# Phase 3 — Distributed Pub/Sub Membership Protocol (Plan)

**Status:** Phase 3a shipped in v0.52.00. Phase 3b + 3c in progress under NX-15 packaging.
**Target:** Extend the DHT simulator with a real, self-organising pub/sub membership protocol, built on top of existing routing. Package the work as a new neuromorphic protocol variant, **NX-15**, that extends NX-10. Existing protocols (Kademlia, G-DHT, NX-10) are not modified; they continue to use the pre-computed-group `pubsubBroadcast` API for their delivery-physics benchmarks.

**Packaging decision:** Rather than pushing the routed-message primitive into the DHT base class (original Option B), we create NX-15 as a subclass of NX-10 that adds the four primitives locally (`routeMessage`, `onRoutedMessage`, `sendDirect`, `onDirectMessage`) and wires an `AxonManager` instance per node. This avoids base-class surgery while giving NX-15 the full membership protocol. The `AxonManager` module stays protocol-agnostic — it could wrap any DHT that implements the four primitives.

---

## 1. Background and Motivation

The DHT simulator's current pub/sub code measures the **delivery physics** of an axonal tree — latency, hop count, fan-out, churn resilience — but does not implement the **membership protocol**. Subscriber lists are pre-computed by the benchmark harness and passed as arguments to a one-shot `pubsubBroadcast(relayId, targetIds)` call. No node holds persistent pub/sub state; no subscribe or unsubscribe message ever traverses the network.

Phase 3 closes that gap. The target protocol is the canonical DHT pub/sub pattern: topic anchors elected by hash-proximity, axon trees that grow along routing paths as subscriber load increases, and self-repair through periodic re-subscription. Each axon member is related to its parent by an ordinary subscription — no special message type, no dedicated control plane.

The PubSubAdapter (v0.51.00) already defines the transport contract the membership protocol must satisfy. The adapter handles sequencing, reorder, and gap detection; the membership protocol handles topic routing, subscriber bookkeeping, and tree maintenance.

---

## 2. Design Goals

1. **Canonical pattern.** The protocol must match the standard "subscribe toward the hash, first encountered axon catches it" pattern. No bespoke design.
2. **Self-organising.** No manual configuration. Topic roots are elected implicitly by DHT geometry. Trees grow and shrink with subscriber load.
3. **Protocol-agnostic default, protocol-aware overrides.** Every DHT (Kademlia, G-DHT, NX-*) gets a working pub/sub for free. Protocols that want to exploit their structural knowledge (NX's synaptome topology, G-DHT's cell locality) can override recruitment policy.
4. **Non-invasive.** Existing benchmarks, lookup behaviour, and protocol files are untouched. Phase 3 is strictly additive.
5. **Churn-tolerant.** The tree self-heals when any axon node or the root dies, without a dedicated recovery protocol.
6. **Satisfies the PubSubAdapter transport contract** exactly as written in v0.51.00 — no changes to the adapter layer.

---

## 3. Layered Architecture

```
┌────────────────────────────────────────────────────────────────┐
│  Application (game state, chat, shared doc, …)                 │
└────────────────────────────────────────────────────────────────┘
                    │  PubSubNode / adapter.publish(domain, event, data)
                    ▼
┌────────────────────────────────────────────────────────────────┐
│  PubSubDomain  (src/pubsub/pubsub.js)          — unchanged     │
│    — local subscription table, wildcard matching, queued drain │
└────────────────────────────────────────────────────────────────┘
                    │  sendMessage / receiveMessage hooks
                    ▼
┌────────────────────────────────────────────────────────────────┐
│  PubSubAdapter  (src/pubsub/PubSubAdapter.js)  — unchanged     │
│    — wire format (senderId, seq), reorder buffer, gap detect   │
└────────────────────────────────────────────────────────────────┘
                    │  transport contract:
                    │    pubsubPublish(topicId, json)
                    │    pubsubSubscribe(topicId)
                    │    pubsubUnsubscribe(topicId)
                    │    onPubsubDelivery(cb)
                    ▼
┌────────────────────────────────────────────────────────────────┐
│  AxonManager  (src/pubsub/AxonManager.js)      — shipped 3a    │
│    — topic role table, subscribe/publish routing, recruitment, │
│      refresh, churn repair                                     │
│    — protocol-agnostic: wraps any DHT satisfying the four      │
│      routing primitives below                                  │
└────────────────────────────────────────────────────────────────┘
                    │  uses:  dht.routeMessage(targetId, type, payload)
                    │         dht.onRoutedMessage(type, handler)
                    │         dht.sendDirect(peerId, type, payload)
                    │         dht.onDirectMessage(type, handler)
                    │  queries: dht.getSelfId(), dht.getAlivePeer(id)
                    ▼
┌────────────────────────────────────────────────────────────────┐
│  NeuromorphicDHTNX15  (src/dht/neuromorphic/...NX15.js)  — NEW │
│    extends NeuromorphicDHTNX10                                 │
│    — routeMessage, sendDirect, onRoutedMessage, onDirectMessage│
│    — _greedyNextHopToward (extracted from NX-10 lookup)        │
│    — per-node AxonManager instance                             │
│    — override pubsubBroadcast → routes via AxonManager         │
│    — pickRecruitPeer override: synaptome-weighted (§5.9)       │
└────────────────────────────────────────────────────────────────┘
                    │  inherits routing from NX-10 (unchanged)
                    ▼
┌────────────────────────────────────────────────────────────────┐
│  NX-10 / NX-9 / … / NX-6 / Kademlia / G-DHT    — UNCHANGED     │
│    existing lookup + one-shot pubsubBroadcast stay as-is       │
└────────────────────────────────────────────────────────────────┘
```

Each layer depends only on the one below. NX-15 adds four new methods; it does not modify any inherited behaviour. MockDHTNode (isolated test harness in `src/pubsub/MockDHTNode.js`) implements the same four primitives for unit testing AxonManager without the real DHT.

---

## 4. NX-15 Additions

### 4.1 `routeMessage(targetId, type, payload, opts) → RouteResult`

Fire-and-forget routing of a typed message toward `targetId`. Each hop on the path may inspect and optionally consume the message based on the per-node handler table.

**Semantics (simulator-internal):**
1. Start at `opts.fromId` (default: self).
2. At each hop, deliver the message to the current node's handler for `type`:
   - Handler returns `'consumed'` → routing terminates. Message is not forwarded further.
   - Handler returns `'forward'` (or returns nothing, or no handler registered) → continue.
3. Compute next hop by calling the protocol's `_greedyNextHopToward(currentNode, targetId)` — a new protocol primitive described in §4.4.
4. If `_greedyNextHopToward` returns the current node (we are closest to target), this is the **terminal** hop: deliver once more with `meta.isTerminal = true` so the handler can distinguish "arrived at the root" from "passing through."
5. Respect `opts.maxHops` (default matches existing lookup cap).

**Handler signature:**
```
handler(payload, meta) → 'consumed' | 'forward' | undefined
  meta = { fromId, targetId, hopCount, isTerminal, node }
```

**Return value:**
```
{ consumed: boolean, atNode: NodeId, hops: Number, exhausted?: boolean }
```

**Cost:** simulator walks the path synchronously using the protocol's existing single-hop routing primitive. On a real network, each hop is a UDP/WebRTC message; the same semantics apply.

### 4.2 `onRoutedMessage(type, handler)`

Per-node registration. When a message of `type` arrives at this node, invoke `handler`. Only one handler per type per node.

Used by the AxonManager to register handlers for `pubsub:subscribe`, `pubsub:unsubscribe`, `pubsub:publish`.

### 4.3 `sendDirect(peerId, type, payload)`

Point-to-point delivery to a specific peer `peerId`. Used for direct axon-to-child delivery, where routing is unnecessary because the sender already knows the recipient's ID and has a direct synapse to them (or can look one up).

In the simulator, this is a synchronous call on the recipient's handler. In production, this is a single UDP/WebRTC send.

**Not the same as `routeMessage`.** `sendDirect` is for "I know exactly who this is going to, no tree walk needed." Used heavily for publish fan-out: once an axon has decided its children are [P1, P2, P3], it delivers to each via `sendDirect`, not via routing.

### 4.4 `_greedyNextHopToward(node, targetId) → Node | null`

Protocol-specific primitive. Returns the peer from `node`'s routing table that should be the next hop toward `targetId`, or `null` if `node` itself is the closest (terminal).

Kademlia: closest by XOR distance in node's buckets.
G-DHT: closest by XOR after S2-prefix alignment.
NX-*: closest by synaptome + highway (existing logic, extracted from `lookup`).

**This is the only invasive change to existing protocols** — each must expose a single-step routing decision. The extraction is small (the inner loop of `lookup` already computes this; we just lift it into a named method).

### 4.5 Policy hooks (overridable on the base class)

Default implementations work for any DHT. Protocols override if they want protocol-specific recruitment or delivery optimisation.

| Hook | Default | NX-10 Override (future) |
|---|---|---|
| `shouldRecruitSubAxon(topicRole)` | subscribers.size >= K (default K=20) | maybe tuned for synaptome density |
| `pickRecruitPeer(topicRole, subscribeMeta)` | `subscribeMeta.fromId` (the peer that forwarded the subscribe) | maybe prefer synaptome peer with highest weight |
| `refreshIntervalMs()` | 30_000 | — |
| `axonMaxSubscribers()` | 20 | maybe tuned per protocol |

---

## 5. AxonManager — the Membership Protocol

### 5.1 Per-node state

```
axonRoles : Map<topicHash, TopicRole>

TopicRole = {
  parentId:       NodeId | null,    // my upstream axon (null if I'm the root)
  children:       Map<NodeId, ChildEntry>,
                                    // peers that have subscribed through me
                                    //   (or that I delegated as sub-axons)
  isRoot:         boolean,          // am I the closest-to-hash for this topic
  parentLastSent: epoch,            // when I last refreshed upward to parent
  roleCreatedAt:  epoch,            // when I became an axon for this topic
}

ChildEntry = {
  createdAt:      epoch,            // when this child first attached
  lastRenewed:    epoch,            // last time this child refreshed
}
```

The `children` map treats direct subscribers and sub-axons identically — from this node's perspective, both are peers to forward publishes to. This is what makes the tree self-similar: a leaf is a child; a sub-axon is also a child. The recruiter doesn't distinguish.

Every child entry carries timestamps. These drive TTL-based expiry and diagnostic reporting. See §5.7 for the refresh and expiry rules.

### 5.2 Subscribe flow

Caller (typically via `adapter.subscribe(domain, event)`) computes `topicId = hash("domain:event")` and invokes `axon.pubsubSubscribe(topicId)`:

```
pubsubSubscribe(topicId):
    dht.routeMessage(topicId, 'pubsub:subscribe',
                     { topicId, subscriberId: self.id })
```

At each hop, the subscribe message is delivered to that node's `_onSubscribe` handler:

```
_onSubscribe({ topicId, subscriberId }, meta):
    role = axonRoles.get(topicId)

    if role exists:
        # We are already an axon for this topic.
        if role.children.has(subscriberId):
            # Renewal: just bump lastRenewed. This is the common case for
            # both direct subscribers and sub-axons that refresh periodically.
            role.children.get(subscriberId).lastRenewed = now
            return 'consumed'

        if shouldRecruitSubAxon(role):
            # Delegate: recruit a peer as a sub-axon.
            # Default pick: meta.fromId (the peer that forwarded this subscribe).
            # NX-10 override: prefer highest-weight synapse among candidates on
            #   the path toward subscriberId (see §5.9).
            recruitId = pickRecruitPeer(role, meta)
            role.children.set(recruitId, { createdAt: now, lastRenewed: now })
            dht.sendDirect(recruitId, 'pubsub:promote-axon',
                           { topicId, newSubscriberId: subscriberId, parentId: self.id })
            return 'consumed'

        # Add directly.
        role.children.set(subscriberId, { createdAt: now, lastRenewed: now })
        return 'consumed'

    if meta.isTerminal:
        # Nobody is the axon yet and the message reached the node closest
        # to topicId. We become the root.
        axonRoles.set(topicId, {
            parentId:       null,
            children:       new Map([[subscriberId, { createdAt: now, lastRenewed: now }]]),
            isRoot:         true,
            parentLastSent: 0,
            roleCreatedAt:  now,
        })
        return 'consumed'

    # Just passing through.
    return 'forward'
```

The `pubsub:promote-axon` message (point-to-point, not routed) tells the recruited peer "you are now an axon for this topic; add newSubscriberId as your child; I (parentId) am your parent." The recruited peer creates its own TopicRole and responds by issuing its own `pubsubSubscribe(topicId)` — which routes toward topicId, gets intercepted by the parent (who adds the recruited peer to its own childSet if not already there), and the two-way relationship is established.

### 5.3 Publish flow

```
pubsubPublish(topicId, json):
    dht.routeMessage(topicId, 'pubsub:publish', { topicId, json })
```

At each hop:

```
_onPublish({ topicId, json }, meta):
    role = axonRoles.get(topicId)
    if role is null:
        # Not an axon for this topic — just forward toward topicId.
        return 'forward'

    # We are an axon. Fan out to all children.
    for childId in role.children.keys():
        if childId == meta.fromId: continue   # don't echo back to forwarder
        dht.sendDirect(childId, 'pubsub:deliver',
                       { topicId, json })

    # If I myself subscribed (my own PubSubAdapter registered interest in
    # this topic), deliver to the local delivery callback too.
    if deliveryCallback and self.id in role.children:
        deliveryCallback(topicId, json)

    return 'consumed'
```

The `pubsub:deliver` message is direct, not routed. When a sub-axon receives it, that sub-axon's handler looks up its own TopicRole and fans out again to its own childSet. Leaves receive `pubsub:deliver` and invoke the delivery callback (which is wired into PubSubAdapter's `onPubsubDelivery`).

**Important property:** the publisher never learns the subscriber list. It just routes the publish toward `topicId`. The axon catches it. Fan-out is delegated through the tree. This matches the design principle that "publisher doesn't need to know who the anchor is — it just routes toward the hash."

### 5.4 Unsubscribe flow

Symmetric to subscribe:

```
pubsubUnsubscribe(topicId):
    dht.routeMessage(topicId, 'pubsub:unsubscribe',
                     { topicId, subscriberId: self.id })

_onUnsubscribe({ topicId, subscriberId }, meta):
    role = axonRoles.get(topicId)
    if role:
        role.children.delete(subscriberId)
        # Note: we do NOT eagerly tear down an empty non-root axon here.
        # Dissolution is handled by §5.8 (orderly collapse) on a timer so
        # that rapid subscribe/unsubscribe churn does not flap the tree.
        return 'consumed'
    return 'forward'
```

Explicit unsubscribes are a hint — they remove the entry from the parent axon's child table promptly. If a subscriber just disappears without calling `unsubscribe` (browser tab closed, node killed), the TTL sweep in §5.7 handles it.

### 5.5 Periodic refresh

Every `refreshIntervalMs` (default 10 s), two kinds of renewal happen:

1. **Leaf refresh.** Each PubSubAdapter with an active subscription re-issues `pubsubSubscribe(topicId)` for each topic. The routed subscribe lands at the axon currently holding this node in its `children` map; the axon's handler (§5.2) notices `role.children.has(subscriberId)` and bumps `lastRenewed = now`. No tree change.

2. **Axon refresh.** Each axon that has any live children and is not the root re-issues its own `pubsubSubscribe(topicId)`. This walks toward `topicId`, is caught by the axon's parent (or by a node closer to the hash if topology has changed), and refreshes the axon's own entry in the parent's `children` map. An axon that stops refreshing upward will be removed by its parent via TTL (§5.7) — this is how an axon voluntarily leaves the tree.

Both refreshes use the same wire format — a plain `pubsub:subscribe`. The axon handler's idempotent-renewal branch (§5.2) makes it safe for any node to refresh as often as it wants, and the same code path handles a brand-new join or a thousandth refresh.

Simulator impl: piggyback on the existing `simEpoch` tick; every `refreshEpochs` ticks, the engine drives `axon.refreshTick()` on each live node.

### 5.6 Churn recovery

Three events trigger re-subscription:

1. **Periodic refresh** (§5.5). Background heartbeat; the common case.
2. **Detected parent death.** If a `sendDirect` to a parent fails, or a routed subscribe reports `exhausted` without reaching a live axon, re-issue subscribe immediately (rather than waiting for the next refresh tick).
3. **Root churn.** When the root dies, its former children's next refresh routes toward `topicId`; whoever is now closest to the hash becomes the new root when its handler sees `isTerminal && !role`. The rest of the former children re-attach along routing paths to the new root, naturally forming a new tree.

No explicit "new root election" protocol is required — the DHT's routing geometry plus the "subscribe attaches at first axon, or at terminal if none" rule together elect the root implicitly.

### 5.7 TTL and expiry

Each axon periodically sweeps its `children` map and removes entries whose `lastRenewed` is older than `maxSubscriptionAgeMs` (default 30 s = 3 × `refreshIntervalMs`).

```
_sweepExpiredChildren():
    for (topicId, role) in axonRoles:
        for (childId, entry) in role.children:
            if now - entry.lastRenewed > maxSubscriptionAgeMs:
                role.children.delete(childId)

        # If all children expired and we are not the root, dissolve.
        # Pure TTL-driven collapse — no explicit coordination needed.
        if role.children is empty and not role.isRoot:
            axonRoles.delete(topicId)
            # Parent's own TTL will remove us from its children map within
            # one refresh interval. No outbound message required.
```

The root has a special rule: an empty root persists for `rootGraceMs` (default 60 s) before dissolving, since the closest-to-hash position is a DHT-geometric fact and a new subscribe might arrive at any moment.

### 5.8 Orderly collapse (active consolidation)

TTL handles silent failures. For voluntary load departure (subscribers leaving gracefully) we want the tree to also collapse quickly, without waiting for TTL or over-consolidating to the root. The rule is a **hysteresis band** with two thresholds:

| Constant | Default | Meaning |
|---|---|---|
| `maxDirectSubs` | 20 | Recruit a sub-axon when `children.size >` this |
| `minDirectSubs` | 5 | Voluntarily dissolve (non-root) when `children.size <` this for one full refresh interval |

The gap between 5 and 20 is the stable band; trees that grow to 20 and shrink to 10 stay put. Only when a sub-axon drops below 5 does it consider dissolving.

**Dissolve sequence** (non-root axon with `children.size < minDirectSubs` for one refresh cycle):

```
_dissolve(topicId, role):
    # 1. Tell each child to re-subscribe via the parent. Children receive
    #    this as a hint, clear this axon from their local parent-pointer,
    #    and immediately issue a fresh pubsubSubscribe(topicId). Their
    #    re-subscribes route toward topicId; the message is intercepted
    #    by role.parentId (or whatever axon now sits on the path).
    for childId in role.children.keys():
        dht.sendDirect(childId, 'pubsub:dissolve-hint',
                       { topicId, suggestedParent: role.parentId })

    # 2. Drop our own axonRoles entry. Stop refreshing upward.
    axonRoles.delete(topicId)
```

The parent is NOT notified directly — its TTL sweep will remove this axon from its own `children` map within one refresh interval. The children's re-subscribes will reach the parent (or a better-placed axon along the path) and re-wire naturally.

**Why hysteresis works:**
- No flapping: recruit at >20, dissolve at <5. A tree oscillating between 8 and 15 stays put.
- No root overload: children don't jump straight to the root. They re-subscribe via the normal routing path, and the first axon they encounter (which may well be the former parent) catches them.
- Graceful cascade: if an axon dissolves and its former parent now has <5 children itself, the parent will dissolve on its next sweep. The tree collapses one layer at a time, in order.
- Churn-resilient: if some of the dissolve-hint messages are lost, TTL catches those children within 30 s anyway.

**Why we don't push everything to the root:**
- The dissolve message only tells children about `role.parentId` (one level up). The re-subscribe then routes normally. If any axon between this former axon and the root still has capacity, it catches the children.
- Root takes children only when genuinely appropriate — i.e., when every intermediate axon in the path has dissolved.

**Root never dissolves via §5.8.** It can only go away via §5.7 when its children map is empty for longer than `rootGraceMs`.

### 5.9 NX-10 recruitment override

For protocols that want to exploit routing-table quality, `pickRecruitPeer` is overridable. NX-10's override prefers high-weight synaptome peers because axon membership is a long-lived commitment, and high-weight synapses are ones LTP has already validated as reliable.

```
# NX-10 override of pickRecruitPeer(role, meta):
NX10_pickRecruitPeer(role, meta):
    # Find synaptome peers that are "toward" the new subscriber in XOR space.
    # (Equivalently: peers that would be plausible next hops for a future
    # subscribe from this direction.)
    candidates = [peer in node.synaptome
                  if xor(peer.id, meta.subscriberId) < xor(self.id, meta.subscriberId)]

    if candidates.length == 0:
        # No forward-progress peer in synaptome — fall through to default.
        return meta.fromId

    # Among forward candidates, prefer highest synapse weight.
    # Ties broken by lowest measured latency.
    return argmax(candidates, peer => [peer.weight, -peer.latencyMs])
```

Fallback to the default (`meta.fromId`) is important — it preserves correctness if the synaptome doesn't contain a suitable candidate. This way the protocol degrades gracefully to the baseline when the synaptome is cold (new node, post-churn, etc.).

---

## 6. Transport Contract Wiring

`PubSubAdapter` expects a transport with four methods. `AxonManager` provides them exactly:

| Adapter requires | AxonManager provides |
|---|---|
| `transport.nodeId` | `axon.nodeId` (returns `dht.getSelfId()`) |
| `transport.pubsubPublish(topicId, json)` | `axon.pubsubPublish(topicId, json)` routes the publish |
| `transport.pubsubSubscribe(topicId)` | `axon.pubsubSubscribe(topicId)` routes the subscribe |
| `transport.pubsubUnsubscribe(topicId)` | `axon.pubsubUnsubscribe(topicId)` routes the unsubscribe |
| `transport.onPubsubDelivery(cb)` | `axon.onPubsubDelivery(cb)` stores the leaf-delivery callback |

Construction:
```javascript
const axon    = new AxonManager(dht, { maxDirectSubs: 20, refreshIntervalMs: 30000 });
const adapter = new PubSubAdapter({ transport: axon });
```

No changes to `PubSubAdapter.js` are required.

---

## 7. File Impact

### Shipped in Phase 3a (v0.52.00)

| Path | Purpose | Lines |
|---|---|---|
| `src/pubsub/AxonManager.js` | Membership protocol (no recruitment yet) | ~280 |
| `src/pubsub/MockDHTNode.js` | Routing primitives for isolated testing | ~260 |
| `src/pubsub/test_mock_dht.js` | 31 assertions on routing | ~240 |
| `src/pubsub/test_axon.js` | 40 assertions on membership | ~320 |
| `src/pubsub/test_integration.js` | 27 assertions end-to-end | ~270 |

### Planned for Phase 3b (NX-15 packaging)

| Path | Change | Est. lines |
|---|---|---|
| `src/pubsub/AxonManager.js` | +recruitment, +orderly collapse, +policy hooks | +150 |
| `src/pubsub/test_axon.js` | +recruitment + collapse scenarios | +100 |
| `src/dht/neuromorphic/NeuromorphicDHTNX15.js` | **NEW** — extends NX-10, adds routing primitives, wires AxonManager, overrides pubsubBroadcast, synaptome-weighted pickRecruitPeer | ~300 |
| `src/pubsub/test_nx15_integration.js` | **NEW** — AxonManager running on real NX-15 at small scale | +250 |
| `src/main.js` | +import, +createDHT case, +benchmark protocol entry | +20 |
| `src/ui/BenchmarkSweep.js` | (no changes expected) | 0 |
| `index.html` | +dropdown option, +benchmark multiselect, +tooltip, version bump | +10 |

### Planned for Phase 3c

| Path | Change | Est. lines |
|---|---|---|
| `src/pubsub/AxonManager.js` | +parent-death detection, +eager re-subscribe | +80 |
| `src/pubsub/test_axon.js` / `test_nx15_integration.js` | +churn scenarios | +150 |

**Existing benchmark numbers do not change.** NX-10, Kademlia, G-DHT, and every other existing protocol continue to use the pre-computed-group `pubsubBroadcast` API. Only NX-15 uses the new membership protocol. The comparison is then NX-10 (delivery-physics with synthetic groups) vs NX-15 (convergence + steady-state + churn with real membership), same family, directly measurable trade-off.

**Total new + modified code for Phase 3b + 3c: ~1000 lines.**

---

## 8. Benchmarks

Three new test types, all coexisting with the existing `pubsub` broadcast benchmark:

1. **`pubsubConvergence`** — Measures subscribe-to-delivery latency. At t=0, N subscribers issue `subscribe(T)` simultaneously. At t=1s, one publisher issues a single `publish(T)`. Record: time from publish to delivery at each subscriber; % of subscribers that received it.

2. **`pubsubSteadyState`** — A tree has been warm for 60 s. Publisher issues 100 publishes at fixed rate. Record: latency distribution, hop count, fan-out, dropped messages.

3. **`pubsubChurn`** — Warm tree with N subscribers. Kill 25 % of nodes (including possibly root + several axons). Wait for refresh interval. Publisher issues 10 publishes. Record: % delivered, latency, tree re-formation time.

These exercise the membership protocol. The existing `pubsub` benchmark (pre-computed groups, one-shot broadcast) remains as the delivery-physics measurement — it still measures the axonal-tree shape and latency without the membership overhead.

---

## 9. Milestones

Phase 3 breaks into three incremental milestones. Each produces a shippable checkpoint.

### Phase 3a — Core membership (single-node axons, with TTL)

- DHT base class extensions (`routeMessage`, `onRoutedMessage`, `sendDirect`, `_greedyNextHopToward` per protocol).
- AxonManager with subscribe / unsubscribe / publish.
- Timestamped children (`createdAt` + `lastRenewed`).
- Periodic refresh for leaves and axons (§5.5).
- TTL expiry sweep (§5.7).
- **No sub-axon recruitment.** Single-axon-per-topic. Subscriber limit: uncapped.
- Unit tests (`test_axon.js`) against MockDHT.
- Integration test: `PubSubAdapter + AxonManager + MockDHT` end-to-end, exercising the 12 adapter scenarios plus refresh/TTL scenarios (renewal bumps lastRenewed, silent subscriber dies after TTL, empty axon self-collapses).
- Deliverable: adapter works against a real DHT for small subscriber counts, with subscriptions that expire if not refreshed.

### Phase 3b — Recruitment, tree growth, orderly collapse, and NX-15 protocol

- Add `shouldRecruitSubAxon` + `pickRecruitPeer` policy hooks to AxonManager with default implementations.
- Add `pubsub:promote-axon` direct message type.
- Tree grows into multi-level axon chains as subscriber count exceeds `maxDirectSubs`.
- Hysteresis dissolve (§5.8): axons with `< minDirectSubs` for one refresh cycle send `pubsub:dissolve-hint` and delete themselves. Children re-subscribe via normal routing; tree collapses one layer at a time.
- **Create `NeuromorphicDHTNX15.js`** — extends NX-10. Adds the four routing primitives (`routeMessage`, `onRoutedMessage`, `sendDirect`, `onDirectMessage`), extracts `_greedyNextHopToward` from NX-10's lookup, wires an `AxonManager` per node, overrides the one-shot `pubsubBroadcast` API to route through the AxonManager instead of building an ephemeral tree.
- NX-15 `pickRecruitPeer` override (§5.9) — prefer forward-progress synaptome peers by weight.
- UI wiring: add NX-15 to the protocol dropdown, benchmark multiselect, and tooltip.
- Benchmark: `pubsubConvergence` + `pubsubSteadyState`.
- Deliverable: NX-15 appears alongside NX-10 in the sim with real persistent trees; scales to thousands of subscribers with bounded per-axon load and collapses gracefully when subscribers leave.

### Phase 3c — Churn recovery

- Parent-death detection (explicit `sendDirect` failure, or `routeMessage` exhaustion) → eager re-subscribe.
- Root-churn handling via refresh (the re-subscribe naturally lands at whoever is now closest to the hash).
- Benchmark: `pubsubChurn`.
- Deliverable: protocol survives 25 % churn with self-healing tree, ≥ 98 % delivery rate.

Each milestone is ~300-500 lines of code and a testable increment. Total Phase 3 effort: roughly 1.5 to 2 weeks of focused work.

---

## 10. Design Parameters (review before implementation)

### Confirmed

- ✅ **#5 — NX-10 recruitment override.** Prefer high-weight synaptome peers (long-lived axon membership favours proven synapses). Formalised in §5.9.
- ✅ **Timestamped children.** Every child carries `createdAt` + `lastRenewed`. Formalised in §5.1.
- ✅ **Periodic refresh by every axon.** Any axon with live children must refresh upward to its parent on the same cadence, or it will be dropped by the parent's TTL sweep. Formalised in §5.5 + §5.7.
- ✅ **Orderly collapse without dumping everything to the root.** Hysteresis band between `maxDirectSubs` (recruit) and `minDirectSubs` (dissolve), with children re-subscribing along normal routing paths when an intermediate axon dissolves. Formalised in §5.8.

### All parameters confirmed

All defaults accepted: `maxDirectSubs=20`, `minDirectSubs=5`, `refreshIntervalMs=10_000`, `maxSubscriptionAgeMs=30_000`, `rootGraceMs=60_000`. Production values will be longer (5-10 min refresh) but the simulator needs shorter cadences to observe the behaviour in bounded test runs.

### Questions resolved by NX-15 packaging

- ~~#6 _greedyNextHopToward extraction across all protocols~~ — only NX-15 needs single-step routing, extracted from NX-10's lookup. Kademlia and G-DHT are unmodified.
- ~~#7 all-protocols-symmetric comparison~~ — NX-15 is compared against NX-10 (same family, fair contest), not against Kademlia. Kademlia's `pubsubBroadcast` remains the flat-delivery baseline it has always been.
- ~~#8 zero changes to PubSubAdapter.js~~ — confirmed, and the Phase 3a fix to `topicIdFor` (signed-int32 bug) doesn't count as a contract change; it's a bug fix to the existing hash function.

---

## 11. Non-Goals (for Phase 3)

- **Tier 2 retransmit** (publisher ring buffer + resend). Documented in the adapter but not wired to the membership protocol. Deferred.
- **Tier 3 snapshot recovery.** App-level state-snapshot plumbing. Deferred.
- **Bloom-filter subscriber compression.** Currently `childSet` is a plain `Set<NodeId>`. For very large trees this becomes a memory issue. Out of scope.
- **Cross-protocol interoperability.** A Kademlia node cannot join an NX-10 topic tree in the current design. Different protocol instances mean separate routing — fine for the simulator, worth revisiting for a production deployment where heterogeneous nodes might coexist.
- **Rate limiting / flood control.** A malicious publisher could flood a topic. Out of scope for the simulator; a real system would add rate limits at axon intake.

---

## 12. Success Criteria

Phase 3 is complete when:

- [ ] All PubSubAdapter tests (31) still pass against `AxonManager + MockDHT`.
- [ ] All existing sim benchmarks still produce unchanged numbers.
- [ ] New `pubsubConvergence` benchmark shows subscribe-to-delivery latency ≤ 3× lookup latency at 25 k nodes, 1000 subscribers.
- [ ] New `pubsubSteadyState` benchmark shows publish latency within 10 % of the existing `pubsubBroadcast` one-shot benchmark (i.e., the membership overhead is small compared to the delivery physics).
- [ ] New `pubsubChurn` benchmark shows ≥ 98 % delivery rate at 25 % churn with 30 s refresh interval.
- [ ] The membership protocol is the same module for every protocol, with only `pickRecruitPeer` varying where a protocol wants an advantage.

/**
 * AxonManager — distributed pub/sub membership protocol.
 *
 * Implements the PubSubAdapter transport contract on top of a DHT that
 * provides the routed-messaging primitives (routeMessage, onRoutedMessage,
 * sendDirect, onDirectMessage).
 *
 * This is Phase 3a: core membership with timestamped children, periodic
 * refresh, and TTL-based expiry. No sub-axon recruitment — a single axon
 * per topic holds every subscriber. Phase 3b introduces recruitment and
 * orderly collapse; Phase 3c adds explicit churn recovery.
 *
 * Message types (over the DHT):
 *
 *   ROUTED:
 *     pubsub:subscribe   — payload: { topicId, subscriberId }
 *     pubsub:unsubscribe — payload: { topicId, subscriberId }
 *     pubsub:publish     — payload: { topicId, json }
 *
 *   DIRECT:
 *     pubsub:deliver     — payload: { topicId, json }
 *
 * See documents/Phase3-Membership-Protocol-Plan.md for the full design
 * rationale, state model, and parameter defaults.
 */

// ── Defaults (simulator-tuned; production would use much longer values) ────

const DEFAULT_MAX_DIRECT_SUBS        = 20;           // §5.8 hysteresis (unused in 3a)
const DEFAULT_MIN_DIRECT_SUBS        = 5;            // §5.8 hysteresis (unused in 3a)
const DEFAULT_REFRESH_INTERVAL_MS    = 10_000;       // §5.5
const DEFAULT_MAX_SUBSCRIPTION_AGE_MS = 30_000;      // §5.7 — 3× refresh
const DEFAULT_ROOT_GRACE_MS          = 60_000;       // §5.7 — 6× refresh
const DEFAULT_ROOT_SET_SIZE          = 5;            // K in K-closest replication

// ── AxonManager ────────────────────────────────────────────────────────────

export class AxonManager {
  /**
   * @param {Object} opts
   * @param {MockDHTNode} opts.dht     — the DHT primitive (routeMessage etc.)
   * @param {number} [opts.maxDirectSubs]
   * @param {number} [opts.minDirectSubs]
   * @param {number} [opts.refreshIntervalMs]
   * @param {number} [opts.maxSubscriptionAgeMs]
   * @param {number} [opts.rootGraceMs]
   * @param {Function} [opts.now]      — clock (for deterministic testing)
   */
  constructor({
    dht,
    maxDirectSubs        = DEFAULT_MAX_DIRECT_SUBS,
    minDirectSubs        = DEFAULT_MIN_DIRECT_SUBS,
    refreshIntervalMs    = DEFAULT_REFRESH_INTERVAL_MS,
    maxSubscriptionAgeMs = DEFAULT_MAX_SUBSCRIPTION_AGE_MS,
    rootGraceMs          = DEFAULT_ROOT_GRACE_MS,
    rootSetSize          = DEFAULT_ROOT_SET_SIZE,    // K in K-closest replication
    pickRecruitPeer      = null,   // protocol-specific override (§5.9)
    shouldRecruitSubAxon = null,   // protocol-specific override
    now                  = () => Date.now(),
  } = {}) {
    if (!dht) throw Error('AxonManager: dht is required');

    this.dht                   = dht;
    this.nodeId                = dht.getSelfId();
    this.maxDirectSubs         = maxDirectSubs;
    this.minDirectSubs         = minDirectSubs;
    this.refreshIntervalMs     = refreshIntervalMs;
    this.maxSubscriptionAgeMs  = maxSubscriptionAgeMs;
    this.rootGraceMs           = rootGraceMs;
    this.rootSetSize           = rootSetSize;
    this._now                  = now;

    // Per-node outgoing publishId counter (monotonic, combined with
    // nodeId to be globally unique across the network).
    this._publishCounter = 0;

    // Per-node LRU of publishIds we have already processed, so a node
    // never fans out or delivers the same publish twice. Without this,
    // the K-closest replication + sub-axon recruitment produces
    // exponential duplication: a subscriber that appears in multiple
    // sub-axons' children maps receives many copies, and if they are
    // themselves a sub-axon, each copy triggers another fan-out round.
    this._seenPublishes = new Map();     // publishId -> insertedAt (ms)
    this._seenPublishCap = 4096;         // bounded size (LRU-ish)
    this._seenPublishTtlMs = 60_000;     // entries expire after 60 s

    // Policy overrides — if provided, replace the default methods. The DHT
    // (e.g., NX-15) is the usual source; it injects its protocol-specific
    // selection using its own routing-table state.
    if (pickRecruitPeer)      this.pickRecruitPeer      = pickRecruitPeer;
    if (shouldRecruitSubAxon) this.shouldRecruitSubAxon = shouldRecruitSubAxon;

    /** topicHash -> TopicRole */
    this.axonRoles = new Map();

    /** topicHash -> TopicSub (my own subscription state — only if I called subscribe) */
    this.mySubscriptions = new Map();

    /** Delivery callback — registered by PubSubAdapter via onPubsubDelivery. */
    this._deliveryCallback = null;

    // Register handlers with the DHT.
    dht.onRoutedMessage('pubsub:subscribe',    (p, m) => this._onSubscribe(p, m));
    dht.onRoutedMessage('pubsub:unsubscribe',  (p, m) => this._onUnsubscribe(p, m));
    dht.onRoutedMessage('pubsub:publish',      (p, m) => this._onPublish(p, m));
    dht.onDirectMessage('pubsub:deliver',      (p, m) => this._onDeliver(p, m));
    dht.onDirectMessage('pubsub:promote-axon', (p, m) => this._onPromoteAxon(p, m));
    dht.onDirectMessage('pubsub:dissolve-hint',(p, m) => this._onDissolveHint(p, m));
    // K-closest mode (available when dht.findKClosest exists).
    dht.onDirectMessage('pubsub:subscribe-k',  (p, m) => this._onSubscribeDirect(p, m));
    dht.onDirectMessage('pubsub:publish-k',    (p, m) => this._onPublishDirect(p, m));
    dht.onDirectMessage('pubsub:unsubscribe-k',(p, m) => this._onUnsubscribeDirect(p, m));

    // Periodic refresh + TTL sweep. We use a single timer driving both
    // actions; refreshTick() is exported for tests that prefer to pump
    // the state machine manually rather than rely on wall-clock timers.
    this._timer = null;
  }

  /** Start the periodic refresh/sweep timer. Idempotent. */
  start() {
    if (this._timer) return;
    this._timer = setInterval(() => this.refreshTick(), this.refreshIntervalMs);
  }

  /** Stop the periodic timer. */
  stop() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  }

  // ── PubSubAdapter transport contract ────────────────────────────────

  /**
   * Publish over the network. In K-closest mode, pick the best of the K
   * current closest-to-hash roots and sendDirect — they have replicated
   * subscriber lists, so any one of K is sufficient. Falls back to a
   * routed publish when the transport doesn't expose findKClosest.
   *
   * Every publish carries a globally-unique publishId (nodeId + counter).
   * Receivers track publishIds they've already processed to prevent
   * exponential duplication when the fan-out tree has overlapping paths
   * (common under K-closest replication + sub-axon recruitment).
   */
  pubsubPublish(topicId, json) {
    const publishId = `${this.nodeId}:${++this._publishCounter}`;
    if (this._useKClosestMode()) {
      const roots = this.dht.findKClosest(topicId, this.rootSetSize);
      if (roots.length > 0) {
        // Send to ALL K roots, not just one. Publisher's K-closest set
        // and subscriber's K-closest set diverge under routing-table
        // instability (churn especially), so subscribers stored at a
        // slightly different set than the publisher now sees. Sending
        // to ALL K guarantees coverage as long as SOME root holds the
        // subscriber. The publishId dedup at each receiver prevents
        // duplicate fan-out, so the cost is K small sendDirect calls
        // to the K roots (not K× amplification on fan-out).
        for (const target of roots) {
          this.dht.sendDirect(target, 'pubsub:publish-k', { topicId, json, publishId });
        }
        return;
      }
    }
    this.dht.routeMessage(topicId, 'pubsub:publish', { topicId, json, publishId });
  }

  /**
   * Subscribe to a topic. In K-closest mode, STOREs the subscription at
   * each of the K nodes closest to hash(topic) so the publisher can hit
   * any one of them and still find us. Falls back to a routed subscribe
   * when the transport doesn't expose findKClosest.
   */
  pubsubSubscribe(topicId) {
    this.mySubscriptions.set(topicId, { subscribedAt: this._now() });

    if (this._useKClosestMode()) {
      const roots = this.dht.findKClosest(topicId, this.rootSetSize);
      if (roots.length > 0) {
        for (const peerId of roots) {
          this.dht.sendDirect(peerId, 'pubsub:subscribe-k', {
            topicId,
            subscriberId: this.nodeId,
            peerRoots:    roots,          // gossip the K-set so each root
                                          // knows its peers (used by root
                                          // reconciliation in the future)
          });
        }
        return;
      }
    }
    this.dht.routeMessage(topicId, 'pubsub:subscribe',
                          { topicId, subscriberId: this.nodeId });
  }

  pubsubUnsubscribe(topicId) {
    this.mySubscriptions.delete(topicId);

    if (this._useKClosestMode()) {
      const roots = this.dht.findKClosest(topicId, this.rootSetSize);
      if (roots.length > 0) {
        for (const peerId of roots) {
          this.dht.sendDirect(peerId, 'pubsub:unsubscribe-k', {
            topicId,
            subscriberId: this.nodeId,
          });
        }
        return;
      }
    }
    this.dht.routeMessage(topicId, 'pubsub:unsubscribe',
                          { topicId, subscriberId: this.nodeId });
  }

  /** True when the underlying transport supports K-closest lookup. */
  _useKClosestMode() {
    return this.rootSetSize > 0 && typeof this.dht.findKClosest === 'function';
  }

  onPubsubDelivery(callback) {
    this._deliveryCallback = callback;
  }

  // ── Handlers ────────────────────────────────────────────────────────

  /**
   * SUBSCRIBE routed message handler.
   *
   * - If we are already the axon for topicId:
   *     - Renewal: bump lastRenewed.
   *     - New subscriber under capacity: add to children.
   *     - New subscriber over capacity: recruit a sub-axon (§5.2, §5.8).
   * - If we are the terminal (closest-to-hash) and no axon exists: become root.
   * - Otherwise: forward along the route.
   */
  _onSubscribe(payload, meta) {
    const { topicId, subscriberId } = payload;
    const role = this.axonRoles.get(topicId);
    const now = this._now();

    if (role) {
      // Self-subscribe: a non-root axon refreshing upward invokes its own
      // handler at hop 0. Don't register ourselves as our own child; let
      // the message continue toward the parent. A root self-subscribing
      // is legitimate — it's the terminal with no upstream.
      if (subscriberId === this.nodeId) {
        if (!role.isRoot) return 'forward';
      }
      this._addOrRecruitChild(topicId, role, subscriberId, meta.fromId);
      return 'consumed';
    }

    if (meta.isTerminal) {
      // Become the root for this topic.
      this.axonRoles.set(topicId, {
        parentId:       null,
        isRoot:         true,
        children:       new Map([[subscriberId, { createdAt: now, lastRenewed: now }]]),
        parentLastSent: 0,
        roleCreatedAt:  now,
        emptiedAt:      0,
        lowWaterSince:  0,   // §5.8 — when children.size first dropped below minDirectSubs
      });
      return 'consumed';
    }

    return 'forward';
  }

  // ── Shared add-or-recruit primitive ─────────────────────────────────

  /**
   * Add `subscriberId` as a child of `role`, or — if `role` is at
   * capacity — promote an existing child to sub-axon and delegate. The
   * recruit pathway always preserves `role.children.size ≤ maxDirectSubs`.
   *
   * This is invoked from every code path that materialises a new child:
   *   - _onSubscribe         (routed subscribe landing at a terminal)
   *   - _onSubscribeDirect   (K-closest STORE)
   *   - _onPromoteAxon       (parent telling us to take a delegated sub)
   *
   * Sharing the implementation is essential: without it, sub-axons that
   * receive repeated promote-axon messages accumulate subscribers past
   * the cap because the recruit-check was only in the subscribe paths.
   */
  _addOrRecruitChild(topicId, role, subscriberId, forwarderId = null) {
    const now = this._now();
    const existing = role.children.get(subscriberId);
    if (existing) { existing.lastRenewed = now; return; }

    if (this.shouldRecruitSubAxon(role)) {
      const meta = { fromId: forwarderId || subscriberId };
      let recruitId = this.pickRecruitPeer(role, meta, subscriberId);
      // Override safety: if an override returned self, the forwarder,
      // or a non-child, fall back to the XOR-closest non-self,
      // non-forwarder existing child.
      if (!recruitId || recruitId === this.nodeId
          || recruitId === forwarderId
          || !role.children.has(recruitId)) {
        recruitId = this._pickExistingChildForRecruit(role, subscriberId, forwarderId);
      }
      if (recruitId) {
        role.children.get(recruitId).lastRenewed = now;
        this.dht.sendDirect(recruitId, 'pubsub:promote-axon', {
          topicId,
          newSubscriberId: subscriberId,
          parentId:        this.nodeId,
        });
        return;
      }
      // No non-self child to recruit. Only happens if role.children is
      // empty or contains only us. Just add the subscriber directly —
      // over-capacity is a lesser evil than infinite recursion.
    }
    role.children.set(subscriberId, { createdAt: now, lastRenewed: now });
  }

  // ── Policy hooks (overridable by subclasses) ───────────────────────

  /**
   * Should this axon recruit a sub-axon for the next new subscriber?
   * Default: when children.size reaches maxDirectSubs.
   * Override on a subclass (e.g., NX-15) to use protocol-specific
   * knowledge — for instance to refuse recruitment when no high-weight
   * synapse is available as a recruit candidate.
   */
  shouldRecruitSubAxon(role) {
    return role.children.size >= this.maxDirectSubs;
  }

  /**
   * Pick which EXISTING child should be promoted to sub-axon. The return
   * value MUST be an id already present in `role.children` — we never
   * grow an axon beyond its cap during recruitment.
   *
   * Default: the existing child with smallest XOR distance to the new
   * subscriber. That child sits on the natural routing path toward future
   * subscribers in the same ID-space region.
   *
   * Override: NX-15 prefers existing children that also appear in the
   * node's synaptome with high weight.
   */
  pickRecruitPeer(role, meta, subscriberId) {
    // Always pick the XOR-closest non-self, non-forwarder existing child.
    // Short-cutting to meta.fromId caused a ping-pong loop when two
    // cross-recruited sub-axons each had the other in children:
    //   A picks B → promote-axon to B → B.meta.fromId = A → B picks A →
    //   promote-axon to A → A.meta.fromId = B → A picks B → loop.
    return this._pickExistingChildForRecruit(role, subscriberId, meta.fromId);
  }

  /** XOR-closest existing child to `subscriberId`, excluding self AND the
   *  peer that forwarded us this message. Recruiting either creates
   *  infinite loops:
   *    - Self: promote-axon to self → loop back into _onPromoteAxon → loop.
   *    - Forwarder: if they're a cross-recruited sub-axon (i.e., they
   *      have US in THEIR children too), they'll pick us as recruit
   *      when processing the promote, and we ping-pong. Both nodes
   *      being each other's children happens when a common parent
   *      delegated both as sub-axons with the other as newSubscriberId.
   */
  _pickExistingChildForRecruit(role, subscriberId, excludeId = null) {
    if (role.children.size === 0) return null;
    const subBig = BigInt('0x' + subscriberId);
    let best = null;
    let bestDist = null;
    for (const childId of role.children.keys()) {
      if (childId === this.nodeId) continue;    // never recruit self
      if (childId === excludeId)   continue;    // never recruit the forwarder
      const d = BigInt('0x' + childId) ^ subBig;
      if (bestDist === null || d < bestDist) { bestDist = d; best = childId; }
    }
    return best;
  }

  /**
   * UNSUBSCRIBE routed message handler.
   *
   * If we are the axon holding this subscriber, drop them from children.
   * We do NOT eagerly dissolve an emptied non-root axon — that is handled
   * by §5.7 TTL sweep (or §5.8 hysteresis in Phase 3b). This keeps
   * unsubscribe semantics uniform with TTL expiry and avoids flapping on
   * rapid subscribe/unsubscribe churn.
   */
  _onUnsubscribe(payload, meta) {
    const { topicId, subscriberId } = payload;
    const role = this.axonRoles.get(topicId);
    if (role && role.children.has(subscriberId)) {
      role.children.delete(subscriberId);
      if (role.children.size === 0) role.emptiedAt = this._now();
      return 'consumed';
    }
    return 'forward';
  }

  /**
   * PUBLISH routed message handler.
   *
   * If we are the axon for this topic, fan out to all children via
   * sendDirect. Otherwise, forward along the route.
   */
  _onPublish(payload, meta) {
    const { topicId, json, publishId } = payload;
    const role = this.axonRoles.get(topicId);
    if (!role) return 'forward';
    if (this._alreadySeenPublish(publishId)) return 'consumed';

    const deadChildren = [];
    for (const [childId] of role.children) {
      if (childId === this.nodeId) {
        if (this._deliveryCallback) this._deliveryCallback(topicId, json);
        continue;
      }
      const ok = this.dht.sendDirect(childId, 'pubsub:deliver', { topicId, json, publishId });
      if (!ok) deadChildren.push(childId);
    }
    for (const dead of deadChildren) role.children.delete(dead);
    return 'consumed';
  }

  /**
   * Publish-id deduplication. Returns true if we've already processed
   * this publishId and should drop; returns false (first-time) and
   * records it otherwise. Bounded by _seenPublishCap and TTL'd by
   * _seenPublishTtlMs; both are enforced opportunistically on insert.
   */
  _alreadySeenPublish(publishId) {
    if (!publishId) return false;            // legacy / untagged publishes never dedup
    const now = this._now();
    if (this._seenPublishes.has(publishId)) {
      this._seenPublishes.get(publishId);    // insertion order unchanged
      return true;
    }
    this._seenPublishes.set(publishId, now);
    if (this._seenPublishes.size > this._seenPublishCap) {
      // Evict oldest half. Map iterates in insertion order.
      const toDrop = this._seenPublishCap / 2;
      let i = 0;
      for (const k of this._seenPublishes.keys()) {
        if (i++ >= toDrop) break;
        this._seenPublishes.delete(k);
      }
    }
    return false;
  }

  /**
   * DIRECT delivery handler — fires when an axon fan-out reaches us.
   *
   * Re-fan rule: only NON-ROOT axons (sub-axons recruited beneath a root)
   * re-broadcast to their children. Roots — the K-closest replicas for a
   * topic — never re-fan from a received pubsub:deliver. Rationale:
   *
   *   The publisher chose ONE root out of K and sent publish-k to it.
   *   That root's _onPublishDirect already initiated a complete fan-out
   *   through its own subtree. The other K-1 roots are not involved in
   *   this publish at all; their subscriber lists are full replicas but
   *   the protocol only uses one root per publish.
   *
   *   Without this rule, a subscriber that happens to also be a K-closest
   *   root creates a cycle: Root A fans to child S (= Root B). S's
   *   _onDeliver fires, S re-fans to its children (including A). A's
   *   _onDeliver fires, re-fans to S. Ping-pong forever.
   *
   * Leaves (no role) and sub-axons (role.isRoot === false) still deliver
   * locally + fan down appropriately.
   */
  _onDeliver(payload, meta) {
    const { topicId, json, publishId } = payload;
    if (this._alreadySeenPublish(publishId)) return;

    const role = this.axonRoles.get(topicId);
    if (role && !role.isRoot) {
      // Sub-axon: re-fan to our children. Skip the upstream peer and self.
      for (const [childId] of role.children) {
        if (childId === meta.fromId) continue;
        if (childId === this.nodeId) continue;
        this.dht.sendDirect(childId, 'pubsub:deliver', { topicId, json, publishId });
      }
    }

    // Local delivery to the adapter — always fires, whether or not we
    // have a role for this topic. Matches the app-level "I subscribed
    // to this topic" expectation.
    if (this._deliveryCallback) this._deliveryCallback(topicId, json);
  }

  /**
   * DIRECT handler — an upstream axon has promoted us to sub-axon status.
   * Payload: { topicId, newSubscriberId, parentId }.
   *
   * If we already have a role for this topic, just add newSubscriberId to
   * our children (the promoter is idempotent; they may send multiple
   * promote-axon messages as new subscribers arrive through us).
   *
   * If we do not have a role, create one with parentId set to the
   * promoter. Our own refreshTick will issue subscribes upward so the
   * promoter keeps us in its children.
   */
  _onPromoteAxon(payload, meta) {
    const { topicId, newSubscriberId, parentId } = payload;
    const now = this._now();

    let role = this.axonRoles.get(topicId);
    if (!role) {
      role = {
        parentId,
        isRoot:         false,
        children:       new Map(),
        parentLastSent: 0,
        roleCreatedAt:  now,
        emptiedAt:      0,
        lowWaterSince:  0,
      };
      this.axonRoles.set(topicId, role);
      // Immediately refresh upward so the promoter sees us as one of
      // their children right away (without waiting for the next tick).
      this.dht.routeMessage(topicId, 'pubsub:subscribe',
                            { topicId, subscriberId: this.nodeId });
    }

    // Use the shared add-or-recruit path so we cascade into our OWN
    // recruitment when at capacity, instead of hoarding subscribers past
    // maxDirectSubs. The parent in the payload tells us who promoted us,
    // but from the new subscriber's perspective WE are its parent.
    this._addOrRecruitChild(topicId, role, newSubscriberId, meta.fromId);
  }

  /**
   * DIRECT handler — our parent axon is dissolving and suggests we
   * re-attach via its own parent (or toward the hash).
   * Payload: { topicId, suggestedParent }.
   *
   * We immediately re-issue our own subscribe. The routed subscribe will
   * be intercepted by the first live axon on the path — which may be the
   * suggestedParent (the grandparent in the dissolved tree) or any
   * intermediate axon that still has capacity.
   *
   * Leaf subscribers receive this too — they just re-issue via their
   * mySubscriptions entry.
   */
  _onDissolveHint(payload, meta) {
    const { topicId } = payload;

    // Case 1: we are a direct subscriber (the hint lands here because the
    // dissolving axon had us as a leaf child). Re-route the subscribe via
    // our own pubsubSubscribe path if we still want this topic.
    if (this.mySubscriptions.has(topicId)) {
      this.dht.routeMessage(topicId, 'pubsub:subscribe',
                            { topicId, subscriberId: this.nodeId });
    }

    // Case 2: we are a sub-axon whose parent dissolved. Clear our parent
    // pointer and re-issue our upward subscribe so we attach to whoever
    // is now on the path to the hash.
    const role = this.axonRoles.get(topicId);
    if (role && !role.isRoot) {
      role.parentId = null;
      if (role.children.size > 0) {
        this.dht.routeMessage(topicId, 'pubsub:subscribe',
                              { topicId, subscriberId: this.nodeId });
      }
    }
  }

  // ── K-closest direct handlers ───────────────────────────────────────
  //
  // In K-closest mode subscribers STORE at every node in the K-closest
  // root set via sendDirect. Each such node treats itself as "in the
  // root set" for the topic and independently runs axonal recruitment
  // below itself. These handlers mirror the routed versions but skip the
  // terminal-election check (caller already decided we're a root).

  _onSubscribeDirect(payload, meta) {
    const { topicId, subscriberId, peerRoots } = payload;
    const now = this._now();

    let role = this.axonRoles.get(topicId);
    if (!role) {
      role = {
        parentId:       null,
        isRoot:         true,
        isInRootSet:    true,
        peerRoots:      new Set((peerRoots || []).filter(id => id !== this.nodeId)),
        children:       new Map(),
        parentLastSent: 0,
        roleCreatedAt:  now,
        emptiedAt:      0,
        lowWaterSince:  0,
      };
      this.axonRoles.set(topicId, role);
    } else {
      // Refresh our view of peer roots if the subscriber sent us a fresher
      // K-set (e.g., after churn drifted the K-closest).
      role.isInRootSet = true;
      if (peerRoots) {
        for (const p of peerRoots) if (p !== this.nodeId) role.peerRoots?.add(p);
      }
    }

    this._addOrRecruitChild(topicId, role, subscriberId, subscriberId);
  }

  _onUnsubscribeDirect(payload, meta) {
    const { topicId, subscriberId } = payload;
    const role = this.axonRoles.get(topicId);
    if (role && role.children.has(subscriberId)) {
      role.children.delete(subscriberId);
      if (role.children.size === 0) role.emptiedAt = this._now();
    }
  }

  _onPublishDirect(payload, meta) {
    const { topicId, json, publishId } = payload;
    if (this._alreadySeenPublish(publishId)) return;
    const role = this.axonRoles.get(topicId);
    if (!role) {
      // The publisher's findKClosest picked us but we don't hold this
      // topic. Fall back to a routed publish so the greedy walk toward
      // hash(topic) reaches a node that does. Dedup prevents loops.
      //
      // Known limitation: under heavy churn (25%+ in this sim's
      // sparsely-connected 50-edge routing), the publisher's and
      // subscribers' K-closest sets can diverge so much that even a
      // routed walk lands on role-holders that cover only a fraction
      // of the subscriber set. Full Kademlia-style iterative lookup
      // would converge more reliably; we have the primitives for that
      // in NX-6 but haven't wired them in as the K-closest fallback
      // path. Flagged as follow-up work in Phase 3 notes.
      this.dht.routeMessage(topicId, 'pubsub:publish', { topicId, json, publishId });
      return;
    }

    const deadChildren = [];
    for (const [childId] of role.children) {
      if (childId === this.nodeId) {
        if (this._deliveryCallback) this._deliveryCallback(topicId, json);
        continue;
      }
      const ok = this.dht.sendDirect(childId, 'pubsub:deliver', { topicId, json, publishId });
      if (!ok) deadChildren.push(childId);
    }
    for (const dead of deadChildren) role.children.delete(dead);
  }

  // ── Refresh and TTL sweep ───────────────────────────────────────────

  /**
   * One tick of the maintenance loop:
   *   1. Renew each of our own subscriptions (leaf refresh).
   *   2. Renew our axon memberships upward to parents (axon refresh).
   *      Phase 3a: single-axon-per-topic, so isRoot is the only branch.
   *   3. Sweep expired children from each axonRole.
   *   4. GC empty non-root roles. GC empty roots past rootGraceMs.
   *
   * Exposed publicly so tests can drive the state machine deterministically.
   */
  refreshTick() {
    const now = this._now();

    // 1. Leaf refresh — re-issue each of our own subscribes. In K-closest
    //    mode, the refresh re-STOREs at the current K-closest set so the
    //    root set tracks any ID-space drift from churn.
    for (const topicId of this.mySubscriptions.keys()) {
      if (this._useKClosestMode()) {
        const roots = this.dht.findKClosest(topicId, this.rootSetSize);
        for (const peerId of roots) {
          this.dht.sendDirect(peerId, 'pubsub:subscribe-k', {
            topicId, subscriberId: this.nodeId, peerRoots: roots,
          });
        }
      } else {
        this.dht.routeMessage(topicId, 'pubsub:subscribe',
                              { topicId, subscriberId: this.nodeId });
      }
    }

    // 2. Axon refresh — a non-root axon must refresh upward so its parent
    //    does not TTL-drop it. Phase 3a has no recruitment so all axons
    //    are roots; this block is a no-op here but the plumbing is in
    //    place for Phase 3b.
    //    An axon with no children has no reason to stay in the tree;
    //    skip the refresh and let the GC step remove it.
    for (const [topicId, role] of this.axonRoles) {
      if (role.isRoot) continue;
      if (role.children.size === 0) continue;
      this.dht.routeMessage(topicId, 'pubsub:subscribe',
                            { topicId, subscriberId: this.nodeId });
      role.parentLastSent = now;
    }

    // 3. TTL sweep — drop stale children.
    for (const role of this.axonRoles.values()) {
      for (const [childId, entry] of role.children) {
        if (now - entry.lastRenewed > this.maxSubscriptionAgeMs) {
          role.children.delete(childId);
        }
      }
      if (role.children.size === 0 && role.emptiedAt === 0) {
        role.emptiedAt = now;
      }
    }

    // 4. §5.8 hysteresis dissolve — a non-root axon whose child count has
    //    been below minDirectSubs for one full refresh interval sends a
    //    dissolve-hint to its children and removes its own role. The
    //    parent's next TTL sweep will drop this (now-silent) axon.
    //    Root never dissolves via hysteresis — it's bound to the hash.
    for (const [topicId, role] of this.axonRoles) {
      if (role.isRoot) continue;
      if (role.children.size === 0) continue;  // handled in step 5
      if (role.children.size >= this.minDirectSubs) {
        role.lowWaterSince = 0;
        continue;
      }
      if (role.lowWaterSince === 0) {
        role.lowWaterSince = now;
        continue;
      }
      if (now - role.lowWaterSince > this.refreshIntervalMs) {
        // One full refresh interval below min → dissolve.
        for (const [childId] of role.children) {
          this.dht.sendDirect(childId, 'pubsub:dissolve-hint', {
            topicId, suggestedParent: role.parentId,
          });
        }
        this.axonRoles.delete(topicId);
      }
    }

    // 5. GC empty roles.
    for (const [topicId, role] of this.axonRoles) {
      if (role.children.size > 0) continue;
      if (!role.isRoot) {
        // Non-root empty: dissolve immediately (TTL-driven collapse — no
        // outbound message needed; parent's next sweep will drop us).
        this.axonRoles.delete(topicId);
        continue;
      }
      // Root empty: respect rootGrace.
      if (role.emptiedAt > 0 && now - role.emptiedAt > this.rootGraceMs) {
        this.axonRoles.delete(topicId);
      }
    }
  }

  // ── Diagnostics ─────────────────────────────────────────────────────

  /** Snapshot for tests: list of (topicId, role) with serializable children. */
  inspectRoles() {
    const out = [];
    for (const [topicId, role] of this.axonRoles) {
      out.push({
        topicId,
        isRoot:         role.isRoot,
        parentId:       role.parentId,
        roleCreatedAt:  role.roleCreatedAt,
        emptiedAt:      role.emptiedAt,
        children: [...role.children.entries()].map(([id, e]) => ({
          id, createdAt: e.createdAt, lastRenewed: e.lastRenewed,
        })),
      });
    }
    return out;
  }

  /** Clean shutdown — stop the timer. Does not send unsubscribes; use
   *  pubsubUnsubscribe explicitly for a graceful departure. */
  destroy() {
    this.stop();
    this.axonRoles.clear();
    this.mySubscriptions.clear();
    this._deliveryCallback = null;
  }
}

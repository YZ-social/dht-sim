# DHT Simulator — Design Questions & Responses

**Date:** 2026-04-06
**Context:** Responses to architectural review questions about the DHT Globe simulator. Each response describes the current state of the simulator, identifies gaps, and proposes a path forward.

---

## 1. Bidirectional connections and connection-limit accounting

### Question summary
A connection is bidirectional: if A connects to B, B now has a connection to A whether it wants one or not. This must count against the connection limit in BOTH nodes, potentially forcing each to drop an existing connection.

### Current state
The simulator already models bidirectional connections. When `bidirectional = true` (the default), every edge A→B also creates a reverse edge B→A. The web-limit enforcement (added in v0.39.14) caps total connections per node:

- **K-DHT / G-DHT:** `KademliaNode.addToBucket()` checks `totalConnections` (sum of all bucket sizes) against `maxConnections` before adding any peer. When at capacity and the target bucket is empty (a new stratum group with zero coverage), the node evicts one peer from the *largest* bucket — preserving keyspace diversity. Otherwise the new peer is silently dropped.

- **Neuromorphic (NX series):** The synaptome is hard-capped at `MAX_SYNAPTOME_SIZE` (48 local + 12 highway). NX-5 uses stratum-aware eviction: when at capacity, the node evicts the weakest synapse from the most over-represented stratum group to make room for an under-represented one.

### Gap
The reverse-edge currently counts against B's budget, but B has **no agency** in deciding *what* to drop when the incoming connection forces it over capacity. In K-DHT, the `addToBucket` eviction logic fires, but it uses B's perspective (largest-bucket eviction), which is a reasonable heuristic but not a deliberate choice. In the neuromorphic protocols, B adds an `incomingSynapse` (lightweight, doesn't consume a synaptome slot) rather than a full synapse — so the reverse edge is second-class and doesn't trigger eviction.

### Proposed path
The observation that "B must realize these are the connections I have, which may not be the connections I'd like to have" is correct and important. We should:

1. **Make reverse-edge insertion trigger the same eviction logic as forward-edge insertion** — B should run its full stratified eviction when an incoming connection pushes it over capacity, choosing what to drop based on its own routing quality assessment.
2. **Add a `connectionRequestReceived(fromId)` hook** in the neuromorphic protocols where B can evaluate whether the incoming connection is worth keeping as a full synapse or should remain a lightweight incoming-only reference.
3. **Simulate this in the benchmark** by tracking how often nodes are forced to drop connections due to incoming pressure, and measuring the routing quality impact.

This is implementable within the existing architecture and is a natural extension of the web-limit enforcement work.

---

## 2. RPC response / request-reply semantics

### Question summary
Some messages need an RPC response. This can't be done only at the application level — the DHT must provide for request-reply, and it needs to be simulated.

### Current state
The simulator models **one-way lookups only**. A lookup routes from source to target and returns a result object (`{ found, hops, time, path }`), but this is a simulator abstraction — no actual response message traverses the network back to the sender. The `time` field is computed from the sum of round-trip latencies along the forward path, which implicitly assumes a response would take the same time.

Kademlia's iterative lookup is inherently request-reply at each hop (FIND_NODE returns a set of closer peers), but the simulator computes this synchronously rather than routing actual response messages.

### Gap
There is no simulation of:
- Response messages traversing the reverse path
- Response routing failures (intermediate node died after forwarding)
- Asymmetric latency (response may take a different path than request)
- The cost of maintaining state for pending responses at each intermediate node

### Proposed path
1. **Add a `RequestReply` message type** to the simulation engine that routes a request forward and then routes a response backward along the recorded path.
2. **Track pending-response state** at each intermediate node — if the node dies before the response arrives, the response is lost and the sender must time out.
3. **Measure round-trip success rate** separately from one-way success rate — this will be strictly lower because any hop failure in either direction kills the RPC.
4. **Model timeout behavior** — the sender waits for a configurable timeout (e.g. 5 seconds) and declares failure if no response arrives.

This directly affects the metrics we care about (transport reliability, pub/sub delivery confirmation) and should be a simulation priority.

---

## 3. Connection formation delay and multi-hop connection setup

### Question summary
Forming a new WebRTC connection takes ~2 seconds. The initiating node must send (usually 2) messages to the target WITHOUT directly connecting to it — meaning messages must be routed through the existing network. This requires at least two hops between sender and target.

### Current state
**No connection formation delay is modeled.** The simulator treats every message as if a persistent connection already exists between the sender and each of its routing table peers. New connections (synapses, bucket entries) are created instantaneously during `addToBucket`, `addSynapse`, or `bootstrapJoin`.

### Gap
This is a significant model gap. In a real WebRTC deployment:
- **ICE negotiation** requires an offer/answer exchange (2 messages minimum) routed through existing peers
- Each message traverses 2+ hops (since sender and target aren't yet directly connected)
- The total setup time is ~2 seconds (ICE + DTLS + SCTP)
- During this time, the network state may change (other nodes joining/leaving)
- The connection attempt may fail if routing can't reach the target

### Proposed path
1. **Add a `CONNECTION_SETUP_MS` parameter** (default 2000) that represents the time cost of establishing a new direct connection.
2. **Model the signaling exchange** as two routed messages (offer + answer) that traverse the existing network — each paying full routing cost (hops × latency).
3. **Connections become "pending" during setup** — they don't contribute to routing until the handshake completes. This prevents the simulator from using a connection the instant it's discovered.
4. **Connection setup failure** — if either signaling message fails to route, the connection is not established. This creates a realistic bootstrapping challenge where poorly-connected nodes struggle to form new connections.

This interacts with question 2 (RPC) because the signaling exchange is inherently request-reply.

---

## 4. Minimum two-hop routing for privacy/security

### Question summary
For security (and civil defense), messages should traverse at least two hops even when a direct connection exists. This affects connection and routing decisions.

### Current state
The simulator always takes the shortest path. If a node has a direct synapse to the target, it uses it in one hop. The AP routing formula scores direct connections highly because they offer maximum XOR progress in a single hop.

### Gap
No minimum-hop constraint exists. A 1-hop direct route is always preferred when available.

### Proposed path
1. **Add a `MIN_HOPS` parameter** (default 2 for privacy mode, 1 for performance mode) that prevents the routing algorithm from delivering to the target until the message has traversed at least `MIN_HOPS` intermediate nodes.
2. **Modify AP routing** to suppress "direct-to-target" shortcuts when `hops < MIN_HOPS`. The message would be forwarded to the best intermediate node first, then to the target.
3. **This affects routing quality metrics** — hop counts will increase and the synaptome will learn to optimize 2-hop paths rather than 1-hop shortcuts. The learning system should naturally adapt: instead of learning "A→D direct", it would learn "A→B→D" where B is the best relay.
4. **Measure the cost** — what's the latency penalty of enforced 2-hop routing? At what network size does it become negligible?

This is compatible with the existing architecture. The neuromorphic learning system would naturally optimize for the best 2-hop paths once direct shortcuts are suppressed. The two-hop AP lookahead already evaluates 2-hop paths — we'd just be making it the minimum rather than a lookahead optimization.

Note: This has implications for pub/sub. The relay→subscriber broadcast already goes through bridge nodes (typically 2 hops in NX-2W+). Enforcing MIN_HOPS=2 for the sender→relay path would mean a minimum of 3 hops for any pub/sub message cycle, which is still reasonable.

---

## 5. Node drop detection and failure propagation

### Question summary
When a node drops, should this information propagate back to the sender and intermediate nodes? The sender and intermediate nodes might have also dropped.

### Current state
When a node is removed (`dht.removeNode(id)`), it is marked `alive = false` and that's it. **No goodbye message is sent.** Other nodes discover the failure **lazily** — the next time they try to route through the dead node, they find it unreachable and skip it. In neuromorphic protocols, dead nodes encountered during routing have their synapse weight zeroed, and the next decay tick prunes them.

### Gap
- No explicit "goodbye" mechanism for graceful departures
- No failure propagation — intermediate nodes don't learn that a peer died until they try to use it
- No timeout modeling — the simulator skips dead nodes instantly rather than waiting for a timeout
- No in-flight message loss — if a message is "in transit" when a node dies, it's not modeled

### Proposed path
1. **Graceful departure (parameterized):** A configurable fraction of nodes (e.g. 80%) send a "goodbye" message to all their direct connections before departing. Each connection partner immediately marks the synapse as dead and can begin eviction/replacement.
2. **Ungraceful departure:** The remaining fraction simply disappears. Direct connections detect the failure after a **channel timeout** (e.g. 5 seconds for WebRTC). During the timeout window, messages routed through the dead node are lost.
3. **Failure propagation:** When a node detects a peer failure (via timeout or goodbye), it can optionally notify its own connections — but this notification is best-effort, not reliable. The notification itself might fail if the notifying node also drops.
4. **In-flight message handling:** Messages currently "in transit" through a dead node are lost. The sender must rely on the RPC timeout (question 2) to detect this.
5. **Simulation impact:** During the timeout window (0–5 seconds), routing quality degrades because messages are being sent into a black hole. This creates a realistic "failure detection latency" that the current simulator doesn't capture.

For the neuromorphic protocols specifically, failure detection could trigger an annealing temperature spike on the detecting node — encouraging it to explore replacement connections faster.

---

## 6. Timeout behavior and recursive message reliability

### Question summary
What happens in the gap between a node dropping and detection? How long should a sender wait to hear of success or failure?

### Current state
The simulator has no timeout modeling. Dead nodes are skipped instantaneously — `if (!peer?.alive) continue` — with zero time cost. This is optimistic.

### Gap
Real-world timeout cascades are complex:
- Node A sends to B, B forwards to C, C is dead
- B waits for C's response (timeout: 5 seconds)
- B sends failure notification back to A (1 hop latency)
- Total failure detection time for A: 5 seconds + 1 hop RTT
- If B also dies during the wait, A waits for its own timeout on B

### Proposed path
1. **Model per-hop timeouts.** Each intermediate node that forwards a message waits up to `HOP_TIMEOUT_MS` (e.g. 5000) for a response from the next hop. On timeout, it sends a failure response upstream.
2. **Model cascading timeouts.** If multiple consecutive hops fail, the timeouts stack. The sender's total wait time is bounded by `MAX_GREEDY_HOPS × HOP_TIMEOUT_MS` in the worst case, but typically much less because the first timeout cascades back quickly.
3. **Add a `SENDER_TIMEOUT_MS` parameter** that caps the total wait time. After this, the sender declares the message failed regardless of whether failure notifications arrive.
4. **Retry logic** (optional): On timeout, the sender can retry via a different path. The neuromorphic learning system would naturally learn to avoid the failed path on retry.

This is tightly coupled with questions 2, 3, and 5. A realistic implementation would model the full lifecycle:
- Send request (forward path)
- Each hop waits for downstream response
- On downstream timeout: propagate failure upstream
- On success: propagate response upstream
- Sender declares success or failure based on first response or sender timeout

---

## 7. Data replication and storage

### Question summary
Data replication can't be handled strictly at a higher level. The DHT needs to ensure data survives node departures. The Kademlia approach involves periodic probes and proactive replication to closer nodes.

### Current state
**The simulator has no storage or replication logic whatsoever.** It is purely a routing simulator — it measures how efficiently messages traverse the network, but doesn't model what happens to data stored at nodes. The "storage hotspot" test in the Hotspot benchmark assigns content items to nodes and measures query load distribution, but this is statistical modeling, not actual storage simulation.

### Gap
This is the largest gap between the simulator and a production DHT. In a real deployment:
- Data must be stored at `k` nodes closest to the content key
- When nodes depart, replicas must be proactively redistributed
- New nodes that join near a content key should receive replicas
- Periodic republishing ensures data survives gradual churn
- The neuromorphic routing table (which nodes you know about) directly affects which replicas you can maintain

### Proposed path
This is a substantial new subsystem. The implementation should be layered:

**Layer 1 — Storage model:**
- Each node has a `storage: Map<contentKey, data>` alongside its routing table
- Content is stored at the `k` nodes closest to the content key (by XOR distance)
- Storage consumes a per-node budget (simulating memory/disk limits)

**Layer 2 — Proactive replication (Kademlia-style):**
- Each storing node periodically probes for the `k` closest nodes to each stored key
- If a closer node is discovered that doesn't have the data, replicate to it
- If a storing node can no longer find itself among the `k` closest, it can release the data

**Layer 3 — Neuromorphic replication (new):**
- The synaptome already tracks which peers are reliable and frequently-contacted
- Replication decisions can be informed by synapse weight: prefer replicating to high-weight peers (proven reliable) over merely XOR-close peers
- The learning system naturally discovers which nodes are stable (high useCount, low churn) — these make better replica holders
- Annealing could be extended to periodically verify replica health

**Layer 4 — Measurement:**
- **Data survival rate:** What fraction of stored items are retrievable after N churn intervals?
- **Replication overhead:** How many replication messages per stored item per time unit?
- **Recovery time:** After a node drops, how quickly are its replicas redistributed?

This is the right level of abstraction — it's not application logic, it's fundamental DHT infrastructure. Transport, storage, and pub/sub all depend on it. We should implement this as a new simulation mode alongside Lookup, Churn, and Pub/Sub.

---

## 8. Node identifier persistence across sessions

### Question summary
Are node identifiers persistent across sessions? Wouldn't that be a security problem?

### Current state
Node IDs are **persistent within a simulation run** but **not across page reloads**. Each time you click "Init", new random IDs are generated. The "Pair Learning" test assigns fixed source→target pairs at test start and routes them repeatedly across multiple training sessions — but the pairs are generated fresh each time the test starts.

In a real deployment, node IDs would need to be persistent across sessions (reconnections) for the routing table to remain valid. The simulator doesn't model session persistence.

### Security implications
Persistent node IDs create several risks:
- **Tracking:** An observer can correlate a node's activity across sessions by its ID
- **Eclipse attacks:** An attacker can pre-compute IDs that target specific keyspace regions and gradually surround a victim node
- **Sybil attacks:** An attacker can generate many IDs in a specific region to dominate storage/routing for keys in that region

### Proposed path
1. **ID rotation:** Nodes periodically generate new IDs while maintaining routing continuity. The old ID is announced as deprecated to direct connections, who update their routing tables. This limits tracking while preserving routing table validity.
2. **Proof-of-work on ID generation:** Require computational work to generate a valid ID, making Sybil attacks expensive. The geographic prefix bits would be verifiable (tied to a proof-of-location or IP geolocation).
3. **Simulation support:** Add an "ID rotation" parameter that periodically reassigns IDs to a fraction of nodes, measuring the routing disruption cost.

For the questions about replication (7) and drop handling (5-6), persistent IDs make replication easier (you know who holds replicas and can verify they're still there) but drop handling harder (a departed node's ID becomes a permanent hole in the keyspace until its data is replicated elsewhere).

---

## 9. Key space: 64 bits with geographic prefix

### Question summary
Do the 64-bit keys include the region prefix? Does that leave enough for a secure hash?

### Current state
Yes, the 64-bit node ID includes the geographic prefix in its high-order bits:

```
64-bit Node ID:
┌──────────────┬────────────────────────────────────────────────┐
│ geo prefix   │ random suffix                                  │
│ (8 bits)     │ (56 bits)                                      │
│ 256 cells    │ ~7.2 × 10^16 unique IDs per cell               │
└──────────────┴────────────────────────────────────────────────┘
```

With `geoBits = 8` (default), 56 bits remain for the random suffix. This is **not enough for a cryptographically secure hash**. SHA-256 produces 256 bits; even truncated to 56 bits, the collision probability is concerning at scale.

### Collision analysis
For `n` items in a space of `2^b` possible values, the birthday-paradox collision probability is approximately `1 - e^(-n² / 2^(b+1))`.

With 56 random bits (`2^56 ≈ 7.2 × 10^16`):
- 10,000 nodes per cell: collision probability ≈ 7 × 10⁻¹⁰ (negligible)
- 1 billion nodes per cell: collision probability ≈ 0.7% (concerning)
- 10 billion total items globally across 256 cells (~39M per cell): collision probability ≈ 1 × 10⁻² per cell

For **content keys** (which don't have a geographic prefix — they use the full 64 bits):
- 10 billion content items in `2^64`: collision probability ≈ 2.7 × 10⁻⁰ — essentially certain to have collisions.

### The real issue
64 bits is insufficient for a production DHT with content-addressing. This is fine for the simulator (which never stores more than 100K nodes), but a production system would need 128 or 256 bits. The simulator already supports configurable bit widths (8, 16, 32, 64, 128) — 128 bits would provide `2^120` content-address space after an 8-bit geo prefix, which is collision-resistant for any practical workload.

### Tooltip correction
The reviewer noted that the tooltip says "Higher prefix bits = finer resolution." The current tooltip actually reads: **"More bits = finer geographic resolution"** — this appears to have been corrected already. (The word "More" is used, not "Higher".)

---

## 10. Load modeling on popular nodes

### Question summary
Does latency increase with traffic? Is the Gini coefficient in N-7W handling overload?

### Current state
**Latency is purely distance-based with no load-dependent component.** The latency model is:

```
RTT(A, B) = 2 × (great_circle_km(A,B) / SPEED_OF_LIGHT_KM_MS + HOP_COST_MS)
```

The `HOP_COST_MS = 10` is a fixed per-hop processing delay, identical for all nodes regardless of how much traffic they're handling.

N-7W introduced **load-aware AP scoring** — nodes with high relay traffic have their AP scores discounted so routing avoids them — but this was subsequently disabled in N-10W and all NX protocols because it harmed pub/sub relay performance (the relay node is supposed to be heavily contacted, and discounting it makes routing avoid it).

The Gini coefficient is measured but doesn't feed back into the simulation — it's a diagnostic metric, not a control mechanism.

### Gap
In a real deployment:
- A node handling 100 concurrent connections has higher per-message latency than one handling 10
- Bandwidth saturation creates hard stops — messages are dropped, not just delayed
- CPU-bound nodes (e.g., running WebRTC DTLS encryption) have non-linear latency curves
- The lack of load-dependent latency means the simulator over-estimates the quality of hub-heavy routing strategies

### Proposed path
1. **Add a load-dependent latency component:**
   ```
   effective_delay = HOP_COST_MS × (1 + LOAD_FACTOR × active_connections / MAX_CONNECTIONS)
   ```
   This makes heavily-loaded nodes slower, naturally creating routing pressure to distribute traffic.

2. **Add a queue model** — each node has a message queue with a processing rate. When the queue is full, messages are dropped (simulating bandwidth exhaustion).

3. **Re-evaluate load-aware AP scoring** with the load-latency model in place. N-7W's approach may work better when the load signal is reflected in actual latency rather than just an AP discount.

---

## 11. Bandwidth limit modeling

### Question summary
There may be hard bandwidth stops that nodes don't know about until reached, and there might be user-configurable bandwidth targets.

### Current state
**No bandwidth modeling exists.** The simulator assumes infinite bandwidth at every node. Messages are delivered instantly (subject to latency) with no queuing, congestion, or throughput limits.

### Gap
Real-world bandwidth constraints include:
- **Upstream bandwidth** — residential connections often have asymmetric upload (e.g. 10 Mbps up, 100 Mbps down). A node relaying many messages can saturate its upload.
- **Connection-level limits** — WebRTC data channels have per-connection throughput caps.
- **ISP throttling** — some ISPs throttle P2P traffic patterns.
- **Hard vs. soft limits** — soft limits degrade gracefully (higher latency); hard limits cause message drops.

### Proposed path
1. **Per-node bandwidth budget:** Each node has a configurable `MAX_BANDWIDTH_KBPS` (default: e.g. 10,000 for 10 Mbps upstream). Each message consumes bandwidth proportional to its size (a new parameter).
2. **Bandwidth exhaustion:** When a node's bandwidth is saturated in a given time window, additional messages are either queued (adding latency) or dropped (reducing success rate).
3. **Advertised limits:** Nodes can advertise their bandwidth capacity to peers. The AP routing formula could incorporate bandwidth as a factor — preferring high-bandwidth relay nodes when available.
4. **Measurement:** Add a "bandwidth utilization" metric to the benchmark, measuring what fraction of each node's bandwidth budget is consumed under different traffic patterns.

This interacts with load modeling (question 10) — bandwidth exhaustion is one of the primary causes of load-dependent latency increases.

---

## 12. Fixed delay and training realism

### Question summary
Is there a risk that fixed delay time allows neuromorphic models to simulate better than they would in practice, where random longer delays could mislead training?

### Current state
The per-hop delay (`HOP_COST_MS = 10`) is **fixed and deterministic**. The geographic component of latency varies by distance but is also deterministic (no jitter). This means:
- The AP formula always gets a clean signal: "this path took X ms because it's Y km long"
- There's no noise to confuse the learning system
- Weight reinforcement (LTP) is always based on accurate latency information

### Gap
Real-world latency is noisy:
- **Jitter:** Same path, same distance, but RTT varies ±20% due to network conditions
- **Congestion spikes:** Occasional 10× latency spikes when a node or link is congested
- **Asymmetric paths:** Forward and reverse paths may have different latency
- **Tail latency:** P99 latency can be 5-10× the median

The neuromorphic learning system is optimizing for a deterministic world. In a noisy world:
- The AP formula might reinforce a path that happened to have a good latency sample, then be disappointed next time
- Decay might prune a synapse that had one bad latency sample despite being generally good
- The EMA latency update (`latency += 0.2 × (sample - latency)`) would oscillate rather than converge

### Proposed path
1. **Add latency jitter:** `effective_latency = base_latency × (1 + jitter)` where `jitter ~ Normal(0, JITTER_SIGMA)` with `JITTER_SIGMA = 0.15` (15% standard deviation).
2. **Add congestion spikes:** With probability `SPIKE_PROB = 0.02`, multiply latency by `SPIKE_FACTOR = 5`. This creates the tail-latency distribution seen in real networks.
3. **Evaluate robustness:** Run benchmarks with and without jitter/spikes. If neuromorphic protocols degrade significantly, the learning parameters (EMA alpha, decay rates, reinforcement thresholds) need tuning for noisy environments.
4. **Adaptive EMA:** The latency EMA alpha (currently fixed at 0.2) could be made adaptive — smaller alpha (slower update) in high-jitter environments to smooth out noise.

This is a legitimate concern. The clean-signal environment almost certainly flatters the neuromorphic protocols relative to what they'd achieve in production. Testing with realistic noise is important for validating the approach.

---

## 13. Churn success rate: per-message or per-hop?

### Question summary
Is the success rate measuring overall message success or per-hop success? Kademlia shows 62% overall, but the original paper reported "nearly 100%".

### Current state
**The success rate measures per-message (end-to-end) success**, not per-hop. From `Engine.js`:

```javascript
if (result && result.found) {
    hopsArr.push(result.hops);   // count as success
} else {
    failures++;                   // count as failure
}
successRate = hopsArr.length / lookupsPerInterval;
```

Each lookup either finds the exact target node (success) or doesn't (failure). A lookup with 5 successful hops that fails on the 6th counts as a failure.

### Why the discrepancy with the Kademlia paper
The Kademlia paper's "nearly 100%" success rate was measured under very different conditions:

1. **The paper used content-based keys, not node-ID lookup.** A "successful" lookup meant finding any node responsible for the key (the closest live node), not finding a specific target node by exact ID match. Our simulator requires finding the **exact target node** — if that specific node is dead, the lookup fails even if nearby nodes are alive.

2. **The paper's churn model was different.** Maymounkov & Mazières modeled steady-state churn where nodes have exponentially-distributed session times with a median of 1 hour. The simulator's 5% churn rate per interval with immediate replacement is a different (and harsher) churn model.

3. **The paper used k=20 redundancy with iterative closest-node convergence.** With 20 replicas per key, at least one of the 20 closest nodes is very likely alive. Our simulator doesn't do key-based storage — it looks for a specific node.

4. **Web Limit enforcement** (added in v0.39.14) now caps K-DHT to 50 connections, compared to the paper's unrestricted bucket filling. This significantly reduces K-DHT's fault tolerance.

### Proposed path
To bring the churn test closer to the paper's methodology:
1. **Add a "closest-node" success mode** — a lookup succeeds if it finds the closest *alive* node to the target key, even if the original target is dead. This would match the paper's definition and likely show much higher success rates.
2. **Separate "exact-node" and "closest-node" success rates** in the output, since both are useful: exact-node for messaging (you need to reach a specific peer), closest-node for storage (you need to reach whoever holds the data).

---

## 14. Churn parameters vs. Kademlia paper definition

### Question summary
The original Kademlia definition was that every node's average online time is the probing/refresh interval, with k=20 providing enough redundancy. L/Int=1 and Rate=95% would match this, but the UI doesn't allow those values.

### Current state
The UI constrains:
- **L/Int** (lookups per interval): minimum 20, default 100
- **Rate** (churn rate): maximum 30%, default 5%

These constraints were set for simulator stability (very low L/Int produces statistically meaningless results; very high churn rates cause complete network collapse in the simulator).

### The Kademlia churn model mismatch
The Kademlia paper models **continuous churn** where:
- Each node has an exponentially-distributed session time
- At any given moment, some nodes are joining and others are leaving
- The *rate* of churn is steady but individual events are stochastic
- k=20 means that even if 19 of 20 nodes in a bucket leave, the remaining 1 can rebuild

The simulator models **batch churn** where:
- All departures happen simultaneously at interval boundaries
- All replacements also happen simultaneously
- There's no gradual replacement — it's a sudden shock

These are fundamentally different. Batch churn at 5% is much harsher than continuous churn at the same average rate because:
- All failures are correlated (simultaneous), not independent
- The network has zero time to adapt between departures
- Replacement nodes all arrive at once with empty routing tables

### Proposed path
1. **Expand the parameter ranges** — allow L/Int down to 1 and Rate up to 95%, with appropriate warnings about statistical significance.
2. **Add continuous churn mode** — instead of batch replacement at interval boundaries, model individual node departures and arrivals as a Poisson process throughout the measurement period. This would match the Kademlia paper's model.
3. **Add session-time distribution** — each node is assigned an exponentially-distributed lifetime. When its time expires, it departs (with or without goodbye per question 5). This naturally produces the Kademlia paper's churn pattern.

With continuous churn and k=20, we should see success rates much closer to the paper's "nearly 100%".

---

## 15. Geographic ID forgery and portal distribution

### Question summary
How do we prevent forging geographic identifiers? And don't we want portals to be able to distribute themselves?

### Current state
There is **no ID verification whatsoever**. A node claims its geographic position at construction time, and the geo-prefix is computed from that claim. Nothing prevents a node from lying about its location to insert itself at a strategic position in the keyspace.

### Attack vectors
1. **Location spoofing:** An attacker claims to be at a geographic position that places them near a target key, allowing them to intercept or store data for that key region.
2. **Eclipse attack:** Multiple attacker nodes claim positions surrounding a victim, gradually becoming the only peers in the victim's routing table.
3. **Sybil attack:** An attacker generates many fake nodes at strategic positions to dominate storage or routing for specific keys.

### Proposed path for ID verification
1. **IP geolocation verification:** When a node joins, its IP address is checked against geolocation databases. The claimed geographic prefix must be consistent with the IP geolocation within some tolerance (e.g., same country or continent). This prevents remote attackers from claiming arbitrary positions but doesn't prevent local attacks.
2. **Proof-of-location protocols:** More sophisticated approaches using network latency triangulation — if a node claims to be in Tokyo, its RTT to known Tokyo nodes should be consistent with that claim.
3. **Proof-of-work per geo-cell:** Require computational work to claim a position in a specific geo-cell. This makes it expensive to claim many positions (Sybil defense).
4. **Certificate-based IDs:** A trusted authority (or a decentralized certificate system) issues signed geographic IDs after verifying location. This is the most secure but least decentralized approach.

### Portal distribution
If "portals" (service endpoints) need to distribute themselves geographically for availability and latency:
- They should be able to register at multiple geographic positions simultaneously
- Each portal instance would have a different geo-prefix but share a common content/service key
- Lookups for the service key would find the geographically nearest portal instance
- This is compatible with the current architecture — a portal simply runs multiple DHT nodes at different locations, each announcing the same service key

### Simulation support
We should add:
1. An "adversarial nodes" parameter — a fraction of nodes that deliberately claim false geographic positions
2. A "location verification" mode that rejects nodes whose latency profile doesn't match their claimed position
3. Metrics for attack detection — how many lookups are intercepted by adversarial nodes?

---

## Summary: Prioritized Implementation Roadmap

Based on the three stated goals (transport, storage, pub/sub), here's a suggested priority order:

| Priority | Question | Area | Effort | Impact |
|---|---|---|---|---|
| **P0** | 2, 6 | RPC response + timeouts | Medium | Fundamental for transport reliability |
| **P0** | 7 | Data replication/storage | Large | Required for storage goal |
| **P1** | 1 | Bidirectional connection accounting | Small | Affects all routing quality |
| **P1** | 5 | Node drop detection + goodbye | Medium | Affects churn resilience |
| **P1** | 3 | Connection formation delay | Medium | Affects bootstrap realism |
| **P1** | 12 | Latency jitter | Small | Validates neuromorphic robustness |
| **P2** | 4 | Min-hop privacy routing | Small | Security requirement |
| **P2** | 10, 11 | Load + bandwidth modeling | Medium | Realism for large deployments |
| **P2** | 13, 14 | Churn model improvements | Medium | Benchmark accuracy |
| **P3** | 8 | ID persistence/rotation | Small | Security consideration |
| **P3** | 9 | Key space expansion (128-bit) | Small | Already supported in UI |
| **P3** | 15 | Geographic ID verification | Medium | Anti-abuse mechanism |

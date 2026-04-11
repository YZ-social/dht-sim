# Neuromorphic DHT Architecture

**A Biologically-Inspired Distributed Hash Table with Axonal Publish/Subscribe**

*Version 0.0.2*

---

## Introduction

Distributed hash tables (DHTs) are the backbone of decentralized systems -- they allow a network of independent computers to collectively store and retrieve data without any central server. Since their introduction in the early 2000s, DHTs have powered file sharing, content delivery, blockchain networks, and decentralized communication. Yet the core routing mechanisms have changed remarkably little since Kademlia's publication in 2002.

This document describes two new approaches developed as part of this research effort:

1. A **Geographic DHT (G-DHT)** that extends Kademlia by encoding a node's physical location into its identifier using S2 geometry. This simple modification halves lookup latency by making XOR routing geographically aware, while a stratified allocation strategy maintains Kademlia's 100% reachability guarantee.

2. A **Neuromorphic DHT** that replaces static routing tables entirely with adaptive, biologically-inspired mechanisms. Drawing from neuroscience, each node maintains a dynamic set of weighted connections (a *synaptome*) that strengthens on successful routes and weakens through disuse -- mirroring how biological neurons form and prune synaptic connections. The system learns the network's topology through experience rather than relying on rigid algorithmic structure.

Built atop the Neuromorphic routing layer is the **Axonal Pub/Sub** system -- a scalable publish/subscribe mechanism where broadcast trees emerge from the routing topology itself. Named after the axonal arbor (the branching output structure of a neuron that delivers signals to many downstream targets), this tree delegates delivery to intermediate nodes that are already on the natural routing path, achieving near-zero overhead for broadcast distribution.

### How It Compares

| Property | Kademlia | G-DHT | Neuromorphic DHT |
|----------|----------|-------|------------------|
| Routing table | Fixed k-buckets | Fixed k-buckets | Adaptive synaptome, ~60 weighted connections |
| Route selection | XOR distance only | XOR distance (geo-aware) | Activation potential: distance + latency + reliability |
| Learning | None | None | Continuous: reinforcement, annealing, decay |
| Latency awareness | None | Via geographic IDs | Integral to route scoring |
| Geographic awareness | None | S2 cell prefix in node ID | S2 cell prefix in node ID |
| Pub/sub | Not built-in | Not built-in | Axonal tree mirrors routing topology |
| Churn recovery | Lazy k-bucket refresh | Lazy k-bucket refresh | Immediate: temperature reheat + synapse replacement |

In simulations with 25,000 globally-distributed nodes under browser-realistic connection limits (50 peers per node), the Neuromorphic DHT routes in approximately 3.5 hops at 221 ms latency, compared to Kademlia's 8.4 hops at 1,024 ms -- a 78% latency reduction. Without connection limits, the Neuromorphic DHT achieves 2.8 hops at 194 ms, compared to Kademlia's 6.2 hops at 738 ms -- a 74% reduction. Both the G-DHT and Neuromorphic DHT support scalable pub/sub delivery to thousands of subscribers with bounded per-node work.

This document is structured so that a technical reader -- or an AI system -- can reconstruct a working implementation from its descriptions. Each chapter builds on the previous, culminating in a complete implementation plan.

---

## Chapter 1: A Brief History of Distributed Hash Tables

### 1.1 The Problem

In the late 1990s, the explosive growth of peer-to-peer file sharing (Napster, Gnutella) exposed a fundamental tension: centralized directories were efficient but fragile and legally vulnerable; fully decentralized flooding was resilient but unscalable. The question became: *can a network of peers collectively implement a key-value lookup service with the efficiency of a centralized index and the resilience of a fully decentralized system?*

### 1.2 The First Generation (2001--2002)

Four research groups independently answered this question within months of each other, each proposing a structured peer-to-peer overlay network -- what would come to be called distributed hash tables:

**Chord** (Stoica et al., MIT, 2001) arranged nodes on a circular identifier space. Each node maintained a "finger table" with O(log N) pointers to nodes at exponentially increasing distances around the ring. Lookups traversed O(log N) hops by following the finger closest to the target without overshooting. Chord's elegance was its simplicity: the ring structure made correctness proofs tractable and join/leave operations well-defined.

**CAN** (Ratnasamy et al., Berkeley, 2001) used a d-dimensional Cartesian coordinate space, partitioning it into zones owned by individual nodes. Routing followed a greedy path through adjacent zones toward the target coordinates. CAN offered O(N^(1/d)) hop counts at the cost of O(d) routing table entries, and its multi-dimensional structure provided natural load balancing.

**Pastry** (Rowstron & Druschel, Microsoft/Rice, 2001) combined prefix-based routing with a leaf set of numerically close neighbors and a neighborhood set of physically close nodes. This hybrid approach explicitly considered network locality -- a property that Chord and CAN initially ignored. Pastry resolved lookups in O(log N) hops while naturally preferring low-latency paths.

**Tapestry** (Zhao et al., Berkeley, 2001) used a similar prefix-based approach with suffix routing, emphasizing fault tolerance through multiple redundant paths. Tapestry's contribution was demonstrating that structured overlays could provide strong availability guarantees even under significant churn.

**Kademlia** (Maymounkov & Mazieres, NYU, 2002) introduced XOR distance as the routing metric, which had the elegant property of being symmetric (distance from A to B equals distance from B to A) and supporting a single routing algorithm for both lookup and node joining. Kademlia's k-buckets -- fixed-size lists of known peers at each distance range -- provided natural redundancy and resistance to certain attacks. Its combination of simplicity, symmetry, and robustness made it the most widely adopted DHT in practice.

### 1.3 Evolution and Applications

**BitTorrent** (2005+) adopted a Kademlia variant (Mainline DHT) for trackerless peer discovery, eventually becoming the largest deployed DHT with millions of simultaneous nodes. The Mainline DHT demonstrated that Kademlia could operate at massive scale, though with high lookup latency (often 10+ seconds due to timeout chains).

**Ethereum** (2015+) uses a modified Kademlia (devp2p) for peer discovery in its blockchain network. The combination of Kademlia's reliable node discovery with application-level gossip protocols has proven effective for blockchain consensus.

**IPFS** (2015+) built its content-addressable storage layer on a Kademlia DHT (libp2p), using it to map content hashes to the peers storing that content. IPFS extended Kademlia with content routing records and provider announcements.

**Coral** (Freedman et al., 2004) introduced "distributed sloppy hash tables" (DSHTs) that organized nodes into clusters by round-trip time, preferring nearby nodes for lookups. This foreshadowed the geographic awareness that would become central to later DHT designs.

**S/Kademlia** (Baumgart & Mies, 2007) addressed Kademlia's security weaknesses with cryptographic node ID generation, sibling broadcasts for data replication, and disjoint lookup paths to resist Eclipse attacks.

### 1.4 The Persistent Limitations

Despite two decades of refinement, DHTs have retained several fundamental limitations:

1. **No latency awareness**: Traditional DHTs route purely by ID-space distance. A lookup may bounce between continents when a geographically closer path exists.

2. **No learning**: Routing tables are populated mechanically (bucket fills on contact) and never adapt to traffic patterns. A frequently-used route receives no preferential treatment.

3. **High hop counts**: O(log N) hops is the theoretical bound, and in practice Kademlia networks often require 8--12 hops per lookup.

4. **No built-in pub/sub**: Group communication requires application-level overlays built atop the DHT, adding complexity and additional hops.

5. **Slow churn recovery**: When nodes depart, routing tables are repaired lazily through periodic refresh, leaving routing gaps that can persist for minutes.

The Neuromorphic DHT addresses all five of these limitations.

---

## Chapter 2: The Kademlia DHT -- A Foundation

This chapter describes how Kademlia works, as it serves as the baseline against which the Neuromorphic DHT is compared.

### 2.1 Identifier Space

Every node and every data key occupies a position in a flat identifier space of B bits (typically 160 bits using SHA-1, though our simulator uses 64 bits). Node IDs are generated from the hash of the node's public key or IP address.

The **XOR distance** between two identifiers a and b is defined as:

```
distance(a, b) = a XOR b
```

XOR distance has three key properties:
- **Identity**: distance(a, a) = 0
- **Symmetry**: distance(a, b) = distance(b, a)
- **Triangle inequality**: distance(a, c) <= distance(a, b) + distance(b, c)

Symmetry is important: if node A considers B close, B also considers A close. This means every routing query simultaneously helps both the querier and the responder learn about each other.

### 2.2 K-Buckets

Each node maintains a routing table of **k-buckets**. For a B-bit identifier space, there are B buckets (bucket 0 through bucket B-1). Bucket i contains up to k nodes (typically k=20) whose XOR distance from the local node falls in the range [2^i, 2^(i+1)).

```
Bucket 0:   peers at distance [1, 2)          — differ only in bit 0
Bucket 1:   peers at distance [2, 4)          — differ from bit 1
Bucket 2:   peers at distance [4, 8)          — differ from bit 2
...
Bucket 63:  peers at distance [2^63, 2^64)    — differ in the highest bit
```

Each higher bucket covers twice the ID space of the previous one. Since nodes are uniformly distributed, higher buckets have exponentially more candidates. Lower buckets (close neighbors) may have few or no entries.

**Eviction policy**: When a new contact is discovered for a full bucket, Kademlia pings the least-recently-seen entry. If it responds, the new contact is discarded (preferring long-lived nodes). If the existing entry is unresponsive, it is replaced. This bias toward stable nodes is one of Kademlia's key robustness features.

### 2.3 Lookup Algorithm

To find the node responsible for a target key T:

```
function LOOKUP(sourceId, targetKey):
    closestKnown = k closest peers to targetKey from local routing table
    queried = {}

    while closestKnown is improving:
        pick alpha unqueried peers from closestKnown
        for each peer P in parallel:
            response = FIND_NODE(P, targetKey)
            queried.add(P)
            merge response contacts into closestKnown
            keep only k closest to targetKey

    return closestKnown[0]   // closest node to target
```

Parameters:
- **k** = 20: replication/routing breadth
- **alpha** = 3: parallel query factor
- Each iteration queries alpha of the k closest unqueried peers and merges their responses

The lookup converges because each round discovers peers strictly closer to the target. With N nodes and B-bit IDs, this requires O(log N) rounds, each with alpha parallel queries.

### 2.4 Strengths and Weaknesses

**Strengths**:
- Provably correct convergence in O(log N) hops
- Natural redundancy (k entries per bucket)
- Self-organizing: routing tables fill automatically through query traffic
- Symmetric distance simplifies implementation
- Robust to moderate churn via long-lived node preference

**Weaknesses**:
- No awareness of physical network topology or latency
- Static routing: no optimization based on observed traffic patterns
- High hop counts at scale (8+ hops common for 25,000 nodes)
- No priority given to frequently used or reliable routes
- Bucket refresh is periodic, not event-driven -- churn recovery is slow

---

## Chapter 3: The Geographic DHT (G-DHT)

The Geographic DHT is a new protocol developed as part of this research effort. It extends Kademlia with a simple but powerful idea: encode a node's physical location into its identifier, so that XOR distance partially correlates with geographic distance. While previous work (notably Coral and Pastry) considered network locality, the G-DHT is the first to embed geographic coordinates directly into the node ID using a space-filling curve, making latency awareness an intrinsic property of the XOR metric itself.

### 3.1 S2 Geometry and Cell Encoding

The Earth's surface is divided into cells using Google's S2 geometry library. S2 projects the sphere onto the faces of a cube, then applies a Hilbert curve mapping to each face. The Hilbert curve has a critical property: points that are close on the curve tend to be close on the surface, preserving spatial locality in a one-dimensional index.

With 8 bits of S2 prefix, the Earth is divided into 256 cells (each roughly 600 km x 600 km at the equator). Each cell receives a unique integer index (0--255) based on its position on the Hilbert curve.

### 3.2 Geographic Node IDs

A node's identifier is constructed by placing its S2 cell index in the high-order bits:

```
Node ID structure:
┌─────────────────┬──────────────────────────────────┐
│  S2 cell prefix  │  Hash of public key               │
│  (8 bits)        │  (remaining bits)                 │
└─────────────────┴──────────────────────────────────┘
```

In the simulator, this is 8 + 56 = 64 bits. In a production system, the total length is determined by the public key size (e.g., 256 bits for Ed25519), with 8 bits of S2 prefix prepended.

This encoding has a powerful consequence for XOR distance:

- **Same cell**: Two nodes in the same S2 cell share their top 8 bits, so their XOR distance is at most 2^(B-8) - 1. They are "close" in ID space.
- **Adjacent cells**: Nearby cells on the Hilbert curve have similar prefixes, so nearby nodes tend to have moderate XOR distance.
- **Distant cells**: Cells on opposite sides of the Earth have very different prefixes, producing large XOR distances.

XOR distance in the G-DHT thus approximates geographic distance: close nodes have small XOR distance, distant nodes have large XOR distance. This means Kademlia's greedy XOR routing naturally prefers geographically close intermediaries.

### 3.3 Stratified Bootstrap with Random Supplement

The G-DHT's geographic ID prefix creates a non-uniform distribution across XOR buckets: intra-cell buckets (0--55 for geo8) are densely populated while inter-cell buckets (56--63) are sparse but critical for global reachability. Under connection budgets (e.g., 50 WebRTC connections), a naive allocation that prioritizes local peers will starve the inter-cell buckets, causing lookup failures.

The solution is a **stratified allocation** that guarantees global reachability, supplemented with random peers for churn resilience:

**Core allocation (80% of budget)**: Kademlia's proven two-phase stratified fill applied across all 64 XOR buckets:
- Phase 1 (breadth): 1 peer per non-empty bucket, ensuring every XOR distance level has at least one connection.
- Phase 2 (depth): Remaining budget fills highest-b buckets first, maximizing global-reach diversity.

**Random supplement (20% of budget)**: Random peers from across the entire network. These provide diverse backup paths that the structured allocation misses, significantly improving churn resilience.

Without a connection budget (uncapped mode), the G-DHT uses three structured layers:

1. **Inter-cell backbone** (k peers per bucket): Connections to nodes in different geographic cells, covering each geographic-prefix bit. Marked as structural (slower decay).
2. **Intra-cell local** (k peers per bucket): Connections to nearby nodes in the same S2 cell. Low-latency local paths.
3. **Random global** (k peers): Random connections for diversity and redundancy.

### 3.4 Performance Impact

The geographic encoding dramatically reduces latency because routing hops prefer geographically close intermediaries. In benchmarks with 25,000 nodes:

| Metric | K-DHT | G-DHT |
|--------|-------|-------|
| Global lookup hops | 8.36 | 8.30 |
| Global lookup latency | 1,024 ms | 408 ms |
| 5,000 km lookup hops | 8.39 | 8.04 |
| 5,000 km lookup latency | 1,039 ms | 318 ms |
| 500 km lookup latency | 999 ms | 206 ms |
| Lookup success rate | 100% | 100% |
| 5% churn success | 62.4% | 79.2% |

The G-DHT cuts latency by 60% through geographic awareness while maintaining 100% reachability (matching Kademlia). Under churn, the random supplement provides superior resilience (79% vs. Kademlia's 62%), as the diverse backup paths offer escape routes when structured peers die.

---

## Chapter 4: The Neuromorphic DHT

The Neuromorphic DHT replaces Kademlia's static k-bucket routing with a biologically-inspired adaptive system. Every aspect of routing -- connection selection, learning, maintenance, and recovery -- draws from neuroscience principles.

### 4.1 Design Philosophy

The human brain maintains approximately 100 trillion synaptic connections, yet efficiently routes signals through neural pathways that strengthen with use and weaken without it. The brain doesn't pre-compute routes; it learns them through experience. The Neuromorphic DHT applies this same principle to network routing:

- **Synapses** replace k-bucket entries: each connection carries a weight reflecting its proven reliability.
- **Long-term potentiation (LTP)** reinforces successful routes, making them more likely to be chosen again.
- **Synaptic decay** weakens unused connections, freeing capacity for better alternatives.
- **Simulated annealing** provides controlled exploration, discovering new routes while preserving proven ones.
- **Temperature** controls the exploration/exploitation balance, starting aggressive and cooling to stability.

### 4.2 Node Identity

Node IDs follow the same S2-prefix scheme as the G-DHT:

```
Node ID:
┌─────────────┬────────────────────────────────────────┐
│ S2 cell (8b) │ Public key hash (variable length)      │
└─────────────┴────────────────────────────────────────┘
```

The total ID length is determined by the public key size. In the simulator, this is 64 bits (8-bit S2 prefix + 56-bit random). In production, it would be 8-bit S2 prefix + the public key itself. The algorithms operate on arbitrary-length bit strings; only the S2 prefix length is fixed.

**Stratum**: The stratum of a connection is defined as the number of leading zero bits in the XOR of the two node IDs:

```
stratum(A, B) = count_leading_zeros(A XOR B)
```

A stratum of 0 means the IDs differ in the most significant bit (maximally far in ID space). A stratum equal to the ID length minus 1 means the IDs differ only in the last bit (maximally close). The stratum partitions the ID space into logarithmic distance bands, analogous to Kademlia's buckets but used as a continuous property rather than a fixed structure.

### 4.3 The Synaptome

Each node maintains a **synaptome** -- a dynamic collection of weighted connections to other nodes. Unlike k-buckets, which are rigidly structured by distance range and size, the synaptome evolves through experience.

#### 4.3.1 Synapse Properties

```
Synapse:
  peerId      : NodeID    — the connected node
  weight      : float     — reliability score [0.0, 1.0]
  latency     : float     — estimated round-trip time (ms), exponential moving average
  stratum     : int       — XOR distance band (leading zeros of XOR)
  inertia     : epoch     — decay protection until this epoch (set by LTP)
  bootstrap   : bool      — structural connection (slower decay)
  useCount    : int       — times used for routing (for adaptive decay)
```

The **weight** is the most important property. It encodes the system's learned confidence in this connection: 1.0 means highly reliable, 0.0 means untested or unreliable. Weight is increased by successful routing (LTP reinforcement) and decreased over time by adaptive decay. It influences route selection through the activation potential formula.

#### 4.3.2 Two-Tier Architecture

The synaptome is split into two tiers with different management policies:

**Local tier** (capacity: 48 synapses):
The primary routing table. Managed by stratified eviction (Section 4.7) to maintain diversity across strata. This tier provides fine-grained reachability to all regions of the ID space.

**Highway tier** (capacity: 12 synapses):
Long-range, high-value connections discovered through periodic hub scanning. Highway synapses receive special decay protection when recently used, making them resistant to eviction. They provide reliable shortcuts across the network.

When routing, both tiers are consulted. The combined capacity of ~60 connections is realistic for browser-based WebRTC environments where connection limits apply.

### 4.4 Activation Potential (AP) Routing

When node A needs to route a message toward target T, it evaluates each synapse using an **activation potential** score:

```
function computeAP(synapse, sourceId, targetId):
    distSource   = XOR(sourceId, targetId)
    distPeer     = XOR(synapse.peerId, targetId)
    progress     = distSource - distPeer        // XOR progress toward target
    if progress <= 0: return -infinity          // no progress — skip

    AP = (progress / synapse.latency) * (1.0 + WEIGHT_SCALE * synapse.weight)
    return AP
```

Where:
- `progress` measures how much closer the synapse's peer is to the target (in XOR distance)
- `synapse.latency` penalizes high-latency connections (geographic awareness)
- `synapse.weight` gives a mild preference to proven routes
- `WEIGHT_SCALE = 0.40` controls how much weight matters vs. raw distance/latency

The highest-AP synapse is selected as the next hop. This formula naturally balances three objectives: making progress toward the target, preferring low-latency paths, and favoring reliable connections.

### 4.5 Two-Hop Lookahead

Pure greedy routing can get trapped in local minima: the best immediate hop may lead to a dead end. The Neuromorphic DHT mitigates this with two-hop lookahead:

```
function selectNextHop(currentNode, targetId):
    candidates = synapses making positive XOR progress toward targetId
    if candidates is empty: return ITERATIVE_FALLBACK

    // Score each candidate by 1-hop AP
    sort candidates by computeAP(candidate, currentNode.id, targetId) descending
    probeSet = top LOOKAHEAD_ALPHA candidates  // default: 5

    bestSynapse = null
    bestAP2 = -infinity

    for each candidate in probeSet:
        peerNode = lookup(candidate.peerId)
        if not alive(peerNode): continue

        // What is the best onward hop from this candidate?
        onwardCandidates = peerNode.synapses making progress from candidate toward targetId
        if onwardCandidates is empty:
            twoHopDist = XOR(candidate.peerId, targetId)
            secondLatency = 0
        else:
            bestOnward = highest-AP synapse from onwardCandidates
            twoHopDist = XOR(bestOnward.peerId, targetId)
            secondLatency = bestOnward.latency

        totalProgress = XOR(currentNode.id, targetId) - twoHopDist
        totalLatency = candidate.latency + secondLatency
        AP2 = (totalProgress / totalLatency) * (1.0 + WEIGHT_SCALE * candidate.weight)

        if AP2 > bestAP2:
            bestAP2 = AP2
            bestSynapse = candidate

    return bestSynapse
```

The two-hop lookahead considers not just where each candidate can take the message, but what that candidate can do *next*. A slightly worse first hop that leads to a much better second hop will be preferred.

### 4.6 Epsilon-Greedy Exploration

On the very first hop of each lookup, there is an `EXPLORATION_EPSILON = 0.05` (5%) chance of selecting a random synapse instead of the best one. This injects controlled randomness that:

- Discovers alternative routes the AP scoring might overlook
- Prevents premature convergence on suboptimal paths
- Provides training signal for synapses that would otherwise never be tested

After the first hop, routing is purely AP-driven. The exploration is concentrated at the source where its cost is lowest (one suboptimal hop out of ~3 total).

### 4.7 Stratified Eviction

When the synaptome reaches capacity and a new synapse needs to be added, the system uses **stratified eviction** to maintain diversity across distance ranges:

```
function stratifiedAdd(node, newSynapse):
    if node.synaptome.size < MAX_CAPACITY:
        node.addSynapse(newSynapse)
        return true

    // Divide strata into STRATA_GROUPS groups (default: 16)
    // Each group covers 4 strata (e.g., group 0 = strata 0-3, group 1 = strata 4-7)
    counts = count synapses per stratum group

    // Find the most over-represented group
    evictGroup = group with highest count (must exceed STRATUM_FLOOR = 2)
    if no group qualifies: return false

    // Evict the weakest synapse from that group
    weakest = lowest-weight synapse in evictGroup
    node.removeSynapse(weakest)
    node.addSynapse(newSynapse)
    return true
```

This ensures that no distance range dominates the synaptome. Even if the node interacts mostly with nearby peers, it retains connections to distant regions of the ID space, maintaining global reachability.

### 4.8 Learning: Long-Term Potentiation (LTP)

After a successful lookup that completes at or below the running average latency, a **reinforcement wave** propagates backward along the path:

```
function reinforceWave(path, currentEpoch):
    for each (fromNode, synapse) in path (reverse order):
        syn = fromNode.synaptome.get(synapse.peerId)
        if syn exists:
            syn.weight = min(1.0, syn.weight + LTP_INCREMENT)  // +0.2
            syn.inertia = currentEpoch + INERTIA_DURATION      // lock for 20 epochs
```

**LTP increment** (+0.2): Each reinforcement boosts the synapse's weight by 0.2, up to the maximum of 1.0. Five successful uses bring a synapse from its initial weight to maximum reliability.

**Inertia lock** (20 epochs): After reinforcement, the synapse is protected from decay for 20 epochs. This prevents recently-proven routes from being weakened by the background decay process.

**Quality gate**: Only paths at or below the exponential moving average latency trigger reinforcement. This ensures that only genuinely good routes are strengthened, preventing reinforcement of degraded paths.

### 4.9 Learning: Simulated Annealing

Each node has a **temperature** that controls its exploration rate:

```
Initial temperature:    T_INIT = 1.0
Cooling factor:         ANNEAL_COOLING = 0.9997 per routing hop
Minimum temperature:    T_MIN = 0.05
Churn reheat target:    T_REHEAT = 0.5
```

On each routing hop through a node, with probability equal to the node's current temperature, an annealing step is performed:

```
function tryAnneal(node, temperature):
    if random() >= temperature: return     // skip with prob (1 - T)
    if node.synaptome.size <= SYNAPTOME_FLOOR: return

    // Find weakest non-bootstrap synapse
    victim = synapse with lowest weight (excluding bootstrap synapses)
    if victim is null: return

    // Determine target stratum range (under-represented group)
    counts = count synapses per stratum group
    targetGroup = group with lowest count
    targetLo = targetGroup * 4
    targetHi = targetLo + 3

    // Select replacement candidate
    if random() < temperature * GLOBAL_BIAS:    // 50% global bias
        candidate = randomNodeInStratumRange(targetLo, targetHi)
    else:
        candidate = twoHopNeighborInStratumRange(node, targetLo, targetHi)

    if candidate is null or already connected: return

    // Replace
    node.removeSynapse(victim)
    newSyn = createSynapse(candidate, weight=0.1)
    node.addSynapse(newSyn)
```

**Early phase** (T near 1.0): Nearly every routing hop triggers exploration. The node aggressively samples new connections, rapidly diversifying its synaptome. Most replacements start weak (weight 0.1) and must prove themselves through LTP.

**Stable phase** (T near 0.05): Only ~5% of hops trigger exploration. The synaptome is largely stable, with occasional probes maintaining awareness of network changes.

**Churn recovery**: When a dead peer is discovered during routing, the node's temperature is spiked to T_REHEAT (0.5), triggering aggressive exploration to repair the damaged synaptome. Temperature naturally cools back down after repair.

### 4.10 Learning: Adaptive Decay

Every DECAY_INTERVAL (100) lookups, all synapses undergo weight decay:

```
function adaptiveDecay(synapse, currentEpoch):
    if synapse.inertia > currentEpoch: return    // LTP-locked: skip

    useFraction = min(1.0, synapse.useCount / USE_SATURATION)  // USE_SATURATION = 20
    gamma = DECAY_GAMMA_MIN + (DECAY_GAMMA_MAX - DECAY_GAMMA_MIN) * useFraction

    // DECAY_GAMMA_MIN = 0.990  (unused: ~1% loss per interval)
    // DECAY_GAMMA_MAX = 0.9998 (heavy use: ~0.02% loss per interval)

    if synapse.bootstrap:
        gamma = gamma + (DECAY_GAMMA_MAX - gamma) * 0.5    // slower decay for structural

    synapse.weight = synapse.weight * gamma

    if synapse.weight < PRUNE_THRESHOLD:    // 0.05
        // Candidate for removal (subject to stratum floor rules)
```

This creates a natural lifecycle:
- **New synapses** start at weight 0.1--0.5 depending on source
- **Unused synapses** decay at ~1% per interval, reaching prune threshold in ~300 intervals
- **Active synapses** decay at ~0.02% per interval, effectively immortal while in use
- **Reinforced synapses** are locked by inertia, skipping decay entirely

### 4.11 Learning: Hop Caching and Lateral Spread

When a node forwards a message toward a target, it learns a direct shortcut to that target:

```
function hopCache(intermediaryId, targetId):
    intermediary = getNode(intermediaryId)
    target = getNode(targetId)

    // Intermediary learns target directly
    newSyn = createSynapse(target, weight=0.5)
    stratifiedAdd(intermediary, newSyn)

    // Cascade to regional neighbors (same top-4 geographic bits)
    regional = intermediary.synapses in same geographic region
    sort regional by weight descending
    for i in 0..min(LATERAL_K, regional.length):    // LATERAL_K = 6
        neighbor = regional[i].peer
        hopCache(neighbor.id, targetId)    // depth-limited to 1 level
```

This creates a wave of shortcut learning: when a target is reached, every node on the path (and their geographic neighbors) learns a direct connection. Future lookups to the same target resolve in 1--2 hops instead of 3--4.

### 4.12 Learning: Triadic Closure

When a node repeatedly forwards messages between the same origin-destination pair:

```
function recordTransit(intermediary, originId, destinationId):
    key = hash(originId, destinationId)
    count = intermediary.transitCache.increment(key)

    if count >= INTRODUCTION_THRESHOLD:    // default: 3
        intermediary.transitCache.remove(key)
        introduce(originId, destinationId)    // create direct synapse

function introduce(aId, bId):
    nodeA = getNode(aId)
    nodeB = getNode(bId)
    newSyn = createSynapse(nodeB, weight=0.5)
    stratifiedAdd(nodeA, newSyn)
```

After three transits through the same intermediary, the origin and destination are introduced directly. This eliminates the intermediary from future paths, reducing hop count. The name comes from social network theory: if A knows B and B knows C, eventually A and C should know each other.

### 4.13 Iterative Fallback

If greedy AP routing reaches a node where no synapse makes positive XOR progress toward the target, the protocol falls back to Kademlia-style iterative search:

```
function iterativeFallback(stuckNode, targetId, maxRounds):
    closest = stuckNode.synaptome sorted by XOR distance to targetId, take k
    queried = {stuckNode.id}

    for round in 1..maxRounds:
        unqueried = closest.filter(c => c not in queried).take(ALPHA)
        if unqueried is empty: break

        for each peer in unqueried:
            queried.add(peer.id)
            response = peer.closestSynapsesTo(targetId)
            merge response into closest, keep k closest

    return closest[0]    // best known peer
```

This provides a safety net: even if the synaptome has gaps that prevent greedy progress, the iterative search can still find the target by progressively querying closer peers. The combination of greedy AP routing (fast, usually works) with iterative fallback (slower, always works) achieves both efficiency and reliability.

### 4.14 Churn Recovery

When routing discovers a dead peer, two mechanisms activate simultaneously:

**Temperature reheat**:
```
node.temperature = max(node.temperature, T_REHEAT)    // spike to 0.5
```

**Immediate evict-and-replace**:
```
function evictAndReplace(node, deadSynapse):
    stratum = deadSynapse.stratum
    node.removeSynapse(deadSynapse)

    // Find replacement in same stratum range (2-hop neighborhood)
    group = stratum / 4
    targetLo = group * 4
    targetHi = targetLo + 3
    candidate = twoHopNeighborInStratumRange(node, targetLo, targetHi)

    if candidate is null: return null

    // Replacement gets competitive weight (median of existing, not penalty)
    medianWeight = median(node.synaptome.weights)
    newSyn = createSynapse(candidate, weight=medianWeight)
    node.addSynapse(newSyn)

    return newSyn    // may be injected into active lookup if closer to target
```

The combination is powerful: the temperature reheat drives aggressive exploration to repair the broader synaptome, while the immediate replacement ensures the specific dead connection is filled without delay. The replacement receives the median weight (not a penalty weight), so it is immediately competitive for routing.

### 4.15 Bootstrap: Network Initialization

A new node joins the network through a sponsor:

```
function bootstrapJoin(newNodeId, sponsorId):
    newNode = getNode(newNodeId)
    sponsor = getNode(sponsorId)

    // Phase 1: Connect to sponsor and self-lookup
    addSynapse(newNode, sponsor)
    lookup(newNodeId, newNodeId)    // discover XOR-close peers

    // Phase 2: Inter-cell discovery
    // For each geographic prefix bit, look up a target in a different cell
    for bit in 0..GEO_BITS-1:
        targetId = newNodeId XOR (1 << (totalBits - GEO_BITS + bit))
        lookup(newNodeId, targetId)    // discover peers in different cells

    // Admission uses stratum-aware eviction:
    // New peers from under-represented strata can displace entries
    // from over-represented strata, maintaining diversity
```

The inter-cell discovery phase is critical: by looking up IDs that differ in each geographic prefix bit, the new node discovers peers in different geographic cells, building the global reachability needed for cross-region routing.

### 4.16 Diversified Bootstrap

The same lesson that improved the G-DHT's reachability and churn resilience applies to the Neuromorphic DHT's initial synaptome construction. Under connection budgets, reserving a portion of the synaptome for random global peers alongside the stratified core provides measurable benefits:

```
function buildInitialSynaptome(node, maxConnections):
    coreBudget = floor(maxConnections * 0.8)
    randomBudget = maxConnections - coreBudget

    // Core: stratified XOR-bucket allocation (same as G-DHT)
    for each peer in stratifiedAllocation(node.id, coreBudget):
        wireSynapse(node, peer, weight=0.5)

    // Supplement: random global peers
    for each peer in randomSample(allNodes, randomBudget):
        wireSynapse(node, peer, weight=0.3)    // moderate: useful but unproven
```

The random supplement serves two purposes in the Neuromorphic DHT:

1. **Churn resilience**: Diverse connections provide escape routes when structured peers die, complementing the temperature reheat and evict-and-replace mechanisms.

2. **Annealing seed diversity**: Simulated annealing explores by sampling 2-hop neighborhoods. With a more diverse starting synaptome, the annealing process has more varied material to explore from, leading to faster convergence to low-latency routes.

Benchmarks show this reduces global latency from 256 ms to 221 ms (a 14% improvement) by enabling faster synaptome convergence during the warmup period.

### 4.17 Incoming Synapses and Bidirectional Learning

When node A creates a synapse to node B, node B records a lightweight **incoming synapse** entry:

```
IncomingSynapse:
  peerId   : A's ID
  latency  : measured RTT
  stratum  : XOR distance band
  weight   : 0.1 (baseline)
  useCount : 0
```

Incoming synapses participate in AP routing as candidates but are not managed by the full decay/reinforcement lifecycle. When an incoming synapse is used successfully multiple times (useCount >= 2), it is **promoted** to a full synapse in the local tier:

```
function promoteIncoming(node, incomingPeerId):
    incoming = node.incomingSynapses.get(incomingPeerId)
    promoted = createSynapse(peer, weight=0.5)    // mid-weight: already proven
    if stratifiedAdd(node, promoted):
        node.incomingSynapses.remove(incomingPeerId)
```

This enables bidirectional route discovery: even if A never explicitly searches for B, if messages from B consistently route through A, A will eventually add B as a full synapse.

### 4.18 Complete Routing Pseudocode

Putting it all together, here is the complete lookup algorithm:

```
function lookup(sourceId, targetId, maxHops=40):
    current = getNode(sourceId)
    path = []
    hops = 0
    totalTime = 0

    while hops < maxHops:
        // Direct hit?
        if current.id == targetId:
            reinforceWave(path, currentEpoch)
            return {found: true, hops, time: totalTime, path}

        // Direct synapse to target?
        if current.hasSynapse(targetId):
            syn = current.getSynapse(targetId)
            totalTime += syn.latency
            reinforceWave(path, currentEpoch)
            return {found: true, hops: hops+1, time: totalTime, path}

        // Collect progress candidates from synaptome + incoming
        candidates = allSynapsesMakingProgress(current, targetId)

        // Check for dead peers in candidates
        deadSynapses = candidates.filter(c => not alive(c.peer))
        for each dead in deadSynapses:
            current.temperature = max(current.temperature, T_REHEAT)
            replacement = evictAndReplace(current, dead)
            if replacement and XOR(replacement.peerId, targetId) < XOR(current.id, targetId):
                candidates.add(replacement)

        candidates = candidates.filter(c => alive(c.peer))
        if candidates is empty:
            return iterativeFallback(current, targetId)

        // Annealing step
        current.temperature = max(T_MIN, current.temperature * ANNEAL_COOLING)
        if random() < current.temperature:
            tryAnneal(current, current.temperature)

        // Epsilon-greedy exploration (first hop only)
        if hops == 0 and random() < EXPLORATION_EPSILON:
            nextSyn = randomChoice(candidates)
        else:
            nextSyn = selectNextHop(current, targetId)  // 2-hop lookahead AP

        // Record transit for triadic closure
        if hops > 0:
            recordTransit(current, path[hops-1].from, nextSyn.peerId)

        // Hop caching
        hopCache(current.id, targetId)

        // Advance
        path.append({from: current.id, synapse: nextSyn})
        totalTime += nextSyn.latency
        nextSyn.useCount++
        current = getNode(nextSyn.peerId)
        hops++

    return {found: false, hops, time: totalTime}
```

---

## Chapter 5: Axonal Pub/Sub

The Axonal Pub/Sub system provides scalable group communication atop the Neuromorphic DHT. Named after the axonal arbor -- the branching output structure of a neuron that delivers signals from one cell body to many downstream targets -- it constructs broadcast trees that mirror the routing topology itself.

### 5.1 The Problem

In a flat pub/sub model, a publisher sends a message to a relay node, which then individually looks up and delivers to every subscriber. With S subscribers and H average hops per lookup:

- **Total routing work**: S x H hops (all on the relay node)
- **Total messages**: S lookups initiated by the relay
- **Bottleneck**: The relay node performs all the work

With 2,000 subscribers and 3.5 hops per lookup, the relay executes 7,000 routing hops per publish event. This doesn't scale.

### 5.2 The Insight

Consider how the relay routes to its 2,000 subscribers. Many of those routes share a common first hop. If the relay's synaptome has ~48 synapses, then on average each synapse is the first hop toward ~42 subscribers. Some synapses cover hundreds:

```
Relay's synaptome:
  Synapse A → first hop toward 200 subscribers
  Synapse B → first hop toward 150 subscribers
  Synapse C → first hop toward 80 subscribers
  ...remaining synapses → fewer subscribers each
```

In flat delivery, the relay-to-A link is traversed 200 times (once per subscriber routed through A). By making A a **forwarder**, the relay sends once to A, and A handles the 200 subscribers. The relay-to-A link is traversed once instead of 200 times.

```
Before (flat):                    After (axonal tree):

Relay ──lookup──> S1 (via A)      Relay ──direct──> Forwarder A
Relay ──lookup──> S2 (via A)                         ├──lookup──> S1
Relay ──lookup──> S3 (via A)                         ├──lookup──> S2
  ... (200 more via A)                               ├──lookup──> S3
Relay ──lookup──> S201 (via B)                       └── ...
Relay ──lookup──> S202 (via B)    Relay ──direct──> Forwarder B
  ... (150 more via B)                               ├──lookup──> S201
                                                     └── ...
```

Key property: A is already a direct synapse of the relay, so relay-to-A is **1 hop with no DHT lookup** -- just a direct message at the round-trip latency between them.

### 5.3 Tree Construction

The axonal tree is built top-down from the relay root. The process is recursive: any node that exceeds its subscriber capacity delegates to forwarders chosen from its own synaptome.

```
function buildAxonalTree(relay, subscribers, capacity):
    root = TreeNode(relay.id, parent=null, depth=0)
    root.subscribers = all live subscribers
    delegateOverflow(root, capacity)
    return root

function delegateOverflow(treeNode, capacity):
    while treeNode.fanOut > capacity:    // fanOut = subscribers + forwarders
        node = getNode(treeNode.nodeId)

        // Group subscribers by their gateway synapse (first hop)
        gateways = {}    // synapseId → [subscriberIds]
        for each subId in treeNode.subscribers:
            gateway = firstHop(node, subId)    // greedy XOR first hop
            if gateway is valid and not already a forwarder:
                gateways[gateway].append(subId)

        // Find the busiest gateway
        bestGateway = gateway with most subscribers (minimum 2)
        if no valid gateway: break    // can't delegate further

        // Create forwarder
        forwarder = TreeNode(bestGateway, parent=treeNode, depth=treeNode.depth+1)
        treeNode.forwarders.add(forwarder)

        // Move subscribers from parent to forwarder
        for each subId in gateways[bestGateway]:
            treeNode.subscribers.remove(subId)
            forwarder.subscribers.add(subId)

        // Recursive: forwarder may itself need to delegate
        delegateOverflow(forwarder, capacity)

function firstHop(node, targetId):
    // Greedy XOR: which synapse is closest to targetId?
    bestPeer = null
    bestDist = XOR(node.id, targetId)

    for each synapse in node.synaptome:
        if not alive(synapse.peer): continue
        dist = XOR(synapse.peerId, targetId)
        if dist < bestDist:
            bestDist = dist
            bestPeer = synapse.peerId

    return bestPeer    // null if node itself is closest
```

**Visual example** with capacity=4 and 20 subscribers:

```
                    ┌─────────────────────┐
                    │      Relay Root     │
                    │  (4 entries total)  │
                    └──┬──┬──┬──┬────────┘
                       │  │  │  │
          ┌────────────┘  │  │  └─── S19 (direct subscriber)
          │               │  └────── S20 (direct subscriber)
          │               │
     ┌────┴────┐    ┌────┴────┐
     │ Fwd  A  │    │ Fwd  B  │
     │ (depth 1)│    │ (depth 1)│
     └──┬─┬─┬─┘    └──┬─┬─┬──┘
        │ │ │          │ │ │
   ┌────┘ │ └──┐  ┌───┘ │ └──────┐
   │      │    │  │     │        │
  Fwd C  S5  S6  S10  S11   ┌──┴──┐
  (depth 2)               │Fwd D │
   │ │ │                  └─┬─┬──┘
  S1 S2 S3 S4             S14 S15 S16 S17

  Root fans out to: Fwd A, Fwd B, S19, S20  (4 entries)
  Fwd A fans out to: Fwd C, S5, S6, ...     (≤4 entries)
  Each node handles at most 4 entries.
```

### 5.4 Delivery

When a publish event occurs, the tree delivers messages recursively:

```
function deliver(treeNode, pathHops, pathLatency, results):
    node = getNode(treeNode.nodeId)
    if not alive(node): return

    // 1. Send to forwarders: 1 hop each (direct synapse, no DHT lookup)
    for each forwarder in treeNode.forwarders:
        fwdNode = getNode(forwarder.nodeId)
        if not alive(fwdNode):
            fallbackDeliver(treeNode, forwarder, pathHops, pathLatency, results)
            continue

        latency = roundTripLatency(node, fwdNode)
        deliver(forwarder, pathHops + 1, pathLatency + latency, results)

    // 2. Send to leaf subscribers: DHT lookup (but from closer starting point)
    for each subId in treeNode.subscribers:
        subNode = getNode(subId)
        if not alive(subNode): continue

        result = dhtLookup(treeNode.nodeId, subId)
        if result.found:
            results.hops.add(pathHops + result.hops)
            results.times.add(pathLatency + result.time)
```

**Why this works**: The forwarder is a direct synapse of its parent, so the "forwarding hop" costs only the round-trip latency between them -- no DHT lookup overhead. The forwarder then initiates DHT lookups for its own subscribers, but from a closer starting point (it was chosen because it's already on the routing path toward those subscribers). The total per-subscriber hop count is approximately the same as a flat lookup, but the work is distributed across the tree.

### 5.5 Subscription Interception

When a new node subscribes to a topic, the subscribe message routes through the network toward the relay root. At each hop, if the intermediate node is already part of the axonal tree for that topic, it captures the subscription locally:

```
function handleSubscription(node, topicId, subscriberId):
    tree = node.axonalTrees.get(topicId)
    if tree is not null and tree.contains(node.id):
        // This node is part of the tree — capture the subscriber
        treeNode = tree.getNode(node.id)
        treeNode.subscribers.add(subscriberId)
        // Trigger rebalance if over capacity
        if treeNode.fanOut > capacity:
            delegateOverflow(treeNode, capacity)
    else:
        // Not part of tree — forward toward relay root via normal routing
        route(node, topicId, subscribeMessage)
```

This means the tree grows organically: new subscribers attach to the nearest tree node on their routing path, not necessarily to the root. This distributes the subscription load and keeps new subscribers close to their delivery point.

### 5.6 Tree Maintenance

**Subscriber TTL**: Each subscriber entry has a last-active timestamp. Subscribers that are not renewed within TTL ticks (default: 10) are pruned. This handles graceful departure without explicit unsubscribe messages.

**Dead forwarder healing**: If a forwarder dies (detected during delivery), its subscribers and child forwarders are moved to its parent:

```
function healDeadForwarder(branch):
    parent = branch.parent

    // Move subscribers up to parent
    for each subId in branch.subscribers:
        parent.subscribers.add(subId)

    // Move child forwarders up to parent
    for each child in branch.forwarders:
        child.parent = parent
        parent.forwarders.add(child)

    parent.forwarders.remove(branch)
    // Mark tree dirty for rebalance on next tick
```

**Tree rebuild**: When the subscriber set changes (additions, removals, or forwarder death), the tree is marked dirty and rebuilt from scratch on the next publish cycle. Rebuilding is inexpensive: it involves one first-hop calculation per subscriber per tree level.

---

## Chapter 6: Performance Characteristics

All benchmarks use 25,000 nodes uniformly distributed across the globe, with 500 lookups per measurement cell. The Neuromorphic DHT receives 4 warmup sessions (5,000 training lookups) before measurement. Pub/sub tests use 2,000 subscribers per group.

Results are presented under three initialization conditions:
- **Web-limited** (50 connections per node): Simulates browser-based WebRTC environments where each node can maintain at most ~50 simultaneous peer connections.
- **Uncapped**: No connection limit. Each protocol builds its optimal routing table. Represents server-side deployments.
- **Bootstrap Init**: Organic join via sponsor nodes (web-limited). Tests how well each protocol performs when nodes join one-by-one rather than receiving pre-computed routing tables.

### 6.1 Point-to-Point Routing (Web-Limited, 50 connections)

| Metric | K-DHT | G-DHT | Neuromorphic |
|--------|-------|-------|--------------|
| Global hops (mean) | 8.36 | 8.30 | 3.54 |
| Global latency (mean) | 1,024 ms | 408 ms | 221 ms |
| 5,000 km hops (mean) | 8.39 | 8.04 | 3.13 |
| 5,000 km latency (mean) | 1,039 ms | 318 ms | 134 ms |
| 500 km latency (mean) | 999 ms | 206 ms | 66 ms |
| NA to Asia latency | 1,195 ms | 315 ms | 238 ms |
| Success rate | 100% | 100% | 100% |

Under web-realistic connection limits, the Neuromorphic DHT achieves **58% fewer hops** than Kademlia and **78% lower latency**. The G-DHT provides a 60% latency improvement over Kademlia while maintaining 100% success.

```
Latency Distribution (Global Lookups, Web-Limited):

K-DHT:         ██████████████████████████████████████████ 1,024 ms
G-DHT:         ████████████████░░░░░░░░░░░░░░░░░░░░░░░░░   408 ms
Neuromorphic:  █████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░   221 ms
               0       200     400     600     800    1000
```

### 6.2 Point-to-Point Routing (Uncapped Connections)

Without connection limits, all protocols build richer routing tables, reducing hop counts and latency:

| Metric | K-DHT | G-DHT | Neuromorphic |
|--------|-------|-------|--------------|
| Global hops (mean) | 6.17 | 6.77 | 2.79 |
| Global latency (mean) | 738 ms | 371 ms | 194 ms |
| 5,000 km latency (mean) | 733 ms | 268 ms | 112 ms |
| 500 km latency (mean) | 745 ms | 146 ms | 45 ms |
| NA to Asia latency | 536 ms | 397 ms | 241 ms |
| Success rate | 100% | 100% | 100% |

The Neuromorphic DHT achieves **74% lower latency** than Kademlia and **48% lower** than the G-DHT. At short range (500 km), the advantage is dramatic: 45 ms vs. 745 ms -- a **94% reduction** over Kademlia.

```
Latency Distribution (Global Lookups, Uncapped):

K-DHT:         ██████████████████████████████████████████  738 ms
G-DHT:         ████████████████████░░░░░░░░░░░░░░░░░░░░░  371 ms
Neuromorphic:  ██████████░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░  194 ms
               0       200     400     600     800
```

### 6.3 Point-to-Point Routing (Bootstrap Init)

Bootstrap Init tests organic join -- nodes enter one-by-one via a sponsor, building routing tables through iterative discovery rather than pre-computation. This is the most realistic test of production behavior.

| Metric | K-DHT | G-DHT | Neuromorphic |
|--------|-------|-------|--------------|
| Global hops (mean) | 6.07 | 6.95 | 4.29 |
| Global latency (mean) | 720 ms | 364 ms | 253 ms |
| 5,000 km latency (mean) | 717 ms | 278 ms | 158 ms |
| 500 km latency (mean) | 717 ms | 192 ms | 78 ms |
| Success rate | 97.0% | 97.0% | **100%** |

A critical result: **the Neuromorphic DHT achieves 100% success under organic join** while both K-DHT and G-DHT drop to 97%. The learning mechanisms (annealing, LTP, hop caching) compensate for imperfect initial routing tables -- the synaptome self-repairs during the warmup period. This demonstrates that the adaptive approach is not just faster but fundamentally more robust to bootstrap imperfections.

### 6.4 Pub/Sub Broadcast

| Metric | K-DHT (flat) | G-DHT (flat) | Neuromorphic (axonal) |
|--------|-------------|-------------|----------------------|
| Relay hops | 10.40 | 7.20 | 3.40 |
| Relay latency | 1,195 ms | 315 ms | 238 ms |
| Broadcast hops (mean) | 8.36 | 8.48 | 3.81 |
| Broadcast latency (mean) | 1,039 ms | 388 ms | 291 ms |
| Max fan-out per node | 1,999 | 1,999 | 46 |
| Tree depth | 0 | 0 | 5 |
| Avg subscribers/node | 1,999 | 1,999 | 11.2 |

The axonal tree reduces max fan-out from 1,999 to 46 -- a **43x reduction** in per-node work -- while achieving the lowest broadcast hop count and relay latency.

```
Fan-out per Relay Node:

K-DHT (flat):      ████████████████████████████████████ 1,999
G-DHT (flat):      ████████████████████████████████████ 1,999
Neuromorphic:      █░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░    46
                   0         500       1000      1500     2000
```

### 6.5 Churn Resilience

| Metric | K-DHT | G-DHT | Neuromorphic |
|--------|-------|-------|--------------|
| 5% churn hops (web-limited) | 9.67 | 10.04 | 4.55 |
| 5% churn latency (web-limited) | 1,227 ms | 477 ms | 257 ms |
| 5% churn success (web-limited) | 62.4% | 79.2% | 74.4% |
| 5% churn success (uncapped) | 100% | 100% | 75.2% |
| 5% churn success (bootstrap) | 89.8% | 92.8% | 74.8% |

The Neuromorphic DHT maintains the lowest latency under churn (257 ms vs. 1,227 ms for K-DHT). Its churn success rate (~75%) is consistent across all three initialization conditions.

A critical finding emerges from the uncapped benchmark: **K-DHT and G-DHT both achieve 100% churn success without connection limits**, confirming that their ~60--80% web-limited churn rate is a connection budget problem, not an algorithmic one. In contrast, the **Neuromorphic DHT's churn rate remains at ~75% even without connection limits**, proving that the weakness lies in the axonal tree's structural dependency -- forwarder death disrupts entire subtrees regardless of how well-connected the underlying synaptome is.

Under Bootstrap Init, churn resilience improves for K-DHT (90%) and G-DHT (93%) because organic join produces more redundant routing tables. The Neuromorphic DHT's churn rate remains at 75%, further confirming that the axonal tree structure, not the routing layer, is the limiting factor.

---

## Chapter 7: Analysis and Potential Issues

### 7.1 Forwarder Loss Under Churn

**The issue**: In the axonal tree, if a forwarder dies during a publish cycle, all subscribers in its subtree are temporarily unreachable via the tree path. The parent must fall back to direct DHT lookups for the entire subtree, which can spike its fan-out far above the capacity limit.

**Severity**: At 5% churn per measurement period, the success rate drops from 100% (no churn) to ~75%. This rate is consistent across both Omniscient and Bootstrap Init, suggesting that the tree structure itself -- not the bootstrap quality -- is the limiting factor. In a 20% churn environment, multiple forwarders could die simultaneously, cascading failures upward through the tree.

**Mitigations**:
- **Current**: Dead forwarders are healed by moving their subtree to the parent; the tree rebuilds on the next tick.
- **Possible**: Redundant forwarders (each delegation assigns a backup); proactive forwarder health checks before each publish cycle; dynamically increasing capacity under high churn to produce shallower trees.

### 7.2 Tree Rebuild Cost at Scale

**The issue**: The current implementation rebuilds the entire tree from scratch when the subscriber set changes. For 2,000 subscribers this is negligible, but for 50,000+ subscribers, the O(S x F) first-hop calculations per tree level become measurable.

**Mitigations**:
- **Current**: Rebuild is skipped when the subscriber set is unchanged.
- **Possible**: Incremental updates via subscription interception -- new subscribers are routed down the existing tree to the nearest node, avoiding a full rebuild.

### 7.3 Gateway Concentration

**The issue**: If the relay's synaptome is poorly distributed (many subscribers in the same ID-space region), one gateway may cover a disproportionate number of subscribers. The recursive delegation handles this, but the resulting tree may be deep and narrow rather than broad and shallow.

**Mitigations**:
- **Current**: Recursive delegation naturally distributes the load.
- **Possible**: When a single gateway covers >50% of remaining subscribers, introduce a secondary splitting criterion (e.g., geographic cell prefix) to force broader distribution.

### 7.4 Synaptome-Tree Coupling

**The issue**: The axonal tree's structure depends on the synaptome state at build time. If annealing replaces a synapse that happens to be a forwarder, the tree becomes structurally invalid without knowing it. The TTL-based rebuild eventually catches this, but there is a window of stale tree structure.

**Mitigations**:
- **Current**: Trees are rebuilt periodically (every time subscribers change or TTL triggers).
- **Possible**: When a synapse that is also a forwarder is evicted by annealing or decay, immediately mark the tree dirty.

### 7.5 Learning Warmup Period

**The issue**: The Neuromorphic DHT requires a warmup period (4 sessions, ~5,000 lookups) before reaching optimal routing performance. During this period, the synaptome is still being trained and hop counts are higher. A newly joined node will not immediately benefit from the adaptive routing.

**Mitigating factors**: Benchmarks show that even under Bootstrap Init (organic join, no pre-computation), the Neuromorphic DHT achieves 100% lookup success -- the only protocol to do so (K-DHT and G-DHT both drop to 97%). The learning mechanisms compensate for imperfect bootstrap tables during warmup.

**Possible further improvements**: Pre-trained synaptome snapshots shared between nodes; accelerated learning through synthetic warmup lookups during join; the diversified bootstrap (Section 4.16) reduces convergence time by providing annealing with more varied seed connections.

### 7.6 Byzantine Resistance

**The issue**: A malicious node could claim a false geographic position (S2 cell prefix) to position itself strategically in the ID space. It could also manipulate its synaptome reports during iterative fallback to poison other nodes' routing tables.

**Mitigations**:
- **Not currently addressed**: The system assumes honest nodes.
- **Possible**: Proof-of-location verification; cryptographic ID binding; reputation systems based on observed routing reliability; requiring multiple independent paths for routing table updates.

### 7.7 Memory and Bandwidth Overhead

**The issue**: Each node maintains ~60 synapses with full metadata (weight, latency, stratum, inertia, useCount). The learning mechanisms (annealing, decay, hop caching) add computational overhead per routing hop. The axonal tree adds per-topic state at forwarder nodes.

**Assessment**: For most applications, this overhead is modest. A synaptome of 60 entries occupies <5 KB. Annealing and decay operations are O(synaptome size) and occur infrequently (annealing probabilistically per hop; decay every 100 lookups). The axonal tree adds ~100 bytes per subscriber per topic at each forwarder. For thousands of subscribers across dozens of topics, this is manageable on modern hardware.

---

## References

### Foundational DHT Papers

1. Stoica, I., Morris, R., Karger, D., Kaashoek, M. F., & Balakrishnan, H. (2001). "Chord: A Scalable Peer-to-peer Lookup Service for Internet Applications." *ACM SIGCOMM Computer Communication Review*, 31(4), 149--160.

2. Maymounkov, P., & Mazieres, D. (2002). "Kademlia: A Peer-to-peer Information System Based on the XOR Metric." In *International Workshop on Peer-to-Peer Systems* (IPTPS), pp. 53--65. Springer.

3. Rowstron, A., & Druschel, P. (2001). "Pastry: Scalable, Decentralized Object Location, and Routing for Large-Scale Peer-to-Peer Systems." In *Middleware 2001*, pp. 329--350. Springer.

4. Ratnasamy, S., Francis, P., Handley, M., Karp, R., & Shenker, S. (2001). "A Scalable Content-Addressable Network." *ACM SIGCOMM Computer Communication Review*, 31(4), 161--172.

5. Zhao, B. Y., Kubiatowicz, J., & Joseph, A. D. (2001). "Tapestry: An Infrastructure for Fault-tolerant Wide-area Location and Routing." Technical Report UCB/CSD-01-1141, UC Berkeley.

### Security, Fault Tolerance, and Extensions

6. Baumgart, I., & Mies, S. (2007). "S/Kademlia: A Practicable Approach Towards Secure Key-Based Routing." In *2007 International Conference on Parallel and Distributed Systems* (ICPADS), pp. 1--8. IEEE.

7. Freedman, M. J., Freudenthal, E., & Mazieres, D. (2004). "Democratizing Content Publication with Coral." In *NSDI '04: 1st USENIX Symposium on Networked Systems Design and Implementation*, pp. 239--252.

8. Lesniewski-Laas, C., & Kaashoek, M. F. (2010). "Whanau: A Sybil-proof Distributed Hash Table." In *NSDI '10: 7th USENIX Symposium on Networked Systems Design and Implementation*. Available at: https://pdos.csail.mit.edu/papers/whanau-nsdi10.pdf

9. Naor, M., & Wieder, U. (2003). "A Simple Fault Tolerant Distributed Hash Table." In *2nd International Workshop on Peer-to-Peer Systems* (IPTPS). Available at: https://www.wisdom.weizmann.ac.il/~naor/PAPERS/iptps.pdf

### Applications

10. Loewenstern, A., & Norberg, A. (2008). "DHT Protocol." BitTorrent Enhancement Proposal 5 (BEP 5). Available at: https://www.bittorrent.org/beps/bep_0005.html

11. Wood, G. (2014). "Ethereum: A Secure Decentralised Generalised Transaction Ledger." Ethereum Yellow Paper (continuously updated). Available at: https://ethereum.github.io/yellowpaper/paper.pdf

12. Benet, J. (2014). "IPFS -- Content Addressed, Versioned, P2P File System." arXiv preprint arXiv:1407.3561. Available at: https://arxiv.org/abs/1407.3561

### Publish/Subscribe

13. Castro, M., Druschel, P., Kermarrec, A.-M., & Rowstron, A. I. T. (2002). "SCRIBE: A Large-Scale and Decentralized Application-Level Multicast Infrastructure." *IEEE Journal on Selected Areas in Communications* (JSAC), 20(8), 1489--1499.

### Geographic, Proximity-Aware, and Recent DHT Work

14. Gummadi, K., Gummadi, R., Gribble, S., Ratnasamy, S., Shenker, S., & Stoica, I. (2003). "The Impact of DHT Routing Geometry on Resilience and Proximity." *ACM SIGCOMM*, pp. 381--394. Available at: https://www.cs.yale.edu/homes/ramki/sigcomm03.pdf

15. Wong, B., Slivkins, A., & Sirer, E. G. (2005). "Meridian: A Lightweight Network Location Service without Virtual Coordinates." *ACM SIGCOMM*. Available at: https://www.cs.cornell.edu/people/egs/papers/meridian-sigcomm05.pdf

16. Google S2 Geometry Library. "S2 Cells." Available at: https://s2geometry.io/devguide/s2cell_hierarchy

17. Hilbert, D. (1891). "Ueber die stetige Abbildung einer Line auf ein Flachenstuck." *Mathematische Annalen*, 38(3), 459--460.

18. Sokoto, S., Krol, M., Stankovic, V., & Riviere, E. (2023). "Next-Generation Distributed Hash Tables." *CoNEXT Student Workshop*. Available at: https://dl.acm.org/doi/10.1145/3630202.3630234

19. "LEAD: A Distributed Learned Hash Table." arXiv preprint arXiv:2508.14239, 2024. Available at: https://arxiv.org/abs/2508.14239

### Neuroscience Analogues

20. Hebb, D. O. (1949). *The Organization of Behavior: A Neuropsychological Theory*. Wiley.

21. Bliss, T. V. P., & Lomo, T. (1973). "Long-lasting Potentiation of Synaptic Transmission in the Dentate Area of the Anaesthetized Rabbit Following Stimulation of the Perforant Path." *The Journal of Physiology*, 232(2), 331--356.

22. Kirkpatrick, S., Gelatt, C. D., & Vecchi, M. P. (1983). "Optimization by Simulated Annealing." *Science*, 220(4598), 671--680.

23. Srinivasa, N., Stepp, N. D., & Cruz-Albrecht, J. (2016). "Multiclass Classification by Adaptive Network of Dendritic Neurons with Binary Synapses Using Structural Plasticity." *Frontiers in Neuroscience*, 10, 113. Available at: https://www.frontiersin.org/articles/10.3389/fnins.2016.00113

### Neuromorphic and Self-Organizing Networks

24. Wang, Y. et al. (2008). "Self-Organizing Peer-to-Peer Social Networks." *Computational Intelligence*, Wiley. Available at: https://www.researchgate.net/publication/220541891_Self-Organizing_Peer-to-Peer_Social_Networks

25. McDaid, L. et al. (2012). "Adaptive Routing Strategies for Large Scale Spiking Neural Network Hardware Implementations." SpringerLink. Available at: https://link.springer.com/chapter/10.1007/978-3-642-21735-7_10

26. "Self-organizing topology control in distributed spatial networks: a structural optimization framework." *Cluster Computing*, 2025. Available at: https://link.springer.com/article/10.1007/s10586-025-05286-0

---

## Appendix: Production System Specification

This appendix describes a complete production system built on the Neuromorphic DHT with Axonal Pub/Sub. It specifies every component needed to go from a protocol description to a working library and application. An AI or developer should be able to use this section as a blueprint for implementation.

### A.1 System Overview

The production system consists of three layers:

```
┌──────────────────────────────────────────────────────────┐
│                   Application Layer                       │
│  (pub/sub topics, key-value storage, message routing)    │
├──────────────────────────────────────────────────────────┤
│                  Neuromorphic DHT Layer                   │
│  (synaptome, AP routing, learning, axonal pub/sub)       │
├──────────────────────────────────────────────────────────┤
│                    Transport Layer                        │
│  (WebRTC data channels / TCP / QUIC / WebSocket relay)   │
└──────────────────────────────────────────────────────────┘
```

### A.2 Node Identity and Cryptography

**Key generation**:
1. Generate an Ed25519 (or similar) key pair: (publicKey, privateKey)
2. Determine the node's geographic cell: `cellId = S2CellId(latitude, longitude, level=4)` producing an 8-bit cell index (0--255)
3. Construct the node ID: `nodeId = cellId || publicKey` (8-bit prefix concatenated with the public key bytes)

**Identity verification**: Any peer can verify a node's identity by checking that the public key portion of the ID matches the key used to sign messages. The S2 prefix is self-declared and cannot be cryptographically verified without a proof-of-location system (see Section 7.6).

**Message signing**: All control messages (FIND_NODE, SUBSCRIBE, PUBLISH, PING) are signed with the sender's private key. The receiver verifies the signature against the sender's nodeId.

### A.3 Transport Layer

The Neuromorphic DHT is transport-agnostic. Each synapse represents a persistent or on-demand connection to a peer. Recommended transports:

**WebRTC Data Channels** (browser-to-browser):
- DTLS-encrypted, NAT-traversing
- Connection limit: ~50--60 simultaneous peers (matching synaptome capacity)
- Signaling required for initial connection establishment
- Best for: browser-based applications, decentralized web apps

**QUIC / TCP** (server-to-server):
- Lower overhead, higher connection limits
- Best for: infrastructure nodes, high-throughput applications

**WebSocket Relay** (fallback):
- For nodes behind restrictive NATs that cannot establish direct connections
- A relay server forwards messages between peers
- Higher latency but universal reachability

### A.4 Message Protocol

All messages share a common envelope:

```
Message:
  version    : uint8          — protocol version
  type       : uint8          — message type (see below)
  senderId   : bytes          — full node ID (S2 prefix + public key)
  signature  : bytes          — Ed25519 signature of the payload
  timestamp  : uint64         — millisecond Unix timestamp
  nonce      : uint64         — prevents replay attacks
  payload    : bytes          — type-specific content
```

**Message types**:

| Type | Name | Payload | Response |
|------|------|---------|----------|
| 0x01 | PING | (empty) | PONG |
| 0x02 | PONG | (empty) | (none) |
| 0x10 | FIND_NODE | targetId: bytes | FIND_NODE_RESPONSE |
| 0x11 | FIND_NODE_RESPONSE | contacts: [{id, address, latency}] | (none) |
| 0x20 | ROUTE | targetId: bytes, payload: bytes, ttl: uint8 | ROUTE_ACK |
| 0x21 | ROUTE_ACK | (empty) | (none) |
| 0x30 | SUBSCRIBE | topicId: bytes, subscriberId: bytes, ttl: uint16 | SUB_ACK |
| 0x31 | SUB_ACK | (empty) | (none) |
| 0x32 | UNSUBSCRIBE | topicId: bytes, subscriberId: bytes | (none) |
| 0x40 | PUBLISH | topicId: bytes, data: bytes | (none) |
| 0x41 | FORWARD | topicId: bytes, data: bytes, subscribers: [bytes] | (none) |
| 0x50 | SYNAPSE_OFFER | offeredPeerId: bytes, offeredAddress: string | (none) |

### A.5 Connection Lifecycle

**Establishing a connection** (WebRTC):

```
function connectToPeer(peerId, peerAddress):
    // 1. Signal via existing peers or bootstrap server
    offer = createWebRTCOffer()
    send offer to peerAddress (via signaling channel)

    // 2. Receive answer
    answer = await receiveAnswer()
    applyAnswer(answer)

    // 3. Wait for data channel to open
    channel = await dataChannelOpen()

    // 4. Exchange PING/PONG to measure latency
    sendPing()
    pong = await receivePong(timeout=5000ms)
    measuredLatency = pong.timestamp - ping.timestamp

    // 5. Create synapse entry
    synapse = Synapse(peerId, weight=0.1, latency=measuredLatency, ...)
    node.addSynapse(synapse)
```

**Connection pooling**: Nodes maintain persistent connections for all synapses in their synaptome. When a synapse is evicted (decay, annealing), the underlying connection is closed. When a new synapse is created, a new connection is established.

**Lazy connections**: For the highway tier or rarely-used synapses, connections can be established on-demand and cached with an idle timeout.

### A.6 Bootstrap Service

A production network requires at least one **bootstrap server** -- a well-known endpoint that new nodes contact to enter the network.

```
BootstrapServer:
    knownNodes: Map<nodeId, {address, lastSeen}>

    function handleJoinRequest(newNodeId, newNodeAddress):
        // Return a diverse set of existing nodes
        sponsors = selectDiverseSponsors(newNodeId, count=8)
        return sponsors

    function selectDiverseSponsors(newNodeId, count):
        // One from same S2 cell (local neighbor)
        // One from each of 7 different S2 cells (global diversity)
        // Prefer recently-seen, long-lived nodes
```

**Bootstrap process for a new node**:

```
function joinNetwork(myKeyPair, myLatitude, myLongitude, bootstrapUrl):
    // 1. Generate node ID
    cellId = S2CellId(myLatitude, myLongitude, level=4)
    myId = cellId || myKeyPair.publicKey

    // 2. Contact bootstrap server
    sponsors = httpGet(bootstrapUrl + "/join", {nodeId: myId, address: myAddress})

    // 3. Connect to sponsor and perform self-lookup
    sponsor = connectToPeer(sponsors[0].id, sponsors[0].address)
    selfLookupResults = iterativeLookup(myId, myId, via=sponsor)

    // 4. Add discovered peers to synaptome
    for each peer in selfLookupResults:
        connectAndAddSynapse(peer)

    // 5. Inter-cell discovery (flip each geographic prefix bit)
    for bit in 0..7:
        targetId = myId XOR (1 << (idLength - 8 + bit))
        results = iterativeLookup(myId, targetId)
        for each peer in results:
            connectAndAddSynapse(peer)  // stratum-aware admission

    // 6. Begin background learning
    startPeriodicMaintenance()
```

### A.7 Background Maintenance

Each node runs periodic maintenance tasks:

```
Maintenance Schedule:
  Every 100 lookups:    Run adaptive decay on all synapses
  Every 500 lookups:    Refresh highway tier (scan for new long-range hubs)
  Every 1000 lookups:   Rebuild annealing candidate buffer
  Every 60 seconds:     Ping all synapses to update latency estimates
  Every 300 seconds:    Prune dead synapses (not responding to pings)
```

### A.8 Pub/Sub Integration

**Publishing a message**:

```
function publish(topicId, data):
    // 1. Find the relay node for this topic
    relayId = hash(topicId)    // topic hash determines relay location in ID space
    relayResult = lookup(myId, relayId)

    // 2. Send PUBLISH message to relay
    send PUBLISH(topicId, data) to relayResult.nodeId
```

**Subscribing to a topic**:

```
function subscribe(topicId, ttlSeconds):
    // 1. Find the relay node
    relayId = hash(topicId)
    relayResult = lookup(myId, relayId)

    // 2. Send SUBSCRIBE message (may be intercepted by tree node)
    send SUBSCRIBE(topicId, myId, ttlSeconds) toward relayResult.nodeId

    // 3. Renew subscription periodically (before TTL expires)
    scheduleRenewal(topicId, ttlSeconds * 0.8)
```

**Relay handling a PUBLISH**:

```
function handlePublish(topicId, data):
    tree = axonalTrees.get(topicId)
    if tree is null: return    // no subscribers

    // Deliver through axonal tree
    for each forwarder in tree.root.forwarders:
        send FORWARD(topicId, data, forwarder.subtreeSubscribers) to forwarder.nodeId

    for each subscriberId in tree.root.subscribers:
        send ROUTE(subscriberId, PUBLISH(topicId, data))
```

### A.9 Data Storage (Key-Value Layer)

For applications requiring key-value storage (not just routing and pub/sub):

```
function store(key, value):
    // 1. Find the k closest nodes to key
    closest = lookup(myId, key)

    // 2. Store on k closest (replication)
    for each node in closest.take(k):
        send STORE(key, value) to node.id

function retrieve(key):
    // 1. Find the k closest nodes to key
    closest = lookup(myId, key)

    // 2. Query closest for the value
    for each node in closest.take(k):
        response = send FIND_VALUE(key) to node.id
        if response.hasValue: return response.value

    return null
```

### A.10 Implementation Checklist

A complete implementation requires these components:

**Core DHT Library**:
- [ ] Node ID generation (S2 prefix + public key)
- [ ] Synapse data structure (weight, latency, stratum, inertia, useCount)
- [ ] Synaptome management (two-tier: local + highway)
- [ ] Stratified eviction (stratum groups, floor rules)
- [ ] AP routing with two-hop lookahead
- [ ] Epsilon-greedy exploration (5% first-hop randomization)
- [ ] Iterative fallback (Kademlia-style FIND_NODE loop)
- [ ] LTP reinforcement wave (weight boost + inertia lock)
- [ ] Simulated annealing (temperature cooling, global/local candidates)
- [ ] Adaptive decay (usage-based gamma, bootstrap protection)
- [ ] Hop caching with lateral spread
- [ ] Triadic closure (transit counting, introduction)
- [ ] Churn recovery (temperature reheat + evict-and-replace)
- [ ] Bootstrap join (self-lookup + inter-cell discovery)
- [ ] Diversified bootstrap (80% stratified + 20% random under connection budget)
- [ ] Incoming synapse tracking and promotion

**Axonal Pub/Sub Extension**:
- [ ] Tree node structure (subscribers, forwarders, parent, depth)
- [ ] First-hop gateway analysis
- [ ] Recursive overflow delegation
- [ ] Tree delivery (forwarder = 1 hop direct; subscriber = DHT lookup)
- [ ] Subscription interception at tree nodes
- [ ] Dead forwarder healing (move subtree to parent)
- [ ] TTL-based subscriber pruning
- [ ] Tree rebuild on subscriber set change

**Transport and Networking**:
- [ ] WebRTC data channel management (or TCP/QUIC)
- [ ] Connection pooling aligned with synaptome
- [ ] Message serialization and signing
- [ ] Ping/pong latency measurement
- [ ] Bootstrap server (HTTP endpoint for initial join)

**Background Services**:
- [ ] Periodic adaptive decay
- [ ] Highway tier refresh
- [ ] Annealing buffer rebuild
- [ ] Synapse liveness monitoring (ping)
- [ ] Subscription TTL renewal

### A.11 Configuration Parameters

All tunable parameters with recommended defaults:

| Parameter | Default | Description |
|-----------|---------|-------------|
| GEO_BITS | 8 | S2 cell prefix bits (256 cells) |
| MAX_SYNAPTOME_SIZE | 48 | Local tier capacity |
| HIGHWAY_SLOTS | 12 | Highway tier capacity |
| SYNAPTOME_FLOOR | 48 | Never shrink local below this |
| WEIGHT_SCALE | 0.40 | Weight influence in AP formula |
| EXPLORATION_EPSILON | 0.05 | First-hop random exploration rate |
| LOOKAHEAD_ALPHA | 5 | Two-hop lookahead probe count |
| MAX_GREEDY_HOPS | 40 | Safety limit on routing depth |
| T_INIT | 1.0 | Initial annealing temperature |
| T_MIN | 0.05 | Minimum annealing temperature |
| ANNEAL_COOLING | 0.9997 | Per-hop temperature decay |
| T_REHEAT | 0.5 | Churn recovery temperature |
| GLOBAL_BIAS | 0.5 | Probability of global vs local annealing candidate |
| LTP_INCREMENT | 0.2 | Weight boost per reinforcement |
| INERTIA_DURATION | 20 | Epochs of decay protection after LTP |
| DECAY_INTERVAL | 100 | Lookups between decay cycles |
| DECAY_GAMMA_MIN | 0.990 | Decay rate for unused synapses |
| DECAY_GAMMA_MAX | 0.9998 | Decay rate for heavily-used synapses |
| USE_SATURATION | 20 | Use count to reach max protection |
| PRUNE_THRESHOLD | 0.05 | Weight below which synapse may be pruned |
| STRATA_GROUPS | 16 | Number of stratum groups for eviction |
| STRATUM_FLOOR | 2 | Minimum synapses per stratum group |
| LATERAL_K | 6 | Hop cache cascade breadth (depth 1) |
| LATERAL_K2 | 2 | Hop cache cascade breadth (depth 2) |
| INTRODUCTION_THRESHOLD | 3 | Transits before triadic closure |
| BOOTSTRAP_CORE_RATIO | 0.80 | Fraction of budget for stratified allocation |
| BOOTSTRAP_RANDOM_WEIGHT | 0.3 | Initial weight for random supplement peers |
| AXONAL_CAPACITY | 32 | Max entries per tree node |
| AXONAL_TTL | 10 | Ticks before pruning inactive subscriber |

### A.12 Example Application: Decentralized Chat

A minimal application demonstrating all system components:

```
// 1. Initialize node
node = NeuromorphicDHT.create({
    keyPair: generateEd25519KeyPair(),
    location: {lat: 51.5074, lng: -0.1278},    // London
    transport: WebRTCTransport,
    bootstrapUrl: "https://bootstrap.example.com"
})

await node.join()

// 2. Create a chat room (pub/sub topic)
roomId = hash("chat:general")

// 3. Subscribe to receive messages
node.subscribe(roomId, {
    ttl: 3600,    // 1 hour subscription
    onMessage: (data) => {
        console.log(`${data.sender}: ${data.text}`)
    }
})

// 4. Publish a message
node.publish(roomId, {
    sender: node.id.toString(),
    text: "Hello, decentralized world!",
    timestamp: Date.now()
})

// 5. Store user profile (key-value)
await node.store(hash("profile:" + node.id), {
    displayName: "Alice",
    publicKey: node.keyPair.publicKey
})

// 6. Retrieve another user's profile
profile = await node.retrieve(hash("profile:" + otherNodeId))
```

This example exercises all three layers: transport (WebRTC), DHT (routing, key-value storage), and pub/sub (axonal tree broadcast). The node joins via bootstrap, subscribes to a topic (building an axonal tree path), publishes messages (delivered through the tree), and stores/retrieves data (replicated across k closest nodes).

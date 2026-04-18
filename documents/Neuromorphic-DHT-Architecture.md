# Neuromorphic DHT Architecture

**A Biologically-Inspired Distributed Hash Table with Axonal Publish/Subscribe**

*Version 0.49.00*

---

## Introduction

Distributed hash tables (DHTs) are the backbone of decentralized systems -- they allow a network of independent computers to collectively store and retrieve data without any central server. Since their introduction in the early 2000s, DHTs have powered file sharing, content delivery, blockchain networks, and decentralized communication. Yet the core routing mechanisms have changed remarkably little since Kademlia's[^2] publication in 2002.

All three protocols compared in this work -- Kademlia, the Geographic DHT, and the Neuromorphic DHT -- are *recursive* DHTs: a lookup is forwarded hop-by-hop through intermediate nodes, each choosing the next best peer, until the target is reached. (This assumption is now standard practice and rarely stated explicitly, but it frames how learning, churn recovery, and pub/sub mechanisms operate -- each hop is both a routing event and a learning opportunity.)

### A Restricted, Browser-Realistic Model

This work studies DHTs under the constraints imposed by a web-browser deployment. Each node is assumed to maintain at most **50 concurrent peer connections** (a realistic ceiling for WebRTC data channels in modern browsers). Node IDs are 64 bits, the network is uniformly distributed across land on Earth, and round-trip times (RTTs) are computed from great-circle distance plus a fixed per-hop cost. The benchmarks that follow use 25,000 such nodes. These constraints matter because they eliminate an entire category of "just add more connections" optimization: every protocol must deliver its performance within the same tight per-node budget. Server-class and mixed-device deployments with higher connection limits would see absolute latencies drop across the board -- Chapter 7 includes an uncapped-connection comparison that confirms the relative picture holds, and in several cases widens, when every protocol is given unlimited capacity.

All reported numbers are averages over 500 lookups per measurement cell, themselves aggregated over multiple benchmark runs. Individual runs show small natural variation (typically ±5% on latency) due to the randomised bootstrap, probabilistic annealing, and epsilon-greedy exploration. The means are stable; the protocol orderings reported in this document do not flip on repeated runs.

### Two New Protocols

This document describes two new approaches developed as part of this research effort:

1. A **Geographic DHT (G-DHT)** that extends Kademlia by encoding a node's physical location into its identifier using S2 geometry[^16]. This simple modification halves lookup latency by making XOR routing geographically aware, while a stratified allocation strategy maintains Kademlia's 100% reachability guarantee.

2. A **Neuromorphic DHT** that replaces static routing tables entirely with adaptive, biologically-inspired mechanisms. Drawing from neuroscience[^20], each node maintains a dynamic set of weighted connections (a *synaptome*) that strengthens on successful routes and weakens through disuse -- mirroring how biological neurons form and prune synaptic connections[^23]. The system learns the network's topology through experience rather than relying on rigid algorithmic structure.

Built atop the Neuromorphic routing layer is the **Axonal Pub/Sub** system -- a scalable publish/subscribe mechanism where broadcast trees emerge from the routing topology itself. Named after the axonal arbor (the branching output structure of a neuron that delivers signals to many downstream targets), this tree delegates delivery to intermediate nodes that are already on the natural routing path, achieving near-zero overhead for broadcast distribution. We have not attempted to build competitive pub/sub overlays for Kademlia or G-DHT; their baseline behaviour in our pub/sub tests is the naive flat-delivery case (the relay looks up every subscriber individually). At scale, only the Axonal tree produces workable pub/sub performance -- so the pub/sub comparison in this document should be read as "Neuromorphic + Axonal tree vs. no serious pub/sub on the other protocols," not as a head-to-head evaluation of pub/sub designs.

### Why Local Performance Matters Most

Real-world DHT workloads are dominated by *local* traffic. Users interact most with content and peers near them geographically -- friends in the same city, cached content from nearby content delivery network (CDN) nodes, regional collaborators, same-organization peers. A messaging app's neighbor-to-neighbor chat, a content-sharing service's regional replication, a gaming system's lobby discovery -- these account for the vast majority of lookups. Global and cross-continent routing matter, but they are the minority case. Any DHT evaluation that weights global routing equally with regional routing misrepresents real deployment performance.

Kademlia treats all distances identically: a lookup to a peer 500 km away traverses the same number of hops, routing through the same XOR-space detours, as a lookup to the opposite side of the globe. The XOR metric is geographically blind. A message destined for a node in the next city may bounce through Tokyo, São Paulo, and Helsinki before arriving. Both the Geographic DHT and Neuromorphic DHT address this fundamental inefficiency -- and the performance gap they open is dramatic specifically for local and concentrated-workload traffic.

### Performance at a Glance (25,000 nodes, web-limited)

| Workload | Kademlia | G-DHT-b | NX-10 | NX-10 vs Kademlia |
|----------|----------|---------|-------|------|
| **500 km lookup** | 378 ms | 130 ms | **66 ms** | **5.7× faster** |
| **1,000 km lookup** | 379 ms | 134 ms | **75 ms** | **5.1× faster** |
| **2,000 km lookup** | 368 ms | 153 ms | **89 ms** | **4.1× faster** |
| **5,000 km lookup** | 368 ms | 195 ms | **144 ms** | **2.6× faster** |
| Concentrated source (10% pool) | 376 ms | 290 ms | **251 ms** | 1.5× faster |
| Concentrated dest (10% pool) | 234 ms | 108 ms | **40 ms** | **5.9× faster** |
| Concentrated pair (10% → 10%) | 242 ms | 108 ms | **32 ms** | **7.6× faster** |
| Global random | 375 ms | 284 ms | **255 ms** | 1.5× faster |
| NA → Asia | 364 ms | 292 ms | **249 ms** | 1.5× faster |
| **Under 10% churn** | 419 ms / 100% | 322 ms / 100% | **262 ms / 100%** | 1.6× faster |
| **Under 25% churn** | 489 ms / 100% | 334 ms / **99.4%** | **259 ms / 100%** | **1.89× faster** |

Both G-DHT-b and NX-10 deliver multi-fold improvements on the workloads that dominate real-world traffic -- local lookups and concentrated-destination patterns -- with NX-10 approaching an order of magnitude in the best cases. NX-10's 500 km latency of 66 ms is 5.7× faster than Kademlia's 378 ms. For repeated lookups to a popular 10% set of destinations, NX-10 achieves 40 ms -- nearly direct delivery -- compared to Kademlia's 234 ms. And for lookups between members of two popular 10% pools (modeling community-to-community traffic), NX-10 reaches 32 ms, **7.6× faster than Kademlia**.

### Churn Invariance

"Resilience" is the wrong word for what NX-10 exhibits under churn. The data shows something stronger: **NX-10's performance does not meaningfully depend on whether churn is happening.**

| Protocol | At rest | 10% churn | 25% churn | Δ at 25% |
|----------|---------|-----------|-----------|---------|
| Kademlia | 375 ms / 100% | 419 ms / 100% | 489 ms / 100% | **+30%** latency penalty |
| G-DHT-b | 284 ms / 100% | 322 ms / 100% | 334 ms / **99.4%** | +18% penalty, **reliability breaks** |
| **NX-10** | 255 ms / 100% | 262 ms / 100% | **259 ms / 100%** | **+1.6% latency penalty** |

At 25% churn per round across 5 rounds, approximately **76% of the original network has been replaced**. Kademlia degrades by 30% in latency but completes every lookup. G-DHT-b reaches its reliability ceiling and begins dropping lookups. NX-10 routes in 259 ms -- statistically indistinguishable from its 255 ms at-rest baseline. The network does not slow down, lose reliability, or show signs of stress. It simply continues operating.

A notable pattern emerges in the at-rest / 10% / 25% progression: Kademlia's latency climbs from 375 ms to 489 ms, while NX-10's stays flat at 255–262 ms. The gap between them widens from 1.47× at rest to 1.89× at 25% churn. Most engineered systems converge under degradation (all components slow together); NX-10 diverges, because its adaptive mechanisms extract increasing value from each lookup as the topology shifts, while static systems lose performance exactly in proportion to the damage inflicted.

This behaviour arises from three mechanisms operating continuously rather than on refresh cycles:

1. **Dead-synapse eviction**: stale connections are discovered and replaced during the lookup that encounters them, not during periodic maintenance
2. **Iterative fallback**: when greedy routing stalls, the node exhaustively searches unvisited peers rather than giving up
3. **Temperature reheat**: encountering a dead peer spikes the exploration rate, aggressively repairing the damaged synaptome before the next lookup arrives

### How It Compares

| Property | Kademlia | G-DHT | Neuromorphic DHT |
|----------|----------|-------|------------------|
| Routing table | Fixed k-buckets | Fixed k-buckets | Adaptive synaptome, ~60 weighted connections |
| Route selection | XOR distance only | XOR distance (geo-aware) | Activation potential: distance + latency + reliability |
| Learning | None | None | Continuous: reinforcement, annealing, decay |
| Latency awareness | None | Via geographic IDs | Integral to route scoring |
| Geographic awareness | None | S2 cell prefix in node ID | S2 cell prefix in node ID |
| Pub/sub | Not built-in | Not built-in | Axonal tree mirrors routing topology |
| Churn recovery | Lazy (dead entries skipped) | Lazy (dead entries skipped) | Immediate: dead-synapse eviction + 2-hop replacement |
| 10% churn latency penalty | +12% | +13% | **+3%** |
| 25% churn latency penalty | +30% | +18% (reliability breaks) | **+1.6%** |
| 25% churn success | 100% | 99.4% | **100%** |

This document is structured so that a technical reader can reconstruct a working implementation from its descriptions. Each chapter builds on the previous, culminating in a complete implementation plan.

---

## Chapter 1: A Brief History of Distributed Hash Tables

### 1.1 The Problem

In the late 1990s, the explosive growth of peer-to-peer file sharing (Napster, Gnutella) exposed a fundamental tension: centralized directories were efficient but fragile and legally vulnerable; fully decentralized flooding was resilient but unscalable. The question became: *can a network of peers collectively implement a key-value lookup service with the efficiency of a centralized index and the resilience of a fully decentralized system?*

### 1.2 The First Generation (2001--2002)

Four research groups independently answered this question within months of each other, each proposing a structured peer-to-peer overlay network -- what would come to be called distributed hash tables:

**Chord**[^1] (Stoica et al., MIT, 2001) arranged nodes on a circular identifier space. Each node maintained a "finger table" with O(log N) pointers to nodes at exponentially increasing distances around the ring. Lookups traversed O(log N) hops by following the finger closest to the target without overshooting. Chord's elegance was its simplicity: the ring structure made correctness proofs tractable and join/leave operations well-defined.

**CAN** (Content Addressable Network)[^4] (Ratnasamy et al., Berkeley, 2001) used a d-dimensional Cartesian coordinate space, partitioning it into zones owned by individual nodes. Routing followed a greedy path through adjacent zones toward the target coordinates. CAN offered O(N^(1/d)) hop counts at the cost of O(d) routing table entries, and its multi-dimensional structure provided natural load balancing.

**Pastry**[^3] (Rowstron & Druschel, Microsoft/Rice, 2001) combined prefix-based routing with a leaf set of numerically close neighbors and a neighborhood set of physically close nodes. This hybrid approach explicitly considered network locality -- a property that Chord and CAN initially ignored. Pastry resolved lookups in O(log N) hops while naturally preferring low-latency paths.

**Tapestry**[^5] (Zhao et al., Berkeley, 2001) used a similar prefix-based approach with suffix routing, emphasizing fault tolerance through multiple redundant paths. Tapestry's contribution was demonstrating that structured overlays could provide strong availability guarantees even under significant churn.

**Kademlia**[^2] (Maymounkov & Mazieres, NYU, 2002) introduced XOR distance as the routing metric, which had the elegant property of being symmetric (distance from A to B equals distance from B to A) and supporting a single routing algorithm for both lookup and node joining. Kademlia's k-buckets -- fixed-size lists of known peers at each distance range -- provided natural redundancy and resistance to certain attacks. Its combination of simplicity, symmetry, and robustness made it the most widely adopted DHT in practice.

### 1.3 Evolution and Applications

**BitTorrent**[^10] (2005+) adopted a Kademlia variant (Mainline DHT) for trackerless peer discovery, eventually becoming the largest deployed DHT with millions of simultaneous nodes. The Mainline DHT demonstrated that Kademlia could operate at massive scale, though with high lookup latency (often 10+ seconds due to timeout chains).

**Ethereum**[^11] (2015+) uses a modified Kademlia (devp2p) for peer discovery in its blockchain network. The combination of Kademlia's reliable node discovery with application-level gossip protocols has proven effective for blockchain consensus.

**IPFS**[^12] (2015+) built its content-addressable storage layer on a Kademlia DHT (libp2p), using it to map content hashes to the peers storing that content. IPFS extended Kademlia with content routing records and provider announcements.

**Coral**[^7] (Freedman et al., 2004) introduced "distributed sloppy hash tables" (DSHTs) that organized nodes into clusters by round-trip time, preferring nearby nodes for lookups. This foreshadowed the geographic awareness that would become central to later DHT designs.

**S/Kademlia**[^6] (Baumgart & Mies, 2007) addressed Kademlia's security weaknesses with cryptographic node ID generation, sibling broadcasts for data replication, and disjoint lookup paths to resist Eclipse attacks.

### 1.4 The Persistent Limitations

Despite two decades of refinement, DHTs have retained several fundamental limitations:

1. **No latency awareness**: Traditional DHTs route purely by ID-space distance. A lookup may bounce between continents when a geographically closer path exists. Gummadi et al.[^14] documented the routing-geometry penalty empirically; Meridian[^15] attempted to add latency awareness via virtual coordinates but did not integrate it with the XOR metric itself.

2. **No learning**: Routing tables are populated mechanically (bucket fills on contact) and never adapt to traffic patterns. A frequently-used route receives no preferential treatment. Recent work on learned hash tables[^19] and next-generation DHTs[^18] highlights this gap, though most proposals remain research prototypes.

3. **High hop counts**: O(log N) hops is the theoretical bound, and in practice Kademlia networks often require 8--12 hops per lookup.

4. **No built-in pub/sub**: Group communication requires application-level overlays built atop the DHT (e.g., SCRIBE[^13]), adding complexity and additional hops.

5. **Slow churn recovery**: When nodes depart, routing tables are repaired lazily through periodic refresh, leaving routing gaps that can persist for minutes.

The Neuromorphic DHT addresses all five of these limitations, drawing on prior work in self-organizing peer-to-peer networks[^24] and adaptive routing strategies for spiking neural networks<sup>25, 26</sup>.

---

## Chapter 2: The Kademlia DHT -- A Foundation

This chapter describes how Kademlia works, as it serves as the baseline against which the Neuromorphic DHT is compared.

### 2.1 Identifier Space

Every node and every data key occupies a position in a flat identifier space of B bits (typically 160 bits using the Secure Hash Algorithm SHA-1, though our simulator uses 64 bits). Node IDs are generated from the hash of the node's public key or IP address.

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

The Geographic DHT is a new protocol developed as part of this research effort. It extends Kademlia with a simple but powerful idea: encode a node's physical location into its identifier, so that XOR distance partially correlates with geographic distance. While previous work (notably Coral[^7] and Pastry[^3]) considered network locality, the G-DHT is the first to embed geographic coordinates directly into the node ID using a space-filling curve, making latency awareness an intrinsic property of the XOR metric itself.

### 3.1 S2 Geometry and Cell Encoding

The Earth's surface is divided into cells using Google's S2 geometry library[^16]. S2 projects the sphere onto the faces of a cube, then applies a Hilbert curve[^17] mapping to each face. The Hilbert curve has a critical property: points that are close on the curve tend to be close on the surface, preserving spatial locality in a one-dimensional index.

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

- **Synapses** replace k-bucket entries: each connection carries a weight reflecting its proven reliability (Hebbian learning[^20]).
- **Long-term potentiation (LTP)**[^21] reinforces successful routes, making them more likely to be chosen again.
- **Synaptic decay** weakens unused connections, freeing capacity for better alternatives.
- **Simulated annealing**[^22] provides controlled exploration, discovering new routes while preserving proven ones.
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

Drawing directly from Bliss and Lomo's 1973 discovery[^21] of long-lasting synaptic strengthening in the hippocampus, we implement a computational analogue: after a successful lookup that completes at or below the running average latency, a **reinforcement wave** propagates backward along the path:

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

Drawing on Kirkpatrick, Gelatt, and Vecchi's classical formulation[^22], each node has a **temperature** that controls its exploration rate:

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

## Chapter 5: NX-10 Protocol Specification — Rule-by-Rule Breakdown

NX-10 is the **State of the Art** neuromorphic protocol, achieving 100% lookup success across all test conditions including 25% churn at 25,000 nodes with realistic (non-omniscient) bootstrap. This chapter details each rule in NX-10, why it exists, and what it contributes to performance. Rules are presented in the order they were added through the NX evolution (NX-1W through NX-10), with empirical evidence from ablation testing.

### 5.1 Architectural Foundation

NX-10 inherits from NX-6, which builds on NX-5, NX-4, NX-3, and the original neuromorphic architecture. The full inheritance chain:

```
NX-10 → NX-6 → NX-5 → NX-4 → NX-3 → NeuromorphicDHTBase → DHT
```

NX-10 adds one feature (routing-topology pub/sub tree) to NX-6's complete routing engine. The routing engine itself accumulated through NX-3 to NX-6.

### 5.2 Rule 1: Synaptome-Based Routing with AP Scoring (NX-3 base)

**What**: Each node maintains a **synaptome** — a flat collection of up to 48 weighted connections (synapses) plus 12 highway connections, replacing Kademlia's rigid k-bucket structure. Route selection uses the **Activation Potential** formula:

```
AP = (XOR_progress / latency) * (1 + WEIGHT_SCALE * weight)
```

**Why**: Kademlia's `findClosest` ranks peers solely by XOR distance. AP routing integrates three signals: XOR progress toward the target, physical latency (geographic awareness), and learned reliability (weight). This produces faster paths because low-latency nearby hops are preferred when they make comparable XOR progress.

**Contribution**: Reduces global latency from Kademlia's ~364ms to ~250ms (31% reduction) at 25,000 nodes under web-limit. The latency component is the dominant factor — without it, the neuromorphic DHT would route through distant nodes as often as nearby ones.

### 5.3 Rule 2: Two-Hop Lookahead (NX-3 base)

**What**: Instead of greedily selecting the single best next hop, evaluate the top 5 candidates (LOOKAHEAD_ALPHA=5) by simulating one additional hop from each. Select the candidate whose two-hop trajectory makes the most progress per unit latency.

**Why**: Pure greedy routing can select a hop that looks good immediately but leads to a dead end. Two-hop lookahead catches these cases: a slightly worse first hop that leads to a much better second hop will be preferred.

**Contribution**: Reduces average hop count by approximately 0.3 hops and prevents routing dead-ends that would otherwise require iterative fallback. Most impactful in the web-limited regime where each node has only 50 connections and local minima are more common.

### 5.4 Rule 3: Incoming Synapses and Bidirectional Routing (NX-3 base)

**What**: When node A creates a synapse to node B, B records a lightweight **incoming synapse** entry pointing back to A. During routing, both outgoing synapses and incoming synapses are considered as next-hop candidates.

**Why**: Under connection budgets, synapse creation is asymmetric — A adds B but B's synaptome may be full. Without incoming synapses, B cannot route back to A even though a real network connection exists. The incoming synapse index doubles the effective routing candidates at each node.

**Contribution**: Critical for narrow-bottleneck routing. In the Slice World test (East/West hemisphere partition with a single Hawaii bridge node), incoming synapses raise success from 52% (Kademlia, no reverse index) to 99.4% (NX-3). The bridge node's incoming synapses expose connections to both hemispheres that its outgoing synaptome alone would miss.

### 5.5 Rule 4: Iterative Fallback (NX-4)

**What**: When greedy AP routing reaches a node where no synapse makes positive XOR progress toward the target, instead of failing, scan all synapses (outgoing + incoming) for the closest unvisited peer to the target, regardless of whether it makes XOR progress. Mark visited nodes to avoid cycles.

**Why**: Greedy XOR routing assumes the synaptome always contains a peer closer to the target. Under connection budgets with 50 connections across 25,000 nodes, this assumption fails — some strata have no coverage. Iterative fallback provides a safety net by allowing non-progress hops that eventually reach a node with forward-progress options.

**Contribution**: The **watershed feature** of the NX line. Raises Slice World success from 99.4% to 100%. Raises churn success from ~80% to 100%. Every NX protocol below NX-4 fails under stress; every protocol NX-4 and above succeeds. Without iterative fallback, all other learning and repair mechanisms are insufficient.

### 5.6 Rule 5: Incoming Synapse Promotion[^20] (NX-5)

**What**: When an incoming synapse is selected as a routing hop multiple times (useCount >= 2), promote it to a full outgoing synapse with weight 0.5. This is Hebbian learning[^20]: connections that carry traffic get cemented.

**Why**: Incoming synapses have a fixed baseline weight of 0.1, making them weak routing candidates. If an incoming synapse proves useful by being selected repeatedly, promoting it to a full synapse with competitive weight (0.5) ensures it participates fully in AP scoring and receives LTP reinforcement.

**Contribution**: Enables organic network learning — the routing table evolves based on actual traffic patterns rather than remaining static after bootstrap. Particularly important for nodes that serve as transit points: they accumulate promoted incoming synapses that reflect real routing demand.

### 5.7 Rule 6: Long-Term Potentiation (LTP) Reinforcement[^21] (NX-3 base)

**What**: After a successful lookup that completes at or below the running average latency, a reinforcement wave propagates backward along the path: each synapse gains +0.2 weight (capped at 1.0) and receives an inertia lock preventing decay for 20 epochs.

**Why**: Without reinforcement, all synapses would decay toward zero and eventually be pruned. LTP creates a positive feedback loop: fast routes get stronger weights, making them more likely to be selected by AP scoring, which generates more reinforcement. The quality gate (at or below the exponential moving average (EMA) latency) ensures only genuinely fast routes are strengthened.

**Contribution**: Drives latency optimization over time. During warmup, LTP reinforcement converges the synaptome from random bootstrap connections to traffic-optimized ones, reducing global latency by approximately 15-20ms over 2,000 training lookups.

### 5.8 Rule 7: Simulated Annealing[^22] (NX-3 base)

**What**: Each node has a temperature (initially 1.0, cooling by factor 0.9997 per routing hop, minimum 0.05). On each hop, with probability equal to the temperature, replace the weakest non-locked synapse with a random peer from the 2-hop neighborhood in the same stratum range.

**Why**: Without exploration, the synaptome converges to a local optimum and cannot adapt to network changes. Annealing provides controlled exploration: early in a node's life (high temperature), it aggressively samples new connections; as it stabilizes (low temperature), it makes only occasional probes. The 2-hop neighborhood constraint ensures replacements are reachable, and stratum targeting maintains diversity.

**Contribution**: Enables continuous adaptation to traffic patterns and network topology changes. Particularly important after churn, where the annealing mechanism discovers replacement connections in strata left empty by dead-synapse eviction.

### 5.9 Rule 8: Adaptive Decay (NX-6 base)

**What**: Every 100 lookups, all synapses undergo weight decay. The decay rate is usage-adaptive: heavily-used synapses decay at 0.9998 per interval (effectively immortal), while unused synapses decay at 0.990 (reaching prune threshold in ~300 intervals). Bootstrap synapses receive extra protection. Synapses with active LTP inertia locks skip decay entirely.

**Why**: Without decay, the synaptome would accumulate stale connections that consume capacity but provide no routing value. Adaptive decay ensures unused connections fade while active ones persist, creating a natural lifecycle that keeps the synaptome fresh.

**Contribution**: Works in concert with annealing and LTP to maintain synaptome quality. Decay creates slots for annealing to fill with new explorations, while LTP-locked synapses resist decay during their proven-useful period.

### 5.10 Rule 9: Hop Caching with Lateral Spread (NX-6 base)

**What**: At each intermediate hop during a lookup, introduce the target node to the current node's synaptome (via stratified eviction if full). Additionally, cascade this introduction to up to 6 geographic neighbors at depth 1, and 2 neighbors at depth 2.

**Why**: Without hop caching, every lookup to the same target must discover the path from scratch. Hop caching creates direct shortcuts: after one lookup reaches target T, every node along the path knows T directly. Lateral spread amplifies this by teaching T to nearby nodes, so future lookups from the same geographic region can reach T faster.

**Contribution**: The primary mechanism for learning geographic shortcuts. NS-series ablation testing showed hop caching alone reduces global latency by 16ms (NS-1 298ms to NS-2 282ms). With eviction-enabled caching (NS-5), 10%dest latency drops from 244ms to 148ms as popular destinations get cached across the routing mesh.

### 5.11 Rule 10: Triadic Closure (NX-6 base)

**What**: When node C repeatedly forwards traffic from origin A toward next-hop D (threshold: 3 transits), C introduces A to D directly via stratified eviction.

**Why**: If A regularly routes through C to reach D, a direct A-to-D connection would eliminate C as an intermediary. Triadic closure discovers these shortcuts through observation rather than explicit search. The threshold prevents premature introductions from one-off routing patterns.

**Contribution**: Most effective when combined with eviction (NS-6 testing: NS-5 282ms to NS-6 275ms global latency). Without eviction, triadic introductions can't displace existing synapses and are lost (NS-4 testing showed triadic alone was counterproductive).

### 5.12 Rule 11: Dead-Synapse Eviction and Replacement (NX-6)

**What**: When routing discovers a dead peer (alive check fails), immediately delete the dead synapse and search the 2-hop neighborhood for a replacement in the same stratum range. The replacement receives the median weight of existing synapses (not penalized). If the replacement makes forward progress toward the current lookup target, inject it into the active candidate set.

**Why**: Kademlia handles dead peers by skipping them during `getAll()` — the slot remains occupied until periodic refresh. This leaves gaps in routing coverage. Immediate eviction and replacement ensures the synaptome is always fully populated with live peers, maintaining routing quality even under heavy churn.

**Contribution**: Critical for churn resilience. Combined with iterative fallback (Rule 5), dead-synapse eviction enables 100% lookup success at 25% churn with 25,000 nodes under realistic bootstrap. The replacement injection into active lookups means even the lookup that discovered the dead peer can route through the replacement immediately.

### 5.13 Rule 12: Churn-Triggered Temperature Reheat (NX-6)

**What**: When a dead peer is discovered during routing (in either normal candidate collection or iterative fallback scan), spike the discovering node's annealing temperature to T_REHEAT (0.5).

**Why**: After churn damages a node's synaptome, the node needs to explore aggressively to find replacements for the dead connections. Under normal cooling, a mature node's temperature would be near T_MIN (0.05), meaning only 5% of hops trigger annealing. Reheating to 0.5 means 50% of hops trigger exploration, driving rapid repair.

**Contribution**: Accelerates post-churn recovery. The temperature naturally cools back down via ANNEAL_COOLING after the repair phase, so the increased exploration is temporary and targeted.

### 5.14 Rule 13: Two-Tier Synaptome (NX-6 base)

**What**: The synaptome is split into a local tier (48 synapses) and a highway tier (12 synapses). The highway tier holds high-diversity hub nodes discovered through periodic scanning of the 2-hop neighborhood. Highway synapses receive special decay protection when recently used and are consulted during routing alongside local synapses.

**Why**: The local tier optimizes for traffic-pattern routing (learned through LTP, annealing, hop caching). The highway tier provides stable long-range connections to high-diversity hubs — nodes that cover many different strata, acting as routing crossroads. The two tiers serve complementary purposes: local for fast common routes, highway for reliable global reach.

**Contribution**: Provides 60 total connections (vs 50 for a single tier), giving NX-10 more routing redundancy. The highway hubs are particularly valuable for cross-region routing where the local tier may lack direct coverage.

### 5.15 Rule 14: Epsilon-Greedy Exploration (NX-3 base)

**What**: On the very first hop of each lookup, with 5% probability, select a random synapse instead of the best AP-scored one.

**Why**: Without first-hop randomization, the same initial synapse would be chosen for similar targets, creating hot spots and preventing discovery of alternative paths. The 5% exploration rate provides training signal for under-used synapses without significantly impacting routing performance (one suboptimal hop out of ~3 total).

**Contribution**: Prevents premature convergence and ensures diverse synapses receive routing traffic for LTP evaluation.

### 5.16 Rule 15: Realistic Bootstrap Join (NX-6 base)

**What**: New nodes join through a sponsor via iterative self-lookup (Phase 1: discover XOR-close peers) followed by inter-cell discovery (Phase 2: lookups with flipped geographic prefix bits to find peers in different S2 cells). Stratum-aware eviction during join displaces over-represented strata to maintain diversity.

**Why**: In a real network, new nodes don't have access to a sorted list of all peers — they know only their sponsor. The iterative join discovers the network through progressive exploration. Phase 2's geographic diversity is critical: without it, the new node would only know peers in its own S2 cell and nearby strata, unable to route globally.

**Contribution**: Enables 100% churn success under realistic conditions. Previous testing showed that omniscient bootstrap (access to the full sorted node list) artificially inflated churn resilience by 25+ percentage points. Realistic bootstrap via iterative join is honest and still achieves 100% with NX-10's full rule set.

### 5.17 Rule 16: Routing-Topology Pub/Sub Tree[^23] (NX-10)

**What**: When broadcasting to subscribers, build a forwarding tree that mirrors the routing topology. For each subscriber, determine which direct synapse would be the first hop toward it. Delegate groups of subscribers to those synapses as forwarders. Recursive: forwarders apply the same delegation when they exceed capacity (default: 32 entries per node).

**Why**: Unlike prior DHT-based pub/sub schemes (e.g., SCRIBE[^13]) that build overlay trees independent of the routing layer, flat pub/sub requires the relay to individually look up every subscriber — O(S x H) routing work concentrated on one node. The routing-topology tree distributes this work: forwarder hops cost only 1 direct hop (no DHT lookup), and each forwarder handles its own subset of subscribers from a closer starting point.

**Contribution**: Reduces max per-node fan-out from 1,999 to ~46 (43x reduction) with 2,000 subscribers. Broadcast latency remains comparable to flat delivery because forwarder hops are direct (1 hop, no lookup overhead). Tree depth emerges naturally from the routing topology (typically 4-5 levels for 2,000 subscribers).

### 5.18 Configuration Summary

NX-10 uses 44 configuration parameters inherited from the NX-6 rule chain. The critical parameters and their defaults:

| Parameter | Value | Rule |
|-----------|-------|------|
| MAX_SYNAPTOME_SIZE | 48 | Two-tier synaptome |
| HIGHWAY_SLOTS | 12 | Two-tier synaptome |
| WEIGHT_SCALE | 0.40 | AP routing |
| LOOKAHEAD_ALPHA | 5 | Two-hop lookahead |
| EXPLORATION_EPSILON | 0.05 | Epsilon-greedy |
| MAX_GREEDY_HOPS | 40 | Safety limit |
| T_INIT / T_MIN | 1.0 / 0.05 | Annealing |
| ANNEAL_COOLING | 0.9997 | Annealing |
| T_REHEAT | 0.5 | Churn reheat |
| DECAY_GAMMA_MIN / MAX | 0.990 / 0.9998 | Adaptive decay |
| PRUNE_THRESHOLD | 0.05 | Decay pruning |
| INERTIA_DURATION | 20 | LTP lock |
| LATERAL_K / K2 | 6 / 2 | Hop cache spread |
| INTRODUCTION_THRESHOLD | 3 | Triadic closure |
| AXONAL_CAPACITY | 32 | Pub/sub tree |

### 5.19 Ablation Summary: Which Rules Matter Most

NS-series testing systematically added features to a minimal core, revealing each rule's marginal contribution:

| Protocol | Features | Global ms | Churn % | Key finding |
|----------|----------|-----------|---------|-------------|
| NS-1 | AP + fallback + evict + LTP + annealing + promotion | 298 | 96.8% | Minimal viable |
| NS-2 | + hop caching | 282 | 97.4% | −16ms latency |
| NS-4 | + triadic (no eviction) | 302 | 97.0% | Worse without eviction |
| NS-5 | + eviction on add | 282 | **100%** | Churn fixed, 10%dest 148ms |
| NS-6 | + triadic with eviction | **275** | **100%** | −7ms, best NS |
| NX-10 | Full rule set (44 params) | **251** | **100%** | SOTA at 25K nodes |

The **essential features** in order of impact:
1. **Iterative fallback** (NX-4): 52% → 100% on Slice World, ~80% → 100% on churn
2. **Incoming synapses**: 52% → 99.4% on Slice World
3. **Eviction on add** (NS-5): 96.8% → 100% churn
4. **Hop caching**: −16ms global latency
5. **Triadic closure + eviction**: −7ms global latency
6. **Two-tier highway + lateral spread + adaptive decay**: −24ms (remaining gap to NX-10)

---

## Chapter 6: Axonal Pub/Sub

The Axonal Pub/Sub system provides scalable group communication atop the Neuromorphic DHT. Named after the axonal arbor[^23] -- the branching output structure of a neuron that delivers signals from one cell body to many downstream targets -- it constructs broadcast trees that mirror the routing topology itself. Unlike earlier DHT-based pub/sub schemes such as SCRIBE[^13], which builds an overlay tree independent of the routing layer, the Axonal Pub/Sub tree emerges from the routing topology itself, achieving near-zero overhead for broadcast distribution.

### 6.1 The Problem

In a flat pub/sub model, a publisher sends a message to a relay node, which then individually looks up and delivers to every subscriber. With S subscribers and H average hops per lookup:

- **Total routing work**: S x H hops (all on the relay node)
- **Total messages**: S lookups initiated by the relay
- **Bottleneck**: The relay node performs all the work

With 2,000 subscribers and 3.5 hops per lookup, the relay executes 7,000 routing hops per publish event. This doesn't scale.

### 6.2 The Insight

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

### 6.3 Tree Construction

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

### 6.4 Delivery

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

### 6.5 Subscription Interception

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

### 6.6 Tree Maintenance

**Subscriber time-to-live (TTL)**: Each subscriber entry has a last-active timestamp. Subscribers that are not renewed within TTL ticks (default: 10) are pruned. This handles graceful departure without explicit unsubscribe messages.

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

## Chapter 7: Performance Characteristics

All benchmarks use 25,000 nodes uniformly distributed across the globe, with 500 lookups per measurement cell. The Neuromorphic DHT (NX-10) receives 4 warmup sessions (5,000 training lookups) before measurement. Pub/sub tests use 2,000 subscribers per group. Node removal is honest -- no protocol reads a dead node's internal state; neighbors discover failures when they attempt to route through stale connections.

**On variance:** all numbers reported in this document are means over 500 lookups per cell, themselves aggregated over multiple benchmark runs. Individual run-to-run variation typically falls within ±5% for routing latencies and ±1% for success rates. Where a result is within noise of another, we say so explicitly. Otherwise, the reported means are stable indicators of protocol behaviour.

### 7.1 Point-to-Point Routing (Web-Limited, 50 connections)

| Metric | K-DHT | G-DHT-b | NX-10 |
|--------|-------|---------|-------|
| Global hops | 3.45 | 4.62 | 3.43 |
| Global latency | 355 ms | 272 ms | 261 ms |
| 500 km latency | 362 ms | 124 ms | 67 ms |
| 2,000 km latency | 348 ms | 157 ms | 90 ms |
| 5,000 km latency | 349 ms | 196 ms | 147 ms |
| 10% dest latency | 241 ms | 107 ms | 40 ms |
| NA to Asia latency | 342 ms | 294 ms | 249 ms |
| Success rate | 100% | 100% | 100% |

Under web-realistic connection limits (50 peers per node), the Neuromorphic DHT achieves **26% lower global latency** than Kademlia and **4% lower** than G-DHT-b. The regional advantage is dramatic: at 500 km, NX-10 routes in 67 ms vs. Kademlia's 362 ms -- an **81% reduction**. For concentrated workloads (10% destinations), NX-10 achieves 40 ms vs. Kademlia's 241 ms through hop caching and LTP reinforcement of popular routes.

```
Latency by Distance (Web-Limited, 25K nodes):

           500km   2000km   5000km   Global   NA→AS
K-DHT:     362     348      349      355      342
G-DHT-b:   124     157      196      272      294
NX-10:      67      90      147      261      249
```

### 7.2 Point-to-Point Routing (Uncapped, No Connection Limit)

The web-limited results above assume each node can maintain at most 50 peer connections -- a browser-realistic constraint. To understand whether the Neuromorphic advantage is an artifact of constrained resources, we also measured all three protocols with the connection cap removed. In this mode, Kademlia and G-DHT are free to fill every XOR bucket to its full `k=20` allocation (producing hundreds of peers per node), and NX-10 is allowed a synaptome of up to 256 connections.

| Metric | K-DHT | G-DHT-b | NX-10 |
|--------|-------|---------|-------|
| Global hops | 2.99 | 4.37 | 2.75 |
| Global latency | 299 ms | 269 ms | **191 ms** |
| 500 km latency | 297 ms | 117 ms | **46 ms** |
| 1,000 km latency | 292 ms | 128 ms | **58 ms** |
| 2,000 km latency | 294 ms | 148 ms | **71 ms** |
| 5,000 km latency | 295 ms | 185 ms | **109 ms** |
| 10% dest latency | 154 ms | 92 ms | **31 ms** |
| 10% → 10% latency | 159 ms | 91 ms | **31 ms** |
| NA to Asia latency | 293 ms | 279 ms | **212 ms** |
| 5% churn latency | 316 ms | 273 ms | **206 ms** |
| 5% churn success | 100% | 100% | **100%** |

The uncapped results confirm that the Neuromorphic advantage is structural, not circumstantial:

**Kademlia barely improves.** Global latency drops only from 355 ms to 299 ms (-16%), and regional latency is essentially unchanged (500 km: 362→297 ms). Giving Kademlia an unlimited connection budget does not fix XOR's geographic blindness -- the protocol still routes through distant peers because that's what its metric demands. Hop count drops from 3.45 to 2.99 (one hop saved), but each hop still costs as much as before.

**G-DHT-b gains modestly.** Global latency improves from 272→269 ms, regional from 124→117 ms at 500 km. The three-layer bootstrap already provided geographic locality under the cap; removing the cap lets the buckets fill more deeply but the protocol has no learning mechanism to exploit the extra capacity.

**NX-10 gains the most.** Global latency drops from 261→191 ms (-27%), and regional from 67→46 ms at 500 km (-31%). The adaptive mechanisms -- hop caching, lateral spread, LTP reinforcement, triadic closure -- all scale with available synaptome slots. More capacity means more room to cache discovered routes, more diverse exploration, and more stable long-range connections. The concentrated-workload metrics (10% dest at 31 ms, 10%→10% at 31 ms) drop to near-direct delivery, indicating the learning machinery has converged on optimal routes for popular traffic patterns.

#### The Gap Widens, Not Closes

The comparison that matters most is how the NX-10 advantage changes when the playing field is levelled:

| Metric | Web-limited (NX-10 vs K-DHT) | Uncapped (NX-10 vs K-DHT) | Gap change |
|--------|------------------------------|---------------------------|-----------|
| Global | 1.36× faster | **1.57× faster** | Widens |
| 500 km | 5.4× faster | **6.5× faster** | Widens |
| 1,000 km | 5.1× faster | **5.0× faster** | Stable |
| 10% dest | 6.0× faster | **5.0× faster** | Narrows slightly |
| 10%→10% | 7.6× faster | **5.1× faster** | Narrows (K-DHT improves) |

The widening of the global and 500 km gaps under uncapped operation is the clearest evidence that NX-10's benefits come from *algorithmic* innovation rather than from working around a constraint that hurts its competitors. When every protocol is given as much capacity as it wants, NX-10 makes better use of it.

One caveat: under concentrated-workload scenarios (10% dest, 10%→10%), Kademlia's uncapped improvement is proportionally larger than NX-10's, because Kademlia starts so far behind -- it now has enough connections that popular destinations are frequently one hop away by chance. The NX-10 advantage is still 5× but has compressed from 7.6×. This tells us that Kademlia's weakness under web-limit is partly a coverage problem (with unlimited connections, random coverage sometimes hits the popular 10% set directly), not purely a metric-blindness problem.

### 7.3 Pub/Sub Broadcast (2,000 subscribers)

| Metric | K-DHT (flat) | G-DHT-b (flat) | NX-10 (axonal) |
|--------|-------------|----------------|----------------|
| Relay latency | 418 ms | 303 ms | 233 ms |
| Broadcast latency | 359 ms | 276 ms | 260 ms |
| Max fan-out per node | 1,999 | 1,999 | 42 |
| Tree depth | 0 | 0 | 5 |
| Avg subscribers/node | 1,999 | 1,999 | 10.8 |

The axonal tree reduces max fan-out from 1,999 to 42 -- a **48x reduction** in per-node work -- while achieving the lowest broadcast and relay latency. Without the tree, the relay node must individually look up and deliver to every subscriber. With the tree, work is distributed across ~185 forwarding nodes (2000 / 10.8 avg subs per node), each handling a manageable subset.

```
Fan-out per Relay Node:

K-DHT (flat):      ████████████████████████████████████ 1,999
G-DHT-b (flat):    ████████████████████████████████████ 1,999
NX-10 (axonal):    █░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░░    42
                   0         500       1000      1500     2000
```

### 7.4 Churn Resilience

| Metric | K-DHT | G-DHT-b | NX-10 |
|--------|-------|---------|-------|
| 5% churn hops | 3.64 | 4.88 | 4.27 |
| 5% churn latency | 384 ms | 300 ms | 253 ms |
| 5% churn success | 99.8% | 100% | **100%** |
| 25% churn success | 99.6% | 100% | **100%** |

Under honest node removal (no proactive healing -- dead nodes simply disappear), all protocols maintain near-perfect churn resilience at 25,000 nodes. NX-10 achieves **100% success at both 5% and 25% churn** while maintaining the lowest churn latency (253 ms). The dead-synapse eviction mechanism discovers and replaces failed connections during routing, while iterative fallback ensures every lookup eventually finds the target even through damaged routing tables.

At extreme churn (25% per round, 5 rounds -- 76% of original nodes replaced), NX-10 maintains 100% success through the combination of:
- Realistic iterative bootstrap join for new nodes
- Dead-synapse eviction + 2-hop replacement during routing
- Churn-triggered temperature reheat for accelerated exploration
- Iterative fallback as a safety net when greedy routing stalls

### 7.5 Slice World Test (Network Partition)

The Slice World test partitions the network into Eastern and Western hemispheres, connected only through a single node in Hawaii. This tests routing through an extreme bottleneck.

| Protocol | Success | Key mechanism |
|----------|---------|---------------|
| K-DHT | 52% | Cannot find bridge -- terminates after 2 no-progress rounds |
| G-DHT-b | 52% | Same limitation as Kademlia |
| NX-3 (no fallback) | 99.4% | Incoming synapses expose bridge connections |
| NX-10 | **100%** | Iterative fallback + incoming synapses guarantee bridge discovery |

This test demonstrates the critical importance of the incoming synapse reverse index (52% → 99.4%) and iterative fallback (99.4% → 100%) for routing through network bottlenecks.

### 7.6 NX-13: Optimized Configuration

NX-13 is NX-10 with tunable parameters, enabling systematic exploration of the configuration space. Through 20+ iterations of parameter optimization at 25,000 nodes, the following improvements were identified:

| Parameter | NX-10 default | NX-13 optimized | Effect |
|-----------|---------------|-----------------|--------|
| Markov window | 16 | 32 | −6 ms global (wider pattern detection) |
| Markov hot threshold | 3 | 2 | Faster hot-destination learning |
| Highway slots | 12 | 16 | Improved cross-continent routing |
| Dendritic capacity | 32 | 64 | −52 ms broadcast with 2000 subscribers |
| Dendritic TTL | 10 | 20 | More stable pub/sub tree |

**Routing results (NX-13 optimized vs NX-10):**

| Metric | NX-10 | NX-13 | Improvement |
|--------|-------|-------|-------------|
| Global latency | 261 ms | 251 ms | −4% |
| 10% src latency | 250 ms | 241 ms | −4% |
| NA→AS latency | 246 ms | 244 ms | −1% |
| Churn success | 100% | 100% | maintained |

**Rule ablation (NX-13, disabling one rule at a time):**

| Rule disabled | Global latency Δ | Key finding |
|---------------|-------------------|-------------|
| Markov pre-learning | +20 ms | Largest single-rule impact on latency |
| Lateral spread | +19 ms | Critical for geographic shortcut propagation |
| Triadic closure | +15 ms | Important for path compression |
| Hop caching | +12 ms | Primarily helps regional routing (+8 ms at 500 km) |
| Two-tier highway | +8 ms | More impactful at larger scale |
| LTP reinforcement | +7 ms | Primarily helps regional routing |

No single rule is responsible for NX-10's performance -- each contributes measurably, and the learning mechanisms work synergistically. The protocol is near a local optimum: 20+ iterations of parameter tuning found only ~10 ms of improvement, confirming the default configuration is well-tuned.

---

## Chapter 8: Analysis and Potential Issues

### 8.1 Forwarder Loss Under Churn

**The issue**: In the axonal tree, if a forwarder dies during a publish cycle, all subscribers in its subtree are temporarily unreachable via the tree path. The parent must fall back to direct DHT lookups for the entire subtree, which can spike its fan-out far above the capacity limit.

**Current status**: Point-to-point routing achieves 100% success at 25% churn through dead-synapse eviction and iterative fallback. The axonal tree has separate healing: dead forwarders are detected during delivery and their subtree is moved to the parent. The tree rebuilds on the next publish cycle.

**Mitigations**:
- **Current**: Dead forwarders are healed by moving their subtree to the parent; the tree rebuilds on the next tick.
- **Possible**: Redundant forwarders (each delegation assigns a backup); proactive forwarder health checks before each publish cycle; dynamically increasing capacity under high churn to produce shallower trees.

### 8.2 Tree Rebuild Cost at Scale

**The issue**: The current implementation rebuilds the entire tree from scratch when the subscriber set changes. For 2,000 subscribers this is negligible, but for 50,000+ subscribers, the O(S x F) first-hop calculations per tree level become measurable.

**Mitigations**:
- **Current**: Rebuild is skipped when the subscriber set is unchanged.
- **Possible**: Incremental updates via subscription interception -- new subscribers are routed down the existing tree to the nearest node, avoiding a full rebuild.

### 8.3 Gateway Concentration

**The issue**: If the relay's synaptome is poorly distributed (many subscribers in the same ID-space region), one gateway may cover a disproportionate number of subscribers. The recursive delegation handles this, but the resulting tree may be deep and narrow rather than broad and shallow.

**Mitigations**:
- **Current**: Recursive delegation naturally distributes the load.
- **Possible**: When a single gateway covers >50% of remaining subscribers, introduce a secondary splitting criterion (e.g., geographic cell prefix) to force broader distribution.

### 8.4 Synaptome-Tree Coupling

**The issue**: The axonal tree's structure depends on the synaptome state at build time. If annealing replaces a synapse that happens to be a forwarder, the tree becomes structurally invalid without knowing it. The TTL-based rebuild eventually catches this, but there is a window of stale tree structure.

**Mitigations**:
- **Current**: Trees are rebuilt periodically (every time subscribers change or TTL triggers).
- **Possible**: When a synapse that is also a forwarder is evicted by annealing or decay, immediately mark the tree dirty.

### 8.5 Learning Warmup Period

**The issue**: The Neuromorphic DHT requires a warmup period (4 sessions, ~5,000 lookups) before reaching optimal routing performance. During this period, the synaptome is still being trained and hop counts are higher. A newly joined node will not immediately benefit from the adaptive routing.

**Mitigating factors**: Benchmarks show that even under Bootstrap Init (organic join, no pre-computation), the Neuromorphic DHT achieves 100% lookup success -- the only protocol to do so (K-DHT and G-DHT both drop to 97%). The learning mechanisms compensate for imperfect bootstrap tables during warmup.

**Possible further improvements**: Pre-trained synaptome snapshots shared between nodes; accelerated learning through synthetic warmup lookups during join; the diversified bootstrap (Section 4.16) reduces convergence time by providing annealing with more varied seed connections.

### 8.6 Byzantine Resistance

**The issue**: A malicious node could claim a false geographic position (S2 cell prefix) to position itself strategically in the ID space. It could also manipulate its synaptome reports during iterative fallback to poison other nodes' routing tables.

**Mitigations**:
- **Not currently addressed**: The system assumes honest nodes.
- **Possible**: Proof-of-location verification; cryptographic ID binding; reputation systems based on observed routing reliability; requiring multiple independent paths for routing table updates.

### 8.7 Memory and Bandwidth Overhead

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
- DTLS-encrypted, Network Address Translation (NAT) traversing
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

# NX-10: Neuromorphic DHT with Routing-Topology Pub/Sub

## Overview

NX-10 is a distributed hash table (DHT) protocol that uses neuroscience-inspired mechanisms for routing and a topology-aware forwarding tree for scalable publish/subscribe. It runs on a network of nodes distributed across the globe, where each node maintains a dynamic set of connections (called **synapses**) to other nodes. These connections strengthen or weaken over time based on usage, similar to how biological neural pathways adapt.

The protocol has two major components:

1. **Neuromorphic routing** (inherited from NX-6): An adaptive routing layer where each node maintains a personal routing table (its "synaptome") that evolves through simulated annealing, reinforcement learning, and decay. This produces efficient point-to-point message routing.

2. **Routing-topology forwarding tree** (new in NX-10): A pub/sub broadcast mechanism where the relay tree mirrors the actual routing paths in the network. Instead of building a separate overlay structure, NX-10 delegates subscribers to the direct connections that messages would naturally flow through anyway.

---

## Part 1: Node Identity and Geography

### Node IDs

Every node has a 64-bit identifier. The top 8 bits encode the node's geographic location using an S2 Hilbert curve cell index (0--255). The remaining 56 bits are random. This means:

- Nodes in the same geographic region share a common ID prefix.
- XOR distance between two IDs within the same cell is bounded (they share the top 8 bits).
- Geographically close nodes can be identified by comparing their top bits.

```
Node ID (64 bits):
[8 bits: S2 cell] [56 bits: random]
```

### Latency Model

Communication latency between two nodes is based on their great-circle distance:

- **Propagation delay**: proportional to distance, up to 150 ms one-way for antipodal nodes (~20,015 km apart).
- **Processing cost**: 10 ms per hop.
- **Round-trip time**: 2 x (propagation + processing). Two nearby nodes might have 25 ms RTT; two on opposite sides of the globe, about 320 ms.

---

## Part 2: The Synaptome (Routing Table)

Each node maintains a set of connections called its **synaptome**. Unlike traditional DHTs that use fixed-structure routing tables (e.g., Kademlia's k-buckets), the synaptome is a dynamic, unbounded-in-principle collection of weighted connections that evolve over time.

### Synapse Properties

Each synapse (connection to another node) carries:

| Property | Description |
|----------|-------------|
| **peerId** | The connected node's 64-bit ID |
| **weight** | Reliability score, 0.0 to 1.0. Higher = more trusted for routing |
| **latency** | Estimated round-trip time to this peer (ms) |
| **stratum** | XOR distance category (0--63). Computed as the number of leading zeros in `myId XOR peerId`. Low stratum = far in ID space; high stratum = close |
| **inertia** | Epoch until which this synapse is protected from decay (set after reinforcement) |
| **bootstrap** | Whether this synapse was established during initial network setup (decays more slowly) |

### Two-Tier Architecture

The synaptome is split into two tiers:

- **Local tier** (up to 48 synapses): The primary routing table. Covers a diverse range of strata for broad reachability. Managed by stratified eviction (see below).
- **Highway tier** (up to 12 synapses): Long-range, high-value connections that receive special decay protection. Discovered through periodic hub scanning.

When routing, both tiers are consulted. The highway tier provides reliable long-range shortcuts; the local tier provides fine-grained reachability.

---

## Part 3: Routing Algorithm

### Activation Potential (AP) Routing

When node A needs to send a message to target T, it uses greedy routing guided by an **activation potential** score. For each candidate synapse C in A's synaptome:

```
AP(C) = (distance_progress / latency) x (1 + 0.4 x weight)
```

Where:
- **distance_progress** = XOR_distance(A, T) - XOR_distance(C, T). How much closer C is to the target than A.
- **latency** = estimated round-trip time to C.
- **weight** = the synapse's reliability score (0 to 1).

The node picks the synapse with the highest AP -- the one that makes the most XOR progress per millisecond, with a mild preference for proven connections. The message is forwarded to that synapse, and the process repeats at each hop.

### Two-Hop Lookahead

Rather than choosing purely based on one-hop AP, the router also considers what the *next* node could do. It takes the top 5 candidates by one-hop AP, peeks into each candidate's synaptome, and computes a two-hop combined score:

```
AP2(C) = (total_progress_after_2_hops / total_latency_for_2_hops) x (1 + 0.4 x weight_of_C)
```

This avoids greedy dead ends: a slightly worse first hop that leads to a much better second hop will be preferred.

### Exploration (Epsilon-Greedy)

On 5% of first hops, the router picks a random synapse instead of the best one. This injects controlled randomness that helps discover better routes, especially early in the network's life.

### Iterative Fallback

If greedy AP routing gets stuck (no synapse makes progress toward the target), the router falls back to Kademlia-style iterative search: it queries the closest known peers for their routing tables, progressively narrowing in on the target. This guarantees reachability even when the synaptome has gaps.

---

## Part 4: Learning Mechanisms

### Long-Term Potentiation (LTP) -- Reinforcement

After a successful lookup that completes at or below the running average latency, the protocol sends a reinforcement wave back along the path. Each synapse used in the path receives:

- **Weight boost**: +0.2 (capped at 1.0)
- **Inertia lock**: Protected from decay for 20 epochs

This means synapses on efficient routes get stronger and more resistant to pruning, while unused synapses gradually weaken.

### Simulated Annealing -- Exploration and Repair

Each node has a **temperature** that starts high (1.0) and slowly cools (multiplied by 0.9997 per routing hop), bottoming out at 0.05. On each routing hop, with probability equal to the current temperature, the node performs an **annealing step**:

1. Find the weakest synapse in an over-represented stratum group.
2. Replace it with a new candidate from either:
   - **Global pool** (random node in the network in an under-represented stratum), or
   - **Local neighborhood** (2-hop neighbor in an under-represented stratum).
3. The new synapse starts with weight 0.1 (low, must prove itself).

This continuously explores new connections, filling gaps in stratum coverage and repairing damage from churn. The temperature controls the exploration rate: aggressive early on, minimal once the network stabilizes.

### Adaptive Decay -- Use-It-or-Lose-It

Every 100 lookups, all synapses undergo weight decay:

- **Heavily used synapses** (used 20+ times): decay factor 0.9998 (lose ~0.02% per interval -- nearly immortal).
- **Unused synapses**: decay factor 0.990 (lose ~1% per interval -- pruned within a few hundred lookups).
- **Bootstrap synapses**: blend toward the slower rate (structural protection).
- **Inertia-locked synapses**: skip decay entirely.

Synapses below weight 0.05 are candidates for pruning, subject to stratum floor rules (each stratum group retains at least a minimum number of synapses).

### Hop Caching and Lateral Spread

When node B forwards a message toward target T, B learns a shortcut: it adds T to its own synaptome (weight 0.5). This shortcut is also cascaded to up to 6 of B's regional neighbors (nodes sharing the same top-4 geographic bits), who each spread to 2 more neighbors. This rapidly propagates useful routes through geographic clusters.

### Triadic Closure

When a node repeatedly forwards messages between the same origin-destination pair (3+ times), it introduces them directly -- creating a synapse between origin and destination, bypassing the intermediary. This emergent shortcutting reduces future hop counts.

---

## Part 5: Network Bootstrap

### Initial Setup (Three-Layer Bootstrap)

When the network is first created, each node is given an initial synaptome through three layers:

1. **Inter-cell structured**: Connections to nodes in different geographic cells, covering diverse strata. These are marked as bootstrap synapses (weight 0.9, slower decay). Think of these as the backbone.

2. **Intra-cell local**: Connections to nearby nodes in the same geographic cell (weight 0.5). These provide local reachability.

3. **Random global**: Random connections to nodes anywhere in the network (weight 0.5). These provide long-range exploration paths.

### Dynamic Join (Stratified Iterative Bootstrap)

When a new node joins an existing network, it:

1. Connects to a sponsor node and performs a self-lookup (searching for its own ID) to discover nearby peers.
2. For each of the 8 geographic prefix bits, performs a lookup for an ID that differs in that bit -- discovering peers in different geographic cells.
3. Uses stratum-aware admission: if the synaptome is full, new peers can displace existing ones from over-represented strata, maintaining diversity.

---

## Part 6: Churn Recovery (NX-6)

When a routing hop discovers that a synapse points to a dead node:

### Temperature Reheat

The node's annealing temperature is spiked to 0.5 (from whatever low value it had cooled to). This triggers aggressive exploration (~50% chance per hop) on the damaged node, driving rapid synapse replacement. Temperature naturally cools back down after repair.

### Immediate Evict-and-Replace

The dead synapse is immediately deleted and replaced with a candidate from the 2-hop neighborhood in the same stratum range. The replacement receives the **median weight** of existing synapses (not a penalty weight), so it starts competitive. If the replacement happens to be closer to the current routing target, it is injected into the active lookup's candidate set for immediate use.

---

## Part 7: Routing-Topology Forwarding Tree (NX-10)

This is the core innovation of NX-10. Previous approaches (NX-7, NX-8, NX-9) built overlay trees using XOR partitioning or geographic clustering. NX-10 instead constructs a broadcast tree that mirrors how messages actually flow through the network.

### The Problem

In flat pub/sub, the relay node must individually look up and deliver to every subscriber. With 2,000 subscribers each requiring ~3.5 routing hops, that is 7,000 routing hops executed by a single node -- a severe bottleneck.

### The Insight

When the relay routes messages to its 2,000 subscribers, many of those routes share a common first hop. If 200 subscribers are all reached through synapse F as the first hop, the relay traverses the relay-to-F link 200 times. By making F a **forwarder**, the relay sends once to F, and F handles the 200 subscribers. This eliminates redundant first hops and distributes the work.

### Tree Construction Algorithm

The tree is built top-down from the relay root:

**Step 1**: All subscribers are assigned to the root node.

**Step 2**: If the root has more entries than its capacity (default: 32), it examines its synaptome to find the **first hop** toward each subscriber using greedy XOR routing (the same logic used in normal routing). It groups subscribers by their gateway synapse.

**Step 3**: The synapse that covers the most subscribers (minimum 2) becomes a **forwarder**. Those subscribers are moved from the root's table to the forwarder's table. The forwarder replaces them as a single entry in the root's table.

**Step 4**: If the forwarder also exceeds capacity, it repeats the same process with its own synapses, creating sub-forwarders. This continues recursively until every node in the tree is at or below capacity.

**Step 5**: If the root is still over capacity after creating one forwarder, it finds the next busiest gateway and creates another forwarder. This repeats until the root is under capacity or no more useful gateways exist.

```
Example with capacity=4 and 12 subscribers:

Before (flat):
  Root ──> S1, S2, S3, S4, S5, S6, S7, S8, S9, S10, S11, S12
  (Root does 12 lookups)

After (tree):
  Root ──> F_a, F_b, S11, S12
           │     │
           │     └──> S5, S6, S7, S8, S9, S10
           │           (F_b may further delegate if >4)
           └──> S1, S2, S3, S4

  Root sends to 4 entries (2 forwarders + 2 direct).
  F_a delivers to 4 subscribers.
  F_b delivers to 6, may create its own sub-forwarder.
```

### Delivery Algorithm

When a publish event occurs:

1. **Root sends to forwarders**: Each forwarder is a direct synapse of the root, so delivery is **1 hop** with no DHT lookup -- just a direct message at the round-trip latency between them.

2. **Root sends to remaining direct subscribers**: These require standard DHT lookups from the root (typically 2--4 hops).

3. **Each forwarder repeats the same process**: sends to its own forwarders (1 hop each) and does DHT lookups for its direct subscribers.

4. **Key property**: Because each forwarder was chosen as the first hop toward its subscribers, it is already closer to them in the routing topology. The DHT lookup from forwarder to subscriber requires fewer hops than it would from the root.

### Subscriber Set Changes

The tree rebuilds when the subscriber set changes (new subscribers added or existing ones time out). Rebuilding is inexpensive: it involves one first-hop calculation per subscriber per tree node level. With capacity 32 and typical tree depth of 3--4, this is a few thousand comparisons for 2,000 subscribers.

Between changes, existing subscriptions are renewed by updating the last-active timestamp on their tree node.

### Self-Healing

- **Dead forwarder**: When a forwarder dies (detected during delivery), its subscribers and child forwarders are moved up to the parent. The parent temporarily exceeds capacity; the next tree rebuild rebalances.

- **Dead subscriber**: Detected during delivery (DHT lookup fails) or during periodic pruning (node no longer alive). Removed from the tree; tree marked dirty for rebuild.

- **TTL expiry**: Subscribers inactive for more than 10 ticks are pruned. This handles graceful unsubscription via timeout.

---

## Part 8: Performance Characteristics

Based on benchmarks with 25,000 nodes and 2,000 subscribers:

| Metric | NX-6 (flat) | NX-10 (tree) |
|--------|-------------|--------------|
| Broadcast hops (mean) | 3.50 | 3.30 |
| Broadcast latency (mean) | 258 ms | 232 ms |
| Max fan-out per node | 1999 | 56 |
| Tree depth | 0 | 4 |
| Avg subscribers per node | 1999 | 11.7 |

The tree reduces max fan-out from 1,999 to 56 -- a 35x reduction in per-node work -- while slightly *improving* hop count and latency.

---

## Part 9: Analysis and Potential Issues

### Churn Vulnerability: Forwarder Loss

**The problem**: If a forwarder dies during a publish cycle, all subscribers in its subtree must be served by fallback delivery from the parent. With capacity 32 and a deep tree, a single forwarder failure could temporarily expose its parent to a burst of 100+ lookups.

**Current mitigation**: The heal-up mechanism moves orphaned subscribers to the parent, and the dirty flag triggers a tree rebuild on the next tick. But there is a window (one publish cycle) where delivery degrades.

**Higher churn impact**: With 5% churn, benchmark shows 72.6% success vs 77% for NX-6 flat. The tree adds structural dependency: a dead forwarder is worse than a dead subscriber because it blocks an entire subtree. In a 20% churn environment, multiple forwarders could die simultaneously, cascading failures upward.

**Possible improvements**:
- **Redundant forwarders**: Each delegation could assign a backup forwarder that receives the subscriber list but only activates if the primary fails.
- **Proactive health checks**: Forwarders could be pinged before each publish cycle; dead ones are healed before delivery begins.
- **Shallower trees under churn**: Dynamically increase capacity (reducing tree depth) when churn rate is high, trading fan-out balance for structural resilience.

### Tree Rebuild Cost

**The problem**: Every time the subscriber set changes (even by one subscriber), the entire tree is rebuilt from scratch. With 2,000 subscribers, this involves clearing and reconstructing all tree nodes.

**Current mitigation**: The `_subscribersChanged` check avoids rebuilds when the set is stable. Rebuilds are fast (just first-hop calculations, no network I/O).

**At larger scale**: With 50,000+ subscribers, rebuild cost grows linearly. The current approach of grouping by first-hop gateway is O(S x F) where S = subscribers and F = average synaptome size (48). At 50,000 subscribers, that is ~2.4M comparisons per rebuild -- still fast, but worth monitoring.

**Possible improvement**: Incremental updates -- add new subscribers to existing tree nodes via routing-path interception (the design already describes this conceptually but the implementation rebuilds from scratch).

### Gateway Concentration

**The problem**: In a well-trained network, many subscribers may route through the same few gateway synapses. A relay with 48 synapses serving 2,000 subscribers might have one gateway covering 500+ subscribers. That forwarder then has its own concentration problem.

**Current behavior**: The recursive delegation handles this -- the forwarder with 500 subscribers will itself delegate to its own gateways. But the tree depth increases, and each level adds 1 hop of latency.

**At extreme scale**: If the relay's synaptome is poorly distributed (many subscribers in the same ID-space region), the tree degenerates into a long chain through a few gateways. The minimum-2-subscribers rule prevents single-subscriber forwarders, but doesn't prevent highly unbalanced splits.

**Possible improvement**: When a gateway covers more than, say, 50% of remaining subscribers, split using a secondary criterion (e.g., geographic cell prefix) rather than routing topology alone.

### Forwarder Selection Bias

**The problem**: Forwarders are chosen purely by "which synapse is the first hop toward the most subscribers." This ignores the forwarder's own capacity, health, and connectivity. A well-connected node and a barely-connected node are treated equally.

**Possible improvement**: Weight the gateway selection by the gateway node's synaptome size, uptime, or recent lookup success rate. This would prefer robust forwarders.

### Subscription Interception Gap

**The problem**: The design describes subscription interception -- new subscribers should be captured by the nearest tree node on their routing path, rather than always going to root. The current implementation does not do this; it rebuilds from scratch, so all subscribers are reassigned from root downward.

**Impact**: In practice, the top-down rebuild achieves a similar result because the delegation algorithm routes subscribers to the same gateways that interception would choose. But incremental interception would be cheaper and more responsive to single-subscriber additions.

### No Cross-Tree Optimization

**The problem**: Each relay maintains its own independent tree. If two relays share many subscribers, they build separate trees with no shared structure. In a network with many pub/sub groups, this means redundant tree construction.

**Impact**: Minimal at current scale (one tree per relay, rebuilt per tick). But in a system with thousands of active pub/sub groups, the per-relay tree overhead adds up.

### Synaptome Coupling

**The problem**: The tree's structure depends entirely on the synaptome state at build time. If the synaptome changes (annealing replaces a synapse that was a forwarder), the tree becomes invalid. The dirty flag and TTL-based rebuild handle this, but there is no direct coupling between synaptome changes and tree invalidation.

**Possible improvement**: When a synapse that is also a forwarder gets evicted by annealing or decay, immediately mark the tree dirty.

---

## Summary

NX-10 combines biological-inspired adaptive routing with a pragmatic forwarding tree that leverages the routing topology itself. The key strengths are:

1. **Zero-overhead forwarding**: Forwarders are direct synapses, so forwarding is a single hop with no DHT lookup.
2. **Bounded fan-out**: No single node handles more than 32 entries, distributing work across the tree.
3. **Self-organizing**: The tree emerges from the routing topology -- no separate overlay to configure or maintain.
4. **Adaptive foundation**: The underlying synaptome continuously improves through reinforcement, annealing, and decay, which in turn improves the tree structure over time.

The primary weakness is structural fragility under high churn: the tree introduces dependencies between nodes, and forwarder failure disrupts entire subtrees. Mitigations exist (heal-up, rebuild) but introduce a recovery window that flat broadcast does not have.

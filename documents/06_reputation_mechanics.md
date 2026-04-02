# Reputation Mechanics: Uptime, Reliability, Warmup, and Parallel Testing

## Overview

This document describes the operational mechanics of reputation in the neuromorphic dendritic platform, focusing on how nodes earn reputation, lose it through churn, and are tested when new or returning. The design prioritizes low memory overhead, fast integration of useful new nodes, and natural resistance to abuse.

---

## Uptime and Reliability as Core Reputation Signals

In a network with significant churn, uptime is one of the most critical reputation signals. A node that is offline cannot relay messages, cannot serve content, and creates cascading failures in any dendritic subtree that routes through it.

### Uptime Measurement

Each node's immediate neighbors continuously track availability through lightweight heartbeats:

- **Heartbeat interval**: Each node sends a lightweight ping to its neighbors on a regular interval (e.g., every 30 seconds)
- **Failure detection**: Missing three consecutive heartbeats marks a node as suspect; five consecutive marks it as down
- **Uptime ratio**: Over a rolling window, calculate: (time online) / (total window time)
- **Example**: A node online 23 out of 24 hours scores 95.8% uptime

### Message Delivery Success Rate

Uptime alone is insufficient — a node can be online but unreliable:

- **Delivery tracking**: When a relay node forwards a message, downstream nodes send acknowledgments back up the tree
- **Success rate**: (messages successfully delivered) / (messages received and forwarded)
- **Latency tracking**: Measure time from message arrival to forwarding completion
- **Composite reliability score**: Combines uptime × delivery success rate × latency percentile

### Failure Recovery Behavior

How a node fails matters:

- **Graceful shutdown**: Node announces departure, transfers subscription state to neighbors — minimal reputation loss
- **Silent churn**: Node disappears without warning — higher reputation penalty
- **Recovery speed**: A node that returns quickly after a brief outage is preferred over one absent for days
- **Pattern detection**: A node that churns on and off repeatedly (e.g., residential internet) is deprioritized even if its uptime ratio looks acceptable

---

## Ephemeral Reputation: No Long-Term Memory

Reputation is not stored as persistent historical record. This is a deliberate design choice for efficiency.

**Why no long-term memory**:
- Storing historical reputation for millions of nodes is expensive
- Stale reputation data can mislead — a node that was great six months ago may have degraded hardware or moved to a worse network position
- Fresh behavior is more predictive than historical behavior

**Consequence**: If a node goes offline — even a previously high-reputation hub — it loses its reputation cache. When it returns, it is treated as a new node and must rebuild.

**Why this is acceptable**:
- The network rebuilds quickly through parallel testing (see below)
- A genuinely good node will re-establish reputation fast
- This prevents "reputation coasting" — nodes that earned trust in the past but are now degraded

---

## The Warmup Period: Inclusive Testing for New Nodes

When a new node joins the network, it starts with zero reputation. However, the system does not simply ignore it or keep it on the periphery indefinitely.

**Design principle**: Be inclusionary. Test new nodes actively and quickly, so that genuinely useful nodes can contribute as soon as possible.

### Why Inclusive Testing Matters

A network that takes weeks to trust new nodes:
- Wastes potential capacity
- Fails to discover nodes with superior hardware or network position
- Creates a "rich get richer" dynamic where established nodes dominate

A network that trusts new nodes immediately:
- Is vulnerable to sybil attacks and low-quality nodes
- Allows bad actors to position themselves as hubs before detection

**Balance**: Test new nodes in parallel with established nodes, get fast feedback, and promote or deprioritize rapidly.

---

## Parallel Testing: The Core Mechanism

When a new node joins and announces its availability for a capability or relay function, the system runs parallel tests rather than waiting for isolated evaluation.

### How Parallel Testing Works

1. **New node joins**: Announces readiness to relay for a given set of topics
2. **Parallel routing**: The system routes the same message through both:
   - The established path (proven, high-reputation relay)
   - The new node
3. **Comparison**: Both paths are observed for:
   - Delivery success (did the message arrive?)
   - Latency (how long did it take?)
   - Message integrity (was it forwarded correctly?)
4. **Outcome**:
   - If new node matches or exceeds established path → promote rapidly
   - If new node fails or lags significantly → keep in test mode longer, do not promote to hub
   - If new node fails repeatedly → deprioritize to periphery

### Properties of Parallel Testing

- **No wasted traffic**: The message is being sent anyway. Parallel testing adds one additional delivery path, not a dedicated test stream
- **Fast feedback**: Results are available within seconds of the message being sent
- **Continuous**: Even established nodes are occasionally tested against new challengers — prevents reputation from becoming stale
- **Graceful discovery**: If a new node is actually better than the established relay (e.g., superior network position, lower latency), the system discovers this quickly and begins preferring it

### Promotion Thresholds

A new node graduates from "test" to "trusted relay" status when:
- It has successfully relayed N messages (e.g., 100) without failure
- Its latency is within an acceptable range of the established path
- Its uptime over the test period meets threshold (e.g., 90%+)
- No integrity failures have been detected

These thresholds are adjustable per deployment context — a high-stakes network (financial data) uses stricter thresholds than a casual messaging network.

---

## Reputation Decay and Recovery

### Decay Without Memory

When a node goes offline:
- Its reputation is not stored — it's simply absent from the active topology
- Neighbors remove it from their local routing tables
- The dendritic tree routes around it (subscription reattachment triggers naturally)

When the node returns:
- It is treated as a new node
- It must re-enter the parallel testing phase
- Its previously-earned position in the tree is not restored automatically

### Fast Recovery for Genuinely Good Nodes

A node that was previously a high-performing hub and returns with the same hardware and network position will:
- Pass parallel tests quickly (its performance metrics haven't changed)
- Re-earn reputation faster than a truly new node (performance, not history, drives promotion)
- Naturally return to a hub position as the topology rewires around its demonstrated performance

This creates a fair, behavior-driven system without requiring memory.

---

## Topology Positioning Based on Reliability

The neuromorphic rewiring algorithm uses reliability scores to position nodes:

| Reliability Score | Topology Position |
|------------------|-------------------|
| 95%+ uptime, 98%+ delivery | Hub relay — critical paths |
| 85–95% uptime, 90–98% delivery | Secondary relay |
| 70–85% uptime | Leaf relay — low-critical paths |
| Below 70% uptime | Periphery — subscriptions only, no relay duties |
| Failed integrity check | Excluded from relay, flagged |

This gradient ensures that critical message paths are handled by the most reliable nodes, while lower-reliability nodes still participate in lower-stakes roles.

---

## Resistance to Abuse

**Sybil attack**: An attacker spins up thousands of new nodes.
- All start at zero reputation and must pass parallel tests
- Fake nodes with poor real-world performance (because they're on the same hardware/connection) will fail tests
- Cannot overwhelm legitimate nodes in hub positions

**Reputation gaming**: A node behaves well during testing, then degrades.
- Continuous parallel testing detects degradation quickly
- Reputation decay happens in real-time based on current behavior, not historical scores

**Eclipse attack**: Attacker nodes surround a target node.
- Geographic S2 variant diversifies routing paths geographically
- Reputation system deprioritizes any cluster of nodes with correlated failure behavior

---

## Summary

The reputation mechanics form a self-correcting, memory-efficient system:

1. **Ephemeral reputation**: No expensive historical storage — current behavior drives positioning
2. **Inclusive warmup**: New nodes are tested immediately, not ignored
3. **Parallel testing**: Fast feedback on new node quality without dedicated test traffic
4. **Gradient positioning**: Reliability scores map directly to topology roles
5. **Continuous evaluation**: Even established nodes are occasionally re-tested
6. **Abuse-resistant**: Sybil attacks fail because fake nodes can't fake real performance

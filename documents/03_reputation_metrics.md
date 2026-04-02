# Reputation Metrics for the Neuromorphic Dendritic Platform

## Overview

Reputation in a decentralized system must be measurable locally — each node only observes its direct interactions — while contributing to global optimization through neuromorphic topology rewiring. All six metrics below are observable within the dendritic tree without requiring global state.

---

## 1. Content Value (Publisher Reputation)

**What it measures**: How much demand exists for content you publish.

**How to track**:
- Count subscription requests for your published topics
- Count downstream message deliveries
- Track rerequests (indicates persistent value)

**Why it matters**: Publishers who create content others want should become hubs. Their content travels further with less latency.

**Local observation**: Direct subscribers and relay nodes immediately downstream measure how often your content flows through them.

---

## 2. Relay Efficiency (Forwarder Reputation)

**What it measures**: How reliably and quickly you forward messages.

**How to track**:
- Message latency: How much delay does your node add?
- Delivery success rate: What percentage of received messages actually get forwarded?
- Message integrity: Do you forward without corruption or loss?

**Why it matters**: Efficient relays become natural hubs. Slow or unreliable nodes drift to the periphery.

**Local observation**: Parent and child relay nodes directly measure latency and success. Subscribers notice when messages don't arrive.

---

## 3. Bandwidth Contribution (Resource Sharing)

**What it measures**: Are you uploading as much as you download?

**How to track**:
- Total bytes relayed (messages forwarded)
- Total bytes published (original content you created)
- Total bytes consumed (messages received that terminate at you)
- Ratio: (relayed + published) / consumed

**Why it matters**: Heavy consumers who don't contribute strain the system. Contributors should get better positioning.

**Local observation**: Each node knows its own traffic; parent and child relays see traffic flowing through them.

---

## 4. Uptime and Availability

**What it measures**: How reliably are you online and reachable?

**How to track**:
- Successful connection attempts / total attempts
- Time since last churn event
- Subscription renewal rate

**Why it matters**: Unreliable nodes create cascading failures. Stable nodes should be relay hubs. Flaky nodes should be leaves.

**Local observation**: Parent and child nodes track successful vs. failed contact attempts. Timeout behavior reveals flakiness.

**Note**: Reputation is ephemeral, not persistent history. If a node goes offline, its reputation cache is not maintained — it must rebuild from scratch when it returns.

---

## 5. Topic Relevance and Popularity

**What it measures**: Does your node actually receive traffic for the topics you relay?

**How to track**:
- Ratio of active subscriptions to advertised topics
- Traffic volume per relayed topic
- Subscription churn: Are subscribers renewing or abandoning?

**Why it matters**: Nodes positioning themselves as relays for unpopular topics waste capacity. Nodes routing genuinely popular content should be hubs.

**Local observation**: You know which subscriptions are active under you. Children report actual traffic volume.

---

## 6. Load Shedding Cooperation

**What it measures**: When overloaded, do you responsibly delegate, or collapse under pressure?

**How to track**:
- When capacity threshold is hit, do you proactively request child relays?
- Do you properly transfer subscription state when delegating?
- Or do you silently drop messages?

**Why it matters**: Nodes that cooperate during overload maintain system health. Nodes that collapse damage their subtree.

---

## 7. Message Honesty

**What it measures**: Do you forward accurate information, or corrupt/fabricate messages?

**How to track**:
- Cryptographic signatures on messages detect tampering
- Publisher verification: Does content actually come from who claims?
- Consistency checks: Do you report conflicting metrics about your own state?

**Why it matters**: Byzantine nodes can poison the network. Any detected dishonesty immediately tanks reputation.

---

## Locality of Reputation

**Critical insight**: Reputation is inherently local.

- Node A's reputation TO node B (its parent) is based on A's directly observable behavior
- Node A's reputation TO node C (a peer) may be different, based on different interactions
- Global reputation emerges from aggregating local observations across the tree

**Implementation approach**:
- Each node maintains a local reputation vector for its parent, children, and direct peers
- Reputation decays over time — old information becomes less relevant
- When reputations propagate upward through acknowledgments, they're tagged with source and timestamp
- Neuromorphic rewiring uses local reputation signals to position nodes in topology

---

## How Reputation Drives Topology

**High reputation nodes** (reliable relays, popular content) become hubs:
- Load shedding directs subscriptions toward them
- Publishers prefer them as distribution points
- Neuromorphic algorithm positions them centrally

**Low reputation nodes** (slow, unreliable, selfish) drift to periphery:
- Few subscriptions route through them
- Limited ability to harm the network

**Feedback loop**:
- Better position → more traffic → more reputation-building opportunities
- Worse position → fewer opportunities → reputation stays low
- Creates natural stratification without explicit punishment

---

## Potential Attacks and Mitigations

**Sybil attack**: Create many low-identity nodes to dilute checks.
- Mitigation: Reputation takes time to build; new nodes start with zero credibility.

**Whitewashing**: Burn a bad-reputation node, create new identity.
- Mitigation: Tie reputation to verifiable behavior (uptime, storage proofs).

**Collusion**: Multiple nodes coordinate to claim false reputation.
- Mitigation: Reputation based on observable behavior, not self-reports.

**Reputation hoarding**: Claim high reputation but don't contribute.
- Mitigation: Reputation is earned through sustained behavior; false claims are detected when node fails under load.

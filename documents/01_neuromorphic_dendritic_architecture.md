**Neuromorphic DHT with Dendritic Pub/Sub**

Architecture Design Document

Version 2.0 --- Updated with Dendritic Terminology and Extended
Architecture

**Document Series**

This document is the master architecture reference for the Neuromorphic
Dendritic Platform. It should be read alongside the following companion
documents:

> **Document 02: Tracker Coordination** --- How integrating tracker
> infrastructure creates BitTorrent-like efficiency on top of the
> neuromorphic DHT.
>
> **Document 03: Reputation Metrics** --- The seven core metrics for
> measuring node trustworthiness and how they drive topology
> positioning.
>
> **Document 04: Platform Applications** --- Six concrete applications:
> messaging, DNS, service discovery, IoT, logging, and ML distribution.
>
> **Document 05: Social Network Architecture** --- A decentralized
> Twitter-like social network with like, dislike, and code red community
> moderation.
>
> **Document 06: Reputation Mechanics** --- Uptime tracking, ephemeral
> reputation, warmup periods, and parallel testing for new nodes.
>
> **Document 07: Agentic Collaboration** --- Using the platform as
> infrastructure for AI agent-to-agent discovery, coordination, and
> collaboration.

**1. Overview**

This document describes the Neuromorphic Dendritic Platform --- a
distributed publish/subscribe system built on top of a neuromorphic
Distributed Hash Table (DHT). The pub/sub overlay is called the
Dendritic system, named for its branching tree structure that mirrors
the dendrites of biological neurons. The platform is designed to scale
to billions of users, self-organize around traffic demand, and self-heal
in the face of node churn --- all using pub/sub as both the data plane
and the control plane.

**2. Terminology**

Two key terms distinguish this platform from conventional DHT and
pub/sub systems:

**2.1 Neuromorphic DHT**

The underlying distributed hash table. Unlike traditional DHTs
(Kademlia, Chord, Pastry), the neuromorphic DHT treats nodes as neurons:
connections rewire dynamically based on observed traffic flow. Nodes
that communicate heavily migrate closer together in the logical topology
over time, reducing hop counts and latency for the most common data
paths. The network continuously adapts to real-world usage rather than
maintaining a static structure.

**2.2 Dendritic Pub/Sub**

The publish/subscribe overlay built on top of the neuromorphic DHT. The
term dendritic refers to the branching relay tree that the system
constructs dynamically to distribute messages from publishers to
subscribers. Like biological dendrites that branch outward to receive
signals, the Dendritic pub/sub system grows relay branches toward
subscribers on demand, and prunes them when demand subsides. The
Dendritic tree is not static --- it is continuously grown, pruned, and
reorganized by the underlying neuromorphic mechanisms.

**3. Neuromorphic DHT**

**3.1 Traditional DHTs vs. Neuromorphic Approach**

Traditional DHTs such as Kademlia use node IDs to organize the network
topology and route messages. Connections are determined by ID proximity,
not by actual traffic patterns. This is efficient for uniform workloads
but suboptimal for real-world usage where some topics, content, and
nodes are far more active than others.

The neuromorphic DHT takes a fundamentally different approach: nodes are
treated analogously to neurons. Connections between nodes are
dynamically rewired based on observed traffic flow. Over time, nodes
that communicate heavily migrate closer together in the logical
topology, reducing hop counts and latency for the most common data
paths. The network becomes increasingly efficient as it adapts to
real-world usage.

**3.2 Geographic Kademlia Variant**

A second variant, Geographic Kademlia, augments the neuromorphic DHT
with a spatial prefix derived from the S2 library. This encodes
real-world geographic location into the node ID, so that nodes that are
physically close are also likely to be close in the DHT topology. This
provides an additional latency improvement for geographically-local
traffic, and is particularly valuable for the applications described in
Document 04.

**3.3 Key Properties**

-   Self-organizing: topology reconfigures automatically around traffic
    patterns

-   Geographically aware: optional S2-based prefix reduces latency for
    local traffic

-   Self-healing: nodes constantly rejoin and re-establish connections
    after churn

-   Traffic-optimized: unlike Kademlia or Chord, routing efficiency
    improves with usage

**4. Baseline Pub/Sub on a DHT**

**4.1 Simple Single-Node Relay**

In a naive pub/sub overlay on a DHT, each topic is mapped to a hash ID
in the DHT\'s key space. The node closest to that ID becomes the relay
node for that topic. It maintains a subscriber table: a list of all
nodes that have subscribed to the topic.

When a publisher sends a message to a topic, the message is routed to
that relay node. The relay node then fans the message out to all
subscribers in its table.

**4.2 Failure Modes**

This simple design has two critical failure modes that necessitate the
Dendritic architecture:

**4.2.1 Node Churn**

DHT nodes join and leave the network continuously. If the relay node for
a popular topic goes offline, all subscribers lose their connection to
that topic instantly. This is a single point of failure.

**4.2.2 Scalability Collapse**

If a topic becomes very popular --- say 100,000 subscribers --- a single
relay node is overwhelmed. It cannot handle the inbound publish rate
combined with the fanout to 100,000 destinations. The system collapses
under its own demand.

**5. The Dendritic Pub/Sub System**

**5.1 Core Concept**

The Dendritic system solves both failure modes by distributing the relay
function across a dynamically-growing tree of nodes. No single node
handles all subscribers. Instead, when a relay node reaches its capacity
limit, it recruits neighboring nodes to take over subsets of its
subscriber list. Those nodes, in turn, can recruit further nodes if they
become overloaded. The result is a recursive fanout tree --- the
Dendritic tree --- rooted at the original relay node for the topic.

**5.2 Dendritic Tree Construction**

**Step 1: Root Relay Node**

A topic is published. The DHT routes to the closest node to the topic\'s
hash ID. This node becomes the root of the Dendritic tree for that
topic. It begins accepting subscriptions.

**Step 2: Overload Detection and Delegation**

When the root relay node\'s subscriber count exceeds its capacity
threshold (e.g., 100 subscribers), it selects a set of its
directly-connected DHT neighbors and delegates subsets of its subscriber
list to them. Each delegated node becomes a secondary relay --- a Level
2 dendritic branch node.

The root establishes a pub/sub relationship with each Level 2 node: when
the root receives a publish event, it re-publishes (forwards) that event
down to each Level 2 branch. Each branch node is responsible for
delivering to its own subscriber subset.

**Step 3: Recursive Branching**

Level 2 branch nodes apply the same logic. If a Level 2 node exceeds its
capacity, it delegates to Level 3 nodes using the same mechanism. This
recursion continues to arbitrary depth. The Dendritic tree grows
organically as demand increases --- exactly as biological dendrites
branch to receive more signal.

**Step 4: DHT-Guided Placement**

When placing subscriptions in the Dendritic tree, nodes use DHT
proximity to guide routing. A relay node examines the subscriber\'s ID.
If a node in its subtree is topologically closer to that subscriber ID,
the subscription is pushed down to that node. Over time, subscriptions
migrate toward nodes that are already close to the subscribers in DHT
space --- naturally aligning the Dendritic tree with the underlying
neuromorphic topology.

**5.3 Subscription Renewal and Self-Pruning**

Subscriptions are not permanent. Each subscriber must renew its
subscription on a regular interval (e.g., every hour). If a subscription
is not renewed, it is removed from the relay node\'s table.

This creates a self-pruning property. If a topic goes quiet --- few or
no new publishes, subscribers stop renewing --- the subscription tables
empty out from the leaves upward. Entire dendritic branches dissolve.
The tree shrinks back to match actual current demand. When demand surges
again, the tree regrows. This mirrors how the neuromorphic DHT
connections strengthen under traffic and weaken under inactivity.

**5.4 Publish Routing Through the Dendritic Tree**

When a publish event enters the Dendritic tree at any node (not
necessarily the root), the node propagates it toward the root, which
then fans it out through the full tree. Branch nodes know to push events
closer to the root if they arrive at a non-root position, ensuring the
full subscriber tree receives the event regardless of where the publish
originates.

**6. Redundancy and Fault Tolerance**

**6.1 Multiple Independent Dendritic Trees**

The simplest redundancy mechanism is to generate multiple topic IDs from
a single logical topic. For example:

-   topic_hash_1 = hash(topic + \"1\")

-   topic_hash_2 = hash(topic + \"2\")

-   topic_hash_3 = hash(topic + \"3\")

Each hash ID maps to a different node in the DHT, spawning a completely
independent Dendritic tree. Subscribers register with all N trees.
Publishers publish to all N trees. If one tree loses a branch or its
root, the other trees continue delivering messages. Redundancy can be
tuned per topic: N=1 for fire-and-forget, N=2 for standard reliability,
N=3 for critical topics.

**6.2 Root Node Self-Healing**

The root relay node --- the trunk of the Dendritic tree --- is the most
critical component. If it churns out, the tree is orphaned. The
self-healing mechanism works as follows:

-   Level 2 branch nodes detect that the root is no longer responding

-   Each Level 2 node re-subscribes to the topic hash ID through the DHT

-   The DHT routes the subscription to whichever node is now closest to
    that hash ID --- the natural new root candidate

-   A new root emerges organically from the DHT\'s own routing logic,
    with no explicit election or coordination protocol

This is equivalent to how DHT nodes self-heal after churn: the system
simply re-routes to the next closest node. The Dendritic tree
reconstructs not just leaves and branches, but its root structure ---
the whole tree is self-healing end to end.

**7. Pub/Sub as its Own Control Plane**

A key architectural insight is that the Dendritic tree-building and
load-shedding coordination is itself implemented using pub/sub messages.
When a relay node delegates subscriptions to a branch node, it publishes
a delegation message. When a node accepts delegated subscriptions, it
subscribes to that relay node\'s republish channel.

This means there is no separate control plane. The same Dendritic
infrastructure that carries application messages also carries the
infrastructure messages that grow, shrink, and repair the tree. The
system bootstraps and self-organizes through its own messaging fabric
--- pub/sub expanding the scope of pub/sub itself.

**8. Reputation and Node Trust**

The Dendritic tree\'s efficiency depends on reliable relay nodes. The
platform incorporates a reputation system that drives topology
positioning. See Document 03 (Reputation Metrics) and Document 06
(Reputation Mechanics) for full details. The key principles are:

-   Reputation is ephemeral --- nodes that go offline lose their
    reputation and must rebuild from scratch

-   New nodes are tested in parallel with established nodes --- fast
    integration of genuinely good nodes

-   Seven core metrics drive reputation: content value, relay
    efficiency, bandwidth contribution, uptime, topic relevance,
    load-shedding cooperation, and message honesty

-   High-reputation nodes are positioned as Dendritic hubs;
    low-reputation nodes drift to the periphery

-   Reputation is local --- each node observes only its direct
    neighbors, and global positioning emerges from aggregated local
    signals

**9. Tracker Coordination**

Layered on top of the neuromorphic DHT is an optional tracker
coordination framework that dramatically improves content discovery
efficiency --- analogous to how BitTorrent trackers improve peer
discovery over raw DHT lookups. See Document 02 (Tracker Coordination)
for full details. Key points:

-   Nodes announce what content they\'re storing, with metadata on
    capacity and bandwidth

-   Tracker queries return ranked peer lists based on geographic
    proximity, current load, and reliability

-   Tracker hints and neuromorphic rewiring reinforce each other ---
    popular content clusters toward demand automatically

-   Tracker state is itself stored and replicated in the DHT, avoiding
    centralization

**10. Scalability Properties**

-   Horizontal scaling: adding more DHT nodes automatically provides
    more Dendritic relay capacity

-   Demand-driven growth: Dendritic tree depth and breadth expand only
    as needed

-   Demand-driven pruning: unused branches dissolve, freeing resources

-   DHT-aligned placement: subscriptions migrate toward
    topologically-close nodes, reducing latency

-   No central coordinator: all decisions are local and emergent

-   Theoretical scale: a billion-user DHT with a million subscribers on
    a single topic is handled by distributing the Dendritic relay tree
    across available nodes

**11. Platform Applications**

The Neuromorphic Dendritic Platform is a general-purpose infrastructure
substrate. See Document 04 (Platform Applications) for detailed
coverage. Current target applications include:

-   Real-time messaging and group chat --- decentralized,
    censorship-resistant

-   Decentralized DNS --- no centralized registrar, low-latency
    resolution via S2 geographic variant

-   Microservice discovery --- reputation-driven, self-organizing
    service registry

-   IoT sensor networks --- scales to millions of sensors, self-pruning
    for dead sensors

-   Distributed logging and observability --- local processing,
    efficient fan-in

-   Machine learning model distribution --- demand-driven replication

-   Decentralized social networking --- community moderation via like,
    dislike, and code red signals (see Document 05)

-   Agentic collaboration infrastructure --- AI agent discovery, task
    routing, and capability-based reputation (see Document 07)

**12. Open Problems and Next Steps**

-   Redundancy coordination: ensuring N independent Dendritic trees do
    not re-converge onto the same nodes

-   Capacity signaling: how relay nodes advertise current load so
    delegation targets are chosen intelligently

-   Loop prevention: ensuring publish events do not cycle through the
    Dendritic tree

-   Reputation bootstrapping: calibrating warmup thresholds and parallel
    testing parameters

-   Namespace governance: how decentralized identity and topic ownership
    are established without a central registry

-   Implementation: mapping this architecture onto the existing
    neuromorphic DHT codebase in Claude Code

Neuromorphic Dendritic Platform --- Architecture Document v2.0 ---
Confidential

# Neuromorphic Dendritic Social Network Architecture

## Overview

A decentralized social network built on the neuromorphic dendritic platform eliminates centralized algorithmic control, puts content moderation in the hands of communities, and self-organizes around genuine user interest rather than engagement maximization.

---

## Core Concept: Users as Publishers, Topics as Follows

Each user publishes posts as a pub/sub topic in the DHT. Following someone is subscribing to their topic. The dendritic tree fans posts out to all followers. No central server decides what you see — the tree delivers what you've explicitly subscribed to.

Popular accounts naturally become hubs in the dendritic topology because many subscribers pull from them. The neuromorphic rewiring positions high-engagement publishers closer to their audience, reducing delivery latency organically.

---

## Content Signals: Like, Dislike, and Code Red

### Like
A positive signal indicating "I want more content like this." Likes increase the reputation of a publisher within a subscriber's local branch. Over time, liked publishers get better positioning in the dendritic tree — their content arrives faster and gets amplified through the local network.

### Dislike
A soft negative signal: "I don't prefer this content." Dislikes accumulate locally. If a subscriber consistently dislikes content from a publisher, the dendritic tree deprioritizes that publisher's content for that subscriber. No global effect — the same publisher might be highly liked in other branches. Dislikes are a preference refinement, not a censorship mechanism.

### Code Red
A hard negative signal: "I do not want this content, and I don't want my community to receive it either." Code red is distinct from dislike in several ways:

- **Scope**: Affects not just the individual subscriber but propagates as a signal through their local community branch
- **Threshold**: Requires accumulation from multiple users — a single code red doesn't quarantine content
- **Effect**: Content gets topologically isolated from branches where code reds accumulate. It remains accessible in branches where it's welcomed
- **Not deletion**: Code red doesn't remove content from the network. It redirects routing so the content stays in communities that want it

**Example**: Adult content receives code reds from a family-oriented community branch. That content is not routed to those subscribers. The same content continues flowing freely in branches where subscribers are opted in. The network self-segments without global censorship.

---

## Community Self-Moderation

The system is self-moderating through local preference signals:

1. **Organic bifurcation**: A controversial publisher splits communities naturally. Subscribers who like the content stay subscribed. Subscribers who dislike it drift away. No platform decision required.

2. **Code red quarantine**: Content deemed harmful by a community gets topologically isolated from that community. The dendritic tree routes around code-red-accumulated topics for those branches.

3. **No algorithmic amplification**: There is no engagement-maximizing algorithm. Content is delivered to subscribers who asked for it, nothing more. Outrage doesn't propagate further than willing audiences.

4. **Trending emerges naturally**: If many subscribers across many branches are receiving the same content, it's genuinely popular — not algorithmically boosted. Trending is an observation, not a product.

---

## Reputation in the Social Context

Publisher reputation is built from:

- **Subscription retention**: Do followers stay subscribed over time?
- **Like/dislike ratio**: Across the subscriber base, what's the balance?
- **Renewal rate**: Do subscribers actively renew subscriptions, or let them expire?
- **Amplification**: Do subscribers re-publish (repost) content, extending its reach?

Publishers with high reputation get better positioning in the dendritic topology — their posts reach followers faster. Publishers with low reputation drift to the periphery — their content still reaches willing subscribers, but with higher latency and less relay support.

---

## Trending Topics

A topic trends when:

- Many subscriptions to it are renewed simultaneously (organic interest spike)
- High amplification rates (many users reposting to their subscribers)
- Low dislike / code red accumulation (genuine rather than divisive)

Trending is computed locally within branches and aggregates upward through the dendritic tree. A topic may trend in one geographic or interest-based branch while remaining obscure in others — which is accurate to actual distributed human interest.

---

## The "Red Light District" Principle

Content that generates code reds across mainstream branches but is actively liked within niche branches gets topologically isolated into those niche branches. It doesn't disappear from the network — it clusters in branches where subscribers explicitly opt in. Accessing that content requires actively subscribing to topics in those branches.

This mirrors how communities naturally self-segregate around content preferences, without requiring platform administrators to make global decisions about what content is permissible.

---

## Anti-Spam and Bot Defense

Reputation mechanics naturally suppress spam:

- **New accounts start with zero reputation**: A fresh account's posts have no relay support. They reach direct subscribers only, with no amplification.
- **Spam accumulates dislikes and code reds**: As recipients signal negative feedback, the dendritic tree deprioritizes routing for that publisher.
- **Warmup period**: Accounts must build reputation through genuine engagement before gaining hub-level distribution
- **Sybil resistance**: Creating many fake accounts doesn't help — each starts at zero reputation and must earn distribution independently

---

## Comparison to Twitter/X

| Property | Twitter/X | Neuromorphic Social Network |
|----------|-----------|----------------------------|
| Content ranking | Algorithmic, engagement-maximized | Subscription-based, community-driven |
| Moderation | Centralized, policy-based | Distributed, preference-based |
| Trending | Algorithmically curated | Organically observed |
| Censorship | Platform can remove content | Community isolation only — no deletion |
| Amplification | Algorithm decides reach | Like/repost signals drive reach |
| Account trust | Verified badges, opaque | Reputation metrics, transparent |
| Data ownership | Centralized | Distributed across nodes |

---

## Open Design Questions

1. **Identity**: How are user identities established and verified without a central registry?
2. **Namespace**: How do you claim a unique username in a decentralized system?
3. **Content persistence**: Who stores old posts if the original publisher goes offline?
4. **Cross-branch discovery**: How do users in different branches find each other and new content?
5. **Code red governance**: Who decides the threshold for code red quarantine in a branch?

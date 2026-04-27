# Neuromorphic DHT — Technical Presentation Outline

**Version:** 0.1 (draft — name, chart production, slide prose pending)
**Target:** ~45 min + Q&A
**Audience:** Sophisticated technical — networking researchers and systems engineers. The deck should respect an audience that remembers CLNP, designed TCP/IP, or built OSPF. Minimal hand-holding; heavy on first-principles reasoning and measured claims.
**Final format:** PPTX or Google Slides (exported from markdown)

---

## Style guide

- **Declarative, measurable, no adjectives where a number will do.**
- Biological terminology is **compact vocabulary for specific mechanisms**, not decoration. Every term on every slide maps to a concrete data structure with defined behavior.
- **Prefer numbers to qualitative claims.** "5.4× faster" beats "significantly faster".
- **Analogies to networking primitives the audience already owns** (OSPF, BGP, AIMD, anycast, small-world overlays). Use them where they clarify.
- **Honest about limits.** Acknowledge costs (compute-per-hop, warmup dependency) in the same slide as the benefit.
- **No chartjunk.** Sans-serif, horizontal grid only, three-color ordinal palette (slate = Kademlia, amber = G-DHT, deep teal = N-DHT).

## Naming

- **First introduction:** *Neuromorphic DHT*.
- **All subsequent references:** *N-DHT*.
- When contrasting with the research prefix, use *NX-17 (N-DHT)* once in Section 8 (evolution timeline) and nowhere else.
- The pub/sub subsystem is *axonal pub/sub* (lower case). Not a separate brand.

## Data manifest

All numbers in this outline reference the canonical benchmark CSVs below. The chart-generation script (`charts/generate.py`) will read these directly.

| Short name | Path | Role |
|---|---|---|
| `wl_25k.csv` | `results/benchmark_2026-04-23T20-10-46.csv` | Web-limited, omniscient, K-DHT + G-DHT + N-DHT, full test suite |
| `unr_25k.csv` | `results/benchmark_2026-04-23T20-35-46.csv` | Unrestricted, omniscient, same three, full test suite |
| `omni_conv/` | `results/benchmark_2026-04-23T22-{13,14,17,22}*.csv` | Regional convergence omniscient (warmup 10/30/60/100) |
| `boot_conv/` | `results/benchmark_2026-04-23T22-{41,45,49,56}*.csv` | Regional convergence bootstrap (warmup 10/30/60/100) |
| `family/` | `results/benchmark_2026-04-23T06-*.csv` | Cross-family training (6 NX variants × 2 inits) |
| `discrete_churn/` | `results/benchmark_2026-04-23T04-*.csv` | Discrete-churn sweep (5 reps × 4 rates) |
| `pubsub_live.csv` | `results/pubsub-membership_latest.csv` | Live-sim cumulative delivery over continuous churn |

## Chart specs

All charts produced as SVG via `charts/generate.py`. Rendered 2× PNG fallback for tools that don't take SVG. Color palette defined in `charts/style.py`.

| ID | Title | Source | Type | Key message |
|---|---|---|---|---|
| C1 | Latency by radius — K/G (web-limited) | `wl_25k.csv` | Grouped bars | Kademlia is locality-blind; G-DHT halves regional latency |
| C2 | Lookup success under churn | 12-run family data | Bars with 100% line | NX-1 / NX-3 break under bootstrap; NX-6+ hold |
| C3 | Hops by radius — 3 protocols (WL) | `wl_25k.csv` | Grouped bars | N-DHT hops-competitive globally, dominant locally |
| C4 | Latency by radius — 3 protocols (WL) | `wl_25k.csv` | Grouped bars | N-DHT is 5.4× faster than K-DHT at 500 km |
| C5 | WL vs unrestricted | both CSVs | Paired grouped bars | All three improve; N-DHT retains lead |
| C6 | Cumulative delivery vs cumulative churn | `pubsub_live.csv` | Line | Replay cache keeps delivery >80% through 33% churn |
| C7 | Discrete-churn recovery w/ σ | `discrete_churn/` | Line + ±σ shading | Recovery is real and bounded; 3-round asymptote |
| C8 | Convergence curves — N-DHT both inits | `omni_conv/` + `boot_conv/` | Two-line convergence | Learning has a well-defined fixed point at ~4.25 hops |
| C9 | Realistic deployment bars (bootstrap warmup=100) | `boot_conv/` last | Grouped bars | N-DHT wins every column under realistic deployment |
| C10 | Per-hop compute cost decomposition | Derived from code | Stacked bars | N-DHT buys 5–7× latency win at 75× per-hop CPU |
| C11 | NX-1 → NX-17 evolution timeline | Hand-curated | Annotated timeline | What each version added, measured impact |

---

## Slide-by-slide

### Section 1 — Opening (3 slides)

**S1. Title**
- **Neuromorphic DHT** — A Learning-Adaptive Distributed Hash Table with Axonal Publish-Subscribe
- Author / date / repo / version (whitepaper v0.56)

**S2. Three gaps in current DHTs**
Motivate three unaddressed problems, each with one concrete number:
- **No locality.** Kademlia at 25 K routes a 500 km lookup in **355 ms**, no better than global.
- **Pub/sub is a bolt-on.** K-closest replication drifts under churn; publisher and subscriber compute different top-K sets.
- **Churn recovery is lazy.** Kademlia repairs on bucket-refresh timers; subscribers miss messages during the gap.

**S3. N-DHT in one slide**
- Adaptive routing: each node maintains a bounded table of weighted edges; edge weights reinforced by observed traffic.
- Locality encoded in IDs: 8-bit S2 cell prefix + 56-bit hash — routes follow geography without extra mechanism.
- Pub/sub as a routed tree: topics grow their own per-topic delivery trees, self-heal via re-subscription.
- **Headline numbers** (25 K nodes, realistic deployment: bootstrap init + 50K training lookups, web-connection cap):
  - Global lookup: **4.22 hops / 243 ms / 100% success**
  - Regional 500 km: **73 ms** — **7.3× faster than Kademlia** (536 ms)
  - 5% discrete churn: **100% lookup success / 95% immediate pub/sub delivery / 100% recovered**
  - Cumulative pub/sub delivery stays **>80% through 33% cumulative churn**

---

### Section 2 — The DHT Problem (4 slides)

**S4. The DHT contract**
- put(key, value), get(key) → value on an untrusted open P2P overlay
- The abstraction underneath: naming, content addressing, blockchains, pub/sub, decentralized databases
- "Correct" = O(log N) lookup, eventual consistency under churn, no central authority
- *Opening question:* what's the best we can do on this abstraction in 2026?

**S5. Kademlia distilled**
- XOR metric: d(a, b) = a ⊕ b; every node knows K peers per bucket
- Lookup: greedy walk toward target by XOR, α parallel queries, K = 20
- Completeness: under perfect conditions, O(log₂ N) hops
- Note: K-buckets were a 2002 answer to "what's a stable routing table?" — static, predictable, analyzable. We'll argue that adaptive weighting does better in practice.

**S6. Kademlia's structural limits** — four gaps, each measured:
- **No locality**: 500 km lookup = 355 ms (WL, 25K) — identical to global
- **Fixed buckets**: no response to traffic patterns; same K peers whether they're useful or not
- **Lazy churn repair**: broken edges persist until next bucket refresh (seconds-to-minutes in practice)
- **Broadcast cost**: O(audience), each recipient via independent lookup

**S7. G-DHT: locality helps, but alone is not enough**
- nodeId = S2 cell prefix (8 bits) || publicKey hash (56 bits)
- XOR routing in ID space → XOR in physical distance (prefix dominates)
- Regional latency: **128 ms at 500 km** (2.7× faster than Kademlia)
- But still a *static* routing algorithm — no learning dynamics
- **[C1]** Hops + latency by radius, K vs G

---

### Section 3 — The Simulator (2 slides)

**S8. The lab bench**
- Purpose-built simulator, ~25 K lines of JavaScript, open-source at `github.com/.../dht-sim`
- **Modelled with fidelity**: GeoJSON-backed land mask; haversine distances; up to 50 K nodes on navigable 3-D globe; per-hop 10 ms simulated delay composable across paths; message ordering, ACKs, reroute events captured
- **Abstracted**: no wall-clock transport, no encryption, no NAT; node identity is in-process
- **Reproducibility**: every protocol builds from the *same* seeded node set; CSV export; no hand-curated results
- Live time-series mode + scripted sweep API for cross-replicate statistics

**S9. Methodology**
- 500 lookups per test cell (global + 5 radii + source/dest pools + cross-continent)
- Warmup distinguishes *omniscient* init (theoretical ceiling — each node seeded with optimal K-closest neighbors) from *bootstrap* init (realistic sponsor-chain join)
- Churn induced discretely (instantaneous kill) or continuously (1% every 5 ticks)
- Success = surviving subscribers receive the message; dead subscribers excluded from denominator
- All three protocols tested on the **same node geometry** — direct comparison, not independent builds

---

### Section 4 — The Neuromorphic Core (10 slides)

**S10. Naming as vocabulary**
- Four terms from neuroscience, each mapping to a specific data structure:
  - **Synapse** = one directed routing edge with a learned weight ∈ [0, 1]
  - **Synaptome** = the full set of synapses at a node; bounded at 50 (matches WebRTC's ~50 peer limit)
  - **Neuron** = a node, carrying a synaptome + temperature + handlers
  - **Axon** = a directed delivery tree for one pub/sub topic, grown by routed subscribe
- Vocabulary choice, not ideology. Behavior does not depend on the biology.

**S11. The synaptome**
- Each synapse: `{peerId, weight, inertia, stratum, latency, lastUsed}`
- **Weight** is the learned signal: reinforced on use (+δ), decayed on idle (×γ per tick)
- **Inertia** protects newly-added synapses (young edges can't be evicted)
- Capacity 50 is binding. Adding a 51st evicts the lowest-vitality existing synapse.

**S12. Action Potential routing**
- Per-hop decision: pick synapse maximizing `AP = (progress / latency) × (1 + w × weight)`
- Analogue: OSPF shortest-path + weighted-edge reinforcement. Progress is immediate XOR improvement; weight biases toward recently-useful peers; latency normalizes for link cost.
- **Two-hop lookahead**: top α=5 first-hop candidates get a second-hop probe; pick the pair with best combined AP. Mitigates greedy local minima without the cost of full iterative deepening.

**S13. LTP — additive reinforcement**
- Long-Term Potentiation: every successful hop reinforces the used synapse by +δ
- Analogue: **TCP AIMD, applied to the routing graph**. Successful delivery → +δ additive; passive decay → ×γ multiplicative.
- Inertia window (20 epochs default) prevents young synapses from being evicted by their own not-yet-strengthened weight
- Net effect: frequently-used routes accumulate weight; cold routes decay; the synaptome tracks actual traffic patterns

**S14. Decay, annealing, exploration**
- **Decay γ = 0.995 per tick** across all weights. Use-it-or-lose-it regularization.
- **Annealing**: periodically, a probabilistic draw replaces the lowest-weight synapse with a 2-hop-neighborhood candidate. Temperature controls intensity; cools over time.
- Analogue: **simulated annealing as background exploration pressure** on the routing graph — prevents local optima from ossifying

**S15. Incoming-synapse promotion**
- Passive observation: every time another node routes *through* me, I record them in an incoming set
- After N transits, incoming peers get promoted to full outgoing synapses
- **Reciprocity discovery** falling out of routing traffic — no explicit messaging
- Closes the feedback loop: traffic patterns inform the routing graph in both directions

**S16. Churn mechanisms**
- **Dead-peer eviction**: liveness check fails → synapse evicted; replacement drawn from 2-hop neighborhood
- **Iterative fallback**: if no greedy candidate makes progress, fall back to Kademlia-style "closest unvisited" — prevents dead-end failures
- **Temperature reheat**: dead-peer discovery spikes the local annealing temperature, accelerating repair
- **[C2]** Lookup success across NX family under bootstrap — shows the reliability floor established at NX-6

**S17. Diversified bootstrap (80/20)**
- Sponsor-chain join alone produces locality-biased synaptomes
- Fix: 80% stratified by XOR distance + **20% random global peers**
- The 20% random seeds annealing with diverse long-range candidates — otherwise annealing can only see 2-hop-local peers (and the "asymptote" sits higher)
- Analogue: **Watts-Strogatz small-world** — a small fraction of long-range edges collapses expected path length

**S18. Per-hop compute cost — the honest trade-off**
- Per hop, N-DHT evaluates:
  - Sort candidates by AP₁ score: O(N log N), N ≤ 50
  - Top α=5 probed for 2-hop lookahead: each expands ≤ 50 synapses, runs a second sort
- **≈ 1,500 ops / hop, vs Kademlia ~ 20 ops / hop. ~75× more CPU per hop.**
- Trade-off accepted: the expensive decision produces shorter paths AND lower latency per lookup; simulated wall-clock is dominated by the network model, not compute
- **[C10]** Decomposed compute cost diagram
- Optimization room noted (top-K heap vs full sort, last-hop shortcut, AP memoization) — current numbers are with the unoptimized baseline

**S19. End-to-end tick — one lookup in real time**
- Sequence diagram showing:
  1. AP-score all synaptome candidates (with 2-hop probe)
  2. Pick best, send message
  3. On arrival: LTP-reinforce the used synapse
  4. Periodic: decay all weights, anneal a replacement, check for dead peers

---

### Section 5 — Comparison (4 slides)

**S20. Point-to-point: hops by radius (web-limited)**
- **[C3]** Grouped bars
- Table:
  | Radius | Kademlia | G-DHT | **N-DHT** |
  |---|---|---|---|
  | Global | 3.43 | 4.67 | **3.64** |
  | 500 km | 3.39 | 3.98 | **2.21** |
  | 2000 km | 3.41 | 4.08 | **2.73** |
  | 10% → 10% | 2.58 | 3.55 | **1.05** |

**S21. Point-to-point: latency by radius (web-limited)**
- **[C4]** Grouped bars
- Table:
  | Radius | Kademlia | G-DHT | **N-DHT** | vs K-DHT |
  |---|---|---|---|---|
  | Global | 357 | 289 | **260** | 1.4× |
  | 500 km | 355 | 128 | **66** | **5.4×** |
  | 2000 km | 348 | 154 | **94** | 3.7× |
  | 10% → 10% | 231 | 109 | **32** | **7.2×** |

**S22. Realistic deployment — bootstrap + training**
- Omniscient is useful for isolating protocol effects but **unreachable in production**.
- Under realistic bootstrap init + 50K training lookups:
  | | Kademlia | G-DHT | **N-DHT** |
  |---|---|---|---|
  | Global hops | 4.70 | 5.65 | **4.22** |
  | Global ms | 536 | 318 | **243** |
  | 2000 km ms | 521 | 187 | **92** |
  | Global success | 98.4% | 99.4% | **100%** |
- **[C9]** Bar chart: N-DHT wins every column; **margins larger** than in the omniscient comparison because K-DHT and G-DHT cannot recover the bootstrap penalty

**S23. Unrestricted: scaling beyond the browser**
- Same experiment, connection cap lifted
- **[C5]** WL-vs-∞ paired bars
- Headline numbers (N-DHT, omniscient): **2.72 hops / 46 ms at 500 km / 30 ms on source-dest pool**
- Gap between WL and ∞: -20% hops, -25% latency for N-DHT. All three protocols improve; N-DHT improves most.

---

### Section 6 — Learning Dynamics (2 slides)

**S24. Convergence curves — learning has a fixed point**
- **[C8]** Two lines on the same chart:
  - Omniscient-init: **3.49 → 4.50** hops over 50K training lookups (drifts UP)
  - Bootstrap-init: **4.35 → 4.22** hops over 50K training lookups (drifts DOWN)
- Both converge to ~4.2–4.3 hops, independent of starting condition
- K-DHT and G-DHT (control) are flat across the entire range — no learning dynamics
- The protocol has a **well-defined learning fixed point** as a property of traffic pattern + synaptome mechanics

**S25. What training does and doesn't do (§6.11)**
- Training **redistributes weight** within the fixed-capacity synaptome; it does not discover new short edges that sponsor-chains missed at join time
- Bootstrap + training → latency improves monotonically (–14% at 2000 km) because per-hop compute prunes
- Training is **compute-optimizing, not primarily path-shortening**
- The real lever for bootstrap routing quality is the **initial synaptome construction** (diversified bootstrap, future: global-pool annealing)
- This is an honest limit, not a defect

---

### Section 7 — Axonal Pub/Sub (7 slides)

**S26. Why pub/sub on DHTs is hard**
- K-closest approach: subscribe STOREs at each of K nodes closest to hash(topic); publish hits any one
- Under churn, publisher and subscriber compute `findKClosest` from different positions → top-K drift → delivery drops
- In our NX-15 lineage at 25% churn: **~38% recovered delivery**. Direct motivation for redesign.

**S27. Publisher-prefix topic IDs**
- Topic ID = `publisher.cellPrefix (8 bits) || hash₅₆(event_name)`
- Convention: `@XX/domain/event` where XX is hex of publisher's cell prefix
- Both publisher and every subscriber derive the **same topic ID deterministically** — no cross-party disagreement
- Topics anchor in the publisher's cell; well-trained from publisher's own lookup traffic

**S28. The axonal tree**
- Subscribe = routed message toward topicId; first live "axon role" on the path intercepts and adds subscriber to its children
- If no axon exists, the terminal node (`findKClosest(topicId, 1)`) opens a role and becomes root
- Publish at root → fan-out to children via direct 1-hop sends → recursive through sub-axons
- **Single root per topic. No K-closest replication. No gossip.**

**S29. Batch adoption on overflow**
- Axon hits 50 direct children (maxDirectSubs) → needs to offload
- Pick an external synaptome peer as a new sub-axon relay
- Partition children by XOR-proximity to the new relay; hand off the closest batch in a single `pubsub:adopt-subscribers` message
- **Invariants preventing cascades:**
  - Partition always non-empty (top-K guaranteed)
  - Parent pre-adds the new relay as its own child; relay's self-subscribe loopback is idempotent

**S30. Self-healing via re-subscribe**
- **No parentId tracking**. Every role re-issues a subscribe on its refresh interval (10 s default).
- Non-root axon's refresh re-attaches to whichever live axon its walk lands on — parent reorganizations are invisible
- Root superseded by newly-joined closer peer hands off via the globality check
- **The re-subscribe *is* the liveness check** — no separate ping RPC

**S31. Replay cache**
- Every relay keeps a bounded ring buffer: `[{json, publishId, publishTs}, …]`, capacity 100
- Every outgoing subscribe carries `lastSeenTs` — the highest publishTs the subscriber has observed
- On subscribe arrival, the axon filters its cache to `publishTs > lastSeenTs` and replays as a single batched message
- Analogue: **anycast with bounded local history** — closest live relay serves missed messages without a central log

**S32. Live-simulation results**
- 25 K nodes, 79 groups × 32 subscribers, 1% churn every 5 ticks, 200+ ticks
- **[C6]** Cumulative delivery curve
- Key points:
  - 5% cumulative churn: immediate 98.7%, cumulative 99.7%
  - 25% cumulative churn: immediate 68%, **cumulative 88%** — replay rescues 20 pp
  - 33% cumulative churn: cumulative still **> 80%**

---

### Section 8 — Churn Resilience (2 slides)

**S33. Discrete-churn benchmark**
- Instantaneous kill at target rate; measure baseline/immediate/recovered with refresh rounds between
- N = 5 replicates per rate, fresh DHT per trial
- **[C7]** Recovery curve with ±σ shading
- Table:
  | Churn rate | Immediate | **Recovered (3 rounds)** |
  |---|---|---|
  | 5% | 86.3 ± 4.0% | **90.0 ± 3.5%** |
  | 10% | 76.3 ± 6.0% | **83.2 ± 4.4%** |
  | 15% | 62.3 ± 3.7% | **71.2 ± 2.9%** |
  | 25% | 51.2 ± 5.3% | **62.2 ± 4.1%** |

**S34. Three refresh rounds is the asymptote**
- Compared recovered at 3 vs 10 rounds across all four rates
- Difference ≤ 1.7 pp everywhere; within replicate σ
- K-set stability *identical* between 3- and 10-round measurements — tree has healed as far as it will
- **Additional refresh rounds do not recover more delivery.** The honest floor is K-set drift survival.

---

### Section 9 — Analysis (2 slides)

**S35. Known limitations**
- **Warmup dependency**: N-DHT needs ~5000 lookups before the synaptome converges — first minute of deployment is suboptimal
- **Synaptome capacity as bottleneck**: 50 is a WebRTC constraint, not a principled choice; server deployments could benefit from larger synaptomes
- **Forwarder loss edge cases**: axon relay dying mid-fan-out → its subtree silent until refresh (survivable, 100% eventual delivery via replay, not instantaneous)
- **Training is compute-optimizing, not path-shortening** — the §6.11 finding

**S36. Future directions**
- **Global-pool annealing**: periodically sample annealing candidates from the global pool rather than 2-hop-local → should close the bootstrap→omniscient gap
- **Adaptive synaptome capacity**: bump capacity during join-heavy periods, prune in steady state
- **Proof-of-location**: today the 8-bit S2 prefix is self-declared; a verifiable location primitive prevents prefix-forgery
- **Larger-scale evaluation**: 100K / 250K / 1M nodes; preliminary 50K data exists, larger runs need server-side simulation

---

### Section 10 — Production Considerations (3 slides)

**S37. Transport layer**
- Transport-agnostic by design
- **WebRTC** (browser-native): ~50 peers, NAT-traversing, DTLS-encrypted, signalling required
- **QUIC / TCP** (servers): unlimited, lower overhead
- **WebSocket relay** (fallback): universal reachability, higher latency
- Identity: Ed25519 keypair; `nodeId = cellPrefix || H(pubkey)`; every control message signed

**S38. Message protocol**
- Common envelope: version, type, sender, signature, timestamp, nonce, payload
- Types: PING/PONG, FIND_NODE, ROUTE, SUBSCRIBE, PUBLISH, UNSUBSCRIBE (+ direct-delivery variants for axonal pub/sub)
- Routing is stateless in the protocol; all state is per-node (synaptome + axon roles)
- Back-pressure: recipient may return ROUTE_DEFER if saturated (design, not yet measured)

**S39. Deployment considerations**
- Trust model: no central authority; public-key signatures authenticate peers
- Sybil resistance: S2 cell prefix lightly discourages sybil swarms per-cell, not full defense — proof-of-location or join-PoW recommended
- Provisioning: bootstrap via small published sponsor set; fully decentralized thereafter
- Observability: nodes export local stats (synaptome health, LTP rate, role counts) for operator overlays

---

### Section 11 — Close (4 slides)

**S40. Key takeaways**
1. Adaptive routing + learned-weight edges reduce regional latency by **5–7×** vs Kademlia, with no correctness loss
2. Publisher-prefix topic IDs + axonal trees give **100%-delivery** pub/sub in steady state; replay cache extends to **>80%** delivery under 33% cumulative churn
3. **Under realistic bootstrap deployment, N-DHT's lead widens** — K-DHT and G-DHT inherit permanent bootstrap penalties (+37% and +21% hops respectively); N-DHT's learning converges around it
4. The protocol has a **well-defined learning fixed point** at ~4.2 hops, independent of starting condition
5. All measured at 25K nodes under the web-connection cap — the realistic deployment scenario

**S41. NX-1 → NX-17 evolution timeline**
- **[C11]** Horizontal timeline with annotations per version
- What each version added; measured impact on hops/success/delivery

**S42. References**
- Whitepaper — `Neuromorphic-DHT-Architecture.md` v0.56
- Github repo — full simulator + benchmarks + research log
- Related work:
  - Kademlia — Maymounkov & Mazières (2002)
  - Pastry, Tapestry — related prefix-based DHTs
  - Small-world networks — Watts & Strogatz (1998)
  - Hebbian learning — Hebb (1949)
  - S2 geometry — Google (2011)

**S43. Q&A**

---

## Production checklist

- [ ] Finalize name (placeholder: N-DHT)
- [ ] Write `charts/generate.py` with shared style stylesheet
- [ ] Generate all 11 charts as SVG
- [ ] Render each slide as a markdown file under `slides/` for precise typography control
- [ ] Build export script (`Marp` or `Pandoc` → PPTX)
- [ ] Proof all numbers against source CSVs (automated — script vs. manual copy)
- [ ] Two peer reviewers on tone/precision before locking
- [ ] Speaker notes per slide (in `slides/*.md` YAML front matter)

## Open questions

- **Title wording?** Current draft: "Neuromorphic DHT — A Learning-Adaptive Distributed Hash Table with Axonal Publish-Subscribe". Consider: does "Learning-Adaptive" add value, or redundant with "Neuromorphic"?
- **Slide 3 headline numbers** — lead with bootstrap numbers (realistic) or omniscient (ceiling)? Draft uses bootstrap. Easier to defend to this audience.
- **Chart C10 (compute cost)**: include as a main-deck slide or move to backup? Argument for main deck: the audience will wonder about the complexity cost of the 2-hop lookahead. Argument for backup: it's self-critical and might seed nitpicking. *Recommend: main deck, it earns trust.*
- **Section 8 (Churn)** at 2 slides vs 3 — is the discrete-churn + asymptote coverage enough, or do we need a dedicated comparison-to-alternatives slide? *Current 2-slide plan feels right.*

---

## Drafting order (when we start building)

1. Chart generator + style (1 session) — data is frozen, script is self-contained
2. Slides S1–S3 + S40–S42 (opening + closing, ~1 session) — frames everything
3. Slides S8–S9 (simulator) — methodology early
4. Slides S20–S23 (comparison) — the measured punchline
5. Slides S10–S19 (core) — the mechanism
6. Slides S26–S32 (pub/sub) — the second-half story
7. Slides S4–S7 (motivation), S24–S25 (training), S33–S34 (churn), S35–S36 (limits), S37–S39 (production)
8. Polish pass: speaker notes, transitions, proofreading

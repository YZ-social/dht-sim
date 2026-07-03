# W2 — Bridge bootstrap-nursery: sim experiment scope

**Question the experiment must answer:** when the bridge stops introducing every
peer (today's uncapped peer-list) and instead introduces each newcomer to only
**k curated anchors**, does the newcomer still reach a **full synaptome** and
become **reachable from the mesh** — at scale, under churn/rejoin — or does it
strand?

If yes, we build the nursery into `axona-bridge` (W2 proper). If no, or only
above some k, the sim tells us the threshold before we touch production.

---

## Why the default sim path can't answer this

The headline benchmarks build the mesh with `buildRoutingTables` (god's-eye XOR
seat — global knowledge places every node in its neighbours' tables). That is
the *right* tool for steady-state routing latency and the *wrong* tool here: it
bypasses admission entirely, so it would seat every newcomer regardless of the
bridge and mask the whole effect. The experiment must run on the
**bootstrap-only substrate**: the *only* way into the mesh is a bridge
introduction + self-expansion.

The faithful primitive already exists — `bootstrapJoin(newId, sponsorId)`
(real `simTransport` channels, iterative XOR-closest walk, respects `tryConnect`
+ `MAX_SYNAPTOME`) — and `benchBootstrap` mode builds a whole network from it.
It models **single-sponsor** churn replacement. W2 needs the **anchor-set**
generalization + a bridge-policy layer on top.

---

## Build

### B1 — `bridgeIntroduce(newId, anchorIds[])`  (engine, ~½ day)
Generalize `bootstrapJoin`: seed the iterative-lookup shortlist from **k anchors**
instead of one sponsor (k=1 reproduces `bootstrapJoin` exactly, so it stays a
regression baseline). Everything downstream — `addPeer`, `iterLookup`, the
bilateral cap, transport channel open — is unchanged. Returns `joinReach`.

### B2 — `BridgeNursery` policy model  (harness, ~1 day)
Plain JS in the harness (NOT kernel — it models the bridge *policy* we'd later
port into `axona-bridge`). Responsibilities:

- **Composite anchor-eligibility score** (a blend, never a single signal — a lone
  metric is gameable and blind to outcomes):
    `score = w_up·uptime + w_deg·degree + w_in·inboundDegree + w_hist·integrationSuccess`
  - **uptime** — longevity as a stability proxy (also the hard gate: a node must
    survive `minUptime` before it is anchor-eligible at all; a fresh joiner never
    anchors).
  - **degree** — outbound synaptome fill / cap (well-connected).
  - **inboundDegree** — incoming synapses / cap. This is the connectivity that
    actually matters for *introducing* — how many peers already route through it
    (B1 finding: reachability lives in inbound refs).
  - **integrationSuccess** — *outcome-based track record*: a smoothed success rate
    `(successes + α)/(attempts + α + β)` over the newcomers this node was an anchor
    for. Each introduction records an attempt against its anchors; when a newcomer
    later **graduates**, its anchors are credited a success. Rewards proven
    introducers and self-corrects (an anchor that looks connected but fails to
    integrate newcomers loses score). α/β keep unproven anchors neutral, not zero.
  - Weights are configurable so B5 can sweep profiles; default: equal-ish, with
    inboundDegree + integrationSuccess weighted slightly higher (they're the two
    that most directly predict a good introduction).
- **`pickAnchors(newId, k)`** → the top-scoring *eligible* nodes, chosen for
  **keyspace diversity** (spread across strata, not the k closest, so the newcomer
  gets footholds in different regions), never itself, all currently healthy.
  Records an attempt against each chosen anchor.
- **Admission budget + graduation:** the bridge keeps room for newcomers; a
  newcomer *graduates* once it clears the stability bar (synaptome fill ≥ threshold
  AND inbound-refs ≥ k), at which point (a) its anchors are credited an integration
  success and (b) it becomes anchor-eligible itself once past `minUptime`. This is
  the "two-tier disconnect but keep as introduction" behaviour, modelled as pool
  membership + credit rather than live connections.

### B3 — Bootstrap-only harness `harness/nursery-experiment.mjs`  (~1 day)
- Genesis: seed a small stable core (the first anchors).
- Grow to N purely via `nursery.pickAnchors` → `engine.bridgeIntroduce` — **no
  `buildRoutingTables` call anywhere.**
- Drive organic growth with explicit `refreshTick` rounds (the sim's deterministic
  stand-in for production's per-peer refresh timer).
- Inject **churn + rejoin** (rejoin is the important axis — a returning node is a
  fresh introduction each time).

### B4 — Metrics + analyzer  (~½ day)
Per newcomer and aggregate:
- **Synaptome fill** — final degree vs `MAX_SYNAPTOME` (the target).
- **Inbound reachability** — measured **structurally**: how many other live nodes
  reference the newcomer's id in their `synaptome`/`incomingSynapses`. This is the
  honest "reachability lives in a newcomer's neighbours' tables" metric (0 when
  isolated, grows with integration). **Do NOT use `eng.lookup()` as the
  reachability probe** — B1 verification proved it's unfaithful two ways: the sim
  transport's final hop can dial *any* registered node (god's-eye), so a lookup
  "reaches" even a 0-ref isolated node; and the probe itself *contaminates* state
  by causing edges to be recorded. Structural ref-counting is deterministic and
  artifact-free.
- **Rounds-to-converge** — refreshTicks until fill + reachability cross the bar.
- **Bridge-vs-mesh introduction share** — fraction of a newcomer's final synapses
  that came from the k anchors vs from mesh self-expansion. (The W1 metric, now in
  sim. We *want* this to fall as the mesh does the work.)
- **Anchor concentration / eclipse exposure** — how concentrated newcomer
  first-contacts are on the anchor pool (a small pool serving everyone is an
  eclipse surface).

### B5 — Sweep + baselines  (harness config)
Three arms, so "curated-k is enough" is a *measured* claim not an assertion:
- **A · god's-eye** (`buildRoutingTables`) — upper bound / ceiling.
- **B · single random sponsor** (`bridgeIntroduce` k=1, random anchor) — floor.
- **C · curated k anchors** (W2) — the candidate.

Axes: **k** ∈ {1,2,3,5}; **N** ∈ {500, 2k, 5k, 25k}; **rejoin churn** ∈ {0, 10, 20}%;
**anchor quality** {random vs eligibility-scored}. Methodology guardrail (hard
rule from prior sim work): **REPS ≥ 5, report mean ± sd** — single-seed fill /
reachability is noise.

**Total: ~3 days** of harness work on an existing, real foundation.

### Greenlight criterion (what result builds W2 in the bridge)
Curated **k=3** reaches **≥ 95% of god's-eye synaptome fill** and **≥ 99% inbound
reachability** at **N=5k under 20% rejoin churn** (mean over ≥5 seeds), with
**mesh self-expansion supplying the majority** of each newcomer's synapses (bridge
share falls with N) and **anchor concentration** below an eclipse threshold we set
in B4. Miss it → the sim has told us k, pool size, or the self-expansion path
needs work *before* production, which is the point.

---

## Expected capability — what this experiment can and cannot tell us

### CAN validate (this is a good sim question)
- **The topological claim:** k-anchor seeding + self-expansion reaches full
  synaptome + inbound reachability at scale. This is a graph/routing-convergence
  question on the *same* substrate that validated routing to 50k.
- **The k threshold** — the minimum anchor count for reliable integration, and how
  pool size trades against eclipse concentration.
- **The comparative result** — curated-k vs random-sponsor vs god's-eye ceiling
  (how much curation buys, how close to the ceiling k=3 gets).
- **Churn/rejoin robustness at scale** — thousands of rejoining nodes, far past
  real-WebRTC's ~12-peer ceiling.
- **That the bridge sheds the introducer role** — self-expansion share rising with
  N is the core efficiency claim, and it's directly measurable here.

### CANNOT validate (must carry to WebRTC / testnet)
- **Real signaling timing / ICE / connection setup.** `simTransport.openConnection`
  always succeeds instantly; real bridges have setup latency, ICE failures, and the
  "broken-but-authentic" failure mode. **The sim has hidden exactly this class of
  bug before** (live pub/sub flake that SimTransport's instant delivery masked) —
  so a green sim is necessary, not sufficient.
- **Wall-clock convergence.** Rounds-to-converge is in *driven refreshTicks*, not
  seconds. Whether a real newcomer fills fast enough before the app/user gives up
  is a live-timing question.
- **Bridge admission-budget dynamics under real connection churn** — modelled as
  pool membership here, not live WS/WebRTC connection pressure.
- **Adversarial anchor capture** — the sim measures *structural* eclipse exposure
  (concentration); it does not model a real attacker gaming gossip/PoW-gated
  anchor eligibility.

### The decision this informs
The sim is the **de-risking gate for the topological premise** of W2 — "bounded
introduction + mesh self-expansion actually integrates a node." It is explicitly
**not** the sign-off. A green result greenlights the `axona-bridge` build; the
live sign-off is the **WebRTC/testnet signaling-split re-measure (W1c)** on the
real nursery — which closes the loop back to the metric W1a/W1b already built.

Encouraging prior: the 4.17.1 cross-region fix proved the iterative `lookup()`
reliably hops the mesh across the full keyspace — that *is* the self-expansion
machinery this experiment leans on, so the premise starts from a better place than
before the incident.

# Pub/Sub Churn Test Suite

Scale + robustness-under-churn harness for the **real-kernel Axon tree**. One
topic = one tree. Drives the shipped `@axona/protocol` `AxonaPeer` pub/sub over
the kernel `SimNetwork`, with **fast sim identities** (no Ed25519 keygen) so
50k-node meshes build in seconds and replacement churn is cheap.

## Files
- `lib/axon-mesh.mjs` — mesh primitives: build, replacement churn, targeted
  re-wire/maintain, subscribe/publish, axon-tree introspection.
- `pubsub-churn-suite.mjs` — the scenario driver (one run → one JSONL record).
- `churn-matrix.sh` — unattended matrix driver (nohup + caffeinate).
- `churn-suite-analyze.mjs` — reads the JSONL, prints a scenario table + flags.

## Continuous-warmup, reused-network model
The mesh is built + trained **once** and **reused across every round** (never torn
down between rounds) — a single long-lived network experiencing continuous churn,
like the real world. **Warmup is continuous**: every action is followed by a warm
cycle, and we warm before every measurement ("when in doubt, warm it up"). A warm
cycle = **training lookups** (grow long-range synapses → keep the mesh globally
navigable) + **refresh ticks** (heal the tree: re-home subs, re-recruit relays).

A churn **event** of `CHURN_PCT` is applied **incrementally** — `CHURN_STEP%` at a
time, each slice followed by a warm cycle (e.g. 5% = `1% + warm` ×5). Replacement
churn keeps **N** and the **SUBS cohort** constant (churned subs → new subscribers).

### Per round
1. **probe** — publish an in-flight message just before the churn event; measure
   immediately → `probe.coldPct` (the disruption a message sees mid-churn).
2. **incremental churn** — `{ churn CHURN_STEP% → warmCycle }` × (PCT/STEP).
3. **warmCycle** — warm before measuring.
4. **recovered** — re-check the probe → `probe.recoveredPct` (deferred / replay
   arrivals during the churn + heal).
5. **warm** — converged steady-state delivery (series across refresh cycles) → the
   headline "does delivery hold under continuous churn" metric.

## Churn modes (`CHURN_MODE`)
- `global` — remove P% of **all N** nodes (random).
- `relay`  — remove P% of the tree's current **sub-axon relays**.
- `root`   — remove P% (default 100) of the tree's current **root set**.

## Metrics (per round, in the JSONL)
- delivery: `cold.pct`, `recovered.pct` (of cold-missed), `warm.pct`
- tree: `depth`, `maxFanout`, `medianFanout`, `roots`, `rootsInTrue`,
  `spuriousRoots`, `subaxons`, `attachedSubs`, `orphanSubs`, `density`
- Per scenario the driver emits `summary` = mean±sd across reps × post-churn rounds.

## Run one scenario
```
N=2000 SUBS=1000 PUBS=1 CHURN_MODE=global CHURN_PCT=20 ROUNDS=3 REPS=3 \
  node harness/pubsub-churn-suite.mjs
```
Key env: `N SUBS PUBS CHURN_MODE CHURN_PCT ROUNDS REPS WARMUP_MS HASH_BITS K
RENEW SETTLE COLD_MS WARM_SERIES WARM_GAP SPREAD OUT LABEL`.

- `SPREAD=0` (default) — single region: clean tree-robustness model, ~100%
  baseline. `SPREAD=1` also exercises the (separate) cross-region greedy-strand
  path, which currently caps delivery well below 100% even with no churn.
- `HASH_BITS=64` (default) — shrunk keyspace (72-bit ids) for scale. `256` =
  production width (slow: real keygen per node).
- `RENEW` — subscriber re-home gate (ms). The orphan window after a root change.

## Run the matrix unattended (hybrid loop)
```
nohup caffeinate -is bash harness/churn-matrix.sh > results/churn/matrix.log 2>&1 &
```
Defaults: `N=50000`, modes `global relay root`, pcts `10 20 30`, `SUBS=1000`,
`REPS=5`, `ROUNDS=5` → `results/churn/matrix.jsonl`. Override any via env.
Claude analyzes the JSONL and steers (adds bisecting pcts where a metric breaks).

## Analyze
```
node harness/churn-suite-analyze.mjs results/churn/matrix.jsonl
```
Flags `WARM<99` (steady-state gap) and `RECOV<80` (deferred-delivery/replay leak).

## Notes / known
- The single-region tree converges to ~100% pre-churn; `relay`/`root` churn only
  has victims once the tree is multi-tier (needs ~1000+ subs to recruit many
  sub-axons). At small SUBS the tree is a near-flat star and relay/root rounds
  may find few/no victims.
- **`SPREAD=1` (global) REQUIRES `WARMUP_LOOKUPS`.** A freshly-wired static-K mesh
  is NOT globally navigable: cross-region routing needs the long-range "highway"
  synapses that LTP learning grows through lookups (the headline benchmark trains
  with ~10k warmup lookups before measuring). **Proven:** globally-spread N=1500,
  no churn — untrained delivers **64.5%**, trained (`WARMUP_LOOKUPS=12000`)
  delivers **100%**. So set `WARMUP_LOOKUPS` (≈8–10×N) for any `SPREAD=1` run, or
  the suite under-measures global delivery. There is **no regional/keyspace bias**
  and no axon-model locality bias — the gap is purely an untrained-mesh artifact.
  `SPREAD=0` (single basin) doesn't need warmup. The `ITER_ROOT=1` flag (route
  pub/sub root resolution through the iterative network `findKClosest` instead of
  the local-only one) is a diagnostic only — it makes no difference once trained.
- diag: `node harness/diag-region-bias.mjs` (env `WARMUP_LOOKUPS`) compares
  local-only vs iterative vs base-`lookup()` reach to the true cross-region root.

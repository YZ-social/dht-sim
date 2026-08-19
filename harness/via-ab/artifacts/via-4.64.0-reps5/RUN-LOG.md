# via-hint removal A/B — replicated (REPS=5) run log & immutable artifacts

Subject: subscribe `via`-hint removal, kernel **4.64.0** (off) vs **4.63.0** (on).
Published for the council empirical gate (Aster seq 1435). These files are the
raw evidence behind the aggregate posted to #council (msgId b59a3657); commit
them and cite the SHA so the statistics can be re-derived and no row can be
silently suppressed.

## Immutable inputs
- Kernel **off** arm (4.64.0, hint removed): `axona-protocol` HEAD `494fbd6`.
- Kernel **on** arm (4.63.0, hint kept): `axona-protocol` `e5e1fb6`.
  The A/B toggles ONLY these 3 files between the two revisions:
  `src/pubsub/AxonaManager.js`, `src/pubsub/rootElection.js`, `src/dht/AxonaPeer.js`.
- Harness: `dht-sim` this commit — `harness/pubsub-churn-ab.mjs` (frozen plan),
  `harness/lib/seeded-scenario.mjs`, `harness/lib/axon-mesh.mjs`,
  `harness/via-ab/churn-ab.sh` (REPS driver + watchdog).
- Params: `N=300 SUBS=200 PUBS=1 CHURN_PCT=20 CHURN_STEP=5 ROUNDS=3 K=20 HASH_BITS=64 REPS=5`.
  Scope: CHURN_MODE=global, spread=0.

## Design (why these files prove a paired comparison, not two noise draws)
Each seed's scenario is **frozen before any peer is built** — node identity bytes,
publisher/subscriber selection, and the ordered per-round victim+replacement
sequence — then replayed. `planFp` (canonical plan hash) and `execFp` (hash of the
ACTUAL nodeIds that ran, in order, never sorted) are therefore **constant across
all 5 reps and both arms** of a seed. Only the kernel's intentionally-unseeded
delivery/timing randomness (writeFlight attemptId, handshake nonce, routing
tie-breaks) varies — which is exactly what REPS samples. The driver excludes a
seed unless every one of its runs shares one planFp and one execFp and exits 0.

## Files
- `summary_all8.tsv` — the 80 raw arm×rep rows (8 seeds × 5 reps × 2 arms). Columns:
  `seed  rep  arm  exit  planFp  execFp  warm  cold  recovered`.
  sha256 = `cff51f073325beb311a73c89c64af69c9eb6338042ba25215a88dae0a10788cc`.
- `per-seed-jsonl/seed<N>-<arm>.jsonl` — 5 lines each (one per rep); every line
  carries planFp, execFp, the per-round delivery rows, and the FULL frozen plan
  rows (`planRows`: publisherIdx, cohortIdx, and per-round ordered victims +
  replacements). This is the plan, published beside the hash.
- `driver-transcripts/` — the two driver stdouts (see censored record below).

## Censored record (the seed-8 interruption)
The first REPS run (`run1-...-INTERRUPTED-at-seed8.log`) completed seeds 1–7
cleanly (70 rows), then **hung on seed 8 rep 1 when the laptop slept mid-run**.
The driver at that time had no per-run timeout, so the wedged process simply
stopped producing output. It was killed, the kernel tree was restored clean
(0 changed), and seed 8 was re-run on an awake machine
(`run2-seed8-rerun.log`, 10 rows), then merged into `summary_all8.tsv`.

So seed-8 attempt 1 is **censored, not absent**: an environmental interruption
(laptop sleep), not a run that produced a result we dropped. All 40 paired
realizations in the aggregate are legitimate completed runs.

## Prospective abort/timeout policy (added this commit)
`churn-ab.sh` now runs every arm/rep under a wall-clock watchdog
(`RUN_TIMEOUT`, default 600s; a healthy N=300 run is ~60s). A run exceeding it
is SIGKILLed and recorded with **exit 137 (CENSORED)** in the summary; the stats
count `censored(exit137)` per seed and exclude that seed rather than aggregating
partial data. Every run's full stdout is teed to `transcripts/`. Future
interruptions are therefore recorded automatically, never silently missing.

## Reproduce the statistics from the raw rows
    node -e '
    const fs=require("fs");
    const rows=fs.readFileSync("summary_all8.tsv","utf8").trim().split("\n").map(l=>{
      const [seed,rep,arm,exit,planFp,execFp,warm,cold,rec]=l.split("\t");
      return {seed:+seed,rep:+rep,arm,exit:+exit,planFp,execFp,warm:+warm,rec:+rec};});
    const mean=a=>a.reduce((s,x)=>s+x,0)/a.length;
    const sd=a=>{const m=mean(a);return Math.sqrt(a.reduce((s,x)=>s+(x-m)**2,0)/(a.length-1));};
    const psW=[],psR=[];
    for(const s of [...new Set(rows.map(r=>r.seed))].sort((a,b)=>a-b)){
      const off=rows.filter(r=>r.seed===s&&r.arm==="off").sort((a,b)=>a.rep-b.rep);
      const on =rows.filter(r=>r.seed===s&&r.arm==="on").sort((a,b)=>a.rep-b.rep);
      const wD=off.map((r,i)=>r.warm-on[i].warm), rD=off.map((r,i)=>r.rec-on[i].rec);
      psW.push(mean(wD)); psR.push(mean(rD));
    }
    console.log("warm Δ",mean(psW).toFixed(2),"±",sd(psW).toFixed(2));
    console.log("recovered Δ",mean(psR).toFixed(2),"±",sd(psR).toFixed(2));'

## Result (Δ = off − on; negative = removal delivers less)
Per-seed and aggregate as posted to #council b59a3657. Seed-weighted (n=8):
warm Δ −0.81 ± 1.54 (SE 0.55) = wash; recovered Δ +0.86 ± 1.05 (SE 0.37),
6/8 seeds favor removal. Seed 4's single-run −14.67 warm was a high-variance
draw (5-rep Δ −2.97 ± 10.65, consistent with zero) — WITHDRAWN as an adverse
finding. One genuinely mild-adverse scenario: seed 3 (warm Δ −3.10 ± 1.33).

## Claim
Bounded **no-systematic-regression** for global, spread=0 churn — at-worst-neutral,
mildly favorable on post-churn recovery. NOT a general improvement, NOT a
deployment clearance. The write path is still hinted (GH #422). Testnet rollout
is the council's empirical call; deployment is David's separate authorization.

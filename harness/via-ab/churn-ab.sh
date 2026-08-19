#!/usr/bin/env bash
# =====================================================================
# Deterministic, frozen-plan churn/resubscribe A/B for the subscribe `via`
# hint removal (kernel v4.64.0). Satisfies Aster's HOLD conditions (council
# seq 1430) plus the reps requirement (seq 1432): the scenario is frozen per
# SEED before routing, and each frozen plan is REALIZED multiple times per arm
# because the kernel's routing/publish/auth randomness is intentionally NOT
# seeded — so delivery has run-to-run noise even on an identical topology. One
# realization per plan cannot establish a per-seed effect; REPS does.
#
#  - harness/pubsub-churn-ab.mjs freezes the whole plan (identity bytes, sub/pub
#    selection, ordered per-round victim+replacement sequence) from SEED before
#    any peer exists, then replays it. planFp = canonical plan hash; execFp =
#    hash of the ACTUAL nodeIds run (order preserved, never sorted). Because the
#    plan is frozen, planFp AND execFp are CONSTANT across reps and across both
#    arms — only delivery varies. The final stats assert that invariant.
#  - Each arm/rep runs as a clean node process against the toggled 3 files.
#  - A seed counts only if all its runs (both arms, all reps) share one planFp
#    and one execFp and exit 0. Per-seed paired deltas (off-on) are reported as
#    mean±sd over reps; the aggregate pools them. Failures are never dropped
#    silently.
set -u
SIM="$(cd "$(dirname "$0")/../.." && pwd)"
KERN="${KERN:-$SIM/../axona-protocol}"
ON_REF="${ON_REF:-e5e1fb6}"
FILES="src/pubsub/AxonaManager.js src/pubsub/rootElection.js src/dht/AxonaPeer.js"
OUTDIR="${OUTDIR:-$SIM/results/churn-ab}"
SUMMARY="$OUTDIR/summary.tsv"

export N=${N:-300} SUBS=${SUBS:-200} PUBS=1 CHURN_PCT=${CHURN_PCT:-20} CHURN_STEP=${CHURN_STEP:-5} ROUNDS=${ROUNDS:-3} K=${K:-20} HASH_BITS=64
SEEDS="${SEEDS:-1 2 3 4 5 6 7 8}"
REPS="${REPS:-5}"

RUN_TIMEOUT="${RUN_TIMEOUT:-600}"   # per-run wall-clock ceiling (s). A healthy
                                    # N=300 run is ~60s; a wedge (e.g. laptop
                                    # sleep mid-run) is killed and recorded as
                                    # CENSORED (exit 137) rather than hanging.
cd "$SIM" || exit 1
mkdir -p "$OUTDIR" "$OUTDIR/transcripts"
: > "$SUMMARY"
restore(){ git -C "$KERN" checkout HEAD -- $FILES 2>/dev/null; }
trap restore EXIT
restore

KERN_SHA="$(git -C "$KERN" rev-parse HEAD)"
ON_SHA="$(git -C "$KERN" rev-parse "$ON_REF")"
SIM_SHA="$(git -C "$SIM" rev-parse HEAD)"
echo "kernel baseline (off/HEAD): $KERN_SHA"
echo "on toggle ref:              $ON_REF -> $ON_SHA"
echo "dht-sim harness:            $SIM_SHA"
echo "toggled files:              $FILES"
echo "params: N=$N SUBS=$SUBS CHURN=$CHURN_PCT%/$CHURN_STEP% ROUNDS=$ROUNDS K=$K  REPS=$REPS  seeds=$SEEDS"
echo

# one arm/rep; echoes TSV: "<exit>\t<planFp>\t<execFp>\t<warm>\t<cold>\t<rec>".
# Runs under a wall-clock watchdog: a run exceeding RUN_TIMEOUT is SIGKILLed and
# reported with exit 137 (CENSORED), so an interruption is recorded, never
# silently absent. Full stdout is teed to a per-run transcript for audit.
one(){
  local seed="$1" label="$2" rep="${3:-0}" tlog
  tlog="$OUTDIR/transcripts/seed${seed}-${label}-rep${rep}.log"
  SEED="$seed" LABEL="$label" OUT="$OUTDIR/seed$seed-$label.jsonl" node harness/pubsub-churn-ab.mjs >"$tlog" 2>&1 &
  local pid=$!
  ( sleep "$RUN_TIMEOUT"; kill -9 "$pid" 2>/dev/null ) & local wd=$!
  wait "$pid" 2>/dev/null; local ec=$?
  kill "$wd" 2>/dev/null; wait "$wd" 2>/dev/null
  local out; out="$(cat "$tlog")"
  local fp warm
  fp="$(printf '%s\n' "$out" | grep -m1 '^FINGERPRINT')"
  warm="$(printf '%s\n' "$out" | grep -m1 '^SUMMARY')"
  printf "%s\t%s\t%s\t%s\t%s\t%s" \
    "$ec" \
    "$(printf '%s' "$fp"   | sed -n 's/.*planFp=\([0-9a-f]*\).*/\1/p')" \
    "$(printf '%s' "$fp"   | sed -n 's/.*execFp=\([0-9a-f]*\).*/\1/p')" \
    "$(printf '%s' "$warm" | sed -n 's/.*warm=\([0-9.]*\)%.*/\1/p')" \
    "$(printf '%s' "$warm" | sed -n 's/.*cold=\([0-9.]*\)%.*/\1/p')" \
    "$(printf '%s' "$warm" | sed -n 's/.*recovered=\([0-9.]*\)%.*/\1/p')"
}

for s in $SEEDS; do
  for rep in $(seq 1 "$REPS"); do
    restore
    row="$(one "$s" off "$rep")"; printf "%s\t%s\toff\t%s\n" "$s" "$rep" "$row" >> "$SUMMARY"
    git -C "$KERN" checkout "$ON_REF" -- $FILES
    row="$(one "$s" on "$rep")";  printf "%s\t%s\ton\t%s\n"  "$s" "$rep" "$row" >> "$SUMMARY"
    restore
    echo "  seed $s rep $rep done"
  done
done

restore
echo
echo "tree clean after restore: $(git -C "$KERN" status --porcelain | wc -l | tr -d ' ') changed (want 0)"
echo

# ── stats: pairing invariant + per-seed paired deltas (mean±sd) + aggregate ──
node -e '
const fs=require("fs");
const rows=fs.readFileSync(process.argv[1],"utf8").trim().split("\n").filter(Boolean).map(l=>{
  const [seed,rep,arm,exit,planFp,execFp,warm,cold,rec]=l.split("\t");
  return {seed:+seed,rep:+rep,arm,exit:+exit,planFp,execFp,warm:+warm,cold:+cold,rec:+rec};
});
const mean=a=>a.reduce((s,x)=>s+x,0)/a.length;
const sd=a=>{if(a.length<2)return 0;const m=mean(a);return Math.sqrt(a.reduce((s,x)=>s+(x-m)**2,0)/(a.length-1));};
const seeds=[...new Set(rows.map(r=>r.seed))].sort((a,b)=>a-b);
const allWarmDeltas=[], allRecDeltas=[], perSeedWarmMean=[], perSeedRecMean=[];
console.log("seed | planFp/execFp | reps | warm off / on / Δ(mean±sd) | rec off / on / Δ(mean±sd) | pair");
for(const s of seeds){
  const rs=rows.filter(r=>r.seed===s);
  const fps=new Set(rs.map(r=>r.planFp)), efps=new Set(rs.map(r=>r.execFp));
  const badExit=rs.some(r=>r.exit!==0);
  const censored=rs.filter(r=>r.exit===137).length;   // SIGKILL by the watchdog
  const paired = fps.size===1 && efps.size===1 && !badExit && !!([...fps][0]) && [...fps][0]!=="" && !!([...efps][0]) && [...efps][0]!=="";
  const offR=rs.filter(r=>r.arm==="off").sort((a,b)=>a.rep-b.rep);
  const onR =rs.filter(r=>r.arm==="on").sort((a,b)=>a.rep-b.rep);
  const nrep=Math.min(offR.length,onR.length);
  const wOff=offR.map(r=>r.warm), wOn=onR.map(r=>r.warm), rOff=offR.map(r=>r.rec), rOn=onR.map(r=>r.rec);
  const wD=[], rD=[]; for(let i=0;i<nrep;i++){wD.push(wOff[i]-wOn[i]); rD.push(rOff[i]-rOn[i]);}
  const fp=`${[...fps][0]}/${[...efps][0]}`;
  const pc=paired?"OK":"FAIL";
  console.log(`${s} | ${fp} | ${nrep} | ${mean(wOff).toFixed(2)} / ${mean(wOn).toFixed(2)} / ${mean(wD).toFixed(2)}±${sd(wD).toFixed(2)} | ${mean(rOff).toFixed(2)} / ${mean(rOn).toFixed(2)} / ${mean(rD).toFixed(2)}±${sd(rD).toFixed(2)} | ${pc}`);
  if(!paired){console.log(`  !! seed ${s} EXCLUDED: planFp{${[...fps]}} execFp{${[...efps]}} badExit=${badExit} censored(exit137)=${censored}`); continue;}
  allWarmDeltas.push(...wD); allRecDeltas.push(...rD);
  perSeedWarmMean.push(mean(wD)); perSeedRecMean.push(mean(rD));
}
console.log("\n== AGGREGATE (paired seeds; delta = off - on; negative = removal lower) ==");
if(!allWarmDeltas.length){console.log("  no paired data");process.exit(0);}
console.log(`  pooled per-realization  n=${allWarmDeltas.length}:  warm Δ ${mean(allWarmDeltas).toFixed(2)}±${sd(allWarmDeltas).toFixed(2)}   recovered Δ ${mean(allRecDeltas).toFixed(2)}±${sd(allRecDeltas).toFixed(2)}`);
console.log(`  seed-weighted (mean of per-seed means) n=${perSeedWarmMean.length}:  warm Δ ${mean(perSeedWarmMean).toFixed(2)}±${sd(perSeedWarmMean).toFixed(2)}   recovered Δ ${mean(perSeedRecMean).toFixed(2)}±${sd(perSeedRecMean).toFixed(2)}`);
' "$SUMMARY"

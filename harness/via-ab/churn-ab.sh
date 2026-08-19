#!/usr/bin/env bash
# =====================================================================
# Deterministic, frozen-plan churn/resubscribe A/B for the subscribe `via`
# hint removal (kernel v4.64.0). Satisfies Aster's HOLD conditions (council
# seq 1430):
#
#  (1) The scenario is FROZEN before routing: harness/pubsub-churn-ab.mjs builds
#      the whole plan (node identity bytes, publisher/subscriber selection,
#      ordered per-round victim + replacement sequence) from SEED before any peer
#      exists, then replays it. Both arms regenerate the identical plan.
#  (2) Each arm emits planFp (hash of the canonical plan) and execFp (hash of the
#      ACTUAL nodeIds that ran — initial ++ per-step victims ++ replacements, in
#      order, never sorted). The plan rows are written to the per-seed OUT jsonl.
#  (3) FAIL-FAST: a seed's delivery numbers are used ONLY if planFp AND execFp
#      match across both arms. A mismatch is printed loudly and the seed is
#      excluded from the aggregate.
#  (4) Each arm runs as a clean node PROCESS against a toggled-in-place kernel;
#      we record the kernel baseline SHA, the ON toggle ref, the harness SHA, and
#      each arm's exit code, and never silently drop a failed run.
#
# The ONLY difference between arms is the 3 routing behaviour files, toggled
# between HEAD (hint-off, 4.64.0) and e5e1fb6 (hint-on, 4.63.0).
set -u
SIM="$(cd "$(dirname "$0")/../.." && pwd)"
KERN="${KERN:-$SIM/../axona-protocol}"
ON_REF="${ON_REF:-e5e1fb6}"
FILES="src/pubsub/AxonaManager.js src/pubsub/rootElection.js src/dht/AxonaPeer.js"
OUTDIR="${OUTDIR:-$SIM/results/churn-ab}"

export N=${N:-300} SUBS=${SUBS:-200} PUBS=1 CHURN_PCT=${CHURN_PCT:-20} CHURN_STEP=${CHURN_STEP:-5} ROUNDS=${ROUNDS:-3} K=${K:-20} HASH_BITS=64
SEEDS="${SEEDS:-1 2 3 4 5 6 7 8}"

cd "$SIM" || exit 1
mkdir -p "$OUTDIR"
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
echo "params: N=$N SUBS=$SUBS CHURN=$CHURN_PCT%/$CHURN_STEP% ROUNDS=$ROUNDS K=$K"
echo

# run one arm; echoes: "<exit> <planFp> <execFp> <warm> <cold> <recovered>"
one(){
  local seed="$1" label="$2" out
  out="$(SEED="$seed" LABEL="$label" OUT="$OUTDIR/seed$seed-$label.jsonl" node harness/pubsub-churn-ab.mjs 2>&1)"
  local ec=$?
  local fp warm; fp="$(printf '%s\n' "$out" | grep -m1 '^FINGERPRINT')"; warm="$(printf '%s\n' "$out" | grep -m1 '^SUMMARY')"
  local planFp execFp w c r
  planFp="$(printf '%s' "$fp"   | sed -n 's/.*planFp=\([0-9a-f]*\).*/\1/p')"
  execFp="$(printf '%s' "$fp"   | sed -n 's/.*execFp=\([0-9a-f]*\).*/\1/p')"
  w="$(printf '%s' "$warm" | sed -n 's/.*warm=\([0-9.]*\)%.*/\1/p')"
  c="$(printf '%s' "$warm" | sed -n 's/.*cold=\([0-9.]*\)%.*/\1/p')"
  r="$(printf '%s' "$warm" | sed -n 's/.*recovered=\([0-9.]*\)%.*/\1/p')"
  echo "$ec ${planFp:-NA} ${execFp:-NA} ${w:-NA} ${c:-NA} ${r:-NA}"
}

printf "%-4s | %-8s %-8s %-6s | off warm/cold/rec | on warm/cold/rec | exit off/on\n" seed planFp execFp pair
offW=(); offR=(); onW=(); onR=(); paired=()
for s in $SEEDS; do
  restore
  read eoff pfoff exoff woff coff roff <<<"$(one "$s" off)"
  git -C "$KERN" checkout "$ON_REF" -- $FILES
  read eon  pfon  exon  won  con  ron  <<<"$(one "$s" on)"
  restore
  # fail-fast pairing check: BOTH fingerprints must match, both arms must exit 0
  pair="FAIL"
  if [ "$pfoff" = "$pfon" ] && [ "$exoff" = "$exon" ] && [ "$pfoff" != "NA" ] && [ "$eoff" = "0" ] && [ "$eon" = "0" ]; then pair="OK"; fi
  printf "%-4s | %-8s %-8s %-6s | %s/%s/%s | %s/%s/%s | %s/%s\n" \
    "$s" "$pfoff" "$exoff" "$pair" "$woff" "$coff" "$roff" "$won" "$con" "$ron" "$eoff" "$eon"
  if [ "$pair" = "OK" ]; then
    paired+=("$s"); offW+=("$woff"); offR+=("$roff"); onW+=("$won"); onR+=("$ron")
  else
    echo "  !! seed $s EXCLUDED: planFp off=$pfoff on=$pfon  execFp off=$exoff on=$exon  exit off=$eoff on=$eon"
  fi
done

restore
echo
echo "tree clean after restore: $(git -C "$KERN" status --porcelain | wc -l | tr -d ' ') changed (want 0)"
echo "paired seeds (used in aggregate): ${paired[*]:-none}"
node -e '
const off={w:process.argv[1].split(",").filter(Boolean),r:process.argv[2].split(",").filter(Boolean)};
const on ={w:process.argv[3].split(",").filter(Boolean),r:process.argv[4].split(",").filter(Boolean)};
const num=a=>a.map(Number).filter(x=>!isNaN(x));
const mean=a=>{a=num(a);return a.length?a.reduce((s,x)=>s+x,0)/a.length:NaN};
if(!off.w.length){console.log("\nNO PAIRED SEEDS — nothing to aggregate.");process.exit(0);}
console.log("\n== AGGREGATE (paired seeds only, frozen-plan) ==");
console.log(`  n=${off.w.length}`);
console.log(`  warm%%      (steady under churn): off ${mean(off.w).toFixed(1)} vs on ${mean(on.w).toFixed(1)}  (delta ${(mean(off.w)-mean(on.w)).toFixed(1)})`);
console.log(`  recovered%% (post-churn heal):    off ${mean(off.r).toFixed(1)} vs on ${mean(on.r).toFixed(1)}  (delta ${(mean(off.r)-mean(on.r)).toFixed(1)})`);
' "$(IFS=,;echo "${offW[*]:-}")" "$(IFS=,;echo "${offR[*]:-}")" "$(IFS=,;echo "${onW[*]:-}")" "$(IFS=,;echo "${onR[*]:-}")"

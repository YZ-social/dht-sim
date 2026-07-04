#!/usr/bin/env bash
# W2 B5 — A/B/C nursery sweep. Runs every (arm × churn × seed) and appends
# one JSON line per run to results/w2/nursery.jsonl. Methodology: >=5 seeds
# per cell so the analyzer reports mean +/- sd (single-seed fill is noise).
#
#   N=500 REPS=5 CHURNS="0 20" bash harness/nursery-sweep.sh
set -u
cd "$(dirname "$0")/.."

N=${N:-500}
K=${K:-3}
TRAFFIC=${TRAFFIC:-3}
REPS=${REPS:-5}
CHURNS=${CHURNS:-"0 20"}
OUT=${OUT:-results/w2/nursery.jsonl}
mkdir -p "$(dirname "$OUT")"
: > "$OUT"

echo "sweep: N=$N K=$K traffic=$TRAFFIC reps=$REPS churns=[$CHURNS] -> $OUT"
for churn in $CHURNS; do
  for arm in A B C; do
    for seed in $(seq 1 "$REPS"); do
      ARM=$arm N=$N K=$K CHURN=$churn TRAFFIC=$TRAFFIC SEED=$seed \
        node harness/nursery-experiment.mjs 2>/dev/null >> "$OUT"
      echo "  done arm=$arm churn=$churn seed=$seed"
    done
  done
done
echo "SWEEP COMPLETE -> $OUT"

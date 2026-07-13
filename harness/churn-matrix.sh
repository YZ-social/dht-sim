#!/usr/bin/env bash
# =====================================================================
# churn-matrix.sh — unattended driver for the pub/sub churn suite.
#
# Iterates a scenario matrix, running harness/pubsub-churn-suite.mjs for
# each and appending one JSONL record per (scenario × reps) to a single
# combined results file. Designed to run under nohup + caffeinate for
# extended autonomous exploration; Claude analyzes the JSONL and steers
# the matrix between/after runs.
#
#   nohup caffeinate -is bash harness/churn-matrix.sh > results/churn/matrix.log 2>&1 &
#
# Override the matrix via env (space-separated lists):
#   MODES="global relay root"  PCTS="5 10 20 30"  SUBS_LIST="1000 5000"
#   N=50000  PUBS_LIST="1"  ROUNDS=5  REPS=5  HASH_BITS=64
#   OUT=results/churn/matrix.jsonl
# =====================================================================
set -uo pipefail
cd "$(dirname "$0")/.."

MODES="${MODES:-global relay root}"
PCTS="${PCTS:-10 20 30}"
SUBS_LIST="${SUBS_LIST:-1000}"
PUBS_LIST="${PUBS_LIST:-1}"
N="${N:-50000}"
ROUNDS="${ROUNDS:-5}"
REPS="${REPS:-5}"
HASH_BITS="${HASH_BITS:-64}"
WARMUP_MS="${WARMUP_MS:-6000}"
SETTLE="${SETTLE:-8000}"
OUT="${OUT:-results/churn/matrix.jsonl}"
LABEL="${LABEL:-matrix}"

mkdir -p "$(dirname "$OUT")"
echo "[matrix] start $(date '+%F %T')  N=$N modes=[$MODES] pcts=[$PCTS] subs=[$SUBS_LIST] pubs=[$PUBS_LIST] rounds=$ROUNDS reps=$REPS → $OUT"

total=0; done=0
for s in $SUBS_LIST; do for pu in $PUBS_LIST; do for m in $MODES; do for p in $PCTS; do total=$((total+1)); done; done; done; done

for SUBS in $SUBS_LIST; do
  for PUBS in $PUBS_LIST; do
    for MODE in $MODES; do
      for PCT in $PCTS; do
        done=$((done+1))
        echo "[matrix] ($done/$total) $(date '+%T')  mode=$MODE pct=$PCT% N=$N SUBS=$SUBS PUBS=$PUBS"
        N=$N SUBS=$SUBS PUBS=$PUBS CHURN_MODE=$MODE CHURN_PCT=$PCT \
          ROUNDS=$ROUNDS REPS=$REPS HASH_BITS=$HASH_BITS WARMUP_MS=$WARMUP_MS SETTLE=$SETTLE \
          OUT="$OUT" LABEL="$LABEL" \
          node harness/pubsub-churn-suite.mjs 2>&1 | sed 's/^/    /'
        echo "[matrix] ($done/$total) done"
      done
    done
  done
done
echo "[matrix] COMPLETE $(date '+%F %T')  → $OUT"

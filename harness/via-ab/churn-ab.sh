#!/usr/bin/env bash
# Seed-paired churn/resubscribe A/B. Same SEED both arms => identical placement
# + churn victims; via logic is the sole variable. Toggles the 3 behavior files
# between HEAD (494fbd6 hint-off) and e5e1fb6 (4.63.0 hint-on).
set -u
SIM="$(cd "$(dirname "$0")/../.." && pwd)"
KERN="${KERN:-$SIM/../axona-protocol}"
FILES="src/pubsub/AxonaManager.js src/pubsub/rootElection.js src/dht/AxonaPeer.js"
export N=${N:-300} SUBS=${SUBS:-200} PUBS=1 CHURN_PCT=${CHURN_PCT:-20} CHURN_STEP=5 ROUNDS=${ROUNDS:-3} REPS=1 HASH_BITS=64
SEEDS="${SEEDS:-1 2 3 4 5 6 7 8}"
cd "$SIM" || exit 1
restore(){ git -C "$KERN" checkout HEAD -- $FILES 2>/dev/null; }
trap restore EXIT; restore
one(){ SEED="$1" node harness/pubsub-churn-suite.mjs 2>/dev/null | awk '/warm \(steady-state/{for(i=1;i<=NF;i++)if($i~/%$/){gsub(/%/,"",$i);w=$i;break}} /probe in-flight/{c="";r="";for(i=1;i<=NF;i++)if($i~/%$/){gsub(/%/,"",$i);if(c=="")c=$i;else r=$i}} END{printf "%s %s %s",w,c,r}'; }
echo "seed | off warm/cold/rec | on warm/cold/rec"
for s in $SEEDS; do restore; read oW oC oR <<<"$(one "$s")"; git -C "$KERN" checkout e5e1fb6 -- $FILES; read nW nC nR <<<"$(one "$s")"; restore
  echo "$s | $oW/$oC/$oR | $nW/$nC/$nR"; done
echo "tree clean: $(git -C "$KERN" status --porcelain|wc -l|tr -d ' ')"

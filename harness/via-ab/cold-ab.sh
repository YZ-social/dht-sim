#!/usr/bin/env bash
# Cold-convergence A/B for the subscribe-side via removal.
# Toggles ONLY the 3 subscribe behavior files between HEAD (494fbd6 hint-off)
# and e5e1fb6 (4.63.0 hint-on). pubsub-real-kernel imports ../axona-protocol
# directly, so routing logic is the sole variable. SYN_CAP=8 -> sparse arm.
set -u
SIM="$(cd "$(dirname "$0")/../.." && pwd)"
KERN="${KERN:-$SIM/../axona-protocol}"
FILES="src/pubsub/AxonaManager.js src/pubsub/rootElection.js src/dht/AxonaPeer.js"
REPS=${REPS:-5}; export N=${N:-150} SUBS=${SUBS:-100} SYN_CAP=${SYN_CAP:-0}
cd "$SIM" || exit 1
restore(){ git -C "$KERN" checkout HEAD -- $FILES 2>/dev/null; }
trap restore EXIT; restore
run(){ : >"$2"; for i in $(seq 1 "$REPS"); do node harness/pubsub-real-kernel.mjs 2>/dev/null | grep '^RESULT_JSON' | sed 's/^RESULT_JSON //' >>"$2"; done; }
OUT="$(mktemp -d)"
echo "== hint-OFF (HEAD $(git -C "$KERN" rev-parse --short HEAD)) N=$N SUBS=$SUBS SYN_CAP=$SYN_CAP reps=$REPS =="; run off "$OUT/off"
git -C "$KERN" checkout e5e1fb6 -- $FILES
echo "== hint-ON (e5e1fb6) =="; run on "$OUT/on"; restore
echo "tree clean: $(git -C "$KERN" status --porcelain|wc -l|tr -d ' ')"
node -e 'const fs=require("fs"),r=f=>fs.readFileSync(f,"utf8").trim().split("\n").map(l=>JSON.parse(l)),m=a=>a.reduce((s,x)=>s+x,0)/a.length;for(const[n,f]of[["OFF",process.argv[1]],["ON",process.argv[2]]]){const d=r(f).map(x=>x.deliveryPct),s=r(f).map(x=>x.spuriousRoots);console.log(`${n}: delivery ${d.join(" ")} mean=${m(d).toFixed(1)} | spurious ${s.join(" ")}`);}' "$OUT/off" "$OUT/on"

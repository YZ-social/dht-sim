# via-hint A/B drivers (kernel 4.64.0 subscribe-side via removal)

Reproduces the 494fbd6 (hint-off) vs e5e1fb6 (hint-on) A/B. Portable: assumes
axona-protocol is a sibling of dht-sim (override with KERN=/path/to/axona-protocol).

The kernel is imported DIRECTLY by the harnesses (../axona-protocol package link),
so the A/B toggles ONLY the three subscribe behavior files:
  src/pubsub/AxonaManager.js  src/pubsub/rootElection.js  src/dht/AxonaPeer.js
between HEAD (494fbd6, hint-off) and e5e1fb6 (4.63.0, hint-on). Everything else in
the e5e1fb6..494fbd6 diff (version string, cache-bust tags, REF-1.1 manifests,
smoke_read_routing) is inert to the sim.

  bash harness/via-ab/cold-ab.sh     # cold convergence (dense + run again with SYN_CAP=8 for sparse)
  SEEDS="1 2 3 4 5 6 7 8" bash harness/via-ab/churn-ab.sh   # seed-paired churn/resubscribe

Restore is automatic (trap): the axona-protocol tree is left at HEAD.

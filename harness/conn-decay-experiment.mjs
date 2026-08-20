// =====================================================================
// conn-decay-experiment.mjs — does a node's connection count decay over
// time under steady traffic, and is it N-dependent? (David's hypothesis:
// in a small network, a demoted connection has no replacement to promote,
// so degree bleeds down over time.)
//
// Real kernel (@axona/protocol) mesh via the harness lib. NO churn — nodes
// never leave/join. The only thing that can move degree is the kernel's own
// FORGET decay (Synapse.decay, gated on lookup traffic: simEpoch++/lookup,
// _tickDecay every DECAY_INTERVAL=500 lookups) balanced against LEARN
// reinforcement/promotion on the same lookups. We drive steady lookups and
// sample every peer's routing degree (synaptome + incomingSynapses, the two
// that share the MAX_SYNAPTOME=50 budget) each cycle.
//
// Sweep N around the 50 cap: below it a node can hold everyone (no forced
// demotion — the suspected reason the 38-relay fleet sits flat at ~35);
// above it, forced eviction + decay could bleed. If degree declines and the
// decline worsens as N grows past 50, that confirms the mechanism.
//
// env: NS="20 40 60 100"  CYCLES=30  LOOKUPS=200  REFRESH=3  STEP_MS=80
//      K=20  HASH_BITS=64  OUT=<jsonl path>
// =====================================================================
import { buildMesh, warmCycle, KERNEL_VERSION, shrinkKeyspace } from './lib/axon-mesh.mjs';
import { appendFileSync, writeFileSync } from 'node:fs';

const NS      = (process.env.NS || '20 40 60 100').trim().split(/\s+/).map(Number);
const CYCLES  = +(process.env.CYCLES || 30);
const LOOKUPS = +(process.env.LOOKUPS || 200);   // per cycle — drives decay ticks
const REFRESH = +(process.env.REFRESH || 3);
const STEP_MS = +(process.env.STEP_MS || 80);
const K       = +(process.env.K || 20);
const DEMOTE  = +(process.env.DEMOTE || 0);   // edges to DROP per node per cycle
const HASH_BITS = +(process.env.HASH_BITS || 64);
const OUT     = process.env.OUT || `results/conn-decay_${NS.join('-')}.jsonl`;

// Demote = a connection DROPS (peer timeout / network blip), both endpoints live.
// Models David's demote event: does the kernel PROMOTE a replacement, or leave
// the slot empty? Drops `DEMOTE` random synapses per node, symmetric (both dirs).
function demoteEdges(state, perNode, rng = Math.random) {
  if (!perNode) return;
  for (const p of state.byBig.values()) {
    const ids = [...p.node.synaptome.keys()];
    for (let d = 0; d < perNode && ids.length; d++) {
      const i = Math.floor(rng() * ids.length);
      const victim = ids.splice(i, 1)[0];
      p.node.synaptome.delete(victim);
      const other = state.byBig.get(victim);
      if (other) { other.node.synaptome.delete(p.big); other.node.incomingSynapses?.delete(p.big); }
      p.node.incomingSynapses?.delete(victim);
    }
  }
}

shrinkKeyspace(HASH_BITS);

const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : 0;

// degree snapshot across all peers: out=synaptome, in=incoming, tot=out+in
function sample(state) {
  const out = [], inc = [], tot = [];
  for (const p of state.byBig.values()) {
    const o = p.node.synaptome.size;
    const i = p.node.incomingSynapses?.size ?? 0;
    out.push(o); inc.push(i); tot.push(o + i);
  }
  const zeros = tot.filter(x => x === 0).length;
  const lows  = tot.filter(x => x < 3).length;   // "starved" — near-isolated
  return {
    outMean: +mean(out).toFixed(2), inMean: +mean(inc).toFixed(2),
    totMean: +mean(tot).toFixed(2), totMin: Math.min(...tot), totMax: Math.max(...tot),
    zeros, lows,
  };
}

writeFileSync(OUT, '');
console.log(`conn-decay — kernel ${KERNEL_VERSION}  N=[${NS}]  CYCLES=${CYCLES}  LOOKUPS/cyc=${LOOKUPS}  K=${K}  HASH_BITS=${HASH_BITS}  (no churn)`);
console.log('N | cap | cyc | totMean(out/in) | totMin | zeros | lows | Δ-from-start');

for (const N of NS) {
  const state = await buildMesh({ N, K, refresh: 3000, renew: 8000, spread: 0 });
  const cap = [...state.byBig.values()][0]?.node?._maxSynaptome
            ?? state.domain?.MAX_SYNAPTOME ?? 50;

  const s0 = sample(state);
  const startTot = s0.totMean;
  const rec = (cyc, s) => {
    appendFileSync(OUT, JSON.stringify({ kernelVersion: KERNEL_VERSION, N, cap, cyc, ...s }) + '\n');
    const d = (s.totMean - startTot).toFixed(2);
    console.log(`${String(N).padStart(3)} | ${cap} | ${String(cyc).padStart(3)} | ${String(s.totMean).padStart(5)} (${s.outMean}/${s.inMean}) | ${String(s.totMin).padStart(2)} | ${String(s.zeros).padStart(3)} | ${String(s.lows).padStart(3)} | ${d}`);
  };
  rec(0, s0);

  for (let c = 1; c <= CYCLES; c++) {
    demoteEdges(state, DEMOTE);                                    // drop connections
    await warmCycle(state, { lookups: LOOKUPS, refreshSteps: REFRESH, stepMs: STEP_MS }); // promote path
    rec(c, sample(state));
  }

  // per-N verdict
  const sf = sample(state);
  const drop = startTot - sf.totMean;
  const pctDrop = startTot > 0 ? (100 * drop / startTot).toFixed(1) : '0';
  console.log(`  >> N=${N} (cap ${cap}): start ${startTot} → end ${sf.totMean} degree  (drop ${drop.toFixed(2)}, ${pctDrop}%)  minEver→${sf.totMin}  zeros ${sf.zeros}  ${N > cap ? '[N>cap: forced eviction regime]' : '[N<=cap: can hold all]'}`);
  // free the mesh's timers so the next N starts clean
  for (const p of state.byBig.values()) { try { await p.peer.stop?.(); } catch { /* */ } }
  console.log('');
}
console.log(`\njsonl: ${OUT}`);

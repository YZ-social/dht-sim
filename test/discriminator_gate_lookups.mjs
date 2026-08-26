// discriminator_gate_lookups.mjs — Aster's same-seed three-arm discriminator
// (ASTER-20260826-1120-DHTSIM-01) for the gated-lookup success question.
//
// Arms (same Math.random seed for positions, build shuffles, workload):
//   A  gate      — admission gate armed (v0.112.0 default engine)
//   B  trim      — gate OFF; cap enforced by symmetric post-build TRIM with
//                  NO channel closes (isolates cap TOPOLOGY from close effects)
//   C  gate+sync — gate armed + explicit symmetric reconciliation sweep
//                  (controls for close-propagation timing)
//
// DISCLOSED LIMIT: node ids are real Ed25519 keygen (not seedable), so arms
// share seed for everything EXCEPT identities; L=1000 lookups averages the
// id variance.
//
// Failure classification from lookup result paths:
//   revisit   — path visits a node twice (greedy local minimum / oscillation)
//   exhausted — hops >= 35 (MAX_HOPS region)
//   shortstop — terminated <=2 hops, no revisit (Aster's observed shape)
//   other
//
//   SEED=42 N=1000 node test/discriminator_gate_lookups.mjs
import { TransportAxonaEngine } from '../src/dht/neuromorphic/TransportAxonaEngine.js';
import { Synapse } from '@axona/protocol';

// ── seeded RNG override (LCG) — BEFORE any engine work ──────────────────
const SEED = +(process.env.SEED || 42);
function makeLcg(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; }; }

const N = +(process.env.N || 1000);
const L = +(process.env.LOOKUPS || 1000);

async function buildArm(label, { gate, trim, sync }) {
  Math.random = makeLcg(SEED);           // same stream per arm
  const eng = new TransportAxonaEngine({ k: 20, alpha: 3, bits: 64, geoBits: 8, hashBits: 56,
    ...(gate ? {} : { noGate: true }) });
  // Arm B: disable the gate by stripping _gateCfg after construction of each
  // peer (the ctor always arms it since v0.112.0; B needs it off).
  for (let i = 0; i < N; i++) await eng.addNode(38 + Math.random() * 2, -77 + Math.random() * 2);
  if (!gate) for (const p of eng._peers.values()) { p._gateCfg = null; }

  // Refusal/swap instrumentation (arms with gate): count decisions.
  let refusals = 0, admits = 0;
  if (gate) for (const p of eng._peers.values()) {
    const orig = p._admitOrImprove?.bind(p);
    if (orig) p._admitOrImprove = (s) => { const r = orig(s); if (r) admits++; else refusals++; return r; };
  }

  await eng.buildRoutingTables({ bidirectional: true, maxConnections: 100 });
  await new Promise(r => setTimeout(r, 1500));   // drain in-flight seed traffic

  if (trim) {
    // Symmetric cap enforcement WITHOUT closes: trim to budget, both ends'
    // maps, channels untouched.
    for (const n of eng.nodeMap.values()) {
      const cap = n._maxSynaptome ?? 50;
      while (n.synaptome.size > cap) {
        const key = [...n.synaptome.keys()][n.synaptome.size - 1];
        n.synaptome.delete(key);
        const far = eng.nodeMap.get(key);
        far?.synaptome?.delete(n.id);
      }
    }
  }
  if (sync) {
    // Explicit symmetric reconciliation: remove one-sided edges (either end
    // missing the reverse entry keeps the edge only if its channel is live).
    for (const n of eng.nodeMap.values()) {
      for (const key of [...n.synaptome.keys()]) {
        try { if (n.transport?.isConnected && !n.transport.isConnected(key)) n.synaptome.delete(key); } catch { /* */ }
      }
    }
  }

  const sizes = [...eng.nodeMap.values()].map(n => n.synaptome.size).sort((a, b) => a - b);
  const nodes = [...eng.nodeMap.values()];
  const pick = makeLcg(SEED ^ 0xbeef);          // same workload stream per arm
  let ok = 0; const failKinds = { revisit: 0, exhausted: 0, shortstop: 0, other: 0 };
  let diagSuppressed = 0;                        // Aster: surface, don't silently null
  for (let i = 0; i < L; i++) {
    const a = nodes[Math.floor(pick() * nodes.length)];
    const b = nodes[Math.floor(pick() * nodes.length)];
    if (a === b) { i--; continue; }
    try {
      const r = await eng.lookup(a.id, b.id);
      if (r && (r.found === true || r.success === true || r?.id === b.id)) { ok++; continue; }
      const path = r?.path ?? [];
      const seen = new Set(); let revisit = false;
      for (const h of path) { if (seen.has(h)) { revisit = true; break; } seen.add(h); }
      if (revisit) failKinds.revisit++;
      else if ((r?.hops ?? path.length) >= 35) failKinds.exhausted++;
      else if ((r?.hops ?? path.length) <= 2) failKinds.shortstop++;
      else failKinds.other++;
    } catch { diagSuppressed++; failKinds.other++; }
  }
  eng.dispose?.();
  const fmt = (o) => Object.entries(o).map(([k, v]) => `${k}=${v}`).join(' ');
  console.log(`[${label}] syn min/med/max=${sizes[0]}/${sizes[sizes.length >> 1]}/${sizes[sizes.length - 1]}  lookups ${ok}/${L}  fails: ${fmt(failKinds)}  gateDecisions: admits=${admits} refusals=${refusals}  diagSuppressed=${diagSuppressed}`);
}

await buildArm('A gate     ', { gate: true,  trim: false, sync: false });
await buildArm('B trim     ', { gate: false, trim: true,  sync: false });
await buildArm('C gate+sync', { gate: true,  trim: false, sync: true  });
process.exit(0);

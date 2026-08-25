// repro_pubsubm_driven.mjs — benchmark-style pubsubm driving on the
// transport engine, no wall-clock settle. Discriminates: does DRIVEN
// refresh (the benchmark's deterministic convergence) work on the axona
// path, or does delivery only converge via the shim's wall-clock timers?
//
//   node test/repro_pubsubm_driven.mjs           (264-bit)
//   HASH_BITS=56 node test/repro_pubsubm_driven.mjs  (browser's 64-bit ids)
import { TransportAxonaEngine } from '../src/dht/neuromorphic/TransportAxonaEngine.js';
import { PubSubAdapter } from '../src/pubsub/PubSubAdapter.js';

const wait = (ms) => new Promise(r => setTimeout(r, ms));
const N = +(process.env.N || 200), GROUPS = 2, GSIZE = 29;

const eng = new TransportAxonaEngine({ k: 20, geoBits: 8,
  ...(process.env.HASH_BITS ? { hashBits: +process.env.HASH_BITS } : {}) });
for (let i = 0; i < N; i++) await eng.addNode(38 + Math.random() * 2, -77 + Math.random() * 2);
await eng.buildRoutingTables({ bidirectional: true });

const nodes = [...eng.nodeMap.values()];
const groups = [];
for (let g = 0; g < GROUPS; g++) {
  const base = g * (GSIZE + 1);
  groups.push({ id: g, relay: nodes[base], participants: nodes.slice(base + 1, base + 1 + GSIZE) });
}

// Subscribe like the benchmark: adapters, 'immediate', NO settle.
const delivered = new Map(); // subId -> count
const adapters = new Map();
const A = (n) => { let a = adapters.get(n.id); if (!a) { a = new PubSubAdapter({ transport: eng.axonFor(n) }); adapters.set(n.id, a); } return a; };
for (const g of groups) {
  for (const p of g.participants) {
    delivered.set(p.id, 0);
    A(p).subscribe('bench', 'g' + g.id, () => delivered.set(p.id, delivered.get(p.id) + 1), 'immediate');
  }
  A(g.relay);
}
await wait(300);  // let the immediate subscribes' async sub() calls land

// EAGER MANAGERS (hypothesis: routed subscribe-k must terminate at a
// handler-installed node, and the kernel builds AxonaManager lazily on
// first pub/sub — so a chosen root without one silently drops the SUB).
if (process.env.EAGER === '1') {
  let forced = 0;
  for (const n of nodes) {
    const p = eng._peers.get(n.id);
    try { if (p && !p._axonaManager) { p._requireAxonaManager('warm'); forced++; } } catch { /* */ }
  }
  console.log(`eager managers forced on ${forced} nodes`);
  await wait(300);
}

const publishAndCount = async (label) => {
  for (const s of delivered.keys()) delivered.set(s, 0);
  for (const g of groups) A(g.relay).publish('bench', 'g' + g.id, { t: label });
  await wait(1500);
  const got = [...delivered.values()].filter(c => c > 0).length;
  console.log(`${label}: delivered ${got}/${delivered.size}`);
  return got;
};

console.log('— phase 1: cold publish (no settle, no driven refresh) —');
await publishAndCount('cold');

console.log('— phase 2: 3 driven refresh rounds (renewMs=0, like buildAxonTree) —');
for (let r = 0; r < 3; r++) {
  for (const p of eng._peers.values()) { const am = p._axonaManager; if (am) am.renewMs = 0; }
  for (const n of nodes) { try { await eng.axonFor(n).refreshTick(); } catch { /* */ } }
  await wait(400);
}
await publishAndCount('after-driven');

console.log('— phase 3: wall-clock 10s (shim timers) —');
await wait(10000);
await publishAndCount('after-wallclock');

// Tree state, read from the KERNEL managers directly.
let roles = 0, children = 0;
for (const p of eng._peers.values()) {
  const am = p._axonaManager; if (!am?.axonRoles) continue;
  roles += am.axonRoles.size;
  for (const role of am.axonRoles.values()) children += role.children?.size ?? 0;
}
console.log(`tree: roles=${roles} childrenTotal=${children}`);
process.exit(0);

// audit_caps.mjs — is the Axona benchmark cheating on connection/synaptome caps?
// Builds the transport engine at the BROWSER's exact benchmark config and
// measures, per node: synaptome.size, incomingSynapses.size, connections.size.
// Production invariant (v2.17.1): synaptome + incoming <= _maxSynaptome (50)
// SHARED; physical connections <= maxConnections (100).
//   node test/audit_caps.mjs            (N=500, hashBits=56, maxConn=100)
import { TransportAxonaEngine } from '../src/dht/neuromorphic/TransportAxonaEngine.js';

const N = +(process.env.N || 500);
const eng = new TransportAxonaEngine({ k: 20, alpha: 3, bits: 64, geoBits: 8, hashBits: 56,
  ...(process.env.ARM_FULL === '1' ? { armFull: true } : {}) });
for (let i = 0; i < N; i++) await eng.addNode(38 + Math.random() * 2, -77 + Math.random() * 2);

// Phase-tag every synaptome add: which phase pushes nodes past the budget?
let phase = 'addNode';
const addsByPhase = new Map();     // phase -> count
const overByPhase = new Map();     // phase -> adds that pushed size past budget
let inAddSynapse = false;
let bypassSets = 0;
let bypassStack = null;
for (const n of eng.nodeMap.values()) {
  const orig = n.addSynapse.bind(n);
  n.addSynapse = (syn) => {
    addsByPhase.set(phase, (addsByPhase.get(phase) ?? 0) + 1);
    if (n._maxSynaptome != null && n.synaptome.size >= n._maxSynaptome) {
      overByPhase.set(phase, (overByPhase.get(phase) ?? 0) + 1);
    }
    inAddSynapse = true;
    try { return orig(syn); } finally { inAddSynapse = false; }
  };
  // Catch EVERY writer: wrap the Map's set. Anything not routed through
  // addSynapse is a bypass — count it and keep one sample stack.
  const mapSet = n.synaptome.set.bind(n.synaptome);
  n.synaptome.set = (k, v) => {
    if (!inAddSynapse && !n.synaptome.has(k)) {
      bypassSets++;
      if (!bypassStack) bypassStack = new Error('bypass writer').stack;
    }
    return mapSet(k, v);
  };
}
phase = 'build';
await eng.buildRoutingTables({ bidirectional: true, maxConnections: +(process.env.MAXCONN || 100) });
phase = 'post-build';
await new Promise(r => setTimeout(r, 3000));   // let any async kernel activity land
console.log('adds by phase:', Object.fromEntries(addsByPhase));
console.log('OVER-BUDGET adds by phase:', Object.fromEntries(overByPhase));
console.log(`BYPASS sets (not via addSynapse): ${bypassSets}`);
if (bypassStack) console.log('sample bypass stack:\n' + bypassStack.split('\n').slice(1, 7).join('\n'));

const rows = [...eng.nodeMap.values()].map(n => ({
  syn: n.synaptome?.size ?? 0,
  inc: n.incomingSynapses?.size ?? 0,
  conn: n.connections?.size ?? 0,
  budget: n._maxSynaptome,
}));
const dist = (xs) => { const s = [...xs].sort((a, b) => a - b); return `min=${s[0]} med=${s[s.length >> 1]} max=${s[s.length - 1]} avg=${(xs.reduce((a, b) => a + b, 0) / xs.length).toFixed(1)}`; };
console.log(`N=${N} budget(_maxSynaptome)=${rows[0].budget}`);
console.log(`synaptome:            ${dist(rows.map(r => r.syn))}`);
console.log(`incomingSynapses:     ${dist(rows.map(r => r.inc))}`);
console.log(`syn+inc (SHARED cap): ${dist(rows.map(r => r.syn + r.inc))}`);
console.log(`connections (<=100):  ${dist(rows.map(r => r.conn))}`);
console.log(`VIOLATIONS: syn>budget=${rows.filter(r => r.syn > r.budget).length}  syn+inc>budget=${rows.filter(r => r.syn + r.inc > r.budget).length}  conn>maxConn=${rows.filter(r => r.conn > +(process.env.MAXCONN || 100)).length}  of ${N}`);

// STALE EDGES (gated-lookup failure hypothesis): synapse entries whose
// transport channel is NOT connected — refuse-and-close asymmetry leaves
// the far end routing into a dead edge.
let staleTotal = 0, nodesWithStale = 0;
const staleCounts = [];
for (const n of eng.nodeMap.values()) {
  let stale = 0;
  for (const peerId of n.synaptome.keys()) {
    try { if (n.transport?.isConnected && !n.transport.isConnected(peerId)) stale++; } catch { /* */ }
  }
  staleCounts.push(stale);
  staleTotal += stale;
  if (stale > 0) nodesWithStale++;
}
console.log(`STALE synapse edges (channel closed): total=${staleTotal} nodesAffected=${nodesWithStale}/${N} ${dist(staleCounts)}`);

// LOOKUP SUCCESS (the gated 2–10% failure question). With ARM_FULL=1 the
// maintenance ticks need wall-clock to refill refusal holes first.
if (process.env.ARM_FULL === '1') {
  console.log('settling 25s for maintenance refills…');
  await new Promise(r => setTimeout(r, 25000));
  const sizes2 = [...eng.nodeMap.values()].map(n => n.synaptome.size);
  console.log(`post-maintenance synaptome: ${dist(sizes2)}`);
}
const nodes = [...eng.nodeMap.values()];
const L = +(process.env.LOOKUPS || 500);
let ok = 0, fail = 0, err = 0; let sampleErr = null;
const failures = [];
for (let i = 0; i < L; i++) {
  const a = nodes[Math.floor(Math.random() * nodes.length)];
  const b = nodes[Math.floor(Math.random() * nodes.length)];
  if (a === b) { i--; continue; }
  try {
    const r = await eng.lookup(a.id, b.id);
    if (r && (r.found === true || r.success === true || r === b || r?.id === b.id)) ok++;
    else {
      fail++;
      failures.push({ r: JSON.stringify(r, (k, v) => typeof v === 'bigint' ? v.toString(16).slice(0, 12) + '…' : v)?.slice(0, 140),
        srcDeg: a.synaptome.size, dstDeg: b.synaptome.size });
    }
  } catch (e) { err++; if (!sampleErr) sampleErr = e.message; }
}
console.log(`LOOKUPS: ${ok}/${L} ok  fail=${fail} err=${err}${sampleErr ? '  sampleErr=' + sampleErr : ''}`);
if (failures.length) {
  const degs = [...eng.nodeMap.values()].map(n => n.synaptome.size);
  const popAvg = (degs.reduce((s, x) => s + x, 0) / degs.length).toFixed(1);
  console.log(`FAILURE FORENSICS (population avg degree ${popAvg}):`);
  for (const f of failures.slice(0, 8)) console.log(`  srcDeg=${f.srcDeg} dstDeg=${f.dstDeg} result=${f.r}`);
}
process.exit(0);

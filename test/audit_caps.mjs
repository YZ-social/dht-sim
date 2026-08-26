// audit_caps.mjs — is the Axona benchmark cheating on connection/synaptome caps?
// Builds the transport engine at the BROWSER's exact benchmark config and
// measures, per node: synaptome.size, incomingSynapses.size, connections.size.
// Production invariant (v2.17.1): synaptome + incoming <= _maxSynaptome (50)
// SHARED; physical connections <= maxConnections (100).
//   node test/audit_caps.mjs            (N=500, hashBits=56, maxConn=100)
import { TransportAxonaEngine } from '../src/dht/neuromorphic/TransportAxonaEngine.js';

const N = +(process.env.N || 500);
const eng = new TransportAxonaEngine({ k: 20, alpha: 3, bits: 64, geoBits: 8, hashBits: 56 });
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
process.exit(0);

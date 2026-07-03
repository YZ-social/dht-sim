// =====================================================================
// smoke_bridge_introduce.mjs — W2 B1: bridgeIntroduce(newId, anchorIds[]).
//
// Proves the anchor-set generalization of bootstrapJoin: a newcomer that
// is NOT in anyone's routing table is introduced to only k curated
// anchors, self-expands the frontier from that seed set, and becomes
// (a) synaptome-filled and (b) INBOUND-reachable — a random mesh node
// can lookup() it. This is the sim primitive the bridge-nursery rides on.
//
//   1. k=3 anchor introduce → newcomer gains synapses, _joinAnchors===3,
//      and is reachable from an unrelated mesh node
//   2. bootstrapJoin(newId, sponsor) still works (k=1 wrapper)
//   3. empty / dead anchor set → 0 (no crash)
//
// Run:  node test/smoke_bridge_introduce.mjs
// =====================================================================

import { TransportAxonaEngine } from '../src/dht/neuromorphic/TransportAxonaEngine.js';

let passed = 0, failed = 0;
const check = (label, cond) => {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else      { console.log(`  ✗ ${label}`); failed++; }
};
const rand = (min, max) => min + Math.random() * (max - min);

// Deterministic-enough spread so anchors land in different keyspace regions.
async function warmMesh(N) {
  const eng = new TransportAxonaEngine({ k: 20, geoBits: 8 });
  for (let i = 0; i < N; i++) await eng.addNode(rand(-60, 60), rand(-180, 180));
  await eng.buildRoutingTables({ bidirectional: true });
  return eng;
}

// Add one isolated node AFTER the mesh is built → it is in no routing table.
async function addNewcomer(eng) {
  const before = new Set(eng.nodeMap.keys());
  await eng.addNode(rand(-60, 60), rand(-180, 180));
  const id = [...eng.nodeMap.keys()].find(x => !before.has(x));
  return id;
}

// Faithful INBOUND reachability = how many OTHER live nodes reference
// this id in their routing tables (synaptome or incomingSynapses). This
// is the honest "reachability lives in a newcomer's neighbours' tables"
// metric. We deliberately do NOT use eng.lookup() as a reachability
// probe: the sim transport's final hop can dial any registered node
// (god's-eye), so lookup "reaches" even an isolated node — AND the probe
// itself contaminates state by causing edges to be recorded. Structural
// ref-counting is sim-artifact-free and deterministic.
function inboundRefs(eng, id) {
  let r = 0;
  for (const n of eng.nodeMap.values()) {
    if (n.id === id) continue;
    if (n.synaptome.has(id) || n.incomingSynapses.has(id)) r++;
  }
  return r;
}

async function testAnchorSetIntroduce() {
  console.log('\n── k=3 anchor-set introduce → fill + inbound reachability ──');
  const eng = await warmMesh(40);
  const meshIds = [...eng.nodeMap.keys()];
  const newId = await addNewcomer(eng);
  const newcomer = eng.nodeMap.get(newId);

  check('newcomer starts isolated (0 outbound synapses)', newcomer.synaptome.size === 0);
  check('newcomer starts with 0 inbound refs (nobody knows it)',
    inboundRefs(eng, newId) === 0);

  // Pick 3 live anchors spread across the id space (min / mid / max).
  const sorted = meshIds.slice().sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const anchors = [sorted[0], sorted[sorted.length >> 1], sorted[sorted.length - 1]];

  const reach = await eng.bridgeIntroduce(newId, anchors);
  check('introduce installed synapses (reach > 0)', reach > 0);
  check('_joinAnchors records the anchor count', newcomer._joinAnchors === 3);
  check('_joinReach === synaptome size', newcomer._joinReach === newcomer.synaptome.size);
  check('newcomer synaptome grew', newcomer.synaptome.size > 0);

  // Inbound reachability: after introduce, other nodes reference the
  // newcomer in their tables — it lives in its neighbours' routing state.
  check('newcomer gained inbound refs (> anchor count)',
    inboundRefs(eng, newId) > anchors.length);
}

async function testBootstrapJoinWrapper() {
  console.log('\n── bootstrapJoin(newId, sponsor) — k=1 wrapper still works ──');
  const eng = await warmMesh(40);
  const meshIds = [...eng.nodeMap.keys()];
  const newId = await addNewcomer(eng);
  const newcomer = eng.nodeMap.get(newId);

  check('newcomer starts with 0 inbound refs', inboundRefs(eng, newId) === 0);
  const reach = await eng.bootstrapJoin(newId, meshIds[0]);
  check('single-sponsor join installed synapses', reach > 0);
  check('_joinAnchors === 1 for single sponsor', newcomer._joinAnchors === 1);
  check('newcomer gained inbound refs after single-sponsor join',
    inboundRefs(eng, newId) > 0);
}

async function testDegenerateAnchors() {
  console.log('\n── empty / invalid anchor set → 0, no crash ──');
  const eng = await warmMesh(10);
  const newId = await addNewcomer(eng);
  check('empty anchor array → 0',     (await eng.bridgeIntroduce(newId, [])) === 0);
  check('unknown anchor id → 0',      (await eng.bridgeIntroduce(newId, ['deadbeef'])) === 0);
  check('newcomer still isolated',    eng.nodeMap.get(newId).synaptome.size === 0);
}

await testAnchorSetIntroduce();
await testBootstrapJoinWrapper();
await testDegenerateAnchors();

console.log(`\n${failed ? '✗' : '✓'} smoke_bridge_introduce: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

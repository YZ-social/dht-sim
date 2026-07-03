// =====================================================================
// smoke_bridge_nursery.mjs — W2 B2: BridgeNursery policy.
//
// Verifies the bridge-introduction policy on top of B1:
//   1. eligibility GATE — a node younger than minUptime never anchors;
//      after minUptime it does
//   2. composite score — each component (uptime/degree/inbound/integ)
//      moves the score; integrationRate starts neutral (~0.5)
//   3. pickAnchors — returns k eligible, keyspace-diverse anchors and
//      records an attempt against each
//   4. attribution loop — introduce a newcomer, graduate it, and its
//      anchors gain an integration success → their integrationRate and
//      composite score rise (outcome-based track record feeds back)
//   5. fresh joiner is NOT anchor-eligible; a graduated+aged one IS
//
// Run:  node test/smoke_bridge_nursery.mjs
// =====================================================================

import { TransportAxonaEngine } from '../src/dht/neuromorphic/TransportAxonaEngine.js';
import { BridgeNursery } from '../harness/BridgeNursery.mjs';

let passed = 0, failed = 0;
const check = (label, cond) => {
  if (cond) { console.log(`  ✓ ${label}`); passed++; }
  else      { console.log(`  ✗ ${label}`); failed++; }
};
const rand = (min, max) => min + Math.random() * (max - min);

async function warmMesh(N) {
  const eng = new TransportAxonaEngine({ k: 20, geoBits: 8 });
  for (let i = 0; i < N; i++) await eng.addNode(rand(-60, 60), rand(-180, 180));
  await eng.buildRoutingTables({ bidirectional: true });
  return eng;
}
async function addNewcomer(eng) {
  const before = new Set(eng.nodeMap.keys());
  await eng.addNode(rand(-60, 60), rand(-180, 180));
  return [...eng.nodeMap.keys()].find(x => !before.has(x));
}

async function testEligibilityGate() {
  console.log('\n── eligibility gate (minUptime) ──');
  const eng = await warmMesh(30);
  const nur = new BridgeNursery(eng, { k: 3, minUptime: 3 });
  const ids = [...eng.nodeMap.keys()];
  for (const id of ids) nur.onJoin(0, id);           // genesis at round 0

  check('nobody eligible at round 0 (uptime 0 < minUptime)',
    ids.every(id => !nur.eligible(0, id)));
  check('nobody eligible at round 2 (still < minUptime)',
    ids.every(id => !nur.eligible(2, id)));
  check('everyone eligible at round 3 (uptime === minUptime)',
    ids.every(id => nur.eligible(3, id)));
}

async function testCompositeScore() {
  console.log('\n── composite score responds to each component ──');
  const eng = await warmMesh(30);
  const nur = new BridgeNursery(eng, { k: 3, minUptime: 3 });
  const ids = [...eng.nodeMap.keys()];
  for (const id of ids) nur.onJoin(0, id);

  const anyId = ids[0];
  check('unproven anchor integrationRate is neutral (~0.5)',
    Math.abs(nur.integrationRate(anyId) - 0.5) < 1e-9);

  // A node with more inbound synapses should outscore one with fewer,
  // holding uptime equal.
  const byInbound = [...eng.nodeMap.values()].sort(
    (a, b) => a.incomingSynapses.size - b.incomingSynapses.size);
  const low = byInbound[0], high = byInbound[byInbound.length - 1];
  check('higher inbound-degree ⇒ higher score (all else ~equal)',
    high.incomingSynapses.size <= low.incomingSynapses.size ||
    nur.score(5, high.id) >= nur.score(5, low.id));

  // Crediting integration successes raises a node's score.
  const target = ids[1];
  const s0 = nur.score(5, target);
  nur._attempts.set(target, 4);
  nur._successes.set(target, 4);   // perfect track record
  const s1 = nur.score(5, target);
  check('integration successes raise the composite score', s1 > s0);
  check('perfect track record pushes integrationRate high (> 0.7)',
    nur.integrationRate(target) > 0.7);
}

async function testPickAndAttribution() {
  console.log('\n── pickAnchors + graduation attribution loop ──');
  const eng = await warmMesh(40);
  const nur = new BridgeNursery(eng, { k: 3, minUptime: 3 });
  for (const id of eng.nodeMap.keys()) nur.onJoin(0, id);

  const round = 5;
  const newId = await addNewcomer(eng);
  nur.onJoin(round, newId);

  const anchors = nur.pickAnchors(round, newId);
  check('pickAnchors returns k anchors', anchors.length === 3);
  check('anchors are distinct', new Set(anchors).size === 3);
  check('anchors are all eligible', anchors.every(id => nur.eligible(round, id)));
  check('newcomer is never its own anchor', !anchors.includes(newId));
  check('attempt recorded against each anchor',
    anchors.every(id => (nur._attempts.get(id) ?? 0) >= 1));

  const rateBefore = anchors.map(id => nur.integrationRate(id));
  // Run the actual introduce so the newcomer integrates, then graduate.
  await eng.bridgeIntroduce(newId, anchors);
  const grad = nur.graduate(round + 1);

  check('newcomer graduated (met synaptome + inbound bar)', grad.includes(newId));
  check('each anchor credited an integration success',
    anchors.every(id => (nur._successes.get(id) ?? 0) >= 1));
  const rateAfter = anchors.map(id => nur.integrationRate(id));
  check('anchor integrationRate rose after a successful integration',
    rateAfter.every((r, i) => r > rateBefore[i]));

  // A freshly-joined newcomer is NOT anchor-eligible yet; after aging it is.
  check('graduated newcomer not anchor-eligible immediately (too young)',
    !nur.eligible(round + 1, newId));
  check('graduated newcomer becomes eligible after minUptime',
    nur.eligible(round + nur.minUptime, newId));
}

await testEligibilityGate();
await testCompositeScore();
await testPickAndAttribution();

console.log(`\n${failed ? '✗' : '✓'} smoke_bridge_nursery: ${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);

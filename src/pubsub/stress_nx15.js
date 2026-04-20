/**
 * stress_nx15.js — scale reproduction for the hang the user sees in the
 * browser benchmark. Spins up a modest NX-15 DHT, pre-registers axons,
 * subscribes hundreds of participants to multiple topics, then runs
 * publish + refresh + churn. Logs progress at every phase so we can see
 * where it stalls.
 *
 * Run:  node src/pubsub/stress_nx15.js
 */

import { NeuromorphicDHTNX15 } from '../dht/neuromorphic/NeuromorphicDHTNX15.js';
import { PubSubAdapter } from './PubSubAdapter.js';

const NODES = Number(process.argv[2]) || 2000;
const COVERAGE = Number(process.argv[3]) || 0.10;
const GROUP_SIZE = Number(process.argv[4]) || 500;
const K = 5;
const MAX_SUBS = 20;

function now() { return Date.now(); }
function elapsed(start) { return ((Date.now() - start) / 1000).toFixed(2); }

async function main() {
  const t0 = now();
  console.log(`[${elapsed(t0)}s] Creating NX-15 with ${NODES} nodes …`);

  const dht = new NeuromorphicDHTNX15({
    k: 20, alpha: 3, bits: 64,
    membership: { rootSetSize: K, maxDirectSubs: MAX_SUBS },
  });

  let seed = 42;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let i = 0; i < NODES; i++) {
    const lat = -60 + rand() * 120;
    const lng = -180 + rand() * 360;
    await dht.addNode(lat, lng);
  }
  console.log(`[${elapsed(t0)}s] Built ${NODES} nodes. Building routing tables…`);
  await dht.buildRoutingTables({ bidirectional: true, maxConnections: Math.min(NODES - 1, 50) });
  console.log(`[${elapsed(t0)}s] Routing tables built.`);

  const aliveNodes = dht.getNodes().filter(n => n.alive);
  const target = Math.ceil(aliveNodes.length * COVERAGE);
  const numGroups = Math.max(1, Math.ceil(target / GROUP_SIZE));
  const shuffled = [...aliveNodes].sort(() => rand() - 0.5);
  const stride = Math.max(1, Math.floor(shuffled.length / numGroups));
  const groups = [];
  for (let i = 0; i < numGroups; i++) {
    const base = (i * stride) % shuffled.length;
    const relay = shuffled[base];
    const participants = [];
    for (let j = 1; j <= GROUP_SIZE; j++) participants.push(shuffled[(base + j) % shuffled.length]);
    groups.push({ id: i, relay, participants });
  }
  console.log(`[${elapsed(t0)}s] Groups built: ${numGroups} × ${GROUP_SIZE} participants each.`);

  console.log(`[${elapsed(t0)}s] Pre-registering axons on all ${aliveNodes.length} nodes…`);
  for (const node of aliveNodes) dht.axonFor(node);
  console.log(`[${elapsed(t0)}s] Axons registered.`);

  const entries = new Map();
  const getEntry = (node) => {
    let e = entries.get(node.id);
    if (e) return e;
    e = {
      node,
      adapter: new PubSubAdapter({ transport: dht.axonFor(node) }),
      deliveries: new Map(),
    };
    entries.set(node.id, e);
    return e;
  };

  console.log(`[${elapsed(t0)}s] Subscribing participants…`);
  let subCount = 0;
  for (const group of groups) {
    const gKey = 'g' + group.id;
    for (const p of group.participants) {
      const entry = getEntry(p);
      entry.deliveries.set(group.id, false);
      entry.adapter.subscribe('bench', gKey, () => { entry.deliveries.set(group.id, true); }, 'immediate');
      subCount++;
      if (subCount % 200 === 0) console.log(`[${elapsed(t0)}s]   ${subCount} subscribers registered…`);
    }
    getEntry(group.relay);
  }
  console.log(`[${elapsed(t0)}s] All ${subCount} subscribers registered.`);

  const runOneTick = (label) => {
    const tick0 = now();
    for (const e of entries.values()) {
      if (!e.node.alive) continue;
      for (const gid of e.deliveries.keys()) e.deliveries.set(gid, false);
    }
    for (const group of groups) {
      if (!group.relay.alive) continue;
      const gKey = 'g' + group.id;
      getEntry(group.relay).adapter.publish('bench', gKey, {});
    }
    let delivered = 0, expected = 0;
    for (const group of groups) {
      for (const p of group.participants) {
        if (!p.alive) continue;
        expected++;
        if (entries.get(p.id).deliveries.get(group.id)) delivered++;
      }
    }
    console.log(`[${elapsed(t0)}s] Tick ${label}: ${delivered}/${expected} delivered in ${((now()-tick0)/1000).toFixed(2)}s`);
    return { delivered, expected };
  };

  for (let t = 0; t < 3; t++) runOneTick(`warmup-${t+1}`);
  for (let t = 0; t < 3; t++) runOneTick(`baseline-${t+1}`);

  // Report axon sizes for diagnostics.
  let totalRoles = 0, maxChildren = 0;
  for (const axon of dht._axonsByNode.values()) {
    for (const role of axon.axonRoles.values()) {
      totalRoles++;
      if (role.children.size > maxChildren) maxChildren = role.children.size;
    }
  }
  console.log(`[${elapsed(t0)}s] Axon state: ${totalRoles} roles, max children on any axon = ${maxChildren}`);

  console.log(`[${elapsed(t0)}s] DONE`);
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });

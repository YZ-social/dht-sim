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
import { PubSubAdapter, topicIdFor } from './PubSubAdapter.js';

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
    console.log(`[${elapsed(t0)}s] Tick ${label}: publishing…`);
    for (const group of groups) {
      if (!group.relay.alive) continue;
      const gKey = 'g' + group.id;
      const pubStart = now();
      getEntry(group.relay).adapter.publish('bench', gKey, {});
      const pubMs = now() - pubStart;
      if (pubMs > 100) console.log(`[${elapsed(t0)}s]   group ${group.id} publish took ${pubMs}ms`);
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

  // Diagnostic: for each group topic, count roles held across the network
  // and report how many are "live" (isRoot=true), how many sub-axon.
  const snapshotTopics = (label) => {
    for (const group of groups) {
      const tid = topicIdFor('bench', 'g' + group.id);
      let rootCount = 0, subCount = 0, totalChildren = 0, liveTargetsHoldingRole = 0;
      for (const [n, axon] of dht._axonsByNode) {
        const role = axon.axonRoles.get(tid);
        if (!role) continue;
        if (role.isRoot) rootCount++; else subCount++;
        totalChildren += role.children.size;
        if (n.alive) liveTargetsHoldingRole++;
      }
      // Also: what does the publisher's findKClosest return?
      const pubKList = dht.axonFor(group.relay).dht.findKClosest(tid, K);
      let pubKHasRole = 0;
      for (const peerHex of pubKList) {
        // peerHex is hex string — find the node.
        for (const [n, axon] of dht._axonsByNode) {
          const nHex = n.id.toString(16).padStart(16, '0');
          if (nHex === peerHex && axon.axonRoles.has(tid)) pubKHasRole++;
        }
      }
      console.log(`[${elapsed(t0)}s]   topic g${group.id} [${label}]: roots=${rootCount}, subaxons=${subCount}, live-holders=${liveTargetsHoldingRole}, totalChildren=${totalChildren}, pubK-with-role=${pubKHasRole}/${pubKList.length}`);
    }
  };

  for (let t = 0; t < 3; t++) runOneTick(`warmup-${t+1}`);
  for (let t = 0; t < 3; t++) runOneTick(`baseline-${t+1}`);
  snapshotTopics('pre-kill');

  // ─── Full pubsubmchurn lifecycle: kill 25%, measure, refresh, re-measure ───
  const churnRate = 0.25;
  const publisherIds = new Set(groups.map(g => g.relay.id));
  const killable = aliveNodes.filter(n => !publisherIds.has(n.id));
  killable.sort(() => rand() - 0.5);
  const killTarget = Math.floor(aliveNodes.length * churnRate);
  console.log(`[${elapsed(t0)}s] Killing ${killTarget} nodes (${(churnRate*100).toFixed(0)}% churn, excluding publishers)…`);
  for (let i = 0; i < killTarget; i++) killable[i].alive = false;

  snapshotTopics('immediately-after-kill');
  for (let t = 0; t < 3; t++) runOneTick(`immediate-${t+1}`);

  console.log(`[${elapsed(t0)}s] Driving refresh ticks on all surviving axons…`);
  const refreshStart = now();
  for (let r = 0; r < 3; r++) {
    let calls = 0;
    for (const node of aliveNodes) {
      if (!node.alive) continue;
      dht.axonFor(node).refreshTick();
      calls++;
    }
    console.log(`[${elapsed(t0)}s]   refresh round ${r+1}: ${calls} refreshTick calls in ${((now()-refreshStart)/1000).toFixed(2)}s`);
  }

  snapshotTopics('post-refresh');
  for (let t = 0; t < 3; t++) runOneTick(`recovered-${t+1}`);

  // Report final axon sizes for diagnostics.
  let totalRoles = 0, maxChildren = 0;
  for (const axon of dht._axonsByNode.values()) {
    for (const role of axon.axonRoles.values()) {
      totalRoles++;
      if (role.children.size > maxChildren) maxChildren = role.children.size;
    }
  }
  console.log(`[${elapsed(t0)}s] Final axon state: ${totalRoles} roles, max children on any axon = ${maxChildren}`);

  console.log(`[${elapsed(t0)}s] DONE`);
}

main().catch(err => { console.error('FATAL:', err); process.exit(1); });

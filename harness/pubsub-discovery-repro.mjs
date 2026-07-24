// =====================================================================
// pubsub-discovery-repro.mjs — A/B/C repro of the cross-region pub/sub
// discovery collapse (kernel 4.38), with a faithful peer-to-peer recovery arm.
//
// HYPOTHESIS: peers that share a bridge but never discover EACH OTHER cause
// every durability mechanism to collapse. A region-B publisher can't find the
// region-A hosts, self-roots the region-A topics as a SINGLETON (no replicas),
// and a fresh region-B subscriber can't route to the real root. The single
// lever is routing-table discovery — and the fix must be PEER-TO-PEER, never
// bridge-mediated introduction (a bridge that must know/introduce peers has
// re-created a central server, and is wrong by construction).
//
// Topology (per arm, fresh SimNetwork):
//   Region A (geo-prefix 0x89): 3 HOST peers that peer.host() ~10 region-A
//                               topics, plus DECOY_A filler peers.
//   Region B (geo-prefix 0x60): 1 PUBLISHER + 1 (separate) SUBSCRIBER, plus
//                               DECOY_B filler peers.
//   Topics are anchored in region A (topic id geo-byte == hosts' node geo-byte),
//   so the hosts are the topic-closest nodes. Decoys are non-hosting,
//   non-subscribing mesh participants — routing substrate only.
//
// SEED arms:
//   full        (control / upper bound) — omniscient XOR routing mesh across ALL
//                 working peers; everyone can discover everyone.
//   star        (starvation lower bound) — every working peer knows ONLY a shared
//                 EMPTY bridge (marked transport.bridgeNodeIdBig = signaling
//                 infra, excluded from routing); the bridge introduces nobody.
//   bootstrap-kN (THE arm that matters) — each peer is seeded with ONLY a SMALL
//                 RANDOM SAMPLE of N live peers (a bridge welcome-frame handing
//                 out N random known peers — NOT the XOR neighborhood, NOT
//                 everyone). The bridge is then NEVER consulted again: no bridge
//                 entries in routing tables, nothing routes through it. Each peer
//                 runs the production join self-lookup (peer.integrate()) and the
//                 kernel's periodic refreshTick discovery. QUESTION: does Axona's
//                 PEER-TO-PEER discovery self-organize so the publisher's
//                 findKClosest(region-A topic) surfaces the region-A hosts and
//                 delivery converges — using only P2P lookup/gossip/synaptome?
//   bridge-knows-all (ANTI-PATTERN, off by default) — peers know only the bridge
//                 and the BRIDGE holds a full table. Kept ONLY to show the bridge
//                 can mask the bug precisely because it became the authority —
//                 this is what we must NOT rely on. Not a fix.
//
//   node harness/pubsub-discovery-repro.mjs                       # default arms
//   ARMS=bootstrap-k3 node harness/pubsub-discovery-repro.mjs      # one arm
//   ARMS=full,star,bootstrap-k3,bootstrap-k5,bridge-knows-all ...  # everything
//
// Env: ARMS, TOPICS(10), DECOY_A(10), DECOY_B(10), SETTLE(2500),
//      DELIVER(3000), DISCOVER(3500), REFRESH(700), RNG_SEED(1337).
// =====================================================================

import {
  AxonaPeer, AxonaDomain, NeuronNode, Synapse, SimNetwork, simTransport,
  createNodeIdentity, createAuthorIdentity, deriveTopicId, clz264, KERNEL_VERSION,
} from '@axona/protocol';
import { buildXorRoutingTable } from '@axona/protocol/utils/geo.js';
import { regionNameForLatLng } from '@axona/protocol/utils/region-names.js';
import { extractS2Prefix } from '@axona/protocol/utils/hexid.js';

const K       = +(process.env.K || 20);
const TOPICS  = +(process.env.TOPICS || 10);
const DECOY_A = +(process.env.DECOY_A || 10);
const DECOY_B = +(process.env.DECOY_B || 10);
const SETTLE  = +(process.env.SETTLE || 2500);    // after publish, before subscribe
const DELIVER = +(process.env.DELIVER || 3000);   // after subscribe, before measuring replay
const DISCOVER= +(process.env.DISCOVER || 3500);  // P2P discovery window after seed+integrate (bootstrap)
const REFRESH = +(process.env.REFRESH || 700);
const RNG_SEED= +(process.env.RNG_SEED || 1337);
const ARMS    = (process.env.ARMS || 'full,star,bootstrap-k3,bootstrap-k5').split(',').map(s => s.trim());
const wait = (ms) => new Promise(r => setTimeout(r, ms));

// Deterministic PRNG (mulberry32) so the random welcome sample + jitter reproduce.
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Region A (hosts + topics): Washington DC cluster → geo-prefix 0x89 (eagle).
// Region B (publisher + subscriber + bridge): Tokyo cluster → geo-prefix 0x60.
const REGION_A = { lat: 38.90, lng: -77.00 };
const REGION_B = { lat: 35.68, lng: 139.76 };
const REGION_A_NAME = regionNameForLatLng(REGION_A.lat, REGION_A.lng);

console.log(`[harness] kernel v${KERNEL_VERSION}  arms=[${ARMS.join(', ')}]  topics=${TOPICS}  decoys A/B=${DECOY_A}/${DECOY_B}`);
console.log(`[harness] regionA='${REGION_A_NAME}' (hosts+topics) vs regionB (pub+sub+bridge)`);

const toBig = (hex) => BigInt('0x' + hex);

async function mkPeer(network, domain, lat, lng, tag) {
  const identity  = await createNodeIdentity({ lat, lng });
  const transport = simTransport({ network, identity, heartbeatMs: 0 });
  await transport.start(identity.id);
  const node = new NeuronNode({ id: toBig(identity.id), lat, lng });
  node.transport = transport;
  const peer = new AxonaPeer({ domain, node, nodeIdentity: identity, transport });
  await peer.start();
  peer._requireAxonaManager?.('repro-init');
  return { peer, node, transport, hex: identity.id, big: node.id, tag };
}

function mkSynapse(fromBig, n) {
  const syn = new Synapse({ peerId: n.big, latencyMs: 1, stratum: clz264(fromBig ^ n.big) });
  syn.weight = 0.5; syn.inertia = 0; syn._addedBy = 'repro';
  return syn;
}
async function setNeighbors(p, neighbors) {
  p.node.synaptome.clear();
  for (const n of neighbors) { if (n.big !== p.big) p.node.synaptome.set(n.big, mkSynapse(p.big, n)); }
}
async function openTo(p, targets) {
  for (const t of targets) {
    if (t.big === p.big) continue;
    try { await p.peer._transport.openConnection(t.hex); } catch { /* ignore */ }
  }
}

async function runArm(seed) {
  const rng = mulberry32(RNG_SEED + seed.length);   // per-arm deterministic stream
  const jit = (base, i) => base + (i * 0.008) + rng() * 0.004;
  const network = new SimNetwork();
  const domain  = new AxonaDomain({ k: K });

  // ── Build peers ─────────────────────────────────────────────────────
  const bridge = await mkPeer(network, domain, jit(REGION_B.lat, 99), jit(REGION_B.lng, 99), 'bridge');
  const hosts = [];
  for (let i = 0; i < 3; i++) hosts.push(await mkPeer(network, domain, jit(REGION_A.lat, i), jit(REGION_A.lng, i), `host${i}`));
  const publisher  = await mkPeer(network, domain, jit(REGION_B.lat, 0), jit(REGION_B.lng, 0), 'publisher');
  const subscriber = await mkPeer(network, domain, jit(REGION_B.lat, 3), jit(REGION_B.lng, 3), 'subscriber');
  const decoysA = [], decoysB = [];
  for (let i = 0; i < DECOY_A; i++) decoysA.push(await mkPeer(network, domain, jit(REGION_A.lat, 10 + i), jit(REGION_A.lng, 10 + i), `decoyA${i}`));
  for (let i = 0; i < DECOY_B; i++) decoysB.push(await mkPeer(network, domain, jit(REGION_B.lat, 10 + i), jit(REGION_B.lng, 10 + i), `decoyB${i}`));
  const working = [...hosts, publisher, subscriber, ...decoysA, ...decoysB];
  const all = [bridge, ...working];

  // Warn-log tallies across ALL peers. NOTE: match by SUFFIX — the kernel emits
  // singleton-root-confirm with a doubled prefix ('pubsub:pubsub:singleton-root-
  // confirm') because wireHandlers passes an already-'pubsub:'-prefixed event
  // into _log(), which prepends 'pubsub:' again. drop-topic-mismatch is single-
  // prefixed ('pubsub:drop-topic-mismatch'). Suffix-match catches both robustly.
  let singletonConfirm = 0, dropMismatch = 0;
  const endsWith = (msg, s) => typeof msg === 'string' && msg.endsWith(s);
  for (const p of all) p.peer.onLog('warn', (msg) => {
    if (endsWith(msg, 'singleton-root-confirm')) singletonConfirm++;
    else if (endsWith(msg, 'drop-topic-mismatch')) dropMismatch++;
  });

  // Arm the manager refresh loop (production parity: refreshTick discovery/repair).
  for (const p of all) { const am = p.peer._axonaManager; if (am) { am.refreshIntervalMs = REFRESH; am.start?.(); } }

  const hostBigs = new Set(hosts.map(h => h.big));
  let pubSeedHadHost = null;   // bootstrap diagnostic

  // ── Seed the routing substrate per arm ──────────────────────────────
  if (seed === 'full') {
    const sorted = working.map(p => p.node).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    for (const p of working) {
      const cands = buildXorRoutingTable(p.node.id, sorted, K, Infinity);
      await setNeighbors(p, cands.map(c => working.find(w => w.big === c.id)).filter(Boolean));
    }
    for (const p of working) await openTo(p, working);

  } else if (seed === 'star' || seed === 'bridge-knows-all') {
    for (const p of working) {
      await setNeighbors(p, [bridge]);
      p.transport.bridgeNodeIdBig = bridge.big;   // faithful: the bridge is signaling infra
      await openTo(p, [bridge]);
    }
    if (seed === 'bridge-knows-all') {
      const sorted = working.map(p => p.node).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      const cands = buildXorRoutingTable(bridge.node.id, sorted, K, Infinity);
      await setNeighbors(bridge, cands.map(c => working.find(w => w.big === c.id)).filter(Boolean));
      await openTo(bridge, working);
    } else {
      await setNeighbors(bridge, []);   // star: the bridge introduces NOBODY
    }

  } else if (seed.startsWith('bootstrap')) {
    // Welcome frame: K_SEED random live peers per node (region-mixed, like a
    // global bridge). Then the bridge is NEVER consulted again — no bridge entry
    // in any routing table, nothing routes through it. Pure peer-to-peer from here.
    const kSeed = +(seed.split('-k')[1] || 3);
    for (const p of working) {
      const pool = working.filter(w => w.big !== p.big);
      // Fisher-Yates partial shuffle with the deterministic RNG.
      for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
      const sample = pool.slice(0, kSeed);
      await setNeighbors(p, sample);
      await openTo(p, sample);
      if (p === publisher) pubSeedHadHost = sample.some(s => hostBigs.has(s.big));
    }
    // Production join path: each freshly-seeded peer runs the network self-lookup
    // (findKClosest(self) → verified-connect its self-neighborhood). Then let the
    // kernel's own P2P discovery (refreshTick + iterative _rootHint_ lookups) run.
    await Promise.all(working.map(p => p.peer.integrate?.().catch(() => {})));
    await wait(DISCOVER);
  }
  await wait(200);

  // ── Topics anchored in region A ─────────────────────────────────────
  const topics = [];
  for (let i = 0; i < TOPICS; i++) {
    const desc = { region: REGION_A_NAME, name: `crisis-${i}` };
    const idHex = await deriveTopicId(desc);
    topics.push({ desc, idHex, big: toBig(idHex) });
  }
  const hostPrefix  = extractS2Prefix(hosts[0].big);
  const topicPrefix = extractS2Prefix(topics[0].big);
  const pubPrefix   = extractS2Prefix(publisher.big);
  const prefixOk = hostPrefix === topicPrefix && pubPrefix !== topicPrefix;

  // ── Hosts host() every region-A topic ───────────────────────────────
  for (const h of hosts) for (const t of topics) {
    try { await h.peer.host(t.desc); } catch (e) { console.log(`[${seed}] host() threw: ${e.message}`); }
  }

  // ── Publisher publishes every topic ─────────────────────────────────
  const author = await createAuthorIdentity();
  for (const t of topics) {
    await publisher.peer.pub(t.desc, `alert on ${t.desc.name}`, { signWith: author });
  }
  await wait(SETTLE);   // refreshTick retry loop re-sends stranded publishes toward the true root

  // ── Can the publisher's pub/sub layer SEE a region-A host? ───────────
  // Uses the SAME local-only adapter findKClosest that root selection reads.
  const am = publisher.peer._axonaManager;
  let topicsSeeingHost = 0;
  for (const t of topics) {
    const kc = await am.dht.findKClosest(t.big, 8);
    if (kc.some(x => hostBigs.has(typeof x === 'bigint' ? x : toBig(x)))) topicsSeeingHost++;
  }
  const pubSingleton  = publisher.peer._axonaManager.inspectHosting().singletonRoots;
  const hostSingleton = hosts.reduce((s, h) => s + h.peer._axonaManager.inspectHosting().singletonRoots, 0);

  // ── Fresh subscriber subscribes to all topics (durable replay) ──────
  const delivered = new Set();
  for (const t of topics) {
    await subscriber.peer.sub(t.desc, (env) => { if (env?.msgId) delivered.add(t.idHex); }, { since: 'all' });
    await wait(5);
  }
  await wait(DELIVER);   // read-repair re-homes a stuck subscriber toward the true root
  const deliveryPct = +(100 * delivered.size / topics.length).toFixed(1);

  for (const p of all) { try { await p.peer.stop?.(); } catch {} }

  return {
    seed, prefixOk,
    topicPrefix: '0x' + topicPrefix.toString(16), pubPrefix: '0x' + pubPrefix.toString(16),
    pubSingleton, hostSingleton, topicsSeeingHost, topicCount: topics.length,
    delivered: delivered.size, deliveryPct, pubSeedHadHost,
    singletonConfirm, dropMismatch,
  };
}

// ── Run the arms ──────────────────────────────────────────────────────
const results = [];
for (const seed of ARMS) {
  process.stdout.write(`\n[run] arm='${seed}' … `);
  const r = await runArm(seed);
  const extra = r.pubSeedHadHost === null ? '' : `, pubSeedHadHost=${r.pubSeedHadHost}`;
  process.stdout.write(`done (delivery ${r.deliveryPct}%, pubSingleton ${r.pubSingleton}, seesHost ${r.topicsSeeingHost}/${r.topicCount}${extra})\n`);
  results.push(r);
}

// ── Summary table ─────────────────────────────────────────────────────
console.log('\n=============================================== SUMMARY ===============================================');
console.log('arm               | singleR(pub) | seesHost? | delivery% | singleton-confirm | drop-mismatch');
console.log('------------------+--------------+-----------+-----------+-------------------+--------------');
for (const r of results) {
  const seesHost = `${r.topicsSeeingHost}/${r.topicCount}`;
  console.log(
    `${r.seed.padEnd(17)} | ${String(r.pubSingleton).padStart(12)} | ${seesHost.padStart(9)} | ${(r.deliveryPct + '%').padStart(9)} | ${String(r.singletonConfirm).padStart(17)} | ${String(r.dropMismatch).padStart(12)}`
  );
}
console.log('======================================================================================================');
console.log(`\nprefix control: hosts/topics=${results[0].topicPrefix}  publisher=${results[0].pubPrefix}  (aligned & cross-region: ${results.every(r => r.prefixOk)})`);
for (const r of results) if (r.pubSeedHadHost !== null) console.log(`  [${r.seed}] publisher's random welcome sample directly included a region-A host: ${r.pubSeedHadHost}`);
console.log('legend: singleR(pub)=publisher singletonRoots (cache-bearing roots w/ 0 replicas); seesHost=topics whose local K-closest (root-selection view) contains a region-A host.');
console.log('\nRESULT_JSON ' + JSON.stringify(results));
process.exit(0);

// =====================================================================
// pubsub-churn-smoke.mjs — reflect the LIVE soak smoke in-sim.
//
// The converged test (pubsub-real-kernel.mjs) measures a QUIESCENT network:
// the mesh is static while publishing, and its churn variant heals FIRST and
// only THEN publishes. It reports ~100% because nothing is moving under the
// publish. The live fleet smoke is the opposite regime and reports 60-69%:
//
//   - subscribers stay up the whole run (the sidecars); the RELAYS roll
//     continuously underneath them (a relay every 15-30 min, kill every 2h),
//   - the publisher publishes on a steady cadence THROUGHOUT that churn, so
//     some messages land mid-root-migration / mid-reattach,
//   - a (message, reader) is delivered IFF the reader's OWN subscription
//     callback fired within a deadline (2x renewal) — watch-only, no root-read
//     credit (soak-manifest-watchonly.json).
//
// This harness runs THAT regime on the current kernel. It keeps SUBS
// subscribers + the publisher alive for the whole window, rolls the
// non-subscriber "relay" pool continuously (kill one, add one fresh — census
// flat, exactly like relay-roll), publishes every PUB_EVERY_MS, and scores
// each (message, reader) watch-only against a sweep of deadline cutoffs.
//
// The question it answers: does the live 60-69% reproduce in-sim (kernel
// behaviour under churn — reproducible + debuggable here) or does the sim
// hold ~100% under equivalent churn (the gap is live transport / fleet, not
// kernel logic)?
//
//   node harness/pubsub-churn-smoke.mjs                 # default: gentle churn
//   CHURN_EVERY_MS=0 node harness/pubsub-churn-smoke.mjs   # control (no churn)
//   CHURN_EVERY_MS=6000 node harness/pubsub-churn-smoke.mjs # aggressive
//
// Timings are quoted relative to the renewal interval REFRESH (the sim's
// RENEW_MS). Live uses deadline = 2x renewal; this harness reports delivery at
// several cutoffs (1x/2x/4x/inf renewal) so the deadline choice is not a
// hidden confound — it prints the whole delivery-vs-deadline curve.
// =====================================================================
import {
  AxonaPeer, AxonaDomain, NeuronNode, Synapse, SimNetwork, simTransport,
  createNodeIdentity, createAuthorIdentity, deriveTopicId, clz264, KERNEL_VERSION,
  configureKeyspace, getKeyspace,
} from '@axona/protocol';
import { buildXorRoutingTable } from '@axona/protocol/utils/geo.js';

const HASH_BITS = +(process.env.HASH_BITS || 256);
if (HASH_BITS !== 256) {
  configureKeyspace({ hashBits: HASH_BITS });
  const ks = getKeyspace();
  console.log(`[keyspace] SHRUNK -> nodeId=${ks.idBits}b authorId=${ks.authorIdBits}b`);
}

const N        = +(process.env.N || 120);
const SUBS     = +(process.env.SUBS || 60);
const K        = +(process.env.K || 20);
const LAT = +(process.env.LAT || 38.0), LNG = +(process.env.LNG || -77.0);
const SYN_CAP  = +(process.env.SYN_CAP || 0);
const REFRESH  = +(process.env.REFRESH || 1500);   // renewal interval (sim RENEW_MS)
const SETTLE   = +(process.env.SETTLE || 4000);    // converge before the window opens
const DURATION_MS   = +(process.env.DURATION_MS || 90000);     // sustained-publish window
const PUB_EVERY_MS  = +(process.env.PUB_EVERY_MS || 2000);     // publish cadence
// churn cadence. Default gentle ~ live intensity (one roll every ~13x renewal);
// 0 disables churn (control arm). Lower = more aggressive.
const CHURN_EVERY_MS = process.env.CHURN_EVERY_MS !== undefined ? +process.env.CHURN_EVERY_MS : 20000;
const LIVE_WINDOW_MS = +(process.env.LIVE_WINDOW_MS || REFRESH);          // forward-push window
const DEADLINE_MS    = +(process.env.DEADLINE_MS || 2 * REFRESH);        // live: 2x renewal
const wait = (ms) => new Promise(r => setTimeout(r, ms));
const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

console.log(`[smoke] N=${N} SUBS=${SUBS} K=${K}  kernel v${KERNEL_VERSION}`);
console.log(`[smoke] window=${DURATION_MS}ms pub-every=${PUB_EVERY_MS}ms churn-every=${CHURN_EVERY_MS || 'OFF'}ms renewal=${REFRESH}ms deadline=${DEADLINE_MS}ms`);

const network = new SimNetwork();
const domain  = new AxonaDomain({ k: K });
let peers = [];                       // mutable: churn adds/removes
let byBig = new Map();
const topic   = { region: 'useast', name: 'load-test' };
const topicHex = await deriveTopicId(topic);
const topicBig = BigInt('0x' + topicHex);

// ── build one production-config peer (used for initial fill AND churn refill) ─
async function buildPeer() {
  const identity = await createNodeIdentity({ lat: LAT, lng: LNG });
  const transport = simTransport({ network, identity, heartbeatMs: 0 });
  await transport.start(identity.id);
  const node = new NeuronNode({ id: BigInt('0x' + identity.id), lat: LAT, lng: LNG });
  node.transport = transport;
  const peer = new AxonaPeer({ domain, node, nodeIdentity: identity, transport });
  await peer.start();
  peer._requireAxonaManager?.('smoke-init');
  const am = peer._axonaManager;
  if (am) { am.refreshIntervalMs = REFRESH; am.start?.(); }
  return { peer, node, hex: identity.id, big: node.id, author: null };
}

// ── (re)seed the navigable XOR mesh over the CURRENT peer set + open channels ─
async function reseedMesh() {
  byBig = new Map(peers.map(p => [p.big, p]));
  const sorted = peers.map(p => p.node).sort(byId);
  for (const p of peers) {
    const cands = buildXorRoutingTable(p.node.id, sorted, K, SYN_CAP || Infinity);
    for (const cand of cands) {
      if (cand.id === p.node.id || p.node.synaptome.has(cand.id)) continue;
      const syn = new Synapse({ peerId: cand.id, latencyMs: 1, stratum: clz264(p.node.id ^ cand.id) });
      syn.weight = 0.5; syn.inertia = 0; syn._addedBy = 'harness';
      p.node.synaptome.set(cand.id, syn);
    }
  }
  for (const p of peers) {
    for (const pb of p.node.synaptome.keys()) {
      const t = byBig.get(pb);
      if (t) { try { await p.peer._transport.openConnection(t.hex); } catch {} }
    }
  }
}

// ── 1. fill to N and converge ────────────────────────────────────────
for (let i = 0; i < N; i++) peers.push(await buildPeer());
await reseedMesh();
console.log(`[mesh] ${peers.length} peers seeded`);

// ── 2. subscribe SUBS (stable readers) + pick a stable publisher ─────
const shuffled = [...peers].sort(() => Math.random() - 0.5);
const subscribers = shuffled.slice(0, SUBS);
const publisher   = shuffled[SUBS] || shuffled[0];
const subSet = new Set(subscribers.map(s => s.hex));
const recvAt = new Map();   // subHex -> Map(msgId -> firstWatchWallMs)
for (const s of subscribers) {
  recvAt.set(s.hex, new Map());
  await s.peer.sub(topic, (env) => {
    if (!env?.msgId) return;
    const m = recvAt.get(s.hex); const k = String(env.msgId);
    if (!m.has(k)) m.set(k, Date.now());
  });
  await wait(3);
}
publisher.author = await createAuthorIdentity();
await wait(SETTLE);
console.log(`[smoke] ${SUBS} readers subscribed; converged. Opening the publish window under churn.`);

// ── 3. sustained publish + continuous rolling churn ─────────────────
const published = [];   // { id, tPub, required:[hex] }
let seq = 0, rolls = 0, killed = 0;
async function publish() {
  try {
    const id = String(await publisher.peer.pub(topic, `m-${seq}`, { signWith: publisher.author }));
    // readers never churn, so every subscriber is a required reader for every msg
    published.push({ id, tPub: Date.now(), required: subscribers.map(s => s.hex) });
    seq++;
  } catch (e) { console.log(`[pub] error: ${e?.message || e}`); }
}
const ROOT_KILL = process.env.ROOT_KILL === '1';   // target the topic-closest node → force a root migration every tick
async function rollOne() {
  // roll a NON-subscriber, non-publisher node: kill one, add one fresh (census flat)
  const pool = peers.filter(p => !subSet.has(p.hex) && p !== publisher);
  if (!pool.length) return;
  // ROOT_KILL: pick the live non-reader node XOR-closest to the topic (a current
  // root), so every churn tick forces the tree to re-elect + subscribers to
  // reattach — the migration the live fleet hits when a relay serving as a root
  // rolls. Random pick (default) rarely lands on the ~5 roots.
  const victim = ROOT_KILL
    ? pool.reduce((best, p) => ((p.big ^ topicBig) < (best.big ^ topicBig) ? p : best))
    : pool[Math.floor(Math.random() * pool.length)];
  try { await victim.peer.stop?.(); } catch {}
  peers = peers.filter(p => p !== victim);
  for (const p of peers) p.node.synaptome.delete(victim.big);   // survivors evict the dead
  killed++;
  peers.push(await buildPeer());                                // fresh replacement
  await reseedMesh();
  rolls++;
}

const t0 = Date.now();
let nextPub = 0, nextChurn = CHURN_EVERY_MS || Infinity;
while (Date.now() - t0 < DURATION_MS) {
  const now = Date.now() - t0;
  if (now >= nextPub) { await publish(); nextPub += PUB_EVERY_MS; }
  if (now >= nextChurn) { await rollOne(); nextChurn += CHURN_EVERY_MS; }
  await wait(80);
}
console.log(`[smoke] window closed: ${published.length} publishes, ${rolls} rolls (${killed} kills). Draining ${DEADLINE_MS}ms of deadline.`);
await wait(DEADLINE_MS + 1500);   // let the last messages' deadlines elapse

// ── 4. watch-only accounting per (message, reader) at several cutoffs ─
// A trial is (published msg, required reader). arrival = firstWatchWall - tPub.
// delivered@cutoff = arrival <= cutoff. Report the delivery-vs-deadline curve
// so the deadline choice is explicit, plus the live/repair split at DEADLINE_MS.
const cutoffs = [
  { name: 'live (<=1x renewal)', ms: LIVE_WINDOW_MS },
  { name: 'deadline (2x renewal)', ms: DEADLINE_MS },
  { name: '4x renewal', ms: 4 * REFRESH },
  { name: 'eventual (no deadline)', ms: Infinity },
];
let trials = 0;
const deliveredAt = new Map(cutoffs.map(c => [c.name, 0]));
let liveN = 0, repairN = 0, missingN = 0;
const latencies = [];   // arrival ms for delivered-eventually trials
for (const msg of published) {
  for (const rHex of msg.required) {
    trials++;
    const at = recvAt.get(rHex)?.get(msg.id);
    const arrival = at === undefined ? Infinity : (at - msg.tPub);
    for (const c of cutoffs) if (arrival <= c.ms) deliveredAt.set(c.name, deliveredAt.get(c.name) + 1);
    if (arrival !== Infinity) latencies.push(arrival);
    if (arrival <= LIVE_WINDOW_MS) liveN++;
    else if (arrival <= DEADLINE_MS) repairN++;
    else missingN++;
  }
}
latencies.sort((a, b) => a - b);
const pct = (x) => trials ? (100 * x / trials).toFixed(1) : '0.0';
const pctl = (p) => latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor(p / 100 * latencies.length))] : 0;

console.log('\n================ SMOKE RESULT ================');
console.log(`churn:            ${CHURN_EVERY_MS ? `${rolls} rolls / ${killed} kills over ${(DURATION_MS/1000)|0}s (one roll per ${(CHURN_EVERY_MS/REFRESH).toFixed(1)}x renewal)` : 'OFF (control)'}`);
console.log(`trials:           ${trials}  (${published.length} messages x ${SUBS} readers)`);
console.log('delivery vs deadline:');
for (const c of cutoffs) console.log(`  ${c.name.padEnd(24)} ${pct(deliveredAt.get(c.name))}%`);
console.log(`class @ live/repair/missing:  ${pct(liveN)}% / ${pct(repairN)}% / ${pct(missingN)}%`);
console.log(`delivered-latency p50/p95/p99: ${pctl(50)} / ${pctl(95)} / ${pctl(99)} ms`);
console.log('==============================================\n');

console.log('RESULT_JSON ' + JSON.stringify({
  N, SUBS, K, REFRESH, DURATION_MS, PUB_EVERY_MS, CHURN_EVERY_MS, DEADLINE_MS,
  messages: published.length, trials, rolls, killed,
  deliveryLivePct: +pct(liveN) + +pct(repairN) === 0 ? 0 : undefined,
  livePct: +pct(liveN), repairPct: +pct(repairN), missingPct: +pct(missingN),
  deliveredDeadlinePct: +pct(deliveredAt.get('deadline (2x renewal)')),
  deliveredEventualPct: +pct(deliveredAt.get('eventual (no deadline)')),
  p50: pctl(50), p95: pctl(95), p99: pctl(99),
}));
process.exit(0);

// =====================================================================
// pubsub-realistic-nochurn.mjs — does the LIVE static-fleet delivery gap
// (~70%, NO churn) reproduce in-sim when the mesh is formed REALISTICALLY
// instead of god's-eye-seeded?
//
// pubsub-real-kernel.mjs / pubsub-churn-smoke.mjs seed each peer's synaptome
// with the exact K XOR-closest via buildXorRoutingTable — a perfectly navigable
// mesh, so greedy routing NEVER strands and no-churn delivery is 100%. The live
// fleet forms its mesh by BOOTSTRAP: each peer join(sponsor) → _selfIntegrate()
// (findKClosest(self) + bilateral adoption), under a capped synaptome
// (MAX_SYNAPTOME=50). That leaves residual strands (~95-98% routing reach, per
// the kernel's own join doc), and the live measurement showed ~70% pub/sub
// delivery on a STATIC warm fleet — a forward-push coverage gap independent of
// churn.
//
// This harness forms the mesh the live way (join + self-integrate, capped
// synaptome, NO god's-eye seed), runs sustained publishing with NO churn, and
// scores each (message, reader) watch-only against deadline cutoffs — the same
// contract as the live soak. If delivery lands well below 100%, the live static
// gap reproduces in-sim (kernel/mesh behaviour, debuggable here). If it stays
// ~100%, the realistic mesh alone doesn't explain it.
//
//   node harness/pubsub-realistic-nochurn.mjs
//   N=120 SUBS=60 SYN_CAP=50 node harness/pubsub-realistic-nochurn.mjs
//
// Env: N, SUBS, SYN_CAP (synaptome cap, default 50 = production MAX_SYNAPTOME),
//   INTEGRATE_ROUNDS (post-join stabilization passes), REFRESH, SETTLE,
//   DURATION_MS, PUB_EVERY_MS, DEADLINE_MS, LIVE_WINDOW_MS.
// =====================================================================
import {
  AxonaPeer, AxonaDomain, NeuronNode, SimNetwork, simTransport,
  createNodeIdentity, createAuthorIdentity, deriveTopicId, KERNEL_VERSION,
  configureKeyspace, getKeyspace,
} from '@axona/protocol';

const HASH_BITS = +(process.env.HASH_BITS || 256);
if (HASH_BITS !== 256) { configureKeyspace({ hashBits: HASH_BITS }); const ks = getKeyspace(); console.log(`[keyspace] nodeId=${ks.idBits}b`); }

const N        = +(process.env.N || 120);
const SUBS     = +(process.env.SUBS || 60);
const K        = +(process.env.K || 20);
const SYN_CAP  = +(process.env.SYN_CAP || 50);        // production MAX_SYNAPTOME
const LAT = +(process.env.LAT || 38.0), LNG = +(process.env.LNG || -77.0);
const INTEGRATE_ROUNDS = +(process.env.INTEGRATE_ROUNDS || 3);
const REFRESH  = +(process.env.REFRESH || 1500);
const SETTLE   = +(process.env.SETTLE || 6000);
const DURATION_MS  = +(process.env.DURATION_MS || 60000);
const PUB_EVERY_MS = +(process.env.PUB_EVERY_MS || 2000);
const LIVE_WINDOW_MS = +(process.env.LIVE_WINDOW_MS || REFRESH);
const DEADLINE_MS    = +(process.env.DEADLINE_MS || 2 * REFRESH);
const NTOPICS  = +(process.env.NTOPICS || 4);          // spread subs across a few topics (like the live open topics)
const wait = (ms) => new Promise(r => setTimeout(r, ms));

console.log(`[realistic] N=${N} SUBS=${SUBS} K=${K} synCap=${SYN_CAP} integrateRounds=${INTEGRATE_ROUNDS}  kernel v${KERNEL_VERSION}`);
console.log(`[realistic] window=${DURATION_MS}ms pub-every=${PUB_EVERY_MS}ms renewal=${REFRESH}ms deadline=${DEADLINE_MS}ms topics=${NTOPICS}  (NO CHURN)`);

const network = new SimNetwork();
// production degree cap — MAX_SYNAPTOME governs the shared routing budget
const domain  = new AxonaDomain({ k: K, MAX_SYNAPTOME: SYN_CAP });
const peers = [];

async function buildPeer() {
  const identity = await createNodeIdentity({ lat: LAT, lng: LNG });
  const transport = simTransport({ network, identity, heartbeatMs: 0 });
  await transport.start(identity.id);
  const node = new NeuronNode({ id: BigInt('0x' + identity.id), lat: LAT, lng: LNG });
  node.transport = transport;
  node._maxSynaptome = SYN_CAP;
  const peer = new AxonaPeer({ domain, node, nodeIdentity: identity, transport });
  await peer.start();
  peer._requireAxonaManager?.('realistic-init');
  const am = peer._axonaManager; if (am) { am.refreshIntervalMs = REFRESH; am.start?.(); }
  return { peer, node, hex: identity.id, big: node.id, author: null };
}

// ── 1. REALISTIC mesh: each peer joins via a random already-present sponsor,
//       then self-integrates. NO buildXorRoutingTable god's-eye seed. ────────
console.log('[mesh] forming realistically (join + self-integrate, capped)…');
for (let i = 0; i < N; i++) {
  const p = await buildPeer();
  if (peers.length) {
    const sponsor = peers[Math.floor(Math.random() * peers.length)];
    try { await p.peer.join(sponsor.hex); } catch (e) { /* best-effort */ }
  } else {
    try { await p.peer.join(); } catch {}
  }
  peers.push(p);
  if ((i + 1) % 30 === 0) console.log(`[mesh]   joined ${i + 1}/${N}`);
}
// stabilization passes — let neighbourhoods settle + bilateral adoption complete
for (let r = 0; r < INTEGRATE_ROUNDS; r++) {
  for (const p of peers) { try { await p.peer._selfIntegrate(); } catch {} }
  await wait(300);
}
const synSizes = peers.map(p => p.node.synaptome.size).sort((a, b) => a - b);
console.log(`[mesh] synaptome size min/med/max = ${synSizes[0]}/${synSizes[synSizes.length>>1]}/${synSizes[synSizes.length-1]} (cap ${SYN_CAP})`);

// ── transport LOSS injection: SimNetwork is lossless; the live fleet runs real
//    WebRTC/WS channels that drop. Surgically drop the forward fanout push
//    (type ~ /deliver/) with probability LOSS, modelling a push lost on a real
//    channel — the subscriber then depends on renewal-replay (which, on the
//    live fleet, missed the 120s deadline → the replay-gap misses). Fire-and-
//    forget MULTICAST, so dropping never hangs an awaited RPC. Routing
//    (lookup_step, subscribe-k) stays reliable — we isolate push loss.
const LOSS = +(process.env.LOSS || 0);
let dropped = 0, pushed = 0;
if (LOSS > 0) {
  for (const p of peers) {
    const am = p.peer._axonaManager; if (!am?.dht?.routeMessage) continue;
    const orig = am.dht.routeMessage.bind(am.dht);
    am.dht.routeMessage = (targetBig, type, payload, opts) => {
      if (/deliver/i.test(String(type))) { pushed++; if (Math.random() < LOSS) { dropped++; return Promise.resolve({ consumed: false, dropped: true }); } }
      return orig(targetBig, type, payload, opts);
    };
  }
  console.log(`[loss] forward-push drop probability = ${(LOSS*100).toFixed(0)}%`);
}

// ── mesh-quality probe: from every peer, does greedy findKClosest(topic) agree
//    on the SAME closest node the god's-eye truth would pick? Disagreement =
//    strand → the source of forward-push coverage loss. ───────────────────────
async function meshQuality(topicBig) {
  // god's-eye truth: the single XOR-closest peer
  let truth = null, best = null;
  for (const p of peers) { const d = p.big ^ topicBig; if (best === null || d < best) { best = d; truth = p.big; } }
  let agree = 0, probes = 0;
  for (const p of peers) {
    probes++;
    try { const a = await p.peer.findKClosest(topicBig, 1); const got = a && a.length ? (typeof a[0] === 'bigint' ? a[0] : BigInt('0x' + a[0])) : null; if (got === truth) agree++; }
    catch {}
  }
  return { agreePct: +(100 * agree / probes).toFixed(1), truth };
}

// ── 2. subscribe SUBS across NTOPICS topics, sustained publish, NO churn ─────
const topics = [];
for (let i = 0; i < NTOPICS; i++) {
  const t = { region: 'useast', name: `load-${i}` };
  const hex = await deriveTopicId(t); topics.push({ t, big: BigInt('0x' + hex) });
}
const shuffled = [...peers].sort(() => Math.random() - 0.5);
const subscribers = shuffled.slice(0, SUBS);
const publisher   = shuffled[SUBS] || shuffled[0];
publisher.author = await createAuthorIdentity();
const recvAt = new Map();   // `${subHex}|${msgId}` -> firstWatchWallMs
for (const s of subscribers) {
  for (const { t } of topics) {
    await s.peer.sub(t, (env) => { if (env?.msgId) { const k = `${s.hex}|${env.msgId}`; if (!recvAt.has(k)) recvAt.set(k, Date.now()); } });
    await wait(2);
  }
}
await wait(SETTLE);

// report mesh quality on each topic (strand rate) before publishing
const mq = [];
for (const { big } of topics) mq.push((await meshQuality(big)).agreePct);
console.log(`[mesh] findKClosest(topic)==truth agreement per topic: ${mq.map(x=>x+'%').join(' ')}  (lower = more strands)`);

const published = [];   // { id, tPub, big }
let seq = 0;
const t0 = Date.now(); let nextPub = 0;
while (Date.now() - t0 < DURATION_MS) {
  if (Date.now() - t0 >= nextPub) {
    const tp = topics[seq % topics.length];
    try { const id = String(await publisher.peer.pub(tp.t, `m-${seq}`, { signWith: publisher.author })); published.push({ id, tPub: Date.now(), big: tp.big }); } catch {}
    seq++; nextPub += PUB_EVERY_MS;
  }
  await wait(60);
}
console.log(`[realistic] window closed: ${published.length} publishes. Draining ${DEADLINE_MS}ms.`);
await wait(DEADLINE_MS + 1500);

// ── 3. watch-only per (message, reader) — every subscriber is a required reader
const cutoffs = [
  { name: 'live (<=1x renewal)', ms: LIVE_WINDOW_MS },
  { name: 'deadline (2x renewal)', ms: DEADLINE_MS },
  { name: '4x renewal', ms: 4 * REFRESH },
  { name: 'eventual', ms: Infinity },
];
let trials = 0; const got = new Map(cutoffs.map(c => [c.name, 0])); const lat = [];
for (const msg of published) {
  for (const s of subscribers) {
    trials++;
    const at = recvAt.get(`${s.hex}|${msg.id}`);
    const arrival = at === undefined ? Infinity : (at - msg.tPub);
    for (const c of cutoffs) if (arrival <= c.ms) got.set(c.name, got.get(c.name) + 1);
    if (arrival !== Infinity) lat.push(arrival);
  }
}
lat.sort((a, b) => a - b);
const pct = (x) => trials ? (100 * x / trials).toFixed(1) : '0.0';
const pl = (p) => lat.length ? lat[Math.min(lat.length - 1, Math.floor(p / 100 * lat.length))] : 0;

console.log('\n============ REALISTIC-MESH NO-CHURN RESULT ============');
console.log(`mesh: synaptome med ${synSizes[synSizes.length>>1]}/${SYN_CAP}; findKClosest==truth ${mq.map(x=>x+'%').join(' ')}`);
console.log(`trials: ${trials}  (${published.length} messages x ${SUBS} readers, ${NTOPICS} topics)`);
for (const c of cutoffs) console.log(`  ${c.name.padEnd(22)} ${pct(got.get(c.name))}%`);
console.log(`delivered-latency p50/p95/p99: ${pl(50)} / ${pl(95)} / ${pl(99)} ms`);
console.log('========================================================\n');
if (LOSS > 0) console.log(`[loss] pushes=${pushed} dropped=${dropped} (${(100*dropped/Math.max(1,pushed)).toFixed(1)}% of pushes)`);
console.log('RESULT_JSON ' + JSON.stringify({
  N, SUBS, K, SYN_CAP, NTOPICS, LOSS, pushed, dropped, messages: published.length, trials,
  meshAgreePct: mq, synMed: synSizes[synSizes.length>>1],
  livePct: +pct(got.get('live (<=1x renewal)')), deadlinePct: +pct(got.get('deadline (2x renewal)')),
  x4Pct: +pct(got.get('4x renewal')), eventualPct: +pct(got.get('eventual')),
  p50: pl(50), p95: pl(95), p99: pl(99),
}));
process.exit(0);

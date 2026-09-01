// =====================================================================
// pubsub-gapfill.mjs — gap-fill exploration prototype (council-ratified artifact).
//
// The diagnosis (council-accepted, PROVISIONAL until live per-hop DELIVER drop is
// measured — see #council 907afc23): the live pub/sub deadline gap is forward-
// push loss recovered only by the coarse renewal cycle, so recovery overshoots
// the 120s completeness deadline. Remedy under review: a gap-fill that recovers a
// missed push FASTER than the renewal cycle.
//
// This models gap-fill as the kernel's OWN renewal-replay triggered early on
// hole detection — recovery therefore enters through the normal watch-delivery
// path (peer.sub since:'all' replays the cache into the callback), preserving
// subscription epochs and ordering, and is NEVER credited from an inspectable
// upstream (Aster's condition, #council 34a4430f).
//
// LIVE CADENCE: renewal 60s, deadline 120s — otherwise the sim's accelerated
// renewal (1.5s) recovers inside the deadline on its own and the effect vanishes.
// Sweep the gap-fill recovery-delay D against a fixed effective push-loss; the
// control (GAPFILL_MS=0) recovers only on the 60s renewal.
//
//   LOSS=0.2 GAPFILL_MS=0    node harness/pubsub-gapfill.mjs   # control
//   LOSS=0.2 GAPFILL_MS=8000 node harness/pubsub-gapfill.mjs   # gap-fill @8s
//
// Reports (Aster's surface, v1): completeness@120s + eventual; first-receipt
// class live|gapfill|renewal (mutually exclusive); publish->callback p50/p95/p99;
// duplicate rate; gap-fill request count + amplification. DEFERRED to the
// live-distribution replay (step 2, David's gate): route-length joint axis,
// false-gap / reconnect / tombstone cases.
// =====================================================================
import {
  AxonaPeer, AxonaDomain, NeuronNode, SimNetwork, simTransport,
  createNodeIdentity, createAuthorIdentity, deriveTopicId, KERNEL_VERSION,
} from '@axona/protocol';

const N        = +(process.env.N || 100);
const SUBS     = +(process.env.SUBS || 40);
const K        = +(process.env.K || 20);
const SYN_CAP  = +(process.env.SYN_CAP || 50);
const LAT = 38.0, LNG = -77.0;
const INTEGRATE_ROUNDS = +(process.env.INTEGRATE_ROUNDS || 3);
const RENEW_MS  = +(process.env.RENEW_MS || 60000);     // LIVE renewal cadence
const DEADLINE_MS = +(process.env.DEADLINE_MS || 120000);
const LIVE_WINDOW_MS = +(process.env.LIVE_WINDOW_MS || 5000);
const LOSS      = +(process.env.LOSS || 0.20);          // effective forward-push drop
const GAPFILL_MS = +(process.env.GAPFILL_MS || 0);      // recovery-delay D; 0 = control (renewal only)
const GAPFILL_POLL = +(process.env.GAPFILL_POLL || 1000);
const NTOPICS   = +(process.env.NTOPICS || 4);
const DURATION_MS = +(process.env.DURATION_MS || 240000);
const PUB_EVERY_MS = +(process.env.PUB_EVERY_MS || 8000);
const SETTLE    = +(process.env.SETTLE || 8000);
const wait = (ms) => new Promise(r => setTimeout(r, ms));

console.log(`[gapfill] N=${N} SUBS=${SUBS} synCap=${SYN_CAP} kernel v${KERNEL_VERSION}`);
console.log(`[gapfill] LIVE cadence: renew=${RENEW_MS}ms deadline=${DEADLINE_MS}ms | LOSS=${(LOSS*100)|0}% GAPFILL_MS=${GAPFILL_MS||'OFF(control)'} window=${DURATION_MS}ms`);

const network = new SimNetwork();
const domain  = new AxonaDomain({ k: K, MAX_SYNAPTOME: SYN_CAP });
const peers = [];
async function buildPeer() {
  const identity = await createNodeIdentity({ lat: LAT, lng: LNG });
  const transport = simTransport({ network, identity, heartbeatMs: 0 });
  await transport.start(identity.id);
  const node = new NeuronNode({ id: BigInt('0x' + identity.id), lat: LAT, lng: LNG });
  node.transport = transport; node._maxSynaptome = SYN_CAP;
  const peer = new AxonaPeer({ domain, node, nodeIdentity: identity, transport });
  await peer.start(); peer._requireAxonaManager?.('gapfill-init');
  const am = peer._axonaManager; if (am) { am.refreshIntervalMs = RENEW_MS; am.start?.(); }
  return { peer, node, hex: identity.id, big: node.id, author: null };
}

// realistic mesh (join + self-integrate, capped)
console.log('[mesh] forming realistically…');
for (let i = 0; i < N; i++) {
  const p = await buildPeer();
  if (peers.length) { const sp = peers[Math.floor(Math.random() * peers.length)]; try { await p.peer.join(sp.hex); } catch {} }
  else { try { await p.peer.join(); } catch {} }
  peers.push(p);
}
for (let r = 0; r < INTEGRATE_ROUNDS; r++) { for (const p of peers) { try { await p.peer._selfIntegrate(); } catch {} } await wait(300); }
const synMed = peers.map(p => p.node.synaptome.size).sort((a,b)=>a-b)[peers.length>>1];
console.log(`[mesh] synaptome med ${synMed}/${SYN_CAP}`);

// forward-push loss injection (on the routed DELIVER; replay DELIVER is lossy too — realistic)
let pushes = 0, dropped = 0;
if (LOSS > 0) for (const p of peers) {
  const am = p.peer._axonaManager; if (!am?.dht?.routeMessage) continue;
  const orig = am.dht.routeMessage.bind(am.dht);
  am.dht.routeMessage = (t, type, payload, opts) => {
    if (/deliver/i.test(String(type))) { pushes++; if (Math.random() < LOSS) { dropped++; return Promise.resolve({ consumed: false, dropped: true }); } }
    return orig(t, type, payload, opts);
  };
}

// topics + subscribers
const topics = [];
for (let i = 0; i < NTOPICS; i++) { const t = { region: 'useast', name: `gf-${i}` }; topics.push({ t, name: t.name, big: BigInt('0x' + await deriveTopicId(t)) }); }
const shuffled = [...peers].sort(() => Math.random() - 0.5);
const subscribers = shuffled.slice(0, SUBS);
const publisher = shuffled[SUBS] || shuffled[0];
publisher.author = await createAuthorIdentity();

// per (sub) receipt tracking: msgId -> {wall, count}; and gap-fill trigger log per (sub,topic)
const recv = new Map();          // subHex -> Map(msgId -> {wall, count})
const gfTriggers = new Map();    // `${subHex}|${topicName}` -> [wall,...]
const subByTopic = new Map();    // topicName -> Set(subHex) (all subs sub all topics here)
for (const s of subscribers) {
  recv.set(s.hex, new Map());
  for (const { t, name } of topics) {
    await s.peer.sub(t, (env) => {
      if (!env?.msgId) return;
      const m = recv.get(s.hex); const k = String(env.msgId);
      const e = m.get(k); if (e) { e.count++; } else m.set(k, { wall: Date.now(), count: 1 });
    });
    if (!subByTopic.has(name)) subByTopic.set(name, new Set()); subByTopic.get(name).add(s.hex);
    await wait(2);
  }
}
await wait(SETTLE);
console.log('[gapfill] subscribed + settled; opening publish window');

const published = [];   // { id, seq, tPub, name, t }
let seq = 0;

// gap-fill loop: on a detected hole (a published msg for a subscribed topic, older
// than GAPFILL_MS, not yet received), trigger an EARLY re-subscribe(since:'all')
// for that topic → replays the cache through the watch callback. Counted as one
// gap-fill request (amplification). Detection uses the harness publish ledger as a
// stand-in for real sequence-hole detection (v1; real hole-detect is the kernel's).
// GAPFILL_MODE:
//  'all'       = re-sub since:'all' (replays whole cache — dup upper bound). REAL kernel.
//  'watermark' = re-sub since:<oldest-missing publishTs-1> — replay from the gap floor,
//                not the start of history. REAL kernel. Bounds dups but timestamp floor
//                still re-sends already-held msgs newer than the oldest hole.
//  'precise'   = the THREE-FIELD renewal (David 2026-09-01): the renewal carries the
//                subscriber's detected missing-list + its high-water seq, and the root
//                replays EXACTLY {missing-list} ∪ {above high-water}, over the lossy
//                path, through the watch record. Per-message precise → dups ~0.
//                MODELED here (the kernel since: API is timestamp-only and has no
//                seq-list renewal yet), so it shows what the proposed kernel behavior
//                would achieve. Recovery still enters via the watch record, subject to
//                the same push-loss on each replayed message.
const GAPFILL_MODE = process.env.GAPFILL_MODE || 'all';
let gfRequests = 0, holes = 0, gfReplayMsgs = 0;
function deliverToWatch(subHex, id) {   // models a DELIVER arriving at the subscriber's watch callback
  const mm = recv.get(subHex); const k = String(id);
  const e = mm.get(k); if (e) e.count++; else mm.set(k, { wall: Date.now(), count: 1 });
}
async function gapfillTick() {
  if (!GAPFILL_MS) return;
  const now = Date.now();
  for (const s of subscribers) {
    const m = recv.get(s.hex);
    for (const tp of topics) {
      const missing = [];
      let oldestMissingTs = Infinity;
      for (const p of published) {
        if (p.name !== tp.name) continue;
        if (now - p.tPub < GAPFILL_MS) continue;          // not yet eligible
        if (m.has(String(p.id))) continue;                // already have it
        missing.push(p); holes++;
        if (p.tPub < oldestMissingTs) oldestMissingTs = p.tPub;
      }
      if (!missing.length) continue;
      const key = `${s.hex}|${tp.name}`;
      const lastT = gfTriggers.get(key) || [];
      if (lastT.length && now - lastT[lastT.length - 1] < GAPFILL_MS) continue;   // debounce: one renewal per D
      (gfTriggers.get(key) || gfTriggers.set(key, []).get(key)).push(now);
      gfRequests++;                                       // one renewal carries the whole request
      if (GAPFILL_MODE === 'precise') {
        // root replays EXACTLY the named-missing + above-high-water set; each replayed
        // DELIVER is subject to the same push-loss (a drop is retried next renewal).
        for (const p of missing) { gfReplayMsgs++; if (Math.random() >= LOSS) deliverToWatch(s.hex, p.id); }
      } else {
        const since = GAPFILL_MODE === 'watermark' ? (oldestMissingTs - 1) : 'all';
        s.peer.sub(tp.t, (env) => { if (env?.msgId) deliverToWatch(s.hex, env.msgId); }, { since }).catch(() => {});
      }
    }
  }
}

const t0 = Date.now(); let nextPub = 0; let gfTimer = 0;
while (Date.now() - t0 < DURATION_MS) {
  const el = Date.now() - t0;
  if (el >= nextPub) { const tp = topics[seq % topics.length]; try { const id = String(await publisher.peer.pub(tp.t, `m-${seq}`, { signWith: publisher.author })); published.push({ id, seq, tPub: Date.now(), name: tp.name, t: tp.t }); } catch {} seq++; nextPub += PUB_EVERY_MS; }
  if (Date.now() - gfTimer >= GAPFILL_POLL) { gfTimer = Date.now(); await gapfillTick(); }
  await wait(120);
}
console.log(`[gapfill] window closed: ${published.length} pubs. Draining ${DEADLINE_MS}ms (deadline) + gap-fill.`);
// keep the gap-fill loop running through the drain so late holes still recover
const drainEnd = Date.now() + DEADLINE_MS + 5000;
while (Date.now() < drainEnd) { if (GAPFILL_MS) await gapfillTick(); await wait(GAPFILL_POLL); }

// ── accounting ──────────────────────────────────────────────────────
let trials = 0, dupTrials = 0;
let cLive = 0, cGap = 0, cRenew = 0, missing = 0, eventual = 0;
const lat = [];
for (const msg of published) {
  for (const s of subscribers) {
    trials++;
    const e = recv.get(s.hex).get(String(msg.id));
    if (!e) { missing++; continue; }
    const arrival = e.wall - msg.tPub;
    if (e.count > 1) dupTrials++;
    if (arrival <= DEADLINE_MS) { /* delivered within deadline */ } // fall through to eventual too
    eventual++;
    lat.push(arrival);
    // first-receipt class
    if (arrival <= LIVE_WINDOW_MS) cLive++;
    else {
      const trigs = gfTriggers.get(`${s.hex}|${msg.name}`) || [];
      const viaGap = trigs.some(g => e.wall >= g && e.wall - g <= GAPFILL_MS + 4000 && (msg.tPub + LIVE_WINDOW_MS) < e.wall);
      if (GAPFILL_MS && viaGap && arrival <= DEADLINE_MS) cGap++;
      else cRenew++;
    }
  }
}
const deliveredWithinDeadline = lat.filter(a => a <= DEADLINE_MS).length;
lat.sort((a,b)=>a-b);
const pct = (x) => trials ? (100*x/trials).toFixed(1) : '0.0';
const pl = (p) => lat.length ? lat[Math.min(lat.length-1, Math.floor(p/100*lat.length))] : 0;
// T_end is the observation horizon: window + one deadline + the 5s drain tail. It
// is NOT quiescence, so completeness@T_end is a CENSORED metric, not eventual
// delivery (Aster 814e2b8c). Run RUN_TO_QUIESCENCE=1 for a longer horizon.
const T_END_S = Math.round((DURATION_MS + DEADLINE_MS + 5000) / 1000);
// amplification / cost (Aster 814e2b8c): total callback firings vs unique delivered,
// renewals per published message, and — for the targeted mode — replayed messages
// per gap actually recovered by gap-fill.
let totalCb = 0; for (const s of subscribers) for (const e of recv.get(s.hex).values()) totalCb += e.count;
const netAmp = eventual ? (totalCb / eventual) : 0;                    // delivery events per unique delivered
const renewalsPerMsg = published.length ? gfRequests / published.length : 0;
const replayPerRecovery = cGap ? gfReplayMsgs / cGap : 0;              // precise: msgs replayed per useful recovery

console.log('\n============ GAP-FILL PROTOTYPE (v1, live cadence) ============');
console.log(`mesh synaptome med ${synMed}/${SYN_CAP}; push drop ${dropped}/${pushes} (${(100*dropped/Math.max(1,pushes)).toFixed(1)}%)`);
console.log(`config: LOSS=${(LOSS*100)|0}%  GAPFILL_MS=${GAPFILL_MS||'OFF(control)'}  mode=${GAPFILL_MODE}  renew=${RENEW_MS}ms  deadline=${DEADLINE_MS}ms`);
console.log(`trials ${trials} (${published.length} msgs x ${SUBS} readers)`);
console.log(`completeness @${DEADLINE_MS/1000|0}s deadline : ${pct(deliveredWithinDeadline)}%`);
console.log(`completeness @T_end (T_end=${T_END_S}s, CENSORED not eventual) : ${pct(eventual)}%   unresolved@T_end ${pct(missing)}%`);
console.log(`first-receipt class  live/gapfill/renewal/missing : ${pct(cLive)}% / ${pct(cGap)}% / ${pct(cRenew)}% / ${pct(missing)}%`);
console.log(`publish->callback p50/p95/p99 : ${pl(50)} / ${pl(95)} / ${pl(99)} ms`);
console.log(`duplicate trials (delivered >1x) : ${pct(dupTrials)}%   net amplification ${netAmp.toFixed(2)} callbacks/delivered`);
console.log(`gap-fill renewals ${gfRequests} (${renewalsPerMsg.toFixed(2)}/msg)${GAPFILL_MODE==='precise'?`, replayed msgs ${gfReplayMsgs} (${replayPerRecovery.toFixed(2)}/useful recovery)`:''}; useful gap-recoveries ${cGap}`);
console.log('===============================================================\n');
console.log('RESULT_JSON ' + JSON.stringify({
  N, SUBS, SYN_CAP, RENEW_MS, DEADLINE_MS, LOSS, GAPFILL_MS, GAPFILL_MODE, synMed, T_END_S,
  pushes, dropped, dropPct: +(100*dropped/Math.max(1,pushes)).toFixed(1),
  trials, messages: published.length,
  deadlinePct: +pct(deliveredWithinDeadline), completenessAtTendPct: +pct(eventual), unresolvedAtTendPct: +pct(missing),
  livePct: +pct(cLive), gapfillPct: +pct(cGap), renewalPct: +pct(cRenew), missingPct: +pct(missing),
  p50: pl(50), p95: pl(95), p99: pl(99), dupPct: +pct(dupTrials),
  netAmp: +netAmp.toFixed(2), renewalsPerMsg: +renewalsPerMsg.toFixed(2), replayPerRecovery: +replayPerRecovery.toFixed(2),
  gfRequests, gfReplayMsgs, holes,
}));
process.exit(0);

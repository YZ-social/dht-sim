// =====================================================================
// trace-publish.mjs — PUBLISHER-SIDE TRANSPORT-WINDOW COUNTER.
//
// NAMED FOR WHAT IT IS (Aster, council seq 214; Orion seq 215). I built this
// as, and called it, a "per-msgId trace". It is not one. It brackets a time
// WINDOW around a publish and attributes the publishing peer's own frames to
// it. It records a truncated msgId for labelling but does NOT correlate frames
// to that id, and it cannot supply attempt number, root hint, route verdict,
// hop count, or XOR progress. Calling it a trace implied a causal record it
// never produced — the name was doing work the code was not.
//
// WHY THIS FILE EXISTS. The theseus harness measured 53M sends and could
// not say what they were. Attribution came only after a per-type histogram
// showed lookahead_probe at 97% of all frames. Council (Aster seq 203/206,
// Orion seq 204/207) then required, before ANY design work on the retry
// path: a counter that is independently verified on a deterministic case,
// and a per-msgId trace carrying attempt number, root hint, verdict, hops,
// lookahead probes, XOR progress, and topology change between attempts.
//
// This harness does the first two properly and is EXPLICIT about which
// parts of the schema it cannot yet supply from outside the kernel.
//
// THE COUNTER PROVES ITSELF BEFORE IT MEASURES ANYTHING. Phase 1 asserts,
// separately: a known direct send is counted once and typed correctly; a
// routed PUB appears with the right OUTER type and the right INNER type;
// REPLICATE is found at the INNER layer (it is never an outer type — that
// mistake made every REPLICATE figure I reported wrong at the layer). If
// any assertion fails the run ABORTS. A counter that has not proved itself
// is exactly the instrument that produced this week's four false readings.
//
// PER-PEER ATTRIBUTION IS THE POINT. Global counters cannot separate a
// publisher's own traffic from background beacons and renewals across the
// fleet. Every peer gets its own counter set, so a publish is measured as
// the delta on the PUBLISHING peer alone, bracketed around the call. A
// control bracket with no publish measures the background rate on that
// same peer, so the publish cost is a difference of two measurements
// rather than an assumption.
//
//   node harness/trace-publish.mjs
//   N=12 TOPICS=3 node harness/trace-publish.mjs
// =====================================================================
import {
  AxonaPeer, AxonaDomain, NeuronNode, Synapse, SimNetwork, simTransport,
  createNodeIdentity, createAuthorIdentity, deriveTopicId, clz264,
  KERNEL_VERSION,
} from '@axona/protocol';
import { buildXorRoutingTable } from '@axona/protocol/utils/geo.js';

const N       = +(process.env.N || 12);
const TOPICS  = +(process.env.TOPICS || 3);
const K       = +(process.env.K || 8);
const SETTLE  = +(process.env.SETTLE || 4000);
// BRACKET raised from 3000: at 3s the control window measured up to 154
// background probes against an 11-probe publish — background was competing
// with signal. A longer window does not reduce background, but it makes both
// terms larger relative to their own noise, and the publish cost is a
// DIFFERENCE of two measurements on the same peer.
const BRACKET = +(process.env.BRACKET || 6000);   // window attributed to one publish
const PUBS    = +(process.env.PUBS || 20);        // publishes per arm
const LAT = 40.7, LNG = -74.0, REGION = 'useast';

const wait = (ms) => new Promise(r => setTimeout(r, ms));
const log  = (...a) => console.log(...a);
const FAIL = (m) => { console.log(`[ABORT] ${m}`); process.exit(2); };

log(`[trace] kernel ${KERNEL_VERSION}  N=${N} TOPICS=${TOPICS}`);

// ── per-peer counters ─────────────────────────────────────────────────
const network = new SimNetwork();
const domain  = new AxonaDomain({ k: K });
let peers = [];
let instrumentError = null;

function newCounters() { return { total: 0, outer: new Map(), inner: new Map() }; }
const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);

function countingSend(transport, ctr) {
  const orig = transport.send?.bind(transport);
  if (typeof orig !== 'function') FAIL('transport.send missing — cannot instrument');
  transport.send = (...args) => {
    try {
      ctr.total++;
      // SimTransport.send(peerId, type, payload) — verified by source read:
      // one directed request to ONE peer. args[1] IS the type; no sniffing.
      bump(ctr.outer, typeof args[1] === 'string' ? args[1] : '(unknown)');
      const p = args[2];
      if (p && typeof p === 'object') {
        const it = typeof p.type === 'string' ? p.type
                 : typeof p.kind === 'string' ? p.kind : null;
        if (it) bump(ctr.inner, it);
      }
    } catch (e) {
      // FAIL LOUD. A silent catch here is what hid the undeclared-map
      // ReferenceError and would have reported REPLICATE=0 as a fact.
      if (!instrumentError) { instrumentError = String(e && e.message || e);
        log(`[INSTRUMENT-FAIL] ${instrumentError}`); }
    }
    return orig(...args);
  };
}

async function spawn() {
  const identity  = await createNodeIdentity({ lat: LAT, lng: LNG });
  const ctr       = newCounters();
  const transport = simTransport({ network, identity, heartbeatMs: 0 });
  countingSend(transport, ctr);
  await transport.start(identity.id);
  const node = new NeuronNode({ id: BigInt('0x' + identity.id), lat: LAT, lng: LNG });
  node.transport = transport;
  const peer = new AxonaPeer({ domain, node, nodeIdentity: identity, transport });
  await peer.start();
  peer._requireAxonaManager?.('trace-init');
  return { peer, node, hex: identity.id, big: node.id, ctr };
}

async function wire(p, all) {
  const nodes = all.map(x => x.node).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const byBig = new Map(all.map(x => [x.big, x]));
  const link = async (a, b) => {
    if (a.big === b.big || a.node.synaptome.has(b.big)) return;
    const syn = new Synapse({ peerId: b.big, latencyMs: 1, stratum: clz264(a.big ^ b.big) });
    syn.weight = 0.5; syn.inertia = 0; syn._addedBy = 'trace';
    a.node.synaptome.set(b.big, syn);
    try { await a.peer._transport.openConnection(b.hex); } catch { /* best-effort */ }
  };
  for (const cand of buildXorRoutingTable(p.node.id, nodes, K, Infinity)) {
    const t = byBig.get(cand.id); if (t) await link(p, t);
  }
  for (const q of all) {
    if (q.big === p.big) continue;
    if (buildXorRoutingTable(q.node.id, nodes, K, Infinity).some(c => c.id === p.big)) await link(q, p);
  }
}

const snap = (c) => ({ total: c.total, outer: new Map(c.outer), inner: new Map(c.inner) });
const diff = (a, b) => {
  const d = { total: b.total - a.total, outer: {}, inner: {} };
  for (const [k, v] of b.outer) { const p = a.outer.get(k) || 0; if (v - p) d.outer[k] = v - p; }
  for (const [k, v] of b.inner) { const p = a.inner.get(k) || 0; if (v - p) d.inner[k] = v - p; }
  return d;
};

// ── PHASE 0 — fleet ───────────────────────────────────────────────────
for (let i = 0; i < N; i++) peers.push(await spawn());
for (const p of peers) await wire(p, peers);
await wait(500);
log(`[phase0] ${peers.length} nodes up`);

const author = await createAuthorIdentity();
const topics = [];
for (let t = 0; t < TOPICS; t++) {
  const desc = { region: REGION, owner: null, name: `trace-${t}`, write: 'open' };
  topics.push({ desc, name: desc.name, id: await deriveTopicId(desc) });
}
for (let t = 0; t < TOPICS; t++) {
  const sub = peers[1 + (t % Math.max(1, peers.length - 1))];
  await sub.peer.sub(topics[t].desc, () => {});
}
await wait(SETTLE);

// ── WILL THIS PUBLISHER ROUTE THIS TOPIC? ─────────────────────────────
// Added after the phase-1 assertion below fired FALSELY (council seq 218,
// Orion seq 219). AxonaPeer.routeMessage (AxonaPeer.js:3947) calls
// _deliverRouted with isTerminal BEFORE the transport send and returns
// {consumed:true, hops:0} on a local consume, so a publisher that is itself
// the topic-closest node never emits a PUB frame — it stores and REPLICATEs.
// That is correct protocol behaviour, not a fault, and it is topology-random
// at roughly 1/N: which is why the assertion aborted at N=10 and passed at
// N=12. The classifier was fine. The assertion was asserting the wrong thing.
//
// TWO INDEPENDENT READS, BOTH RECORDED, because they can disagree:
//   selfClosest — global truth: is the origin the XOR-closest LIVE peer to the
//                 topic id? This is the dominant cause of a self-terminal publish.
//   greedyHop   — the origin's OWN table, which is what routeMessage actually
//                 consults (_greedyNextHopToward, AxonaPeer.js:3395). Terminality
//                 is TABLE-relative, not global, so a node can be globally closest
//                 yet hold a synapse it believes is closer, or vice versa.
//
// This PREDICTS routing, it does not decree it. A null greedy hop is NECESSARY
// for terminal but not SUFFICIENT — routeMessage then tries _findCloserInTwoHops
// — and a non-terminal origin can still consume locally if it is already the
// root. So predictRouted is a precondition for the assertion, and the phase-2
// rows record the raw reads so a disagreement shows up instead of hiding.
const idBigOf = (hex) => BigInt('0x' + String(hex));

if (typeof peers[0].peer._greedyNextHopToward !== 'function') {
  FAIL('_greedyNextHopToward missing — cannot tell whether a publish will route');
}

function routingPredicate(origin, topicHex) {
  const tb = idBigOf(topicHex);
  let closest = null, best = null;
  for (const q of peers) {
    const d = q.big ^ tb;
    if (best === null || d < best) { best = d; closest = q; }
  }
  let greedyHop, readErr = null;
  try { greedyHop = origin.peer._greedyNextHopToward(tb); }
  catch (e) { readErr = String(e && e.message || e); greedyHop = undefined; }
  const selfClosest = closest === origin;
  return {
    selfClosest,
    greedyNull: greedyHop === null,
    readErr,
    // Both must hold: someone else is closest AND this node's own table can
    // name a next hop. Either one alone has been enough to fool me once.
    predictRouted: !selfClosest && greedyHop !== null && greedyHop !== undefined,
  };
}

// ── PHASE 1 — THE COUNTER PROVES ITSELF, OR THE RUN ABORTS ────────────
log('');
log('[phase1] counter self-verification (council seq 203 precondition)');

// (a) A KNOWN DIRECT SEND must be counted exactly once, with the right type.
const a0 = peers[0], a1 = peers[1];
const before = snap(a0.ctr);
try { await a0.peer._transport.send(a1.hex, 'lookahead_probe', { target: a1.big, fromDist: 0n }); }
catch { /* handler may reject; the SEND is still what we are counting */ }
const dDirect = diff(before, snap(a0.ctr));
log(`  (a) direct send      total=${dDirect.total}  outer=${JSON.stringify(dDirect.outer)}`);
if (dDirect.total !== 1) FAIL(`direct send counted ${dDirect.total} times, expected exactly 1`);
if ((dDirect.outer['lookahead_probe'] || 0) !== 1) FAIL('direct send not typed as lookahead_probe');

// (b) A ROUTED PUB must appear with an OUTER carrier and an INNER pubsub:pub.
//
// THE PRECONDITION IS MADE TRUE BY CONSTRUCTION rather than gated and hoped
// for: pick a probe topic this publisher will actually ROUTE. A topic that
// self-terminates is not a weaker case of the same experiment — it is a
// different experiment, and phase 2 measures it separately instead of
// letting it abort a run or, worse, silently dilute one.
let probe = null, probePred = null;
for (const t of topics) {
  const pred = routingPredicate(a0, t.id);
  if (pred.predictRouted) { probe = t; probePred = pred; break; }
}
// Mint extra candidates if every configured topic self-terminates. Cheap, and
// far better than aborting on correct protocol behaviour.
for (let extra = 0; !probe && extra < 32; extra++) {
  const desc = { region: REGION, owner: null, name: `trace-probe-${extra}`, write: 'open' };
  const t = { desc, name: desc.name, id: await deriveTopicId(desc) };
  const pred = routingPredicate(a0, t.id);
  if (pred.predictRouted) {
    probe = t; probePred = pred;
    // Give it a subscriber like the configured topics have, so the probe is
    // the same kind of object the rest of the harness measures, then let the
    // table settle and RE-READ the predicate — subscribing changes roles and
    // could move the very thing being asserted on.
    const sub = peers[1 + (extra % Math.max(1, peers.length - 1))];
    if (sub !== a0) await sub.peer.sub(t.desc, () => {});
    await wait(SETTLE);
    probePred = routingPredicate(a0, t.id);
  }
}
if (!probe) {
  FAIL(`no topic of ${TOPICS}+32 candidates routes from this publisher — fleet too small, or its table is empty`);
}
if (!probePred.predictRouted) {
  FAIL(`probe topic ${probe.name} stopped routing after its subscriber settled ` +
       `(selfClosest=${probePred.selfClosest} greedyNull=${probePred.greedyNull}) — precondition moved under the assertion`);
}
log(`  (b) probe topic      ${probe.name}  selfClosest=${probePred.selfClosest} greedyNull=${probePred.greedyNull}`);

const b0 = snap(a0.ctr);
const pubId = await a0.peer.pub(probe.desc, 'trace probe message', { signWith: author });
await wait(BRACKET);
const dPub = diff(b0, snap(a0.ctr));
log(`  (b) routed PUB       total=${dPub.total}  outer=${JSON.stringify(dPub.outer)}`);
log(`                       inner=${JSON.stringify(dPub.inner)}`);
if (!pubId) FAIL('pub() returned no msgId — cannot trace what was never published');
// BOTH LAYERS, because the comment above says both and the code asserted only
// one (Aster, council seq 214). A comment claiming a check the code does not
// perform is the same defect class as everything else this week: the assertion
// LOOKS like it covers the carrier and does not. Asserting the outer carrier
// is what would have caught the REPLICATE layer mistake on its own.
// These now say something true, because the probe topic was CHOSEN to route.
// Before the precondition they read "a publish always crosses the wire", which
// is false, and a false assertion that fires looks exactly like a real defect.
if (!dPub.outer['route_msg']) FAIL('route_msg not observed as the OUTER carrier on a topic predicted to route — classifier is wrong');
if (!dPub.inner['pubsub:pub']) FAIL('pubsub:pub not observed at the INNER layer on a topic predicted to route — classifier is wrong');

// (c) REPLICATE must be found at the INNER layer and NEVER as an outer type.
//     This is the exact mistake that invalidated every REPLICATE figure in
//     the replicas matrix, so it is asserted rather than assumed.
await wait(SETTLE);
let outerRep = 0, innerRep = 0;
for (const p of peers) {
  outerRep += p.ctr.outer.get('pubsub:replicate') || 0;
  innerRep += p.ctr.inner.get('pubsub:replicate') || 0;
}
log(`  (c) REPLICATE        outer=${outerRep}  inner=${innerRep}`);
if (outerRep !== 0) FAIL(`REPLICATE seen as an OUTER type ${outerRep}x — layer assumption is wrong`);
if (innerRep === 0) FAIL('REPLICATE never observed at the INNER layer — nothing replicated, or classifier is blind');
if (instrumentError) FAIL(`instrumentation raised: ${instrumentError}`);
log('[phase1] PASS — counter verified on all three cases');

// ── PHASE 2 — PER-msgId TRACE: settled origin vs newborn origin ───────
// THE COMPARISON. Same publish, same topics, same fleet; the only variable
// is whether the ORIGIN is integrated. Each publish is bracketed on the
// PUBLISHING peer's own counters, and each is preceded by a CONTROL
// bracket of equal length with no publish, so background beacon/renewal
// traffic is subtracted rather than assumed away.
log('');
log('[phase2] per-msgId trace — settled origin vs newborn origin');
const rows = [];

async function traceOne(origin, label, topic, attempt) {
  // Read the routing predicate BEFORE publishing. This is the confirmation I
  // told council I had not run: if the self-terminal mechanism is what produces
  // inner:pub=0, then predictRouted=false must partition the pub=0 rows exactly.
  // Recorded per row rather than asserted, so the harness reports a mismatch
  // instead of me inferring one from frame shape afterwards.
  const pred = routingPredicate(origin, topic.id);

  const ctrl0 = snap(origin.ctr);
  await wait(BRACKET);                       // control: background only
  const ctrl = diff(ctrl0, snap(origin.ctr));

  const p0 = snap(origin.ctr);
  const t0 = Date.now();
  let msgId = null, err = null;
  try { msgId = await origin.peer.pub(topic.desc, `trace ${label} ${attempt}`, { signWith: author }); }
  catch (e) { err = String(e && e.message || e); }
  await wait(BRACKET);
  const d = diff(p0, snap(origin.ctr));
  const row = {
    label, attempt, topic: topic.name,
    msgId: msgId ? String(msgId).slice(0, 12) : null,
    verdict: err ? `error:${err.slice(0, 40)}` : (msgId ? 'published' : 'no-msgId'),
    ms: Date.now() - t0,
    probes: d.outer['lookahead_probe'] || 0,
    probesBackground: ctrl.outer['lookahead_probe'] || 0,
    routeMsg: d.outer['route_msg'] || 0,
    innerPub: d.inner['pubsub:pub'] || 0,
    totalDelta: d.total, totalBackground: ctrl.total,
    peersAlive: peers.length,
    selfClosest: pred.selfClosest,
    greedyNull: pred.greedyNull,
    predictRouted: pred.predictRouted,
  };
  rows.push(row);
  log(`  ${label.padEnd(8)} a${attempt} ${row.verdict.padEnd(12)} ${String(row.ms).padStart(5)}ms  ` +
      `probes=${String(row.probes).padStart(6)} (bg ${row.probesBackground})  route_msg=${row.routeMsg}  ` +
      `inner:pub=${row.innerPub}  ${row.predictRouted ? 'routed' : 'SELF-TERMINAL'}`);
  return row;
}

// SETTLED origin — one node that has been in the mesh since phase 0. Reusing
// it across publishes is CORRECT here: settled is a stable condition, and a
// node does not become more settled by publishing.
for (let i = 0; i < PUBS; i++) await traceOne(peers[2], 'settled', topics[i % TOPICS], i);

// NEWBORN origin — A FRESH NODE FOR EVERY PUBLISH.
//
// THE FIRST VERSION OF THIS WAS WRONG. It spawned ONE newborn and had it
// publish repeatedly, so publish #2 came from a node its own publish #1 had
// already integrated. That arm measured "newborn, then slightly-used, then
// used" and called all three newborn. Newborn is a MOMENT, not a property:
// the only way to sample it repeatedly is to keep making new ones.
for (let i = 0; i < PUBS; i++) {
  const nb = await spawn();
  peers.push(nb);
  await wire(nb, peers);
  await traceOne(nb, 'newborn', topics[i % TOPICS], i);
}

// ── RESULT ────────────────────────────────────────────────────────────
const mean = (a, f) => a.length ? +(a.reduce((s, r) => s + f(r), 0) / a.length).toFixed(1) : null;
// MEDIAN AND MAX ALONGSIDE THE MEAN. The first reading had a 276-probe
// outlier against a best of 11; a mean alone hides whether the cost is a
// shifted distribution or a rare spike, and those imply different fixes.
const med = (a, f) => { if (!a.length) return null;
  const v = a.map(f).sort((x, y) => x - y), m = v.length >> 1;
  return v.length % 2 ? v[m] : +((v[m - 1] + v[m]) / 2).toFixed(1); };
const mx  = (a, f) => a.length ? Math.max(...a.map(f)) : null;
const S = rows.filter(r => r.label === 'settled'), B = rows.filter(r => r.label === 'newborn');
const line = (lab, a) => log(`[result] ${lab.padEnd(8)} n=${a.length}  probes/publish mean ${mean(a, r => r.probes)}  median ${med(a, r => r.probes)}  max ${mx(a, r => r.probes)}   background mean ${mean(a, r => r.probesBackground)}  median ${med(a, r => r.probesBackground)}`);
log('');
line('settled', S);
line('newborn', B);
log(`[result] net of background — settled median ${med(S, r => r.probes - r.probesBackground)}   newborn median ${med(B, r => r.probes - r.probesBackground)}`);
log(`[result] route_msg (hops proxy) — settled median ${med(S, r => r.routeMsg)}   newborn median ${med(B, r => r.routeMsg)}`);

// ── THE PARTITION CHECK ───────────────────────────────────────────────
// The claim from council seq 218 was: inner:pub=0 happens because the publisher
// was the topic-closest node and consumed its own publish at hop zero. That was
// an INFERENCE from frame shape — nothing recorded whether the publish routed.
// Now it is recorded, so the claim is CHECKABLE: predictRouted=false must
// partition the pub=0 rows exactly. Reported, never asserted — a mismatch here
// is a finding about the mechanism, not a reason to abort a measurement run.
const selfTerm = rows.filter(r => !r.predictRouted);
const routed   = rows.filter(r =>  r.predictRouted);
const stWithPub    = selfTerm.filter(r => r.innerPub > 0).length;
const routedNoPub  = routed.filter(r => r.innerPub === 0).length;
log('');
log(`[partition] self-terminal rows ${selfTerm.length}/${rows.length}  (expected ~${(100 / Math.max(1, N)).toFixed(0)}% at N=${N})`);
log(`[partition]   self-terminal WITH a wire PUB : ${stWithPub}   (mechanism predicts 0)`);
log(`[partition]   routed WITHOUT a wire PUB     : ${routedNoPub}   (mechanism predicts 0)`);
if (stWithPub === 0 && routedNoPub === 0 && selfTerm.length > 0) {
  log('[partition] CLEAN — routing prediction partitions inner:pub exactly. Mechanism CONFIRMED on this run.');
} else if (selfTerm.length === 0) {
  log('[partition] INCONCLUSIVE — no self-terminal publish occurred, so this run cannot confirm or refute.');
} else {
  log('[partition] MISMATCH — the prediction does NOT partition inner:pub. The mechanism is incomplete;');
  log('            terminality is table-relative and _findCloserInTwoHops can override a null greedy hop.');
}
log('[result] NOT SUPPLIED by this harness, and council asked for it: per-attempt root hint,');
log('         route verdict from inside routeMessage, hop count, and XOR-distance progress.');
log('         Those live inside the kernel routing loop and cannot be read from the transport.');
console.log('TRACE ' + JSON.stringify({ kernel: KERNEL_VERSION, N, topics: TOPICS, bracketMs: BRACKET, rows }));
process.exit(0);

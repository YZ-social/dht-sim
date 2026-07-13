// =====================================================================
// diag-route-substrate.mjs — what happens to a packet A→B under REAL churn?
//
// Studies the NEUROMORPHIC ROUTING SUBSTRATE (below pub/sub). A SUB/PUB/
// DELIVER is just a routeMessage toward an id, so the foundational question
// is point-to-point: can a random A reach a node B?
//
// CHURN MODEL (the realistic one — corrected):
//   • leave   = removeNodes(): stop + unregister + prune. Breaks PATHS, not
//               addresses (nobody is addressed there anymore).
//   • join    = mintNewcomers(): FRESH transport id at a FRESH keyspace
//               position (never reused) + seedBootstrap() to a few RANDOM
//               seeds — NOT its K-closest. N stays constant.
//   The hard direction is routing TO a newcomer: a fresh address the mesh
//   has not woven in yet. Survivor↔survivor is the easy control.
//
// TWO MOMENTS per churn event (the floor/ceiling band):
//   • FLOOR   — immediately post-join, seed-only wiring (pre-warmup).
//   • CEILING — after self-lookup + warmup LTP weaves newcomers in.
//   A continuously-churning network's true delivery sits in this band,
//   weighted by churn-rate ÷ heal-rate.
//
// peer.routeMessage(B,'diag',{}) → {consumed,atNode,hops,terminal,exhausted}.
// A 'diag' handler consumes ONLY at B, so: consumed@B=reached, terminal@X≠B=
// false terminus (reachability hole), exhausted=MAX_HOPS/dead-hop give-up.
// At a stop X we diagnose WHY: does X know any node closer to B?
//   • topology-gap   — X has NO synapse closer to B (mesh hasn't learned the
//                      newcomer's neighbourhood yet). The expected floor mode;
//                      a SINKHOLE if it persists post-heal.
//   • killed-next-hop — X HAS a closer synapse but it's dead (pothole).
//   • routing-bug     — X has a LIVE closer synapse greedy didn't take (~0).
//
// Env: N PAIRS K HASH_BITS WARMUP_LOOKUPS CHURN_PCT SEED_LINKS HEAL_LOOKUPS GBUCKET SEED
// =====================================================================
import {
  shrinkKeyspace, buildMesh, trainLookups, warmCycle,
  removeNodes, mintNewcomers, seedBootstrap, wait, KERNEL_VERSION,
} from './lib/axon-mesh.mjs';

const N        = +(process.env.N || 10000);
const PAIRS    = +(process.env.PAIRS || 1500);
const K        = +(process.env.K || 20);
const HASH_BITS= +(process.env.HASH_BITS || 64);
const WARM     = +(process.env.WARMUP_LOOKUPS || 0);
const CHURN_PCT= +(process.env.CHURN_PCT || 20);
const SEEDLINKS= +(process.env.SEED_LINKS || 3);
const HEAL_LK  = +(process.env.HEAL_LOOKUPS || (4 * N));
const GBUCKET  = +(process.env.GBUCKET || 8);
let   SEED     = +(process.env.SEED || 1);

const ks = shrinkKeyspace(HASH_BITS);
const nextRnd = () => { SEED = (SEED * 1103515245 + 12345) & 0x7fffffff; return SEED / 0x7fffffff; };
const pick = (arr) => arr[Math.floor(nextRnd() * arr.length)];
const TOP = BigInt(ks.idBits - GBUCKET);
const bucketOf = (big) => (big >> TOP);

console.log(`diag-route-substrate kernel v${KERNEL_VERSION} idBits=${ks.idBits} N=${N} pairs=${PAIRS} K=${K} warmup=${WARM} churn=${CHURN_PCT}% seedLinks=${SEEDLINKS}`);

const state = await buildMesh({ N, K, refresh: 100000, renew: 1, spread: true });
if (WARM > 0) { console.log(`training ${WARM} lookups…`); await trainLookups(state, WARM); }

let state_byBig = state.byBig;
function installDiag(p) { p.peer.onRoutedMessage('diag', (_pl, meta) => (meta.targetId === p.big ? 'consumed' : null)); }
for (const p of state_byBig.values()) installDiag(p);

async function route(A, Bbig) {
  let r;
  try { r = await A.peer.routeMessage(Bbig, 'diag', {}); }
  catch { return { ok: false, atNode: A.big, hops: -1, kind: 'threw' }; }
  if (r.consumed && r.atNode === Bbig) return { ok: true, atNode: r.atNode, hops: r.hops, kind: 'reached' };
  if (r.exhausted) return { ok: false, atNode: r.atNode, hops: r.hops, kind: 'exhausted' };
  return { ok: false, atNode: r.atNode, hops: r.hops, kind: 'false-terminal' };
}

function diagnoseStop(atBig, Bbig) {
  const X = state_byBig.get(atBig);
  if (!X) return 'terminus-gone';
  const dX = atBig ^ Bbig;
  let liveCloser = false, deadCloser = false;
  const t = X.peer._node.transport;
  const connOk = (typeof t?.isConnected === 'function') ? t.isConnected.bind(t) : null;
  const dead = X.peer._node._deadPeers;
  for (const syn of X.peer._node.synaptome.values()) {
    if ((syn.peerId ^ Bbig) >= dX) continue;
    const isDead = (dead && dead.has(syn.peerId)) || (connOk && !connOk(syn.peerId)) || !state_byBig.has(syn.peerId);
    if (isDead) deadCloser = true; else liveCloser = true;
  }
  if (liveCloser) return 'routing-bug';
  if (deadCloser) return 'killed-next-hop';
  return 'topology-gap';
}

function summarize(label, results) {
  const n = results.length;
  const ok = results.filter(r => r.ok);
  const byKind = {};
  for (const r of results) byKind[r.kind] = (byKind[r.kind] || 0) + 1;
  const hops = ok.map(r => r.hops).sort((a, b) => a - b);
  const mean = hops.length ? (hops.reduce((a, b) => a + b, 0) / hops.length) : 0;
  const p = (q) => hops.length ? hops[Math.min(hops.length - 1, Math.floor(q * hops.length))] : 0;
  console.log(`${label}: ${ok.length}/${n} reached (${n ? (100 * ok.length / n).toFixed(1) : 0}%)  |  ${Object.entries(byKind).map(([k, v]) => `${k}=${v}`).join(' ')}  |  hops mean=${mean.toFixed(2)} p99=${p(0.99)}`);
  return ok.length / Math.max(1, n);
}

// per-newcomer reachability: of R probes from random survivors, did ≥1 reach it?
function perTargetReach(results) {
  const byT = new Map();
  for (const r of results) { const e = byT.get(String(r.Bbig)) || { tot: 0, ok: 0 }; e.tot++; if (r.ok) e.ok++; byT.set(String(r.Bbig), e); }
  let fully = 0, partial = 0, dark = 0;
  for (const e of byT.values()) { if (e.ok === e.tot) fully++; else if (e.ok > 0) partial++; else dark++; }
  return { targets: byT.size, fully, partial, dark };
}

// ── baseline (steady state, survivor↔survivor) ───────────────────────────
const allBig0 = [...state_byBig.keys()];
const baseProbes = [];
for (let i = 0; i < Math.min(PAIRS, 600); i++) {
  const A = state_byBig.get(pick(allBig0)); const B = pick(allBig0);
  if (A.big !== B) baseProbes.push(await route(A, B));
}
summarize('BASELINE (survivor↔survivor, steady)', baseProbes);

// ── churn event: remove CHURN_PCT, add CHURN_PCT fresh seed-only newcomers ─
const survAll = [...state_byBig.values()];
const nChurn = Math.floor(survAll.length * CHURN_PCT / 100);
const victims = [];
const vseen = new Set();
while (vseen.size < nChurn) { const v = pick(survAll); if (!vseen.has(v.big)) { vseen.add(v.big); victims.push(v); } }
await removeNodes(state, victims);
const newcomers = await mintNewcomers(state, nChurn);
for (const nc of newcomers) { installDiag(nc); await seedBootstrap(state, nc, SEEDLINKS); }
console.log(`\n— churn: removed ${victims.length}, joined ${newcomers.length} fresh-id nodes (seed-only, ${SEEDLINKS} random links each). N=${state_byBig.size}.`);

const survivors = [...state_byBig.values()].filter(p => !newcomers.includes(p));
const ncBig = newcomers.map(n => n.big);

// build the probe set: random survivor A → random newcomer B (the hard direction)
const probes = [];
for (let i = 0; i < PAIRS; i++) probes.push({ A: pick(survivors), Bbig: pick(ncBig) });

// ── FLOOR: route to newcomers immediately (seed-only, pre-warmup) ─────────
console.log('');
const floor = [];
for (const { A, Bbig } of probes) floor.push({ ...(await route(A, Bbig)), Bbig });
const floorPct = summarize('FLOOR  to-newcomer (seed-only, pre-warmup)', floor);
const fMech = {}; for (const r of floor.filter(r => !r.ok)) { const m = diagnoseStop(r.atNode, r.Bbig); fMech[m] = (fMech[m] || 0) + 1; }
const fReach = perTargetReach(floor);
console.log(`   mechanism: ${Object.entries(fMech).map(([k, v]) => `${k}=${v}`).join(' ') || '(none)'}`);
console.log(`   newcomers: ${fReach.fully} fully-reachable, ${fReach.partial} partial, ${fReach.dark} DARK (0 probes reached) of ${fReach.targets}`);

// also confirm survivor↔survivor still fine right after churn (paths)
const ctl = [];
const survBig = survivors.map(s => s.big);
for (let i = 0; i < 400; i++) { const A = pick(survivors), B = pick(survBig); if (A.big !== B) ctl.push(await route(A, B)); }
summarize('   control survivor↔survivor (post-churn)', ctl);

// ── HEAL: newcomers self-lookup + warmup LTP + refresh ────────────────────
console.log(`\n— heal: newcomer self-lookups + ${HEAL_LK} warmup lookups + refresh…`);
for (const nc of newcomers) { try { await nc.peer.lookup(nc.big); } catch { /* */ } }
await trainLookups(state, HEAL_LK);
await warmCycle(state, { lookups: 0, refreshSteps: 3, stepMs: 150 });

// ── CEILING: re-route the SAME pairs ─────────────────────────────────────
const ceil = [];
for (const { A, Bbig } of probes) ceil.push({ ...(await route(A, Bbig)), Bbig });
const ceilPct = summarize('CEILING to-newcomer (post-warmup)', ceil);
const cMech = {}; for (const r of ceil.filter(r => !r.ok)) { const m = diagnoseStop(r.atNode, r.Bbig); cMech[m] = (cMech[m] || 0) + 1; }
const cReach = perTargetReach(ceil);
console.log(`   mechanism: ${Object.entries(cMech).map(([k, v]) => `${k}=${v}`).join(' ') || '(none)'}`);
console.log(`   newcomers: ${cReach.fully} fully-reachable, ${cReach.partial} partial, ${cReach.dark} DARK of ${cReach.targets}`);

// ── sinkhole vs pothole: which newcomers stayed dark, and are they clustered?
const stayedDark = new Set();
const ceilByT = new Map(); for (const r of ceil) { const e = ceilByT.get(String(r.Bbig)) || { tot: 0, ok: 0 }; e.tot++; if (r.ok) e.ok++; ceilByT.set(String(r.Bbig), e); }
for (const [t, e] of ceilByT) if (e.ok === 0) stayedDark.add(t);
console.log(`\nBAND: floor ${(100 * floorPct).toFixed(1)}%  →  ceiling ${(100 * ceilPct).toFixed(1)}%   (gap ${(100 * (ceilPct - floorPct)).toFixed(1)} pts = what warmup buys)`);
if (stayedDark.size === 0) {
  console.log(`→ every newcomer became reachable after warmup → POTHOLES (transient; heal weaves them in). No sinkholes.`);
} else {
  const buckets = new Set([...stayedDark].map(t => String(bucketOf(BigInt(t)))));
  console.log(`→ ${stayedDark.size} newcomers STILL DARK post-heal across ${buckets.size} keyspace buckets → ${buckets.size <= 2 ? 'CLUSTERED (sinkhole)' : 'SCATTERED (slow-heal potholes)'}.`);
}
process.exit(0);

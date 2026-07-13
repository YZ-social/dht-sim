// =====================================================================
// diag-route-healcurve.mjs — how FAST does a fresh address get woven in?
//
// The churn band (diag-route-substrate) gives two endpoints: floor (instant
// of join, seed-only) and ceiling (fully healed). A continuously-churning
// network lives BETWEEN them, at a point set by churn-rate ÷ heal-rate. This
// script measures the heal-rate half: reachability-TO-newcomers as a function
// of cumulative warmup, so we can read off "how much heal buys how much
// reachability" — and whether that cost scales with N.
//
// Flow: build + warm steady mesh → churn (remove P%, add P% fresh seed-only
// newcomers) → measure reach% to newcomers at:
//   point 0           — seed-only (the floor)
//   point 'self'      — after each newcomer looks up its OWN id once (the
//                       single biggest accelerator: its neighbours learn it)
//   point k·BATCH     — after k batches of global warmup lookups
// Curve = [{cumLookups, reachPct, darkNewcomers}]. Heal rate ≈ lookups (in
// units of N) to cross 90% reach.
//
// Env: N PAIRS K HASH_BITS WARMUP_LOOKUPS CHURN_PCT SEED_LINKS BATCH ROUNDS SEED OUT
// =====================================================================
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  shrinkKeyspace, buildMesh, trainLookups, warmCycle,
  removeNodes, mintNewcomers, seedBootstrap, welcomePush, KERNEL_VERSION,
} from './lib/axon-mesh.mjs';

const N        = +(process.env.N || 10000);
const PAIRS    = +(process.env.PAIRS || 1500);
const K        = +(process.env.K || 20);
const HASH_BITS= +(process.env.HASH_BITS || 64);
const WARM     = +(process.env.WARMUP_LOOKUPS || (2 * N));
const CHURN_PCT= +(process.env.CHURN_PCT || 20);
const SEEDLINKS= +(process.env.SEED_LINKS || 3);
const BATCH    = +(process.env.BATCH || N);          // one "unit" of heal = N lookups
const ROUNDS   = +(process.env.ROUNDS || 8);
let   SEED     = +(process.env.SEED || 1);
const OUT      = process.env.OUT || 'results/churn/route-healcurve.jsonl';

const ks = shrinkKeyspace(HASH_BITS);
const nextRnd = () => { SEED = (SEED * 1103515245 + 12345) & 0x7fffffff; return SEED / 0x7fffffff; };
const pick = (arr) => arr[Math.floor(nextRnd() * arr.length)];

console.log(`diag-route-healcurve kernel v${KERNEL_VERSION} idBits=${ks.idBits} N=${N} churn=${CHURN_PCT}% seedLinks=${SEEDLINKS} batch=${BATCH} rounds=${ROUNDS}`);

const state = await buildMesh({ N, K, refresh: 100000, renew: 1, spread: true });
if (WARM > 0) { console.log(`training ${WARM} steady-state lookups…`); await trainLookups(state, WARM); }

const installDiag = (p) => p.peer.onRoutedMessage('diag', (_pl, meta) => (meta.targetId === p.big ? 'consumed' : null));
for (const p of state.byBig.values()) installDiag(p);

async function reaches(A, Bbig) {
  try { const r = await A.peer.routeMessage(Bbig, 'diag', {}); return !!(r.consumed && r.atNode === Bbig); }
  catch { return false; }
}

// churn event
const survAll = [...state.byBig.values()];
const nChurn = Math.floor(survAll.length * CHURN_PCT / 100);
const victims = []; const vseen = new Set();
while (vseen.size < nChurn) { const v = pick(survAll); if (!vseen.has(v.big)) { vseen.add(v.big); victims.push(v); } }
await removeNodes(state, victims);
const newcomers = await mintNewcomers(state, nChurn);
for (const nc of newcomers) { installDiag(nc); await seedBootstrap(state, nc, SEEDLINKS); }
const survivors = [...state.byBig.values()].filter(p => !newcomers.includes(p));
const ncBig = newcomers.map(n => n.big);
console.log(`— churn: removed ${victims.length}, joined ${newcomers.length} fresh-id seed-only nodes. N=${state.byBig.size}.\n`);

// fixed probe set: random survivor → random newcomer
const probes = [];
for (let i = 0; i < PAIRS; i++) probes.push({ A: pick(survivors), Bbig: pick(ncBig) });
const probedT = new Set(probes.map(p => String(p.Bbig)));   // distinct newcomers actually tested

async function measure() {
  let ok = 0; const reachedT = new Set();
  for (const { A, Bbig } of probes) { if (await reaches(A, Bbig)) { ok++; reachedT.add(String(Bbig)); } }
  const dark = [...probedT].filter(b => !reachedT.has(b)).length;   // dark among TESTED only
  return { reachPct: +(100 * ok / probes.length).toFixed(1), dark, probed: probedT.size };
}

const curve = [];
const point = async (cum, tag) => {
  const m = await measure();
  curve.push({ cumLookups: cum, tag, ...m });
  console.log(`  ${String(tag).padStart(8)} (cum ${String(cum).padStart(7)} = ${(cum / N).toFixed(1)}×N) →  reach ${String(m.reachPct).padStart(5)}%   dark ${m.dark}/${m.probed} tested`);
};

// HEAL_MODE: 'random' = blind global warmup (incidentally hits newcomers).
//            'directed' = route traffic AT newcomers: D survivors look up each
//            newcomer's id per round. Every lookup is spent on integration.
const HEAL_MODE = process.env.HEAL_MODE || 'random';
const D = +(process.env.DIRECTED_D || 4);          // directed lookups per newcomer per round

// route directed traffic at every newcomer: D random survivors look it up.
async function directedRound() {
  for (const nc of newcomers) {
    for (let i = 0; i < D; i++) {
      const src = pick(survivors);
      try { await src.peer.lookup(nc.big); } catch { /* */ }
    }
  }
  return newcomers.length * D;                      // lookups spent this round
}

await point(0, 'floor');

if (HEAL_MODE === 'welcome' || HEAL_MODE === 'integrate') {
  // Self-integration. 'welcome' = harness model (manual mutual wire).
  // 'integrate' = the REAL kernel path: peer.integrate() → _selfIntegrate
  // (findKClosest(ownId) + openConnection) and the SimTransport bind events
  // (onPeerBound on BOTH ends) make neighbours adopt the newcomer. No manual
  // wiring, no oracle — exactly what production join() now does.
  let found = 0, opened = 0;
  for (const nc of newcomers) {
    if (HEAL_MODE === 'integrate') { opened += await nc.peer.integrate({ K }); }
    else { const r = await welcomePush(state, nc, K); found += r.found; opened += r.wired; }
  }
  await warmCycle(state, { lookups: 0, refreshSteps: 1, stepMs: 50 });
  console.log(`  (${HEAL_MODE}: ${(opened / newcomers.length).toFixed(1)} ${HEAL_MODE === 'integrate' ? 'channels opened' : 'newly wired'} per newcomer via the ${HEAL_MODE === 'integrate' ? 'REAL kernel peer.integrate()' : 'harness model'})`);
  await point(0, HEAL_MODE);                        // cost is the self-lookups, not warmup
  // then a little ambient warmup to see if it tops up the stragglers
  let cum = 0;
  for (let r = 1; r <= Math.min(ROUNDS, 3); r++) {
    await trainLookups(state, BATCH); cum += BATCH;
    await warmCycle(state, { lookups: 0, refreshSteps: 1, stepMs: 50 });
    await point(cum, `+${r}×N`);
  }
} else {
  for (const nc of newcomers) { try { await nc.peer.lookup(nc.big); } catch { /* */ } }
  await warmCycle(state, { lookups: 0, refreshSteps: 1, stepMs: 50 });
  await point(0, 'self-lk');                       // self-lookup only, no global warmup
  let cum = 0;
  for (let r = 1; r <= ROUNDS; r++) {
    if (HEAL_MODE === 'directed') { cum += await directedRound(); }
    else { await trainLookups(state, BATCH); cum += BATCH; }
    await warmCycle(state, { lookups: 0, refreshSteps: 1, stepMs: 50 });
    await point(cum, HEAL_MODE === 'directed' ? `dir·${r}` : `+${r}×N`);
  }
}

// heal rate: lookups (×N) to first cross 90% reach
const cross = curve.find(p => p.reachPct >= 90);
console.log(`\nheal rate: ${cross ? `${(cross.cumLookups / N).toFixed(1)}×N lookups to cross 90% reach (after self-lk=${curve[1].reachPct}%)` : 'did NOT reach 90% within budget'}`);
console.log(`self-lookup alone: floor ${curve[0].reachPct}% → ${curve[1].reachPct}% (the single-step accelerator)`);

mkdirSync(dirname(OUT), { recursive: true });
appendFileSync(OUT, JSON.stringify({ ts: new Date().toISOString(), kernelVersion: KERNEL_VERSION, scenario: { N, PAIRS, K, hashBits: HASH_BITS, warm: WARM, churnPct: CHURN_PCT, seedLinks: SEEDLINKS, batch: BATCH }, curve }) + '\n');
console.log(`→ ${OUT}`);
process.exit(0);

// =====================================================================
// pubsub-churn-suite.mjs — scale + robustness-under-churn for the real-kernel
// Axon tree, on a CONTINUOUSLY-WARMED, REUSED network (real-world model).
//
// One topic = one tree. The mesh is built + trained ONCE and reused across
// every round (never torn down between rounds). Warmup is continuous: every
// action is followed by a warm cycle (training lookups that keep the mesh
// globally navigable + refresh ticks that heal the tree), and we warm before
// every pub/sub measurement. "When in doubt, warm it up."
//
// A churn EVENT of CHURN_PCT% is applied INCREMENTALLY: CHURN_STEP% at a time,
// each increment followed by a warm cycle (e.g. 5% = 1%+warm ×5). Replacement
// churn keeps N (and the SUBS cohort) constant.
//
// Per round:
//   probe publish (in-flight) → measure immediate (cold, the disruption)
//   incremental churn: { churn STEP% → warmCycle } × (PCT/STEP)
//   warmCycle (pre-measure)
//   re-measure probe → recovered (deferred/replay during the churn+heal)
//   measure converged steady-state delivery → warm
//
// Env: N SUBS PUBS CHURN_MODE CHURN_PCT CHURN_STEP ROUNDS REPS HASH_BITS K
//      REFRESH RENEW SETTLE WARMUP_INIT WARM_LOOKUPS WARM_REFRESH WARM_SERIES
//      WARM_GAP COLD_MS PROBE SPREAD OUT LABEL
// =====================================================================

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  shrinkKeyspace, buildMesh, replaceChurn, warmCycle, trainLookups,
  classifyTree, treeStats, roleOf, publish, deliveredCount,
  createAuthorIdentity, deriveTopicId, wait, KERNEL_VERSION,
} from './lib/axon-mesh.mjs';

const N         = +(process.env.N || 2000);
const SUBS      = +(process.env.SUBS || 1000);
const PUBS      = +(process.env.PUBS || 1);
const CHURN_MODE= process.env.CHURN_MODE || 'global';
const CHURN_PCT = +(process.env.CHURN_PCT || 10);
const CHURN_STEP= +(process.env.CHURN_STEP || 1);          // incremental churn slice
const ROUNDS    = +(process.env.ROUNDS || 5);
const REPS      = +(process.env.REPS || 3);
const HASH_BITS = +(process.env.HASH_BITS || 64);
const K         = +(process.env.K || 20);
const REFRESH   = +(process.env.REFRESH || 1200);
const RENEW     = +(process.env.RENEW || 8000);
const SETTLE    = +(process.env.SETTLE || 4000);
const SPREAD    = (process.env.SPREAD ?? '0') !== '0';
// Continuous-warmup knobs. Warmup is UNCONDITIONAL — every run trains the mesh
// (lookups → LTP highways) and heals the tree (refresh ticks), regardless of
// SPREAD. A trained mesh is the faithful Axona model even in a single region;
// "when in doubt, warm it up". Override with WARMUP_INIT=0 to deliberately
// measure the raw, un-trained seed.
// Warmup is bounded, not linear in N: a training lookup costs ~O(hops) and at
// 50k that's ~5ms each, so 8×N would be ~34 min. The benchmark reached 100%
// global with ~10k warmup lookups, so cap the budget (still full training at
// small N, feasible at 50k). Per-cycle warm is smaller — it re-trains around
// the churned nodes, not the whole mesh.
const WARMUP_INIT  = process.env.WARMUP_INIT  != null ? +process.env.WARMUP_INIT  : Math.min(8 * N, 20000);
const WARM_LOOKUPS = process.env.WARM_LOOKUPS != null ? +process.env.WARM_LOOKUPS : Math.min(2 * N, 4000);
const WARM_REFRESH = +(process.env.WARM_REFRESH || 3);
const PROBE     = (process.env.PROBE ?? '1') !== '0';
const STEP_MEASURE = (process.env.STEP_MEASURE ?? '1') !== '0';   // measure delivery after each 1% slice
const COLD_MS   = +(process.env.COLD_MS || 1200);
const OUT       = process.env.OUT || `results/churn/${CHURN_MODE}.jsonl`;
const LABEL     = process.env.LABEL || '';

const ks = shrinkKeyspace(HASH_BITS);
const TOPIC = { region: 'useast', owner: null, name: 'churn-suite', write: 'open' };
const topicBig = BigInt('0x' + await deriveTopicId(TOPIC));
const mean = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
const sd   = (a) => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(mean(a.map(x => (x - m) ** 2))); };
const shuffle = (a) => { const x = a.slice(); for (let i = x.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [x[i], x[j]] = [x[j], x[i]]; } return x; };

console.log(`pubsub-churn-suite  kernel v${KERNEL_VERSION}  keyspace idBits=${ks.idBits}  spread=${SPREAD}`);
console.log(`N=${N} SUBS=${SUBS} PUBS=${PUBS} mode=${CHURN_MODE} churn=${CHURN_PCT}% step=${CHURN_STEP}% rounds=${ROUNDS} reps=${REPS}`);
console.log(`warmup: init=${WARMUP_INIT} per-cycle-lookups=${WARM_LOOKUPS} refresh=${WARM_REFRESH}\n`);
mkdirSync(dirname(OUT), { recursive: true });

const warm = (state) => warmCycle(state, { lookups: WARM_LOOKUPS, refreshSteps: WARM_REFRESH });

async function subscribe(p) {
  try { await p.peer.sub(TOPIC, (env) => { if (env?.msgId && !p.received.has(String(env.msgId))) p.received.set(String(env.msgId), Date.now()); }); p.isSub = true; }
  catch { /* */ }
}
async function trueRoots(pub) {
  const arr = await pub.peer.findKClosest(topicBig, 5);
  return new Set(arr.map(b => (typeof b === 'bigint' ? b : BigInt('0x' + b))));
}
function attachedOrphan(cohort) {
  let attached = 0, orphan = 0;
  for (const s of cohort) {
    const up = s.peer._axonaManager?._upstream?.get(topicBig);
    if (roleOf(s, topicBig) || (up && up.length)) attached++; else orphan++;
  }
  return { attachedSubs: attached, orphanSubs: orphan };
}
async function publishAll(publishers, tag) { const ids = []; for (const p of publishers) ids.push(await publish(p, TOPIC, tag)); return ids; }
function aggDelivery(cohort, ids) { let d = 0; for (const id of ids) d += deliveredCount(cohort, id); return { delivered: d, of: ids.length * cohort.length }; }

const WARM_SERIES = +(process.env.WARM_SERIES || 3), WARM_GAP = +(process.env.WARM_GAP || 2500);
async function measureConverged(state, publishers, cohort, tag) {
  let last = { delivered: 0, of: publishers.length * cohort.length, pct: 0 };
  for (let i = 0; i < WARM_SERIES; i++) {
    const ids = await publishAll(publishers, `${tag}-${i}`);
    await warm(state);
    await wait(WARM_GAP);
    const d = aggDelivery(cohort, ids);
    last = { ...d, pct: +(100 * d.delivered / Math.max(1, d.of)).toFixed(2) };
  }
  return last;
}

// victims for a given churn slice pct, per mode
function pickVictims(state, pct) {
  if (CHURN_MODE === 'global') {
    const pool = [...state.byBig.values()].filter(p => !p.isPublisher);
    const n = Math.max(1, Math.round(N * pct / 100));
    return { victims: shuffle(pool).slice(0, n), classSize: pool.length };
  }
  const { roots, relays } = classifyTree(state, topicBig);
  const pool = (CHURN_MODE === 'root' ? roots : relays).filter(p => !p.isPublisher);
  const n = pool.length ? Math.max(1, Math.round(pool.length * pct / 100)) : 0;
  return { victims: shuffle(pool).slice(0, n), classSize: pool.length };
}

// apply CHURN_PCT incrementally (CHURN_STEP at a time), warming after each slice.
// keeps the SUBS cohort constant: churned subs → new subscribing replacements.
// With STEP_MEASURE=1 (default) it ALSO measures delivery after each slice's warm,
// so we see the wave of churn heal over time (per-increment trace).
async function churnEvent(state, cohort, publishers, round) {
  const steps = Math.max(1, Math.round(CHURN_PCT / CHURN_STEP));
  const perStep = CHURN_PCT / steps;
  let killed = 0, classSizeLast = 0;
  const trace = [];
  for (let s = 0; s < steps; s++) {
    const { victims, classSize } = pickVictims(state, perStep);
    classSizeLast = classSize;
    if (victims.length) {
      const { added } = await replaceChurn(state, victims);
      killed += victims.length;
      for (let i = cohort.length - 1; i >= 0; i--) if (!state.byBig.has(cohort[i].big)) cohort.splice(i, 1);
      const need = SUBS - cohort.length;
      for (const f of added.slice(0, Math.max(0, need))) { await subscribe(f); cohort.push(f); }
    }
    await warm(state);          // warm after EVERY increment
    if (STEP_MEASURE) {
      // light single-publish delivery probe after this slice's warm — the
      // healed-delivery point on the churn-over-time curve.
      const ids = await publishAll(publishers, `r${round}-s${s}`);
      await wait(WARM_GAP);
      const d = aggDelivery(cohort, ids);
      trace.push({ step: s + 1, cumPct: +((s + 1) * perStep).toFixed(2), killed, deliveredPct: +(100 * d.delivered / Math.max(1, d.of)).toFixed(2) });
    }
  }
  return { killed, classSize: classSizeLast, steps, trace };
}

async function runRep(rep) {
  // build + train ONCE; reuse across all rounds
  const state = await buildMesh({ N, K, refresh: REFRESH, renew: RENEW, spread: SPREAD });
  await trainLookups(state, WARMUP_INIT);   // initial mesh training (navigability)
  const all = [...state.byBig.values()];
  const publishers = all.slice(0, PUBS);
  for (const pub of publishers) { pub.author = await createAuthorIdentity(); pub.isPublisher = true; }
  const cohort = all.slice(PUBS, PUBS + SUBS);
  for (const s of cohort) await subscribe(s);
  await wait(SETTLE);
  await warm(state);

  const rounds = [];
  // baseline (round 0): warmed steady-state, no churn
  {
    const w = await measureConverged(state, publishers, cohort, `rep${rep}-r0`);
    const tr = await trueRoots(publishers[0]); const ao = attachedOrphan(cohort);
    rounds.push({ round: 0, churn: null, warm: w, tree: { ...treeStats(state, topicBig, tr), ...ao, density: +(ao.attachedSubs / cohort.length).toFixed(3) } });
    console.log(`  rep${rep} r0 baseline warm=${w.pct}% subaxons=${rounds[0].tree.subaxons} roots=${rounds[0].tree.roots}/${rounds[0].tree.rootsInTrue}t orphans=${rounds[0].tree.orphanSubs}`);
  }

  for (let round = 1; round <= ROUNDS; round++) {
    // in-flight probe: publish just before the churn event, measure immediately
    let probe = null, probeIds = [];
    if (PROBE) { probeIds = await publishAll(publishers, `rep${rep}-r${round}-probe`); await wait(COLD_MS); probe = aggDelivery(cohort, probeIds); }

    const ev = await churnEvent(state, cohort, publishers, round);   // incremental churn + continuous warm + per-slice trace
    await warm(state);                                   // warm before measuring

    const recovered = PROBE ? aggDelivery(cohort, probeIds) : null;   // deferred arrivals of the in-flight probe
    const w = await measureConverged(state, publishers, cohort, `rep${rep}-r${round}-warm`);
    const tr = await trueRoots(publishers[0]); const ao = attachedOrphan(cohort);

    const probeCold = probe ? +(100 * probe.delivered / Math.max(1, probe.of)).toFixed(2) : null;
    const probeRec  = recovered ? +(100 * recovered.delivered / Math.max(1, recovered.of)).toFixed(2) : null;
    rounds.push({
      round, churn: { mode: CHURN_MODE, pct: CHURN_PCT, step: CHURN_STEP, killed: ev.killed, classSize: ev.classSize },
      probe: PROBE ? { coldPct: probeCold, recoveredPct: probeRec } : null,
      stepTrace: ev.trace,
      warm: w, tree: { ...treeStats(state, topicBig, tr), ...ao, density: +(ao.attachedSubs / cohort.length).toFixed(3) },
    });
    if (STEP_MEASURE && ev.trace.length) console.log(`       slices: ${ev.trace.map(s => `${s.cumPct}%→${s.deliveredPct}%`).join('  ')}`);
    const r = rounds[rounds.length - 1];
    console.log(`  rep${rep} r${round} [${CHURN_MODE} ${ev.killed} in ${ev.steps}×${CHURN_STEP}%]` +
      (PROBE ? ` probe ${probeCold}%→${probeRec}%` : '') +
      ` warm=${w.pct}% depth=${r.tree.depth} roots=${r.tree.roots}/${r.tree.rootsInTrue}t orphans=${r.tree.orphanSubs}`);
  }

  for (const p of state.byBig.values()) { try { await p.peer.stop?.(); } catch { /* */ } }
  return rounds;
}

const reps = [];
for (let rep = 0; rep < REPS; rep++) reps.push(await runRep(rep));

const cr = reps.flat().filter(r => r.round >= 1);
const summary = {
  warmPct:      { mean: +mean(cr.map(r => r.warm.pct)).toFixed(2), sd: +sd(cr.map(r => r.warm.pct)).toFixed(2) },
  probeColdPct: PROBE ? { mean: +mean(cr.map(r => r.probe.coldPct)).toFixed(2), sd: +sd(cr.map(r => r.probe.coldPct)).toFixed(2) } : null,
  probeRecPct:  PROBE ? { mean: +mean(cr.map(r => r.probe.recoveredPct)).toFixed(2), sd: +sd(cr.map(r => r.probe.recoveredPct)).toFixed(2) } : null,
  warmDepth:    { mean: +mean(cr.map(r => r.tree.depth)).toFixed(2) },
  orphanSubs:   { mean: +mean(cr.map(r => r.tree.orphanSubs)).toFixed(1) },
};
appendFileSync(OUT, JSON.stringify({
  ts: new Date().toISOString(), kernelVersion: KERNEL_VERSION, label: LABEL,
  scenario: { N, SUBS, PUBS, churnMode: CHURN_MODE, churnPct: CHURN_PCT, churnStep: CHURN_STEP, rounds: ROUNDS, reps: REPS, hashBits: HASH_BITS, idBits: ks.idBits, spread: SPREAD, K, renew: RENEW, warmupInit: WARMUP_INIT, warmLookups: WARM_LOOKUPS },
  summary, reps,
}) + '\n');

console.log(`\n==== SUMMARY (${CHURN_MODE} ${CHURN_PCT}% in ${CHURN_STEP}% steps, ${REPS}×${ROUNDS} rounds, spread=${SPREAD}) ====`);
console.log(`warm (steady-state under churn)  ${summary.warmPct.mean}% ± ${summary.warmPct.sd}`);
if (PROBE) console.log(`probe in-flight: cold ${summary.probeColdPct.mean}% → recovered ${summary.probeRecPct.mean}%`);
console.log(`depth ${summary.warmDepth.mean}   orphan-subs ${summary.orphanSubs.mean}`);
console.log(`→ ${OUT}`);

// =====================================================================
// pubsub-churn-ab.mjs — deterministic, frozen-plan churn A/B for ONE arm.
//
// Purpose: give a controlled comparison of two kernel revisions under churn/
// resubscribe where the ONLY difference is the code under test. Aster's HOLD
// (council seq 1425/1430) showed the previous churn A/B was not paired at all:
// pubsub-churn-suite.mjs never consumed SEED and drew scenario randomness from
// Math.random / crypto.getRandomValues, so "same seed" arms were independent
// draws. This harness satisfies her four conditions:
//
//   (1) FREEZE BEFORE ROUTING. The entire scenario — every node's identity
//       bytes, the publisher/subscriber selection, and the exact ORDERED victim
//       and replacement sequence for every round/step — is generated from SEED
//       up front, before a single peer is built. Execution only replays it.
//
//   (2) CANONICAL PLAN + ORDER PRESERVED. The plan is serialized canonically
//       (JSON, fixed field order) and hashed (planFp). Victims and replacements
//       are recorded IN ORDER, never sorted — order changes where a replacement
//       lands in the keyspace, so a sorted set would hide order-dependent
//       effects. The full plan rows are written to the output for publication.
//
//   (3) SINGLE AUDITED SEAM + FAIL-FAST. Scenario randomness enters through
//       exactly one seam: a per-mint crypto.getRandomValues shim (scoped to the
//       identity call, then restored) fed by the frozen byte stream. Kernel
//       routing/publish/auth randomness (writeFlight attemptId, handshake nonce)
//       is NEVER seeded. Beyond planFp (a pure function of SEED+config, identical
//       across arms by construction) the harness ALSO emits execFp, hashed from
//       the ACTUAL nodeIds that ran (initial ++ per-step victims ++ per-step
//       replacements, in order). If any stray scenario-random source existed,
//       execFp would diverge across arms. The A/B driver aborts unless BOTH
//       fingerprints match across the two arms before any delivery number counts.
//
//   (4) The driver runs each arm in a clean tree, records kernel+harness SHAs
//       and exit status, and never discards a failed arm.
//
// Scope: CHURN_MODE=global (victim selection independent of the routing tree, so
// it is freezable) and spread=0 (fixed region; no geo randomness). Both hold for
// this A/B. Other modes are out of scope here and use pubsub-churn-suite.mjs.
//
// Env: SEED (required), N, SUBS, PUBS, K, HASH_BITS, CHURN_PCT, CHURN_STEP,
//      ROUNDS, RENEW, REFRESH, SETTLE, WARMUP_INIT, WARM_LOOKUPS, WARM_REFRESH,
//      COLD_MS, WARM_SERIES, WARM_GAP, LABEL, OUT.
// =====================================================================

import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  shrinkKeyspace, buildMesh, replaceChurn, warmCycle, trainLookups,
  publish, deliveredCount, createAuthorIdentity, deriveTopicId, wait, KERNEL_VERSION,
} from './lib/axon-mesh.mjs';
import { makeRng, seededShuffle, fnv1a } from './lib/seeded-scenario.mjs';

// ── config ────────────────────────────────────────────────────────────
const SEED = process.env.SEED != null && process.env.SEED !== '' ? (+process.env.SEED >>> 0) : null;
if (SEED == null) { console.error('pubsub-churn-ab: SEED is required (frozen-plan A/B).'); process.exit(2); }
const N          = +(process.env.N || 300);
const SUBS       = +(process.env.SUBS || 200);
const PUBS       = +(process.env.PUBS || 1);
const K          = +(process.env.K || 20);
const HASH_BITS  = +(process.env.HASH_BITS || 64);
const CHURN_PCT  = +(process.env.CHURN_PCT || 20);
const CHURN_STEP = +(process.env.CHURN_STEP || 5);
const ROUNDS     = +(process.env.ROUNDS || 3);
const RENEW      = +(process.env.RENEW || 8000);
const REFRESH    = +(process.env.REFRESH || 1200);
const SETTLE     = +(process.env.SETTLE || 4000);
const WARMUP_INIT  = process.env.WARMUP_INIT  != null ? +process.env.WARMUP_INIT  : Math.min(8 * N, 20000);
const WARM_LOOKUPS = process.env.WARM_LOOKUPS != null ? +process.env.WARM_LOOKUPS : Math.min(2 * N, 4000);
const WARM_REFRESH = +(process.env.WARM_REFRESH || 3);
const COLD_MS    = +(process.env.COLD_MS || 1200);
const WARM_SERIES= +(process.env.WARM_SERIES || 3);
const WARM_GAP   = +(process.env.WARM_GAP || 2500);
const LABEL      = process.env.LABEL || '';
const OUT        = process.env.OUT || `results/churn-ab/${SEED}.jsonl`;

const CONFIG = { N, SUBS, PUBS, K, HASH_BITS, CHURN_MODE: 'global', CHURN_PCT, CHURN_STEP,
  ROUNDS, RENEW, REFRESH, SETTLE, WARMUP_INIT, WARM_LOOKUPS, WARM_REFRESH, COLD_MS,
  WARM_SERIES, WARM_GAP, SPREAD: 0, topic: 'churn-ab:useast:open' };

const ks = shrinkKeyspace(HASH_BITS);
const TOPIC = { region: 'useast', owner: null, name: 'churn-ab', write: 'open' };
const topicBig = BigInt('0x' + await deriveTopicId(TOPIC));

// ── PHASE 1: freeze the plan (pure, no routing, no peers) ──────────────
// One PRNG drives ALL scenario randomness. Node identity bytes and victim
// selection are the only consumers; both happen here, before any peer exists.
function buildPlan() {
  const rng = makeRng(SEED);
  const nodeBytes = [];                              // nodeBytes[m] = 32 ints 0..255
  const mint = () => { const b = new Array(32); for (let i = 0; i < 32; i++) b[i] = (rng() * 256) & 0xff; nodeBytes.push(b); return nodeBytes.length - 1; };

  for (let m = 0; m < N; m++) mint();               // initial nodes → mint indices [0,N)
  const publisherIdx = Array.from({ length: PUBS }, (_, i) => i);
  const cohortIdx    = Array.from({ length: SUBS }, (_, i) => PUBS + i);

  // Live bookkeeping in INSERTION order (mirrors the Map iteration order the
  // execution will use). Publishers never churn. n per step matches the suite's
  // global mode: round(N * perStep / 100).
  const liveOrder = Array.from({ length: N }, (_, i) => i);
  const isPub = (m) => m < PUBS;
  const steps = Math.max(1, Math.round(CHURN_PCT / CHURN_STEP));
  const perStep = CHURN_PCT / steps;
  const rounds = [];
  for (let r = 1; r <= ROUNDS; r++) {
    const roundSteps = [];
    for (let s = 0; s < steps; s++) {
      const pool = liveOrder.filter(m => !isPub(m));
      const n = Math.max(1, Math.round(N * perStep / 100));
      const victims = seededShuffle(rng, pool).slice(0, n);            // ORDER preserved
      const replacements = victims.map(() => mint());                  // one per victim, in order
      const vset = new Set(victims);
      for (let i = liveOrder.length - 1; i >= 0; i--) if (vset.has(liveOrder[i])) liveOrder.splice(i, 1);
      liveOrder.push(...replacements);                                 // appended in order
      roundSteps.push({ victims, replacements });
    }
    rounds.push({ round: r, steps: roundSteps });
  }
  return { seed: SEED, config: CONFIG, publisherIdx, cohortIdx, nodeBytes, rounds };
}

// Canonical serialization: nodeBytes as hex (the actual identity bytes → nodeId),
// selections and per-step victim/replacement mint-index arrays in order. Any
// difference in topology or churn order changes this hash.
function canonicalPlan(plan) {
  const hex = (b) => b.map(x => x.toString(16).padStart(2, '0')).join('');
  return JSON.stringify({
    seed: plan.seed,
    config: plan.config,
    publisherIdx: plan.publisherIdx,
    cohortIdx: plan.cohortIdx,
    nodeBytes: plan.nodeBytes.map(hex),
    rounds: plan.rounds.map(r => ({ round: r.round, steps: r.steps.map(s => ({ victims: s.victims, replacements: s.replacements })) })),
  });
}

// A float rng that replays exact bytes through the crypto shim: the shim computes
// (rng()*256)&0xff, and (b+0.5)/256*256 truncates to b for every b in 0..255.
function byteReplayRng(flatBytes) { let i = 0; return () => (flatBytes[i++] + 0.5) / 256; }

// ── delivery/measure helpers (same semantics as pubsub-churn-suite.mjs) ─
const warm = (state) => warmCycle(state, { lookups: WARM_LOOKUPS, refreshSteps: WARM_REFRESH });
async function subscribe(p) {
  try { await p.peer.sub(TOPIC, (env) => { if (env?.msgId && !p.received.has(String(env.msgId))) p.received.set(String(env.msgId), Date.now()); }); p.isSub = true; }
  catch { /* */ }
}
async function publishAll(publishers, tag) { const ids = []; for (const p of publishers) ids.push(await publish(p, TOPIC, tag)); return ids; }
function aggDelivery(cohort, ids) { let d = 0; for (const id of ids) d += deliveredCount(cohort, id); return { delivered: d, of: ids.length * cohort.length }; }
const pct = (d) => +(100 * d.delivered / Math.max(1, d.of)).toFixed(2);
async function measureConverged(publishers, cohort, tag) {
  let last = { delivered: 0, of: publishers.length * cohort.length };
  for (let i = 0; i < WARM_SERIES; i++) { const ids = await publishAll(publishers, `${tag}-${i}`); await wait(WARM_GAP); last = aggDelivery(cohort, ids); }
  return pct(last);
}

// ── PHASE 2: execute the frozen plan (replay only) ─────────────────────
async function runArm(plan) {
  // One flat byte stream for the WHOLE run: initial N mints, then per-step
  // replacements in exact execution order. buildMesh consumes the init prefix;
  // each replaceChurn consumes the next replacement chunk. Nothing else draws.
  const flat = [];
  for (let m = 0; m < N; m++) flat.push(...plan.nodeBytes[m]);
  for (const r of plan.rounds) for (const s of r.steps) for (const m of s.replacements) flat.push(...plan.nodeBytes[m]);
  const replay = byteReplayRng(flat);

  const state = await buildMesh({ N, K, refresh: REFRESH, renew: RENEW, spread: false, rng: replay });
  await trainLookups(state, WARMUP_INIT);

  const byIndex = [...state.byBig.values()];         // mint order 0..N-1
  const execLog = ['init:' + byIndex.map(p => p.big.toString(16)).join(',')];

  const publishers = plan.publisherIdx.map(i => byIndex[i]);
  for (const p of publishers) { p.author = await createAuthorIdentity(); p.isPublisher = true; }
  const cohort = plan.cohortIdx.map(i => byIndex[i]);
  for (const p of cohort) await subscribe(p);
  await wait(SETTLE);
  await warm(state);

  const rows = [];
  rows.push({ round: 0, warm: await measureConverged(publishers, cohort, 'r0') });   // baseline

  for (const r of plan.rounds) {
    // in-flight probe: publish just before churn, read cold now and recovered after heal
    const probeIds = await publishAll(publishers, `r${r.round}-probe`);
    await wait(COLD_MS);
    const cold = pct(aggDelivery(cohort, probeIds));

    for (const s of r.steps) {
      const victimPeers = s.victims.map(i => byIndex[i]);
      execLog.push('kill:' + victimPeers.map(p => p.big.toString(16)).join(','));
      const { added } = await replaceChurn(state, victimPeers);
      // added is in mint order (replaceChurn mints one per victim, in order) → map
      // to the plan's replacement mint-indices, same order.
      if (added.length !== s.replacements.length) throw new Error(`replacement count mismatch r${r.round}: got ${added.length} want ${s.replacements.length}`);
      s.replacements.forEach((m, k) => { byIndex[m] = added[k]; });
      execLog.push('add:' + added.map(p => p.big.toString(16)).join(','));
      // keep the SUBS cohort constant: drop churned subs, adopt fresh replacements
      for (let i = cohort.length - 1; i >= 0; i--) if (!state.byBig.has(cohort[i].big)) cohort.splice(i, 1);
      const need = SUBS - cohort.length;
      for (const f of added.slice(0, Math.max(0, need))) { await subscribe(f); cohort.push(f); }
      await warm(state);
    }
    const recovered = pct(aggDelivery(cohort, probeIds));   // deferred arrivals of the probe
    const warmPct = await measureConverged(publishers, cohort, `r${r.round}-warm`);
    rows.push({ round: r.round, cold, recovered, warm: warmPct });
    console.log(`  r${r.round}  cold=${cold}%  recovered=${recovered}%  warm=${warmPct}%`);
  }

  for (const p of state.byBig.values()) { try { await p.peer.stop?.(); } catch { /* */ } }
  return { rows, execFp: fnv1a(execLog.join('\n')) };
}

// ── run ────────────────────────────────────────────────────────────────
mkdirSync(dirname(OUT), { recursive: true });
const plan = buildPlan();
const planFp = fnv1a(canonicalPlan(plan));
console.log(`churn-ab  kernel v${KERNEL_VERSION}  idBits=${ks.idBits}  seed=${SEED}  label=${LABEL}`);
console.log(`plan: N=${N} SUBS=${SUBS} PUBS=${PUBS} churn=${CHURN_PCT}%/${CHURN_STEP}% rounds=${ROUNDS}  planFp=${planFp}`);

const { rows, execFp } = await runArm(plan);

const cr = rows.filter(r => r.round >= 1);
const mean = (a) => a.length ? +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(2) : 0;
const summary = {
  warm: mean(cr.map(r => r.warm)),
  cold: mean(cr.map(r => r.cold)),
  recovered: mean(cr.map(r => r.recovered)),
};
console.log(`SUMMARY seed=${SEED} label=${LABEL}  warm=${summary.warm}%  cold=${summary.cold}%  recovered=${summary.recovered}%`);
console.log(`FINGERPRINT seed=${SEED} label=${LABEL}  planFp=${planFp}  execFp=${execFp}`);

// Publish the plan rows (per-step victim/replacement mint-index sequences) beside
// the hashes so the comparison is auditable, not just asserted.
appendFileSync(OUT, JSON.stringify({
  ts: new Date().toISOString(), kernelVersion: KERNEL_VERSION, label: LABEL, seed: SEED,
  planFp, execFp, config: CONFIG, summary, rows,
  planRows: {
    publisherIdx: plan.publisherIdx, cohortIdx: plan.cohortIdx,
    rounds: plan.rounds.map(r => ({ round: r.round, steps: r.steps.map(s => ({ victims: s.victims, replacements: s.replacements })) })),
  },
}) + '\n');
console.log(`→ ${OUT}`);

// =====================================================================
// pubsub-churn-band.mjs — does join-time self-integration close #259?
//
// The substrate study proved: a fresh node is unreachable until its NEIGHBOURS
// learn it, and peer.integrate() (findKClosest(ownId)+openConnection) fixes
// that. This carries it UP to pub/sub: when a subscriber is replaced by a fresh
// node, can the tree route a DELIVER to it, and can its SUB reach the tree?
//
// One topic, one tree. Steady warmed mesh → subscribe a cohort → baseline
// delivery (~100%). Then CHURN: remove P% of the cohort + P% of relays, mint
// P% FRESH seed-only newcomers; the cohort-replacements subscribe. Measure
// delivery TO the fresh replacement subscribers at three moments:
//   FLOOR     — fresh subs sub() seed-only (pre-integrate)
//   INTEGRATE — each newcomer peer.integrate() (the real kernel join heal)
//   CEILING   — + ambient warmup
//
// If integrate lifts FLOOR→~CEILING, the substrate fix closes the pub/sub
// churn-recovery gap.
//
// Env: N SUBS K HASH_BITS WARMUP_LOOKUPS CHURN_PCT SEED_LINKS HEAL_LOOKUPS SETTLE DELIVER SEED
// =====================================================================
import {
  shrinkKeyspace, buildMesh, trainLookups, warmCycle,
  removeNodes, mintNewcomers, seedBootstrap,
  publish, deliveredCount, createAuthorIdentity, deriveTopicId, treeStats, wait, KERNEL_VERSION,
} from './lib/axon-mesh.mjs';

const N        = +(process.env.N || 10000);
const SUBS     = +(process.env.SUBS || 1000);
const K        = +(process.env.K || 20);
const HASH_BITS= +(process.env.HASH_BITS || 64);
const WARM     = +(process.env.WARMUP_LOOKUPS || (2 * N));
const CHURN_PCT= +(process.env.CHURN_PCT || 20);
const SEEDLINKS= +(process.env.SEED_LINKS || 1);
const HEAL_LK  = +(process.env.HEAL_LOOKUPS || (2 * N));
const SETTLE   = +(process.env.SETTLE || 3000);
const DELIVER  = +(process.env.DELIVER || 3000);
let   SEED     = +(process.env.SEED || 1);

const ks = shrinkKeyspace(HASH_BITS);
const nextRnd = () => { SEED = (SEED * 1103515245 + 12345) & 0x7fffffff; return SEED / 0x7fffffff; };
const pick = (arr) => arr[Math.floor(nextRnd() * arr.length)];
const TOPIC = { region: 'useast', owner: null, name: 'churn-band', write: 'open' };
const topicBig = BigInt('0x' + await deriveTopicId(TOPIC));

const subscribe = (s) => s.peer.sub(TOPIC, (env) => { if (env?.msgId) s.received.set(String(env.msgId), Date.now()); }).catch(() => {});

console.log(`pubsub-churn-band kernel v${KERNEL_VERSION} idBits=${ks.idBits} N=${N} SUBS=${SUBS} churn=${CHURN_PCT}% seedLinks=${SEEDLINKS}`);

const state = await buildMesh({ N, K, refresh: 100000, renew: 1, spread: true });
if (WARM > 0) { console.log(`training ${WARM} steady-state lookups…`); await trainLookups(state, WARM); }

const peers = [...state.byBig.values()];
const publisher = peers[0]; publisher.author = await createAuthorIdentity(); publisher.isPublisher = true;
const cohort = peers.slice(1, 1 + SUBS);
for (const s of cohort) await subscribe(s);
await wait(SETTLE);

const REPS = +(process.env.REPS || 5);
// REPS publishes spaced out; a sub counts as delivered if it received ANY rep
// (union = "did it ever get through", smoothing single-probe tree-reformation
// noise + capturing deferred delivery). Also report mean per-probe.
async function probe(label, who) {
  const ids = [];
  for (let r = 0; r < REPS; r++) { ids.push(await publish(publisher, TOPIC, 'probe')); await wait(Math.max(400, DELIVER / REPS)); }
  await wait(DELIVER);
  let union = 0, perProbeSum = 0;
  for (const s of who) { let any = false; for (const id of ids) if (s.received.has(String(id))) { any = true; perProbeSum++; } if (any) union++; }
  const unionPct = +(100 * union / who.length).toFixed(1);
  const meanPct = +(100 * perProbeSum / (who.length * REPS)).toFixed(1);
  console.log(`  ${label}: union ${union}/${who.length} (${unionPct}%)  mean/probe ${meanPct}%  [${REPS} reps]`);
  return unionPct;
}

console.log('');
await probe('BASELINE (full cohort, steady)', cohort);

// ── churn: remove P% of cohort + P% of relays; mint fresh seed-only replacements
const nSubChurn = Math.floor(SUBS * CHURN_PCT / 100);
const nRelayChurn = Math.floor((N - SUBS) * CHURN_PCT / 100);
const subVictims = [];
{ const seen = new Set(); while (seen.size < nSubChurn) { const v = pick(cohort); if (!seen.has(v.big)) { seen.add(v.big); subVictims.push(v); } } }
const survivorsCohort = cohort.filter(s => !subVictims.includes(s));
const nonCohort = peers.filter(p => p !== publisher && !cohort.includes(p));
const relayVictims = [];
{ const seen = new Set(); while (seen.size < nRelayChurn && seen.size < nonCohort.length) { const v = pick(nonCohort); if (!seen.has(v.big)) { seen.add(v.big); relayVictims.push(v); } } }

await removeNodes(state, [...subVictims, ...relayVictims]);
const newcomers = await mintNewcomers(state, subVictims.length + relayVictims.length);
for (const nc of newcomers) await seedBootstrap(state, nc, SEEDLINKS);
// the first nSubChurn newcomers become the replacement subscribers
const freshSubs = newcomers.slice(0, subVictims.length);
console.log(`\n— churn: -${subVictims.length} subs, -${relayVictims.length} relays; +${newcomers.length} fresh seed-only nodes (${freshSubs.length} of them subscribe). N=${state.byBig.size}.`);

// ── FLOOR: fresh subs subscribe seed-only (no integrate) ─────────────────
for (const s of freshSubs) await subscribe(s);
await wait(SETTLE);
console.log('');
const floor = await probe('FLOOR  delivery to FRESH subs (seed-only)', freshSubs);
await probe('       delivery to surviving old subs', survivorsCohort);

// ── INTEGRATE: every newcomer self-integrates (the real join() heal) ─────
console.log(`\n— integrate: each newcomer peer.integrate() (findKClosest+openConnection)…`);
let opened = 0;
for (const nc of newcomers) { try { opened += await nc.peer.integrate({ K }); } catch { /* */ } }
console.log(`  (${(opened / Math.max(1, newcomers.length)).toFixed(1)} channels opened per newcomer)`);
// re-assert subscription toward the now-reachable tree, then settle
for (const s of freshSubs) await subscribe(s);
await wait(SETTLE);
console.log('');
const integ = await probe('INTEGRATE delivery to FRESH subs', freshSubs);

// ── RECOVERY LOOP: re-home over rounds (re-sub fresh subs + warm) ────────
// The single-shot "ceiling" under-measures — the tree needs several re-home
// cycles to fully re-converge (cf. diag-root-convergence). Loop and watch it climb.
const RROUNDS = +(process.env.RECOVERY_ROUNDS || 4);
console.log(`\n— recovery: ${RROUNDS} re-home rounds (${Math.floor(HEAL_LK / RROUNDS)} lookups + refresh + re-sub each)…`);
let ceil = 0;
for (let r = 1; r <= RROUNDS; r++) {
  await trainLookups(state, Math.floor(HEAL_LK / RROUNDS));
  await warmCycle(state, { lookups: 0, refreshSteps: 3, stepMs: 150 });
  for (const s of freshSubs) await subscribe(s);
  await wait(SETTLE);
  ceil = await probe(`  recovery round ${r} (fresh subs)`, freshSubs);
}

const ts = treeStats(state, topicBig, new Set());
console.log(`\nBAND (delivery to fresh churn-replacement subscribers):`);
console.log(`  floor ${floor}%  →  integrate ${integ}%  →  ceiling ${ceil}%   (integrate lifts ${(integ - floor).toFixed(1)} pts)`);
console.log(`  tree: roots=${ts.roots} subaxons=${ts.subaxons} depth=${ts.depth} medFanout=${ts.medianFanout}`);
console.log(`→ if integrate ≈ ceiling: join-time self-integration closes the #259 churn-recovery gap at the pub/sub layer.`);
process.exit(0);

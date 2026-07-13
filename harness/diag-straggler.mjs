// =====================================================================
// diag-straggler.mjs — WHY do ~7.5% of fresh churn-replacement subscribers
// stay dark even after integrate + recovery rounds?
//
// Reproduces the pubsub-churn-band end state (steady mesh → churn → fresh
// seed-only subs → integrate → recovery rounds), then AUTOPSIES the subs that
// never received. For each dark sub, classify the cause:
//   • substrate-unreachable — a routed packet from a survivor can't even reach
//     its node id → integrate failed to weave it in (mesh/reachability problem).
//   • attached-but-dark      — substrate-reachable AND it holds an _upstream pin
//     for the topic, but deliveries don't arrive (tree/relay problem).
//   • no-upstream            — substrate-reachable but never attached to the
//     tree (its SUB never landed on a relay → subscribe-path problem).
// Plus per-straggler: synaptome size, integrate channels, neighbourhood density
// (how many of its true K-closest are actually live + known to it).
//
// Env: N SUBS K HASH_BITS WARMUP_LOOKUPS CHURN_PCT SEED_LINKS RECOVERY_ROUNDS HEAL_LOOKUPS REPS SETTLE DELIVER SEED
// =====================================================================
import {
  shrinkKeyspace, buildMesh, trainLookups, warmCycle,
  removeNodes, mintNewcomers, seedBootstrap,
  publish, createAuthorIdentity, deriveTopicId, roleOf, wait, KERNEL_VERSION,
} from './lib/axon-mesh.mjs';

const N        = +(process.env.N || 10000);
const SUBS     = +(process.env.SUBS || 1000);
const K        = +(process.env.K || 20);
const HASH_BITS= +(process.env.HASH_BITS || 64);
const WARM     = +(process.env.WARMUP_LOOKUPS || (2 * N));
const CHURN_PCT= +(process.env.CHURN_PCT || 20);
const SEEDLINKS= +(process.env.SEED_LINKS || 1);
const RROUNDS  = +(process.env.RECOVERY_ROUNDS || 4);
const HEAL_LK  = +(process.env.HEAL_LOOKUPS || (2 * N));
const REPS     = +(process.env.REPS || 5);
const SETTLE   = +(process.env.SETTLE || 4000);
const DELIVER  = +(process.env.DELIVER || 2500);
let   SEED     = +(process.env.SEED || 1);

const ks = shrinkKeyspace(HASH_BITS);
const nextRnd = () => { SEED = (SEED * 1103515245 + 12345) & 0x7fffffff; return SEED / 0x7fffffff; };
const pick = (arr) => arr[Math.floor(nextRnd() * arr.length)];
const TOPIC = { region: 'useast', owner: null, name: 'straggler', write: 'open' };
const topicBig = BigInt('0x' + await deriveTopicId(TOPIC));
const subscribe = (s) => s.peer.sub(TOPIC, (env) => { if (env?.msgId) s.received.set(String(env.msgId), Date.now()); }).catch(() => {});

console.log(`diag-straggler kernel v${KERNEL_VERSION} idBits=${ks.idBits} N=${N} SUBS=${SUBS} churn=${CHURN_PCT}% rounds=${RROUNDS}`);

const state = await buildMesh({ N, K, refresh: 100000, renew: 1, spread: true });
if (WARM > 0) { console.log(`training ${WARM} lookups…`); await trainLookups(state, WARM); }

const peers = [...state.byBig.values()];
const publisher = peers[0]; publisher.author = await createAuthorIdentity(); publisher.isPublisher = true;
const cohort = peers.slice(1, 1 + SUBS);
for (const s of cohort) await subscribe(s);
await wait(SETTLE);

// churn: remove P% subs + P% relays; mint fresh seed-only replacements
const nSubChurn = Math.floor(SUBS * CHURN_PCT / 100);
const nRelayChurn = Math.floor((N - SUBS) * CHURN_PCT / 100);
const subVictims = []; { const seen = new Set(); while (seen.size < nSubChurn) { const v = pick(cohort); if (!seen.has(v.big)) { seen.add(v.big); subVictims.push(v); } } }
const nonCohort = peers.filter(p => p !== publisher && !cohort.includes(p));
const relayVictims = []; { const seen = new Set(); while (seen.size < nRelayChurn && seen.size < nonCohort.length) { const v = pick(nonCohort); if (!seen.has(v.big)) { seen.add(v.big); relayVictims.push(v); } } }
await removeNodes(state, [...subVictims, ...relayVictims]);
const newcomers = await mintNewcomers(state, subVictims.length + relayVictims.length);
const integChannels = new Map();
for (const nc of newcomers) await seedBootstrap(state, nc, SEEDLINKS);
const freshSubs = newcomers.slice(0, subVictims.length);
for (const s of freshSubs) await subscribe(s);
await wait(SETTLE);

// integrate + recovery rounds (the pubsub-churn-band end state)
const PASSES = +(process.env.INTEGRATE_PASSES || 1);
for (const nc of newcomers) {
  let opened = 0;
  for (let p = 0; p < PASSES; p++) { try { opened += await nc.peer.integrate({ K }); } catch { /* */ } }
  integChannels.set(nc.big, opened);
}
for (const s of freshSubs) await subscribe(s);
await wait(SETTLE);
for (let r = 1; r <= RROUNDS; r++) {
  await trainLookups(state, Math.floor(HEAL_LK / RROUNDS));
  await warmCycle(state, { lookups: 0, refreshSteps: 3, stepMs: 150 });
  for (const s of freshSubs) await subscribe(s);
  await wait(SETTLE);
}

// final delivery (REPS union) → identify dark fresh subs
const ids = [];
for (let r = 0; r < REPS; r++) { ids.push(await publish(publisher, TOPIC, 'p')); await wait(Math.max(400, DELIVER / REPS)); }
await wait(DELIVER);
const dark = freshSubs.filter(s => !ids.some(id => s.received.has(String(id))));
const reached = freshSubs.length - dark.length;
console.log(`\nfresh subs: ${reached}/${freshSubs.length} reached (${(100 * reached / freshSubs.length).toFixed(1)}%) · ${dark.length} DARK → autopsy:`);

// substrate reachability probe: route from a random survivor to the sub's id
const survivors = [...state.byBig.values()].filter(p => !newcomers.includes(p) && p !== publisher);
for (const s of freshSubs) s.peer.onRoutedMessage('sx', (_p, meta) => (meta.targetId === s.big ? 'consumed' : null));
async function substrateReachable(subBig) {
  for (let i = 0; i < 3; i++) {                       // 3 tries from diverse survivors
    const A = pick(survivors);
    try { const r = await A.peer.routeMessage(subBig, 'sx', {}); if (r && r.consumed && r.atNode === subBig) return true; } catch { /* */ }
  }
  return false;
}
// true K-closest live to an id, and how many the node actually holds a synapse to
function nbrhood(s) {
  const sorted = [...state.byBig.keys()].sort((a, b) => { const da = a ^ s.big, db = b ^ s.big; return da < db ? -1 : da > db ? 1 : 0; }).slice(1, K + 1);
  const syn = s.peer._node.synaptome;
  const known = sorted.filter(id => syn.has(id)).length;
  return { trueLive: sorted.length, known };
}

let cUnreach = 0, cNoUp = 0, cAttachedDark = 0;
const sample = dark.slice(0, Math.min(dark.length, 20));
for (const s of dark) {
  const reach = await substrateReachable(s.big);
  const up = s.peer._axonaManager?._upstream?.get(topicBig);
  const hasUp = !!(up && up.length);
  if (!reach) cUnreach++;
  else if (!hasUp) cNoUp++;
  else cAttachedDark++;
}
console.log(`\n  CAUSE breakdown of ${dark.length} dark subs:`);
console.log(`    substrate-unreachable : ${cUnreach}  (integrate didn't weave them in)`);
console.log(`    no-upstream (unattached): ${cNoUp}  (reachable, but SUB never landed on a relay)`);
console.log(`    attached-but-dark      : ${cAttachedDark}  (reachable + pinned, deliveries still miss)`);

// per-straggler detail (sample)
console.log(`\n  sample (≤20): synaptome / integ-channels / nbrs-known of K / has-upstream / substrate-reachable`);
for (const s of sample) {
  const nb = nbrhood(s);
  const reach = await substrateReachable(s.big);
  const up = s.peer._axonaManager?._upstream?.get(topicBig);
  console.log(`    0x${s.big.toString(16).slice(0,8)}: syn=${String(s.peer._node.synaptome.size).padStart(3)}  integ=${String(integChannels.get(s.big) ?? 0).padStart(2)}  nbrs=${nb.known}/${nb.trueLive}  up=${up && up.length ? 'Y' : 'n'}  reach=${reach ? 'Y' : 'n'}`);
}
process.exit(0);

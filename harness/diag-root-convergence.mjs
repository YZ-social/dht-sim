// =====================================================================
// diag-root-convergence.mjs — what happens to the axon tree when the ROOT dies?
//
// The pub/sub churn band showed delivery caps at ~57% after heavy churn with
// roots=28 — the tree FRAGMENTED. This isolates the cause: kill the emergent
// root + its root-set (the K nodes XOR-closest to topicId) — NOT random churn —
// and trace whether the tree re-elects a SINGLE true root and recovers delivery
// over re-home cycles.
//
// Per round (a warmCycle = refreshTick re-home + re-announce + prune):
//   • distinct role-roots         — how many nodes claim isRoot/isInRootSet
//   • true root elected?          — does the new XOR-closest survivor hold a root role
//   • spurious roots              — role-roots NOT in the true K-closest set
//   • delivery% (REPS union)      — does the publisher reach the cohort again
//
// Convergence = roots collapse →1 (the true one) and delivery →100%. A stall
// (roots stuck high, delivery capped) localises the re-election gap.
//
// Env: N SUBS K HASH_BITS WARMUP_LOOKUPS KILL_ROOTS ROUNDS REPS HEAL_PER_ROUND SETTLE DELIVER SEED
// =====================================================================
import {
  shrinkKeyspace, buildMesh, trainLookups, warmCycle,
  removeNodes, publish, deliveredCount, roleOf,
  createAuthorIdentity, deriveTopicId, treeStats, classifyTree, wait, KERNEL_VERSION,
} from './lib/axon-mesh.mjs';

const N        = +(process.env.N || 10000);
const SUBS     = +(process.env.SUBS || 1000);
const K        = +(process.env.K || 20);
const HASH_BITS= +(process.env.HASH_BITS || 64);
const WARM     = +(process.env.WARMUP_LOOKUPS || (2 * N));
const KILL_ROOTS = +(process.env.KILL_ROOTS || K);     // kill the emergent root + root-set
const ROUNDS   = +(process.env.ROUNDS || 8);
const REPS     = +(process.env.REPS || 5);
const HEAL_PR  = +(process.env.HEAL_PER_ROUND || Math.floor(N / 2));
const SETTLE   = +(process.env.SETTLE || 3000);
const DELIVER  = +(process.env.DELIVER || 2500);
let   SEED     = +(process.env.SEED || 1);

const ks = shrinkKeyspace(HASH_BITS);
const TOPIC = { region: 'useast', owner: null, name: 'root-conv', write: 'open' };
const topicBig = BigInt('0x' + await deriveTopicId(TOPIC));
const subscribe = (s) => s.peer.sub(TOPIC, (env) => { if (env?.msgId) s.received.set(String(env.msgId), Date.now()); }).catch(() => {});

console.log(`diag-root-convergence kernel v${KERNEL_VERSION} idBits=${ks.idBits} N=${N} SUBS=${SUBS} killRoots=${KILL_ROOTS} rounds=${ROUNDS}`);

const state = await buildMesh({ N, K, refresh: 100000, renew: 1, spread: true });
if (WARM > 0) { console.log(`training ${WARM} steady-state lookups…`); await trainLookups(state, WARM); }

const peers = [...state.byBig.values()];
const publisher = peers[0]; publisher.author = await createAuthorIdentity(); publisher.isPublisher = true;
const cohort = peers.slice(1, 1 + SUBS);
for (const s of cohort) await subscribe(s);
await wait(SETTLE);

// true root-set = live survivors XOR-closest to topicId
function trueRootSet(k) {
  return [...state.byBig.keys()].sort((a, b) => { const da = a ^ topicBig, db = b ^ topicBig; return da < db ? -1 : da > db ? 1 : 0; }).slice(0, k);
}
async function deliveryPct(who) {
  const ids = [];
  for (let r = 0; r < REPS; r++) { ids.push(await publish(publisher, TOPIC, 'p')); await wait(Math.max(350, DELIVER / REPS)); }
  await wait(DELIVER);
  let union = 0;
  for (const s of who) { for (const id of ids) if (s.received.has(String(id))) { union++; break; } }
  return +(100 * union / who.length).toFixed(1);
}
function snapshot() {
  const trueSet = new Set(trueRootSet(K));
  const trueRoot = trueRootSet(1)[0];
  const ts = treeStats(state, topicBig, trueSet);
  const ct = classifyTree(state, topicBig);
  const trueRootHasRole = !!roleOf(state.byBig.get(trueRoot), topicBig);
  const trueRootIsRoot = (() => { const r = roleOf(state.byBig.get(trueRoot), topicBig); return !!(r && (r.isRoot || r.isInRootSet)); })();
  return { roots: ts.roots, spurious: ts.spuriousRoots, rootsInTrue: ts.rootsInTrue, relays: ct.relays.length, trueRootHasRole, trueRootIsRoot };
}

console.log('');
let s = snapshot();
let d = await deliveryPct(cohort);
console.log(`BASELINE: delivery ${d}%  roots=${s.roots} (inTrue=${s.rootsInTrue} spurious=${s.spurious}) relays=${s.relays} trueRootIsRoot=${s.trueRootIsRoot}`);

// ── kill the emergent root + root-set (+ optional global relay churn) ────
const KILL_RELAYS_PCT = +(process.env.KILL_RELAYS_PCT || 0);
const victimSet = new Map();
for (const b of trueRootSet(KILL_ROOTS)) { const p = state.byBig.get(b); if (p) victimSet.set(b, p); }
if (KILL_RELAYS_PCT > 0) {
  const pool = peers.filter(p => p !== publisher && state.byBig.has(p.big) && !victimSet.has(p.big));
  const nRelay = Math.floor(state.byBig.size * KILL_RELAYS_PCT / 100);
  const seen = new Set();
  while (seen.size < nRelay && seen.size < pool.length) {
    SEED = (SEED * 1103515245 + 12345) & 0x7fffffff;
    const p = pool[Math.floor((SEED / 0x7fffffff) * pool.length)];
    if (!seen.has(p.big)) { seen.add(p.big); victimSet.set(p.big, p); }
  }
}
const victims = [...victimSet.values()];
const cohortVictims = victims.filter(v => cohort.includes(v));
await removeNodes(state, victims);
const liveCohort = cohort.filter(c => state.byBig.has(c.big));
console.log(`\n— killed ${victims.length} nodes = root-set${KILL_RELAYS_PCT ? ` + ${KILL_RELAYS_PCT}% global relays` : ''} (${cohortVictims.length} were also subscribers). cohort ${liveCohort.length} live.`);
console.log(`  new true root = 0x${trueRootSet(1)[0].toString(16).slice(0, 10)}… (next-closest survivor)\n`);

// ── recovery loop: warm cycle (re-home + re-announce) then measure ───────
for (let r = 0; r <= ROUNDS; r++) {
  if (r > 0) {
    await trainLookups(state, HEAL_PR);
    await warmCycle(state, { lookups: 0, refreshSteps: 3, stepMs: 150 });
    for (const c of liveCohort) await subscribe(c);   // renewal toward the (new) root
    await wait(SETTLE);
  }
  s = snapshot();
  d = await deliveryPct(liveCohort);
  const tag = r === 0 ? 'post-kill ' : `round ${r}   `;
  console.log(`${tag}: delivery ${String(d).padStart(5)}%  roots=${String(s.roots).padStart(3)} (inTrue=${s.rootsInTrue} spurious=${String(s.spurious).padStart(3)}) relays=${String(s.relays).padStart(4)} trueRootIsRoot=${s.trueRootIsRoot}`);
}

console.log(`\n→ converged if roots→~1 (inTrue=1, spurious→0) AND delivery→~100%. A stall (roots stuck high / delivery capped) = the re-election gap.`);
process.exit(0);

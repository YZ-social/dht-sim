// =====================================================================
// warmup-curve.mjs — how much warmup does a cold mesh need to reach a
// stable state? Build a globally-spread mesh (NO initial warmup), then:
//   measure → { train BATCH lookups → re-home subs → measure } × ROUNDS
// Each measure records pub/sub delivery% (fixed cohort, one tree) AND
// lookup-success% (random lookups reaching the true XOR-closest node).
// Output: a curve of both vs cumulative warmup lookups.
//
// Env: N SUBS K BATCH ROUNDS HASH_BITS LOOKUP_SAMPLES SETTLE DELIVER OUT
// =====================================================================
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import {
  shrinkKeyspace, buildMesh, trainLookups, publish, deliveredCount,
  createAuthorIdentity, deriveTopicId, wait, KERNEL_VERSION,
} from './lib/axon-mesh.mjs';

const N        = +(process.env.N || 50000);
const SUBS     = +(process.env.SUBS || 1000);
const K        = +(process.env.K || 20);
const BATCH    = +(process.env.BATCH || 5000);
const ROUNDS   = +(process.env.ROUNDS || 10);
const HASH_BITS= +(process.env.HASH_BITS || 64);
const SAMPLES  = +(process.env.LOOKUP_SAMPLES || 300);
const SETTLE   = +(process.env.SETTLE || 2500);
const DELIVER  = +(process.env.DELIVER || 2500);
const OUT      = process.env.OUT || 'results/churn/warmup-curve.jsonl';

const ks = shrinkKeyspace(HASH_BITS);
const TOPIC = { region: 'useast', owner: null, name: 'warmup-curve', write: 'open' };
const topicBig = BigInt('0x' + await deriveTopicId(TOPIC));
const rnd = (n) => Math.floor(Math.random() * n);

console.log(`warmup-curve kernel v${KERNEL_VERSION} idBits=${ks.idBits}  N=${N} SUBS=${SUBS} batch=${BATCH} rounds=${ROUNDS} (globally spread)`);

console.log(`building ${N}-node mesh (no initial warmup)…`);
let t = Date.now();
const state = await buildMesh({ N, K, refresh: 100000, renew: 1, spread: true });   // renew=1 → every refreshTick re-homes
console.log(`  built in ${((Date.now()-t)/1000).toFixed(1)}s`);
const peers = [...state.byBig.values()];

const publisher = peers[0];
publisher.author = await createAuthorIdentity(); publisher.isPublisher = true;
const cohort = peers.slice(1, 1 + SUBS);
for (const s of cohort) {
  try { await s.peer.sub(TOPIC, (env) => { if (env?.msgId) s.received.set(String(env.msgId), Date.now()); }); } catch { /* */ }
}

// true global XOR-closest live node to a target
function trueClosest(target) {
  let best = null, bestD = null;
  for (const p of peers) { const d = p.big ^ target; if (bestD === null || d < bestD) { bestD = d; best = p.big; } }
  return best;
}
async function lookupPct() {
  let hit = 0;
  for (let i = 0; i < SAMPLES; i++) {
    const src = peers[rnd(peers.length)];
    const target = peers[rnd(peers.length)].big;
    try {
      const r = await src.peer.findKClosest(target, 1);
      const got = r?.[0] != null ? (typeof r[0] === 'bigint' ? r[0] : BigInt('0x' + r[0])) : null;
      if (got === trueClosest(target)) hit++;
    } catch { /* */ }
  }
  return +(100 * hit / SAMPLES).toFixed(1);
}
async function deliveryPct() {
  for (const p of state.byBig.values()) { try { await p.am?.refreshTick?.(); } catch { /* */ } }   // re-home subs on current mesh
  await wait(SETTLE);
  const id = await publish(publisher, TOPIC, 'probe');
  await wait(DELIVER);
  return +(100 * deliveredCount(cohort, id) / SUBS).toFixed(1);
}

const curve = [];
async function point(cum) {
  const lk = await lookupPct();
  const dl = await deliveryPct();
  curve.push({ cumLookups: cum, lookupPct: lk, deliveryPct: dl });
  console.log(`  warmup ${String(cum).padStart(6)} lookups →  lookup ${String(lk).padStart(5)}%   delivery ${String(dl).padStart(5)}%`);
}

await point(0);                                  // pre-warmup
for (let r = 1; r <= ROUNDS; r++) {
  await trainLookups(state, BATCH);
  await point(r * BATCH);
}

mkdirSync(dirname(OUT), { recursive: true });
appendFileSync(OUT, JSON.stringify({ ts: new Date().toISOString(), kernelVersion: KERNEL_VERSION, scenario: { N, SUBS, K, batch: BATCH, rounds: ROUNDS, hashBits: HASH_BITS, idBits: ks.idBits }, curve }) + '\n');
console.log(`\n→ ${OUT}`);
process.exit(0);

// diag-region-bias.mjs — is the pub/sub root-resolution biased vs base DHT?
// Build a globally-spread mesh, pick a useast topic, and for far-region nodes
// compare three answers for "who is the topic root?":
//   true   — brute-force global XOR-closest LIVE node (ground truth)
//   local  — the default-dht findKClosest pub/sub uses (synaptome-only)
//   iter   — peer.findKClosest (iterative network probe — what lookup() uses)
import { buildMesh, shrinkKeyspace, deriveTopicId, KERNEL_VERSION } from './lib/axon-mesh.mjs';

const N = +(process.env.N || 800), K = +(process.env.K || 20);
shrinkKeyspace(+(process.env.HASH_BITS || 64));
console.log(`diag-region-bias kernel v${KERNEL_VERSION}  N=${N} K=${K} (globally spread)`);

const state = await buildMesh({ N, K, refresh: 100000, renew: 100000, spread: true });
const peers = [...state.byBig.values()];
const topicBig = BigInt('0x' + await deriveTopicId({ region: 'useast', owner: null, name: 'diag', write: 'open' }));
const regionOf = (big) => big >> BigInt(state.peers?.[0]?.am ? 64 : 64);   // top byte (hashBits=64)
const topByte = (big) => Number(big >> 64n);
const topicRegion = topByte(topicBig);

// optional warmup: run random lookups across the mesh to LEARN long-range
// synapses (LTP / small-world densification), as the benchmark does before it
// measures its 100%-global routing. WARMUP_LOOKUPS=0 = untrained (default).
const WARMUP_LOOKUPS = +(process.env.WARMUP_LOOKUPS || 0);
if (WARMUP_LOOKUPS > 0) {
  const list = [...state.byBig.values()];
  console.log(`warmup: ${WARMUP_LOOKUPS} random lookups to train the mesh…`);
  for (let i = 0; i < WARMUP_LOOKUPS; i++) {
    const src = list[Math.floor(Math.random() * list.length)];
    const tgt = list[Math.floor(Math.random() * list.length)].big;
    try { await src.peer.lookup(tgt); } catch { /* */ }
  }
}

// ground truth: global XOR-closest live node
let trueRoot = null, bestD = null;
for (const p of peers) { const d = p.big ^ topicBig; if (bestD === null || d < bestD) { bestD = d; trueRoot = p.big; } }
const trueRegion = topByte(trueRoot);
const sameRegionCount = peers.filter(p => topByte(p.big) === topicRegion).length;

console.log(`topic region byte=0x${topicRegion.toString(16)}  true-root region=0x${trueRegion.toString(16)}  nodes-in-topic-region=${sameRegionCount}/${N}`);

// sample far-region nodes (top byte != topic region)
const far = peers.filter(p => topByte(p.big) !== topicRegion);
const sample = far.sort(() => Math.random() - 0.5).slice(0, 25);

let localHit = 0, iterHit = 0, lookupHit = 0, lookupFound = 0;
const asBig = (x) => x == null ? null : (typeof x === 'bigint' ? x : BigInt('0x' + x));
for (const p of sample) {
  const local = await p.peer._axonaManager.dht.findKClosest(topicBig, 1);
  const iter  = await p.peer.findKClosest(topicBig, 1);
  const lk    = await p.peer.lookup(topicBig);                     // the base-DHT _lookupStep path (100%-global primitive)
  const lb = asBig(local?.[0]), ib = asBig(iter?.[0]);
  const term = lk?.path?.length ? asBig(lk.path[lk.path.length - 1]) : null;   // terminal node of the lookup
  if (lb === trueRoot) localHit++;
  if (ib === trueRoot) iterHit++;
  if (term === trueRoot) lookupHit++;
  if (lk?.found) lookupFound++;
}
console.log(`\nfar-region subscribers (n=${sample.length}) — reached the TRUE root?`);
console.log(`  local-only findKClosest (pub/sub default): ${localHit}/${sample.length}`);
console.log(`  iterative  findKClosest:                   ${iterHit}/${sample.length}`);
console.log(`  base-DHT   lookup() terminal:              ${lookupHit}/${sample.length}   (lookup reported found: ${lookupFound}/${sample.length})`);
console.log(`\n→ if lookup≈all but findKClosest≈half: the bias is the routing PRIMITIVE pub/sub uses, not the metric.`);
console.log(`→ if lookup also≈half: the harness mesh itself is too sparse for global reach (confound, not axon bias).`);

for (const p of peers) { try { await p.peer.stop?.(); } catch { /* */ } }
process.exit(0);

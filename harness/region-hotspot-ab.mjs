// region-hotspot-ab.mjs — quantify the ocean-topic hotspot, before/after the
// canonical-region fold (kernel 4.23.0).
//
// THE PROBLEM: a topic's id is `regionByte ‖ hash`. Anchor a topic at an OCEAN
// cell and its region byte points at a slice of the keyspace where NO nodes
// live (people are on land), so its K-closest root cohort collapses onto the
// same handful of boundary nodes nearest that ocean byte — a hotspot. Every
// ocean-anchored topic in the world piles onto that same tiny set.
//
// THE FIX: canonicalRegion() folds each ocean/sparse cell onto its nearest
// MAJOR (populated) region at mint time, so the topic id carries a real region
// byte and its cohort spreads across that region's full node population.
//
// THIS HARNESS holds one realistic node population fixed and mints the SAME
// topics two ways — raw ocean byte (pre) vs canonicalized byte (post) — then
// measures how concentrated the root cohorts are. Isolates the topic-placement
// effect (the mechanism the fix targets); node identities are unchanged.
//
//   node harness/region-hotspot-ab.mjs
//
// Uses the vendored kernel's real id math + region model.

import {
  MAJORS, canonicalRegion, REGION_NAMES,
} from '../../axona-protocol/src/utils/region-names.js';
import { assembleId, xorDistance } from '../../axona-protocol/src/utils/hexid.js';
import { S2_CELL_COUNT } from '../../axona-protocol/src/utils/s2.js';

const MAJOR_CODES = Object.keys(MAJORS).map(Number);
const OCEAN_CODES = [];
for (let c = 0; c < S2_CELL_COUNT; c++) if (MAJORS[c] === undefined) OCEAN_CODES.push(c);

// ── deterministic PRNG (no Math.random — reproducible gate) ──────────────────
let _seed = 0x9e3779b9;
function rand() { _seed = (_seed * 1664525 + 1013904223) >>> 0; return _seed / 0x100000000; }
function randHash() { // 256-bit-ish spread across the hash region as a BigInt
  let h = 0n;
  for (let i = 0; i < 8; i++) h = (h << 32n) | BigInt((rand() * 0x100000000) >>> 0);
  return h;
}

const K = 3;                 // root cohort size (K-closest)
const NODES_PER_REGION = 25; // realistic-ish population spread over the 84 majors
const TOPICS = 2000;         // ocean-anchored topics to mint

// ── node population: NODES_PER_REGION nodes in each MAJOR region (people live on
// land; every node's top byte is a populated canonical region). Fixed for A/B. ──
const nodes = [];
for (const rc of MAJOR_CODES)
  for (let i = 0; i < NODES_PER_REGION; i++)
    nodes.push(assembleId(rc, randHash()));

function rootCohort(topicId) {           // K nodes with smallest XOR distance
  return nodes
    .map((n) => [n, xorDistance(n, topicId)])
    .sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
    .slice(0, K)
    .map((x) => x[0]);
}

function measure(label, regionByteFor) {
  const load = new Map();                // nodeId → #topics it roots
  for (let t = 0; t < TOPICS; t++) {
    const oceanCode = OCEAN_CODES[(rand() * OCEAN_CODES.length) | 0];
    const topicId = assembleId(regionByteFor(oceanCode), randHash());
    for (const n of rootCohort(topicId)) load.set(n, (load.get(n) || 0) + 1);
  }
  const loads = [...load.values()].sort((a, b) => b - a);
  const distinctRoots = loads.length;
  const maxLoad = loads[0] || 0;
  const totalAssign = loads.reduce((a, b) => a + b, 0);
  // share of all root-assignments carried by the busiest 1% of nodes
  const top1pct = Math.max(1, Math.floor(nodes.length * 0.01));
  const hotShare = loads.slice(0, top1pct).reduce((a, b) => a + b, 0) / totalAssign;
  console.log(`\n${label}`);
  console.log(`  distinct root nodes used : ${distinctRoots} / ${nodes.length}`);
  console.log(`  busiest node roots       : ${maxLoad} topics  (${(100 * maxLoad / TOPICS).toFixed(1)}% of all topics)`);
  console.log(`  load on busiest 1% nodes : ${(100 * hotShare).toFixed(1)}% of all root-assignments`);
  return { distinctRoots, maxLoad, hotShare };
}

console.log('='.repeat(70));
console.log(`REGION HOTSPOT A/B — ${nodes.length} nodes (${MAJOR_CODES.length} regions × ${NODES_PER_REGION}), ` +
  `${TOPICS} ocean-anchored topics, K=${K}`);
console.log(`ocean/sparse cells: ${OCEAN_CODES.length}   canonical majors: ${MAJOR_CODES.length}`);
console.log('='.repeat(70));

_seed = 0x9e3779b9;
const pre = measure('PRE  (raw ocean region byte — the hotspot)', (c) => c);
_seed = 0x9e3779b9;  // same topic stream
const post = measure('POST (canonicalRegion fold)', (c) => canonicalRegion(c));

console.log('\n' + '='.repeat(70));
// "Hotspot" = a few nodes carrying a disproportionate share. The metrics that
// capture it are PEAK per-node load and the busiest-1% share — NOT the count of
// distinct nodes touched (PRE touches more nodes, but spikes each; POST folds
// into fewer regions yet spreads evenly WITHIN them — the intended behavior).
const peakDrop = (pre.maxLoad / Math.max(1, post.maxLoad)).toFixed(1);
const hotDrop = (pre.hotShare / Math.max(1e-9, post.hotShare)).toFixed(1);
console.log(`RESULT: peak node load    ${pre.maxLoad} → ${post.maxLoad} topics   (${peakDrop}× lower hotspot)`);
console.log(`        busiest-1% share  ${(100 * pre.hotShare).toFixed(1)}% → ${(100 * post.hotShare).toFixed(1)}%   (${hotDrop}× less concentrated)`);
console.log(`        (nodes touched ${pre.distinctRoots} → ${post.distinctRoots}; fewer regions, even spread within — by design)`);
const PASS = post.maxLoad < pre.maxLoad * 0.6 && post.hotShare < pre.hotShare * 0.75;
console.log(PASS ? '✓ GATE PASS — fold materially de-concentrates ocean topics (peak & tail both down)' :
                   '✗ GATE FAIL — fold did not reduce concentration');
console.log('='.repeat(70));
process.exit(PASS ? 0 : 1);

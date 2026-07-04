// =====================================================================
// nursery-experiment.mjs — W2 B3+B4: bootstrap-nursery experiment (one run).
//
// Grows an N-node mesh via one of three INTRODUCTION arms, under optional
// rejoin churn, with a BOUNDED lookup-traffic budget per grow step (the
// sim's real self-expansion mechanism — see the probe in W2-nursery-scope.md),
// and emits structural metrics as one JSON line.
//
//   ARM=A  god's-eye ceiling — buildRoutingTables reseats each round (no bridge)
//   ARM=B  floor — each newcomer introduced to ONE random sponsor (k=1)
//   ARM=C  curated — BridgeNursery.introduce → k composite-scored anchors
//
// Env: ARM N K CHURN TRAFFIC GENESIS BATCH SEED
//   CHURN   = % of live non-genesis nodes that leave+rejoin each round
//   TRAFFIC = lookup rounds per grow step (bounded self-expansion)
//
// Metrics (over live NON-genesis nodes — the ones the bridge integrated):
//   fill        median synaptome degree
//   inbound     median inbound refs (nodes referencing it — honest reachability)
//   reachFrac   fraction with inbound >= K
//   meshShare   mean (final - bridgeContribution)/final  (mesh did the rest)
//   eclipse     max anchor-usage share + gini (C only)
//
// Run:  ARM=C N=500 CHURN=20 node harness/nursery-experiment.mjs
// =====================================================================

import { TransportAxonaEngine } from '../src/dht/neuromorphic/TransportAxonaEngine.js';
import { BridgeNursery } from './BridgeNursery.mjs';

const ARM     = process.env.ARM     || 'C';
const N       = +(process.env.N     || 500);
const K       = +(process.env.K     || 3);
const CHURN   = +(process.env.CHURN || 0);
const TRAFFIC = +(process.env.TRAFFIC || 3);
const GENESIS = +(process.env.GENESIS || 20);
const BATCH   = +(process.env.BATCH || 25);
const SEED    = +(process.env.SEED  || 1);
// Uniform realistic synaptome cap across ALL arms — else god's-eye
// buildRoutingTables seats an unbounded near-all-to-all degree and the
// "fraction of ceiling" comparison is meaningless. 50 == domain MAX_SYNAPTOME.
const MAXCONN = +(process.env.MAXCONN || 50);

// Small deterministic PRNG so runs are reproducible per SEED (Math.random
// would make reps non-comparable). Mulberry32.
let _s = SEED >>> 0;
const rng = () => { _s |= 0; _s = _s + 0x6D2B79F5 | 0; let t = Math.imul(_s ^ _s >>> 15, 1 | _s); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
const rand = (a, b) => a + rng() * (b - a);
const median = (xs) => { if (!xs.length) return 0; const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const mean = (xs) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;

const eng = new TransportAxonaEngine({ k: 20, geoBits: 8 });
const nur = new BridgeNursery(eng, { k: K, minUptime: 3 });
const genesis = new Set();           // ids that were the seed core (excluded from metrics)
const bridgeContrib = new Map();     // newcomerId -> synaptome size right after its introduce

function liveIds()        { return [...eng.nodeMap.values()].filter(n => n.alive).map(n => n.id); }
function liveNewcomers()  { return liveIds().filter(id => !genesis.has(id)); }
function inboundRefs(id) {
  let r = 0;
  for (const n of eng.nodeMap.values()) { if (!n.alive || n.id === id) continue; if (n.synaptome.has(id) || n.incomingSynapses.has(id)) r++; }
  return r;
}
async function addIsolated(round) {
  const before = new Set(eng.nodeMap.keys());
  await eng.addNode(rand(-60, 60), rand(-180, 180));
  const id = [...eng.nodeMap.keys()].find(x => !before.has(x));
  eng.nodeMap.get(id).maxConnections = MAXCONN; // uniform realistic cap
  nur.onJoin(round, id);
  return id;
}
async function introduce(round, id) {
  if (ARM === 'B') {
    const pool = liveIds().filter(x => x !== id);
    const sponsor = pool[Math.floor(rng() * pool.length)];
    await eng.bridgeIntroduce(id, [sponsor]);
  } else if (ARM === 'C') {
    await nur.introduce(round, id, K);
  }
  // ARM A does nothing here — buildRoutingTables (below) is its god's-eye seat.
  bridgeContrib.set(id, eng.nodeMap.get(id).synaptome.size);
}
// Bounded self-expansion, TARGETED at the round's joiners (scalable: O(joiners)
// not O(N)). Each joiner does TRAFFIC outbound lookups (explores → grows its own
// synaptome) and receives TRAFFIC inbound lookups (others route to it → grows its
// inbound refs). This is the sim's real growth path (lookup learning), bounded so
// introduction QUALITY still matters before a node accumulates traffic.
async function traffic(joiners) {
  const ids = liveIds();
  if (ids.length < 2 || !joiners.length) return;
  for (const j of joiners) {
    if (!eng.nodeMap.get(j)?.alive) continue;
    for (let i = 0; i < TRAFFIC; i++) {
      const t = ids[Math.floor(rng() * ids.length)];
      if (t !== j) await eng.lookup(j, t);   // joiner explores (outbound)
      const s = ids[Math.floor(rng() * ids.length)];
      if (s !== j) await eng.lookup(s, j);   // someone routes to joiner (inbound)
    }
  }
}

// ── genesis core ──
for (let i = 0; i < GENESIS; i++) { const id = await addIsolated(0); genesis.add(id); }
await eng.buildRoutingTables({ bidirectional: true, maxConnections: MAXCONN });

// ── grow to N, with per-round rejoin churn ──
let round = 0;
while (liveNewcomers().length + genesis.size < N) {
  round++;
  const joiners = [];

  // rejoin churn: some live non-genesis nodes LEAVE and REJOIN the same
  // round — each rejoin is a fresh addNode + fresh introduction (the real
  // cost). Net population from churn is zero (so growth still terminates);
  // fresh newcomers below are what grow the mesh toward N.
  if (CHURN > 0 && round > 1) {
    const pool = liveNewcomers();
    const nLeave = Math.floor(pool.length * CHURN / 100);
    const victims = [];
    for (let i = 0; i < nLeave; i++) {
      const v = pool[Math.floor(rng() * pool.length)];
      if (v != null && !victims.includes(v)) victims.push(v);
    }
    for (const v of victims) await eng.removeNode(v);
    for (let i = 0; i < victims.length; i++) joiners.push(await addIsolated(round)); // rejoiners
  }

  // fresh newcomers this round (bounded by BATCH and the N target).
  const target = Math.min(BATCH, N - (liveNewcomers().length + genesis.size));
  for (let i = 0; i < target; i++) joiners.push(await addIsolated(round));

  if (ARM === 'A') {
    await eng.buildRoutingTables({ bidirectional: true, maxConnections: MAXCONN }); // god's-eye ceiling
  } else {
    for (const id of joiners) await introduce(round, id);
  }
  await traffic(joiners);
  if (ARM === 'C') nur.graduate(round);
}
await traffic(liveNewcomers().slice(0, 200)); // final settle (bounded)

// ── measure over live newcomers ──
const news = liveNewcomers();
const fills   = news.map(id => eng.nodeMap.get(id).synaptome.size);
const inb     = news.map(id => inboundRefs(id));
const reach   = news.filter(id => inboundRefs(id) >= K).length / (news.length || 1);
const meshSh  = news.map(id => {
  const fin = eng.nodeMap.get(id).synaptome.size;
  const bc  = bridgeContrib.get(id) ?? fin;
  return fin > 0 ? Math.max(0, (fin - bc) / fin) : 0;
});

// eclipse concentration from anchor usage (C only)
let eclipseMax = 0, eclipseGini = 0;
if (ARM === 'C') {
  const uses = [...nur._attempts.values()];
  const tot = uses.reduce((a, b) => a + b, 0);
  if (tot > 0) {
    eclipseMax = Math.max(...uses) / tot;
    const s = [...uses].sort((a, b) => a - b); let cum = 0, g = 0;
    for (let i = 0; i < s.length; i++) { cum += s[i]; g += cum; }
    eclipseGini = s.length ? (s.length + 1 - 2 * (g / cum)) / s.length : 0;
  }
}

console.log(JSON.stringify({
  arm: ARM, N, K, churn: CHURN, traffic: TRAFFIC, seed: SEED,
  liveNewcomers: news.length,
  fillMed: median(fills), fillMean: +mean(fills).toFixed(2),
  inboundMed: median(inb), inboundMean: +mean(inb).toFixed(2),
  reachFrac: +reach.toFixed(3),
  meshShareMean: +mean(meshSh).toFixed(3),
  eclipseMax: +eclipseMax.toFixed(3), eclipseGini: +eclipseGini.toFixed(3),
  graduated: ARM === 'C' ? nur._graduated.size : null,
}));

/**
 * NX-1W Coordinate Descent Parameter Search
 * Minimises pub/sub bcast ms by varying one parameter at a time.
 * Runs 30 candidates then optionally a combined validation run.
 *
 * Usage: node coord_descent.mjs
 */

import { readFileSync } from 'fs';

const BASE_URL  = 'http://localhost:3000';
const RESULTS   = '/Users/croqueteer/Documents/claude/dht-sim/results/benchmark_latest.csv';
const NOISE_MS  = 8;          // minimum improvement to keep a change
const POLL_MS   = 20_000;     // poll interval
const TIMEOUT_S = 300;        // max seconds to wait per run
const START_TS  = Date.now();
const TIME_LIMIT_MS = 58 * 60_000;  // 58 minutes

// ── Helpers ────────────────────────────────────────────────────────────────

async function apiGet(path) {
  const r = await fetch(`${BASE_URL}${path}`);
  return r.json();
}

async function apiPost(path, body) {
  const r = await fetch(`${BASE_URL}${path}`, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify(body),
  });
  return r.json();
}

async function apiDelete(path) {
  const r = await fetch(`${BASE_URL}${path}`, { method: 'DELETE' });
  return r.json();
}

async function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function log(entry) {
  console.log(entry);
  try {
    await apiPost('/api/log', { entry });
  } catch { /* non-fatal */ }
}

/** Wait until /api/status is ready, or timeout. Returns true if ready. */
async function waitForReady() {
  const deadline = Date.now() + TIMEOUT_S * 1000;
  while (Date.now() < deadline) {
    try {
      const s = await apiGet('/api/status');
      if (s.ready) return true;
    } catch { /* server hiccup, keep trying */ }
    await sleep(POLL_MS);
  }
  return false;
}

/** Parse bcast ms from the NX-1W row of benchmark_latest.csv */
function readBcastMs() {
  try {
    const csv  = readFileSync(RESULTS, 'utf8');
    const line = csv.split('\n').find(l => l.startsWith('NX-1W'));
    if (!line) return null;
    const fields = line.split(',');
    // With tests=[global,pubsub]:
    // Protocol, global hops, global ms, relay hops, relay ms, bcast hops, bcast ms
    //    0           1           2          3           4         5           6
    const bcast = parseFloat(fields[6]);
    const relay = parseFloat(fields[4]);
    const globalMs = parseFloat(fields[2]);
    return { bcast, relay, globalMs };
  } catch (e) {
    console.error('CSV read error:', e.message);
    return null;
  }
}

/** Clear any stale .ready flag */
async function clearReady() {
  try {
    const s = await apiGet('/api/status');
    if (s.ready) {
      await apiDelete('/complete');
      console.log('  [cleared stale ready flag]');
    }
  } catch { /* ignore */ }
}

/** Deep-clone an object */
function clone(obj) {
  return JSON.parse(JSON.stringify(obj));
}

// ── Default parameters (= N-15W config = baseline) ─────────────────────────

const DEFAULTS = {
  bootstrap:     { kBootFactor: 1 },
  twoTier:       { enabled: true, maxSynaptomeSize: 48, highwaySlots: 12 },
  apRouting:     { lookaheadAlpha: 5, weightScale: 0.40, geoRegionBits: 4, explorationEpsilon: 0.05, maxGreedyHops: 40 },
  ltp:           { enabled: true, inertiaDuration: 20 },
  triadic:       { enabled: true, introductionThreshold: 1 },
  hopCaching:    { enabled: true, cascadeWeight: 0.1 },
  lateralSpread: { enabled: true, lateralK: 6, lateralK2: 2, lateralMaxDepth: 2 },
  stratified:    { enabled: true, strataGroups: 16, stratumFloor: 2 },
  annealing:     { enabled: true, tInit: 1.0, tMin: 0.05, annealCooling: 0.9997, globalBias: 0.5 },
  relayPinning:  { enabled: true, relayPinThreshold: 5, relayPinWindow: 64, relayPinMax: 4, relayPinWeight: 0.95 },
  markov:        { enabled: true, markovWindow: 32, markovHotThreshold: 3, markovBaseWeight: 0.5, markovMaxWeight: 0.9 },
  adaptiveDecay: { enabled: true, decayInterval: 100, pruneThreshold: 0.05, decayGammaMin: 0.990, decayGammaMax: 0.9998, useSaturation: 20, decayGammaHighwayActive: 0.9995, decayGammaHighwayIdle: 0.990, highwayRenewalWindow: 3000, highwayFloor: 2, synaptomeFloor: 48 },
  highwayRefresh:{ enabled: true, hubRefreshInterval: 300, hubScanCap: 120, hubMinDiversity: 5, hubNoise: 1.0 },
  loadBalancing: { enabled: false, loadDecay: 0.995, loadPenalty: 0.40, loadFloor: 0.10, loadSaturation: 0.15 },
};

// ── Candidates to test (Pass 1) ─────────────────────────────────────────────
// Each entry: [ruleKey, paramKey, candidateValue, label]

const CANDIDATES = [
  // Relay Pinning
  ['relayPinning', 'relayPinThreshold',  3,       'relayPinThreshold=3'],
  ['relayPinning', 'relayPinThreshold',  7,       'relayPinThreshold=7'],
  ['relayPinning', 'relayPinWindow',     32,      'relayPinWindow=32'],
  ['relayPinning', 'relayPinWindow',     128,     'relayPinWindow=128'],
  ['relayPinning', 'relayPinMax',        2,       'relayPinMax=2'],
  ['relayPinning', 'relayPinMax',        8,       'relayPinMax=8'],
  ['relayPinning', 'relayPinWeight',     0.85,    'relayPinWeight=0.85'],
  ['relayPinning', 'relayPinWeight',     1.0,     'relayPinWeight=1.0'],
  // Markov
  ['markov', 'markovWindow',        16,    'markovWindow=16'],
  ['markov', 'markovWindow',        64,    'markovWindow=64'],
  ['markov', 'markovHotThreshold',  2,     'markovHotThreshold=2'],
  ['markov', 'markovHotThreshold',  5,     'markovHotThreshold=5'],
  ['markov', 'markovBaseWeight',    0.3,   'markovBaseWeight=0.3'],
  ['markov', 'markovBaseWeight',    0.7,   'markovBaseWeight=0.7'],
  ['markov', 'markovMaxWeight',     0.8,   'markovMaxWeight=0.8'],
  ['markov', 'markovMaxWeight',     1.0,   'markovMaxWeight=1.0'],
  // Two-Tier
  ['twoTier', 'maxSynaptomeSize',  32,    'maxSynaptomeSize=32'],
  ['twoTier', 'maxSynaptomeSize',  64,    'maxSynaptomeSize=64'],
  ['twoTier', 'highwaySlots',       8,    'highwaySlots=8'],
  ['twoTier', 'highwaySlots',      16,    'highwaySlots=16'],
  // LTP
  ['ltp', 'inertiaDuration',  10,    'inertiaDuration=10'],
  ['ltp', 'inertiaDuration',  40,    'inertiaDuration=40'],
  // Annealing
  ['annealing', 'annealCooling',  0.9990,  'annealCooling=0.9990'],
  ['annealing', 'annealCooling',  0.9999,  'annealCooling=0.9999'],
  ['annealing', 'globalBias',     0.3,     'globalBias=0.3'],
  ['annealing', 'globalBias',     0.7,     'globalBias=0.7'],
  // Adaptive Decay
  ['adaptiveDecay', 'decayGammaMax',   0.9995,  'decayGammaMax=0.9995'],
  ['adaptiveDecay', 'decayGammaMax',   0.9999,  'decayGammaMax=0.9999'],
  ['adaptiveDecay', 'synaptomeFloor',  32,      'synaptomeFloor=32'],
  ['adaptiveDecay', 'synaptomeFloor',  64,      'synaptomeFloor=64'],
];

// ── Main loop ──────────────────────────────────────────────────────────────

async function runBenchmark(rules, label, hypothesis) {
  await clearReady();

  await apiPost('/api/experiment', {
    label,
    hypothesis,
    runs: [{
      nodeCount:       5000,
      warmupSessions:  10,
      protocols:       ['ngdhtnx1w'],
      tests:           ['global', 'pubsub'],
      nx1wRules:       rules,
    }],
  });

  console.log(`  Posted: ${label}`);
  const ready = await waitForReady();
  if (!ready) {
    await log(`  TIMEOUT waiting for: ${label}`);
    return null;
  }

  const result = readBcastMs();
  await apiDelete('/complete');
  return result;
}

async function main() {
  await log('=== PASS 1 START ===');
  await log(`Baseline bcast=130ms. Testing ${CANDIDATES.length} candidates. Noise floor: ${NOISE_MS}ms.`);

  let currentBest     = clone(DEFAULTS);
  let currentBcastMs  = 130;
  const kept          = [];
  let runNum          = 0;

  for (const [ruleKey, paramKey, candidateValue, label] of CANDIDATES) {
    runNum++;

    // Check time budget
    if (Date.now() - START_TS > TIME_LIMIT_MS) {
      await log(`TIME LIMIT reached after ${runNum - 1} runs — stopping early`);
      break;
    }

    // Build rules: clone currentBest, change one param
    const rules = clone(currentBest);
    rules[ruleKey][paramKey] = candidateValue;

    console.log(`\n[Run ${runNum}/${CANDIDATES.length}] ${label}`);

    const result = await runBenchmark(
      rules,
      `Run${runNum}: ${label}`,
      `Coordinate descent — testing ${label} (baseline best: ${currentBcastMs}ms)`,
    );

    if (!result) {
      await log(`Run ${runNum}: ${label} → FAILED (no result)`);
      continue;
    }

    const { bcast, relay, globalMs } = result;
    const improved = bcast < currentBcastMs - NOISE_MS;
    const decision = improved ? 'KEEP' : 'DISCARD';

    if (improved) {
      currentBest[ruleKey][paramKey] = candidateValue;
      currentBcastMs = bcast;
      kept.push({ label, bcast, improvement: (130 - bcast).toFixed(1) });
    }

    const elapsed = ((Date.now() - START_TS) / 60000).toFixed(1);
    await log(`Run ${runNum}: ${label} → bcast ${bcast}ms relay ${relay}ms global ${globalMs}ms | ${decision} (best: ${currentBcastMs}ms) [${elapsed}min]`);
  }

  // Summary
  await log('');
  await log('=== PASS 1 COMPLETE ===');
  await log(`Candidates tested: ${runNum}`);
  if (kept.length > 0) {
    await log('Improvements kept (>' + NOISE_MS + 'ms):');
    for (const k of kept) {
      await log(`  ${k.label} → ${k.bcast}ms (${k.improvement}ms better than 130ms baseline)`);
    }
  } else {
    await log('No improvements found exceeding noise floor.');
  }
  await log(`Best bcast ms: ${currentBcastMs}ms (vs 130ms baseline = ${(130 - currentBcastMs).toFixed(1)}ms improvement)`);

  // Combined validation if any improvements and time remains
  if (kept.length > 0 && Date.now() - START_TS < TIME_LIMIT_MS) {
    await log('');
    await log('Running combined validation with all kept improvements...');
    const result = await runBenchmark(
      currentBest,
      'COMBINED validation',
      `All kept improvements combined: ${kept.map(k => k.label).join(', ')}`,
    );
    if (result) {
      const { bcast, relay, globalMs } = result;
      const combinedBetter = bcast < currentBcastMs - NOISE_MS;
      await log(`COMBINED: bcast ${bcast}ms relay ${relay}ms global ${globalMs}ms | ${combinedBetter ? 'BETTER than individual' : 'same/worse than best individual'}`);
      await log(`Final best bcast ms: ${Math.min(bcast, currentBcastMs)}ms`);
      await log('');
      await log('=== OPTIMISED PARAMETER SET ===');
      await log(JSON.stringify(currentBest, null, 2));
    }
  }

  const totalMin = ((Date.now() - START_TS) / 60000).toFixed(1);
  await log(`Total elapsed: ${totalMin} minutes`);
  console.log('\nDone.');
}

main().catch(async e => {
  console.error('Fatal error:', e);
  await log(`FATAL ERROR: ${e.message}`).catch(() => {});
  process.exit(1);
});

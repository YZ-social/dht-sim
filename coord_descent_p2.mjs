/**
 * NX-1W Coordinate Descent — Pass 2
 *
 * Starts from Pass 1 best: markovWindow=16, bcast=116ms
 * Targets:
 *   - Fine-tune markovWindow (8, 12, 20, 24)
 *   - Re-test Pass 1 borderline params against new 116ms baseline
 *   - AP routing exploration (untested territory)
 *   - Lateral spread and hop caching (untested)
 *
 * Usage: node coord_descent_p2.mjs
 */

import { readFileSync } from 'fs';

const BASE_URL      = 'http://localhost:3000';
const RESULTS       = '/Users/croqueteer/Documents/claude/dht-sim/results/benchmark_latest.csv';
const NOISE_MS      = 8;
const POLL_MS       = 20_000;
const TIMEOUT_S     = 300;
const START_TS      = Date.now();
const TIME_LIMIT_MS = 58 * 60_000;

// ── Helpers ─────────────────────────────────────────────────────────────────

async function apiGet(path) {
  const r = await fetch(`${BASE_URL}${path}`);
  return r.json();
}
async function apiPost(path, body) {
  const r = await fetch(`${BASE_URL}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return r.json();
}
async function apiDelete(path) {
  const r = await fetch(`${BASE_URL}${path}`, { method: 'DELETE' });
  return r.json();
}
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function log(entry) {
  console.log(entry);
  try { await apiPost('/api/log', { entry }); } catch { /* non-fatal */ }
}

async function waitForReady() {
  const deadline = Date.now() + TIMEOUT_S * 1000;
  while (Date.now() < deadline) {
    try { const s = await apiGet('/api/status'); if (s.ready) return true; } catch {}
    await sleep(POLL_MS);
  }
  return false;
}

function readResult() {
  try {
    const csv  = readFileSync(RESULTS, 'utf8');
    const line = csv.split('\n').find(l => l.startsWith('NX-1W'));
    if (!line) return null;
    const f = line.split(',');
    return { bcast: parseFloat(f[6]), relay: parseFloat(f[4]), globalMs: parseFloat(f[2]) };
  } catch { return null; }
}

async function clearReady() {
  try {
    const s = await apiGet('/api/status');
    if (s.ready) { await apiDelete('/complete'); console.log('  [cleared stale flag]'); }
  } catch {}
}

function clone(obj) { return JSON.parse(JSON.stringify(obj)); }

// ── Best params from Pass 1 ──────────────────────────────────────────────────

const BEST_P1 = {
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
  markov:        { enabled: true, markovWindow: 16, markovHotThreshold: 3, markovBaseWeight: 0.5, markovMaxWeight: 0.9 },
  adaptiveDecay: { enabled: true, decayInterval: 100, pruneThreshold: 0.05, decayGammaMin: 0.990, decayGammaMax: 0.9998, useSaturation: 20, decayGammaHighwayActive: 0.9995, decayGammaHighwayIdle: 0.990, highwayRenewalWindow: 3000, highwayFloor: 2, synaptomeFloor: 48 },
  highwayRefresh:{ enabled: true, hubRefreshInterval: 300, hubScanCap: 120, hubMinDiversity: 5, hubNoise: 1.0 },
  loadBalancing: { enabled: false, loadDecay: 0.995, loadPenalty: 0.40, loadFloor: 0.10, loadSaturation: 0.15 },
};

// ── Pass 2 candidates ────────────────────────────────────────────────────────

const CANDIDATES = [
  // --- Fine-tune markovWindow around the Pass 1 winner (16) ---
  ['markov',        'markovWindow',       8,      'markovWindow=8'],
  ['markov',        'markovWindow',       12,     'markovWindow=12'],
  ['markov',        'markovWindow',       20,     'markovWindow=20'],
  ['markov',        'markovWindow',       24,     'markovWindow=24'],

  // --- Re-test Pass 1 borderliners vs new 116ms baseline ---
  ['relayPinning',  'relayPinWindow',     32,     'relayPinWindow=32'],
  ['ltp',           'inertiaDuration',    10,     'inertiaDuration=10'],
  ['relayPinning',  'relayPinWeight',     0.85,   'relayPinWeight=0.85'],
  ['twoTier',       'highwaySlots',       8,      'highwaySlots=8'],

  // --- AP routing (untested in Pass 1) ---
  ['apRouting',     'weightScale',        0.30,   'weightScale=0.30'],
  ['apRouting',     'weightScale',        0.50,   'weightScale=0.50'],
  ['apRouting',     'explorationEpsilon', 0.02,   'explorationEpsilon=0.02'],
  ['apRouting',     'explorationEpsilon', 0.10,   'explorationEpsilon=0.10'],
  ['apRouting',     'lookaheadAlpha',     3,      'lookaheadAlpha=3'],
  ['apRouting',     'lookaheadAlpha',     8,      'lookaheadAlpha=8'],

  // --- Lateral spread (untested) ---
  ['lateralSpread', 'lateralK',           4,      'lateralK=4'],
  ['lateralSpread', 'lateralK',           8,      'lateralK=8'],
  ['lateralSpread', 'lateralMaxDepth',    1,      'lateralMaxDepth=1'],
  ['lateralSpread', 'lateralMaxDepth',    3,      'lateralMaxDepth=3'],

  // --- Hop caching (untested) ---
  ['hopCaching',    'cascadeWeight',      0.05,   'cascadeWeight=0.05'],
  ['hopCaching',    'cascadeWeight',      0.20,   'cascadeWeight=0.20'],

  // --- Highway refresh (untested) ---
  ['highwayRefresh','hubRefreshInterval', 150,    'hubRefreshInterval=150'],
  ['highwayRefresh','hubRefreshInterval', 600,    'hubRefreshInterval=600'],
];

// ── Run one benchmark ────────────────────────────────────────────────────────

async function runBenchmark(rules, label, hypothesis) {
  await clearReady();
  await apiPost('/api/experiment', {
    label, hypothesis,
    runs: [{ nodeCount: 5000, warmupSessions: 10, protocols: ['ngdhtnx1w'], tests: ['global', 'pubsub'], nx1wRules: rules }],
  });
  console.log(`  Posted: ${label}`);
  const ready = await waitForReady();
  if (!ready) { await log(`  TIMEOUT: ${label}`); return null; }
  const result = readResult();
  await apiDelete('/complete');
  return result;
}

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  await log('');
  await log('=== PASS 2 START ===');
  await log(`Starting from Pass 1 best: markovWindow=16, bcast=116ms. Testing ${CANDIDATES.length} candidates. Noise floor: ${NOISE_MS}ms.`);

  let currentBest    = clone(BEST_P1);
  let currentBcastMs = 116;
  const kept         = [];
  let runNum         = 0;

  for (const [ruleKey, paramKey, candidateValue, label] of CANDIDATES) {
    runNum++;

    if (Date.now() - START_TS > TIME_LIMIT_MS) {
      await log(`TIME LIMIT reached after ${runNum - 1} runs — stopping early`);
      break;
    }

    const rules = clone(currentBest);
    rules[ruleKey][paramKey] = candidateValue;

    console.log(`\n[Run ${runNum}/${CANDIDATES.length}] ${label}`);

    const result = await runBenchmark(
      rules,
      `P2-Run${runNum}: ${label}`,
      `Pass 2 coord descent — ${label} (current best: ${currentBcastMs}ms)`,
    );

    if (!result) {
      await log(`P2 Run ${runNum}: ${label} → FAILED`);
      continue;
    }

    const { bcast, relay, globalMs } = result;
    const improved = bcast < currentBcastMs - NOISE_MS;
    const decision = improved ? 'KEEP' : 'DISCARD';

    if (improved) {
      currentBest[ruleKey][paramKey] = candidateValue;
      currentBcastMs = bcast;
      kept.push({ label, bcast, delta: (116 - bcast).toFixed(1) });
    }

    const elapsed = ((Date.now() - START_TS) / 60000).toFixed(1);
    await log(`P2 Run ${runNum}: ${label} → bcast ${bcast}ms relay ${relay}ms global ${globalMs}ms | ${decision} (best: ${currentBcastMs}ms) [${elapsed}min]`);
  }

  // Summary
  await log('');
  await log('=== PASS 2 COMPLETE ===');
  await log(`Candidates tested: ${runNum}`);
  if (kept.length > 0) {
    await log(`Improvements kept (>${NOISE_MS}ms from 116ms):`);
    for (const k of kept) {
      await log(`  ${k.label} → ${k.bcast}ms (${k.delta}ms gain over Pass 1 best)`);
    }
  } else {
    await log('No further improvements found — Pass 1 result (116ms, markovWindow=16) holds.');
  }
  await log(`Best bcast ms after Pass 2: ${currentBcastMs}ms (overall improvement from baseline: ${(130 - currentBcastMs).toFixed(1)}ms)`);

  // Combined validation if any new improvements
  if (kept.length > 0 && Date.now() - START_TS < TIME_LIMIT_MS) {
    await log('');
    await log('Running combined validation...');
    const result = await runBenchmark(
      currentBest,
      'P2-COMBINED validation',
      `All Pass 2 improvements combined: ${kept.map(k => k.label).join(', ')}`,
    );
    if (result) {
      const { bcast, relay, globalMs } = result;
      await log(`P2 COMBINED: bcast ${bcast}ms relay ${relay}ms global ${globalMs}ms`);
      await log(`Final best bcast ms: ${Math.min(bcast, currentBcastMs)}ms`);
    }
  }

  await log('');
  await log('=== FINAL OPTIMISED PARAMETER SET (Pass 1 + Pass 2) ===');
  await log(JSON.stringify(currentBest, null, 2));

  const totalMin = ((Date.now() - START_TS) / 60000).toFixed(1);
  await log(`Total Pass 2 elapsed: ${totalMin} minutes`);
  console.log('\nDone.');
}

main().catch(async e => {
  console.error('Fatal:', e);
  await log(`FATAL: ${e.message}`).catch(() => {});
  process.exit(1);
});

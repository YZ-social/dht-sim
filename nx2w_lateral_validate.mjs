/**
 * NX-2W Lateral Spread Validation
 *
 * Validates that depth=1, K2=2 outperforms the default depth=2, K2=2
 * across all 6 conditions (2 node counts × 3 group sizes).
 *
 * Hypothesis: lateralMaxDepth=1, lateralK2=2 is better than the default
 *             lateralMaxDepth=2, lateralK2=2 at all group sizes.
 *
 * Usage: node nx2w_lateral_validate.mjs
 */

import { readFileSync, writeFileSync } from 'fs';

const BASE_URL  = 'http://localhost:3000';
const RESULTS   = '/Users/croqueteer/Documents/claude/dht-sim/results/benchmark_latest.csv';
const REPORT    = '/Users/croqueteer/Documents/claude/dht-sim/results/nx2w_lateral_validate.csv';
const POLL_MS   = 20_000;
const TIMEOUT_S = 360;
const START_TS  = Date.now();

// ── Helpers ───────────────────────────────────────────────────────────────────

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
  await fetch(`${BASE_URL}${path}`, { method: 'DELETE' });
}
async function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

async function log(entry) {
  console.log(entry);
  try { await apiPost('/api/log', { entry }); } catch {}
}

async function waitForReady() {
  const deadline = Date.now() + TIMEOUT_S * 1000;
  while (Date.now() < deadline) {
    try { const s = await apiGet('/api/status'); if (s.ready) return true; } catch {}
    await sleep(POLL_MS);
  }
  return false;
}

async function clearReady() {
  try {
    const s = await apiGet('/api/status');
    if (s.ready) await apiDelete('/complete');
  } catch {}
}

function parseCSV() {
  try {
    const csv    = readFileSync(RESULTS, 'utf8');
    const lines  = csv.split('\n');
    const header = lines.find(l => l.startsWith('Protocol,'));
    const hasGlobal = header?.includes('global');
    const rows   = {};
    for (const line of lines) {
      const f = line.trim().replace(/\r/, '').split(',');
      if (f.length < 5) continue;
      const proto = f[0].trim();
      if (!['NX-2W'].includes(proto)) continue;
      if (hasGlobal && f.length >= 7) {
        rows[proto] = { globalMs: +f[2], bcastHops: +f[5], bcastMs: +f[6] };
      } else if (!hasGlobal && f.length >= 5) {
        rows[proto] = { globalMs: NaN, bcastHops: +f[3], bcastMs: +f[4] };
      }
    }
    return rows;
  } catch (e) {
    console.error('CSV parse error:', e.message);
    return null;
  }
}

function fmt(v, decimals = 0) {
  return isNaN(v) ? '—' : v.toFixed(decimals);
}

// ── NX-2W rules factory ───────────────────────────────────────────────────────

function makeRules(lateralMaxDepth, lateralK2) {
  return {
    bootstrap:      { kBootFactor: 1 },
    twoTier:        { enabled: true, maxSynaptomeSize: 48, highwaySlots: 12 },
    apRouting:      { lookaheadAlpha: 5, weightScale: 0.40, geoRegionBits: 4, explorationEpsilon: 0.05, maxGreedyHops: 40 },
    ltp:            { enabled: true, inertiaDuration: 20 },
    triadicClosure: { enabled: true, introductionThreshold: 1 },
    hopCaching:     { enabled: true, cascadeWeight: 0.1 },
    lateralSpread:  { enabled: true, lateralK: 6, lateralK2, lateralMaxDepth },
    stratified:     { enabled: true, strataGroups: 16, stratumFloor: 2 },
    annealing:      { enabled: true, tInit: 1.0, tMin: 0.05, annealCooling: 0.9997, globalBias: 0.5 },
    markov:         { enabled: true, markovWindow: 16, markovHotThreshold: 3, markovBaseWeight: 0.5, markovMaxWeight: 0.9 },
    adaptiveDecay:  { enabled: true, decayInterval: 100, pruneThreshold: 0.05, decayGammaMin: 0.990, decayGammaMax: 0.9998, useSaturation: 20, decayGammaHighwayActive: 0.9995, decayGammaHighwayIdle: 0.990, highwayRenewalWindow: 3000, highwayFloor: 2, synaptomeFloor: 48 },
    highwayRefresh: { enabled: true, hubRefreshInterval: 300, hubScanCap: 120, hubMinDiversity: 5, hubNoise: 1.0 },
    loadBalancing:  { enabled: false },
  };
}

// ── Test conditions ───────────────────────────────────────────────────────────

const CONDITIONS = [
  { label: '5k-gs16',  nodes: 5000,  groupSize: 16  },
  { label: '5k-gs64',  nodes: 5000,  groupSize: 64  },
  { label: '5k-gs256', nodes: 5000,  groupSize: 256 },
  { label: '10k-gs16', nodes: 10000, groupSize: 16  },
  { label: '10k-gs64', nodes: 10000, groupSize: 64  },
  { label: '10k-gs256',nodes: 10000, groupSize: 256 },
];

const CONFIGS = [
  { name: 'baseline (d=2,K2=2)', depth: 2, k2: 2 },
  { name: 'candidate (d=1,K2=2)', depth: 1, k2: 2 },
];

// ── Run one condition+config ──────────────────────────────────────────────────

async function runOne(cond, cfg) {
  await clearReady();

  const payload = {
    label:           `NX-2W validate lateral: ${cfg.name} @ ${cond.label}`,
    hypothesis:      `depth=${cfg.depth} K2=${cfg.k2} at ${cond.nodes} nodes gs=${cond.groupSize}`,
    nodeCount:       cond.nodes,
    pubsubGroupSize: cond.groupSize,
    warmupSessions:  10,
    protocols:       ['ngdhtnx2w'],
    tests:           ['global', 'pubsub'],
    nx1wRules:       makeRules(cfg.depth, cfg.k2),
  };

  await apiPost('/api/experiment', { runs: [payload] });

  const ok = await waitForReady();
  if (!ok) return null;

  await sleep(500);
  const rows = parseCSV();
  await apiDelete('/complete');
  return rows?.['NX-2W'] ?? null;
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  await log('════════════════════════════════════════════════════════');
  await log('NX-2W LATERAL SPREAD VALIDATION');
  await log('════════════════════════════════════════════════════════');
  await log('Candidate : lateralMaxDepth=1, lateralK2=2');
  await log('Baseline  : lateralMaxDepth=2, lateralK2=2 (current default)');
  await log('Conditions: 6 (2 node counts × 3 group sizes)');
  await log('Warmup    : 10 sessions');
  await log('');

  // results[conditionIndex][configIndex] = data
  const grid = CONDITIONS.map(() => []);
  let runNum = 0;
  const total = CONDITIONS.length * CONFIGS.length;

  for (let ci = 0; ci < CONDITIONS.length; ci++) {
    const cond = CONDITIONS[ci];
    for (let ki = 0; ki < CONFIGS.length; ki++) {
      const cfg = CONFIGS[ki];
      runNum++;
      const elapsed = ((Date.now() - START_TS) / 60000).toFixed(1);
      await log(`[${runNum}/${total}] ${cond.label} × ${cfg.name} [${elapsed}min]`);

      const d = await runOne(cond, cfg);
      grid[ci][ki] = d;

      if (d) {
        await log(`  global=${fmt(d.globalMs)}ms  bcast=${fmt(d.bcastHops,3)}hops/${fmt(d.bcastMs)}ms`);
      } else {
        await log('  ERROR — no data');
      }
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────────

  await log('');
  await log('════════════════════════════════════════════════════════');
  await log('RESULTS SUMMARY');
  await log('════════════════════════════════════════════════════════');
  await log('');
  await log(`Condition    | baseline bcast | candidate bcast | Δ ms  | Δ hops | Verdict`);
  await log(`-------------|----------------|-----------------|-------|--------|--------`);

  const csvLines = ['condition,baseline_bcastMs,baseline_bcastHops,candidate_bcastMs,candidate_bcastHops,deltaBcastMs,deltaHops,verdict'];

  let passes = 0, wins = 0, fails = 0;

  for (let ci = 0; ci < CONDITIONS.length; ci++) {
    const cond = CONDITIONS[ci];
    const base = grid[ci][0];
    const cand = grid[ci][1];

    if (!base || !cand) {
      await log(`${cond.label.padEnd(13)}| ERROR`);
      continue;
    }

    const dMs   = cand.bcastMs   - base.bcastMs;
    const dHops = cand.bcastHops - base.bcastHops;
    const sign  = dMs > 0 ? '+' : '';

    let verdict;
    if (dMs < -10)      { verdict = 'WIN';  wins++; }
    else if (dMs > 20)  { verdict = 'FAIL'; fails++; }
    else                { verdict = 'PASS'; passes++; }

    const line = `${cond.label.padEnd(13)}| ${fmt(base.bcastMs).padStart(7)}ms/${fmt(base.bcastHops,3)}h | ${fmt(cand.bcastMs).padStart(7)}ms/${fmt(cand.bcastHops,3)}h | ${(sign+fmt(dMs)).padStart(5)}ms | ${(dHops>=0?'+':'')+fmt(dHops,3)} | ${verdict}`;
    await log(line);
    csvLines.push(`${cond.label},${fmt(base.bcastMs)},${fmt(base.bcastHops,3)},${fmt(cand.bcastMs)},${fmt(cand.bcastHops,3)},${fmt(dMs)},${fmt(dHops,3)},${verdict}`);
  }

  await log('');
  await log(`Totals: ${wins} WIN  ${passes} PASS  ${fails} FAIL  (of ${CONDITIONS.length} conditions)`);
  await log('');

  if (fails === 0 && wins > 0) {
    await log('OVERALL: CANDIDATE WINS ✓');
    await log('Set lateralMaxDepth=1, lateralK2=2 as new NX-2W default.');
  } else if (fails === 0) {
    await log('OVERALL: EQUIVALENT');
    await log('Candidate matches baseline — safe to adopt for simplicity.');
  } else {
    await log('OVERALL: MIXED — baseline holds for some conditions.');
  }

  writeFileSync(REPORT, csvLines.join('\n') + '\n');
  await log('');
  await log(`Results saved to: results/nx2w_lateral_validate.csv`);
  await log(`Total elapsed: ${((Date.now() - START_TS) / 60000).toFixed(1)} minutes`);
  await log('Done.');
}

main().catch(console.error);

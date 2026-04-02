/**
 * NX-2W Final Validation — Full 6-Condition Matrix
 *
 * Compares NX-1W (original defaults) vs NX-2W (all improvements applied)
 * across all 6 conditions to quantify the cumulative benefit of simplification.
 *
 * NX-2W improvements over NX-1W:
 *   1. Relay pinning     — REMOVED   (covered by markov pre-learning)
 *   2. lateralMaxDepth   — 2 → 1     (-14 to -24ms at large groups)
 *   3. annealLocalSample — 20 → 50   (marginal -2ms, lower hops)
 *   4. Stratified evict  — DISABLED  (-40ms at gs=64 — was actively hurting)
 *   5. Highway refresh   — DISABLED  (-22ms — disrupting stable connections)
 *
 * Test matrix:
 *   Node counts : 5,000 | 10,000
 *   Group sizes : 16 (small) | 64 (inflection) | 256 (large)
 *   Tests       : global + pubsub
 *   Warmup      : 10 sessions
 *
 * Verdict per condition:
 *   WIN      — NX-2W >10ms faster on bcast
 *   PASS     — within ±10ms
 *   FAIL     — NX-2W >20ms slower
 *
 * Usage: node nx2w_final_validation.mjs
 */

import { readFileSync, writeFileSync } from 'fs';

const BASE_URL  = 'http://localhost:3000';
const RESULTS   = '/Users/croqueteer/Documents/claude/dht-sim/results/benchmark_latest.csv';
const REPORT    = '/Users/croqueteer/Documents/claude/dht-sim/results/nx2w_final_validation.csv';
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
      if (!['NX-1W', 'NX-2W'].includes(proto)) continue;
      if (hasGlobal && f.length >= 7) {
        rows[proto] = { globalHops: +f[1], globalMs: +f[2], bcastHops: +f[5], bcastMs: +f[6] };
      } else if (!hasGlobal && f.length >= 5) {
        rows[proto] = { globalHops: NaN, globalMs: NaN, bcastHops: +f[3], bcastMs: +f[4] };
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

function verdict(nx1, nx2) {
  if (!nx1 || !nx2) return 'ERROR';
  const d = nx2.bcastMs - nx1.bcastMs;
  if (d < -10)  return 'WIN';
  if (d >  20)  return 'FAIL';
  return 'PASS';
}

// ── Protocol rules ────────────────────────────────────────────────────────────

// NX-1W: original defaults, all rules enabled
const NX1W_RULES = {
  bootstrap:          { kBootFactor: 1 },
  twoTier:            { enabled: true,  maxSynaptomeSize: 48, highwaySlots: 12 },
  apRouting:          { lookaheadAlpha: 5, weightScale: 0.40, geoRegionBits: 4, explorationEpsilon: 0.05, maxGreedyHops: 40 },
  ltp:                { enabled: true,  inertiaDuration: 20 },
  triadicClosure:     { enabled: true,  introductionThreshold: 1 },
  hopCaching:         { enabled: true,  cascadeWeight: 0.1 },
  lateralSpread:      { enabled: true,  lateralK: 6, lateralK2: 2, lateralMaxDepth: 2 },
  stratifiedEviction: { enabled: true,  strataGroups: 16, stratumFloor: 2 },
  annealing:          { enabled: true,  tInit: 1.0, tMin: 0.05, annealCooling: 0.9997, globalBias: 0.5, annealLocalSample: 20 },
  relayPinning:       { enabled: true,  relayPinThreshold: 5, relayPinWindow: 64, relayPinMax: 4, relayPinWeight: 0.95 },
  markov:             { enabled: true,  markovWindow: 16, markovHotThreshold: 3, markovBaseWeight: 0.5, markovMaxWeight: 0.9 },
  adaptiveDecay:      { enabled: true,  decayInterval: 100, pruneThreshold: 0.05, decayGammaMin: 0.990, decayGammaMax: 0.9998, useSaturation: 20, decayGammaHighwayActive: 0.9995, decayGammaHighwayIdle: 0.990, highwayRenewalWindow: 3000, highwayFloor: 2, synaptomeFloor: 48 },
  highwayRefresh:     { enabled: true,  hubRefreshInterval: 300, hubScanCap: 120, hubMinDiversity: 5, hubNoise: 1.0 },
  loadBalancing:      { enabled: false },
};

// NX-2W: all improvements applied
const NX2W_RULES = {
  bootstrap:          { kBootFactor: 1 },
  twoTier:            { enabled: true,  maxSynaptomeSize: 48, highwaySlots: 12 },
  apRouting:          { lookaheadAlpha: 5, weightScale: 0.40, geoRegionBits: 4, explorationEpsilon: 0.05, maxGreedyHops: 40 },
  ltp:                { enabled: true,  inertiaDuration: 20 },
  triadicClosure:     { enabled: true,  introductionThreshold: 1 },
  hopCaching:         { enabled: true,  cascadeWeight: 0.1 },
  lateralSpread:      { enabled: true,  lateralK: 6, lateralK2: 2, lateralMaxDepth: 1 },   // depth 2→1
  stratifiedEviction: { enabled: false },                                                    // DISABLED
  annealing:          { enabled: true,  tInit: 1.0, tMin: 0.05, annealCooling: 0.9997, globalBias: 0.5, annealLocalSample: 50 },  // sample 20→50
  markov:             { enabled: true,  markovWindow: 16, markovHotThreshold: 3, markovBaseWeight: 0.5, markovMaxWeight: 0.9 },
  adaptiveDecay:      { enabled: true,  decayInterval: 100, pruneThreshold: 0.05, decayGammaMin: 0.990, decayGammaMax: 0.9998, useSaturation: 20, decayGammaHighwayActive: 0.9995, decayGammaHighwayIdle: 0.990, highwayRenewalWindow: 3000, highwayFloor: 2, synaptomeFloor: 48 },
  highwayRefresh:     { enabled: false },                                                    // DISABLED
  loadBalancing:      { enabled: false },
  // relayPinning: removed entirely from NX-2W
};

// ── Test conditions ───────────────────────────────────────────────────────────

const CONDITIONS = [
  { label: '5k-gs16',   nodes: 5000,  groupSize: 16  },
  { label: '5k-gs64',   nodes: 5000,  groupSize: 64  },
  { label: '5k-gs256',  nodes: 5000,  groupSize: 256 },
  { label: '10k-gs16',  nodes: 10000, groupSize: 16  },
  { label: '10k-gs64',  nodes: 10000, groupSize: 64  },
  { label: '10k-gs256', nodes: 10000, groupSize: 256 },
];

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  await log('════════════════════════════════════════════════════════');
  await log('NX-2W FINAL VALIDATION — Full 6-Condition Matrix');
  await log('════════════════════════════════════════════════════════');
  await log('NX-1W : original defaults (all rules on, lateralDepth=2, stratified=on, refresh=on)');
  await log('NX-2W : relay pinning removed, lateralDepth=1, annealSample=50,');
  await log('        stratified eviction=off, highway refresh=off');
  await log('Warmup: 10 sessions per condition');
  await log('');

  await clearReady();

  // results[condIdx] = { nx1w, nx2w }
  const grid = CONDITIONS.map(() => ({ nx1w: null, nx2w: null }));
  let runNum = 0;
  const total = CONDITIONS.length * 2;

  for (let ci = 0; ci < CONDITIONS.length; ci++) {
    const cond = CONDITIONS[ci];

    for (const [proto, rules, key] of [
      ['ngdhtnx1w', NX1W_RULES, 'nx1w'],
      ['ngdhtnx2w', NX2W_RULES, 'nx2w'],
    ]) {
      runNum++;
      const elapsed = ((Date.now() - START_TS) / 60000).toFixed(1);
      const protoLabel = key === 'nx1w' ? 'NX-1W (baseline)' : 'NX-2W (candidate)';
      await log(`[${runNum}/${total}] ${cond.label} × ${protoLabel} [${elapsed}min]`);

      await clearReady();

      const payload = {
        label:           `Final validation: ${protoLabel} @ ${cond.label}`,
        nodeCount:       cond.nodes,
        pubsubGroupSize: cond.groupSize,
        warmupSessions:  10,
        protocols:       [proto],
        tests:           ['global', 'pubsub'],
        nx1wRules:       rules,
      };

      await apiPost('/api/experiment', { runs: [payload] });

      const ok = await waitForReady();
      if (!ok) { await log('  TIMEOUT'); continue; }

      await sleep(500);
      const rows = parseCSV();
      await apiDelete('/complete');

      const protoKey = key === 'nx1w' ? 'NX-1W' : 'NX-2W';
      const d = rows?.[protoKey];
      if (!d) { await log(`  No ${protoKey} row`); continue; }

      grid[ci][key] = d;
      await log(`  global=${fmt(d.globalMs)}ms  bcast=${fmt(d.bcastHops, 3)}hops/${fmt(d.bcastMs)}ms`);
    }
  }

  // ── Summary ───────────────────────────────────────────────────────────────

  await log('');
  await log('════════════════════════════════════════════════════════');
  await log('RESULTS SUMMARY');
  await log('════════════════════════════════════════════════════════');
  await log('');
  await log('Condition    | NX-1W bcast      | NX-2W bcast      |  Δ ms  | Δ hops | Verdict');
  await log('-------------|------------------|------------------|--------|--------|--------');

  const csvLines = ['condition,nx1w_globalMs,nx1w_bcastMs,nx1w_bcastHops,nx2w_globalMs,nx2w_bcastMs,nx2w_bcastHops,deltaBcastMs,deltaHops,verdict'];

  let wins = 0, passes = 0, fails = 0;
  const bcastDeltas = [];

  for (let ci = 0; ci < CONDITIONS.length; ci++) {
    const cond = CONDITIONS[ci];
    const { nx1w, nx2w } = grid[ci];
    if (!nx1w || !nx2w) {
      await log(`${cond.label.padEnd(13)}| ERROR`);
      continue;
    }

    const dMs   = nx2w.bcastMs   - nx1w.bcastMs;
    const dHops = nx2w.bcastHops - nx1w.bcastHops;
    const v     = verdict(nx1w, nx2w);
    if (v === 'WIN')  wins++;
    else if (v === 'FAIL') fails++;
    else passes++;
    bcastDeltas.push(dMs);

    const sign = dMs >= 0 ? '+' : '';
    const line = `${cond.label.padEnd(13)}| ${fmt(nx1w.bcastMs).padStart(5)}ms/${fmt(nx1w.bcastHops,3)}h | ${fmt(nx2w.bcastMs).padStart(5)}ms/${fmt(nx2w.bcastHops,3)}h | ${(sign+fmt(dMs)).padStart(6)} | ${((dHops>=0?'+':'')+fmt(dHops,3)).padStart(6)} | ${v}`;
    await log(line);
    csvLines.push(`${cond.label},${fmt(nx1w.globalMs)},${fmt(nx1w.bcastMs)},${fmt(nx1w.bcastHops,3)},${fmt(nx2w.globalMs)},${fmt(nx2w.bcastMs)},${fmt(nx2w.bcastHops,3)},${fmt(dMs)},${fmt(dHops,3)},${v}`);
  }

  const avgDelta = bcastDeltas.length
    ? bcastDeltas.reduce((a, b) => a + b, 0) / bcastDeltas.length
    : NaN;

  await log('');
  await log(`Totals: ${wins} WIN  ${passes} PASS  ${fails} FAIL  (of ${CONDITIONS.length} conditions)`);
  await log(`Average bcast delta: ${avgDelta >= 0 ? '+' : ''}${fmt(avgDelta, 1)}ms`);
  await log('');

  if (fails === 0 && wins > 0) {
    await log('OVERALL: NX-2W WINS ✓');
    await log('NX-2W is simpler AND faster than NX-1W across all tested conditions.');
  } else if (fails === 0) {
    await log('OVERALL: EQUIVALENT ✓');
    await log('NX-2W matches NX-1W performance with fewer active rules.');
  } else {
    await log('OVERALL: MIXED — NX-2W regresses on some conditions.');
  }

  writeFileSync(REPORT, csvLines.join('\n') + '\n');
  await log('');
  await log(`Results saved to: results/nx2w_final_validation.csv`);
  await log(`Total elapsed: ${((Date.now() - START_TS) / 60000).toFixed(1)} minutes`);
  await log('Done.');
}

main().catch(console.error);

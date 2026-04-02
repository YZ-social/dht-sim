/**
 * NX-2W Stratified Eviction Parameter Sweep
 *
 * Tests stratifiedEviction.enabled, strataGroups, and stratumFloor
 * within NX-2W to determine what this rule contributes and whether
 * it can be simplified or removed.
 *
 * Stratified eviction ensures the synaptome maintains coverage across
 * all XOR-distance strata by evicting from the most over-represented
 * group rather than simply the weakest connection overall.
 *
 * Fixed condition: 10k nodes, groupSize=64, warmup=10
 *
 * Grid:
 *   [0]  baseline       — enabled, groups=16, floor=2
 *   [1]  disabled       — enabled=false (simple weakest eviction)
 *   [2]  groups=4       — minimal grouping
 *   [3]  groups=8       — half default
 *   [4]  groups=32      — double default
 *   [5]  floor=1        — minimal protection per group
 *   [6]  floor=3        — more protection per group
 *   [7]  floor=4        — strong protection per group
 *   [8]  g=8,floor=1    — simplified: fewer groups, less protection
 *   [9]  g=8,floor=3    — fewer groups, more protection
 *
 * Usage: node nx2w_stratified_sweep.mjs
 */

import { readFileSync, writeFileSync } from 'fs';

const BASE_URL  = 'http://localhost:3000';
const RESULTS   = '/Users/croqueteer/Documents/claude/dht-sim/results/benchmark_latest.csv';
const REPORT    = '/Users/croqueteer/Documents/claude/dht-sim/results/nx2w_stratified_sweep.csv';
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
      if (proto !== 'NX-2W') continue;
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

function makeRules(stratOverride) {
  return {
    bootstrap:      { kBootFactor: 1 },
    twoTier:        { enabled: true, maxSynaptomeSize: 48, highwaySlots: 12 },
    apRouting:      { lookaheadAlpha: 5, weightScale: 0.40, geoRegionBits: 4, explorationEpsilon: 0.05, maxGreedyHops: 40 },
    ltp:            { enabled: true, inertiaDuration: 20 },
    triadicClosure: { enabled: true, introductionThreshold: 1 },
    hopCaching:     { enabled: true, cascadeWeight: 0.1 },
    lateralSpread:  { enabled: true, lateralK: 6, lateralK2: 2, lateralMaxDepth: 1 },
    stratifiedEviction: { enabled: true, strataGroups: 16, stratumFloor: 2, ...stratOverride },
    annealing:      { enabled: true, tInit: 1.0, tMin: 0.05, annealCooling: 0.9997, globalBias: 0.5, annealLocalSample: 50 },
    markov:         { enabled: true, markovWindow: 16, markovHotThreshold: 3, markovBaseWeight: 0.5, markovMaxWeight: 0.9 },
    adaptiveDecay:  { enabled: true, decayInterval: 100, pruneThreshold: 0.05, decayGammaMin: 0.990, decayGammaMax: 0.9998, useSaturation: 20, decayGammaHighwayActive: 0.9995, decayGammaHighwayIdle: 0.990, highwayRenewalWindow: 3000, highwayFloor: 2, synaptomeFloor: 48 },
    highwayRefresh: { enabled: true, hubRefreshInterval: 300, hubScanCap: 120, hubMinDiversity: 5, hubNoise: 1.0 },
    loadBalancing:  { enabled: false },
  };
}

// ── Sweep grid ────────────────────────────────────────────────────────────────

const GRID = [
  { label: 'baseline     (g=16,floor=2)', override: {} },
  { label: 'disabled     (enabled=false)', override: { enabled: false } },
  { label: 'groups=4     (g=4,floor=2)',   override: { strataGroups: 4  } },
  { label: 'groups=8     (g=8,floor=2)',   override: { strataGroups: 8  } },
  { label: 'groups=32    (g=32,floor=2)',  override: { strataGroups: 32 } },
  { label: 'floor=1      (g=16,floor=1)',  override: { stratumFloor: 1  } },
  { label: 'floor=3      (g=16,floor=3)',  override: { stratumFloor: 3  } },
  { label: 'floor=4      (g=16,floor=4)',  override: { stratumFloor: 4  } },
  { label: 'g=8,floor=1  (simplified)',    override: { strataGroups: 8, stratumFloor: 1 } },
  { label: 'g=8,floor=3  (g=8,floor=3)',   override: { strataGroups: 8, stratumFloor: 3 } },
];

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  await log('════════════════════════════════════════════════════════');
  await log('NX-2W STRATIFIED EVICTION PARAMETER SWEEP');
  await log('════════════════════════════════════════════════════════');
  await log('Protocol : NX-2W (relay pinning removed, lateralMaxDepth=1, annealLocalSample=50)');
  await log('Condition: 10k nodes, groupSize=64, warmup=10');
  await log(`Grid     : ${GRID.length} configurations`);
  await log('');

  await clearReady();

  const results = [];

  for (let i = 0; i < GRID.length; i++) {
    const { label, override } = GRID[i];
    const elapsed = ((Date.now() - START_TS) / 60000).toFixed(1);
    await log(`[${i + 1}/${GRID.length}] ${label} [${elapsed}min]`);

    const payload = {
      label:           `NX-2W stratified sweep: ${label}`,
      hypothesis:      `stratified config: ${JSON.stringify(override)}`,
      nodeCount:       10000,
      pubsubGroupSize: 64,
      warmupSessions:  10,
      protocols:       ['ngdhtnx2w'],
      tests:           ['global', 'pubsub'],
      nx1wRules:       makeRules(override),
    };

    await clearReady();
    await apiPost('/api/experiment', { runs: [payload] });
    await log('  Posted');

    const ok = await waitForReady();
    if (!ok) { await log('  TIMEOUT — skipping'); results.push({ label, data: null }); continue; }

    await sleep(500);
    const rows = parseCSV();
    await apiDelete('/complete');

    const d = rows?.['NX-2W'];
    if (!d) { await log('  No NX-2W row found'); results.push({ label, data: null }); continue; }

    await log(`  global=${fmt(d.globalMs)}ms  bcast=${fmt(d.bcastHops, 3)}hops/${fmt(d.bcastMs)}ms`);
    results.push({ label, data: d });
  }

  // ── Summary ───────────────────────────────────────────────────────────────

  await log('');
  await log('════════════════════════════════════════════════════════');
  await log('RESULTS SUMMARY');
  await log('════════════════════════════════════════════════════════');
  await log('');

  const baseline = results[0]?.data;
  await log('Config                        | global ms | bcast hops | bcast ms | Δ bcast ms');
  await log('------------------------------|-----------|------------|----------|------------');

  const csvLines = ['config,globalMs,bcastHops,bcastMs,deltaBcastMs'];

  for (const { label, data } of results) {
    if (!data) {
      await log(`${label.padEnd(30)}| ERROR`);
      continue;
    }
    const delta = baseline ? (data.bcastMs - baseline.bcastMs) : NaN;
    const sign  = delta > 0 ? '+' : '';
    const line  = `${label.padEnd(30)}| ${fmt(data.globalMs).padStart(9)} | ${fmt(data.bcastHops, 3).padStart(10)} | ${fmt(data.bcastMs).padStart(8)} | ${(sign + fmt(delta)).padStart(10)}ms`;
    await log(line);
    csvLines.push(`"${label}",${fmt(data.globalMs)},${fmt(data.bcastHops,3)},${fmt(data.bcastMs)},${fmt(delta)}`);
  }

  await log('');

  const valid    = results.filter(r => r.data);
  const best     = valid.reduce((a, b) => b.data.bcastMs < a.data.bcastMs ? b : a, valid[0]);
  const deltas   = valid.slice(1).map(r => Math.abs(r.data.bcastMs - baseline.bcastMs));
  const maxDelta = Math.max(...deltas);
  const avgDelta = deltas.reduce((a, b) => a + b, 0) / deltas.length;

  await log(`Best bcast ms : ${best?.label?.trim()} → ${fmt(best?.data?.bcastMs)}ms`);
  await log(`Max Δ vs baseline: ${fmt(maxDelta)}ms  |  Avg |Δ|: ${fmt(avgDelta, 1)}ms`);
  await log('');

  const disabledDelta = results[1]?.data ? results[1].data.bcastMs - baseline.bcastMs : NaN;

  if (maxDelta < 15) {
    await log('→ LOW sensitivity: stratified eviction parameters have minimal impact.');
    await log('  Safe to disable or simplify.');
  } else if (!isNaN(disabledDelta) && Math.abs(disabledDelta) < 10) {
    await log('→ REMOVABLE: disabled is within noise — stratified eviction adds no value.');
    await log('  Safe to remove; simple weakest-eviction is equivalent.');
  } else if (best.data.bcastMs < baseline.bcastMs - 10) {
    await log(`→ IMPROVEMENT FOUND: adopt "${best.label.trim()}" as new default.`);
  } else {
    await log('→ SENSITIVE: current defaults are well-tuned. Keep stratified eviction as-is.');
  }

  writeFileSync(REPORT, csvLines.join('\n') + '\n');
  await log('');
  await log(`Results saved to: results/nx2w_stratified_sweep.csv`);
  await log(`Total elapsed: ${((Date.now() - START_TS) / 60000).toFixed(1)} minutes`);
  await log('Done.');
}

main().catch(console.error);

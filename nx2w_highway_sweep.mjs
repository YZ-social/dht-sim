/**
 * NX-2W Two-Tier Highway Parameter Sweep
 *
 * Tests the two-tier highway (long-range connections to high-diversity hubs)
 * and highway refresh subsystem within NX-2W.
 *
 * The highway tier sits alongside the local synaptome (48 slots) and holds
 * up to 12 additional long-range connections selected by hub diversity score.
 * Highway refresh periodically scans neighbours-of-neighbours to find better
 * hubs, driven by hubRefreshInterval (every N lookups per node).
 *
 * Fixed condition: 10k nodes, groupSize=64, warmup=10
 *
 * Grid:
 *   [0]  baseline         — twoTier enabled, slots=12, refresh enabled, interval=300
 *   [1]  no-highway       — twoTier.enabled=false  (single-tier only)
 *   [2]  slots=4          — minimal highway
 *   [3]  slots=8          — half default
 *   [4]  slots=16         — larger highway
 *   [5]  slots=24         — double default
 *   [6]  no-refresh       — highwayRefresh.enabled=false (static highway from boot)
 *   [7]  fast-refresh     — hubRefreshInterval=100 (3x more frequent)
 *   [8]  slow-refresh     — hubRefreshInterval=600 (2x less frequent)
 *   [9]  synaptome=32     — smaller local tier, same highway
 *
 * Usage: node nx2w_highway_sweep.mjs
 */

import { readFileSync, writeFileSync } from 'fs';

const BASE_URL  = 'http://localhost:3000';
const RESULTS   = '/Users/croqueteer/Documents/claude/dht-sim/results/benchmark_latest.csv';
const REPORT    = '/Users/croqueteer/Documents/claude/dht-sim/results/nx2w_highway_sweep.csv';
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
        rows[proto] = { globalMs: +f[2], globalHops: +f[1], bcastHops: +f[5], bcastMs: +f[6] };
      } else if (!hasGlobal && f.length >= 5) {
        rows[proto] = { globalMs: NaN, globalHops: NaN, bcastHops: +f[3], bcastMs: +f[4] };
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

function makeRules({ twoTierOverride = {}, refreshOverride = {}, decayOverride = {} } = {}) {
  return {
    bootstrap:      { kBootFactor: 1 },
    twoTier:        { enabled: true, maxSynaptomeSize: 48, highwaySlots: 12, ...twoTierOverride },
    apRouting:      { lookaheadAlpha: 5, weightScale: 0.40, geoRegionBits: 4, explorationEpsilon: 0.05, maxGreedyHops: 40 },
    ltp:            { enabled: true, inertiaDuration: 20 },
    triadicClosure: { enabled: true, introductionThreshold: 1 },
    hopCaching:     { enabled: true, cascadeWeight: 0.1 },
    lateralSpread:  { enabled: true, lateralK: 6, lateralK2: 2, lateralMaxDepth: 1 },
    stratifiedEviction: { enabled: false },
    annealing:      { enabled: true, tInit: 1.0, tMin: 0.05, annealCooling: 0.9997, globalBias: 0.5, annealLocalSample: 50 },
    markov:         { enabled: true, markovWindow: 16, markovHotThreshold: 3, markovBaseWeight: 0.5, markovMaxWeight: 0.9 },
    adaptiveDecay:  { enabled: true, decayInterval: 100, pruneThreshold: 0.05, decayGammaMin: 0.990, decayGammaMax: 0.9998, useSaturation: 20, decayGammaHighwayActive: 0.9995, decayGammaHighwayIdle: 0.990, highwayRenewalWindow: 3000, highwayFloor: 2, synaptomeFloor: 48, ...decayOverride },
    highwayRefresh: { enabled: true, hubRefreshInterval: 300, hubScanCap: 120, hubMinDiversity: 5, hubNoise: 1.0, ...refreshOverride },
    loadBalancing:  { enabled: false },
  };
}

// ── Sweep grid ────────────────────────────────────────────────────────────────

const GRID = [
  {
    label:   'baseline       (slots=12, refresh=300)',
    options: {},
  },
  {
    label:   'no-highway     (twoTier disabled)',
    options: { twoTierOverride: { enabled: false } },
  },
  {
    label:   'slots=4        (minimal highway)',
    options: { twoTierOverride: { highwaySlots: 4 } },
  },
  {
    label:   'slots=8        (half default)',
    options: { twoTierOverride: { highwaySlots: 8 } },
  },
  {
    label:   'slots=16       (larger highway)',
    options: { twoTierOverride: { highwaySlots: 16 } },
  },
  {
    label:   'slots=24       (double default)',
    options: { twoTierOverride: { highwaySlots: 24 } },
  },
  {
    label:   'no-refresh     (static highway)',
    options: { refreshOverride: { enabled: false } },
  },
  {
    label:   'fast-refresh   (interval=100)',
    options: { refreshOverride: { hubRefreshInterval: 100 } },
  },
  {
    label:   'slow-refresh   (interval=600)',
    options: { refreshOverride: { hubRefreshInterval: 600 } },
  },
  {
    label:   'synaptome=32   (smaller local tier)',
    options: { twoTierOverride: { maxSynaptomeSize: 32 }, decayOverride: { synaptomeFloor: 32 } },
  },
];

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  await log('════════════════════════════════════════════════════════');
  await log('NX-2W TWO-TIER HIGHWAY PARAMETER SWEEP');
  await log('════════════════════════════════════════════════════════');
  await log('Protocol : NX-2W (stratified eviction off, lateralMaxDepth=1, annealLocalSample=50)');
  await log('Condition: 10k nodes, groupSize=64, warmup=10');
  await log(`Grid     : ${GRID.length} configurations`);
  await log('');

  await clearReady();

  const results = [];

  for (let i = 0; i < GRID.length; i++) {
    const { label, options } = GRID[i];
    const elapsed = ((Date.now() - START_TS) / 60000).toFixed(1);
    await log(`[${i + 1}/${GRID.length}] ${label} [${elapsed}min]`);

    const payload = {
      label:           `NX-2W highway sweep: ${label}`,
      hypothesis:      label,
      nodeCount:       10000,
      pubsubGroupSize: 64,
      warmupSessions:  10,
      protocols:       ['ngdhtnx2w'],
      tests:           ['global', 'pubsub'],
      nx1wRules:       makeRules(options),
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

    await log(`  global=${fmt(d.globalMs)}ms (${fmt(d.globalHops,2)}h)  bcast=${fmt(d.bcastHops, 3)}hops/${fmt(d.bcastMs)}ms`);
    results.push({ label, data: d });
  }

  // ── Summary ───────────────────────────────────────────────────────────────

  await log('');
  await log('════════════════════════════════════════════════════════');
  await log('RESULTS SUMMARY');
  await log('════════════════════════════════════════════════════════');
  await log('');

  const baseline = results[0]?.data;
  await log('Config                                | global ms | bcast hops | bcast ms | Δ bcast ms');
  await log('--------------------------------------|-----------|------------|----------|------------');

  const csvLines = ['config,globalMs,globalHops,bcastHops,bcastMs,deltaBcastMs'];

  for (const { label, data } of results) {
    if (!data) {
      await log(`${label.padEnd(38)}| ERROR`);
      continue;
    }
    const delta = baseline ? (data.bcastMs - baseline.bcastMs) : NaN;
    const sign  = delta > 0 ? '+' : '';
    const line  = `${label.padEnd(38)}| ${fmt(data.globalMs).padStart(9)} | ${fmt(data.bcastHops, 3).padStart(10)} | ${fmt(data.bcastMs).padStart(8)} | ${(sign + fmt(delta)).padStart(10)}ms`;
    await log(line);
    csvLines.push(`"${label}",${fmt(data.globalMs)},${fmt(data.globalHops,2)},${fmt(data.bcastHops,3)},${fmt(data.bcastMs)},${fmt(delta)}`);
  }

  await log('');

  const valid    = results.filter(r => r.data);
  const best     = valid.reduce((a, b) => b.data.bcastMs < a.data.bcastMs ? b : a, valid[0]);
  const noHighway = results[1]?.data;
  const deltas   = valid.slice(1).map(r => Math.abs(r.data.bcastMs - baseline.bcastMs));
  const maxDelta = Math.max(...deltas);
  const avgDelta = deltas.reduce((a, b) => a + b, 0) / deltas.length;

  await log(`Best bcast ms    : ${best?.label?.trim()} → ${fmt(best?.data?.bcastMs)}ms`);
  await log(`Max Δ vs baseline: ${fmt(maxDelta)}ms  |  Avg |Δ|: ${fmt(avgDelta, 1)}ms`);

  if (noHighway) {
    const nhDelta = noHighway.bcastMs - baseline.bcastMs;
    const sign = nhDelta >= 0 ? '+' : '';
    await log(`No-highway delta : ${sign}${fmt(nhDelta)}ms bcast  (${sign}${fmt(noHighway.globalMs - baseline.globalMs)}ms global)`);
  }

  await log('');

  const noHighwayDelta = noHighway ? Math.abs(noHighway.bcastMs - baseline.bcastMs) : Infinity;

  if (noHighwayDelta < 10) {
    await log('→ HIGHWAY REMOVABLE: disabling two-tier is within noise.');
    await log('  Single-tier with 48 synaptome slots is sufficient.');
  } else if (best.data.bcastMs < baseline.bcastMs - 10) {
    await log(`→ IMPROVEMENT: adopt "${best.label.trim()}" as new default.`);
  } else if (maxDelta < 15) {
    await log('→ LOW sensitivity: highway parameters are near-optimal. Keep as-is.');
  } else {
    await log('→ SENSITIVE: highway provides value. Keep enabled, review slot count.');
  }

  writeFileSync(REPORT, csvLines.join('\n') + '\n');
  await log('');
  await log(`Results saved to: results/nx2w_highway_sweep.csv`);
  await log(`Total elapsed: ${((Date.now() - START_TS) / 60000).toFixed(1)} minutes`);
  await log('Done.');
}

main().catch(console.error);

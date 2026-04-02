/**
 * NX-2W Simplification Test — Step 1 (revised): Relay Pinning Removed
 *
 * Compares NX-1W (baseline) vs NX-2W (relay pinning removed, triadic closure
 * restored) across multiple node counts and group sizes to validate that the
 * simplification does not degrade performance.
 *
 * Background: Step 1a (triadic closure removal) produced 6/6 FAIL with
 * average +104ms bcast delta. Triadic closure is the primary mechanism
 * creating direct publisher→subscriber shortcuts. Relay pinning is now
 * the candidate for removal — coordinate descent showed zero sensitivity
 * to all 4 relay pinning parameters.
 *
 * Test matrix:
 *   Node counts : 5,000 | 10,000
 *   Group sizes : 16 (small) | 64 (inflection) | 256 (large)
 *   Tests       : global + pubsub
 *   Warmup      : 10 sessions (consistent training)
 *   Total runs  : 6
 *
 * Verdict criteria (per condition):
 *   PASS     — NX-2W within 10ms of NX-1W on bcast ms AND global ms within 15ms
 *   MARGINAL — NX-2W 10–20ms worse on bcast ms
 *   FAIL     — NX-2W >20ms worse on bcast ms OR global hops clearly higher
 *
 * Usage: node nx2w_comparison.mjs
 */

import { readFileSync, writeFileSync } from 'fs';

const BASE_URL  = 'http://localhost:3000';
const RESULTS   = '/Users/croqueteer/Documents/claude/dht-sim/results/benchmark_latest.csv';
const REPORT    = '/Users/croqueteer/Documents/claude/dht-sim/results/nx2w_comparison.csv';
const POLL_MS   = 20_000;
const TIMEOUT_S = 360;
const START_TS  = Date.now();

// ── Helpers ──────────────────────────────────────────────────────────────────

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
      if (!['N-15W', 'NX-1W', 'NX-2W'].includes(proto)) continue;
      if (hasGlobal && f.length >= 7) {
        rows[proto] = { globalHops: +f[1], globalMs: +f[2], relayHops: +f[3], relayMs: +f[4], bcastHops: +f[5], bcastMs: +f[6] };
      } else if (!hasGlobal && f.length >= 5) {
        rows[proto] = { globalHops: NaN, globalMs: NaN, relayHops: +f[1], relayMs: +f[2], bcastHops: +f[3], bcastMs: +f[4] };
      }
    }
    return rows;
  } catch (e) {
    console.error('CSV parse error:', e.message);
    return null;
  }
}

function verdict(nx1, nx2) {
  if (!nx1 || !nx2) return 'ERROR';
  const bcastDelta  = nx2.bcastMs  - nx1.bcastMs;
  const globalDelta = nx2.globalMs - nx1.globalMs;
  const hopsDelta   = nx2.bcastHops - nx1.bcastHops;
  if (bcastDelta > 20 || hopsDelta > 0.3) return 'FAIL';
  if (bcastDelta > 10) return 'MARGINAL';
  return 'PASS';
}

function fmt(v, decimals = 0) {
  return isNaN(v) ? '  —  ' : v.toFixed(decimals);
}

// ── NX-1W optimised rules (markovWindow=16, all other defaults) ───────────────

const NX1W_RULES = {
  bootstrap:     { kBootFactor: 1 },
  twoTier:       { enabled: true, maxSynaptomeSize: 48, highwaySlots: 12 },
  apRouting:     { lookaheadAlpha: 5, weightScale: 0.40, geoRegionBits: 4, explorationEpsilon: 0.05, maxGreedyHops: 40 },
  ltp:           { enabled: true, inertiaDuration: 20 },
  triadicClosure:{ enabled: true, introductionThreshold: 1 },
  hopCaching:    { enabled: true, cascadeWeight: 0.1 },
  lateralSpread: { enabled: true, lateralK: 6, lateralK2: 2, lateralMaxDepth: 2 },
  stratified:    { enabled: true, strataGroups: 16, stratumFloor: 2 },
  annealing:     { enabled: true, tInit: 1.0, tMin: 0.05, annealCooling: 0.9997, globalBias: 0.5 },
  relayPinning:  { enabled: true, relayPinThreshold: 5, relayPinWindow: 64, relayPinMax: 4, relayPinWeight: 0.95 },
  markov:        { enabled: true, markovWindow: 16, markovHotThreshold: 3, markovBaseWeight: 0.5, markovMaxWeight: 0.9 },
  adaptiveDecay: { enabled: true, decayInterval: 100, pruneThreshold: 0.05, decayGammaMin: 0.990, decayGammaMax: 0.9998, useSaturation: 20, decayGammaHighwayActive: 0.9995, decayGammaHighwayIdle: 0.990, highwayRenewalWindow: 3000, highwayFloor: 2, synaptomeFloor: 48 },
  highwayRefresh:{ enabled: true, hubRefreshInterval: 300, hubScanCap: 120, hubMinDiversity: 5, hubNoise: 1.0 },
  loadBalancing: { enabled: false },
};

// ── Test conditions ───────────────────────────────────────────────────────────

const CONDITIONS = [
  { nodeCount: 5000,  groupSize: 16,  label: '5k-gs16  (small group, small net)' },
  { nodeCount: 5000,  groupSize: 64,  label: '5k-gs64  (inflection point, small net)' },
  { nodeCount: 5000,  groupSize: 256, label: '5k-gs256 (large group, small net)' },
  { nodeCount: 10000, groupSize: 16,  label: '10k-gs16  (small group, large net)' },
  { nodeCount: 10000, groupSize: 64,  label: '10k-gs64  (inflection point, large net)' },
  { nodeCount: 10000, groupSize: 256, label: '10k-gs256 (large group, large net)' },
];

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  await log('');
  await log('════════════════════════════════════════════════════════');
  await log('NX-2W SIMPLIFICATION TEST — Step 1 (revised): Relay Pinning Removed');
  await log('════════════════════════════════════════════════════════');
  await log('Hypothesis: Relay pinning is redundant with markov pre-learning.');
  await log('           Removing it will not degrade performance.');
  await log('Conditions: 6 (2 node counts × 3 group sizes)');
  await log('Protocols : NX-1W (baseline) vs NX-2W (relay pinning removed)');
  await log('Verdict   : PASS if NX-2W within 10ms bcast on all conditions');
  await log('');

  // CSV header
  writeFileSync(REPORT,
    'Condition,Nodes,GroupSize,' +
    'NX1W_GlobalMs,NX1W_BcastHops,NX1W_BcastMs,' +
    'NX2W_GlobalMs,NX2W_BcastHops,NX2W_BcastMs,' +
    'BcastDelta_ms,GlobalDelta_ms,HopsDelta,Verdict\n'
  );

  const results = [];

  for (let i = 0; i < CONDITIONS.length; i++) {
    const cond = CONDITIONS[i];
    const elapsed = ((Date.now() - START_TS) / 60000).toFixed(1);
    console.log(`\n[${i + 1}/${CONDITIONS.length}] ${cond.label} [${elapsed}min]`);

    await clearReady();

    await apiPost('/api/experiment', {
      label: `NX2W-step1: ${cond.label}`,
      hypothesis: 'Triadic closure removal — comparing NX-1W vs NX-2W',
      runs: [{
        nodeCount:       cond.nodeCount,
        pubsubCoverage:  10,
        pubsubGroupSize: cond.groupSize,
        warmupSessions:  10,
        protocols:       ['ngdhtnx1w', 'ngdhtnx2w'],
        tests:           ['global', 'pubsub'],
        nx1wRules:       NX1W_RULES,
      }],
    });

    console.log(`  Posted`);
    const ready = await waitForReady();

    if (!ready) {
      await log(`  TIMEOUT on ${cond.label}`);
      await apiDelete('/complete');
      continue;
    }

    const rows = parseCSV();
    await apiDelete('/complete');

    if (!rows) {
      await log(`  PARSE FAILED on ${cond.label}`);
      continue;
    }

    const nx1 = rows['NX-1W'];
    const nx2 = rows['NX-2W'];
    const v   = verdict(nx1, nx2);

    if (nx1 && nx2) {
      const bcastDelta  = nx2.bcastMs  - nx1.bcastMs;
      const globalDelta = nx2.globalMs - nx1.globalMs;
      const hopsDelta   = nx2.bcastHops - nx1.bcastHops;

      results.push({ cond, nx1, nx2, bcastDelta, globalDelta, hopsDelta, v });

      const sign = bcastDelta >= 0 ? '+' : '';
      await log(`  NX-1W: global=${fmt(nx1.globalMs)}ms  bcast=${fmt(nx1.bcastHops,3)}hops/${fmt(nx1.bcastMs)}ms`);
      await log(`  NX-2W: global=${fmt(nx2.globalMs)}ms  bcast=${fmt(nx2.bcastHops,3)}hops/${fmt(nx2.bcastMs)}ms`);
      await log(`  Delta: bcast=${sign}${fmt(bcastDelta)}ms  global=${sign}${fmt(globalDelta)}ms  hops=${sign}${fmt(hopsDelta,3)}  → ${v}`);

      // Append to CSV
      const { appendFileSync } = await import('fs');
      appendFileSync(REPORT,
        `"${cond.label}",${cond.nodeCount},${cond.groupSize},` +
        `${fmt(nx1.globalMs)},${fmt(nx1.bcastHops,3)},${fmt(nx1.bcastMs)},` +
        `${fmt(nx2.globalMs)},${fmt(nx2.bcastHops,3)},${fmt(nx2.bcastMs)},` +
        `${fmt(bcastDelta)},${fmt(globalDelta)},${fmt(hopsDelta,3)},${v}\n`
      );
    } else {
      await log(`  Missing rows: NX-1W=${!!nx1} NX-2W=${!!nx2}`);
    }
  }

  // ── Final verdict ────────────────────────────────────────────────────────

  await log('');
  await log('════════════════════════════════════════════════════════');
  await log('RESULTS SUMMARY');
  await log('════════════════════════════════════════════════════════');
  await log('');
  await log('Condition              | NX-1W bcast | NX-2W bcast | Delta  | Verdict');
  await log('-----------------------|-------------|-------------|--------|--------');

  for (const r of results) {
    const sign = r.bcastDelta >= 0 ? '+' : '';
    await log(
      r.cond.label.padEnd(23) + '| ' +
      `${fmt(r.nx1.bcastMs)}ms`.padStart(11) + ' | ' +
      `${fmt(r.nx2.bcastMs)}ms`.padStart(11) + ' | ' +
      `${sign}${fmt(r.bcastDelta)}ms`.padStart(6) + ' | ' +
      r.v
    );
  }

  const passes   = results.filter(r => r.v === 'PASS').length;
  const marginal = results.filter(r => r.v === 'MARGINAL').length;
  const fails    = results.filter(r => r.v === 'FAIL').length;

  await log('');
  await log(`Totals: ${passes} PASS  ${marginal} MARGINAL  ${fails} FAIL  (of ${results.length} conditions)`);
  await log('');

  const avgBcastDelta = results.reduce((s, r) => s + r.bcastDelta, 0) / results.length;
  const avgHopsDelta  = results.reduce((s, r) => s + r.hopsDelta, 0)  / results.length;
  await log(`Average bcast delta : ${avgBcastDelta >= 0 ? '+' : ''}${avgBcastDelta.toFixed(1)}ms`);
  await log(`Average hops delta  : ${avgHopsDelta  >= 0 ? '+' : ''}${avgHopsDelta.toFixed(3)}`);
  await log('');

  if (fails === 0 && marginal === 0) {
    await log('OVERALL: PASS ✓');
    await log('Relay pinning is redundant with markov pre-learning at all tested conditions.');
    await log('Proceed to Step 2: Reduce lateral spread to depth=1.');
  } else if (fails === 0 && marginal > 0) {
    await log('OVERALL: MARGINAL');
    await log('NX-2W is slightly worse on some conditions — investigate which group');
    await log('sizes or node counts show the most degradation before proceeding.');
  } else {
    await log('OVERALL: FAIL');
    await log('Relay pinning provides measurable value not covered by markov pre-learning.');
    await log('Do NOT proceed to Step 2 — restore relay pinning in NX-2W.');
  }

  await log('');
  await log(`Results saved to: results/nx2w_comparison.csv`);
  await log(`Total elapsed: ${((Date.now() - START_TS) / 60000).toFixed(1)} minutes`);
  console.log('\nDone.');
}

main().catch(async e => {
  console.error('Fatal:', e);
  await log(`FATAL: ${e.message}`).catch(() => {});
  process.exit(1);
});

/**
 * Phase 1 — Pub/Sub Scaling Baseline Sweep
 *
 * Tests N-15W and NX-1W across 8 group sizes to establish
 * how bcast ms scales with subscriber count under flat delivery.
 *
 * Usage: node scaling_phase1.mjs
 */

import { readFileSync, writeFileSync, appendFileSync } from 'fs';

const BASE_URL      = 'http://localhost:3000';
const RESULTS       = '/Users/croqueteer/Documents/claude/dht-sim/results/benchmark_latest.csv';
const REPORT        = '/Users/croqueteer/Documents/claude/dht-sim/results/scaling_phase1.csv';
const POLL_MS       = 20_000;
const TIMEOUT_S     = 360;   // larger groups take longer
const START_TS      = Date.now();

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
  try { await apiPost('/api/log', { entry }); } catch {}
}

async function waitForReady() {
  const deadline = Date.now() + TIMEOUT_S * 1000;
  while (Date.now() < deadline) {
    try {
      const s = await apiGet('/api/status');
      if (s.ready) return true;
    } catch {}
    await sleep(POLL_MS);
  }
  return false;
}

async function clearReady() {
  try {
    const s = await apiGet('/api/status');
    if (s.ready) { await apiDelete('/complete'); console.log('  [cleared stale flag]'); }
  } catch {}
}

function parseCSV() {
  try {
    const csv   = readFileSync(RESULTS, 'utf8');
    const lines = csv.split('\n');
    const rows  = {};

    // Detect column layout from header line
    const header = lines.find(l => l.startsWith('Protocol,'));
    const hasglobal = header && header.includes('global');

    for (const line of lines) {
      const f = line.trim().replace(/\r/,'').split(',');
      if (f.length < 5) continue;
      const proto = f[0].trim();
      if (!['N-15W','NX-1W','NX-2W','Kademlia','G-DHT-8','G-DHT-16'].includes(proto)) continue;
      if (hasglobal && f.length >= 7) {
        rows[proto] = {
          globalHops: parseFloat(f[1]),
          globalMs:   parseFloat(f[2]),
          relayHops:  parseFloat(f[3]),
          relayMs:    parseFloat(f[4]),
          bcastHops:  parseFloat(f[5]),
          bcastMs:    parseFloat(f[6]),
        };
      } else if (!hasglobal && f.length >= 5) {
        rows[proto] = {
          globalHops: NaN,
          globalMs:   NaN,
          relayHops:  parseFloat(f[1]),
          relayMs:    parseFloat(f[2]),
          bcastHops:  parseFloat(f[3]),
          bcastMs:    parseFloat(f[4]),
        };
      }
    }
    return rows;
  } catch (e) {
    console.error('CSV parse error:', e.message);
    return null;
  }
}

// ── Sweep definition ─────────────────────────────────────────────────────────

const GROUP_SIZES  = [16, 32, 64, 128, 256, 512, 1024, 2048];
const PROTOCOLS    = ['ngdht15w', 'ngdhtnx1w'];
const NODE_COUNT   = 10000;
const COVERAGE_PCT = 10;
const WARMUP       = 10;

// NX-1W best params from coord descent
const NX1W_RULES = {
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

// ── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  await log('');
  await log('=== PHASE 1 SCALING SWEEP START ===');
  await log(`Protocols: N-15W, NX-1W | Nodes: ${NODE_COUNT} | Coverage: ${COVERAGE_PCT}% | Warmup: ${WARMUP} sessions`);
  await log(`Group sizes: ${GROUP_SIZES.join(', ')}`);
  await log(`Total runs: ${GROUP_SIZES.length} (both protocols per run)`);

  // Write CSV header
  writeFileSync(REPORT,
    'GroupSize,Nodes,Protocol,RelayHops,RelayMs,BcastHops,BcastMs,BcastMsPerSubscriber\n'
  );

  const allResults = [];
  let runNum = 0;

  for (const groupSize of GROUP_SIZES) {
    runNum++;
    const elapsed = ((Date.now() - START_TS) / 60000).toFixed(1);
    console.log(`\n[Run ${runNum}/${GROUP_SIZES.length}] groupSize=${groupSize} [${elapsed}min elapsed]`);

    await clearReady();

    // Both protocols in one benchmark run
    await apiPost('/api/experiment', {
      label: `Phase1-groupSize=${groupSize}`,
      hypothesis: `Scaling baseline: how does bcast ms grow with ${groupSize} subscribers?`,
      runs: [{
        nodeCount:      NODE_COUNT,
        pubsubCoverage: COVERAGE_PCT,
        pubsubGroupSize: groupSize,
        warmupSessions: WARMUP,
        protocols:      PROTOCOLS,
        tests:          ['pubsub', 'global'],
        nx1wRules:      NX1W_RULES,
      }],
    });

    console.log(`  Posted groupSize=${groupSize}`);
    const ready = await waitForReady();

    if (!ready) {
      await log(`  TIMEOUT on groupSize=${groupSize} — skipping`);
      await apiDelete('/complete');
      continue;
    }

    const rows = parseCSV();
    await apiDelete('/complete');

    if (!rows) {
      await log(`  PARSE FAILED on groupSize=${groupSize}`);
      continue;
    }

    // Collect results for both protocols
    for (const [key, label] of [['N-15W','N-15W'], ['NX-1W','NX-1W']]) {
      const r = rows[key];
      if (!r) {
        await log(`  No row for ${key} at groupSize=${groupSize}`);
        continue;
      }
      const msPerSub = (r.bcastMs / groupSize).toFixed(4);
      allResults.push({ groupSize, label, ...r, msPerSub: parseFloat(msPerSub) });

      // Append to CSV
      appendFileSync(REPORT,
        `${groupSize},${NODE_COUNT},${label},${r.relayHops},${r.relayMs},${r.bcastHops},${r.bcastMs},${msPerSub}\n`
      );

      await log(`  ${label} gs=${groupSize}: relay=${r.relayMs}ms bcast=${r.bcastMs}ms (${msPerSub}ms/sub) hops=${r.bcastHops}`);
    }
  }

  // ── Summary table ──────────────────────────────────────────────────────────

  await log('');
  await log('=== PHASE 1 COMPLETE ===');
  await log('');
  await log('GroupSize | N-15W bcast ms | NX-1W bcast ms | N-15W ms/sub | NX-1W ms/sub | N-15W hops | NX-1W hops');
  await log('----------|----------------|----------------|--------------|--------------|------------|----------');

  for (const gs of GROUP_SIZES) {
    const n15 = allResults.find(r => r.groupSize === gs && r.label === 'N-15W');
    const nx1 = allResults.find(r => r.groupSize === gs && r.label === 'NX-1W');
    if (n15 && nx1) {
      await log(
        String(gs).padStart(9) + ' | ' +
        String(n15.bcastMs).padStart(14) + ' | ' +
        String(nx1.bcastMs).padStart(14) + ' | ' +
        String(n15.msPerSub.toFixed(3)).padStart(12) + ' | ' +
        String(nx1.msPerSub.toFixed(3)).padStart(12) + ' | ' +
        String(n15.bcastHops.toFixed(3)).padStart(10) + ' | ' +
        String(nx1.bcastHops.toFixed(3)).padStart(10)
      );
    }
  }

  // Scaling analysis
  await log('');
  await log('Scaling analysis (bcast ms growth):');
  const n15_16  = allResults.find(r => r.groupSize === 16   && r.label === 'N-15W');
  const n15_256 = allResults.find(r => r.groupSize === 256  && r.label === 'N-15W');
  const n15_2048= allResults.find(r => r.groupSize === 2048 && r.label === 'N-15W');
  if (n15_16 && n15_256 && n15_2048) {
    const slope_low  = (n15_256.bcastMs  - n15_16.bcastMs)  / (256  - 16);
    const slope_high = (n15_2048.bcastMs - n15_256.bcastMs) / (2048 - 256);
    await log(`  N-15W: 16→256 subs: +${(n15_256.bcastMs - n15_16.bcastMs).toFixed(0)}ms | slope: ${slope_low.toFixed(3)}ms/sub`);
    await log(`  N-15W: 256→2048 subs: +${(n15_2048.bcastMs - n15_256.bcastMs).toFixed(0)}ms | slope: ${slope_high.toFixed(3)}ms/sub`);
    await log(`  Scaling behaviour: ${Math.abs(slope_high / slope_low) > 1.5 ? 'SUPER-LINEAR (accelerating)' : Math.abs(slope_high / slope_low) < 0.7 ? 'SUB-LINEAR (improving)' : 'LINEAR (constant per-sub cost)'}`);
  }

  await log('');
  await log(`Results saved to: results/scaling_phase1.csv`);
  await log(`Total elapsed: ${((Date.now() - START_TS) / 60000).toFixed(1)} minutes`);
  console.log('\nDone.');
}

main().catch(async e => {
  console.error('Fatal:', e);
  await log(`FATAL: ${e.message}`).catch(() => {});
  process.exit(1);
});

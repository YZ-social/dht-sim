/**
 * main.js – application bootstrap and event wiring.
 *
 * Responsibilities:
 *   - Load world GeoJSON and initialise the 3D globe.
 *   - Respond to UI button clicks (Init / Lookup Test / Churn Test / Stop).
 *   - Instantiate the correct DHT protocol and run simulations.
 *   - Push results to the Results panel and path visualisations to the globe.
 */

import { Globe }              from './globe/Globe.js';
import { KademliaDHT }        from './dht/kademlia/KademliaDHT.js';
import { GeographicDHT }      from './dht/geographic/GeographicDHT.js';
import { NeuromorphicDHT }    from './dht/neuromorphic/NeuromorphicDHT.js';
import { NeuromorphicDHT2 }   from './dht/neuromorphic/NeuromorphicDHT2.js';
import { NeuromorphicDHT2BP }  from './dht/neuromorphic/NeuromorphicDHT2BP.js';
import { NeuromorphicDHT2SHC } from './dht/neuromorphic/NeuromorphicDHT2SHC.js';
import { NeuromorphicDHT3 }    from './dht/neuromorphic/NeuromorphicDHT3.js';
import { NeuromorphicDHT4 }    from './dht/neuromorphic/NeuromorphicDHT4.js';
import { NeuromorphicDHT5 }    from './dht/neuromorphic/NeuromorphicDHT5.js';
import { SimulationEngine }   from './simulation/Engine.js';
import { Controls }           from './ui/Controls.js';
import { Results }            from './ui/Results.js';
import { setLatencyParams,
         getLatencyParams,
         haversine }          from './utils/geo.js';

// ─────────────────────────────────────────────────────────────────────────────
// Module-level state
// ─────────────────────────────────────────────────────────────────────────────

let globe    = null;
let dht      = null;
let engine   = null;

// Expose for browser console debugging
window.__sim = { get globe() { return globe; }, get dht() { return dht; } };
const controls = new Controls();
const results  = new Results('resultsOverlay');

// ─────────────────────────────────────────────────────────────────────────────
// Startup
// ─────────────────────────────────────────────────────────────────────────────

async function init() {
  controls.setStatus('Loading world map…', 'info');

  // Initialise Three.js globe
  const canvas = document.getElementById('globeCanvas');
  globe = new Globe(canvas);

  // Load countries (TopoJSON via CDN, converted to GeoJSON by topojson-client)
  try {
    const topoData = await fetch(
      'https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/countries-110m.json'
    ).then(r => r.json());

    // topojson-client is loaded as a global <script> tag
    const geoJSON = topojson.feature(topoData, topoData.objects.countries);
    await globe.loadCountries(geoJSON);
    controls.setStatus('Ready – configure parameters and click Init Network.', 'info');
  } catch (err) {
    console.error('Failed to load world map:', err);
    controls.setStatus('Map load failed; node placement will be random.', 'warn');
  }

  engine = new SimulationEngine();

  // Wire buttons
  document.getElementById('btnInit')?.addEventListener('click', onInit);
  document.getElementById('btnLookupTest')?.addEventListener('click', onLookupTest);
  document.getElementById('btnChurnTest')?.addEventListener('click', onChurnTest);
  document.getElementById('btnDemoLookup')?.addEventListener('click', onDemoLookup);
  document.getElementById('btnTrainNetwork')?.addEventListener('click', onTrainNetwork);
  document.getElementById('btnConcordance')?.addEventListener('click', onConcordance);
  document.getElementById('btnPairLearning')?.addEventListener('click', onPairLearning);
  document.getElementById('btnBenchmark')?.addEventListener('click', onBenchmark);

  // Auto-rotate toggle
  document.getElementById('autoRotate')?.addEventListener('change', e => {
    globe?.setAutoRotate(e.target.checked);
  });

  // Node click → show routing table connections
  canvas.addEventListener('nodeclicked', (e) => {
    const { nodeId } = e.detail;
    if (nodeId === null || !dht) {
      globe.clearConnections();
      controls.setStatus('Selection cleared.', 'info');
      return;
    }
    // Get routing table entries from the clicked node
    const node = dht.nodeMap?.get(nodeId);
    if (!node || typeof node.getRoutingTableEntries !== 'function') return;

    const entries = node.getRoutingTableEntries();
    const nodeMap = new Map(dht.getNodes().map(n => [n.id, n]));
    globe.clearArcs();
    globe.showNodeConnections(nodeId, nodeMap, entries.map(n => n.id));

    const hex = nodeId.toString(16).padStart(16, '0').toUpperCase();
    controls.setStatus(
      `Node 0x${hex} — ${entries.length} routing-table contacts. Click elsewhere to deselect.`,
      'info'
    );
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Network Initialisation
// ─────────────────────────────────────────────────────────────────────────────

async function onInit() {
  trainingActive = false;
  controls.setTraining(false);
  concordanceActive = false;
  controls.setConcordance(false);
  pairActive = false;
  controls.setPairLearning(false);
  controls.setRunning(true);
  controls.setProgress(0);
  results.clear();
  results.clearTraining();
  results.clearConcordance();
  results.clearPairLearning();
  globe.clearArcs();
  globe.clearConnections();
  globe.clearRegionalBoundary();

  const params = controls.snapshot();
  controls.setStatus(`Building ${params.nodeCount}-node ${params.protocol} network…`, 'info');

  // Apply latency parameters before building the network
  const { maxPropagation } = getLatencyParams();
  setLatencyParams(maxPropagation, params.nodeDelay);

  // Instantiate the selected DHT protocol
  dht = createDHT(params);

  // Generate nodes on land
  const nodes = [];
  for (let i = 0; i < params.nodeCount; i++) {
    const { lat, lng } = globe.randomLandPoint();
    const node = await dht.addNode(lat, lng);
    nodes.push(node);

    if ((i + 1) % 50 === 0) {
      controls.setProgress((i + 1) / params.nodeCount * 0.7);
      await yieldUI();
    }
  }

  controls.setStatus('Building routing tables…', 'info');
  controls.setProgress(0.8);
  await yieldUI();

  dht.buildRoutingTables();

  controls.setProgress(1);
  globe.setNodes(dht.getNodes());
  controls.setStatus(
    `Network ready: ${nodes.length} nodes, ${params.protocol} ` +
    `(k=${params.k}, α=${params.alpha}, ${params.bits}-bit IDs)`,
    'success'
  );
  controls.setRunning(false);
  controls.setProgress(0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Lookup Test
// ─────────────────────────────────────────────────────────────────────────────

async function onLookupTest() {
  if (!dht) {
    controls.setStatus('Initialise the network first.', 'warn');
    return;
  }
  controls.setRunning(true);
  controls.setProgress(0);
  globe.clearArcs();
  globe.clearConnections();
  globe.clearRegionalBoundary();

  const params = controls.snapshot();
  controls.setStatus(`Running ${params.msgCount} random lookups…`, 'info');

  // Draw regional boundary ring so the user can see the constraint is active
  if (params.regional) {
    const nodes = dht.getNodes().filter(n => n.alive);
    if (nodes.length) {
      const src = nodes[Math.floor(Math.random() * nodes.length)];
      globe.drawRegionalBoundary(src.lat, src.lng, params.regionalRadius);
    }
  }

  engine.onProgress = (frac, partial) => {
    controls.setProgress(frac);
    if (partial?.hops?.mean != null) {
      controls.setStatus(
        `Progress ${(frac * 100).toFixed(0)}% — ` +
        `avg hops: ${partial.hops.mean.toFixed(2)}, ` +
        `avg time: ${partial.time.mean.toFixed(1)} ms`,
        'info'
      );
    }
  };

  engine.onPathFound = (path, d) => {
    const nodeMap = new Map(d.getNodes().map(n => [n.id, n]));
    globe.showPath(path, nodeMap);
  };

  const result = await engine.runLookupTest(dht, {
    numMessages:    params.msgCount,
    captureLastPath: true,
    regional:       params.regional,
    regionalRadius: params.regionalRadius,
    hotPct:         params.hotPct,
    sourcePct:      params.sourceMode ? params.sourcePct : 0,
    destPct:        params.destMode   ? params.destPct   : 0,
  });

  results.showLookupResults(result);
  controls.setStatus(
    `Done. Avg hops: ${result.hops?.mean.toFixed(2)}, ` +
    `avg time: ${result.time?.mean.toFixed(1)} ms, ` +
    `success: ${(result.successRate * 100).toFixed(1)}%`,
    'success'
  );
  controls.setRunning(false);
  controls.setProgress(0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Demo (single animated lookup)
// ─────────────────────────────────────────────────────────────────────────────

async function onDemoLookup() {
  if (!dht) {
    controls.setStatus('Initialise the network first.', 'warn');
    return;
  }
  controls.setRunning(true);
  globe.clearArcs();
  globe.clearConnections();
  globe.clearRegionalBoundary();  // remove any ring from the previous demo

  const nodes = dht.getNodes().filter(n => n.alive);
  if (nodes.length < 2) {
    controls.setStatus('Not enough nodes for a demo lookup.', 'warn');
    controls.setRunning(false);
    return;
  }
  const params = controls.snapshot();

  // ── Select sender (and build nearby list for regional mode) ───────────────
  // In regional mode, only consider senders that already have at least one
  // other live node within the radius — this guarantees nearby is never empty
  // and eliminates all "no nodes within X km" failures.
  let source, nearby = [];
  if (params.regional) {
    const eligible = nodes.filter(n =>
      nodes.some(m => m.id !== n.id &&
        haversine(n.lat, n.lng, m.lat, m.lng) <= params.regionalRadius)
    );
    if (!eligible.length) {
      controls.setStatus(
        `No node pairs within ${params.regionalRadius} km — try a larger radius or more nodes.`, 'warn'
      );
      controls.setRunning(false);
      return;
    }
    source = eligible[Math.floor(Math.random() * eligible.length)];
    nearby = nodes.filter(n =>
      n.id !== source.id &&
      haversine(source.lat, source.lng, n.lat, n.lng) <= params.regionalRadius
    );
    // Draw the ring now so it's visible while the lookup runs
    globe.drawRegionalBoundary(source.lat, source.lng, params.regionalRadius);
  } else {
    source = nodes[Math.floor(Math.random() * nodes.length)];
  }

  controls.setStatus(
    `Demo lookup from node 0x${source.id.toString(16).padStart(16,'0').toUpperCase().slice(0,8)}…` +
    `${params.regional ? ` (regional ≤${params.regionalRadius} km)` : ''}…`,
    'info'
  );

  // ── Choose target and run lookup ───────────────────────────────────────────
  const nodeMap = new Map(dht.getNodes().map(n => [n.id, n]));
  let result = null;

  if (params.regional) {
    // Pick a random node within the ring as the receiver and route to its
    // actual node ID using each protocol's native XOR routing.
    //   – Geographic DHT: IDs are geo-prefixed, so the XOR path is naturally
    //     geographic and tends to stay within the region.
    //   – Kademlia: IDs are random, so the XOR path wanders geographically
    //     even though it converges to the correct receiver ID.
    // This is the honest comparison: no geographic routing assist for Kademlia.
    const receiver = nearby[Math.floor(Math.random() * nearby.length)];
    result = await dht.lookup(source.id, receiver.id);
  } else {
    const { randomU64 } = await import('./utils/geo.js');
    result = await dht.lookup(source.id, randomU64());
  }

  // Sanity-check: destination should be within the regional ring.
  if (params.regional && result?.path?.length > 1) {
    const destNode = nodeMap.get(result.path.at(-1));
    if (!destNode ||
        haversine(source.lat, source.lng, destNode.lat, destNode.lng) > params.regionalRadius) {
      controls.setStatus(
        'Regional path ended outside the ring — no nearby nodes reachable. Try more nodes or a larger radius.',
        'warn'
      );
      controls.setRunning(false);
      return;
    }
  }

  if (result?.path?.length > 1) {
    controls.setStatus(
      `Path: ${result.path.length} nodes, ${result.hops} hops, ${result.time.toFixed(1)} ms — animating…`,
      'info'
    );
    await globe.animatePath(result.path, nodeMap, 800);
    results.showDemoResults(result);
    controls.setStatus(
      `Demo complete: ${result.hops} hops, ${result.time.toFixed(1)} ms total`,
      'success'
    );
  } else {
    controls.setStatus('Lookup returned no path.', 'warn');
  }
  controls.setRunning(false);
}

// ─────────────────────────────────────────────────────────────────────────────
// Churn Test
// ─────────────────────────────────────────────────────────────────────────────

async function onChurnTest() {
  if (!dht) {
    controls.setStatus('Initialise the network first.', 'warn');
    return;
  }
  controls.setRunning(true);
  controls.setProgress(0);
  globe.clearArcs();
  globe.clearConnections();

  const params = controls.snapshot();
  controls.setStatus(
    `Churn test: ${params.churnIntervals} intervals, ` +
    `${(params.churnRate * 100).toFixed(0)}% churn/interval, ` +
    `${params.lookupsPerInterval} lookups/interval…`,
    'info'
  );

  engine.onProgress = (frac, data) => {
    controls.setProgress(frac);
    if (data?.timeSeries) {
      results.updateChurnProgress(data.timeSeries);
      const last = data.timeSeries[data.timeSeries.length - 1];
      if (last) {
        controls.setStatus(
          `Interval ${last.interval + 1}/${params.churnIntervals} — ` +
          `avg hops: ${last.hops?.mean?.toFixed(2) ?? '—'}, ` +
          `success: ${(last.successRate * 100).toFixed(1)}%`,
          'info'
        );
      }
    }
    // Refresh node colours after churn
    globe.setNodes(dht.getNodes());
  };

  const result = await engine.runChurnTest(dht, {
    churnRate: params.churnRate,
    intervals: params.churnIntervals,
    lookupsPerInterval: params.lookupsPerInterval,
    landFn: (lat, lng) => globe.isLand(lat, lng),
  });

  results.showChurnResults(result);
  globe.setNodes(dht.getNodes());
  controls.setStatus('Churn test complete.', 'success');
  controls.setRunning(false);
  controls.setProgress(0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Train Network (Neuromorphic only)
// ─────────────────────────────────────────────────────────────────────────────

let trainingActive  = false;
let trainingHistory = [];
let trainingEpoch   = 0;   // cumulative lookups processed across all sessions
let concordanceActive = false;
let pairActive = false;

async function onTrainNetwork() {
  if (trainingActive) {
    // Toggle off: stop training loop
    trainingActive = false;
    return;
  }

  if (concordanceActive) return;
  if (pairActive) return;

  if (!dht) {
    controls.setStatus('Initialise the network first.', 'warn');
    return;
  }

  trainingActive  = true;
  trainingHistory = [];
  trainingEpoch   = 0;
  results.clearTraining();
  controls.setTraining(true);
  globe.clearArcs();
  globe.clearConnections();
  globe.clearRegionalBoundary();

  const params = controls.snapshot();

  // Draw regional boundary ring once so user can see the constraint is active
  if (params.regional) {
    const nodes = dht.getNodes().filter(n => n.alive);
    if (nodes.length) {
      const src = nodes[Math.floor(Math.random() * nodes.length)];
      globe.drawRegionalBoundary(src.lat, src.lng, params.regionalRadius);
    }
  }

  // ── Session 0: baseline measurement (pre-training state) ──────────────
  controls.setStatus('Running baseline measurement (session 0)…', 'info');
  const baseResult = await engine.runLookupTest(dht, {
    numMessages:     params.msgCount,
    captureLastPath: false,
    regional:        params.regional,
    regionalRadius:  params.regionalRadius,
    hotPct:          params.hotPct,
    sourcePct:       params.sourceMode ? params.sourcePct : 0,
    destPct:         params.destMode   ? params.destPct   : 0,
  });
  if (trainingActive) {
    const baseNodes = dht.getNodes().filter(n => n.alive);
    const baseAvgSyn = baseNodes.length > 0 && typeof baseNodes[0].synaptome !== 'undefined'
      ? baseNodes.reduce((s, n) => s + n.synaptome.size, 0) / baseNodes.length
      : null;
    trainingHistory.push({
      session: 0,
      epoch:       0,
      avgSynapses: baseAvgSyn,
      successRate: baseResult.successRate,
      hops:        baseResult.hops,
      time:        baseResult.time,
      isBaseline:  true,
    });
    results.showTrainingResults(trainingHistory);
    await yieldUI();
  }

  while (trainingActive) {
    const session = trainingHistory.length; // 1-based after baseline
    controls.setStatus(`Training session ${session}…`, 'info');

    const result = await engine.runLookupTest(dht, {
      numMessages:     params.msgCount,
      captureLastPath: false,
      regional:        params.regional,
      regionalRadius:  params.regionalRadius,
      hotPct:          params.hotPct,
      sourcePct:       params.sourceMode ? params.sourcePct : 0,
      destPct:         params.destMode   ? params.destPct   : 0,
    });

    if (!trainingActive) break;   // stopped during the run

    trainingEpoch += params.msgCount;

    // Compute avg synapses per node (Neuromorphic only)
    let avgSynapses = null;
    const nodes = dht.getNodes().filter(n => n.alive);
    if (nodes.length > 0 && typeof nodes[0].synaptome !== 'undefined') {
      avgSynapses = nodes.reduce((s, n) => s + n.synaptome.size, 0) / nodes.length;
    }

    trainingHistory.push({
      session,
      epoch:       trainingEpoch,
      avgSynapses,
      successRate: result.successRate,
      hops:        result.hops,
      time:        result.time,
    });

    results.updateTrainingProgress(trainingHistory);

    controls.setStatus(
      `Session ${session} — hops: ${result.hops?.mean.toFixed(2) ?? '—'}, ` +
      `time: ${result.time?.mean.toFixed(1) ?? '—'} ms, ` +
      `success: ${(result.successRate * 100).toFixed(1)}%`,
      'info'
    );

    await yieldUI();
  }

  trainingActive = false;
  controls.setTraining(false);
  const trainedSessions = trainingHistory.filter(s => !s.isBaseline).length;
  controls.setStatus(
    `Training stopped after ${trainedSessions} session(s).`,
    'success'
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Concordance — star-topology overlay network test
// ─────────────────────────────────────────────────────────────────────────────

async function onConcordance() {
  if (concordanceActive) {
    concordanceActive = false;
    return;
  }

  if (trainingActive || pairActive || !dht) {
    if (!dht) controls.setStatus('Initialise the network first.', 'warn');
    return;
  }

  const params = controls.snapshot();
  const aliveNodes = dht.getNodes().filter(n => n.alive);
  if (aliveNodes.length < params.concordanceSize + 1) {
    controls.setStatus(
      `Need at least ${params.concordanceSize + 1} nodes for concordance. Init a larger network.`,
      'warn'
    );
    return;
  }

  concordanceActive = true;
  controls.setConcordance(true);
  globe.clearArcs();
  globe.clearConnections();
  globe.clearRegionalBoundary();

  // Pick a relay and participants fresh each run
  const shuffled    = [...aliveNodes].sort(() => Math.random() - 0.5);
  const relay       = shuffled[0];
  const participants = shuffled.slice(1, 1 + params.concordanceSize);

  // Highlight the relay on the globe by drawing boundary rings centred on it
  globe.drawRegionalBoundary(relay.lat, relay.lng, 500);

  const history = [];
  let session   = 0;

  results.clearConcordance();
  controls.setStatus(`Concordance: relay 0x${relay.id.toString(16).padStart(16,'0').toUpperCase().slice(0,8)}… · ${participants.length} participants`, 'info');

  while (concordanceActive) {
    session++;
    controls.setStatus(`Concordance session ${session}…`, 'info');

    const sess = await engine.runConcordanceSession(dht, relay, participants);

    if (!concordanceActive) break;

    history.push({
      session,
      participants: participants.length,
      toRelay:   sess.toRelay,
      fromRelay: sess.fromRelay,
    });

    results.showConcordanceResults(history, relay);
    results.updateConcordanceProgress(history, relay);

    controls.setStatus(
      `Concordance #${session} — →relay: ${sess.toRelay?.mean?.toFixed(2) ?? '—'} hops, ` +
      `relay→: ${sess.fromRelay?.mean?.toFixed(2) ?? '—'} hops`,
      'info'
    );

    await yieldUI();
  }

  concordanceActive = false;
  controls.setConcordance(false);
  controls.setStatus(`Concordance stopped after ${session} session(s).`, 'success');
}

// ─────────────────────────────────────────────────────────────────────────────
// Pair Learning — fixed one-to-one routing test
// ─────────────────────────────────────────────────────────────────────────────

async function onPairLearning() {
  if (pairActive) {
    pairActive = false;
    return;
  }

  if (trainingActive || concordanceActive || !dht) {
    if (!dht) controls.setStatus('Initialise the network first.', 'warn');
    return;
  }

  const aliveNodes = dht.getNodes().filter(n => n.alive);
  if (aliveNodes.length < 2) {
    controls.setStatus('Need at least 2 nodes for pair learning.', 'warn');
    return;
  }

  pairActive = true;
  controls.setPairLearning(true);
  globe.clearArcs();
  globe.clearConnections();
  globe.clearRegionalBoundary();

  // Assign each node a fixed random target (different from itself).
  // Targets are chosen once and stay fixed across all sessions so the
  // neuromorphic synaptome can build dedicated shortcuts for each pair.
  const pairs = aliveNodes.map((src, i) => {
    let dstIdx;
    do { dstIdx = Math.floor(Math.random() * aliveNodes.length); }
    while (dstIdx === i);
    return { srcId: src.id, dstId: aliveNodes[dstIdx].id };
  });

  results.clearPairLearning();
  const history = [];
  let session = 0;

  controls.setStatus(
    `Pair Learning: ${pairs.length.toLocaleString()} fixed pairs — running…`,
    'info'
  );

  while (pairActive) {
    session++;
    controls.setStatus(`Pair Learning session ${session} (${pairs.length.toLocaleString()} pairs)…`, 'info');
    controls.setProgress(0);

    const sess = await engine.runPairSession(dht, pairs);

    if (!pairActive) break;

    history.push({
      session,
      pairs:   pairs.length,
      hops:    sess.hops,
      time:    sess.time,
      success: sess.successCount,
    });

    results.showPairResults(history);
    results.updatePairProgress(history);

    controls.setProgress(0);
    controls.setStatus(
      `Pair #${session} — avg hops: ${sess.hops?.mean?.toFixed(2) ?? '—'}, ` +
      `avg time: ${sess.time?.mean?.toFixed(1) ?? '—'} ms, ` +
      `routed: ${sess.successCount}/${pairs.length}`,
      'info'
    );

    await yieldUI();
  }

  pairActive = false;
  controls.setPairLearning(false);
  controls.setProgress(0);
  controls.setStatus(
    `Pair Learning stopped after ${session} session(s) · ${pairs.length.toLocaleString()} pairs.`,
    'success'
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Benchmark — all-protocol × multi-radius comparison
// ─────────────────────────────────────────────────────────────────────────────

let benchmarkActive = false;

async function onBenchmark() {
  // Cannot start a benchmark while training is running.
  if (trainingActive) return;
  if (concordanceActive) return;
  if (pairActive) return;

  // Toggle: clicking while running stops the benchmark.
  if (benchmarkActive) {
    benchmarkActive = false;
    engine.stop();
    return;
  }

  benchmarkActive = true;
  controls.setBenchmarking(true);
  controls.setProgress(0);
  globe.clearArcs();
  globe.clearConnections();

  const params = controls.snapshot();

  const PROTOCOL_DEFS = [
    { key: 'kademlia', label: 'Kademlia' },
    { key: 'geo8',     label: 'G-DHT-8'  },
    // Neuromorphic protocols need a warmup burst so synaptic shortcuts form
    // before measurement.  Without warmup their weights are identical to G-DHT-8.
    { key: 'ngdht',     label: 'N-1',     warmupLookups: params.benchWarmupSessions * 500, warmupHotPct: 10, warmupRadius: 2000 },
    { key: 'ngdht2',    label: 'N-2',     warmupLookups: params.benchWarmupSessions * 500, warmupHotPct: 10, warmupRadius: 2000 },
    { key: 'ngdht2bp',  label: 'N-2-BP',  warmupLookups: params.benchWarmupSessions * 500, warmupHotPct: 10, warmupRadius: 2000 },
    { key: 'ngdht2shc', label: 'N-2-SHC', warmupLookups: params.benchWarmupSessions * 500, warmupHotPct: 10, warmupRadius: 2000 },
    { key: 'ngdht3',    label: 'N-3',     warmupLookups: params.benchWarmupSessions * 500, warmupHotPct: 10, warmupRadius: 2000 },
    { key: 'ngdht4',    label: 'N-4',     warmupLookups: params.benchWarmupSessions * 500, warmupHotPct: 10, warmupRadius: 2000 },
    { key: 'ngdht5',    label: 'N-5',     warmupLookups: params.benchWarmupSessions * 500, warmupHotPct: 10, warmupRadius: 2000 },
  ];

  // Benchmark always tests 4 regional radii, a dest-restricted column, and global.
  // The dest percentage is taken from the Dest input (default 10%); the Dest
  // checkbox only affects individual Lookup Tests, not the benchmark.
  const testSpecs = [
    { type: 'global' },                                // measured first — pre-specialisation baseline
    { type: 'regional', radius: 500  },
    { type: 'regional', radius: 1000 },
    { type: 'regional', radius: 2000 },
    { type: 'regional', radius: 5000 },
    { type: 'source',  pct: params.sourcePct },
    { type: 'dest',    pct: params.destPct },
    { type: 'srcdest', srcPct: params.sourcePct, destPct: params.destPct },
    { type: 'continent', src: 'NA', dst: 'AS' },       // hardest trans-oceanic pair — tests long-range stratum preservation
    { type: 'churn',   rate: params.benchChurnPct },  // always last — modifies DHT state
  ];

  const N           = params.nodeCount;
  const NUM_LOOKUPS = params.msgCount;

  // Total work units: for each protocol — 1 build step + one step per test spec.
  const TOTAL_STEPS      = PROTOCOL_DEFS.length * (1 + testSpecs.length);
  const YIELD_EVERY      = Math.max(100, Math.floor(N / 200));
  let   completedSteps   = 0;

  // Build a progress fraction from completed steps plus partial progress inside
  // the current build.
  const stepFrac = (done, partial = 0) => (done + partial) / TOTAL_STEPS;

  const protocolDefs = [];

  for (const def of PROTOCOL_DEFS) {
    const buildFn = async () => {
      if (!benchmarkActive) return null;

      controls.setStatus(
        `[${def.label}] Building network (${N.toLocaleString()} nodes)…`, 'bench'
      );
      const benchDHT = createDHT({ ...params, protocol: def.key });

      for (let i = 0; i < N; i++) {
        if (!benchmarkActive) return null;   // stop during node addition
        const { lat, lng } = globe.randomLandPoint();
        await benchDHT.addNode(lat, lng);
        if ((i + 1) % YIELD_EVERY === 0) {
          controls.setProgress(stepFrac(completedSteps, (i + 1) / N * 0.8));
          await yieldUI();
        }
      }

      if (!benchmarkActive) return null;
      controls.setStatus(`[${def.label}] Building routing tables…`, 'bench');
      benchDHT.buildRoutingTables();
      completedSteps++;
      controls.setProgress(stepFrac(completedSteps));
      await yieldUI();

      return benchDHT;
    };

    protocolDefs.push({
      key:           def.key,
      label:         def.label,
      buildFn,
      warmupLookups: def.warmupLookups,
      warmupHotPct:  def.warmupHotPct,
      warmupRadius:  def.warmupRadius,
    });
  }

  const benchResult = await engine.runBenchmark(protocolDefs, {
    testSpecs,
    numMessages: NUM_LOOKUPS,
    landFn: () => globe.randomLandPoint(),
    // onStart: status-only update before each cell (no progress increment)
    onStart: (msg) => {
      controls.setStatus(`[Benchmark] ${msg}`, 'bench');
    },
    // onStep: called once after each cell completes — drives progress bar
    onStep: (msg) => {
      completedSteps++;
      controls.setProgress(stepFrac(completedSteps));
      controls.setStatus(`[Benchmark] ${msg}`, 'bench');
    },
  });

  const stopped = !benchmarkActive;
  benchmarkActive = false;
  controls.setBenchmarking(false);
  controls.setProgress(0);

  if (stopped) {
    controls.setStatus('Benchmark stopped.', 'warn');
  } else {
    results.showBenchmarkResults(benchResult, N);
    controls.setStatus('Benchmark complete.', 'success');
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Factory
// ─────────────────────────────────────────────────────────────────────────────

function createDHT(params) {
  switch (params.protocol) {
    case 'geo8':
      return new GeographicDHT({
        k: params.k,
        alpha: params.alpha,
        bits: params.bits,
        geoBits: 8,
      });
    case 'geo16':
      return new GeographicDHT({
        k: params.k,
        alpha: params.alpha,
        bits: params.bits,
        geoBits: 16,
      });
    case 'ngdht':
      return new NeuromorphicDHT({
        k: params.k,
        alpha: params.alpha,
        bits: params.bits,
      });
    case 'ngdht2':
      return new NeuromorphicDHT2({
        k: params.k,
        alpha: params.alpha,
        bits: params.bits,
      });
    case 'ngdht2bp':
      return new NeuromorphicDHT2BP({
        k: params.k,
        alpha: params.alpha,
        bits: params.bits,
      });
    case 'ngdht2shc':
      return new NeuromorphicDHT2SHC({
        k: params.k,
        alpha: params.alpha,
        bits: params.bits,
      });
    case 'ngdht3':
      return new NeuromorphicDHT3({
        k: params.k,
        alpha: params.alpha,
        bits: params.bits,
      });
    case 'ngdht4':
      return new NeuromorphicDHT4({
        k: params.k,
        alpha: params.alpha,
        bits: params.bits,
      });
    case 'ngdht5':
      return new NeuromorphicDHT5({
        k: params.k,
        alpha: params.alpha,
        bits: params.bits,
      });
    case 'kademlia':
    default:
      return new KademliaDHT({
        k: params.k,
        alpha: params.alpha,
        bits: params.bits,
      });
  }
}

function yieldUI() {
  return new Promise(r => setTimeout(r, 0));
}

// ─────────────────────────────────────────────────────────────────────────────
// Boot
// ─────────────────────────────────────────────────────────────────────────────

document.addEventListener('DOMContentLoaded', init);

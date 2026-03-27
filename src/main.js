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
import { NeuromorphicDHT5W }   from './dht/neuromorphic/NeuromorphicDHT5W.js';
import { NeuromorphicDHT6W }   from './dht/neuromorphic/NeuromorphicDHT6W.js';
import { NeuromorphicDHT7W }   from './dht/neuromorphic/NeuromorphicDHT7W.js';
import { NeuromorphicDHT8W }   from './dht/neuromorphic/NeuromorphicDHT8W.js';
import { NeuromorphicDHT9W }   from './dht/neuromorphic/NeuromorphicDHT9W.js';
import { NeuromorphicDHT10W }  from './dht/neuromorphic/NeuromorphicDHT10W.js';
import { NeuromorphicDHT11W }  from './dht/neuromorphic/NeuromorphicDHT11W.js';
import { NeuromorphicDHT12W }  from './dht/neuromorphic/NeuromorphicDHT12W.js';
import { NeuromorphicDHT13W }  from './dht/neuromorphic/NeuromorphicDHT13W.js';
import { NeuromorphicDHT15W }  from './dht/neuromorphic/NeuromorphicDHT15W.js';
// NeuromorphicDHT14W retired — superseded by N-15W. Source kept in neuromorphic/ for reference.
import { SimulationEngine }   from './simulation/Engine.js';
import { Controls }           from './ui/Controls.js';
import { Results }            from './ui/Results.js';
import { BenchmarkSweep }    from './ui/BenchmarkSweep.js';
import { setLatencyParams,
         getLatencyParams,
         haversine }          from './utils/geo.js';
import { requestNotifyPermission,
         notifyEnabled,
         notify }             from './utils/notify.js';

// ─────────────────────────────────────────────────────────────────────────────
// Result push — POST CSV + metadata to server so Claude can read it
// ─────────────────────────────────────────────────────────────────────────────

async function pushResult(type, csv, meta = {}) {
  try {
    await fetch('/complete', {
      method:  'POST',
      headers: { 'Content-Type': 'application/json' },
      body:    JSON.stringify({ type, csv, meta }),
    });
  } catch (e) {
    console.warn('pushResult: server not reachable', e);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Module-level state
// ─────────────────────────────────────────────────────────────────────────────

let globe    = null;
let dht      = null;
let engine   = null;
const sweep  = new BenchmarkSweep();

// Expose for browser console / Claude debugging
window.__sim = {
  get globe()  { return globe;  },
  get dht()    { return dht;    },
  get sweep()  { return sweep;  },
};
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
  document.getElementById('btnPubSub')?.addEventListener('click', onPubSub);
  document.getElementById('btnPairLearning')?.addEventListener('click', onPairLearning);
  document.getElementById('btnHotspotTest')?.addEventListener('click', onHotspotTest);
  document.getElementById('btnBenchmark')?.addEventListener('click', onBenchmark);
  document.getElementById('btnSweepStop')?.addEventListener('click', () => sweep.stop());

  // Notification bell button
  const btnNotify = document.getElementById('btnNotify');
  function _refreshNotifyBtn() {
    if (!btnNotify) return;
    const perm = typeof Notification !== 'undefined' ? Notification.permission : 'unsupported';
    btnNotify.classList.remove('notify-on', 'notify-off', 'notify-denied');
    if (perm === 'denied') {
      btnNotify.classList.add('notify-denied');
      btnNotify.setAttribute('data-tip', 'Notifications blocked — change in browser settings');
    } else if (perm !== 'granted') {
      btnNotify.classList.add('notify-off');
      btnNotify.setAttribute('data-tip', 'Click to enable desktop notifications when tests complete');
    } else {
      btnNotify.classList.add('notify-on');
      btnNotify.setAttribute('data-tip', 'Notifications enabled — click to send a test notification');
    }
  }
  btnNotify?.addEventListener('click', async () => {
    if (notifyEnabled()) {
      notify('DHT Globe', 'Notifications are working ✓');
    } else {
      const granted = await requestNotifyPermission();
      if (granted) notify('DHT Globe', 'Notifications enabled — you will be alerted when tests complete ✓');
    }
    _refreshNotifyBtn();
  });
  _refreshNotifyBtn();

  // Auto-rotate toggle
  document.getElementById('autoRotate')?.addEventListener('change', e => {
    globe?.setAutoRotate(e.target.checked);
  });

  // Fullscreen button — fullscreens the whole page so the sidebar stays visible
  const fsBtn = document.getElementById('globeFullscreenBtn');
  fsBtn?.addEventListener('click', () => {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen();
    } else {
      document.exitFullscreen();
    }
  });
  document.addEventListener('fullscreenchange', () => {
    if (fsBtn) fsBtn.textContent = document.fullscreenElement ? '✕' : '⛶';
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
  pubsubActive = false;
  controls.setPubSub(false);
  pairActive = false;
  controls.setPairLearning(false);
  hotspotActive = false;
  controls.setHotspotTesting(false);
  controls.setRunning(true);
  controls.setProgress(0);
  results.clear();
  results.clearTraining();
  results.clearPubSub();
  results.clearPairLearning();
  globe.clearArcs();
  globe.clearConnections();
  globe.clearRegionalBoundary();

  const params = controls.snapshot();
  controls.setStatus(`Building ${params.nodeCount}-node ${params.protocol} network…`, 'info');

  // Apply latency parameters before building the network
  const { maxPropagation } = getLatencyParams();
  setLatencyParams(maxPropagation, params.nodeDelay);

  // Dispose the previous DHT before allocating the new one.
  // With large node counts the old network can hold hundreds of MB; releasing
  // it explicitly (and yielding so the GC can reclaim it) prevents OOM during
  // the double-allocation window that would otherwise occur.
  if (dht) {
    dht.dispose();
    dht = null;
    await yieldUI();  // let GC run before the new allocation
  }

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

  dht.buildRoutingTables({ bidirectional: params.bidirectional });

  controls.setProgress(1);
  globe.setNodes(dht.getNodes());
  controls.setStatus(
    `Network ready: ${nodes.length} nodes, ${params.protocol} ` +
    `(k=${params.k}, α=${params.alpha}, ${params.bits}-bit IDs)`,
    'success'
  );
  controls.setRunning(false);
  controls.setProgress(0);
  sweep.notifyInitComplete();
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
  results.setRunParams(params);
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
  const _ltStatus = `Done. Avg hops: ${result.hops?.mean.toFixed(2)}, ` +
    `avg time: ${result.time?.mean.toFixed(1)} ms, ` +
    `success: ${(result.successRate * 100).toFixed(1)}%`;
  controls.setStatus(_ltStatus, 'success');
  notify('Lookup Test complete', _ltStatus);
  await pushResult('lookup', results.getLookupCSV(), { avgHops: result.hops?.mean, avgMs: result.time?.mean, successRate: result.successRate });
  controls.setRunning(false);
  controls.setProgress(0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Demo (looping animated lookup — toggle start / stop)
// ─────────────────────────────────────────────────────────────────────────────

let _demoRunning = false;

async function onDemoLookup() {
  // Second click → stop the loop
  if (_demoRunning) {
    _demoRunning = false;
    return;
  }

  if (!dht) {
    controls.setStatus('Initialise the network first.', 'warn');
    return;
  }

  _demoRunning = true;
  controls.setDemo(true);

  const { randomU64 } = await import('./utils/geo.js');

  while (_demoRunning) {
    globe.clearArcs();
    globe.clearConnections();
    globe.clearRegionalBoundary();

    const nodes = dht.getNodes().filter(n => n.alive);
    if (nodes.length < 2) {
      controls.setStatus('Not enough nodes for a demo lookup.', 'warn');
      break;
    }
    const params = controls.snapshot();

    // ── Select sender ────────────────────────────────────────────────────────
    // In regional mode, only consider senders that have at least one other
    // live node within the radius — guarantees nearby is never empty.
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
        break;
      }
      source = eligible[Math.floor(Math.random() * eligible.length)];
      nearby = nodes.filter(n =>
        n.id !== source.id &&
        haversine(source.lat, source.lng, n.lat, n.lng) <= params.regionalRadius
      );
      globe.drawRegionalBoundary(source.lat, source.lng, params.regionalRadius);
    } else {
      source = nodes[Math.floor(Math.random() * nodes.length)];
    }

    controls.setStatus(
      `Demo lookup from node 0x${source.id.toString(16).padStart(16,'0').toUpperCase().slice(0,8)}` +
      `${params.regional ? ` (regional ≤${params.regionalRadius} km)` : ''}…`,
      'info'
    );

    // ── Run lookup ───────────────────────────────────────────────────────────
    const nodeMap = new Map(dht.getNodes().map(n => [n.id, n]));
    let result = null;

    if (params.regional) {
      const receiver = nearby[Math.floor(Math.random() * nearby.length)];
      result = await dht.lookup(source.id, receiver.id);
    } else {
      result = await dht.lookup(source.id, randomU64());
    }

    if (!_demoRunning) break;

    // Sanity-check: destination should be within the regional ring.
    if (params.regional && result?.path?.length > 1) {
      const destNode = nodeMap.get(result.path.at(-1));
      if (!destNode ||
          haversine(source.lat, source.lng, destNode.lat, destNode.lng) > params.regionalRadius) {
        controls.setStatus(
          'Regional path ended outside the ring — no nearby nodes reachable. Try more nodes or a larger radius.',
          'warn'
        );
        break;
      }
    }

    if (result?.path?.length > 1) {
      controls.setStatus(
        `Demo: ${result.hops} hops, ${result.time.toFixed(1)} ms — animating…`,
        'info'
      );
      await globe.animatePath(result.path, nodeMap, 800);
      if (!_demoRunning) break;
      results.showDemoResults(result);
      controls.setStatus(
        `Demo: ${result.hops} hops, ${result.time.toFixed(1)} ms — next in 1 s…`,
        'success'
      );
    } else {
      controls.setStatus('Demo: lookup returned no path — retrying…', 'warn');
    }

    // 1-second pause before next demo
    await new Promise(r => setTimeout(r, 1000));
  }

  _demoRunning = false;
  controls.setDemo(false);
  globe.clearArcs();
  globe.clearRegionalBoundary();
  controls.setStatus('Demo stopped.', 'info');
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
  results.setRunParams(params);
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
  notify('Churn Test complete', `${params.churnIntervals} intervals · ${(params.churnRate * 100).toFixed(0)}% churn/interval`);
  await pushResult('churn', results.getChurnCSV(), { intervals: params.churnIntervals, churnRate: params.churnRate });
  controls.setRunning(false);
  controls.setProgress(0);
}

// ─────────────────────────────────────────────────────────────────────────────
// Train Network (Neuromorphic only)
// ─────────────────────────────────────────────────────────────────────────────

let trainingActive  = false;
let trainingHistory = [];
let trainingEpoch   = 0;   // cumulative lookups processed across all sessions
let pubsubActive = false;
let pairActive = false;
let hotspotActive = false;

async function onTrainNetwork() {
  if (trainingActive) {
    // Toggle off: stop training loop
    trainingActive = false;
    return;
  }

  if (pubsubActive) return;
  if (pairActive) return;

  if (!dht) {
    controls.setStatus('Initialise the network first.', 'warn');
    return;
  }

  trainingActive  = true;
  trainingHistory = [];
  trainingEpoch   = 0;
  results.clearTraining();
  results.clearHotspot();
  controls.setTraining(true);
  globe.clearArcs();
  globe.clearConnections();
  globe.clearRegionalBoundary();

  const params = controls.snapshot();
  results.setRunParams(params);

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
  const _trainMsg = `Training stopped after ${trainedSessions} session(s).`;
  controls.setStatus(_trainMsg, 'success');
  notify('Train Network complete', _trainMsg);
  await pushResult('training', results.getTrainingCSV(), { sessions: trainedSessions });
}

// ─────────────────────────────────────────────────────────────────────────────
// Pub/Sub — multi-group overlay network test
// ─────────────────────────────────────────────────────────────────────────────

async function onPubSub() {
  if (pubsubActive) {
    pubsubActive = false;
    return;
  }

  if (trainingActive || pairActive || hotspotActive || !dht) {
    if (!dht) controls.setStatus('Initialise the network first.', 'warn');
    return;
  }

  const params     = controls.snapshot();
  results.setRunParams(params);
  const aliveNodes = dht.getNodes().filter(n => n.alive);
  const groupSize  = params.pubsubGroupSize;

  if (aliveNodes.length < groupSize + 1) {
    controls.setStatus(`Need at least ${groupSize + 1} nodes for Pub/Sub. Init a larger network.`, 'warn');
    return;
  }

  // ── Build pub/sub groups ──────────────────────────────────────────────────
  // Target: pubsubCoverage% of nodes in ≥1 group.
  // In regional mode, participants in each group are drawn only from nodes
  // within regionalRadius km of that group's relay.
  const targetNodes = Math.ceil(aliveNodes.length * params.pubsubCoverage / 100);
  const numGroups   = Math.max(1, Math.ceil(targetNodes / groupSize));
  const shuffled    = [...aliveNodes].sort(() => Math.random() - 0.5);
  const stride      = Math.max(1, Math.floor(shuffled.length / numGroups));

  if (params.regional) {
    // Verify at least one node has enough regional neighbours to form a group
    const minNeeded = Math.min(groupSize, 2);
    const hasRegion = aliveNodes.some(n =>
      aliveNodes.filter(m => m.id !== n.id &&
        haversine(n.lat, n.lng, m.lat, m.lng) <= params.regionalRadius).length >= minNeeded
    );
    if (!hasRegion) {
      controls.setStatus(
        `No node has ${minNeeded}+ neighbours within ${params.regionalRadius} km — try a larger radius or more nodes.`, 'warn'
      );
      return;
    }
  }

  const groups = [];
  for (let i = 0; i < numGroups; i++) {
    const base  = (i * stride) % shuffled.length;
    const relay = shuffled[base];

    let pool;
    if (params.regional) {
      // Participants must be within regionalRadius km of the relay
      pool = aliveNodes.filter(n =>
        n.id !== relay.id &&
        haversine(relay.lat, relay.lng, n.lat, n.lng) <= params.regionalRadius
      );
    } else {
      // Global mode: stride through the full shuffled array
      pool = [];
      for (let j = 1; j <= groupSize; j++) {
        pool.push(shuffled[(base + j) % shuffled.length]);
      }
    }

    // Shuffle the pool and take up to groupSize participants
    pool = pool.sort(() => Math.random() - 0.5).slice(0, groupSize);
    if (!pool.length) continue;   // no neighbours in range — skip this relay

    groups.push({ id: i, relay, participants: pool });
  }

  if (!groups.length) {
    controls.setStatus(
      `Could not form any groups within ${params.regionalRadius} km — try a larger radius.`, 'warn'
    );
    return;
  }

  // Actual coverage (unique nodes across all groups)
  const covered = new Set();
  for (const g of groups) {
    covered.add(g.relay.id);
    for (const p of g.participants) covered.add(p.id);
  }
  const actualCoverage = ((covered.size / aliveNodes.length) * 100).toFixed(1);

  pubsubActive = true;
  controls.setPubSub(true);
  globe.clearArcs();
  globe.clearConnections();
  globe.clearRegionalBoundary();

  // Pan the globe to the first relay; ring only shown in regional mode
  const ringRadius = params.regional ? params.regionalRadius : 0;
  if (params.regional) {
    globe.drawRegionalBoundary(groups[0].relay.lat, groups[0].relay.lng, ringRadius);
  }
  globe.panToLatLng(groups[0].relay.lat, groups[0].relay.lng);

  const history = [];
  let tick = 0;

  results.clearPubSub();
  controls.setStatus(
    `Pub/Sub: ${groups.length} groups · ${actualCoverage}% coverage · ${aliveNodes.length} nodes` +
    (params.regional ? ` · regional ≤${params.regionalRadius} km` : ''),
    'info'
  );

  while (pubsubActive) {
    tick++;
    const result = await engine.runPubSubSession(dht, groups);

    if (!pubsubActive) break;
    if (!result) continue;

    // Move the globe ring (regional only), pan the camera, and highlight relay + participants
    if (result.lastRelayNode) {
      const { lat, lng } = result.lastRelayNode;
      if (params.regional) {
        globe.drawRegionalBoundary(lat, lng, ringRadius);
      }
      globe.panToLatLng(lat, lng);
      const participantIds = result.lastParticipantNodes
        ? result.lastParticipantNodes.map(n => n.id)
        : [];
      globe.highlightPubSubGroup(result.lastRelayNode.id, participantIds);
    }

    history.push({
      tick,
      groups:    numGroups,
      coverage:  actualCoverage,
      msgHops:   result.relayHops,
      bcastAvg:  result.bcastHops,
      totalHops: result.relayHops + result.bcastHops,
      relayMs:   result.relayMs,
      bcastMs:   result.bcastMs,
    });

    results.showPubSubResults(history, numGroups, actualCoverage);

    controls.setStatus(
      `Pub/Sub session #${tick} — relay: ${result.relayHops.toFixed(1)} hops · bcast avg: ` +
      `${result.bcastHops.toFixed(1)} hops · relay ${result.relayMs} ms · bcast ${result.bcastMs} ms` +
      ` (${result.messagesPerSession} msgs/session)`,
      'info'
    );

    await yieldUI();
  }

  pubsubActive = false;
  controls.setPubSub(false);
  globe.clearPubSubHighlights();
  const _psMsg = `Pub/Sub stopped after ${tick} session(s).`;
  controls.setStatus(_psMsg, 'success');
  notify('Pub/Sub Test stopped', _psMsg);
  await pushResult('pubsub', results.getPubSubCSV(), { sessions: tick, groups: numGroups, coverage: actualCoverage });
}

// ─────────────────────────────────────────────────────────────────────────────
// Pair Learning — fixed one-to-one routing test
// ─────────────────────────────────────────────────────────────────────────────

async function onPairLearning() {
  if (pairActive) {
    pairActive = false;
    return;
  }

  if (trainingActive || pubsubActive || !dht) {
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
  results.setRunParams(controls.snapshot());

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
  const _plMsg = `Pair Learning stopped after ${session} session(s) · ${pairs.length.toLocaleString()} pairs.`;
  controls.setStatus(_plMsg, 'success');
  notify('Pair Learning stopped', _plMsg);
  await pushResult('pair-learning', results.getPairCSV(), { sessions: session, pairs: pairs.length });
}

// ─────────────────────────────────────────────────────────────────────────────
// Hotspot Test
// ─────────────────────────────────────────────────────────────────────────────

async function onHotspotTest() {
  if (!dht) { controls.setStatus('Initialise the network first.', 'warn'); return; }
  if (hotspotActive) {
    engine.stop();
    hotspotActive = false;
    controls.setHotspotTesting(false);
    controls.setStatus('Hotspot test stopped.', 'warn');
    return;
  }
  if (trainingActive || pubsubActive || pairActive) {
    controls.setStatus('Stop the running test first.', 'warn');
    return;
  }

  hotspotActive = true;
  controls.setHotspotTesting(true);
  results.clearHotspot();
  globe.clearArcs();

  const params    = controls.snapshot();
  results.setRunParams(params);
  const warmup    = params.benchWarmupSessions * 500;

  controls.setStatus('Hotspot test — warming up…', 'info');
  controls.setProgress(0);

  const protoName = dht.constructor.protocolName ?? params.protocol;
  engine.onProgress = (frac, info) => {
    controls.setProgress(frac);
    if (info?.phase === 'warmup') {
      controls.setStatus(`[${protoName}] Hotspot warmup: ${info.done}/${info.total} lookups…`, 'info');
    } else if (info?.phase === 'highway') {
      controls.setStatus(`[${protoName}] Highway phase: ${info.done}/${info.total} lookups…`, 'info');
    } else if (info?.phase === 'storage') {
      controls.setStatus(`[${protoName}] Storage phase: ${info.done}/${info.total} queries…`, 'info');
    }
  };

  engine.onComplete = async (result) => {
    if (result?.type === 'hotspot') {
      results.showHotspotResults(result);
      const hw = result.highway;
      const st = result.storage;
      const _hsMsg = `Hotspot done — Highway Gini: ${hw.gini.toFixed(3)} ` +
        `(top 1% = ${(hw.top1pctLoad*100).toFixed(1)}%),  ` +
        `Storage Gini: ${st.gini.toFixed(3)} ` +
        `(top 10% items = ${(st.top10pctItemLoad*100).toFixed(1)}%)`;
      controls.setStatus(_hsMsg, 'success');
      notify('Hotspot Test complete', `Highway Gini: ${hw.gini.toFixed(3)} · Storage Gini: ${st.gini.toFixed(3)}`);
      await pushResult('hotspot', results.getHotspotCSV(), { hwGini: hw.gini, stGini: st.gini });
    }
    hotspotActive = false;
    controls.setHotspotTesting(false);
    controls.setProgress(0);
  };

  await engine.runHotspotTest(dht, {
    warmupLookups:  warmup,
    numLookups:     params.hotspotLookups,
    contentCount:   params.contentCount,
    zipfExponent:   params.zipfExponent,
    contentLookups: params.hotspotLookups,
  });

  if (hotspotActive) {
    hotspotActive = false;
    controls.setHotspotTesting(false);
    controls.setProgress(0);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Benchmark — all-protocol × multi-radius comparison
// ─────────────────────────────────────────────────────────────────────────────

let benchmarkActive = false;

async function onBenchmark() {
  // Cannot start a benchmark while training is running.
  if (trainingActive) return;
  if (pubsubActive) return;
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
  results.setRunParams(params);

  const PROTOCOL_DEFS = [
    { key: 'kademlia', label: 'Kademlia' },
    { key: 'geo8',     label: 'G-DHT-8'  },
    // Neuromorphic protocols need a warmup burst so synaptic shortcuts form
    // before measurement.  Without warmup their weights are identical to G-DHT-8.
    { key: 'ngdht',     label: 'N-1',     warmupLookups: Math.max(params.benchWarmupSessions, Math.round(4 * params.nodeCount / 10000)) * 500, warmupHotPct: 10, warmupRadius: 2000 },
    { key: 'ngdht2',    label: 'N-2',     warmupLookups: Math.max(params.benchWarmupSessions, Math.round(4 * params.nodeCount / 10000)) * 500, warmupHotPct: 10, warmupRadius: 2000 },
    { key: 'ngdht2bp',  label: 'N-2-BP',  warmupLookups: Math.max(params.benchWarmupSessions, Math.round(4 * params.nodeCount / 10000)) * 500, warmupHotPct: 10, warmupRadius: 2000 },
    { key: 'ngdht2shc', label: 'N-2-SHC', warmupLookups: Math.max(params.benchWarmupSessions, Math.round(4 * params.nodeCount / 10000)) * 500, warmupHotPct: 10, warmupRadius: 2000 },
    { key: 'ngdht3',    label: 'N-3',     warmupLookups: Math.max(params.benchWarmupSessions, Math.round(4 * params.nodeCount / 10000)) * 500, warmupHotPct: 10, warmupRadius: 2000 },
    { key: 'ngdht4',    label: 'N-4',     warmupLookups: Math.max(params.benchWarmupSessions, Math.round(4 * params.nodeCount / 10000)) * 500, warmupHotPct: 10, warmupRadius: 2000 },
    { key: 'ngdht5',    label: 'N-5',     warmupLookups: Math.max(params.benchWarmupSessions, Math.round(4 * params.nodeCount / 10000)) * 500, warmupHotPct: 10, warmupRadius: 2000 },
    { key: 'ngdht5w',   label: 'N-5W',    warmupLookups: Math.max(params.benchWarmupSessions, Math.round(4 * params.nodeCount / 10000)) * 500, warmupHotPct: 10, warmupRadius: 2000 },
    { key: 'ngdht6w',   label: 'N-6W',    warmupLookups: Math.max(params.benchWarmupSessions, Math.round(4 * params.nodeCount / 10000)) * 500, warmupHotPct: 10, warmupRadius: 2000 },
    { key: 'ngdht7w',   label: 'N-7W',    warmupLookups: Math.max(params.benchWarmupSessions, Math.round(4 * params.nodeCount / 10000)) * 500, warmupHotPct: 10, warmupRadius: 2000 },
    { key: 'ngdht8w',   label: 'N-8W',    warmupLookups: Math.max(params.benchWarmupSessions, Math.round(4 * params.nodeCount / 10000)) * 500, warmupHotPct: 10, warmupRadius: 2000 },
    { key: 'ngdht9w',   label: 'N-9W',    warmupLookups: Math.max(params.benchWarmupSessions, Math.round(4 * params.nodeCount / 10000)) * 500, warmupHotPct: 10, warmupRadius: 2000 },
    { key: 'ngdht10w',  label: 'N-10W',   warmupLookups: Math.max(params.benchWarmupSessions, Math.round(4 * params.nodeCount / 10000)) * 500, warmupHotPct: 10, warmupRadius: 2000 },
    { key: 'ngdht11w',  label: 'N-11W',   warmupLookups: Math.max(params.benchWarmupSessions, Math.round(4 * params.nodeCount / 10000)) * 500, warmupHotPct: 10, warmupRadius: 2000 },
    { key: 'ngdht12w',  label: 'N-12W',   warmupLookups: Math.max(params.benchWarmupSessions, Math.round(4 * params.nodeCount / 10000)) * 500, warmupHotPct: 10, warmupRadius: 2000 },
    { key: 'ngdht13w',  label: 'N-13W',   warmupLookups: Math.max(params.benchWarmupSessions, Math.round(4 * params.nodeCount / 10000)) * 500, warmupHotPct: 10, warmupRadius: 2000 },
    { key: 'ngdht15w',  label: 'N-15W',   warmupLookups: Math.max(params.benchWarmupSessions, Math.round(4 * params.nodeCount / 10000)) * 500, warmupHotPct: 10, warmupRadius: 2000 },
  ].filter(def => !params.benchProtocols || params.benchProtocols.has(def.key));

  // Build the full ordered test list, then filter by user selection.
  // 'churn' is always kept last if selected (it modifies DHT state).
  const ALL_TEST_SPECS = [
    { key: 'global',    type: 'global' },
    { key: 'r500',      type: 'regional', radius: 500  },
    { key: 'r1000',     type: 'regional', radius: 1000 },
    { key: 'r2000',     type: 'regional', radius: 2000 },
    { key: 'r5000',     type: 'regional', radius: 5000 },
    { key: 'src',       type: 'source',   pct: params.sourcePct },
    { key: 'dest',      type: 'dest',     pct: params.destPct },
    { key: 'srcdest',   type: 'srcdest',  srcPct: params.sourcePct, destPct: params.destPct },
    { key: 'continent', type: 'continent', src: 'NA', dst: 'AS' },
    { key: 'pubsub',    type: 'pubsub',   groupSize: params.pubsubGroupSize, coverage: params.pubsubCoverage },
    { key: 'churn',     type: 'churn',    rate: params.benchChurnPct },
  ];
  const testSpecs = ALL_TEST_SPECS
    .filter(s => !params.benchTests || params.benchTests.has(s.key))
    .map(({ key: _key, ...rest }) => rest);  // strip the key before passing to engine

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
  const TOTAL_PROTOCOLS = PROTOCOL_DEFS.length;

  for (let defIdx = 0; defIdx < TOTAL_PROTOCOLS; defIdx++) {
    const def = PROTOCOL_DEFS[defIdx];
    const tag = `${def.label} (${defIdx + 1}/${TOTAL_PROTOCOLS})`;

    const buildFn = async () => {
      if (!benchmarkActive) return null;

      controls.setStatus(`${tag} — building network (${N.toLocaleString()} nodes)…`, 'bench');
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
      controls.setStatus(`${tag} — building routing tables…`, 'bench');
      benchDHT.buildRoutingTables({ bidirectional: params.bidirectional });
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
      controls.setStatus(msg, 'bench');
    },
    // onStep: called once after each cell completes — drives progress bar
    onStep: (msg) => {
      completedSteps++;
      controls.setProgress(stepFrac(completedSteps));
      controls.setStatus(msg, 'bench');
    },
  });

  const stopped = !benchmarkActive;
  benchmarkActive = false;
  controls.setBenchmarking(false);
  controls.setProgress(0);

  if (stopped) {
    controls.setStatus('Benchmark stopped.', 'warn');
    notify('Benchmark stopped', `Interrupted after partial run · ${N.toLocaleString()} nodes`);
    sweep.notifyBenchmarkStopped();
  } else {
    results.showBenchmarkResults(benchResult, N, params);
    controls.setStatus('Benchmark complete.', 'success');
    notify('Benchmark complete ✓', `${params.benchProtocols?.length ?? '?'} protocols · ${N.toLocaleString()} nodes`);
    await pushResult('benchmark', results.getBenchmarkCSV(benchResult, N, params), { protocols: params.benchProtocols ?? [], nodeCount: N, warmupSessions: params.benchWarmupSessions, testSpecs: params.benchTests ?? [] });
    sweep.notifyBenchmarkComplete();
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
    case 'ngdht5w':
      return new NeuromorphicDHT5W({
        k: params.k,
        alpha: params.alpha,
        bits: params.bits,
      });
    case 'ngdht6w':
      return new NeuromorphicDHT6W({
        k: params.k,
        alpha: params.alpha,
        bits: params.bits,
      });
    case 'ngdht7w':
      return new NeuromorphicDHT7W({
        k: params.k,
        alpha: params.alpha,
        bits: params.bits,
      });
    case 'ngdht8w':
      return new NeuromorphicDHT8W({
        k: params.k,
        alpha: params.alpha,
        bits: params.bits,
      });
    case 'ngdht9w':
      return new NeuromorphicDHT9W({
        k: params.k,
        alpha: params.alpha,
        bits: params.bits,
      });
    case 'ngdht10w':
      return new NeuromorphicDHT10W({
        k: params.k,
        alpha: params.alpha,
        bits: params.bits,
      });
    case 'ngdht11w':
      return new NeuromorphicDHT11W({
        k: params.k,
        alpha: params.alpha,
        bits: params.bits,
      });
    case 'ngdht12w':
      return new NeuromorphicDHT12W({
        k: params.k,
        alpha: params.alpha,
        bits: params.bits,
      });
    case 'ngdht13w':
      return new NeuromorphicDHT13W({
        k: params.k,
        alpha: params.alpha,
        bits: params.bits,
      });
    case 'ngdht15w':
      return new NeuromorphicDHT15W({
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

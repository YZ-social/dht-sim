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
import { GeographicDHT, GeographicDHTa, GeographicDHTb } from './dht/geographic/GeographicDHT.js';
import { NeuromorphicDHT }    from './dht/neuromorphic/NeuromorphicDHT.js';
import { NeuromorphicDHT15W }  from './dht/neuromorphic/NeuromorphicDHT15W.js';
import { NeuromorphicDHTNX1W } from './dht/neuromorphic/NeuromorphicDHTNX1W.js';
import { NeuromorphicDHTNX2W } from './dht/neuromorphic/NeuromorphicDHTNX2W.js';
import { NeuromorphicDHTNX3 }  from './dht/neuromorphic/NeuromorphicDHTNX3.js';
import { NeuromorphicDHTNX4 }  from './dht/neuromorphic/NeuromorphicDHTNX4.js';
import { NeuromorphicDHTNX5 }  from './dht/neuromorphic/NeuromorphicDHTNX5.js';
import { NeuromorphicDHTNX6 }  from './dht/neuromorphic/NeuromorphicDHTNX6.js';
import { NeuromorphicDHTNX7 }  from './dht/neuromorphic/NeuromorphicDHTNX7.js';
import { NeuromorphicDHTNX8 }  from './dht/neuromorphic/NeuromorphicDHTNX8.js';
import { NeuromorphicDHTNX9 }  from './dht/neuromorphic/NeuromorphicDHTNX9.js';
import { NeuromorphicDHTNX10 } from './dht/neuromorphic/NeuromorphicDHTNX10.js';
import { NeuromorphicDHTNX13 } from './dht/neuromorphic/NeuromorphicDHTNX13.js';
import { NeuromorphicDHTNX15 } from './dht/neuromorphic/NeuromorphicDHTNX15.js';
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

/** Max nodes to render on the globe.  Above this the globe is cleared.
 *  Uses InstancedMesh for >10k so 25k is performant. */
const GLOBE_NODE_LIMIT = 25_000;

// ─────────────────────────────────────────────────────────────────────────────
// Module-level state
// ─────────────────────────────────────────────────────────────────────────────

let globe    = null;
let dht      = null;
let engine   = null;
const sweep  = new BenchmarkSweep();

// ─────────────────────────────────────────────────────────────────────────────
// Theme management — follows prefers-color-scheme; manual toggle overrides
// ─────────────────────────────────────────────────────────────────────────────

const _themeQuery = window.matchMedia('(prefers-color-scheme: light)');

function applyTheme(isLight) {
  document.body.classList.toggle('light', isLight);
  globe?.setTheme(isLight);
  const btn = document.getElementById('btnThemeToggle');
  if (btn) btn.textContent = isLight ? '\u2600 Light' : '\u263D Dark';
}

// System preference changes (e.g. Claude Preview panel toggle):
// clear any manual override so the app follows the system going forward.
_themeQuery.addEventListener('change', e => {
  localStorage.removeItem('dht-theme');
  applyTheme(e.matches);
});

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

  // Apply theme before globe starts rendering (localStorage overrides system pref)
  const _savedTheme = localStorage.getItem('dht-theme');
  const _startLight = _savedTheme ? _savedTheme === 'light' : _themeQuery.matches;
  document.body.classList.toggle('light', _startLight);
  const _tb = document.getElementById('btnThemeToggle');
  if (_tb) _tb.textContent = _startLight ? '\u2600 Light' : '\u263D Dark';

  // Initialise Three.js globe
  const canvas = document.getElementById('globeCanvas');
  globe = new Globe(canvas);

  // Globe always uses light-mode colours — call unconditionally.
  globe.setTheme(_startLight);

  // Load countries (TopoJSON via CDN, converted to GeoJSON by topojson-client)
  try {
    const topoData = await fetch(
      'https://cdn.jsdelivr.net/npm/world-atlas@2.0.2/countries-110m.json'
    ).then(r => r.json());

    // topojson-client is loaded as a global <script> tag
    const geoJSON = topojson.feature(topoData, topoData.objects.countries);
    await globe.loadCountries(geoJSON);
    globe.setTheme(_startLight);   // re-apply after texture is built
    controls.setStatus('Ready – configure parameters and click Init Network.', 'info');
  } catch (err) {
    console.error('Failed to load world map:', err);
    controls.setStatus('Map load failed; node placement will be random.', 'warn');
  }

  engine = new SimulationEngine();

  // Wire buttons
  document.getElementById('btnInit')?.addEventListener('click', onInit);
  document.getElementById('btnBootstrap')?.addEventListener('click', onBootstrap);
  document.getElementById('btnLookupTest')?.addEventListener('click', onLookupTest);
  document.getElementById('btnAddNodes')?.addEventListener('click', onAddNodes);
  document.getElementById('btnThemeToggle')?.addEventListener('click', () => {
    const isLight = !document.body.classList.contains('light');
    localStorage.setItem('dht-theme', isLight ? 'light' : 'dark');
    applyTheme(isLight);
  });
  document.getElementById('btnSliceWorld')?.addEventListener('click', onSliceWorld);
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

  dht.buildRoutingTables({
    bidirectional:  params.bidirectional,
    maxConnections: params.webLimit ? 50 : Infinity,
  });

  controls.setProgress(1);
  await yieldUI();  // let GC settle after routing table build before globe work

  // Skip WebGL globe rendering for very large networks.
  // Uses InstancedMesh for >10k nodes; hidden above GLOBE_NODE_LIMIT.
  if (nodes.length <= GLOBE_NODE_LIMIT) {
    globe.setNodes(dht.getNodes());
  } else {
    globe.setNodes([]);  // clear any leftover nodes from a previous smaller run
  }
  controls.setStatus(
    `Network ready: ${nodes.length} nodes, ${params.protocol} ` +
    `(k=${params.k}, α=${params.alpha}, ${params.bits}-bit IDs)` +
    (nodes.length > GLOBE_NODE_LIMIT ? ' — globe hidden for large network' : ''),
    'success'
  );
  controls.updateNodeCount(nodes.length);
  controls.setRunning(false);
  controls.setProgress(0);
  sweep.notifyInitComplete();
}

// ─────────────────────────────────────────────────────────────────────────────
// Slice World — East/West hemisphere partition with Hawaii bridge
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Prune cross-hemisphere connections from every node's routing table,
 * leaving Hawaii as the sole bridge between Eastern and Western hemispheres.
 *
 * Hemisphere rule: Western = lng < 0, Eastern = lng >= 0.
 * Hawaii (hawaiiId) is exempt — keeps all connections to both hemispheres.
 */
function pruneSliceWorld(dhtRef, hawaiiId) {
  const isWestern = (node) => node.lng < 0;

  for (const node of dhtRef.nodeMap.values()) {
    if (!node.alive || node.id === hawaiiId) continue;
    const nodeWest = isWestern(node);

    if (node.synaptome) {
      // ── NeuronNode (neuromorphic protocols) ──
      for (const [peerId] of node.synaptome) {
        if (peerId === hawaiiId) continue;
        const peer = dhtRef.nodeMap.get(peerId);
        if (peer && isWestern(peer) !== nodeWest) {
          node.synaptome.delete(peerId);
        }
      }
      if (node.highway) {
        for (const [peerId] of node.highway) {
          if (peerId === hawaiiId) continue;
          const peer = dhtRef.nodeMap.get(peerId);
          if (peer && isWestern(peer) !== nodeWest) {
            node.highway.delete(peerId);
          }
        }
      }
      for (const [peerId] of node.incomingSynapses) {
        if (peerId === hawaiiId) continue;
        const peer = dhtRef.nodeMap.get(peerId);
        if (peer && isWestern(peer) !== nodeWest) {
          node.incomingSynapses.delete(peerId);
        }
      }
    } else if (node.buckets) {
      // ── KademliaNode (Kademlia / G-DHT) ──
      for (const bucket of node.buckets) {
        bucket.nodes = bucket.nodes.filter(peer =>
          peer.id === hawaiiId || isWestern(peer) === nodeWest
        );
      }
      node._totalConns = node.buckets.reduce((s, b) => s + b.size, 0);
      // Clean incoming peers (reverse connections)
      if (node.incomingPeers) {
        for (const [peerId, peer] of node.incomingPeers) {
          if (peerId === hawaiiId) continue;
          if (isWestern(peer) !== nodeWest) node.incomingPeers.delete(peerId);
        }
      }
    }
  }
}

async function onSliceWorld() {
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
  controls.setStatus(`Building Slice World: ${params.nodeCount}-node ${params.protocol} network…`, 'info');

  const { maxPropagation } = getLatencyParams();
  setLatencyParams(maxPropagation, params.nodeDelay);

  if (dht) {
    dht.dispose();
    dht = null;
    await yieldUI();
  }

  dht = createDHT(params);

  // ── Place Hawaii node first (the sole bridge) ──────────────────────────────
  const hawaiiNode = await dht.addNode(19.82, -155.47);
  const hawaiiId   = hawaiiNode.id;

  // ── Generate remaining nodes on land ───────────────────────────────────────
  const nodes = [hawaiiNode];
  for (let i = 1; i < params.nodeCount; i++) {
    const { lat, lng } = globe.randomLandPoint();
    const node = await dht.addNode(lat, lng);
    nodes.push(node);

    if ((i + 1) % 50 === 0) {
      controls.setProgress((i + 1) / params.nodeCount * 0.6);
      await yieldUI();
    }
  }

  controls.setStatus('Building routing tables…', 'info');
  controls.setProgress(0.7);
  await yieldUI();

  // ── Build full routing tables, then prune cross-hemisphere links ───────────
  dht.buildRoutingTables({
    bidirectional:  params.bidirectional,
    maxConnections: params.webLimit ? 50 : Infinity,
  });

  controls.setStatus('Pruning cross-hemisphere connections (Hawaii bridge only)…', 'info');
  controls.setProgress(0.85);
  await yieldUI();

  pruneSliceWorld(dht, hawaiiId);

  controls.setProgress(1);
  await yieldUI();

  // ── Count hemisphere stats ─────────────────────────────────────────────────
  let westCount = 0, eastCount = 0;
  for (const n of nodes) {
    if (n.lng < 0) westCount++; else eastCount++;
  }

  if (nodes.length <= GLOBE_NODE_LIMIT) {
    globe.setNodes(dht.getNodes());
  } else {
    globe.setNodes([]);
  }

  controls.setStatus(
    `Slice World ready: ${nodes.length} nodes (${westCount} West, ${eastCount} East), ` +
    `Hawaii bridge, ${params.protocol}`,
    'success'
  );
  controls.updateNodeCount(nodes.length);
  controls.setRunning(false);
  controls.setProgress(0);
  sweep.notifyInitComplete();
}

// ─────────────────────────────────────────────────────────────────────────────
// Bootstrap Network — build incrementally via sponsor-based join
// ─────────────────────────────────────────────────────────────────────────────

async function onBootstrap() {
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
  controls.setStatus(
    `Bootstrapping ${params.nodeCount}-node ${params.protocol} network…`, 'info'
  );

  const { maxPropagation } = getLatencyParams();
  setLatencyParams(maxPropagation, params.nodeDelay);

  // Dispose previous DHT
  if (dht) {
    dht.dispose();
    dht = null;
    await yieldUI();
  }

  dht = createDHT(params);

  // Build incrementally: first node has no peers, each subsequent node
  // joins through the live network via a sponsor.
  const nodes = [];
  for (let i = 0; i < params.nodeCount; i++) {
    const { lat, lng } = globe.randomLandPoint();
    const node = await dht.addNode(lat, lng);
    nodes.push(node);

    // Every node after the first joins via sponsor
    if (i > 0) {
      const sponsor = findSponsor(dht, node);
      if (sponsor && dht.bootstrapJoin) {
        dht.bootstrapJoin(node.id, sponsor.id);
      }
    }

    if ((i + 1) % 50 === 0) {
      controls.setProgress((i + 1) / params.nodeCount * 0.8);
      await yieldUI();
    }
  }

  // Refresh phase — early joiners have sparse tables because few peers existed
  // when they joined.  A single self-lookup per node (as real Kademlia does
  // periodically) lets every node discover the full set of peers now available.
  controls.setStatus('Refreshing routing tables…', 'info');
  controls.setProgress(0.85);
  await yieldUI();

  if (dht.bootstrapJoin) {
    const allIds = [...dht.nodeMap.keys()];
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      // Pick a random existing node as refresh sponsor (not self)
      let sponsorId = node.id;
      while (sponsorId === node.id) {
        sponsorId = allIds[Math.floor(Math.random() * allIds.length)];
      }
      dht.bootstrapJoin(node.id, sponsorId);

      if ((i + 1) % 100 === 0) {
        controls.setProgress(0.85 + (i + 1) / nodes.length * 0.15);
        await yieldUI();
      }
    }
  }

  controls.setProgress(1);
  await yieldUI();

  if (nodes.length <= GLOBE_NODE_LIMIT) {
    globe.setNodes(dht.getNodes());
  } else {
    globe.setNodes([]);
  }
  controls.setStatus(
    `Network bootstrapped: ${nodes.length} nodes, ${params.protocol} ` +
    `(k=${params.k}, α=${params.alpha}, ${params.bits}-bit IDs)` +
    (nodes.length > GLOBE_NODE_LIMIT ? ' — globe hidden for large network' : ''),
    'success'
  );
  controls.updateNodeCount(nodes.length);
  controls.setRunning(false);
  controls.setProgress(0);
  sweep.notifyInitComplete();
}

// ─────────────────────────────────────────────────────────────────────────────
// Add Nodes — organic join via sponsor
// ─────────────────────────────────────────────────────────────────────────────

/** Find the existing alive node with the smallest XOR distance to newNode. */
function findSponsor(dht, newNode) {
  if (!dht.nodeMap) return null;
  let best = null, bestDist = null;
  for (const [id, node] of dht.nodeMap) {
    if (id === newNode.id || !node.alive) continue;
    const dist = newNode.id ^ id;
    if (bestDist === null || dist < bestDist) { best = node; bestDist = dist; }
  }
  return best;
}

async function onAddNodes() {
  if (!dht) {
    controls.setStatus('Initialise the network first.', 'warn');
    return;
  }
  controls.setRunning(true);
  controls.setProgress(0);

  const params   = controls.snapshot();
  const count    = params.addNodeCount;
  const warmup   = params.addNodeWarmup;
  const newNodes = [];

  controls.setStatus(
    `Adding ${count} node${count > 1 ? 's' : ''} via organic join…`, 'info'
  );

  // Phase 1 — create and sponsor-join each node
  for (let i = 0; i < count; i++) {
    const { lat, lng } = globe.randomLandPoint();
    const newNode = await dht.addNode(lat, lng);
    newNodes.push(newNode);

    const sponsor = findSponsor(dht, newNode);
    if (sponsor && dht.bootstrapJoin) {
      dht.bootstrapJoin(newNode.id, sponsor.id);
    }

    controls.setProgress((i + 1) / count * (warmup > 0 ? 0.4 : 1.0));
    if ((i + 1) % 10 === 0) await yieldUI();
  }

  // Phase 2 — warmup lookups from each new node to integrate via LTP / annealing
  if (warmup > 0 && newNodes.length > 0) {
    const allIds = dht.nodeMap
      ? [...dht.nodeMap.keys()]
      : dht.getNodes().map(n => n.id);
    let done = 0;
    const totalWarmup = newNodes.length * warmup;
    for (const newNode of newNodes) {
      for (let w = 0; w < warmup; w++) {
        const targetId = allIds[Math.floor(Math.random() * allIds.length)];
        if (targetId !== newNode.id) await dht.lookup(newNode.id, targetId);
        controls.setProgress(0.4 + (++done / totalWarmup) * 0.6);
        if (done % 25 === 0) await yieldUI();
      }
    }
  }

  const allNodes = dht.getNodes();
  const total = dht.nodeMap?.size ?? allNodes.length;
  if (total <= GLOBE_NODE_LIMIT) {
    globe.setNodes(allNodes);
  } else {
    globe.setNodes([]);
  }
  controls.updateNodeCount(total);
  controls.setStatus(
    `Added ${count} node${count > 1 ? 's' : ''} — network now has ${total} active nodes.`,
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
      // Pick a random live node as the target (not the source).
      // Using a real node ID ensures the lookup has a meaningful destination
      // and the path animation terminates at an actual node on the globe.
      let target = source;
      while (target.id === source.id) {
        target = nodes[Math.floor(Math.random() * nodes.length)];
      }
      result = await dht.lookup(source.id, target.id);
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
  controls.updateNodeCount(dht.nodeMap?.size ?? dht.getNodes().length);
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
      maxFanout:      result.maxFanout,
      treeDepth:      result.treeDepth,
      avgSubsPerNode: result.avgSubsPerNode,
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
    { key: 'geo',      label: `G-DHT-${params.geoBits}` },
    { key: 'geoa',     label: 'G-DHT-a' },
    { key: 'geob',     label: 'G-DHT-b' },
    // Neuromorphic protocols need a warmup burst so synaptic shortcuts form
    // before measurement.  Without warmup their weights are identical to G-DHT.
    { key: 'ngdht',     label: 'N-1',     warmupLookups: Math.max(params.benchWarmupSessions, Math.round(4 * params.nodeCount / 10000)) * 500, warmupHotPct: 10, warmupRadius: 2000 },
    { key: 'ngdht15w',  label: 'N-15W',   warmupLookups: Math.max(params.benchWarmupSessions, Math.round(4 * params.nodeCount / 10000)) * 500, warmupHotPct: 10, warmupRadius: 2000 },
    { key: 'ngdhtnx1w', label: 'NX-1W',   warmupLookups: Math.max(params.benchWarmupSessions, Math.round(4 * params.nodeCount / 10000)) * 500, warmupHotPct: 10, warmupRadius: 2000 },
    { key: 'ngdhtnx2w', label: 'NX-2W',   warmupLookups: Math.max(params.benchWarmupSessions, Math.round(4 * params.nodeCount / 10000)) * 500, warmupHotPct: 10, warmupRadius: 2000 },
    { key: 'ngdhtnx3',  label: 'NX-3',    warmupLookups: Math.max(params.benchWarmupSessions, Math.round(4 * params.nodeCount / 10000)) * 500, warmupHotPct: 10, warmupRadius: 2000 },
    { key: 'ngdhtnx4',  label: 'NX-4',    warmupLookups: Math.max(params.benchWarmupSessions, Math.round(4 * params.nodeCount / 10000)) * 500, warmupHotPct: 10, warmupRadius: 2000 },
    { key: 'ngdhtnx5',  label: 'NX-5',    warmupLookups: Math.max(params.benchWarmupSessions, Math.round(4 * params.nodeCount / 10000)) * 500, warmupHotPct: 10, warmupRadius: 2000, warmupGlobalLookups: Math.max(params.benchWarmupSessions, Math.round(4 * params.nodeCount / 10000)) * 250 },
    { key: 'ngdhtnx6',  label: 'NX-6',    warmupLookups: Math.max(params.benchWarmupSessions, Math.round(4 * params.nodeCount / 10000)) * 500, warmupHotPct: 10, warmupRadius: 2000, warmupGlobalLookups: Math.max(params.benchWarmupSessions, Math.round(4 * params.nodeCount / 10000)) * 250 },
    { key: 'ngdhtnx7',  label: 'NX-7',    warmupLookups: Math.max(params.benchWarmupSessions, Math.round(4 * params.nodeCount / 10000)) * 500, warmupHotPct: 10, warmupRadius: 2000, warmupGlobalLookups: Math.max(params.benchWarmupSessions, Math.round(4 * params.nodeCount / 10000)) * 250 },
    { key: 'ngdhtnx8',  label: 'NX-8',    warmupLookups: Math.max(params.benchWarmupSessions, Math.round(4 * params.nodeCount / 10000)) * 500, warmupHotPct: 10, warmupRadius: 2000, warmupGlobalLookups: Math.max(params.benchWarmupSessions, Math.round(4 * params.nodeCount / 10000)) * 250 },
    { key: 'ngdhtnx9',  label: 'NX-9',    warmupLookups: Math.max(params.benchWarmupSessions, Math.round(4 * params.nodeCount / 10000)) * 500, warmupHotPct: 10, warmupRadius: 2000, warmupGlobalLookups: Math.max(params.benchWarmupSessions, Math.round(4 * params.nodeCount / 10000)) * 250 },
    { key: 'ngdhtnx10', label: 'NX-10',   warmupLookups: Math.max(params.benchWarmupSessions, Math.round(4 * params.nodeCount / 10000)) * 500, warmupHotPct: 10, warmupRadius: 2000, warmupGlobalLookups: Math.max(params.benchWarmupSessions, Math.round(4 * params.nodeCount / 10000)) * 250 },
    { key: 'ngdhtnx13', label: 'NX-13',  warmupLookups: Math.max(params.benchWarmupSessions, Math.round(4 * params.nodeCount / 10000)) * 500, warmupHotPct: 10, warmupRadius: 2000, warmupGlobalLookups: Math.max(params.benchWarmupSessions, Math.round(4 * params.nodeCount / 10000)) * 250 },
    { key: 'ngdhtnx15', label: 'NX-15',  warmupLookups: Math.max(params.benchWarmupSessions, Math.round(4 * params.nodeCount / 10000)) * 500, warmupHotPct: 10, warmupRadius: 2000, warmupGlobalLookups: Math.max(params.benchWarmupSessions, Math.round(4 * params.nodeCount / 10000)) * 250 },
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
    { key: 'pubsubm',   type: 'pubsubm',  groupSize: params.pubsubGroupSize, coverage: params.pubsubCoverage },
    { key: 'pubsubmchurn', type: 'pubsubmchurn', groupSize: params.pubsubGroupSize, coverage: params.pubsubCoverage, rate: params.benchChurnPct },
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

      if (params.benchBootstrap && benchDHT.bootstrapJoin) {
        // Propagate connection cap + bidirectional flag (normally done by
        // buildRoutingTables, which the bootstrap path skips).
        const maxConn = params.webLimit ? 50 : Infinity;
        benchDHT.maxConnections = maxConn;
        benchDHT.bidirectional  = params.bidirectional;
        // Propagate cap to all existing nodes so addToBucket enforces it
        for (const node of benchDHT.nodeMap.values()) {
          if (node.maxConnections !== undefined) node.maxConnections = maxConn;
        }

        // Bootstrapped init: each node joins via sponsor + refresh pass
        controls.setStatus(`${tag} — bootstrap joining…`, 'bench');
        const allNodes = [...benchDHT.nodeMap.values()];
        for (let i = 1; i < allNodes.length; i++) {
          if (!benchmarkActive) return null;
          const sponsor = findSponsor(benchDHT, allNodes[i]);
          if (sponsor) benchDHT.bootstrapJoin(allNodes[i].id, sponsor.id);
          if ((i + 1) % 100 === 0) {
            controls.setProgress(stepFrac(completedSteps, (0.8 + (i + 1) / allNodes.length * 0.1)));
            await yieldUI();
          }
        }
        // Refresh pass — early joiners had sparse tables
        controls.setStatus(`${tag} — refreshing routing tables…`, 'bench');
        const allIds = [...benchDHT.nodeMap.keys()];
        for (let i = 0; i < allNodes.length; i++) {
          if (!benchmarkActive) return null;
          let sponsorId = allNodes[i].id;
          while (sponsorId === allNodes[i].id) {
            sponsorId = allIds[Math.floor(Math.random() * allIds.length)];
          }
          benchDHT.bootstrapJoin(allNodes[i].id, sponsorId);
          if ((i + 1) % 100 === 0) {
            controls.setProgress(stepFrac(completedSteps, (0.9 + (i + 1) / allNodes.length * 0.1)));
            await yieldUI();
          }
        }
      } else {
        // Bulk routing-table construction (default)
        controls.setStatus(`${tag} — building routing tables…`, 'bench');
        benchDHT.buildRoutingTables({
          bidirectional:  params.bidirectional,
          maxConnections: params.webLimit ? 50 : Infinity,
        });
      }
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
    case 'geo':
      return new GeographicDHT({
        k: params.k,
        alpha: params.alpha,
        bits: params.bits,
        geoBits: params.geoBits ?? 8,
      });
    case 'geoa':
      return new GeographicDHTa({
        k: params.k,
        alpha: params.alpha,
        bits: params.bits,
        geoBits: params.geoBits ?? 8,
      });
    case 'geob':
      return new GeographicDHTb({
        k: params.k,
        alpha: params.alpha,
        bits: params.bits,
        geoBits: params.geoBits ?? 8,
      });
    case 'ngdht':
      return new NeuromorphicDHT({
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
    case 'ngdhtnx1w':
      return new NeuromorphicDHTNX1W({
        k: params.k,
        alpha: params.alpha,
        bits: params.bits,
        geoBits: params.geoBits,
        rules: params.nx1wRules,
      });
    case 'ngdhtnx2w':
      return new NeuromorphicDHTNX2W({
        k: params.k,
        alpha: params.alpha,
        bits: params.bits,
        geoBits: params.geoBits,
        rules: params.nx2wRules,
      });
    case 'ngdhtnx3':
      return new NeuromorphicDHTNX3({
        k: params.k,
        alpha: params.alpha,
        bits: params.bits,
        geoBits: params.geoBits,
        rules: params.nx1wRules,
      });
    case 'ngdhtnx4':
      return new NeuromorphicDHTNX4({
        k: params.k,
        alpha: params.alpha,
        bits: params.bits,
        geoBits: params.geoBits,
        rules: params.nx1wRules,
      });
    case 'ngdhtnx5':
      return new NeuromorphicDHTNX5({
        k: params.k,
        alpha: params.alpha,
        bits: params.bits,
        geoBits: params.geoBits,
        rules: params.nx1wRules,
      });
    case 'ngdhtnx6':
      return new NeuromorphicDHTNX6({
        k: params.k,
        alpha: params.alpha,
        bits: params.bits,
        geoBits: params.geoBits,
        rules: params.nx1wRules,
      });
    case 'ngdhtnx7':
      return new NeuromorphicDHTNX7({
        k: params.k,
        alpha: params.alpha,
        bits: params.bits,
        geoBits: params.geoBits,
        rules: params.nx1wRules,
      });
    case 'ngdhtnx8':
      return new NeuromorphicDHTNX8({
        k: params.k,
        alpha: params.alpha,
        bits: params.bits,
        geoBits: params.geoBits,
        rules: params.nx1wRules,
      });
    case 'ngdhtnx9':
      return new NeuromorphicDHTNX9({
        k: params.k,
        alpha: params.alpha,
        bits: params.bits,
        geoBits: params.geoBits,
        rules: params.nx1wRules,
      });
    case 'ngdhtnx10':
      return new NeuromorphicDHTNX10({
        k: params.k,
        alpha: params.alpha,
        bits: params.bits,
        geoBits: params.geoBits,
        rules: params.nx1wRules,
      });
    case 'ngdhtnx13':
      return new NeuromorphicDHTNX13({
        k: params.k,
        alpha: params.alpha,
        bits: params.bits,
        geoBits: params.geoBits,
        rules: params.nx13Rules,
      });
    case 'ngdhtnx15':
      return new NeuromorphicDHTNX15({
        k: params.k,
        alpha: params.alpha,
        bits: params.bits,
        geoBits: params.geoBits,
        rules: params.nx1wRules,
        membership: params.nx15Params,   // UI-tunable pub/sub membership params
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

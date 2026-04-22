/**
 * smoke_nx16.js — minimal verification that NX-16's masked-distance
 * findKClosest actually spreads replicas across S2 cells.
 *
 *   node src/pubsub/smoke_nx16.js
 */

import { NeuromorphicDHTNX15 } from '../dht/neuromorphic/NeuromorphicDHTNX15.js';
import { NeuromorphicDHTNX16 } from '../dht/neuromorphic/NeuromorphicDHTNX16.js';

const NODES = 2000;
const TOPICS = 30;
const K = 20;
const GEO_BITS = 8;

function buildDht(Klass, seed = 42) {
  const dht = new Klass({ k: 20, alpha: 3, bits: 64, geoBits: GEO_BITS });
  let s = seed;
  const rand = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  for (let i = 0; i < NODES; i++) {
    const lat = -60 + rand() * 120;
    const lng = -180 + rand() * 360;
    dht.addNode(lat, lng);
  }
  return dht;
}

function cellOf(id) {
  // Top GEO_BITS = S2 cell
  return (BigInt(id) >> BigInt(64 - GEO_BITS)) & ((1n << BigInt(GEO_BITS)) - 1n);
}

function bigIntFromHex(h) { return BigInt('0x' + h); }

async function analyze(Klass, label) {
  console.log(`\n── ${label} (${NODES} nodes, K=${K}, geoBits=${GEO_BITS}) ──`);
  const dht = buildDht(Klass);
  await dht.buildRoutingTables({ bidirectional: true, maxConnections: 50 });

  const aliveNodes = dht.getNodes().filter(n => n.alive);
  const src = aliveNodes[0];

  const cellSpreadSamples = [];
  for (let t = 0; t < TOPICS; t++) {
    // Synthesize a random 16-char hex topic ID.
    let hex = '';
    for (let i = 0; i < 16; i++) hex += '0123456789abcdef'[Math.floor(Math.random()*16)];
    const K_closest = dht.findKClosest(src, hex, K);
    const cells = new Set(K_closest.map(n => cellOf(n.id)));
    cellSpreadSamples.push(cells.size);
  }

  const avgCells = cellSpreadSamples.reduce((a,b)=>a+b,0) / cellSpreadSamples.length;
  const min = Math.min(...cellSpreadSamples);
  const max = Math.max(...cellSpreadSamples);
  console.log(`  Average distinct S2 cells in K=${K} replicas: ${avgCells.toFixed(2)} (min ${min}, max ${max})`);
  console.log(`  Expected for uniform spread:               ~${Math.min(K, 256)} cells`);
  console.log(`  Expected for NX-15 cell-clustering:        ~1-3 cells`);
}

(async () => {
  await analyze(NeuromorphicDHTNX15, 'NX-15 (cell-concentrated replicas)');
  await analyze(NeuromorphicDHTNX16, 'NX-16 (cell-spread replicas)');
})();

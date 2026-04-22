/**
 * smoke_findK_perf.js — measure findKClosest latency and pool-growth
 * profile for NX-15 vs NX-16, to diagnose the slowdown reported in the
 * 25K-node benchmark.
 *
 *   node src/pubsub/smoke_findK_perf.js
 */

import { NeuromorphicDHTNX15 } from '../dht/neuromorphic/NeuromorphicDHTNX15.js';
import { NeuromorphicDHTNX16 } from '../dht/neuromorphic/NeuromorphicDHTNX16.js';

const NODES = Number(process.argv[2]) || 10000;
const CALLS = 200;
const K = 5;
const GEO_BITS = 8;

async function build(Klass) {
  const dht = new Klass({ k: 20, alpha: 3, bits: 64, geoBits: GEO_BITS });
  let s = 42;
  const rand = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  for (let i = 0; i < NODES; i++) {
    const lat = -60 + rand() * 120;
    const lng = -180 + rand() * 360;
    await dht.addNode(lat, lng);
  }
  await dht.buildRoutingTables({ bidirectional: true, maxConnections: 50 });
  return dht;
}

async function measure(Klass, label) {
  console.log(`\n── ${label} (${NODES} nodes, K=${K}) ──`);
  const t0 = Date.now();
  const dht = await build(Klass);
  console.log(`  built in ${((Date.now()-t0)/1000).toFixed(1)}s`);
  const alive = dht.getNodes().filter(n => n.alive);
  const src = alive[0];

  // Warm up the JIT + synaptome LTP a bit so numbers are representative.
  for (let i = 0; i < 50; i++) {
    let hex = ''; for (let j = 0; j < 16; j++) hex += '0123456789abcdef'[Math.floor(Math.random()*16)];
    dht.findKClosest(src, hex, K);
  }

  const t1 = Date.now();
  let poolTotal = 0;
  for (let i = 0; i < CALLS; i++) {
    let hex = ''; for (let j = 0; j < 16; j++) hex += '0123456789abcdef'[Math.floor(Math.random()*16)];
    // Patch candidates map to count final size — lightweight instrumentation.
    const result = dht.findKClosest(src, hex, K);
    poolTotal += result.length;
  }
  const elapsed = Date.now() - t1;
  console.log(`  ${CALLS} findKClosest calls: ${elapsed}ms total, ${(elapsed/CALLS).toFixed(2)}ms/call`);
}

(async () => {
  await measure(NeuromorphicDHTNX15, 'NX-15 (full-bit XOR)');
  await measure(NeuromorphicDHTNX16, 'NX-16 (masked XOR)');
})();

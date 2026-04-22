/**
 * smoke_nx16_lookup.js — verify NX-16 behaves IDENTICALLY to NX-15 on the
 * regular `lookup()` path (non-pub/sub). NA→AS hangs reported by the user
 * would be caught here if the override somehow affected ordinary lookup.
 *
 *   node src/pubsub/smoke_nx16_lookup.js
 */

import { NeuromorphicDHTNX15 } from '../dht/neuromorphic/NeuromorphicDHTNX15.js';
import { NeuromorphicDHTNX16 } from '../dht/neuromorphic/NeuromorphicDHTNX16.js';
import { continentOf } from '../utils/geo.js';

const NODES = 1500;
const LOOKUPS = 100;
const GEO_BITS = 8;

async function build(Klass, seed) {
  const dht = new Klass({ k: 20, alpha: 3, bits: 64, geoBits: GEO_BITS });
  let s = seed;
  const rand = () => { s = (s * 1103515245 + 12345) & 0x7fffffff; return s / 0x7fffffff; };
  for (let i = 0; i < NODES; i++) {
    const lat = -60 + rand() * 120;
    const lng = -180 + rand() * 360;
    await dht.addNode(lat, lng);
  }
  await dht.buildRoutingTables({ bidirectional: true, maxConnections: 50 });
  return { dht, rand };
}

async function timeNAAS(Klass, label) {
  const t0 = Date.now();
  console.log(`\n── ${label} ──`);
  const { dht } = await build(Klass, 12345);
  console.log(`  built in ${((Date.now()-t0)/1000).toFixed(1)}s`);

  const alive = dht.getNodes().filter(n => n.alive);
  const NA = alive.filter(n => continentOf(n.lat, n.lng) === 'NA');
  const AS = alive.filter(n => continentOf(n.lat, n.lng) === 'AS');
  console.log(`  NA=${NA.length}  AS=${AS.length}`);
  if (NA.length === 0 || AS.length === 0) { console.log('  insufficient continental nodes'); return; }

  const t1 = Date.now();
  let totalHops = 0, successes = 0;
  for (let i = 0; i < LOOKUPS; i++) {
    const src = NA[Math.floor(Math.random() * NA.length)];
    const dst = AS[Math.floor(Math.random() * AS.length)];
    const r = await dht.lookup(src.id, dst.id);
    if (r?.found) { successes++; totalHops += r.hops; }
  }
  const elapsed = Date.now() - t1;
  console.log(`  ${LOOKUPS} NA→AS lookups: ${successes}/${LOOKUPS} success, avg ${(totalHops/Math.max(1,successes)).toFixed(2)} hops, ${elapsed}ms total (${(elapsed/LOOKUPS).toFixed(1)}ms/lookup)`);
}

(async () => {
  await timeNAAS(NeuromorphicDHTNX15, 'NX-15 (baseline)');
  await timeNAAS(NeuromorphicDHTNX16, 'NX-16 (masked findKClosest)');
})();

// Geographic utilities for the DHT simulator
// All distances in km, times in ms

export const EARTH_RADIUS_KM = 6371;

// Antipodal distance = half the great circle circumference
export const MAX_GREAT_CIRCLE_KM = Math.PI * EARTH_RADIUS_KM; // ~20,015 km

// Propagation delay constants (configurable via setLatencyParams)
let MAX_PROPAGATION_MS = 300;  // ms for antipodal nodes
let HOP_COST_MS = 10;          // ms processing overhead per one-way message

export function setLatencyParams(maxProp, hopCost) {
  MAX_PROPAGATION_MS = maxProp;
  HOP_COST_MS = hopCost;
}

export function getLatencyParams() {
  return { maxPropagation: MAX_PROPAGATION_MS, hopCost: HOP_COST_MS };
}

/**
 * Haversine great-circle distance between two lat/lng points.
 * @returns {number} Distance in km
 */
export function haversine(lat1, lng1, lat2, lng2) {
  const toRad = x => x * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return EARTH_RADIUS_KM * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * One-way propagation delay based on great-circle distance.
 * Antipodal nodes (max distance) → MAX_PROPAGATION_MS.
 * @returns {number} Propagation delay in ms
 */
export function propagationDelay(node1, node2) {
  const dist = haversine(node1.lat, node1.lng, node2.lat, node2.lng);
  return (dist / MAX_GREAT_CIRCLE_KM) * MAX_PROPAGATION_MS;
}

/**
 * Total one-way message latency: propagation + hop processing cost.
 */
export function messageLatency(node1, node2) {
  return propagationDelay(node1, node2) + HOP_COST_MS;
}

/**
 * Round-trip latency (send + receive) between two nodes.
 */
export function roundTripLatency(node1, node2) {
  return 2 * messageLatency(node1, node2);
}

/**
 * Convert lat/lng to Three.js-compatible XYZ on a unit sphere.
 * Convention: Y-up, north pole at (0,1,0).
 */
export function latLngToXYZ(lat, lng, radius = 1) {
  const phi = (90 - lat) * Math.PI / 180;   // polar angle from north pole
  const theta = (lng + 180) * Math.PI / 180; // azimuthal angle
  return {
    x: -radius * Math.sin(phi) * Math.cos(theta),
    y:  radius * Math.cos(phi),
    z:  radius * Math.sin(phi) * Math.sin(theta),
  };
}

/**
 * Convert a unit XYZ vector back to lat/lng.
 */
export function xyzToLatLng(x, y, z) {
  const lat = 90 - Math.acos(Math.max(-1, Math.min(1, y))) * 180 / Math.PI;
  const lng = Math.atan2(z, -x) * 180 / Math.PI - 180;
  return { lat, lng: ((lng + 540) % 360) - 180 };
}

/**
 * Generate a cryptographically random 32-bit unsigned integer.
 */
export function randomU32() {
  return crypto.getRandomValues(new Uint32Array(1))[0];
}

/**
 * O(n log n) XOR-bucket routing table builder.
 *
 * Given all nodes pre-sorted ascending by .id (unsigned 32-bit), returns up
 * to k peers per XOR-distance bucket for the node with the given selfId.
 * Replaces the O(n²) double-loop in buildRoutingTables().
 *
 * Algorithm: for Kademlia bucket b (0 = LSB bucket, 31 = MSB bucket), the
 * peer IDs that belong to bucket b form a contiguous range in the sorted ID
 * array — their top (32-b) bits match selfId except that bit b is flipped.
 * Binary search locates that range in O(log n); we take the first k entries.
 *
 * @param {number}   selfId  32-bit unsigned node ID.
 * @param {object[]} sorted  Nodes sorted ascending by .id (all nodes incl. self).
 * @param {number}   k       Max peers per bucket.
 * @returns {object[]}       Peer nodes to add (never includes selfId).
 */
export function buildXorRoutingTable(selfId, sorted, k) {
  const result = [];

  for (let b = 0; b <= 31; b++) {
    let rangeStart, rangeEnd;

    if (b < 31) {
      // Top (31-b) bits of peer match selfId; bit b is flipped; lower b bits = any.
      const highBits    = selfId >>> (b + 1);
      const flippedBitB = ((selfId >>> b) & 1) ^ 1;
      const peerPfx     = ((highBits << 1) | flippedBitB) >>> 0;
      rangeStart        = (peerPfx << b) >>> 0;
      rangeEnd          = (rangeStart | ((1 << b) - 1)) >>> 0;
    } else {
      // b = 31: MSB differs — peers live in the opposite half of the ID space.
      rangeStart = (selfId >>> 31) === 0 ? 0x80000000 : 0;
      rangeEnd   = (selfId >>> 31) === 0 ? 0xFFFFFFFF : 0x7FFFFFFF;
    }

    // Binary search for the first index ≥ rangeStart.
    let lo = 0, hi = sorted.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      if (sorted[mid].id < rangeStart) lo = mid + 1; else hi = mid;
    }

    // Collect up to k peers from [rangeStart, rangeEnd].
    // selfId is never in any bucket range (XOR with self = 0 has no bucket).
    let taken = 0;
    for (let i = lo; i < sorted.length && taken < k; i++) {
      if (sorted[i].id > rangeEnd) break;
      result.push(sorted[i]);
      taken++;
    }
  }

  return result;
}

// ── Continent classification ──────────────────────────────────────────────

/**
 * Bounding-box continent classification.
 * Order matters: OC before AS so Australia/NZ nodes aren't absorbed by Asia.
 */
const CONTINENT_BOXES = [
  { id: 'NA', minLat: 15,  maxLat: 85,  minLng: -170, maxLng: -50  },
  { id: 'SA', minLat: -60, maxLat: 15,  minLng: -90,  maxLng: -30  },
  { id: 'EU', minLat: 35,  maxLat: 72,  minLng: -25,  maxLng: 45   },
  { id: 'AF', minLat: -40, maxLat: 40,  minLng: -20,  maxLng: 55   },
  { id: 'OC', minLat: -50, maxLat: 10,  minLng: 110,  maxLng: 180  },
  { id: 'AS', minLat: 5,   maxLat: 80,  minLng: 45,   maxLng: 180  },
];

export const CONTINENT_NAMES = {
  NA: 'N.Am.', SA: 'S.Am.', EU: 'Europe',
  AF: 'Africa', AS: 'Asia',  OC: 'Oceania',
};

/**
 * Return the continent code ('NA', 'SA', 'EU', 'AF', 'AS', 'OC') for a
 * lat/lng point, or null if unclassified (open ocean, polar regions).
 */
export function continentOf(lat, lng) {
  for (const b of CONTINENT_BOXES) {
    if (lat >= b.minLat && lat <= b.maxLat &&
        lng >= b.minLng && lng <= b.maxLng) return b.id;
  }
  return null;
}

/**
 * Compute statistics over an array of numbers.
 */
export function computeStats(values) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const n = sorted.length;
  const sum = sorted.reduce((a, b) => a + b, 0);
  return {
    count: n,
    mean: sum / n,
    median: sorted[Math.floor(n / 2)],
    p25: sorted[Math.floor(n * 0.25)],
    p75: sorted[Math.floor(n * 0.75)],
    p95: sorted[Math.floor(n * 0.95)],
    p99: sorted[Math.floor(n * 0.99)],
    min: sorted[0],
    max: sorted[n - 1],
  };
}

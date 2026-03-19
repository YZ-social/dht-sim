/**
 * GeographicDHT – a Kademlia variant where node IDs are derived from
 * physical location.
 *
 * Standard Kademlia assigns each node a random ID drawn uniformly from the
 * key space, so XOR distances carry no geographic meaning.
 *
 * GeographicDHT instead assigns IDs whose high-order bits encode the node's
 * S2-like geographic cell (via a Hilbert-curve mapping of lat/lng).  The
 * remaining lower bits are random to guarantee uniqueness within a cell.
 *
 *   Node ID layout  (32 bits total, geoBits = 8 example):
 *   ┌─────────────────────────┬────────────────────────────────┐
 *   │  geographic prefix      │  random suffix                 │
 *   │  (top geoBits bits)     │  (bottom 32-geoBits bits)      │
 *   │  8 bits → 256 geo cells │  24 bits → ~16 M unique IDs    │
 *   └─────────────────────────┴────────────────────────────────┘
 *
 * Consequence for routing:
 *   • Nodes in the same geographic cell share the same high-order bits.
 *   • XOR distance between two nodes is small when they are nearby.
 *   • Iterative FIND_NODE lookups tend to traverse geographically coherent
 *     paths, reducing propagation latency compared to random-ID Kademlia.
 *
 * Everything else (k-buckets, α-parallel lookup, termination) is unchanged.
 */

import { KademliaDHT, KademliaNode } from '../kademlia/KademliaDHT.js';
import { randomU32 }                  from '../../utils/geo.js';
import { geoCellId }                  from '../../utils/s2.js';

export class GeographicDHT extends KademliaDHT {
  /**
   * @param {object} config
   * @param {number} config.geoBits  – geographic prefix width in bits (default 8)
   * @param {number} config.k        – k-bucket size (default 20)
   * @param {number} config.alpha    – lookup parallelism (default 3)
   * @param {number} config.bits     – total key-space width (default 32)
   */
  constructor(config = {}) {
    super(config);
    this.geoBits = config.geoBits ?? 8;
  }

  static get protocolName() { return 'Geographic'; }

  /**
   * Create a node whose ID encodes its geographic location in the high-order
   * bits, with random low-order bits for intra-cell uniqueness.
   */
  async addNode(lat, lng) {
    const prefix   = geoCellId(lat, lng, this.geoBits);
    const shift    = 32 - this.geoBits;
    const randMask = shift > 0 ? ((1 << shift) - 1) : 0;
    const rand     = randomU32() & randMask;
    const id       = ((prefix << shift) | rand) >>> 0;  // unsigned 32-bit

    const node = new KademliaNode({
      id, lat, lng, k: this.k, bits: this.bits,
    });
    this.nodeMap.set(id, node);
    this.network.addNode(node);
    return node;
  }

  getStats() {
    return {
      ...super.getStats(),
      protocol: `Geographic-${this.geoBits}`,
      geoBits: this.geoBits,
    };
  }
}

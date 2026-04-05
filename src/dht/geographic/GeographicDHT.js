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
import { randomU64, buildIntraCellTable, buildInterCellTable, reservoirSample } from '../../utils/geo.js';
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
    // Allow 3 consecutive no-progress rounds before terminating (vs Kademlia's 2).
    // One extra round gives the lookup a second chance to escape a local
    // minimum without significantly inflating hop counts.
    this.noProgressLimit = config.noProgressLimit ?? 3;
  }

  static get protocolName() { return 'Geographic'; }

  /**
   * Create a node whose ID encodes its geographic location in the high-order
   * bits, with random low-order bits for intra-cell uniqueness.
   */
  async addNode(lat, lng) {
    const prefix   = geoCellId(lat, lng, this.geoBits);
    const shift    = 64 - this.geoBits;
    // Top geoBits encode geographic cell; bottom (64-geoBits) bits are random.
    const randBits = randomU64() & ((1n << BigInt(shift)) - 1n);
    const id       = (BigInt(prefix) << BigInt(shift)) | randBits;

    const node = new KademliaNode({
      id, lat, lng, k: this.k, bits: this.bits,
    });
    this.nodeMap.set(id, node);
    this.network.addNode(node);
    return node;
  }

  /**
   * Build routing tables with a three-layer strategy:
   *
   * Layer 1 — Intra-cell local (XOR buckets 0 … 63-geoBits)
   *   Peers sharing the same geographic S2-cell prefix.  Low-latency hops
   *   within the geographic cluster.
   *
   * Layer 2 — Inter-cell structured (XOR buckets 64-geoBits … 63)
   *   One peer per bucket covering each geographic-prefix bit, exactly as
   *   Kademlia does for its full key space.  Guarantees that every target
   *   anywhere in the world is reachable — the key-space halving invariant
   *   applied to the inter-cell portion of the ID.
   *   geo8 → 8 buckets (b=56–63); geo16 → 16 buckets (b=48–63).
   *
   * Layer 3 — Random global (uniform sample from full network)
   *   Redundancy and load distribution beyond the structured minimum.
   *
   * Budget allocation (web-limit = 50 example for geo8):
   *   Inter-cell structured: k=1 per bucket → 8 peers (skeleton only)
   *   Remaining 42: half local (21), half random (21)
   *   Empirically optimal: increasing inter-cell k hurts because every peer
   *   taken from local+random reduces overall routing table density.
   *
   * Without web-limit:
   *   Local: all intra-cell peers (k per bucket)
   *   Inter-cell: k peers per bucket
   *   Random: k additional random global peers
   */
  buildRoutingTables({ bidirectional = true, maxConnections = Infinity } = {}) {
    this.bidirectional  = bidirectional;
    this.maxConnections = maxConnections;

    const k            = this.k;
    const intraBuckets = 64 - this.geoBits;   // geo8 → 56, geo16 → 48
    const sorted       = [...this.nodeMap.values()]
      .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    const allNodes     = [...this.nodeMap.values()];

    for (const node of sorted) {
      const selected = new Set([node.id]);

      // ── Layer 2: inter-cell structured (always first to guarantee budget) ──
      // Under web-limit use k=1 (minimum halving guarantee per bucket).
      // Uncapped: use full k per bucket.
      const interCellK = isFinite(maxConnections) ? 1 : k;
      const interCellPeers = buildInterCellTable(node.id, sorted, interCellK, intraBuckets);
      for (const peer of interCellPeers) {
        node.addToBucket(peer);
        if (bidirectional) peer.addToBucket(node);
        selected.add(peer.id);
      }

      // ── Remaining budget after inter-cell ──────────────────────────────────
      let localBudget, globalBudget;
      if (!isFinite(maxConnections)) {
        localBudget  = Infinity;   // all intra-cell peers
        globalBudget = k;          // k random global peers
      } else {
        const remaining = Math.max(0, maxConnections - interCellPeers.length);
        // Even split: empirically optimal balance between local routing
        // density (final hops) and global random reach (last-mile coverage).
        localBudget  = Math.max(1, Math.floor(remaining / 2));
        globalBudget = Math.max(1, remaining - localBudget);
      }

      // ── Layer 1: intra-cell local ──────────────────────────────────────────
      const rawLocal   = buildIntraCellTable(node.id, sorted, k, intraBuckets);
      const localPeers = isFinite(localBudget) ? rawLocal.slice(0, localBudget) : rawLocal;
      for (const peer of localPeers) {
        node.addToBucket(peer);
        if (bidirectional) peer.addToBucket(node);
        selected.add(peer.id);
      }

      // ── Layer 3: random global ─────────────────────────────────────────────
      const globalPeers = reservoirSample(allNodes, globalBudget, selected);
      for (const peer of globalPeers) {
        node.addToBucket(peer);
        if (bidirectional) peer.addToBucket(node);
      }
    }
  }

  getStats() {
    return {
      ...super.getStats(),
      protocol: `G-DHT-${this.geoBits}`,
      geoBits: this.geoBits,
    };
  }
}

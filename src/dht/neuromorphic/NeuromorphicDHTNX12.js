/**
 * NeuromorphicDHTNX12 (NX-12) – Batch Churn Heal
 *
 * Extends NX-11 with postChurnHeal():
 *   After all removals + additions in a churn round, each live node checks
 *   its OWN synaptome/highway/incomingSynapses for dead entries and repairs
 *   them.  This is realistic — each node inspects its own state, not the
 *   dying node's state.
 *
 * Note: proper neuromorphic bootstrap (bootstrapNode) is now provided by
 * the NX-6 base class, with NX-11's 80/20 override inherited here.
 */

import { NeuromorphicDHTNX11 } from './NeuromorphicDHTNX11.js';

export class NeuromorphicDHTNX12 extends NeuromorphicDHTNX11 {
  static get protocolName() { return 'Neuromorphic-NX12'; }

  // removeNode() inherited from NX-6 — node dies, that's it.
  // Neighbors discover dead links when they next route through them.

  // ── Batch heal (called by Engine after a churn round) ───────────────────────

  /**
   * Each live node checks its OWN routing state for dead peers and repairs.
   * This is honest — a node can always inspect its own synaptome and ping
   * its own connections to discover failures.
   */
  postChurnHeal() {
    for (const node of this.nodeMap.values()) {
      if (!node.alive) continue;

      // Synaptome: find and replace dead synapses from own 2-hop neighborhood.
      const dead = [];
      for (const syn of node.synaptome.values()) {
        const peer = this.nodeMap.get(syn.peerId);
        if (!peer?.alive) dead.push(syn);
      }
      for (const syn of dead) {
        this._evictAndReplace(node, syn);
      }

      // Highway: remove dead entries.
      if (this.EN_TWO_TIER && node.highway) {
        for (const [peerId] of node.highway) {
          const peer = this.nodeMap.get(peerId);
          if (!peer?.alive) node.highway.delete(peerId);
        }
      }

      // IncomingSynapses: purge stale reverse pointers.
      for (const [peerId] of node.incomingSynapses) {
        const peer = this.nodeMap.get(peerId);
        if (!peer?.alive) node.incomingSynapses.delete(peerId);
      }

      // Reheat nodes that had damage so they explore replacement connections.
      if (dead.length > 0 && this.EN_ANNEALING) {
        node.temperature = Math.max(
          node.temperature ?? this.T_REHEAT,
          this.T_REHEAT,
        );
      }
    }
  }

  // ── Stats ───────────────────────────────────────────────────────────────────

  getStats() {
    return { ...super.getStats(), protocol: 'Neuromorphic-NX12' };
  }
}

/**
 * NeuromorphicDHTNX8 (NX-8) – Balanced Dendritic Pub/Sub
 *
 * Extends NX-6 with DendriticTreeV2: balanced binary relay tree.
 * When a branch exceeds capacity, it becomes a pure relay node and
 * ALL its subscribers are split 50/50 between two new child branches
 * recruited from the synaptome.
 *
 * vs NX-7 (DendriticTree V1, 25% peel-off):
 *   - Balanced tree: depth ≈ log₂(N/capacity) instead of linear chain
 *   - Pure relay interior: only leaf nodes hold subscribers
 *   - Better fan-out distribution: max 2 children per interior node
 *
 * All NX-6 features inherited: churn reheat, dead-synapse eviction,
 * stratified bootstrap, iterative fallback, two-tier routing, etc.
 *
 * config.rules.dendritic: { enabled, capacity (default 32), ttl (default 10) }
 */

import { NeuromorphicDHTNX6 } from './NeuromorphicDHTNX6.js';
import { DendriticTreeV2 }    from './DendriticTreeV2.js';

export class NeuromorphicDHTNX8 extends NeuromorphicDHTNX6 {
  static get protocolName() { return 'Neuromorphic-NX8'; }

  constructor(config = {}) {
    super(config);

    const rules = config.rules ?? {};
    const d = (param, fallback) => rules.dendritic?.[param] ?? fallback;

    // ── Rule 18 (NX-8): Balanced Dendritic Pub/Sub Tree ─────────────────────
    this.EN_DENDRITIC       = rules.dendritic?.enabled !== false;
    this.DENDRITIC_CAPACITY = d('capacity', 32);
    this.DENDRITIC_TTL      = d('ttl', 10);

    /** Per-relay dendritic trees: relayId → DendriticTreeV2 */
    this._dendriticTrees = new Map();
  }

  // ── Dendritic Pub/Sub Broadcast ────────────────────────────────────────────

  async pubsubBroadcast(relayId, targetIds) {
    if (!this.EN_DENDRITIC || targetIds.length === 0) {
      return this._flatBroadcast(relayId, targetIds);
    }

    let tree = this._dendriticTrees.get(relayId);
    if (!tree) {
      tree = new DendriticTreeV2(this, relayId, {
        capacity: this.DENDRITIC_CAPACITY,
        ttl:      this.DENDRITIC_TTL,
      });
      this._dendriticTrees.set(relayId, tree);
    }

    const rootNode = this.nodeMap.get(relayId);
    if (!rootNode?.alive) {
      this._dendriticTrees.delete(relayId);
      return this._flatBroadcast(relayId, targetIds);
    }

    const targetSet = new Set(targetIds);
    return tree.broadcast(targetSet);
  }

  async _flatBroadcast(relayId, targetIds) {
    const hops  = [];
    const times = [];
    for (const targetId of targetIds) {
      const node = this.nodeMap.get(targetId);
      if (!node?.alive) continue;
      try {
        const r = await this.lookup(relayId, targetId);
        if (r?.found) {
          hops.push(r.hops);
          times.push(Math.round(r.time));
        }
      } catch { /* skip */ }
    }
    return { hops, times, maxNodeLookups: targetIds.length, treeDepth: 0, avgSubsPerNode: targetIds.length };
  }

  // ── Node Lifecycle ─────────────────────────────────────────────────────────

  async removeNode(nodeId) {
    this._dendriticTrees.delete(nodeId);
    return super.removeNode(nodeId);
  }

  // ── Stats ──────────────────────────────────────────────────────────────────

  getStats() {
    const base = super.getStats();

    let totalBranches = 0;
    let totalDepth    = 0;
    let totalSubs     = 0;
    let treeCount     = 0;

    for (const tree of this._dendriticTrees.values()) {
      treeCount++;
      totalBranches += tree.branchCount;
      totalDepth    += tree.depth;
      totalSubs     += tree.subIndex.size;
    }

    return {
      ...base,
      protocol:           'Neuromorphic-NX8',
      dendriticTrees:     treeCount,
      dendriticBranches:  totalBranches,
      dendriticAvgDepth:  treeCount ? (totalDepth / treeCount).toFixed(1) : '—',
      dendriticTotalSubs: totalSubs,
    };
  }
}

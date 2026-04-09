/**
 * NeuromorphicDHTNX7 (NX-7) – Dendritic Pub/Sub
 *
 * Extends NX-6 with a hierarchical relay tree for scalable pub/sub broadcast.
 * Instead of flat fan-out (relay → every subscriber via individual lookups),
 * NX-7 builds a Dendritic tree that distributes the relay workload across
 * branch nodes recruited from the synaptome.
 *
 * The tree is dynamic:
 *   - GROWS as subscribers are added (splits when a branch exceeds capacity)
 *   - SHRINKS as subscriptions time out or nodes die (prunes empty branches)
 *   - SELF-HEALS when branch nodes die (subscribers promoted to parent)
 *
 * All NX-6 features are inherited: churn-triggered temperature reheat,
 * dead-synapse eviction+replacement, stratified bootstrap, iterative fallback,
 * two-tier routing, annealing, LTP, hop caching, etc.
 *
 * New config.rules additions:
 *   {
 *     dendritic: {
 *       enabled:     true,       // enable dendritic tree broadcast
 *       capacity:    32,         // max direct subscribers per branch node
 *       ttl:         10          // ticks before pruning inactive subscriber
 *     }
 *   }
 */

import { NeuromorphicDHTNX6 } from './NeuromorphicDHTNX6.js';
import { DendriticTree }      from './DendriticTree.js';

export class NeuromorphicDHTNX7 extends NeuromorphicDHTNX6 {
  static get protocolName() { return 'Neuromorphic-NX7'; }

  constructor(config = {}) {
    super(config);

    const rules = config.rules ?? {};
    const d = (param, fallback) => rules.dendritic?.[param] ?? fallback;

    // ── Rule 18 (NX-7): Dendritic Pub/Sub Tree ──────────────────────────────
    this.EN_DENDRITIC       = rules.dendritic?.enabled !== false;  // on by default
    this.DENDRITIC_CAPACITY = d('capacity', 32);      // max subscribers per branch
    this.DENDRITIC_TTL      = d('ttl', 10);            // subscription timeout in ticks

    /** Per-relay dendritic trees: relayId → DendriticTree */
    this._dendriticTrees = new Map();
  }

  // ── Dendritic Pub/Sub Broadcast ────────────────────────────────────────────

  /**
   * Tree-based broadcast: Engine.js calls this instead of flat fan-out
   * when dht.pubsubBroadcast exists.
   *
   * @param {bigint}   relayId   — root relay node ID
   * @param {bigint[]} targetIds — subscriber node IDs to deliver to
   * @returns {{ hops: number[], times: number[] }}
   */
  async pubsubBroadcast(relayId, targetIds) {
    if (!this.EN_DENDRITIC || targetIds.length === 0) {
      // Fallback to flat broadcast
      return this._flatBroadcast(relayId, targetIds);
    }

    // Get or create dendritic tree for this relay
    let tree = this._dendriticTrees.get(relayId);
    if (!tree) {
      tree = new DendriticTree(this, relayId, {
        capacity: this.DENDRITIC_CAPACITY,
        ttl:      this.DENDRITIC_TTL,
      });
      this._dendriticTrees.set(relayId, tree);
    }

    // Check root is still alive; if not, rebuild tree with new relay
    const rootNode = this.nodeMap.get(relayId);
    if (!rootNode?.alive) {
      this._dendriticTrees.delete(relayId);
      return this._flatBroadcast(relayId, targetIds);
    }

    // Broadcast through tree (adds/renews subscribers, delivers, prunes)
    // Returns { hops, times, maxNodeLookups }
    const targetSet = new Set(targetIds);
    return tree.broadcast(targetSet);
  }

  /**
   * Flat broadcast fallback — same as what Engine.js does for non-tree protocols,
   * but executed here so the interface stays consistent.
   */
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
    // Flat: relay performs ALL lookups, no tree
    return { hops, times, maxNodeLookups: targetIds.length, treeDepth: 0, avgSubsPerNode: targetIds.length };
  }

  // ── Node Lifecycle Overrides ───────────────────────────────────────────────

  async removeNode(nodeId) {
    // Clean up any dendritic tree rooted at this node
    this._dendriticTrees.delete(nodeId);
    return super.removeNode(nodeId);
  }

  // ── Stats ──────────────────────────────────────────────────────────────────

  getStats() {
    const base = super.getStats();

    // Dendritic tree stats
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
      protocol:           'Neuromorphic-NX7',
      dendriticTrees:     treeCount,
      dendriticBranches:  totalBranches,
      dendriticAvgDepth:  treeCount ? (totalDepth / treeCount).toFixed(1) : '—',
      dendriticTotalSubs: totalSubs,
    };
  }
}

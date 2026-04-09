/**
 * NeuromorphicDHTNX10 (NX-10) – Routing-Topology Forwarding Tree
 *
 * Extends NX-6 with RoutingTree: a pub/sub tree that mirrors the actual
 * routing topology.  When a node has more subscribers than capacity, it
 * finds which direct synapse (connection) would be the first hop toward
 * the most subscribers, and delegates those subscribers to that synapse
 * as a forwarder.  Recursive — forwarders apply the same rule.
 *
 * vs NX-7/8 (overlay trees):
 *   - Tree mirrors routing topology — no extra overlay to maintain
 *   - Forwarder = direct synapse, so forwarding hop = 1 hop (no DHT lookup)
 *   - Subscribers naturally cluster at the forwarder closest to them
 *   - Fan-out per node bounded by capacity
 *
 * vs NX-9 (geographic clustering):
 *   - Routing-aware, not geography-aware — works even without S2 prefix
 *   - Tree depth emerges from routing topology, not preset cell structure
 *   - Subscription interception: tree nodes capture in-flight subscriptions
 *
 * All NX-6 features inherited: churn reheat, dead-synapse eviction,
 * stratified bootstrap, iterative fallback, two-tier routing, etc.
 *
 * config.rules.dendritic: { enabled, capacity (default 32), ttl (default 10) }
 */

import { NeuromorphicDHTNX6 } from './NeuromorphicDHTNX6.js';
import { RoutingTree }        from './RoutingTree.js';

export class NeuromorphicDHTNX10 extends NeuromorphicDHTNX6 {
  static get protocolName() { return 'Neuromorphic-NX10'; }

  constructor(config = {}) {
    super(config);

    const rules = config.rules ?? {};
    const d = (param, fallback) => rules.dendritic?.[param] ?? fallback;

    // ── Rule 20 (NX-10): Routing-Topology Forwarding Tree ───────────────────
    this.EN_DENDRITIC       = rules.dendritic?.enabled !== false;
    this.DENDRITIC_CAPACITY = d('capacity', 32);
    this.DENDRITIC_TTL      = d('ttl', 10);

    /** Per-relay routing trees: relayId → RoutingTree */
    this._dendriticTrees = new Map();
  }

  // ── Dendritic Pub/Sub Broadcast ────────────────────────────────────────────

  async pubsubBroadcast(relayId, targetIds) {
    if (!this.EN_DENDRITIC || targetIds.length === 0) {
      return this._flatBroadcast(relayId, targetIds);
    }

    let tree = this._dendriticTrees.get(relayId);
    if (!tree) {
      tree = new RoutingTree(this, relayId, {
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
      protocol:           'Neuromorphic-NX10',
      dendriticTrees:     treeCount,
      dendriticBranches:  totalBranches,
      dendriticAvgDepth:  treeCount ? (totalDepth / treeCount).toFixed(1) : '—',
      dendriticTotalSubs: totalSubs,
    };
  }
}

/**
 * NeuromorphicDHTNX11 (NX-11) – Diversified Bootstrap + Axonal Pub/Sub
 *
 * Extends NX-10 (routing-topology forwarding tree) with the G-DHT-b
 * bootstrap lesson: under web-limit, reserve 20% of synaptome capacity
 * for random global peers alongside the stratified 80%.
 *
 * Why this helps:
 *   - NX-10 inherits NX-3's web-limited bootstrap, which gives 100% of
 *     the synaptome budget to stratified XOR-bucket allocation.  This
 *     provides excellent reachability but poor churn resilience: all
 *     connections are structured, so when a peer dies there may be no
 *     alternative path in that stratum range.
 *   - G-DHT-b showed that reserving 20% for random global peers improves
 *     churn success from 69% to 77% without sacrificing reachability.
 *   - For the neuromorphic DHT, random initial peers also give annealing
 *     more diverse starting material to explore from.
 *
 * All NX-10 features inherited: routing-topology axonal tree, churn reheat,
 * dead-synapse eviction, stratified bootstrap, iterative fallback, etc.
 *
 * config.rules.dendritic: { enabled, capacity (default 32), ttl (default 10) }
 */

import { NeuromorphicDHTNX10 }  from './NeuromorphicDHTNX10.js';
import { Synapse }              from './Synapse.js';
import { roundTripLatency, clz64, buildXorRoutingTable, reservoirSample }
                                from '../../utils/geo.js';

export class NeuromorphicDHTNX11 extends NeuromorphicDHTNX10 {
  static get protocolName() { return 'Neuromorphic-NX11'; }

  // ── Diversified Bootstrap ──────────────────────────────────────────────────

  buildRoutingTables({ bidirectional = true, maxConnections = Infinity } = {}) {
    // Let the full NX chain (NX-6 → NX-5 → NX-4 → NX-3 → ...) run first.
    // Under web-limit, NX-3 will wire synaptomes via buildXorRoutingTable
    // using the full maxConnections budget.  We then supplement with random
    // global peers by evicting some of the lowest-value structured peers.

    if (!isFinite(maxConnections)) {
      // Uncapped: standard three-layer init is optimal — no change needed.
      super.buildRoutingTables({ bidirectional, maxConnections });
      return;
    }

    // Web-limited: override NX-3's init with 80/20 stratified + random.
    // We call the grandparent chain (NX-6..NX-5..NX-4 config setup) but
    // replace NX-3's synaptome wiring with our own.

    // First, run the super chain to set up config and node structures,
    // but with a reduced budget for the stratified core.
    const coreBudget = Math.floor(maxConnections * 0.8);
    super.buildRoutingTables({ bidirectional, maxConnections: coreBudget });

    // Now supplement each node's synaptome with random global peers.
    const randomBudget = maxConnections - coreBudget;
    const allNodes = [...this.nodeMap.values()];

    for (const node of allNodes) {
      if (!node.alive) continue;

      // Collect IDs already in synaptome to avoid duplicates
      const existing = new Set([node.id]);
      for (const syn of node.synaptome.values()) existing.add(syn.peerId);
      if (node.highway) {
        for (const syn of node.highway.values()) existing.add(syn.peerId);
      }

      // Add random global peers
      const randomPeers = reservoirSample(allNodes, randomBudget, existing);
      for (const peer of randomPeers) {
        const latMs   = roundTripLatency(node, peer);
        const stratum = clz64(node.id ^ peer.id);
        const syn     = new Synapse({ peerId: peer.id, latencyMs: latMs, stratum });
        syn.weight = 0.3;   // moderate weight: useful but not yet proven
        node.addSynapse(syn);
        if (bidirectional) peer.addIncomingSynapse(node.id, latMs, stratum);
      }
    }
  }

  // ── Churn bootstrap (80/20 diversified) ─────────────────────────────────────

  /**
   * Override NX-6's flat XOR bootstrap with the same 80/20 stratified+random
   * strategy used by buildRoutingTables().  Ensures new nodes added during
   * churn get the same connection diversity as nodes from initial setup.
   */
  bootstrapNode(newNode, sorted, k = 20) {
    if (!sorted?.length || !newNode?.alive) return;

    const maxConn = newNode.maxConnections ?? this.MAX_SYNAPTOME_SIZE ?? Infinity;
    const bidir   = this.bidirectional;

    const wireSynapse = (peer, weight) => {
      const latMs   = roundTripLatency(newNode, peer);
      const stratum = clz64(newNode.id ^ peer.id);
      const syn     = new Synapse({ peerId: peer.id, latencyMs: latMs, stratum });
      syn.weight    = weight;
      newNode.addSynapse(syn);
      if (bidir) peer.addIncomingSynapse(newNode.id, latMs, stratum);
    };

    if (isFinite(maxConn)) {
      // Web-limited: 80% stratified XOR + 20% random global
      const coreBudget   = Math.floor(maxConn * 0.8);
      const randomBudget = maxConn - coreBudget;

      const existing = new Set([newNode.id]);
      for (const peer of buildXorRoutingTable(newNode.id, sorted, k, coreBudget)) {
        wireSynapse(peer, 0.5);
        existing.add(peer.id);
      }
      const randomPeers = reservoirSample(sorted, randomBudget, existing);
      for (const peer of randomPeers) {
        wireSynapse(peer, 0.3);
      }
    } else {
      // Uncapped: delegate to NX-6's flat XOR bootstrap
      super.bootstrapNode(newNode, sorted, k);
      return;
    }

    newNode._nodeMapRef = this.nodeMap;
  }

  // ── Stats ──────────────────────────────────────────────────────────────────

  getStats() {
    const base = super.getStats();
    return {
      ...base,
      protocol: 'Neuromorphic-NX11',
    };
  }
}

/**
 * NeuromorphicDHTNS3 (NS-3) – NS-2 + Geographic-Aware Bootstrap
 *
 * Adds geographic three-layer bootstrap to NS-2, working under web-limit:
 *
 *   Layer 1 (inter-cell): 1 peer per inter-cell XOR bucket — guarantees
 *     global reachability across geographic cells. Budget: ~8 peers for
 *     8-bit geo prefix.
 *
 *   Layer 2 (intra-cell): nearby peers in the same geographic cell —
 *     provides low-latency local hops. Budget: half of remaining.
 *
 *   Layer 3 (random global): uniform random sample — diversity and
 *     backup paths. Budget: other half of remaining.
 *
 * This replaces NS-1/NS-2's flat XOR bootstrap which optimizes for
 * reachability but not latency.  Geographic init ensures that early hops
 * in a lookup traverse nearby nodes (low RTT) before jumping to distant
 * cells when needed.
 */

import { NeuromorphicDHTNS2 } from './NeuromorphicDHTNS2.js';
import { Synapse }            from './Synapse.js';
import { roundTripLatency, clz64, buildXorRoutingTable,
         buildIntraCellTable, buildInterCellTable, reservoirSample }
                              from '../../utils/geo.js';

export class NeuromorphicDHTNS3 extends NeuromorphicDHTNS2 {
  static get protocolName() { return 'Neuromorphic-NS3'; }

  buildRoutingTables({ bidirectional = true, maxConnections = Infinity } = {}) {
    super.buildRoutingTables({ bidirectional, maxConnections });
    // super wired flat XOR — clear and rewire with geographic layers
    // (only under web-limit; uncapped already gets good latency from volume)
    if (!isFinite(maxConnections)) return;

    const k            = this._k;
    const intraBuckets = 64 - this.GEO_BITS;
    const sorted       = [...this.nodeMap.values()].sort(
      (a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    );
    const allNodes     = [...this.nodeMap.values()];

    const wireSynapse = (node, peer) => {
      const latMs   = roundTripLatency(node, peer);
      const stratum = clz64(node.id ^ peer.id);
      const syn     = new Synapse({ peerId: peer.id, latencyMs: latMs, stratum });
      node.addSynapse(syn);
      if (bidirectional) peer.addIncomingSynapse(node.id, latMs, stratum);
    };

    for (const node of sorted) {
      // Clear the flat XOR synapses from super.buildRoutingTables
      node.synaptome.clear();
      node.incomingSynapses.clear();

      const selected = new Set([node.id]);

      // Layer 1: inter-cell structured (1 per bucket, ~8 peers for geo8)
      const interCellPeers = buildInterCellTable(node.id, sorted, 1, intraBuckets);
      for (const peer of interCellPeers) {
        wireSynapse(node, peer);
        selected.add(peer.id);
      }

      // Remaining budget split evenly between local and random
      const remaining   = Math.max(0, maxConnections - interCellPeers.length);
      const localBudget = Math.max(1, Math.floor(remaining / 2));
      const randBudget  = Math.max(1, remaining - localBudget);

      // Layer 2: intra-cell local (low-latency nearby peers)
      const localPeers = buildIntraCellTable(node.id, sorted, k, intraBuckets)
        .slice(0, localBudget);
      for (const peer of localPeers) {
        wireSynapse(node, peer);
        selected.add(peer.id);
      }

      // Layer 3: random global (diversity + backup paths)
      const globalPeers = reservoirSample(allNodes, randBudget, selected);
      for (const peer of globalPeers) {
        wireSynapse(node, peer);
      }

      node._nodeMapRef = this.nodeMap;
    }
  }

  getStats() {
    return { ...super.getStats(), protocol: 'Neuromorphic-NS3' };
  }
}

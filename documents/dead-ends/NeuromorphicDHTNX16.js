/**
 * NeuromorphicDHTNX16 — NX-15 with a cell-agnostic topic distance metric for
 * pub/sub replica selection.
 *
 * ⚠ DEAD END — retained for documentation. See NX-17 for the working
 * publisher-prefix addressing scheme that superseded this approach.
 *
 * ── Motivation (now disproven) ────────────────────────────────────────────
 * NX-15's K-closest replicas all land in a single S2 cell (whichever cell
 * hash(topic) points into). Under 25% uniform churn that cell loses ~25%
 * of its nodes and all K replicas share fate — the shared-fate failure
 * domain. NX-16 attempted to break this by using a *masked-distance*
 * metric inside findKClosest: ignore the top geoBits of the target and
 * compare only the random tail, so replicas spread uniformly across all
 * 256 cells.
 *
 * ── Why it failed ──────────────────────────────────────────────────────────
 * Routing (synaptic highways, 2-hop AP, regional queries) continues to
 * use full 64-bit XOR and therefore points toward specific cells. But if
 * findKClosest's "closest" metric ignores the prefix, the routing
 * gradient is mis-aligned with the selection criterion: expansion from
 * any seed pulls candidates into the full-XOR target cell, while the
 * selection criterion says nodes in any cell can be equally close. The
 * candidate pool either grows unboundedly (correctness preserved but
 * perf catastrophic) or gets shortlist-capped (fast but traps each
 * caller in their own cell's local top-N). Either way, publisher and
 * subscribers diverge on which K nodes are "closest" — they explore
 * different parts of the network and end up selecting different K sets.
 * The 25K-node benchmark collapsed to ~40% delivery even with zero
 * churn.
 *
 * Publisher and subscribers both use the same deterministic metric, so
 * they still converge on the same K-closest set. No extra network calls,
 * no extra lookups, no salts or virtual IDs — just a different comparator
 * inside findKClosest.
 *
 * ── Lessons ────────────────────────────────────────────────────────────────
 * The fundamental architectural principle violated here: the distance
 * metric used to SELECT candidates must be compatible with the gradient
 * used to EXPAND candidates. Synaptome expansion points toward specific
 * cells; a selection metric that ignores cells cannot converge when
 * given that expansion structure.
 *
 * The correct fix for cell-concentration (if needed) operates at the
 * addressing layer, not the metric layer. NX-17's publisher-prefix
 * scheme replaces the random target cell with a deterministic,
 * well-routed cell (the publisher's own) — and turned out to improve
 * churn resilience anyway (+10 pp at 25% churn vs NX-15), apparently
 * because routing into the publisher's own cell is refreshed by the
 * publisher's ordinary lookup traffic rather than depending solely on
 * pub/sub traffic.
 */

import { NeuromorphicDHTNX15 } from './NeuromorphicDHTNX15.js';

function topicToBigInt(topicId) {
  if (typeof topicId === 'bigint') return topicId;
  return BigInt('0x' + topicId);
}

export class NeuromorphicDHTNX16 extends NeuromorphicDHTNX15 {
  static get protocolName() { return 'Neuromorphic-NX16'; }

  /**
   * K-closest lookup using a cell-agnostic distance: the top `geoBits`
   * of both the node id and the target are masked out before XOR, so
   * distance is determined entirely by the random tail.
   *
   * Same iterative-FIND_NODE structure and hybrid termination as NX-15;
   * only the distance function differs. Seed tier (synaptome + highway +
   * incomingSynapses) and expansion tier (outgoing synaptome + highway)
   * are identical, so we still leverage LTP-trained highways to reach
   * across cells even though we no longer prefer in-cell candidates.
   */
  findKClosest(sourceNode, targetId, K = 5, { alpha = 3, maxRounds = 40 } = {}) {
    const src = this._resolveNode(sourceNode);
    if (!src) return [];
    const targetBig = topicToBigInt(targetId);

    // Mask off the geographic prefix. NX-* uses 64-bit node IDs; the top
    // GEO_BITS are the S2 cell prefix. For GEO_BITS=0 this is a no-op and
    // NX-16 degenerates to NX-15's behaviour (distance is full-bit XOR).
    const ID_BITS  = 64;
    const tailBits = Math.max(0, ID_BITS - this.GEO_BITS);
    const mask     = (1n << BigInt(tailBits)) - 1n;
    const maskedTarget = targetBig & mask;
    const maskedDist = (id) => (id & mask) ^ maskedTarget;

    const candidates = new Map();   // BigInt id → NeuronNode
    const distances  = new Map();   // BigInt id → BigInt masked distance
    const addCandidate = (node) => {
      if (!node?.alive || candidates.has(node.id)) return;
      candidates.set(node.id, node);
      distances.set(node.id, maskedDist(node.id));
    };

    addCandidate(src);
    const addTier = (tier) => {
      if (!tier) return;
      for (const syn of tier.values()) addCandidate(this.nodeMap.get(syn.peerId));
    };
    addTier(src.synaptome);
    addTier(src.highway);
    addTier(src.incomingSynapses);

    // Hybrid termination: top-K fully probed AND pool stable for one
    // α-round. See NX-15.findKClosest for rationale.
    //
    // The candidate pool is intentionally UNBOUNDED. An earlier version
    // of NX-16 applied a Kademlia-style shortlist cap to curb the ~38×
    // findKClosest slowdown introduced by masked distance, but this
    // broke the protocol: with masked XOR the synaptome expansion
    // (cell-local) points toward the full-XOR target cell, not the
    // masked-XOR target region. Pool cap traps each caller in their own
    // cell's local top-N, so publisher and subscribers start from
    // different cells and converge on DIFFERENT K-closest sets. Pub/sub
    // delivery collapsed from ~100% to 39% at 25K nodes (and axon-role
    // count ballooned ~5× as every small group elected its own caller-
    // local roots). The only way to guarantee deterministic convergence
    // of publisher and subscriber K-closest is to let the pool grow
    // until every caller has reached the same globally-best neighbour-
    // hood in masked-distance space. This costs O(pool · log(pool))
    // sort per round but correctness requires it.
    const visited = new Set();
    let lastPoolSize = 0;
    let stableRounds = 0;
    for (let round = 0; round < maxRounds; round++) {
      const sortedCands = [...candidates.values()]
        .sort((a, b) => distances.get(a.id) < distances.get(b.id) ? -1 : 1);
      const topK = sortedCands.slice(0, K);
      const topKAllVisited = topK.every(n => visited.has(n.id));

      let toQuery = topK.filter(n => !visited.has(n.id)).slice(0, alpha);
      if (toQuery.length < alpha) {
        const remaining = alpha - toQuery.length;
        const beyond = sortedCands.filter(n => !visited.has(n.id) && !topK.includes(n)).slice(0, remaining);
        toQuery = toQuery.concat(beyond);
      }
      if (toQuery.length === 0) break;

      for (const peer of toQuery) {
        visited.add(peer.id);
        // Expansion uses OUTGOING routing only. Seed-only incoming is
        // enough to break out of LTP-specialized local minima; see
        // NX-15 findKClosest for the rationale.
        addTier(peer.synaptome);
        addTier(peer.highway);
      }

      const grew = candidates.size > lastPoolSize;
      lastPoolSize = candidates.size;
      stableRounds = grew ? 0 : stableRounds + 1;
      if (topKAllVisited && stableRounds >= 1) break;
    }

    return [...candidates.values()]
      .sort((a, b) => distances.get(a.id) < distances.get(b.id) ? -1 : 1)
      .slice(0, K);
  }
}

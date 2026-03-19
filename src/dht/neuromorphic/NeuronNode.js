/**
 * NeuronNode – a Network Neuron in the Neuromorphic Geographic DHT.
 *
 * Unlike KademliaNode's fixed k-bucket array, a NeuronNode maintains a
 * dynamic, unbounded Synaptome (Map<peerId, Synapse>), governed by:
 *   - Experiential weight updates (LTP / LTD)
 *   - Inertia locks on recently-reinforced synapses
 *   - The Structural Survival Rule: never prune the last synapse in a stratum
 *
 * Routing decisions use the Activation Potential (AP) formula rather than
 * closest-XOR, weighting progress, latency, and reliability together.
 */
import { DHTNode } from '../DHTNode.js';

export class NeuronNode extends DHTNode {
  constructor({ id, lat, lng }) {
    super({ id, lat, lng });

    /** @type {Map<number, import('./Synapse.js').Synapse>} */
    this.synaptome = new Map();

    /**
     * Regional latency baselines: S2 prefix → historical average latency (ms).
     * Used by the neuromodulation wave to judge whether a route was "fast".
     */
    this.regionalBaselines = new Map();

    /**
     * Transit cache for triadic closure (Structural Plasticity).
     * Maps "fromId_toId" → count of times this node forwarded that pair.
     */
    this.transitCache = new Map();

    /** Injected by NeuromorphicDHT after buildRoutingTables(). */
    this._nodeMapRef = null;
  }

  // ── Synaptome management ──────────────────────────────────────────────────

  addSynapse(synapse) {
    this.synaptome.set(synapse.peerId, synapse);
  }

  hasSynapse(peerId) {
    return this.synaptome.has(peerId);
  }

  /**
   * Structural Survival Rule: a synapse may only be pruned if another synapse
   * with the same stratum exists in the synaptome.  This guarantees that every
   * populated stratum always has at least one live route, preserving global
   * network navigability even after heavy decay.
   */
  canPrune(synapse) {
    for (const s of this.synaptome.values()) {
      if (s !== synapse && s.stratum === synapse.stratum) return true;
    }
    return false;
  }

  // ── Activation Potential routing ──────────────────────────────────────────

  /**
   * Return all synapses that make strict XOR progress toward targetId.
   * Strict progress (peerDist < myDist) is a mathematical loop prevention:
   * XOR distance can only decrease each hop, so no node can be revisited.
   */
  progressCandidates(targetId) {
    const myDist = (this.id ^ targetId) >>> 0;
    const result = [];
    for (const s of this.synaptome.values()) {
      if (((s.peerId ^ targetId) >>> 0) < myDist) result.push(s);
    }
    return result;
  }

  /**
   * Select the synapse with the highest Activation Potential.
   *
   *   AP_c = (ΔDistance_c / L_c) × (1 + weightScale × W_c)
   *
   * ΔDistance / L  — pure progress velocity (dominant term).
   * (1 + scale×W)  — mild preference boost for synapses that have historically
   *                  led to fast lookups (latency-quality LTP signal).
   *                  weightScale is kept small (default 0.15) so weight is a
   *                  tiebreaker, not a dominator.  Because weight only accrues
   *                  on at-or-below-average-latency paths, high-W synapses
   *                  genuinely represent fast routes, not just frequent ones.
   */
  bestByAP(candidates, targetId, weightScale = 0.15) {
    const myDist = (this.id ^ targetId) >>> 0;
    let best = null;
    let bestAP = -Infinity;
    for (const s of candidates) {
      const peerDist = (s.peerId ^ targetId) >>> 0;
      const delta    = myDist - peerDist;
      const ap       = (delta / s.latency) * (1 + weightScale * s.weight);
      if (ap > bestAP) { bestAP = ap; best = s; }
    }
    return best;
  }

  // ── Globe visualisation ───────────────────────────────────────────────────

  /**
   * Compatible with the existing globe click-to-show-routing-table feature.
   */
  getRoutingTableEntries() {
    if (!this._nodeMapRef) return [];
    const entries = [];
    for (const s of this.synaptome.values()) {
      const n = this._nodeMapRef.get(s.peerId);
      if (n) entries.push(n);
    }
    return entries;
  }

  // ── Network message handler ───────────────────────────────────────────────

  handleMessage({ type }) {
    if (type === 'PING') return 'PONG';
    return null;
  }
}

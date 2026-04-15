/**
 * NeuromorphicDHTNS2 (NS-2) – NS-1 + Hop Caching
 *
 * Adds a single feature to NS-1: at each intermediate hop during a lookup,
 * introduce the target node to the current node's synaptome.  This teaches
 * intermediate nodes about popular destinations, creating geographic
 * shortcuts that reduce latency on subsequent lookups.
 *
 * No lateral spread, no cascade backprop — just the forward introduce.
 */

import { NeuromorphicDHTNS1 } from './NeuromorphicDHTNS1.js';
import { Synapse }            from './Synapse.js';
import { roundTripLatency, clz64 } from '../../utils/geo.js';

export class NeuromorphicDHTNS2 extends NeuromorphicDHTNS1 {
  static get protocolName() { return 'Neuromorphic-NS2'; }

  async lookup(sourceId, targetKey) {
    const source = this.nodeMap.get(sourceId);
    if (!source || !source.alive) return null;

    this.simEpoch++;
    if (++this.lookupsSinceDecay >= this.DECAY_INTERVAL) {
      this._tickDecay();
      this.lookupsSinceDecay = 0;
    }

    const path    = [sourceId];
    const trace   = [];
    const queried = new Set([sourceId]);
    let currentId   = sourceId;
    let totalTimeMs = 0;
    let reached     = false;

    for (let hop = 0; hop < this.MAX_HOPS; hop++) {
      const current = this.nodeMap.get(currentId);
      if (!current || !current.alive) break;

      const currentDist = current.id ^ targetKey;
      if (currentDist === 0n) { reached = true; break; }

      // ── Collect forward-progress candidates + handle dead synapses ─────
      const deadSynapses = [];
      const candidates   = [];

      for (const s of current.synaptome.values()) {
        if ((s.peerId ^ targetKey) >= currentDist) continue;
        const peer = this.nodeMap.get(s.peerId);
        if (!peer?.alive) { deadSynapses.push(s); s.weight = 0; continue; }
        candidates.push(s);
      }
      for (const s of current.incomingSynapses.values()) {
        if ((s.peerId ^ targetKey) >= currentDist) continue;
        const peer = this.nodeMap.get(s.peerId);
        if (peer?.alive) candidates.push(s);
      }

      // Dead-synapse eviction + replacement
      for (const syn of deadSynapses) {
        const replacement = this._evictAndReplace(current, syn);
        if (replacement && (replacement.peerId ^ targetKey) < currentDist) {
          candidates.push(replacement);
        }
      }

      // ── Iterative fallback ─────────────────────────────────────────────
      if (candidates.length === 0) {
        let bestSyn = null, bestDist = null;
        const scan = (s) => {
          if (queried.has(s.peerId)) return;
          const peer = this.nodeMap.get(s.peerId);
          if (!peer?.alive) return;
          const d = s.peerId ^ targetKey;
          if (bestDist === null || d < bestDist) { bestDist = d; bestSyn = s; }
        };
        for (const s of current.synaptome.values()) scan(s);
        for (const s of current.incomingSynapses.values()) scan(s);
        if (!bestSyn) break;
        candidates.push(bestSyn);
      }

      // ── Select next hop ────────────────────────────────────────────────
      let nextSyn;

      const direct = current.synaptome.get(targetKey)
                  ?? current.incomingSynapses.get(targetKey);
      if (direct && this.nodeMap.get(targetKey)?.alive) {
        nextSyn = direct;
      }

      if (!nextSyn && hop === 0 && Math.random() < this.EPSILON) {
        nextSyn = candidates[Math.floor(Math.random() * candidates.length)];
      }

      if (!nextSyn) {
        const inRegion = ((current.id ^ targetKey) >> BigInt(64 - this.GEO_REGION_BITS)) === 0n;
        const wScale   = inRegion ? this.WEIGHT_SCALE : 0;
        nextSyn = this._bestByTwoHopAP(current, candidates, targetKey, currentDist, wScale);
      }

      const nextId   = nextSyn.peerId;
      const nextNode = this.nodeMap.get(nextId);
      if (!nextNode) break;

      // ── Incoming promotion ─────────────────────────────────────────────
      if (current.incomingSynapses.has(nextId) && !current.synaptome.has(nextId)) {
        const inc = current.incomingSynapses.get(nextId);
        inc.useCount = (inc.useCount ?? 0) + 1;
        if (inc.useCount >= this.INCOMING_PROMOTE_THRESH) {
          const syn = new Synapse({ peerId: nextId, latencyMs: inc.latency, stratum: inc.stratum });
          syn.weight = 0.5;
          if (current.synaptome.size < this.MAX_SYNAPTOME) {
            current.addSynapse(syn);
            current.incomingSynapses.delete(nextId);
          }
        }
      }

      queried.add(nextId);
      path.push(nextId);
      trace.push({ fromId: currentId, synapse: nextSyn });
      totalTimeMs += nextSyn.latency;

      // ── Hop caching: introduce target to intermediate node ─────────────
      if (currentId !== targetKey) {
        this._hopCache(currentId, targetKey);
      }

      // ── Simple annealing ───────────────────────────────────────────────
      current.temperature = Math.max(this.T_MIN, current.temperature * this.ANNEAL_COOLING);
      if (Math.random() < current.temperature) {
        this._tryAnneal(current);
      }

      currentId = nextId;
    }

    // ── Post-lookup: LTP reinforcement on fast paths ─────────────────────────
    if (reached) {
      const hopCount = path.length - 1;
      this._emaHops = this._emaHops === null ? hopCount : 0.9 * this._emaHops + 0.1 * hopCount;
      this._emaTime = this._emaTime === null ? totalTimeMs : 0.9 * this._emaTime + 0.1 * totalTimeMs;

      if (trace.length > 0 && totalTimeMs <= this._emaTime) {
        this._reinforceWave(trace);
      }
    }

    return { path, hops: path.length - 1, time: totalTimeMs, found: reached };
  }

  // ── Hop caching ─────────────────────────────────────────────────────────────

  /** Introduce a target node to an intermediate hop's synaptome. */
  _hopCache(nodeId, targetId) {
    const node   = this.nodeMap.get(nodeId);
    const target = this.nodeMap.get(targetId);
    if (!node || !target || !node.alive || !target.alive) return;
    if (node.synaptome.has(targetId)) return;
    if (node.synaptome.size >= this.MAX_SYNAPTOME) return;

    const latMs   = roundTripLatency(node, target);
    const stratum = clz64(node.id ^ target.id);
    const syn     = new Synapse({ peerId: targetId, latencyMs: latMs, stratum });
    syn.weight    = 0.3;
    node.addSynapse(syn);
  }

  // ── Stats ───────────────────────────────────────────────────────────────────

  getStats() {
    return { ...super.getStats(), protocol: 'Neuromorphic-NS2' };
  }
}

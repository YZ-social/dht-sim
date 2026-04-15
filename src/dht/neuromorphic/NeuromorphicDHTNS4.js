/**
 * NeuromorphicDHTNS4 (NS-4) – NS-2 + Triadic Closure
 *
 * When node C repeatedly forwards traffic from origin A toward next-hop D,
 * C introduces A and D directly — creating a shortcut that bypasses C on
 * future lookups.  This is Hebbian learning: "neurons that fire together
 * wire together."
 *
 * Triadic closure discovers low-latency shortcuts because if A→C and C→D
 * are both fast (selected by AP routing), then A→D is likely fast too.
 * Over time this compresses routing paths, especially for regional traffic.
 */

import { NeuromorphicDHTNS2 } from './NeuromorphicDHTNS2.js';
import { Synapse }            from './Synapse.js';
import { roundTripLatency, clz64 } from '../../utils/geo.js';

export class NeuromorphicDHTNS4 extends NeuromorphicDHTNS2 {
  static get protocolName() { return 'Neuromorphic-NS4'; }

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

      // ── Hop caching (from NS-2) ───────────────────────────────────────
      if (currentId !== targetKey) {
        this._hopCache(currentId, targetKey);
      }

      // ── Triadic closure: if C forwards A→D repeatedly, introduce A↔D ──
      if (currentId !== sourceId) {
        this._recordTransit(current, sourceId, nextId);
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

  // ── Triadic closure ─────────────────────────────────────────────────────────

  /**
   * Record that node C forwarded traffic from origin A to next-hop D.
   * On the 2nd occurrence of the same A→D pair through C, introduce A to D
   * directly — creating a shortcut.
   */
  _recordTransit(node, originId, nextId) {
    const key   = `${originId}_${nextId}`;
    const count = (node.transitCache.get(key) ?? 0) + 1;
    if (count >= 2) {
      node.transitCache.delete(key);
      this._introduce(originId, nextId);
    } else {
      node.transitCache.set(key, count);
    }
  }

  /** Add a direct synapse from node A to node C if there's room. */
  _introduce(aId, cId) {
    const nodeA = this.nodeMap.get(aId);
    const nodeC = this.nodeMap.get(cId);
    if (!nodeA || !nodeC || !nodeA.alive || !nodeC.alive) return;
    if (nodeA.synaptome.has(cId)) return;
    if (nodeA.synaptome.size >= this.MAX_SYNAPTOME) return;

    const latMs   = roundTripLatency(nodeA, nodeC);
    const stratum = clz64(nodeA.id ^ nodeC.id);
    const syn     = new Synapse({ peerId: cId, latencyMs: latMs, stratum });
    syn.weight    = 0.5;
    nodeA.addSynapse(syn);
  }

  // ── Stats ───────────────────────────────────────────────────────────────────

  getStats() {
    return { ...super.getStats(), protocol: 'Neuromorphic-NS4' };
  }
}

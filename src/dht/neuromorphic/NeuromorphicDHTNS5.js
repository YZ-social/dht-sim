/**
 * NeuromorphicDHTNS5 (NS-5) – NS-2 + Eviction on Add
 *
 * NS-2's hop caching and incoming promotion only add synapses when there's
 * room (size < MAX_SYNAPTOME).  Once the synaptome is full, no new
 * connections can be learned — the routing table is frozen at its initial
 * bootstrap state plus whatever fit during early warmup.
 *
 * NS-5 adds simple eviction: when the synaptome is full and a new synapse
 * is proposed (from hop caching, incoming promotion, or annealing), the
 * weakest existing synapse is evicted to make room.  This lets the routing
 * table continuously improve — proven-useful connections displace weak ones.
 *
 * This is the same "simple eviction" that NX-6 uses by default (its
 * stratified eviction is disabled because simple outperforms it).
 */

import { NeuromorphicDHTNS2 } from './NeuromorphicDHTNS2.js';
import { Synapse }            from './Synapse.js';
import { roundTripLatency, clz64 } from '../../utils/geo.js';

export class NeuromorphicDHTNS5 extends NeuromorphicDHTNS2 {
  static get protocolName() { return 'Neuromorphic-NS5'; }

  // ── Eviction-aware add ──────────────────────────────────────────────────────

  /**
   * Add a synapse to a node's synaptome, evicting the weakest if full.
   * Returns true if added, false if eviction wasn't possible.
   */
  _addOrEvict(node, newSyn) {
    if (node.synaptome.size < this.MAX_SYNAPTOME) {
      node.addSynapse(newSyn);
      return true;
    }
    // Evict weakest synapse (skip LTP-locked ones)
    let weakest = null, weakW = Infinity;
    for (const s of node.synaptome.values()) {
      if (s.inertia > this.simEpoch) continue;
      if (s.weight < weakW) { weakW = s.weight; weakest = s; }
    }
    if (!weakest || weakW >= newSyn.weight) return false;
    node.synaptome.delete(weakest.peerId);
    node.addSynapse(newSyn);
    return true;
  }

  // ── Override hop caching to use eviction ─────────────────────────────────────

  _hopCache(nodeId, targetId) {
    const node   = this.nodeMap.get(nodeId);
    const target = this.nodeMap.get(targetId);
    if (!node || !target || !node.alive || !target.alive) return;
    if (node.synaptome.has(targetId)) return;

    const latMs   = roundTripLatency(node, target);
    const stratum = clz64(node.id ^ target.id);
    const syn     = new Synapse({ peerId: targetId, latencyMs: latMs, stratum });
    syn.weight    = 0.3;
    this._addOrEvict(node, syn);
  }

  // ── Override lookup to use eviction for incoming promotion ───────────────────

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

      // ── Incoming promotion (with eviction) ─────────────────────────────
      if (current.incomingSynapses.has(nextId) && !current.synaptome.has(nextId)) {
        const inc = current.incomingSynapses.get(nextId);
        inc.useCount = (inc.useCount ?? 0) + 1;
        if (inc.useCount >= this.INCOMING_PROMOTE_THRESH) {
          const syn = new Synapse({ peerId: nextId, latencyMs: inc.latency, stratum: inc.stratum });
          syn.weight = 0.5;
          if (this._addOrEvict(current, syn)) {
            current.incomingSynapses.delete(nextId);
          }
        }
      }

      queried.add(nextId);
      path.push(nextId);
      trace.push({ fromId: currentId, synapse: nextSyn });
      totalTimeMs += nextSyn.latency;

      // ── Hop caching (with eviction via overridden _hopCache) ───────────
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

  // ── Stats ───────────────────────────────────────────────────────────────────

  getStats() {
    return { ...super.getStats(), protocol: 'Neuromorphic-NS5' };
  }
}

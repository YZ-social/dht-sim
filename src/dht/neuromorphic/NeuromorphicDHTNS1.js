/**
 * NeuromorphicDHTNS1 (NS-1) – Simplified Neuromorphic Protocol
 *
 * Distilled from the NX-4 through NX-12 line, keeping only the features
 * that testing proved essential:
 *
 *  1. Synaptome + incomingSynapses (NeuronNode architecture)
 *  2. AP routing with two-hop lookahead
 *  3. Iterative fallback (from NX-4)
 *  4. Dead-synapse eviction + 2-hop replacement (from NX-6)
 *  5. Simple weights: LTP reinforcement + fixed-rate decay
 *  6. Minimal annealing (temperature-based 2-hop exploration)
 *  7. Incoming synapse promotion (from NX-5)
 *  8. Realistic bootstrapJoin with geo-prefix discovery
 *
 * Removed (no measurable impact in testing):
 *  - Two-tier highway          - Triadic closure
 *  - Hop caching / backprop    - Lateral spread
 *  - Markov prediction         - Stratified eviction
 *  - Highway refresh           - Load balancing
 *  - Churn reheat
 *
 * Config: 8 parameters (down from NX-6's 44).
 */

import { DHT }          from '../DHT.js';
import { Synapse }      from './Synapse.js';
import { NeuronNode }   from './NeuronNode.js';
import { randomU64, clz64, roundTripLatency, buildXorRoutingTable }
                         from '../../utils/geo.js';

export class NeuromorphicDHTNS1 extends DHT {
  static get protocolName() { return 'Neuromorphic-NS1'; }

  constructor(config = {}) {
    super(config);
    this.nodeMap           = new Map();
    this.simEpoch          = 0;
    this.lookupsSinceDecay = 0;
    this._k                = config.k ?? 20;
    this._alpha            = config.alpha ?? 3;
    this._emaHops          = null;
    this._emaTime          = null;

    // ── 8 config parameters ──────────────────────────────────────────────
    const r = config.rules ?? {};
    this.MAX_SYNAPTOME    = r.maxSynaptomeSize   ?? 50;
    this.WEIGHT_SCALE     = r.weightScale         ?? 0.40;
    this.LOOKAHEAD_ALPHA  = r.lookaheadAlpha      ?? 5;
    this.EPSILON          = r.explorationEpsilon   ?? 0.05;
    this.MAX_HOPS         = r.maxGreedyHops        ?? 40;
    this.DECAY_GAMMA      = r.decayGamma           ?? 0.995;
    this.PRUNE_THRESHOLD  = r.pruneThreshold       ?? 0.05;
    this.ANNEAL_COOLING   = r.annealCooling        ?? 0.9997;

    // Fixed constants (not configurable — good defaults)
    this.DECAY_INTERVAL         = 100;
    this.T_INIT                 = 1.0;
    this.T_MIN                  = 0.05;
    this.INERTIA_DURATION       = 20;
    this.INCOMING_PROMOTE_THRESH = 2;
    this.GEO_BITS               = 8;
    this.GEO_REGION_BITS        = 4;
    this.ANNEAL_LOCAL_SAMPLE    = 50;
    this.STRATA_GROUPS          = 16;
  }

  // ── Node lifecycle ──────────────────────────────────────────────────────────

  async addNode(lat, lng) {
    const id   = randomU64();
    const node = new NeuronNode({ id, lat, lng });
    node._nodeMapRef = this.nodeMap;
    node.temperature = this.T_INIT;
    this.nodeMap.set(id, node);
    this.network.addNode(node);
    return node;
  }

  async removeNode(nodeId) {
    const node = this.nodeMap.get(nodeId);
    if (!node) return;
    node.alive = false;
    // Node is simply gone. Neighbors discover the failure when they next
    // try to route through it — dead-synapse eviction in lookup() handles
    // the repair. No walking the dying node's state (unrealistic).
    this.network.removeNode(nodeId);
    this.nodeMap.delete(nodeId);
  }

  // ── Initial routing table construction ──────────────────────────────────────

  buildRoutingTables({ bidirectional = true, maxConnections = Infinity } = {}) {
    super.buildRoutingTables({ bidirectional, maxConnections });
    if (isFinite(maxConnections) && maxConnections < this.MAX_SYNAPTOME) {
      this.MAX_SYNAPTOME = maxConnections;
    }

    const k      = this._k;
    const sorted = [...this.nodeMap.values()].sort(
      (a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    );

    for (const node of sorted) {
      for (const peer of buildXorRoutingTable(node.id, sorted, k, maxConnections)) {
        const latMs   = roundTripLatency(node, peer);
        const stratum = clz64(node.id ^ peer.id);
        const syn     = new Synapse({ peerId: peer.id, latencyMs: latMs, stratum });
        node.addSynapse(syn);
        if (bidirectional) peer.addIncomingSynapse(node.id, latMs, stratum);
      }
      node._nodeMapRef = this.nodeMap;
    }
  }

  // ── Churn bootstrap (Engine calls this for new nodes during churn) ─────────

  bootstrapNode(newNode, sorted, k = 20) {
    if (!sorted?.length || !newNode?.alive) return;
    const maxConn = this.MAX_SYNAPTOME;
    const bidir   = this.bidirectional;

    for (const peer of buildXorRoutingTable(newNode.id, sorted, k, maxConn)) {
      const latMs   = roundTripLatency(newNode, peer);
      const stratum = clz64(newNode.id ^ peer.id);
      const syn     = new Synapse({ peerId: peer.id, latencyMs: latMs, stratum });
      syn.weight    = 0.5;
      newNode.addSynapse(syn);
      if (bidir) peer.addIncomingSynapse(newNode.id, latMs, stratum);
    }
    newNode._nodeMapRef = this.nodeMap;
  }

  // ── Realistic bootstrap join (iterative self-lookup + geo-prefix) ──────────

  bootstrapJoin(newNodeId, sponsorId) {
    const newNode = this.nodeMap.get(newNodeId);
    const sponsor = this.nodeMap.get(sponsorId);
    if (!newNode || !sponsor) return 0;

    const k      = this._k;
    const alpha  = this._alpha;
    const synCap = this.MAX_SYNAPTOME;

    const addPeer = (peer) => {
      if (peer.id === newNodeId || newNode.synaptome.has(peer.id)) return;
      if (newNode.synaptome.size >= synCap) return;
      const latMs   = roundTripLatency(newNode, peer);
      const stratum = clz64(newNode.id ^ peer.id);
      const syn     = new Synapse({ peerId: peer.id, latencyMs: latMs, stratum });
      newNode.addSynapse(syn);
      if (this.bidirectional) peer.addIncomingSynapse(newNode.id, latMs, stratum);
    };

    const findClosest = (node, targetId) => {
      const peers = [];
      const seen  = new Set();
      for (const syn of node.synaptome.values()) {
        const p = this.nodeMap.get(syn.peerId);
        if (p?.alive && !seen.has(p.id)) { seen.add(p.id); peers.push(p); }
      }
      for (const syn of node.incomingSynapses.values()) {
        const p = this.nodeMap.get(syn.peerId);
        if (p?.alive && !seen.has(p.id)) { seen.add(p.id); peers.push(p); }
      }
      peers.sort((a, b) => {
        const da = a.id ^ targetId, db = b.id ^ targetId;
        return da < db ? -1 : da > db ? 1 : 0;
      });
      return peers.slice(0, k);
    };

    const iterLookup = (targetId, startNode, maxRounds) => {
      const queried = new Set([newNodeId]);
      let shortlist = findClosest(startNode, targetId);
      for (const p of shortlist) addPeer(p);

      for (let round = 0; round < maxRounds; round++) {
        const unq = shortlist.filter(n => !queried.has(n.id)).slice(0, alpha);
        if (unq.length === 0) break;
        let improved = false;
        for (const peer of unq) {
          queried.add(peer.id);
          for (const cand of findClosest(peer, targetId)) {
            if (cand.id !== newNodeId && !queried.has(cand.id)) {
              addPeer(cand);
              if (!shortlist.some(n => n.id === cand.id)) {
                shortlist.push(cand);
                improved = true;
              }
            }
          }
        }
        shortlist.sort((a, b) => {
          const da = a.id ^ targetId, db = b.id ^ targetId;
          return da < db ? -1 : da > db ? 1 : 0;
        });
        shortlist = shortlist.slice(0, k);
        if (!improved) break;
      }
    };

    // Phase 1: self-lookup from sponsor
    addPeer(sponsor);
    iterLookup(newNodeId, sponsor, 10);

    // Phase 2: geo-prefix flipped lookups from newNode (now has Phase 1 peers)
    const shift = BigInt(64 - this.GEO_BITS);
    for (let bit = 0; bit < this.GEO_BITS; bit++) {
      iterLookup(newNodeId ^ (1n << (shift + BigInt(bit))), newNode, 2);
    }

    newNode._nodeMapRef = this.nodeMap;
    newNode.temperature = this.T_INIT;
    return newNode.synaptome.size;
  }

  // ── Routing ─────────────────────────────────────────────────────────────────

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

      // ── Iterative fallback (NX-4) ──────────────────────────────────────
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

      // Direct synapse to target?
      const direct = current.synaptome.get(targetKey)
                  ?? current.incomingSynapses.get(targetKey);
      if (direct && this.nodeMap.get(targetKey)?.alive) {
        nextSyn = direct;
      }

      // Epsilon-greedy exploration (first hop only)
      if (!nextSyn && hop === 0 && Math.random() < this.EPSILON) {
        nextSyn = candidates[Math.floor(Math.random() * candidates.length)];
      }

      // Two-hop lookahead AP scoring
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

  // ── Two-hop lookahead AP selection ──────────────────────────────────────────

  _bestByTwoHopAP(current, candidates, targetKey, currentDist, wScale) {
    // Rank by single-hop AP, take top α for two-hop probe
    const ranked = candidates.map(s => {
      const pd = s.peerId ^ targetKey;
      const ap = (Number(currentDist - pd) / s.latency) * (1 + wScale * s.weight);
      return { s, ap };
    }).sort((a, b) => b.ap - a.ap);

    const probeSet = ranked.slice(0, this.LOOKAHEAD_ALPHA).map(x => x.s);
    let bestSyn = null, bestAP2 = -Infinity;

    for (const first of probeSet) {
      const firstDist = first.peerId ^ targetKey;
      if (firstDist === 0n) return first;

      const firstNode = this.nodeMap.get(first.peerId);
      if (!firstNode?.alive) continue;

      // Find best second hop from firstNode's synaptome
      const fwd = [];
      for (const fs of firstNode.synaptome.values()) {
        if ((fs.peerId ^ targetKey) < firstDist && this.nodeMap.get(fs.peerId)?.alive)
          fwd.push(fs);
      }

      let twoHopDist, secondLat;
      if (fwd.length === 0) {
        twoHopDist = firstDist;
        secondLat  = 0;
      } else {
        const best2 = firstNode.bestByAP(fwd, targetKey, wScale);
        twoHopDist = best2.peerId ^ targetKey;
        secondLat  = best2.latency;
      }

      const progress = Number(currentDist - twoHopDist);
      const totalLat = first.latency + secondLat;
      const ap2      = (progress / totalLat) * (1 + wScale * first.weight);

      if (ap2 > bestAP2) { bestAP2 = ap2; bestSyn = first; }
    }

    return bestSyn ?? current.bestByAP(candidates, targetKey, wScale);
  }

  // ── Dead-synapse eviction + replacement ─────────────────────────────────────

  _evictAndReplace(node, deadSyn) {
    const stratum = deadSyn.stratum;
    node.synaptome.delete(deadSyn.peerId);

    const group = Math.min(this.STRATA_GROUPS - 1, stratum >>> 2);
    const lo = group * 4, hi = lo + 3;

    const candidate = this._localCandidate(node, lo, hi);
    if (!candidate || node.synaptome.has(candidate.id)) return null;

    // Replacement weight = median of existing synapses
    const weights = [];
    for (const s of node.synaptome.values()) weights.push(s.weight);
    weights.sort((a, b) => a - b);
    const medW = weights.length > 0 ? weights[weights.length >> 1] : this.PRUNE_THRESHOLD;

    const latMs      = roundTripLatency(node, candidate);
    const newStratum = clz64(node.id ^ candidate.id);
    const syn        = new Synapse({ peerId: candidate.id, latencyMs: latMs, stratum: newStratum });
    syn.weight       = medW;
    node.addSynapse(syn);
    return syn;
  }

  // ── 2-hop neighborhood candidate search ─────────────────────────────────────

  _localCandidate(node, lo, hi) {
    const candidates = [];
    outer:
    for (const syn of node.synaptome.values()) {
      const peer = this.nodeMap.get(syn.peerId);
      if (!peer?.alive) continue;
      for (const peerSyn of peer.synaptome.values()) {
        const id = peerSyn.peerId;
        if (id === node.id || node.synaptome.has(id)) continue;
        const c = this.nodeMap.get(id);
        if (!c?.alive) continue;
        if (clz64(node.id ^ id) >= lo && clz64(node.id ^ id) <= hi) {
          candidates.push(c);
          if (candidates.length >= this.ANNEAL_LOCAL_SAMPLE) break outer;
        }
      }
    }
    return candidates.length > 0
      ? candidates[Math.floor(Math.random() * candidates.length)]
      : null;
  }

  // ── Simple annealing ────────────────────────────────────────────────────────

  _tryAnneal(node) {
    if (node.synaptome.size === 0) return;

    // Find weakest synapse
    let weakest = null, weakW = Infinity;
    for (const s of node.synaptome.values()) {
      if (s.inertia > this.simEpoch) continue;   // skip LTP-locked
      if (s.weight < weakW) { weakW = s.weight; weakest = s; }
    }
    if (!weakest) return;

    // Find replacement from 2-hop neighborhood in same stratum group
    const group = Math.min(this.STRATA_GROUPS - 1, weakest.stratum >>> 2);
    const candidate = this._localCandidate(node, group * 4, group * 4 + 3);
    if (!candidate || node.synaptome.has(candidate.id)) return;

    // Replace
    node.synaptome.delete(weakest.peerId);
    const latMs   = roundTripLatency(node, candidate);
    const stratum = clz64(node.id ^ candidate.id);
    const syn     = new Synapse({ peerId: candidate.id, latencyMs: latMs, stratum });
    syn.weight    = 0.1;   // must prove itself
    node.addSynapse(syn);
  }

  // ── Fixed-rate decay ────────────────────────────────────────────────────────

  _tickDecay() {
    for (const node of this.nodeMap.values()) {
      if (!node.alive) continue;
      const toPrune = [];
      for (const syn of node.synaptome.values()) {
        if (syn.inertia > this.simEpoch) continue;
        syn.decay(this.DECAY_GAMMA);
        if (syn.weight < this.PRUNE_THRESHOLD) toPrune.push(syn);
      }
      // Prune below threshold but maintain minimum synaptome size
      if (node.synaptome.size > this.MAX_SYNAPTOME) {
        for (const syn of toPrune) node.synaptome.delete(syn.peerId);
      }
    }
  }

  // ── LTP reinforcement wave ──────────────────────────────────────────────────

  _reinforceWave(trace) {
    for (let i = trace.length - 1; i >= 0; i--) {
      const { fromId, synapse } = trace[i];
      const node = this.nodeMap.get(fromId);
      if (!node) continue;
      const syn = node.synaptome.get(synapse.peerId);
      if (syn) {
        syn.reinforce(this.simEpoch, this.INERTIA_DURATION);
        syn.useCount = (syn.useCount ?? 0) + 1;
      }
    }
  }

  // ── Stats ───────────────────────────────────────────────────────────────────

  getStats() {
    const base  = super.getStats();
    const nodes = [...this.nodeMap.values()];
    const avgSyn = nodes.length
      ? (nodes.reduce((a, n) => a + n.synaptome.size, 0) / nodes.length).toFixed(1)
      : 0;
    const avgTemp = nodes.length
      ? (nodes.reduce((a, n) => a + (n.temperature ?? this.T_INIT), 0) / nodes.length).toFixed(3)
      : '—';

    return {
      ...base,
      protocol:    'Neuromorphic-NS1',
      epoch:       this.simEpoch,
      avgSynapses: avgSyn,
      avgTemp,
    };
  }
}

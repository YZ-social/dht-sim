/**
 * NeuromorphicDHTNH1 (NH-1) — Neuro-Homeostatic Protocol
 *
 * Implements five fundamental operations through a unified vitality model:
 *
 *   NAVIGATE — AP routing with two-hop lookahead + iterative fallback
 *   LEARN    — LTP reinforcement, hop caching, triadic closure, incoming promotion
 *   FORGET   — continuous weight decay, vitality-based eviction
 *   EXPLORE  — temperature-controlled annealing, epsilon-greedy first hop
 *   STRUCTURE — diversity budget penalizes over-represented strata
 *
 * Vitality model:
 *   vitality(syn) = weight × recency(syn) × diversity(syn)
 *
 *   - weight:    [0,1] trained by LTP, decayed over time
 *   - recency:   exponential decay from last reinforcement (uses inertia field)
 *   - diversity:  1/(1+excess) penalty for over-represented stratum groups
 *
 * A single _addByVitality() method handles all admission decisions.
 * 12 parameters, each controlling a behavioral axis.
 */

import { DHT }          from '../DHT.js';
import { Synapse }      from './Synapse.js';
import { NeuronNode }   from './NeuronNode.js';
import { randomU64, clz64, roundTripLatency, buildXorRoutingTable }
                         from '../../utils/geo.js';

export class NeuromorphicDHTNH1 extends DHT {
  static get protocolName() { return 'Neuromorphic-NH1'; }

  constructor(config = {}) {
    super(config);
    this.nodeMap           = new Map();
    this.simEpoch          = 0;
    this.lookupsSinceDecay = 0;
    this._k                = config.k ?? 20;
    this._alpha            = config.alpha ?? 3;
    this._emaHops          = null;
    this._emaTime          = null;

    const r = config.rules ?? {};

    // ── Parameters — one per behavioral axis ────────────────────────────
    // STRUCTURE
    this.MAX_SYNAPTOME      = r.maxSynaptome       ?? 50;
    this.DIVERSITY_BUDGET   = r.diversityBudget     ?? 4;
    // NAVIGATE
    this.WEIGHT_SCALE       = r.weightScale         ?? 0.40;
    this.LOOKAHEAD_ALPHA    = r.lookaheadAlpha      ?? 5;
    this.MAX_HOPS           = r.maxHops             ?? 40;
    // EXPLORE
    this.EPSILON            = r.epsilon             ?? 0.05;
    this.ANNEAL_COOLING     = r.annealCooling       ?? 0.9997;
    // FORGET
    this.DECAY_GAMMA        = r.decayGamma          ?? 0.995;
    this.VITALITY_FLOOR     = r.vitalityFloor       ?? 0.05;
    this.EN_ADAPTIVE_DECAY  = r.adaptiveDecay       ?? false;
    this.DECAY_GAMMA_MIN    = r.decayGammaMin       ?? 0.990;
    this.DECAY_GAMMA_MAX    = r.decayGammaMax        ?? 0.9998;
    this.USE_SATURATION     = r.useSaturation       ?? 20;
    // LEARN
    this.INERTIA_DURATION   = r.inertiaDuration     ?? 20;
    this.PROMOTE_THRESHOLD  = r.promoteThreshold    ?? 2;
    this.TRIADIC_THRESHOLD  = r.triadicThreshold    ?? 2;
    this.EN_LATERAL_SPREAD  = r.lateralSpread       ?? false;
    this.LATERAL_K          = r.lateralK            ?? 6;

    // ── Fixed constants ──────────────────────────────────────────────────
    this.DECAY_INTERVAL      = 100;
    this.T_INIT              = 1.0;
    this.T_MIN               = 0.05;
    this.T_REHEAT            = 0.5;
    this.GEO_BITS            = 8;
    this.GEO_REGION_BITS     = r.geoRegionBits ?? 4;
    this.STRATA_GROUPS       = 16;
    this.ANNEAL_LOCAL_SAMPLE = 50;
    this.RECENCY_HALF_LIFE   = r.recencyHalfLife ?? 50;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Node Lifecycle
  // ═══════════════════════════════════════════════════════════════════════════

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
    this.network.removeNode(nodeId);
    this.nodeMap.delete(nodeId);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STRUCTURE: Bootstrap
  // ═══════════════════════════════════════════════════════════════════════════

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

  bootstrapNode(newNode, sorted, k = 20) {
    if (!sorted?.length || !newNode?.alive) return;
    const bidir = this.bidirectional;
    for (const peer of buildXorRoutingTable(newNode.id, sorted, k, this.MAX_SYNAPTOME)) {
      const latMs   = roundTripLatency(newNode, peer);
      const stratum = clz64(newNode.id ^ peer.id);
      const syn     = new Synapse({ peerId: peer.id, latencyMs: latMs, stratum });
      syn.weight    = 0.5;
      newNode.addSynapse(syn);
      if (bidir) peer.addIncomingSynapse(newNode.id, latMs, stratum);
    }
    newNode._nodeMapRef = this.nodeMap;
  }

  bootstrapJoin(newNodeId, sponsorId) {
    const newNode = this.nodeMap.get(newNodeId);
    const sponsor = this.nodeMap.get(sponsorId);
    if (!newNode || !sponsor) return 0;

    const k = this._k, alpha = this._alpha;

    const addPeer = (peer) => {
      if (peer.id === newNodeId || newNode.synaptome.has(peer.id)) return;
      if (newNode.synaptome.size >= this.MAX_SYNAPTOME) return;
      const latMs   = roundTripLatency(newNode, peer);
      const stratum = clz64(newNode.id ^ peer.id);
      const syn     = new Synapse({ peerId: peer.id, latencyMs: latMs, stratum });
      newNode.addSynapse(syn);
      if (this.bidirectional) peer.addIncomingSynapse(newNode.id, latMs, stratum);
    };

    const findClosest = (node, targetId) => {
      const peers = [], seen = new Set();
      for (const s of node.synaptome.values()) {
        const p = this.nodeMap.get(s.peerId);
        if (p?.alive && !seen.has(p.id)) { seen.add(p.id); peers.push(p); }
      }
      for (const s of node.incomingSynapses.values()) {
        const p = this.nodeMap.get(s.peerId);
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
        if (!unq.length) break;
        let improved = false;
        for (const peer of unq) {
          queried.add(peer.id);
          for (const c of findClosest(peer, targetId)) {
            if (c.id !== newNodeId && !queried.has(c.id)) {
              addPeer(c);
              if (!shortlist.some(n => n.id === c.id)) { shortlist.push(c); improved = true; }
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

    addPeer(sponsor);
    iterLookup(newNodeId, sponsor, 10);
    const shift = BigInt(64 - this.GEO_BITS);
    for (let bit = 0; bit < this.GEO_BITS; bit++) {
      iterLookup(newNodeId ^ (1n << (shift + BigInt(bit))), newNode, 2);
    }
    newNode._nodeMapRef = this.nodeMap;
    newNode.temperature = this.T_INIT;
    return newNode.synaptome.size;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Routing — The Five Operations
  // ═══════════════════════════════════════════════════════════════════════════

  async lookup(sourceId, targetKey) {
    const source = this.nodeMap.get(sourceId);
    if (!source || !source.alive) return null;

    this.simEpoch++;
    if (++this.lookupsSinceDecay >= this.DECAY_INTERVAL) {
      this._tickDecay();                              // FORGET: periodic
      this.lookupsSinceDecay = 0;
    }

    const path = [sourceId], trace = [], queried = new Set([sourceId]);
    let currentId = sourceId, totalTimeMs = 0, reached = false;

    for (let hop = 0; hop < this.MAX_HOPS; hop++) {
      const current = this.nodeMap.get(currentId);
      if (!current || !current.alive) break;

      const currentDist = current.id ^ targetKey;
      if (currentDist === 0n) { reached = true; break; }

      // ── NAVIGATE: collect forward-progress candidates ──────────────────
      const deadSynapses = [], candidates = [];

      for (const s of current.synaptome.values()) {
        if ((s.peerId ^ targetKey) >= currentDist) continue;
        const peer = this.nodeMap.get(s.peerId);
        if (!peer?.alive) { deadSynapses.push(s); s.weight = 0; continue; }
        candidates.push(s);
      }
      for (const s of current.incomingSynapses.values()) {
        if ((s.peerId ^ targetKey) >= currentDist) continue;
        if (this.nodeMap.get(s.peerId)?.alive) candidates.push(s);
      }

      // ── FORGET: dead-synapse eviction + replacement ────────────────────
      if (deadSynapses.length > 0) {
        current.temperature = Math.max(current.temperature, this.T_REHEAT);
        for (const syn of deadSynapses) {
          const repl = this._evictAndReplace(current, syn);
          if (repl && (repl.peerId ^ targetKey) < currentDist) candidates.push(repl);
        }
      }

      // ── NAVIGATE: iterative fallback ───────────────────────────────────
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

      // ── NAVIGATE: select next hop ──────────────────────────────────────
      let nextSyn;

      const direct = current.synaptome.get(targetKey)
                  ?? current.incomingSynapses.get(targetKey);
      if (direct && this.nodeMap.get(targetKey)?.alive) nextSyn = direct;

      if (!nextSyn && hop === 0 && Math.random() < this.EPSILON) {
        nextSyn = candidates[Math.floor(Math.random() * candidates.length)];
      }

      if (!nextSyn) {
        const inRegion = ((current.id ^ targetKey) >> BigInt(64 - this.GEO_REGION_BITS)) === 0n;
        nextSyn = this._bestByTwoHopAP(current, candidates, targetKey, currentDist,
          inRegion ? this.WEIGHT_SCALE : 0);
      }

      const nextId = nextSyn.peerId;
      if (!this.nodeMap.get(nextId)) break;

      // ── LEARN: incoming promotion ──────────────────────────────────────
      if (current.incomingSynapses.has(nextId) && !current.synaptome.has(nextId)) {
        const inc = current.incomingSynapses.get(nextId);
        inc.useCount = (inc.useCount ?? 0) + 1;
        if (inc.useCount >= this.PROMOTE_THRESHOLD) {
          const syn = new Synapse({ peerId: nextId, latencyMs: inc.latency, stratum: inc.stratum });
          syn.weight = 0.5;
          syn.inertia = this.simEpoch;  // fresh recency
          if (this._addByVitality(current, syn)) current.incomingSynapses.delete(nextId);
        }
      }

      queried.add(nextId);
      path.push(nextId);
      trace.push({ fromId: currentId, synapse: nextSyn });
      totalTimeMs += nextSyn.latency;

      // ── LEARN: hop caching ─────────────────────────────────────────────
      if (currentId !== targetKey) this._hopCache(currentId, targetKey);

      // ── LEARN: triadic closure ─────────────────────────────────────────
      if (currentId !== sourceId) this._recordTransit(current, sourceId, nextId);

      // ── EXPLORE: annealing ─────────────────────────────────────────────
      current.temperature = Math.max(this.T_MIN, current.temperature * this.ANNEAL_COOLING);
      if (Math.random() < current.temperature) this._tryAnneal(current);

      currentId = nextId;
    }

    // ── LEARN: LTP reinforcement on fast paths ───────────────────────────
    if (reached) {
      const hopCount = path.length - 1;
      this._emaHops = this._emaHops === null ? hopCount : 0.9 * this._emaHops + 0.1 * hopCount;
      this._emaTime = this._emaTime === null ? totalTimeMs : 0.9 * this._emaTime + 0.1 * totalTimeMs;
      if (trace.length > 0 && totalTimeMs <= this._emaTime) this._reinforceWave(trace);
    }

    return { path, hops: path.length - 1, time: totalTimeMs, found: reached };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // NAVIGATE: Two-hop lookahead AP selection
  // ═══════════════════════════════════════════════════════════════════════════

  _bestByTwoHopAP(current, candidates, targetKey, currentDist, wScale) {
    const ranked = candidates.map(s => {
      const ap = (Number(currentDist - (s.peerId ^ targetKey)) / s.latency)
              * (1 + wScale * s.weight);
      return { s, ap };
    }).sort((a, b) => b.ap - a.ap);

    const probeSet = ranked.slice(0, this.LOOKAHEAD_ALPHA).map(x => x.s);
    let bestSyn = null, bestAP2 = -Infinity;

    for (const first of probeSet) {
      const firstDist = first.peerId ^ targetKey;
      if (firstDist === 0n) return first;
      const firstNode = this.nodeMap.get(first.peerId);
      if (!firstNode?.alive) continue;

      const fwd = [];
      for (const fs of firstNode.synaptome.values()) {
        if ((fs.peerId ^ targetKey) < firstDist && this.nodeMap.get(fs.peerId)?.alive)
          fwd.push(fs);
      }

      let twoHopDist, secondLat;
      if (!fwd.length) { twoHopDist = firstDist; secondLat = 0; }
      else {
        const best2 = firstNode.bestByAP(fwd, targetKey, wScale);
        twoHopDist = best2.peerId ^ targetKey;
        secondLat  = best2.latency;
      }

      const ap2 = (Number(currentDist - twoHopDist) / (first.latency + secondLat))
               * (1 + wScale * first.weight);
      if (ap2 > bestAP2) { bestAP2 = ap2; bestSyn = first; }
    }
    return bestSyn ?? current.bestByAP(candidates, targetKey, wScale);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Vitality Model — The Unified Admission Gate
  // ═══════════════════════════════════════════════════════════════════════════

  /** Compute dynamic vitality: weight × recency × diversity */
  _vitality(node, syn) {
    // Recency: exponential decay from last reinforcement
    let recency;
    if (syn.inertia > this.simEpoch) {
      recency = 1.0;  // LTP-locked: full recency
    } else {
      const elapsed = this.simEpoch - syn.inertia;
      recency = Math.max(0.1, Math.exp(-elapsed / this.RECENCY_HALF_LIFE));
    }

    // Diversity: penalty for over-represented stratum groups
    const group = Math.min(this.STRATA_GROUPS - 1, syn.stratum >>> 2);
    let groupCount = 0;
    for (const s of node.synaptome.values()) {
      if (Math.min(this.STRATA_GROUPS - 1, s.stratum >>> 2) === group) groupCount++;
    }
    const excess = Math.max(0, groupCount - this.DIVERSITY_BUDGET);
    const diversity = 1.0 / (1 + excess);

    return syn.weight * recency * diversity;
  }

  /** Add synapse, evicting lowest-vitality if full. */
  _addByVitality(node, newSyn) {
    if (node.synaptome.size < this.MAX_SYNAPTOME) {
      node.addSynapse(newSyn);
      return true;
    }

    // Hybrid: vitality selects the SMARTEST victim (diversity-aware),
    // weight comparison gates admission (safe, proven by NS-5).
    let victim = null, minV = Infinity;
    for (const s of node.synaptome.values()) {
      if (s.inertia > this.simEpoch) continue;  // LTP-locked: protected
      const v = this._vitality(node, s);
      if (v < minV) { minV = v; victim = s; }
    }
    if (!victim || victim.weight >= newSyn.weight) return false;

    node.synaptome.delete(victim.peerId);
    node.addSynapse(newSyn);
    return true;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // LEARN: LTP Reinforcement
  // ═══════════════════════════════════════════════════════════════════════════

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

  // ═══════════════════════════════════════════════════════════════════════════
  // LEARN: Triadic Closure
  // ═══════════════════════════════════════════════════════════════════════════

  _recordTransit(node, originId, nextId) {
    const key   = `${originId}_${nextId}`;
    const count = (node.transitCache.get(key) ?? 0) + 1;
    if (count >= this.TRIADIC_THRESHOLD) {
      node.transitCache.delete(key);
      this._introduce(originId, nextId);
    } else {
      node.transitCache.set(key, count);
    }
  }

  _introduce(aId, cId) {
    const nodeA = this.nodeMap.get(aId);
    const nodeC = this.nodeMap.get(cId);
    if (!nodeA || !nodeC || !nodeA.alive || !nodeC.alive) return;
    if (nodeA.synaptome.has(cId)) return;
    const latMs   = roundTripLatency(nodeA, nodeC);
    const stratum = clz64(nodeA.id ^ nodeC.id);
    const syn     = new Synapse({ peerId: cId, latencyMs: latMs, stratum });
    syn.weight    = 0.5;
    syn.inertia   = this.simEpoch;  // fresh recency
    this._addByVitality(nodeA, syn);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // LEARN: Hop Caching
  // ═══════════════════════════════════════════════════════════════════════════

  _hopCache(nodeId, targetId, depth = 0) {
    const node   = this.nodeMap.get(nodeId);
    const target = this.nodeMap.get(targetId);
    if (!node || !target || !node.alive || !target.alive) return;
    if (!node.synaptome.has(targetId)) {
      const latMs   = roundTripLatency(node, target);
      const stratum = clz64(node.id ^ target.id);
      const syn     = new Synapse({ peerId: targetId, latencyMs: latMs, stratum });
      syn.weight    = 0.3;
      syn.inertia   = this.simEpoch;  // fresh recency so vitality comparison is fair
      const added   = this._addByVitality(node, syn);

      // Lateral spread: propagate to geographic neighbors (same top-4 geo bits)
      if (this.EN_LATERAL_SPREAD && added && depth === 0) {
        const nodeRegion = node.id >> BigInt(64 - this.GEO_REGION_BITS);
        const regional = [];
        for (const s of node.synaptome.values()) {
          if (s.peerId === targetId) continue;
          const peer = this.nodeMap.get(s.peerId);
          if (!peer?.alive) continue;
          if ((s.peerId >> BigInt(64 - this.GEO_REGION_BITS)) === nodeRegion) {
            regional.push(s);
          }
        }
        regional.sort((a, b) => b.weight - a.weight);
        for (let i = 0; i < Math.min(this.LATERAL_K, regional.length); i++) {
          this._hopCache(regional[i].peerId, targetId, 1);
        }
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // FORGET: Periodic Decay + Vitality Pruning
  // ═══════════════════════════════════════════════════════════════════════════

  _tickDecay() {
    for (const node of this.nodeMap.values()) {
      if (!node.alive) continue;
      const toPrune = [];
      for (const syn of node.synaptome.values()) {
        if (syn.inertia > this.simEpoch) continue;  // LTP-locked: skip

        let gamma;
        if (this.EN_ADAPTIVE_DECAY) {
          // Usage-based: heavily-used synapses decay slower
          const useFrac = Math.min(1, (syn.useCount ?? 0) / this.USE_SATURATION);
          gamma = this.DECAY_GAMMA_MIN
                + (this.DECAY_GAMMA_MAX - this.DECAY_GAMMA_MIN) * useFrac;
          // Bootstrap synapses blend toward max gamma (slower decay)
          if (syn.bootstrap) gamma = gamma + (this.DECAY_GAMMA_MAX - gamma) * 0.5;
        } else {
          gamma = this.DECAY_GAMMA;
        }

        syn.decay(gamma);
      }
      // Never delete synapses during decay — only weaken them.
      // Eviction happens through _addByVitality when new connections are learned.
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // EXPLORE: Annealing
  // ═══════════════════════════════════════════════════════════════════════════

  _tryAnneal(node) {
    if (!node.alive || node.synaptome.size === 0) return;

    // Find weakest synapse by weight (skip LTP-locked)
    let victim = null, weakW = Infinity;
    for (const s of node.synaptome.values()) {
      if (s.inertia > this.simEpoch) continue;
      if (s.weight < weakW) { weakW = s.weight; victim = s; }
    }
    if (!victim) return;

    // Target under-represented stratum group
    const counts = new Array(this.STRATA_GROUPS).fill(0);
    for (const s of node.synaptome.values()) {
      counts[Math.min(this.STRATA_GROUPS - 1, s.stratum >>> 2)]++;
    }
    let targetGroup = 0, minCount = Infinity;
    for (let g = 0; g < this.STRATA_GROUPS; g++) {
      if (counts[g] < minCount) { minCount = counts[g]; targetGroup = g; }
    }

    const lo = targetGroup * 4, hi = lo + 3;
    const candidate = this._localCandidate(node, lo, hi);
    if (!candidate || node.synaptome.has(candidate.id)) return;

    node.synaptome.delete(victim.peerId);
    const latMs   = roundTripLatency(node, candidate);
    const stratum = clz64(node.id ^ candidate.id);
    const syn     = new Synapse({ peerId: candidate.id, latencyMs: latMs, stratum });
    syn.weight    = 0.1;
    node.addSynapse(syn);
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // STRUCTURE: Dead-synapse Replacement + 2-hop Search
  // ═══════════════════════════════════════════════════════════════════════════

  _evictAndReplace(node, deadSyn) {
    node.synaptome.delete(deadSyn.peerId);
    const group = Math.min(this.STRATA_GROUPS - 1, deadSyn.stratum >>> 2);
    const candidate = this._localCandidate(node, group * 4, group * 4 + 3);
    if (!candidate || node.synaptome.has(candidate.id)) return null;

    const weights = [];
    for (const s of node.synaptome.values()) weights.push(s.weight);
    weights.sort((a, b) => a - b);
    const medW = weights.length > 0 ? weights[weights.length >> 1] : this.VITALITY_FLOOR;

    const latMs   = roundTripLatency(node, candidate);
    const stratum = clz64(node.id ^ candidate.id);
    const syn     = new Synapse({ peerId: candidate.id, latencyMs: latMs, stratum });
    syn.weight    = medW;
    node.addSynapse(syn);
    return syn;
  }

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
        const stratum = clz64(node.id ^ id);
        if (stratum >= lo && stratum <= hi) {
          candidates.push(c);
          if (candidates.length >= this.ANNEAL_LOCAL_SAMPLE) break outer;
        }
      }
    }
    return candidates.length > 0
      ? candidates[Math.floor(Math.random() * candidates.length)]
      : null;
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Honest Churn Heal (each node checks its own synapses)
  // ═══════════════════════════════════════════════════════════════════════════

  postChurnHeal() {
    for (const node of this.nodeMap.values()) {
      if (!node.alive) continue;
      const dead = [];
      for (const syn of node.synaptome.values()) {
        if (!this.nodeMap.get(syn.peerId)?.alive) dead.push(syn);
      }
      for (const syn of dead) this._evictAndReplace(node, syn);
      for (const [peerId] of node.incomingSynapses) {
        if (!this.nodeMap.get(peerId)?.alive) node.incomingSynapses.delete(peerId);
      }
      if (dead.length > 0) {
        node.temperature = Math.max(node.temperature, this.T_REHEAT);
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Stats
  // ═══════════════════════════════════════════════════════════════════════════

  getStats() {
    const base  = super.getStats();
    const nodes = [...this.nodeMap.values()];
    const avgSyn = nodes.length
      ? (nodes.reduce((a, n) => a + n.synaptome.size, 0) / nodes.length).toFixed(1) : 0;
    const avgTemp = nodes.length
      ? (nodes.reduce((a, n) => a + (n.temperature ?? this.T_INIT), 0) / nodes.length).toFixed(3)
      : '—';
    return { ...base, protocol: 'Neuromorphic-NH1', epoch: this.simEpoch, avgSynapses: avgSyn, avgTemp };
  }
}

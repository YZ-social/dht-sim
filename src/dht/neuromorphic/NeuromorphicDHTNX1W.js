/**
 * NeuromorphicDHTNX1W (NX-1W) – Fully Configurable Neuromorphic DHT
 *
 * Derived from N-15W. Every rule can be independently enabled/disabled and
 * every parameter is configurable at construction time via config.rules.
 * Default values reproduce N-15W exactly.
 *
 * config.rules shape:
 *   {
 *     bootstrap:          { kBootFactor }
 *     twoTier:            { enabled, maxSynaptomeSize, highwaySlots }
 *     apRouting:          { lookaheadAlpha, weightScale, geoRegionBits,
 *                           explorationEpsilon, maxGreedyHops }
 *     ltp:                { enabled, inertiaDuration }
 *     triadicClosure:     { enabled, introductionThreshold }
 *     hopCaching:         { enabled, cascadeWeight }
 *     lateralSpread:      { enabled, lateralK, lateralK2, lateralMaxDepth }
 *     stratifiedEviction: { enabled, strataGroups, stratumFloor }
 *     annealing:          { enabled, tInit, tMin, annealCooling, globalBias,
 *                           annealLocalSample }
 *     relayPinning:       { enabled, relayPinThreshold, relayPinWindow,
 *                           relayPinMax, relayPinWeight }
 *     markov:             { enabled, markovWindow, markovHotThreshold,
 *                           markovBaseWeight, markovMaxWeight }
 *     adaptiveDecay:      { enabled, decayInterval, pruneThreshold,
 *                           decayGammaMin, decayGammaMax, useSaturation,
 *                           decayGammaHighwayActive, decayGammaHighwayIdle,
 *                           highwayRenewalWindow, highwayFloor, synaptomeFloor }
 *     highwayRefresh:     { enabled, hubRefreshInterval, hubScanCap,
 *                           hubMinDiversity, hubNoise }
 *     loadBalancing:      { enabled (default false), loadDecay, loadPenalty,
 *                           loadFloor, loadSaturation }
 *   }
 */

import { DHT }               from '../DHT.js';
import { Synapse }           from './Synapse.js';
import { NeuronNode }        from './NeuronNode.js';
import { randomU64, clz64,
         roundTripLatency,
         buildXorRoutingTable } from '../../utils/geo.js';
import { geoCellId }         from '../../utils/s2.js';

export class NeuromorphicDHTNX1W extends DHT {
  static get protocolName() { return 'Neuromorphic-NX1W'; }

  constructor(config = {}) {
    super(config);
    this.nodeMap           = new Map();
    this.simEpoch          = 0;
    this.lookupsSinceDecay = 0;
    this._k                = config.k ?? 20;
    this._emaHops          = null;
    this._emaTime          = null;
    this._annealBuffer     = null;
    this._annealBufDirty   = true;
    this._annealBufCount   = 0;

    const r = config.rules ?? {};
    // p(rule, param, default) — read a numeric param with fallback
    const p = (rule, param, def) => {
      const v = r[rule]?.[param];
      return (v !== undefined && v !== null && v !== '') ? +v : def;
    };
    // e(rule, default) — read enabled flag
    const e = (rule, def = true) => {
      const v = r[rule]?.enabled;
      return v !== undefined ? Boolean(v) : def;
    };

    // ── Rule enabled flags ────────────────────────────────────────────────────
    // Rule 1 (Bootstrap) is always active — no flag
    this.EN_TWO_TIER        = e('twoTier');
    this.EN_LTP             = e('ltp');
    this.EN_TRIADIC         = e('triadicClosure');
    this.EN_HOP_CACHING     = e('hopCaching');
    this.EN_LATERAL_SPREAD  = e('lateralSpread');
    this.EN_STRATIFIED      = e('stratifiedEviction');
    this.EN_ANNEALING       = e('annealing');
    this.EN_RELAY_PINNING   = e('relayPinning');
    this.EN_MARKOV          = e('markov');
    this.EN_ADAPTIVE_DECAY  = e('adaptiveDecay');
    this.EN_HIGHWAY_REFRESH = e('highwayRefresh');
    this.EN_LOAD_BALANCING  = e('loadBalancing', false);  // off by default

    // ── Rule 1: Bootstrap ─────────────────────────────────────────────────────
    this.GEO_BITS      = 8;   // fixed — defines the ID format
    this.K_BOOT_FACTOR = p('bootstrap', 'kBootFactor', 1);

    // ── Rule 2: Two-Tier Synaptome ────────────────────────────────────────────
    this.MAX_SYNAPTOME_SIZE = p('twoTier', 'maxSynaptomeSize', 48);
    this.HIGHWAY_SLOTS      = this.EN_TWO_TIER
                               ? p('twoTier', 'highwaySlots', 12) : 0;

    // ── Rule 3: AP Routing with Two-Hop Lookahead ─────────────────────────────
    this.LOOKAHEAD_ALPHA     = p('apRouting', 'lookaheadAlpha', 5);
    this.WEIGHT_SCALE        = p('apRouting', 'weightScale', 0.40);
    this.GEO_REGION_BITS     = p('apRouting', 'geoRegionBits', 4);
    this.EXPLORATION_EPSILON = p('apRouting', 'explorationEpsilon', 0.05);
    this.MAX_GREEDY_HOPS     = p('apRouting', 'maxGreedyHops', 40);

    // ── Rule 4: LTP Reinforcement ─────────────────────────────────────────────
    this.INERTIA_DURATION = p('ltp', 'inertiaDuration', 20);

    // ── Rule 5: Triadic Closure ───────────────────────────────────────────────
    this.INTRODUCTION_THRESHOLD = p('triadicClosure', 'introductionThreshold', 1);

    // ── Rule 6: Hop Caching + Cascade Backprop ────────────────────────────────
    this.HOP_CASCADE_WEIGHT = p('hopCaching', 'cascadeWeight', 0.1);

    // ── Rule 7: Cascading Lateral Spread ──────────────────────────────────────
    this.LATERAL_K         = p('lateralSpread', 'lateralK', 6);
    this.LATERAL_K2        = p('lateralSpread', 'lateralK2', 2);
    this.LATERAL_MAX_DEPTH = p('lateralSpread', 'lateralMaxDepth', 2);

    // ── Rule 8: Stratified Eviction ───────────────────────────────────────────
    this.STRATA_GROUPS = p('stratifiedEviction', 'strataGroups', 16);
    this.STRATUM_FLOOR = p('stratifiedEviction', 'stratumFloor', 2);

    // ── Rule 9: Simulated Annealing ───────────────────────────────────────────
    this.T_INIT              = p('annealing', 'tInit', 1.0);
    this.T_MIN               = p('annealing', 'tMin', 0.05);
    this.ANNEAL_COOLING      = p('annealing', 'annealCooling', 0.9997);
    this.GLOBAL_BIAS         = p('annealing', 'globalBias', 0.5);
    this.ANNEAL_LOCAL_SAMPLE = p('annealing', 'annealLocalSample', 20);
    this.ANNEAL_BUF_REBUILD  = 200;

    // ── Rule 10: Relay Pinning ────────────────────────────────────────────────
    this.RELAY_PIN_THRESHOLD = p('relayPinning', 'relayPinThreshold', 5);
    this.RELAY_PIN_WINDOW    = p('relayPinning', 'relayPinWindow', 64);
    this.RELAY_PIN_MAX       = p('relayPinning', 'relayPinMax', 4);
    this.RELAY_PIN_WEIGHT    = p('relayPinning', 'relayPinWeight', 0.95);

    // ── Rule 11: Markov Pre-learning ──────────────────────────────────────────
    this.MARKOV_WINDOW        = p('markov', 'markovWindow', 16);
    this.MARKOV_HOT_THRESHOLD = p('markov', 'markovHotThreshold', 3);
    this.MARKOV_BASE_WEIGHT   = p('markov', 'markovBaseWeight', 0.5);
    this.MARKOV_MAX_WEIGHT    = p('markov', 'markovMaxWeight', 0.9);

    // ── Rule 12: Adaptive Decay ───────────────────────────────────────────────
    this.DECAY_INTERVAL             = p('adaptiveDecay', 'decayInterval', 100);
    this.PRUNE_THRESHOLD            = p('adaptiveDecay', 'pruneThreshold', 0.05);
    this.DECAY_GAMMA_MIN            = p('adaptiveDecay', 'decayGammaMin', 0.990);
    this.DECAY_GAMMA_MAX            = p('adaptiveDecay', 'decayGammaMax', 0.9998);
    this.USE_SATURATION             = p('adaptiveDecay', 'useSaturation', 20);
    this.DECAY_GAMMA_HIGHWAY_ACTIVE = p('adaptiveDecay', 'decayGammaHighwayActive', 0.9995);
    this.DECAY_GAMMA_HIGHWAY_IDLE   = p('adaptiveDecay', 'decayGammaHighwayIdle', 0.990);
    this.HIGHWAY_RENEWAL_WINDOW     = p('adaptiveDecay', 'highwayRenewalWindow', 3000);
    this.HIGHWAY_FLOOR              = p('adaptiveDecay', 'highwayFloor', 2);
    this.SYNAPTOME_FLOOR            = p('adaptiveDecay', 'synaptomeFloor', 48);

    // ── Rule 13: Highway Refresh ──────────────────────────────────────────────
    this.HUB_REFRESH_INTERVAL = p('highwayRefresh', 'hubRefreshInterval', 300);
    this.HUB_SCAN_CAP         = p('highwayRefresh', 'hubScanCap', 120);
    this.HUB_MIN_DIVERSITY    = p('highwayRefresh', 'hubMinDiversity', 5);
    this.HUB_NOISE            = p('highwayRefresh', 'hubNoise', 1.0);

    // ── Optional: Load-Aware AP Scoring (from N-7W/N-9W, off by default) ──────
    this.LOAD_DECAY      = p('loadBalancing', 'loadDecay', 0.995);
    this.LOAD_PENALTY    = p('loadBalancing', 'loadPenalty', 0.40);
    this.LOAD_FLOOR      = p('loadBalancing', 'loadFloor', 0.10);
    this.LOAD_SATURATION = p('loadBalancing', 'loadSaturation', 0.15);
  }

  // ── Node lifecycle ──────────────────────────────────────────────────────────

  async addNode(lat, lng) {
    const prefix   = geoCellId(lat, lng, this.GEO_BITS);
    const shift    = 64 - this.GEO_BITS;
    const randBits = randomU64() & ((1n << BigInt(shift)) - 1n);
    const id       = (BigInt(prefix) << BigInt(shift)) | randBits;
    const node     = new NeuronNode({ id, lat, lng });

    node.temperature     = this.EN_ANNEALING ? this.T_INIT : 1.0;
    node.highway         = new Map();   // always init; stays empty if two-tier disabled
    node.hubRefreshCount = 0;
    node.recentDests     = [];
    node.recentDestFreq  = new Map();
    node.pinnedDests     = new Set();
    node.pinWindow       = [];
    node.pinWindowFreq   = new Map();
    if (this.EN_LOAD_BALANCING) {
      node.loadEMA       = 0;
      node.loadLastEpoch = 0;
    }

    this.nodeMap.set(id, node);
    this.network.addNode(node);
    this._annealBufDirty = true;
    return node;
  }

  async removeNode(nodeId) {
    const node = this.nodeMap.get(nodeId);
    if (!node) return;
    node.alive = false;
    this.network.removeNode(nodeId);
    this.nodeMap.delete(nodeId);
    this._annealBufDirty = true;
  }

  // ── Neurogenesis ────────────────────────────────────────────────────────────

  buildRoutingTables({ bidirectional = true, maxConnections = Infinity } = {}) {
    super.buildRoutingTables({ bidirectional, maxConnections });
    if (maxConnections < this.MAX_SYNAPTOME_SIZE) {
      this.MAX_SYNAPTOME_SIZE = maxConnections;
    }
    const sorted = [...this.nodeMap.values()].sort(
      (a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    );
    for (const node of sorted) {
      for (const peer of buildXorRoutingTable(node.id, sorted, this._k * this.K_BOOT_FACTOR, maxConnections)) {
        const latMs   = roundTripLatency(node, peer);
        const stratum = clz64(node.id ^ peer.id);
        node.addSynapse(new Synapse({ peerId: peer.id, latencyMs: latMs, stratum }));
        if (this.bidirectional) peer.addIncomingSynapse(node.id, latMs, stratum);
      }
      node._nodeMapRef = this.nodeMap;
    }
  }

  /**
   * Query a node's synaptome + highway for the k closest peers to targetId.
   */
  _synaptomeFindClosest(node, targetId, k) {
    const seen = new Set();
    const peers = [];
    for (const syn of node.synaptome.values()) {
      const peer = this.nodeMap.get(syn.peerId);
      if (peer?.alive && !seen.has(peer.id)) { seen.add(peer.id); peers.push(peer); }
    }
    if (this.EN_TWO_TIER) {
      for (const syn of node.highway.values()) {
        const peer = this.nodeMap.get(syn.peerId);
        if (peer?.alive && !seen.has(peer.id)) { seen.add(peer.id); peers.push(peer); }
      }
    }
    for (const syn of node.incomingSynapses.values()) {
      const peer = this.nodeMap.get(syn.peerId);
      if (peer?.alive && !seen.has(peer.id)) { seen.add(peer.id); peers.push(peer); }
    }
    peers.sort((a, b) => {
      const da = a.id ^ targetId;
      const db = b.id ^ targetId;
      return da < db ? -1 : da > db ? 1 : 0;
    });
    return peers.slice(0, k);
  }

  /**
   * Bootstrap join — iterative self-lookup + multi-prefix discovery.
   *
   * Phase 1: standard FIND_NODE(self) discovers XOR-close peers (same geo cell).
   * Phase 2: additional lookups targeting synthetic IDs with flipped geographic
   *          prefix bits, discovering peers in distant cells — same strategy as
   *          G-DHT's bootstrap.  This gives the synaptome initial coverage across
   *          all XOR strata, so annealing and warmup have a solid foundation.
   */
  bootstrapJoin(newNodeId, sponsorId) {
    const newNode = this.nodeMap.get(newNodeId);
    const sponsor = this.nodeMap.get(sponsorId);
    if (!newNode || !sponsor) return 0;

    const k     = this._k;
    const alpha = this._alpha ?? 3;

    const synCap = isFinite(this.maxConnections) ? this.maxConnections : this.MAX_SYNAPTOME_SIZE;
    const addPeer = (peer) => {
      if (peer.id === newNodeId || newNode.synaptome.has(peer.id)) return;
      if (newNode.synaptome.size >= synCap) return;
      const latMs   = roundTripLatency(newNode, peer);
      const stratum = clz64(newNode.id ^ peer.id);
      newNode.addSynapse(new Synapse({ peerId: peer.id, latencyMs: latMs, stratum }));
      if (this.bidirectional) peer.addIncomingSynapse(newNode.id, latMs, stratum);
    };

    const iterativeLookup = (targetId, startNode, maxRounds) => {
      const queried = new Set([newNodeId]);
      let shortlist = this._synaptomeFindClosest(startNode, targetId, k);
      for (const peer of shortlist) addPeer(peer);

      for (let round = 0; round < maxRounds; round++) {
        const unqueried = shortlist.filter(n => !queried.has(n.id)).slice(0, alpha);
        if (unqueried.length === 0) break;

        let improved = false;
        for (const peer of unqueried) {
          queried.add(peer.id);
          const found = this._synaptomeFindClosest(peer, targetId, k);
          for (const candidate of found) {
            if (candidate.id !== newNodeId && !queried.has(candidate.id)) {
              addPeer(candidate);
              if (!shortlist.some(n => n.id === candidate.id)) {
                shortlist.push(candidate);
                improved = true;
              }
            }
          }
        }

        shortlist.sort((a, b) => {
          const da = a.id ^ targetId;
          const db = b.id ^ targetId;
          return da < db ? -1 : da > db ? 1 : 0;
        });
        shortlist = shortlist.slice(0, k);

        if (!improved) break;
      }
    };

    // Phase 1: Connect to sponsor + self-lookup for close peers
    addPeer(sponsor);
    iterativeLookup(newNodeId, sponsor, 10);

    // Phase 2: Inter-cell discovery — flip each geo-prefix bit to find
    // peers in distant geographic cells (mirrors G-DHT bootstrap strategy)
    const shift = BigInt(64 - this.GEO_BITS);
    for (let bit = 0; bit < this.GEO_BITS; bit++) {
      const targetId = newNodeId ^ (1n << (shift + BigInt(bit)));
      iterativeLookup(targetId, newNode, 2);
    }

    newNode._nodeMapRef = this.nodeMap;
    newNode.temperature = this.EN_ANNEALING ? this.T_INIT : 1.0;
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

    if (++this._annealBufCount >= this.ANNEAL_BUF_REBUILD) {
      this._annealBufDirty = true;
      this._annealBufCount = 0;
    }

    // Rule 11: Markov hot-destination pre-learning
    if (this.EN_MARKOV) {
      this._markovRecord(source, targetKey);
      if (!this._hasAny(source, targetKey)) {
        const freq = source.recentDestFreq.get(targetKey) ?? 0;
        if (freq >= this.MARKOV_HOT_THRESHOLD) {
          const wt = Math.min(this.MARKOV_MAX_WEIGHT,
            this.MARKOV_BASE_WEIGHT +
            (this.MARKOV_MAX_WEIGHT - this.MARKOV_BASE_WEIGHT) * (freq / this.MARKOV_WINDOW));
          this._introduce(sourceId, targetKey, wt);
        }
      }
    }

    // Rule 10: Relay pin tracking
    if (this.EN_RELAY_PINNING) {
      this._updatePins(source, targetKey);
    }

    const path  = [sourceId];
    const trace = [];
    let currentId   = sourceId;
    let totalTimeMs = 0;
    let reached     = false;

    for (let hop = 0; hop < this.MAX_GREEDY_HOPS; hop++) {
      const current = this.nodeMap.get(currentId);
      if (!current || !current.alive) break;

      const currentDist = current.id ^ targetKey;
      if (currentDist === 0n) { reached = true; break; }

      // Collect forward-progress candidates from all tiers
      const candidates = [];
      for (const s of current.synaptome.values()) {
        if ((s.peerId ^ targetKey) >= currentDist) continue;
        const peer = this.nodeMap.get(s.peerId);
        if (!peer?.alive) { s.weight = 0; continue; }
        candidates.push(s);
      }
      if (this.EN_TWO_TIER) {
        for (const s of current.highway.values()) {
          if ((s.peerId ^ targetKey) >= currentDist) continue;
          const peer = this.nodeMap.get(s.peerId);
          if (!peer?.alive) { s.weight = 0; continue; }
          candidates.push(s);
        }
      }
      for (const s of current.incomingSynapses.values()) {
        if ((s.peerId ^ targetKey) >= currentDist) continue;
        const peer = this.nodeMap.get(s.peerId);
        if (!peer?.alive) continue;
        candidates.push(s);
      }
      if (candidates.length === 0) break;

      const inTargetRegion =
        ((current.id ^ targetKey) >> BigInt(64 - this.GEO_REGION_BITS)) === 0n;

      // Select next hop: priority order
      let nextSyn;

      // Priority 1: direct synapse to target
      const directSyn = current.synaptome.get(targetKey)
                     ?? (this.EN_TWO_TIER ? current.highway.get(targetKey) : undefined)
                     ?? current.incomingSynapses.get(targetKey);
      if (directSyn && this.nodeMap.get(targetKey)?.alive) {
        nextSyn = directSyn;
      }

      // Priority 2: pinned destination at source (first hop only)
      if (!nextSyn && this.EN_RELAY_PINNING && hop === 0 && current.pinnedDests.has(targetKey)) {
        const ps = current.synaptome.get(targetKey)
                ?? (this.EN_TWO_TIER ? current.highway.get(targetKey) : undefined);
        if (ps && this.nodeMap.get(ps.peerId)?.alive) nextSyn = ps;
      }

      // Priority 3: explore randomly (first hop, epsilon-greedy)
      if (!nextSyn && hop === 0 && Math.random() < this.EXPLORATION_EPSILON) {
        nextSyn = candidates[Math.floor(Math.random() * candidates.length)];
      }

      // Priority 4: two-hop lookahead AP scoring
      if (!nextSyn) {
        const wScale = inTargetRegion ? this.WEIGHT_SCALE : 0;
        nextSyn = this._bestByTwoHopAP(current, candidates, targetKey, currentDist, wScale);
      }

      const nextId   = nextSyn.peerId;
      const nextNode = this.nodeMap.get(nextId);
      if (!nextNode) break;

      path.push(nextId);
      trace.push({ fromId: currentId, synapse: nextSyn });
      totalTimeMs += nextSyn.latency;

      // Highway renewal timestamp (N-15W rule)
      if (this.EN_TWO_TIER) {
        nextSyn.lastActiveEpoch = this.simEpoch;
        const hwRenew = current.highway.get(nextSyn.peerId);
        if (hwRenew && hwRenew !== nextSyn) hwRenew.lastActiveEpoch = this.simEpoch;
      }

      // Optional: Load tracking for load-aware AP scoring
      if (this.EN_LOAD_BALANCING) {
        const elapsed = this.simEpoch - (nextNode.loadLastEpoch ?? 0);
        nextNode.loadEMA       = (nextNode.loadEMA ?? 0) * Math.pow(this.LOAD_DECAY, elapsed)
                                 + (1 - this.LOAD_DECAY);
        nextNode.loadLastEpoch = this.simEpoch;
      }

      // Rule 5: Triadic closure (not at source)
      if (this.EN_TRIADIC && currentId !== sourceId) {
        this._recordTransit(current, sourceId, nextId);
      }

      // Rule 6/7: Hop caching + lateral spread
      if (this.EN_HOP_CACHING && currentId !== targetKey) {
        this._introduceAndSpread(currentId, targetKey);
      }

      // Rule 9: Simulated annealing
      if (this.EN_ANNEALING) {
        current.temperature = Math.max(this.T_MIN, current.temperature * this.ANNEAL_COOLING);
        if (Math.random() < current.temperature) {
          this._tryAnneal(current);
        }
      }

      // Rule 13: Highway refresh
      if (this.EN_TWO_TIER && this.EN_HIGHWAY_REFRESH) {
        if (++current.hubRefreshCount >= this.HUB_REFRESH_INTERVAL) {
          current.hubRefreshCount = 0;
          this._refreshHighway(current);
        }
      }

      currentId = nextId;
    }

    const hopCount = path.length - 1;
    if (reached) {
      this._emaHops = this._emaHops === null
        ? hopCount : 0.9 * this._emaHops + 0.1 * hopCount;
      this._emaTime = this._emaTime === null
        ? totalTimeMs : 0.9 * this._emaTime + 0.1 * totalTimeMs;

      // Rule 4: LTP reinforcement on fast paths
      if (this.EN_LTP && trace.length > 0 && totalTimeMs <= this._emaTime) {
        this._reinforceWave(trace);
      }

      // Rule 6: Cascade backpropagation
      if (this.EN_HOP_CACHING && trace.length >= 2) {
        const last = trace[trace.length - 1];
        if (last.synapse.peerId === targetKey) {
          const gatewayId = last.fromId;
          for (let j = 0; j < trace.length - 1; j++) {
            const fromNode = this.nodeMap.get(trace[j].fromId);
            if (fromNode && !this._hasAny(fromNode, targetKey)) {
              this._introduce(trace[j].fromId, gatewayId, this.HOP_CASCADE_WEIGHT);
            }
          }
        }
      }
    }

    return {
      path,
      hops:  path.length - 1,
      time:  totalTimeMs,
      found: reached,
    };
  }

  // ── LTP reinforcement wave ──────────────────────────────────────────────────

  _reinforceWave(trace) {
    for (let i = trace.length - 1; i >= 0; i--) {
      const { fromId, synapse } = trace[i];
      const node = this.nodeMap.get(fromId);
      if (!node) continue;
      const syn = node.synaptome.get(synapse.peerId)
               ?? (this.EN_TWO_TIER ? node.highway.get(synapse.peerId) : undefined);
      if (syn) {
        syn.reinforce(this.simEpoch, this.INERTIA_DURATION);
        syn.useCount = (syn.useCount ?? 0) + 1;
      }
    }
  }

  // ── Two-hop lookahead AP selection ─────────────────────────────────────────

  _bestByTwoHopAP(current, candidates, targetKey, currentDist, wScale) {
    const sorted = candidates.map(s => {
      const pd  = s.peerId ^ targetKey;
      let ap1   = (Number(currentDist - pd) / s.latency) * (1 + wScale * s.weight);
      // Optional load balancing penalty
      if (this.EN_LOAD_BALANCING) {
        const peer = this.nodeMap.get(s.peerId);
        if (peer && peer.loadEMA !== undefined) {
          const elapsed = this.simEpoch - (peer.loadLastEpoch ?? 0);
          const load    = peer.loadEMA * Math.pow(this.LOAD_DECAY, elapsed);
          ap1 *= Math.max(this.LOAD_FLOOR,
                          1 - this.LOAD_PENALTY * (load / this.LOAD_SATURATION));
        }
      }
      return { s, ap1 };
    }).sort((a, b) => b.ap1 - a.ap1);

    const probeSet = sorted.slice(0, this.LOOKAHEAD_ALPHA).map(x => x.s);

    let bestSyn = null;
    let bestAP2 = -Infinity;

    for (const firstSyn of probeSet) {
      const firstDist = firstSyn.peerId ^ targetKey;
      if (firstDist === 0n) return firstSyn;

      const firstNode = this.nodeMap.get(firstSyn.peerId);
      if (!firstNode?.alive) continue;

      const fwdCands = [];
      for (const fs of firstNode.synaptome.values()) {
        if ((fs.peerId ^ targetKey) < firstDist && this.nodeMap.get(fs.peerId)?.alive)
          fwdCands.push(fs);
      }
      if (this.EN_TWO_TIER) {
        for (const fs of firstNode.highway.values()) {
          if ((fs.peerId ^ targetKey) < firstDist && this.nodeMap.get(fs.peerId)?.alive)
            fwdCands.push(fs);
        }
      }

      let twoHopDist, secondLatency;
      if (fwdCands.length === 0) {
        twoHopDist    = firstDist;
        secondLatency = 0;
      } else {
        const bestFwd = firstNode.bestByAP(fwdCands, targetKey, wScale);
        twoHopDist    = bestFwd.peerId ^ targetKey;
        secondLatency = bestFwd.latency;
      }

      const progress2 = Number(currentDist - twoHopDist);
      const totalLat  = firstSyn.latency + secondLatency;
      const ap2       = (progress2 / totalLat) * (1 + wScale * firstSyn.weight);

      if (ap2 > bestAP2) { bestAP2 = ap2; bestSyn = firstSyn; }
    }

    return bestSyn ?? current.bestByAP(candidates, targetKey, wScale);
  }

  // ── Triadic closure ─────────────────────────────────────────────────────────

  _recordTransit(node, originId, nextId) {
    const key   = `${originId}_${nextId}`;
    const count = (node.transitCache.get(key) ?? 0) + 1;
    if (count >= this.INTRODUCTION_THRESHOLD) {
      node.transitCache.delete(key);
      this._introduce(originId, nextId);
    } else {
      node.transitCache.set(key, count);
    }
  }

  // ── Standard introduce ──────────────────────────────────────────────────────

  _introduce(aId, cId, initialWeight = 0.5) {
    const nodeA = this.nodeMap.get(aId);
    const nodeC = this.nodeMap.get(cId);
    if (!nodeA || !nodeC || !nodeA.alive || !nodeC.alive) return;
    if (this._hasAny(nodeA, cId)) return;

    const latMs   = roundTripLatency(nodeA, nodeC);
    const stratum = clz64(nodeA.id ^ nodeC.id);
    const syn     = new Synapse({ peerId: cId, latencyMs: latMs, stratum });
    syn.weight    = initialWeight;
    this._stratifiedAdd(nodeA, syn);
  }

  // ── Hop caching + cascading lateral spread ──────────────────────────────────

  _introduceAndSpread(aId, cId, depth = 1) {
    const nodeA = this.nodeMap.get(aId);
    const nodeC = this.nodeMap.get(cId);
    if (!nodeA || !nodeC || !nodeA.alive || !nodeC.alive) return;
    if (this._hasAny(nodeA, cId)) return;

    const latMs   = roundTripLatency(nodeA, nodeC);
    const stratum = clz64(nodeA.id ^ nodeC.id);
    const syn     = new Synapse({ peerId: cId, latencyMs: latMs, stratum });
    syn.weight    = 0.5;
    const added   = this._stratifiedAdd(nodeA, syn);

    // Rule 7: Cascade to regional neighbours
    if (this.EN_LATERAL_SPREAD && added && depth <= this.LATERAL_MAX_DEPTH) {
      const aRegion  = aId >> BigInt(64 - this.GEO_REGION_BITS);
      const regional = [];
      for (const s of nodeA.synaptome.values()) {
        if (s.peerId === cId) continue;
        if ((s.peerId >> BigInt(64 - this.GEO_REGION_BITS)) !== aRegion) continue;
        if (this.nodeMap.get(s.peerId)?.alive) regional.push(s);
      }
      regional.sort((a, b) => b.weight - a.weight);
      const k = depth === 1 ? this.LATERAL_K : this.LATERAL_K2;
      for (let i = 0; i < Math.min(k, regional.length); i++) {
        this._introduceAndSpread(regional[i].peerId, cId, depth + 1);
      }
    }
  }

  // ── Two-tier helper ─────────────────────────────────────────────────────────

  _hasAny(node, peerId) {
    return node.synaptome.has(peerId)
        || (this.EN_TWO_TIER && !!(node.highway?.has(peerId)));
  }

  // ── Local-tier stratified admission ────────────────────────────────────────

  _stratifiedAdd(node, newSyn) {
    if (node.synaptome.size < this.MAX_SYNAPTOME_SIZE) {
      node.addSynapse(newSyn);
      return true;
    }

    if (!this.EN_STRATIFIED) {
      // Simple eviction: weakest non-pinned connection
      let weakest = null, weakestW = Infinity;
      for (const syn of node.synaptome.values()) {
        if (this.EN_RELAY_PINNING && node.pinnedDests.has(syn.peerId)) continue;
        if (syn.weight < weakestW) { weakestW = syn.weight; weakest = syn; }
      }
      if (!weakest) return false;
      node.synaptome.delete(weakest.peerId);
      node.addSynapse(newSyn);
      return true;
    }

    const { counts, byGroup } = this._buildGroupCounts(node);

    let evictGroup = -1, maxCount = this.STRATUM_FLOOR;
    for (let g = 0; g < this.STRATA_GROUPS; g++) {
      if (counts[g] > maxCount) { maxCount = counts[g]; evictGroup = g; }
    }
    if (evictGroup === -1) return false;

    let weakest = null, weakestW = Infinity;
    for (const syn of byGroup[evictGroup]) {
      if (this.EN_RELAY_PINNING && node.pinnedDests.has(syn.peerId)) continue;
      if (syn.weight < weakestW) { weakestW = syn.weight; weakest = syn; }
    }
    if (!weakest) return false;

    node.synaptome.delete(weakest.peerId);
    node.addSynapse(newSyn);
    return true;
  }

  // ── Highway tier management ─────────────────────────────────────────────────

  _refreshHighway(node) {
    if (!node.alive || this.HIGHWAY_SLOTS === 0) return;

    const candidates = [];
    const seen       = new Set([node.id]);

    outer:
    for (const syn of node.synaptome.values()) {
      const peer = this.nodeMap.get(syn.peerId);
      if (!peer?.alive) continue;
      seen.add(peer.id);
      for (const pSyn of peer.synaptome.values()) {
        if (seen.has(pSyn.peerId)) continue;
        seen.add(pSyn.peerId);
        const candidate = this.nodeMap.get(pSyn.peerId);
        if (!candidate?.alive) continue;
        candidates.push(candidate);
        if (candidates.length >= this.HUB_SCAN_CAP) break outer;
      }
    }

    const scored = candidates
      .map(c => ({ node: c, score: this._stratumDiversity(c) + Math.random() * this.HUB_NOISE }))
      .filter(c => c.score >= this.HUB_MIN_DIVERSITY);

    scored.sort((a, b) => b.score - a.score);

    node.highway.clear();
    for (let i = 0; i < Math.min(this.HIGHWAY_SLOTS, scored.length); i++) {
      const hub     = scored[i].node;
      const latMs   = roundTripLatency(node, hub);
      const stratum = clz64(node.id ^ hub.id);
      const syn     = new Synapse({ peerId: hub.id, latencyMs: latMs, stratum });
      syn.weight          = 0.5;
      syn.lastActiveEpoch = this.simEpoch;   // grace period on creation
      node.highway.set(hub.id, syn);
    }
  }

  _stratumDiversity(node) {
    const groups = new Set();
    for (const syn of node.synaptome.values()) groups.add(syn.stratum >>> 2);
    return groups.size;
  }

  // ── Markov rolling-window tracking ─────────────────────────────────────────

  _markovRecord(node, targetKey) {
    node.recentDests.push(targetKey);
    node.recentDestFreq.set(targetKey, (node.recentDestFreq.get(targetKey) ?? 0) + 1);
    if (node.recentDests.length > this.MARKOV_WINDOW) {
      const evicted = node.recentDests.shift();
      const f = node.recentDestFreq.get(evicted) - 1;
      if (f <= 0) node.recentDestFreq.delete(evicted);
      else        node.recentDestFreq.set(evicted, f);
    }
  }

  // ── Relay pin tracking ──────────────────────────────────────────────────────

  _updatePins(node, targetKey) {
    node.pinWindow.push(targetKey);
    node.pinWindowFreq.set(targetKey, (node.pinWindowFreq.get(targetKey) ?? 0) + 1);
    if (node.pinWindow.length > this.RELAY_PIN_WINDOW) {
      const evicted = node.pinWindow.shift();
      const f = node.pinWindowFreq.get(evicted) - 1;
      if (f <= 0) node.pinWindowFreq.delete(evicted);
      else        node.pinWindowFreq.set(evicted, f);
    }

    const freq = node.pinWindowFreq.get(targetKey) ?? 0;
    if (freq >= this.RELAY_PIN_THRESHOLD && !node.pinnedDests.has(targetKey)) {
      if (node.pinnedDests.size < this.RELAY_PIN_MAX) {
        node.pinnedDests.add(targetKey);
        const syn = node.synaptome.get(targetKey) ?? node.highway.get(targetKey);
        if (syn && syn.weight < this.RELAY_PIN_WEIGHT) syn.weight = this.RELAY_PIN_WEIGHT;
      }
    }

    for (const dest of node.pinnedDests) {
      if ((node.pinWindowFreq.get(dest) ?? 0) < this.RELAY_PIN_THRESHOLD)
        node.pinnedDests.delete(dest);
    }
  }

  // ── Local-tier annealing ────────────────────────────────────────────────────

  _tryAnneal(node) {
    if (!node.alive || node.synaptome.size === 0) return;
    if (node.synaptome.size <= this.SYNAPTOME_FLOOR) return;

    let weakest = null, weakestW = Infinity;
    let targetLo = 0, targetHi = 63;

    if (this.EN_STRATIFIED) {
      const { counts, byGroup } = this._buildGroupCounts(node);

      let evictGroup = -1, maxCount = this.STRATUM_FLOOR;
      for (let g = 0; g < this.STRATA_GROUPS; g++) {
        if (counts[g] > maxCount) { maxCount = counts[g]; evictGroup = g; }
      }
      if (evictGroup === -1) return;

      let minCount = Infinity, targetGroup = 0;
      for (let g = 0; g < this.STRATA_GROUPS; g++) {
        if (counts[g] < minCount) { minCount = counts[g]; targetGroup = g; }
      }
      targetLo = targetGroup * 4;
      targetHi = targetLo + 3;

      for (const syn of byGroup[evictGroup]) {
        if (this.EN_RELAY_PINNING && node.pinnedDests.has(syn.peerId)) continue;
        if (syn.weight < weakestW) { weakestW = syn.weight; weakest = syn; }
      }
    } else {
      for (const syn of node.synaptome.values()) {
        if (this.EN_RELAY_PINNING && node.pinnedDests.has(syn.peerId)) continue;
        if (syn.weight < weakestW) { weakestW = syn.weight; weakest = syn; }
      }
    }
    if (!weakest) return;

    const useGlobal = Math.random() < ((node.temperature ?? 0.5) * this.GLOBAL_BIAS);
    const candidate = useGlobal
      ? this._globalCandidate(node, targetLo, targetHi)
      : this._localCandidate(node, targetLo, targetHi);

    if (!candidate || this._hasAny(node, candidate.id)) return;

    node.synaptome.delete(weakest.peerId);
    const latMs   = roundTripLatency(node, candidate);
    const stratum = clz64(node.id ^ candidate.id);
    const newSyn  = new Synapse({ peerId: candidate.id, latencyMs: latMs, stratum });
    newSyn.weight = 0.1;
    node.addSynapse(newSyn);
  }

  // ── Global candidate (annealing exploration) ───────────────────────────────

  // HONESTY: No access to global nodeMap — nodes can only explore via their
  // own synaptome neighbourhood. Delegate to _localCandidate (2-hop search).
  _globalCandidate(node, lo, hi) {
    return this._localCandidate(node, lo, hi);
  }

  // ── Local candidate (annealing neighbourhood) ─────────────────────────────

  _localCandidate(node, lo, hi) {
    const candidates = [];
    outer:
    for (const syn of node.synaptome.values()) {
      const peer = this.nodeMap.get(syn.peerId);
      if (!peer?.alive) continue;
      for (const peerSyn of peer.synaptome.values()) {
        const id = peerSyn.peerId;
        if (id === node.id || this._hasAny(node, id)) continue;
        const candidate = this.nodeMap.get(id);
        if (!candidate?.alive) continue;
        const stratum = clz64(node.id ^ id);
        if (stratum >= lo && stratum <= hi) {
          candidates.push(candidate);
          if (candidates.length >= this.ANNEAL_LOCAL_SAMPLE) break outer;
        }
      }
    }
    if (candidates.length === 0) return null;
    return candidates[Math.floor(Math.random() * candidates.length)];
  }

  // ── Stratum group helpers ──────────────────────────────────────────────────

  _buildGroupCounts(node) {
    const counts  = new Array(this.STRATA_GROUPS).fill(0);
    const byGroup = Array.from({ length: this.STRATA_GROUPS }, () => []);
    for (const syn of node.synaptome.values()) {
      const g = Math.min(this.STRATA_GROUPS - 1, syn.stratum >>> 2);
      counts[g]++;
      byGroup[g].push(syn);
    }
    return { counts, byGroup };
  }

  // ── Adaptive temporal decay ────────────────────────────────────────────────

  _tickDecay() {
    for (const node of this.nodeMap.values()) {
      this._decayTier(node, node.synaptome, true);
      if (this.EN_TWO_TIER) this._decayTier(node, node.highway, false);
    }
  }

  _decayTier(node, tierMap, applyStructuralRule) {
    const toPrune   = [];
    const isHighway = !applyStructuralRule;

    for (const syn of tierMap.values()) {
      if (syn.inertia > this.simEpoch) continue;

      // Pinned destinations decay at max rate with weight floor
      if (this.EN_RELAY_PINNING && node.pinnedDests?.has(syn.peerId)) {
        syn.decay(this.DECAY_GAMMA_MAX);
        if (syn.weight < this.RELAY_PIN_WEIGHT) syn.weight = this.RELAY_PIN_WEIGHT;
        continue;
      }

      let gamma;
      if (isHighway) {
        if (this.EN_ADAPTIVE_DECAY) {
          const lastActive = syn.lastActiveEpoch ?? 0;
          const isActive   = (lastActive + this.HIGHWAY_RENEWAL_WINDOW) > this.simEpoch;
          gamma = isActive ? this.DECAY_GAMMA_HIGHWAY_ACTIVE : this.DECAY_GAMMA_HIGHWAY_IDLE;
        } else {
          gamma = this.DECAY_GAMMA_MIN;   // fixed cold rate when adaptive decay off
        }
      } else {
        if (this.EN_ADAPTIVE_DECAY) {
          const useFrac = Math.min(1, (syn.useCount ?? 0) / this.USE_SATURATION);
          gamma = this.DECAY_GAMMA_MIN + (this.DECAY_GAMMA_MAX - this.DECAY_GAMMA_MIN) * useFrac;
        } else {
          gamma = this.DECAY_GAMMA_MIN;   // fixed rate when adaptive decay off
        }
      }
      syn.decay(gamma);

      if (syn.weight < this.PRUNE_THRESHOLD) toPrune.push(syn);
    }

    if (!toPrune.length) return;

    // Highway floor
    if (isHighway) {
      if (tierMap.size <= this.HIGHWAY_FLOOR) {
        for (const syn of toPrune) syn.weight = this.PRUNE_THRESHOLD;
        return;
      }
      const canDelete = tierMap.size - this.HIGHWAY_FLOOR;
      toPrune.sort((a, b) => a.weight - b.weight);
      for (let i = 0; i < toPrune.length; i++) {
        if (i < canDelete) tierMap.delete(toPrune[i].peerId);
        else               toPrune[i].weight = this.PRUNE_THRESHOLD;
      }
      return;
    }

    // Guard B: local tier synaptome floor
    if (tierMap.size <= this.SYNAPTOME_FLOOR) {
      for (const syn of toPrune) syn.weight = this.PRUNE_THRESHOLD;
      return;
    }

    if (!this.EN_STRATIFIED) {
      // Simple: delete below-threshold directly
      for (const syn of toPrune) tierMap.delete(syn.peerId);
      return;
    }

    // Per-stratum structural survival rule
    const byStratum = new Map();
    for (const syn of toPrune) {
      let arr = byStratum.get(syn.stratum);
      if (!arr) { arr = []; byStratum.set(syn.stratum, arr); }
      arr.push(syn);
    }

    const minPerStratum = this._k;
    for (const [stratum, candidates] of byStratum) {
      let total = 0;
      for (const s of tierMap.values()) { if (s.stratum === stratum) total++; }
      const removable = Math.max(0, total - minPerStratum);
      candidates.sort((a, b) => a.weight - b.weight);
      for (let i = 0; i < candidates.length; i++) {
        if (i < removable) tierMap.delete(candidates[i].peerId);
        else               candidates[i].weight = this.PRUNE_THRESHOLD;
      }
    }
  }

  // ── Stats ──────────────────────────────────────────────────────────────────

  getStats() {
    const base  = super.getStats();
    const nodes = [...this.nodeMap.values()];
    const localSyn  = nodes.reduce((a, n) => a + n.synaptome.size, 0);
    const hwSyn     = nodes.reduce((a, n) => a + (n.highway?.size ?? 0), 0);
    const avgTemp   = nodes.length
      ? (nodes.reduce((a, n) => a + (n.temperature ?? this.T_INIT), 0) / nodes.length).toFixed(3)
      : '—';
    const avgPinned = nodes.length
      ? (nodes.reduce((a, n) => a + (n.pinnedDests?.size ?? 0), 0) / nodes.length).toFixed(2)
      : '0.00';

    return {
      ...base,
      protocol:      'Neuromorphic-NX1W',
      epoch:         this.simEpoch,
      avgSynapses:   nodes.length ? ((localSyn + hwSyn) / nodes.length).toFixed(1) : 0,
      avgLocalSyn:   nodes.length ? (localSyn / nodes.length).toFixed(1) : 0,
      avgHighwaySyn: nodes.length ? (hwSyn / nodes.length).toFixed(1) : 0,
      avgTemp,
      avgPinned,
    };
  }
}

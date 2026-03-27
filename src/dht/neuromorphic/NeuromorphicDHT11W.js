/**
 * NeuromorphicDHT11W (N-G-DHT-11W) – Generation 11, Frequency-Weighted Reservation
 *
 * N-11W takes N-10W as its direct base and replaces the hard RELAY_PIN_MAX cap
 * with a frequency-weighted synaptome reservation that scales dynamically with
 * the number of observed hot relay destinations.
 *
 * ── Observation ───────────────────────────────────────────────────────────────
 *
 * N-10W's RELAY_PIN_MAX=4 cap fails at high pub/sub coverage and large scale.
 * At 50% coverage with a 32-member group, each relay node routes for ~16 group
 * members — but with only 4 protected slots, 12 members' synapses remain
 * eviction-eligible.  At 25K nodes the XOR ID space produces ~391 distinct
 * destination groups competing for 48 synaptome slots; the fixed-4-pin budget
 * covers < 1.1% of those destinations.
 *
 * Root cause: RELAY_PIN_MAX is a network-topology-unaware constant.  It was
 * tuned for the benchmark parameters used during N-10W development (32-member
 * group, 10% coverage → ~3 active members per relay node) but does not
 * generalise to higher coverage or group sizes.
 *
 * ── Change — Frequency-Weighted Synaptome Reservation ────────────────────────
 *
 * The fixed RELAY_PIN_MAX cap is removed.  Instead, the pin set is allowed to
 * grow up to RELAY_PIN_RESERVE_FRAC (50%) of MAX_SYNAPTOME_SIZE = 24 slots.
 *
 * Within that budget, pins are frequency-ranked: when the budget is exhausted
 * and a new destination qualifies (freq ≥ RELAY_PIN_THRESHOLD), it displaces
 * the currently pinned destination with the lowest rolling-window frequency —
 * ensuring the 24 most active relay destinations are always protected.
 *
 * Additionally, _stratifiedAdd now also checks whether the would-be eviction
 * candidate's frequency meets RELAY_PIN_THRESHOLD even if it is not yet in
 * pinnedDests.  Such "threshold-qualified but unregistered" entries are treated
 * as temporary pins and protected from structural eviction.
 *
 * ── Everything else inherited unchanged from N-10W ────────────────────────────
 *   • Cascading lateral spread: LATERAL_K=6, LATERAL_K2=2, LATERAL_MAX_DEPTH=2
 *   • Synaptome floor protection (Guard A + B, SYNAPTOME_FLOOR=48)
 *   • Tier rebalancing: MAX_SYNAPTOME_SIZE=48, HIGHWAY_SLOTS=12
 *   • Adaptive temporal decay (DECAY_GAMMA_MIN/MAX, USE_SATURATION)
 *   • Markov hot-destination pre-learning (MARKOV_BASE_WEIGHT=0.5)
 *   • Extended randomised hub pool (HUB_SCAN_CAP=120, HUB_NOISE=1.0)
 *   • Stratified eviction (STRATA_GROUPS=16, STRATUM_FLOOR=2)
 *   • Simulated annealing (T_INIT, T_MIN, ANNEAL_COOLING, GLOBAL_BIAS)
 *   • Two-hop lookahead with advance-per-latency scoring (α=5)
 *   • Source-inclusive hop caching + shortcut cascade backpropagation
 *   • Triadic closure, inertia locks, intra-regional weight bonus
 *   • Dense bootstrap (K_BOOT_FACTOR=1, 20 peers/bucket)
 *   • Load-aware AP scoring REMOVED (N-10W change 1)
 */

import { DHT }               from '../DHT.js';
import { Synapse }           from './Synapse.js';
import { NeuronNode }        from './NeuronNode.js';
import { randomU64, clz64,
         roundTripLatency,
         buildXorRoutingTable } from '../../utils/geo.js';
import { geoCellId }         from '../../utils/s2.js';

// ── Shared constants ──────────────────────────────────────────────────────────

const GEO_BITS               = 8;
const INERTIA_DURATION       = 20;
const DECAY_INTERVAL         = 100;
const PRUNE_THRESHOLD        = 0.05;
const INTRODUCTION_THRESHOLD = 1;
const MAX_GREEDY_HOPS        = 40;
const K_BOOT_FACTOR          = 1;    // 20 bootstrap peers (browser-realistic)

const EXPLORATION_EPSILON    = 0.05;
const WEIGHT_SCALE           = 0.40;
const LOOKAHEAD_ALPHA        = 5;
const GEO_REGION_BITS        = 4;

// ── Cascading lateral spread parameters ──────────────────────────────────────

const LATERAL_K         = 6;   // wider first-hop spread
const LATERAL_K2        = 2;   // second-hop spread (depth-2 cascade)
const LATERAL_MAX_DEPTH = 2;   // cascade terminates at depth 2

// ── Tier sizes — total = 48 + 12 = 60 (browser WebRTC budget) ────────────────

const MAX_SYNAPTOME_SIZE = 48;   // local tier cap
const HIGHWAY_SLOTS      = 12;   // highway tier cap

// ── Synaptome floor — local tier never shrinks below this ─────────────────────

const SYNAPTOME_FLOOR = MAX_SYNAPTOME_SIZE;   // 48

// ── Local-tier stratification ─────────────────────────────────────────────────

const STRATA_GROUPS  = 16;   // 64 strata ÷ 4 = 16 groups of 4
const STRATUM_FLOOR  = 2;    // min entries per group before eviction is allowed

// ── Simulated annealing ───────────────────────────────────────────────────────

const T_INIT              = 1.0;
const T_MIN               = 0.05;
const ANNEAL_COOLING      = 0.9997;
const GLOBAL_BIAS         = 0.5;
const ANNEAL_LOCAL_SAMPLE = 20;
const ANNEAL_BUF_REBUILD  = 200;

// ── Adaptive decay ────────────────────────────────────────────────────────────

const DECAY_GAMMA_MIN = 0.990;   // cold (useCount=0)   → ~10% loss/interval
const DECAY_GAMMA_MAX = 0.9998;  // hot  (useCount≥20)  → ~0.02% loss/interval
const USE_SATURATION  = 20;      // uses needed to reach full decay protection

// ── Markov hot-destination learning ──────────────────────────────────────────

const MARKOV_WINDOW        = 32;
const MARKOV_HOT_THRESHOLD = 3;
const MARKOV_BASE_WEIGHT   = 0.5;
const MARKOV_MAX_WEIGHT    = 0.9;

// ── Highway / hub management ──────────────────────────────────────────────────

const HUB_REFRESH_INTERVAL = 300;
const HUB_SCAN_CAP         = 120;
const HUB_MIN_DIVERSITY    = 5;
const HUB_NOISE            = 1.0;

// ── Change: Frequency-weighted relay reservation ──────────────────────────────
//
// RELAY_PIN_MAX is REMOVED.  The pin budget now scales with observed traffic:
//   dynamicMax = min(RELAY_PIN_RESERVE_FRAC × MAX_SYNAPTOME_SIZE, hotDestCount)
//
// When the budget is full and a new hot destination arrives, it displaces the
// pin with the lowest current rolling-window frequency (frequency-ranked).

const RELAY_PIN_THRESHOLD    = 5;    // pin-window freq to qualify for protection
const RELAY_PIN_WINDOW       = 64;   // rolling window size for pin decisions
const RELAY_PIN_RESERVE_FRAC = 0.5;  // up to 50% of synaptome reserved (= 24 slots)
const RELAY_PIN_WEIGHT       = 0.95; // minimum weight floor for pinned synapses

// ─────────────────────────────────────────────────────────────────────────────
// NeuromorphicDHT11W
// ─────────────────────────────────────────────────────────────────────────────

export class NeuromorphicDHT11W extends DHT {
  static get protocolName() { return 'Neuromorphic-11W'; }

  constructor(config = {}) {
    super(config);
    /** @type {Map<bigint, NeuronNode>} */
    this.nodeMap           = new Map();
    this.simEpoch          = 0;
    this.lookupsSinceDecay = 0;
    this._k                = config.k ?? 20;
    this._emaHops          = null;
    this._emaTime          = null;

    this._annealBuffer   = null;
    this._annealBufDirty = true;
    this._annealBufCount = 0;
  }

  // ── Node lifecycle ────────────────────────────────────────────────────────

  async addNode(lat, lng) {
    const prefix   = geoCellId(lat, lng, GEO_BITS);
    const shift    = 64 - GEO_BITS;
    const randBits = randomU64() & ((1n << BigInt(shift)) - 1n);
    const id       = (BigInt(prefix) << BigInt(shift)) | randBits;
    const node     = new NeuronNode({ id, lat, lng });

    node.temperature      = T_INIT;
    node.highway          = new Map();
    node.hubRefreshCount  = 0;
    node.recentDests      = [];
    node.recentDestFreq   = new Map();
    // Frequency-weighted relay reservation state (replaces N-10W fixed pin set)
    node.pinnedDests      = new Set();
    node.pinWindow        = [];
    node.pinWindowFreq    = new Map();

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

  // ── Neurogenesis ──────────────────────────────────────────────────────────

  buildRoutingTables({ bidirectional = true } = {}) {
    super.buildRoutingTables({ bidirectional });
    const sorted = [...this.nodeMap.values()].sort(
      (a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    );
    for (const node of sorted) {
      for (const peer of buildXorRoutingTable(node.id, sorted, this._k * K_BOOT_FACTOR)) {
        const latMs   = roundTripLatency(node, peer);
        const stratum = clz64(node.id ^ peer.id);
        node.addSynapse(new Synapse({ peerId: peer.id, latencyMs: latMs, stratum }));
        if (this.bidirectional) peer.addIncomingSynapse(node.id, latMs, stratum);
      }
      node._nodeMapRef = this.nodeMap;
    }
  }

  // ── Routing ───────────────────────────────────────────────────────────────

  async lookup(sourceId, targetKey) {
    const source = this.nodeMap.get(sourceId);
    if (!source || !source.alive) return null;

    this.simEpoch++;
    if (++this.lookupsSinceDecay >= DECAY_INTERVAL) {
      this._tickDecay();
      this.lookupsSinceDecay = 0;
    }

    if (++this._annealBufCount >= ANNEAL_BUF_REBUILD) {
      this._annealBufDirty = true;
      this._annealBufCount = 0;
    }

    // Markov hot-destination pre-learning.
    this._markovRecord(source, targetKey);
    if (!this._hasAny(source, targetKey)) {
      const freq = source.recentDestFreq.get(targetKey) ?? 0;
      if (freq >= MARKOV_HOT_THRESHOLD) {
        const markovWeight = Math.min(MARKOV_MAX_WEIGHT,
          MARKOV_BASE_WEIGHT + (MARKOV_MAX_WEIGHT - MARKOV_BASE_WEIGHT) * (freq / MARKOV_WINDOW));
        this._introduce(sourceId, targetKey, markovWeight);
      }
    }

    // Update frequency-weighted relay reservation at the source.
    this._updatePins(source, targetKey);

    const path  = [sourceId];
    const trace = [];
    let currentId   = sourceId;
    let totalTimeMs = 0;
    let reached     = false;

    for (let hop = 0; hop < MAX_GREEDY_HOPS; hop++) {
      const current = this.nodeMap.get(currentId);
      if (!current || !current.alive) break;

      const currentDist = current.id ^ targetKey;
      if (currentDist === 0n) { reached = true; break; }

      const candidates = [];
      for (const s of current.synaptome.values()) {
        if ((s.peerId ^ targetKey) >= currentDist) continue;
        const peer = this.nodeMap.get(s.peerId);
        if (!peer?.alive) { s.weight = 0; continue; }
        candidates.push(s);
      }
      for (const s of current.highway.values()) {
        if ((s.peerId ^ targetKey) >= currentDist) continue;
        const peer = this.nodeMap.get(s.peerId);
        if (!peer?.alive) { s.weight = 0; continue; }
        candidates.push(s);
      }
      for (const s of current.incomingSynapses.values()) {
        if ((s.peerId ^ targetKey) >= currentDist) continue; // no progress
        const peer = this.nodeMap.get(s.peerId);
        if (!peer?.alive) continue;
        candidates.push(s);
      }
      if (candidates.length === 0) break;

      const inTargetRegion =
        ((current.id ^ targetKey) >> BigInt(64 - GEO_REGION_BITS)) === 0n;

      let nextSyn;
      const directSyn = current.synaptome.get(targetKey) ?? current.highway.get(targetKey)
                     ?? current.incomingSynapses.get(targetKey);
      if (directSyn && this.nodeMap.get(targetKey)?.alive) {
        // Priority 0: direct synapse to target.
        nextSyn = directSyn;
      } else if (hop === 0 && current.pinnedDests.has(targetKey)) {
        // Priority 0.5: pinned destination at source — high-weight direct synapse
        // guaranteed; bypass two-hop lookahead overhead.
        const pinnedSyn = current.synaptome.get(targetKey) ?? current.highway.get(targetKey);
        if (pinnedSyn && this.nodeMap.get(pinnedSyn.peerId)?.alive) {
          nextSyn = pinnedSyn;
        }
      }

      if (!nextSyn) {
        if (hop === 0 && Math.random() < EXPLORATION_EPSILON) {
          nextSyn = candidates[Math.floor(Math.random() * candidates.length)];
        } else if (inTargetRegion) {
          nextSyn = this._bestByTwoHopAP(current, candidates, targetKey, currentDist, WEIGHT_SCALE);
        } else {
          nextSyn = this._bestByTwoHopAP(current, candidates, targetKey, currentDist, 0);
        }
      }

      const nextId   = nextSyn.peerId;
      const nextNode = this.nodeMap.get(nextId);
      if (!nextNode) break;

      path.push(nextId);
      trace.push({ fromId: currentId, synapse: nextSyn });
      totalTimeMs += nextSyn.latency;

      if (currentId !== sourceId) {
        this._recordTransit(current, sourceId, nextId);
      }

      if (currentId !== targetKey) {
        this._introduceAndSpread(currentId, targetKey);
      }

      current.temperature = Math.max(T_MIN, current.temperature * ANNEAL_COOLING);
      if (Math.random() < current.temperature) {
        this._tryAnneal(current);
      }

      if (++current.hubRefreshCount >= HUB_REFRESH_INTERVAL) {
        current.hubRefreshCount = 0;
        this._refreshHighway(current);
      }

      currentId = nextId;
    }

    const hopCount = path.length - 1;
    if (reached) {
      this._emaHops = this._emaHops === null
        ? hopCount : 0.9 * this._emaHops + 0.1 * hopCount;
      this._emaTime = this._emaTime === null
        ? totalTimeMs : 0.9 * this._emaTime + 0.1 * totalTimeMs;
      if (trace.length > 0 && totalTimeMs <= this._emaTime) {
        this._reinforceWave(trace);
      }

      if (trace.length >= 2) {
        const lastTrace = trace[trace.length - 1];
        if (lastTrace.synapse.peerId === targetKey) {
          const gatewayId = lastTrace.fromId;
          for (let j = 0; j < trace.length - 1; j++) {
            const fromNode = this.nodeMap.get(trace[j].fromId);
            if (fromNode && !this._hasAny(fromNode, targetKey)) {
              this._introduce(trace[j].fromId, gatewayId, 0.1);
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

  // ── LTP reinforcement wave ────────────────────────────────────────────────

  _reinforceWave(trace) {
    for (let i = trace.length - 1; i >= 0; i--) {
      const { fromId, synapse } = trace[i];
      const node = this.nodeMap.get(fromId);
      if (!node) continue;
      const syn = node.synaptome.get(synapse.peerId) ?? node.highway.get(synapse.peerId);
      if (syn) {
        syn.reinforce(this.simEpoch, INERTIA_DURATION);
        syn.useCount = (syn.useCount ?? 0) + 1;
      }
    }
  }

  // ── 2-hop lookahead AP selection ──────────────────────────────────────────

  _bestByTwoHopAP(current, candidates, targetKey, currentDist, wScale) {
    const sorted = candidates
      .map(s => {
        const pd  = s.peerId ^ targetKey;
        const ap1 = (Number(currentDist - pd) / s.latency) * (1 + wScale * s.weight);
        return { s, ap1 };
      })
      .sort((a, b) => b.ap1 - a.ap1);

    const probeSet = sorted.slice(0, LOOKAHEAD_ALPHA).map(x => x.s);

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
      for (const fs of firstNode.highway.values()) {
        if ((fs.peerId ^ targetKey) < firstDist && this.nodeMap.get(fs.peerId)?.alive)
          fwdCands.push(fs);
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

      if (ap2 > bestAP2) {
        bestAP2 = ap2;
        bestSyn = firstSyn;
      }
    }

    return bestSyn ?? current.bestByAP(candidates, targetKey, wScale);
  }

  // ── Triadic closure ───────────────────────────────────────────────────────

  _recordTransit(node, originId, nextId) {
    const key   = `${originId}_${nextId}`;
    const count = (node.transitCache.get(key) ?? 0) + 1;
    if (count >= INTRODUCTION_THRESHOLD) {
      node.transitCache.delete(key);
      this._introduce(originId, nextId);
    } else {
      node.transitCache.set(key, count);
    }
  }

  // ── Standard introduce ────────────────────────────────────────────────────

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

  // ── Cascading lateral spread ──────────────────────────────────────────────

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

    if (added && depth <= LATERAL_MAX_DEPTH) {
      const aRegion  = aId >> BigInt(64 - GEO_REGION_BITS);
      const regional = [];
      for (const s of nodeA.synaptome.values()) {
        if (s.peerId === cId) continue;
        if ((s.peerId >> BigInt(64 - GEO_REGION_BITS)) !== aRegion) continue;
        if (this.nodeMap.get(s.peerId)?.alive) regional.push(s);
      }
      regional.sort((a, b) => b.weight - a.weight);
      const k = depth === 1 ? LATERAL_K : LATERAL_K2;
      for (let i = 0; i < Math.min(k, regional.length); i++) {
        this._introduceAndSpread(regional[i].peerId, cId, depth + 1);
      }
    }
  }

  // ── Two-tier helper ───────────────────────────────────────────────────────

  _hasAny(node, peerId) {
    return node.synaptome.has(peerId) || node.highway.has(peerId);
  }

  // ── Local-tier stratified admission ──────────────────────────────────────
  //
  // Change: eviction also skips synaptome entries whose pinWindowFreq meets
  // the threshold even if they have not been registered in pinnedDests yet —
  // "threshold-qualified" entries receive the same eviction immunity.

  _stratifiedAdd(node, newSyn) {
    if (node.synaptome.size < MAX_SYNAPTOME_SIZE) {
      node.addSynapse(newSyn);
      return true;
    }

    const { counts, byGroup } = this._buildGroupCounts(node);

    let evictGroup = -1, maxCount = STRATUM_FLOOR;
    for (let g = 0; g < STRATA_GROUPS; g++) {
      if (counts[g] > maxCount) { maxCount = counts[g]; evictGroup = g; }
    }
    if (evictGroup === -1) return false;

    // Skip pinned destinations AND threshold-qualified entries.
    let weakest = null, weakestW = Infinity;
    for (const syn of byGroup[evictGroup]) {
      if (node.pinnedDests.has(syn.peerId)) continue;
      if ((node.pinWindowFreq?.get(syn.peerId) ?? 0) >= RELAY_PIN_THRESHOLD) continue;
      if (syn.weight < weakestW) { weakestW = syn.weight; weakest = syn; }
    }
    if (!weakest) return false;

    node.synaptome.delete(weakest.peerId);
    node.addSynapse(newSyn);
    return true;
  }

  // ── Highway tier management ───────────────────────────────────────────────

  _refreshHighway(node) {
    if (!node.alive) return;

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
        if (candidates.length >= HUB_SCAN_CAP) break outer;
      }
    }

    const scored = candidates
      .map(c => ({ node: c, score: this._stratumDiversity(c) + Math.random() * HUB_NOISE }))
      .filter(c => c.score >= HUB_MIN_DIVERSITY);

    scored.sort((a, b) => b.score - a.score);

    node.highway.clear();
    for (let i = 0; i < Math.min(HIGHWAY_SLOTS, scored.length); i++) {
      const hub     = scored[i].node;
      const latMs   = roundTripLatency(node, hub);
      const stratum = clz64(node.id ^ hub.id);
      const syn     = new Synapse({ peerId: hub.id, latencyMs: latMs, stratum });
      syn.weight    = 0.5;
      node.highway.set(hub.id, syn);
    }
  }

  _stratumDiversity(node) {
    const groups = new Set();
    for (const syn of node.synaptome.values()) {
      groups.add(syn.stratum >>> 2);
    }
    return groups.size;
  }

  // ── Markov rolling-window tracking ────────────────────────────────────────

  _markovRecord(node, targetKey) {
    node.recentDests.push(targetKey);
    node.recentDestFreq.set(
      targetKey,
      (node.recentDestFreq.get(targetKey) ?? 0) + 1
    );
    if (node.recentDests.length > MARKOV_WINDOW) {
      const evicted = node.recentDests.shift();
      const f = node.recentDestFreq.get(evicted) - 1;
      if (f <= 0) node.recentDestFreq.delete(evicted);
      else        node.recentDestFreq.set(evicted, f);
    }
  }

  // ── Frequency-weighted relay reservation ─────────────────────────────────
  //
  // Dynamic pin budget = min(RELAY_PIN_RESERVE_FRAC × MAX_SYNAPTOME_SIZE,
  //                         number of qualifying destinations).
  // When the budget is full, a new qualifier displaces the lowest-frequency pin
  // (frequency-ranked replacement).

  _updatePins(node, targetKey) {
    // Update the pin rolling window.
    node.pinWindow.push(targetKey);
    node.pinWindowFreq.set(
      targetKey,
      (node.pinWindowFreq.get(targetKey) ?? 0) + 1
    );
    if (node.pinWindow.length > RELAY_PIN_WINDOW) {
      const evicted = node.pinWindow.shift();
      const f = node.pinWindowFreq.get(evicted) - 1;
      if (f <= 0) node.pinWindowFreq.delete(evicted);
      else        node.pinWindowFreq.set(evicted, f);
    }

    const freq = node.pinWindowFreq.get(targetKey) ?? 0;

    // Release pins whose frequency has dropped below the threshold.
    for (const dest of node.pinnedDests) {
      if ((node.pinWindowFreq.get(dest) ?? 0) < RELAY_PIN_THRESHOLD) {
        node.pinnedDests.delete(dest);
      }
    }

    if (freq < RELAY_PIN_THRESHOLD) return;

    const maxPins = Math.floor(RELAY_PIN_RESERVE_FRAC * MAX_SYNAPTOME_SIZE);

    if (!node.pinnedDests.has(targetKey)) {
      if (node.pinnedDests.size < maxPins) {
        // Budget available — pin immediately.
        node.pinnedDests.add(targetKey);
      } else {
        // Budget full — frequency-ranked replacement: evict the least-frequent
        // currently pinned destination if the new entry is more frequent.
        let minFreq = freq;
        let minDest = null;
        for (const dest of node.pinnedDests) {
          const dFreq = node.pinWindowFreq.get(dest) ?? 0;
          if (dFreq < minFreq) { minFreq = dFreq; minDest = dest; }
        }
        if (minDest !== null) {
          node.pinnedDests.delete(minDest);
          node.pinnedDests.add(targetKey);
        }
      }
    }

    // Boost synapse weight if the pinned entry already exists.
    const syn = node.synaptome.get(targetKey) ?? node.highway.get(targetKey);
    if (syn && syn.weight < RELAY_PIN_WEIGHT) {
      syn.weight = RELAY_PIN_WEIGHT;
    }
  }

  // ── Local-tier annealing ──────────────────────────────────────────────────

  _tryAnneal(node) {
    if (!node.alive || node.synaptome.size === 0) return;

    // Guard A: do not anneal below the floor.
    if (node.synaptome.size <= SYNAPTOME_FLOOR) return;

    const { counts, byGroup } = this._buildGroupCounts(node);

    let targetGroup = 0, minCount = Infinity;
    for (let g = 0; g < STRATA_GROUPS; g++) {
      if (counts[g] < minCount) { minCount = counts[g]; targetGroup = g; }
    }

    let evictGroup = -1, maxCount = STRATUM_FLOOR;
    for (let g = 0; g < STRATA_GROUPS; g++) {
      if (counts[g] > maxCount) { maxCount = counts[g]; evictGroup = g; }
    }
    if (evictGroup === -1) return;

    // Skip pinned destinations and threshold-qualified entries.
    let weakest = null, weakestW = Infinity;
    for (const syn of byGroup[evictGroup]) {
      if (node.pinnedDests.has(syn.peerId)) continue;
      if ((node.pinWindowFreq?.get(syn.peerId) ?? 0) >= RELAY_PIN_THRESHOLD) continue;
      if (syn.weight < weakestW) { weakestW = syn.weight; weakest = syn; }
    }
    if (!weakest) return;

    const lo = targetGroup * 4;
    const hi = lo + 3;

    const useGlobal = Math.random() < (node.temperature * GLOBAL_BIAS);
    const candidate = useGlobal
      ? this._globalCandidate(node, lo, hi)
      : this._localCandidate(node, lo, hi);

    if (!candidate || this._hasAny(node, candidate.id)) return;

    node.synaptome.delete(weakest.peerId);
    const latMs   = roundTripLatency(node, candidate);
    const stratum = clz64(node.id ^ candidate.id);
    const newSyn  = new Synapse({ peerId: candidate.id, latencyMs: latMs, stratum });
    newSyn.weight = 0.1;
    node.addSynapse(newSyn);
  }

  // ── Global candidate ──────────────────────────────────────────────────────

  _globalCandidate(node, lo, hi) {
    if (this._annealBufDirty || !this._annealBuffer) {
      this._annealBuffer   = [...this.nodeMap.keys()];
      this._annealBufDirty = false;
    }
    const buf = this._annealBuffer;
    const n   = buf.length;
    if (n === 0) return null;

    const start = Math.floor(Math.random() * n);
    for (let i = 0; i < n; i++) {
      const id = buf[(start + i) % n];
      if (id === node.id) continue;
      const candidate = this.nodeMap.get(id);
      if (!candidate?.alive || this._hasAny(node, id)) continue;
      const stratum = clz64(node.id ^ id);
      if (stratum >= lo && stratum <= hi) return candidate;
    }
    return null;
  }

  // ── Local candidate ───────────────────────────────────────────────────────

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
          if (candidates.length >= ANNEAL_LOCAL_SAMPLE) break outer;
        }
      }
    }
    if (candidates.length === 0) return null;
    return candidates[Math.floor(Math.random() * candidates.length)];
  }

  // ── Stratum group helpers ─────────────────────────────────────────────────

  _buildGroupCounts(node) {
    const counts  = new Array(STRATA_GROUPS).fill(0);
    const byGroup = Array.from({ length: STRATA_GROUPS }, () => []);
    for (const syn of node.synaptome.values()) {
      const g = syn.stratum >>> 2;
      counts[g]++;
      byGroup[g].push(syn);
    }
    return { counts, byGroup };
  }

  // ── Adaptive temporal decay ───────────────────────────────────────────────

  _tickDecay() {
    for (const node of this.nodeMap.values()) {
      this._decayTier(node, node.synaptome, true);
      this._decayTier(node, node.highway, false);
    }
  }

  _decayTier(node, tierMap, applyStructuralRule) {
    const toPrune = [];

    for (const syn of tierMap.values()) {
      if (syn.inertia > this.simEpoch) continue;

      // Pinned destinations always decay at the protected rate and have their
      // weight restored to the pin floor if it drops below.
      if (node.pinnedDests?.has(syn.peerId)) {
        syn.decay(DECAY_GAMMA_MAX);
        if (syn.weight < RELAY_PIN_WEIGHT) syn.weight = RELAY_PIN_WEIGHT;
        continue;   // never a prune candidate
      }

      const useFrac = Math.min(1, (syn.useCount ?? 0) / USE_SATURATION);
      const gamma   = DECAY_GAMMA_MIN + (DECAY_GAMMA_MAX - DECAY_GAMMA_MIN) * useFrac;
      syn.decay(gamma);

      if (syn.weight < PRUNE_THRESHOLD) toPrune.push(syn);
    }

    if (!toPrune.length) return;

    if (!applyStructuralRule) {
      for (const syn of toPrune) tierMap.delete(syn.peerId);
      return;
    }

    // Guard B: if the local tier is at or below the floor, reset
    // all below-threshold weights rather than deleting entries.
    if (tierMap.size <= SYNAPTOME_FLOOR) {
      for (const syn of toPrune) syn.weight = PRUNE_THRESHOLD;
      return;
    }

    // Local tier: apply structural survival rule (per-stratum minimum).
    const byStratum = new Map();
    for (const syn of toPrune) {
      let arr = byStratum.get(syn.stratum);
      if (!arr) { arr = []; byStratum.set(syn.stratum, arr); }
      arr.push(syn);
    }

    const minPerStratum = this._k;
    for (const [stratum, candidates] of byStratum) {
      let total = 0;
      for (const s of tierMap.values()) {
        if (s.stratum === stratum) total++;
      }
      const removable = Math.max(0, total - minPerStratum);
      candidates.sort((a, b) => a.weight - b.weight);
      for (let i = 0; i < candidates.length; i++) {
        if (i < removable) tierMap.delete(candidates[i].peerId);
        else               candidates[i].weight = PRUNE_THRESHOLD;
      }
    }
  }

  // ── Stats ─────────────────────────────────────────────────────────────────

  getStats() {
    const base  = super.getStats();
    const nodes = [...this.nodeMap.values()];
    const localSyn   = nodes.reduce((a, n) => a + n.synaptome.size, 0);
    const hwSyn      = nodes.reduce((a, n) => a + (n.highway?.size ?? 0), 0);
    const avgTemp    = nodes.length
      ? (nodes.reduce((a, n) => a + (n.temperature ?? T_INIT), 0) / nodes.length).toFixed(3)
      : '—';
    const avgPinned  = nodes.length
      ? (nodes.reduce((a, n) => a + (n.pinnedDests?.size ?? 0), 0) / nodes.length).toFixed(2)
      : '0.00';

    return {
      ...base,
      protocol:      'Neuromorphic-11W',
      epoch:         this.simEpoch,
      avgSynapses:   nodes.length ? ((localSyn + hwSyn) / nodes.length).toFixed(1) : 0,
      avgLocalSyn:   nodes.length ? (localSyn / nodes.length).toFixed(1) : 0,
      avgHighwaySyn: nodes.length ? (hwSyn / nodes.length).toFixed(1) : 0,
      avgTemp,
      avgPinned,
    };
  }
}

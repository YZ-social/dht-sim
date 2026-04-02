/**
 * NeuromorphicDHT6W (N-G-DHT-6W) – Generation 6, Browser/Web-Realistic
 *
 * N-6W extends N-5W with four new mechanisms designed for a world-scale
 * peer-to-peer deployment where each node is a browser tab constrained to
 * ~60 warm WebRTC connections.
 *
 * ── Mechanism 1 — Two-Tier Synaptome ─────────────────────────────────────────
 *
 * The 60-connection budget is split into two logically distinct pools:
 *
 *   Local tier  (node.synaptome, 48 slots):
 *     Identical stratified + annealing management inherited from N-5W.
 *     Learns routes through direct experience (hop caching, backpropagation,
 *     lateral spread, triadic closure).
 *
 *   Highway tier  (node.highway, 12 slots):
 *     Reserved for globally well-connected "hub" nodes.  In a real deployment
 *     these hubs would be discovered via a lightweight gossip protocol; in the
 *     simulation we approximate this by scanning the 2-hop neighbourhood for
 *     nodes whose synaptomes cover the most distinct stratum groups.
 *     A node with high stratum diversity has connections that span many
 *     different parts of the XOR key-space — one highway hop can collapse a
 *     multi-hop inter-continental route into a single advance.
 *
 *   Highway refresh (every HUB_REFRESH_INTERVAL=300 lookup participations):
 *     Collect up to HUB_SCAN_CAP=80 candidates from the 2-hop neighbourhood,
 *     score each by stratum diversity, keep the top-HIGHWAY_SLOTS scorers.
 *     A candidate must reach at least HUB_MIN_DIVERSITY=6 distinct groups to
 *     qualify — this prevents local cluster nodes from occupying highway slots.
 *
 * ── Mechanism 2 — Adaptive Temporal Decay ────────────────────────────────────
 *
 * N-5W uses a fixed DECAY_GAMMA = 0.998 for all synapses regardless of use.
 * N-6W tracks a per-synapse use-count (incremented in _reinforceWave) and
 * computes an effective gamma at decay time:
 *
 *   gamma = DECAY_GAMMA_MIN + (DECAY_GAMMA_MAX - DECAY_GAMMA_MIN)
 *                           × min(1, useCount / USE_SATURATION)
 *
 *   DECAY_GAMMA_MIN = 0.990  — cold synapse: loses ~10% weight/interval
 *   DECAY_GAMMA_MAX = 0.9998 — hot synapse:  loses ~0.02% weight/interval
 *   USE_SATURATION  = 20     — uses to reach maximum protection
 *
 * Effect: bootstrap synapses that are never selected for routing self-prune
 * quickly, freeing slots for learned shortcuts; frequently used routes become
 * nearly permanent regardless of the stratified eviction policy.
 *
 * ── Mechanism 3 — Markov Hot-Destination Pre-learning ────────────────────────
 *
 * Hop-caching (N-3+) creates a direct synapse at the source only when a
 * lookup SUCCEEDS and the path was below the EMA latency threshold.  If a
 * destination is repeatedly unreachable (all paths too long, node churned)
 * the source never accumulates a direct shortcut.
 *
 * N-6W tracks the last MARKOV_WINDOW=32 destinations at the source node.
 * When a targetKey appears >= MARKOV_HOT_THRESHOLD=3 times in that window
 * AND the source does not yet have a direct synapse to it, a direct
 * introduction is fired immediately at the START of the lookup — before
 * routing begins.  On the very next hop, the freshly introduced synapse is
 * available as a direct-to-target candidate.
 *
 * This is complementary to hop-caching: hop-caching is path-success-gated;
 * Markov fires unconditionally after enough repetition.
 *
 * ── Mechanism 4 — Highway-Augmented Routing ──────────────────────────────────
 *
 * During routing, highway synapses are included alongside local-tier synapses
 * when building the candidate set.  The two-hop lookahead then evaluates hub
 * nodes' synaptomes — effectively giving each node access to 60 additional
 * forward-progress candidates without consuming extra connections.  Because
 * highway hubs are selected for stratum diversity, they reliably provide the
 * long-range candidates that annealing would otherwise have to discover slowly.
 *
 * ── Inherited from N-5W (unchanged) ──────────────────────────────────────────
 *   • Stratified synaptome eviction (STRATA_GROUPS=16, STRATUM_FLOOR=2)
 *   • Simulated annealing (T_INIT, T_MIN, ANNEAL_COOLING, GLOBAL_BIAS)
 *   • Lateral shortcut propagation (LATERAL_K=3)
 *   • Passive dead-node eviction
 *   • Source-inclusive hop caching
 *   • Shortcut cascade backpropagation
 *   • Two-hop lookahead with advance-per-latency scoring (α=5)
 *   • Triadic closure
 *   • Dense bootstrap (K_BOOT_FACTOR=1 for browser, 20 peers)
 *   • Inertia locks (INERTIA_DURATION=20)
 *   • Intra-regional weight bonus (WEIGHT_SCALE=0.40)
 */

import { DHT }               from '../DHT.js';
import { Synapse }           from './Synapse.js';
import { NeuronNode }        from './NeuronNode.js';
import { randomU64, clz64,
         roundTripLatency,
         buildXorRoutingTable } from '../../utils/geo.js';
import { geoCellId }         from '../../utils/s2.js';

// ── Shared constants (same as N-5W unless noted) ──────────────────────────────

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
const LATERAL_K              = 3;

// ── Tier sizes — total = 48 + 12 = 60 (browser WebRTC budget) ─────────────────

const MAX_SYNAPTOME_SIZE = 48;   // local tier cap
const HIGHWAY_SLOTS      = 12;   // highway tier cap

// ── Local-tier stratification (same logic as N-5W, applied to 48-slot tier) ───

const STRATA_GROUPS  = 16;   // 64 strata ÷ 4 = 16 groups of 4
const STRATUM_FLOOR  = 2;    // 16×2=32 guaranteed; 16 flexible

// ── Simulated annealing (unchanged from N-5W) ─────────────────────────────────

const T_INIT              = 1.0;
const T_MIN               = 0.05;
const ANNEAL_COOLING      = 0.9997;
const GLOBAL_BIAS         = 0.5;
const ANNEAL_LOCAL_SAMPLE = 20;
const ANNEAL_BUF_REBUILD  = 200;

// ── Mechanism 2: Adaptive decay ───────────────────────────────────────────────

const DECAY_GAMMA_MIN = 0.990;   // cold (useCount=0)   → ~10% loss/interval
const DECAY_GAMMA_MAX = 0.9998;  // hot  (useCount≥20)  → ~0.02% loss/interval
const USE_SATURATION  = 20;      // uses needed to reach full decay protection

// ── Mechanism 3: Markov hot-destination learning ──────────────────────────────

const MARKOV_WINDOW        = 16;  // rolling destination window per node
const MARKOV_HOT_THRESHOLD = 3;   // appearances before eager introduction fires

// ── Mechanism 1: Highway / hub management ─────────────────────────────────────

const HUB_REFRESH_INTERVAL = 300;  // lookup participations between refreshes
const HUB_SCAN_CAP         = 80;   // max 2-hop candidates evaluated per refresh
const HUB_MIN_DIVERSITY    = 6;    // min distinct strata groups to qualify as hub

// ─────────────────────────────────────────────────────────────────────────────
// NeuromorphicDHT6W
// ─────────────────────────────────────────────────────────────────────────────

export class NeuromorphicDHT6W extends DHT {
  static get protocolName() { return 'Neuromorphic-6W'; }

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

    // Per-node N-6W state (duck-typed onto NeuronNode)
    node.temperature      = T_INIT;
    node.highway          = new Map();      // peerId → Synapse (highway tier)
    node.hubRefreshCount  = 0;              // lookup participations since last refresh
    node.recentDests      = [];             // Markov: rolling dest array
    node.recentDestFreq   = new Map();      // Markov: dest → count in window

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
        // Bootstrap fills local tier directly; 20 peers is well under the 48 cap.
        node.addSynapse(new Synapse({ peerId: peer.id, latencyMs: latMs, stratum }));
        if (this.bidirectional) peer.addIncomingSynapse(node.id, latMs, stratum);
      }
      node._nodeMapRef = this.nodeMap;
    }
    // Highway starts empty — fills during first HUB_REFRESH_INTERVAL lookups.
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

    // ── Mechanism 3: Markov hot-destination pre-learning ──────────────────
    // Update the source node's rolling destination window.
    this._markovRecord(source, targetKey);
    // If this target is "hot" and we lack a direct synapse, create one now —
    // it will be available as a candidate on the very first hop below.
    if (!this._hasAny(source, targetKey)) {
      const freq = source.recentDestFreq.get(targetKey) ?? 0;
      if (freq >= MARKOV_HOT_THRESHOLD) {
        this._introduce(sourceId, targetKey);
      }
    }

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

      // Collect forward-progress candidates from BOTH local and highway tiers.
      // Passive dead-node eviction: zero weight on first encounter.
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
      // Priority 0: direct-to-target short-circuit (checks both tiers).
      const directSyn = current.synaptome.get(targetKey) ?? current.highway.get(targetKey)
                     ?? current.incomingSynapses.get(targetKey);
      if (directSyn && this.nodeMap.get(targetKey)?.alive) {
        nextSyn = directSyn;
      } else if (hop === 0 && Math.random() < EXPLORATION_EPSILON) {
        nextSyn = candidates[Math.floor(Math.random() * candidates.length)];
      } else if (inTargetRegion) {
        nextSyn = this._bestByTwoHopAP(current, candidates, targetKey, currentDist, WEIGHT_SCALE);
      } else {
        nextSyn = this._bestByTwoHopAP(current, candidates, targetKey, currentDist, 0);
      }

      const nextId   = nextSyn.peerId;
      const nextNode = this.nodeMap.get(nextId);
      if (!nextNode) break;

      path.push(nextId);
      trace.push({ fromId: currentId, synapse: nextSyn });
      totalTimeMs += nextSyn.latency;

      // Triadic closure (intermediate nodes only).
      if (currentId !== sourceId) {
        this._recordTransit(current, sourceId, nextId);
      }

      // Source-inclusive hop caching with lateral spread.
      if (currentId !== targetKey) {
        this._introduceAndSpread(currentId, targetKey);
      }

      // ── Simulated annealing ───────────────────────────────────────────────
      current.temperature = Math.max(T_MIN, current.temperature * ANNEAL_COOLING);
      if (Math.random() < current.temperature) {
        this._tryAnneal(current);
      }

      // ── Mechanism 1: Highway refresh ─────────────────────────────────────
      if (++current.hubRefreshCount >= HUB_REFRESH_INTERVAL) {
        current.hubRefreshCount = 0;
        this._refreshHighway(current);
      }

      currentId = nextId;
    }

    // LTP reinforcement on successful below-EMA-latency paths.
    const hopCount = path.length - 1;
    if (reached) {
      this._emaHops = this._emaHops === null
        ? hopCount : 0.9 * this._emaHops + 0.1 * hopCount;
      this._emaTime = this._emaTime === null
        ? totalTimeMs : 0.9 * this._emaTime + 0.1 * totalTimeMs;
      if (trace.length > 0 && totalTimeMs <= this._emaTime) {
        this._reinforceWave(trace);
      }

      // Shortcut cascade backpropagation.
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

  // ── LTP reinforcement wave (tracks useCount for adaptive decay) ───────────

  _reinforceWave(trace) {
    for (let i = trace.length - 1; i >= 0; i--) {
      const { fromId, synapse } = trace[i];
      const node = this.nodeMap.get(fromId);
      if (!node) continue;
      // Check both tiers — a highway synapse may be on the winning path.
      const syn = node.synaptome.get(synapse.peerId) ?? node.highway.get(synapse.peerId);
      if (syn) {
        syn.reinforce(this.simEpoch, INERTIA_DURATION);
        syn.useCount = (syn.useCount ?? 0) + 1;  // adaptive decay tracking
      }
    }
  }

  // ── 2-hop lookahead AP selection ──────────────────────────────────────────
  // Reads the peer's full synaptome (local + highway) for the second hop.

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

      // Collect forward candidates from peer's both tiers.
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

  // ── Standard introduce (stratified into local tier) ───────────────────────

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

  // ── Introduce with lateral spread ─────────────────────────────────────────

  _introduceAndSpread(aId, cId) {
    const nodeA = this.nodeMap.get(aId);
    const nodeC = this.nodeMap.get(cId);
    if (!nodeA || !nodeC || !nodeA.alive || !nodeC.alive) return;
    if (this._hasAny(nodeA, cId)) return;

    const latMs   = roundTripLatency(nodeA, nodeC);
    const stratum = clz64(nodeA.id ^ nodeC.id);
    const syn     = new Synapse({ peerId: cId, latencyMs: latMs, stratum });
    syn.weight    = 0.5;
    const added   = this._stratifiedAdd(nodeA, syn);

    if (added) {
      const aRegion  = aId >> BigInt(64 - GEO_REGION_BITS);
      const regional = [];
      for (const s of nodeA.synaptome.values()) {
        if (s.peerId === cId) continue;
        if ((s.peerId >> BigInt(64 - GEO_REGION_BITS)) !== aRegion) continue;
        if (this.nodeMap.get(s.peerId)?.alive) regional.push(s);
      }
      regional.sort((a, b) => b.weight - a.weight);
      for (let i = 0; i < Math.min(LATERAL_K, regional.length); i++) {
        this._introduce(regional[i].peerId, cId);
      }
    }
  }

  // ── Two-tier helper ───────────────────────────────────────────────────────
  // Returns true if peerId is present in either the local or highway tier.

  _hasAny(node, peerId) {
    return node.synaptome.has(peerId) || node.highway.has(peerId);
  }

  // ── Local-tier stratified admission ──────────────────────────────────────

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

    let weakest = null, weakestW = Infinity;
    for (const syn of byGroup[evictGroup]) {
      if (syn.weight < weakestW) { weakestW = syn.weight; weakest = syn; }
    }
    if (!weakest) return false;

    node.synaptome.delete(weakest.peerId);
    node.addSynapse(newSyn);
    return true;
  }

  // ── Mechanism 1: Highway tier management ─────────────────────────────────
  //
  // Scans the 2-hop neighbourhood for the highest-stratum-diversity nodes
  // and fills the highway tier with up to HIGHWAY_SLOTS of them.

  _refreshHighway(node) {
    if (!node.alive) return;

    const candidates = [];
    const seen       = new Set([node.id]);

    // Collect up to HUB_SCAN_CAP peers-of-peers.
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

    // Score each candidate by stratum diversity of its synaptome.
    const scored = candidates
      .map(c => ({ node: c, score: this._stratumDiversity(c) }))
      .filter(c => c.score >= HUB_MIN_DIVERSITY);

    scored.sort((a, b) => b.score - a.score);

    // Rebuild highway with top-scoring hubs.
    node.highway.clear();
    for (let i = 0; i < Math.min(HIGHWAY_SLOTS, scored.length); i++) {
      const hub     = scored[i].node;
      const latMs   = roundTripLatency(node, hub);
      const stratum = clz64(node.id ^ hub.id);
      const syn     = new Synapse({ peerId: hub.id, latencyMs: latMs, stratum });
      syn.weight    = 0.5;  // hubs start with meaningful weight
      node.highway.set(hub.id, syn);
    }
  }

  // Returns the number of distinct stratum groups (0–15) covered by a node's
  // local synaptome — used as the hub quality score.
  _stratumDiversity(node) {
    const groups = new Set();
    for (const syn of node.synaptome.values()) {
      groups.add(syn.stratum >>> 2);
    }
    return groups.size;
  }

  // ── Mechanism 3: Markov rolling-window tracking ───────────────────────────

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

  // ── Local-tier annealing ──────────────────────────────────────────────────

  _tryAnneal(node) {
    if (!node.alive || node.synaptome.size === 0) return;

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

    let weakest = null, weakestW = Infinity;
    for (const syn of byGroup[evictGroup]) {
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

  // ── Global candidate ─────────────────────────────────────────────────────

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

  // ── Mechanism 2: Adaptive temporal decay ─────────────────────────────────
  // Synapses with high useCount decay slowly (valuable learned routes);
  // unused synapses decay quickly (frees slots for new discoveries).

  _tickDecay() {
    for (const node of this.nodeMap.values()) {
      // Decay local tier.
      this._decayTier(node, node.synaptome, true);
      // Decay highway tier (no structural survival rule applies there).
      this._decayTier(node, node.highway, false);
    }
  }

  _decayTier(node, tierMap, applyStructuralRule) {
    const toPrune = [];

    for (const syn of tierMap.values()) {
      if (syn.inertia > this.simEpoch) continue;

      // Adaptive gamma: used synapses decay much slower than cold ones.
      const useFrac = Math.min(1, (syn.useCount ?? 0) / USE_SATURATION);
      const gamma   = DECAY_GAMMA_MIN + (DECAY_GAMMA_MAX - DECAY_GAMMA_MIN) * useFrac;
      syn.decay(gamma);

      if (syn.weight < PRUNE_THRESHOLD) toPrune.push(syn);
    }

    if (!toPrune.length) return;

    if (!applyStructuralRule) {
      // Highway: prune all below-threshold entries directly.
      for (const syn of toPrune) tierMap.delete(syn.peerId);
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
    return {
      ...base,
      protocol:     'Neuromorphic-6W',
      epoch:        this.simEpoch,
      avgSynapses:  nodes.length ? ((localSyn + hwSyn) / nodes.length).toFixed(1) : 0,
      avgLocalSyn:  nodes.length ? (localSyn / nodes.length).toFixed(1) : 0,
      avgHighwaySyn: nodes.length ? (hwSyn / nodes.length).toFixed(1) : 0,
      avgTemp,
    };
  }
}

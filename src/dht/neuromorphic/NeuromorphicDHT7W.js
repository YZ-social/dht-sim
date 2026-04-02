/**
 * NeuromorphicDHT7W (N-G-DHT-7W) – Generation 7, Load-Balanced Browser/Web-Realistic
 *
 * N-7W extends N-6W with four new mechanisms (5–8) whose shared goal is to
 * reduce routing-hotspot concentration.  Profiling of N-6W showed a highway-
 * link Gini coefficient of 0.88, meaning a small fraction of hub nodes absorb
 * a disproportionate share of all relay traffic.  All five neuromorphic
 * generations tested (N-3W through N-6W) cluster in the 0.87–0.92 Gini band,
 * whereas the Kademlia baseline sits at 0.84.  The mechanisms below are
 * designed to close that gap to ≤ 0.85 without sacrificing hop-count or
 * latency improvements already won in N-6W.
 *
 * ── Mechanism 1 — Two-Tier Synaptome (inherited from N-6W) ───────────────────
 *
 * The 60-connection budget is split into two pools:
 *
 *   Local tier  (node.synaptome, 40 slots — adjusted down from 48 to make
 *                room for the wider highway pool):
 *     Stratified + annealing management identical to N-5W/N-6W.  Learns
 *     routes through direct experience (hop caching, backpropagation,
 *     lateral spread, triadic closure).
 *
 *   Highway tier  (node.highway, 20 slots — up from 12):
 *     Reserved for globally well-connected "hub" nodes.  Hubs are scored by
 *     the number of distinct stratum groups they cover in their synaptome,
 *     then the top HIGHWAY_SLOTS are kept.  In N-7W the scan pool is wider
 *     (HUB_SCAN_CAP=120), the qualifying bar is slightly lower
 *     (HUB_MIN_DIVERSITY=5), and score selection includes random noise to
 *     prevent deterministic re-selection of the same hubs on every refresh
 *     (see Mechanism 7).
 *
 *   Total connections: 40 + 20 = 60 (unchanged browser WebRTC budget).
 *
 * ── Mechanism 2 — Adaptive Temporal Decay (inherited from N-6W) ──────────────
 *
 * Per-synapse use-count drives an effective gamma at decay time:
 *
 *   gamma = DECAY_GAMMA_MIN + (DECAY_GAMMA_MAX - DECAY_GAMMA_MIN)
 *                           × min(1, useCount / USE_SATURATION)
 *
 *   DECAY_GAMMA_MIN = 0.990  — cold synapse: loses ~10% weight/interval
 *   DECAY_GAMMA_MAX = 0.9998 — hot synapse:  loses ~0.02% weight/interval
 *   USE_SATURATION  = 20     — uses to reach maximum decay protection
 *
 * ── Mechanism 3 — Markov Hot-Destination Pre-learning (inherited from N-6W) ──
 *
 * N-6W tracks the last MARKOV_WINDOW=32 destinations per source node and fires
 * a direct introduction when a target appears ≥ MARKOV_HOT_THRESHOLD=3 times
 * and no direct synapse exists yet.  N-7W retains the same trigger logic but
 * scales the initial weight of the introduced synapse by destination frequency
 * (Mechanism 8).
 *
 * ── Mechanism 4 — Highway-Augmented Routing (inherited from N-6W) ────────────
 *
 * Highway synapses are included alongside local-tier synapses when building the
 * per-hop candidate set.  The two-hop lookahead evaluates the peer's both tiers,
 * giving each node ~60 additional forward-progress candidates for free.
 *
 * ── Mechanism 5 — Per-Node Load Tracking with Lazy Decay (NEW) ───────────────
 *
 * Each node carries a load signal (node.loadEMA, node.loadLastEpoch).  Every
 * time a node is selected as the next relay hop during routing, its load is
 * incremented by (1 − LOAD_DECAY) after applying exponential decay over the
 * epochs elapsed since its last update:
 *
 *   decayedLoad = loadEMA × LOAD_DECAY^(simEpoch − loadLastEpoch)
 *   loadEMA     = decayedLoad + (1 − LOAD_DECAY)
 *
 * This is a lazy/amortised design: we never sweep all nodes each lookup.
 * Only nodes actually used in routing are ever updated; all others accrue
 * passive decay that is computed on demand via _decayedLoad().  The result
 * is that a heavily used hub's EMA rises toward 1.0, while idle nodes'
 * signals drift toward 0 over time.
 *
 * LOAD_DECAY = 0.995 — with this value, a node's contribution from a single
 * relay participation decays to half of its initial value after roughly
 * 138 lookups, and to ~1% after ~920 lookups.
 *
 * ── Mechanism 6 — Load-Aware AP Scoring (NEW) ────────────────────────────────
 *
 * In the two-hop lookahead (_bestByTwoHopAP), both the one-hop (ap1) and
 * two-hop combined (ap2) scores are multiplied by a load discount factor:
 *
 *   loadDiscount = max(LOAD_FLOOR, 1 − LOAD_PENALTY × (load / LOAD_SATURATION))
 *
 *   LOAD_PENALTY    = 0.40  — at saturation, the AP score is reduced by 40%
 *   LOAD_FLOOR      = 0.10  — even a saturated node retains 10% of its score
 *   LOAD_SATURATION = 0.15  — loadEMA value treated as "fully saturated"
 *
 * By penalising hot nodes' AP scores the algorithm naturally routes around
 * heavily loaded hubs when alternative peers of comparable quality exist.
 * The LOAD_FLOOR prevents complete exclusion of saturated nodes — they remain
 * eligible as a last resort.
 *
 * The ap1 discount uses the direct candidate's own load; the ap2 discount uses
 * the first-hop candidate's load, since it is the node that will be the relay.
 *
 * ── Mechanism 7 — Extended + Randomised Hub Pool (NEW) ───────────────────────
 *
 * Three parameter changes widen the effective hub search space:
 *
 *   HIGHWAY_SLOTS = 20  (was 12) — more hub connections, broader fan-out
 *   HUB_SCAN_CAP  = 120 (was 80) — wider 2-hop candidate scan
 *   HUB_MIN_DIVERSITY = 5 (was 6) — lower bar, more nodes qualify as hubs
 *
 * Additionally, a uniform random noise term (HUB_NOISE = 1.0) is added to
 * each candidate's stratum-diversity score before sorting.  Without noise,
 * all nodes with the same 2-hop neighbourhood would select identical hub
 * sets, causing the same handful of nodes to appear in thousands of highway
 * tiers simultaneously.  The noise ensures that ties are broken differently
 * on every refresh, spreading highway connections across a larger fraction
 * of qualifying hubs.
 *
 * ── Mechanism 8 — Adaptive Markov Weight (NEW) ───────────────────────────────
 *
 * When a Markov hot-destination introduction is triggered, the initial weight
 * of the new synapse is scaled proportionally to the destination's frequency
 * within the rolling window:
 *
 *   markovWeight = min(MARKOV_MAX_WEIGHT,
 *     MARKOV_BASE_WEIGHT + (MARKOV_MAX_WEIGHT − MARKOV_BASE_WEIGHT)
 *                        × (freq / MARKOV_WINDOW))
 *
 *   MARKOV_BASE_WEIGHT = 0.3  — floor weight for a barely-hot destination
 *   MARKOV_MAX_WEIGHT  = 0.9  — ceiling weight for a maximally frequent dest
 *
 * A destination seen 3 times (the threshold) in a window of 32 gets a weight
 * of ≈0.37; one seen 32/32 times gets 0.9.  This lets the LTP reinforcement
 * loop build up high-frequency shortcuts faster while not over-committing
 * slots to marginal destinations.
 *
 * ── Inherited from N-5W / N-6W (unchanged) ───────────────────────────────────
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
 *
 * ── Design rationale ─────────────────────────────────────────────────────────
 *
 * Hotspot concentration is a structural property of all preferential-attachment
 * routing systems: nodes that forward many lookups gain more reinforced synapses
 * from more sources, which causes even more traffic to route through them.
 * N-7W attacks this cycle on three fronts:
 *
 *   1. Signal (Mechanism 5): make each node's load observable to its peers.
 *   2. Score (Mechanism 6): penalise hot nodes at selection time.
 *   3. Diversity (Mechanism 7+8): widen the hub pool and vary its composition
 *      so that alternative hubs are always available and receive proportional
 *      initial weight when introduced as shortcuts.
 *
 * The combined effect is expected to reduce highway Gini from 0.88 (N-6W)
 * toward ≤ 0.85, matching or bettering the Kademlia baseline of 0.84.
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
const LATERAL_K              = 3;

// ── Tier sizes — total = 40 + 20 = 60 (browser WebRTC budget) ◀ ──────────────

const MAX_SYNAPTOME_SIZE = 40;   // local tier cap (◀ was 48)
const HIGHWAY_SLOTS      = 20;   // highway tier cap (◀ was 12)

// ── Local-tier stratification ─────────────────────────────────────────────────

const STRATA_GROUPS  = 16;   // 64 strata ÷ 4 = 16 groups of 4
const STRATUM_FLOOR  = 2;    // 16×2=32 guaranteed; 8 flexible

// ── Simulated annealing ───────────────────────────────────────────────────────

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

// ── Mechanism 3 + 8: Markov hot-destination learning ─────────────────────────

const MARKOV_WINDOW        = 16;   // rolling destination window per node
const MARKOV_HOT_THRESHOLD = 3;    // appearances before eager introduction fires
const MARKOV_BASE_WEIGHT   = 0.3;  // ◀ new: floor synapse weight for hot dest
const MARKOV_MAX_WEIGHT    = 0.9;  // ◀ new: ceiling synapse weight for hot dest

// ── Mechanism 1 + 7: Highway / hub management ─────────────────────────────────

const HUB_REFRESH_INTERVAL = 300;  // lookup participations between refreshes
const HUB_SCAN_CAP         = 120;  // ◀ was 80: max 2-hop candidates per refresh
const HUB_MIN_DIVERSITY    = 5;    // ◀ was 6: min distinct strata groups to qualify
const HUB_NOISE            = 1.0;  // ◀ new: random score perturbation per refresh

// ── Mechanism 5 + 6: Load awareness ──────────────────────────────────────────

const LOAD_DECAY       = 0.995;   // EMA decay factor per lookup participation
const LOAD_PENALTY     = 0.40;    // max AP multiplier reduction at saturation
const LOAD_FLOOR       = 0.10;    // minimum load discount (never excludes entirely)
const LOAD_SATURATION  = 0.15;    // loadEMA value treated as "fully saturated"

// ─────────────────────────────────────────────────────────────────────────────
// NeuromorphicDHT7W
// ─────────────────────────────────────────────────────────────────────────────

export class NeuromorphicDHT7W extends DHT {
  static get protocolName() { return 'Neuromorphic-7W'; }

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

    // Per-node N-7W state (Mechanism 5)
    node.loadEMA          = 0;              // exponential moving average of relay load
    node.loadLastEpoch    = 0;              // simEpoch when loadEMA was last written

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
        // Bootstrap fills local tier directly; 20 peers is well under the 40 cap.
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

    // ── Mechanism 3 + 8: Markov hot-destination pre-learning ──────────────
    // Update the source node's rolling destination window.
    this._markovRecord(source, targetKey);
    // If this target is "hot" and we lack a direct synapse, create one now —
    // it will be available as a candidate on the very first hop below.
    // Mechanism 8: the initial weight scales with destination frequency.
    if (!this._hasAny(source, targetKey)) {
      const freq = source.recentDestFreq.get(targetKey) ?? 0;
      if (freq >= MARKOV_HOT_THRESHOLD) {
        const markovWeight = Math.min(MARKOV_MAX_WEIGHT,
          MARKOV_BASE_WEIGHT + (MARKOV_MAX_WEIGHT - MARKOV_BASE_WEIGHT) * (freq / MARKOV_WINDOW));
        this._introduce(sourceId, targetKey, markovWeight);
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

      // Mechanism 5: record relay load on the node about to be visited.
      nextNode.loadEMA       = this._decayedLoad(nextNode) + (1 - LOAD_DECAY);
      nextNode.loadLastEpoch = this.simEpoch;

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

      // ── Mechanism 1 + 7: Highway refresh ─────────────────────────────────
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

  // ── Mechanism 5: Lazy load decay helper ───────────────────────────────────
  // Returns the decayed loadEMA for a node without mutating it.  The actual
  // write-back happens only when the node is selected as a relay hop.

  _decayedLoad(node) {
    const elapsed = this.simEpoch - (node.loadLastEpoch ?? 0);
    return (node.loadEMA ?? 0) * Math.pow(LOAD_DECAY, elapsed);
  }

  // ── 2-hop lookahead AP selection (Mechanism 6: load-aware) ───────────────
  // Reads the peer's full synaptome (local + highway) for the second hop.
  // Load discounts are applied to both the 1-hop and 2-hop combined scores.

  _bestByTwoHopAP(current, candidates, targetKey, currentDist, wScale) {
    const sorted = candidates
      .map(s => {
        const peer = this.nodeMap.get(s.peerId);
        const pd   = s.peerId ^ targetKey;
        let ap1    = (Number(currentDist - pd) / s.latency) * (1 + wScale * s.weight);

        // Mechanism 6: discount ap1 by the candidate peer's load.
        const peerLoad     = this._decayedLoad(peer);
        const loadDiscount = Math.max(LOAD_FLOOR, 1 - LOAD_PENALTY * (peerLoad / LOAD_SATURATION));
        ap1 *= loadDiscount;

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
      let ap2         = (progress2 / totalLat) * (1 + wScale * firstSyn.weight);

      // Mechanism 6: discount ap2 by the first-hop node's load (it is the relay).
      ap2 *= Math.max(LOAD_FLOOR, 1 - LOAD_PENALTY * (this._decayedLoad(firstNode) / LOAD_SATURATION));

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

  // ── Mechanism 1 + 7: Highway tier management ──────────────────────────────
  //
  // Scans the 2-hop neighbourhood for the highest-stratum-diversity nodes and
  // fills the highway tier with up to HIGHWAY_SLOTS of them.  Random noise is
  // added to each candidate's score (Mechanism 7) to prevent identical hub
  // selection across refreshes.

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

    // Score each candidate by stratum diversity of its synaptome, with random
    // noise to prevent deterministic re-selection (Mechanism 7).
    const scored = candidates
      .map(c => ({ node: c, score: this._stratumDiversity(c) + Math.random() * HUB_NOISE }))
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

    // Mechanism 5: median loadEMA across live nodes.
    let avgLoad = '0.0000';
    if (nodes.length > 0) {
      const loads = nodes
        .map(n => this._decayedLoad(n))
        .sort((a, b) => a - b);
      const mid = Math.floor(loads.length / 2);
      const median = loads.length % 2 === 0
        ? (loads[mid - 1] + loads[mid]) / 2
        : loads[mid];
      avgLoad = median.toFixed(4);
    }

    return {
      ...base,
      protocol:      'Neuromorphic-7W',
      epoch:         this.simEpoch,
      avgSynapses:   nodes.length ? ((localSyn + hwSyn) / nodes.length).toFixed(1) : 0,
      avgLocalSyn:   nodes.length ? (localSyn / nodes.length).toFixed(1) : 0,
      avgHighwaySyn: nodes.length ? (hwSyn / nodes.length).toFixed(1) : 0,
      avgTemp,
      avgLoad,
    };
  }
}

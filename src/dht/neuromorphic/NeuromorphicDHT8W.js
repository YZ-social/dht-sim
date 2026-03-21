/**
 * NeuromorphicDHT8W (N-G-DHT-8W) – Generation 8, Cascading Lateral Spread + Load-Aware Routing
 *
 * N-8W is a hybrid of N-4's lateral spread scaling insight and N-7W's load-aware
 * routing.  It takes N-7W as its direct base and introduces two targeted changes:
 * a tier rebalancing that restores the N-6W local/highway split, and a depth-aware
 * cascading lateral spread that replaces N-7W's single-hop broadcast.  Every other
 * mechanism — adaptive decay, Markov hot-destination learning, load-aware AP
 * scoring, the extended randomised hub pool, two-tier synaptome structure,
 * stratified eviction, and simulated annealing — is carried over unchanged.
 *
 * ── Change 1 — Tier Rebalancing (restores N-6W split) ────────────────────────
 *
 * N-7W shifted budget from the local tier to the highway tier (40 + 20 = 60) to
 * give load-aware routing a larger hub fan-out.  Profiling showed that the extra
 * highway slots offer diminishing returns once the scan pool (HUB_SCAN_CAP=120)
 * is wide: hub diversity is already adequate at 12 highway connections.  The 8
 * reclaimed slots are returned to the local tier, which directly benefits lateral
 * spread: more room for learned geographic shortcuts means fewer evictions when
 * the cascade places new synapses.
 *
 *   MAX_SYNAPTOME_SIZE = 48   (was 40 in N-7W; restores N-6W value)
 *   HIGHWAY_SLOTS      = 12   (was 20 in N-7W; restores N-6W value)
 *   Total              = 60   (unchanged browser WebRTC budget)
 *
 * ── Change 2 — Cascading Lateral Spread ──────────────────────────────────────
 *
 * Background — why lateral spread outperforms annealing at scale:
 *
 *   Simulated annealing (Mechanism 4 in N-5W+) discovers new synapses by
 *   randomly sampling the global node population or the 2-hop neighbourhood.
 *   At N = 50,000 nodes the synaptome covers only 60 / 50,000 = 0.12% of nodes,
 *   and the 2-hop neighbourhood covers roughly 60² = 3,600 / 50,000 = 7.2%.
 *   Most annealing trials miss the geographic cluster that contains the current
 *   routing target, so the shortcut acceptance rate drops sharply with network
 *   size.
 *
 *   Lateral spread (introduced in N-4) sidesteps this problem entirely.  When
 *   node A discovers a shortcut to target C during a live lookup, A already knows
 *   which of its synaptome peers are in the same geographic region as C (they
 *   share the same top GEO_REGION_BITS of their ID).  A can therefore push the
 *   shortcut directly to those regional neighbours without any random sampling.
 *   This is O(LATERAL_K) work per discovery event and is guaranteed to reach
 *   peers that are topologically close to the target — exactly the nodes that
 *   will benefit most from the shortcut in future lookups.
 *
 *   At N = 50,000 with GEO_REGION_BITS = 4 there are 16 geographic regions of
 *   ~3,125 nodes each.  A node's synaptome will on average contain
 *   48 × (3,125 / 50,000) ≈ 3 regional peers.  With LATERAL_K = 6, the spread
 *   comfortably covers all regional neighbours already in the synaptome.
 *
 * N-7W's lateral spread (LATERAL_K = 3):
 *
 *   When node A gains a shortcut to C, A tells its top-3 regional neighbours.
 *   Total nodes that learn the shortcut per discovery event: 1 (A) + 3 = 4.
 *
 * N-8W's cascading lateral spread (LATERAL_K = 6, LATERAL_K2 = 2, depth = 2):
 *
 *   When node A gains a shortcut to C (depth=1):
 *     A tells its top-6 regional neighbours (depth=1 spread, LATERAL_K = 6).
 *     Each of those 6 nodes, when they in turn gain the shortcut, tells their
 *     own top-2 regional neighbours (depth=2 spread, LATERAL_K2 = 2).
 *     Depth-3 calls do not recurse (LATERAL_MAX_DEPTH = 2 terminates at depth=2).
 *
 *   Total nodes that learn the shortcut per discovery event:
 *     1  (A itself)
 *   + 6  (depth-1 spread: LATERAL_K)
 *   + 12 (depth-2 spread: LATERAL_K × LATERAL_K2 = 6 × 2)
 *   = 19  nodes in the geographic cluster, up from 4 in N-7W.
 *
 *   The cascade terminates at depth=2 to contain message amplification.  Each
 *   recursive call is guarded by the same _hasAny check, so nodes that already
 *   hold the shortcut do not spread further, and the worst-case total is bounded
 *   at 1 + LATERAL_K + LATERAL_K × LATERAL_K2 regardless of graph density.
 *
 * Interaction with load-aware AP scoring:
 *
 *   Within _introduceAndSpread, the depth-1 spread selects the top-LATERAL_K
 *   regional neighbours by synapse weight (b.weight − a.weight sort).  Synapse
 *   weights reflect past routing success, which is itself discounted by load via
 *   the AP-scoring mechanism (Mechanism 6).  As a result, shortcuts preferentially
 *   cascade toward the least-loaded well-connected regional nodes, reinforcing
 *   load balancing rather than undermining it.
 *
 * ── Mechanism 1 — Two-Tier Synaptome (inherited from N-6W / N-7W) ─────────────
 *
 * The 60-connection budget is split into two pools:
 *
 *   Local tier  (node.synaptome, 48 slots — restored from N-6W):
 *     Stratified + annealing management identical to N-7W.  Learns routes
 *     through direct experience (hop caching, backpropagation, lateral spread
 *     cascade, triadic closure).  The extra 8 slots vs N-7W give the cascade
 *     more room to place incoming shortcuts without evicting existing ones.
 *
 *   Highway tier  (node.highway, 12 slots — restored from N-6W):
 *     Reserved for globally well-connected "hub" nodes scored by stratum
 *     diversity.  HUB_SCAN_CAP=120 and HUB_NOISE=1.0 are retained from N-7W
 *     to keep selection wide and non-deterministic.
 *
 *   Total connections: 48 + 12 = 60 (unchanged browser WebRTC budget).
 *
 * ── Mechanism 2 — Adaptive Temporal Decay (inherited from N-7W) ──────────────
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
 * ── Mechanism 3 — Markov Hot-Destination Pre-learning (inherited from N-7W) ───
 *
 * Tracks the last MARKOV_WINDOW=32 destinations per source node and fires a
 * direct introduction when a target appears ≥ MARKOV_HOT_THRESHOLD=3 times and
 * no direct synapse exists yet.  Initial weight scales with destination frequency
 * (Mechanism 8).
 *
 * ── Mechanism 4 — Highway-Augmented Routing (inherited from N-7W) ─────────────
 *
 * Highway synapses are included alongside local-tier synapses when building the
 * per-hop candidate set.  The two-hop lookahead evaluates both tiers of the peer,
 * giving each node ~60 additional forward-progress candidates for free.
 *
 * ── Mechanism 5 — Per-Node Load Tracking with Lazy Decay (inherited from N-7W) ─
 *
 * Each node carries a load signal (node.loadEMA, node.loadLastEpoch).  Every
 * time a node is selected as the next relay hop during routing, its load is
 * incremented by (1 − LOAD_DECAY) after applying exponential decay over the
 * epochs elapsed since its last update:
 *
 *   decayedLoad = loadEMA × LOAD_DECAY^(simEpoch − loadLastEpoch)
 *   loadEMA     = decayedLoad + (1 − LOAD_DECAY)
 *
 * This is a lazy/amortised design: only nodes actually used in routing are ever
 * updated; all others accrue passive decay that is computed on demand.
 *
 *   LOAD_DECAY = 0.995 — contribution from a single relay participation decays
 *   to half its initial value after ~138 lookups, ~1% after ~920 lookups.
 *
 * ── Mechanism 6 — Load-Aware AP Scoring (inherited from N-7W) ────────────────
 *
 * In the two-hop lookahead (_bestByTwoHopAP), both ap1 and ap2 scores are
 * multiplied by a load discount factor:
 *
 *   loadDiscount = max(LOAD_FLOOR, 1 − LOAD_PENALTY × (load / LOAD_SATURATION))
 *
 *   LOAD_PENALTY    = 0.40  — at saturation the AP score is reduced by 40%
 *   LOAD_FLOOR      = 0.10  — even a saturated node retains 10% of its score
 *   LOAD_SATURATION = 0.15  — loadEMA value treated as "fully saturated"
 *
 * ── Mechanism 7 — Extended + Randomised Hub Pool (inherited from N-7W) ────────
 *
 *   HUB_SCAN_CAP      = 120  — wide 2-hop candidate scan
 *   HUB_MIN_DIVERSITY = 5    — lower qualifying bar for hub status
 *   HUB_NOISE         = 1.0  — random noise prevents deterministic re-selection
 *
 * ── Mechanism 8 — Adaptive Markov Weight (inherited from N-7W) ───────────────
 *
 * When a Markov hot-destination introduction fires, the initial weight of the new
 * synapse scales with destination frequency:
 *
 *   markovWeight = min(MARKOV_MAX_WEIGHT,
 *     MARKOV_BASE_WEIGHT + (MARKOV_MAX_WEIGHT − MARKOV_BASE_WEIGHT)
 *                        × (freq / MARKOV_WINDOW))
 *
 *   MARKOV_BASE_WEIGHT = 0.3   MARKOV_MAX_WEIGHT = 0.9
 *
 * ── Inherited from N-5W / N-6W / N-7W (unchanged) ────────────────────────────
 *   • Stratified synaptome eviction (STRATA_GROUPS=16, STRATUM_FLOOR=2)
 *   • Simulated annealing (T_INIT, T_MIN, ANNEAL_COOLING, GLOBAL_BIAS)
 *   • Passive dead-node eviction
 *   • Source-inclusive hop caching
 *   • Shortcut cascade backpropagation
 *   • Two-hop lookahead with advance-per-latency scoring (α=5)
 *   • Triadic closure
 *   • Dense bootstrap (K_BOOT_FACTOR=1 for browser, 20 peers)
 *   • Inertia locks (INERTIA_DURATION=20)
 *   • Intra-regional weight bonus (WEIGHT_SCALE=0.40)
 *
 * ── Design rationale ──────────────────────────────────────────────────────────
 *
 * N-7W's three-front attack on hotspot concentration (signal, score, diversity)
 * is retained in full.  N-8W adds a fourth front: cluster saturation.  By
 * propagating each shortcut discovery to up to 19 nodes in the same geographic
 * cluster, the probability that any future lookup through that cluster already
 * has a direct synapse to the target rises dramatically, reducing the relay
 * burden on the handful of hubs that would otherwise carry all inter-cluster
 * traffic.  The depth-2 limit keeps total message amplification bounded and
 * the load-aware weight ordering ensures cascade priority flows to the least
 * congested nodes.
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

// ── Change 2: Cascading lateral spread parameters ─────────────────────────────

const LATERAL_K         = 6;   // was 3 in N-7W — wider first-hop spread
const LATERAL_K2        = 2;   // NEW — second-hop spread (depth-2 cascade)
const LATERAL_MAX_DEPTH = 2;   // NEW — cascade terminates at depth 2

// ── Change 1: Tier sizes — total = 48 + 12 = 60 (browser WebRTC budget) ───────

const MAX_SYNAPTOME_SIZE = 48;   // local tier cap (was 40 in N-7W; restores N-6W)
const HIGHWAY_SLOTS      = 12;   // highway tier cap (was 20 in N-7W; restores N-6W)

// ── Local-tier stratification ─────────────────────────────────────────────────

const STRATA_GROUPS  = 16;   // 64 strata ÷ 4 = 16 groups of 4
const STRATUM_FLOOR  = 2;    // 16×2=32 guaranteed; 16 flexible (up from 8)

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

const MARKOV_WINDOW        = 32;   // rolling destination window per node
const MARKOV_HOT_THRESHOLD = 3;    // appearances before eager introduction fires
const MARKOV_BASE_WEIGHT   = 0.3;  // floor synapse weight for hot dest
const MARKOV_MAX_WEIGHT    = 0.9;  // ceiling synapse weight for hot dest

// ── Mechanism 1 + 7: Highway / hub management ─────────────────────────────────

const HUB_REFRESH_INTERVAL = 300;  // lookup participations between refreshes
const HUB_SCAN_CAP         = 120;  // max 2-hop candidates per refresh
const HUB_MIN_DIVERSITY    = 5;    // min distinct strata groups to qualify
const HUB_NOISE            = 1.0;  // random score perturbation per refresh

// ── Mechanism 5 + 6: Load awareness ──────────────────────────────────────────

const LOAD_DECAY       = 0.995;   // EMA decay factor per lookup participation
const LOAD_PENALTY     = 0.40;    // max AP multiplier reduction at saturation
const LOAD_FLOOR       = 0.10;    // minimum load discount (never excludes entirely)
const LOAD_SATURATION  = 0.15;    // loadEMA value treated as "fully saturated"

// ─────────────────────────────────────────────────────────────────────────────
// NeuromorphicDHT8W
// ─────────────────────────────────────────────────────────────────────────────

export class NeuromorphicDHT8W extends DHT {
  static get protocolName() { return 'Neuromorphic-8W'; }

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

  buildRoutingTables() {
    const sorted = [...this.nodeMap.values()].sort(
      (a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0
    );
    for (const node of sorted) {
      for (const peer of buildXorRoutingTable(node.id, sorted, this._k * K_BOOT_FACTOR)) {
        const latMs   = roundTripLatency(node, peer);
        const stratum = clz64(node.id ^ peer.id);
        // Bootstrap fills local tier directly; 20 peers is well under the 48 cap.
        node.addSynapse(new Synapse({ peerId: peer.id, latencyMs: latMs, stratum }));
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
      if (candidates.length === 0) break;

      const inTargetRegion =
        ((current.id ^ targetKey) >> BigInt(64 - GEO_REGION_BITS)) === 0n;

      let nextSyn;
      // Priority 0: direct-to-target short-circuit (checks both tiers).
      const directSyn = current.synaptome.get(targetKey) ?? current.highway.get(targetKey);
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

      // Source-inclusive hop caching with cascading lateral spread (Change 2).
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

  // ── Change 2: Cascading lateral spread (depth-aware) ──────────────────────
  //
  // Depth=1: node A gains shortcut to C, then tells its top-LATERAL_K regional
  //          neighbours about C.
  // Depth=2: each of those regional neighbours, upon gaining the shortcut,
  //          tells their own top-LATERAL_K2 regional neighbours.
  // Depth>LATERAL_MAX_DEPTH: no further recursion.
  //
  // Total shortcut propagation per discovery event (worst case):
  //   1 (A) + LATERAL_K (depth-1) + LATERAL_K × LATERAL_K2 (depth-2) = 19
  //
  // The _hasAny guard at entry ensures nodes that already hold the shortcut
  // do not trigger further spread, so the bound is tight.

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
      protocol:      'Neuromorphic-8W',
      epoch:         this.simEpoch,
      avgSynapses:   nodes.length ? ((localSyn + hwSyn) / nodes.length).toFixed(1) : 0,
      avgLocalSyn:   nodes.length ? (localSyn / nodes.length).toFixed(1) : 0,
      avgHighwaySyn: nodes.length ? (hwSyn / nodes.length).toFixed(1) : 0,
      avgTemp,
      avgLoad,
    };
  }
}

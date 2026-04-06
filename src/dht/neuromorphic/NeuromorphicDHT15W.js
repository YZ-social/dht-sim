/**
 * NeuromorphicDHT15W (N-G-DHT-14W) – Generation 14, Highway Synapse Preservation
 *
 * N-14W takes N-10W as its direct base and introduces two targeted fixes derived
 * from analysis of long-run training data showing synaptic decay over time.
 *
 * ── Observation ───────────────────────────────────────────────────────────────
 *
 * Training data (333 sessions, 5000 nodes) revealed a three-phase degradation:
 *
 *   1. Relay hops (1.875) are good but not optimal — N-1's simplicity achieves
 *      1.813 because pure AP learning with no competing mechanisms maximally
 *      specialises on relay routes during pub/sub warmup.
 *
 *   2. Bcast ms (141ms) lags behind N-6W (123ms) and N-2-BP (122ms).  Root cause:
 *      N-9W's MARKOV_BASE_WEIGHT=0.3 seeds Markov-introduced participant entries
 *      at ~0.356 (at freq=3/32 scaling), lower than N-6W's flat 0.5.  Weaker
 *      initial weight = higher eviction risk before reinforcement accumulates.
 *
 *   3. No mechanism protects recurring relay/participant entries from stratified
 *      eviction.  During relay-centric warmup, stratification can displace
 *      participant entries to maintain stratum diversity, producing bcast hops
 *      slightly above 1.000.
 *
 * ── Change 1 — Remove Load-Aware AP Scoring ──────────────────────────────────
 *
 * Load balancing (introduced in N-7W) consistently degrades pub/sub relay ms
 * (N-7W: 188ms vs N-6W: 159ms) by routing around loaded relay nodes via longer
 * geographic paths.  Per-hop relay cost rises from 72.7ms/hop (N-6W, no load
 * balancing) to 84.8ms/hop (N-9W, with load balancing) — N-9W compensates with
 * fewer hops, arriving at the same 159ms total, but the mechanism is fragile.
 *
 * Removing load balancing eliminates gratuitous latency in pub/sub scenarios
 * where the relay IS the optimal destination and should never be avoided.
 *
 * ── Change 2 — Raise MARKOV_BASE_WEIGHT 0.3 → 0.5 ───────────────────────────
 *
 * Restores N-6W's flat 0.5 initial weight for Markov-introduced synapses.
 * At the hot threshold (freq=3/window=32), N-9W computed weight ≈ 0.356; N-10W
 * computes weight ≈ 0.538.  The higher seed weight lets participant entries
 * survive stratified eviction long enough for reinforcement to take hold,
 * recovering N-6W's 123ms bcast ms without sacrificing N-9W's routing quality.
 *
 * ── Change 3 — Relay Pinning ──────────────────────────────────────────────────
 *
 * A separate, longer rolling window (RELAY_PIN_WINDOW=64) tracks destination
 * frequency independent of the Markov window.  When a destination appears
 * ≥ RELAY_PIN_THRESHOLD (5) times, it joins the node's pinnedDests set (up to
 * RELAY_PIN_MAX=4 entries).  Pinned destinations receive:
 *
 *   • Eviction immunity in _stratifiedAdd and _tryAnneal — they are skipped
 *     when selecting the weakest candidate for eviction.
 *   • Decay protection — they decay at DECAY_GAMMA_MAX unconditionally, and
 *     their weight is restored to RELAY_PIN_WEIGHT (0.95) if it falls below.
 *   • AP priority at the source node — on hop=0, if a pinned destination makes
 *     >50% XOR progress toward the target it is used directly, bypassing the
 *     two-hop lookahead.  This captures the N-1 relay-specialisation advantage
 *     without sacrificing general routing quality on non-pinned lookups.
 *
 * Pins are self-managing: they are released when the destination's pin-window
 * frequency drops below RELAY_PIN_THRESHOLD, i.e. after sustained absence.
 *
 * ── Everything else inherited unchanged from N-9W ─────────────────────────────
 *   • Synaptome floor protection (Guard A + B, SYNAPTOME_FLOOR=48)
 *   • Tier rebalancing: MAX_SYNAPTOME_SIZE=48, HIGHWAY_SLOTS=12
 *   • Cascading lateral spread: LATERAL_K=6, LATERAL_K2=2, LATERAL_MAX_DEPTH=2
 *   • Adaptive temporal decay (DECAY_GAMMA_MIN/MAX, USE_SATURATION)
 *   • Markov hot-destination pre-learning (raised MARKOV_BASE_WEIGHT=0.5)
 *   • Extended randomised hub pool (HUB_SCAN_CAP=120, HUB_NOISE=1.0)
 *   • Stratified eviction (STRATA_GROUPS=16, STRATUM_FLOOR=2)
 *   • Simulated annealing (T_INIT, T_MIN, ANNEAL_COOLING, GLOBAL_BIAS)
 *   • Two-hop lookahead with advance-per-latency scoring (α=5)
 *   • Source-inclusive hop caching + shortcut cascade backpropagation
 *   • Triadic closure, inertia locks, intra-regional weight bonus
 *   • Dense bootstrap (K_BOOT_FACTOR=1, 20 peers/bucket)
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

const MARKOV_WINDOW        = 16;
const MARKOV_HOT_THRESHOLD = 3;
const MARKOV_BASE_WEIGHT   = 0.5;  // Change 2: raised from 0.3 → restores N-6W seeding
const MARKOV_MAX_WEIGHT    = 0.9;

// ── Highway / hub management ──────────────────────────────────────────────────

const HUB_REFRESH_INTERVAL = 300;
const HUB_SCAN_CAP         = 120;
const HUB_MIN_DIVERSITY    = 5;
const HUB_NOISE            = 1.0;

// ── (from N-10W) Load-aware AP scoring REMOVED ────────────────────────────────
// Load balancing raised per-hop relay cost from 72.7ms (N-6W) to 84.8ms (N-9W).

// ── N-15W: Renewal-based highway protection ────────────────────────────
// Highway synapses traversed within HIGHWAY_RENEWAL_WINDOW epochs use the
// active (protected) rate; idle synapses fall back to the cold local rate.
const DECAY_GAMMA_HIGHWAY_ACTIVE = 0.9995; // protected rate when recently traversed
const DECAY_GAMMA_HIGHWAY_IDLE   = DECAY_GAMMA_MIN; // 0.990 when idle
const HIGHWAY_RENEWAL_WINDOW     = 3000;   // lookups (~6 sessions) before idle
const HIGHWAY_FLOOR              = 2;      // tiny emergency floor (was 8 in N-14W)

// ── Change 3: Relay pinning ───────────────────────────────────────────────────

const RELAY_PIN_THRESHOLD = 5;    // pin-window freq to enter protected set
const RELAY_PIN_WINDOW    = 64;   // rolling window size for pin decisions
const RELAY_PIN_MAX       = 4;    // max pinned destinations per node
const RELAY_PIN_WEIGHT    = 0.95; // minimum weight floor for pinned synapses

// ─────────────────────────────────────────────────────────────────────────────
// NeuromorphicDHT10W
// ─────────────────────────────────────────────────────────────────────────────

export class NeuromorphicDHT15W extends DHT {
  static get protocolName() { return 'Neuromorphic-15W'; }

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
    // Change 3: relay pinning state (replaces load tracking from N-9W)
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
    for (const syn of node.highway.values()) {
      const peer = this.nodeMap.get(syn.peerId);
      if (peer?.alive && !seen.has(peer.id)) { seen.add(peer.id); peers.push(peer); }
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
   * Phase 1: FIND_NODE(self) for XOR-close peers (same geo cell).
   * Phase 2: lookups targeting flipped geo-prefix bits to discover peers
   *          in distant cells (G-DHT bootstrap strategy).
   */
  bootstrapJoin(newNodeId, sponsorId) {
    const newNode = this.nodeMap.get(newNodeId);
    const sponsor = this.nodeMap.get(sponsorId);
    if (!newNode || !sponsor) return 0;

    const k     = this._k;
    const alpha = this._alpha ?? 3;

    const synCap = isFinite(this.maxConnections) ? this.maxConnections : MAX_SYNAPTOME_SIZE;
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

    // Phase 2: Inter-cell discovery — flip each geo-prefix bit
    const shift = BigInt(64 - GEO_BITS);
    for (let bit = 0; bit < GEO_BITS; bit++) {
      const targetId = newNodeId ^ (1n << (shift + BigInt(bit)));
      iterativeLookup(targetId, sponsor, 5);
    }

    newNode._nodeMapRef = this.nodeMap;
    newNode.temperature = T_INIT;
    return newNode.synaptome.size;
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

    // Change 3: update relay pin tracking at the source.
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
        // Change 3 — Priority 0.5: pinned destination at source.
        // The pin guarantees a high-weight direct synapse exists; route to it
        // immediately without two-hop lookahead overhead.
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

      // N-15W: renew lastActiveEpoch on the selected synapse.
      // Also renew any highway synapse to this peer (handles reverse-edge case).
      nextSyn.lastActiveEpoch = this.simEpoch;
      const _hwRenew = current.highway.get(nextSyn.peerId);
      if (_hwRenew && _hwRenew !== nextSyn) _hwRenew.lastActiveEpoch = this.simEpoch;

      // Change 1: load tracking removed — no loadEMA update here.

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

  // ── 2-hop lookahead AP selection (load balancing removed) ─────────────────

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

    // Change 3: skip pinned destinations when selecting eviction candidate.
    let weakest = null, weakestW = Infinity;
    for (const syn of byGroup[evictGroup]) {
      if (node.pinnedDests.has(syn.peerId)) continue;
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
      syn.lastActiveEpoch = this.simEpoch; // N-15W: grace period on creation
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

  // ── Change 3: Relay pin tracking ─────────────────────────────────────────

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

    // Pin new hot destinations that cross the threshold.
    const freq = node.pinWindowFreq.get(targetKey) ?? 0;
    if (freq >= RELAY_PIN_THRESHOLD && !node.pinnedDests.has(targetKey)) {
      if (node.pinnedDests.size < RELAY_PIN_MAX) {
        node.pinnedDests.add(targetKey);
        // Immediately boost the synapse weight if it already exists.
        const syn = node.synaptome.get(targetKey) ?? node.highway.get(targetKey);
        if (syn && syn.weight < RELAY_PIN_WEIGHT) {
          syn.weight = RELAY_PIN_WEIGHT;
        }
      }
    }

    // Release pins whose frequency has dropped below the threshold.
    for (const dest of node.pinnedDests) {
      if ((node.pinWindowFreq.get(dest) ?? 0) < RELAY_PIN_THRESHOLD) {
        node.pinnedDests.delete(dest);
      }
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

    // Change 3: skip pinned destinations when selecting eviction candidate.
    let weakest = null, weakestW = Infinity;
    for (const syn of byGroup[evictGroup]) {
      if (node.pinnedDests.has(syn.peerId)) continue;
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
    const toPrune    = [];
    const isHighway  = !applyStructuralRule;

    for (const syn of tierMap.values()) {
      if (syn.inertia > this.simEpoch) continue;

      // Pinned destinations always decay at the protected rate.
      if (node.pinnedDests?.has(syn.peerId)) {
        syn.decay(DECAY_GAMMA_MAX);
        if (syn.weight < RELAY_PIN_WEIGHT) syn.weight = RELAY_PIN_WEIGHT;
        continue;   // never a prune candidate
      }

      // N-15W: highway synapses use renewal-based decay rate.
      // Active (traversed recently) => protected rate; idle => cold rate.
      let gamma;
      if (isHighway) {
        const lastActive = syn.lastActiveEpoch ?? 0;
        const isActive   = (lastActive + HIGHWAY_RENEWAL_WINDOW) > this.simEpoch;
        gamma = isActive ? DECAY_GAMMA_HIGHWAY_ACTIVE : DECAY_GAMMA_HIGHWAY_IDLE;
      } else {
        const useFrac = Math.min(1, (syn.useCount ?? 0) / USE_SATURATION);
        gamma = DECAY_GAMMA_MIN + (DECAY_GAMMA_MAX - DECAY_GAMMA_MIN) * useFrac;
      }
      syn.decay(gamma);

      if (syn.weight < PRUNE_THRESHOLD) toPrune.push(syn);
    }

    if (!toPrune.length) return;

    if (isHighway) {
      // N-15W: reduced floor (2); merit-based renewal handles normal protection.
      if (tierMap.size <= HIGHWAY_FLOOR) {
        for (const syn of toPrune) syn.weight = PRUNE_THRESHOLD;
        return;
      }
      const canDelete = tierMap.size - HIGHWAY_FLOOR;
      toPrune.sort((a, b) => a.weight - b.weight);
      for (let i = 0; i < toPrune.length; i++) {
        if (i < canDelete) tierMap.delete(toPrune[i].peerId);
        else               toPrune[i].weight = PRUNE_THRESHOLD;
      }
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
      protocol:      'Neuromorphic-15W',
      epoch:         this.simEpoch,
      avgSynapses:   nodes.length ? ((localSyn + hwSyn) / nodes.length).toFixed(1) : 0,
      avgLocalSyn:   nodes.length ? (localSyn / nodes.length).toFixed(1) : 0,
      avgHighwaySyn: nodes.length ? (hwSyn / nodes.length).toFixed(1) : 0,
      avgTemp,
      avgPinned,
    };
  }
}

/**
 * NeuromorphicDHT12W (N-G-DHT-12W) – Generation 12, Highway-Tier Relay Pinning
 *
 * N-12W is based on N-9W (not N-10W or N-11W) and makes two targeted changes
 * derived from systematic analysis of N-10W and N-11W benchmark regressions.
 *
 * ── Why N-10W and N-11W Regressed at Large Scale ─────────────────────────────
 *
 * N-10W introduced relay pinning into the LOCAL synaptome (48 slots).  At
 * 25K nodes / 50% pub/sub coverage each relay node sees ~16 qualifying group
 * members.  N-10W's hard RELAY_PIN_MAX=4 cap protected only 4 of those 16
 * entries, leaving 12 vulnerable to stratified eviction.
 *
 * N-11W tried to fix this by enlarging the pin budget to 50% of the local
 * synaptome (24 slots).  The result was worse: with 16 of 48 local slots
 * locked at weight 0.95, only 32 slots remained for general XOR routing in a
 * 25K-node network that requires log₂(25,000) ≈ 14.6 levels of routing
 * diversity.  Relay hops, relay ms, bcast hops and bcast ms ALL regressed vs.
 * N-10W at 25K/50%.  Per-hop relay latency rose from 65ms (N-10W) to 71ms
 * (N-11W) because the pinned local entries were geographically suboptimal.
 *
 * N-10W also removed load-aware AP scoring, which harmed scale performance:
 * N-9W WITH load balancing achieved 3.250 relay hops / 230ms at 25K/50%, while
 * N-10W WITHOUT load balancing achieved only 3.875 relay hops / 252ms.
 *
 * ── Change 1 — Restore Load-Aware AP Scoring (from N-9W) ─────────────────────
 *
 * Load-aware scoring was removed in N-10W because it raised per-hop relay
 * latency at 5K/10% (72.7ms → 84.8ms/hop).  However, at 25K/50% its absence
 * increased total relay hops from 3.250 (N-9W with load) to 3.875 (N-10W
 * without load).  The trade-off is unfavourable at scale: load balancing
 * prevents relay-node saturation, distributing traffic across more diverse
 * paths and maintaining sub-4-hop routing at 25K nodes.
 *
 * Constants and implementation identical to N-9W:
 *   LOAD_DECAY=0.995, LOAD_PENALTY=0.40, LOAD_FLOOR=0.10, LOAD_SATURATION=0.15
 *
 * ── Change 2 — Highway-Tier Relay Pinning ─────────────────────────────────────
 *
 * Relay pins are moved from the local synaptome into the HIGHWAY tier.  The
 * highway has 12 slots; up to RELAY_PIN_HIGHWAY_SLOTS=4 are reserved for
 * pinned relay destinations, and the remaining HIGHWAY_HUB_SLOTS=8 are filled
 * with hub diversity nodes exactly as before.
 *
 * Benefits:
 *
 *   • The local 48-slot synaptome is untouched by relay pinning — full routing
 *     diversity is preserved regardless of pub/sub coverage or group size.
 *
 *   • Pinned entries are accessible to routing naturally (lookup already
 *     iterates over both synaptome and highway when building candidates).
 *
 *   • The priority-0.5 source shortcut still fires: at hop=0, if the target is
 *     a pinned destination, the highway entry is used directly without two-hop
 *     lookahead overhead.
 *
 *   • _stratifiedAdd and _tryAnneal need NO pin-skip logic — local eviction is
 *     purely merit-based again.
 *
 * Highway refresh (`_refreshHighway`) now operates in two passes:
 *   Pass 1 — Re-add active pinned destinations (up to RELAY_PIN_HIGHWAY_SLOTS).
 *   Pass 2 — Fill remaining highway slots with high-diversity hub candidates.
 *
 * `_updatePins` tracks pinnedDests/pinWindow/pinWindowFreq as before, and also
 * immediately writes qualifying destinations into the highway map so the
 * priority shortcut is available without waiting for the next hub refresh cycle.
 *
 * RELAY_PIN_MAX=4 is retained from N-10W — local crowding is no longer a
 * concern so the small fixed cap is sufficient.
 *
 * ── Everything else inherited unchanged from N-9W ─────────────────────────────
 *   • Synaptome floor protection (Guard A + B, SYNAPTOME_FLOOR=48)
 *   • Cascading lateral spread: LATERAL_K=6, LATERAL_K2=2, LATERAL_MAX_DEPTH=2
 *   • Adaptive temporal decay (DECAY_GAMMA_MIN/MAX, USE_SATURATION)
 *   • Markov hot-destination pre-learning (MARKOV_BASE_WEIGHT=0.3)
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

// ── Cascading lateral spread ──────────────────────────────────────────────────

const LATERAL_K         = 6;
const LATERAL_K2        = 2;
const LATERAL_MAX_DEPTH = 2;

// ── Tier sizes — total = 48 + 12 = 60 (browser WebRTC budget) ────────────────

const MAX_SYNAPTOME_SIZE     = 48;   // local tier cap
const HIGHWAY_SLOTS          = 12;   // total highway tier cap
const HIGHWAY_HUB_SLOTS      = 8;    // highway slots for hub diversity nodes
const RELAY_PIN_HIGHWAY_SLOTS = 4;   // highway slots reserved for relay pins
                                     // HIGHWAY_HUB_SLOTS + RELAY_PIN_HIGHWAY_SLOTS = HIGHWAY_SLOTS

// ── Synaptome floor ───────────────────────────────────────────────────────────

const SYNAPTOME_FLOOR = MAX_SYNAPTOME_SIZE;   // 48

// ── Local-tier stratification ─────────────────────────────────────────────────

const STRATA_GROUPS  = 16;
const STRATUM_FLOOR  = 2;

// ── Simulated annealing ───────────────────────────────────────────────────────

const T_INIT              = 1.0;
const T_MIN               = 0.05;
const ANNEAL_COOLING      = 0.9997;
const GLOBAL_BIAS         = 0.5;
const ANNEAL_LOCAL_SAMPLE = 20;
const ANNEAL_BUF_REBUILD  = 200;

// ── Adaptive decay ────────────────────────────────────────────────────────────

const DECAY_GAMMA_MIN = 0.990;
const DECAY_GAMMA_MAX = 0.9998;
const USE_SATURATION  = 20;

// ── Markov hot-destination learning ──────────────────────────────────────────

const MARKOV_WINDOW        = 16;
const MARKOV_HOT_THRESHOLD = 3;
const MARKOV_BASE_WEIGHT   = 0.3;   // N-9W value — produces better bcast ms than 0.5
const MARKOV_MAX_WEIGHT    = 0.9;

// ── Highway / hub management ──────────────────────────────────────────────────

const HUB_REFRESH_INTERVAL = 300;
const HUB_SCAN_CAP         = 120;
const HUB_MIN_DIVERSITY    = 5;
const HUB_NOISE            = 1.0;

// ── Change 1: Load-aware AP scoring (restored from N-9W) ─────────────────────

const LOAD_DECAY      = 0.995;   // EMA decay factor per lookup participation
const LOAD_PENALTY    = 0.40;    // max AP multiplier reduction at saturation
const LOAD_FLOOR      = 0.10;    // minimum load discount (never excludes entirely)
const LOAD_SATURATION = 0.15;    // loadEMA treated as "fully saturated"

// ── Change 2: Highway-tier relay pinning ─────────────────────────────────────

const RELAY_PIN_THRESHOLD = 5;    // pin-window freq to qualify for protection
const RELAY_PIN_WINDOW    = 64;   // rolling window size for pin decisions
const RELAY_PIN_MAX       = 4;    // max pinned destinations per node (≤ RELAY_PIN_HIGHWAY_SLOTS)
const RELAY_PIN_WEIGHT    = 0.95; // weight floor for pinned highway synapses

// ─────────────────────────────────────────────────────────────────────────────
// NeuromorphicDHT12W
// ─────────────────────────────────────────────────────────────────────────────

export class NeuromorphicDHT12W extends DHT {
  static get protocolName() { return 'Neuromorphic-12W'; }

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
    // Change 1: load tracking
    node.loadEMA          = 0;
    node.loadLastEpoch    = 0;
    // Change 2: highway-tier relay pin tracking
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

    // Change 2: update highway-tier relay pins at the source.
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
        // Change 2 — Priority 0.5: pinned destination in highway at source.
        // Bypass two-hop lookahead; the pinned highway entry provides a
        // pre-validated high-weight route to this relay target.
        const pinnedSyn = current.highway.get(targetKey);
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

      // Change 1: update load EMA on the node we just routed to.
      nextNode.loadEMA       = this._decayedLoad(nextNode) + (1 - LOAD_DECAY);
      nextNode.loadLastEpoch = this.simEpoch;

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

  // ── Change 1: Lazy load decay helper ──────────────────────────────────────

  _decayedLoad(node) {
    const elapsed = this.simEpoch - (node.loadLastEpoch ?? 0);
    return (node.loadEMA ?? 0) * Math.pow(LOAD_DECAY, elapsed);
  }

  // ── Change 1: 2-hop lookahead AP selection (load-aware) ───────────────────

  _bestByTwoHopAP(current, candidates, targetKey, currentDist, wScale) {
    const sorted = candidates
      .map(s => {
        const peer = this.nodeMap.get(s.peerId);
        const pd   = s.peerId ^ targetKey;
        let ap1    = (Number(currentDist - pd) / s.latency) * (1 + wScale * s.weight);

        // Load discount: steer away from saturated relay nodes.
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

      // Apply load discount at the first-hop node.
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
  // No pin-skip logic needed — pins live in the highway tier, not here.

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

  // ── Change 2: Highway tier management (hub + pin slots) ──────────────────
  //
  // Pass 1 — Re-insert active pinned relay destinations (up to
  //           RELAY_PIN_HIGHWAY_SLOTS).  These are re-created fresh so stale
  //           latency measurements are updated each refresh cycle.
  // Pass 2 — Fill remaining slots (up to HIGHWAY_HUB_SLOTS) with the
  //           highest-diversity hub candidates found via 2-hop scan.

  _refreshHighway(node) {
    if (!node.alive) return;

    // Pass 1: re-build pinned relay entries.
    const freshPins = new Map();
    for (const destId of node.pinnedDests) {
      if (freshPins.size >= RELAY_PIN_HIGHWAY_SLOTS) break;
      const dest = this.nodeMap.get(destId);
      if (!dest?.alive) continue;
      const latMs   = roundTripLatency(node, dest);
      const stratum = clz64(node.id ^ dest.id);
      const syn     = new Synapse({ peerId: destId, latencyMs: latMs, stratum });
      syn.weight    = RELAY_PIN_WEIGHT;
      freshPins.set(destId, syn);
    }

    // Pass 2: discover hub diversity candidates (skip already-pinned nodes).
    const candidates = [];
    const seen       = new Set([node.id, ...freshPins.keys()]);

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

    // Rebuild highway: pins first, then hubs in remaining slots.
    node.highway.clear();
    for (const [id, syn] of freshPins) {
      node.highway.set(id, syn);
    }
    const hubBudget = HIGHWAY_HUB_SLOTS;
    let hubCount = 0;
    for (let i = 0; i < scored.length && hubCount < hubBudget; i++) {
      const hub = scored[i].node;
      if (node.highway.has(hub.id)) continue;
      const latMs   = roundTripLatency(node, hub);
      const stratum = clz64(node.id ^ hub.id);
      const syn     = new Synapse({ peerId: hub.id, latencyMs: latMs, stratum });
      syn.weight    = 0.5;
      node.highway.set(hub.id, syn);
      hubCount++;
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

  // ── Change 2: Highway-tier relay pin tracking ─────────────────────────────
  //
  // Manages pinnedDests (the set of qualifying destination IDs) and immediately
  // writes a high-weight highway entry for any newly pinned destination so the
  // priority-0.5 source shortcut is available without waiting for the next
  // scheduled hub refresh cycle.

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

    // Release pins whose frequency has dropped below the threshold.
    for (const dest of node.pinnedDests) {
      if ((node.pinWindowFreq.get(dest) ?? 0) < RELAY_PIN_THRESHOLD) {
        node.pinnedDests.delete(dest);
        node.highway.delete(dest);   // evict stale pin from highway
      }
    }

    const freq = node.pinWindowFreq.get(targetKey) ?? 0;
    if (freq < RELAY_PIN_THRESHOLD) return;

    if (!node.pinnedDests.has(targetKey)) {
      if (node.pinnedDests.size < RELAY_PIN_MAX) {
        node.pinnedDests.add(targetKey);
      } else {
        // Frequency-ranked replacement: displace the least-frequent current pin.
        let minFreq = freq;
        let minDest = null;
        for (const dest of node.pinnedDests) {
          const dFreq = node.pinWindowFreq.get(dest) ?? 0;
          if (dFreq < minFreq) { minFreq = dFreq; minDest = dest; }
        }
        if (minDest !== null) {
          node.pinnedDests.delete(minDest);
          node.highway.delete(minDest);
          node.pinnedDests.add(targetKey);
        }
      }
    }

    // Immediately write / refresh the highway entry for this pinned destination
    // so the priority shortcut fires before the next scheduled hub refresh.
    if (node.pinnedDests.has(targetKey)) {
      const dest = this.nodeMap.get(targetKey);
      if (dest?.alive) {
        const latMs   = roundTripLatency(node, dest);
        const stratum = clz64(node.id ^ dest.id);
        const syn     = new Synapse({ peerId: targetKey, latencyMs: latMs, stratum });
        syn.weight    = RELAY_PIN_WEIGHT;
        node.highway.set(targetKey, syn);
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

    // No pin-skip needed — pins are in highway, not local synaptome.
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

      // Change 2: pinned highway entries decay at the protected rate and have
      // their weight restored to the pin floor if it drops below.
      if (node.pinnedDests?.has(syn.peerId)) {
        syn.decay(DECAY_GAMMA_MAX);
        if (syn.weight < RELAY_PIN_WEIGHT) syn.weight = RELAY_PIN_WEIGHT;
        continue;
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

    // Guard B: if the local tier is at or below the floor, reset weights.
    if (tierMap.size <= SYNAPTOME_FLOOR) {
      for (const syn of toPrune) syn.weight = PRUNE_THRESHOLD;
      return;
    }

    // Local tier: per-stratum structural survival rule.
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
    const avgLoad    = nodes.length
      ? (nodes.reduce((a, n) => a + this._decayedLoad(n), 0) / nodes.length).toFixed(4)
      : '0.0000';

    return {
      ...base,
      protocol:      'Neuromorphic-12W',
      epoch:         this.simEpoch,
      avgSynapses:   nodes.length ? ((localSyn + hwSyn) / nodes.length).toFixed(1) : 0,
      avgLocalSyn:   nodes.length ? (localSyn / nodes.length).toFixed(1) : 0,
      avgHighwaySyn: nodes.length ? (hwSyn / nodes.length).toFixed(1) : 0,
      avgTemp,
      avgPinned,
      avgLoad,
    };
  }
}

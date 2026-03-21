/**
 * NeuromorphicDHT5W (N-G-DHT-5W) – Generation 5, Browser/Web-Realistic Variant
 *
 * Identical to N-5 in every mechanism and algorithm but operates under the
 * resource constraints of a real browser WebRTC deployment:
 *
 *   MAX_SYNAPTOME_SIZE = 60
 *     Each browser tab can sustain ~50–80 warm WebRTC PeerConnections before
 *     RAM exhaustion (each WebRTC connection consumes ~5–10 MB of DTLS/ICE/SCTP
 *     state).  60 is the practical upper bound for a resource-conscious node.
 *
 *   K_BOOT_FACTOR = 1  (20 bootstrap peers instead of 40)
 *     With a 60-slot cap, seeding 40 bootstrap peers would leave only 20 slots
 *     for learned shortcuts.  Halving bootstrap density preserves 40 slots for
 *     shortcut formation — the ratio where annealing and stratified eviction are
 *     most effective.
 *
 *   STRATUM_FLOOR = 2  (16 groups × 2 = 32 guaranteed slots; 28 flexible)
 *     At cap=60 the original floor of 3 (×16 = 48 mandatory slots) left only
 *     12 flexible slots, starving the annealing exploration budget.  A floor
 *     of 2 maintains the long-range protection guarantee while allowing the
 *     annealing eviction policy meaningful headroom.
 *
 * ── Why this variant matters ─────────────────────────────────────────────────
 *
 * The simulation's N-5 synaptome cap of 800 is unrealistic for browser nodes.
 * This variant lets us directly measure the routing performance trade-off:
 *
 *   N-5  (cap=800): log(N)/log(800)  ≈ 1.3 hops at N=5 000
 *   N-5W (cap=60):  log(N)/log(60)   ≈ 2.2 hops at N=5 000
 *   Kademlia:       log₂(N)          ≈ 12.3 hops at N=5 000
 *
 * N-5W is still ~5.5× more hop-efficient than Kademlia while fitting in a
 * real browser tab.  The smaller synaptome also makes annealing more aggressive
 * (evictions are more frequent) so convergence is actually faster per lookup.
 *
 * ── Inherited from N-5 (unchanged) ──────────────────────────────────────────
 *   • Stratified synaptome (STRATA_GROUPS = 16, STRATUM_FLOOR = 2)
 *   • Simulated annealing (T_INIT, T_MIN, ANNEAL_COOLING, GLOBAL_BIAS)
 *   • Lateral shortcut propagation (LATERAL_K = 3)
 *   • Passive dead-node eviction
 *   • Source-inclusive hop caching
 *   • Shortcut cascade backpropagation
 *   • Two-hop lookahead with advance-per-latency scoring (α = 5)
 *   • Triadic closure
 *   • Gentler decay (DECAY_GAMMA = 0.998, PRUNE_THRESHOLD = 0.05)
 *   • Stronger intra-regional weight bonus (WEIGHT_SCALE = 0.40)
 */

import { DHT }               from '../DHT.js';
import { Synapse }           from './Synapse.js';
import { NeuronNode }        from './NeuronNode.js';
import { randomU64, clz64,
         roundTripLatency,
         buildXorRoutingTable } from '../../utils/geo.js';
import { geoCellId }         from '../../utils/s2.js';

// ── Shared constants (same as N-5 except where noted) ─────────────────────────

const GEO_BITS               = 8;
const INERTIA_DURATION       = 20;
const DECAY_GAMMA            = 0.998;
const DECAY_INTERVAL         = 100;
const PRUNE_THRESHOLD        = 0.05;
const INTRODUCTION_THRESHOLD = 1;
const MAX_GREEDY_HOPS        = 40;
const K_BOOT_FACTOR          = 1;    // ◀ browser: 20 bootstrap peers (was 2 / 40)

const EXPLORATION_EPSILON    = 0.05;
const WEIGHT_SCALE           = 0.40;
const LOOKAHEAD_ALPHA        = 5;
const GEO_REGION_BITS        = 4;
const LATERAL_K              = 3;
const MAX_SYNAPTOME_SIZE     = 60;   // ◀ browser: ~50–80 warm WebRTC connections

// ── N-5W specific (browser-adjusted) ──────────────────────────────────────────

// Stratification
const STRATA_GROUPS   = 16;   // 64 strata ÷ 4 = 16 groups of 4 strata each
const STRATUM_FLOOR   = 2;    // ◀ browser: floor=2 (×16=32 min slots, 28 flexible)

// Simulated annealing — unchanged from N-5
const T_INIT              = 1.0;
const T_MIN               = 0.05;
const ANNEAL_COOLING      = 0.9997;
const GLOBAL_BIAS         = 0.5;
const ANNEAL_LOCAL_SAMPLE = 20;
const ANNEAL_BUF_REBUILD  = 200;

// ─────────────────────────────────────────────────────────────────────────────
// NeuromorphicDHT5W
// ─────────────────────────────────────────────────────────────────────────────

export class NeuromorphicDHT5W extends DHT {
  static get protocolName() { return 'Neuromorphic-5W'; }

  constructor(config = {}) {
    super(config);
    /** @type {Map<number, NeuronNode>} */
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
    const prefix = geoCellId(lat, lng, GEO_BITS);
    const shift  = 64 - GEO_BITS;
    const randBits = randomU64() & ((1n << BigInt(shift)) - 1n);
    const id     = (BigInt(prefix) << BigInt(shift)) | randBits;
    const node   = new NeuronNode({ id, lat, lng });
    node.temperature = T_INIT;
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
    const sorted = [...this.nodeMap.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    for (const node of sorted) {
      for (const peer of buildXorRoutingTable(node.id, sorted, this._k * K_BOOT_FACTOR)) {
        const latMs   = roundTripLatency(node, peer);
        const stratum = clz64(node.id ^ peer.id);
        node.addSynapse(new Synapse({ peerId: peer.id, latencyMs: latMs, stratum }));
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
        if (!peer?.alive) {
          s.weight = 0;
          continue;
        }
        candidates.push(s);
      }
      if (candidates.length === 0) break;

      const inTargetRegion =
        ((current.id ^ targetKey) >> BigInt(64 - GEO_REGION_BITS)) === 0n;

      let nextSyn;
      const directSyn = current.synaptome.get(targetKey);
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

      if (currentId !== sourceId) {
        this._recordTransit(current, sourceId, nextId);
      }

      if (currentId !== targetKey) {
        this._introduceAndSpread(currentId, targetKey);
      }

      // ── Simulated Annealing ───────────────────────────────────────────────
      current.temperature = Math.max(T_MIN, current.temperature * ANNEAL_COOLING);
      if (Math.random() < current.temperature) {
        this._tryAnneal(current);
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
            if (fromNode && !fromNode.hasSynapse(targetKey)) {
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
      const syn = node.synaptome.get(synapse.peerId);
      if (syn) syn.reinforce(this.simEpoch, INERTIA_DURATION);
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
        if ((fs.peerId ^ targetKey) < firstDist) {
          if (this.nodeMap.get(fs.peerId)?.alive) fwdCands.push(fs);
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

  // ── Standard introduce (stratified) ──────────────────────────────────────

  _introduce(aId, cId, initialWeight = 0.5) {
    const nodeA = this.nodeMap.get(aId);
    const nodeC = this.nodeMap.get(cId);
    if (!nodeA || !nodeC || !nodeA.alive || !nodeC.alive) return;
    if (nodeA.hasSynapse(cId)) return;

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

    if (nodeA.hasSynapse(cId)) return;

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

  // ── Mechanism 1: Stratified synaptome admission ───────────────────────────

  _stratifiedAdd(node, newSyn) {
    if (node.synaptome.size < MAX_SYNAPTOME_SIZE) {
      node.addSynapse(newSyn);
      return true;
    }

    const { counts, byGroup } = this._buildGroupCounts(node);

    let evictGroup = -1;
    let maxCount   = STRATUM_FLOOR;
    for (let g = 0; g < STRATA_GROUPS; g++) {
      if (counts[g] > maxCount) {
        maxCount   = counts[g];
        evictGroup = g;
      }
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

  // ── Mechanism 2: Simulated annealing step ─────────────────────────────────

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

    const useGlobal   = Math.random() < (node.temperature * GLOBAL_BIAS);
    const candidate   = useGlobal
      ? this._globalCandidate(node, lo, hi)
      : this._localCandidate(node, lo, hi);

    if (!candidate || node.hasSynapse(candidate.id)) return;

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

    const buf   = this._annealBuffer;
    const n     = buf.length;
    if (n === 0) return null;

    const start = Math.floor(Math.random() * n);
    for (let i = 0; i < n; i++) {
      const id = buf[(start + i) % n];
      if (id === node.id) continue;
      const candidate = this.nodeMap.get(id);
      if (!candidate?.alive || node.hasSynapse(id)) continue;
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
        if (id === node.id || node.hasSynapse(id)) continue;
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

  // ── Synaptic decay (LTD) ──────────────────────────────────────────────────

  _tickDecay() {
    for (const node of this.nodeMap.values()) {
      const toPrune = [];

      for (const syn of node.synaptome.values()) {
        if (syn.inertia > this.simEpoch) continue;
        syn.decay(DECAY_GAMMA);
        if (syn.weight < PRUNE_THRESHOLD) toPrune.push(syn);
      }

      if (!toPrune.length) continue;

      const byStratum = new Map();
      for (const syn of toPrune) {
        let arr = byStratum.get(syn.stratum);
        if (!arr) { arr = []; byStratum.set(syn.stratum, arr); }
        arr.push(syn);
      }

      const minPerStratum = this._k;

      for (const [stratum, candidates] of byStratum) {
        let total = 0;
        for (const s of node.synaptome.values()) {
          if (s.stratum === stratum) total++;
        }
        const removable = Math.max(0, total - minPerStratum);

        candidates.sort((a, b) => a.weight - b.weight);
        for (let i = 0; i < candidates.length; i++) {
          if (i < removable) {
            node.synaptome.delete(candidates[i].peerId);
          } else {
            candidates[i].weight = PRUNE_THRESHOLD;
          }
        }
      }
    }
  }

  // ── Stats ─────────────────────────────────────────────────────────────────

  getStats() {
    const base  = super.getStats();
    const nodes = [...this.nodeMap.values()];
    const totalSyn  = nodes.reduce((acc, n) => acc + n.synaptome.size, 0);
    const avgTemp   = nodes.length
      ? (nodes.reduce((acc, n) => acc + (n.temperature ?? T_INIT), 0) / nodes.length).toFixed(3)
      : '—';
    return {
      ...base,
      protocol:    'Neuromorphic-5W',
      epoch:       this.simEpoch,
      avgSynapses: nodes.length ? (totalSyn / nodes.length).toFixed(1) : 0,
      avgTemp,
    };
  }
}

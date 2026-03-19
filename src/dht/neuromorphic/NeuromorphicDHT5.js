/**
 * NeuromorphicDHT5 (N-G-DHT-5) – Generation 5
 *
 * Builds on N-4 with two new mechanisms that address the specialisation-
 * interference problem: after heavy regional or dest training the N-4 synaptome
 * fills with high-weight short-range synapses, crowding out the long-range
 * entries needed to route across continents — causing global lookup performance
 * to degrade compared to a freshly warmed-up state.
 *
 * ── Mechanism 1 — Stratified Synaptome ───────────────────────────────────────
 *
 * XOR strata (0–31, computed as Math.clz32(myId ^ peerId)) are grouped into
 * STRATA_GROUPS = 8 buckets of 4 strata each.  With an 8-bit geographic ID
 * prefix, strata 0–7 (groups 0–1) correspond to nodes in different continent
 * cells — the inter-continental long-range hops essential for global routing.
 * Strata 8–23 (groups 2–5) correspond to intra-continental peers that regional
 * training strongly reinforces.
 *
 * When the synaptome is full and a new synapse must be admitted, the eviction
 * policy now targets the most over-represented stratum group rather than
 * rejecting the newcomer outright.  Each group is guaranteed STRATUM_FLOOR = 3
 * slots — no regional flood can reduce any group below that floor, so long-range
 * routing entries are structurally protected.
 *
 * ── Mechanism 2 — Simulated Annealing ────────────────────────────────────────
 *
 * Each node carries a temperature T that starts at T_INIT = 1.0 and decays
 * multiplicatively by ANNEAL_COOLING = 0.9997 each time the node participates
 * in a lookup.  After every hop, with probability T, an annealing step fires:
 *
 *   • Eviction target: weakest synapse in the most over-represented stratum
 *     group (same as the stratified eviction policy).
 *   • Global replacement (prob ∝ T × GLOBAL_BIAS): pick a random alive node
 *     from the full network in the most under-represented stratum group.
 *     Explores beyond the 2-hop neighbourhood; fires often when T is high
 *     (young/post-churn nodes) and rarely as the synaptome matures.
 *   • Local replacement (otherwise): collect up to ANNEAL_LOCAL_SAMPLE = 20
 *     candidates from the 2-hop neighbourhood (peers-of-peers) that fall in the
 *     target stratum group; pick one at random.  Cheaper than global and
 *     promotes knowledge diffusion through existing cluster connections.
 *
 * The two-mode replacement creates a natural exploration→exploitation schedule:
 * young nodes fan out globally to seed diverse strata quickly; mature nodes
 * integrate knowledge from their neighbourhood without disrupting learned paths.
 *
 * ── Inherited from N-4 (unchanged) ──────────────────────────────────────────
 *   • Lateral shortcut propagation (LATERAL_K = 3)
 *   • Passive dead-node eviction
 *   • Source-inclusive hop caching
 *   • Shortcut cascade backpropagation
 *   • Two-hop lookahead with advance-per-latency scoring (α = 5)
 *   • Triadic closure
 *   • Dense bootstrap (K_BOOT_FACTOR = 2)
 *   • Gentler decay (DECAY_GAMMA = 0.998, PRUNE_THRESHOLD = 0.05)
 *   • Stronger intra-regional weight bonus (WEIGHT_SCALE = 0.40)
 */

import { DHT }               from '../DHT.js';
import { Synapse }           from './Synapse.js';
import { NeuronNode }        from './NeuronNode.js';
import { randomU32,
         roundTripLatency,
         buildXorRoutingTable } from '../../utils/geo.js';
import { geoCellId }         from '../../utils/s2.js';

// ── Shared constants (same as N-4) ────────────────────────────────────────────

const GEO_BITS               = 8;
const INERTIA_DURATION       = 20;
const DECAY_GAMMA            = 0.998;
const DECAY_INTERVAL         = 100;
const PRUNE_THRESHOLD        = 0.05;
const INTRODUCTION_THRESHOLD = 1;
const MAX_GREEDY_HOPS        = 40;
const K_BOOT_FACTOR          = 2;

const EXPLORATION_EPSILON    = 0.05;
const WEIGHT_SCALE           = 0.40;
const LOOKAHEAD_ALPHA        = 5;
const GEO_REGION_BITS        = 4;
const LATERAL_K              = 3;
const MAX_SYNAPTOME_SIZE     = 800;

// ── N-5 specific ──────────────────────────────────────────────────────────────

// Stratification
const STRATA_GROUPS   = 8;    // 32 strata ÷ 4 = 8 groups of 4 strata each
const STRATUM_FLOOR   = 3;    // minimum synapses guaranteed per stratum group

// Simulated annealing
const T_INIT              = 1.0;   // starting temperature for every new node
const T_MIN               = 0.05;  // minimum temperature (exploration never fully stops)
const ANNEAL_COOLING      = 0.9997;// multiplicative cooling per lookup participation
const GLOBAL_BIAS         = 0.5;   // at T = T_INIT, prob of global vs. local replacement
const ANNEAL_LOCAL_SAMPLE = 20;    // max 2-hop candidates to collect before choosing
const ANNEAL_BUF_REBUILD  = 200;   // rebuild global-candidate buffer every N lookups

// ─────────────────────────────────────────────────────────────────────────────
// NeuromorphicDHT5
// ─────────────────────────────────────────────────────────────────────────────

export class NeuromorphicDHT5 extends DHT {
  static get protocolName() { return 'Neuromorphic-5'; }

  constructor(config = {}) {
    super(config);
    /** @type {Map<number, NeuronNode>} */
    this.nodeMap           = new Map();
    this.simEpoch          = 0;
    this.lookupsSinceDecay = 0;
    this._k                = config.k ?? 20;
    this._emaHops          = null;
    this._emaTime          = null;

    // Lazy-built buffer of node IDs used by global annealing candidate search.
    // Rebuilt when size changes or after ANNEAL_BUF_REBUILD lookups.
    this._annealBuffer   = null;
    this._annealBufDirty = true;
    this._annealBufCount = 0;
  }

  // ── Node lifecycle ────────────────────────────────────────────────────────

  async addNode(lat, lng) {
    const prefix = geoCellId(lat, lng, GEO_BITS);
    const shift  = 32 - GEO_BITS;
    const rand   = randomU32() & ((1 << shift) - 1);
    const id     = ((prefix << shift) | rand) >>> 0;
    const node   = new NeuronNode({ id, lat, lng });
    // Inject per-node annealing state (duck-typing, same pattern as _nodeMapRef)
    node.temperature = T_INIT;
    this.nodeMap.set(id, node);
    this.network.addNode(node);
    this._annealBufDirty = true; // size changed — force buffer rebuild
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
    const sorted = [...this.nodeMap.values()].sort((a, b) => a.id - b.id);
    for (const node of sorted) {
      for (const peer of buildXorRoutingTable(node.id, sorted, this._k * K_BOOT_FACTOR)) {
        const latMs   = roundTripLatency(node, peer);
        const stratum = Math.clz32((node.id ^ peer.id) >>> 0);
        // Bootstrap uses addSynapse directly — synaptome is empty at this point
        // (40 initial peers well under MAX_SYNAPTOME_SIZE) so no eviction needed.
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

    // Invalidate anneal buffer periodically (handles churn & topology drift)
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

      const currentDist = (currentId ^ targetKey) >>> 0;
      if (currentDist === 0) { reached = true; break; }

      // Collect alive candidates that make strict XOR progress.
      // N-4 / N-5: zero-weight dead entries immediately (passive dead-node eviction).
      const candidates = [];
      for (const s of current.synaptome.values()) {
        if (((s.peerId ^ targetKey) >>> 0) >= currentDist) continue;
        const peer = this.nodeMap.get(s.peerId);
        if (!peer?.alive) {
          s.weight = 0;
          continue;
        }
        candidates.push(s);
      }
      if (candidates.length === 0) break;

      // Two-tier region check.
      const inTargetRegion =
        ((currentId ^ targetKey) >>> (32 - GEO_REGION_BITS)) === 0;

      // Priority 0 — Direct-to-target short-circuit.
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

      // Triadic closure (intermediate nodes only).
      if (currentId !== sourceId) {
        this._recordTransit(current, sourceId, nextId);
      }

      // Source-inclusive hop caching with lateral spread (inherited from N-4).
      if (currentId !== targetKey) {
        this._introduceAndSpread(currentId, targetKey);
      }

      // ── N-5 Simulated Annealing ──────────────────────────────────────────
      // Cool the node's temperature and fire an annealing step with probability T.
      current.temperature = Math.max(T_MIN, current.temperature * ANNEAL_COOLING);
      if (Math.random() < current.temperature) {
        this._tryAnneal(current);
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

      // Shortcut cascade backpropagation (inherited from N-3 / N-4).
      if (trace.length >= 2) {
        const lastTrace = trace[trace.length - 1];
        if (lastTrace.synapse.peerId === targetKey) {
          const gatewayId = lastTrace.fromId;
          for (let j = 0; j < trace.length - 1; j++) {
            const fromNode = this.nodeMap.get(trace[j].fromId);
            // Don't add a relay shortcut if the node already has a direct
            // synapse to the target — a relay shortcut would only compete
            // with and degrade the direct route learned via hop caching.
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
        const pd  = (s.peerId ^ targetKey) >>> 0;
        const ap1 = ((currentDist - pd) / s.latency) * (1 + wScale * s.weight);
        return { s, ap1 };
      })
      .sort((a, b) => b.ap1 - a.ap1);

    const probeSet = sorted.slice(0, LOOKAHEAD_ALPHA).map(x => x.s);

    let bestSyn = null;
    let bestAP2 = -Infinity;

    for (const firstSyn of probeSet) {
      const firstDist = (firstSyn.peerId ^ targetKey) >>> 0;
      if (firstDist === 0) return firstSyn;

      const firstNode = this.nodeMap.get(firstSyn.peerId);
      if (!firstNode?.alive) continue;

      const fwdCands = [];
      for (const fs of firstNode.synaptome.values()) {
        if (((fs.peerId ^ targetKey) >>> 0) < firstDist) {
          if (this.nodeMap.get(fs.peerId)?.alive) fwdCands.push(fs);
        }
      }

      let twoHopDist, secondLatency;
      if (fwdCands.length === 0) {
        twoHopDist    = firstDist;
        secondLatency = 0;
      } else {
        const bestFwd = firstNode.bestByAP(fwdCands, targetKey, wScale);
        twoHopDist    = (bestFwd.peerId ^ targetKey) >>> 0;
        secondLatency = bestFwd.latency;
      }

      const progress2 = currentDist - twoHopDist;
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
    const stratum = Math.clz32((nodeA.id ^ nodeC.id) >>> 0);
    const syn     = new Synapse({ peerId: cId, latencyMs: latMs, stratum });
    syn.weight    = initialWeight; // direct shortcuts start at 0.5; cascade relays at 0.1
    this._stratifiedAdd(nodeA, syn);
  }

  // ── Introduce with lateral spread (N-4 mechanism 1, stratified in N-5) ───

  _introduceAndSpread(aId, cId) {
    const nodeA = this.nodeMap.get(aId);
    const nodeC = this.nodeMap.get(cId);
    if (!nodeA || !nodeC || !nodeA.alive || !nodeC.alive) return;

    if (nodeA.hasSynapse(cId)) return;

    const latMs   = roundTripLatency(nodeA, nodeC);
    const stratum = Math.clz32((nodeA.id ^ nodeC.id) >>> 0);
    const syn     = new Synapse({ peerId: cId, latencyMs: latMs, stratum });
    syn.weight    = 0.5;
    const added   = this._stratifiedAdd(nodeA, syn);

    if (added) {
      // Lateral spread — share the new shortcut with A's top same-region neighbours.
      const aRegion  = aId >>> (32 - GEO_REGION_BITS);
      const regional = [];
      for (const s of nodeA.synaptome.values()) {
        if (s.peerId === cId) continue;
        if ((s.peerId >>> (32 - GEO_REGION_BITS)) !== aRegion) continue;
        if (this.nodeMap.get(s.peerId)?.alive) regional.push(s);
      }
      regional.sort((a, b) => b.weight - a.weight);
      for (let i = 0; i < Math.min(LATERAL_K, regional.length); i++) {
        this._introduce(regional[i].peerId, cId);
      }
    }
  }

  // ── Mechanism 1: Stratified synaptome admission ───────────────────────────
  //
  // When the synaptome is at capacity, evict the weakest synapse from the most
  // over-represented stratum group (the one furthest above STRATUM_FLOOR) to
  // make room for the newcomer.  If all groups are at or below the floor, the
  // new synapse is dropped (rare edge case in small, dense networks).
  //
  // Returns true if the synapse was added, false if it was rejected.

  _stratifiedAdd(node, newSyn) {
    if (node.synaptome.size < MAX_SYNAPTOME_SIZE) {
      node.addSynapse(newSyn);
      return true;
    }

    const { counts, byGroup } = this._buildGroupCounts(node);

    // Find the most over-represented group that can donate a synapse.
    let evictGroup = -1;
    let maxCount   = STRATUM_FLOOR; // must strictly exceed floor to be a candidate
    for (let g = 0; g < STRATA_GROUPS; g++) {
      if (counts[g] > maxCount) {
        maxCount   = counts[g];
        evictGroup = g;
      }
    }
    if (evictGroup === -1) return false; // all at floor — cannot evict

    // Evict the weakest synapse in that group.
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
  //
  // Replace the weakest synapse in the most over-represented group with a
  // candidate from either the global network (exploration) or the 2-hop
  // neighbourhood (exploitation), biased toward the most under-represented
  // stratum group.

  _tryAnneal(node) {
    if (!node.alive || node.synaptome.size === 0) return;

    const { counts, byGroup } = this._buildGroupCounts(node);

    // Target group: most under-represented (we want to fill it).
    let targetGroup = 0, minCount = Infinity;
    for (let g = 0; g < STRATA_GROUPS; g++) {
      if (counts[g] < minCount) { minCount = counts[g]; targetGroup = g; }
    }

    // Evict group: most over-represented (we can afford to lose one).
    let evictGroup = -1, maxCount = STRATUM_FLOOR;
    for (let g = 0; g < STRATA_GROUPS; g++) {
      if (counts[g] > maxCount) { maxCount = counts[g]; evictGroup = g; }
    }
    if (evictGroup === -1) return; // nothing safe to evict

    // Weakest synapse in evict group.
    let weakest = null, weakestW = Infinity;
    for (const syn of byGroup[evictGroup]) {
      if (syn.weight < weakestW) { weakestW = syn.weight; weakest = syn; }
    }
    if (!weakest) return;

    // Find a replacement candidate in the target stratum range.
    const lo = targetGroup * 4;
    const hi = lo + 3;

    const useGlobal   = Math.random() < (node.temperature * GLOBAL_BIAS);
    const candidate   = useGlobal
      ? this._globalCandidate(node, lo, hi)
      : this._localCandidate(node, lo, hi);

    if (!candidate || node.hasSynapse(candidate.id)) return;

    // Swap: evict the loser, install the explorer at a low initial weight.
    node.synaptome.delete(weakest.peerId);
    const latMs   = roundTripLatency(node, candidate);
    const stratum = Math.clz32((node.id ^ candidate.id) >>> 0);
    const newSyn  = new Synapse({ peerId: candidate.id, latencyMs: latMs, stratum });
    newSyn.weight = 0.1; // must prove itself before getting reinforced
    node.addSynapse(newSyn);
  }

  // ── Global candidate: random alive node in target stratum range ───────────
  //
  // Uses a lazily-rebuilt flat buffer of node IDs for O(1) random access with
  // an early-exit linear scan.  Expected scan length = buffer.length / (nodes in
  // target stratum) ≈ 8 for group 0 (strata 0-3 hold ~1/8 of all nodes).

  _globalCandidate(node, lo, hi) {
    // Rebuild the buffer if dirty (nodes added/removed) or too stale.
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
      const stratum = Math.clz32((node.id ^ id) >>> 0);
      if (stratum >= lo && stratum <= hi) return candidate;
    }
    return null;
  }

  // ── Local candidate: random node from 2-hop neighbourhood ────────────────
  //
  // Collects up to ANNEAL_LOCAL_SAMPLE qualifying peers-of-peers and returns
  // a uniform random pick.  Capped to bound worst-case cost.

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
        const stratum = Math.clz32((node.id ^ id) >>> 0);
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
      const g = syn.stratum >>> 2; // fast floor(stratum / 4), yields 0–7
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
      protocol:    'Neuromorphic-5',
      epoch:       this.simEpoch,
      avgSynapses: nodes.length ? (totalSyn / nodes.length).toFixed(1) : 0,
      avgTemp,
    };
  }
}

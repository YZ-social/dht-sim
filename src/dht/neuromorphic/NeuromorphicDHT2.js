/**
 * NeuromorphicDHT2 (N-G-DHT-2) – Neuromorphic Geographic DHT, generation 2.
 *
 * Starts as an exact copy of NeuromorphicDHT (Neuromorphic-1) including all
 * tunable constants, 2-hop lookahead routing, EMA-gated LTP, triadic closure,
 * hop caching, and stratum-aware decay.  From this identical baseline,
 * Neuromorphic-2 will be evolved through further experiments while
 * Neuromorphic-1 is preserved as a fixed reference point.
 *
 * Experiment 9 — Hierarchical Two-Tier Routing
 *
 * All previous experiments (5-8) tested the same fundamental approach:
 * build a global shortcut web and hope it beats the geographic AP baseline.
 * Experiments proved this impossible — the physics ceiling (RTT triangle
 * inequality) prevents any learned shortcut from reducing global latency.
 *
 * However, Exp 1 (regional mode) conclusively showed N-DHT outperforms
 * G-DHT-8 in regional routing: 1.38 hops / 70ms vs 2.23 hops / 91.9ms.
 * The shortcut web DOES work — just not globally.
 *
 * Exp 9 exploits this asymmetry with a two-tier routing architecture:
 *
 *   Tier 1 — Inter-regional (cross-cell hops):
 *     2-hop lookahead AP with weightScale=0.  Identical to N-1/G-DHT-8
 *     routing quality; learned weights add noise, not signal.
 *     Uses _bestByTwoHopAP(..., wScale=0).
 *
 *   Tier 2 — Intra-regional (source and target share a GEO_REGION_BITS cell):
 *     Full 2-hop lookahead AP with WEIGHT_SCALE active.  Inside a dense
 *     geographic cell (~312 nodes at 5000 total), shortcuts genuinely
 *     collapse multi-hop XOR paths into fewer hops, exactly as seen in
 *     regional-mode experiments.
 *
 *   Region test: ((currentId ^ targetKey) >>> (32 - GEO_REGION_BITS)) === 0
 *   With GEO_REGION_BITS=4: 16 continent-sized cells, ~312 nodes each.
 *
 * Reinforcement (LTP) fires on both tiers when the full path beats EMA,
 * but only the intra-regional weights materially influence routing.
 * Triadic closure introduces shortcuts between observed transit pairs,
 * concentrating new synapses exactly where repeated paths run.
 *
 * Expected result: global hops ≈ G-DHT-8 baseline (inter-regional is
 * identical); final 1-2 hops collapse from ~2 → ~1.4 inside the target
 * region, matching the regional-mode benchmark.
 */

import { DHT }               from '../DHT.js';
import { Synapse }           from './Synapse.js';
import { NeuronNode }        from './NeuronNode.js';
import { randomU32,
         roundTripLatency,
         buildXorRoutingTable } from '../../utils/geo.js';
import { geoCellId }         from '../../utils/s2.js';

// ── Tunable constants ─────────────────────────────────────────────────────────

const GEO_BITS             = 8;    // geographic prefix bits in G-ID
const INERTIA_DURATION     = 20;   // epochs a reinforced synapse is decay-immune
const DECAY_GAMMA          = 0.995; // per-tick weight multiplier (~0.5% decay)
const DECAY_INTERVAL       = 100;  // run Tick_Decay every N lookups
const PRUNE_THRESHOLD      = 0.10; // prune synapses below this weight
// Minimum synapses per stratum is set to this._k at runtime (see _tickDecay).
const INTRODUCTION_THRESHOLD = 1;  // forward same pair N times → introduce them
const MAX_GREEDY_HOPS      = 40;   // safety cap on path length

// ── Learning hyperparameters ───────────────────────────────────────────────
const EXPLORATION_EPSILON  = 0.05; // 5% random first-hop exploration only
const WEIGHT_SCALE         = 0.15; // shortcut weight bonus in intra-regional AP
// LOOKAHEAD_ALPHA: top candidates probed in 2-hop lookahead (intra-regional).
const LOOKAHEAD_ALPHA      = 3;
// GEO_REGION_BITS: coarse cell resolution for the tier-1 / tier-2 boundary.
// 4 bits → 16 continent-sized cells, ~312 nodes each at 5000 total.
// GEO_BITS (8) still governs ID generation and routing-table bucket granularity.
const GEO_REGION_BITS      = 4;

// ─────────────────────────────────────────────────────────────────────────────
// NeuromorphicDHT2
// ─────────────────────────────────────────────────────────────────────────────

export class NeuromorphicDHT2 extends DHT {
  static get protocolName() { return 'Neuromorphic-2'; }

  constructor(config = {}) {
    super(config);
    /** @type {Map<number, NeuronNode>} */
    this.nodeMap          = new Map();
    this.simEpoch         = 0;
    this.lookupsSinceDecay = 0;
    this._k               = config.k ?? 20;
    this._emaHops         = null;
    this._emaTime         = null;
  }

  // ── Node lifecycle ────────────────────────────────────────────────────────

  async addNode(lat, lng) {
    const prefix = geoCellId(lat, lng, GEO_BITS);
    const shift  = 32 - GEO_BITS;
    const rand   = randomU32() & ((1 << shift) - 1);
    const id     = ((prefix << shift) | rand) >>> 0;

    const node = new NeuronNode({ id, lat, lng });
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

  // ── Phase 2: Neurogenesis (Bootstrap to G-DHT-8 parity) ──────────────────

  buildRoutingTables() {
    const k      = this._k;
    const sorted = [...this.nodeMap.values()].sort((a, b) => a.id - b.id);

    for (const node of sorted) {
      for (const peer of buildXorRoutingTable(node.id, sorted, k)) {
        const latMs   = roundTripLatency(node, peer);
        const stratum = Math.clz32((node.id ^ peer.id) >>> 0);
        node.addSynapse(new Synapse({ peerId: peer.id, latencyMs: latMs, stratum }));
      }
      node._nodeMapRef = this.nodeMap;
    }
  }

  // ── Phase 3: Action Selection — Two-Tier Hierarchical Routing ────────────

  async lookup(sourceId, targetKey) {
    const source = this.nodeMap.get(sourceId);
    if (!source || !source.alive) return null;

    this.simEpoch++;
    if (++this.lookupsSinceDecay >= DECAY_INTERVAL) {
      this._tickDecay();
      this.lookupsSinceDecay = 0;
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

      const candidates = [];
      for (const s of current.synaptome.values()) {
        if (((s.peerId ^ targetKey) >>> 0) >= currentDist) continue;
        const peer = this.nodeMap.get(s.peerId);
        if (!peer?.alive) continue;
        candidates.push(s);
      }

      if (candidates.length === 0) break;

      // Two-tier routing decision.
      // inTargetRegion: source and target share a coarse geographic cell
      // (top GEO_REGION_BITS of their IDs match → same continent-sized cell).
      const inTargetRegion =
        ((currentId ^ targetKey) >>> (32 - GEO_REGION_BITS)) === 0;

      // Priority 0 — Direct-to-target short-circuit (O(1) Map lookup):
      //   If this node has a direct synapse to the exact target, always take
      //   it regardless of latency.  AP = ΔDist/L penalises long-range hops,
      //   so a shortcut to a distant target would otherwise be outranked by
      //   local hops — but reaching the destination in one hop is always
      //   fewer hops than any alternative.
      let nextSyn;
      const directSyn = current.synaptome.get(targetKey);
      if (directSyn && this.nodeMap.get(targetKey)?.alive) {
        nextSyn = directSyn;
      } else if (hop === 0 && Math.random() < EXPLORATION_EPSILON) {
        // Random exploration on first hop only (same as N-1)
        nextSyn = candidates[Math.floor(Math.random() * candidates.length)];
      } else if (inTargetRegion) {
        // Tier 2 — Intra-regional: 2-hop lookahead with learned shortcuts.
        // Dense local node population means shortcuts genuinely collapse hops.
        nextSyn = this._bestByTwoHopAP(current, candidates, targetKey, currentDist, WEIGHT_SCALE);
      } else {
        // Tier 1 — Inter-regional: 2-hop lookahead, zero weight influence.
        // Matches N-1/G-DHT-8 routing quality exactly; shortcuts can't beat
        // the RTT triangle inequality for cross-continental hops.
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

      if (currentId !== sourceId && currentId !== targetKey) {
        this._introduce(currentId, targetKey);
      }

      currentId = nextId;
    }

    const hopCount = path.length - 1;
    if (reached) {
      this._emaHops = this._emaHops === null
        ? hopCount
        : 0.9 * this._emaHops + 0.1 * hopCount;
      this._emaTime = this._emaTime === null
        ? totalTimeMs
        : 0.9 * this._emaTime + 0.1 * totalTimeMs;
      if (trace.length > 0 && totalTimeMs <= this._emaTime) {
        this._reinforceWave(trace);
      }
    }

    return {
      path,
      hops: path.length - 1,
      time: totalTimeMs,
      found: reached,
    };
  }

  // ── Phase 4: Neuromodulation (Positive Wave / LTP) ───────────────────────

  _reinforceWave(trace) {
    for (let i = trace.length - 1; i >= 0; i--) {
      const { fromId, synapse } = trace[i];
      const node = this.nodeMap.get(fromId);
      if (!node) continue;
      const syn = node.synaptome.get(synapse.peerId);
      if (syn) syn.reinforce(this.simEpoch, INERTIA_DURATION);
    }
  }

  // ── 2-hop lookahead AP selection (intra-regional tier only) ──────────────

  // wScale = WEIGHT_SCALE for intra-regional (shortcuts active),
  //          0            for inter-regional (pure geographic, matches N-1).
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

  // ── Phase 5: Structural Plasticity (Triadic Closure) ─────────────────────

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

  _introduce(aId, cId) {
    const nodeA = this.nodeMap.get(aId);
    const nodeC = this.nodeMap.get(cId);
    if (!nodeA || !nodeC || !nodeA.alive || !nodeC.alive) return;
    if (nodeA.hasSynapse(cId)) return;

    const latMs   = roundTripLatency(nodeA, nodeC);
    const stratum = Math.clz32((nodeA.id ^ nodeC.id) >>> 0);
    const syn     = new Synapse({ peerId: cId, latencyMs: latMs, stratum });
    syn.weight    = 0.5;
    nodeA.addSynapse(syn);
  }

  // ── Phase 6: Synaptic Decay (LTD) ────────────────────────────────────────

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
    const base = super.getStats();
    const nodes = [...this.nodeMap.values()];
    const totalSyn = nodes.reduce((acc, n) => acc + n.synaptome.size, 0);
    return {
      ...base,
      protocol: 'Neuromorphic-2',
      epoch:       this.simEpoch,
      avgSynapses: nodes.length ? (totalSyn / nodes.length).toFixed(1) : 0,
    };
  }
}

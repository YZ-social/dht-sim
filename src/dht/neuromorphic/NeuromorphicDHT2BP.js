/**
 * NeuromorphicDHT2BP (N-G-DHT-2-BP) – N-2 + Cascade Backpropagation only.
 *
 * Ablation study: identical to N-2 in every constant and mechanism EXCEPT
 * for the addition of shortcut cascade backpropagation (Innovation 2 from N-3).
 *
 * Purpose: isolate how much of N-3's improvement over N-2 comes from cascade
 * backpropagation alone, before the other N-3 changes (source-inclusive hop
 * caching, K_BOOT_FACTOR=2, higher WEIGHT_SCALE, wider LOOKAHEAD_ALPHA,
 * gentler decay) are also in play.
 *
 * ── What is different from N-2 ───────────────────────────────────────────────
 *
 *   Shortcut cascade backpropagation (after successful lookup):
 *     When the final hop was a direct-to-target synapse fired at "gateway" G,
 *     ALL earlier path nodes — including source — learn a synapse to G.
 *     They gain a guaranteed 2-hop path: earlier_node → G → target.
 *     This propagates O(path_length) useful new synapses from a single
 *     shortcut event, vs N-2 which requires many separate lookups to build
 *     the same shortcut density backward along the path.
 *
 *     Example:  path S → A → B → G → target   (G fires direct shortcut)
 *     Cascade teaches:  S→G,  A→G,  B→G
 *     Next lookup from any of those nodes to target: at most 2 hops via G.
 *
 * ── What is identical to N-2 ─────────────────────────────────────────────────
 *   All constants:  DECAY_GAMMA=0.995, PRUNE_THRESHOLD=0.10,
 *                   WEIGHT_SCALE=0.15, LOOKAHEAD_ALPHA=3
 *   Bootstrap density:  standard k (no K_BOOT_FACTOR)
 *   Source guard in hop caching:  `currentId !== sourceId && currentId !== targetKey`
 *   Two-tier routing architecture
 *   All other learning mechanics
 */

import { DHT }               from '../DHT.js';
import { Synapse }           from './Synapse.js';
import { NeuronNode }        from './NeuronNode.js';
import { randomU64, clz64,
         roundTripLatency,
         buildXorRoutingTable } from '../../utils/geo.js';
import { geoCellId }         from '../../utils/s2.js';

// ── Tunable constants (identical to N-2) ──────────────────────────────────────

const GEO_BITS             = 8;
const INERTIA_DURATION     = 20;
const DECAY_GAMMA          = 0.995;
const DECAY_INTERVAL       = 100;
const PRUNE_THRESHOLD      = 0.10;
const INTRODUCTION_THRESHOLD = 1;
const MAX_GREEDY_HOPS      = 40;

const EXPLORATION_EPSILON  = 0.05;
const WEIGHT_SCALE         = 0.15;
const LOOKAHEAD_ALPHA      = 3;
const GEO_REGION_BITS      = 4;

// ─────────────────────────────────────────────────────────────────────────────
// NeuromorphicDHT2BP
// ─────────────────────────────────────────────────────────────────────────────

export class NeuromorphicDHT2BP extends DHT {
  static get protocolName() { return 'Neuromorphic-2-BP'; }

  constructor(config = {}) {
    super(config);
    /** @type {Map<number, NeuronNode>} */
    this.nodeMap           = new Map();
    this.simEpoch          = 0;
    this.lookupsSinceDecay = 0;
    this._k                = config.k ?? 20;
    this._emaHops          = null;
    this._emaTime          = null;
  }

  // ── Node lifecycle ────────────────────────────────────────────────────────

  async addNode(lat, lng) {
    const prefix = geoCellId(lat, lng, GEO_BITS);
    const shift  = 64 - GEO_BITS;
    const randBits = randomU64() & ((1n << BigInt(shift)) - 1n);
    const id     = (BigInt(prefix) << BigInt(shift)) | randBits;

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

  // ── Bootstrap (identical to N-2 — standard k per stratum) ────────────────

  buildRoutingTables({ bidirectional = true } = {}) {
    super.buildRoutingTables({ bidirectional });
    const k      = this._k;
    const sorted = [...this.nodeMap.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

    for (const node of sorted) {
      for (const peer of buildXorRoutingTable(node.id, sorted, k)) {
        const latMs   = roundTripLatency(node, peer);
        const stratum = clz64(node.id ^ peer.id);
        node.addSynapse(new Synapse({ peerId: peer.id, latencyMs: latMs, stratum }));
        if (this.bidirectional) peer.addIncomingSynapse(node.id, latMs, stratum);
      }
      node._nodeMapRef = this.nodeMap;
    }
  }

  // ── Lookup — N-2 routing + cascade backpropagation ────────────────────────

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

      const currentDist = current.id ^ targetKey;  // BigInt
      if (currentDist === 0n) { reached = true; break; }

      const candidates = [];
      for (const s of current.synaptome.values()) {
        if ((s.peerId ^ targetKey) >= currentDist) continue;
        const peer = this.nodeMap.get(s.peerId);
        if (!peer?.alive) continue;
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

      // Priority 0 — Direct-to-target short-circuit (same as N-2).
      let nextSyn;
      const directSyn = current.synaptome.get(targetKey)
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

      // Triadic closure (same as N-2).
      if (currentId !== sourceId) {
        this._recordTransit(current, sourceId, nextId);
      }

      // Hop caching (same guard as N-2 — source excluded).
      if (currentId !== sourceId && currentId !== targetKey) {
        this._introduce(currentId, targetKey);
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

      // ── Cascade backpropagation (the ONLY addition vs N-2) ───────────────
      //   If the final hop was a direct-to-target shortcut fired at gateway G
      //   (detected by trace.last.synapse.peerId === targetKey), teach every
      //   earlier path node about G.  Each learns a 2-hop path: node → G → target.
      //   This propagates O(path_length) new shortcuts from a single event.
      //   N-2 would require many independent lookups to achieve the same density.
      if (trace.length >= 2) {
        const lastTrace = trace[trace.length - 1];
        if (lastTrace.synapse.peerId === targetKey) {
          const gatewayId = lastTrace.fromId;
          for (let j = 0; j < trace.length - 1; j++) {
            this._introduce(trace[j].fromId, gatewayId);
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

  // ── 2-hop lookahead AP selection (identical to N-2) ──────────────────────

  _bestByTwoHopAP(current, candidates, targetKey, currentDist, wScale) {
    const sorted = candidates
      .map(s => {
        const pd  = s.peerId ^ targetKey;  // BigInt
        const ap1 = (Number(currentDist - pd) / s.latency) * (1 + wScale * s.weight);
        return { s, ap1 };
      })
      .sort((a, b) => b.ap1 - a.ap1);

    const probeSet = sorted.slice(0, LOOKAHEAD_ALPHA).map(x => x.s);

    let bestSyn = null;
    let bestAP2 = -Infinity;

    for (const firstSyn of probeSet) {
      const firstDist = firstSyn.peerId ^ targetKey;  // BigInt

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
        twoHopDist    = bestFwd.peerId ^ targetKey;  // BigInt
        secondLatency = bestFwd.latency;
      }

      const progress2 = Number(currentDist - twoHopDist);  // Convert for float arithmetic
      const totalLat  = firstSyn.latency + secondLatency;
      const ap2       = (progress2 / totalLat) * (1 + wScale * firstSyn.weight);

      if (ap2 > bestAP2) {
        bestAP2 = ap2;
        bestSyn = firstSyn;
      }
    }

    return bestSyn ?? current.bestByAP(candidates, targetKey, wScale);
  }

  // ── Triadic closure (identical to N-2) ───────────────────────────────────

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
    const stratum = clz64(nodeA.id ^ nodeC.id);
    const syn     = new Synapse({ peerId: cId, latencyMs: latMs, stratum });
    syn.weight    = 0.5;
    nodeA.addSynapse(syn);
    if (this.bidirectional) nodeC.addIncomingSynapse(aId, latMs, stratum);
  }

  // ── Synaptic decay (identical to N-2) ─────────────────────────────────────

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
      protocol:    'Neuromorphic-2-BP',
      epoch:       this.simEpoch,
      avgSynapses: nodes.length ? (totalSyn / nodes.length).toFixed(1) : 0,
    };
  }
}

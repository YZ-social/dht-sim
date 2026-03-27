/**
 * NeuromorphicDHT4 (N-G-DHT-4) – Generation 4
 *
 * Builds on N-3 with two new mechanisms optimised for the sender/receiver
 * population model (a fixed subset of senders always routing to a fixed subset
 * of receivers) and improved churn resilience.
 *
 * ── Mechanism 1 — Lateral shortcut propagation ───────────────────────────────
 *
 * N-3 teaches shortcuts reactively: when source S reaches target T, S gains
 * a direct synapse to T (source-inclusive hop caching).  But neighbouring
 * senders S2, S3 … in the same geographic region don't benefit until they
 * independently complete their own lookups to T.
 *
 * N-4 adds lateral spreading: the FIRST TIME a node A learns a new direct
 * synapse to T, it immediately introduces T to A's top LATERAL_K same-region
 * routing-table neighbours (highest-weight synapses in the same coarse cell).
 * Those neighbours gain a direct synapse to T without ever having routed to
 * it themselves.
 *
 * In the sender/receiver model this means: as soon as any sender discovers a
 * shortcut to a receiver, the entire local sender cluster benefits within the
 * same lookup epoch — shortcut discovery is O(1) amortised across the cluster
 * rather than O(cluster_size) sequential lookups.
 *
 * ── Mechanism 2 — Passive dead-node eviction ─────────────────────────────────
 *
 * N-3 relies on the passive DECAY_GAMMA schedule to eventually prune synapses
 * pointing to churned-out nodes.  Under high churn this creates a "ghost
 * synapse" problem: routing tables remain polluted with dead entries for many
 * DECAY_INTERVAL epochs, fragmenting the candidate set.
 *
 * N-4 adds opportunistic eviction: during every lookup's candidate-collection
 * sweep, any synapse whose peer is no longer alive has its weight zeroed
 * immediately.  The next decay tick then prunes it.  No extra messages; no
 * extra passes — dead entries are cleaned up the moment they are encountered
 * during normal routing.
 *
 * Combined effect: after a churn event, routing tables converge to a clean
 * state within O(numLookups / numNodes) lookups rather than O(decayInterval).
 *
 * ── Inherited from N-3 (unchanged) ──────────────────────────────────────────
 *   • Source-inclusive hop caching
 *   • Shortcut cascade backpropagation
 *   • Two-hop lookahead with advance-per-latency scoring (α = 5)
 *   • Triadic closure (hop caching for intermediate nodes)
 *   • Dense bootstrap (K_BOOT_FACTOR = 2)
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

// ── Tunable constants (same as N-3 unless noted) ──────────────────────────────

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
const GEO_REGION_BITS        = 4;   // coarse tier boundary (16 continent cells)

// ── N-4 specific ──────────────────────────────────────────────────────────────

const LATERAL_K              = 3;   // same-region neighbours that receive a new shortcut
const MAX_SYNAPTOME_SIZE     = 800; // hard cap on per-node synapse count to bound memory at large N

// ─────────────────────────────────────────────────────────────────────────────
// NeuromorphicDHT4
// ─────────────────────────────────────────────────────────────────────────────

export class NeuromorphicDHT4 extends DHT {
  static get protocolName() { return 'Neuromorphic-4'; }

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
    const node   = new NeuronNode({ id, lat, lng });
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

  // ── Neurogenesis ──────────────────────────────────────────────────────────

  buildRoutingTables({ bidirectional = true } = {}) {
    super.buildRoutingTables({ bidirectional });
    const sorted = [...this.nodeMap.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
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

      // Collect alive candidates that make strict XOR progress.
      // N-4: zero-weight dead entries immediately for fast churn recovery.
      const candidates = [];
      for (const s of current.synaptome.values()) {
        if ((s.peerId ^ targetKey) >= currentDist) continue;
        const peer = this.nodeMap.get(s.peerId);
        if (!peer?.alive) {
          // Mechanism 2 — passive dead-node eviction
          s.weight = 0;
          continue;
        }
        candidates.push(s);
      }
      for (const s of current.incomingSynapses.values()) {
        if ((s.peerId ^ targetKey) >= currentDist) continue; // no progress
        const peer = this.nodeMap.get(s.peerId);
        if (!peer?.alive) continue;
        candidates.push(s);
      }
      if (candidates.length === 0) break;

      // Two-tier region check.
      const inTargetRegion =
        ((current.id ^ targetKey) >> BigInt(64 - GEO_REGION_BITS)) === 0n;

      // Priority 0 — Direct-to-target short-circuit.
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

      // Triadic closure (intermediate nodes only — same as N-3).
      if (currentId !== sourceId) {
        this._recordTransit(current, sourceId, nextId);
      }

      // Source-inclusive hop caching with lateral spread (N-4).
      // N-3: _introduce(currentId, targetKey)
      // N-4: _introduceAndSpread(currentId, targetKey) — new shortcut also
      //      propagates to same-region routing neighbours of currentId.
      if (currentId !== targetKey) {
        this._introduceAndSpread(currentId, targetKey);
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

      // Shortcut cascade backpropagation (inherited from N-3).
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

  // ── Standard introduce (no spread) ───────────────────────────────────────

  _introduce(aId, cId, initialWeight = 0.5) {
    const nodeA = this.nodeMap.get(aId);
    const nodeC = this.nodeMap.get(cId);
    if (!nodeA || !nodeC || !nodeA.alive || !nodeC.alive) return;
    if (nodeA.hasSynapse(cId)) return;
    if (nodeA.synaptome.size >= MAX_SYNAPTOME_SIZE) return; // memory cap

    const latMs   = roundTripLatency(nodeA, nodeC);
    const stratum = clz64(nodeA.id ^ nodeC.id);
    const syn     = new Synapse({ peerId: cId, latencyMs: latMs, stratum });
    syn.weight    = initialWeight; // direct shortcuts start at 0.5; cascade relays at 0.1
    nodeA.addSynapse(syn);
    if (this.bidirectional) nodeC.addIncomingSynapse(aId, latMs, stratum);
  }

  // ── Introduce with lateral spread (N-4 mechanism 1) ──────────────────────
  //
  // If node A gains a NEW direct synapse to C, also introduce C to A's top
  // LATERAL_K same-region (coarse GEO_REGION_BITS cell) routing-table
  // neighbours — those are the nodes most likely to be fellow senders in the
  // same geographic cluster and most likely to also need routes to C.

  _introduceAndSpread(aId, cId) {
    const nodeA = this.nodeMap.get(aId);
    const nodeC = this.nodeMap.get(cId);
    if (!nodeA || !nodeC || !nodeA.alive || !nodeC.alive) return;

    const alreadyKnown = nodeA.hasSynapse(cId);

    if (!alreadyKnown && nodeA.synaptome.size < MAX_SYNAPTOME_SIZE) {
      const latMs   = roundTripLatency(nodeA, nodeC);
      const stratum = clz64(nodeA.id ^ nodeC.id);
      const syn     = new Synapse({ peerId: cId, latencyMs: latMs, stratum });
      syn.weight    = 0.5;
      nodeA.addSynapse(syn);

      // Lateral spread — tell A's same-region neighbours about C.
      const aRegion = aId >> BigInt(64 - GEO_REGION_BITS);
      const regional = [];
      for (const syn of nodeA.synaptome.values()) {
        if (syn.peerId === cId) continue;
        if ((syn.peerId >> BigInt(64 - GEO_REGION_BITS)) !== aRegion) continue;
        if (this.nodeMap.get(syn.peerId)?.alive) regional.push(syn);
      }
      // Pick top LATERAL_K by current synapse weight (most trusted neighbours).
      regional.sort((a, b) => b.weight - a.weight);
      for (let i = 0; i < Math.min(LATERAL_K, regional.length); i++) {
        this._introduce(regional[i].peerId, cId);
      }
    }
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
    const base = super.getStats();
    const nodes = [...this.nodeMap.values()];
    const totalSyn = nodes.reduce((acc, n) => acc + n.synaptome.size, 0);
    return {
      ...base,
      protocol:    'Neuromorphic-4',
      epoch:       this.simEpoch,
      avgSynapses: nodes.length ? (totalSyn / nodes.length).toFixed(1) : 0,
    };
  }
}

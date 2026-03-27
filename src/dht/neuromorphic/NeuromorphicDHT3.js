/**
 * NeuromorphicDHT3 (N-G-DHT-3) – Neuromorphic Geographic DHT, generation 3.
 *
 * Builds on N-G-DHT-2's two-tier hierarchical routing with three structural
 * advances designed to maximise shortcut propagation speed and density.
 *
 * ── Experiment 10 — Full-Path Shortcut Cascades ──────────────────────────────
 *
 * N-1 and N-2 build shortcuts REACTIVELY: intermediate nodes accumulate direct
 * synapses to targets they've forwarded traffic toward.  The shortcut web grows
 * gradually and is sparse until many lookups have traversed the same paths.
 *
 * N-3 introduces two mechanisms that propagate shortcuts much more aggressively:
 *
 *   1. Source-inclusive hop caching
 *      N-1/N-2 exclude the source node from hop caching (the guard
 *      `currentId !== sourceId`).  N-3 removes this restriction — the source
 *      ALSO receives a direct synapse to the target after any successful lookup.
 *      Repeated lookups from the same source to the same popular destination
 *      complete in exactly 1 hop (direct-to-target priority fires immediately).
 *
 *   2. Shortcut cascade backpropagation
 *      When a direct-to-target shortcut fires at "gateway" node G
 *      (detected because trace.last.synapse.peerId === targetKey),
 *      ALL earlier path nodes — including source — learn to route via G.
 *      They gain a guaranteed 2-hop path: any_earlier_node → G → target.
 *      This propagates O(path_length) useful new synapses from a single
 *      shortcut event, vs N-1/N-2 which require many separate lookups to
 *      build the same shortcut density backward along the path.
 *
 *      Example:  path S → A → B → G → target   (G has direct shortcut)
 *      Cascade teaches:  S→G,  A→G,  B→G
 *      Next lookup from S to target:  S → G → target = 2 hops
 *      (or 1 hop if source-inclusive hop caching already gave S a direct route)
 *
 * ── Additional structural parameters ─────────────────────────────────────────
 *
 *   3. Denser initial synaptome (K_BOOT_FACTOR = 2):
 *      Bootstrap with 2k entries per XOR stratum instead of k, giving the
 *      routing table a richer starting set of candidates to learn from.
 *      minPerStratum in decay is kept at k so extra entries are pruneable.
 *
 *   4. Higher intra-regional WEIGHT_SCALE (0.40 vs N-2's 0.15):
 *      More aggressive exploitation of learned shortcuts within geographic
 *      cells — where dense local traffic means shortcuts are highly reliable.
 *
 *   5. Wider 2-hop lookahead (LOOKAHEAD_ALPHA = 5 vs N-2's 3):
 *      Probes 5 first-hop candidates per step, sampling a wider horizon
 *      for better onward-path selection.
 *
 *   6. Gentler decay (DECAY_GAMMA = 0.998 vs 0.995, PRUNE_THRESHOLD = 0.05
 *      vs 0.10): shortcuts survive longer and the synaptome grows denser over
 *      training, building a more comprehensive shortcut web.
 *
 * ── Two-tier routing (inherited from N-2) ─────────────────────────────────────
 *   Tier 1 – inter-regional (cross GEO_REGION_BITS boundary): wScale = 0
 *   Tier 2 – intra-regional (same coarse cell): wScale = WEIGHT_SCALE
 *   Region test: top GEO_REGION_BITS of (currentId ^ targetKey) are all zero.
 */

import { DHT }               from '../DHT.js';
import { Synapse }           from './Synapse.js';
import { NeuronNode }        from './NeuronNode.js';
import { randomU64, clz64,
         roundTripLatency,
         buildXorRoutingTable } from '../../utils/geo.js';
import { geoCellId }         from '../../utils/s2.js';

// ── Tunable constants ─────────────────────────────────────────────────────────

const GEO_BITS             = 8;     // geographic prefix bits in G-ID (same as N-1/N-2)
const INERTIA_DURATION     = 20;    // epochs a reinforced synapse is decay-immune
const DECAY_GAMMA          = 0.998; // gentler decay (N-1/N-2 use 0.995) — richer web
const DECAY_INTERVAL       = 100;   // ticks between decay sweeps
const PRUNE_THRESHOLD      = 0.05;  // lower floor (N-1/N-2 use 0.10) — denser web
const INTRODUCTION_THRESHOLD = 1;   // transit count before triadic closure fires
const MAX_GREEDY_HOPS      = 40;    // safety cap on path length
const K_BOOT_FACTOR        = 2;     // bootstrap with k×2 synapses per stratum
const MAX_SYNAPTOME_SIZE   = 800;   // hard cap on per-node synapse count to bound memory at large N

// ── Learning hyperparameters ──────────────────────────────────────────────────

const EXPLORATION_EPSILON  = 0.05;  // first-hop random exploration (same as N-1/N-2)
const WEIGHT_SCALE         = 0.40;  // intra-regional AP weight bonus (N-2 uses 0.15)
const LOOKAHEAD_ALPHA      = 5;     // candidates probed in 2-hop lookahead (N-2: 3)
const GEO_REGION_BITS      = 4;     // coarse tier boundary: 16 continent-sized cells

// ─────────────────────────────────────────────────────────────────────────────
// NeuromorphicDHT3
// ─────────────────────────────────────────────────────────────────────────────

export class NeuromorphicDHT3 extends DHT {
  static get protocolName() { return 'Neuromorphic-3'; }

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

  // ── Neurogenesis (bootstrap to 2×-dense G-DHT-8 synaptome) ───────────────

  buildRoutingTables({ bidirectional = true } = {}) {
    super.buildRoutingTables({ bidirectional });
    const sorted = [...this.nodeMap.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
    for (const node of sorted) {
      // Bootstrap with K_BOOT_FACTOR × k peers per XOR stratum.
      // minPerStratum in _tickDecay stays at k, so the extra entries can be
      // pruned as learned shortcuts accumulate.
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

      // Collect alive candidates that make strict XOR progress toward target.
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

      // Two-tier region check (inherited from N-2):
      // same top GEO_REGION_BITS → intra-regional (weights active).
      const inTargetRegion =
        ((current.id ^ targetKey) >> BigInt(64 - GEO_REGION_BITS)) === 0n;

      // Priority 0 — Direct-to-target short-circuit:
      //   O(1) Map lookup.  If this node has a direct synapse to the exact
      //   target, always take it — AP would penalise high-latency hops even
      //   though completing in 1 more hop is always optimal.
      let nextSyn;
      const directSyn = current.synaptome.get(targetKey)
                     ?? current.incomingSynapses.get(targetKey);
      if (directSyn && this.nodeMap.get(targetKey)?.alive) {
        nextSyn = directSyn;
      } else if (hop === 0 && Math.random() < EXPLORATION_EPSILON) {
        nextSyn = candidates[Math.floor(Math.random() * candidates.length)];
      } else if (inTargetRegion) {
        // Tier 2: intra-regional — learned shortcuts genuinely collapse hops.
        nextSyn = this._bestByTwoHopAP(current, candidates, targetKey, currentDist, WEIGHT_SCALE);
      } else {
        // Tier 1: inter-regional — pure geographic progress, weight = 0.
        nextSyn = this._bestByTwoHopAP(current, candidates, targetKey, currentDist, 0);
      }

      const nextId   = nextSyn.peerId;
      const nextNode = this.nodeMap.get(nextId);
      if (!nextNode) break;

      path.push(nextId);
      trace.push({ fromId: currentId, synapse: nextSyn });
      totalTimeMs += nextSyn.latency;

      // Triadic closure (same as N-1/N-2).
      if (currentId !== sourceId) {
        this._recordTransit(current, sourceId, nextId);
      }

      // Innovation 1 — Source-inclusive hop caching:
      //   N-1/N-2 guard: `currentId !== sourceId && currentId !== targetKey`
      //   N-3 removes the sourceId guard so the SOURCE also accumulates a
      //   direct synapse to every target it has successfully routed to.
      //   Combined with the direct-to-target priority check, the second
      //   lookup from the same source to the same popular dest = 1 hop.
      if (currentId !== targetKey) {
        this._introduce(currentId, targetKey);
      }

      currentId = nextId;
    }

    // LTP reinforcement: only paths at or below EMA latency are reinforced.
    const hopCount = path.length - 1;
    if (reached) {
      this._emaHops = this._emaHops === null
        ? hopCount : 0.9 * this._emaHops + 0.1 * hopCount;
      this._emaTime = this._emaTime === null
        ? totalTimeMs : 0.9 * this._emaTime + 0.1 * totalTimeMs;
      if (trace.length > 0 && totalTimeMs <= this._emaTime) {
        this._reinforceWave(trace);
      }

      // Innovation 2 — Shortcut cascade backpropagation:
      //   If the lookup completed via a direct-to-target shortcut fired at
      //   the penultimate node (the "gateway"), teach ALL earlier path nodes
      //   to route via that gateway.  Each learns a guaranteed 2-hop path:
      //
      //     earlier_node → gateway → target
      //
      //   This propagates O(path_length) useful new synapses from a single
      //   shortcut event.  N-1/N-2 require many separate lookups to propagate
      //   shortcut knowledge backward up the path; N-3 does it in one pass.
      if (trace.length >= 2) {
        const lastTrace = trace[trace.length - 1];
        if (lastTrace.synapse.peerId === targetKey) {
          // Direct shortcut fired at lastTrace.fromId = the gateway node.
          const gatewayId = lastTrace.fromId;
          // Teach source and every earlier intermediary about the gateway.
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

  // wScale = WEIGHT_SCALE for intra-regional, 0 for inter-regional.
  // LOOKAHEAD_ALPHA = 5 (wider than N-2's 3).
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

      // Immediate win — first hop IS the target.
      if (firstDist === 0n) return firstSyn;

      const firstNode = this.nodeMap.get(firstSyn.peerId);
      if (!firstNode?.alive) continue;

      // Peek into the candidate's synaptome for the best onward hop.
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

  _introduce(aId, cId, initialWeight = 0.5) {
    const nodeA = this.nodeMap.get(aId);
    const nodeC = this.nodeMap.get(cId);
    if (!nodeA || !nodeC || !nodeA.alive || !nodeC.alive) return;
    if (nodeA.hasSynapse(cId)) return; // already connected
    if (nodeA.synaptome.size >= MAX_SYNAPTOME_SIZE) return; // memory cap

    const latMs   = roundTripLatency(nodeA, nodeC);
    const stratum = clz64(nodeA.id ^ nodeC.id);
    const syn     = new Synapse({ peerId: cId, latencyMs: latMs, stratum });
    syn.weight    = initialWeight; // direct shortcuts start at 0.5; cascade relays at 0.1
    nodeA.addSynapse(syn);
    if (this.bidirectional) nodeC.addIncomingSynapse(aId, latMs, stratum);
  }

  // ── Synaptic decay (LTD) ──────────────────────────────────────────────────

  _tickDecay() {
    for (const node of this.nodeMap.values()) {
      const toPrune = [];

      for (const syn of node.synaptome.values()) {
        if (syn.inertia > this.simEpoch) continue; // inertia-locked: skip
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

      // Keep at least k per stratum (= original config.k, not 2k).
      // The extra K_BOOT_FACTOR synapses and learned shortcuts beyond k
      // compete normally for pruning.
      const minPerStratum = this._k;

      for (const [stratum, candidates] of byStratum) {
        let total = 0;
        for (const s of node.synaptome.values()) {
          if (s.stratum === stratum) total++;
        }
        const removable = Math.max(0, total - minPerStratum);

        // Prune weakest first.
        candidates.sort((a, b) => a.weight - b.weight);
        for (let i = 0; i < candidates.length; i++) {
          if (i < removable) {
            node.synaptome.delete(candidates[i].peerId);
          } else {
            candidates[i].weight = PRUNE_THRESHOLD; // reset to floor
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
      protocol:    'Neuromorphic-3',
      epoch:       this.simEpoch,
      avgSynapses: nodes.length ? (totalSyn / nodes.length).toFixed(1) : 0,
    };
  }
}

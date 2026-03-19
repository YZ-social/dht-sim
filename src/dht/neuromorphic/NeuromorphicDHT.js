/**
 * NeuromorphicDHT (N-G-DHT) – Neuromorphic Geographic Distributed Hash Table.
 *
 * Architecture overview
 * ─────────────────────
 * Nodes are assigned G-IDs with an 8-bit geographic S2 prefix (identical to
 * GeographicDHT-8), so XOR distance naturally measures geographic proximity.
 *
 * The routing table is replaced by a dynamic Synaptome: an unbounded map of
 * weighted Synapse objects that evolve through use.
 *
 * At bootstrap the Synaptome is pre-wired to exactly match the G-DHT-8
 * routing table (Phase 2: Neurogenesis), so initial performance is on par
 * with G-DHT-8. From there, four adaptive mechanisms take over:
 *
 *   1. Greedy AP-based routing   – prefer fast, reliable, high-progress hops.
 *   2. Neuromodulation (LTP)     – successful paths are reinforced (+0.2W),
 *                                  locked with an inertia epoch.
 *   3. Structural Plasticity     – frequently-used transit pairs are short-
 *                                  circuited via direct high-weight synapses.
 *   4. Synaptic Decay (LTD)      – unused synapses decay (×0.90 per tick)
 *                                  and are pruned below a weight floor,
 *                                  respecting the Structural Survival Rule.
 *
 * Simulation time model
 * ─────────────────────
 * Real-time features (inertia locks, decay intervals) are mapped onto a
 * monotonic simulation epoch counter (simEpoch) incremented per lookup:
 *   - Inertia lock   = INERTIA_DURATION epochs  (~10 minutes in real time)
 *   - Decay interval = DECAY_INTERVAL lookups   (~60 seconds of traffic)
 */

import { DHT }               from '../DHT.js';
import { Synapse }           from './Synapse.js';
import { NeuronNode }        from './NeuronNode.js';
import { randomU64, clz64,
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
// EXPLORATION_EPSILON: probability of choosing a random (non-best-AP) candidate
// at the FIRST hop only.  All-hop exploration inflates every session's average
// latency (~18ms with 10%/hop), polluting the EMA quality signal.
// First-hop-only keeps noise bounded: one random step, greedy thereafter.
const EXPLORATION_EPSILON  = 0.05; // 5% random first-hop exploration only
// WEIGHT_SCALE: how much synapse weight influences AP selection.
// Kept at 0.15 (mild tiebreaker) so AP is dominated by ΔDist/L.
// High-W synapses get a max 15% boost — enough to prefer genuinely fast
// paths that have been reinforced, without overriding better-progress routes.
const WEIGHT_SCALE         = 0.15;
// LOOKAHEAD_ALPHA: how many top-AP candidates to probe for 2-hop lookahead.
// At each hop we peek into each candidate's synaptome and pick the first hop
// whose NEXT hop lands closest to target (2-hop AP optimisation).
// This mirrors G-DHT-8's iterative multi-table aggregation: G-DHT-8 queries
// α=3 nodes per round and sees 60 candidates; LOOKAHEAD_ALPHA=3 gives N-G-DHT
// the same effective "look ahead" without changing the recursive routing model.
const LOOKAHEAD_ALPHA      = 3;

// ─────────────────────────────────────────────────────────────────────────────
// NeuromorphicDHT
// ─────────────────────────────────────────────────────────────────────────────

export class NeuromorphicDHT extends DHT {
  static get protocolName() { return 'Neuromorphic-1'; }

  constructor(config = {}) {
    super(config);
    /** @type {Map<number, NeuronNode>} */
    this.nodeMap          = new Map();
    this.simEpoch         = 0;
    this.lookupsSinceDecay = 0;
    this._k               = config.k ?? 20;
    // EMA of successful hop counts — used for hop-efficiency gate (secondary).
    // Null until the first successful lookup.
    this._emaHops         = null;
    // EMA of successful lookup times (ms) — primary quality signal for LTP.
    // Only paths at or below this average get reinforced.
    this._emaTime         = null;
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
    // Dead peers are skipped during routing (alive check); their synapses
    // pointing outward will decay naturally over subsequent ticks.
  }

  // ── Phase 2: Neurogenesis (Bootstrap to G-DHT-8 parity) ──────────────────

  /**
   * Wire every neuron's Synaptome to match the G-DHT-8 k-bucket layout.
   *
   * For each node we sort all peers into 32 XOR-distance buckets (one per
   * bit position), keep the k closest per bucket, and create a Synapse for
   * each.  This reproduces the exact G-DHT-8 routing table as an initial
   * Synaptome — the neuron's starting state is on par with G-DHT-8.
   */
  buildRoutingTables() {
    const k      = this._k;
    const sorted = [...this.nodeMap.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

    for (const node of sorted) {
      for (const peer of buildXorRoutingTable(node.id, sorted, k)) {
        const latMs   = roundTripLatency(node, peer);
        const stratum = clz64(node.id ^ peer.id);
        node.addSynapse(new Synapse({ peerId: peer.id, latencyMs: latMs, stratum }));
      }
      node._nodeMapRef = this.nodeMap;
    }
  }

  // ── Phase 3: Action Selection (Greedy AP routing) ─────────────────────────

  /**
   * Route a message from sourceId toward targetKey using greedy Activation
   * Potential selection at each hop.
   *
   * Each hop: pick the synapse with highest AP = (ΔDist / L) × (1 + W).
   * After convergence, fire a Positive Wave backward to reinforce the path.
   *
   * @param {number} sourceId
   * @param {number} targetKey
   * @returns {Promise<import('../DHT.js').LookupResult>}
   */
  async lookup(sourceId, targetKey) {
    const source = this.nodeMap.get(sourceId);
    if (!source || !source.alive) return null;

    // Advance simulation epoch and trigger decay if due
    this.simEpoch++;
    if (++this.lookupsSinceDecay >= DECAY_INTERVAL) {
      this._tickDecay();
      this.lookupsSinceDecay = 0;
    }

    const path  = [sourceId];
    const trace = []; // [{ fromId, synapse }] for the reinforcement wave

    let currentId   = sourceId;
    let totalTimeMs = 0;
    let reached     = false;

    for (let hop = 0; hop < MAX_GREEDY_HOPS; hop++) {
      const current = this.nodeMap.get(currentId);
      if (!current || !current.alive) break;

      const currentDist = current.id ^ targetKey;  // BigInt

      // Exact target reached (only possible when targetKey is a real node ID)
      if (currentDist === 0n) { reached = true; break; }

      // Phase 3, step 1: collect all alive synapses making strict XOR progress.
      // Strict progress (peerDist < currentDist) is the natural loop prevention:
      // XOR distance can only decrease each hop, so no node can be revisited.
      const candidates = [];
      for (const s of current.synaptome.values()) {
        if ((s.peerId ^ targetKey) >= currentDist) continue; // no progress
        const peer = this.nodeMap.get(s.peerId);
        if (!peer?.alive) continue;
        candidates.push(s);
      }

      // No progress possible → converged to the closest reachable node.
      // This is the natural termination for greedy routing.
      if (candidates.length === 0) break;

      // Phase 3, step 2–3: select next hop.
      //
      // Priority 0 — Direct-to-target short-circuit (O(1) Map lookup):
      //   If this node has a synapse pointing directly at the exact target,
      //   always take it.  The AP formula is ΔDist/L and therefore strongly
      //   penalises high-latency hops — a shortcut to a geographically
      //   distant dest node (200 ms RTT) loses to local 5 ms hops in AP even
      //   though jumping straight there is always fewer hops than any
      //   alternative.  We bypass AP entirely for the exact-target case.
      //
      // Priority 1 — ε-greedy first-hop exploration (encourages diversity).
      // Priority 2 — 2-hop lookahead AP for all other hops.
      let nextSyn;
      const directSyn = current.synaptome.get(targetKey);
      if (directSyn && this.nodeMap.get(targetKey)?.alive) {
        nextSyn = directSyn;
      } else if (hop === 0 && Math.random() < EXPLORATION_EPSILON) {
        nextSyn = candidates[Math.floor(Math.random() * candidates.length)];
      } else {
        nextSyn = this._bestByTwoHopAP(current, candidates, targetKey, currentDist);
      }
      const nextId   = nextSyn.peerId;
      const nextNode = this.nodeMap.get(nextId);
      if (!nextNode) break;

      path.push(nextId);
      trace.push({ fromId: currentId, synapse: nextSyn });
      totalTimeMs += roundTripLatency(current, nextNode);

      // Phase 5a: record transit for triadic closure (source learns shortcuts)
      if (currentId !== sourceId) {
        this._recordTransit(current, sourceId, nextId);
      }

      // Phase 5b: hop caching — every intermediary node learns a direct
      // shortcut to the target.  Unlike triadic closure (which only benefits
      // the source), this enriches the routing table at *every hop*, so
      // future lookups passing through these nodes toward similar targets
      // can take a big XOR leap instead of multiple small steps.
      if (currentId !== sourceId && currentId !== targetKey) {
        this._introduce(currentId, targetKey);
      }

      currentId = nextId;
    }

    // Phase 4: Latency-quality LTP.
    //
    // Reinforce only if:
    //   a) the lookup succeeded (reached the exact target), AND
    //   b) total path time ≤ running EMA of successful lookup times.
    //
    // The EMA is the primary learning signal: synapses on paths that were
    // at-or-below average latency accumulate weight.  The AP formula
    // (ΔDist/L × (1 + WEIGHT_SCALE × W)) then gives those synapses a mild
    // preference boost, steering future lookups toward the faster paths.
    // Paths above average never reinforce → their synapses decay → the network
    // naturally consolidates onto genuinely fast routes.
    const hopCount = path.length - 1;
    if (reached) {
      this._emaHops = this._emaHops === null
        ? hopCount
        : 0.9 * this._emaHops + 0.1 * hopCount;
      this._emaTime = this._emaTime === null
        ? totalTimeMs
        : 0.9 * this._emaTime + 0.1 * totalTimeMs;
      // Reinforce if this path was at or below the running average latency.
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

  /**
   * Walk the hop trace in reverse and reinforce each synapse used.
   * Each reinforcement: W += 0.2 (capped at 1.0), inertia lock for
   * INERTIA_DURATION epochs.
   */
  _reinforceWave(trace) {
    for (let i = trace.length - 1; i >= 0; i--) {
      const { fromId, synapse } = trace[i];
      const node = this.nodeMap.get(fromId);
      if (!node) continue;
      // Re-fetch from synaptome in case it was replaced (e.g. after introduction)
      const syn = node.synaptome.get(synapse.peerId);
      if (syn) syn.reinforce(this.simEpoch, INERTIA_DURATION);
    }
  }

  // ── 2-hop lookahead AP selection ─────────────────────────────────────────

  /**
   * Pick the best first hop using 2-hop lookahead Activation Potential.
   *
   *   AP_2hop = (currentDist − twoHopDist) / (L_first + L_second)
   *             × (1 + WEIGHT_SCALE × firstSyn.weight)
   *
   * For each of the top LOOKAHEAD_ALPHA candidates (ranked by 1-hop AP),
   * we peek into that node's synaptome to find the best onward hop toward
   * target.  The combined 2-hop XOR progress over combined 2-hop latency
   * is the true AP signal.  This mirrors G-DHT-8's iterative round-1
   * aggregation without abandoning the recursive routing model:
   *
   *   G-DHT-8:  queries α=3 nodes, each returns k=20 → 60 candidates seen.
   *   N-G-DHT:  probes α=3 candidates' synaptomes  → same 60-candidate horizon.
   *
   * Dead-end first hops (no onward progress) degrade gracefully to 1-hop AP.
   */
  _bestByTwoHopAP(current, candidates, targetKey, currentDist) {
    // Sort candidates by 1-hop AP to identify the top-α to probe
    const sorted = candidates
      .map(s => {
        const pd  = s.peerId ^ targetKey;  // BigInt
        const ap1 = (Number(currentDist - pd) / s.latency) * (1 + WEIGHT_SCALE * s.weight);
        return { s, ap1 };
      })
      .sort((a, b) => b.ap1 - a.ap1);

    const probeSet = sorted.slice(0, LOOKAHEAD_ALPHA).map(x => x.s);

    let bestSyn = null;
    let bestAP2 = -Infinity;

    for (const firstSyn of probeSet) {
      const firstDist = firstSyn.peerId ^ targetKey;  // BigInt

      // Immediate win: this candidate IS the target
      if (firstDist === 0n) return firstSyn;

      const firstNode = this.nodeMap.get(firstSyn.peerId);
      if (!firstNode?.alive) continue;

      // Collect first hop's alive progress candidates toward target
      const fwdCands = [];
      for (const fs of firstNode.synaptome.values()) {
        if ((fs.peerId ^ targetKey) < firstDist) {
          if (this.nodeMap.get(fs.peerId)?.alive) fwdCands.push(fs);
        }
      }

      let twoHopDist, secondLatency;
      if (fwdCands.length === 0) {
        // Dead end after first hop: 2-hop progress = 1-hop progress, L_second = 0
        twoHopDist     = firstDist;
        secondLatency  = 0;
      } else {
        const bestFwd  = firstNode.bestByAP(fwdCands, targetKey, WEIGHT_SCALE);
        twoHopDist     = bestFwd.peerId ^ targetKey;  // BigInt
        secondLatency  = bestFwd.latency;
      }

      // 2-hop AP: total progress over total latency, boosted by first-hop weight
      const progress2   = Number(currentDist - twoHopDist);  // Convert for float arithmetic
      const totalLat    = firstSyn.latency + secondLatency;
      const ap2         = (progress2 / totalLat) * (1 + WEIGHT_SCALE * firstSyn.weight);

      if (ap2 > bestAP2) {
        bestAP2 = ap2;
        bestSyn = firstSyn;
      }
    }

    // Fallback: if all probed are dead, use full-candidate 1-hop AP
    return bestSyn ?? current.bestByAP(candidates, targetKey, WEIGHT_SCALE);
  }

  // ── Phase 5: Structural Plasticity (Triadic Closure) ─────────────────────

  /**
   * Record that intermediary `node` forwarded a message originating from
   * `originId` onward to `nextId`.  When the same (origin → next) pair
   * has been relayed INTRODUCTION_THRESHOLD times, introduce origin to next
   * with a fresh, high-weight direct synapse.
   */
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

  /**
   * Create a direct synapse from nodeA to nodeC (The Sprout).
   * Initialized with W=0.8 to immediately compete with well-worn routes.
   */
  _introduce(aId, cId) {
    const nodeA = this.nodeMap.get(aId);
    const nodeC = this.nodeMap.get(cId);
    if (!nodeA || !nodeC || !nodeA.alive || !nodeC.alive) return;
    if (nodeA.hasSynapse(cId)) return; // already connected

    const latMs   = roundTripLatency(nodeA, nodeC);
    const stratum = clz64(nodeA.id ^ nodeC.id);
    const syn     = new Synapse({ peerId: cId, latencyMs: latMs, stratum });
    syn.weight    = 0.5; // neutral weight — must earn AP priority through reinforcement
    nodeA.addSynapse(syn);
  }

  // ── Phase 6: Synaptic Decay (LTD) ────────────────────────────────────────

  /**
   * Periodic decay pass over all synapses in the network.
   *
   * For each node:
   *   1. Decay all non-inertia synapses by DECAY_GAMMA.
   *   2. Collect those that fell below PRUNE_THRESHOLD.
   *   3. Group candidates by stratum and count total synapses per stratum.
   *   4. Prune the weakest candidates first, but keep at least
   *      MIN_STRATUM_SYNAPSES per stratum (Structural Breadth Rule).
   *      Survivors that would be pruned are reset to PRUNE_THRESHOLD.
   *
   * Sorting weakest-first ensures the most-reinforced synapses survive,
   * preserving the routing breadth needed for efficient greedy routing.
   */
  _tickDecay() {
    for (const node of this.nodeMap.values()) {
      const toPrune = [];

      for (const syn of node.synaptome.values()) {
        if (syn.inertia > this.simEpoch) continue; // inertia-locked: skip
        syn.decay(DECAY_GAMMA);
        if (syn.weight < PRUNE_THRESHOLD) toPrune.push(syn);
      }

      if (!toPrune.length) continue;

      // Group below-threshold candidates by stratum
      const byStratum = new Map();
      for (const syn of toPrune) {
        let arr = byStratum.get(syn.stratum);
        if (!arr) { arr = []; byStratum.set(syn.stratum, arr); }
        arr.push(syn);
      }

      // Keep at least k synapses per stratum — same breadth as G-DHT-8 k-buckets.
      // Shortcuts added by triadic closure (beyond k) can be pruned normally.
      const minPerStratum = this._k;

      for (const [stratum, candidates] of byStratum) {
        // Count all live synapses in this stratum (including above-threshold ones)
        let total = 0;
        for (const s of node.synaptome.values()) {
          if (s.stratum === stratum) total++;
        }

        // How many can be removed while preserving minPerStratum?
        const removable = Math.max(0, total - minPerStratum);

        // Sort weakest first — prune the least-useful ones
        candidates.sort((a, b) => a.weight - b.weight);

        for (let i = 0; i < candidates.length; i++) {
          if (i < removable) {
            node.synaptome.delete(candidates[i].peerId); // prune
          } else {
            candidates[i].weight = PRUNE_THRESHOLD;      // reset to floor
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
      protocol: 'Neuromorphic',
      epoch:       this.simEpoch,
      avgSynapses: nodes.length ? (totalSyn / nodes.length).toFixed(1) : 0,
    };
  }
}

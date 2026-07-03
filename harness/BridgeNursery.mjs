// =====================================================================
// BridgeNursery.mjs — W2 B2: bridge bootstrap-nursery policy (sim-side).
//
// Models the bridge's INTRODUCTION policy (not a kernel change): who the
// bridge hands a newcomer to, and how the anchor pool is curated. Rides
// on engine.bridgeIntroduce(newId, anchorIds) (B1).
//
// Anchor eligibility is a COMPOSITE score — never one signal (a lone
// metric is gameable and blind to outcomes):
//     score = w.uptime·uptime + w.degree·degree
//           + w.inbound·inboundDegree + w.integ·integrationSuccess
//   · uptime            longevity / stability (also the hard eligibility gate)
//   · degree            outbound synaptome fill  (well-connected)
//   · inboundDegree     incoming synapses        (how many route THROUGH it)
//   · integrationSuccess smoothed success rate over newcomers it anchored —
//                        an OUTCOME-based track record. Attempts are recorded
//                        at pickAnchors; successes credited when a newcomer
//                        graduates. Self-correcting: a well-connected node that
//                        fails to integrate newcomers loses anchor score.
//
// A fresh joiner is NEVER anchor-eligible until it survives `minUptime`
// AND graduates; then it can itself become an anchor. That is the
// "keep room for newcomers, introduce to proven anchors" behaviour.
// =====================================================================

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
// Keyspace-region prefix = the top 8 bits of the 264-bit BigInt node id
// (the geo/region byte). Used to spread anchors across regions. Under a
// shrunk keyspace this collapses to one bucket, which degrades to
// score-order (pass 2) rather than crashing — acceptable for diversity.
const regionKey = (id) => (id >> 256n).toString();

export class BridgeNursery {
  constructor(engine, opts = {}) {
    this.eng = engine;
    this.k          = opts.k          ?? 3;    // anchors per introduction
    this.minUptime  = opts.minUptime  ?? 3;    // rounds survived before anchor-eligible
    this.uptimeRef  = opts.uptimeRef  ?? 20;   // uptime normalization horizon (rounds)
    // Graduation = a real working degree, as ABSOLUTE floors (mesh-size
    // robust; a fraction-of-cap bar is unreachable in small meshes where
    // even established nodes sit well below MAX_SYNAPTOME).
    this.gradSyn     = opts.gradSyn     ?? 2 * this.k; // outbound synapses to graduate
    this.gradInbound = opts.gradInbound ?? this.k;     // inbound refs to graduate
    // Bayesian-smoothing priors so unproven anchors sit NEUTRAL, not zero.
    this.alpha = opts.alpha ?? 1;
    this.beta  = opts.beta  ?? 1;
    // Composite weights (B5 sweeps these). Default: inbound + track-record
    // weighted a touch higher — the two that most predict a good introduction.
    this.weights = opts.weights ?? { uptime: 0.2, degree: 0.2, inbound: 0.3, integ: 0.3 };

    this._born       = new Map(); // id -> round first seen
    this._intro      = new Map(); // newcomerId -> { anchors:[ids], round }
    this._attempts   = new Map(); // anchorId -> # times chosen as an anchor
    this._successes  = new Map(); // anchorId -> # anchored newcomers that graduated
    this._graduated  = new Set(); // newcomerIds past the stability bar
  }

  get _maxSyn() { return this.eng.domain?.MAX_SYNAPTOME ?? 50; }

  // Register a node's arrival (genesis core + every newcomer).
  onJoin(round, id) { if (!this._born.has(id)) this._born.set(id, round); }

  // Count OTHER live nodes referencing `id` in their tables — the honest
  // inbound-reachability measure (see W2 scope B4; NOT eng.lookup()).
  inboundRefs(id) {
    let r = 0;
    for (const n of this.eng.nodeMap.values()) {
      if (n.id === id) continue;
      if (n.synaptome.has(id) || n.incomingSynapses.has(id)) r++;
    }
    return r;
  }

  eligible(round, id) {
    const born = this._born.get(id);
    if (born == null || (round - born) < this.minUptime) return false;
    const node = this.eng.nodeMap.get(id);
    return !!(node && node.alive);
  }

  integrationRate(id) {
    const a = this._attempts.get(id) ?? 0;
    const s = this._successes.get(id) ?? 0;
    return (s + this.alpha) / (a + this.alpha + this.beta);
  }

  score(round, id) {
    const node = this.eng.nodeMap.get(id);
    if (!node) return 0;
    const cap     = this._maxSyn;
    const uptimeN = clamp01((round - (this._born.get(id) ?? round)) / this.uptimeRef);
    const degN    = clamp01(node.synaptome.size / cap);
    const inN     = clamp01(node.incomingSynapses.size / cap);
    const integN  = this.integrationRate(id); // already in [0,1]
    const w = this.weights;
    return w.uptime * uptimeN + w.degree * degN + w.inbound * inN + w.integ * integN;
  }

  // Choose k eligible anchors: top composite score, spread across keyspace
  // regions (distinct high-byte prefixes first), never `newId`. Records an
  // attempt against each chosen anchor.
  pickAnchors(round, newId, k = this.k) {
    const scored = [];
    for (const id of this.eng.nodeMap.keys()) {
      if (id === newId || !this.eligible(round, id)) continue;
      scored.push({ id, s: this.score(round, id) });
    }
    scored.sort((a, b) => b.s - a.s);

    const chosen = [], usedRegions = new Set();
    // Pass 1: highest score with a NOT-yet-used keyspace region (diversity).
    for (const { id } of scored) {
      if (chosen.length >= k) break;
      const reg = regionKey(id);
      if (!usedRegions.has(reg)) { chosen.push(id); usedRegions.add(reg); }
    }
    // Pass 2: fill any remaining slots with the next-highest scorers.
    for (const { id } of scored) {
      if (chosen.length >= k) break;
      if (!chosen.includes(id)) chosen.push(id);
    }

    for (const id of chosen) this._attempts.set(id, (this._attempts.get(id) ?? 0) + 1);
    this._intro.set(newId, { anchors: chosen, round });
    return chosen;
  }

  // Introduce a newcomer through the bridge: pick anchors, then run the
  // B1 primitive. Returns { anchors, reach }.
  async introduce(round, newId, k = this.k) {
    const anchors = this.pickAnchors(round, newId, k);
    const reach = await this.eng.bridgeIntroduce(newId, anchors);
    return { anchors, reach };
  }

  // Scan introduced newcomers; graduate any past the stability bar and
  // credit their anchors an integration success. Returns the newly
  // graduated ids (now anchor-eligible themselves once past minUptime).
  graduate(round) {
    const newlyGraduated = [];
    for (const [newId, info] of this._intro) {
      if (this._graduated.has(newId)) continue;
      const node = this.eng.nodeMap.get(newId);
      if (!node || !node.alive) continue;
      if (node.synaptome.size >= this.gradSyn && this.inboundRefs(newId) >= this.gradInbound) {
        this._graduated.add(newId);
        for (const a of info.anchors) this._successes.set(a, (this._successes.get(a) ?? 0) + 1);
        newlyGraduated.push(newId);
      }
    }
    return newlyGraduated;
  }

  stats() {
    return {
      tracked:    this._born.size,
      introduced: this._intro.size,
      graduated:  this._graduated.size,
      anchorsUsed: this._attempts.size,
    };
  }
}

import { randomU64, computeStats, haversine, continentOf, buildXorRoutingTable } from '../utils/geo.js';
import { PubSubAdapter, topicIdFor } from '../pubsub/PubSubAdapter.js';

/**
 * SimulationEngine – orchestrates lookup tests and churn tests on a DHT.
 *
 * Emits progress via onProgress(fraction, partialStats) callback.
 * All timing is simulated (no real waits); the engine yields to the event loop
 * periodically so the UI stays responsive.
 */
export class SimulationEngine {
  constructor() {
    this.running = false;
    this.onProgress = null;   // (fraction: 0-1, partial: object) => void
    this.onComplete = null;   // (result: object) => void
    this.onPathFound = null;  // (path: number[], dht) => void  – for visualization
  }

  stop() {
    this.running = false;
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  /** Pick a random live node from the DHT. */
  _randomNode(dht) {
    const nodes = dht.getNodes().filter(n => n.alive);
    if (!nodes.length) return null;
    return nodes[Math.floor(Math.random() * nodes.length)];
  }

  /** Pick a random live node from the DHT that is NOT excludeId. */
  _randomOtherNode(dht, excludeId) {
    const nodes = dht.getNodes().filter(n => n.alive && n.id !== excludeId);
    if (!nodes.length) return null;
    return nodes[Math.floor(Math.random() * nodes.length)];
  }

  /**
   * Return all live nodes within radiusKm of sourceNode (excluding itself).
   * Uses the Haversine great-circle distance.
   */
  _nodesWithinRadius(dht, sourceNode, radiusKm) {
    return dht.getNodes().filter(n =>
      n.alive &&
      n.id !== sourceNode.id &&
      haversine(sourceNode.lat, sourceNode.lng, n.lat, n.lng) <= radiusKm
    );
  }

  /**
   * Return all live nodes that have at least one other live node within
   * radiusKm.  Used to pre-filter eligible senders in regional mode so that
   * every randomly chosen sender is guaranteed to have a reachable receiver.
   */
  _eligibleRegionalSenders(dht, radiusKm) {
    const nodes = dht.getNodes().filter(n => n.alive);
    return nodes.filter(n =>
      nodes.some(m => m.id !== n.id &&
        haversine(n.lat, n.lng, m.lat, m.lng) <= radiusKm)
    );
  }

  /** Yield to the browser event loop so the UI can update. */
  _yield() {
    return new Promise(resolve => setTimeout(resolve, 0));
  }

  _partialStats(hops, times) {
    return {
      hops: computeStats(hops),
      time: computeStats(times),
      count: hops.length,
    };
  }

  // ── Lookup Test ──────────────────────────────────────────────────────────

  /**
   * Run `numMessages` independent random lookups and collect metrics.
   *
   * @param {import('../dht/DHT.js').DHT} dht
   * @param {object}  params
   * @param {number}  params.numMessages
   * @param {boolean} params.captureLastPath  – store the final path for globe viz
   * @returns {Promise<LookupTestResult>}
   */
  async runLookupTest(dht, params = {}) {
    const {
      numMessages    = 500,
      captureLastPath = true,
      regional       = false,
      regionalRadius = 2000,
      hotPct         = 100,
      sourcePct      = 0,    // 0 = disabled; 1-99 = % of nodes that act as sources
      sourceNodes    = null, // pre-built source pool (takes precedence over sourcePct)
      destPct        = 0,    // 0 = disabled; 1-99 = % of nodes designated as destinations
      destNodes      = null, // pre-built destination pool (takes precedence over destPct).
                             // Pass this from runBenchmark so warmup and measurement share
                             // the EXACT same destination set — critical for N-DHT learning.
      destRandom     = false,  // when true and destPool is active, pick a random dest from the
                               // pool instead of the XOR-nearest entry. Used for continent tests
                               // where any cross-continental destination is equally valid.
      managed        = false,  // when true, caller owns this.running (used by runBenchmark)
    } = params;
    if (!managed) this.running = true;

    const hopsArr = [];
    const timeArr = [];
    let failures = 0;
    let lastPath = null;

    // Build a nodeMap once so per-lookup destination checks are O(1)
    const allNodes = dht.getNodes();
    const nodeMap  = new Map(allNodes.map(n => [n.id, n]));

    // In regional mode, pre-compute senders that have at least one node
    // within the radius.  This eliminates all "no nearby nodes" failures
    // and ensures the full numMessages count is meaningful.
    const eligibleSenders = regional
      ? this._eligibleRegionalSenders(dht, regionalRadius)
      : null;

    // Source pool — restricts which nodes can initiate lookups.
    //   1. sourceNodes (pre-built array): use as-is, filtering for liveness.
    //   2. sourcePct (percentage): sample a fresh random pool now.
    //   3. Neither set → no source restriction (standard behaviour).
    // sourcePool is mutually exclusive with hotPool and regional.
    let sourcePool = null;
    if (!regional && sourceNodes) {
      sourcePool = sourceNodes.filter(n => n.alive);
    } else if (!regional && sourcePct > 0 && sourcePct < 100) {
      const aliveNodes = allNodes.filter(n => n.alive);
      const poolSize   = Math.max(1, Math.ceil(aliveNodes.length * sourcePct / 100));
      sourcePool = shuffleSample(aliveNodes, poolSize);
    }

    // Destination pool — three priority levels:
    //   1. destNodes (pre-built array): use as-is, filtering for liveness.
    //      Used by runBenchmark so warmup and measurement share the same pool.
    //   2. destPct (percentage): sample a fresh random pool now.
    //      Used by standalone Lookup Tests from the UI.
    //   3. Neither set → no destination restriction (standard behaviour).
    // destPool and hotPool are mutually exclusive; destPool takes precedence.
    let destPool = null;
    if (destNodes) {
      // Pre-built pool passed in — filter for current liveness only
      destPool = destNodes.filter(n => n.alive);
    } else if (!regional && destPct > 0 && destPct < 100) {
      const aliveNodes = allNodes.filter(n => n.alive);
      const poolSize   = Math.max(1, Math.ceil(aliveNodes.length * destPct / 100));
      destPool = shuffleSample(aliveNodes, poolSize);
    }

    // Hot-node pool: when hotPct < 100 AND neither sourcePool nor destPool is active,
    // restrict both sources and destinations to a random subset of alive nodes.
    // Repeated traffic between the same popular nodes gives the neuromorphic
    // synaptome enough signal to build dense shortcuts.
    let hotPool = null;
    if (!regional && !sourcePool && !destPool && hotPct < 100) {
      const aliveNodes = allNodes.filter(n => n.alive);
      const poolSize   = Math.max(2, Math.ceil(aliveNodes.length * hotPct / 100));
      hotPool = shuffleSample(aliveNodes, poolSize);
    }

    if (regional && eligibleSenders.length === 0) {
      this.running = false;
      return {
        type: 'lookup', hops: null, time: null,
        totalRuns: 0, successes: 0, failures: numMessages,
        successRate: 0, lastPath: null, hopsRaw: [], timeRaw: [],
      };
    }

    const YIELD_EVERY = 50; // yield every N lookups

    for (let i = 0; i < numMessages; i++) {
      if (!this.running) break;

      const source = regional
        ? eligibleSenders[Math.floor(Math.random() * eligibleSenders.length)]
        : sourcePool
          ? sourcePool[Math.floor(Math.random() * sourcePool.length)]
          : hotPool
            ? hotPool[Math.floor(Math.random() * hotPool.length)]
            : this._randomNode(dht);
      if (!source || !source.alive) { failures++; continue; }

      try {
        let result;
        if (regional) {
          // Pick a receiver within the regional radius and route to its actual
          // node ID using each protocol's native XOR routing.
          const nearby = this._nodesWithinRadius(dht, source, regionalRadius);
          const receiver = nearby[Math.floor(Math.random() * nearby.length)];
          result = await dht.lookup(source.id, receiver.id);
        } else {
          // Pick a target: destPool → hotPool → uniform random.
          let receiver;
          if (destPool) {
            const others = destPool.filter(n => n.id !== source.id && n.alive);
            if (others.length > 0) {
              if (destRandom) {
                // Random selection — used for continent tests where any destination
                // in the target region is equally valid.  Tests the protocol's
                // ability to reach arbitrary far-away nodes, not just the
                // XOR-nearest one.
                receiver = others[Math.floor(Math.random() * others.length)];
              } else {
                // XOR-nearest selection for hot-dest / CDN traffic pattern.
                // Each client reaches its most topologically-accessible popular
                // node; repeated traffic along those same short paths lets N-DHT
                // build dense shortcut webs (the tributary effect).
                const srcId = source.id;
                receiver = others.reduce((best, n) =>
                  (n.id ^ srcId) < (best.id ^ srcId) ? n : best
                );
              }
            } else {
              receiver = this._randomOtherNode(dht, source.id);
            }
          } else if (hotPool) {
            const others = hotPool.filter(n => n.id !== source.id && n.alive);
            receiver = others.length > 0
              ? others[Math.floor(Math.random() * others.length)]
              : this._randomOtherNode(dht, source.id);
          } else {
            receiver = this._randomOtherNode(dht, source.id);
          }
          result = await dht.lookup(source.id, receiver ? receiver.id : randomU64());
        }

        if (result && result.found) {
          hopsArr.push(result.hops);
          timeArr.push(result.time);
          if (captureLastPath && result.path.length > 1) {
            lastPath = result.path;
          }
        } else {
          failures++;
        }
      } catch {
        failures++;
      }

      // Yield & report progress periodically
      if ((i + 1) % YIELD_EVERY === 0) {
        await this._yield();
        if (this.onProgress) {
          this.onProgress((i + 1) / numMessages, this._partialStats(hopsArr, timeArr));
        }
      }
    }

    const result = {
      type: 'lookup',
      hops: computeStats(hopsArr),
      time: computeStats(timeArr),
      totalRuns: numMessages,
      successes: hopsArr.length,
      failures,
      successRate: hopsArr.length / numMessages,
      lastPath,
      hopsRaw: hopsArr,
      timeRaw: timeArr,
    };

    if (!managed) {
      if (this.onComplete) this.onComplete(result);
      if (captureLastPath && lastPath && this.onPathFound) {
        this.onPathFound(lastPath, dht);
      }
      this.running = false;
    }
    return result;
  }

  // ── Benchmark ────────────────────────────────────────────────────────────

  /**
   * Run a multi-protocol, multi-radius benchmark.
   *
   * For each entry in `protocolDefs`, calls `entry.buildFn()` (async) to get a
   * pre-built DHT, then runs lookups at each radius in `radii`.  A radius of 0
   * means global (uniform random pairs).
   *
   * @param {Array<{key:string, label:string, buildFn:()=>Promise<DHT>}>} protocolDefs
   * @param {object}   params
   * @param {object[]} params.testSpecs      - Array of test-cell descriptors:
   *   { type:'regional', radius:number } | { type:'global' } | { type:'dest', pct:number }
   * @param {number}   params.numMessages    - Lookups per cell.
   * @param {Function} params.onStart        - (msg:string) => void  — status before each cell
   * @param {Function} params.onStep         - (msg:string) => void  — called after each cell completes
   * @returns {Promise<object>}  { protocolDefs, testSpecs, data }
   *   data[protocolKey][specKey] = { hops, time, successRate, totalRuns }
   */
  async runBenchmark(protocolDefs, params = {}) {
    const {
      testSpecs = [
        { type: 'regional', radius: 500  },
        { type: 'regional', radius: 1000 },
        { type: 'regional', radius: 2000 },
        { type: 'regional', radius: 5000 },
        { type: 'global' },
      ],
      numMessages = 500,
      landFn      = null,       // () => {lat, lng} — for churn node replacement
      onStart     = () => {},   // (msg) => void — status update only, no progress increment
      onStep      = () => {},   // (msg) => void — called after each cell completes
    } = params;

    // Stable string key and human-readable label for each test spec.
    const specKey   = s => s.type === 'regional'  ? `r${s.radius}`
                         : s.type === 'dest'      ? `dest_${s.pct}`
                         : s.type === 'source'    ? `src_${s.pct}`
                         : s.type === 'srcdest'   ? `srcdest_${s.srcPct}_${s.destPct}`
                         : s.type === 'churn'     ? `churn_${s.rate}`
                         : s.type === 'continent' ? `cont_${s.src}_${s.dst}`
                         : s.type === 'pubsub'    ? 'pubsub'
                         : 'global';
    const specLabel = s => s.type === 'regional'  ? `${s.radius} km`
                         : s.type === 'dest'      ? `${s.pct}% dest`
                         : s.type === 'source'    ? `${s.pct}% src`
                         : s.type === 'srcdest'   ? `${s.srcPct}%→${s.destPct}%`
                         : s.type === 'churn'     ? `${s.rate}% churn`
                         : s.type === 'continent' ? `${s.src}→${s.dst}`
                         : s.type === 'pubsub'    ? 'Pub/Sub'
                         : 'Global';

    this.running = true;
    const data   = {};
    const totalProtos = protocolDefs.length;

    for (let defIdx = 0; defIdx < totalProtos; defIdx++) {
      const def = protocolDefs[defIdx];
      if (!this.running) break;
      data[def.key] = {};
      // Tag prepended to every status message: "N-5 (7/11)"
      const tag = `${def.label} (${defIdx + 1}/${totalProtos})`;

      // Build phase reported by caller via def.buildFn
      const dht = await def.buildFn();
      if (!dht) continue;

      // Optional warmup for protocols that need pre-training (e.g. neuromorphic).
      // Runs a burst of hot-node regional lookups so synaptic weights form before
      // any measurement cells are recorded.  Warmup counts are specified on the
      // protocol def; non-neuromorphic protocols leave warmupLookups undefined/0.
      if (def.warmupLookups > 0) {
        onStart(`${tag} · warming up (${def.warmupLookups.toLocaleString()} regional lookups)…`);
        await this.runLookupTest(dht, {
          numMessages:    def.warmupLookups,
          captureLastPath: false,
          regional:       true,
          regionalRadius: def.warmupRadius ?? 2000,
          hotPct:         def.warmupHotPct ?? 10,
          managed:        true,
        });
      }

      // NX-5+: additional global warmup so learning mechanisms can exercise
      // and repair long-range routes that bootstrap may have missed.
      if (def.warmupGlobalLookups > 0) {
        onStart(`${tag} · global warmup (${def.warmupGlobalLookups.toLocaleString()} lookups)…`);
        await this.runLookupTest(dht, {
          numMessages:    def.warmupGlobalLookups,
          captureLastPath: false,
          regional:       false,
          hotPct:         100,
          managed:        true,
        });
      }

      for (const spec of testSpecs) {
        if (!this.running) break;

        // Build the dest/source pool ONCE per spec so that both the warmup and the
        // measurement run against the EXACT same node set.  This is critical
        // for neuromorphic protocols: the synaptome learns routes toward/from specific
        // nodes during warmup; if the measurement used a different random pool
        // those learned shortcuts would never fire.
        let sharedDestNodes   = null;
        let sharedSourceNodes = null;
        if (spec.type === 'dest') {
          const alive    = dht.getNodes().filter(n => n.alive);
          const poolSize = Math.max(1, Math.ceil(alive.length * spec.pct / 100));
          sharedDestNodes = shuffleSample(alive, poolSize);
        }
        if (spec.type === 'source') {
          const alive    = dht.getNodes().filter(n => n.alive);
          const poolSize = Math.max(1, Math.ceil(alive.length * spec.pct / 100));
          sharedSourceNodes = shuffleSample(alive, poolSize);
        }
        if (spec.type === 'srcdest') {
          const alive       = dht.getNodes().filter(n => n.alive);
          const srcPoolSize = Math.max(1, Math.ceil(alive.length * spec.srcPct / 100));
          const dstPoolSize = Math.max(1, Math.ceil(alive.length * spec.destPct / 100));
          sharedSourceNodes = shuffleSample(alive, srcPoolSize);
          // Destination pool must not overlap with source pool to model the
          // separation between active senders and active receivers.
          const srcSet      = new Set(sharedSourceNodes.map(n => n.id));
          const nonSrc      = alive.filter(n => !srcSet.has(n.id));
          sharedDestNodes   = shuffleSample(nonSrc.length >= dstPoolSize ? nonSrc : alive, dstPoolSize);
        }
        if (spec.type === 'continent') {
          // Pre-compute the full node sets for each continent.  Both pools are used
          // for both warmup and measurement so the synaptome trains on the exact
          // cross-continental routes that will be measured.
          const alive       = dht.getNodes().filter(n => n.alive);
          sharedSourceNodes = alive.filter(n => continentOf(n.lat, n.lng) === spec.src);
          sharedDestNodes   = alive.filter(n => continentOf(n.lat, n.lng) === spec.dst);
        }

        // Dest-specific warmup for neuromorphic protocols.
        if (spec.type === 'dest' && def.warmupLookups > 0) {
          onStart(`${tag} · warming up for ${spec.pct}% dest (${def.warmupLookups.toLocaleString()} lookups)…`);
          await this.runLookupTest(dht, {
            numMessages:    def.warmupLookups,
            captureLastPath: false,
            destNodes:      sharedDestNodes,   // same pool as measurement
            managed:        true,
          });
        }

        // Source-specific warmup for neuromorphic protocols.
        if (spec.type === 'source' && def.warmupLookups > 0) {
          onStart(`${tag} · warming up for ${spec.pct}% src (${def.warmupLookups.toLocaleString()} lookups)…`);
          await this.runLookupTest(dht, {
            numMessages:    def.warmupLookups,
            captureLastPath: false,
            sourceNodes:    sharedSourceNodes,
            managed:        true,
          });
        }

        // Src→Dest combined warmup for neuromorphic protocols.
        if (spec.type === 'srcdest' && def.warmupLookups > 0) {
          onStart(`${tag} · warming up for ${spec.srcPct}%→${spec.destPct}% (${def.warmupLookups.toLocaleString()} lookups)…`);
          await this.runLookupTest(dht, {
            numMessages:    def.warmupLookups,
            captureLastPath: false,
            sourceNodes:    sharedSourceNodes,
            destNodes:      sharedDestNodes,
            managed:        true,
          });
        }

        // Continent-crossing warmup: train the synaptome on trans-continental
        // routes before measurement so long-range strata can build shortcuts.
        if (spec.type === 'continent' && def.warmupLookups > 0) {
          onStart(`${tag} · warming up for ${spec.src}→${spec.dst} (${def.warmupLookups.toLocaleString()} lookups)…`);
          await this.runLookupTest(dht, {
            numMessages:    def.warmupLookups,
            captureLastPath: false,
            sourceNodes:    sharedSourceNodes,
            destNodes:      sharedDestNodes,
            destRandom:     true,   // any destination in the target continent is valid
            managed:        true,
          });
        }

        // ── Churn rounds (applied before final measurement, always last spec) ──
        if (spec.type === 'churn') {
          const CHURN_ROUNDS  = 5;
          const rate          = (spec.rate ?? 5) / 100;
          const getLandPoint  = landFn ?? (() => randomLandPoint(null));
          // Adapt lookups between rounds for neuromorphic protocols.
          // Scale to warmupLookups / CHURN_ROUNDS so per-round density matches
          // the original warmup density — critical at high node counts where
          // 100 fixed lookups cover only a tiny fraction of replaced nodes.
          const ADAPT_LOOKUPS = def.warmupLookups > 0
            ? Math.max(100, Math.round(def.warmupLookups / CHURN_ROUNDS))
            : 0;

          for (let round = 0; round < CHURN_ROUNDS; round++) {
            if (!this.running) break;
            onStart(`${tag} · churn round ${round + 1}/${CHURN_ROUNDS} (${spec.rate}% turnover)…`);

            const alive = dht.getNodes().filter(n => n.alive);
            const numToReplace = Math.max(1, Math.floor(alive.length * rate));
            for (const node of shuffleSample(alive, numToReplace)) {
              await dht.removeNode(node.id);
            }
            // Add replacement nodes — each performs a realistic iterative
            // bootstrap join through a random live sponsor, discovering the
            // network the same way a real node would (no omniscient sorted
            // array).  The sponsor is picked randomly from the live set.
            const liveAfterRemoval = dht.getNodes().filter(n => n.alive);
            for (let i = 0; i < numToReplace; i++) {
              const { lat, lng } = getLandPoint();
              const newNode = await dht.addNode(lat, lng);
              // Pick a random live sponsor for the iterative join.
              const sponsor = liveAfterRemoval[
                Math.floor(Math.random() * liveAfterRemoval.length)
              ];
              if (sponsor && typeof dht.bootstrapJoin === 'function') {
                dht.bootstrapJoin(newNode.id, sponsor.id);
              }
            }

            // NX-12+: Second-pass re-heal — repair any synapses whose
            // first-pass replacement was also churned in this same batch.
            if (typeof dht.postChurnHeal === 'function') {
              dht.postChurnHeal();
            }

            // Neuromorphic protocols get adaptation lookups between rounds
            // so synaptic weights can adjust to the changed topology.
            if (ADAPT_LOOKUPS > 0 && round < CHURN_ROUNDS - 1) {
              await this.runLookupTest(dht, {
                numMessages:    ADAPT_LOOKUPS,
                captureLastPath: false,
                managed:        true,
              });
            }
            await this._yield();
          }
        }

        // ── Pub/Sub measurement ─────────────────────────────────────────────
        // Pub/sub is handled entirely here; skip the normal runLookupTest path.
        if (spec.type === 'pubsub') {
          const groupSize = spec.groupSize ?? 32;
          const coverage  = spec.coverage  ?? 10;

          // Build concordance groups using the same staggered-stride strategy
          // as the interactive pub/sub test so routing patterns are consistent.
          const aliveNodes  = dht.getNodes().filter(n => n.alive);
          const targetNodes = Math.ceil(aliveNodes.length * coverage / 100);
          const numGroups   = Math.max(1, Math.ceil(targetNodes / groupSize));
          const shuffled    = [...aliveNodes].sort(() => Math.random() - 0.5);
          const stride      = Math.max(1, Math.floor(shuffled.length / numGroups));

          const groups = [];
          for (let i = 0; i < numGroups; i++) {
            const base         = (i * stride) % shuffled.length;
            const relay        = shuffled[base];
            const participants = [];
            for (let j = 1; j <= groupSize; j++) {
              participants.push(shuffled[(base + j) % shuffled.length]);
            }
            groups.push({ id: i, relay, participants });
          }

          // Pub/sub warmup: 2× the standard warmup budget, using actual pub/sub
          // ticks so the synaptome learns relay→participant routes specifically.
          if (def.warmupLookups > 0) {
            const warmupTicks = Math.ceil((def.warmupLookups * 2) / (groupSize + 1));
            onStart(`${tag} · pub/sub warmup (${warmupTicks} ticks)…`);
            for (let t = 0; t < warmupTicks; t++) {
              if (!this.running) break;
              await this.runPubSubTick(dht, groups);
            }
          }

          // Measurement: enough ticks to match the lookup count of other cells.
          const measTicks = Math.max(10, Math.ceil(numMessages / (groupSize + 1)));
          onStart(`${tag} · Pub/Sub (${measTicks} ticks)…`);

          const allMsgHops      = [];
          const allMsgMs        = [];
          const allBcastHops    = [];
          const allBcastMs      = [];
          const allMaxFanout    = [];
          const allAvgSubs      = [];
          let   maxTreeDepth    = 0;
          for (let t = 0; t < measTicks; t++) {
            if (!this.running) break;
            const tick = await this.runPubSubTick(dht, groups);
            if (!tick) continue;
            allMsgHops.push(tick.msgHops);
            if (tick.msgMs > 0) allMsgMs.push(tick.msgMs);
            allBcastHops.push(...tick.bcastHops);
            if (tick.bcastMsStats?.mean != null) allBcastMs.push(tick.bcastMsStats.mean);
            if (tick.maxNodeLookups != null) allMaxFanout.push(tick.maxNodeLookups);
            if (tick.avgSubsPerNode != null) allAvgSubs.push(tick.avgSubsPerNode);
            if (tick.treeDepth != null) maxTreeDepth = Math.max(maxTreeDepth, tick.treeDepth);
          }

          data[def.key]['pubsub'] = {
            msgHops:       computeStats(allMsgHops),
            msgMs:         computeStats(allMsgMs),
            bcastHops:     computeStats(allBcastHops),
            bcastMs:       computeStats(allBcastMs),
            maxFanout:     computeStats(allMaxFanout),
            avgSubsPerNode: computeStats(allAvgSubs),
            treeDepth:     maxTreeDepth,
            numGroups,
            totalTicks:    measTicks,
          };
          onStep(`${tag} · Pub/Sub ✓`);
          continue; // skip the normal runLookupTest path
        }

        // ── Pub/Sub Membership measurement (NX-15+) ─────────────────────────
        // Drives the AxonManager-based membership protocol rather than the
        // inherited one-shot pubsubBroadcast. Each participant in every
        // group subscribes via a PubSubAdapter; each tick, the relay
        // publishes via its own adapter; we count deliveries per-group and
        // inspect the resulting axon tree. Only supported on DHTs that
        // expose `axonFor` (NX-15 and descendants).
        if (spec.type === 'pubsubm') {
          if (typeof dht.axonFor !== 'function') {
            data[def.key]['pubsubm'] = {
              unsupported: true,
              reason:      'protocol does not expose axonFor()',
            };
            onStep(`${tag} · Pub/Sub (Membership) — n/a`);
            continue;
          }

          const groupSize = spec.groupSize ?? 32;
          const coverage  = spec.coverage  ?? 10;

          const aliveNodes  = dht.getNodes().filter(n => n.alive);
          const targetNodes = Math.ceil(aliveNodes.length * coverage / 100);
          const numGroups   = Math.max(1, Math.ceil(targetNodes / groupSize));
          const shuffled    = [...aliveNodes].sort(() => Math.random() - 0.5);
          const stride      = Math.max(1, Math.floor(shuffled.length / numGroups));

          const groups = [];
          for (let i = 0; i < numGroups; i++) {
            const base         = (i * stride) % shuffled.length;
            const relay        = shuffled[base];
            const participants = [];
            for (let j = 1; j <= groupSize; j++) {
              participants.push(shuffled[(base + j) % shuffled.length]);
            }
            groups.push({ id: i, relay, participants });
          }

          // Pre-register an AxonManager on every live node. The membership
          // protocol needs a handler on whichever node happens to be the
          // terminal (closest to hash(topic)) for each group's topic —
          // otherwise the routed subscribe walks all the way to terminal
          // and silently fizzles because no handler intercepts it. We
          // can't know in advance which node the hash will land on, so we
          // blanket-register. Handler/state footprint is ~1 KB per node.
          for (const node of aliveNodes) dht.axonFor(node);

          // Set up one PubSubAdapter per distinct node (relay or participant).
          // `entries.get(nodeId) = { adapter, deliveries: Map<groupId, bool> }`.
          // We subscribe each participant to its own group's topic and
          // install a per-group callback that flips the delivery bit when
          // a publish arrives.
          const entries = new Map();
          const getEntry = (node) => {
            let e = entries.get(node.id);
            if (e) return e;
            e = { node, adapter: new PubSubAdapter({ transport: dht.axonFor(node) }), deliveries: new Map() };
            entries.set(node.id, e);
            return e;
          };

          for (const group of groups) {
            const gKey = 'g' + group.id;
            for (const p of group.participants) {
              const entry = getEntry(p);
              entry.deliveries.set(group.id, false);
              // Capture by-group delivery via the subscribe callback.
              entry.adapter.subscribe('bench', gKey,
                () => { entry.deliveries.set(group.id, true); }, 'immediate');
            }
            // Publisher adapter (may be different node than any participant).
            getEntry(group.relay);
          }

          // Short warmup — let the tree stabilise before we start counting.
          const warmupTicks = 3;
          onStart(`${tag} · Pub/Sub (Membership) warmup (${warmupTicks} ticks)…`);
          const runOneTick = () => {
            // Reset per-group delivery bits.
            for (const e of entries.values()) {
              for (const gid of e.deliveries.keys()) e.deliveries.set(gid, false);
            }
            // Publish on each group (synchronous under NX-15 — no await needed).
            for (const group of groups) {
              const gKey = 'g' + group.id;
              getEntry(group.relay).adapter.publish('bench', gKey, {});
            }
          };
          for (let t = 0; t < warmupTicks; t++) { if (!this.running) break; runOneTick(); }

          const measTicks = Math.max(10, Math.ceil(numMessages / (groupSize + 1)));
          onStart(`${tag} · Pub/Sub (Membership) (${measTicks} ticks)…`);

          const perTickDeliveredPct = [];
          const perTickAxonRoles    = [];
          const perTickMaxChildren  = [];
          const perTickTreeDepth    = [];
          for (let t = 0; t < measTicks; t++) {
            if (!this.running) break;
            runOneTick();

            // Count per-group delivery rate for this tick.
            let delivered = 0, expected = 0;
            for (const group of groups) {
              for (const p of group.participants) {
                expected++;
                if (entries.get(p.id).deliveries.get(group.id)) delivered++;
              }
            }
            perTickDeliveredPct.push(expected === 0 ? 100 : (delivered / expected) * 100);

            // Inspect the network's axon roles for each topic.
            let totalRoles = 0, maxChildren = 0, maxDepth = 1;
            for (const group of groups) {
              const topicId = topicIdFor('bench', 'g' + group.id);
              for (const axon of dht._axonsByNode.values()) {
                const role = axon.axonRoles.get(topicId);
                if (!role) continue;
                totalRoles++;
                maxChildren = Math.max(maxChildren, role.children.size);
                if (!role.isRoot) maxDepth = Math.max(maxDepth, 2); // simple depth proxy
              }
            }
            perTickAxonRoles.push(totalRoles);
            perTickMaxChildren.push(maxChildren);
            perTickTreeDepth.push(maxDepth);
          }

          data[def.key]['pubsubm'] = {
            deliveredPct:  computeStats(perTickDeliveredPct),
            axonRoles:     computeStats(perTickAxonRoles),
            maxChildren:   computeStats(perTickMaxChildren),
            treeDepth:     Math.max(...perTickTreeDepth, 1),
            numGroups,
            groupSize,
            totalTicks:    measTicks,
          };
          onStep(`${tag} · Pub/Sub (Membership) ✓`);
          continue;
        }

        // ── Pub/Sub Membership + Churn (NX-15+) ─────────────────────────────
        // Measures how K-closest replication + TTL/refresh holds up when a
        // fraction of nodes die mid-test. Three phases produce three
        // independent delivery-rate numbers:
        //
        //   baseline  — steady-state delivery before any churn
        //   immediate — delivery right after killing `rate`% of nodes,
        //               before any refresh cycles run (measures raw
        //               resilience from K-fold replication alone)
        //   recovered — delivery after driving refresh ticks across all
        //               surviving axons (measures whether TTL/refresh +
        //               K-closest drift-tracking heal the tree)
        //
        // Dead subscribers are excluded from the denominator — the
        // question is "do surviving subscribers still get messages?",
        // not "can dead nodes receive publishes?" (obviously no).
        if (spec.type === 'pubsubmchurn') {
          if (typeof dht.axonFor !== 'function') {
            data[def.key]['pubsubmchurn'] = { unsupported: true };
            onStep(`${tag} · Pub/Sub (Membership+Churn) — n/a`);
            continue;
          }

          const groupSize = spec.groupSize ?? 32;
          const coverage  = spec.coverage  ?? 10;
          const churnRate = spec.rate      ?? 25;

          const aliveNodes  = dht.getNodes().filter(n => n.alive);
          const targetNodes = Math.ceil(aliveNodes.length * coverage / 100);
          const numGroups   = Math.max(1, Math.ceil(targetNodes / groupSize));
          const shuffled    = [...aliveNodes].sort(() => Math.random() - 0.5);
          const stride      = Math.max(1, Math.floor(shuffled.length / numGroups));

          const groups = [];
          for (let i = 0; i < numGroups; i++) {
            const base         = (i * stride) % shuffled.length;
            const relay        = shuffled[base];
            const participants = [];
            for (let j = 1; j <= groupSize; j++) {
              participants.push(shuffled[(base + j) % shuffled.length]);
            }
            groups.push({ id: i, relay, participants });
          }

          // Pre-register axons on every live node (same reason as pubsubm).
          for (const node of aliveNodes) dht.axonFor(node);

          // Subscribe every participant and install per-group delivery bits.
          const entries = new Map();
          const getEntry = (node) => {
            let e = entries.get(node.id);
            if (e) return e;
            e = { node, adapter: new PubSubAdapter({ transport: dht.axonFor(node) }),
                  deliveries: new Map() };
            entries.set(node.id, e);
            return e;
          };
          for (const group of groups) {
            const gKey = 'g' + group.id;
            for (const p of group.participants) {
              const entry = getEntry(p);
              entry.deliveries.set(group.id, false);
              entry.adapter.subscribe('bench', gKey,
                () => { entry.deliveries.set(group.id, true); }, 'immediate');
            }
            getEntry(group.relay);
          }

          const runOneTick = () => {
            for (const e of entries.values()) {
              if (!e.node.alive) continue;
              for (const gid of e.deliveries.keys()) e.deliveries.set(gid, false);
            }
            for (const group of groups) {
              if (!group.relay.alive) continue;
              const gKey = 'g' + group.id;
              getEntry(group.relay).adapter.publish('bench', gKey, {});
            }
          };
          const measureDeliveredPct = () => {
            let delivered = 0, expected = 0;
            for (const group of groups) {
              for (const p of group.participants) {
                if (!p.alive) continue;          // exclude dead subs from denominator
                expected++;
                if (entries.get(p.id).deliveries.get(group.id)) delivered++;
              }
            }
            return expected === 0 ? 100 : (delivered / expected) * 100;
          };

          // Phase 1: warmup (let tree stabilise).
          onStart(`${tag} · Pub/Sub+Churn · warmup…`);
          for (let t = 0; t < 3; t++) { if (!this.running) break; runOneTick(); }

          // Phase 2: baseline measurement.
          onStart(`${tag} · Pub/Sub+Churn · baseline…`);
          const baselineTicks = 5;
          const baseline = [];
          for (let t = 0; t < baselineTicks; t++) {
            if (!this.running) break;
            runOneTick();
            baseline.push(measureDeliveredPct());
          }

          // Phase 3: kill churnRate% of nodes. Exclude relays so publishes
          // can keep firing (we're testing subscriber/axon churn, not
          // publisher failure — publisher failure is a separate concern).
          const publisherIds = new Set(groups.map(g => g.relay.id));
          const killable = aliveNodes.filter(n => !publisherIds.has(n.id));
          killable.sort(() => Math.random() - 0.5);
          const killTarget = Math.floor(aliveNodes.length * churnRate / 100);
          const numKilled = Math.min(killTarget, killable.length);
          for (let i = 0; i < numKilled; i++) killable[i].alive = false;
          onStart(`${tag} · Pub/Sub+Churn · killed ${numKilled} of ${aliveNodes.length}…`);

          // Phase 4: immediate post-churn measurement (no refresh yet).
          const immediate = [];
          for (let t = 0; t < 5; t++) {
            if (!this.running) break;
            runOneTick();
            immediate.push(measureDeliveredPct());
          }

          // Phase 5: drive refresh cycles so TTL sweeps + re-STOREs can heal
          // the tree. Multiple rounds let cascading effects settle.
          for (let r = 0; r < 3; r++) {
            for (const node of aliveNodes) {
              if (!node.alive) continue;
              const axon = dht.axonFor(node);
              axon.refreshTick();
            }
          }

          // Phase 6: post-recovery measurement.
          const recovered = [];
          for (let t = 0; t < 5; t++) {
            if (!this.running) break;
            runOneTick();
            recovered.push(measureDeliveredPct());
          }

          data[def.key]['pubsubmchurn'] = {
            baseline:       computeStats(baseline),
            immediate:      computeStats(immediate),
            recovered:      computeStats(recovered),
            killedCount:    numKilled,
            totalNodes:     aliveNodes.length,
            churnRate,
            numGroups,
            groupSize,
          };
          onStep(`${tag} · Pub/Sub+Churn ✓`);
          continue;
        }

        const cellLabel = `${tag} · ${specLabel(spec)}`;
        onStart(`${cellLabel}…`);

        const result = await this.runLookupTest(dht, {
          numMessages,
          captureLastPath: false,
          regional:        spec.type === 'regional',
          regionalRadius:  spec.type === 'regional' ? spec.radius : 2000,
          destNodes:       sharedDestNodes,    // pre-built pool (null for non-dest/source specs)
          sourceNodes:     sharedSourceNodes,  // pre-built pool (null for non-source specs)
          destRandom:      spec.type === 'continent', // random dst for continent, XOR-nearest for dest
          hotPct:          100,
          managed:         true,  // don't let runLookupTest reset this.running
        });

        data[def.key][specKey(spec)] = {
          hops:        result.hops,
          time:        result.time,
          successRate: result.successRate,
          totalRuns:   result.totalRuns,
        };

        onStep(`${cellLabel} ✓`);
      }

      // Explicitly release all node/synapse memory before building the next
      // protocol's DHT.  Without this, V8 may not GC the old DHT before the
      // new one is fully built, briefly doubling memory usage — fatal at 50k+
      // nodes where a single protocol's synaptome can approach the heap limit.
      dht.dispose?.();
      await this._yield(); // give the GC a chance to collect before next build
    }

    this.running = false;
    return { protocolDefs, testSpecs, data };
  }

  // ── Churn Test ───────────────────────────────────────────────────────────

  /**
   * Simulate node churn while continuously running lookups.
   *
   * @param {import('../dht/DHT.js').DHT} dht
   * @param {object} params
   * @param {number} params.churnRate         - Fraction of nodes replaced per interval (0–1)
   * @param {number} params.intervals         - Number of churn intervals to simulate
   * @param {number} params.lookupsPerInterval
   * @param {Function} params.landFn          - (lat,lng)=>bool  land detector
   * @param {number[]} params.landBbox        - [minLat, maxLat, minLng, maxLng]
   * @returns {Promise<ChurnTestResult>}
   */
  async runChurnTest(dht, params = {}) {
    const {
      churnRate = 0.05,
      intervals = 10,
      lookupsPerInterval = 100,
      landFn = null,
    } = params;

    this.running = true;
    const timeSeries = [];

    for (let interval = 0; interval < intervals; interval++) {
      if (!this.running) break;

      // ── Apply churn ────────────────────────────────────────────────────
      const nodes = dht.getNodes().filter(n => n.alive);
      const numToReplace = Math.max(1, Math.floor(nodes.length * churnRate));

      // Remove random nodes
      const toRemove = shuffleSample(nodes, numToReplace);
      for (const node of toRemove) {
        await dht.removeNode(node.id);
      }

      // Add replacement nodes — realistic iterative bootstrap join
      const liveAfterRemoval = dht.getNodes().filter(n => n.alive);
      for (let i = 0; i < numToReplace; i++) {
        const { lat, lng } = randomLandPoint(landFn);
        const newNode = await dht.addNode(lat, lng);
        const sponsor = liveAfterRemoval[
          Math.floor(Math.random() * liveAfterRemoval.length)
        ];
        if (sponsor && typeof dht.bootstrapJoin === 'function') {
          dht.bootstrapJoin(newNode.id, sponsor.id);
        }
      }

      // ── Run lookups ────────────────────────────────────────────────────
      const hopsArr = [];
      const timeArr = [];
      let failures = 0;

      for (let i = 0; i < lookupsPerInterval; i++) {
        const source = this._randomNode(dht);
        if (!source) { failures++; continue; }
        try {
          const receiver = this._randomOtherNode(dht, source.id);
          const result = await dht.lookup(source.id, receiver ? receiver.id : randomU64());
          if (result && result.found) {
            hopsArr.push(result.hops);
            timeArr.push(result.time);
          } else {
            failures++;
          }
        } catch {
          failures++;
        }
      }

      const entry = {
        interval,
        nodeCount: dht.getNodes().filter(n => n.alive).length,
        nodesReplaced: numToReplace,
        hops: computeStats(hopsArr),
        time: computeStats(timeArr),
        successRate: hopsArr.length / lookupsPerInterval,
        failures,
      };
      timeSeries.push(entry);

      await this._yield();
      if (this.onProgress) {
        this.onProgress((interval + 1) / intervals, { timeSeries });
      }
    }

    const result = { type: 'churn', timeSeries };
    if (this.onComplete) this.onComplete(result);
    this.running = false;
    return result;
  }

  // ── Pair Learning Session ────────────────────────────────────────────────

  /**
   * Run one pair-learning session: every source node routes a lookup to its
   * fixed assigned target.  Repeated sessions drive neuromorphic shortcut
   * formation so hop counts trend toward 1.
   *
   * @param {object}   dht
   * @param {Array<{srcId:number, dstId:number}>} pairs  – fixed pairings built at test start
   * @returns {Promise<{hops, time, hopsRaw, timeRaw, successCount}>}
   */
  async runPairSession(dht, pairs) {
    const hopsArr  = [];
    const timeArr  = [];
    const nodeMap  = new Map(dht.getNodes().map(n => [n.id, n]));
    const YIELD_EVERY = 50;

    for (let i = 0; i < pairs.length; i++) {
      const { srcId, dstId } = pairs[i];
      const src = nodeMap.get(srcId);
      if (!src?.alive) continue;                  // skip dead senders

      try {
        const r = await dht.lookup(srcId, dstId);
        if (r?.found) {
          hopsArr.push(r.hops);
          timeArr.push(r.time);
        }
      } catch { /* skip failed lookups */ }

      if ((i + 1) % YIELD_EVERY === 0) await this._yield();
    }

    return {
      hops:         computeStats(hopsArr),
      time:         computeStats(timeArr),
      hopsRaw:      hopsArr,
      timeRaw:      timeArr,
      successCount: hopsArr.length,
    };
  }

  // ── Pub/Sub Tick ─────────────────────────────────────────────────────────

  /**
   * Run one pub/sub message cycle across a set of concordance groups.
   * A random participant from a random group sends to its relay; the relay
   * broadcasts back to all participants in that group.
   *
   * @param {object}   dht    – the active DHT instance
   * @param {object[]} groups – array of { id, relay, participants[] }
   * @returns {Promise<object|null>} tick stats, or null if no alive nodes found
   */
  async runPubSubTick(dht, groups) {
    const YIELD_EVERY = 8;

    // Pick a random group with a live relay
    const liveGroups = groups.filter(g => g.relay.alive);
    if (!liveGroups.length) return null;
    const group = liveGroups[Math.floor(Math.random() * liveGroups.length)];
    const { relay, participants } = group;

    // Pick a random live participant as message sender
    const alive = participants.filter(p => p.alive);
    if (!alive.length) return null;
    const sender = alive[Math.floor(Math.random() * alive.length)];

    // sender → relay
    let msgHops = null;
    let msgMs   = null;
    try {
      const r = await dht.lookup(sender.id, relay.id);
      if (r?.found) {
        msgHops = r.hops;
        msgMs   = Math.round(r.time);   // per-hop geographic RTT, same as all other tests
      }
    } catch { /* skip */ }

    // relay → all participants (broadcast)
    const bcastHops  = [];
    const bcastMsArr = [];
    const targets    = alive.filter(p => p.id !== sender.id).map(p => p.id);

    let maxNodeLookups = targets.length;  // flat default: relay does all lookups
    let treeDepth      = 0;               // flat default: no tree
    let avgSubsPerNode = targets.length;  // flat default: all on relay

    if (typeof dht.pubsubBroadcast === 'function' && targets.length > 0) {
      // Tree-based broadcast: one call handles the full fan-out
      try {
        const result = await dht.pubsubBroadcast(relay.id, targets);
        bcastHops.push(...result.hops);
        bcastMsArr.push(...result.times);
        if (result.maxNodeLookups != null) maxNodeLookups = result.maxNodeLookups;
        if (result.treeDepth != null) treeDepth = result.treeDepth;
        if (result.avgSubsPerNode != null) avgSubsPerNode = result.avgSubsPerNode;
      } catch { /* skip */ }
    } else {
      // Standard flat broadcast: one lookup per participant
      for (let i = 0; i < alive.length; i++) {
        const p = alive[i];
        if (p.id === sender.id) continue; // sender already reached relay
        try {
          const r = await dht.lookup(relay.id, p.id);
          if (r?.found) {
            bcastHops.push(r.hops);
            bcastMsArr.push(Math.round(r.time));  // per-hop geographic RTT
          }
        } catch { /* skip */ }
        if ((i + 1) % YIELD_EVERY === 0) await this._yield();
      }
    }

    const bcastStats  = computeStats(bcastHops);
    const bcastMsStats = computeStats(bcastMsArr);
    const totalHops   = (msgHops ?? 0) + bcastHops.reduce((a, b) => a + b, 0);

    return {
      groupId:        group.id,
      senderId:       sender.id,
      relayId:        relay.id,
      relayNode:      relay,          // full node object (lat/lng) for globe positioning
      participantNodes: alive,        // alive participants for globe highlighting
      msgHops,
      msgMs,
      bcastStats,
      bcastHops,
      bcastMsArr,    // raw per-participant ms values (used by runPubSubSession)
      bcastMsStats,
      totalHops,
      maxNodeLookups,                 // max lookups by any single node in this broadcast
      treeDepth,                       // dendritic tree depth (0 for flat)
      avgSubsPerNode,                  // avg subscribers per branch node
      simMs: (msgMs ?? 0) + Math.round((bcastMsStats?.mean ?? 0)),
    };
  }

  // ── Pub/Sub Session ───────────────────────────────────────────────────────

  /**
   * Run one pub/sub SESSION consisting of `messagesPerSession` independent
   * message/broadcast cycles. Each cycle picks a random sender from a random
   * group, routes sender → relay, then broadcasts relay → all participants.
   *
   * Returns the grand average across all cycles so callers get a stable,
   * low-noise measurement per session:
   *
   *   relayHops  = mean of messagesPerSession relay hop counts
   *   relayMs    = mean of messagesPerSession relay RTTs
   *   bcastHops  = mean over all (messagesPerSession × groupSize) bcast hops
   *   bcastMs    = mean over all (messagesPerSession × groupSize) bcast RTTs
   *
   * @param {object}   dht               – active DHT instance
   * @param {object[]} groups            – array of { id, relay, participants[] }
   * @param {number}   [messagesPerSession=10]
   * @returns {Promise<object|null>}
   */
  async runPubSubSession(dht, groups, messagesPerSession = 10) {
    const allRelayHops = [];
    const allRelayMs   = [];
    const allBcastHops = [];
    const allBcastMs   = [];
    const allMaxFanout = [];
    const allAvgSubs   = [];
    let   maxTreeDepth  = 0;
    let lastRelayNode        = null;
    let lastParticipantNodes = null;

    for (let m = 0; m < messagesPerSession; m++) {
      const tick = await this.runPubSubTick(dht, groups);
      if (!tick) continue;
      if (tick.msgHops != null) allRelayHops.push(tick.msgHops);
      if (tick.msgMs   != null) allRelayMs.push(tick.msgMs);
      allBcastHops.push(...tick.bcastHops);
      allBcastMs.push(...tick.bcastMsArr);
      if (tick.maxNodeLookups != null) allMaxFanout.push(tick.maxNodeLookups);
      if (tick.avgSubsPerNode != null) allAvgSubs.push(tick.avgSubsPerNode);
      if (tick.treeDepth != null) maxTreeDepth = Math.max(maxTreeDepth, tick.treeDepth);
      lastRelayNode        = tick.relayNode;
      lastParticipantNodes = tick.participantNodes;
    }

    if (!allRelayHops.length) return null;

    const mean = arr => arr.reduce((a, b) => a + b, 0) / arr.length;

    return {
      relayHops:         mean(allRelayHops),
      relayMs:           Math.round(mean(allRelayMs)),
      bcastHops:         allBcastHops.length ? mean(allBcastHops) : 0,
      bcastMs:           allBcastMs.length   ? Math.round(mean(allBcastMs)) : 0,
      maxFanout:         allMaxFanout.length ? Math.round(mean(allMaxFanout)) : null,
      avgSubsPerNode:    allAvgSubs.length   ? mean(allAvgSubs) : null,
      treeDepth:         maxTreeDepth,
      lastRelayNode,
      lastParticipantNodes,
      messagesPerSession,
      totalBcasts:       allBcastHops.length,
    };
  }

  /**
   * Bootstrap a newly joined node into the DHT's routing tables.
   * For Kademlia: add the new node to every existing node's bucket (if it fits),
   * and populate the new node's own buckets from existing nodes.
   */
  // sorted: pre-sorted (by id) array of live nodes, built once per churn round.
  _bootstrapNode(newNode, sorted, k = 20) {
    if (typeof newNode.addToBucket !== 'function') return;
    if (!sorted?.length) return;

    // Use buildXorRoutingTable (O(k·log N)) — fills only the K-closest peers
    // per XOR bucket, matching real Kademlia self-lookup semantics.
    // Respect the node's global connection cap when selecting initial peers.
    const maxConn = newNode.maxConnections ?? Infinity;
    for (const peer of buildXorRoutingTable(newNode.id, sorted, k, maxConn)) {
      newNode.addToBucket(peer);
      peer.addToBucket(newNode);
    }
  }

  // ── Hotspot Test ─────────────────────────────────────────────────────────

  /**
   * Gini coefficient of an array of non-negative numbers.
   * 0 = perfectly equal, 1 = one entity holds everything.
   */
  _gini(values) {
    const n = values.length;
    if (!n) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const sum = sorted.reduce((s, v) => s + v, 0);
    if (!sum) return 0;
    let num = 0;
    for (let i = 0; i < n; i++) num += (2 * (i + 1) - n - 1) * sorted[i];
    return num / (n * sum);
  }

  /**
   * Build Lorenz curve data from a raw frequency array.
   * Returns { xs, ys } – both 0–100 arrays for Chart.js.
   * Nodes ranked from least-loaded to most-loaded on X axis.
   */
  _lorenz(values) {
    const sorted = [...values].sort((a, b) => a - b);
    const total  = sorted.reduce((s, v) => s + v, 0);
    const n      = sorted.length;
    const xs = [0], ys = [0];
    let cum = 0;
    for (let i = 0; i < n; i++) {
      cum += sorted[i];
      xs.push(((i + 1) / n) * 100);
      ys.push(total ? (cum / total) * 100 : ((i + 1) / n) * 100);
    }
    return { xs, ys };
  }

  /**
   * Run the two-phase Hotspot Test.
   *
   * Phase 1 — Highway: random lookups; track which nodes act as intermediate
   *   relay hops.  Measures routing-load concentration across nodes.
   *
   * Phase 2 — Storage: Zipf-distributed queries to a fixed content-item set;
   *   tracks destination query concentration.  Models popular-content hotspots.
   *
   * @param {object} dht
   * @param {object} params
   * @param {number} params.warmupLookups    – train neuromorphic nets before measuring
   * @param {number} params.numLookups       – highway-phase query count
   * @param {number} params.contentCount     – number of unique content items
   * @param {number} params.zipfExponent     – Zipf skew (0=uniform, 1=classic, 2=extreme)
   * @param {number} params.contentLookups   – storage-phase query count
   * @returns {Promise<{highway, storage}>}
   */
  async runHotspotTest(dht, params = {}) {
    const {
      warmupLookups  = 0,
      numLookups     = 1000,
      contentCount   = 50,
      zipfExponent   = 1.0,
      contentLookups = 1000,
    } = params;

    this.running = true;
    const YIELD_EVERY = 50;
    const totalOps = warmupLookups + numLookups + contentLookups;

    // ── Warmup ─────────────────────────────────────────────────────────────
    for (let i = 0; i < warmupLookups && this.running; i++) {
      const src = this._randomNode(dht);
      const dst = src ? this._randomOtherNode(dht, src.id) : null;
      if (src && dst) {
        try { await dht.lookup(src.id, dst.id); } catch { /* skip */ }
      }
      if ((i + 1) % YIELD_EVERY === 0) {
        this.onProgress?.((i + 1) / totalOps, { phase: 'warmup', done: i + 1, total: warmupLookups });
        await this._yield();
      }
    }

    // ── Phase 1: Highway hotspot ────────────────────────────────────────────
    const transitCounts  = new Map();   // nodeId → transit-hop count
    let   hwSuccesses    = 0;

    for (let i = 0; i < numLookups && this.running; i++) {
      const src = this._randomNode(dht);
      const dst = src ? this._randomOtherNode(dht, src.id) : null;
      if (!src || !dst) continue;

      try {
        const r = await dht.lookup(src.id, dst.id);
        if (r?.found && r.path?.length > 2) {
          hwSuccesses++;
          // intermediate hops only (not source=path[0], not dest=path[last])
          for (let j = 1; j < r.path.length - 1; j++) {
            const id = r.path[j];
            transitCounts.set(id, (transitCounts.get(id) ?? 0) + 1);
          }
        }
      } catch { /* skip */ }

      if ((i + 1) % YIELD_EVERY === 0) {
        this.onProgress?.((warmupLookups + i + 1) / totalOps,
          { phase: 'highway', done: i + 1, total: numLookups });
        await this._yield();
      }
    }

    const allNodes      = dht.getNodes().filter(n => n.alive);
    const transitValues = allNodes.map(n => transitCounts.get(n.id) ?? 0);
    const totalTransits = transitValues.reduce((s, v) => s + v, 0);
    const sortedTrans   = [...transitValues].sort((a, b) => b - a);
    const n1  = Math.max(1, Math.ceil(allNodes.length * 0.01));
    const n10 = Math.max(1, Math.ceil(allNodes.length * 0.10));
    const top1pctLoad  = totalTransits
      ? sortedTrans.slice(0, n1).reduce((s, v) => s + v, 0)  / totalTransits : 0;
    const top10pctLoad = totalTransits
      ? sortedTrans.slice(0, n10).reduce((s, v) => s + v, 0) / totalTransits : 0;

    const highwayResult = {
      gini:          this._gini(transitValues),
      top1pctLoad,
      top10pctLoad,
      maxLoad:       sortedTrans[0] ?? 0,
      totalTransits,
      successRate:   hwSuccesses / Math.max(1, numLookups),
      lorenz:        this._lorenz(transitValues),
      numNodes:      allNodes.length,
    };

    // ── Phase 2: Storage hotspot ────────────────────────────────────────────
    // Select contentCount random nodes as content holders
    const shuffled = [...allNodes].sort(() => Math.random() - 0.5);
    const contentNodes = shuffled.slice(0, Math.min(contentCount, shuffled.length));

    // Precompute Zipf cumulative weights
    const weights = contentNodes.map((_, i) => 1 / Math.pow(i + 1, Math.max(0.01, zipfExponent)));
    const wSum    = weights.reduce((s, w) => s + w, 0);
    const cumW    = [];
    let acc = 0;
    for (const w of weights) { acc += w / wSum; cumW.push(acc); }

    const destCounts   = new Map();
    let   stSuccesses  = 0;

    for (let i = 0; i < contentLookups && this.running; i++) {
      // Zipf-sample a content target
      const r    = Math.random();
      const idx  = cumW.findIndex(c => c >= r);
      const target = contentNodes[idx >= 0 ? idx : contentNodes.length - 1];
      const src    = this._randomOtherNode(dht, target.id);
      if (!src) continue;

      try {
        const res = await dht.lookup(src.id, target.id);
        if (res?.found) {
          stSuccesses++;
          destCounts.set(target.id, (destCounts.get(target.id) ?? 0) + 1);
        }
      } catch { /* skip */ }

      if ((i + 1) % YIELD_EVERY === 0) {
        this.onProgress?.((warmupLookups + numLookups + i + 1) / totalOps,
          { phase: 'storage', done: i + 1, total: contentLookups });
        await this._yield();
      }
    }

    const destValues       = contentNodes.map(n => destCounts.get(n.id) ?? 0);
    const totalDest        = destValues.reduce((s, v) => s + v, 0);
    const sortedDest       = [...destValues].sort((a, b) => b - a);
    const top10pctItems    = Math.max(1, Math.ceil(contentNodes.length * 0.10));
    const top10pctItemLoad = totalDest
      ? sortedDest.slice(0, top10pctItems).reduce((s, v) => s + v, 0) / totalDest : 0;

    const storageResult = {
      gini:              this._gini(destValues),
      top10pctItemLoad,
      maxLoad:           sortedDest[0] ?? 0,
      totalQueries:      contentLookups,
      successRate:       stSuccesses / Math.max(1, contentLookups),
      lorenz:            this._lorenz(destValues),
      numItems:          contentNodes.length,
      zipfExponent,
    };

    this.running = false;
    this.onComplete?.({ type: 'hotspot', highway: highwayResult, storage: storageResult });
    return { highway: highwayResult, storage: storageResult };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Utility functions
// ─────────────────────────────────────────────────────────────────────────────

function shuffleSample(arr, n) {
  const copy = [...arr];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, n);
}

/**
 * Generate a random land point using the provided land-detection function.
 * Falls back to a random point if landFn is null or returns false after 200 tries.
 */
function randomLandPoint(landFn) {
  if (!landFn) {
    return {
      lat: Math.random() * 160 - 80,
      lng: Math.random() * 360 - 180,
    };
  }
  for (let i = 0; i < 200; i++) {
    const lat = Math.random() * 160 - 80;
    const lng = Math.random() * 360 - 180;
    if (landFn(lat, lng)) return { lat, lng };
  }
  return { lat: 0, lng: 0 };
}

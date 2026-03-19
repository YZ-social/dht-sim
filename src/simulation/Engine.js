import { randomU64, computeStats, haversine, continentOf } from '../utils/geo.js';

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
                         : 'global';
    const specLabel = s => s.type === 'regional'  ? `${s.radius} km`
                         : s.type === 'dest'      ? `${s.pct}% dest`
                         : s.type === 'source'    ? `${s.pct}% src`
                         : s.type === 'srcdest'   ? `${s.srcPct}%→${s.destPct}%`
                         : s.type === 'churn'     ? `${s.rate}% churn`
                         : s.type === 'continent' ? `${s.src}→${s.dst}`
                         : 'Global';

    this.running = true;
    const data   = {};

    for (const def of protocolDefs) {
      if (!this.running) break;
      data[def.key] = {};

      // Build phase reported by caller via def.buildFn
      const dht = await def.buildFn();
      if (!dht) continue;

      // Optional warmup for protocols that need pre-training (e.g. neuromorphic).
      // Runs a burst of hot-node regional lookups so synaptic weights form before
      // any measurement cells are recorded.  Warmup counts are specified on the
      // protocol def; non-neuromorphic protocols leave warmupLookups undefined/0.
      if (def.warmupLookups > 0) {
        onStart(`${def.label} · warming up (${def.warmupLookups.toLocaleString()} lookups)…`);
        await this.runLookupTest(dht, {
          numMessages:    def.warmupLookups,
          captureLastPath: false,
          regional:       true,
          regionalRadius: def.warmupRadius ?? 2000,
          hotPct:         def.warmupHotPct ?? 10,
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
          onStart(`${def.label} · warming up for ${spec.pct}% dest (${def.warmupLookups.toLocaleString()} lookups)…`);
          await this.runLookupTest(dht, {
            numMessages:    def.warmupLookups,
            captureLastPath: false,
            destNodes:      sharedDestNodes,   // same pool as measurement
            managed:        true,
          });
        }

        // Source-specific warmup for neuromorphic protocols.
        if (spec.type === 'source' && def.warmupLookups > 0) {
          onStart(`${def.label} · warming up for ${spec.pct}% src (${def.warmupLookups.toLocaleString()} lookups)…`);
          await this.runLookupTest(dht, {
            numMessages:    def.warmupLookups,
            captureLastPath: false,
            sourceNodes:    sharedSourceNodes,
            managed:        true,
          });
        }

        // Src→Dest combined warmup for neuromorphic protocols.
        if (spec.type === 'srcdest' && def.warmupLookups > 0) {
          onStart(`${def.label} · warming up for ${spec.srcPct}%→${spec.destPct}% (${def.warmupLookups.toLocaleString()} lookups)…`);
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
          onStart(`${def.label} · warming up for ${spec.src}→${spec.dst} (${def.warmupLookups.toLocaleString()} lookups)…`);
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
          // Adapt lookups between rounds for neuromorphic protocols
          const ADAPT_LOOKUPS = def.warmupLookups > 0 ? 100 : 0;

          for (let round = 0; round < CHURN_ROUNDS; round++) {
            if (!this.running) break;
            onStart(`${def.label} · churn round ${round + 1}/${CHURN_ROUNDS} (${spec.rate}% turnover)…`);

            const alive = dht.getNodes().filter(n => n.alive);
            const numToReplace = Math.max(1, Math.floor(alive.length * rate));
            for (const node of shuffleSample(alive, numToReplace)) {
              await dht.removeNode(node.id);
            }
            for (let i = 0; i < numToReplace; i++) {
              const { lat, lng } = getLandPoint();
              const newNode = await dht.addNode(lat, lng);
              this._bootstrapNode(dht, newNode);
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

        const cellLabel = `${def.label} · ${specLabel(spec)}`;
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

      // Add replacement nodes on land
      for (let i = 0; i < numToReplace; i++) {
        const { lat, lng } = randomLandPoint(landFn);
        const newNode = await dht.addNode(lat, lng);
        // Bootstrap the new node into routing tables
        this._bootstrapNode(dht, newNode);
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

  // ── Concordance Session ──────────────────────────────────────────────────

  /**
   * Run one concordance session: every participant looks up the relay, then
   * the relay looks up every participant.  Repeated sessions drive neuromorphic
   * synaptome formation so hop counts trend toward 1 in both directions.
   *
   * @param {object} dht
   * @param {object} relay        – the central relay node
   * @param {object[]} participants – the N participant nodes
   * @returns {Promise<{toRelay, fromRelay, toRelayRaw, fromRelayRaw}>}
   */
  async runConcordanceSession(dht, relay, participants) {
    const toRelayHops   = [];
    const fromRelayHops = [];
    const YIELD_EVERY   = 8;

    for (let i = 0; i < participants.length; i++) {
      const p = participants[i];
      if (!p.alive || !relay.alive) continue;

      // participant → relay
      try {
        const r = await dht.lookup(p.id, relay.id);
        if (r?.found) toRelayHops.push(r.hops);
      } catch { /* skip */ }

      // relay → participant
      try {
        const r = await dht.lookup(relay.id, p.id);
        if (r?.found) fromRelayHops.push(r.hops);
      } catch { /* skip */ }

      if ((i + 1) % YIELD_EVERY === 0) await this._yield();
    }

    return {
      toRelay:      computeStats(toRelayHops),
      fromRelay:    computeStats(fromRelayHops),
      toRelayRaw:   toRelayHops,
      fromRelayRaw: fromRelayHops,
    };
  }

  /**
   * Bootstrap a newly joined node into the DHT's routing tables.
   * For Kademlia: add the new node to every existing node's bucket (if it fits),
   * and populate the new node's own buckets from existing nodes.
   */
  _bootstrapNode(dht, newNode) {
    // This is a simplified bootstrap: in production Kademlia the new node
    // would issue a self-lookup to fill its buckets.
    const existing = dht.getNodes().filter(n => n.alive && n.id !== newNode.id);
    if (typeof newNode.addToBucket === 'function') {
      for (const other of existing) {
        newNode.addToBucket(other);
        other.addToBucket(newNode);
      }
    }
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

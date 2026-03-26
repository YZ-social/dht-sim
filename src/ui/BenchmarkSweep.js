/**
 * BenchmarkSweep – runs a sequence of benchmark runs with varying parameters.
 *
 * Integration contract (main.js must call these at the right moments):
 *   sweep.notifyInitComplete()           — end of onInit(), after setRunning(false)
 *   sweep.notifyBenchmarkComplete()      — end of onBenchmark(), success path only
 *   sweep.notifyBenchmarkStopped()       — end of onBenchmark(), stopped/error path
 *
 * Claude (or UI) starts a sweep via:
 *   window.__sim.sweep.start(runs)
 *
 * Each run is an object with any subset of:
 *   { nodeCount, pubsubCoverage, pubsubGroupSize, warmupSessions,
 *     protocols: ['kademlia','geo8','ngdht10w'],
 *     tests:     ['global','r2000','pubsub'] }
 */
export class BenchmarkSweep {
  constructor() {
    this._running  = false;
    this._runs     = [];
    this._idx      = 0;
    this._results  = [];
    this._onInit   = null;   // resolve callback waiting for init
    this._onBench  = null;   // resolve callback waiting for benchmark
    this._statusEl = null;

    // Poll server for experiments queued by Claude via POST /api/experiment
    setInterval(() => this._pollExperiment(), 3000);
  }

  async _pollExperiment() {
    if (this._running) return;
    try {
      const r   = await fetch('/api/experiment');
      const exp = await r.json();
      if (exp?.runs?.length) {
        console.log(`[Sweep] Picked up experiment from server: "${exp.label}"`);
        this.start(exp.runs);
      }
    } catch { /* server may not be up yet */ }
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  get running()  { return this._running; }
  get progress() { return { idx: this._idx, total: this._runs.length, results: this._results.length }; }
  get results()  { return this._results; }

  /**
   * Start a sweep.
   * @param {Array<Object>} runs  Array of param-override objects.
   * @returns {boolean} false if a sweep is already running.
   */
  start(runs) {
    if (this._running) {
      console.warn('[Sweep] Already running — call stop() first');
      return false;
    }
    if (!runs?.length) {
      console.warn('[Sweep] No runs provided');
      return false;
    }
    this._running = true;
    this._runs    = runs;
    this._idx     = 0;
    this._results = [];
    this._log(`Starting ${runs.length} run(s)`);
    this._updateSweepStatus();
    this._next();
    return true;
  }

  /** Abort the current sweep after the running step finishes. */
  stop() {
    if (!this._running) return;
    this._log('Sweep aborted by user');
    this._running = false;
    this._onInit  = null;
    this._onBench = null;
    this._updateSweepStatus();
  }

  // ── Called by main.js ────────────────────────────────────────────────────

  notifyInitComplete() {
    const cb = this._onInit;
    this._onInit = null;
    if (cb) cb();
  }

  notifyBenchmarkComplete() {
    const cb = this._onBench;
    this._onBench = null;
    if (cb) cb(true);
  }

  notifyBenchmarkStopped() {
    const cb = this._onBench;
    this._onBench = null;
    if (this._running) {
      this._log(`Benchmark stopped on run ${this._idx + 1} — aborting sweep`);
      this._running = false;
      this._updateSweepStatus();
    }
    if (cb) cb(false);
  }

  // ── Internal state machine ────────────────────────────────────────────────

  _next() {
    if (!this._running) return;

    if (this._idx >= this._runs.length) {
      this._running = false;
      this._log(`All ${this._runs.length} run(s) complete — ${this._results.length} result(s) collected`);
      this._updateSweepStatus();
      return;
    }

    const run = this._runs[this._idx];
    this._log(`Run ${this._idx + 1}/${this._runs.length}: ${JSON.stringify(run)}`);
    this._updateSweepStatus();

    // Apply this run's parameters to the DOM
    this._applyParams(run);

    // Register init callback then click Init
    this._onInit = () => {
      if (!this._running) return;

      // Re-apply after init in case anything reset (e.g. pubsubCoverage)
      this._applyParams(run);

      // Register benchmark callback then click Benchmark
      this._onBench = (success) => {
        if (!this._running) return;
        if (!success) return;          // sweep already aborted in notifyBenchmarkStopped
        this._results.push({ runIdx: this._idx, params: { ...run } });
        this._idx++;
        // Small gap so the UI settles before next init
        setTimeout(() => this._next(), 1500);
      };

      document.getElementById('btnBenchmark')?.click();
    };

    document.getElementById('btnInit')?.click();
  }

  _applyParams(run) {
    const setNum = (id, val) => {
      if (val === undefined || val === null) return;
      const el = document.getElementById(id);
      if (!el) return;
      el.value = val;
      el.dispatchEvent(new Event('input',  { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    };

    const setMultiSelect = (id, values, storageKey) => {
      if (!values) return;
      const sel = document.getElementById(id);
      if (!sel) return;
      const set = new Set(values);
      [...sel.options].forEach(o => { o.selected = set.has(o.value); });
      // Persist so Controls.js snapshot() reads correctly
      if (storageKey) {
        const payload = { v: 2, sel: [...set], known: [...sel.options].map(o => o.value) };
        localStorage.setItem(storageKey, JSON.stringify(payload));
      }
      sel.dispatchEvent(new Event('change', { bubbles: true }));
    };

    setNum('nodeCount',         run.nodeCount);
    setNum('pubsubCoverage',    run.pubsubCoverage);
    setNum('pubsubGroupSize',   run.pubsubGroupSize);
    setNum('benchWarmupSessions', run.warmupSessions);
    setMultiSelect('benchProtocols', run.protocols, 'dht-bench-protocols');
    setMultiSelect('benchTests',     run.tests,     'dht-bench-tests');
  }

  _updateSweepStatus() {
    const el     = document.getElementById('sweepStatus');
    const stopBtn = document.getElementById('btnSweepStop');
    if (!el) return;

    if (!this._running && this._idx === 0 && this._results.length === 0) {
      el.textContent = '';
      el.style.display = 'none';
      if (stopBtn) stopBtn.style.display = 'none';
      return;
    }

    el.style.display = '';
    if (this._running) {
      el.textContent = `Sweep: run ${this._idx + 1}/${this._runs.length}`;
      el.className = 'sweep-status sweep-running';
      if (stopBtn) stopBtn.style.display = '';
    } else if (this._results.length === this._runs.length) {
      el.textContent = `Sweep complete — ${this._results.length} run(s) done ✓`;
      el.className = 'sweep-status sweep-done';
      if (stopBtn) stopBtn.style.display = 'none';
    } else {
      el.textContent = `Sweep stopped (${this._results.length}/${this._runs.length} done)`;
      el.className = 'sweep-status sweep-stopped';
      if (stopBtn) stopBtn.style.display = 'none';
    }
  }

  _log(msg) {
    console.log(`[Sweep] ${msg}`);
  }
}

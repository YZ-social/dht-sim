/**
 * Controls – manages all UI parameter inputs and emits change events.
 * Reads/writes the DOM and fires CustomEvents on `document`.
 */
export class Controls {
  constructor() {
    this._bindAll();
  }

  _el(id) { return document.getElementById(id); }

  _bindAll() {
    // Rename "Lookup Test" → "Lookup Training" for the Neuromorphic protocol
    const protocolSel = this._el('dhtProtocol');
    if (protocolSel) {
      protocolSel.addEventListener('change', () => this._updateLookupLabel());
      this._updateLookupLabel();
    }

    // Sliders with live value display (Network row)
    this._bindSlider('nodeCount', 'nodeCountVal');
    this._bindSlider('kParam', 'kParamVal');
    this._bindSlider('alphaParam', 'alphaParamVal');
    this._bindSlider('nodeDelay', 'nodeDelayVal');

    // Standalone number inputs — clamp on change
    this._bindNumber('msgCount', 50, 5000);
    this._bindNumber('hotPct',    1,  100);

    // Sliders with live value display (Churn row)
    this._bindSlider('churnRate', 'churnRateVal');
    this._bindSlider('churnIntervals', 'churnIntervalsVal');
    this._bindSlider('lookupsPerInterval', 'lookupsPerIntervalVal');
  }

  _bindSlider(sliderId, displayId, fmt = v => v) {
    const slider  = this._el(sliderId);
    const display = this._el(displayId);
    if (!slider || !display) return;

    const isInput = display.tagName === 'INPUT';

    // Slider → display
    if (isInput) {
      display.value = slider.value;
    } else {
      display.textContent = fmt(slider.value);
    }
    slider.addEventListener('input', () => {
      if (isInput) display.value = slider.value;
      else display.textContent = fmt(slider.value);
    });

    // Number input → slider (two-way binding)
    if (isInput) {
      display.addEventListener('change', () => {
        const min = parseInt(slider.min);
        const max = parseInt(slider.max);
        const val = Math.max(min, Math.min(max, parseInt(display.value) || min));
        display.value = val;
        slider.value  = val;
      });
    }
  }

  _bindNumber(id, min, max) {
    const el = this._el(id);
    if (!el) return;
    el.addEventListener('change', () => {
      const val = Math.max(min, Math.min(max, parseInt(el.value) || min));
      el.value = val;
    });
  }

  // ── Parameter getters ────────────────────────────────────────────────────

  get dhtProtocol() { return this._el('dhtProtocol')?.value ?? 'kademlia'; }
  get nodeCount()   { return parseInt(this._el('nodeCount')?.value ?? 500); }
  get kParam()      { return parseInt(this._el('kParam')?.value ?? 20); }
  get alphaParam()  { return parseInt(this._el('alphaParam')?.value ?? 3); }
  get idBits()      { return parseInt(this._el('idBits')?.value ?? 32); }
  get nodeDelay()   { return parseInt(this._el('nodeDelay')?.value ?? 10); }
  get msgCount()    { return parseInt(this._el('msgCount')?.value ?? 500); }
  get hotPct()      { return parseInt(this._el('hotPct')?.value  ?? 100); }
  get churnRate()   { return parseInt(this._el('churnRate')?.value ?? 5) / 100; }
  get churnIntervals() { return parseInt(this._el('churnIntervals')?.value ?? 10); }
  get lookupsPerInterval() { return parseInt(this._el('lookupsPerInterval')?.value ?? 100); }
  get regional()       { return this._el('regionalMode')?.checked ?? false; }
  get regionalRadius() { return parseInt(this._el('regionalRadius')?.value ?? 2000); }
  get sourceMode()     { return this._el('sourceMode')?.checked ?? false; }
  get sourcePct()      { return parseInt(this._el('sourcePct')?.value ?? 10); }
  get destMode()          { return this._el('destMode')?.checked ?? false; }
  get destPct()           { return parseInt(this._el('destPct')?.value ?? 10); }
  get benchChurnPct()        { return parseInt(this._el('benchChurnPct')?.value ?? 5); }
  get benchWarmupSessions()  { return Math.max(1, Math.min(10, parseInt(this._el('benchWarmupSessions')?.value ?? 4))); }
  get showAnimation() { return this._el('showAnimation')?.checked ?? true; }
  get autoRotate()  { return this._el('autoRotate')?.checked ?? false; }
  get concordanceSize() { return Math.max(4, Math.min(256, parseInt(this._el('concordanceSize')?.value ?? 32))); }

  /** Return all current parameters as a plain object. */
  snapshot() {
    return {
      protocol: this.dhtProtocol,
      nodeCount: this.nodeCount,
      k: this.kParam,
      alpha: this.alphaParam,
      bits: this.idBits,
      nodeDelay: this.nodeDelay,
      msgCount: this.msgCount,
      hotPct:   this.hotPct,
      regional: this.regional,
      regionalRadius: this.regionalRadius,
      sourceMode: this.sourceMode,
      sourcePct:  this.sourcePct,
      destMode:       this.destMode,
      destPct:        this.destPct,
      benchChurnPct:       this.benchChurnPct,
      benchWarmupSessions: this.benchWarmupSessions,
      concordanceSize: this.concordanceSize,
      churnRate: this.churnRate,
      churnIntervals: this.churnIntervals,
      lookupsPerInterval: this.lookupsPerInterval,
      showAnimation: this.showAnimation,
    };
  }

  _updateLookupLabel() {
    const btn = this._el('btnLookupTest');
    if (btn) {
      const isNeuro = this.dhtProtocol === 'ngdht' || this.dhtProtocol === 'ngdht2' || this.dhtProtocol === 'ngdht2bp' || this.dhtProtocol === 'ngdht2shc' || this.dhtProtocol === 'ngdht3' || this.dhtProtocol === 'ngdht4' || this.dhtProtocol === 'ngdht5';
      btn.textContent = isNeuro ? '▶ Lookup Training' : '▶ Lookup Test';
    }
  }

  // ── Button state management ──────────────────────────────────────────────

  setRunning(running) {
    // btnBenchmark is managed independently by setBenchmarking(); exclude it here.
    const btns = ['btnInit', 'btnLookupTest', 'btnChurnTest'];
    btns.forEach(id => {
      const el = this._el(id);
      if (el) el.disabled = running;
    });
    // Disable Benchmark, Train, and Concordance during normal tests
    const benchBtn = this._el('btnBenchmark');
    if (benchBtn) benchBtn.disabled = running;
    const trainBtn = this._el('btnTrainNetwork');
    if (trainBtn) trainBtn.disabled = running;
    const concBtn = this._el('btnConcordance');
    if (concBtn) concBtn.disabled = running;
    const pairBtn = this._el('btnPairLearning');
    if (pairBtn) pairBtn.disabled = running;
  }

  setBenchmarking(active) {
    // During benchmarking: disable everything except the benchmark button itself
    // (which becomes "⏹ Stop Benchmark").
    const btns = ['btnInit', 'btnLookupTest', 'btnChurnTest', 'btnDemoLookup'];
    btns.forEach(id => {
      const el = this._el(id);
      if (el) el.disabled = active;
    });
    const trainBtn = this._el('btnTrainNetwork');
    if (trainBtn) trainBtn.disabled = active;
    const concBtn = this._el('btnConcordance');
    if (concBtn) concBtn.disabled = active;
    const pairBtn2 = this._el('btnPairLearning');
    if (pairBtn2) pairBtn2.disabled = active;

    const benchBtn = this._el('btnBenchmark');
    if (benchBtn) {
      benchBtn.disabled = false;
      if (active) {
        benchBtn.textContent = '⏹ Stop Benchmark';
        benchBtn.classList.add('active');
      } else {
        benchBtn.textContent = '▶▶ Benchmark';
        benchBtn.classList.remove('active');
      }
    }
  }

  setConcordance(active) {
    const btns = ['btnInit', 'btnLookupTest', 'btnChurnTest', 'btnDemoLookup', 'btnBenchmark', 'btnTrainNetwork', 'btnPairLearning'];
    btns.forEach(id => {
      const el = this._el(id);
      if (el) el.disabled = active;
    });
    const concBtn = this._el('btnConcordance');
    if (concBtn) {
      concBtn.disabled = false;
      if (active) {
        concBtn.textContent = '⏹ Stop Concordance';
        concBtn.classList.add('active');
      } else {
        concBtn.textContent = '◎ Concordance';
        concBtn.classList.remove('active');
      }
    }
  }

  setPairLearning(active) {
    const btns = ['btnInit', 'btnLookupTest', 'btnChurnTest', 'btnDemoLookup',
                  'btnBenchmark', 'btnTrainNetwork', 'btnConcordance'];
    btns.forEach(id => {
      const el = this._el(id);
      if (el) el.disabled = active;
    });
    const pairBtn = this._el('btnPairLearning');
    if (pairBtn) {
      pairBtn.disabled = false;
      if (active) {
        pairBtn.textContent = '⏹ Stop Pairs';
        pairBtn.classList.add('active');
      } else {
        pairBtn.textContent = '↔ Pair Learning';
        pairBtn.classList.remove('active');
      }
    }
  }

  setTraining(active) {
    const btns = ['btnInit', 'btnLookupTest', 'btnChurnTest', 'btnDemoLookup', 'btnBenchmark', 'btnConcordance', 'btnPairLearning'];
    btns.forEach(id => {
      const el = this._el(id);
      if (el) el.disabled = active;
    });
    const trainBtn = this._el('btnTrainNetwork');
    if (trainBtn) {
      trainBtn.disabled = false;
      if (active) {
        trainBtn.textContent = '⏹ Stop Training';
        trainBtn.classList.add('active');
      } else {
        trainBtn.textContent = '⟳ Train Network';
        trainBtn.classList.remove('active');
      }
    }
  }

  setStatus(msg, type = 'info') {
    const el = this._el('statusMsg');
    if (!el) return;
    el.textContent = msg;
    el.className = `status-msg status-${type}`;
  }

  setProgress(fraction) {
    const bar = this._el('progressBar');
    if (bar) bar.style.width = `${Math.round(fraction * 100)}%`;
  }
}

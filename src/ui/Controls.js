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
    // Also show/hide NX-1W rule panel
    const protocolSel = this._el('dhtProtocol');
    if (protocolSel) {
      protocolSel.addEventListener('change', () => {
        this._updateLookupLabel();
        this._updateNX1WPanel();
      });
      this._updateLookupLabel();
      this._updateNX1WPanel();
    }

    // Number inputs — clamp on change
    this._bindNumber('nodeCount',         20,   100000);
    this._bindNumber('kParam',             1,       50);
    this._bindNumber('alphaParam',         1,       10);
    this._bindNumber('nodeDelay',          0,      500);
    this._bindNumber('msgCount',          50,     5000);
    this._bindNumber('hotPct',             1,      100);
    this._bindNumber('churnRate',          1,       50);
    this._bindNumber('churnIntervals',     2,       30);
    this._bindNumber('lookupsPerInterval', 20,     500);
    this._bindNumber('addNodeCount',        1,    1000);
    this._bindNumber('addNodeWarmup',       0,     500);

    // Benchmark multi-selects: restore from localStorage, then wire buttons + persistence
    this._restoreMultiSelect('benchProtocols', 'dht-bench-protocols');
    this._restoreMultiSelect('benchTests',     'dht-bench-tests');

    this._bindMultiSelectAll ('benchProtoAll',  'benchProtocols', 'dht-bench-protocols');
    this._bindMultiSelectNone('benchProtoNone', 'benchProtocols', 'dht-bench-protocols');
    this._bindMultiSelectAll ('benchTestAll',   'benchTests',     'dht-bench-tests');
    this._bindMultiSelectNone('benchTestNone',  'benchTests',     'dht-bench-tests');

    // Save on every change
    this._bindMultiSelectSave('benchProtocols', 'dht-bench-protocols');
    this._bindMultiSelectSave('benchTests',     'dht-bench-tests');

    // Single-click toggle: no Ctrl/Cmd required to select/deselect items
    this._enableClickToggle('benchProtocols', 'dht-bench-protocols');
    this._enableClickToggle('benchTests',     'dht-bench-tests');
  }

  /** Restore a <select multiple> from a stored JSON array of selected values. */
  _restoreMultiSelect(selectId, storageKey) {
    const el = this._el(selectId);
    if (!el) return;
    try {
      const saved = localStorage.getItem(storageKey);
      if (!saved) return;
      const parsed = JSON.parse(saved);

      if (parsed && !Array.isArray(parsed) && parsed.v === 2) {
        // New format {v:2, sel:[…], known:[…]}: only update options that were
        // present when the state was saved.  New options (not in `known`) keep
        // their HTML default so freshly-added protocols appear selected.
        const selSet   = new Set(parsed.sel   ?? []);
        const knownSet = new Set(parsed.known ?? []);
        [...el.options].forEach(o => {
          if (knownSet.has(o.value)) o.selected = selSet.has(o.value);
          // else: option is new since last save → leave HTML default untouched
        });
      } else {
        // Legacy plain-array format: treat saved values as explicitly selected;
        // options absent from the array keep their HTML default rather than
        // being forced to deselected.  This means newly-added protocols (like
        // N-11W) automatically appear selected on first load after the upgrade.
        const vals = new Set(Array.isArray(parsed) ? parsed : []);
        [...el.options].forEach(o => { if (vals.has(o.value)) o.selected = true; });
      }
    } catch (_) { /* ignore parse errors */ }
  }

  /** Wire a "Select All" button for a multi-select. */
  _bindMultiSelectAll(btnId, selectId, storageKey) {
    const btn = this._el(btnId);
    const sel = this._el(selectId);
    if (!btn || !sel) return;
    btn.addEventListener('click', () => {
      [...sel.options].forEach(o => { o.selected = true; });
      this._saveMultiSelect(sel, storageKey);
    });
  }

  /** Wire a "Deselect All" button for a multi-select. */
  _bindMultiSelectNone(btnId, selectId, storageKey) {
    const btn = this._el(btnId);
    const sel = this._el(selectId);
    if (!btn || !sel) return;
    btn.addEventListener('click', () => {
      [...sel.options].forEach(o => { o.selected = false; });
      this._saveMultiSelect(sel, storageKey);
    });
  }

  /** Save selection to localStorage whenever the select changes. */
  _bindMultiSelectSave(selectId, storageKey) {
    const sel = this._el(selectId);
    if (!sel) return;
    sel.addEventListener('change', () => this._saveMultiSelect(sel, storageKey));
  }

  /** Persist current selection of a <select multiple> to localStorage. */
  _saveMultiSelect(sel, storageKey) {
    try {
      const sel_  = [...sel.options].filter(o =>  o.selected).map(o => o.value);
      const known = [...sel.options].map(o => o.value);
      localStorage.setItem(storageKey, JSON.stringify({ v: 2, sel: sel_, known }));
    } catch (_) { /* quota / private browsing */ }
  }

  /** Make a <select multiple> toggle items on single click (no Ctrl/Cmd). */
  _enableClickToggle(selectId, storageKey) {
    const sel = this._el(selectId);
    if (!sel) return;

    // Snapshot selection state on mousedown (before browser changes it)
    let snapshot = [];
    sel.addEventListener('mousedown', (e) => {
      if (!e.target.closest('option')) return;
      snapshot = [...sel.options].map(o => o.selected);
    });

    // On mouseup: restore snapshot, then toggle only the clicked option
    sel.addEventListener('mouseup', (e) => {
      const option = e.target.closest('option');
      if (!option || !snapshot.length) return;
      const scrollTop = sel.scrollTop;
      // Restore pre-click state
      [...sel.options].forEach((o, i) => { o.selected = snapshot[i]; });
      // Toggle the clicked one
      option.selected = !option.selected;
      snapshot = [];
      sel.scrollTop = scrollTop;
      this._saveMultiSelect(sel, storageKey);
    });
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
  get idBits()      { return parseInt(this._el('idBits')?.value ?? 64); }
  get geoBits()     { return Math.max(1, Math.min(32, parseInt(this._el('geoBits')?.value ?? 8))); }
  get nodeDelay()   { return parseInt(this._el('nodeDelay')?.value ?? 10); }
  get msgCount()    { return parseInt(this._el('msgCount')?.value ?? 500); }
  get hotPct()      { return parseInt(this._el('hotPct')?.value  ?? 100); }
  get churnRate()   { return parseInt(this._el('churnRate')?.value ?? 5) / 100; }
  get churnIntervals() { return parseInt(this._el('churnIntervals')?.value ?? 10); }
  get lookupsPerInterval() { return parseInt(this._el('lookupsPerInterval')?.value ?? 100); }
  get addNodeCount()  { return Math.max(1, parseInt(this._el('addNodeCount')?.value  ?? 1)); }
  get addNodeWarmup() { return Math.max(0, parseInt(this._el('addNodeWarmup')?.value ?? 50)); }
  get regional()       { return this._el('regionalMode')?.checked ?? false; }
  get regionalRadius() { return parseInt(this._el('regionalRadius')?.value ?? 2000); }
  get sourceMode()     { return this._el('sourceMode')?.checked ?? false; }
  get sourcePct()      { return parseInt(this._el('sourcePct')?.value ?? 10); }
  get destMode()          { return this._el('destMode')?.checked ?? false; }
  get destPct()           { return parseInt(this._el('destPct')?.value ?? 10); }
  get benchChurnPct()        { return parseInt(this._el('churnRate')?.value ?? 5); }
  get benchWarmupSessions()  { return Math.max(1, Math.min(99, parseInt(this._el('benchWarmupSessions')?.value ?? 4))); }
  get benchProtocols() {
    const el = this._el('benchProtocols');
    if (!el) return null;   // null = all
    const sel = [...el.options].filter(o => o.selected).map(o => o.value);
    return sel.length ? new Set(sel) : null;
  }
  get benchTests() {
    const el = this._el('benchTests');
    if (!el) return null;   // null = all
    const sel = [...el.options].filter(o => o.selected).map(o => o.value);
    return sel.length ? new Set(sel) : null;
  }
  get bidirectional()    { return this._el('bidirectional')?.checked ?? true; }
  get webLimit()         { return this._el('webLimit')?.checked ?? false; }
  get benchBootstrap()   { return this._el('benchBootstrap')?.checked ?? false; }
  get showAnimation() { return this._el('showAnimation')?.checked ?? true; }
  get autoRotate()  { return this._el('autoRotate')?.checked ?? false; }
  get pubsubGroupSize() { return Math.max(4, parseInt(this._el('pubsubGroupSize')?.value ?? 32)); }
  get pubsubCoverage()  { return Math.max(1, Math.min(100, parseInt(this._el('pubsubCoverage')?.value ?? 10))); }
  get hotspotLookups()  { return Math.max(100, parseInt(this._el('hotspotLookups')?.value ?? 1000)); }
  get contentCount()    { return Math.max(10,  parseInt(this._el('contentCount')?.value   ?? 50)); }
  get zipfExponent()    { return Math.max(0.1, parseFloat(this._el('zipfExponent')?.value ?? 1.0)); }

  /** Return all current parameters as a plain object. */
  snapshot() {
    return {
      protocol: this.dhtProtocol,
      nodeCount: this.nodeCount,
      k: this.kParam,
      alpha: this.alphaParam,
      bits: this.idBits,
      geoBits: this.geoBits,
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
      benchProtocols:      this.benchProtocols,
      benchTests:          this.benchTests,
      pubsubGroupSize: this.pubsubGroupSize,
      pubsubCoverage:  this.pubsubCoverage,
      hotspotLookups: this.hotspotLookups,
      contentCount:   this.contentCount,
      zipfExponent:   this.zipfExponent,
      churnRate: this.churnRate,
      churnIntervals: this.churnIntervals,
      lookupsPerInterval: this.lookupsPerInterval,
      addNodeCount:  this.addNodeCount,
      addNodeWarmup: this.addNodeWarmup,
      showAnimation: this.showAnimation,
      bidirectional:   this.bidirectional,
      webLimit:         this.webLimit,
      benchBootstrap:   this.benchBootstrap,
      nx1wRules: this.getNX1WRules(),
      nx2wRules: this.getNX2WRules(),
      nx13Rules: this.getNX13Rules(),
      nx15Params: this.getNX15Params(),
    };
  }

  _updateLookupLabel() {
    const btn = this._el('btnLookupTest');
    if (btn) {
      const isNeuro = this.dhtProtocol.startsWith('ngdht');
      btn.textContent = isNeuro ? '▶ Lookup Training' : '▶ Lookup Test';
    }
  }

  _updateNX1WPanel() {
    const p1 = this._el('nx1w-panel');
    if (p1) p1.classList.toggle('nx-visible', this.dhtProtocol === 'ngdhtnx1w');
    const p2 = this._el('nx2w-panel');
    if (p2) p2.classList.toggle('nx-visible', this.dhtProtocol === 'ngdhtnx2w');
    const nx13 = this._el('nx13-panel');
    if (nx13) nx13.classList.toggle('nx-visible', this.dhtProtocol === 'ngdhtnx13');
    const nx15 = this._el('nx15-panel');
    if (nx15) nx15.classList.toggle('nx-visible', this.dhtProtocol === 'ngdhtnx15');
  }

  /** Read all NX-1W rule parameters from DOM inputs. */
  getNX1WRules() {
    const num = id => { const el = this._el(id); return el ? parseFloat(el.value) : undefined; };
    const int = id => { const el = this._el(id); return el ? parseInt(el.value) : undefined; };
    const chk = (id, def = true) => { const el = this._el(id); return el ? el.checked : def; };

    return {
      bootstrap:          { kBootFactor:               int('nx-kBootFactor') },
      twoTier:            { enabled: chk('nx-twoTier-en'),
                            maxSynaptomeSize:          int('nx-maxSynaptomeSize'),
                            highwaySlots:              int('nx-highwaySlots') },
      apRouting:          { lookaheadAlpha:            int('nx-lookaheadAlpha'),
                            weightScale:               num('nx-weightScale'),
                            geoRegionBits:             int('nx-geoRegionBits'),
                            explorationEpsilon:        num('nx-explorationEpsilon'),
                            maxGreedyHops:             int('nx-maxGreedyHops') },
      ltp:                { enabled: chk('nx-ltp-en'),
                            inertiaDuration:           int('nx-inertiaDuration') },
      triadicClosure:     { enabled: chk('nx-triadic-en'),
                            introductionThreshold:     int('nx-introductionThreshold') },
      hopCaching:         { enabled: chk('nx-hopCaching-en'),
                            cascadeWeight:             num('nx-cascadeWeight') },
      lateralSpread:      { enabled: chk('nx-lateralSpread-en'),
                            lateralK:                  int('nx-lateralK'),
                            lateralK2:                 int('nx-lateralK2'),
                            lateralMaxDepth:           int('nx-lateralMaxDepth') },
      stratifiedEviction: { enabled: chk('nx-stratified-en'),
                            strataGroups:              int('nx-strataGroups'),
                            stratumFloor:              int('nx-stratumFloor') },
      annealing:          { enabled: chk('nx-annealing-en'),
                            tInit:                     num('nx-tInit'),
                            tMin:                      num('nx-tMin'),
                            annealCooling:             num('nx-annealCooling'),
                            globalBias:                num('nx-globalBias'),
                            annealLocalSample:         int('nx-annealLocalSample') },
      relayPinning:       { enabled: chk('nx-relayPinning-en'),
                            relayPinThreshold:         int('nx-relayPinThreshold'),
                            relayPinWindow:            int('nx-relayPinWindow'),
                            relayPinMax:               int('nx-relayPinMax'),
                            relayPinWeight:            num('nx-relayPinWeight') },
      markov:             { enabled: chk('nx-markov-en'),
                            markovWindow:              int('nx-markovWindow'),
                            markovHotThreshold:        int('nx-markovHotThreshold'),
                            markovBaseWeight:          num('nx-markovBaseWeight'),
                            markovMaxWeight:           num('nx-markovMaxWeight') },
      adaptiveDecay:      { enabled: chk('nx-adaptiveDecay-en'),
                            decayInterval:             int('nx-decayInterval'),
                            pruneThreshold:            num('nx-pruneThreshold'),
                            decayGammaMin:             num('nx-decayGammaMin'),
                            decayGammaMax:             num('nx-decayGammaMax'),
                            useSaturation:             int('nx-useSaturation'),
                            decayGammaHighwayActive:   num('nx-decayGammaHighwayActive'),
                            decayGammaHighwayIdle:     num('nx-decayGammaHighwayIdle'),
                            highwayRenewalWindow:      int('nx-highwayRenewalWindow'),
                            highwayFloor:              int('nx-highwayFloor'),
                            synaptomeFloor:            int('nx-synaptomeFloor') },
      highwayRefresh:     { enabled: chk('nx-highwayRefresh-en'),
                            hubRefreshInterval:        int('nx-hubRefreshInterval'),
                            hubScanCap:                int('nx-hubScanCap'),
                            hubMinDiversity:           int('nx-hubMinDiversity'),
                            hubNoise:                  num('nx-hubNoise') },
      loadBalancing:      { enabled: chk('nx-loadBalancing-en', false),
                            loadDecay:                 num('nx-loadDecay'),
                            loadPenalty:               num('nx-loadPenalty'),
                            loadFloor:                 num('nx-loadFloor'),
                            loadSaturation:            num('nx-loadSaturation') },
    };
  }

  /** Read all NX-2W rule parameters from DOM inputs. */
  getNX2WRules() {
    const num = id => { const el = this._el(id); return el ? parseFloat(el.value) : undefined; };
    const int = id => { const el = this._el(id); return el ? parseInt(el.value)   : undefined; };
    const chk = (id, def = true) => { const el = this._el(id); return el ? el.checked : def; };

    return {
      // ── All NX-1W rules (same params, n2- prefix) ──────────────────────────
      bootstrap:          { kBootFactor:               int('n2-kBootFactor') },
      twoTier:            { enabled: chk('n2-twoTier-en'),
                            maxSynaptomeSize:           int('n2-maxSynaptomeSize'),
                            highwaySlots:               int('n2-highwaySlots') },
      apRouting:          { lookaheadAlpha:             int('n2-lookaheadAlpha'),
                            weightScale:               num('n2-weightScale'),
                            geoRegionBits:             int('n2-geoRegionBits'),
                            explorationEpsilon:        num('n2-explorationEpsilon'),
                            maxGreedyHops:             int('n2-maxGreedyHops') },
      ltp:                { enabled: chk('n2-ltp-en'),
                            inertiaDuration:           int('n2-inertiaDuration') },
      triadicClosure:     { enabled: chk('n2-triadic-en'),
                            introductionThreshold:     int('n2-introductionThreshold') },
      hopCaching:         { enabled: chk('n2-hopCaching-en'),
                            cascadeWeight:             num('n2-cascadeWeight') },
      lateralSpread:      { enabled: chk('n2-lateralSpread-en'),
                            lateralK:                  int('n2-lateralK'),
                            lateralK2:                 int('n2-lateralK2'),
                            lateralMaxDepth:           int('n2-lateralMaxDepth') },
      stratifiedEviction: { enabled: chk('n2-stratified-en'),
                            strataGroups:              int('n2-strataGroups'),
                            stratumFloor:              int('n2-stratumFloor') },
      annealing:          { enabled: chk('n2-annealing-en'),
                            tInit:                     num('n2-tInit'),
                            tMin:                      num('n2-tMin'),
                            annealCooling:             num('n2-annealCooling'),
                            globalBias:                num('n2-globalBias'),
                            annealLocalSample:         int('n2-annealLocalSample') },
      relayPinning:       { enabled: chk('n2-relayPinning-en'),
                            relayPinThreshold:         int('n2-relayPinThreshold'),
                            relayPinWindow:            int('n2-relayPinWindow'),
                            relayPinMax:               int('n2-relayPinMax'),
                            relayPinWeight:            num('n2-relayPinWeight') },
      markov:             { enabled: chk('n2-markov-en'),
                            markovWindow:              int('n2-markovWindow'),
                            markovHotThreshold:        int('n2-markovHotThreshold'),
                            markovBaseWeight:          num('n2-markovBaseWeight'),
                            markovMaxWeight:           num('n2-markovMaxWeight') },
      adaptiveDecay:      { enabled: chk('n2-adaptiveDecay-en'),
                            decayInterval:             int('n2-decayInterval'),
                            pruneThreshold:            num('n2-pruneThreshold'),
                            decayGammaMin:             num('n2-decayGammaMin'),
                            decayGammaMax:             num('n2-decayGammaMax'),
                            useSaturation:             int('n2-useSaturation'),
                            decayGammaHighwayActive:   num('n2-decayGammaHighwayActive'),
                            decayGammaHighwayIdle:     num('n2-decayGammaHighwayIdle'),
                            highwayRenewalWindow:      int('n2-highwayRenewalWindow'),
                            highwayFloor:              int('n2-highwayFloor'),
                            synaptomeFloor:            int('n2-synaptomeFloor') },
      highwayRefresh:     { enabled: chk('n2-highwayRefresh-en'),
                            hubRefreshInterval:        int('n2-hubRefreshInterval'),
                            hubScanCap:                int('n2-hubScanCap'),
                            hubMinDiversity:           int('n2-hubMinDiversity'),
                            hubNoise:                  num('n2-hubNoise') },
      loadBalancing:      { enabled: chk('n2-loadBalancing-en', false),
                            loadDecay:                 num('n2-loadDecay'),
                            loadPenalty:               num('n2-loadPenalty'),
                            loadFloor:                 num('n2-loadFloor'),
                            loadSaturation:            num('n2-loadSaturation') },
      // ── Rule 15: Broadcast Tree (NX-2W only) ──────────────────────────────
      broadcastTree:      { enabled: chk('n2-broadcastTree-en'),
                            branchingFactor:           int('n2-branchingFactor'),
                            maxDepth:                  int('n2-maxDepth'),
                            rebalanceAt:               int('n2-rebalanceAt'),
                            edgeLtpWeight:             num('n2-edgeLtpWeight'),
                            proximityBias:             num('n2-proximityBias') },
    };
  }

  /** Read NX-13 rule parameters from DOM inputs (mirrors NX-1W structure). */
  getNX13Rules() {
    const num = id => { const el = this._el(id); return el ? parseFloat(el.value) : undefined; };
    const int = id => { const el = this._el(id); return el ? parseInt(el.value)   : undefined; };
    const chk = (id, def = true) => { const el = this._el(id); return el ? el.checked : def; };

    return {
      bootstrap:          { kBootFactor:               int('x3-kBootFactor') },
      twoTier:            { enabled: chk('x3-twoTier-en'),
                            maxSynaptomeSize:          int('x3-maxSynaptomeSize'),
                            highwaySlots:              int('x3-highwaySlots') },
      apRouting:          { lookaheadAlpha:            int('x3-lookaheadAlpha'),
                            weightScale:               num('x3-weightScale'),
                            geoRegionBits:             int('x3-geoRegionBits'),
                            explorationEpsilon:        num('x3-explorationEpsilon'),
                            maxGreedyHops:             int('x3-maxGreedyHops') },
      ltp:                { enabled: chk('x3-ltp-en'),
                            inertiaDuration:           int('x3-inertiaDuration') },
      triadicClosure:     { enabled: chk('x3-triadic-en'),
                            introductionThreshold:     int('x3-introductionThreshold') },
      hopCaching:         { enabled: chk('x3-hopCaching-en'),
                            cascadeWeight:             num('x3-cascadeWeight') },
      lateralSpread:      { enabled: chk('x3-lateralSpread-en'),
                            lateralK:                  int('x3-lateralK'),
                            lateralK2:                 int('x3-lateralK2'),
                            lateralMaxDepth:           int('x3-lateralMaxDepth') },
      stratifiedEviction: { enabled: chk('x3-stratified-en', false) },
      annealing:          { enabled: chk('x3-annealing-en'),
                            tInit:                     num('x3-tInit'),
                            tMin:                      num('x3-tMin'),
                            annealCooling:             num('x3-annealCooling'),
                            globalBias:                num('x3-globalBias'),
                            annealLocalSample:         int('x3-annealLocalSample') },
      markov:             { enabled: chk('x3-markov-en'),
                            markovWindow:              int('x3-markovWindow'),
                            markovHotThreshold:        int('x3-markovHotThreshold'),
                            markovBaseWeight:          num('x3-markovBaseWeight'),
                            markovMaxWeight:           num('x3-markovMaxWeight') },
      adaptiveDecay:      { enabled: chk('x3-adaptiveDecay-en'),
                            decayInterval:             int('x3-decayInterval'),
                            pruneThreshold:            num('x3-pruneThreshold'),
                            decayGammaMin:             num('x3-decayGammaMin'),
                            decayGammaMax:             num('x3-decayGammaMax'),
                            useSaturation:             int('x3-useSaturation'),
                            decayGammaHighwayActive:   num('x3-decayGammaHighwayActive'),
                            decayGammaHighwayIdle:     num('x3-decayGammaHighwayIdle'),
                            highwayRenewalWindow:      int('x3-highwayRenewalWindow'),
                            highwayFloor:              int('x3-highwayFloor'),
                            synaptomeFloor:            int('x3-synaptomeFloor') },
      highwayRefresh:     { enabled: chk('x3-highwayRefresh-en', false) },
      loadBalancing:      { enabled: chk('x3-loadBalancing-en', false) },
      // NX-10 dendritic pub/sub
      dendritic:          { enabled: chk('x3-dendritic-en'),
                            capacity:                  int('x3-dendriticCapacity'),
                            ttl:                       int('x3-dendriticTtl') },
      // NX-5 incoming promotion
      incomingPromotion:  { threshold:                 int('x3-incomingPromoteThreshold') },
      // NX-6 churn
      churnReheat:        { tReheat:                   num('x3-tReheat') },
      deadEviction:       { enabled: chk('x3-deadEviction-en') },
    };
  }

  /** Read all NX-15 (pub/sub membership) parameters from DOM inputs. */
  getNX15Params() {
    const num = id => { const el = this._el(id); return el ? parseFloat(el.value) : undefined; };
    const int = id => { const el = this._el(id); return el ? parseInt(el.value) : undefined; };

    return {
      rootSetSize:          int('x15-rootSetSize'),
      maxDirectSubs:        int('x15-maxDirectSubs'),
      minDirectSubs:        int('x15-minDirectSubs'),
      refreshIntervalMs:    int('x15-refreshIntervalMs'),
      maxSubscriptionAgeMs: int('x15-maxSubscriptionAgeMs'),
      rootGraceMs:          int('x15-rootGraceMs'),
      reorderWindowMs:      int('x15-reorderWindowMs'),
    };
  }

  // ── Button state management ──────────────────────────────────────────────

  setRunning(running) {
    // btnBenchmark is managed independently by setBenchmarking(); exclude it here.
    ['btnInit', 'btnLookupTest', 'btnChurnTest', 'btnDemoLookup', 'btnSliceWorld',
     'btnBenchmark', 'btnTrainNetwork', 'btnPubSub', 'btnPairLearning', 'btnHotspotTest', 'btnAddNodes']
      .forEach(id => { const el = this._el(id); if (el) el.disabled = running; });
  }

  setDemo(active) {
    const demoBtn = this._el('btnDemoLookup');
    if (demoBtn) {
      demoBtn.disabled = false;   // always clickable — it's the stop control when active
      if (active) {
        demoBtn.textContent = '⏹ Stop Demo';
        demoBtn.classList.add('active');
      } else {
        demoBtn.textContent = '▶ Demo';
        demoBtn.classList.remove('active');
      }
    }
    ['btnInit', 'btnLookupTest', 'btnChurnTest', 'btnBenchmark', 'btnSliceWorld',
     'btnTrainNetwork', 'btnPubSub', 'btnPairLearning', 'btnHotspotTest', 'btnAddNodes']
      .forEach(id => { const b = this._el(id); if (b) b.disabled = active; });
  }

  setBenchmarking(active) {
    // During benchmarking: disable everything except the benchmark button itself
    // (which becomes "⏹ Stop Benchmark").
    const btns = ['btnInit', 'btnLookupTest', 'btnChurnTest', 'btnDemoLookup', 'btnSliceWorld', 'btnAddNodes'];
    btns.forEach(id => {
      const el = this._el(id);
      if (el) el.disabled = active;
    });
    const trainBtn = this._el('btnTrainNetwork');
    if (trainBtn) trainBtn.disabled = active;
    const concBtn = this._el('btnPubSub');
    if (concBtn) concBtn.disabled = active;
    const pairBtn2 = this._el('btnPairLearning');
    if (pairBtn2) pairBtn2.disabled = active;
    const hotBtn2 = this._el('btnHotspotTest');
    if (hotBtn2) hotBtn2.disabled = active;

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

  setPubSub(active) {
    const btns = ['btnInit', 'btnLookupTest', 'btnChurnTest', 'btnDemoLookup', 'btnBenchmark', 'btnTrainNetwork', 'btnPairLearning', 'btnAddNodes'];
    btns.forEach(id => {
      const el = this._el(id);
      if (el) el.disabled = active;
    });
    const concBtn = this._el('btnPubSub');
    if (concBtn) {
      concBtn.disabled = false;
      if (active) {
        concBtn.textContent = '⏹ Stop Pub/Sub';
        concBtn.classList.add('active');
      } else {
        concBtn.textContent = '⊕ Pub/Sub';
        concBtn.classList.remove('active');
      }
    }
  }

  setPairLearning(active) {
    const btns = ['btnInit', 'btnLookupTest', 'btnChurnTest', 'btnDemoLookup',
                  'btnBenchmark', 'btnTrainNetwork', 'btnPubSub', 'btnAddNodes'];
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
    const btns = ['btnInit', 'btnLookupTest', 'btnChurnTest', 'btnDemoLookup', 'btnBenchmark', 'btnPubSub', 'btnPairLearning', 'btnHotspotTest', 'btnAddNodes'];
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

  setHotspotTesting(active) {
    const btn = this._el('btnHotspotTest');
    if (btn) {
      btn.disabled = false;
      if (active) {
        btn.textContent = '⏹ Stop Hotspot';
        btn.classList.add('active');
      } else {
        btn.textContent = '🌡 Hotspot';
        btn.classList.remove('active');
      }
    }
    ['btnInit','btnLookupTest','btnChurnTest','btnDemoLookup',
     'btnTrainNetwork','btnPubSub','btnPairLearning','btnBenchmark','btnAddNodes']
      .forEach(id => { const b = this._el(id); if (b) b.disabled = active; });
  }

  updateNodeCount(n) {
    const txt = `${n} active`;
    const b1 = this._el('activeNodeCount');
    const b2 = this._el('activeNodeCountChurn');
    if (b1) b1.textContent = txt;
    if (b2) b2.textContent = txt;
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

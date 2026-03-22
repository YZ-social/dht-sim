/**
 * Results – renders test outcomes into the results panel.
 * Uses Chart.js (loaded globally as `Chart`) for histograms and time-series.
 */
export class Results {
  constructor(panelId = 'resultsOverlay') {
    this.panel = document.getElementById(panelId);
    this._charts = {};
    this._trainingHistory    = null;
    this._pubsubHistory = null;
    this._pairHistory        = null;
    this._benchmarkRows      = null;  // set by showBenchmarkResults
    this._lastLookupResult   = null;
    this._lastChurnResult    = null;
    this._hotspotData        = null;
  }

  // ── CSV download helpers ──────────────────────────────────────────────────

  /**
   * Trigger a browser download of `csvString` as `filename`.
   */
  _downloadCSV(csvString, filename) {
    const blob = new Blob([csvString], { type: 'text/csv;charset=utf-8;' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.style.display = 'none';
    a.href     = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    setTimeout(() => {
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
    }, 100);
  }

  /**
   * Insert (or replace) a title bar as the FIRST CHILD of the panel div
   * identified by `panelId`.  Title is left-justified; ⬇ CSV button is right.
   * `csvFn` is called at click-time so it always captures current data.
   */
  _attachPanelHeader(panelId, title, csvFn, filename) {
    const panel = document.getElementById(panelId);
    if (!panel) return;
    // Remove any previous panel header
    const existing = panel.querySelector(':scope > .panel-title-bar');
    if (existing) existing.remove();
    const bar = document.createElement('div');
    bar.className = 'panel-title-bar';
    const lbl = document.createElement('span');
    lbl.className   = 'panel-title';
    lbl.textContent = title;
    const btn = document.createElement('button');
    btn.className   = 'chart-dl-btn';
    btn.textContent = '⬇ CSV';
    btn.title       = 'Download data as CSV';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const csv = csvFn();
      if (csv) this._downloadCSV(csv, filename);
    });
    bar.appendChild(lbl);
    bar.appendChild(btn);
    panel.insertBefore(bar, panel.firstChild);
  }

  /**
   * Insert (or replace) a small header row immediately BEFORE the chart-box
   * element identified by `beforeId`.  Used for sub-charts inside a panel.
   */
  _attachChartHeader(beforeId, title, csvFn, filename) {
    const target = document.getElementById(beforeId);
    if (!target) return;
    const prev = target.previousElementSibling;
    if (prev?.classList.contains('chart-header')) prev.remove();
    const hdr = document.createElement('div');
    hdr.className = 'chart-header';
    const lbl = document.createElement('span');
    lbl.className   = 'chart-header-title';
    lbl.textContent = title;
    const btn = document.createElement('button');
    btn.className   = 'chart-dl-btn';
    btn.textContent = '⬇ CSV';
    btn.title       = 'Download chart data as CSV';
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const csv = csvFn();
      if (csv) this._downloadCSV(csv, filename);
    });
    hdr.appendChild(lbl);
    hdr.appendChild(btn);
    target.parentNode.insertBefore(hdr, target);
  }

  _el(id) { return document.getElementById(id); }

  // ── Lookup Test Results ──────────────────────────────────────────────────

  showLookupResults(result) {
    this._lastLookupResult = result;
    this._attachPanelHeader('lookupResults', 'Lookup Test', () => this._lookupHopsCSV(), `dht-lookup-${Date.now()}.csv`);
    const { hops, time, totalRuns, successes, failures, successRate } = result;

    this._setText('resNodeCount',    this._el('nodeCountVal')?.value ?? '—');
    this._setText('resProtocol',     document.getElementById('dhtProtocol')?.selectedOptions[0]?.text ?? '—');
    this._setText('resTotalRuns',    totalRuns.toLocaleString());
    this._setText('resSuccessRate',  `${(successRate * 100).toFixed(1)}%`);
    this._setText('resFailures',     failures.toLocaleString());
    const regionalOn     = document.getElementById('regionalMode')?.checked ?? false;
    const regionalRadius = parseInt(document.getElementById('regionalRadius')?.value ?? 2000);
    const destOn         = document.getElementById('destMode')?.checked ?? false;
    const destPct        = parseInt(document.getElementById('destPct')?.value ?? 10);
    const modeLabel      = destOn    ? `Dest ${destPct}%`
                         : regionalOn ? `Regional ≤${regionalRadius} km`
                         : 'Global';
    this._setText('resMode', modeLabel);
    const modeEl = this._el('resMode');
    if (modeEl) modeEl.style.color = destOn ? '#44ddff' : regionalOn ? '#ffff44' : '';

    if (hops) {
      this._setText('resAvgHops',  hops.mean.toFixed(2));
      this._setText('resP50Hops',  hops.median.toFixed(1));
      this._setText('resP95Hops',  hops.p95.toFixed(1));
      this._setText('resMaxHops',  hops.max);
    }
    if (time) {
      this._setText('resAvgTime',  `${time.mean.toFixed(1)} ms`);
      this._setText('resP50Time',  `${time.median.toFixed(1)} ms`);
      this._setText('resP95Time',  `${time.p95.toFixed(1)} ms`);
      this._setText('resMaxTime',  `${time.max.toFixed(1)} ms`);
    }

    this._showSection('lookupResults');
    this._hideSection('churnResults');
    this._hideSection('demoResults');
    this._hideSection('benchmarkResults');
    this._hideSection('trainingResults');
    this._hideSection('pubsubResults');
    this._hideSection('pairResults');
    this._hideSection('hotspotResults');
    this.panel?.classList.remove('bench-wide');

    if (result.hopsRaw && result.timeRaw) {
      requestAnimationFrame(() => {
        this._drawHistogram('hopsHistChart', result.hopsRaw, 'Hop Distribution', '#00ff88');
        this._drawHistogram('timeHistChart', result.timeRaw, 'Time Distribution (ms)', '#ffaa00');
        this._attachChartHeader('hopsChartBox', 'Hop Distribution', () => this._lookupHopsCSV(), `dht-hops-${Date.now()}.csv`);
        this._attachChartHeader('timeChartBox', 'Latency Distribution', () => this._lookupTimeCSV(), `dht-time-${Date.now()}.csv`);
      });
    }
  }

  // ── Demo Lookup Results ──────────────────────────────────────────────────

  showDemoResults(result) {
    this._setText('demoProtocol',  document.getElementById('dhtProtocol')?.selectedOptions[0]?.text ?? '—');
    this._setText('demoNodeCount', document.getElementById('nodeCountVal')?.value ?? '—');
    this._setText('demoHops',      result.hops ?? '—');
    this._setText('demoTime',      result.time != null ? `${result.time.toFixed(1)} ms` : '—');
    this._setText('demoPathLen',   result.path?.length ?? '—');
    this._setText('demoSuccess',   result.found ? 'Found ✓' : 'Failed ✗');

    const successEl = this._el('demoSuccess');
    if (successEl) successEl.style.color = result.found ? '#00ff88' : '#ff4444';

    const regionalOn     = document.getElementById('regionalMode')?.checked ?? false;
    const regionalRadius = parseInt(document.getElementById('regionalRadius')?.value ?? 2000);
    this._setText('demoMode', regionalOn ? `Regional ≤${regionalRadius} km` : 'Global');
    const modeEl = this._el('demoMode');
    if (modeEl) modeEl.style.color = regionalOn ? '#ffff44' : '';

    this._showSection('demoResults');
    this._hideSection('lookupResults');
    this._hideSection('churnResults');
    this._hideSection('benchmarkResults');
    this._hideSection('trainingResults');
    this._hideSection('pubsubResults');
    this._hideSection('pairResults');
    this._hideSection('hotspotResults');
    this.panel?.classList.remove('bench-wide');
  }

  // ── Training Results ─────────────────────────────────────────────────────

  /**
   * Called once to show the training panel (first session completed).
   * Subsequent sessions call updateTrainingProgress.
   */
  showTrainingResults(history) {
    this._showSection('trainingResults');
    this._hideSection('lookupResults');
    this._hideSection('churnResults');
    this._hideSection('demoResults');
    this._hideSection('benchmarkResults');
    this._hideSection('pubsubResults');
    this._hideSection('pairResults');
    this._hideSection('hotspotResults');
    this.panel?.classList.remove('bench-wide');
    this._attachPanelHeader('trainingResults', 'Train Network', () => this._trainingCSV(), `dht-training-${Date.now()}.csv`);
    this._updateTrainingStats(history);
    requestAnimationFrame(() => this._drawTrainingChart(history));
  }

  updateTrainingProgress(history) {
    if (!history.length) return;
    this._updateTrainingStats(history);
    // Call synchronously: chart already exists and canvas has dimensions,
    // so no rAF needed — and rAF batching prevents incremental updates.
    this._drawTrainingChart(history);
  }

  _updateTrainingStats(history) {
    if (!history.length) return;
    const s = history[history.length - 1];
    this._setText('trainSession',  s.session);
    this._setText('trainEpoch',    s.epoch.toLocaleString());
    this._setText('trainAvgSyn',   s.avgSynapses != null ? s.avgSynapses.toFixed(1) : '—');
    this._setText('trainSuccess',  `${(s.successRate * 100).toFixed(1)}%`);
    this._setText('trainAvgHops',  s.hops?.mean != null ? s.hops.mean.toFixed(2) : '—');
    this._setText('trainAvgTime',  s.time?.mean != null ? `${s.time.mean.toFixed(1)} ms` : '—');

    // Build the row HTML (shared between baseline pin and rolling log)
    const sessionLabel = s.isBaseline ? '◆ base' : `#${s.session}`;
    const rowHTML =
      `<span class="tl-session">${sessionLabel}</span>` +
      `<span class="tl-hops">hops ${s.hops?.mean != null ? s.hops.mean.toFixed(2) : '—'}</span>` +
      `<span class="tl-time">${s.time?.mean != null ? s.time.mean.toFixed(1) + ' ms' : '—'}</span>` +
      `<span class="tl-success">${(s.successRate * 100).toFixed(1)}%</span>` +
      `<span class="tl-meta">syn ${s.avgSynapses != null ? s.avgSynapses.toFixed(1) : '—'}` +
      (s.isBaseline ? ' · pre-training' : ` · epoch ${s.epoch}`) + '</span>';

    if (s.isBaseline) {
      // Sticky pinned baseline — always visible above the session log
      const pin = this._el('trainingBaseline');
      if (pin) {
        const row = document.createElement('div');
        row.className = 'training-log-row';
        row.innerHTML = rowHTML;
        pin.innerHTML = '';
        pin.appendChild(row);
      }
    } else {
      // Rolling session log
      const log = this._el('trainingLog');
      if (log) {
        const row = document.createElement('div');
        row.className = 'training-log-row';
        row.innerHTML = rowHTML;
        log.appendChild(row);
        log.scrollTop = log.scrollHeight;
      }
    }
  }

  _drawTrainingChart(history) {
    this._trainingHistory = history;
    const canvas = this._el('trainingLineChart');
    if (!canvas || typeof Chart === 'undefined' || history.length < 1) return;

    const labels = history.map(s => s.isBaseline ? '◆ base' : `#${s.session}`);
    const small  = { size: 10, family: "'JetBrains Mono','Fira Mono','Consolas',monospace" };

    // Per-point styling: baseline gets a larger diamond, training gets a circle
    const hopPointStyles  = history.map(s => s.isBaseline ? 'rectRot' : 'circle');
    const hopPointRadii   = history.map(s => s.isBaseline ? 5 : 1);
    const timePointStyles = history.map(s => s.isBaseline ? 'rectRot' : 'circle');
    const timePointRadii  = history.map(s => s.isBaseline ? 5 : 1);

    if (this._charts['trainingLineChart']) {
      // Incremental update — push new point without destroying
      const chart = this._charts['trainingLineChart'];
      chart.data.labels = labels;
      chart.data.datasets[0].data        = history.map(s => s.hops?.mean ?? null);
      chart.data.datasets[0].pointStyle  = hopPointStyles;
      chart.data.datasets[0].pointRadius = hopPointRadii;
      chart.data.datasets[1].data        = history.map(s => s.time?.mean ?? null);
      chart.data.datasets[1].pointStyle  = timePointStyles;
      chart.data.datasets[1].pointRadius = timePointRadii;
      chart.update('none');
      return;
    }

    // Vertical annotation at x=0 (baseline) via a custom plugin
    const baselineLinePlugin = {
      id: 'baselineLine',
      afterDraw(chart) {
        if (chart.data.labels.length < 1) return;
        const ctx    = chart.ctx;
        const xScale = chart.scales.x;
        const yScale = chart.scales.yHops;
        const x      = xScale.getPixelForTick(0);
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(x, yScale.top);
        ctx.lineTo(x, yScale.bottom);
        ctx.strokeStyle = 'rgba(100,130,200,0.35)';
        ctx.lineWidth   = 1;
        ctx.setLineDash([4, 4]);
        ctx.stroke();
        ctx.restore();
      },
    };

    this._charts['trainingLineChart'] = new Chart(canvas, {
      type: 'line',
      plugins: [baselineLinePlugin],
      data: {
        labels,
        datasets: [
          {
            label: 'Avg Hops',
            data: history.map(s => s.hops?.mean ?? null),
            borderColor: '#00ff88',
            backgroundColor: '#00ff8818',
            yAxisID: 'yHops',
            tension: 0.3,
            pointStyle:  hopPointStyles,
            pointRadius: hopPointRadii,
            pointBackgroundColor: history.map(s => s.isBaseline ? '#00ff88' : '#00ff8888'),
            borderWidth: 2,
          },
          {
            label: 'Avg Time (ms)',
            data: history.map(s => s.time?.mean ?? null),
            borderColor: '#ffaa00',
            backgroundColor: '#ffaa0018',
            yAxisID: 'yTime',
            tension: 0.3,
            pointStyle:  timePointStyles,
            pointRadius: timePointRadii,
            pointBackgroundColor: history.map(s => s.isBaseline ? '#ffaa00' : '#ffaa0088'),
            borderWidth: 2,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        animation: false,
        plugins: {
          legend: {
            position: 'bottom',
            labels: { color: '#bbccee', font: small, boxWidth: 12, padding: 8 },
          },
          tooltip: {
            callbacks: {
              title: (items) => {
                const s = history[items[0]?.dataIndex];
                return s?.isBaseline ? '◆ Baseline (pre-training)' : `Session #${s?.session}`;
              },
            },
          },
        },
        scales: {
          x: {
            ticks: { color: '#99aacc', font: small, maxTicksLimit: 14 },
            grid:  { color: '#1a2a44' },
          },
          yHops: {
            type: 'linear', position: 'left',
            ticks: { color: '#00ff88', font: small },
            grid:  { color: '#1a2a4466' },
            title: { display: true, text: 'Hops', color: '#00ff88', font: small },
          },
          yTime: {
            type: 'linear', position: 'right',
            ticks: { color: '#ffaa00', font: small },
            grid:  { drawOnChartArea: false },
            title: { display: true, text: 'ms', color: '#ffaa00', font: small },
          },
        },
      },
    });
  }

  _trainingCSV() {
    if (!this._trainingHistory?.length) return '';
    const rows = [
      ['Session', 'Avg Hops', 'Avg Time (ms)',
       'Success Rate', 'Avg Synapses', 'Epoch'].join(','),
    ];
    for (const s of this._trainingHistory) {
      rows.push([
        s.isBaseline ? 'baseline' : s.session,
        s.hops?.mean  != null ? s.hops.mean.toFixed(3)  : '',
        s.time?.mean  != null ? s.time.mean.toFixed(2)  : '',
        s.successRate != null ? (s.successRate * 100).toFixed(2) + '%' : '',
        s.avgSynapses != null ? s.avgSynapses.toFixed(1) : '',
        s.epoch       != null ? s.epoch : '',
      ].join(','));
    }
    return rows.join('\r\n');
  }

  /** Clear training log and destroy training chart (called on new Init). */
  clearTraining() {
    const pin = this._el('trainingBaseline');
    if (pin) pin.innerHTML = '';
    const log = this._el('trainingLog');
    if (log) log.innerHTML = '';
    if (this._charts['trainingLineChart']) {
      this._charts['trainingLineChart'].destroy();
      delete this._charts['trainingLineChart'];
    }
    this._hideSection('trainingResults');
  }

  /** Clear pub/sub chart and log (called on new Init or new pub/sub run). */
  clearPubSub() {
    const log = this._el('pubsubLog');
    if (log) log.innerHTML = '';
    if (this._charts['pubsubLineChart']) {
      this._charts['pubsubLineChart'].destroy();
      delete this._charts['pubsubLineChart'];
    }
    this._pubsubHistory = null;
    this._hideSection('pubsubResults');
  }

  /** Clear pair-learning chart and log (called on new Init or new pair run). */
  clearPairLearning() {
    const log = this._el('pairLog');
    if (log) log.innerHTML = '';
    if (this._charts['pairLineChart']) {
      this._charts['pairLineChart'].destroy();
      delete this._charts['pairLineChart'];
    }
    this._hideSection('pairResults');
  }

  // ── Pair Learning Results ────────────────────────────────────────────────

  showPairResults(history) {
    this._showSection('pairResults');
    this._hideSection('lookupResults');
    this._hideSection('churnResults');
    this._hideSection('demoResults');
    this._hideSection('benchmarkResults');
    this._hideSection('trainingResults');
    this._hideSection('pubsubResults');
    this._hideSection('hotspotResults');
    this.panel?.classList.remove('bench-wide');
    this._attachPanelHeader('pairResults', 'Pair Learning', () => this._pairCSV(), `dht-pair-learning-${Date.now()}.csv`);
    this._updatePairStats(history);
    this._drawPairChart(history);
  }

  updatePairProgress(history) {
    if (!history.length) return;
    this._updatePairStats(history);
    this._drawPairChart(history);
  }

  _updatePairStats(history) {
    if (!history.length) return;
    const s       = history[history.length - 1];
    const base    = history[0];
    const curHops = s.hops?.mean ?? null;
    const basHops = base?.hops?.mean ?? null;
    const delta   = (curHops != null && basHops != null)
      ? (curHops - basHops).toFixed(2)
      : null;
    const deltaStr = delta != null
      ? (parseFloat(delta) <= 0 ? delta : `+${delta}`)
      : '—';

    this._setText('pairSession',  s.session);
    this._setText('pairCount',    s.pairs.toLocaleString());
    this._setText('pairAvgHops',  curHops != null ? curHops.toFixed(2) : '—');
    this._setText('pairBaseline', basHops != null ? basHops.toFixed(2) : '—');
    this._setText('pairDelta',    deltaStr);

    const deltaEl = this._el('pairDelta');
    if (deltaEl && delta != null) {
      deltaEl.style.color = parseFloat(delta) < 0 ? '#00ff88'
                          : parseFloat(delta) > 0 ? '#ff4444'
                          : '#7799cc';
    }

    // Rolling session log
    const log = this._el('pairLog');
    if (log) {
      const row = document.createElement('div');
      row.className = 'pair-log-row';
      row.innerHTML =
        `<span class="pl-session">#${s.session}</span>` +
        `<span class="pl-hops">hops ${curHops != null ? curHops.toFixed(2) : '—'}</span>` +
        `<span class="pl-time">${s.time?.mean != null ? s.time.mean.toFixed(1) + ' ms' : '—'}</span>` +
        `<span class="pl-delta">${deltaStr}</span>`;
      log.appendChild(row);
      log.scrollTop = log.scrollHeight;
    }
  }

  _drawPairChart(history) {
    this._pairHistory = history;
    const canvas = this._el('pairLineChart');
    if (!canvas || typeof Chart === 'undefined' || history.length < 1) return;

    const labels   = history.map(s => `#${s.session}`);
    const hopData  = history.map(s => s.hops?.mean  ?? null);
    const timeData = history.map(s => s.time?.mean  ?? null);

    // Y-axis: start at 1.0 (theoretical minimum), top at observed max
    const allHops = hopData.filter(v => v != null);
    const yMin = 1;
    const yMax = allHops.length ? Math.ceil(Math.max(...allHops) + 0.5) : 8;

    const small = { size: 10, family: "'JetBrains Mono','Fira Mono','Consolas',monospace" };

    if (this._charts['pairLineChart']) {
      const chart = this._charts['pairLineChart'];
      chart.data.labels = labels;
      chart.data.datasets[0].data = hopData;
      chart.data.datasets[1].data = timeData;
      chart.options.scales.yHops.min = yMin;
      chart.options.scales.yHops.max = yMax;
      chart.update('none');
      return;
    }

    // Dashed goal line at hops = 1
    const goalLinePlugin = {
      id: 'pairGoalLine',
      afterDraw(chart) {
        const ctx    = chart.ctx;
        const yScale = chart.scales.yHops;
        const xScale = chart.scales.x;
        if (!yScale || !xScale) return;
        const y = yScale.getPixelForValue(1);
        ctx.save();
        ctx.beginPath();
        ctx.moveTo(xScale.left, y);
        ctx.lineTo(xScale.right, y);
        ctx.strokeStyle = 'rgba(180,220,80,0.35)';
        ctx.lineWidth   = 1;
        ctx.setLineDash([4, 4]);
        ctx.stroke();
        ctx.restore();
      },
    };

    this._charts['pairLineChart'] = new Chart(canvas, {
      type: 'line',
      plugins: [goalLinePlugin],
      data: {
        labels,
        datasets: [
          {
            label: 'Avg Hops',
            data: hopData,
            borderColor: '#aaff44',
            backgroundColor: '#aaff4418',
            yAxisID: 'yHops',
            tension: 0.3,
            pointRadius: 3,
            borderWidth: 2,
          },
          {
            label: 'Avg Time (ms)',
            data: timeData,
            borderColor: '#ff8844',
            backgroundColor: '#ff884418',
            yAxisID: 'yTime',
            tension: 0.3,
            pointRadius: 3,
            borderWidth: 2,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        animation: false,
        plugins: {
          legend: {
            position: 'bottom',
            labels: { color: '#bbccee', font: small, boxWidth: 12, padding: 8 },
          },
          tooltip: {
            callbacks: {
              title: (items) => `Session ${history[items[0]?.dataIndex]?.session ?? ''}`,
            },
          },
        },
        scales: {
          x: {
            ticks: { color: '#99aacc', font: small, maxTicksLimit: 16 },
            grid:  { color: '#1a2a44' },
          },
          yHops: {
            type: 'linear', position: 'left',
            min: yMin,
            max: yMax,
            ticks: { color: '#aaff44', font: small },
            grid:  { color: '#1a2a4466' },
            title: { display: true, text: 'Avg Hops', color: '#aaff44', font: small },
          },
          yTime: {
            type: 'linear', position: 'right',
            ticks: { color: '#ff8844', font: small },
            grid:  { drawOnChartArea: false },
            title: { display: true, text: 'ms', color: '#ff8844', font: small },
          },
        },
      },
    });
  }

  _pairCSV() {
    if (!this._pairHistory?.length) return '';
    const base = this._pairHistory[0]?.hops?.mean ?? null;
    const rows = [
      ['Session', 'Pairs', 'Avg Hops', 'Avg Time (ms)', 'Delta Hops'].join(','),
    ];
    for (const s of this._pairHistory) {
      const delta = base != null && s.hops?.mean != null
        ? (s.hops.mean - base).toFixed(3) : '';
      rows.push([
        s.session,
        s.pairs ?? '',
        s.hops?.mean != null ? s.hops.mean.toFixed(3) : '',
        s.time?.mean != null ? s.time.mean.toFixed(2) : '',
        delta,
      ].join(','));
    }
    return rows.join('\r\n');
  }

  // ── Pub/Sub Results ──────────────────────────────────────────────────────

  showPubSubResults(history, numGroups, coverage) {
    this._showSection('pubsubResults');
    this._hideSection('lookupResults');
    this._hideSection('churnResults');
    this._hideSection('demoResults');
    this._hideSection('benchmarkResults');
    this._hideSection('trainingResults');
    this._hideSection('pairResults');
    this._hideSection('hotspotResults');
    this.panel?.classList.remove('bench-wide');
    this._attachPanelHeader('pubsubResults', 'Pub/Sub', () => this._pubsubCSV(), `dht-pubsub-${Date.now()}.csv`);
    this._updatePubSubStats(history, numGroups, coverage);
    requestAnimationFrame(() => this._drawPubSubChart(history));
  }

  _updatePubSubStats(history, numGroups, coverage) {
    if (!history.length) return;
    const s = history[history.length - 1];
    this._setText('psMessages', `${s.tick}`);
    this._setText('psGroups',   `${numGroups}`);
    this._setText('psCoverage', `${coverage}%`);
    this._setText('psMsgHops',  s.msgHops != null ? `${s.msgHops}` : '—');
    this._setText('psBcastHops', s.bcastAvg != null ? s.bcastAvg.toFixed(2) : '—');
    this._setText('psSimMs',    s.simMs != null ? `${s.simMs}` : '—');

    // Rolling log
    const log = this._el('pubsubLog');
    if (log) {
      const row = document.createElement('div');
      row.className = 'concordance-log-row';
      row.innerHTML =
        `<span class="cl-session">#${s.tick}</span>` +
        `<span class="cl-to">msg ${s.msgHops ?? '—'} hops</span>` +
        `<span class="cl-from">bcast ${s.bcastAvg != null ? s.bcastAvg.toFixed(1) : '—'}</span>` +
        `<span class="cl-ms">${s.simMs ?? '—'} ms</span>`;
      log.appendChild(row);
      log.scrollTop = log.scrollHeight;
    }
  }

  _drawPubSubChart(history) {
    this._pubsubHistory = history;
    const canvas = this._el('pubsubLineChart');
    if (!canvas || typeof Chart === 'undefined' || history.length < 1) return;

    // Keep a rolling window of the last 100 ticks for readability
    const WIN  = 100;
    const view = history.length > WIN ? history.slice(-WIN) : history;

    const labels    = view.map(s => `#${s.tick}`);
    const msgData   = view.map(s => s.msgHops   ?? null);
    const bcastData = view.map(s => s.bcastAvg  != null ? +s.bcastAvg.toFixed(2) : null);
    const msData    = view.map(s => s.simMs      ?? null);

    const allHops = [...msgData, ...bcastData].filter(v => v != null);
    const yHopMin = 1;
    const yHopMax = allHops.length ? Math.ceil(Math.max(...allHops) + 0.5) : 6;
    const allMs   = msData.filter(v => v != null);
    const yMsMax  = allMs.length ? Math.ceil(Math.max(...allMs) / 50) * 50 + 50 : 500;

    const small = { size: 10, family: "'JetBrains Mono','Fira Mono','Consolas',monospace" };

    if (this._charts['pubsubLineChart']) {
      const chart = this._charts['pubsubLineChart'];
      chart.data.labels            = labels;
      chart.data.datasets[0].data  = msgData;
      chart.data.datasets[1].data  = bcastData;
      chart.data.datasets[2].data  = msData;
      chart.options.scales.yHops.min = yHopMin;
      chart.options.scales.yHops.max = yHopMax;
      chart.options.scales.yMs.max   = yMsMax;
      chart.update('none');
      return;
    }

    this._charts['pubsubLineChart'] = new Chart(canvas, {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: 'Msg → Relay (hops)',
            data: msgData,
            borderColor: '#44ddff',
            backgroundColor: '#44ddff18',
            yAxisID: 'yHops',
            tension: 0.3,
            pointRadius: 2,
            borderWidth: 2,
          },
          {
            label: 'Broadcast avg (hops)',
            data: bcastData,
            borderColor: '#aa66ff',
            backgroundColor: '#aa66ff18',
            yAxisID: 'yHops',
            tension: 0.3,
            pointRadius: 2,
            borderWidth: 2,
          },
          {
            label: 'Sim latency (ms)',
            data: msData,
            borderColor: '#ffcc44',
            backgroundColor: '#ffcc4418',
            yAxisID: 'yMs',
            tension: 0.3,
            pointRadius: 2,
            borderWidth: 1.5,
            borderDash: [3, 3],
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        animation: false,
        plugins: {
          legend: {
            position: 'bottom',
            labels: { color: '#bbccee', font: small, boxWidth: 12, padding: 8 },
          },
          tooltip: {
            callbacks: {
              title: (items) => `Message ${view[items[0]?.dataIndex]?.tick ?? ''}`,
            },
          },
        },
        scales: {
          x: {
            ticks: { color: '#99aacc', font: small, maxTicksLimit: 12 },
            grid:  { color: '#1a2a44' },
          },
          yHops: {
            type: 'linear', position: 'left',
            min: yHopMin,
            max: yHopMax,
            ticks: { color: '#bbccee', font: small },
            grid:  { color: '#1a2a4466' },
            title: { display: true, text: 'Hops', color: '#bbccee', font: small },
          },
          yMs: {
            type: 'linear', position: 'right',
            min: 0,
            max: yMsMax,
            ticks: { color: '#ffcc44', font: small },
            grid:  { drawOnChartArea: false },
            title: { display: true, text: 'ms', color: '#ffcc44', font: small },
          },
        },
      },
    });
  }

  _pubsubCSV() {
    if (!this._pubsubHistory?.length) return '';
    const rows = [
      ['Tick', 'Groups', 'Coverage%', 'Msg Hops', 'Bcast Avg Hops', 'Total Hops', 'Sim ms'].join(','),
    ];
    for (const s of this._pubsubHistory) {
      rows.push([
        s.tick,
        s.groups    ?? '',
        s.coverage  ?? '',
        s.msgHops   ?? '',
        s.bcastAvg  != null ? s.bcastAvg.toFixed(3) : '',
        s.totalHops ?? '',
        s.simMs     ?? '',
      ].join(','));
    }
    return rows.join('\r\n');
  }

  _lookupHopsCSV() {
    if (!this._lastLookupResult) return '';
    const { hops, totalRuns, successes } = this._lastLookupResult;
    const rows = [
      ['Metric', 'Value'].join(','),
      ['Total Runs', totalRuns],
      ['Successes', successes],
      ['Avg Hops', hops?.mean?.toFixed(3) ?? ''],
      ['Median Hops', hops?.median?.toFixed(3) ?? ''],
      ['Max Hops', hops?.max ?? ''],
    ];
    if (hops?.histogram) {
      rows.push(['', '']);
      rows.push(['Hops', 'Count'].join(','));
      hops.histogram.forEach((count, idx) => {
        if (count > 0) rows.push([idx, count].join(','));
      });
    }
    return rows.join('\r\n');
  }

  _lookupTimeCSV() {
    if (!this._lastLookupResult) return '';
    const { time } = this._lastLookupResult;
    const rows = [
      ['Metric', 'Value'].join(','),
      ['Avg Time (ms)', time?.mean?.toFixed(2) ?? ''],
      ['Median Time (ms)', time?.median?.toFixed(2) ?? ''],
      ['Max Time (ms)', time?.max ?? ''],
    ];
    return rows.join('\r\n');
  }

  _churnCSV() {
    if (!this._lastChurnResult) return '';
    const timeSeries = this._lastChurnResult.timeSeries;
    if (!timeSeries?.length) return '';
    const rows = [
      ['Interval', 'Node Count', 'Nodes Replaced', 'Avg Hops', 'Avg Time (ms)', 'Success Rate'].join(','),
    ];
    for (const e of timeSeries) {
      rows.push([
        e.interval + 1,
        e.nodeCount ?? '',
        e.nodesReplaced ?? '',
        e.hops?.mean?.toFixed(3) ?? '',
        e.time?.mean?.toFixed(2) ?? '',
        e.successRate != null ? (e.successRate * 100).toFixed(2) + '%' : '',
      ].join(','));
    }
    return rows.join('\r\n');
  }

  // ── Churn Test Results ───────────────────────────────────────────────────

  showChurnResults(result) {
    this._lastChurnResult = result;
    const { timeSeries } = result;
    this._showSection('churnResults');
    this._hideSection('lookupResults');
    this._hideSection('demoResults');
    this._hideSection('benchmarkResults');
    this._hideSection('trainingResults');
    this._hideSection('pubsubResults');
    this._hideSection('pairResults');
    this._hideSection('hotspotResults');
    this.panel?.classList.remove('bench-wide');
    this._attachPanelHeader('churnResults', 'Churn Test', () => this._churnCSV(), `dht-churn-${Date.now()}.csv`);
    this._updateChurnStats(timeSeries);
    requestAnimationFrame(() => this._drawChurnChart(timeSeries));
  }

  updateChurnProgress(timeSeries) {
    if (timeSeries.length === 0) return;
    if (this._lastChurnResult) this._lastChurnResult.timeSeries = timeSeries;
    this._updateChurnStats(timeSeries);
    requestAnimationFrame(() => this._drawChurnChart(timeSeries));
  }

  _updateChurnStats(timeSeries) {
    if (!timeSeries.length) return;
    const last  = timeSeries[timeSeries.length - 1];
    const total = parseInt(this._el('churnIntervals')?.value ?? 10);
    this._setText('churnCurInterval', `${last.interval + 1} / ${total}`);
    this._setText('churnCurNodes',    last.nodeCount.toLocaleString());
    this._setText('churnCurReplaced', `−${last.nodesReplaced}`);
    this._setText('churnCurSuccess',  `${(last.successRate * 100).toFixed(1)}%`);
    this._setText('churnCurHops',     last.hops?.mean?.toFixed(2) ?? '—');
    this._setText('churnCurTime',
      last.time?.mean != null ? `${last.time.mean.toFixed(1)} ms` : '—');
  }

  // ── Histogram ────────────────────────────────────────────────────────────

  _drawHistogram(canvasId, data, label, color) {
    const canvas = this._el(canvasId);
    if (!canvas || typeof Chart === 'undefined') return;

    if (this._charts[canvasId]) {
      this._charts[canvasId].destroy();
    }

    const min = Math.min(...data);
    const max = Math.max(...data);
    const bins = Math.min(30, max - min + 1);
    const binSize = Math.max(1, (max - min) / bins);
    const buckets = Array.from({ length: bins }, (_, i) => ({
      label: (min + i * binSize).toFixed(0),
      count: 0,
    }));

    for (const v of data) {
      const idx = Math.min(bins - 1, Math.floor((v - min) / binSize));
      buckets[idx].count++;
    }

    this._charts[canvasId] = new Chart(canvas, {
      type: 'bar',
      data: {
        labels: buckets.map(b => b.label),
        datasets: [{
          label,
          data: buckets.map(b => b.count),
          backgroundColor: color + 'aa',
          borderColor: color,
          borderWidth: 1,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: { legend: { display: false } },
        scales: {
          x: { ticks: { color: '#99aacc', maxTicksLimit: 10 }, grid: { color: '#1a2a44' } },
          y: { ticks: { color: '#99aacc' }, grid: { color: '#1a2a44' } },
        },
      },
    });
  }

  // ── Churn time-series chart ──────────────────────────────────────────────

  _drawChurnChart(timeSeries) {
    const canvas = this._el('churnTimeChart');
    if (!canvas || typeof Chart === 'undefined' || !timeSeries.length) return;

    if (this._charts['churnTimeChart']) {
      this._charts['churnTimeChart'].destroy();
    }

    const labels = timeSeries.map(e => `I${e.interval + 1}`);
    const small  = { size: 10, family: "'JetBrains Mono','Fira Mono','Consolas',monospace" };

    this._charts['churnTimeChart'] = new Chart(canvas, {
      type: 'line',
      data: {
        labels,
        datasets: [
          {
            label: 'Avg Hops',
            data: timeSeries.map(e => e.hops?.mean ?? 0),
            borderColor: '#00ff88',
            backgroundColor: '#00ff8818',
            yAxisID: 'yHops',
            tension: 0.3,
            pointRadius: 3,
            borderWidth: 2,
          },
          {
            label: 'Success %',
            data: timeSeries.map(e => e.successRate * 100),
            borderColor: '#44aaff',
            backgroundColor: '#44aaff18',
            yAxisID: 'ySuccess',
            tension: 0.3,
            pointRadius: 3,
            borderWidth: 2,
          },
        ],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        plugins: {
          legend: {
            position: 'bottom',
            labels: { color: '#bbccee', font: small, boxWidth: 12, padding: 10 },
          },
          tooltip: {
            callbacks: {
              // Append time + node count to the tooltip body
              afterBody: (items) => {
                const e = timeSeries[items[0]?.dataIndex];
                if (!e) return '';
                const t = e.time?.mean != null ? `${e.time.mean.toFixed(1)} ms` : '—';
                return [`Avg Time: ${t}`, `Nodes: ${e.nodeCount}  (−${e.nodesReplaced})`];
              },
            },
          },
        },
        scales: {
          x: {
            ticks: { color: '#99aacc', font: small },
            grid:  { color: '#1a2a44' },
          },
          yHops: {
            type: 'linear', position: 'left',
            ticks: { color: '#00ff88', font: small },
            grid:  { color: '#1a2a4466' },
            title: { display: true, text: 'Avg Hops', color: '#00ff88', font: small },
          },
          ySuccess: {
            type: 'linear', position: 'right',
            max: 100,
            ticks: { color: '#44aaff', font: small, callback: v => v + '%' },
            grid:  { drawOnChartArea: false },
            title: { display: true, text: 'Success', color: '#44aaff', font: small },
          },
        },
      },
    });
  }

  // ── Benchmark Results ────────────────────────────────────────────────────

  /**
   * Render a multi-protocol × multi-radius comparison table.
   *
   * @param {object} benchResult  Return value from Engine.runBenchmark().
   * @param {number} nodeCount    Node count for the header.
   */
  showBenchmarkResults(benchResult, nodeCount) {
    const { protocolDefs, testSpecs, data } = benchResult;

    const container = this._el('benchmarkResults');
    if (!container) return;

    // Short display names for continent codes used in column headers and tooltips.
    const contName = { NA:'N.Am.', SA:'S.Am.', EU:'Europe', AF:'Africa', AS:'Asia', OC:'Oceania' };

    // Stable key and column label for each test spec.
    const specKey   = s => s.type === 'regional'  ? `r${s.radius}`
                         : s.type === 'dest'       ? `dest_${s.pct}`
                         : s.type === 'source'     ? `src_${s.pct}`
                         : s.type === 'srcdest'    ? `srcdest_${s.srcPct}_${s.destPct}`
                         : s.type === 'churn'      ? `churn_${s.rate}`
                         : s.type === 'continent'  ? `cont_${s.src}_${s.dst}`
                         : s.type === 'pubsub'     ? 'pubsub'
                         : 'global';
    const specLabel = s => s.type === 'regional'  ? `${s.radius} km`
                         : s.type === 'dest'       ? `${s.pct}% dest`
                         : s.type === 'source'     ? `${s.pct}% src`
                         : s.type === 'srcdest'    ? `${s.srcPct}%→${s.destPct}%`
                         : s.type === 'churn'      ? `${s.rate}% churn`
                         : s.type === 'continent'  ? `${contName[s.src]??s.src}→${contName[s.dst]??s.dst}`
                         : s.type === 'pubsub'     ? 'Pub/Sub'
                         : 'Global';
    const specTip   = s => s.type === 'regional'
      ? `Regional lookups: source and destination chosen within ${s.radius} km of each other. Tests geographic locality routing.`
      : s.type === 'dest'
      ? `Dest ${s.pct}%: all lookups target the same pool of ${s.pct}% hot destination nodes, from random sources. XOR-nearest selection gives structurally shorter paths, and Neuromorphic protocols learn these popular destinations faster.`
      : s.type === 'source'
      ? `Src ${s.pct}%: all lookups originate from the same pool of ${s.pct}% source nodes, with fully random destinations. No structural shortcut — performance is similar to global.`
      : s.type === 'srcdest'
      ? `Src${s.srcPct}%→Dest${s.destPct}%: lookups always originate from the same ${s.srcPct}% sender pool and target the same ${s.destPct}% receiver pool (non-overlapping). Models real-world traffic where a fixed set of clients sends to a fixed set of servers. N-4 lateral shortcut propagation means the entire sender cluster learns fast routes to receivers simultaneously.`
      : s.type === 'churn'
      ? `Churn ${s.rate}%: ${s.rate}% of nodes are replaced with fresh (state-free) nodes across 5 successive rounds before measurement. Neuromorphic protocols get 100 adaptation lookups between rounds to partially re-learn the changed topology. Tests steady-state routing resilience under ongoing node turnover.`
      : s.type === 'continent'
      ? `Cross-continental: sources drawn from ${contName[s.src]??s.src}, destinations from ${contName[s.dst]??s.dst}. Guaranteed to require at least one long trans-oceanic hop (~150–200 ms one-way). Tests whether long-range XOR strata are preserved after regional specialisation — the exact problem N-5's stratified synaptome was designed to solve. Neuromorphic protocols receive continent-crossing warmup lookups so trans-oceanic shortcuts can form before measurement.`
      : s.type === 'pubsub'
      ? `Pub/Sub overlay: nodes form ${s.coverage ?? 10}% coverage concordance groups (1 relay + ${s.groupSize ?? 32} participants each). Left column (→relay) = avg hops from a random participant to its relay. Right column (bcast) = avg hops from the relay back to each participant. Neuromorphic protocols receive 2× the standard warmup budget using actual pub/sub traffic so synaptomes learn relay-centric routes before measurement.`
      : 'Global: both source and destination chosen uniformly at random from all nodes. Worst-case baseline — no locality or hot-spot bias.';

    // Protocol row tooltip descriptions.
    const protoTips = {
      kademlia:  'Classic Kademlia: XOR-metric k-bucket routing with α-parallel iterative node lookups. No geographic awareness.',
      geo8:      'Geo-DHT-8: XOR routing with an 8-bit S2 geographic cell prefix embedded in node IDs. Biases routing toward physically nearby nodes.',
      ngdht:     'Neuromorphic-1 (N-1): Hebbian synapse weighting layered on top of geographic routing. Synapses strengthen on frequently used paths. First-generation adaptive DHT.',
      ngdht2:    'Neuromorphic-2 (N-2): Adds two-hop lookahead AP (advance-per-latency) selection and triadic-closure hop caching to N-1. Learns shortcut connections through intermediate nodes.',
      ngdht2bp:  'Ablation — N-2 + Cascade Backpropagation only (N-2-BP): when a direct-to-target shortcut fires at a gateway node, all upstream path nodes learn a synapse to that gateway. Marginally better than N-2 alone because shortcuts must already exist to trigger the cascade.',
      ngdht2shc: 'Ablation — N-2 + Source-Inclusive Hop Caching only (N-2-SHC): the source node itself caches a direct synapse to the target after every successful lookup (N-2 excluded the source). Fires unconditionally, rapidly seeding direct shortcuts throughout the network.',
      ngdht3:    'Neuromorphic-3 (N-3): N-2 + source-inclusive hop caching + cascade backpropagation + tuned constants (denser bootstrap, longer synapse lifetime, stronger intra-regional weight). Full synergy: hop caching seeds shortcuts that cascade then propagates to all upstream nodes — six new shortcuts per event.',
      ngdht4:    'Neuromorphic-4 (N-4): N-3 + two new mechanisms. (1) Lateral shortcut propagation: when any node learns a new direct route to a target, it immediately shares that shortcut with its top-3 same-region routing neighbours — the entire local sender cluster benefits from the first successful lookup. (2) Passive dead-node eviction: stale synapses to churned-out peers are zeroed on first encounter during routing, accelerating churn recovery vs. waiting for the decay schedule.',
      ngdht5:    'Neuromorphic-5 (N-5): N-4 + two new mechanisms that fix specialisation-induced interference. (1) Stratified Synaptome: the 32 XOR strata are grouped into 8 buckets; each bucket is guaranteed a minimum of 3 synapse slots. When the synaptome is full, eviction targets the most over-represented bucket — regional training can no longer crowd out the long-range inter-continental entries needed for global routing. (2) Simulated Annealing: each node carries a temperature that starts high and cools as it participates in lookups. After every hop, the node probabilistically replaces its weakest over-represented synapse with a candidate from the most under-represented stratum group — either globally random (high T, exploration) or from its 2-hop neighbourhood (low T, exploitation).',
      ngdht5w:   'Neuromorphic-5W (N-5W): Browser-realistic variant of N-5. Identical algorithms and all five inherited mechanisms but operates under real WebRTC resource constraints: synaptome cap reduced from 800 → 60 (matching the ~50–80 warm WebRTC PeerConnections a browser tab can sustain), bootstrap density halved (K_BOOT=1, 20 peers vs 40), and stratum floor adjusted to 2 to preserve meaningful eviction headroom at the tighter cap. Expected routing diameter at N=5,000: log(5000)/log(60) ≈ 2.2 hops vs N-5\'s 1.3 and Kademlia\'s 12.3. Use this to validate that neuromorphic routing remains competitive under real-world deployment constraints.',
      ngdht6w:   'Neuromorphic-6W (N-6W): Browser-realistic next-generation protocol with four mechanisms beyond N-5W. (1) Two-tier synaptome: 48 local (stratified/annealing) + 12 highway slots = 60 total WebRTC connections. Highway reserved for globally well-connected hub nodes, collapsing inter-continental routes to 1–2 hops. (2) Hub discovery: every 300 lookup participations, scan the 2-hop neighbourhood and fill highway with the nodes covering the most distinct stratum groups — simulates the gossip protocol a real deployment would use. (3) Adaptive temporal decay: each synapse tracks a use-count; frequently reinforced synapses decay near-zero (gamma≈0.9998) while unused bootstrap entries die quickly (gamma≈0.990), self-pruning the synaptome toward actually useful routes. (4) Markov hot-destination learning: source tracks its last 32 destinations; after a target appears 3 times, a direct synapse is eagerly pre-built before routing begins — fires even on failed lookups where hop-caching would never trigger.',
      ngdht7w:   'Neuromorphic-7W (N-7W): N-6W + load-balancing mechanisms targeting highway hotspot concentration (Gini 0.85 vs Kademlia\'s 0.84). (5) Per-node load EMA: each node tracks relay traffic via a lazy exponential moving average (LOAD_DECAY=0.995), updated only when visited. (6) Load-aware AP scoring: both 1-hop and 2-hop AP scores are discounted by a load penalty (up to 40% reduction at saturation), naturally steering lookups away from overloaded hubs. (7) Extended hub pool: highway widened to 20 slots, scan cap raised to 120 candidates, random noise (HUB_NOISE=1.0) added to diversity scores to prevent deterministic re-selection of the same hubs. (8) Adaptive Markov weight: Markov-triggered shortcuts get an initial weight proportional to destination frequency (0.3–0.9) rather than a fixed value.',
      ngdht8w:   'Neuromorphic-8W (N-8W): N-7W + cascading lateral spread (Mechanism 9). Tier split restored to N-6W values (48 local + 12 highway). Lateral spread deepened to depth 2: when node A learns a shortcut to target C, it tells its top-6 regional neighbours (depth-1); each of those tells their own top-2 regional neighbours (depth-2). Coverage per discovery: 1 + 6 + 12 = 19 nodes in the geographic cluster, vs 4 in N-7W. Addresses the scaling degradation seen at 50K nodes where synaptome-based annealing covers only 0.12% of the network; cascade spread propagates shortcuts through graph topology rather than random sampling, maintaining sub-logarithmic scaling.',
    };

    // Header row
    let html = `
      <div class="panel-title-bar">
        <span class="panel-title">Benchmark — ${nodeCount.toLocaleString()} nodes · 500 lookups/cell <span class="bench-title-note">· each cell: mean / p95</span></span>
        <button class="chart-dl-btn" id="benchCsvBtn">&#8595; CSV</button>
      </div>
      <div class="bench-table-wrap">
      <table class="bench-table">
        <thead>
          <tr>
            <th>Protocol</th>`;
    for (const s of testSpecs) {
      const cls = s.type === 'dest'      ? ' class="dest-col"'
                : s.type === 'source'    ? ' class="src-col"'
                : s.type === 'srcdest'   ? ' class="srcdest-col"'
                : s.type === 'churn'     ? ' class="churn-col"'
                : s.type === 'continent' ? ' class="continent-col"'
                : s.type === 'pubsub'    ? ' class="pubsub-col"'
                : '';
      html += `<th colspan="2"${cls} data-tip="${specTip(s)}">${specLabel(s)}</th>`;
    }
    html += `
          </tr>
          <tr>
            <th></th>`;
    for (const s of testSpecs) {
      const isSrc       = s.type === 'source';
      const isDest      = s.type === 'dest';
      const isSrcDest   = s.type === 'srcdest';
      const isChurn     = s.type === 'churn';
      const isContinent = s.type === 'continent';
      const isPubSub    = s.type === 'pubsub';
      const sub = isSrc ? ' src-sub' : isDest ? ' dest-sub' : isSrcDest ? ' srcdest-sub' : isChurn ? ' churn-sub' : isContinent ? ' continent-sub' : isPubSub ? ' pubsub-sub' : '';
      if (isPubSub) {
        html += `<th class="sub${sub}">→relay</th><th class="sub${sub}">bcast</th>`;
      } else {
        html += `<th class="sub${sub}">hops</th><th class="sub${sub}">ms</th>`;
      }
    }
    html += `</tr></thead><tbody>`;

    // Find per-column minimums for winner highlighting
    const minHops = {};
    const minTime = {};
    for (const s of testSpecs) {
      const k = specKey(s);
      minHops[k] = Infinity;
      minTime[k] = Infinity;
      for (const def of protocolDefs) {
        const cell = data[def.key]?.[k];
        if (s.type === 'pubsub') {
          // pub/sub cells use msgHops (left) and bcastHops (right) instead of hops/time
          if (cell?.msgHops?.mean  != null && cell.msgHops.mean  < minHops[k]) minHops[k] = cell.msgHops.mean;
          if (cell?.bcastHops?.mean != null && cell.bcastHops.mean < minTime[k]) minTime[k] = cell.bcastHops.mean;
        } else {
          if (cell?.hops?.mean != null && cell.hops.mean < minHops[k]) minHops[k] = cell.hops.mean;
          if (cell?.time?.mean != null && cell.time.mean < minTime[k]) minTime[k] = cell.time.mean;
        }
      }
    }

    // Data rows
    for (const def of protocolDefs) {
      const rowTip = protoTips[def.key] ?? '';
      html += `<tr><td class="proto-name"${rowTip ? ` data-tip="${rowTip}"` : ''}>${def.label}</td>`;
      for (const s of testSpecs) {
        const k           = specKey(s);
        const cell        = data[def.key]?.[k];
        const isSrc       = s.type === 'source';
        const isDest      = s.type === 'dest';
        const isSrcDest   = s.type === 'srcdest';
        const isChurn     = s.type === 'churn';
        const isContinent = s.type === 'continent';
        const isPubSub    = s.type === 'pubsub';
        const specCls     = isSrc ? ' src-cell' : isDest ? ' dest-cell' : isSrcDest ? ' srcdest-cell' : isChurn ? ' churn-cell' : isContinent ? ' continent-cell' : isPubSub ? ' pubsub-cell' : '';

        // Pub/Sub cells store msgHops + bcastHops rather than hops + time
        if (isPubSub) {
          if (!cell || !cell.msgHops) {
            html += `<td class="no-data${specCls}" colspan="2">—</td>`;
            continue;
          }
          const msgH    = cell.msgHops.mean.toFixed(2);
          const bcastH  = cell.bcastHops?.mean != null ? cell.bcastHops.mean.toFixed(2) : '—';
          const p95msg  = cell.msgHops.p95  != null ? cell.msgHops.p95.toFixed(1)  : null;
          const p95bcst = cell.bcastHops?.p95 != null ? cell.bcastHops.p95.toFixed(1) : null;
          const msgWin   = cell.msgHops.mean   <= minHops[k] + 0.005;
          const bcastWin = cell.bcastHops?.mean != null && cell.bcastHops.mean <= minTime[k] + 0.005;
          html += `<td class="hops-cell${msgWin ? ' win' : ''}${specCls}">${msgH}${p95msg ? `<span class="p95">${p95msg}</span>` : ''}</td>`;
          html += `<td class="hops-cell${bcastWin ? ' win' : ''}${specCls}">${bcastH}${p95bcst ? `<span class="p95">${p95bcst}</span>` : ''}</td>`;
          continue;
        }

        if (!cell || !cell.hops) {
          html += `<td class="no-data${specCls}" colspan="2">—</td>`;
          continue;
        }
        const hops    = cell.hops.mean.toFixed(2);
        const ms      = cell.time?.mean  != null ? cell.time.mean.toFixed(1)  : '—';
        const p95hops = cell.hops.p95    != null ? cell.hops.p95.toFixed(1)   : null;
        const p95ms   = cell.time?.p95   != null ? cell.time.p95.toFixed(0)   : null;
        const sr      = cell.successRate < 0.99
          ? ` <span class="sr">${(cell.successRate * 100).toFixed(0)}%</span>` : '';

        const hopsWin = cell.hops.mean <= minHops[k] + 0.005;
        const timeWin = cell.time?.mean != null && cell.time.mean <= minTime[k] + 0.5;

        const p95HopsStr = p95hops ? `<span class="p95">${p95hops}</span>` : '';
        const p95MsStr   = p95ms   ? `<span class="p95">${p95ms}</span>`   : '';

        html += `<td class="hops-cell${hopsWin ? ' win' : ''}${specCls}">${hops}${sr}${p95HopsStr}</td>`;
        html += `<td class="time-cell${timeWin ? ' win' : ''}${specCls}">${ms}${p95MsStr}</td>`;
      }
      html += `</tr>`;
    }

    html += `</tbody></table></div>`;
    container.innerHTML = html;

    // Wire up benchmark CSV button (can't use addEventListener before innerHTML)
    const benchCsvBtn = container.querySelector('#benchCsvBtn');
    if (benchCsvBtn) {
      benchCsvBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        const csv = this._benchmarkCSV(benchResult, nodeCount);
        if (csv) this._downloadCSV(csv, `dht-benchmark-${Date.now()}.csv`);
      });
    }

    this._showSection('benchmarkResults');
    this._hideSection('lookupResults');
    this._hideSection('churnResults');
    this._hideSection('demoResults');
    this._hideSection('trainingResults');
    this._hideSection('pubsubResults');
    this._hideSection('pairResults');
    this._hideSection('hotspotResults');
    this.panel?.classList.add('bench-wide');
  }

  _benchmarkCSV(benchResult, nodeCount) {
    if (!benchResult) return '';
    const { protocolDefs, testSpecs, data } = benchResult;
    const csvSpecLabel = s => s.type === 'regional'  ? `${s.radius}km`
                            : s.type === 'dest'       ? `${s.pct}%dest`
                            : s.type === 'source'     ? `${s.pct}%src`
                            : s.type === 'srcdest'    ? `${s.srcPct}%→${s.destPct}%`
                            : s.type === 'churn'      ? `${s.rate}%churn`
                            : s.type === 'continent'  ? `${s.src}→${s.dst}`
                            : s.type === 'pubsub'     ? 'pubsub'
                            : 'global';
    const csvSpecKey   = s => s.type === 'regional'  ? `r${s.radius}`
                            : s.type === 'dest'       ? `dest_${s.pct}`
                            : s.type === 'source'     ? `src_${s.pct}`
                            : s.type === 'srcdest'    ? `srcdest_${s.srcPct}_${s.destPct}`
                            : s.type === 'churn'      ? `churn_${s.rate}`
                            : s.type === 'continent'  ? `cont_${s.src}_${s.dst}`
                            : s.type === 'pubsub'     ? 'pubsub'
                            : 'global';
    // Build header: Protocol, then two columns per spec
    // (pub/sub uses →relay hops + bcast hops; all others use hops + ms)
    const headerCols = ['Protocol'];
    for (const s of testSpecs) {
      const lbl = csvSpecLabel(s);
      if (s.type === 'pubsub') {
        headerCols.push(`${lbl} →relay hops`, `${lbl} bcast hops`);
      } else {
        headerCols.push(`${lbl} hops`, `${lbl} ms`);
      }
    }
    const rows = [headerCols.join(',')];
    for (const proto of protocolDefs) {
      const cols = [proto.label ?? proto.key];
      for (const s of testSpecs) {
        const key  = csvSpecKey(s);
        const cell = data?.[proto.key]?.[key];
        if (s.type === 'pubsub') {
          cols.push(
            cell?.msgHops?.mean   != null ? cell.msgHops.mean.toFixed(3)   : '',
            cell?.bcastHops?.mean != null ? cell.bcastHops.mean.toFixed(3) : '',
          );
        } else {
          cols.push(
            cell?.hops?.mean  != null ? cell.hops.mean.toFixed(3)  : '',
            cell?.time?.mean  != null ? cell.time.mean.toFixed(2)  : '',
          );
        }
      }
      rows.push(cols.join(','));
    }
    rows.unshift(`# DHT Benchmark — ${nodeCount?.toLocaleString()} nodes · 500 lookups/cell`);
    return rows.join('\r\n');
  }

  // ── Helpers ──────────────────────────────────────────────────────────────

  _setText(id, val) {
    const el = this._el(id);
    if (el) el.textContent = val;
  }

  _showSection(id) {
    const el = this._el(id);
    if (el) el.style.display = '';
  }

  _hideSection(id) {
    const el = this._el(id);
    if (el) el.style.display = 'none';
  }

  clear() {
    Object.values(this._charts).forEach(c => c.destroy?.());
    this._charts = {};
    this._hideSection('benchmarkResults');
    this._hideSection('pubsubResults');
    this._hideSection('pairResults');
    this._hideSection('hotspotResults');
    this.panel?.classList.remove('bench-wide');
  }

  // ── Hotspot Results ───────────────────────────────────────────────────────

  _destroyChart(key) {
    if (this._charts[key]) {
      this._charts[key].destroy();
      delete this._charts[key];
    }
  }

  clearHotspot() {
    this._hotspotData = null;
    this._destroyChart('highwayLorenz');
    this._destroyChart('storageLorenz');
    this._hideSection('hotspotResults');
  }

  showHotspotResults(data) {
    this._hotspotData = data;
    // Hide other panels
    ['lookupResults','churnResults','benchmarkResults',
     'trainingResults','pubsubResults','pairResults']
      .forEach(id => this._hideSection(id));

    this._attachPanelHeader('hotspotResults', 'Hotspot Test',
      () => this._hotspotCSV(), 'hotspot.csv');

    this._updateHotspotStats(data);
    this._drawHotspotCharts(data);
    document.getElementById('hotspotResults').style.display = '';
  }

  _updateHotspotStats(data) {
    const hw = data.highway;
    const st = data.storage;
    const fmt = (v, digits = 2) => (v ?? 0).toFixed(digits);
    const pct  = v => (v * 100).toFixed(1) + '%';

    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };
    set('hsHwGini',      fmt(hw.gini));
    set('hsHwTop1',      pct(hw.top1pctLoad));
    set('hsHwTop10',     pct(hw.top10pctLoad));
    set('hsHwMax',       hw.maxLoad);
    set('hsHwSuccess',   pct(hw.successRate));
    set('hsStGini',      fmt(st.gini));
    set('hsStTop10',     pct(st.top10pctItemLoad));
    set('hsStMax',       st.maxLoad);
    set('hsStSuccess',   pct(st.successRate));
    set('hsStItems',     st.numItems);
    set('hsStZipf',      st.zipfExponent.toFixed(1));
  }

  _drawHotspotCharts(data) {
    this._destroyChart('highwayLorenz');
    this._destroyChart('storageLorenz');

    const GRID   = 'rgba(30,90,160,0.2)';
    const LABEL  = '#7799cc';
    const EQUAL  = 'rgba(255,255,255,0.15)';

    // Shared Lorenz chart builder
    const drawLorenz = (canvasId, key, lorenz, color, title) => {
      const canvas = document.getElementById(canvasId);
      if (!canvas) return;
      const equalLine = [{ x: 0, y: 0 }, { x: 100, y: 100 }];
      const curveData = lorenz.xs.map((x, i) => ({ x, y: lorenz.ys[i] }));
      this._charts[key] = new Chart(canvas.getContext('2d'), {
        type: 'scatter',
        data: {
          datasets: [
            {
              label: 'Perfect equality',
              data: equalLine,
              borderColor: EQUAL,
              borderWidth: 1,
              borderDash: [4, 4],
              pointRadius: 0,
              showLine: true,
              fill: false,
            },
            {
              label: title,
              data: curveData,
              borderColor: color,
              backgroundColor: color.replace(')', ',0.12)').replace('rgb', 'rgba'),
              borderWidth: 1.5,
              pointRadius: 0,
              showLine: true,
              fill: { target: { value: 100 }, below: color.replace(')', ',0.06)').replace('rgb', 'rgba') },
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: false,
          plugins: {
            legend: { display: false },
            tooltip: {
              callbacks: {
                label: ctx => `${ctx.parsed.x.toFixed(1)}% of nodes → ${ctx.parsed.y.toFixed(1)}% of load`,
              },
            },
          },
          scales: {
            x: {
              type: 'linear', min: 0, max: 100,
              title: { display: true, text: 'Cumulative % of nodes (least→most loaded)', color: LABEL, font: { size: 10 } },
              ticks: { color: LABEL, font: { size: 9 }, callback: v => v + '%' },
              grid: { color: GRID },
            },
            y: {
              type: 'linear', min: 0, max: 100,
              title: { display: true, text: 'Cumulative % of traffic', color: LABEL, font: { size: 10 } },
              ticks: { color: LABEL, font: { size: 9 }, callback: v => v + '%' },
              grid: { color: GRID },
            },
          },
        },
      });
    };

    drawLorenz('highwayLorenzChart', 'highwayLorenz',
      data.highway.lorenz, 'rgb(255,140,40)',   'Routing relay load');
    drawLorenz('storageLorenzChart', 'storageLorenz',
      data.storage.lorenz, 'rgb(100,200,255)', 'Content query load');
  }

  _hotspotCSV() {
    if (!this._hotspotData) return '';
    const { highway: hw, storage: st } = this._hotspotData;
    const lines = [
      'Section,Metric,Value',
      `Highway,Gini,${hw.gini.toFixed(4)}`,
      `Highway,Top 1% node load,${(hw.top1pctLoad * 100).toFixed(2)}%`,
      `Highway,Top 10% node load,${(hw.top10pctLoad * 100).toFixed(2)}%`,
      `Highway,Max relay count,${hw.maxLoad}`,
      `Highway,Total transits,${hw.totalTransits}`,
      `Highway,Success rate,${(hw.successRate * 100).toFixed(2)}%`,
      `Highway,Nodes measured,${hw.numNodes}`,
      `Storage,Gini,${st.gini.toFixed(4)}`,
      `Storage,Top 10% item load,${(st.top10pctItemLoad * 100).toFixed(2)}%`,
      `Storage,Max item queries,${st.maxLoad}`,
      `Storage,Total queries,${st.totalQueries}`,
      `Storage,Success rate,${(st.successRate * 100).toFixed(2)}%`,
      `Storage,Content items,${st.numItems}`,
      `Storage,Zipf exponent,${st.zipfExponent}`,
      '',
      'Highway Lorenz Curve',
      'Node percentile,Cumulative load %',
      ...hw.lorenz.xs.map((x, i) => `${x.toFixed(2)},${hw.lorenz.ys[i].toFixed(2)}`),
      '',
      'Storage Lorenz Curve',
      'Item percentile,Cumulative queries %',
      ...st.lorenz.xs.map((x, i) => `${x.toFixed(2)},${st.lorenz.ys[i].toFixed(2)}`),
    ];
    return lines.join('\n');
  }
}

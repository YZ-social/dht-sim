import express    from 'express';
import { writeFile, unlink, appendFile, readFile } from 'fs/promises';
import { existsSync }   from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dirname  = dirname(fileURLToPath(import.meta.url));
const RESULTS    = join(__dirname, 'results');
const READY_FLAG = join(RESULTS, '.ready');
const RESEARCH_LOG = join(RESULTS, 'research.log');

// Queue of experiments posted by Claude.  The browser polls GET /api/experiment
// to pick one up; posting a new one overwrites any unstarted one.
let pendingExperiment = null;

const app  = express();
const PORT = 3000;

app.use(express.static(__dirname));
app.use(express.json({ limit: '10mb' }));

// ─────────────────────────────────────────────────────────────────────────────
// POST /complete
// Called by the app when a test finishes.
// Body: { type, csv, meta }
// Writes: results/<type>_latest.csv, results/<type>_<ts>.csv, results/.ready
// ─────────────────────────────────────────────────────────────────────────────
app.post('/complete', async (req, res) => {
  const { type = 'unknown', csv = '', meta = {} } = req.body;
  const ts      = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const latest  = join(RESULTS, `${type}_latest.csv`);
  const archive = join(RESULTS, `${type}_${ts}.csv`);
  const ready   = { type, ts, meta, latestFile: latest, archiveFile: archive };

  try {
    await writeFile(latest,     csv,                    'utf8');
    await writeFile(archive,    csv,                    'utf8');
    await writeFile(READY_FLAG, JSON.stringify(ready),  'utf8');
    console.log(`[complete] ${type} → ${archive}`);
    res.json({ ok: true, latestFile: latest, archiveFile: archive });
  } catch (err) {
    console.error('[complete] write error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

// DELETE /complete — Claude clears the flag after consuming the result.
app.delete('/complete', async (_req, res) => {
  try { await unlink(READY_FLAG); } catch { /* already gone */ }
  res.json({ ok: true });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /api/status
// Claude polls this to check whether a result is waiting.
// ─────────────────────────────────────────────────────────────────────────────
app.get('/api/status', (_req, res) => {
  const ready = existsSync(READY_FLAG);
  res.json({ ready, pendingExperiment: pendingExperiment !== null });
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/experiment
// Claude queues the next sweep run.
// Body: { runs: [{nodeCount, pubsubCoverage, protocols, tests, ...}],
//         label: string, hypothesis: string }
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/experiment', async (req, res) => {
  const { runs, label = '', hypothesis = '' } = req.body;
  if (!Array.isArray(runs) || runs.length === 0) {
    return res.status(400).json({ ok: false, error: 'runs must be a non-empty array' });
  }
  pendingExperiment = { runs, label, hypothesis, queuedAt: new Date().toISOString() };
  console.log(`[experiment] queued: "${label}" — ${runs.length} run(s)`);
  res.json({ ok: true, queued: pendingExperiment });
});

// GET /api/experiment
// Browser polls this; returns and clears the pending experiment (if any).
app.get('/api/experiment', (_req, res) => {
  const exp = pendingExperiment;
  pendingExperiment = null;
  res.json(exp ?? null);
});

// ─────────────────────────────────────────────────────────────────────────────
// POST /api/log
// Claude appends a research entry to results/research.log.
// Body: { entry: string }
// ─────────────────────────────────────────────────────────────────────────────
app.post('/api/log', async (req, res) => {
  const { entry = '' } = req.body;
  const ts   = new Date().toISOString();
  const line = `\n${'─'.repeat(72)}\n[${ts}]\n${entry}\n`;
  try {
    await appendFile(RESEARCH_LOG, line, 'utf8');
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ ok: false, error: err.message });
  }
});

// GET /api/log — Claude reads the full research log.
app.get('/api/log', async (_req, res) => {
  try {
    const content = await readFile(RESEARCH_LOG, 'utf8');
    res.type('text/plain').send(content);
  } catch {
    res.type('text/plain').send('(no research log yet)');
  }
});

// ─────────────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\nDHT Simulator running at http://localhost:${PORT}\n`);
});

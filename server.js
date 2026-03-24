import express    from 'express';
import { writeFile, unlink } from 'fs/promises';
import { fileURLToPath }     from 'url';
import { dirname, join }     from 'path';

const __dirname  = dirname(fileURLToPath(import.meta.url));
const RESULTS    = join(__dirname, 'results');
const READY_FLAG = join(RESULTS, '.ready');

const app  = express();
const PORT = 3000;

app.use(express.static(__dirname));
app.use(express.json({ limit: '10mb' }));

/**
 * POST /complete
 * Called by the app when a test finishes.
 * Body: { type: string, csv: string, meta: object }
 *
 * Writes:
 *   results/<type>_latest.csv   — always overwritten (Claude reads this)
 *   results/<type>_<ts>.csv     — timestamped archive
 *   results/.ready              — trigger file: Claude's watcher detects this
 */
app.post('/complete', async (req, res) => {
  const { type = 'unknown', csv = '', meta = {} } = req.body;
  const ts      = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const latest  = join(RESULTS, `${type}_latest.csv`);
  const archive = join(RESULTS, `${type}_${ts}.csv`);
  const ready   = { type, ts, meta, latestFile: latest, archiveFile: archive };

  try {
    await writeFile(latest,    csv,                     'utf8');
    await writeFile(archive,   csv,                     'utf8');
    await writeFile(READY_FLAG, JSON.stringify(ready),  'utf8');
    console.log(`[complete] ${type} → ${latest}`);
    res.json({ ok: true, latestFile: latest });
  } catch (err) {
    console.error('[complete] write error:', err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/**
 * DELETE /complete
 * Called by Claude after it has consumed the result, to clear the flag.
 */
app.delete('/complete', async (_req, res) => {
  try {
    await unlink(READY_FLAG);
    res.json({ ok: true });
  } catch {
    res.json({ ok: true }); // already gone is fine
  }
});

app.listen(PORT, () => {
  console.log(`\nDHT Simulator running at http://localhost:${PORT}\n`);
});

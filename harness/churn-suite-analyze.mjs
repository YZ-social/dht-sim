// =====================================================================
// churn-suite-analyze.mjs — read churn-suite JSONL, print a scenario table.
//
//   node harness/churn-suite-analyze.mjs [results/churn/matrix.jsonl ...]
//
// Per scenario (N/SUBS/PUBS/mode/pct): cold / recovered / warm mean±sd,
// effective post-recovery delivery, tree depth, orphan subs. Flags
// scenarios where warm < 99% (steady-state gap) or recovered < 80% (the
// deferred-delivery / replay path leaks).
// =====================================================================
import { readFileSync } from 'node:fs';

const files = process.argv.slice(2);
if (!files.length) files.push('results/churn/matrix.jsonl');

const rows = [];
for (const f of files) {
  let txt; try { txt = readFileSync(f, 'utf8'); } catch { console.error(`(skip ${f}: not found)`); continue; }
  for (const line of txt.split('\n')) {
    if (!line.trim()) continue;
    try { rows.push(JSON.parse(line)); } catch { /* */ }
  }
}
if (!rows.length) { console.error('no records'); process.exit(1); }

const pct = (x) => (x == null ? '  -  ' : `${x.toFixed(1)}%`.padStart(6));
const key = (s) => `${s.churnMode}/${s.churnPct}% N=${s.N} SUBS=${s.SUBS} PUBS=${s.PUBS}`;

// group records by scenario key (multiple matrix runs of the same scenario merge)
const byKey = new Map();
for (const r of rows) { const k = key(r.scenario); if (!byKey.has(k)) byKey.set(k, []); byKey.get(k).push(r); }

const mean = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0;
const sd   = (a) => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(mean(a.map(x => (x - m) ** 2))); };

console.log(`\nkernel ${rows[0].kernelVersion} · ${rows.length} record(s) · ${byKey.size} scenario(s)\n`);
console.log(['scenario'.padEnd(42), 'cold', '  sd', 'recov', 'warm', '  sd', 'eff', 'depth', 'orph', 'flag'].join(' '));
console.log('-'.repeat(108));

const order = { global: 0, relay: 1, root: 2 };
const keys = [...byKey.keys()].sort((a, b) => {
  const A = byKey.get(a)[0].scenario, B = byKey.get(b)[0].scenario;
  return (order[A.churnMode] - order[B.churnMode]) || (A.N - B.N) || (A.SUBS - B.SUBS) || (A.churnPct - B.churnPct);
});

for (const k of keys) {
  const recs = byKey.get(k);
  // pool all post-churn rounds across every rep of every record for this scenario
  const cr = recs.flatMap(r => r.reps.flat()).filter(r => r.round >= 1);
  if (!cr.length) continue;
  const cold = cr.map(r => r.cold.pct), warm = cr.map(r => r.warm.pct), rec = cr.map(r => r.recovered.pct);
  const depth = cr.map(r => r.tree.depth), orph = cr.map(r => r.tree.orphanSubs);
  // effective delivery = warm (post-recovery steady state); also show recovered-of-missed
  const warmM = mean(warm), recM = mean(rec);
  const flags = [];
  if (warmM < 99) flags.push('WARM<99');
  if (recM < 80 && mean(cold) < 99) flags.push('RECOV<80');
  console.log([
    k.padEnd(42), pct(mean(cold)), pct(sd(cold)).trim().padStart(4),
    pct(recM), pct(warmM), pct(sd(warm)).trim().padStart(4),
    pct(warmM), mean(depth).toFixed(1).padStart(5), mean(orph).toFixed(0).padStart(4),
    flags.join(',') || 'ok',
  ].join(' '));
}
console.log('\ncold=delivery immediately after churn · recov=% of cold-missed delivered after warm-up (deferred/replay)');
console.log('warm=converged steady-state after heal · eff=effective post-recovery delivery · depth/orph=tree shape\n');

// =====================================================================
// verify-artifacts.mjs — prove the via-AB artifact chain is complete and honest.
//
// Asserts a BIJECTION between the summary rows and the per-run jsonl records:
// every summary.tsv row (seed,rep,arm) has exactly one jsonl record with the
// same key and matching exit/planFp/execFp/warm/cold/recovered, and every jsonl
// record maps back to exactly one row. Then re-derives the paired aggregate.
// Exits non-zero on ANY mismatch, missing record, or orphan — so a contaminated
// or incomplete artifact set (e.g. an extra un-linked record) fails loudly.
//
// Usage: node harness/via-ab/verify-artifacts.mjs <summary.tsv> <jsonl-dir>
// =====================================================================
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const [summaryPath, jsonlDir] = process.argv.slice(2);
if (!summaryPath || !jsonlDir) { console.error('usage: verify-artifacts.mjs <summary.tsv> <jsonl-dir>'); process.exit(2); }

const fail = (m) => { console.error('FAIL: ' + m); process.exitCode = 1; };
const key = (seed, rep, arm) => `${seed}/${rep}/${arm}`;
const near = (a, b) => Math.abs(a - b) < 1e-9;

// ── load summary.tsv rows ──
const rows = readFileSync(summaryPath, 'utf8').trim().split('\n').filter(Boolean).map(l => {
  const [seed, rep, arm, exit, planFp, execFp, warm, cold, rec] = l.split('\t');
  return { seed: +seed, rep: +rep, arm, exit: +exit, planFp, execFp, warm: +warm, cold: +cold, rec: +rec };
});

// ── load jsonl records (one per file, one line) ──
const files = readdirSync(jsonlDir).filter(f => f.endsWith('.jsonl'));
const recs = [];
for (const f of files) {
  const lines = readFileSync(join(jsonlDir, f), 'utf8').trim().split('\n').filter(Boolean);
  if (lines.length !== 1) fail(`${f} has ${lines.length} records, expected exactly 1 (non-appending per-run file)`);
  for (const line of lines) {
    const j = JSON.parse(line);
    recs.push({ file: f, seed: j.seed, rep: j.rep, arm: j.arm ?? j.label,
      planFp: j.planFp, execFp: j.execFp, warm: j.summary.warm, cold: j.summary.cold, rec: j.summary.recovered });
  }
}

console.log(`summary rows: ${rows.length}   jsonl records: ${recs.length}   jsonl files: ${files.length}`);
if (rows.length !== recs.length) fail(`row/record count mismatch (${rows.length} vs ${recs.length})`);

// ── bijection: build maps, check each direction ──
const byKeyRec = new Map();
for (const r of recs) {
  if (r.rep == null || r.arm == null) { fail(`record ${r.file} missing seed/rep/arm identity`); continue; }
  const k = key(r.seed, r.rep, r.arm);
  if (byKeyRec.has(k)) fail(`duplicate jsonl record for ${k} (${r.file} and ${byKeyRec.get(k).file})`);
  byKeyRec.set(k, r);
}
const seenRec = new Set();
for (const row of rows) {
  const k = key(row.seed, row.rep, row.arm);
  const r = byKeyRec.get(k);
  if (!r) { fail(`no jsonl record for summary row ${k}`); continue; }
  seenRec.add(k);
  if (r.planFp !== row.planFp) fail(`${k} planFp mismatch: tsv ${row.planFp} vs jsonl ${r.planFp}`);
  if (r.execFp !== row.execFp) fail(`${k} execFp mismatch: tsv ${row.execFp} vs jsonl ${r.execFp}`);
  if (!near(r.warm, row.warm)) fail(`${k} warm mismatch: tsv ${row.warm} vs jsonl ${r.warm}`);
  if (!near(r.cold, row.cold)) fail(`${k} cold mismatch: tsv ${row.cold} vs jsonl ${r.cold}`);
  if (!near(r.rec, row.rec))   fail(`${k} recovered mismatch: tsv ${row.rec} vs jsonl ${r.rec}`);
}
for (const k of byKeyRec.keys()) if (!seenRec.has(k)) fail(`orphan jsonl record ${k} has no summary row`);

// ── frozen-plan invariant: planFp & execFp constant across a seed's reps/arms ──
const bySeed = new Map();
for (const row of rows) { if (!bySeed.has(row.seed)) bySeed.set(row.seed, []); bySeed.get(row.seed).push(row); }
for (const [seed, rs] of bySeed) {
  const pf = new Set(rs.map(r => r.planFp)), ef = new Set(rs.map(r => r.execFp));
  if (pf.size !== 1) fail(`seed ${seed} has ${pf.size} distinct planFp (frozen plan must be constant)`);
  if (ef.size !== 1) fail(`seed ${seed} has ${ef.size} distinct execFp (frozen plan must be constant)`);
  if (rs.some(r => r.exit !== 0)) fail(`seed ${seed} has a non-zero exit (censored/failed run)`);
}

// ── re-derive the aggregate (seed-weighted paired Δ = off − on) ──
const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
const sd = a => { if (a.length < 2) return 0; const m = mean(a); return Math.sqrt(a.reduce((s, x) => s + (x - m) ** 2, 0) / (a.length - 1)); };
const psW = [], psR = [];
for (const [, rs] of [...bySeed].sort((a, b) => a[0] - b[0])) {
  const off = rs.filter(r => r.arm === 'off').sort((a, b) => a.rep - b.rep);
  const on = rs.filter(r => r.arm === 'on').sort((a, b) => a.rep - b.rep);
  if (off.length !== on.length) fail(`seed ${rs[0].seed} arm imbalance off=${off.length} on=${on.length}`);
  psW.push(mean(off.map((r, i) => r.warm - on[i].warm)));
  psR.push(mean(off.map((r, i) => r.rec - on[i].rec)));
}
console.log(`aggregate seed-weighted n=${psW.length}: warm Δ ${mean(psW).toFixed(2)}±${sd(psW).toFixed(2)}  recovered Δ ${mean(psR).toFixed(2)}±${sd(psR).toFixed(2)}`);

if (process.exitCode) console.error('\nARTIFACT CHAIN INVALID.');
else console.log('\nPASS — 80 summary rows ↔ 80 jsonl records, bijective; fingerprints frozen per seed; aggregate re-derived.');

// =====================================================================
// nursery-analyze.mjs — W2 B5: aggregate the A/B/C sweep into a verdict.
//
// Reads results/w2/nursery.jsonl (one run per line), groups by (churn, arm),
// reports mean +/- sd per cell, computes the curated/ceiling and random/
// ceiling fill ratios, and prints a data-driven verdict against the
// greenlight bar (C >= 95% of god's-eye fill, >= 99% inbound reachability,
// majority mesh self-expansion, eclipse concentration bounded).
//
// Run:  node harness/nursery-analyze.mjs [path.jsonl]
// =====================================================================

import { readFileSync } from 'node:fs';

const path = process.argv[2] || 'results/w2/nursery.jsonl';
const rows = readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);

const mean = (xs) => xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
const sd = (xs) => { if (xs.length < 2) return 0; const m = mean(xs); return Math.sqrt(mean(xs.map(x => (x - m) ** 2))); };
const f = (x, d = 1) => x.toFixed(d);

// group by churn -> arm -> rows
const byChurn = new Map();
for (const r of rows) {
  if (!byChurn.has(r.churn)) byChurn.set(r.churn, new Map());
  const m = byChurn.get(r.churn);
  if (!m.has(r.arm)) m.set(r.arm, []);
  m.get(r.arm).push(r);
}

const ARMNAME = { A: 'A god\'s-eye', B: 'B random', C: 'C curated' };
console.log(`\nW2 bridge-nursery sweep — ${rows.length} runs from ${path}`);
console.log(`N=${rows[0]?.N} K=${rows[0]?.K} traffic=${rows[0]?.traffic}  (mean ± sd across seeds)\n`);

const verdicts = [];
for (const churn of [...byChurn.keys()].sort((a, b) => a - b)) {
  const arms = byChurn.get(churn);
  console.log(`── churn = ${churn}% ──`);
  console.log('  arm          fill        inbound     reach   meshShare   eclipseGini  n');
  const cell = {};
  for (const arm of ['A', 'B', 'C']) {
    const rs = arms.get(arm) || [];
    if (!rs.length) continue;
    const fill = rs.map(r => r.fillMean), inb = rs.map(r => r.inboundMean);
    const reach = rs.map(r => r.reachFrac), ms = rs.map(r => r.meshShareMean);
    const gini = rs.map(r => r.eclipseGini);
    cell[arm] = { fill: mean(fill), reach: mean(reach), ms: mean(ms), gini: mean(gini) };
    console.log(
      `  ${ARMNAME[arm].padEnd(12)} ${f(mean(fill)).padStart(5)}±${f(sd(fill)).padStart(4)}  ` +
      `${f(mean(inb)).padStart(5)}±${f(sd(inb)).padStart(4)}  ${f(mean(reach), 3)}   ` +
      `${f(mean(ms), 3)}       ${f(mean(gini), 3)}        ${rs.length}`);
  }
  if (cell.A && cell.C) {
    const cRatio = cell.C.fill / cell.A.fill;
    const bRatio = cell.B ? cell.B.fill / cell.A.fill : 0;
    console.log(`  → C/ceiling fill = ${f(cRatio * 100)}%   B/ceiling = ${f(bRatio * 100)}%   ` +
      `C reach = ${f(cell.C.reach, 3)}   C meshShare = ${f(cell.C.ms, 3)}   C gini = ${f(cell.C.gini, 3)}`);
    verdicts.push({ churn, cRatio, bRatio, reach: cell.C.reach, ms: cell.C.ms, gini: cell.C.gini });
  }
  console.log('');
}

// ── greenlight evaluation ──
console.log('── verdict (greenlight: C ≥95% ceiling fill, ≥99% reach, majority mesh, gini <0.6) ──');
for (const v of verdicts) {
  const passFill  = v.cRatio >= 0.95;
  const passReach = v.reach  >= 0.99;
  const passMesh  = v.ms     >= 0.50;
  const passEcl   = v.gini   <  0.60;
  const beatsRand = v.cRatio > v.bRatio + 0.02; // C meaningfully beats random sponsor
  console.log(`  churn ${String(v.churn).padStart(2)}%: ` +
    `fill≥95%[${passFill ? 'Y' : 'N'} ${f(v.cRatio * 100)}%]  ` +
    `reach≥99%[${passReach ? 'Y' : 'N'}]  ` +
    `mesh-majority[${passMesh ? 'Y' : 'N'} ${f(v.ms, 2)}]  ` +
    `gini<0.6[${passEcl ? 'Y' : 'N'} ${f(v.gini, 2)}]  ` +
    `C>random[${beatsRand ? 'Y' : 'N'}]`);
}
console.log('\n(Reachability is the load-bearing claim — bounded introduction integrating a');
console.log(' node at all. Fill%/curation-vs-random tell us whether curation is worth its cost.)');

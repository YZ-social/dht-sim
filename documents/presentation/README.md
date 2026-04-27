# Neuromorphic DHT — Presentation

Source materials for the technical presentation. See `OUTLINE.md` for the structural plan.

## Layout

```
presentation/
├── OUTLINE.md          — slide-by-slide structure, data manifest, chart specs
├── deck.md             — Marp-compatible markdown, rendered to HTML/PDF/PPTX
├── README.md           — this file
├── charts/
│   ├── style.py        — matplotlib style module (palette, typography, spines)
│   ├── generate.py     — produces all 11 charts from results/*.csv
│   └── *.svg           — generated artefacts (11 charts, ~15 KB each)
├── images/
│   └── DHT-SIM-Image.png  — screenshot of the simulator in action
├── data/               — reserved for dataset symlinks
└── slides/             — reserved for per-slide variant markdown
```

## Regenerating charts

Charts are fully reproducible from the CSVs under `results/`.

```bash
cd documents/presentation
./venv/bin/python charts/generate.py
```

The `venv/` is a local virtualenv with matplotlib + numpy. Create it with:

```bash
python3 -m venv venv
./venv/bin/pip install matplotlib numpy
```

## Rendering the deck

The deck is written in Marp-compatible markdown. Three output formats:

**PPTX (for PowerPoint / Google Slides import):**
```bash
npx @marp-team/marp-cli --pptx deck.md -o deck.pptx
```

**PDF:**
```bash
npx @marp-team/marp-cli --pdf deck.md -o deck.pdf
```

**HTML (for browser preview):**
```bash
npx @marp-team/marp-cli --html deck.md -o deck.html
```

Requires Node.js. `marp-cli` is a standalone npx target — no global install needed.

## Editing

- **Content only** — edit `deck.md`. Every slide is `---`-delimited.
- **Chart updates** — re-run new benchmarks, then `charts/generate.py`. SVGs are re-read automatically.
- **New slides** — add to `deck.md` at the appropriate section boundary.
- **Global style** — change the YAML front-matter `style:` block at the top of `deck.md`.

## Data sources for charts

All numbers in the deck trace to:

| Chart | Source CSV |
|---|---|
| C1, C3, C4 | `results/benchmark_2026-04-23T20-10-46.csv` (web-limited, 25K, omniscient) |
| C5 | + `results/benchmark_2026-04-23T20-35-46.csv` (unrestricted counterpart) |
| C2 | `results/benchmark_2026-04-23T06-*.csv` (12-run family sweep) |
| C6 | `results/pubsub-membership_latest.csv` (live-sim cumulative delivery) |
| C7 | `results/benchmark_2026-04-23T04-*.csv` (20-run discrete-churn sweep, §6.10) |
| C8 | `results/benchmark_2026-04-23T22-*.csv` (both convergence sweeps) |
| C9 | `results/benchmark_2026-04-23T22-56-02.csv` (bootstrap warmup=100) |
| C10, C11 | Hand-curated (see `charts/generate.py`) |

## TODO before final delivery

- [ ] Finalize protocol name (currently placeholder: N-DHT / Neuromorphic DHT)
- [ ] Re-run charts if any benchmark CSVs are updated
- [ ] Speaker-notes pass (currently not embedded; add `<!-- notes: ... -->` to each slide)
- [ ] Proofread against whitepaper v0.56 for terminology drift
- [ ] Export to PPTX and review in Google Slides / Keynote for layout regressions

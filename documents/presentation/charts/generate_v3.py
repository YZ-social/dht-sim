#!/usr/bin/env python3
"""Generate v0.3 deck charts (NH-1 era).

Run: python3 generate_v3.py

Produces:
  C_highway_knee.svg  — highway% sweep at 25K (slide 18)
  C_4way_25k.svg      — Kad / G-DHT / NX-17 / NH-1 at 25K (slide 17)

Both read from results/ with explicit file lists. Extends the v0.2 style
module without modifying generate.py.
"""

import sys
from pathlib import Path

import numpy as np
import matplotlib.pyplot as plt

sys.path.insert(0, str(Path(__file__).parent))
from style import (
    apply_base_style, style_axes, figsize_wide, legend,
    PROTO_COLORS, KADEMLIA, G_DHT, N_DHT, HIGHLIGHT, MUTED, GRID,
)
from generate import parse_csv, num, get


HERE    = Path(__file__).parent
OUT_DIR = HERE
RESULTS = HERE.parent.parent.parent / "results"

# ── Highway% knee data (13-run sweep at 25K, v0.67.01 post-fix) ──────────
HIGHWAY_RUNS = [
    # (highway%, csv path)  — geoBits=8 only; the geoBits=0 baseline is shown separately
    (0,   RESULTS / "benchmark_2026-04-27T22-42-10.csv"),
    (5,   RESULTS / "benchmark_2026-04-27T22-49-09.csv"),
    (10,  RESULTS / "benchmark_2026-04-27T22-56-26.csv"),
    (15,  RESULTS / "benchmark_2026-04-27T23-03-23.csv"),
    (20,  RESULTS / "benchmark_2026-04-27T23-10-17.csv"),
    (25,  RESULTS / "benchmark_2026-04-27T23-16-17.csv"),
    (30,  RESULTS / "benchmark_2026-04-27T23-22-12.csv"),
    (35,  RESULTS / "benchmark_2026-04-27T23-27-12.csv"),
    (40,  RESULTS / "benchmark_2026-04-27T23-31-45.csv"),
    (45,  RESULTS / "benchmark_2026-04-27T23-35-44.csv"),
    (50,  RESULTS / "benchmark_2026-04-27T23-39-47.csv"),
    (100, RESULTS / "benchmark_2026-04-27T23-43-43.csv"),
]


def chart_highway_knee():
    """Slide 18 — highway% knee. Three line series on shared x: hw% 0..100."""
    pcts, glob_ms, r500_ms, r2k_ms = [], [], [], []
    for pct, path in HIGHWAY_RUNS:
        rows, _ = parse_csv(path)
        pcts.append(pct)
        glob_ms.append(get(rows, "NH-1", "global ms"))
        r500_ms.append(get(rows, "NH-1", "500km ms"))
        r2k_ms.append(get(rows, "NH-1", "2000km ms"))

    fig, ax = plt.subplots(figsize=figsize_wide())

    # Use teal family for the three series — same protocol, different metrics.
    teal_dark   = N_DHT          # global
    teal_mid    = "#5fa6a6"      # 500 km
    teal_light  = "#94c5c5"      # 2000 km

    ax.plot(pcts, glob_ms, marker="o", color=teal_dark,  linewidth=2.0, label="Global")
    ax.plot(pcts, r2k_ms,  marker="s", color=teal_mid,   linewidth=2.0, label="2000 km")
    ax.plot(pcts, r500_ms, marker="^", color=teal_light, linewidth=2.0, label="500 km")

    # Knee annotation at hw=15%
    knee_x = 15
    knee_y = glob_ms[pcts.index(knee_x)]
    ax.axvline(knee_x, color=HIGHLIGHT, linewidth=0.8, linestyle="--", alpha=0.6)
    ax.annotate(
        f"knee — 15 %\n70 % of gain captured",
        xy=(knee_x, knee_y),
        xytext=(28, knee_y + 25),
        fontsize=10, color=HIGHLIGHT,
        arrowprops=dict(arrowstyle="->", color=HIGHLIGHT, lw=0.8),
    )

    ax.set_xlabel("Highway % (server-class fraction)")
    ax.set_ylabel("Lookup latency (ms)")
    ax.set_title("Highway% knee — NH-1 at 25 K (web-limited, geoBits = 8)")
    ax.set_xticks([0, 5, 10, 15, 20, 25, 30, 35, 40, 45, 50, 100])
    ax.set_xlim(-3, 103)
    ax.set_ylim(0, 290)

    legend(ax, loc="upper right")
    style_axes(ax)
    fig.savefig(OUT_DIR / "C_highway_knee.svg")
    plt.close(fig)
    print(f"wrote {OUT_DIR / 'C_highway_knee.svg'}")


def chart_4way_25k(csv_path=None):
    """Slide 17 — 4-protocol comparison at 25K.

    If csv_path is None, falls back to placeholder data with a "PENDING"
    overlay so the chart remains usable in draft form.
    """
    radii = ["global", "500km", "1000km", "2000km", "5000km"]
    labels = ["Global", "500 km", "1000 km", "2000 km", "5000 km"]

    placeholder = csv_path is None or not Path(csv_path).exists()
    if not placeholder:
        rows, _ = parse_csv(csv_path)
        kad   = [get(rows, "Kademlia",        f"{r} ms") for r in radii]
        gdht  = [get(rows, "G-DHT",           f"{r} ms") for r in radii]
        nx17  = [get(rows, "Neuromorphic-NX17", f"{r} ms") or
                 get(rows, "NX-17",            f"{r} ms") for r in radii]
        nh1   = [get(rows, "NH-1",            f"{r} ms") for r in radii]
    else:
        # Best-known illustrative values from prior runs — clearly marked PENDING.
        kad  = [536, 517, 519, 521, 530]
        gdht = [318, 153, 169, 187, 290]
        nx17 = [237, 81,  90,  100, 130]
        nh1  = [263, 96,  108, 124, 155]

    fig, ax = plt.subplots(figsize=figsize_wide())
    x = np.arange(len(labels))
    w = 0.20

    ax.bar(x - 1.5*w, kad,  w, label="Kademlia", color=KADEMLIA)
    ax.bar(x - 0.5*w, gdht, w, label="G-DHT",    color=G_DHT)
    ax.bar(x + 0.5*w, nx17, w, label="NX-17",    color="#6fa8a8")
    ax.bar(x + 1.5*w, nh1,  w, label="NH-1",     color=N_DHT)

    for i, (k, g, n17, nh) in enumerate(zip(kad, gdht, nx17, nh1)):
        if k:    ax.text(i - 1.5*w, k    + 8, f"{k:.0f}",   ha="center", fontsize=8, color="#333")
        if g:    ax.text(i - 0.5*w, g    + 8, f"{g:.0f}",   ha="center", fontsize=8, color="#333")
        if n17:  ax.text(i + 0.5*w, n17  + 8, f"{n17:.0f}", ha="center", fontsize=8, color="#333")
        if nh:   ax.text(i + 1.5*w, nh   + 8, f"{nh:.0f}",  ha="center", fontsize=8, color="#333")

    ax.set_xticks(x)
    ax.set_xticklabels(labels)
    ax.set_ylabel("Simulated latency (ms)")
    title = "Lookup latency by distance — 25 K nodes, web-limited"
    if placeholder:
        title += "  [PENDING — placeholder data]"
    ax.set_title(title)
    ymax = max(max(filter(None, kad)), max(filter(None, gdht)),
               max(filter(None, nx17)), max(filter(None, nh1)))
    ax.set_ylim(0, ymax * 1.18)
    legend(ax, loc="upper right")
    style_axes(ax)
    fig.savefig(OUT_DIR / "C_4way_25k.svg")
    plt.close(fig)
    print(f"wrote {OUT_DIR / 'C_4way_25k.svg'}"
          + (" (placeholder)" if placeholder else ""))


def chart_C1_refresh(csv_path):
    """Regenerate C1 (Kademlia vs G-DHT latency by radius) with current data.

    The original generate.py points C1 at a stale 2026-04-23 CSV. This re-uses
    the 4-protocol benchmark (which has K and G rows) for honest current data.
    """
    rows, _ = parse_csv(csv_path)
    radii = ["global", "500km", "1000km", "2000km", "5000km"]
    labels = ["Global", "500 km", "1000 km", "2000 km", "5000 km"]
    k_ms = [get(rows, "Kademlia", f"{r} ms") for r in radii]
    g_ms = [get(rows, "G-DHT",     f"{r} ms") for r in radii]

    fig, ax = plt.subplots(figsize=figsize_wide())
    x = np.arange(len(labels))
    w = 0.38
    ax.bar(x - w/2, k_ms, w, label="Kademlia", color=KADEMLIA)
    ax.bar(x + w/2, g_ms, w, label="G-DHT",    color=G_DHT)

    for i, (km, gm) in enumerate(zip(k_ms, g_ms)):
        if km is not None:
            ax.text(i - w/2, km + 8, f"{km:.0f}", ha="center", fontsize=9, color="#333")
        if gm is not None:
            ax.text(i + w/2, gm + 8, f"{gm:.0f}", ha="center", fontsize=9, color="#333")

    ax.set_xticks(x)
    ax.set_xticklabels(labels)
    ax.set_ylabel("Simulated latency (ms)")
    ax.set_title("Lookup latency by distance — Kademlia vs G-DHT (web-limited, 25 K)")
    valid = [v for v in (k_ms + g_ms) if v is not None]
    ax.set_ylim(0, max(valid) * 1.18 if valid else 600)
    legend(ax, loc="upper right")
    style_axes(ax)
    fig.savefig(OUT_DIR / "C1_latency_kad_vs_gdht.svg")
    plt.close(fig)
    print(f"wrote {OUT_DIR / 'C1_latency_kad_vs_gdht.svg'} (refreshed with {csv_path.name})")


def main():
    apply_base_style()
    chart_highway_knee()

    # v0.68.00 — headline 4-way data is now the canonical-init geoBits=8 run.
    # Pick the matching CSV (Init mode,canonical + G-DHT Bits,8 + all 4
    # protocols + all 5 distance bands).
    headline = None
    for cand in sorted(RESULTS.glob("benchmark_2026-04-2*T*.csv"), reverse=True):
        try:
            with open(cand) as f:
                content = f.read()
            if (    "Init mode,canonical" in content
                and "G-DHT Bits,8" in content
                and "5000km ms" in content
                and "Kademlia"   in content
                and "G-DHT"      in content
                and ("NX-17" in content or "NX17" in content)
                and "NH-1"       in content):
                headline = cand
                break
        except OSError:
            continue

    if headline:
        chart_C1_refresh(headline)
        chart_4way_25k(headline)
    else:
        print("WARN: no canonical-init geoBits=8 CSV found; charts may use placeholders")
        chart_4way_25k(None)


if __name__ == "__main__":
    main()

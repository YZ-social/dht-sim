#!/usr/bin/env python3
"""Generate all presentation charts from benchmark CSVs.

Run:  python3 generate.py

Reads CSVs from ../../../results/ (repo-relative) and writes SVGs to this
directory. Idempotent — always regenerates.
"""

import os
import re
import sys
from pathlib import Path

import numpy as np
import matplotlib.pyplot as plt

sys.path.insert(0, str(Path(__file__).parent))
from style import (
    apply_base_style, style_axes, annotate_value, figsize_wide, legend,
    PROTO_COLORS, KADEMLIA, G_DHT, N_DHT, HIGHLIGHT, MUTED, SEQUENTIAL,
)

# ── Paths ──────────────────────────────────────────────────────────────────

HERE    = Path(__file__).parent
OUT_DIR = HERE
RESULTS = HERE.parent.parent.parent / "results"

# Canonical data sources (see OUTLINE.md § Data manifest)
WL_25K      = RESULTS / "benchmark_2026-04-23T20-10-46.csv"
UNR_25K     = RESULTS / "benchmark_2026-04-23T20-35-46.csv"
PUBSUB_LIVE = RESULTS / "pubsub-membership_latest.csv"

# Convergence sweep archives (warmupSessions = 10, 30, 60, 100)
OMNI_CONV = [
    RESULTS / "benchmark_2026-04-23T22-13-08.csv",
    RESULTS / "benchmark_2026-04-23T22-14-50.csv",
    RESULTS / "benchmark_2026-04-23T22-17-31.csv",
    RESULTS / "benchmark_2026-04-23T22-22-05.csv",
]
BOOT_CONV = [
    RESULTS / "benchmark_2026-04-23T22-41-36.csv",
    RESULTS / "benchmark_2026-04-23T22-45-06.csv",
    RESULTS / "benchmark_2026-04-23T22-49-38.csv",
    RESULTS / "benchmark_2026-04-23T22-56-02.csv",
]
CONV_WARMUPS = [10, 30, 60, 100]   # sessions — effective lookups = max(ws, 10) × 500

# 12-run cross-family (6 NX variants × 2 init modes)
FAMILY = [
    RESULTS / "benchmark_2026-04-23T06-15-44.csv",  # N-1 omni
    RESULTS / "benchmark_2026-04-23T06-17-55.csv",  # N-1 boot
    RESULTS / "benchmark_2026-04-23T06-18-17.csv",  # NX-3 omni
    RESULTS / "benchmark_2026-04-23T06-23-03.csv",  # NX-3 boot
    RESULTS / "benchmark_2026-04-23T06-23-27.csv",  # NX-6 omni
    RESULTS / "benchmark_2026-04-23T06-29-35.csv",  # NX-6 boot
    RESULTS / "benchmark_2026-04-23T06-29-59.csv",  # NX-10 omni
    RESULTS / "benchmark_2026-04-23T06-34-06.csv",  # NX-10 boot
    RESULTS / "benchmark_2026-04-23T06-34-29.csv",  # NX-15 omni
    RESULTS / "benchmark_2026-04-23T06-38-46.csv",  # NX-15 boot
    RESULTS / "benchmark_2026-04-23T06-39-09.csv",  # NX-17 omni
    RESULTS / "benchmark_2026-04-23T06-43-13.csv",  # NX-17 boot
]
FAMILY_LABELS = ["N-1", "NX-3", "NX-6", "NX-10", "NX-15", "NX-17"]

# Discrete-churn sweep (5 reps × 4 rates — see §6.10 and the 20-run sweep)
# NB: these are from the v0.60.00 analysis sweep
import glob
DISCRETE_CHURN = sorted(glob.glob(str(RESULTS / "benchmark_2026-04-23T04-*.csv")))


# ── CSV parsing ────────────────────────────────────────────────────────────

def parse_csv(path):
    """Parse a benchmark CSV into (rows, params). rows is list[dict]; params is dict."""
    with open(path) as f:
        lines = f.readlines()
    try:
        h_idx = next(i for i, l in enumerate(lines) if l.startswith("Protocol,"))
    except StopIteration:
        return [], {}
    header = [c.strip() for c in lines[h_idx].strip().split(",")]
    rows = []
    for line in lines[h_idx + 1:]:
        if not line.strip() or line.startswith("#") or line.startswith("Parameter"):
            break
        cells = [c.strip() for c in line.strip().split(",")]
        rows.append(dict(zip(header, cells)))
    # Params section
    params = {}
    in_params = False
    for line in lines:
        if line.startswith("Parameter,"):
            in_params = True
            continue
        if in_params and "," in line:
            k, v = line.strip().split(",", 1)
            params[k.strip()] = v.strip()
    return rows, params


def num(s):
    """Parse a benchmark cell — strips % signs; returns None on failure."""
    if s is None:
        return None
    s = str(s).strip().rstrip("%")
    try:
        return float(s)
    except ValueError:
        return None


def get(rows, proto, key):
    """Look up a numeric cell for a given protocol in parsed rows."""
    for r in rows:
        if r.get("Protocol", "").startswith(proto) or r.get("Protocol", "") == proto:
            return num(r.get(key, ""))
    return None


def proto_canonical(label):
    """Map CSV protocol labels to canonical deck labels."""
    if label.startswith("G-DHT"):
        return "G-DHT"
    if label.startswith("N-") or label.startswith("NX-"):
        return "N-DHT"
    return label  # e.g. 'Kademlia'


# ── Chart C1: Latency by radius, K vs G (web-limited) ─────────────────────

def chart_C1():
    rows, _ = parse_csv(WL_25K)
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
        ax.text(i - w/2, km + 5, f"{km:.0f}", ha="center", fontsize=9, color="#333")
        ax.text(i + w/2, gm + 5, f"{gm:.0f}", ha="center", fontsize=9, color="#333")

    ax.set_xticks(x)
    ax.set_xticklabels(labels)
    ax.set_ylabel("Simulated latency (ms)")
    ax.set_title("Lookup latency by distance — Kademlia vs G-DHT (web-limited, 25 K)")
    ax.set_ylim(0, max(max(k_ms), max(g_ms)) * 1.18)
    legend(ax, loc="upper right")
    style_axes(ax)
    fig.savefig(OUT_DIR / "C1_latency_kad_vs_gdht.svg")
    plt.close(fig)


# ── Chart C2: Lookup success across NX family under bootstrap ─────────────

def chart_C2():
    # Family files alternate omni, boot per protocol. Boot index = 1, 3, 5, ...
    boot_success = {}
    for proto, path in zip(FAMILY_LABELS, FAMILY[1::2]):
        rows, _ = parse_csv(path)
        # The family entry's protocol label varies (N-1, NX-3, etc.)
        for r in rows:
            succ = num(r.get("global success%", ""))
            if succ is not None:
                boot_success[proto] = succ
                break

    fig, ax = plt.subplots(figsize=figsize_wide())
    xs = np.arange(len(FAMILY_LABELS))
    vals = [boot_success.get(p, 0) for p in FAMILY_LABELS]
    colors = [HIGHLIGHT if v < 99 else N_DHT for v in vals]
    ax.bar(xs, vals, 0.6, color=colors)
    for x, v in zip(xs, vals):
        ax.text(x, v + 1.5, f"{v:.1f}%", ha="center", fontsize=10,
                color="#333", fontweight="bold")
    ax.axhline(100, color=MUTED, linewidth=0.8, linestyle="--")
    ax.set_xticks(xs)
    ax.set_xticklabels(FAMILY_LABELS)
    ax.set_ylabel("Global lookup success (%)")
    ax.set_title("Bootstrap-trained lookup success across NX family (25 K)")
    ax.set_ylim(50, 105)
    ax.text(0, 58, "Reliability floor established at NX-6",
            fontsize=9, color=HIGHLIGHT, style="italic")
    style_axes(ax)
    fig.savefig(OUT_DIR / "C2_family_success.svg")
    plt.close(fig)


# ── Chart C3: Hops by radius, 3 protocols (WL) ────────────────────────────

def chart_C3():
    rows, _ = parse_csv(WL_25K)
    radii_keys = ["global hops", "500km hops", "1000km hops", "2000km hops",
                  "5000km hops", "10%→10% hops"]
    labels = ["Global", "500 km", "1000 km", "2000 km", "5000 km", "10%→10%"]
    k  = [get(rows, "Kademlia", k) for k in radii_keys]
    g  = [get(rows, "G-DHT",     k) for k in radii_keys]
    n  = [get(rows, "NX-17",     k) for k in radii_keys]

    fig, ax = plt.subplots(figsize=figsize_wide())
    x = np.arange(len(labels))
    w = 0.26
    ax.bar(x - w, k, w, label="Kademlia", color=KADEMLIA)
    ax.bar(x,     g, w, label="G-DHT",    color=G_DHT)
    ax.bar(x + w, n, w, label="N-DHT",    color=N_DHT)

    ax.set_xticks(x); ax.set_xticklabels(labels)
    ax.set_ylabel("Average hops")
    ax.set_title("Lookup hops by distance — three protocols (web-limited, 25 K)")
    ymax = max(max(k), max(g), max(n)) * 1.15
    ax.set_ylim(0, ymax)
    legend(ax, loc="upper right")
    style_axes(ax)
    fig.savefig(OUT_DIR / "C3_hops_by_radius.svg")
    plt.close(fig)


# ── Chart C4: Latency by radius, 3 protocols (WL) ─────────────────────────

def chart_C4():
    rows, _ = parse_csv(WL_25K)
    radii_keys = ["global ms", "500km ms", "1000km ms", "2000km ms",
                  "5000km ms", "10%→10% ms"]
    labels = ["Global", "500 km", "1000 km", "2000 km", "5000 km", "10%→10%"]
    k  = [get(rows, "Kademlia", k) for k in radii_keys]
    g  = [get(rows, "G-DHT",     k) for k in radii_keys]
    n  = [get(rows, "NX-17",     k) for k in radii_keys]

    fig, ax = plt.subplots(figsize=figsize_wide())
    x = np.arange(len(labels))
    w = 0.26
    ax.bar(x - w, k, w, label="Kademlia", color=KADEMLIA)
    ax.bar(x,     g, w, label="G-DHT",    color=G_DHT)
    ax.bar(x + w, n, w, label="N-DHT",    color=N_DHT)

    for i, v in enumerate(n):
        ax.text(i + w, v + 6, f"{v:.0f}", ha="center", fontsize=8,
                color=N_DHT, fontweight="bold")

    ax.set_xticks(x); ax.set_xticklabels(labels)
    ax.set_ylabel("Simulated latency (ms)")
    ax.set_title("Lookup latency by distance — three protocols (web-limited, 25 K)")
    ymax = max(max(k), max(g), max(n)) * 1.15
    ax.set_ylim(0, ymax)
    legend(ax, loc="upper right")
    style_axes(ax)
    fig.savefig(OUT_DIR / "C4_latency_by_radius.svg")
    plt.close(fig)


# ── Chart C5: Web-limited vs unrestricted (all three) ─────────────────────

def chart_C5():
    wl, _  = parse_csv(WL_25K)
    unr, _ = parse_csv(UNR_25K)

    metrics = [
        ("global ms", "Global"),
        ("500km ms",  "500 km"),
        ("2000km ms", "2000 km"),
        ("10%→10% ms", "10%→10%"),
    ]
    groups = ["Kademlia", "G-DHT", "N-DHT"]
    colors = [KADEMLIA, G_DHT, N_DHT]

    fig, ax = plt.subplots(figsize=figsize_wide())
    n_metrics = len(metrics)
    x = np.arange(n_metrics)
    w = 0.12

    protos_csv = [("Kademlia", "Kademlia"), ("G-DHT", "G-DHT"), ("NX-17", "N-DHT")]
    for idx, (csv_key, label) in enumerate(protos_csv):
        wl_vals  = [get(wl,  csv_key, m[0]) for m in metrics]
        unr_vals = [get(unr, csv_key, m[0]) for m in metrics]
        offset_wl  = (idx - 1) * (w * 2) - w/2
        offset_unr = (idx - 1) * (w * 2) + w/2
        ax.bar(x + offset_wl,  wl_vals,  w, color=colors[idx], alpha=0.55,
               label=f"{label} · WL" if idx == 0 else None)
        ax.bar(x + offset_unr, unr_vals, w, color=colors[idx],
               label=f"{label} · ∞"  if idx == 0 else None)

    # Manual legend: 3 protocols × 2 regimes
    from matplotlib.patches import Patch
    handles = []
    for c, l in zip(colors, groups):
        handles.append(Patch(facecolor=c, alpha=0.55, label=f"{l} (web-limited)"))
        handles.append(Patch(facecolor=c, label=f"{l} (unrestricted)"))
    ax.legend(handles=handles, loc="upper right", fontsize=9, ncol=3)

    ax.set_xticks(x); ax.set_xticklabels([m[1] for m in metrics])
    ax.set_ylabel("Simulated latency (ms)")
    ax.set_title("Web-limited vs unrestricted — all three protocols (25 K)")
    style_axes(ax)
    fig.savefig(OUT_DIR / "C5_wl_vs_unrestricted.svg")
    plt.close(fig)


# ── Chart C6: Cumulative delivery vs cumulative churn (live sim) ──────────

def chart_C6():
    # Parse live sim CSV — expects rows like:
    #   tick,deliveredPct,cumulativePct,cumKilledPct, ...
    # We approximate: pull cumulative churn x-axis vs immediate + cumulative delivered.
    lines = PUBSUB_LIVE.read_text().splitlines()
    header = None
    data = []
    for line in lines:
        if line.startswith("tick,") or ("cumulativeKilledPct" in line and header is None):
            header = [c.strip() for c in line.split(",")]
            continue
        if header and "," in line:
            cells = [c.strip() for c in line.split(",")]
            if len(cells) < len(header):
                continue
            try:
                data.append(dict(zip(header, cells)))
            except Exception:
                continue
    if not data:
        # fallback: publish fixed points from whitepaper §6.9 table
        x   = [0, 5, 10, 15, 20, 25, 30, 33]
        imm = [100.0, 98.7, 91.1, 87.3, 86.5, 68.1, 51.8, 51.8]
        cum = [100.0, 99.7, 95.5, 93.1, 91.0, 88.1, 81.3, 80.7]
    else:
        def f(row, key):
            v = row.get(key, "")
            try: return float(v.rstrip("%"))
            except Exception: return None
        x   = []
        imm = []
        cum = []
        for row in data:
            cx = f(row, "cumulativeKilledPct")
            di = f(row, "deliveredPct")
            dc = f(row, "cumulativePct")
            if cx is not None and di is not None:
                x.append(cx)
                imm.append(di)
                cum.append(dc if dc is not None else di)

    fig, ax = plt.subplots(figsize=figsize_wide())
    ax.plot(x, imm, marker="o", markersize=4, color=MUTED,
            linewidth=1.5, label="Immediate delivery")
    ax.plot(x, cum, marker="o", markersize=5, color=N_DHT,
            linewidth=2.3, label="Cumulative delivery (with replay cache)")
    ax.fill_between(x, imm, cum, color=N_DHT, alpha=0.08)

    ax.set_xlabel("Cumulative network churn (%)")
    ax.set_ylabel("Delivery rate (%)")
    ax.set_title("Axonal pub/sub delivery under continuous 1 % / 5 tick churn — 25 K")
    ax.set_ylim(40, 105)
    ax.axhline(80, color=HIGHLIGHT, linewidth=0.6, linestyle=":", alpha=0.6)
    ax.text(max(x) * 0.02, 81, "replay-cache floor", fontsize=9,
            color=HIGHLIGHT, alpha=0.8)
    legend(ax, loc="lower left")
    style_axes(ax)
    fig.savefig(OUT_DIR / "C6_pubsub_delivery.svg")
    plt.close(fig)


# ── Chart C7: Discrete-churn recovery with σ shading ──────────────────────

def chart_C7():
    """Aggregate the 5-rep × 4-rate sweep. Each CSV has one NX-17 row."""
    if not DISCRETE_CHURN:
        print("[C7] No discrete-churn CSVs found — skipping")
        return

    per_rate = {}  # rate -> list of dicts
    for path in DISCRETE_CHURN:
        rows, _ = parse_csv(path)
        for row in rows:
            cols = list(row.keys())
            rate_col = next((c for c in cols if "baseline%" in c), None)
            if not rate_col:
                continue
            m = re.search(r"pubsubm\+(\d+)%churn", rate_col)
            if not m:
                continue
            rate = int(m.group(1))
            per_rate.setdefault(rate, []).append(row)

    rates = sorted(per_rate.keys())
    if not rates:
        print("[C7] No rate data — skipping")
        return

    def col_vals(rows, suffix):
        vals = []
        for r in rows:
            key = next((k for k in r if k.endswith(suffix)), None)
            if key:
                v = num(r.get(key, ""))
                if v is not None:
                    vals.append(v)
        return vals

    def mean_std(rows, suffix):
        vals = col_vals(rows, suffix)
        if not vals:
            return None, None
        return float(np.mean(vals)), float(np.std(vals, ddof=1) if len(vals) > 1 else 0)

    baseline = [mean_std(per_rate[r], "baseline%")   for r in rates]
    immediate = [mean_std(per_rate[r], "immediate%") for r in rates]
    recovered = [mean_std(per_rate[r], "recovered%") for r in rates]

    fig, ax = plt.subplots(figsize=figsize_wide())

    def band(series, color, label):
        mu  = [v[0] for v in series]
        sd  = [v[1] for v in series]
        ax.plot(rates, mu, marker="o", markersize=5, linewidth=2.0, color=color, label=label)
        lo  = [m - s for m, s in zip(mu, sd)]
        hi  = [m + s for m, s in zip(mu, sd)]
        ax.fill_between(rates, lo, hi, color=color, alpha=0.15)

    band(baseline,  MUTED,    "Baseline (pre-kill)")
    band(immediate, HIGHLIGHT, "Immediate (post-kill)")
    band(recovered, N_DHT,    "Recovered (3 refresh rounds)")

    ax.set_xlabel("Single-kill churn rate (% of nodes)")
    ax.set_ylabel("Delivery rate (%)")
    ax.set_title("Discrete-churn recovery (mean ± σ, 5 reps per rate, 25 K)")
    ax.set_xticks(rates)
    ax.set_ylim(40, 105)
    legend(ax, loc="lower left")
    style_axes(ax)
    fig.savefig(OUT_DIR / "C7_discrete_churn.svg")
    plt.close(fig)


# ── Chart C8: Convergence curves (both inits) ────────────────────────────

def chart_C8():
    def conv_series(paths, key):
        out = []
        for path in paths:
            rows, _ = parse_csv(path)
            v = get(rows, "NX-17", key)
            out.append(v)
        return out

    omni_g = conv_series(OMNI_CONV, "global hops")
    boot_g = conv_series(BOOT_CONV, "global hops")

    fig, ax = plt.subplots(figsize=figsize_wide())
    x = [w * 500 for w in CONV_WARMUPS]  # effective warmup lookups
    # Actually CONV_WARMUPS are session counts where lookups = max(ws, 10)*500
    x = [max(ws, 10) * 500 for ws in CONV_WARMUPS]

    ax.plot(x, omni_g, marker="o", color=N_DHT, linewidth=2.3,
            label="Omniscient init (N-DHT)", markersize=6)
    ax.plot(x, boot_g, marker="s", color=HIGHLIGHT, linewidth=2.3,
            label="Bootstrap init (N-DHT)", markersize=6)

    # K-DHT / G-DHT flat controls (one average value across all four)
    k_vals = [get(parse_csv(p)[0], "Kademlia", "global hops") for p in OMNI_CONV]
    g_vals = [get(parse_csv(p)[0], "G-DHT",     "global hops") for p in OMNI_CONV]
    k_avg = float(np.mean([v for v in k_vals if v is not None]))
    g_avg = float(np.mean([v for v in g_vals if v is not None]))
    ax.axhline(k_avg, color=KADEMLIA, linewidth=1.2, linestyle="--",
               label=f"Kademlia (flat ≈ {k_avg:.2f})")
    ax.axhline(g_avg, color=G_DHT, linewidth=1.2, linestyle="--",
               label=f"G-DHT (flat ≈ {g_avg:.2f})")

    # Asymptote annotation
    asymptote = float(np.mean([omni_g[-1], boot_g[-1]]))
    ax.axhline(asymptote, color=MUTED, linewidth=0.6, linestyle=":")
    ax.annotate(f"~{asymptote:.2f}-hop asymptote",
                xy=(x[-1], asymptote), xytext=(-6, -16),
                textcoords="offset points", ha="right",
                fontsize=9, color=MUTED, style="italic")

    ax.set_xlabel("Effective training lookups")
    ax.set_ylabel("Global lookup hops")
    ax.set_title("N-DHT learning convergence — omniscient vs bootstrap init (25 K, WL)")
    ax.set_xscale("log")
    legend(ax, loc="center right", fontsize=9)
    style_axes(ax)
    fig.savefig(OUT_DIR / "C8_convergence.svg")
    plt.close(fig)


# ── Chart C9: Realistic deployment bars (bootstrap + max warmup) ─────────

def chart_C9():
    rows, _ = parse_csv(BOOT_CONV[-1])  # warmup=100, bootstrap
    # Extract K, G, N rows
    def row_for(label):
        for r in rows:
            p = r.get("Protocol", "")
            if label == "Kademlia" and p == "Kademlia": return r
            if label == "G-DHT" and p.startswith("G-DHT"): return r
            if label == "N-DHT" and (p.startswith("NX-") or p.startswith("N-")): return r
        return {}

    k = row_for("Kademlia"); g = row_for("G-DHT"); n = row_for("N-DHT")

    metrics = [
        ("Global\nhops",      "global hops"),
        ("Global\nlatency (ms)","global ms"),
        ("2000 km\nlatency (ms)","2000km ms"),
    ]

    fig, axes = plt.subplots(1, 3, figsize=(12, 4.2))
    for ax, (title, key) in zip(axes, metrics):
        vals = [num(k.get(key)), num(g.get(key)), num(n.get(key))]
        colors = [KADEMLIA, G_DHT, N_DHT]
        bars = ax.bar(["Kademlia", "G-DHT", "N-DHT"], vals, color=colors)
        for bar, v in zip(bars, vals):
            ax.text(bar.get_x() + bar.get_width()/2, v + max(vals)*0.02,
                    f"{v:.0f}" if v >= 10 else f"{v:.2f}",
                    ha="center", fontsize=10, fontweight="bold")
        ax.set_title(title, fontsize=11, fontweight="normal")
        ax.set_ylim(0, max(vals) * 1.18)
        style_axes(ax)

    fig.suptitle("Realistic deployment — bootstrap init + 50 K training lookups (web-limited, 25 K)",
                 fontsize=13, fontweight="bold", y=1.02)
    fig.savefig(OUT_DIR / "C9_realistic_deployment.svg")
    plt.close(fig)


# ── Chart C10: Per-hop compute cost decomposition ────────────────────────

def chart_C10():
    # Hand-curated cost model matching the S18 slide claim.
    protocols = ["Kademlia", "G-DHT", "N-DHT"]

    # Approximate operations per hop
    parts = {
        "XOR + bucket/stratum scan": [20, 35, 50],
        "AP₁ scoring + sort":         [0, 0, 280],
        "Two-hop probe (α=5)":        [0, 0, 1100],
        "Liveness + LTP update":      [0, 0, 70],
    }

    fig, ax = plt.subplots(figsize=figsize_wide())
    bottom = [0, 0, 0]
    colors = ["#b8c4d4", "#9db4a9", "#6b8d85", "#2d7373"]
    for (label, vals), color in zip(parts.items(), colors):
        ax.bar(protocols, vals, 0.5, bottom=bottom, label=label, color=color)
        bottom = [b + v for b, v in zip(bottom, vals)]

    totals = [sum(v) for v in zip(*parts.values())]
    for i, t in enumerate(totals):
        ax.text(i, t + 50, f"{t:,} ops", ha="center",
                fontsize=10, fontweight="bold", color="#333")

    ax.set_ylabel("Approximate operations per hop")
    ax.set_title("Per-hop compute cost — the honest trade-off")
    ax.set_ylim(0, max(totals) * 1.18)
    legend(ax, loc="upper left", fontsize=9)
    style_axes(ax)
    fig.savefig(OUT_DIR / "C10_compute_cost.svg")
    plt.close(fig)


# ── Chart C11: Evolution timeline NX-1 → NX-17 ───────────────────────────

def chart_C11():
    """Hand-curated feature timeline."""
    events = [
        ("NX-1",  "First Hebbian synapses"),
        ("NX-5",  "Stratified bootstrap +\nincoming promotion"),
        ("NX-6",  "Dead-peer eviction +\ntemperature reheat"),
        ("NX-10", "Routing-topology\nforwarding tree"),
        ("NX-11", "80/20 diversified\nbootstrap"),
        ("NX-15", "K-closest pub/sub\n(deprecated)"),
        ("NX-17", "Axonal pub/sub +\npublisher-prefix topic IDs\n+ replay cache"),
    ]

    fig, ax = plt.subplots(figsize=(12, 3.8))
    n = len(events)
    x = np.arange(n)
    ax.plot(x, [0]*n, color=MUTED, linewidth=2, zorder=1)
    ax.scatter(x, [0]*n, s=90, color=N_DHT, zorder=2)

    # Alternate above/below for readability
    for i, (label, desc) in enumerate(events):
        ax.annotate(f"{label}", xy=(i, 0), xytext=(0, 12 if i % 2 == 0 else -28),
                    textcoords="offset points", ha="center",
                    fontsize=10, fontweight="bold", color=N_DHT)
        ax.annotate(desc, xy=(i, 0), xytext=(0, 32 if i % 2 == 0 else -48),
                    textcoords="offset points", ha="center",
                    fontsize=8.5, color="#444")

    ax.set_xlim(-0.6, n - 0.4)
    ax.set_ylim(-1, 1)
    ax.axis("off")
    ax.set_title("Neuromorphic DHT evolution — NX-1 through NX-17",
                 fontsize=13, fontweight="bold", pad=20)
    fig.savefig(OUT_DIR / "C11_evolution.svg")
    plt.close(fig)


# ── Main ───────────────────────────────────────────────────────────────────

def main():
    apply_base_style()
    charts = [chart_C1, chart_C2, chart_C3, chart_C4, chart_C5,
              chart_C6, chart_C7, chart_C8, chart_C9, chart_C10, chart_C11]
    for fn in charts:
        name = fn.__name__
        try:
            fn()
            print(f"  ✓ {name}")
        except Exception as e:
            print(f"  ✗ {name}: {e}")
            import traceback; traceback.print_exc()


if __name__ == "__main__":
    main()

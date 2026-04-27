"""Shared chart style for the Neuromorphic DHT presentation.

Design anchors:
- Sans-serif throughout (Helvetica / Arial fallback)
- Horizontal grid only, 0.5 pt light gray
- Top + right spines removed; left + bottom in mid gray
- Three-color ordinal palette: slate = Kademlia, amber = G-DHT, teal = N-DHT
- Sequential viridis for churn / warmup sweeps
- Bold titles, medium axis labels, light tick labels
- All charts exported as SVG (scalable, embeddable in PPTX)
"""

import matplotlib as mpl
from matplotlib import pyplot as plt

# ── Palette ────────────────────────────────────────────────────────────────

KADEMLIA = "#4a5a75"   # slate
G_DHT    = "#cc9b3b"   # amber
N_DHT    = "#2d7373"   # deep teal

PROTO_COLORS = {
    "Kademlia": KADEMLIA,
    "G-DHT":    G_DHT,
    "G-DHT-b":  G_DHT,
    "N-DHT":    N_DHT,
    "NX-17":    N_DHT,
}

# Accents for emphasis
HIGHLIGHT = "#c4572b"    # burnt orange — for callouts, annotations
MUTED     = "#9b9b9b"    # mid gray — secondary text, control lines
GRID      = "#dedede"    # light gray grid

# Sequential palette for per-rate / per-warmup sweeps (viridis-tuned)
SEQUENTIAL = ["#fde725", "#6ece58", "#1f9e89", "#26828e", "#3e4989", "#440154"]


def apply_base_style():
    """Apply global matplotlib defaults to match the deck style."""
    mpl.rcParams.update({
        "font.family":       "sans-serif",
        "font.sans-serif":   ["Helvetica Neue", "Helvetica", "Arial", "DejaVu Sans"],
        "font.size":         11,
        "axes.titlesize":    14,
        "axes.titleweight":  "bold",
        "axes.labelsize":    11,
        "axes.labelweight":  "regular",
        "axes.edgecolor":    "#555555",
        "axes.linewidth":    0.75,
        "axes.grid":         True,
        "axes.grid.axis":    "y",
        "grid.color":        GRID,
        "grid.linewidth":    0.5,
        "grid.linestyle":    "-",
        "xtick.color":       "#444444",
        "ytick.color":       "#444444",
        "xtick.labelsize":   10,
        "ytick.labelsize":   10,
        "xtick.major.size":  3,
        "ytick.major.size":  3,
        "xtick.major.width": 0.6,
        "ytick.major.width": 0.6,
        "axes.spines.top":   False,
        "axes.spines.right": False,
        "legend.frameon":    False,
        "legend.fontsize":   10,
        "figure.dpi":        100,
        "savefig.dpi":       150,
        "savefig.bbox":      "tight",
        "savefig.pad_inches": 0.15,
        "svg.fonttype":      "none",  # keep text as text in SVG, not paths
    })


def style_axes(ax):
    """Extra per-axes polish applied after base style."""
    ax.set_axisbelow(True)
    for spine in ("left", "bottom"):
        ax.spines[spine].set_color("#555555")
    ax.tick_params(axis="both", which="both", length=3, width=0.6, color="#555555")


def annotate_value(ax, x, y, text, color=None, offset=(0, 6), **kwargs):
    """Place a small label near a data point."""
    ax.annotate(
        text, xy=(x, y), xytext=offset, textcoords="offset points",
        ha="center", va="bottom",
        fontsize=9, color=color or "#333333",
        **kwargs,
    )


def figsize_wide():
    """16:9 presentation-friendly figure size (inches)."""
    return (10, 5.0)


def figsize_square():
    return (7, 5.0)


def legend(ax, **kwargs):
    """Apply a consistent legend placement. Defaults merge with caller kwargs."""
    defaults = {"loc": "upper right", "frameon": False}
    defaults.update(kwargs)
    return ax.legend(**defaults)

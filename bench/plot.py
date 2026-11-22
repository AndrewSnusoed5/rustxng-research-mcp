"""Build the README benchmark charts from the committed numeric results."""
import json
from collections import defaultdict
from math import ceil
from pathlib import Path
from statistics import mean, median

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt

DOCS = Path(__file__).resolve().parents[1] / "docs"
BACKGROUND = "#f2f6fb"
INK = "#172743"
MUTED = "#475c78"
GRID = "#dae3ef"
PROFILES = {
    "http": ("RustXNG HTTP", "#365981"),
    "mcp": ("RustXNG adapter", "#177d79"),
    "native": ("my-web-search", "#743fa0"),
    "old-http": ("Older RustXNG HTTP", "#985022"),
}

plt.rcParams.update({
    "font.family": "DejaVu Sans",
    "font.size": 11,
    "text.color": INK,
    "axes.labelcolor": MUTED,
    "xtick.color": MUTED,
    "ytick.color": INK,
    "figure.facecolor": BACKGROUND,
    "axes.facecolor": BACKGROUND,
})


def p90(samples):
    return sorted(samples)[ceil(0.9 * len(samples)) - 1]


def chart_axis(axis, title, maximum, xlabel):
    axis.set_title(title, loc="left", fontsize=13, fontweight="bold", pad=12)
    for spine in axis.spines.values():
        spine.set_visible(False)
    axis.set_xlim(0, maximum)
    axis.set_xlabel(xlabel)
    axis.set_axisbelow(True)
    axis.grid(axis="x", color=GRID, linewidth=0.8)
    axis.tick_params(axis="both", length=0)


def annotated_bars(axis, y, values, colors, labels, margin, height=0.45):
    axis.barh(y, values, height=height, color=colors)
    for position, value, label in zip(y, values, labels):
        axis.text(value + margin, position, label, va="center", fontsize=10, fontweight="bold")


def live_chart():
    groups = defaultdict(list)
    with (DOCS / "benchmark-results.jsonl").open(encoding="utf-8-sig") as stream:
        for line in stream:
            row = json.loads(line)
            if row["kind"] == "live":
                groups[row["profile"]].append(row)
    profiles = [profile for profile in PROFILES if groups[profile]]
    if not profiles:
        raise ValueError("No live benchmark samples")
    successes = [[row for row in groups[profile] if not row.get("error")] for profile in profiles]
    names, colors = zip(*(PROFILES[profile] for profile in profiles))
    seconds = [[row["ms"] / 1000 for row in rows] for rows in successes]
    durations = [median(values) for values in seconds]
    tails = [p90(values) for values in seconds]
    bodies = [sum(row["bodies"] for row in rows) for rows in successes]
    matches = [sum(row["facts"] for row in rows) for rows in successes]
    controls = [sum(row["controls"] for row in groups[profile]) for profile in profiles]

    figure, axes = plt.subplots(1, 3, figsize=(13.4, 4.5), gridspec_kw={"wspace": 0.42})
    figure.subplots_adjust(left=0.17, right=0.96, top=0.70, bottom=0.17)
    figure.text(0.06, 0.89, "RustXNG search and page retrieval", fontsize=24, fontweight="bold")
    figure.text(0.06, 0.81, "8 topics × 2 passes · Up to five result rows per call · RustXNG v0.32.0 Standard", color=MUTED)
    positions = list(reversed(range(len(profiles))))
    ceiling = max(tails) * 1.33 + 0.05
    chart_axis(axes[0], "Live call latency", ceiling, "Seconds")
    annotated_bars(axes[0], [y + 0.13 for y in positions], tails, "#b9cbdf",
                   [f"{x:.2f}" for x in tails], ceiling * 0.02, height=0.22)
    annotated_bars(axes[0], [y - 0.13 for y in positions], durations, colors,
                   [f"{x:.3f}" if x < 0.1 else f"{x:.2f}" for x in durations], ceiling * 0.02, height=0.22)
    axes[0].set_yticks(positions, names)
    axes[0].set_title("Live latency · p90 / p50", loc="left", fontsize=13, fontweight="bold", pad=12)
    for axis, title, values, labels, maximum, unit in [
        (axes[1], "Page texts returned", bodies, [str(n) for n in bodies], 94, "Non-empty bodies"),
        (axes[2], "Matches in page text", matches, [f"{x}/{n}" for x, n in zip(matches, controls)], max(controls) * 1.20, "Body-only controls"),
    ]:
        chart_axis(axis, title, maximum, unit)
        annotated_bars(axis, positions, values, colors, labels, maximum * 0.02)
        axis.set_yticks(positions, [""] * len(positions))
        axis.set_ylim(axes[0].get_ylim())
    figure.text(0.06, 0.042, "Repeated live requests can reuse RustXNG caches. Coverage and latency vary by provider and network.", color=MUTED, fontsize=9)
    figure.savefig(DOCS / "rustxng-benchmark.png", dpi=175)
    plt.close(figure)


def fetch_chart():
    rows = json.loads((DOCS / "fetch-scheduling.json").read_text(encoding="utf-8-sig"))
    figure, axis = plt.subplots(figsize=(9.9, 4.8))
    figure.subplots_adjust(left=0.18, right=0.96, top=0.70, bottom=0.19)
    figure.text(0.06, 0.90, "Page scheduling in my-web-search", fontsize=24, fontweight="bold")
    figure.text(0.06, 0.81, "Same fixed URL panel and network limits · Mean fetch time over two passes", color=MUTED)
    chart_axis(axis, "", 14.5, "Fetch stage time in seconds")
    for tasks, color, offset in [(24, "#365981", 0.15), (100, "#177d79", -0.15)]:
        subset = [row for row in rows if row["tasks"] == tasks]
        positions = [y + offset for y in reversed(range(len(subset)))]
        seconds = [mean(row["fetch_ms"]) / 1000 for row in subset]
        annotated_bars(axis, positions, seconds, color, [f"{x:.2f}" for x in seconds], 0.22, height=0.24)
    axis.set_yticks([2, 1, 0], ["15 URLs", "48 URLs", "72 URLs"])
    figure.text(0.19, 0.735, "24 scheduled tasks", color="#365981", fontweight="bold")
    figure.text(0.44, 0.735, "100 scheduled tasks", color="#177d79", fontweight="bold")
    figure.text(0.06, 0.052, "At 72 URLs, 125 → 128 bodies across both passes. This is a downloader comparison within my-web-search.", color=MUTED, fontsize=9)
    figure.savefig(DOCS / "page-scheduling.png", dpi=175)
    plt.close(figure)


if __name__ == "__main__":
    live_chart()
    fetch_chart()

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


def comparison_groups(filename, *keys):
    groups = defaultdict(list)
    with (DOCS / filename).open(encoding="utf-8-sig") as stream:
        for line in stream:
            row = json.loads(line)
            groups[tuple(row[key] for key in keys)].append(row)
    return groups


def comparison_rows(label, before, after, precision):
    return [(f"{label} · {name}", metric(before), metric(after), precision)
            for name, metric in (("p50", median), ("p90", p90))]


def latency_comparison(axis, rows, ticks, column_title="SEARXNG → RUSTXNG"):
    positions = list(reversed(range(len(rows))))
    faster = "#137571"
    slower = "#a34021"
    changes = [100 * (after / before - 1) for _, before, after, _ in rows]
    colors = [faster if change < 0 else slower for change in changes]
    axis.set_xlim(ticks[0] - 10, ticks[-1] + 10)
    axis.set_ylim(-0.65, len(rows) - 0.35)
    axis.set_xticks(ticks, [f"{tick:+g}%" if tick else "0%" for tick in ticks])
    axis.set_yticks(positions, [label for label, *_ in rows])
    axis.set_axisbelow(True)
    axis.grid(axis="x", color=GRID, linewidth=0.8)
    axis.axvline(0, color=MUTED, linewidth=0.9)
    axis.tick_params(axis="both", length=0)
    for spine in axis.spines.values():
        spine.set_visible(False)
    axis.barh(positions, changes, color=colors, height=0.52)
    transform = axis.get_yaxis_transform()
    for y, change, color, (_, before, after, precision) in zip(positions, changes, colors, rows):
        axis.text(1.05, y, f"{change:+.1f}%", color=color, fontweight="bold", va="center", transform=transform)
        axis.text(1.25, y, f"{before:,.{precision}f} → {after:,.{precision}f} ms",
                  va="center", transform=transform)
    axis.text(1.05, 1.05, "CHANGE", transform=axis.transAxes, fontsize=9, color=MUTED)
    axis.text(1.25, 1.05, column_title, transform=axis.transAxes, fontsize=9, color=MUTED)


def engines_chart():
    groups = comparison_groups("engine-benchmark-results.jsonl", "engines", "profile", "trial")
    engine_sets = [("Wikipedia", "wikipedia"), ("Wikipedia + Wiby", "wikipedia,wiby")]
    profiles = ("searxng", "rustxng")
    first, repeat = [], []
    for label, engines in engine_sets:
        for trial, rows in ((1, first), (2, repeat)):
            before, after = ([row["ms"] for row in groups[engines, profile, trial] if not row.get("error")]
                             for profile in profiles)
            rows.extend(comparison_rows(label, before, after, 2))

    figure, axes = plt.subplots(2, 1, figsize=(12.6, 6.9))
    figure.subplots_adjust(left=0.24, right=0.715, top=0.76, bottom=0.23, hspace=0.69)
    figure.text(0.055, 0.92, "SearXNG vs RustXNG", fontsize=25, fontweight="bold")
    topics = {row["topic"] for rows in groups.values() for row in rows}
    calls = sum(map(len, groups.values()))
    figure.text(0.055, 0.867, f"Live providers · Same {len(topics)} topics and host · {calls} direct HTTP searches", color=MUTED)
    for axis, title, rows in zip(axes, ("First pass", "Identical repeat"), (first, repeat)):
        axis.set_title(title, loc="left", fontsize=14, fontweight="bold", pad=12)
        latency_comparison(axis, rows, [-100, -50, 0, 50, 100, 150, 200])

    hit_labels = []
    result_labels = []
    for name, engines in engine_sets:
        combined = [[row for trial in (1, 2) for row in groups[engines, profile, trial]]
                    for profile in profiles]
        (before, total_before), (after, total_after) = [
            (sum(row.get("rank", 0) > 0 for row in rows), len(rows)) for rows in combined
        ]
        points = 100 * (after / total_after - before / total_before)
        hit_labels.append(f"{name} {before}/{total_before} → {after}/{total_after} ({points:+.1f} pp)")
        before, after = [median(row["results"] for row in rows) for rows in combined]
        change = 100 * (after / before - 1)
        result_labels.append(f"{name} {before:g} → {after:g} ({change:+.1f}%)")
    figure.text(0.055, 0.126, f"Reference hit@5 · {'   |   '.join(hit_labels)}",
                fontsize=12, fontweight="bold")
    figure.text(0.055, 0.084, f"Median result rows · {'   |   '.join(result_labels)}", color=MUTED)
    figure.text(0.055, 0.037, "Negative values mean lower latency. Identical repeats include caching. Provider adapters can issue different requests.",
                color=MUTED, fontsize=9)
    figure.savefig(DOCS / "searxng-vs-rustxng.png", dpi=175)
    plt.close(figure)


def matched_chart():
    groups = comparison_groups("matched-provider-results.jsonl", "mode", "profile")
    rows = []
    for label, mode in (("Local HTTPS", "local"), ("HTTPS + 80 ms timer", "delay")):
        before, after = ([row["totalMs"] for row in groups[mode, profile]]
                         for profile in ("searxng", "rustxng"))
        rows.extend(comparison_rows(label, before, after, 3))

    figure, axis = plt.subplots(figsize=(12.6, 4.0))
    figure.subplots_adjust(left=0.25, right=0.715, top=0.68, bottom=0.25)
    figure.text(0.055, 0.87, "Same provider request and results", fontsize=24, fontweight="bold")
    calls = sum(map(len, groups.values()))
    figure.text(0.055, 0.77, f"One HTTPS call and the same ten result rows per search · {calls} direct HTTP searches", color=MUTED)
    latency_comparison(axis, rows, [-100, -75, -50, -25, 0])
    figure.text(0.055, 0.088, "Negative values mean lower latency. Queries were unique and connection pools were warmed.",
                color=MUTED, fontsize=9)
    figure.savefig(DOCS / "matched-provider-comparison.png", dpi=175)
    plt.close(figure)


def fresh_user_chart():
    groups = comparison_groups("fresh-user-search-results.jsonl", "profile")
    before, after = [groups[profile,] for profile in ("searxng", "rustxng")]
    timings = comparison_rows("HTML",
                              [row["ms"] for row in before if "ms" in row],
                              [row["ms"] for row in after if "ms" in row], 1)
    diagnostic = comparison_groups("fresh-user-search-timings.jsonl", "profile")
    timings.extend(comparison_rows("Diagnostic JSON",
                                   *([row["ms"] for row in diagnostic[profile,] if "ms" in row]
                                     for profile in ("searxng", "rustxng")), 1))
    figure, axis = plt.subplots(figsize=(12.6, 4.2))
    figure.subplots_adjust(left=0.23, right=0.715, top=0.65, bottom=0.29)
    topics = len({row["topic"] for row in before})
    figure.text(0.055, 0.87, "Fresh searches on live providers", fontsize=24, fontweight="bold")
    figure.text(0.055, 0.76, f"SearXNG vs RustXNG v0.32.0 · {topics} different queries per run · Complete responses", color=MUTED)
    latency_comparison(axis, timings, [-40, -30, -20, -10, 0, 10, 20])
    hits = [sum(row.get("rank", 0) > 0 for row in rows) for rows in (before, after)]
    wins = sum(rust["ms"] < sear["ms"] for rust, sear in zip(after, before) if "ms" in rust and "ms" in sear)
    figure.text(0.055, 0.14, f"HTML run · RustXNG was quicker on {wins}/{topics} queries · Reference hit@5 {hits[0]}/{topics} → {hits[1]}/{topics}",
                fontsize=11, fontweight="bold")
    figure.text(0.055, 0.07, "Wikipedia, Wiby, GitHub and Hacker News · No timed query was reused within a service.",
                fontsize=9, color=MUTED)
    figure.savefig(DOCS / "fresh-user-search.png", dpi=175)
    plt.close(figure)


def candidate_chart():
    samples = comparison_groups("fresh-user-candidate-results.jsonl", "profile")
    rows = []
    candidate = [row["ms"] for row in samples["rustxng-candidate",] if "ms" in row]
    for label, profile in (("RustXNG release", "rustxng"), ("SearXNG", "searxng")):
        prior = [row["ms"] for row in samples[profile,] if "ms" in row]
        rows.extend(comparison_rows(label, prior, candidate, 1))
    figure, axis = plt.subplots(figsize=(12.6, 3.9))
    figure.subplots_adjust(left=0.23, right=0.715, top=0.64, bottom=0.25)
    figure.text(0.055, 0.87, "Newer RustXNG build on live searches", fontsize=24, fontweight="bold")
    figure.text(0.055, 0.76, "Revision 742dc97 · Three-way HTML run · 18 different queries per service", color=MUTED)
    latency_comparison(axis, rows, [-30, -20, -10, 0, 10], "BASELINE → NEW BUILD")
    hits = [sum(row.get("rank", 0) > 0 for row in samples[profile,])
            for profile in ("searxng", "rustxng", "rustxng-candidate")]
    figure.text(0.055, 0.08, "Reference hit@5 · " + "   |   ".join(
        f"{name} {count}/{len(candidate)}" for name, count in zip(("SearXNG", "Release", "New build"), hits)),
        fontsize=10, color=MUTED)
    figure.savefig(DOCS / "fresh-user-candidate.png", dpi=175)
    plt.close(figure)


if __name__ == "__main__":
    live_chart()
    fetch_chart()
    engines_chart()
    matched_chart()
    fresh_user_chart()
    candidate_chart()

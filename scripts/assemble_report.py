#!/usr/bin/env python3
"""Assemble a TradingAgents run into readable Markdown and HTML reports.

The subagents each write their own section file under the run directory, so
nothing long has to pass back through the orchestrator. This script joins them
into a fixed layout and produces two reader-facing artifacts:

    complete_report.md    structured Markdown with a decision table and TOC
    complete_report.html  one self-contained, offline page with a rating badge,
                          summary cards, collapsible sections and print styles
    meta.json             machine-readable run metadata

Usage (through the bundled wrapper, which bootstraps the private venv):
    "$TRADING_AGENTS_HOME/bin/ta-assemble" \
        --run-dir /path/to/run --ticker NVDA --date 2026-10-20 --rating Hold \
        --analysts market,social,news,fundamentals --debate-rounds 1 --risk-rounds 1
"""

from __future__ import annotations

import argparse
import html
import json
import re
from datetime import datetime
from pathlib import Path

try:
    import markdown
except ImportError:  # the plugin venv installs it; keep a readable fallback
    markdown = None

SECTIONS = (
    ("I. Analyst Team Reports", "analysts", "1_analysts", (
        ("Market Analyst", "market.md", "market"),
        ("Sentiment Analyst", "sentiment.md", "sentiment"),
        ("News Analyst", "news.md", "news"),
        ("Fundamentals Analyst", "fundamentals.md", "fundamentals"),
    )),
    ("II. Research Team Decision", "research", "2_research", (
        ("Bull Researcher", "bull.md", "bull"),
        ("Bear Researcher", "bear.md", "bear"),
        ("Research Manager", "manager.md", "manager"),
    )),
    ("III. Trading Team Plan", "trading", "3_trading", (
        ("Trader", "trader.md", "trader"),
    )),
    ("IV. Risk Management Team Decision", "risk", "4_risk", (
        ("Aggressive Analyst", "aggressive.md", "aggressive"),
        ("Conservative Analyst", "conservative.md", "conservative"),
        ("Neutral Analyst", "neutral.md", "neutral"),
    )),
    ("V. Portfolio Manager Decision", "portfolio", "5_portfolio", (
        ("Portfolio Manager", "decision.md", "decision"),
    )),
)

GAP_MARKERS = re.compile(
    r"(DATA_UNAVAILABLE|unavailable|not provided|No .* report in this run)", re.IGNORECASE
)

RATING_CLASS = {
    "Buy": "rating-buy",
    "Overweight": "rating-buy",
    "Hold": "rating-hold",
    "Underweight": "rating-sell",
    "Sell": "rating-sell",
    "REVIEW": "rating-review",
}


# --------------------------------------------------------------------------- #
# reading and extraction
# --------------------------------------------------------------------------- #


def read(path: Path) -> str:
    return path.read_text(encoding="utf-8").strip() if path.is_file() else ""


def field(text: str, label: str) -> str:
    """A ``**Label**: value`` block, including continuation lines."""
    pattern = rf"^\s*\*\*{re.escape(label)}\*\*\s*:\s*(.*?)(?=\n\s*\*\*[A-Z][^*\n]*\*\*\s*:|\Z)"
    match = re.search(pattern, text or "", re.MULTILINE | re.DOTALL)
    return match.group(1).strip() if match else ""


def sentiment_glance(text: str) -> str:
    band = re.search(r"\*\*Overall Sentiment:\*\*\s*\*\*(.+?)\*\*\s*\(Score:\s*([\d.]+)/10\)",
                     text or "")
    confidence = re.search(r"\*\*Confidence:\*\*\s*(\w+)", text or "")
    if not band:
        return "not reported"
    value = f"{band.group(1)} · {band.group(2)}/10"
    if confidence:
        value += f" · {confidence.group(1).lower()} confidence"
    return value


def preview(text: str, limit: int = 180) -> str:
    for line in (text or "").splitlines():
        line = re.sub(r"^[#>*\-\s]+", "", line).strip()
        if not line or line.startswith("|") or line.startswith("**"):
            continue
        line = re.sub(r"[*_`]", "", line)
        return line[:limit] + ("…" if len(line) > limit else "")
    return ""


def demote_headings(text: str, levels: int = 2) -> str:
    """Push embedded report headings below the report's own section level."""
    out, fence = [], False
    for line in (text or "").splitlines():
        if line.strip().startswith("```"):
            fence = not fence
        elif not fence:
            match = re.match(r"^(#{1,5})\s+(.*)$", line)
            if match:
                line = "#" * min(6, len(match.group(1)) + levels) + " " + match.group(2)
        out.append(line)
    return "\n".join(out)


def collect_gaps(sections: list[tuple[str, str]], missing: list[str]) -> list[str]:
    gaps, seen = [], set()
    for name, text in sections:
        in_fence = False
        for line in (text or "").splitlines():
            if line.strip().startswith("```"):
                in_fence = not in_fence
                continue
            if in_fence:
                continue
            line = re.sub(r"^[\s>*\-\u2022]+", "", line).strip()
            line = re.sub(r"\*\*", "", line)
            # Table rows are too noisy to read as gaps; skip them.
            if (not line or line.startswith("|") or len(line) > 220
                    or not GAP_MARKERS.search(line)):
                continue
            key = line.lower()
            if key not in seen:
                seen.add(key)
                gaps.append(f"{name}: {line}")
    for item in missing:
        gaps.append(f"Missing report: {item}")
    return gaps[:20]


def metric_cards(decision: str, trader: str, sentiment: str, rating: str) -> list[tuple[str, str]]:
    return [
        ("Rating", rating),
        ("Trader action", field(trader, "Action") or "not provided"),
        ("Sentiment", sentiment_glance(sentiment)),
        ("Trader entry", field(trader, "Entry Price") or "not provided"),
        ("Trader stop", field(trader, "Stop Loss") or "not provided"),
        ("Trader sizing", preview(field(trader, "Position Sizing"), 160) or "not provided"),
        ("Price target", field(decision, "Price Target") or "not provided"),
        ("Time horizon", field(decision, "Time Horizon") or "not provided"),
    ]


# --------------------------------------------------------------------------- #
# Markdown report
# --------------------------------------------------------------------------- #


def table_cell(value: str) -> str:
    return (value or "—").replace("|", "\\|").replace("\n", " ").strip()


def build_markdown(args, sections, gaps, missing, generated, version) -> str:
    by_path = dict(sections)
    decision = by_path.get("5_portfolio/decision.md", "")
    trader = by_path.get("3_trading/trader.md", "")
    sentiment = by_path.get("1_analysts/sentiment.md", "")

    summary = field(decision, "Executive Summary") or "not provided"
    cards = metric_cards(decision, trader, sentiment, args.rating)
    card_table = "\n".join(
        ["| Field | Value |", "|---|---|"]
        + [f"| {table_cell(label)} | {table_cell(value)} |" for label, value in cards]
    )

    toc_lines = ["- [Decision at a Glance](#summary)"]
    section_blocks = []
    for heading, anchor, folder, agents in SECTIONS:
        present = [agent for agent, filename, _key in agents
                   if f"{folder}/{filename}" in by_path]
        if not present:
            continue
        toc_lines.append(f"- [{heading}](#{anchor})")
        blocks = []
        for agent, filename, _key in agents:
            text = by_path.get(f"{folder}/{filename}", "")
            if not text:
                continue
            blocks.append(f"### {agent}\n\n{demote_headings(text, 3)}")
        section_blocks.append(
            f'<a id="{anchor}"></a>\n## {heading}\n\n' + "\n\n".join(blocks)
        )
    toc_lines.extend(["- [Data Gaps](#gaps)", "- [Run Metadata](#meta)"])

    lines = [
        f"# Trading Analysis Report: {args.ticker}",
        "",
        f"> **Rating: {args.rating}** · Analysis date: {args.date} · "
        f"Generated: {generated}",
        "",
        "Also available as a styled, self-contained [HTML report](complete_report.html).",
        "",
        '<a id="summary"></a>',
        "## Decision at a Glance",
        "",
        card_table,
        "",
        "*Entry, stop and sizing are the Trader's proposal; the Portfolio Manager's "
        "decision below may override them.*",
        "",
        "### Executive Summary",
        "",
        summary,
        "",
        "## Contents",
        "",
        *toc_lines,
        "",
        *section_blocks,
        "",
        '<a id="gaps"></a>',
        "## Data Gaps",
        "",
        "*Automatically extracted from the section text; read the full reports "
        "for context.*",
        "",
        ("\n".join(f"- {gap}" for gap in gaps) if gaps
         else "No explicit data gaps were reported by the section writers."),
        "",
        '<a id="meta"></a>',
        "## Run Metadata",
        "",
        "| Field | Value |",
        "|---|---|",
        f"| Ticker | {table_cell(args.ticker)} |",
        f"| Analysis date | {table_cell(args.date)} |",
        f"| Rating | {table_cell(args.rating)} |",
        f"| Analysts | {table_cell(args.analysts)} |",
        f"| Research debate rounds | {args.debate_rounds} |",
        f"| Risk debate rounds | {args.risk_rounds} |",
        f"| Engine | DeepSeek Harness subagents · trading-agents plugin {version} |",
        f"| Generated | {generated} |",
        f"| Missing sections | {table_cell(', '.join(missing) if missing else 'none')} |",
        "",
        "---",
        "",
        "*Generated locally by the trading-agents DeepSeek Harness plugin. "
        "Not investment advice.*",
        "",
    ]
    return "\n".join(lines)


# --------------------------------------------------------------------------- #
# HTML report
# --------------------------------------------------------------------------- #


LT_TOKEN = "@@TA_LT@@"
GT_TOKEN = "@@TA_GT@@"


def md_to_html(text: str) -> str:
    if not text:
        return ""
    # Protect raw angle brackets so placeholders such as
    # `<StockTwits unavailable: ...>` display literally instead of being parsed
    # as HTML tags. Do not pre-escape "&": Markdown already escapes it, and
    # escaping it here would double-escape entities inside code spans.
    safe = text.replace("<", LT_TOKEN).replace(">", GT_TOKEN)
    if markdown is None:
        fallback = html.escape(safe, quote=False)
        return ("<pre>"
                + fallback.replace(LT_TOKEN, "&lt;").replace(GT_TOKEN, "&gt;")
                + "</pre>")
    rendered = markdown.markdown(safe, extensions=["tables", "fenced_code", "sane_lists"])
    rendered = rendered.replace(LT_TOKEN, "&lt;").replace(GT_TOKEN, "&gt;")
    rendered = rendered.replace("<table>", '<div class="table-wrap"><table>')
    rendered = rendered.replace("</table>", "</table></div>")
    return rendered


def inline_md(text: str) -> str:
    """Render inline code and bold for a single line that is not a block.

    Data-gap lines are plain strings rather than a Markdown block, so their
    backticks used to show literally in the HTML. Escape the text first, then
    turn ``code`` and **bold** spans into their HTML equivalents.
    """
    safe = html.escape(text or "", quote=False)
    safe = re.sub(r"`([^`]+)`", r"<code>\1</code>", safe)
    safe = re.sub(r"\*\*([^*]+)\*\*", r"<strong>\1</strong>", safe)
    return safe


def html_section(title: str, anchor: str, bodies: list[tuple[str, str, bool]],
                 intro: str = "") -> str:
    inner = []
    if intro:
        inner.append(f'<p class="section-intro">{html.escape(intro)}</p>')
    for agent, text, open_default in bodies:
        hint = preview(text)
        open_attr = " open" if open_default else ""
        inner.append(
            f'<details class="report"{open_attr}>'
            f"<summary><span class=\"agent\">{html.escape(agent)}</span>"
            f"<span class=\"hint\">{html.escape(hint)}</span></summary>"
            f'<div class="body">{md_to_html(demote_headings(text, 2))}</div>'
            "</details>"
        )
    return "\n".join([
        f'<section id="{anchor}">',
        f"<h2>{html.escape(title)}</h2>",
        *inner,
        "</section>",
    ])


def build_html(args, sections, gaps, missing, generated, version) -> str:
    by_path = dict(sections)
    decision = by_path.get("5_portfolio/decision.md", "")
    trader = by_path.get("3_trading/trader.md", "")
    sentiment = by_path.get("1_analysts/sentiment.md", "")
    summary = field(decision, "Executive Summary") or "not provided"
    cards = metric_cards(decision, trader, sentiment, args.rating)

    lang = "zh-CN" if ("chinese" in args.language.lower() or "中文" in args.language) else "en"
    rating_class = RATING_CLASS.get(args.rating, "rating-review")

    card_html = "\n".join(
        f'<div class="card"><div class="label">{html.escape(label)}</div>'
        f'<div class="value" title="{html.escape(value, quote=True)}">{html.escape(value)}</div></div>'
        for label, value in cards
    )

    toc = [
        ("summary", "Decision at a Glance"),
        ("analysts", "I. Analyst Team Reports"),
        ("research", "II. Research Team Decision"),
        ("trading", "III. Trading Team Plan"),
        ("risk", "IV. Risk Management Team Decision"),
        ("portfolio", "V. Portfolio Manager Decision"),
        ("gaps", "Data Gaps"),
        ("meta", "Run Metadata"),
    ]
    toc_html = "\n".join(
        f'<a href="#{anchor}">{html.escape(label)}</a>' for anchor, label in toc
    )

    open_by_key = {"market": True, "manager": True, "trader": True, "decision": True}

    body_sections = []
    for heading, anchor, folder, agents in SECTIONS:
        bodies = []
        for agent, filename, key in agents:
            text = by_path.get(f"{folder}/{filename}", "")
            if text:
                bodies.append((agent, text, open_by_key.get(key, False)))
        if bodies:
            body_sections.append(html_section(heading, anchor, bodies))

    gaps_html = ("<ul class=\"gap-list\">"
                 + "".join(f"<li>{inline_md(gap)}</li>" for gap in gaps)
                 + "</ul>") if gaps else (
        "<p>No explicit data gaps were reported by the section writers.</p>")

    meta_rows = [
        ("Ticker", args.ticker),
        ("Analysis date", args.date),
        ("Rating", args.rating),
        ("Analysts", args.analysts),
        ("Research debate rounds", str(args.debate_rounds)),
        ("Risk debate rounds", str(args.risk_rounds)),
        ("Engine", f"DeepSeek Harness subagents · trading-agents plugin {version}"),
        ("Generated", generated),
        ("Missing sections", ", ".join(missing) if missing else "none"),
    ]
    meta_html = "\n".join(
        f"<tr><th>{html.escape(label)}</th><td>{html.escape(value)}</td></tr>"
        for label, value in meta_rows
    )

    return f"""<!doctype html>
<html lang="{lang}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Trading Analysis Report: {html.escape(args.ticker)} · {html.escape(args.date)}</title>
<style>
:root {{
  --bg: #f6f7f9; --panel: #ffffff; --text: #111827; --muted: #6b7280;
  --line: #e5e7eb; --accent: #2563eb; --code: #f3f4f6;
  --green: #15803d; --green-bg: #dcfce7; --red: #b91c1c; --red-bg: #fee2e2;
  --amber: #b45309; --amber-bg: #fef3c7; --blue-bg: #dbeafe;
}}
@media (prefers-color-scheme: dark) {{
  :root {{
    --bg: #0b1220; --panel: #111827; --text: #e5e7eb; --muted: #9ca3af;
    --line: #1f2937; --accent: #60a5fa; --code: #1f2937;
    --green: #4ade80; --green-bg: #052e16; --red: #f87171; --red-bg: #450a0a;
    --amber: #fbbf24; --amber-bg: #451a03; --blue-bg: #172554;
  }}
}}
* {{ box-sizing: border-box; }}
html {{ scroll-behavior: smooth; }}
body {{
  margin: 0; background: var(--bg); color: var(--text);
  font-family: ui-sans-serif, -apple-system, BlinkMacSystemFont, "Segoe UI",
    Roboto, "Helvetica Neue", Arial, "PingFang SC", "Hiragino Sans GB",
    "Microsoft YaHei", sans-serif;
  line-height: 1.62; font-size: 15px;
}}
.wrap {{ max-width: 1120px; margin: 0 auto; padding: 32px 24px 64px; }}
.hero {{
  background: var(--panel); border: 1px solid var(--line); border-radius: 18px;
  padding: 26px 28px; box-shadow: 0 1px 2px rgba(0,0,0,.04);
}}
.eyebrow {{ color: var(--muted); font-size: 12px; letter-spacing: .12em;
  text-transform: uppercase; font-weight: 650; }}
h1 {{ margin: 6px 0 10px; font-size: 34px; line-height: 1.15; letter-spacing: -.02em; }}
.hero-row {{ display: flex; flex-wrap: wrap; align-items: center; gap: 10px 14px; }}
.badge {{ display: inline-block; padding: 5px 12px; border-radius: 999px;
  font-size: 13px; font-weight: 750; letter-spacing: .02em; }}
.rating-buy {{ color: var(--green); background: var(--green-bg); }}
.rating-sell {{ color: var(--red); background: var(--red-bg); }}
.rating-hold {{ color: var(--amber); background: var(--amber-bg); }}
.rating-review {{ color: var(--accent); background: var(--blue-bg); }}
.muted {{ color: var(--muted); }}
.lede {{ margin: 6px 0 0; font-size: 16px; }}
.lede-label {{ margin-top: 16px; color: var(--muted); font-size: 11px;
  letter-spacing: .09em; text-transform: uppercase; font-weight: 650; }}
.toc {{ display: flex; flex-wrap: wrap; gap: 8px; margin: 18px 0 6px; }}
.toc a {{ color: var(--accent); text-decoration: none; background: var(--panel);
  border: 1px solid var(--line); border-radius: 999px; padding: 6px 12px;
  font-size: 13px; font-weight: 600; }}
.toc a:hover {{ text-decoration: underline; }}
section {{ margin-top: 30px; }}
h2 {{ font-size: 22px; margin: 0 0 12px; letter-spacing: -.01em; }}
h3, h4 {{ margin: 20px 0 8px; }}
h5, h6 {{ margin: 16px 0 6px; font-size: 14px; }}
.section-intro {{ color: var(--muted); margin-top: -4px; }}
.cards {{ display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr));
  gap: 12px; }}
.card {{ background: var(--panel); border: 1px solid var(--line); border-radius: 12px;
  padding: 14px 16px; }}
.card .label {{ color: var(--muted); font-size: 11px; letter-spacing: .09em;
  text-transform: uppercase; font-weight: 650; }}
.card .value {{ margin-top: 4px; font-weight: 650; font-size: 16px;
  overflow-wrap: anywhere; display: -webkit-box; -webkit-line-clamp: 4;
  -webkit-box-orient: vertical; overflow: hidden; }}
details.report {{ background: var(--panel); border: 1px solid var(--line);
  border-radius: 12px; margin: 12px 0; overflow: hidden; }}
details.report > summary {{ cursor: pointer; padding: 14px 18px;
  display: flex; flex-wrap: wrap; gap: 4px 14px; align-items: baseline;
  list-style: none; }}
details.report > summary::-webkit-details-marker {{ display: none; }}
details.report > summary::before {{ content: "▸"; color: var(--muted);
  font-size: 12px; width: 12px; flex: none; }}
details.report[open] > summary::before {{ content: "▾"; }}
details.report[open] > summary {{ border-bottom: 1px solid var(--line); }}
section:target h2 {{ color: var(--accent); }}
.agent {{ font-weight: 700; font-size: 16px; }}
.hint {{ color: var(--muted); font-size: 13px; flex: 1 1 320px; min-width: 0;
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }}
.body {{ padding: 2px 20px 20px; }}
.table-wrap {{ overflow-x: auto; margin: 12px 0; }}
table {{ width: 100%; border-collapse: collapse; font-size: 13.5px;
  font-variant-numeric: tabular-nums; }}
th, td {{ border-bottom: 1px solid var(--line); padding: 8px 10px;
  text-align: left; vertical-align: top; }}
th {{ background: var(--code); font-weight: 650; }}
tr:nth-child(even) td {{ background: color-mix(in srgb, var(--code) 45%, transparent); }}
blockquote {{ margin: 12px 0; padding: 6px 16px; border-left: 3px solid var(--accent);
  color: var(--muted); background: color-mix(in srgb, var(--blue-bg) 35%, transparent); }}
code {{ background: var(--code); padding: 1px 5px; border-radius: 4px; font-size: 90%; }}
pre {{ background: var(--code); padding: 14px; border-radius: 10px; overflow-x: auto; }}
pre code {{ padding: 0; background: none; }}
hr {{ border: none; border-top: 1px solid var(--line); margin: 26px 0; }}
.gap-list li {{ margin: 6px 0; }}
.footer {{ color: var(--muted); font-size: 12px; margin-top: 34px; }}
@media (max-width: 720px) {{
  .wrap {{ padding: 20px 14px 48px; }}
  h1 {{ font-size: 27px; }}
  .hero {{ padding: 20px; }}
  .hint {{ white-space: normal; }}
}}
@media print {{
  body {{ background: #fff; color: #000; font-size: 11pt; }}
  .wrap {{ max-width: none; padding: 0; }}
  .hero, .card, details.report {{ box-shadow: none; }}
  .toc {{ display: none; }}
  details.report:not([open]) > *:not(summary) {{ display: block; }}
  details.report > summary {{ cursor: default; }}
  section {{ break-inside: auto; }}
  .card, details.report, .table-wrap {{ break-inside: avoid; }}
}}
</style>
</head>
<body>
<div class="wrap">
<header class="hero">
  <div class="eyebrow">TradingAgents · multi-agent research</div>
  <h1>{html.escape(args.ticker)} <span class="muted">· {html.escape(args.date)}</span></h1>
  <div class="hero-row">
    <span class="badge {rating_class}">{html.escape(args.rating)}</span>
    <span class="muted">Generated {html.escape(generated)} · {html.escape(args.analysts)} · research {args.debate_rounds} round(s) · risk {args.risk_rounds} round(s)</span>
  </div>
  <p class="lede-label">Executive summary</p>
  <p class="lede">{html.escape(summary)}</p>
</header>

<nav class="toc">
{toc_html}
</nav>

<section id="summary">
<h2>Decision at a Glance</h2>
<div class="cards">
{card_html}
</div>
<p class="section-intro">Entry, stop and sizing are the Trader's proposal; the Portfolio Manager's decision below may override them.</p>
</section>

{chr(10).join(body_sections)}

<section id="gaps">
<h2>Data Gaps</h2>
<p class="section-intro">Automatically extracted from the section text; read the full reports for context.</p>
{gaps_html}
</section>

<section id="meta">
<h2>Run Metadata</h2>
<div class="table-wrap"><table>
{meta_html}
</table></div>
</section>

<div class="footer">
  Generated locally by the <strong>trading-agents</strong> DeepSeek Harness plugin
  (v{html.escape(version)}). Data comes from Yahoo Finance, Google News, FRED,
  Polymarket, StockTwits and Reddit. This is research, not investment advice.
  &nbsp;·&nbsp; <a href="complete_report.md">Markdown source</a>
</div>
</div>
</body>
</html>
"""


# --------------------------------------------------------------------------- #
# entry point
# --------------------------------------------------------------------------- #


def plugin_version() -> str:
    manifest = Path(__file__).resolve().parents[1] / "package.json"
    try:
        return json.loads(manifest.read_text(encoding="utf-8")).get("version", "unknown")
    except (OSError, ValueError):
        return "unknown"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--run-dir", required=True)
    parser.add_argument("--ticker", required=True)
    parser.add_argument("--date", required=True)
    parser.add_argument("--rating", required=True)
    parser.add_argument("--analysts", default="market,social,news,fundamentals")
    parser.add_argument("--debate-rounds", type=int, default=1)
    parser.add_argument("--risk-rounds", type=int, default=1)
    parser.add_argument("--language", default="English")
    args = parser.parse_args()

    run_dir = Path(args.run_dir)
    if not run_dir.is_dir():
        raise SystemExit(f"ERROR: run directory not found: {run_dir}")
    if args.rating not in {"Buy", "Overweight", "Hold", "Underweight", "Sell", "REVIEW"}:
        raise SystemExit(
            f"ERROR: invalid rating {args.rating!r}; expected one of the 5-tier labels or REVIEW"
        )

    generated = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    version = plugin_version()

    sections: list[tuple[str, str]] = []
    missing: list[str] = []
    for _heading, _anchor, folder, agents in SECTIONS:
        for _agent, filename, _key in agents:
            key = f"{folder}/{filename}"
            text = read(run_dir / folder / filename)
            if text:
                sections.append((key, text))
            else:
                missing.append(key)

    gaps = collect_gaps(sections, missing)
    markdown_report = build_markdown(args, sections, gaps, missing, generated, version)
    html_report = build_html(args, sections, gaps, missing, generated, version)

    md_path = run_dir / "complete_report.md"
    html_path = run_dir / "complete_report.html"
    md_path.write_text(markdown_report, encoding="utf-8")
    html_path.write_text(html_report, encoding="utf-8")

    meta = {
        "ticker": args.ticker,
        "trade_date": args.date,
        "rating": args.rating,
        "engine": "deepseek-harness",
        "plugin_version": version,
        "analysts": [item for item in args.analysts.split(",") if item],
        "max_debate_rounds": args.debate_rounds,
        "max_risk_discuss_rounds": args.risk_rounds,
        "language": args.language,
        "generated_at": datetime.now().isoformat(timespec="seconds"),
        "missing_sections": missing,
        "data_gap_count": len(gaps),
        "reports": {
            "markdown": "complete_report.md",
            "html": "complete_report.html",
        },
    }
    (run_dir / "meta.json").write_text(
        json.dumps(meta, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )

    print(md_path)
    print(html_path)
    if missing:
        print("Missing sections: " + ", ".join(missing))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

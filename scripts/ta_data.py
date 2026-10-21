#!/usr/bin/env python3
"""CLI for the trading-agents plugin's standalone data layer.

Run through the bundled wrapper, which bootstraps the plugin's own venv:

    "$TRADING_AGENTS_HOME/bin/ta" snapshot NVDA --date 2026-10-20

(where TRADING_AGENTS_HOME defaults to $DSH_HOME/trading-agents).

Nothing here imports the TradingAgents Python project.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import warnings
from datetime import date, timedelta
from pathlib import Path

# yfinance still calls the deprecated Timestamp.utcnow on pandas 3.x; the
# warning is noise in every agent's tool output.
warnings.simplefilter("ignore")

import ta_lib as lib


def _plugin_version() -> str:
    """Read the DSH bundle manifest so the CLI version never drifts from it."""
    manifest = Path(__file__).resolve().parents[1] / "package.json"
    try:
        return json.loads(manifest.read_text(encoding="utf-8")).get("version", "0.0.0")
    except (OSError, ValueError):
        return "0.0.0"


VERSION = _plugin_version()


def _date(value: str | None) -> str:
    return value or lib.today()


def _window(start: str | None, end: str | None, days: int) -> tuple[str, str]:
    end = end or lib.today()
    if not start:
        start = (lib.parse_date(end) - timedelta(days=days)).isoformat()
    return start, end


def _print(title: str, body: str) -> None:
    print(f"## {title}\n")
    print(body)
    print()


# --------------------------------------------------------------------------- #
# commands
# --------------------------------------------------------------------------- #


def cmd_today(args) -> None:
    print(lib.today())


def cmd_doctor(args) -> None:
    import markdown
    import pandas
    import requests
    import yfinance

    print(f"python: {sys.version.split()[0]} ({sys.executable})")
    print(f"trading-agents plugin: {VERSION}")
    print(f"yfinance: {yfinance.__version__}")
    print(f"pandas: {pandas.__version__}")
    print(f"requests: {requests.__version__}")
    print(f"markdown: {markdown.__version__}")
    print(f"data home: {lib.data_home()}")
    print(f"memory log: {lib.memory_path()}")
    for name, url in (
        ("yahoo", "https://feeds.finance.yahoo.com/rss/2.0/headline?s=SPY&region=US&lang=en-US"),
        ("fred", "https://fred.stlouisfed.org/graph/fredgraph.csv?id=DGS10&cosd=2026-01-01"),
        ("polymarket", "https://gamma-api.polymarket.com/markets?closed=false&limit=1"),
        ("stocktwits", "https://api.stocktwits.com/api/2/streams/symbol/SPY.json"),
        ("futu", "https://ai-news-search.futunn.com/stock_feed?keyword=NVDA&size=1"),
        ("reddit", "https://www.reddit.com/r/stocks/search.rss?q=SPY&restrict_sr=1&sort=new&t=week"),
        ("google-news", "https://news.google.com/rss/search?q=stock+market&hl=en-US&gl=US&ceid=US:en"),
    ):
        try:
            if name == "fred":
                headers = {"User-Agent": lib.FRED_UA}
            elif name == "futu":
                headers = {"User-Agent": lib.FUTU_UA}
            else:
                headers = None
            response = lib.SESSION.get(url, timeout=15, headers=headers)
            print(f"{name}: HTTP {response.status_code}")
        except Exception as exc:  # noqa: BLE001
            print(f"{name}: unavailable ({type(exc).__name__})")


def cmd_identity(args) -> None:
    as_of = _date(args.date)
    print(lib.identity_text(args.ticker, as_of))
    info = lib.company_info(args.ticker)
    keys = ("longName", "shortName", "sector", "industry", "exchange", "quoteType",
            "currency", "marketCap")
    print()
    print("Resolved metadata (JSON):")
    print(json.dumps({key: info.get(key) for key in keys if info.get(key)}, indent=2,
                     ensure_ascii=False))


def cmd_quote(args) -> None:
    end = _date(args.date)
    start = args.start or (lib.parse_date(end) - timedelta(days=args.days)).isoformat()
    print(lib.quote_text(args.ticker, start, end))


def cmd_snapshot(args) -> None:
    print(lib.snapshot_text(args.ticker, _date(args.date), args.lookback))


def cmd_indicator(args) -> None:
    names = [name.strip().lower() for name in args.names.split(",") if name.strip()]
    print(lib.indicator_text(args.ticker, _date(args.date), names, args.lookback))


def cmd_fundamentals(args) -> None:
    print(lib.fundamentals_text(args.ticker, _date(args.date)))


def cmd_statement(args) -> None:
    print(lib.statement_text(args.ticker, args.kind, args.freq, _date(args.date)))


def cmd_insiders(args) -> None:
    print(lib.insiders_text(args.ticker))


def cmd_news(args) -> None:
    end = _date(args.end or args.date)
    start = args.start or (lib.parse_date(end) - timedelta(days=args.days)).isoformat()
    name = lib.company_info(args.ticker).get("longName")
    items = lib.ticker_news(args.ticker, name, start, end, args.limit)
    print(f"# News for {args.ticker} ({start}..{end})")
    print()
    print(lib.format_news(
        items,
        f"<No dated news found for {args.ticker} in {start}..{end}. This is a feed "
        "limitation, not proof of silence.>",
    ))


def cmd_global_news(args) -> None:
    end = _date(args.date)
    items = lib.global_news(end, args.lookback, args.limit)
    start = (lib.parse_date(end) - timedelta(days=args.lookback)).isoformat()
    print(f"# Global Market News, from {start} to {end}")
    print()
    print(lib.format_news(items, "<No global news returned by the RSS feeds.>"))


def cmd_macro(args) -> None:
    print(lib.macro_text(args.indicator, _date(args.date), args.lookback))


def cmd_prediction(args) -> None:
    print(lib.prediction_text(args.topic, args.limit))


def cmd_sentiment(args) -> None:
    print(lib.sentiment_bundle(args.ticker, _date(args.date), args.limit))


def cmd_futu(args) -> None:
    start = (lib.parse_date(_date(args.date)) - timedelta(days=7)).isoformat()
    print(lib.futu_community_block(args.ticker, start, _date(args.date), args.limit))


def _pending_entries(ticker: str | None) -> list[dict]:
    entries = [entry for entry in lib.load_entries() if entry["pending"]]
    if ticker:
        ticker = lib.normalize_symbol(ticker)
        entries = [entry for entry in entries if entry["ticker"] == ticker]
    return entries


def cmd_memory_context(args) -> None:
    text = lib.past_context(args.ticker, as_of=args.as_of)
    print(text or "(No resolved past decisions in the memory log.)")


def cmd_memory_store(args) -> None:
    decision = Path(args.decision_file).read_text(encoding="utf-8")
    stored = lib.store_decision(args.ticker, args.date, decision, args.rating,
                                replace=args.replace)
    if args.replace:
        print(f"Replaced the pending decision for {args.ticker} on {args.date} "
              f"with {args.rating}." if stored else
              f"No matching pending entry for {args.ticker} on {args.date}; nothing changed.")
    elif stored:
        print(f"Stored pending decision for {args.ticker} on {args.date} ({args.rating}).")
    else:
        print(f"Kept the existing memory entry for {args.ticker} on {args.date} "
              "(idempotency guard); nothing appended.")


def cmd_memory_list(args) -> None:
    entries = lib.load_entries()
    if args.pending_only:
        entries = [entry for entry in entries if entry["pending"]]
    print(json.dumps(entries, indent=2, ensure_ascii=False))


def cmd_memory_settle(args) -> None:
    holding_days = int(os.environ.get("TRADING_AGENTS_HOLDING_DAYS", "5"))
    results = []
    for entry in _pending_entries(args.ticker):
        item = {
            "ticker": entry["ticker"],
            "date": entry["date"],
            "rating": entry["rating"],
            "decision": entry["decision"],
            "holding_days": holding_days,
        }
        try:
            outcome = lib.fetch_returns(entry["ticker"], entry["date"], holding_days)
        except Exception as exc:  # noqa: BLE001
            item.update(status="failed", reason=f"prices unavailable: {type(exc).__name__}: {exc}")
            results.append(item)
            continue
        item.update(outcome)
        results.append(item)
    print(json.dumps(results, indent=2, ensure_ascii=False))


def cmd_memory_outcome(args) -> None:
    reflection = Path(args.reflection_file).read_text(encoding="utf-8").strip()
    updated = lib.update_outcome(
        args.ticker, args.date, args.raw_return, args.alpha_return,
        args.holding_days, reflection, resolution_date=args.resolution_date,
    )
    print("Settled." if updated else "No pending entry matched; nothing changed.")


# --------------------------------------------------------------------------- #
# CLI
# --------------------------------------------------------------------------- #


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--version", action="version", version=f"%(prog)s {VERSION}")
    sub = parser.add_subparsers(dest="command", required=True)

    def add_date(target, dest="date"):
        target.add_argument("--date", default=None, help="analysis date, YYYY-MM-DD (default: today)")

    p = sub.add_parser("today", help="print today's date in YYYY-MM-DD")
    p.set_defaults(func=cmd_today)

    p = sub.add_parser("doctor", help="show environment and data-source connectivity")
    p.set_defaults(func=cmd_doctor)

    p = sub.add_parser("identity", help="resolve company name / sector / exchange")
    p.add_argument("ticker")
    add_date(p)
    p.add_argument("--asset-type", default="stock", choices=["stock", "crypto"])
    p.set_defaults(func=cmd_identity)

    p = sub.add_parser("quote", help="OHLCV price history")
    p.add_argument("ticker")
    add_date(p)
    p.add_argument("--start", default=None)
    p.add_argument("--days", type=int, default=180)
    p.set_defaults(func=cmd_quote)

    p = sub.add_parser("snapshot", help="verified OHLCV + indicators (source of truth)")
    p.add_argument("ticker")
    add_date(p)
    p.add_argument("--lookback", type=int, default=30)
    p.set_defaults(func=cmd_snapshot)

    p = sub.add_parser("indicator", help="technical indicators, comma separated")
    p.add_argument("ticker")
    add_date(p)
    p.add_argument("--names", required=True, help=", ".join(lib.INDICATOR_NAMES))
    p.add_argument("--lookback", type=int, default=30)
    p.set_defaults(func=cmd_indicator)

    p = sub.add_parser("fundamentals", help="company overview and trailing metrics")
    p.add_argument("ticker")
    add_date(p)
    p.set_defaults(func=cmd_fundamentals)

    p = sub.add_parser("statement", help="balance sheet, cashflow or income statement")
    p.add_argument("ticker")
    p.add_argument("--kind", required=True, choices=["balance", "cashflow", "income"])
    p.add_argument("--freq", default="quarterly", choices=["quarterly", "annual"])
    add_date(p)
    p.set_defaults(func=cmd_statement)

    p = sub.add_parser("insiders", help="insider transactions")
    p.add_argument("ticker")
    add_date(p)
    p.set_defaults(func=cmd_insiders)

    p = sub.add_parser("news", help="ticker news over a window")
    p.add_argument("ticker")
    add_date(p)
    p.add_argument("--start", default=None)
    p.add_argument("--end", default=None)
    p.add_argument("--days", type=int, default=30)
    p.add_argument("--limit", type=int, default=20)
    p.set_defaults(func=cmd_news)

    p = sub.add_parser("global-news", help="macro / market news")
    add_date(p)
    p.add_argument("--lookback", type=int, default=7)
    p.add_argument("--limit", type=int, default=10)
    p.set_defaults(func=cmd_global_news)

    p = sub.add_parser("macro", help="FRED macro series (keyless CSV endpoint)")
    p.add_argument("indicator", help="cpi, core_pce, unemployment, fed_funds_rate, "
                                     "10y_treasury, yield_curve, real_gdp, vix, "
                                     "ecb_deposit_rate, euro_hicp, euro_core_hicp, "
                                     "euro_real_gdp, germany_10y, france_10y, eur_usd, "
                                     "or a raw FRED series ID")
    add_date(p)
    p.add_argument("--lookback", type=int, default=365)
    p.set_defaults(func=cmd_macro)

    p = sub.add_parser("prediction", help="Polymarket event probabilities")
    p.add_argument("topic")
    add_date(p)
    p.add_argument("--limit", type=int, default=6)
    p.set_defaults(func=cmd_prediction)

    p = sub.add_parser("sentiment", help="news + StockTwits + Futu + Reddit bundle")
    p.add_argument("ticker")
    add_date(p)
    p.add_argument("--limit", type=int, default=30)
    p.set_defaults(func=cmd_sentiment)

    p = sub.add_parser("futu", help="Futu community/feed (牛牛圈) posts")
    p.add_argument("ticker")
    add_date(p)
    p.add_argument("--limit", type=int, default=30)
    p.set_defaults(func=cmd_futu)

    mem = sub.add_parser("memory", help="memory log operations").add_subparsers(
        dest="memory_command", required=True
    )
    p = mem.add_parser("context", help="lessons from resolved past decisions")
    p.add_argument("ticker")
    p.add_argument("--as-of", default=None)
    p.set_defaults(func=cmd_memory_context)

    p = mem.add_parser("store", help="append this run's decision as pending")
    p.add_argument("ticker")
    p.add_argument("--date", required=True)
    p.add_argument("--rating", required=True)
    p.add_argument("--decision-file", required=True)
    p.add_argument("--replace", action="store_true",
                   help="rewrite an existing pending entry for the same ticker+date")
    p.set_defaults(func=cmd_memory_store)

    p = mem.add_parser("list", help="dump entries as JSON")
    p.add_argument("--pending-only", action="store_true")
    p.set_defaults(func=cmd_memory_list)

    p = mem.add_parser("settle", help="score pending decisions whose window has traded")
    p.add_argument("--ticker", default=None)
    p.set_defaults(func=cmd_memory_settle)

    p = mem.add_parser("outcome", help="write a reflection into a settled entry")
    p.add_argument("ticker")
    p.add_argument("--date", required=True)
    p.add_argument("--raw-return", type=float, required=True)
    p.add_argument("--alpha-return", type=float, required=True)
    p.add_argument("--holding-days", type=int, required=True)
    p.add_argument("--resolution-date", default=None)
    p.add_argument("--reflection-file", required=True)
    p.set_defaults(func=cmd_memory_outcome)

    return parser


def main(argv=None) -> int:
    # Set again at runtime: pandas resets the warning filters when it imports.
    warnings.simplefilter("ignore")
    args = build_parser().parse_args(argv)
    try:
        args.func(args)
    except Exception as exc:  # noqa: BLE001 — surfaced to the agent as a hard error
        print(f"ERROR: {type(exc).__name__}: {exc}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

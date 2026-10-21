"""Standalone market-data helpers for the trading-agents DeepSeek Harness plugin.

This module deliberately imports nothing from the TradingAgents Python project.
Its only dependencies are ``yfinance``, ``pandas`` and ``requests``; all data
sources used here are keyless:

- prices / fundamentals / insider data: Yahoo Finance via yfinance
- ticker and global news: Yahoo Finance RSS + Google News RSS
- macro series: FRED's public CSV endpoint (no API key)
- prediction markets: Polymarket Gamma API
- social sentiment: StockTwits public API + Reddit RSS
- memory log: a local markdown file under the plugin's data home

Every fetcher degrades to a clearly-labelled placeholder instead of raising,
so an agent can report a data gap rather than invent a value.
"""

from __future__ import annotations

try:
    import fcntl
except ImportError:  # Windows: advisory locks are unavailable; writes still work
    fcntl = None
import html
import io
import json
import os
import re
import time
from datetime import date, datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from pathlib import Path
from urllib.parse import quote_plus
from xml.etree import ElementTree as ET

import pandas as pd
import requests
import yfinance as yf

UA = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 "
    "trading-agents-plugin/0.1"
)
# FRED's edge answers a custom User-Agent with a silent timeout; a curl-style
# string is accepted. Keep this separate from the social/news UA, which Reddit
# wants descriptive.
FRED_UA = "curl/8.7.1"
SESSION = requests.Session()
SESSION.headers.update({"User-Agent": UA, "Accept": "*/*"})

INDICATOR_DESCRIPTIONS = {
    "close_10_ema": "10 EMA: responsive short-term average; fast momentum, noisy in chop.",
    "close_50_sma": "50 SMA: medium-term trend; dynamic support/resistance.",
    "close_200_sma": "200 SMA: long-term benchmark; golden/death cross confirmation.",
    "macd": "MACD line: EMA(12)-EMA(26); crossovers and divergence.",
    "macds": "MACD signal: EMA(9) of MACD; crossover trigger.",
    "macdh": "MACD histogram: MACD minus signal; momentum strength.",
    "rsi": "RSI(14): 70/30 overbought/oversold; extremes persist in strong trends.",
    "boll": "Bollinger middle: 20 SMA basis.",
    "boll_ub": "Bollinger upper: +2 standard deviations.",
    "boll_lb": "Bollinger lower: -2 standard deviations.",
    "atr": "ATR(14): average true range; stops and position sizing.",
    "vwma": "VWMA(20): volume-weighted moving average; trend confirmation.",
}
INDICATOR_NAMES = tuple(INDICATOR_DESCRIPTIONS)

MACRO_SERIES = {
    "cpi": ("CPIAUCSL", "Consumer Price Index for All Urban Consumers: All Items",
            "Index 1982-1984=100", "monthly"),
    "core_pce": ("PCEPILFE", "Personal Consumption Expenditures Excluding Food and Energy",
                 "Index 2017=100", "monthly"),
    "unemployment": ("UNRATE", "Unemployment Rate", "Percent", "monthly"),
    "fed_funds_rate": ("FEDFUNDS", "Federal Funds Effective Rate", "Percent", "monthly"),
    "10y_treasury": ("DGS10", "10-Year Treasury Constant Maturity Rate", "Percent", "daily"),
    "yield_curve": ("T10Y2Y", "10-Year minus 2-Year Treasury Spread", "Percent", "daily"),
    "real_gdp": ("GDPC1", "Real Gross Domestic Product", "Billions of chained 2017 dollars", "quarterly"),
    "vix": ("VIXCLS", "CBOE Volatility Index", "Index", "daily"),
    "ecb_deposit_rate": ("ECBDFR", "ECB Deposit Facility Rate", "Percent", "monthly"),
    "euro_hicp": ("CP0000EZ19M086NEST", "Euro Area HICP: All Items", "Index 2015=100", "monthly"),
    "euro_core_hicp": ("CPHPTT01EZM659N", "Euro Area HICP Excluding Food and Energy",
                       "Percent change from year ago", "monthly"),
    "euro_real_gdp": ("CLVMNACSCAB1GQEA19", "Euro Area Real GDP", "Millions of chained 2010 euros", "quarterly"),
    "germany_10y": ("IRLTLT01DEM156N", "Germany Long-Term Government Bond Yield", "Percent", "monthly"),
    "france_10y": ("IRLTLT01FRM156N", "France Long-Term Government Bond Yield", "Percent", "monthly"),
    "eur_usd": ("DEXUSEU", "US Dollars per Euro", "USD per EUR", "daily"),
}

BENCHMARK_MAP = {
    ".NS": "^NSEI", ".BO": "^BSESN", ".T": "^N225", ".TW": "^TWII", ".TWO": "^TWII",
    ".KS": "^KS11", ".KQ": "^KQ11", ".HK": "^HSI", ".SI": "^STI", ".L": "^FTSE",
    ".DE": "^GDAXI", ".PA": "^FCHI", ".AS": "^AEX", ".SW": "^SSMI", ".MI": "FTSEMIB.MI",
    ".TO": "^GSPTSE", ".AX": "^AXJO", ".SS": "000001.SS", ".SZ": "399001.SZ",
    ".SA": "^BVSP", "": "SPY",
}

DEFAULT_SUBREDDITS = ("wallstreetbets", "stocks", "investing")
CRYPTO_SUBREDDITS = ("CryptoCurrency", "CryptoMarkets")


# --------------------------------------------------------------------------- #
# basics
# --------------------------------------------------------------------------- #


def today() -> str:
    return date.today().isoformat()


def parse_date(value: str) -> date:
    return datetime.strptime(value, "%Y-%m-%d").date()


def default_data_home() -> Path:
    """DSH home for plugin data: $DSH_HOME/trading-agents, else ~/.dsh/trading-agents."""
    dsh_home = os.environ.get("DSH_HOME")
    if dsh_home:
        return Path(dsh_home).expanduser() / "trading-agents"
    return Path("~/.dsh/trading-agents").expanduser()


def data_home() -> Path:
    root = Path(os.environ.get("TRADING_AGENTS_HOME") or default_data_home()).expanduser()
    root.mkdir(parents=True, exist_ok=True)
    return root


def _as_of(value: str | None) -> date:
    return parse_date(value) if value else date.today()


def _clamp(value: str | None, floor: str) -> str:
    return value or floor


def is_crypto(ticker: str) -> bool:
    upper = ticker.upper()
    return upper.endswith("-USD") or upper.endswith("USDT")


def crypto_base(ticker: str) -> str | None:
    if not is_crypto(ticker):
        return None
    base = re.split(r"-|USDT", ticker.upper())[0]
    return base or None


def normalize_symbol(ticker: str) -> str:
    """Map broker-style Hong Kong codes to Yahoo's four-digit form.

    Yahoo lists Hong Kong equities as ``2513.HK`` / ``0700.HK``; brokers often
    use five digits (``02513.HK``). Only the numeric part is normalized, so
    every other ticker and suffix is passed through unchanged.
    """
    symbol = (ticker or "").strip()
    match = re.fullmatch(r"(\d+)\.HK", symbol, re.IGNORECASE)
    if match:
        return f"{match.group(1).lstrip('0').zfill(4)}.HK"
    return symbol


def subreddits_for(ticker: str) -> tuple[str, ...]:
    base = crypto_base(ticker)
    if base:
        return (base,) + CRYPTO_SUBREDDITS
    return DEFAULT_SUBREDDITS


def fmt(value, digits: int = 2) -> str:
    if value is None:
        return "n/a"
    try:
        number = float(value)
    except (TypeError, ValueError):
        return str(value)
    if pd.isna(number):
        return "n/a"
    if abs(number) >= 1000:
        return f"{number:,.{digits}f}"
    if abs(number) < 1 and number != 0:
        return f"{number:.4f}"
    return f"{number:.{digits}f}"


def markdown_table(headers: list[str], rows: list[list], align: str = "right") -> str:
    sep = "|" + "|".join(
        "---:" if i and align == "right" else "---"
        for i in range(len(headers))
    ) + "|"
    lines = ["| " + " | ".join(headers) + " |", sep]
    lines += ["| " + " | ".join(str(cell) for cell in row) + " |" for row in rows]
    return "\n".join(lines)


def strip_html(text: str | None) -> str:
    return re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", html.unescape(text or ""))).strip()


# --------------------------------------------------------------------------- #
# prices and indicators
# --------------------------------------------------------------------------- #


def history(ticker: str, start: str, end: str, interval: str = "1d") -> pd.DataFrame:
    """Daily OHLCV from Yahoo; dates are naive and sorted ascending."""
    symbol = normalize_symbol(ticker)
    frame = yf.Ticker(symbol).history(
        start=start, end=end, interval=interval, auto_adjust=False, actions=False,
    )
    if frame is None or frame.empty:
        return pd.DataFrame()
    index = pd.to_datetime(frame.index)
    if getattr(index, "tz", None) is not None:
        index = index.tz_localize(None)
    frame = frame.copy()
    frame.index = index
    frame = frame[~frame.index.duplicated(keep="last")].sort_index()
    return frame


def fetch_through(ticker: str, as_of: str, calendar_days: int) -> pd.DataFrame:
    """Rows known on ``as_of``, with enough history for long indicators."""
    end = parse_date(as_of) + timedelta(days=1)
    start = parse_date(as_of) - timedelta(days=calendar_days)
    frame = history(ticker, start.isoformat(), end.isoformat())
    if frame.empty:
        return frame
    return frame[[d.date() <= parse_date(as_of) for d in frame.index]]


def fetch_range(ticker: str, start: str, end: str) -> pd.DataFrame:
    frame = history(ticker, start, (parse_date(end) + timedelta(days=1)).isoformat())
    if frame.empty:
        return frame
    return frame[[parse_date(start) <= d.date() <= parse_date(end) for d in frame.index]]


def _ema(series: pd.Series, span: int) -> pd.Series:
    return series.ewm(span=span, adjust=False, min_periods=span).mean()


def _sma(series: pd.Series, window: int) -> pd.Series:
    return series.rolling(window, min_periods=window).mean()


def _rsi(close: pd.Series, period: int = 14) -> pd.Series:
    delta = close.diff()
    gain = delta.clip(lower=0.0)
    loss = -delta.clip(upper=0.0)
    avg_gain = gain.ewm(alpha=1 / period, adjust=False, min_periods=period).mean()
    avg_loss = loss.ewm(alpha=1 / period, adjust=False, min_periods=period).mean()
    rs = avg_gain / avg_loss.replace(0.0, float("nan"))
    out = 100.0 - 100.0 / (1.0 + rs)
    return out.where(avg_loss != 0.0, 100.0)


def _atr(close: pd.Series, high: pd.Series, low: pd.Series, period: int = 14) -> pd.Series:
    previous = close.shift(1)
    true_range = pd.concat(
        [(high - low).abs(), (high - previous).abs(), (low - previous).abs()], axis=1
    ).max(axis=1)
    return true_range.ewm(alpha=1 / period, adjust=False, min_periods=period).mean()


def indicator_frame(frame: pd.DataFrame) -> pd.DataFrame:
    close, high, low = frame["Close"], frame["High"], frame["Low"]
    volume = frame.get("Volume", pd.Series(index=frame.index, dtype=float))
    macd = _ema(close, 12) - _ema(close, 26)
    signal = _ema(macd, 9)
    middle = _sma(close, 20)
    std = close.rolling(20, min_periods=20).std(ddof=0)
    return pd.DataFrame({
        "close_10_ema": _ema(close, 10),
        "close_50_sma": _sma(close, 50),
        "close_200_sma": _sma(close, 200),
        "macd": macd,
        "macds": signal,
        "macdh": macd - signal,
        "rsi": _rsi(close),
        "boll": middle,
        "boll_ub": middle + 2 * std,
        "boll_lb": middle - 2 * std,
        "atr": _atr(close, high, low),
        "vwma": (close * volume).rolling(20, min_periods=20).sum()
                / volume.rolling(20, min_periods=20).sum(),
    }, index=frame.index)


def snapshot_text(ticker: str, as_of: str, lookback: int = 30) -> str:
    frame = fetch_through(ticker, as_of, calendar_days=max(420, lookback * 3))
    if frame.empty:
        return f"<No Yahoo price data for {ticker} on or before {as_of}.>"
    indicators = indicator_frame(frame)
    latest = frame.iloc[-1]
    latest_date = frame.index[-1].date().isoformat()
    rows = [
        ["Open", fmt(latest["Open"])],
        ["High", fmt(latest["High"])],
        ["Low", fmt(latest["Low"])],
        ["Close", fmt(latest["Close"])],
        ["Volume", f"{int(latest['Volume']):,}" if pd.notna(latest["Volume"]) else "n/a"],
    ]
    indicator_rows = [
        [name, fmt(indicators[name].iloc[-1])] for name in INDICATOR_NAMES
    ]
    recent = frame.tail(lookback)
    closes = markdown_table(["Date", "Close"], [
        [d.date().isoformat(), fmt(row["Close"])] for d, row in recent.iterrows()
    ])
    note = "" if latest_date == as_of else (
        f"\n- Note: {as_of} has no completed session in this feed; "
        f"the latest verified row is {latest_date}."
    )
    return "\n".join([
        f"## Verified market data snapshot for {ticker}",
        "",
        f"- Requested analysis date: {as_of}",
        f"- Latest trading row used: {latest_date}",
        "- Rows after the requested analysis date are excluded before verification.",
        note,
        "",
        "### Latest verified OHLCV row",
        "",
        markdown_table(["Field", "Value"], rows),
        "",
        "### Verified technical indicators (latest row)",
        "",
        markdown_table(["Indicator", "Value"], indicator_rows),
        "",
        f"### Recent verified closes (last {len(recent)} rows)",
        "",
        closes,
    ]).strip()


def quote_text(ticker: str, start: str, end: str) -> str:
    frame = fetch_range(ticker, start, end)
    if frame.empty:
        return f"<No Yahoo price data for {ticker} between {start} and {end}.>"
    columns = [c for c in ("Open", "High", "Low", "Close", "Volume") if c in frame.columns]
    view = frame[columns].copy()
    for column in ("Open", "High", "Low", "Close"):
        if column in view:
            view[column] = view[column].map(lambda v: round(float(v), 4))
    if "Volume" in view:
        view["Volume"] = view["Volume"].map(lambda v: int(v) if pd.notna(v) else 0)
    return (
        f"# Stock data for {ticker} from {start} to {end}\n"
        f"# Total records: {len(view)}\n\n"
        + view.to_csv(index_label="Date")
    )


def indicator_text(ticker: str, as_of: str, names: list[str], lookback: int = 30) -> str:
    frame = fetch_through(ticker, as_of, calendar_days=max(420, lookback * 3))
    if frame.empty:
        return f"<No Yahoo price data for {ticker} on or before {as_of}.>"
    indicators = indicator_frame(frame)
    blocks = []
    for name in names:
        if name not in indicators:
            blocks.append(f"## Indicator: {name}\n\n<Unknown indicator. Choose from: "
                          f"{', '.join(INDICATOR_NAMES)}>")
            continue
        series = indicators[name].tail(lookback)
        lines = [
            f"## Indicator: {name}",
            "",
            INDICATOR_DESCRIPTIONS.get(name, ""),
            "",
            f"{name} values, most recent {len(series)} rows on or before {as_of}:",
            "",
        ]
        lines += [f"{d.date().isoformat()}: {fmt(v, 4)}" for d, v in series.items()]
        blocks.append("\n".join(lines))
    return "\n\n".join(blocks)


# --------------------------------------------------------------------------- #
# fundamentals
# --------------------------------------------------------------------------- #


def company_info(ticker: str) -> dict:
    try:
        handle = yf.Ticker(normalize_symbol(ticker))
        getter = getattr(handle, "get_info", None)
        return (getter() if callable(getter) else handle.info) or {}
    except Exception:
        return {}


def identity_text(ticker: str, as_of: str | None = None) -> str:
    info = company_info(ticker)
    crypto = is_crypto(ticker)
    name = info.get("longName") or info.get("shortName") or info.get("name")
    label = "asset" if crypto else "instrument"
    context = (
        f"The {label} to analyze is `{ticker}`. Refer to it by this exact ticker in "
        "every report and recommendation, preserving any exchange suffix (e.g. .TO, "
        ".HK, .T, -USD)."
    )
    details = []
    if name:
        details.append(f"{'Name' if crypto else 'Company'}: {name}")
    if info.get("sector") and info.get("industry"):
        details.append(f"Business classification: {info['sector']} / {info['industry']}")
    elif info.get("sector"):
        details.append(f"Sector: {info['sector']}")
    if info.get("exchange"):
        details.append(f"Exchange: {info['exchange']}")
    if details:
        context += (
            " Resolved identity: " + "; ".join(details)
            + ". Do not substitute a different company or ticker unless a tool result "
            "explicitly disproves this resolved identity."
        )
    if crypto:
        context += (" Treat it as a crypto asset rather than a company, and do not assume "
                    "company fundamentals are available.")
    if as_of and as_of != today():
        context += (" Identity values are current, not a historical vintage; on the analysis "
                    "date the company may have been named or classified differently.")
    return context


FUNDAMENTAL_KEYS = (
    ("longName", "Company"),
    ("sector", "Sector"),
    ("industry", "Industry"),
    ("exchange", "Exchange"),
    ("quoteType", "Quote type"),
    ("currency", "Currency"),
    ("marketCap", "Market cap"),
    ("enterpriseValue", "Enterprise value"),
    ("trailingPE", "Trailing P/E"),
    ("forwardPE", "Forward P/E"),
    ("priceToSalesTrailing12Months", "P/S (trailing)"),
    ("grossMargins", "Gross margin"),
    ("operatingMargins", "Operating margin"),
    ("profitMargins", "Net margin"),
    ("returnOnEquity", "Return on equity"),
    ("totalRevenue", "Total revenue"),
    ("revenueGrowth", "Revenue growth"),
    ("earningsGrowth", "Earnings growth"),
    ("totalCash", "Total cash"),
    ("totalDebt", "Total debt"),
    ("freeCashflow", "Free cash flow"),
    ("operatingCashflow", "Operating cash flow"),
    ("beta", "Beta"),
    ("fiftyTwoWeekHigh", "52-week high"),
    ("fiftyTwoWeekLow", "52-week low"),
    ("currentPrice", "Current price"),
    ("targetMeanPrice", "Mean analyst target"),
    ("recommendationKey", "Recommendation"),
    ("sharesOutstanding", "Shares outstanding"),
)


def fundamentals_text(ticker: str, as_of: str) -> str:
    info = company_info(ticker)
    if not info:
        return f"<Yahoo fundamentals unavailable for {ticker}.>"
    rows = []
    for key, label in FUNDAMENTAL_KEYS:
        value = info.get(key)
        if value is None:
            continue
        if key in {"marketCap", "enterpriseValue", "totalRevenue", "totalCash", "totalDebt",
                   "freeCashflow", "operatingCashflow", "sharesOutstanding"}:
            value = f"{float(value):,.0f}"
        elif key in {"grossMargins", "operatingMargins", "profitMargins", "returnOnEquity",
                     "revenueGrowth", "earningsGrowth"}:
            value = f"{float(value) * 100:.2f}%"
        else:
            value = fmt(value)
        rows.append([label, value])
    caveat = ""
    if as_of != today():
        caveat = (
            f"\n> Point-in-time caveat: these profile values are current Yahoo data, not a "
            f"vintage as of {as_of}. Use the statement tables for reported period data.\n"
        )
    return "\n".join([
        f"# Company Fundamentals for {ticker}",
        f"# Retrieved: {today()} (requested analysis date: {as_of})",
        caveat,
        markdown_table(["Field", "Value"], rows),
    ]).strip()


def _statement_frame(ticker: str, kind: str, freq: str) -> pd.DataFrame:
    handle = yf.Ticker(normalize_symbol(ticker))
    quarterly = freq == "quarterly"
    attribute = {
        "income": "quarterly_income_stmt" if quarterly else "income_stmt",
        "balance": "quarterly_balance_sheet" if quarterly else "balance_sheet",
        "cashflow": "quarterly_cashflow" if quarterly else "cashflow",
    }[kind]
    frame = getattr(handle, attribute, None)
    if frame is None or frame.empty:
        alt = handle.get_income_stmt if kind == "income" else None
        frame = alt(freq="quarterly") if callable(alt) else frame
    return frame if frame is not None else pd.DataFrame()


def statement_text(ticker: str, kind: str, freq: str, as_of: str) -> str:
    frame = _statement_frame(ticker, kind, freq)
    if frame.empty:
        return f"<Yahoo {kind} statement unavailable for {ticker}.>"
    columns = list(frame.columns)[-8:]
    frame = frame[columns]
    headers = ["Line item"] + [pd.Timestamp(c).strftime("%Y-%m-%d") for c in columns]
    rows = []
    for label, row in frame.iterrows():
        rendered = [str(label)]
        for value in row:
            if pd.isna(value):
                rendered.append("n/a")
            elif "EPS" in str(label) or "Share" in str(label):
                rendered.append(f"{float(value):,.4f}")
            else:
                rendered.append(f"{float(value) / 1_000_000:,.1f}")
        rows.append(rendered)
    return "\n".join([
        f"# {kind.title()} Statement for {ticker} ({freq})",
        f"# Retrieved {today()} for analysis date {as_of}; values in millions except "
        "per-share rows. Yahoo's current report, not a historical vintage.",
        "",
        markdown_table(headers, rows[:80]),
    ])


def insiders_text(ticker: str) -> str:
    try:
        frame = yf.Ticker(normalize_symbol(ticker)).insider_transactions
    except Exception as exc:  # noqa: BLE001
        return f"<Yahoo insider transactions unavailable for {ticker}: {type(exc).__name__}>"
    if frame is None or frame.empty:
        return f"<No insider transactions returned for {ticker}.>"
    frame = frame.tail(20)
    headers = [str(c) for c in frame.columns]
    rows = []
    for _, row in frame.iterrows():
        rendered = []
        for value in row:
            if isinstance(value, (pd.Timestamp, datetime)):
                rendered.append(pd.Timestamp(value).strftime("%Y-%m-%d"))
            elif isinstance(value, float):
                rendered.append(f"{value:,.2f}")
            else:
                rendered.append(str(value))
        rows.append(rendered)
    return markdown_table(headers, rows)


# --------------------------------------------------------------------------- #
# news
# --------------------------------------------------------------------------- #


def _parse_pub(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        parsed = parsedate_to_datetime(value)
    except (TypeError, ValueError):
        try:
            parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
        except ValueError:
            return None
    if parsed.tzinfo is not None:
        parsed = parsed.astimezone(timezone.utc).replace(tzinfo=None)
    return parsed


def _element_text(node, path: str, ns: dict | None = None) -> str:
    found = node.find(path, ns or {})
    return (found.text or "").strip() if found is not None and found.text else ""


def parse_feed(text: str) -> list[dict]:
    """RSS or Atom items as {title, link, published, summary, source}."""
    try:
        root = ET.fromstring(text)
    except ET.ParseError:
        return []
    items = []
    for node in root.findall(".//item"):
        items.append({
            "title": _element_text(node, "title"),
            "link": _element_text(node, "link"),
            "published": _parse_pub(_element_text(node, "pubDate")),
            "summary": strip_html(_element_text(node, "description")),
            "source": _element_text(node, "source"),
        })
    if items:
        return items
    ns = {"a": "http://www.w3.org/2005/Atom"}
    for node in root.findall(".//a:entry", ns):
        link_node = node.find("a:link", ns)
        category = node.find("a:category", ns)
        items.append({
            "title": _element_text(node, "a:title", ns),
            "link": link_node.get("href") if link_node is not None else "",
            "published": _parse_pub(
                _element_text(node, "a:published", ns) or _element_text(node, "a:updated", ns)
            ),
            "summary": strip_html(
                _element_text(node, "a:content", ns) or _element_text(node, "a:summary", ns)
            ),
            "source": category.get("term", "") if category is not None else "",
        })
    return items


def _fetch_feed(url: str) -> list[dict]:
    try:
        response = SESSION.get(url, timeout=20)
        response.raise_for_status()
        return parse_feed(response.text)
    except (requests.RequestException, ValueError):
        return []


def _in_window(item: dict, start: date, end: date) -> bool:
    published = item.get("published")
    return published is None or start <= published.date() <= end


def _dedupe(items: list[dict]) -> list[dict]:
    seen, out = set(), []
    for item in sorted(items, key=lambda x: x.get("published") or datetime.min, reverse=True):
        key = (item.get("title") or "").strip().lower()
        if key and key not in seen:
            seen.add(key)
            out.append(item)
    return out


def ticker_news(ticker: str, name: str | None, start: str, end: str, limit: int = 20) -> list[dict]:
    start_date, end_date = parse_date(start), parse_date(end)
    days = max(1, (end_date - start_date).days)
    query = f'"{ticker}" stock'
    if name:
        query = f'"{name}" OR "{ticker}" stock'
    urls = [
        f"https://feeds.finance.yahoo.com/rss/2.0/headline?s={quote_plus(normalize_symbol(ticker))}"
        "&region=US&lang=en-US",
        f"https://news.google.com/rss/search?q={quote_plus(query)}+when:{days}d"
        "&hl=en-US&gl=US&ceid=US:en",
    ]
    items = []
    for url in urls:
        items.extend(_fetch_feed(url))
    items = [item for item in items if _in_window(item, start_date, end_date)]
    return _dedupe(items)[:limit]


def global_news(as_of: str, lookback: int = 7, limit: int = 10,
                queries: list[str] | None = None) -> list[dict]:
    end = parse_date(as_of)
    start = end - timedelta(days=lookback)
    queries = queries or [
        "Federal Reserve interest rates inflation",
        "S&P 500 earnings GDP economic outlook",
        "geopolitical risk trade war sanctions",
        "ECB Bank of England BOJ central bank policy",
        "oil commodities supply chain energy",
    ]
    items = []
    for query in queries:
        items.extend(_fetch_feed(
            "https://news.google.com/rss/search?q="
            f"{quote_plus(query)}+when:{lookback}d&hl=en-US&gl=US&ceid=US:en"
        ))
    items.extend(_fetch_feed(
        "https://feeds.finance.yahoo.com/rss/2.0/headline?s=^GSPC&region=US&lang=en-US"
    ))
    items = [item for item in items if _in_window(item, start, end)]
    return _dedupe(items)[:limit]


def format_news(items: list[dict], empty: str) -> str:
    if not items:
        return empty
    lines = []
    for item in items:
        published = item.get("published")
        date_text = published.strftime("%Y-%m-%d") if published else "date unknown"
        source = item.get("source") or "Yahoo Finance"
        lines.append(f"### {item['title']} ({source})")
        if item.get("link"):
            lines.append(f"Link: {item['link']}")
        lines.append(f"Date: {date_text}")
        if item.get("summary"):
            lines.append(item["summary"][:400])
        lines.append("")
    return "\n".join(lines).strip()


# --------------------------------------------------------------------------- #
# macro
# --------------------------------------------------------------------------- #


def macro_text(indicator: str, as_of: str, look_back_days: int | None = None) -> str:
    key = indicator.strip().lower()
    series_id, title, units, frequency = MACRO_SERIES.get(
        key, (indicator.strip().upper(), indicator.strip().upper(), "n/a", "n/a")
    )
    days = look_back_days or 365
    start = parse_date(as_of) - timedelta(days=days)
    url = (f"https://fred.stlouisfed.org/graph/fredgraph.csv?id={quote_plus(series_id)}"
           f"&cosd={start.isoformat()}")
    try:
        response = SESSION.get(url, timeout=25, headers={"User-Agent": FRED_UA})
        response.raise_for_status()
        frame = pd.read_csv(io.StringIO(response.text))
    except (requests.RequestException, ValueError, pd.errors.ParserError) as exc:
        return (f"DATA_UNAVAILABLE: FRED series {series_id} could not be retrieved "
                f"({type(exc).__name__}). Do not fabricate values.")
    if frame.empty or len(frame.columns) < 2:
        return f"DATA_UNAVAILABLE: FRED series {series_id} returned no observations."
    date_column, value_column = frame.columns[0], frame.columns[1]
    frame[date_column] = pd.to_datetime(frame[date_column], errors="coerce")
    frame[value_column] = pd.to_numeric(frame[value_column], errors="coerce")
    frame = frame.dropna().sort_values(date_column)
    frame = frame[frame[date_column].dt.date <= parse_date(as_of)]
    if frame.empty:
        return f"DATA_UNAVAILABLE: no {series_id} observations on or before {as_of}."
    latest_date = frame[date_column].iloc[-1]
    latest = float(frame[value_column].iloc[-1])
    first = float(frame[value_column].iloc[0])
    change = latest - first
    pct = (change / first * 100) if first else None
    recent = frame.tail(12)
    table = markdown_table(
        ["Date", "Value"],
        [[row[date_column].strftime("%Y-%m-%d"), fmt(row[value_column], 4)] for _, row in recent.iterrows()],
    )
    pct_text = f"{pct:+.2f}%" if pct is not None else "n/a"
    return "\n".join([
        f"## {title} ({series_id})",
        "",
        f"- Units: {units}",
        f"- Frequency: {frequency}",
        f"- As-of cutoff: {as_of}",
        f"- Latest observation: {latest_date.strftime('%Y-%m-%d')} = {fmt(latest, 4)}",
        f"- Change over window since {frame[date_column].iloc[0].strftime('%Y-%m-%d')}: "
        f"{change:+.4f} ({pct_text})",
        "",
        f"### Recent observations (last {len(recent)})",
        "",
        table,
    ])


# --------------------------------------------------------------------------- #
# prediction markets
# --------------------------------------------------------------------------- #


def prediction_text(topic: str, limit: int = 6) -> str:
    try:
        response = SESSION.get(
            "https://gamma-api.polymarket.com/markets",
            params={"closed": "false", "limit": 500, "order": "volume24hr", "ascending": "false"},
            timeout=25,
        )
        response.raise_for_status()
        markets = response.json()
    except (requests.RequestException, ValueError) as exc:
        return f"<Polymarket unavailable: {type(exc).__name__}>"
    tokens = [
        token for token in re.findall(r"[a-z0-9]+", topic.lower())
        if len(token) > 2 and token not in {"the", "and", "for", "will", "does", "happen"}
    ]
    matches = []
    for market in markets if isinstance(markets, list) else []:
        text = " ".join(str(market.get(key, "")) for key in ("question", "description", "slug"))
        score = sum(1 for token in tokens if token in text.lower())
        if score:
            matches.append((score, market))
    matches.sort(key=lambda pair: (pair[0], float(pair[1].get("volumeNum") or 0)), reverse=True)
    if not matches:
        return f"<No open Polymarket markets matched {topic!r}.>"
    lines = [f"## Polymarket prediction markets: {topic!r}",
             "",
             "Live, market-implied probabilities; they are crowd odds, not forecasts.",
             ""]
    for _, market in matches[:limit]:
        outcomes = market.get("outcomes")
        prices = market.get("outcomePrices")
        try:
            outcomes = json.loads(outcomes) if isinstance(outcomes, str) else outcomes or []
            prices = json.loads(prices) if isinstance(prices, str) else prices or []
        except ValueError:
            outcomes, prices = [], []
        probability = ""
        for name, price in zip(outcomes, prices):
            if str(name).strip().lower() in {"yes", "true"}:
                probability = f"Yes {float(price) * 100:.0f}%"
                break
        if not probability and prices:
            probability = f"{outcomes[0] if outcomes else 'Outcome'} {float(prices[0]) * 100:.0f}%"
        volume = float(market.get("volumeNum") or 0)
        end_date = str(market.get("endDate") or "")[:10]
        lines.append(
            f"- **{market.get('question', '')}** — {probability} "
            f"(${volume:,.0f} volume, resolves {end_date or 'n/a'})"
        )
    return "\n".join(lines)


# --------------------------------------------------------------------------- #
# sentiment
# --------------------------------------------------------------------------- #


# StockTwits covers US listings and crypto. A bare numeric HK code can map to a
# different US company (2513 -> EGIO), so foreign listings must never be
# stripped to their numeric part; they get an explicit coverage-gap marker.
FOREIGN_LISTING_SUFFIXES = re.compile(
    r"\.(HK|T|L|TO|V|AX|NZ|DE|F|BE|SG|MU|DU|PA|AS|BR|LS|MC|MI|SW|VI|ST|OL|CO|HE|"
    r"IC|IR|AT|IS|SA|NS|BO|KS|KQ|TW|TWO|SI|BK|JK|KL|SS|SZ)$",
    re.IGNORECASE,
)

# Futu's public, keyless content gateway. Its stock_feed endpoint is what the
# official Futu Comment Sentiment skill uses; it mixes user posts (牛牛圈) with
# platform articles.
FUTU_FEED_URL = "https://ai-news-search.futunn.com/stock_feed"
FUTU_UA = "stock-analysis/2.0.0 (Skill)"


def stocktwits_supported(ticker: str) -> bool:
    """Whether StockTwits plausibly covers this listing."""
    return bool(crypto_base(ticker)) or not FOREIGN_LISTING_SUFFIXES.search(ticker.strip())


def _stocktwits_symbol(ticker: str) -> str:
    base = crypto_base(ticker)
    return f"{base}.X" if base else normalize_symbol(ticker).upper()


def stocktwits_block(ticker: str, start: str, end: str, limit: int = 30) -> str:
    if not stocktwits_supported(ticker):
        return (f"<StockTwits does not cover {ticker} (non-US listing); this is a "
                "coverage gap, not silence.>")
    symbol = _stocktwits_symbol(ticker)
    url = f"https://api.stocktwits.com/api/2/streams/symbol/{quote_plus(symbol)}.json"
    response = None
    for attempt in range(2):
        try:
            response = SESSION.get(url, timeout=20)
        except requests.RequestException as exc:
            if attempt == 0:
                time.sleep(1.0)
                continue
            return (f"<StockTwits unavailable for {symbol} ({type(exc).__name__}); "
                    "this is a data gap, not silence.>")
        if response.status_code == 404:
            return (f"<StockTwits has no symbol coverage for {symbol} "
                    "(HTTP 404: Symbol not found); this is a coverage gap, not silence.>")
        if response.status_code in (429, 500, 502, 503, 504) and attempt == 0:
            time.sleep(1.5)
            continue
        break
    if response is None:
        return (f"<StockTwits unavailable for {symbol}; this is a data gap, not silence.>")
    if response.status_code == 429:
        return (f"<StockTwits rate-limited for {symbol} (HTTP 429); data is unavailable "
                "for this run, not silent.>")
    if response.status_code != 200:
        return (f"<StockTwits unavailable for {symbol} (HTTP {response.status_code}); "
                "this is a data gap, not silence.>")
    try:
        messages = response.json().get("messages", [])
    except ValueError:
        return (f"<StockTwits returned malformed JSON for {symbol}; this is a data gap, "
                "not silence.>")
    start_date, end_date = parse_date(start), parse_date(end)
    kept, bullish, bearish, unlabeled = [], 0, 0, 0
    for message in messages:
        created = _parse_pub(message.get("created_at"))
        if created and not (start_date <= created.date() <= end_date):
            continue
        sentiment = ((message.get("entities") or {}).get("sentiment") or {}).get("basic")
        if sentiment == "Bullish":
            bullish += 1
        elif sentiment == "Bearish":
            bearish += 1
        else:
            unlabeled += 1
        kept.append({
            "created": created,
            "user": (message.get("user") or {}).get("username", "?"),
            "sentiment": sentiment or "no label",
            "body": strip_html(message.get("body", ""))[:280],
        })
    if not kept:
        return (f"<No StockTwits messages for ${symbol} within {start}..{end}; the endpoint "
                "only serves recent items, so this is not proof of silence.>")
    header = (f"StockTwits ${symbol}: {len(kept)} messages in window — "
              f"{bullish} bullish, {bearish} bearish, {unlabeled} unlabeled.")
    lines = [header, ""]
    for item in kept[:limit]:
        stamp = item["created"].strftime("%Y-%m-%d %H:%M") if item["created"] else "date unknown"
        lines.append(f"[{stamp}] @{item['user']} ({item['sentiment']}): {item['body']}")
    return "\n".join(lines)


def _futu_keywords(ticker: str) -> list[str]:
    """Keywords Futu's stock_feed accepts for this instrument.

    Futu resolves HK codes without the suffix (02513 or 2513) and rejects
    ``02513.HK``; US symbols use their normal ticker.
    """
    base = crypto_base(ticker)
    if base:
        return [base]
    normalized = normalize_symbol(ticker)
    if normalized.upper().endswith(".HK"):
        digits = normalized[:-3]
        candidates = [digits, digits.lstrip("0") or digits, ticker.split(".")[0]]
    else:
        candidates = [normalized]
        if "." in normalized:
            candidates.append(normalized.split(".")[0])
    out = []
    for item in candidates:
        if item and item not in out:
            out.append(item)
    return out


def _futu_feed(keyword: str, limit: int) -> tuple[list | None, str | None]:
    params = {"keyword": keyword, "size": min(max(limit, 1), 50)}
    headers = {"User-Agent": FUTU_UA, "Accept": "application/json"}
    for attempt in range(2):
        try:
            response = SESSION.get(FUTU_FEED_URL, params=params, headers=headers, timeout=20)
        except requests.RequestException as exc:
            if attempt == 0:
                time.sleep(1.0)
                continue
            return None, type(exc).__name__
        if response.status_code in (429, 500, 502, 503, 504) and attempt == 0:
            time.sleep(1.5)
            continue
        if response.status_code != 200:
            return None, f"HTTP {response.status_code}"
        try:
            payload = response.json()
        except ValueError:
            return None, "malformed JSON"
        if payload.get("code") != 0:
            return None, f"code {payload.get('code')}: {payload.get('message', '')}".strip()
        return payload.get("data") or [], None
    return None, "unavailable"


def futu_community_block(ticker: str, start: str, end: str, limit: int = 30) -> str:
    """Futu 牛牛圈 community/feed posts over the analysis window."""
    start_date, end_date = parse_date(start), parse_date(end)
    errors = []
    for keyword in _futu_keywords(ticker):
        data, error = _futu_feed(keyword, limit)
        if error:
            errors.append(f"{keyword}: {error}")
            continue
        items, seen = [], set()
        for item in data:
            published = item.get("publish_time")
            created = None
            if published not in (None, ""):
                try:
                    created = datetime.fromtimestamp(int(published), timezone.utc).replace(tzinfo=None)
                except (TypeError, ValueError, OSError):
                    created = None
            if created and not (start_date <= created.date() <= end_date):
                continue
            title = strip_html(item.get("title") or "")
            desc = strip_html(item.get("desc") or "")
            key = (str(item.get("id") or ""), title.lower())
            if key in seen or not (title or desc):
                continue
            seen.add(key)
            items.append({
                "created": created,
                "title": title,
                "desc": desc,
                "url": item.get("url") or "",
            })
        if not items:
            continue
        lines = [
            f"Futu community/feed (牛牛圈) for keyword {keyword!r}: "
            f"{len(items)} posts in window.",
            "",
        ]
        for item in items[:limit]:
            stamp = item["created"].strftime("%Y-%m-%d %H:%M") if item["created"] else "date unknown"
            text = item["title"]
            if item["desc"] and item["desc"] not in text:
                text += f" — {item['desc'][:240]}"
            lines.append(f"[{stamp}] {text}")
            if item["url"]:
                lines.append(f"    Link: {item['url']}")
        lines.extend([
            "",
            "Note: this public feed mixes user posts and platform articles; it is a "
            "live snapshot, not a point-in-time archive. Treat short $TICKER posts as "
            "user opinion and longer articles as context.",
        ])
        return "\n".join(lines)
    if errors:
        return (f"<Futu community/feed unavailable for {ticker} "
                f"({'; '.join(errors[:3])}); this is a data gap, not silence.>")
    return (f"<No Futu community/feed posts for {ticker} within {start}..{end}; "
            "the public feed is a live snapshot, so this is not proof of silence.>")


def reddit_block(ticker: str, start: str, end: str) -> str:
    base = crypto_base(ticker) or normalize_symbol(ticker).upper()
    subreddits = subreddits_for(ticker)
    start_date, end_date = parse_date(start), parse_date(end)
    combined = "+".join(subreddits)
    # One combined feed covers every subreddit; only fall back to per-subreddit
    # requests when it returns nothing (Reddit RSS allows about one request a
    # minute per IP, so redundant calls are costly).
    combined_items = _fetch_feed(
        f"https://www.reddit.com/r/{combined}/search.rss?q={quote_plus(base)}"
        "&restrict_sr=1&sort=new&t=week&limit=100"
    )
    sources = [(None, combined_items)]
    if not combined_items:
        sources = [
            (sub, _fetch_feed(
                f"https://www.reddit.com/r/{sub}/search.rss?q={quote_plus(base)}"
                "&restrict_sr=1&sort=new&t=week&limit=25"
            ))
            for sub in subreddits
        ]

    items: dict[str, list[dict]] = {}
    seen = set()
    for default_sub, feed_items in sources:
        for item in feed_items:
            published = item.get("published")
            if published and not (start_date <= published.date() <= end_date):
                continue
            key = (item.get("title") or "").strip().lower()
            if not key or key in seen:
                continue
            seen.add(key)
            link = item.get("link") or ""
            sub = next((name for name in subreddits if f"/r/{name}/" in link),
                       default_sub or subreddits[0])
            items.setdefault(sub, []).append(item)
    if not items:
        return (f"<No Reddit posts mentioning {base.upper()} across "
                f"{', '.join('r/' + s for s in subreddits)} in {start}..{end}.>")
    lines = []
    for sub in subreddits:
        posts = items.get(sub, [])[:5]
        if not posts:
            continue
        lines.append(f"r/{sub} — {len(items[sub])} recent posts mentioning {base.upper()}:")
        for item in posts:
            published = item.get("published")
            stamp = published.strftime("%Y-%m-%d") if published else "date unknown"
            lines.append(f"  [{stamp}] {item.get('title', '')}")
            if item.get("summary"):
                lines.append(f"    body excerpt: {item['summary'][:280]}")
        lines.append("")
    return "\n".join(lines).strip()


def sentiment_bundle(ticker: str, as_of: str, limit: int = 30) -> str:
    name = company_info(ticker).get("longName")
    end_date = parse_date(as_of)
    start = (end_date - timedelta(days=7)).isoformat()
    news = format_news(
        ticker_news(ticker, name, start, as_of),
        f"<No Yahoo/Google news items for {ticker} in {start}..{as_of}.>",
    )
    subreddits = subreddits_for(ticker)
    if subreddits == DEFAULT_SUBREDDITS:
        character = ("r/wallstreetbets is often contrarian/exuberant; r/stocks more measured; "
                     "r/investing longer-term.")
    else:
        character = (f"r/{subreddits[0]} leans toward the coin's holders; r/CryptoCurrency and "
                     "r/CryptoMarkets are broader crypto communities.")
    return "\n".join([
        f"# Sentiment sources for {ticker} ({start}..{as_of})",
        "",
        "## News headlines (Yahoo Finance RSS + Google News)",
        "",
        news,
        "",
        "## StockTwits messages (public $cashtag stream)",
        "",
        stocktwits_block(ticker, start, as_of, limit),
        "",
        "## Futu community (牛牛圈)",
        "",
        futu_community_block(ticker, start, as_of, limit),
        "",
        "## Reddit posts (r/" + ", r/".join(subreddits) + ")",
        "",
        reddit_block(ticker, start, as_of),
        "",
        "## Subreddit character",
        "",
        character,
    ]).strip()


# --------------------------------------------------------------------------- #
# memory log
# --------------------------------------------------------------------------- #

MEMORY_SEPARATOR = "\n\n<!-- ENTRY_END -->\n\n"


def _lock(handle) -> None:
    if fcntl is not None:
        fcntl.flock(handle, fcntl.LOCK_EX)


def _unlock(handle) -> None:
    if fcntl is not None:
        fcntl.flock(handle, fcntl.LOCK_UN)


def memory_path() -> Path:
    path = data_home() / "memory" / "trading_memory.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    return path


def _memory_tag(date_text: str, ticker: str, rating: str, *rest: str) -> str:
    return f"[{' | '.join([date_text, ticker, rating, *rest])}]"


def _parse_entry(block: str) -> dict | None:
    lines = block.strip().splitlines()
    if not lines:
        return None
    tag_line = lines[0].strip()
    if not (tag_line.startswith("[") and tag_line.endswith("]")):
        return None
    fields = [field.strip() for field in tag_line[1:-1].split("|")]
    if len(fields) < 4:
        return None
    body = "\n".join(lines[1:]).strip()
    decision_match = re.search(r"DECISION:\n(.*?)(?=\nREFLECTION:|\Z)", body, re.DOTALL)
    reflection_match = re.search(r"REFLECTION:\n(.*)$", body, re.DOTALL)
    resolved = next((f[9:].strip() for f in fields[6:] if f.startswith("resolved:")), None)
    return {
        "date": fields[0],
        "ticker": fields[1],
        "rating": fields[2],
        "pending": fields[3] == "pending",
        "raw": None if fields[3] == "pending" else fields[3],
        "alpha": fields[4] if len(fields) > 4 else None,
        "holding": fields[5] if len(fields) > 5 else None,
        "resolved": resolved,
        "decision": (decision_match.group(1) if decision_match else body).strip(),
        "reflection": (reflection_match.group(1) if reflection_match else "").strip(),
    }


def load_entries() -> list[dict]:
    path = memory_path()
    if not path.exists():
        return []
    blocks = path.read_text(encoding="utf-8").split(MEMORY_SEPARATOR)
    return [entry for block in blocks if (entry := _parse_entry(block))]


def replace_decision(ticker: str, trade_date: str, decision: str, rating: str) -> bool:
    """Replace an existing pending decision for ticker+date.

    Used when a run is refreshed the same day and the new decision supersedes
    the earlier one. Resolved entries are never replaced.
    """
    ticker = normalize_symbol(ticker)
    path = memory_path()
    if not path.exists():
        return False
    with open(path, "r+", encoding="utf-8") as handle:
        _lock(handle)
        try:
            blocks = handle.read().split(MEMORY_SEPARATOR)
            prefix = f"[{trade_date} | {ticker} |"
            updated = False
            new_blocks = []
            for block in blocks:
                stripped = block.strip()
                if not stripped:
                    new_blocks.append(block)
                    continue
                tag = stripped.splitlines()[0].strip()
                if (not updated and tag.startswith(prefix)
                        and tag.endswith("| pending]")):
                    new_blocks.append(
                        f"{_memory_tag(trade_date, ticker, rating, 'pending')}\n\n"
                        f"DECISION:\n{decision.strip()}"
                    )
                    updated = True
                else:
                    new_blocks.append(block)
            if not updated:
                return False
            tmp = path.with_suffix(".tmp")
            tmp.write_text(MEMORY_SEPARATOR.join(new_blocks), encoding="utf-8")
            os.replace(tmp, path)
            return True
        finally:
            _unlock(handle)


def store_decision(ticker: str, trade_date: str, decision: str, rating: str,
                   replace: bool = False) -> bool:
    """Append a pending entry; returns False when one already exists for ticker+date.

    With ``replace=True`` an existing pending entry for the same ticker+date is
    rewritten with the new rating and decision instead.
    """
    if replace:
        return replace_decision(ticker, trade_date, decision, rating)
    ticker = normalize_symbol(ticker)
    path = memory_path()
    with open(path, "a+", encoding="utf-8") as handle:
        _lock(handle)
        try:
            handle.seek(0)
            prefix = f"[{trade_date} | {ticker} |"
            for line in handle.read().splitlines():
                if line.startswith(prefix) and line.endswith("]"):
                    return False
            handle.seek(0, os.SEEK_END)
            handle.write(
                f"{_memory_tag(trade_date, ticker, rating, 'pending')}\n\n"
                f"DECISION:\n{decision.strip()}{MEMORY_SEPARATOR}"
            )
            return True
        finally:
            _unlock(handle)


def _format_full(entry: dict) -> str:
    tag = (f"[{entry['date']} | {entry['ticker']} | {entry['rating']} | "
           f"{entry['raw'] or 'n/a'} | {entry['alpha'] or 'n/a'} | {entry['holding'] or 'n/a'}]")
    parts = [tag, f"DECISION:\n{entry['decision']}"]
    if entry["reflection"]:
        parts.append(f"REFLECTION:\n{entry['reflection']}")
    return "\n\n".join(parts)


def _format_reflection_only(entry: dict) -> str:
    tag = f"[{entry['date']} | {entry['ticker']} | {entry['rating']} | {entry['raw'] or 'n/a'}]"
    if entry["reflection"]:
        return f"{tag}\n{entry['reflection']}"
    text = entry["decision"][:300]
    return f"{tag}\n{text}{'...' if len(entry['decision']) > 300 else ''}"


def past_context(ticker: str, as_of: str | None = None, n_same: int = 5, n_cross: int = 3) -> str:
    ticker = normalize_symbol(ticker)
    entries = [entry for entry in load_entries() if not entry["pending"]]
    if as_of:
        entries = [entry for entry in entries if entry["resolved"] and entry["resolved"] <= as_of]
    same, cross = [], []
    for entry in reversed(entries):
        if len(same) >= n_same and len(cross) >= n_cross:
            break
        if entry["ticker"] == ticker and len(same) < n_same:
            same.append(entry)
        elif entry["ticker"] != ticker and len(cross) < n_cross:
            cross.append(entry)
    parts = []
    if same:
        parts.append(f"Past analyses of {ticker} (most recent first):")
        parts.extend(_format_full(entry) for entry in same)
    if cross:
        parts.append("Recent cross-ticker lessons:")
        parts.extend(_format_reflection_only(entry) for entry in cross)
    return "\n\n".join(parts)


def resolve_benchmark(ticker: str) -> str:
    explicit = os.environ.get("TRADING_AGENTS_BENCHMARK")
    if explicit:
        return explicit
    upper = ticker.upper()
    for suffix, benchmark in BENCHMARK_MAP.items():
        if suffix and upper.endswith(suffix.upper()):
            return benchmark
    return BENCHMARK_MAP[""]


def _closes(ticker: str, start: str, end: str) -> pd.Series:
    frame = fetch_range(ticker, start, end) if start <= end else pd.DataFrame()
    if frame.empty:
        return pd.Series(dtype=float)
    series = frame["Close"].astype(float)
    return series[series > 0]


def fetch_returns(ticker: str, trade_date: str, holding_days: int = 5,
                  benchmark: str | None = None) -> dict:
    """Score a decision: entry at the first close after its date, exit N sessions later."""
    benchmark = benchmark or resolve_benchmark(ticker)
    start = parse_date(trade_date)
    end = start + timedelta(days=round((holding_days + 1) * 7 / 5) + 7)
    stock = _closes(ticker, trade_date, end.isoformat())
    stock = stock[[d.date() > start for d in stock.index]]
    bench_start = (start - timedelta(days=7)).isoformat()
    bench = _closes(benchmark, bench_start, end.isoformat())
    if len(stock) <= holding_days:
        return {"status": "waiting", "benchmark": benchmark,
                "reason": "holding window has not fully traded"}
    if bench.empty or bench.index[0].date() > stock.index[0].date() \
            or bench.index[-1].date() < stock.index[holding_days].date():
        return {"status": "waiting", "benchmark": benchmark,
                "reason": "benchmark has not traded through the exit"}
    entry_price, exit_price = float(stock.iloc[0]), float(stock.iloc[holding_days])
    raw = (exit_price - entry_price) / entry_price
    bench_entry = float(bench.asof(stock.index[0]))
    bench_exit = float(bench.asof(stock.index[holding_days]))
    alpha = raw - (bench_exit - bench_entry) / bench_entry
    return {
        "status": "ready",
        "benchmark": benchmark,
        "raw_return": raw,
        "alpha_return": alpha,
        "holding_days": holding_days,
        "resolution_date": stock.index[holding_days].date().isoformat(),
    }


def update_outcome(ticker: str, trade_date: str, raw_return: float, alpha_return: float,
                   holding_days: int, reflection: str, resolution_date: str | None = None) -> bool:
    ticker = normalize_symbol(ticker)
    path = memory_path()
    if not path.exists():
        return False
    with open(path, "r+", encoding="utf-8") as handle:
        _lock(handle)
        try:
            text = handle.read()
            blocks = text.split(MEMORY_SEPARATOR)
            prefix = f"[{trade_date} | {ticker} |"
            updated = False
            new_blocks = []
            for block in blocks:
                stripped = block.strip()
                if not stripped:
                    new_blocks.append(block)
                    continue
                lines = stripped.splitlines()
                tag_line = lines[0].strip()
                if (not updated and tag_line.startswith(prefix)
                        and tag_line.endswith("| pending]")):
                    fields = [field.strip() for field in tag_line[1:-1].split("|")]
                    rating = fields[2]
                    tag = (f"[{trade_date} | {ticker} | {rating} | {raw_return:+.1%} | "
                           f"{alpha_return:+.1%} | {holding_days}d")
                    if resolution_date:
                        tag += f" | resolved:{resolution_date}"
                    tag += "]"
                    rest = "\n".join(lines[1:]).strip()
                    new_blocks.append(f"{tag}\n\n{rest}\n\nREFLECTION:\n{reflection.strip()}")
                    updated = True
                else:
                    new_blocks.append(block)
            if not updated:
                return False
            tmp = path.with_suffix(".tmp")
            tmp.write_text(MEMORY_SEPARATOR.join(new_blocks), encoding="utf-8")
            os.replace(tmp, path)
            return True
        finally:
            _unlock(handle)

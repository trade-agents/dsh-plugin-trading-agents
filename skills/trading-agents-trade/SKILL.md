---
name: trading-agents-trade
description: Entry point for a TradingAgents research run — parse the ticker, optional date, and options, then load and follow the trading-agents-pipeline skill.
whenToUse: Use when the user invokes the trade entry point or asks to run the TradingAgents pipeline on a named ticker.
user-invocable: true
---

# TradingAgents trade entry point

This is a thin entry point. It parses the user's arguments and then hands control to the
`trading-agents-pipeline` skill; it never runs any pipeline step itself.

Arguments are the text after the skill token in the user's message.

## Parse

Shape: `TICKER [YYYY-MM-DD] [analysts=market,social,news,fundamentals] [debate=N] [risk=N] [language=...]`

- `TICKER` — required; the first bare argument. Preserve exchange suffixes such as
  `700.HK`, `7203.T`, `BTC-USD`.
- `YYYY-MM-DD` — optional; a bare date argument. Reject a future date.
- `analysts=...` — comma-separated subset of `market`, `social`, `news`, `fundamentals`
  (default all four; `social` means sentiment).
- `debate=N` — bull+bear turns per debate round (default `1`).
- `risk=N` — aggressive+conservative+neutral turns per risk round (default `1`).
- `language=...` — report prose language. Defaults to the plugin's `outputLanguage`
  config (injected as `$DSH_TRADING_AGENTS_OUTPUT_LANGUAGE`); pass it to override for one
  run.
- Anything else in the user's message — holdings, cash, constraints — is the `PORTFOLIO`
  text.

If no `TICKER` can be found, ask for one and stop. Do not ask about the optional
arguments; the pipeline has defaults for every one of them.

## Run

1. Call the `skill` tool with name `trading-agents-pipeline`.
2. Follow that skill exactly, starting from its step 0, using the values parsed above:
   ticker, date, analysts, debate rounds, risk rounds, language, and portfolio text.
   Read its `references/steps.md` before step 0, as that skill instructs.

Do not duplicate or shortcut the pipeline steps here. The pipeline skill owns the full
procedure, the subagent contract, the absence markers, the rating validation, and the
final-answer contract.

## Runtime notes

- Every bash block starts by defining the wrapper paths, because shell state does not
  persist between calls:
  `DATA="${DSH_TRADING_AGENTS_HOME:-${TRADING_AGENTS_HOME:-${DSH_HOME:-$HOME/.dsh}/trading-agents}}"; TA="$DATA/bin/ta"; TA_ASSEMBLE="$DATA/bin/ta-assemble"`,
  then uses `"$TA"` and `"$TA_ASSEMBLE"`.
- Results dir default: `${TRADING_AGENTS_RESULTS_DIR:-$PWD/.trading-agents/runs}`.
- The DSH equivalent of the SessionStart bootstrap is the plugin's activation-time warm-up.
  A first `ta` call may still spend about a minute installing the venv; if it fails, run
  `"$TA" doctor` and report the error; never fall back to another Python.

---
name: trading-agents-pipeline
description: Run the full keyless multi-agent equity research pipeline for one ticker — analysts, bull versus bear debate, trader, risk debate, portfolio decision — then assemble reports and record one memory entry.
whenToUse: Use for a complete multi-agent research run on a ticker, directly or via the trading-agents-trade entry skill.
user-invocable: true
---

# TradingAgents pipeline

Replicate the TradingAgents role graph with DSH subagents. The main session is the **orchestrator**: it spawns role subagents, passes *file paths* (never report bodies), and writes a report tree; each role writes its own section file, so long text never round-trips through this context.

The bundled `ta` CLI is keyless: prices, indicators, fundamentals, news, macro, prediction-market odds, and social sentiment from public endpoints; it never imports the TradingAgents Python project.

**Detailed bash recipes and prompt field lists for every step are in `references/steps.md` in this skill's base directory; read it before step 0.**

## Runtime facts

- Every bash block first defines the wrapper paths (shell state does not persist): `DATA="${DSH_TRADING_AGENTS_HOME:-${TRADING_AGENTS_HOME:-${DSH_HOME:-$HOME/.dsh}/trading-agents}}"; TA="$DATA/bin/ta"; TA_ASSEMBLE="$DATA/bin/ta-assemble"`, then uses `"$TA"` and `"$TA_ASSEMBLE"`.
- Results dir default `${TRADING_AGENTS_RESULTS_DIR:-$PWD/.trading-agents/runs}`; home default `${TRADING_AGENTS_HOME:-${DSH_HOME:-$HOME/.dsh}/trading-agents}`.
- The DSH equivalent of the SessionStart bootstrap is the plugin's activation-time warm-up; a first `ta` call may still spend about a minute installing the venv. If it fails, run `"$TA" doctor` and report the error; never fall back to another Python.

## Inputs

Arguments are the text after the skill token in the user's message. Parse them plus the user's message:

| Input | Default | Notes |
|---|---|---|
| `TICKER` | required | Preserve suffixes (`700.HK`, `BTC-USD`). |
| `DATE` | today (`date +%F`) | `YYYY-MM-DD`; reject future dates. |
| `ANALYSTS` | `market,social,news,fundamentals` | `social` = sentiment. |
| `DEBATE_ROUNDS` | `1` | Bull+bear turns per round. |
| `RISK_ROUNDS` | `1` | Aggressive+conservative+neutral turns per round. |
| `LANGUAGE` | `$TRADING_AGENTS_OUTPUT_LANGUAGE` or English | Report prose language. |
| `PORTFOLIO` | not provided | Free text: holdings, cash, constraints. |

If `TICKER` is missing, ask and stop; everything else has a default — do not ask. Accept `key=value` (`analysts=market,news debate=2 risk=2 language=Chinese`) or bare positional arguments after the ticker (`NVDA 2026-10-20`).

## Roles

13 model-only DSH skills via `subagent`: `trading-agents-market-analyst`, `trading-agents-sentiment-analyst`, `trading-agents-news-analyst`, `trading-agents-fundamentals-analyst`; `trading-agents-bull-researcher`, `trading-agents-bear-researcher`, `trading-agents-research-manager`; `trading-agents-trader`; `trading-agents-aggressive-risk-analyst`, `trading-agents-conservative-risk-analyst`, `trading-agents-neutral-risk-analyst`; `trading-agents-portfolio-manager`; `trading-agents-memory-reflector`.

## Subagent contract

Spawn every role with the `subagent` tool, beginning every child prompt with this literal first line (substitute the role name):

```
First call the `skill` tool with name `trading-agents-<role>` to load your role instructions, then follow them exactly.
```

Then append the role's field block from `references/steps.md` (`TICKER`, `ANALYSIS_DATE`, input/output paths, `OUTPUT_LANGUAGE`).

The `subagent` tool returns immediately with a child id; the parent gets a completion notice when the child settles. Do not read a role's output before that notice — the file may be stale or absent. Spawn selected analysts (plus the memory reflector when due) as parallel calls in one message; run debate turns sequentially.

## Steps

0. **Setup.** One bash call creates `RUN_DIR` (`0_context`…`6_memory`), `run.env`, the instrument context, `pending.json`, and `portfolio.md`, then counts ready items. Every later bash call starts with the literal `RUN_DIR` and sources `run.env`.
1. **Analysts — parallel.** One `subagent` per selected analyst in one message, plus the memory reflector when ready items exist; then refresh `0_context/past_context.md`.
2. **Research debate — sequential.** Per round, bull then bear; `OPPONENT_ARGUMENT` is the latest opposing turn (`none` in round 1) and `DEBATE_HISTORY` the running history (`none` in round 1). Append every turn to the history file.
3. **Research Manager.** Writes `2_research/manager.md` from the debate history and analyst reports; then merge the per-round turns into `2_research/bull.md` and `2_research/bear.md`.
4. **Trader.** Writes `3_trading/trader.md` from the manager plan, market report, and portfolio context.
5. **Risk debate — sequential.** Per round, aggressive → conservative → neutral, with the trader proposal, analyst reports, portfolio context, risk history, and latest opponent turns; append every turn to the risk history.
6. **Portfolio Manager.** Writes `5_portfolio/decision.md` from the manager plan, trader proposal, risk history, past context, and portfolio context; read the rating deterministically (first `**Rating**:` line); then merge the risk turns into `4_risk/{aggressive,conservative,neutral}.md`.
7. **Assemble and record.** Run the assemble wrapper (run dir, ticker, date, rating, analysts, rounds, language), then record the decision with the `ta_memory` tool (`action: store`).
8. **Final answer.** Follow the contract below.

## Failure and absence markers

- Retry a failed or empty role once with the same prompt.
- If it still fails, write the explicit marker — never a missing path, never treating absence as an empty finding. Analysts get `(No <key> report in this run: it is not available, not an empty finding.)`; research turns get `<Bull|Bear> Analyst: (argument unavailable this turn.)`; risk turns get `<Aggressive|Conservative|Neutral> Analyst: (argument unavailable this turn.)`. Append the marker to the history and continue.
- Unselected analysts also get the marker, so downstream roles always read a file.
- Never substitute your own analysis or invented data for a failed role; mark the gap.

## Rating validation

The rating read from `5_portfolio/decision.md` must be exactly one of `Buy`, `Overweight`, `Hold`, `Underweight`, `Sell`. If not, re-run the PM once with an explicit correction; if still invalid, use `REVIEW` and say so in the final answer.

## Final answer

Report in the user's language: **Rating** and the one-sentence summary; **key evidence** per side in a compact table plus the risk debate's bottom line; **actionable levels** (entry, stop, sizing, or "not provided"); **data gaps** and failed sections; **paths** to `complete_report.html` (open this), `complete_report.md`, the decision file, and the run directory; and if the memory reflector ran, its settled/waiting/failed counts. Do not paste full reports into the answer.

## Rules for the orchestrator

- Pass **paths**, not report text; never `cat` a full report into a subagent prompt.
- Run analysts in parallel; run every debate turn sequentially (each needs the previous turn).
- Do not touch the user's project files, git state, or unrelated files.
- One run = one memory entry; re-running a ticker and date does not duplicate it (idempotency guard).

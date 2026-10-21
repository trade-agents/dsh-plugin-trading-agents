# TradingAgents pipeline — step-by-step reference

This file holds the exact bash recipes and prompt field lists for
`skills/trading-agents-pipeline/SKILL.md`. Read it before step 0. Nothing here is optional;
the SKILL.md carries the rules, this file carries the wiring.

## Conventions used below

- Bash state does **not** persist between calls. Every block re-derives the wrapper paths
  and, from step 0 on, starts from the literal run directory and sources `run.env`.
- The DSH equivalent of the Claude Code SessionStart bootstrap is the plugin's
  activation-time warm-up. A first `ta` call may still spend about a minute installing
  the venv. If it fails, run `"$TA" doctor` and report the error; never fall back to
  another Python.
- Delegate roles with the `subagent` tool. The tool returns immediately with a child id;
  the parent receives a completion notice when the child settles. Never read a child's
  output file before that notice — it may be stale or absent. A role is loaded by the
  child through its own skill, so every child prompt begins with the literal line below
  (substitute the real role name, e.g. `trading-agents-market-analyst`):

  ```
  First call the `skill` tool with name `trading-agents-<role>` to load your role instructions, then follow them exactly.
  ```

- Pass **paths**, never report bodies. Do not `cat` a report into a prompt.
- Retry a failed or empty role **once** with the same prompt, then write its explicit
  absence marker (see the per-step sections and the SKILL.md rules).

## 0. Setup (one bash call)

Fill the first six assignments from the user's parsed arguments. `ASSET_TYPE` only
distinguishes crypto from stock. Keep exchange suffixes on the ticker.

```bash
DATA="${DSH_TRADING_AGENTS_HOME:-${TRADING_AGENTS_HOME:-${DSH_HOME:-$HOME/.dsh}/trading-agents}}"
TA="$DATA/bin/ta"; TA_ASSEMBLE="$DATA/bin/ta-assemble"
TICKER=NVDA; DATE=2026-10-20; ANALYSTS=market,social,news,fundamentals
DEBATE_ROUNDS=1; RISK_ROUNDS=1; LANGUAGE=English
ASSET_TYPE=stock
case "$TICKER" in *-USD) ASSET_TYPE=crypto;; esac
SAFE=$(printf '%s' "$TICKER" | tr '/ ' '__')
RUN_DIR="${TRADING_AGENTS_RESULTS_DIR:-$PWD/.trading-agents/runs}/${SAFE}_$(date +%Y%m%d_%H%M%S)"
mkdir -p "$RUN_DIR"/{0_context,1_analysts,2_research/debate,3_trading,4_risk/debate,5_portfolio,6_memory}
cat > "$RUN_DIR/run.env" <<EOF
TICKER=$TICKER
DATE=$DATE
ANALYSTS=$ANALYSTS
DEBATE_ROUNDS=$DEBATE_ROUNDS
RISK_ROUNDS=$RISK_ROUNDS
LANGUAGE=$LANGUAGE
RUN_DIR=$RUN_DIR
EOF
"$TA" identity "$TICKER" --date "$DATE" --asset-type "$ASSET_TYPE" \
  > "$RUN_DIR/0_context/instrument_context.md"
"$TA" memory settle --ticker "$TICKER" \
  > "$RUN_DIR/6_memory/pending.json"
: > "$RUN_DIR/2_research/debate/history.md"
: > "$RUN_DIR/4_risk/debate/history.md"
pwd; echo "$RUN_DIR"
```

If `"$TA" identity` fails on the first call because the venv is still bootstrapping, run
`"$TA" doctor`, report the error, and retry once — do not substitute another Python.

### Every later bash call starts like this

Copy the **literal absolute** run directory printed by setup. Shell state does not persist.

```bash
DATA="${DSH_TRADING_AGENTS_HOME:-${TRADING_AGENTS_HOME:-${DSH_HOME:-$HOME/.dsh}/trading-agents}}"
TA="$DATA/bin/ta"; TA_ASSEMBLE="$DATA/bin/ta-assemble"
RUN_DIR=/absolute/path/printed/above; . "$RUN_DIR/run.env"
```

### Portfolio context

Write `$RUN_DIR/0_context/portfolio.md` with the user's `PORTFOLIO` text. When the user
provided none, write exactly this line:

```bash
DATA="${DSH_TRADING_AGENTS_HOME:-${TRADING_AGENTS_HOME:-${DSH_HOME:-$HOME/.dsh}/trading-agents}}"
TA="$DATA/bin/ta"; TA_ASSEMBLE="$DATA/bin/ta-assemble"
RUN_DIR=/absolute/path/printed/above; . "$RUN_DIR/run.env"
cat > "$RUN_DIR/0_context/portfolio.md" <<'EOF'
Portfolio context: not provided. You do not know the caller's current holdings or cash, so do not assume a flat book; give direction and sizing guidance in terms the caller can apply to their own position.
EOF
```

### Is settlement due?

```bash
DATA="${DSH_TRADING_AGENTS_HOME:-${TRADING_AGENTS_HOME:-${DSH_HOME:-$HOME/.dsh}/trading-agents}}"
TA="$DATA/bin/ta"; TA_ASSEMBLE="$DATA/bin/ta-assemble"
RUN_DIR=/absolute/path/printed/above; . "$RUN_DIR/run.env"
grep -c '"status": "ready"' "$RUN_DIR/6_memory/pending.json" || true
```

A non-zero count means the memory reflector joins the analyst batch in step 1; otherwise
skip it. Do not read `past_context.md` yet — it is refreshed after settlement in step 1.

### Run environment for every role

Roles receive `TICKER`, `ANALYSIS_DATE`, `CONTEXT_PATH`, their input report paths, their
own output path (`REPORT_PATH`, `ARGUMENT_PATH`, `PLAN_PATH`, `PROPOSAL_PATH`, or
`DECISION_PATH`), and `OUTPUT_LANGUAGE`. `OUTPUT_LANGUAGE` is a full instruction such as
`Chinese` or `English`; the role writes its prose in it and keeps labelled rating/trade
lines in English.

## 1. Analysts — parallel

Launch **one `subagent` call per selected analyst in a single message**. Use a
`description` of the form `Market analyst: NVDA 2026-10-20`. Every prompt starts with the
role-load line.

| Analyst | Role skill | Report file |
|---|---|---|
| Market | `trading-agents-market-analyst` | `1_analysts/market.md` |
| Sentiment | `trading-agents-sentiment-analyst` | `1_analysts/sentiment.md` |
| News | `trading-agents-news-analyst` | `1_analysts/news.md` |
| Fundamentals | `trading-agents-fundamentals-analyst` | `1_analysts/fundamentals.md` |

Prompt template — fill every field (`<file>` is the report file from the table):

```
First call the `skill` tool with name `trading-agents-<role>` to load your role instructions, then follow them exactly.
TICKER=<TICKER>
ANALYSIS_DATE=<DATE>
CONTEXT_PATH=<RUN_DIR>/0_context/instrument_context.md
REPORT_PATH=<RUN_DIR>/1_analysts/<file>
OUTPUT_LANGUAGE=<LANGUAGE>
Write the report in <LANGUAGE>; keep labelled rating/trade lines in English.
```

### Memory reflector (same message, only when ready items exist)

Role skill `trading-agents-memory-reflector`:

```
First call the `skill` tool with name `trading-agents-memory-reflector` to load your role instructions, then follow them exactly.
WORK_DIR=<RUN_DIR>/6_memory
TICKER=<TICKER>
Pending results are in <RUN_DIR>/6_memory/pending.json. Run `memory settle --ticker <TICKER>` yourself for fresh figures, and record only entries whose status is ready.
```

### Failure handling and absence normalization

Wait for all completion notices. If an analyst errored or returned without its file, retry
once with the same prompt. Then normalize every slot — unselected, failed, and empty
analysts all get the explicit absence marker, so downstream roles never read a missing
path or mistake absence for an empty finding:

```bash
DATA="${DSH_TRADING_AGENTS_HOME:-${TRADING_AGENTS_HOME:-${DSH_HOME:-$HOME/.dsh}/trading-agents}}"
TA="$DATA/bin/ta"; TA_ASSEMBLE="$DATA/bin/ta-assemble"
RUN_DIR=/absolute/path/printed/above; . "$RUN_DIR/run.env"
for pair in market:market sentiment:sentiment news:news fundamentals:fundamentals; do
  key=${pair%%:*}; file=${pair##*:}
  if [ ! -s "$RUN_DIR/1_analysts/$file.md" ]; then
    printf '(No %s report in this run: it is not available, not an empty finding.)\n' "$key" \
      > "$RUN_DIR/1_analysts/$file.md"
  fi
done
```

Verify with `ls -l "$RUN_DIR/1_analysts"`; do not `cat` the reports.

### Refresh lessons

Settlement may have just added lessons; refresh the past-context file:

```bash
DATA="${DSH_TRADING_AGENTS_HOME:-${TRADING_AGENTS_HOME:-${DSH_HOME:-$HOME/.dsh}/trading-agents}}"
TA="$DATA/bin/ta"; TA_ASSEMBLE="$DATA/bin/ta-assemble"
RUN_DIR=/absolute/path/printed/above; . "$RUN_DIR/run.env"
if [ "$DATE" = "$(date +%F)" ]; then
  "$TA" memory context "$TICKER" > "$RUN_DIR/0_context/past_context.md"
else
  "$TA" memory context "$TICKER" --as-of "$DATE" > "$RUN_DIR/0_context/past_context.md"
fi
```

## 2. Research debate — sequential

Maintain a running history file. For each round `r` from 1 to `DEBATE_ROUNDS`:

1. **Bull** (`trading-agents-bull-researcher`) — `OPPONENT_ARGUMENT` is the latest bear
   file, or `none` in round 1. `DEBATE_HISTORY` is the history file, or `none` in round 1.
2. **Bear** (`trading-agents-bear-researcher`) — `OPPONENT_ARGUMENT` is the bull file just
   written.

Run them strictly one after the other: each turn needs the previous one.

Prompt fields for both roles:

```
First call the `skill` tool with name `trading-agents-<role>` to load your role instructions, then follow them exactly.
TICKER=<TICKER>
ANALYSIS_DATE=<DATE>
CONTEXT_PATH=<RUN_DIR>/0_context/instrument_context.md
MARKET_REPORT=<RUN_DIR>/1_analysts/market.md
SENTIMENT_REPORT=<RUN_DIR>/1_analysts/sentiment.md
NEWS_REPORT=<RUN_DIR>/1_analysts/news.md
FUNDAMENTALS_REPORT=<RUN_DIR>/1_analysts/fundamentals.md
DEBATE_HISTORY=<RUN_DIR>/2_research/debate/history.md or none
OPPONENT_ARGUMENT=<path to the latest opposing turn, or none>
ARGUMENT_PATH=<RUN_DIR>/2_research/debate/{bull|bear}_r<r>.md
OUTPUT_LANGUAGE=<LANGUAGE>
```

After each turn, append it to the running history (chronological, no token cost). Pass the
history path rather than its contents:

```bash
DATA="${DSH_TRADING_AGENTS_HOME:-${TRADING_AGENTS_HOME:-${DSH_HOME:-$HOME/.dsh}/trading-agents}}"
TA="$DATA/bin/ta"; TA_ASSEMBLE="$DATA/bin/ta-assemble"
RUN_DIR=/absolute/path/printed/above; . "$RUN_DIR/run.env"
cat "$RUN_DIR/2_research/debate/bull_r<r>.md" >> "$RUN_DIR/2_research/debate/history.md"
```

Same pattern for the bear turn file. On a failed or empty turn, retry once; if it still
fails, write `<Bull|Bear> Analyst: (argument unavailable this turn.)` to the turn file,
append it, and continue.

## 3. Research Manager

Role skill `trading-agents-research-manager`.

```
First call the `skill` tool with name `trading-agents-research-manager` to load your role instructions, then follow them exactly.
TICKER=<TICKER>
ANALYSIS_DATE=<DATE>
CONTEXT_PATH=<RUN_DIR>/0_context/instrument_context.md
DEBATE_HISTORY=<RUN_DIR>/2_research/debate/history.md
MARKET_REPORT=<RUN_DIR>/1_analysts/market.md
SENTIMENT_REPORT=<RUN_DIR>/1_analysts/sentiment.md
NEWS_REPORT=<RUN_DIR>/1_analysts/news.md
FUNDAMENTALS_REPORT=<RUN_DIR>/1_analysts/fundamentals.md
PLAN_PATH=<RUN_DIR>/2_research/manager.md
OUTPUT_LANGUAGE=<LANGUAGE>
```

Then materialize the debate files the report tree expects (append order is round order):

```bash
DATA="${DSH_TRADING_AGENTS_HOME:-${TRADING_AGENTS_HOME:-${DSH_HOME:-$HOME/.dsh}/trading-agents}}"
TA="$DATA/bin/ta"; TA_ASSEMBLE="$DATA/bin/ta-assemble"
RUN_DIR=/absolute/path/printed/above; . "$RUN_DIR/run.env"
: > "$RUN_DIR/2_research/bull.md"; : > "$RUN_DIR/2_research/bear.md"
for f in "$RUN_DIR"/2_research/debate/bull_r*.md; do cat "$f" >> "$RUN_DIR/2_research/bull.md"; done
for f in "$RUN_DIR"/2_research/debate/bear_r*.md; do cat "$f" >> "$RUN_DIR/2_research/bear.md"; done
```

## 4. Trader

Role skill `trading-agents-trader`.

```
First call the `skill` tool with name `trading-agents-trader` to load your role instructions, then follow them exactly.
TICKER=<TICKER>
ANALYSIS_DATE=<DATE>
CONTEXT_PATH=<RUN_DIR>/0_context/instrument_context.md
INVESTMENT_PLAN=<RUN_DIR>/2_research/manager.md
MARKET_REPORT=<RUN_DIR>/1_analysts/market.md
PORTFOLIO_CONTEXT=<RUN_DIR>/0_context/portfolio.md
PROPOSAL_PATH=<RUN_DIR>/3_trading/trader.md
OUTPUT_LANGUAGE=<LANGUAGE>
```

## 5. Risk debate — sequential

For each round `r` from 1 to `RISK_ROUNDS`, run in this fixed order:
**aggressive → conservative → neutral**.

| Turn | Role skill | File |
|---|---|---|
| Aggressive | `trading-agents-aggressive-risk-analyst` | `4_risk/debate/aggressive_r<r>.md` |
| Conservative | `trading-agents-conservative-risk-analyst` | `4_risk/debate/conservative_r<r>.md` |
| Neutral | `trading-agents-neutral-risk-analyst` | `4_risk/debate/neutral_r<r>.md` |

Prompt fields (all three):

```
First call the `skill` tool with name `trading-agents-<role>` to load your role instructions, then follow them exactly.
TICKER=<TICKER>
ANALYSIS_DATE=<DATE>
CONTEXT_PATH=<RUN_DIR>/0_context/instrument_context.md
TRADER_PROPOSAL=<RUN_DIR>/3_trading/trader.md
MARKET_REPORT=<RUN_DIR>/1_analysts/market.md
SENTIMENT_REPORT=<RUN_DIR>/1_analysts/sentiment.md
NEWS_REPORT=<RUN_DIR>/1_analysts/news.md
FUNDAMENTALS_REPORT=<RUN_DIR>/1_analysts/fundamentals.md
PORTFOLIO_CONTEXT=<RUN_DIR>/0_context/portfolio.md
RISK_HISTORY=<RUN_DIR>/4_risk/debate/history.md or none in round 1
AGGRESSIVE_ARGUMENT=<latest aggressive path or none>
CONSERVATIVE_ARGUMENT=<latest conservative path or none>
NEUTRAL_ARGUMENT=<latest neutral path or none>
ARGUMENT_PATH=<RUN_DIR>/4_risk/debate/<file>
OUTPUT_LANGUAGE=<LANGUAGE>
```

After each turn, append it chronologically to the risk history:

```bash
DATA="${DSH_TRADING_AGENTS_HOME:-${TRADING_AGENTS_HOME:-${DSH_HOME:-$HOME/.dsh}/trading-agents}}"
TA="$DATA/bin/ta"; TA_ASSEMBLE="$DATA/bin/ta-assemble"
RUN_DIR=/absolute/path/printed/above; . "$RUN_DIR/run.env"
cat "$RUN_DIR/4_risk/debate/<aggressive|conservative|neutral>_r<r>.md" >> "$RUN_DIR/4_risk/debate/history.md"
```

Same retry/placeholder rule as the research debate:
`<Aggressive|Conservative|Neutral> Analyst: (argument unavailable this turn.)`.

## 6. Portfolio Manager

Role skill `trading-agents-portfolio-manager`.

```
First call the `skill` tool with name `trading-agents-portfolio-manager` to load your role instructions, then follow them exactly.
TICKER=<TICKER>
ANALYSIS_DATE=<DATE>
CONTEXT_PATH=<RUN_DIR>/0_context/instrument_context.md
INVESTMENT_PLAN=<RUN_DIR>/2_research/manager.md
TRADER_PROPOSAL=<RUN_DIR>/3_trading/trader.md
RISK_HISTORY=<RUN_DIR>/4_risk/debate/history.md
PAST_CONTEXT=<RUN_DIR>/0_context/past_context.md
PORTFOLIO_CONTEXT=<RUN_DIR>/0_context/portfolio.md
DECISION_PATH=<RUN_DIR>/5_portfolio/decision.md
OUTPUT_LANGUAGE=<LANGUAGE>
```

Read the rating deterministically — never infer it from prose:

```bash
DATA="${DSH_TRADING_AGENTS_HOME:-${TRADING_AGENTS_HOME:-${DSH_HOME:-$HOME/.dsh}/trading-agents}}"
TA="$DATA/bin/ta"; TA_ASSEMBLE="$DATA/bin/ta-assemble"
RUN_DIR=/absolute/path/printed/above; . "$RUN_DIR/run.env"
grep -m1 -E '^\*\*Rating\*\*:' "$RUN_DIR/5_portfolio/decision.md" \
  | sed -E 's/.*\*\*Rating\*\*:[[:space:]]*//; s/[^A-Za-z].*//'
```

The result must be one of `Buy`, `Overweight`, `Hold`, `Underweight`, `Sell`. If it is not,
re-run the portfolio manager once with an explicit correction prompt (same fields, plus
"Your previous decision did not contain a valid `**Rating**:` line; rewrite it with exactly
one of Buy, Overweight, Hold, Underweight, Sell"). If it is still invalid, use `REVIEW` as
the rating and say so in the final answer.

Build the risk section files (append order is round order):

```bash
DATA="${DSH_TRADING_AGENTS_HOME:-${TRADING_AGENTS_HOME:-${DSH_HOME:-$HOME/.dsh}/trading-agents}}"
TA="$DATA/bin/ta"; TA_ASSEMBLE="$DATA/bin/ta-assemble"
RUN_DIR=/absolute/path/printed/above; . "$RUN_DIR/run.env"
for name in aggressive conservative neutral; do
  : > "$RUN_DIR/4_risk/$name.md"
  for f in "$RUN_DIR"/4_risk/debate/${name}_r*.md; do cat "$f" >> "$RUN_DIR/4_risk/$name.md"; done
done
```

## 7. Assemble and record

Set `RATING` to the validated rating from step 6.

```bash
DATA="${DSH_TRADING_AGENTS_HOME:-${TRADING_AGENTS_HOME:-${DSH_HOME:-$HOME/.dsh}/trading-agents}}"
TA="$DATA/bin/ta"; TA_ASSEMBLE="$DATA/bin/ta-assemble"
RUN_DIR=/absolute/path/printed/above; . "$RUN_DIR/run.env"
RATING=<the rating read in step 6>
"$TA_ASSEMBLE" \
  --run-dir "$RUN_DIR" --ticker "$TICKER" --date "$DATE" --rating "$RATING" \
  --analysts "$ANALYSTS" --debate-rounds "$DEBATE_ROUNDS" --risk-rounds "$RISK_ROUNDS" \
  --language "$LANGUAGE"
```

`"$TA_ASSEMBLE"` writes `complete_report.md`, `complete_report.html`, and `meta.json` in
the run directory.

Record the decision in the memory log with the **`ta_memory` tool**, not with the wrapper:

```
ta_memory(action="store", ticker=TICKER, date=DATE, rating=RATING,
          decisionFile="<RUN_DIR>/5_portfolio/decision.md")
```

Why the tool and not bash: DSH confines the agent's bash and write tools to the workspace,
while the memory log lives in the data home (`$DATA/memory/trading_memory.md`) outside it.
The `ta_memory` tool runs in the Host process and can append there. The wrapper's read
commands (`memory context`, `memory settle`, `snapshot`, `quote`, `news`, ...) still work
from bash; only the two that write the log — `memory store` and `memory outcome` — must go
through the tool. If `ta_memory` reports a sandbox or permission error, report it instead
of retrying with bash.

`ta_memory(action="store", ...)` adds exactly one pending memory entry per run; the
idempotency guard prevents duplicates for the same ticker and date.

## 8. Final answer

Report, in the user's language:

- **Rating** and the one-sentence executive summary.
- **Key evidence** per side in a compact bull-versus-bear table, plus the risk debate's
  bottom line.
- **Actionable levels**: entry, stop, sizing (or "not provided").
- **Data gaps** and any failed section.
- **Paths**: `complete_report.html` (open this for reading), `complete_report.md`, the
  decision file, and the run directory.
- If the memory reflector ran: how many decisions it settled, waited on, or failed.

Do not paste the full reports into the answer. Offer the complete report path.

## Role output map

| Step | Role skill | Output |
|---|---|---|
| 1 | `trading-agents-market-analyst` | `1_analysts/market.md` |
| 1 | `trading-agents-sentiment-analyst` | `1_analysts/sentiment.md` |
| 1 | `trading-agents-news-analyst` | `1_analysts/news.md` |
| 1 | `trading-agents-fundamentals-analyst` | `1_analysts/fundamentals.md` |
| 1 | `trading-agents-memory-reflector` | reflections recorded by `memory outcome` |
| 2 | `trading-agents-bull-researcher` | `2_research/debate/bull_r<r>.md` |
| 2 | `trading-agents-bear-researcher` | `2_research/debate/bear_r<r>.md` |
| 3 | `trading-agents-research-manager` | `2_research/manager.md` |
| 4 | `trading-agents-trader` | `3_trading/trader.md` |
| 5 | `trading-agents-aggressive-risk-analyst` | `4_risk/debate/aggressive_r<r>.md` |
| 5 | `trading-agents-conservative-risk-analyst` | `4_risk/debate/conservative_r<r>.md` |
| 5 | `trading-agents-neutral-risk-analyst` | `4_risk/debate/neutral_r<r>.md` |
| 6 | `trading-agents-portfolio-manager` | `5_portfolio/decision.md` |

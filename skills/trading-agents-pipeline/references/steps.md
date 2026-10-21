# TradingAgents pipeline — teammate roster and step-by-step wiring

This file holds the roster, the exact team-tool calls, and the bash recipes for
`skills/trading-agents-pipeline/SKILL.md`. Read it before step 0. Nothing here is optional;
the SKILL.md carries the rules, this file carries the wiring.

## Roster

Teammate names are **stable, permanent, and never reused for another member**. Create each
once per session (`spawn_teammate`) and reuse it on later runs (`send_message`).

| Role key | Teammate | Role skill (loaded by the teammate) | Writes |
|---|---|---|---|
| market | `ta-market` | `trading-agents-market-analyst` | `1_analysts/market.md` |
| sentiment | `ta-sentiment` | `trading-agents-sentiment-analyst` | `1_analysts/sentiment.md` |
| news | `ta-news` | `trading-agents-news-analyst` | `1_analysts/news.md` |
| fundamentals | `ta-fundamentals` | `trading-agents-fundamentals-analyst` | `1_analysts/fundamentals.md` |
| bull | `ta-bull` | `trading-agents-bull-researcher` | `2_research/debate/bull_r<r>.md` |
| bear | `ta-bear` | `trading-agents-bear-researcher` | `2_research/debate/bear_r<r>.md` |
| manager | `ta-manager` | `trading-agents-research-manager` | `2_research/manager.md` |
| trader | `ta-trader` | `trading-agents-trader` | `3_trading/trader.md` |
| aggressive | `ta-aggressive` | `trading-agents-aggressive-risk-analyst` | `4_risk/debate/aggressive_r<r>.md` |
| conservative | `ta-conservative` | `trading-agents-conservative-risk-analyst` | `4_risk/debate/conservative_r<r>.md` |
| neutral | `ta-neutral` | `trading-agents-neutral-risk-analyst` | `4_risk/debate/neutral_r<r>.md` |
| pm | `ta-pm` | `trading-agents-portfolio-manager` | `5_portfolio/decision.md` |
| reflector | `ta-reflector` | `trading-agents-memory-reflector` | memory log (no run file) |

The team holds the Lead plus these thirteen names; a profile's `maxMembers` must allow
them. Do not create a `ta-<ticker>-…` variant: names are not reusable and the roster is
meant to survive across runs.

## Conventions used below

- Bash state does **not** persist between calls. Every block re-derives the wrapper paths
  and, from step 0 on, starts from the literal run directory and sources `run.env`.
- The DSH equivalent of the Claude Code SessionStart bootstrap is the plugin's
  activation-time warm-up. If a first `ta` call fails, run `"$TA" doctor` and report the
  error; never fall back to another Python.
- Pass **paths**, never report bodies. Do not `cat` a report into a dispatch.
- Every dispatch begins with the literal role-load line (substitute the real role name,
  e.g. `trading-agents-market-analyst`):

  ```
  First call the `skill` tool with name `trading-agents-<role>` to load your role instructions, then follow them exactly.
  ```

- A dispatch always carries the shared task id and ends with:

  ```
  Shared task: <task-id>. Before writing, claim it (team_task_get, then team_task_update
  action=claim with its revision). After your file exists, complete it (action=complete).
  Then send the Lead the short Return block from your role instructions.
  ```

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
cat > "$RUN_DIR/0_context/portfolio.md" <<'EOF'
Portfolio context: not provided. You do not know the caller's current holdings or cash, so do not assume a flat book; give direction and sizing guidance in terms the caller can apply to their own position.
EOF
pwd; echo "$RUN_DIR"
```

When the user supplied `PORTFOLIO` text, write that text to `0_context/portfolio.md`
instead of the default line. A non-zero
`grep -c '"status": "ready"' "$RUN_DIR/6_memory/pending.json"` means the memory reflector
joins the analyst batch in step 1; otherwise skip it.

### Every later bash call starts like this

Copy the **literal absolute** run directory printed by setup. Shell state does not persist.

```bash
DATA="${DSH_TRADING_AGENTS_HOME:-${TRADING_AGENTS_HOME:-${DSH_HOME:-$HOME/.dsh}/trading-agents}}"
TA="$DATA/bin/ta"; TA_ASSEMBLE="$DATA/bin/ta-assemble"
RUN_DIR=/absolute/path/printed/above; . "$RUN_DIR/run.env"
```

## Team bootstrap (once per run, before step 1)

```text
list_agents()
```

For every role this run needs, compare the roster against that list:

- **missing** → `spawn_teammate({ name: "ta-market", description: "Market analyst teammate", context: "fresh", prompt: <dispatch> })`
- **already present** → `send_message({ target: "ta-market", message: <dispatch> })`

The dispatch itself is identical in both cases: the initial prompt is the teammate's first
task, and a later message is its next. `describe` is a short human label; `name` must be
exactly one of the roster names.

### Shared task per role

Create the stage's tasks **before** dispatching, so the dispatch can name the task id and
so dependencies are visible on the board:

```text
team_task_create({
  subject: "NVDA 2026-10-21 market report",
  description: "Write <RUN_DIR>/1_analysts/market.md using the role skill. Field block: TICKER, ANALYSIS_DATE, CONTEXT_PATH, REPORT_PATH, OUTPUT_LANGUAGE.",
  write_scopes: [".trading-agents/runs/NVDA_20261021_224819/1_analysts/market.md"]
})
```

Add `blocked_by` with the earlier task ids when a stage needs prior output:

| Task | `blocked_by` |
|---|---|
| each analyst | — |
| bull | the four analyst tasks |
| bear | bull |
| manager | bull, bear |
| trader | manager |
| aggressive | trader |
| conservative | aggressive |
| neutral | conservative |
| pm | neutral |
| reflector | — (independent of the run's stage chain) |

A teammate may claim a task only when everything it depends on is complete, so the board
enforces the pipeline's ordering in addition to the Lead's own sequencing.

## 1. Analysts — parallel

Create four tasks (one per selected analyst), then dispatch **all of them in one tool
block** so they run concurrently. Field block (`<file>` from the roster):

```
TICKER=<TICKER>
ANALYSIS_DATE=<DATE>
CONTEXT_PATH=<RUN_DIR>/0_context/instrument_context.md
REPORT_PATH=<RUN_DIR>/1_analysts/<file>
OUTPUT_LANGUAGE=<LANGUAGE>
Write the report in <LANGUAGE>; keep labelled rating/trade lines in English.
```

Reflector dispatch (same block, only when ready items exist):

```
WORK_DIR=<RUN_DIR>/6_memory
TICKER=<TICKER>
Pending results are in <RUN_DIR>/6_memory/pending.json. Run `memory settle --ticker <TICKER>` yourself for fresh figures, and record only entries whose status is ready.
```

### Wait and normalize

```text
wait_agent({ timeout_ms: 120000 })
list_agents({})
team_task_list({ status: "completed" })
```

Repeat the wait/read pair until every analyst task is `completed` or a teammate reported a
failure; `wait_agent` returns `noProgress` when nothing is running — then check the board
before waiting again. After the stage, verify and normalize the slots (do not `cat` the
reports):

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
ls -l "$RUN_DIR/1_analysts"
```

Refresh the lessons file after settlement may have added entries:

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

For each round `r` from 1 to `DEBATE_ROUNDS`: create the bull task (blocked by the analyst
tasks), dispatch `ta-bull`, wait for its task to complete, append its turn, then create the
bear task (blocked by bull), dispatch `ta-bear`, wait, append.

Prompt fields for both:

```
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

After each turn, append it to the running history (chronological, no token cost):

```bash
DATA="${DSH_TRADING_AGENTS_HOME:-${TRADING_AGENTS_HOME:-${DSH_HOME:-$HOME/.dsh}/trading-agents}}"
TA="$DATA/bin/ta"; TA_ASSEMBLE="$DATA/bin/ta-assemble"
RUN_DIR=/absolute/path/printed/above; . "$RUN_DIR/run.env"
cat "$RUN_DIR/2_research/debate/bull_r<r>.md" >> "$RUN_DIR/2_research/debate/history.md"
```

Same pattern for the bear turn file. On a failed or empty turn, reopen its task, resend the
same dispatch once; if it still fails, write
`<Bull|Bear> Analyst: (argument unavailable this turn.)` to the turn file, append it,
complete the task with that note, and continue.

## 3. Research Manager

Create the manager task (blocked by bull and bear), dispatch `ta-manager`:

```
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

Create the trader task (blocked by manager), dispatch `ta-trader`:

```
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
**aggressive → conservative → neutral**, each blocked by the previous turn's task.

Prompt fields (all three):

```
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
ARGUMENT_PATH=<RUN_DIR>/4_risk/debate/<aggressive|conservative|neutral>_r<r>.md
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

Create the pm task (blocked by neutral), dispatch `ta-pm`:

```
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
re-dispatch `ta-pm` once with an explicit correction prompt (same fields, plus "Your
previous decision did not contain a valid `**Rating**:` line; rewrite it with exactly one of
Buy, Overweight, Hold, Underweight, Sell"). If it is still invalid, use `REVIEW` as the
rating and say so in the final answer.

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

## Capacity: the 8-member default

The shipped `@deepseek-ai/dsh-experimental-agent-team-profile` bundle mounts the team with
`maxMembers: 8`, while this roster needs 13 teammate slots. Raise it once in the profile's
own `cordis.patch.yml` (the user layer, applied after every bundle; HMR recomposes without a
restart):

```yaml
- id: agent-team
  name: '@deepseek-ai/dsh-experimental-agent-team'
  config:
    maxMembers: 24
    maxTasks: 256
    maxMessageBytes: 65536
    disposalTimeoutMs: 5000
```

Check `list_agents` before the first dispatch. If the free slots are fewer than this run
needs, say so once and dispatch the un-spawnable roles with the `subagent` tool below; a
`Team member limit N reached` error is final, never retried.

## Fallback when team tools are unavailable

If the profile does not mount the agent-team tools, replace each dispatch with the
`subagent` tool and the same role-load line plus field block. The task board can still be
used by the Lead alone for tracking, but teammate claims are skipped. Everything else —
files, markers, rating validation, assembly, memory store — is identical.

## Role output map

| Step | Teammate | Output |
|---|---|---|
| 1 | `ta-market` | `1_analysts/market.md` |
| 1 | `ta-sentiment` | `1_analysts/sentiment.md` |
| 1 | `ta-news` | `1_analysts/news.md` |
| 1 | `ta-fundamentals` | `1_analysts/fundamentals.md` |
| 1 | `ta-reflector` | reflections recorded by `memory outcome` |
| 2 | `ta-bull` | `2_research/debate/bull_r<r>.md` |
| 2 | `ta-bear` | `2_research/debate/bear_r<r>.md` |
| 3 | `ta-manager` | `2_research/manager.md` |
| 4 | `ta-trader` | `3_trading/trader.md` |
| 5 | `ta-aggressive` | `4_risk/debate/aggressive_r<r>.md` |
| 5 | `ta-conservative` | `4_risk/debate/conservative_r<r>.md` |
| 5 | `ta-neutral` | `4_risk/debate/neutral_r<r>.md` |
| 6 | `ta-pm` | `5_portfolio/decision.md` |

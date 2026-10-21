---
name: trading-agents-pipeline
description: Run the full keyless multi-agent equity research pipeline for one ticker — analysts, bull versus bear debate, trader, risk debate, portfolio decision — then assemble reports and record one memory entry. Uses a DSH agent team (Lead + named teammates + shared task board).
whenToUse: Use for a complete multi-agent research run on a ticker, directly or via the trading-agents-trade entry skill.
user-invocable: true
---

# TradingAgents pipeline (agent-team mode)

This session is the **Lead** of a DSH agent team: every desk role is a durable named
teammate and one shared task board tracks each stage deliverable. The Lead passes *file
paths* (never report bodies); each teammate writes only its own section file, so long text
never round-trips through the Lead's context. The bundled `ta` CLI is keyless (prices,
indicators, fundamentals, news, macro, prediction-market odds, social sentiment).

**The roster mapping, every task/spawn/message template, and every bash recipe are in
`references/steps.md` in this skill's base directory; read it before step 0.**

## Runtime facts

- The profile must mount the agent-team tools (`spawn_teammate`, `send_message`,
  `list_agents`, `wait_agent`, `team_task_*`). Without `spawn_teammate`, fall back to the
  `subagent` tool with the same role-load line and field block; everything else is identical.
- Bash blocks re-derive the wrapper: `DATA="${DSH_TRADING_AGENTS_HOME:-${TRADING_AGENTS_HOME:-${DSH_HOME:-$HOME/.dsh}/trading-agents}}"; TA="$DATA/bin/ta"; TA_ASSEMBLE="$DATA/bin/ta-assemble"`.
  Results dir default `${TRADING_AGENTS_RESULTS_DIR:-$PWD/.trading-agents/runs}`.
- A first `ta` call may spend about a minute bootstrapping the venv. If it fails, run
  `"$TA" doctor` and report the error; never fall back to another Python.
- **Capacity.** The roster needs 13 teammate slots and the shipped agent-team bundle sets
  `maxMembers: 8`. Check `list_agents` before dispatch: if fewer slots are free than this
  run needs, tell the user once to raise `maxMembers` (profile patch in
  `references/steps.md`) and dispatch the roles that cannot be spawned with the `subagent`
  tool, so the run still completes.

## Inputs

Arguments are the text after the skill token in the user's message. Parse them plus the
user's message:

| Input | Default | Notes |
|---|---|---|
| `TICKER` | required | Preserve suffixes (`700.HK`, `BTC-USD`). |
| `DATE` | today (`date +%F`) | `YYYY-MM-DD`; reject future dates. |
| `ANALYSTS` | `market,social,news,fundamentals` | `social` = sentiment. |
| `DEBATE_ROUNDS` | `1` | Bull+bear turns per round. |
| `RISK_ROUNDS` | `1` | Aggressive+conservative+neutral turns per round. |
| `LANGUAGE` | `$TRADING_AGENTS_OUTPUT_LANGUAGE` or English | Report prose language. |
| `PORTFOLIO` | not provided | Free text: holdings, cash, constraints. |

If `TICKER` is missing, ask and stop; everything else has a default. Accept `key=value`
(`analysts=market,news debate=2 risk=2 language=Chinese`) or bare positional arguments.

## Team protocol

1. **Reuse before creating.** Names are permanent and never reused for a different member,
   so the team is created once per session. Call `list_agents`; `spawn_teammate`
   (`context: "fresh"`) only missing roles, `send_message` existing ones. A
   member-limit error is final: never retry it — use the `subagent` fallback for that role.
2. **One shared task per role per run.** Create a stage's tasks with `team_task_create`
   (subject, description, `write_scopes`, `blocked_by` on the previous stage) before
   dispatching; every dispatch names its task id.
3. **One dispatch message.** It is: the literal role-load line
   `First call the \`skill\` tool with name \`trading-agents-<role>\` to load your role instructions, then follow them exactly.`,
   the task id with claim/complete instructions, and the stage's field block.
   Never paste role instructions: the teammate loads its own skill.
4. **Wait, then verify.** After dispatching, call `wait_agent`; on every wakeup re-read
   `list_agents` and `team_task_list`. Proceed only when the stage's tasks are `completed`
   and their output files are non-empty; never read a file before its task completes.
5. **Ordering.** Dispatch the selected analysts (plus the memory reflector when settlements
   are ready) in one tool block; run every debate turn strictly after the previous task
   completes. Do not reuse a run-specific teammate name.

## Steps

0. **Setup.** One bash call creates `RUN_DIR` (`0_context`…`6_memory`), `run.env`, the
   instrument context, `pending.json`, and `portfolio.md`. Later bash calls start from the
   literal `RUN_DIR` and source `run.env`.
1. **Analysts — parallel.** Dispatch the selected analysts through their teammates in one
   block, plus `ta-reflector` when ready settlements exist; wait for the tasks; normalize
   every analyst slot; refresh `0_context/past_context.md`.
2. **Research debate — sequential.** Per round: `ta-bull` then `ta-bear`.
   `OPPONENT_ARGUMENT` is the latest opposing turn (`none` in round 1), `DEBATE_HISTORY`
   the running history (`none` in round 1). Append every turn to the history.
3. **Research Manager.** `ta-manager` writes `2_research/manager.md`; then merge the turns
   into `2_research/bull.md` and `2_research/bear.md`.
4. **Trader.** `ta-trader` writes `3_trading/trader.md` from the manager plan, market
   report, and portfolio context.
5. **Risk debate — sequential.** Per round: `ta-aggressive` → `ta-conservative` →
   `ta-neutral`, with the proposal, analyst reports, portfolio context, risk history, and
   latest opponent turns; append every turn to the risk history.
6. **Portfolio Manager.** `ta-pm` writes `5_portfolio/decision.md`; read the rating
   deterministically (first `**Rating**:` line); merge the risk turns into
   `4_risk/{aggressive,conservative,neutral}.md`.
7. **Assemble and record.** Run the assemble wrapper, then record the decision with the
   `ta_memory` tool (`action: store`). Complete the stage tasks on the board.
8. **Final answer.** Follow the contract below.

## Failure and absence markers

- A failed or empty role gets one retry: reopen its task and resend the same dispatch.
- If it still fails, write the explicit marker — never a missing path, never treating
  absence as an empty finding. Analysts get
  `(No <key> report in this run: it is not available, not an empty finding.)`; research
  turns get `<Bull|Bear> Analyst: (argument unavailable this turn.)`; risk turns get
  `<Aggressive|Conservative|Neutral> Analyst: (argument unavailable this turn.)`. Append the
  marker to the history, update the task honestly, and continue.
- Unselected analysts also get the marker, so downstream roles always read a file.
- Never substitute your own analysis or invented data for a failed role; mark the gap.

## Rating validation

The rating read from `5_portfolio/decision.md` must be exactly one of `Buy`, `Overweight`,
`Hold`, `Underweight`, `Sell`. If not, re-dispatch `ta-pm` once with an explicit correction;
if still invalid, use `REVIEW` and say so in the final answer.

## Final answer

Report in the user's language: **Rating** and the one-sentence summary; **key evidence** per
side in a compact table plus the risk debate's bottom line; **actionable levels** (entry,
stop, sizing, or "not provided"); **data gaps** and failed sections; **paths** to
`complete_report.html` (open this), `complete_report.md`, the decision file, and the run
directory; and if the memory reflector ran, its settled/waiting/failed counts. Do not paste
full reports into the answer.

## Rules for the Lead

- Pass **paths**, not report text; never `cat` a report into a dispatch message.
- Analysts in parallel; every debate turn sequentially (each needs the previous turn).
- Keep the board truthful: complete a task only after its file exists; reopen rather than
  working around a stale revision. Do not touch the user's project files or git state.
- One run = one memory entry; re-running the same ticker and date does not duplicate it.

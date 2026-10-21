---
name: trading-agents-settle-decisions
description: Settle past TradingAgents decisions whose holding window has traded — run memory settle, dispatch the memory-reflector teammate for ready items, and report settled, waiting, and failed counts.
whenToUse: Use when the user asks to settle due decisions, update reflections, or check what the memory log is waiting on.
user-invocable: true
---

# Settle TradingAgents decisions

Settle past decisions whose holding window has traded, using the
`trading-agents-memory-reflector` role, so later pipeline runs can learn from outcomes.

Arguments are the text after the skill token in the user's message: an optional `TICKER`
(omit it to cover every ticker). If the user gives anything else, treat it as the ticker
filter only when it looks like one; otherwise ask.

## 1. Create a work directory

```bash
DATA="${DSH_TRADING_AGENTS_HOME:-${TRADING_AGENTS_HOME:-${DSH_HOME:-$HOME/.dsh}/trading-agents}}"
TA="$DATA/bin/ta"; TA_ASSEMBLE="$DATA/bin/ta-assemble"
WORK_DIR="${TRADING_AGENTS_RESULTS_DIR:-$PWD/.trading-agents/runs}/_settlement_$(date +%Y%m%d_%H%M%S)"
mkdir -p "$WORK_DIR"
echo "$WORK_DIR"
```

Every later bash block starts with the literal `WORK_DIR` printed above, plus the wrapper
paths, because shell state does not persist between calls.

## 2. Check what is due

Omit the ticker to cover every ticker. Every bash block redefines the wrapper paths.

```bash
DATA="${DSH_TRADING_AGENTS_HOME:-${TRADING_AGENTS_HOME:-${DSH_HOME:-$HOME/.dsh}/trading-agents}}"
TA="$DATA/bin/ta"; TA_ASSEMBLE="$DATA/bin/ta-assemble"
WORK_DIR=/absolute/path/printed/above
TICKER=<ticker from the arguments, or empty>
if [ -n "$TICKER" ]; then
  "$TA" memory settle --ticker "$TICKER" > "$WORK_DIR/pending.json"
else
  "$TA" memory settle > "$WORK_DIR/pending.json"
fi
cat "$WORK_DIR/pending.json"
```

Each item's `status` is `ready` (the full holding window has traded), `waiting` (not yet),
or `failed` (prices unreadable). Count each status from the JSON.

## 3. Dispatch the memory reflector when anything is ready

The reflector is the durable teammate `ta-reflector` (role skill
`trading-agents-memory-reflector`). Teammate names are permanent, so check the roster with
`list_agents`: call `spawn_teammate` only when the name is missing, and `send_message` when
it already exists. The dispatch is the same text either way.

Create the shared task first so the board records the work:

```
team_task_create({
  subject: "Settle due TradingAgents decisions (<ticker or all>)",
  description: "Write 2-4 sentence reflections for ready items and record their outcomes in the memory log."
})
```

Then dispatch (the initial prompt when spawning, the message when reusing):

```
First call the `skill` tool with name `trading-agents-memory-reflector` to load your role instructions, then follow them exactly.
WORK_DIR=<WORK_DIR>
TICKER=<ticker or "all">
Pending results are in <WORK_DIR>/pending.json. Run `memory settle` yourself if you need fresh figures, and record only entries whose status is ready.
Shared task: <task-id>. Claim it before writing (team_task_get, then team_task_update action=claim with its revision); complete it (action=complete) once your reflections are recorded. Then send the Lead the short Return block from your role instructions.
```

Call `wait_agent`, then re-read `list_agents` and `team_task_list`; repeat until the task is
`completed` or the reflector reports a failure. On a failed or empty run, reopen the task and
resend the same dispatch once; if it still fails, report the failure instead of inventing
reflections. Never read or claim results before the task completes. Without the team tools,
fall back to the `subagent` tool with the same role-load line.

If no item is ready, do not dispatch anything: say how many are waiting and how many failed,
with the failure reasons when the JSON provides them, and stop.

## 4. Report

Report, in the user's language:

- **Settled**: how many decisions were settled, with ticker and date.
- **Waiting**: how many remain pending, and why (window not fully traded).
- **Failed**: how many could not be priced, with the reported reasons.
- The work directory and `pending.json` paths.

Do not paste reflections into the answer. Never invent outcomes, prices, or benchmarks; if
a figure is missing, say so.

## Runtime notes

- The DSH equivalent of the SessionStart bootstrap is the plugin's activation-time warm-up.
  A first `ta` call may still spend about a minute installing the venv; if it fails, run
  `"$TA" doctor` and report the error; never fall back to another Python.
- Results dir default: `${TRADING_AGENTS_RESULTS_DIR:-$PWD/.trading-agents/runs}`; home default:
  `${TRADING_AGENTS_HOME:-${DSH_HOME:-$HOME/.dsh}/trading-agents}`.

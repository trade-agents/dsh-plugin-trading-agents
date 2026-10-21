---
name: trading-agents-settle-decisions
description: Settle past TradingAgents decisions whose holding window has traded — run memory settle, spawn the memory reflector for ready items, and report settled, waiting, and failed counts.
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

## 3. Spawn the memory reflector when anything is ready

If at least one item has `"status": "ready"`, spawn the memory reflector with the
`subagent` tool:

- Role skill: `trading-agents-memory-reflector`.
- `description`: `Memory reflector: settle <ticker or all>`.
- Child prompt — begin with the literal role-load line:

```
First call the `skill` tool with name `trading-agents-memory-reflector` to load your role instructions, then follow them exactly.
WORK_DIR=<WORK_DIR>
TICKER=<ticker or "all">
Pending results are in <WORK_DIR>/pending.json. Run `memory settle` yourself if you need fresh figures, and record only entries whose status is ready.
```

The `subagent` tool returns immediately with a child id; the parent gets a completion
notice when the child settles. Do not read the reflector's output files or claim results
before that notice. If the child fails, retry once with the same prompt; if it fails again,
report the failure instead of inventing reflections.

If no item is ready, do not spawn anything: say how many are waiting and how many failed,
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

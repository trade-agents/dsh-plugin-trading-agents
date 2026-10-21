# DSH port of `trading-agents-plugin` — interface design (v1)

Source (read-only): `/Users/huike/Project/trading-workspace/trading-agents-plugin` (Claude Code plugin, v0.2.9).
Target: this workspace, a **DSH bundle package** `dsh-plugin-trading-agents`.

## Goal

Same functionality as the Claude Code plugin: a keyless multi-agent equity research
pipeline (4 analysts → bull/bear debate → research manager → trader → risk debate →
portfolio manager), a Python data layer, a memory log, Markdown + HTML reports, and
slash-command entry points.

## Mapping: Claude Code → DSH

| Claude Code | DSH equivalent |
| --- | --- |
| `commands/*.md` (prompt expansion) | **user-invocable runtime skills** (`/trading-agents-trade`, …) |
| `skills/pipeline/SKILL.md` | runtime skill `trading-agents-pipeline` |
| `agents/*.md` (13 subagent defs) | runtime **model-invocable-only** skills read from `roles/*.md`, loaded by a durable named teammate (`ta-market` … `ta-pm`) the Lead creates with `spawn_teammate` and dispatches with `send_message`; a shared task board tracks stages, write scopes and dependencies |
| `hooks/hooks.json` SessionStart → `bootstrap.sh` | plugin `apply()` best-effort warm-up + lazy bootstrap in every tool + `ta_doctor` |
| `${CLAUDE_PLUGIN_ROOT}/scripts/ta` | `$TRADING_AGENTS_HOME/bin/ta` launcher the plugin writes on activation |
| `.claude-plugin/plugin.json` | `package.json` (`dsh.bundle.patch`) + `locale/{en,zh}.json` meta + `icon.svg` |
| `marketplace.json` | documented install section in README (DSH uses profiles/`dsh plugin install`) |

## Package layout (final)

```
package.json              name dsh-plugin-trading-agents, dsh.bundle.patch
cordis.patch.yml          inserts row id: trading-agents
icon.svg  locale/en.json  locale/zh.json
lib/index.js              name / inject / apply(ctx, config)
lib/config.js             config normalization + defaults
lib/paths.js              home / results / bin / venv resolution
lib/python.js             venv bootstrap, launcher writing, child_process runner
lib/frontmatter.js        tiny YAML-frontmatter reader for SKILL.md / roles
lib/skills.js             runtime skill registration (pipeline, trade, settle, roles)
lib/tools.js              the five registered tools
roles/*.md                13 role instruction files (model-invocable-only skills)
skills/<name>/SKILL.md    pipeline / trade / settle-decisions (user-invocable)
skills/trading-agents-pipeline/references/steps.md  full per-step recipes
scripts/                  ported Python data layer + wrappers (owner: script-porter)
requirements.txt
test/smoke.js             offline assertions; optional live checks
test/dsh-schema-check.mjs DSH's real tool validator
test/dsh-skill-check.mjs  DSH's real skill registry (register + load)
README.md
```

## Config (all optional, validated in `apply`; no schemastery peer dep)

```yaml
- id: trading-agents
  name: dsh-plugin-trading-agents
  config:
    home: ''                 # default $DSH_HOME/trading-agents (~/.dsh/trading-agents)
    resultsDir: ''           # default <workspace>/.trading-agents/runs (inside the sandboxed workspace)
    outputLanguage: English
    holdingDays: 5
    benchmark: ''            # default: auto by exchange suffix (yfinance logic)
    python: ''               # default: python3 on PATH
    autoBootstrap: true      # warm the venv when the plugin activates (SessionStart analog)
    bootstrapTimeoutMs: 300000
    bootstrapInline: false   # if false, warm-up is fire-and-forget in the background
    exposeRoleSkills: true   # register the 13 role skills (children load them)
    env: {}                  # extra environment variables for Python
```

Unknown keys are rejected at load time (loud failure, like the mysql plugin), but a bad
config never breaks profile startup: the plugin still loads, tools still appear, and each
tool call returns the exact problem to fix.

## Tools (registered on `ctx.tools`)

| Tool | Purpose |
| --- | --- |
| `ta_doctor` | Python/venv/deps/connectivity report + **pluginRoot**, **home**, **resultsDir**, **binDir**, **venvPython** paths (this is how prompts discover the CLI). |
| `ta_run` | Create a run directory (`<resultsDir>/<TICKER>_<ts>` with `0_context`…`6_memory`), write `run.env`, write `0_context/instrument_context.md` via `identity`, and write `6_memory/pending.json` via `memory settle`. Returns all paths. |
| `ta_data` | Every data subcommand with typed params: `identity`, `quote`, `snapshot`, `indicator`, `fundamentals`, `statement`, `insiders`, `news`, `global-news`, `macro`, `prediction`, `sentiment`, `futu`, `today`. |
| `ta_memory` | `context`, `store`, `list`, `settle`, `outcome`. |
| `ta_assemble` | Run `assemble_report.py`: `runDir`, `ticker`, `date`, `rating`, `analysts`, `debateRounds`, `riskRounds`, `language` → writes `complete_report.md`/`.html`/`meta.json`. |

Every tool returns the CLI's stdout, exit code, and stderr tail; failures are reported, never
fabricated. `ta_data`/`ta_memory` accept `date`, `ticker`, `start`, `end`, `days`, etc. and
build argv internally (no shell interpolation).

## Skill surface

| Skill | Invocation | Purpose |
| --- | --- | --- |
| `trading-agents-pipeline` | user + model | full orchestration (command analog of `/trading-agents:pipeline`) |
| `trading-agents-trade` | user + model | thin entry: parse args, then load + follow the pipeline skill |
| `trading-agents-settle-decisions` | user + model | settle due decisions, spawn the memory reflector |
| `trading-agents-<role>` ×13 | model only (`user-invocable: false`) | one role each, loaded by the child subagent |

`name` must be kebab-case. `SKILL.md`-style frontmatter is parsed by `lib/frontmatter.js`.
Keep every skill body **under 7500 characters** — DSH's standard tool-result pruner trims
results above 8192 characters, which would silently cut a long SKILL.md. Long recipes go to
`skills/<name>/references/*.md`, read on demand from the base directory the `skill` tool
reports.

## Bash convention for skills (the `${CLAUDE_PLUGIN_ROOT}` replacement)

The plugin writes `$HOME/bin`-style launchers on activation:

```
<home>/bin/ta            # exec bash <pluginRoot>/scripts/ta "$@"
<home>/bin/ta-assemble   # exec bash <pluginRoot>/scripts/ta-assemble "$@"
<home>/env.sh            # exports TRADING_AGENTS_HOME / TRADING_AGENTS_PLUGIN_ROOT
```

Skills start every bash block with:

```bash
DATA="${TRADING_AGENTS_HOME:-${DSH_HOME:-$HOME/.dsh}/trading-agents}"
TA="$DATA/bin/ta"
```

Default `home`: `$TRADING_AGENTS_HOME`, else `$DSH_HOME/trading-agents`, else `~/.dsh/trading-agents`.
`resultsDir` default `<home>/runs`. All existing env var names are preserved.

## Behaviour parity checklist

1. 4 analysts in parallel; sequential bull/bear rounds; research manager; trader; sequential
   aggressive/conservative/neutral rounds; portfolio manager.
2. Role outputs written by the role itself to its `REPORT_PATH`/`ARGUMENT_PATH`; the
   orchestrator passes paths only, never report bodies.
3. Missing/failed sections normalised to explicit absence markers; rating read from
   `**Rating**:` deterministically, validated against the five allowed values.
4. `complete_report.md` + `complete_report.html` + `meta.json`, plus the per-section files.
5. Memory log: `context` → `store` (pending) → `settle` (score) → `outcome` (reflection).
6. Python venv at `<home>/venv`, bootstrapped on first use with a requirements hash cache.
7. Data gaps reported as explicit placeholders, never estimated.
8. Language / holding-days / benchmark configuration.

## Non-goals

- No dependency on the TradingAgents Python project or any API key.
- No `@deepseek-ai/*` imports: the plugin resolves from a profile's `node_modules` with no
  peer packages. Only `node:` builtins.
- No writes outside `<home>` (venv/memory/bootstrap/launchers) and `<resultsDir>`.

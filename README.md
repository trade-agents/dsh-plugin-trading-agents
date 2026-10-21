# TradingAgents plugin for DeepSeek Harness

A distributable **DSH bundle** that runs a multi-agent equity research and trading
decision pipeline:

**4 analysts in parallel → bull vs. bear debate → research manager → trader →
aggressive / conservative / neutral risk debate → portfolio manager decision**

This repository: <https://github.com/trade-agents/dsh-plugin-trading-agents>.

It is a port of the [TradingAgents Claude Code plugin](https://github.com/trade-agents/trading-agents-plugin),
re-implemented against DeepSeek Harness's plugin, skill and tool contracts. It is a
standalone reimplementation of the [TradingAgents](https://github.com/TauricResearch/TradingAgents)
role graph: it does **not** import or require that Python project, and it needs no API keys.

## What changes between the two harnesses

The behaviour is the same; the extension points are not.

| Claude Code artifact | DSH artifact in this package |
| --- | --- |
| `commands/*.md` (prompt-expanding slash commands) | **user-invocable runtime skills**: `/trading-agents-trade`, `/trading-agents-settle-decisions`, `/trading-agents-pipeline` |
| `skills/pipeline/SKILL.md` | `skills/trading-agents-pipeline/SKILL.md` + `references/steps.md` (split because DSH trims tool results above 8192 characters) |
| `agents/*.md` (13 subagent definitions) | `roles/*.md`, registered as **model-only skills** (`trading-agents-<role>`); the orchestrator spawns a `subagent` and tells it to load its role skill first, so role text never passes through the orchestrator's context |
| `hooks/hooks.json` → `SessionStart` bootstrap | the plugin's activation-time warm-up (`autoBootstrap`), plus lazy bootstrap on the first tool call and `ta_doctor` |
| `${CLAUDE_PLUGIN_ROOT}/scripts/ta` | `$TRADING_AGENTS_HOME/bin/ta` launchers the plugin writes on activation, plus the `ta_*` tools |
| `.claude-plugin/plugin.json` | `package.json` (`dsh.bundle.patch`) + `locale/{en,zh}.json` display metadata + `icon.svg` |
| `marketplace.json` | a DSH profile: install the bundle into it (see [Install](#install)) |

`subagent_type: trading-agents:market-analyst` becomes the `subagent` tool with a
prompt whose first line is:

```text
First call the `skill` tool with name `trading-agents-market-analyst` to load your role instructions, then follow them exactly.
```

## Requirements

- **DeepSeek Harness ≥ 0.2.1-rc.2** (the `engines.dsh` range is enforced at install time).
- **Python 3.10+** with `venv` and `pip` — the plugin creates its own venv the first time it runs.
- **bash** for the wrapper scripts (macOS, Linux, WSL, or Git Bash on Windows).
- Network access to PyPI for the first install, and to the data endpoints at runtime
  (Yahoo Finance, Google News, FRED, Polymarket, StockTwits, Reddit, Futu).
- No API keys, and no dependency on the TradingAgents Python project.

The plugin itself has **no npm dependencies** — it imports only `node:` builtins, so it
resolves from a profile's `node_modules` with no peer packages.

## Install

### From this repository

The package is a DSH bundle, so any pnpm-acceptable spec works. From a shell with `dsh`
on `PATH`:

```bash
# SSH (the repository is private; git uses the same credentials as `git clone`)
dsh plugin --profile <profile> add git+ssh://git@github.com/trade-agents/dsh-plugin-trading-agents.git

# or a local checkout
dsh plugin --profile <profile> add /absolute/path/to/dsh-plugin-trading-agents
```

Or ask the agent in a session to install it from the repository URL with the
`plugin_manager` tool (`action: install_bundle`, `target` set to the git spec). The Web
Plugins page's Add-plugin dialog takes the same spec. In Desktop, the CLI that can manage
the initialized Desktop profile ships with the app at
`/Applications/DeepSeek Harness.app/Contents/Resources/runtime/cli/bin/dsh`.

### Into a DSH profile (recommended, from a local checkout)

Ask the agent to install the bundle, or use the Plugins page in the Web UI:

```text
Install the DSH bundle at /absolute/path/to/dsh-plugin-trading-agents into my profile.
```

The agent does that with the `plugin_manager` tool, `action: install_bundle`,
`target` set to the absolute package directory. The bundle patch inserts one row
(`id: trading-agents`), and the plugin's tools and skills become available in every
session of that profile.

### By hand, into a profile's patch

If the package already resolves from the profile's `node_modules`, add the row to
`$DSH_HOME/profiles/<profile>/cordis.patch.yml`:

```yaml
- id: trading-agents
  name: dsh-plugin-trading-agents
  config:
    outputLanguage: English
    holdingDays: 5
```

`config` is optional; the defaults are documented in [Configuration](#configuration).

### Verify the install

```bash
# offline: plugin surface, config validation, argv construction, launchers
node test/smoke.js

# the same schemas through DSH's real validator (must run through the Electron binary)
ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" \
  test/dsh-schema-check.mjs
```

In a session, run the `ta_doctor` tool: it reports the plugin root, data home,
results directory, launcher paths and venv state.

## Use

```text
/trading-agents-trade NVDA
/trading-agents-trade NVDA 2026-10-20
/trading-agents-trade NVDA analysts=market,news debate=2 risk=2 language=Chinese
/trading-agents-pipeline 700.HK
/trading-agents-settle-decisions
```

A skill is invoked by typing `/name` in the composer; the text after the name is the
skill's input (there is no `$ARGUMENTS` template in DSH).

You can also ask for a single role directly — for example "act as the market analyst
for NVDA" — or drive the pipeline through the tools.

Ticker formats: exchange suffixes are preserved (`.HK`, `.T`, `.TO`, `-USD`). Hong Kong
broker codes with five digits are normalized for data requests (`02513.HK` → Yahoo's
`2513.HK`), while reports keep the caller's ticker.

## Tools

The plugin registers five tools on the DSH tool registry. They are the path-independent
way to reach the Python layer; the skills also call the same CLI through the generated
`bin/ta` launcher.

| Tool | Purpose |
| --- | --- |
| `ta_doctor` | Environment report: plugin root, data home, results directory, launcher paths, venv state, Python interpreter; optional data-source connectivity probe. |
| `ta_run` | Creates run `<results>/<TICKER>_<timestamp>/` with `0_context`…`6_memory`, `run.env`, the instrument context, the portfolio context and the pending-settlement list. Returns every path the pipeline needs. |
| `ta_data` | Every keyless read: `identity`, `quote`, `snapshot`, `indicator`, `fundamentals`, `statement`, `insiders`, `news`, `global-news`, `macro`, `prediction`, `sentiment`, `futu`, `today`. |
| `ta_memory` | Memory log: `context`, `store`, `list`, `settle`, `outcome`. |
| `ta_assemble` | Builds `complete_report.md`, `complete_report.html` and `meta.json` from a finished run directory. |

Every tool returns the CLI's real exit code and both streams; missing data is reported as
a labelled gap, never estimated.

## Skills

| Skill | Who can invoke it | Purpose |
| --- | --- | --- |
| `trading-agents-pipeline` | user + model | The full orchestration procedure. |
| `trading-agents-trade` | user + model | Entry point: parses the argument line, then follows the pipeline skill. |
| `trading-agents-settle-decisions` | user + model | Settles due decisions and spawns the memory reflector. |
| `trading-agents-market-analyst`, `-sentiment-analyst`, `-news-analyst`, `-fundamentals-analyst`, `-bull-researcher`, `-bear-researcher`, `-research-manager`, `-trader`, `-aggressive-risk-analyst`, `-conservative-risk-analyst`, `-neutral-risk-analyst`, `-portfolio-manager`, `-memory-reflector` | model only | One desk role each, loaded by the subagent the orchestrator spawns. |

## What runs

| Role | Role skill | Writes |
| --- | --- | --- |
| Market Analyst | `trading-agents-market-analyst` | `1_analysts/market.md` |
| Sentiment Analyst | `trading-agents-sentiment-analyst` | `1_analysts/sentiment.md` |
| News Analyst | `trading-agents-news-analyst` | `1_analysts/news.md` |
| Fundamentals Analyst | `trading-agents-fundamentals-analyst` | `1_analysts/fundamentals.md` |
| Bull Researcher | `trading-agents-bull-researcher` | `2_research/debate/bull_rN.md` |
| Bear Researcher | `trading-agents-bear-researcher` | `2_research/debate/bear_rN.md` |
| Research Manager | `trading-agents-research-manager` | `2_research/manager.md` |
| Trader | `trading-agents-trader` | `3_trading/trader.md` |
| Aggressive Risk Analyst | `trading-agents-aggressive-risk-analyst` | `4_risk/debate/aggressive_rN.md` |
| Conservative Risk Analyst | `trading-agents-conservative-risk-analyst` | `4_risk/debate/conservative_rN.md` |
| Neutral Risk Analyst | `trading-agents-neutral-risk-analyst` | `4_risk/debate/neutral_rN.md` |
| Portfolio Manager | `trading-agents-portfolio-manager` | `5_portfolio/decision.md` |
| Memory Reflector | `trading-agents-memory-reflector` | memory log |

Output tree:

```text
<results>/<TICKER>_<timestamp>/
  0_context/{instrument_context,portfolio,past_context}.md
  1_analysts/{market,sentiment,news,fundamentals}.md
  2_research/{bull,bear,manager}.md + debate/
  3_trading/trader.md
  4_risk/{aggressive,conservative,neutral}.md + debate/
  5_portfolio/decision.md
  6_memory/
  complete_report.md      # readable Markdown report
  complete_report.html    # self-contained styled HTML report
  meta.json
```

## Reports

Every run writes two reader-facing artifacts plus machine metadata:

- **`complete_report.html`** — a single offline page: rating badge, summary cards
  (action, entry, stop, sizing, sentiment, target, horizon), a section TOC,
  collapsible analyst/debate sections, styled tables, data-gap list, run metadata,
  and print CSS. No external assets, fonts, or scripts.
- **`complete_report.md`** — the same content as structured Markdown with a decision
  table, TOC with working anchors, full section text, data gaps, and run metadata.
- **`meta.json`** — ticker, date, rating, analysts, debate rounds, language, missing
  sections, data-gap count, plugin version, and generated timestamp.

The individual section files remain in `1_analysts/` … `5_portfolio/`, so the report can
be regenerated without re-running the agents:

```bash
DATA="${TRADING_AGENTS_HOME:-${DSH_HOME:-$HOME/.dsh}/trading-agents}"
"$DATA/bin/ta-assemble" \
  --run-dir <run-dir> --ticker NVDA --date 2026-10-20 --rating Hold \
  --analysts market,social,news,fundamentals --debate-rounds 1 --risk-rounds 1 \
  --language English
```

## Data sources (no API keys)

The bundled `ta` CLI uses only `yfinance`, `pandas`, and `requests`; report rendering
adds `Markdown`.

| Data | Source |
| --- | --- |
| OHLCV, technical inputs, company profile, statements, insiders | Yahoo Finance via yfinance |
| Ticker news | Yahoo Finance RSS + Google News RSS |
| Global / macro news | Google News RSS + Yahoo Finance RSS |
| Macro series (CPI, PCE, unemployment, Fed funds, yields, VIX, euro area) | FRED public CSV endpoint — no key |
| Prediction-market odds | Polymarket Gamma API |
| Retail sentiment | StockTwits public API + Reddit RSS |
| Chinese / HK community sentiment | Futu community/feed (`ai-news-search.futunn.com/stock_feed`, public, no key) |

Missing data is returned as a labelled placeholder (for example `DATA_UNAVAILABLE`,
`<StockTwits ... coverage gap>`, or `<Futu ... unavailable>`), never estimated.

Known limitations (unchanged from the source plugin):

- Yahoo profile/statement data is current, not a historical vintage; reports state this
  when the analysis date is in the past.
- StockTwits covers US/crypto listings. HK and other non-US listings are reported as a
  coverage gap; Futu community is the primary social source for HK/A-share names.
- Futu's public feed mixes short user posts with platform articles and is a live snapshot,
  not a point-in-time archive.
- StockTwits, Futu and Reddit serve recent items only; historical windows are reported as
  unavailable, not as silence.
- FRED's CSV endpoint is keyless but unofficial; if it changes, the plugin reports the gap
  instead of fabricating values.
- yfinance and the public endpoints must be reachable from the machine.

## Python environment

The plugin creates its own virtual environment at
`${TRADING_AGENTS_HOME:-$DSH_HOME/trading-agents}/venv` and installs `requirements.txt`
on first use. It never uses a project venv.

Three things warm it:

1. **Activation warm-up** — when the plugin loads, it starts the bootstrap in the
   background (the DSH analog of the Claude Code `SessionStart` hook). Set
   `autoBootstrap: false` to turn it off, or `bootstrapInline: true` to await it during
   profile load.
2. **Lazy bootstrap** — the first `ta_*` tool call or `bin/ta` invocation bootstraps if
   the venv is missing or `requirements.txt` changed.
3. **`ta_doctor`** — reports state without side effects.

Once ready, the bootstrap is a **read-only** check, so the wrapper works even when DSH
sandboxes the agent's bash tool and the data home is outside the workspace.

Created on activation (and safe to delete; they are recreated):

```text
<home>/bin/ta             # exec bash <plugin>/scripts/ta "$@"
<home>/bin/ta-assemble    # exec bash <plugin>/scripts/ta-assemble "$@"
<home>/env.sh             # exports the same paths the plugin resolved
```

Logs go to `<home>/bootstrap.log`. The venv requirements hash is cached in
`<home>/venv/.req-hash`, and a `mkdir` lock serializes concurrent bootstrap attempts.

If PyPI is blocked, preinstall into the plugin venv manually:

```bash
python3 -m venv "${TRADING_AGENTS_HOME:-$DSH_HOME/trading-agents}/venv"
"${TRADING_AGENTS_HOME:-$DSH_HOME/trading-agents}/venv/bin/python" -m pip install -r requirements.txt
```

## Configuration

Every field is optional, validated at load time, and unknown fields are rejected so a typo
fails loudly. A bad config never breaks profile startup: the plugin stays loaded, the
tools stay visible, and each call returns the exact problem to fix.

```yaml
- id: trading-agents
  name: dsh-plugin-trading-agents
  config:
    home: ''                       # default: $TRADING_AGENTS_HOME, else $DSH_HOME/trading-agents
    resultsDir: ''                 # default: <workspace>/.trading-agents/runs
    outputLanguage: English
    holdingDays: 5
    benchmark: ''                  # default: auto by exchange suffix (SPY for US)
    python: ''                     # default: python3 on PATH
    autoBootstrap: true
    bootstrapTimeoutMs: 300000
    bootstrapInline: false
    exposeRoleSkills: true
    env: {}                        # extra environment variables for the Python layer
```

| Field | Default | Meaning |
| --- | --- | --- |
| `home` | `$DSH_HOME/trading-agents` | venv, memory log, launchers, bootstrap log. |
| `resultsDir` | `<workspace>/.trading-agents/runs` | Run directories. Defaults inside the workspace because DSH confines the agent's bash and write tools there. |
| `outputLanguage` | `English` | Report prose language. |
| `holdingDays` | `5` | Outcome window for settlement. |
| `benchmark` | auto by suffix | Alpha benchmark symbol. |
| `python` | `python3` | Interpreter used to create the venv. When unset, the plugin falls back to the CPython that ships with DSH, then `python3` on `PATH`. |
| `autoBootstrap` | `true` | Warm the venv when the plugin activates. |
| `bootstrapTimeoutMs` | `300000` | Cap on one bootstrap run. |
| `bootstrapInline` | `false` | Await the warm-up instead of backgrounding it. |
| `exposeRoleSkills` | `true` | Register the 13 role skills. |
| `env` | `{}` | Extra environment variables for the Python layer. |

## Environment variables

The names are unchanged from the Claude Code plugin, so an existing log or results
directory can be reused.

| Variable | Default | Purpose |
| --- | --- | --- |
| `TRADING_AGENTS_HOME` | `$DSH_HOME/trading-agents` | venv, memory log, launchers, bootstrap log |
| `TRADING_AGENTS_RESULTS_DIR` | `<workspace>/.trading-agents/runs` | run directories |
| `TRADING_AGENTS_OUTPUT_LANGUAGE` | `English` | report prose language |
| `TRADING_AGENTS_HOLDING_DAYS` | `5` | outcome window for settlement |
| `TRADING_AGENTS_BENCHMARK` | auto by exchange suffix | alpha benchmark |
| `TRADING_AGENTS_PYTHON` | `python3` | interpreter used to create the venv |
| `DSH_TRADING_AGENTS_ROOT` | set by the plugin | plugin root, injected into the shell by `dsh-shell-env` |
| `DSH_TRADING_AGENTS_HOME` | set by the plugin | resolved data home, injected into the shell |
| `DSH_TRADING_AGENTS_RESULTS_DIR` | set by the plugin | resolved results directory, injected into the shell |

The memory log is `<home>/memory/trading_memory.md`, in the same markdown format the
original project uses, so an existing log can be copied in.

### How this interacts with the DSH file sandbox

DSH's default file policy (`workspace-write`) confines the agent's `bash`, `read` and
`write` tools to the session workspace. The port is shaped around that:

- **The run tree lives in the workspace** (`<workspace>/.trading-agents/runs`), because the
  pipeline's `mkdir`, history appends, section merges and role `write` calls all run
  through those tools. Bash resolves it from `$PWD`; the `ta_run` tool resolves it from the
  calling session's working directory, so a Desktop session that changed directory still
  writes where its own tools may write.
- **The venv and the memory log live in the data home**, outside the workspace. The venv is
  created and upgraded by the Host-process plugin and by the `ta_*` tools, which are not
  sandboxed; bash only reads the interpreter, so `"$TA" snapshot …` works.
- **The two memory writes go through the `ta_memory` tool** (`action: store` and
  `action: outcome`), because the memory log is outside the workspace. Read-only memory
  calls (`context`, `settle`) work from bash too.
- If you run sessions with a wider file policy (`danger-full-access`), you can point
  `resultsDir` or `TRADING_AGENTS_RESULTS_DIR` at a shared directory and use the wrapper
  for memory writes as well.

Add `.trading-agents/` to the project's `.gitignore` — it holds run output, not source.

## Development

```bash
DATA="${TRADING_AGENTS_HOME:-${DSH_HOME:-$HOME/.dsh}/trading-agents}"
"$DATA/bin/ta" doctor
"$DATA/bin/ta" snapshot NVDA --date 2026-10-20
"$DATA/bin/ta" sentiment NVDA --date 2026-10-20
"$DATA/bin/ta" futu 02513.HK --date 2026-10-21
"$DATA/bin/ta" macro cpi --date 2026-10-20
```

When the profile mounts `dsh-shell-env` (the base composition does), the plugin also
injects `DSH_TRADING_AGENTS_HOME`, `DSH_TRADING_AGENTS_ROOT` and
`DSH_TRADING_AGENTS_RESULTS_DIR` into every shell call, so a skill block can read the
resolved paths instead of recomputing them.

Bump `version` in `package.json` when publishing a release.

Tests:

```bash
# offline: plugin surface, config, argv, launchers, no network or venv needed
node test/smoke.js

# also exercises the real endpoints, the run tree, and the report assembler
DSH_TEST_TRADING_AGENTS_LIVE=1 TRADING_AGENTS_HOME=/path/to/bootstrapped/home node test/smoke.js

# DSH's own tool validator: schemas plus live output values
ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" \
  test/dsh-schema-check.mjs

# DSH's own skill registry: every skill must register AND load back
ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness" \
  test/dsh-skill-check.mjs
```

The last two must run through the packaged Electron binary because the DSH runtime lives
inside `app.asar`. Set `DSH_APP_ASAR` if the app is installed somewhere else.

## Layout

```
package.json              bundle manifest (dsh.bundle.patch)
cordis.patch.yml          inserts the `trading-agents` row
icon.svg  locale/         Plugin Manager display metadata
lib/index.js              plugin entry: name / inject / apply
lib/config.js             config validation and defaults
lib/paths.js              home / results / launcher paths
lib/python.js             venv bootstrap, launchers, subprocess bridge
lib/skills.js             runtime skill registration
lib/tools.js              the five tool definitions and renderers
lib/frontmatter.js        minimal SKILL.md frontmatter reader
roles/*.md                the thirteen desk roles
skills/                   pipeline / trade / settle-decision skills + references
scripts/                  the ported Python data layer and shell wrappers
test/                     offline smoke suite + DSH validator check
notes/                    port design and per-workstream deviation notes
```

## Differences from the Claude Code plugin (deliberate)

- **Slash commands are skills.** DSH has no prompt-expanding command file; a
  user-invocable skill is the equivalent surface. Input arrives as ordinary message text.
- **Roles are skills, not agent definitions.** DSH's `subagent` tool takes a prompt, not
  an `agent_type`. The orchestrator passes a fixed first line that makes the child load
  its role skill, which keeps role instructions out of the orchestrator's context.
- **The pipeline skill is split.** DSH trims tool results above 8192 characters, so the
  full bash recipes live in `skills/trading-agents-pipeline/references/steps.md` and are
  read on demand.
- **No `SessionStart` hook.** Activation-time warm-up plus lazy bootstrap cover it, and
  the bootstrap can no longer block a session start.
- **Launchers instead of `${CLAUDE_PLUGIN_ROOT}`.** Skills call `"$DATA/bin/ta"`, which
  works from any shell and any install location.
- **Five tools are new.** DSH plugins can register tools, so the data layer, run setup,
  memory and report assembly are also available as typed calls in addition to bash.

## License

Apache-2.0.

# Verification record

Everything below was run on the porting machine: macOS, DeepSeek Harness
**0.2.1-rc.2**, Node 24.21.0, Python 3.13.1 on `PATH`.

## 1. Static correctness

| Check | Result |
| --- | --- |
| `node --check lib/*.js` | all 7 modules parse |
| `bash -n scripts/ta scripts/ta-assemble scripts/bootstrap.sh` | pass |
| `python3 -m py_compile scripts/*.py` | pass |
| `package.json`, `locale/*.json` parse as JSON | pass |
| `cordis.patch.yml` parses as YAML with one `insert` row | pass |
| no `CLAUDE_PLUGIN_ROOT`, `.claude/`, `$ARGUMENTS`, `argument-hint`, `allowed-tools` left in `skills/`, `roles/`, `scripts/` | pass |

## 2. `node test/smoke.js` — offline

**86 assertions, 0 failures.** Covers: plugin exports, the five tools and their
`presentCall`/`render` surface, all 16 skills/roles parse, every skill declares a
loadable `source` + `resourceBase`, no body above the pruner threshold, config
defaults and rejections, home/results precedence, frontmatter edge cases, every
`ta_data`/`ta_memory` argv shape, generated launchers, `ta_run` input validation,
broken-config degradation, and package hygiene.

## 3. `test/dsh-schema-check.mjs` — DSH's real tool validator

Run through `ELECTRON_RUN_AS_NODE=1 "/Applications/DeepSeek Harness.app/Contents/MacOS/DeepSeek Harness"`.

**20 assertions, 0 failures.** `assertSupportedJsonSchema` accepts every
`parameters` and `output.schema`; `validateJsonSchemaValue` accepts a live
`ta_doctor` value and synthetic `ta_run`/`ta_data`/`ta_memory`/`ta_assemble`
values; every `render` returns ContentBlocks.

## 4. `test/dsh-skill-check.mjs` — DSH's real skill registry

**41 assertions, 0 failures.** A real `SkillRegistry` (`@deepseek-ai/dsh-skill`)
is constructed on a real cordis `Context`; all 16 skills register, the catalog
lists 16, and `ctx.skills.get(name)` **loads** all 16 — this is the check that
catches the `source` requirement, which is not validated at registration time.

## 5. `DSH_TEST_TRADING_AGENTS_LIVE=1 node test/smoke.js` — live

**94 assertions, 0 failures**, against a bootstrapped venv at `/tmp/ta-e2e`:

- `ta_data today`, `snapshot NVDA`, `macro cpi` reach the real endpoints.
- `ta_run` creates the full `0_context`…`6_memory` tree, `run.env`, instrument context,
  portfolio context and `pending.json`; warnings are reported rather than thrown.
- `ta_assemble` builds `complete_report.md`, `complete_report.html`, `meta.json`;
  the HTML is self-contained (no external `script`/`link` URLs); `meta.json` records
  `rating: Hold`, `ticker: NVDA`, `engine: deepseek-harness`.

## 6. Python data layer (ported by script-porter, re-verified)

- First bootstrap creates the venv and installs
  `yfinance 0.2.66 / pandas 3.0.6 / requests 2.34.2 / Markdown 3.11.2`; `pip check`
  and import probes pass.
- `scripts/ta doctor` exits 0; `scripts/ta today`, `--version`, `ta-assemble --help`
  work; the argparse surface is unchanged from the source plugin.
- `--check` is side-effect free; concurrent bootstraps serialize on one lock; a failed
  install exits 1 with the log tail and removes the lock.
- The wrappers resolve symlinks correctly on macOS (`readlink -f` absent).

## 7. Real profile composition and activation

A throwaway profile was created under a temporary `DSH_HOME`:

```bash
DSH_HOME=<workspace>/.verify/home dsh ta-verify --from-default-profile web
# plugin copied into <profile>/node_modules, appended to dsh.profile.bundles
DSH_HOME=<workspace>/.verify/home dsh ta-verify --dump-config
```

- `--dump-config` composes without error and shows the inserted row:

```yaml
# == dsh-plugin-trading-agents
- id: trading-agents
  name: dsh-plugin-trading-agents
  config:
    outputLanguage: English
    holdingDays: 5
    autoBootstrap: true
    exposeRoleSkills: true
```

- A real boot of a `headless` profile containing the bundle reached the model call
  (failing only with `MISSING_CREDENTIAL`, as expected for a throwaway home) and left
  the plugin's activation side effects on disk:

```text
<home>/trading-agents/bin/ta             # exec bash <plugin>/scripts/ta "$@"
<home>/trading-agents/bin/ta-assemble
<home>/trading-agents/bin/env.sh
```

`env.sh` recorded the resolved home, the plugin root inside the profile's
`node_modules`, and the workspace-relative results root — proving `apply()` ran in a
real DSH profile, not only under the test harness.

## 8. Sandbox behaviour

DSH's default `workspace-write` policy confines the agent's `bash`, `read` and `write`
tools to the session workspace, and this was exercised directly:

- With the data home made read-only (`chmod -R a-w`), `"$TA" today` and
  `"$TA" snapshot NVDA --lookback 5` both succeed: the bootstrap's ready path is
  read-only (no directory, lock or log writes).
- Writes to `~/.dsh` from the sandboxed bash tool are refused (`Operation not
  permitted`), which is why the memory log's two write paths (`memory store`,
  `memory outcome`) go through the Host-process `ta_memory` tool instead.
- The run tree defaults to `<workspace>/.trading-agents/runs` (`$PWD` in bash, the
  session's working directory in `ta_run`) because every pipeline write goes through
  sandboxed tools.
- `PYTHONDONTWRITEBYTECODE=1` in the bridge and the wrappers keeps `__pycache__` out
  of the package directory.

## 9. macOS: do not build the venv from the app-bundled CPython

The first Desktop install picked the CPython shipped inside DeepSeek Harness.app
(`.../runtime/primary-runtime/dependencies/python/bin/python3`, 3.12.14) because
interpreter resolution preferred the bundled runtime. The bootstrap installed the
requirements, but importing numpy failed:

```text
dlopen(.../numpy/_core/_multiarray_umath.cpython-312-darwin.so ...)
code signature ... not valid for use in process: mapping process and mapped file
(non-platform) have different Team IDs
```

The app's interpreter is hardened-signed with library validation enabled, so it refuses
the ad-hoc-signed extension modules in prebuilt wheels. Fix: `resolvePython` now prefers
`python` config → `TRADING_AGENTS_PYTHON` → `python3` on `PATH`, and the bundled CPython is
no longer a default (only an explicit choice). The venv was rebuilt with the system
Python 3.13 (`yfinance/pandas 3.0.6/numpy 2.5.4 import ok`), and in-session `ta_data
snapshot NVDA` returned verified OHLCV plus indicators. The README now documents the
requirement and the trap.

## 10. Configurable output language (v1.3.0)

The plugin's `outputLanguage` config now drives the whole run, not only the Python child
environment:

- `lib/config.js` normalizes names and codes into canonical language names (`zh`, `中文`,
  `CN` → `Chinese`; `ja`, `日本語` → `Japanese`; `zh-tw` → `Traditional Chinese`; and so on),
  passes unknown values through, and rejects empty or over-64-character values.
- The plugin contributes `DSH_TRADING_AGENTS_OUTPUT_LANGUAGE` to every shell call through
  `dsh-shell-env`, so the pipeline's bash setup reads the configured language instead of
  defaulting to English.
- `ta_run` and `ta_assemble` default to the configured language; per-run `language=<value>`
  still overrides it, and each run records the language it used in `run.env` and `meta.json`.
- `ta_doctor` reports the configured language.

Verification: `node test/smoke.js` covers alias normalization, pass-through, rejection, the
shell-env contribution (declared variable + resolved value), the pipeline setup reading the
variable, and `ta_doctor` reporting it — 96 assertions, 0 failures; DSH's real validators
pass 20/20 (tools) and 41/41 (skills).

## 11. Agent-team mode (v1.1.0)

The pipeline was converted from anonymous `subagent` children to a DSH **agent team**: the
session is the Lead, each desk role is a durable named teammate, and a shared task board
records every stage with `write_scopes` and `blocked_by` dependencies.

Validated live in the desktop profile (which mounts
`@deepseek-ai/dsh-experimental-agent-team-profile`):

1. `team_task_create` produced `task-3` (write scope = the market report path).
2. `spawn_teammate` created `ta-market` (`context: fresh`) with the dispatch: role-load
   line + field block + task id + claim/complete instructions.
3. The teammate loaded `trading-agents-market-analyst` through the `skill` tool, called
   `team_task_get` then `team_task_update action=claim` (revision 1 → `in_progress`,
   `ownerName: ta-market`), wrote a 23.8 KB Chinese report, completed the task (revision 3),
   and sent the Lead its Return block.
4. `wait_agent` woke on each membership/task change; it returned the documented
   `noProgress` (`no-active-peer`) once the teammate went inactive.
5. `send_message` to the now-inactive `ta-market` resumed it for a reuse check, which
   answered with its name, role skill and completed task id and wrote nothing.

Design consequences recorded in the skill/README:

- Names are permanent and never reusable, so the roster is created once per session and
  every later run only sends messages (`list_agents` gates create vs reuse).
- The shipped `maxMembers` is 16 and the roster is 13 teammates + the Lead, so a session
  that already holds other teammates may need free slots or a raised limit; the skill
  states the roster and never invents run-specific names.
- `subagent` remains the documented fallback when the team tools are absent.

### Capacity finding (v1.2.0)

The first full team-mode run hit `Team member limit 8 reached`: the shipped
`@deepseek-ai/dsh-experimental-agent-team-profile` bundle mounts
`@deepseek-ai/dsh-experimental-agent-team` with `maxMembers: 8`, not the documentation
default of 16. The 13-role roster therefore cannot be created on a stock profile.

Handling, verified live:

- Raise the limit once in the profile's own `cordis.patch.yml` (user layer, applied after
  every bundle). HMR re-applied the row without restarting the app: a `spawn_teammate` that
  had just failed with the limit error succeeded immediately after the patch write.
- The skill now pre-checks `list_agents` for capacity and, when slots are short, reports the
  shortfall once and dispatches the un-spawnable roles through `subagent` so the run still
  completes. A limit error is documented as final, never retried.
- The README and `cordis.patch.yml` carry the exact override snippet.

### Full team-mode acceptance run (MSFT, 2026-10-21)

Executed end to end in the desktop profile after raising `maxMembers` to 24:

- **12/12 roles ran as named teammates**: `ta-market`, `ta-sentiment`, `ta-news`,
  `ta-fundamentals` in parallel; then `ta-bull` → `ta-bear` (debate), `ta-manager`,
  `ta-trader`, `ta-aggressive` → `ta-conservative` → `ta-neutral` (risk debate), `ta-pm`.
- **Task board was the spine**: tasks `task-4`…`task-15`, each with `write_scopes` and
  `blocked_by` on the previous stage; every task went `pending` → `in_progress` (ownerName =
  the teammate) → `completed`, and the dependency chain held the ordering without the Lead
  polling files.
- **No role failed and no absence marker was needed**; every output file is non-empty.
- **Artifacts**: `complete_report.md` 220 KB / `complete_report.html` 279 KB (no external
  scripts, stylesheets or images), `meta.json` with `missing_sections: []`,
  `plugin_version 1.2.0`, and one pending memory entry for MSFT.
- **Wall clock**: 23:18 → 23:34 for the full 12-role run (≈16 min), including a live
  `maxMembers` override mid-run.

### FRED outage handling (observed live)

During the MSFT acceptance run every FRED series returned `DATA_UNAVAILABLE`. The endpoint
was serving a **"Site Maintenance" HTML page with HTTP 200** rather than CSV, so the data
layer correctly reported the gap instead of estimating. The message now names that cause
(`FRED returned an HTML page instead of CSV … site maintenance or request throttling`)
rather than a bare `ParserError`, and the CLI still returns `DATA_UNAVAILABLE` — no value is
ever fabricated. A maintainer should re-run `ta macro cpi` after the outage to confirm.

## Known limits of this verification

- The two `dsh-*-check.mjs` scripts hard-code `/Applications/DeepSeek Harness.app` by
  default (override with `DSH_APP_ASAR`); they need the packaged Electron binary
  because the runtime lives inside `app.asar`.
- A full pipeline run (13 subagents + model calls) was not executed here: it needs
  model credentials and a traded symbol. Its per-role prompts were ported byte-for-byte
  where behaviour lives, and the data, run-tree, memory and report stages were each
  exercised end to end.

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

## Known limits of this verification

- The two `dsh-*-check.mjs` scripts hard-code `/Applications/DeepSeek Harness.app` by
  default (override with `DSH_APP_ASAR`); they need the packaged Electron binary
  because the runtime lives inside `app.asar`.
- A full pipeline run (13 subagents + model calls) was not executed here: it needs
  model credentials and a traded symbol. Its per-role prompts were ported byte-for-byte
  where behaviour lives, and the data, run-tree, memory and report stages were each
  exercised end to end.

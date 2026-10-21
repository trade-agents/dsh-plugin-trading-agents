# Script port: Claude Code plugin -> DSH plugin

Scope of this port: `scripts/` and `requirements.txt` only. Everything else in
the source plugin (`agents/`, `commands/`, `hooks/`, `skills/`, README, ...) is
owned by other ports. The source directory was treated as read-only and was
never modified. `scripts/__pycache__/` was not copied.

## Deliberate deviations from the source

- **`scripts/ta`, `scripts/ta-assemble`**
  - Default data home changed from `~/.claude/trading-agents` to
    `$DSH_HOME/trading-agents`, falling back to `~/.dsh/trading-agents` when
    `DSH_HOME` is unset or empty. `TRADING_AGENTS_HOME` still overrides it.
    Why: the plugin now runs inside DSH, not Claude Code.
  - Added a `resolve_self()` symlink resolver (`readlink -f` when supported,
    with a portable bash loop fallback because macOS `readlink` has no `-f`)
    and `cd -P` for `HERE`/`ROOT`. Why: the DSH plugin may expose these entry
    points through symlinks; the original wrappers found the wrong repo root
    when invoked through one.
  - Executable bits preserved; CLI arguments are passed through unchanged.

- **`scripts/bootstrap.sh`**
  - Same data-home change (`TRADING_AGENTS_HOME` > `$DSH_HOME/trading-agents` >
    `~/.dsh/trading-agents`). `requirements.txt` hash cache, `pip check`,
    import verification, log file (`$DATA/bootstrap.log`), messages and exit
    codes are otherwise unchanged.
  - Added `--check` and `TRADING_AGENTS_BOOTSTRAP_CHECK=1`. Check mode prints
    a short readiness report on stdout and exits 0 when ready / 1 when not
    ready; it never creates the data home or the venv. Added only because the
    DSH doctor tool needs a side-effect-free readiness probe.
  - Added a `mkdir`-based lock at `$DATA/.bootstrap.lock` around venv creation
    and dependency installation, released by an `EXIT` trap. A lock older than
    900 s is treated as stale and removed; waiting for a live lock is capped at
    900 s. Why: DSH can trigger bootstrap from two entry points concurrently;
    the original code could race two `python3 -m venv` / `pip install` runs.
  - Added the same `resolve_self()` symlink resolution as the wrappers. Why:
    the script is also an entry point and must find `requirements.txt` when
    reached through a symlink.
  - Unknown arguments are rejected with exit code 2 (the source ignored all
    arguments; no supported invocation is affected).

- **`scripts/ta_lib.py`**
  - Added `default_data_home()` (`$DSH_HOME/trading-agents`, else
    `~/.dsh/trading-agents`) and made `data_home()` use it when
    `TRADING_AGENTS_HOME` is unset/empty. `memory_path()` keeps deriving from
    `data_home()`, so the memory log follows automatically.
    Why: Python-side home resolution must match the shell wrappers.
  - Environment variable names (`TRADING_AGENTS_HOME`,
    `TRADING_AGENTS_RESULTS_DIR`, `TRADING_AGENTS_OUTPUT_LANGUAGE`,
    `TRADING_AGENTS_HOLDING_DAYS`, `TRADING_AGENTS_BENCHMARK`) are unchanged.

- **`scripts/ta_data.py`**
  - `_plugin_version()` now reads the DSH bundle manifest
    `<repo>/package.json` (`version`) instead of
    `<repo>/.claude-plugin/plugin.json`, keeping the `0.0.0` fallback on any
    read/parse error. No other CLI behavior changed; the argparse surface is
    byte-for-byte the same command set.

- **`scripts/assemble_report.py`**
  - `plugin_version()` now reads `<repo>/package.json`. Its pre-existing
    `"unknown"` fallback was kept (the `0.0.0` fallback requirement applied to
    `ta_data.py`). Report sections, artifact names (`complete_report.md`,
    `complete_report.html`, `meta.json`), ordering and the deterministic
    layout are unchanged.
  - Still deliberately sets `meta.json` `"engine": "claude-code"` and the
    HTML footer "Claude Code plugin": the port brief scoped this file to the
    plugin-version lookup only, and changing those values would alter existing
    report output. Runtime paths no longer depend on `.claude`.

- **`requirements.txt`** -- copied byte-identical.

- **`.gitignore`** -- copied byte-identical; it already contained
  `__pycache__/` and `*.pyc` (plus `.DS_Store`, `.venv/`, `bootstrap.log`).

## Known stale Claude references (intentional, no runtime effect)

`ta_data.py` / `assemble_report.py` module docstrings still mention
`${CLAUDE_PLUGIN_ROOT}` and "Claude Code plugin". They are comments only; the
port brief asked to keep everything else byte-identical for auditability.
They can be reworded in a later cosmetic pass without touching behavior.

## Home-resolution summary

| Condition | Data home |
| --- | --- |
| `TRADING_AGENTS_HOME` set (non-empty) | `$TRADING_AGENTS_HOME` |
| else `DSH_HOME` set (non-empty) | `$DSH_HOME/trading-agents` |
| else | `~/.dsh/trading-agents` |

Identical in `scripts/ta`, `scripts/ta-assemble`, `scripts/bootstrap.sh`, and
`ta_lib.data_home()`.

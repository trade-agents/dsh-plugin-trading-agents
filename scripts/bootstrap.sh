#!/usr/bin/env bash
# Create/update the plugin's private Python environment. No project venv is used.
set -euo pipefail

# --check reports readiness only; it never creates the venv or the data home.
CHECK="${TRADING_AGENTS_BOOTSTRAP_CHECK:-0}"
for arg in "$@"; do
  case "$arg" in
    --check) CHECK=1 ;;
    *)
      echo "ERROR: unknown argument: $arg (supported: --check)" >&2
      exit 2
      ;;
  esac
done

# Resolve this script through symlinks so it also works when linked into a DSH
# bin directory. macOS readlink has no -f, so try it only when supported and
# fall back to a portable bash loop.
resolve_self() {
  local target="${BASH_SOURCE[0]}" dir link
  if command -v readlink >/dev/null 2>&1 && readlink -f "$target" >/dev/null 2>&1; then
    readlink -f "$target"
    return 0
  fi
  while [ -L "$target" ]; do
    dir="$(cd -P "$(dirname "$target")" && pwd)"
    link="$(readlink "$target")"
    case "$link" in
      /*) target="$link" ;;
      *) target="$dir/$link" ;;
    esac
  done
  printf '%s\n' "$(cd -P "$(dirname "$target")" && pwd)/$(basename "$target")"
}

SELF="$(resolve_self)"
HERE="$(cd -P "$(dirname "$SELF")" && pwd)"
ROOT="$(cd -P "$HERE/.." && pwd)"
DSH_HOME="${DSH_HOME:-$HOME/.dsh}"
DATA="${TRADING_AGENTS_HOME:-$DSH_HOME/trading-agents}"
VENV="$DATA/venv"
REQ="$ROOT/requirements.txt"
# Interpreter used to create the venv; the DSH plugin sets this from its
# `python` config so an operator can point at the CPython bundled with DSH.
PYTHON="${TRADING_AGENTS_PYTHON:-python3}"
LOG="$DATA/bootstrap.log"
LOCK="$DATA/.bootstrap.lock"

# A DSH plugin may trigger bootstrap from more than one place at the same time.
# mkdir serialises venv creation; the lock is only removed as stale after a
# crashed process, never merely because an install is slow.
LOCK_STALE_SECONDS=900
LOCK_WAIT_SECONDS=900

hash_req() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$1" | awk '{print $1}'
  else
    "$PYTHON" -c 'import hashlib,sys; print(hashlib.sha256(open(sys.argv[1], "rb").read()).hexdigest())' "$1"
  fi
}

python_ok() {
  "$PYTHON" -c 'import sys; raise SystemExit(0 if sys.version_info >= (3, 10) else 1)' >/dev/null 2>&1
}

mtime() {
  # GNU stat first (Linux), then BSD stat (macOS). If neither works, report
  # "now" so an unverifiable lock is never treated as stale and stolen.
  stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null || date +%s
}

check_mode() {
  local ready=1 current=""
  printf 'trading-agents bootstrap check\n'
  printf 'data home: %s\n' "$DATA"

  if ! command -v "$PYTHON" >/dev/null 2>&1; then
    printf 'python3: missing (3.10+ required)\n'
    ready=0
  elif python_ok; then
    printf 'python3: %s (ok)\n' "$("$PYTHON" -c 'import sys; print(sys.version.split()[0])')"
  else
    printf 'python3: %s (3.10+ required)\n' \
      "$("$PYTHON" -c 'import sys; print(sys.version.split()[0])' 2>/dev/null || echo unknown)"
    ready=0
  fi

  if [ -f "$REQ" ]; then
    printf 'requirements: %s\n' "$REQ"
  else
    printf 'requirements: missing (%s)\n' "$REQ"
    ready=0
  fi

  if [ -x "$VENV/bin/python" ]; then
    printf 'venv: %s\n' "$VENV"
    if "$VENV/bin/python" -m pip --version >/dev/null 2>&1; then
      printf 'pip: ok\n'
    else
      printf 'pip: missing\n'
      ready=0
    fi
    current="$(hash_req "$REQ" 2>/dev/null || true)"
    if [ -f "$REQ" ] && [ "$(cat "$VENV/.req-hash" 2>/dev/null || true)" = "$current" ]; then
      printf 'requirements hash: current\n'
    else
      printf 'requirements hash: stale\n'
      ready=0
    fi
    if "$VENV/bin/python" -m pip check >/dev/null 2>&1; then
      printf 'pip check: ok\n'
    else
      printf 'pip check: failed\n'
      ready=0
    fi
    if "$VENV/bin/python" -c 'import yfinance, pandas, requests, markdown' >/dev/null 2>&1; then
      printf 'imports: ok\n'
    else
      printf 'imports: failed\n'
      ready=0
    fi
  else
    printf 'venv: missing (%s)\n' "$VENV"
    ready=0
  fi

  if [ "$ready" -eq 1 ]; then
    printf 'status: ready\n'
    return 0
  fi
  printf 'status: not ready (run scripts/bootstrap.sh to install)\n'
  return 1
}

acquire_lock() {
  local waited=0 now age
  while ! mkdir "$LOCK" 2>/dev/null; do
    now="$(date +%s)"
    age=$(( now - $(mtime "$LOCK") ))
    if [ "$age" -gt "$LOCK_STALE_SECONDS" ]; then
      echo "trading-agents: removing stale bootstrap lock at $LOCK" >&2
      rm -rf -- "$LOCK"
      continue
    fi
    if [ "$waited" -ge "$LOCK_WAIT_SECONDS" ]; then
      echo "ERROR: timed out waiting for another bootstrap to finish (lock: $LOCK)." >&2
      exit 1
    fi
    if [ "$waited" -eq 0 ]; then
      echo "trading-agents: another bootstrap is running; waiting..." >&2
    fi
    sleep 1
    waited=$((waited + 1))
  done
  trap 'rm -rf -- "$LOCK"' EXIT
}

if [ "$CHECK" = "1" ]; then
  if check_mode; then
    exit 0
  fi
  exit 1
fi

if ! command -v "$PYTHON" >/dev/null 2>&1; then
  echo "ERROR: $PYTHON not found. Install Python 3.10+ or set the plugin's \`python\` config to the CPython bundled with DSH." >&2
  exit 1
fi

if ! python_ok; then
  echo "ERROR: Python 3.10+ is required; found $("$PYTHON" -c 'import sys; print(sys.version.split()[0])')." >&2
  exit 1
fi

if [ ! -f "$REQ" ]; then
  echo "ERROR: requirements.txt not found at $REQ" >&2
  exit 1
fi

# Fast path: nothing to do and nothing to write. A DSH session may sandbox the
# agent's bash tool to the workspace, where this data home is read-only; a ready
# environment must therefore be verifiable without creating a directory, a lock
# or a log line, or every skill that calls "$TRADING_AGENTS_HOME/bin/ta" fails.
if [ -x "$VENV/bin/python" ] && [ -f "$VENV/.req-hash" ] \
   && [ "$(cat "$VENV/.req-hash" 2>/dev/null || true)" = "$(hash_req "$REQ")" ]; then
  exit 0
fi

mkdir -p "$DATA"

acquire_lock

if [ ! -x "$VENV/bin/python" ]; then
  echo "trading-agents: creating Python environment at $VENV (first run)" >&2
  if ! "$PYTHON" -m venv "$VENV" >>"$LOG" 2>&1; then
    echo "ERROR: python3 -m venv failed. See $LOG" >&2
    tail -20 "$LOG" >&2 || true
    exit 1
  fi
fi

if ! "$VENV/bin/python" -m pip --version >/dev/null 2>&1; then
  echo "ERROR: pip is missing from $VENV. Install the python3-venv/pip package and retry." >&2
  exit 1
fi

CURRENT="$(hash_req "$REQ")"
if [ "$(cat "$VENV/.req-hash" 2>/dev/null || true)" != "$CURRENT" ]; then
  echo "trading-agents: installing Python dependencies (first run or update)" >&2
  "$VENV/bin/python" -m pip install --upgrade pip >>"$LOG" 2>&1 || true
  if ! "$VENV/bin/python" -m pip install -r "$REQ" >>"$LOG" 2>&1; then
    echo "ERROR: dependency install failed. See $LOG" >&2
    tail -20 "$LOG" >&2 || true
    exit 1
  fi
  if ! "$VENV/bin/python" -m pip check >>"$LOG" 2>&1; then
    echo "ERROR: installed dependencies have conflicts. See $LOG" >&2
    tail -20 "$LOG" >&2 || true
    exit 1
  fi
  if ! "$VENV/bin/python" -c 'import yfinance, pandas, requests, markdown' >>"$LOG" 2>&1; then
    echo "ERROR: installed dependencies cannot be imported. See $LOG" >&2
    tail -20 "$LOG" >&2 || true
    exit 1
  fi
  printf '%s\n' "$CURRENT" > "$VENV/.req-hash"
fi

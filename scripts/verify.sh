#!/usr/bin/env bash
# One command: clean clone -> build -> full test matrix.
#
# Proves the repo works from nothing but git, cargo, node, and python --
# not "works on my machine". By default this clones a fresh copy into a
# temp directory and builds/tests THAT, so nothing in your existing working
# tree (uncommitted changes, stale build artifacts, local-only fixes) can
# make the result look better than what a judge cloning the repo actually
# gets.
#
# REAL COLD-START RUNTIME: expect roughly 10-20 minutes end-to-end with
# no warm caches (network speed and CPU dependent) -- the Rust release
# build alone is the dominant cost, measured at ~7-8 minutes from a
# completely empty target/ and a warm cargo registry cache (a first-ever
# `cargo build` on the machine, which also has to download every crate,
# will take longer still). This is NOT a hang: each step prints a
# heartbeat line periodically, and "Compiling <crate>" lines from cargo
# itself are the normal sign of life during the long stretch. A silent
# terminal for a minute or two at a time during the Rust build is normal.
#
# Usage:
#   ./scripts/verify.sh                 # clean clone of the current branch's HEAD commit
#   ./scripts/verify.sh --ref <branch>  # clean clone of a specific branch/tag/commit
#   ./scripts/verify.sh --in-place      # skip cloning, test the current working tree instead
#                                       # (faster, but not a from-nothing proof)
#   ./scripts/verify.sh --skip-python   # skip the channel-simulator Python matrix
#                                       # (skips the pip install step; useful with no network)
#
# Exit code 0 iff every step passed. On failure, the temp clone (if any) is
# left in place and its path is printed, so you can inspect what broke.
#
# NOTE on `npm test`: it spawns several worker processes in parallel. If
# something else on the machine is also compiling at that exact moment
# (e.g. you ran this alongside another build), vitest's worker pool can
# time out waiting for a worker to start and report a spurious failure --
# a resource-contention flake, not a real test failure. Re-running alone
# resolves it. This script runs its own steps sequentially, so it should
# not trigger this on its own; it's only a risk if you're doing something
# else heavy on the same machine at the same time.

set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."
REPO_ROOT="$(pwd)"
REPO_URL="$(git remote get-url origin 2>/dev/null || echo "$REPO_ROOT")"
REF="$(git rev-parse HEAD)"
IN_PLACE=0
SKIP_PYTHON=0

# Force a predictable build location regardless of the caller's own shell
# environment -- a stray CARGO_TARGET_DIR (some Rust setups export one
# globally to share build caches across projects) would otherwise put the
# compiled binary somewhere other than <clone>/src-tauri/target, which is
# exactly where the channel_simulator Python scripts below expect to find
# it, and where they'd silently fail to find it instead.
unset CARGO_TARGET_DIR

while [ $# -gt 0 ]; do
  case "$1" in
    --ref) REF="$2"; shift 2 ;;
    --in-place) IN_PLACE=1; shift ;;
    --skip-python) SKIP_PYTHON=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done

STEPS_PASSED=()
STEPS_FAILED=()
STEP_NUM=0
RUN_START=$(date +%s)

run_step() {
  local name="$1"; shift
  STEP_NUM=$((STEP_NUM + 1))
  local start_ts
  start_ts=$(date +%s)
  echo ""
  echo "=== [step $STEP_NUM, $(date '+%H:%M:%S')] $name ==="
  echo "+ $*"

  # Heartbeat so a quiet command (pip/npm with little output of their own)
  # doesn't look hung during a long step -- printed every 20s until the
  # command finishes.
  ( while true; do
      sleep 20
      echo "    ... still running: $name ($(( $(date +%s) - start_ts ))s elapsed)"
    done ) &
  local hb_pid=$!
  disown "$hb_pid" 2>/dev/null

  "$@"
  local status=$?

  kill "$hb_pid" 2>/dev/null
  wait "$hb_pid" 2>/dev/null

  local elapsed=$(( $(date +%s) - start_ts ))
  if [ "$status" -eq 0 ]; then
    STEPS_PASSED+=("$name (${elapsed}s)")
    echo "=== [step $STEP_NUM] PASSED in ${elapsed}s: $name ==="
  else
    STEPS_FAILED+=("$name (${elapsed}s)")
    echo ">>> [step $STEP_NUM] FAILED after ${elapsed}s: $name" >&2
  fi
}

if [ "$IN_PLACE" -eq 1 ]; then
  WORKDIR="$REPO_ROOT"
  echo "Testing in place: $WORKDIR (not a clean-clone proof)"
else
  WORKDIR="$(mktemp -d)"
  echo "Clean clone of $REPO_URL @ $REF into: $WORKDIR"
  if ! git clone --quiet "$REPO_URL" "$WORKDIR"; then
    echo "clone failed" >&2
    exit 1
  fi
  if ! git -C "$WORKDIR" checkout --quiet "$REF"; then
    echo "checkout of ref '$REF' failed" >&2
    exit 1
  fi
fi

cd "$WORKDIR"

run_step "Rust: release build (stegstr-cli)" \
  cargo build --release --bin stegstr-cli --manifest-path src-tauri/Cargo.toml

run_step "Rust: cargo test --release" \
  cargo test --release --manifest-path src-tauri/Cargo.toml

run_step "Rust: cargo clippy -- -D warnings" \
  cargo clippy --release --all-targets --manifest-path src-tauri/Cargo.toml -- -D warnings

if command -v npm >/dev/null 2>&1; then
  run_step "Frontend: npm install" npm install --no-audit --no-fund
  run_step "Frontend: npm test" npm test
else
  echo ""
  echo "=== Frontend tests skipped: npm not found ==="
  STEPS_FAILED+=("Frontend: npm not found")
fi

if [ "$SKIP_PYTHON" -eq 0 ]; then
  if command -v python >/dev/null 2>&1; then
    PY=python
  elif command -v python3 >/dev/null 2>&1; then
    PY=python3
  else
    PY=""
  fi

  if [ -n "$PY" ]; then
    pushd channel_simulator >/dev/null
    run_step "Python: pip install -r requirements.txt" \
      "$PY" -m pip install -r requirements.txt
    run_step "Python: generate realistic covers" \
      "$PY" gen_realistic_covers.py
    run_step "Python: generate extended covers" \
      "$PY" gen_extended_covers.py
    run_step "Python: run_matrix_rust_cli.py (45/45 expected)" \
      "$PY" run_matrix_rust_cli.py
    run_step "Python: run_matrix_realistic.py (prototype matrix)" \
      "$PY" run_matrix_realistic.py
    popd >/dev/null
  else
    echo ""
    echo "=== Python matrix skipped: no python/python3 found ==="
    STEPS_FAILED+=("Python: interpreter not found")
  fi
else
  echo ""
  echo "=== Python matrix skipped: --skip-python ==="
fi

TOTAL_ELAPSED=$(( $(date +%s) - RUN_START ))
echo ""
echo "==================== SUMMARY ===================="
for s in "${STEPS_PASSED[@]:-}"; do
  [ -n "$s" ] && echo "PASS  $s"
done
for s in "${STEPS_FAILED[@]:-}"; do
  [ -n "$s" ] && echo "FAIL  $s"
done
echo "${#STEPS_PASSED[@]} passed, ${#STEPS_FAILED[@]} failed -- total ${TOTAL_ELAPSED}s"

if [ "$IN_PLACE" -eq 0 ]; then
  if [ "${#STEPS_FAILED[@]}" -eq 0 ]; then
    rm -rf "$WORKDIR"
  else
    echo "Clean clone left at: $WORKDIR (for inspection)"
  fi
fi

[ "${#STEPS_FAILED[@]}" -eq 0 ]

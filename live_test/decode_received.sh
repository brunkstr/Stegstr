#!/usr/bin/env bash
# Decode every image in live_test/received/ with the current release CLI
# and compare against live_test/PAYLOAD.txt. Prints PASS/FAIL per file.
#
# Usage (from repo root, Git Bash):
#   ./live_test/decode_received.sh
#
# Put whatever comes back from WhatsApp/Instagram/Telegram (downloaded,
# not screenshotted) into live_test/received/ before running this.
#
# Files with "control" in the name are treated as control files (the
# untouched, no-payload originals used for the WhatsApp control test) --
# finding no payload in one is the correct, expected outcome, not a
# failure, so it's reported separately rather than as a red FAIL.

set -u
cd "$(dirname "${BASH_SOURCE[0]}")"

CLI="../src-tauri/target/release/stegstr-cli.exe"
PAYLOAD_FILE="PAYLOAD.txt"
RECEIVED_DIR="received"

if [ ! -x "$CLI" ]; then
  echo "error: CLI binary not found at $CLI -- build it first (cargo build --release --bin stegstr-cli)" >&2
  exit 1
fi
if [ ! -f "$PAYLOAD_FILE" ]; then
  echo "error: $PAYLOAD_FILE not found" >&2
  exit 1
fi

EXPECTED="$(cat "$PAYLOAD_FILE")"
shopt -s nullglob
files=("$RECEIVED_DIR"/*)
shopt -u nullglob

if [ ${#files[@]} -eq 0 ]; then
  echo "no files in $RECEIVED_DIR/ yet -- nothing to check"
  exit 0
fi

total=0
passed=0
control=0
for f in "${files[@]}"; do
  [ -f "$f" ] || continue
  name="$(basename "$f")"
  is_control=0
  case "$name" in
    *[Cc]ontrol*) is_control=1 ;;
  esac

  raw="$("$CLI" decode "$f" 2>&1)"
  status=$?

  if [ $status -ne 0 ]; then
    if [ $is_control -eq 1 ]; then
      echo "OK    $name  (control -- no payload expected)"
      control=$((control + 1))
    else
      total=$((total + 1))
      echo "FAIL  $name  (decode failed: $raw)"
    fi
    continue
  fi

  # decode prints either raw text/JSON, or base64:<data> when the payload
  # isn't valid JSON (which a plain test string like ours is not).
  if [[ "$raw" == base64:* ]]; then
    decoded="$(printf '%s' "${raw#base64:}" | base64 -d 2>/dev/null)"
  else
    decoded="$raw"
  fi

  if [ $is_control -eq 1 ]; then
    # A control file that DOES decode to something is worth a human's
    # attention -- it means this file isn't actually payload-free, which
    # would undermine the control test's own premise.
    echo "NOTE  $name  (control file, but a payload WAS found: $decoded)"
    control=$((control + 1))
    continue
  fi

  total=$((total + 1))
  if [ "$decoded" = "$EXPECTED" ]; then
    echo "PASS  $name"
    passed=$((passed + 1))
  else
    echo "FAIL  $name  (got: $decoded)"
  fi
done

echo "---"
if [ "$control" -gt 0 ]; then
  echo "$passed/$total passed, $control control file(s) OK"
else
  echo "$passed/$total passed"
fi

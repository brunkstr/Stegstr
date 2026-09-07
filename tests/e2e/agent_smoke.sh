#!/usr/bin/env bash
# Headless, no-human smoke test for the whole AI-agent-operability flow:
# post -> embed --json -> decode --json -> detect --json -> calibrate --json
# -> mcp (starts, speaks MCP over stdio, lists exactly the 4 documented
# tools, shuts down cleanly) -> the 4 documented non-zero exit codes,
# each actually triggered, not just asserted from memory.
#
# This exists because "here's an image and a message, zero human input" is
# a specific claim (skill/stegstr/SKILL.md, README.md) -- this script is
# what actually walks that path end to end and fails loudly if it can't.
#
# Usage (from repo root): ./tests/e2e/agent_smoke.sh
# Requires: the CLI built (cargo build --release --bin stegstr-cli), python
# (already a dependency of this repo's own scripts) for JSON field checks.

set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

CLI="src-tauri/target/release/stegstr-cli"
[ -f "${CLI}.exe" ] && CLI="${CLI}.exe"

WORKDIR="$(mktemp -d 2>/dev/null || echo "${TMPDIR:-/tmp}/stegstr_agent_smoke_$$")"
mkdir -p "$WORKDIR"
trap 'rm -rf "$WORKDIR"' EXIT

PASS=0
FAIL=0

ok()   { PASS=$((PASS + 1)); echo "  PASS: $1"; }
bad()  { FAIL=$((FAIL + 1)); echo "  FAIL: $1"; }
step() { echo ""; echo "=== $1 ==="; }

# Extract a field from JSON on stdin via python (no jq dependency, python is
# already required by channel_simulator/run_matrix_realistic.py).
jfield() {
  python -c "import json,sys; v=json.load(sys.stdin); print(v$1)" 2>/dev/null
}

[ -f "$CLI" ] || { echo "CLI not found at $CLI -- build it first: cargo build --release --bin stegstr-cli"; exit 1; }

step "post: create a bundle with zero flags"
POST_JSON="$("$CLI" post "agent smoke test note" --json)"
[ $? -eq 0 ] && [ "$(echo "$POST_JSON" | jfield "['ok']")" = "True" ] && ok "post --json exits 0 and ok:true" || bad "post --json"
# post --json's own output is {"ok":true,"bundle":{...},"output_path":null} --
# embed needs just the bundle, not that whole wrapper. Unwrapping it here is
# exactly the step an agent must not skip.
BUNDLE_JSON="$(echo "$POST_JSON" | python -c "import json,sys; print(json.dumps(json.load(sys.stdin)['bundle']))")"

step "embed: hide the bundle in a real cover photo, robust encoder, encrypted"
COVER="channel_simulator/covers/textured.jpg"
OUT="$WORKDIR/agent_out.jpg"
EMBED_JSON="$("$CLI" embed "$COVER" -o "$OUT" --robust --payload "$BUNDLE_JSON" --encrypt --json)"
EMBED_STATUS=$?
[ $EMBED_STATUS -eq 0 ] && [ -f "$OUT" ] && [ "$(echo "$EMBED_JSON" | jfield "['encoder']")" = "qim" ] && ok "embed --robust --json produces a qim-encoded file" || bad "embed --robust --json"

step "decode: agent doesn't know the encoder, doesn't decrypt yet"
DECODE_JSON="$("$CLI" decode "$OUT" --json)"
[ $? -eq 0 ] && [ "$(echo "$DECODE_JSON" | jfield "['encoder']")" = "qim" ] && [ "$(echo "$DECODE_JSON" | jfield "['payload_encoding']")" = "base64" ] && ok "decode --json auto-detects qim, reports base64 for encrypted bytes" || bad "decode --json"

step "detect: decode + decrypt + parse the bundle in one step"
DETECT_JSON="$("$CLI" detect "$OUT" --json)"
DETECT_STATUS=$?
NOTE_CONTENT="$(echo "$DETECT_JSON" | jfield "['bundle']['events'][0]['content']")"
[ $DETECT_STATUS -eq 0 ] && [[ "$NOTE_CONTENT" == "agent smoke test note"* ]] && ok "detect --json recovers the original note content" || bad "detect --json (got: $NOTE_CONTENT)"

step "calibrate: fingerprint a real captured platform round trip"
if [ -f "live_test/send_instagram.jpg" ] && [ -f "live_test/received/received_instagram.jpg" ]; then
  CAL_JSON="$("$CLI" calibrate --sent live_test/send_instagram.jpg --received live_test/received/received_instagram.jpg --profiles-out "$WORKDIR/channel_profiles.toml" --json)"
  CAL_STATUS=$?
  [ $CAL_STATUS -eq 0 ] && [ -f "$WORKDIR/channel_profiles.toml" ] && [ "$(echo "$CAL_JSON" | jfield "['ok']")" = "True" ] && ok "calibrate --json writes a profile from real captured evidence" || bad "calibrate --json"
else
  echo "  SKIP: live_test/ evidence pair not present"
fi

step "mcp: server starts over stdio, lists exactly embed/decode/detect/calibrate, shuts down"
MCP_REQUESTS='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"agent_smoke","version":"0"}}}
{"jsonrpc":"2.0","method":"notifications/initialized"}
{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}'
# The trailing `sleep` keeps stdin's write end open a moment after the
# requests are written -- closing it immediately (plain `printf | mcp`) races
# the server's response against stdin EOF-triggered shutdown, and can drop
# the last response(s) before they're flushed. Confirmed by hand: without
# the sleep this is flaky; with it, reliable.
MCP_OUT="$( ( printf '%s\n' "$MCP_REQUESTS"; sleep 1 ) | timeout 10 "$CLI" mcp 2>"$WORKDIR/mcp_stderr.log" || true)"
TOOL_NAMES="$(echo "$MCP_OUT" | python -c "
import json,sys
names = []
for line in sys.stdin:
    line = line.strip()
    if not line:
        continue
    try:
        msg = json.loads(line)
    except json.JSONDecodeError:
        continue
    if msg.get('id') == 2 and 'result' in msg:
        names = sorted(t['name'] for t in msg['result'].get('tools', []))
print(','.join(names))
" 2>/dev/null)"
[ "$TOOL_NAMES" = "calibrate,decode,detect,embed" ] && ok "mcp tools/list reports exactly embed,decode,detect,calibrate" || bad "mcp tools/list (got: '$TOOL_NAMES')"

step "documented exit codes: each one actually triggered, not assumed"

"$CLI" decode "$COVER" --json >/dev/null 2>&1
[ $? -eq 3 ] && ok "no payload found -> exit 3" || bad "no payload found -> exit 3"

echo "garbage, not an image" > "$WORKDIR/garbage.png"
"$CLI" decode "$WORKDIR/garbage.png" --json >/dev/null 2>&1
[ $? -eq 5 ] && ok "malformed input -> exit 5" || bad "malformed input -> exit 5"

PLAIN_OUT="$WORKDIR/plain.png"
"$CLI" embed "$COVER" -o "$PLAIN_OUT" --payload "not encrypted" --json >/dev/null 2>&1
"$CLI" decode "$PLAIN_OUT" --decrypt --json >/dev/null 2>&1
[ $? -eq 4 ] && ok "decryption failure -> exit 4" || bad "decryption failure -> exit 4"

# Native Windows Python can't resolve an MSYS-style /tmp/... path (Git Bash
# and the system Python are different runtimes) -- translate via cygpath
# when present; elsewhere (Linux/macOS) $WORKDIR is already native.
PY_WORKDIR="$WORKDIR"
command -v cygpath >/dev/null 2>&1 && PY_WORKDIR="$(cygpath -w "$WORKDIR")"
python -c "
from PIL import Image
import os
Image.new('RGB', (32, 32), (100, 100, 100)).save(os.path.join(r'$PY_WORKDIR', 'tiny_cover.jpg'), quality=90)
" 2>/dev/null
if [ -f "$WORKDIR/tiny_cover.jpg" ]; then
  # Written to a file, not passed inline: Windows caps a single command-line
  # argument well under 50,000 bytes (see BUGS.md's --payload-base64 @file
  # entry) -- inline would fail for an unrelated reason before ever
  # reaching the capacity check this is actually testing.
  python -c "print('x' * 50000)" > "$WORKDIR/huge_payload.txt"
  "$CLI" embed "$WORKDIR/tiny_cover.jpg" -o "$WORKDIR/tiny_out.jpg" --robust --payload "@$WORKDIR/huge_payload.txt" --json >/dev/null 2>&1
  [ $? -eq 2 ] && ok "capacity exceeded -> exit 2" || bad "capacity exceeded -> exit 2"
else
  echo "  SKIP: PIL/Pillow not available to generate a tiny cover for the capacity test"
fi

step "Summary"
echo "  $PASS passed, $FAIL failed"
[ "$FAIL" -eq 0 ]

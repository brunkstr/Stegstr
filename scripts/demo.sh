#!/usr/bin/env bash
# Deterministic demo script for filming: fixed cover, fixed payload, fixed
# paths. Every command is printed before it runs, so nothing needs to be
# typed live on camera and no take is wasted re-typing a mistake.
#
# Usage (from repo root):
#   ./scripts/demo.sh            # embed + decode round trip only
#   ./scripts/demo.sh --matrix   # also runs the reproducible 32-combination
#                                 # Python channel matrix (shot 6 in the video brief)
#
# This does NOT perform the live social-platform upload/download step
# (shot 4, "the money shot") -- that's inherently manual, done by hand in
# one unbroken take per STEGSTR_VIDEO_ENTRY_BRIEF.md's credibility rule.
# This script prepares everything up to and after that point so the only
# thing left to do live is the actual send/receive.

set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

CLI="src-tauri/target/release/stegstr-cli"
[ -f "${CLI}.exe" ] && CLI="${CLI}.exe"

COVER="channel_simulator/covers/textured.jpg"
OUT="demo_out.jpg"
PAYLOAD="Stegstr demo payload -- survives WhatsApp, Instagram, Telegram"

say() { echo ""; echo "# $*"; }
run() { echo "+ $*"; "$@"; }

say "Fresh build (skip if already built)"
run cargo build --release --bin stegstr-cli --manifest-path src-tauri/Cargo.toml

say "Embed a fixed payload into a fixed cover with the robust (JPEG/QIM) encoder"
run "$CLI" embed "$COVER" -o "$OUT" --robust --payload "$PAYLOAD"

say "Decode it straight back (pre-send sanity check)"
run "$CLI" decode "$OUT"
echo ""
echo "(the payload above isn't valid JSON, so decode wraps it as base64:<data> --"
echo " that's expected. base64 -d confirms the message underneath:)"
echo "+ $CLI decode $OUT | sed 's/^base64://' | base64 -d"
"$CLI" decode "$OUT" | sed 's/^base64://' | base64 -d
echo ""

say "$OUT is ready to send through a real platform by hand."
echo "After downloading the received file back, decode it the same way:"
echo "  $CLI decode <received-file>"
echo "Expect: base64:<data>, which decodes to exactly: $PAYLOAD"

if [ "${1:-}" = "--matrix" ]; then
  say "Reproducible channel matrix (9 cover types x 5 simulated platforms)"
  PY=python
  command -v python >/dev/null 2>&1 || PY=python3
  ( cd channel_simulator && run "$PY" run_matrix_realistic.py )
fi

say "Done. Clean up the demo output? rm ${OUT}"

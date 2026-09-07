#!/usr/bin/env bash
# Two-mode helper for filming shot 4 (the live Instagram round trip) --
# nothing to type on camera, output kept minimal and readable at a
# distance. See STEGSTR_VIDEO_ENTRY_BRIEF.md for the shot itself; this
# only prepares the before/after, the actual send/download is manual.
#
# Usage (from repo root):
#   ./scripts/film_clip_d.sh embed
#     Embeds a fixed payload into a real photo cover with --robust,
#     writes live_shot.jpg, prints its path and exact byte size.
#     -> send live_shot.jpg through Instagram by hand, download the
#        received copy, save it as live_shot_received.jpg, then:
#   ./scripts/film_clip_d.sh check
#     Shows live_shot.jpg vs. live_shot_received.jpg side by side (byte
#     sizes), decodes the received file to plain text (no raw base64),
#     and prints one clear PASS/FAIL line.

set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

CLI="src-tauri/target/release/stegstr-cli"
[ -f "${CLI}.exe" ] && CLI="${CLI}.exe"

COVER="live_test/control/control_whatsapp_original.jpg"
OUT="live_shot.jpg"
RECEIVED="live_shot_received.jpg"
PAYLOAD="Stegstr hidden message -- live Instagram test"

fail() { echo ""; echo "  FAIL -- $*"; echo ""; exit 1; }

bytes_of() { stat -c%s "$1" 2>/dev/null || stat -f%z "$1" 2>/dev/null; }

fmt_bytes() {
  # Comma-thousands, no external deps (printf %'d is locale-dependent
  # and unreliable in Git Bash).
  local n="$1" out="" cnt=0
  while [ "$n" -ge 1000 ]; do
    out=",$(printf '%03d' $((n % 1000)))$out"
    n=$((n / 1000))
    cnt=$((cnt + 1))
  done
  echo "${n}${out}"
}

cmd="${1:-}"

case "$cmd" in
  embed)
    [ -f "$CLI" ] || fail "CLI not found at $CLI -- build it first: cargo build --release --bin stegstr-cli"
    [ -f "$COVER" ] || fail "cover not found at $COVER"

    "$CLI" embed "$COVER" -o "$OUT" --robust --payload "$PAYLOAD" >/dev/null 2>&1
    [ -f "$OUT" ] || fail "embed did not produce $OUT"

    size=$(bytes_of "$OUT")
    echo ""
    echo "=================================================="
    echo ""
    echo "   $OUT"
    echo ""
    echo "   $(fmt_bytes "$size") bytes"
    echo ""
    echo "=================================================="
    echo ""
    ;;

  check)
    [ -f "$CLI" ] || fail "CLI not found at $CLI -- build it first: cargo build --release --bin stegstr-cli"
    [ -f "$OUT" ] || fail "$OUT not found -- run '$0 embed' first"
    [ -f "$RECEIVED" ] || fail "$RECEIVED not found -- download the sent file back and save it under that name first"

    sent_size=$(bytes_of "$OUT")
    recv_size=$(bytes_of "$RECEIVED")
    delta=$((recv_size - sent_size))
    if [ "$delta" -ge 0 ]; then delta_str="+$(fmt_bytes "$delta")"; else delta_str="-$(fmt_bytes "${delta#-}")"; fi

    raw="$("$CLI" decode "$RECEIVED" 2>&1)"
    status=$?
    if [ $status -eq 0 ] && [[ "$raw" == base64:* ]]; then
      decoded="$(printf '%s' "${raw#base64:}" | base64 -d 2>/dev/null)"
    elif [ $status -eq 0 ]; then
      decoded="$raw"
    else
      decoded=""
    fi

    echo ""
    echo "=================================================="
    echo ""
    echo "   SENT      $OUT"
    echo "             $(fmt_bytes "$sent_size") bytes"
    echo ""
    echo "   RECEIVED  $RECEIVED"
    echo "             $(fmt_bytes "$recv_size") bytes  ($delta_str)"
    echo ""
    echo "   --------------------------------------------"
    echo ""
    echo "   decoded message:"
    echo ""
    echo "   $decoded"
    echo ""
    echo "   --------------------------------------------"
    echo ""
    if [ "$decoded" = "$PAYLOAD" ]; then
      echo "   PASS"
    else
      echo "   FAIL"
    fi
    echo ""
    echo "=================================================="
    echo ""
    [ "$decoded" = "$PAYLOAD" ]
    ;;

  *)
    echo "usage: $0 embed|check" >&2
    exit 2
    ;;
esac

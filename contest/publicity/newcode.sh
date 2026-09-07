#!/bin/bash
# Mint a referral code and append it to participants.tsv.  Usage: ./newcode.sh "Display name"
set -euo pipefail
cd "$(dirname "$0")"
ALPHABET=ABCDEFGHJKMNPQRSTUVWXYZ23456789
while :; do
  code=$(LC_ALL=C tr -dc "$ALPHABET" < /dev/urandom | head -c 6)
  grep -q "^$code	" participants.tsv || break
done
printf '%s\t%s\n' "$code" "${1:-}" >> participants.tsv
echo "$code  https://stegstr.com/r/$code"

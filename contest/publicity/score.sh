#!/bin/bash
# Nightly publicity-contest scoring on the relay VM (buzz-relay-vm, project web3services).
# Installed at /opt/publicity/score.sh and run by root's cron. See PUBLICITY_CONTEST.md.
set -euo pipefail
DIR=/opt/publicity
OUT=$DIR/out
mkdir -p "$OUT"
docker exec relays-strfry-1 /app/strfry scan '{"kinds":[0,1]}' 2>/dev/null \
  | python3 "$DIR/score.py" --key "$DIR/scoreboard.key" --participants "$DIR/participants.tsv" --out "$OUT"
# Publish the signed kind-30078 scoreboard event so stegstr.com/publicity/ can read it from the relay.
docker exec -i relays-strfry-1 /app/strfry import < "$OUT/scores.event" 2>&1 | grep -E "Done\.|rejected [1-9]|ERROR" || true
echo "$(date -u +%FT%TZ) scored: $(python3 -c "import json;d=json.load(open('$OUT/scores.json'));print(d['totals'])")" >> "$DIR/score.log"

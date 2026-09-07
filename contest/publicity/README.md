# Stegstr publicity contest: measuring unique identities per participant

Goal stated by David (2026-09-06): reward participants for the number of
**unique identities that become active on relay.stegstr.com** because of them.
Not clicks, not installs. Unique Nostr pubkeys that publish at least one event.

## What a participant gets

A short referral code, 6 characters, e.g. `K7M2QX`, and two things built from it:

- A link: `https://stegstr.com/r/K7M2QX`
- A QR code for the same link (generated on the referral page, downloadable PNG)

Nobody types a hash. The code is short because it only has to be unique among a
few hundred participants, not globally secure. The long, hashed links David saw
elsewhere are tracking tokens for ad networks; we do not need them.

## How the code reaches the relay (built 2026-09-07)

The activity we score happens later than the click, from an app or CLI,
signed by a key that did not exist at click time. The code therefore travels
with the person, not the click:

1. `stegstr.com/r/CODE` is a static invitation page (nginx rewrites the path
   to `r/index.html`). It stores `{code, at}` under the localStorage key
   `stegstr_ref` on the stegstr.com origin and links to `/app/?ref=CODE`.
   The web app shares that origin, so it sees the code; it also reads `?ref=`
   itself. A code that is already stored is never overwritten.
2. Desktop users type or paste the code (or the whole link) into Settings,
   under Referral code. It can be removed there too.
3. For 30 days after the code was stored, every profile (kind 0) and note
   (kind 1) the app publishes carries the indexed tag
   `["r", "https://stegstr.com/r/CODE"]`. `stegstr-cli post --ref CODE` adds
   the same tag, so agents can be attributed too. Code: `src/app/referral.ts`,
   `src/SettingsView.tsx`, `src-tauri/src/bin/stegstr_cli.rs`.
4. Nightly (03:17 UTC, root cron on buzz-relay-vm) `/opt/publicity/score.sh`
   runs `strfry scan '{"kinds":[0,1]}'` through `score.py`, writes
   `out/YYYY-MM-DD.tsv` (one line per attributed pubkey, kept for audit) and
   `out/scores.json`, then signs the JSON into a kind-30078 event
   (`d = stegstr-publicity-scores`) and imports it into the relay. The page at
   `stegstr.com/publicity/` reads that event straight from
   `wss://relay.stegstr.com`; no bucket, no extra web server. The signing key
   lives only at `/opt/publicity/scoreboard.key` (mode 600); its pubkey is
   pinned in `publicity/index.html`.

Codes: 4-8 characters from A-Z without I, L, O and digits 2-9. Mint one with
`contest/publicity/newcode.sh "Name"`, which appends to `participants.tsv`;
copy that file to `/opt/publicity/participants.tsv` on the VM so the code
shows as registered on the board. Unregistered codes are scanned but hidden.

## Scoring (as implemented in score.py)

A pubkey is attributed to the first code it ever carried (earliest
`created_at`). Weight per pubkey:

| Signal | Weight |
|---|---|
| No kind-0 with a name, or no kind-1 notes at all | 0 (listed as "not scored") |
| Notes on fewer than 3 distinct UTC days | 0.2 |
| Notes on 3 or more distinct UTC days | 1.0 |
| More than 20 pubkeys first seen for one code inside one minute | 0, flagged "burst" |

A code's score is the sum. Ties break on full-weight count, then identities.
The relay does not record IPs in events, so the IP-block check from the
original design is a manual step on Caddy's access log if a code looks wrong.

## Not built

- Relay-side IP attribution and per-participant relay URLs (options B and C
  of the original design). The tag approach covers both app and CLI users
  and needs no relay changes.
- The contest listing itself (freelancer.com) and the prize.

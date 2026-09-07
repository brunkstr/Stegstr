# Progress

Status snapshot for the `hardening` branch, `STEGSTR_ENTRY_V3.md` campaign.

- **Phase 1 (break it) + post-Phase-4 regression pass:** 9 numbered bugs
  found and fixed (4 Critical, 2 High, 3 Medium), all with regression
  tests. Kept distinct, not merged into one number: 5 confirmed
  pre-existing in pristine upstream (#1, #2, #4, #5, #6, each verified by
  building and running a pristine clone or diffing against it), 3
  introduced by this fork's own new work (#3, #7, #8 -- bugs in code
  upstream doesn't have at all), and 1 (#9) that's neither -- the faulty
  code is identical to upstream's, but the bug is only reachable because
  of this fork's own dual-encoder decode path. One security issue in two
  of the tiers (#6: spoofable events, upstream; #8: crash on malformed
  input, this fork's own work). See `BUGS.md`.
- **Phase 2 (environments):** Windows/macOS/Ubuntu release builds green in
  real CI (manually dispatched, run `32971568821`). MSRV 1.88.0 declared and
  actually verified. 8 npm vulnerabilities fixed (1 critical). Broken
  mobile-android submodule (failing every CI checkout) removed and
  documented. Outdated GitHub Actions bumped. `.claude/` audited (see
  git history for anything contest-strategy-specific, kept out of the
  working tree). Node 18/20 matrix configured but never actually executed
  (see `ROBUSTNESS_REPORT.md`, "what we did not test").
- **Phase 3 (networking under failure):** Nostr event signature
  verification added (bug #6, confirmed pre-existing upstream gap).
  Verified not overly strict: 100/100 real relay events accepted. Partial
  publish success now reported honestly. Reconnect-with-backoff added.
  7 failure modes tested against a local mock relay. Two gaps found and
  left open, documented: no `CLOSED`/`NOTICE` handling, no offline outbox
  for non-zap events.
- **Phase 4 (steganography):** per-cover adaptive QIM delta shipped
  (flat covers: worst-case SSIM 0.662 -> 0.758, zero survival cost,
  45/45 held). Full non-monotonic tradeoff curve documented, not picked
  quietly. One residual gap: literal solid-color cover still fails the
  harshest simulated platform.
- **Live platform confirmation:** Instagram genuinely recompresses and
  survives (+9.1% size, decodes correctly). WhatsApp comes back
  byte-identical -- a control test (untouched original through the same
  path, ~76% smaller) proved this is pass-through, not recompression
  survival, and the report says so precisely rather than the easier,
  looser claim. Telegram still simulated only.
- **Phase 5 (package):** this file, `ROBUSTNESS_REPORT.md`,
  `scripts/verify.sh` / `.ps1`, `scripts/demo.sh` all done this round.
  `run_matrix_realistic.py` already finishes in ~10s (no fix needed).
- **Merged to `main` and released.** `hardening` fast-forwarded into
  `main`; tag `v0.1.0` cut, `release.yml` green on all 3 OSes, GitHub
  Release live with 6 assets. Windows `.exe` verified end-to-end
  (installed, launched, real window, bundled CLI round-tripped, then
  cleanly uninstalled). Linux AppImage checksum-verified but not
  launch-tested (no Linux environment available here).
- **Post-Phase-4 regression pass (time-boxed):** adversarial corpus
  re-run against the current binary (84 ops, 0 crashes -- found bug #9
  above); dual-format decoder attacked directly with 300 trials of random
  header/body noise plus a truncated-cover case (0 panics); `verifyEvent`
  attacked with 41 malformed-event shapes (all rejected cleanly, none
  threw); diff audit of `origin/main` vs. upstream for debug prints/TODOs/
  scratch files (clean). One adjacent finding, not a code bug:
  `Stegstr_Contest_Entry.pdf` was a real committed document that predated
  this campaign and had gone stale (pre-hardening numbers, missing the
  bug count, missing the WhatsApp pass-through distinction) -- deleted;
  README.md is now the single current entry document.
- **v0.1.1 cut** to ship bug #9's fix (v0.1.0's binaries predated it).
  v0.1.0 left in place, not deleted. README download links use
  `/releases/latest/download/...`, so they resolve to v0.1.1 automatically.
- **AI agent operability** (STEGSTR_BRIEF.md's Phase 7; highest-priority
  remaining item at the time it was picked up, nothing existed for it
  before): `--json` on decode/detect/embed/post/calibrate, schemas
  committed under `schema/cli/` and validated against the real binary in
  `src-tauri/tests/cli_json_schema.rs`; documented, source-verified exit
  codes (0/1/2/3/4/5); no interactive prompts, now guarded, not just
  absent; new `calibrate` command (channel fingerprinting) verified
  against this repo's own real captured `live_test/` evidence -- exact
  JPEG quality recovery (80 for Instagram, 92 for the WhatsApp control)
  and an independently-correct inference of WhatsApp's ~1600px resize cap
  from pixel dimensions alone; new `mcp` command, a stdio MCP server on
  the official `rmcp` SDK exposing embed/decode/detect/calibrate, verified
  with real `initialize`/`tools/list`/`tools/call` round trips;
  `skill/stegstr/` rewritten with every command block actually run against
  the compiled binary (caught a real stale-claim risk: `post --json`'s
  wrapper vs. the bare bundle); `tests/e2e/agent_smoke.sh` added, 10/10
  passing, stable across repeated runs. Not built, flagged as open scope
  rather than dropped silently: binary-safe stdin/stdout piping for
  embed/detect, `--seed` for deterministic output. Full detail: `BUGS.md`'s
  "Phase 7" entry, `README.md`'s "AI agent operability" section.
- **v0.1.2 cut** to ship the above. First release-build attempt failed CI
  on all 3 platforms (a known Tauri limitation with multiple `[[bin]]`
  targets, triggered by this work's original module layout) -- caught by
  watching the actual CI run rather than assuming success, root-caused,
  fixed, re-verified, and the broken tag replaced before anything public
  was affected (no release was ever published from the failed build). See
  `BUGS.md`'s "Phase 7" entry for the full account.

**Open items, in priority order:** Telegram live send, video recording
(shot list in `STEGSTR_VIDEO_ENTRY_BRIEF.md`), entry description text.

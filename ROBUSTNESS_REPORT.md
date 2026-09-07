# Robustness Report

One consolidated report for judging: what was tested, what changed, and what
was not tested. Everything here is backed by a command you can re-run --
see "Reproduce" under each section, or `scripts/verify.sh` /
`scripts/verify.ps1` for the whole matrix in one command against a genuinely
clean clone. Full detail and raw numbers live in `BUGS.md`,
`channel_simulator/BASELINE_RESULTS.md`, and `ROBUSTNESS_PORT_NOTES.md` --
this file summarizes and cross-references them rather than duplicating them.

---

## 1. Bugs found and fixed

**9 numbered bugs** (4 Critical, 2 High, 3 Medium), all with repro steps,
root cause, fix, commit hash, and a regression test in `BUGS.md`. Three
groups, kept separate rather than merged into one number --
"pre-existing in upstream," "introduced by this fork's own new work," and
"upstream's code, but only reachable because of this fork's own work" are
different claims and are backed by different evidence:

**Tier 1 -- pre-existing in the upstream application (5 bugs), each
verified by actually building and running a pristine clone of
`brunkstr/Stegstr` @ `ad2e10e`, not inferred from shared code:**

| # | Severity | Summary |
|---|---|---|
| 1 | Critical | Default DWT decode returned silently corrupted payloads on covers >= 256px |
| 2 | High | DWT decode flipped bits on high-contrast/noisy covers (unguarded clamping) |
| 4 | High | `decode()`'s tile-aligned search silently skipped for extreme aspect ratios |
| 5 | Critical | `encode()` wrote every non-leftmost tile's pixels from the wrong source column -- visible image corruption, not just imperfect invisibility |
| 6 | Critical | Received Nostr events were never cryptographically verified -- **security issue**: allows event spoofing/impersonation |

**Tier 2 -- bugs in this fork's own new work (3 bugs), not present in
upstream because the code they're in didn't exist there:**

| # | Severity | Summary |
|---|---|---|
| 3 | Medium | Malformed-JPEG decode (new QIM/libjpeg FFI path) leaked a file handle + libjpeg memory pool every attempt |
| 7 | Medium | Publish treated "1 of 5 relays confirmed" the same as "5 of 5" in the UI (a gap in this fork's own new confirmed-count feature) |
| 8 | Critical | Old QIM images (pre-Phase-4, 16-bit header) failed to decode against the current binary -- and could crash the process (Reed-Solomon buffer underflow) -- **security-relevant**: a crafted/malformed header crashes the app on untrusted input |

**Tier 3 -- upstream's own code, but the bug isn't reachable there (1 bug):**

| # | Severity | Summary |
|---|---|---|
| 9 | Medium | Default decoder trusted the file extension over actual content, breaking `decode_any()`'s "you don't need to know which encoder produced it" promise -- the faulty line is identical to upstream's, but upstream has no second encoder and makes no such promise, so it can't actually hit this |

Bugs #1, #2, #5 were confirmed against pristine upstream by directly
embedding/decoding with the upstream binary and inspecting the (corrupted)
output. Bug #4 was checked the same way during this packaging pass (not
originally verified when found -- only assumed plausible since it shares
the same tiling code as #1 -- then actually built and run to confirm,
same corruption signature). Bug #6 (the Nostr signature gap) was verified
by a byte-for-byte diff of `relay.ts`'s `onmessage` handler against
upstream, plus a whole-tree grep for `verify`/`schnorr.verify`, both
confirming it's the holder's own app's gap, not this fork's.

Two of the nine are security issues, one in each of the first two tiers:
#6 (upstream, spoofable events) and #8 (this fork's own QIM work, crash on
malformed input). They are not both "pre-existing in upstream" -- keeping
that distinction is the point of the tiers above.

**Post-Phase-4 regression pass (time-boxed, not a full re-run):** re-ran
the adversarial corpus against the current binary (84 embed/decode/raw-
decode operations across ~28 files, 0 crashes -- this is what found bug
#9), attacked the dual-format decoder directly with 300 trials of random
header/body coefficient noise plus a truncated-cover case (0 panics --
the bug #8 fix holds), attacked `verifyEvent` with 41 malformed-event
shapes (all rejected cleanly, none threw), and diffed `origin/main`
against upstream for debug prints/TODOs/commented-out code/scratch files
(clean). Full detail: `BUGS.md`'s "Post-Phase-4 regression pass" section.

Additional findings documented but **not** fixed (flagged honestly rather
than silently left out): no `CLOSED`/`NOTICE` handling in `relay.ts`, no
persistent offline outbox for non-zap events, a CLI UX gap in
`--payload-base64` (no `@file` form), and the Android submodule being a
broken gitlink inherited from upstream with no recoverable source. See
`BUGS.md`'s "Also investigated, not a bug" and Phase 3 sections for detail.

**Reproduce:** `cargo test --release --manifest-path src-tauri/Cargo.toml`
(regression tests for every fixed bug), `npm test` (Nostr/relay fixes, 71
tests), `cargo clippy --release --all-targets -- -D warnings` (clean).

---

## 2. Steganographic robustness: before and after

| | encoder | simulated channel matrix | live platforms |
|---|---|---|---|
| **Before** | DWT (spatial-domain, PNG) | 0/4 (whatsapp/instagram/facebook/twitter) | never survives -- upstream's own docs say to avoid JPEG |
| **After** | QIM (JPEG DCT-domain, `--robust`) | 45/45 (9 cover types x 5 platforms incl. Telegram) | WhatsApp + Instagram confirmed (see below); Telegram simulated only |

The DWT baseline's 0/4 isn't a strawman -- it's what the *default* encoder
(`embed` without `--robust`) still does today, because DWT survives being
opened and re-saved locally but not a platform's own resize+recompress
pipeline. `--robust` opts into the JPEG/QIM path specifically to survive
that. `channel_simulator/BASELINE_RESULTS.md` has the full progression:
initial 20/20 QIM result on 4 covers, extended to 45/45 on 9 covers
(including a real phone aspect ratio and a screenshot), then re-verified
against the actual compiled Rust binary (not just the Python prototype)
after the Phase 1 bugfix campaign and again after Phase 4's adaptive delta.

**Invisibility, measured not assumed:** PSNR ~32dB, SSIM 0.70-0.84 across
realistic cover types at the shipped `QIM_DELTA=16` (down from an initial
`=32` that scored ~26dB and was visibly grainy on inspection -- caught by
actually looking at the output, not just the bit-error-rate number).

**Phase 4 (adaptive per-cover delta):** the known flat-cover weak point
(`smooth`, 0.662 SSIM) improved to 0.758 SSIM with zero simulated-survival
cost (45/45 held both before and after), by giving flat covers a smaller
QIM delta (`QIM_DELTA_FLAT=12`). The tuning value came from re-testing the
actual Rust binary end-to-end, not a formula -- see
`BASELINE_RESULTS.md`'s "tradeoff curve" section for the full, honestly
non-monotonic sweep (delta=10 broke Telegram, 14 was worse than both 12 and
16). One residual gap: a literal solid-color cover (0.0 AC energy, not
achievable by any real photo) still fails the harshest simulated platform.

**Reproduce:** `cd channel_simulator && python run_matrix_rust_cli.py`
(45/45), `python run_matrix_rust_cli_extra.py` (79/80 on a harder corpus),
`python adaptive_delta_report.py` (before/after PSNR/SSIM/survival table).

---

## 3. Live platform confirmation (not simulated)

Two live-test rounds exist. The earlier one (`ROBUSTNESS_PORT_NOTES.md`)
sent a photo through real WhatsApp and Instagram and decoded both correctly.
This session re-ran it against the current (Phase 4) binary with a fixed,
randomly-noned payload and three real camera-realistic covers, then added a
control experiment the earlier round didn't have:

| platform | sent | received | Δ | decode | what this proves |
|---|---:|---:|---:|---|---|
| WhatsApp | 14,486 B | 14,486 B | +0 B | PASS | **pass-through, not survival** -- see control below |
| Instagram | 48,241 B | 52,609 B | +9.1% | PASS | genuine recompression survival |
| Telegram | 26,321 B | -- not sent live -- | -- | -- | simulated only |

**The control test, and why it matters:** a byte-identical round trip is
consistent with two different mechanisms -- the platform recompressed and
happened to reproduce the same bytes, or the platform didn't touch the file
at all. Sent an **untouched original photo** (no embedding, same source
image, SHA-256-verified unmodified) through the identical WhatsApp path: it
came back at ~94KB, a ~76% reduction, proving the path does recompress.
Since the same path left the 14,486-byte stego file completely untouched,
the correct conclusion is that `--robust`'s pre-conditioning (576px
longer-side resize, JPEG quality 80) already puts its output below
whatever threshold triggers WhatsApp's own recompression -- **the stego
file passed through unmodified, it did not survive being recompressed.**
Instagram's result, where the file size did change, is the one entitled to
the "survives recompression" claim. Full writeup:
`channel_simulator/BASELINE_RESULTS.md`, "Live re-test after Phase 4."

**The 576px tradeoff, with real capacity numbers.** `--robust` always caps
the cover to 576px on the longer side before embedding -- a 1920x1200
source comes out at 576x360, regardless of source resolution. Measured
directly (binary search against the compiled CLI, not estimated):

| cover shape (post-resize) | measured payload capacity |
|---|---:|
| 576x360 (landscape photo) | 903 bytes |
| 576x576 (square) | 1,513 bytes |

Both comfortably exceed a typical Nostr note (542 bytes) and the 5-recipient
NIP-04 envelope tested elsewhere (1,187 bytes), but capacity scales with
resized pixel count, not the 576px figure alone -- worth checking for an
unusually large bundle on a narrow-aspect cover.

**Reproduce:** `live_test/` (gitignored, not committed -- contains the exact
covers, payload, and `decode_received.sh` used for this round).

---

## 4. Nostr client hardening

| finding | status |
|---|---|
| Received events never cryptographically verified (bug #6) | **Fixed** -- `verifyEvent()` added, wired into `relay.ts` |
| verifyEvent could be too strict and silently reject genuine events | **Checked, not a problem** -- 100/100 real events from two independent public relays (relay.damus.io, nos.lol) verified correctly, 0 false rejections |
| Partial publish success reported as full success (bug #7) | **Fixed** -- distinct toast for `0 < confirmed < total` |
| Dropped relay connections never reconnected | **Fixed** -- exponential backoff reconnect |
| Duplicate event de-duplication | **Verified correct** -- `Map` keyed by event id already overwrites in place |
| Clock skew (event `created_at` far in the future) | **Verified accepted** -- NIP-01 doesn't mandate freshness, and the new verifier doesn't add an implicit one |
| Relay rate-limiting (`CLOSED` message) | **Finding, not fixed** -- `relay.ts` has no case for `CLOSED`/`NOTICE` at all; silently ignored |
| Offline outbox surviving a restart | **Finding, not fixed** -- exists for zap payments only (`localStorage`-backed queue); ordinary posts/replies/DMs/etc. have no persistence and are lost on restart if unsent |

**Reproduce:** `src/__tests__/nostr-event-verify.test.ts`,
`src/__tests__/relay-failure-injection.test.ts` (mock relay, 7 failure modes
including relay-down/slow/drops-mid-subscription/half-pool-unreachable),
`src/__tests__/verify-against-real-relay.test.ts` (real relays, excluded
from `npm test` since it's network-dependent -- run explicitly).

---

## 5. Cross-environment

| environment | status | evidence |
|---|---|---|
| Windows release build | **Green** | GitHub Actions run [`32971568821`](https://github.com/akifjanjua/Stegstr/actions/runs/32971568821), `build (windows-latest)`, 3m55s |
| macOS release build | **Green** | same run, `build (macos-latest)`, 2m19s |
| Ubuntu 22.04 release build | **Green** | same run, `build (ubuntu-22.04)`, 3m54s |
| Rust MSRV (1.88.0) | **Verified for real** | `cargo +1.88.0 build`/`test` both run and pass, not just declared |
| Rust stable | **Verified** | this repo's day-to-day toolchain throughout the campaign |
| npm audit | **Fixed** | 8 advisories (1 critical, 6 high) in dev/build tooling, resolved with `npm audit fix`, web build + full test suite (58/58 at the time) re-verified after |
| Node 18 / 20 / 22 | **Configured, not executed** -- see "What we did not test" | `frontend-test.yml` added but never actually run (see below) |
| Web/wasm build | **Fix applied, not fully round-trip tested** | `src/stego-qim.ts`'s pre-resize bug fixed the same way as Rust/Python; unit tests pass, but an actual embed -> channel-simulate -> decode round trip in the browser was not completed this session |
| Android | **Honestly documented as untestable here** | `mobile-android/` was a broken git submodule gitlink with no `.gitmodules` entry, inherited from upstream (confirmed present there too); removed the broken gitlink, documented the real state (Rust side has `tauri::mobile_entry_point`, but `tauri android init` was never run and this environment has no Android SDK/NDK) |
| Release pipeline (tag -> binaries) | **Fixed and validated, deliberately not exercised for a real release** | `release.yml` switched to tag-triggered with SHA256 checksums; `build.yml` manually dispatched and confirmed green on all 3 OSes (above). No tag has been pushed and no GitHub Release has been cut -- that's a deliberate standing constraint for this session, not a gap in the workflow itself |

**Reproduce:** `scripts/verify.sh` / `scripts/verify.ps1` -- clean clone,
Rust build+test+clippy, `npm install && npm test`, full Python channel
matrix, one command.

---

## What we did not test

Stated plainly, not glossed over:

- **Node 18 and Node 20 were never actually executed**, on this machine or
  in CI. `frontend-test.yml`'s Node-version matrix job was added and is
  correctly configured (`workflow_dispatch` plus push/PR to main/release),
  but GitHub only allows manual `workflow_dispatch` runs for workflow files
  present on the **default branch**, and this session's standing constraint
  has been to never push to `main`. It has therefore never actually
  triggered on GitHub. Locally, this machine has only Node 24.16.0 installed
  system-wide, no `nvm`/`fnm`/`volta` available to test 18/20 directly. The
  test suite is plain Vitest with nothing version-specific in it, so risk is
  believed low, but "believed low" is not "verified" -- flagging the gap
  rather than asserting it's fine.
- **Android was not built or run**, on a device, an emulator, or otherwise
  -- no SDK/NDK available in this environment, and the pre-existing
  submodule gitlink pointed at a commit with no recorded source URL, so
  there was nothing to recover. The Rust side is mobile-capable in principle
  (`tauri::mobile_entry_point` exists) but `tauri android init` has never
  been run against this codebase.
- **The web/wasm build's embed/decode path was not round-trip tested in an
  actual browser** against the channel simulator. The known bug (guessed-
  platform pre-resize) was fixed by mirroring the already-proven Rust/Python
  fix, and the existing unit tests (low-level DCT/quantization/Reed-Solomon
  math) pass, but "the fix mirrors proven logic" is not the same claim as
  "verified end-to-end in a browser."
- **Telegram has no live-platform confirmation**, only the simulated channel
  profile (which does correctly model Telegram's known resize/quality
  settings, and is the same code path validated live for WhatsApp/Instagram
  -- but it is still a proxy, not a real send).
- **macOS and Linux were only build-tested (CI), not run-tested.** The
  binaries compile and the release workflow's artifacts are produced on all
  three OSes, but no one has launched the resulting macOS/Linux app or CLI
  and used it interactively the way the Windows machine that did all the
  live-platform and CLI testing was used.
- **cargo-fuzz never actually ran.** Scaffolded (`src-tauri/fuzz/`,
  `decode_any` target) but blocked by a Windows/MSVC-specific libFuzzer
  linker limitation (`LNK1561`), not a code issue -- see `BUGS.md`'s
  writeup. Coverage for the same class of concern (arbitrary/malformed
  decode input) comes instead from proptest, the adversarial image corpus,
  and a crash-sweep script, none of which substitute for real
  coverage-guided fuzzing.
- **No multi-megabyte payload was sent through a real platform live** --
  capacity limits and Reed-Solomon correction were validated against the
  simulated channel matrix and local encode/decode, not an actual large
  upload/download round trip.
- **Encrypted payloads (`--encrypt`) were not included in the live-platform
  sends** -- verified locally (round-trips, tamper detection via AES-GCM's
  auth tag) and via the simulated matrix (the 1,187-byte NIP-04 envelope
  case), but not through an actual WhatsApp/Instagram send.
- **No tag was pushed and no GitHub Release was cut**, deliberately, per
  this session's standing instruction. The release pipeline itself is
  fixed and its build step is validated (see above); actually cutting a
  release remains the repo owner's call.

---

## Reproduce everything

```bash
./scripts/verify.sh       # clean clone -> Rust build/test/clippy -> npm test -> full Python matrix
./scripts/demo.sh         # fixed cover, fixed payload, embed + decode round trip
```

Windows: `scripts\verify.ps1` (same steps, PowerShell).

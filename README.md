# Stegstr

<!-- Demo video slot: STEGSTR_VIDEO_ENTRY_BRIEF.md's shot list, once recorded. -->

**Steganographic social networking.** Hide messages in images and share them anywhere — local-first, with optional Nostr sync. This fork of [brunkstr/Stegstr](https://github.com/brunkstr/Stegstr) fixes 9 bugs — 5 pre-existing in upstream (including a Nostr signature-spoofing vulnerability), 3 more found in its own new work — and adds JPEG-domain steganography that survives WhatsApp and Instagram recompression — confirmed with real sends, not just simulation.

## Download v0.1.0

No Rust, no Node, no build step. Pick your platform:

| Platform | Download |
|---|---|
| Windows | [Stegstr-Windows.exe](https://github.com/akifjanjua/Stegstr/releases/latest/download/Stegstr-Windows.exe) (or [.msi](https://github.com/akifjanjua/Stegstr/releases/latest/download/Stegstr-Windows.msi)) |
| macOS | [Stegstr-macOS.dmg](https://github.com/akifjanjua/Stegstr/releases/latest/download/Stegstr-macOS.dmg) |
| Linux | [Stegstr-Linux.AppImage](https://github.com/akifjanjua/Stegstr/releases/latest/download/Stegstr-Linux.AppImage) (or [.deb](https://github.com/akifjanjua/Stegstr/releases/latest/download/Stegstr-Linux.deb)) |

All builds and the release itself run in [GitHub Actions from a clean clone](https://github.com/akifjanjua/Stegstr/actions/runs/33031749340), not a local machine. [`SHA256SUMS.txt`](https://github.com/akifjanjua/Stegstr/releases/latest/download/SHA256SUMS.txt) is in the release if you want to verify your download (`sha256sum -c SHA256SUMS.txt`, or `certutil -hashfile <file> SHA256` on Windows).

**Verified before publishing, not just built:** the Windows download was installed and launched for real — an actual app window opened and stayed running — and the bundled CLI was round-tripped (embed → decode, byte-exact) before this link went out. **The Linux AppImage is checksum-verified and the correct size, but launching it was not tested** — this was built and verified from a Windows machine with no Linux environment available. If you're on Linux, you're the first real launch test; let us know if something's wrong.

## What this fork fixes

**5 bugs pre-existing in the upstream application** — each confirmed by building and running a pristine clone of `brunkstr/Stegstr` @ [`ad2e10e`](https://github.com/brunkstr/Stegstr/commit/ad2e10e) directly, not inferred from reading the code:

- **A Nostr signature-spoofing vulnerability** — received events were never cryptographically verified. Any relay (or a MITM) could inject events that display as posted by any pubkey, including someone else's. ([full writeup](BUGS.md#6-received-nostr-events-were-never-cryptographically-verified))
- **Silent payload corruption on the default encoder** — the default `embed` (no flags) returns wrong bytes on decode for any cover ≥256px with a payload over ~9 bytes, no error, just wrong data. ([full writeup](BUGS.md#1-dwt-decode-returns-silently-corrupted-payload-for-any-image--256px-with-a-payload-over-9-bytes))
- **A ~9dB image-destruction bug** — encoding into any cover wider than one 256px tile visibly wrecked the image itself (a measured PSNR of 8.96dB / 9.02dB on two covers, against 30-67dB everywhere else) — the payload still decoded fine, which is exactly why every prior correctness test missed it; nothing had compared the output image to the cover pixel-for-pixel. [Evidence images](docs/evidence/) show the corruption directly. ([full writeup](BUGS.md#5-encode-wrote-every-non-leftmost-tiles-pixels-from-the-wrong-source-column----catastrophic-visible-corruption-not-just-imperfect-invisibility))
- Decode flipped bits on high-contrast/noisy covers (unguarded clamping in the inverse transform). ([BUGS.md #2](BUGS.md#2-dwt-decode-flips-bits-on-high-contrastnoisy-covers-silent-clamping-in-the-haar-inverse-transform))
- Decode's tile-aligned search silently skipped for extreme aspect ratios (same corruption class as above, different geometry). ([BUGS.md #4](BUGS.md#4-decodes-tile-aligned-search-silently-skipped-for-one-axis-large-other-small-images))

**Separately: 3 bugs found and fixed in this fork's own new work** — these aren't upstream's fault, they're in code upstream doesn't have (the new JPEG/QIM encoder, and the Nostr publish-confirmation feature):

- A malformed/legacy JPEG could leak a file handle and libjpeg's memory pool on every decode attempt. ([BUGS.md #3](BUGS.md#3-malformed-jpeg-decode-leaks-a-file-handle--libjpeg-memory-pool-on-every-attempt))
- Publish silently treated "1 of 5 relays confirmed" the same as "5 of 5" in the UI. ([BUGS.md #7](BUGS.md#7-publish-silently-treated-1-of-5-relays-confirmed-the-same-as-5-of-5))
- **Security-relevant:** an old QIM image (pre-adaptive-delta header format) could crash the app outright via a Reed-Solomon buffer underflow — a malformed/mismatched header, not just an incompatibility. Fixed with a bounds check plus a versioned decoder that still reads the old format. ([BUGS.md #8](BUGS.md#8-old-qim-images-16-bit-header-failed-to-decode-against-the-current-binary----and-worse-could-crash-the-process))

**One more, found in a later regression pass, that doesn't cleanly fit either group above:** the default decoder trusted a file's extension over its actual content, so a valid image saved with the "wrong" extension failed with a misleading "corrupt file" error. The faulty line is identical to upstream's, but upstream has no second encoder and never promises extension-agnostic decoding — the bug only became reachable once this fork's own dual-encoder decode path existed. ([BUGS.md #9](BUGS.md#9-default-decoder-trusted-the-file-extension-instead-of-the-files-actual-content-breaking-decode_anys-own-documented-promise))

Plus repo and toolchain fixes: 8 npm vulnerabilities (1 critical), a broken `mobile-android` git submodule failing every CI checkout, no declared Rust MSRV, and outdated GitHub Actions. Full detail on all 9 application bugs, with repro steps, root cause, fix commit, and regression test each: [`BUGS.md`](BUGS.md). Consolidated report with before/after numbers and an honest "what we did not test" section: [`ROBUSTNESS_REPORT.md`](ROBUSTNESS_REPORT.md).

## Live platform results — stated precisely

"Survives recompression" and "passes through untouched" are different claims. Both are documented, not conflated:

| Platform | Result | What was actually shown |
|---|---|---|
| **Instagram** | Live, genuine survival | Sent through real Instagram: file size changed (+9.1%, 48,241 → 52,609 bytes) — Instagram actually re-encoded it — and the payload still decoded correctly. |
| **WhatsApp** | Live, but pass-through, not survival | Sent through real WhatsApp: came back byte-identical. A control test (an untouched, unembedded original sent the same way) came back ~76% smaller, proving WhatsApp's pipeline *does* recompress — just not this file. The stego output is small/compliant enough that WhatsApp's own pipeline treats it as a no-op, so this is not evidence the payload survived a recompression pass. |
| **Telegram** | Simulated only | Same code path validated for WhatsApp/Instagram, run through a local simulator matching Telegram's known resize/quality settings — not sent through a real Telegram client. |

Full methodology, the control-test details, and the simulated 45/45 channel matrix (9 cover types × 5 platform profiles): [`channel_simulator/BASELINE_RESULTS.md`](channel_simulator/BASELINE_RESULTS.md#live-re-test-after-phase-4-three-real-sends-plus-a-whatsapp-control-experiment).

## Usage

You need [Rust](https://rustup.rs) (latest stable) to build the CLI, or use a downloaded binary above.

```bash
./stegstr-cli post "Hello from CLI" --output bundle.json
./stegstr-cli embed cover.png -o out.png --payload @bundle.json --encrypt
./stegstr-cli detect out.png
```

**Sending through WhatsApp, Instagram, or Telegram?** Add `--robust` — it switches to the JPEG/DCT (QIM) encoder built to survive those platforms' own re-compression (the example above, without `--robust`, does not survive being re-uploaded). Output is always a `.jpg`:

```bash
./stegstr-cli embed cover.jpg -o out.jpg --robust --payload "hello world"
# send out.jpg through WhatsApp/Instagram/Telegram, download the received copy, then:
./stegstr-cli decode received.jpg
# decode tries the robust JPEG/QIM decoder first, then falls back to PNG/DWT --
# you don't need to know which encoder produced an image you were sent.
```

## AI agent operability

The CLI and an MCP server are both first-class here, not an afterthought —
[`skill/stegstr/`](skill/stegstr/) documents the full zero-human-input flow,
and every claim below is verified against the real binary in
`src-tauri/tests/cli_json_schema.rs` and [`tests/e2e/agent_smoke.sh`](tests/e2e/agent_smoke.sh).

- **`--json` on every command** (`decode`, `detect`, `embed`, `post`,
  `calibrate`) — exactly one JSON object on stdout, no prose mixed in.
  Schemas are committed at [`schema/cli/`](schema/cli/) and validated
  against the actual binary in CI-runnable tests, not just documented and
  hoped-for.
- **Documented, stable exit codes**:

  | Code | Meaning |
  |---|---|
  | `0` | Success |
  | `1` | Invalid usage or an otherwise-unclassified error |
  | `2` | Capacity exceeded — payload doesn't fit the cover |
  | `3` | No payload found in the image |
  | `4` | Decryption failure (`--encrypt`/`--decrypt`) |
  | `5` | Malformed input (unreadable image, bad base64/hex, non-UTF-8 text) |

  In `--json` mode the exit code always matches the emitted `error.kind`.
- **No interactive prompts, ever** — nothing in this CLI reads stdin
  interactively, on a TTY or not. `--yes` is accepted everywhere as a
  no-op, for scripts that want to pass it defensively.
- **`stegstr-cli calibrate`** — channel fingerprinting: compare a sent
  original against the file received back after a real platform round
  trip, and infer that platform's actual re-encode pipeline (resize rule;
  exact JPEG quality recovered from quantization tables, or a clearly
  labeled best-fit estimate when it isn't exact; chroma subsampling;
  progressive/baseline; whether metadata was stripped). Verified against
  this repo's own real captured Instagram and WhatsApp evidence in
  [`live_test/`](live_test/) — correctly recovered exact JPEG quality for
  both, and independently inferred WhatsApp's ~1600px longest-side resize
  from pixel dimensions alone.
- **`stegstr-cli mcp`** — an MCP server over stdio (built on the official
  [`rmcp`](https://github.com/modelcontextprotocol/rust-sdk) SDK) exposing
  `embed`, `decode`, `detect`, and `calibrate` as tools, each with a typed
  input schema and description, returning the identical JSON shape as the
  matching CLI command.

**What isn't included in this pass, honestly:** binary-safe stdin/stdout
piping for `embed`/`detect`, and a `--seed` flag for deterministic output
where randomness is used (event keys, the QIM permutation) — both are in
the original AI-agent-operability brief but weren't built here; flagged as
open scope, not silently dropped.

## Verify it yourself

```bash
./scripts/verify.sh     # clean clone -> Rust build/test/clippy -> npm test -> full channel matrix
./scripts/demo.sh        # fixed cover, fixed payload: embed + decode round trip
```

Windows: `scripts\verify.ps1` (same steps, PowerShell). Needs Rust, and optionally Node.js + Python for the frontend tests and channel-simulator matrix (skippable: `./scripts/verify.sh --skip-python`).

**Expect this to take a while on a cold machine** — roughly 10-20 minutes with no warm caches (network- and CPU-dependent), most of it the Rust release build alone (measured at ~7-8 minutes from an empty `target/`). The script prints a heartbeat line every 20 seconds during long steps and a `[step N]` marker with elapsed time per step, so a quiet stretch is normal, not a hang — `cargo`'s own `Compiling <crate>` output is the sign of life during the build itself.

If `npm test` reports a timeout waiting for a worker process to start, that's a resource-contention flake (something else on the machine was compiling at the same moment), not a real test failure — it doesn't happen when nothing else is running concurrently. Just re-run it.

## Build from source (full app)

Prerequisites: Node.js 18+, Rust (latest stable).

```bash
git clone https://github.com/akifjanjua/Stegstr.git
cd Stegstr
npm install
npm run build:mac   # or build:win, build:linux
```

See the repo for platform-specific build deps (e.g. Xcode CLI tools, Visual Studio Build Tools, Linux dev packages). CLI-only:

```bash
cd src-tauri && cargo build --release --bin stegstr-cli
```

Binary: `target/release/stegstr-cli` (Windows: `stegstr-cli.exe`).

## Links

- [Latest release](https://github.com/akifjanjua/Stegstr/releases/latest) — downloads for all platforms
- [Robustness report](ROBUSTNESS_REPORT.md) — before/after numbers, live-platform confirmation, what wasn't tested
- [Bugs found and fixed](BUGS.md) — 9 bugs (5 pre-existing upstream, 3 in this fork's own work, 1 that's neither), repro steps, root cause, fix, regression test each
- [Evidence images](docs/evidence/) — visual proof of the image-destruction bug, upstream vs. fixed
- [Agent skill](skill/stegstr/) — zero-human-input CLI/MCP workflow for AI agents, every command verified
- [CLI JSON schemas](schema/cli/) — `--json` output shapes for every command
- [What changed in this fork and why](ROBUSTNESS_PORT_NOTES.md)
- [Website](https://stegstr.com) — Downloads, getting started, wiki (this is the original upstream project's site, not this fork's)
- [Wiki / CLI docs](https://stegstr.com/wiki/cli.html) — Full CLI reference
- [This fork's source](https://github.com/akifjanjua/Stegstr)

## License

MIT

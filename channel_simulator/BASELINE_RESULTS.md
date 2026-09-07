# Baseline: DWT Fails After Channel Simulator

## Summary

The current Stegstr encoder (DWT Haar 2D, LSB in LH coefficients, PNG output) **does not** survive the simulated social-platform channels. This documents the baseline run and validates the channel simulator as a proxy for WhatsApp, Instagram, Facebook, and Twitter.

## Method

1. **Encode:** Embed a fixed payload (`channel_test!`) into a cover image using `stegstr-cli embed` (DWT encoder). Output: PNG.
2. **Channel:** For each profile (whatsapp, instagram, facebook, twitter), run the channel simulator on the stego PNG: strip metadata, resize to profile max width, re-encode as JPEG (quality and 4:2:0 per profile).
3. **Decode:** Run `stegstr-cli decode` on the resulting JPEG.
4. **Compare:** Check whether the decoded payload equals the original.

## Result (encoder × channel)

| Encoder | whatsapp | instagram | facebook | twitter |
|---------|----------|-----------|----------|---------|
| dwt     | FAIL     | FAIL      | FAIL     | FAIL    |

- **FAIL** = decode returns wrong data or decode fails (non-zero exit).
- No channel produced a correct payload recovery.

## Conclusion

- The channel simulator correctly applies resize + JPEG re-encoding, which **destroys** the DWT/LSB embedding (as expected: JPEG recomputes DCT from pixels and quantizes, wiping spatial/wavelet LSB).
- To survive these platforms, embedding must be in the **JPEG (DCT) domain** with robustness (stable coefficients, error correction). See the project plan for the DCT-robust prototype.

## How to reproduce

From `channel_simulator/`:

```bash
# Build CLI: from repo root, cargo build --release --bin stegstr-cli
python test_channel_robustness.py   # or run the baseline test block from README
```

---

## Update: QIM (DCT-domain) result -- the required platforms now pass

The baseline above validated the *problem*. This section documents the *fix*:
`dct_variants.encode_dct_qim` / `decode_dct_qim`, tuned and tested against
**realistic (non-flat) cover photos** rather than the single flat solid-color
fixture used above (a flat image never triggers the resize step at all, since
every platform's `max_width` was larger than the fixture's 512px -- that made
the original DWT-fails baseline correct, but would have made an early QIM
"it passes!" result misleading. See `covers/` and `gen_realistic_covers.py`
for the four cover types used below: textured, high-frequency noise, smooth
gradient, and a portrait-like image).

### What changed vs. the initial QIM prototype

1. **Universal pre-resize, not platform-guessing.** Coefficient-domain
   embedding cannot survive an actual pixel resize (resampling recomputes
   every 8x8 block from scratch -- confirmed empirically at ~50% bit-error
   rate, i.e. random). The original approach pre-resized the cover to *guess*
   which platform it would be sent through; guessing wrong, or the image being
   forwarded through a second platform, defeated it completely. Embed now
   always shrinks to a width safe for every platform in the target set (see
   `QIM_WIDTH_PRESETS` in `dct_variants.py`), so every downstream resize step
   is a guaranteed no-op.
2. **Spatially decorrelated redundancy.** The original 5x bit-repetition
   placed all 5 copies of a bit in the *same* 8x8 block (`debug_smooth.py`
   demonstrates this), so a block that quantizes badly (e.g. a flat/low-energy
   region) made every copy wrong the same way -- majority voting over
   correlated failures does nothing. Redundant copies are now scattered via a
   single fixed pseudorandom permutation of all coefficient positions (same
   seed on encode/decode), which fixed the worst-case (flat gradient) cover
   from failing every single platform to passing all three required ones.
3. **Fixed a silent crash.** `decode_dct_qim` didn't catch Reed-Solomon decode
   exceptions on uncorrectable codewords -- it raised instead of returning
   `None`, which a caller doing `if decode(...) == payload` would never even
   reach.
4. Added a **Telegram** channel profile (max_width 1280, quality 87 -- its
   default "compress" send mode) and a `simulate_chain()` helper for modeling
   multi-hop re-shares (e.g. received via Telegram, then forwarded via
   WhatsApp), which is strictly harsher than any single hop.

### Result: single-hop, `robustness="max"` (default), realistic payload (542 bytes)

| cover    | whatsapp | instagram | facebook | twitter | telegram |
|----------|----------|-----------|----------|---------|----------|
| highfreq | PASS     | PASS      | PASS     | PASS    | PASS     |
| portrait | PASS     | PASS      | PASS     | PASS    | PASS     |
| smooth   | PASS     | PASS      | PASS     | PASS    | PASS     |
| textured | PASS     | PASS      | PASS     | PASS    | PASS     |

**20/20** -- every platform tested (including the three the spec requires:
WhatsApp, Instagram, Telegram) x every cover type, including the deliberately
adversarial flat-gradient cover, which has almost no AC energy anywhere to
embed into.

### Multi-hop re-share chains (bonus scenario, not required by spec)

9/12 pass; the 3 failures are all the adversarial flat-gradient cover on
chains that include a WhatsApp hop (its quality=65 is the harshest single
setting tested). Real photos (textured/portrait/highfreq) pass every chain
tested, including 3-hop re-shares.

### How to reproduce

```bash
cd channel_simulator
pip install -r requirements.txt
python gen_realistic_covers.py       # generates covers/ (once)
python run_matrix_realistic.py       # full matrix incl. chains
python sweep_delta.py                # shows how QIM_DELTA was chosen
python debug_ber.py                  # raw per-channel bit-error-rate, no RS/repeat
```

### Update: extended validation (9 cover types, including real phone aspect ratios) -- 45/45

Following up on a contest holder's question about how extensively this had been tested, the
cover set was expanded from 4 synthetic 768x768 images to 9, including cases the original set
didn't touch: a real phone-camera aspect ratio (1080x1920 portrait -- the original covers were
all square, which no phone actually produces), a screenshot-style image (flat UI blocks + hard
edges, a very common real share), a low-light/noisy photo, a high-contrast outdoor scene, and an
adversarial narrow-but-tall image (500x2200) chosen to stress-test resize handling.

This surfaced and fixed two real bugs, both now fixed in both the Python prototype and the Rust
port:

1. **Resize logic only checked image width, not the longer dimension.** Real platforms cap the
   long edge (e.g. "max 1600px on the longest side"), not literally the width. A narrow-but-tall
   cover could pass the pre-resize safety check unshrunk (width looked safe) and then get resized
   for real by the channel simulator once its now-inaccurate width check no longer applied,
   which is exactly the failure mode the pre-resize exists to prevent. Fixed in
   `channel.py::_resize_to_max_dim`, `dct_variants.py::encode_dct_qim`, and
   `stego_qim.rs::encode`.
2. **Erasure over-marking on low-detail content.** The confidence-margin heuristic that flags
   "low confidence" bytes for Reed-Solomon erasure correction could flag more bytes than the
   codeword could mathematically correct (observed: 163 flagged erasures against a 176-byte
   codeword with only 128 parity bytes) on content with large flat/low-AC-energy regions
   (screenshots, UI images) -- even though the underlying raw bit-error rate was still only
   ~1%, comfortably within plain blind-correction capacity. Fixed by retrying without erasure
   hints when erasure-assisted decode fails, in both `dct_variants.py::decode_dct_qim` and
   `stego_qim.rs::unwrap_payload`.

Result after both fixes, run through the actual compiled Rust CLI (not just the Python
prototype): **45/45** -- 9 cover types x all 5 platforms (WhatsApp, Instagram, Telegram,
Facebook, Twitter).

### Update: invisibility was never actually measured -- it should have been

All tuning to this point optimized `QIM_DELTA` purely for bit-error rate. Visually
inspecting output images (the same scrutiny that caught the dot-scheme visibility bug in
`ROBUSTNESS_PORT_NOTES.md`) found `QIM_DELTA=32` produces genuinely visible graininess on
flat/low-detail covers (screenshots, UI images) -- confirmed against a same-pipeline,
no-embedding baseline (identical resize + JPEG quality, zero QIM changes) to rule out JPEG
compression artifacts as the cause. Measured PSNR against that baseline: **~26dB across
every cover type tested**, not just flat ones -- below the ~30dB threshold generally
considered "fine" in watermarking literature, let alone the ~40dB+ considered imperceptible.

Re-swept delta with PSNR measured alongside robustness at every step (not just BER): 14 is
the exact floor for full 45/45 robustness; settled on **`QIM_DELTA=16`** for a small safety
margin, which still gets 45/45 while roughly halving the visible error (~32dB PSNR, plus
visibly cleaner on direct inspection). The redundancy/permutation/erasure-fallback fixes
made since the original delta=32 sweep meant far less raw signal margin is actually needed
than that first BER-only sweep assumed.

### How to reproduce

```bash
python sweep_delta.py          # original BER-only sweep (what produced delta=32)
# PSNR-vs-robustness re-tune: see the delta re-tune commit for the measurement script
```

### The shipped app, not just the prototype

Earlier revisions of this document noted the Python prototype was validated
but the Rust port (`src-tauri/src/stego_qim.rs`) hadn't been compiled or
tested. That's since been resolved: the Rust CLI now builds cleanly
(`cargo build --release --bin stegstr-cli`) and every number above from the
45/45 extended matrix onward was run through the actual compiled binary, not
just the Python prototype. It's also been confirmed against two real
platforms directly (not simulated): an embedded photo was sent through real
WhatsApp and Instagram, downloaded from the receiving side, and decoded
byte-for-byte correctly on both -- see `../ROBUSTNESS_PORT_NOTES.md` for the
full build/verify instructions. (A later control experiment narrowed exactly
what the WhatsApp half of this claim is entitled to say -- see "Live re-test
after Phase 4" below: the file passed through unmodified rather than being
recompressed and surviving it. Instagram's result there is a genuine
recompression-survival result.)

### Two more checks: camera-realistic covers, and SSIM (not just PSNR)

**Every test above used programmatically-generated (PIL-drawn) cover images** -- circles,
gradients, noise -- never a photo that had already been through a real camera's own JPEG
encoder. A genuine camera photo carries its own compression artifacts and sensor noise
before Stegstr ever touches it, which synthetic sources don't have. Approximated this by
pre-compressing existing covers once at typical phone-camera settings (JPEG Q92, 4:2:0)
*before* using them as embed covers, then running the full platform matrix: **15/15
passed** (3 covers x whatsapp/instagram/facebook/twitter/telegram). Real camera photos are
also almost never mathematically flat like the synthetic "smooth" worst case below, so
this is a meaningfully closer proxy to real usage than the synthetic set alone.

**Invisibility was only measured with PSNR (page/section above); added SSIM** (structural
similarity, generally considered a better match to human perception than PSNR alone) for a
second, independent check:

| Cover | PSNR | SSIM |
|---|---|---|
| textured | 32.8 dB | 0.84 |
| portrait | 33.0 dB | 0.71 |
| smooth (worst case) | 33.1 dB | 0.70 |

SSIM of 0.70-0.84 is "good" but not "excellent" (>0.95) -- direct visual inspection of the
smooth-gradient worst case confirms a faint grain is still present, less pronounced than
before the delta=32->16 retune but not eliminated. This is an honest limitation, not a bug:
DCT-coefficient steganography fundamentally needs *some* natural high-frequency detail to
mask modifications within, and a mathematically flat gradient has almost none -- this is
true of any coefficient-domain steganography technique, not specific to this
implementation. Real photos (the actual, typical use case) have far more natural texture
than this deliberately-adversarial synthetic worst case, and score better (textured: 0.84
SSIM) even before accounting for that. Not further tuned beyond this point given the
robustness/invisibility tradeoff already made (see the delta re-tune above) and that the
worst case here is not representative of typical real-world cover photos.

---

## Re-verified post Phase-1-bugfix campaign, against the actual Rust CLI (SIMULATED channels, not the Python prototype)

**This section is simulated-channel testing, like everything else in this
file above it except the "two real platforms" paragraph just above (which
is explicitly marked as such) -- no image in this section was actually
uploaded to or downloaded from WhatsApp, Instagram, Facebook, Twitter, or
Telegram.** `channel.py`'s `simulate()` approximates what each platform's
own re-encoding does (resize to the platform's known max width, re-encode as
JPEG at the platform's known quality/chroma-subsampling settings) entirely
locally, no network involved. It is a well-validated proxy (see the "two
real platforms" paragraph above, where the same simulated WhatsApp/Instagram
profiles were cross-checked against genuine uploads and matched), but it is
still a proxy, not a live-platform test, and this section's numbers should
never be read as "sent through real WhatsApp/Instagram/etc." Telegram in
particular has never been tested live at all (see `STEGSTR_ENTRY_V3.md`
Part 2's "Close the Telegram gap" -- still open).

The results above (this file, up to this point) were measured using
`dct_variants.encode_dct_qim`/`decode_dct_qim` -- the Python prototype the
Rust `stego_qim.rs` implementation was ported from, not the shipped binary
itself. BUGS.md documents a bugfix campaign that touched `stego.rs` (DWT/PNG
path: bugs #1, #2, #4, #5) and `stego_qim.rs`'s libjpeg FFI cleanup layer
(bug #3 -- a resource-leak fix with no change to the QIM encode/decode math
itself). None of those fixes changed the QIM algorithm's actual coefficient
read/write logic, but "should be unaffected" is not the same as "verified,"
so re-ran the simulated-channel survival matrix against the **actual,
current `stegstr-cli --robust` binary** end-to-end (not the Python
prototype) -- see `run_matrix_rust_cli.py`.

Covers: the original 4 (`textured`, `highfreq`, `smooth`, `portrait`) plus 5
more from `covers_extended/` (`high_contrast`, `low_light`, `screenshot`,
`phone_portrait`, `narrow_tall`) -- 9 covers x 5 simulated channel profiles
(whatsapp, instagram, facebook, twitter, telegram) = 45 combinations.

**Result: 45/45 passed.** Simulated WhatsApp/Instagram/Facebook/Twitter/
Telegram-profile survival holds after the Phase 1 bugfix campaign, confirmed
against the real shipped binary (not assumed from the fixes' scope) -- but
still simulated, not a live-platform re-test.

```
cover                  whatsapp   instagram  facebook   twitter    telegram
-----------------------------------------------------------------------------
textured.png           PASS       PASS       PASS       PASS       PASS
highfreq.png           PASS       PASS       PASS       PASS       PASS
smooth.png             PASS       PASS       PASS       PASS       PASS
portrait.png           PASS       PASS       PASS       PASS       PASS
high_contrast.png      PASS       PASS       PASS       PASS       PASS
low_light.png          PASS       PASS       PASS       PASS       PASS
screenshot.png         PASS       PASS       PASS       PASS       PASS
phone_portrait.png     PASS       PASS       PASS       PASS       PASS
narrow_tall.png        PASS       PASS       PASS       PASS       PASS
```

Reproduce: `cd channel_simulator && python run_matrix_rust_cli.py` (requires
`cargo build --release --bin stegstr-cli` first).

---

## Phase 4: adaptive per-cover QIM delta -- honest before/after

The known weak point above (flat covers scoring ~0.70 SSIM at the uniform
`QIM_DELTA=16`) is addressed by making delta per-cover-adaptive: flat covers
(average mid-frequency AC coefficient magnitude below a threshold, computed
before any embedding touches the cover) use `QIM_DELTA_FLAT=12`; everything
else keeps the original 16. The chosen tier is written into the header (not
guessed at decode time -- see the design-choice discussion below) so decode
always knows exactly which delta was used.

**Scope note, stated plainly:** the brief asked for PER-8x8-BLOCK adaptive
strength. What shipped is PER-COVER (whole-image) adaptive strength instead.
QIM's bit detection needs the *exact* delta used at embed time for a given
coefficient -- decode cannot reliably re-derive "was this specific block
flat" from coefficients that have since been modified by our own embedding
and, for real use, requantized by a platform's JPEG re-encode. A wrong-delta
read isn't degraded, it's close to random noise for that coefficient.
Literal per-block adaptivity would need either a large explicit side-channel
(a delta-tier bit per block -- plausibly thousands of blocks, more overhead
than most real payloads) or a resync mechanism trusted enough to bet payload
integrity on. Neither was attempted. Per-cover adaptivity still directly
targets the measured problem (flat *covers* score badly, which is what was
actually measured and reported) at a granularity that's always exactly
decodable. See `src-tauri/src/stego_qim.rs`'s `DELTA TIERS` comment block
for the full reasoning in-line with the code.

### Before/after, per cover (actual Rust CLI, `--robust`, `covers/` + `covers_extended/`)

Baseline for PSNR/SSIM is the same resize+JPEG-quality-80 pipeline with zero
QIM changes (isolates the embedding's own visual cost from ordinary JPEG
compression artifacts a cover has regardless of Stegstr). Survival = how
many of the 5 simulated platform channels (WhatsApp/Instagram/Facebook/
Twitter/Telegram) decoded correctly.

| cover | PSNR before | SSIM before | PSNR after | SSIM after | delta SSIM | survival before | survival after |
|---|---:|---:|---:|---:|---:|---:|---:|
| highfreq (busy, unaffected) | 27.72 | 0.979 | 27.72 | 0.979 | +0.000 | 5/5 | 5/5 |
| narrow_tall (busy, unaffected) | 25.41 | 0.768 | 25.41 | 0.768 | +0.000 | 5/5 | 5/5 |
| textured | 31.70 | 0.796 | 33.66 | 0.855 | +0.059 | 5/5 | 5/5 |
| portrait | 32.27 | 0.673 | 34.57 | 0.766 | +0.093 | 5/5 | 5/5 |
| smooth (the ~0.70 worst case) | 32.42 | 0.662 | 34.72 | 0.758 | +0.096 | 5/5 | 5/5 |
| high_contrast | 32.29 | 0.688 | 34.49 | 0.775 | +0.087 | 5/5 | 5/5 |
| low_light | 32.16 | 0.700 | 34.36 | 0.786 | +0.086 | 5/5 | 5/5 |
| phone_portrait | 29.67 | 0.618 | 31.88 | 0.717 | +0.099 | 5/5 | 5/5 |
| screenshot | 29.97 | 0.587 | 32.12 | 0.686 | +0.099 | 5/5 | 5/5 |

**Result: the specific flat/featureless-cover weak point this phase targeted
(`smooth`: 0.662 SSIM) improved to 0.758 -- a real, meaningful gain, roughly
matched across every cover that classified as flat (+0.06 to +0.10 SSIM),
with zero simulated-platform survival cost on this 9-cover x 5-platform
corpus (45/45 both before and after).** `highfreq` and `narrow_tall` (busy
covers, correctly classified into the unchanged default tier) show no
change, as expected -- they were never the problem this phase targeted.

### The tradeoff curve that produced QIM_DELTA_FLAT=12, and why it isn't monotonic

Requested explicitly: don't pick a setting quietly. Delta tuning against the
Python prototype (`sweep_delta_per_cover.py`) suggested 10 was safe (every
cover but `highfreq` survived all 5 platforms down to delta=8). Shipping
delta=10 against the **actual Rust binary** broke 7/45 on the simulated
Telegram channel specifically -- caused by the real binary's larger header
(24 bits: tier byte + length, vs. the Python prototype's 16-bit length-only
header) shifting which physical coefficients the fixed permutation assigns
to header vs. body, which the Python-side sweep never modeled. Re-swept
against the real binary directly:

| QIM_DELTA_FLAT | primary corpus (9 covers x 5 platforms) | extra corpus (hard covers x 5 platforms x 2 payload sizes) |
|---:|---|---|
| 10 | 38/45 (7 failures, all simulated Telegram) | not tested (already worse than 12) |
| 12 | **45/45** | **79/80** (1 failure: literal solid-color cover on simulated WhatsApp) |
| 14 | 39/45 (6 failures, all simulated Telegram) | 72/80 (8 failures, all simulated Telegram) |
| 16 (= default, no adaptivity) | 45/45 | not tested (this is the unmodified baseline) |

**14 failing where both 12 and 16 succeed is the important, counterintuitive
result here: this is not a smooth "smaller delta = more risk" curve.** Some
specific delta values interact badly with a specific platform's JPEG
requantization step size at that specific quality setting in a way that
doesn't reduce monotonically. QIM_DELTA_FLAT=12 is the value that tested
clean, not a value derived from a formula -- re-tuning this constant without
re-running `run_matrix_rust_cli.py` (and ideally `run_matrix_rust_cli_extra.py`)
against the real binary would be re-introducing exactly the gap this section
documents.

### Known residual limitation

`pure_solid_white.png` (a literal solid color, 0.0 average AC magnitude --
the absolute floor, not just "low") failed to survive simulated WhatsApp
(quality=65, the harshest platform tested) even at delta=12. This is 1 of
125 total cover x platform x payload combinations tested across both
corpora (`run_matrix_rust_cli.py` + `run_matrix_rust_cli_extra.py`). No real
photo is ever truly zero-variance -- sensor noise alone prevents it -- so
this is documented as a known gap rather than chased with further delta
tuning, especially given the demonstrated non-monotonic behavior above makes
further tuning risky without extensive re-validation.

### Reproduce

```bash
cd channel_simulator
python adaptive_delta_report.py       # before/after PSNR/SSIM/survival table
python run_matrix_rust_cli.py         # primary 9-cover x 5-platform matrix
python run_matrix_rust_cli_extra.py   # hard-covers stress + larger payload
```
All three require `cargo build --release --bin stegstr-cli` first, and
`adaptive_delta_report.py`'s "before" column requires temporarily rebuilding
with `QIM_DELTA_FLAT` set equal to `QIM_DELTA_DEFAULT` (16) in
`src-tauri/src/stego_qim.rs` to disable adaptivity for comparison.

---

## Live re-test after Phase 4: three real sends, plus a WhatsApp control experiment

The Phase 4 adaptive-delta change alters what gets embedded, so the earlier
live-platform confirmation (`ROBUSTNESS_PORT_NOTES.md`, WhatsApp + Instagram)
needed re-running against the current binary, not assumed to still hold.
This round also asked a sharper question the earlier one didn't: when a
platform returns a file byte-identical to what was sent, does that mean the
embedding *survived recompression*, or that *no recompression happened at
all*? Those are different claims, and only a control image (no embedding,
sent the same way) can tell them apart.

### Method

Built the current release CLI (`cargo build --release --bin stegstr-cli`,
this session's binary, includes the Phase 4 adaptive delta and the header-
versioning fix from `BUGS.md` #8). Embedded a single fixed, randomly-noned
payload (`STEGSTR-LIVE-TEST-2026-08-26-d154705a3226`, see `live_test/PAYLOAD.txt`)
into three **real camera-realistic JPEG photos** -- not this repo's synthetic
generated covers, but genuine photographic images (OS-bundled default
wallpaper photography, not PIL-drawn) -- via
`stegstr-cli embed <cover> -o <out> --robust --payload "<msg>"`
(`Robustness::Max`: the default `--robust` implies). Sent each through the
identical manual path a real user would use (WhatsApp Web, Instagram) and
brought the received file back for byte-exact size comparison and decode.
Telegram was prepared identically but not yet sent live -- see below, still
simulated for that platform.

### Result: WhatsApp and Instagram

| file | sent | received | Δ | decode |
|---|---:|---:|---:|---|
| `send_whatsapp.jpg` | 14,486 B | 14,486 B | +0 B | **PASS** |
| `send_instagram.jpg` | 48,241 B | 52,609 B | +4,368 B (+9.1%) | **PASS** |
| `send_telegram.jpg` | 26,321 B | -- not sent live this round -- | -- | simulated only |

Both received files decode to the exact original payload via the current
binary. **These are two different kinds of result and should not be
described the same way:**

- **Instagram is a genuine survival result.** The file changed size, meaning
  Instagram's own pipeline actually re-encoded it, and the payload survived
  that real recompression. This is the claim "survives Instagram
  recompression" is actually entitled to.
- **WhatsApp came back byte-identical -- which is not, by itself, evidence
  of survival.** A byte-identical round trip is equally consistent with two
  very different mechanisms: (a) WhatsApp recompressed the file and,
  coincidentally or otherwise, produced the exact same bytes, or (b)
  WhatsApp's pipeline didn't touch the file at all because it was already
  compliant with whatever threshold triggers its own recompression. Without
  a control, "decoded correctly after being byte-identical" cannot
  distinguish these, and only one of them is actually a robustness result.

### The control test

Sent an **untouched, unembedded, original cover photo** -- the same photo
`send_whatsapp.jpg` was made from, 1920x1200, 393,630 bytes, verified
byte-for-byte identical to the OS source file by SHA-256 before sending
(`live_test/control/control_whatsapp_original.jpg`) -- through the identical
WhatsApp Web path.

**Result: the control came back at ~94KB, a ~76% size reduction.** WhatsApp's
pipeline does recompress images that need it. Since the *same path*
recompressed a 393,630-byte original by ~76% but left our 14,486-byte stego
file completely untouched, mechanism (a) above is ruled out and (b) is
confirmed: **the stego file wasn't put through recompression and made to
survive it -- it was already small/compliant enough that WhatsApp's own
pipeline treated it as a no-op.**

**Precise statement of what's proven:** `--robust`'s pre-conditioning
(resize to 576px on the longer side, JPEG re-encode at quality 80 -- see
below) puts its output below whatever size/dimension threshold triggers
WhatsApp's own recompression, so the file passes through the path
unmodified. This is **not** the same claim as "survives WhatsApp
recompression" -- that would require WhatsApp to have actually re-encoded
the file and the payload to still decode afterward, which is precisely what
did *not* happen here (WhatsApp never touched it) and precisely what *did*
happen with Instagram above. Do not conflate the two in any summary of this
result: WhatsApp is a pass-through result, Instagram is a survival result.

This doesn't mean WhatsApp support is weaker -- a file WhatsApp never
recompresses is at zero risk from WhatsApp's recompression, which is a
perfectly good practical outcome for a user sending a photo. It means the
correct claim is narrower and more precise than "survives WhatsApp
recompression," and the simulated WhatsApp channel profile in this file's
matrices above (quality 65, resize) — which genuinely does recompress every
image it's given, precisely because a local simulator has no threshold logic
to skip below — remains the only evidence for surviving an *actual*
WhatsApp-style recompression pass, not a live confirmation that WhatsApp
itself ever performs one on Stegstr's typical output size.

### The 576px pre-resize: a stated tradeoff, with real capacity numbers

`--robust` (`Robustness::Max`) always shrinks the cover to **576px on the
longer side** before embedding, then re-encodes at **JPEG quality 80**
(`stego_qim.rs`, `QIM_EMBED_QUALITY`) -- this is what makes recompression a
guaranteed no-op for every target platform's own resize step (see "What
changed vs. the initial QIM prototype" above), and, per this section, is
also apparently what keeps WhatsApp specifically from touching the file at
all. The tradeoff is real: a photo sent through Stegstr is delivered at a
fraction of its original resolution regardless of how large the source was
-- the 1920x1200 control photo above would come out at 576x360, a ~90%
pixel-count reduction, even before any platform touches it.

That resolution ceiling also caps how much payload fits. Measured directly
against the compiled binary (binary search on `--payload` length until
`embed` starts failing with "Payload too large"), not estimated from the
formula:

| cover (post-resize) | measured capacity |
|---|---:|
| 576x360 (16:10 landscape photo, e.g. the control cover here) | 903 bytes |
| 576x576 (square) | 1,513 bytes |

Capacity scales with resized pixel count, not with `--robust`'s 576px figure
alone -- a narrower-aspect cover has fewer total coefficients after the same
longer-side cap. Both numbers comfortably exceed a typical Nostr note (the
542-byte realistic payload used earlier in this file) but are worth knowing
explicitly before assuming a large bundle (e.g. the 1187-byte 5-recipient
NIP-04 envelope noted in `ROBUSTNESS_PORT_NOTES.md`) fits every cover shape.

### Telegram: still simulated

Telegram was prepared identically (`send_telegram.jpg`, embedded and
pre-send-verified) but not sent through a real Telegram client this round.
Its row in every matrix in this file, and the "45/45" and "79/80" results
above, remain simulated-channel-profile results only. Closing this is still
open (`STEGSTR_ENTRY_V3.md` Part 2, "Close the Telegram gap").

### Reproduce

`live_test/` (repo-root, gitignored via `.git/info/exclude`) has the exact
covers, payload, and a `decode_received.sh` that PASS/FAILs anything dropped
into `live_test/received/` against `live_test/PAYLOAD.txt`.

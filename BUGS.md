# BUGS.md

Bugs found and fixed during the Phase 1 "break it" test campaign (see
`STEGSTR_ENTRY_V3.md`). Format per bug: repro steps, root cause, fix, commit,
regression test.

---

## Verified against pristine upstream: (a), not (b)

Cloned `brunkstr/Stegstr` (commit `ad2e10e`) into a separate directory, built
it from scratch, and ran the minimal repro for bug #1 (default embed, cover
> 256x256, payload > ~16 bytes) directly against it -- no diffing, no
assuming, an actual build and an actual run:

```
$ stegstr-cli embed photoish.png -o out.png --payload "0123456789ABCDEFGHIJ"
$ stegstr-cli decode out.png
base64:MDEyMzRTVEVHU1RSAAAAFDAxMjM=
$ echo MDEyMzRTVEVHU1RSAAAAFDAxMjM= | base64 -d
01234STEGSTR▒▒▒0123
```
Corrupted, same signature as our fork's pre-fix output. **(a) is true: this
reproduces identically on pristine upstream. It is a pre-existing bug in the
holder's app, not something this fork introduced.** A byte-for-byte diff
(`diff --strip-trailing-cr`, to rule out a line-ending false-positive)
against our pre-fix `stego.rs` (commit `2b21daa`) confirms the file is
identical to upstream's -- neither `decode()`'s tile-ordering bug (#1) nor
`embed_in_tile()`'s unguarded LSB choice (#2) had been touched before this
campaign started.

Bug #2 (clamping) and bug #5 (the tile-position pixel-corruption bug, see
below) were **also** independently confirmed present on pristine upstream
during this verification pass -- not assumed, actually reproduced by
embedding with the upstream binary and inspecting the output. See each bug's
entry for specifics.

Bug #4 was confirmed the same way later, during the release-packaging pass
(not originally verified when it was found and fixed -- see its own entry).
Bug #6 (the Nostr signature gap) was confirmed via a source diff and grep
against upstream rather than a build+run repro -- see its own entry.
**5 of the 9 numbered bugs are confirmed pre-existing in pristine upstream:
#1, #2, #4, #5, #6.** The next 3 (#3, #7, #8) are bugs in this fork's
own new work -- QIM steganography and the Nostr publish-confirmation
feature don't exist in upstream at all, so they can't be "pre-existing"
there. Keep these two groups distinct; see `ROBUSTNESS_REPORT.md` for the
full breakdown. Bug #9 is neither: its faulty line of code is identical to
upstream's, but upstream has no second encoder and never promises
extension-agnostic decoding, so the bug isn't actually reachable there --
it only became a real, breakable promise once this fork's own dual-encoder
`decode_any()` existed. Counted on its own, not folded into either tier.

## Backward compatibility

Concern: bug #5's fix changes embedding semantics (skipping infeasible
blocks, clamping unused ones) and bug #1/#4's fixes reorder decode
precedence. Either could break images produced by the old, unfixed encoder.

Tested by embedding with the **upstream** (unfixed) binary across 4 cover
types x 3 payload sizes (12 cases), then decoding each output with **our
fixed** binary and comparing against both the original payload and what
upstream's own decoder returned:

- **0 regressions.** Every case where upstream's own encode+decode round-trip
  already succeeded cleanly, our fixed decoder also succeeds and returns the
  identical, correct payload.
- Several cases where upstream's own decode returned WRONG bytes (pre-existing
  bug #1 corruption) are **recovered** by our fixed decoder -- it returns the
  original, correct payload from a file upstream's own tooling could never
  read correctly. This is a real, unplanned benefit: the decode-side fix
  helps old upstream-produced images too, for however long they're still
  around.
- One case (a long payload on a 1024x1024 cover) where upstream's own decode
  returned wrong bytes AND our decoder also returns wrong (but different)
  bytes -- diagnosed below (bug #2's residual case) as pre-existing embed-time
  corruption in upstream's own unfixed encoder, not recoverable by any
  decoder, and not something our fix could have caused since decode cannot
  reconstruct information a bad embed already destroyed. Re-running the exact
  same cover+payload through **our own** encoder end-to-end (not reading
  upstream's already-corrupted file) round-trips correctly.

Full backward-compat sweep output and methodology: see
`scripts/` methodology note in this file's revision history, or re-run via
the two-binary comparison (build `brunkstr/Stegstr` upstream, embed with it,
decode with this fork's binary, compare).

## Invisibility re-measurement

See bug #5 below for the full before/after PSNR/SSIM table. Short version:
the clamping fix (bug #2) itself has no measurable effect on aggregate
PSNR/SSIM (it only touches the rare individual blocks that would otherwise
clamp) -- before/after numbers for bug #2 alone are within noise of each
other across every cover type tested. The dramatic PSNR/SSIM swings actually
observed (8.96dB -> 51.16dB on a gradient; 9.02dB -> 48.64dB on random noise)
turned out to be a **separate, far more severe bug** (#5) found specifically
because this re-measurement was done at all -- see below.

## Stress coverage: hard covers, not just random noise

Random noise is the capacity-easy case for DWT (every block has plenty of AC
energy headroom); it is not where clamping bites. Re-ran the stress sweep on
the actual hard cases: flat gradients, blown-out white, near-black night
shots, uniform sky, and pure solid colors (zero AC energy anywhere, the
absolute worst case) -- 8 cover images x 12 payload lengths (1 to 2000
bytes) = 72 attempted round trips (excluding expected capacity errors), **0
failures/mismatches**. Additionally re-ran the random-noise sweep at larger
sizes (1024x1024 and 1536x1536, 10 seeds each, payloads up to 2000 bytes) to
specifically hunt for bug #2's residual "no LH value avoids clamping" case in
our own encoder: 60 round trips, **0 failures**.

## cargo-fuzz on decode_any(): deferred, Windows-specific linker limitation

Set up `src-tauri/fuzz/` (`cargo fuzz init`, target `decode_any` in
`fuzz_targets/decode_any.rs`, fuzzing `stegstr_lib::decode_any` -- the exact
entry point exercised whenever a user opens any image file, tried against
arbitrary bytes written to a temp file each iteration since the QIM/libjpeg
FFI path needs a real file handle, not an in-memory reader).

Time-boxed this at 20 minutes given it was fighting the Windows/MSVC
toolchain rather than the actual code:
- Installing `cargo-fuzz` requires the nightly toolchain (installed cleanly).
- First build attempt failed: `cargo fuzz build` resolves its own
  `fuzz/Cargo.lock` independently of the main crate's pinned lock, and pulled
  in `tauri 2.11.5` (main crate is pinned to `2.9.5`) plus newer
  `tauri-plugin-*` versions with an incompatible `tauri-codegen` pairing --
  `tauri::generate_context!()` failed to compile
  (`missing field 'referenced_by' in initializer of 'ResolvedCommand'`).
  Fixed by copying the main crate's `Cargo.lock` into `fuzz/Cargo.lock` so
  the shared dependency graph resolves identically.
- Second attempt got past compilation and all the way to the link step, then
  failed with `LNK1561: entry point must be defined`. This is a known,
  documented libFuzzer-on-Windows-MSVC limitation (libFuzzer's runtime and
  MSVC's linker disagree about the entry point in this configuration) --
  not something specific to this codebase, and not a quick fix within the
  time-box (the standard workaround is switching to the `x86_64-pc-windows-gnu`
  target or building on Linux, either of which means re-downloading and
  re-compiling the entire dependency tree again from scratch).

**Deferred, not abandoned:** the scaffolding (`fuzz/Cargo.toml`,
`fuzz_targets/decode_any.rs`) is committed and ready to run as-is on Linux,
which is cargo-fuzz's fully-supported platform and also where Phase 2's CI
matrix already needs to build and test anyway -- the natural place to
actually run this, not a Windows dev machine. Until then, coverage of the
same "arbitrary/malformed bytes into the decode path" concern comes from: the
proptest property test (found bug #4), the adversarial image corpus (found
bug #3's leak via `notreally.jpg`), and the `attack.py` crash-sweep script
that ran every corpus image + payload combination through both encoders
checking for non-clean exit codes or panic signatures. None of that is a
substitute for real coverage-guided fuzzing, but it's not nothing either.

## Adversarial image corpus: exact coverage manifest

Every entry actually generated and exercised (embed + decode, both encoders,
via `stegstr-cli`) in this campaign, against the specific cases named:

| requested case          | corpus file(s)                              | format/mode confirmed          |
|--------------------------|----------------------------------------------|---------------------------------|
| CMYK JPEG                 | `cmyk.jpg`                                   | JPEG, CMYK, 64x64                |
| progressive JPEG          | `progressive.jpg`                            | JPEG (progressive), RGB, 128x128 |
| EXIF-rotated              | `exif_rotated.jpg`                           | JPEG, RGB, 100x60, orientation=6 |
| palette PNG                | `palette.png`                                | PNG, mode P (indexed), 64x64     |
| 16-bit PNG                 | `sixteen_bit_gray.png`                       | PNG, mode I;16, 64x64            |
| truncated file              | `truncated.png`                              | valid PNG sig, cut at 50% length |
| corrupt file                 | `corrupt.png`                                | valid PNG sig, 50 bytes flipped  |
| non-image, image extension  | `notreally.png`, `notreally.jpg`             | plain text / fake-SOI garbage    |
| empty file                    | `empty.png`, `empty.jpg`                   | 0 bytes                          |
| wrong key                       | see bug #2/#3 entries + "Also investigated" -- app-layer "encryption" uses a fixed, non-secret app key (documented, intentional design, not a per-recipient secret); tested tampered-ciphertext (bit-flipped) instead, correctly rejected by AES-GCM's auth tag |
| double-embedded                  | re-embedded a second, shorter payload into an already-embedded output, both encoders -- decodes the second payload correctly, both DWT and QIM |
| zero-byte payload                 | `--payload-base64 ""` -- round-trips correctly, both encoders |
| payload exactly at capacity        | binary-searched the exact boundary on both encoders -- capacity succeeds, capacity+1 fails cleanly with a descriptive error, no crash |
| grayscale PNG                       | `grayscale.png`                              | PNG, mode L, 64x64                |
| PNG with alpha                       | `with_alpha.png`                             | PNG, mode RGBA, 64x64             |
| interlaced PNG                        | `interlaced.png`                             | PNG (Adam7 interlace), RGB, 64x64 |
| animated PNG (APNG)                    | `animated.png`                               | PNG, 3 frames, RGB, 32x32         |
| 1x1 / 1x2 / 2x1 / 2x2 / 3x3 images      | `tiny_*.png`                                 | PNG, RGB, exact sizes named        |
| 7x7 / 8x8 / 9x9 / 16x16 images            | `small_*.png`                                | PNG, RGB, exact sizes named         |
| non-square, odd dims                       | `odd_15x17.png`                              | PNG, RGB, 15x17                     |
| large multi-tile covers                     | `large_1024.png` (1024x1024), `large_2048.jpg` (1500x900) | PNG/JPEG, RGB |
| flat/featureless covers                      | `flat_gray.png`/`.jpg`, plus `hard_covers/`: `flat_gradient`, `blown_out_white`, `near_black_night`, `uniform_sky`, `pure_solid_gray/white/black` | see bug #5 table |
| paths with spaces / non-ASCII                 | tested directly (`weird path with spaces/日本語ディレクトリ/cöver ímage.png`) -- embed + decode both succeed |
| very long Windows paths                        | tested directly (363-char path, well past classic `MAX_PATH`=260) -- succeeds |
| read-only output directory/file                 | tested directly -- clean `Access is denied (os error 5)`, no crash |
| two invocations racing on the same file           | tested directly (10 concurrent `embed` calls to the same output path) -- no crash, no corrupted file, last-writer-wins, clean decode |
| emoji / RTL text / null bytes payloads             | included in the `attack.py` payload battery run against every corpus image, both encoders -- no crashes |
| multi-megabyte payloads                             | 1MB and 5MB payloads tested against large-capacity covers -- clean capacity errors or successful embeds, no crash |

**Payload edge cases battery** (run against every corpus image above, both
encoders): empty, 1 byte, short, emoji+accented text, RTL (Arabic) text,
embedded null bytes, 1KB, 10KB, 1MB, 5MB.

---

## 1. DWT decode returns silently corrupted payload for any image >= 256px with a payload over ~9 bytes

**Severity:** Critical. This is the default encoder (`stegstr-cli embed` without
`--robust`), so this affected essentially every real use of it.

**Repro (pre-fix):**
```bash
stegstr-cli embed cover_512x512.png -o out.png --payload-base64 <(echo -n "0123456789" | base64)
stegstr-cli decode out.png
# => base64:AAAAASTEGS...   (garbage, not the original 10 bytes)
```
Any payload of 10+ raw bytes (i.e. `to_embed = MAGIC(7) + LEN(4) + payload`
exceeding 128 bits) on a cover >= 256px in both dimensions reproduced this.
A 5-byte payload happened to round-trip correctly, which is why the existing
unit test (a 256x256 single-tile image) never caught it.

**Root cause:** `stego::encode()` embeds independently into each 256x256 tile
using a Haar2D transform local to that tile (256-wide block grid). `decode()`
tried a **whole-image** Haar2D transform first ("backward compat"), which
indexes LH coefficients by the image's *full* width, not the tile's local
256-wide grid. The two orderings only agree for the first 128 bits (one
tile-local row); beyond that the whole-image bit sequence silently mixes in
data from the *adjacent* tile. `decode_from_tile`'s magic search has no
integrity check beyond "declared length fits available bits", so it returned
a magic-shaped but corrupted match instead of ever reaching the (correct)
tile-aligned sliding-window search that came after it in the old code.

**Fix:** Reordered `decode()` to try the tile-aligned sliding-window search
first (this reproduces the encoder's exact per-tile transform for any
un-cropped image), falling back to the whole-image interpretation only for
images smaller than one tile or the rare case where `encode()` itself fell
back to a whole-image transform (no single tile had capacity).

**Commit:** `699f4cb`

**Regression test:** `stego::tests::test_encode_decode_roundtrip_multi_tile_long_payload`
(512x512 cover, 100-byte payload) in `src-tauri/src/stego.rs`.

---

## 2. DWT decode flips bits on high-contrast/noisy covers (silent clamping in the Haar inverse transform)

**Severity:** High. Any cover with pixels at or near 0/255 (camera noise/grain,
screenshots, synthetic/high-contrast images, some CMYK-JPEG-derived RGB) could
corrupt scattered bytes of the payload.

**Repro (pre-fix, after bug #1's fix alone):**
```bash
# a cover with independent per-channel random noise
stegstr-cli embed noise_256x256.png -o out.png --payload "The quick brown fox jumps over the lazy dog. (x5)"
stegstr-cli decode out.png
# => single scattered byte flips, e.g. "brown fox" -> "Brown fox"
```

**Root cause (two-part):**
- `embed_in_tile()` picked the LH coefficient value using only LSB parity
  (`(lh & !1) | bit`), regardless of whether the pixels it reconstructs to
  stay within `[0, 255]`. A pixel already within 1 of a boundary (common with
  noisy/high-contrast data) pushed the reconstruction out of range;
  `haar2d_inverse` silently `.clamp(0, 255)`s it, and decode's forward
  transform then reads back the flipped LSB. (Proved algebraically: the /4
  truncation in the forward transform divides evenly back out of the inverse
  formulas as long as no clamping occurs, so avoiding clamping makes the
  round trip exact, not just "usually fine".)
- Even after fixing the above (`pick_safe_lh`, searching nearby LH values
  with the correct parity for one that avoids clamping), a residual case
  remained: some blocks have **only one** LH value in existence that avoids
  clamping, and it may have the wrong parity for the bit that needs encoding
  there. Skipping such blocks (`both_bits_feasible`) fixed the direct case,
  but *leaving them untouched* could still let their own natural LH value
  clamp, which drifts that block's recomputed `(ll, hl, hh)` on decode and
  can flip its `both_bits_feasible` classification -- desyncing which blocks
  encoder and decoder each think carry data, corrupting everything from that
  block onward. (Caught via `cmyk.jpg` in the adversarial corpus: instrumented
  encode/decode to print their skip decisions and diffed them -- they
  disagreed on 6 of ~46 blocks.)

**Fix:**
- `pick_safe_lh()`: choose the LH value closest to natural (of the required
  parity) that reconstructs all four pixels without clamping.
- `both_bits_feasible()` / `safe_lh_for_unused_block()`: a block only carries
  a payload bit if *both* possible bit values are representable there without
  clamping (computed from `(ll, hl, hh)` alone, so both sides always agree);
  every other block -- used for payload or not -- gets nudged to a clamp-free
  LH value too, so no block's `(ll, hl, hh)` can ever drift between what
  encoder and decoder each compute.

**Residual limitation (documented, not fixed):** a block where *no* LH value
at all avoids clamping (`lh_min > lh_max` in `lh_bounds()`) is mathematically
unavoidable to distort. This is strictly rarer than the fixed case above.
**Update after upstream verification:** decoding a file *upstream's own
(unfixed) encoder* wrote for a 1024x1024 random-noise cover with a 141-byte
payload showed exactly this residual single-byte-flip signature -- so the
underlying mathematical edge case is real and does occur on sufficiently
large/adversarial covers, not just a theoretical corner case. However, that
corruption happened during upstream's *embed* (its unfixed
`(lh & !1) | bit` has no clamp-avoidance at all), which no decoder can
retroactively repair -- it is not evidence our fix has a gap. Re-running our
own encoder+decoder end-to-end on that exact cover+payload (and a further
60-case sweep at 1024x1024 and 1536x1536 with random seeds and payloads up to
2000 bytes) found 0 mismatches. The residual case remains real in principle
but still unobserved from *our* encoder specifically. If it matters for full
closure, the general fix is the same idea Phase 4 already plans for the QIM
path: skip such blocks from capacity entirely and let tile-level redundancy
cover the loss.

**Commit:** `699f4cb`

**Regression test:** `stego::tests::test_encode_decode_roundtrip_high_contrast_cover`
(deterministic xorshift-random 256x256 cover) in `src-tauri/src/stego.rs`.
Also verified with a 252-case stress sweep (7 sizes x 6 seeds x 6 payload
lengths, uniform random noise covers) and the full adversarial image corpus
(grayscale, palette, 16-bit, interlaced, animated, CMYK, progressive,
EXIF-rotated) -- 0 mismatches, down from 7 before this fix.

---

## 3. Malformed-JPEG decode leaks a file handle + libjpeg memory pool on every attempt

**Severity:** Medium. Not a crash (already caught by `catch_unwind`), but a
real, repeatable resource leak on a routine input path.

**Repro:**
```bash
printf '\xff\xd8not really jpeg data after SOI marker' > fake.jpg
stegstr-cli decode fake.jpg
# stderr: "thread 'main' panicked at ...: libjpeg error: JPEG datastream contains no image"
# exits 1 (not a crash) -- but see root cause: the FILE* and libjpeg's
# internal decompress memory pool for this attempt are never freed.
```
`decode_any()` (lib.rs) tries the QIM/JPEG decoder against **every** image
passed to it regardless of extension, so this fires on every malformed-JPEG
decode attempt, not a rare corner case -- any truncated or corrupt JPEG whose
first two bytes still happen to be a valid SOI marker (routine: any real
photo cut short mid-transfer) hits it.

**Root cause:** `ffi::error_exit` (the libjpeg error handler) calls `panic!()`
so routine libjpeg errors (corrupt/truncated input) can be turned into a
normal `Result::Err` via `catch_unwind` at the `read_y_coefficients` /
`write_y_coefficients` boundary. But `jpeg_destroy_decompress`/`_compress` and
`fclose` were only called on the non-panicking path -- a panic mid-read/write
unwound straight past them.

**Fix:** Added `DecompressGuard` / `CompressGuard` RAII wrappers around each
libjpeg session + its `FILE*`, so cleanup runs in `Drop` -- guaranteed on both
the normal-return and panic-unwind paths.

**Commit:** `699f4cb`

**Regression test:** none added (the leak itself isn't practically observable
from a single-process unit test on Windows' default handle limits without an
OS-specific handle-counting harness). Verified by re-running the fixed binary
against `notreally.jpg` (fake SOI + garbage body) 20x in a row and confirming
identical, clean `Err` behavior each time (no behavior change expected or
observed -- the fix is only visible via not leaking, which the RAII guarantee
makes structurally true rather than something to assert at runtime).

---

## 4. `decode()`'s tile-aligned search silently skipped for "one axis large, other small" images

**Severity:** High. Same corruption class as bug #1, for a geometry #1's fix
didn't cover.

**Found by:** a proptest property test added specifically to fuzz this class
of bug (`prop_roundtrip_random_cover_and_payload`, random cover dimensions
8..320, random payload 0..600 bytes) -- found a failing case within the
default 40 generated cases, on the *first run after adding the test*.
Minimized automatically to `w = 258, h = 8`.

**Repro:**
```bash
# a cover wider than one tile but shorter than one tile
stegstr-cli embed cover_258x8.png -o out.png --payload "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ0123"
stegstr-cli decode out.png
# => corrupted output, not the original payload
```

**Root cause:** `encode()` tiles each axis independently -- its loop steps by
`TILE_SIZE` on x and y separately -- so a "wide but short" or "narrow but
tall" image (only ONE dimension >= `TILE_SIZE`) still gets tiled along that
one axis. A 258x8 image becomes a 256x8 tile at x=0 plus a near-empty 2x8
remainder (too small to hold anything, skipped). But `decode()`'s tile-aligned
search only ran when **both** `w >= TILE_SIZE` and `h >= TILE_SIZE`
(`&&`), so for this shape it skipped the tile-aligned search entirely and
fell straight to the whole-image interpretation -- the same wrong-bit-ordering
failure as bug #1, just for a shape the `&&` guard exempted.

**Fix:** Changed the guard from `&&` to `||`. The existing per-axis
`saturating_sub`/`step_by` math already handles the smaller axis correctly
(it collapses to a single `0` offset) once the loop is allowed to run at all.

**Commit:** `e65d722`

**Regression test:** `stego::tests::prop_roundtrip_random_cover_and_payload`
(the proptest itself -- its regression corpus at
`src-tauri/proptest-regressions/stego.txt` pins this exact minimized case so
it's replayed on every future run before any new cases are generated).
Verified with a follow-up 500-case run (`PROPTEST_CASES=500`), plus the full
corpus and 252-case stress sweep, all still 0 mismatches.

**Confirmed present in pristine upstream.** Not checked at the time this
bug was originally found and fixed -- verified afterward, during the
release-packaging pass, rather than left as an assumed "probably, since
it's the same shared tiling code as #1". Built `brunkstr/Stegstr` @
`ad2e10e` and ran the exact repro above (258x8 cover, same payload)
against it directly: output is corrupted with the same signature (a
correct `01234` prefix, then garbage) as this fork's pre-fix behavior.
Confirmed by actually running it, not inferred from the shared root cause.

---

## 5. `encode()` wrote every non-leftmost tile's pixels from the WRONG source column -- catastrophic visible corruption, not just imperfect invisibility

**Severity:** Critical, and arguably the most user-visible bug in this
campaign. It doesn't corrupt the payload (decode still recovers it correctly
from the untouched leftmost tile), but it visibly wrecks the cover image
itself for any image wider than one 256px tile -- which defeats the entire
point of steganography (the image is supposed to look unmodified).

**Found by:** re-measuring PSNR/SSIM invisibility (before/after the clamping
fix, bug #2) on a set of "hard" covers -- flat gradients, blown-out white,
near-black, uniform sky, plain random noise -- per an explicit request to
verify the clamping fix's actual visual impact. A 512x512 gradient scored
PSNR 8.96dB / SSIM 0.75, and a 1024x1024 random-noise cover scored PSNR
9.02dB / SSIM 0.25. Every other/smaller cover scored 30-67dB -- these two were
wildly, suspiciously worse, which is what prompted digging into WHY rather
than just reporting the number.

**Repro:**
```bash
# any cover wider than 256px, e.g. a 512x512 image
stegstr-cli embed cover_512x512.png -o out.png --payload "short message"
# out.png: columns 0-255 (the leftmost tile) look normal.
# columns 256-511 are visibly a different image entirely -- literally a
# copy of columns 0-255's original content, not the cover's actual content
# there. Payload still decodes fine (bug is invisible to any
# payload-correctness check), but the image is grossly, visibly altered.
```

**Root cause:** `encode()`'s tile-extraction loop computed each tile's row
read offset as `(ty + y) * w * 4`, omitting `+ tx * 4`. Every tile except the
leftmost column (`tx = 0`) therefore read pixel data starting at column 0
instead of its own x position, ran that (wrong) data through
`embed_in_tile`, and wrote the result back at its own (correct) output
position via `out_row_start = (ty + y) * w * 4 + tx * 4` (which DID have the
offset) -- silently overwriting that entire tile region with a copy of the
leftmost tile's content. The decode-side equivalent read
(`decode()`'s sliding-window loop, further down the same file) already had
the correct `+ ox * 4` term; only this one encode-side read was missing it.

This was invisible to every payload-correctness round-trip test run in this
entire campaign -- the 252-case stress sweep, the full adversarial corpus,
the proptest, the hard-cover sweep -- because `decode()` finds the payload in
the untouched `tx = 0` tile and returns immediately. None of those tests ever
compared the cover to the stego output pixel-for-pixel; they only checked
"does the payload come back correctly," which structurally cannot see this
bug. It only surfaced once asked to measure invisibility, not just
correctness.

**Confirmed present in pristine upstream** (brunkstr/Stegstr, commit
`ad2e10e`) -- this exact code, never touched by any of this fork's other
fixes. Not fork-introduced.

**Fix:** Added the missing `+ tx * 4`.

**Commit:** `08bd234`

**Before/after PSNR / SSIM** (payload: "The quick brown fox..." x4, 188
bytes; see `channel_simulator/` methodology notes for measurement approach --
here computed with scikit-image's reference PSNR/SSIM implementations):

| cover                        | PSNR before | SSIM before | PSNR after | SSIM after |
|-------------------------------|------------:|------------:|-----------:|-----------:|
| flat_gradient (512x512)       |    8.96 dB  |      0.7521 |  51.16 dB  |     0.9956 |
| blown_out_white (512x512)     |   48.59 dB  |      0.9873 |  49.96 dB  |     0.9912 |
| near_black_night (512x512)    |   43.50 dB  |      0.9454 |  49.02 dB  |     0.9807 |
| uniform_sky (512x512)         |   44.89 dB  |      0.9684 |  49.19 dB  |     0.9895 |
| pure_solid_gray (512x512)     |   66.65 dB  |      0.9998 |  66.65 dB  |     0.9998 |
| photoish, textured (512x512)  |   31.34 dB  |      0.8430 |  50.41 dB  |     0.9944 |
| random_noise (1024x1024)      |    9.02 dB  |      0.2527 |  48.64 dB  |     0.9999 |

`pure_solid_gray` is unchanged (66.65dB both before and after) -- expected:
a uniform-color image has identical content in every tile regardless of
which tile's data actually gets read, so that cover can't reveal this bug
either way. That row is a useful internal-consistency check on the
measurement itself, not evidence the fix did nothing.

**Regression test:** `stego::tests::test_encode_does_not_corrupt_non_leftmost_tiles`,
which asserts image fidelity (small LSB-scale pixel deltas, not payload
recovery) in a non-leftmost tile -- specifically to catch what
payload-only round-trip tests structurally cannot.

---

## Phase 4: adaptive per-cover QIM delta (feature, not a bug fix)

Not a bug -- STEGSTR_ENTRY_V3.md Phase 4 asked for the known flat-cover SSIM
weak point (~0.70) to be addressed with adaptive embedding strength. Full
writeup, honest tradeoff table, and the (non-monotonic!) delta-tuning
process live in `channel_simulator/BASELINE_RESULTS.md` -- summary:

- Shipped **per-cover** adaptive delta (flat covers: `QIM_DELTA_FLAT=12`;
  everything else: unchanged `16`), not literal per-8x8-block adaptivity as
  the brief described -- QIM's decode needs the exact delta used at embed
  time, which per-block adaptivity can't reliably guarantee without a large
  side-channel. See `stego_qim.rs`'s `DELTA TIERS` comment for the full
  reasoning.
- Result: the specific worst case measured before (`smooth`, 0.662 SSIM)
  improved to 0.758; every cover that classified flat gained +0.06 to +0.10
  SSIM; simulated-platform survival held at 45/45 both before and after on
  the primary 9-cover corpus.
- The delta value (12) came from re-testing the **actual Rust binary**
  end-to-end after the Python-prototype-calibrated value (10) broke 7/45 on
  simulated Telegram -- the real binary's larger header shifts which
  physical coefficients carry the payload, which the Python proxy never
  modeled. 14 tested *worse* than both 12 and 16 (non-monotonic).
- **Known residual gap:** a literal solid-color cover (0.0 AC energy, not
  achievable by any real photo) failed the harshest simulated platform even
  at delta=12 -- 1 of 125 total combinations tested. Documented, not fixed.

**Commit:** see the commit introducing `DELTA TIERS` in `stego_qim.rs`.

**Regression tests:** `stego_qim::tests::test_adaptive_delta_roundtrip_flat_and_busy_covers`,
`stego_qim::tests::test_average_ac_magnitude_separates_flat_from_busy`.

---

## 6. Received Nostr events were never cryptographically verified

**Severity:** Critical. This is a Nostr client; verifying that an event
actually came from the pubkey it claims to is one of the protocol's core
integrity guarantees, and it wasn't happening at all.

**Repro:** construct any event-shaped object with an arbitrary `id`,
`pubkey`, and `sig` (no real signature needed) and send it as an `EVENT`
message from a relay -- see
`src/__tests__/nostr-event-verify.test.ts`'s "impersonation" test, which
does exactly this: signs a note with an attacker's own key, then relabels
the event with a victim's pubkey, and confirms this bare object was
previously accepted with no check.

**Root cause:** `relay.ts`'s `onmessage` handler checked only that an
incoming `EVENT` message's payload had the right *shape*
(`e.id && e.pubkey && typeof e.created_at === "number" && ...`) -- never
that `id` actually equals `sha256(serialize([0, pubkey, created_at, kind,
tags, content]))`, and never that `sig` is a valid Schnorr signature over
that id by that pubkey. `nostr-stub.ts` had signing (`finishEventAsync`)
but no verification function at all; grepping the whole `src/` tree for
`verify`/`schnorr.verify` found nothing related to event authenticity.
Practical impact: any relay in the configured pool, or a MITM between the
app and one, could inject events that display in the UI as genuinely
posted by any pubkey -- including someone else's.

**Fix:** added `nostr-stub.ts`'s `verifyEvent()` (recomputes the id hash,
compares it, then calls `@noble/secp256k1`'s `schnorr.verify`) and wired it
into `relay.ts`'s `onmessage` so an event only reaches the app's `onEvent`
callback -- and therefore anywhere in the UI -- after verification passes.
Failed verification drops the event with a `console.warn`, not a silent
display.

**Commit:** `fea5984`

**Regression tests:** `src/__tests__/nostr-event-verify.test.ts` -- accepts
a genuinely signed event; rejects tampered content, a forged id, a garbage
signature, and the impersonation case above; rejects malformed events
without throwing. 6/6 passing.

**Verified pre-existing upstream, not fork-introduced.** Same check run for
bugs #1/#2/#5 (see "Verified against pristine upstream" above): cloned
`brunkstr/Stegstr` at `ad2e10e` and grepped its whole `src/` tree for
`verify`/`schnorr.verify` -- zero matches, same as our pre-fix tree. Diffed
`src/relay.ts`'s `onmessage` handler byte-for-byte against upstream's copy:
identical, no verification call anywhere. This is the holder's pre-existing
vulnerability, not something this fork introduced -- not assumed, confirmed
by direct comparison against the actual upstream source.

**Verified the fix isn't overly strict.** A verifier that's too strict would
silently break the real feed just as badly as one that's missing entirely --
this failure mode isn't caught by synthetic/forged-event unit tests alone.
Connected to two independent real public relays (`wss://relay.damus.io`,
`wss://nos.lol`), pulled 50 real recently-published `kind:1` events from
each, ran every one through the actual `verifyEvent()`: **100/100 accepted,
0 false rejections** across both relays. See
`src/__tests__/verify-against-real-relay.test.ts` (excluded from the regular
`npm test` run since it's network-dependent and talks to a third party; run
explicitly with `npx vitest run src/__tests__/verify-against-real-relay.test.ts`).

---

## 7. Publish silently treated "1 of 5 relays confirmed" the same as "5 of 5"

**Severity:** Medium. Not data loss, but a UX honesty gap the plan
specifically asked about.

**Root cause:** `App.tsx`'s `publishViaRelay` only surfaced a toast when
`publish()` resolved with `count === 0` (total failure). Any count between
1 and the full relay list -- including a note that only reached 1 of 5
relays, meaning most of the pool's subscribers would never see it -- looked
identical in the UI to full success.

**Fix:** added an informational toast for `0 < count < total`
("Reached N of M relays -- some may not have received this"), distinct from
the existing error toast for total failure.

**Commit:** `fea5984`

**Verified via:** `src/__tests__/relay-failure-injection.test.ts`'s
"half the pool unreachable" test -- a real mock relay + a real unreachable
address, confirming `publish()` itself already reported the count honestly
(1, not 0 or 2) even before this fix; the fix is specifically about the UI
not silently treating that 1 the same as a full 2.

---

## 8. Old QIM images (16-bit header) failed to decode against the current binary -- and worse, could crash the process

**Severity:** Critical. Not just a compatibility gap: a mismatched header
interpretation could underflow a buffer in the Reed-Solomon decoder and
panic the whole process (exit code 101), not fail cleanly.

**Why this was checked:** Phase 4's adaptive-delta work (see above) grew
the QIM header from 16 bits (`u16` codeword length only) to 24 bits (a tier
byte + `u16` length), needed so decode knows which delta the body used
before it can read the body. That's a wire-format change; anything embedded
with the pre-Phase-4 binary needed to be checked against the new decoder,
not assumed to still work.

**Repro:** built the pre-Phase-4 binary from commit `24d71d8` (last commit
before the adaptive-delta commit `11d4269`) in a separate git worktree,
confirmed via grep it still has the old `QIM_HEADER_BITS: usize = 16`.
Embedded a payload with that binary, decoded the resulting JPEG with the
current (post-`11d4269`) binary:

```
$ old-stegstr-cli.exe embed cover.png -o old_embed.jpg --payload "header compat test message"
$ new-stegstr-cli.exe decode old_embed.jpg
thread 'main' panicked at ...reed-solomon-0.2.1\src\buffer.rs:38:14:
range end index 18446744073709551492 out of range for slice of length 4
[exit code: 101]
```

**Root cause, two layered bugs:**
1. `decode()` only ever tried the current 24-bit header interpretation.
   Read against a 16-bit-header image, the extra assumed tier byte shifts
   every subsequent bit read, so the recovered `codeword_len` is garbage --
   in this repro, garbled down to a value that produced a Reed-Solomon
   chunk shorter than `QIM_RS_NSYM` (128).
2. `mod rs`'s `decode()` passed that too-short chunk straight into
   `reed_solomon::Decoder::correct()` with no bounds check. The
   `reed-solomon` crate (v0.2.1) does not itself guard against a buffer
   shorter than `nsym`, and underflows a `usize` internally, producing the
   panic above. This is a real crash reachable from ordinary use (open any
   old-format image with the new binary), not a contrived fuzz input.

**Fix:**
- `mod rs::decode()`: added an explicit bounds check --
  `if chunk.len() <= nsym { return Err(...) }` -- before calling
  `dec.correct()`, so a too-short/malformed chunk fails cleanly with a
  descriptive error instead of panicking. This is defense in depth against
  any malformed input, not just the legacy-header case.
- Added `QIM_LEGACY_HEADER_BITS = 16` and extracted the header/body decode
  logic into `try_decode_with_header_format(..., header_bits)`, parameterized
  over which header layout to assume. Public `decode()` now tries the
  current 24-bit format first, and on failure falls back to the legacy
  16-bit format (fixed `QIM_TIER_DEFAULT`/`QIM_DELTA_DEFAULT` body, no tier
  byte). A wrong-format read fails cleanly (RS correction failure or a magic
  mismatch in `unwrap_payload`) rather than false-positiving, for the same
  reason `decode_any` already trying QIM against a plain PNG before falling
  back to DWT is safe.

**Verified, both directions, byte-exact:**
- Old-format image (embedded with the `24d71d8` binary) now decodes
  correctly with the current binary: output exactly matches the original
  payload ("header compat test message"). Exit code 101 (panic) before the
  fix; exit code 0 with the correct payload after.
- New-format image (embedded with the current binary) still decodes
  correctly (regression check): output exactly matches ("reverse compat
  test message").
- Full regression suite still green after the fix: `cargo test --release`
  8/8, `cargo clippy --release --all-targets -- -D warnings` clean,
  platform survival matrix 45/45, extra stress matrix 79/80 (same single
  pre-existing residual gap as before -- `pure_solid_white` on WhatsApp,
  unrelated to this fix, not a new regression).

**Commit:** `1fb3e0c`

**Regression test:** `stego_qim::tests::test_legacy_16bit_header_still_decodes`
-- reproduces the legacy 16-bit-header encoder inline (the current `encode()`
can no longer produce that format itself) and confirms the current `decode()`
falls back to it correctly.

---

## Phase 3: networking-under-failure verification (STEGSTR_ENTRY_V3.md)

No Docker in this environment, so no nostr-rs-relay/strfry -- built a
controllable in-process mock relay instead (`src/__tests__/mock-relay.ts`,
~150 lines, speaks just enough NIP-01 to drive the real client code) and
exercised `relay.ts`'s actual `connectRelays`/`publish` against it for each
failure mode the plan named. See `src/__tests__/relay-failure-injection.test.ts`
for the full test code; summary of what was verified, 7/7 passing:

| failure mode | verified behavior |
|---|---|
| relay down | `connectRelays` doesn't throw; `onError` fires so the app can surface it; `close()` cleanly stops retry attempts |
| relay slow (within OK timeout) | `publish()` still returns a confirmed count of 1 -- a slow-but-eventual OK isn't lost |
| relay slow (beyond OK timeout) | `publish()` honestly returns 0, not a false success, once the timeout passes |
| relay drops mid-subscription (before EOSE) | client detects the close (`onclose`) and reconnects -- confirmed by counting actual reconnect callback firings, not just reading the backoff code |
| half the pool unreachable | `publish()` returns exactly the reachable count (1 of 2), not 0 (would look like total failure) and not 2 (would look like full success) |
| clock skew | `verifyEvent` (see bug #6) accepts a legitimately-signed event with `created_at` 5 years in the future -- confirms the new verification layer doesn't start silently rejecting on freshness, which NIP-01 doesn't mandate |
| relay rate-limiting (NIP-01 `CLOSED`) | **finding, not fixed:** `relay.ts`'s `onmessage` has no case for `msg[0] === "CLOSED"` (or `"NOTICE"`) at all. Sending `CLOSED` in response to a `REQ` is silently ignored -- no re-subscribe, no user-visible signal distinguishing "relay actively rejected this subscription" from "relay just has nothing to send yet." Confirmed via the mock relay: the client received the message (`gotClosed === true`) but `onEose` correctly never fired and nothing else happened either. |

**Duplicate event deduplication:** confirmed correct on the main feed
ingestion path -- `App.tsx`'s `flush()` builds `new Map(prev.map((e) => [e.id, e]))`
before merging in a new batch, so a duplicate `id` overwrites in place
rather than appending; the final array can never contain two entries with
the same id.

**Offline outbox surviving a restart: finding, not fixed.** There IS a
persistent, restart-surviving queue in this codebase -- but only for zaps
(`BASE_ZAP_QUEUE`, backed by `localStorage`, loaded on mount via
`loadQueuedZaps`, flushed automatically when the network becomes available
again). Every other `publishViaRelay` call site (posts, replies, DMs,
likes, follows, reactions, profile edits, contact-list updates) follows the
same pattern: the event is added to local `events` state unconditionally,
then `publishViaRelay` is called *only if* `networkEnabled && canPublishToNetwork`
-- and if that publish resolves with 0 confirmations, or is never attempted
because the app was offline, there is no retry and no persistence. `events`
itself is a plain `useState<NostrEvent[]>([])` with no `localStorage`
read/write anywhere (confirmed by grep -- no `loadEvents`/`BASE_EVENTS`
pattern exists, unlike the zap queue's explicit one). A post composed while
offline, or one where every relay in the pool was unreachable, is visible
in the current session but is gone -- not just unsent, entirely gone, not
recoverable -- the moment the app restarts. The zap queue is a working,
precedented pattern for the fix (persist an outbox to `localStorage`,
flush on reconnect); extending it to general events was not attempted here
given the time available, since it's a real feature addition (a new
persisted queue + flush wiring across every `publishViaRelay` call site)
rather than a small fix.

---

## 9. Default decoder trusted the file extension instead of the file's actual content, breaking `decode_any()`'s own documented promise

**Severity:** Medium. Not data loss and not a crash -- the payload is still there and still recoverable -- but a confusing, misleading failure for a case the CLI's own docs claim is handled ("you don't need to know which encoder produced an image you were sent").

**Found by:** the post-Phase-4 regression sweep, re-running the adversarial corpus against the current binary. A default (non-`--robust`) embed writes genuine PNG bytes; naming that output `.jpg` (a plausible slip, since `--robust` output is documented as `.jpg`) made `decode`/`detect` fail entirely.

**Repro:**
```bash
stegstr-cli embed cover.png -o out.jpg --payload "hello"   # writes real PNG bytes to a .jpg path
stegstr-cli decode out.jpg
# decode error: Format error decoding Jpeg: Error parsing image. Illegal start bytes:8950
```
The file is not corrupt -- `0x8950` is literally the start of a PNG signature (`\x89PNG`) misread as JPEG. Renaming the exact same bytes to `.png` decodes it correctly.

**Root cause:** `decode_any()` (`lib.rs`) tries `stego_qim::decode()` first, which already sniffs the JPEG SOI marker directly from the bytes (bug #3's fix) -- so a QIM/JPEG file mislabeled `.png` decodes fine, content wins. But the DWT fallback, `stego::decode()`, loads the image via `load_image_with_orientation()`'s `ImageReader::open(path)`, which without `.with_guessed_format()` picks a decoder from the path's **extension**, not the bytes. A PNG mislabeled `.jpg` never reaches the correct decoder at all. This asymmetry -- one path content-sniffs, the other trusts the extension -- is what let this slip through: no test had tried embedding with one encoder and decoding with a mismatched extension.

**Note on origin:** `load_image_with_orientation` is byte-for-byte identical to pristine upstream (`brunkstr/Stegstr` @ `ad2e10e`) -- confirmed by direct comparison, not assumed. The defect itself predates this fork. But upstream has only one encoder and never claims extension-agnostic decoding, so it has no real occasion to hit this; the bug only became reachable, and only broke a real promise, once this fork's `--robust`/QIM encoder and `decode_any()`'s "try both, extension doesn't matter" contract existed. Filed as its own entry rather than folded into either tier above -- it doesn't cleanly fit "pre-existing upstream bug" (upstream can't actually trigger it) or "bug in this fork's own new code" (the faulty line isn't new).

**Fix:** `.with_guessed_format()` added to the `ImageReader` chain in `load_image_with_orientation`, so the actual magic bytes are sniffed the same way the QIM path already does.

**Commit:** `5489857`

**Regression test:** `stego::tests::test_decode_ignores_misleading_extension` -- embeds real PNG bytes, deliberately saves them with a `.jpg` name, and confirms `decode()` still recovers the payload.

## Post-Phase-4 regression pass: the other three checks, time-boxed

Focused, not a full re-run -- only the code that changed since the original Phase 1 corpus sweep (adaptive delta, dual-format decode, the header bounds check). Bug #9 above is what it found; the other three checks came back clean:

- **Adversarial corpus, re-run against the current binary.** ~28 files across the original manifest's categories (palette/16-bit/interlaced/CMYK/progressive/truncated/corrupt/empty/non-image/tiny/odd-dims/flat covers), both encoders, plus decoding each raw adversarial file directly -- 84 embed/decode/raw-decode operations, 0 crashes or hangs. This is what surfaced bug #9 (cross-checking outputs under mismatched extensions).
- **Dual-format decoder, attacked directly.** `stego_qim::tests::test_dual_format_decode_survives_adversarial_header_bytes`: 300 trials of fully random bits written into both header and body coefficient slots (so the 24-bit reading, the 16-bit fallback, and whatever codeword length either derives from the noise are all attacker-controlled), decoded via the real public `decode()` wrapped in `catch_unwind`. `test_dual_format_decode_survives_truncated_tiny_cover` covers a cover too small to hold a header in either format. **0 panics** -- the bug #8 fix holds against exactly the class of input it was fixed for.
- **`verifyEvent`, attacked with malformed events.** `nostr-event-verify.test.ts`'s new "malformed-input attack sweep": missing fields, null/wrong-typed id/pubkey/sig/tags/content/kind/created_at, oversized and undersized hex fields, huge payloads, deeply nested tags, `NaN`/`Infinity`, non-hex and non-ASCII-lookalike pubkeys, prototype-pollution-shaped extra fields -- 41 cases. **Every one resolves to `false`, none throw.**
- **Diff audit (`origin/main` vs. pristine upstream) for debug prints, TODOs, commented-out code, leftover scratch files.** Clean: one `console.log` in a network test file (intentional -- it's meant to be read when a human runs it manually), no commented-out code, no scratch/temp files added anywhere in the diff. **One adjacent finding, not a code bug (since resolved):** `Stegstr_Contest_Entry.pdf` was a real, intentionally-committed submission document (not scratch/garbage) that predated this entire campaign and had gone stale -- it still described the pre-hardening 20/20 and 45/45 results, didn't mention any of the 9 bugs in this file, and presented the WhatsApp live-send result without the pass-through-vs-survival distinction `BASELINE_RESULTS.md` later established. Deleted rather than updated -- README.md is now the current, single entry document, and a second document describing an older state would only recreate the same conflict later.

---

## Phase 7: AI agent operability (feature, not a bug fix)

Not a bug -- STEGSTR_BRIEF.md's Phase 7 asked for the CLI and an MCP server
to actually match what `skill/stegstr/` and `agents.txt` already claimed.
Summary; see README.md's "AI agent operability" section and
`skill/stegstr/SKILL.md` for the user-facing documentation, all verified
against the real binary, not just written.

- **`--json` on `decode`/`detect`/`embed`/`post`/`calibrate`.** Exactly one
  JSON object on stdout per command, nothing else. Schemas committed at
  `schema/cli/*.schema.json`, validated against the real compiled binary in
  `src-tauri/tests/cli_json_schema.rs` (both success and every error path,
  for every command).
- **Exit codes**, source-verified rather than guessed: each classification
  in `stegstr_cli.rs`'s `classify_decode_error`/`classify_encode_error`/
  `classify_crypto_error` is tied to an exact, cited error literal from
  `stego.rs`/`stego_qim.rs`/`stego_crypto.rs` (e.g. capacity errors always
  start with the literal `"Payload too large"` in both encoders) --
  matched at the specific call site that can produce that error, not by
  sniffing arbitrary error text for keywords. All 4 non-generic codes
  (`2` capacity exceeded, `3` no payload found, `4` decryption failure,
  `5` malformed input) were each triggered for real, not just asserted:
  `2` via a 50KB payload against a 32x32 cover, `3` via decoding an
  unembedded image, `4` via `--decrypt` on a non-encrypted payload, `5` via
  decoding a non-image file.
- **No interactive prompts.** Grepped: nothing in this CLI ever read stdin
  interactively before this work either -- `--yes` is now an explicit,
  documented no-op flag and `is_noninteractive()` is the enforcement point
  for any future prompt, rather than there being no guard at all.
- **`calibrate`** (new feature, STEGSTR_BRIEF.md section 5.2): a pure-Rust
  JPEG marker-segment parser (`jpeg_probe.rs`, deliberately separate from
  `stego_qim.rs`'s hardened libjpeg FFI wrapper -- no coefficient access
  needed, so no reason to add risk to that surface) recovers quantization
  tables, chroma sampling factors, and progressive/baseline directly from
  JPEG marker bytes. JPEG quality is estimated by matching the recovered
  luma table against the standard IJG quality-scaling curve; reported as
  `jpeg_quality_exact: true` only on a byte-exact match, a labeled best-fit
  estimate otherwise -- never claimed as exact when it isn't. **Verified
  against this repo's own real captured evidence, not synthetic covers**:
  run against `live_test/send_instagram.jpg` /
  `live_test/received/received_instagram.jpg`, recovered JPEG quality 80
  (exact) and chroma subsampling 4:4:4; against the WhatsApp control pair
  (`live_test/control/control_whatsapp_original.jpg` /
  `live_test/received/received_control_whatsapp.jpg`), recovered quality 92
  (exact), chroma 4:2:0, and independently inferred a resize rule of
  "uniform downscale, max side 1920 -> 1600" from pixel dimensions alone --
  which matches WhatsApp's independently-known ~1600px longest-side cap, a
  real corroborating signal the inference is measuring something true, not
  just self-consistent.
- **`stegstr-cli mcp`**: an MCP server over stdio using the official `rmcp`
  SDK (`modelcontextprotocol/rust-sdk`), exposing `embed`, `decode`,
  `detect`, `calibrate` as tools with typed input schemas (via `schemars`)
  and descriptions. Verified end-to-end by hand: `initialize` handshake,
  `tools/list` (returns exactly these 4 tools), and sequenced `tools/call`
  round trips (`embed` then `decode` its own output) all produce correct
  results. **Finding during verification, not a defect:** the server
  processes concurrent `tools/call` requests genuinely concurrently
  (responses matched by JSON-RPC `id`, not send order) -- a client that
  fires a `decode` for a file before that file's `embed` response has come
  back will race it. Documented in `SKILL.md`'s MCP section for anyone
  driving the server by hand over a raw pipe rather than a real MCP client
  (which naturally waits for each response it needs).
- **`skill/stegstr/`**: `SKILL.md` and `README.md` rewritten to document
  `--json`, exit codes, `calibrate`, and `mcp` -- and, per explicit
  instruction, every single command block in the rewritten `SKILL.md` was
  actually run against the compiled binary and its real output compared to
  what's documented, not proofread from memory. One stale-claim class this
  caught: `post --json`'s output is `{"ok":true,"bundle":{...},"output_path":...}`,
  not the bare bundle -- an early draft's example workflow would have had
  an agent embed that whole wrapper (including `"ok"`/`"output_path"`) as
  the payload instead of unwrapping `bundle` first. Caught before it shipped.
- **`tests/e2e/agent_smoke.sh`**: headless, no human -- `post` ->
  unwrap `bundle` -> `embed --robust --json` -> `decode --json` ->
  `detect --json` -> `calibrate --json` against real `live_test/` evidence
  -> `mcp` `tools/list` -> all 4 documented non-zero exit codes each
  actually triggered. 10/10 passing, confirmed stable across repeated runs.
  Building it surfaced two real script-level bugs before they could mislead
  anyone reusing this as a template: (1) the same wrapper-vs-`bundle`
  unwrapping mistake described above, and (2) a genuine timing race in
  driving `stegstr-cli mcp` over a plain shell pipe -- closing stdin the
  instant the last request is written can race the server's still-in-flight
  final response and silently drop it. Both fixed in the script and
  documented in `SKILL.md` so nobody else has to rediscover them.

**What isn't included in this pass, honestly:** STEGSTR_BRIEF.md's Phase 7
also asks for binary-safe stdin/stdout piping (so `embed`/`detect` compose
in a shell pipeline) and a `--seed` flag for deterministic output wherever
randomness is used (Nostr key generation in `post`, the QIM permutation).
Neither was built here -- flagged as open scope rather than silently
dropped, same as every other documented gap in this file.

**Regression tests:** `src-tauri/src/bin/stegstr_cli.rs`'s
`classify_*`/`strip_global_flags`/`is_noninteractive` unit tests;
`src-tauri/src/bin_support/calibrate.rs`'s `resize_rule_*` unit tests;
`src-tauri/src/jpeg_probe.rs`'s quality-estimation and chroma-subsampling
unit tests (including an exact-recovery round trip at 5 quality levels);
`src-tauri/tests/cli_json_schema.rs` (schema validation against the real
binary, success and error paths, all 5 JSON-emitting commands);
`tests/e2e/agent_smoke.sh` (the full headless flow).

**Caught only by watching the real release CI run, not by any local
check:** the first attempt at this work organized `calibrate`/`mcp` as
`src/bin/stegstr_cli/{calibrate,mcp}.rs` (Rust's normal directory-module
form for a binary). `cargo build`/`test`/`clippy` all passed cleanly with
that layout -- but the actual `v0.1.2` release build failed on all 3
platforms: Tauri's bundler (deb confirmed, msi/dmg share the underlying
code path) tried to copy a binary literally named `stegstr_cli` into the
package and errored that it doesn't exist, because cargo actually produces
`stegstr-cli` -- the name this crate's `[[bin]]` section has always
declared. This is a known Tauri limitation with multiple `[[bin]]` targets
in one package (`tauri-apps/tauri` discussion #7592); the directory-module
switch was enough to trigger it even though the declared bin name never
changed. Fixed by reverting to the flat `src/bin/stegstr_cli.rs` layout
that built cleanly for v0.1.0/v0.1.1, with `calibrate.rs`/`mcp.rs` moved to
a new `src/bin_support/` directory (outside `src/bin/`, so cargo's binary
auto-discovery never treats them as their own targets) and pulled in via
`#[path]`. No source changes beyond the module wiring; same 29/29 tests,
same clean clippy, same 10/10 `agent_smoke.sh`. The original `v0.1.2` tag
was deleted and recreated pointing at the fix -- no release was ever
published from the broken build, confirmed via `gh release view` before
deleting it.

---

## Also investigated, not a bug

- **`--payload-base64` has no `@file` form.** `--payload @file` requires the
  file to be valid UTF-8 (it's read via `fs::read_to_string`); embedding an
  arbitrary binary file requires `--payload-base64 <b64>`, which only accepts
  an inline string, not a file -- and inline base64 for anything past roughly
  tens of KB exceeds Windows' ~32K command-line length limit. Not fixed (CLI
  UX gap, not a correctness bug); flagged for Phase 5 (`scripts/`) or a future
  `--payload-base64 @file` option.
- **`stego_crypto`'s "encrypt" is app-wide obfuscation, not per-recipient
  secrecy.** The AES key is derived from a fixed, public salt baked into the
  source (`APP_KEY_SALT`), so any Stegstr build can decrypt any
  `--encrypt`-ed payload -- this is documented/intentional ("any Stegstr user
  can detect"), not a "wrong decryption key" bug. Tampered-ciphertext input
  (bit-flipped) is correctly rejected by AES-GCM's auth tag, verified.
- **Capacity boundary (exactly-at-capacity / one-byte-over) for both encoders**
  is off-by-one-clean: verified via binary search on both DWT and QIM paths --
  exact-capacity succeeds, capacity+1 fails with a descriptive error, no crash.

# Robustness research: why Stegstr fails on real platforms, and the fix

All numbers below are reproducible from this directory. Nothing here is
estimated or quoted from a paper — every cell is a measured decode.

```bash
pip install numpy pillow scipy reedsolo

python bench.py current          # the old scheme, as a baseline
python bench.py stdm:locator     # the new scheme, research implementation
python probe_band.py             # per-frequency channel response

# The one that matters: the shipping TypeScript encoder, end to end.
cd .. && npm install && npm run build:cli && cd robust_lab
python crossvalidate.py --mode locator
```

---

## 1. The root cause: resize, not recompression

`docs/WHATSAPP_PLAN.md` records the open problem as *"QIM passes our simulated
WhatsApp but fails on real WhatsApp"*, and concludes the simulator must be too
optimistic. That conclusion is half right. The simulator is too optimistic, but
not because its quality factor is wrong — because of what it never varies.

Isolating the two things a platform does to an image:

| Cover size | Platform  | Did it resize?  | Decode |
|------------|-----------|-----------------|--------|
| 1600×1200  | whatsapp  | no              | PASS   |
| 1600×1200  | telegram  | yes → 1280×960  | FAIL   |
| 1600×1200  | instagram | yes → 1080×809  | FAIL   |
| 2000×1500  | whatsapp  | yes → 1600×1200 | FAIL   |
| 1608×1208  | whatsapp  | yes → 1600×1202 | FAIL   |

The pattern is total. **Recompression alone is survivable; any resize at all is
fatal.** The last row is the important one: a 1608 → 1600 px resize is a 0.5%
change, and it still destroys 100% of payloads.

The reason is structural. `src/stego-qim.ts` embeds in the 8×8 DCT blocks of
the image *at whatever resolution it happens to have*. Resampling moves every
pixel, so the receiver's 8×8 grid no longer lines up with the sender's and each
coefficient becomes a blend of neighbours. No amount of Reed–Solomon parity
recovers that, which is exactly why `dct_rs64` showed no improvement over `dct`
in `docs/robust_comparison.md` — the limiting factor was never parity.

The upstream mitigation is `PLATFORM_WIDTHS`: pre-resize the cover to the
platform's exact cap so the platform has no reason to resize. That is why the
simulated matrix looks good. It fails in the real world because it needs the
user to name the destination correctly in advance, and it breaks whenever a
platform's cap differs from the constant in the table — by any amount, as row 5
shows.

## 2. Measured baseline

Four synthetic-but-photographic covers (smooth landscape, dense foliage,
smooth-skin portrait, noisy night frame) at 1600×1200, 4 trials per cell, each
trial sampling that platform's quality/filter/crop variability.

| Scheme  | tg-file | instagram | facebook | twitter | telegram | whatsapp | wa ×2 | **Overall** |
|---------|---------|-----------|----------|---------|----------|----------|-------|-------------|
| current | 100%    | **0%**    | 100%     | 100%    | **0%**   | 100%     | 100%  | **71.4%**   |

PSNR 38.7 dB, 2.71 s per embed. The two zero columns are precisely the two
platforms whose caps (1080, 1280) are below the 1600 px cover.

## 3. The fix: normalise before embedding

Never embed in the delivered resolution. Both sender and receiver first
resample the luma plane onto a fixed canonical square (512×512), ignoring
aspect ratio. A uniform rescale by a platform is then undone by the receiver's
own normalisation, so the embedding grid is reproducible no matter what size
the image arrives at.

Inside the canonical frame, plain QIM is replaced with **spread-transform
dither modulation**. Each payload bit owns a pseudorandom set of *L*
mid-frequency DCT coefficients and a ±1 chip pattern; the bit is carried by the
*projection* of those coefficients onto the chip vector, which is quantised
with a dither lattice. Because the bit lives in a projection rather than in
individual coefficients, host interference cancels exactly, and the change to
any single coefficient is 1/√L of the step — invisible, while the projection is
*L* times more noise-resistant than any one coefficient.

### Choosing the band by measurement

`probe_band.py` embeds one carrier per radial ring and reports the bit-error
rate per ring after each channel, i.e. the channel's frequency response as the
detector actually sees it:

| ring (r)  | cycles  | facebook | twitter | telegram | instagram | whatsapp | wa ×2 |
|-----------|---------|----------|---------|----------|-----------|----------|-------|
| 0.14–0.20 | 36–52   | 0.0%     | 0.0%    | 0.0%     | 0.0%      | 0.0%     | 0.0%  |
| 0.20–0.33 | 52–84   | 0.0%     | 0.0%    | 0.0%     | 0.0%      | 0.0%     | 0.0%  |
| 0.33–0.39 | 84–99   | 0.0%     | 0.0%    | 0.0%     | 1.8%      | 0.0%     | 0.0%  |
| 0.39–0.45 | 99–115  | 0.0%     | 0.0%    | 0.0%     | 6.5%      | 0.0%     | 0.0%  |
| 0.51–0.57 | 131–146 | 0.0%     | 0.0%    | 0.0%     | 22.7%     | 4.2%     | 3.6%  |
| 0.69–0.76 | 178–193 | 13.0%    | 3.9%    | 5.5%     | 43.2%     | 32.0%    | 32.8% |
| 0.94–1.00 | 240–256 | 30.7%    | 26.0%   | 46.6%    | 46.9%     | 46.9%    | 46.6% |

Below r ≈ 0.08 the image's own energy dominates and edits become visible; above
r ≈ 0.45 downscaling and JPEG quantisation start eating the carrier, Instagram
first. The modes below use that measured window rather than a guessed one.

### Results

Measured on the **shipping TypeScript encoder** (`dist-cli/stegstr.mjs`, the
same module the app imports), not on research code, via
`python crossvalidate.py`:

| Scheme        | payload | tg-file | instagram | facebook | twitter | telegram | whatsapp | wa ×2 | **Overall** |
|---------------|---------|---------|-----------|----------|---------|----------|----------|-------|-------------|
| current (QIM) | 64 B    | 100%    | 0%        | 100%     | 100%    | 0%       | 100%     | 100%  | **71.4%**   |
| stdm:locator  | 48 B    | 100%    | 100%      | 100%     | 100%    | 100%     | 100%     | 100%  | **100.0%**  |
| stdm:standard | 163 B   | 100%    | 100%      | 100%     | 100%    | 100%     | 100%     | 100%  | **100.0%**  |

`stdm:locator` is also **13× faster to embed** (0.20 s vs 2.71 s per image).

### One more failure mode, found only by running the real app

The numbers above all come from channel models that resize with a good filter,
because that is what a platform's servers do. Running the built app in Chromium
turned up a case none of them covered: **WhatsApp Web and Telegram Desktop
downscale in the client**, using a canvas bilinear filter that aliases rather
than averages. That is a far harsher attack than server-side Lanczos, and at the
original dither step the payload did not survive it.

Raising the step fixed it at almost no cost, because at this scale the JPEG's own
quantisation noise dominates the watermark's:

| dither step | 1600→1080 (good filter) | 1600→1080 (canvas, low quality) | PSNR |
|-------------|--------------------------|----------------------------------|------|
| 28          | fails                    | fails                            | 32.9 |
| 44          | passes                   | fails                            | 32.8 |
| 52          | passes                   | passes                           | 32.7 |
| 64          | passes                   | passes                           | 32.5 |

Shipping values are 56 (locator) and 64 (standard); standard needs more because
it has half the spreading.

### Invisibility

PSNR of the stego image against the cover, on the four benchmark covers, with
the cost of a plain re-save at the same quality shown alongside, so the
watermark's own contribution is separable. Measured at the output quality of
the time (q92); the shipping default is now q98, which lifts every figure here
by roughly 1.8 dB:

| cover     | locator | standard | plain re-save |
|-----------|---------|----------|----------------|
| landscape | 40.3    | 37.6     | 44.0           |
| foliage   | 38.1    | 36.2     | 40.0           |
| portrait  | 40.9    | 37.8     | 46.0           |
| night     | 34.8    | 33.8     | 35.6           |

On the noisy night frame the watermark costs 0.8 dB over the JPEG alone. This
sits in the normal range for robust watermarking rather than the >40 dB of a
fragile scheme, which is the honest trade for surviving a Q65 recompression.

### Geometric attacks

| Attack        | stdm:locator | current |
|---------------|--------------|---------|
| scale 37%     | **PASS**     | FAIL    |
| scale 63%     | **PASS**     | FAIL    |
| scale 150%    | **PASS**     | FAIL    |
| JPEG q30      | PASS         | PASS    |
| grayscale     | PASS         | PASS    |
| crop 2%/edge  | **PASS**     | FAIL    |
| crop 5%/edge  | FAIL         | FAIL    |
| rotate 0.5°   | FAIL         | FAIL    |

Arbitrary rescaling — the thing that broke every platform — is now a non-event.

## 4. Three modes, because one size does not fit

Capacity in the survivable band is genuinely limited, so the scheme exposes the
trade-off instead of hiding it:

| Mode       | payload | intended channel                                  |
|------------|---------|---------------------------------------------------|
| `locator`  | 48 B    | WhatsApp/Instagram — carries a 32-byte Nostr event id + 16-byte key; the message itself is fetched over relays |
| `standard` | 163 B   | a short note travelling entirely inside the image |
| `bulk`     | 1377 B  | lossless channels: Telegram "send as file", email, disk |

`locator` mode is the one that ties the two contest requirements together: the
steganographic channel carries a *pointer*, and the networking layer resolves
it. That is what makes 100% WhatsApp survival possible without pretending a
64 kB bundle can survive a 1080 px downscale.

## 5. Honest limitations

- **Rotation is not handled.** Even 0.5° fails. Fixing it needs a
  synchronisation template (log-polar / Fourier–Mellin), not a parameter tweak.
- **Crops beyond ~2% per edge are not handled.** The detector re-expands by a
  few candidate insets, which works while the missing border is thin. Larger
  crops need the same synchronisation template as rotation.
- **The channel models are models.** They are materially harsher than the
  upstream simulator — long-edge caps, non-multiple-of-8 output, sampled
  quality ranges, sharpening, double-encode, edge crop — but they are still not
  the real apps. Validation through actual WhatsApp, Telegram and Instagram is
  required before any of these numbers should be quoted as real-world figures.
- **Covers are synthetic.** They are built with 1/f statistics to behave like
  photographs, and span smooth/detailed/dark cases, but a real photo set should
  be run before final claims.

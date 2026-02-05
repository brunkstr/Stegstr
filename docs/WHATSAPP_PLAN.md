# Plan: Surviving Real WhatsApp

## The problem

- **QIM** passes our simulated WhatsApp (800px, Q65, 4:2:0) but **fails on real WhatsApp**.
- Real WhatsApp introduces more errors than RS(96) can correct (ReedSolomonError: "Too many errors").
- Implication: our simulator is **too optimistic** – real WhatsApp is harsher than we model.

## Why QIM isn't enough

From the alternatives research:

| Method   | Harsh Q (WhatsApp) | Notes |
|----------|--------------------|-------|
| QIM      | **Moderate**       | Quantization helps, but strong requantization still corrupts. We've pushed delta and RS; errors exceed correction. |
| TCM      | **Good**           | Embeds only in coefficients that survive the channel – addresses *which* bits flip, not just how many. |
| Lattice  | **Good**           | Same idea: select stable positions. "Errorless" recovery when channel is modeled correctly. |
| Adaptive | **Good**           | Iteratively adapts embedding based on simulated decode – expensive but robust. |

**QIM** increases robustness by coarser quantization and more RS. But if real WhatsApp uses different parameters than our simulator (e.g. different Q, resize, or multiple recompressions), we're embedding in coefficients that get destroyed. **TCM/Lattice** fix that by only embedding where the channel leaves the data intact.

## Recommended plan

### Phase 1: Calibrate simulator to real WhatsApp (high value, low effort)

**Goal:** Know if our WhatsApp profile (800px, Q65) matches reality.

1. Upload a few test images through real WhatsApp (various sizes, e.g. 600px, 1200px, 2000px wide).
2. Download and measure: output dimensions, file size, estimate Q from file size.
3. If real WhatsApp uses different params (e.g. Q60, 1600px), update `channel.py` and re-run the matrix.

**Outcome:** Either we fix the simulator so our tests are valid, or we confirm real WhatsApp is harsher and Phase 2 is necessary.

---

### Phase 2: TCM-style coefficient selection (high value, medium effort)

**Goal:** Embed only in coefficients that survive a round-trip through the target channel.

**Algorithm sketch:**
1. Resize cover to WhatsApp max (800px) if needed.
2. Convert to JPEG at high quality (e.g. Q95).
3. For each candidate DCT coefficient position (e.g. first 24 AC per block):
   - Embed a test bit.
   - Decode to pixels → run through WhatsApp simulator (resize + Q65 + 4:2:0).
   - Decode DCT from attacked image.
   - Check if our bit survived.
4. Build list of "stable" positions.
5. Embed payload (with RS) only in those stable positions.

**Challenges:**
- After resize, block layout changes – encoder and decoder see different grids. We need a consistent scheme (e.g. embed only in the *pre*-resize image at 800px, so the channel doesn't resize again, or use a fixed 800px cover).
- Simpler variant: assume input is already ≤800px wide; simulate only recompression (no resize). Many WhatsApp uploads won't be resized. This still improves over blind QIM.

**Feasibility:** Medium. We have `channel.simulate()`, `dct_stego`, and `jpeglib`. We can add `encode_dct_tcm_whatsapp()` that does the stability test and embeds accordingly.

---

### Phase 3: Reduce payload for harsh channels (medium value, low effort)

**Goal:** Fewer bits to protect → more redundancy per bit.

- Add "Compact" embed mode: embed a minimal bundle (e.g. identity + last N events) when "WhatsApp" is selected.
- Or: cap payload size and increase RS to 128 when embedding for WhatsApp.
- Trade-off: less data survives, but more likely to decode.

---

### Phase 4: Honest fallback and UX (low effort)

**Goal:** Don't over-promise; guide users.

- In the app: when user selects "Robust (QIM)", show a note: *"Best on Instagram, Facebook, Twitter. WhatsApp may fail – try sharing via DM or link instead."*
- Add a "Report channel" option: if decode fails, let users report which platform the image came from, to improve calibration.

---

## Summary

| Phase | Effort | Impact | Next step |
|-------|--------|--------|-----------|
| 1. Calibrate | Low   | High | Measure real WhatsApp output; update simulator. |
| 2. TCM       | Medium| High | Implement channel-aware coefficient selection. |
| 3. Compact   | Low   | Medium | Add small-payload mode for WhatsApp. |
| 4. UX        | Low   | Low  | Add disclaimer; optional feedback. |

**Recommendation:** Do Phase 1 first. If the simulator is wrong, fix it and re-test QIM. If the simulator is correct and real WhatsApp is simply harsher, implement Phase 2 (TCM-style) as the main technical fix for WhatsApp.

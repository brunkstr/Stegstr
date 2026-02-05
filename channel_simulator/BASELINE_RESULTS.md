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

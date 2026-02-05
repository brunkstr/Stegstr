# Robust Steganography Comparison

This document summarizes the encoder × channel pass/fail matrix after implementing alternative DCT-based methods and running them through the channel simulator. See [CHANNEL_SPEC.md](../channel_simulator/CHANNEL_SPEC.md) for exact profile parameters.

## Result (encoder × channel)

| Encoder   | whatsapp | instagram | facebook | twitter |
|-----------|----------|-----------|----------|---------|
| dwt       | FAIL     | FAIL      | FAIL     | FAIL    |
| dct       | FAIL     | PASS      | FAIL     | PASS    |
| dct_rs64  | FAIL     | PASS      | FAIL     | PASS    |
| dct_sign  | FAIL     | PASS      | PASS     | PASS    |
| dct_tcm   | FAIL     | PASS      | PASS     | PASS    |
| **dct_qim** | **PASS** | **PASS**  | **PASS** | **PASS** |

- **PASS** = decoded payload equals original (`channel_test!`).
- **FAIL** = decode returns wrong data or decode fails.
- Profiles: WhatsApp (800px, Q65), Instagram (1080px, Q82), Facebook (2048px, Q77), Twitter (600px, Q82). All use 4:2:0 and LANCZOS resize.

## How each method defeats the situation

| Encoder   | Defeats resize | Defeats recompression | Notes |
|-----------|----------------|------------------------|-------|
| dwt       | No             | No                     | LSB in wavelet domain is destroyed by resize + JPEG. |
| dct       | Partial        | Partial (mid-Q)        | LSB of DCT AC coefficients; RS(32). Survives Instagram/Twitter. |
| dct_rs64  | Partial        | Partial (mid-Q)        | Same as dct with RS(64) for stronger parity. No improvement in matrix. |
| dct_sign  | Partial        | Better                 | Bit in sign (positive/negative) of DCT coeffs; signs more stable than LSB under recompression. **Improves Facebook.** |
| dct_tcm   | Partial        | Better                 | First 16 AC positions (mid-frequency), RS(48). **Improves Facebook.** |
| **dct_qim** | **Yes**      | **Yes (incl. Q65)**    | Quantization Index Modulation; coarser quantization (δ=6) + RS(64). **Passes all channels including WhatsApp.** |

## Observations

- **dct_qim** (QIM with δ=6, RS64) passes all four channels including WhatsApp—the only method that survives Q65.
- **dct_sign** and **dct_tcm** improve robustness over base DCT on Facebook but fail WhatsApp.
- **dct_rs64** did not improve over base DCT; the limiting factor is coefficient flips rather than Reed–Solomon capacity.

## Recommendation

1. **For all channels (including WhatsApp):** Use **dct_qim** — passes all four profiles.
2. **For Instagram, Facebook, Twitter only:** **dct_sign** or **dct_tcm** also work.
3. **Implementation:** Variants live in `channel_simulator/dct_variants.py`; the matrix script is `channel_simulator/run_matrix.py`.

## Reproduce

```bash
cd channel_simulator
python3 run_matrix.py
```

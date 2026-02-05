# Robust Steganography Options Matrix

Systematic survey of alternative embedding methods for surviving social-platform channel attacks (resize + JPEG recompression). For each option: summary, how it defeats resize/recompression, references, code availability, and feasibility for integration.

---

## 1. DCT sign-based embedding

**Summary:** Encode bits in the **sign** of DCT coefficients (positive/negative) instead of LSB of magnitude. Signs are more stable than magnitudes under recompression.

**Defeats resize:** Partial (block alignment); resize changes block layout.  
**Defeats recompression:** Good when Q is similar; signs tend to survive. Weak at very low Q (WhatsApp-like).  
**Limitation:** One embedding change can affect multiple coefficients in the same 8×8 block; lattice partitioning mitigates.

**References:** IEEE "Robust Steganography by Modifying Sign of DCT Coefficients".  
**Code:** [Sign_steganography_revisited](https://github.com/sh1newu/Sign_steganography_revisited) (Python).  
**Feasibility:** Medium. Direct evolution of current DCT; can adapt payload format.

---

## 2. Lattice-based DCT (64 lattices per block)

**Summary:** Partition the 64 DCT coefficients per block into 64 non-overlapping lattices. Simulate recompression and select embedding positions that remain stable. Combines with J-UNIWARD-like cost functions.

**Defeats resize:** Via channel simulation only if resize is in the loop; otherwise indirect.  
**Defeats recompression:** Very good by design; "errorless" recovery reported.  
**Limitation:** High implementation complexity; requires simulation of target channel during embedding.

**References:** ArXiv 2211.04750, 2211.10095.  
**Code:** Research code in papers; no clear public repo.  
**Feasibility:** Hard. Would need to implement or port from paper.

---

## 3. Transport Channel Matching (TCM)

**Summary:** Simulate the exact channel (resize + JPEG at platform Q). For each candidate coefficient, compute robustness cost (likelihood to flip). Embed only in stable coefficients; optionally with STC + Reed–Solomon.

**Defeats resize:** Yes, if simulator includes resize.  
**Defeats recompression:** Very good; channel-specific.  
**Limitation:** Requires knowing or approximating the target channel; calibration to real platforms improves results.

**References:** IEEE "Improving the Robustness of Adaptive Steganographic Algorithms Based on Transport Channel Matching"; HAL 04181480.  
**Code:** Not widely available; algorithm described in papers.  
**Feasibility:** Hard. Can implement a simplified version using our channel simulator as the target.

---

## 4. Adaptive dither / anti-compression feedback

**Summary:** Iteratively embed, run image through simulated compressor, observe which coefficients flip, adjust embedding. Adapts to unknown or varying recompression without knowing exact compressor.

**Defeats resize:** If simulation loop includes resize.  
**Defeats recompression:** Good; adapts to observed behavior.  
**Limitation:** Computationally expensive; multiple embed-simulate-decode iterations.

**References:** "Anti-compression JPEG steganography over repetitive compression networks" (ScienceDirect).  
**Code:** Not publicly available.  
**Feasibility:** Hard. Would need to implement from paper.

---

## 5. Quantization Index Modulation (QIM) / dither modulation

**Summary:** Map message symbols to quantization indices; embed by quantizing host coefficients to chosen reconstruction levels. DC-QIM is optimal for certain channel models. Applicable in DCT or wavelet domain.

**Defeats resize:** Partial (wavelet multiresolution variants).  
**Defeats recompression:** Good for moderate requantization; strong Q hurts.  
**Limitation:** Quantization step vs attack step tradeoff; very low Q can still corrupt.

**References:** Chen & Wornell; "Comparative Study of Wavelet Based Lattice QIM"; [QuantizationIndexModulation](https://github.com/pl561/QuantizationIndexModulation) (Python).  
**Code:** GitHub implementation exists.  
**Feasibility:** Medium. Can integrate or adapt existing QIM code.

---

## 6. Spread-spectrum embedding

**Summary:** Spread message over many coefficients using pseudo-random or adaptive sequences; low energy per coefficient. Correlation-based extraction. Can combine with robust coefficient selection (e.g. sign-stable DCT).

**Defeats resize:** Partial; downscale loses coefficients; redundancy helps.  
**Defeats recompression:** Good when combined with robust coeff selection.  
**Limitation:** Moderate at harsh Q; spread may not survive heavy quantization.

**References:** IEEE "Spread spectrum image steganography"; Springer "Beyond traditional steganography"; Cox et al.  
**Code:** Various academic implementations; no canonical public repo.  
**Feasibility:** Medium. Would need to implement or locate suitable code.

---

## 7. Invertible / robust neural steganography (INN, RoSteALS, FIIH)

**Summary:** Train a network (INN or autoencoder latent space) so stego survives a noise/compression layer. Some embed in DCT with learnable noise layer. Report 0% error at certain Q factors.

**Defeats resize:** Only if trained with resize.  
**Defeats recompression:** Good at Q factors seen in training; low-Q (WhatsApp) unknown.  
**Limitation:** Very high complexity; GPU; training data and pipeline.

**References:** "INN-based Robust JPEG Steganography" (OpenReview 2024); "PRIS"; "RoSteALS" (CVPRW 2023); "FIIH" (2024).  
**Code:** Some papers release code; PyTorch-based.  
**Feasibility:** Very hard for quick integration.

---

## 8. Redundant / multi-tile embedding (extended)

**Summary:** Embed same payload in many tiles/regions (Stegstr already does for crop). Add redundancy in DCT domain and strong error correction (Reed–Solomon, more parity). Combines with any robust DCT method.

**Defeats resize/crop:** Yes via multiple copies.  
**Defeats recompression:** Only when combined with robust DCT; redundancy alone does not fix coefficient flips.

**References:** Extends existing Stegstr tile design.  
**Code:** N/A; incremental change to dct_stego.  
**Feasibility:** Easy. Increase RS_NSYM, reduce payload, or replicate across DCT blocks.

---

## 9. Differential Manchester + sign-based

**Summary:** Use differential Manchester coding for synchronization/location; embed payload in sign-stable or weighted-cost DCT coefficients. Reduces impact of flips on finding message region.

**Defeats resize:** Partial.  
**Defeats recompression:** Good when combined with sign-based embedding.  
**Limitation:** Moderate at harsh Q.

**References:** "A Compression Resistant Steganography Based on Differential Manchester Code" (MDPI Symmetry).  
**Code:** Not widely available.  
**Feasibility:** Medium. Combines known techniques.

---

## Summary Table

| Option            | Resize       | Recompression | Harsh Q (WhatsApp) | Feasibility |
|-------------------|-------------|---------------|---------------------|-------------|
| Sign-based DCT    | Partial     | Good          | Weak                | Medium      |
| Lattice DCT       | Via sim     | Very good     | Good                | Hard        |
| TCM               | Yes         | Very good     | Good                | Hard        |
| Adaptive dither   | If in loop  | Good          | Good                | Hard        |
| QIM               | Partial     | Good          | Moderate            | Medium      |
| Spread spectrum   | Partial     | Good          | Moderate            | Medium      |
| INN / neural      | If trained  | Good          | Unknown             | Very hard   |
| Redundant + DCT   | Yes (tiles) | With robust   | With robust         | Easy        |
| Diff. Manchester  | Partial     | Good          | Moderate            | Medium      |

---

## Recommended first candidates (Phase 3)

1. **Sign-based DCT** – Direct evolution of current DCT; Sign_steganography_revisited has code.  
2. **TCM-inspired** – Use our channel simulator; select coefficients that survive round-trip; keep RS.  
3. **Stronger redundancy + current DCT** – Higher RS_NSYM, lower payload; quick test.

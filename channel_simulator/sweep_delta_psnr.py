"""
Re-tune QIM_DELTA with PSNR measured alongside robustness at every step, not
just bit-error-rate (which is all sweep_delta.py checks). The original
delta=32 was chosen from BER alone and turned out to score only ~26dB PSNR
against a same-pipeline no-embedding baseline -- genuinely visible, confirmed
by direct inspection, not just a number. See BASELINE_RESULTS.md for the
full writeup and the chosen value (16).

Usage: python sweep_delta_psnr.py
"""
from __future__ import annotations

import io
import math
import os
import sys
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).resolve().parent))

import dct_variants as dv
from channel import simulate, PROFILES

COVERS_DIR = Path(__file__).resolve().parent / "covers"
COVERS_EXT_DIR = Path(__file__).resolve().parent / "covers_extended"
PAYLOAD = b"Hey, meeting moved to 4pm. Bring the signed copies. Stegstr."


def psnr(a: Image.Image, b: Image.Image) -> float:
    arr_a = np.array(a.convert("RGB"), dtype=np.float64)
    arr_b = np.array(b.convert("RGB"), dtype=np.float64)
    mse = np.mean((arr_a - arr_b) ** 2)
    if mse == 0:
        return float("inf")
    return 20 * math.log10(255.0) - 10 * math.log10(mse)


def no_embed_baseline(cover_path: Path) -> Image.Image:
    """Same resize + JPEG quality as encode_dct_qim, with zero QIM changes --
    isolates visible impact of the embedding itself from ordinary JPEG
    compression artifacts (which a flat-color cover like a screenshot has
    plenty of on its own, and shouldn't be blamed on the encoder)."""
    orig = Image.open(cover_path).convert("RGB")
    max_width = dv.QIM_WIDTH_PRESETS["max"]
    long_side = max(orig.width, orig.height)
    if long_side > max_width:
        ratio = max_width / long_side
        orig = orig.resize(
            (max(1, round(orig.width * ratio)), max(1, round(orig.height * ratio))),
            Image.Resampling.LANCZOS,
        )
    buf = io.BytesIO()
    orig.save(buf, "JPEG", quality=dv.QIM_EMBED_QUALITY, subsampling=0)
    return Image.open(buf).convert("RGB")


def main() -> None:
    covers = sorted(COVERS_DIR.glob("*.png")) + sorted(COVERS_EXT_DIR.glob("*.png"))
    if not covers:
        print("No covers found; run gen_realistic_covers.py and gen_extended_covers.py first.")
        sys.exit(1)

    for delta in [10, 12, 14, 16, 18, 22, 26, 32]:
        dv.QIM_DELTA = float(delta)
        dv.QIM_ERASURE_MARGIN = dv.QIM_DELTA / 6.0
        n_pass, n_total, psnrs, fails = 0, 0, [], []
        for cover in covers:
            try:
                stego_bytes = dv.encode_dct_qim(str(cover), PAYLOAD)
            except ValueError:
                continue  # cover too small for this payload at this delta's overhead; skip
            stego_img = Image.open(io.BytesIO(stego_bytes)).convert("RGB")
            baseline_img = no_embed_baseline(cover)
            if baseline_img.size == stego_img.size:
                psnrs.append(psnr(baseline_img, stego_img))
            tmp = cover.with_name(f"_sweep_{cover.stem}.jpg")
            tmp.write_bytes(stego_bytes)
            for ch in PROFILES:
                after = simulate(tmp, ch)
                dec = dv.decode_dct_qim(after)
                n_total += 1
                if dec == PAYLOAD:
                    n_pass += 1
                else:
                    fails.append((cover.name, ch))
            tmp.unlink(missing_ok=True)
        avg_psnr = sum(psnrs) / len(psnrs) if psnrs else 0.0
        print(f"delta={delta:3d}  {n_pass}/{n_total} passed   avg PSNR={avg_psnr:.1f} dB  fails={fails}")


if __name__ == "__main__":
    main()

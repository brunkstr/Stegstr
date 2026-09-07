"""Per-cover-type delta sweep: survival rate + PSNR + SSIM broken out by
cover, not just aggregated -- needed to design per-cover-flatness adaptive
delta tiers (see stego_qim.rs's average_ac_energy / DELTA_TIERS) and to show
the SSIM-gain vs survival-rate tradeoff curve honestly, not just at one
aggregate number.

Usage: python sweep_delta_per_cover.py
"""
from __future__ import annotations

import io
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from skimage.metrics import structural_similarity as sk_ssim
from skimage.metrics import peak_signal_noise_ratio as sk_psnr

sys.path.insert(0, str(Path(__file__).resolve().parent))

import dct_variants as dv
from channel import simulate, PROFILES

COVERS_DIR = Path(__file__).resolve().parent / "covers"
COVERS_EXT_DIR = Path(__file__).resolve().parent / "covers_extended"
PAYLOAD = b"Hey, meeting moved to 4pm. Bring the signed copies. Stegstr."


def no_embed_baseline(cover_path: Path) -> Image.Image:
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


def measure(a: Image.Image, b: Image.Image):
    arr_a = np.asarray(a.convert("RGB"))
    arr_b = np.asarray(b.convert("RGB"))
    h = min(arr_a.shape[0], arr_b.shape[0])
    w = min(arr_a.shape[1], arr_b.shape[1])
    arr_a = arr_a[:h, :w]
    arr_b = arr_b[:h, :w]
    p = sk_psnr(arr_a, arr_b, data_range=255)
    s = sk_ssim(arr_a, arr_b, channel_axis=2, data_range=255)
    return p, s


def main():
    covers = sorted(COVERS_DIR.glob("*.png")) + sorted(COVERS_EXT_DIR.glob("*.png"))
    deltas = [8, 10, 12, 14, 16, 20, 24, 28, 32]

    # header: cover name, then per-delta PSNR/SSIM/survival
    print(f"{'cover':18s} " + " ".join(f"d={d:<3d}(P/S/surv)" for d in deltas))
    results = {}  # cover -> delta -> (psnr, ssim, pass, total)
    for cover in covers:
        results[cover.name] = {}
        baseline_img = no_embed_baseline(cover)
        for delta in deltas:
            dv.QIM_DELTA = float(delta)
            dv.QIM_ERASURE_MARGIN = dv.QIM_DELTA / 6.0
            try:
                stego_bytes = dv.encode_dct_qim(str(cover), PAYLOAD)
            except ValueError:
                results[cover.name][delta] = None
                continue
            stego_img = Image.open(io.BytesIO(stego_bytes)).convert("RGB")
            p, s = (float("nan"), float("nan"))
            if baseline_img.size == stego_img.size:
                p, s = measure(baseline_img, stego_img)
            tmp = cover.with_name(f"_sweep2_{cover.stem}.jpg")
            tmp.write_bytes(stego_bytes)
            n_pass = 0
            for ch in PROFILES:
                after = simulate(tmp, ch)
                dec = dv.decode_dct_qim(after)
                if dec == PAYLOAD:
                    n_pass += 1
            tmp.unlink(missing_ok=True)
            results[cover.name][delta] = (p, s, n_pass, len(PROFILES))

    for cover in covers:
        row = []
        for delta in deltas:
            r = results[cover.name][delta]
            if r is None:
                row.append(f"{'n/a':>16s}")
            else:
                p, s, n_pass, n_total = r
                row.append(f"{p:5.1f}/{s:.2f}/{n_pass}/{n_total}")
        print(f"{cover.name:18s} " + " ".join(f"{c:>16s}" for c in row))


if __name__ == "__main__":
    main()

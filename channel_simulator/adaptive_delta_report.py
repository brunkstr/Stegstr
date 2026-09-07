"""Honest before/after report for Phase 4 (adaptive per-cover QIM delta):
PSNR, SSIM, and simulated-platform survival rate per cover, comparing the
old uniform delta=16 against the new adaptive scheme (flat covers get
delta=12, everything else keeps delta=16) -- using the actual Rust CLI
binary end-to-end, not the Python prototype.
"""
import subprocess, base64, io
from pathlib import Path

import numpy as np
from PIL import Image
from skimage.metrics import structural_similarity as sk_ssim
from skimage.metrics import peak_signal_noise_ratio as sk_psnr

from channel import simulate, PROFILES
import dct_variants as dv

CLI = r"D:\Projects\Stegstr\src-tauri\target\release\stegstr-cli.exe"
COVERS_DIR = Path("covers")
COVERS_EXT_DIR = Path("covers_extended")
PAYLOAD = b"Hey, meeting moved to 4pm. Bring the signed copies. Stegstr."
B64 = base64.standard_b64encode(PAYLOAD).decode()


def no_embed_baseline(cover_path: Path) -> Image.Image:
    """Same resize + JPEG quality as the Rust embed path, with zero QIM
    changes -- isolates the embedding's own visual impact from ordinary JPEG
    compression artifacts a cover has regardless of Stegstr."""
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


def measure(a, b):
    arr_a = np.asarray(a.convert("RGB"))
    arr_b = np.asarray(b.convert("RGB"))
    h = min(arr_a.shape[0], arr_b.shape[0])
    w = min(arr_a.shape[1], arr_b.shape[1])
    arr_a, arr_b = arr_a[:h, :w], arr_b[:h, :w]
    return sk_psnr(arr_a, arr_b, data_range=255), sk_ssim(arr_a, arr_b, channel_axis=2, data_range=255)


def embed(cli_env_delta_flat, cover, out_path):
    """cli_env_delta_flat unused -- delta is baked into the binary at build
    time (no runtime flag), so this just calls embed; caller swaps binaries."""
    r = subprocess.run([CLI, "embed", str(cover), "-o", str(out_path), "--payload-base64", B64, "--robust"],
                        capture_output=True, timeout=60)
    return r.returncode == 0


def survival(stego_path, expected):
    n_pass = 0
    for ch in PROFILES:
        buf = io.BytesIO(simulate(stego_path, ch))
        tmp = stego_path.with_name(f"_surv_{stego_path.stem}_{ch}.jpg")
        tmp.write_bytes(buf.getvalue())
        r = subprocess.run([CLI, "decode", str(tmp)], capture_output=True, timeout=30)
        tmp.unlink(missing_ok=True)
        if r.returncode == 0:
            out = r.stdout
            if out.startswith(b"base64:"):
                out = base64.standard_b64decode(out[7:].decode().strip())
            if out == expected:
                n_pass += 1
    return n_pass, len(PROFILES)


def main():
    covers = sorted(COVERS_DIR.glob("*.png")) + sorted(COVERS_EXT_DIR.glob("*.png"))
    print(f"{'cover':18s} {'PSNR':>8s} {'SSIM':>6s} {'survival':>9s}   (current build)")
    for cover in covers:
        stego_path = cover.with_name(f"_report_{cover.stem}.jpg")
        if not embed(None, cover, stego_path):
            print(f"{cover.name:18s}  EMBED FAILED")
            continue
        baseline_img = no_embed_baseline(cover)
        stego_img = Image.open(stego_path).convert("RGB")
        p, s = measure(baseline_img, stego_img)
        n_pass, n_total = survival(stego_path, PAYLOAD)
        print(f"{cover.name:18s} {p:8.2f} {s:6.3f} {n_pass:4d}/{n_total:<4d}")
        stego_path.unlink(missing_ok=True)


if __name__ == "__main__":
    main()

"""
Local replica of the contest's evaluation gauntlet.

Mirrors the published methodology (Evaluator Instructions v1.0, section 2) so we
can measure ourselves the way the contest owner will:

  1. embed a known 43-byte secret into a standard cover
  2. control check - decode our own untouched output first
  3. push the stego image through five lossy profiles (light -> heavy + resize)
  4. decode each; survival means the exact secret came back
  5. report PSNR and SSIM of stego vs cover

The five profiles are named after the leaderboard columns. Exact parameters are
not published, so these are deliberately a shade harsher than a plausible
reading of "light -> heavy": beating a harder test than the real one is the
safe direction to be wrong in.

    python gauntlet.py                 # current shipping CLI
    python gauntlet.py --covers photo  # single cover
"""

from __future__ import annotations

import argparse
import base64
import io
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).parent))
import covers as covers_mod  # noqa: E402
import busy_covers  # noqa: E402

REPO = Path(__file__).resolve().parent.parent
# STEGSTR_CLI lets this run against a clean clone rather than the working tree,
# which is the only way to be sure the pinned commit is what scores.
CLI = Path(os.environ.get("STEGSTR_CLI") or (REPO / "dist-cli" / "stegstr.mjs"))

#: The gauntlet embeds a known 43-byte secret.
SECRET = b"stegstr gauntlet secret payload 43 bytes!!!"
assert len(SECRET) == 43, len(SECRET)

#: (name, long_edge_cap, jpeg_quality, subsampling). 0 = no resize.
PROFILES: list[tuple[str, int, int, int]] = [
    ("Light",  0,    88, 0),
    ("Mod.",   0,    78, 2),
    ("Strong", 0,    68, 2),
    ("Heavy",  0,    55, 2),
    ("Resize", 1080, 72, 2),
]


def psnr(a: np.ndarray, b: np.ndarray) -> float:
    mse = float(np.mean((a.astype(np.float64) - b.astype(np.float64)) ** 2))
    return float("inf") if mse == 0 else 10.0 * float(np.log10(255.0 * 255.0 / mse))


def ssim(a: np.ndarray, b: np.ndarray) -> float:
    """Global SSIM on luma, 8x8 windows. Close enough for tracking a trend."""
    ya = (a[:, :, 0] * 0.299 + a[:, :, 1] * 0.587 + a[:, :, 2] * 0.114).astype(np.float64)
    yb = (b[:, :, 0] * 0.299 + b[:, :, 1] * 0.587 + b[:, :, 2] * 0.114).astype(np.float64)
    h, w = ya.shape
    h8, w8 = h // 8 * 8, w // 8 * 8
    ta = ya[:h8, :w8].reshape(h8 // 8, 8, w8 // 8, 8).transpose(0, 2, 1, 3).reshape(-1, 64)
    tb = yb[:h8, :w8].reshape(h8 // 8, 8, w8 // 8, 8).transpose(0, 2, 1, 3).reshape(-1, 64)
    mu_a, mu_b = ta.mean(1), tb.mean(1)
    va, vb = ta.var(1), tb.var(1)
    cov = ((ta - mu_a[:, None]) * (tb - mu_b[:, None])).mean(1)
    c1, c2 = (0.01 * 255) ** 2, (0.03 * 255) ** 2
    s = ((2 * mu_a * mu_b + c1) * (2 * cov + c2)) / ((mu_a**2 + mu_b**2 + c1) * (va + vb + c2))
    return float(s.mean())


def apply_profile(stego_bytes: bytes, cap: int, quality: int, subsampling: int) -> bytes:
    img = Image.open(io.BytesIO(stego_bytes)).convert("RGB")
    if cap and max(img.width, img.height) > cap:
        scale = cap / max(img.width, img.height)
        img = img.resize(
            (max(1, round(img.width * scale)), max(1, round(img.height * scale))),
            Image.LANCZOS,
        )
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=quality, subsampling=subsampling)
    return buf.getvalue()


def cli(args: list[str]) -> dict:
    proc = subprocess.run(["node", str(CLI), *args, "--json"], capture_output=True, text=True)
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError:
        return {"ok": False, "error": (proc.stderr or proc.stdout).strip()[:200]}


def embed(cover: Path, out: Path, mode: str, delta: str | None = None, quality: str | None = None) -> dict:
    extra = (["--delta", delta] if delta else []) + (["--quality", quality] if quality else [])
    return cli(["embed", str(cover), "-o", str(out),
                "--payload-base64", base64.b64encode(SECRET).decode(), "--mode", mode, *extra])


def decode(path: Path, mode: str, delta: str | None = None) -> bytes | None:
    extra = ["--delta", delta] if delta else []
    r = cli(["detect", str(path), "--mode", mode, *extra])
    if not r.get("ok"):
        return None
    return base64.b64decode(r["payload"]) if r.get("encoding") == "base64" else r["payload"].encode()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", default="locator")
    ap.add_argument("--covers", default="landscape,foliage,portrait,night")
    ap.add_argument("--delta", default=None)
    ap.add_argument("--quality", default=None)
    ap.add_argument("--ext", default="jpg", choices=["jpg", "png"])
    args = ap.parse_args()

    if not CLI.exists():
        raise SystemExit(f"build the CLI first: npm run build:cli  (missing {CLI})")

    names = [c.strip() for c in args.covers.split(",") if c.strip()]
    print(f"\nGauntlet replica - mode {args.mode}, {len(SECRET)}-byte secret\n")
    header = f"{'cover':<11}{'control':<9}" + "".join(f"{p[0]:>8}" for p in PROFILES) + f"{'PSNR':>8}{'SSIM':>8}"
    print(header)
    print("-" * len(header))

    survived = total = 0
    psnrs: list[float] = []
    ssims: list[float] = []

    with tempfile.TemporaryDirectory() as tmp:
        tmpdir = Path(tmp)
        for name in names:
            if name in busy_covers.BUSY:
                cover = busy_covers.get_busy(name, 1920, 1080)
            else:
                cover = covers_mod.get_cover(name, 1600, 1200)
            stego_path = tmpdir / f"{name}.{args.ext}"

            res = embed(cover, stego_path, args.mode, args.delta, args.quality)
            if not res.get("ok"):
                print(f"{name:<11}EMBED FAILED: {res.get('error')}")
                continue

            stego_bytes = stego_path.read_bytes()
            control = decode(stego_path, args.mode, args.delta) == SECRET

            cov_arr = np.asarray(Image.open(cover).convert("RGB"))
            steg_arr = np.asarray(Image.open(io.BytesIO(stego_bytes)).convert("RGB"))
            p, s = psnr(cov_arr, steg_arr), ssim(cov_arr, steg_arr)
            psnrs.append(p)
            ssims.append(s)

            row = f"{name:<11}{('PASS' if control else 'FAIL'):<9}"
            for pname, cap, q, sub in PROFILES:
                attacked = tmpdir / f"{name}_{pname}.jpg"
                attacked.write_bytes(apply_profile(stego_bytes, cap, q, sub))
                ok = decode(attacked, args.mode, args.delta) == SECRET
                survived += ok
                total += 1
                row += f"{('OK' if ok else 'x'):>8}"
            row += f"{p:>8.1f}{s:>8.3f}"
            print(row)

    print("-" * len(header))
    if total:
        pct = 100.0 * survived / total
        print(f"\nSurvival: {survived}/{total} ({pct:.0f}%)")
        print(f"PSNR:     {np.mean(psnrs):.1f} dB mean   (leader on the board is 50.1)")
        print(f"SSIM:     {np.mean(ssims):.4f}\n")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

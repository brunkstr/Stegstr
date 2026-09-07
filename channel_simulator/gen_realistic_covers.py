"""
Generate realistic-ish synthetic cover photos (no external downloads / copyright
concerns): textured, high-frequency, and smooth-gradient cases, to replace the
flat-color fixture used by the original baseline (which does not stress AC
coefficients at all).
"""
from __future__ import annotations

import numpy as np
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter

OUT_DIR = Path(__file__).resolve().parent / "covers"
OUT_DIR.mkdir(exist_ok=True)

rng = np.random.default_rng(42)


def textured_photo(size=768) -> Image.Image:
    """Landscape-like: gradient sky + noisy 'terrain' + shapes + blur (mimics real photo stats)."""
    h = w = size
    arr = np.zeros((h, w, 3), dtype=np.float32)
    for y in range(h):
        t = y / h
        arr[y, :, 0] = 135 * (1 - t) + 90 * t
        arr[y, :, 1] = 180 * (1 - t) + 110 * t
        arr[y, :, 2] = 235 * (1 - t) + 70 * t
    noise = rng.normal(0, 18, (h, w, 3))
    arr += noise
    img = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))
    draw = ImageDraw.Draw(img)
    for _ in range(40):
        x0, y0 = rng.integers(0, w), rng.integers(0, h)
        r = rng.integers(10, 80)
        color = tuple(int(c) for c in rng.integers(0, 255, 3))
        draw.ellipse([x0 - r, y0 - r, x0 + r, y0 + r], outline=color, width=2)
    img = img.filter(ImageFilter.GaussianBlur(0.6))
    return img


def high_freq_noise(size=768) -> Image.Image:
    """Worst case for coefficient-domain embedding: strong high-frequency energy everywhere."""
    arr = rng.integers(0, 255, (size, size, 3), dtype=np.uint8)
    img = Image.fromarray(arr)
    return img


def smooth_gradient(size=768) -> Image.Image:
    """Low-texture case: smooth gradients concentrate energy in DC/low-AC, little room in mid-AC."""
    h = w = size
    xx, yy = np.meshgrid(np.linspace(0, 255, w), np.linspace(0, 255, h))
    arr = np.stack([xx, yy, (xx + yy) / 2], axis=-1)
    return Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))


def portrait_like(size=768) -> Image.Image:
    """Face-photo-like: smooth skin-tone regions + sharper edges (hair/eyes) + blur."""
    h = w = size
    arr = np.full((h, w, 3), (200, 170, 150), dtype=np.float32)
    yy, xx = np.mgrid[0:h, 0:w]
    cx, cy = w / 2, h / 2
    mask = ((xx - cx) ** 2 / (w * 0.3) ** 2 + (yy - cy) ** 2 / (h * 0.4) ** 2) < 1
    arr[mask] = (210, 180, 160)
    noise = rng.normal(0, 8, (h, w, 3))
    arr += noise
    img = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))
    draw = ImageDraw.Draw(img)
    draw.ellipse([cx - w * 0.28, cy - h * 0.05, cx + w * 0.28, cy + h * 0.05], fill=(40, 30, 25))
    for i in range(2):
        ex = cx + (i * 2 - 1) * w * 0.12
        draw.ellipse([ex - 15, cy - 10, ex + 15, cy + 10], fill=(255, 255, 255))
        draw.ellipse([ex - 6, cy - 6, ex + 6, cy + 6], fill=(60, 40, 30))
    img = img.filter(ImageFilter.GaussianBlur(1.2))
    return img


GENERATORS = {
    "textured": textured_photo,
    "highfreq": high_freq_noise,
    "smooth": smooth_gradient,
    "portrait": portrait_like,
}


def main():
    for name, fn in GENERATORS.items():
        img = fn()
        out_png = OUT_DIR / f"{name}.png"
        out_jpg = OUT_DIR / f"{name}.jpg"
        img.save(out_png, "PNG")
        img.save(out_jpg, "JPEG", quality=95, subsampling=0)
        arr = np.array(img)
        print(f"{name}: {img.size} std={arr.std(axis=(0,1)).round(1)}")


if __name__ == "__main__":
    main()

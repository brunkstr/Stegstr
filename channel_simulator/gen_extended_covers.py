"""
Extended cover set for more extensive validation: adds scenarios the original
4 covers didn't touch -- different aspect ratios (phone portrait photos are
the overwhelmingly common real-world case, not square), a screenshot-style
image (UI + text, a very common thing people actually share), a low-light/
noisy photo, and a high-contrast outdoor scene.
"""
from __future__ import annotations

import numpy as np
from pathlib import Path
from PIL import Image, ImageDraw, ImageFilter, ImageFont

OUT_DIR = Path(__file__).resolve().parent / "covers_extended"
OUT_DIR.mkdir(exist_ok=True)

rng = np.random.default_rng(7)


def phone_portrait(w=1080, h=1920) -> Image.Image:
    """Typical phone camera aspect ratio (9:16), the overwhelmingly common
    real-world shape -- the original 4 covers were all square (768x768),
    which no phone camera actually produces."""
    arr = np.zeros((h, w, 3), dtype=np.float32)
    for y in range(h):
        t = y / h
        arr[y, :, 0] = 100 * (1 - t) + 180 * t
        arr[y, :, 1] = 140 * (1 - t) + 150 * t
        arr[y, :, 2] = 200 * (1 - t) + 120 * t
    arr += rng.normal(0, 15, (h, w, 3))
    img = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))
    draw = ImageDraw.Draw(img)
    for _ in range(60):
        x0, y0 = rng.integers(0, w), rng.integers(0, h)
        r = rng.integers(15, 100)
        color = tuple(int(c) for c in rng.integers(0, 255, 3))
        draw.ellipse([x0 - r, y0 - r, x0 + r, y0 + r], outline=color, width=3)
    return img.filter(ImageFilter.GaussianBlur(0.5))


def screenshot_like(w=1170, h=2532) -> Image.Image:
    """UI-screenshot style: flat color blocks + sharp text-like edges. A very
    common real share (chat screenshots, memes with captions) with very
    different statistics from a photo -- large uniform regions, hard edges."""
    img = Image.new("RGB", (w, h), (245, 245, 248))
    draw = ImageDraw.Draw(img)
    draw.rectangle([0, 0, w, 180], fill=(30, 32, 40))
    y = 220
    for _ in range(14):
        bh = rng.integers(60, 140)
        bw = rng.integers(int(w * 0.4), int(w * 0.9))
        color = tuple(int(c) for c in rng.integers(180, 255, 3))
        draw.rounded_rectangle([40, y, 40 + bw, y + bh], radius=20, fill=color, outline=(200, 200, 205))
        y += bh + 30
        if y > h - 150:
            break
    draw.rectangle([0, h - 140, w, h], fill=(255, 255, 255))
    return img


def low_light_noisy(size=900) -> Image.Image:
    """Dark/underexposed photo: low overall signal, high relative sensor
    noise -- stresses the encoder differently than a well-lit shot."""
    base = rng.integers(15, 45, (size, size, 3)).astype(np.float32)
    noise = rng.normal(0, 12, (size, size, 3))
    arr = np.clip(base + noise, 0, 255).astype(np.uint8)
    img = Image.fromarray(arr)
    draw = ImageDraw.Draw(img)
    for _ in range(5):
        x, y = rng.integers(0, size, 2)
        r = rng.integers(30, 90)
        draw.ellipse([x - r, y - r, x + r, y + r], fill=(80, 75, 60))
    return img.filter(ImageFilter.GaussianBlur(1.0))


def high_contrast_outdoor(size=1200) -> Image.Image:
    """Bright sky + dark silhouette -- strong edges and a wide dynamic
    range, common in real outdoor photos."""
    arr = np.zeros((size, size, 3), dtype=np.float32)
    horizon = size // 3
    arr[:horizon, :, 0] = 90
    arr[:horizon, :, 1] = 160
    arr[:horizon, :, 2] = 250
    arr[horizon:, :, 0] = 40
    arr[horizon:, :, 1] = 90
    arr[horizon:, :, 2] = 40
    arr += rng.normal(0, 10, (size, size, 3))
    img = Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8))
    draw = ImageDraw.Draw(img)
    pts = [(size * 0.2, horizon), (size * 0.35, horizon - 220), (size * 0.5, horizon),
           (size * 0.65, horizon - 300), (size * 0.8, horizon)]
    draw.polygon(pts + [(size * 0.8, horizon), (size * 0.2, horizon)], fill=(15, 20, 15))
    return img


GENERATORS = {
    "phone_portrait": phone_portrait,
    "screenshot": screenshot_like,
    "low_light": low_light_noisy,
    "high_contrast": high_contrast_outdoor,
}


def main():
    for name, fn in GENERATORS.items():
        img = fn()
        out_png = OUT_DIR / f"{name}.png"
        img.save(out_png, "PNG")
        arr = np.array(img)
        print(f"{name}: {img.size} std={arr.std(axis=(0,1)).round(1)}")


if __name__ == "__main__":
    main()

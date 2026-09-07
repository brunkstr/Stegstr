"""
Covers with genuinely high-frequency detail everywhere.

The benchmark set has a "foliage" cover, but its detail comes from smoothed
value noise, so most of its energy still sits below the canonical Nyquist. A
screenshot, a page of text, or fine fabric does not: its energy runs right up to
the pixel grid, and downsampling that to the canonical square folds it straight
into the carrier band, raising the noise floor the payload has to clear.

The contest's independent app testing reported exactly this: resize survival
drops on a detailed cover. These reproduce it.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

CACHE = Path(__file__).parent / "covers"


def _font(size: int):
    for name in ("consola.ttf", "cour.ttf", "arial.ttf"):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    return ImageFont.load_default()


def text_page(w: int, h: int) -> Image.Image:
    """Screenshot-like page of dense text: the worst case for high-frequency energy."""
    img = Image.new("RGB", (w, h), (250, 250, 248))
    d = ImageDraw.Draw(img)
    f = _font(15)
    rng = np.random.default_rng(11)
    words = ["steganography", "canonical", "coefficient", "projection", "resize",
             "payload", "dither", "spread", "modulation", "invisible", "channel",
             "recompression", "threshold", "luminance", "quantisation"]
    y = 12
    while y < h:
        line = " ".join(rng.choice(words) for _ in range(max(2, w // 95)))
        d.text((14, y), line, fill=(24, 24, 28), font=f)
        y += 21
    return img


def fine_texture(w: int, h: int) -> Image.Image:
    """Per-pixel detail with no smoothing: fabric, gravel, sensor noise."""
    rng = np.random.default_rng(23)
    base = rng.integers(60, 200, size=(h, w)).astype(np.float64)
    yy, xx = np.mgrid[0:h, 0:w]
    weave = 26 * np.sin(xx * 1.1) * np.sin(yy * 0.9)
    lum = np.clip(base + weave, 0, 255)
    rgb = np.stack([lum * 0.98, lum * 0.94, lum * 0.86], axis=-1)
    return Image.fromarray(np.clip(rgb, 0, 255).astype(np.uint8), "RGB")


def city_detail(w: int, h: int) -> Image.Image:
    """Hard edges and repeated structure: windows, bricks, railings."""
    img = Image.new("RGB", (w, h), (40, 44, 52))
    d = ImageDraw.Draw(img)
    rng = np.random.default_rng(37)
    for bx in range(0, w, 47):
        bh = int(h * rng.uniform(0.35, 0.95))
        d.rectangle([bx, h - bh, bx + 42, h], fill=tuple(int(v) for v in rng.integers(50, 110, 3)))
        for wy in range(h - bh + 8, h - 8, 13):
            for wx in range(bx + 5, bx + 38, 9):
                if rng.random() < 0.62:
                    c = int(rng.integers(150, 255))
                    d.rectangle([wx, wy, wx + 5, wy + 8], fill=(c, c - 12, c - 40))
    arr = np.asarray(img, dtype=np.float64)
    arr += np.random.default_rng(5).normal(0, 4, arr.shape)
    return Image.fromarray(np.clip(arr, 0, 255).astype(np.uint8), "RGB")


def gradient(w: int, h: int) -> Image.Image:
    """A smooth gradient, matching the scoring cover named on the leaderboard."""
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float64)
    lum = 40 + 170 * (xx / w * 0.6 + yy / h * 0.4)
    rgb = np.stack([lum * 1.0, lum * 0.95, lum * 0.88], axis=-1)
    return Image.fromarray(np.clip(rgb, 0, 255).astype(np.uint8), "RGB")


BUSY = {"textpage": text_page, "finetexture": fine_texture,
        "citydetail": city_detail, "gradient": gradient}


def get_busy(kind: str, w: int = 1920, h: int = 1080) -> Path:
    CACHE.mkdir(exist_ok=True)
    p = CACHE / f"{kind}_{w}x{h}.png"
    if not p.exists():
        BUSY[kind](w, h).save(p)
    return p


def high_frequency_share(path) -> float:
    """Fraction of spectral energy above half Nyquist. Higher = busier."""
    from scipy.fft import dctn
    y = np.asarray(Image.open(path).convert("L"), dtype=np.float64)
    c = np.abs(dctn(y, norm="ortho"))
    n0, n1 = c.shape
    u = np.arange(n0)[:, None] / n0
    v = np.arange(n1)[None, :] / n1
    r = np.sqrt(u ** 2 + v ** 2)
    total = float((c ** 2).sum())
    return float((c[r > 0.5] ** 2).sum() / total) if total else 0.0


if __name__ == "__main__":
    import covers as base
    print(f"{'cover':<16}{'energy above half-Nyquist':>28}")
    print("-" * 44)
    for k in base.GENERATORS:
        print(f"{k:<16}{high_frequency_share(base.get_cover(k, 1600, 1200)):>27.4%}")
    for k in BUSY:
        print(f"{k:<16}{high_frequency_share(get_busy(k)):>27.4%}")

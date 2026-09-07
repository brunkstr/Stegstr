"""
Cover images for benchmarking.

Steganography benchmarks are meaningless on flat synthetic images: a smooth
gradient has almost no high-frequency energy, so embedding noise both hides
badly and survives unrealistically well. These covers span the range that
matters — smooth sky, busy foliage, hard edges, and low light.
"""

from __future__ import annotations

from pathlib import Path

import numpy as np
from PIL import Image

CACHE = Path(__file__).parent / "covers"


def _fbm(h: int, w: int, octaves: int, rng: np.random.Generator) -> np.ndarray:
    """Fractal Brownian motion — 1/f noise, the texture statistic of photographs."""
    out = np.zeros((h, w))
    amp = 1.0
    for o in range(octaves):
        size = max(2, 2 ** (o + 2))
        coarse = rng.random((min(size, h), min(size, w)))
        layer = np.asarray(
            Image.fromarray((coarse * 255).astype(np.uint8)).resize((w, h), Image.BICUBIC),
            dtype=np.float64,
        ) / 255.0
        out += amp * layer
        amp *= 0.5
    out -= out.min()
    return out / max(out.max(), 1e-9)


def _landscape(h: int, w: int, seed: int) -> np.ndarray:
    """Smooth sky over textured ground: the hardest realistic mix."""
    rng = np.random.default_rng(seed)
    yy = np.linspace(0, 1, h)[:, None]
    sky = np.clip(1.3 - yy * 1.6, 0, 1)
    ground = _fbm(h, w, 6, rng)
    horizon = 1 / (1 + np.exp(-(yy - 0.45) * 40))
    lum = sky * (1 - horizon) + ground * horizon
    rgb = np.stack([lum * 0.75 + 0.2, lum * 0.85 + 0.12, lum * 1.0 + 0.05], axis=-1)
    rgb += rng.normal(0, 0.006, rgb.shape)
    return np.clip(rgb, 0, 1)


def _foliage(h: int, w: int, seed: int) -> np.ndarray:
    """High-detail texture everywhere — lots of places to hide, lots of noise."""
    rng = np.random.default_rng(seed)
    base = _fbm(h, w, 8, rng)
    detail = _fbm(h, w, 9, rng)
    lum = np.clip(base * 0.6 + detail * 0.5, 0, 1)
    rgb = np.stack([lum * 0.55 + 0.05, lum * 0.9 + 0.08, lum * 0.4 + 0.04], axis=-1)
    rgb += rng.normal(0, 0.01, rgb.shape)
    return np.clip(rgb, 0, 1)


def _portrait(h: int, w: int, seed: int) -> np.ndarray:
    """Large smooth skin areas with a blurred background — worst case for hiding."""
    rng = np.random.default_rng(seed)
    yy, xx = np.mgrid[0:h, 0:w].astype(np.float64)
    cy, cx = h * 0.45, w * 0.5
    r = np.sqrt(((yy - cy) / (h * 0.32)) ** 2 + ((xx - cx) / (w * 0.26)) ** 2)
    face = np.clip(1.15 - r, 0, 1)
    bg = _fbm(h, w, 3, rng) * 0.35 + 0.25
    lum = np.where(r < 1.0, 0.62 + face * 0.22, bg)
    rgb = np.stack([lum * 1.0 + 0.06, lum * 0.82 + 0.03, lum * 0.72 + 0.02], axis=-1)
    rgb += rng.normal(0, 0.004, rgb.shape)
    return np.clip(rgb, 0, 1)


def _night(h: int, w: int, seed: int) -> np.ndarray:
    """Dark frame with sensor noise and a few blown highlights."""
    rng = np.random.default_rng(seed)
    lum = _fbm(h, w, 7, rng) * 0.22
    for _ in range(14):
        gy, gx = rng.integers(0, h), rng.integers(0, w)
        yy, xx = np.mgrid[0:h, 0:w]
        d = np.sqrt((yy - gy) ** 2 + (xx - gx) ** 2)
        lum += np.exp(-d / max(6, min(h, w) * 0.01)) * rng.uniform(0.4, 1.0)
    lum = np.clip(lum, 0, 1)
    rgb = np.stack([lum * 1.0, lum * 0.9 + 0.01, lum * 0.75 + 0.03], axis=-1)
    rgb += rng.normal(0, 0.018, rgb.shape)
    return np.clip(rgb, 0, 1)


GENERATORS = {
    "landscape": _landscape,
    "foliage": _foliage,
    "portrait": _portrait,
    "night": _night,
}


def get_cover(kind: str, width: int = 1600, height: int = 1200) -> Path:
    """Return a path to a cached cover image, generating it on first use."""
    CACHE.mkdir(exist_ok=True)
    path = CACHE / f"{kind}_{width}x{height}.png"
    if not path.exists():
        seed = abs(hash(kind)) % 100000
        arr = GENERATORS[kind](height, width, seed)
        Image.fromarray((arr * 255).astype(np.uint8), "RGB").save(path)
    return path


def all_covers(width: int = 1600, height: int = 1200) -> dict[str, Path]:
    return {k: get_cover(k, width, height) for k in GENERATORS}

"""
Measure which canonical-DCT frequencies actually survive each platform.

Rather than guessing a mid-frequency band, embed one STDM bit in every radial
ring of the canonical spectrum, push the image through a channel, and read the
bits back. The resulting bit-error-rate per ring is the channel's frequency
response as our detector sees it, and it tells us exactly which rings are
usable and how much spreading each needs.
"""

from __future__ import annotations

import io
import random
import sys
from pathlib import Path

import numpy as np
from PIL import Image
from scipy.fft import dctn, idctn

sys.path.insert(0, str(Path(__file__).parent))

import channel  # noqa: E402
import covers  # noqa: E402
from stdm import _from_canonical, _load_rgb, _luma, _to_canonical  # noqa: E402

CANON = 512
RINGS = 16
R_MAX = 1.0
CHIPS = 128
DELTA = 26.0
TRIALS = 4


def ring_masks(n: int, rings: int, r_max: float) -> list[np.ndarray]:
    u = np.arange(n)[:, None]
    v = np.arange(n)[None, :]
    r = np.sqrt((u / n) ** 2 + (v / n) ** 2).reshape(-1)
    edges = np.linspace(0.02, r_max, rings + 1)
    return [np.flatnonzero((r >= edges[i]) & (r < edges[i + 1])) for i in range(rings)]


def build(seed: int, n: int, rings: int, r_max: float, chips: int, reps: int):
    """For each ring, `reps` independent bit carriers drawn from that ring."""
    rng = np.random.default_rng(seed)
    out = []
    for idx in ring_masks(n, rings, r_max):
        if idx.size < chips * reps:
            out.append(None)
            continue
        pick = rng.permutation(idx)[: chips * reps].reshape(reps, chips)
        sign = rng.choice(np.array([-1.0, 1.0]), size=(reps, chips))
        out.append((pick, sign))
    return out


def main() -> None:
    reps = 24  # bits per ring, so each BER figure averages over 24 carriers
    carriers = build(12345, CANON, RINGS, R_MAX, CHIPS, reps)
    rng_bits = np.random.default_rng(999)
    inv = 1.0 / np.sqrt(CHIPS)

    platforms = ["telegram_file", "facebook", "twitter", "telegram", "instagram",
                 "whatsapp", "whatsapp_twice"]
    err = {p: np.zeros(RINGS) for p in platforms}
    cnt = np.zeros(RINGS)
    psnrs = []

    for kind in ["landscape", "foliage", "portrait", "night"]:
        cover = covers.get_cover(kind, 1600, 1200)
        rgb = _load_rgb(cover)
        h, w = rgb.shape[:2]
        canon = _to_canonical(_luma(rgb), CANON)
        coeffs = dctn(canon, norm="ortho")
        flat = coeffs.reshape(-1)

        truth = {}
        for ri, car in enumerate(carriers):
            if car is None:
                continue
            pick, sign = car
            bits = rng_bits.integers(0, 2, size=reps).astype(np.float64)
            truth[ri] = bits
            host = (flat[pick] * sign).sum(axis=1) * inv
            k = np.round(host / DELTA)
            k = np.where(np.mod(k, 2) == bits, k, k + 1.0)
            corr = (k * DELTA - host) * inv
            np.add.at(flat, pick, corr[:, None] * sign)

        stego_canon = idctn(flat.reshape(CANON, CANON), norm="ortho")
        delta_plane = _from_canonical(stego_canon - canon, w, h)
        out = np.clip(rgb + delta_plane[:, :, None], 0, 255)
        buf = io.BytesIO()
        Image.fromarray(out.astype(np.uint8), "RGB").save(
            buf, format="JPEG", quality=92, subsampling=0
        )
        stego = buf.getvalue()
        psnrs.append(channel.psnr(cover, Image.open(io.BytesIO(stego))))

        for plat in platforms:
            for t in range(TRIALS):
                att = channel.simulate(stego, plat, rng=random.Random((hash(kind) + t) & 0xFFFF))
                rcanon = _to_canonical(_luma(_load_rgb(att)), CANON)
                rflat = dctn(rcanon, norm="ortho").reshape(-1)
                for ri, car in enumerate(carriers):
                    if car is None:
                        continue
                    pick, sign = car
                    proj = (rflat[pick] * sign).sum(axis=1) * inv
                    got = np.mod(np.round(proj / DELTA), 2)
                    err[plat][ri] += float(np.sum(got != truth[ri]))
                    if plat == platforms[0] and t == 0:
                        cnt[ri] += reps

    total = cnt * TRIALS
    edges = np.linspace(0.02, R_MAX, RINGS + 1)

    print(f"\nSTDM bit-error rate per canonical frequency ring "
          f"(canonical {CANON}, {CHIPS} chips/bit, delta {DELTA})")
    print(f"Mean stego PSNR: {np.mean(psnrs):.1f} dB\n")
    head = f"{'ring (r)':<16}{'cycles':<9}" + "".join(f"{p[:9]:>11}" for p in platforms)
    print(head)
    print("-" * len(head))
    for ri in range(RINGS):
        if total[ri] == 0:
            continue
        cyc = f"{edges[ri] * CANON / 2:.0f}-{edges[ri+1] * CANON / 2:.0f}"
        row = f"{f'{edges[ri]:.2f}-{edges[ri+1]:.2f}':<16}{cyc:<9}"
        for p in platforms:
            row += f"{err[p][ri] / total[ri] * 100:>10.1f}%"
        print(row)


if __name__ == "__main__":
    main()

"""
Faithful port of the *shipping* Stegstr encoder (`src/stego-qim.ts`).

This exists to measure the real baseline. The TypeScript version only runs in a
browser (it needs canvas for JPEG encode/decode), so its end-to-end behaviour
is never exercised by the vitest suite. Reproducing it in numpy lets us push it
through the channel models and get an honest survival number to beat.

Everything here mirrors stego-qim.ts constant for constant:
  QIM_DELTA = 14, QIM_REPEAT = 5, QIM_RS_NSYM = 128, quality 75, AC 1..24,
  AC-major coefficient ordering, QIM applied to *quantised* coefficients.
"""

from __future__ import annotations

import io
import zlib

import numpy as np
from PIL import Image
from reedsolo import RSCodec, ReedSolomonError

MAGIC = b"STEGSTR"
LENGTH_BYTES = 4

QIM_DELTA = 14
QIM_RS_NSYM = 128
QIM_REPEAT = 5
QIM_EMBED_QUALITY = 75

# Zigzag order, position -> (row, col). Matches ZIGZAG_2D in src/dct.ts.
ZIGZAG_2D = [
    (0, 0), (0, 1), (1, 0), (2, 0), (1, 1), (0, 2), (0, 3), (1, 2),
    (2, 1), (3, 0), (4, 0), (3, 1), (2, 2), (1, 3), (0, 4), (0, 5),
    (1, 4), (2, 3), (3, 2), (4, 1), (5, 0), (6, 0), (5, 1), (4, 2),
    (3, 3), (2, 4), (1, 5), (0, 6), (0, 7), (1, 6), (2, 5), (3, 4),
    (4, 3), (5, 2), (6, 1), (7, 0), (7, 1), (6, 2), (5, 3), (4, 4),
    (3, 5), (2, 6), (1, 7), (2, 7), (3, 6), (4, 5), (5, 4), (6, 3),
    (7, 2), (7, 3), (6, 4), (5, 5), (4, 6), (3, 7), (4, 7), (5, 6),
    (6, 5), (7, 4), (7, 5), (6, 6), (5, 7), (6, 7), (7, 6), (7, 7),
]
AC_INDICES = list(range(1, 25))

Q50_LUMINANCE = np.array([
    16, 11, 10, 16, 24, 40, 51, 61,
    12, 14, 13, 17, 26, 58, 60, 55,
    14, 13, 16, 24, 40, 57, 69, 56,
    14, 17, 22, 29, 51, 87, 80, 62,
    18, 22, 37, 56, 68, 109, 103, 77,
    24, 35, 55, 64, 81, 104, 113, 92,
    49, 64, 78, 87, 103, 121, 120, 101,
    72, 92, 95, 98, 112, 100, 103, 99,
], dtype=np.float64).reshape(8, 8)


def quantization_table(quality: int) -> np.ndarray:
    q = max(1, min(100, quality))
    scale = 5000 / q if q < 50 else 200 - 2 * q
    return np.maximum(1, np.floor((Q50_LUMINANCE * scale + 50) / 100))


def _dct_matrix() -> np.ndarray:
    m = np.zeros((8, 8))
    for k in range(8):
        for n in range(8):
            a = np.sqrt(1 / 8) if k == 0 else np.sqrt(2 / 8)
            m[k, n] = a * np.cos((2 * n + 1) * k * np.pi / 16)
    return m


_D = _dct_matrix()


def dct2(block: np.ndarray) -> np.ndarray:
    return _D @ block @ _D.T


def idct2(coeffs: np.ndarray) -> np.ndarray:
    return _D.T @ coeffs @ _D


def _to_bits(data: bytes) -> np.ndarray:
    return np.unpackbits(np.frombuffer(data, dtype=np.uint8))


def _from_bits(bits: np.ndarray) -> bytes:
    usable = (len(bits) // 8) * 8
    return np.packbits(bits[:usable].astype(np.uint8)).tobytes()


def _qim_embed(x: float, bit: int, delta: float) -> float:
    cell = round(x / delta) * delta
    offset = ((-1) ** (bit + 1)) * (delta / 4.0)
    return round(cell + offset)


def _qim_detect(z: float, delta: float) -> tuple[int, float]:
    cell = round(z / delta) * delta
    d0 = abs(z - (cell - delta / 4.0))
    d1 = abs(z - (cell + delta / 4.0))
    return (0 if d0 <= d1 else 1), abs(d0 - d1)


def _rgb_to_y(rgb: np.ndarray) -> np.ndarray:
    return 0.299 * rgb[:, :, 0] + 0.587 * rgb[:, :, 1] + 0.114 * rgb[:, :, 2]


def embed(image_path, payload: bytes, quality: int = QIM_EMBED_QUALITY) -> bytes:
    """Embed exactly the way src/stego-qim.ts does, returning JPEG bytes."""
    img = Image.open(image_path).convert("RGB")
    pixels = np.asarray(img, dtype=np.float64).copy()
    height, width = pixels.shape[:2]

    body = zlib.compress(payload)
    raw = MAGIC + len(body).to_bytes(4, "big") + body
    codeword = bytes(RSCodec(QIM_RS_NSYM).encode(raw))
    to_embed = len(codeword).to_bytes(2, "big") + codeword

    bits = np.repeat(_to_bits(to_embed), QIM_REPEAT)

    blocks_y, blocks_x = height // 8, width // 8
    blocks_per_plane = blocks_y * blocks_x
    capacity = blocks_per_plane * len(AC_INDICES)
    if len(bits) > capacity:
        raise ValueError(f"payload too large: need {len(bits)} bits, have {capacity}")

    qt = quantization_table(quality)
    y = _rgb_to_y(pixels)

    for br in range(blocks_y):
        for bc in range(blocks_x):
            block = y[br * 8:(br + 1) * 8, bc * 8:(bc + 1) * 8] - 128.0
            qc = np.round(dct2(block) / qt)

            modified = False
            for zi in range(len(AC_INDICES)):
                # AC-major stream index, exactly as buildCoeffStream() orders it.
                idx = zi * blocks_per_plane + br * blocks_x + bc
                if idx >= len(bits):
                    continue
                dy, dx = ZIGZAG_2D[AC_INDICES[zi]]
                new = _qim_embed(qc[dy, dx], int(bits[idx]), QIM_DELTA)
                if new != qc[dy, dx]:
                    qc[dy, dx] = new
                    modified = True

            if not modified:
                continue

            spatial = idct2(qc * qt) + 128.0
            y_diff = spatial - y[br * 8:(br + 1) * 8, bc * 8:(bc + 1) * 8]
            # stego-qim.ts adds the luminance delta to R, G and B alike.
            for ch in range(3):
                sub = pixels[br * 8:(br + 1) * 8, bc * 8:(bc + 1) * 8, ch]
                pixels[br * 8:(br + 1) * 8, bc * 8:(bc + 1) * 8, ch] = np.clip(
                    np.round(sub + y_diff), 0, 255
                )

    out = Image.fromarray(pixels.astype(np.uint8), "RGB")
    buf = io.BytesIO()
    out.save(buf, format="JPEG", quality=quality, subsampling=2)
    return buf.getvalue()


def detect(image, quality: int = QIM_EMBED_QUALITY) -> bytes | None:
    """Extract exactly the way src/stego-qim.ts does. None if nothing decodes."""
    if isinstance(image, (bytes, bytearray)):
        img = Image.open(io.BytesIO(bytes(image))).convert("RGB")
    else:
        img = Image.open(image).convert("RGB")

    pixels = np.asarray(img, dtype=np.float64)
    height, width = pixels.shape[:2]
    blocks_y, blocks_x = height // 8, width // 8
    blocks_per_plane = blocks_y * blocks_x
    if blocks_per_plane == 0:
        return None

    qt = quantization_table(quality)
    y = _rgb_to_y(pixels)

    coeffs = np.zeros((len(AC_INDICES), blocks_y, blocks_x))
    for br in range(blocks_y):
        for bc in range(blocks_x):
            block = y[br * 8:(br + 1) * 8, bc * 8:(bc + 1) * 8] - 128.0
            qc = np.round(dct2(block) / qt)
            for zi in range(len(AC_INDICES)):
                dy, dx = ZIGZAG_2D[AC_INDICES[zi]]
                coeffs[zi, br, bc] = qc[dy, dx]

    flat = coeffs.reshape(-1)
    raw_bits = np.empty(len(flat), dtype=np.uint8)
    for i, z in enumerate(flat):
        raw_bits[i], _ = _qim_detect(z, QIM_DELTA)

    usable = (len(raw_bits) // QIM_REPEAT) * QIM_REPEAT
    votes = raw_bits[:usable].reshape(-1, QIM_REPEAT).sum(axis=1)
    bits = (votes > QIM_REPEAT // 2).astype(np.uint8)

    if len(bits) < 16:
        return None
    header = _from_bits(bits[:16])
    codeword_len = (header[0] << 8) | header[1]
    total_bits = (2 + codeword_len) * 8
    if codeword_len <= QIM_RS_NSYM or len(bits) < total_bits:
        return None

    codeword = _from_bits(bits[:total_bits])[2:2 + codeword_len]
    try:
        decoded = bytes(RSCodec(QIM_RS_NSYM).decode(codeword)[0])
    except (ReedSolomonError, Exception):
        return None

    if not decoded.startswith(MAGIC):
        return None
    body_len = int.from_bytes(decoded[7:11], "big")
    body = decoded[11:11 + body_len]
    try:
        return zlib.decompress(body)
    except zlib.error:
        return body

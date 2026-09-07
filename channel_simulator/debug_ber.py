"""Measure raw QIM bit-error-rate (before RS correction) per cover x channel."""
from __future__ import annotations

import struct
import sys
import tempfile
from pathlib import Path

import numpy as np
import jpeglib

sys.path.insert(0, str(Path(__file__).resolve().parent))

from channel import simulate, PROFILES
from dct_variants import (
    QIM_DELTA, QIM_REPEAT, QIM_EMBED_QUALITY, QIM_DEFAULT_WIDTH,
    _qim_embed, _qim_detect, _repeat_bits, _coeff_stream, _block_zigzag_index_to_2d,
)
from dct_stego import MAGIC, LENGTH_BYTES, _to_bits

COVERS_DIR = Path(__file__).resolve().parent / "covers"
PAYLOAD = b"x" * 50


def encode_get_bits_and_stego(cover_path: Path, payload: bytes):
    from PIL import Image
    img = Image.open(cover_path).convert("RGB")
    if img.width > QIM_DEFAULT_WIDTH:
        ratio = QIM_DEFAULT_WIDTH / img.width
        img = img.resize((QIM_DEFAULT_WIDTH, max(1, round(img.height * ratio))), Image.Resampling.LANCZOS)
    tmp = Path(tempfile.mktemp(suffix=".jpg"))
    img.save(tmp, "JPEG", quality=QIM_EMBED_QUALITY, subsampling=0)
    jpeg = jpeglib.read_dct(str(tmp))
    tmp.unlink(missing_ok=True)
    Y = np.array(jpeg.Y, dtype=np.int32)
    raw = MAGIC + struct.pack(">I", len(payload)) + payload
    bits = _to_bits(raw)
    bits = _repeat_bits(bits, QIM_REPEAT)
    stream = _coeff_stream(Y)
    bits = bits[: min(len(bits), len(stream))]
    for i, bit in enumerate(bits):
        by, bx, zi = stream[i]
        dy, dx = _block_zigzag_index_to_2d(zi)
        c = float(Y[by, bx, dy, dx])
        Y[by, bx, dy, dx] = np.int16(np.clip(_qim_embed(c, bit, QIM_DELTA), -32767, 32767))
    out = Path(tempfile.mktemp(suffix=".jpg"))
    jpeg_out = jpeglib.from_dct(Y.astype(np.int16), jpeg.Cb, jpeg.Cr, qt=jpeg.qt)
    jpeg_out.write_dct(str(out), quality=-1)
    stego_bytes = out.read_bytes()
    out.unlink(missing_ok=True)
    return bits, stego_bytes, len(stream)


def measure_ber(stego_bytes: bytes, expected_bits: list[int]) -> tuple[float, int]:
    with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as f:
        f.write(stego_bytes)
        path = Path(f.name)
    try:
        jpeg = jpeglib.read_dct(str(path))
        Y = np.array(jpeg.Y, dtype=np.int32)
        stream = _coeff_stream(Y)
        n = min(len(expected_bits), len(stream))
        errors = 0
        for i in range(n):
            by, bx, zi = stream[i]
            dy, dx = _block_zigzag_index_to_2d(zi)
            c = float(Y[by, bx, dy, dx])
            got = _qim_detect(c, QIM_DELTA)
            if got != expected_bits[i]:
                errors += 1
        return errors / n, n
    finally:
        path.unlink(missing_ok=True)


def main():
    covers = sorted(COVERS_DIR.glob("*.png"))
    channels = list(PROFILES.keys())
    print(f"{'cover':10} | " + " | ".join(f"{c:>10}" for c in channels))
    for cover in covers:
        bits, stego_bytes, n_coeffs = encode_get_bits_and_stego(cover, PAYLOAD)
        tmp_stego = cover.with_name(f"_dbg_{cover.stem}.jpg")
        tmp_stego.write_bytes(stego_bytes)
        row = []
        for ch in channels:
            after = simulate(tmp_stego, ch)
            ber, n = measure_ber(after, bits)
            row.append(f"{ber*100:9.1f}%")
        tmp_stego.unlink(missing_ok=True)
        print(f"{cover.stem:10} | " + " | ".join(row))


if __name__ == "__main__":
    main()

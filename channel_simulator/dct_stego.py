"""
DCT-domain (JPEG) steganography prototype with Reed-Solomon error correction.
Embeds payload in LSB of selected AC coefficients (Y channel) so it can survive
recompression better than spatial/wavelet methods. Use with the channel simulator
to test robustness.
"""

from __future__ import annotations

import struct
import tempfile
from pathlib import Path

import numpy as np

try:
    import jpeglib
except ImportError:
    jpeglib = None

try:
    from reedsolo import RSCodec
except ImportError:
    RSCodec = None

MAGIC = b"STEGSTR"
MAGIC_LEN = 7
LENGTH_BYTES = 4
RS_NSYM = 32
# Standard JPEG zigzag: zigzag position k -> (row, col) in 8x8 block
ZIGZAG_2D = [
    (0, 0), (0, 1), (1, 0), (2, 0), (1, 1), (0, 2), (0, 3), (1, 2), (2, 1), (3, 0),
    (4, 0), (3, 1), (2, 2), (1, 3), (0, 4), (0, 5), (1, 4), (2, 3), (3, 2), (4, 1),
    (5, 0), (6, 0), (5, 1), (4, 2), (3, 3), (2, 4), (1, 5), (0, 6), (0, 7), (1, 6),
    (2, 5), (3, 4), (4, 3), (5, 2), (6, 1), (7, 0), (7, 1), (6, 2), (5, 3), (4, 4),
    (3, 5), (2, 6), (1, 7), (2, 7), (3, 6), (4, 5), (5, 4), (6, 3), (7, 2), (7, 3),
    (6, 4), (5, 5), (4, 6), (3, 7), (4, 7), (5, 6), (6, 5), (7, 4), (7, 5), (6, 6),
    (5, 7), (6, 7), (7, 6), (7, 7),
]
AC_INDICES = list(range(1, 25))


def _to_bits(data: bytes) -> list[int]:
    out: list[int] = []
    for b in data:
        for i in range(7, -1, -1):
            out.append((b >> i) & 1)
    return out


def _from_bits(bits: list[int]) -> bytes:
    out = bytearray()
    for i in range(0, len(bits), 8):
        if i + 8 > len(bits):
            break
        byte = 0
        for j in range(8):
            byte = (byte << 1) | (bits[i + j] & 1)
        out.append(byte)
    return bytes(out)


def _wrap_payload(payload: bytes, use_rs: bool = True, rs_nsym: int = 32) -> bytes:
    raw = MAGIC + struct.pack(">I", len(payload)) + payload
    if use_rs and RSCodec is not None:
        codeword = RSCodec(rs_nsym).encode(raw)
        return struct.pack(">H", len(codeword)) + codeword
    codeword = raw
    return struct.pack(">H", len(codeword)) + codeword


def _unwrap_payload(data: bytes, use_rs: bool = True, rs_nsym: int = 32) -> bytes | None:
    if len(data) < 2:
        return None
    (codeword_len,) = struct.unpack(">H", data[:2])
    if len(data) < 2 + codeword_len:
        return None
    codeword = data[2 : 2 + codeword_len]
    if use_rs and RSCodec is not None:
        try:
            decoded = RSCodec(rs_nsym).decode(codeword)[0]
        except Exception:
            return None
    else:
        decoded = codeword
    if len(decoded) < MAGIC_LEN + LENGTH_BYTES or decoded[:MAGIC_LEN] != MAGIC:
        return None
    (plen,) = struct.unpack(">I", decoded[MAGIC_LEN : MAGIC_LEN + LENGTH_BYTES])
    if len(decoded) < MAGIC_LEN + LENGTH_BYTES + plen:
        return None
    return decoded[MAGIC_LEN + LENGTH_BYTES : MAGIC_LEN + LENGTH_BYTES + plen]


def _coeff_stream(Y: np.ndarray) -> list[tuple[int, int, int]]:
    nby, nbx, _, _ = Y.shape
    out: list[tuple[int, int, int]] = []
    for by in range(nby):
        for bx in range(nbx):
            for zi in range(len(AC_INDICES)):
                out.append((by, bx, zi))
    return out


def _block_zigzag_index_to_2d(zi: int) -> tuple[int, int]:
    return ZIGZAG_2D[AC_INDICES[zi]]


def encode_dct(cover_path: str | Path, payload: bytes, quality: int = 85, use_rs: bool = True, rs_nsym: int = 32) -> bytes:
    if jpeglib is None:
        raise RuntimeError("jpeglib is required for DCT steganography; pip install jpeglib")
    cover_path = Path(cover_path)
    if not cover_path.exists():
        raise FileNotFoundError(cover_path)
    if cover_path.suffix.lower() in (".png", ".gif", ".bmp"):
        from PIL import Image
        img = Image.open(cover_path)
        img = img.convert("RGB")
        tmp_jpeg = Path(tempfile.mktemp(suffix=".jpg"))
        try:
            img.save(tmp_jpeg, "JPEG", quality=quality, subsampling=0)
            jpeg_path = tmp_jpeg
        except Exception:
            tmp_jpeg.unlink(missing_ok=True)
            raise
    else:
        jpeg_path = cover_path
        tmp_jpeg = None
    try:
        jpeg = jpeglib.read_dct(str(jpeg_path))
    finally:
        if tmp_jpeg is not None:
            tmp_jpeg.unlink(missing_ok=True)
    Y = np.array(jpeg.Y, dtype=np.int32)
    to_embed = _wrap_payload(payload, use_rs=use_rs, rs_nsym=rs_nsym)
    bits = _to_bits(to_embed)
    stream = _coeff_stream(Y)
    if len(bits) > len(stream):
        raise ValueError(f"Payload too large: need {len(bits)} bits, have {len(stream)} coefficients")
    for i, bit in enumerate(bits):
        by, bx, zi = stream[i]
        dy, dx = _block_zigzag_index_to_2d(zi)
        c = int(Y[by, bx, dy, dx])
        if c == 0:
            c = 2 if bit == 0 else 1
        else:
            c_odd = c & 1
            if c_odd != bit:
                if c > 0:
                    c = c - 1
                else:
                    c = c + 1
        Y[by, bx, dy, dx] = np.int16(np.clip(c, -32767, 32767))
    out_path = Path(tempfile.mktemp(suffix=".jpg"))
    try:
        jpeg_out = jpeglib.from_dct(Y.astype(np.int16), jpeg.Cb, jpeg.Cr, qt=jpeg.qt)
        jpeg_out.write_dct(str(out_path), quality=-1)
        return out_path.read_bytes()
    finally:
        out_path.unlink(missing_ok=True)


def decode_dct(jpeg_bytes: bytes, use_rs: bool = True, rs_nsym: int = 32) -> bytes | None:
    if jpeglib is None:
        raise RuntimeError("jpeglib is required; pip install jpeglib")
    with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as f:
        f.write(jpeg_bytes)
        path = Path(f.name)
    try:
        jpeg = jpeglib.read_dct(str(path))
        Y = np.array(jpeg.Y, dtype=np.int32)
        stream = _coeff_stream(Y)
        bits: list[int] = []
        for by, bx, zi in stream:
            dy, dx = _block_zigzag_index_to_2d(zi)
            c = int(Y[by, bx, dy, dx])
            bits.append(c & 1)
        if len(bits) < 16:
            return None
        (codeword_len,) = struct.unpack(">H", _from_bits(bits[:16]))
        total_bits = (2 + codeword_len) * 8
        if len(bits) < total_bits:
            return None
        raw = _from_bits(bits[:total_bits])
        return _unwrap_payload(raw, use_rs=use_rs, rs_nsym=rs_nsym)
    finally:
        path.unlink(missing_ok=True)


def decode_dct_from_path(jpeg_path: str | Path, use_rs: bool = True, rs_nsym: int = 32) -> bytes | None:
    data = Path(jpeg_path).read_bytes()
    return decode_dct(data, use_rs=use_rs, rs_nsym=rs_nsym)

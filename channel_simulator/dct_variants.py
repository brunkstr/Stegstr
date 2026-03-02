"""
DCT steganography variants for robustness research:
- sign: Sign-based embedding (bit in sign of coefficient; more stable under recompression)
- tcm:  TCM-inspired: use only coefficients with |c|>=2, fewer AC positions, stronger RS
- rs64: Same as base DCT but RS_NSYM=64 (double parity for harsher channels)
- qim:  Quantization Index Modulation; coarser quantization for robustness to requantization
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

from dct_stego import (
    AC_INDICES,
    LENGTH_BYTES,
    MAGIC,
    MAGIC_LEN,
    ZIGZAG_2D,
    _block_zigzag_index_to_2d,
    _from_bits,
    _to_bits,
    _unwrap_payload,
    _wrap_payload,
    _coeff_stream,
    decode_dct,
    encode_dct,
)

TCM_AC_COUNT = 16
TCM_RS_NSYM = 48
RS64_NSYM = 64
QIM_DELTA = 14  # Tuned: 14 needed for WhatsApp standard (Q=65); 10 works for most others
QIM_RS_NSYM = 128  # Stronger parity for harsh channels (WhatsApp)
QIM_REPEAT = 5  # Tuned: 5x repeat for robust majority voting across all platforms
QIM_MAX_WIDTH = 0  # 0 = use platform-matched pre-resize (see QIM_PLATFORM_WIDTHS)
QIM_EMBED_QUALITY = 75  # Tuned: match or slightly below platform quality
QIM_ERASURE_MARGIN = QIM_DELTA / 6.0  # Mark low-confidence bytes as erasures

# Platform-matched pre-resize widths (key insight: match platform's max_width to avoid resize)
QIM_PLATFORM_WIDTHS = {
    "instagram": 1080,
    "facebook": 2048,
    "twitter": 1600,
    "whatsapp_standard": 1600,
    "whatsapp_hd": 4096,
    "telegram_photo": 1920,
    "imessage": 1280,
}
QIM_DEFAULT_WIDTH = 1080  # Universal default when platform unknown


def _coeff_stream_tcm(Y: np.ndarray) -> list[tuple[int, int, int]]:
    """First TCM_AC_COUNT AC positions (mid-frequency, more stable). Fixed order for encode/decode."""
    nby, nbx, _, _ = Y.shape
    out = []
    for by in range(nby):
        for bx in range(nbx):
            for zi in range(min(TCM_AC_COUNT, len(AC_INDICES))):
                out.append((by, bx, zi))
    return out


def encode_dct_sign(cover_path: str | Path, payload: bytes, quality: int = 85) -> bytes:
    """Sign-based: bit 0 = negative, bit 1 = positive. More stable under recompression."""
    cover_path = Path(cover_path)
    if cover_path.suffix.lower() in (".png", ".gif", ".bmp"):
        from PIL import Image
        img = Image.open(cover_path).convert("RGB")
        tmp = Path(tempfile.mktemp(suffix=".jpg"))
        img.save(tmp, "JPEG", quality=quality, subsampling=0)
        jpeg_path = tmp
    else:
        jpeg_path = cover_path
        tmp = None
    try:
        jpeg = jpeglib.read_dct(str(jpeg_path))
    finally:
        if tmp:
            tmp.unlink(missing_ok=True)
    Y = np.array(jpeg.Y, dtype=np.int32)
    to_embed = _wrap_payload(payload, use_rs=True, rs_nsym=32)
    bits = _to_bits(to_embed)
    stream = _coeff_stream(Y)
    if len(bits) > len(stream):
        raise ValueError(f"Payload too large: {len(bits)} bits, {len(stream)} coeffs")
    for i, bit in enumerate(bits):
        by, bx, zi = stream[i]
        dy, dx = _block_zigzag_index_to_2d(zi)
        c = int(Y[by, bx, dy, dx])
        if c == 0:
            c = 1 if bit else -1
        else:
            want_positive = bool(bit)
            if (c > 0) != want_positive:
                c = -c
        Y[by, bx, dy, dx] = np.int16(np.clip(c, -32767, 32767))
    out = Path(tempfile.mktemp(suffix=".jpg"))
    try:
        jpeg_out = jpeglib.from_dct(Y.astype(np.int16), jpeg.Cb, jpeg.Cr, qt=jpeg.qt)
        jpeg_out.write_dct(str(out), quality=-1)
        return out.read_bytes()
    finally:
        out.unlink(missing_ok=True)


def decode_dct_sign(jpeg_bytes: bytes) -> bytes | None:
    """Extract from sign-based (positive=1, negative=0)."""
    with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as f:
        f.write(jpeg_bytes)
        path = Path(f.name)
    try:
        jpeg = jpeglib.read_dct(str(path))
        Y = np.array(jpeg.Y, dtype=np.int32)
        stream = _coeff_stream(Y)
        bits = [1 if int(Y[by, bx, _block_zigzag_index_to_2d(zi)[0], _block_zigzag_index_to_2d(zi)[1]]) > 0 else 0
                for by, bx, zi in stream]
        if len(bits) < 16:
            return None
        (codeword_len,) = struct.unpack(">H", _from_bits(bits[:16]))
        total_bits = (2 + codeword_len) * 8
        if len(bits) < total_bits:
            return None
        raw = _from_bits(bits[:total_bits])
        return _unwrap_payload(raw, use_rs=True, rs_nsym=32)
    finally:
        path.unlink(missing_ok=True)


def encode_dct_tcm(cover_path: str | Path, payload: bytes, quality: int = 85) -> bytes:
    """TCM-inspired: embed only in |c|>=2, first 16 AC, RS_NSYM=48."""
    cover_path = Path(cover_path)
    if cover_path.suffix.lower() in (".png", ".gif", ".bmp"):
        from PIL import Image
        img = Image.open(cover_path).convert("RGB")
        tmp = Path(tempfile.mktemp(suffix=".jpg"))
        img.save(tmp, "JPEG", quality=quality, subsampling=0)
        jpeg_path = tmp
    else:
        jpeg_path = cover_path
        tmp = None
    try:
        jpeg = jpeglib.read_dct(str(jpeg_path))
    finally:
        if tmp:
            tmp.unlink(missing_ok=True)
    Y = np.array(jpeg.Y, dtype=np.int32)
    raw = MAGIC + struct.pack(">I", len(payload)) + payload
    codeword = RSCodec(TCM_RS_NSYM).encode(raw)
    to_embed = struct.pack(">H", len(codeword)) + codeword
    bits = _to_bits(to_embed)
    stream = _coeff_stream_tcm(Y)
    if len(bits) > len(stream):
        raise ValueError(f"Payload too large: {len(bits)} bits, {len(stream)} stable coeffs")
    for i, bit in enumerate(bits):
        by, bx, zi = stream[i]
        dy, dx = ZIGZAG_2D[AC_INDICES[zi]]
        c = int(Y[by, bx, dy, dx])
        c_odd = c & 1
        if c_odd != bit:
            c = (c - 1) if c > 0 else (c + 1)
        Y[by, bx, dy, dx] = np.int16(np.clip(c, -32767, 32767))
    out = Path(tempfile.mktemp(suffix=".jpg"))
    try:
        jpeg_out = jpeglib.from_dct(Y.astype(np.int16), jpeg.Cb, jpeg.Cr, qt=jpeg.qt)
        jpeg_out.write_dct(str(out), quality=-1)
        return out.read_bytes()
    finally:
        out.unlink(missing_ok=True)


def decode_dct_tcm(jpeg_bytes: bytes) -> bytes | None:
    """Extract from TCM-inspired (same stream order as encode)."""
    with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as f:
        f.write(jpeg_bytes)
        path = Path(f.name)
    try:
        jpeg = jpeglib.read_dct(str(path))
        Y = np.array(jpeg.Y, dtype=np.int32)
        stream = _coeff_stream_tcm(Y)
        bits = []
        for by, bx, zi in stream:
            dy, dx = ZIGZAG_2D[AC_INDICES[zi]]
            bits.append(int(Y[by, bx, dy, dx]) & 1)
        if len(bits) < 16:
            return None
        (codeword_len,) = struct.unpack(">H", _from_bits(bits[:16]))
        total_bits = (2 + codeword_len) * 8
        if len(bits) < total_bits:
            return None
        raw = _from_bits(bits[:total_bits])
        codeword = raw[2 : 2 + codeword_len]
        decoded = RSCodec(TCM_RS_NSYM).decode(codeword)[0]
        if len(decoded) < MAGIC_LEN + LENGTH_BYTES or decoded[:MAGIC_LEN] != MAGIC:
            return None
        (plen,) = struct.unpack(">I", decoded[MAGIC_LEN : MAGIC_LEN + LENGTH_BYTES])
        return decoded[MAGIC_LEN + LENGTH_BYTES : MAGIC_LEN + LENGTH_BYTES + plen]
    finally:
        path.unlink(missing_ok=True)


def encode_dct_rs64(cover_path: str | Path, payload: bytes, quality: int = 85) -> bytes:
    """Same as base DCT but RS_NSYM=64 (double parity)."""
    return encode_dct(cover_path, payload, quality, use_rs=True, rs_nsym=RS64_NSYM)


def decode_dct_rs64(jpeg_bytes: bytes) -> bytes | None:
    """Decode with RS_NSYM=64."""
    return decode_dct(jpeg_bytes, use_rs=True, rs_nsym=RS64_NSYM)


def _qim_embed(x: float, bit: int, delta: int) -> int:
    """QIM embed: quantize x to one of two reconstruction levels for bit."""
    cell = round(x / delta) * delta
    offset = (-1) ** (bit + 1) * delta / 4.0
    return int(round(cell + offset))


def _qim_detect(z: float, delta: int) -> int:
    """QIM detect: return 0 or 1 based on nearest reconstruction level."""
    cell = round(z / delta) * delta
    r0 = cell - delta / 4.0
    r1 = cell + delta / 4.0
    if abs(z - r0) <= abs(z - r1):
        return 0
    return 1


def _qim_detect_with_margin(z: float, delta: int) -> tuple[int, float]:
    """Return bit and confidence margin between nearest reconstruction levels."""
    cell = round(z / delta) * delta
    r0 = cell - delta / 4.0
    r1 = cell + delta / 4.0
    d0 = abs(z - r0)
    d1 = abs(z - r1)
    bit = 0 if d0 <= d1 else 1
    margin = abs(d0 - d1)
    return bit, margin


def _repeat_bits(bits: list[int], repeat: int) -> list[int]:
    if repeat <= 1:
        return bits
    out: list[int] = []
    for bit in bits:
        out.extend([bit] * repeat)
    return out


def _majority_bits(bits: list[int], repeat: int) -> list[int]:
    if repeat <= 1:
        return bits
    usable = (len(bits) // repeat) * repeat
    out: list[int] = []
    for i in range(0, usable, repeat):
        chunk = bits[i : i + repeat]
        out.append(1 if sum(chunk) > (repeat // 2) else 0)
    return out


def encode_dct_qim(cover_path: str | Path, payload: bytes, quality: int = 0, platform: str = "") -> bytes:
    """QIM: Quantization Index Modulation with repetition + strong RS for WhatsApp.
    quality=0 uses QIM_EMBED_QUALITY default. platform selects pre-resize width.
    """
    cover_path = Path(cover_path)
    from PIL import Image
    embed_quality = quality if quality > 0 else QIM_EMBED_QUALITY
    max_width = QIM_PLATFORM_WIDTHS.get(platform, QIM_DEFAULT_WIDTH) if QIM_MAX_WIDTH <= 0 else QIM_MAX_WIDTH
    tmp = None
    if cover_path.suffix.lower() in (".png", ".gif", ".bmp", ".jpg", ".jpeg"):
        img = Image.open(cover_path).convert("RGB")
        if max_width > 0 and img.width > max_width:
            ratio = max_width / img.width
            new_h = max(1, round(img.height * ratio))
            img = img.resize((max_width, new_h), Image.Resampling.LANCZOS)
        tmp = Path(tempfile.mktemp(suffix=".jpg"))
        img.save(tmp, "JPEG", quality=embed_quality, subsampling=0)
        jpeg_path = tmp
    else:
        jpeg_path = cover_path
    try:
        jpeg = jpeglib.read_dct(str(jpeg_path))
    finally:
        if tmp:
            tmp.unlink(missing_ok=True)
    Y = np.array(jpeg.Y, dtype=np.int32)
    raw = MAGIC + struct.pack(">I", len(payload)) + payload
    codeword = RSCodec(QIM_RS_NSYM).encode(raw)
    to_embed = struct.pack(">H", len(codeword)) + codeword
    bits = _to_bits(to_embed)
    bits = _repeat_bits(bits, QIM_REPEAT)
    stream = _coeff_stream(Y)
    if len(bits) > len(stream):
        raise ValueError(f"Payload too large: {len(bits)} bits, {len(stream)} coeffs")
    delta = QIM_DELTA
    for i, bit in enumerate(bits):
        by, bx, zi = stream[i]
        dy, dx = _block_zigzag_index_to_2d(zi)
        c = float(Y[by, bx, dy, dx])
        y = _qim_embed(c, bit, delta)
        Y[by, bx, dy, dx] = np.int16(np.clip(y, -32767, 32767))
    out = Path(tempfile.mktemp(suffix=".jpg"))
    try:
        jpeg_out = jpeglib.from_dct(Y.astype(np.int16), jpeg.Cb, jpeg.Cr, qt=jpeg.qt)
        jpeg_out.write_dct(str(out), quality=-1)
        return out.read_bytes()
    finally:
        out.unlink(missing_ok=True)


def decode_dct_qim(jpeg_bytes: bytes) -> bytes | None:
    """Extract from QIM embedding (majority vote + strong RS)."""
    with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as f:
        f.write(jpeg_bytes)
        path = Path(f.name)
    try:
        jpeg = jpeglib.read_dct(str(path))
        Y = np.array(jpeg.Y, dtype=np.int32)
        stream = _coeff_stream(Y)
        delta = QIM_DELTA
        bits = []
        margins = []
        for by, bx, zi in stream:
            dy, dx = _block_zigzag_index_to_2d(zi)
            c = float(Y[by, bx, dy, dx])
            bit, margin = _qim_detect_with_margin(c, delta)
            bits.append(bit)
            margins.append(margin)
        bits = _majority_bits(bits, QIM_REPEAT)
        if QIM_REPEAT > 1:
            grouped = []
            for i in range(0, len(margins), QIM_REPEAT):
                chunk = margins[i : i + QIM_REPEAT]
                if len(chunk) == QIM_REPEAT:
                    grouped.append(sum(chunk) / QIM_REPEAT)
            margins = grouped
        if len(bits) < 16:
            return None
        (codeword_len,) = struct.unpack(">H", _from_bits(bits[:16]))
        total_bits = (2 + codeword_len) * 8
        if len(bits) < total_bits:
            return None
        raw = _from_bits(bits[:total_bits])
        codeword = raw[2 : 2 + codeword_len]
        # Mark low-confidence bytes as erasures for RS decoding
        erasures = []
        byte_margins = []
        for i in range(0, len(bits[:total_bits]) // 8):
            start = i * 8
            end = start + 8
            if end > len(margins):
                break
            byte_margins.append(min(margins[start:end]))
        for idx, m in enumerate(byte_margins[:codeword_len]):
            if m < QIM_ERASURE_MARGIN:
                erasures.append(idx)
        decoded = RSCodec(QIM_RS_NSYM).decode(codeword, erase_pos=erasures)[0]
        if len(decoded) < MAGIC_LEN + LENGTH_BYTES or decoded[:MAGIC_LEN] != MAGIC:
            return None
        (plen,) = struct.unpack(">I", decoded[MAGIC_LEN : MAGIC_LEN + LENGTH_BYTES])
        return decoded[MAGIC_LEN + LENGTH_BYTES : MAGIC_LEN + LENGTH_BYTES + plen]
    finally:
        path.unlink(missing_ok=True)

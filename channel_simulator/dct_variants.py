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
QIM_DELTA = 16  # Re-tuned after adding PSNR measurement to the validation (the original
                # 32 was chosen from bit-error-rate alone, without ever checking visual
                # impact -- it scored only ~26dB PSNR against the same-pipeline no-embed
                # baseline, which is genuinely visible, not just "technically imperfect").
                # 14 is the exact floor for full 45/45 robustness across all 9 cover types
                # x 5 platforms; 16 keeps a small margin above that floor at ~32dB PSNR,
                # a real improvement with no robustness cost. See sweep_delta.py for the
                # original BER-only sweep and the delta re-tune in git history/PR notes for
                # the PSNR-aware follow-up.
QIM_RS_NSYM = 128  # Stronger parity for harsh channels (WhatsApp)
QIM_REPEAT = 5  # Swept; 7 was tried and performed slightly worse in practice (more
                # votes drawn from farther/less-favorable permutation positions) --
                # 5 already gives a 100% pass rate on the three required platforms.
QIM_EMBED_QUALITY = 80

# Coefficient-domain (DCT position) embedding cannot survive an actual pixel
# resize: resampling recomputes every 8x8 block from scratch, decorrelating
# embedded coefficients almost completely (~50% BER, i.e. random). Guessing
# which platform an image will be sent through and pre-matching that width
# (the previous approach) fails whenever the guess is wrong, the image gets
# forwarded through a second platform, or the user doesn't know the
# destination. Instead: embed always pre-resizes the cover to a width safe
# for ALL platforms in the target profile, so every downstream resize step is
# a guaranteed no-op (PIL only shrinks, never grows, to fit max_width).
#
# "standard": safe for WhatsApp (800), Instagram (1080), Telegram (1280) --
#             the three platforms the spec requires surviving. Higher
#             resolution / quality output.
# "max":      also safe for Twitter/X-style aggressive downscaling (600).
#             Empirically 100% pass rate across every platform x cover-type
#             combination tested (see run_matrix_realistic.py), at the cost
#             of a smaller embedded image -- default for that reason; callers
#             who know their content only needs the three required platforms
#             and want higher output resolution can opt into "standard".
QIM_WIDTH_PRESETS = {
    "standard": 768,
    "max": 576,
}
QIM_DEFAULT_ROBUSTNESS = "max"
QIM_DEFAULT_WIDTH = QIM_WIDTH_PRESETS[QIM_DEFAULT_ROBUSTNESS]
QIM_ERASURE_MARGIN = QIM_DELTA / 6.0  # Mark low-confidence bytes as erasures


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


def _interleave_repeat(bits: list[int], repeat: int) -> list[int]:
    """Repeat the whole bit array `repeat` times as full consecutive passes
    (not per-bit) -- see _fixed_permutation for how these passes end up
    scattered across genuinely distant parts of the image rather than
    clustered in one region.
    """
    if repeat <= 1:
        return bits
    return bits * repeat


def _deinterleave_majority(bits: list[int], margins: list[float], repeat: int) -> tuple[list[int], list[float]]:
    """Inverse of _interleave_repeat: bits/margins is `repeat` concatenated
    passes of length n; vote per position across passes. Returns (voted_bits,
    per-position min-margin) both of length n.
    """
    if repeat <= 1:
        return bits, margins
    n = len(bits) // repeat
    out_bits: list[int] = []
    out_margins: list[float] = []
    for i in range(n):
        votes = [bits[i + p * n] for p in range(repeat)]
        vote_margins = [margins[i + p * n] for p in range(repeat)]
        out_bits.append(1 if sum(votes) > (repeat // 2) else 0)
        out_margins.append(min(vote_margins))
    return out_bits, out_margins


QIM_HEADER_BITS = 16  # codeword length prefix (uint16, up to 65535 bytes)
QIM_HEADER_REPEAT = 9  # extra margin: losing the header loses the whole payload
QIM_PERM_SEED = 20231115  # arbitrary, fixed forever: encoder and decoder must agree


def _fixed_permutation(total_positions: int) -> np.ndarray:
    """A single deterministic pseudorandom shuffle of every coefficient
    position in the image, seeded identically on encode and decode.

    This is what actually gives redundant copies of a bit spatially
    decorrelated locations: consecutive slices of a true random permutation
    are uniformly scattered across the WHOLE image regardless of how small
    the payload is relative to total capacity. (Two earlier approaches got
    this wrong: per-bit consecutive repetition puts all copies in the same
    8x8 block -- see debug_smooth.py -- and naive "concatenate N passes then
    slice" clusters every pass in the same corner of the image whenever
    payload << capacity, which is the common case.) Slicing this permutation
    for header vs. codeword use (in that fixed order) also guarantees the two
    never collide, with no bookkeeping required.
    """
    rng = np.random.RandomState(QIM_PERM_SEED)
    perm = np.arange(total_positions)
    rng.shuffle(perm)
    return perm


def encode_dct_qim(cover_path: str | Path, payload: bytes, quality: int = 0, robustness: str = QIM_DEFAULT_ROBUSTNESS) -> bytes:
    """QIM: Quantization Index Modulation with block-decorrelated interleaving + strong RS.

    quality=0 uses QIM_EMBED_QUALITY default. `robustness` selects the universal
    pre-resize width ("standard" = WhatsApp/Instagram/Telegram-safe, "max" = also
    Twitter/X-safe) -- see QIM_WIDTH_PRESETS for rationale. Never resize based on
    a guessed destination platform: the cover must be safe for every platform it
    might end up shared through, not just one.

    Redundancy is spread across spatially distant coefficients (see
    _interleave_repeat): repeating a bit in the SAME 8x8 block (the naive
    approach) gives zero protection, because a block that quantizes badly
    (e.g. a flat/low-AC-energy region) makes every repeat wrong in the same
    way -- majority voting over correlated failures doesn't help.
    """
    cover_path = Path(cover_path)
    from PIL import Image
    embed_quality = quality if quality > 0 else QIM_EMBED_QUALITY
    max_width = QIM_WIDTH_PRESETS.get(robustness, QIM_DEFAULT_WIDTH)
    tmp = None
    if cover_path.suffix.lower() in (".png", ".gif", ".bmp", ".jpg", ".jpeg"):
        img = Image.open(cover_path).convert("RGB")
        long_side = max(img.width, img.height)
        if max_width > 0 and long_side > max_width:
            # Constrain by the LONGER side, matching real platforms (see
            # channel.py's _resize_to_max_dim) -- a narrow-but-tall cover
            # (e.g. a cropped screenshot) would otherwise sail through this
            # pre-resize unshrunk just because its width alone looked safe,
            # then get resized for real once a platform touches it, which is
            # exactly the failure mode this pre-resize exists to prevent.
            ratio = max_width / long_side
            new_w = max(1, round(img.width * ratio))
            new_h = max(1, round(img.height * ratio))
            img = img.resize((new_w, new_h), Image.Resampling.LANCZOS)
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
    codeword_bits = _to_bits(codeword)
    header_bits = _to_bits(struct.pack(">H", len(codeword)))

    stream = _coeff_stream(Y)
    perm = _fixed_permutation(len(stream))

    interleaved_header = _interleave_repeat(header_bits, QIM_HEADER_REPEAT)
    interleaved_codeword = _interleave_repeat(codeword_bits, QIM_REPEAT)
    needed = len(interleaved_header) + len(interleaved_codeword)
    if needed > len(perm):
        raise ValueError(
            f"Payload too large: need {needed} coeffs (header+codeword x redundancy), "
            f"have {len(perm)} available"
        )
    header_positions = perm[: len(interleaved_header)]
    codeword_positions = perm[len(interleaved_header) : needed]

    delta = QIM_DELTA

    def _write_bit(stream_pos: int, bit: int) -> None:
        by, bx, zi = stream[stream_pos]
        dy, dx = _block_zigzag_index_to_2d(zi)
        c = float(Y[by, bx, dy, dx])
        Y[by, bx, dy, dx] = np.int16(np.clip(_qim_embed(c, bit, delta), -32767, 32767))

    for pos, bit in zip(header_positions, interleaved_header):
        _write_bit(int(pos), bit)
    for pos, bit in zip(codeword_positions, interleaved_codeword):
        _write_bit(int(pos), bit)

    out = Path(tempfile.mktemp(suffix=".jpg"))
    try:
        jpeg_out = jpeglib.from_dct(Y.astype(np.int16), jpeg.Cb, jpeg.Cr, qt=jpeg.qt)
        jpeg_out.write_dct(str(out), quality=-1)
        return out.read_bytes()
    finally:
        out.unlink(missing_ok=True)


def decode_dct_qim(jpeg_bytes: bytes) -> bytes | None:
    """Extract from QIM embedding (interleaved majority vote + strong RS)."""
    with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as f:
        f.write(jpeg_bytes)
        path = Path(f.name)
    try:
        jpeg = jpeglib.read_dct(str(path))
        Y = np.array(jpeg.Y, dtype=np.int32)
        stream = _coeff_stream(Y)
        delta = QIM_DELTA

        def _read_bit(stream_pos: int) -> tuple[int, float]:
            by, bx, zi = stream[stream_pos]
            dy, dx = _block_zigzag_index_to_2d(zi)
            c = float(Y[by, bx, dy, dx])
            return _qim_detect_with_margin(c, delta)

        perm = _fixed_permutation(len(stream))
        n_header_slots = QIM_HEADER_BITS * QIM_HEADER_REPEAT
        if n_header_slots > len(perm):
            return None
        header_positions = perm[:n_header_slots]

        header_bits_raw = []
        header_margins_raw = []
        for pos in header_positions:
            bit, margin = _read_bit(int(pos))
            header_bits_raw.append(bit)
            header_margins_raw.append(margin)
        header_bits, _ = _deinterleave_majority(
            header_bits_raw, header_margins_raw, QIM_HEADER_REPEAT
        )
        if len(header_bits) < QIM_HEADER_BITS:
            return None
        (codeword_len,) = struct.unpack(">H", _from_bits(header_bits[:QIM_HEADER_BITS]))
        n_codeword_bits = codeword_len * 8
        needed = n_header_slots + n_codeword_bits * QIM_REPEAT
        if codeword_len == 0 or needed > len(perm):
            return None
        codeword_positions = perm[n_header_slots:needed]

        codeword_bits_raw = []
        codeword_margins_raw = []
        for pos in codeword_positions:
            bit, margin = _read_bit(pos)
            codeword_bits_raw.append(bit)
            codeword_margins_raw.append(margin)
        codeword_bits, bit_margins = _deinterleave_majority(
            codeword_bits_raw, codeword_margins_raw, QIM_REPEAT
        )
        codeword = _from_bits(codeword_bits)

        # Mark low-confidence bytes as erasures for RS decoding
        erasures = []
        for idx in range(codeword_len):
            start = idx * 8
            end = start + 8
            if end > len(bit_margins):
                break
            if min(bit_margins[start:end]) < QIM_ERASURE_MARGIN:
                erasures.append(idx)
        decoded = None
        try:
            decoded = RSCodec(QIM_RS_NSYM).decode(codeword, erase_pos=erasures)[0]
        except Exception:
            # Erasure marking is a heuristic (bytes near a QIM decision boundary)
            # and can over-trigger on content with large low-AC-energy regions
            # (flat colors, screenshots): most declared erasures may not
            # actually be wrong, and declaring more than the RS codeword can
            # correct fails outright even though the real bit-error rate is
            # low enough for plain blind correction to succeed. Retry without
            # erasure hints rather than giving up.
            try:
                decoded = RSCodec(QIM_RS_NSYM).decode(codeword, erase_pos=[])[0]
            except Exception:
                return None
        if decoded is None:
            return None
        if len(decoded) < MAGIC_LEN + LENGTH_BYTES or decoded[:MAGIC_LEN] != MAGIC:
            return None
        (plen,) = struct.unpack(">I", decoded[MAGIC_LEN : MAGIC_LEN + LENGTH_BYTES])
        return decoded[MAGIC_LEN + LENGTH_BYTES : MAGIC_LEN + LENGTH_BYTES + plen]
    finally:
        path.unlink(missing_ok=True)

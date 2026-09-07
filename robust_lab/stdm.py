"""
Resize-invariant steganography: Spread-Transform Dither Modulation (STDM)
in a canonically-normalised DCT domain.

Why the current scheme dies
---------------------------
`src/stego-qim.ts` embeds in the 8x8 DCT blocks of the image *at whatever
resolution it happens to be*. The moment a platform rescales the image, the
receiver's 8x8 grid no longer lines up with the sender's, every coefficient is
a blend of neighbours, and the payload is gone. Measured: a 1608 -> 1600 px
resize — a 0.5% change — destroys 100% of payloads. The upstream workaround is
to pre-resize the cover to the platform's exact cap so no resize happens, which
fails as soon as the user picks the wrong platform or the platform changes its
cap.

The fix
-------
Never embed in the delivered resolution. Both sender and receiver first
normalise the luma plane to a fixed canonical square (default 512x512). A
uniform rescale by the platform is then undone by the receiver's own
normalisation, so the embedding grid is reproducible no matter what size the
image arrives at.

Inside that canonical frame we use STDM rather than plain QIM:

  * Each payload bit owns a pseudorandom set of L mid-frequency DCT
    coefficients and a +/-1 chip pattern (both derived from a key).
  * The bit is carried by the *projection* of those coefficients onto the chip
    vector, which is quantised with a dither lattice.
  * Because the bit lives in a projection rather than in individual
    coefficients, host interference cancels exactly, and the per-coefficient
    change is 1/sqrt(L) of the quantisation step — invisible, yet the
    projection is L times more resistant to noise than any single coefficient.

Band selection matters: only coefficients between `R_LO` and `R_HI` of Nyquist
are used. Below that lies the image's own energy (visible artefacts); above it
is exactly what downscaling and JPEG quantisation throw away.
"""

from __future__ import annotations

import io
import zlib
from dataclasses import dataclass

import numpy as np
from PIL import Image
from scipy.fft import dctn, idctn

from reedsolo import RSCodec, ReedSolomonError

MAGIC = b"SGX1"

# ---------------------------------------------------------------------------
# Parameters
# ---------------------------------------------------------------------------


@dataclass(frozen=True)
class Params:
    """A robustness/capacity operating point."""

    #: Canonical square edge the luma plane is normalised to, at both ends.
    canonical: int = 512
    #: Chips (coefficients) per payload bit. More chips = more robust, fewer bits.
    chips: int = 72
    #: Dither-modulation step, in canonical DCT units.
    delta: float = 26.0
    #: Usable band, as a fraction of the canonical Nyquist radius.
    #: Measured by probe_band.py: below ~0.08 the change is visible and the
    #: image's own energy dominates; above ~0.45 platform downscaling and JPEG
    #: quantisation start eating the carrier (Instagram first, at ~0.39).
    r_lo: float = 0.08
    r_hi: float = 0.42
    #: Reed-Solomon parity symbols.
    rs_nsym: int = 32
    #: JPEG quality used when writing the stego image.
    quality: int = 92

    @property
    def key_seed(self) -> int:
        return 0x57E65712


#: Maximum robustness. Carries a locator (32-byte event id + 16-byte key), not
#: the message itself — the message is fetched over the network. This is the
#: mode that has to survive WhatsApp.
LOCATOR = Params(canonical=512, chips=50, delta=28.0, r_hi=0.40, rs_nsym=24)

#: Balanced: a short message travels entirely inside the image.
STANDARD = Params(canonical=512, chips=25, delta=26.0, r_hi=0.45, rs_nsym=32)

#: Large payload for gentle channels (Telegram "send as file", email, disk).
BULK = Params(canonical=768, chips=12, delta=22.0, r_hi=0.55, rs_nsym=48)

MODES = {"locator": LOCATOR, "standard": STANDARD, "bulk": BULK}


# ---------------------------------------------------------------------------
# Canonical domain
# ---------------------------------------------------------------------------

_RGB_TO_Y = np.array([0.299, 0.587, 0.114])


def _load_rgb(image) -> np.ndarray:
    if isinstance(image, Image.Image):
        img = image.convert("RGB")
    elif isinstance(image, (bytes, bytearray)):
        img = Image.open(io.BytesIO(bytes(image))).convert("RGB")
    else:
        img = Image.open(image).convert("RGB")
    return np.asarray(img, dtype=np.float64)


def _luma(rgb: np.ndarray) -> np.ndarray:
    return rgb @ _RGB_TO_Y


def _to_canonical(plane: np.ndarray, size: int) -> np.ndarray:
    """Resample a plane onto the canonical square, ignoring aspect ratio.

    Ignoring aspect ratio is deliberate: it makes the mapping depend only on
    the image's *content extent*, so any uniform rescale by a platform is
    undone exactly.
    """
    img = Image.fromarray(plane.astype(np.float32), mode="F")
    return np.asarray(img.resize((size, size), Image.BICUBIC), dtype=np.float64)


def _from_canonical(plane: np.ndarray, width: int, height: int) -> np.ndarray:
    img = Image.fromarray(plane.astype(np.float32), mode="F")
    return np.asarray(img.resize((width, height), Image.BICUBIC), dtype=np.float64)


# ---------------------------------------------------------------------------
# Carrier construction
# ---------------------------------------------------------------------------


def _band_indices(p: Params) -> np.ndarray:
    """Flat indices of the mid-frequency DCT coefficients we are allowed to use."""
    n = p.canonical
    u = np.arange(n)[:, None]
    v = np.arange(n)[None, :]
    r = np.sqrt((u / n) ** 2 + (v / n) ** 2)
    mask = (r >= p.r_lo) & (r <= p.r_hi)
    return np.flatnonzero(mask.reshape(-1))


def _carriers(p: Params, nbits: int) -> tuple[np.ndarray, np.ndarray]:
    """Assign each bit a disjoint chip set and a +/-1 pattern.

    Returns (positions[nbits, chips], signs[nbits, chips]).
    """
    band = _band_indices(p)
    rng = np.random.default_rng(p.key_seed)
    order = rng.permutation(band.size)
    need = nbits * p.chips
    if need > band.size:
        raise ValueError(
            f"capacity exceeded: {nbits} bits x {p.chips} chips = {need} "
            f"coefficients needed, band has {band.size}"
        )
    picks = band[order[:need]].reshape(nbits, p.chips)
    signs = rng.choice(np.array([-1.0, 1.0]), size=(nbits, p.chips))
    return picks, signs


def capacity_bits(p: Params) -> int:
    return int(_band_indices(p).size // p.chips)


def capacity_bytes(p: Params) -> int:
    """Payload bytes available after framing and parity."""
    raw = capacity_bits(p) // 8
    return max(0, raw - p.rs_nsym - len(MAGIC) - 2)


# ---------------------------------------------------------------------------
# Framing
# ---------------------------------------------------------------------------


#: MAGIC + compression flag + 2-byte body length.
_HEADER = len(MAGIC) + 1 + 2


def frame_bytes(p: Params) -> int:
    """Total codeword size for a mode. Fixed, so the detector knows the length."""
    return capacity_bits(p) // 8


def payload_bytes(p: Params) -> int:
    """Usable payload bytes for a mode."""
    return max(0, frame_bytes(p) - p.rs_nsym - _HEADER)


def _frame(payload: bytes, p: Params) -> bytes:
    """Pack payload into a fixed-size RS codeword.

    The frame is a constant size per mode. That costs a little capacity but
    means the detector never has to guess a length — it reads exactly
    `frame_bytes(p)` symbols and hands them to Reed-Solomon, which is both
    faster and far more reliable than trial-decoding every candidate length.
    """
    body = zlib.compress(payload, 9)
    flag = 1
    if len(body) >= len(payload):
        body, flag = payload, 0  # compression did not help

    room = payload_bytes(p)
    if len(body) > room:
        raise ValueError(
            f"payload too large for mode: {len(body)} bytes after compression, "
            f"room for {room}"
        )

    head = MAGIC + bytes([flag]) + len(body).to_bytes(2, "big")
    message = head + body + bytes(room - len(body))
    return bytes(RSCodec(p.rs_nsym).encode(message))


def _unframe(data: bytes, p: Params) -> bytes | None:
    try:
        decoded = bytes(RSCodec(p.rs_nsym).decode(data)[0])
    except (ReedSolomonError, ValueError):
        return None
    if not decoded.startswith(MAGIC):
        return None
    flag = decoded[len(MAGIC)]
    length = int.from_bytes(decoded[len(MAGIC) + 1:len(MAGIC) + 3], "big")
    body = decoded[_HEADER:_HEADER + length]
    if len(body) != length:
        return None
    if flag == 1:
        try:
            return zlib.decompress(body)
        except zlib.error:
            return None
    return body


# ---------------------------------------------------------------------------
# Embed / detect
# ---------------------------------------------------------------------------


def _dither(p: Params, nbits: int) -> np.ndarray:
    """Per-bit dither offset, so the lattice is not aligned across bits."""
    rng = np.random.default_rng(p.key_seed ^ 0x9E3779B9)
    return rng.uniform(0, p.delta, size=nbits)


def embed(image, payload: bytes, p: Params = LOCATOR) -> bytes:
    """Embed `payload` and return JPEG bytes."""
    codeword = _frame(payload, p)
    bits = np.unpackbits(np.frombuffer(codeword, dtype=np.uint8)).astype(np.float64)
    nbits = bits.size

    rgb = _load_rgb(image)
    height, width = rgb.shape[:2]
    y = _luma(rgb)

    canon = _to_canonical(y, p.canonical)
    coeffs = dctn(canon, norm="ortho")
    flat = coeffs.reshape(-1)

    picks, signs = _carriers(p, nbits)
    dither = _dither(p, nbits)
    inv_norm = 1.0 / np.sqrt(p.chips)

    # Projection of the host onto each bit's chip direction.
    host = (flat[picks] * signs).sum(axis=1) * inv_norm

    # Dither modulation: quantise the projection to the lattice for this bit.
    # Even lattice carries 0, odd lattice carries 1.
    step = p.delta
    shifted = host - dither
    k = np.round(shifted / step)
    parity_now = np.mod(k, 2)
    k = np.where(parity_now == bits, k, k + 1.0)
    target = k * step + dither

    correction = (target - host) * inv_norm
    np.add.at(flat, picks, correction[:, None] * signs)

    stego_canon = idctn(flat.reshape(p.canonical, p.canonical), norm="ortho")
    delta_plane = _from_canonical(stego_canon - canon, width, height)

    out = np.clip(rgb + delta_plane[:, :, None], 0, 255)
    buf = io.BytesIO()
    Image.fromarray(out.astype(np.uint8), "RGB").save(
        buf, format="JPEG", quality=p.quality, subsampling=0
    )
    return buf.getvalue()


#: Symmetric insets, as a fraction of each edge, tried when the first read
#: fails. Platforms that trim a few pixels to hit an allowed aspect ratio
#: (Instagram is the main offender) shift the content extent, which moves the
#: canonical grid; re-expanding by a candidate inset puts it back.
#:
#: Only small insets are listed, and deliberately so. The re-expansion pads
#: with replicated edge pixels, which approximates the missing border well
#: while it is thin but injects low-frequency error straight into the carrier
#: band once it is not. Measured: 2% per edge recovers, 5% does not. Larger
#: crops need a synchronisation template rather than a guess — see the
#: limitations section of RESULTS.md.
_CROP_HYPOTHESES: tuple[float, ...] = (0.0, 0.005, 0.012, 0.022, 0.035)


def _read_frame(y: np.ndarray, p: Params, picks, signs, dither) -> bytes:
    canon = _to_canonical(y, p.canonical)
    flat = dctn(canon, norm="ortho").reshape(-1)
    proj = (flat[picks] * signs).sum(axis=1) * (1.0 / np.sqrt(p.chips))
    bits = np.mod(np.round((proj - dither) / p.delta), 2).astype(np.uint8)
    return np.packbits(bits).tobytes()


def detect(image, p: Params = LOCATOR) -> bytes | None:
    """Recover the payload from an image of any size, or None.

    The image may have been rescaled by any factor — normalisation handles
    that. If it was also cropped, the first read fails and we retry against a
    few candidate insets; Reed-Solomon's own integrity check tells us which
    hypothesis was right, so a wrong guess simply fails and costs one DCT.
    """
    try:
        rgb = _load_rgb(image)
    except Exception:  # noqa: BLE001
        return None

    y = _luma(rgb)
    height, width = y.shape[:2]

    nbits = frame_bytes(p) * 8
    picks, signs = _carriers(p, nbits)
    dither = _dither(p, nbits)

    for inset in _CROP_HYPOTHESES:
        if inset == 0.0:
            view = y
        else:
            dx, dy = int(round(width * inset)), int(round(height * inset))
            if width - 2 * dx < 32 or height - 2 * dy < 32:
                continue
            # The sender's frame was larger than what arrived, so pad the
            # received content back out to the extent it was embedded in.
            view = np.pad(y, ((dy, dy), (dx, dx)), mode="edge")

        out = _unframe(_read_frame(view, p, picks, signs, dither), p)
        if out is not None:
            return out

    return None

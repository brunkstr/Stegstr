"""
Realistic social-platform channel models.

The upstream `channel_simulator/channel.py` models each platform as a single
"resize to width W, JPEG at quality Q" step. Real platforms are harsher:

  * they resize on the LONG edge, not the width, so portrait images are hit
    differently than landscape ones;
  * the output dimension is almost never a multiple of 8, so the receiver's
    8x8 DCT grid does not line up with the sender's;
  * quality is adaptive, not fixed, and is applied on top of an already-lossy
    input (double compression);
  * several platforms sharpen after downscaling;
  * some clients re-encode a second time on the receiving end.

Each profile below therefore has a *range* of behaviours, and `simulate()`
samples from it. `simulate_worst()` picks the harshest corner so a scheme can
be tested against the bad case rather than the lucky one.
"""

from __future__ import annotations

import io
import random
from dataclasses import dataclass, field

import numpy as np
from PIL import Image, ImageFilter


@dataclass(frozen=True)
class Profile:
    """One platform's image-processing behaviour."""

    name: str
    #: Max long-edge in pixels; the image is downscaled to fit. 0 = never resize.
    long_edge: int
    #: JPEG quality range the platform re-encodes with.
    quality: tuple[int, int]
    #: Chroma subsampling: 0 = 4:4:4, 2 = 4:2:0.
    subsampling: int = 2
    #: Unsharp-mask strength applied after downscale (0 = none).
    sharpen: float = 0.0
    #: Number of independent JPEG re-encodes (>1 models client + server passes).
    passes: int = 1
    #: Resampling filters the platform may use.
    filters: tuple[int, ...] = field(default=(Image.LANCZOS, Image.BICUBIC))
    #: Pixels that may be cropped off each edge (models aspect-ratio cropping).
    crop: int = 0


PROFILES: dict[str, Profile] = {
    # WhatsApp "standard quality": the harshest mainstream channel.
    "whatsapp": Profile(
        name="whatsapp",
        long_edge=1600,
        quality=(60, 75),
        subsampling=2,
        sharpen=0.0,
        passes=1,
    ),
    # WhatsApp "HD quality" toggle: larger cap, gentler quantisation.
    "whatsapp_hd": Profile(
        name="whatsapp_hd",
        long_edge=3000,
        quality=(75, 85),
        subsampling=2,
    ),
    # Telegram "compress image" (the default when sending from the gallery).
    "telegram": Profile(
        name="telegram",
        long_edge=1280,
        quality=(78, 89),
        subsampling=2,
    ),
    # Telegram "send as file" — lossless passthrough, the easy case.
    "telegram_file": Profile(
        name="telegram_file",
        long_edge=0,
        quality=(100, 100),
        subsampling=0,
    ),
    # Instagram feed: fixed 1080 width, sharpening, occasional edge crop.
    "instagram": Profile(
        name="instagram",
        long_edge=1080,
        quality=(72, 88),
        subsampling=2,
        sharpen=0.6,
        crop=4,
    ),
    # Facebook / Messenger.
    "facebook": Profile(
        name="facebook",
        long_edge=2048,
        quality=(70, 85),
        subsampling=2,
        sharpen=0.3,
    ),
    # X / Twitter.
    "twitter": Profile(
        name="twitter",
        long_edge=1600,
        quality=(75, 85),
        subsampling=2,
    ),
    # Worst realistic case: forwarded through two apps in a row.
    "whatsapp_twice": Profile(
        name="whatsapp_twice",
        long_edge=1600,
        quality=(60, 72),
        subsampling=2,
        passes=2,
    ),
}


def _to_pil(image) -> Image.Image:
    """Accept a path, raw bytes, or a PIL image and return RGB PIL."""
    if isinstance(image, Image.Image):
        return image.convert("RGB")
    if isinstance(image, (bytes, bytearray)):
        return Image.open(io.BytesIO(bytes(image))).convert("RGB")
    return Image.open(image).convert("RGB")


def _jpeg_roundtrip(img: Image.Image, quality: int, subsampling: int) -> Image.Image:
    buf = io.BytesIO()
    img.save(buf, format="JPEG", quality=quality, subsampling=subsampling, optimize=False)
    buf.seek(0)
    return Image.open(buf).convert("RGB")


def _apply(
    img: Image.Image,
    profile: Profile,
    quality: int,
    resample: int,
    crop_px: int,
) -> Image.Image:
    if crop_px > 0 and img.width > 2 * crop_px and img.height > 2 * crop_px:
        img = img.crop((crop_px, crop_px, img.width - crop_px, img.height - crop_px))

    if profile.long_edge > 0 and max(img.width, img.height) > profile.long_edge:
        scale = profile.long_edge / max(img.width, img.height)
        # Real platforms round to whole pixels; the result is rarely /8.
        new_w = max(1, int(round(img.width * scale)))
        new_h = max(1, int(round(img.height * scale)))
        img = img.resize((new_w, new_h), resample)

    if profile.sharpen > 0:
        img = img.filter(
            ImageFilter.UnsharpMask(radius=1.0, percent=int(profile.sharpen * 100), threshold=3)
        )

    for _ in range(profile.passes):
        img = _jpeg_roundtrip(img, quality, profile.subsampling)

    return img


def simulate(
    image,
    profile_name: str,
    output_path=None,
    rng: random.Random | None = None,
) -> bytes:
    """Push an image through one platform, sampling that platform's variability."""
    profile = PROFILES[profile_name]
    rng = rng or random.Random()

    quality = rng.randint(*profile.quality)
    resample = rng.choice(profile.filters)
    crop_px = rng.randint(0, profile.crop) if profile.crop else 0

    out = _apply(_to_pil(image), profile, quality, resample, crop_px)

    buf = io.BytesIO()
    out.save(buf, format="JPEG", quality=95, subsampling=profile.subsampling)
    data = buf.getvalue()
    if output_path is not None:
        with open(output_path, "wb") as fh:
            fh.write(data)
    return data


def simulate_worst(image, profile_name: str, output_path=None) -> bytes:
    """Harshest corner of a platform's behaviour: lowest quality, most crop."""
    profile = PROFILES[profile_name]
    out = _apply(
        _to_pil(image),
        profile,
        quality=profile.quality[0],
        resample=Image.BICUBIC,
        crop_px=profile.crop,
    )
    buf = io.BytesIO()
    out.save(buf, format="JPEG", quality=95, subsampling=profile.subsampling)
    data = buf.getvalue()
    if output_path is not None:
        with open(output_path, "wb") as fh:
            fh.write(data)
    return data


def psnr(a: Image.Image | str, b: Image.Image | str) -> float:
    """Peak signal-to-noise ratio between two images, for invisibility checks."""
    ia = np.asarray(_to_pil(a), dtype=np.float64)
    ib = np.asarray(_to_pil(b), dtype=np.float64)
    if ia.shape != ib.shape:
        pb = _to_pil(b).resize((_to_pil(a).width, _to_pil(a).height), Image.LANCZOS)
        ib = np.asarray(pb, dtype=np.float64)
    mse = float(np.mean((ia - ib) ** 2))
    if mse == 0:
        return float("inf")
    return 10.0 * float(np.log10(255.0 * 255.0 / mse))

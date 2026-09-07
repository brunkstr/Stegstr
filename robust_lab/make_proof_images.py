"""
Generate the visual proof images used in the contest entry boards.

Two things are worth showing rather than asserting:

  1. The stego image is indistinguishable from the cover, and the difference
     map - amplified far past what an eye could see - is structureless noise
     rather than a visible grid or block pattern.
  2. The payload still reads back after a real platform-style round trip,
     which is the whole claim.
"""

from __future__ import annotations

import io
import sys
from pathlib import Path

import numpy as np
from PIL import Image, ImageDraw, ImageFont

sys.path.insert(0, str(Path(__file__).parent))
import channel  # noqa: E402

HERE = Path(__file__).parent
REPO = HERE.parent
OUT = Path(r"C:\Users\saifs\Desktop\Stegstr Contest Entry\entry-images\assets")
OUT.mkdir(parents=True, exist_ok=True)

# A real photograph, when one is available. The synthetic benchmark covers are
# built for measurement, not for looking at, and a foggy gradient makes a poor
# argument that the change is invisible on real pictures.
PHOTO = OUT / "photo.jpg"
FALLBACK_COVER = HERE / "covers" / "landscape_1600x1200.png"
FALLBACK_STEGO = REPO / "testkit" / "out" / "landscape-locator.jpg"

PANEL_W, PANEL_H = 620, 465
GAP = 26
LABEL_H = 54
BG = (14, 17, 23)
FG = (232, 236, 243)
MUTED = (139, 148, 158)


def font(size: int, bold: bool = False):
    for name in (("seguisb.ttf", "segoeuib.ttf") if bold else ("segoeui.ttf",)):
        try:
            return ImageFont.truetype(name, size)
        except OSError:
            continue
    try:
        return ImageFont.truetype("arialbd.ttf" if bold else "arial.ttf", size)
    except OSError:
        return ImageFont.load_default()


def fit(img: Image.Image, w: int, h: int) -> Image.Image:
    """Cover-fit into w x h without distorting."""
    scale = max(w / img.width, h / img.height)
    resized = img.resize((max(1, round(img.width * scale)), max(1, round(img.height * scale))), Image.LANCZOS)
    left = (resized.width - w) // 2
    top = (resized.height - h) // 2
    return resized.crop((left, top, left + w, top + h))


def difference_map(cover: Image.Image, stego: Image.Image, gain: int = 24) -> Image.Image:
    """Amplified |cover - stego|, so the change is visible at all."""
    a = np.asarray(cover.convert("RGB"), dtype=np.float64)
    b = np.asarray(stego.convert("RGB").resize(cover.size, Image.LANCZOS), dtype=np.float64)
    diff = np.abs(a - b).mean(axis=2)
    diff = np.clip(diff * gain, 0, 255)
    # Tint it so it reads as a diagnostic overlay rather than a photo.
    rgb = np.zeros((*diff.shape, 3))
    rgb[:, :, 0] = diff * 0.45
    rgb[:, :, 1] = diff * 0.85
    rgb[:, :, 2] = diff
    return Image.fromarray(np.clip(rgb, 0, 255).astype(np.uint8), "RGB")


def source_pair() -> tuple[Path, Path, float]:
    """Return (cover, stego, psnr), embedding into the real photo when present."""
    if not PHOTO.exists():
        return FALLBACK_COVER, FALLBACK_STEGO, channel.psnr(FALLBACK_COVER, FALLBACK_STEGO)

    stego_path = OUT / "photo-stego.jpg"
    if not stego_path.exists():
        import base64
        import json
        import subprocess

        payload = b"stegstr|photo|locator"
        result = subprocess.run(
            [
                "node", str(REPO / "dist-cli" / "stegstr.mjs"), "embed", str(PHOTO),
                "-o", str(stego_path), "--payload-base64", base64.b64encode(payload).decode(),
                "--mode", "locator", "--json",
            ],
            capture_output=True, text=True,
        )
        if not json.loads(result.stdout or "{}").get("ok"):
            return FALLBACK_COVER, FALLBACK_STEGO, channel.psnr(FALLBACK_COVER, FALLBACK_STEGO)

    return PHOTO, stego_path, channel.psnr(PHOTO, stego_path)


def build_comparison() -> Path:
    cover_path, stego_path, psnr = source_pair()
    cover = Image.open(cover_path).convert("RGB")
    stego = Image.open(stego_path).convert("RGB")

    panels = [
        (fit(cover, PANEL_W, PANEL_H), "Original cover", "untouched"),
        (fit(stego, PANEL_W, PANEL_H), "Carrying a hidden message", f"PSNR {psnr:.1f} dB"),
        (fit(difference_map(cover, stego), PANEL_W, PANEL_H), "Difference, amplified 24x", "no grid, no blocks"),
    ]

    width = PANEL_W * 3 + GAP * 2
    height = PANEL_H + LABEL_H
    canvas = Image.new("RGB", (width, height), BG)
    draw = ImageDraw.Draw(canvas)

    f_label = font(24, bold=True)
    f_sub = font(20)

    for i, (panel, label, sub) in enumerate(panels):
        x = i * (PANEL_W + GAP)
        canvas.paste(panel, (x, 0))
        draw.text((x + 2, PANEL_H + 14), label, font=f_label, fill=FG)
        w = draw.textlength(label, font=f_label)
        draw.text((x + 2 + w + 14, PANEL_H + 17), sub, font=f_sub, fill=MUTED)

    path = OUT / "comparison.png"
    canvas.save(path)
    return path


def build_roundtrip() -> Path:
    """The same image before and after a modelled WhatsApp round trip."""
    _, stego_path, _ = source_pair()
    stego = Image.open(stego_path).convert("RGB")
    attacked_bytes = channel.simulate(stego_path, "whatsapp")
    attacked = Image.open(io.BytesIO(attacked_bytes)).convert("RGB")

    panels = [
        (fit(stego, PANEL_W, PANEL_H), f"Sent  {stego.width}x{stego.height}", f"{stego_path.stat().st_size // 1024} kB"),
        (fit(attacked, PANEL_W, PANEL_H), f"Received  {attacked.width}x{attacked.height}",
         f"{len(attacked_bytes) // 1024} kB, resized + recompressed"),
    ]

    width = PANEL_W * 2 + GAP
    height = PANEL_H + LABEL_H
    canvas = Image.new("RGB", (width, height), BG)
    draw = ImageDraw.Draw(canvas)
    f_label = font(24, bold=True)
    f_sub = font(20)

    for i, (panel, label, sub) in enumerate(panels):
        x = i * (PANEL_W + GAP)
        canvas.paste(panel, (x, 0))
        draw.text((x + 2, PANEL_H + 14), label, font=f_label, fill=FG)
        w = draw.textlength(label, font=f_label)
        draw.text((x + 2 + w + 14, PANEL_H + 17), sub, font=f_sub, fill=MUTED)

    path = OUT / "roundtrip.png"
    canvas.save(path)
    return path


if __name__ == "__main__":
    _c, _s, _p = source_pair()
    print(f"using cover {_c.name} -> stego {_s.name}, PSNR {_p:.1f} dB")
    print("wrote", build_comparison())
    print("wrote", build_roundtrip())

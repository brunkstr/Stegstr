"""Sweep QIM_DELTA to find a value with near-zero BER across required platforms."""
from __future__ import annotations
import struct, sys, tempfile
from pathlib import Path
import numpy as np
import jpeglib

sys.path.insert(0, str(Path(__file__).resolve().parent))
from channel import simulate
from dct_variants import _qim_embed, _qim_detect, _coeff_stream, _block_zigzag_index_to_2d
from dct_stego import MAGIC, _to_bits
import struct as st

COVERS_DIR = Path(__file__).resolve().parent / "covers"
REQUIRED = ["whatsapp", "instagram", "telegram"]
SAFE_WIDTH = 768  # <= min(800 whatsapp, 1080 instagram, 1280 telegram)
EMBED_QUALITY = 80
PAYLOAD = b"x" * 50

def encode(cover_path, payload, delta):
    from PIL import Image
    img = Image.open(cover_path).convert("RGB")
    if img.width > SAFE_WIDTH:
        r = SAFE_WIDTH / img.width
        img = img.resize((SAFE_WIDTH, max(1, round(img.height*r))), Image.Resampling.LANCZOS)
    tmp = Path(tempfile.mktemp(suffix=".jpg"))
    img.save(tmp, "JPEG", quality=EMBED_QUALITY, subsampling=0)
    jpeg = jpeglib.read_dct(str(tmp)); tmp.unlink(missing_ok=True)
    Y = np.array(jpeg.Y, dtype=np.int32)
    raw = MAGIC + st.pack(">I", len(payload)) + payload
    bits = _to_bits(raw)
    stream = _coeff_stream(Y)
    bits = bits[:min(len(bits), len(stream))]
    for i, bit in enumerate(bits):
        by, bx, zi = stream[i]
        dy, dx = _block_zigzag_index_to_2d(zi)
        c = float(Y[by, bx, dy, dx])
        Y[by, bx, dy, dx] = np.int16(np.clip(_qim_embed(c, bit, delta), -32767, 32767))
    out = Path(tempfile.mktemp(suffix=".jpg"))
    jpeg_out = jpeglib.from_dct(Y.astype(np.int16), jpeg.Cb, jpeg.Cr, qt=jpeg.qt)
    jpeg_out.write_dct(str(out), quality=-1)
    b = out.read_bytes(); out.unlink(missing_ok=True)
    return bits, b

def ber(stego_bytes, expected_bits, delta):
    with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as f:
        f.write(stego_bytes); path = Path(f.name)
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
            if _qim_detect(c, delta) != expected_bits[i]:
                errors += 1
        return errors / n
    finally:
        path.unlink(missing_ok=True)

covers = sorted(COVERS_DIR.glob("*.png"))
for delta in [10, 14, 18, 22, 26, 30, 36, 44]:
    worst = 0.0
    details = []
    for cover in covers:
        bits, stego = encode(cover, PAYLOAD, delta)
        tmp_stego = cover.with_name(f"_sw_{cover.stem}.jpg")
        tmp_stego.write_bytes(stego)
        for ch in REQUIRED:
            after = simulate(tmp_stego, ch)
            b = ber(after, bits, delta)
            worst = max(worst, b)
            details.append(f"{cover.stem}/{ch}={b*100:.1f}%")
        tmp_stego.unlink(missing_ok=True)
    print(f"delta={delta:3d}  worst_BER={worst*100:5.1f}%   " + " ".join(details))

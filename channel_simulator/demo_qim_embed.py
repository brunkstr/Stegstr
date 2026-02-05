"""
Demo: Embed a payload into an image with QIM and save the result for inspection.

Usage:
  python demo_qim_embed.py [cover_image]

  If no cover is given, uses fixture_cover.jpg (or creates one from fixture_cover.png).
  Writes demo_cover.jpg and demo_qim_stego.jpg to the current directory,
  then opens both in the default viewer for side-by-side comparison.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from channel import simulate
from test_channel_robustness import make_cover_image, _SCRIPT_DIR

OUT_COVER = _SCRIPT_DIR / "demo_cover.jpg"
OUT_STEGO = _SCRIPT_DIR / "demo_qim_stego.jpg"
TEST_PAYLOAD = b"channel_test!"


def main() -> None:
    cover_arg = sys.argv[1] if len(sys.argv) > 1 else None
    if cover_arg:
        cover_path = Path(cover_arg)
        if not cover_path.exists():
            print(f"Error: {cover_path} not found")
            sys.exit(1)
    else:
        cover_png = make_cover_image()
        if not (_SCRIPT_DIR / "fixture_cover.jpg").exists():
            simulate(cover_png, "instagram", output_path=_SCRIPT_DIR / "fixture_cover.jpg")
        cover_path = _SCRIPT_DIR / "fixture_cover.jpg"

    try:
        from dct_variants import encode_dct_qim, decode_dct_qim
    except ImportError as e:
        print(f"Error: {e}")
        sys.exit(1)

    # Prepare cover JPEG for display
    if cover_path.suffix.lower() in (".png", ".gif", ".bmp"):
        from PIL import Image
        img = Image.open(cover_path).convert("RGB")
        img.save(OUT_COVER, "JPEG", quality=85, subsampling=0)
    else:
        OUT_COVER.write_bytes(cover_path.read_bytes())

    print("Embedding payload with QIM...")
    stego_bytes = encode_dct_qim(cover_path, TEST_PAYLOAD)
    OUT_STEGO.write_bytes(stego_bytes)

    # Verify decode on the stego (before channel)
    dec = decode_dct_qim(stego_bytes)
    ok = dec == TEST_PAYLOAD
    print(f"Decode check (before channel): {'OK' if ok else 'FAIL'}")

    print()
    print("Output files:")
    print(f"  Cover:  {OUT_COVER}")
    print(f"  Stego:  {OUT_STEGO}")
    print()

    # Open in default viewer (macOS/Linux)
    try:
        if sys.platform == "darwin":
            subprocess.run(["open", str(OUT_COVER)], check=False)
            subprocess.run(["open", str(OUT_STEGO)], check=False)
        elif sys.platform == "linux":
            subprocess.run(["xdg-open", str(OUT_STEGO)], check=False)
        else:
            print("Open the files above in your image viewer to compare.")
    except Exception:
        print("Open the files above in your image viewer to compare.")


if __name__ == "__main__":
    main()

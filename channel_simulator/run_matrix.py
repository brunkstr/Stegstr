"""
Run full encoder x channel pass/fail matrix for all available encoders.
Output: single table (encoder x channel) with PASS/FAIL.

Usage: python run_matrix.py
"""

from __future__ import annotations

import base64
import subprocess
import sys
import tempfile
from pathlib import Path

# Add parent for imports
sys.path.insert(0, str(Path(__file__).resolve().parent))

from channel import simulate
from test_channel_robustness import (
    get_cli_path,
    make_cover_image,
    run_decode,
    _SCRIPT_DIR,
)

PROFILES = ["whatsapp", "instagram", "facebook", "twitter"]
TEST_PAYLOAD = b"channel_test!"


def run_dwt_matrix(cover_path: Path, cover_jpg: Path) -> list[tuple[str, str, bool]]:
    """DWT encoder via CLI."""
    cli = get_cli_path()
    if not cli:
        return []
    matrix = []
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        stego = tmp / "stego.png"
        b64 = base64.standard_b64encode(TEST_PAYLOAD).decode()
        r = subprocess.run(
            [str(cli), "embed", str(cover_path), "-o", str(stego), "--payload-base64", b64],
            capture_output=True,
            timeout=30,
        )
        if r.returncode != 0 or not stego.exists():
            return []
        for name in PROFILES:
            jpeg_path = tmp / f"out_{name}.jpg"
            simulate(stego, name, output_path=jpeg_path)
            ok, dec = run_decode(cli, jpeg_path)
            matrix.append(("dwt", name, ok and dec == TEST_PAYLOAD))
    return matrix


def _run_dct_variant(
    cover_path: Path,
    cover_jpg: Path,
    encoder_name: str,
    encode_fn,
    decode_fn,
) -> list[tuple[str, str, bool]]:
    if not cover_jpg.exists():
        simulate(cover_path, "instagram", output_path=cover_jpg)
    matrix = []
    try:
        stego_bytes = encode_fn(cover_jpg, TEST_PAYLOAD)
    except Exception:
        return []
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        (tmp / "stego.jpg").write_bytes(stego_bytes)
        for name in PROFILES:
            after = simulate(tmp / "stego.jpg", name, output_path=tmp / f"after_{name}.jpg")
            dec = decode_fn(after)
            matrix.append((encoder_name, name, dec == TEST_PAYLOAD if dec else False))
    return matrix


def run_dct_matrix(cover_path: Path, cover_jpg: Path) -> list[tuple[str, str, bool]]:
    """DCT encoder (dct_stego)."""
    try:
        from dct_stego import encode_dct, decode_dct
    except ImportError:
        return []
    return _run_dct_variant(cover_path, cover_jpg, "dct", encode_dct, decode_dct)


def run_dct_sign_matrix(cover_path: Path, cover_jpg: Path) -> list[tuple[str, str, bool]]:
    try:
        from dct_variants import encode_dct_sign, decode_dct_sign
    except ImportError:
        return []
    return _run_dct_variant(cover_path, cover_jpg, "dct_sign", encode_dct_sign, decode_dct_sign)


def run_dct_tcm_matrix(cover_path: Path, cover_jpg: Path) -> list[tuple[str, str, bool]]:
    try:
        from dct_variants import encode_dct_tcm, decode_dct_tcm
    except ImportError:
        return []
    return _run_dct_variant(cover_path, cover_jpg, "dct_tcm", encode_dct_tcm, decode_dct_tcm)


def run_dct_rs64_matrix(cover_path: Path, cover_jpg: Path) -> list[tuple[str, str, bool]]:
    try:
        from dct_variants import encode_dct_rs64, decode_dct_rs64
    except ImportError:
        return []
    return _run_dct_variant(cover_path, cover_jpg, "dct_rs64", encode_dct_rs64, decode_dct_rs64)


def run_dct_qim_matrix(cover_path: Path, cover_jpg: Path) -> list[tuple[str, str, bool]]:
    try:
        from dct_variants import encode_dct_qim, decode_dct_qim
    except ImportError:
        return []
    return _run_dct_variant(cover_path, cover_jpg, "dct_qim", encode_dct_qim, decode_dct_qim)


def main() -> None:
    cover = make_cover_image()
    cover_jpg = _SCRIPT_DIR / "fixture_cover.jpg"
    if not cover_jpg.exists():
        simulate(cover, "instagram", output_path=cover_jpg)

    all_rows: list[tuple[str, str, bool]] = []
    all_rows.extend(run_dwt_matrix(cover, cover_jpg))
    all_rows.extend(run_dct_matrix(cover, cover_jpg))
    all_rows.extend(run_dct_sign_matrix(cover, cover_jpg))
    all_rows.extend(run_dct_tcm_matrix(cover, cover_jpg))
    all_rows.extend(run_dct_rs64_matrix(cover, cover_jpg))
    all_rows.extend(run_dct_qim_matrix(cover, cover_jpg))

    # Build table
    encoders = sorted(set(r[0] for r in all_rows))
    print("\nEncoder x Channel matrix (PASS/FAIL):\n")
    print("Encoder | " + " | ".join(f"{p:>10}" for p in PROFILES))
    print("-" * (10 + 13 * len(PROFILES)))
    for enc in encoders:
        row = [enc]
        for p in PROFILES:
            match = next((r[2] for r in all_rows if r[0] == enc and r[1] == p), False)
            row.append("PASS" if match else "FAIL")
        print(" | ".join(f"{x:>10}" for x in row))
    print()
    sys.exit(0)


if __name__ == "__main__":
    main()

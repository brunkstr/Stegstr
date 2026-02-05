"""
Automated channel robustness tests: encode -> simulate platform channel -> decode -> verify.

Run: pytest test_channel_robustness.py -v
Or:  python test_channel_robustness.py

Requires Stegstr CLI for DWT encode/decode. Set STEGSTR_CLI to the binary path, or
run from repo root with cargo build --release --bin stegstr-cli (default path used).
"""

from __future__ import annotations

import io
import os
import subprocess
import sys
import tempfile
from pathlib import Path

import pytest

from channel import simulate
from channel import PROFILES
from channel import ProfileName

# Default CLI path: stegstr v1.0/src-tauri/target/release/stegstr-cli (Tauri layout)
_SCRIPT_DIR = Path(__file__).resolve().parent
_REPO_ROOT = _SCRIPT_DIR.parent
_DEFAULT_CLI = _REPO_ROOT / "src-tauri" / "target" / "release" / "stegstr-cli"
if sys.platform == "win32":
    _DEFAULT_CLI = _REPO_ROOT / "src-tauri" / "target" / "release" / "stegstr-cli.exe"


def get_cli_path() -> Path | None:
    path = os.environ.get("STEGSTR_CLI")
    if path:
        p = Path(path)
        return p if p.is_absolute() else _REPO_ROOT / path
    if _DEFAULT_CLI.exists():
        return _DEFAULT_CLI
    # fallback debug build
    debug_cli = _REPO_ROOT / "src-tauri" / "target" / "debug" / "stegstr-cli"
    if sys.platform == "win32":
        debug_cli = _REPO_ROOT / "src-tauri" / "target" / "debug" / "stegstr-cli.exe"
    return debug_cli if debug_cli.exists() else None


def make_cover_image(size: int = 512) -> Path:
    """Create a minimal PNG cover image for testing (even dimensions for DWT)."""
    from PIL import Image

    path = _SCRIPT_DIR / "fixture_cover.png"
    if path.exists() and path.stat().st_size > 0:
        return path
    img = Image.new("RGB", (size, size), color=(120, 140, 160))
    img.save(path, format="PNG")
    return path


def run_decode(cli: Path, image_path: Path) -> tuple[bool, bytes]:
    """
    Run stegstr-cli decode; return (success, payload_bytes).
    CLI returns the application payload only (raw UTF-8 or base64 decoded).
    """
    import base64
    try:
        result = subprocess.run(
            [str(cli), "decode", str(image_path)],
            capture_output=True,
            timeout=30,
        )
        if result.returncode != 0:
            return False, result.stderr or b""
        out = result.stdout
        if out.startswith(b"base64:"):
            try:
                out = base64.standard_b64decode(out[7:].decode().strip())
            except Exception:
                return True, result.stdout  # return raw on parse error
        return True, out
    except Exception as e:
        return False, str(e).encode()


@pytest.fixture(scope="module")
def cli_path():
    return get_cli_path()


@pytest.fixture(scope="module")
def cover_path():
    return make_cover_image()


@pytest.fixture(scope="module")
def test_payload():
    # Short payload so round-trip fits (encoder wraps as STEGSTR + 4-byte len + payload)
    return b"channel_test!"


def test_channel_simulator_standalone():
    """Channel simulator runs and produces valid JPEG with expected dimensions."""
    cover = make_cover_image()
    for name in ["whatsapp", "instagram", "twitter"]:
        jpeg = simulate(cover, name)
        assert jpeg[:2] == b"\xff\xd8"
        from PIL import Image
        img = Image.open(io.BytesIO(jpeg))
        img.load()
        profile = PROFILES[name]
        assert img.size[0] <= profile.max_width


def test_channel_simulator_output_path():
    """Simulate with output_path writes file and returns same bytes."""
    cover = make_cover_image()
    with tempfile.NamedTemporaryFile(suffix=".jpg", delete=False) as f:
        out = Path(f.name)
    try:
        jpeg = simulate(cover, "instagram", output_path=out)
        assert out.exists()
        assert out.read_bytes() == jpeg
    finally:
        out.unlink(missing_ok=True)


@pytest.mark.skipif(get_cli_path() is None, reason="Stegstr CLI not built (run: cargo build --release --bin stegstr-cli)")
def test_dwt_fails_after_channel_baseline(cli_path: Path, cover_path: Path, test_payload: bytes):
    """
    Baseline: current DWT embedding does NOT survive any channel simulation.
    Encode -> simulate (WhatsApp/Instagram/etc.) -> decode should yield wrong or unreadable payload.
    """
    import base64
    with tempfile.TemporaryDirectory() as tmp:
        stego_png = Path(tmp) / "stego.png"
        # Embed using CLI (payload as base64 for binary)
        b64 = base64.standard_b64encode(test_payload).decode()
        ok = subprocess.run(
            [str(cli_path), "embed", str(cover_path), "-o", str(stego_png), "--payload-base64", b64],
            capture_output=True,
            timeout=30,
        )
        if ok.returncode != 0:
            pytest.skip(f"CLI embed failed: {ok.stderr.decode()}")
        assert stego_png.exists()

        results: list[tuple[str, bool, str]] = []
        for profile_name in ["whatsapp", "instagram", "facebook", "twitter"]:
            jpeg_path = Path(tmp) / f"after_{profile_name}.jpg"
            simulate(stego_png, profile_name, output_path=jpeg_path)
            success, decoded = run_decode(cli_path, jpeg_path)
            payload_match = success and decoded == test_payload
            results.append((profile_name, payload_match, (decoded[:50].decode("utf-8", errors="replace") if decoded else "")))

        # Baseline: at least one channel must break the payload (typically all)
        any_failed = not all(r[1] for r in results)
        assert any_failed, (
            "Baseline expected: DWT should NOT survive channel (payload mismatch or decode fail). "
            "If all passed, channel sim may be too mild or decoder changed. Results: " + str(results)
        )


def test_encode_simulate_decode_matrix(cli_path: Path | None, cover_path: Path, test_payload: bytes):
    """
    Report matrix: for each encoder (currently only DWT) and each channel profile,
    run encode -> simulate -> decode and record pass/fail.
    """
    import base64
    if cli_path is None:
        pytest.skip("Stegstr CLI not built")
    with tempfile.TemporaryDirectory() as tmp:
        stego_png = Path(tmp) / "stego.png"
        b64 = base64.standard_b64encode(test_payload).decode()
        subprocess.run(
            [str(cli_path), "embed", str(cover_path), "-o", str(stego_png), "--payload-base64", b64],
            capture_output=True,
            timeout=30,
        )
        if not stego_png.exists():
            pytest.skip("CLI embed failed")

        matrix: list[tuple[str, str, bool]] = []
        for profile_name in ["whatsapp", "instagram", "facebook", "twitter"]:
            jpeg_path = Path(tmp) / f"out_{profile_name}.jpg"
            simulate(stego_png, profile_name, output_path=jpeg_path)
            success, decoded = run_decode(cli_path, jpeg_path)
            match = success and decoded == test_payload
            matrix.append(("dwt", profile_name, match))

        # Print matrix for visibility
        for enc, ch, pass_ in matrix:
            status = "PASS" if pass_ else "FAIL"
            print(f"  {enc} x {ch}: {status}")
        # Currently we expect all FAIL for DWT
        assert not any(m[2] for m in matrix), "DWT should not survive any channel (see plan)"


def test_dct_roundtrip_no_channel(cover_path: Path, test_payload: bytes):
    """DCT encode/decode round-trip without channel (sanity check)."""
    try:
        from dct_stego import encode_dct, decode_dct
    except ImportError:
        pytest.skip("dct_stego (jpeglib, reedsolo) not installed")
    from channel import simulate
    cover_jpg = _SCRIPT_DIR / "fixture_cover.jpg"
    if not cover_jpg.exists():
        simulate(cover_path, "instagram", output_path=cover_jpg)
    stego = encode_dct(cover_jpg, test_payload)
    dec = decode_dct(stego)
    assert dec == test_payload, f"roundtrip failed: {dec!r} != {test_payload!r}"


def test_dct_survives_some_channels(cover_path: Path, test_payload: bytes):
    """
    DCT-robust encoder should survive at least some channel profiles (e.g. Instagram, Twitter).
    """
    try:
        from dct_stego import encode_dct, decode_dct
    except ImportError:
        pytest.skip("dct_stego not installed")
    from channel import simulate
    cover_jpg = _SCRIPT_DIR / "fixture_cover.jpg"
    if not cover_jpg.exists():
        simulate(cover_path, "instagram", output_path=cover_jpg)
    stego_bytes = encode_dct(cover_jpg, test_payload)
    results = []
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        stego_path = tmp / "stego.jpg"
        stego_path.write_bytes(stego_bytes)
        for profile_name in ["whatsapp", "instagram", "facebook", "twitter"]:
            after_path = tmp / f"after_{profile_name}.jpg"
            after_bytes = simulate(stego_path, profile_name, output_path=after_path)
            dec = decode_dct(after_bytes)
            results.append((profile_name, dec == test_payload))
    assert any(r[1] for r in results), f"DCT should survive at least one channel: {results}"


if __name__ == "__main__":
    # Run pytest with verbose output
    pytest.main([__file__, "-v", "-s"])

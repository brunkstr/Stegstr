"""Platform survival matrix using the REAL Rust stegstr-cli --robust (QIM)
binary end-to-end -- not the Python dct_variants prototype. Encode with the
actual shipped CLI, run each cover through the channel simulator (resize +
JPEG re-encode per platform, matching WhatsApp/Instagram/Facebook/Twitter/
Telegram), decode with the actual shipped CLI, and verify the payload.

Run from channel_simulator/ after building: cargo build --release --bin stegstr-cli
"""
from __future__ import annotations

import base64
import subprocess
import sys
import tempfile
from pathlib import Path

from channel import simulate, PROFILES

SCRIPT_DIR = Path(__file__).resolve().parent
REPO_ROOT = SCRIPT_DIR.parent
CLI = REPO_ROOT / "src-tauri" / "target" / "release" / "stegstr-cli.exe"
if not CLI.exists():
    CLI = REPO_ROOT / "src-tauri" / "target" / "release" / "stegstr-cli"

COVERS = [
    SCRIPT_DIR / "covers" / "textured.png",
    SCRIPT_DIR / "covers" / "highfreq.png",
    SCRIPT_DIR / "covers" / "smooth.png",
    SCRIPT_DIR / "covers" / "portrait.png",
    SCRIPT_DIR / "covers_extended" / "high_contrast.png",
    SCRIPT_DIR / "covers_extended" / "low_light.png",
    SCRIPT_DIR / "covers_extended" / "screenshot.png",
    SCRIPT_DIR / "covers_extended" / "phone_portrait.png",
    SCRIPT_DIR / "covers_extended" / "narrow_tall.png",
]

PLATFORMS = ["whatsapp", "instagram", "facebook", "twitter", "telegram"]
PAYLOAD = b'{"version":1,"events":[{"content":"channel survival test"}]}'


def run_decode(image_path: Path) -> tuple[bool, bytes]:
    try:
        result = subprocess.run(
            [str(CLI), "decode", str(image_path)],
            capture_output=True, timeout=30,
        )
        if result.returncode != 0:
            return False, result.stderr or b""
        out = result.stdout
        if out.startswith(b"base64:"):
            try:
                out = base64.standard_b64decode(out[7:].decode().strip())
            except Exception:
                return True, result.stdout
        return True, out
    except Exception as e:
        return False, str(e).encode()


def main():
    if not CLI.exists():
        print(f"CLI not found at {CLI} -- build with: cargo build --release --bin stegstr-cli")
        sys.exit(1)

    b64 = base64.standard_b64encode(PAYLOAD).decode()
    results = {}  # cover -> platform -> bool
    fails = []

    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        for cover in COVERS:
            if not cover.exists():
                print(f"SKIP missing cover: {cover}")
                continue
            stego_jpg = tmp / f"{cover.stem}_stego.jpg"
            r = subprocess.run(
                [str(CLI), "embed", str(cover), "-o", str(stego_jpg),
                 "--payload-base64", b64, "--robust"],
                capture_output=True, timeout=60,
            )
            if r.returncode != 0:
                print(f"EMBED FAILED for {cover.name}: {r.stderr.decode(errors='replace')[:150]}")
                results[cover.name] = {p: False for p in PLATFORMS}
                fails.append((cover.name, "embed", r.stderr.decode(errors='replace')[:150]))
                continue

            row = {}
            for platform in PLATFORMS:
                after_path = tmp / f"{cover.stem}_{platform}.jpg"
                simulate(stego_jpg, platform, output_path=after_path)
                success, decoded = run_decode(after_path)
                match = success and decoded == PAYLOAD
                row[platform] = match
                if not match:
                    fails.append((cover.name, platform,
                                   decoded[:80] if isinstance(decoded, bytes) else decoded))
            results[cover.name] = row

    # Print matrix
    header = f"{'cover':22s} " + " ".join(f"{p:10s}" for p in PLATFORMS)
    print(header)
    print("-" * len(header))
    total = 0
    passed = 0
    for cover_name, row in results.items():
        cells = []
        for p in PLATFORMS:
            ok = row.get(p, False)
            total += 1
            passed += 1 if ok else 0
            cells.append(f"{'PASS' if ok else 'FAIL':10s}")
        print(f"{cover_name:22s} " + " ".join(cells))

    print(f"\n{passed}/{total} cover x platform combinations passed")
    if fails:
        print(f"\n{len(fails)} failures:")
        for f in fails:
            print(" ", f)


if __name__ == "__main__":
    main()

"""
Build the evidence pack attached to the contest evaluation form.

The form takes one file, so this produces a single zip holding the artefacts the
instructions ask for (section 6): the gauntlet run, the unit-test output, and
the actual image files - cover, stego, and the received copy after each profile -
so every claim in the write-up can be checked rather than taken on faith.
"""

from __future__ import annotations

import base64
import io
import json
import os
import shutil
import subprocess
import sys
import zipfile
from pathlib import Path

import numpy as np
from PIL import Image

sys.path.insert(0, str(Path(__file__).parent))
import covers as covers_mod  # noqa: E402
from gauntlet import PROFILES, SECRET, apply_profile, psnr, ssim  # noqa: E402

REPO = Path(__file__).resolve().parent.parent
# STEGSTR_CLI lets this run against a clean clone rather than the working tree,
# which is the only way to be sure the pinned commit is what scores.
CLI = Path(os.environ.get("STEGSTR_CLI") or (REPO / "dist-cli" / "stegstr.mjs"))
OUT = Path.home() / "Desktop" / "Stegstr Contest Entry" / "evidence"
COMMIT = subprocess.run(["git", "rev-parse", "HEAD"], cwd=REPO,
                        capture_output=True, text=True).stdout.strip()


def cli(args: list[str]) -> dict:
    proc = subprocess.run(["node", str(CLI), *args, "--json"], capture_output=True, text=True)
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError:
        return {"ok": False, "error": (proc.stderr or proc.stdout)[:200]}


def recovered(result: dict) -> bytes | None:
    """The CLI reports text payloads as utf8 and binary ones as base64."""
    if not result.get("ok"):
        return None
    if result.get("encoding") == "base64":
        return base64.b64decode(result["payload"])
    return result["payload"].encode()


def main() -> int:
    if OUT.exists():
        shutil.rmtree(OUT)
    images = OUT / "images"
    images.mkdir(parents=True)

    lines: list[str] = []
    lines.append(f"Stegstr entry #71 - gauntlet evidence")
    lines.append(f"commit {COMMIT}")
    lines.append(f"secret: {len(SECRET)} bytes, {SECRET!r}")
    lines.append("")
    lines.append(f"{'cover':<11}{'control':<9}" + "".join(f"{p[0]:>8}" for p in PROFILES)
                 + f"{'PSNR':>8}{'SSIM':>8}")
    lines.append("-" * 76)

    survived = total = 0
    for name in ["landscape", "foliage", "portrait", "night"]:
        cover = covers_mod.get_cover(name, 1600, 1200)
        shutil.copy(cover, images / f"{name}_1_cover.png")

        stego_path = images / f"{name}_2_stego.png"
        res = cli(["embed", str(cover), "-o", str(stego_path),
                   "--payload-base64", base64.b64encode(SECRET).decode(), "--mode", "locator"])
        if not res.get("ok"):
            lines.append(f"{name:<11}EMBED FAILED {res.get('error')}")
            continue

        stego_bytes = stego_path.read_bytes()
        control = cli(["detect", str(stego_path), "--mode", "locator"])
        control_ok = recovered(control) == SECRET

        cov_arr = np.asarray(Image.open(cover).convert("RGB"))
        st_arr = np.asarray(Image.open(io.BytesIO(stego_bytes)).convert("RGB"))
        row = f"{name:<11}{('PASS' if control_ok else 'FAIL'):<9}"

        for pname, cap, q, sub in PROFILES:
            recv = images / f"{name}_3_received_{pname.replace('.', '')}.jpg"
            recv.write_bytes(apply_profile(stego_bytes, cap, q, sub))
            got = cli(["detect", str(recv), "--mode", "locator"])
            ok = recovered(got) == SECRET
            survived += bool(ok)
            total += 1
            row += f"{('OK' if ok else 'x'):>8}"

        row += f"{psnr(cov_arr, st_arr):>8.1f}{ssim(cov_arr, st_arr):>8.3f}"
        lines.append(row)

    lines.append("-" * 76)
    lines.append("")
    lines.append(f"Survival: {survived}/{total} ({100.0 * survived / total:.0f}%)")
    (OUT / "gauntlet-results.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("\n".join(lines))

    # Unit tests, captured verbatim rather than summarised.
    npx = shutil.which("npx.cmd") or shutil.which("npx")
    tests = subprocess.run([npx, "vitest", "run"], cwd=REPO,
                           capture_output=True, text=True, encoding="utf-8", errors="replace")
    # vitest writes its summary to stderr, so keep both streams.
    captured = (tests.stdout or "") + (tests.stderr or "")
    (OUT / "unit-tests.txt").write_text(captured[-30000:], encoding="utf-8")
    print(f"unit-tests.txt: {len(captured)} chars captured")

    archive = OUT.parent / "stegstr-71-evidence.zip"
    if archive.exists():
        archive.unlink()
    with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as z:
        for f in sorted(OUT.rglob("*")):
            if f.is_file():
                z.write(f, f.relative_to(OUT).as_posix())
    print(f"\nevidence pack: {archive}  ({archive.stat().st_size // 1024} kB)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

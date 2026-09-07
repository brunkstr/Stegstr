"""
End-to-end validation of the *shipping* TypeScript encoder.

Everything in `bench.py` measures Python research code. This drives the real
`dist-cli/stegstr.mjs` - the same module the app imports - so the numbers
describe what actually ships:

    node CLI embeds  ->  real JPEG on disk  ->  channel simulator  ->  node CLI detects

Build the CLI first:

    npx esbuild cli/stegstr.ts --bundle --platform=node --format=esm \
      --target=node18 --outfile=dist-cli/stegstr.mjs --external:jpeg-js --external:pngjs

Then:

    python crossvalidate.py --trials 3
"""

from __future__ import annotations

import argparse
import base64
import json
import random
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))

import channel  # noqa: E402
import covers  # noqa: E402

REPO = Path(__file__).resolve().parent.parent
CLI = REPO / "dist-cli" / "stegstr.mjs"

PLATFORMS = ["telegram_file", "instagram", "facebook", "twitter", "telegram",
             "whatsapp", "whatsapp_twice"]

PAYLOADS = {
    "locator": bytes(range(48)),
    "standard": b'{"v":1,"t":"the quick brown fox jumps over the lazy dog","n":42}',
}


def node() -> str:
    exe = shutil.which("node")
    if not exe:
        raise SystemExit("node not found on PATH")
    return exe


def run_cli(args: list[str]) -> dict:
    proc = subprocess.run(
        [node(), str(CLI), *args, "--json"],
        capture_output=True,
        text=True,
    )
    try:
        return json.loads(proc.stdout)
    except json.JSONDecodeError:
        return {"ok": False, "error": (proc.stderr or proc.stdout).strip()[:200]}


def embed(cover: Path, out: Path, payload: bytes, mode: str) -> dict:
    return run_cli([
        "embed", str(cover), "-o", str(out),
        "--payload-base64", base64.b64encode(payload).decode(),
        "--mode", mode,
    ])


def detect(image: Path, mode: str) -> bytes | None:
    result = run_cli(["detect", str(image), "--mode", mode])
    if not result.get("ok"):
        return None
    if result.get("encoding") == "base64":
        return base64.b64decode(result["payload"])
    return result["payload"].encode()


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--trials", type=int, default=3)
    ap.add_argument("--mode", default="locator")
    args = ap.parse_args()

    if not CLI.exists():
        raise SystemExit(f"CLI bundle not found at {CLI} - build it first (see module docstring)")

    payload = PAYLOADS.get(args.mode, PAYLOADS["locator"])
    print(f"\nShipping TypeScript encoder via {CLI.relative_to(REPO)}")
    print(f"Mode: {args.mode} | payload {len(payload)} B | trials per cell: {args.trials}\n")

    header = f"{'cover':<12}" + "".join(f"{p:>16}" for p in PLATFORMS)
    print(header)
    print("-" * len(header))

    totals = {p: [0, 0] for p in PLATFORMS}

    with tempfile.TemporaryDirectory() as tmp:
        tmpdir = Path(tmp)
        for kind in covers.GENERATORS:
            cover = covers.get_cover(kind, 1600, 1200)
            stego = tmpdir / f"{kind}.jpg"

            result = embed(cover, stego, payload, args.mode)
            if not result.get("ok"):
                print(f"{kind:<12}  EMBED FAILED: {result.get('error')}")
                continue

            row = f"{kind:<12}"
            for platform in PLATFORMS:
                ok = 0
                for t in range(args.trials):
                    attacked = tmpdir / f"{kind}_{platform}_{t}.jpg"
                    rng = random.Random(hash((kind, platform, t)) & 0xFFFFFFFF)
                    channel.simulate(stego, platform, output_path=attacked, rng=rng)
                    if detect(attacked, args.mode) == payload:
                        ok += 1
                totals[platform][0] += ok
                totals[platform][1] += args.trials
                row += f"{f'{ok}/{args.trials}':>16}"
            print(row)

    print("-" * len(header))
    summary = f"{'TOTAL':<12}"
    for p in PLATFORMS:
        ok, n = totals[p]
        summary += f"{f'{ok}/{n} ({100.0 * ok / n:.0f}%)' if n else '-':>16}"
    print(summary)

    total_ok = sum(v[0] for v in totals.values())
    total_n = sum(v[1] for v in totals.values())
    if total_n:
        print(f"\nOverall: {total_ok}/{total_n} ({100.0 * total_ok / total_n:.1f}%)\n")
    return 0 if total_ok == total_n else 1


if __name__ == "__main__":
    raise SystemExit(main())

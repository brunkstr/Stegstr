"""
Benchmark harness: scheme x cover x platform -> survival rate.

Usage:
    python bench.py current            # measure the shipping stego-qim.ts scheme
    python bench.py current --trials 5
"""

from __future__ import annotations

import argparse
import io
import random
import sys
import time
from pathlib import Path

from PIL import Image

sys.path.insert(0, str(Path(__file__).parent))

import channel  # noqa: E402
import covers  # noqa: E402

DEFAULT_PLATFORMS = [
    "telegram_file",
    "instagram",
    "facebook",
    "twitter",
    "telegram",
    "whatsapp",
    "whatsapp_twice",
]

#: A 48-byte locator: 32-byte Nostr event id + 16-byte decryption key. This is
#: what the robust mode is actually sized to carry.
LOCATOR_PAYLOAD = bytes(range(48))

#: A short note, for modes with room for the message itself.
MESSAGE_PAYLOAD = b'{"v":1,"t":"the quick brown fox jumps over the lazy dog","n":42}'


def load_scheme(name: str):
    """Return (embed, detect, label) for a named scheme."""
    if name == "current":
        import qim_current

        return qim_current.embed, qim_current.detect, "current (stego-qim.ts port)"

    if name.startswith("stdm"):
        import stdm

        mode = name.split(":", 1)[1] if ":" in name else "locator"
        p = stdm.MODES[mode]
        return (
            lambda img, payload: stdm.embed(img, payload, p),
            lambda img: stdm.detect(img, p),
            f"stdm:{mode} (canonical {p.canonical}, {p.chips} chips, "
            f"{stdm.payload_bytes(p)}B payload)",
        )

    raise SystemExit(f"unknown scheme: {name}")


def run(scheme_name: str, trials: int, platforms: list[str], cover_kinds: list[str],
        payload: bytes | None = None) -> int:
    embed, detect, label = load_scheme(scheme_name)
    if payload is None:
        payload = LOCATOR_PAYLOAD if scheme_name.endswith("locator") else MESSAGE_PAYLOAD
    PAYLOAD = payload

    print(f"\nScheme: {label}")
    print(f"Payload: {len(PAYLOAD)} bytes | trials per cell: {trials}\n")

    header = f"{'cover':<12}" + "".join(f"{p:>16}" for p in platforms)
    print(header)
    print("-" * len(header))

    totals = {p: [0, 0] for p in platforms}
    psnr_values: list[float] = []
    embed_times: list[float] = []

    for kind in cover_kinds:
        cover_path = covers.get_cover(kind)
        row = f"{kind:<12}"

        t0 = time.time()
        try:
            stego_bytes = embed(cover_path, PAYLOAD)
        except Exception as exc:  # noqa: BLE001
            print(f"{kind:<12}  EMBED FAILED: {exc}")
            continue
        embed_times.append(time.time() - t0)

        stego_img = Image.open(io.BytesIO(stego_bytes)).convert("RGB")
        psnr_values.append(channel.psnr(cover_path, stego_img))

        # Sanity: the scheme must at least decode its own untouched output.
        if detect(stego_bytes) != PAYLOAD:
            row += f"{'SELF-TEST FAIL':>16}"
            print(row)
            continue

        for platform in platforms:
            ok = 0
            for t in range(trials):
                rng = random.Random(hash((kind, platform, t)) & 0xFFFFFFFF)
                attacked = channel.simulate(stego_bytes, platform, rng=rng)
                try:
                    if detect(attacked) == PAYLOAD:
                        ok += 1
                except Exception:  # noqa: BLE001
                    pass
            totals[platform][0] += ok
            totals[platform][1] += trials
            row += f"{f'{ok}/{trials}':>16}"

        print(row)

    print("-" * len(header))
    summary = f"{'TOTAL':<12}"
    for p in platforms:
        ok, n = totals[p]
        pct = (100.0 * ok / n) if n else 0.0
        summary += f"{f'{ok}/{n} ({pct:.0f}%)':>16}"
    print(summary)

    if psnr_values:
        avg_psnr = sum(psnr_values) / len(psnr_values)
        print(f"\nInvisibility: mean PSNR {avg_psnr:.1f} dB (>40 dB = imperceptible)")
    if embed_times:
        print(f"Embed time:   mean {sum(embed_times) / len(embed_times):.2f}s per image")

    overall_ok = sum(v[0] for v in totals.values())
    overall_n = sum(v[1] for v in totals.values())
    print(f"Overall:      {overall_ok}/{overall_n} "
          f"({100.0 * overall_ok / overall_n:.1f}%)\n" if overall_n else "")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("scheme", nargs="?", default="current")
    ap.add_argument("--trials", type=int, default=3)
    ap.add_argument("--platforms", default=",".join(DEFAULT_PLATFORMS))
    ap.add_argument("--covers", default=",".join(covers.GENERATORS))
    args = ap.parse_args()
    return run(
        args.scheme,
        args.trials,
        args.platforms.split(","),
        args.covers.split(","),
    )


if __name__ == "__main__":
    raise SystemExit(main())

"""
Rigorous robustness matrix: realistic (non-flat) cover photos x all platform
profiles x realistic payload size, plus multi-hop re-share chains.

The original run_matrix.py used a single flat solid-color 512x512 image and a
13-byte payload, which does not stress AC coefficients the way a real photo
does. This script closes that gap before trusting any PASS result.

Usage: python run_matrix_realistic.py
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from channel import simulate, simulate_chain, PROFILES
from dct_variants import encode_dct_qim, decode_dct_qim

COVERS_DIR = Path(__file__).resolve().parent / "covers"
SINGLE_PROFILES = list(PROFILES.keys())
CHAINS = [
    ["telegram", "whatsapp"],
    ["whatsapp", "instagram"],
    ["instagram", "telegram", "whatsapp"],
]

# Realistic payload: a Nostr kind-1 event bundle roughly matching a real post,
# not a 13-byte string.
REALISTIC_BUNDLE = json.dumps({
    "version": 1,
    "events": [{
        "id": "a" * 64,
        "pubkey": "b" * 64,
        "created_at": 1731000000,
        "kind": 1,
        "tags": [["p", "c" * 64]],
        "content": "Hey, meeting moved to 4pm tomorrow. Bring the signed contract copies. Sent by Stegstr.",
        "sig": "d" * 128,
    }],
}).encode()


def run_for_cover(cover_path: Path, payload: bytes) -> list[tuple[str, str, bool]]:
    rows = []
    try:
        stego_bytes = encode_dct_qim(cover_path, payload)
    except Exception as e:
        return [(cover_path.stem, "ENCODE_ERROR", False, str(e))]
    tmp_stego = cover_path.with_name(f"_tmp_stego_{cover_path.stem}.jpg")
    tmp_stego.write_bytes(stego_bytes)
    try:
        for name in SINGLE_PROFILES:
            after = simulate(tmp_stego, name)
            dec = decode_dct_qim(after)
            rows.append((cover_path.stem, name, dec == payload))
        for chain in CHAINS:
            after = simulate_chain(tmp_stego, chain)
            dec = decode_dct_qim(after)
            rows.append((cover_path.stem, "->".join(chain), dec == payload))
    finally:
        tmp_stego.unlink(missing_ok=True)
    return rows


def main():
    covers = sorted(COVERS_DIR.glob("*.png"))
    if not covers:
        print("No covers found; run gen_realistic_covers.py first.")
        sys.exit(1)

    all_rows = []
    for cover in covers:
        all_rows.extend(run_for_cover(cover, REALISTIC_BUNDLE))

    channels = SINGLE_PROFILES + ["->".join(c) for c in CHAINS]
    print(f"\ndct_qim x realistic covers (payload={len(REALISTIC_BUNDLE)} bytes)\n")
    header = "cover".ljust(10) + " | " + " | ".join(c.ljust(22) for c in channels)
    print(header)
    print("-" * len(header))
    for cover in covers:
        name = cover.stem
        cells = []
        for ch in channels:
            match = next((r[2] for r in all_rows if r[0] == name and r[1] == ch), None)
            cells.append(("PASS" if match else "FAIL").ljust(22))
        print(name.ljust(10) + " | " + " | ".join(cells))

    n_total = len(all_rows)
    n_pass = sum(1 for r in all_rows if r[2])
    print(f"\n{n_pass}/{n_total} passed")
    sys.exit(0 if n_pass == n_total else 1)


if __name__ == "__main__":
    main()

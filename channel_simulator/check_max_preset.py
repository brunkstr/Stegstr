import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).resolve().parent))
from channel import simulate, PROFILES
from dct_variants import encode_dct_qim, decode_dct_qim

COVERS_DIR = Path(__file__).resolve().parent / "covers"
payload = b"max preset check payload, twitter/x aggressive downscale test"

for cover in sorted(COVERS_DIR.glob("*.png")):
    stego = encode_dct_qim(cover, payload, robustness="max")
    tmp = cover.with_name(f"_max_{cover.stem}.jpg")
    tmp.write_bytes(stego)
    row = []
    for ch in PROFILES:
        after = simulate(tmp, ch)
        dec = decode_dct_qim(after)
        row.append(f"{ch}={'PASS' if dec == payload else 'FAIL'}")
    tmp.unlink(missing_ok=True)
    print(cover.stem, " ".join(row))

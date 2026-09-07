"""Extra stress pass for the adaptive-delta change: hard_covers set (flat
gradient, blown-out white, near-black, uniform sky, pure solid colors) plus
a larger payload, through the real Rust CLI end-to-end."""
import subprocess, base64, sys
from pathlib import Path
from channel import simulate

CLI = r"D:\Projects\Stegstr\src-tauri\target\release\stegstr-cli.exe"
HARD_COVERS_DIR = Path(r"C:\Users\MUHAMM~1\AppData\Local\Temp\claude\D--Projects-Stegstr\ea052c2c-51de-490e-a3ab-1b5631e1f7a2\scratchpad\hard_covers")
PLATFORMS = ["whatsapp", "instagram", "facebook", "twitter", "telegram"]
PAYLOADS = {
    "short": b'{"version":1,"events":[{"content":"channel survival test"}]}',
    "long": ("The quick brown fox jumps over the lazy dog. " * 8).encode(),
}


def run_decode(image_path):
    r = subprocess.run([CLI, "decode", str(image_path)], capture_output=True, timeout=30)
    if r.returncode != 0:
        return False, r.stderr
    out = r.stdout
    if out.startswith(b"base64:"):
        out = base64.standard_b64decode(out[7:].decode().strip())
    return True, out


covers = sorted(HARD_COVERS_DIR.glob("*.png"))
fails = []
total = 0
for cover in covers:
    for pname, payload in PAYLOADS.items():
        b64 = base64.standard_b64encode(payload).decode()
        stego = cover.with_name(f"_extra_{cover.stem}_{pname}.jpg")
        r = subprocess.run([CLI, "embed", str(cover), "-o", str(stego), "--payload-base64", b64, "--robust"],
                            capture_output=True, timeout=60)
        if r.returncode != 0:
            print(f"EMBED FAIL {cover.name} {pname}: {r.stderr.decode(errors='replace')[:150]}")
            continue
        for platform in PLATFORMS:
            after = cover.with_name(f"_extra_{cover.stem}_{pname}_{platform}.jpg")
            simulate(stego, platform, output_path=after)
            total += 1
            ok, decoded = run_decode(after)
            if not ok or decoded != payload:
                fails.append((cover.name, pname, platform))
            after.unlink(missing_ok=True)
        stego.unlink(missing_ok=True)

print(f"\n{total - len(fails)}/{total} passed")
if fails:
    print("FAILURES:")
    for f in fails:
        print(" ", f)

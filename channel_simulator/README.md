# Channel Simulator and Robustness Tests

Simulates social-platform image processing (WhatsApp, Instagram, Facebook, Twitter) so steganography can be tested in an **enclosed loop** without posting to real platforms.

## Setup

```bash
cd channel_simulator
pip install -r requirements.txt
```

For tests that use the Stegstr CLI (embed/decode), build the CLI first:

```bash
cd .. && cargo build --release --bin stegstr-cli
# Binary: src-tauri/target/release/stegstr-cli
```

## Channel simulator

```python
from channel import simulate, PROFILES

# Simulate WhatsApp: resize to 800px, JPEG Q 65, 4:2:0
jpeg_bytes = simulate("stego.png", "whatsapp")

# With output file
simulate("stego.png", "instagram", output_path="after_instagram.jpg")
```

Profiles: `whatsapp`, `instagram`, `facebook`, `twitter` (see `channel.PROFILES`).

## Tests

Run all tests (standalone + CLI-based):

```bash
python test_channel_robustness.py
```

Or run specific tests (avoid loading all pytest plugins if you have env issues):

```bash
python -c "
import sys; sys.path.insert(0, '.')
# Standalone
from channel import simulate, PROFILES
from pathlib import Path
from PIL import Image
cover = Path('fixture_cover.png')
if not cover.exists():
    Image.new('RGB', (512,512), (120,140,160)).save(cover)
for name in ['whatsapp', 'instagram', 'twitter']:
    jpeg = simulate(cover, name)
    assert jpeg[:2] == b'\xff\xd8'
print('Channel simulator tests OK')
# Baseline (requires CLI)
from test_channel_robustness import get_cli_path, run_decode, make_cover_image
from channel import simulate
import base64, subprocess, tempfile
cli = get_cli_path()
if cli:
    cover = make_cover_image()
    payload = b'channel_test!'
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        stego = tmp / 'stego.png'
        subprocess.run([str(cli), 'embed', str(cover), '-o', str(stego), '--payload-base64', base64.b64encode(payload).decode()], capture_output=True)
        for name in ['whatsapp', 'instagram']:
            simulate(stego, name, output_path=tmp / (name + '.jpg'))
            ok, dec = run_decode(cli, tmp / (name + '.jpg'))
            assert not (ok and dec == payload), 'DWT should not survive channel'
    print('Baseline OK')
"
```

## Baseline result

Current **DWT (Haar 2D) + LSB** embedding does **not** survive any simulated channel (WhatsApp, Instagram, Facebook, Twitter). After resize + JPEG re-encode, decode fails or returns wrong data. This validates the need for a DCT-based robust path (see plan).

## DCT-robust prototype

Optional: install `jpeglib` and `reedsolo` for DCT-domain steganography that can survive some channel simulation:

```bash
pip install jpeglib reedsolo
```

```python
from dct_stego import encode_dct, decode_dct
from pathlib import Path
from channel import simulate

# Cover must be JPEG (or path to PNG; it will be converted)
cover_jpg = Path("fixture_cover.jpg")
payload = b"your payload"
stego_jpeg_bytes = encode_dct(cover_jpg, payload)
# After "channel" (e.g. Instagram-like):
after = simulate("stego.jpg", "instagram")  # or pass bytes via temp file
decoded = decode_dct(after)
# Decoded should match payload for Instagram/Twitter-like profiles; WhatsApp/Facebook may fail.
```

Payload format is compatible (STEGSTR magic + length + payload) with Reed–Solomon error correction. In tests, DCT survives **Instagram** and **Twitter**-like channels; **WhatsApp** and **Facebook**-like (harsher resize/Q) may still corrupt the payload.

## Optional: STEGSTR_CLI

Set `STEGSTR_CLI` to the path to `stegstr-cli` if it is not under `../src-tauri/target/release/`.

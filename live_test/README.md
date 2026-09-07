# Live platform evidence

The actual sent and received files from the live WhatsApp/Instagram round trip
described in [`channel_simulator/BASELINE_RESULTS.md`](../channel_simulator/BASELINE_RESULTS.md#live-re-test-after-phase-4-three-real-sends-plus-a-whatsapp-control-experiment)
and [`ROBUSTNESS_REPORT.md`](../ROBUSTNESS_REPORT.md) -- not simulated, not
regenerated for this commit. Reproduce the check yourself:

```bash
./decode_received.sh
```

## What was sent

One fixed, randomly-noned payload (`PAYLOAD.txt`), embedded with the current
release CLI via `stegstr-cli embed <cover> -o <out> --robust --payload "<msg>"`
(`Robustness::Max` -- `--robust`'s default) into real camera-realistic JPEG
photos, not this repo's synthetic generated covers.

## What came back

| file | sent | received | Δ | decode |
|---|---:|---:|---:|---|
| `send_instagram.jpg` / `received_instagram.jpg` | 48,241 B | 52,609 B | +4,368 B (+9.1%) | **PASS** |
| `send_whatsapp.jpg` / `received_whatsapp.jpg` | 14,486 B | 14,486 B | +0 B | **PASS** |
| `control/control_whatsapp_original.jpg` / `received/received_control_whatsapp.jpg` | 393,630 B | ~94 KB | -76% | n/a -- no payload, by design |

## What the control proves

A byte-identical round trip (WhatsApp, above) is consistent with two different
mechanisms: the platform recompressed the file and coincidentally reproduced
the same bytes, or the platform didn't touch the file at all. Only a control
image -- an **untouched, unembedded original**, sent the same way -- can tell
these apart.

The control (`control_whatsapp_original.jpg`, SHA-256-verified identical to
its source before sending) came back at ~94KB, a ~76% reduction. WhatsApp's
pipeline does recompress images that need it. Since the same path recompressed
a 393,630-byte original by ~76% but left the 14,486-byte stego file completely
untouched, the correct conclusion is: `--robust`'s pre-conditioning (resize to
576px on the longer side, JPEG quality 80) already puts its output below
whatever threshold triggers WhatsApp's own recompression. **The stego file
passed through unmodified -- it did not survive being recompressed.**

Instagram's result is the opposite and stronger case: the file size changed,
meaning Instagram's own pipeline actually re-encoded it, and the payload
still decoded correctly afterward. That is a genuine
recompression-survival result. Do not describe the WhatsApp result the same
way -- they are different claims, and this folder is the evidence for why.

`decode_received.sh` correctly reports the control files as
`OK (control -- no payload expected)` rather than a decode failure, since
they were never supposed to contain a payload.

## Not included here

`send_telegram.jpg` was prepared identically but never sent through a real
Telegram client this round -- Telegram's live-platform confirmation is still
open. See `STEGSTR_ENTRY_V3.md` Part 2, "Close the Telegram gap."

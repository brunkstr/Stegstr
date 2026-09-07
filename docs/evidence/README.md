# Visual evidence: BUGS.md #5

Side-by-side proof of the tile-position pixel-corruption bug documented in
[`BUGS.md`](../../BUGS.md#5-encode-wrote-every-non-leftmost-tiles-pixels-from-the-wrong-source-column----catastrophic-visible-corruption-not-just-imperfect-invisibility).

Each image is a 2x3 grid:

- **Top row:** original cover -> output from pristine upstream's (buggy) DWT
  encoder -> difference vs the cover, amplified 4x for visibility.
- **Bottom row:** same cover -> output from this fork's fixed encoder ->
  difference vs the cover, amplified 4x.

All three covers are 512x512 (two 256px tiles wide), embedded with the same
188-byte payload.

| file | cover |
|---|---|
| `bug5_flat_gradient.png` | Smooth horizontal gradient -- the most dramatic case: the right tile is visibly a repeated copy of the left tile's gradient, creating an obvious seam. |
| `bug5_uniform_sky.png` | Pale blue gradient with subtle diagonal shading (sun-position asymmetry) -- a plausible sky photo, not perfectly symmetric, so the same-content-either-way case doesn't mask the bug. |
| `bug5_photo.png` | Textured/noisy cover approximating a real photo -- the diff panel shows the classic "wrong tile" signature: near-zero on the left, full-strength colour noise on the right. |

In every case, upstream's diff panel is visibly split down the tile boundary
(black on the left, bright on the right); this fork's fixed diff panel is
uniformly black.

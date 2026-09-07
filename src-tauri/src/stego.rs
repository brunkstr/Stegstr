// DWT (Haar 2D) steganography: payload = magic + 4-byte length (big-endian) + data.
// Embeds in LSB of LH (detail) coefficients.
// Phase 1.1: Tile-based redundant embedding for crop survival.

use image::codecs::png::PngEncoder;
use image::ExtendedColorType;
use image::ImageDecoder;
use image::ImageEncoder;
use image::ImageReader;
use image::metadata::Orientation;
use std::io::{Cursor, Write};

const MAGIC: &[u8] = b"STEGSTR";
const MAGIC_LEN: usize = 7;
const LENGTH_BYTES: usize = 4;
const TILE_SIZE: u32 = 256;
const DECODE_STEP: u32 = 128;

fn load_image_with_orientation(image_path: &std::path::Path) -> Result<image::RgbaImage, String> {
    // `with_guessed_format` sniffs the actual magic bytes rather than trusting
    // the file extension `ImageReader::open` alone would use -- without it, a
    // genuine PNG stego image saved (or renamed) with a `.jpg` extension fails
    // here with a misleading "illegal start bytes" JPEG-parse error instead of
    // decoding correctly, contradicting decode_any()'s documented contract
    // that the caller doesn't need to know which encoder produced an image.
    // The QIM/JPEG path doesn't have this problem: it already sniffs the SOI
    // marker directly (see bug #3's fix) rather than trusting the extension.
    let reader = ImageReader::open(image_path)
        .map_err(|e| e.to_string())?
        .with_guessed_format()
        .map_err(|e| e.to_string())?;
    let mut decoder = reader.into_decoder().map_err(|e| e.to_string())?;
    let orientation = decoder.orientation().unwrap_or(Orientation::NoTransforms);
    let mut img = image::DynamicImage::from_decoder(decoder).map_err(|e| e.to_string())?;
    img.apply_orientation(orientation);
    Ok(img.to_rgba8())
}

/// Crop image to even dimensions for DWT (required for Haar 2x2).
fn ensure_even_dimensions(img: &image::RgbaImage) -> image::RgbaImage {
    let w = img.width();
    let h = img.height();
    let w_even = if w.is_multiple_of(2) { w } else { w.saturating_sub(1) };
    let h_even = if h.is_multiple_of(2) { h } else { h.saturating_sub(1) };
    if w_even == w && h_even == h {
        img.clone()
    } else {
        image::imageops::crop_imm(img, 0, 0, w_even.max(2), h_even.max(2)).to_image()
    }
}

// Haar 2x2 DWT: block [a,b; c,d] -> LL=(a+b+c+d)/4, LH=(b+d-a-c)/4, HL=(c+d-a-b)/4, HH=(b+c-a-d)/4
fn haar2d_forward(
    img: &[u8],
    w: u32,
    h: u32,
    ch: usize,
) -> (Vec<i32>, Vec<i32>, Vec<i32>, Vec<i32>) {
    let half_w = (w / 2) as usize;
    let half_h = (h / 2) as usize;
    let stride = (w * 4) as usize;
    let mut ll = vec![0i32; half_w * half_h];
    let mut lh = vec![0i32; half_w * half_h];
    let mut hl = vec![0i32; half_w * half_h];
    let mut hh = vec![0i32; half_w * half_h];
    for i in 0..half_h {
        for j in 0..half_w {
            let a = img[(i * 2) * stride + (j * 2) * 4 + ch] as i32;
            let b = img[(i * 2) * stride + (j * 2 + 1) * 4 + ch] as i32;
            let c = img[(i * 2 + 1) * stride + (j * 2) * 4 + ch] as i32;
            let d = img[(i * 2 + 1) * stride + (j * 2 + 1) * 4 + ch] as i32;
            let idx = i * half_w + j;
            ll[idx] = (a + b + c + d) / 4;
            lh[idx] = (b + d - a - c) / 4;
            hl[idx] = (c + d - a - b) / 4;
            hh[idx] = (b + c - a - d) / 4;
        }
    }
    (ll, lh, hl, hh)
}

#[allow(clippy::too_many_arguments)]
fn haar2d_inverse(
    out: &mut [u8],
    w: u32,
    h: u32,
    ch: usize,
    ll: &[i32],
    lh: &[i32],
    hl: &[i32],
    hh: &[i32],
) {
    let half_w = (w / 2) as usize;
    let half_h = (h / 2) as usize;
    let stride = (w * 4) as usize;
    for i in 0..half_h {
        for j in 0..half_w {
            let idx = i * half_w + j;
            let ll_ij = ll[idx];
            let lh_ij = lh[idx];
            let hl_ij = hl[idx];
            let hh_ij = hh[idx];
            let a = (ll_ij - lh_ij - hl_ij - hh_ij).clamp(0, 255);
            let b = (ll_ij + lh_ij - hl_ij + hh_ij).clamp(0, 255);
            let c = (ll_ij - lh_ij + hl_ij + hh_ij).clamp(0, 255);
            let d = (ll_ij + lh_ij + hl_ij - hh_ij).clamp(0, 255);
            out[(i * 2) * stride + (j * 2) * 4 + ch] = a as u8;
            out[(i * 2) * stride + (j * 2 + 1) * 4 + ch] = b as u8;
            out[(i * 2 + 1) * stride + (j * 2) * 4 + ch] = c as u8;
            out[(i * 2 + 1) * stride + (j * 2 + 1) * 4 + ch] = d as u8;
        }
    }
}

fn bits_to_bytes(b: &[bool]) -> Vec<u8> {
    b.chunks(8)
        .map(|c| {
            let mut byte = 0u8;
            for (i, &bit) in c.iter().enumerate() {
                if bit {
                    byte |= 1 << (7 - i);
                }
            }
            byte
        })
        .collect()
}

/// Inclusive range of lh values that reconstruct all four pixels of a block to
/// within [0, 255] (no clamping in `haar2d_inverse`). `lh_min > lh_max` means
/// no lh value at all avoids clamping for this block.
fn lh_bounds(ll: i32, hl: i32, hh: i32) -> (i32, i32) {
    let lh_min = (ll - hl - hh - 255)
        .max(hl - ll - hh)
        .max(ll + hl + hh - 255)
        .max(hh - ll - hl);
    let lh_max = (ll - hl - hh)
        .min(255 - ll + hl - hh)
        .min(ll + hl + hh)
        .min(255 - ll - hl + hh);
    (lh_min, lh_max)
}

/// Is there an integer lh with the given LSB parity inside `lh_bounds`?
/// Depends only on (ll, hl, hh) -- never on the block's actual/natural lh --
/// so encoder and decoder always agree on the answer for any block neither
/// side has distorted, letting decode replicate encode's slot allocation with
/// no side channel.
fn feasible_for_bit(bit: i32, ll: i32, hl: i32, hh: i32) -> bool {
    let (lh_min, lh_max) = lh_bounds(ll, hl, hh);
    if lh_min > lh_max {
        return false;
    }
    let mut lh = lh_min;
    if (lh & 1) != bit {
        lh += 1;
    }
    lh <= lh_max
}

/// A block can only safely carry a payload bit if BOTH possible bit values are
/// individually representable there without clamping -- otherwise the specific
/// bit this block ends up needing depends on payload content, which decode has
/// no way to know in advance. `embed_in_tile`/`decode_from_tile` both skip any
/// block where this is false, in the same deterministic block order, so the
/// two sides never disagree about which blocks carry data.
fn both_bits_feasible(ll: i32, hl: i32, hh: i32) -> bool {
    feasible_for_bit(0, ll, hl, hh) && feasible_for_bit(1, ll, hl, hh)
}

/// For a block NOT carrying a payload bit, still choose an lh inside
/// `lh_bounds` (closest to the natural value) whenever one exists, instead of
/// leaving lh untouched.
///
/// This matters even though no payload data lives here: if the block's own
/// natural lh happens to fall outside `lh_bounds` too, `haar2d_inverse` would
/// clamp it anyway, and that clamp shifts the (ll, hl, hh) decode recomputes
/// for this block away from what encode saw. `both_bits_feasible` depends on
/// exactly those values, so encode and decode would then disagree about
/// whether this block was skipped or used -- corrupting every bit that comes
/// after it once the two sides' slot sequences fall out of sync (BUGS.md #3).
/// A block where `lh_bounds` is empty (`lh_min > lh_max`, no lh at all avoids
/// clamping) is the one residual case this can't fix; that's a strictly
/// smaller, unavoidable-under-any-choice condition.
fn safe_lh_for_unused_block(orig_lh: i32, ll: i32, hl: i32, hh: i32) -> i32 {
    let (lh_min, lh_max) = lh_bounds(ll, hl, hh);
    if lh_min > lh_max {
        return orig_lh;
    }
    orig_lh.clamp(lh_min, lh_max)
}

/// Choose the lh (LH coefficient) value closest to `orig_lh` that (a) has the
/// requested LSB parity and (b) reconstructs all four pixels in a block to
/// within [0, 255] with NO clamping in `haar2d_inverse`.
///
/// Forward-then-inverse on this Haar2D pair is algebraically exact (the /4
/// truncation in `haar2d_forward` divides evenly back out) as long as the
/// reconstructed a/b/c/d never need clamping -- clamping is the only lossy
/// step. `(orig_lh & !1) | bit` (the previous, unguarded choice) only ever
/// moves lh by at most 1 from its natural value, but that's enough to push a
/// reconstructed pixel out of [0,255] whenever the true pixel was already
/// within 1 of 0 or 255 -- common on high-contrast/random image data. When
/// that happens the clamp silently changes the pixel, which flips the
/// recovered LSB back on decode and corrupts the payload with no error ever
/// surfacing. Searching outward in steps of 2 (the smallest step that
/// preserves parity) finds a nearby lh that reconstructs cleanly instead.
fn pick_safe_lh(orig_lh: i32, bit: i32, ll: i32, hl: i32, hh: i32) -> i32 {
    let in_range = |lh: i32| -> bool {
        let a = ll - lh - hl - hh;
        let b = ll + lh - hl + hh;
        let c = ll - lh + hl + hh;
        let d = ll + lh + hl - hh;
        (0..=255).contains(&a) && (0..=255).contains(&b) && (0..=255).contains(&c) && (0..=255).contains(&d)
    };
    let base = (orig_lh & !1) | bit;
    if in_range(base) {
        return base;
    }
    for step in 1..=64 {
        let up = base + step * 2;
        if in_range(up) {
            return up;
        }
        let down = base - step * 2;
        if in_range(down) {
            return down;
        }
    }
    base
}

/// Embed payload into a single tile (raw RGBA). Tile must be even dimensions.
///
/// Skips any block where `both_bits_feasible` is false (see that function):
/// forcing a bit there would need `haar2d_inverse` to clamp, which silently
/// flips the LSB back on decode (BUGS.md #3). `decode_from_tile` below skips
/// the exact same blocks, computed the same way, so the two sides never
/// disagree about which blocks carry data despite no side channel between
/// them -- which also means EVERY block, not just ones that ran out of
/// payload bits, must get a clamp-free lh (`safe_lh_for_unused_block`): a
/// clamp on any block, used or not, drifts that block's (ll, hl, hh) and can
/// flip its `both_bits_feasible` classification out from under decode.
fn embed_in_tile(raw: &[u8], tw: u32, th: u32, to_embed: &[u8]) -> Result<Vec<u8>, String> {
    let bits_needed = to_embed.len() * 8;
    let half_w = (tw / 2) as usize;
    let half_h = (th / 2) as usize;
    let blocks_per_channel = half_w * half_h;
    let total_bits_available = blocks_per_channel * 3;
    if bits_needed > total_bits_available {
        return Err(format!(
            "Tile too small: need {} bits, have {} (upper bound)",
            bits_needed, total_bits_available
        ));
    }
    let mut out_raw = raw.to_vec();
    let mut bit_cursor = 0usize;
    for ch in 0..3 {
        let (ll, lh, hl, hh) = haar2d_forward(&out_raw, tw, th, ch);
        let mut lh_mod = lh.clone();
        for block_idx in 0..blocks_per_channel {
            let (ll_b, hl_b, hh_b) = (ll[block_idx], hl[block_idx], hh[block_idx]);
            if bit_cursor < bits_needed && both_bits_feasible(ll_b, hl_b, hh_b) {
                let byte_idx = bit_cursor / 8;
                let bit_in_byte = 7 - (bit_cursor % 8);
                let bit = (to_embed[byte_idx] >> bit_in_byte) & 1;
                lh_mod[block_idx] = pick_safe_lh(lh[block_idx], bit as i32, ll_b, hl_b, hh_b);
                bit_cursor += 1;
            } else {
                lh_mod[block_idx] = safe_lh_for_unused_block(lh[block_idx], ll_b, hl_b, hh_b);
            }
        }
        haar2d_inverse(&mut out_raw, tw, th, ch, &ll, &lh_mod, &hl, &hh);
    }
    if bit_cursor < bits_needed {
        return Err(format!(
            "Tile too small: need {} bits, only {} usable slots (some blocks skipped as unsafe to modify)",
            bits_needed, bit_cursor
        ));
    }
    Ok(out_raw)
}

/// Decode payload from a single tile (raw RGBA).
fn decode_from_tile(raw: &[u8], tw: u32, th: u32) -> Result<Vec<u8>, String> {
    if tw < 2 || th < 2 {
        return Err("Tile too small".to_string());
    }
    let half_w = (tw / 2) as usize;
    let half_h = (th / 2) as usize;
    let blocks_per_channel = half_w * half_h;
    let mut bits = Vec::with_capacity(blocks_per_channel * 3);
    for ch in 0..3 {
        let (ll, lh, hl, hh) = haar2d_forward(raw, tw, th, ch);
        for block_idx in 0..blocks_per_channel {
            if !both_bits_feasible(ll[block_idx], hl[block_idx], hh[block_idx]) {
                continue;
            }
            bits.push((lh[block_idx] & 1) != 0);
        }
    }
    if bits.len() < 88 {
        return Err("Tile too small".to_string());
    }
    for start in 0..bits.len().saturating_sub(88) {
        let slice = &bits[start..start + MAGIC_LEN * 8];
        let bytes = bits_to_bytes(slice);
        if bytes == MAGIC {
            let len_slice = &bits[start + MAGIC_LEN * 8..start + (MAGIC_LEN + LENGTH_BYTES) * 8];
            let len_bytes = bits_to_bytes(len_slice);
            let payload_len = u32::from_be_bytes([
                len_bytes[0], len_bytes[1], len_bytes[2], len_bytes[3],
            ]) as usize;
            let payload_end = start + (MAGIC_LEN + LENGTH_BYTES) * 8 + payload_len * 8;
            if payload_end > bits.len() {
                continue;
            }
            let payload_bits =
                &bits[start + (MAGIC_LEN + LENGTH_BYTES) * 8..payload_end];
            return Ok(bits_to_bytes(payload_bits));
        }
    }
    Err("Magic not found in tile".to_string())
}

/// Encode payload into image using DWT (Haar 2D). Embeds in LH coefficient LSB.
/// Uses tile-based redundancy: embeds full payload in each 256x256 tile for crop survival.
/// Returns PNG bytes. Image is auto-cropped to even dimensions if needed.
pub fn encode(image_path: &std::path::Path, payload: &[u8]) -> Result<Vec<u8>, String> {
    let img_rgba = load_image_with_orientation(image_path)?;
    let img_rgba = ensure_even_dimensions(&img_rgba);
    let (w, h) = (img_rgba.width(), img_rgba.height());
    if w < 2 || h < 2 {
        return Err("Image must be at least 2x2 after cropping to even dimensions".to_string());
    }
    let raw = img_rgba.as_raw();

    let mut to_embed = Vec::with_capacity(MAGIC_LEN + LENGTH_BYTES + payload.len());
    to_embed.write_all(MAGIC).map_err(|e| e.to_string())?;
    let len = payload.len() as u32;
    to_embed.write_all(&len.to_be_bytes()).map_err(|e| e.to_string())?;
    to_embed.write_all(payload).map_err(|e| e.to_string())?;
    let bits_needed = to_embed.len() * 8;

    let mut out_img = raw.to_vec();
    let mut embedded_any = false;

    for ty in (0..h).step_by(TILE_SIZE as usize) {
        for tx in (0..w).step_by(TILE_SIZE as usize) {
            let tw = (TILE_SIZE).min(w - tx);
            let th = (TILE_SIZE).min(h - ty);
            let tw_even = if tw % 2 == 0 { tw } else { tw - 1 };
            let th_even = if th % 2 == 0 { th } else { th - 1 };
            if tw_even < 2 || th_even < 2 {
                continue;
            }
            let capacity = ((tw_even / 2) * (th_even / 2) * 3) as usize;
            if capacity < bits_needed {
                continue;
            }
            let mut tile = Vec::with_capacity((tw_even * th_even * 4) as usize);
            for y in 0..th_even {
                // BUG (fixed): this was missing `+ tx * 4`, so every tile read
                // pixel data starting at column 0 regardless of its own x
                // position. For any image wider than one tile (> TILE_SIZE),
                // every tile except the leftmost column got embedded with a
                // COPY of column-0 pixel data, then written back at its own
                // (correct) output position -- silently overwriting that whole
                // region with unrelated content. The payload still decoded
                // correctly (decode finds it in the untouched tile at tx=0),
                // which is exactly why this was invisible to every
                // payload-correctness round-trip test and only showed up in a
                // cover-vs-stego pixel comparison (PSNR ~9dB, not the ~30-65dB
                // expected -- essentially the whole non-leftmost image visibly
                // wrecked, not steganographically hidden at all).
                let row_start = ((ty + y) * w * 4 + tx * 4) as usize;
                let row_end = row_start + (tw_even * 4) as usize;
                tile.extend_from_slice(&raw[row_start..row_end]);
            }
            if let Ok(modified) = embed_in_tile(&tile, tw_even, th_even, &to_embed) {
                for (y, row) in modified.chunks((tw_even * 4) as usize).enumerate() {
                    let out_row_start = ((ty + y as u32) * w * 4 + tx * 4) as usize;
                    out_img[out_row_start..out_row_start + row.len()].copy_from_slice(row);
                }
                embedded_any = true;
            }
        }
    }

    if !embedded_any {
        let half_w = (w / 2) as usize;
        let half_h = (h / 2) as usize;
        let total_bits_available = half_w * half_h * 3;
        if bits_needed > total_bits_available {
            return Err(format!(
                "Payload too large: need {} bits, image has {} (no tile had capacity)",
                bits_needed, total_bits_available
            ));
        }
        out_img = embed_in_tile(raw, w, h, &to_embed)?;
    }

    let mut out = Cursor::new(Vec::new());
    let encoder = PngEncoder::new(&mut out);
    encoder
        .write_image(&out_img, w, h, ExtendedColorType::Rgba8)
        .map_err(|e: image::ImageError| e.to_string())?;
    Ok(out.into_inner())
}

/// Decode payload from DWT-embedded image.
/// Tries tile-grid-aligned windows first (matches how `encode()` actually tiles
/// images >= TILE_SIZE into independent 256x256 Haar2D transforms), then falls
/// back to a whole-image transform for images smaller than one tile or for the
/// rare case where `encode()` itself fell back to a whole-image transform
/// because no single tile had capacity for the payload.
///
/// BUG (fixed): this used to try the whole-image transform first. For a large
/// enough image, a whole-image Haar2D transform indexes LH coefficients by the
/// image's full width, not each tile's own 256-wide local grid the encoder used.
/// The two orderings only agree for the first 128 bits (one tile-local row), so
/// once a payload's header+data spans more than one row (roughly 9+ payload
/// bytes) the whole-image bit sequence silently diverges from what was
/// actually embedded. `decode_from_tile`'s magic search has no integrity check
/// beyond "declared length fits available bits", so it returned a magic-shaped
/// but corrupted match instead of ever reaching the tile-aligned search below,
/// which does reproduce the exact per-tile transform and always decodes
/// correctly for any un-cropped, large-enough image.
pub fn decode(image_path: &std::path::Path) -> Result<Vec<u8>, String> {
    let img_rgba = load_image_with_orientation(image_path)?;
    let img_rgba = ensure_even_dimensions(&img_rgba);
    let (w, h) = (img_rgba.width(), img_rgba.height());
    if w < 2 || h < 2 {
        return Err("Image too small or dimensions not even".to_string());
    }
    let raw = img_rgba.as_raw();

    // `||`, not `&&`: encode() tiles each axis independently (its loop steps
    // by TILE_SIZE on x and y separately), so a "wide but short" or "narrow
    // but tall" image -- only ONE dimension >= TILE_SIZE -- still gets tiled
    // along that one axis (e.g. a 258x8 image becomes a 256x8 tile at x=0 plus
    // a near-empty 2x8 remainder). Requiring BOTH dimensions >= TILE_SIZE here
    // skipped the tile-aligned search entirely for that shape and fell through
    // to the whole-image interpretation, which is wrong whenever the image was
    // actually tiled (bug: found by the prop_roundtrip_random_cover_and_payload
    // proptest, minimal case w=258 h=8).
    if w >= TILE_SIZE || h >= TILE_SIZE {
        for oy in (0..=h.saturating_sub(TILE_SIZE)).step_by(DECODE_STEP as usize) {
            for ox in (0..=w.saturating_sub(TILE_SIZE)).step_by(DECODE_STEP as usize) {
                let tw = TILE_SIZE.min(w - ox);
                let th = TILE_SIZE.min(h - oy);
                let tw_even = if tw % 2 == 0 { tw } else { tw - 1 };
                let th_even = if th % 2 == 0 { th } else { th - 1 };
                if tw_even < 2 || th_even < 2 {
                    continue;
                }
                let mut tile = Vec::with_capacity((tw_even * th_even * 4) as usize);
                for y in 0..th_even {
                    let row_start = ((oy + y) * w * 4 + ox * 4) as usize;
                    tile.extend_from_slice(&raw[row_start..row_start + (tw_even * 4) as usize]);
                }
                if let Ok(payload) = decode_from_tile(&tile, tw_even, th_even) {
                    return Ok(payload);
                }
            }
        }
    }

    if let Ok(payload) = decode_from_tile(raw, w, h) {
        return Ok(payload);
    }

    Err("Not a Stegstr image (magic not found)".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use proptest::prelude::*;

    #[test]
    fn test_encode_decode_roundtrip() {
        let mut img = image::RgbaImage::new(256, 256);
        for (i, p) in img.pixels_mut().enumerate() {
            let v = (i % 256) as u8;
            *p = image::Rgba([v, v.wrapping_add(1), v.wrapping_add(2), 255]);
        }
        let mut png_bytes = Vec::new();
        let encoder = PngEncoder::new(&mut png_bytes);
        encoder
            .write_image(img.as_raw(), 256, 256, ExtendedColorType::Rgba8)
            .unwrap();
        let cover_path = std::env::temp_dir().join("stego_test_cover.png");
        std::fs::write(&cover_path, &png_bytes).unwrap();

        let payload = b"Hello, Stegstr!";
        let encoded = encode(&cover_path, payload).unwrap();
        let out_path = std::env::temp_dir().join("stego_test_out.png");
        std::fs::write(&out_path, &encoded).unwrap();

        let decoded = decode(&out_path).unwrap();
        assert_eq!(decoded, payload);

        let _ = std::fs::remove_file(cover_path);
        let _ = std::fs::remove_file(out_path);
    }

    /// Regression test for the extension-vs-content mismatch found during
    /// the post-Phase-4 regression sweep: `decode()` must sniff the actual
    /// file content, not trust the extension, exactly like the QIM/JPEG path
    /// already does via its SOI-marker check (bug #3). Before the fix,
    /// `ImageReader::open` picked a JPEG decoder for a `.jpg`-named path
    /// regardless of its real (PNG) content, failing with a misleading
    /// "illegal start bytes" error instead of decoding correctly.
    #[test]
    fn test_decode_ignores_misleading_extension() {
        let mut img = image::RgbaImage::new(256, 256);
        for (i, p) in img.pixels_mut().enumerate() {
            let v = (i % 256) as u8;
            *p = image::Rgba([v, v.wrapping_add(1), v.wrapping_add(2), 255]);
        }
        let mut png_bytes = Vec::new();
        let encoder = PngEncoder::new(&mut png_bytes);
        encoder
            .write_image(img.as_raw(), 256, 256, ExtendedColorType::Rgba8)
            .unwrap();
        let cover_path = std::env::temp_dir().join("stego_test_ext_cover.png");
        std::fs::write(&cover_path, &png_bytes).unwrap();

        let payload = b"extension should not matter";
        let encoded = encode(&cover_path, payload).unwrap();
        // Genuine PNG bytes, deliberately saved with a misleading .jpg name.
        let out_path = std::env::temp_dir().join("stego_test_ext_out.jpg");
        std::fs::write(&out_path, &encoded).unwrap();

        let decoded = decode(&out_path).unwrap();
        assert_eq!(decoded, payload);

        let _ = std::fs::remove_file(cover_path);
        let _ = std::fs::remove_file(out_path);
    }

    /// Regression test for BUGS.md #1: a multi-tile image (> 256x256, so
    /// `encode()` embeds via its per-256x256-tile loop) with a payload long
    /// enough to span more than one tile-local coefficient row (> ~9 payload
    /// bytes) used to decode as silently corrupted garbage, because `decode()`
    /// tried a whole-image transform (wrong bit ordering for a tiled image)
    /// before the tile-aligned search that actually matches the encoder.
    #[test]
    fn test_encode_decode_roundtrip_multi_tile_long_payload() {
        let (w, h) = (512u32, 512u32);
        let mut img = image::RgbaImage::new(w, h);
        for (i, p) in img.pixels_mut().enumerate() {
            let v = (i % 256) as u8;
            *p = image::Rgba([v, v.wrapping_add(7), v.wrapping_add(13), 255]);
        }
        let mut png_bytes = Vec::new();
        let encoder = PngEncoder::new(&mut png_bytes);
        encoder
            .write_image(img.as_raw(), w, h, ExtendedColorType::Rgba8)
            .unwrap();
        let cover_path = std::env::temp_dir().join("stego_test_multitile_cover.png");
        std::fs::write(&cover_path, &png_bytes).unwrap();

        // 100 bytes: well past the ~9-byte single-row threshold that triggered
        // the whole-image/tile-local ordering mismatch.
        let payload = vec![b'A'; 100];
        let encoded = encode(&cover_path, &payload).unwrap();
        let out_path = std::env::temp_dir().join("stego_test_multitile_out.png");
        std::fs::write(&out_path, &encoded).unwrap();

        let decoded = decode(&out_path).unwrap();
        assert_eq!(decoded, payload);

        let _ = std::fs::remove_file(cover_path);
        let _ = std::fs::remove_file(out_path);
    }

    /// Regression test for BUGS.md #3: high-contrast / random-noise cover
    /// images -- ordinary, common inputs -- used to decode with scattered
    /// single-byte corruption. Root cause: `embed_in_tile` picked an LH value
    /// with the right LSB parity but no regard for whether the pixels it would
    /// reconstruct to stay in [0,255]; a pixel already at (or within 1 of) 0 or
    /// 255 pushed the reconstruction out of range, `haar2d_inverse` silently
    /// clamped it, and decode's forward transform then read back the wrong LSB.
    /// A uniform-random-noise cover deliberately maximizes how many blocks sit
    /// at that boundary.
    #[test]
    fn test_encode_decode_roundtrip_high_contrast_cover() {
        let (w, h) = (256u32, 256u32);
        let mut img = image::RgbaImage::new(w, h);
        // Deterministic xorshift so this test has no external RNG dependency.
        let mut state: u32 = 0x2545F491;
        let mut next = || {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            state
        };
        for p in img.pixels_mut() {
            let r = next();
            *p = image::Rgba([
                (r & 0xFF) as u8,
                ((r >> 8) & 0xFF) as u8,
                ((r >> 16) & 0xFF) as u8,
                255,
            ]);
        }
        let mut png_bytes = Vec::new();
        let encoder = PngEncoder::new(&mut png_bytes);
        encoder
            .write_image(img.as_raw(), w, h, ExtendedColorType::Rgba8)
            .unwrap();
        let cover_path = std::env::temp_dir().join("stego_test_contrast_cover.png");
        std::fs::write(&cover_path, &png_bytes).unwrap();

        let payload = ("The quick brown fox jumps over the lazy dog. ".repeat(5)).into_bytes();
        let encoded = encode(&cover_path, &payload).unwrap();
        let out_path = std::env::temp_dir().join("stego_test_contrast_out.png");
        std::fs::write(&out_path, &encoded).unwrap();

        let decoded = decode(&out_path).unwrap();
        assert_eq!(decoded, payload);

        let _ = std::fs::remove_file(cover_path);
        let _ = std::fs::remove_file(out_path);
    }

    /// Regression test for BUGS.md #5: `encode()`'s tile-extraction loop was
    /// missing `+ tx * 4` in its row offset, so every tile except the leftmost
    /// column read (and then embedded-and-overwrote) column-0 pixel data
    /// instead of its own. Payload correctness round-trip tests never caught
    /// this -- decode finds the payload in the untouched tx=0 tile and returns
    /// immediately -- so this test checks image FIDELITY, not just payload
    /// recovery: every tile outside the leftmost column must stay close to its
    /// original pixels (small LSB-only deltas), not get replaced wholesale.
    #[test]
    fn test_encode_does_not_corrupt_non_leftmost_tiles() {
        let (w, h) = (512u32, 256u32); // two tiles wide, one tall
        let mut img = image::RgbaImage::new(w, h);
        for (i, p) in img.pixels_mut().enumerate() {
            let v = (i % 256) as u8;
            *p = image::Rgba([v, v.wrapping_add(7), v.wrapping_add(13), 255]);
        }
        let mut png_bytes = Vec::new();
        PngEncoder::new(&mut png_bytes)
            .write_image(img.as_raw(), w, h, ExtendedColorType::Rgba8)
            .unwrap();
        let cover_path = std::env::temp_dir().join("stego_test_tile_fidelity_cover.png");
        std::fs::write(&cover_path, &png_bytes).unwrap();

        let payload = b"tile fidelity check";
        let encoded = encode(&cover_path, payload).unwrap();
        let out_path = std::env::temp_dir().join("stego_test_tile_fidelity_out.png");
        std::fs::write(&out_path, &encoded).unwrap();

        let stego_img = image::open(&out_path).unwrap().to_rgba8();
        let cover_raw = img.as_raw();
        let stego_raw = stego_img.as_raw();
        let stride = (w * 4) as usize;

        // The right tile (columns 256..512) must be close to its original
        // pixels (LSB-scale changes only), not overwritten with the left
        // tile's content.
        let mut max_delta = 0i32;
        for y in 0..h as usize {
            for x in 256..w as usize {
                for ch in 0..4 {
                    let idx = y * stride + x * 4 + ch;
                    let delta = (cover_raw[idx] as i32 - stego_raw[idx] as i32).abs();
                    max_delta = max_delta.max(delta);
                }
            }
        }
        assert!(
            max_delta <= 4,
            "right tile changed by up to {max_delta} (expected small LSB-scale deltas only -- \
             a large delta means the tile-extraction offset bug is back"
        );

        let decoded = decode(&out_path).unwrap();
        assert_eq!(decoded, payload);

        let _ = std::fs::remove_file(cover_path);
        let _ = std::fs::remove_file(out_path);
    }

    proptest::proptest! {
        #![proptest_config(proptest::prelude::ProptestConfig::with_cases(40))]

        /// Property: for any random-noise cover (single-tile and multi-tile
        /// sizes) and any payload that fits, encode-then-decode always returns
        /// the exact original bytes. This is the property bugs #1-#3 in
        /// BUGS.md all violated for ordinary inputs; each fix here is a
        /// counterexample this test would have failed on before it landed.
        #[test]
        fn prop_roundtrip_random_cover_and_payload(
            w in 8u32..320,
            h in 8u32..320,
            seed in any::<u64>(),
            payload in proptest::collection::vec(any::<u8>(), 0..600),
        ) {
            let w = w - (w % 2); // encode() requires even dimensions
            let h = h - (h % 2);
            if w < 2 || h < 2 {
                return Ok(());
            }
            let mut state = seed | 1;
            let mut next = move || {
                state ^= state << 13;
                state ^= state >> 17;
                state ^= state << 5;
                state
            };
            let mut img = image::RgbaImage::new(w, h);
            for p in img.pixels_mut() {
                let r = next();
                *p = image::Rgba([(r & 0xFF) as u8, ((r >> 8) & 0xFF) as u8, ((r >> 16) & 0xFF) as u8, 255]);
            }
            let mut png_bytes = Vec::new();
            PngEncoder::new(&mut png_bytes)
                .write_image(img.as_raw(), w, h, ExtendedColorType::Rgba8)
                .unwrap();
            let unique = format!("{:x}_{:x}_{:x}_{}", w, h, seed, payload.len());
            let cover_path = std::env::temp_dir().join(format!("stego_prop_cover_{unique}.png"));
            std::fs::write(&cover_path, &png_bytes).unwrap();

            let result = encode(&cover_path, &payload);
            if let Ok(encoded) = result {
                let out_path = std::env::temp_dir().join(format!("stego_prop_out_{unique}.png"));
                std::fs::write(&out_path, &encoded).unwrap();
                let decoded = decode(&out_path).unwrap();
                prop_assert_eq!(decoded, payload);
                let _ = std::fs::remove_file(out_path);
            }
            // Err(_) is fine -- it just means this random cover/payload
            // combination didn't fit; capacity errors are covered elsewhere.

            let _ = std::fs::remove_file(cover_path);
        }
    }
}

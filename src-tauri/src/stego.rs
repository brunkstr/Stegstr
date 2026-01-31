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
    let reader = ImageReader::open(image_path).map_err(|e| e.to_string())?;
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
    let w_even = if w % 2 == 0 { w } else { w.saturating_sub(1) };
    let h_even = if h % 2 == 0 { h } else { h.saturating_sub(1) };
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
            let a = img[(i * 2 + 0) * stride + (j * 2 + 0) * 4 + ch] as i32;
            let b = img[(i * 2 + 0) * stride + (j * 2 + 1) * 4 + ch] as i32;
            let c = img[(i * 2 + 1) * stride + (j * 2 + 0) * 4 + ch] as i32;
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
            out[(i * 2 + 0) * stride + (j * 2 + 0) * 4 + ch] = a as u8;
            out[(i * 2 + 0) * stride + (j * 2 + 1) * 4 + ch] = b as u8;
            out[(i * 2 + 1) * stride + (j * 2 + 0) * 4 + ch] = c as u8;
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

/// Embed payload into a single tile (raw RGBA). Tile must be even dimensions.
fn embed_in_tile(raw: &[u8], tw: u32, th: u32, to_embed: &[u8]) -> Result<Vec<u8>, String> {
    let bits_needed = to_embed.len() * 8;
    let half_w = (tw / 2) as usize;
    let half_h = (th / 2) as usize;
    let blocks_per_channel = half_w * half_h;
    let bits_per_channel = blocks_per_channel;
    let total_bits_available = blocks_per_channel * 3;
    if bits_needed > total_bits_available {
        return Err(format!(
            "Tile too small: need {} bits, have {}",
            bits_needed, total_bits_available
        ));
    }
    let mut out_raw = raw.to_vec();
    for ch in 0..3 {
        let (ll, lh, hl, hh) = haar2d_forward(&out_raw, tw, th, ch);
        let mut lh_mod = lh;
        for block_idx in 0..blocks_per_channel {
            let global_idx = ch * bits_per_channel + block_idx;
            if global_idx >= bits_needed {
                break;
            }
            let byte_idx = global_idx / 8;
            let bit_in_byte = 7 - (global_idx % 8);
            let bit = (to_embed[byte_idx] >> bit_in_byte) & 1;
            lh_mod[block_idx] = (lh_mod[block_idx] & !1) | (bit as i32);
        }
        haar2d_inverse(&mut out_raw, tw, th, ch, &ll, &lh_mod, &hl, &hh);
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
    let total_bits = blocks_per_channel * 3;
    if total_bits < 88 {
        return Err("Tile too small".to_string());
    }
    let mut bits = Vec::with_capacity(total_bits);
    for ch in 0..3 {
        let (_, lh, _, _) = haar2d_forward(raw, tw, th, ch);
        for block_idx in 0..blocks_per_channel {
            bits.push((lh[block_idx] & 1) != 0);
        }
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
                let row_start = ((ty + y) * w * 4) as usize;
                let row_end = row_start + (tw_even * 4) as usize;
                tile.extend_from_slice(&raw[row_start..row_end]);
            }
            match embed_in_tile(&tile, tw_even, th_even, &to_embed) {
                Ok(modified) => {
                    for (y, row) in modified.chunks((tw_even * 4) as usize).enumerate() {
                        let out_row_start = ((ty + y as u32) * w * 4 + tx * 4) as usize;
                        out_img[out_row_start..out_row_start + row.len()].copy_from_slice(row);
                    }
                    embedded_any = true;
                }
                Err(_) => {}
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
/// Tries full-image decode first (backward compat), then sliding 256x256 window for crop survival.
pub fn decode(image_path: &std::path::Path) -> Result<Vec<u8>, String> {
    let img_rgba = load_image_with_orientation(image_path)?;
    let img_rgba = ensure_even_dimensions(&img_rgba);
    let (w, h) = (img_rgba.width(), img_rgba.height());
    if w < 2 || h < 2 {
        return Err("Image too small or dimensions not even".to_string());
    }
    let raw = img_rgba.as_raw();

    if let Ok(payload) = decode_from_tile(raw, w, h) {
        return Ok(payload);
    }

    if w >= TILE_SIZE && h >= TILE_SIZE {
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

    Err("Not a Stegstr image (magic not found)".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

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

}

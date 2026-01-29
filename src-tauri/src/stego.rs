// LSB steganography for PNG: payload = magic + 4-byte length (big-endian) + data

use image::codecs::png::PngEncoder;
use image::ExtendedColorType;
use image::ImageEncoder;
use image::ImageDecoder;
use image::ImageReader;
use image::metadata::Orientation;
use std::io::{Cursor, Write};

const MAGIC: &[u8] = b"STEGSTR";
const MAGIC_LEN: usize = 7;
const LENGTH_BYTES: usize = 4;

fn load_image_with_orientation(image_path: &std::path::Path) -> Result<image::RgbaImage, String> {
    let reader = ImageReader::open(image_path).map_err(|e| e.to_string())?;
    let mut decoder = reader.into_decoder().map_err(|e| e.to_string())?;
    let orientation = decoder.orientation().unwrap_or(Orientation::NoTransforms);
    let mut img = image::DynamicImage::from_decoder(decoder).map_err(|e| e.to_string())?;
    img.apply_orientation(orientation);
    Ok(img.to_rgba8())
}

/// Encode payload into image LSB (1 bit per channel, 3 bits per pixel).
/// Returns PNG bytes. Applies EXIF orientation so output is upright.
pub fn encode_lsb(image_path: &std::path::Path, payload: &[u8]) -> Result<Vec<u8>, String> {
    let img_rgba = load_image_with_orientation(image_path)?;
    let (w, h) = (img_rgba.width(), img_rgba.height());
    let mut img_rgba = img_rgba;

    let mut to_embed = Vec::with_capacity(MAGIC_LEN + LENGTH_BYTES + payload.len());
    to_embed.write_all(MAGIC).map_err(|e| e.to_string())?;
    let len = payload.len() as u32;
    to_embed.write_all(&len.to_be_bytes()).map_err(|e| e.to_string())?;
    to_embed.write_all(payload).map_err(|e| e.to_string())?;

    let bits_needed = to_embed.len() * 8;
    let pixels_needed = (bits_needed + 2) / 3; // 3 bits per pixel
    let total_pixels = (w as u64 * h as u64) as usize;
    if pixels_needed > total_pixels {
        return Err(format!(
            "Payload too large: need {} pixels, image has {}",
            pixels_needed, total_pixels
        ));
    }

    let mut bit_idx = 0usize;
    for pixel in img_rgba.pixels_mut() {
        if bit_idx >= bits_needed {
            break;
        }
        for ch in 0..3 {
            if bit_idx >= bits_needed {
                break;
            }
            let byte_idx = bit_idx / 8;
            let bit_in_byte = 7 - (bit_idx % 8);
            let bit = (to_embed[byte_idx] >> bit_in_byte) & 1;
            pixel[ch] = (pixel[ch] & 0xFE) | bit;
            bit_idx += 1;
        }
    }

    let mut out = Cursor::new(Vec::new());
    let encoder = PngEncoder::new(&mut out);
    encoder
        .write_image(img_rgba.as_raw(), w, h, ExtendedColorType::Rgba8)
        .map_err(|e: image::ImageError| e.to_string())?;
    Ok(out.into_inner())
}

/// Decode payload from image LSB. Returns payload bytes or error.
/// Applies EXIF orientation before reading LSB so magic is found in correct pixel order.
pub fn decode_lsb(image_path: &std::path::Path) -> Result<Vec<u8>, String> {
    let img_rgba = load_image_with_orientation(image_path)?;

    let mut bits = Vec::new();
    for pixel in img_rgba.pixels() {
        for ch in 0..3 {
            bits.push((pixel[ch] & 1) != 0);
        }
    }

    // Need at least magic + length = 7 + 4 = 11 bytes = 88 bits
    if bits.len() < 88 {
        return Err("Image too small or no stego data".to_string());
    }

    let bits_to_bytes = |b: &[bool]| -> Vec<u8> {
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
    };

    // Find magic
    for start in 0..bits.len().saturating_sub(88) {
        let slice = &bits[start..start + MAGIC_LEN * 8];
        let bytes = bits_to_bytes(slice);
        if bytes == MAGIC {
            let len_slice = &bits[start + MAGIC_LEN * 8..start + (MAGIC_LEN + LENGTH_BYTES) * 8];
            let len_bytes = bits_to_bytes(len_slice);
            let payload_len = u32::from_be_bytes([len_bytes[0], len_bytes[1], len_bytes[2], len_bytes[3]]) as usize;
            let payload_end = start + (MAGIC_LEN + LENGTH_BYTES) * 8 + payload_len * 8;
            if payload_end > bits.len() {
                continue;
            }
            let payload_bits = &bits[start + (MAGIC_LEN + LENGTH_BYTES) * 8..payload_end];
            return Ok(bits_to_bytes(payload_bits));
        }
    }
    Err("Not a Stegstr image (magic not found)".to_string())
}

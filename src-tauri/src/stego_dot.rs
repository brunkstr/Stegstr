// Dot-offset steganography (robust to platform transforms).
// Payload format: MAGIC + 4-byte big-endian length + payload bytes.

use image::codecs::png::PngEncoder;
use image::metadata::Orientation;
use image::{ExtendedColorType, ImageDecoder, ImageEncoder, ImageReader, RgbImage};
use std::io::Cursor;

const MAGIC: &[u8] = b"STEGSTR";
const MAGIC_LEN: usize = 7;
const LENGTH_BYTES: usize = 4;

const STEP: u32 = 6;
const OFFSET: u32 = 2;
const REPEAT: usize = 3;
const SHUFFLE_SEED: u32 = 42;

fn load_image_with_orientation(path: &std::path::Path) -> Result<RgbImage, String> {
    let reader = ImageReader::open(path).map_err(|e| e.to_string())?;
    let mut decoder = reader.into_decoder().map_err(|e| e.to_string())?;
    let orientation = decoder.orientation().unwrap_or(Orientation::NoTransforms);
    let mut img = image::DynamicImage::from_decoder(decoder).map_err(|e| e.to_string())?;
    img.apply_orientation(orientation);
    Ok(img.to_rgb8())
}

fn bytes_to_bits(data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len() * 8);
    for b in data {
        for i in (0..8).rev() {
            out.push((b >> i) & 1);
        }
    }
    out
}

fn bits_to_bytes(bits: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity((bits.len() + 7) / 8);
    for chunk in bits.chunks(8) {
        let mut byte = 0u8;
        for (i, &bit) in chunk.iter().enumerate() {
            byte |= (bit & 1) << (7 - i);
        }
        out.push(byte);
    }
    out
}

fn wrap_payload(payload: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(MAGIC_LEN + LENGTH_BYTES + payload.len());
    out.extend_from_slice(MAGIC);
    let len = payload.len() as u32;
    out.extend_from_slice(&len.to_be_bytes());
    out.extend_from_slice(payload);
    out
}

fn unwrap_payload(raw: &[u8]) -> Result<Vec<u8>, String> {
    if raw.len() < MAGIC_LEN + LENGTH_BYTES {
        return Err("Payload too short".to_string());
    }
    if &raw[..MAGIC_LEN] != MAGIC {
        return Err("Magic not found".to_string());
    }
    let len = u32::from_be_bytes([
        raw[MAGIC_LEN],
        raw[MAGIC_LEN + 1],
        raw[MAGIC_LEN + 2],
        raw[MAGIC_LEN + 3],
    ]) as usize;
    if raw.len() < MAGIC_LEN + LENGTH_BYTES + len {
        return Err("Payload length mismatch".to_string());
    }
    Ok(raw[MAGIC_LEN + LENGTH_BYTES..MAGIC_LEN + LENGTH_BYTES + len].to_vec())
}

fn cell_positions(width: u32, height: u32) -> Vec<(u32, u32)> {
    let mut out = Vec::new();
    if width < OFFSET + 2 || height < OFFSET + 2 {
        return out;
    }
    let max_x = width - 2;
    let max_y = height - 2;
    let mut y = OFFSET;
    while y <= max_y {
        let mut x = OFFSET;
        while x <= max_x {
            out.push((x, y));
            x += STEP;
        }
        y += STEP;
    }
    out
}

fn shuffle_positions(mut positions: Vec<(u32, u32)>) -> Vec<(u32, u32)> {
    if positions.len() <= 1 {
        return positions;
    }
    let mut seed = SHUFFLE_SEED;
    let mut i = positions.len() - 1;
    while i > 0 {
        seed = seed.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
        let j = (seed as usize) % (i + 1);
        positions.swap(i, j);
        i -= 1;
    }
    positions
}

fn max_payload_bytes_for_image(img: &RgbImage) -> usize {
    let (w, h) = img.dimensions();
    let positions = cell_positions(w, h);
    let capacity_bits = (positions.len() * 2) / REPEAT;
    let overhead_bytes = 2 + MAGIC_LEN + LENGTH_BYTES;
    let capacity_bytes = capacity_bits / 8;
    capacity_bytes.saturating_sub(overhead_bytes)
}

fn encode_offset(img: &mut RgbImage, bits: &[u8]) -> Result<(), String> {
    let (w, h) = img.dimensions();
    let positions = shuffle_positions(cell_positions(w, h));
    let capacity_bits = (positions.len() * 2) / REPEAT;
    if bits.len() > capacity_bits {
        return Err(format!(
            "Image too small: need {} bits, have {}",
            bits.len(),
            capacity_bits
        ));
    }
    let offsets = [(0u32, 0u32), (0, 1), (1, 0), (1, 1)];
    let symbols: Vec<[u8; 2]> = bits
        .chunks(2)
        .map(|c| [*c.get(0).unwrap_or(&0), *c.get(1).unwrap_or(&0)])
        .collect();
    let needed_cells = symbols.len() * REPEAT;
    if positions.len() < needed_cells {
        return Err(format!(
            "Image too small: need {} cells, have {}",
            needed_cells,
            positions.len()
        ));
    }
    for (si, sym) in symbols.iter().enumerate() {
        let idx = ((sym[0] & 1) << 1) | (sym[1] & 1);
        let (bx, by) = offsets[idx as usize];
        for r in 0..REPEAT {
            let (x, y) = positions[si * REPEAT + r];
            for (ox, oy) in offsets {
                img.put_pixel(x + ox, y + oy, image::Rgb([255, 255, 255]));
            }
            img.put_pixel(x + bx, y + by, image::Rgb([0, 0, 0]));
        }
    }
    Ok(())
}

fn decode_offset(img: &RgbImage) -> Result<Vec<u8>, String> {
    let (w, h) = img.dimensions();
    let positions = shuffle_positions(cell_positions(w, h));
    if positions.is_empty() {
        return Err("Image too small for dot decode".to_string());
    }
    let offsets = [(0u32, 0u32), (0, 1), (1, 0), (1, 1)];
    let mut symbols: Vec<u8> = Vec::with_capacity(positions.len());
    for (x, y) in positions {
        let mut min_idx = 0usize;
        let mut min_val: u32 = u32::MAX;
        for (i, (ox, oy)) in offsets.iter().enumerate() {
            let p = img.get_pixel(x + ox, y + oy);
            let v = p[0] as u32 + p[1] as u32 + p[2] as u32;
            if v < min_val {
                min_val = v;
                min_idx = i;
            }
        }
        symbols.push(min_idx as u8);
    }
    let mut bits: Vec<u8> = Vec::with_capacity((symbols.len() / REPEAT) * 2);
    let groups = symbols.len() / REPEAT;
    for gi in 0..groups {
        let mut counts = [0u8; 4];
        for r in 0..REPEAT {
            let idx = symbols[gi * REPEAT + r] as usize;
            if idx < 4 {
                counts[idx] += 1;
            }
        }
        let mut max_idx = 0usize;
        let mut max_count = 0u8;
        for (i, &c) in counts.iter().enumerate() {
            if c > max_count {
                max_count = c;
                max_idx = i;
            }
        }
        bits.push(((max_idx >> 1) & 1) as u8);
        bits.push((max_idx & 1) as u8);
    }
    if bits.len() < 16 {
        return Err("Insufficient bits".to_string());
    }
    let codeword_len = {
        let header = bits_to_bytes(&bits[..16]);
        if header.len() < 2 {
            return Err("Invalid header".to_string());
        }
        u16::from_be_bytes([header[0], header[1]]) as usize
    };
    let total_bits = (2 + codeword_len) * 8;
    if bits.len() < total_bits {
        return Err("Insufficient payload bits".to_string());
    }
    let raw = bits_to_bytes(&bits[..total_bits]);
    if raw.len() < 2 + codeword_len {
        return Err("Payload decode failed".to_string());
    }
    let payload_raw = &raw[2..2 + codeword_len];
    unwrap_payload(payload_raw)
}

pub fn encode(image_path: &std::path::Path, payload: &[u8]) -> Result<Vec<u8>, String> {
    let mut img = load_image_with_orientation(image_path)?;
    let wrapped = wrap_payload(payload);
    let mut to_embed = Vec::with_capacity(2 + wrapped.len());
    let codeword_len = wrapped.len();
    if codeword_len > u16::MAX as usize {
        return Err("Payload too large for dot method".to_string());
    }
    to_embed.extend_from_slice(&(codeword_len as u16).to_be_bytes());
    to_embed.extend_from_slice(&wrapped);
    let bits = bytes_to_bits(&to_embed);
    encode_offset(&mut img, &bits)?;

    let mut buf = Cursor::new(Vec::new());
    let encoder = PngEncoder::new(&mut buf);
    encoder
        .write_image(img.as_raw(), img.width(), img.height(), ExtendedColorType::Rgb8)
        .map_err(|e| e.to_string())?;
    let out = buf.into_inner();
    // Sanity: ensure PNG signature
    if out.len() < 8 || out[..8] != [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] {
        return Err("Dot encoder produced non-PNG output".to_string());
    }
    Ok(out)
}

pub fn decode(image_path: &std::path::Path) -> Result<Vec<u8>, String> {
    let img = load_image_with_orientation(image_path)?;
    decode_offset(&img)
}

pub fn max_payload_bytes(image_path: &std::path::Path) -> Result<usize, String> {
    let img = load_image_with_orientation(image_path)?;
    Ok(max_payload_bytes_for_image(&img))
}

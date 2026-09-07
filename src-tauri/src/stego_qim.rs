//! Robust JPEG-domain steganography (QIM: Quantization Index Modulation).
//!
//! Port of the algorithm validated empirically in `channel_simulator/dct_variants.py`
//! (encode_dct_qim / decode_dct_qim) against a simulated WhatsApp / Instagram /
//! Telegram / Facebook / Twitter channel (resize + JPEG recompression + metadata
//! strip): 100% payload-recovery rate across every platform and cover-image type
//! tested at the "max" width preset. See channel_simulator/BASELINE_RESULTS.md and
//! run_matrix_realistic.py for the methodology and numbers behind these constants.
//!
//! WHY THIS EXISTS: the original DWT (Haar 2D) encoder in `stego.rs` embeds in
//! spatial-domain LSBs and is documented (BASELINE_RESULTS.md) to NOT survive any
//! of the above platforms -- they all re-encode images as JPEG, which recomputes
//! every pixel from scratch and wipes spatial-domain LSBs. This module embeds
//! directly in JPEG DCT coefficients instead, which is the domain those platforms'
//! own re-compression operates in, and adds redundancy + error correction so the
//! payload survives being re-quantized at a different JPEG quality.
//!
//! KEY DESIGN POINTS carried over from the validated Python prototype (see comments
//! inline in dct_variants.py for the empirical reasoning behind each):
//!   - Coefficient-domain (position-based) embedding cannot survive an actual pixel
//!     resize -- resampling recomputes every 8x8 block from scratch. So embed always
//!     pre-resizes the cover to a width safe for every platform we care about (never
//!     guesses a single destination platform), guaranteeing every downstream resize
//!     is a no-op.
//!   - Redundancy copies of a bit MUST land in spatially decorrelated coefficients.
//!     Naive consecutive repetition puts all copies in the same 8x8 block, so a
//!     block that quantizes badly (e.g. a flat/low-energy region) makes every copy
//!     wrong the same way -- majority voting over correlated failures does nothing.
//!     This uses a single fixed pseudorandom permutation of all coefficient
//!     positions (same seed on encode and decode) so redundant copies scatter
//!     across the whole image regardless of payload size.
//!
//! VERIFICATION STATUS: the algorithm above (QIM math, bit packing, permutation,
//! Reed-Solomon chunking) is plain, deterministic Rust with no external unknowns.
//! The one part written against documentation rather than a local compiler is the
//! `ffi` submodule (libjpeg DCT coefficient read/write via mozjpeg-sys, following
//! the standard jpegtran.c coefficient-copy pattern). Build with
//! `cargo build --release --bin stegstr-cli` and run
//! `stegstr-cli embed --robust ...` / `stegstr-cli decode ...` to confirm; if the
//! FFI section fails to compile, the error will be localized to `ffi::read_y_coefficients`
//! / `ffi::write_y_coefficients` and is very likely a small signature mismatch
//! against the exact mozjpeg-sys version resolved by Cargo, not a logic error.

use std::path::Path;

// ---------------------------------------------------------------------------
// Shared constants (mirror dct_stego.py / dct_variants.py)
// ---------------------------------------------------------------------------

const MAGIC: &[u8] = b"STEGSTR";
const MAGIC_LEN: usize = 7;
const LENGTH_BYTES: usize = 4;

/// Standard JPEG zigzag order: zigzag position -> (row, col) in an 8x8 block.
const ZIGZAG_2D: [(usize, usize); 64] = [
    (0, 0), (0, 1), (1, 0), (2, 0), (1, 1), (0, 2), (0, 3), (1, 2), (2, 1), (3, 0),
    (4, 0), (3, 1), (2, 2), (1, 3), (0, 4), (0, 5), (1, 4), (2, 3), (3, 2), (4, 1),
    (5, 0), (6, 0), (5, 1), (4, 2), (3, 3), (2, 4), (1, 5), (0, 6), (0, 7), (1, 6),
    (2, 5), (3, 4), (4, 3), (5, 2), (6, 1), (7, 0), (7, 1), (6, 2), (5, 3), (4, 4),
    (3, 5), (2, 6), (1, 7), (2, 7), (3, 6), (4, 5), (5, 4), (6, 3), (7, 2), (7, 3),
    (6, 4), (5, 5), (4, 6), (3, 7), (4, 7), (5, 6), (6, 5), (7, 4), (7, 5), (6, 6),
    (5, 7), (6, 7), (7, 6), (7, 7),
];
/// Mid-frequency AC zigzag indices used for embedding (skip DC at 0).
const AC_COUNT: usize = 24;

/// Re-tuned after adding PSNR measurement to the validation (the original 32
/// was chosen from bit-error-rate alone, without ever checking visual impact --
/// it scored only ~26dB PSNR against the same-pipeline no-embed baseline, which
/// is genuinely visible, not just "technically imperfect"). 14 is the exact
/// floor for full 45/45 robustness across all 9 cover types x 5 platforms; 16
/// keeps a small margin above that floor at ~32dB PSNR, a real quality
/// improvement with no robustness cost. See channel_simulator/sweep_delta.py
/// for the original BER-only sweep. Kept as the default/"busy" tier and the
/// fixed header delta below -- see DELTA TIERS for the flat-cover addition.
const QIM_DELTA_DEFAULT: f64 = 16.0;

// ---------------------------------------------------------------------------
// DELTA TIERS (Phase 4: per-cover adaptive strength)
//
// The known weak point (BASELINE_RESULTS.md): flat/featureless covers score
// only ~0.70 SSIM at the uniform delta=16, because a fixed quantization step
// is a much bigger relative perturbation on a cover with little natural AC
// energy to hide it in than on a busy one.
//
// PER-8x8-BLOCK adaptive delta (as literally described in the brief) is not
// safely decodable: QIM's detection (`qim_detect_with_margin`) requires the
// EXACT delta used at embed time for that coefficient -- decode has no way to
// independently re-derive "how flat was this block originally" from
// coefficients that have since been modified by our own embedding and, for
// real use, requantized by a platform's JPEG re-encode. A wrong-delta read
// isn't degraded, it's close to random noise for that coefficient. Per-block
// adaptivity would need either a large explicit side-channel (a delta-tier
// bit per block, plausibly thousands of blocks -- more overhead than most
// real payloads) or a resync mechanism trusted enough to bet payload
// integrity on; neither was pursued here given the time available.
//
// What ships instead: PER-COVER (whole-image) adaptive delta, chosen once at
// encode time from the cover's average AC coefficient magnitude and written
// into the header (see QIM_HEADER_BITS) so decode reads it directly rather
// than re-deriving it. This is a coarser granularity than the brief's
// literal per-block description, but it directly targets the measured
// problem (flat *covers*, not flat *regions inside* covers) with a change
// decode can always resolve exactly right.
//
// Calibration went through two passes, both worth being honest about:
//
// Pass 1 (Python prototype, channel_simulator/sweep_delta_per_cover.py, 9
// covers x 9 delta values x 5 simulated platforms) suggested delta=10 was
// safe -- every cover but `highfreq` survived all 5 platforms down to
// delta=8. Shipping that value against the REAL Rust binary (this module,
// with its 24-bit tier+length header, vs the Python prototype's plain
// 16-bit length header -- a different header size shifts which physical
// coefficients the permutation assigns to the body) broke 7/45 on the
// simulated Telegram channel specifically. Root-caused by testing the
// actual shipped binary end-to-end (channel_simulator/run_matrix_rust_cli.py)
// rather than trusting the Python proxy's numbers to transfer directly.
//
// Pass 2 re-swept delta against the real binary: 10 broke 7/45 (all
// Telegram), 12 was clean (45/45) with one residual failure on a much
// harder synthetic corpus (a literal solid-color image, 0.0 avg AC
// magnitude, on the harshest platform -- see below), 14 was WORSE again
// (6/45 broke, still all Telegram) than both 12 and 16. That non-monotonic
// pattern -- 14 failing where both 12 and 16 succeed -- means this isn't a
// smooth noise-margin tradeoff; some specific delta values interact badly
// with a specific platform's JPEG requantization step size in a way that
// isn't simply "smaller delta = more risk." QIM_DELTA_FLAT=12 is the
// empirically-clean value from actually testing the shipped binary, not a
// value derived from theory.
//
// Also corrected: the threshold below is compared against
// `average_ac_magnitude`, which only averages the 24 MID-FREQUENCY
// positions actually used for embedding -- not all 63 AC positions. An
// earlier Python-side calibration pass measured the wrong quantity (all 63)
// and produced numbers that looked like a 10x safety margin; recalibrated
// against the actual metric this code computes: `highfreq` (busy,
// deliberately adversarial) = 3.96, `narrow_tall` = 1.39, `textured` = 0.97,
// everything else in the test corpus <= 0.53. QIM_FLATNESS_THRESHOLD=1.0
// sits in the real (narrower than first thought, ~0.97-1.39) gap between
// `textured` and `narrow_tall` -- both tested clean at their respective
// tiers, but this margin is tighter than the numbers originally written
// here claimed, and a cover landing very close to 1.0 is the most likely
// place a future misclassification would show up.
//
// KNOWN RESIDUAL LIMITATION: a cover with essentially zero AC energy (a
// literal solid color, not just "flat" -- e.g. pure_solid_white.png,
// avg AC magnitude 0.0) failed to survive the harshest simulated platform
// (WhatsApp, quality=65) even at delta=12; only 1 of 125 total
// cover x platform x payload combinations tested. No real photo is ever
// truly zero-variance (sensor noise alone prevents it), so this is treated
// as a documented gap rather than chased further -- see
// channel_simulator/BASELINE_RESULTS.md for the full tradeoff table and
// this specific failure.
const QIM_DELTA_FLAT: f64 = 12.0;
/// Average |AC coefficient magnitude| (mid-frequency zigzag positions 1-24,
/// DC excluded) below which a cover is classified "flat" and gets
/// QIM_DELTA_FLAT instead of QIM_DELTA_DEFAULT.
const QIM_FLATNESS_THRESHOLD: f64 = 1.0;
/// Tier byte values written into the header's first byte (see QIM_HEADER_BITS).
const QIM_TIER_DEFAULT: u8 = 0;
const QIM_TIER_FLAT: u8 = 1;

fn delta_for_tier(tier: u8) -> f64 {
    if tier == QIM_TIER_FLAT {
        QIM_DELTA_FLAT
    } else {
        QIM_DELTA_DEFAULT
    }
}

const QIM_RS_NSYM: usize = 128;
const QIM_REPEAT: usize = 5;
const QIM_EMBED_QUALITY: u8 = 80;
/// Header layout: 1 tier byte + u16 codeword-length prefix (up to 65535
/// bytes). The header itself is ALWAYS embedded/read at QIM_HEADER_DELTA --
/// fixed, not adaptive -- since decode must be able to read the tier byte
/// before it can know which delta the rest of the payload used.
const QIM_HEADER_BITS: usize = 24;
/// Pre-Phase-4 header layout: just the u16 codeword-length prefix, no tier
/// byte (that version always used a single QIM_DELTA=16 for everything).
/// `decode()` tries the current 24-bit format first, then falls back to this
/// one, so images embedded by this crate's own earlier builds still decode
/// instead of failing (or, before that fallback existed, panicking -- see
/// BUGS.md's header-compatibility entry for how this was actually found).
const QIM_LEGACY_HEADER_BITS: usize = 16;
const QIM_HEADER_DELTA: f64 = QIM_DELTA_DEFAULT;
const QIM_HEADER_REPEAT: usize = 9; // extra margin: losing the header loses the whole payload
const QIM_PERM_SEED: u64 = 20231115;

fn erasure_margin_for(delta: f64) -> f64 {
    delta / 6.0
}

/// Universal pre-resize width presets. Coefficient-domain embedding cannot survive
/// an actual resize (see module docs), so embed always shrinks the cover to a width
/// no platform in the target set will touch -- never resize based on a guessed
/// destination, since forwarding through a second platform or guessing wrong
/// defeats it entirely.
#[derive(Default)]
pub enum Robustness {
    /// Safe for WhatsApp (800), Instagram (1080), Telegram (1280) -- the three
    /// platforms the spec requires surviving. Higher resolution output.
    Standard,
    /// Also safe for Twitter/X-style aggressive downscaling (600). Empirically
    /// 100% pass rate across every platform x cover-type combination tested.
    /// Default: safer with only a modest resolution cost.
    #[default]
    Max,
}

impl Robustness {
    fn max_width(&self) -> u32 {
        match self {
            Robustness::Standard => 768,
            Robustness::Max => 576,
        }
    }
}

// ---------------------------------------------------------------------------
// Bit packing
// ---------------------------------------------------------------------------

fn to_bits(data: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(data.len() * 8);
    for &b in data {
        for i in (0..8).rev() {
            out.push((b >> i) & 1);
        }
    }
    out
}

fn from_bits(bits: &[u8]) -> Vec<u8> {
    let mut out = Vec::with_capacity(bits.len() / 8);
    for chunk in bits.chunks(8) {
        if chunk.len() < 8 {
            break;
        }
        let mut byte = 0u8;
        for &bit in chunk {
            byte = (byte << 1) | (bit & 1);
        }
        out.push(byte);
    }
    out
}

/// Concatenate `repeat` full copies of `bits`. Combined with the fixed
/// permutation below, each copy lands in a spatially distant part of the image.
fn interleave_repeat(bits: &[u8], repeat: usize) -> Vec<u8> {
    if repeat <= 1 {
        return bits.to_vec();
    }
    let mut out = Vec::with_capacity(bits.len() * repeat);
    for _ in 0..repeat {
        out.extend_from_slice(bits);
    }
    out
}

/// Inverse of interleave_repeat: `bits`/`margins` is `repeat` concatenated passes
/// of length n; majority-vote per position across passes.
fn deinterleave_majority(bits: &[u8], margins: &[f64], repeat: usize) -> (Vec<u8>, Vec<f64>) {
    if repeat <= 1 {
        return (bits.to_vec(), margins.to_vec());
    }
    let n = bits.len() / repeat;
    let mut out_bits = Vec::with_capacity(n);
    let mut out_margins = Vec::with_capacity(n);
    for i in 0..n {
        let mut ones = 0usize;
        let mut min_margin = f64::INFINITY;
        for p in 0..repeat {
            if bits[i + p * n] == 1 {
                ones += 1;
            }
            min_margin = min_margin.min(margins[i + p * n]);
        }
        out_bits.push(if ones > repeat / 2 { 1 } else { 0 });
        out_margins.push(min_margin);
    }
    (out_bits, out_margins)
}

// ---------------------------------------------------------------------------
// Fixed pseudorandom permutation (spatial decorrelation)
// ---------------------------------------------------------------------------

/// splitmix64: small, fully-specified, dependency-free PRNG. Deliberately NOT
/// using the `rand` crate here: its internal algorithm can change across major
/// versions, which would silently break decode compatibility for images embedded
/// by an older encoder build. This format only ever needs to agree with itself.
fn splitmix64_next(state: &mut u64) -> u64 {
    *state = state.wrapping_add(0x9E3779B97F4A7C15);
    let mut z = *state;
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58476D1CE4E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D049BB133111EB);
    z ^ (z >> 31)
}

/// A single deterministic pseudorandom shuffle of every coefficient position in
/// the image, seeded identically on encode and decode. Consecutive slices of a
/// true random permutation are scattered across the WHOLE image regardless of
/// how small the payload is relative to total capacity -- this is what actually
/// spatially decorrelates the `repeat` copies of each bit (see module docs).
fn fixed_permutation(n: usize) -> Vec<u32> {
    let mut perm: Vec<u32> = (0..n as u32).collect();
    let mut state = QIM_PERM_SEED;
    // Fisher-Yates
    for i in (1..n).rev() {
        let r = splitmix64_next(&mut state);
        let j = (r % (i as u64 + 1)) as usize;
        perm.swap(i, j);
    }
    perm
}

// ---------------------------------------------------------------------------
// QIM embed/detect
// ---------------------------------------------------------------------------

fn qim_embed(x: f64, bit: u8, delta: f64) -> i32 {
    let cell = (x / delta).round() * delta;
    let offset = if bit == 1 { delta / 4.0 } else { -delta / 4.0 };
    (cell + offset).round() as i32
}

fn qim_detect_with_margin(z: f64, delta: f64) -> (u8, f64) {
    let cell = (z / delta).round() * delta;
    let r0 = cell - delta / 4.0;
    let r1 = cell + delta / 4.0;
    let d0 = (z - r0).abs();
    let d1 = (z - r1).abs();
    let bit = if d0 <= d1 { 0 } else { 1 };
    (bit, (d0 - d1).abs())
}

// ---------------------------------------------------------------------------
// Reed-Solomon (GF(256), 255-byte blocks) with manual chunking, matching how
// Python's `reedsolo` auto-chunks messages longer than one RS block.
// ---------------------------------------------------------------------------

mod rs {
    use reed_solomon::{Decoder, Encoder};

    const BLOCK: usize = 255;

    pub fn encode(data: &[u8], nsym: usize) -> Vec<u8> {
        let enc = Encoder::new(nsym);
        let data_per_chunk = BLOCK - nsym;
        let mut out = Vec::with_capacity(data.len() + data.len() / data_per_chunk.max(1) * nsym + nsym);
        if data.is_empty() {
            let encoded = enc.encode(&[]);
            out.extend_from_slice(&encoded);
            return out;
        }
        for chunk in data.chunks(data_per_chunk) {
            let encoded = enc.encode(chunk);
            out.extend_from_slice(&encoded);
        }
        out
    }

    /// `erasure_positions` are byte offsets into the (post-encode) codeword.
    ///
    /// BUG (fixed): `reed_solomon::Decoder::correct` does not itself validate
    /// that its input buffer is at least `nsym` bytes long -- for a chunk
    /// shorter than `nsym` (reachable from a corrupted or mismatched header
    /// producing a bogus `codeword_len`, not just adversarial input) it
    /// panics via an internal usize underflow
    /// (`reed-solomon-0.2.1/src/buffer.rs`: computing `chunk.len() - nsym`
    /// wraps around to near `usize::MAX`, then a slice bound built from that
    /// panics). Confirmed via cross-version compatibility testing: decoding
    /// a QIM image embedded by this crate's own pre-Phase-4 build (16-bit
    /// header) with the current (24-bit header) decoder produced exactly
    /// this crash, not a clean decode failure. `decode_any` (lib.rs) runs
    /// this path against every image passed to it regardless of source, so
    /// any sufficiently malformed input reaching here -- not just an old
    /// file format -- could crash the whole process. Guarded here instead
    /// of trusting the header's declared length is internally consistent.
    pub fn decode(codeword: &[u8], nsym: usize, erasure_positions: &[usize]) -> Result<Vec<u8>, String> {
        let dec = Decoder::new(nsym);
        let mut out = Vec::with_capacity(codeword.len());
        for (chunk_idx, chunk) in codeword.chunks(BLOCK).enumerate() {
            if chunk.len() <= nsym {
                return Err(format!(
                    "RS chunk too short to decode: {} bytes, need > {} (nsym)",
                    chunk.len(),
                    nsym
                ));
            }
            let base = chunk_idx * BLOCK;
            let local_erasures: Vec<u8> = erasure_positions
                .iter()
                .filter(|&&p| p >= base && p < base + chunk.len())
                .map(|&p| (p - base) as u8)
                .collect();
            let buf = chunk.to_vec();
            let erasures_opt = if local_erasures.is_empty() { None } else { Some(&local_erasures[..]) };
            let recovered = dec
                .correct(&buf, erasures_opt)
                .map_err(|e| format!("RS decode failed: {:?}", e))?;
            out.extend_from_slice(recovered.data());
        }
        Ok(out)
    }
}

// ---------------------------------------------------------------------------
// Payload framing: MAGIC + u32 length + payload -> RS codeword -> u16 codeword
// length header. Mirrors dct_stego.py's _wrap_payload / _unwrap_payload.
// ---------------------------------------------------------------------------

fn wrap_payload(payload: &[u8]) -> Vec<u8> {
    let mut raw = Vec::with_capacity(MAGIC_LEN + LENGTH_BYTES + payload.len());
    raw.extend_from_slice(MAGIC);
    raw.extend_from_slice(&(payload.len() as u32).to_be_bytes());
    raw.extend_from_slice(payload);
    rs::encode(&raw, QIM_RS_NSYM)
}

fn unwrap_payload(codeword: &[u8], erasures: &[usize]) -> Option<Vec<u8>> {
    // Erasure marking is a heuristic (bytes near a QIM decision boundary) and
    // can over-trigger on content with large low-AC-energy regions (flat
    // colors, screenshots): more bytes can get declared "erased" than the RS
    // codeword can correct even though the real bit-error rate is low enough
    // for plain blind correction to succeed on its own. Retry without erasure
    // hints rather than giving up outright.
    let decoded = rs::decode(codeword, QIM_RS_NSYM, erasures)
        .or_else(|_| rs::decode(codeword, QIM_RS_NSYM, &[]))
        .ok()?;
    if decoded.len() < MAGIC_LEN + LENGTH_BYTES || &decoded[..MAGIC_LEN] != MAGIC {
        return None;
    }
    let plen = u32::from_be_bytes(decoded[MAGIC_LEN..MAGIC_LEN + LENGTH_BYTES].try_into().ok()?) as usize;
    let start = MAGIC_LEN + LENGTH_BYTES;
    let end = start.checked_add(plen)?;
    decoded.get(start..end).map(|s| s.to_vec())
}

// ---------------------------------------------------------------------------
// Coefficient stream: (block_row, block_col, ac_zigzag_index) for every 8x8
// luma block, mid-frequency AC positions only. Same order used by encode/decode.
// ---------------------------------------------------------------------------

fn coeff_stream(blocks_wide: usize, blocks_high: usize) -> Vec<(usize, usize, usize)> {
    let mut out = Vec::with_capacity(blocks_wide * blocks_high * AC_COUNT);
    for by in 0..blocks_high {
        for bx in 0..blocks_wide {
            for zi in 0..AC_COUNT {
                out.push((by, bx, zi));
            }
        }
    }
    out
}

fn zigzag_rc(zi_offset_by_one: usize) -> (usize, usize) {
    // AC index k (1-based within the 24 mid-frequency positions) maps to
    // zigzag position k (skipping DC at 0), same as Python's AC_INDICES = 1..=24.
    ZIGZAG_2D[zi_offset_by_one + 1]
}

/// Average |AC coefficient magnitude| over the same mid-frequency positions
/// `coeff_stream` addresses, used to classify a cover as "flat" or not (see
/// DELTA TIERS above). Must be called on untouched coefficients -- before
/// any embedding -- since the whole point is to measure the cover's own
/// content, not anything this module is about to write into it.
fn average_ac_magnitude(jpeg: &ffi::YCoefficients, stream: &[(usize, usize, usize)]) -> f64 {
    if stream.is_empty() {
        return 0.0;
    }
    let sum: f64 = stream
        .iter()
        .map(|&(by, bx, zi)| {
            let (dy, dx) = zigzag_rc(zi);
            (jpeg.get(by, bx, dy, dx) as f64).abs()
        })
        .sum();
    sum / stream.len() as f64
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/// Conservative estimate of how many raw payload bytes a cover image can hold
/// after the safety pre-resize, so callers (the UI) can trim an oversized
/// payload before attempting an embed rather than just trying and failing.
/// Slightly under-estimates real capacity (doesn't perfectly model RS chunk
/// boundaries), which is the safe direction to be wrong in here.
pub fn capacity_bytes(cover_path: &Path, robustness: &Robustness) -> Result<usize, String> {
    let img = image::open(cover_path).map_err(|e| e.to_string())?;
    let max_w = robustness.max_width();
    let long_side = img.width().max(img.height());
    let (w, h) = if long_side > max_w {
        let ratio = max_w as f64 / long_side as f64;
        (
            ((img.width() as f64) * ratio).round().max(1.0) as u32,
            ((img.height() as f64) * ratio).round().max(1.0) as u32,
        )
    } else {
        (img.width(), img.height())
    };
    let blocks_wide = (w / 8).max(1) as usize;
    let blocks_high = (h / 8).max(1) as usize;
    let total_coeffs = blocks_wide * blocks_high * AC_COUNT;
    let header_slots = QIM_HEADER_BITS * QIM_HEADER_REPEAT;
    let usable = total_coeffs.saturating_sub(header_slots);
    let codeword_bits_max = usable / QIM_REPEAT;
    let codeword_bytes_max = codeword_bits_max / 8;
    // Reed-Solomon: ~(255-nsym)/255 of each chunk is usable data.
    let rs_data_ratio_num = 255usize.saturating_sub(QIM_RS_NSYM);
    let raw_bytes_max = codeword_bytes_max * rs_data_ratio_num / 255;
    Ok(raw_bytes_max.saturating_sub(MAGIC_LEN + LENGTH_BYTES))
}

/// Embed `payload` into `cover_path` (any image format the `image` crate reads),
/// returning JPEG bytes. See module docs for the robustness rationale.
pub fn encode(cover_path: &Path, payload: &[u8], robustness: Robustness) -> Result<Vec<u8>, String> {
    let img = image::open(cover_path).map_err(|e| e.to_string())?.to_rgb8();
    let max_w = robustness.max_width();
    // Constrain by the LONGER side, matching real platforms (they cap the long
    // edge, not literally the width). A narrow-but-tall cover (e.g. a cropped
    // screenshot) would otherwise sail through this pre-resize unshrunk just
    // because its width alone looked safe, then get resized for real once a
    // platform touches it -- exactly the failure mode this pre-resize exists
    // to prevent.
    let long_side = img.width().max(img.height());
    let img = if long_side > max_w {
        let ratio = max_w as f64 / long_side as f64;
        let new_w = ((img.width() as f64) * ratio).round().max(1.0) as u32;
        let new_h = ((img.height() as f64) * ratio).round().max(1.0) as u32;
        image::imageops::resize(&img, new_w, new_h, image::imageops::FilterType::Lanczos3)
    } else {
        img
    };

    let tmp_in = std::env::temp_dir().join(format!("stegstr_qim_in_{}.jpg", std::process::id()));
    {
        let mut f = std::fs::File::create(&tmp_in).map_err(|e| e.to_string())?;
        let mut enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut f, QIM_EMBED_QUALITY);
        enc.encode(&img, img.width(), img.height(), image::ExtendedColorType::Rgb8)
            .map_err(|e| e.to_string())?;
    }

    let result = (|| -> Result<Vec<u8>, String> {
        let mut jpeg = ffi::read_y_coefficients(&tmp_in)?;
        let stream = coeff_stream(jpeg.blocks_wide, jpeg.blocks_high);

        // Classify BEFORE any embedding touches a single coefficient -- this
        // must reflect the cover's own natural content, not anything we're
        // about to write.
        let tier = if average_ac_magnitude(&jpeg, &stream) < QIM_FLATNESS_THRESHOLD {
            QIM_TIER_FLAT
        } else {
            QIM_TIER_DEFAULT
        };
        let body_delta = delta_for_tier(tier);

        let codeword = wrap_payload(payload);
        let codeword_bits = to_bits(&codeword);
        let mut header_bytes = vec![tier];
        header_bytes.extend_from_slice(&(codeword.len() as u16).to_be_bytes());
        let header_bits = to_bits(&header_bytes);

        let perm = fixed_permutation(stream.len());
        let interleaved_header = interleave_repeat(&header_bits, QIM_HEADER_REPEAT);
        let interleaved_codeword = interleave_repeat(&codeword_bits, QIM_REPEAT);
        let needed = interleaved_header.len() + interleaved_codeword.len();
        if needed > perm.len() {
            return Err(format!(
                "Payload too large: need {} coefficients (header+codeword x redundancy), have {}",
                needed,
                perm.len()
            ));
        }

        let write_bit = |jpeg: &mut ffi::YCoefficients, slot: u32, bit: u8, delta: f64| {
            let (by, bx, zi) = stream[slot as usize];
            let (dy, dx) = zigzag_rc(zi);
            let c = jpeg.get(by, bx, dy, dx) as f64;
            let v = qim_embed(c, bit, delta).clamp(-32767, 32767) as i16;
            jpeg.set(by, bx, dy, dx, v);
        };

        for (i, &bit) in interleaved_header.iter().enumerate() {
            write_bit(&mut jpeg, perm[i], bit, QIM_HEADER_DELTA);
        }
        for (i, &bit) in interleaved_codeword.iter().enumerate() {
            write_bit(&mut jpeg, perm[interleaved_header.len() + i], bit, body_delta);
        }

        let tmp_out = std::env::temp_dir().join(format!("stegstr_qim_out_{}.jpg", std::process::id()));
        ffi::write_y_coefficients(&tmp_in, &jpeg, &tmp_out)?;
        let bytes = std::fs::read(&tmp_out).map_err(|e| e.to_string())?;
        let _ = std::fs::remove_file(&tmp_out);
        Ok(bytes)
    })();

    let _ = std::fs::remove_file(&tmp_in);
    result
}

/// Try decoding assuming a specific header layout. `header_bits` is 24 (this
/// crate's current format: tier byte + u16 length) or `QIM_LEGACY_HEADER_BITS`
/// (16, pre-Phase-4: u16 length only, always `QIM_TIER_DEFAULT`/delta 16).
/// Returns `None` on any failure -- wrong header size read against a given
/// image's actual embedded format produces garbage `codeword_len`/coefficient
/// values, which fail cleanly here (RS correction failure, or a magic
/// mismatch in `unwrap_payload`) rather than a false positive: Reed-Solomon
/// plus an explicit 7-byte magic comparison is a strong enough integrity
/// check that a coincidental match on the wrong interpretation is not a
/// realistic concern (same reasoning `decode_any` already relies on when it
/// tries this QIM decoder against a plain PNG before falling back to DWT).
fn try_decode_with_header_format(
    jpeg: &ffi::YCoefficients,
    stream: &[(usize, usize, usize)],
    perm: &[u32],
    header_bits: usize,
) -> Option<Vec<u8>> {
    let read_bit = |slot: u32, delta: f64| -> (u8, f64) {
        let (by, bx, zi) = stream[slot as usize];
        let (dy, dx) = zigzag_rc(zi);
        let c = jpeg.get(by, bx, dy, dx) as f64;
        qim_detect_with_margin(c, delta)
    };

    // Header is always at the fixed QIM_HEADER_DELTA -- decode has to be
    // able to read the tier byte (which says what delta the BODY used)
    // before it can know any other delta, so the header itself can't be
    // adaptive without a chicken-and-egg problem.
    let n_header_slots = header_bits * QIM_HEADER_REPEAT;
    if n_header_slots > perm.len() {
        return None;
    }
    let mut header_bits_raw = Vec::with_capacity(n_header_slots);
    let mut header_margins_raw = Vec::with_capacity(n_header_slots);
    for &slot in perm.iter().take(n_header_slots) {
        let (bit, margin) = read_bit(slot, QIM_HEADER_DELTA);
        header_bits_raw.push(bit);
        header_margins_raw.push(margin);
    }
    let (header_bits_decoded, _) = deinterleave_majority(&header_bits_raw, &header_margins_raw, QIM_HEADER_REPEAT);
    if header_bits_decoded.len() < header_bits {
        return None;
    }
    let header_bytes = from_bits(&header_bits_decoded[..header_bits]);

    let (tier, codeword_len) = if header_bits == QIM_LEGACY_HEADER_BITS {
        if header_bytes.len() < 2 {
            return None;
        }
        (QIM_TIER_DEFAULT, u16::from_be_bytes([header_bytes[0], header_bytes[1]]) as usize)
    } else {
        if header_bytes.len() < 3 {
            return None;
        }
        (header_bytes[0], u16::from_be_bytes([header_bytes[1], header_bytes[2]]) as usize)
    };
    let body_delta = delta_for_tier(tier);
    let n_codeword_bits = codeword_len * 8;
    let needed = n_header_slots + n_codeword_bits * QIM_REPEAT;
    if codeword_len == 0 || needed > perm.len() {
        return None;
    }

    let mut codeword_bits_raw = Vec::with_capacity(n_codeword_bits * QIM_REPEAT);
    let mut codeword_margins_raw = Vec::with_capacity(n_codeword_bits * QIM_REPEAT);
    for &slot in perm.iter().take(needed).skip(n_header_slots) {
        let (bit, margin) = read_bit(slot, body_delta);
        codeword_bits_raw.push(bit);
        codeword_margins_raw.push(margin);
    }
    let (codeword_bits, bit_margins) = deinterleave_majority(&codeword_bits_raw, &codeword_margins_raw, QIM_REPEAT);
    let codeword = from_bits(&codeword_bits);

    let body_erasure_margin = erasure_margin_for(body_delta);
    let mut erasures = Vec::new();
    for idx in 0..codeword_len {
        let start = idx * 8;
        let end = start + 8;
        if end > bit_margins.len() {
            break;
        }
        let min_margin = bit_margins[start..end].iter().cloned().fold(f64::INFINITY, f64::min);
        if min_margin < body_erasure_margin {
            erasures.push(idx);
        }
    }

    unwrap_payload(&codeword, &erasures)
}

/// Extract a payload previously embedded with [`encode`]. Returns `Ok(None)` (not
/// an error) when the image has no valid QIM payload, so callers can fall back to
/// trying the DWT decoder -- a plain, non-Stegstr JPEG is an expected input, not a
/// failure.
///
/// Tries the current header format first, then the pre-Phase-4 legacy format
/// (see `QIM_LEGACY_HEADER_BITS`) -- images embedded by this crate's own
/// earlier builds still decode instead of failing (or, before this fallback
/// existed, panicking: see BUGS.md's header-compatibility entry).
pub fn decode(path: &Path) -> Result<Option<Vec<u8>>, String> {
    let jpeg = match ffi::read_y_coefficients(path) {
        Ok(j) => j,
        Err(_) => return Ok(None), // not a readable JPEG at all
    };
    let stream = coeff_stream(jpeg.blocks_wide, jpeg.blocks_high);
    let perm = fixed_permutation(stream.len());

    if let Some(payload) = try_decode_with_header_format(&jpeg, &stream, &perm, QIM_HEADER_BITS) {
        return Ok(Some(payload));
    }
    if let Some(payload) = try_decode_with_header_format(&jpeg, &stream, &perm, QIM_LEGACY_HEADER_BITS) {
        return Ok(Some(payload));
    }
    Ok(None)
}

// ---------------------------------------------------------------------------
// libjpeg DCT coefficient FFI. Isolated here so a signature mismatch against the
// resolved mozjpeg-sys version stays localized -- everything above this line is
// plain deterministic Rust with no external unknowns. Follows the standard
// jpegtran.c coefficient-copy pattern (jpeg_read_coefficients ->
// access_virt_barray for in-place mutation of the Y component only ->
// jpeg_copy_critical_parameters -> jpeg_write_coefficients), which preserves
// quantization tables and the Cb/Cr planes byte-for-byte unchanged.
// ---------------------------------------------------------------------------
mod ffi {
    use super::Path;
    use mozjpeg_sys::*;
    use std::ffi::CString;
    use std::os::raw::c_char;

    /// Owned copy of the Y-plane DCT coefficients plus enough layout info to
    /// address (block_row, block_col, coeff_row, coeff_col).
    pub struct YCoefficients {
        pub blocks_wide: usize,
        pub blocks_high: usize,
        data: Vec<[i16; 64]>,
    }

    impl YCoefficients {
        pub fn get(&self, by: usize, bx: usize, dy: usize, dx: usize) -> i16 {
            self.data[by * self.blocks_wide + bx][dy * 8 + dx]
        }
        pub fn set(&mut self, by: usize, bx: usize, dy: usize, dx: usize, v: i16) {
            self.data[by * self.blocks_wide + bx][dy * 8 + dx] = v;
        }
    }

    // libjpeg's JMSG_LENGTH_MAX (a C #define, not exported by bindgen). The
    // compiler's expected-type error against format_message's actual generated
    // signature is ground truth here, not the C header's nominal value.
    const JMSG_LENGTH_MAX: usize = 80;

    unsafe extern "C-unwind" fn error_exit(cinfo: &mut jpeg_common_struct) {
        let buf = [0u8; JMSG_LENGTH_MAX];
        if let Some(fmt) = (*cinfo.err).format_message {
            fmt(cinfo, &buf);
        }
        let end = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
        let msg = String::from_utf8_lossy(&buf[..end]).into_owned();
        panic!("libjpeg error: {}", msg);
    }

    fn path_to_cstring(p: &Path) -> Result<CString, String> {
        CString::new(p.to_string_lossy().as_bytes()).map_err(|e| e.to_string())
    }

    /// Read just the Y-plane coefficients into an owned Rust structure. Does NOT
    /// need to keep the libjpeg session alive afterward (see write_y_coefficients,
    /// which re-opens the same file for the actual in-place-mutation write path).
    pub fn read_y_coefficients(path: &Path) -> Result<YCoefficients, String> {
        // libjpeg reports "this isn't a JPEG" through the same error_exit path
        // (-> panic, see below) as genuinely unexpected internal errors, but
        // "the file the user picked isn't a JPEG" is a routine, expected
        // outcome here -- decode is deliberately tried against arbitrary
        // files (see decode_any in lib.rs). Checking the SOI marker ourselves
        // first avoids ever entering libjpeg -- and printing a scary (if
        // harmless; catch_unwind below does prevent an actual crash) "thread
        // panicked" message -- for the common case of a non-JPEG or empty
        // file, which is not a bug, just normal input.
        let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
        if bytes.len() < 2 || bytes[0] != 0xFF || bytes[1] != 0xD8 {
            return Err("Not a JPEG file".to_string());
        }
        std::panic::catch_unwind(|| read_y_coefficients_inner(path))
            .map_err(|_| "libjpeg error while reading coefficients".to_string())?
    }

    /// RAII guard so `jpeg_destroy_decompress` + `fclose` always run -- including
    /// when `error_exit` (see above) unwinds out of a libjpeg call via panic.
    /// Before this guard existed, a panic partway through `jpeg_read_header` /
    /// jpeg_read_coefficients` (routinely triggered by a truncated or corrupt
    /// JPEG whose first two bytes still happen to be a valid SOI marker -- e.g.
    /// any real photo cut short mid-transfer) skipped both cleanup calls, since
    /// they were only ever reached on the non-panicking path. Each such call
    /// leaked one open `FILE*` and libjpeg's internal per-decompress memory
    /// pool; `decode_any` (lib.rs) tries the QIM/JPEG decoder against *every*
    /// image passed in regardless of extension, so this fired on every
    /// malformed-JPEG decode attempt, not just a rare corner case.
    struct DecompressGuard {
        cinfo: jpeg_decompress_struct,
        fp: *mut std::ffi::c_void,
    }

    impl Drop for DecompressGuard {
        fn drop(&mut self) {
            unsafe {
                jpeg_destroy_decompress(&mut self.cinfo);
                if !self.fp.is_null() {
                    libc_fclose(self.fp);
                }
            }
        }
    }

    fn read_y_coefficients_inner(path: &Path) -> Result<YCoefficients, String> {
        unsafe {
            let mut err: jpeg_error_mgr = std::mem::zeroed();
            jpeg_std_error(&mut err);
            err.error_exit = Some(error_exit);

            let mut cinfo: jpeg_decompress_struct = std::mem::zeroed();
            cinfo.common.err = &mut err;
            jpeg_create_decompress(&mut cinfo);

            let c_path = path_to_cstring(path)?;
            let mode = CString::new("rb").unwrap();
            let fp = libc_fopen(c_path.as_ptr(), mode.as_ptr());
            if fp.is_null() {
                jpeg_destroy_decompress(&mut cinfo);
                return Err(format!("cannot open {}", path.display()));
            }
            let mut guard = DecompressGuard { cinfo, fp };

            jpeg_stdio_src(&mut guard.cinfo, guard.fp as *mut _);
            jpeg_read_header(&mut guard.cinfo, true as boolean);
            let coef_arrays = jpeg_read_coefficients(&mut guard.cinfo);
            if coef_arrays.is_null() {
                return Err("jpeg_read_coefficients returned null".to_string());
            }

            let comp = &*guard.cinfo.comp_info; // component 0 = Y for standard JFIF ordering
            let blocks_wide = comp.width_in_blocks as usize;
            let blocks_high = comp.height_in_blocks as usize;
            let mut data = vec![[0i16; 64]; blocks_wide * blocks_high];

            let access = (*guard.cinfo.common.mem).access_virt_barray.expect("access_virt_barray missing");
            let y_array = *coef_arrays; // coefficient array for component 0
            let v_samp = comp.v_samp_factor.max(1) as u32;
            let mut blk_y: u32 = 0;
            while blk_y < blocks_high as u32 {
                let rows = v_samp.min(blocks_high as u32 - blk_y);
                let buffer = access(&mut guard.cinfo.common, y_array, blk_y, rows, false as boolean);
                for offset_y in 0..rows as usize {
                    let row_ptr = *buffer.add(offset_y);
                    for bx in 0..blocks_wide {
                        let block = *row_ptr.add(bx);
                        data[(blk_y as usize + offset_y) * blocks_wide + bx] = block;
                    }
                }
                blk_y += rows;
            }

            // `guard` drops here (and on any panic unwind above), running
            // jpeg_destroy_decompress + fclose exactly once either way.
            Ok(YCoefficients { blocks_wide, blocks_high, data })
        }
    }

    /// Re-open `src_path` (the same file `read_y_coefficients` was called on),
    /// overwrite the Y-plane blocks with `modified`, and write the result to
    /// `dst_path`. Cb/Cr planes and quantization tables pass through unchanged
    /// via jpeg_copy_critical_parameters + reusing the same coef_arrays pointer.
    pub fn write_y_coefficients(src_path: &Path, modified: &YCoefficients, dst_path: &Path) -> Result<(), String> {
        let src_path = src_path.to_path_buf();
        let dst_path = dst_path.to_path_buf();
        let blocks_wide = modified.blocks_wide;
        let blocks_high = modified.blocks_high;
        let data = modified.data.clone();
        std::panic::catch_unwind(move || {
            write_y_coefficients_inner(&src_path, blocks_wide, blocks_high, &data, &dst_path)
        })
        .map_err(|_| "libjpeg error while writing coefficients".to_string())?
    }

    /// Same rationale as `DecompressGuard` above, for the compress side.
    struct CompressGuard {
        cinfo: jpeg_compress_struct,
        fp: *mut std::ffi::c_void,
    }

    impl Drop for CompressGuard {
        fn drop(&mut self) {
            unsafe {
                jpeg_destroy_compress(&mut self.cinfo);
                if !self.fp.is_null() {
                    libc_fclose(self.fp);
                }
            }
        }
    }

    fn write_y_coefficients_inner(
        src_path: &Path,
        blocks_wide: usize,
        blocks_high: usize,
        data: &[[i16; 64]],
        dst_path: &Path,
    ) -> Result<(), String> {
        unsafe {
            let mut src_err: jpeg_error_mgr = std::mem::zeroed();
            jpeg_std_error(&mut src_err);
            src_err.error_exit = Some(error_exit);
            let mut dst_err: jpeg_error_mgr = std::mem::zeroed();
            jpeg_std_error(&mut dst_err);
            dst_err.error_exit = Some(error_exit);

            let mut srcinfo: jpeg_decompress_struct = std::mem::zeroed();
            srcinfo.common.err = &mut src_err;
            jpeg_create_decompress(&mut srcinfo);
            let mut dstinfo: jpeg_compress_struct = std::mem::zeroed();
            dstinfo.common.err = &mut dst_err;
            jpeg_create_compress(&mut dstinfo);

            let src_c = path_to_cstring(src_path)?;
            let rb = CString::new("rb").unwrap();
            let in_fp = libc_fopen(src_c.as_ptr(), rb.as_ptr());
            if in_fp.is_null() {
                jpeg_destroy_decompress(&mut srcinfo);
                jpeg_destroy_compress(&mut dstinfo);
                return Err(format!("cannot reopen {}", src_path.display()));
            }
            let mut src_guard = DecompressGuard { cinfo: srcinfo, fp: in_fp };

            jpeg_stdio_src(&mut src_guard.cinfo, src_guard.fp as *mut _);
            jpeg_read_header(&mut src_guard.cinfo, true as boolean);
            let coef_arrays = jpeg_read_coefficients(&mut src_guard.cinfo);
            if coef_arrays.is_null() {
                jpeg_destroy_compress(&mut dstinfo);
                return Err("jpeg_read_coefficients returned null".to_string());
            }

            // Mutate component 0 (Y) in place with our modified coefficients.
            let comp = &*src_guard.cinfo.comp_info;
            let access = (*src_guard.cinfo.common.mem).access_virt_barray.expect("access_virt_barray missing");
            let y_array = *coef_arrays;
            let v_samp = comp.v_samp_factor.max(1) as u32;
            let mut blk_y: u32 = 0;
            while blk_y < blocks_high as u32 {
                let rows = v_samp.min(blocks_high as u32 - blk_y);
                let buffer = access(&mut src_guard.cinfo.common, y_array, blk_y, rows, true as boolean);
                for offset_y in 0..rows as usize {
                    let row_ptr = *buffer.add(offset_y);
                    for bx in 0..blocks_wide {
                        let block_ptr = row_ptr.add(bx);
                        *block_ptr = data[(blk_y as usize + offset_y) * blocks_wide + bx];
                    }
                }
                blk_y += rows;
            }

            let dst_c = path_to_cstring(dst_path)?;
            let wb = CString::new("wb").unwrap();
            let out_fp = libc_fopen(dst_c.as_ptr(), wb.as_ptr());
            if out_fp.is_null() {
                jpeg_destroy_compress(&mut dstinfo);
                return Err(format!("cannot open {} for writing", dst_path.display()));
            }
            let mut dst_guard = CompressGuard { cinfo: dstinfo, fp: out_fp };

            jpeg_stdio_dest(&mut dst_guard.cinfo, dst_guard.fp as *mut _);
            jpeg_copy_critical_parameters(&src_guard.cinfo, &mut dst_guard.cinfo);
            jpeg_write_coefficients(&mut dst_guard.cinfo, coef_arrays);
            jpeg_finish_compress(&mut dst_guard.cinfo);
            jpeg_finish_decompress(&mut src_guard.cinfo);

            // Both guards drop here (and on any panic unwind above), each
            // running its destroy + fclose exactly once either way.
            Ok(())
        }
    }

    // libjpeg's stdio source/dest managers want a real C FILE*; go through libc
    // directly rather than pulling in a whole extra crate for two functions.
    extern "C" {
        #[link_name = "fopen"]
        fn libc_fopen(path: *const c_char, mode: *const c_char) -> *mut std::ffi::c_void;
        #[link_name = "fclose"]
        fn libc_fclose(f: *mut std::ffi::c_void) -> i32;
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn write_png(path: &Path, w: u32, h: u32, mut pixels: impl FnMut(u32, u32) -> [u8; 3]) {
        let mut img = image::RgbImage::new(w, h);
        for y in 0..h {
            for x in 0..w {
                img.put_pixel(x, y, image::Rgb(pixels(x, y)));
            }
        }
        img.save(path).unwrap();
    }

    /// Regression test for Phase 4 (adaptive per-cover QIM delta): a flat
    /// cover must round-trip correctly through the QIM_DELTA_FLAT tier, and
    /// a busy cover must round-trip correctly through QIM_DELTA_DEFAULT --
    /// both are exercised by the same encode()/decode() pair, so this also
    /// covers the header's tier byte being read back correctly.
    #[test]
    fn test_adaptive_delta_roundtrip_flat_and_busy_covers() {
        let payload = b"adaptive per-cover QIM delta round trip";

        let flat_path = std::env::temp_dir().join("stego_qim_test_flat.png");
        write_png(&flat_path, 256, 256, |_, _| [128, 128, 128]);
        let flat_jpeg = encode(&flat_path, payload, Robustness::Max).unwrap();
        let flat_out = std::env::temp_dir().join("stego_qim_test_flat_out.jpg");
        std::fs::write(&flat_out, &flat_jpeg).unwrap();
        assert_eq!(decode(&flat_out).unwrap().as_deref(), Some(payload.as_slice()));
        let _ = std::fs::remove_file(&flat_path);
        let _ = std::fs::remove_file(&flat_out);

        let busy_path = std::env::temp_dir().join("stego_qim_test_busy.png");
        let mut state: u32 = 0xC0FFEE;
        write_png(&busy_path, 256, 256, |_, _| {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            [(state & 0xFF) as u8, ((state >> 8) & 0xFF) as u8, ((state >> 16) & 0xFF) as u8]
        });
        let busy_jpeg = encode(&busy_path, payload, Robustness::Max).unwrap();
        let busy_out = std::env::temp_dir().join("stego_qim_test_busy_out.jpg");
        std::fs::write(&busy_out, &busy_jpeg).unwrap();
        assert_eq!(decode(&busy_out).unwrap().as_deref(), Some(payload.as_slice()));
        let _ = std::fs::remove_file(&busy_path);
        let _ = std::fs::remove_file(&busy_out);
    }

    /// The flat cover above must actually classify into the flat tier, and
    /// the busy one into the default tier -- otherwise the test above could
    /// pass while both silently used the same tier and this feature would be
    /// untested.
    #[test]
    fn test_average_ac_magnitude_separates_flat_from_busy() {
        let flat_path = std::env::temp_dir().join("stego_qim_test_classify_flat.png");
        write_png(&flat_path, 256, 256, |_, _| [128, 128, 128]);
        let flat_jpeg_path = std::env::temp_dir().join("stego_qim_test_classify_flat.jpg");
        {
            let img = image::open(&flat_path).unwrap().to_rgb8();
            let mut f = std::fs::File::create(&flat_jpeg_path).unwrap();
            let mut enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut f, QIM_EMBED_QUALITY);
            enc.encode(&img, img.width(), img.height(), image::ExtendedColorType::Rgb8).unwrap();
        }
        let jpeg = ffi::read_y_coefficients(&flat_jpeg_path).unwrap();
        let stream = coeff_stream(jpeg.blocks_wide, jpeg.blocks_high);
        let flat_mag = average_ac_magnitude(&jpeg, &stream);
        assert!(
            flat_mag < QIM_FLATNESS_THRESHOLD,
            "solid-color cover should classify as flat, got avg_ac_magnitude={flat_mag}"
        );
        let _ = std::fs::remove_file(&flat_path);
        let _ = std::fs::remove_file(&flat_jpeg_path);
    }

    /// Reproduces the pre-Phase-4 encoder's 16-bit header (`QIM_LEGACY_HEADER_BITS`:
    /// u16 codeword length only, no tier byte, body always at
    /// `QIM_DELTA_DEFAULT`). `encode()` can no longer produce this format
    /// itself now that it always writes the tier byte, so this stands in for
    /// the old binary to exercise the decoder's legacy fallback path.
    fn encode_legacy_16bit_header(cover_path: &Path, payload: &[u8]) -> Vec<u8> {
        let img = image::open(cover_path).unwrap().to_rgb8();
        let tmp_in = std::env::temp_dir().join(format!("stegstr_qim_legacy_in_{}.jpg", std::process::id()));
        {
            let mut f = std::fs::File::create(&tmp_in).unwrap();
            let mut enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut f, QIM_EMBED_QUALITY);
            enc.encode(&img, img.width(), img.height(), image::ExtendedColorType::Rgb8).unwrap();
        }

        let mut jpeg = ffi::read_y_coefficients(&tmp_in).unwrap();
        let stream = coeff_stream(jpeg.blocks_wide, jpeg.blocks_high);
        let codeword = wrap_payload(payload);
        let codeword_bits = to_bits(&codeword);
        let header_bytes = (codeword.len() as u16).to_be_bytes().to_vec();
        let header_bits = to_bits(&header_bytes);

        let perm = fixed_permutation(stream.len());
        let interleaved_header = interleave_repeat(&header_bits, QIM_HEADER_REPEAT);
        let interleaved_codeword = interleave_repeat(&codeword_bits, QIM_REPEAT);

        let write_bit = |jpeg: &mut ffi::YCoefficients, slot: u32, bit: u8, delta: f64| {
            let (by, bx, zi) = stream[slot as usize];
            let (dy, dx) = zigzag_rc(zi);
            let c = jpeg.get(by, bx, dy, dx) as f64;
            let v = qim_embed(c, bit, delta).clamp(-32767, 32767) as i16;
            jpeg.set(by, bx, dy, dx, v);
        };
        for (i, &bit) in interleaved_header.iter().enumerate() {
            write_bit(&mut jpeg, perm[i], bit, QIM_HEADER_DELTA);
        }
        for (i, &bit) in interleaved_codeword.iter().enumerate() {
            write_bit(&mut jpeg, perm[interleaved_header.len() + i], bit, QIM_DELTA_DEFAULT);
        }

        let tmp_out = std::env::temp_dir().join(format!("stegstr_qim_legacy_out_{}.jpg", std::process::id()));
        ffi::write_y_coefficients(&tmp_in, &jpeg, &tmp_out).unwrap();
        let bytes = std::fs::read(&tmp_out).unwrap();
        let _ = std::fs::remove_file(&tmp_in);
        let _ = std::fs::remove_file(&tmp_out);
        bytes
    }

    /// Regression test for the header-versioning fix: images embedded with
    /// the old 16-bit header must still decode with the current decoder.
    /// Before this fix `decode()` only tried the current 24-bit header --
    /// against a legacy image this silently returned `None` in the best
    /// case, and in the worst case (a short-enough misread codeword length)
    /// crashed the process via a Reed-Solomon buffer underflow. See BUGS.md.
    #[test]
    fn test_legacy_16bit_header_still_decodes() {
        let payload = b"header compat regression test";
        let cover_path = std::env::temp_dir().join("stego_qim_test_legacy_cover.png");
        let mut state: u32 = 0xDEADBEEF;
        write_png(&cover_path, 256, 256, |_, _| {
            state ^= state << 13;
            state ^= state >> 17;
            state ^= state << 5;
            [(state & 0xFF) as u8, ((state >> 8) & 0xFF) as u8, ((state >> 16) & 0xFF) as u8]
        });

        let legacy_jpeg = encode_legacy_16bit_header(&cover_path, payload);
        let legacy_out = std::env::temp_dir().join("stego_qim_test_legacy_out.jpg");
        std::fs::write(&legacy_out, &legacy_jpeg).unwrap();

        assert_eq!(decode(&legacy_out).unwrap().as_deref(), Some(payload.as_slice()));

        let _ = std::fs::remove_file(&cover_path);
        let _ = std::fs::remove_file(&legacy_out);
    }

    /// Attacks the dual-format decoder directly with adversarial coefficient
    /// data: every trial writes fully random bits into the header AND body
    /// slots (so the 24-bit reading, the 16-bit fallback reading, and
    /// whatever codeword length either one derives from that noise are all
    /// attacker-controlled), then calls the real public `decode()`. This is
    /// exactly the class of input BUGS.md #8 found a crash in (a
    /// Reed-Solomon buffer underflow from a garbled codeword length) --
    /// after that fix, the two format attempts trying arbitrary/ambiguous
    /// bit patterns against each other should never panic, only ever return
    /// `Ok(None)` or `Err(..)` cleanly. Wrapped in `catch_unwind` so a
    /// regression here fails this one test with the seed, instead of
    /// aborting the whole test binary.
    #[test]
    fn test_dual_format_decode_survives_adversarial_header_bytes() {
        let cover_path = std::env::temp_dir().join("stego_qim_test_adversarial_cover.png");
        write_png(&cover_path, 256, 256, |_, _| [128, 128, 128]);
        let tmp_in = std::env::temp_dir().join("stego_qim_test_adversarial_in.jpg");
        {
            let img = image::open(&cover_path).unwrap().to_rgb8();
            let mut f = std::fs::File::create(&tmp_in).unwrap();
            let mut enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut f, QIM_EMBED_QUALITY);
            enc.encode(&img, img.width(), img.height(), image::ExtendedColorType::Rgb8).unwrap();
        }
        let (stream_len, blocks_wide, blocks_high) = {
            let base_jpeg = ffi::read_y_coefficients(&tmp_in).unwrap();
            (
                coeff_stream(base_jpeg.blocks_wide, base_jpeg.blocks_high).len(),
                base_jpeg.blocks_wide,
                base_jpeg.blocks_high,
            )
        };
        let stream = coeff_stream(blocks_wide, blocks_high);
        let perm = fixed_permutation(stream_len);

        // Enough slots for both header interpretations plus a plausible
        // (attacker-chosen-length) body -- covers the "codeword length
        // claims more data than actually follows" case too, since a random
        // 16-bit length is very likely to exceed what's actually available.
        let n_noise_slots = stream_len.min(20_000);

        for seed in 0u64..300 {
            // Re-read fresh coefficients each iteration (YCoefficients isn't
            // Clone) rather than mutating a shared decoded copy across seeds.
            let mut jpeg = ffi::read_y_coefficients(&tmp_in).unwrap();
            let mut state = seed ^ 0x9E3779B97F4A7C15;
            for &slot in perm.iter().take(n_noise_slots) {
                let (by, bx, zi) = stream[slot as usize];
                let (dy, dx) = zigzag_rc(zi);
                let bit = (splitmix64_next(&mut state) & 1) as u8;
                // Alternate delta so neither the 24-bit nor the 16-bit
                // reading gets a consistent single-delta advantage.
                let delta = if splitmix64_next(&mut state) & 1 == 0 {
                    QIM_HEADER_DELTA
                } else {
                    QIM_DELTA_FLAT
                };
                let c = jpeg.get(by, bx, dy, dx) as f64;
                let v = qim_embed(c, bit, delta).clamp(-32767, 32767) as i16;
                jpeg.set(by, bx, dy, dx, v);
            }
            let out_path = std::env::temp_dir().join(format!("stego_qim_adversarial_{seed}.jpg"));
            ffi::write_y_coefficients(&tmp_in, &jpeg, &out_path).unwrap();

            let result = std::panic::catch_unwind(|| decode(&out_path));
            let _ = std::fs::remove_file(&out_path);
            assert!(
                result.is_ok(),
                "decode() panicked on adversarial header/body noise, seed={seed}"
            );
            // Whatever it returned, it must be a clean Result -- either a
            // descriptive Err or Ok(None)/Ok(Some(garbage)) is acceptable,
            // a panic is not. (A coincidental RS+7-byte-magic false
            // positive on pure noise is not a realistic concern here --
            // same reasoning the dual-format decoder's own doc comment
            // already relies on.)
            let _ = result.unwrap();
        }

        let _ = std::fs::remove_file(&cover_path);
        let _ = std::fs::remove_file(&tmp_in);
    }

    /// Companion to the adversarial-noise test above: a cover too small to
    /// even hold a full header in either format must fail cleanly (`Ok(None)`
    /// or a descriptive `Err`), not panic, no matter what garbage is in its
    /// few available coefficients.
    #[test]
    fn test_dual_format_decode_survives_truncated_tiny_cover() {
        let cover_path = std::env::temp_dir().join("stego_qim_test_tiny_cover.png");
        write_png(&cover_path, 8, 8, |x, y| {
            [((x * 37 + y) & 0xFF) as u8, ((x * 13) & 0xFF) as u8, ((y * 29) & 0xFF) as u8]
        });
        let out_path = std::env::temp_dir().join("stego_qim_test_tiny_out.jpg");
        {
            let img = image::open(&cover_path).unwrap().to_rgb8();
            let mut f = std::fs::File::create(&out_path).unwrap();
            let mut enc = image::codecs::jpeg::JpegEncoder::new_with_quality(&mut f, QIM_EMBED_QUALITY);
            enc.encode(&img, img.width(), img.height(), image::ExtendedColorType::Rgb8).unwrap();
        }

        let result = std::panic::catch_unwind(|| decode(&out_path));
        assert!(result.is_ok(), "decode() panicked on a too-small-for-any-header cover");
        assert!(result.unwrap().unwrap().is_none(), "a tiny plain cover should decode to no payload, not an error or a false positive");

        let _ = std::fs::remove_file(&cover_path);
        let _ = std::fs::remove_file(&out_path);
    }
}

//! Pure-Rust JPEG marker-segment parser, used only by `stegstr-cli
//! calibrate` (see bin/stegstr_cli/calibrate.rs) to read a JPEG's structural
//! metadata: dimensions, chroma subsampling, quantization tables,
//! progressive/baseline, and EXIF/ICC presence.
//!
//! Deliberately separate from `stego_qim.rs`'s `ffi` module, which wraps
//! libjpeg via mozjpeg-sys for the QIM encoder/decoder's DCT-coefficient
//! access (see that module's own comment on why it's isolated, and BUGS.md
//! #3/#8 for the hardening that module has already earned). calibrate only
//! ever *reads* header-level structure -- no coefficient access, no
//! encode/decode -- so it doesn't need libjpeg at all: JPEG's marker-segment
//! format is a simple, fully public byte layout, and reading it directly in
//! safe Rust means zero new risk to the FFI surface that bugs #3 and #8
//! already had to harden.
//!
//! Stops parsing at the first SOS (Start of Scan) marker -- everything
//! calibrate needs (SOF0/SOF2, DQT, APPn) appears in the header, before the
//! entropy-coded scan data begins, so entropy data is never touched.

/// libjpeg's well-known zigzag-to-natural-order mapping for an 8x8 block
/// (`jpeg_natural_order` in libjpeg's jutils.c): `NATURAL_ORDER[zigzag_index]`
/// is that coefficient's position in row-major (natural) order. DQT segments
/// store quantization table entries in zigzag order; this converts back to
/// natural order so the recovered table can be compared, entry-for-entry,
/// against the standard IJG base tables below.
const NATURAL_ORDER: [usize; 64] = [
    0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5, 12, 19, 26, 33, 40, 48, 41, 34, 27, 20,
    13, 6, 7, 14, 21, 28, 35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51, 58, 59,
    52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
];

/// IJG standard base luminance quantization table at quality 50, natural
/// (row-major) order. Every "quality Q" scaled table is derived from this
/// via `scale_for_quality` -- the same formula libjpeg itself uses to build
/// tables from a quality setting (jcparam.c's `jpeg_quality_scaling` +
/// `jpeg_add_quant_table`), used here in reverse to estimate quality.
const IJG_BASE_LUMA: [u16; 64] = [
    16, 11, 10, 16, 24, 40, 51, 61, 12, 12, 14, 19, 26, 58, 60, 55, 14, 13, 16, 24, 40, 57, 69, 56,
    14, 17, 22, 29, 51, 87, 80, 62, 18, 22, 37, 56, 68, 109, 103, 77, 24, 35, 55, 64, 81, 104, 113,
    92, 49, 64, 78, 87, 103, 121, 120, 101, 72, 92, 95, 98, 112, 100, 103, 99,
];

#[derive(Debug, Clone, PartialEq)]
pub struct JpegProfile {
    pub width: u16,
    pub height: u16,
    pub progressive: bool,
    /// (h_samp, v_samp) per component, in the order they appear in the SOF
    /// segment (component 0 is Y for standard YCbCr JPEGs).
    pub component_sampling: Vec<(u8, u8)>,
    /// Quantization tables actually present, in natural (row-major) order,
    /// keyed by the table id (0-3) the SOF segment's components reference.
    pub quant_tables: std::collections::BTreeMap<u8, [u16; 64]>,
    pub has_exif: bool,
    pub has_icc: bool,
}

impl JpegProfile {
    /// 4:2:0 / 4:2:2 / 4:4:4 / other, derived from the luma (component 0)
    /// sampling factors relative to the chroma components -- the standard
    /// convention (h_samp=2,v_samp=2 on luma with 1,1 on chroma is 4:2:0,
    /// the JPEG re-encode default nearly every platform uses).
    pub fn chroma_subsampling(&self) -> &'static str {
        let Some(&(ly, lv)) = self.component_sampling.first() else {
            return "unknown";
        };
        let chroma_uniform = self.component_sampling[1..].iter().all(|&(h, v)| h == 1 && v == 1);
        if !chroma_uniform {
            return "unknown";
        }
        match (ly, lv) {
            (2, 2) => "4:2:0",
            (2, 1) => "4:2:2",
            (1, 1) => "4:4:4",
            _ => "unknown",
        }
    }

    /// Estimate JPEG quality (1-100) from the luma quantization table (table
    /// id 0), by finding the standard-scaled table closest to the one
    /// actually recovered. Returns (quality, mean_absolute_error). An error
    /// of 0 means the table is a byte-exact match to the IJG standard
    /// scaling curve at that quality -- genuinely exact recovery, not a
    /// guess. Any other value is the closest fit, honestly reported as such
    /// rather than claimed as exact: a platform's own encoder may not use
    /// unmodified IJG scaling.
    pub fn estimate_jpeg_quality(&self) -> Option<(u8, f64)> {
        let table = self.quant_tables.get(&0)?;
        let mut best_q = 1u8;
        let mut best_err = f64::MAX;
        for q in 1..=100u8 {
            let scaled = scale_for_quality(&IJG_BASE_LUMA, q);
            let err: f64 = table
                .iter()
                .zip(scaled.iter())
                .map(|(&a, &b)| (a as f64 - b as f64).abs())
                .sum::<f64>()
                / 64.0;
            if err < best_err {
                best_err = err;
                best_q = q;
            }
        }
        Some((best_q, best_err))
    }
}

/// IJG's own quality->scale-factor->table formula (jcparam.c), run forward.
/// Used here only to score candidate qualities against a recovered table
/// (see `estimate_jpeg_quality`), not to encode anything.
fn scale_for_quality(base: &[u16; 64], quality: u8) -> [u16; 64] {
    let q = quality.clamp(1, 100) as i64;
    let scale_factor = if q < 50 { 5000 / q } else { 200 - q * 2 };
    let mut out = [0u16; 64];
    for (i, &b) in base.iter().enumerate() {
        let v = (b as i64 * scale_factor + 50) / 100;
        out[i] = v.clamp(1, 255) as u16;
    }
    out
}

#[derive(Debug)]
pub enum ProbeError {
    NotAJpeg,
    Truncated,
}

impl std::fmt::Display for ProbeError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            ProbeError::NotAJpeg => write!(f, "not a JPEG file (missing SOI marker)"),
            ProbeError::Truncated => write!(f, "truncated JPEG: marker segment runs past end of file"),
        }
    }
}

/// Parse a JPEG's marker segments up to (not including) the entropy-coded
/// scan data. Pure structural read -- no decoding of pixel/coefficient data.
pub fn probe(bytes: &[u8]) -> Result<JpegProfile, ProbeError> {
    if bytes.len() < 4 || bytes[0] != 0xFF || bytes[1] != 0xD8 {
        return Err(ProbeError::NotAJpeg);
    }
    let mut profile = JpegProfile {
        width: 0,
        height: 0,
        progressive: false,
        component_sampling: Vec::new(),
        quant_tables: std::collections::BTreeMap::new(),
        has_exif: false,
        has_icc: false,
    };

    let mut i = 2usize;
    while i + 1 < bytes.len() {
        if bytes[i] != 0xFF {
            // Padding/stray byte between segments; skip.
            i += 1;
            continue;
        }
        let marker = bytes[i + 1];
        i += 2;
        // Markers with no length field: TEM, RST0-7, SOI, EOI.
        if marker == 0x01 || (0xD0..=0xD9).contains(&marker) {
            if marker == 0xD9 {
                break; // EOI
            }
            continue;
        }
        if marker == 0xDA {
            // SOS: header parsing done, entropy-coded data follows.
            break;
        }
        if i + 1 >= bytes.len() {
            return Err(ProbeError::Truncated);
        }
        let seg_len = u16::from_be_bytes([bytes[i], bytes[i + 1]]) as usize;
        if seg_len < 2 || i + seg_len > bytes.len() {
            return Err(ProbeError::Truncated);
        }
        let seg_start = i + 2;
        let seg_end = i + seg_len;
        let seg = &bytes[seg_start..seg_end];

        match marker {
            // SOF0 (baseline), SOF2 (progressive), and the less common
            // extended-sequential/lossless variants -- treated as baseline
            // except SOF2/6/A/E, which are the progressive-DCT variants.
            0xC0..=0xCF if marker != 0xC4 && marker != 0xC8 && marker != 0xCC => {
                profile.progressive = matches!(marker, 0xC2 | 0xC6 | 0xCA | 0xCE);
                if seg.len() >= 6 {
                    profile.height = u16::from_be_bytes([seg[1], seg[2]]);
                    profile.width = u16::from_be_bytes([seg[3], seg[4]]);
                    let num_components = seg[5] as usize;
                    profile.component_sampling.clear();
                    for c in 0..num_components {
                        let off = 6 + c * 3;
                        if off + 2 < seg.len() {
                            let samp = seg[off + 1];
                            profile.component_sampling.push((samp >> 4, samp & 0x0F));
                        }
                    }
                }
            }
            0xDB => {
                // DQT: one or more tables back to back until segment ends.
                let mut p = 0usize;
                while p < seg.len() {
                    let precision_and_id = seg[p];
                    let precision = precision_and_id >> 4; // 0 = 8-bit, 1 = 16-bit
                    let id = precision_and_id & 0x0F;
                    p += 1;
                    let mut table = [0u16; 64];
                    for zz in 0..64 {
                        let v = if precision == 0 {
                            if p >= seg.len() {
                                break;
                            }
                            let v = seg[p] as u16;
                            p += 1;
                            v
                        } else {
                            if p + 1 >= seg.len() {
                                break;
                            }
                            let v = u16::from_be_bytes([seg[p], seg[p + 1]]);
                            p += 2;
                            v
                        };
                        table[NATURAL_ORDER[zz]] = v;
                    }
                    profile.quant_tables.insert(id, table);
                }
            }
            // APP1: EXIF ("Exif\0\0") or XMP -- only flag genuine EXIF.
            0xE1 if seg.starts_with(b"Exif\0\0") => {
                profile.has_exif = true;
            }
            // APP2: ICC profile chunks are tagged "ICC_PROFILE\0".
            0xE2 if seg.starts_with(b"ICC_PROFILE\0") => {
                profile.has_icc = true;
            }
            _ => {}
        }
        i = seg_end;
    }
    Ok(profile)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rejects_non_jpeg() {
        let png_sig = [0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A];
        assert!(matches!(probe(&png_sig), Err(ProbeError::NotAJpeg)));
    }

    #[test]
    fn scale_for_quality_100_is_all_ones() {
        // IJG's own formula: quality 100 -> scale_factor 0 -> every entry
        // clamps to the minimum, 1. A cheap sanity check on the formula
        // itself before trusting the quality-estimation search that uses it.
        let scaled = scale_for_quality(&IJG_BASE_LUMA, 100);
        assert!(scaled.iter().all(|&v| v == 1));
    }

    #[test]
    fn quality_roundtrip_is_exact_for_standard_scaling() {
        // Build a synthetic table via the same formula real IJG-derived
        // encoders use, then confirm estimate_jpeg_quality recovers the
        // exact quality with zero error -- this is the "exact, not
        // estimated" case the brief asks for.
        for q in [10u8, 50, 75, 90, 95] {
            let table = scale_for_quality(&IJG_BASE_LUMA, q);
            let mut profile = JpegProfile {
                width: 1,
                height: 1,
                progressive: false,
                component_sampling: vec![],
                quant_tables: std::collections::BTreeMap::new(),
                has_exif: false,
                has_icc: false,
            };
            profile.quant_tables.insert(0, table);
            let (est_q, err) = profile.estimate_jpeg_quality().unwrap();
            assert_eq!(est_q, q, "quality {q} round-tripped to {est_q}");
            assert_eq!(err, 0.0, "quality {q} should be an exact match, got error {err}");
        }
    }

    #[test]
    fn chroma_subsampling_reads_common_modes() {
        let mut p = JpegProfile {
            width: 1,
            height: 1,
            progressive: false,
            component_sampling: vec![(2, 2), (1, 1), (1, 1)],
            quant_tables: std::collections::BTreeMap::new(),
            has_exif: false,
            has_icc: false,
        };
        assert_eq!(p.chroma_subsampling(), "4:2:0");
        p.component_sampling = vec![(1, 1), (1, 1), (1, 1)];
        assert_eq!(p.chroma_subsampling(), "4:4:4");
    }
}

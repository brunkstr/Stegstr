# Channel Specification

Exact parameters for each simulated platform profile. "Defeating the situation" means payload recovery (decode = original) after these transformations.

## Profile Parameters

| Profile    | max_width | JPEG quality | Chroma subsampling | Resize method |
|-----------|-----------|--------------|--------------------|---------------|
| whatsapp  | 800       | 65           | 4:2:0              | LANCZOS       |
| instagram | 1080      | 82           | 4:2:0              | LANCZOS       |
| facebook  | 2048      | 77           | 4:2:0              | LANCZOS       |
| twitter   | 600       | 82           | 4:2:0              | LANCZOS       |

## Pipeline Order

1. **Strip EXIF / metadata** (orientation applied then discarded)
2. **Convert to RGB** if needed (sRGB assumed)
3. **Resize** to max_width (maintain aspect ratio) if image is wider
4. **Encode as JPEG** with quality and 4:2:0 subsampling

## Source

Defined in [channel.py](channel.py) `PROFILES` and applied by `simulate()`.

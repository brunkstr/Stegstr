/**
 * STDM codec adapter: the resize-robust method from contest entry #71 (Saif,
 * github.com/saifbrand/Stegstr, MIT; PR #4). Both ends resample the luma plane
 * onto a fixed canonical grid before embedding, so a platform's rescale is
 * undone by the receiver's own normalisation; strength is calibrated per cover.
 * Three payload modes trade capacity for robustness: locator (48 B, a pointer
 * the relay resolves), standard (163 B note), bulk (lossless channels only).
 * Verified blind on the contest gauntlet: 100% on gradient and texture covers,
 * 80% on the busy cover (3-cover mean 93%). Known limits: rotation and crops
 * beyond ~2% per edge are not handled.
 */
import type { Codec, EncodeOptions } from "./types";
import { isJpegFile } from "./qim";
import {
  MODES,
  type ModeName,
  decodeStdmImageFile,
  encodeStdmImageFile,
  getStdmCapacityForFile,
  stdmSelfTest,
} from "../stego-stdm-web";

export const DEFAULT_STDM_MODE: ModeName = "standard";

export interface StdmEncodeOptions extends EncodeOptions {
  mode?: ModeName;
}

export const stdmCodec: Codec = {
  id: "robust",
  label: "Robust (JPEG, survives resizing)",
  description: "Resize-robust JPEG method: survives recompression and platform rescaling; fixed small payload per mode.",
  container: "jpeg",
  accepts: isJpegFile,
  decode: (file) => decodeStdmImageFile(file),
  async encode(cover, payload, opts?: StdmEncodeOptions) {
    const mode = opts?.mode ?? DEFAULT_STDM_MODE;
    if (!(mode in MODES)) throw new Error(`Unknown mode ${mode}`);
    const blob = await encodeStdmImageFile(cover, payload, mode);
    const check = await stdmSelfTest(blob, payload, mode);
    if (!check.ok) throw new Error(`Robust self-test failed: ${check.error ?? "payload did not round-trip"}`);
    return blob;
  },
  async capacityBytes(cover, opts?: StdmEncodeOptions) {
    const info = await getStdmCapacityForFile(cover, opts?.mode ?? DEFAULT_STDM_MODE);
    return info.usable ? info.capacityBytes : 0;
  },
};

/**
 * QIM codec adapter: JPEG DCT-domain quantization-index modulation from #108's
 * stego-qim.ts. Survives platform recompression at a fixed grid; lost if the
 * image is resized after embedding, which is why encode pre-sizes the cover to
 * the target platform's width.
 */
import type { Codec, EncodeOptions } from "./types";
import {
  decodeQimImageFile,
  encodeQimImageFile,
  resizeCoverForPlatform,
  qimSelfTest,
  getQimCapacityForFile,
  PLATFORM_WIDTHS,
  DEFAULT_PLATFORM,
} from "../stego-qim";

export function isJpegFile(file: File): boolean {
  const n = file.name.toLowerCase();
  return file.type === "image/jpeg" || n.endsWith(".jpg") || n.endsWith(".jpeg");
}

export const qimCodec: Codec = {
  id: "qim",
  label: "QIM (JPEG)",
  description: "Robust JPEG method: survives recompression by messaging apps; lost if the image is resized afterwards.",
  container: "jpeg",
  accepts: isJpegFile,
  decode: (file) => decodeQimImageFile(file),
  async encode(cover, payload, opts?: EncodeOptions) {
    const platform = opts?.platform ?? DEFAULT_PLATFORM;
    const width = PLATFORM_WIDTHS[platform] ?? PLATFORM_WIDTHS[DEFAULT_PLATFORM];
    const resized = await resizeCoverForPlatform(cover, width);
    const blob = await encodeQimImageFile(resized, payload);
    const check = await qimSelfTest(blob, payload);
    if (!check.ok) throw new Error(`QIM self-test failed: ${check.error ?? "payload did not round-trip"}`);
    return blob;
  },
  async capacityBytes(cover, opts?: EncodeOptions) {
    const { capacityBytes } = await getQimCapacityForFile(cover, opts?.platform ?? DEFAULT_PLATFORM);
    return capacityBytes;
  },
};

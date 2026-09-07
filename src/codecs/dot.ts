/**
 * Dot codec adapter: the upstream lossless PNG method (spatial encoding). Exact
 * bytes back from an untouched file; does not survive recompression or resizing.
 * Kept as the catch-all decoder so every image made by any earlier version still opens.
 */
import type { Codec } from "./types";
import { decodeStegoFile, encodeStegoToBlob } from "../platform-web";
import { getDotCapacityForFile } from "../stego-dot-web";
import { uint8ArrayToBase64 } from "../utils";

export const dotCodec: Codec = {
  id: "dot",
  label: "Dot (PNG)",
  description: "Lossless PNG method: largest capacity, exact round-trip; does not survive recompression or resizing.",
  container: "png",
  accepts: () => true,
  decode: (file) => decodeStegoFile(file),
  async encode(cover, payload) {
    return encodeStegoToBlob(cover, "base64:" + uint8ArrayToBase64(payload));
  },
  async capacityBytes(cover) {
    return getDotCapacityForFile(cover);
  },
};

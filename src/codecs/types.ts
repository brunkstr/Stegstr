/**
 * The codec contract. A codec hides bytes in an image and gets them back out.
 *
 * Why a registry: the contest produced several hiding methods that all tag their
 * payload with the same "STEGSTR1" magic but lay it out differently, so an image
 * cannot be identified by magic alone. The app therefore tries codecs in a fixed
 * order, and each one must verify its own payload (checksum / self-test) before
 * claiming success. Adding a method is adding a module here — see docs/codecs.md.
 */

export type CodecId = "robust" | "qim" | "dot" | (string & {});

export interface CodecDecodeResult {
  ok: boolean;
  /** The payload as stored (typically "base64:..." of the encrypted bundle). */
  payload?: string;
  error?: string;
}

export interface EncodeOptions {
  /** Platform target for codecs that pre-size the cover (e.g. "instagram", "whatsapp"). */
  platform?: string;
}

export interface Codec {
  /** Stable identifier, used in the embed dialog and in logs. */
  id: CodecId;
  /** Short human name for the UI. */
  label: string;
  /** One sentence on what it survives and what it costs. */
  description: string;
  /** What the codec writes. Decides the output extension. */
  container: "jpeg" | "png";
  /** Cheap pre-check before an expensive decode attempt (e.g. only JPEG files). */
  accepts(file: File): boolean;
  /** Extract the payload, or explain why not. Must never throw for a normal file. */
  decode(file: File): Promise<CodecDecodeResult>;
  /** Hide `payload` in `cover`. Implementations should self-test before returning. */
  encode(cover: File, payload: Uint8Array, opts?: EncodeOptions): Promise<Blob>;
  /** Payload bytes this cover can carry under `opts`, when the codec can say. */
  capacityBytes?(cover: File, opts?: EncodeOptions): Promise<number>;
}

/**
 * Codec registry: the ordered list of hiding methods the app can read and write.
 *
 * Decode order matters and is deliberate: robust JPEG codecs first (they only
 * accept JPEG input, so PNG files skip them), the lossless Dot method last as the
 * catch-all. Every codec verifies its own payload, so a false positive from one
 * cannot shadow another.
 */
import type { Codec, CodecDecodeResult, CodecId } from "./types";
import { qimCodec } from "./qim";
import { dotCodec } from "./dot";

const codecs: Codec[] = [qimCodec, dotCodec];

/** Codecs in decode order. */
export function listCodecs(): readonly Codec[] {
  return codecs;
}

export function getCodec(id: CodecId): Codec | undefined {
  return codecs.find((c) => c.id === id);
}

/**
 * Register an additional codec. `before` places it ahead of an existing codec in
 * decode order (new robust JPEG codecs should go before "dot"). Registering an id
 * twice replaces the earlier entry, which keeps hot-reload and tests simple.
 */
export function registerCodec(codec: Codec, before?: CodecId): void {
  const existing = codecs.findIndex((c) => c.id === codec.id);
  if (existing >= 0) codecs.splice(existing, 1);
  const at = before ? codecs.findIndex((c) => c.id === before) : -1;
  if (at >= 0) codecs.splice(at, 0, codec);
  else codecs.push(codec);
}

export interface DecodeAnyResult extends CodecDecodeResult {
  /** Which codec produced the payload, when one did. */
  codecId?: CodecId;
  /** One line per attempt, for the Stego Log. */
  attempts: string[];
}

/**
 * Try every codec that accepts the file, in registry order, until one returns a
 * verified payload. A codec that throws is recorded and skipped, never fatal.
 */
export async function decodeAny(file: File, onAttempt?: (line: string) => void): Promise<DecodeAnyResult> {
  const attempts: string[] = [];
  const note = (line: string) => {
    attempts.push(line);
    onAttempt?.(line);
  };
  let lastError: string | undefined;
  for (const codec of codecs) {
    if (!codec.accepts(file)) continue;
    note(`Trying ${codec.label} decode...`);
    try {
      const r = await codec.decode(file);
      if (r.ok && r.payload) {
        note(`${codec.label} decode OK (${r.payload.length} chars)`);
        return { ok: true, payload: r.payload, codecId: codec.id, attempts };
      }
      lastError = r.error ?? "no payload";
      note(`${codec.label} decode failed: ${lastError}`);
    } catch (e) {
      lastError = e instanceof Error ? e.message : String(e);
      note(`${codec.label} decode error: ${lastError}`);
    }
  }
  return { ok: false, error: lastError ?? "No codec accepted this file", attempts };
}

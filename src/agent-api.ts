/**
 * Scriptable API exposed on `window.stegstr`.
 *
 * Stegstr is meant to be operable by an agent, not only by a person clicking
 * through a dialog. The CLI covers headless use; this covers the running app,
 * so anything that can evaluate JavaScript in the page - a browser automation
 * driver, a devtools console, an agent harness - can embed and detect without
 * reverse-engineering the UI.
 *
 * Everything here is a thin wrapper over the same functions the UI calls, so
 * the two can never drift apart.
 */

import {
  MODES,
  MODE_LABELS,
  type ModeName,
  decodeStdmImageFile,
  encodeStdmImageFile,
  getStdmCapacityForFile,
  minimumEdge,
  payloadBytes,
} from "./stego-stdm-web";

export interface StegstrAgentApi {
  readonly version: string;
  /** Mode names with their capacity and minimum image size. */
  modes(): Array<{ mode: ModeName; capacityBytes: number; minEdge: number; title: string; detail: string }>;
  /** Capacity for a specific image, and whether it is usable at all. */
  capacity(image: Blob, mode?: ModeName): Promise<{ capacityBytes: number; width: number; height: number; usable: boolean; minEdge: number }>;
  /** Embed text or bytes, returning a JPEG blob. */
  encode(cover: Blob, payload: string | Uint8Array, mode?: ModeName): Promise<Blob>;
  /** Recover a payload as text, or null when the image carries nothing. */
  decode(image: Blob, mode?: ModeName): Promise<string | null>;
  /** Recover a payload with the detail an agent may want. */
  decodeDetailed(image: Blob, mode?: ModeName): Promise<{ ok: boolean; payload?: string; mode?: ModeName; error?: string }>;
  /** Parameter-sweep hooks, used by the robustness harnesses. */
  encodeWithDelta(cover: Blob, payload: string | Uint8Array, mode: ModeName, delta: number): Promise<Blob>;
  decodeWithDelta(image: Blob, mode: ModeName, delta: number): Promise<string | null>;
}

const VERSION = "2.0.0-stdm";

export const agentApi: StegstrAgentApi = {
  version: VERSION,

  modes() {
    return (Object.keys(MODES) as ModeName[]).map((mode) => ({
      mode,
      capacityBytes: payloadBytes(MODES[mode]),
      minEdge: minimumEdge(MODES[mode]),
      title: MODE_LABELS[mode].title,
      detail: MODE_LABELS[mode].detail,
    }));
  },

  capacity(image, mode = "locator") {
    return getStdmCapacityForFile(image, mode);
  },

  encode(cover, payload, mode = "standard") {
    const bytes = typeof payload === "string" ? new TextEncoder().encode(payload) : payload;
    return encodeStdmImageFile(cover, bytes, mode);
  },

  async decode(image, mode) {
    const result = await decodeStdmImageFile(image, mode);
    return result.ok ? (result.payload ?? null) : null;
  },

  async decodeDetailed(image, mode) {
    const { ok, payload, mode: found, error } = await decodeStdmImageFile(image, mode);
    return { ok, payload, mode: found, error };
  },

  encodeWithDelta(cover, payload, mode, delta) {
    const bytes = typeof payload === "string" ? new TextEncoder().encode(payload) : payload;
    return encodeStdmImageFile(cover, bytes, mode, { delta });
  },

  async decodeWithDelta(image, mode, delta) {
    const result = await decodeStdmImageFile(image, mode, { delta });
    return result.ok ? (result.payload ?? null) : null;
  },
};

declare global {
  interface Window {
    stegstr?: StegstrAgentApi;
    /** Alias kept for the browser smoke test. */
    __stegstr?: StegstrAgentApi;
  }
}

export function installAgentApi(): void {
  if (typeof window === "undefined") return;
  window.stegstr = agentApi;
  window.__stegstr = agentApi;
}

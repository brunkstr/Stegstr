/**
 * NIP-98 signed uploads (ported from #79). The token must be a valid kind-27235
 * event naming the exact URL and method, and the client must surface the host's
 * refusal instead of swallowing it.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import * as Nostr from "../nostr-stub";
import { nip98Token, uploadMedia, UploadError, isUploadableMedia } from "../upload";

const sk = Nostr.bytesToHex(Nostr.generateSecretKey());
const URL_ = "https://nostr.build/api/v2/upload/files";
const png = new File([new Uint8Array([137, 80, 78, 71])], "x.png", { type: "image/png" });
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

describe("nip98Token", () => {
  it("is a signed kind-27235 event for this URL and method, base64-encoded", async () => {
    const tok = await nip98Token(sk, URL_, "POST");
    const ev = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(tok), (c) => c.charCodeAt(0))));
    expect(ev.kind).toBe(27235);
    expect(ev.tags).toContainEqual(["u", URL_]);
    expect(ev.tags).toContainEqual(["method", "POST"]);
    expect(ev.pubkey).toBe(Nostr.getPublicKey(Nostr.hexToBytes(sk)));
    expect(await Nostr.verifyEvent(ev)).toBe(true);
  });
});

describe("uploadMedia", () => {
  it("sends the Authorization header and returns the URL the host gives back", async () => {
    let seen: RequestInit | undefined;
    globalThis.fetch = vi.fn(async (_u: RequestInfo | URL, init?: RequestInit) => {
      seen = init;
      return new Response(JSON.stringify({ status: "success", data: [{ url: "https://i.nostr.build/abc.png" }] }), { status: 200 });
    }) as typeof fetch;
    const url = await uploadMedia(png, sk);
    expect(url).toBe("https://i.nostr.build/abc.png");
    const auth = (seen?.headers as Record<string, string>)?.Authorization;
    expect(auth).toMatch(/^Nostr [A-Za-z0-9+/=]+$/);
  });
  it("reports the host's refusal instead of failing silently", async () => {
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ status: "error", message: "Unauthorized, please provide a valid nip-98 token" }), { status: 401, statusText: "Unauthorized" })) as typeof fetch;
    await expect(uploadMedia(png, sk)).rejects.toThrow(UploadError);
    await expect(uploadMedia(png, sk)).rejects.toThrow(/nip-98/);
  });
  it("refuses without a key and refuses non-media before touching the network", async () => {
    globalThis.fetch = vi.fn() as typeof fetch;
    await expect(uploadMedia(png, "")).rejects.toThrow(/identity/);
    await expect(uploadMedia(new File(["x"], "doc.pdf", { type: "application/pdf" }), sk)).rejects.toThrow(/not an image or video/);
    expect(globalThis.fetch).not.toHaveBeenCalled();
    expect(isUploadableMedia(new File(["x"], "clip.mov", { type: "" }))).toBe(true);
  });
});

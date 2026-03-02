import { describe, it, expect, beforeAll } from "vitest";
import { webcrypto } from "node:crypto";

// Polyfill crypto.subtle for Node.js test environment
beforeAll(() => {
  if (!globalThis.crypto?.subtle) {
    Object.defineProperty(globalThis, "crypto", {
      value: webcrypto,
      writable: true,
    });
  }
});

describe("stego-crypto", () => {
  it("encryptApp/decryptApp round-trip", async () => {
    const { encryptApp, decryptApp } = await import("../stego-crypto");
    const plaintext = JSON.stringify({ test: true, content: "Hello Stegstr" });
    const encrypted = await encryptApp(plaintext);
    expect(encrypted).toBeInstanceOf(Uint8Array);
    expect(encrypted.length).toBeGreaterThan(plaintext.length);

    const decrypted = await decryptApp(encrypted);
    expect(decrypted).toBe(plaintext);
  });

  it("isEncryptedPayload detects valid magic", async () => {
    const { encryptApp, isEncryptedPayload } = await import("../stego-crypto");
    const encrypted = await encryptApp("test");
    expect(isEncryptedPayload(encrypted)).toBe(true);
  });

  it("isEncryptedPayload rejects random bytes", async () => {
    const { isEncryptedPayload } = await import("../stego-crypto");
    const random = new Uint8Array(32);
    crypto.getRandomValues(random);
    expect(isEncryptedPayload(random)).toBe(false);
  });

  it("isEncryptedPayload rejects short payload", async () => {
    const { isEncryptedPayload } = await import("../stego-crypto");
    expect(isEncryptedPayload(new Uint8Array([]))).toBe(false);
    expect(isEncryptedPayload(new Uint8Array([83]))).toBe(false);
  });

  it("decryptApp rejects tampered payload", async () => {
    const { encryptApp, decryptApp } = await import("../stego-crypto");
    const encrypted = await encryptApp("valid data");
    // Tamper with ciphertext
    const tampered = new Uint8Array(encrypted);
    tampered[tampered.length - 1] ^= 0xff;
    await expect(decryptApp(tampered)).rejects.toThrow();
  });

  it("decryptApp rejects wrong magic", async () => {
    const { decryptApp } = await import("../stego-crypto");
    const bad = new Uint8Array(64);
    bad[0] = 0; // wrong magic
    await expect(decryptApp(bad)).rejects.toThrow("Invalid Stegstr encrypted payload");
  });

  it("encryptOpen is same as encryptApp", async () => {
    const { encryptOpen, decryptApp } = await import("../stego-crypto");
    const json = JSON.stringify({ notes: [] });
    const encrypted = await encryptOpen(json);
    const decrypted = await decryptApp(encrypted);
    expect(decrypted).toBe(json);
  });
});

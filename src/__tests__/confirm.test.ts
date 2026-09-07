/**
 * Regression for the inherited "Cancel still converts the identity" bug: Tauri's
 * dialog plugin makes window.confirm async, so a synchronous truthiness check
 * always proceeds. confirmDialog must honour the answer in both environments.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { confirmDialog } from "../confirm";

const original = window.confirm;
afterEach(() => {
  window.confirm = original;
});

describe("confirmDialog", () => {
  it("returns the boolean from a synchronous (browser) confirm", async () => {
    window.confirm = vi.fn(() => false);
    expect(await confirmDialog("x")).toBe(false);
    window.confirm = vi.fn(() => true);
    expect(await confirmDialog("x")).toBe(true);
  });

  it("waits for an asynchronous (Tauri) confirm and honours Cancel", async () => {
    // Tauri's override returns a Promise; a truthiness check on it would be true.
    window.confirm = vi.fn(() => Promise.resolve(false)) as unknown as typeof window.confirm;
    expect(await confirmDialog("x")).toBe(false);
    window.confirm = vi.fn(() => Promise.resolve(true)) as unknown as typeof window.confirm;
    expect(await confirmDialog("x")).toBe(true);
  });

  it("passes the message through", async () => {
    const spy = vi.fn(() => true);
    window.confirm = spy;
    await confirmDialog("Delete this note?");
    expect(spy).toHaveBeenCalledWith("Delete this note?");
  });
});

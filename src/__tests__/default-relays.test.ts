import { describe, it, expect } from "vitest";
import { DEFAULT_RELAYS } from "../relay";

describe("DEFAULT_RELAYS", () => {
  it("puts the Stegstr relay first and keeps the public relays as secondaries", () => {
    expect(DEFAULT_RELAYS[0]).toBe("wss://relay.stegstr.com");
    expect(DEFAULT_RELAYS.length).toBeGreaterThanOrEqual(2);
    expect(new Set(DEFAULT_RELAYS).size).toBe(DEFAULT_RELAYS.length);
  });
});

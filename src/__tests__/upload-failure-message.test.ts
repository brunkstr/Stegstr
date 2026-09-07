/**
 * Regression for the inherited silent profile-picture upload failure: the error
 * was swallowed with `catch (_) {}`. Failures must produce a message the user
 * can act on, and a 401 from nostr.build must say why.
 */
import { describe, it, expect } from "vitest";
import { uploadFailureMessage } from "../EditProfileModal";

describe("uploadFailureMessage", () => {
  it("explains a NIP-98 / 401 rejection and offers the URL alternative", () => {
    const m = uploadFailureMessage(
      "Profile picture",
      new Error('Upload failed: 401 Unauthorized - {"message":"please provide a valid nip-98 token"}'),
    );
    expect(m).toMatch(/^Profile picture upload failed\./);
    expect(m).toMatch(/NIP-98/);
    expect(m).toMatch(/paste an image URL/i);
  });

  it("gives a generic hint for other errors and never hides the detail", () => {
    const m = uploadFailureMessage("Banner", new Error("Failed to fetch"));
    expect(m).toMatch(/Banner upload failed\. Check your connection/);
    expect(m).toContain("Failed to fetch");
  });
});

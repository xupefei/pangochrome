import { describe, expect, it } from "vitest";
import { newProfileId } from "./storage";

describe("newProfileId", () => {
  it("encodes bytes as URL-safe base64 without padding", () => {
    expect(newProfileId(new Uint8Array([0xfb, 0xff, 0xbf]))).toBe("-_-_");
  });

  it("produces a 32-character id that matches the helper's profile id rule", () => {
    const id = newProfileId(crypto.getRandomValues(new Uint8Array(24)));
    expect(id).toHaveLength(32);
    expect(id).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
  });
});

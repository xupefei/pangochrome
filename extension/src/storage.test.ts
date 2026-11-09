import { afterEach, describe, expect, it, vi } from "vitest";
import { loadStored, newProfileId } from "./storage";

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubStorage(values: Record<string, unknown>): ReturnType<typeof vi.fn> {
  const set = vi.fn(async () => undefined);
  vi.stubGlobal("chrome", {
    storage: {
      local: {
        get: vi.fn(async () => values),
        set,
        remove: vi.fn(async () => undefined),
      },
    },
  });
  return set;
}

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

describe("loadStored", () => {
  it("loads the saved routes with the exit node flag", async () => {
    stubStorage({
      profileId: "abcdefgh1234",
      wantConnected: true,
      lastConnected: {
        routes: { hosts: ["app.internal"], cidrs: [] },
        exitNodeChosen: true,
      },
    });
    await expect(loadStored()).resolves.toEqual({
      profileId: "abcdefgh1234",
      wantConnected: true,
      lastConnected: { routes: { hosts: ["app.internal"], cidrs: [] }, exitNodeChosen: true },
    });
  });

  it("drops saved routes written with the old exitNodeActive field", async () => {
    stubStorage({
      profileId: "abcdefgh1234",
      wantConnected: false,
      lastConnected: { routes: { hosts: [], cidrs: [] }, exitNodeActive: true },
    });
    await expect(loadStored()).resolves.toMatchObject({ lastConnected: null });
  });

  it("creates and saves a profile id when none is stored", async () => {
    const set = stubStorage({});
    const stored = await loadStored();
    expect(stored.profileId).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(set).toHaveBeenCalledWith({ profileId: stored.profileId });
    expect(stored.wantConnected).toBe(false);
    expect(stored.lastConnected).toBeNull();
  });
});

import { describe, expect, it } from "vitest";
import { badgeFor } from "./badge";
import type { HelperStatus } from "./messages";
import type { Phase, State } from "./protocol";

const READY: HelperStatus = { kind: "ready" };

function stateIn(phase: Phase, extra: Partial<State> = {}): State {
  return { phase, orgs: [], sites: [], routes: { hosts: [], cidrs: [] }, ...extra };
}

describe("badgeFor", () => {
  it("shows an error when the helper is missing or failed", () => {
    expect(badgeFor({ helper: { kind: "notInstalled" }, state: null, error: null }).text).toBe("!");
    expect(
      badgeFor({ helper: { kind: "failed", message: "x" }, state: null, error: null }).text,
    ).toBe("!");
  });

  it("shows an error for a routing failure or a state error", () => {
    expect(badgeFor({ helper: READY, state: stateIn("disconnected"), error: "x" }).text).toBe("!");
    expect(
      badgeFor({ helper: READY, state: stateIn("disconnected", { error: "x" }), error: null }).text,
    ).toBe("!");
  });

  it("is empty while the helper starts", () => {
    expect(badgeFor({ helper: { kind: "starting" }, state: null, error: null }).text).toBe("");
  });

  it("shows ON when connected and EXIT when the exit node is active", () => {
    expect(badgeFor({ helper: READY, state: stateIn("connected"), error: null }).text).toBe("ON");
    const exit = stateIn("connected", {
      exitNode: { siteResourceId: 1, name: "Gateway", active: true },
    });
    expect(badgeFor({ helper: READY, state: exit, error: null }).text).toBe("EXIT");
  });

  it("shows a pending marker while connecting", () => {
    expect(badgeFor({ helper: READY, state: stateIn("connecting"), error: null }).text).toBe("...");
  });

  it("is empty when disconnected or logged out", () => {
    expect(badgeFor({ helper: READY, state: stateIn("disconnected"), error: null }).text).toBe("");
    expect(badgeFor({ helper: READY, state: stateIn("loggedOut"), error: null }).text).toBe("");
  });
});

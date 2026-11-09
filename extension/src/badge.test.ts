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
    expect(badgeFor({ helper: { kind: "notInstalled" }, state: null, error: null, mode: null }).text).toBe("!");
    expect(
      badgeFor({ helper: { kind: "failed", message: "x" }, state: null, error: null, mode: "failClosed" }).text,
    ).toBe("!");
  });

  it("shows an error for a routing or connect failure, or a state error", () => {
    expect(
      badgeFor({ helper: READY, state: stateIn("disconnected"), error: "x", mode: null }).text,
    ).toBe("!");
    expect(
      badgeFor({
        helper: READY,
        state: stateIn("disconnected", { error: "x" }),
        error: null,
        mode: "failClosed",
      }).text,
    ).toBe("!");
  });

  it("shows STOP while the fail-closed PAC is in effect, even before the helper is ready", () => {
    expect(badgeFor({ helper: { kind: "starting" }, state: null, error: null, mode: "failClosed" }).text).toBe(
      "STOP",
    );
    expect(badgeFor({ helper: READY, state: stateIn("connecting"), error: null, mode: "failClosed" }).text).toBe(
      "STOP",
    );
  });

  it("shows ON when the connected PAC is in effect and no exit node is chosen", () => {
    expect(badgeFor({ helper: READY, state: stateIn("connected"), error: null, mode: "connected" }).text).toBe(
      "ON",
    );
  });

  it("shows EXIT when the exit node is active and STOP while it is chosen but not active", () => {
    const active = stateIn("connected", {
      exitNode: { siteResourceId: 1, name: "Gateway", active: true },
    });
    expect(badgeFor({ helper: READY, state: active, error: null, mode: "connected" }).text).toBe("EXIT");
    const pending = stateIn("connected", {
      exitNode: { siteResourceId: 1, name: "Gateway", active: false },
    });
    expect(badgeFor({ helper: READY, state: pending, error: null, mode: "connected" }).text).toBe("STOP");
  });

  it("never shows ON or EXIT while the proxy is clear or was not written", () => {
    const connected = stateIn("connected");
    expect(badgeFor({ helper: READY, state: connected, error: null, mode: "clear" }).text).toBe("");
    expect(badgeFor({ helper: READY, state: connected, error: null, mode: null }).text).toBe("");
  });

  it("is empty when the user has turned the connection off", () => {
    expect(badgeFor({ helper: READY, state: stateIn("disconnected"), error: null, mode: "clear" }).text).toBe("");
    expect(badgeFor({ helper: READY, state: stateIn("loggedOut"), error: null, mode: "clear" }).text).toBe("");
  });
});

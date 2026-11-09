import { describe, expect, it } from "vitest";
import type { Phase, State } from "./protocol";
import { FAIL_CLOSED_PROXY, lastConnectedFrom, planRouting, type ProxyMode } from "./routing";

const routes = { hosts: ["app.internal"], cidrs: ["10.20.0.0/16"] };

function stateIn(phase: Phase, exitActive = true): State {
  return {
    phase,
    orgs: [],
    sites: [],
    routes,
    exitNode: { siteResourceId: 7, name: "Gateway", active: exitActive },
  };
}

// Each row: phase, wantConnected, helperReady, expected mode.
const TABLE: Array<[Phase, boolean, boolean, ProxyMode]> = [
  ["loggedOut", false, false, "clear"],
  ["loggedOut", false, true, "clear"],
  ["loggedOut", true, false, "failClosed"],
  ["loggedOut", true, true, "failClosed"],
  ["loggingIn", false, false, "clear"],
  ["loggingIn", false, true, "clear"],
  ["loggingIn", true, false, "failClosed"],
  ["loggingIn", true, true, "failClosed"],
  ["disconnected", false, false, "clear"],
  ["disconnected", false, true, "clear"],
  ["disconnected", true, false, "failClosed"],
  ["disconnected", true, true, "failClosed"],
  ["connecting", false, false, "clear"],
  ["connecting", false, true, "clear"],
  ["connecting", true, false, "failClosed"],
  ["connecting", true, true, "failClosed"],
  ["connected", false, false, "clear"],
  ["connected", false, true, "clear"],
  ["connected", true, false, "failClosed"],
  ["connected", true, true, "connected"],
];

describe("planRouting mode", () => {
  it.each(TABLE)(
    "phase %s, wantConnected %s, helperReady %s -> %s",
    (phase, wantConnected, helperReady, mode) => {
      const plan = planRouting({
        wantConnected,
        helperReady,
        proxyPort: 8123,
        state: stateIn(phase),
        lastConnected: null,
      });
      expect(plan.mode).toBe(mode);
      expect(plan.pac === null).toBe(mode === "clear");
    },
  );

  it("sends no PAC after the user disconnects, even if the helper still reports connected", () => {
    const plan = planRouting({
      wantConnected: false,
      helperReady: true,
      proxyPort: 8123,
      state: stateIn("connected"),
      lastConnected: null,
    });
    expect(plan).toEqual({ mode: "clear", pac: null });
  });

  it("treats a ready helper without a port as not connected", () => {
    const plan = planRouting({
      wantConnected: true,
      helperReady: true,
      proxyPort: null,
      state: stateIn("connected"),
      lastConnected: null,
    });
    expect(plan.mode).toBe("failClosed");
  });
});

describe("planRouting PAC", () => {
  it("routes through the helper port with the live routes", () => {
    const plan = planRouting({
      wantConnected: true,
      helperReady: true,
      proxyPort: 8123,
      state: stateIn("connected", false),
      lastConnected: null,
    });
    expect(plan.pac).toContain('var proxy = "PROXY 127.0.0.1:8123";');
    expect(plan.pac).toContain('var hosts = ["app.internal"];');
    expect(plan.pac).toContain('var cidrs = [{"network":"10.20.0.0","mask":"255.255.0.0"}];');
    expect(plan.pac).toContain("var exitNodeActive = false;");
  });

  it("fails closed with the last connected routes and exit node flag", () => {
    const plan = planRouting({
      wantConnected: true,
      helperReady: false,
      proxyPort: null,
      state: null,
      lastConnected: { routes, exitNodeActive: true },
    });
    expect(plan.pac).toContain(`var proxy = "${FAIL_CLOSED_PROXY}";`);
    expect(plan.pac).toContain('var hosts = ["app.internal"];');
    expect(plan.pac).toContain("var exitNodeActive = true;");
  });

  it("fails closed with no routes when the helper was never connected in this profile", () => {
    const plan = planRouting({
      wantConnected: true,
      helperReady: false,
      proxyPort: null,
      state: null,
      lastConnected: null,
    });
    expect(plan.pac).toContain("var hosts = [];");
    expect(plan.pac).toContain("var cidrs = [];");
    expect(plan.pac).toContain("var exitNodeActive = false;");
  });
});

describe("lastConnectedFrom", () => {
  it("copies the routes of a connected state", () => {
    const source = stateIn("connected", true);
    const saved = lastConnectedFrom(source);
    expect(saved).toEqual({ routes, exitNodeActive: true });
    expect(saved?.routes).not.toBe(source.routes);
  });

  it("returns null when the state is not connected", () => {
    expect(lastConnectedFrom(stateIn("connecting"))).toBeNull();
    expect(lastConnectedFrom(null)).toBeNull();
  });
});

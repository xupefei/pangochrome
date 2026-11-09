import { describe, expect, it } from "vitest";
import type { Phase, State } from "./protocol";
import {
  exitNodeChosen,
  FAIL_CLOSED_PROXY,
  lastConnectedFrom,
  planRouting,
  type LastConnected,
  type ProxyMode,
} from "./routing";

const routes = { hosts: ["app.internal"], cidrs: ["10.20.0.0/16"] };

function stateIn(phase: Phase, exitActive: boolean | null = true): State {
  return {
    phase,
    orgs: [],
    sites: [],
    routes,
    exitNode:
      exitActive === null ? undefined : { siteResourceId: 7, name: "Gateway", active: exitActive },
  };
}

const LAST: LastConnected = { routes, exitNodeChosen: true };

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

  it("sends no PAC and no WebRTC policy after the user disconnects", () => {
    const plan = planRouting({
      wantConnected: false,
      helperReady: true,
      proxyPort: 8123,
      state: stateIn("connected"),
      lastConnected: null,
    });
    expect(plan).toEqual({ mode: "clear", pac: null, catchAll: false, webRtc: "default" });
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
      state: stateIn("connected", null),
      lastConnected: null,
    });
    expect(plan.pac).toContain('var proxy = "PROXY 127.0.0.1:8123";');
    expect(plan.pac).toContain('var hosts = ["app.internal"];');
    expect(plan.pac).toContain('var cidrs = [{"network":"10.20.0.0","mask":"255.255.0.0"}];');
    expect(plan.pac).toContain("var catchAll = false;");
  });

  it("applies the catch-all to a chosen exit node that is not active yet", () => {
    const plan = planRouting({
      wantConnected: true,
      helperReady: true,
      proxyPort: 8123,
      state: stateIn("connected", false),
      lastConnected: null,
    });
    expect(plan.catchAll).toBe(true);
    expect(plan.pac).toContain("var catchAll = true;");
  });

  it("fails closed with the last connected routes when the helper is down", () => {
    const plan = planRouting({
      wantConnected: true,
      helperReady: false,
      proxyPort: null,
      state: null,
      lastConnected: LAST,
    });
    expect(plan.pac).toContain(`var proxy = "${FAIL_CLOSED_PROXY}";`);
    expect(plan.pac).toContain('var hosts = ["app.internal"];');
    expect(plan.pac).toContain("var catchAll = true;");
  });

  it("fails closed with no routes when no connection was made in this profile", () => {
    const plan = planRouting({
      wantConnected: true,
      helperReady: false,
      proxyPort: null,
      state: null,
      lastConnected: null,
    });
    expect(plan.pac).toContain("var hosts = [];");
    expect(plan.pac).toContain("var cidrs = [];");
    expect(plan.pac).toContain("var catchAll = false;");
  });

  it("takes the exit node choice from the current state when one exists", () => {
    // Choosing None while disconnected must lift the catch-all, even if the last connected state had an exit node.
    const plan = planRouting({
      wantConnected: true,
      helperReady: true,
      proxyPort: 8123,
      state: stateIn("disconnected", null),
      lastConnected: LAST,
    });
    expect(plan.mode).toBe("failClosed");
    expect(plan.catchAll).toBe(false);
    expect(plan.pac).toContain("var catchAll = false;");
    expect(plan.pac).toContain('var hosts = ["app.internal"];');
  });

  it("keeps the catch-all when the current state has an exit node while disconnected", () => {
    const plan = planRouting({
      wantConnected: true,
      helperReady: false,
      proxyPort: null,
      state: stateIn("disconnected", false),
      lastConnected: { routes, exitNodeChosen: false },
    });
    expect(plan.catchAll).toBe(true);
    expect(plan.pac).toContain("var catchAll = true;");
  });
});

describe("planRouting WebRTC policy", () => {
  it("disables non-proxied UDP while wanted and an exit node is chosen", () => {
    const plan = planRouting({
      wantConnected: true,
      helperReady: true,
      proxyPort: 8123,
      state: stateIn("connecting", false),
      lastConnected: null,
    });
    expect(plan.webRtc).toBe("disable_non_proxied_udp");
  });

  it("uses the last connected flag when there is no state", () => {
    const plan = planRouting({
      wantConnected: true,
      helperReady: false,
      proxyPort: null,
      state: null,
      lastConnected: LAST,
    });
    expect(plan.webRtc).toBe("disable_non_proxied_udp");
  });

  it("clears the policy when no exit node is chosen", () => {
    const plan = planRouting({
      wantConnected: true,
      helperReady: true,
      proxyPort: 8123,
      state: stateIn("connected", null),
      lastConnected: null,
    });
    expect(plan.webRtc).toBe("default");
  });

  it("clears the policy when the user has turned the connection off", () => {
    const plan = planRouting({
      wantConnected: false,
      helperReady: true,
      proxyPort: 8123,
      state: stateIn("connected", true),
      lastConnected: LAST,
    });
    expect(plan.webRtc).toBe("default");
  });
});

describe("exitNodeChosen", () => {
  it("reads the current state when there is one", () => {
    expect(exitNodeChosen(stateIn("disconnected", true), LAST)).toBe(true);
    expect(exitNodeChosen(stateIn("disconnected", null), LAST)).toBe(false);
  });

  it("reads the last connected state when there is no state", () => {
    expect(exitNodeChosen(null, LAST)).toBe(true);
    expect(exitNodeChosen(null, null)).toBe(false);
  });
});

describe("lastConnectedFrom", () => {
  it("copies the routes of a connected state and records that an exit node is chosen", () => {
    const source = stateIn("connected", false);
    const saved = lastConnectedFrom(source, null);
    expect(saved).toEqual({ routes, exitNodeChosen: true });
    expect(saved.routes).not.toBe(source.routes);
  });

  it("records no exit node when none is chosen", () => {
    expect(lastConnectedFrom(stateIn("connected", null), null)).toEqual({
      routes,
      exitNodeChosen: false,
    });
  });

  it("keeps the previous routes but takes the exit-node choice from a state that is not connected", () => {
    const previous: LastConnected = { routes, exitNodeChosen: false };
    expect(lastConnectedFrom(stateIn("connecting", false), previous)).toEqual({
      routes,
      exitNodeChosen: true,
    });
    expect(lastConnectedFrom(stateIn("loggedOut", null), { routes, exitNodeChosen: true })).toEqual({
      routes,
      exitNodeChosen: false,
    });
  });

  it("records the exit-node choice before the first connected state", () => {
    expect(lastConnectedFrom(stateIn("connecting", false), null)).toEqual({
      routes: { hosts: [], cidrs: [] },
      exitNodeChosen: true,
    });
  });
});

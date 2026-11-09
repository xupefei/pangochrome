import { describe, expect, it } from "vitest";
import { isExitNodeList, isHello, isState } from "./protocol";

const minimal = { phase: "disconnected", orgs: [], sites: [], routes: { hosts: [], cidrs: [] } };

describe("isState", () => {
  it("accepts a minimal state", () => {
    expect(isState(minimal)).toBe(true);
  });

  it("accepts a full connected state", () => {
    expect(
      isState({
        phase: "connected",
        server: "https://app.pangolin.net",
        user: { email: "a@example.com" },
        orgs: [{ orgId: "o1", name: "Org" }],
        orgId: "o1",
        sites: [{ siteId: 1, name: "Site", connected: true, relayed: false, aliases: ["app.internal"] }],
        routes: { hosts: ["app.internal"], cidrs: ["10.0.0.0/8"] },
        exitNode: { siteResourceId: 7, name: "Gateway", active: false },
      }),
    ).toBe(true);
  });

  it("accepts null for optional fields", () => {
    expect(isState({ ...minimal, exitNode: null, orgId: null, error: null, login: null })).toBe(true);
  });

  it("rejects an unknown phase", () => {
    expect(isState({ ...minimal, phase: "bogus" })).toBe(false);
  });

  it("rejects a missing routes object", () => {
    const { routes: _routes, ...withoutRoutes } = minimal;
    expect(isState(withoutRoutes)).toBe(false);
  });

  it("rejects a route list that is not all strings", () => {
    expect(isState({ ...minimal, routes: { hosts: ["a", 3], cidrs: [] } })).toBe(false);
  });

  it("rejects a site whose aliases are not strings", () => {
    const sites = [{ siteId: 1, name: "S", connected: true, relayed: false, aliases: [null] }];
    expect(isState({ ...minimal, sites })).toBe(false);
  });

  it("rejects an exit node without an active flag", () => {
    expect(isState({ ...minimal, exitNode: { siteResourceId: 1, name: "G" } })).toBe(false);
  });

  it("rejects a non-object", () => {
    expect(isState("connected")).toBe(false);
    expect(isState(null)).toBe(false);
  });
});

describe("isHello", () => {
  const proxy = { host: "127.0.0.1", port: 8123, username: "u", password: "p" };

  it("accepts a proxy with a valid port and credentials", () => {
    expect(isHello({ version: "0.1.0", proxy })).toBe(true);
  });

  it.each([0, 65536, 1.5, "8123"])("rejects port %j", (port) => {
    expect(isHello({ version: "0.1.0", proxy: { ...proxy, port } })).toBe(false);
  });

  it("rejects missing credentials", () => {
    expect(isHello({ version: "0.1.0", proxy: { host: "127.0.0.1", port: 8123, username: "u" } })).toBe(false);
  });
});

describe("isExitNodeList", () => {
  const node = { siteResourceId: 1, name: "Gateway", siteNames: ["Site"], online: true };

  it("accepts an empty list and a valid list", () => {
    expect(isExitNodeList([])).toBe(true);
    expect(isExitNodeList([node])).toBe(true);
  });

  it("rejects a non-array and an entry with a missing field", () => {
    expect(isExitNodeList({ nodes: [node] })).toBe(false);
    expect(isExitNodeList([{ ...node, online: undefined }])).toBe(false);
  });
});

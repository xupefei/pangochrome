import { describe, expect, it } from "vitest";
import { buildPac } from "./pac";

const PROXY = "PROXY 127.0.0.1:8123";
const BLOCKED = "PROXY 127.0.0.1:1";

/** The same octet check as the PAC. A host that fails it is a name, so isInNet must not see it. */
const STRICT_IPV4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/;

function ipv4(text: string): number {
  return text.split(".").reduce((acc, octet) => acc * 256 + Number(octet), 0);
}

/** Chromium's shExpMatch: escape ".", "*" to ".*", "?" to ".", anchor, and use a RegExp for the rest. */
function chromiumShExpMatch(value: string, pattern: string): boolean {
  const source = pattern.replace(/\./g, "\\.").replace(/\*/g, ".*").replace(/\?/g, ".");
  return new RegExp(`^${source}$`).test(value);
}

// isInNet throws for a name, because a real PAC engine would resolve that name in DNS.
const defaultShims: Record<string, (...args: never[]) => unknown> = {
  shExpMatch: chromiumShExpMatch,
  isInNet: (host: string, pattern: string, mask: string): boolean => {
    if (!STRICT_IPV4.test(host)) throw new Error(`isInNet called with a name: ${host}`);
    const m = ipv4(mask);
    return ((ipv4(host) & m) >>> 0) === ((ipv4(pattern) & m) >>> 0);
  },
  isPlainHostName: (host: string): boolean => !host.includes("."),
  dnsDomainIs: (host: string, domain: string): boolean => host.endsWith(domain),
  dnsResolve: (): never => {
    throw new Error("dnsResolve must not be called");
  },
};

function evaluate(
  pac: string,
  host: string,
  overrides: Partial<Record<keyof typeof defaultShims, unknown>> = {},
): string {
  const shims = { ...defaultShims, ...overrides };
  const fn = new Function(
    ...Object.keys(shims),
    "testHost",
    `${pac}\nreturn FindProxyForURL("http://" + testHost + "/", testHost);`,
  ) as (...args: unknown[]) => string;
  return fn(...Object.values(shims), host);
}

describe("buildPac", () => {
  describe("alias routes", () => {
    const pac = buildPac({
      proxy: PROXY,
      routes: { hosts: ["app.internal"], cidrs: [] },
      catchAll: false,
    });

    it("matches an exact alias, ignoring case and a trailing dot", () => {
      expect(evaluate(pac, "app.internal")).toBe(PROXY);
      expect(evaluate(pac, "APP.Internal.")).toBe(PROXY);
    });

    it("does not match a longer or shorter name", () => {
      expect(evaluate(pac, "x.app.internal")).toBe("DIRECT");
      expect(evaluate(pac, "app.internal.evil")).toBe("DIRECT");
    });

    it("matches a wildcard alias, including names with more labels", () => {
      const wild = buildPac({
        proxy: PROXY,
        routes: { hosts: ["*.corp.example"], cidrs: [] },
        catchAll: false,
      });
      expect(evaluate(wild, "a.corp.example")).toBe(PROXY);
      expect(evaluate(wild, "a.b.corp.example")).toBe(PROXY);
      expect(evaluate(wild, "corp.example")).toBe("DIRECT");
    });

    it("matches a single-character wildcard", () => {
      const single = buildPac({
        proxy: PROXY,
        routes: { hosts: ["app?.internal"], cidrs: [] },
        catchAll: false,
      });
      expect(evaluate(single, "app1.internal")).toBe(PROXY);
      expect(evaluate(single, "app12.internal")).toBe("DIRECT");
      expect(evaluate(single, "app.internal")).toBe("DIRECT");
    });

    it("normalises and de-duplicates the host list", () => {
      const messy = buildPac({
        proxy: PROXY,
        routes: { hosts: [" App.Internal. ", "app.internal", ""], cidrs: [] },
        catchAll: false,
      });
      expect(messy).toContain('var hosts = ["app.internal"];');
    });

    it("drops route hosts with characters that shExpMatch would read as regex syntax", () => {
      const risky = buildPac({
        proxy: PROXY,
        routes: { hosts: ["app(1.internal", "a|b", "ok.internal"], cidrs: [] },
        catchAll: false,
      });
      expect(risky).toContain('var hosts = ["ok.internal"];');
      expect(evaluate(risky, "a|b")).toBe("DIRECT");
      expect(evaluate(risky, "ok.internal")).toBe(PROXY);
    });

    it("returns the proxy when a host pattern cannot be evaluated", () => {
      const throwing = () => {
        throw new SyntaxError("Invalid regular expression");
      };
      expect(evaluate(pac, "example.com", { shExpMatch: throwing })).toBe(PROXY);
    });
  });

  describe("IPv4 literal routes", () => {
    it("sends an address inside a route CIDR to the proxy", () => {
      const pac = buildPac({
        proxy: PROXY,
        routes: { hosts: [], cidrs: ["10.20.0.0/16"] },
        catchAll: false,
      });
      expect(evaluate(pac, "10.20.5.5")).toBe(PROXY);
      expect(evaluate(pac, "10.21.0.1")).toBe("DIRECT");
    });

    it("uses the network part of a CIDR that has host bits set", () => {
      const pac = buildPac({
        proxy: PROXY,
        routes: { hosts: [], cidrs: ["10.20.5.5/16"] },
        catchAll: false,
      });
      expect(evaluate(pac, "10.20.200.1")).toBe(PROXY);
    });

    it("matches a single address with /32", () => {
      const pac = buildPac({
        proxy: PROXY,
        routes: { hosts: [], cidrs: ["100.96.128.5/32"] },
        catchAll: false,
      });
      expect(evaluate(pac, "100.96.128.5")).toBe(PROXY);
      expect(evaluate(pac, "100.96.128.6")).toBe("DIRECT");
    });

    it("does not call isInNet for a name that looks like an address", () => {
      const pac = buildPac({
        proxy: PROXY,
        routes: { hosts: [], cidrs: ["10.20.0.0/16"] },
        catchAll: false,
      });
      expect(evaluate(pac, "10.20.5.5.nip.io")).toBe("DIRECT");
    });

    it("does not call isInNet for an out-of-range address such as 256.1.1.1", () => {
      const pac = buildPac({
        proxy: PROXY,
        routes: { hosts: [], cidrs: ["10.0.0.0/8"] },
        catchAll: true,
      });
      // The name goes through the catch-all, so the strict isInNet shim would throw if it were called.
      expect(evaluate(pac, "256.1.1.1")).toBe(PROXY);
      expect(evaluate(pac, "999.1.1.1")).toBe(PROXY);
    });

    it("drops malformed CIDRs", () => {
      const pac = buildPac({
        proxy: PROXY,
        routes: {
          hosts: [],
          cidrs: ["10.20.0.0/33", "10.20.0.0", "300.0.0.0/8", "10.0.0.0/8/8", "10.0.0.0/-1"],
        },
        catchAll: false,
      });
      expect(pac).toContain("var cidrs = [];");
    });
  });

  describe("exit node catch-all", () => {
    const pac = buildPac({ proxy: PROXY, routes: { hosts: [], cidrs: [] }, catchAll: true });

    it("sends other hosts and public addresses to the proxy", () => {
      expect(evaluate(pac, "example.com")).toBe(PROXY);
      expect(evaluate(pac, "8.8.8.8")).toBe(PROXY);
      expect(evaluate(pac, "2001:db8::1")).toBe(PROXY);
    });

    it("keeps localhost, loopback and link-local destinations direct", () => {
      expect(evaluate(pac, "localhost")).toBe("DIRECT");
      expect(evaluate(pac, "app.localhost")).toBe("DIRECT");
      expect(evaluate(pac, "127.0.0.1")).toBe("DIRECT");
      expect(evaluate(pac, "127.255.0.9")).toBe("DIRECT");
      expect(evaluate(pac, "169.254.10.1")).toBe("DIRECT");
      expect(evaluate(pac, "::1")).toBe("DIRECT");
      expect(evaluate(pac, "[::1]")).toBe("DIRECT");
      expect(evaluate(pac, "[fe80::1]")).toBe("DIRECT");
    });

    it("covers the whole IPv6 link-local range fe80::/10", () => {
      expect(evaluate(pac, "fe81::1")).toBe("DIRECT");
      expect(evaluate(pac, "febf::1")).toBe("DIRECT");
      expect(evaluate(pac, "fec0::1")).toBe(PROXY);
    });

    it("keeps RFC 1918 addresses direct and sends the rest of 172.x to the proxy", () => {
      expect(evaluate(pac, "10.1.2.3")).toBe("DIRECT");
      expect(evaluate(pac, "172.16.0.1")).toBe("DIRECT");
      expect(evaluate(pac, "172.31.255.255")).toBe("DIRECT");
      expect(evaluate(pac, "172.32.0.1")).toBe(PROXY);
      expect(evaluate(pac, "192.168.1.1")).toBe("DIRECT");
    });

    it("lets a route CIDR win over the local exceptions", () => {
      const routed = buildPac({
        proxy: PROXY,
        routes: { hosts: [], cidrs: ["10.20.0.0/16"] },
        catchAll: true,
      });
      expect(evaluate(routed, "10.20.5.5")).toBe(PROXY);
      expect(evaluate(routed, "10.30.0.1")).toBe("DIRECT");
    });

    it("sends everything direct except the routes when no exit node is chosen", () => {
      const off = buildPac({
        proxy: PROXY,
        routes: { hosts: ["app.internal"], cidrs: [] },
        catchAll: false,
      });
      expect(evaluate(off, "example.com")).toBe("DIRECT");
      expect(evaluate(off, "app.internal")).toBe(PROXY);
    });
  });

  describe("fail-closed PAC", () => {
    const routes = { hosts: ["app.internal"], cidrs: ["10.20.0.0/16"] };

    it("sends routed hosts and all other hosts to the blocked port when an exit node is chosen", () => {
      const pac = buildPac({ proxy: BLOCKED, routes, catchAll: true });
      expect(evaluate(pac, "app.internal")).toBe(BLOCKED);
      expect(evaluate(pac, "10.20.1.1")).toBe(BLOCKED);
      expect(evaluate(pac, "example.com")).toBe(BLOCKED);
      expect(evaluate(pac, "localhost")).toBe("DIRECT");
    });

    it("sends only routed hosts to the blocked port without an exit node", () => {
      const pac = buildPac({ proxy: BLOCKED, routes, catchAll: false });
      expect(evaluate(pac, "app.internal")).toBe(BLOCKED);
      expect(evaluate(pac, "10.20.1.1")).toBe(BLOCKED);
      expect(evaluate(pac, "example.com")).toBe("DIRECT");
    });
  });

  it("escapes U+2028 and U+2029 in the proxy string", () => {
    const pac = buildPac({
      proxy: "PROXY 127.0.0.1:1\u2028\u2029",
      routes: { hosts: [], cidrs: [] },
      catchAll: false,
    });
    expect(pac).not.toContain("\u2028");
    expect(pac).not.toContain("\u2029");
    expect(pac).toContain("\\u2028\\u2029");
  });

  it("uses only ES5 syntax", () => {
    const pac = buildPac({
      proxy: PROXY,
      routes: { hosts: ["*.corp.example"], cidrs: ["10.0.0.0/8"] },
      catchAll: true,
    });
    expect(pac).not.toMatch(/\b(let|const)\b|=>/);
  });
});

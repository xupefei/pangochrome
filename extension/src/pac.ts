import type { Routes } from "./protocol";

export interface PacInput {
  /** Returned for matched hosts, for example "PROXY 127.0.0.1:8123" or "DIRECT". */
  proxy: string;
  routes: Routes;
  /** True when an exit node is chosen. Every host except the local exceptions then goes to the proxy. */
  catchAll: boolean;
}

interface CidrRule {
  network: string;
  mask: string;
}

/** Characters that Chrome's shExpMatch accepts in a route host. Other characters are regex syntax to it. */
const ROUTE_HOST_PATTERN = /^[a-z0-9._*?-]+$/;

/**
 * Builds a PAC script with the routing rules from docs/PROTOCOL.md.
 * The script uses ES5 only, because PAC engines do not all support newer syntax.
 * isInNet is called only for strict IPv4 literals. Otherwise the PAC engine resolves the name in DNS.
 */
export function buildPac(input: PacInput): string {
  const hosts = normaliseHosts(input.routes.hosts);
  const cidrs = normaliseCidrs(input.routes.cidrs);
  return [
    "function FindProxyForURL(url, host) {",
    `  var proxy = ${literal(input.proxy)};`,
    `  var hosts = ${literal(hosts)};`,
    `  var cidrs = ${literal(cidrs)};`,
    `  var catchAll = ${input.catchAll ? "true" : "false"};`,
    ...PAC_BODY,
    "}",
  ].join("\n");
}

const PAC_BODY = [
  "  host = host.toLowerCase();",
  '  if (host.charAt(0) === "[" && host.charAt(host.length - 1) === "]") host = host.slice(1, -1);',
  '  if (host.charAt(host.length - 1) === ".") host = host.slice(0, -1);',
  "  for (var i = 0; i < hosts.length; i++) {",
  "    try {",
  "      if (shExpMatch(host, hosts[i])) return proxy;",
  "    } catch (e) {",
  "      // A pattern that cannot be evaluated sends the request to the helper, which refuses it.",
  "      return proxy;",
  "    }",
  "  }",
  String.raw`  var isIPv4 = /^(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)(\.(25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)){3}$/.test(host);`,
  "  if (isIPv4) {",
  "    for (var j = 0; j < cidrs.length; j++) {",
  "      if (isInNet(host, cidrs[j].network, cidrs[j].mask)) return proxy;",
  "    }",
  "  }",
  '  if (!catchAll) return "DIRECT";',
  '  if (isLocalAddress(host, isIPv4)) return "DIRECT";',
  "  return proxy;",
  "}",
  "",
  "function isLocalAddress(host, isIPv4) {",
  '  if (host === "localhost" || dnsDomainIs(host, ".localhost")) return true;',
  "  if (isIPv4) {",
  '    return isInNet(host, "127.0.0.0", "255.0.0.0") ||',
  '      isInNet(host, "169.254.0.0", "255.255.0.0") ||',
  '      isInNet(host, "10.0.0.0", "255.0.0.0") ||',
  '      isInNet(host, "172.16.0.0", "255.240.0.0") ||',
  '      isInNet(host, "192.168.0.0", "255.255.0.0");',
  "  }",
  '  return host === "::1" || /^fe[89ab][0-9a-f]:/.test(host);',
];

/** JSON with U+2028 and U+2029 escaped. Those characters are not allowed in ES5 string literals. */
function literal(value: unknown): string {
  return JSON.stringify(value).split(String.fromCharCode(0x2028)).join("\\u2028").split(String.fromCharCode(0x2029)).join("\\u2029");
}

function normaliseHosts(hosts: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of hosts) {
    if (typeof raw !== "string") continue;
    const host = raw.trim().toLowerCase().replace(/\.$/, "");
    if (!host || seen.has(host) || !ROUTE_HOST_PATTERN.test(host)) continue;
    seen.add(host);
    out.push(host);
  }
  return out;
}

function normaliseCidrs(cidrs: readonly string[]): CidrRule[] {
  const out: CidrRule[] = [];
  for (const raw of cidrs) {
    if (typeof raw !== "string") continue;
    const [addressText = "", prefixText = "", extra] = raw.trim().split("/");
    if (extra !== undefined || !/^\d{1,2}$/.test(prefixText)) continue;
    const address = parseIPv4(addressText);
    const prefix = Number(prefixText);
    if (address === null || prefix > 32) continue;
    const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
    out.push({
      network: formatIPv4((address & mask) >>> 0),
      mask: formatIPv4(mask),
    });
  }
  return out;
}

function parseIPv4(text: string): number | null {
  const octets = text.split(".");
  if (octets.length !== 4) return null;
  let value = 0;
  for (const octet of octets) {
    if (!/^\d{1,3}$/.test(octet)) return null;
    const n = Number(octet);
    if (n > 255) return null;
    value = value * 256 + n;
  }
  return value;
}

function formatIPv4(value: number): string {
  return [
    (value >>> 24) & 255,
    (value >>> 16) & 255,
    (value >>> 8) & 255,
    value & 255,
  ].join(".");
}

import { describe, expect, it } from "vitest";
import { isHttpUrl, isPlainHostname } from "./url";

describe("isHttpUrl", () => {
  it.each([
    "https://app.pangolin.net/device",
    "http://pangolin.internal/x",
    "HTTPS://APP.EXAMPLE/",
  ])("accepts %s", (url) => {
    expect(isHttpUrl(url)).toBe(true);
  });

  it.each([
    "javascript:alert(1)",
    "file:///etc/passwd",
    "ftp://example.com/",
    "https://",
    " https://example.com/",
    "",
  ])("rejects %j", (url) => {
    expect(isHttpUrl(url)).toBe(false);
  });
});

describe("isPlainHostname", () => {
  it.each(["app.internal", "APP.internal", "a-b_c.example"])("accepts %s", (host) => {
    expect(isPlainHostname(host)).toBe(true);
  });

  it.each(["*.corp.example", "app?.internal", "app(1.internal", "a|b", "", "app internal"])(
    "rejects %j",
    (host) => {
      expect(isPlainHostname(host)).toBe(false);
    },
  );
});

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

function readJson(url: URL): Record<string, unknown> {
  return JSON.parse(readFileSync(url, "utf8")) as Record<string, unknown>;
}

const manifest = readJson(new URL("../static/manifest.json", import.meta.url));
const ids = readJson(new URL("../../config/ids.json", import.meta.url));

describe("static/manifest.json", () => {
  it("uses the fixed extension key from config/ids.json", () => {
    expect(manifest["key"]).toBe(ids["chromeExtensionKey"]);
  });

  it("declares the MV3 worker, popup and permissions", () => {
    expect(manifest["manifest_version"]).toBe(3);
    expect(manifest["background"]).toEqual({ service_worker: "background.js", type: "module" });
    expect(manifest["action"]).toMatchObject({ default_popup: "popup.html" });
    expect(manifest["permissions"]).toEqual([
      "nativeMessaging",
      "privacy",
      "proxy",
      "storage",
      "webRequest",
      "webRequestAuthProvider",
    ]);
    expect(manifest["host_permissions"]).toEqual(["<all_urls>"]);
  });

  it("requires Chrome 120, which the extension's APIs need", () => {
    expect(manifest["minimum_chrome_version"]).toBe("120");
  });
});

import { describe, expect, it } from "vitest";
import { helperRunsOn, helperUpdateNeeded, installCommand } from "./install";

const ID = "lioplghkjopgaienllcabfmfehgkjgfh";

describe("installCommand", () => {
  it("installs the release for the extension's version and allows its ID", () => {
    expect(installCommand("0.1.0", ID)).toBe(
      "curl -fsSL https://github.com/xupefei/pangochrome/releases/download/v0.1.0/install.sh" +
        ` | sh -s -- --extension-id ${ID}`,
    );
  });

  it("refuses values that are not a release version or an extension ID", () => {
    expect(installCommand("0.1", ID)).toBeNull();
    expect(installCommand("0.1.0; rm -rf ~", ID)).toBeNull();
    expect(installCommand("0.1.0", "not-an-id")).toBeNull();
    expect(installCommand("0.1.0", `${ID} --uninstall`)).toBeNull();
  });
});

describe("helperRunsOn", () => {
  it("is true for macOS and Linux only", () => {
    expect(helperRunsOn("mac")).toBe(true);
    expect(helperRunsOn("linux")).toBe(true);
    expect(helperRunsOn("win")).toBe(false);
    expect(helperRunsOn("cros")).toBe(false);
  });
});

describe("helperUpdateNeeded", () => {
  it.each([
    ["v0.1.0", "0.1.0", false],
    ["v0.1.0", "0.2.0", true],
    ["v0.2.0", "0.1.0", false],
    ["v0.9.0", "0.10.0", true],
    ["v1.0.0", "0.10.0", false],
    ["dev", "0.2.0", false],
    ["v0.1.0-3-gabc1234", "0.2.0", false],
    ["0.1.0", "0.2.0", false],
    ["v0.1", "0.2.0", false],
    ["", "0.2.0", false],
  ])("helper %j with extension %j -> %s", (helperVersion, extensionVersion, expected) => {
    expect(helperUpdateNeeded(helperVersion, extensionVersion)).toBe(expected);
  });
});

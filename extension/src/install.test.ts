import { describe, expect, it } from "vitest";
import { helperRunsOn, installCommand } from "./install";

const ID = "lioplghkjopgaienllcabfmfehgkjgfh";

describe("installCommand", () => {
  it("installs the release with the extension's version and allows its ID", () => {
    expect(installCommand("0.1.0", ID)).toBe(
      "curl -fsSL https://github.com/xupefei/pangochrome/releases/download/v0.1.0/install.sh" +
        ` | sh -s -- --version v0.1.0 --extension-id ${ID}`,
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

import { describe, expect, it } from "vitest";
import { controlMessage } from "./proxy-settings";

describe("controlMessage", () => {
  it("returns null when this extension controls the setting", () => {
    expect(controlMessage("controlled_by_this_extension")).toBeNull();
  });

  it("names the other extension when another one controls the setting", () => {
    expect(controlMessage("controlled_by_other_extensions")).toBe(
      "Another extension controls the proxy settings.",
    );
  });

  it("names the policy when a browser policy controls the setting", () => {
    expect(controlMessage("not_controllable")).toBe("A browser policy controls the proxy settings.");
  });

  it("uses a neutral message for a level it does not know", () => {
    expect(controlMessage("controllable_by_this_extension")).toBe(
      "The browser did not apply the proxy settings.",
    );
  });
});

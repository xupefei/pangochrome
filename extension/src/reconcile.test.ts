import { describe, expect, it } from "vitest";
import { reconcileFor, retryDelayMs } from "./reconcile";

describe("reconcileFor when the user wants the connection off", () => {
  it.each([
    ["connected", true, { kind: "disconnect" }],
    ["connecting", true, { kind: "disconnect" }],
    ["connected", false, { kind: "none" }],
    ["disconnected", true, { kind: "none" }],
    ["loggedOut", true, { kind: "none" }],
  ] as const)("phase %s, helper ready %s -> %j", (phase, helperReady, expected) => {
    expect(
      reconcileFor({ wantConnected: false, helperReady, phase, retryPending: false, streak: 0 }),
    ).toEqual(expected);
  });
});

describe("reconcileFor when the user wants the connection on", () => {
  it("connects at once after a connected state, or at the first attempt", () => {
    expect(
      reconcileFor({ wantConnected: true, helperReady: true, phase: "disconnected", retryPending: false, streak: 0 }),
    ).toEqual({ kind: "connect", delayMs: 0 });
  });

  it("waits with backoff after each failed attempt", () => {
    const delays = [1, 2, 3, 4, 9].map((streak) =>
      reconcileFor({ wantConnected: true, helperReady: true, phase: "disconnected", retryPending: false, streak }),
    );
    expect(delays).toEqual([
      { kind: "connect", delayMs: 2_000 },
      { kind: "connect", delayMs: 5_000 },
      { kind: "connect", delayMs: 10_000 },
      { kind: "connect", delayMs: 30_000 },
      { kind: "connect", delayMs: 30_000 },
    ]);
  });

  it("does not schedule a second attempt while one is pending", () => {
    expect(
      reconcileFor({ wantConnected: true, helperReady: true, phase: "disconnected", retryPending: true, streak: 2 }),
    ).toEqual({ kind: "none" });
  });

  it.each(["connected", "connecting", "loggingIn", "loggedOut", "disconnected"] as const)(
    "does nothing in phase %s while the helper is not ready",
    (phase) => {
      expect(
        reconcileFor({ wantConnected: true, helperReady: false, phase, retryPending: false, streak: 0 }),
      ).toEqual({ kind: "none" });
    },
  );

  it("does nothing while connected or connecting", () => {
    for (const phase of ["connected", "connecting", "loggedOut", "loggingIn"] as const) {
      expect(
        reconcileFor({ wantConnected: true, helperReady: true, phase, retryPending: false, streak: 0 }),
      ).toEqual({ kind: "none" });
    }
  });

  it("does nothing before the first state is known", () => {
    expect(
      reconcileFor({ wantConnected: true, helperReady: true, phase: null, retryPending: false, streak: 0 }),
    ).toEqual({ kind: "none" });
  });
});

describe("retryDelayMs", () => {
  it("has no delay for the first attempt and then backs off", () => {
    expect([0, 1, 2, 3, 4, 5].map(retryDelayMs)).toEqual([0, 2_000, 5_000, 10_000, 30_000, 30_000]);
  });
});

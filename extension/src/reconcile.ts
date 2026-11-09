import type { Phase } from "./protocol";

/** Wait before each reconnect attempt after the first one. The last value repeats. */
export const RETRY_DELAYS_MS: readonly number[] = [2_000, 5_000, 10_000, 30_000];

export interface ReconcileInput {
  wantConnected: boolean;
  helperReady: boolean;
  phase: Phase | null;
  /** True while a delayed connect attempt is waiting to run. */
  retryPending: boolean;
  /** Connect attempts since the last connected state. */
  streak: number;
}

export type Reconcile =
  | { kind: "none" }
  | { kind: "disconnect" }
  | { kind: "connect"; delayMs: number };

/** Decides what the helper should do so that its phase matches the user's intent. */
export function reconcileFor(input: ReconcileInput): Reconcile {
  if (!input.wantConnected) {
    const running = input.phase === "connected" || input.phase === "connecting";
    return input.helperReady && running ? { kind: "disconnect" } : { kind: "none" };
  }
  if (!input.helperReady || input.phase !== "disconnected" || input.retryPending) {
    return { kind: "none" };
  }
  return { kind: "connect", delayMs: retryDelayMs(input.streak) };
}

/** The wait before a connect attempt. The first attempt after a connected state is immediate. */
export function retryDelayMs(streak: number): number {
  if (streak <= 0) return 0;
  const index = Math.min(streak - 1, RETRY_DELAYS_MS.length - 1);
  return RETRY_DELAYS_MS[index] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1] ?? 0;
}

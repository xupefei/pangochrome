import type { HelperStatus } from "./messages";
import type { State } from "./protocol";

export interface BadgeView {
  text: string;
  color: string;
}

const EMPTY: BadgeView = { text: "", color: "#6B6B6B" };
const CONNECTED: BadgeView = { text: "ON", color: "#1E8E3E" };
const EXIT_NODE: BadgeView = { text: "EXIT", color: "#4C78C6" };
const CONNECTING: BadgeView = { text: "...", color: "#6B6B6B" };
const ERROR: BadgeView = { text: "!", color: "#D93025" };

export function badgeFor(input: {
  helper: HelperStatus;
  state: State | null;
  error: string | null;
}): BadgeView {
  const { helper, state } = input;
  if (helper.kind === "notInstalled" || helper.kind === "failed") return ERROR;
  if (input.error !== null || state?.error) return ERROR;
  if (helper.kind !== "ready" || state === null) return EMPTY;
  switch (state.phase) {
    case "connected":
      return state.exitNode?.active === true ? EXIT_NODE : CONNECTED;
    case "connecting":
      return CONNECTING;
    default:
      return EMPTY;
  }
}

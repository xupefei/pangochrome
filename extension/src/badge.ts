import type { HelperStatus } from "./messages";
import type { State } from "./protocol";
import type { ProxyMode } from "./routing";

export interface BadgeView {
  text: string;
  color: string;
}

const EMPTY: BadgeView = { text: "", color: "#6B6B6B" };
const ON: BadgeView = { text: "ON", color: "#1E8E3E" };
const EXIT: BadgeView = { text: "EXIT", color: "#4C78C6" };
const STOP: BadgeView = { text: "STOP", color: "#D93025" };
const ERROR: BadgeView = { text: "!", color: "#E5832A" };

export interface BadgeInput {
  helper: HelperStatus;
  state: State | null;
  error: string | null;
  /** The routing mode in effect. Null when the last proxy write failed or none was made. */
  mode: ProxyMode | null;
}

/**
 * Shows what the browser routes, not what the helper reports. ON and EXIT appear
 * only while the connected PAC is in effect. STOP shows when traffic is blocked,
 * including an exit node that is chosen but not yet active.
 */
export function badgeFor(input: BadgeInput): BadgeView {
  const { helper, state, mode } = input;
  if (helper.kind === "notInstalled" || helper.kind === "failed") return ERROR;
  if (input.error !== null || state?.error) return ERROR;
  if (mode === "failClosed") return STOP;
  if (mode === "connected" && state !== null) {
    if (!state.exitNode) return ON;
    return state.exitNode.active ? EXIT : STOP;
  }
  return EMPTY;
}

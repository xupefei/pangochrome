import { buildPac } from "./pac";
import type { Routes, State } from "./protocol";

/** Nothing listens on port 1, so requests sent here always fail. */
export const FAIL_CLOSED_PROXY = "PROXY 127.0.0.1:1";

/**
 * clear: no PAC script. connected: routes from the live state.
 * failClosed: routes from the last connected state, sent to FAIL_CLOSED_PROXY.
 */
export type ProxyMode = "clear" | "connected" | "failClosed";

export interface LastConnected {
  routes: Routes;
  exitNodeActive: boolean;
}

export interface RoutingInput {
  wantConnected: boolean;
  helperReady: boolean;
  proxyPort: number | null;
  state: State | null;
  lastConnected: LastConnected | null;
}

export interface RoutingPlan {
  mode: ProxyMode;
  /** The PAC script to apply, or null to clear the proxy settings. */
  pac: string | null;
}

export function planRouting(input: RoutingInput): RoutingPlan {
  if (!input.wantConnected) return { mode: "clear", pac: null };

  const { state, proxyPort } = input;
  if (input.helperReady && proxyPort !== null && state?.phase === "connected") {
    return {
      mode: "connected",
      pac: buildPac({
        proxy: `PROXY 127.0.0.1:${proxyPort}`,
        routes: state.routes,
        exitNodeActive: state.exitNode?.active === true,
      }),
    };
  }

  const last = input.lastConnected;
  return {
    mode: "failClosed",
    pac: buildPac({
      proxy: FAIL_CLOSED_PROXY,
      routes: last?.routes ?? { hosts: [], cidrs: [] },
      exitNodeActive: last?.exitNodeActive ?? false,
    }),
  };
}

/** The routing facts to keep for fail-closed use, or null when the state is not connected. */
export function lastConnectedFrom(state: State | null): LastConnected | null {
  if (state?.phase !== "connected") return null;
  return {
    routes: { hosts: [...state.routes.hosts], cidrs: [...state.routes.cidrs] },
    exitNodeActive: state.exitNode?.active === true,
  };
}

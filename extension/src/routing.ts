import { buildPac } from "./pac";
import type { Routes, State } from "./protocol";

/** Nothing listens on port 1, so requests sent here always fail. */
export const FAIL_CLOSED_PROXY = "PROXY 127.0.0.1:1";

/**
 * clear: no PAC script. connected: routes from the live state.
 * failClosed: routes from the last connected state, sent to FAIL_CLOSED_PROXY.
 */
export type ProxyMode = "clear" | "connected" | "failClosed";

export type WebRtcPolicy = "disable_non_proxied_udp" | "default";

export interface LastConnected {
  routes: Routes;
  /** True when the connected state had an exit node chosen, whether or not it was active. */
  exitNodeChosen: boolean;
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
  /** True when every host except the local exceptions goes to the helper. */
  catchAll: boolean;
  webRtc: WebRtcPolicy;
}

/**
 * Whether an exit node is chosen. The current state decides when there is one,
 * so choosing None while disconnected lifts the catch-all. Otherwise the last connected state decides.
 */
export function exitNodeChosen(state: State | null, last: LastConnected | null): boolean {
  if (state !== null) return Boolean(state.exitNode);
  return last?.exitNodeChosen === true;
}

export function planRouting(input: RoutingInput): RoutingPlan {
  if (!input.wantConnected) {
    return { mode: "clear", pac: null, catchAll: false, webRtc: "default" };
  }

  const { state, proxyPort } = input;
  const catchAll = exitNodeChosen(state, input.lastConnected);
  const webRtc: WebRtcPolicy = catchAll ? "disable_non_proxied_udp" : "default";
  if (input.helperReady && proxyPort !== null && state?.phase === "connected") {
    return {
      mode: "connected",
      pac: buildPac({
        proxy: `PROXY 127.0.0.1:${proxyPort}`,
        routes: state.routes,
        catchAll,
      }),
      catchAll,
      webRtc,
    };
  }

  const last = input.lastConnected;
  return {
    mode: "failClosed",
    pac: buildPac({
      proxy: FAIL_CLOSED_PROXY,
      routes: last?.routes ?? { hosts: [], cidrs: [] },
      catchAll,
    }),
    catchAll,
    webRtc,
  };
}

/**
 * The routing facts to keep for fail-closed use. Routes come from the last
 * connected state. The exit-node choice comes from the latest state in any
 * phase, so it is still known if the helper stops before it connects.
 */
export function lastConnectedFrom(state: State, previous: LastConnected | null): LastConnected {
  const routes =
    state.phase === "connected"
      ? { hosts: [...state.routes.hosts], cidrs: [...state.routes.cidrs] }
      : previous?.routes ?? { hosts: [], cidrs: [] };
  return { routes, exitNodeChosen: Boolean(state.exitNode) };
}

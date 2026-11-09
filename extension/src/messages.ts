// Messages between the popup and the background service worker, sent over a chrome.runtime port.

import type { State } from "./protocol";
import type { ProxyMode } from "./routing";

export type HelperStatus =
  | { kind: "starting" }
  | { kind: "ready" }
  | { kind: "notInstalled" }
  | { kind: "failed"; message: string };

export interface Snapshot {
  helper: HelperStatus;
  wantConnected: boolean;
  state: State | null;
  /** The routing mode in effect, or null when the last proxy write failed or none was made. */
  mode: ProxyMode | null;
  /** True when the routing in effect sends traffic through a chosen exit node. */
  exitChosen: boolean;
  /** The routing or connect failure that the background recorded last. */
  error: string | null;
}

export type PopupAction =
  | { action: "retryHelper" }
  | { action: "login"; server: string }
  | { action: "cancelLogin" }
  | { action: "logout" }
  | { action: "selectOrg"; orgId: string }
  | { action: "setConnected"; connected: boolean }
  | { action: "reconnect" }
  | { action: "setExitNode"; siteResourceId: number }
  | { action: "listExitNodes" };

export type PopupToBackground = {
  type: "action";
  id: number;
  action: PopupAction;
};

export type BackgroundToPopup =
  | { type: "snapshot"; snapshot: Snapshot }
  | { type: "reply"; id: number; ok: true; result: unknown }
  | { type: "reply"; id: number; ok: false; error: string };

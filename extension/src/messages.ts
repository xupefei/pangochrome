// Messages between the popup and the background service worker, sent over a chrome.runtime port.

import type { State } from "./protocol";

export type HelperStatus =
  | { kind: "starting" }
  | { kind: "ready" }
  | { kind: "notInstalled" }
  | { kind: "failed"; message: string };

export interface Snapshot {
  helper: HelperStatus;
  wantConnected: boolean;
  state: State | null;
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

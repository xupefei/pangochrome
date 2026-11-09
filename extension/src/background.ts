import { badgeFor } from "./badge";
import type {
  BackgroundToPopup,
  HelperStatus,
  PopupAction,
  PopupToBackground,
  Snapshot,
} from "./messages";
import { NativeClient, type NativeEvent } from "./native";
import { NATIVE_HOST_NAME, type Command, type Hello, type State } from "./protocol";
import { ProxyAuth } from "./proxy-auth";
import {
  applyPac,
  clearPac,
  CONTROLLED_BY_OTHER_MESSAGE,
  type ApplyResult,
} from "./proxy-settings";
import { lastConnectedFrom, planRouting, type LastConnected } from "./routing";
import { loadStored, saveLastConnected, saveWantConnected } from "./storage";

const PROXY_REJECTED_MESSAGE = "The browser rejected the proxy settings.";

class Background {
  readonly auth = new ProxyAuth();

  private helper: HelperStatus = { kind: "starting" };
  private state: State | null = null;
  private wantConnected = false;
  private lastConnected: LastConnected | null = null;
  private profileId = "";
  private proxyPort: number | null = null;
  private routingError: string | null = null;
  private connectError: string | null = null;
  /** Set once per helper session. It stops a failing connect from retrying in a loop. */
  private reconciled = false;
  /** Counts helper open and close events. Replies from an older session are ignored. */
  private session = 0;
  private appliedKey: string | null = null;
  private routingChain: Promise<void> = Promise.resolve();
  private readonly ports = new Set<chrome.runtime.Port>();
  private readonly native = new NativeClient({
    hostName: NATIVE_HOST_NAME,
    onEvent: (event) => this.onNativeEvent(event),
  });
  private readonly ready: Promise<void>;

  constructor() {
    this.ready = this.init().catch(logFailure("Startup failed"));
  }

  /** Another extension or a policy changed the proxy. The error stays until our PAC is in control again. */
  onProxySettingsChanged(levelOfControl: string): void {
    if (this.appliedKey === null || this.appliedKey === "clear") return;
    this.routingError =
      levelOfControl === "controlled_by_this_extension" ? null : CONTROLLED_BY_OTHER_MESSAGE;
    this.publish();
  }

  attachPopup(port: chrome.runtime.Port): void {
    if (port.name !== "popup") return;
    this.ports.add(port);
    port.onDisconnect.addListener(() => {
      this.ports.delete(port);
    });
    port.onMessage.addListener((message: PopupToBackground) => {
      void this.handlePopupMessage(port, message);
    });
    void this.ready.then(() => this.publish());
  }

  private async init(): Promise<void> {
    const stored = await loadStored();
    this.profileId = stored.profileId;
    this.wantConnected = stored.wantConnected;
    this.lastConnected = stored.lastConnected;
    this.native.start();
    await this.scheduleRouting();
  }

  private onNativeEvent(event: NativeEvent): void {
    switch (event.type) {
      case "open":
        this.session += 1;
        this.helper = { kind: "starting" };
        this.state = null;
        this.proxyPort = null;
        this.reconciled = false;
        void this.hello(this.session);
        void this.scheduleRouting();
        break;
      case "closed":
        this.session += 1;
        this.auth.set(null);
        this.proxyPort = null;
        this.state = null;
        this.helper =
          event.failure.kind === "notInstalled"
            ? { kind: "notInstalled" }
            : { kind: "failed", message: event.failure.message };
        void this.scheduleRouting();
        break;
      case "state":
        this.onState(event.state);
        break;
    }
  }

  private async hello(session: number): Promise<void> {
    try {
      const hello: unknown = await this.native.request({
        cmd: "hello",
        profileId: this.profileId,
      });
      if (session !== this.session) return;
      if (!isUsableHello(hello)) throw new Error("The helper sent an invalid reply.");
      const { port, username, password } = hello.proxy;
      this.auth.set({ port, username, password });
      this.proxyPort = port;
      this.helper = { kind: "ready" };
      this.reconcileOnce();
      void this.scheduleRouting();
    } catch (err) {
      if (session !== this.session) return;
      this.helper = { kind: "failed", message: describeError(err) };
      void this.scheduleRouting();
    }
  }

  private onState(state: State): void {
    this.state = state;
    if (state.phase === "loggedOut") {
      // A logged-out helper cannot connect, so the saved intent no longer applies.
      if (this.wantConnected) {
        this.wantConnected = false;
        void saveWantConnected(false).catch(logFailure("Could not save the connect state"));
      }
      if (this.lastConnected) {
        this.lastConnected = null;
        void saveLastConnected(null).catch(logFailure("Could not clear the routes"));
      }
    }
    const connected = lastConnectedFrom(state);
    if (connected && JSON.stringify(connected) !== JSON.stringify(this.lastConnected)) {
      this.lastConnected = connected;
      void saveLastConnected(connected).catch(logFailure("Could not save the routes"));
    }
    this.reconcileOnce();
    void this.scheduleRouting();
  }

  /** Matches the helper to the saved connect intent once per helper session. */
  private reconcileOnce(): void {
    if (this.reconciled || this.helper.kind !== "ready" || this.state === null) return;
    this.reconciled = true;
    const phase = this.state.phase;
    if (this.wantConnected && phase === "disconnected") {
      this.sendInBackground({ cmd: "connect" });
    } else if (!this.wantConnected && (phase === "connected" || phase === "connecting")) {
      this.sendInBackground({ cmd: "disconnect" });
    }
  }

  private sendInBackground(command: Command): void {
    this.native.request(command).catch((err: unknown) => {
      this.connectError = describeError(err);
      this.publish();
    });
  }

  /** Applies the routing plan. Calls run one at a time, in order. */
  private scheduleRouting(): Promise<void> {
    this.routingChain = this.routingChain
      .then(() => this.applyRouting())
      .catch((err: unknown) => {
        this.routingError = describeError(err);
        this.publish();
      });
    return this.routingChain;
  }

  private async applyRouting(): Promise<void> {
    const plan = planRouting({
      wantConnected: this.wantConnected,
      helperReady: this.helper.kind === "ready",
      proxyPort: this.proxyPort,
      state: this.state,
      lastConnected: this.lastConnected,
    });
    const key = plan.pac === null ? "clear" : `pac:${plan.pac}`;
    if (key !== this.appliedKey) {
      const result = await this.setProxy(plan.pac);
      this.appliedKey = result.ok ? key : null;
      this.routingError = result.ok ? null : result.message;
    }
    this.publish();
  }

  private async setProxy(pac: string | null): Promise<ApplyResult> {
    try {
      return pac === null ? await clearPac() : await applyPac(pac);
    } catch {
      return { ok: false, message: PROXY_REJECTED_MESSAGE };
    }
  }

  private publish(): void {
    const snapshot: Snapshot = {
      helper: this.helper,
      wantConnected: this.wantConnected,
      state: this.state,
      error: this.routingError ?? this.connectError,
    };
    const badge = badgeFor({
      helper: snapshot.helper,
      state: snapshot.state,
      error: snapshot.error,
    });
    chrome.action.setBadgeBackgroundColor({ color: badge.color });
    chrome.action.setBadgeText({ text: badge.text });
    const message: BackgroundToPopup = { type: "snapshot", snapshot };
    for (const port of this.ports) {
      try {
        port.postMessage(message);
      } catch {
        this.ports.delete(port);
      }
    }
  }

  private async handlePopupMessage(
    port: chrome.runtime.Port,
    message: PopupToBackground,
  ): Promise<void> {
    let reply: BackgroundToPopup;
    try {
      await this.ready;
      const result = await this.runAction(message.action);
      reply = { type: "reply", id: message.id, ok: true, result };
    } catch (err) {
      reply = { type: "reply", id: message.id, ok: false, error: describeError(err) };
    }
    try {
      port.postMessage(reply);
    } catch {
      this.ports.delete(port);
    }
  }

  private async runAction(action: PopupAction): Promise<unknown> {
    switch (action.action) {
      case "retryHelper":
        this.native.restart();
        return {};
      case "login": {
        const info = await this.native.request({ cmd: "login", server: action.server });
        if (!/^https?:\/\//.test(info.url)) {
          throw new Error("The helper returned an invalid approval page.");
        }
        await chrome.tabs.create({ url: info.url });
        return {};
      }
      case "cancelLogin":
        return this.native.request({ cmd: "cancelLogin" });
      case "logout":
        return this.logout();
      case "selectOrg":
        return this.native.request({ cmd: "selectOrg", orgId: action.orgId });
      case "setConnected":
        return this.setConnected(action.connected);
      case "setExitNode":
        return this.native.request({
          cmd: "setExitNode",
          siteResourceId: action.siteResourceId,
        });
      case "listExitNodes":
        return this.native.request({ cmd: "listExitNodes" });
    }
  }

  private async logout(): Promise<unknown> {
    this.wantConnected = false;
    this.lastConnected = null;
    await Promise.all([saveWantConnected(false), saveLastConnected(null)]);
    await this.scheduleRouting();
    return this.native.request({ cmd: "logout" });
  }

  private async setConnected(connected: boolean): Promise<unknown> {
    this.wantConnected = connected;
    await saveWantConnected(connected);
    // Fail closed before a connect starts, and clear before a disconnect is sent.
    await this.scheduleRouting();
    this.connectError = null;
    if (connected) return this.native.request({ cmd: "connect" });
    return this.native.request({ cmd: "disconnect" });
  }
}

function isUsableHello(value: unknown): value is Hello {
  if (typeof value !== "object" || value === null) return false;
  const proxy = (value as Record<string, unknown>)["proxy"];
  if (typeof proxy !== "object" || proxy === null) return false;
  const { port, username, password } = proxy as Record<string, unknown>;
  return (
    typeof port === "number" &&
    Number.isInteger(port) &&
    port > 0 &&
    port < 65536 &&
    typeof username === "string" &&
    typeof password === "string"
  );
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function logFailure(context: string): (err: unknown) => void {
  return (err) => {
    console.warn(`[pangochrome] ${context}:`, describeError(err));
  };
}

const background = new Background();

chrome.runtime.onConnect.addListener((port) => background.attachPopup(port));
chrome.proxy.settings.onChange.addListener((details) =>
  background.onProxySettingsChanged(details.levelOfControl),
);
chrome.webRequest.onAuthRequired.addListener(
  background.auth.listener,
  { urls: ["<all_urls>"] },
  ["asyncBlocking"],
);
// Registering a listener makes Chrome start this worker at browser launch, so auto-connect runs without a popup.
chrome.runtime.onStartup.addListener(() => undefined);

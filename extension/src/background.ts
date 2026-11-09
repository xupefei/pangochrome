import { badgeFor } from "./badge";
import type {
  BackgroundToPopup,
  HelperStatus,
  PopupAction,
  PopupToBackground,
  Snapshot,
} from "./messages";
import { NativeClient, type NativeEvent } from "./native";
import {
  isExitNodeList,
  isHello,
  NATIVE_HOST_NAME,
  type Command,
  type CommandResult,
  type LoginInfo,
  type State,
} from "./protocol";
import { reconcileFor } from "./reconcile";
import { ProxyAuth } from "./proxy-auth";
import { applyPac, applyWebRtcPolicy, clearPac, controlMessage, type ApplyResult } from "./proxy-settings";
import {
  lastConnectedFrom,
  planRouting,
  type LastConnected,
  type ProxyMode,
  type WebRtcPolicy,
} from "./routing";
import { SerialQueue } from "./serial";
import { loadStored, saveLastConnected, saveWantConnected } from "./storage";
import { isHttpUrl } from "./url";

const PROXY_REJECTED = "The browser rejected the proxy settings.";
const WEBRTC_REJECTED = "The browser rejected the WebRTC setting.";
const NOT_RUNNING = "The helper is not running.";
const LOAD_FAILED = "Could not read the saved settings.";
/** How long to wait before retaking the proxy after another extension released it. */
const CONTROL_RETRY_MS = 5_000;

/** Opens once the helper has answered hello. Commands wait on it. */
class Gate {
  readonly promise: Promise<void>;
  private resolveGate: () => void = () => undefined;
  private rejectGate: (err: Error) => void = () => undefined;
  private settled = false;

  constructor() {
    this.promise = new Promise<void>((resolve, reject) => {
      this.resolveGate = resolve;
      this.rejectGate = reject;
    });
    this.promise.catch(() => undefined);
  }

  open(): void {
    if (this.settled) return;
    this.settled = true;
    this.resolveGate();
  }

  fail(message: string): void {
    if (this.settled) return;
    this.settled = true;
    this.rejectGate(new Error(message));
  }
}

function failedGate(message: string): Gate {
  const gate = new Gate();
  gate.fail(message);
  return gate;
}

class Background {
  readonly auth = new ProxyAuth();

  private helper: HelperStatus = { kind: "starting" };
  private state: State | null = null;
  private wantConnected = false;
  private lastConnected: LastConnected | null = null;
  private profileId = "";
  private loaded = false;
  private proxyPort: number | null = null;
  /** Counts helper open and close events. Replies from an older session are ignored. */
  private session = 0;
  private helloGate: Gate = failedGate(NOT_RUNNING);
  private applied: { mode: ProxyMode; exitChosen: boolean } | null = null;
  private appliedKey: string | null = null;
  private appliedWebRtc: WebRtcPolicy | null = null;
  /** True while this worker writes proxy settings. Events caused by those writes are ignored. */
  private applying = false;
  private routingError: string | null = null;
  private controlError: string | null = null;
  private connectError: string | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private controlRetryTimer: ReturnType<typeof setTimeout> | null = null;
  /** Connect attempts since the last connected state. It sets the backoff delay. */
  private connectStreak = 0;
  private routingChain: Promise<void> = Promise.resolve();
  private readonly actions = new SerialQueue();
  private readonly ports = new Set<chrome.runtime.Port>();
  private readonly native = new NativeClient({
    hostName: NATIVE_HOST_NAME,
    onEvent: (event) => this.onNativeEvent(event),
  });
  private readonly ready: Promise<void>;

  constructor() {
    this.ready = this.startup();
  }

  /** Another extension or a policy changed the proxy settings. */
  onProxySettingsChanged(levelOfControl: string): void {
    if (this.applying) return;
    if (levelOfControl === "controlled_by_this_extension") {
      this.controlError = null;
      // Our last write failed, and now the proxy is ours again. Apply the routing again.
      if (this.appliedKey === null) {
        void this.scheduleRouting();
      } else {
        this.publish();
      }
      return;
    }
    if (levelOfControl === "controllable_by_this_extension") {
      // We can take control again. Retry shortly, so that a release by another extension is picked up.
      if (this.appliedKey !== "clear") this.scheduleControlRetry();
      return;
    }
    if (this.appliedKey === "clear") return;
    this.controlError = controlMessage(levelOfControl);
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

  private async startup(): Promise<void> {
    try {
      const stored = await loadStored();
      this.profileId = stored.profileId;
      this.wantConnected = stored.wantConnected;
      this.lastConnected = stored.lastConnected;
      this.loaded = true;
      this.native.start();
    } catch (err) {
      // Without the saved intent, assume that the user still wants the connection.
      // Traffic then stays blocked until the user turns the connection off.
      this.wantConnected = true;
      this.helper = { kind: "failed", message: LOAD_FAILED };
      logFailure("Startup failed")(err);
    }
    await this.scheduleRouting();
  }

  private onNativeEvent(event: NativeEvent): void {
    switch (event.type) {
      case "open":
        this.session += 1;
        this.helper = { kind: "starting" };
        this.state = null;
        this.proxyPort = null;
        this.connectError = null;
        this.clearRetryTimer();
        this.auth.set(null);
        this.helloGate = new Gate();
        void this.sendHello(this.session, this.helloGate);
        void this.scheduleRouting();
        break;
      case "closed":
        this.session += 1;
        this.helloGate.fail(NOT_RUNNING);
        this.auth.set(null);
        this.proxyPort = null;
        this.state = null;
        this.clearRetryTimer();
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

  private async sendHello(session: number, gate: Gate): Promise<void> {
    try {
      const hello: unknown = await this.native.request({
        cmd: "hello",
        profileId: this.profileId,
      });
      if (session !== this.session) return;
      if (!isHello(hello)) throw new Error("The helper sent an invalid reply.");
      const { port, username, password } = hello.proxy;
      this.auth.set({ port, username, password });
      this.proxyPort = port;
      this.helper = { kind: "ready" };
      gate.open();
      this.reconcile();
      void this.scheduleRouting();
    } catch (err) {
      if (session !== this.session) return;
      const message = describeError(err);
      this.helper = { kind: "failed", message };
      gate.fail(message);
      void this.scheduleRouting();
    }
  }

  private onState(state: State): void {
    this.state = state;
    if (state.phase === "connected") {
      this.connectStreak = 0;
      this.clearRetryTimer();
      this.connectError = null;
    }
    const saved = lastConnectedFrom(state, this.lastConnected);
    if (JSON.stringify(saved) !== JSON.stringify(this.lastConnected)) {
      this.lastConnected = saved;
      void saveLastConnected(saved).catch(logFailure("Could not save the routes"));
    }
    this.reconcile();
    void this.scheduleRouting();
  }

  /** Makes the helper match the saved intent. Runs on every state event, so a failed connect retries. */
  private reconcile(): void {
    const decision = reconcileFor({
      wantConnected: this.wantConnected,
      helperReady: this.helper.kind === "ready",
      phase: this.state?.phase ?? null,
      retryPending: this.retryTimer !== null,
      streak: this.connectStreak,
    });
    if (decision.kind === "disconnect") {
      this.sendInBackground({ cmd: "disconnect" });
    } else if (decision.kind === "connect") {
      if (decision.delayMs === 0) {
        this.attemptConnect();
      } else {
        this.retryTimer = setTimeout(() => this.connectAfterDelay(), decision.delayMs);
      }
    }
  }

  private attemptConnect(): void {
    this.connectStreak += 1;
    this.sendInBackground({ cmd: "connect" });
  }

  private connectAfterDelay(): void {
    this.retryTimer = null;
    // The state may have changed while the timer waited, so check again.
    if (this.wantConnected && this.helper.kind === "ready" && this.state?.phase === "disconnected") {
      this.attemptConnect();
    }
  }

  private clearRetryTimer(): void {
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
  }

  private scheduleControlRetry(): void {
    if (this.controlRetryTimer !== null) return;
    this.controlRetryTimer = setTimeout(() => {
      this.controlRetryTimer = null;
      this.appliedKey = null;
      void this.scheduleRouting();
    }, CONTROL_RETRY_MS);
  }

  /** Sends a command once the helper has answered hello. The helper rejects commands before that. */
  private async send<C extends Command>(command: C): Promise<CommandResult<C["cmd"]>> {
    await this.helloGate.promise;
    return this.native.request(command);
  }

  private sendInBackground(command: Command): void {
    this.send(command).then(
      () => {
        if (this.connectError !== null) {
          this.connectError = null;
          this.publish();
        }
      },
      (err: unknown) => {
        this.connectError = describeError(err);
        this.publish();
      },
    );
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
    let failure: string | null = null;
    this.applying = true;
    try {
      if (key !== this.appliedKey) {
        const result = await this.setProxy(plan.pac);
        if (result.ok) {
          this.appliedKey = key;
          this.applied = { mode: plan.mode, exitChosen: plan.catchAll };
          this.controlError = null;
        } else {
          this.appliedKey = null;
          this.applied = null;
          failure = result.message;
        }
      }
      if (plan.webRtc !== this.appliedWebRtc) {
        const result = await this.setWebRtc(plan.webRtc);
        this.appliedWebRtc = result.ok ? plan.webRtc : null;
        failure ??= result.ok ? null : result.message;
      }
    } finally {
      this.applying = false;
    }
    this.routingError = failure;
    this.publish();
  }

  private async setProxy(pac: string | null): Promise<ApplyResult> {
    try {
      return pac === null ? await clearPac() : await applyPac(pac);
    } catch (err) {
      logFailure("Proxy settings rejected")(err);
      return { ok: false, message: PROXY_REJECTED };
    }
  }

  private async setWebRtc(policy: WebRtcPolicy): Promise<ApplyResult> {
    try {
      return await applyWebRtcPolicy(policy);
    } catch (err) {
      logFailure("WebRTC setting rejected")(err);
      return { ok: false, message: WEBRTC_REJECTED };
    }
  }

  private publish(): void {
    const snapshot: Snapshot = {
      helper: this.helper,
      wantConnected: this.wantConnected,
      state: this.state,
      mode: this.applied?.mode ?? null,
      exitChosen: this.applied?.exitChosen ?? false,
      error: this.routingError ?? this.controlError ?? this.connectError,
    };
    const badge = badgeFor({
      helper: snapshot.helper,
      state: snapshot.state,
      error: snapshot.error,
      mode: snapshot.mode,
    });
    void Promise.resolve(chrome.action.setBadgeBackgroundColor({ color: badge.color })).catch(
      logFailure("Could not set the badge colour"),
    );
    void Promise.resolve(chrome.action.setBadgeText({ text: badge.text })).catch(
      logFailure("Could not set the badge text"),
    );
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
      const result = await this.actions.run(() => this.runAction(message.action));
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
        if (this.loaded) {
          this.native.restart();
        } else {
          await this.startup();
        }
        return {};
      case "login": {
        const info: LoginInfo = await this.send({ cmd: "login", server: action.server });
        if (!isHttpUrl(info.url)) {
          throw new Error("The helper returned an invalid approval page.");
        }
        await openTab(info.url);
        return {};
      }
      case "cancelLogin":
        return this.send({ cmd: "cancelLogin" });
      case "logout":
        return this.logout();
      case "selectOrg":
        return this.send({ cmd: "selectOrg", orgId: action.orgId });
      case "setConnected":
        return this.setConnected(action.connected);
      case "reconnect":
        this.clearRetryTimer();
        this.connectStreak = 0;
        this.reconcile();
        return {};
      case "setExitNode":
        return this.send({ cmd: "setExitNode", siteResourceId: action.siteResourceId });
      case "listExitNodes": {
        const nodes: unknown = await this.send({ cmd: "listExitNodes" });
        if (!isExitNodeList(nodes)) throw new Error("The helper sent an invalid exit node list.");
        return nodes;
      }
      default: {
        const unknownAction: never = action;
        throw new Error(`Unknown action: ${JSON.stringify(unknownAction)}`);
      }
    }
  }

  /** Logout clears the saved intent and the saved routes. Session end does not. */
  private async logout(): Promise<unknown> {
    this.wantConnected = false;
    this.lastConnected = null;
    this.clearRetryTimer();
    this.connectStreak = 0;
    await this.scheduleRouting();
    void Promise.all([saveWantConnected(false), saveLastConnected(null)]).catch(
      logFailure("Could not save the saved state"),
    );
    return this.send({ cmd: "logout" });
  }

  private async setConnected(connected: boolean): Promise<unknown> {
    this.wantConnected = connected;
    this.clearRetryTimer();
    this.connectStreak = 0;
    if (connected) {
      this.connectError = null;
      // Fail closed first. The connect attempt follows once the proxy is set.
      await this.scheduleRouting();
      void saveWantConnected(true).catch(logFailure("Could not save the connect state"));
      this.reconcile();
      return {};
    }
    // The saved routes stay, so that the next connect fails closed for them
    // until the tunnel is up again. Only logout forgets them.
    await this.scheduleRouting();
    void saveWantConnected(false).catch(logFailure("Could not save the connect state"));
    // The helper may be down. Clearing the proxy has already happened, so that failure is ignored.
    try {
      await this.send({ cmd: "disconnect" });
    } catch (err) {
      if (describeError(err) !== NOT_RUNNING) throw err;
    }
    return {};
  }
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function logFailure(context: string): (err: unknown) => void {
  return (err) => {
    console.warn(`[pangochrome] ${context}:`, describeError(err));
  };
}

async function openTab(url: string): Promise<void> {
  try {
    await chrome.tabs.create({ url });
  } catch (err) {
    throw new Error(`Could not open the approval page. ${describeError(err)}`);
  }
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

// Portions adapted from tailchrome (https://github.com/dantraynor/tailchrome), MIT licence, Copyright (c) 2026 Tesseras.

import type { Command, CommandResult, State } from "./protocol";

/** The subset of chrome.runtime.Port that this client uses. */
export interface NativePort {
  postMessage(message: unknown): void;
  disconnect(): void;
  onMessage: { addListener(listener: (message: unknown) => void): void };
  onDisconnect: { addListener(listener: () => void): void };
}

export type HelperFailure =
  | { kind: "notInstalled"; message: string }
  | { kind: "failed"; message: string };

export type NativeEvent =
  | { type: "open" }
  | { type: "closed"; failure: HelperFailure }
  | { type: "state"; state: State };

export interface NativeClientOptions {
  hostName: string;
  onEvent: (event: NativeEvent) => void;
  /** Defaults to chrome.runtime.connectNative. */
  connect?: (hostName: string) => NativePort;
  /** Returns the text of Chrome's last error. Defaults to chrome.runtime.lastError. */
  readLastError?: () => string;
  requestTimeoutMs?: number;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
}

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_RECONNECT_BASE_MS = 1_000;
const DEFAULT_RECONNECT_MAX_MS = 30_000;

interface PendingRequest {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Owns the native port to the helper. Requests get an id, and the reply with
 * the same id settles them. State events and port lifecycle go to onEvent.
 */
export class NativeClient {
  private port: NativePort | null = null;
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly connectPort: (hostName: string) => NativePort;
  private readonly readLastError: () => string;
  private readonly hostName: string;
  private readonly onEvent: (event: NativeEvent) => void;
  private readonly requestTimeoutMs: number;
  private readonly reconnectBaseMs: number;
  private readonly reconnectMaxMs: number;
  private backoffMs: number;

  constructor(options: NativeClientOptions) {
    this.hostName = options.hostName;
    this.onEvent = options.onEvent;
    this.connectPort = options.connect ?? defaultConnect;
    this.readLastError = options.readLastError ?? readChromeLastError;
    this.requestTimeoutMs = options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.reconnectBaseMs = options.reconnectBaseMs ?? DEFAULT_RECONNECT_BASE_MS;
    this.reconnectMaxMs = options.reconnectMaxMs ?? DEFAULT_RECONNECT_MAX_MS;
    this.backoffMs = this.reconnectBaseMs;
  }

  /** Opens the port unless it is already open or a reconnect is pending. */
  start(): void {
    if (this.port || this.reconnectTimer) return;
    this.open();
  }

  /** Closes the current port, if any, and opens a new one now. */
  restart(): void {
    this.clearReconnectTimer();
    const port = this.port;
    this.port = null;
    this.backoffMs = this.reconnectBaseMs;
    this.rejectAll("The helper was restarted.");
    port?.disconnect();
    this.open();
  }

  request<C extends Command>(
    command: C,
    timeoutMs: number = this.requestTimeoutMs,
  ): Promise<CommandResult<C["cmd"]>> {
    const port = this.port;
    if (!port) return Promise.reject(new Error("The helper is not running."));
    const id = this.nextId++;
    return new Promise<CommandResult<C["cmd"]>>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("The helper did not reply in time."));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: resolve as (result: unknown) => void,
        reject,
        timer,
      });
      try {
        port.postMessage({ id, ...command });
      } catch (err) {
        this.settle(id);
        reject(new Error(describeError(err)));
      }
    });
  }

  private open(): void {
    let port: NativePort;
    try {
      port = this.connectPort(this.hostName);
    } catch (err) {
      this.onEvent({
        type: "closed",
        failure: classifyDisconnect(describeError(err)),
      });
      this.scheduleReconnect();
      return;
    }
    this.port = port;
    port.onMessage.addListener((message) => {
      if (this.port === port) this.handleMessage(message);
    });
    port.onDisconnect.addListener(() => this.handleDisconnect(port));
    this.onEvent({ type: "open" });
  }

  private handleMessage(message: unknown): void {
    if (!isRecord(message)) return;
    // A valid message means the helper runs, so the next reconnect starts from the base delay.
    this.backoffMs = this.reconnectBaseMs;
    if (typeof message["id"] === "number") {
      const entry = this.settle(message["id"]);
      if (!entry) return;
      if (message["ok"] === true) {
        entry.resolve(message["result"]);
      } else {
        const error = message["error"];
        entry.reject(
          new Error(typeof error === "string" ? error : "The helper returned an error."),
        );
      }
      return;
    }
    if (message["event"] === "state" && isRecord(message["state"])) {
      this.onEvent({ type: "state", state: message["state"] as unknown as State });
    }
  }

  private handleDisconnect(port: NativePort): void {
    if (this.port !== port) return;
    const lastError = this.readLastError();
    this.port = null;
    this.rejectAll("The helper stopped.");
    this.onEvent({ type: "closed", failure: classifyDisconnect(lastError) });
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    this.clearReconnectTimer();
    const delay = this.backoffMs;
    this.backoffMs = Math.min(delay * 2, this.reconnectMaxMs);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.open();
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }

  private settle(id: number): PendingRequest | undefined {
    const entry = this.pending.get(id);
    if (!entry) return undefined;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    return entry;
  }

  private rejectAll(message: string): void {
    for (const id of [...this.pending.keys()]) {
      this.settle(id)?.reject(new Error(message));
    }
  }
}

/**
 * Maps Chrome's disconnect text to a failure kind. A missing helper is the
 * only kind the popup can fix by installing it, so it gets its own kind.
 */
export function classifyDisconnect(lastError: string): HelperFailure {
  const normalized = lastError.toLowerCase();
  if (
    /native messaging host .*not found/.test(normalized) ||
    normalized.includes("no such native application")
  ) {
    return { kind: "notInstalled", message: "The helper is not installed." };
  }
  return {
    kind: "failed",
    message: lastError.trim() || "The helper stopped unexpectedly.",
  };
}

function defaultConnect(hostName: string): NativePort {
  return chrome.runtime.connectNative(hostName);
}

function readChromeLastError(): string {
  return chrome.runtime.lastError?.message ?? "";
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

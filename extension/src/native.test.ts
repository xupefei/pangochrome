import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { classifyDisconnect, NativeClient, type NativeEvent, type NativePort } from "./native";

class FakePort implements NativePort {
  readonly posted: unknown[] = [];
  disconnected = false;
  private readonly messageListeners: Array<(message: unknown) => void> = [];
  private readonly disconnectListeners: Array<() => void> = [];

  readonly onMessage = {
    addListener: (listener: (message: unknown) => void): void => {
      this.messageListeners.push(listener);
    },
  };

  readonly onDisconnect = {
    addListener: (listener: () => void): void => {
      this.disconnectListeners.push(listener);
    },
  };

  postMessage(message: unknown): void {
    this.posted.push(message);
  }

  disconnect(): void {
    this.disconnected = true;
  }

  /** Simulates a message from the helper. */
  receive(message: unknown): void {
    for (const listener of this.messageListeners) listener(message);
  }

  /** Simulates the helper closing the port. */
  close(): void {
    for (const listener of this.disconnectListeners) listener();
  }
}

interface Harness {
  client: NativeClient;
  ports: FakePort[];
  events: NativeEvent[];
  setLastError(message: string): void;
  setConnectError(error: Error | null): void;
}

function setup(options: { requestTimeoutMs?: number } = {}): Harness {
  const ports: FakePort[] = [];
  const events: NativeEvent[] = [];
  let lastError = "";
  let connectError: Error | null = null;
  const client = new NativeClient({
    hostName: "pangochrome.helper",
    connect: () => {
      if (connectError) throw connectError;
      const port = new FakePort();
      ports.push(port);
      return port;
    },
    readLastError: () => lastError,
    onEvent: (event) => events.push(event),
    requestTimeoutMs: options.requestTimeoutMs ?? 1000,
    reconnectBaseMs: 100,
    reconnectMaxMs: 800,
  });
  return {
    client,
    ports,
    events,
    setLastError: (message) => {
      lastError = message;
    },
    setConnectError: (error) => {
      connectError = error;
    },
  };
}

function lastPort(ports: FakePort[]): FakePort {
  const port = ports[ports.length - 1];
  if (!port) throw new Error("no port was opened");
  return port;
}

describe("NativeClient", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("emits open when the port starts", () => {
    const { client, events, ports } = setup();
    client.start();
    expect(ports).toHaveLength(1);
    expect(events).toEqual([{ type: "open" }]);
  });

  it("does not open a second port while one is open", () => {
    const { client, ports } = setup();
    client.start();
    client.start();
    expect(ports).toHaveLength(1);
  });

  it("rejects requests while no port is open", async () => {
    const { client } = setup();
    await expect(client.request({ cmd: "getState" })).rejects.toThrow(
      "The helper is not running.",
    );
  });

  it("sends the command with a positive id", () => {
    const { client, ports } = setup();
    client.start();
    void client.request({ cmd: "login", server: "https://app.pangolin.net" });
    expect(lastPort(ports).posted).toEqual([
      { id: 1, cmd: "login", server: "https://app.pangolin.net" },
    ]);
  });

  it("settles each request with the reply that has its id", async () => {
    const { client, ports } = setup();
    client.start();
    const first = client.request({ cmd: "listExitNodes" });
    const second = client.request({ cmd: "getState" });
    const port = lastPort(ports);

    port.receive({ id: 2, ok: true, result: { phase: "disconnected" } });
    port.receive({ id: 1, ok: true, result: [] });

    await expect(first).resolves.toEqual([]);
    await expect(second).resolves.toEqual({ phase: "disconnected" });
  });

  it("rejects with the helper error text", async () => {
    const { client, ports } = setup();
    client.start();
    const pending = client.request({ cmd: "connect" });
    lastPort(ports).receive({ id: 1, ok: false, error: "not logged in" });
    await expect(pending).rejects.toThrow("not logged in");
  });

  it("ignores replies with an unknown id", () => {
    const { client, ports, events } = setup();
    client.start();
    lastPort(ports).receive({ id: 99, ok: true, result: {} });
    expect(events).toEqual([{ type: "open" }]);
  });

  it("rejects a request that gets no reply in time, and ignores a late reply", async () => {
    const { client, ports } = setup({ requestTimeoutMs: 1000 });
    client.start();
    const pending = client.request({ cmd: "connect" });
    const assertion = expect(pending).rejects.toThrow("The helper did not reply in time.");
    vi.advanceTimersByTime(1000);
    await assertion;
    expect(() => lastPort(ports).receive({ id: 1, ok: true, result: {} })).not.toThrow();
  });

  it("dispatches state events and ignores other messages", () => {
    const { client, ports, events } = setup();
    client.start();
    const port = lastPort(ports);
    port.receive({ event: "state", state: { phase: "connected" } });
    port.receive({ unrelated: true });
    port.receive("text");
    expect(events).toEqual([
      { type: "open" },
      { type: "state", state: { phase: "connected" } },
    ]);
  });

  it("rejects pending requests and emits closed when the port closes", async () => {
    const { client, ports, events } = setup();
    client.start();
    const pending = client.request({ cmd: "getState" });
    lastPort(ports).close();
    await expect(pending).rejects.toThrow("The helper stopped.");
    expect(events.at(-1)).toEqual({
      type: "closed",
      failure: { kind: "failed", message: "The helper stopped unexpectedly." },
    });
  });

  it("reports a missing helper as notInstalled", () => {
    const { client, ports, events, setLastError } = setup();
    setLastError("Specified native messaging host not found.");
    client.start();
    lastPort(ports).close();
    expect(events.at(-1)).toEqual({
      type: "closed",
      failure: { kind: "notInstalled", message: "The helper is not installed." },
    });
  });

  it("reconnects with exponential backoff up to the maximum", () => {
    const { client, ports } = setup();
    client.start();

    lastPort(ports).close();
    vi.advanceTimersByTime(99);
    expect(ports).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(ports).toHaveLength(2);

    lastPort(ports).close();
    vi.advanceTimersByTime(199);
    expect(ports).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(ports).toHaveLength(3);

    lastPort(ports).close();
    vi.advanceTimersByTime(399);
    expect(ports).toHaveLength(3);
    vi.advanceTimersByTime(1);
    expect(ports).toHaveLength(4);

    lastPort(ports).close();
    vi.advanceTimersByTime(799);
    expect(ports).toHaveLength(4);
    vi.advanceTimersByTime(1);
    expect(ports).toHaveLength(5);

    // The delay stays at the maximum.
    lastPort(ports).close();
    vi.advanceTimersByTime(799);
    expect(ports).toHaveLength(5);
    vi.advanceTimersByTime(1);
    expect(ports).toHaveLength(6);
  });

  it("resets the backoff after a valid message", () => {
    const { client, ports } = setup();
    client.start();

    lastPort(ports).close();
    vi.advanceTimersByTime(100);
    expect(ports).toHaveLength(2);

    lastPort(ports).receive({ event: "state", state: { phase: "disconnected" } });
    lastPort(ports).close();
    vi.advanceTimersByTime(99);
    expect(ports).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(ports).toHaveLength(3);
  });

  it("restart drops the current port and opens a new one now", async () => {
    const { client, ports, events } = setup();
    client.start();
    const pending = client.request({ cmd: "getState" });
    const first = lastPort(ports);

    client.restart();

    expect(first.disconnected).toBe(true);
    expect(ports).toHaveLength(2);
    await expect(pending).rejects.toThrow("The helper was restarted.");
    expect(events.map((event) => event.type)).toEqual(["open", "open"]);
  });

  it("reports a connect that throws and retries later", () => {
    const { client, ports, events, setConnectError } = setup();
    setConnectError(new Error("Native host has exited."));
    client.start();
    expect(events.at(-1)).toEqual({
      type: "closed",
      failure: { kind: "failed", message: "Native host has exited." },
    });

    setConnectError(null);
    vi.advanceTimersByTime(100);
    expect(ports).toHaveLength(1);
    expect(events.at(-1)).toEqual({ type: "open" });
  });
});

describe("classifyDisconnect", () => {
  it.each([
    ["Specified native messaging host not found.", "notInstalled"],
    ["Native messaging host pangochrome.helper not found.", "notInstalled"],
    ["No such native application pangochrome.helper", "notInstalled"],
    ["Access to the specified native messaging host is forbidden.", "failed"],
    ["Native host has exited.", "failed"],
    ["", "failed"],
  ])("classifies %j as %s", (lastError, kind) => {
    expect(classifyDisconnect(lastError).kind).toBe(kind);
  });

  it("keeps Chrome's message for a failure", () => {
    expect(classifyDisconnect("Native host has exited.")).toEqual({
      kind: "failed",
      message: "Native host has exited.",
    });
  });
});

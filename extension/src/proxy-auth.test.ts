import { describe, expect, it, vi } from "vitest";
import { ProxyAuth } from "./proxy-auth";

const CREDENTIALS = { port: 8123, username: "user-1", password: "secret-1" };

function challenge(host: string, port: number, requestId: string, isProxy = true) {
  return { isProxy, challenger: { host, port }, requestId };
}

describe("ProxyAuth listener", () => {
  it("answers the helper's proxy challenge with its credentials", () => {
    const auth = new ProxyAuth();
    auth.set(CREDENTIALS);
    const callback = vi.fn();
    auth.listener(challenge("127.0.0.1", 8123, "1"), callback);
    expect(callback).toHaveBeenCalledWith({
      authCredentials: { username: "user-1", password: "secret-1" },
    });
  });

  it("passes challenges from other hosts to Chrome without answering them", () => {
    const auth = new ProxyAuth();
    auth.set(CREDENTIALS);
    const otherHost = vi.fn();
    auth.listener(challenge("example.com", 8123, "1"), otherHost);
    expect(otherHost).toHaveBeenCalledWith({});
  });

  it("cancels a loopback challenge from another port, so no login dialog appears", () => {
    const auth = new ProxyAuth();
    auth.set(CREDENTIALS);
    const otherPort = vi.fn();
    auth.listener(challenge("127.0.0.1", 9999, "2"), otherPort);
    expect(otherPort).toHaveBeenCalledWith({ cancel: true });
  });

  it("cancels a loopback challenge when no credentials are set", () => {
    const auth = new ProxyAuth();
    const callback = vi.fn();
    auth.listener(challenge("127.0.0.1", 8123, "3"), callback);
    expect(callback).toHaveBeenCalledWith({ cancel: true });
  });

  it("does not answer server challenges", () => {
    const auth = new ProxyAuth();
    auth.set(CREDENTIALS);
    const callback = vi.fn();
    auth.listener(challenge("127.0.0.1", 8123, "1", false), callback);
    expect(callback).toHaveBeenCalledWith({});
  });

  it("cancels a second challenge for the same request", () => {
    const auth = new ProxyAuth();
    auth.set(CREDENTIALS);
    auth.listener(challenge("127.0.0.1", 8123, "1"), vi.fn());
    const second = vi.fn();
    auth.listener(challenge("127.0.0.1", 8123, "1"), second);
    expect(second).toHaveBeenCalledWith({ cancel: true });
  });

  it("forgets its credentials when set to null", () => {
    const auth = new ProxyAuth();
    auth.set(CREDENTIALS);
    auth.set(null);
    const callback = vi.fn();
    auth.listener(challenge("127.0.0.1", 8123, "1"), callback);
    expect(callback).toHaveBeenCalledWith({ cancel: true });
  });

  it("accepts a call without a callback", () => {
    const auth = new ProxyAuth();
    auth.set(CREDENTIALS);
    expect(() => auth.listener(challenge("127.0.0.1", 8123, "1"))).not.toThrow();
  });
});

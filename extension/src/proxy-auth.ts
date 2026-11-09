// Portions adapted from tailchrome (https://github.com/dantraynor/tailchrome), MIT licence, Copyright (c) 2026 Tesseras.

export interface ProxyCredentials {
  port: number;
  username: string;
  password: string;
}

type ChallengeDetails = Pick<
  chrome.webRequest.OnAuthRequiredDetails,
  "isProxy" | "challenger" | "requestId"
>;

type ChallengeCallback = (response: chrome.webRequest.BlockingResponse) => void;

const MAX_TRACKED_REQUESTS = 1024;

/**
 * Answers the helper proxy's 407 challenge. Only challenges from
 * 127.0.0.1 on the helper's port get credentials.
 */
export class ProxyAuth {
  private credentials: ProxyCredentials | null = null;
  private readonly answered = new Set<string>();

  set(credentials: ProxyCredentials | null): void {
    this.credentials = credentials;
    this.answered.clear();
  }

  /** Register with chrome.webRequest.onAuthRequired using the "asyncBlocking" option. */
  readonly listener = (details: ChallengeDetails, callback?: ChallengeCallback): undefined => {
    const credentials = this.credentials;
    if (
      !details.isProxy ||
      details.challenger.host !== "127.0.0.1" ||
      credentials === null ||
      details.challenger.port !== credentials.port
    ) {
      callback?.({});
      return;
    }
    // A second challenge for the same request means the helper rejected the credentials.
    // Cancel the request so that Chrome does not loop.
    if (this.answered.has(details.requestId)) {
      callback?.({ cancel: true });
      return;
    }
    if (this.answered.size >= MAX_TRACKED_REQUESTS) {
      const oldest = this.answered.values().next().value;
      if (oldest !== undefined) this.answered.delete(oldest);
    }
    this.answered.add(details.requestId);
    callback?.({
      authCredentials: { username: credentials.username, password: credentials.password },
    });
  };
}

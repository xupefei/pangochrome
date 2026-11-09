import type { WebRtcPolicy } from "./routing";

export type ApplyResult = { ok: true } | { ok: false; message: string };

/**
 * The message for a proxy control level that is not this extension's, or null
 * when this extension controls the setting.
 */
export function controlMessage(levelOfControl: string): string | null {
  switch (levelOfControl) {
    case "controlled_by_this_extension":
      return null;
    case "controlled_by_other_extensions":
      return "Another extension controls the proxy settings.";
    case "not_controllable":
      return "A browser policy controls the proxy settings.";
    default:
      return "The browser did not apply the proxy settings.";
  }
}

/** Sets the PAC script and checks that this extension still controls the proxy. */
export async function applyPac(pac: string): Promise<ApplyResult> {
  await chromeCall<void>((done) =>
    chrome.proxy.settings.set(
      {
        value: { mode: "pac_script", pacScript: { data: pac, mandatory: true } },
        scope: "regular",
      },
      () => done(undefined),
    ),
  );
  const current = await chromeCall<chrome.types.ChromeSettingGetResult<chrome.proxy.ProxyConfig>>(
    (done) => chrome.proxy.settings.get({ incognito: false }, done),
  );
  const message = controlMessage(current.levelOfControl);
  return message === null ? { ok: true } : { ok: false, message };
}

export async function clearPac(): Promise<ApplyResult> {
  await chromeCall<void>((done) =>
    chrome.proxy.settings.clear({ scope: "regular" }, () => done(undefined)),
  );
  return { ok: true };
}

/** Sets or clears the WebRTC policy that keeps UDP inside the proxy. */
export async function applyWebRtcPolicy(policy: WebRtcPolicy): Promise<ApplyResult> {
  if (policy === "default") {
    await chromeCall<void>((done) =>
      chrome.privacy.network.webRTCIPHandlingPolicy.clear(
        { scope: "regular" },
        () => done(undefined),
      ),
    );
  } else {
    await chromeCall<void>((done) =>
      chrome.privacy.network.webRTCIPHandlingPolicy.set(
        { value: "disable_non_proxied_udp", scope: "regular" },
        () => done(undefined),
      ),
    );
  }
  return { ok: true };
}

function chromeCall<T>(invoke: (done: (value: T) => void) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    invoke((value) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message ?? "Chrome rejected the setting."));
      } else {
        resolve(value);
      }
    });
  });
}

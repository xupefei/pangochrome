export type ApplyResult = { ok: true } | { ok: false; message: string };

export const CONTROLLED_BY_OTHER_MESSAGE =
  "Another extension or a browser policy controls the proxy settings.";

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
  if (current.levelOfControl !== "controlled_by_this_extension") {
    return { ok: false, message: CONTROLLED_BY_OTHER_MESSAGE };
  }
  return { ok: true };
}

export async function clearPac(): Promise<ApplyResult> {
  await chromeCall<void>((done) =>
    chrome.proxy.settings.clear({ scope: "regular" }, () => done(undefined)),
  );
  return { ok: true };
}

function chromeCall<T>(invoke: (done: (value: T) => void) => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    invoke((value) => {
      const error = chrome.runtime.lastError;
      if (error) {
        reject(new Error(error.message ?? "Chrome rejected the proxy settings."));
      } else {
        resolve(value);
      }
    });
  });
}

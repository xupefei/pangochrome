const RELEASES_URL = "https://github.com/xupefei/pangochrome/releases";

/** The values of chrome.runtime.PlatformInfo.os. */
export type PlatformOs = `${chrome.runtime.PlatformOs}`;

export function helperRunsOn(os: PlatformOs): boolean {
  return os === "mac" || os === "linux";
}

/**
 * The command that installs the helper release for this extension version and
 * allows this extension's ID. Null when the version or the ID is not safe to
 * put in a shell command.
 */
export function installCommand(version: string, extensionId: string): string | null {
  if (!/^\d+\.\d+\.\d+$/.test(version) || !/^[a-p]{32}$/.test(extensionId)) return null;
  return `curl -fsSL ${RELEASES_URL}/download/v${version}/install.sh | sh -s -- --extension-id ${extensionId}`;
}

/**
 * True when the helper reports a release version older than this extension's.
 * Other strings, such as "dev" or git describe output, never count.
 */
export function helperUpdateNeeded(helperVersion: string, extensionVersion: string): boolean {
  const helper = /^v(\d+)\.(\d+)\.(\d+)$/.exec(helperVersion);
  const extension = /^(\d+)\.(\d+)\.(\d+)$/.exec(extensionVersion);
  if (!helper || !extension) return false;
  for (let i = 1; i <= 3; i++) {
    const difference = Number(helper[i]) - Number(extension[i]);
    if (difference !== 0) return difference < 0;
  }
  return false;
}

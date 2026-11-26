/** The GitHub releases that publish the helper and its install script. */
export const RELEASES_URL = "https://github.com/xupefei/pangochrome/releases";

/** Reports whether the helper has a release for this chrome.runtime.PlatformInfo os. */
export function helperRunsOn(os: string): boolean {
  return os === "mac" || os === "linux";
}

/**
 * The shell command that installs the helper release with the same version
 * as this extension, and allows this extension's ID. Null when the version
 * or the ID cannot be part of a safe command.
 */
export function installCommand(version: string, extensionId: string): string | null {
  if (!/^\d+\.\d+\.\d+$/.test(version) || !/^[a-p]{32}$/.test(extensionId)) return null;
  const tag = `v${version}`;
  return `curl -fsSL ${RELEASES_URL}/download/${tag}/install.sh | sh -s -- --version ${tag} --extension-id ${extensionId}`;
}

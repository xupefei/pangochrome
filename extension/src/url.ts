/** True for an absolute http or https URL. Used before any URL from the helper opens. */
export function isHttpUrl(value: string): boolean {
  if (!/^https?:\/\//i.test(value)) return false;
  try {
    new URL(value);
    return true;
  } catch {
    return false;
  }
}

/** True for a host name without wildcards, such as "app.internal". */
export function isPlainHostname(value: string): boolean {
  return /^[a-z0-9._-]+$/.test(value.toLowerCase());
}

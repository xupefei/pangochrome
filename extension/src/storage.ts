import type { LastConnected } from "./routing";

export interface Stored {
  profileId: string;
  wantConnected: boolean;
  lastConnected: LastConnected | null;
}

const PROFILE_ID_PATTERN = /^[A-Za-z0-9_-]{8,64}$/;

/** A base64url string of 24 random bytes is 32 characters and matches PROFILE_ID_PATTERN. */
export function newProfileId(randomBytes: Uint8Array): string {
  let binary = "";
  for (const byte of randomBytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export async function loadStored(): Promise<Stored> {
  const values: Record<string, unknown> = await chrome.storage.local.get([
    "profileId",
    "wantConnected",
    "lastConnected",
  ]);
  const saved = values["profileId"];
  let profileId: string;
  if (typeof saved === "string" && PROFILE_ID_PATTERN.test(saved)) {
    profileId = saved;
  } else {
    profileId = newProfileId(crypto.getRandomValues(new Uint8Array(24)));
    await chrome.storage.local.set({ profileId });
  }
  return {
    profileId,
    wantConnected: values["wantConnected"] === true,
    lastConnected: parseLastConnected(values["lastConnected"]),
  };
}

export async function saveWantConnected(wantConnected: boolean): Promise<void> {
  await chrome.storage.local.set({ wantConnected });
}

export async function saveLastConnected(value: LastConnected | null): Promise<void> {
  if (value === null) {
    await chrome.storage.local.remove("lastConnected");
  } else {
    await chrome.storage.local.set({ lastConnected: value });
  }
}

function parseLastConnected(value: unknown): LastConnected | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const routes = record["routes"];
  if (typeof routes !== "object" || routes === null) return null;
  const { hosts, cidrs } = routes as Record<string, unknown>;
  if (!isStringArray(hosts) || !isStringArray(cidrs)) return null;
  if (typeof record["exitNodeChosen"] !== "boolean") return null;
  return { routes: { hosts, cidrs }, exitNodeChosen: record["exitNodeChosen"] };
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

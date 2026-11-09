// Types for the extension-to-helper protocol. Source of truth: docs/PROTOCOL.md.

// Must match "nativeHostName" in config/ids.json.
export const NATIVE_HOST_NAME = "pangochrome.helper";

export interface HelloProxy {
  host: "127.0.0.1";
  port: number;
  username: string;
  password: string;
}

export interface Hello {
  version: string;
  proxy: HelloProxy;
}

export interface LoginInfo {
  code: string;
  url: string;
  expiresAt: number;
}

export interface ExitNode {
  siteResourceId: number;
  name: string;
  siteNames: string[];
  online: boolean;
}

export type Phase =
  | "loggedOut"
  | "loggingIn"
  | "disconnected"
  | "connecting"
  | "connected";

export interface Org {
  orgId: string;
  name: string;
}

export interface Site {
  siteId: number;
  name: string;
  connected: boolean;
  relayed: boolean;
  aliases: string[];
}

export interface Routes {
  hosts: string[];
  cidrs: string[];
}

export interface ExitNodeState {
  siteResourceId: number;
  name: string;
  active: boolean;
}

export interface State {
  phase: Phase;
  server?: string;
  user?: { email: string; name?: string };
  orgs: Org[];
  orgId?: string;
  login?: LoginInfo;
  error?: string;
  sites: Site[];
  routes: Routes;
  exitNode?: ExitNodeState;
}

export type Command =
  | { cmd: "hello"; profileId: string }
  | { cmd: "getState" }
  | { cmd: "login"; server: string }
  | { cmd: "cancelLogin" }
  | { cmd: "logout" }
  | { cmd: "selectOrg"; orgId: string }
  | { cmd: "connect" }
  | { cmd: "disconnect" }
  | { cmd: "listExitNodes" }
  | { cmd: "setExitNode"; siteResourceId: number };

export type CommandName = Command["cmd"];

export type EmptyResult = Record<string, never>;

export interface CommandResults {
  hello: Hello;
  getState: State;
  login: LoginInfo;
  cancelLogin: EmptyResult;
  logout: EmptyResult;
  selectOrg: EmptyResult;
  connect: EmptyResult;
  disconnect: EmptyResult;
  listExitNodes: ExitNode[];
  setExitNode: EmptyResult;
}

export type CommandResult<C extends CommandName> = CommandResults[C];

const PHASES: readonly string[] = [
  "loggedOut",
  "loggingIn",
  "disconnected",
  "connecting",
  "connected",
];

/**
 * Checks the fields that the extension reads. Optional fields are checked
 * only when they are present, and null counts as absent.
 */
export function isState(value: unknown): value is State {
  if (!isRecord(value)) return false;
  const phase = value["phase"];
  if (typeof phase !== "string" || !PHASES.includes(phase)) return false;
  return (
    Array.isArray(value["orgs"]) &&
    value["orgs"].every(isOrg) &&
    Array.isArray(value["sites"]) &&
    value["sites"].every(isSite) &&
    isRoutes(value["routes"]) &&
    isOptional(value["orgId"], isString) &&
    isOptional(value["server"], isString) &&
    isOptional(value["error"], isString) &&
    isOptional(value["login"], isLoginInfo) &&
    isOptional(value["exitNode"], isExitNodeState) &&
    isOptional(value["user"], isUser)
  );
}

export function isExitNodeList(value: unknown): value is ExitNode[] {
  return Array.isArray(value) && value.every(isExitNode);
}

export function isHello(value: unknown): value is Hello {
  if (!isRecord(value)) return false;
  const proxy = value["proxy"];
  if (!isRecord(proxy)) return false;
  const port = proxy["port"];
  return (
    typeof port === "number" &&
    Number.isInteger(port) &&
    port > 0 &&
    port < 65536 &&
    isString(proxy["username"]) &&
    isString(proxy["password"])
  );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isString(value: unknown): value is string {
  return typeof value === "string";
}

function isBoolean(value: unknown): value is boolean {
  return typeof value === "boolean";
}

function isNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString);
}

function isOptional(value: unknown, check: (item: unknown) => boolean): boolean {
  return value === undefined || value === null || check(value);
}

function isOrg(value: unknown): boolean {
  return isRecord(value) && isString(value["orgId"]) && isString(value["name"]);
}

function isSite(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNumber(value["siteId"]) &&
    isString(value["name"]) &&
    isBoolean(value["connected"]) &&
    isBoolean(value["relayed"]) &&
    isStringArray(value["aliases"])
  );
}

function isRoutes(value: unknown): boolean {
  return isRecord(value) && isStringArray(value["hosts"]) && isStringArray(value["cidrs"]);
}

function isExitNodeState(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNumber(value["siteResourceId"]) &&
    isString(value["name"]) &&
    isBoolean(value["active"])
  );
}

function isExitNode(value: unknown): boolean {
  return (
    isRecord(value) &&
    isNumber(value["siteResourceId"]) &&
    isString(value["name"]) &&
    isStringArray(value["siteNames"]) &&
    isBoolean(value["online"])
  );
}

function isLoginInfo(value: unknown): boolean {
  return (
    isRecord(value) &&
    isString(value["code"]) &&
    isString(value["url"]) &&
    isNumber(value["expiresAt"])
  );
}

function isUser(value: unknown): boolean {
  return isRecord(value) && isString(value["email"]);
}

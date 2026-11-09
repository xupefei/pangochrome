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

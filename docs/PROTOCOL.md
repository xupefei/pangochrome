# Pangochrome extension–helper protocol

The extension starts the helper with `chrome.runtime.connectNative("pangochrome.helper")`.
Chrome frames each message as a 4-byte little-endian length followed by UTF-8
JSON. Each message is one JSON object. The maximum size of a helper message is
1 MiB.

## Messages

Extension to helper (request):

```json
{ "id": 7, "cmd": "connect" }
```

Helper to extension (reply to one request):

```json
{ "id": 7, "ok": true, "result": {} }
{ "id": 7, "ok": false, "error": "not logged in" }
```

Helper to extension (event, no `id`):

```json
{ "event": "state", "state": { } }
```

- `id` is a positive integer chosen by the extension. The helper copies it
  into exactly one reply.
- The helper sends a `state` event after every state change, and once after
  `hello`.
- Errors are short sentences for the user. They contain no secrets.

## Commands

| `cmd` | Arguments | `result` | Effect |
|---|---|---|---|
| `hello` | `profileId: string` | `Hello` | Must be first. Selects the state directory for this browser profile. |
| `getState` | | `State` | |
| `login` | `server: string` | `LoginInfo` | Starts the device-code login. The extension opens `url` in a new tab. |
| `cancelLogin` | | `{}` | |
| `logout` | | `{}` | Stops the tunnel, ends the session on the server, deletes saved credentials. |
| `selectOrg` | `orgId: string` | `{}` | Saves the org. If connected, reconnects to the new org. |
| `connect` | | `{}` | Starts the tunnel. Progress arrives as `state` events. |
| `disconnect` | | `{}` | Stops the tunnel. |
| `listExitNodes` | | `ExitNode[]` | Fetches the gateway resources of the org from the server. |
| `setExitNode` | `siteResourceId: number` | `{}` | `0` turns the exit node off. The choice is saved per org and applied on every connect. |

`profileId` is a random string (`[A-Za-z0-9_-]{8,64}`) that the extension
creates once and keeps in `chrome.storage.local`.

`server` is a base URL such as `https://app.pangolin.net`. The helper adds
`https://` when the scheme is missing.

## Types

```ts
interface Hello {
  version: string;          // helper version
  proxy: {
    host: "127.0.0.1";
    port: number;           // HTTP proxy port for this helper process
    username: string;       // Basic proxy credentials, new for each process
    password: string;
  };
}

interface LoginInfo {
  code: string;             // e.g. "ABCD-1234", show it to the user
  url: string;              // approval page; open it in a tab
  expiresAt: number;        // ms since epoch
}

interface ExitNode {
  siteResourceId: number;
  name: string;
  siteNames: string[];
  online: boolean;          // at least one backing site is online
}

type Phase =
  | "loggedOut"      // no saved session
  | "loggingIn"      // device code shown, waiting for approval
  | "disconnected"   // logged in, tunnel stopped
  | "connecting"     // tunnel starting or reconnecting
  | "connected";     // tunnel registered, routes usable

interface State {
  phase: Phase;
  server?: string;
  user?: { email: string; name?: string };
  orgs: { orgId: string; name: string }[];
  orgId?: string;
  login?: LoginInfo;        // only in phase "loggingIn"
  error?: string;           // last error, cleared by the next successful action
  sites: Site[];            // empty unless connecting or connected
  routes: Routes;           // empty unless connected
  exitNode?: {
    siteResourceId: number;
    name: string;
    active: boolean;        // true when the tunnel routes all traffic through it
  };
}

interface Site {
  siteId: number;
  name: string;
  connected: boolean;
  relayed: boolean;
  aliases: string[];        // DNS aliases served by this site
}

interface Routes {
  hosts: string[];          // lower-case host names; may hold * (0+ chars) and ? (1 char)
  cidrs: string[];          // IPv4 CIDRs, e.g. "10.0.0.0/24", "100.96.128.5/32"
}
```

## Browser routing rules

The extension owns `chrome.proxy`. It sets a PAC script that returns
`PROXY 127.0.0.1:<port>` (the helper's HTTP proxy) or `DIRECT`. It answers
the proxy's `407` challenge from `chrome.webRequest.onAuthRequired` with the
`Hello.proxy` credentials, and only for challenges from `127.0.0.1:<port>`.

When `phase` is `connected`:

1. A host that matches `routes.hosts` (case-insensitive, `shExpMatch`
   semantics) goes to the proxy.
2. An IPv4 literal inside `routes.cidrs` goes to the proxy.
3. If `exitNode.active` is true, every other host goes to the proxy, except
   `localhost`, loopback, link-local and RFC 1918 IPv4 literals, which go
   `DIRECT`.
4. Everything else goes `DIRECT`.

When the user wants to be connected but `phase` is not `connected`, or the
helper is not running, the extension fails closed. It sends the hosts and
CIDRs from the last `connected` state to `PROXY 127.0.0.1:1`, which always
fails. If the exit node was active, every host except the step 3 exceptions
goes there too. When the user disconnects or logs out, the extension clears
its proxy settings.

## Helper proxy rules

The helper proxy accepts `CONNECT host:port` and absolute-form HTTP requests
with `Proxy-Authorization: Basic`. Without valid credentials it answers `407`
with `Proxy-Authenticate: Basic realm="pangochrome"`. It dials only through
the tunnel:

- A host that is a Pangolin alias resolves to its alias address.
- An IPv4 literal must be inside a site's remote subnets or alias addresses.
- With an active exit node, any other host or IP is allowed except loopback,
  link-local, multicast and unspecified addresses. Names resolve over the
  tunnel.
- Everything else gets `403`. A failed dial gets `502`.

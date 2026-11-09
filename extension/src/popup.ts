import type {
  BackgroundToPopup,
  HelperStatus,
  PopupAction,
  PopupToBackground,
  Snapshot,
} from "./messages";
import type { ExitNode, LoginInfo, Site, State } from "./protocol";
import { isHttpUrl, isPlainHostname } from "./url";

const INSTALL_COMMAND = "pangochrome-helper install";
const CLOUD_SERVER = "https://app.pangolin.net";
/** The search box appears when the site list has more aliases than this. */
const SEARCH_ALIAS_THRESHOLD = 6;

type Attrs = Record<string, string>;

interface ExitNodeList {
  /** The organisation that the nodes belong to. Null before the first load. */
  loadedFor: string | null;
  loading: boolean;
  nodes: ExitNode[];
  error: string | null;
}

const root = requireElement("root");

let port: chrome.runtime.Port | null = null;
let nextRequestId = 1;
const pending = new Map<
  number,
  { resolve: (result: unknown) => void; reject: (error: Error) => void }
>();

let snapshot: Snapshot | null = null;
let exitNodes: ExitNodeList = { loadedFor: null, loading: false, nodes: [], error: null };
let localError: string | null = null;
let loginChoice: "cloud" | "self" = "cloud";
let selfHostedUrl = "";
let siteQuery = "";
let siteListEl: HTMLElement | null = null;
let lastRenderKey = "";
/** Keys of the actions in flight. Kept here so a re-render does not re-enable a control. */
const busy = new Set<string>();
/** The value that the connect toggle shows while its request is in flight. */
let pendingToggle: boolean | null = null;

connect();
render(true);

function connect(): void {
  let next: chrome.runtime.Port;
  try {
    next = chrome.runtime.connect({ name: "popup" });
  } catch {
    localError = "Could not reach Pangochrome. Reopen the popup.";
    render(true);
    return;
  }
  port = next;
  next.onMessage.addListener((message: BackgroundToPopup) => handleMessage(message));
  next.onDisconnect.addListener(() => {
    if (port === next) port = null;
    for (const entry of pending.values()) {
      entry.reject(new Error("Lost the connection to Pangochrome. Reopen the popup."));
    }
    pending.clear();
    // The service worker restarts when the popup sends its next request.
    setTimeout(connect, 500);
  });
}

function handleMessage(message: BackgroundToPopup): void {
  if (message.type === "snapshot") {
    snapshot = message.snapshot;
    loadExitNodesIfNeeded();
    render();
    return;
  }
  const entry = pending.get(message.id);
  if (!entry) return;
  pending.delete(message.id);
  if (message.ok) {
    entry.resolve(message.result);
  } else {
    entry.reject(new Error(message.error));
  }
}

function call<T>(action: PopupAction): Promise<T> {
  const current = port;
  if (!current) {
    return Promise.reject(new Error("Not connected to Pangochrome. Reopen the popup."));
  }
  const id = nextRequestId++;
  const message: PopupToBackground = { type: "action", id, action };
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: (result) => resolve(result as T), reject });
    current.postMessage(message);
  });
}

/**
 * Sends an action and disables its control until the reply arrives. A second
 * action with the same key is ignored while the first is in flight.
 */
async function act(busyKey: string, action: PopupAction): Promise<void> {
  if (busy.has(busyKey)) return;
  busy.add(busyKey);
  localError = null;
  render(true);
  try {
    await call<unknown>(action);
  } catch (err) {
    localError = describeError(err);
  } finally {
    busy.delete(busyKey);
  }
  render(true);
}

function isBusy(...keys: string[]): boolean {
  return keys.some((key) => busy.has(key));
}

function loadExitNodesIfNeeded(): void {
  const state = snapshot?.state;
  if (!state || !isMainPhase(state) || exitNodes.loading) return;
  const orgKey = state.orgId ?? "";
  if (exitNodes.loadedFor === orgKey) return;
  void loadExitNodes(orgKey);
}

async function loadExitNodes(orgKey: string): Promise<void> {
  exitNodes = { loadedFor: exitNodes.loadedFor, loading: true, nodes: [], error: null };
  render();
  try {
    const nodes = await call<ExitNode[]>({ action: "listExitNodes" });
    exitNodes = { loadedFor: orgKey, loading: false, nodes, error: null };
  } catch (err) {
    exitNodes = { loadedFor: orgKey, loading: false, nodes: [], error: describeError(err) };
  }
  render();
  // The organisation may have changed while the request was in flight.
  loadExitNodesIfNeeded();
}

function render(force = false): void {
  const key = JSON.stringify([snapshot, exitNodes, localError, loginChoice, pendingToggle, [...busy]]);
  if (!force && key === lastRenderKey) return;
  lastRenderKey = key;
  const focused = document.activeElement;
  const focusKey = focused instanceof HTMLElement ? focused.dataset["focus"] : undefined;
  root.replaceChildren(buildView());
  if (focusKey) {
    root.querySelector<HTMLElement>(`[data-focus="${CSS.escape(focusKey)}"]`)?.focus();
  }
}

function buildView(): HTMLElement {
  if (!snapshot) return statusView("Loading...");
  const { helper, state } = snapshot;
  if (helper.kind === "notInstalled" || helper.kind === "failed") return helperView(helper);
  if (helper.kind !== "ready" || state === null) {
    return statusView("Starting the helper...");
  }
  switch (state.phase) {
    case "loggedOut":
      return loginView(state);
    case "loggingIn":
      return loggingInView(state);
    default:
      return mainView(state, snapshot);
  }
}

function statusView(text: string): HTMLElement {
  const view = section();
  view.append(el("p", "muted", text), ...blockedParts("helper"), ...banners(localError));
  return view;
}

function helperView(helper: HelperStatus): HTMLElement {
  const view = section();
  if (helper.kind === "notInstalled") {
    view.append(
      heading("Helper required"),
      el("p", "muted", "Pangochrome needs its helper to reach private sites. Install it, then press Retry."),
      commandRow(INSTALL_COMMAND),
    );
  } else if (helper.kind === "failed") {
    view.append(
      heading("Helper not running"),
      el("p", "muted", "Pangochrome could not start its helper. Press Retry to try again."),
      ...banners(helper.message),
    );
  }
  view.append(...blockedParts("helper"), ...banners(localError));
  const retry = button("Retry", "btn btn-primary", () => act("retry", { action: "retryHelper" }), {
    "data-focus": "retry",
  });
  retry.disabled = isBusy("retry");
  view.append(actionRow([retry]));
  return view;
}

function loginView(state: State): HTMLElement {
  const view = section();
  view.append(heading("Log in"), el("p", "muted", "Choose the Pangolin server for this browser."));

  const choices = el("fieldset", "choices");
  choices.append(
    el("legend", "", "Server"),
    radioChoice("cloud", "Pangolin Cloud (app.pangolin.net)"),
    radioChoice("self", "Self-hosted"),
  );
  view.append(choices);

  const submit = button("Log in", "btn btn-primary", () => {
    const server = loginChoice === "cloud" ? CLOUD_SERVER : selfHostedUrl.trim();
    void act("login", { action: "login", server });
  }, { "data-focus": "login" });
  submit.disabled = isBusy("login") || (loginChoice === "self" && selfHostedUrl.trim() === "");

  if (loginChoice === "self") {
    const input = el("input", "", undefined, {
      type: "text",
      inputmode: "url",
      autocomplete: "off",
      spellcheck: "false",
      placeholder: "https://pangolin.example.com",
      "aria-label": "Server URL",
      "data-focus": "server-url",
    });
    input.value = selfHostedUrl;
    input.addEventListener("input", () => {
      selfHostedUrl = input.value;
      submit.disabled = isBusy("login") || selfHostedUrl.trim() === "";
    });
    view.append(labelled("Server URL", input));
  }

  view.append(
    ...banners(state.error, snapshot?.error, localError),
    ...blockedParts("login"),
    actionRow([submit]),
  );
  return view;
}

function radioChoice(value: "cloud" | "self", label: string): HTMLElement {
  const row = el("label", "choice");
  const input = el("input", "", undefined, {
    type: "radio",
    name: "server-kind",
    value,
    "data-focus": `server-${value}`,
  });
  input.checked = loginChoice === value;
  input.addEventListener("change", () => {
    if (!input.checked) return;
    loginChoice = value;
    render(true);
  });
  row.append(input, document.createTextNode(label));
  return row;
}

function loggingInView(state: State): HTMLElement {
  const view = section();
  const login = state.login;
  view.append(
    heading("Approve this login"),
    el("p", "muted", "Open the approval page and check that it shows this code."),
    el("div", "code-large", login?.code ?? "..."),
    ...banners(state.error, snapshot?.error, localError),
    ...blockedParts("login"),
  );
  const open = button("Open approval page", "btn btn-primary", () => {
    if (login) openApprovalPage(login);
  }, { "data-focus": "approval" });
  open.disabled = login === undefined;
  const cancel = button("Cancel", "btn", () => act("cancel", { action: "cancelLogin" }), {
    "data-focus": "cancel",
  });
  cancel.disabled = isBusy("cancel");
  view.append(actionRow([open, cancel]));
  return view;
}

function openApprovalPage(login: LoginInfo): void {
  openUrl(login.url);
}

function mainView(state: State, snap: Snapshot): HTMLElement {
  const view = section();
  view.append(header(state, snap));
  view.append(...blockedParts("helper"));
  if (snap.wantConnected && state.phase === "disconnected") {
    const reconnect = button("Reconnect", "btn btn-primary", () => act("reconnect", { action: "reconnect" }), {
      "data-focus": "reconnect",
    });
    reconnect.disabled = isBusy("reconnect");
    view.append(actionRow([reconnect]));
  }
  view.append(...orgSection(state));
  view.append(exitNodeField(state));
  view.append(...banners(state.error, snap.error, localError));
  view.append(sitesCard(state));
  view.append(footer(state));
  return view;
}

/**
 * The text and the turn-off control shown while the user wants the connection
 * but traffic is not routed through it. Empty when the connected routing is in effect.
 */
function blockedParts(reason: "login" | "helper"): HTMLElement[] {
  const snap = snapshot;
  if (!snap || !snap.wantConnected || snap.mode === "connected") return [];
  const scope = snap.exitChosen ? "All traffic stays" : "Private sites stay";
  const text =
    reason === "login"
      ? `${scope} blocked until you log in.`
      : `${scope} blocked until Pangochrome connects.`;
  const turnOff = button("Turn off and browse normally", "btn", () => act("turnOff", {
    action: "setConnected",
    connected: false,
  }), { "data-focus": "turn-off" });
  turnOff.disabled = isBusy("turnOff", "toggle");
  return [el("p", "notice", text), actionRow([turnOff])];
}

function header(state: State, snap: Snapshot): HTMLElement {
  const row = el("div", "header");
  const titles = el("div", "title-block");
  titles.append(
    el("div", "brand", "Pangochrome"),
    el("div", "status", statusText(state, snap), { "aria-live": "polite" }),
  );
  const toggle = el("input", "switch", undefined, {
    type: "checkbox",
    role: "switch",
    "aria-label": "Connect",
    "data-focus": "toggle",
  });
  toggle.checked = pendingToggle ?? snap.wantConnected;
  toggle.disabled = isBusy("toggle");
  toggle.addEventListener("change", () => {
    const next = toggle.checked;
    pendingToggle = next;
    void act("toggle", { action: "setConnected", connected: next }).then(() => {
      pendingToggle = null;
      render(true);
    });
  });
  row.append(titles, toggle);
  return row;
}

/** The status line follows the routing that is in effect, not only the helper's phase. */
function statusText(state: State, snap: Snapshot): string {
  if (state.phase === "connecting") return "Connecting...";
  if (state.phase === "connected" && snap.mode === "connected") {
    return state.exitNode?.active === true
      ? `Connected via exit node ${state.exitNode.name}`
      : "Connected";
  }
  return "Disconnected";
}

/** The organisation selector. It appears for several organisations, or when the current one is missing from the list. */
function orgSection(state: State): HTMLElement[] {
  if (state.orgs.length === 0) {
    return [el("p", "muted", "You are not in any organisation.")];
  }
  const current = state.orgId ?? "";
  const missing = current !== "" && !state.orgs.some((org) => org.orgId === current);
  if (state.orgs.length < 2 && !missing) return [];

  const select = el("select", "", undefined, { "data-focus": "org" });
  for (const org of state.orgs) select.append(new Option(org.name, org.orgId));
  if (missing) select.append(new Option(current, current));
  select.value = current;
  select.disabled = isBusy("org");
  select.addEventListener("change", () => {
    void act("org", { action: "selectOrg", orgId: select.value });
  });
  return [labelled("Organisation", select)];
}

function exitNodeField(state: State): HTMLElement {
  const orgKey = state.orgId ?? "";
  const loaded = exitNodes.loadedFor === orgKey && !exitNodes.loading;
  const current = state.exitNode?.siteResourceId ?? 0;

  const options: Array<[number, string]> = [[0, "None"]];
  if (loaded) {
    for (const node of exitNodes.nodes) {
      options.push([node.siteResourceId, node.online ? node.name : `${node.name} (offline)`]);
    }
  }
  if (current !== 0 && state.exitNode && !options.some(([id]) => id === current)) {
    options.push([current, state.exitNode.name]);
  }

  const select = el("select", "", undefined, { "data-focus": "exit-node" });
  for (const [id, label] of options) select.append(new Option(label, String(id)));
  select.value = String(current);
  select.disabled = !loaded || isBusy("exit");
  select.addEventListener("change", () => {
    void act("exit", { action: "setExitNode", siteResourceId: Number(select.value) });
  });

  const wrapper = el("div", "stack");
  wrapper.append(labelled("Exit node", select));
  if (exitNodes.loading) {
    wrapper.append(el("p", "muted", "Loading exit nodes..."));
  }
  if (loaded && exitNodes.error) {
    wrapper.append(el("p", "muted", `Could not load exit nodes: ${exitNodes.error}`));
  }
  return wrapper;
}

function sitesCard(state: State): HTMLElement {
  const card = el("section", "card");
  card.append(el("h2", "card-title", "Sites"));
  if (aliasCount(state.sites) > SEARCH_ALIAS_THRESHOLD) {
    const search = el("input", "search", undefined, {
      type: "search",
      placeholder: "Search sites and aliases",
      "aria-label": "Search sites and aliases",
      "data-focus": "site-search",
    });
    search.value = siteQuery;
    search.addEventListener("input", () => {
      siteQuery = search.value;
      renderSiteList();
    });
    card.append(search);
  }
  siteListEl = el("ul", "site-list");
  card.append(siteListEl);
  renderSiteList();
  return card;
}

function renderSiteList(): void {
  if (!siteListEl) return;
  const sites = snapshot?.state?.sites ?? [];
  const query = aliasCount(sites) > SEARCH_ALIAS_THRESHOLD ? siteQuery.trim().toLowerCase() : "";
  const items: HTMLElement[] = [];
  for (const site of sites) {
    const siteMatches = query === "" || site.name.toLowerCase().includes(query);
    const aliases = siteMatches
      ? site.aliases
      : site.aliases.filter((alias) => alias.toLowerCase().includes(query));
    if (!siteMatches && aliases.length === 0) continue;
    items.push(siteItem(site, aliases));
  }
  if (items.length === 0) {
    const message = sites.length === 0
      ? "Sites appear when the tunnel connects."
      : "No sites match your search.";
    siteListEl.replaceChildren(el("li", "muted", message));
    return;
  }
  siteListEl.replaceChildren(...items);
}

function siteItem(site: Site, aliases: string[]): HTMLElement {
  const item = el("li", "site");
  const head = el("div", "site-head");
  const dot = el("span", site.connected ? "dot dot-on" : "dot");
  dot.setAttribute("aria-hidden", "true");
  head.append(
    dot,
    el("span", "site-name", site.name),
    el("span", "visually-hidden", site.connected ? "Connected." : "Not connected."),
  );
  if (site.relayed) head.append(el("span", "tag", "Relayed"));
  item.append(head);

  if (aliases.length === 0) {
    item.append(el("p", "muted", "No aliases"));
    return item;
  }
  const list = el("ul", "aliases");
  for (const alias of aliases) list.append(aliasRow(alias));
  item.append(list);
  return item;
}

function aliasRow(alias: string): HTMLElement {
  const copy = button("Copy", "btn btn-small", () => copyText(copy, alias), {
    "aria-label": `Copy ${alias}`,
    "data-focus": `copy:${alias}`,
  });

  // Only plain host names can be opened. Wildcard patterns and names with other characters cannot.
  const plain = isPlainHostname(alias);
  const open = button("Open", "btn btn-small", () => openUrl(`https://${alias}/`), {
    "aria-label": `Open ${alias}`,
    "data-focus": `open:${alias}`,
  });
  open.disabled = !plain;
  if (!plain) open.title = "Only plain host names can be opened.";

  const actions = el("div", "alias-actions");
  actions.append(copy, open);
  const row = el("li", "alias");
  row.append(el("code", "alias-name", alias), actions);
  return row;
}

function openUrl(url: string): void {
  if (!isHttpUrl(url)) {
    localError = "That address cannot be opened.";
    render(true);
    return;
  }
  chrome.tabs.create({ url }).catch((err: unknown) => {
    localError = `Could not open the page. ${describeError(err)}`;
    render(true);
  });
}

async function copyText(target: HTMLButtonElement, text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    localError = "Could not copy to the clipboard.";
    render(true);
    return;
  }
  target.textContent = "Copied";
  setTimeout(() => {
    target.textContent = "Copy";
  }, 1500);
}

function footer(state: State): HTMLElement {
  const footerEl = el("footer", "footer");
  const who = el("div", "footer-text");
  who.append(
    el("div", "", state.user?.email ?? ""),
    el("div", "muted", state.server ?? ""),
  );
  const logout = button("Log out", "btn btn-small", () => act("logout", { action: "logout" }), {
    "data-focus": "logout",
  });
  logout.disabled = isBusy("logout");
  footerEl.append(who, logout);
  return footerEl;
}

function commandRow(command: string): HTMLElement {
  const row = el("div", "command");
  const copy = button("Copy", "btn btn-small", () => copyText(copy, command), {
    "aria-label": "Copy the install command",
    "data-focus": "copy-install",
  });
  row.append(el("code", "command-text", command), copy);
  return row;
}

function aliasCount(sites: Site[]): number {
  return sites.reduce((total, site) => total + site.aliases.length, 0);
}

function isMainPhase(state: State): boolean {
  return state.phase === "disconnected" || state.phase === "connecting" || state.phase === "connected";
}

function banners(...messages: Array<string | null | undefined>): HTMLElement[] {
  return messages.flatMap((message) =>
    message ? [el("p", "banner", message, { role: "alert" })] : [],
  );
}

function section(): HTMLElement {
  return el("section", "view");
}

function heading(text: string): HTMLElement {
  return el("h1", "", text);
}

function actionRow(children: HTMLElement[]): HTMLElement {
  const row = el("div", "actions");
  row.append(...children);
  return row;
}

function labelled(text: string, control: HTMLElement): HTMLElement {
  const label = el("label", "field");
  label.append(el("span", "field-label", text), control);
  return label;
}

function button(
  label: string,
  className: string,
  onClick: () => void | Promise<void>,
  attrs: Attrs = {},
): HTMLButtonElement {
  const node = el("button", className, label, { type: "button", ...attrs });
  node.addEventListener("click", () => {
    void onClick();
  });
  return node;
}

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className = "",
  text?: string,
  attrs: Attrs = {},
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  for (const [name, value] of Object.entries(attrs)) node.setAttribute(name, value);
  return node;
}

function requireElement(id: string): HTMLElement {
  const node = document.getElementById(id);
  if (!(node instanceof HTMLElement)) throw new Error(`Missing #${id} element.`);
  return node;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

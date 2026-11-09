import type {
  BackgroundToPopup,
  HelperStatus,
  PopupAction,
  PopupToBackground,
  Snapshot,
} from "./messages";
import type { ExitNode, Site, State } from "./protocol";

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

/** Sends an action and shows its error, if any. Always re-renders, so disabled controls recover. */
async function act(action: PopupAction): Promise<void> {
  localError = null;
  try {
    await call<unknown>(action);
  } catch (err) {
    localError = describeError(err);
  }
  render(true);
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
  const key = JSON.stringify([snapshot, exitNodes, localError, loginChoice]);
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
  if (helper.kind !== "ready" || state === null) return statusView("Starting the helper...");
  switch (state.phase) {
    case "loggedOut":
      return loginView(snapshot.error);
    case "loggingIn":
      return loggingInView(state, snapshot.error);
    default:
      return mainView(state, snapshot.wantConnected, snapshot.error);
  }
}

function statusView(text: string): HTMLElement {
  const view = section();
  view.append(el("p", "muted", text));
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
  view.append(
    actionRow([
      button("Retry", "btn btn-primary", () => act({ action: "retryHelper" }), {
        "data-focus": "retry",
      }),
    ]),
  );
  return view;
}

function loginView(error: string | null): HTMLElement {
  const view = section();
  view.append(heading("Log in"), el("p", "muted", "Choose the Pangolin server for this browser."));

  const choices = el("fieldset", "choices");
  choices.append(
    el("legend", "", "Server"),
    radioChoice("cloud", "Pangolin Cloud (app.pangolin.net)"),
    radioChoice("self", "Self-hosted"),
  );
  view.append(choices);

  const submit = button("Log in", "btn btn-primary", async () => {
    const server = loginChoice === "cloud" ? CLOUD_SERVER : selfHostedUrl.trim();
    submit.disabled = true;
    await act({ action: "login", server });
  }, { "data-focus": "login" });
  submit.disabled = loginChoice === "self" && selfHostedUrl.trim() === "";

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
      submit.disabled = selfHostedUrl.trim() === "";
    });
    view.append(labelled("Server URL", input));
  }

  view.append(...banners(error, localError), actionRow([submit]));
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

function loggingInView(state: State, error: string | null): HTMLElement {
  const view = section();
  const login = state.login;
  view.append(
    heading("Approve this login"),
    el("p", "muted", "Open the approval page and check that it shows this code."),
    el("div", "code-large", login?.code ?? "...", {
      "aria-label": login ? `Approval code ${login.code}` : "Waiting for the approval code",
    }),
    ...banners(error, localError),
  );
  const open = button("Open approval page", "btn btn-primary", () => {
    if (login) void chrome.tabs.create({ url: login.url });
  }, { "data-focus": "approval" });
  open.disabled = login === undefined;
  view.append(
    actionRow([
      open,
      button("Cancel", "btn", () => act({ action: "cancelLogin" }), { "data-focus": "cancel" }),
    ]),
  );
  return view;
}

function mainView(state: State, wantConnected: boolean, error: string | null): HTMLElement {
  const view = section();
  view.append(header(state, wantConnected));
  if (state.orgs.length > 1) view.append(orgField(state));
  view.append(exitNodeField(state));
  view.append(...banners(state.error, error, localError));
  view.append(sitesCard(state));
  view.append(footer(state));
  return view;
}

function header(state: State, wantConnected: boolean): HTMLElement {
  const row = el("div", "header");
  const titles = el("div", "title-block");
  titles.append(
    el("div", "brand", "Pangochrome"),
    el("div", "status", statusText(state), { "aria-live": "polite" }),
  );
  const toggle = el("input", "switch", undefined, {
    type: "checkbox",
    role: "switch",
    "aria-label": "Connect",
    "data-focus": "toggle",
  });
  toggle.checked = wantConnected;
  toggle.addEventListener("change", () => {
    void act({ action: "setConnected", connected: toggle.checked });
  });
  row.append(titles, toggle);
  return row;
}

function statusText(state: State): string {
  switch (state.phase) {
    case "connected":
      return state.exitNode?.active === true
        ? `Connected via exit node ${state.exitNode.name}`
        : "Connected";
    case "connecting":
      return "Connecting...";
    default:
      return "Disconnected";
  }
}

function orgField(state: State): HTMLElement {
  const select = el("select", "", undefined, { "data-focus": "org" });
  for (const org of state.orgs) select.append(new Option(org.name, org.orgId));
  select.value = state.orgId ?? "";
  select.addEventListener("change", () => {
    void act({ action: "selectOrg", orgId: select.value });
  });
  return labelled("Organisation", select);
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
  select.disabled = !loaded;
  select.addEventListener("change", () => {
    void act({ action: "setExitNode", siteResourceId: Number(select.value) });
  });

  const wrapper = el("div", "stack");
  wrapper.append(labelled("Exit node", select));
  if (!loaded && !exitNodes.loading && exitNodes.error === null) {
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

  // Wildcard patterns are not host names, so they cannot be opened.
  const wildcard = /[*?]/.test(alias);
  const open = button("Open", "btn btn-small", () => {
    void chrome.tabs.create({ url: `https://${alias}/` });
  }, {
    "aria-label": `Open https://${alias}/`,
    "data-focus": `open:${alias}`,
  });
  open.disabled = wildcard;
  if (wildcard) open.title = "Wildcard aliases cannot be opened.";

  const actions = el("div", "alias-actions");
  actions.append(copy, open);
  const row = el("li", "alias");
  row.append(el("code", "alias-name", alias), actions);
  return row;
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
  footerEl.append(
    who,
    button("Log out", "btn btn-small", () => act({ action: "logout" }), {
      "data-focus": "logout",
    }),
  );
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

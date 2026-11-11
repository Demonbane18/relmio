import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";

const source = async () => readFile("src/ui/local.js", "utf8");
const between = (text, start, end) => {
  const from = text.indexOf(start); const to = text.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `missing ${start}`);
  return text.slice(from, to);
};
// Page helpers the detail and snapshot renderers call. The status helper is the real one.
const footerHelpers = (script) => [
  between(script, "function isCodexChat(target)", "\nfunction assistantModeLabel"),
  between(script, "function renderFooterForTarget(target)", "\nfunction renderTarget"),
  between(script, "function dashboardServiceStatus(service)", "\nfunction dashboardBoundary"),
].join("\n");
const snapshot = () => ({ generatedAt: "2026-09-05T00:00:00.000Z", services: [
  { target: "codex-chatgpt", label: "Codex (ChatGPT login)", kind: "endpoint", managed: true, state: "healthy", snapshot: { target: "codex-chatgpt", endpoint: "ws://127.0.0.1:14500/", auth: { configured: true, disclosure: "rotate-only" }, canRotateCredential: true }, actions: ["sign-in-chatgpt", "sign-out-chatgpt", "rotate-local-capability"] },
  { target: "codex-chat", label: "Codex Chat adapter", kind: "endpoint", managed: false, state: "absent", snapshot: null, actions: ["setup"] },
  { target: "xai-grok-build", label: "SuperGrok", kind: "endpoint", managed: false, state: "absent", snapshot: null, actions: ["setup"] },
  { target: "local-n8n-stack", label: "Local n8n stack", kind: "n8n-stack", managed: false, state: "absent", snapshot: null, actions: ["setup"] },
  { target: "n8n-openai-oauth", label: "OpenAI OAuth bridge", kind: "n8n-oauth-bridge", managed: false, state: "absent", snapshot: null, actions: ["setup"] },
  { target: "local-n8n-assistant", label: "AI Assistant tools", kind: "n8n-assistant", managed: false, state: "absent", snapshot: null, actions: ["setup"] },
], providers: [
  { target: "codex-chatgpt", label: "ChatGPT", authentication: "provider-oauth", readiness: "runtime-owned" },
  { target: "codex-chat", label: "ChatGPT", authentication: "provider-oauth", readiness: "runtime-owned" },
  { target: "xai-grok-build", label: "SuperGrok", authentication: "provider-oauth", readiness: "runtime-owned" },
] });

test("expired inventory refuses actions and marks the verified snapshot stale", async () => {
  const script = await source();
  const stale = between(script, "function isDashboardSnapshotStale", "\nfunction appendDashboardFact");
  const actions = between(script, "async function runDashboardAction", "\nfunction renderDashboardAction");
  const view = snapshot(); const error = { hidden: true, focus() { this.focused = true; }, textContent: "" }; let setup = 0; const renders = [];
  const run = runInNewContext(`const DASHBOARD_STALE_AFTER_MS = 300000;${stale}\n${actions}; runDashboardAction;`, {
    Date: class extends Date { static now() { return Date.parse(view.generatedAt) + 300001; } },
    dashboardToWizardTarget: (target) => target, document: { body: { dataset: { localView: "dashboard" } } }, element: () => error,
    async enterSetupView() { setup += 1; }, isDashboardSnapshotStale: () => true, renderDashboardSnapshot(...args) { renders.push(args); }, showDashboardRemovalReview() {}, showDashboardCodexSignInManagement() {}, showDashboardProviderRuntimeGuidance() {}, showDashboardRotationReview() {}, showStoppedManagedLocalN8nStack() {}, state: { dashboardBusy: false, dashboardSnapshot: view },
  });
  await run(view.services[0], "sign-in-chatgpt");
  assert.equal(setup, 0); assert.equal(renders.length, 1); assert.equal(renders[0][1].stale, true); assert.equal(error.focused, true);
});

test("dashboard timer rerenders stale inventory and reduced motion selects auto scrolling", async () => {
  const script = await source(); const stale = between(script, "function isDashboardSnapshotStale", "\nfunction appendDashboardFact"); const motion = between(script, "function preferredScrollBehavior", "\nif (typeof document");
  let callback; let now = Date.parse(snapshot().generatedAt) + 1; const state = { dashboardStaleTimer: 8, dashboardSnapshot: snapshot() };
  const helpers = runInNewContext(`const DASHBOARD_STALE_AFTER_MS = 300000;${stale}\n${motion}; ({scheduleDashboardStaleExpiry, preferredScrollBehavior});`, { Date: class extends Date { static now() { return now; } }, state, document: { body: { dataset: { localView: "dashboard" } } }, window: { clearTimeout() {}, setTimeout(fn, delay) { callback = { fn, delay }; return 9; }, matchMedia: () => ({ matches: true }) }, renderDashboardSnapshot(value, options) { state.rendered = { value, options }; } });
  helpers.scheduleDashboardStaleExpiry(state.dashboardSnapshot); assert.equal(callback.delay, 300000); now += 300001; callback.fn(); assert.equal(state.rendered.options.stale, true); assert.equal(helpers.preferredScrollBehavior(), "auto");
});

test("approved endpoint facts copy safely and copy failures expose no endpoint", async () => {
  const script = await source(); const facts = between(script, "function appendDashboardFact", "\nfunction dashboardComponentSummary"); const details = between(script, "function dashboardProviderForTarget", "\nfunction renderDashboardServiceRow");
  const nodes = new Map(); const make = () => ({ children: [], lastElementChild: { textContent: "" }, dataset: {}, attributes: new Map(), append(...items) { this.children.push(...items); }, addEventListener(event, listener) { this.listener = listener; }, setAttribute(k,v) { this.attributes.set(k,v); }, focus() { this.focused = true; }, replaceChildren(...items) { this.children = items; } }); const element = (id) => nodes.get(id) ?? nodes.set(id, make()).get(id);
  let fail = false; const render = runInNewContext(`${footerHelpers(script)}\n${facts}\n${details}; renderDashboardServiceDetail;`, { document: { createElement: make }, element, copyText: async () => { if (fail) throw new Error("copy denied"); }, flashCopied() {}, dashboardBoundary: () => "Verified", dashboardComponentSummary: () => "", dashboardServiceDescription: () => "", dashboardStateLabel: () => "Healthy", dashboardStatusDot: make, renderDashboardAction: () => null, state: { dashboardSnapshot: snapshot() } });
  render(snapshot().services[0]); const walk = (node) => node.listener ? node : node.children.flatMap((child) => [walk(child)]).find(Boolean); const button = walk(element("dashboard-service-facts")); assert.ok(button); await button.listener(); fail = true; await button.listener(); assert.equal(element("dashboard-error").focused, true); assert.doesNotMatch(element("dashboard-error").textContent, /127\.0\.0\.1/u);
});

test("stale dashboard rerender restores focus to the matching Codex endpoint copy control", async () => {
  const script = await source();
  const staleAndFocus = between(script, "function isDashboardSnapshotStale", "\nfunction appendDashboardFact");
  const facts = between(script, "function appendDashboardFact", "\nfunction dashboardComponentSummary");
  const details = between(script, "function dashboardProviderForTarget", "\nfunction renderDashboardServiceRow");
  const render = between(script, "function renderDashboardSnapshot", "\nfunction renderDashboardFailure");
  const view = { ...snapshot(), docker: { available: true, version: "29", composeVersion: "5" }, auth: { secretsRevealable: false } };
  let now = Date.parse(view.generatedAt) + 1; let timer; const nodes = new Map();
  const node = (tag = "div") => ({ tagName: tag, attributes: new Map(), children: [], lastElementChild: { textContent: "" }, classList: { add() {}, remove() {} }, dataset: {}, disabled: false, hidden: false, append(...items) { this.children.push(...items); this.childElementCount = this.children.length; this.lastElementChild = items.at(-1) ?? null; }, addEventListener() {}, getAttribute(name) { return this.attributes.get(name) ?? null; }, setAttribute(name, value) { this.attributes.set(name, String(value)); }, replaceChildren(...items) { this.children = items; this.childElementCount = items.length; this.lastElementChild = items.at(-1) ?? null; }, focus(options) { this.focusOptions = options; document.activeElement = this; } });
  const element = (id) => nodes.get(id) ?? nodes.set(id, node()).get(id);
  const descend = (root) => [root, ...(root.children ?? []).flatMap(descend)];
  const body = node("body"); body.dataset.localView = "dashboard";
  const document = { activeElement: body, body, createElement: node, querySelectorAll(selector) { assert.equal(selector, "[data-dashboard-service]"); return [...nodes.values()].flatMap(descend).filter((item) => item.dataset?.dashboardService); } };
  const controls = runInNewContext(`const DASHBOARD_STALE_AFTER_MS = 300000;${footerHelpers(script)}\n${staleAndFocus}\n${facts}\n${details}\n${render}; renderDashboardSnapshot;`, {
    Date: class extends Date { static now() { return now; } }, DASHBOARD_SERVICE_DEFINITIONS: view.services.map(({ target, label }) => ({ target, label })), document, element,
    state: { dashboardBusy: false, dashboardFocusIdentity: null, dashboardSelectedTarget: "codex-chatgpt", dashboardSnapshot: null, dashboardStaleTimer: null },
    window: { clearTimeout() {}, setTimeout(callback, delay) { timer = { callback, delay }; return 1; } },
    assistantModeLabel: () => "Disabled", copyText: async () => {}, dashboardBoundary: () => "Verified", dashboardComponentSummary: () => "n8n", dashboardServiceDescription: () => "Verified service", dashboardStateLabel: (value) => value, dashboardStateNode: () => node("span"), dashboardStatusDot: () => node("span"), flashCopied() {}, localTime: () => node("time"), renderDashboardAction: () => null, renderDashboardCompactService: () => node("li"), renderDashboardProvider: () => node("li"), renderDashboardSectionStatus: () => node("li"), renderDashboardServiceRow(service) { const item = node("li"); const select = node("button"); select.dataset.dashboardService = service.target; select.dataset.dashboardControl = "select"; item.append(select); return item; }, renderDashboardTruth() {},
  });
  const copy = () => descend(element("dashboard-service-facts")).find((item) => item.tagName === "button");
  controls(view, { stale: false }); const before = copy();
  assert.equal(before.dataset.dashboardService, "codex-chatgpt"); assert.equal(before.dataset.dashboardFact, "endpoint"); before.focus();
  assert.equal(timer.delay, 300000); now += 300001; timer.callback();
  const after = copy(); assert.notEqual(after, before); assert.equal(document.activeElement, after); assert.equal(after.focusOptions.preventScroll, true);
});

test("dashboard copy allowlist includes endpoint and n8n URLs but never credential values", async () => {
  const script = await source(); const facts = between(script, "function appendDashboardFact", "\nfunction dashboardComponentSummary"); const details = between(script, "function dashboardProviderForTarget", "\nfunction renderDashboardServiceRow");
  const nodes = new Map(); const node = (tag = "div") => ({ tagName: tag, attributes: new Map(), children: [], lastElementChild: { textContent: "" }, classList: { add() {}, remove() {} }, dataset: {}, hidden: false, append(...items) { this.children.push(...items); this.childElementCount = this.children.length; }, addEventListener(name, callback) { this.listener = callback; }, setAttribute(name, value) { this.attributes.set(name, String(value)); }, replaceChildren(...items) { this.children = items; this.childElementCount = items.length; }, focus() { this.focused = true; } }); const element = (id) => nodes.get(id) ?? nodes.set(id, node()).get(id);
  const detail = runInNewContext(`${footerHelpers(script)}\n${facts}\n${details}; renderDashboardServiceDetail;`, { document: { createElement: node }, element, state: { dashboardSnapshot: snapshot() }, assistantModeLabel: () => "Disabled", copyText: async () => {}, flashCopied() {}, dashboardBoundary: () => "Verified", dashboardComponentSummary: () => "n8n, ngrok", dashboardServiceDescription: () => "Verified", dashboardStateLabel: (value) => value, dashboardStatusDot: () => node("span"), renderDashboardAction: () => null });
  const buttons = () => element("dashboard-service-facts").children.flatMap((row) => row.children.flatMap((child) => child.children?.filter((item) => item.tagName === "button") ?? []));
  detail(snapshot().services[0]); assert.deepEqual(buttons().map((button) => button.attributes.get("aria-label")), ["Copy Codex (ChatGPT login) endpoint"]);
  detail({ target: "local-n8n-stack", label: "Local n8n stack", kind: "n8n-stack", managed: true, state: "healthy", actions: [], snapshot: { endpoints: { n8nLocal: "http://127.0.0.1:5678/", ngrokPublic: "https://workflow.example.invalid/" }, components: { n8n: true, ngrok: true }, assistantMode: "disabled" } });
  assert.deepEqual(buttons().map((button) => button.attributes.get("aria-label")), ["Copy local n8n URL", "Copy public n8n URL"]);
  detail({ target: "local-n8n-assistant", label: "AI Assistant tools", kind: "n8n-assistant", managed: true, state: "healthy", actions: [], snapshot: { components: { codeSandbox: true } } });
  assert.equal(buttons().length, 0);
});

// The real setup reset and dashboard entry up to the inventory read, which is a stub.
function dashboardEntry(script) {
  const code = [
    between(script, "function clearLocalModelPoll()", "\nfunction renderLocalModelStatus"),
    between(script, "function captureDashboardFocusIdentity", "\nfunction restoreDashboardFocus"),
    between(script, "function renderDashboardTruth", "\nfunction renderDashboardServiceDetail"),
    between(script, "function renderDashboardChecking", "\nfunction renderDashboardSnapshot"),
    between(script, "function setClaudeOneTimeKey(key)", "\nfunction renderClaudeStatus"),
    between(script, "function clearOneTimeSetupValues", "\nfunction syncDashboardNavigation"),
    "enterDashboardView;",
  ].join("\n");
  const nodes = new Map();
  const element = (id) => nodes.get(id) ?? nodes.set(id, { id, checked: true, dataset: {}, disabled: false, hidden: false, textContent: `pending-${id}`, value: `pending-${id}`, replaceChildren(...children) { this.children = children; }, removeAttribute(name) { if (name === "href") this.href = ""; }, setAttribute() {}, querySelector: () => null, focus() {} }).get(id);
  const state = { assistantSearxngReview: { reviewId: "pending" }, assistantSearxngReviewId: "pending", dashboardFocusIdentity: { service: "codex-chatgpt" }, dashboardGeneration: 0, installedTarget: "local-n8n-assistant", localModelPollTimer: 7, localModelGeneration: 0, plan: { target: "local-n8n-assistant" }, planId: "pending" };
  const calls = []; const clearedTimers = [];
  const openDisclosures = [{ open: true }, { open: true }];
  const document = { body: { dataset: {} }, querySelectorAll: () => openDisclosures };
  const enter = runInNewContext(code, { state, element, document, window: { clearTimeout(timer) { clearedTimers.push(timer); }, scrollTo(options) { calls.push(options); } }, async api(path, options) { calls.push([path, options]); return { discarded: true }; }, clearChatTesterState() { calls.push("chat-cleared"); }, clearDashboardStaleTimer() {}, invalidatePlan() { state.plan = null; state.planId = null; }, preferredScrollBehavior: () => "auto", async loadLocalDashboard() { calls.push("inventory"); }, renderInstalledImages(images, visible) { calls.push(["images", images, visible]); }, scheduleDashboardStaleExpiry() {} });
  return { enter, state, element, document, calls, clearedTimers, openDisclosures };
}

test("returning to dashboard discards pending setup reviews and one-time values", async () => {
  const { enter, state, element, calls, clearedTimers, openDisclosures } = dashboardEntry(await source());
  await enter();
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0])), ["/api/local/discard", { method: "POST", body: {} }]);
  assert.equal(state.plan, null);
  assert.equal(state.planId, null);
  assert.equal(state.installedTarget, null);
  assert.equal(state.assistantSearxngReview, null);
  assert.equal(state.assistantSearxngReviewId, null);
  // The inventory check starts on the dashboard, so no control focused before setup gets focus back.
  assert.equal(state.dashboardFocusIdentity, null);
  assert.equal(element("result-credential").textContent, "");
  assert.equal(element("ngrok-authtoken").value, "");
  assert.equal(element("install-result-list").hidden, true);
  assert.ok(openDisclosures.every((details) => details.open === false), "removal and tester disclosures start closed next time");
  assert.equal(calls.at(-1), "inventory");
  assert.deepEqual(clearedTimers, [7]);
  assert.equal(state.localModelPollTimer, null);
  assert.equal(state.localModelGeneration, 1);
  assert.equal(element("n8n-local-model-management").hidden, true);
  // The one-time Claude key leaves the page, and the guide no longer sees a fresh key.
  assert.equal(element("claude-client-key").textContent, "");
  assert.equal(element("claude-one-time-key").hidden, true);
  assert.equal(element("claude-copy-key").dataset.guideState, "none");
});

test("a refresh keeps the dashboard control focused at the press for its inventory check to restore", async () => {
  const { enter, state, document } = dashboardEntry(await source());
  document.body.dataset.localView = "dashboard";
  document.activeElement = { dataset: { dashboardService: "codex-chatgpt", dashboardControl: "select" } };
  const entering = enter({ preserveFocus: true, preserveScroll: true });
  // The check disabled that control, so the browser moved focus to the page while the discard ran.
  document.activeElement = document.body;
  await entering;
  assert.deepEqual(JSON.parse(JSON.stringify(state.dashboardFocusIdentity)), { service: "codex-chatgpt", action: null, actionLocation: null, fact: null });
});

test("dashboard direct hashes and browser history retain one current navigation link", async () => {
  const script = await source(); const navigation = between(script, "function syncDashboardNavigation", "\nfunction initializeLocalDashboard"); const init = between(script, "function initializeLocalDashboard", "\nfunction parseRelmioStreamEvent");
  const links = ["#dashboard-overview", "#dashboard-connections", "#dashboard-n8n", "#dashboard-credentials", "#dashboard-activity"].map((href) => ({ attributes: new Map([["href", href]]), getAttribute(name) { return this.attributes.get(name) ?? null; }, setAttribute(name, value) { this.attributes.set(name, String(value)); }, removeAttribute(name) { this.attributes.delete(name); }, addEventListener(name, callback) { this.listener = callback; } }));
  const listeners = new Map(); const window = { location: { hash: "#dashboard-n8n" }, addEventListener(name, callback) { listeners.set(name, callback); } }; const sync = runInNewContext(`${navigation}; syncDashboardNavigation;`, { document: { querySelectorAll: () => links, getElementById: () => ({ hidden: false }) }, window });
  sync(); assert.equal(links[2].attributes.get("aria-current"), "location"); window.location.hash = "#dashboard-activity"; sync(); assert.equal(links[4].attributes.get("aria-current"), "location"); window.location.hash = "#unknown"; sync(); assert.equal(links[0].attributes.get("aria-current"), "location");
  const initialize = runInNewContext(`${init}; initializeLocalDashboard;`, { document: { querySelectorAll: () => links, getElementById: () => ({ hidden: false }) }, element: () => ({ addEventListener() {} }), window, syncDashboardNavigation: sync, async enterDashboardView() {}, async refreshProjectMeta() {}, enterSetupView() {}, renderDashboardFailure() {}, showError() {} });
  initialize(); window.location.hash = "#dashboard-connections"; listeners.get("hashchange")(); assert.equal(links[1].attributes.get("aria-current"), "location"); assert.equal(links.filter((link) => link.attributes.has("aria-current")).length, 1);
});

// Each request waits until the test answers it, so overlapping checks can finish in any order.
function heldRequests() {
  const calls = [];
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  return {
    calls,
    api: (path) => new Promise((resolve, reject) => calls.push({ path, resolve, reject })),
    async answer(index, value) { calls[index].resolve(value); await settle(); },
    async fail(index, error) { calls[index].reject(error); await settle(); },
    settle,
  };
}

// The real dashboard entry, inventory check, renderers and buttons on a fake page.
function dashboardPage(script) {
  const code = [
    "const DASHBOARD_STALE_AFTER_MS = 300000;",
    footerHelpers(script),
    between(script, "function isDashboardSnapshotStale", "\nfunction appendDashboardFact"),
    between(script, "function appendDashboardFact", "\nfunction dashboardComponentSummary"),
    between(script, "function dashboardProviderForTarget", "\nfunction renderDashboardServiceRow"),
    between(script, "function renderDashboardChecking", "\nasync function loadLocalDashboard"),
    between(script, "async function loadLocalDashboard", "\n// Plan and usage"),
    between(script, "async function enterSetupView(", "\nfunction syncDashboardNavigation"),
    between(script, "function initializeLocalDashboard", "\nfunction parseRelmioStreamEvent"),
    "({ initialize: initializeLocalDashboard, loadLocalDashboard, enterSetupView, renderFooterForTarget });",
  ].join("\n");
  const view = { ...snapshot(), docker: { available: true, version: "29", composeVersion: "5" }, auth: { secretsRevealable: false } };
  const held = heldRequests(); const nodes = new Map(); const scrolls = []; const failures = [];
  const node = (tag = "div") => ({ tagName: tag, attributes: new Map(), children: [], listeners: {}, lastElementChild: { textContent: "" }, classList: { add() {}, remove() {} }, dataset: {}, disabled: false, hidden: false, append(...items) { this.children.push(...items); this.childElementCount = this.children.length; this.lastElementChild = items.at(-1) ?? null; }, addEventListener(name, handler) { this.listeners[name] = handler; }, getAttribute(name) { return this.attributes.get(name) ?? null; }, setAttribute(name, value) { this.attributes.set(name, String(value)); }, replaceChildren(...items) { this.children = items; this.childElementCount = items.length; this.lastElementChild = items.at(-1) ?? null; }, querySelector: () => null, focus() { document.activeElement = this; } });
  const element = (id) => nodes.get(id) ?? nodes.set(id, node()).get(id);
  const body = node("body"); body.dataset.localView = "dashboard";
  const document = { activeElement: body, body, createElement: node, querySelector: () => node(), querySelectorAll: () => [] };
  const state = { dashboardBusy: false, dashboardGeneration: 0, dashboardFocusIdentity: null, dashboardSelectedTarget: "codex-chatgpt", dashboardSnapshot: null, dashboardStaleTimer: null, target: "xai-grok-build" };
  const page = runInNewContext(code, {
    DASHBOARD_SERVICE_DEFINITIONS: view.services.map(({ target, label }) => ({ target, label })), element, state, document, api: held.api,
    window: { addEventListener() {}, clearTimeout() {}, setTimeout() { return 1; }, scrollTo(options) { scrolls.push(options); } },
    clearLocalModelPoll() {}, resetPendingSetupState() {}, preferredScrollBehavior: () => "auto", syncDashboardNavigation() {},
    normalizeDashboardSnapshot: (value) => value, showDashboardUsage() {},
    showError(error) { failures.push(error); },
    clearMessage() {}, showSetupStage() {}, showStep() {}, async initializeLocalWizard() {}, focusVisibleSetupHeading() {},
    assistantModeLabel: () => "Disabled", copyText: async () => {}, dashboardBoundary: () => "Verified", dashboardComponentSummary: () => "n8n", dashboardServiceDescription: () => "Verified service", dashboardStateLabel: (value) => value, dashboardStateNode: () => node("span"), dashboardStatusDot: () => node("span"), flashCopied() {}, localTime: () => node("time"), renderDashboardAction: () => null, renderDashboardCompactService: () => node("li"), renderDashboardSectionStatus: () => node("li"), renderDashboardServiceRow: () => node("li"),
  });
  return { page, held, element, state, document, view, scrolls, failures };
}

test("Refresh starts one discard and one inventory check however often it is pressed, and an older check never replaces a newer one", async () => {
  const { page, held, element, state, document, view, scrolls, failures } = dashboardPage(await source());
  const paths = (from) => held.calls.slice(from).map(({ path }) => path);
  const press = (id) => element(id).listeners.click();
  const [first, older, newest] = [{ ...view }, { ...view }, { ...view }];

  // Entry discards pending setup work before it checks, then shows the top of the page with focus on its title.
  page.initialize();
  assert.deepEqual(paths(0), ["/api/local/discard"]);
  await held.answer(0, { discarded: true });
  assert.deepEqual(paths(0), ["/api/local/discard", "/api/local/dashboard"]);
  assert.equal(scrolls.length, 1);
  assert.equal(document.activeElement, element("dashboard-title"));
  await held.answer(1, first);
  assert.equal(state.dashboardSnapshot, first);

  // Two presses while the discard runs and two while the inventory check runs start one of each.
  element("dashboard-refresh").focus();
  press("dashboard-refresh"); press("dashboard-refresh");
  assert.deepEqual(paths(2), ["/api/local/discard"], "a press during the discard starts nothing");
  await held.answer(2, { discarded: true });
  assert.deepEqual(paths(2), ["/api/local/discard", "/api/local/dashboard"]);
  press("dashboard-refresh"); press("dashboard-refresh"); await held.settle();
  assert.deepEqual(paths(2), ["/api/local/discard", "/api/local/dashboard"], "a press during the inventory check starts nothing");
  assert.equal(scrolls.length, 1, "Refresh keeps the scroll position");
  assert.equal(document.activeElement, element("dashboard-refresh"), "Refresh keeps focus on itself");

  // Setup opens and closes while that check runs, so a newer check starts beside it.
  press("dashboard-new-setup"); await held.settle();
  press("setup-back-to-dashboard");
  await held.answer(4, { discarded: true });
  assert.deepEqual(paths(3), ["/api/local/dashboard", "/api/local/discard", "/api/local/dashboard"]);
  await held.answer(5, newest);
  await held.answer(3, older);
  assert.equal(state.dashboardSnapshot, newest, "the older answer arrives last and is dropped");
  assert.equal(element("dashboard-error").hidden, true, "no check failed");

  // Once the newest check is shown, Refresh works again.
  press("dashboard-refresh");
  assert.deepEqual(paths(6), ["/api/local/discard"]);
  assert.deepEqual(failures, []);
});

test("a dashboard answer that arrives after setup opened leaves the Claude notice in place", async () => {
  const { page, held, element, state, view } = dashboardPage(await source());
  const loading = page.loadLocalDashboard();
  await page.enterSetupView();
  // The person picks the Claude card, whose setup screens carry the one Anthropic notice.
  page.renderFooterForTarget("n8n-claude-oauth");
  assert.equal(element("local-footer-claude").hidden, false);
  await held.answer(0, view);
  await loading;
  assert.equal(element("local-footer-claude").hidden, false, "the late answer does not swap the notice for the dashboard selection's");
  assert.equal(element("local-footer-provider").hidden, true);
  assert.equal(state.dashboardSnapshot, null, "the late answer is not rendered");
});

test("Refresh shows its check while the discard runs, and a failed discard ends it on the last verified inventory", async () => {
  const { page, held, element, state, document, view } = dashboardPage(await source());
  const press = (id) => element(id).listeners.click();
  const shown = () => [element("dashboard-refresh").getAttribute("aria-busy"), element("dashboard-inventory-freshness").textContent, state.dashboardBusy];
  const current = () => ({ ...view, generatedAt: new Date().toISOString() });
  page.initialize();
  await held.answer(0, { discarded: true });
  await held.answer(1, current());
  assert.deepEqual(shown(), ["false", "Current", false]);

  // While a slow discard runs, Refresh is busy and the inventory no longer reads as current.
  press("dashboard-refresh");
  assert.deepEqual(shown(), ["true", "Checking", true]);
  // The discard fails: the check ends on the last verified inventory, marked stale, and the error takes focus.
  await held.fail(2, new Error("The local Relmio wizard is not reachable."));
  assert.deepEqual(shown(), ["false", "Refresh needed", false]);
  assert.equal(element("dashboard-error").hidden, false);
  assert.equal(document.activeElement, element("dashboard-error"));
  // Refresh works again, and its check puts the error away.
  press("dashboard-refresh");
  assert.equal(element("dashboard-error").hidden, true);
  await held.answer(3, { discarded: true });
  await held.answer(4, current());
  assert.deepEqual(shown(), ["false", "Current", false]);
});

test("a discard that fails from setup, or after setup replaced the refresh, leaves the dashboard as it was", async () => {
  const { page, held, element, state, document, view, failures } = dashboardPage(await source());
  const press = (id) => element(id).listeners.click();
  const current = () => ({ ...view, generatedAt: new Date().toISOString() });
  const refused = new Error("The local Relmio wizard is not reachable.");
  page.initialize();
  await held.answer(0, { discarded: true });
  await held.answer(1, current());

  // Back to dashboard fails: the person stays on setup with the error, and the hidden dashboard is not left checking.
  press("dashboard-new-setup"); await held.settle();
  press("setup-back-to-dashboard");
  await held.fail(2, refused);
  assert.deepEqual(failures, [refused]);
  assert.equal(document.body.dataset.localView, "setup");
  assert.equal(state.dashboardBusy, false);
  assert.equal(element("dashboard-refresh").getAttribute("aria-busy"), "false");
  assert.equal(element("dashboard-inventory-freshness").textContent, "Current");

  // A refresh whose discard fails after setup opened leaves both views alone.
  press("setup-back-to-dashboard");
  await held.answer(3, { discarded: true });
  await held.answer(4, current());
  press("dashboard-refresh");
  press("dashboard-new-setup"); await held.settle();
  await held.fail(5, refused);
  assert.equal(failures.length, 1, "setup shows no second error");
  assert.equal(element("dashboard-error").hidden, true, "the dashboard shows no failure");
  assert.equal(document.body.dataset.localView, "setup");
});

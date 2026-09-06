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
const snapshot = () => ({ generatedAt: "2026-09-05T00:00:00.000Z", services: [
  { target: "codex-chatgpt", label: "Codex (ChatGPT login)", kind: "endpoint", managed: true, state: "healthy", snapshot: { target: "codex-chatgpt", endpoint: "ws://127.0.0.1:14500/", auth: { configured: true, disclosure: "rotate-only" }, canRotateCredential: true }, actions: ["sign-in-chatgpt", "sign-out-chatgpt", "rotate-local-capability"] },
  { target: "codex-chat", label: "Codex Chat adapter", kind: "endpoint", managed: false, state: "absent", snapshot: null, actions: ["setup"] },
  { target: "xai-grok-build", label: "SuperGrok", kind: "endpoint", managed: false, state: "absent", snapshot: null, actions: ["setup"] },
  { target: "local-n8n-stack", label: "n8n + ngrok", kind: "n8n-stack", managed: false, state: "absent", snapshot: null, actions: ["setup"] },
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

test("dashboard initialization enters through safe discard and refreshes metadata", async () => {
  const script = await source(); const section = between(script, "function initializeLocalDashboard", "\nfunction parseRelmioStreamEvent");
  const calls = []; const listeners = new Map();
  const initialize = runInNewContext(`${section}; initializeLocalDashboard;`, { document: { querySelectorAll: () => [] }, element: (id) => ({ addEventListener: (event, handler) => listeners.set(`${id}:${event}`, handler) }), async enterDashboardView(options) { calls.push(options ?? null); }, async refreshProjectMeta() { calls.push("meta"); }, enterSetupView() {}, renderDashboardFailure() {}, showError() {}, syncDashboardNavigation() {}, window: { addEventListener() {} } });
  initialize(); await Promise.resolve(); await Promise.resolve();
  assert.deepEqual(calls, [null, "meta"]); listeners.get("dashboard-refresh:click")(); await Promise.resolve();
  assert.deepEqual(JSON.parse(JSON.stringify(calls[2])), { preserveFocus: true, preserveScroll: true });
});

test("dashboard timer rerenders stale inventory and reduced motion selects auto scrolling", async () => {
  const script = await source(); const stale = between(script, "function isDashboardSnapshotStale", "\nfunction appendDashboardFact"); const motion = between(script, "function preferredScrollBehavior", "\nif (typeof document");
  let callback; let now = Date.parse(snapshot().generatedAt) + 1; const state = { dashboardStaleTimer: 8, dashboardSnapshot: snapshot() };
  const helpers = runInNewContext(`const DASHBOARD_STALE_AFTER_MS = 300000;${stale}\n${motion}; ({scheduleDashboardStaleExpiry, preferredScrollBehavior});`, { Date: class extends Date { static now() { return now; } }, state, document: { body: { dataset: { localView: "dashboard" } } }, window: { clearTimeout() {}, setTimeout(fn, delay) { callback = { fn, delay }; return 9; }, matchMedia: () => ({ matches: true }) }, renderDashboardSnapshot(value, options) { state.rendered = { value, options }; } });
  helpers.scheduleDashboardStaleExpiry(state.dashboardSnapshot); assert.equal(callback.delay, 300000); now += 300001; callback.fn(); assert.equal(state.rendered.options.stale, true); assert.equal(helpers.preferredScrollBehavior(), "auto");
});

test("approved endpoint facts copy safely and copy failures expose no endpoint", async () => {
  const script = await source(); const facts = between(script, "function appendDashboardFact", "\nfunction dashboardComponentSummary"); const details = between(script, "function dashboardProviderForTarget", "\nfunction renderDashboardServiceRow");
  const nodes = new Map(); const make = () => ({ children: [], dataset: {}, attributes: new Map(), append(...items) { this.children.push(...items); }, addEventListener(event, listener) { this.listener = listener; }, setAttribute(k,v) { this.attributes.set(k,v); }, focus() { this.focused = true; }, replaceChildren(...items) { this.children = items; } }); const element = (id) => nodes.get(id) ?? nodes.set(id, make()).get(id);
  let fail = false; const render = runInNewContext(`${facts}\n${details}; renderDashboardServiceDetail;`, { document: { createElement: make }, element, copyText: async () => { if (fail) throw new Error("copy denied"); }, flashCopied() {}, dashboardBoundary: () => "Verified", dashboardComponentSummary: () => "", dashboardServiceDescription: () => "", dashboardStateLabel: () => "Healthy", dashboardStatusDot: make, renderDashboardAction: () => null, state: { dashboardSnapshot: snapshot() } });
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
  const node = (tag = "div") => ({ tagName: tag, attributes: new Map(), children: [], classList: { add() {}, remove() {} }, dataset: {}, disabled: false, hidden: false, append(...items) { this.children.push(...items); this.childElementCount = this.children.length; this.lastElementChild = items.at(-1) ?? null; }, addEventListener() {}, getAttribute(name) { return this.attributes.get(name) ?? null; }, setAttribute(name, value) { this.attributes.set(name, String(value)); }, replaceChildren(...items) { this.children = items; this.childElementCount = items.length; this.lastElementChild = items.at(-1) ?? null; }, focus(options) { this.focusOptions = options; document.activeElement = this; } });
  const element = (id) => nodes.get(id) ?? nodes.set(id, node()).get(id);
  const descend = (root) => [root, ...(root.children ?? []).flatMap(descend)];
  const body = node("body"); body.dataset.localView = "dashboard";
  const document = { activeElement: body, body, createElement: node, querySelectorAll(selector) { assert.equal(selector, "[data-dashboard-service]"); return [...nodes.values()].flatMap(descend).filter((item) => item.dataset?.dashboardService); } };
  const controls = runInNewContext(`const DASHBOARD_STALE_AFTER_MS = 300000;${staleAndFocus}\n${facts}\n${details}\n${render}; renderDashboardSnapshot;`, {
    Date: class extends Date { static now() { return now; } }, DASHBOARD_SERVICE_DEFINITIONS: view.services.map(({ target, label }) => ({ target, label })), document, element,
    state: { dashboardBusy: false, dashboardFocusIdentity: null, dashboardSelectedTarget: "codex-chatgpt", dashboardSnapshot: null, dashboardStaleTimer: null },
    window: { clearTimeout() {}, setTimeout(callback, delay) { timer = { callback, delay }; return 1; } },
    assistantModeLabel: () => "Disabled", copyText: async () => {}, dashboardBoundary: () => "Verified", dashboardComponentSummary: () => "n8n", dashboardServiceDescription: () => "Verified service", dashboardStateLabel: (value) => value, dashboardStateNode: () => node("span"), dashboardStatusDot: () => node("span"), flashCopied() {}, formatDashboardTime: () => "now", renderDashboardAction: () => null, renderDashboardCompactService: () => node("li"), renderDashboardProvider: () => node("li"), renderDashboardSectionStatus: () => node("li"), renderDashboardServiceRow(service) { const item = node("li"); const select = node("button"); select.dataset.dashboardService = service.target; select.dataset.dashboardControl = "select"; item.append(select); return item; }, renderDashboardTruth() {},
  });
  const copy = () => descend(element("dashboard-service-facts")).find((item) => item.tagName === "button");
  controls(view, { stale: false }); const before = copy();
  assert.equal(before.dataset.dashboardService, "codex-chatgpt"); assert.equal(before.dataset.dashboardFact, "endpoint"); before.focus();
  assert.equal(timer.delay, 300000); now += 300001; timer.callback();
  const after = copy(); assert.notEqual(after, before); assert.equal(document.activeElement, after); assert.equal(after.focusOptions.preventScroll, true);
});

test("dashboard copy allowlist includes endpoint and n8n URLs but never credential values", async () => {
  const script = await source(); const facts = between(script, "function appendDashboardFact", "\nfunction dashboardComponentSummary"); const details = between(script, "function dashboardProviderForTarget", "\nfunction renderDashboardServiceRow");
  const nodes = new Map(); const node = (tag = "div") => ({ tagName: tag, attributes: new Map(), children: [], classList: { add() {}, remove() {} }, dataset: {}, hidden: false, append(...items) { this.children.push(...items); this.childElementCount = this.children.length; }, addEventListener(name, callback) { this.listener = callback; }, setAttribute(name, value) { this.attributes.set(name, String(value)); }, replaceChildren(...items) { this.children = items; this.childElementCount = items.length; }, focus() { this.focused = true; } }); const element = (id) => nodes.get(id) ?? nodes.set(id, node()).get(id);
  const detail = runInNewContext(`${facts}\n${details}; renderDashboardServiceDetail;`, { document: { createElement: node }, element, state: { dashboardSnapshot: snapshot() }, assistantModeLabel: () => "Disabled", copyText: async () => {}, flashCopied() {}, dashboardBoundary: () => "Verified", dashboardComponentSummary: () => "n8n, ngrok", dashboardServiceDescription: () => "Verified", dashboardStateLabel: (value) => value, dashboardStatusDot: () => node("span"), renderDashboardAction: () => null });
  const buttons = () => element("dashboard-service-facts").children.flatMap((row) => row.children.flatMap((child) => child.children?.filter((item) => item.tagName === "button") ?? []));
  detail(snapshot().services[0]); assert.deepEqual(buttons().map((button) => button.attributes.get("aria-label")), ["Copy Codex (ChatGPT login) endpoint"]);
  detail({ target: "local-n8n-stack", label: "n8n + ngrok", kind: "n8n-stack", managed: true, state: "healthy", actions: [], snapshot: { endpoints: { n8nLocal: "http://127.0.0.1:5678/", ngrokPublic: "https://workflow.example.invalid/", ngrokInspector: "http://127.0.0.1:4040/" }, components: { n8n: true, ngrok: true }, assistantMode: "disabled" } });
  assert.deepEqual(buttons().map((button) => button.attributes.get("aria-label")), ["Copy local n8n URL", "Copy public n8n URL", "Copy ngrok inspector URL"]);
  detail({ target: "local-n8n-assistant", label: "AI Assistant tools", kind: "n8n-assistant", managed: true, state: "healthy", actions: [], snapshot: { components: { codeSandbox: true } } });
  assert.equal(buttons().length, 0);
});

test("returning to dashboard discards pending setup reviews and one-time values", async () => {
  const script = await source(); const transition = between(script, "function clearOneTimeSetupValues", "\nfunction syncDashboardNavigation"); const nodes = new Map();
  const element = (id) => nodes.get(id) ?? nodes.set(id, { id, checked: true, disabled: false, hidden: false, textContent: `pending-${id}`, value: `pending-${id}`, removeAttribute(name) { if (name === "href") this.href = ""; }, focus() {} }).get(id);
  const state = { assistantSearxngReview: { reviewId: "pending" }, assistantSearxngReviewId: "pending", dashboardFocusIdentity: { service: "codex-chatgpt" }, installedTarget: "local-n8n-assistant", plan: { target: "local-n8n-assistant" }, planId: "pending" }; const calls = [];
  const enter = runInNewContext(`${transition}; enterDashboardView;`, { state, element, document: { body: { dataset: {} } }, window: { scrollTo(options) { calls.push(options); } }, async api(path, options) { calls.push([path, options]); return { discarded: true }; }, clearChatTesterState() { calls.push("chat-cleared"); }, clearDashboardStaleTimer() {}, invalidatePlan() { state.plan = null; state.planId = null; }, preferredScrollBehavior: () => "auto", async loadLocalDashboard() { calls.push("inventory"); }, scheduleDashboardStaleExpiry() {} });
  await enter(); assert.deepEqual(JSON.parse(JSON.stringify(calls[0])), ["/api/local/discard", { method: "POST", body: {} }]); assert.equal(state.plan, null); assert.equal(state.planId, null); assert.equal(state.installedTarget, null); assert.equal(state.assistantSearxngReview, null); assert.equal(state.assistantSearxngReviewId, null); assert.equal(state.dashboardFocusIdentity, null); assert.equal(element("result-credential").textContent, ""); assert.equal(element("ngrok-authtoken").value, ""); assert.equal(element("install-result-list").hidden, true); assert.equal(element("n8n-oauth-link").href, ""); assert.equal(calls.at(-1), "inventory");
});

test("dashboard direct hashes and browser history retain one current navigation link", async () => {
  const script = await source(); const navigation = between(script, "function syncDashboardNavigation", "\nfunction initializeLocalDashboard"); const init = between(script, "function initializeLocalDashboard", "\nfunction parseRelmioStreamEvent");
  const links = ["#dashboard-overview", "#dashboard-connections", "#dashboard-n8n", "#dashboard-credentials", "#dashboard-activity"].map((href) => ({ attributes: new Map([["href", href]]), getAttribute(name) { return this.attributes.get(name) ?? null; }, setAttribute(name, value) { this.attributes.set(name, String(value)); }, removeAttribute(name) { this.attributes.delete(name); }, addEventListener(name, callback) { this.listener = callback; } }));
  const listeners = new Map(); const window = { location: { hash: "#dashboard-n8n" }, addEventListener(name, callback) { listeners.set(name, callback); } }; const sync = runInNewContext(`${navigation}; syncDashboardNavigation;`, { document: { querySelectorAll: () => links }, window });
  sync(); assert.equal(links[2].attributes.get("aria-current"), "location"); window.location.hash = "#dashboard-activity"; sync(); assert.equal(links[4].attributes.get("aria-current"), "location"); window.location.hash = "#unknown"; sync(); assert.equal(links[0].attributes.get("aria-current"), "location");
  const initialize = runInNewContext(`${init}; initializeLocalDashboard;`, { document: { querySelectorAll: () => links }, element: () => ({ addEventListener() {} }), window, syncDashboardNavigation: sync, async enterDashboardView() {}, async refreshProjectMeta() {}, enterSetupView() {}, renderDashboardFailure() {}, showError() {} });
  initialize(); window.location.hash = "#dashboard-connections"; listeners.get("hashchange")(); assert.equal(links[1].attributes.get("aria-current"), "location"); assert.equal(links.filter((link) => link.attributes.has("aria-current")).length, 1);
});

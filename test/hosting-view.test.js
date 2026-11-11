import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { HOSTING_PROVIDERS } from "../src/domain/hosting-providers.js";
import { validateUsername } from "../src/domain/validation.js";
import { wizardApiError } from "../src/ui/session.js";

const ROOT_ONLY = ["openai", "assistant", "searxng", "supergrok", "claude"];
const vmProviders = HOSTING_PROVIDERS.filter(provider => provider.kind === "managed-vm");
const rootOff = vmProviders.filter(provider => provider.rootLogin !== "default");

test("Back from Details keeps Choose focused when a pending plan completes", async () => {
  const script = await readFile("src/ui/hosting.js", "utf8");
  const views = script.slice(script.indexOf("const VIEW_HEADINGS"), script.indexOf("\nfunction node(", script.indexOf("const VIEW_HEADINGS")));
  const invalidation = script.slice(script.indexOf("function clearError()"), script.indexOf("\nfunction activeProvider(", script.indexOf("function clearError()")));
  const handlers = script.slice(script.indexOf('el("hosting-provider").addEventListener'), script.indexOf("\nasync function loadCatalog()", script.indexOf('el("hosting-provider").addEventListener')));
  const nodes = new Map();
  let activeElement;
  const el = id => {
    if (!nodes.has(id)) nodes.set(id, {
      id, value: "", disabled: false, hidden: false, handlers: new Map(),
      addEventListener(name, handler) { this.handlers.set(name, handler); },
      replaceChildren() {}, reportValidity() { return true; },
      focus() { activeElement = this; },
      getBoundingClientRect() { return { top: 100, bottom: 130 }; },
      closest() { return null; }, scrollIntoView() {},
    });
    return nodes.get(id);
  };
  const state = { generation: 0, plan: null, archive: null, requestPending: false };
  const document = {
    body: { dataset: { hostingView: "details" } },
    querySelector() { return { getBoundingClientRect() { return { bottom: 56 }; } }; },
  };
  let resolveRequest;
  runInNewContext(`${views}\n${invalidation}\n${handlers}`, {
    el, document, state, token: "fixture-token", innerHeight: 800,
    activeProfile() { return { providerId: "fixture", component: "model" }; },
    planInputs() { return { diskGB: 20 }; },
    randomDeploymentId() { return "fixture-deployment"; },
    fetch() { return new Promise(resolve => { resolveRequest = resolve; }); },
    renderPlan() { document.body.dataset.hostingView = "review"; el("review-title").focus(); },
    renderProvider() {}, renderComponent() {}, downloadBundle() {}, error() {},
  });
  el("hosting-model").value = "qwen3:0.6b";
  const pending = el("hosting-form").handlers.get("submit")({ preventDefault() {} });
  assert.equal(state.requestPending, true);
  el("hosting-details-back").handlers.get("click")();
  assert.equal(document.body.dataset.hostingView, "choose");
  assert.equal(activeElement, el("matrix-title"));
  resolveRequest({ ok: true, json: async () => ({ providerId: "fixture", component: "model" }) });
  await pending;
  assert.equal(document.body.dataset.hostingView, "choose");
  assert.equal(activeElement, el("matrix-title"));
  assert.equal(state.plan, null);
});

test("the catalog records each Linux VM's documented sign-in as guidance only", () => {
  assert.deepEqual(rootOff.map(provider => provider.id).sort(), ["aws", "azure-vm", "gce", "generic", "lightsail", "oci", "ovh"]);
  for (const provider of vmProviders) {
    assert.ok(["default", "off-by-default", "operator-chosen"].includes(provider.rootLogin), provider.id);
    assert.ok(Array.isArray(provider.defaultUsers) && Object.isFrozen(provider.defaultUsers), provider.id);
    for (const user of provider.defaultUsers) assert.equal(validateUsername(user), user);
    assert.equal(provider.defaultUsers.includes("root"), provider.rootLogin === "default", provider.id);
    assert.match(provider.reviewedOn, /^\d{4}-\d{2}-\d{2}$/u);
  }
  for (const provider of HOSTING_PROVIDERS.filter(item => item.kind !== "managed-vm")) {
    assert.equal(Object.hasOwn(provider, "rootLogin") || Object.hasOwn(provider, "defaultUsers"), false, provider.id);
  }
  // Providers that sign in by key only say how to load the key; password-first providers do not.
  const mentionsKeyLoading = id => HOSTING_PROVIDERS.find(provider => provider.id === id).sshHint.includes("ssh-add <key file>");
  for (const id of ["aws", "lightsail", "oci", "gce"]) assert.equal(mentionsKeyLoading(id), true, id);
  for (const id of ["hostinger", "contabo", "ovh"]) assert.equal(mentionsKeyLoading(id), false, id);
});

test("root-only components show a root sign-in note beside the Managed badge where root is not the default", async () => {
  const script = await readFile("src/ui/hosting.js", "utf8");
  const from = (start, end) => script.slice(script.indexOf(start), script.indexOf(end, script.indexOf(start)));
  const nodes = new Map();
  const stub = id => ({
    id, value: "", hidden: false, disabled: false, open: false, textContent: "", children: [],
    replaceChildren(...children) { this.children = children; },
    cloneNode() { return stub(id); }, replaceWith(next) { nodes.set(id, next); },
  });
  const el = id => {
    if (!nodes.has(id)) nodes.set(id, stub(id));
    return nodes.get(id);
  };
  const context = {
    el, provider: null, token: "fixture-token", state: { models: [] },
    node: (tag, text, className) => ({ tag, text, className }),
    invalidate() {}, activeProfile() { return null; }, bindWizardNavigation() {}, renderField() {}, option() {},
  };
  runInNewContext(`${from("const MANAGED_ROUTES", "const KIND_LABELS")}
    ${from("const MODE_LABELS", "const FILE_NAME")}
    function activeProvider() { return provider; }
    ${from("function modeOf(", "// Compact cell")}
    ${from("function renderComponent()", "\nfunction renderField(")}
    globalThis.render = renderComponent; globalThis.note = rootSignInNote;`, context);
  const shown = (provider, component) => {
    context.provider = provider;
    el("hosting-component").value = component;
    context.render();
    return el("hosting-capability").children.filter(child => typeof child === "object");
  };

  for (const provider of rootOff) {
    for (const component of ROOT_ONLY) {
      const [badge, note, capability, ...rest] = shown(provider, component);
      assert.equal(badge.text, "Managed", `${provider.id} ${component}`);
      assert.equal(note.text, context.note(provider, component));
      assert.match(note.text, /root sign-in/iu);
      // It shares the first line with the badge; a longer note wraps and step 1 scrolls at 1280 x 720.
      assert.ok(note.text.length <= 30, `${provider.id} ${component}: ${note.text.length} characters`);
      // sudo does not unlock these components, so the note must not hint that it does.
      assert.doesNotMatch(note.text, /sudo/iu);
      assert.equal(capability.text, provider.components[component].note);
      assert.deepEqual(rest, []);
    }
    // The model accepts a sudo session, so it carries no root note.
    assert.deepEqual(shown(provider, "model").map(child => child.text), ["Managed", provider.components.model.note]);
  }
  for (const provider of HOSTING_PROVIDERS.filter(item => !rootOff.includes(item))) {
    for (const component of Object.keys(provider.components)) {
      assert.equal(context.note(provider, component), null, `${provider.id} ${component}`);
      assert.equal(shown(provider, component).length, 2, `${provider.id} ${component}`);
    }
  }
});

test("choosing a provider on the server model page never changes the login, authentication or privilege", async t => {
  const previous = { document: globalThis.document, window: globalThis.window, fetch: globalThis.fetch, MutationObserver: globalThis.MutationObserver };
  t.after(() => { for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; } });
  const nodes = new Map();
  const element = id => {
    if (!nodes.has(id)) nodes.set(id, {
      value: "", checked: false, disabled: false, hidden: true, textContent: "", handlers: new Map(), attributes: new Map(),
      addEventListener(event, callback) { this.handlers.set(event, [...(this.handlers.get(event) ?? []), callback]); },
      dispatch(event) { for (const callback of this.handlers.get(event) ?? []) callback({ currentTarget: this, preventDefault() {} }); },
      setAttribute(name, value) { this.attributes.set(name, value); }, getAttribute(name) { return this.attributes.get(name) ?? null; },
      removeAttribute(name) { this.attributes.delete(name); },
      checkValidity() { return Boolean(this.value); }, focus() {},
      replaceChildren(...children) { this.children = children; if (!children.some(child => child.value === this.value)) this.value = children[0]?.value ?? ""; },
    });
    return nodes.get(id);
  };
  globalThis.document = { body: { dataset: {} }, getElementById: element, querySelectorAll: () => [], addEventListener() {}, createElement: () => ({}) };
  globalThis.window = { history: { state: { relmioWizardSession: "a".repeat(43) }, replaceState() {} }, location: { pathname: "/local-model-vps", hash: "", reload() {} }, addEventListener() {} };
  globalThis.MutationObserver = class { observe() {} };
  globalThis.fetch = async path => ({
    ok: path === "/api/ssh/connection" || path === "/api/ssh/capabilities",
    json: async () => (path === "/api/ssh/connection" ? { connected: false } : { agent: { status: "configured" } }),
  });
  await import("../src/ui/local-model-vps.js");
  await new Promise(resolve => setImmediate(resolve));

  const chosen = { host: "my-server.example", port: "2222", username: "custom-admin", "ssh-authentication": "password", "ssh-privilege": "root" };
  for (const [id, value] of Object.entries(chosen)) element(id).value = value;
  for (const provider of vmProviders) {
    element("hosting-provider").value = provider.id;
    element("hosting-provider").dispatch("change");
    assert.equal(element("hosting-hint").textContent, provider.sshHint, provider.id);
    for (const [id, value] of Object.entries(chosen)) assert.equal(element(id).value, value, `${provider.id}: ${id}`);
  }
});

test("hosting plan failures keep server codes and safety flags for guide help", async () => {
  const script = await readFile("src/ui/hosting.js", "utf8");
  const errorSource = script.slice(script.indexOf("function error("), script.indexOf("\nfunction clearError("));
  const handlers = script.slice(script.indexOf('el("hosting-provider").addEventListener'), script.indexOf("\nasync function loadCatalog()"));
  const nodes = new Map();
  const el = id => {
    if (!nodes.has(id)) nodes.set(id, {
      value: "", handlers: new Map(), textContent: "", hidden: true,
      addEventListener(event, handler) { this.handlers.set(event, handler); },
      reportValidity() { return true; }, focus() {},
    });
    return nodes.get(id);
  };
  const serverFailure = { error: "Review this destination again.", code: "review_required", param: "providerId",
    remoteOutcomeUnknown: true, retryBlocked: true, recovery: "reauthorize" };
  let guideError;
  runInNewContext(`${errorSource}\n${handlers}`, {
    el, token: "fixture-token", state: { generation: 0, requestPending: false },
    wizardApiError, relmioGuide: { error(failure) { guideError = failure; } },
    activeProfile() { return { providerId: "fixture", component: "model" }; },
    planInputs() { return {}; }, randomDeploymentId() { return "fixture"; },
    fetch: async () => ({ ok: false, status: 403, json: async () => serverFailure }),
    invalidate() {}, renderProvider() {}, renderComponent() {}, downloadBundle() {}, showView() {},
    renderPlan() { assert.fail("A failed request must not render a plan."); },
  });
  await el("hosting-form").handlers.get("submit")({ preventDefault() {} });
  assert.equal(el("hosting-error").textContent, serverFailure.error);
  assert.equal(el("hosting-error").hidden, false);
  assert.deepEqual(
    [guideError.code, guideError.status, guideError.param, guideError.remoteOutcomeUnknown, guideError.retryBlocked],
    ["review_required", 403, "providerId", true, true],
  );
  assert.equal(Object.hasOwn(guideError, "recovery"), false);
});

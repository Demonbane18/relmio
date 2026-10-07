import assert from "node:assert/strict";
import test from "node:test";
import { accountUiState, createSiwcControls, createSiwcRecovery, normalizeSiwcAccount, siwcErrorFromResponse } from "../src/ui/siwc-controls.js";
import { siwcAccount } from "./helpers/siwc-wizard.js";

class Element {
  constructor(tag) { this.tag = tag; this.children = []; this.listeners = new Map(); this.attributes = {}; this.textContent = ""; }
  append(...children) { this.children.push(...children); }
  replaceChildren(...children) { this.children = children; }
  setAttribute(key, value) { this.attributes[key] = value; }
  addEventListener(type, listener) { this.listeners.set(type, listener); }
  focus() { this.focused = true; }
  get value() { return this.selectedValue ?? this.children[0]?.value ?? ""; }
  set value(value) { this.selectedValue = value; }
  get options() { return this.children; }
  get selectedIndex() { return Math.max(0, this.children.findIndex((item) => item.value === this.value)); }
  async fire(type) { await this.listeners.get(type)?.(); await new Promise(setImmediate); }
}

function recoveryHarness(t, api, options = {}) {
  const previous = globalThis.document;
  globalThis.document = { createElement: (tag) => new Element(tag) };
  t.after(() => { if (previous === undefined) delete globalThis.document; else globalThis.document = previous; });
  const root = new Element("div");
  const errors = [];
  const results = [];
  const reviews = [];
  const recovery = createSiwcRecovery({ root, api, onError: (error) => errors.push(error),
    onReview: (result) => reviews.push(result), onResult: (result) => results.push(result), ...options });
  const body = root.children[0].children[1];
  return { recovery, errors, results, reviews, account: body.children[0].children[0],
    status: body.children[2], check: body.children[3], resume: body.children[4],
    confirmation: body.children[5].children[0], apply: body.children[6] };
}

test("account states distinguish identity, permission, ownership and credential expiry", () => {
  assert.equal(accountUiState(siwcAccount), "plan-active");
  assert.equal(accountUiState({ ...siwcAccount, planPermission: "not-granted" }), "identity-only");
  assert.equal(accountUiState({ ...siwcAccount, session: "reauthorize" }), "reauthorize");
  assert.equal(accountUiState({ ...siwcAccount, ownership: "handoff-pending", session: "signed-out" }), "handoff-pending");
  assert.equal(accountUiState({ ...siwcAccount, ownership: "transferred" }), "transferred");
  assert.equal(normalizeSiwcAccount({ ...siwcAccount, accessToken: "must-not-leak" }).accessToken, undefined);
  assert.throws(() => normalizeSiwcAccount({ ...siwcAccount, generation: "../outside" }));
  assert.equal(siwcErrorFromResponse({ error: "Usage paused", recovery: "manage-usage" }, 429).recovery, "manage-usage");
});

test("recovery UI requires reviewed account and checkbox, consumes confirmation and announces exact result", async (t) => {
  const calls = [];
  const account = { ...siwcAccount, ownership: "handoff-pending" };
  const harness = recoveryHarness(t, async (path, options) => {
    calls.push({ path, options });
    if (path === "/api/siwc/accounts") return { accounts: [account] };
    if (path.endsWith("/review")) return { reviewId: "review_fixture_1", account };
    return { outcome: "not-accepted", account };
  });
  await harness.recovery.load();
  assert.equal(harness.apply.disabled, true);
  await harness.check.fire("click");
  assert.equal(calls.length, 2);
  assert.equal(harness.apply.disabled, true);
  assert.equal(harness.confirmation.focused, true);
  harness.confirmation.checked = true;
  await harness.confirmation.fire("change");
  assert.equal(harness.apply.disabled, false);
  await harness.apply.fire("click");
  assert.deepEqual(calls[2].options.body, { reviewId: "review_fixture_1", confirmed: true });
  assert.equal(harness.results[0].outcome, "not-accepted");
  assert.equal(harness.apply.hidden, true);
  assert.equal(harness.status.focused, true);
  assert.equal(harness.status.attributes.role, "status");
  assert.equal(harness.status.attributes["aria-live"], "polite");
  assert.equal(harness.errors.length, 0);
  await harness.apply.fire("click");
  assert.equal(calls.length, 3);
});

test("resume UI hands reviewed plan to final install confirmation without executing recovery", async (t) => {
  const calls = [];
  const plan = { planId: "plan_fixture_1", plan: { resumeRequired: true } };
  const harness = recoveryHarness(t, async (path) => {
    calls.push(path);
    return path === "/api/siwc/accounts" ? { accounts: [siwcAccount] } : plan;
  });
  await harness.recovery.load();
  await harness.resume.fire("click");
  assert.deepEqual(harness.reviews, [plan]);
  assert.equal(calls.length, 2);
  assert.equal(harness.apply.hidden, true);
});

test("sanitized recovery fixtures disable writes while retaining status and labels", async (t) => {
  let calls = 0;
  const harness = recoveryHarness(t, async () => { calls++; return {
    accounts: [siwcAccount], previewMode: true, previewFixture: "staged",
  }; });
  await harness.recovery.load();
  assert.equal(harness.check.disabled, true);
  assert.equal(harness.resume.disabled, true);
  await harness.check.fire("click");
  assert.equal(calls, 1);
  assert.ok(harness.status.textContent.length > 0);
});

test("refreshing recovery accounts invalidates an earlier confirmation", async (t) => {
  const account = { ...siwcAccount, ownership: "handoff-pending" };
  const harness = recoveryHarness(t, async (path) => path === "/api/siwc/accounts"
    ? { accounts: [account] } : { reviewId: "review_fixture_1", account });
  await harness.recovery.load();
  await harness.check.fire("click");
  harness.confirmation.checked = true;
  await harness.confirmation.fire("change");
  assert.equal(harness.apply.disabled, false);
  await harness.recovery.load();
  assert.equal(harness.apply.hidden, true);
  assert.equal(harness.apply.disabled, true);
});

test("n8n recovery forwards selected immutable IDs only for a fresh resume review", async (t) => {
  const account = { ...siwcAccount, ownership: "handoff-pending" };
  const calls = [];
  const ids = { n8nContainerId: "c".repeat(64), dockerNetworkId: "b".repeat(64) };
  const harness = recoveryHarness(t, async (path, options) => {
    if (path === "/api/siwc/accounts") return { accounts: [account] };
    calls.push({ path, options });
    return options.body.action === "resume"
      ? { planId: "resume_plan_1", plan: { resumeRequired: true } }
      : { reviewId: "reconcile_review_1", account };
  }, {
    getTarget: ({ target, action }) => target === "n8n-openai-oauth" && action === "resume" ? ids : {},
  });
  await harness.recovery.load({ target: "n8n-openai-oauth" });
  await harness.resume.fire("click");
  assert.deepEqual(calls[0].options.body, {
    target: "n8n-openai-oauth", registrationId: account.registrationId, action: "resume", ...ids,
  });
  await harness.check.fire("click");
  assert.deepEqual(calls[1].options.body, {
    target: "n8n-openai-oauth", registrationId: account.registrationId, action: "reconcile",
  });
});

test("recovery account labels use plain ownership words, not internal state names", async (t) => {
  const harness = recoveryHarness(t, async () => ({ accounts: [siwcAccount,
    { ...siwcAccount, registrationId: "fixture_registration_2", ownership: "handoff-pending" },
    { ...siwcAccount, registrationId: "fixture_registration_3", ownership: "transferred" }] }));
  await harness.recovery.load();
  assert.equal(harness.account.children.length, 3);
  for (const option of harness.account.children) {
    assert.doesNotMatch(option.textContent, /\((owned|handoff-pending)\)/u);
  }
});

const browserGlobals = { document: globalThis.document, Option: globalThis.Option, MutationObserver: globalThis.MutationObserver };

function controlsHarness(t, { visible = true, previewMode = false, previewFixture = null, accounts = [siwcAccount] } = {}) {
  const observers = [];
  const doc = { body: { dataset: {} }, activeElement: null, createElement: (tag) => new Element(tag) };
  globalThis.document = doc;
  globalThis.Option = class { constructor(textContent, value) { Object.assign(this, { textContent, value, disabled: false }); } };
  globalThis.MutationObserver = class { constructor(callback) { observers.push(callback); } observe() {} };
  t.after(() => {
    for (const [key, value] of Object.entries(browserGlobals)) {
      if (value === undefined) delete globalThis[key]; else globalThis[key] = value;
    }
  });
  const nodes = new Map();
  const control = () => ({
    hidden: false, disabled: false, open: false, textContent: "", className: "", value: "", children: [], listeners: new Map(),
    add(child) { this.children.push(child); },
    replaceChildren(...children) { this.children = children; },
    addEventListener(type, listener) { this.listeners.set(type, listener); },
    focus() { doc.activeElement = this; },
    checkVisibility() { return visible && !this.hidden; },
    showModal() { this.open = true; },
    close() { this.open = false; this.listeners.get("close")?.(); },
    async fire(type) { await this.listeners.get(type)?.({ currentTarget: this }); await new Promise(setImmediate); },
  });
  const field = (name) => {
    if (!nodes.has(name)) nodes.set(name, control());
    return nodes.get(name);
  };
  const root = {
    querySelector: (selector) => field(/data-siwc="([^"]+)"/u.exec(selector)[1]),
    contains: (node) => [...nodes.values()].includes(node),
    checkVisibility: () => visible,
  };
  const calls = [];
  let current = accounts;
  const api = async (path, options = {}) => {
    calls.push({ path, body: options.body });
    if (path === "/api/siwc/accounts") {
      return { accounts: current, pendingRegistrations: [], selectedRegistrationId: current[0]?.registrationId,
        previewMode, previewFixture };
    }
    if (path === "/api/siwc/logout") {
      current = [{ ...current[0], session: "signed-out", generation: "fixture_generation_logout" }];
      return { revocation: "unconfirmed" };
    }
    if (path === "/api/siwc/ack") current = [{ ...current[0], needsPlanWelcome: false, generation: "fixture_generation_ack" }];
    return {};
  };
  const controls = createSiwcControls({ root, api, onChange() {}, onLogin() {}, onError(error) { throw error; } });
  return {
    controls, field, calls, doc,
    show() { visible = true; },
    releaseOperationLock() { doc.body.dataset.operationBusy = "false"; for (const callback of observers) callback(); },
  };
}

test("plan welcome waits for a visible view and an unlocked page, and Escape keeps it reopenable", async (t) => {
  const harness = controlsHarness(t, { visible: false, accounts: [{ ...siwcAccount, needsPlanWelcome: true }] });
  const dialog = harness.field("welcome");
  await harness.controls.load();
  assert.equal(dialog.open, false, "a hidden view never opens an invisible modal");
  assert.equal(harness.field("plan-badge").hidden, true, "an unconfirmed plan is not shown as in use");

  harness.show();
  harness.doc.body.dataset.operationBusy = "true";
  harness.controls.showWelcome();
  assert.equal(dialog.open, false, "an operation lock would disable the dialog's buttons");
  harness.releaseOperationLock();
  assert.equal(dialog.open, true);
  assert.equal(harness.doc.activeElement, harness.field("welcome-accept"));

  dialog.close();
  assert.equal(harness.calls.some(({ path }) => path === "/api/siwc/ack"), false, "Escape is not an acknowledgment");
  assert.equal(harness.field("welcome-open").hidden, false);
  assert.equal(harness.doc.activeElement, harness.field("state"));

  const reopen = harness.field("welcome-open");
  await reopen.fire("click");
  assert.equal(dialog.open, true);
  dialog.close();
  assert.equal(harness.doc.activeElement, reopen, "focus returns to the control that opened the notice");

  await reopen.fire("click");
  await harness.field("welcome-accept").fire("click");
  assert.equal(harness.calls.filter(({ path }) => path === "/api/siwc/ack").length, 1);
  assert.equal(dialog.open, false);
  assert.equal(harness.field("welcome-open").hidden, true);
  assert.equal(harness.field("plan-badge").hidden, false);
});

test("account controls are drawn again after an operation lock restores older control states", async (t) => {
  const preview = controlsHarness(t, { previewMode: true });
  await preview.controls.load();
  for (const name of ["account", "new", "pause", "logout"]) assert.equal(preview.field(name).disabled, true);
  for (const name of ["account", "new", "pause", "logout"]) preview.field(name).disabled = false;
  preview.releaseOperationLock();
  for (const name of ["account", "new", "pause", "logout"]) assert.equal(preview.field(name).disabled, true, name);

  const empty = controlsHarness(t, { accounts: [] });
  await empty.controls.load();
  empty.field("account").disabled = false;
  empty.releaseOperationLock();
  assert.equal(empty.field("account").disabled, true, "an empty account picker stays disabled");
});

test("a usage limit pauses plan controls and keeps Manage usage as the recovery", async (t) => {
  const limited = controlsHarness(t, { previewMode: true, previewFixture: "usage-limit" });
  await limited.controls.load();
  assert.equal(limited.controls.isUsageLimited(), true);
  assert.equal(limited.field("plan-badge").hidden, true);
  assert.equal(limited.field("pause").hidden, true);
  assert.equal(limited.field("usage").hidden, false);

  const connected = controlsHarness(t, { previewMode: true, previewFixture: "connected" });
  await connected.controls.load();
  assert.equal(connected.controls.isUsageLimited(), false);
  assert.equal(connected.field("plan-badge").hidden, false);
  assert.equal(connected.field("pause").hidden, false);
});

test("signing out moves focus to the account state once the button hides itself", async (t) => {
  const harness = controlsHarness(t);
  await harness.controls.load();
  const logout = harness.field("logout");
  logout.focus();
  await logout.fire("click");
  assert.equal(logout.hidden, true);
  assert.equal(harness.doc.activeElement, harness.field("state"));
  assert.equal(accountUiState(harness.controls.selected()), "signed-out");
  assert.ok(harness.field("status").textContent.length > 0);
});

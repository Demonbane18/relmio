import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { siwcInstallResult } from "./helpers/siwc-wizard.js";
import { accountUiState, normalizeSiwcAccount } from "../src/ui/siwc-controls.js";

const VERIFICATION_URL = "https://auth.openai.com/codex/device";
const owner = { registrationId: "fixture_registration_1", label: "Test ChatGPT account", session: "connected",
  planEnabled: true, planPermission: "granted", ownership: "owned" };

function slice(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `missing ${start}`);
  return source.slice(from, to);
}

async function harness(apiResult, { install = false } = {}) {
  const source = await readFile(new URL("../src/ui/local.js", import.meta.url), "utf8");
  const nodes = new Map();
  const events = [];
  const element = (id) => {
    if (!nodes.has(id)) {
      const handlers = {};
      nodes.set(id, {
        id, handlers, hidden: false, disabled: false, checked: false, open: false, textContent: "", value: "", attributes: new Map(),
        get href() { return this.attributes.get("href") ?? ""; },
        set href(value) { this.attributes.set("href", value); },
        set innerHTML(_value) { throw new Error("untrusted text must use textContent"); },
        removeAttribute(name) { this.attributes.delete(name); },
        addEventListener(type, handler) { handlers[type] = handler; },
        setCustomValidity() {},
        focus() { events.push(`focus:${id}`); },
      });
    }
    return nodes.get(id);
  };
  const timers = [];
  const window = {
    setTimeout(callback, delay) { timers.push({ callback, delay, cleared: false }); return timers.length; },
    clearTimeout(handle) { if (timers[handle - 1]) timers[handle - 1].cleared = true; },
  };
  const calls = [];
  const state = { imagesGeneration: 0, imagesTimer: null, installedImages: null, operationBusy: false,
    installedOwner: install ? null : { target: "n8n-openai-oauth", account: owner },
    planId: install ? "review-1" : null, plan: install ? { target: "n8n-openai-oauth" } : null,
    catalogLabels: new Map(), chatTester: {} };
  const context = {
    element, window, state, Date, normalizeSiwcAccount, accountUiState,
    api: async (path, options) => { calls.push({ path, body: options?.body }); events.push(`api:${path}`); return apiResult(path, options); },
    setBusy: (_button, busy) => { events.push(busy ? "busy" : "idle"); return true; },
    clearError() {}, showError(error) { events.push(`error:${error.message}`); },
    setMessage(text) { events.push(`message:${text}`); },
    document: { createElement: () => ({}) },
    isN8nSidecar: (target) => target === "n8n-openai-oauth",
    isN8nDockerTarget: (target) => target === "n8n-openai-oauth",
    isN8nSuperGrok: () => false, isN8nLocalModel: () => false,
    isN8nAssistant: () => false, isN8nStack: () => false, isCodexChat: () => false,
    isGrokBuild: (target) => target === "xai-grok-build",
    clearLocalModelPoll() {}, invalidateLocalModelReview() {}, renderInstalledSiwcModels() {}, renderFooterForTarget() {},
    appendPolicyNotice() {}, replaceListItems() {}, resetBasicAuthPasswordVisibility() {}, selectedManagedStack: () => null,
    startInstallProgress() { return true; }, stopInstallProgress() { events.push("install-stopped"); },
    showStep(step) { events.push(`step:${step}`); },
  };
  runInNewContext([
    slice(source, "function renderInstalledSiwcOwner(", "\nfunction showDashboardSiwcOwner"),
    slice(source, "// Image generation for the running installed n8n sidecar", "\nfunction clearOneTimeSetupValues"),
    ...(install ? [
      slice(source, "function invalidatePlan()", "\nfunction showDetectedManagedLocalN8nStackRecovery"),
      slice(source, "function renderPlan(plan)", "\nfunction prepareInstallPanel"),
      slice(source, "function renderN8nCredentialStatus(result)", "\nfunction renderInstallResult"),
      slice(source, "function renderInstallResult(result)", "\nfunction setChatTesterStatus"),
      slice(source, 'element("install-button").addEventListener("click"', '\nelement("remove-bridge-confirm").addEventListener'),
    ] : []),
    "initializeInstalledImages();",
    "Object.assign(globalThis, { renderInstalledSiwcOwner, renderInstalledImages, checkInstalledImages, " +
      "renderPlan: typeof renderPlan === 'function' ? renderPlan : null, " +
      "invalidatePlan: typeof invalidatePlan === 'function' ? invalidatePlan : null });",
  ].join("\n"), context);
  if (install) {
    element("install-confirm").checked = true;
    element("local-background-consent").checked = true;
    element("local-install-images-confirm").checked = false;
  }
  const due = () => timers.filter((timer) => !timer.cleared);
  return { context, element, timers, due, calls, events, state };
}

const visibleBlocks = (element) => ["off", "pending", "on"].filter((name) => !element(`installed-images-${name}`).hidden);
// Values made inside the VM have its prototypes; compare their JSON shape.
const plain = (value) => JSON.parse(JSON.stringify(value));
const settle = () => new Promise((resolve) => setImmediate(resolve));

test("the local image block shows only for the running owned sidecar and starts from a fresh status check", async () => {
  const ui = await harness(() => ({ state: "off" }));
  const render = (target, state, account = owner) => ui.context.renderInstalledSiwcOwner({ target, state,
    snapshot: { registrationId: owner.registrationId, migrationRequired: false, auth: { configured: true, account } } });
  render("n8n-openai-oauth", "healthy");
  assert.equal(ui.element("installed-images").hidden, false);
  assert.equal(ui.element("local-siwc-images-signout-note").hidden, false);
  for (const [target, state, account] of [["n8n-openai-oauth", "stopped"], ["n8n-openai-oauth", "partial"],
    ["codex-chat", "healthy"], ["n8n-openai-oauth", "healthy", { ...owner, ownership: "transferred" }]]) {
    render(target, state, account);
    assert.equal(ui.element("installed-images").hidden, true, `${target} ${state}`);
  }
  render("n8n-openai-oauth", "healthy");
  ui.element("installed-images").open = true;
  ui.element("installed-images").handlers.toggle({ currentTarget: ui.element("installed-images") });
  await settle();
  assert.deepEqual(plain(ui.calls), [{ path: "/api/local/n8n/siwc/images/status", body: { registrationId: owner.registrationId } }]);
  assert.deepEqual(visibleBlocks(ui.element), ["off"]);
  assert.equal(ui.element("installed-images-start").disabled, true, "sign-in needs the approval box");
  ui.element("installed-images-confirm").checked = true;
  ui.element("installed-images-confirm").handlers.change({ currentTarget: ui.element("installed-images-confirm") });
  assert.equal(ui.element("installed-images-start").disabled, false);
});

test("a manual status check that returns after the block was reset does not show it again", async () => {
  let answer;
  const ui = await harness(() => new Promise((resolve) => { answer = resolve; }));
  ui.context.renderInstalledSiwcOwner({ target: "n8n-openai-oauth", state: "healthy",
    snapshot: { registrationId: owner.registrationId, migrationRequired: false, auth: { configured: true, account: owner } } });
  const pending = ui.context.checkInstalledImages();
  await settle();
  ui.context.renderInstalledImages(null, false);
  answer({ state: "signed-in", account: { accountIdSuffix: "abc123" } });
  await pending;
  assert.equal(ui.element("installed-images").hidden, true);
  assert.deepEqual(visibleBlocks(ui.element).filter((name) => name === "on"), []);
});

test("a pending code shows as text with the fixed sign-in link, polls every 5 seconds and stops when hidden", async () => {
  let pollResult = { state: "pending", pending: { userCode: "<img src=x onerror=alert(1)>", verificationUrl: "https://evil.example/", expiresAt: "2026-10-07T12:15:00.000Z" } };
  const ui = await harness(() => pollResult);
  ui.context.renderInstalledImages(pollResult);
  assert.deepEqual(visibleBlocks(ui.element), ["pending"]);
  assert.equal(ui.element("installed-images-code").textContent, "<img src=x onerror=alert(1)>");
  assert.equal(ui.element("installed-images-link").href, VERIFICATION_URL, "only the fixed Codex page is linked");
  assert.match(ui.element("installed-images-expiry").textContent, /every 5 seconds/u);
  assert.equal(ui.due().length, 1);
  assert.equal(ui.due()[0].delay, 5_000);

  pollResult = { state: "signed-in", account: { email: "<b>images@example.test</b>", planType: "plus", accountIdSuffix: "abc123" } };
  ui.due()[0].callback();
  await settle();
  assert.deepEqual(plain(ui.calls.map(({ path }) => path)), ["/api/local/n8n/siwc/images/login-status"]);
  assert.deepEqual(visibleBlocks(ui.element), ["on"]);
  assert.equal(ui.element("installed-images-status").textContent, "Images on for <b>images@example.test</b> (plus).");
  assert.equal(ui.element("installed-images-link").href, "");
  assert.equal(ui.due().length, 0, "a finished sign-in is not polled again");

  ui.context.renderInstalledImages({ state: "pending", pending: { userCode: "ABCD-1234", verificationUrl: VERIFICATION_URL, expiresAt: "2026-10-07T12:15:00.000Z" } });
  const stale = ui.due()[0];
  ui.context.renderInstalledImages(null, false);
  assert.equal(ui.element("installed-images").hidden, true);
  assert.equal(ui.due().length, 0);
  stale.callback();
  await settle();
  assert.equal(ui.calls.length, 1, "a poll scheduled before hiding does not run");

  ui.context.renderInstalledImages({ state: "unavailable" });
  assert.deepEqual(visibleBlocks(ui.element), []);
  assert.match(ui.element("installed-images-status").textContent, /^Update the sidecar first/u);
});

test("image sign-out needs its approval and renders the result after the operation ends", async () => {
  const ui = await harness(() => ({ state: "off", revocation: "unconfirmed" }));
  ui.context.renderInstalledImages({ state: "signed-in", account: { accountIdSuffix: "abc123" } });
  const signOut = ui.element("installed-images-signout");
  await signOut.handlers.click({ currentTarget: signOut });
  assert.equal(ui.calls.length, 0);
  assert.match(ui.events.at(-1), /^error:Confirm/u);

  ui.element("installed-images-signout-confirm").checked = true;
  signOut.handlers.click({ currentTarget: signOut });
  await settle();
  assert.deepEqual(plain(ui.calls), [{ path: "/api/local/n8n/siwc/images/action", body: { action: "sign-out", confirmed: true } }]);
  const idle = ui.events.indexOf("idle");
  assert.ok(idle > ui.events.indexOf("api:/api/local/n8n/siwc/images/action") && idle < ui.events.findIndex((event) => event.startsWith("message:")));
  assert.deepEqual(visibleBlocks(ui.element), ["off"]);
  assert.equal(ui.element("installed-images-signout-confirm").checked, false);
  assert.match(ui.element("installed-images-status").textContent, /did not confirm the revocation/u);
});

test("unchecked sidecar install keeps image generation untouched", async () => {
  const result = { ...siwcInstallResult(), target: "n8n-openai-oauth",
    endpoint: "http://n8n-openai-oauth:10531/v1", networkName: "n8n_default" };
  const ui = await harness((path) => {
    assert.equal(path, "/api/local/install", "unchecked install makes no image request");
    return result;
  }, { install: true });
  await ui.element("install-button").handlers.click({ currentTarget: ui.element("install-button") });
  assert.deepEqual(plain(ui.calls.map(({ path }) => path)), ["/api/local/install"]);
  assert.equal(ui.element("result-credential").textContent, result.clientCredential);
  assert.equal(ui.element("installed-images").open, false);
});

test("opted-in healthy install starts image sign-in and polls the pending code", async () => {
  const result = { ...siwcInstallResult(), target: "n8n-openai-oauth",
    endpoint: "http://n8n-openai-oauth:10531/v1", networkName: "n8n_default" };
  const pending = { state: "pending", pending: {
    userCode: "ABCD-1234", verificationUrl: VERIFICATION_URL, expiresAt: "2026-10-08T12:15:00.000Z",
  } };
  const ui = await harness((path) => path === "/api/local/install" ? result
    : path.endsWith("/status") && !path.endsWith("/login-status") ? { state: "off" }
      : path.endsWith("/login-status") ? { state: "signed-in", account: { email: "images@example.test", planType: "plus" } }
        : pending, { install: true });
  ui.element("local-install-images-confirm").checked = true;
  await ui.element("install-button").handlers.click({ currentTarget: ui.element("install-button") });
  assert.deepEqual(plain(ui.calls), [
    { path: "/api/local/install", body: { planId: "review-1", confirmed: true, backgroundConsent: true } },
    { path: "/api/local/n8n/siwc/images/status", body: { registrationId: result.account.registrationId } },
    { path: "/api/local/n8n/siwc/images/action", body: { action: "login-start", confirmed: true } },
  ]);
  assert.ok(ui.events.indexOf("install-stopped") < ui.events.indexOf("api:/api/local/n8n/siwc/images/status"));
  assert.equal(ui.element("done-title").textContent, "Private n8n sidecar is installed");
  assert.equal(ui.element("result-credential").textContent, result.clientCredential);
  assert.equal(ui.element("installed-images").open, false, "Ready must fit one screen, so the block stays closed");
  assert.equal(ui.element("installed-images-title").textContent,
    "Image generation: Sidecar installed. Image sign-in pending. Open to see the code.");
  assert.deepEqual(visibleBlocks(ui.element), ["pending"]);
  assert.equal(ui.element("installed-images-status").textContent, "Sidecar installed. Image sign-in pending.");
  assert.equal(ui.element("installed-images-install-instruction").hidden, false);
  assert.equal(ui.element("installed-images-code-prompt").hidden, true);
  assert.equal(ui.element("installed-images-safety").hidden, true);
  assert.equal(ui.element("installed-images-code").textContent, pending.pending.userCode);
  assert.equal(ui.element("installed-images-link").href, pending.pending.verificationUrl);
  assert.match(ui.element("installed-images-expiry").textContent, /^Code expires at .* Relmio checks every 5 seconds\.$/u);
  assert.equal(ui.due()[0].delay, 5_000);
  ui.due()[0].callback();
  await settle();
  assert.equal(ui.element("installed-images-status").textContent,
    "Codex image sign-in complete for images@example.test. In n8n, choose gpt-image-2. Image generation has not been tested.");
  assert.equal(ui.due().length, 0);
});

test("the Ready image cancel control ends a pending install sign-in", async () => {
  const result = { ...siwcInstallResult(), target: "n8n-openai-oauth",
    endpoint: "http://n8n-openai-oauth:10531/v1", networkName: "n8n_default" };
  const ui = await harness((path, options) => {
    if (path === "/api/local/install") return result;
    if (path.endsWith("/images/status")) return { state: "off" };
    if (options.body.action === "login-cancel") return { state: "off", outcome: "declined" };
    return { state: "pending", pending: { userCode: "ABCD-1234",
      verificationUrl: VERIFICATION_URL, expiresAt: "2026-10-08T12:15:00.000Z" } };
  }, { install: true });
  ui.element("local-install-images-confirm").checked = true;
  await ui.element("install-button").handlers.click({ currentTarget: ui.element("install-button") });
  ui.element("installed-images-cancel").handlers.click({ currentTarget: ui.element("installed-images-cancel") });
  await settle();
  assert.deepEqual(plain(ui.calls.at(-1)), { path: "/api/local/n8n/siwc/images/action",
    body: { action: "login-cancel", confirmed: true } });
  assert.equal(ui.due().length, 0);
  assert.equal(ui.element("installed-images-status").textContent,
    "Sidecar installed. Image generation is off. You can sign in for images later.");
});

test("image start failure and unverified runtime leave the installed key and recovery visible", async () => {
  for (const [override, expectedCalls, failStatus] of [[{}, 3, false], [{}, 2, true],
    [{ runtimeState: "unknown" }, 1], [{ readiness: "unverified" }, 1],
    [{ finalizationFailure: { error: "journal failed" } }, 1], [{ deploymentMode: "partial" }, 1]]) {
    const result = { ...siwcInstallResult(override), target: "n8n-openai-oauth",
      endpoint: "http://n8n-openai-oauth:10531/v1", networkName: "n8n_default" };
    const ui = await harness((path) => {
      if (path === "/api/local/install") return result;
      if (path.endsWith("/images/status") && !failStatus) return { state: "off" };
      throw new Error("Image start failed");
    }, { install: true });
    ui.element("local-install-images-confirm").checked = true;
    await ui.element("install-button").handlers.click({ currentTarget: ui.element("install-button") });
    assert.equal(ui.calls.length, expectedCalls);
    assert.equal(ui.element("result-credential").textContent, result.clientCredential);
    assert.equal(ui.element("installed-images").open, false);
    assert.equal(ui.element("installed-images-title").textContent,
      "Image generation: Sidecar installed. Image sign-in did not start. You can try again under the sidecar's Manage ChatGPT sign-out, then Image generation.");
    assert.equal(ui.element("installed-images-status").textContent,
      "Sidecar installed. Image sign-in did not start. You can try again under the sidecar's Manage ChatGPT sign-out, then Image generation.");
    assert.ok(ui.events.includes("step:4"));
  }
});

test("Ready polling distinguishes failed checks, declined codes, and unknown outcomes", async () => {
  const result = { ...siwcInstallResult(), target: "n8n-openai-oauth",
    endpoint: "http://n8n-openai-oauth:10531/v1", networkName: "n8n_default" };
  const pending = { state: "pending", pending: { userCode: "ABCD-1234",
    verificationUrl: VERIFICATION_URL, expiresAt: "2026-10-08T12:15:00.000Z" } };
  const ui = await harness((path) => {
    if (path === "/api/local/install") return result;
    if (path.endsWith("/images/status")) return { state: "off" };
    if (path.endsWith("/login-status")) throw new Error("Poll failed");
    return pending;
  }, { install: true });
  ui.element("local-install-images-confirm").checked = true;
  await ui.element("install-button").handlers.click({ currentTarget: ui.element("install-button") });
  ui.due()[0].callback();
  await settle();
  assert.equal(ui.element("installed-images-status").textContent,
    "Sidecar installed. Image sign-in status could not be checked. Check image generation before trying again.");
  for (const outcome of ["declined", "expired", "cancelled"]) {
    ui.context.renderInstalledImages({ state: "off", outcome });
    assert.equal(ui.element("installed-images-status").textContent,
      "Sidecar installed. Image generation is off. You can sign in for images later.");
  }
  ui.context.renderInstalledImages({ state: "off" });
  assert.doesNotMatch(ui.element("installed-images-status").textContent, /Image generation is off/u);

  const manual = await harness(() => { throw new Error("Poll failed"); });
  manual.context.renderInstalledImages(pending);
  manual.due()[0].callback();
  await settle();
  assert.equal(manual.element("installed-images-status").textContent,
    "The image sign-in status could not be checked. Press Check image generation to continue.");
});

test("opening the install image section does not duplicate its status check", async () => {
  const result = { ...siwcInstallResult(), target: "n8n-openai-oauth",
    endpoint: "http://n8n-openai-oauth:10531/v1", networkName: "n8n_default" };
  let finishStatus;
  const ui = await harness((path) => {
    if (path === "/api/local/install") return result;
    if (path.endsWith("/images/status")) return new Promise((resolve) => { finishStatus = resolve; });
    return { state: "pending", pending: { userCode: "ABCD-1234",
      verificationUrl: VERIFICATION_URL, expiresAt: "2026-10-08T12:15:00.000Z" } };
  }, { install: true });
  ui.element("local-install-images-confirm").checked = true;
  const installing = ui.element("install-button").handlers.click({ currentTarget: ui.element("install-button") });
  await settle();
  ui.element("installed-images").handlers.toggle({ currentTarget: ui.element("installed-images") });
  await settle();
  assert.deepEqual(plain(ui.calls.map(({ path }) => path)), [
    "/api/local/install", "/api/local/n8n/siwc/images/status",
  ]);
  finishStatus({ state: "off" });
  await installing;
  assert.equal(ui.calls.at(-1).body.action, "login-start");
});

test("new review resets image opt-in without revoking the confirmed plan", async () => {
  const ui = await harness(() => { throw new Error("No API request expected"); }, { install: true });
  const plan = { target: "n8n-openai-oauth", account: siwcInstallResult().account,
    networkName: "n8n_default", endpoint: "http://n8n-openai-oauth:10531/v1" };
  ui.context.renderPlan(plan);
  assert.equal(ui.element("local-install-images-row").hidden, false);
  ui.element("local-install-images-confirm").checked = true;
  ui.element("local-install-images-disclosure").open = true;
  ui.context.renderPlan(plan);
  assert.equal(ui.element("local-install-images-confirm").checked, false);
  assert.equal(ui.element("local-install-images-disclosure").open, false);
  assert.equal(ui.element("install-confirm").checked, true);
  ui.context.invalidatePlan();
  assert.equal(ui.element("local-install-images-confirm").checked, false);
  ui.context.renderPlan({ target: "xai-grok-build", endpoint: "http://127.0.0.1:14502/v1" });
  assert.equal(ui.element("local-install-images-row").hidden, true);
});

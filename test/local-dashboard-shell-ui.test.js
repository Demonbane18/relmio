import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";

async function sources() {
  return Promise.all([readFile("src/ui/local.html", "utf8"), readFile("src/ui/local.js", "utf8")]);
}

function normalizeProvider(script) {
  const start = script.indexOf("function dashboardContractError()");
  const end = script.indexOf("function normalizeDashboardService(", start);
  assert.ok(start >= 0 && end > start);
  return runInNewContext(`${script.slice(start, end)}\nnormalizeDashboardProvider;`, {
    hasExactKeys(value, keys) {
      return Boolean(value) && typeof value === "object" && !Array.isArray(value) &&
        Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
    },
  });
}

test("dashboard declares exactly seven services and four neutral OAuth providers", async () => {
  const [, script] = await sources();
  const services = script.match(/const DASHBOARD_SERVICE_DEFINITIONS = Object\.freeze\(\[(?<body>[\s\S]*?)\]\);/u);
  const providers = script.match(/const DASHBOARD_PROVIDER_DEFINITIONS = Object\.freeze\(\[(?<body>[\s\S]*?)\]\);/u);
  assert.ok(services && providers);
  assert.equal((services.groups.body.match(/target:/gu) ?? []).length, 7);
  assert.equal((providers.groups.body.match(/target:/gu) ?? []).length, 4);
  for (const target of ["codex-chatgpt", "codex-chat", "xai-grok-build", "n8n-supergrok-oauth"]) {
    assert.match(providers.groups.body, new RegExp(`target: "${target}"[\\s\\S]*authentication: "provider-oauth", readiness: "runtime-owned"`, "u"));
  }
  assert.doesNotMatch(script, /select-api-profile|replace-api-key|registryRevision|profiles/u);
});

test("provider snapshot validation rejects profile fields and non-runtime OAuth readiness", async () => {
  const [, script] = await sources();
  const normalize = normalizeProvider(script);
  const definition = { target: "xai-grok-build", label: "SuperGrok", authentication: "provider-oauth", readiness: "runtime-owned" };
  const good = { target: "xai-grok-build", label: "SuperGrok", authentication: "provider-oauth", readiness: "runtime-owned" };
  assert.equal(JSON.stringify(normalize(good, definition)), JSON.stringify(definition));
  assert.throws(() => normalize({ ...good, profiles: [] }, definition), /unexpected dashboard/u);
  assert.throws(() => normalize({ ...good, readiness: "selected" }, definition), /unexpected dashboard/u);
});

test("dashboard copy keeps provider readiness independent from local health", async () => {
  const [html, script] = await sources();
  assert.match(html, /Provider readiness/u);
  assert.match(script, /Provider-managed · not inspected/u);
  assert.match(script, /const providerState = "absent"/u);
  assert.match(script, /SuperGrok authentication is owned by its official CLI/u);
});

function sourceBetween(script, startMarker, endMarker) {
  const start = script.indexOf(startMarker);
  const end = script.indexOf(endMarker, start);
  assert.ok(start >= 0 && end > start, `missing ${startMarker}`);
  return script.slice(start, end);
}

function oauthOnlySnapshot() {
  const services = [
    ["codex-chatgpt", "Codex (ChatGPT login)", "endpoint"],
    ["codex-chat", "Codex Chat adapter", "endpoint"],
    ["xai-grok-build", "SuperGrok", "endpoint"],
    ["local-n8n-stack", "n8n + ngrok", "n8n-stack"],
    ["n8n-openai-oauth", "OpenAI OAuth bridge", "n8n-oauth-bridge"],
    ["local-n8n-assistant", "AI Assistant tools", "n8n-assistant"],
    ["n8n-supergrok-oauth", "SuperGrok for n8n", "n8n-supergrok"],
  ].map(([target, label, kind]) => ({ target, label, kind, managed: false, state: "absent", snapshot: null, actions: ["setup"] }));
  return {
    schemaVersion: 1,
    generatedAt: "2026-09-05T00:00:00.000Z",
    docker: { available: true, version: "29.7.2", composeVersion: "2.39.1" },
    auth: { secretsRevealable: false },
    services,
    providers: [
      { target: "codex-chatgpt", label: "ChatGPT", authentication: "provider-oauth", readiness: "runtime-owned" },
      { target: "codex-chat", label: "ChatGPT", authentication: "provider-oauth", readiness: "runtime-owned" },
      { target: "xai-grok-build", label: "SuperGrok", authentication: "provider-oauth", readiness: "runtime-owned" },
      { target: "n8n-supergrok-oauth", label: "SuperGrok (n8n)", authentication: "provider-oauth", readiness: "runtime-owned" },
    ],
  };
}

function loadSnapshotNormalizer(script) {
  const constantsStart = script.indexOf("const DASHBOARD_STATES");
  const constantsEnd = script.indexOf("\nconst messageBox", constantsStart);
  const contractStart = script.indexOf("function dashboardContractError()");
  const contractEnd = script.indexOf("\nfunction dashboardStateLabel", contractStart);
  assert.ok(constantsStart >= 0 && constantsEnd > constantsStart && contractStart >= 0 && contractEnd > contractStart);
  return runInNewContext(`${script.slice(constantsStart, constantsEnd)}\nfunction hasExactKeys(value, keys) { return Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key)); }\n${script.slice(contractStart, contractEnd)}\nnormalizeDashboardSnapshot;`, { URL });
}

test("OAuth inventory normalizes seven rows, permits supported OAuth actions, and rejects retired fields", async () => {
  const [, script] = await sources();
  const normalize = loadSnapshotNormalizer(script);
  const snapshot = oauthOnlySnapshot();
  const codex = snapshot.services[0];
  Object.assign(codex, {
    managed: true,
    state: "healthy",
    snapshot: { target: codex.target, endpoint: "ws://127.0.0.1:14500/", auth: { configured: true, disclosure: "rotate-only" }, canRotateCredential: true },
    actions: ["sign-in-chatgpt", "sign-out-chatgpt", "rotate-local-capability"],
  });
  const grok = snapshot.services[2];
  Object.assign(grok, {
    managed: true,
    state: "healthy",
    snapshot: { target: grok.target, endpoint: "http://127.0.0.1:14502/", auth: { configured: true, disclosure: "rotate-only" }, canRotateCredential: true },
    actions: ["sign-in-grok-build", "sign-out-grok-build", "rotate-local-capability"],
  });
  const n8nGrok = snapshot.services[6];
  Object.assign(n8nGrok, {
    managed: true,
    state: "healthy",
    snapshot: { target: n8nGrok.target, endpoint: "http://n8n-supergrok:14502/v1", auth: { configured: true, disclosure: "one-time" }, canRemove: true },
    actions: ["sign-in-grok-build", "sign-out-grok-build", "remove-owned-supergrok"],
  });
  const normalized = normalize(snapshot);
  assert.equal(normalized.services.length, 7);
  assert.deepEqual(Array.from(normalized.services[0].actions), codex.actions);
  assert.deepEqual(Array.from(normalized.services[2].actions), grok.actions);
  assert.deepEqual(Array.from(normalized.services[6].actions), n8nGrok.actions);
  const retiredField = structuredClone(snapshot);
  retiredField.providers[2].profiles = [];
  assert.throws(() => normalize(retiredField), /unexpected dashboard/u);
  const retiredTarget = structuredClone(snapshot);
  retiredTarget.services[0].target = "xai-inference";
  assert.throws(() => normalize(retiredTarget), /unexpected dashboard/u);
  const invalidAction = structuredClone(snapshot);
  invalidAction.services[2].actions[0] = "replace-api-key";
  assert.throws(() => normalize(invalidAction), /unexpected dashboard/u);
});

test("fresh inventory renders successfully and stale inventory preserves runtime truth", async () => {
  const [, script] = await sources();
  const renderSource = sourceBetween(script, "function renderDashboardSnapshot", "\nfunction renderDashboardFailure");
  const truths = new Map();
  const nodes = new Map();
  const element = (id) => {
    if (!nodes.has(id)) nodes.set(id, { dataset: {}, hidden: false, disabled: false, replaceChildren() {}, setAttribute() {}, textContent: "" });
    return nodes.get(id);
  };
  const state = { dashboardBusy: false, dashboardFocusIdentity: null, dashboardSelectedTarget: null };
  const render = runInNewContext(`${renderSource}; renderDashboardSnapshot;`, {
    captureDashboardFocusIdentity() { return null; }, clearDashboardStaleTimer() {}, dashboardProviderForTarget() { return null; }, dashboardStateLabel(value) { return value; }, dashboardStateNode() { return {}; }, dashboardStatusDot() { return {}; }, document: { body: { dataset: {} }, createElement() { return { append() {}, textContent: "" }; } }, element, formatDashboardTime() { return "Sep 5"; }, isDashboardSnapshotStale() { return false; }, renderDashboardCompactService() { return {}; }, renderDashboardProvider() { return {}; }, renderDashboardSectionStatus() { return {}; }, renderDashboardServiceDetail() {}, renderDashboardServiceRow() { return {}; }, renderDashboardTruth(id, label, status) { truths.set(id, { label, status }); }, restoreDashboardFocus() {}, scheduleDashboardStaleExpiry() {}, state,
  });
  const snapshot = oauthOnlySnapshot();
  snapshot.services[0] = { ...snapshot.services[0], managed: true, state: "healthy", snapshot: { target: "codex-chatgpt", endpoint: "ws://127.0.0.1:14500/", auth: { configured: true, disclosure: "rotate-only" }, canRotateCredential: true }, actions: ["sign-in-chatgpt", "sign-out-chatgpt", "rotate-local-capability"] };
  render(snapshot, { stale: false });
  assert.deepEqual(truths.get("dashboard-inventory-freshness"), { label: "Current", status: "healthy" });
  render(snapshot, { stale: true });
  assert.deepEqual(truths.get("dashboard-runtime-health"), { label: "Healthy", status: "healthy" });
  assert.deepEqual(truths.get("dashboard-provider-readiness"), { label: "Provider-managed · not inspected", status: "absent" });
  assert.deepEqual(truths.get("dashboard-inventory-freshness"), { label: "Refresh needed", status: "stale" });
});

test("dashboard failure replaces loading state with seven unavailable rows", async () => {
  const [, script] = await sources();
  const source = sourceBetween(script, "function renderDashboardFailure", "\nasync function loadLocalDashboard");
  const nodes = new Map();
  const element = (id) => {
    if (!nodes.has(id)) nodes.set(id, { children: [], className: "", dataset: {}, disabled: true, hidden: false, focus() {}, querySelector() { return { className: "dashboard-status-dot state-checking" }; }, replaceChildren(...children) { this.children = children; }, setAttribute() {}, textContent: "Checking" });
    return nodes.get(id);
  };
  const definitions = oauthOnlySnapshot().services.map(({ target, label, kind }) => ({ target, label, kind }));
  const render = runInNewContext(`${source}; renderDashboardFailure;`, { clearDashboardStaleTimer() {}, DASHBOARD_SERVICE_DEFINITIONS: definitions, dashboardStatusDot() { return {}; }, document: { body: { dataset: {} }, createElement() { return { append() {}, textContent: "" }; } }, element, renderDashboardRelayPath() {}, renderDashboardTruth(id, label) { element(id).textContent = label; }, renderDashboardCompactService(service) { return { service, lastElementChild: { textContent: "" } }; }, renderDashboardSectionStatus() { return {}; }, renderDashboardServiceRow(service) { return { service }; }, renderDashboardSnapshot() { throw new Error("must not render a missing snapshot"); }, state: { dashboardBusy: true, dashboardSnapshot: null } });
  render();
  assert.equal(element("dashboard-services").children.length, 7);
  assert.ok(element("dashboard-services").children.every(({ service }) => service.state === "unavailable" && service.actions.length === 0));
  assert.equal(element("dashboard-runtime-health").textContent, "Unavailable");
  assert.equal(element("dashboard-inventory-freshness").textContent, "Unavailable");
});

test("provider guidance dispatches without starting provider authentication", async () => {
  const [, script] = await sources();
  const source = sourceBetween(script, "async function runDashboardAction", "\nfunction renderDashboardAction");
  const calls = [];
  const run = runInNewContext(`${source}; runDashboardAction;`, { dashboardToWizardTarget(target) { return target; }, async enterSetupView(target, options) { calls.push({ kind: "setup", target, options }); }, isDashboardSnapshotStale() { return false; }, showDashboardCodexSignInManagement() { calls.push({ kind: "codex" }); }, showDashboardProviderRuntimeGuidance(service, action) { calls.push({ kind: "guidance", target: service.target, action }); }, showDashboardRemovalReview() {}, showDashboardRotationReview() {}, showStoppedManagedLocalN8nStack() {}, state: { dashboardBusy: false, dashboardSnapshot: oauthOnlySnapshot() } });
  const grok = { target: "xai-grok-build", label: "SuperGrok", kind: "endpoint", actions: ["sign-in-grok-build", "sign-out-grok-build", "rotate-local-capability"] };
  await run(grok, "sign-in-grok-build");
  await run(grok, "sign-out-grok-build");
  assert.deepEqual(JSON.parse(JSON.stringify(calls)), [
    { kind: "setup", target: "xai-grok-build", options: { checkDocker: false } },
    { kind: "guidance", target: "xai-grok-build", action: "sign-in-grok-build" },
    { kind: "setup", target: "xai-grok-build", options: { checkDocker: false } },
    { kind: "guidance", target: "xai-grok-build", action: "sign-out-grok-build" },
  ]);
});

test("navigation clears one-time local values and dashboard controls remain keyboard-addressable", async () => {
  const [html, script] = await sources();
  const source = sourceBetween(script, "function clearOneTimeSetupValues", "\nfunction resetPendingSetupState");
  const nodes = new Map();
  const element = (id) => {
    if (!nodes.has(id)) nodes.set(id, { value: "sensitive", textContent: "sensitive", removeAttribute() {}, hidden: false });
    return nodes.get(id);
  };
  const clear = runInNewContext(`${source}; clearOneTimeSetupValues;`, { element, clearChatTesterState() {} });
  clear();
  for (const id of ["result-credential", "result-sandbox-key", "result-n8n-settings", "device-code"]) assert.equal(element(id).textContent, "");
  assert.match(html, /id="dashboard-title" tabindex="-1"/u);
  assert.match(script, /select\.type = "button";[\s\S]*aria-pressed/u);
  assert.match(script, /button\.type = "button";[\s\S]*runDashboardAction/u);
});

test("local OAuth endpoint planning emits only target and port", async () => {
  const [, script] = await sources();
  const helpers = sourceBetween(script, "function isCodexChat(target)", "\nfunction assistantModeLabel");
  const handler = sourceBetween(script, 'element("target-form").addEventListener("submit"', "\nfor (const input of document.querySelectorAll('input[name=\"target\"]')");
  const controls = new Map();
  const element = (id) => {
    if (!controls.has(id)) controls.set(id, { value: id === "local-port" ? "14502" : "", checked: false, disabled: false, addEventListener(name, listener) { this.listener = listener; } });
    return controls.get(id);
  };
  const requests = [];
  const state = { target: "xai-grok-build", operationBusy: false, planId: null, plan: null };
  runInNewContext(`${helpers}\n${handler}`, {
    api: async (path, options) => {
      requests.push({ path, body: options.body });
      return { planId: "reviewed", plan: { target: options.body.target } };
    },
    clearError() {}, element, invalidatePlan() {}, renderPlan() {}, setBusy() { return true; }, setMessage() {}, showError(error) { throw error; }, showStep() {}, state,
  });
  for (const target of ["codex-chatgpt", "codex-chat", "xai-grok-build"]) {
    state.target = target;
    await element("target-form").listener({ preventDefault() {} });
  }
  assert.deepEqual(JSON.parse(JSON.stringify(requests)), [
    { path: "/api/local/plan", body: { target: "codex-chatgpt", port: "14502" } },
    { path: "/api/local/plan", body: { target: "codex-chat", port: "14502" } },
    { path: "/api/local/plan", body: { target: "xai-grok-build", port: "14502" } },
  ]);
});

test("private n8n SuperGrok planning sends only the selected n8n identities", async () => {
  const [, script] = await sources();
  const helpers = sourceBetween(script, "function isCodexChat(target)", "\nfunction assistantModeLabel");
  const handler = sourceBetween(script, 'element("target-form").addEventListener("submit"', "\nfor (const input of document.querySelectorAll('input[name=\"target\"]')");
  const controls = new Map();
  const element = (id) => {
    if (!controls.has(id)) controls.set(id, { value: id === "n8n-container" ? "n8n-123" : id === "n8n-network" ? "network-456" : "", checked: false, disabled: false, addEventListener(name, listener) { this.listener = listener; } });
    return controls.get(id);
  };
  const requests = [];
  const state = { target: "n8n-supergrok-oauth", operationBusy: false, planId: null, plan: null, n8nOAuthExists: false };
  runInNewContext(`${helpers}\n${handler}`, {
    api: async (path, options) => {
      requests.push({ path, body: options.body });
      return { planId: "reviewed", plan: { target: options.body.target } };
    },
    clearError() {}, element, invalidatePlan() {}, renderPlan() {}, setBusy() { return true; }, setMessage() {}, showError(error) { throw error; }, showStep() {}, state,
  });
  await element("target-form").listener({ preventDefault() {} });
  assert.deepEqual(JSON.parse(JSON.stringify(requests)), [{
    path: "/api/local/plan",
    body: { target: "n8n-supergrok-oauth", n8nContainerId: "n8n-123", dockerNetworkId: "network-456" },
  }]);
});

test("private n8n SuperGrok install validation rejects an unexpected endpoint before rendering a bearer", async () => {
  const [, script] = await sources();
  const source = sourceBetween(script, "function renderInstallResult", "\nfunction setChatTesterStatus");
  const render = runInNewContext(`${source}; renderInstallResult;`, {
    hasExactKeys(value, keys) { return Boolean(value) && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)); },
    isN8nSidecar() { return false; }, isN8nSuperGrok(target) { return target === "n8n-supergrok-oauth"; }, isN8nAssistant() { return false; }, isN8nStack() { return false; }, isSafeDockerDisplayName(value) { return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(value); },
    state: {}, element() { throw new Error("invalid result must not render"); },
  });
  assert.throws(() => render({
    target: "n8n-supergrok-oauth", endpoint: "http://unexpected:14502/v1", baseUrl: "http://unexpected:14502/v1", protocol: "openai-chat-completions", networkName: "private", n8nContainerName: "n8n", hostPublication: "none", clientCredential: "a".repeat(32), credentialShownOnce: true, deploymentMode: "installed", models: ["grok-build"],
  }), /unexpected response/u);
});

test("private n8n SuperGrok removal is stale-guarded and never dispatches the OpenAI bridge endpoint", async () => {
  const [, script] = await sources();
  const actionSource = sourceBetween(script, "async function runDashboardAction", "\nfunction renderDashboardAction");
  const removalSource = sourceBetween(script, 'element("remove-supergrok-confirm").addEventListener', '\nelement("remove-assistant-confirm").addEventListener');
  assert.match(removalSource, /\/api\/local\/supergrok\/remove/u);
  assert.doesNotMatch(removalSource, /\/api\/local\/n8n\/remove/u);
  const calls = [];
  const nodes = new Map();
  const element = (id) => {
    if (!nodes.has(id)) nodes.set(id, { hidden: true, textContent: "", focus() {} });
    return nodes.get(id);
  };
  const run = runInNewContext(`${actionSource}; runDashboardAction;`, {
    dashboardToWizardTarget(target) { return target; }, async enterSetupView() { calls.push("setup"); }, isDashboardSnapshotStale() { return true; }, renderDashboardSnapshot() { calls.push("render-stale"); }, showDashboardCodexSignInManagement() {}, showDashboardProviderRuntimeGuidance() {}, showDashboardRemovalReview() { calls.push("remove"); }, showDashboardRotationReview() {}, showStoppedManagedLocalN8nStack() {}, state: { dashboardBusy: false, dashboardSnapshot: { generatedAt: "old" } }, element,
  });
  await run({ target: "n8n-supergrok-oauth", actions: ["remove-owned-supergrok"] }, "remove-owned-supergrok");
  assert.deepEqual(calls, ["render-stale"]);
  assert.match(element("dashboard-error").textContent, /expired/u);
});

test("provider runtime guidance clears completion chrome and ordinary setup restores it", async () => {
  const [, script] = await sources();
  const stepSource = sourceBetween(script, "function showStep(step,", "\nasync function api");
  const guidanceSource = sourceBetween(
    script,
    "function showDashboardProviderRuntimeGuidance",
    "\nfunction showDashboardRemovalReview",
  );
  const nodes = new Map();
  const makeNode = (dataset = {}) => {
    const attributes = new Map();
    const classes = new Set();
    return {
      attributes,
      classList: {
        contains: (name) => classes.has(name),
        toggle(name, active) { active ? classes.add(name) : classes.delete(name); },
      },
      dataset,
      focus() {},
      hidden: false,
      querySelector() { return { focus() {} }; },
      removeAttribute(name) { attributes.delete(name); },
      setAttribute(name, value) { attributes.set(name, value); },
      textContent: "",
    };
  };
  for (const id of ["setup-progress", "done-step-caption", "success-mark", "done-title", "done-detail"]) {
    nodes.set(id, makeNode());
  }
  const panels = [1, 2, 3, 4].map((step) => makeNode({ step: String(step) }));
  const markers = [1, 2, 3, 4].map((step) => makeNode({ stepMarker: String(step) }));
  const [showStep, showGuidance] = runInNewContext(
    `${stepSource}\n${guidanceSource}\n[showStep, showDashboardProviderRuntimeGuidance];`,
    {
      dashboardProviderForTarget(target) {
        return target.startsWith("codex")
          ? { label: "ChatGPT" }
          : { label: "SuperGrok" };
      },
      document: {
        body: { dataset: {} },
        querySelectorAll(selector) {
          return selector === "[data-step]" ? panels : markers;
        },
      },
      element(id) { return nodes.get(id); },
      preferredScrollBehavior() { return "auto"; },
      resetDashboardActionReview() {},
      setMessage() {},
      state: {},
      window: { scrollTo() {} },
    },
  );

  for (const [target, action] of [
    ["xai-grok-build", "sign-in-grok-build"],
    ["xai-grok-build", "sign-out-grok-build"],
    ["codex-chat", "sign-out-chatgpt"],
  ]) {
    showGuidance({ target }, action);
    assert.equal(nodes.get("setup-progress").hidden, true);
    assert.equal(nodes.get("done-step-caption").hidden, true);
    assert.equal(nodes.get("success-mark").hidden, true);
    assert.ok(markers.every((marker) => !marker.classList.contains("complete")));
    assert.ok(markers.every((marker) => !marker.attributes.has("aria-current")));
  }

  showStep(1);
  assert.equal(nodes.get("setup-progress").hidden, false);
  assert.equal(nodes.get("done-step-caption").hidden, false);
  assert.equal(nodes.get("success-mark").hidden, false);
  assert.equal(markers[0].attributes.get("aria-current"), "step");
  showStep(4);
  assert.ok(markers.slice(0, 3).every((marker) => marker.classList.contains("complete")));
  assert.equal(markers[3].attributes.get("aria-current"), "step");
});

test("provider rows name each local runtime while preserving neutral provider readiness", async () => {
  const [, script] = await sources();
  const definitionsStart = script.indexOf("const DASHBOARD_SERVICE_DEFINITIONS");
  const definitionsEnd = script.indexOf("\nconst DASHBOARD_PROVIDER_DEFINITIONS", definitionsStart);
  const renderer = sourceBetween(script, "function renderDashboardProvider", "\nfunction renderDashboardTruth");
  assert.ok(definitionsStart >= 0 && definitionsEnd > definitionsStart);
  const document = {
    createElement() {
      return {
        children: [],
        append(...children) { this.children.push(...children); },
        textContent: "",
      };
    },
  };
  const { definitions, render } = runInNewContext(
    `${script.slice(definitionsStart, definitionsEnd)}\n${renderer}\n({ definitions: DASHBOARD_SERVICE_DEFINITIONS, render: renderDashboardProvider });`,
    {
      dashboardProviderReadiness() { return "Provider-managed · not inspected"; },
      dashboardProviderState() { return "absent"; },
      dashboardStateNode() { return document.createElement("span"); },
      dashboardStatusDot() { return document.createElement("span"); },
      document,
    },
  );
  const providers = [
    { target: "codex-chatgpt", label: "ChatGPT" },
    { target: "codex-chat", label: "ChatGPT" },
    { target: "xai-grok-build", label: "SuperGrok" },
  ];
  const rows = providers.map(render);
  const titles = rows.map((row) => row.children[1].children[0].textContent);
  const details = rows.map((row) => row.children[1].children[1].textContent);

  assert.deepEqual(titles, Array.from(definitions).slice(0, 3).map(({ label }) => label));
  assert.equal(new Set(titles).size, 3);
  assert.deepEqual(details, [
    "Provider: ChatGPT · Provider-managed · not inspected",
    "Provider: ChatGPT · Provider-managed · not inspected",
    "Provider: SuperGrok · Provider-managed · not inspected",
  ]);
});

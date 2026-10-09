import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";

const script = await readFile(new URL("../src/ui/local.js", import.meta.url), "utf8");

function source(start, end) {
  const from = script.indexOf(start);
  const to = script.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `missing ${start}`);
  return script.slice(from, to);
}

function nodes() {
  const entries = new Map();
  const element = (id) => {
    if (!entries.has(id)) entries.set(id, {
      value: "", checked: false, disabled: false, hidden: false, open: false, textContent: "",
      handlers: {}, children: [], setCustomValidity() {}, replaceChildren(...items) { this.children = items; },
      addEventListener(name, handler) { this.handlers[name] = handler; },
      set innerHTML(_) { throw new Error("Never use innerHTML for server text"); },
    });
    return entries.get(id);
  };
  return { element, entries };
}

const stack = {
  target: "local-n8n-stack", publicAccess: "none", localUrl: "http://localhost:5679",
  ngrokPublicUrl: null, projectName: `relmio-local-n8n-${"a".repeat(32)}`,
  n8nContainerName: "relmio-local-n8n-n8n-1", networkName: "relmio-local-n8n_edge",
  assistantMode: "disabled", containerServices: ["n8n"], networks: ["relmio-local-n8n_edge"],
  deploymentMode: "new-disposable-stack", hostPublication: "127.0.0.1:5679",
};

const predicates = {
  isN8nLocalModel: (target) => target === "n8n-local-model",
  isN8nSidecar: (target) => target === "n8n-openai-oauth",
  isN8nSuperGrok: (target) => target === "n8n-supergrok-oauth",
  isN8nAssistant: (target) => target === "n8n-ai-assistant",
  isN8nStack: (target) => target === "local-n8n-stack",
  isGrokBuild: () => false, isCodexChat: () => false,
};

function planHarness(publicLink) {
  const { element } = nodes();
  element("n8n-stack-public-access").checked = publicLink;
  element("ngrok-hostname").value = "work.example.ngrok.app";
  element("ngrok-inspector-port").value = "4041";
  element("n8n-stack-port").value = "5679";
  element("n8n-stack-timezone").value = "Asia/Manila";
  element("n8n-stack-assistant-mode").value = "disabled";
  const calls = [];
  const plan = { ...stack, publicAccess: publicLink ? "ngrok" : "none",
    ngrokPublicUrl: publicLink ? "https://work.example.ngrok.app" : null };
  const state = { target: "local-n8n-stack", dockerAvailable: true, n8nContainers: [] };
  runInNewContext(`${source('element("target-form").addEventListener("submit"', '\nfor (const button of document.querySelectorAll("[data-stack-addon]"))')}`, {
    state, element, ...predicates, stackUsesNgrok: () => element("n8n-stack-public-access").checked,
    assistantAlreadyInstalled: () => false, isN8nDockerTarget: () => false,
    setBusy: () => true, clearError() {}, invalidatePlan() {}, renderPlan() {}, showStep() {}, setMessage() {},
    showError(error) { throw error; },
    api: async (_path, request) => { calls.push(request.body); return { planId: "plan-1", plan }; },
  });
  return { element, calls, state };
}

test("stack plan defaults private and opt-in sends ngrok fields", async () => {
  for (const publicLink of [false, true]) {
    const ui = planHarness(publicLink);
    await ui.element("target-form").handlers.submit({ preventDefault() {} });
    const body = ui.calls[0];
    assert.equal(body.publicAccess, publicLink ? "ngrok" : "none");
    assert.equal(Object.hasOwn(body, "ngrokHostname"), publicLink);
    assert.equal(Object.hasOwn(body, "ngrokInspectorPort"), publicLink);
  }
});

test("ngrok fields are hidden and inert unless public access is checked", () => {
  const { element } = nodes();
  const state = { target: "local-n8n-stack" };
  const update = runInNewContext(`${source('function stackUsesNgrok()', '\nfunction validateLocalN8nStackCredentials()')}; updateStackPublicAccess`, {
    element, state, isN8nStack: predicates.isN8nStack, invalidatePlan() {},
  });
  update();
  for (const id of ["ngrok-hostname-field", "ngrok-inspector-field", "ngrok-checklist"]) {
    assert.equal(element(id).hidden, true);
  }
  for (const id of ["ngrok-hostname", "ngrok-inspector-port"]) {
    assert.equal(element(id).disabled, true);
    assert.equal(element(id).required, false);
  }
  element("n8n-stack-public-access").checked = true;
  update();
  assert.equal(element("ngrok-hostname-field").hidden, false);
  assert.equal(element("ngrok-inspector-port").required, true);
  assert.match(element("boundary-detail").textContent, /Basic Auth/u);
});

test("stack review omits exposure confirmation for private mode", () => {
  for (const publicLink of [false, true]) {
    const { element } = nodes();
    const plan = { ...stack, publicAccess: publicLink ? "ngrok" : "none",
      ngrokPublicUrl: publicLink ? "https://work.example.ngrok.app" : null };
    const render = runInNewContext(`${source('function renderPlan(plan)', '\nfunction prepareInstallPanel')}; renderPlan`, {
      element, document: { createElement: () => ({ textContent: "" }) }, ...predicates,
      isN8nDockerTarget: () => false,
      selectedManagedStack: () => null,
      normalizeSiwcAccount() {}, accountUiState() {}, validateLocalModelPlan() {},
      assistantModeLabel: () => "Disabled", modelGigabytes: String,
      replaceListItems(target, items) { target.children = items; },
      appendPolicyNotice(target, heading, detail) { target.heading = heading; target.detail = detail; },
    });
    render(plan);
    assert.equal(element("review-endpoint").textContent, stack.localUrl);
    assert.equal(element("review-public-url-row").hidden, !publicLink);
    assert.equal(element("install-confirm-copy").textContent.includes("public ngrok URL"), publicLink);
    if (!publicLink) assert.ok(element("review-will").children.includes("Private to this computer. No public URL."));
  }
});

test("managed ChatGPT review shows credential access and token boundaries before approval", () => {
  const { element } = nodes();
  const render = runInNewContext(`${source('function renderPlan(plan)', '\nfunction prepareInstallPanel')}; renderPlan`, {
    element, document: { createElement: () => ({ textContent: "" }) }, ...predicates,
    isN8nDockerTarget: () => true,
    selectedManagedStack: () => ({ n8nContainerName: stack.n8nContainerName }),
    normalizeSiwcAccount: (account) => account, accountUiState: () => "plan-active",
    assistantModeLabel: () => "Disabled", modelGigabytes: String,
    replaceListItems(target, items) { target.children = items; },
    appendPolicyNotice(target, heading, detail) { target.heading = heading; target.detail = detail; },
  });
  render({ target: "n8n-openai-oauth", endpoint: "http://n8n-openai-oauth:10531/v1",
    n8nContainerName: stack.n8nContainerName, networkName: stack.networkName,
    account: { label: "Test account", registrationId: "fixture-registration-1", needsPlanWelcome: false } });
  const notice = element("review-policy");
  assert.match(notice.detail, /OpenAI tokens stay in the sidecar/u);
  assert.match(notice.detail, /Anyone allowed to use this credential can send requests/u);
  assert.match(notice.detail, /own approved workflows/u);
  assert.match(notice.detail, /Docker users and backups/u);
});

test("Ready opens local n8n and offers matching add-ons only", () => {
  for (const { assistantMode, publicAccess } of [
    { assistantMode: "disabled", publicAccess: "none" },
    { assistantMode: "sandbox", publicAccess: "none" },
    { assistantMode: "disabled", publicAccess: "ngrok" },
  ]) {
    const { element } = nodes();
    const buttons = ["n8n-openai-oauth", "n8n-local-model", "n8n-supergrok-oauth", "n8n-ai-assistant"]
      .map((stackAddon) => ({ dataset: { stackAddon }, hidden: false }));
    const state = { chatTester: {}, n8nDiscoveryLoaded: true };
    const render = runInNewContext(`${source('function isSafeLocalN8nUrl(value)', '\nfunction normalizeStackDashboardSnapshot')}\n${source('function renderInstallResult(result)', '\nfunction setChatTesterStatus')}; renderInstallResult`, {
      element, state, document: { querySelectorAll: () => buttons }, ...predicates,
      assistantModeLabel: (value) => value, isSafeDockerDisplayName: (value) => /^[A-Za-z0-9_.-]+$/u.test(value),
      clearLocalModelPoll() {}, appendPolicyNotice() {}, renderN8nCredentialStatus() {},
    });
    render({ ...stack, assistantMode, publicAccess,
      ngrokPublicUrl: publicAccess === "ngrok" ? "https://work.example.ngrok.app" : null });
    assert.equal(element("n8n-stack-open-link").href, stack.localUrl);
    assert.equal(element("n8n-stack-open").hidden, false);
    assert.equal(element("n8n-stack-addons").hidden, false);
    assert.deepEqual(buttons.map(({ hidden }) => hidden), [false, false, false, assistantMode !== "disabled"]);
    assert.equal(element("result-n8n").textContent, stack.n8nContainerName);
    assert.equal(element("result-network").textContent, stack.networkName);
    assert.equal(element("result-deployment-row").hidden, true);
    assert.equal(element("done-detail").textContent, publicAccess === "none"
      ? "This n8n runs only on this computer."
      : "Open n8n here. Check the public URL requires Basic Auth in a private window.");
    assert.equal(element("result-public-url-row").hidden, publicAccess === "none");
    assert.equal(state.n8nDiscoveryLoaded, false);
  }
});

test("Ready add-on buttons preselect exact stack pair, then fall back when discovery differs", async () => {
  for (const matches of [true, false]) {
    const { element } = nodes();
    const stages = [];
    const buttons = ["n8n-openai-oauth", "n8n-local-model", "n8n-supergrok-oauth", "n8n-ai-assistant"]
      .map((stackAddon) => ({ dataset: { stackAddon }, handlers: {}, addEventListener(name, handler) { this.handlers[name] = handler; } }));
    const state = { installedStack: stack, n8nContainers: [], operationBusy: false };
    runInNewContext(source('\nfor (const button of document.querySelectorAll("[data-stack-addon]"))', '\nfor (const input of document.querySelectorAll(\'input[name="target"]\'))'), {
      state, element, document: { querySelectorAll: () => buttons },
      clearError() {}, selectN8nManagementTarget(target) { state.target = target; },
      showStep(step) { stages.push(step); }, showSetupStage(stage) { stages.push(stage); },
      updateN8nChoiceVisibility(skip) { stages.push(skip === true ? "skipped" : "shown"); },
      async refreshSelectedN8nContext() {
        state.n8nDiscoveryLoaded = true;
        state.n8nContainers = [{ containerId: "container-1", containerName: matches ? stack.n8nContainerName : "other-n8n", managedStack: matches,
          networks: [{ dockerNetworkId: "network-1", networkName: matches ? stack.networkName : "other_network" }] }];
        element("n8n-container").value = "container-1";
        element("n8n-network").value = "network-1";
      },
      showError(error) { throw error; },
    });
    for (const button of buttons) {
      await button.handlers.click();
      assert.equal(state.target, button.dataset.stackAddon);
      assert.equal(state.stackAddonPrefill.n8nContainerName, stack.n8nContainerName);
      assert.equal(state.stackAddonPrefill.networkName, stack.networkName);
      assert.equal(stages.at(-1), matches ? "skipped" : "choose");
    }
  }
});

test("managed discovery preselects its recommended network and blocks duplicate Assistant", async () => {
  const { element } = nodes();
  const managed = { containerId: "id-1", containerName: stack.n8nContainerName, image: "n8n:latest",
    managedStack: true, recommendedNetwork: stack.networkName,
    networks: [{ dockerNetworkId: "net-1", networkName: stack.networkName }] };
  const state = { target: "n8n-local-model", n8nContainers: [], stackAddonPrefill: null,
    installedStack: { ...stack, assistantMode: "sandbox" }, dockerAvailable: true };
  const fixture = source('function setSelectOptions(select, options, emptyLabel, promptLabel)', '\nfunction selectN8nManagementTarget(target)');
  const api = runInNewContext(`${fixture}\n${source('async function enterSetupView(', '\nasync function enterDashboardView')}; ({
    refreshN8nDiscovery, updateReviewAvailability, renderSidecarNetworkOptions, enterSetupView, updateN8nChoiceVisibility
  })`, {
    state, element, document: {
      body: { dataset: {} },
      createElement: () => ({ value: "", textContent: "" }),
      querySelector: (selector) => selector === ".docker-status" ? element("docker-status") : element("target-input"),
    },
    api: async () => ({ containers: [managed] }), invalidatePlan() {},
    isN8nSidecar: predicates.isN8nSidecar, isN8nStack: predicates.isN8nStack,
    isN8nSuperGrok: predicates.isN8nSuperGrok,
    isN8nDockerTarget: () => true, isN8nAssistant: predicates.isN8nAssistant, isCodexChat: () => false,
    isN8nLocalModel: predicates.isN8nLocalModel, isSafeDockerDisplayName: () => true,
    LOCAL_MODEL_IDS: new Set(["qwen3:0.6b"]),
    clearDashboardStaleTimer() {}, renderTarget() { state.target = element("target-input").value; },
    showSetupStage() {}, showStep() {}, async initializeLocalWizard() {}, focusVisibleSetupHeading() {},
    async refreshSelectedN8nContext() { await api.refreshN8nDiscovery(); },
  });
  for (const target of ["n8n-openai-oauth", "n8n-local-model", "n8n-supergrok-oauth", "n8n-ai-assistant"]) {
    element("target-input").value = target;
    element("n8n-container").value = "previous-choice";
    element("n8n-network").value = "previous-network";
    await api.enterSetupView(target);
    assert.equal(element("n8n-container").value, managed.containerId);
    assert.equal(element("n8n-network").value, managed.networks[0].dockerNetworkId);
    assert.equal(element("n8n-container-field").hidden, true);
    assert.equal(element("n8n-network-field").hidden, true);
    assert.equal(element("n8n-change-choice").hidden, false);
  }
  api.updateN8nChoiceVisibility();
  await api.refreshN8nDiscovery();
  assert.equal(element("n8n-container-field").hidden, false, "refresh must preserve the expanded manual choice");
  state.target = "n8n-ai-assistant";
  api.renderSidecarNetworkOptions();
  assert.equal(element("review-button").disabled, true);
  assert.equal(element("n8n-discovery-status").textContent, "This n8n already has Assistant tools from its setup.");
  state.target = "n8n-local-model";
  element("local-model-id").value = "qwen3:0.6b";
  api.updateReviewAvailability();
  assert.equal(element("review-button").disabled, false);
});

test("credential success keeps key in closed disclosure; failure exposes manual key", () => {
  const { element } = nodes();
  const render = runInNewContext(`${source('function renderN8nCredentialStatus(result)', '\nfunction renderInstallResult')}; renderN8nCredentialStatus`, {
    element, isN8nLocalModel: predicates.isN8nLocalModel,
  });
  const key = "one-time-test-key";
  for (const state of ["created", "updated"]) {
    render({ target: "n8n-openai-oauth", clientCredential: key,
      n8nCredential: { state, name: '<img src=x onerror="oops">' } });
    assert.match(element("n8n-credential-status").textContent, /Added to n8n as "<img/u);
    assert.equal(element("result-credential-row").hidden, true);
    assert.equal(element("n8n-key-elsewhere").hidden, false);
    assert.equal(element("n8n-key-elsewhere").open, false);
    assert.equal(element("n8n-elsewhere-key").textContent, key);
    assert.equal(element("one-time-note").hidden, true);
  }
  render({ target: "n8n-openai-oauth", clientCredential: key, n8nCredential: { state: "failed", name: "Relmio ChatGPT plan" } });
  assert.match(element("n8n-credential-status").textContent, /Check n8n for the named credential before adding the key below manually/u);
  assert.equal(element("n8n-key-elsewhere").hidden, true);
  assert.equal(element("result-credential-row").hidden, false);
  render({ target: "n8n-local-model", n8nCredential: { state: "created", name: "Relmio local model" } });
  assert.equal(element("local-model-placeholder-row").hidden, true);
  assert.equal(element("n8n-elsewhere-key").textContent, "local-only");
});

test("healthy stack row opens validated local URL, never an unhealthy endpoint", () => {
  const normalize = runInNewContext(`${source('function isSafeLocalN8nUrl(value)', '\nfunction normalizeStackDashboardSnapshot')}\n${source('function normalizeStackDashboardSnapshot(snapshot)', '\nfunction normalizeBridgeDashboardSnapshot')}; normalizeStackDashboardSnapshot`, {
    assertDashboardKeys() {}, DASHBOARD_ASSISTANT_MODES: new Set(["disabled", "sandbox", "sandbox-with-searxng"]),
    dashboardContractError: () => new Error("Invalid dashboard response"),
    normalizeDashboardEndpoint: (value) => value, normalizeDashboardPublicUrl: (value) => value,
    normalizeDashboardBooleans: (value) => value, isSafeDockerDisplayName: (value) => typeof value === "string",
  });
  const snapshot = normalize({ target: "local-n8n-stack", assistantMode: "disabled", publicAccess: "none",
    localUrl: stack.localUrl, ngrokPublicUrl: null, n8nContainerName: stack.n8nContainerName,
    networkName: stack.networkName, endpoints: { n8nLocal: "http://127.0.0.1:5679/", ngrokPublic: null,
      ngrokInspector: null }, components: { n8n: true, ngrok: false, codeSandbox: false, searxng: false },
    canResume: false, canRemove: true });
  assert.equal(snapshot.localUrl, stack.localUrl);
  assert.equal(snapshot.endpoints.ngrokPublic, null);
  assert.throws(() => normalize({ ...snapshot, localUrl: "https://outside.example/" }), /Invalid dashboard response/u);
  const createElement = (tagName) => ({
    tagName, children: [], dataset: {}, append(...items) { this.children.push(...items); },
    addEventListener() {}, setAttribute() {},
    get childElementCount() { return this.children.length; },
  });
  const views = runInNewContext(`${source('function createDashboardOpenN8nLink(', '\nfunction renderDashboardSectionStatus')}; ({ row: renderDashboardServiceRow, compact: renderDashboardCompactService })`, {
    document: { createElement }, state: {}, dashboardStatusDot: () => createElement("span"),
    dashboardStateNode: () => createElement("span"),
    dashboardStateLabel: () => "Healthy", dashboardBoundary: () => "Loopback only",
    isSafeLocalN8nUrl: (value) => value === stack.localUrl,
    renderDashboardAction: () => null, renderDashboardServiceDetail() {},
  });
  const service = { kind: "n8n-stack", target: "local-n8n-stack", state: "healthy",
    label: "Local n8n stack", actions: [], snapshot };
  const healthy = views.row(service, { selected: false, stale: false });
  const open = healthy.children.at(-1);
  assert.equal(open.tagName, "a");
  assert.equal(open.href, stack.localUrl);
  assert.equal(open.target, "_blank");
  assert.equal(open.rel, "noopener noreferrer");
  assert.equal(views.row({ ...service, state: "stopped" }, { selected: false, stale: false }).children.length, 1);
  const compact = views.compact(service);
  const compactLink = compact.children[1].children.at(-1);
  assert.equal(compactLink.href, stack.localUrl);
  assert.equal(compactLink.target, "_blank");
  assert.equal(compactLink.rel, "noopener noreferrer");
  assert.equal(views.compact({ ...service, state: "stopped" }).children[1].children.length, 2);
});

test("stack removal review replaces the previous Ready eyebrow", () => {
  const { element } = nodes();
  element("done-provider-context").textContent = "Managed private model · n8n Chat Completions";
  const state = { installedTarget: "n8n-local-model" };
  const review = runInNewContext(`${source('function showDashboardRemovalReview(', '\nasync function runDashboardAction')}; showDashboardRemovalReview`, {
    state, element, document: { querySelector: () => null },
    resetDashboardActionReview() {}, dashboardToWizardTarget: (target) => target,
    showStep() {}, setMessage() {},
  });
  review({ target: "local-n8n-stack", kind: "n8n-stack", state: "healthy" });
  assert.equal(element("done-provider-context").textContent, "Local n8n · owned stack");
  assert.equal(element("n8n-stack-removal").hidden, false);
  assert.equal(element("n8n-stack-removal-disclosure").open, true);
});

test("the private stack snapshot the server sends passes the page's real endpoint checks", () => {
  const normalize = runInNewContext(`${source("function readDashboardLoopbackPort(value)", "\nfunction normalizeDashboardBooleans")}
${source("function isSafeLocalN8nUrl(value)", "\nfunction normalizeBridgeDashboardSnapshot")}; normalizeStackDashboardSnapshot`, {
    URL, assertDashboardKeys() {}, DASHBOARD_ASSISTANT_MODES: new Set(["disabled", "sandbox", "sandbox-with-searxng"]),
    dashboardContractError: () => new Error("Invalid dashboard response"),
    normalizeDashboardBooleans: (value) => value, isSafeDockerDisplayName: (value) => typeof value === "string",
  });
  // Shape captured from GET /api/local/dashboard for a private stack with Code Sandbox on 2026-10-09.
  const project = `relmio-local-n8n-${"6b5e5640b6ce8f62f40ba4393904bb2c"}`;
  const fromServer = { target: "local-n8n-stack", publicAccess: "none", localUrl: "http://localhost:5679",
    ngrokPublicUrl: null, n8nContainerName: `${project}-n8n-1`, networkName: `${project}_edge`, assistantMode: "sandbox",
    endpoints: { n8nLocal: "http://localhost:5679", ngrokPublic: null, ngrokInspector: null },
    components: { n8n: true, ngrok: false, codeSandbox: true, searxng: false }, canResume: false, canRemove: true };
  const snapshot = normalize(fromServer);
  assert.equal(snapshot.endpoints.n8nLocal, "http://localhost:5679");
  assert.equal(snapshot.localUrl, "http://localhost:5679");
  // A localhost endpoint that does not match the validated localUrl is still refused.
  assert.throws(() => normalize({ ...fromServer, endpoints: { ...fromServer.endpoints, n8nLocal: "http://localhost:6000" } }),
    /Invalid dashboard response/u);
  // Older servers send a 127.0.0.1 endpoint and no localUrl.
  const legacy = { ...fromServer, endpoints: { ...fromServer.endpoints, n8nLocal: "http://127.0.0.1:5679/" } };
  delete legacy.localUrl;
  assert.equal(normalize(legacy).localUrl, "http://localhost:5679");
});

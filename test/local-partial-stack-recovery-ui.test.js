import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";

function createFakeElement({ disabled = false, value = "", textContent = "" } = {}) {
  const handlers = new Map();
  const attributes = new Map();
  return {
    attributes,
    checked: false,
    customValidity: "",
    dataset: {},
    disabled,
    handlers,
    hidden: false,
    textContent,
    type: "password",
    value,
    addEventListener(type, handler) {
      handlers.set(type, handler);
    },
    focus() {
      this.focused = true;
    },
    reportValidity() {
      return true;
    },
    setAttribute(name, attributeValue) {
      attributes.set(name, String(attributeValue));
    },
    setCustomValidity(message) {
      this.customValidity = message;
    },
  };
}

function deferred() {
  let reject;
  let resolve;
  const promise = new Promise((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, reject, resolve };
}

function extractLocalInstallHandler(script) {
  const helperStart = script.indexOf("function resetBasicAuthPasswordVisibility()");
  const helperEnd = script.indexOf("function showStep(step)", helperStart);
  const handlerStart = script.indexOf(
    'element("install-button").addEventListener("click"',
  );
  const handlerEnd = script.indexOf(
    'element("remove-bridge-confirm").addEventListener("change"',
    handlerStart,
  );
  assert.ok(helperStart >= 0 && helperEnd > helperStart);
  assert.ok(handlerStart >= 0 && handlerEnd > handlerStart);
  return {
    handler: script.slice(handlerStart, handlerEnd),
    helpers: script.slice(helperStart, helperEnd),
  };
}

function createInstallHarness(script, { target = "local-n8n-stack" } = {}) {
  const elements = new Map();
  const getElement = (id) => {
    if (!elements.has(id)) elements.set(id, createFakeElement());
    return elements.get(id);
  };
  const installButton = createFakeElement({ textContent: "Install locally" });
  const apiKey = createFakeElement({ disabled: target !== "openai-api" });
  const ngrokAuthtoken = createFakeElement({
    disabled: target !== "local-n8n-stack",
    value: "test-authtoken",
  });
  const basicAuthUsername = createFakeElement({
    disabled: target !== "local-n8n-stack",
    value: "relmio",
  });
  const basicAuthPassword = createFakeElement({
    disabled: target !== "local-n8n-stack",
    value: "password-for-test",
  });
  const generatePassword = createFakeElement({
    disabled: target !== "local-n8n-stack",
  });
  const togglePassword = createFakeElement({
    disabled: target !== "local-n8n-stack",
  });
  const backButton = createFakeElement({ textContent: "Back" });
  const intentionallyDisabledControl = createFakeElement({ disabled: true });
  const installControls = [
    installButton,
    apiKey,
    ngrokAuthtoken,
    basicAuthUsername,
    basicAuthPassword,
    generatePassword,
    togglePassword,
    backButton,
    intentionallyDisabledControl,
  ];
  const installPanel = createFakeElement();
  installPanel.querySelectorAll = () => installControls;
  const installConfirm = createFakeElement();
  installConfirm.checked = true;
  const installSettingsButton = createFakeElement();
  const installProgress = createFakeElement();
  installProgress.hidden = true;
  getElement("n8n-stack-removal").hidden = true;

  for (const [id, item] of [
    ["install-button", installButton],
    ["platform-api-key", apiKey],
    ["ngrok-authtoken", ngrokAuthtoken],
    ["ngrok-basic-auth-username", basicAuthUsername],
    ["ngrok-basic-auth-password", basicAuthPassword],
    ["generate-ngrok-basic-auth-password", generatePassword],
    ["toggle-ngrok-basic-auth-password", togglePassword],
    ["install-panel", installPanel],
    ["install-confirm", installConfirm],
    ["install-settings-button", installSettingsButton],
    ["install-progress", installProgress],
  ]) {
    elements.set(id, item);
  }

  const reviewedPlan = { target };
  const state = {
    installedTarget: null,
    operationBusy: false,
    operationButton: null,
    operationControlObserver: null,
    operationControlStates: [],
    operationLabel: "",
    operationProgressStartedAt: 0,
    operationProgressTimer: null,
    plan: reviewedPlan,
    planId: "reviewed-plan",
  };
  const request = deferred();
  const apiCalls = [];
  const messages = [];
  const shownErrors = [];
  const shownSteps = [];
  const renderedResults = [];
  const intervals = [];
  const clearedIntervals = [];
  const sandbox = {
    api: async (path, options) => {
      apiCalls.push({ options, path });
      return request.promise;
    },
    clearError() {},
    element: getElement,
    invalidatePlan() {
      state.plan = null;
      state.planId = null;
      installConfirm.checked = false;
      installSettingsButton.disabled = true;
    },
    isN8nAssistant: () => false,
    isN8nSidecar: () => false,
    isN8nStack: (candidate) => candidate === "local-n8n-stack",
    renderInstallResult: (result) => renderedResults.push(result),
    setMessage: (message) => messages.push(message),
    showError: (error) => shownErrors.push(error),
    showStep: (step) => shownSteps.push(step),
    state,
    validateLocalN8nStackCredentials: () => true,
    window: {
      clearInterval: (timer) => clearedIntervals.push(timer),
      setInterval: (callback, milliseconds) => {
        intervals.push({ callback, milliseconds });
        return intervals.length;
      },
    },
  };
  const { handler, helpers } = extractLocalInstallHandler(script);
  const installHandler = runInNewContext(
    `${helpers}\n${handler}\nelement("install-button").handlers.get("click");`,
    sandbox,
    { filename: "local-install-handler.vm.js", timeout: 1_000 },
  );

  return {
    apiCalls,
    basicAuthPassword,
    basicAuthUsername,
    clearedIntervals,
    element: getElement,
    elements,
    installButton,
    installControls,
    installHandler,
    intervals,
    messages,
    ngrokAuthtoken,
    renderedResults,
    request,
    reviewedPlan,
    shownErrors,
    shownSteps,
    state,
  };
}

function disabledStates(controls) {
  return controls.map((control) => control.disabled);
}

test("the local browser offers explicit removal only for a server-attested partial stack", async () => {
  const script = await readFile("src/ui/local.js", "utf8");
  const installStart = script.indexOf(
    'element("install-button").addEventListener("click"',
  );
  const partialBranch = script.indexOf(
    "error.managedPartialStack === true",
    installStart,
  );
  const retryBranch = script.indexOf("error.retryablePlan === true", installStart);
  const installFinally = script.indexOf("} finally {", retryBranch);

  assert.match(
    script,
    /error\.managedPartialStack = result\.managedPartialStack === true;/u,
  );
  assert.ok(installStart >= 0);
  assert.ok(partialBranch > installStart && partialBranch < retryBranch);
  assert.ok(retryBranch < installFinally);

  const partialRecovery = script.slice(partialBranch, retryBranch);
  assert.match(partialRecovery, /invalidatePlan\(\)/u);
  assert.match(
    partialRecovery,
    /state\.installedTarget = "local-n8n-stack"/u,
  );
  assert.match(
    partialRecovery,
    /element\("n8n-stack-removal"\)\.hidden = false/u,
  );
  assert.match(
    partialRecovery,
    /element\("remove-n8n-stack-confirm"\)\.checked = false/u,
  );
  assert.match(
    partialRecovery,
    /element\("remove-n8n-stack-button"\)\.disabled = true/u,
  );
  assert.match(partialRecovery, /showStep\(4\)/u);
  assert.match(partialRecovery, /showError\(error\)/u);

  const removalStart = script.indexOf(
    'element("remove-n8n-stack-button").addEventListener("click"',
  );
  const removalEnd = script.indexOf(
    'element("rotate-credential-button").addEventListener("click"',
    removalStart,
  );
  const removalHandler = script.slice(removalStart, removalEnd);
  assert.match(
    removalHandler,
    /state\.installedTarget !== "local-n8n-stack" \|\| !confirmation\.checked/u,
  );
  assert.match(removalHandler, /api\("\/api\/local\/n8n\/stack\/remove"/u);
  assert.match(removalHandler, /body: \{ confirmed: true \}/u);

  assert.doesNotMatch(
    partialRecovery,
    /error\.(?:message|safeMessage)|\.includes\(|\.match\(|\.test\(/u,
  );

  const nonPartialFailure = script.slice(retryBranch, installFinally);
  assert.match(nonPartialFailure, /invalidatePlan\(\)/u);
  assert.match(nonPartialFailure, /state\.installedTarget = null/u);
  assert.match(
    nonPartialFailure,
    /element\("n8n-stack-removal"\)\.hidden = true/u,
  );
});

test("restart detection maps strict safe states to normal flow, resume, partial recovery, or no automatic action", async () => {
  const script = await readFile("src/ui/local.js", "utf8");
  const recoveryStart = script.indexOf(
    "function showDetectedManagedLocalN8nStackRecovery()",
  );
  const recoveryEnd = script.indexOf("function renderTarget()", recoveryStart);
  const recovery = script.slice(recoveryStart, recoveryEnd);
  const stoppedStart = script.indexOf("function showStoppedManagedLocalN8nStack()");
  const stoppedEnd = script.indexOf("function renderTarget()", stoppedStart);
  const stopped = script.slice(stoppedStart, stoppedEnd);
  const refreshStart = script.indexOf("async function refreshDockerStatus()");
  const refreshEnd = script.indexOf("async function refreshProjectMeta()", refreshStart);
  const refresh = script.slice(refreshStart, refreshEnd);

  assert.ok(recoveryStart >= 0);
  assert.match(refresh, /result\.localN8nStackState/u);
  assert.match(
    refresh,
    /if \(state\.localN8nStackState === "partial"\) \{[\s\S]*showDetectedManagedLocalN8nStackRecovery\(\);[\s\S]*return;/u,
  );
  assert.match(
    refresh,
    /if \(state\.localN8nStackState === "stopped"\) \{[\s\S]*showStoppedManagedLocalN8nStack\(\);[\s\S]*return;/u,
  );
  assert.match(
    refresh,
    /if \(state\.localN8nStackState === "healthy"\) \{[\s\S]*updateReviewAvailability\(\);/u,
  );
  assert.match(
    refresh,
    /if \(state\.localN8nStackState === "unavailable"\) \{[\s\S]*No automatic resume or removal control is available/u,
  );
  assert.match(recovery, /invalidatePlan\(\)/u);
  assert.match(recovery, /state\.installedTarget = "local-n8n-stack"/u);
  assert.match(recovery, /element\("n8n-stack-removal"\)\.hidden = false/u);
  assert.match(
    recovery,
    /element\("remove-n8n-stack-confirm"\)\.checked = false/u,
  );
  assert.match(
    recovery,
    /element\("remove-n8n-stack-button"\)\.disabled = true/u,
  );
  assert.match(recovery, /showStep\(4\)/u);
  assert.match(
    `${refresh}\n${recovery}`,
    /owned partial local n8n \+ ngrok stack/u,
  );
  assert.match(`${refresh}\n${recovery}`, /partial/iu);
  assert.doesNotMatch(
    `${refresh}\n${recovery}`,
    /validateLocalN8nStackCredentials|ngrok-authtoken|\/api\/local\/plan/u,
  );
  assert.match(stopped, /element\("n8n-stack-resume"\)\.hidden = false/u);
  assert.match(stopped, /element\("n8n-stack-removal"\)\.hidden = true/u);
  assert.match(stopped, /existing containers only/u);

  const removalStart = script.indexOf(
    'element("remove-n8n-stack-button").addEventListener("click"',
  );
  const removalEnd = script.indexOf(
    'element("rotate-credential-button").addEventListener("click"',
    removalStart,
  );
  const removalHandler = script.slice(removalStart, removalEnd);
  assert.match(
    removalHandler,
    /state\.installedTarget !== "local-n8n-stack" \|\| !confirmation\.checked/u,
  );
  assert.match(removalHandler, /api\("\/api\/local\/n8n\/stack\/remove"/u);
  const resumeStart = script.indexOf(
    'element("resume-n8n-stack-button").addEventListener("click"',
  );
  const resumeEnd = script.indexOf(
    'element("remove-n8n-stack-button").addEventListener("click"',
    resumeStart,
  );
  const resumeHandler = script.slice(resumeStart, resumeEnd);
  assert.match(resumeHandler, /state\.localN8nStackState !== "stopped"/u);
  assert.match(resumeHandler, /api\("\/api\/local\/n8n\/stack\/resume"/u);
  assert.match(resumeHandler, /body: \{ confirmed: true \}/u);
  assert.doesNotMatch(resumeHandler, /\/api\/local\/n8n\/stack\/remove|\b(?:up|down|recreate)\b/u);
  assert.match(script, /element\("setup-another-local"\)\.href = createWizardUrl\("\/local"\)/u);
});

test("the install lifecycle suppresses duplicate submission and restores the reviewed controls after success", async () => {
  const script = await readFile("src/ui/local.js", "utf8");
  const harness = createInstallHarness(script, { target: "codex-app-server" });
  const before = disabledStates(harness.installControls);

  const firstAttempt = harness.installHandler({
    currentTarget: harness.installButton,
  });
  const duplicateAttempt = harness.installHandler({
    currentTarget: harness.installButton,
  });

  assert.equal(harness.apiCalls.length, 1);
  assert.equal(harness.state.operationBusy, true);
  assert.deepEqual(
    disabledStates(harness.installControls),
    harness.installControls.map(() => true),
  );
  assert.equal(harness.elements.get("install-panel").attributes.get("aria-busy"), "true");
  assert.equal(harness.elements.get("install-progress").hidden, false);
  assert.equal(harness.intervals.length, 1);
  await duplicateAttempt;

  harness.request.resolve({ target: "codex-app-server" });
  await firstAttempt;

  assert.equal(harness.apiCalls.length, 1);
  assert.equal(harness.state.operationBusy, false);
  assert.deepEqual(disabledStates(harness.installControls), before);
  assert.equal(harness.elements.get("install-panel").attributes.get("aria-busy"), "false");
  assert.equal(harness.elements.get("install-progress").hidden, true);
  assert.deepEqual(harness.clearedIntervals, [1]);
  assert.deepEqual(harness.renderedResults, [{ target: "codex-app-server" }]);
  assert.deepEqual(harness.shownSteps, [4]);
  assert.equal(harness.state.planId, null);
});

test("a safe stack credential rejection preserves the reviewed plan while clearing and reopening every secret field", async () => {
  const script = await readFile("src/ui/local.js", "utf8");
  const harness = createInstallHarness(script);
  const before = disabledStates(harness.installControls);
  harness.ngrokAuthtoken.setCustomValidity("previous invalid token");
  harness.basicAuthUsername.setCustomValidity("previous invalid username");
  harness.basicAuthPassword.setCustomValidity("previous invalid password");

  const attempt = harness.installHandler({ currentTarget: harness.installButton });
  assert.equal(harness.apiCalls.length, 1);
  assert.deepEqual(
    disabledStates(harness.installControls),
    harness.installControls.map(() => true),
  );
  harness.request.reject(
    Object.assign(new Error("The supplied credentials were rejected."), {
      retryablePlan: true,
    }),
  );
  await attempt;

  assert.equal(harness.state.planId, "reviewed-plan");
  assert.equal(harness.state.plan, harness.reviewedPlan);
  assert.deepEqual(harness.shownSteps, [3]);
  assert.deepEqual(disabledStates(harness.installControls), before);
  assert.equal(harness.ngrokAuthtoken.value, "");
  assert.equal(harness.basicAuthUsername.value, "");
  assert.equal(harness.basicAuthPassword.value, "");
  assert.equal(harness.ngrokAuthtoken.customValidity, "");
  assert.equal(harness.basicAuthUsername.customValidity, "");
  assert.equal(harness.basicAuthPassword.customValidity, "");
  assert.equal(harness.ngrokAuthtoken.disabled, false);
  assert.equal(harness.basicAuthUsername.disabled, false);
  assert.equal(harness.basicAuthPassword.disabled, false);
  assert.equal(harness.elements.get("n8n-stack-secrets").hidden, false);
  assert.match(
    harness.messages.at(-1),
    /Credentials were cleared for safety\. Re-enter all three credentials/u,
  );
  assert.equal(harness.apiCalls[0].options.body.ngrokAuthtoken, undefined);
  assert.equal(harness.apiCalls[0].options.body.basicAuthUsername, undefined);
  assert.equal(harness.apiCalls[0].options.body.basicAuthPassword, undefined);
});

test("a retry-safe rejected ngrok startup gives beginner guidance without retaining any credential", async () => {
  const script = await readFile("src/ui/local.js", "utf8");
  const harness = createInstallHarness(script);
  const attempt = harness.installHandler({ currentTarget: harness.installButton });
  harness.request.reject(
    Object.assign(new Error("The new n8n + ngrok stack did not start."), {
      retryablePlan: true,
      retryableNgrokSetup: true,
    }),
  );
  await attempt;
  assert.equal(harness.state.planId, "reviewed-plan");
  assert.equal(harness.ngrokAuthtoken.value, "");
  assert.equal(harness.basicAuthUsername.value, "");
  assert.equal(harness.basicAuthPassword.value, "");
  assert.equal(harness.elements.get("n8n-stack-secrets").hidden, false);
  assert.match(harness.messages.at(-1), /reserved ngrok hostname and active agent token/u);
});

test("a partial-stack removal requires the exact boolean attestation", async () => {
  const script = await readFile("src/ui/local.js", "utf8");
  const nonStrict = createInstallHarness(script);
  const nonStrictAttempt = nonStrict.installHandler({
    currentTarget: nonStrict.installButton,
  });
  nonStrict.request.reject(
    Object.assign(new Error("Untrusted partial-stack status."), {
      managedPartialStack: "true",
      retryablePlan: true,
    }),
  );
  await nonStrictAttempt;

  assert.equal(nonStrict.element("n8n-stack-removal").hidden, true);
  assert.equal(nonStrict.state.planId, "reviewed-plan");
  assert.deepEqual(nonStrict.shownSteps, [3]);

  const strict = createInstallHarness(script);
  const strictAttempt = strict.installHandler({
    currentTarget: strict.installButton,
  });
  const attestedError = Object.assign(new Error("Attested partial stack."), {
    managedPartialStack: true,
  });
  strict.request.reject(attestedError);
  await strictAttempt;

  assert.equal(strict.element("n8n-stack-removal").hidden, false);
  assert.equal(strict.element("remove-n8n-stack-confirm").checked, false);
  assert.equal(strict.element("remove-n8n-stack-button").disabled, true);
  assert.equal(strict.state.installedTarget, "local-n8n-stack");
  assert.equal(strict.state.planId, null);
  assert.deepEqual(strict.shownSteps, [4]);
  assert.deepEqual(strict.shownErrors, [attestedError]);
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

import {
  bindWizardNavigation,
  readWizardSession,
} from "../src/ui/session.js";
import { formatAuthUpdatedAt } from "../src/ui/time.js";
import { clearFieldError, createCredentialSshGuard, sameSshIdentity, setFieldError } from "../src/ui/ssh-form.js";

const rootIdentity = {
  host: "new.example", port: 22, username: "root",
  fingerprint: `SHA256:${"a".repeat(43)}`, authentication: "agent",
  privilege: "root", loginUid: 0, effectiveUid: 0, scope: "vps", generation: 1,
};

test("credential timestamps are formatted in the user's local date and time", () => {
  assert.equal(
    formatAuthUpdatedAt("2026-07-28T01:11:01.000Z", {
      locale: "en-US",
      timeZone: "Asia/Manila",
    }),
    "Jul 28, 2026, 9:11:01 AM",
  );
  assert.equal(formatAuthUpdatedAt("not-a-date"), null);
});



test("Responses API completion reminder stays until the user dismisses it", async () => {
  const script = await readFile("src/ui/app.js", "utf8");
  const dismissStart = script.indexOf("function dismissToast(toast)");
  const dismissEnd = script.indexOf("\nfunction resetFingerprint", dismissStart);
  const listenerStart = script.indexOf('for (const button of document.querySelectorAll("[data-dismiss-toast]")');
  const listenerEnd = script.indexOf('\nfor (const button of document.querySelectorAll(".back-button")', listenerStart);
  assert.ok(dismissStart >= 0 && dismissEnd > dismissStart, "missing toast dismissal helper");
  assert.ok(listenerStart >= 0 && listenerEnd > listenerStart, "missing dismissible notice binding");

  const listeners = new Map();
  const notice = { hidden: false };
  const dismissButton = {
    dataset: { dismissToast: "responses-api-notice" },
    addEventListener(_event, handler) {
      listeners.set("dismiss", handler);
    },
  };
  const timers = new WeakMap();
  vm.runInNewContext(`${script.slice(dismissStart, dismissEnd)}\n${script.slice(listenerStart, listenerEnd)}`, {
    document: {
      querySelectorAll(selector) {
        if (selector === "[data-dismiss-toast]") return [dismissButton];
        return [];
      },
    },
    element(id) {
      assert.equal(id, "responses-api-notice");
      return notice;
    },
    window: { clearTimeout() {} },
    toastTimers: timers,
    handleCopyClick() {},
  }, { filename: "responses-api-notice.vm.js", timeout: 1_000 });

  assert.equal(notice.hidden, false);
  listeners.get("dismiss")({ currentTarget: dismissButton });
  assert.equal(notice.hidden, true);
});

test("VPS disconnect clears only browser connection state after an exact server acknowledgement", async () => {
  const script = await readFile("src/ui/app.js", "utf8");
  const start = script.indexOf("async function disconnectVpsSession()");
  const end = script.indexOf(
    '\nelement("disconnect-vps-button")',
    start,
  );
  assert.ok(start >= 0 && end > start, "missing VPS disconnect boundary");
  const source = script.slice(start, end);
  const calls = [];
  const state = {
    discovery: { containers: [{}] },
    networks: { networks: ["n8n_default"] },
  };
  const elements = new Map([
    ["container-select", { replaceChildren: () => calls.push(["clear", "container-select"]) }],
    ["network-select", { replaceChildren: () => calls.push(["clear", "network-select"]) }],
    ["detected-vps-integration-management", { hidden: false }],
  ]);
  let response = { disconnected: true };
  const disconnectVpsSession = vm.runInNewContext(
    `${source}; disconnectVpsSession;`,
    {
      async api(path, options) {
        calls.push(["api", path, options]);
        return response;
      },
      element(id) {
        return elements.get(id);
      },
      invalidateReviewedPlan() {
        calls.push(["invalidate-plan"]);
      },
      resetFingerprint() {
        calls.push(["reset-fingerprint"]);
      },
      state,
    },
    { filename: "vps-disconnect.vm.js", timeout: 1_000 },
  );

  await disconnectVpsSession();
  assert.equal(calls[0][0], "api");
  assert.equal(calls[0][1], "/api/disconnect");
  assert.equal(
    JSON.stringify(calls[0][2]),
    JSON.stringify({ method: "POST", body: {} }),
  );
  assert.equal(state.discovery, null);
  assert.equal(state.networks, null);
  assert.equal(elements.get("detected-vps-integration-management").hidden, true);
  assert.ok(calls.some(([name]) => name === "invalidate-plan"));
  assert.ok(calls.some(([name]) => name === "reset-fingerprint"));

  calls.length = 0;
  state.discovery = { containers: [{}] };
  state.networks = { networks: ["n8n_default"] };
  response = { disconnected: true, unexpected: "field" };
  await assert.rejects(disconnectVpsSession(), /unexpected disconnect response/u);
  assert.equal(state.discovery.containers.length, 1);
  assert.equal(state.networks.networks.length, 1);
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], "api");
  assert.equal(calls[0][1], "/api/disconnect");
  assert.equal(
    JSON.stringify(calls[0][2]),
    JSON.stringify({ method: "POST", body: {} }),
  );
});

test("failed VPS install invalidates approval and returns to connection", async () => {
  const script = await readFile("src/ui/app.js", "utf8");
  const start = script.indexOf('element("install-button").addEventListener');
  const end = script.indexOf('\nfor (const input of document.querySelectorAll', start);
  assert.ok(start >= 0 && end > start, "missing VPS install handler");

  const calls = [];
  const handlers = new Map();
  const state = {
    planId: "reviewed-plan",
    reviewedIdentity: rootIdentity,
    managingDetectedIntegration: true,
    installAttempted: false,
  };
  const elements = new Map([
    ["install-button", { disabled: false, addEventListener: (_, handler) => handlers.set("install", handler) }],
    ["install-confirm", { checked: true }],
    ["container-select", { value: "n8n" }],
    ["network-select", { value: "n8n_default" }],
    ["manage-vps-searxng", { checked: false }],
  ]);
  const context = {
    state,
    sshSession: { adoptedIdentity: () => rootIdentity },
    sameSshIdentity,
    element: (id) => elements.get(id),
    isAssistantIntegration: () => false,
    clearError: () => calls.push(["clear-error"]),
    invalidateReviewedPlan() {
      calls.push(["invalidate-plan"]);
      state.planId = null;
      state.reviewedIdentity = null;
      elements.get("install-confirm").checked = false;
      elements.get("install-button").disabled = true;
    },
    setMessage: (message) => calls.push(["message", message]),
    showError: (error) => calls.push(["error", error.message]),
    showStep: (step) => calls.push(["step", step]),
    runOperation: async (_button, _label, work) => work(),
    api: async (path) => {
      calls.push(["api", path]);
      throw new Error("model verification failed");
    },
    renderImageModelsForN8n(models) {
      calls.push(["image-models", models]);
    },
  };
  vm.runInNewContext(script.slice(start, end), context, {
    filename: "vps-install-failure.vm.js",
    timeout: 1_000,
  });

  await handlers.get("install")({ currentTarget: elements.get("install-button") });

  assert.ok(calls.some(([name, value]) => name === "api" && value === "/api/install"));
  assert.ok(calls.some(([name, value]) => name === "step" && value === 2));
  assert.ok(calls.some(([name, value]) => name === "error" && value === "model verification failed"));
  assert.equal(state.planId, null);
  assert.equal(elements.get("install-confirm").checked, false);
  assert.equal(elements.get("install-button").disabled, true);
});

test("rejected VPS bridge credential returns to fresh sign-in without retrying the update", async () => {
  const script = await readFile("src/ui/app.js", "utf8");
  const start = script.indexOf("function clearEndedVpsConnectionState()");
  const end = script.indexOf('\nfor (const input of document.querySelectorAll', start);
  assert.ok(start >= 0 && end > start, "missing VPS credential recovery boundary");

  const calls = [];
  const handlers = new Map();
  const state = {
    planId: "reviewed-plan",
    reviewedIdentity: rootIdentity,
    fingerprint: "SHA256:reviewed",
    discovery: { containers: [{ name: "n8n" }] },
    networks: { networks: ["n8n_default"] },
    managingDetectedIntegration: true,
    installAttempted: false,
    oauthRetryBlocked: false,
  };
  const elements = new Map([
    ["install-button", { disabled: false, addEventListener: (_, handler) => handlers.set("install", handler) }],
    ["install-confirm", { checked: true }],
    ["container-select", { value: "n8n", replaceChildren: () => calls.push(["clear", "container-select"]) }],
    ["network-select", { value: "n8n_default", replaceChildren: () => calls.push(["clear", "network-select"]) }],
    ["manage-vps-searxng", { checked: false }],
    ["fingerprint-box", { hidden: false }],
    ["fingerprint-confirm", { checked: true }],
    ["password", { value: "secret", disabled: false }],
    ["connect-button", { disabled: false }],
    ["username", { disabled: false }],
    ["ssh-authentication", { disabled: false }],
    ["detected-vps-integration-management", { hidden: false }],
    ["auth-indicator", { classList: { remove: (name) => calls.push(["class-remove", name]) } }],
    ["auth-title", { textContent: "Local credential found" }],
    ["auth-detail", { textContent: "Continue uses it as-is." }],
    ["login-button", {
      disabled: true,
      textContent: "Sign in with ChatGPT",
      dataset: {},
      focus: () => calls.push(["focus", "login-button"]),
    }],
    ["signin-next", { disabled: false }],
  ]);
  const apiStart = script.indexOf("async function api(");
  const apiEnd = script.indexOf("\nfunction renderAuthUpdatedAt", apiStart);
  assert.ok(apiStart >= 0 && apiEnd > apiStart, "missing browser API helper");
  const api = vm.runInNewContext(`${script.slice(apiStart, apiEnd)}; api`, {
    token: "setup-token",
    sshSession: { async before() {}, async after() {} },
    fetch: async (path) => {
      calls.push(["api", path]);
      return {
        ok: false,
        async json() {
          return {
            error: "The VPS rejected the ChatGPT credential.",
            recoveryAction: "refresh-chatgpt-sign-in",
          };
        },
      };
    },
  }, { filename: "vps-install-api.vm.js", timeout: 1_000 });
  const context = {
    state,
    sshSession: { adoptedIdentity: () => rootIdentity },
    sameSshIdentity,
    selectChatGptSetup: () => calls.push(["select-chatgpt"]),
    setSignInLeads() {},
    setCredentialInputsEnabled(enabled) {
      elements.get("username").disabled = !enabled;
      elements.get("ssh-authentication").disabled = !enabled;
    },
    element: (id) => elements.get(id),
    isAssistantIntegration: () => false,
    clearError: () => calls.push(["clear-error"]),
    invalidateReviewedPlan() {
      calls.push(["invalidate-plan"]);
      state.planId = null;
      state.reviewedIdentity = null;
      elements.get("install-confirm").checked = false;
      elements.get("install-button").disabled = true;
    },
    setMessage: (message) => calls.push(["message", message]),
    showError: (error) => calls.push(["error", error.message]),
    showStep: (step) => calls.push(["step", step]),
    runOperation: async (_button, _label, work) => work(),
    api,
    renderImageModelsForN8n(models) {
      calls.push(["image-models", models]);
    },
  };
  vm.runInNewContext(script.slice(start, end), context, {
    filename: "vps-install-auth-recovery.vm.js",
    timeout: 1_000,
  });

  await handlers.get("install")({ currentTarget: elements.get("install-button") });

  assert.deepEqual(
    calls.filter(([name]) => name === "api").map(([, path]) => path),
    ["/api/install"],
  );
  assert.ok(calls.some(([name, value]) => name === "step" && value === 1));
  assert.equal(state.planId, null);
  assert.equal(state.fingerprint, null);
  assert.equal(state.discovery, null);
  assert.equal(state.networks, null);
  assert.equal(elements.get("install-confirm").checked, false);
  assert.equal(elements.get("install-button").disabled, true);
  assert.equal(elements.get("fingerprint-box").hidden, true);
  assert.equal(elements.get("fingerprint-confirm").checked, false);
  assert.equal(elements.get("password").value, "");
  assert.equal(elements.get("password").disabled, true);
  assert.equal(elements.get("connect-button").disabled, true);
  assert.equal(elements.get("username").disabled, true);
  assert.equal(elements.get("ssh-authentication").disabled, true);
  assert.equal(elements.get("detected-vps-integration-management").hidden, true);
  assert.equal(elements.get("login-button").disabled, false);
  assert.equal(elements.get("signin-next").disabled, true);
  assert.ok(calls.some(([name, value]) => name === "focus" && value === "login-button"));
  assert.equal(calls.some(([name, path]) => name === "api" && path === "/api/oauth/login"), false);

  calls.length = 0;
  state.planId = "another-reviewed-plan";
  state.reviewedIdentity = rootIdentity;
  state.oauthRetryBlocked = true;
  elements.get("install-confirm").checked = true;
  elements.get("install-button").disabled = false;
  elements.get("login-button").disabled = true;
  await handlers.get("install")({ currentTarget: elements.get("install-button") });
  assert.equal(elements.get("login-button").disabled, true);
  assert.equal(calls.some(([name]) => name === "focus"), false);
});

test("install API preserves only the exact fresh-sign-in recovery action", async () => {
  const script = await readFile("src/ui/app.js", "utf8");
  const start = script.indexOf("async function api(");
  const end = script.indexOf("\nfunction renderAuthUpdatedAt", start);
  assert.ok(start >= 0 && end > start, "missing browser API helper");
  let responseBody = {
    error: "request failed",
    recoveryAction: "refresh-chatgpt-sign-in",
    redirectUrl: "https://attacker.invalid/redirect",
  };
  const api = vm.runInNewContext(`${script.slice(start, end)}; api`, {
    token: "setup-token",
    sshSession: { async before() {}, async after() {} },
    fetch: async () => ({
      ok: false,
      async json() {
        return responseBody;
      },
    }),
  }, { filename: "vps-api-recovery-action.vm.js", timeout: 1_000 });

  const installError = await api("/api/install", { method: "POST", body: {} }).catch((error) => error);
  assert.equal(installError.recoveryAction, "refresh-chatgpt-sign-in");
  assert.equal(installError.redirectUrl, undefined);

  const getInstallError = await api("/api/install").catch((error) => error);
  assert.equal(getInstallError.recoveryAction, undefined);

  responseBody = {
    error: "refresh-chatgpt-sign-in",
    recoveryAction: "https://attacker.invalid/redirect",
  };
  const arbitraryActionError = await api("/api/install", { method: "POST", body: {} }).catch((error) => error);
  assert.equal(arbitraryActionError.recoveryAction, undefined);

  responseBody = {
    error: "request failed",
    recoveryAction: "refresh-chatgpt-sign-in",
  };
  const otherError = await api("/api/status").catch((error) => error);
  assert.equal(otherError.recoveryAction, undefined);
});

test("failed Docker network refresh stays on selection and invalidates approval", async () => {
  const script = await readFile("src/ui/app.js", "utf8");
  const start = script.indexOf('element("container-select").addEventListener');
  const end = script.indexOf('\nelement("review-button")', start);
  assert.ok(start >= 0 && end > start, "missing container network handler");

  const calls = [];
  const handlers = new Map();
  const state = { planId: "old-plan" };
  const elements = new Map([
    ["container-select", { value: "n8n", addEventListener: (_, handler) => handlers.set("networks", handler) }],
    ["install-confirm", { checked: true }],
    ["install-button", { disabled: false }],
  ]);
  const context = {
    state,
    element: (id) => elements.get(id),
    clearError: () => calls.push(["clear-error"]),
    invalidateReviewedPlan() {
      calls.push(["invalidate-plan"]);
      state.planId = null;
      elements.get("install-confirm").checked = false;
      elements.get("install-button").disabled = true;
    },
    runOperation: async (_select, _label, work) => work(),
    loadNetworks: async () => {
      throw new Error("network refresh failed");
    },
    renderNetworks: () => assert.fail("failed refresh must not render networks"),
    setMessage: (message) => calls.push(["message", message]),
    showError: (error) => calls.push(["error", error.message]),
    showStep: (step) => calls.push(["step", step]),
  };
  vm.runInNewContext(script.slice(start, end), context, {
    filename: "vps-network-failure.vm.js",
    timeout: 1_000,
  });

  await handlers.get("networks")({ currentTarget: elements.get("container-select") });

  assert.equal(calls.some(([name]) => name === "step"), false);
  assert.ok(calls.some(([name, value]) => name === "error" && value === "network refresh failed"));
  assert.equal(state.planId, null);
  assert.equal(elements.get("install-confirm").checked, false);
  assert.equal(elements.get("install-button").disabled, true);
});

test("VPS integration review can be rendered repeatedly without deleting its summary fields", async () => {
  const script = await readFile("src/ui/app.js", "utf8");
  const functionStart = script.indexOf("function replaceReviewItems(");
  const functionEnd = script.indexOf("const ASSISTANT_SANDBOX_IMAGE", functionStart);
  assert.ok(functionStart >= 0 && functionEnd > functionStart);

  const elements = new Map(
    [
      "review-intro",
      "review-network",
      "review-endpoint-label",
      "review-endpoint",
      "review-will-list",
      "review-wont-list",
      "install-confirm-copy",
      "install-button",
      "ssh-session",
      "ssh-review-identity",
      "review-build-list",
      "review-build-details",
    ].map((id) => [
      id,
      {
        children: [],
        dataset: {},
        textContent: "",
        replaceChildren(...children) {
          this.children = children;
        },
      },
    ]),
  );
  const context = {
    document: {
      createElement() {
        return { textContent: "" };
      },
      getElementById(id) {
        return elements.get(id) ?? null;
      },
    },
  };
  const review = vm.runInNewContext(
    `const state = { integrationKind: "sidecar", managingDetectedIntegration: false };
     const element = (id) => document.getElementById(id);
     ${script.slice(functionStart, functionEnd)}
     ({ state, renderIntegrationReview });`,
    { ...context, sshSession: { adoptedIdentity: () => rootIdentity }, sameSshIdentity },
  );

  review.renderIntegrationReview({
    endpointHostname: "n8n-openai-oauth",
    operationLockPath: "/docker/n8n-openai-oauth/.openai-oauth-operation.lock",
    temporaryBuildStatePath: "/docker/n8n-openai-oauth/.openai-oauth-operation.lock/buildx",
    networkName: "n8n_default",
  });
  review.state.integrationKind = "assistant";
  review.state.managingDetectedIntegration = true;
  review.renderIntegrationReview({ includeSearxng: true, networkName: "n8n_default" });
  review.state.integrationKind = "sidecar";
  review.renderIntegrationReview({
    endpointHostname: "n8n-openai-oauth",
    operationLockPath: "/docker/n8n-openai-oauth/.openai-oauth-operation.lock",
    temporaryBuildStatePath: "/docker/n8n-openai-oauth/.openai-oauth-operation.lock/buildx",
    networkName: "n8n_default",
  });

  assert.equal(elements.get("review-network").textContent, "n8n_default");
  assert.equal(elements.get("review-endpoint").textContent, "n8n-openai-oauth");
  assert.match(
    elements.get("review-will-list").children.map((item) => item.textContent).join(" "),
    /\/docker\/n8n-openai-oauth/u,
  );
  assert.throws(() => review.renderIntegrationReview({
    endpointHostname: "n8n-openai-oauth",
    networkName: "unexpected-network",
    operationLockPath: "/docker/n8n-openai-oauth/.openai-oauth-operation.lock",
    temporaryBuildStatePath: "/root/.docker/buildx",
  }), /build boundary/u);
  assert.equal(elements.get("review-network").textContent, "n8n_default");
});

test("review recipient follows the adopted guard identity and refuses missing or changed identity", async t => {
  const script = await readFile("src/ui/app.js", "utf8");
  const start = script.indexOf("function replaceReviewItems(");
  const end = script.indexOf("const ASSISTANT_SANDBOX_IMAGE", start);
  const confirmStart = script.indexOf('element("install-confirm").addEventListener("change"');
  const confirmEnd = script.indexOf("function clearEndedVpsConnectionState", confirmStart);
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      textContent: "", children: [], dataset: {}, hidden: true,
      checked: false, disabled: true,
      replaceChildren(...children) { this.children = children; },
      addEventListener(_event, handler) { this.handler = handler; },
    });
    return elements.get(id);
  };
  const previousDocument = globalThis.document;
  const previousFetch = globalThis.fetch;
  const document = { getElementById: element, createElement: () => ({ textContent: "" }) };
  globalThis.document = document;
  let current = rootIdentity;
  globalThis.fetch = async () => ({ ok: true, json: async () => current });
  t.after(() => {
    if (previousDocument === undefined) delete globalThis.document;
    else globalThis.document = previousDocument;
    if (previousFetch === undefined) delete globalThis.fetch;
    else globalThis.fetch = previousFetch;
  });
  const state = { integrationKind: "sidecar", managingDetectedIntegration: false, planId: "reviewed", reviewedIdentity: null };
  const invalidateReviewedPlan = () => {
    state.planId = null;
    state.reviewedIdentity = null;
    element("install-confirm").checked = false;
    element("install-button").disabled = true;
  };
  const guard = createCredentialSshGuard({ token: "fixture", onMismatch: invalidateReviewedPlan });
  const review = vm.runInNewContext(`
    const element = id => document.getElementById(id);
    ${script.slice(start, end)}
    ${script.slice(confirmStart, confirmEnd)}
    ({ renderIntegrationReview });`,
    { document, state, sshSession: guard, sameSshIdentity, invalidateReviewedPlan },
  );
  const plan = {
    endpointHostname: "n8n-openai-oauth", networkName: "n8n_default",
    operationLockPath: "/docker/n8n-openai-oauth/.openai-oauth-operation.lock",
    temporaryBuildStatePath: "/docker/n8n-openai-oauth/.openai-oauth-operation.lock/buildx",
  };
  assert.throws(() => review.renderIntegrationReview(plan), /verified administrative SSH identity/u);
  await guard.after("/api/ssh/connect", { identity: rootIdentity });
  element("ssh-session").textContent = "No authenticated VPS session.";
  review.renderIntegrationReview(plan);
  state.planId = "reviewed";
  assert.match(element("install-confirm-copy").textContent, /root@new\.example:22/u);
  assert.doesNotMatch(element("install-confirm-copy").textContent, /No authenticated VPS session/u);
  element("install-confirm").checked = true;
  element("install-confirm").handler({ currentTarget: element("install-confirm") });
  assert.equal(element("install-button").disabled, false);
  current = { ...rootIdentity, host: "replacement.example", generation: 2 };
  await assert.rejects(() => guard.before("/api/plan"), /authenticated VPS changed/u);
  assert.equal(state.planId, null);
  assert.equal(element("install-confirm").checked, false);
  assert.throws(() => review.renderIntegrationReview(plan), /verified administrative SSH identity/u);
  await guard.after("/api/ssh/connect", { identity: current });
  await guard.after("/api/disconnect", {});
  assert.throws(() => review.renderIntegrationReview(plan), /verified administrative SSH identity/u);
});

test("earlier-step navigation clears plan approval and focuses visible destination", async () => {
  const script = await readFile("src/ui/app.js", "utf8");
  const start = script.indexOf("const STEP_LABELS");
  const end = script.indexOf("async function api(", start);
  const elements = new Map();
  const focused = [];
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      textContent: "", hidden: false, checked: false, disabled: false,
      focus() { focused.push(id); }, scrollIntoView() {},
      setAttribute() {}, removeAttribute() {},
    });
    return elements.get(id);
  };
  const panels = [1, 2, 3, 4, 5].map(step => ({
    dataset: { step: String(step) }, hidden: step !== 4, scrollTop: 50,
    querySelector: () => element(`heading-${step}`),
  }));
  const markers = [1, 2, 3, 4, 5].map(step => ({
    dataset: { stepMarker: String(step) },
    classList: { toggle() {} }, setAttribute() {}, removeAttribute() {},
  }));
  const buttons = [1, 2, 3, 4, 5].map(step => ({ dataset: { stepTarget: String(step) }, disabled: true }));
  const document = {
    body: { dataset: {} },
    getElementById: element,
    querySelectorAll: selector => selector === "[data-step]" ? panels : selector === "[data-step-marker]" ? markers : buttons,
    querySelector: () => null,
  };
  const state = { step: 4, operationBusy: false, planId: "reviewed", installAttempted: false };
  const wizard = vm.runInNewContext(`
    const element = id => document.getElementById(id);
    function focusVisible(target) { target.focus({ preventScroll: true }); target.scrollIntoView(); }
    ${script.slice(start, end)}
    ({ showStep, goToEarlierStep });`, {
    document, state, dismissToast() {}, clearError() {},
    invalidateReviewedPlan() {
      state.planId = null;
      element("install-confirm").checked = false;
      element("install-button").disabled = true;
    },
    setMessage() {},
  });
  element("install-confirm").checked = true;
  wizard.goToEarlierStep(3);
  assert.equal(state.step, 3);
  assert.equal(state.planId, null);
  assert.equal(element("install-confirm").checked, false);
  assert.equal(element("install-button").disabled, true);
  assert.equal(panels[2].hidden, false);
  assert.equal(panels[3].hidden, true);
  assert.equal(focused.at(-1), "heading-3");
  assert.equal(buttons[1].disabled, false);
  state.operationBusy = true;
  wizard.goToEarlierStep(1);
  assert.equal(state.step, 3);
  state.operationBusy = false;
  wizard.showStep(5);
  wizard.goToEarlierStep(1);
  assert.equal(state.step, 5);
  assert.equal(buttons.every(button => button.disabled), true);
});

test("route selection exposes ChatGPT setup and restores chooser focus", async () => {
  const script = await readFile("src/ui/app.js", "utf8");
  const start = script.indexOf("function focusVisible(");
  const end = script.indexOf("function dismissToast(", start);
  const focused = [];
  const nodes = new Map();
  const element = id => {
    if (!nodes.has(id)) nodes.set(id, {
      hidden: id === "chatgpt-setup", attributes: new Map(),
      setAttribute(name, value) { this.attributes.set(name, value); },
      addEventListener(name, listener) { this[name] = listener; },
      focus() { focused.push(id); }, scrollIntoView() {},
    });
    return nodes.get(id);
  };
  const state = { step: 1, operationBusy: false };
  vm.runInNewContext(script.slice(start, end), {
    element, state, clearError() {}, showStep() {},
  });
  element("openai-vps-route").click();
  assert.equal(element("setup-choices").hidden, true);
  assert.equal(element("chatgpt-setup").hidden, false);
  assert.equal(element("openai-vps-route").attributes.get("aria-expanded"), "true");
  assert.equal(focused.at(-1), "signin-title");
  element("change-setup-button").click();
  assert.equal(element("setup-choices").hidden, false);
  assert.equal(element("chatgpt-setup").hidden, true);
  assert.equal(element("openai-vps-route").attributes.get("aria-expanded"), "false");
  assert.equal(focused.at(-1), "openai-vps-route");
  state.operationBusy = true;
  element("openai-vps-route").click();
  assert.equal(element("chatgpt-setup").hidden, true);
});

test("fingerprint check validates address and port before unlocking authentication", async () => {
  const script = await readFile("src/ui/app.js", "utf8");
  const start = script.indexOf('element("fingerprint-button").addEventListener');
  const end = script.indexOf('element("host").addEventListener("input"', start);
  const nodes = new Map();
  const focus = [];
  const document = { activeElement: null };
  const element = id => {
    if (!nodes.has(id)) nodes.set(id, {
      value: "", checked: false, disabled: true, hidden: true, attributes: new Map([["aria-describedby", `${id}-hint`]]),
      valid: true, addEventListener(name, handler) { this[name] = handler; },
      checkValidity() { return this.valid; },
      reportValidity() { this.reported = true; },
      getAttribute(name) { return this.attributes.get(name) ?? null; },
      setAttribute(name, value) { this.attributes.set(name, value); },
      removeAttribute(name) { this.attributes.delete(name); },
      focus() { focus.push(id); document.activeElement = this; }, scrollIntoView() {},
    });
    return nodes.get(id);
  };
  const calls = [];
  const state = { fingerprint: null, operationBusy: false, operationOwner: 0 };
  const context = {
    document, element, state, clearError() {}, invalidateReviewedPlan() {}, clearFieldError,
    runOperation: async (button, _label, work) => {
      state.operationOwner++;
      document.activeElement = element("operation-progress");
      try { return await work(); }
      finally { document.activeElement = button; }
    },
    api: async (path, options) => {
      calls.push([path, options.body]);
      return { fingerprint: rootIdentity.fingerprint };
    },
    focusVisible: input => { input.focus(); input.scrollIntoView(); },
    setCredentialInputsEnabled: enabled => {
      element("username").disabled = !enabled;
      element("ssh-authentication").disabled = !enabled;
    },
    sshAuthentication: { sync({ trusted }) { element("password").disabled = !trusted; } },
    setMessage() {}, showError(error) { throw error; },
  };
  vm.runInNewContext(script.slice(start, end), context);
  element("host").value = "new.example";
  element("port").value = "0";
  element("port").valid = false;
  await element("fingerprint-button").click({ currentTarget: element("fingerprint-button") });
  assert.equal(calls.length, 0);
  assert.equal(element("port").reported, true);
  assert.equal(focus.at(-1), "port");
  assert.equal(element("port").getAttribute("aria-invalid"), "true");
  element("port").value = "22";
  element("port").valid = true;
  await element("fingerprint-button").click({ currentTarget: element("fingerprint-button") });
  assert.equal(calls[0][0], "/api/ssh/fingerprint");
  assert.equal(element("port").getAttribute("aria-invalid"), null);
  assert.equal(element("port").getAttribute("aria-describedby"), "port-hint");
  assert.equal(element("fingerprint-box").hidden, false);
  assert.equal(focus.at(-1), "fingerprint-confirm");
  assert.equal(element("username").disabled, true);
  element("fingerprint-confirm").checked = true;
  element("fingerprint-confirm").change({ currentTarget: element("fingerprint-confirm") });
  assert.equal(element("username").disabled, false);
  assert.equal(element("ssh-authentication").disabled, false);
  element("fingerprint-confirm").checked = false;
  element("fingerprint-confirm").change({ currentTarget: element("fingerprint-confirm") });
  assert.equal(element("username").disabled, true);
});

test("wizard errors and completed cancellation move focus to visible recovery controls", async () => {
  const script = await readFile("src/ui/app.js", "utf8");
  const errorStart = script.indexOf("function showError(");
  const errorEnd = script.indexOf("function clearError(", errorStart);
  const stopStart = script.indexOf("function setOAuthStopControlVisible(");
  const stopEnd = script.indexOf("function blockOAuthRetry(", stopStart);
  const focused = [];
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, {
      hidden: id === "operation-progress", disabled: false, dataset: {},
      textContent: "Stop ChatGPT sign-in",
      setAttribute() {},
      removeAttribute() {},
      focus() { focused.push(id); }, scrollIntoView() {},
    });
    return elements.get(id);
  };
  const state = { oauthCancellationMessage: "Sign-in stopped", operationBusy: false, oauthRetryBlocked: false };
  const document = { activeElement: null };
  const ui = vm.runInNewContext(`
    function focusVisible(target) { target.focus({ preventScroll: true }); target.scrollIntoView(); }
    ${script.slice(errorStart, errorEnd)}
    ${script.slice(stopStart, stopEnd)}
    ({ showError, setOAuthStopControlVisible, finishOAuthCancellation });`, {
    element, state, document,
    errorMessage: element("global-error-text"), errorBox: element("global-error"),
    setMessage: text => { element("global-message-text").textContent = text; },
  });
  ui.showError(new Error("connection failed"));
  assert.equal(element("global-error").hidden, false);
  assert.equal(focused.at(-1), "global-error");
  element("global-error").hidden = true;
  document.activeElement = element("stop-login-button");
  element("operation-progress").hidden = false;
  ui.setOAuthStopControlVisible(false);
  assert.equal(focused.at(-1), "operation-progress");
  element("operation-progress").hidden = true;
  ui.finishOAuthCancellation();
  assert.equal(element("global-message-text").textContent, "Sign-in stopped");
  assert.equal(focused.at(-1), "login-button");
  state.oauthCancellationMessage = "Stopped again";
  state.oauthRetryBlocked = true;
  ui.finishOAuthCancellation();
  assert.equal(focused.at(-1), "login-button");
});

test("server-rejected connection fields are marked invalid until the person edits them", async () => {
  const script = await readFile("src/ui/app.js", "utf8");
  const errorStart = script.indexOf("function showError(");
  const errorEnd = script.indexOf("function clearError(", errorStart);
  const inputStart = script.indexOf('for (const id of ["host", "port", "username"])');
  const inputEnd = script.indexOf('element("password").addEventListener("input"', inputStart);
  assert.ok(errorStart >= 0 && errorEnd > errorStart && inputStart >= 0 && inputEnd > inputStart);
  const nodes = new Map();
  const element = id => {
    if (!nodes.has(id)) nodes.set(id, {
      hidden: true, textContent: "", listeners: new Map(),
      attributes: new Map([["aria-describedby", `${id}-hint`]]),
      getAttribute(name) { return this.attributes.get(name) ?? null; },
      setAttribute(name, value) { this.attributes.set(name, value); },
      removeAttribute(name) { this.attributes.delete(name); },
      addEventListener(name, listener) { this.listeners.set(name, listener); },
      focus() {}, scrollIntoView() {},
    });
    return nodes.get(id);
  };
  const ui = vm.runInNewContext(`
    function focusVisible(target) { target.focus({ preventScroll: true }); target.scrollIntoView(); }
    ${script.slice(errorStart, errorEnd)}
    ${script.slice(inputStart, inputEnd)}
    ({ showError });`, {
    element, setFieldError, clearFieldError,
    errorMessage: element("global-error-text"), errorBox: element("global-error"),
  });
  const described = id => element(id).getAttribute("aria-describedby");

  ui.showError(new Error("Connection refused."));
  assert.equal(element("host").getAttribute("aria-invalid"), null);
  ui.showError(new Error("Hostname is invalid."));
  assert.equal(element("host").getAttribute("aria-invalid"), "true");
  assert.equal(described("host"), "host-hint global-error-text");
  assert.equal(element("global-error-text").textContent, "Hostname is invalid.");
  ui.showError(new Error("Port is invalid."));
  assert.equal(element("port").getAttribute("aria-invalid"), "true");
  element("host").listeners.get("input")();
  assert.equal(element("host").getAttribute("aria-invalid"), null);
  assert.equal(described("host"), "host-hint");
  assert.equal(element("port").getAttribute("aria-invalid"), "true");
});

test("a running setup operation marks the step panel busy and leaves the progress rail free", async () => {
  const script = await readFile("src/ui/app.js", "utf8");
  const start = script.indexOf("const OPERATION_INTERACTIVE_SELECTOR");
  const end = script.indexOf("\nfunction showStep(step)", start);
  assert.ok(start >= 0 && end > start);
  const nodes = new Map();
  const element = id => {
    if (!nodes.has(id)) nodes.set(id, {
      id, hidden: id === "operation-progress", textContent: "", dataset: {},
      attributes: new Map(id === "setup-steps" ? [["aria-busy", "false"]] : []),
      children: [],
      setAttribute(name, value) { this.attributes.set(name, value); },
      getAttribute(name) { return this.attributes.get(name) ?? null; },
      removeAttribute(name) { this.attributes.delete(name); },
      focus() {},
      querySelectorAll() { return []; },
    });
    return nodes.get(id);
  };
  const progress = element("operation-progress");
  const steps = element("setup-steps");
  const main = element("main-content");
  progress.parent = element("setup-rail");
  steps.parent = main;
  const state = { operationBusy: false, operationOwner: 0, step: 2, fingerprint: null };
  const ui = vm.runInNewContext(`
    ${script.slice(start, end)}
    ({ startOperation, stopOperation });`, {
    element, state, document: {
      body: { dataset: {} },
      activeElement: element("review-button"),
      querySelectorAll: () => [],
      addEventListener() {},
    },
    focusVisible() {},
    sshAuthentication: { sync() {} },
    setCredentialInputsEnabled() {},
    updateStepNavigation() {},
    MutationObserver: class { observe() {} disconnect() {} },
    window: { setInterval() { return 1; }, clearInterval() {} },
  });
  assert.equal(ui.startOperation(element("review-button"), "Preparing plan…"), true);
  assert.equal(steps.getAttribute("aria-busy"), "true");
  assert.equal(main.getAttribute("aria-busy"), null);
  assert.equal(progress.getAttribute("aria-busy"), null);
  assert.equal(progress.parent.getAttribute("aria-busy"), null);
  ui.stopOperation(element("review-button"), state.operationOwner);
  assert.equal(steps.getAttribute("aria-busy"), "false");
  assert.equal(main.getAttribute("aria-busy"), null);
});

test("VPS Assistant result validation executes before any result DOM mutation", async () => {
  const script = await readFile("src/ui/app.js", "utf8");
  const functionStart = script.indexOf("const ASSISTANT_SANDBOX_IMAGE");
  const functionEnd = script.indexOf("async function loadNetworks", functionStart);
  assert.ok(functionStart >= 0 && functionEnd > functionStart);

  const elements = new Map(
    [
      "assistant-result-sandbox-url",
      "assistant-result-sandbox-key",
      "assistant-result-key-row",
      "assistant-result-searxng-row",
      "assistant-result-searxng-url",
      "assistant-result-settings",
      "assistant-result-key-note",
    ].map((id) => [id, { hidden: false, textContent: "unchanged" }]),
  );
  const assistantUi = vm.runInNewContext(
    `const element = (id) => document.getElementById(id);
     ${script.slice(functionStart, functionEnd)}
     ({ validateAssistantInstallResult, renderAssistantResult });`,
    {
      document: {
        getElementById(id) {
          return elements.get(id) ?? null;
        },
      },
    },
  );
  const sandboxUrl = `http://relmio-ai-sandbox-${"a".repeat(32)}:8080`;
  const searxngUrl = `http://relmio-ai-searxng-${"b".repeat(32)}:8080`;
  const sandboxImage =
    "ghcr.io/n8n-io/n8n-sandbox-service-sandbox:1.1.0@sha256:16f62fb90a4ce61ef74925f62ea76bb11eb2a5598888b7c0651100c7944ed2d8";
  const sandboxApiKey = "A".repeat(43);
  const settingsFor = ({ key, searchUrl } = {}) => ({
    N8N_INSTANCE_AI_SANDBOX_ENABLED: "true",
    N8N_INSTANCE_AI_SANDBOX_PROVIDER: "n8n-sandbox",
    N8N_INSTANCE_AI_SANDBOX_IMAGE: sandboxImage,
    N8N_SANDBOX_SERVICE_URL: sandboxUrl,
    ...(key ? { N8N_SANDBOX_SERVICE_API_KEY: key } : {}),
    ...(searchUrl ? { N8N_INSTANCE_AI_SEARXNG_URL: searchUrl } : {}),
  });

  const installed = assistantUi.renderAssistantResult({
    deploymentMode: "installed",
    includeSearxng: true,
    n8nSettings: settingsFor({ key: sandboxApiKey, searchUrl: searxngUrl }),
    sandboxApiKey,
    sandboxUrl,
    searxngUrl,
  });
  assert.equal(installed.includeSearxng, true);
  assert.equal(elements.get("assistant-result-key-row").hidden, false);
  assert.equal(elements.get("assistant-result-searxng-row").hidden, false);
  assert.equal(elements.get("assistant-result-sandbox-key").textContent, sandboxApiKey);

  assistantUi.renderAssistantResult({
    deploymentMode: "updated",
    includeSearxng: false,
    n8nSettings: settingsFor(),
    sandboxApiKey: null,
    sandboxUrl,
  });
  assert.equal(elements.get("assistant-result-key-row").hidden, true);
  assert.equal(elements.get("assistant-result-searxng-row").hidden, true);
  assert.equal(elements.get("assistant-result-sandbox-key").textContent, "");

  const beforeInvalid = [...elements].map(([id, value]) => [
    id,
    { hidden: value.hidden, textContent: value.textContent },
  ]);
  assert.throws(
    () =>
      assistantUi.renderAssistantResult({
        deploymentMode: "updated",
        includeSearxng: false,
        n8nSettings: { ...settingsFor(), UNREVIEWED_SETTING: "unsafe" },
        sandboxApiKey: null,
        sandboxUrl,
      }),
    /invalid n8n settings/u,
  );
  assert.deepEqual(
    [...elements].map(([id, value]) => [
      id,
      { hidden: value.hidden, textContent: value.textContent },
    ]),
    beforeInvalid,
  );
  assert.throws(
    () =>
      assistantUi.validateAssistantInstallResult({
        deploymentMode: "installed",
        includeSearxng: false,
        n8nSettings: settingsFor({ key: "short" }),
        sandboxApiKey: "short",
        sandboxUrl,
      }),
    /invalid Assistant result/u,
  );
  assert.throws(
    () =>
      assistantUi.validateAssistantInstallResult({
        deploymentMode: "updated",
        includeSearxng: false,
        n8nSettings: settingsFor(),
        sandboxApiKey: null,
        sandboxUrl: "https://example.test/sandbox",
      }),
    /invalid Code Sandbox URL/u,
  );
});

test("wizard session rejects query capabilities and reads only clean-entry history state", () => {
  const sessionToken = "A".repeat(43);
  const replacements = [];
  const browserWindow = {
    history: {
      state: { relmioWizardSession: "B".repeat(43), unrelated: true },
      replaceState(nextState, title, pathname) {
        this.state = nextState;
        replacements.push({ nextState, title, pathname });
      },
    },
    location: {
      hash: "#dashboard-overview",
      pathname: "/local",
      search: `?session=${sessionToken}`,
    },
  };

  assert.equal(readWizardSession(browserWindow), "B".repeat(43));
  assert.deepEqual(browserWindow.history.state, {
    relmioWizardSession: "B".repeat(43),
  });
  assert.deepEqual(JSON.parse(JSON.stringify(replacements.at(-1))), {
    nextState: { relmioWizardSession: "B".repeat(43) },
    title: "",
    pathname: "/local#dashboard-overview",
  });
});

test("wizard session rejects malformed query capabilities and sanitizes history state", () => {
  const sessionToken = "C".repeat(43);

  for (const search of [
    `?session=${sessionToken}&extra=1`,
    `?extra=1&session=${sessionToken}`,
    `?session=${sessionToken.slice(0, 42)}`,
    `?session=${sessionToken}%20`,
    `?session=${"!".repeat(43)}`,
  ]) {
    const browserWindow = {
      history: {
        state: null,
        replaceState(nextState, title, pathname) {
          this.state = nextState;
          assert.equal(title, "");
          assert.equal(pathname, "/assistant");
        },
      },
      location: { hash: "", pathname: "/assistant", search },
    };

    assert.equal(readWizardSession(browserWindow), null, search);
    assert.equal(browserWindow.history.state, null, search);
  }

  const browserWindow = {
    history: {
      state: { relmioWizardSession: sessionToken, unrelated: true },
      replaceState(nextState) {
        this.state = nextState;
      },
    },
    location: { hash: "", pathname: "/", search: "" },
  };
  assert.equal(readWizardSession(browserWindow), sessionToken);
  assert.deepEqual(browserWindow.history.state, {
    relmioWizardSession: sessionToken,
  });

  browserWindow.history.state = { relmioWizardSession: 42 };
  assert.equal(readWizardSession(browserWindow), null);
  assert.equal(browserWindow.history.state, null);
});

test("fragment navigation preserves the session across reload and back-forward entries", () => {
  const sessionToken = "H".repeat(43);
  const listeners = new Map();
  const browserWindow = {
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    history: {
      state: { relmioWizardSession: sessionToken },
      replaceState(nextState, title, path) {
        this.state = nextState;
        this.lastReplacement = { nextState, title, path };
      },
    },
    location: { hash: "", pathname: "/local", search: "" },
  };

  assert.equal(readWizardSession(browserWindow), sessionToken);
  assert.equal(typeof listeners.get("hashchange"), "function");

  browserWindow.location.hash = "#dashboard-activity";
  browserWindow.history.state = null;
  listeners.get("hashchange")();
  assert.deepEqual(browserWindow.history.state, {
    relmioWizardSession: sessionToken,
  });
  assert.equal(
    readWizardSession({
      history: browserWindow.history,
      location: browserWindow.location,
    }),
    sessionToken,
  );

  browserWindow.location.hash = "";
  browserWindow.history.state = null;
  listeners.get("hashchange")();
  assert.deepEqual(browserWindow.history.lastReplacement, {
    nextState: { relmioWizardSession: sessionToken },
    title: "",
    path: "/local",
  });
});

test("browser transfer bootstrap clears window.name before exchange and stores only the returned session", async () => {
  const script = await readFile("src/ui/session-bootstrap.js", "utf8");
  const transferId = "T".repeat(43);
  const secret = "S".repeat(43);
  const sessionToken = "W".repeat(43);
  const calls = [];
  const replacements = [];
  let resolveTransfer;
  const browserWindow = {
    name: `relmio-v1.${transferId}.${secret}`,
    location: { hash: "", pathname: "/local", search: "" },
    history: {
      replaceState(nextState, title, path) {
        replacements.push({ nextState, title, path });
      },
    },
  };
  browserWindow.window = browserWindow;
  const context = vm.createContext({
    window: browserWindow,
    fetch: (...args) => {
      assert.equal(browserWindow.name, "");
      calls.push(args);
      return new Promise((resolve) => { resolveTransfer = resolve; });
    },
    JSON,
    Promise,
  });

  vm.runInContext(script, context);
  assert.equal(browserWindow.name, "");
  assert.equal(calls.length, 1);
  browserWindow.location.hash = "#dashboard";
  browserWindow.history.state = null;
  resolveTransfer({
    ok: true,
    async json() { return { sessionToken }; },
  });
  await browserWindow.__relmioWizardSessionReady;
  assert.equal(calls[0][0], "/__relmio/browser/transfer");
  assert.deepEqual(JSON.parse(calls[0][1].body), {
    route: "/local",
    transferId,
    secret,
  });
  assert.deepEqual(JSON.parse(JSON.stringify(replacements.at(-1))), {
    nextState: { relmioWizardSession: sessionToken },
    title: "",
    path: "/local#dashboard",
  });
});

test("browser transfer bootstrap clears malformed window.name without making a request", async () => {
  const script = await readFile("src/ui/session-bootstrap.js", "utf8");
  for (const name of ["", "other", `relmio-v1.${"A".repeat(43)}.short`]) {
    let requests = 0;
    const browserWindow = {
      name,
      location: { hash: "", pathname: "/local", search: "" },
      history: { replaceState() {} },
    };
    browserWindow.window = browserWindow;
    vm.runInContext(script, vm.createContext({
      window: browserWindow,
      fetch: async () => { requests += 1; },
      JSON,
      Promise,
    }));
    assert.equal(browserWindow.name, "");
    await browserWindow.__relmioWizardSessionReady;
    assert.equal(requests, 0);
  }
});

test("history restores the matching wizard document and never resumes a cached credential screen", () => {
  const listeners = new Map();
  let reloads = 0;
  const browserWindow = {
    addEventListener(type, listener) { listeners.set(type, listener); },
    history: {
      state: { relmioWizardSession: "H".repeat(43) },
      replaceState(state) { this.state = state; },
    },
    location: { pathname: "/supergrok-vps", hash: "", reload() { reloads++; } },
  };
  readWizardSession(browserWindow);
  listeners.get("popstate")();
  listeners.get("pageshow")({ persisted: false });
  assert.equal(reloads, 0);
  browserWindow.location.pathname = "/";
  listeners.get("popstate")();
  assert.equal(reloads, 1);
  listeners.get("pageshow")({ persisted: true });
  assert.equal(reloads, 2);
  assert.deepEqual(browserWindow.history.state, { relmioWizardSession: "H".repeat(43) });
});

test("wizard navigation keeps the capability in same-tab history and all link URLs token-free", () => {
  const sessionToken = "D".repeat(43);
  const listeners = new Map();
  const attributes = new Map();
  const link = {
    target: "",
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    getAttribute(name) {
      return attributes.get(name) ?? null;
    },
    setAttribute(name, value) {
      attributes.set(name, value);
    },
  };
  const pushed = [];
  let reloads = 0;
  const browserWindow = {
    history: {
      pushState(nextState, title, pathname) {
        pushed.push({ nextState, title, pathname });
      },
    },
    location: {
      reload() {
        reloads += 1;
      },
    },
  };

  bindWizardNavigation(link, "/local", sessionToken, browserWindow);
  assert.equal(link.getAttribute("href"), "/local");
  assert.doesNotMatch(link.getAttribute("href"), /session|[?]/u);

  let prevented = false;
  listeners.get("click")({
    altKey: false,
    button: 0,
    ctrlKey: false,
    defaultPrevented: false,
    metaKey: false,
    preventDefault() {
      prevented = true;
    },
    shiftKey: false,
  });
  assert.equal(prevented, true);
  assert.deepEqual(pushed, [{
    nextState: { relmioWizardSession: sessionToken },
    title: "",
    pathname: "/local",
  }]);
  assert.equal(reloads, 1);

  for (const override of [
    { ctrlKey: true },
    { metaKey: true },
    { shiftKey: true },
    { altKey: true },
    { button: 1 },
  ]) {
    prevented = false;
    listeners.get("click")({
      altKey: false,
      button: 0,
      ctrlKey: false,
      defaultPrevented: false,
      metaKey: false,
      preventDefault() {
        prevented = true;
      },
      shiftKey: false,
      ...override,
    });
    assert.equal(prevented, false);
  }
  link.target = "_blank";
  listeners.get("click")({
    altKey: false,
    button: 0,
    ctrlKey: false,
    defaultPrevented: false,
    metaKey: false,
    preventDefault() {
      prevented = true;
    },
    shiftKey: false,
  });
  assert.equal(pushed.length, 1);
  assert.equal(reloads, 1);
});

test("private wizard capability stays out of URLs and persistent browser storage", async () => {
  for (const path of ["src/ui/app.js", "src/ui/assistant.js", "src/ui/session.js"]) {
    const script = await readFile(path, "utf8");
    assert.doesNotMatch(script, /[?]session=/u);
    assert.doesNotMatch(
      script,
      /\blocalStorage\b|\bsessionStorage\b|\bindexedDB\b|document\.cookie/u,
    );
  }
});


test("VPS reload rehydrates and completes the server-owned pending OAuth attempt", async () => {
  const app = await readFile("src/ui/app.js", "utf8");
  const start = app.indexOf("async function recoverPendingOAuthAttempt()");
  const end = app.indexOf("\nasync function initializeVpsWizard()", start);
  assert.ok(start >= 0 && end > start, "missing OAuth reload recovery boundary");
  const source = app.slice(start, end);
  const calls = [];
  const state = {
    oauthAttemptId: null,
    oauthCancellationMessage: "",
    oauthLoginGeneration: 4,
    oauthLoginWindow: null,
    oauthRetryBlocked: false,
  };
  const loginLink = {
    hidden: false,
    removeAttribute(name) {
      calls.push(["remove-attribute", name]);
    },
  };
  const context = {
    state,
    async api(path) {
      calls.push(["api", path]);
      if (path === "/api/oauth/status") {
        return { attemptId: "a1b2c3d4-1234", status: "pending" };
      }
      if (path === "/api/status") {
        return { authExists: true, authUpdatedAt: "2026-09-04T00:00:00.000Z" };
      }
      throw new Error(`Unexpected path: ${path}`);
    },
    blockOAuthRetry() {
      calls.push(["block-retry"]);
    },
    selectChatGptSetup() {},
    finishOAuthCancellation() {},
    element(id) {
      assert.equal(id, "login-link");
      return loginLink;
    },
    renderAuthStatus(status, options) {
      calls.push(["render-auth", status.authExists, options.fresh]);
    },
    async runOperation(trigger, label, work, options) {
      calls.push(["operation", trigger, label, options.allowedSelector]);
      return work();
    },
    setMessage(message) {
      calls.push(["message", message]);
    },
    setOAuthStopControlVisible(visible) {
      calls.push(["stop-visible", visible]);
    },
    updateOperationLabel(label) {
      calls.push(["operation-label", label]);
    },
    showError(error) {
      calls.push(["error", error.message]);
    },
    validateOAuthAttemptId(value) {
      calls.push(["validate-attempt", value]);
      return value;
    },
    async waitForOAuthCompletion(attemptId) {
      calls.push(["wait", attemptId]);
    },
    OPERATION_ALLOWED_SELECTOR: "#login-link, #stop-login-button",
  };
  const recoverPendingOAuthAttempt = vm.runInNewContext(
    `${source}; recoverPendingOAuthAttempt`,
    context,
    { filename: "vps-oauth-reload-recovery.vm.js", timeout: 1_000 },
  );

  assert.equal(await recoverPendingOAuthAttempt(), true);
  assert.equal(state.oauthLoginGeneration, 5);
  assert.equal(state.oauthAttemptId, null);
  assert.equal(loginLink.hidden, true);
  assert.deepEqual(
    calls.filter(([name]) => !["operation", "message", "operation-label"].includes(name)),
    [
      ["api", "/api/oauth/status"],
      ["validate-attempt", "a1b2c3d4-1234"],
      ["remove-attribute", "href"],
      ["stop-visible", true],
      ["wait", "a1b2c3d4-1234"],
      ["api", "/api/status"],
      ["render-auth", true, true],
      ["stop-visible", false],
    ],
  );
  assert.doesNotMatch(
    JSON.stringify(state),
    /authorizationUrl|credential|password/iu,
  );
});

test("ordinary OAuth startup failure leaves route choices available", async () => {
  const script = await readFile("src/ui/app.js", "utf8");
  const start = script.indexOf("async function recoverPendingOAuthAttempt()");
  const end = script.indexOf("async function initializeVpsWizard()", start);
  const routeStart = script.indexOf("function focusVisible(");
  const routeEnd = script.indexOf('element("openai-vps-route").addEventListener', routeStart);
  const nodes = new Map([
    ["setup-choices", { hidden: false }],
    ["chatgpt-setup", { hidden: true }],
    ["openai-vps-route", { setAttribute() {} }],
  ]);
  const state = { step: 1, oauthLoginGeneration: 0, oauthCancellationMessage: "" };
  const errors = [];
  const recover = vm.runInNewContext(`
    ${script.slice(routeStart, routeEnd)}
    ${script.slice(start, end)}
    recoverPendingOAuthAttempt;`, {
    state, element: id => nodes.get(id),
    async runOperation(_trigger, _label, work) { return work(); },
    async api() { throw new Error("Startup status unavailable"); },
    showError(error) { errors.push(error.message); },
    finishOAuthCancellation() {},
    OPERATION_ALLOWED_SELECTOR: "#login-link, #stop-login-button",
  });
  assert.equal(await recover(), true);
  assert.deepEqual(errors, ["Startup status unavailable"]);
  assert.equal(nodes.get("setup-choices").hidden, false);
  assert.equal(nodes.get("chatgpt-setup").hidden, true);
});

test("copy success survives the browser clearing event.currentTarget", async () => {
  const app = await readFile("src/ui/app.js", "utf8");
  const functionStart = app.indexOf("function createCopyClickHandler(");
  const functionEnd = app.indexOf("const handleCopyClick", functionStart);

  assert.notEqual(functionStart, -1);
  assert.notEqual(functionEnd, -1);

  const functionSource = app.slice(functionStart, functionEnd).trimEnd();
  const createCopyClickHandler = vm.runInNewContext(
    `${functionSource}; createCopyClickHandler`,
  );
  const button = { dataset: { copyLabel: "Base URL" } };
  const event = { currentTarget: button };
  const calls = [];
  const handler = createCopyClickHandler({
    copyValueFor(copyButton) {
      assert.equal(copyButton, button);
      return "http://n8n-openai-oauth:10531/v1";
    },
    clearError() {
      calls.push("clear-error");
    },
    async copyText(value) {
      calls.push(["copy", value]);
      await Promise.resolve();
    },
    flashCopied(copyButton) {
      calls.push(["flash", copyButton]);
    },
    setMessage(message) {
      calls.push(["message", message]);
    },
    showError(error) {
      calls.push(["error", error.message]);
    },
  });

  const completion = handler(event);
  event.currentTarget = null;
  await completion;

  assert.deepEqual(calls.slice(0, 3), [
    "clear-error",
    ["copy", "http://n8n-openai-oauth:10531/v1"],
    ["flash", button],
  ]);
  assert.equal(calls[3]?.[0], "message");
});

test("OpenAI VPS continuation reuses a verified connection before requesting SSH", async () => {
  const script = await readFile("src/ui/app.js", "utf8");
  const start = script.indexOf("async function continueWithOpenAiVps()");
  const end = script.indexOf('\nelement("signin-next").addEventListener', start);
  assert.ok(start >= 0 && end > start);
  const calls = [];
  let discovery = { discovery: { containers: [{ name: "n8n" }] }, networks: { networks: ["private"] } };
  const continuation = vm.runInNewContext(
    `${script.slice(start, end)}; continueWithOpenAiVps;`,
    {
      sshSession: { async adoptCurrent() {} },
      clearError() {
        calls.push("clear-error");
      },
      discover: async () => {
        calls.push("discover");
        if (discovery instanceof Error) throw discovery;
        return discovery;
      },
      element(id) {
        assert.equal(id, "signin-next");
        return { id };
      },
      renderDiscovery(result) {
        calls.push(["render", result]);
      },
      async runOperation(trigger, label, work, options) {
        calls.push(["operation", trigger.id, label, options.progressNote]);
        return work();
      },
      setMessage(message) {
        calls.push(["message", message]);
      },
      showError(error) {
        calls.push(["error", error.message]);
      },
      showStep(step) {
        calls.push(["step", step]);
      },
    },
    { filename: "openai-vps-continuation.vm.js", timeout: 1_000 },
  );

  await continuation();
  assert.equal(calls.filter(([name]) => name === "operation").length, 1);
  assert.ok(calls.some(([name]) => name === "render"));
  assert.equal(calls.some(([name]) => name === "step"), false);

  calls.length = 0;
  discovery = new Error("Connect to the VPS first.");
  await continuation();
  assert.ok(calls.some(([name, step]) => name === "step" && step === 2));
  assert.equal(calls.some(([name]) => name === "error"), false);

  calls.length = 0;
  discovery = new Error("Docker inspection failed.");
  await continuation();
  assert.ok(calls.some(([name, message]) => name === "error" && message === "Docker inspection failed."));
  assert.ok(calls.some(([name, message]) => name === "message" && /reconnect only if needed/u.test(message)));
});

test("SuperGrok device polling defers while another VPS read is active", async () => {
  const script = await readFile("src/ui/supergrok-vps.js", "utf8");
  const start = script.indexOf("function scheduleLoginPoll");
  const end = script.indexOf('\nfor (const id of ["host", "port"])');
  assert.ok(start >= 0 && end > start);

  const timers = new Map();
  let nextTimer = 1;
  let apiCalls = 0;
  let loginState = "pending";
  const nodes = new Map();
  const element = (id) => {
    if (!nodes.has(id)) nodes.set(id, { hidden: true, textContent: "", href: "" });
    return nodes.get(id);
  };
  const state = {
    busy: true,
    loginGeneration: 1,
    pollTimer: null,
    status: { installId: "fixture-install" },
  };
  const window = {
    clearTimeout(id) {
      timers.delete(id);
    },
    setTimeout(callback, delay) {
      const id = nextTimer++;
      timers.set(id, { callback, delay });
      return id;
    },
  };
  const context = {
    api: async () => {
      apiCalls += 1;
      return {
        state: loginState,
        userCode: loginState === "pending" ? "TEST-CODE" : undefined,
        verificationUrl: loginState === "pending" ? "https://accounts.x.ai/device" : undefined,
      };
    },
    element,
    perform: async (_label, work) => work(),
    refreshStatus: async () => {},
    setMessage() {},
    state,
    window,
  };
  vm.runInNewContext(
    `${script.slice(start, end)}\nglobalThis.pollLogin = pollLogin;`,
    context,
    { filename: "supergrok-login-poll.vm.js" },
  );
  const flush = async () => {
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  };

  await context.pollLogin("fixture-install", 1);
  assert.equal(apiCalls, 0);
  const deferredTimer = state.pollTimer;
  assert.equal(timers.get(deferredTimer)?.delay, 500);

  state.busy = false;
  timers.get(deferredTimer).callback();
  await flush();
  assert.equal(apiCalls, 1);
  assert.equal(timers.get(state.pollTimer)?.delay, 2_000);

  state.busy = true;
  await context.pollLogin("fixture-install", state.loginGeneration);
  const cancelledTimer = state.pollTimer;
  state.loginGeneration += 1;
  timers.get(cancelledTimer).callback();
  await flush();
  assert.equal(apiCalls, 1);

  state.busy = false;
  loginState = "expired";
  await context.pollLogin("fixture-install", state.loginGeneration);
});

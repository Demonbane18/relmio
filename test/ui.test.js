import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

import {
  bindWizardNavigation,
  readWizardSession,
} from "../src/ui/session.js";
import { formatAuthUpdatedAt } from "../src/ui/time.js";

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

test("wizard HTML has accessible landmarks, labels, and no inline scripts", async () => {
  const html = await readFile("src/ui/index.html", "utf8");

  assert.match(html, /<html lang="en">/);
  assert.ok(
    html.indexOf('src="/session-bootstrap.js"') <
      html.indexOf('src="/app.js"'),
  );
  assert.match(html, /<body data-current-step="1">/u);
  assert.match(html, /<title>Relmio \| n8n Setup<\/title>/u);
  assert.match(html, /class="brand-mark"[\s\S]*<span>Relmio<\/span>/u);
  assert.match(html, /class="theme-picker"/u);
  assert.match(html, /name="color-theme" value="system"/u);
  assert.match(html, /name="color-theme" value="light"/u);
  assert.match(html, /name="color-theme" value="dark"/u);
  assert.match(html, /class="theme-icon theme-icon-system"/u);
  assert.match(html, /class="theme-icon theme-icon-light"/u);
  assert.match(html, /class="theme-icon theme-icon-dark"/u);
  assert.match(html, /title="Use system appearance"/u);
  assert.match(
    html,
    /<nav class="steps" aria-label="Setup progress">[\s\S]*data-step-marker="1"[\s\S]*data-step-marker="5"/u,
  );
  assert.match(
    html,
    /<main id="main-content" class="shell" tabindex="-1" aria-busy="false">/u,
  );
  assert.match(
    html,
    /<aside class="rail" aria-label="Setup progress and safety">/u,
  );
  assert.match(
    html,
    /class="rail"[\s\S]*<h1 id="page-title">[\s\S]*aria-label="Setup progress"[\s\S]*class="toast-stack"[\s\S]*<section class="panel" data-step="1"/u,
  );
  assert.match(html, /unofficial, private, and policy-uncertain/u);
  assert.match(
    html,
    /current ChatGPT sign-in bridge supports Message a Model and GPT Image generation\/editing[\s\S]*does not support audio, Classify Text for Violations \(moderation\), file management, stored conversations, or video generation[\s\S]*do not enter its API key into this bridge/u,
  );
  assert.doesNotMatch(html, /class="(?:eyebrow|step-kicker)"/u);
  assert.doesNotMatch(html, /n8n OAuth Bridge/u);
  assert.equal((html.match(/<h1\b/g) ?? []).length, 1);
  assert.match(html, /class="skip-link"/);
  assert.match(html, /Back up first/);
  assert.match(html, /Export your n8n workflows before connecting/);
  assert.match(
    html,
    /class="toast-stack" aria-label="Wizard notifications"[\s\S]*id="global-safety"[\s\S]*id="global-backup"[\s\S]*id="global-message"[\s\S]*id="global-error"/u,
  );
  assert.match(html, /id="global-message"[\s\S]*role="status"/u);
  assert.match(html, /id="global-error"[\s\S]*role="alert"\s+tabindex="-1"/u);
  assert.equal(
    (html.match(/class="toast-close"/gu) ?? []).length,
    5,
  );
  assert.match(html, /data-dismiss-toast="global-safety"/u);
  assert.match(html, /data-dismiss-toast="global-backup"/u);
  assert.match(html, /data-dismiss-toast="global-message"/u);
  assert.match(html, /data-dismiss-toast="global-error"/u);
  assert.match(
    html,
    /id="responses-api-notice"[\s\S]*OpenAI OAuth\/Codex: Use Responses API ON[\s\S]*data-dismiss-toast="responses-api-notice"[\s\S]*aria-label="Dismiss Responses API reminder"/u,
  );
  assert.match(
    html,
    /<dt>Responses API<\/dt>[\s\S]*<strong>On<\/strong> for Chat Model node version 1\.3/u,
  );
  assert.match(
    html,
    /id="auth-updated"[^>]*hidden[\s\S]*<time id="auth-updated-time"><\/time>/,
  );
  assert.equal(
    (html.match(/<h2[^>]*tabindex="-1"/g) ?? []).length,
    5,
  );
  assert.match(html, /<label class="field">[\s\S]*id="host"/);
  assert.match(html, /id="password"[\s\S]*disabled[\s\S]*required/);
  assert.match(
    html,
    /data-copy-target="result-url"[\s\S]*aria-label="Copy Base URL"/,
  );
  assert.match(
    html,
    /data-copy-target="result-key"[\s\S]*aria-label="Copy API key"/,
  );
  assert.match(
    html,
    /data-copy-target="result-model"[\s\S]*aria-label="Copy model ID"/,
  );
  assert.match(
    html,
    /data-copy-target="result-http-url"[\s\S]*aria-label="Copy HTTP endpoint"/,
  );
  assert.match(
    html,
    /data-copy-target="result-http-body"[\s\S]*aria-label="Copy HTTP JSON body"/,
  );
  assert.match(html, /id="copy-settings"[\s\S]*data-copy-group="credential"/u);
  assert.match(html, /id="copy-http-recipe"[\s\S]*data-copy-group="http"/u);
  assert.equal(
    (html.match(/<details class="recipe-disclosure">/gu) ?? []).length,
    2,
  );
  assert.match(
    html,
    /<details class="recipe-disclosure">[\s\S]*<summary>[\s\S]*AI Agent or Basic LLM Chain/u,
  );
  assert.match(
    html,
    /<details class="recipe-disclosure">[\s\S]*<summary>[\s\S]*HTTP Request node/u,
  );
  assert.match(html, /<dt>Method<\/dt>[\s\S]*<code>POST<\/code>/u);
  assert.match(html, /Generic Auth Type[\s\S]*Bearer Auth/u);
  assert.match(html, /Credential[\s\S]*openai-oauth/u);
  assert.match(html, /Bearer token[\s\S]*local-only/u);
  assert.match(html, /Authorization header[\s\S]*Bearer local-only/u);
  assert.match(
    html,
    /data-copy-target="result-http-auth"[\s\S]*aria-label="Copy Authorization header"/u,
  );
  assert.match(html, /Content-Type[\s\S]*application\/json/u);
  assert.match(html, /Send body[\s\S]*JSON[\s\S]*Using JSON/u);
  assert.match(html, /id="result-http-body"/u);
  assert.match(html, /OpenAI credential[\s\S]*OpenAI Chat Model/u);
  assert.doesNotMatch(html, /<script(?![^>]*\bsrc=)/);
  assert.doesNotMatch(html, /\sonclick=/i);
});

test("every wizard route clears the browser transfer before loading its application module", async () => {
  for (const [path, applicationScript] of [
    ["src/ui/index.html", "/app.js"],
    ["src/ui/local.html", "/local.js"],
    ["src/ui/assistant.html", "/assistant.js"],
  ]) {
    const html = await readFile(path, "utf8");
    const bootstrapIndex = html.indexOf('src="/session-bootstrap.js"');
    assert.ok(bootstrapIndex >= 0, path);
    assert.ok(bootstrapIndex < html.indexOf(`src="${applicationScript}"`), path);
  }

  const session = await readFile("src/ui/session.js", "utf8");
  assert.match(session, /await pendingBrowserTransfer/u);
  assert.doesNotMatch(session, /location\.search[\s\S]*session/u);
});

test("VPS wizard uses icon-only copy controls and starts fresh from Ready", async () => {
  const [html, script, css] = await Promise.all([
    readFile("src/ui/index.html", "utf8"),
    readFile("src/ui/app.js", "utf8"),
    readFile("src/ui/styles.css", "utf8"),
  ]);

  assert.doesNotMatch(html, />\s*Copy(?:\s+[^<]*)?\s*<\/button>/u);
  assert.match(
    html,
    /data-copy-target="result-url"[\s\S]*aria-label="Copy Base URL"[\s\S]*title="Copy Base URL"[\s\S]*class="copy-icon copy-icon-copy"[\s\S]*class="copy-icon copy-icon-check"/u,
  );
  assert.match(
    html,
    /id="copy-settings"[\s\S]*aria-label="Copy OpenAI credential settings"[\s\S]*title="Copy OpenAI credential settings"/u,
  );
  assert.match(html, /data-step="5"[\s\S]*id="setup-another-vps"/u);
  assert.doesNotMatch(html, /data-step="5"[\s\S]*data-back="4"/u);
  assert.match(
    script,
    /bindWizardNavigation\(element\("setup-another-vps"\), "\/", token\);/u,
  );
  assert.match(script, /button\.classList\.add\("copied"\)/u);
  assert.match(css, /\.copy-value\.copied \.copy-icon-copy/u);
  assert.match(css, /\.copy-value\.copied \.copy-icon-check/u);
  assert.match(css, /\.copy-value\s*\{[^}]*min-height:\s*2\.75rem;[^}]*width:\s*2\.75rem;/su);
});

test("detected VPS n8n exposes managed bridge and Assistant companion paths", async () => {
  const [html, script] = await Promise.all([
    readFile("src/ui/index.html", "utf8"),
    readFile("src/ui/app.js", "utf8"),
  ]);

  assert.match(
    html,
    /id="detected-vps-integration-management"[^>]*hidden[\s\S]*Manage detected self-hosted n8n/u,
  );
  assert.match(html, /id="manage-vps-sidecar"[\s\S]*OpenAI-OAuth\/Codex bridge/u);
  assert.match(html, /id="manage-vps-assistant"[\s\S]*Assistant companion/u);
  assert.match(html, /id="refresh-vps-chatgpt"[^>]*>\s*Refresh ChatGPT sign-in\s*<\/button>/u);
  assert.match(
    html,
    /id="disconnect-vps-button"[^>]*>\s*Disconnect from VPS\s*<\/button>/u,
  );
  assert.match(html, /id="manage-vps-searxng" type="checkbox"/u);
  assert.match(script, /api\(assistant \? "\/api\/assistant\/plan" : "\/api\/plan"/u);
  assert.match(script, /api\(assistant \? "\/api\/assistant\/install" : "\/api\/install"/u);
  assert.match(script, /element\("login-button"\)\.click\(\)/u);
  assert.match(script, /element\("sidecar-ready-content"\)\.hidden = assistant/u);
  assert.doesNotMatch(script, /\.innerHTML\b/);
});

test("Responses API completion reminder stays until the user dismisses it", async () => {
  const [html, script] = await Promise.all([
    readFile("src/ui/index.html", "utf8"),
    readFile("src/ui/app.js", "utf8"),
  ]);
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
  assert.match(
    html,
    /<dt>Responses API<\/dt>[\s\S]*<strong>On<\/strong> for Chat Model node version 1\.3/u,
  );
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

test("failed VPS install returns to connection with an inspect-before-retry message", async () => {
  const script = await readFile("src/ui/app.js", "utf8");
  const start = script.indexOf('element("install-button").addEventListener');
  const end = script.indexOf('\nfor (const input of document.querySelectorAll', start);
  assert.ok(start >= 0 && end > start, "missing VPS install handler");

  const calls = [];
  const handlers = new Map();
  const state = {
    planId: "reviewed-plan",
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
    element: (id) => elements.get(id),
    isAssistantIntegration: () => false,
    clearError: () => calls.push(["clear-error"]),
    invalidateReviewedPlan() {
      calls.push(["invalidate-plan"]);
      state.planId = null;
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
  };
  vm.runInNewContext(script.slice(start, end), context, {
    filename: "vps-install-failure.vm.js",
    timeout: 1_000,
  });

  await handlers.get("install")({ currentTarget: elements.get("install-button") });

  assert.ok(calls.some(([name, value]) => name === "api" && value === "/api/install"));
  assert.ok(calls.some(([name, value]) => name === "step" && value === 2));
  assert.ok(calls.some(([name, value]) =>
    name === "message" &&
    value === "The install or update did not finish, and the VPS connection was closed. Reconnect and inspect the companion before retrying."
  ));
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
    element: (id) => elements.get(id),
    isAssistantIntegration: () => false,
    clearError: () => calls.push(["clear-error"]),
    invalidateReviewedPlan() {
      calls.push(["invalidate-plan"]);
      state.planId = null;
      elements.get("install-confirm").checked = false;
      elements.get("install-button").disabled = true;
    },
    setMessage: (message) => calls.push(["message", message]),
    showError: (error) => calls.push(["error", error.message]),
    showStep: (step) => calls.push(["step", step]),
    runOperation: async (_button, _label, work) => work(),
    api,
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
  assert.equal(elements.get("detected-vps-integration-management").hidden, true);
  assert.equal(elements.get("auth-title").textContent, "Fresh ChatGPT sign-in needed");
  assert.match(elements.get("auth-detail").textContent, /reconnect to the VPS and review the bridge update again/u);
  assert.equal(elements.get("login-button").textContent, "Refresh ChatGPT sign-in");
  assert.equal(elements.get("login-button").disabled, false);
  assert.equal(elements.get("signin-next").disabled, true);
  assert.ok(calls.some(([name, value]) => name === "focus" && value === "login-button"));
  assert.equal(calls.some(([name, path]) => name === "api" && path === "/api/oauth/login"), false);

  calls.length = 0;
  state.planId = "another-reviewed-plan";
  state.oauthRetryBlocked = true;
  elements.get("install-confirm").checked = true;
  elements.get("install-button").disabled = false;
  elements.get("login-button").disabled = true;
  await handlers.get("install")({ currentTarget: elements.get("install-button") });
  assert.equal(elements.get("login-button").disabled, true);
  assert.equal(calls.some(([name]) => name === "focus"), false);
  assert.match(elements.get("auth-detail").textContent, /restart Relmio/u);
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

test("failed Docker network refresh stays on selection without claiming disconnect", async () => {
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
  assert.ok(calls.some(([name, value]) =>
    name === "message" &&
    value === "The Docker network list did not refresh. Retry the container selection, or disconnect and reconnect if needed."
  ));
  assert.ok(calls.some(([name, value]) => name === "error" && value === "network refresh failed"));
  assert.equal(state.planId, null);
  assert.equal(elements.get("install-confirm").checked, false);
  assert.equal(elements.get("install-button").disabled, true);
});

test("VPS integration review can be rendered repeatedly without deleting its summary fields", async () => {
  const [html, script] = await Promise.all([
    readFile("src/ui/index.html", "utf8"),
    readFile("src/ui/app.js", "utf8"),
  ]);
  const reviewList = html.indexOf('<ul id="review-will-list"');
  assert.ok(reviewList > 0);
  assert.ok(html.indexOf('id="review-network"') < reviewList);
  assert.ok(html.indexOf('id="review-endpoint"') < reviewList);

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
    context,
  );

  review.renderIntegrationReview({
    endpointHostname: "n8n-openai-oauth",
    networkName: "n8n_default",
  });
  assert.equal(
    elements.get("review-will-list").children[0].textContent,
    "Create or update only /docker/n8n-openai-oauth.",
  );
  review.state.integrationKind = "assistant";
  review.state.managingDetectedIntegration = true;
  review.renderIntegrationReview({ includeSearxng: true, networkName: "n8n_default" });
  review.state.integrationKind = "sidecar";
  review.renderIntegrationReview({
    endpointHostname: "n8n-openai-oauth",
    networkName: "n8n_default",
  });

  assert.equal(elements.get("review-network").textContent, "n8n_default");
  assert.equal(elements.get("review-endpoint-label").textContent, "Private hostname");
  assert.equal(elements.get("review-endpoint").textContent, "n8n-openai-oauth");
  assert.equal(elements.get("review-will-list").children.length, 4);
  assert.equal(elements.get("review-wont-list").children.length, 4);
  assert.equal(elements.get("install-button").textContent, "Update the bridge");
  assert.deepEqual(
    elements
      .get("review-will-list")
      .children.map((child) => child.textContent),
    [
      "Update only /docker/n8n-openai-oauth.",
      "Upload the current Relmio adapter runtime and current ChatGPT sign-in.",
      "Rebuild and start only the openai-oauth sidecar.",
      "Attach the sidecar to n8n_default.",
    ],
  );
  assert.match(
    elements.get("install-confirm-copy").textContent,
    /runtime and sign-in update/u,
  );
  assert.match(
    script,
    /Adapter runtime and ChatGPT sign-in file updated on the existing wizard-managed sidecar\. n8n was not restarted\./u,
  );
});

test("VPS Assistant results render validated one-time connection settings", async () => {
  const [html, script] = await Promise.all([
    readFile("src/ui/index.html", "utf8"),
    readFile("src/ui/app.js", "utf8"),
  ]);

  assert.match(html, /id="assistant-result-sandbox-url"/u);
  assert.match(html, /id="assistant-result-sandbox-key"/u);
  assert.match(html, /Code Sandbox API key\s*<small>\(shown once\)<\/small>/u);
  assert.match(html, /id="assistant-result-searxng-row"[^>]*hidden/u);
  assert.match(html, /id="assistant-result-settings"/u);
  assert.match(html, /Relmio never edits its Compose file or restarts its container/u);
  assert.match(script, /function validateAssistantInstallResult\(result\)/u);
  assert.match(script, /function renderAssistantResult\(result\)/u);
  assert.match(script, /N8N_INSTANCE_AI_SANDBOX_IMAGE/u);
  assert.match(script, /N8N_SANDBOX_SERVICE_API_KEY/u);
  assert.match(script, /Object\.keys\(value\)\.length !== expectedNames\.length/u);
  assert.match(script, /!Object\.hasOwn\(value, name\)/u);
  assert.match(script, /value\[name\] !== expectedSettings\[name\]/u);
  assert.match(script, /result\.n8nSettings,\s*expectedSettings/u);
  assert.match(script, /intentionally does not return the existing sandbox API key/u);
  assert.match(script, /preserve[^\n]*N8N_ENABLED_MODULES[^\n]*instance-ai/iu);
  assert.doesNotMatch(script, /N8N_ENABLED_MODULES:\s*"instance-ai"/u);
  assert.doesNotMatch(script, /returnedSettings\s*\?\?/u);
  assert.match(script, /assistant-result-settings"\)\.textContent/u);
  assert.match(script, /assistant-result-key-row"\)\.hidden/u);
  assert.match(script, /sidecar-ready-content"\)\.hidden = assistant/u);
  assert.doesNotMatch(script, /\.innerHTML\b/);
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
  assert.match(elements.get("assistant-result-key-note").textContent, /shown-once API key/u);

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
  assert.match(
    elements.get("assistant-result-key-note").textContent,
    /does not return the existing sandbox API key[\s\S]*Preserve the existing N8N_ENABLED_MODULES/u,
  );

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

test("workspace CSS keeps the document still and notices in flow", async () => {
  const css = await readFile("src/ui/styles.css", "utf8");

  const bodyBlock = css.match(/(?:^|\n)body\s*\{[^}]*\}/u)?.[0] ?? "";
  assert.match(bodyBlock, /overflow:\s*hidden/u);

  const toastStackBlock = css.match(/\.toast-stack\s*\{[^}]*\}/u)?.[0] ?? "";
  assert.notEqual(toastStackBlock, "");
  assert.doesNotMatch(toastStackBlock, /position:\s*fixed/u);

  const panelBlock = css.match(/\.panel\s*\{[^}]*\}/u)?.[0] ?? "";
  assert.match(panelBlock, /overflow-y:\s*auto/u);

  assert.match(css, /--radius-lg:\s*1rem/u);
});

test("short narrow viewports preserve an internally scrollable task panel", async () => {
  const css = await readFile("src/ui/styles.css", "utf8");
  const shortNarrowStart = css.indexOf(
    "@media (max-width: 60rem) and (max-height: 36rem)",
  );

  assert.notEqual(shortNarrowStart, -1);

  const shortNarrowCss = css.slice(shortNarrowStart);
  assert.match(shortNarrowCss, /\.intro\s*\{\s*display:\s*none/u);
  assert.match(
    shortNarrowCss,
    /\.shell\s*\{[\s\S]*grid-template-rows:\s*auto\s+minmax\(7rem,\s*1fr\)/u,
  );
  assert.match(
    shortNarrowCss,
    /\.toast-stack\s*\{[\s\S]*display:\s*flex[\s\S]*overflow-x:\s*auto/u,
  );
  assert.match(shortNarrowCss, /\.safety-note\s*>\s*span\s*\{\s*display:\s*none/u);
  assert.match(
    shortNarrowCss,
    /\.panel\s*\{[\s\S]*min-height:\s*7rem[\s\S]*overflow-y:\s*auto/u,
  );
});

test("browser code never uses innerHTML or web storage for credentials", async () => {
  const [app, oauthPopup] = await Promise.all([
    readFile("src/ui/app.js", "utf8"),
    readFile("src/ui/oauth-popup.js", "utf8"),
  ]);
  const browserCode = `${app}\n${oauthPopup}`;

  assert.doesNotMatch(browserCode, /\.innerHTML\b/);
  assert.doesNotMatch(browserCode, /\blocalStorage\b|\bsessionStorage\b/);
  assert.doesNotMatch(app, /console\.(?:log|warn|error)/);
  assert.match(app, /textContent/);
  assert.match(app, /authUpdatedAt/);
  assert.match(app, /Fresh sign-in saved/);
  assert.match(app, /unexpected response/);
  assert.match(app, /For a persistent install, run relmio open/);
  assert.match(app, /npx --yes --ignore-scripts relmio@latest open/);
  assert.match(
    app,
    /For a hosted foreground launcher, return to the active terminal and press Enter to create a fresh private handoff/,
  );
  assert.doesNotMatch(app, /URL printed by its active terminal/u);
  assert.match(app, /installAttempted/);
  assert.match(app, /status\.previewMode/);
  assert.match(app, /Preview sign-in disabled/);
  assert.match(
    app,
    /querySelectorAll\(\s*"\[data-copy-target\], \[data-copy-group\]",?\s*\)/u,
  );
  assert.match(app, /async function copyText\(value\)/);
  assert.match(app, /textarea\.focus\(\)/);
  assert.match(app, /textarea\.select\(\)/);
  assert.match(app, /textarea\.setSelectionRange\?\.\(0, textarea\.value\.length\)/);
  assert.match(app, /document\.execCommand\("copy"\)/);
  assert.match(
    app,
    /const textarea = document\.createElement\("textarea"\);[\s\S]*textarea\.focus\(\);[\s\S]*textarea\.select\(\);[\s\S]*textarea\.setSelectionRange\?\.\(0, textarea\.value\.length\);[\s\S]*document\.execCommand\("copy"\)[\s\S]*finally \{[\s\S]*textarea\.remove\(\);[\s\S]*previouslyFocused\?\.focus\?\.\(\);[\s\S]*if \(copied\) \{[\s\S]*navigator\.clipboard\.writeText\(value\)/u,
  );
  assert.match(app, /messages:[\s\S]*What is a robot\?/u);
  assert.match(app, /response_format:[\s\S]*json_schema/u);
  assert.match(app, /additionalProperties: false/u);
  assert.match(app, /strict: true/u);
  assert.match(app, /chat\/completions/u);
  assert.match(app, /Authentication: Generic Credential Type/u);
  assert.match(app, /Generic Auth Type: Bearer Auth/u);
  assert.match(app, /Authorization: \$\{element\("result-http-auth"\)\.textContent\}/u);
  assert.match(app, /Specify Body: Using JSON/u);
  assert.match(app, /function dismissToast\(toast\)/u);
  assert.match(app, /document\.body\.dataset\.currentStep = String\(step\)/u);
  assert.match(
    app,
    /if \(step === 5\) \{[\s\S]*dismissToast\(element\("global-safety"\)\);[\s\S]*dismissToast\(element\("global-backup"\)\);/u,
  );
  assert.match(app, /window\.setTimeout\([\s\S]*dismissToast\(messageToast\)/u);
  assert.match(app, /data-dismiss-toast/u);
  assert.doesNotMatch(app, /"Use Responses API: on"/u);
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

test("persistent VPS and Assistant routes use the shared token-free session helpers", async () => {
  const routes = [
    { path: "/", scriptPath: "src/ui/app.js" },
    { path: "/assistant", scriptPath: "src/ui/assistant.js" },
  ];

  for (const route of routes) {
    const script = await readFile(route.scriptPath, "utf8");
    assert.match(
      script,
      /import \{ bindWizardNavigation, readWizardSession \} from "\.\/session\.js";/u,
    );
    assert.match(script, /const token = readWizardSession\(\);/u);
    assert.doesNotMatch(script, /[?]session=/u);
    assert.doesNotMatch(
      script,
      /\blocalStorage\b|\bsessionStorage\b|\bindexedDB\b|document\.cookie/u,
    );
  }

  const sessionHelper = await readFile("src/ui/session.js", "utf8");
  assert.doesNotMatch(
    sessionHelper,
    /\blocalStorage\b|\bsessionStorage\b|\bindexedDB\b|document\.cookie/u,
  );
});

test("VPS reload rehydrates and completes the server-owned pending OAuth attempt", async () => {
  const app = await readFile("src/ui/app.js", "utf8");
  const start = app.indexOf("async function recoverPendingOAuthAttempt()");
  const end = app.indexOf("\nasync function initializeVpsWizard()", start);
  assert.ok(start >= 0 && end > start, "missing OAuth reload recovery boundary");
  assert.match(
    app,
    /async function initializeVpsWizard\(\) \{[\s\S]*recoverPendingOAuthAttempt\(\)[\s\S]*if \(!recoveredOAuth\) \{[\s\S]*refreshAuthStatus\(\);[\s\S]*initializeVpsWizard\(\)\.catch\(showError\);/u,
  );
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
  assert.deepEqual(calls, [
    [
      "operation",
      null,
      "Checking for active ChatGPT sign-in…",
      "#login-link, #stop-login-button",
    ],
    ["api", "/api/oauth/status"],
    ["validate-attempt", "a1b2c3d4-1234"],
    ["remove-attribute", "href"],
    ["stop-visible", true],
    [
      "message",
      "A ChatGPT sign-in is still in progress. Complete it in its existing browser tab, or stop it here.",
    ],
    ["operation-label", "Reconnecting to ChatGPT sign-in…"],
    ["wait", "a1b2c3d4-1234"],
    ["api", "/api/status"],
    ["render-auth", true, true],
    ["stop-visible", false],
  ]);
  assert.doesNotMatch(
    JSON.stringify(state),
    /authorizationUrl|credential|password/iu,
  );
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

  assert.deepEqual(calls, [
    "clear-error",
    ["copy", "http://n8n-openai-oauth:10531/v1"],
    ["flash", button],
    ["message", "Base URL copied."],
  ]);
});

test("local OAuth prepares and navigates its popup before severing opener access", async () => {
  const [app, html] = await Promise.all([
    readFile("src/ui/app.js", "utf8"),
    readFile("src/ui/index.html", "utf8"),
  ]);

  assert.match(app, /Preparing a fresh ChatGPT sign-in/u);
  assert.match(app, /prepareOAuthPopup\(loginWindow\);/u);
  assert.match(
    app,
    /loginWindow\.location\.replace\(authorizationUrl\);[\s\S]*loginWindowNavigated = true;[\s\S]*loginWindow\.opener = null;/u,
  );
  assert.match(
    app,
    /loginWindow\.location\.replace\(authorizationUrl\);[\s\S]*loginWindow\.opener = null;/u,
  );
  assert.doesNotMatch(
    app,
    /const loginWindow = window\.open\("about:blank", "_blank"\);[\s\S]{0,120}loginWindow\.opener = null;/u,
  );
  assert.match(app, /loginLink\.href = authorizationUrl;/u);
  assert.match(app, /loginWindow\.close\(\);/u);
  assert.match(html, /id="login-link"[\s\S]*target="_blank"[\s\S]*rel="noopener noreferrer"/u);
});

test("OAuth UI offers an accessible stop control and rejects stale polling after replacement", async () => {
  const [app, html] = await Promise.all([
    readFile("src/ui/app.js", "utf8"),
    readFile("src/ui/index.html", "utf8"),
  ]);

  assert.match(
    html,
    /<button id="stop-login-button" class="button secondary" type="button" hidden>\s*Stop ChatGPT sign-in\s*<\/button>/u,
  );
  assert.match(app, /async function waitForOAuthCompletion\(expectedAttemptId\)/u);
  assert.match(
    app,
    /result\.retryBlocked === true[\s\S]*oauthRetryBlocked = true[\s\S]*result\.attemptId !== expectedAttemptId/u,
  );
  assert.match(
    app,
    /result\.attemptId !== expectedAttemptId[\s\S]*replaced by a newer attempt/u,
  );
  assert.match(
    app,
    /if \(error\.oauthRetryBlocked === true\) \{\s*blockOAuthRetry\(\);/u,
  );
  assert.match(app, /\/api\/oauth\/cancel/u);
  assert.match(app, /body: \{ attemptId \}/u);
  assert.match(app, /oauthLoginGeneration/u);
  assert.match(app, /oauthRetryBlocked/u);
  assert.match(app, /stop-login-button/u);
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
  assert.ok(calls.some(([name, message]) => name === "message" && message === "Enter the VPS address exactly as Hostinger shows it."));

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
  assert.equal(element("login-state").textContent, "Complete the sign-in on the official Grok page, then return here.");
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
  assert.match(element("login-state").textContent, /device code expired/u);
});

test("wizard theme preferences store only the selected color mode", async () => {
  const theme = await readFile("src/ui/theme.js", "utf8");

  assert.match(theme, /relmio-color-mode/u);
  assert.match(theme, /localStorage\.getItem/u);
  assert.match(theme, /localStorage\.setItem/u);
  assert.doesNotMatch(theme, /password|credential|token|fingerprint/iu);
});

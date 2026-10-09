import { runInNewContext } from "node:vm";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { clearFieldError, setFieldError } from "../src/ui/ssh-form.js";
import { siwcAccount } from "./helpers/siwc-wizard.js";
import { accountUiState, siwcErrorFromResponse } from "../src/ui/siwc-controls.js";



test("local model completion reflects acquisition, failure, and verified inference", async () => {
  const script = await readFile("src/ui/local.js", "utf8");
  const render = extractBetween(script, "function renderLocalModelStatus", "\nfunction scheduleLocalModelPoll");
  const nodes = new Map();
  const element = (id) => {
    if (!nodes.has(id)) nodes.set(id, { hidden: false, textContent: "" });
    return nodes.get(id);
  };
  const state = { step: 4, installedTarget: "n8n-local-model", localModelReady: false };
  const messages = [];
  const renderStatus = runInNewContext(`${render}\nrenderLocalModelStatus`, {
    state, element, setMessage: (message) => messages.push(message),
    validateLocalModelStatus() {}, modelGigabytes: (bytes) => String(bytes),
    scheduleLocalModelPoll() {}, clearLocalModelPoll() {},
  });
  const downloading = { status: "downloading", modelId: "qwen3:0.6b", endpoint: "http://n8n-local-model:11434/v1",
    progress: { status: "downloading", completed: 0, total: 522653277 } };
  renderStatus(downloading);
  assert.equal(element("success-mark").hidden, true);
  assert.equal(element("done-step-caption").textContent.includes("Ready"), false);
  assert.equal(element("local-model-settings").hidden, true);
  assert.match(messages.at(-1), /Do not configure n8n yet/u);

  renderStatus({ ...downloading, status: "model-error", progress: null });
  assert.equal(element("success-mark").hidden, true);
  assert.equal(element("local-model-review-retry").hidden, false);
  assert.match(element("done-detail").textContent, /failed/u);
  renderStatus({ ...downloading, status: "partial", progress: null });
  assert.equal(element("success-mark").hidden, true);
  assert.equal(element("local-model-review-retry").hidden, false);
  assert.equal(element("local-model-settings").hidden, true);

  renderStatus({ ...downloading, status: "model-ready", progress: null });
  assert.equal(element("success-mark").hidden, false);
  assert.equal(element("done-step-caption").textContent, "Step 4 of 4 · Ready");
  assert.equal(element("local-model-settings").hidden, false);
  assert.equal(element("local-model-installed-id").textContent, "qwen3:0.6b");
  assert.match(messages.at(-1), /Verified private inference/u);
});

test("VPS model recovery appears only when discovery confirms no running n8n", async () => {
  const script = await readFile("src/ui/local-model-vps.js", "utf8");
  const startup = script.slice(script.indexOf("\nif (!token) {"));
  async function inspect(failure) {
    const nodes = new Map();
    const errors = [];
    let completed;
    runInNewContext(startup, {
      token: "private-session",
      el(id) {
        if (!nodes.has(id)) nodes.set(id, { hidden: true });
        return nodes.get(id);
      },
      message() {},
      async readSshIdentity() { return { host: "fixture.example", port: 22, fingerprint: `SHA256:${"a".repeat(43)}` }; },
      adoptConnectedIdentity() {},
      async discover() { throw failure; },
      perform(_label, task) {
        completed = task().catch(error => errors.push(error));
        return completed;
      },
    });
    await completed;
    return { manualVisible: nodes.get("manual-recovery")?.hidden === false, errors };
  }
  const transport = await inspect(new Error("SSH discovery failed"));
  assert.equal(transport.manualVisible, false);
  assert.match(transport.errors[0].message, /SSH discovery failed/u);
  const absent = new Error("No running n8n container found.");
  absent.code = "NO_RUNNING_N8N";
  const confirmed = await inspect(absent);
  assert.equal(confirmed.manualVisible, true);
  assert.equal(confirmed.errors.length, 0);
});

test("the install key warning names the selected target's own boundary", async () => {
  const script = await readFile("src/ui/local.js", "utf8");
  const source = extractBetween(
    script,
    "function prepareInstallPanel()",
    "\nconst ASSISTANT_SANDBOX_IMAGE",
  );
  const nodes = new Map();
  const element = (id) => {
    if (!nodes.has(id)) nodes.set(id, { hidden: false, disabled: false, required: false, value: "", textContent: "", dataset: {}, setCustomValidity() {} });
    return nodes.get(id);
  };
  const prepare = runInNewContext(`${source}; prepareInstallPanel;`, {
    element,
    resetBasicAuthPasswordVisibility() {},
    setButtonLabel() {},
    isGrokBuild: (value) => value === "xai-grok-build",
    isCodexChat: (target) => target === "codex-chat",
    isN8nSidecar: (target) => target === "n8n-openai-oauth",
    isN8nSuperGrok: (target) => target === "n8n-supergrok-oauth",
    isN8nLocalModel: (target) => target === "n8n-local-model",
    isN8nAssistant: (target) => target === "n8n-ai-assistant",
    isN8nStack: (target) => target === "local-n8n-stack",
    state: { plan: { target: "xai-grok-build" } },
  });

  prepare();
  assert.equal(element("codex-install-warning").hidden, false);
  assert.match(element("codex-install-warning-title").textContent, /endpoint/u);
  assert.match(element("codex-install-warning-detail").textContent, /SuperGrok/u);
  assert.doesNotMatch(element("codex-install-warning-detail").textContent, /Codex|ChatGPT/u);

  for (const target of ["codex-chatgpt", "codex-chat"]) {
    nodes.forEach((node) => { node.textContent = ""; });
    runInNewContext(`${source}; prepareInstallPanel;`, {
      element,
      resetBasicAuthPasswordVisibility() {},
      setButtonLabel() {},
      isGrokBuild: () => false,
      isCodexChat: (value) => value === target,
      isN8nSidecar: () => false,
      isN8nSuperGrok: () => false,
      isN8nLocalModel: () => false,
      isN8nAssistant: () => false,
      isN8nStack: () => false,
      state: { plan: { target } },
    })();
    assert.match(element("codex-install-warning-detail").textContent, /Codex/u);
  }
});


test("the complete script renders a healthy OAuth inventory instead of falling back to unavailable", async () => {
  const { runInNewContext } = await import("node:vm");
  const shared = (await readFile("src/ui/siwc-controls.js", "utf8")).replace(/^export /gmu, "");
  const script = (await readFile("src/ui/local.js", "utf8")).replace(/^import[\s\S]*?;\r?\n/gmu, "");
  const fixture = {
    schemaVersion: 1, generatedAt: new Date().toISOString(),
    docker: { available: true, version: "29.7.2", composeVersion: "2.39.1" }, auth: { secretsRevealable: false },
    providers: [["codex-chatgpt", "ChatGPT"], ["codex-chat", "ChatGPT"], ["xai-grok-build", "SuperGrok"], ["n8n-supergrok-oauth", "SuperGrok (n8n)"]].map(([target, label]) => ({ target, label, authentication: "provider-oauth", readiness: "runtime-owned" })),
    services: [
      ["codex-chatgpt", "Codex (ChatGPT plan)", "endpoint", "ws://127.0.0.1:14500/", ["setup", "sign-out-chatgpt", "disable-chatgpt-plan", "rotate-local-capability"]],
      ["codex-chat", "Codex Chat adapter", "endpoint", "http://127.0.0.1:14501/", ["setup", "sign-out-chatgpt", "disable-chatgpt-plan", "rotate-local-capability"]],
      ["xai-grok-build", "SuperGrok", "endpoint", "http://127.0.0.1:14502/", ["sign-in-grok-build", "sign-out-grok-build", "rotate-local-capability"]],
      ["local-n8n-stack", "Local n8n stack", "n8n-stack"], ["n8n-openai-oauth", "ChatGPT plan sidecar", "n8n-oauth-bridge"], ["local-n8n-assistant", "AI Assistant tools", "n8n-assistant"], ["n8n-supergrok-oauth", "SuperGrok for n8n", "n8n-supergrok"],
      ["n8n-local-model", "Local model for n8n", "n8n-local-model"],
    ].map(([target, label, kind, endpoint, actions]) => endpoint ? ({ target, label, kind, managed: true, state: "healthy",
      snapshot: { target, endpoint, ...(target.startsWith("codex") ? { registrationId: siwcAccount.registrationId, migrationRequired: false } : {}),
        auth: { configured: true, disclosure: "rotate-only", ...(target.startsWith("codex") ? { account: siwcAccount } : {}) },
        canRotateCredential: true }, actions }) : target === "n8n-supergrok-oauth" ? ({ target, label, kind, managed: true, state: "healthy", snapshot: { target, endpoint: "http://n8n-supergrok:14502/v1", auth: { configured: true, disclosure: "one-time" }, canRemove: true }, actions: ["sign-in-grok-build", "sign-out-grok-build", "remove-owned-supergrok"] }) : ({ target, label, kind, managed: false, state: "absent", snapshot: null, actions: ["setup"] })),
  };
  const makeNode = () => ({ attributes: new Map(), children: [], lastElementChild: { textContent: "" }, checked: false, classList: { add() {}, remove() {}, toggle() {} }, dataset: {}, disabled: false, hidden: false, isConnected: true, readOnly: false, append(...items) { this.children.push(...items); }, add(item) { this.children.push(item); }, appendChild() {}, addEventListener() {}, focus() {}, getAttribute(name) { return this.attributes.get(name) ?? null; }, removeAttribute(name) { this.attributes.delete(name); }, replaceChildren(...items) { this.children = items; }, select() {}, setAttribute(name, value) { this.attributes.set(name, String(value)); }, setCustomValidity() {}, setSelectionRange() {}, querySelector() { return makeNode(); }, querySelectorAll() { return []; }, reportValidity() { return true; }, style: {}, textContent: "", type: "password", value: "" });
  const html = await readFile("src/ui/local.html", "utf8");
  const nodes = new Map([...html.matchAll(/\bid="([^"\s]+)"/gu)].map(([, id]) => [id, makeNode()]));
  const createdNodes = new Map();
  const createElement = () => {
    const node = makeNode();
    Object.defineProperty(node, "id", { get() { return node._id ?? ""; }, set(id) { node._id = id; createdNodes.set(id, node); } });
    return node;
  };
  const element = (id) => nodes.get(id) ?? createdNodes.get(id) ?? null;
  const document = { activeElement: null, body: makeNode(), createElement, execCommand() { return false; }, getElementById: element, addEventListener() {}, querySelector(selector) { return selector.includes('name="target"') ? { value: "xai-grok-build", checked: true } : null; }, querySelectorAll() { return []; } }; document.body.dataset = {};
  const window = { addEventListener() {}, clearInterval() {}, clearTimeout() {}, location: { hash: "" }, matchMedia() { return { matches: true }; }, scrollTo() {}, setInterval() { return 1; }, setTimeout() { return 1; } };
  const fetch = async (path) => ({ ok: true, async json() { return path === "/api/local/dashboard" ? fixture : path === "/api/local/project-meta" ? { version: "0.13.0", stars: null } : {}; } });
  runInNewContext(`${shared}\n${script}`, { readWizardSession: () => "a".repeat(43), bindWizardNavigation() {}, initWizardTopbar() {},
    INITIAL_CHAT_TESTER_FEEDBACK: {}, nextChatTesterFeedback: () => ({}),
    Option: class { constructor(text, value) { this.textContent = text; this.value = value; } },
    URL, URLSearchParams, AbortController, Date, Intl, JSON, Math, Promise, TextDecoder, TextEncoder, Uint8Array, btoa(value) { return value; }, clearFieldError, clearTimeout() {}, crypto: { getRandomValues() {}, subtle: {} }, document, fetch, navigator: {}, setFieldError, setTimeout() { return 1; }, window }, { filename: "local-healthy-dashboard.vm.js", timeout: 1_000 });
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(element("dashboard-runtime-health").textContent, "Healthy");
  assert.equal(element("dashboard-provider-readiness").textContent, "Provider-managed · not inspected");
  assert.notEqual(element("dashboard-last-checked").textContent, "Unavailable");
});

const ATTEMPT_ID = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
const OTHER_ATTEMPT_ID = "bbbbbbbb-bbbb-cccc-dddd-eeeeeeeeeeee";
const RETRY_BLOCKED_MESSAGE =
  "ChatGPT sign-in could not be stopped safely. Close the sign-in helper, then restart Relmio.";

function extractBetween(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  const end = source.indexOf(endMarker, start + startMarker.length);
  assert.ok(start >= 0, `missing source marker: ${startMarker}`);
  assert.ok(end > start, `missing source end marker: ${endMarker}`);
  return source.slice(start, end);
}

function createOAuthControl(text = "") {
  const attributes = new Map();
  return {
    attributes,
    dataset: {},
    disabled: false,
    handlers: {},
    hidden: true,
    href: "",
    tabIndex: 0,
    textContent: text,
    value: "",
    addEventListener(event, callback) {
      this.handlers[event] = callback;
    },
    click() {
      this.lastClick = this.handlers.click?.({
        currentTarget: this,
        preventDefault() {},
      });
      return this.lastClick;
    },
    getAttribute(name) {
      return this.attributes.get(name) ?? null;
    },
    removeAttribute(name) {
      this.attributes.delete(name);
      if (name === "href") this.href = "";
    },
    setAttribute(name, value) {
      this.attributes.set(name, String(value));
    },
  };
}

function loadN8nOAuthHandlers(script, respond) {
  const controls = extractBetween(
    script,
    "async function refreshN8nOAuthStatus",
    "\nfunction invalidateLocalModelReview",
  );
  const listeners = extractBetween(
    script,
    'element("refresh-local-n8n-chatgpt").addEventListener',
    "\nfunction updateInstalledOwnerApproval",
  );
  const elements = new Map([
    ["n8n-oauth-link", createOAuthControl("Open fresh ChatGPT sign-in")],
    ["n8n-oauth-status", createOAuthControl("Checking local ChatGPT sign-in…")],
    ["n8n-oauth-sign-in", createOAuthControl("Sign in to ChatGPT")],
    ["refresh-local-n8n-chatgpt", createOAuthControl("Refresh ChatGPT sign-in")],
    ["n8n-oauth-refresh", createOAuthControl("Refresh status")],
    ["local-siwc", createOAuthControl()],
    ["refresh-bridge-confirm", createOAuthControl()],
    ["refresh-bridge-button", createOAuthControl()],
    ["refresh-bridge-status", createOAuthControl()],
  ]);
  const harness = {
    calls: [],
    elements,
    errors: [],
    messages: [],
    opened: [],
    selectedTargets: [],
    state: {
      n8nOAuthAttemptId: null,
      n8nOAuthCancellationMessage: "",
      n8nOAuthExists: false,
      n8nOAuthGeneration: 0,
      n8nOAuthRetryBlocked: false,
      suppressTargetRefresh: false,
      target: "n8n-openai-oauth",
      n8nOAuthIntent: { purpose: "sign-in" },
    },
  };
  let operationBusy = false;
  const context = {
    Date,
    accountUiState, siwcErrorFromResponse,
    siwc: {
      async load() {
        const result = await context.api("/api/siwc/accounts");
        return result.accounts[0];
      },
      async authorized() { return this.load(); },
      isUsageLimited() { return false; },
    },
    api: async (path, options = {}) => {
      const call = {
        path,
        method: options.method ?? "GET",
        body: options.body ?? null,
        stopVisible: elements.get("n8n-oauth-link").hidden === false,
        stopLabel: elements.get("n8n-oauth-link").textContent,
        linkHref: elements.get("n8n-oauth-link").href,
      };
      harness.calls.push(call);
      return respond(call, harness);
    },
    clearError() {},
    delay: async () => {},
    element: (id) => elements.get(id),
    selectN8nManagementTarget(target) {
      harness.selectedTargets.push(target);
      harness.state.target = target;
    },
    setBusy(button, busy, label) {
      if (busy) {
        if (operationBusy) return false;
        operationBusy = true;
        button.priorDisabled = button.disabled;
        if (!button.dataset.label) button.dataset.label = button.textContent.trim();
        button.textContent = label;
        button.setAttribute("aria-busy", "true");
        return true;
      }
      operationBusy = false;
      button.disabled = button.priorDisabled ?? false;
      elements.get("refresh-local-n8n-chatgpt").disabled = false;
      button.setAttribute("aria-busy", "false");
      button.textContent = button.dataset.label ?? button.textContent;
      return true;
    },
    setMessage(message) {
      harness.messages.push(message);
    },
    showError(error) {
      harness.errors.push(error);
    },
    sidecarOAuthExists(result) {
      return result?.authExists === true;
    },
    state: harness.state,
    updateReviewAvailability() {
      harness.reviewUpdates = (harness.reviewUpdates ?? 0) + 1;
      harness.reviewReady = harness.state.n8nOAuthExists === true;
    },
    window: {
      open(...args) {
        harness.opened.push(args);
        return { close() {}, location: { replace() {} }, opener: {} };
      },
    },
  };
  const handlers = runInNewContext(
    `${controls}\n${listeners}\n({
      refreshSignIn: element("refresh-local-n8n-chatgpt").handlers.click,
      signIn: element("n8n-oauth-sign-in").handlers.click,
      stop: stopN8nOAuthSignIn,
    })`,
    context,
    { filename: "local-n8n-oauth-ui.vm.js", timeout: 1_000 },
  );
  Object.assign(harness, handlers);
  return harness;
}

function signedInStatus() {
  return { accounts: [siwcAccount] };
}

test("local sign-in accepts system-browser launch and reloads the selected SIWC account", async () => {
  const script = await readFile("src/ui/local.js", "utf8");
  let statusPolls = 0;
  const harness = loadN8nOAuthHandlers(script, (call) => {
    if (call.path === "/api/oauth/status" && call.method === "GET" && statusPolls === 0) {
      statusPolls += 1;
      return { status: "idle" };
    }
    if (call.path === "/api/oauth/login") {
      return { launchMode: "system-browser", attemptId: ATTEMPT_ID };
    }
    if (call.path === "/api/oauth/status") {
      return { status: "success", attemptId: ATTEMPT_ID };
    }
    if (call.path === "/api/siwc/accounts") return signedInStatus();
    throw new Error(`unexpected ${call.method} ${call.path}`);
  });

  await harness.signIn({ currentTarget: harness.elements.get("n8n-oauth-sign-in") });

  assert.deepEqual(harness.opened, []);
  assert.equal(
    harness.calls.some((call) => call.path === "/api/oauth/login" && call.method === "POST"),
    true,
  );
  assert.deepEqual(
    JSON.parse(JSON.stringify(
      harness.calls.find((call) => call.path === "/api/oauth/login").body,
    )),
    { purpose: "sign-in" },
  );
  const waited = harness.calls.find(
    (call) => call.path === "/api/oauth/status" && call.stopVisible === true,
  );
  assert.equal(waited.stopLabel, "Stop ChatGPT sign-in");
  assert.equal(waited.linkHref, "");
  assert.equal(
    harness.calls.some((call) => call.body && Object.hasOwn(call.body, "authorizationUrl")),
    false,
  );
  assert.equal(harness.state.n8nOAuthExists, true);
  assert.equal(harness.reviewReady, true);
  assert.equal(harness.elements.get("n8n-oauth-link").hidden, true);
  assert.equal(harness.elements.get("n8n-oauth-link").href, "");
  assert.equal(harness.errors.length, 0);
  // The account card shows plan use, so the sidecar status line stays empty while the
  // result is still announced.
  assert.equal(harness.elements.get("n8n-oauth-status").textContent, "");
  assert.match(harness.messages.at(-1), new RegExp(siwcAccount.label, "u"));
});

test("a chat tester error and its Manage usage recovery scroll into view before focus", async () => {
  const script = await readFile("src/ui/local.js", "utf8");
  const source = extractBetween(script, "function showChatTesterError(", "\nfunction appendChatTesterTurn");
  const events = [];
  const nodes = new Map();
  const element = (id) => {
    if (!nodes.has(id)) nodes.set(id, { id, hidden: true, textContent: "",
      scrollIntoView(options) { events.push(["scroll", id, options.block, this.hidden]); },
      focus(options) { events.push(["focus", id, options?.preventScroll === true]); } });
    return nodes.get(id);
  };
  const { show, reveal } = runInNewContext(`${source}; ({ show: showChatTesterError, reveal: revealChatTesterError })`,
    { element, siwcErrorText: (error) => error.message });

  show({ message: "Usage limit reached", recovery: "manage-usage" });
  assert.equal(element("chat-tester-usage").hidden, false);
  assert.deepEqual(events, [
    ["scroll", "chat-tester-error", "nearest", false],
    ["scroll", "chat-tester-usage", "nearest", false],
    ["focus", "chat-tester-error", true],
  ]);

  events.length = 0;
  show({ message: "Request failed", recovery: "fix-request" });
  assert.equal(element("chat-tester-usage").hidden, true);
  assert.deepEqual(events.map(([kind, id]) => [kind, id]), [["scroll", "chat-tester-error"], ["focus", "chat-tester-error"]]);

  // After the send handler restores its buttons, the shown error is scrolled into view again
  // without moving focus; a hidden error scrolls nothing.
  events.length = 0;
  reveal();
  assert.deepEqual(events.map(([kind, id]) => [kind, id]), [["scroll", "chat-tester-error"]]);
  element("chat-tester-error").hidden = true;
  events.length = 0;
  reveal();
  assert.deepEqual(events, []);
});

test("fresh account setup uses the same system-browser flow without copying credentials", async () => {
  const script = await readFile("src/ui/local.js", "utf8");
  let seenStatus = false;
  const harness = loadN8nOAuthHandlers(script, (call) => {
    if (call.path === "/api/oauth/status" && !seenStatus) {
      seenStatus = true;
      return { status: "idle" };
    }
    if (call.path === "/api/oauth/login") {
      return { launchMode: "system-browser", attemptId: ATTEMPT_ID };
    }
    if (call.path === "/api/oauth/status") {
      return { status: "success", attemptId: ATTEMPT_ID };
    }
    if (call.path === "/api/siwc/accounts") return signedInStatus();
    throw new Error(`unexpected ${call.method} ${call.path}`);
  });
  harness.state.n8nOAuthExists = true;

  const refresh = harness.refreshSignIn({
    currentTarget: harness.elements.get("refresh-local-n8n-chatgpt"),
  });
  await harness.elements.get("n8n-oauth-sign-in").lastClick;
  await refresh;
  assert.equal(harness.calls.filter((call) => call.path === "/api/oauth/login").length, 1);
  assert.equal(harness.calls.some((call) => call.path === "/api/local/n8n/sidecar/refresh"), false);
});

test("a pending local sign-in is resumed instead of starting another login", async () => {
  const script = await readFile("src/ui/local.js", "utf8");
  let polls = 0;
  const harness = loadN8nOAuthHandlers(script, (call) => {
    if (call.path === "/api/oauth/login") {
      throw new Error("pending sign-in must not be replaced");
    }
    if (call.path === "/api/oauth/status") {
      polls += 1;
      return polls === 1
        ? { status: "pending", attemptId: ATTEMPT_ID }
        : { status: "success", attemptId: ATTEMPT_ID };
    }
    if (call.path === "/api/siwc/accounts") return signedInStatus();
    throw new Error(`unexpected ${call.method} ${call.path}`);
  });

  await harness.signIn({ currentTarget: harness.elements.get("n8n-oauth-sign-in") });

  assert.equal(harness.calls.some((call) => call.path === "/api/oauth/login"), false);
  assert.equal(harness.state.n8nOAuthExists, true);
  assert.equal(harness.errors.length, 0);
});

test("a second local sign-in click does not start another attempt while one is pending", async () => {
  const script = await readFile("src/ui/local.js", "utf8");
  let releaseFirstStatus;
  const firstStatus = new Promise((resolve) => {
    releaseFirstStatus = resolve;
  });
  const harness = loadN8nOAuthHandlers(script, async (call) => {
    if (call.path === "/api/oauth/status" && harness.calls.length === 1) {
      await firstStatus;
      return { status: "idle" };
    }
    if (call.path === "/api/oauth/login") {
      return { launchMode: "system-browser", attemptId: ATTEMPT_ID };
    }
    if (call.path === "/api/oauth/status") {
      return { status: "success", attemptId: ATTEMPT_ID };
    }
    if (call.path === "/api/siwc/accounts") return signedInStatus();
    throw new Error(`unexpected ${call.method} ${call.path}`);
  });
  const button = harness.elements.get("n8n-oauth-sign-in");
  const first = harness.signIn({ currentTarget: button });
  await harness.signIn({ currentTarget: button });
  assert.equal(harness.calls.filter((call) => call.path === "/api/oauth/login").length, 0);
  releaseFirstStatus();
  await first;
  assert.equal(harness.calls.filter((call) => call.path === "/api/oauth/login").length, 1);
});

test("retryBlocked disables local sign-in retries and shows the safe restart instruction", async () => {
  const script = await readFile("src/ui/local.js", "utf8");
  const harness = loadN8nOAuthHandlers(script, (call) => {
    if (call.path === "/api/oauth/status") {
      return {
        status: "error",
        error: RETRY_BLOCKED_MESSAGE,
        retryBlocked: true,
      };
    }
    throw new Error(`unexpected ${call.method} ${call.path}`);
  });
  const button = harness.elements.get("n8n-oauth-sign-in");

  await harness.signIn({ currentTarget: button });
  await harness.signIn({ currentTarget: button });
  await harness.refreshSignIn({
    currentTarget: harness.elements.get("refresh-local-n8n-chatgpt"),
  });

  assert.equal(harness.calls.some((call) => call.path === "/api/oauth/login"), false);
  assert.equal(button.disabled, true);
  assert.equal(harness.elements.get("refresh-local-n8n-chatgpt").disabled, true);
  assert.equal(harness.errors[0].oauthRetryBlocked, true);
  assert.equal(harness.state.n8nOAuthRetryBlocked, true);
  assert.equal(harness.elements.get("n8n-oauth-link").hidden, true);
});

test("Stop cancels only the current local sign-in attempt", async () => {
  const script = await readFile("src/ui/local.js", "utf8");
  let releaseStatus;
  const waiting = new Promise((resolve) => {
    releaseStatus = resolve;
  });
  const harness = loadN8nOAuthHandlers(script, async (call) => {
    if (call.path === "/api/oauth/status" && harness.calls.length === 1) {
      return { status: "idle" };
    }
    if (call.path === "/api/oauth/login") {
      return { launchMode: "system-browser", attemptId: ATTEMPT_ID };
    }
    if (call.path === "/api/oauth/status") {
      await waiting;
      return { status: "pending", attemptId: ATTEMPT_ID };
    }
    if (call.path === "/api/oauth/cancel") {
      return { status: "cancelled", attemptId: call.body.attemptId };
    }
    throw new Error(`unexpected ${call.method} ${call.path}`);
  });
  const button = harness.elements.get("n8n-oauth-sign-in");
  const pending = harness.signIn({ currentTarget: button });
  const stopLink = harness.elements.get("n8n-oauth-link");
  for (let turn = 0; stopLink.hidden && turn < 20; turn += 1) {
    await Promise.resolve();
  }
  assert.equal(stopLink.hidden, false);
  await harness.stop({
    currentTarget: harness.elements.get("n8n-oauth-link"),
    preventDefault() {},
  });
  releaseStatus();
  await pending;

  const cancel = harness.calls.find((call) => call.path === "/api/oauth/cancel");
  assert.equal(cancel.method, "POST");
  assert.deepEqual(JSON.parse(JSON.stringify(cancel.body)), { attemptId: ATTEMPT_ID });
  assert.equal(harness.calls.filter((call) => call.path === "/api/oauth/login").length, 1);
  assert.equal(harness.state.n8nOAuthExists, false);
  assert.equal(harness.elements.get("n8n-oauth-link").hidden, true);
  assert.equal(harness.elements.get("n8n-oauth-link").href, "");
});

test("stopping a local sign-in releases the Stop control for the next attempt", async () => {
  const script = await readFile("src/ui/local.js", "utf8");
  let releaseStatus;
  let waiting;
  let pending = false;
  const harness = loadN8nOAuthHandlers(script, async (call) => {
    if (call.path === "/api/oauth/status" && !pending) return { status: "idle" };
    if (call.path === "/api/oauth/login") {
      pending = true;
      waiting = new Promise((resolve) => { releaseStatus = resolve; });
      return { launchMode: "system-browser", attemptId: ATTEMPT_ID };
    }
    if (call.path === "/api/oauth/status") {
      await waiting;
      return { status: "pending", attemptId: ATTEMPT_ID };
    }
    if (call.path === "/api/oauth/cancel") {
      pending = false;
      return { status: "cancelled", attemptId: call.body.attemptId };
    }
    throw new Error(`unexpected ${call.method} ${call.path}`);
  });
  const button = harness.elements.get("n8n-oauth-sign-in");
  const stop = harness.elements.get("n8n-oauth-link");
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const started = harness.signIn({ currentTarget: button });
    for (let turn = 0; stop.hidden && turn < 20; turn += 1) await Promise.resolve();
    assert.equal(stop.hidden, false);
    await harness.stop({ currentTarget: stop, preventDefault() {} });
    releaseStatus();
    await started;
    assert.equal(stop.getAttribute("aria-busy"), "false");
    assert.equal(stop.hidden, true);
  }
  assert.equal(harness.calls.filter((call) => call.path === "/api/oauth/login").length, 2);
  assert.equal(harness.calls.filter((call) => call.path === "/api/oauth/cancel").length, 2);
});

test("a replaced local sign-in attempt is not treated as success", async () => {
  const script = await readFile("src/ui/local.js", "utf8");
  const harness = loadN8nOAuthHandlers(script, (call) => {
    if (call.path === "/api/oauth/status" && harness.calls.length === 1) return { status: "idle" };
    if (call.path === "/api/oauth/login") {
      return { launchMode: "system-browser", attemptId: ATTEMPT_ID };
    }
    if (call.path === "/api/oauth/status") {
      return { status: "success", attemptId: OTHER_ATTEMPT_ID };
    }
    throw new Error(`unexpected ${call.method} ${call.path}`);
  });

  await harness.signIn({ currentTarget: harness.elements.get("n8n-oauth-sign-in") });

  assert.equal(harness.errors.length, 1);
  assert.equal(harness.state.n8nOAuthExists, false);
  assert.equal(harness.calls.some((call) => call.path === "/api/siwc/accounts" &&
    harness.state.n8nOAuthExists), false);
});

test("Codex targets use independently scoped SIWC browser authorization without native login RPC", async () => {
  const script = await readFile("src/ui/local.js", "utf8");
  for (const target of ["codex-chatgpt", "codex-chat"]) {
    const harness = loadN8nOAuthHandlers(script, (call) => {
      if (call.path === "/api/oauth/login") return { launchMode: "system-browser", attemptId: ATTEMPT_ID };
      if (call.path === "/api/oauth/status") return harness.calls.length === 1
        ? { status: "idle" } : { status: "success", attemptId: ATTEMPT_ID };
      if (call.path === "/api/siwc/accounts") return signedInStatus();
      throw new Error("Unexpected native login boundary.");
    });
    harness.state.target = target;
    harness.state.n8nOAuthIntent = { purpose: "sign-in", registrationId: siwcAccount.registrationId };
    await harness.signIn({ currentTarget: harness.elements.get("n8n-oauth-sign-in") });
    const login = harness.calls.find((call) => call.path === "/api/oauth/login");
    assert.equal(login.body.registrationId, siwcAccount.registrationId);
    assert.equal(harness.calls.some((call) => call.path.startsWith("/api/local/codex/")), false);
    assert.equal(harness.opened.length, 0);
    assert.equal(harness.errors.length, 0);
  }
});

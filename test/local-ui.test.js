import { runInNewContext } from "node:vm";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const VOID_ELEMENTS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta",
  "path", "rect", "source", "track", "wbr",
]);

function readyPanelParents(html) {
  const start = html.indexOf('<section class="panel success-panel"');
  assert.notEqual(start, -1, "expected the ready panel");
  const stack = [];
  const parents = new Map();
  const actions = [];
  const tags = /<\/?([A-Za-z][\w:-]*)(?:\s[^>]*)?>/gu;
  tags.lastIndex = start;

  for (const match of html.matchAll(tags)) {
    if (match.index < start) continue;
    const raw = match[0];
    const tag = match[1].toLowerCase();
    const closing = raw.startsWith("</");
    if (closing) {
      if (VOID_ELEMENTS.has(tag)) continue;
      const node = stack.pop();
      assert.ok(node, `unexpected closing </${tag}> in ready panel`);
      assert.equal(node.tag, tag, `invalid ready panel nesting at </${tag}>`);
      if (stack.length === 0) return { actions, parents };
      continue;
    }
    const id = raw.match(/\bid="([^"\s]+)"/u)?.[1] ?? null;
    const classes = new Set((raw.match(/\bclass="([^"]*)"/u)?.[1] ?? "").split(/\s+/u).filter(Boolean));
    const node = { tag, id, classes };
    const parent = stack.at(-1) ?? null;
    if (id) parents.set(id, parent);
    if (classes.has("actions")) actions.push(parent);
    if (!VOID_ELEMENTS.has(tag) && !raw.endsWith("/>") ) stack.push(node);
  }
  assert.fail("ready panel did not close");
}

test("Test AI Chat exposes a quiet accessible streaming lifecycle", async () => {
  const [html, script, css] = await Promise.all([
    readFile("src/ui/local.html", "utf8"),
    readFile("src/ui/local.js", "utf8"),
    readFile("src/ui/local.css", "utf8"),
  ]);

  assert.match(html, /id="chat-tester-stop"[\s\S]*aria-label="Stop response"/u);
  assert.match(
    html,
    /id="chat-tester-status"[^>]*role="status"[^>]*aria-live="polite"[^>]*aria-atomic="true"/u,
  );
  assert.match(
    html,
    /id="chat-tester-transcript"[\s\S]*role="log"[\s\S]*aria-busy="false"[\s\S]*aria-relevant="additions"/u,
  );
  assert.match(script, /nextChatTesterFeedback/u);
  assert.match(script, /new AbortController\(\)/u);
  assert.match(script, /signal: controller\.signal/u);
  assert.match(script, /markMainBusy: false/u);
  assert.match(
    script,
    /chat-tester-transcript"\)\.setAttribute\("aria-busy", "true"\)/u,
  );
  assert.match(
    script,
    /chat-tester-transcript"\)\.setAttribute\("aria-busy", "false"\)/u,
  );
  assert.match(script, /type: "stopping"/u);
  assert.match(script, /type: "stopped"/u);
  assert.match(script, /data\.text\.length === 0/u);
  assert.match(
    script,
    /if \(feedback\.phase !== previous\.phase\) \{\s*setChatTesterStatus/u,
  );
  assert.match(css, /chat-tester-turn-waiting/u);
  assert.match(css, /chat-tester-stream-cursor/u);

  const reducedMotion = css.slice(
    css.indexOf("@media (prefers-reduced-motion: reduce)"),
  );
  assert.match(
    reducedMotion,
    /chat-tester-turn-waiting[\s\S]*chat-tester-stream-cursor[\s\S]*animation:\s*none/u,
  );
});

test("ready-panel credential and action controls are siblings of its flex heading", async () => {
  const html = await readFile("src/ui/local.html", "utf8");
  const { actions, parents } = readyPanelParents(html);
  const oneTimeNoteParent = parents.get("one-time-note");
  const resultParent = parents.get("install-result-list");

  assert.ok(oneTimeNoteParent?.classes.has("success-panel"));
  assert.ok(resultParent?.classes.has("success-panel"));
  assert.ok(!oneTimeNoteParent?.classes.has("success-heading"));
  assert.ok(!resultParent?.classes.has("success-heading"));
  assert.ok(actions.some((parent) => parent?.classes.has("success-panel")));
  assert.ok(!actions.some((parent) => parent?.classes.has("success-heading")));
});

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

test("the complete local script bootstraps without retired tail initializers", async () => {
  const { runInNewContext } = await import("node:vm");
  const script = (await readFile("src/ui/local.js", "utf8"))
    .replace(/^import .*?;\r?\n/u, "const readWizardSession = () => null; const bindWizardNavigation = () => {};\n")
    .replace(/import \{[\s\S]*?\} from "\.\/chat-tester-feedback\.js";\r?\n/u, "const INITIAL_CHAT_TESTER_FEEDBACK = {}; const nextChatTesterFeedback = () => ({});\n");
  const makeNode = () => ({
    attributes: new Map(),
    checked: false,
    classList: { add() {}, remove() {}, toggle() {} },
    dataset: {}, disabled: false, hidden: false, isConnected: true, readOnly: false,
    append() {}, appendChild() {}, addEventListener() {}, focus() {}, removeAttribute() {}, replaceChildren() {}, select() {}, setAttribute() {}, setCustomValidity() {}, setSelectionRange() {},
    querySelector() { return null; }, querySelectorAll() { return []; }, reportValidity() { return true; },
    style: {}, textContent: "", type: "password", value: "",
  });
  const html = await readFile("src/ui/local.html", "utf8");
  const nodes = new Map(
    [...html.matchAll(/\bid="([^"\s]+)"/gu)].map(([, id]) => [id, makeNode()]),
  );
  const createdNodes = new Map();
  const createElement = () => {
    const node = makeNode();
    Object.defineProperty(node, "id", {
      get() { return node._id ?? ""; },
      set(id) { node._id = id; createdNodes.set(id, node); },
    });
    return node;
  };
  const element = (id) => nodes.get(id) ?? createdNodes.get(id) ?? null;
  const document = {
    activeElement: null, body: makeNode(), createElement,
    execCommand() { return false; }, getElementById: element,
    addEventListener() {}, querySelector() { return null; }, querySelectorAll() { return []; },
  };
  document.body.dataset = {};
  const window = {
    addEventListener() {}, clearInterval() {}, clearTimeout() {}, location: { hash: "" },
    matchMedia() { return { matches: true }; }, scrollTo() {}, setInterval() { return 1; }, setTimeout() { return 1; },
  };
  runInNewContext(script, { URL, URLSearchParams, AbortController, Date, Intl, JSON, Math, Promise, TextDecoder, TextEncoder, Uint8Array, btoa(value) { return value; }, clearTimeout() {}, crypto: { getRandomValues() {}, subtle: {} }, document, fetch() { throw new Error("fetch must not run without a wizard token"); }, navigator: {}, setTimeout() { return 1; }, window }, { filename: "local-whole-bootstrap.vm.js", timeout: 1_000 });
  await Promise.resolve();
  assert.ok(nodes.has("dashboard-refresh"));
});

test("the complete script renders a healthy OAuth inventory instead of falling back to unavailable", async () => {
  const { runInNewContext } = await import("node:vm");
  const script = (await readFile("src/ui/local.js", "utf8"))
    .replace(/^import .*?;\r?\n/u, "const readWizardSession = () => 'a'.repeat(43); const bindWizardNavigation = () => {};\n")
    .replace(/import \{[\s\S]*?\} from "\.\/chat-tester-feedback\.js";\r?\n/u, "const INITIAL_CHAT_TESTER_FEEDBACK = {}; const nextChatTesterFeedback = () => ({});\n");
  const fixture = {
    schemaVersion: 1, generatedAt: new Date().toISOString(),
    docker: { available: true, version: "29.7.2", composeVersion: "2.39.1" }, auth: { secretsRevealable: false },
    providers: [["codex-chatgpt", "ChatGPT"], ["codex-chat", "ChatGPT"], ["xai-grok-build", "SuperGrok"], ["n8n-supergrok-oauth", "SuperGrok (n8n)"]].map(([target, label]) => ({ target, label, authentication: "provider-oauth", readiness: "runtime-owned" })),
    services: [
      ["codex-chatgpt", "Codex (ChatGPT login)", "endpoint", "ws://127.0.0.1:14500/", ["sign-in-chatgpt", "sign-out-chatgpt", "rotate-local-capability"]],
      ["codex-chat", "Codex Chat adapter", "endpoint", "http://127.0.0.1:14501/", ["sign-in-chatgpt", "sign-out-chatgpt", "rotate-local-capability"]],
      ["xai-grok-build", "SuperGrok", "endpoint", "http://127.0.0.1:14502/", ["sign-in-grok-build", "sign-out-grok-build", "rotate-local-capability"]],
      ["local-n8n-stack", "n8n + ngrok", "n8n-stack"], ["n8n-openai-oauth", "OpenAI OAuth bridge", "n8n-oauth-bridge"], ["local-n8n-assistant", "AI Assistant tools", "n8n-assistant"], ["n8n-supergrok-oauth", "SuperGrok for n8n", "n8n-supergrok"],
      ["n8n-local-model", "Local model for n8n", "n8n-local-model"],
    ].map(([target, label, kind, endpoint, actions]) => endpoint ? ({ target, label, kind, managed: true, state: "healthy", snapshot: { target, endpoint, auth: { configured: true, disclosure: "rotate-only" }, canRotateCredential: true }, actions }) : target === "n8n-supergrok-oauth" ? ({ target, label, kind, managed: true, state: "healthy", snapshot: { target, endpoint: "http://n8n-supergrok:14502/v1", auth: { configured: true, disclosure: "one-time" }, canRemove: true }, actions: ["sign-in-grok-build", "sign-out-grok-build", "remove-owned-supergrok"] }) : ({ target, label, kind, managed: false, state: "absent", snapshot: null, actions: ["setup"] })),
  };
  const makeNode = () => ({ attributes: new Map(), checked: false, classList: { add() {}, remove() {}, toggle() {} }, dataset: {}, disabled: false, hidden: false, isConnected: true, readOnly: false, append() {}, appendChild() {}, addEventListener() {}, focus() {}, removeAttribute() {}, replaceChildren() {}, select() {}, setAttribute() {}, setCustomValidity() {}, setSelectionRange() {}, querySelector() { return null; }, querySelectorAll() { return []; }, reportValidity() { return true; }, style: {}, textContent: "", type: "password", value: "" });
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
  runInNewContext(script, { URL, URLSearchParams, AbortController, Date, Intl, JSON, Math, Promise, TextDecoder, TextEncoder, Uint8Array, btoa(value) { return value; }, clearTimeout() {}, crypto: { getRandomValues() {}, subtle: {} }, document, fetch, navigator: {}, setTimeout() { return 1; }, window }, { filename: "local-healthy-dashboard.vm.js", timeout: 1_000 });
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
    "function updateManagedBridgeRefreshControls",
    "\nfunction invalidatePlan",
  );
  const listeners = extractBetween(
    script,
    'element("refresh-local-n8n-chatgpt").addEventListener',
    'element("update-bridge-confirm").addEventListener',
  );
  const elements = new Map([
    ["n8n-oauth-link", createOAuthControl("Open fresh ChatGPT sign-in")],
    ["n8n-oauth-status", createOAuthControl("Checking local ChatGPT sign-in…")],
    ["n8n-oauth-sign-in", createOAuthControl("Sign in to ChatGPT")],
    ["refresh-local-n8n-chatgpt", createOAuthControl("Refresh ChatGPT sign-in")],
    ["n8n-oauth-refresh", createOAuthControl("Refresh status")],
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
    },
  };
  let operationBusy = false;
  const context = {
    Date,
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
      stop: element("n8n-oauth-link").handlers.click,
    })`,
    context,
    { filename: "local-n8n-oauth-ui.vm.js", timeout: 1_000 },
  );
  Object.assign(harness, handlers);
  return harness;
}

function signedInStatus() {
  return {
    authExists: true,
    authUpdatedAt: "2026-09-26T12:00:00.000Z",
  };
}

test("local n8n sign-in accepts system-browser launch and continues to bridge refresh", async () => {
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
    if (call.path === "/api/status") return signedInStatus();
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
    {},
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
  assert.match(
    harness.messages.join("\n"),
    /official ChatGPT sign-in window opened by Relmio/u,
  );
  assert.equal(harness.state.n8nOAuthExists, true);
  assert.equal(harness.reviewReady, true);
  assert.match(harness.elements.get("n8n-oauth-status").textContent, /^Signed in locally\./u);
  assert.equal(
    harness.elements.get("refresh-bridge-status").textContent,
    "New ChatGPT sign-in is ready, but has not been copied to any bridge. Confirm the separate action only if Relmio created that bridge.",
  );
  assert.equal(harness.elements.get("refresh-bridge-confirm").disabled, false);
  assert.equal(harness.elements.get("refresh-bridge-confirm").checked, false);
  assert.equal(harness.elements.get("refresh-bridge-button").disabled, true);
  assert.equal(harness.elements.get("n8n-oauth-link").hidden, true);
  assert.equal(harness.elements.get("n8n-oauth-link").href, "");
  assert.equal(harness.errors.length, 0);
});

test("refreshing ChatGPT sign-in for an existing bridge uses the same system-browser attempt", async () => {
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
    if (call.path === "/api/status") return signedInStatus();
    throw new Error(`unexpected ${call.method} ${call.path}`);
  });
  harness.state.n8nOAuthExists = true;

  const refresh = harness.refreshSignIn({
    currentTarget: harness.elements.get("refresh-local-n8n-chatgpt"),
  });
  await harness.elements.get("n8n-oauth-sign-in").lastClick;
  await refresh;
  assert.match(
    harness.elements.get("refresh-bridge-status").textContent,
    /has not been copied to any bridge/u,
  );
  assert.equal(harness.elements.get("refresh-bridge-button").disabled, true);
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
    if (call.path === "/api/status") return signedInStatus();
    throw new Error(`unexpected ${call.method} ${call.path}`);
  });

  await harness.signIn({ currentTarget: harness.elements.get("n8n-oauth-sign-in") });

  assert.equal(harness.calls.some((call) => call.path === "/api/oauth/login"), false);
  assert.match(harness.messages.join("\n"), /still in progress/u);
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
    if (call.path === "/api/status") return signedInStatus();
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
  assert.equal(harness.elements.get("n8n-oauth-status").textContent, RETRY_BLOCKED_MESSAGE);
  assert.equal(harness.errors[0].message, RETRY_BLOCKED_MESSAGE);
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
  assert.equal(harness.messages.at(-1), "ChatGPT sign-in stopped. You can start again.");
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

  assert.match(harness.errors[0].message, /replaced by a newer attempt/u);
  assert.equal(harness.state.n8nOAuthExists, false);
  assert.equal(harness.calls.some((call) => call.path === "/api/status"), false);
  assert.equal(harness.elements.get("refresh-bridge-button").disabled, true);
  assert.match(
    harness.elements.get("refresh-bridge-status").textContent,
    /Complete ChatGPT sign-in first/u,
  );
});

test("the Codex device-code sign-in stays separate from the n8n system-browser flow", async () => {
  const script = await readFile("src/ui/local.js", "utf8");
  const validators = extractBetween(
    script,
    "function validateVerificationUrl",
    "\nasync function copyText",
  );
  const listener = extractBetween(
    script,
    'element("codex-login-button").addEventListener',
    'for (const button of document.querySelectorAll("[data-copy-target]")',
  );
  const calls = [];
  const link = createOAuthControl();
  const code = createOAuthControl();
  const status = createOAuthControl();
  const result = createOAuthControl();
  const button = createOAuthControl("Sign in to ChatGPT");
  const elements = new Map([
    ["device-code-link", link],
    ["device-code", code],
    ["device-code-status", status],
    ["device-code-result", result],
    ["codex-login-button", button],
  ]);
  runInNewContext(`${validators}\n${listener}`, {
    URL,
    api: async (path, options = {}) => {
      calls.push({ path, method: options.method ?? "GET", body: options.body ?? null });
      if (path === "/api/local/codex/login") {
        return {
          verificationUrl: "https://auth.openai.com/codex/device",
          userCode: "ABCD-EFGH",
        };
      }
      if (path === "/api/local/codex/login/status") return { status: "success" };
      throw new Error(`unexpected ${path}`);
    },
    clearError() {},
    delay: async () => {},
    element: (id) => elements.get(id),
    isCodexChat: (target) => target === "codex-chat",
    setBusy: () => true,
    setMessage() {},
    showError(error) {
      throw error;
    },
    state: { installedTarget: "codex-chatgpt" },
  }, { filename: "local-codex-device-ui.vm.js", timeout: 1_000 });

  await button.handlers.click({ currentTarget: button });

  assert.equal(link.href, "https://auth.openai.com/codex/device");
  assert.equal(code.textContent, "ABCD-EFGH");
  assert.equal(calls.some((call) => call.path === "/api/oauth/login"), false);
  assert.equal(calls[0].path, "/api/local/codex/login");
  assert.deepEqual(JSON.parse(JSON.stringify(calls[0].body)), { target: "codex-chatgpt" });
});

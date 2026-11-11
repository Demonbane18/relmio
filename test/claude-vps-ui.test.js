import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { HOSTING_PROVIDERS } from "../src/domain/hosting-providers.js";
import { bindWizardNavigation, wizardApiError } from "../src/ui/session.js";
import { formatLocalDateTime } from "../src/ui/time.js";

const source = await readFile(new URL("../src/ui/claude-vps.js", import.meta.url), "utf8");
const fields = ["officialBinaryReviewed", "effectivePolicyReviewed", "nativeAuthAndBillingReviewed", "policyChangesControlled"];
const candidate = { version: "2.1.317", arch: "amd64", platform: "linux-x64", executableSha256: "a".repeat(64) };
const installation = { network: "n8n_default", arch: "amd64", models: ["claude-sonnet-5-5"], expiresAt: "2026-11-11T12:00:00Z", approvalExpired: false, container: "running", endpoint: "http://relmio-claude:14502/v1" };
const status = { state: "installed", candidate, installation, loginCommand: "ssh -t root@fixture.example sh /docker/n8n-openai-oauth/claude/login.sh" };
const settle = () => new Promise(resolve => setImmediate(resolve));

function fixture({ after = async () => {}, adoptCurrent = async () => { throw new Error("Connect to the VPS first."); }, initialReply } = {}) {
  const nodes = new Map();
  const calls = [];
  const guideErrors = [];
  const element = id => {
    if (!nodes.has(id)) nodes.set(id, {
      id, value: "", textContent: "", checked: false, hidden: false, disabled: false, isConnected: true,
      dataset: {}, handlers: {}, attributes: new Map(), children: [],
      classList: { toggle(name, on) { this[name] = on; } },
      addEventListener(name, fn) { this.handlers[name] = fn; },
      setAttribute(name, value) { this.attributes.set(name, value); },
      getAttribute(name) { return this.attributes.get(name) ?? null; },
      removeAttribute(name) { this.attributes.delete(name); }, toggleAttribute() {},
      querySelector() { return this; }, querySelectorAll() { return models; },
      focus() { context.document.activeElement = this; }, scrollIntoView() {}, closest() { return null; },
      getBoundingClientRect() { return { top: 100, bottom: 130 }; }, getClientRects() { return this.hidden ? [] : [{}]; },
      replaceChildren(...children) { this.children = children; if (["container", "network"].includes(this.id)) this.value = children[0]?.value ?? ""; }, append(...children) { this.children.push(...children); },
    });
    return nodes.get(id);
  };
  const reviews = fields.map(field => { const input = element(field); input.dataset.review = field; return input; });
  const models = [element("sonnet")]; models[0].value = "claude-sonnet-5-5"; models[0].checked = true;
  const actions = ["install", "replace", "renew", "sign-out", "remove"].map(action => { const button = element(action); button.dataset.action = action; return button; });
  element("container").value = "n8n"; element("network").value = "n8n_default";
  let reply = initialReply ?? (path => {
    if (path === "/api/vps/claude/status") return status;
    if (path === "/api/vps/claude/auth-status") return { loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" };
    if (path === "/api/vps/claude/models") return { models: ["claude-sonnet-5-5"] };
    return {};
  });
  const context = {
    readWizardSession: () => "fixture-token", initWizardTopbar() {}, wizardApiError, formatLocalDateTime,
    flashCopied(button) { button.copied = true; },
    relmioGuide: { error(error) { guideErrors.push(error); }, clearError() {} },
    createCredentialSshGuard: config => ({ before: async () => {}, after: async (...args) => after(config, ...args), adoptCurrent, refreshHostReport() {} }),
    bindSshAuthentication: () => ({ sync() {}, request: expectedFingerprint => ({ expectedFingerprint }) }), clearFieldError() {}, markRejectedField: text => text,
    document: { body: { dataset: {} }, getElementById: element,
      querySelector: selector => selector.startsWith("[data-review=") ? reviews.find(input => selector.includes(input.dataset.review)) : element("topbar"),
      querySelectorAll: selector => selector === "[data-review]" ? reviews : selector.startsWith('[name="claude-model"]') ? models.filter(input => !selector.endsWith(":checked") || input.checked) : selector === "[data-action]" ? actions : [],
      createElement: tag => element(`${tag}-${nodes.size}`), addEventListener() {},
    },
    window: { setInterval: () => 1, clearInterval() {}, addEventListener() {} }, innerHeight: 720,
    navigator: { clipboard: { writeText: async () => {} } },
    fetch: async (path, options) => {
      const body = options.body ? JSON.parse(options.body) : undefined;
      calls.push({ path, method: options.method, body });
      // A reply with httpStatus is a failed response.
      const { httpStatus = 200, ...value } = reply(path, body);
      return { ok: httpStatus < 400, status: httpStatus, json: async () => value };
    },
  };
  const ui = runInNewContext(`${source.replace(/^import .*;\r?\n/gmu, "")}\n({ state, beginAction, prepareReview, renderStatus, refreshStatus, syncConnectionControls, perform });`, context);
  return { ui, element, reviews, models, actions, calls, guideErrors, document: context.document, setReply(fn) { reply = fn; } };
}

function plan(action) {
  return { planId: "fixture-plan", plan: { action, installDirectory: "/docker/n8n-openai-oauth/claude", endpoint: installation.endpoint, network: installation.network,
    ...candidate, models: installation.models, expiresAt: installation.expiresAt, keepsClaudeLogin: action !== "install", existingN8nChanges: [], restarts: 0, publishedPorts: [], operationLockPath: "/docker/n8n-openai-oauth/.claude-operation.lock" } };
}

test("Claude owner review defaults unchecked and final consent gates exact action payloads", async () => {
  const f = fixture(); await settle();
  f.ui.renderStatus(status);
  for (const action of ["install", "replace", "renew"]) {
    f.ui.beginAction(action);
    assert.equal(f.reviews.every(input => !input.checked), true);
    await assert.rejects(() => f.ui.prepareReview(action), /all four owner reviews/u);
    assert.equal(f.calls.length, 0);
    f.reviews.forEach(input => { input.checked = true; });
    f.ui.syncConnectionControls();
    assert.equal(f.element("prepare-button").disabled, false);
    f.setReply(() => plan(action));
    await f.ui.prepareReview(action);
    const request = f.calls.pop();
    assert.equal(request.path, "/api/vps/claude/plan");
    assert.deepEqual(request.body, action === "renew" ? { action, review: Object.fromEntries(fields.map(key => [key, true])) }
      : { action, containerName: "n8n", networkName: "n8n_default", models: ["claude-sonnet-5-5"], review: Object.fromEntries(fields.map(key => [key, true])) });
    assert.equal(f.element("confirm-action").checked, false);
    assert.equal(f.element("apply-button").disabled, true);
    f.element("apply-button").handlers.click(); await settle();
    assert.equal(f.calls.length, 0);
  }
  for (const action of ["sign-out", "remove"]) {
    f.setReply(() => plan(action)); await f.ui.prepareReview(action);
    assert.deepEqual(f.calls.pop().body, { action });
  }
});

test("Claude applies only plan id and final consent, keeps one-time key through status refresh", async () => {
  const f = fixture(); await settle();
  f.ui.state.plan = plan("install"); f.element("confirm-action").checked = true;
  f.setReply(path => path.endsWith("/apply") ? { state: "installed", clientKey: "one-time-fixture-key" } : status);
  f.element("apply-button").handlers.click(); await settle();
  assert.deepEqual(f.calls[0], { path: "/api/vps/claude/apply", method: "POST", body: { planId: "fixture-plan", confirmed: true } });
  assert.equal(f.calls[1].method, "GET");
  assert.equal(f.element("client-key").value, "one-time-fixture-key");
  assert.equal(f.element("login-command").textContent, status.loginCommand);
  assert.equal(f.ui.state.plan, null);
  await f.ui.refreshStatus();
  assert.equal(f.element("client-key").value, "one-time-fixture-key");
  f.ui.renderStatus({ state: "absent", candidate, installation: null, loginCommand: status.loginCommand });
  assert.equal(f.element("client-key").value, "");
});

test("Claude rejects an altered write boundary and keeps invalid/manual status honest", async () => {
  const f = fixture(); await settle();
  f.reviews.forEach(input => { input.checked = true; });
  f.setReply(() => ({ ...plan("install"), plan: { ...plan("install").plan, publishedPorts: [14502] } }));
  await assert.rejects(() => f.ui.prepareReview("install"), /safety boundary/u);
  assert.equal(f.ui.state.plan, null);
  f.ui.renderStatus({ state: "invalid" });
  assert.equal(f.actions.every(button => button.hidden), true);
  f.ui.renderStatus({ state: "manual", candidate });
  assert.deepEqual(f.actions.filter(button => !button.hidden).map(button => button.dataset.action), ["replace"]);
});

test("Claude sign-in requires claude.ai and model checks send only the separate key", async () => {
  const f = fixture(); await settle();
  f.setReply(() => ({ loggedIn: true, authMethod: "api_key", subscriptionType: "<img src=x>" }));
  f.element("auth-button").handlers.click(); await settle();
  assert.match(f.element("login-state").textContent, /not ready/u);
  f.setReply(() => ({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "<img src=x>" }));
  f.element("auth-button").handlers.click(); await settle();
  assert.match(f.element("login-state").textContent, /<img src=x>/u);
  f.element("client-key").value = "separate-key";
  f.setReply(() => ({ models: ["<script>not markup</script>"] }));
  f.element("models-button").handlers.click(); await settle();
  assert.deepEqual(f.calls.at(-1).body, { clientKey: "separate-key" });
  assert.match(f.element("models-result").textContent, /<script>not markup<\/script>/u);
});

test("Claude routes preserve wizard sessions and hosting offers no credential artifact", async () => {
  const chooser = await readFile("src/ui/app.js", "utf8");
  const bindings = chooser.split("\n").filter(line => line.startsWith("bindWizardNavigation") && line.includes('"/claude-vps"')).join("\n");
  const links = [];
  runInNewContext(bindings, { token: "session", element: id => id, bindWizardNavigation: (...args) => links.push(args) });
  assert.deepEqual(links, [["vps-claude-start", "/claude-vps", "session"], ["vps-claude-manage", "/claude-vps", "session"]]);
  const hosting = await readFile("src/ui/hosting.js", "utf8");
  const routes = runInNewContext(`${hosting.slice(hosting.indexOf("const MANAGED_ROUTES"), hosting.indexOf("const KIND_LABELS"))}; MANAGED_ROUTES`);
  for (const provider of HOSTING_PROVIDERS) {
    const managed = ["managed-vm", "local"].includes(provider.kind);
    assert.equal(provider.components.claude.mode, managed ? "managed" : "unavailable");
    if (managed) assert.equal(routes[provider.kind].claude, provider.kind === "local" ? "/local" : "/claude-vps");
    else assert.match(provider.components.claude.note, /do not copy a Claude login into an artifact/u);
  }
});

test("Claude accepts private bootstrap transfer and same-tab navigation without URL credentials", async () => {
  const sessionToken = "C".repeat(43);
  const calls = [];
  const browserWindow = {
    name: `relmio-v1.${"A".repeat(43)}.${"B".repeat(43)}`,
    location: { pathname: "/claude-vps", hash: "", search: "", reload() { calls.push("reload"); } },
    history: {
      replaceState(state) { this.state = state; },
      pushState(state, _title, route) { this.state = state; calls.push(route); },
    },
  };
  runInNewContext(await readFile("src/ui/session-bootstrap.js", "utf8"), {
    window: browserWindow,
    fetch: async (_path, options) => {
      assert.equal(JSON.parse(options.body).route, "/claude-vps");
      return { ok: true, json: async () => ({ sessionToken }) };
    },
  });
  await browserWindow.__relmioWizardSessionReady;
  assert.equal(browserWindow.name, "");
  assert.equal(browserWindow.history.state.relmioWizardSession, sessionToken);
  let click;
  const link = { setAttribute(name, value) { this[name] = value; }, addEventListener(_name, handler) { click = handler; } };
  bindWizardNavigation(link, "/claude-vps", sessionToken, browserWindow);
  assert.equal(link.href, "/claude-vps");
  click({ button: 0, preventDefault() {} });
  assert.deepEqual(calls, ["/claude-vps", "reload"]);
  assert.equal(browserWindow.history.state.relmioWizardSession, sessionToken);
});

test("an installed companion remains manageable when n8n discovery is empty", async () => {
  const f = fixture({ adoptCurrent: async () => {}, initialReply: path => {
    if (path === "/api/discover") return { containers: [] };
    if (path === "/api/vps/claude/status") return status;
    return {};
  } });
  await settle();
  assert.deepEqual(f.calls.map(call => call.path), ["/api/discover", "/api/vps/claude/status"]);
  assert.equal(f.element("settings-panel").hidden, false);
  assert.equal(f.element("ssh-panel").hidden, true);
  assert.equal(f.element("container").value, "");
  assert.equal(f.element("network").value, "");
  assert.deepEqual(f.actions.filter(button => !button.hidden).map(button => button.dataset.action), ["renew", "sign-out", "remove"]);
  for (const action of ["renew", "sign-out", "remove"]) {
    f.reviews.forEach(input => { input.checked = true; });
    f.setReply(() => plan(action));
    await f.ui.prepareReview(action);
    assert.equal(f.calls.at(-1).body.action, action);
    assert.equal(f.element("review-panel").hidden, false);
  }
});

// The guide sends people who just started n8n to reload this page, not to Refresh status.
test("Refresh status rereads only the companion, and loading the page looks for n8n again", async () => {
  const replies = {
    "/api/discover": { containers: [{ name: "n8n", image: "n8nio/n8n" }] },
    "/api/networks": { networks: ["n8n_default"], recommended: "n8n_default" },
    "/api/vps/claude/status": { state: "absent", candidate },
  };
  const f = fixture({ adoptCurrent: async () => {}, initialReply: path => replies[path] ?? {} });
  await settle();
  assert.deepEqual(f.calls.map(call => call.path), ["/api/discover", "/api/networks", "/api/vps/claude/status"]);
  assert.equal(f.element("selection-panel").hidden, false);
  f.calls.length = 0;
  f.element("refresh-button").handlers.click(); await settle();
  assert.deepEqual(f.calls.map(call => call.path), ["/api/vps/claude/status"]);
});

test("a failed post-apply identity check retains the one-time result without another remote read", async () => {
  const f = fixture({ after: async (config, path) => {
    if (path === "/api/vps/claude/apply") {
      config.onMismatch();
      throw new Error("The SSH session could not be inspected.");
    }
  } });
  await settle();
  f.ui.state.plan = plan("install"); f.element("confirm-action").checked = true;
  f.setReply(() => ({ state: "installed", clientKey: "one-time-fixture-key" }));
  f.element("apply-button").handlers.click();
  await settle();
  assert.equal(f.element("client-key").value, "one-time-fixture-key");
  assert.equal(f.element("settings-panel").hidden, false);
  assert.equal(f.element("error-message").hidden, false);
  assert.deepEqual(f.calls.map(call => call.path), ["/api/vps/claude/apply"]);
  assert.equal(f.ui.state.plan, null);
});

test("a failed Claude call hands status, code and the unknown-outcome flag to error help", async () => {
  const f = fixture(); await settle();
  f.setReply(() => ({ httpStatus: 504, error: "The remote command timed out.", code: "vps_step_start", remoteOutcomeUnknown: true, recovery: "fix-request" }));
  f.element("auth-button").handlers.click(); await settle();
  const failure = f.guideErrors.at(-1);
  assert.equal(failure.message, "The remote command timed out.");
  assert.equal(failure.status, 504);
  assert.equal(failure.code, "vps_step_start");
  assert.equal(failure.remoteOutcomeUnknown, true);
  assert.equal(failure.recovery, undefined, "ChatGPT sign-in recovery advice is not carried over");
  assert.equal(f.element("error-message").textContent, "The remote command timed out.");
});

test("Claude approval dates are local times inside <time> that keeps the exact instant", async () => {
  const f = fixture(); await settle();
  f.ui.renderStatus(status);
  const [label, time] = f.element("approval-expiry").children;
  assert.equal(label, "Approval expires: ");
  assert.equal(time.getAttribute("datetime"), installation.expiresAt);
  assert.equal(time.textContent, formatLocalDateTime(installation.expiresAt));
  assert.notEqual(time.textContent, installation.expiresAt);
  f.reviews.forEach(input => { input.checked = true; });
  f.setReply(() => plan("renew"));
  await f.ui.prepareReview("renew");
  assert.equal(f.element("review-expiry").children[0].getAttribute("datetime"), installation.expiresAt);
  f.setReply(() => ({ ...plan("sign-out"), plan: { ...plan("sign-out").plan, expiresAt: undefined } }));
  await f.ui.prepareReview("sign-out");
  assert.deepEqual(f.element("review-expiry").children, ["Not renewed by this action"]);
});

test("a companion that is not running directs inspection without promising lock recovery", async () => {
  const f = fixture(); await settle();
  for (const container of ["restarting", "unhealthy", "stopped", "missing"]) {
    f.ui.renderStatus({ ...status, installation: { ...installation, container } });
    assert.equal(f.element("selection-panel").hidden, false, container);
    assert.equal(f.element("settings-panel").hidden, true, container);
    assert.match(f.element("installation-state").textContent, /Inspect the companion logs/u, container);
    assert.match(f.element("login-state").textContent, /stop every process and container.*account-lock recovery guide/u, container);
    assert.equal(f.element("login-state").dataset.guideState, "unchecked", container);
    assert.ok(f.actions.some(button => button.dataset.action === "replace" && !button.hidden), container);
    assert.equal(f.element("installation-state").dataset.guideState, "not-running", container);
    assert.equal(f.element("selection-replace").classList["rm-button--primary"], false, "Continue is the one primary action once a companion is installed");
  }
  // Expired approval remains visible without diagnosing why the runtime stopped.
  f.ui.renderStatus({ ...status, installation: { ...installation, container: "restarting", approvalExpired: true } });
  assert.equal(f.element("settings-panel").hidden, false, "renewal lives with the companion's settings");
  assert.match(f.element("login-state").textContent, /approval also expired.*Renew approval/u);
  assert.equal(f.element("login-state").dataset.guideState, "unchecked");
  assert.equal(f.element("installation-state").dataset.guideState, "expired");
  assert.equal(f.element("approval-expiry").dataset.guideState, "expired");
  // A missing network must not turn runtime trouble into a replacement promise.
  f.element("network").value = "";
  f.ui.renderStatus({ ...status, installation: { ...installation, container: "restarting" } });
  assert.match(f.element("installation-state").textContent, /Inspect the companion logs/u);
  f.element("network").value = "n8n_default";
  f.ui.renderStatus(status);
  assert.equal(f.element("settings-panel").hidden, false);
  assert.equal(f.element("installation-state").dataset.guideState, undefined);
  assert.equal(f.element("approval-expiry").dataset.guideState, undefined);
  // Without an installed companion the review is the only primary action.
  f.ui.renderStatus({ state: "manual", candidate });
  assert.equal(f.element("selection-replace").classList["rm-button--primary"], true);
});

test("the guide can read the sign-in state and a just-issued key", async () => {
  const f = fixture(); await settle();
  f.setReply(() => ({ loggedIn: false }));
  f.element("auth-button").handlers.click(); await settle();
  assert.equal(f.element("login-state").dataset.guideState, "waiting");
  f.setReply(() => ({ loggedIn: true, authMethod: "claude.ai" }));
  f.element("auth-button").handlers.click(); await settle();
  assert.equal(f.element("login-state").dataset.guideState, "ready");
  assert.equal(f.element("copy-key").dataset.guideState, undefined);

  f.ui.state.plan = plan("replace"); f.element("confirm-action").checked = true;
  f.setReply(path => path.endsWith("/apply") ? { state: "installed", clientKey: "one-time-fixture-key" }
    : { ...status, installation: { ...installation, container: "unhealthy" } });
  f.element("apply-button").handlers.click(); await settle();
  assert.equal(f.element("copy-key").dataset.guideState, "fresh");
  assert.equal(f.element("login-state").dataset.guideState, "unchecked");
  assert.equal(f.element("settings-panel").hidden, false, "a key shown once stays in view even when the companion is not ready");

  f.element("client-key").handlers.input();
  assert.equal(f.element("copy-key").dataset.guideState, undefined, "a typed key is a saved key");
});

test("keyboard focus returns to the control that started an operation unless an error took it", async () => {
  const f = fixture(); await settle();
  const refresh = f.element("refresh-button");
  const run = async (work) => {
    f.document.activeElement = refresh;
    await f.ui.perform("Working", async () => {
      // The browser drops focus from a control once it is disabled.
      f.document.activeElement = f.document.body;
      await work?.();
    });
    return f.document.activeElement;
  };
  assert.equal(await run(), refresh);
  assert.equal(await run(async () => { throw new Error("Refused"); }), f.element("error-message"));
  refresh.hidden = true;
  assert.equal(await run(), f.document.body, "a control that is no longer shown is left alone");
});

test("copying the n8n key marks the copy button and announces the copy", async () => {
  const f = fixture(); await settle();
  f.element("client-key").value = "saved-key";
  await f.element("copy-key").handlers.click();
  assert.equal(f.element("copy-key").copied, true);
  assert.match(f.element("status-message").textContent, /copied/iu);
});

test("a used server identity confirmation is put away after connecting, even when discovery then fails", async () => {
  const f = fixture(); await settle();
  const fingerprint = `SHA256:${"a".repeat(43)}`;
  const confirm = () => {
    f.ui.state.fingerprint = fingerprint;
    f.element("fingerprint-box").hidden = false;
    f.element("trust-host").checked = true;
  };
  const submit = async () => { f.element("ssh-form").handlers.submit({ preventDefault() {} }); await settle(); };
  confirm();
  f.setReply(path => path === "/api/discover" ? { httpStatus: 502, error: "Docker did not answer on the server." } : {});
  f.calls.length = 0;
  await submit();
  assert.deepEqual(f.calls.map(call => call.path), ["/api/ssh/connect", "/api/discover"]);
  assert.equal(f.calls[0].body.expectedFingerprint, fingerprint);
  assert.equal(f.element("error-message").hidden, false);
  assert.equal(f.element("fingerprint-box").hidden, true);
  assert.equal(f.element("trust-host").checked, false);
  assert.equal(f.ui.state.fingerprint, null);
  assert.equal(f.element("connect-button").disabled, true);
  // Another attempt needs a fresh identity check first.
  await submit();
  assert.equal(f.calls.filter(call => call.path === "/api/ssh/connect").length, 1);
  // A refused sign-in keeps the confirmation, so the person can correct the password.
  confirm();
  f.setReply(() => ({ httpStatus: 400, error: "SSH sign-in was refused." }));
  await submit();
  assert.equal(f.element("fingerprint-box").hidden, false);
  assert.equal(f.element("trust-host").checked, true);
});

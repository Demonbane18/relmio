import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { formatLocalDateTime } from "../src/ui/time.js";

const script = await readFile(new URL("../src/ui/local.js", import.meta.url), "utf8");
const html = await readFile(new URL("../src/ui/local.html", import.meta.url), "utf8");

function source(start, end) {
  const from = script.indexOf(start);
  const to = script.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `missing ${start}`);
  return script.slice(from, to);
}

// Values made inside the VM have its prototypes; compare their JSON shape.
const plain = (value) => JSON.parse(JSON.stringify(value));
const EXPIRES = "2026-11-17T03:02:51.040Z";
const claudeSnapshot = (overrides = {}) => ({ target: "n8n-claude-oauth", endpoint: "http://relmio-claude:14502/v1",
  auth: { configured: true, disclosure: "one-time" }, canRemove: true, models: ["claude-sonnet-5-5"],
  expiresAt: EXPIRES, approvalExpired: false, runtime: "running", ...overrides });
const claudeService = (state, overrides) => ({ target: "n8n-claude-oauth", label: "Claude for n8n", kind: "n8n-claude",
  managed: true, state, snapshot: claudeSnapshot(overrides), actions: ["manage-claude", "remove"] });
const hasExactKeys = (value, keys) => Boolean(value) && typeof value === "object" && !Array.isArray(value) &&
  Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
const claudeInstallResult = { target: "n8n-claude-oauth", endpoint: "http://relmio-claude:14502/v1", baseUrl: "http://relmio-claude:14502/v1",
  protocol: "openai-chat-completions", networkName: "n8n_default", n8nContainerName: "n8n-n8n-1", hostPublication: "none",
  clientCredential: "Q".repeat(43), credentialShownOnce: true, deploymentMode: "installed", models: ["claude-sonnet-5-5"], expiresAt: EXPIRES };

// A small DOM stand-in: elements by id, created nodes, and text that includes child nodes.
function dom() {
  const focused = [];
  const make = (tagName = "div") => ({
    tagName, attributes: new Map(), children: [], dataset: {}, handlers: {},
    hidden: false, checked: false, disabled: false, className: "", lastElementChild: { textContent: "" }, _text: "",
    get textContent() { return this._text + this.children.map((child) => typeof child === "string" ? child : child.textContent).join(""); },
    set textContent(value) { this._text = String(value); this.children = []; },
    get childElementCount() { return this.children.filter((child) => typeof child !== "string").length; },
    append(...items) { this.children.push(...items); },
    replaceChildren(...items) { this._text = ""; this.children = items; },
    setAttribute(name, value) { this.attributes.set(name, String(value)); },
    getAttribute(name) { return this.attributes.get(name) ?? null; },
    removeAttribute(name) { this.attributes.delete(name); },
    addEventListener(name, handler) { this.handlers[name] = handler; },
    focus() { focused.push(this); },
    set innerHTML(_value) { throw new Error("untrusted text must use textContent"); },
  });
  const nodes = new Map();
  const element = (id) => nodes.get(id) ?? nodes.set(id, make()).get(id);
  return { element, make, focused };
}

// The Claude card with fake timers. `reply` answers its status reads.
function claudeCard({ reply = () => ({}) } = {}) {
  const { element, make } = dom();
  const timers = [];
  const requests = [];
  const state = { installedTarget: "n8n-claude-oauth", operationBusy: false, claudeStatusTimer: null, claudeStatusGeneration: 0, claudeStatusChecks: 0 };
  const page = { hidden: false, createElement: make, querySelector: () => ({ checked: false }), querySelectorAll: () => [] };
  const context = {
    element, formatLocalDateTime, hasExactKeys, state, document: page,
    window: { setTimeout(callback, delay) { timers.push({ callback, delay }); return timers.length; }, clearTimeout() {} },
    api: async (path) => { requests.push(path); return reply(path); },
    assertDashboardKeys(value, keys) { if (!hasExactKeys(value, keys)) throw new Error("contract"); },
    dashboardContractError: () => new Error("contract"),
    isSafeDockerDisplayName: (value) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(value),
    resetDashboardActionReview() {}, renderFooterForTarget() {},
  };
  const api = runInNewContext([
    source("const CLAUDE_REVIEW_KEYS", "\nconst token = readWizardSession"),
    source("function localTime(iso)", "\nfunction isDashboardSnapshotStale"),
    source("function normalizeN8nClaudeDashboardSnapshot", "\nfunction normalizeDashboardServiceSnapshot"),
    source("function readClaudeReview(kind)", "\nfunction isN8nLocalModel(target)"),
    "({ renderClaudeManagement, renderClaudeInstallResult, setClaudeOneTimeKey });",
  ].join("\n"), context);
  return { element, api, state, page, timers, requests };
}

function dashboardViews() {
  const { element, make } = dom();
  const context = {
    element, formatLocalDateTime,
    state: { dashboardSnapshot: { providers: [{ target: "n8n-claude-oauth", label: "Claude (n8n)" }] } },
    document: { createElement: make, querySelectorAll: () => [] },
    copyText: async () => {}, flashCopied() {}, renderDashboardAction: () => null,
    assistantModeLabel: () => "Disabled", dashboardComponentSummary: () => "",
  };
  const api = runInNewContext([
    source("const CLAUDE_REVIEW_KEYS", "\nconst token = readWizardSession"),
    source("function isCodexChat(target)", "\nfunction assistantModeLabel"),
    source("function renderFooterForTarget(target)", "\nfunction renderTarget"),
    source("function dashboardStateLabel", "\nfunction isDashboardSnapshotStale"),
    source("function appendDashboardFact", "\nfunction dashboardComponentSummary"),
    source("function dashboardProviderForTarget", "\nfunction renderDashboardCompactService"),
    "({ row: renderDashboardServiceRow, detail: renderDashboardServiceDetail });",
  ].join("\n"), context);
  return { element, api };
}

test("formatLocalDateTime shows a short local date and time and nothing for a bad value", () => {
  const expected = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(EXPIRES));
  assert.equal(formatLocalDateTime(EXPIRES), expected);
  assert.notEqual(formatLocalDateTime(EXPIRES), EXPIRES);
  for (const value of ["not-a-date", "", null, undefined, Number.NaN]) assert.equal(formatLocalDateTime(value), "");
});

test("Manage Claude names the runtime honestly and gives advice only for a companion that keeps stopping", () => {
  const { element, api } = claudeCard();
  for (const [runtime, tone, guideState, advice] of [
    ["running", "success", "running", false],
    ["starting", "accent", "starting", false],
    ["restarting", "warning", "not-running", true],
    ["unhealthy", "warning", "not-running", true],
    ["stopped", "warning", "stopped", false],
  ]) {
    api.renderClaudeManagement(claudeSnapshot({ runtime }));
    const status = element("claude-runtime-status");
    assert.equal(status.dataset.tone, tone, runtime);
    assert.equal(status.dataset.guideState, guideState, runtime);
    assert.equal(element("claude-runtime-help").hidden, !advice, runtime);
    const text = element("claude-runtime-text").textContent;
    assert.match(text, new RegExp(`^${runtime}`, "iu"));
    // A reinstall keeps the login volume and any stale lock in it, so no state offers one as a fix.
    assert.doesNotMatch(text, /remove|reinstall|replace|add it again/iu, runtime);
  }
  // Docker's first health check is due a minute after every install or renewal: a calm state.
  api.renderClaudeManagement(claudeSnapshot({ runtime: "starting" }));
  assert.match(element("claude-runtime-text").textContent, /about a minute/u);
  assert.equal(element("claude-auth-status").dataset.guideState, "unchecked");
});

test("Claude approval dates are local and kept in a time element, never a raw timestamp", () => {
  const { element, api } = claudeCard();
  api.renderClaudeManagement(claudeSnapshot());
  const approval = element("claude-approval-status");
  const time = approval.children.find((child) => typeof child !== "string");
  assert.equal(time.tagName, "time");
  assert.equal(time.dateTime, EXPIRES);
  assert.equal(time.textContent, formatLocalDateTime(EXPIRES));
  assert.match(approval.textContent, /^Approval expires /u);
  assert.doesNotMatch(approval.textContent, /\d{4}-\d\d-\d\dT/u, "no raw ISO timestamp is shown");

  api.renderClaudeManagement(claudeSnapshot({ approvalExpired: true }));
  assert.match(element("claude-approval-status").textContent, /^Approval expired .+\. Renew before use\.$/u);
});

test("the Ready step after a Claude install shows a fresh one-time key and a calm starting companion", () => {
  const { element, api } = claudeCard();
  const result = claudeInstallResult;
  api.renderClaudeInstallResult(result);
  assert.equal(element("done-title").textContent, "Claude companion installed");
  assert.equal(element("claude-one-time-key").hidden, false);
  assert.equal(element("claude-client-key").textContent, result.clientCredential);
  assert.equal(element("claude-copy-key").dataset.guideState, "fresh");
  assert.equal(element("claude-runtime-status").dataset.tone, "accent");
  assert.equal(element("claude-runtime-help").hidden, true, "a fresh install gets no recovery advice");

  api.setClaudeOneTimeKey("");
  assert.equal(element("claude-client-key").textContent, "");
  assert.equal(element("claude-one-time-key").hidden, true);
  assert.equal(element("claude-copy-key").dataset.guideState, "none");
  assert.throws(() => api.renderClaudeInstallResult({ ...result, hostPublication: "127.0.0.1:14502" }), /unexpected response/u);
});

test("the Ready view reads a starting companion again until Docker reports another state", async () => {
  let runtime = "starting";
  const { element, api, state, page, timers, requests } = claudeCard({
    reply: () => ({ target: "n8n-claude-oauth", managed: true, state: "partial", snapshot: claudeSnapshot({ runtime }) }),
  });
  const tick = () => timers.at(-1).callback();
  api.renderClaudeInstallResult(claudeInstallResult);
  assert.equal(timers.at(-1).delay, 30_000);
  await tick();
  assert.deepEqual(requests, ["/api/local/claude/status"]);
  assert.match(element("claude-runtime-text").textContent, /^Starting/u, "starting stays a calm state");
  // A hidden tab or a running operation sends nothing and tries again later.
  page.hidden = true;
  await tick();
  page.hidden = false;
  state.operationBusy = true;
  await tick();
  state.operationBusy = false;
  assert.equal(requests.length, 1);
  runtime = "running";
  await tick();
  assert.equal(requests.length, 2);
  assert.equal(element("claude-runtime-text").textContent, "Running.");
  assert.equal(element("claude-runtime-status").dataset.tone, "success");
  assert.equal(state.claudeStatusTimer, null, "a settled companion is not read again");

  // A failing health check shows the recovery advice.
  runtime = "unhealthy";
  api.renderClaudeInstallResult(claudeInstallResult);
  await tick();
  assert.match(element("claude-runtime-text").textContent, /^Unhealthy/u);
  assert.equal(element("claude-runtime-help").hidden, false);
  assert.equal(element("claude-runtime-status").dataset.guideState, "not-running");

  // A companion that stays starting is read at most seven times, and the card then says its state is unconfirmed.
  runtime = "starting";
  api.renderClaudeInstallResult(claudeInstallResult);
  requests.length = 0;
  for (let turn = 0; turn < 20 && state.claudeStatusTimer !== null; turn += 1) await tick();
  assert.equal(requests.length, 7);
  assert.match(element("claude-runtime-text").textContent, /^Unknown\. /u);

  // Once the view is left, no request is sent.
  api.renderClaudeInstallResult(claudeInstallResult);
  requests.length = 0;
  element("n8n-claude-management").hidden = true;
  await tick();
  assert.equal(requests.length, 0);
  assert.equal(state.claudeStatusTimer, null);
});

test("a status read that finds no runtime says so instead of Starting, and checks that end unsettled point to Refresh status", async () => {
  let answer;
  const { element, api, state, timers, requests } = claudeCard({ reply: () => answer() });
  const tick = () => timers.at(-1).callback();
  const line = () => element("claude-runtime-text").textContent;
  const server = (serverState) => () => ({ target: "n8n-claude-oauth", managed: false, state: serverState, snapshot: null });
  const offline = () => { throw new Error("The local Relmio wizard is not reachable."); };

  // Docker or the companion's files cannot be read: the card stops saying Starting and reads again later.
  answer = server("unavailable");
  api.renderClaudeInstallResult(claudeInstallResult);
  await tick();
  assert.match(line(), /^Unavailable\. /u);
  assert.equal(element("claude-runtime-status").dataset.tone, "warning");
  assert.equal(element("claude-runtime-help").hidden, true, "an unreadable status gets no restart advice");
  assert.notEqual(state.claudeStatusTimer, null);
  // A later read that finds the companion starting shows the calm line again.
  answer = () => ({ target: "n8n-claude-oauth", managed: true, state: "partial", snapshot: claudeSnapshot({ runtime: "starting" }) });
  await tick();
  assert.match(line(), /^Starting/u);
  assert.equal(element("claude-runtime-status").dataset.tone, "accent");
  // A failed read, or an answer that fits no status, only uses up its check.
  answer = offline;
  await tick();
  answer = () => ({ target: "n8n-claude-oauth", managed: false, state: "absent", snapshot: claudeSnapshot() });
  await tick();
  assert.match(line(), /^Starting/u, "Starting stays while checks remain");
  // The last check finds no runtime: the card says the state is unknown and points to Refresh status.
  answer = server("unavailable");
  for (let turn = 0; turn < 20 && state.claudeStatusTimer !== null; turn += 1) await tick();
  assert.equal(requests.length, 7);
  assert.equal(line(), "Unknown. Relmio could not confirm the companion's state. Check again with Refresh status on the dashboard.");
  assert.equal(element("claude-runtime-status").dataset.tone, "warning");

  // A companion Relmio no longer finds ends the reads at once.
  answer = server("absent");
  api.renderClaudeInstallResult(claudeInstallResult);
  requests.length = 0;
  await tick();
  assert.match(line(), /^Not found\. /u);
  assert.equal(element("claude-runtime-status").dataset.tone, "warning");
  assert.equal(state.claudeStatusTimer, null);
  assert.equal(requests.length, 1);

  // Reads that all fail end the same way as reads that find no runtime.
  answer = offline;
  api.renderClaudeInstallResult(claudeInstallResult);
  for (let turn = 0; turn < 20 && state.claudeStatusTimer !== null; turn += 1) await tick();
  assert.match(line(), /^Unknown\. /u);
});

test("the dashboard row and detail show the Claude approval and never call a lapsed or stopping companion healthy", () => {
  const { element, api } = dashboardViews();
  const time = formatLocalDateTime(EXPIRES);
  const rowText = (service) => {
    const row = api.row(service, { selected: true, stale: false });
    const [dot, copy] = row.children[0].children;
    return { dot: dot.className, detail: copy.children[1] };
  };

  const healthy = rowText(claudeService("healthy"));
  assert.match(healthy.dot, /state-healthy/u);
  assert.equal(healthy.detail.textContent, `Healthy · Expires ${time}`);
  assert.ok(healthy.detail.children.some((child) => child.tagName === "time" && child.dateTime === EXPIRES));

  const expired = rowText(claudeService("partial", { approvalExpired: true }));
  assert.match(expired.dot, /state-partial/u);
  assert.equal(expired.detail.textContent, `Approval expired ${time}. Renew before use.`);

  // The server marks a stale-approval companion partial; a healthy state with a lapsed
  // approval or a restart loop is still not shown as healthy.
  for (const overrides of [{ approvalExpired: true }, { runtime: "restarting" }]) {
    const row = rowText(claudeService("healthy", overrides));
    assert.match(row.dot, /state-partial/u);
    assert.doesNotMatch(row.detail.textContent, /Healthy/u);
  }

  const starting = rowText(claudeService("partial", { runtime: "starting" }));
  assert.match(starting.dot, /state-starting/u);
  assert.equal(starting.detail.textContent, `Starting · Expires ${time}`);

  const fact = (label) => element("dashboard-service-facts").children
    .find((row) => row.children[0].textContent === label)?.children[1].textContent;
  const runtimeNode = () => element("dashboard-relay").children[1].children[2].textContent;

  api.detail(claudeService("healthy"));
  assert.equal(runtimeNode(), "Runtime reachable");
  assert.equal(fact("Runtime"), "Running");
  assert.equal(fact("Approval"), `Expires ${time}`);

  api.detail(claudeService("partial", { approvalExpired: true }));
  assert.equal(runtimeNode(), "Approval expired");
  assert.equal(fact("Approval"), `Expired ${time}. Renew before use.`);
  assert.match(element("dashboard-service-detail-copy").textContent, /Renew it before use/u);

  api.detail(claudeService("partial", { runtime: "restarting" }));
  assert.equal(runtimeNode(), "Restarting");
  assert.equal(fact("Runtime"), "Restarting");
  const copy = element("dashboard-service-detail-copy").textContent;
  assert.match(copy, /keeps stopping/u);
  assert.match(copy, /docker logs relmio-claude/u);
  assert.match(copy, /account-lock recovery guide/u);
  assert.doesNotMatch(copy, /reinstall|add it again|remove it/iu);

  api.detail(claudeService("partial", { runtime: "starting" }));
  assert.equal(runtimeNode(), "Starting");
  assert.doesNotMatch(element("dashboard-service-detail-copy").textContent, /logs|recovery/u, "starting needs no advice");
});

test("Claude removal sends keepLogin only when the person chose to keep the sign-in", async () => {
  const { element } = dom();
  const calls = [];
  const errors = [];
  const statuses = [];
  let response;
  const state = { installedTarget: "n8n-claude-oauth" };
  runInNewContext(source('for (const action of ["renew", "sign-out", "remove"])', '\nelement("claude-check-models")'), {
    element, state, hasExactKeys, document: { querySelectorAll: () => [] },
    claudeReviewAccepted: () => true, readClaudeReview: () => ({ officialBinaryReviewed: true }),
    setBusy: () => true, clearError() {}, resetDashboardActionReview() {}, setClaudeAuthStatus() {},
    renderClaudeStatus(status) { statuses.push(status); }, setMessage() {}, showError(error) { errors.push(error); },
    updateClaudeKeepLogin() {},
    api: async (path, options) => { calls.push({ path, body: options.body }); return response; },
  });
  const remove = async ({ keep, result }) => {
    state.installedTarget = "n8n-claude-oauth";
    element("claude-remove-confirm").checked = true;
    element("claude-keep-login").checked = keep;
    response = result;
    await element("claude-remove").handlers.click({ currentTarget: element("claude-remove") });
  };

  // Removal has its own confirmation: the one for renewal and sign-out does not allow it.
  element("claude-change-confirm").checked = true;
  await element("claude-remove").handlers.click({ currentTarget: element("claude-remove") });
  assert.equal(calls.length, 0);
  element("claude-change-confirm").checked = false;
  element("claude-remove-confirm").checked = true;
  await element("claude-renew").handlers.click({ currentTarget: element("claude-renew") });
  assert.equal(calls.length, 0);

  await remove({ keep: true, result: { target: "n8n-claude-oauth", removed: true, loginKept: true } });
  assert.deepEqual(plain(calls.at(-1)), { path: "/api/local/claude/remove", body: { confirmed: true, keepLogin: true } });
  assert.match(element("done-detail").textContent, /kept your Claude sign-in for a reinstall/u);
  // Keeping the login is retention only: no claim that a reinstall recovers the companion.
  assert.doesNotMatch(element("done-detail").textContent, /fix|recover|lock|restart/iu);
  assert.equal(element("claude-keep-login").checked, false, "the choice does not carry over to the next action");

  await remove({ keep: false, result: { target: "n8n-claude-oauth", removed: true, loginKept: false } });
  assert.deepEqual(plain(calls.at(-1)), { path: "/api/local/claude/remove", body: { confirmed: true } });
  assert.match(element("done-detail").textContent, /login volume and managed files were removed/u);

  await remove({ keep: true, result: { target: "n8n-claude-oauth", removed: true, loginKept: false } });
  assert.match(element("done-detail").textContent, /could not keep the Claude sign-in/u);

  await remove({ keep: true, result: { target: "n8n-claude-oauth", removed: true } });
  assert.match(errors.at(-1).message, /result is invalid/u);

  // Renewal restarts the companion, so it shows as starting with the new approval date.
  state.installedTarget = "n8n-claude-oauth";
  element("claude-change-confirm").checked = true;
  response = { target: "n8n-claude-oauth", changed: true, expiresAt: EXPIRES };
  await element("claude-renew").handlers.click({ currentTarget: element("claude-renew") });
  assert.deepEqual(plain(calls.at(-1)).body, { confirmed: true, review: { officialBinaryReviewed: true } });
  assert.deepEqual(plain(statuses.at(-1)), { runtime: "starting", approvalExpired: false, expiresAt: EXPIRES });
});

test("the Claude removal review shows only the removal section and Manage brings the card back", async () => {
  const { element, make } = dom();
  const state = { dashboardBusy: false, dashboardSnapshot: {}, installedTarget: null };
  const api = runInNewContext([
    source("const CLAUDE_REVIEW_KEYS", "\nconst token = readWizardSession"),
    source("function localTime(iso)", "\nfunction isDashboardSnapshotStale"),
    source("function normalizeN8nClaudeDashboardSnapshot", "\nfunction normalizeDashboardServiceSnapshot"),
    source("function readClaudeReview(kind)", "\nfunction isN8nLocalModel(target)"),
    source("async function runDashboardAction", "\nfunction renderDashboardAction"),
    "({ run: runDashboardAction, updateClaudeChangeApproval, updateClaudeKeepLogin });",
  ].join("\n"), {
    element, formatLocalDateTime, hasExactKeys, state,
    document: { createElement: make, querySelector: () => ({ checked: false }), querySelectorAll: () => [] },
    assertDashboardKeys(value, keys) { if (!hasExactKeys(value, keys)) throw new Error("contract"); },
    dashboardContractError: () => new Error("contract"),
    isDashboardSnapshotStale: () => false, dashboardToWizardTarget: (target) => target,
    async enterSetupView() {}, resetDashboardActionReview() {}, showStep() {},
    window: { setTimeout: () => 1, clearTimeout() {} },
  });
  const service = claudeService("healthy");

  await api.run(service, "remove");
  assert.equal(element("done-title").textContent, "Review Claude for n8n removal");
  assert.equal(element("n8n-claude-management").hidden, false);
  assert.equal(element("claude-card").hidden, true, "sign-in and status are not part of a removal review");
  assert.equal(element("claude-manage").hidden, true, "n8n settings, model check and renewal are not part of a removal review");
  assert.equal(element("claude-removal").open, true);
  assert.equal(element("claude-keep-login").checked, false, "keeping the sign-in is off until the person ticks it");
  assert.equal(element("claude-remove").disabled, true, "removal waits for its own confirmation");
  assert.match(element("claude-remove-confirm-copy").textContent, /remove only its Claude companion, login volume and managed files/u);

  // The confirmation for renewal and sign-out never enables removal.
  element("claude-change-confirm").checked = true;
  api.updateClaudeChangeApproval();
  assert.equal(element("claude-remove").disabled, true);
  element("claude-remove-confirm").checked = true;
  api.updateClaudeChangeApproval();
  assert.equal(element("claude-remove").disabled, false);

  // Keeping the sign-in changes what the confirmation says, so the earlier tick is cleared.
  element("claude-keep-login").checked = true;
  api.updateClaudeKeepLogin();
  assert.equal(element("claude-remove-confirm").checked, false);
  assert.equal(element("claude-remove").disabled, true);
  assert.match(element("claude-remove-confirm-copy").textContent, /keep the login volume/u);
  element("claude-remove-confirm").checked = true;

  await api.run(service, "manage-claude");
  assert.equal(element("done-title").textContent, "Manage Claude for n8n");
  assert.equal(element("claude-card").hidden, false);
  assert.equal(element("claude-manage").hidden, false);
  assert.equal(element("claude-manage").open, false);
  assert.equal(element("claude-removal").open, false, "Manage starts with removal closed");
  assert.equal(element("claude-remove-confirm").checked, false, "a confirmation never carries over to another view");
  assert.equal(element("claude-keep-login").checked, false);
});

test("Continue opens the Claude plan only with all four review answers, and Install still needs the plan's own confirmation", () => {
  const { element, make, focused } = dom();
  // The four answer checkboxes, under the names the page gives them.
  const names = [...html.matchAll(/data-claude-review="(\w+)"/gu)].map(([, name]) => name);
  assert.equal(names.length, 4);
  const answers = new Map(names.map((name) => [name, make("input")]));
  const page = {
    querySelector: (selector) => answers.get(/^\[data-claude-review="(\w+)"\]$/u.exec(selector)?.[1]) ?? null,
    querySelectorAll: (selector) => selector === "[data-claude-review]" ? [...answers.values()] : [],
  };
  const state = { operationBusy: false, plan: { target: "n8n-claude-oauth" } };
  // The real answer check, review stages, approval update with its change listeners, and Continue handler.
  const { show } = runInNewContext([
    source("const CLAUDE_REVIEW_KEYS", "\nconst token = readWizardSession"),
    source("function readClaudeReview(kind)", "\nfunction setClaudeAuthStatus"),
    source("function showReviewStage(stage", "\nfunction prepareInstallPanel"),
    source("function updateLocalReviewApproval()", '\nelement("local-background-consent")'),
    source('element("claude-review-continue").addEventListener("click"', "\n// After an unconfirmed install"),
    "({ show: showReviewStage });",
  ].join("\n"), { element, state, document: page, isN8nClaude: (target) => target === "n8n-claude-oauth", clearError() {} });
  const tick = (input, checked) => { input.checked = checked; input.handlers.change(); };
  const pressContinue = () => element("claude-review-continue").handlers.click();
  const install = element("install-settings-button");

  show("approval", { focus: false });
  for (const missing of names) {
    for (const [name, input] of answers) tick(input, name !== missing);
    assert.equal(element("claude-review-continue").disabled, true, `Continue waits for ${missing}`);
    pressContinue();
    assert.equal(element("claude-review").hidden, false, `without ${missing} the review stays open`);
    assert.equal(element("review-plan").hidden, true, `without ${missing} the plan stays closed`);
    assert.equal(install.hidden, true);
  }

  tick(answers.get(names.at(-1)), true);
  assert.equal(element("claude-review-continue").disabled, false);
  assert.equal(install.disabled, true, "the four answers alone never enable Install");
  pressContinue();
  assert.equal(element("claude-review").hidden, true);
  assert.equal(element("review-plan").hidden, false);
  assert.equal(element("review-approval").hidden, false);
  assert.equal(element("claude-review-continue").hidden, true);
  assert.equal(element("review-title").textContent, "Review the plan");
  assert.equal(focused.at(-1), element("review-title"), "focus moves to the plan's heading");
  assert.equal(install.hidden, false);
  assert.equal(install.disabled, true, "the plan's own confirmation is still needed");
  tick(element("install-confirm"), true);
  assert.equal(install.disabled, false);
  tick(answers.get(names[0]), false);
  assert.equal(install.disabled, true, "every owner answer stays required");

  // Other plans have no owner answers: Continue stays off and the plan confirmation alone decides.
  state.plan = { target: "xai-grok-build" };
  element("install-confirm").handlers.change();
  assert.equal(element("claude-review-continue").disabled, true);
  assert.equal(install.disabled, false);
});

test("hidden tabs skip status polls and tick once when they show again", async () => {
  const { element } = dom();
  const document = { hidden: true };
  const timers = [];
  let requests = 0;
  const state = { localModelPollTimer: null, localModelGeneration: 0, imagesGeneration: 3, operationBusy: false };
  const window = { setTimeout(callback, delay) { timers.push({ callback, delay }); return timers.length; } };
  const { model } = runInNewContext(`${source("function scheduleLocalModelPoll(delay", "\nasync function refreshLocalModelStatus")}
({ model: scheduleLocalModelPoll });`, {
    element, state, document, window, showError() {}, renderLocalModelStatus() {},
    api: async () => { requests += 1; return {}; },
  });
  model();
  assert.equal(timers[0].delay, 3_000);
  await timers[0].callback();
  assert.equal(requests, 0, "a hidden tab sends no request");
  assert.equal(timers.length, 2, "and checks again later");
  document.hidden = false;
  await timers[1].callback();
  assert.equal(requests, 1);

  const scheduled = [];
  const images = runInNewContext(`${source("async function pollInstalledImages(generation)", "\n// Results render after the operation ends")}
pollInstalledImages;`, {
    element, state, document: { hidden: true }, renderInstalledImages() {}, setImagesStatus() {}, setMessage() {},
    scheduleInstalledImagesPoll(generation) { scheduled.push(generation); },
    api: async () => { requests += 1; return {}; },
  });
  await images(3);
  assert.equal(requests, 1, "a hidden tab skips the image sign-in check too");
  assert.deepEqual(scheduled, [3]);

  // Showing the tab again runs each pending poll at once instead of waiting a full interval.
  const listeners = {};
  const calls = [];
  const cleared = [];
  const pending = { imagesTimer: 5, imagesGeneration: 3, localModelPollTimer: 9, claudeStatusTimer: 4 };
  const page = { hidden: false, addEventListener(name, handler) { listeners[name] = handler; } };
  runInNewContext(script.slice(script.indexOf("// Hidden tabs skip their status requests.")), {
    document: page, state: pending, window: { clearTimeout(timer) { cleared.push(timer); } },
    scheduleInstalledImagesPoll(generation, delay) { calls.push(["images", generation, delay]); },
    scheduleLocalModelPoll(delay) { calls.push(["model", delay]); },
    scheduleClaudeStatusPoll(delay) { calls.push(["claude", delay]); },
  });
  listeners.visibilitychange();
  assert.deepEqual(plain(calls), [["images", 3, 0], ["model", 0], ["claude", 0]]);
  assert.deepEqual(cleared, [9, 4]);
  assert.equal(pending.localModelPollTimer, null);
  page.hidden = true;
  calls.length = 0;
  listeners.visibilitychange();
  assert.deepEqual(calls, []);
});

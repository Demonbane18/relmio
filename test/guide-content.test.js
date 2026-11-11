import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";

import { GUIDE_ERRORS } from "../src/ui/guide/errors.js";
import { currentTip, lookupError, tipDone } from "../src/ui/guide.js";
import { wizardApiError } from "../src/ui/session.js";
import { formatLocalDateTime } from "../src/ui/time.js";
import { parseAdministrativeProbe, parseLoginUid } from "../src/infrastructure/ssh-administration.js";
import { connectVerified, formatSha256Fingerprint } from "../src/infrastructure/ssh.js";
import { requireSupportedVpsCpu, VPS_OPERATION_LOCKS, createVpsLockCommand, createVpsBuildStateCommand,
  cleanupVpsBuildStateCommand, releaseVpsLockCommand } from "../src/domain/vps-build-state.js";
import { assertVpsNetworkSupported } from "../src/domain/vps-network.js";
import { PRECHECK_COMMAND, SHARED_ROOT_COMMAND, SHARED_ROOT_TIGHTEN_COMMAND } from "../src/domain/safety.js";
import { withVpsOperationLock } from "../src/services/vps-operation-lock.js";
import { installVpsSuperGrok, reviewVpsSuperGrok } from "../src/services/vps-supergrok.js";
import { installVpsLocalModel, reviewVpsLocalModel } from "../src/services/vps-local-model.js";

const PAGES = {
  vps: "index.html",
  local: "local.html",
  assistant: "assistant.html",
  "supergrok-vps": "supergrok-vps.html",
  "claude-vps": "claude-vps.html",
  "local-model-vps": "local-model-vps.html",
  hosting: "hosting.html",
};
const ACTIONS = new Set(["type", "press", "choose", "check", "read", "wait"]);
const DONE = /^(filled|checked|clicked|changed|manual|(visible|hidden):(.+))$/u;
const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);
const TAG = /<!--[\s\S]*?-->|<!doctype[^>]*>|<(\/?)([a-zA-Z][\w-]*)((?:\s+[^\s"'>/=]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+))?)*)\s*\/?>/giu;
const ATTR = /([^\s"'>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/gu;

// Builds a flat element list with parent links; enough for id/class/attribute/descendant selectors.
function parseHtml(html) {
  const root = { tag: "#root", attrs: new Map(), parent: null };
  const elements = [];
  let current = root;
  for (const [token, closing, rawTag, rawAttrs = ""] of html.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/giu, "").matchAll(TAG)) {
    if (!rawTag) continue;
    const tag = rawTag.toLowerCase();
    if (closing) {
      let node = current;
      while (node !== root && node.tag !== tag) node = node.parent;
      if (node !== root) current = node.parent;
      continue;
    }
    const attrs = new Map();
    for (const [, name, double, single, bare] of rawAttrs.matchAll(ATTR)) attrs.set(name.toLowerCase(), double ?? single ?? bare ?? "");
    const element = { tag, attrs, parent: current };
    elements.push(element);
    if (!VOID.has(tag) && !token.endsWith("/>")) current = element;
  }
  return elements;
}

// Supports compound selectors (tag, #id, .class, [attr], [attr=value]) joined by descendant
// spaces. Anything else throws, so content stays within selectors this test can verify.
function parseCompound(text) {
  const parts = { tag: null, checks: [] };
  const pattern = /^([a-z][\w-]*)|#([\w-]+)|\.([\w-]+)|\[([\w-]+)(?:=(?:"([^"]*)"|'([^']*)'|([\w-]+)))?\]/iuy;
  let index = 0;
  while (index < text.length) {
    pattern.lastIndex = index;
    const match = pattern.exec(text);
    if (!match || match[0] === "") throw new Error(`Unsupported selector: ${text}`);
    const [, tag, id, className, attr, double, single, bare] = match;
    if (tag) {
      if (index !== 0) throw new Error(`Unsupported selector: ${text}`);
      parts.tag = tag.toLowerCase();
    } else if (id) parts.checks.push((element) => element.attrs.get("id") === id);
    else if (className) parts.checks.push((element) => (element.attrs.get("class") ?? "").split(/\s+/u).includes(className));
    else {
      const value = double ?? single ?? bare;
      parts.checks.push((element) => element.attrs.has(attr) && (value === undefined || element.attrs.get(attr) === value));
    }
    index = pattern.lastIndex;
  }
  return (element) => (!parts.tag || element.tag === parts.tag) && parts.checks.every((check) => check(element));
}

function matches(elements, selector) {
  const compounds = selector.trim().split(/\s+/u).map(parseCompound);
  const last = compounds.pop();
  return elements.some((element) => {
    if (!last(element)) return false;
    let ancestor = element.parent;
    for (let index = compounds.length - 1; index >= 0; index -= 1) {
      while (ancestor && !(ancestor.tag !== "#root" && compounds[index](ancestor))) ancestor = ancestor.parent;
      if (!ancestor) return false;
      ancestor = ancestor.parent;
    }
    return true;
  });
}

function strings(value, path = "") {
  if (typeof value === "string") return [[path, value]];
  if (Array.isArray(value)) return value.flatMap((item, index) => strings(item, `${path}[${index}]`));
  if (value && typeof value === "object") return Object.entries(value).flatMap(([key, item]) => strings(item, `${path}.${key}`));
  return [];
}

const words = (text) => text.trim().split(/\s+/u).length;
const sentences = (text) => (text.match(/[.?](?=\s|$)/gu) ?? []).length;
const html = Object.fromEntries(await Promise.all(Object.entries(PAGES).map(async ([page, file]) =>
  [page, await readFile(new URL(`../src/ui/${file}`, import.meta.url), "utf8")])));
const pages = Object.fromEntries(Object.entries(html).map(([page, markup]) => [page, parseHtml(markup)]));
const guides = Object.fromEntries(await Promise.all(Object.keys(PAGES).map(async (page) =>
  [page, (await import(`../src/ui/guide/content-${page}.js`)).GUIDE])));

const localSource = await readFile(new URL("../src/ui/local.js", import.meta.url), "utf8");
const claudeSource = await readFile(new URL("../src/ui/claude-vps.js", import.meta.url), "utf8");

function assertSelector(page, selector, where, rendered = [pages[page]]) {
  assert.equal(typeof selector, "string", `${where} needs a selector`);
  assert.ok(rendered.some(elements => matches(elements, selector)), `${where}: "${selector}" matches nothing in ${PAGES[page]}`);
}

function assertEntry(entry, where) {
  assert.ok(entry.title?.trim() && words(entry.title) <= 8, `${where} title`);
  assert.ok(entry.say?.trim() && sentences(entry.say) >= 1 && sentences(entry.say) <= 3, `${where} say`);
  assert.ok(Array.isArray(entry.steps) && entry.steps.length > 0 && entry.steps.every((step) => step.trim()), `${where} steps`);
  for (const [page, selector] of Object.entries(entry.targets ?? {})) {
    assert.ok(Object.hasOwn(PAGES, page), `${where} targets unknown page ${page}`);
    assertSelector(page, selector, `${where}.targets.${page}`);
  }
}

for (const [page, guide] of Object.entries(guides)) {
  test(`${page} guide points only at elements in ${PAGES[page]}`, async () => {
    const rendered = page === "local" ? await localGuideStates()
      : page === "claude-vps" ? await vpsGuideStates() : [pages[page]];
    assert.equal(guide.page, page);
    assert.ok(guide.title.trim() && guide.intro.trim());
    const body = pages[page].find((element) => element.tag === "body");
    if (body.attrs.has("data-guide-page")) assert.equal(body.attrs.get("data-guide-page"), page);
    assert.ok(guide.chapters.length > 0);
    const chapterIds = new Set();
    const tipIds = new Set();
    for (const chapter of guide.chapters) {
      const where = `${page}/${chapter.id}`;
      assert.match(chapter.id, /^[a-z0-9-]+$/u, where);
      assert.ok(!chapterIds.has(chapter.id), `${where} repeats a chapter id`);
      chapterIds.add(chapter.id);
      assert.ok(words(chapter.label) >= 2 && words(chapter.label) <= 5, `${where} label needs 2 to 5 words`);
      assert.ok(chapter.badge?.trim(), `${where} badge`);
      assertSelector(page, chapter.panel, `${where} panel`, rendered);
      assert.ok(chapter.tips.length > 0, `${where} has no tips`);
      for (const tip of chapter.tips) {
        const tipWhere = `${where}/${tip.id}`;
        assert.match(tip.id, /^[a-z0-9-]+$/u, tipWhere);
        assert.ok(!tipIds.has(tip.id), `${tipWhere} repeats a tip id`);
        tipIds.add(tip.id);
        assertSelector(page, tip.target, `${tipWhere} target`, rendered);
        assert.ok(ACTIONS.has(tip.action), `${tipWhere} action`);
        assert.ok(tip.title.trim() && words(tip.title) <= 6, `${tipWhere} title needs at most 6 words`);
        assert.ok(sentences(tip.say) >= 1 && sentences(tip.say) <= 3, `${tipWhere} say needs 1 to 3 sentences`);
        for (const key of ["example", "find"]) {
          if (key in tip) assert.ok(typeof tip[key] === "string" && tip[key].trim(), `${tipWhere} ${key}`);
        }
        const done = DONE.exec(tip.done);
        assert.ok(done, `${tipWhere} done`);
        if (done[3]) assertSelector(page, done[3], `${tipWhere} done`, rendered);
      }
    }
    // At most one press installs; when it succeeds and the last chapter shows, the mascot hops once.
    const installs = guide.chapters.flatMap((chapter) => chapter.tips.filter((tip) => "installs" in tip));
    assert.ok(installs.length <= 1, `${page} marks more than one install press`);
    for (const tip of installs) assert.deepEqual([tip.installs, tip.action, tip.done], [true, "press", "clicked"], `${page}/${tip.id}`);
    assert.equal(installs.length, ["vps", "local", "assistant"].includes(page) ? 1 : 0, `${page} install-only press; generic apply can also remove or sign out`);
    assert.ok(guide.finish.title.trim() && guide.finish.say.trim());
    assert.ok(guide.finish.next.length > 0 && guide.finish.next.every((step) => step.trim()));
  });
}

// The codes the server and the local page set on a typed refusal: the
// connection probe's exit codes 70 to 79 and its other refusals, the sign-in
// refusals, the operation lock, the network check, the install steps, the
// unsupported CPU and the unconfirmed local install.
const TYPED_REFUSALS = [
  "vps_prereq_linux", "vps_prereq_uid", "vps_prereq_tools", "vps_prereq_docker_dir", "vps_prereq_docker_cli",
  "vps_prereq_docker_context", "vps_prereq_docker_engine", "vps_prereq_compose", "vps_prereq_builder_config",
  "vps_prereq_default_builder", "vps_prereq_rootless", "vps_prereq_probe",
  "ssh_root_login_disabled", "ssh_auth_refused", "ssh_not_root", "vps_operation_lock", "vps_network_unsupported",
  "vps_step_compose_config", "vps_step_build", "vps_step_start", "vps_step_image_check", "vps_host_unsupported_cpu",
  "install_unconfirmed",
];

test("error help covers every recovery code and the codes pages branch on", async () => {
  const server = await readFile(new URL("../src/web/server.js", import.meta.url), "utf8");
  const set = /const SIWC_RECOVERY = new Set\(\[([^\]]+)\]\)/u.exec(server);
  assert.ok(set, "SIWC_RECOVERY not found in server.js");
  const recovery = [...set[1].matchAll(/"([^"]+)"/gu)].map(([, code]) => code);
  assert.ok(recovery.length >= 9);
  for (const code of recovery) assertEntry(GUIDE_ERRORS.recovery[code] ?? {}, `recovery.${code}`);
  for (const [code, entry] of Object.entries(GUIDE_ERRORS.recovery)) {
    assert.ok(recovery.includes(code), `recovery.${code} is not in SIWC_RECOVERY`);
    assertEntry(entry, `recovery.${code}`);
  }
  const required = [
    "ssh_identity_review_required", "subscription_sharing_usage_limit_exceeded",
    "retryBlocked", "remoteOutcomeUnknown", "managedPartialStack",
    "usage_limit", "reauthorize", "probe_rejected", "checks_off", "time_limit", "lease_unavailable",
    "catalog_unavailable", "registration_unavailable",
    // /api/plan refuses a second VPS install with vps_sidecar_<state>.
    "vps_sidecar_owned", "vps_sidecar_updating", "vps_sidecar_staged", "vps_sidecar_partial",
    ...TYPED_REFUSALS,
  ];
  const acquisition = await readFile(new URL("../src/local-model/acquisition.mjs", import.meta.url), "utf8");
  const modelErrors = /const ERROR_CODES = new Set\(\[([^\]]+)\]\)/u.exec(acquisition);
  assert.ok(modelErrors, "ERROR_CODES not found in acquisition.mjs");
  required.push(...[...modelErrors[1].matchAll(/"([^"]+)"/gu)].map(([, code]) => code));
  for (const code of required) assert.ok(GUIDE_ERRORS.codes[code], `codes.${code} is missing`);
  for (const [code, entry] of Object.entries(GUIDE_ERRORS.codes)) assertEntry(entry, `codes.${code}`);
  for (const status of ["400", "401", "403", "404", "409", "429", "500", "502", "503"]) {
    assert.ok(GUIDE_ERRORS.status[status], `status.${status} is missing`);
  }
  for (const [status, entry] of Object.entries(GUIDE_ERRORS.status)) assertEntry(entry, `status.${status}`);
  assertEntry(GUIDE_ERRORS.fallback, "fallback");
});

test("every typed refusal has one entry: a title, one sentence and at most three steps", async () => {
  const troubleshooting = await readFile(new URL("../docs/troubleshooting.md", import.meta.url), "utf8");
  for (const code of TYPED_REFUSALS) {
    const entry = GUIDE_ERRORS.codes[code];
    assert.ok(entry, `codes.${code} is missing`);
    assert.ok(entry.title?.trim(), `codes.${code} has a title`);
    assert.equal(sentences(entry.say), 1, `codes.${code} says one sentence`);
    assert.ok(entry.steps.length >= 1 && entry.steps.length <= 3, `codes.${code} has at most three steps`);
    assert.ok(troubleshooting.includes(`\`${code}\``), `codes.${code} needs a troubleshooting source row`);
  }

  // The facts the entries must carry.
  const steps = (code) => GUIDE_ERRORS.codes[code].steps.join(" ");
  assert.ok(steps("vps_prereq_docker_dir").includes("sudo install -d -o root -g root -m 0755 /docker"));
  assert.match(GUIDE_ERRORS.codes.vps_prereq_docker_dir.say, /does not create that folder/u);
  for (const code of ["ssh_root_login_disabled", "ssh_auth_refused", "ssh_not_root"]) {
    assert.match(steps(code), /ChatGPT, Assistant, SuperGrok and Claude setups need a direct root sign-in/u, code);
    assert.match(steps(code), /Only the Local model setup also accepts another account, with passwordless sudo -n/u, code);
    assert.match(steps(code), /Relmio never asks anyone to turn on root or password sign-in/u, code);
  }
  assert.match(steps("vps_operation_lock"), /Leave the lock files alone/u);
  assert.equal(GUIDE_ERRORS.codes.install_unconfirmed.targets.local, "#setup-back-to-dashboard");
  assert.equal(GUIDE_ERRORS.codes.ssh_identity_review_required.targets["claude-vps"], "#scan-button");
  assert.equal(GUIDE_ERRORS.codes.NO_RUNNING_N8N, undefined, "the code never reaches the guide");
});


test("Claude help points at the one-time key first and never nudges replacement or renewal", () => {
  const tips = (page) => guides[page].chapters.flatMap((chapter) => chapter.tips);
  const index = (page, id) => tips(page).findIndex((tip) => tip.id === id);
  // The key is shown once, so its tip comes before the terminal sign-in and only while a key was just issued.
  for (const [page, key, terminal] of [["claude-vps", "key", "command"], ["local", "claude-key", "claude-terminal"]]) {
    assert.ok(index(page, key) >= 0 && index(page, key) < index(page, terminal), `${page}: the key tip comes first`);
    assert.match(tips(page)[index(page, key)].target, /\[data-guide-state=fresh\]$/u, page);
  }
  const vps = Object.fromEntries(tips("claude-vps").map((tip) => [tip.id, tip]));
  assert.ok(index("claude-vps", "continue") < index("claude-vps", "replace"), "continue comes before replace");
  for (const id of ["replace", "replace-key", "renew"]) assert.deepEqual([vps[id].action, vps[id].done], ["read", "manual"], id);
  assert.equal(vps.auth.done, "visible:#login-state[data-guide-state=ready]", "a sign-in check counts when the page confirms it");
  assert.equal(vps["approval-expired"].target, "#approval-expiry[data-guide-state=expired]");
  assert.match(vps["approval-expired"].say, /Renew approval/u);
  assert.match(vps["approval-expired"].say, /renewal does not clear that lock/u);
  // Refresh status rereads only the companion; loading the page runs n8n discovery again.
  assert.match(vps.container.find, /reload this page/u);
  assert.doesNotMatch(vps.container.find, /Refresh status/u);
  // Every step that can run an operation has its wait tip.
  for (const chapter of guides["claude-vps"].chapters) {
    assert.ok(chapter.tips.some((tip) => tip.action === "wait" && tip.target === "#operation-progress"), `claude-vps/${chapter.id} wait tip`);
  }
  // A retained login also retains its account lock; replacement is not lock recovery.
  const local = Object.fromEntries(tips("local").map((tip) => [tip.id, tip]));
  assert.match(local["claude-restarting"].target, /\[data-guide-state=not-running\]$/u);
  for (const tip of [vps["not-running"], local["claude-restarting"]]) {
    assert.match(tip.say, /account_locked/u);
    assert.match(tip.say, /every process or container using that account has stopped/u);
    assert.match(tip.find, /lock intact/u);
  }
  assert.match(vps["replace-key"].say, /does not clear an account lock/u);
  assert.match(local["claude-keep-login"].say, /does not repair a stranded lock/u);
  assert.equal(local["claude-check"].done, "visible:#claude-auth-status[data-guide-state=ready]");
});

test("guide copy follows the brand voice and uses documentation-safe values", () => {
  for (const [name, value] of [...Object.entries(guides), ["errors", GUIDE_ERRORS]]) {
    for (const [path, text] of strings(value)) {
      assert.doesNotMatch(text, /[!\u2013\u2014]|\p{Extended_Pictographic}/u, `${name}${path} has an exclamation mark, dash or emoji`);
      for (const [address] of text.matchAll(/\b\d{1,3}(?:\.\d{1,3}){3}\b/gu)) {
        assert.ok(address.startsWith("203.0.113.") || address === "127.0.0.1", `${name}${path} uses a real-looking address ${address}`);
      }
    }
  }
});

test("selector checks catch a renamed element", () => {
  assert.ok(matches(pages.vps, "#vps-form #host"));
  assert.ok(!matches(pages.vps, "#vps-form #hots"));
  assert.ok(matches(pages["supergrok-vps"], "#settings-panel [data-action=sign-in]"));
  assert.ok(!matches(pages["supergrok-vps"], "#ssh-panel [data-action=sign-in]"));
  assert.throws(() => matches(pages.vps, "#host:focus"), /Unsupported selector/u);
});

// Execute the same controller slices as the page tests, without importing their tests.
function localScript(start, end) {
  const from = localSource.indexOf(start);
  const to = localSource.indexOf(end, from + start.length);
  assert.ok(from >= 0 && to > from, `missing controller slice ${start}`);
  return localSource.slice(from, to);
}

// Keep attributes and dataset coupled, so moving a state onto another element cannot pass.
function pageDom(page) {
  const elements = parseHtml(html[page]);
  const windows = {};
  const snapshots = [pages[page]];
  const query = (selector, scope = elements) => selector.split(",").flatMap(part => {
    const checked = part.endsWith(":checked");
    return scope.filter(node => matches([node], checked ? part.slice(0, -8) : part) && (!checked || node.checked));
  });
  const descendants = node => elements.filter(item => {
    for (let parent = item.parent; parent; parent = parent.parent) if (parent === node) return true;
    return false;
  });
  const decorate = node => Object.assign(node, {
    value: node.attrs.get("value") ?? "", textContent: "", checked: node.attrs.has("checked"),
    disabled: node.attrs.has("disabled"), handlers: {}, children: [], isConnected: true,
    dataset: new Proxy({}, {
      get: (_, key) => node.attrs.get(`data-${key.replace(/[A-Z]/gu, letter => `-${letter.toLowerCase()}`)}`),
      set: (_, key, value) => { node.attrs.set(`data-${key.replace(/[A-Z]/gu, letter => `-${letter.toLowerCase()}`)}`, String(value)); return true; },
      deleteProperty: (_, key) => node.attrs.delete(`data-${key.replace(/[A-Z]/gu, letter => `-${letter.toLowerCase()}`)}`),
    }),
    setAttribute(name, value) { this.attrs.set(name, String(value)); },
    getAttribute(name) { return this.attrs.get(name) ?? null; },
    removeAttribute(name) { this.attrs.delete(name); },
    toggleAttribute(name, on) { if (on) this.attrs.set(name, ""); else this.attrs.delete(name); },
    addEventListener(name, handler) { this.handlers[name] = handler; },
    querySelector(selector) { return query(selector, descendants(this))[0] ?? null; },
    querySelectorAll(selector) { return query(selector, descendants(this)); },
    replaceChildren(...children) { this.children = children; },
    append(...children) { this.children.push(...children); },
    focus() { document.activeElement = this; }, scrollIntoView() {}, closest() { return null; },
    getBoundingClientRect() { return { top: 100, bottom: 130 }; },
    getClientRects() {
      for (let current = this; current; current = current.parent) if (current.attrs.has("hidden")) return [];
      return [{}];
    },
    setCustomValidity() {},
    classList: { toggle() {} },
  });
  for (const node of elements) {
    decorate(node);
    Object.defineProperty(node, "hidden", {
      get() { return this.attrs.has("hidden"); },
      set(value) { this.toggleAttribute("hidden", value); },
    });
  }
  const element = id => {
    const node = elements.find(item => item.attrs.get("id") === id);
    assert.ok(node, `${page} has no #${id}`);
    return node;
  };
  const document = { body: elements.find(node => node.tag === "body"), hidden: false,
    getElementById: element, querySelector: selector => query(selector)[0] ?? null,
    querySelectorAll: query, addEventListener() {},
    createElement: tag => decorate({ tag, attrs: new Map(), parent: null }),
  };
  const shown = selector => query(selector).some(node => {
    for (let current = node; current; current = current.parent) if (current.attrs.has("hidden")) return false;
    return true;
  });
  return {
    element, document, snapshots, probe: { shown, marked: () => false },
    window: { addEventListener(name, handler) { windows[name] = handler; }, setTimeout: () => 1, clearTimeout() {},
      setInterval: () => 1, clearInterval() {} },
    windows,
    capture() {
      const copies = new Map(elements.map(node => [node, { tag: node.tag, attrs: new Map(node.attrs), parent: null }]));
      for (const [node, copy] of copies) copy.parent = copies.get(node.parent) ?? node.parent;
      snapshots.push([...copies.values()]);
    },
    async click(id) {
      await element(id).handlers.click({ currentTarget: element(id) });
      await new Promise(resolve => setImmediate(resolve));
    },
  };
}

const guideTip = (page, id) => guides[page].chapters.flatMap(chapter => chapter.tips).find(tip => tip.id === id);
function assertTipVisible(dom, page, id, expected) {
  const tip = guideTip(page, id);
  assert.equal(dom.probe.shown(tip.target), expected, `${page}/${id} target visibility`);
  assert.equal(currentTip([tip], dom.probe), expected ? 0 : -1, `${page}/${id} is offered only in its state`);
}

const expiresAt = "2026-11-17T03:02:51.040Z";
const claudeSnapshot = (runtime = "running") => ({
  target: "n8n-claude-oauth", endpoint: "http://relmio-claude:14502/v1", auth: { configured: true, disclosure: "one-time" },
  canRemove: true, models: ["claude-sonnet-5-5"], expiresAt, approvalExpired: false, runtime,
});

async function localGuideStates() {
  const dom = pageDom("local");
  const { element } = dom;
  // The surrounding wizard has reached Ready; the real card controller owns everything inside it.
  for (let node = element("n8n-claude-management").parent; node; node = node.parent) node.attrs.delete("hidden");
  let reply;
  const context = {
    ...dom, formatLocalDateTime, state: { installedTarget: "n8n-claude-oauth", operationBusy: false,
      claudeStatusTimer: null, claudeStatusGeneration: 0, claudeStatusChecks: 0 },
    api: async path => { assert.equal(path, "/api/local/claude/auth-status"); return reply; },
    assertDashboardKeys(value, keys) { assert.deepEqual(Object.keys(value).sort(), [...keys].sort()); },
    dashboardContractError: () => new Error("invalid dashboard"),
    isSafeDockerDisplayName: value => /^[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(value),
    resetDashboardActionReview() {}, renderFooterForTarget() {}, setBusy: () => true, clearError() {},
    showError(error) { throw error; },
  };
  const ui = runInNewContext([
    localScript("const CLAUDE_REVIEW_KEYS", "\nconst token = readWizardSession"),
    localScript("function hasExactKeys", "\nfunction isSafeAssistantUrl"),
    localScript("function localTime(iso)", "\nfunction isDashboardSnapshotStale"),
    localScript("function normalizeN8nClaudeDashboardSnapshot", "\nfunction normalizeDashboardServiceSnapshot"),
    localScript("function readClaudeReview(kind)", "\nfunction isN8nLocalModel(target)"),
    localScript('element("claude-check-sign-in").addEventListener', '\nfor (const action of ["renew"'),
    "({ renderClaudeManagement, renderClaudeInstallResult, setClaudeOneTimeKey });",
  ].join("\n"), context);
  ui.renderClaudeManagement(claudeSnapshot());
  assert.equal(element("claude-auth-status").dataset.guideState, "unchecked");
  assert.equal(tipDone(guideTip("local", "claude-check"), dom.probe), false);
  assertTipVisible(dom, "local", "claude-key", false);
  for (const [loggedIn, authMethod, expected] of [[false, null, "waiting"], [true, "api_key", "waiting"], [true, "claude.ai", "ready"]]) {
    reply = { loggedIn, authMethod, subscriptionType: "max" };
    await dom.click("claude-check-sign-in");
    assert.equal(element("claude-auth-status").dataset.guideState, expected);
    assert.equal(tipDone(guideTip("local", "claude-check"), dom.probe), expected === "ready");
    dom.capture();
  }
  for (const [runtime, expected] of [["restarting", "not-running"], ["unhealthy", "not-running"],
    ["starting", "starting"], ["stopped", "stopped"], ["running", "running"]]) {
    ui.renderClaudeManagement(claudeSnapshot(runtime));
    assert.equal(element("claude-runtime-status").dataset.guideState, expected);
    assertTipVisible(dom, "local", "claude-restarting", expected === "not-running");
    assert.equal(tipDone(guideTip("local", "claude-check"), dom.probe), false, "new management status requires a fresh sign-in check");
    dom.capture();
  }
  ui.renderClaudeInstallResult({ target: "n8n-claude-oauth", endpoint: claudeSnapshot().endpoint,
    baseUrl: claudeSnapshot().endpoint, protocol: "openai-chat-completions", networkName: "fixture-net",
    n8nContainerName: "n8n-fixture", hostPublication: "none", clientCredential: "Q".repeat(43),
    credentialShownOnce: true, deploymentMode: "installed", models: ["claude-sonnet-5-5"], expiresAt });
  assert.equal(element("claude-client-key").textContent, "Q".repeat(43));
  assert.equal(element("claude-copy-key").dataset.guideState, "fresh");
  assertTipVisible(dom, "local", "claude-key", true);
  assertTipVisible(dom, "local", "claude-restarting", false);
  dom.capture();
  ui.setClaudeOneTimeKey("");
  assert.equal(element("claude-client-key").textContent, "");
  assert.equal(element("claude-one-time-key").hidden, true);
  assert.notEqual(element("claude-copy-key").dataset.guideState, "fresh");
  assertTipVisible(dom, "local", "claude-key", false);
  return dom.snapshots;
}

async function vpsGuideStates() {
  const dom = pageDom("claude-vps");
  const { element } = dom;
  let status = { state: "installed", installation: { container: "running", approvalExpired: false, expiresAt,
    models: ["claude-sonnet-5-5"] }, loginCommand: "ssh -t root@fixture.example sh /docker/n8n-openai-oauth/claude/login.sh" };
  let auth = { loggedIn: false, authMethod: null, subscriptionType: null };
  const ui = runInNewContext(`${claudeSource.replace(/^import .*;\r?\n/gmu, "")}\n({ state, refreshStatus });`, {
    ...dom, innerHeight: 720, readWizardSession: () => "fixture-token", initWizardTopbar() {}, wizardApiError, formatLocalDateTime,
    flashCopied() {}, clearFieldError() {}, markRejectedField: text => text,
    createCredentialSshGuard: () => ({ before: async () => {}, after: async () => {}, refreshHostReport() {},
      adoptCurrent: async () => { throw new Error("Connect to the VPS first."); } }),
    bindSshAuthentication: () => ({ sync() {} }),
    navigator: { clipboard: { writeText: async () => {} } },
    fetch: async path => {
      const value = path.endsWith("/status") ? status : path.endsWith("/auth-status") ? auth
        : path.endsWith("/apply") ? { clientKey: "one-time-fixture-key" } : assert.fail(`Unexpected API ${path}`);
      return { ok: true, status: 200, json: async () => value };
    },
    relmioGuide: { clearError() {}, error(error) { throw error; } },
  });
  await new Promise(resolve => setImmediate(resolve));
  await ui.refreshStatus();
  assert.equal(element("login-state").dataset.guideState, "unchecked");
  assert.equal(tipDone(guideTip("claude-vps", "auth"), dom.probe), false);
  assertTipVisible(dom, "claude-vps", "key", false);
  for (const [loggedIn, authMethod, expected] of [[false, null, "waiting"], [true, "api_key", "waiting"], [true, "claude.ai", "ready"]]) {
    auth = { loggedIn, authMethod, subscriptionType: "max" };
    await dom.click("auth-button");
    assert.equal(element("login-state").dataset.guideState, expected);
    assert.equal(tipDone(guideTip("claude-vps", "auth"), dom.probe), expected === "ready");
    dom.capture();
  }
  for (const [container, approvalExpired, trouble, expired] of [
    ["stopped", false, true, false], ["restarting", false, true, false], ["unhealthy", false, true, false],
    ["stopped", true, false, true], ["running", true, false, true], ["running", false, false, false],
  ]) {
    status = { ...status, installation: { ...status.installation, container, approvalExpired } };
    await ui.refreshStatus();
    assertTipVisible(dom, "claude-vps", "not-running", trouble);
    assertTipVisible(dom, "claude-vps", "approval-expired", expired);
    assert.equal(tipDone(guideTip("claude-vps", "auth"), dom.probe), false);
    dom.capture();
  }
  ui.state.plan = { planId: "fixture-plan" };
  element("confirm-action").checked = true;
  await dom.click("apply-button");
  assert.equal(element("client-key").value, "one-time-fixture-key");
  assert.equal(element("copy-key").dataset.guideState, "fresh");
  assertTipVisible(dom, "claude-vps", "key", true);
  dom.capture();
  await ui.refreshStatus();
  assertTipVisible(dom, "claude-vps", "key", true);
  element("client-key").value = "saved-key";
  element("client-key").handlers.input();
  assert.notEqual(element("copy-key").dataset.guideState, "fresh");
  assertTipVisible(dom, "claude-vps", "key", false);
  dom.windows.pagehide();
  assert.equal(element("client-key").value, "");
  assertTipVisible(dom, "claude-vps", "key", false);
  return dom.snapshots;
}

async function unconfirmedInstall() {
  const dom = pageDom("local");
  const state = { plan: { target: "xai-grok-build" }, planId: "fixture-plan", operationBusy: false };
  dom.element("install-confirm").checked = true;
  let shown;
  runInNewContext([
    localScript("const LOCAL_PORT_REJECTION", "\nfunction clearFieldErrors"),
    localScript("function isCodexChat(target)", "\nfunction isN8nDockerTarget"),
    localScript('element("install-button").addEventListener', '\nelement("remove-bridge-confirm")'),
  ].join("\n"), {
    ...dom, state, clearError() {}, setMessage() {}, showStep() {},
    startInstallProgress: () => true, stopInstallProgress() {}, resetBasicAuthPasswordVisibility() {},
    invalidatePlan() { state.plan = null; state.planId = null; },
    api: async () => { throw new Error("Synthetic Docker failure"); },
    showError(error) { shown = error; },
  });
  await dom.click("install-button");
  return shown;
}

function refusedSsh({ authentication = false } = {}) {
  const client = new EventEmitter();
  client.end = () => {};
  client.connect = () => queueMicrotask(() => authentication
    ? client.emit("error", Object.assign(new Error("synthetic refusal"), { level: "client-authentication" }))
    : client.emit("ready"));
  client.exec = (_command, callback) => {
    const stream = new EventEmitter();
    stream.stderr = new EventEmitter();
    stream.destroy = () => {};
    stream.end = () => queueMicrotask(() => { stream.emit("data", Buffer.from("1000\n")); stream.emit("close", 0); });
    callback(null, stream);
  };
  return connectVerified({ host: "fixture.example", port: 22, username: "root", password: "fixture-only",
    useAgent: false, privilege: "root", expectedFingerprint: formatSha256Fingerprint("ab".repeat(32)) },
  { createClient: () => client });
}

// Only the install path up to its injected failure; unknown remote commands reject.
function failingInstallRemote(product, failure) {
  const model = product === "model";
  const root = `/docker/n8n-openai-oauth/${model ? "local-model" : "supergrok"}`;
  const lock = VPS_OPERATION_LOCKS[model ? "model" : "supergrok"];
  const containerId = "a".repeat(64), networkId = "b".repeat(64);
  const files = new Map();
  let marker, pending, built = false;
  const ok = (stdout = "") => ({ code: 0, stdout });
  const failed = { code: 7, stdout: "", stderr: "synthetic command failure" };
  return {
    async upload(path, text) {
      files.set(path.slice(root.length + 1), text);
      if (path.endsWith("/.managed-by-relmio.json")) marker = JSON.parse(text);
      if (path.endsWith("/.managed-by-relmio.json.next")) pending = JSON.parse(text);
    },
    async exec(command) {
      if ((failure === "config" && command.includes(" config --quiet")) ||
          (failure === "build" && command.includes(" build ")) ||
          (failure === "image-check" && built && command.startsWith("docker image inspect ")) ||
          (failure === "start" && command.includes(" up -d --wait "))) return failed;
      if (command === PRECHECK_COMMAND) return ok("managed");
      if (command === "[ -d /docker ] && [ ! -L /docker ] && stat -c %u:%a /docker") return ok("0:755");
      if (command.includes("printf absent")) return ok(marker ? JSON.stringify(marker) : "absent");
      if (command.includes("json .Id")) return ok(`${JSON.stringify(containerId)}|true|${JSON.stringify({ "fixture-net": { NetworkID: networkId } })}`);
      if (command.startsWith("docker network inspect ")) return ok(JSON.stringify({
        Id: networkId, Name: "fixture-net", Driver: "bridge", Scope: "local", Internal: false, Options: {}, Containers: {},
      }));
      if (command.startsWith("docker info ")) return ok(`${16 * 1024 ** 3}|4|"/var/lib/docker"`);
      if (command.startsWith("df -B1 ")) return ok(`Avail\n${50 * 1024 ** 3}\n`);
      if (command.startsWith("sed -n ")) return ok(`${8 * 1024 ** 2}\n`);
      if (/^docker (?:container|volume) inspect /u.test(command)) return failed;
      if (/^docker (?:ps -a|volume ls|image ls) --/u.test(command)) return ok();
      if (command.startsWith(SHARED_ROOT_COMMAND) || command === SHARED_ROOT_TIGHTEN_COMMAND) return ok();
      if (command === createVpsLockCommand(lock)) return ok("11:22");
      if (command === createVpsBuildStateCommand(lock, "11:22")) return ok("11:33");
      if (command === cleanupVpsBuildStateCommand(lock, "11:22", "11:33") ||
          command === releaseVpsLockCommand(lock, "11:22")) return ok();
      if (command.includes(`mv -T -- ${root}/.managed-by-relmio.json.next`)) {
        marker = pending;
        files.set(".managed-by-relmio.json", JSON.stringify(marker));
        files.delete(".managed-by-relmio.json.next");
        return ok();
      }
      if (command.includes(`stat -c '%d:%i' ${root}`)) return ok("22:33");
      if (command.includes(`sha256sum ${root}/.managed-by-relmio.json | cut`)) return ok(createHash("sha256").update(JSON.stringify(marker)).digest("hex"));
      if (command.includes(`find ${root} -mindepth 1`)) return ok([...files.keys()].join("\n"));
      if (command.startsWith(`[ ! -L ${root}/`) || command.endsWith(`umask 077 && mkdir ${root}`)) return ok();
      if (command.includes(" config --quiet")) return ok();
      if (command.includes(" BUILDX_CONFIG=") && command.includes(" build ")) { built = true; return ok(); }
      if (command.startsWith("docker image inspect ")) return built ? ok(JSON.stringify({
        Id: `sha256:${"c".repeat(64)}`, Config: { Labels: { "io.relmio.managed": "true",
          "io.relmio.install": marker.installId, "io.relmio.target": model ? "n8n-local-model" : "n8n-supergrok-oauth" } },
      })) : failed;
      throw new Error(`Unexpected fake remote command: ${command}`);
    },
  };
}

test("typed refusals produced by real failures select their own guide entries", async t => {
  const producers = [
    ...TYPED_REFUSALS.slice(0, 10).map((code, index) => [code,
      () => parseAdministrativeProbe({ code: 70 + index, stdout: "" })]),
    ["vps_prereq_rootless", () => parseAdministrativeProbe({ code: 0,
      stdout: '0\nunix:///var/run/docker.sock\n/usr/bin/docker\ndefault\n{"OSType":"linux","ServerVersion":"28.0.1","SecurityOptions":["name=rootless"]}\n2.39.2\ndefault\n' })],
    ["vps_prereq_probe", () => parseAdministrativeProbe({ code: 99, stdout: "" })],
    ["ssh_root_login_disabled", () => parseLoginUid({ code: 1, stdout: 'Please login as the user "ubuntu" rather than the user "root".\n' })],
    ["ssh_auth_refused", () => refusedSsh({ authentication: true })],
    ["ssh_not_root", () => refusedSsh()],
    ["vps_operation_lock", () => withVpsOperationLock({ exec: async () => ({ code: 1, stdout: "" }) },
      VPS_OPERATION_LOCKS.supergrok, () => assert.fail("held lock must not run the operation"))],
    ["vps_network_unsupported", () => assertVpsNetworkSupported({ Name: "bridge", Driver: "bridge" })],
    ["vps_host_unsupported_cpu", () => requireSupportedVpsCpu({ arch: "riscv64" }, "SuperGrok")],
  ];
  for (const product of ["supergrok", "model"]) {
    for (const [failure, code] of [["config", "vps_step_compose_config"], ["build", "vps_step_build"],
      ["image-check", "vps_step_image_check"], ["start", "vps_step_start"]]) {
      producers.push([code, async () => {
        const remote = failingInstallRemote(product, failure);
        const model = product === "model";
        const review = model ? reviewVpsLocalModel : reviewVpsSuperGrok;
        const install = model ? installVpsLocalModel : installVpsSuperGrok;
        const plan = await review({ remote, containerName: "n8n-fixture", networkName: "fixture-net", action: "install",
          ...(model ? { modelId: "qwen3:0.6b" } : {}) });
        return install({ remote, plan, confirmed: true }, { entropy: size => Buffer.alloc(size, 0xcc),
          readAssets: async () => model ? { "catalog.mjs": "synthetic catalog", "acquisition.mjs": "synthetic acquisition" }
            : { "gateway.js": "synthetic gateway", "chat.js": "synthetic chat", "session.js": "synthetic session" } });
      }, product]);
    }
  }
  for (const [code, produce, product = ""] of producers) {
    await t.test(`${code} ${product}`.trim(), async () => {
      await assert.rejects(async () => produce(), error => {
        assert.equal(error.code, code);
        assert.equal(lookupError(GUIDE_ERRORS, error), GUIDE_ERRORS.codes[code]);
        return true;
      });
    });
  }
  await t.test("install_unconfirmed", async () => {
    const error = await unconfirmedInstall();
    assert.equal(error.errorCode, "install_unconfirmed");
    assert.equal(lookupError(GUIDE_ERRORS, error), GUIDE_ERRORS.codes.install_unconfirmed);
  });
  assert.deepEqual(new Set([...producers.map(([code]) => code), "install_unconfirmed"]), new Set(TYPED_REFUSALS));
});

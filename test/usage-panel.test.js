import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";

import { renderUsage } from "../src/ui/usage-panel.js";
import { startWizardServer } from "../src/web/server.js";

const MANAGE = "https://chatgpt.com/settings/usage";
const sessionToken = "usage-panel-test-session-token-0123456789abcdef";
const account = { label: "Work <img src=x onerror=alert(1)>", email: "account@example.test", session: "connected",
  planPermission: "granted", planEnabled: true, registrationId: "fixture_registration_1", ownership: "owned" };
const zero = { requests: 0, completed: 0, failed: 0, incomplete: 0, input: 0, cached: 0, output: 0, reasoning: 0, total: 0 };
const blank = (state) => ({ state, since: null, updatedAt: null, totals: zero, activeDays: 0, peakDay: null,
  days: [], models: [], lastUsageEvent: null });
const row = (id, requests, total) => ({ id, requests, total, input: 0, cached: 0, output: 0, reasoning: 0 });
const ok = (overrides = {}) => ({
  state: "ok", since: "2026-09-08T00:00:00.000Z", updatedAt: "2026-10-07T12:00:30.000Z",
  totals: { ...zero, requests: 98_765, completed: 98_000, failed: 700, incomplete: 60, total: 1_234_567 },
  activeDays: 9, peakDay: { date: "2026-10-03", total: 220_000 },
  days: [{ date: "2026-10-03", requests: 1_000, total: 220_000 }],
  models: [row("gpt-6-sol", 90_000, 1_200_000), row("gpt-6-luna", 8_000, 0),
    ...Array.from({ length: 5 }, (_, index) => row(`gpt-extra-${index}`, 1, 10)), row("other", 760, 34_517)],
  lastUsageEvent: null,
  ...overrides,
});
const event = (code, recovery) => ({ at: "2026-10-07T11:00:00.000Z", code, recovery });
const settle = () => new Promise((resolve) => setImmediate(resolve));

// A DOM that only builds text: setting innerHTML, outerHTML or insertAdjacentHTML throws.
function createNode(tag) {
  let text = "";
  return {
    tag, className: "", children: [], attributes: new Map(), hidden: false, disabled: false, listeners: {},
    style: { values: new Map(), setProperty(name, value) { this.values.set(name, value); } },
    get textContent() { return text + this.children.map((child) => child.textContent).join(""); },
    set textContent(value) { text = String(value); this.children = []; },
    append(...items) { this.children.push(...items); },
    replaceChildren(...items) { text = ""; this.children = items; },
    setAttribute(name, value) { this.attributes.set(name, String(value)); },
    removeAttribute(name) { this.attributes.delete(name); },
    addEventListener(type, listener) { this.listeners[type] = listener; },
    set innerHTML(_) { throw new Error("usage text must not be parsed as HTML"); },
    set outerHTML(_) { throw new Error("usage text must not be parsed as HTML"); },
    insertAdjacentHTML() { throw new Error("usage text must not be parsed as HTML"); },
  };
}
globalThis.document = { createElement: createNode };

const flat = (node) => [node, ...node.children.flatMap(flat)];
const english = (parts, info) => renderUsage(parts, { ...info, locale: "en-US" });
function render(info) {
  const parts = { status: createNode("p"), view: createNode("div") };
  english(parts, info);
  const nodes = flat(parts.view);
  return {
    status: parts.status.textContent,
    text: parts.view.textContent,
    nodes,
    manage: nodes.filter((node) => node.tag === "a" && node.href === MANAGE),
    terms: Object.fromEntries(nodes.filter((node) => node.tag === "dt")
      .map((term) => [term.textContent, nodes[nodes.indexOf(term) + 1].textContent])),
  };
}

function slice(source, start, end) {
  const from = source.indexOf(start);
  const to = source.indexOf(end, from);
  assert.ok(from >= 0 && to > from, `missing ${start}`);
  return source.slice(from, to);
}

function page() {
  const nodes = new Map();
  return (id) => nodes.get(id) ?? nodes.set(id, createNode(id)).get(id);
}

test("each usage state explains itself and keeps Refresh usage as the way forward", () => {
  const idle = render({ page: "vps", account });
  assert.match(idle.status, /Press Refresh usage/u);
  assert.equal(idle.manage.length, 1, "the note always links Manage usage");
  assert.match(render({ page: "local", account, loading: true }).status, /^Reading request counts/u);

  const counted = render({ page: "vps", account, usage: ok() });
  assert.match(counted.status, /^Updated /u);
  assert.equal(counted.terms.Requests, "98,765");

  const vpsEmpty = render({ page: "vps", account, usage: blank("empty") });
  const localEmpty = render({ page: "local", account, usage: blank("empty") });
  assert.match(vpsEmpty.status, /Review sidecar update/u, "an empty VPS view points at the sidecar update");
  assert.doesNotMatch(localEmpty.status, /Review sidecar update/u, "the local page has no such button");
  for (const view of [vpsEmpty, localEmpty]) {
    assert.match(view.status, /No requests counted/u);
    assert.equal(view.terms.Requests, undefined, "an empty view shows no totals");
  }

  for (const name of ["vps", "local"]) {
    const unavailable = render({ page: name, account, usage: blank("unavailable") });
    assert.match(unavailable.status, /could not be read.*Refresh usage/u);
    assert.equal(unavailable.terms.Requests, undefined);
  }

  // A view with any malformed field reads as unavailable instead of showing part of it.
  for (const broken of [{ ...ok(), totals: { ...ok().totals, requests: -1 } }, { ...ok(), state: "full" },
    { ...ok(), models: [{ id: "gpt-6-sol", requests: "1", total: 0 }] }, { ...ok(), updatedAt: "yesterday" },
    { ...ok(), lastUsageEvent: event("subscription_sharing_unknown", "none") }]) {
    const view = render({ page: "vps", account, usage: broken });
    assert.match(view.status, /could not be read/u);
    assert.doesNotMatch(view.text, /98,765|gpt-6-sol/u);
  }
});

test("counts are formatted numbers, never percentages, and the bars are decoration", () => {
  const view = render({ page: "local", account, usage: ok() });
  for (const value of ["98,765", "1,234,567", "98,000 completed", "700 failed", "60 incomplete", "5 cancelled",
    "90,000 requests · 1,200,000 tokens", "220,000 tokens", "Oct 3", "since Sep 8", "Other models"]) {
    assert.ok(view.text.includes(value), `missing ${value}`);
  }
  assert.doesNotMatch(`${view.status} ${view.text}`, /%|percent/iu, "plan percent is never shown or derived");
  const [tokenLabel, tokenTotal] = Object.entries(view.terms).find(([term]) => /^Tokens/u.test(term));
  assert.equal(tokenTotal, "1,234,567");
  assert.match(tokenLabel, /completed/u, "the token total says it counts completed responses only");
  assert.doesNotMatch(view.text, /resets? (?:at|in|on)\b/iu, "no reset time is shown");

  const bars = view.nodes.filter((node) => node.className === "rm-progress__bar");
  assert.equal(bars.length, 8);
  assert.ok(view.nodes.filter((node) => node.className.includes("usage-panel__bar"))
    .every((track) => track.attributes.get("aria-hidden") === "true"));
  assert.equal(bars[0].style.values.get("--rm-progress"), "100%");
  assert.equal(bars[1].style.values.get("--rm-progress"), "2%", "a model without tokens keeps a visible stub");

  const top = view.nodes.find((node) => node.tag === "ul");
  assert.equal(top.children.length, 3, "the busiest models stay visible");
  assert.ok(view.nodes.some((node) => node.tag === "summary" && node.textContent === "5 more models"));
});

test("the panel shows the account, plan use, image plan type and model checks it is given", () => {
  const vps = render({ page: "vps", account, imagePlan: "plus", models: { listed: 12, verified: 3 }, usage: ok() });
  assert.equal(vps.terms.Account, `${account.label} (${account.email})`, "untrusted text stays text");
  assert.equal(vps.terms["Plan use"], "On");
  assert.match(vps.terms["Image add-on plan type"], /^plus .*not document/u, "the plan type says OpenAI does not document it");
  assert.equal(vps.terms.Models, "12 listed by OpenAI · 3 verified by a completed request");

  const local = render({ page: "local", account: { ...account, planEnabled: false }, models: { listed: null }, usage: ok() });
  assert.equal(local.terms["Plan use"], "Paused");
  assert.equal(local.terms["Image add-on plan type"], undefined, "the image plan shows only while that add-on is signed in");
  assert.equal(local.terms.Models, "6 verified by a completed request in the last 30 days",
    "without model checks, only named models that returned tokens count as verified");
  assert.equal(render({ page: "vps", account: { ...account, session: "signed-out" } }).terms["Plan use"], "Signed out");
  const fresh = render({ page: "vps", account: { ...account, session: "reauthorize" } }).terms["Plan use"];
  assert.notEqual(fresh, "Signed out", "an account that needs a fresh sign-in is not shown as signed out");
  assert.match(fresh, /sign-in/u);
});

test("the last plan usage event names its next step, and only a usage limit offers Manage usage", () => {
  const recoveries = {
    subscription_sharing_usage_limit_exceeded: "manage-usage",
    subscription_sharing_usage_unavailable: "retry-later",
    subscription_sharing_user_unavailable: "retry-later",
    subscription_sharing_user_not_eligible: "none",
  };
  const titles = new Set();
  for (const [code, recovery] of Object.entries(recoveries)) {
    for (const usage of [ok({ lastUsageEvent: event(code, recovery) }), { ...blank("empty"), lastUsageEvent: event(code, recovery) }]) {
      const view = render({ page: "vps", account, usage });
      const box = view.nodes.find((node) => node.className === "usage-panel__event");
      const [status, next] = box.children;
      titles.add(status.textContent);
      assert.match(status.textContent, /[A-Z][a-z]{2} \d{1,2}, /u, "the event says when it happened");
      assert.ok(next.textContent.trim(), `${code} names a next step`);
      assert.equal(/limit/iu.test(status.textContent), code === "subscription_sharing_usage_limit_exceeded",
        `${code}: only a usage limit is titled as a limit`);
      assert.doesNotMatch(box.textContent, /switch to|another account/iu, "never suggests rotating accounts");
      assert.doesNotMatch(box.textContent, /resets? (?:at|in|on)\b/iu, "no reset time is shown");
      const button = flat(box).find((node) => node.tag === "a");
      assert.equal(Boolean(button), recovery === "manage-usage", code);
      if (button) {
        assert.equal(button.href, MANAGE);
        assert.equal(button.target, "_blank");
        assert.equal(button.rel, "noopener noreferrer");
        assert.match(button.textContent, /opens in a new tab/u);
      }
      assert.equal(view.manage.length, recovery === "manage-usage" ? 2 : 1);
    }
  }
  assert.equal(titles.size, Object.keys(recoveries).length, "each code has its own title");
  assert.ok(!render({ page: "vps", account, usage: ok() }).nodes.some((node) => node.className === "usage-panel__event"));
});

test("a refused refresh explains how to recover and keeps the last counts on screen", () => {
  const conflict = Object.assign(new Error("Review this VPS owner and destination again."), { status: 409 });
  const limited = Object.assign(new Error("Too many attempts. Wait a few minutes and try again."), { status: 429 });
  const vps = render({ page: "vps", account, usage: ok(), error: conflict });
  assert.match(vps.status, /Check installed account again, then Refresh usage/u);
  assert.equal(vps.terms.Requests, "98,765", "the last counts stay visible");
  assert.match(vps.status, /The counts shown are from [A-Z][a-z]{2} \d{1,2}, /u, "kept counts say how old they are");
  assert.match(render({ page: "local", account, error: conflict }).status, /Refresh usage again/u);
  for (const name of ["vps", "local"]) {
    assert.match(render({ page: name, account, error: limited }).status, /10 times in 15 minutes.*Wait a few minutes.*Refresh usage/u);
  }
  const failed = render({ page: "local", account, error: Object.assign(new Error("The local wizard is not reachable."), { status: 502 }) });
  assert.equal(failed.status, "The local wizard is not reachable. Press Refresh usage to try again.");
});

test("VPS Refresh usage reads only the checked owner and keeps a 409 recoverable", async () => {
  const source = await readFile(new URL("../src/ui/app.js", import.meta.url), "utf8");
  const code = [slice(source, "async function renderVpsUsage(", "\nfunction vpsOwnerModelBadge"),
    slice(source, 'element("vps-usage-refresh").addEventListener', '\nelement("vps-owner-inspect").addEventListener')].join("\n");
  const element = page();
  const requests = [];
  let reply = async () => ok();
  const owner = { state: "owned", account, registrationId: account.registrationId, containerName: "n8n", networkName: "n8n_default" };
  const state = { vpsOwner: owner, vpsModels: { state: "available", models: [{ state: "verified" }, { state: "failed" }] },
    vpsImages: { state: "signed-in", account: { planType: "pro" } } };
  const context = {
    state, element, usagePanel: Promise.resolve({ renderUsage: english }),
    runOperation: async (_button, _label, work) => work(),
    api: async (path, options) => { requests.push([path, options]); return reply(); },
  };
  runInNewContext(code, context);
  const refresh = () => element("vps-usage-refresh").listeners.click({ currentTarget: element("vps-usage-refresh") });
  const shown = () => `${element("vps-usage-status").textContent}\n${element("vps-usage-view").textContent}`;

  await refresh();
  assert.deepEqual(JSON.parse(JSON.stringify(requests)), [["/api/siwc/vps/usage/status", { method: "POST",
    body: { containerName: "n8n", networkName: "n8n_default", registrationId: account.registrationId } }]]);
  assert.equal(element("vps-usage").hidden, false);
  assert.match(shown(), /^Updated /u);
  assert.match(shown(), /2 listed by OpenAI · 1 verified by a completed request/u);
  assert.match(shown(), /Image add-on plan typepro/u);

  reply = async () => { throw Object.assign(new Error("Review this VPS owner and destination again."), { status: 409 }); };
  await refresh();
  assert.match(shown(), /^Press Check installed account again/u);
  assert.match(shown(), /98,765/u, "the last counts stay after a refused refresh");

  state.vpsOwner = { ...owner };
  await context.renderVpsUsage();
  assert.match(shown(), /^Updated /u, "a fresh owner check clears the refusal");
  state.vpsOwner = { ...owner, registrationId: "fixture_registration_2" };
  await context.renderVpsUsage();
  assert.doesNotMatch(shown(), /98,765/u, "another registration never sees these counts");
  state.vpsOwner = { ...owner, state: "stopped" };
  await context.renderVpsUsage();
  assert.equal(element("vps-usage").hidden, true, "only a checked, owned sidecar shows the panel");
  assert.equal(requests.length, 2);
});

test("the local dashboard reads counts only from a running n8n sidecar and drops stale reads", async () => {
  const source = await readFile(new URL("../src/ui/local.js", import.meta.url), "utf8");
  const code = slice(source, "async function loadLocalUsage(", "\nfunction initializeLocalUsage(");
  const element = page();
  const calls = [];
  const pending = [];
  const sidecar = (serviceState) => ({ services: [{ target: "n8n-openai-oauth", state: serviceState,
    snapshot: serviceState === "absent" ? null : { auth: { account } } }] });
  const state = { dashboardSnapshot: sidecar("absent"), dashboardUsage: null, installedUsage: null };
  const context = { state, element, usagePanel: Promise.resolve({ renderUsage: english }),
    api: (path) => { calls.push(path); return new Promise((resolve) => pending.push(resolve)); } };
  runInNewContext(code, context);

  element("dashboard-usage").hidden = true;
  context.showDashboardUsage();
  element("dashboard-usage").hidden = false;
  for (const serviceState of ["absent", "stopped"]) {
    state.dashboardSnapshot = sidecar(serviceState);
    context.showDashboardUsage();
    await settle();
    assert.equal(element("dashboard-usage-refresh").hidden, true, serviceState);
  }
  assert.match(element("dashboard-usage-status").textContent, /not running.*Connections/u);
  assert.deepEqual(calls, [], "no sidecar to read means no request");

  state.dashboardSnapshot = sidecar("healthy");
  context.showDashboardUsage();
  await settle();
  context.showDashboardUsage();
  await settle();
  assert.deepEqual(calls, ["/api/local/usage/status", "/api/local/usage/status"]);
  assert.equal(element("dashboard-usage-refresh").attributes.get("aria-busy"), "true");
  pending[1](ok());
  await settle();
  pending[0](blank("unavailable"));
  await settle();
  assert.match(element("dashboard-usage-status").textContent, /^Updated /u, "the older read never overwrites the newer one");
  assert.equal(element("dashboard-usage-refresh").disabled, false);
  assert.equal(element("dashboard-usage-refresh").attributes.has("aria-busy"), false);
  assert.match(element("dashboard-usage-view").textContent, /Work <img src=x onerror=alert\(1\)> \(account@example\.test\)/u);

  state.installedUsage = { account, listed: 3 };
  void context.loadLocalUsage("installed");
  await settle();
  pending[2](blank("empty"));
  await settle();
  assert.match(element("installed-usage-status").textContent, /^No requests counted/u);
  assert.match(element("installed-usage-view").textContent, /3 listed by OpenAI/u);
});

test("the panel module brings its own stylesheet, so no page blocks on it", async (t) => {
  const wizard = await startWizardServer({ sessionToken });
  t.after(() => wizard.close());
  for (const [path, type] of [["/usage-panel.js", "text/javascript"], ["/usage-panel.css", "text/css"]]) {
    const response = await fetch(`${wizard.origin}${path}`);
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get("content-type"), `${type}; charset=utf-8`);
  }
  for (const file of ["index.html", "local.html"]) {
    const html = await readFile(new URL(`../src/ui/${file}`, import.meta.url), "utf8");
    assert.doesNotMatch(html, /usage-panel\.css/u, `${file} does not load the panel stylesheet up front`);
  }

  // In a page, the module adds the stylesheet and finishes loading only once it has loaded.
  const head = createNode("head");
  let added;
  const appended = new Promise((resolve) => { added = resolve; });
  head.append = (...items) => { head.children.push(...items); added(items[0]); };
  globalThis.document = { createElement: createNode, head };
  t.after(() => { globalThis.document = { createElement: createNode }; });
  let ready = false;
  const loading = import("../src/ui/usage-panel.js?in-page").then((module) => { ready = true; return module; });
  const link = await Promise.race([appended, loading.then(() => null)]);
  assert.deepEqual([link?.tag, link?.rel, link?.href], ["link", "stylesheet", "/usage-panel.css"]);
  await settle();
  assert.equal(ready, false, "the panel cannot render before its stylesheet");
  link.listeners.load();
  assert.equal(typeof (await loading).renderUsage, "function");
  assert.equal(head.children.length, 1);
});

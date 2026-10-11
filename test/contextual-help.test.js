import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { mountGuide } from "../src/ui/guide-dock.js";
import { box, overlaps } from "../src/ui/guide.js";
import { contextualHelp, HELP_FAQ, HELP_METADATA, helpState, UNKNOWN_HELP, validHelpMetadata } from "../src/ui/guide/context.js";

test("help follows the actual permission, notice, ownership and preview prerequisite", () => {
  const cases = [
    [{ accountState: "new" }, "sign-in", "[data-siwc=new]"],
    [{ accountState: "new", pending: true }, "pending-sign-in", "[data-siwc=finish]"],
    [{ accountState: "identity-only" }, "permission", "[data-siwc=grant]"],
    [{ accountState: "plan-paused" }, "paused", "[data-siwc=resume]"],
    [{ accountState: "plan-active", noticePending: true }, "acknowledgment", "[data-siwc=welcome-open], [data-siwc=welcome-accept]"],
    [{ accountState: "plan-active", usageLimited: true, noticePending: true }, "usage-limit", "[data-siwc=usage]"],
    [{ accountState: "reauthorize" }, "sign-in-again", "[data-siwc=return]"],
    [{ accountState: "signed-out" }, "sign-in-again", "[data-siwc=return]"],
    [{ accountState: "transferred", noticePending: true }, "ownership-transferred", "[data-siwc=recover]"],
    [{ accountState: "handoff-pending" }, "ownership-pending", "[data-siwc=recover]"],
    [{ accountState: "host-unavailable" }, "ownership-host", "[data-siwc=new]"],
    [{ accountState: "identity-only", preview: true }, "preview", "[data-siwc=state]"],
    [{ busy: true, preview: true, accountState: "identity-only" }, "busy", "#operation-progress"],
  ];
  for (const [state, id, target] of cases) {
    const help = contextualHelp(state);
    assert.equal(help.id, id); assert.equal(help.target, target);
    if (id !== "permission") assert.notEqual(help.target, "[data-siwc=grant]", "only missing permission points at the grant");
  }
  assert.equal(contextualHelp({ accountState: "plan-active" }), null);
  assert.equal(contextualHelp({}), null);
  assert.equal(contextualHelp({ accountState: "future-state" }), UNKNOWN_HELP);
});

test("invalid or future help metadata produces a safe unknown answer", () => {
  assert.equal(validHelpMetadata(HELP_METADATA), true);
  for (const value of [null, {}, { ...HELP_METADATA, schema: 2 }, { ...HELP_METADATA, revision: 2 },
    { ...HELP_METADATA, reviewedOn: "2026-02-30" }, { ...HELP_METADATA, sources: ["../../private.md"] },
    { ...HELP_METADATA, reviewedOn: "2027-01-01" }, { ...HELP_METADATA, sourceVersion: "99.0.0" },
    { ...HELP_METADATA, sourceCommit: "not-a-commit" }, { ...HELP_METADATA, sourceVersion: "latest" }]) {
    assert.equal(validHelpMetadata(value), false);
    assert.equal(contextualHelp({ accountState: "identity-only" }, value), UNKNOWN_HELP);
  }
});

test("every help chapter carries supported source metadata and every local source exists", async () => {
  const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(HELP_METADATA.sourceVersion, manifest.version, "update bundled help metadata when the package version changes");
  for (const page of ["vps", "local", "assistant", "hosting", "supergrok-vps", "local-model-vps"]) {
    const { GUIDE } = await import(`../src/ui/guide/content-${page}.js`);
    assert.equal(validHelpMetadata(GUIDE.metadata), true, page);
  }
  for (const source of HELP_METADATA.sources) await readFile(new URL(`../${source}`, import.meta.url), "utf8");
});

test("new n8n help states the private default and optional public link", async () => {
  const { GUIDE } = await import("../src/ui/guide/content-local.js");
  const tip = GUIDE.chapters.find((chapter) => chapter.id === "choose")?.tips.find((entry) => entry.id === "cards");
  assert.ok(tip, "the local connection chooser must have a setup tip");
  assert.match(tip.say, /private to this computer by default/u);
  assert.match(tip.say, /public ngrok link is optional/u);
  assert.doesNotMatch(tip.say, /fresh n8n with a public link/u);
});

test("help reads enum and boolean state without taking account data", () => {
  const state = helpState({ dataset: { guideAccountState: "identity-only", guidePreview: "false",
    guidePlanNotice: "true", guidePending: "true", email: "private", accessToken: "private" } },
  { dataset: { operationBusy: "true" } });
  assert.deepEqual(state, { busy: true, preview: false, accountState: "identity-only",
    noticePending: true, usageLimited: false, pending: true });
  for (const item of [UNKNOWN_HELP, ...HELP_FAQ]) {
    assert.doesNotMatch(item.say, /[!\u2013\u2014]|\p{Extended_Pictographic}/u);
  }
});

// A small DOM fixture runs the actual dock handlers. It does not start a
// browser, HTTP server, OAuth flow, SSH connection or installation.
function dockHarness(t, { width = 390, reduced = true, pref = "off", missing = false } = {}) {
  const original = new Map(["document", "matchMedia", "innerHeight", "getComputedStyle", "ResizeObserver",
    "MutationObserver", "requestAnimationFrame", "addEventListener", "scrollBy"].map((key) => [key, globalThis[key]]));
  t.after(() => { for (const [key, value] of original) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; } });
  let doc;
  const selectorMatches = (node, selector) => selector.split(",").some((item) => {
    const part = item.trim();
    if (part.startsWith("#")) return node.id === part.slice(1);
    if (/^\.[\w-]+$/u.test(part)) return node.className.split(/\s/u).includes(part.slice(1));
    const attr = /^\[([\w-]+)(?:=['"]?([\w-]+)['"]?)?\]$/u.exec(part);
    if (attr) return node.getAttribute(attr[1]) !== null && (attr[2] === undefined || node.getAttribute(attr[1]) === attr[2]);
    return /^[a-z]+$/u.test(part) && node.tag === part;
  });
  class Node {
    constructor(tag) {
      this.tag = tag; this.nodeType = 1; this.children = []; this.className = ""; this.attributes = new Map();
      this.listeners = new Map(); this.dataset = {}; this.style = {}; this.hidden = false;
      this.rect = { left: 16, top: 100, right: 240, bottom: 140, width: 224, height: 40 };
      this.classList = {
        toggle: (name, on) => { const set = new Set(this.className.split(/\s/u).filter(Boolean)); if (on) set.add(name); else set.delete(name); this.className = [...set].join(" "); },
        add: (name) => this.classList.toggle(name, true), remove: (name) => this.classList.toggle(name, false),
      };
      if (["button", "input", "select"].includes(tag)) this.disabled = false;
    }
    append(...nodes) { for (const node of nodes) { node.parentElement = node.parentNode = this; this.children.push(node); } }
    replaceChildren(...nodes) { this.children = []; this.append(...nodes); }
    remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter((node) => node !== this); this.parentElement = this.parentNode = null; }
    contains(node) { return node === this || this.children.some((child) => child.contains(node)); }
    matches(selector) { return selectorMatches(this, selector); }
    querySelectorAll(selector) { return this.children.flatMap((child) => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
    closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) ?? null; }
    setAttribute(key, value) { this.attributes.set(key, String(value)); if (key === "class") this.className = value; }
    getAttribute(key) { return this.attributes.get(key) ?? null; }
    removeAttribute(key) { this.attributes.delete(key); }
    addEventListener(type, handler) { const list = this.listeners.get(type) ?? []; list.push(handler); this.listeners.set(type, list); }
    fire(type, event = {}) { for (const handler of this.listeners.get(type) ?? []) handler({ target: this, preventDefault() {}, ...event }); }
    checkVisibility() { return !this.hidden && (!this.parentElement || this.parentElement.checkVisibility()); }
    getClientRects() { return this.checkVisibility() ? [this.rect] : []; }
    getBoundingClientRect() { return this.rect; }
    get offsetWidth() { return this.className.includes("rm-guide") ? 280 : 32; }
    get offsetHeight() { return this.className === "rm-guide" ? 280 : 32; }
    get offsetTop() { return 0; }
    get isConnected() { return doc.body.contains(this); }
    focus() { doc.activeElement = this; }
    scrollIntoView() { this.scrolled = true; }
  }
  const body = new Node("body"); body.rect = { left: 0, top: 0, width, height: 844, right: width, bottom: 844 };
  const root = new Node("section"); root.className = "siwc-controls";
  root.dataset.guideAccountState = "identity-only";
  const goal = new Node("button"); goal.setAttribute("data-siwc", "grant"); goal.hidden = missing;
  let clicks = 0; goal.addEventListener("click", () => clicks++);
  root.append(goal); body.append(root);
  const panel = new Node("section"); panel.id = "panel"; panel.className = "rm-panel";
  panel.rect = { left: 16, top: 64, width: width - 32, height: 740, right: width - 16, bottom: 804 };
  body.append(panel);
  const frames = [];
  const captureListeners = new Map();
  doc = { body, activeElement: body, documentElement: { clientWidth: width },
    createElement: (tag) => new Node(tag), createElementNS: (_ns, tag) => new Node(tag),
    querySelectorAll: (selector) => body.querySelectorAll(selector), querySelector: (selector) => body.querySelector(selector),
    addEventListener(type, handler, capture) {
      if (capture !== true) return;
      const list = captureListeners.get(type) ?? [];
      list.push(handler); captureListeners.set(type, list);
    } };
  Object.assign(globalThis, { document: doc, innerHeight: 844,
    matchMedia: (query) => ({ matches: query.includes("reduced-motion") ? reduced : width >= 1024 }),
    getComputedStyle: () => ({ overflowX: "visible", overflowY: "visible" }),
    ResizeObserver: class { observe() {} unobserve() {} }, MutationObserver: class { observe() {} },
    requestAnimationFrame: (work) => { frames.push(work); return frames.length; }, addEventListener() {}, scrollBy() {},
  });
  const host = { page: "vps", toggles: [], pref, failure: null,
    content: { metadata: HELP_METADATA, chapters: [{ id: "test", panel: "#panel", tips: [
      { id: "grant", target: "[data-siwc=grant]", title: "Allow ChatGPT plan use", say: "Review the separate permission.", action: "press", done: "clicked" },
    ] }] }, choose(value) { host.pref = value; } };
  const guide = mountGuide(host);
  const byClass = (name) => body.querySelector(`.${name}`);
  const button = (text) => body.querySelectorAll("button").find((node) => node.textContent === text);
  return { doc, guide, host, goal, root, body, button, byClass, clicks: () => clicks,
    dispatchCaptured(target, type, details = {}) {
      let stopped = false;
      const event = { target, type, preventDefault() {}, stopImmediatePropagation() { stopped = true; }, ...details };
      for (const handler of captureListeners.get(type) ?? []) {
        handler(event);
        if (stopped) break;
      }
      if (!stopped) target.fire(type, event);
      return stopped;
    },
    refresh() { guide.refresh(); while (frames.length) frames.shift()(); } };
}

test("help opens with the walkthrough off, points without activating, and Escape dismisses/reopens", (t) => {
  const h = dockHarness(t);
  h.refresh();
  assert.equal(h.byClass("rm-guide-chip").hidden, false);
  h.guide.openHelp();
  assert.equal(h.host.pref, "off");
  assert.equal(h.byClass("rm-guide__title").textContent, "Allow ChatGPT plan use");
  assert.equal(h.byClass("rm-guide-pointer").hidden, false);
  h.button("Show me").fire("click");
  assert.equal(h.doc.activeElement, h.goal);
  assert.equal(h.clicks(), 0, "help does not click the permission control");
  h.byClass("rm-guide").focus();
  h.byClass("rm-guide").fire("keydown", { key: "Escape" });
  assert.equal(h.byClass("rm-guide").hidden, true);
  assert.equal(h.byClass("rm-guide-pointer").hidden, true);
  h.byClass("rm-guide-chip").fire("click");
  assert.equal(h.byClass("rm-guide").hidden, false);
});

for (const file of ["app.js", "local.js", "assistant.js"]) {
  test(`busy Help Escape capture regression (${file})`, async (t) => {
    const source = (await readFile(new URL(`../src/ui/${file}`, import.meta.url), "utf8")).replace(/\r\n/gu, "\n");
    const functionSource = (name) => {
      const start = source.indexOf(`function ${name}(`);
      const end = source.indexOf("\n}\n", start);
      assert.ok(start >= 0 && end > start, `missing ${name} in ${file}`);
      return source.slice(start, end + 2);
    };
    const constants = ["OPERATION_BLOCKED_EVENTS", "OPERATION_ALLOWED_SELECTOR"].map((name) => {
      const start = source.indexOf(`const ${name} =`);
      return start < 0 ? "" : source.slice(start, source.indexOf(";", start) + 1);
    }).join("\n");
    const registration = /document\.addEventListener\(eventName, blockOperationInteraction, true\);/u.exec(source);
    assert.ok(registration, `the real route capture registration is required in ${file}`);
    const h = dockHarness(t);
    const state = { operationBusy: true, operationAllowedSelector: null };
    vm.runInNewContext(`${constants}\n${functionSource("isOperationAllowedControl")}\n${functionSource("blockOperationInteraction")}
      for (const eventName of OPERATION_BLOCKED_EVENTS) { ${registration[0]} }`, { state, document: h.doc });
    h.refresh();
    const chip = h.byClass("rm-guide-chip");
    chip.focus();
    h.body.dataset.operationBusy = "true";
    h.goal.disabled = true;
    h.guide.openHelp();
    const dock = h.byClass("rm-guide");
    assert.equal(h.doc.activeElement, dock, "opening Help focuses the aside, not a button");
    assert.equal(h.dispatchCaptured(dock, "keydown", { key: "Escape" }), false, "capture must let Escape reach the dock");
    assert.equal(dock.hidden, true, "the actual dock Escape handler dismisses Help");
    assert.equal(h.doc.activeElement, chip, "focus returns to the Help trigger");
    assert.equal(h.byClass("rm-guide-pointer").hidden, true);
    assert.equal(h.host.pref, "off");
    assert.equal(h.goal.disabled, true);
    assert.equal(state.operationBusy, true, "dismissal must not stop or unlock the operation");
    assert.equal(h.dispatchCaptured(h.goal, "keydown", { key: "Escape" }), true, "protected controls stay locked");
    assert.equal(h.dispatchCaptured(h.goal, "click"), true);
    assert.equal(h.clicks(), 0);
    assert.equal(h.dispatchCaptured(dock, "keydown", { key: "Enter" }), true, "only Escape gets the new exemption");
    assert.equal(h.dispatchCaptured(dock, "click"), true);
    h.guide.openHelp();
    assert.equal(dock.hidden, false, "Help can reopen while the operation stays busy");
  });
}

test("missing targets hide Show me, explain the gap and never point at another control", (t) => {
  const h = dockHarness(t, { missing: true });
  h.guide.openHelp();
  assert.equal(h.button("Show me").hidden, true);
  assert.match(h.byClass("rm-guide__body").children.find((node) => node.getAttribute("role") === "status").textContent, /not visible/u);
  assert.equal(h.byClass("rm-guide-pointer").hidden, true);
  assert.equal(h.clicks(), 0);
});

test("the welcome card and Help never cover the controls of a region the page keeps clear", (t) => {
  const h = dockHarness(t, { pref: null });
  // The selected connection's action, low on a 390 x 844 window, where the dock's sheet would sit.
  const kept = h.doc.createElement("section");
  kept.setAttribute("data-guide-keep", "");
  const action = h.doc.createElement("button");
  action.rect = box(16, 600, 200, 40);
  kept.append(action);
  h.body.append(kept);
  const dock = h.byClass("rm-guide");
  const spot = () => {
    const [left, top] = /translate\((-?\d+)px, (-?\d+)px\)/u.exec(dock.style.transform).slice(1).map(Number);
    return box(left, top, Number.parseFloat(dock.style.width), 280);
  };
  h.refresh();
  assert.equal(dock.hidden, false, "the welcome card has room under the top bar");
  assert.equal(overlaps(spot(), action.rect), false, "the welcome card keeps the action clear");
  h.guide.openHelp();
  assert.equal(dock.hidden, false);
  assert.equal(overlaps(spot(), action.rect), false, "Help keeps it clear too");
});

test("help retains disabled controls and a static reduced-motion path on narrow and wide views", (t) => {
  const h = dockHarness(t, { width: 1280, reduced: true });
  h.goal.disabled = true;
  h.body.dataset.operationBusy = "true";
  h.guide.openHelp();
  assert.equal(h.byClass("rm-guide__title").textContent, "Wait for the current operation");
  assert.equal(h.goal.disabled, true);
  h.body.dataset.operationBusy = "false";
  h.refresh();
  h.button("Show me").fire("click");
  assert.equal(h.goal.disabled, true);
  assert.equal(h.clicks(), 0);
  assert.notEqual(h.doc.activeElement, h.goal, "disabled consent does not receive activation or focus");
});

test("unknown metadata shown in the actual dock never suggests granting permission", (t) => {
  const h = dockHarness(t);
  h.host.content.metadata = { ...HELP_METADATA, schema: 2 };
  h.guide.openHelp();
  assert.equal(h.byClass("rm-guide__title").textContent, UNKNOWN_HELP.title);
  assert.equal(h.button("Show me").hidden, true);
});

test("topics expose current feature tips and FAQ, then return to the active guide", (t) => {
  const h = dockHarness(t, { pref: "on" });
  h.guide.openHelp();
  const topic = h.byClass("rm-guide__topics").querySelector("select");
  assert.ok(topic.children.some((option) => option.value === "tip:grant"));
  topic.value = "faq:identity"; topic.fire("change");
  assert.equal(h.byClass("rm-guide__title").textContent, "Is sign-in enough?");
  assert.equal(h.button("Show me").hidden, true);
  topic.value = "tip:grant"; topic.fire("change");
  assert.equal(h.byClass("rm-guide__say").textContent, "Review the separate permission.");
  topic.value = ""; topic.fire("change");
  assert.match(h.byClass("rm-guide__say").textContent, /permission has not been granted/u);
  h.button("Return to guide").fire("click");
  assert.equal(h.byClass("rm-guide__topics").hidden, true);
  assert.equal(h.host.pref, "on");
});

test("route-wide activation guards leave help usable and block protected controls", async () => {
  for (const file of ["supergrok-vps.js", "local-model-vps.js"]) {
    const source = await readFile(new URL(`../src/ui/${file}`, import.meta.url), "utf8");
    const start = source.indexOf('for (const name of ["click", "pointerdown", "keydown", "beforeinput", "input", "change", "submit"])');
    const end = source.indexOf("async function perform(", start);
    const handlers = [];
    vm.runInNewContext(source.slice(start, end), { state: { busy: true }, document: { addEventListener(_type, handler) { handlers.push(handler); } } });
    for (const handler of handlers) {
      for (const help of [true, false]) {
        let blocked = 0;
        handler({ target: { closest: () => help ? {} : null }, preventDefault() { blocked++; }, stopImmediatePropagation() {} });
        assert.equal(blocked, help ? 0 : 1, file);
      }
    }
  }
});

test("local-model operation locks exclude help and preserve preexisting disabled confirmation", async () => {
  const source = await readFile(new URL("../src/ui/local-model-vps.js", import.meta.url), "utf8");
  const start = source.indexOf("async function perform(");
  const end = source.indexOf("function setOptions(", start);
  const node = (help, disabled) => ({ disabled, attrs: new Map(),
    closest: () => help ? {} : null, getAttribute(name) { return this.attrs.get(name) ?? null; },
    setAttribute(name, value) { this.attrs.set(name, value); }, removeAttribute(name) { this.attrs.delete(name); } });
  const help = node(true, false); const apply = node(false, true); const trust = node(false, false);
  const body = { dataset: {} };
  const perform = vm.runInNewContext(`${source.slice(start, end)}; perform`, {
    state: { busy: false }, document: { body, querySelectorAll: () => [help, apply, trust] },
    el: () => ({ hidden: true, scrollIntoView() {}, setAttribute() {} }), message() {},
    error: (message) => assert.fail(message), syncTrust() {}, syncConfirm() {},
  });
  await perform("Fixture operation", async () => {
    assert.equal(help.disabled, false); assert.equal(apply.disabled, true); assert.equal(trust.disabled, true);
    assert.equal(body.dataset.operationBusy, "true");
  });
  assert.equal(help.disabled, false); assert.equal(apply.disabled, true); assert.equal(trust.disabled, false);
  assert.equal(body.dataset.operationBusy, "false");
});

test("operation guards exempt help controls while retaining the lock on consent and install controls", async () => {
  for (const file of ["app.js", "local.js", "assistant.js"]) {
    const source = await readFile(new URL(`../src/ui/${file}`, import.meta.url), "utf8");
    const start = source.indexOf("function isOperationAllowedControl(");
    const end = source.indexOf("function lockAddedOperationControls(", start);
    const state = { operationAllowedSelector: null, operationControlStates: [] };
    const lock = vm.runInNewContext(`${source.slice(start, end)}; lockOperationControl`, {
      state, OPERATION_ALLOWED_SELECTOR: "[data-operation-allow]",
      readOperationAttribute: (control, name) => control.attrs.get(name) ?? null,
    });
    const node = (help, disabled = false) => ({ disabled, attrs: new Map(),
      closest: (selector) => help && selector.includes(".rm-guide-layer") ? {} : null,
      setAttribute(name, value) { this.attrs.set(name, value); }, getAttribute(name) { return this.attrs.get(name) ?? null; } });
    const help = node(true); const install = node(false); const consent = node(false, true);
    lock(help); lock(install); lock(consent);
    assert.equal(help.disabled, false, file);
    assert.equal(install.disabled, true, file); assert.equal(consent.disabled, true, file);
    assert.equal(state.operationControlStates.length, 2, file);
  }
});

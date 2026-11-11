import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";
import { mountGuide } from "../src/ui/guide-dock.js";
import { box, overlaps } from "../src/ui/guide.js";
import { contextualHelp, HELP_FAQ, HELP_METADATA, HELP_TERMS, helpState, UNKNOWN_HELP, validHelpMetadata } from "../src/ui/guide/context.js";

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
  // A revision newer than this build knows, none at all, or a review of another commit or version.
  for (const value of [null, {}, { ...HELP_METADATA, schema: 2 }, { ...HELP_METADATA, revision: HELP_METADATA.revision + 1 },
    { ...HELP_METADATA, revision: 0 }, { ...HELP_METADATA, sourceCommit: "9c7f82d854f229b9416354cc9a3eefb87aa93c5d" },
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
  for (const page of ["vps", "local", "assistant", "hosting", "supergrok-vps", "claude-vps", "local-model-vps"]) {
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
  for (const item of [UNKNOWN_HELP, ...HELP_FAQ, ...HELP_TERMS]) {
    assert.doesNotMatch(`${item.title} ${item.say}`, /[!\u2013\u2014]|\p{Extended_Pictographic}/u);
  }
  for (const item of HELP_TERMS) {
    assert.match(item.id, /^[a-z-]+$/u);
    assert.ok(item.title.endsWith("?") && item.say.trim() && item.target === null, item.id);
  }
  assert.equal(new Set(HELP_TERMS.map((item) => item.id)).size, HELP_TERMS.length);
});

// A stand-in for the tab's sessionStorage, so no test shares guide progress.
function tabStorage(entries = {}) {
  const data = new Map(Object.entries(entries));
  return { data, getItem: (key) => data.get(key) ?? null, setItem: (key, value) => { data.set(key, String(value)); } };
}

// A small DOM fixture runs the actual dock handlers. It does not start a
// browser, HTTP server, OAuth flow, SSH connection or installation.
// skipLink adds the page's own skip link; storage is the tab's sessionStorage.
// walk adds text nodes, ranges and a tree walker, so the pointer's action
// label can measure the lines of text beside its target.
function dockHarness(t, { width = 390, reduced = true, pref = "off", missing = false, skipLink = false, storage = tabStorage(), walk = false } = {}) {
  const original = new Map(["document", "matchMedia", "innerHeight", "getComputedStyle", "ResizeObserver",
    "MutationObserver", "requestAnimationFrame", "addEventListener", "scrollBy", "NodeFilter"].map((key) => [key, globalThis[key]]));
  const storageBefore = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: storage });
  t.after(() => {
    for (const [key, value] of original) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; }
    if (storageBefore) Object.defineProperty(globalThis, "sessionStorage", storageBefore); else delete globalThis.sessionStorage;
  });
  let doc;
  const selectorMatches = (node, selector) => selector.split(",").some((item) => {
    const part = item.trim();
    if (part.startsWith("#")) return node.id === part.slice(1);
    if (/^\.[\w-]+$/u.test(part)) return node.className.split(/\s/u).includes(part.slice(1));
    const attr = /^\[([\w-]+)(?:=['"]?([\w-]+)['"]?)?\]$/u.exec(part);
    if (attr) return node.getAttribute(attr[1]) !== null && (attr[2] === undefined || node.getAttribute(attr[1]) === attr[2]);
    return /^[a-z][a-z0-9]*$/u.test(part) && node.tag === part;
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
    after(node) { const list = this.parentElement.children; list.splice(list.indexOf(this) + 1, 0, node); node.parentElement = node.parentNode = this.parentElement; }
    contains(node) { return node === this || this.children.some((child) => child.contains(node)); }
    matches(selector) { return selectorMatches(this, selector); }
    querySelectorAll(selector) { return this.children.flatMap((child) => [...(child.matches(selector) ? [child] : []), ...child.querySelectorAll(selector)]); }
    querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
    closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) ?? null; }
    setAttribute(key, value) { this.attributes.set(key, String(value)); if (key === "class") this.className = value; }
    getAttribute(key) { return this.attributes.get(key) ?? null; }
    hasAttribute(key) { return this.attributes.has(key); }
    removeAttribute(key) { this.attributes.delete(key); }
    addEventListener(type, handler) { const list = this.listeners.get(type) ?? []; list.push(handler); this.listeners.set(type, list); }
    fire(type, event = {}) { for (const handler of this.listeners.get(type) ?? []) handler({ target: this, preventDefault() {}, ...event }); }
    // A display: contents wrapper has no box, so the browser reports it as not visible; its children still are.
    // Nothing under a hidden or display: none node is.
    rendered() { return !this.hidden && this.display !== "none" && (!this.parentElement || this.parentElement.rendered()); }
    checkVisibility() { return this.display !== "contents" && this.rendered(); }
    getClientRects() { return this.checkVisibility() ? [this.rect] : []; }
    // A line of text inside this element, at the given box.
    text(value, rect) { const text = { nodeType: 3, nodeValue: value, parentElement: this, rects: [rect] }; (this.texts ??= []).push(text); return text; }
    getBoundingClientRect() { return this.rect; }
    get offsetWidth() { return this.className.includes("rm-guide") ? 280 : 32; }
    get offsetHeight() { return this.className === "rm-guide" ? 280 : 32; }
    get offsetTop() { return 0; }
    get isConnected() { return doc.body.contains(this); }
    focus() { doc.activeElement = this; }
    scrollIntoView() { this.scrolled = true; }
  }
  const body = new Node("body"); body.rect = { left: 0, top: 0, width, height: 844, right: width, bottom: 844 };
  if (skipLink) body.append(Object.assign(new Node("a"), { className: "rm-skip-link", textContent: "Skip to setup" }));
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
  // A tree walker with the browser's filter rules: reject prunes a branch, skip passes through to its children.
  const createTreeWalker = (start, _show, accept) => {
    const queue = [];
    const visit = (node) => {
      for (const text of node.texts ?? []) if (accept(text) === 1) queue.push(text);
      for (const child of node.children) {
        const verdict = accept(child);
        if (verdict === 2) continue;
        if (verdict === 1) queue.push(child);
        visit(child);
      }
    };
    visit(start);
    return { currentNode: start, nextNode() { this.currentNode = queue.shift() ?? null; return this.currentNode; } };
  };
  doc = { body, activeElement: body, documentElement: { clientWidth: width },
    createElement: (tag) => new Node(tag), createElementNS: (_ns, tag) => new Node(tag),
    querySelectorAll: (selector) => body.querySelectorAll(selector), querySelector: (selector) => body.querySelector(selector),
    ...(walk ? { createTreeWalker, createRange: () => ({ selectNodeContents(node) { this.node = node; }, getClientRects() { return this.node.rects ?? []; } }) } : {}),
    addEventListener(type, handler, capture) {
      if (capture !== true) return;
      const list = captureListeners.get(type) ?? [];
      list.push(handler); captureListeners.set(type, list);
    } };
  Object.assign(globalThis, { document: doc, innerHeight: 844,
    NodeFilter: { SHOW_ELEMENT: 1, SHOW_TEXT: 4, FILTER_ACCEPT: 1, FILTER_REJECT: 2, FILTER_SKIP: 3 },
    matchMedia: (query) => ({ matches: query.includes("reduced-motion") ? reduced : width >= 1024 }),
    getComputedStyle: (node) => ({ overflowX: "visible", overflowY: "visible", display: node?.display ?? "block" }),
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
  return { doc, guide, host, goal, root, body, panel, button, byClass, clicks: () => clicks,
    node(tag, props = {}) { const node = Object.assign(new Node(tag), props); body.append(node); return node; },
    title: () => byClass("rm-guide__title").textContent,
    chipText: () => byClass("rm-guide-chip").children[1].textContent,
    // The one status region outside the dock that announces tips.
    status: () => body.querySelectorAll("[role=status]").find((node) => node.className === "rm-visually-hidden").textContent,
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
  assert.match(h.byClass("rm-guide__availability").textContent, /not visible/u);
  assert.match(h.status(), /not visible/u);
  assert.equal(h.byClass("rm-guide-layer").querySelectorAll("[role=status]").length, 1, "one polite guide status even for a missing target");
  assert.equal(h.byClass("rm-guide-pointer").hidden, true);
  assert.equal(h.clicks(), 0);
});

test("the action label avoids text in a display: contents wrapper and ignores a display: none branch", (t) => {
  const h = dockHarness(t, { width: 800, walk: true });
  // Mid-window, so the 280 px label fits on either side of the button, below or above it.
  h.goal.rect = box(300, 400, 200, 40);
  // A hint under the button, in a form with display: contents, as on step 1.
  const form = h.node("form", { display: "contents" });
  const hint = Object.assign(h.doc.createElement("p"), { rect: box(300, 444, 400, 20) });
  hint.text("Use the address your host gave you.", hint.rect);
  form.append(hint);
  // Text where the label goes above the button, in a wrapper inside a display: none branch.
  const gone = h.node("div", { display: "none" });
  const wrapper = Object.assign(h.doc.createElement("div"), { display: "contents" });
  wrapper.text("A hint from another step.", box(300, 380, 400, 20));
  gone.append(wrapper);
  const cursor = h.byClass("rm-guide-pointer__cursor");
  h.guide.openHelp();
  assert.equal(h.byClass("rm-guide-pointer").hidden, false);
  assert.doesNotMatch(cursor.className, /is-bare/u, "text in the hidden branch never crowds the label out");
  assert.match(cursor.className, /is-raised/u, "the hint under the button sends the label above it");
  // With the form hidden its hint no longer counts: the label goes back under the button.
  form.hidden = true;
  h.refresh();
  assert.doesNotMatch(cursor.className, /is-raised|is-bare/u);
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

test("topics expose current feature tips, FAQ and word topics, then return to the active guide", (t) => {
  const h = dockHarness(t, { pref: "on" });
  h.guide.openHelp();
  const topic = h.byClass("rm-guide__topics").querySelector("select");
  const values = topic.querySelectorAll("option").map((option) => option.value);
  assert.equal(values[0], "", "Current step comes first");
  assert.ok(values.includes("tip:grant"));
  assert.deepEqual(topic.querySelectorAll("optgroup").map((group) => group.label), ["This step", "Questions", "Words"]);
  for (const item of HELP_TERMS) assert.ok(values.includes(`term:${item.id}`), item.id);
  topic.value = "faq:identity"; topic.fire("change");
  assert.equal(h.byClass("rm-guide__title").textContent, "Is sign-in enough?");
  assert.equal(h.button("Show me").hidden, true);
  topic.value = "term:fingerprint"; topic.fire("change");
  assert.equal(h.title(), "What is a fingerprint?");
  assert.equal(h.button("Show me").hidden, true, "a word topic points at nothing");
  topic.value = "tip:grant"; topic.fire("change");
  assert.equal(h.byClass("rm-guide__say").textContent, "Review the separate permission.");
  topic.value = ""; topic.fire("change");
  assert.match(h.byClass("rm-guide__say").textContent, /permission has not been granted/u);
  assert.equal(h.byClass("rm-guide").getAttribute("aria-label"), "Help");
  h.button("Return to guide").fire("click");
  assert.equal(h.byClass("rm-guide__topics").hidden, true);
  assert.equal(h.byClass("rm-guide").getAttribute("aria-label"), "Setup guide");
  assert.equal(h.host.pref, "on");
});

// Where the dock sits in the fixture window.
function dockSpot(dock) {
  const [left, top] = /translate\((-?\d+)px, (-?\d+)px\)/u.exec(dock.style.transform).slice(1).map(Number);
  return box(left, top, Number.parseFloat(dock.style.width), 280);
}

const note = { id: "note", target: "#note", title: "Read the note", say: "It explains the plan.", action: "read", done: "manual" };

test("a folded walkthrough keeps its tip on the chip, announces it and reopens that tip", (t) => {
  const h = dockHarness(t, { pref: "on" });
  // A kept action where the sheet would sit: no spot is clear of it and of the tip's target.
  const kept = h.node("section");
  kept.setAttribute("data-guide-keep", "");
  const action = h.doc.createElement("button");
  action.rect = box(16, 600, 200, 40);
  kept.append(action);
  h.refresh();
  const dock = h.byClass("rm-guide");
  const chip = h.byClass("rm-guide-chip");
  assert.equal(dock.hidden, true, "it folds instead of covering the kept action or its own target");
  assert.equal(chip.hidden, false);
  assert.equal(h.chipText(), "Allow ChatGPT plan use", "the chip carries the tip's title");
  assert.equal(chip.getAttribute("aria-label"), "Setup guide: Allow ChatGPT plan use");
  assert.equal(h.status(), "Allow ChatGPT plan use. Review the separate permission.", "the tip is announced while only the chip shows");
  chip.fire("click");
  assert.equal(dock.hidden, false, "one press opens that tip");
  assert.equal(h.title(), "Allow ChatGPT plan use");
  assert.equal(h.button("Next tip").hidden, false);
  assert.equal(h.byClass("rm-guide__topics").hidden, true, "the walkthrough, not Help");
  assert.equal(overlaps(dockSpot(dock), action.rect), false, "opened, it still keeps the kept action clear");
  // It fades in where it arrives and stays put while nothing moves.
  const arrived = dock.dataset.arrive;
  assert.ok(arrived);
  h.refresh();
  assert.equal(dock.dataset.arrive, arrived);

  // Hide folds it too, and the chip still leads back to the tip.
  h.body.querySelectorAll("button").find((node) => node.getAttribute("aria-label") === "Hide guide").fire("click");
  assert.equal(dock.hidden, true);
  assert.equal(h.chipText(), "Allow ChatGPT plan use");
  chip.fire("click");
  assert.equal(dock.hidden, false);
  assert.equal(h.byClass("rm-guide__topics").hidden, true);

  // With the walkthrough off the chip is Help again.
  h.host.pref = "off";
  h.refresh();
  assert.equal(h.chipText(), "Help");
  assert.equal(chip.getAttribute("aria-label"), "Open help for this view");
  chip.fire("click");
  assert.equal(h.byClass("rm-guide__topics").hidden, false);
});

test("the folded chip keeps the page's own buttons and headings clear", (t) => {
  const h = dockHarness(t, { pref: "on" });
  // The kept action folds the dock, as above. A heading fills the window's
  // foot, where the chip usually sits, and a button stands above its right end.
  const kept = h.node("section");
  kept.setAttribute("data-guide-keep", "");
  kept.append(Object.assign(h.doc.createElement("button"), { rect: box(16, 600, 200, 40) }));
  const heading = h.node("h2", { rect: box(16, 790, 358, 40) });
  const back = h.node("button", { rect: box(200, 740, 180, 40) });
  h.refresh();
  const chip = h.byClass("rm-guide-chip");
  assert.equal(chip.hidden, false);
  const [left, top] = /translate\((-?\d+)px, (-?\d+)px\)/u.exec(chip.style.transform).slice(1).map(Number);
  const spot = box(left, top, chip.offsetWidth, chip.offsetHeight);
  assert.equal(overlaps(spot, heading.rect) || overlaps(spot, back.rect), false, "neither the heading nor the button is under it");
  assert.ok(spot.top >= 8 && spot.bottom <= 844 && spot.left >= 0 && spot.right <= 390, "inside the window");
});

test("Hide keeps focus-follow announcements on the folded chip", (t) => {
  const h = dockHarness(t, { pref: "on" });
  const text = h.node("p", { id: "note" });
  h.host.content.chapters[0].tips.push(note);
  h.refresh();
  h.body.querySelectorAll("button").find((node) => node.getAttribute("aria-label") === "Hide guide").fire("click");
  text.focus();
  h.dispatchCaptured(text, "focusin");
  h.refresh();
  assert.equal(h.byClass("rm-guide").hidden, true);
  assert.equal(h.chipText(), "Read the note");
  assert.equal(h.status(), "Read the note");
  assert.equal(h.byClass("rm-guide-layer").querySelectorAll("[role=status]").length, 1);
});

test("a press counts only when its operation ends without a new failure", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = dockHarness(t, { pref: "on" });
  h.refresh();
  assert.equal(h.title(), "Allow ChatGPT plan use");
  h.dispatchCaptured(h.goal, "click");
  h.body.dataset.operationBusy = "true";
  h.refresh();
  assert.equal(h.title(), "Allow ChatGPT plan use", "the press waits while the page is busy");
  h.host.failure = { info: {}, surfaces: [], entry: null };
  h.body.dataset.operationBusy = "false";
  h.refresh();
  assert.equal(h.title(), "Allow ChatGPT plan use", "a press that ended in a failure does not complete the tip");
  h.refresh();
  assert.equal(h.title(), "Allow ChatGPT plan use", "and it is not counted later");
  // The same failure, still showing, does not block the next press.
  h.dispatchCaptured(h.goal, "click");
  h.refresh();
  assert.equal(h.title(), "Setup complete");
});

test("a failure reported and cleared between frames still rejects a pending press", (t) => {
  const h = dockHarness(t, { pref: "on" });
  h.refresh();
  h.dispatchCaptured(h.goal, "click");
  h.host.failureCount = 1;
  h.host.failure = null;
  h.refresh();
  assert.equal(h.title(), "Allow ChatGPT plan use");
});

test("losing a confirmed sign-in resumes its outcome tip", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = dockHarness(t, { pref: "on" });
  const state = h.node("p", { id: "auth-ready" });
  h.host.content.chapters[0].tips[0].done = "visible:#auth-ready";
  h.refresh();
  assert.equal(h.title(), "Setup complete");
  state.hidden = true;
  h.refresh();
  assert.equal(h.title(), "Allow ChatGPT plan use", "a prior finish cannot override the page's current outcome");
});

test("a fresh key shown after an earlier key needs its own copy", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = dockHarness(t, { pref: "on" });
  h.goal.setAttribute("data-guide-state", "fresh");
  h.host.content.chapters[0].tips[0].target = "[data-guide-state=fresh]";
  h.refresh();
  h.dispatchCaptured(h.goal, "click");
  h.refresh();
  assert.equal(h.title(), "Setup complete");
  h.goal.setAttribute("data-guide-state", "none");
  h.refresh();
  h.goal.setAttribute("data-guide-state", "fresh");
  h.refresh();
  assert.equal(h.title(), "Allow ChatGPT plan use", "copying an earlier key cannot complete this key's tip");
});

test("a copy press counts only once the page marks a successful copy", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = dockHarness(t, { pref: "on" });
  // The tip's control is a copy button: it holds the kit's copy icon.
  h.goal.append(Object.assign(h.doc.createElement("span"), { className: "rm-icon rm-icon--copy" }));
  // A second copy button, one that names its copy target, as on the local page.
  const key = h.node("button", { id: "key-copy" });
  key.setAttribute("data-copy-target", "key");
  h.host.content.chapters[0].tips.push({ id: "key", target: "#key-copy", title: "Save the key now", say: "Copy it now.", action: "press", done: "clicked" });
  h.refresh();
  h.dispatchCaptured(h.goal, "click");
  h.refresh();
  assert.equal(h.title(), "Allow ChatGPT plan use", "the page is idle while the browser still asks for clipboard access");
  h.host.failureCount = 1;
  h.refresh();
  assert.equal(h.title(), "Allow ChatGPT plan use", "a refused copy leaves the tip open");
  h.dispatchCaptured(h.goal, "click");
  h.goal.setAttribute("data-copied", "");
  h.refresh();
  assert.equal(h.title(), "Save the key now");
  h.dispatchCaptured(key, "click");
  h.refresh();
  assert.equal(h.title(), "Save the key now");
  key.setAttribute("data-copied", "");
  h.refresh();
  assert.equal(h.title(), "Setup complete");
});

test("a filled field counts once the browser accepts its value", (t) => {
  const h = dockHarness(t, { pref: "on" });
  const port = h.node("input", { id: "port", value: "99999", validity: { valid: false },
    checkValidity() { assert.fail("an invalid native field must not fire the page's invalid handler"); } });
  h.host.content.chapters[0].tips.unshift({ id: "port", target: "#port", title: "Check the port", say: "Keep 22.", action: "type", done: "filled" });
  h.refresh();
  assert.equal(h.title(), "Check the port", "a value the browser rejects does not complete the tip");
  Object.assign(port, { value: "22", validity: { valid: true }, checkValidity: () => false });
  h.refresh();
  assert.equal(h.title(), "Check the port", "checkValidity must accept a filled field too");
  port.checkValidity = () => true;
  h.refresh();
  assert.equal(h.title(), "Allow ChatGPT plan use");
});

test("the dock follows the control that has focus and announces only its title", (t) => {
  const h = dockHarness(t, { pref: "on" });
  const text = h.node("p", { id: "note" });
  const other = h.node("input", { id: "other" });
  h.host.content.chapters[0].tips.push(note);
  h.refresh();
  assert.equal(h.title(), "Allow ChatGPT plan use");
  text.focus();
  h.dispatchCaptured(text, "focusin");
  h.refresh();
  assert.equal(h.title(), "Read the note");
  assert.equal(h.status(), "Read the note", "a change that follows focus announces the title only");
  other.focus();
  h.dispatchCaptured(other, "focusin");
  h.refresh();
  assert.equal(h.title(), "Allow ChatGPT plan use", "a control without a tip returns to the next undone tip");

  // The tip of the control in use stays while it keeps focus, even once it is done.
  h.goal.focus();
  h.dispatchCaptured(h.goal, "focusin");
  h.dispatchCaptured(h.goal, "click");
  h.refresh();
  assert.equal(h.title(), "Allow ChatGPT plan use");
  h.dispatchCaptured(h.goal, "focusout", { relatedTarget: null });
  h.refresh();
  assert.equal(h.title(), "Read the note");

  // In Help, focus picks that control's topic.
  h.guide.openHelp();
  h.dispatchCaptured(h.goal, "focusin");
  h.refresh();
  assert.equal(h.byClass("rm-guide__topics").querySelector("select").value, "tip:grant");
  assert.equal(h.title(), "Allow ChatGPT plan use");
  assert.equal(h.status(), "Allow ChatGPT plan use", "focus-driven Help changes announce only the title");
  h.dispatchCaptured(other, "focusin");
  h.refresh();
  assert.equal(h.byClass("rm-guide__topics").querySelector("select").value, "", "leaving a field restores Current step");
});

test("a second skip link reaches the guide, which comes last in the page", (t) => {
  const h = dockHarness(t, { skipLink: true });
  h.refresh();
  const links = h.body.querySelectorAll(".rm-skip-link");
  assert.deepEqual(links.map((link) => link.textContent), ["Skip to setup", "Skip to help"]);
  assert.equal(h.body.children.indexOf(links[1]), h.body.children.indexOf(links[0]) + 1, "right after the page's own skip link");
  links[1].fire("click");
  assert.equal(h.doc.activeElement, h.byClass("rm-guide-chip"), "with the walkthrough off it lands on the Help chip");
  h.host.pref = "on";
  h.refresh();
  assert.equal(links[1].textContent, "Skip to setup guide");
  links[1].fire("click");
  assert.equal(h.doc.activeElement, h.byClass("rm-guide"));
});

test("a reading tip passed with Next tip is kept for the tab", (t) => {
  const storage = tabStorage();
  const h = dockHarness(t, { pref: "on", storage });
  h.node("p", { id: "note" });
  h.host.content.chapters[0].tips.unshift(note);
  h.refresh();
  assert.equal(h.title(), "Read the note");
  h.button("Next tip").fire("click");
  assert.equal(h.title(), "Allow ChatGPT plan use");
  assert.deepEqual(JSON.parse(storage.getItem("relmio-guide-progress:vps")), { read: ["test/note"], badges: [] });
});

test("after a reload the tab's read tips and badges come back; unknown ids are ignored", (t) => {
  const storage = tabStorage({ "relmio-guide-progress:vps": JSON.stringify({
    read: ["test/note", "test/grant", "gone/tip", 7], badges: ["test", "gone"], extra: true }) });
  const h = dockHarness(t, { pref: "on", storage });
  h.node("p", { id: "note" });
  h.host.content.chapters[0].tips.unshift(note);
  h.host.content.chapters[0].badge = "Checked";
  h.refresh();
  assert.equal(h.title(), "Allow ChatGPT plan use", "the reading tip is not shown again, and a press is never restored");
  assert.equal(h.byClass("rm-guide__dots").children[0].getAttribute("data-state"), "done");
  assert.equal(h.byClass("rm-guide__dots").children[0].className, "", "a badge from before the reload does not animate");
  assert.ok(h.byClass("rm-guide__progress").children.some((node) => node.textContent === "Checked"));
});

test("damaged tab progress reads as none", (t) => {
  const h = dockHarness(t, { pref: "on", storage: tabStorage({ "relmio-guide-progress:vps": "{not json" }) });
  h.node("p", { id: "note" });
  h.host.content.chapters[0].tips.unshift(note);
  h.refresh();
  assert.equal(h.title(), "Read the note");
});

test("error help never covers the field the page marked", (t) => {
  const h = dockHarness(t, { pref: "on" });
  const field = h.node("input", { id: "container" });
  field.setAttribute("aria-invalid", "true");
  field.rect = box(16, 600, 300, 40);
  // The quest track sits where the sheet's other spot is.
  h.node("ol", { className: "rm-stepper--track" }).rect = box(16, 20, 300, 40);
  h.host.failure = { info: { status: 400, marked: true }, surfaces: [], entry: {
    title: "Request not accepted", say: "Something in this request was not accepted.", steps: ["Check the marked box."] } };
  h.refresh();
  const dock = h.byClass("rm-guide");
  assert.equal(h.byClass("rm-guide__eyebrow").textContent, "Error help");
  assert.equal(dock.getAttribute("aria-label"), "Error help");
  assert.equal(h.status(), "Request not accepted. Something in this request was not accepted. Check the marked box.");
  assert.equal(dock.hidden, true, "unopened, it folds: the sheet would cover the field or the page title");
  assert.equal(h.chipText(), "Need help with this error?");
  // Opened, it gives up the title, never the marked field.
  dock.focus();
  h.refresh();
  assert.equal(dock.hidden, false);
  assert.equal(overlaps(dockSpot(dock), field.rect), false);
});

test("an install that reaches the last chapter earns its badge and one hop once the page is idle", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = dockHarness(t, { pref: "on" });
  const ready = h.node("section", { id: "ready", hidden: true });
  ready.append(Object.assign(h.doc.createElement("button"), { id: "copy" }));
  h.host.content.chapters = [
    { id: "review", label: "Review the plan", panel: "#panel", badge: "Plan approved", tips: [
      { id: "apply", target: "[data-siwc=grant]", title: "Confirm the action", say: "Press it.", action: "press", done: "clicked", installs: true }] },
    { id: "ready", label: "Copy your settings", panel: "#ready", badge: "Connected", tips: [
      { id: "copy", target: "#copy", title: "Copy your key", say: "Copy it now.", action: "press", done: "clicked" }] },
  ];
  h.refresh();
  const pose = () => h.byClass("rm-guide").querySelector(".rm-mascot").getAttribute("data-pose");
  const dots = () => h.byClass("rm-guide__dots").children;
  h.dispatchCaptured(h.goal, "click");
  h.body.dataset.operationBusy = "true";
  // The page shows its Ready step before the operation ends.
  h.panel.hidden = true;
  ready.hidden = false;
  h.refresh();
  assert.equal(h.title(), "Copy your key");
  assert.deepEqual(dots().map((dot) => dot.getAttribute("data-state")), ["todo", "current"], "no badge while the press waits for its result");
  assert.notEqual(pose(), "happy");
  h.body.dataset.operationBusy = "false";
  h.refresh();
  assert.deepEqual(dots().map((dot) => dot.getAttribute("data-state")), ["done", "current"], "the chapter left behind earns its badge once the page is idle");
  assert.equal(pose(), "happy", "one hop for the finished install");
  assert.equal(dots()[0].className, "is-new", "the new check is drawn once");
  dots()[0].fire("animationend");
  assert.equal(dots()[0].className, "");
});

test("a failed install earns no badge and no hop", (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const h = dockHarness(t, { pref: "on" });
  h.host.content.chapters[0].tips[0].installs = true;
  h.host.content.chapters[0].badge = "Installed";
  h.refresh();
  h.dispatchCaptured(h.goal, "click");
  h.body.dataset.operationBusy = "true";
  h.refresh();
  h.host.failure = { info: { status: 400 }, surfaces: [], entry: null };
  h.body.dataset.operationBusy = "false";
  h.refresh();
  assert.equal(h.title(), "Allow ChatGPT plan use");
  assert.equal(h.byClass("rm-guide__dots").children[0].getAttribute("data-state"), "current");
  assert.notEqual(h.byClass("rm-guide").querySelector(".rm-mascot").getAttribute("data-pose"), "happy");
});

test("route-wide activation guards leave help usable and block protected controls", async () => {
  for (const file of ["supergrok-vps.js", "claude-vps.js", "local-model-vps.js"]) {
    const source = await readFile(new URL(`../src/ui/${file}`, import.meta.url), "utf8");
    const start = source.indexOf('for (const name of ["click", "pointerdown", "keydown", "beforeinput", "input", "change", "submit"])');
    const end = source.indexOf("async function perform(", start);
    const handlers = [];
    vm.runInNewContext(source.slice(start, end), { state: { busy: true }, document: { addEventListener(_type, handler) { handlers.push(handler); } } });
    for (const handler of handlers) {
      for (const scope of [".rm-guide-layer", "[data-guide-help]", null]) {
        let blocked = 0;
        handler({ target: { closest: (selector) => scope && selector.includes(scope) ? {} : null }, preventDefault() { blocked++; }, stopImmediatePropagation() {} });
        assert.equal(blocked, scope ? 0 : 1, `${file}: ${scope ?? "protected control"}`);
      }
    }
  }
});

test("local-model operation locks exclude help and preserve preexisting disabled confirmation", async () => {
  const source = await readFile(new URL("../src/ui/local-model-vps.js", import.meta.url), "utf8");
  const start = source.indexOf("async function perform(");
  const end = source.indexOf("function setOptions(", start);
  const node = (scope, disabled) => ({ disabled, attrs: new Map(),
    closest: (selector) => scope && selector.includes(scope) ? {} : null, getAttribute(name) { return this.attrs.get(name) ?? null; },
    setAttribute(name, value) { this.attrs.set(name, value); }, removeAttribute(name) { this.attrs.delete(name); } });
  const help = node(".rm-guide-layer", false); const skip = node("[data-guide-help]");
  const apply = node(null, true); const trust = node(null, false);
  const body = { dataset: {} };
  const perform = vm.runInNewContext(`${source.slice(start, end)}; perform`, {
    state: { busy: false }, document: { body, querySelectorAll: () => [help, skip, apply, trust] },
    el: () => ({ hidden: true, scrollIntoView() {}, setAttribute() {} }), message() {},
    error: (message) => assert.fail(message), syncTrust() {}, syncConfirm() {},
  });
  await perform("Fixture operation", async () => {
    assert.equal(help.disabled, false); assert.equal(apply.disabled, true); assert.equal(trust.disabled, true);
    assert.equal(skip.attrs.size, 0, "the guide skip link stays in the tab order outside the guide layer");
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
    const node = (scope, disabled = false) => ({ disabled, attrs: new Map(),
      closest: (selector) => scope && selector.includes(scope) ? {} : null,
      setAttribute(name, value) { this.attrs.set(name, value); }, getAttribute(name) { return this.attrs.get(name) ?? null; } });
    const help = node(".rm-guide-layer"); const skip = node("[data-guide-help]");
    skip.disabled = undefined;
    const install = node(null); const consent = node(null, true);
    lock(help); lock(skip); lock(install); lock(consent);
    assert.equal(help.disabled, false, file);
    assert.equal(skip.attrs.size, 0, `${file}: guide skip link remains keyboard reachable`);
    assert.equal(install.disabled, true, file); assert.equal(consent.disabled, true, file);
    assert.equal(state.operationControlStates.length, 2, file);
  }
});

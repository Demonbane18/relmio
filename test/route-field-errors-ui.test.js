import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { clearFieldError, markRejectedField, setFieldError } from "../src/ui/ssh-form.js";

const pages = [
  ["assistant.js", "showError", "global-error-text"],
  ["supergrok-vps.js", "showError", "error-message"],
  ["local-model-vps.js", "error", "error"],
];

for (const [file, handler, errorId] of pages) {
  test(`${file} identifies rejected SSH fields without invalidating unrelated fields`, async () => {
    const script = await readFile(`src/ui/${file}`, "utf8");
    const start = script.indexOf(`function ${handler}(`);
    const end = script.indexOf("\n}", start) + 2;
    assert.ok(start >= 0 && end > start);
    const nodes = new Map();
    const element = (id) => {
      if (!nodes.has(id)) nodes.set(id, {
        attributes: new Map(), hidden: true, textContent: "", label: null,
        closest() { return this.label ? { querySelector: () => ({ textContent: ` ${this.label} ` }) } : null; },
        getAttribute(name) { return this.attributes.get(name) ?? null; },
        setAttribute(name, value) { this.attributes.set(name, value); },
        removeAttribute(name) { this.attributes.delete(name); },
        focus() { this.focused = true; },
      });
      return nodes.get(id);
    };
    element("host").setAttribute("aria-describedby", "host-hint");
    element("host").label = "Server address";
    const report = runInNewContext(`${script.slice(start, end)}; ${handler}`, {
      element, el: element, errorBox: element("global-error"), errorMessage: element("global-error-text"),
      clearFieldError, markRejectedField, setFieldError,
    });
    for (const [message, field] of [["Hostname is invalid.", "host"], ["Port is invalid.", "port"], ["Username is invalid.", "username"], ["Password is invalid.", "password"]]) {
      report(handler === "error" ? message : new Error(message));
      assert.equal(element(field).getAttribute("aria-invalid"), "true");
      assert.ok(element(field).getAttribute("aria-describedby").split(" ").includes(errorId));
      assert.equal(element(file === "assistant.js" ? "global-error" : errorId).hidden, false);
      // The message uses the field's visible label when the page shows one.
      assert.equal(element(errorId).textContent, field === "host" ? "Server address is invalid." : message);
      clearFieldError(element(field), errorId);
      assert.equal(element(field).getAttribute("aria-invalid"), null);
    }
    report(handler === "error" ? "The VPS is unreachable." : new Error("The VPS is unreachable."));
    for (const field of ["host", "port", "username", "password"]) assert.equal(element(field).getAttribute("aria-invalid"), null);
    assert.equal(element("host").getAttribute("aria-describedby"), "host-hint");
  });
}

for (const [file, handler, errorId] of pages) {
  test(`${file} shows native rejection on the field and clears it when corrected`, async () => {
    const script = await readFile(`src/ui/${file}`, "utf8");
    const assistant = file === "assistant.js";
    const model = file === "local-model-vps.js";
    const first = script.indexOf(`function ${handler}(`);
    const last = script.indexOf("\n}", first) + 2;
    const start = script.indexOf(assistant
      ? 'element("host").addEventListener("input"'
      : model ? 'for (const id of ["host", "port"]) el(id).addEventListener("input"'
        : 'for (const id of ["host", "port"]) element(id).addEventListener("input"');
    const end = script.indexOf(assistant
      ? 'element("vps-form").addEventListener("submit"'
      : model ? 'el("ssh-form").addEventListener("submit"'
        : 'element("scan-button").addEventListener("click"', start);
    assert.ok(first >= 0 && last > first && start >= 0 && end > start);
    const nodes = new Map();
    const element = (id) => {
      if (!nodes.has(id)) nodes.set(id, {
        id, attributes: new Map(), handlers: new Map(), hidden: true, textContent: "",
        getAttribute(name) { return this.attributes.get(name) ?? null; },
        setAttribute(name, value) { this.attributes.set(name, value); },
        removeAttribute(name) { this.attributes.delete(name); },
        addEventListener(name, handler) { this.handlers.set(name, handler); },
        focus() {},
      });
      return nodes.get(id);
    };
    const clearError = () => { element(assistant ? "global-error" : "error-message").hidden = true; };
    runInNewContext(`${script.slice(first, last)}\n${script.slice(start, end)}`, {
      element, el: element, clearError, clearFieldError, markRejectedField, setFieldError,
      errorBox: element("global-error"), errorMessage: element("global-error-text"),
      invalidateReviewedPlan() {}, resetFingerprint() {}, resetHost() {}, invalidate() {}, syncTrust() {},
    });
    const field = element("username");
    element("ssh-form").handlers.get("invalid")?.({ target: field, preventDefault() {} });
    if (assistant) element("vps-form").handlers.get("invalid")({ target: field, preventDefault() {} });
    assert.equal(field.getAttribute("aria-invalid"), "true");
    assert.ok(field.getAttribute("aria-describedby").split(" ").includes(errorId));
    assert.equal(element(assistant ? "global-error" : errorId).hidden, false);
    field.handlers.get("input")();
    assert.equal(field.getAttribute("aria-invalid"), null);
    assert.equal(field.getAttribute("aria-describedby"), null);
    assert.equal(element(assistant ? "global-error" : errorId).hidden, true);
  });
}

test("manual model recovery rejects unsafe names and clears each field on correction", async () => {
  const script = await readFile("src/ui/local-model-vps.js", "utf8");
  const start = script.indexOf('el("inspect-owned").addEventListener');
  const end = script.indexOf('el("refresh").addEventListener', start);
  assert.ok(start >= 0 && end > start);
  const nodes = new Map();
  const el = (id) => {
    if (!nodes.has(id)) nodes.set(id, {
      value: "", hidden: true, attributes: new Map(), handlers: {},
      addEventListener(name, fn) { this.handlers[name] = fn; },
      getAttribute(name) { return this.attributes.get(name) ?? null; },
      setAttribute(name, value) { this.attributes.set(name, value); },
      removeAttribute(name) { this.attributes.delete(name); },
    });
    return nodes.get(id);
  };
  let inspections = 0;
  const state = { manual: false };
  runInNewContext(script.slice(start, end), {
    el, state, clearFieldError, setFieldError,
    async perform(_label, task) { try { await task(); } catch {} },
    invalidate() {},
    async refreshStatus() { inspections++; },
  });
  el("manual-container").value = "n8n;rm";
  el("manual-network").value = "";
  el("inspect-owned").handlers.click();
  await new Promise(resolve => setImmediate(resolve));
  for (const id of ["manual-container", "manual-network"]) {
    assert.equal(el(id).getAttribute("aria-invalid"), "true");
    assert.equal(el(id).getAttribute("aria-describedby"), "error");
  }
  assert.equal(inspections, 0);
  assert.equal(state.manual, false);

  el("manual-container").value = "original-n8n";
  el("manual-container").handlers.input();
  assert.equal(el("manual-container").getAttribute("aria-invalid"), null);
  assert.equal(el("manual-network").getAttribute("aria-invalid"), "true");
  el("manual-network").value = "original_network";
  el("manual-network").handlers.input();
  el("inspect-owned").handlers.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(el("manual-network").getAttribute("aria-invalid"), null);
  assert.equal(inspections, 1);
  assert.equal(state.manual, true);
});

test("local setup marks a rejected port invalid, links the error, and clears both on correction", async () => {
  const script = await readFile("src/ui/local.js", "utf8");
  const helpersStart = script.indexOf("const LOCAL_PORT_REJECTION");
  const helpersEnd = script.indexOf("\nfunction validateLocalN8nStackCredentials", helpersStart);
  const handlersStart = script.indexOf("let reportingRejectedField");
  const handlersEnd = script.indexOf('\nelement("local-port").addEventListener("input", invalidatePlan)', handlersStart);
  assert.ok(helpersStart >= 0 && helpersEnd > helpersStart && handlersStart >= 0 && handlersEnd > handlersStart);
  const nodes = new Map();
  const element = (id) => {
    if (!nodes.has(id)) nodes.set(id, {
      id, attributes: new Map(), handlers: new Map(), hidden: true, textContent: "",
      type: "number", min: "1024", max: "65535", validity: { valueMissing: false },
      getAttribute(name) { return this.attributes.get(name) ?? null; },
      setAttribute(name, value) { this.attributes.set(name, value); },
      removeAttribute(name) { this.attributes.delete(name); },
      addEventListener(name, handler) { this.handlers.set(name, handler); },
      closest() { return { querySelector: () => ({ textContent: " Port for this local connection " }) }; },
      focus() {},
    });
    return nodes.get(id);
  };
  const describedByError = () => [...nodes.values()].filter((node) =>
    (node.getAttribute("aria-describedby") ?? "").split(" ").includes("global-error-text"));
  const timers = [];
  const { showError } = runInNewContext(`${script.slice(helpersStart, helpersEnd)}\n${script.slice(handlersStart, handlersEnd)}\n({ showError });`, {
    element, clearFieldError, setFieldError,
    errorBox: element("global-error"), errorText: element("global-error-text"),
    document: { querySelectorAll: describedByError, querySelector: () => describedByError()[0] ?? null },
    window: { setTimeout: (callback) => timers.push(callback) },
  });
  const port = element("local-port");
  const stackPort = element("n8n-stack-port");
  port.setAttribute("aria-describedby", "local-port-help");
  let prevented = 0;
  const invalid = (target) => element("target-form").handlers.get("invalid")({ target, preventDefault() { prevented++; } });
  // One validation pass rejects two fields: both lose the native bubble, and
  // only the first is reported and linked, as the browser would.
  invalid(port);
  invalid(stackPort);
  assert.equal(prevented, 2);
  assert.equal(port.getAttribute("aria-invalid"), "true");
  assert.equal(port.getAttribute("aria-describedby"), "local-port-help global-error-text");
  assert.equal(stackPort.getAttribute("aria-invalid"), null);
  assert.equal(element("global-error").hidden, false);
  assert.ok(element("global-error-text").textContent.startsWith("Port for this local connection"));

  element("target-form").handlers.get("input")({ target: port });
  assert.equal(port.getAttribute("aria-invalid"), null);
  assert.equal(port.getAttribute("aria-describedby"), "local-port-help");
  assert.equal(element("global-error").hidden, true);

  // The next submit reports again.
  for (const run of timers.splice(0)) run();
  invalid(stackPort);
  assert.equal(stackPort.getAttribute("aria-invalid"), "true");

  // A server-side port rejection marks the field; an unrelated error clears it.
  showError(new Error("Local endpoint port must be between 1024 and 65535."));
  assert.equal(port.getAttribute("aria-invalid"), "true");
  showError(new Error("Docker is unavailable for local planning."));
  assert.equal(port.getAttribute("aria-invalid"), null);
  assert.equal(port.getAttribute("aria-describedby"), "local-port-help");
});

for (const file of ["supergrok-vps.js", "local-model-vps.js"]) {
  test(`${file} keeps live status outside the busy step while locking activation and leaving Tab free`, async () => {
    const script = await readFile(`src/ui/${file}`, "utf8");
    const supergrok = file === "supergrok-vps.js";
    const start = script.indexOf(supergrok ? "function controls()" : 'for (const name of ["click"');
    const end = script.indexOf(supergrok ? "\nasync function api(" : "\nfunction setOptions(", start);
    assert.ok(start >= 0 && end > start);
    const make = (disabled) => ({
      ...(disabled === null ? {} : { disabled }), attributes: new Map(),
      getAttribute(name) { return this.attributes.get(name) ?? null; },
      setAttribute(name, value) { this.attributes.set(name, String(value)); },
      removeAttribute(name) { this.attributes.delete(name); },
    });
    const summary = make(null);
    const input = make(false);
    const preDisabled = make(true);
    const link = make(null);
    const main = make(null);
    const busyRegion = make(null);
    const status = make(null);
    busyRegion.parentElement = main;
    status.parentElement = main;
    const listeners = new Map();
    const state = { busy: false };
    const helpers = runInNewContext(`${script.slice(start, end)}; ({ perform })`, {
      state,
      document: {
        body: { dataset: {} },
        querySelectorAll() { return [summary, input, preDisabled, link]; },
        addEventListener(name, handler) { listeners.set(name, handler); },
      },
      element: id => id === "route-steps-content" ? busyRegion : main,
      el: id => id === "route-steps-content" ? busyRegion : main,
      clearError() {}, setMessage() {}, message() {}, startProgress() {}, stopProgress() {},
      syncConnectionControls() {}, syncTrust() {}, syncConfirm() {},
    });
    let finish;
    const running = helpers.perform("Working", () => new Promise(resolve => { finish = resolve; }));
    await Promise.resolve();
    assert.equal(busyRegion.getAttribute("aria-busy"), "true");
    for (let ancestor = status; ancestor; ancestor = ancestor.parentElement) {
      assert.notEqual(ancestor.getAttribute("aria-busy"), "true");
    }
    assert.equal(input.disabled, true);
    assert.equal(preDisabled.disabled, true);
    assert.equal(summary.getAttribute("tabindex"), "-1");
    assert.equal(link.getAttribute("tabindex"), "-1");
    const fired = (name, key) => {
      let prevented = false;
      listeners.get(name)({
        key, preventDefault() { prevented = true; }, stopImmediatePropagation() {},
      });
      return prevented;
    };
    assert.equal(fired("keydown", "Tab"), false);
    assert.equal(fired("keydown", "Enter"), true);
    assert.equal(fired("click"), true);
    assert.equal(fired("input"), true);
    finish();
    await running;
    assert.equal(busyRegion.getAttribute("aria-busy"), "false");
    assert.equal(input.disabled, false);
    assert.equal(preDisabled.disabled, true);
    assert.equal(summary.getAttribute("tabindex"), null);
    assert.equal(link.getAttribute("tabindex"), null);
  });
}

test("SuperGrok copy recovers from clipboard denial without losing button focus", async () => {
  const script = await readFile("src/ui/supergrok-vps.js", "utf8");
  const start = script.indexOf('element("copy-key").addEventListener');
  const end = script.indexOf('element("disconnect-button").addEventListener', start);
  assert.ok(start >= 0 && end > start);
  const button = { focusCount: 0, focus() { this.focusCount++; } };
  const input = { value: "fixture-bearer" };
  const textarea = {
    style: {}, focus() {}, select() { this.selected = true; },
    remove() { this.removed = true; },
  };
  let handler;
  let copied;
  let status;
  let rejectClipboard;
  runInNewContext(script.slice(start, end), {
    element: id => id === "copy-key" ? { addEventListener: (_, callback) => { handler = callback; } } : input,
    state: { busy: false },
    navigator: { clipboard: { writeText() { return new Promise((_, reject) => { rejectClipboard = reject; }); } } },
    document: {
      createElement() { return textarea; }, body: { append(node) { assert.equal(node, textarea); } },
      execCommand(command) { copied = command; return true; },
    },
    setMessage(value) { status = value; }, showError() { throw new Error("Unexpected copy failure"); },
  });
  const event = { currentTarget: button };
  const copying = handler(event);
  event.currentTarget = null;
  await new Promise(resolve => setImmediate(resolve));
  rejectClipboard(new Error("Denied"));
  await copying;
  assert.equal(textarea.selected, true);
  assert.equal(textarea.removed, true);
  assert.equal(textarea["aria-hidden"], undefined);
  assert.equal(copied, "copy");
  assert.equal(button.focusCount, 1);
  assert.match(status, /copied/i);
});

test("Local model copy reads displayed settings after they diverge from status and constants", async () => {
  const script = await readFile("src/ui/local-model-vps.js", "utf8");
  const start = script.indexOf("async function copyText(");
  const end = script.indexOf('window.addEventListener("pagehide"', start);
  assert.ok(start >= 0 && end > start);
  const nodes = new Map();
  const el = (id) => {
    if (!nodes.has(id)) nodes.set(id, { textContent: "", addEventListener(name, handler) { this[name] = handler; } });
    return nodes.get(id);
  };
  const textarea = {
    style: {}, focus() { this.focused = true; }, select() { this.selected = true; },
    remove() { this.removed = true; },
  };
  let copied;
  let status;
  runInNewContext(script.slice(start, end), {
    el, state: { busy: false, status: { modelId: "stale-model" } }, ENDPOINT: "http://stale.invalid/v1",
    navigator: { clipboard: { async writeText() { throw new Error("Denied"); } } },
    document: {
      createElement() { return textarea; }, body: { append(input) { assert.equal(input, textarea); } },
      execCommand(command) { copied = command; return true; },
    },
    message(value) { status = value; }, error() { throw new Error("Unexpected copy failure"); },
  });
  for (const [buttonId, targetId, displayed] of [
    ["copy-url", "base-url", "http://displayed.invalid/v1"],
    ["copy-model", "selected-model", "displayed-model"],
    ["copy-key", "placeholder-key", "displayed-placeholder"],
  ]) {
    const button = { focusCount: 0, focus() { this.focusCount++; } };
    el(targetId).textContent = "before-render";
    el(targetId).textContent = displayed;
    await el(buttonId).click({ currentTarget: button });
    assert.equal(textarea.value, displayed);
    assert.equal(button.focusCount, 1);
  }
  assert.equal(textarea.selected, true);
  assert.equal(textarea.removed, true);
  assert.equal(textarea["aria-hidden"], undefined);
  assert.equal(copied, "copy");
  assert.match(status, /copied/i);
});

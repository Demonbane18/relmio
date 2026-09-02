import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";

class FakeElement {
  constructor(tagName, {
    disabled = false,
    hidden = false,
    readOnly = false,
    textContent = "",
  } = {}) {
    this.attributes = new Map();
    this.children = [];
    this.dataset = {};
    this.hidden = hidden;
    this.nodeType = 1;
    this.parentElement = null;
    this.tagName = tagName.toUpperCase();
    this.textContent = textContent;
    if (["BUTTON", "INPUT", "SELECT", "TEXTAREA"].includes(this.tagName)) {
      this._disabled = disabled;
      this.disabledWrites = 0;
      Object.defineProperty(this, "disabled", {
        configurable: true,
        get: () => this._disabled,
        set: (value) => {
          this._disabled = value;
          this.disabledWrites += 1;
        },
      });
    }
    if (["INPUT", "TEXTAREA"].includes(this.tagName)) {
      this._readOnly = readOnly;
      this.readOnlyWrites = 0;
      Object.defineProperty(this, "readOnly", {
        configurable: true,
        get: () => this._readOnly,
        set: (value) => {
          this._readOnly = value;
          this.readOnlyWrites += 1;
        },
      });
    }
  }

  append(...children) {
    for (const child of children) {
      child.parentElement = this;
      child.ownerDocument = this.ownerDocument;
      this.children.push(child);
    }
  }

  contains(candidate) {
    if (candidate === this) return true;
    return this.children.some((child) => child.contains(candidate));
  }

  closest(selector) {
    for (let node = this; node; node = node.parentElement) {
      if (selector === "#operation-progress" && node.attributes.get("id") === "operation-progress") {
        return node;
      }
      if (
        selector.includes('[data-operation-allow="auth"]') &&
        node.attributes.get("data-operation-allow") === "auth"
      ) {
        return node;
      }
      if (
        selector.includes('[data-operation-allow="copy"]') &&
        node.attributes.get("data-operation-allow") === "copy"
      ) {
        return node;
      }
    }
    return null;
  }

  focus() {
    this.focused = true;
    if (this.ownerDocument) this.ownerDocument.activeElement = this;
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  hasAttribute(name) {
    return this.attributes.has(name);
  }

  matches(selector) {
    if (selector.includes("button") && this.tagName === "BUTTON") return true;
    if (selector.includes("input") && this.tagName === "INPUT") return true;
    if (selector.includes("select") && this.tagName === "SELECT") return true;
    if (selector.includes("textarea") && this.tagName === "TEXTAREA") return true;
    if (selector.includes("a[href]") && this.tagName === "A" && this.hasAttribute("href")) return true;
    return selector.includes("[contenteditable]") && this.hasAttribute("contenteditable");
  }

  querySelectorAll(selector) {
    const matches = [];
    const visit = (node) => {
      for (const child of node.children) {
        if (child.matches(selector)) matches.push(child);
        visit(child);
      }
    };
    visit(this);
    return matches;
  }

  removeAttribute(name) {
    this.attributes.delete(name);
  }

  setAttribute(name, value) {
    this.attributes.set(name, String(value));
  }
}

function extractOperationHelpers(script) {
  const start = script.indexOf("const OPERATION_INTERACTIVE_SELECTOR");
  const end = script.indexOf("\nfunction showStep(step)", start);
  assert.ok(start >= 0, "missing central operation helper marker");
  assert.ok(end > start, "missing central operation helper end marker");
  return script.slice(start, end);
}

function createHarness(script) {
  const elements = new Map();
  const body = new FakeElement("body");
  const mainContent = new FakeElement("main");
  const operationProgress = new FakeElement("section", { hidden: true });
  operationProgress.setAttribute("id", "operation-progress");
  const installProgress = new FakeElement("section", { hidden: true });
  const label = new FakeElement("p", { textContent: "No operation is running." });
  const elapsed = new FakeElement("time", { textContent: "00:00" });
  const progressbar = new FakeElement("div");
  operationProgress.append(installProgress, label, elapsed, progressbar);

  const activeButton = new FakeElement("button", { textContent: "Review local plan" });
  const enabledInput = new FakeElement("input");
  const disabledSelect = new FakeElement("select", { disabled: true });
  const readonlyTextarea = new FakeElement("textarea", { readOnly: true });
  const navigation = new FakeElement("a");
  delete navigation.disabled;
  delete navigation.readOnly;
  navigation.setAttribute("href", "/local");
  const themeInput = new FakeElement("input");
  const hiddenAction = new FakeElement("button", { hidden: true });
  const deviceCodeCopy = new FakeElement("button", { textContent: "Copy" });
  deviceCodeCopy.setAttribute("data-operation-allow", "copy");
  body.append(
    activeButton,
    enabledInput,
    disabledSelect,
    readonlyTextarea,
    navigation,
    themeInput,
    hiddenAction,
    deviceCodeCopy,
    operationProgress,
    mainContent,
  );

  for (const [id, value] of [
    ["operation-progress", operationProgress],
    ["install-progress", installProgress],
    ["operation-progress-label", label],
    ["operation-progress-elapsed", elapsed],
    ["operation-progress-bar", progressbar],
    ["install-progress-phase", label],
    ["install-elapsed", elapsed],
    ["install-progress-bar", progressbar],
    ["main-content", mainContent],
  ]) {
    elements.set(id, value);
  }

  const listeners = new Map();
  const controls = [
    activeButton,
    enabledInput,
    disabledSelect,
    readonlyTextarea,
    navigation,
    themeInput,
    hiddenAction,
    deviceCodeCopy,
  ];
  const document = {
    activeElement: activeButton,
    body,
    addEventListener(name, handler, options) {
      listeners.set(name, { handler, options });
    },
    querySelectorAll(selector) {
      return controls.filter((control) => control.matches(selector));
    },
  };
  const assignOwnerDocument = (node) => {
    node.ownerDocument = document;
    for (const child of node.children) assignOwnerDocument(child);
  };
  assignOwnerDocument(body);

  const intervals = [];
  const clearedIntervals = [];
  const observers = [];
  class FakeMutationObserver {
    constructor(callback) {
      this.callback = callback;
      observers.push(this);
    }

    disconnect() {
      this.disconnected = true;
    }

    observe(target, options) {
      this.observed = { options, target };
    }
  }

  const state = {
    operationBusy: false,
    operationButton: null,
    operationControlObserver: null,
    operationControlStates: [],
    operationLabel: "",
    operationProgressStartedAt: 0,
    operationProgressTimer: null,
  };
  const helpers = runInNewContext(
    `${extractOperationHelpers(script)}\n({ setBusy, startOperation, stopOperation, updateOperationProgress });`,
    {
      Date,
      MutationObserver: FakeMutationObserver,
      document,
      element(id) {
        if (!elements.has(id)) elements.set(id, new FakeElement("div"));
        return elements.get(id);
      },
      state,
      window: {
        clearInterval(timer) {
          clearedIntervals.push(timer);
        },
        setInterval(callback, milliseconds) {
          intervals.push({ callback, milliseconds });
          return intervals.length;
        },
      },
    },
    { filename: "local-operation-progress-ui.vm.js", timeout: 1_000 },
  );

  return {
    activeButton,
    clearedIntervals,
    controls,
    deviceCodeCopy,
    disabledSelect,
    document,
    elapsed,
    enabledInput,
    helpers,
    hiddenAction,
    intervals,
    label,
    listeners,
    mainContent,
    navigation,
    observers,
    operationProgress,
    progressbar,
    readonlyTextarea,
    state,
    themeInput,
  };
}

function blockedEvent(target) {
  return {
    defaultPrevented: false,
    immediatePropagationStopped: false,
    target,
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopImmediatePropagation() {
      this.immediatePropagationStopped = true;
    },
  };
}

test("local wizard exposes one semantic indeterminate operation progress region", async () => {
  const html = await readFile("src/ui/local.html", "utf8");
  const root = html.match(/<[^>]+id="operation-progress"[^>]*>/u)?.[0] ?? "";
  const progressbar = html.match(
    /<[^>]+class="[^"]*operation-progress__track[^"]*"[^>]*>/u,
  )?.[0] ?? "";

  assert.match(root, /class="operation-progress"/u);
  assert.match(root, /role="status"/u);
  assert.match(root, /aria-live="polite"/u);
  assert.match(root, /aria-atomic="false"/u);
  assert.match(root, /hidden/u);
  assert.match(html, /class="[^"]*operation-progress__track/u);
  assert.match(html, /class="[^"]*operation-progress__bar/u);
  assert.match(html, /class="[^"]*operation-progress__label/u);
  assert.match(html, /class="[^"]*operation-progress__elapsed/u);
  assert.match(html, /class="install-progress-elapsed" aria-hidden="true"/u);
  assert.match(html, /id="main-content"[^>]*aria-busy="false"/u);
  assert.doesNotMatch(html, /<body[^>]*aria-busy=/u);
  assert.match(progressbar, /role="progressbar"/u);
  assert.doesNotMatch(progressbar, /aria-value(?:now|min|max)/u);
  assert.match(html, /Duration varies by operation/u);
  assert.doesNotMatch(html, /(?:\bETA\b|estimated time|\d+% complete)/iu);
});

test("central operation lifecycle locks, observes, blocks, restores, and resets", async () => {
  const script = await readFile("src/ui/local.js", "utf8");
  const harness = createHarness(script);
  const started = harness.helpers.setBusy(
    harness.activeButton,
    true,
    "Preparing plan…",
  );

  assert.equal(started, true);
  assert.equal(harness.state.operationBusy, true);
  assert.equal(harness.document.body.dataset.operationBusy, "true");
  assert.equal(harness.document.body.getAttribute("aria-busy"), null);
  assert.equal(harness.mainContent.getAttribute("aria-busy"), "true");
  assert.equal(harness.operationProgress.hidden, false);
  assert.equal(harness.label.textContent, "Preparing plan…");
  assert.equal(harness.activeButton.textContent, "Preparing plan…");
  assert.equal(harness.activeButton.getAttribute("aria-busy"), "true");
  assert.equal(harness.intervals.length, 1);
  assert.equal(harness.intervals[0].milliseconds, 1_000);
  assert.ok(
    harness.controls
      .filter((control) =>
        control !== harness.navigation && control !== harness.deviceCodeCopy)
      .every((control) => control.disabled),
  );
  assert.equal(harness.deviceCodeCopy.disabled, false, "required device-code copy stays usable");
  assert.equal(harness.enabledInput.readOnly, true);
  assert.equal(harness.readonlyTextarea.readOnly, true);
  assert.equal(harness.navigation.getAttribute("aria-disabled"), "true");
  assert.equal(harness.navigation.getAttribute("tabindex"), "-1");
  assert.equal(harness.hiddenAction.disabled, true, "hidden actions are locked before being shown");

  const dynamicButton = new FakeElement("button", { hidden: true });
  harness.observers[0].callback([{ addedNodes: [dynamicButton] }]);
  assert.equal(dynamicButton.disabled, true, "new controls inherit the active lock");

  const lockedDisabledWrites = harness.enabledInput.disabledWrites;
  const lockedReadOnlyWrites = harness.enabledInput.readOnlyWrites;
  harness.observers[0].callback([{
    addedNodes: [],
    target: harness.enabledInput,
    type: "attributes",
  }]);
  assert.equal(
    harness.enabledInput.disabledWrites,
    lockedDisabledWrites,
    "an already disabled control is not rewritten by its own observer record",
  );
  assert.equal(
    harness.enabledInput.readOnlyWrites,
    lockedReadOnlyWrites,
    "an already readonly control is not rewritten by its own observer record",
  );
  harness.enabledInput.disabled = false;
  harness.enabledInput.readOnly = false;
  harness.observers[0].callback([{
    addedNodes: [],
    target: harness.enabledInput,
    type: "attributes",
  }]);
  assert.equal(harness.enabledInput.disabled, true, "a drifted control is disabled again");
  assert.equal(harness.enabledInput.readOnly, true, "a drifted control is readonly again");

  const dynamicLink = new FakeElement("a");
  delete dynamicLink.disabled;
  delete dynamicLink.readOnly;
  dynamicLink.setAttribute("href", "https://example.com/");
  harness.observers[0].callback([{ type: "attributes", target: dynamicLink }]);
  assert.equal(dynamicLink.getAttribute("aria-disabled"), "true");
  assert.equal(dynamicLink.getAttribute("tabindex"), "-1");

  const authLink = new FakeElement("a");
  delete authLink.disabled;
  delete authLink.readOnly;
  authLink.setAttribute("data-operation-allow", "auth");
  authLink.setAttribute("href", "https://auth.openai.com/oauth/authorize");
  harness.observers[0].callback([{ type: "attributes", target: authLink }]);
  assert.equal(authLink.getAttribute("aria-disabled"), null);
  assert.equal(authLink.getAttribute("tabindex"), null);

  harness.enabledInput.disabled = false;
  harness.enabledInput.readOnly = false;
  harness.observers[0].callback([
    { type: "attributes", target: harness.enabledInput },
  ]);
  assert.equal(harness.enabledInput.disabled, true, "render updates cannot remove the lock");
  assert.equal(harness.enabledInput.readOnly, true, "typing stays locked after render updates");

  harness.state.operationProgressStartedAt = Date.now() - 65_000;
  harness.intervals[0].callback();
  assert.equal(harness.elapsed.textContent, "01:05");
  assert.equal(harness.elapsed.dateTime, "PT65S");
  assert.equal(harness.label.textContent, "Preparing plan…", "elapsed time never invents a phase");

  for (const eventName of ["click", "pointerdown", "keydown", "beforeinput", "input", "change", "submit"]) {
    const event = blockedEvent(harness.navigation);
    harness.listeners.get(eventName).handler(event);
    assert.equal(event.defaultPrevented, true, `${eventName} default is blocked`);
    assert.equal(event.immediatePropagationStopped, true, `${eventName} handlers are blocked`);
    assert.equal(harness.listeners.get(eventName).options, true, `${eventName} guard captures first`);
  }
  for (const allowedControl of [authLink, harness.deviceCodeCopy]) {
    const event = blockedEvent(allowedControl);
    harness.listeners.get("click").handler(event);
    assert.equal(event.defaultPrevented, false, "required auth actions stay usable");
    assert.equal(event.immediatePropagationStopped, false);
  }

  assert.equal(
    harness.helpers.setBusy(new FakeElement("button"), true, "Duplicate…"),
    false,
    "a second operation cannot enter while locked",
  );
  assert.equal(harness.helpers.setBusy(harness.activeButton, false), true);

  assert.equal(harness.state.operationBusy, false);
  assert.equal(harness.document.body.dataset.operationBusy, "false");
  assert.equal(harness.document.body.getAttribute("aria-busy"), null);
  assert.equal(harness.mainContent.getAttribute("aria-busy"), "false");
  assert.equal(harness.operationProgress.hidden, true);
  assert.equal(harness.label.textContent, "No operation is running.");
  assert.equal(harness.elapsed.textContent, "00:00");
  assert.equal(harness.activeButton.textContent, "Review local plan");
  assert.equal(harness.activeButton.getAttribute("aria-busy"), "false");
  assert.equal(harness.document.activeElement, harness.activeButton);
  assert.equal(harness.enabledInput.disabled, false);
  assert.equal(harness.enabledInput.readOnly, false);
  assert.equal(harness.disabledSelect.disabled, true);
  assert.equal(harness.readonlyTextarea.disabled, false);
  assert.equal(harness.readonlyTextarea.readOnly, true);
  assert.equal(harness.themeInput.disabled, false);
  assert.equal(harness.hiddenAction.disabled, false);
  assert.equal(dynamicButton.disabled, false);
  assert.equal(dynamicLink.getAttribute("aria-disabled"), null);
  assert.equal(dynamicLink.getAttribute("tabindex"), null);
  assert.equal(authLink.getAttribute("aria-disabled"), null);
  assert.equal(authLink.getAttribute("tabindex"), null);
  assert.equal(harness.navigation.getAttribute("aria-disabled"), null);
  assert.equal(harness.navigation.getAttribute("tabindex"), null);
  assert.deepEqual(harness.clearedIntervals, [1]);
  assert.equal(harness.observers[0].disconnected, true);

  const after = blockedEvent(harness.navigation);
  harness.listeners.get("click").handler(after);
  assert.equal(after.defaultPrevented, false, "events resume after deterministic reset");
});

test("operation cleanup restores the wizard after both success and error", async () => {
  const script = await readFile("src/ui/local.js", "utf8");
  const harness = createHarness(script);
  const runOperation = async (work) => {
    assert.equal(
      harness.helpers.setBusy(harness.activeButton, true, "Checking…"),
      true,
    );
    try {
      return await work();
    } finally {
      harness.helpers.setBusy(harness.activeButton, false);
    }
  };

  assert.equal(await runOperation(async () => "done"), "done");
  assert.equal(harness.state.operationBusy, false);
  assert.equal(harness.enabledInput.disabled, false);
  assert.equal(harness.operationProgress.hidden, true);

  await assert.rejects(
    runOperation(async () => {
      throw new Error("expected operation failure");
    }),
    /expected operation failure/u,
  );
  assert.equal(harness.state.operationBusy, false);
  assert.equal(harness.enabledInput.disabled, false);
  assert.equal(harness.activeButton.textContent, "Review local plan");
  assert.equal(harness.operationProgress.hidden, true);
  assert.equal(harness.elapsed.textContent, "00:00");

  assert.equal(
    harness.helpers.setBusy(harness.activeButton, true, "Checking…"),
    true,
  );
  harness.document.activeElement = harness.navigation;
  harness.activeButton.focused = false;
  harness.helpers.setBusy(harness.activeButton, false);
  assert.equal(
    harness.activeButton.focused,
    false,
    "cleanup does not steal focus after another destination receives it",
  );
});

test("every long-running local wizard action enters and leaves the shared lifecycle", async () => {
  const script = await readFile("src/ui/local.js", "utf8");
  const busyStarts = script.match(/setBusy\(button, true,/gu) ?? [];
  const busyStops = script.match(/setBusy\(button, false\);/gu) ?? [];

  assert.ok(busyStarts.length >= 15, `expected all async action starts, found ${busyStarts.length}`);
  assert.equal(busyStops.length, busyStarts.length);
  assert.match(script, /startInstallProgress\(button\);[\s\S]*stopInstallProgress\(button\);/u);
  const refreshContext = script.slice(
    script.indexOf("async function refreshSelectedN8nContext("),
    script.indexOf("function validateOAuthAuthorizationUrl("),
  );
  assert.match(refreshContext, /startOperation\(/u);
  assert.match(refreshContext, /Promise\.allSettled\(/u);
  assert.doesNotMatch(refreshContext, /Promise\.all\(/u);
  assert.match(script, /async function initializeLocalWizard\([\s\S]*startOperation\(/u);
  for (const path of [
    "/api/local/plan",
    "/api/local/n8n/discover",
    "/api/oauth/login",
    "/api/local/n8n/sidecar/refresh",
    "/api/local/n8n/assistant/searxng/review",
    "/api/local/n8n/assistant/searxng/enable",
    "/api/local/install",
    "/api/local/n8n/remove",
    "/api/local/n8n/assistant/remove",
    "/api/local/n8n/stack/resume",
    "/api/local/n8n/stack/remove",
    "/api/local/client-credential/rotate",
    "/api/local/chat-test/key",
    "/api/local/codex/login",
  ]) {
    assert.match(script, new RegExp(path.replaceAll("/", "\\/"), "u"));
  }
  assert.doesNotMatch(script, /console\.(?:log|info|debug|warn|error)\([^)]*(?:credential|password|token|apiKey)/iu);
});

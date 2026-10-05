import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";

const WIZARDS = [
  { allowOAuth: true, busyId: "setup-steps", html: "src/ui/index.html", script: "src/ui/app.js" },
  { allowOAuth: false, busyId: "assistant-step", html: "src/ui/assistant.html", script: "src/ui/assistant.js" },
];

class FakeElement {
  constructor(tagName, {
    disabled = false,
    hidden = false,
    id = "",
    readOnly = false,
    textContent = "",
  } = {}) {
    this.attributes = new Map();
    this.children = [];
    this.dataset = {};
    this.hidden = hidden;
    this.isConnected = true;
    this.nodeType = 1;
    this.parentElement = null;
    this.tagName = tagName.toUpperCase();
    this.textContent = textContent;
    if (id) this.setAttribute("id", id);
    if (["BUTTON", "INPUT", "SELECT", "TEXTAREA"].includes(this.tagName)) {
      this.disabled = disabled;
    }
    if (["INPUT", "TEXTAREA"].includes(this.tagName)) {
      this.readOnly = readOnly;
    }
  }

  append(...children) {
    for (const child of children) {
      child.parentElement = this;
      child.ownerDocument = this.ownerDocument;
      this.children.push(child);
    }
  }

  closest(selector) {
    for (let node = this; node; node = node.parentElement) {
      const id = node.getAttribute("id");
      if (selector === "#operation-progress" && id === "operation-progress") {
        return node;
      }
      if (
        selector.includes("#login-link") &&
        ["login-link", "stop-login-button"].includes(id)
      ) {
        return node;
      }
    }
    return null;
  }

  contains(candidate) {
    if (candidate === this) return true;
    return this.children.some((child) => child.contains(candidate));
  }

  focus(options) {
    this.focused = true;
    this.focusOptions = options;
    if (this.ownerDocument) this.ownerDocument.activeElement = this;
  }
  scrollIntoView(options) {
    this.scrolledIntoView = options;
  }

  getAttribute(name) {
    return this.attributes.get(name) ?? null;
  }

  hasAttribute(name) {
    return this.attributes.has(name);
  }

  matches(selector) {
    if (selector === ".assistant-step") return this.getAttribute("id") === "assistant-step";
    if (selector.includes("button") && this.tagName === "BUTTON") return true;
    if (selector.includes("input") && this.tagName === "INPUT") return true;
    if (selector.includes("select") && this.tagName === "SELECT") return true;
    if (selector.includes("textarea") && this.tagName === "TEXTAREA") return true;
    if (selector.includes("summary") && this.tagName === "SUMMARY") return true;
    if (selector.includes("a[href]") && this.tagName === "A" && this.hasAttribute("href")) {
      return true;
    }
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
  const focusStart = script.indexOf("function focusVisible(");
  const focusEnd = script.indexOf("\nfunction ", focusStart + 1);
  const start = script.indexOf("const OPERATION_INTERACTIVE_SELECTOR");
  const end = script.indexOf("\nfunction showStep(step)", start);
  assert.ok(focusStart >= 0 && focusEnd > focusStart && start >= 0 && end > start);
  return `${script.slice(focusStart, focusEnd)}\n${script.slice(start, end)}`;
}

function createHarness(script, wizard) {
  const elements = new Map();
  const body = new FakeElement("body");
  const mainContent = new FakeElement("main", { id: "main-content" });
  const busyRegion = new FakeElement("section", { id: wizard.busyId });
  const message = new FakeElement("div", { id: "global-message" });
  message.setAttribute("aria-live", "polite");
  const progress = new FakeElement("section", {
    hidden: true,
    id: "operation-progress",
  });
  const label = new FakeElement("p", {
    id: "operation-progress-label",
    textContent: "No operation is running.",
  });
  const elapsed = new FakeElement("time", {
    id: "operation-progress-elapsed",
    textContent: "00:00",
  });
  const progressbar = new FakeElement("div", { id: "operation-progress-bar" });
  const note = new FakeElement("p", { id: "operation-progress-note" });
  progress.append(label, elapsed, progressbar, note);
  const rail = new FakeElement("aside");
  rail.append(progress);
  mainContent.append(rail, busyRegion);

  const activeButton = new FakeElement("button", {
    id: "review-button",
    textContent: "Review the exact plan",
  });
  const backButton = new FakeElement("button", {
    id: "back-button",
    textContent: "Back",
  });
  const disclosure = new FakeElement("summary", { id: "details" });
  const input = new FakeElement("input", { id: "host" });
  const disabledSelect = new FakeElement("select", {
    disabled: true,
    id: "network-select",
  });
  const navigation = new FakeElement("a", { id: "setup-another-vps" });
  delete navigation.disabled;
  delete navigation.readOnly;
  navigation.setAttribute("href", "/");
  const loginLink = new FakeElement("a", { id: "login-link" });
  delete loginLink.disabled;
  delete loginLink.readOnly;
  loginLink.setAttribute("href", "https://auth.openai.com/oauth/authorize");
  const stopLogin = new FakeElement("button", {
    disabled: false,
    id: "stop-login-button",
    textContent: "Stop ChatGPT sign-in",
  });
  body.append(
    activeButton,
    backButton,
    disclosure,
    input,
    disabledSelect,
    navigation,
    loginLink,
    stopLogin,
    message,
    mainContent,
  );

  for (const value of [mainContent, busyRegion, message, progress, label, elapsed, progressbar, note]) {
    elements.set(value.getAttribute("id"), value);
  }

  const controls = [
    activeButton,
    backButton,
    disclosure,
    input,
    disabledSelect,
    navigation,
    loginLink,
    stopLogin,
  ];
  const listeners = new Map();
  const document = {
    activeElement: activeButton,
    body,
    addEventListener(name, handler, options) {
      listeners.set(name, { handler, options });
    },
    querySelectorAll(selector) {
      if (selector === ".assistant-step") return wizard.allowOAuth ? [] : [busyRegion];
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
    step: 1,
    fingerprint: null,
    operationAllowedSelector: null,
    operationButton: null,
    operationButtonAriaBusy: null,
    operationButtonLabel: "",
    operationControlObserver: null,
    operationControlStates: [],
    operationFocusControl: null,
    operationLabel: "",
    operationMessageLive: null,
    operationOwner: 0,
    operationProgressStartedAt: 0,
    operationProgressTimer: null,
  };
  const helpers = runInNewContext(
    `${extractOperationHelpers(script)}\n({ runOperation, startOperation, stopOperation, updateOperationProgress });`,
    {
      Date,
      MutationObserver: FakeMutationObserver,
      document,
      element(id) {
        if (!elements.has(id)) elements.set(id, new FakeElement("div", { id }));
        return elements.get(id);
      },
      sshAuthentication: { sync() {} },
      setCredentialInputsEnabled(enabled) {
        for (const id of ["username", "ssh-authentication"]) {
          if (!elements.has(id)) elements.set(id, new FakeElement(id === "username" ? "input" : "select", { id }));
          elements.get(id).disabled = !enabled;
        }
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
    { filename: "vps-operation-progress-ui.vm.js", timeout: 1_000 },
  );

  return {
    activeButton,
    busyRegion,
    backButton,
    disclosure,
    clearedIntervals,
    disabledSelect,
    document,
    elapsed,
    helpers,
    input,
    intervals,
    label,
    listeners,
    loginLink,
    mainContent,
    message,
    navigation,
    note,
    observers,
    progress,
    progressbar,
    state,
    stopLogin,
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

test("shared VPS lifecycle excludes overlap and locks slow operations", async () => {
  for (const wizard of WIZARDS) {
    const script = await readFile(wizard.script, "utf8");
    const harness = createHarness(script, wizard);
    let release;
    const pending = harness.helpers.runOperation(
      harness.activeButton,
      "Preparing plan…",
      () => new Promise((resolve) => {
        release = resolve;
      }),
      wizard.allowOAuth
        ? { allowedSelector: "#login-link, #stop-login-button" }
        : undefined,
    );
    await Promise.resolve();

    assert.equal(harness.state.operationBusy, true, wizard.script);
    assert.equal(harness.document.body.dataset.operationBusy, "true");
    assert.equal(harness.busyRegion.getAttribute("aria-busy"), "true");
    for (let ancestor = harness.progress; ancestor; ancestor = ancestor.parentElement) {
      assert.notEqual(ancestor.getAttribute("aria-busy"), "true", "live progress is outside the busy step");
    }
    assert.equal(harness.progress.hidden, false);
    assert.equal(harness.progress.scrolledIntoView.block, "start", "active progress is revealed");
    assert.equal(harness.progress.focusOptions.preventScroll, true);
    assert.equal(harness.label.textContent, "Preparing plan…");
    assert.equal(harness.activeButton.textContent, "Preparing plan…");
    assert.equal(harness.activeButton.getAttribute("aria-busy"), "true");
    assert.equal(harness.message.getAttribute("aria-live"), "off");
    assert.equal(harness.intervals.length, 1);
    assert.equal(harness.intervals[0].milliseconds, 1_000);
    assert.equal(harness.backButton.disabled, true, "Back is locked");
    assert.equal(harness.input.disabled, true, "typing control is disabled");
    assert.equal(harness.input.readOnly, true, "typing control is readonly");
    assert.equal(harness.navigation.getAttribute("aria-disabled"), "true");
    assert.equal(harness.navigation.getAttribute("tabindex"), "-1");
    assert.equal(
      harness.loginLink.getAttribute("aria-disabled"),
      wizard.allowOAuth ? null : "true",
    );
    assert.equal(harness.stopLogin.disabled, !wizard.allowOAuth);
    assert.equal(harness.disclosure.getAttribute("tabindex"), "-1");
    for (const key of ["Tab"]) {
      for (const shiftKey of [false, true]) {
        const event = { ...blockedEvent(harness.disclosure), type: "keydown", key, shiftKey };
        harness.listeners.get("keydown").handler(event);
        assert.equal(event.defaultPrevented, false, `${wizard.script}: ${shiftKey ? "Shift+Tab" : "Tab"} moves focus`);
      }
    }
    const activation = { ...blockedEvent(harness.disclosure), type: "keydown", key: "Enter" };
    harness.listeners.get("keydown").handler(activation);
    assert.equal(activation.defaultPrevented, true, "native disclosure stays locked");

    for (const target of [harness.backButton, harness.input, harness.navigation]) {
      for (const eventName of ["click", "pointerdown", "keydown", "beforeinput", "input", "change", "submit"]) {
        const event = blockedEvent(target);
        harness.listeners.get(eventName).handler(event);
        assert.equal(event.defaultPrevented, true, `${wizard.script} ${eventName}`);
        assert.equal(event.immediatePropagationStopped, true);
        assert.equal(harness.listeners.get(eventName).options, true);
      }
    }
    for (const oauthControl of [harness.loginLink, harness.stopLogin]) {
      const event = blockedEvent(oauthControl);
      harness.listeners.get("click").handler(event);
      assert.equal(
        event.defaultPrevented,
        !wizard.allowOAuth,
        "OAuth controls are exceptions only in the OAuth-owning wizard lifecycle",
      );
    }

    assert.equal(
      harness.helpers.startOperation(new FakeElement("button"), "Duplicate…"),
      false,
      "a second operation cannot enter",
    );
    harness.state.operationProgressStartedAt = Date.now() - 65_000;
    const progressValueText = harness.progressbar.getAttribute("aria-valuetext");
    harness.intervals[0].callback();
    assert.equal(harness.elapsed.textContent, "01:05");
    assert.equal(harness.elapsed.getAttribute("datetime"), "PT65S");
    assert.equal(harness.label.textContent, "Preparing plan…");
    assert.equal(
      harness.progressbar.getAttribute("aria-valuetext"),
      progressValueText,
      "elapsed ticks do not rewrite the live operation label",
    );

    const dynamicButton = new FakeElement("button", { hidden: true });
    harness.observers[0].callback([{ addedNodes: [dynamicButton] }]);
    assert.equal(dynamicButton.disabled, true, "newly rendered controls inherit the lock");

    release("done");
    assert.equal(await pending, "done");
    assert.equal(harness.state.operationBusy, false);
    assert.equal(harness.document.body.dataset.operationBusy, "false");
    assert.equal(harness.busyRegion.getAttribute("aria-busy"), "false");
    assert.equal(harness.progress.hidden, true);
    assert.equal(harness.message.getAttribute("aria-live"), "polite");
    assert.equal(harness.backButton.disabled, false);
    assert.equal(harness.input.disabled, false);
    assert.equal(harness.input.readOnly, false);
    assert.equal(harness.disabledSelect.disabled, true, "business-disabled state is preserved");
    assert.equal(harness.navigation.getAttribute("aria-disabled"), null);
    assert.equal(harness.navigation.getAttribute("tabindex"), null);
    assert.equal(harness.disclosure.getAttribute("tabindex"), null);
    assert.equal(harness.document.activeElement, harness.activeButton);
    assert.equal(harness.activeButton.scrolledIntoView.block, "start", "restored focus is revealed");
    assert.deepEqual(harness.clearedIntervals, [1]);
    assert.equal(harness.observers[0].disconnected, true);
  }
});

test("VPS lifecycle restores success, failure, and replaced-button paths", async () => {
  for (const wizard of WIZARDS) {
    const script = await readFile(wizard.script, "utf8");
    const harness = createHarness(script, wizard);

    assert.equal(
      await harness.helpers.runOperation(
        harness.activeButton,
        "Checking…",
        async () => "ok",
      ),
      "ok",
    );
    assert.equal(harness.state.operationBusy, false);
    assert.equal(harness.disabledSelect.disabled, true);

    await assert.rejects(
      harness.helpers.runOperation(
        harness.activeButton,
        "Checking…",
        async () => {
          throw new Error("expected operation failure");
        },
      ),
      /expected operation failure/u,
    );
    assert.equal(harness.state.operationBusy, false);
    assert.equal(harness.input.disabled, false);
    assert.equal(harness.progress.hidden, true);
    assert.equal(harness.elapsed.textContent, "00:00");

    const replacementHarness = createHarness(script, wizard);
    assert.equal(
      replacementHarness.helpers.startOperation(
        replacementHarness.activeButton,
        "Checking…",
      ),
      true,
    );
    replacementHarness.activeButton.isConnected = false;
    replacementHarness.activeButton.focused = false;
    assert.equal(
      replacementHarness.helpers.stopOperation(replacementHarness.activeButton),
      true,
    );
    assert.equal(
      replacementHarness.activeButton.focused,
      false,
      "a detached initiating button is never focused during cleanup",
    );

    const ownerHarness = createHarness(script, wizard);
    assert.equal(
      ownerHarness.helpers.startOperation(ownerHarness.activeButton, "First…"),
      true,
    );
    const firstOwner = ownerHarness.state.operationOwner;
    assert.equal(
      ownerHarness.helpers.stopOperation(ownerHarness.activeButton, firstOwner),
      true,
    );
    assert.equal(
      ownerHarness.helpers.startOperation(ownerHarness.activeButton, "Second…"),
      true,
    );
    const secondOwner = ownerHarness.state.operationOwner;
    assert.equal(
      ownerHarness.helpers.stopOperation(ownerHarness.activeButton, firstOwner),
      false,
      "a stale cleanup cannot release the current operation",
    );
    assert.equal(ownerHarness.state.operationBusy, true);
    assert.equal(
      ownerHarness.helpers.stopOperation(ownerHarness.activeButton, secondOwner),
      true,
    );

    const startupHarness = createHarness(script, wizard);
    startupHarness.document.activeElement = startupHarness.document.body;
    await startupHarness.helpers.runOperation(
      null,
      "Checking local state…",
      async () => "ready",
    );
    assert.equal(
      startupHarness.document.activeElement,
      startupHarness.mainContent,
      "a triggerless startup check never leaves focus in the hidden progress region",
    );
  }
});

test("OAuth exceptions hand focus back before either allowed control disappears", async () => {
  const script = await readFile("src/ui/app.js", "utf8");

  for (const allowedControlName of ["loginLink", "stopLogin"]) {
    const harness = createHarness(script, WIZARDS[0]);
    let release;
    const pending = harness.helpers.runOperation(
      harness.activeButton,
      "Waiting for browser sign-in…",
      () => new Promise((resolve) => {
        release = resolve;
      }),
      { allowedSelector: "#login-link, #stop-login-button" },
    );
    await Promise.resolve();

    const allowedControl = harness[allowedControlName];
    allowedControl.hidden = true;
    harness.document.activeElement = allowedControl;
    release();
    await pending;

    assert.equal(
      harness.document.activeElement,
      harness.activeButton,
      `${allowedControlName} cannot retain focus after OAuth cleanup`,
    );
  }
});

test("VPS route operations reveal their live rail status while the step is busy", async () => {
  const supergrok = await readFile("src/ui/supergrok-vps.js", "utf8");
  const progress = new FakeElement("section", { hidden: true });
  const label = new FakeElement("p");
  const bar = new FakeElement("div");
  const started = supergrok.indexOf("function startProgress(");
  const ended = supergrok.indexOf("\nfunction controls()", started);
  const grokState = { progressStartedAt: 0, progressTimer: null };
  const startProgress = runInNewContext(
    `${supergrok.slice(started, ended)}\nstartProgress`,
    {
      element(id) {
        return { "operation-progress": progress, "operation-progress-label": label, "operation-progress-bar": bar }[id];
      },
      state: grokState,
      updateProgress() {},
      window: { setInterval() { return 1; }, clearInterval() {} },
    },
  );
  startProgress("Checking VPS identity…");
  assert.equal(progress.hidden, false);
  assert.equal(progress.scrolledIntoView.block, "nearest", "an offscreen status is revealed without moving a visible one");

  const local = await readFile("src/ui/local-model-vps.js", "utf8");
  const operationStart = local.indexOf("async function perform(");
  const operationEnd = local.indexOf("\nfunction setOptions", operationStart);
  const status = new FakeElement("p");
  const busyStep = new FakeElement("div");
  const polling = new FakeElement("p", { hidden: false });
  const modelState = { busy: false };
  let release;
  const { perform } = runInNewContext(
    `${local.slice(operationStart, operationEnd)}\n({ perform })`,
    {
      document: { querySelectorAll() { return []; } },
      el(id) { return { error: new FakeElement("p"), message: status, progress: polling, "route-steps-content": busyStep }[id]; },
      error() {},
      message(value) { status.textContent = value; },
      state: modelState,
      syncConfirm() {},
      syncTrust() {},
    },
  );
  const pending = perform("Checking VPS host identity…", () => new Promise((resolve) => { release = resolve; }));
  assert.equal(modelState.busy, true);
  assert.equal(busyStep.getAttribute("aria-busy"), "true");
  assert.equal(status.scrolledIntoView.block, "nearest", "an offscreen status is revealed without moving a visible one");
  assert.equal(polling.hidden, true, "a new operation restores its own current status");
  release();
  await pending;
  assert.equal(modelState.busy, false);
});

test("model polling completion replaces download feedback with the final status", async () => {
  const script = await readFile("src/ui/local-model-vps.js", "utf8");
  const start = script.indexOf("function renderStatus(");
  const end = script.indexOf("\nasync function refreshStatus", start);
  const nodes = new Map([
    ...["installation-state", "review-install", "review-retry", "review-remove",
      "settings-panel", "selected-model", "readiness", "message"].map((id) => [id, new FakeElement("p")]),
    ["progress", new FakeElement("p", { hidden: true })],
  ]);
  const state = { manual: false, timer: null };
  const renderStatus = runInNewContext(
    `${script.slice(start, end)}\nrenderStatus`,
    {
      clearTimeout() {},
      el(id) { return nodes.get(id); },
      message(text) { nodes.get("message").textContent = text; },
      schedulePoll() {},
      state,
      validStatus(status) { return status; },
    },
  );
  renderStatus({ state: "downloading", modelId: "qwen3:0.6b" });
  nodes.get("message").textContent = "Action applied.";
  nodes.get("progress").hidden = false;
  renderStatus({ state: "model-ready", modelId: "qwen3:0.6b" });
  assert.equal(nodes.get("progress").hidden, true);
  assert.equal(nodes.get("message").textContent, nodes.get("installation-state").textContent);
});

test("setup fingerprint result reveals confirmation after rendering without stealing later focus", async () => {
  const script = await readFile("src/ui/app.js", "utf8");
  const focusStart = script.indexOf("function focusVisible(");
  const errorStart = script.indexOf("function showError(");
  const handlerStart = script.indexOf('element("fingerprint-button").addEventListener("click"');
  const source = [
    script.slice(focusStart, script.indexOf("\nfunction ", focusStart + 1)),
    script.slice(errorStart, script.indexOf("\nfunction ", errorStart + 1)),
    script.slice(handlerStart, script.indexOf('\nelement("fingerprint-confirm").addEventListener', handlerStart)),
  ].join("\n");

  for (const { failure = false, moved = false, stale = false } of [
    {}, { moved: true }, { failure: true }, { failure: true, moved: true },
    { stale: true }, { failure: true, stale: true },
  ]) {
    let onClick;
    let settle;
    const button = new FakeElement("button", { id: "fingerprint-button" });
    button.addEventListener = (_name, handler) => { onClick = handler; };
    const box = new FakeElement("div", { hidden: true });
    const confirm = Object.assign(new FakeElement("input"), { checked: true });
    const errorBox = new FakeElement("div", { hidden: true });
    const errorMessage = new FakeElement("span");
    const other = new FakeElement("button");
    const progress = new FakeElement("section");
    const document = { activeElement: button };
    for (const node of [button, box, confirm, errorBox, other, progress]) node.ownerDocument = document;
    const nodes = new Map([
      ["fingerprint-button", button],
      ["fingerprint-box", box],
      ["fingerprint-confirm", confirm],
      ["fingerprint-value", new FakeElement("code")],
      ["host", Object.assign(new FakeElement("input"), { checkValidity: () => true, value: "example.test" })],
      ["port", Object.assign(new FakeElement("input"), { checkValidity: () => true, value: "22" })],
      ["password", Object.assign(new FakeElement("input"), { value: "old" })],
      ["connect-button", new FakeElement("button")],
      ["global-error-recovery", new FakeElement("a", { hidden: true })],
    ]);
    const state = { fingerprint: null, operationBusy: false, operationOwner: 0 };
    runInNewContext(source, {
      clearError() {},
      clearFieldError() {},
      document,
      element(id) { return nodes.get(id); },
      errorBox,
      errorMessage,
      invalidateReviewedPlan() {},
      runOperation() {
        state.operationOwner++;
        document.activeElement = progress;
        return new Promise((resolve, reject) => {
          settle = () => {
            if (document.activeElement === progress && !stale) document.activeElement = button;
            if (failure) reject(new Error("scan failed"));
            else resolve({ fingerprint: "SHA256:checked" });
          };
        });
      },
      setCredentialInputsEnabled() {},
      markRejectedField: (text) => text,
      setMessage() {},
      state,
    });
    const pending = onClick({ currentTarget: button });
    if (moved) document.activeElement = other;
    if (stale) { state.operationOwner++; state.operationBusy = true; }
    settle();
    await pending;

    assert.equal(box.hidden, failure || stale);
    assert.equal(document.activeElement, stale ? progress : moved ? other : failure ? errorBox : confirm);
    assert.equal(Boolean(confirm.scrolledIntoView), !failure && !moved && !stale);
    if (!failure && !moved && !stale) assert.equal(confirm.scrolledIntoView.block, "start");
    assert.equal(errorBox.hidden, !failure || stale);
  }
});

test("Assistant fingerprint rescans require a fresh confirmation", async () => {
  const script = await readFile("src/ui/assistant.js", "utf8");
  const start = script.indexOf("function resetFingerprint()");
  const end = script.indexOf("\nfunction fillSelect", start);
  assert.ok(start >= 0 && end > start, "missing Assistant fingerprint helpers");

  const elements = new Map([
    ["connect-button", Object.assign(new FakeElement("button"), { disabled: false })],
    ["fingerprint-box", Object.assign(new FakeElement("div"), { hidden: false })],
    ["fingerprint-confirm", Object.assign(new FakeElement("input"), { checked: true })],
    ["fingerprint-value", new FakeElement("code", { textContent: "SHA256:old" })],
    ["password", Object.assign(new FakeElement("input"), { disabled: false, value: "secret" })],
    ["privileged-confirm", Object.assign(new FakeElement("input"), { checked: true })],
  ]);
  const state = { fingerprint: "SHA256:old" };
  let invalidations = 0;
  const helpers = runInNewContext(
    `${script.slice(start, end)}\n({ renderFingerprint });`,
    {
      element(id) {
        return elements.get(id);
      },
      invalidateReviewedPlan() {
        invalidations += 1;
      },
      state,
    },
    { filename: "assistant-fingerprint-rescan.vm.js", timeout: 1_000 },
  );

  helpers.renderFingerprint("SHA256:new");

  assert.equal(state.fingerprint, "SHA256:new");
  assert.equal(elements.get("fingerprint-value").textContent, "SHA256:new");
  assert.equal(elements.get("fingerprint-box").hidden, false);
  assert.equal(elements.get("fingerprint-confirm").checked, false);
  assert.equal(elements.get("password").value, "");
  assert.equal(elements.get("password").disabled, true);
  assert.equal(elements.get("connect-button").disabled, true);
  assert.equal(invalidations, 1);
});

test("reviewed plan IDs stay opaque, gate installation, and invalidate on edits", async () => {
  for (const wizard of WIZARDS) {
    const script = await readFile(wizard.script, "utf8");
    const start = script.indexOf("function validatePlanId(value)");
    const endMarker = wizard.allowOAuth
      ? "\nconst revertTimers"
      : "\nconst OPERATION_INTERACTIVE_SELECTOR";
    const end = script.indexOf(endMarker, start);
    assert.ok(start >= 0 && end > start, `missing plan helpers in ${wizard.script}`);

    const installConfirm = Object.assign(new FakeElement("input"), { checked: true });
    const installButton = Object.assign(new FakeElement("button"), { disabled: false });
    const state = {
      planId: "stale-plan",
      reviewedIncludeSearxng: true,
    };
    const helpers = runInNewContext(
      `${script.slice(start, end)}\n({ invalidateReviewedPlan, validatePlanId });`,
      {
        element(id) {
          return id === "install-confirm" ? installConfirm : installButton;
        },
        Error,
        state,
      },
      { filename: "vps-plan-id.vm.js", timeout: 1_000 },
    );
    const opaquePlanId = "opaque plan/with-symbols:+=";
    assert.equal(helpers.validatePlanId(opaquePlanId), opaquePlanId);
    assert.throws(() => helpers.validatePlanId(""), /unexpected plan reference/u);
    assert.throws(() => helpers.validatePlanId("bad\nplan"), /unexpected plan reference/u);

    helpers.invalidateReviewedPlan();
    assert.equal(state.planId, null);
    assert.equal(installConfirm.checked, false);
    assert.equal(installButton.disabled, true);
    if (!wizard.allowOAuth) assert.equal(state.reviewedIncludeSearxng, null);
  }
});

test("Assistant Back from Review withdraws the plan and its approval", async () => {
  const script = await readFile("src/ui/assistant.js", "utf8");
  const start = script.indexOf("function invalidateReviewedPlan()");
  const end = script.indexOf("\nconst OPERATION_INTERACTIVE_SELECTOR", start);
  const backStart = script.indexOf('for (const button of document.querySelectorAll(".back-button"))');
  const backEnd = script.indexOf("\ninitWizardTopbar(", backStart);
  assert.ok(start >= 0 && end > start && backStart >= 0 && backEnd > backStart);
  const state = { planId: "reviewed-plan", reviewedIncludeSearxng: true };
  const confirm = Object.assign(new FakeElement("input"), { checked: true });
  const install = Object.assign(new FakeElement("button"), { disabled: false });
  const back = Object.assign(new FakeElement("button"), {
    dataset: { back: "2" },
    addEventListener(name, handler) { if (name === "click") this.click = handler; },
  });
  let currentStep = 3;
  runInNewContext(`${script.slice(start, end)}\n${script.slice(backStart, backEnd)}`, {
    state,
    element(id) { return id === "install-confirm" ? confirm : install; },
    document: { querySelectorAll() { return [back]; } },
    clearError() {}, setMessage() {}, showStep(step) { currentStep = step; },
  });
  back.click();
  assert.equal(currentStep, 2);
  assert.equal(state.planId, null);
  assert.equal(state.reviewedIncludeSearxng, null);
  assert.equal(confirm.checked, false);
  assert.equal(install.disabled, true);
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { runInNewContext } from "node:vm";

const WIZARDS = [
  { allowOAuth: true, html: "src/ui/index.html", script: "src/ui/app.js" },
  { allowOAuth: false, html: "src/ui/assistant.html", script: "src/ui/assistant.js" },
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
  const start = script.indexOf("const OPERATION_INTERACTIVE_SELECTOR");
  const end = script.indexOf("\nfunction showStep(step)", start);
  assert.ok(start >= 0, "missing central operation helper marker");
  assert.ok(end > start, "missing central operation helper end marker");
  return script.slice(start, end);
}

function createHarness(script) {
  const elements = new Map();
  const body = new FakeElement("body");
  const mainContent = new FakeElement("main", { id: "main-content" });
  mainContent.setAttribute("aria-busy", "false");
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

  const activeButton = new FakeElement("button", {
    id: "review-button",
    textContent: "Review the exact plan",
  });
  const backButton = new FakeElement("button", {
    id: "back-button",
    textContent: "Back",
  });
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
    input,
    disabledSelect,
    navigation,
    loginLink,
    stopLogin,
    message,
    progress,
    mainContent,
  );

  for (const value of [mainContent, message, progress, label, elapsed, progressbar, note]) {
    elements.set(value.getAttribute("id"), value);
  }

  const controls = [
    activeButton,
    backButton,
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
    backButton,
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

test("both VPS wizards expose one accessible indeterminate elapsed progress region", async () => {
  for (const wizard of WIZARDS) {
    const html = await readFile(wizard.html, "utf8");
    const root = html.match(/<[^>]+id="operation-progress"[^>]*>/u)?.[0] ?? "";
    const progressbar = html.match(
      /<[^>]+id="operation-progress-bar"[^>]*>/u,
    )?.[0] ?? "";

    assert.equal((html.match(/id="operation-progress"/gu) ?? []).length, 1, wizard.html);
    assert.equal((html.match(/role="progressbar"/gu) ?? []).length, 1, wizard.html);
    assert.match(root, /class="operation-progress"/u);
    assert.match(root, /role="status"/u);
    assert.match(root, /aria-live="polite"/u);
    assert.match(root, /aria-atomic="false"/u);
    assert.match(root, /tabindex="-1"/u);
    assert.match(root, /hidden/u);
    assert.match(progressbar, /role="progressbar"/u);
    assert.doesNotMatch(progressbar, /aria-value(?:now|min|max)/u);
    assert.match(html, /id="operation-progress-elapsed"[^>]*datetime="PT0S"[^>]*>00:00</u);
    assert.match(html, /id="main-content"[^>]*aria-busy="false"/u);
    assert.doesNotMatch(html, /<body[^>]*aria-busy=/u);
    assert.match(
      html,
      /Timing varies with your (?:VPS|remote server) and network/u,
    );
    assert.doesNotMatch(html, /(?:\bETA\b|estimated time|\d+% complete)/iu);
  }
});

test("shared VPS lifecycle excludes overlap and locks slow operations", async () => {
  for (const wizard of WIZARDS) {
    const script = await readFile(wizard.script, "utf8");
    const harness = createHarness(script);
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
    assert.equal(harness.mainContent.getAttribute("aria-busy"), "true");
    assert.equal(harness.progress.hidden, false);
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
    assert.equal(harness.mainContent.getAttribute("aria-busy"), "false");
    assert.equal(harness.progress.hidden, true);
    assert.equal(harness.message.getAttribute("aria-live"), "polite");
    assert.equal(harness.backButton.disabled, false);
    assert.equal(harness.input.disabled, false);
    assert.equal(harness.input.readOnly, false);
    assert.equal(harness.disabledSelect.disabled, true, "business-disabled state is preserved");
    assert.equal(harness.navigation.getAttribute("aria-disabled"), null);
    assert.equal(harness.navigation.getAttribute("tabindex"), null);
    assert.equal(harness.document.activeElement, harness.activeButton);
    assert.deepEqual(harness.clearedIntervals, [1]);
    assert.equal(harness.observers[0].disconnected, true);
  }
});

test("VPS lifecycle restores success, failure, and replaced-button paths", async () => {
  for (const wizard of WIZARDS) {
    const script = await readFile(wizard.script, "utf8");
    const harness = createHarness(script);

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

    const replacementHarness = createHarness(script);
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

    const ownerHarness = createHarness(script);
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

    const startupHarness = createHarness(script);
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
    const harness = createHarness(script);
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
  assert.match(
    script,
    /fingerprint-button[\s\S]*?if \(!result\) return;\s*renderFingerprint\(result\.fingerprint\);/u,
  );
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

    assert.match(
      script,
      /const planId = validatePlanId\(plan\.planId\);[\s\S]{0,1000}state\.planId = planId;/u,
      `${wizard.script} stores only a validated returned plan ID`,
    );
    assert.match(
      script,
      /if \(!state\.planId \|\| !element\("install-confirm"\)\.checked\)/u,
      `${wizard.script} requires both a current plan and confirmation`,
    );
    assert.match(
      script,
      /planId:\s*state\.planId/u,
      `${wizard.script} binds installation to the reviewed plan`,
    );
    assert.match(
      script,
      /element\("fingerprint-button"\)[\s\S]{0,250}invalidateReviewedPlan\(\);/u,
    );
    assert.match(script, /element\("vps-form"\)[\s\S]{0,300}invalidateReviewedPlan\(\);/u);
    assert.match(script, /element\("container-select"\)[\s\S]{0,300}invalidateReviewedPlan\(\);/u);
    assert.match(script, /element\("network-select"\)[\s\S]{0,180}invalidateReviewedPlan\(\);/u);
  }

  const app = await readFile("src/ui/app.js", "utf8");
  assert.match(app, /input\[name="vps-integration"\][\s\S]{0,260}invalidateReviewedPlan\(\);/u);
  assert.match(app, /manage-vps-searxng[\s\S]{0,180}invalidateReviewedPlan\(\);/u);
  const assistant = await readFile("src/ui/assistant.js", "utf8");
  assert.match(assistant, /include-searxng[\s\S]{0,180}invalidateReviewedPlan\(\);/u);
});

test("every VPS long action routes through the page lifecycle", async () => {
  const app = await readFile("src/ui/app.js", "utf8");
  const assistant = await readFile("src/ui/assistant.js", "utf8");

  for (const script of [app, assistant]) {
    assert.match(script, /fingerprint-button[\s\S]*runOperation\(/u);
    assert.match(script, /vps-form[\s\S]*runOperation\(/u);
    assert.match(script, /container-select[\s\S]*runOperation\(/u);
    assert.match(script, /review-button[\s\S]*runOperation\(/u);
    assert.match(script, /install-button[\s\S]*runOperation\(/u);
    assert.doesNotMatch(script, /function setBusy\(/u);
  }

  assert.match(app, /login-button[\s\S]*runOperation\(/u);
  assert.match(app, /stop-login-button[\s\S]*runActiveOperationTask\(/u);
  assert.match(app, /refreshAuthStatus[\s\S]*runOperation\(/u);
  assert.ok((app.match(/runOperation\(/gu) ?? []).length >= 8);
  assert.ok((assistant.match(/runOperation\(/gu) ?? []).length >= 6);

  for (const path of [
    "/api/status",
    "/api/oauth/login",
    "/api/oauth/cancel",
    "/api/ssh/fingerprint",
    "/api/ssh/connect",
    "/api/discover",
    "/api/networks",
    "/api/plan",
    "/api/assistant/plan",
    "/api/install",
    "/api/assistant/install",
  ]) {
    assert.match(app, new RegExp(path.replaceAll("/", "\\/"), "u"));
  }
  for (const path of [
    "/api/ssh/fingerprint",
    "/api/ssh/connect",
    "/api/discover",
    "/api/networks",
    "/api/assistant/plan",
    "/api/assistant/install",
  ]) {
    assert.match(assistant, new RegExp(path.replaceAll("/", "\\/"), "u"));
  }
});

test("shared progress styling remains responsive and motion-safe", async () => {
  const css = await readFile("src/ui/styles.css", "utf8");
  assert.match(css, /\.operation-progress\s*\{/u);
  assert.match(css, /\.operation-progress__content\s*\{/u);
  assert.match(css, /\.operation-progress__track\s*\{/u);
  assert.match(css, /\.operation-progress__bar\s*\{/u);
  assert.match(css, /@keyframes operation-progress-indeterminate/u);
  assert.match(css, /@media \(max-width: 42rem\)[\s\S]*\.operation-progress__content/u);
  assert.match(
    css,
    /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.operation-progress__bar[\s\S]*animation:\s*none !important/u,
  );
});

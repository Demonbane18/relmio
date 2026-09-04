import { formatAuthUpdatedAt } from "./time.js";
import { prepareOAuthPopup } from "./oauth-popup.js";
import { bindWizardNavigation, readWizardSession } from "./session.js";

const token = readWizardSession();

const state = {
  step: 1,
  fingerprint: null,
  discovery: null,
  networks: null,
  installAttempted: false,
  planId: null,
  oauthAttemptId: null,
  oauthRetryBlocked: false,
  oauthLoginGeneration: 0,
  oauthLoginWindow: null,
  integrationKind: "sidecar",
  managingDetectedIntegration: false,
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
  oauthCancellationMessage: "",
};

const element = (id) => document.getElementById(id);
const localEndpointLink = element("local-endpoint-link");
bindWizardNavigation(localEndpointLink, "/local", token);
const messageToast = element("global-message");
const message = element("global-message-text");
const errorBox = element("global-error");
const errorMessage = element("global-error-text");
const toastTimers = new WeakMap();

function dismissToast(toast) {
  window.clearTimeout(toastTimers.get(toast));
  toast.hidden = true;
}

function resetFingerprint() {
  invalidateReviewedPlan();
  state.fingerprint = null;
  element("fingerprint-box").hidden = true;
  element("fingerprint-confirm").checked = false;
  element("password").value = "";
  element("password").disabled = true;
  element("connect-button").disabled = true;
}

function setMessage(text) {
  messageToast.hidden = false;
  message.textContent = text;
  window.clearTimeout(toastTimers.get(messageToast));
  toastTimers.set(
    messageToast,
    window.setTimeout(() => dismissToast(messageToast), 6_000),
  );
}

function showError(error) {
  errorMessage.textContent = error.message ?? "Something went wrong.";
  errorBox.hidden = false;
  errorBox.focus();
}

function clearError() {
  errorBox.hidden = true;
  errorMessage.textContent = "";
}

function validatePlanId(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 512 ||
    /[\0\r\n]/u.test(value)
  ) {
    throw new Error("The wizard returned an unexpected plan reference.");
  }
  return value;
}

function invalidateReviewedPlan() {
  state.planId = null;
  element("install-confirm").checked = false;
  element("install-button").disabled = true;
}

const revertTimers = new WeakMap();

function flashCopied(button) {
  if (!button.dataset.label) {
    button.dataset.label = button.getAttribute("aria-label");
  }
  button.setAttribute("aria-label", `${button.dataset.copyLabel} copied`);
  button.setAttribute("title", `${button.dataset.copyLabel} copied`);
  button.classList.add("copied");
  window.clearTimeout(revertTimers.get(button));
  revertTimers.set(
    button,
    window.setTimeout(() => {
      button.setAttribute("aria-label", button.dataset.label);
      button.setAttribute("title", button.dataset.label);
      button.classList.remove("copied");
    }, 1800),
  );
}

async function copyText(value) {
  const previouslyFocused = document.activeElement;
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.readOnly = true;
  textarea.setAttribute("aria-hidden", "true");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";

  let copied = false;
  try {
    document.body.append(textarea);
    textarea.focus();
    textarea.select();
    textarea.setSelectionRange?.(0, textarea.value.length);
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  } finally {
    textarea.remove();
    previouslyFocused?.focus?.();
  }

  if (copied) {
    return;
  }

  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch {
      // The generic error below avoids exposing copied configuration values.
    }
  }

  throw new Error("The browser refused clipboard access.");
}

function renderHttpRequestBody(model) {
  element("result-http-body").textContent = JSON.stringify(
    {
      model: model === "Not detected" ? "gpt-5.6-sol" : model,
      messages: [
        {
          role: "user",
          content: "What is a robot?",
        },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "answer",
          schema: {
            type: "object",
            properties: {
              content: { type: "string" },
            },
            required: ["content"],
            additionalProperties: false,
          },
          strict: true,
        },
      },
    },
    null,
    2,
  );
}

function copyCredentialSettings() {
  return [
    `Base URL: ${element("result-url").textContent}`,
    `API Key: ${element("result-key").textContent}`,
    "Organization ID: leave empty",
    "Add Custom Header: off",
  ].join("\n");
}

function copyHttpRecipe() {
  return [
    "Method: POST",
    `URL: ${element("result-http-url").textContent}`,
    "Authentication: Generic Credential Type",
    "Generic Auth Type: Bearer Auth",
    "Credential: openai-oauth",
    `Bearer token: ${element("result-key").textContent}`,
    `Authorization: ${element("result-http-auth").textContent}`,
    "Content-Type: application/json",
    "Send Headers: On",
    "Send Body: On",
    "Body Content Type: JSON",
    "Specify Body: Using JSON",
    "JSON body:",
    element("result-http-body").textContent,
  ].join("\n");
}

function copyValueFor(button) {
  if (button.dataset.copyTarget) {
    return element(button.dataset.copyTarget).textContent;
  }
  if (button.dataset.copyGroup === "credential") {
    return copyCredentialSettings();
  }
  if (button.dataset.copyGroup === "http") {
    return copyHttpRecipe();
  }
  return "";
}

function createCopyClickHandler({
  copyValueFor,
  clearError,
  copyText,
  flashCopied,
  setMessage,
  showError,
}) {
  return async function handleCopyClick(event) {
    const button = event.currentTarget;
    const label = button.dataset.copyLabel;
    const value = copyValueFor(button);
    clearError();
    try {
      if (!value) {
        throw new Error("No displayed value is available to copy.");
      }
      await copyText(value);
      flashCopied(button);
      setMessage(`${label} copied.`);
    } catch {
      showError(new Error(`Copy failed. Select the ${label} manually.`));
    }
  };
}

const handleCopyClick = createCopyClickHandler({
  copyValueFor,
  clearError,
  copyText,
  flashCopied,
  setMessage,
  showError,
});

bindWizardNavigation(element("setup-another-vps"), "/", token);

const delay = (milliseconds) =>
  new Promise((resolve) => window.setTimeout(resolve, milliseconds));

function validateAuthorizationUrl(value) {
  const url = new URL(value);
  if (
    url.origin !== "https://auth.openai.com" ||
    url.pathname !== "/oauth/authorize"
  ) {
    throw new Error("The wizard refused an unexpected sign-in destination.");
  }
  return url.toString();
}

function validateOAuthAttemptId(value) {
  if (typeof value !== "string" || !/^[0-9a-f-]{8,128}$/iu.test(value)) {
    throw new Error(
      "The wizard returned an unexpected sign-in attempt. Start again.",
    );
  }
  return value;
}

function setOAuthStopControlVisible(visible) {
  const stopButton = element("stop-login-button");
  if (!stopButton.dataset.label) {
    stopButton.dataset.label = stopButton.textContent.trim();
  }
  stopButton.hidden = !visible;
  stopButton.disabled = !visible;
  stopButton.setAttribute("aria-busy", "false");
  stopButton.textContent = stopButton.dataset.label;
}

function blockOAuthRetry() {
  state.oauthRetryBlocked = true;
  state.oauthAttemptId = null;
  state.oauthLoginWindow?.close?.();
  state.oauthLoginWindow = null;
  element("login-link").hidden = true;
  element("login-link").removeAttribute("href");
  setOAuthStopControlVisible(false);
  const loginButton = element("login-button");
  loginButton.disabled = true;
}

async function waitForOAuthCompletion(expectedAttemptId) {
  for (let attempt = 0; attempt < 330; attempt += 1) {
    const result = await api("/api/oauth/status");
    if (result.retryBlocked === true) {
      const error = new Error(
        result.error ??
          "ChatGPT sign-in could not be stopped safely. Close the sign-in helper, then restart Relmio.",
      );
      error.oauthRetryBlocked = true;
      throw error;
    }
    if (result.attemptId !== expectedAttemptId) {
      throw new Error(
        "The ChatGPT sign-in was replaced by a newer attempt. Start again.",
      );
    }
    if (result.status === "success") {
      return;
    }
    if (result.status === "error") {
      const error = new Error(
        result.error ?? "ChatGPT sign-in did not finish. Start again.",
      );
      error.oauthRetryBlocked = result.retryBlocked === true;
      throw error;
    }
    if (result.status === "cancelled") {
      throw new Error("ChatGPT sign-in was stopped. Start again.");
    }
    await delay(attempt < 40 ? 250 : 1_000);
  }
  throw new Error("The sign-in request expired. Start a fresh login.");
}

async function recoverPendingOAuthAttempt() {
  let loginGeneration = null;
  try {
    const recovery = await runOperation(
      null,
      "Checking for active ChatGPT sign-in…",
      async () => {
        const result = await api("/api/oauth/status");
        if (result.retryBlocked === true) {
          const error = new Error(
            result.error ??
              "ChatGPT sign-in could not be stopped safely. Close the sign-in helper, then restart Relmio.",
          );
          error.oauthRetryBlocked = true;
          throw error;
        }
        if (result.status !== "pending") {
          return { pending: false, status: null };
        }

        const attemptId = validateOAuthAttemptId(result.attemptId);
        loginGeneration = state.oauthLoginGeneration + 1;
        state.oauthLoginGeneration = loginGeneration;
        state.oauthAttemptId = attemptId;
        const loginLink = element("login-link");
        loginLink.hidden = true;
        loginLink.removeAttribute("href");
        setOAuthStopControlVisible(true);
        setMessage(
          "A ChatGPT sign-in is still in progress. Complete it in its existing browser tab, or stop it here.",
        );
        updateOperationLabel("Reconnecting to ChatGPT sign-in…");
        await waitForOAuthCompletion(attemptId);
        if (state.oauthLoginGeneration !== loginGeneration) {
          return { pending: true, status: null };
        }
        return {
          pending: true,
          status: await api("/api/status"),
        };
      },
      {
        allowedSelector: OPERATION_ALLOWED_SELECTOR,
        progressNote:
          "Relmio is checking for a server-owned ChatGPT sign-in attempt. If one is active, finish it in the existing browser tab or stop it here.",
      },
    );

    if (!recovery) return true;
    if (!recovery.pending) return false;
    if (
      recovery.status &&
      state.oauthLoginGeneration === loginGeneration
    ) {
      renderAuthStatus(recovery.status, { fresh: true });
    }
    return true;
  } catch (error) {
    if (
      loginGeneration === null ||
      state.oauthLoginGeneration === loginGeneration
    ) {
      if (error.oauthRetryBlocked === true) {
        blockOAuthRetry();
      }
      showError(error);
    }
    return true;
  } finally {
    if (
      loginGeneration !== null &&
      state.oauthLoginGeneration === loginGeneration
    ) {
      state.oauthAttemptId = null;
      state.oauthLoginWindow = null;
      setOAuthStopControlVisible(false);
      if (state.oauthRetryBlocked) {
        element("login-button").disabled = true;
      }
    }
    if (state.oauthCancellationMessage) {
      const cancellationMessage = state.oauthCancellationMessage;
      state.oauthCancellationMessage = "";
      setMessage(cancellationMessage);
    }
  }
}

async function initializeVpsWizard() {
  const recoveredOAuth = await recoverPendingOAuthAttempt();
  if (!recoveredOAuth) {
    await refreshAuthStatus();
  }
}

const OPERATION_INTERACTIVE_SELECTOR =
  'button, input, select, textarea, summary, a[href], [contenteditable]';
const OPERATION_ALLOWED_SELECTOR = "#login-link, #stop-login-button";
const OPERATION_BLOCKED_EVENTS = [
  "click",
  "pointerdown",
  "keydown",
  "beforeinput",
  "input",
  "change",
  "submit",
];
const OPERATION_DEFAULT_NOTE =
  "Timing varies with your VPS and network. Keep this page open. Relmio will unlock this setup when the current operation finishes or stops.";

function readOperationAttribute(control, name) {
  return typeof control.getAttribute === "function"
    ? control.getAttribute(name)
    : control.attributes?.get?.(name) ?? null;
}

function restoreOperationAttribute(control, name, value) {
  if (value === null) {
    if (typeof control.removeAttribute === "function") {
      control.removeAttribute(name);
    } else {
      control.attributes?.delete?.(name);
    }
    return;
  }
  control.setAttribute?.(name, value);
}

function isOperationAllowedControl(control) {
  return Boolean(
    state.operationAllowedSelector &&
    control?.closest?.(state.operationAllowedSelector),
  );
}

function operationControlCandidates() {
  return Array.from(
    document.querySelectorAll?.(OPERATION_INTERACTIVE_SELECTOR) ?? [],
  );
}

function lockOperationControl(control) {
  if (!control || isOperationAllowedControl(control)) return;
  const existingSnapshot = state.operationControlStates.find(
    (snapshot) => snapshot.control === control,
  );
  if (existingSnapshot) {
    if (existingSnapshot.disabled !== null && control.disabled !== true) {
      control.disabled = true;
    }
    if (existingSnapshot.readOnly !== null && control.readOnly !== true) {
      control.readOnly = true;
    }
    if (readOperationAttribute(control, "aria-disabled") !== "true") {
      control.setAttribute?.("aria-disabled", "true");
    }
    if (
      existingSnapshot.disabled === null &&
      readOperationAttribute(control, "tabindex") !== "-1"
    ) {
      control.setAttribute?.("tabindex", "-1");
    }
    if (
      existingSnapshot.contentEditable !== null &&
      readOperationAttribute(control, "contenteditable") !== "false"
    ) {
      control.setAttribute?.("contenteditable", "false");
    }
    return;
  }

  const snapshot = {
    control,
    disabled: typeof control.disabled === "boolean" ? control.disabled : null,
    readOnly: typeof control.readOnly === "boolean" ? control.readOnly : null,
    ariaDisabled: readOperationAttribute(control, "aria-disabled"),
    tabIndex: readOperationAttribute(control, "tabindex"),
    contentEditable: readOperationAttribute(control, "contenteditable"),
  };
  state.operationControlStates.push(snapshot);
  if (snapshot.disabled !== null) control.disabled = true;
  if (snapshot.readOnly !== null) control.readOnly = true;
  control.setAttribute?.("aria-disabled", "true");
  if (snapshot.disabled === null) control.setAttribute?.("tabindex", "-1");
  if (snapshot.contentEditable !== null) {
    control.setAttribute?.("contenteditable", "false");
  }
}

function lockAddedOperationControls(node) {
  if (!node || node.nodeType !== 1) return;
  if (node.matches?.(OPERATION_INTERACTIVE_SELECTOR)) {
    lockOperationControl(node);
  }
  for (const control of node.querySelectorAll?.(
    OPERATION_INTERACTIVE_SELECTOR,
  ) ?? []) {
    lockOperationControl(control);
  }
}

function formatOperationElapsed(elapsedSeconds) {
  const minutes = String(Math.floor(elapsedSeconds / 60)).padStart(2, "0");
  const seconds = String(elapsedSeconds % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function updateOperationProgress() {
  const elapsedSeconds = Math.max(
    0,
    Math.floor((Date.now() - state.operationProgressStartedAt) / 1_000),
  );
  const elapsed = formatOperationElapsed(elapsedSeconds);
  const elapsedElement = element("operation-progress-elapsed");
  elapsedElement.textContent = elapsed;
  elapsedElement.setAttribute("datetime", `PT${elapsedSeconds}S`);
}

function updateOperationLabel(label) {
  state.operationLabel = label || "Working…";
  element("operation-progress-label").textContent = state.operationLabel;
  element("operation-progress-bar").setAttribute(
    "aria-valuetext",
    state.operationLabel,
  );
  if (state.operationButton) {
    state.operationButton.textContent = state.operationLabel;
  }
  updateOperationProgress();
}

function startOperation(
  trigger,
  label,
  {
    allowedSelector = null,
    progressNote = OPERATION_DEFAULT_NOTE,
  } = {},
) {
  if (state.operationBusy) return false;

  state.operationBusy = true;
  state.operationAllowedSelector = allowedSelector;
  state.operationOwner += 1;
  state.operationFocusControl =
    trigger ??
    (document.activeElement && document.activeElement !== document.body
      ? document.activeElement
      : element("main-content"));
  state.operationButton = trigger?.tagName === "BUTTON" ? trigger : null;
  state.operationButtonLabel = state.operationButton?.textContent?.trim?.() ?? "";
  state.operationButtonAriaBusy = state.operationButton
    ? readOperationAttribute(state.operationButton, "aria-busy")
    : null;
  state.operationControlStates = [];
  state.operationLabel = label || "Working…";
  state.operationProgressStartedAt = Date.now();

  if (state.operationButton) {
    state.operationButton.setAttribute("aria-busy", "true");
    state.operationButton.textContent = state.operationLabel;
  }
  for (const control of operationControlCandidates()) {
    lockOperationControl(control);
  }

  document.body.dataset.operationBusy = "true";
  element("main-content").setAttribute("aria-busy", "true");
  const messageRegion = element("global-message");
  state.operationMessageLive = readOperationAttribute(
    messageRegion,
    "aria-live",
  );
  messageRegion.setAttribute("aria-live", "off");

  element("operation-progress-note").textContent = progressNote;
  const progress = element("operation-progress");
  progress.hidden = false;
  updateOperationLabel(state.operationLabel);
  progress.focus?.({ preventScroll: true });

  if (typeof MutationObserver !== "undefined" && document.body) {
    state.operationControlObserver = new MutationObserver((records) => {
      if (!state.operationBusy) return;
      for (const record of records) {
        if (record.type === "attributes") {
          lockAddedOperationControls(record.target);
        }
        for (const node of record.addedNodes ?? []) {
          lockAddedOperationControls(node);
        }
      }
    });
    state.operationControlObserver.observe(document.body, {
      attributeFilter: ["disabled", "readonly", "href", "contenteditable"],
      attributes: true,
      childList: true,
      subtree: true,
    });
  }

  state.operationProgressTimer = window.setInterval(
    updateOperationProgress,
    1_000,
  );
  return true;
}

function stopOperation(trigger, expectedOwner) {
  if (
    !state.operationBusy ||
    (expectedOwner !== undefined && expectedOwner !== state.operationOwner)
  ) {
    return false;
  }

  if (state.operationProgressTimer !== null) {
    window.clearInterval(state.operationProgressTimer);
  }
  state.operationProgressTimer = null;
  state.operationControlObserver?.disconnect?.();
  state.operationControlObserver = null;
  state.operationBusy = false;

  for (const snapshot of state.operationControlStates) {
    if (snapshot.disabled !== null) {
      snapshot.control.disabled = snapshot.disabled;
    }
    if (snapshot.readOnly !== null) {
      snapshot.control.readOnly = snapshot.readOnly;
    }
    restoreOperationAttribute(
      snapshot.control,
      "aria-disabled",
      snapshot.ariaDisabled,
    );
    restoreOperationAttribute(snapshot.control, "tabindex", snapshot.tabIndex);
    restoreOperationAttribute(
      snapshot.control,
      "contenteditable",
      snapshot.contentEditable,
    );
  }
  state.operationControlStates = [];

  document.body.dataset.operationBusy = "false";
  element("main-content").setAttribute("aria-busy", "false");
  restoreOperationAttribute(
    element("global-message"),
    "aria-live",
    state.operationMessageLive,
  );

  const progress = element("operation-progress");
  const restoreFocus =
    document.activeElement === progress ||
    progress.contains?.(document.activeElement) ||
    isOperationAllowedControl(document.activeElement);
  progress.hidden = true;
  element("operation-progress-label").textContent = "No operation is running.";
  const elapsedElement = element("operation-progress-elapsed");
  elapsedElement.textContent = "00:00";
  elapsedElement.setAttribute("datetime", "PT0S");
  element("operation-progress-bar").setAttribute(
    "aria-valuetext",
    "No operation is running.",
  );
  element("operation-progress-note").textContent = OPERATION_DEFAULT_NOTE;

  const activeButton = state.operationButton;
  if (activeButton) {
    restoreOperationAttribute(
      activeButton,
      "aria-busy",
      state.operationButtonAriaBusy,
    );
    activeButton.textContent = state.operationButtonLabel;
  }

  const focusControl = state.operationFocusControl ?? trigger ?? null;
  if (
    restoreFocus &&
    focusControl?.isConnected !== false &&
    !focusControl?.disabled &&
    !focusControl?.hidden &&
    !focusControl?.closest?.("[hidden]")
  ) {
    focusControl.focus?.({ preventScroll: true });
  }

  state.operationButton = null;
  state.operationAllowedSelector = null;
  state.operationButtonAriaBusy = null;
  state.operationButtonLabel = "";
  state.operationFocusControl = null;
  state.operationLabel = "";
  state.operationMessageLive = null;
  state.operationProgressStartedAt = 0;
  return true;
}

async function runOperation(trigger, label, work, options) {
  if (!startOperation(trigger, label, options)) return undefined;
  const operationOwner = state.operationOwner;
  try {
    return await work();
  } finally {
    stopOperation(trigger, operationOwner);
  }
}

async function runActiveOperationTask(button, label, work) {
  if (!state.operationBusy || !isOperationAllowedControl(button)) {
    return undefined;
  }
  const operationOwner = state.operationOwner;
  const previousLabel = state.operationLabel;
  const previousButtonLabel = button.textContent;
  const previousDisabled = button.disabled;
  const previousAriaBusy = readOperationAttribute(button, "aria-busy");
  updateOperationLabel(label);
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  button.textContent = label;
  try {
    return await work();
  } finally {
    button.disabled = previousDisabled;
    restoreOperationAttribute(button, "aria-busy", previousAriaBusy);
    button.textContent = previousButtonLabel;
    if (
      state.operationBusy &&
      state.operationOwner === operationOwner
    ) {
      updateOperationLabel(previousLabel);
    }
  }
}

function blockOperationInteraction(event) {
  if (
    !state.operationBusy ||
    event.target?.closest?.("#operation-progress") ||
    isOperationAllowedControl(event.target)
  ) {
    return;
  }
  event.preventDefault?.();
  event.stopImmediatePropagation?.();
}

for (const eventName of OPERATION_BLOCKED_EVENTS) {
  document.addEventListener(eventName, blockOperationInteraction, true);
}
function showStep(step) {
  state.step = step;
  document.body.dataset.currentStep = String(step);
  if (step === 5) {
    dismissToast(element("global-safety"));
    dismissToast(element("global-backup"));
  }
  for (const panel of document.querySelectorAll("[data-step]")) {
    const active = Number(panel.dataset.step) === step;
    panel.hidden = !active;
    if (active) {
      panel.querySelector("h2")?.focus({ preventScroll: true });
    }
  }
  for (const marker of document.querySelectorAll("[data-step-marker]")) {
    const markerStep = Number(marker.dataset.stepMarker);
    marker.classList.toggle("complete", markerStep < step);
    if (markerStep === step) {
      marker.setAttribute("aria-current", "step");
    } else {
      marker.removeAttribute("aria-current");
    }
  }
  window.scrollTo({ top: 0, behavior: "smooth" });
}

async function api(path, { method = "GET", body } = {}) {
  if (!token) {
    throw new Error(
      "This wizard link is incomplete. Close this tab. For a persistent install, run relmio open. For an NPX run, use npx --yes --ignore-scripts relmio@latest open. For a hosted foreground launcher, return to the active terminal and press Enter to create a fresh private handoff.",
    );
  }

  let response;
  try {
    response = await fetch(path, {
      method,
      headers: {
        "Content-Type": "application/json",
        "X-Setup-Token": token,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new Error(
      "The local wizard server is not reachable. For a persistent install, run relmio status, then relmio open. For NPX, use npx --yes --ignore-scripts relmio@latest status, then npx --yes --ignore-scripts relmio@latest open. For a hosted foreground launcher, keep its terminal open and restart that launcher if needed.",
    );
  }

  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error(
      "The wizard returned an unreadable response. Restart the setup command and try again.",
    );
  }
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error(
      "The wizard returned an unexpected response. Restart the setup command and try again.",
    );
  }
  if (!response.ok) {
    const error = new Error(result.error ?? "The request failed.");
    error.oauthRetryBlocked = result.retryBlocked === true;
    throw error;
  }
  return result;
}

function renderAuthUpdatedAt(value) {
  const row = element("auth-updated");
  const time = element("auth-updated-time");
  const formatted = formatAuthUpdatedAt(value);

  if (!formatted) {
    row.hidden = true;
    time.textContent = "";
    time.removeAttribute("datetime");
    return null;
  }

  time.textContent = formatted;
  time.setAttribute("datetime", value);
  row.hidden = false;
  return formatted;
}

function renderAuthStatus(status, { fresh = false } = {}) {
  const indicator = element("auth-indicator");
  const loginButton = element("login-button");
  const next = element("signin-next");
  const formattedUpdatedAt = renderAuthUpdatedAt(status.authUpdatedAt);

  if (status.previewMode) {
    indicator.classList.add("ready");
    element("auth-title").textContent = "Sanitized preview credential";
    element("auth-detail").textContent =
      "Preview mode uses sample data and cannot start a real ChatGPT sign-in.";
    loginButton.textContent = "Preview sign-in disabled";
    loginButton.dataset.label = "Preview sign-in disabled";
    loginButton.disabled = true;
    next.disabled = false;
    setMessage("Sanitized preview mode: no live ChatGPT sign-in will open.");
    return;
  }

  loginButton.disabled = false;
  if (status.authExists) {
    indicator.classList.add("ready");
    element("auth-title").textContent = fresh
      ? "Fresh credential saved"
      : "Local credential found";
    element("auth-detail").textContent =
      "Continue uses it as-is. Refresh the sign-in if it is expired or was created by another client.";
    loginButton.textContent = "Refresh ChatGPT sign-in";
    loginButton.dataset.label = "Refresh ChatGPT sign-in";
    next.disabled = false;
    setMessage(
      fresh && formattedUpdatedAt
        ? `Fresh sign-in saved at ${formattedUpdatedAt} (local time).`
        : "Local sign-in is ready.",
    );
  } else {
    indicator.classList.remove("ready");
    element("auth-title").textContent = "Sign-in needed";
    element("auth-detail").textContent =
      "A browser sign-in will open and wait for up to five minutes.";
    loginButton.textContent = "Sign in with ChatGPT";
    loginButton.dataset.label = "Sign in with ChatGPT";
    next.disabled = true;
    setMessage("Sign in with ChatGPT to continue.");
  }
}

async function refreshAuthStatus({ fresh = false } = {}) {
  clearError();
  const status = await runOperation(
    null,
    fresh ? "Checking the fresh sign-in…" : "Checking local sign-in…",
    () => api("/api/status"),
    {
      progressNote:
        "Relmio is checking the credential stored on this computer. Timing varies with this computer. Keep this page open until the check finishes.",
    },
  );
  if (!status) return false;
  renderAuthStatus(status, { fresh });
  return true;
}

function fillSelect(select, items, selectedValue) {
  select.replaceChildren();
  for (const item of items) {
    const option = document.createElement("option");
    option.value = item.value;
    option.textContent = item.label;
    option.selected = item.value === selectedValue;
    select.append(option);
  }
}

function replaceReviewItems(id, items) {
  element(id).replaceChildren(
    ...items.map((item) => {
      const listItem = document.createElement("li");
      listItem.textContent = item;
      return listItem;
    }),
  );
}

function isAssistantIntegration() {
  return state.integrationKind === "assistant";
}

function renderIntegrationManagement() {
  const assistant = isAssistantIntegration();
  element("manage-vps-searxng-row").hidden = !assistant;
  const manageButton = element("manage-vps-integration");
  manageButton.textContent = assistant
    ? "Manage Assistant companion"
    : "Manage OpenAI-OAuth/Codex bridge";
  const reviewButton = element("review-button");
  reviewButton.textContent = assistant
    ? "Review Assistant plan"
    : state.managingDetectedIntegration
      ? "Review bridge update"
      : "Review the exact plan";
  reviewButton.dataset.label = reviewButton.textContent;
}

function renderIntegrationReview(plan) {
  const assistant = isAssistantIntegration();
  element("review-intro").textContent = assistant
    ? "Only the separate Assistant companion can be changed. Your n8n container remains operator-managed."
    : "No existing n8n files or containers will be changed.";
  element("review-network").textContent = plan.networkName;
  element("review-endpoint-label").textContent = assistant
    ? "Assistant selection"
    : "Private hostname";
  element("review-endpoint").textContent = assistant
    ? plan.includeSearxng
      ? "Code Sandbox + private SearXNG"
      : "Code Sandbox"
    : plan.endpointHostname;
  replaceReviewItems(
    "review-will-list",
    assistant
      ? [
          "Build and start only Relmio-managed Code Sandbox companion services.",
          plan.includeSearxng
            ? "Add the optional private SearXNG JSON search companion."
            : "Keep SearXNG disabled; no web-search companion will be started.",
          `Attach the companion only to ${plan.networkName}.`,
          "Verify companion health without changing the existing n8n container.",
        ]
      : [
          "Create or update only /docker/n8n-openai-oauth.",
          "Build and start only the openai-oauth sidecar.",
          `Attach the sidecar to ${plan.networkName}.`,
          "Upload the refreshed ChatGPT OAuth file with owner-only permissions.",
        ],
  );
  replaceReviewItems(
    "review-wont-list",
    assistant
      ? [
          "Edit, exec into, rebuild, stop, restart, or recreate n8n.",
          "Publish a sandbox, runner, or SearXNG port.",
          "Configure model-provider credentials or apply n8n settings for you.",
          "Restart n8n after you apply any returned configuration.",
        ]
      : [
          "Edit or rebuild the n8n image.",
          "Stop, restart, or recreate n8n.",
          "Publish port 10531.",
          "Create a Traefik route.",
        ],
  );
  element("install-confirm-copy").textContent = assistant
    ? "I approve this private Assistant companion installation and understand that n8n configuration and any restart remain my separate action."
    : "I approve this sidecar-only installation and understand openai-oauth is an unofficial project.";
  const installButton = element("install-button");
  installButton.textContent = assistant
    ? "Install Assistant companion"
    : state.managingDetectedIntegration
      ? "Update the bridge"
      : "Install the sidecar";
  installButton.dataset.label = installButton.textContent;
}

const ASSISTANT_SANDBOX_IMAGE =
  "ghcr.io/n8n-io/n8n-sandbox-service-sandbox:1.1.0@sha256:16f62fb90a4ce61ef74925f62ea76bb11eb2a5598888b7c0651100c7944ed2d8";
const ASSISTANT_N8N_SETTINGS_NOTE =
  "Apply only the returned companion settings. Preserve the existing N8N_ENABLED_MODULES value and ensure it continues to include instance-ai.";

function validateAssistantUrl(value, label, prefix) {
  if (
    typeof value !== "string" ||
    !new RegExp(`^http://${prefix}-[a-f0-9]{32}:8080$`, "u").test(value)
  ) {
    throw new Error(`The wizard returned an invalid ${label}.`);
  }
  return value;
}

function validateAssistantSettings(value, expectedSettings) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("The wizard returned invalid n8n settings.");
  }
  const expectedNames = Object.keys(expectedSettings);
  if (
    Object.keys(value).length !== expectedNames.length ||
    expectedNames.some(
      (name) =>
        !Object.hasOwn(value, name) ||
        value[name] !== expectedSettings[name],
    )
  ) {
    throw new Error("The wizard returned invalid n8n settings.");
  }
  return expectedSettings;
}

function validateAssistantInstallResult(result) {
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("The wizard returned an invalid Assistant result.");
  }
  const sandboxUrl = validateAssistantUrl(
    result.sandboxUrl,
    "Code Sandbox URL",
    "relmio-ai-sandbox",
  );
  const includeSearxng = result.includeSearxng;
  const sandboxApiKey = result.sandboxApiKey;
  if (
    typeof includeSearxng !== "boolean" ||
    !["installed", "updated"].includes(result.deploymentMode) ||
    (sandboxApiKey !== null &&
      (typeof sandboxApiKey !== "string" ||
        !/^[A-Za-z0-9_-]{43}$/u.test(sandboxApiKey))) ||
    (result.deploymentMode === "installed" && sandboxApiKey === null)
  ) {
    throw new Error("The wizard returned an invalid Assistant result.");
  }
  const searxngUrl = includeSearxng
    ? validateAssistantUrl(
        result.searxngUrl,
        "SearXNG URL",
        "relmio-ai-searxng",
      )
    : null;
  if (!includeSearxng && Object.hasOwn(result, "searxngUrl")) {
    throw new Error("The wizard returned an invalid Assistant result.");
  }
  const expectedSettings = {
    N8N_INSTANCE_AI_SANDBOX_ENABLED: "true",
    N8N_INSTANCE_AI_SANDBOX_PROVIDER: "n8n-sandbox",
    N8N_INSTANCE_AI_SANDBOX_IMAGE: ASSISTANT_SANDBOX_IMAGE,
    N8N_SANDBOX_SERVICE_URL: sandboxUrl,
    ...(typeof sandboxApiKey === "string"
      ? { N8N_SANDBOX_SERVICE_API_KEY: sandboxApiKey }
      : {}),
    ...(searxngUrl ? { N8N_INSTANCE_AI_SEARXNG_URL: searxngUrl } : {}),
  };
  const n8nSettings = validateAssistantSettings(
    result.n8nSettings,
    expectedSettings,
  );
  return {
    includeSearxng,
    n8nSettings,
    sandboxApiKey: typeof sandboxApiKey === "string" ? sandboxApiKey : null,
    sandboxUrl,
    searxngUrl,
  };
}

function renderAssistantResult(result) {
  const assistant = validateAssistantInstallResult(result);
  element("assistant-result-sandbox-url").textContent = assistant.sandboxUrl;
  element("assistant-result-sandbox-key").textContent = assistant.sandboxApiKey ?? "";
  element("assistant-result-key-row").hidden = assistant.sandboxApiKey === null;
  element("assistant-result-searxng-row").hidden = !assistant.searxngUrl;
  element("assistant-result-searxng-url").textContent = assistant.searxngUrl ?? "";
  element("assistant-result-settings").textContent = Object.entries(assistant.n8nSettings)
    .map(([name, value]) => `${name}=${value}`)
    .join("\n");
  const keyNote = element("assistant-result-key-note");
  keyNote.hidden = false;
  keyNote.textContent = assistant.sandboxApiKey === null
    ? `This update intentionally does not return the existing sandbox API key. Keep the original key in your operator-controlled n8n configuration. ${ASSISTANT_N8N_SETTINGS_NOTE}`
    : `Save the shown-once API key before leaving this page. ${ASSISTANT_N8N_SETTINGS_NOTE}`;
  return assistant;
}

async function loadNetworks(
  containerName = element("container-select").value,
) {
  return api("/api/networks", {
    method: "POST",
    body: { containerName },
  });
}

function renderNetworks(result) {
  state.networks = result;
  fillSelect(
    element("network-select"),
    result.networks.map((network) => ({ value: network, label: network })),
    result.recommended,
  );
}

async function discover() {
  const discovery = await api("/api/discover", {
    method: "POST",
    body: {},
  });
  if (discovery.containers.length === 0) {
    throw new Error("No running official n8n container was found.");
  }
  const networks = await loadNetworks(discovery.containers[0].name);
  return { discovery, networks };
}

function renderDiscovery({ discovery, networks }) {
  state.discovery = discovery;
  element("docker-version").textContent = discovery.dockerVersion;
  element("compose-version").textContent = discovery.composeVersion;
  fillSelect(
    element("container-select"),
    discovery.containers.map((container) => ({
      value: container.name,
      label: `${container.name} - ${container.image}`,
    })),
    discovery.containers[0].name,
  );
  renderNetworks(networks);
  element("detected-vps-integration-management").hidden = false;
  renderIntegrationManagement();
  showStep(3);
}

element("login-button").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  if (state.oauthRetryBlocked) {
    return;
  }
  invalidateReviewedPlan();
  const loginLink = element("login-link");
  const loginGeneration = state.oauthLoginGeneration + 1;
  state.oauthLoginGeneration = loginGeneration;
  state.oauthAttemptId = null;
  const loginWindow = window.open("about:blank", "_blank");
  state.oauthLoginWindow = loginWindow;
  let loginWindowNavigated = false;
  prepareOAuthPopup(loginWindow);
  clearError();
  loginLink.hidden = true;
  loginLink.removeAttribute("href");
  setOAuthStopControlVisible(false);
  setMessage(
    "Preparing a fresh ChatGPT sign-in. The existing local credential will be replaced only after sign-in succeeds.",
  );
  try {
    const status = await runOperation(
      button,
      "Waiting for browser sign-in…",
      async () => {
        const result = await api("/api/oauth/login", {
          method: "POST",
          body: {},
        });
        const authorizationUrl = validateAuthorizationUrl(
          result.authorizationUrl,
        );
        const attemptId = validateOAuthAttemptId(result.attemptId);
        if (state.oauthLoginGeneration !== loginGeneration) {
          return undefined;
        }
        state.oauthAttemptId = attemptId;
        setOAuthStopControlVisible(true);
        loginLink.href = authorizationUrl;
        loginLink.hidden = false;
        if (loginWindow) {
          loginWindow.location.replace(authorizationUrl);
          loginWindowNavigated = true;
          loginWindow.opener = null;
        }
        await waitForOAuthCompletion(attemptId);
        if (state.oauthLoginGeneration !== loginGeneration) {
          return undefined;
        }
        return api("/api/status");
      },
      {
        allowedSelector: OPERATION_ALLOWED_SELECTOR,
        progressNote:
          "Finish the newly opened ChatGPT sign-in. This can take several minutes and no fixed finish time is promised. Keep this page open. Use the sign-in link or Stop control if needed.",
      },
    );
    if (!status || state.oauthLoginGeneration !== loginGeneration) {
      return;
    }
    loginLink.hidden = true;
    loginLink.removeAttribute("href");
    renderAuthStatus(status, { fresh: true });
  } catch (error) {
    if (loginWindow && !loginWindowNavigated) {
      loginWindow.close();
    }
    if (state.oauthLoginGeneration === loginGeneration) {
      if (error.oauthRetryBlocked === true) {
        blockOAuthRetry();
      }
      showError(error);
    }
  } finally {
    if (state.oauthLoginGeneration === loginGeneration) {
      state.oauthAttemptId = null;
      state.oauthLoginWindow = null;
      setOAuthStopControlVisible(false);
      if (state.oauthRetryBlocked) {
        button.disabled = true;
      }
    }
    if (state.oauthCancellationMessage) {
      const cancellationMessage = state.oauthCancellationMessage;
      state.oauthCancellationMessage = "";
      setMessage(cancellationMessage);
    }
  }
});

element("stop-login-button").addEventListener("click", async (event) => {
  const stopButton = event.currentTarget;
  const attemptId = state.oauthAttemptId;
  const loginGeneration = state.oauthLoginGeneration;
  if (typeof attemptId !== "string") {
    return;
  }
  clearError();
  try {
    const result = await runActiveOperationTask(
      stopButton,
      "Stopping sign-in…",
      () => api("/api/oauth/cancel", {
        method: "POST",
        body: { attemptId },
      }),
    );
    if (!result) return;
    if (
      state.oauthLoginGeneration !== loginGeneration ||
      result.attemptId !== attemptId ||
      result.status !== "cancelled"
    ) {
      return;
    }
    state.oauthLoginGeneration += 1;
    state.oauthAttemptId = null;
    state.oauthLoginWindow?.close?.();
    state.oauthLoginWindow = null;
    element("login-link").hidden = true;
    element("login-link").removeAttribute("href");
    setOAuthStopControlVisible(false);
    state.oauthCancellationMessage =
      "ChatGPT sign-in stopped. You can start again.";
    updateOperationLabel("Finishing the stopped sign-in…");
  } catch (error) {
    if (state.oauthLoginGeneration === loginGeneration) {
      if (error.oauthRetryBlocked === true) {
        state.oauthLoginGeneration += 1;
        blockOAuthRetry();
      }
      showError(error);
    }
  }
});

element("signin-next").addEventListener("click", () => {
  clearError();
  showStep(2);
  setMessage("Enter the VPS address exactly as Hostinger shows it.");
});

element("fingerprint-button").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  clearError();
  invalidateReviewedPlan();
  try {
    const result = await runOperation(
      button,
      "Checking server identity…",
      () => api("/api/ssh/fingerprint", {
        method: "POST",
        body: {
          host: element("host").value,
          port: element("port").value,
        },
      }),
    );
    if (!result) return;
    state.fingerprint = result.fingerprint;
    element("fingerprint-value").textContent = result.fingerprint;
    element("fingerprint-box").hidden = false;
    element("fingerprint-confirm").checked = false;
    element("password").value = "";
    element("password").disabled = true;
    element("connect-button").disabled = true;
    setMessage("Confirm the VPS identity before sending a password.");
  } catch (error) {
    showError(error);
  }
});

element("fingerprint-confirm").addEventListener("change", (event) => {
  invalidateReviewedPlan();
  const confirmed = event.currentTarget.checked;
  element("password").disabled = !confirmed;
  element("connect-button").disabled = !confirmed;
  if (confirmed) {
    element("password").focus();
  } else {
    element("password").value = "";
  }
});

element("host").addEventListener("input", resetFingerprint);
element("port").addEventListener("input", resetFingerprint);
element("username").addEventListener("input", invalidateReviewedPlan);
element("password").addEventListener("input", invalidateReviewedPlan);

element("vps-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = element("connect-button");
  clearError();
  invalidateReviewedPlan();
  setMessage("Connecting, then inspecting Docker with read-only commands…");
  try {
    const discovered = await runOperation(
      button,
      "Connecting and inspecting Docker…",
      async () => {
        await api("/api/ssh/connect", {
          method: "POST",
          body: {
            host: element("host").value,
            port: element("port").value,
            username: element("username").value,
            password: element("password").value,
            expectedFingerprint: state.fingerprint,
          },
        });
        return discover();
      },
      {
        progressNote:
          "Relmio is opening the verified SSH connection and inspecting Docker with read-only commands. Timing varies with your VPS and network. Keep this page open.",
      },
    );
    if (!discovered) return;
    element("password").value = "";
    renderDiscovery(discovered);
    setMessage(
      "n8n was found. Choose its network, then install or manage a Relmio-owned companion.",
    );
  } catch (error) {
    element("password").value = "";
    showError(error);
  }
});

async function disconnectVpsSession() {
  const result = await api("/api/disconnect", {
    method: "POST",
    body: {},
  });
  if (
    !result ||
    typeof result !== "object" ||
    Array.isArray(result) ||
    Object.keys(result).length !== 1 ||
    result.disconnected !== true
  ) {
    throw new Error("The wizard returned an unexpected disconnect response.");
  }
  invalidateReviewedPlan();
  state.discovery = null;
  state.networks = null;
  resetFingerprint();
  element("container-select").replaceChildren();
  element("network-select").replaceChildren();
  element("detected-vps-integration-management").hidden = true;
  return result;
}

element("disconnect-vps-button").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  clearError();
  try {
    const result = await runOperation(
      button,
      "Disconnecting from VPS…",
      disconnectVpsSession,
    );
    if (!result) return;
    showStep(2);
    setMessage(
      "Disconnected from the VPS. Check its identity again before reconnecting.",
    );
  } catch (error) {
    showError(error);
  }
});

element("container-select").addEventListener("change", async (event) => {
  const select = event.currentTarget;
  const containerName = select.value;
  clearError();
  invalidateReviewedPlan();
  try {
    const networks = await runOperation(
      select,
      "Refreshing Docker networks…",
      () => loadNetworks(containerName),
    );
    if (!networks) return;
    renderNetworks(networks);
    setMessage("Docker networks refreshed for the selected n8n container.");
  } catch (error) {
    element("install-confirm").checked = false;
    element("install-button").disabled = true;
    showStep(2);
    setMessage(
      "The install stopped and the VPS connection was closed. Reconnect to inspect the sidecar before retrying.",
    );
    showError(error);
  }
});

element("review-button").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  clearError();
  invalidateReviewedPlan();
  try {
    const networkName = element("network-select").value;
    const assistant = isAssistantIntegration();
    const plan = await runOperation(
      button,
      "Preparing the exact plan…",
      () => api(assistant ? "/api/assistant/plan" : "/api/plan", {
        method: "POST",
        body: {
          containerName: element("container-select").value,
          networkName,
          ...(assistant
            ? { includeSearxng: element("manage-vps-searxng").checked }
            : {}),
        },
      }),
    );
    if (!plan) return;
    const planId = validatePlanId(plan.planId);
    renderIntegrationReview(plan);
    state.planId = planId;
    element("install-confirm").checked = false;
    element("install-button").disabled = true;
    showStep(4);
    setMessage("Review the plan. The VPS has not been changed.");
  } catch (error) {
    showError(error);
  }
});

element("network-select").addEventListener("change", () => {
  invalidateReviewedPlan();
  setMessage("Network changed. Review a fresh plan before installing.");
});

element("install-confirm").addEventListener("change", (event) => {
  element("install-button").disabled = !(
    event.currentTarget.checked && state.planId
  );
});

element("install-button").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  clearError();
  const assistant = isAssistantIntegration();
  if (!state.planId || !element("install-confirm").checked) {
    invalidateReviewedPlan();
    showError(new Error("Review and confirm a fresh plan first."));
    return;
  }
  setMessage(
    assistant
      ? "Installing only the separate Assistant companion. This can take several minutes."
      : "Installing only the separate OAuth sidecar. This can take several minutes.",
  );
  state.installAttempted = true;
  try {
    const result = await runOperation(
      button,
      assistant ? "Building the companion…" : "Building the sidecar…",
      () => api(assistant ? "/api/assistant/install" : "/api/install", {
        method: "POST",
        body: {
          containerName: element("container-select").value,
          networkName: element("network-select").value,
          confirmed: element("install-confirm").checked,
          planId: state.planId,
          ...(assistant
            ? { includeSearxng: element("manage-vps-searxng").checked }
            : {}),
        },
      }),
      {
        progressNote:
          "Docker may be downloading images, building, or starting the reviewed companion. Timing varies with your VPS and network. Keep this page open until verification finishes.",
      },
    );
    if (!result) return;
    invalidateReviewedPlan();
    if (!assistant) {
      element("result-url").textContent = result.baseUrl;
      element("result-key").textContent = result.apiKeyPlaceholder;
      const firstModel = result.models[0] ?? "Not detected";
      element("result-model").textContent = firstModel;
      element("result-models").textContent = result.models.join(", ");
      element("result-http-url").textContent =
        `${result.baseUrl.replace(/\/$/u, "")}/chat/completions`;
      renderHttpRequestBody(firstModel);
    }
    const assistantResult = assistant ? renderAssistantResult(result) : null;
    element("done-title").textContent = assistant
      ? "The private Assistant companion is ready"
      : "The private bridge is ready";
    element("done-detail").textContent = assistant
      ? assistantResult.includeSearxng
        ? `Code Sandbox and private SearXNG were verified. ${ASSISTANT_N8N_SETTINGS_NOTE} Relmio did not restart n8n.`
        : `Code Sandbox was verified without SearXNG. ${ASSISTANT_N8N_SETTINGS_NOTE} Relmio did not restart n8n.`
      : "Use these values in n8n on the same private Docker network.";
    element("assistant-result").hidden = !assistant;
    element("sidecar-ready-content").hidden = assistant;
    element("assistant-result-detail").textContent = assistant
      ? assistantResult.includeSearxng
        ? `Code Sandbox and the optional private SearXNG companion were verified. ${ASSISTANT_N8N_SETTINGS_NOTE}`
        : `Code Sandbox was verified without SearXNG. ${ASSISTANT_N8N_SETTINGS_NOTE}`
      : "";
    showStep(5);
    setMessage(
      assistant
        ? "Assistant companion verified. Your existing n8n was not restarted."
        : result.deploymentMode === "updated"
        ? "OAuth refreshed on the existing wizard-managed sidecar. n8n was not restarted."
        : "Installation verified. Your existing n8n was not restarted.",
    );
  } catch (error) {
    invalidateReviewedPlan();
    showError(error);
  }
});

for (const input of document.querySelectorAll('input[name="vps-integration"]')) {
  input.addEventListener("change", (event) => {
    invalidateReviewedPlan();
    state.integrationKind = event.currentTarget.value;
    state.managingDetectedIntegration = true;
    renderIntegrationManagement();
  });
}

element("manage-vps-searxng").addEventListener("change", () => {
  invalidateReviewedPlan();
  setMessage("Assistant options changed. Review a fresh plan before installing.");
});

element("manage-vps-integration").addEventListener("click", () => {
  clearError();
  state.managingDetectedIntegration = true;
  renderIntegrationManagement();
  setMessage(
    isAssistantIntegration()
      ? "Review a private Assistant companion plan. SearXNG remains opt-in and n8n stays untouched."
      : "Review a private bridge update. Refresh ChatGPT sign-in first if its session needs replacement.",
  );
});

element("refresh-vps-chatgpt").addEventListener("click", () => {
  clearError();
  state.integrationKind = "sidecar";
  state.managingDetectedIntegration = true;
  element("manage-vps-sidecar").checked = true;
  renderIntegrationManagement();
  element("login-button").click();
});

for (const button of document.querySelectorAll(
  "[data-copy-target], [data-copy-group]",
)) {
  button.addEventListener("click", handleCopyClick);
}

for (const button of document.querySelectorAll("[data-dismiss-toast]")) {
  button.addEventListener("click", (event) => {
    dismissToast(element(event.currentTarget.dataset.dismissToast));
  });
}

for (const button of document.querySelectorAll(".back-button")) {
  button.addEventListener("click", () => {
    clearError();
    showStep(Number(button.dataset.back));
    setMessage(
      state.installAttempted
        ? "The install was attempted. Reconnect to inspect the sidecar; n8n was not restarted."
        : "No VPS changes have been made.",
    );
  });
}

renderHttpRequestBody(element("result-model").textContent);
initializeVpsWizard().catch(showError);

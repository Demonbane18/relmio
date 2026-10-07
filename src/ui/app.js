import { accountUiState, createSiwcControls, createSiwcRecovery, normalizeSiwcAccount, siwcErrorFromResponse, siwcErrorText } from "./siwc-controls.js";
import { bindWizardNavigation, readWizardSession } from "./session.js";
import { bindSshAuthentication, clearFieldError, createCredentialSshGuard, markRejectedField, sameSshIdentity } from "./ssh-form.js";
import { initWizardTopbar } from "./topbar.js";

const token = readWizardSession();

const state = {
  step: 1,
  fingerprint: null,
  discovery: null,
  networks: null,
  installAttempted: false,
  planId: null,
  reviewedIdentity: null,
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
  loginIntent: { purpose: "sign-in" },
  catalogLabels: new Map(),
  vpsOwner: null,
  vpsOwnerUpdate: null,
  vpsImagesGeneration: 0,
  vpsImagesTimer: null,
  vpsImages: null,
  vpsModels: null,
  vpsUsage: null,
  vpsUsageError: null,
  planMigrationRequired: false,
  planReplacementRequired: false,
  vpsReconnectRequired: false,
};

const element = (id) => document.getElementById(id);
const localEndpointLink = element("local-endpoint-link");
bindWizardNavigation(localEndpointLink, "/local", token);
bindWizardNavigation(element("vps-supergrok-start"), "/supergrok-vps", token);
bindWizardNavigation(element("vps-supergrok-manage"), "/supergrok-vps", token);
bindWizardNavigation(element("vps-local-model-start"), "/local-model-vps", token);
bindWizardNavigation(element("vps-local-model-manage"), "/local-model-vps", token);
bindWizardNavigation(element("hosting-options-link"), "/hosting", token);
const messageToast = element("global-message");
const message = element("global-message-text");
const errorBox = element("global-error");
const errorMessage = element("global-error-text");
const toastTimers = new WeakMap();
let sshIdentityDecision = 0;
const sshAuthentication = bindSshAuthentication({ token, trustId: "fingerprint-confirm", onChange: handleVpsConnectionInput, shouldApplyConnectionStatus: () => sshIdentityDecision === 0 });
const sshSession = createCredentialSshGuard({ token, onIdentityDecision() { sshIdentityDecision++; }, onMismatch() {
  invalidateReviewedPlan();
  clearEndedVpsConnectionState();
  showStep(2);
} });
setCredentialInputsEnabled(false);
initWizardTopbar({
  session: token,
  isBusy: () => state.operationBusy,
  loadProjectMeta: () => api("/api/local/project-meta"),
});

function focusVisible(target) {
  target.focus({ preventScroll: true });
  target.scrollIntoView?.({ block: "start", behavior: "instant" });
}

function selectChatGptSetup({ focus = true } = {}) {
  element("setup-choices").hidden = true;
  element("chatgpt-setup").hidden = false;
  element("signin-title").textContent = "Sign in with ChatGPT";
  element("openai-vps-route").setAttribute("aria-expanded", "true");
  element("global-message").hidden = true;
  if (state.step !== 1) showStep(1);
  if (focus) focusVisible(element("signin-title"));
  // The first account load runs while this view is hidden; show a due plan welcome now.
  siwc.showWelcome();
}

element("openai-vps-route").addEventListener("click", () => {
  if (state.operationBusy || state.step !== 1) return;
  clearError();
  selectChatGptSetup();
});

element("change-setup-button").addEventListener("click", () => {
  if (state.operationBusy || state.step !== 1) return;
  clearError();
  element("chatgpt-setup").hidden = true;
  element("setup-choices").hidden = false;
  element("signin-title").textContent = "Choose your setup";
  element("openai-vps-route").setAttribute("aria-expanded", "false");
  focusVisible(element("openai-vps-route"));
});

function dismissToast(toast) {
  window.clearTimeout(toastTimers.get(toast));
  toast.hidden = true;
}
function setCredentialInputsEnabled(enabled) {
  element("username").disabled = !enabled;
  element("ssh-authentication").disabled = !enabled;
}


function resetFingerprint() {
  invalidateReviewedPlan();
  clearVpsFingerprintReview();
  setCredentialInputsEnabled(false);
}

function clearVpsFingerprintReview() {
  state.vpsReconnectRequired = true;
  state.fingerprint = null;
  element("fingerprint-box").hidden = true;
  element("fingerprint-confirm").checked = false;
  element("password").value = "";
  element("password").disabled = true;
  element("connect-button").disabled = true;
  element("connect-button").textContent = "Connect";
}

function handleVpsConnectionInput() {
  invalidateReviewedPlan();
  if (!sshSession.adoptedIdentity()) return;
  if (!state.vpsReconnectRequired) clearVpsFingerprintReview();
  setMessage("Connection details changed. Check and confirm the server identity again before reconnecting.");
}

function handleVpsDestinationInput() {
  resetFingerprint();
  if (sshSession.adoptedIdentity()) setMessage(
    "Connection details changed. Check and confirm the server identity again before reconnecting.");
}

function vpsConnectionMatchesForm(identity) {
  return identity.host === element("host").value &&
    identity.port === Number(element("port").value) &&
    identity.username === element("username").value &&
    identity.authentication === element("ssh-authentication").value;
}

function syncVpsConnectAction() {
  const identity = sshSession.adoptedIdentity();
  const retry = identity && !state.vpsReconnectRequired && vpsConnectionMatchesForm(identity);
  const button = element("connect-button");
  button.textContent = retry ? "Retry discovery" : "Connect";
  button.disabled = !retry && !(state.fingerprint && element("fingerprint-confirm").checked);
  if (retry) {
    element("password").value = "";
    element("password").disabled = true;
    element("password").required = false;
  }
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

function showError(error, { focus = true } = {}) {
  const text = markRejectedField(error.message ?? "Something went wrong.", element, "global-error-text");
  errorMessage.textContent = error.recovery && error.recovery !== "none" ? siwcErrorText(error) : text;
  element("global-error-recovery").hidden = error.recovery !== "manage-usage";
  errorBox.hidden = false;
  if (focus) focusVisible(errorBox);
  globalThis.relmioGuide?.error?.(error);
}

function clearError() {
  errorBox.hidden = true;
  errorMessage.textContent = "";
  element("global-error-recovery").hidden = true;
  globalThis.relmioGuide?.clearError?.();
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
  state.reviewedIdentity = null;
  element("install-confirm").checked = false;
  element("background-consent").checked = false;
  state.planMigrationRequired = false;
  state.planReplacementRequired = false;
  element("vps-migration-row").hidden = true;
  element("vps-replacement-row").hidden = true;
  element("vps-migration-consent").checked = false;
  element("vps-replacement-consent").checked = false;
  element("install-button").disabled = true;
}

const revertTimers = new WeakMap();

// Shows a check on the button for a moment. The accessible name never changes;
// the result is announced through the polite status message.
function flashCopied(button) {
  button.classList.add("copied");
  window.clearTimeout(revertTimers.get(button));
  revertTimers.set(button, window.setTimeout(() => button.classList.remove("copied"), 1800));
}

async function copyText(value) {
  try {
    await navigator.clipboard.writeText(value);
    return;
  } catch {
    // Fall back to copying a selection. Focus stays on the copy button.
  }
  const source = document.createElement("pre");
  source.textContent = value;
  source.setAttribute("aria-hidden", "true");
  source.style.position = "fixed";
  source.style.insetInlineStart = "-200vw";
  const selection = document.getSelection();
  const saved = selection.rangeCount ? selection.getRangeAt(0) : null;
  let copied = false;
  try {
    document.body.append(source);
    selection.selectAllChildren(source);
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  } finally {
    source.remove();
    selection.removeAllRanges();
    if (saved) selection.addRange(saved);
  }
  // The generic error avoids exposing copied configuration values.
  if (!copied) throw new Error("The browser refused clipboard access.");
}

function renderHttpRequestBody(model) {
  element("result-http-body").textContent = model
    ? JSON.stringify({
        model,
        messages: [{ role: "user", content: "What is a robot?" }],
      }, null, 2)
    : "";
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
    "Credential: Relmio sidecar",
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
  if (!visible && document.activeElement === stopButton) {
    const progress = element("operation-progress");
    if (!progress.hidden) focusVisible(progress);
  }
  stopButton.hidden = !visible;
  stopButton.disabled = !visible;
  stopButton.setAttribute("aria-busy", "false");
  stopButton.textContent = stopButton.dataset.label;
}
function finishOAuthCancellation() {
  if (!state.oauthCancellationMessage) return;
  const cancellationMessage = state.oauthCancellationMessage;
  state.oauthCancellationMessage = "";
  setMessage(cancellationMessage);
  const retry = element("login-button");
  if (!state.operationBusy && !state.oauthRetryBlocked && !retry.disabled && errorBox.hidden) {
    focusVisible(retry);
  }
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
      const error = siwcErrorFromResponse(result, result.upstreamStatus ?? 409);
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
      const error = siwcErrorFromResponse(result, result.upstreamStatus ?? 400);
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
        selectChatGptSetup({ focus: false });
        const loginLink = element("login-link");
        loginLink.hidden = true;
        loginLink.removeAttribute("href");
        setOAuthStopControlVisible(true);
        updateOperationLabel("Reconnecting to ChatGPT sign-in…");
        await waitForOAuthCompletion(attemptId);
        if (state.oauthLoginGeneration !== loginGeneration) {
          return { pending: true, status: null };
        }
        return {
          pending: true,
          status: await siwc.authorized({ purpose: "sign-in" }),
        };
      },
      {
        allowedSelector: OPERATION_ALLOWED_SELECTOR,
        progressNote:
          "Relmio is checking for a ChatGPT sign-in that is still running. If one is active, finish it in its existing browser tab or stop it here.",
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
      if (loginGeneration !== null || error.oauthRetryBlocked === true) {
        selectChatGptSetup({ focus: false });
      }
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
    finishOAuthCancellation();
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
  "Timing varies with your remote server and network. Keep this page open until this step finishes.";

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
  element("setup-steps").setAttribute("aria-busy", "true");
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
  focusVisible(progress);

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
  updateStepNavigation();
  const trusted = Boolean(state.step !== 5 && state.fingerprint && element("fingerprint-confirm").checked);
  sshAuthentication.sync({ trusted });
  setCredentialInputsEnabled(trusted);

  document.body.dataset.operationBusy = "false";
  element("setup-steps").setAttribute("aria-busy", "false");
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
    focusVisible(focusControl);
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
    // Tab and Shift+Tab still move focus; activation and input stay blocked.
    (event.type === "keydown" && event.key === "Tab") ||
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
const STEP_LABELS = ["Choose setup", "Check server", "Choose n8n", "Review", "Ready"];

function updateStepNavigation() {
  element("setup-progress-label").textContent = `Step ${state.step} of 5 · ${STEP_LABELS[state.step - 1]}`;
  for (const button of document.querySelectorAll("[data-step-target]")) {
    const target = Number(button.dataset.stepTarget);
    button.disabled = state.operationBusy || state.step === 5 || !Number.isInteger(target) || target < 1 || target >= state.step;
  }
}

function showStep(step) {
  state.step = step;
  document.body.dataset.currentStep = String(step);
  if (step === 5) dismissToast(element("global-safety"));
  let heading = null;
  for (const panel of document.querySelectorAll("[data-step]")) {
    const active = Number(panel.dataset.step) === step;
    panel.hidden = !active;
    if (active) {
      panel.scrollTop = 0;
      heading = panel.querySelector("h2");
    }
  }
  for (const marker of document.querySelectorAll("[data-step-marker]")) {
    const markerStep = Number(marker.dataset.stepMarker);
    if (markerStep < step) marker.setAttribute("data-state", "done");
    else marker.removeAttribute("data-state");
    if (markerStep === step) marker.setAttribute("aria-current", "step");
    else marker.removeAttribute("aria-current");
  }
  updateStepNavigation();
  if (heading) focusVisible(heading);
}

document.querySelector(".rm-skip-link")?.addEventListener("click", (event) => {
  event.preventDefault();
  const heading = document.querySelector("[data-step]:not([hidden]) h2");
  if (heading) focusVisible(heading);
});

function goToEarlierStep(target) {
  if (state.operationBusy || state.step === 5 || !Number.isInteger(target) || target < 1 || target >= state.step) return;
  clearError();
  invalidateReviewedPlan();
  showStep(target);
  setMessage(state.installAttempted
    ? "The install was attempted. Reconnect to inspect the sidecar; n8n was not restarted."
    : "No VPS changes have been made.");
}


async function api(path, { method = "GET", body } = {}) {
  if (!token) {
    throw new Error(
      "This wizard link is incomplete. Close this tab. For a persistent install, run relmio open. For an NPX run, use npx --yes --ignore-scripts relmio@latest open. For a hosted foreground launcher, return to the active terminal and press Enter to create a fresh private handoff.",
    );
  }
  if (path.startsWith("/api/siwc/vps/")) await sshSession.adoptCurrent();
  else await sshSession.before(path);

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
    const error = siwcErrorFromResponse(result, response.status);
    error.oauthRetryBlocked = result.retryBlocked === true;
    throw error;
  }
  if (path === "/api/siwc/vps/status") await sshSession.adoptCurrent();
  else await sshSession.after(path, result);
  return result;
}

function resetVpsOwner() {
  state.vpsOwner = null;
  element("vps-owner-actions").hidden = true;
  element("vps-owner-inspect-row").hidden = true;
  element("vps-owner-inspect").hidden = true;
  element("vps-owner-replace").hidden = true;
  element("vps-owner-confirm").checked = false;
  element("vps-owner-background-confirm").checked = false;
  renderVpsOwnerUpdate(null);
  element("vps-owner-status").textContent = "Choose the n8n container and network, then check the installed account.";
}

const siwc = createSiwcControls({
  root: element("vps-siwc"),
  api,
  onChange(account) {
    invalidateReviewedPlan();
    state.catalogLabels.clear();
    resetVpsOwner();
    renderAuthStatus(account);
  },
  onLogin(intent) {
    if (state.operationBusy) return;
    state.loginIntent = intent;
    element("login-button").click();
  },
  onError: showError,
});
element("vps-siwc").querySelector('[data-siwc="recover"]').addEventListener("click", () => {
  if (state.operationBusy) return;
  showStep(2);
  setMessage("Verify the destination server, then open recovery beside its installed account controls.");
});

function renderAuthStatus(account, { fresh = false } = {}) {
  const mode = accountUiState(account);
  const welcomePending = mode === "plan-active" && account.needsPlanWelcome === true;
  const usageLimited = siwc.isUsageLimited();
  const ready = mode === "plan-active" && !welcomePending && !usageLimited;
  const indicator = element("auth-indicator");
  indicator.classList.toggle("ready", ready);
  element("auth-updated").hidden = true;
  element("auth-title").textContent = ready
    ? fresh ? "ChatGPT plan use enabled" : "ChatGPT plan ready"
    : usageLimited ? "ChatGPT usage limit reached"
      : welcomePending ? "Review the plan notice"
        : mode === "identity-only" ? "Connected for identity"
          : mode === "plan-paused" ? "Plan use paused"
            : mode === "transferred" ? "Owned by the installation"
              : mode === "handoff-pending" ? "Transfer needs review"
                : mode === "reauthorize" ? "Sign in again"
                  : "ChatGPT sign-in needed";
  element("auth-detail").textContent = siwc.isPreview()
    ? "Sanitized preview data. Live ChatGPT sign-in and installation are disabled."
    : ready
      ? "The selected registration is ready to review. Model access and each request still depend on this account."
      : usageLimited
        ? "Plan requests are paused. Manage usage in ChatGPT."
        : welcomePending
          ? "Read the ChatGPT plan notice and choose Continue before reviewing a model installation."
          : mode === "identity-only"
            ? "Identity is verified. Grant separate ChatGPT plan permission before reviewing a model installation."
            : mode === "transferred"
              ? "Use the installed owner's controls to manage this session; start a fresh registration for another installation."
              : mode === "handoff-pending"
                ? "No plan request is allowed until destination ownership is resolved."
                : "Continue with ChatGPT or select a different registration above.";
  element("signin-next").hidden = false;
  element("signin-next").disabled = !ready;
}

async function refreshAuthStatus({ fresh = false } = {}) {
  clearError();
  const account = await runOperation(
    null,
    fresh ? "Checking the new account…" : "Checking ChatGPT accounts…",
    () => siwc.load(),
    { progressNote: "Relmio checks your local account registrations. No personal Codex credential is imported." },
  );
  if (account === undefined) return false;
  renderAuthStatus(account, { fresh });
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
    : "Manage ChatGPT plan sidecar";
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
  const identity = sshSession.adoptedIdentity();
  if (!identity || !sameSshIdentity(identity, state.reviewedIdentity ?? identity)) {
    invalidateReviewedPlan();
    throw new Error("The verified administrative SSH identity is unavailable. Disconnect and reconnect before reviewing this plan.");
  }
  const recipient = `${identity.username}@${identity.host}:${identity.port}`;
  if (!assistant && (
    plan.operationLockPath !== "/docker/n8n-openai-oauth/.openai-oauth-operation.lock" ||
    plan.temporaryBuildStatePath !== "/docker/n8n-openai-oauth/.openai-oauth-operation.lock/buildx"
  )) throw new Error("The reviewed bridge build boundary is invalid. Review a fresh plan.");
  if (!assistant) {
    const account = normalizeSiwcAccount(plan.account);
    if ((!plan.resumeRequired && account.registrationId !== siwc.selected()?.registrationId) ||
        !/^[a-f0-9]{64}$/u.test(plan.n8nContainerId ?? "") ||
        !/^[a-f0-9]{64}$/u.test(plan.networkId ?? "") ||
        (plan.migrationRequired && (plan.legacyResourcesPreserved !== true ||
          plan.requiresMigrationConsent !== true)) ||
        (plan.replacementRequired && (plan.oldSessionSignedOut !== true ||
          plan.oldHistoryRetained !== true || plan.requiresReplacementConsent !== true)) ||
        (plan.migrationRequired && plan.replacementRequired)) {
      throw new Error("The selected ChatGPT account or owner plan changed. Review again.");
    }
  }
  state.planMigrationRequired = !assistant && plan.migrationRequired === true;
  state.planReplacementRequired = !assistant && plan.replacementRequired === true;
  element("vps-migration-row").hidden = !state.planMigrationRequired;
  element("vps-replacement-row").hidden = !state.planReplacementRequired;
  element("vps-migration-consent").checked = false;
  element("vps-replacement-consent").checked = false;
  element("review-intro").textContent = assistant
    ? "Only the Assistant companion changes. Nothing is written until you approve."
    : "Only the reviewed Relmio sidecar changes. Nothing is written until you approve.";
  if (plan.resumeRequired) element("review-intro").textContent =
    `Resume owned installation ${plan.staging.installId.slice(0, 12)} from ${plan.staging.stage}. Existing files stay in place; a completed transfer rotates the one-time key.`;
  element("review-destination-row").hidden = assistant;
  element("review-destination").textContent = assistant ? "" :
    `${plan.containerName} (${plan.n8nContainerId.slice(0, 12)}) / ${plan.networkName} (${plan.networkId.slice(0, 12)})`;
  element("review-account-row").hidden = assistant;
  element("review-account").textContent = assistant ? "" :
    `${plan.account?.label ?? "Unverified"}${plan.account?.email ? ` (${plan.account.email})` : ""} · ${plan.account?.registrationId?.slice(-8) ?? ""}`;
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
          state.planMigrationRequired
            ? "Stop only the attested old Relmio sidecar. Keep its old auth credential offline."
            : state.planReplacementRequired
              ? "Replace only the signed-out, ownership-attested sidecar. Retain its old mapping offline."
              : "Create only /docker/n8n-openai-oauth.",
          "Transfer the selected registration to this user-controlled installation.",
          "Build and start only the private sidecar.",
          // The network shows twice in the facts above, so this line takes the attach line's place
          // and the step keeps one screen. The details sit under the build details disclosure.
          "Keep 31 days of request and token counts here.",
        ],
  );
  replaceReviewItems("review-build-list", assistant ? [] : [
    `After you confirm, use a temporary root-only Buildx folder at ${plan.temporaryBuildStatePath}. If cleanup is uncertain, that folder and its lock may remain for you to inspect.`,
    "Build only managed runtime files. The selected registration is transferred separately, outside the build context. Cleanup does not change n8n or model caches.",
    "The sidecar keeps daily request and token counts on this server for 31 days, with no prompts or answers. Relmio reads them only when you press Refresh usage.",
  ]);
  element("review-build-summary").textContent = assistant ? "Host key and build details" : "Host key, build and request count details";
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
    ? "I approve this private Assistant companion. n8n settings and any restart stay my separate action."
    : `I approve the service-only write under /docker/n8n-openai-oauth on ${recipient}, and the transfer of ${plan.account?.label ?? "this account"}. n8n remains unchanged.`;
  element("background-consent-row").hidden = assistant;
  element("background-consent").checked = false;
  const installButton = element("install-button");
  installButton.textContent = assistant
    ? "Install Assistant companion"
    : state.managingDetectedIntegration
      ? "Update the bridge"
      : "Install the sidecar";
  installButton.dataset.label = installButton.textContent;
  state.reviewedIdentity = identity;
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
  clearError();
  loginLink.hidden = true;
  loginLink.removeAttribute("href");
  setOAuthStopControlVisible(false);
  try {
    const status = await runOperation(
      button,
      "Waiting for browser sign-in…",
      async () => {
        const result = await api("/api/oauth/login", {
          method: "POST",
          body: state.loginIntent,
        });
        if (result.launchMode !== "system-browser") {
          throw new Error(
            "The wizard returned an unexpected sign-in launch mode. Update Relmio and try again.",
          );
        }
        const attemptId = validateOAuthAttemptId(result.attemptId);
        if (state.oauthLoginGeneration !== loginGeneration) {
          return undefined;
        }
        state.oauthAttemptId = attemptId;
        selectChatGptSetup({ focus: false });
        setOAuthStopControlVisible(true);
        await waitForOAuthCompletion(attemptId);
        if (state.oauthLoginGeneration !== loginGeneration) {
          return undefined;
        }
        return siwc.authorized(state.loginIntent);
      },
      {
        allowedSelector: OPERATION_ALLOWED_SELECTOR,
        progressNote:
          "Finish sign-in in the ChatGPT window Relmio opened. The selected registration changes only after verified identity. Keep this page open or use Stop.",
      },
    );
    if (!status || state.oauthLoginGeneration !== loginGeneration) {
      return;
    }
    loginLink.hidden = true;
    loginLink.removeAttribute("href");
    renderAuthStatus(status, { fresh: true });
  } catch (error) {
    if (state.oauthLoginGeneration === loginGeneration) {
      if (error.oauthRetryBlocked === true) {
        blockOAuthRetry();
      }
      await siwc.load({ welcome: false }).catch(() => {});
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
    finishOAuthCancellation();
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

async function continueWithOpenAiVps() {
  clearError();
  try {
    const discovered = await runOperation(
      element("signin-next"),
      "Checking the verified VPS connection…",
      async () => {
        await sshSession.adoptCurrent();
        return discover();
      },
      {
        progressNote:
          "Relmio is inspecting the existing verified SSH connection with read-only Docker commands. Keep this page open.",
      },
    );
    if (!discovered) return;
    renderDiscovery(discovered);
    setMessage(
      "n8n was found on the verified VPS connection. Choose its network, then install or manage a Relmio-owned companion.",
    );
  } catch (error) {
    showStep(2);
    if (error?.message === "Connect to the VPS first.") {
      setMessage("Enter the intended VPS address and account from your hosting provider.");
      return;
    }
    showError(error);
    setMessage(
      "The verified VPS connection could not be inspected. Review the error, then reconnect only if needed.",
    );
  }
}

element("signin-next").addEventListener("click", () => {
  void continueWithOpenAiVps();
});

element("fingerprint-button").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  clearError();
  resetFingerprint();
  for (const id of ["host", "port"]) {
    const input = element(id);
    if (!input.checkValidity()) {
      input.setAttribute("aria-invalid", "true");
      focusVisible(input);
      input.reportValidity();
      return;
    }
  }
  const operationOwner = state.operationOwner + 1;
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
    if (!result || operationOwner !== state.operationOwner) return;
    for (const id of ["host", "port"]) clearFieldError(element(id), "global-error-text");
    state.fingerprint = result.fingerprint;
    element("fingerprint-value").textContent = result.fingerprint;
    element("fingerprint-box").hidden = false;
    element("fingerprint-confirm").checked = false;
    element("password").value = "";
    element("password").disabled = true;
    setCredentialInputsEnabled(false);
    element("connect-button").disabled = true;
    setMessage("Confirm the VPS identity before authenticating.");
    if (document.activeElement === button && !state.operationBusy) {
      focusVisible(element("fingerprint-confirm"));
    }
  } catch (error) {
    if (operationOwner === state.operationOwner) {
      showError(error, { focus: document.activeElement === button });
    }
  }
});

element("fingerprint-confirm").addEventListener("change", (event) => {
  invalidateReviewedPlan();
  const confirmed = event.currentTarget.checked;
  sshAuthentication.sync({ trusted: confirmed });
  setCredentialInputsEnabled(confirmed && Boolean(state.fingerprint));
  element("connect-button").disabled = !confirmed;
  if (confirmed) {
    (element("ssh-authentication").value === "agent" ? element("connect-button") : element("password")).focus();
  } else {
    element("password").value = "";
  }
});

element("host").addEventListener("input", handleVpsDestinationInput);
element("port").addEventListener("input", handleVpsDestinationInput);
for (const id of ["host", "port", "username"]) {
  element(id).addEventListener("input", () => clearFieldError(element(id), "global-error-text"));
}
element("password").addEventListener("input", invalidateReviewedPlan);

element("vps-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = element("connect-button");
  if (state.operationBusy) return;
  clearError();
  invalidateReviewedPlan();
  const identity = sshSession.adoptedIdentity();
  const retry = identity && !state.vpsReconnectRequired;
  if ((retry && !vpsConnectionMatchesForm(identity)) ||
      (!retry && (!state.fingerprint || !element("fingerprint-confirm").checked))) {
    resetFingerprint();
    showError(new Error("Check and confirm the server identity again before connecting with these details."));
    return;
  }
  setMessage(retry ? "Retrying Docker discovery on the verified connection…" :
    "Connecting, then inspecting Docker with read-only commands…");
  try {
    const discovered = await runOperation(
      button,
      retry ? "Inspecting Docker…" : "Connecting and inspecting Docker…",
      async () => {
        if (!retry) {
          await api("/api/ssh/connect", {
            method: "POST",
            body: sshAuthentication.request(state.fingerprint),
          });
          state.vpsReconnectRequired = false;
          state.fingerprint = null;
          element("fingerprint-box").hidden = true;
          element("fingerprint-confirm").checked = false;
          element("password").value = "";
          element("password").disabled = true;
          element("password").required = false;
        }
        return discover();
      },
      {
        progressNote: retry
          ? "Relmio is reusing the verified SSH connection for read-only Docker discovery. No new authentication or password is needed."
          : "Relmio is opening the verified SSH connection and inspecting Docker with read-only commands. Timing varies with your VPS and network. Keep this page open.",
      },
    );
    if (!discovered) return;
    element("password").value = "";
    clearFieldError(element("username"), "global-error-text");
    renderDiscovery(discovered);
    setMessage(
      "n8n was found. Choose its network, then install or manage a Relmio-owned companion.",
    );
  } catch (error) {
    if (error.code === "ssh_identity_review_required") resetFingerprint();
    showError(error);
  } finally {
    element("password").value = "";
    syncVpsConnectAction();
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
  resetVpsOwner();
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
    setMessage(
      "The Docker network list did not refresh. Retry the container selection, or disconnect and reconnect if needed.",
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
      async () => {
        if (!assistant) {
          const models = await siwc.catalog();
          if (models.length === 0) throw new Error("No models are listed for this selected ChatGPT account.");
          state.catalogLabels = new Map(models.map(({ slug, display_name }) => [slug, display_name]));
        }
        return api(assistant ? "/api/assistant/plan" : "/api/plan", {
          method: "POST",
          body: {
            containerName: element("container-select").value,
            networkName,
            ...(assistant ? { includeSearxng: element("manage-vps-searxng").checked } : {}),
          },
        });
      },
    );
    if (!plan) return;
    const planId = validatePlanId(plan.planId);
    renderIntegrationReview(plan);
    state.planId = planId;
    element("install-confirm").checked = false;
    element("install-button").disabled = true;
    dismissToast(messageToast);
    showStep(4);
  } catch (error) {
    showError(error);
  }
});

element("network-select").addEventListener("change", () => {
  invalidateReviewedPlan();
  resetVpsOwner();
  setMessage("Network changed. Review a fresh plan before installing.");
});

function updateInstallApproval() {
  const approved = element("install-confirm").checked && state.planId &&
    sameSshIdentity(state.reviewedIdentity, sshSession.adoptedIdentity()) &&
    (isAssistantIntegration() || (element("background-consent").checked &&
      (!state.planMigrationRequired || element("vps-migration-consent").checked) &&
      (!state.planReplacementRequired || element("vps-replacement-consent").checked)));
  if (!sameSshIdentity(state.reviewedIdentity, sshSession.adoptedIdentity()) &&
      element("install-confirm").checked) {
    invalidateReviewedPlan();
    showError(new Error("The verified VPS identity changed. Reconnect before reviewing a fresh plan."));
    return;
  }
  element("install-button").disabled = !approved;
}
element("install-confirm").addEventListener("change", updateInstallApproval);
element("background-consent").addEventListener("change", updateInstallApproval);
element("vps-migration-consent").addEventListener("change", updateInstallApproval);
element("vps-replacement-consent").addEventListener("change", updateInstallApproval);

function clearEndedVpsConnectionState({ preserveOwner = false } = {}) {
  state.discovery = null;
  state.networks = null;
  state.fingerprint = null;
  element("fingerprint-box").hidden = true;
  element("fingerprint-confirm").checked = false;
  element("password").value = "";
  element("password").disabled = true;
  setCredentialInputsEnabled(false);
  element("connect-button").disabled = true;
  element("container-select").replaceChildren();
  element("network-select").replaceChildren();
  element("detected-vps-integration-management").hidden = true;
  if (!preserveOwner) resetVpsOwner();
}


element("install-button").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  clearError();
  const assistant = isAssistantIntegration();
  if (!state.planId || !element("install-confirm").checked ||
    (!assistant && (!element("background-consent").checked ||
      (state.planMigrationRequired && !element("vps-migration-consent").checked) ||
      (state.planReplacementRequired && !element("vps-replacement-consent").checked))) ||
    !sameSshIdentity(state.reviewedIdentity, sshSession.adoptedIdentity())) {
    invalidateReviewedPlan();
    showError(new Error("Review and confirm a fresh plan first."));
    return;
  }
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
            : { backgroundConsent: element("background-consent").checked,
                ...(state.planMigrationRequired ? { migrationConsent: element("vps-migration-consent").checked } : {}),
                ...(state.planReplacementRequired ? { replacementConsent: element("vps-replacement-consent").checked } : {}) }),
        },
      }),
      {
        progressNote:
          "Docker may be downloading images, building, or starting the reviewed companion. Timing varies with your VPS and network. Keep this page open until verification finishes.",
      },
    );
    if (!result) return;
    const installedAccount = assistant ? null : normalizeSiwcAccount(result.account);
    const verifiedCatalog = assistant || result.readiness === "verified";
    invalidateReviewedPlan();
    if (!assistant) {
      element("result-url").textContent = result.baseUrl;
      element("result-key").textContent = result.clientCredential;
      element("result-http-auth").textContent = `Bearer ${result.clientCredential}`;
      element("result-account").textContent =
        `Installed account: ${installedAccount.label} · ${installedAccount.registrationId.slice(-8)}.`;
      // A finalization failure or an unverified runtime holds the key: no plan badge, and the
      // readiness line becomes the warning.
      const holdKey = Boolean(result.finalizationFailure) || result.runtimeState !== "running";
      element("result-plan-badge").hidden = holdKey || !installedAccount.planEnabled;
      element("result-usage").hidden = holdKey;
      const failureDetails = result.finalizationFailure ?? result.runtimeFailure ?? result.catalogFailure;
      const failure = failureDetails
        ? siwcErrorFromResponse(failureDetails, failureDetails.status ?? 502) : null;
      element("result-readiness").textContent = result.finalizationFailure
        ? `Finalization did not finish. ${failure ? siwcErrorText(failure) : ""} Review the installed target again.`
        : result.runtimeState !== "running"
        ? `Runtime outcome: ${result.runtimeState}. ${result.hostPublication === "unknown" ? "Host publication could not be verified. " : ""}Do not send requests. ${failure ? siwcErrorText(failure) : ""}`
        : verifiedCatalog
          ? "The installed account's model list was checked. No inference result has been verified here."
          : `The installed model check did not complete. Save the one-time key. ${failure ? siwcErrorText(failure) : "Check the installed owner before using n8n."}`;
      element("result-readiness").className = holdKey || !verifiedCatalog
        ? "rm-callout rm-callout--warning" : "rm-small";
      element("credential-title").textContent = holdKey
        ? "Save the Relmio client credential" : "1. Add the Relmio client credential";
      element("result-readiness-usage").hidden = failure?.recovery !== "manage-usage";
      // Image models answer only on the images route, so the chat recipe never offers them.
      const chatModels = result.models.filter((slug) => !slug.includes("image"));
      fillSelect(element("result-model-picker"),
        chatModels.map((slug) => ({ value: slug, label: state.catalogLabels.get(slug) ?? slug })),
        chatModels[0]);
      const selectedModel = chatModels[0] ?? "";
      element("result-model").textContent = selectedModel;
      element("result-models").textContent = result.models.length ? result.models.join(", ") : "None listed";
      // Request tools stay off while the key is held, so nothing suggests sending a request.
      element("result-model-picker").disabled = chatModels.length === 0 || holdKey;
      element("copy-http-recipe").disabled = chatModels.length === 0 || holdKey;
      element("result-http-url").textContent =
        `${result.baseUrl.replace(/\/$/u, "")}/chat/completions`;
      renderHttpRequestBody(selectedModel);
    }
    const assistantResult = assistant ? renderAssistantResult(result) : null;
    element("done-title").textContent = assistant
      ? "The private Assistant companion is ready"
      : result.finalizationFailure ? "Session transferred; finalization needs review"
        : result.runtimeState !== "running"
        ? "Session transferred; runtime needs inspection"
        : verifiedCatalog ? "The private sidecar is installed" : "Sidecar installed; model check unverified";
    element("done-detail").textContent = assistant
      ? assistantResult.includeSearxng
        ? "Code Sandbox and private SearXNG were checked. Relmio did not restart n8n."
        : "Code Sandbox was checked without SearXNG. Relmio did not restart n8n."
      : result.finalizationFailure
        ? "Save the one-time key now. Do not configure n8n until finalization is resolved."
        : result.runtimeState !== "running"
          ? "Save the one-time Relmio client key, but do not configure n8n until the owned runtime has been inspected."
          : "Copy the one-time Relmio client key into n8n on this private network. The selected installation owns future token refresh and sign-out.";
    element("assistant-result").hidden = !assistant;
    element("sidecar-ready-content").hidden = assistant;
    showStep(5);
    setMessage(assistant
      ? "Assistant companion verified. Your existing n8n was not restarted."
      : result.finalizationFailure
        ? "The server owns the session, but finalization did not finish. Save the one-time key and review the installed target."
        : result.runtimeState !== "running"
          ? "The destination owns the account, but its service status is uncertain. Save the one-time key and inspect the sidecar manually."
          : verifiedCatalog
            ? "The selected ChatGPT registration is owned by the sidecar. Set the one-time local client key in n8n yourself."
            : "The sidecar is installed, but model access was not verified. Save its one-time key and check the installed owner.");
  } catch (error) {
    invalidateReviewedPlan();
    if (error.sshIdentityUnverified === true) {
      state.installAttempted = false;
      showStep(2);
      setMessage("No installation request was sent. Verify the intended VPS again.");
      showError(error);
      return;
    }
    showStep(2);
    setMessage("The installation did not finish. Reconnect and inspect the owner before reviewing another write.");
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
      : "Review a separately authorized registration before replacing an owned sidecar. The installed owner can be managed below.",
  );
});

element("refresh-vps-chatgpt").addEventListener("click", () => {
  clearError();
  state.integrationKind = "sidecar";
  state.managingDetectedIntegration = true;
  element("manage-vps-sidecar").checked = true;
  renderIntegrationManagement();
  state.loginIntent = { purpose: "sign-in" };
  element("login-button").click();
});

element("result-model-picker").addEventListener("change", (event) => {
  const model = event.currentTarget.value;
  element("result-model").textContent = model;
  renderHttpRequestBody(model);
});

function sameVpsOwnerTarget(left, right) {
  return Boolean(left && right && left.containerName === right.containerName &&
    left.networkName === right.networkName && left.n8nContainerId === right.n8nContainerId &&
    left.networkId === right.networkId && left.identity && right.identity &&
    ["host", "port", "fingerprint", "username", "authentication", "privilege",
      "loginUid", "effectiveUid"].every((key) => left.identity[key] === right.identity[key]));
}

function renderVpsOwner(status, { reviewedStopped = false } = {}) {
  const account = status.account ? normalizeSiwcAccount(status.account) : null;
  const target = {
    containerName: element("container-select").value,
    networkName: element("network-select").value,
    ...status.destination,
    identity: sshSession.adoptedIdentity(),
  };
  state.vpsOwner = { ...target, state: status.state,
    registrationId: status.registrationId ?? account?.registrationId ?? status.staging?.registrationId, account, reviewedStopped };
  const stopped = status.state === "stopped" && !account && Boolean(status.registrationId);
  element("vps-owner-inspect-row").hidden = !stopped;
  element("vps-owner-inspect").hidden = !stopped;
  element("vps-owner-inspect-confirm").checked = false;
  element("vps-owner-confirm").checked = false;
  element("vps-owner-background-confirm").checked = false;
  renderVpsOwnerUpdate(status, account);
  const mutable = account?.ownership === "owned" && account.session !== "signed-out" &&
    (status.state === "owned" || reviewedStopped);
  element("vps-owner-actions").hidden = !mutable;
  element("vps-owner-enable").hidden = !mutable || account.planEnabled ||
    account.planPermission !== "granted";
  element("vps-owner-background-row").hidden = element("vps-owner-enable").hidden;
  element("vps-owner-disable").hidden = !mutable || !account.planEnabled;
  element("vps-owner-logout").hidden = !mutable;
  for (const id of ["vps-owner-enable", "vps-owner-disable", "vps-owner-logout"]) element(id).disabled = true;
  element("vps-owner-replace").hidden = !(account?.session === "signed-out" &&
    account.planEnabled === false && reviewedStopped);
  element("vps-owner-status").textContent = account
    ? `${account.label}${account.email ? ` (${account.email})` : ""} · ${account.registrationId.slice(-8)}. ${account.session === "connected"
      ? account.planEnabled ? "Using ChatGPT plan." : "Plan use paused." : "Signed out."}`
    : stopped ? "The sidecar is stopped. Confirm a one-off owner inspection before changing its session."
      : status.state === "legacy" ? "Legacy bridge found. Review a fresh SIWC migration. The old credential stays offline."
        : status.state === "updating" ? "A sidecar update did not finish."
          : status.state === "partial" ? "Owner state is partial. Inspect the service manually before another write."
            : "No attested installed ChatGPT account was found on this selected network.";
}

function renderVpsOwnerUpdate(status, account = null) {
  state.vpsOwnerUpdate = null;
  const owned = status?.state === "owned" && account?.ownership === "owned";
  const updating = status?.state === "updating";
  element("vps-owner-update").hidden = !owned && !updating;
  element("vps-owner-update-plan").hidden = true;
  element("vps-owner-update-confirm").checked = false;
  element("vps-owner-update-apply").disabled = true;
  element("vps-owner-update-summary").textContent = "";
  element("vps-owner-update-status").textContent = updating
    ? `A sidecar update was interrupted at stage ${status.staging?.stage ?? "unknown"}. Review it to finish.`
    : status?.runtimeUpdateAvailable === true ? "A newer sidecar runtime is available."
      : status?.runtimeUpdateAvailable === false ? "The sidecar runtime is current."
        : "Review the sidecar update to compare it with this Relmio version.";
  renderVpsOwnerImages(null, owned);
  renderVpsOwnerModels(null, owned);
}

function stopVpsOwnerImagesPolling() {
  state.vpsImagesGeneration += 1;
  window.clearTimeout(state.vpsImagesTimer);
  state.vpsImagesTimer = null;
}

function renderVpsOwnerImages(images, visible = true) {
  stopVpsOwnerImagesPolling();
  state.vpsImages = images;
  const view = images?.state;
  const account = images?.account;
  const identity = sshSession.adoptedIdentity();
  element("vps-owner-images").hidden = !visible;
  element("vps-owner-images-off").hidden = view !== "off" && view !== "reauthorize";
  element("vps-owner-images-pending").hidden = view !== "pending";
  element("vps-owner-images-on").hidden = view !== "signed-in" && view !== "reauthorize";
  for (const id of ["vps-owner-images-confirm", "vps-owner-images-signout-confirm"]) element(id).checked = false;
  for (const id of ["vps-owner-images-start", "vps-owner-images-signout"]) element(id).disabled = true;
  element("vps-owner-images-confirm-label").textContent = "I understand. Sign in to Codex for images on " +
    `${identity ? `${identity.username}@${identity.host}:${identity.port}` : "this server"}.`;
  element("vps-owner-images-code").textContent = view === "pending" ? images.pending.userCode : "";
  const link = element("vps-owner-images-link");
  if (view === "pending") link.href = images.pending.verificationUrl;
  else link.removeAttribute("href");
  element("vps-owner-images-expiry").textContent = view === "pending"
    ? `The code expires at ${new Date(images.pending.expiresAt).toLocaleTimeString()}. Relmio checks every 5 seconds.`
    : "";
  const who = account
    ? ` for ${account.email ?? `account …${account.accountIdSuffix}`}${account.planType ? ` (${account.planType})` : ""}`
    : "";
  element("vps-owner-images-status").textContent = view === "signed-in" ? `Images on${who}.`
    : view === "pending" ? "Open the Codex sign-in page and enter the code below. Image generation turns on when you approve it."
      : view === "reauthorize" ? "The Codex image sign-in expired. Sign in for images again."
        : view === "unavailable" ? "Update the sidecar first (Review sidecar update) to add image generation."
          : images?.outcome === "declined" ? "The Codex sign-in was declined. Image generation is off."
            : images?.outcome === "expired" ? "The sign-in code expired before it was used. Image generation is off."
              : view === "off" ? "Image generation is off."
                : "Check the installed account to see image generation.";
  if (view === "pending") scheduleVpsOwnerImagesPoll(state.vpsImagesGeneration);
}

function scheduleVpsOwnerImagesPoll(generation, delay = 5_000) {
  window.clearTimeout(state.vpsImagesTimer);
  state.vpsImagesTimer = generation === state.vpsImagesGeneration
    ? window.setTimeout(() => { void pollVpsOwnerImages(generation); }, delay)
    : null;
}

// The server detaches SSH after sign-out or a finished sign-in, like other owner changes.
async function endVpsOwnerImagesSession() {
  await api("/api/disconnect", { method: "POST", body: {} }).catch(() => {});
  clearEndedVpsConnectionState({ preserveOwner: true });
  showStep(2);
}

async function pollVpsOwnerImages(generation) {
  if (generation !== state.vpsImagesGeneration) return;
  if (state.operationBusy) {
    scheduleVpsOwnerImagesPoll(generation, 500);
    return;
  }
  let result;
  try {
    result = await api("/api/siwc/vps/images/login-status", { method: "POST", body: {} });
  } catch (error) {
    if (generation !== state.vpsImagesGeneration) return;
    element("vps-owner-images-status").textContent =
      "The image sign-in status could not be checked. Check the installed account again to continue.";
    showError(error, { focus: false });
    return;
  }
  if (generation !== state.vpsImagesGeneration) return;
  renderVpsOwnerImages(result);
  if (result.state === "pending") return;
  setMessage(element("vps-owner-images-status").textContent);
  await endVpsOwnerImagesSession();
}

async function changeVpsOwnerImages(action, button, confirmId) {
  const owner = state.vpsOwner;
  if (!owner || (confirmId && !element(confirmId).checked)) {
    showError(new Error("Confirm this image sign-in change first."));
    return;
  }
  clearError();
  try {
    const result = await runOperation(button, action === "login-start" ? "Starting image sign-in…"
      : action === "sign-out" ? "Signing out of images…" : "Cancelling image sign-in…", () =>
      api("/api/siwc/vps/images/action", { method: "POST", body: { action, confirmed: true } }));
    if (!result || state.vpsOwner !== owner) return;
    renderVpsOwnerImages(result);
    if (action === "login-start" && result.state === "pending") focusVisible(element("vps-owner-images-link"));
    if (action === "login-cancel") focusVisible(element("vps-owner-images-confirm"));
    if (action === "sign-out") {
      const message = result.revocation === "unconfirmed"
        ? "The Codex image sign-in was removed from this server, but OpenAI did not confirm the revocation."
        : "Signed out of images. The Codex image sign-in was removed from this server.";
      element("vps-owner-images-status").textContent = message;
      setMessage(message);
    }
  } catch (error) { showError(error); }
  finally {
    if (action === "sign-out") await endVpsOwnerImagesSession();
  }
}

element("vps-owner-images-confirm").addEventListener("change", (event) => {
  element("vps-owner-images-start").disabled = !event.currentTarget.checked;
});
element("vps-owner-images-signout-confirm").addEventListener("change", (event) => {
  element("vps-owner-images-signout").disabled = !event.currentTarget.checked;
});
element("vps-owner-images-start").addEventListener("click", (event) => {
  void changeVpsOwnerImages("login-start", event.currentTarget, "vps-owner-images-confirm");
});
element("vps-owner-images-cancel").addEventListener("click", (event) => {
  void changeVpsOwnerImages("login-cancel", event.currentTarget);
});
element("vps-owner-images-signout").addEventListener("click", (event) => {
  void changeVpsOwnerImages("sign-out", event.currentTarget, "vps-owner-images-signout-confirm");
});

const VPS_MODEL_BADGES = new Map([
  ["verified", ["Ready", "rm-badge rm-badge--success"]],
  ["failed", ["Not working", "rm-badge rm-badge--warning"]],
  ["unchecked", ["Not checked yet", "rm-badge"]],
]);
const VPS_MODEL_LISTED_BADGES = new Map([[true, ["In n8n", "rm-badge rm-badge--accent"]], [false, ["Not in n8n", "rm-badge"]]]);
const VPS_MODEL_STOP_REASONS = new Map([
  ["usage_limit", "Checks paused: plan usage isn't available right now."],
  ["reauthorize", "Checks paused: ChatGPT sign-in is needed."],
  ["probe_rejected", "Checks paused: OpenAI refused the test request."],
  ["checks_off", "Checks stopped because they were turned off."],
  ["time_limit", "Some models weren't checked in time. The sidecar keeps checking in the background."],
  ["lease_unavailable", "Checks paused: the ChatGPT session isn't available for plan use right now."],
]);

// Without a catalog only turning checks off stays offered; turning them on needs the catalog.
function vpsOwnerModelsControl(models) {
  return models?.state !== "available" ? null : models.checksEnabled ? "off" : models.catalogError ? null : "on";
}

function vpsOwnerModelsStatus(models) {
  if (!models) return "Check the installed account to see models.";
  if (models.state !== "available") return "Update the sidecar first (Review sidecar update) to show models.";
  const catalog = models.catalogError
    ? `OpenAI's model catalog is unavailable right now.${models.checksEnabled ? " You can still turn model checks off." : ""}`
    : models.catalogCheckedAt === null ? "Check the installed account to refresh the model list."
      : models.models.length
        ? `Catalog read at ${new Date(models.catalogCheckedAt).toLocaleTimeString()} as Codex ${models.clientVersion}.`
        : "OpenAI's catalog lists no models for this account.";
  return [`Model checks are ${models.checksEnabled ? "on" : "off"}.`, catalog,
    VPS_MODEL_STOP_REASONS.get(models.lastRun?.stoppedReason)].filter(Boolean).join(" ");
}

function renderVpsOwnerModels(models, visible = true) {
  const available = models?.state === "available";
  const control = vpsOwnerModelsControl(models);
  const identity = sshSession.adoptedIdentity();
  element("vps-owner-models").hidden = !visible;
  element("vps-owner-models-view").hidden = !available;
  element("vps-owner-models-checks-off").hidden = control !== "on";
  element("vps-owner-models-checks-on").hidden = control !== "off";
  for (const id of ["vps-owner-models-confirm", "vps-owner-models-off-confirm"]) element(id).checked = false;
  for (const id of ["vps-owner-models-on", "vps-owner-models-off"]) element(id).disabled = true;
  element("vps-owner-models-confirm-label").textContent = "I approve model checks on " +
    `${identity ? `${identity.username}@${identity.host}:${identity.port}` : "this server"}.`;
  element("vps-owner-models-list").replaceChildren(...(available ? models.models.map(vpsOwnerModelRow) : []));
  element("vps-owner-models-status").textContent = vpsOwnerModelsStatus(models);
  state.vpsModels = models;
  void renderVpsUsage();
}

// Plan and usage on the owner panel: the checked account, the image add-on's plan type while it
// is signed in, the model checks and the request counts that Refresh usage reads. The panel
// module loads on first use with its stylesheet, so the first paint of this page stays light.
// The section shows only once both have loaded, so it never appears unstyled.
let usagePanel = null;

async function renderVpsUsage({ loading = false } = {}) {
  const owner = state.vpsOwner;
  const section = element("vps-usage");
  if (owner?.state !== "owned" || owner.account?.ownership !== "owned") {
    section.hidden = true;
    return;
  }
  usagePanel ??= import("./usage-panel.js");
  const { renderUsage } = await usagePanel;
  if (state.vpsOwner !== owner) return;
  section.hidden = false;
  const models = state.vpsModels?.state === "available" ? { listed: state.vpsModels.models.length,
    verified: state.vpsModels.models.filter((model) => model.state === "verified").length } : null;
  renderUsage({ status: element("vps-usage-status"), view: element("vps-usage-view") }, {
    page: "vps", account: owner.account, models, loading,
    imagePlan: state.vpsImages?.state === "signed-in" ? state.vpsImages.account?.planType ?? null : null,
    usage: state.vpsUsage?.registrationId === owner.registrationId ? state.vpsUsage.view : null,
    error: state.vpsUsageError?.owner === owner ? state.vpsUsageError.error : null,
  });
}

function vpsOwnerModelBadge([text, className]) {
  const badge = document.createElement("span");
  badge.className = className;
  badge.textContent = text;
  return badge;
}

function vpsOwnerModelRow(model) {
  const row = document.createElement("div");
  const label = document.createElement("dt");
  const detail = document.createElement("dd");
  const id = document.createElement("code");
  const copy = document.createElement("button");
  const icon = document.createElement("span");
  const name = document.createElement("span");
  label.textContent = model.display_name;
  detail.className = "rm-cluster";
  id.textContent = model.id;
  copy.type = "button";
  copy.className = "rm-button rm-button--sm copy-value";
  icon.className = "rm-icon rm-icon--copy rm-icon--sm";
  icon.setAttribute("aria-hidden", "true");
  // Each button names its model, so a list of Copy ID buttons stays distinguishable.
  name.className = "rm-visually-hidden";
  name.textContent = ` ${model.id}`;
  copy.append(icon, "Copy ID", name);
  copy.addEventListener("click", () => { void copyVpsOwnerModelId(model.id, copy, id); });
  detail.append(id, vpsOwnerModelBadge(VPS_MODEL_LISTED_BADGES.get(model.listed)),
    vpsOwnerModelBadge(VPS_MODEL_BADGES.get(model.state)), copy);
  row.append(label, detail);
  return row;
}

async function copyVpsOwnerModelId(modelId, button, code) {
  const status = element("vps-owner-models-status");
  try {
    await copyText(modelId);
    flashCopied(button);
    status.textContent = `Copied ${modelId}.`;
  } catch {
    document.getSelection().selectAllChildren(code);
    status.textContent = "Copy failed. The ID is selected, so you can copy it with your keyboard.";
  }
}

async function changeVpsOwnerModels(enabled, button, confirmId) {
  const owner = state.vpsOwner;
  if (!owner || !element(confirmId).checked) {
    showError(new Error("Confirm this model check change first."));
    return;
  }
  clearError();
  try {
    const result = await runOperation(button, enabled ? "Turning on model checks…" : "Turning off model checks…",
      () => api("/api/siwc/vps/models/checks", { method: "POST", body: { enabled, confirmed: true } }),
      { progressNote: enabled
        ? "The sidecar tests up to 12 models now, one at a time. This can take a few minutes."
        : OPERATION_DEFAULT_NOTE });
    if (!result || state.vpsOwner !== owner) return;
    renderVpsOwnerModels(result);
    const control = vpsOwnerModelsControl(result);
    focusVisible(element(control === "off" ? "vps-owner-models-off-confirm"
      : control === "on" ? "vps-owner-models-confirm" : "vps-owner-check"));
  } catch (error) { showError(error); }
}

for (const [enabled, buttonId, confirmId] of [
  [true, "vps-owner-models-on", "vps-owner-models-confirm"],
  [false, "vps-owner-models-off", "vps-owner-models-off-confirm"],
]) {
  element(confirmId).addEventListener("change", (event) => {
    element(buttonId).disabled = !event.currentTarget.checked;
  });
  element(buttonId).addEventListener("click", (event) => {
    void changeVpsOwnerModels(enabled, event.currentTarget, confirmId);
  });
}

function updateVpsOwnerApproval() {
  const owner = state.vpsOwner;
  const accepted = element("vps-owner-confirm").checked && owner?.account?.ownership === "owned" &&
    (owner.state === "owned" || owner.reviewedStopped === true);
  element("vps-owner-enable").disabled = !accepted || !element("vps-owner-background-confirm").checked;
  element("vps-owner-disable").disabled = !accepted;
  element("vps-owner-logout").disabled = !accepted;
}
element("vps-owner-confirm").addEventListener("change", updateVpsOwnerApproval);
element("vps-owner-background-confirm").addEventListener("change", updateVpsOwnerApproval);

element("vps-owner-check").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  clearError();
  try {
    const result = await runOperation(button, "Checking installed owner…", () =>
      api("/api/siwc/vps/status", {
        method: "POST",
        body: { containerName: element("container-select").value,
          networkName: element("network-select").value },
      }));
    if (!result) return;
    const current = { containerName: element("container-select").value,
      networkName: element("network-select").value, identity: sshSession.adoptedIdentity() };
    const destination = result.destination;
    current.n8nContainerId = destination?.n8nContainerId;
    current.networkId = destination?.networkId;
    const prior = state.vpsOwner;
    if (result.state === "stopped" && prior?.reviewedStopped && prior.account &&
        result.registrationId === prior.registrationId && sameVpsOwnerTarget(prior, current)) {
      renderVpsOwner({ ...result, account: prior.account }, { reviewedStopped: true });
    } else renderVpsOwner(result);
    const owner = state.vpsOwner;
    if (element("vps-owner-images").hidden) return;
    const target = { containerName: owner.containerName, networkName: owner.networkName,
      registrationId: owner.registrationId };
    const images = await runOperation(button, "Checking image generation…", () =>
      api("/api/siwc/vps/images/status", { method: "POST", body: target }));
    if (images && state.vpsOwner === owner) renderVpsOwnerImages(images);
    const models = await runOperation(button, "Checking models…", () =>
      api("/api/siwc/vps/models/status", { method: "POST", body: target }));
    if (models && state.vpsOwner === owner) renderVpsOwnerModels(models);
  } catch (error) { showError(error); }
});

// Read-only. The route allows 10 reads in 15 minutes and answers 409 once the owner check expires.
element("vps-usage-refresh").addEventListener("click", async (event) => {
  const owner = state.vpsOwner;
  if (!owner?.registrationId) return;
  state.vpsUsageError = null;
  void renderVpsUsage({ loading: true });
  try {
    const view = await runOperation(event.currentTarget, "Reading request counts…", () =>
      api("/api/siwc/vps/usage/status", { method: "POST", body: { containerName: owner.containerName,
        networkName: owner.networkName, registrationId: owner.registrationId } }));
    if (view) state.vpsUsage = { registrationId: owner.registrationId, view };
  } catch (error) {
    state.vpsUsageError = { owner, error };
  }
  await renderVpsUsage();
});

element("vps-owner-inspect").addEventListener("click", async (event) => {
  const owner = state.vpsOwner;
  if (!owner?.registrationId || owner.state !== "stopped" ||
      !element("vps-owner-inspect-confirm").checked) {
    showError(new Error("Confirm the stopped sidecar owner inspection first."));
    return;
  }
  const button = event.currentTarget;
  clearError();
  try {
    const result = await runOperation(button, "Inspecting stopped owner…", () =>
      api("/api/siwc/vps/inspect-stopped", { method: "POST", body: {
        containerName: owner.containerName, networkName: owner.networkName,
        registrationId: owner.registrationId, confirmed: true,
      } }));
    if (!result) return;
    renderVpsOwner({ state: "stopped", registrationId: owner.registrationId,
      account: result.account, destination: { n8nContainerId: owner.n8nContainerId, networkId: owner.networkId } }, { reviewedStopped: true });
    setMessage("Stopped owner verified. Reconnect to the same server before a separately confirmed session change.");
  } catch (error) { showError(error); }
  finally {
    await api("/api/disconnect", { method: "POST", body: {} }).catch(() => {});
    clearEndedVpsConnectionState({ preserveOwner: true });
    showStep(2);
  }
});

async function manageVpsOwner(action, button) {
  const owner = state.vpsOwner;
  if (!owner?.account || !element("vps-owner-confirm").checked ||
      (action === "enable-plan" && !element("vps-owner-background-confirm").checked)) {
    showError(new Error("Confirm this installed account action and its background use."));
    return;
  }
  clearError();
  try {
    const result = await runOperation(button, "Checking installed owner…", () =>
      api("/api/siwc/vps/manage", { method: "POST", body: {
        containerName: owner.containerName, networkName: owner.networkName,
        registrationId: owner.account.registrationId,
        expectedGeneration: owner.account.generation,
        action, confirmed: true,
        ...(action === "enable-plan" ? { backgroundConsent: true } : {}),
      } }));
    if (!result) return;
    renderVpsOwner({ state: result.runtimeStopped ? "stopped" : "owned",
      registrationId: result.account.registrationId, account: result.account,
      destination: { n8nContainerId: owner.n8nContainerId, networkId: owner.networkId } },
    { reviewedStopped: result.runtimeStopped === true });
    const message = result.revocation === "unconfirmed"
      ? "Local credentials were cleared but provider revocation was not confirmed. Disconnect Relmio in ChatGPT settings."
      : action === "sign-out" ? "The installed account was signed out. Old credentials stay separate."
        : action === "disable-plan" ? "Plan use paused. Only this owned sidecar stopped."
          : "Plan use enabled. Only this owned sidecar started.";
    element("vps-owner-status").textContent = message;
    setMessage(message);
  } catch (error) { showError(error); }
  finally {
    await api("/api/disconnect", { method: "POST", body: {} }).catch(() => {});
    clearEndedVpsConnectionState({ preserveOwner: true });
    showStep(2);
  }
}
for (const [id, action] of [
  ["vps-owner-enable", "enable-plan"], ["vps-owner-disable", "disable-plan"],
  ["vps-owner-logout", "sign-out"],
]) element(id).addEventListener("click", (event) => { void manageVpsOwner(action, event.currentTarget); });

element("vps-owner-update-review").addEventListener("click", async (event) => {
  const owner = state.vpsOwner;
  if (!owner?.registrationId || !["owned", "updating"].includes(owner.state)) {
    showError(new Error("Check the installed account before reviewing a sidecar update."));
    return;
  }
  const button = event.currentTarget;
  clearError();
  state.vpsOwnerUpdate = null;
  element("vps-owner-update-plan").hidden = true;
  element("vps-owner-update-confirm").checked = false;
  element("vps-owner-update-apply").disabled = true;
  try {
    const result = await runOperation(button, "Reviewing the sidecar update…", () =>
      api("/api/siwc/vps/runtime-update/review", { method: "POST", body: {
        containerName: owner.containerName, networkName: owner.networkName,
        registrationId: owner.registrationId,
      } }));
    if (!result || state.vpsOwner !== owner) return;
    if (result.rebuildRequired === false) {
      element("vps-owner-update-status").textContent = "Already current. Nothing to update.";
      return;
    }
    const identity = sshSession.adoptedIdentity();
    const count = result.changedFiles.length;
    element("vps-owner-update-summary").textContent = "Rebuild and restart only the Relmio sidecar from this Relmio version. " +
      `${count} runtime ${count === 1 ? "file changes" : "files change"}. ` +
      "The ChatGPT sign-in and the one-time Relmio key stay the same. " +
      "The sidecar is unavailable for about a minute. n8n is not stopped or restarted. " +
      "The updated sidecar keeps daily request and token counts on the server for 31 days, with no prompts or answers. " +
      `Image ${result.imageId}, container ${result.containerId}.`;
    element("vps-owner-update-confirm-label").textContent =
      `I approve rebuilding and restarting only this owned sidecar on ${identity.username}@${identity.host}:${identity.port}.`;
    state.vpsOwnerUpdate = { reviewId: result.reviewId };
    element("vps-owner-update-plan").hidden = false;
  } catch (error) { showError(error); }
});

element("vps-owner-update-confirm").addEventListener("change", (event) => {
  element("vps-owner-update-apply").disabled = !event.currentTarget.checked || !state.vpsOwnerUpdate;
});

element("vps-owner-update-apply").addEventListener("click", async (event) => {
  const owner = state.vpsOwner;
  const update = state.vpsOwnerUpdate;
  if (!owner || !update || !element("vps-owner-update-confirm").checked) {
    showError(new Error("Review the sidecar update and confirm it first."));
    return;
  }
  const button = event.currentTarget;
  clearError();
  state.vpsOwnerUpdate = null;
  try {
    const result = await runOperation(button, "Updating the sidecar…", () =>
      api("/api/siwc/vps/runtime-update/apply", { method: "POST", body: {
        reviewId: update.reviewId, confirmed: true,
      } }));
    if (!result) return;
    renderVpsOwner({ state: "owned", registrationId: result.account.registrationId, account: result.account,
      runtimeUpdateAvailable: false,
      destination: { n8nContainerId: owner.n8nContainerId, networkId: owner.networkId } });
    const message = "Sidecar updated. The one-time key and sign-in are unchanged.";
    element("vps-owner-update-status").textContent = message;
    setMessage(message);
  } catch (error) { showError(error); }
  finally {
    await api("/api/disconnect", { method: "POST", body: {} }).catch(() => {});
    clearEndedVpsConnectionState({ preserveOwner: true });
    showStep(2);
  }
});

element("vps-owner-replace").addEventListener("click", () => {
  const owner = state.vpsOwner;
  if (!owner?.reviewedStopped || owner.account?.session !== "signed-out") return;
  if (accountUiState(siwc.selected()) !== "plan-active" || siwc.selected()?.needsPlanWelcome) {
    selectChatGptSetup();
    setMessage("Sign in with a fresh independent registration, then inspect the stopped old owner again before reviewing replacement.");
    return;
  }
  state.integrationKind = "sidecar";
  element("manage-vps-sidecar").checked = true;
  renderIntegrationManagement();
  element("review-button").click();
});

createSiwcRecovery({
  root: element("vps-siwc-recovery"), api, vps: true,
  getTarget: () => ({ containerName: element("container-select").value,
    networkName: element("network-select").value }),
  onReview(plan) {
    state.integrationKind = "sidecar";
    renderIntegrationReview(plan);
    state.planId = validatePlanId(plan.planId);
    element("install-confirm").checked = false;
    element("install-button").disabled = true;
    showStep(4);
  },
  async onResult() { await siwc.load({ welcome: false }); clearEndedVpsConnectionState(); showStep(2); },
  onError: showError,
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
  button.addEventListener("click", () => goToEarlierStep(Number(button.dataset.back)));
}
for (const button of document.querySelectorAll("[data-step-target]")) {
  button.addEventListener("click", () => goToEarlierStep(Number(button.dataset.stepTarget)));
}
updateStepNavigation();

renderHttpRequestBody(element("result-model").textContent);
initializeVpsWizard().catch(showError);

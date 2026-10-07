import { accountUiState, createSiwcControls, createSiwcRecovery, normalizeSiwcAccount, siwcErrorFromResponse, siwcErrorText } from "./siwc-controls.js";
import { bindWizardNavigation, readWizardSession } from "./session.js";
import { clearFieldError, setFieldError } from "./ssh-form.js";
import {
  INITIAL_CHAT_TESTER_FEEDBACK,
  nextChatTesterFeedback,
} from "./chat-tester-feedback.js";
import { initWizardTopbar } from "./topbar.js";

const token = readWizardSession();

const element = (id) => document.getElementById(id);

const state = {
  step: 1,
  target: "xai-grok-build",
  dockerAvailable: false,
  localN8nStackState: null,
  planId: null,
  plan: null,
  installedTarget: null,
  operationBusy: false,
  operationButton: null,
  operationControlObserver: null,
  operationControlStates: [],
  operationLabel: "",
  operationProgressStartedAt: 0,
  operationProgressTimer: null,
  suppressTargetRefresh: false,
  n8nContainers: [],
  n8nDiscoveryLoaded: false,
  n8nOAuthExists: false,
  n8nOAuthGeneration: 0,
  n8nOAuthAttemptId: null,
  n8nOAuthRetryBlocked: false,
  n8nOAuthCancellationMessage: "",
  n8nOAuthIntent: { purpose: "sign-in" },
  installedOwner: null,
  installedSiwcModelLocked: false,
  catalogLabels: new Map(),
  assistantSearxngReviewId: null,
  assistantSearxngReview: null,
  localModelReview: null,
  localModelPollTimer: null,
  localModelGeneration: 0,
  localModelReady: false,
  dashboardSnapshot: null,
  dashboardSnapshotStale: true,
  dashboardSelectedTarget: null,
  dashboardBusy: false,
  dashboardStaleTimer: null,
  dashboardFocusIdentity: null,
  dashboardUsage: null,
  installedUsage: null,
  chatTester: {
    activeController: null,
    conversationId: null,
    encryptedCredential: null,
    endpointBaseUrl: null,
    expiresAt: null,
    generation: 0,
    models: [],
    keyId: null,
    feedback: { ...INITIAL_CHAT_TESTER_FEEDBACK },
  },
};

const DASHBOARD_STATES = Object.freeze([
  "checking", "healthy", "stopped", "staged", "partial", "legacy", "unavailable", "stale", "absent",
]);
const DASHBOARD_ACTIONS = Object.freeze([
  "setup", "resume", "remove", "sign-out-chatgpt", "disable-chatgpt-plan", "inspect-stopped-chatgpt",
  "sign-in-grok-build", "sign-out-grok-build", "remove-owned-supergrok",
  "rotate-local-capability", "retry-model",
]);
const DASHBOARD_SERVICE_DEFINITIONS = Object.freeze([
  Object.freeze({ target: "codex-chatgpt", label: "Codex (ChatGPT plan)", kind: "endpoint" }),
  Object.freeze({ target: "codex-chat", label: "Codex Chat adapter", kind: "endpoint" }),
  Object.freeze({ target: "xai-grok-build", label: "SuperGrok", kind: "endpoint" }),
  Object.freeze({ target: "local-n8n-stack", label: "n8n + ngrok", kind: "n8n-stack" }),
  Object.freeze({ target: "n8n-openai-oauth", label: "ChatGPT plan sidecar", kind: "n8n-oauth-bridge" }),
  Object.freeze({ target: "local-n8n-assistant", label: "AI Assistant tools", kind: "n8n-assistant" }),
  Object.freeze({ target: "n8n-supergrok-oauth", label: "SuperGrok for n8n", kind: "n8n-supergrok" }),
  Object.freeze({ target: "n8n-local-model", label: "Local model for n8n", kind: "n8n-local-model" }),
]);
const DASHBOARD_PROVIDER_DEFINITIONS = Object.freeze([
  Object.freeze({ target: "codex-chatgpt", label: "ChatGPT", authentication: "provider-oauth", readiness: "runtime-owned" }),
  Object.freeze({ target: "codex-chat", label: "ChatGPT", authentication: "provider-oauth", readiness: "runtime-owned" }),
  Object.freeze({ target: "xai-grok-build", label: "SuperGrok", authentication: "provider-oauth", readiness: "runtime-owned" }),
  Object.freeze({ target: "n8n-supergrok-oauth", label: "SuperGrok (n8n)", authentication: "provider-oauth", readiness: "runtime-owned" }),
]);
const DASHBOARD_SERVICE_STATES = new Set(
  DASHBOARD_STATES.filter((value) => !["checking", "stale"].includes(value)),
);
const DASHBOARD_ACTION_SET = new Set(DASHBOARD_ACTIONS);
const DASHBOARD_ASSISTANT_MODES = new Set([
  "disabled",
  "sandbox",
  "sandbox-with-searxng",
]);
const DASHBOARD_STALE_AFTER_MS = 5 * 60 * 1_000;

const messageBox = element("global-message");
const messageText = element("global-message-text");
const errorBox = element("global-error");
const errorText = element("global-error-text");

bindWizardNavigation(element("back-to-vps"), "/", token);
bindWizardNavigation(element("setup-another-local"), "/local", token);
bindWizardNavigation(element("return-to-vps"), "/", token);
bindWizardNavigation(element("local-route-vps-openai"), "/", token);
bindWizardNavigation(element("local-route-vps-supergrok"), "/supergrok-vps", token);
bindWizardNavigation(element("local-route-vps-model"), "/local-model-vps", token);
bindWizardNavigation(element("dashboard-hosting-link"), "/hosting", token);
initWizardTopbar({
  session: token,
  isBusy: () => state.operationBusy,
  loadProjectMeta: () => api("/api/local/project-meta"),
});

// Step 1 has two stages so each fits one screen: choose a connection, then
// check its settings. The form, its fields and the review submit are shared.
function showSetupStage(stage, { focus = true } = {}) {
  const configure = stage === "configure";
  element("choose-stage").hidden = configure;
  element("configure-stage").hidden = !configure;
  element("back-to-vps").hidden = configure;
  element("choose-continue").hidden = configure;
  element("configure-back").hidden = !configure;
  element("review-button").hidden = !configure;
  element("choose-step-caption").textContent = configure
    ? "Step 1 of 4 · Settings"
    : "Step 1 of 4 · Choose";
  element("choose-title").textContent = configure
    ? "Check the settings"
    : "Choose what to set up";
  if (focus) element("choose-title").focus({ preventScroll: true });
}

element("choose-continue").addEventListener("click", () => {
  if (state.operationBusy) return;
  showSetupStage("configure");
  if (!element("local-siwc").hidden) siwc.load().catch(showError);
});

element("configure-back").addEventListener("click", () => {
  if (state.operationBusy) return;
  showSetupStage("choose");
});

element("local-route-current").addEventListener("click", () => {
  if (state.operationBusy) return;
  showSetupStage("choose", { focus: false });
  document.querySelector('input[name="target"]:checked')?.focus({
    preventScroll: true,
  });
});

function setMessage(text) {
  messageText.textContent = text;
  messageBox.hidden = false;
}

// Rejected fields point at the visible error through aria-describedby and
// lose that link, and aria-invalid, whenever the error is cleared or replaced.
const LOCAL_PORT_REJECTION =
  /^(?:Port is invalid\.|Local endpoint port must|The selected local endpoint port)/u;

function clearFieldErrors() {
  for (const field of document.querySelectorAll('[aria-describedby~="global-error-text"]')) {
    clearFieldError(field, "global-error-text");
  }
}

function clearError() {
  errorText.textContent = "";
  element("local-image-build-troubleshooting").hidden = true;
  element("global-error-recovery").hidden = true;
  errorBox.hidden = true;
  clearFieldErrors();
  globalThis.relmioGuide?.clearError?.();
}

function showError(error, invalidFields = []) {
  const localImageBuildFailed = error?.message === "Local image build failed.";
  errorText.textContent = localImageBuildFailed
    ? "Relmio could not build the local image. Check that Docker is running, has enough disk space, and can pull its base image."
    : error?.recovery && error.recovery !== "none" ? siwcErrorText(error)
      : error?.message ?? "Something went wrong.";
  element("global-error-recovery").hidden = error?.recovery !== "manage-usage";
  element("local-image-build-troubleshooting").hidden = !localImageBuildFailed;
  clearFieldErrors();
  const rejected = LOCAL_PORT_REJECTION.test(errorText.textContent)
    ? [element("local-port")]
    : invalidFields;
  for (const field of rejected) setFieldError(field, "global-error-text");
  errorBox.hidden = false;
  errorBox.focus();
  globalThis.relmioGuide?.error?.(error);
}

function validateLocalN8nStackCredentials() {
  const ngrokAuthtoken = element("ngrok-authtoken");
  const basicAuthUsername = element("ngrok-basic-auth-username");
  const basicAuthPassword = element("ngrok-basic-auth-password");
  const validations = [
    {
      input: ngrokAuthtoken,
      valid:
        ngrokAuthtoken.value.length >= 8 &&
        ngrokAuthtoken.value.length <= 512 &&
        !/\s/u.test(ngrokAuthtoken.value) &&
        !/^ngrok(?:\.exe)?\s+config\s+add-authtoken\b/iu.test(
          ngrokAuthtoken.value,
        ),
      message: "Paste only the agent token value from ngrok’s “Your Authtoken” or “Authtokens” page (8–512 characters, no whitespace), not the ngrok config add-authtoken command or an ngrok API key.",
    },
    {
      input: basicAuthUsername,
      valid: /^[A-Za-z0-9_-]{1,64}$/u.test(basicAuthUsername.value),
      message: "Use 1–64 letters, numbers, hyphens, or underscores.",
    },
    {
      input: basicAuthPassword,
      valid:
        basicAuthPassword.value.length >= 12 &&
        basicAuthPassword.value.length <= 512 &&
        !/[\0\r\n:]/u.test(basicAuthPassword.value),
      message: "Use 12–512 characters without a colon or line break.",
    },
  ];
  let firstInvalidInput = null;
  for (const validation of validations) {
    validation.input.setCustomValidity(validation.valid ? "" : validation.message);
    if (!validation.valid && !firstInvalidInput) {
      firstInvalidInput = validation.input;
    }
  }
  if (firstInvalidInput) {
    firstInvalidInput.reportValidity();
    return false;
  }
  return true;
}

function resetBasicAuthPasswordVisibility() {
  const input = element("ngrok-basic-auth-password");
  const button = element("toggle-ngrok-basic-auth-password");
  input.type = "password";
  button.textContent = "Show password";
  button.setAttribute("aria-pressed", "false");
}

const OPERATION_INTERACTIVE_SELECTOR =
  'button, input, select, textarea, summary, a[href], [contenteditable]';
const OPERATION_ALLOWED_SELECTOR =
  '[data-operation-allow="auth"], [data-operation-allow="copy"], [data-operation-allow="stop"]';
const OPERATION_BLOCKED_EVENTS = [
  "click",
  "pointerdown",
  "keydown",
  "beforeinput",
  "input",
  "change",
  "submit",
];

function readOperationAttribute(control, name) {
  if (typeof control.getAttribute === "function") {
    return control.getAttribute(name);
  }
  return control.attributes?.get?.(name) ?? null;
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

function operationControlCandidates() {
  const scope = typeof document === "undefined"
    ? element("install-panel")
    : document;
  return Array.from(
    scope.querySelectorAll?.(OPERATION_INTERACTIVE_SELECTOR) ?? [],
  );
}

function isOperationAllowedControl(control) {
  return Boolean(control?.closest?.(OPERATION_ALLOWED_SELECTOR));
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
  for (const control of node.querySelectorAll?.(OPERATION_INTERACTIVE_SELECTOR) ?? []) {
    lockOperationControl(control);
  }
}

function formatInstallElapsed(elapsedSeconds) {
  const minutes = String(Math.floor(elapsedSeconds / 60)).padStart(2, "0");
  const seconds = String(elapsedSeconds % 60).padStart(2, "0");
  return `${minutes}:${seconds}`;
}

function updateOperationProgress() {
  const elapsedSeconds = Math.max(
    0,
    Math.floor((Date.now() - state.operationProgressStartedAt) / 1_000),
  );
  const label = state.operationLabel || "Working…";
  const labelElement = element("install-progress-phase");
  labelElement.textContent = label;
  element("install-progress-bar").setAttribute("aria-valuetext", label);
  const elapsedElement = element("install-elapsed");
  elapsedElement.textContent = formatInstallElapsed(elapsedSeconds);
  elapsedElement.dateTime = `PT${elapsedSeconds}S`;
}

function startOperation(button, label, {
  markMainBusy = true,
  progressNote = "Duration varies. Keep this page open until it finishes.",
  showProgress = true,
} = {}) {
  if (state.operationBusy) return false;
  state.operationBusy = true;
  state.operationButton = button ?? null;
  state.operationControlStates = [];
  state.operationLabel = label || "Working…";
  state.operationProgressStartedAt = Date.now();

  if (button) {
    if (!button.dataset.label) {
      button.dataset.label = button.textContent.trim();
    }
    button.setAttribute("aria-busy", "true");
    button.textContent = state.operationLabel;
  }
  for (const control of operationControlCandidates()) {
    lockOperationControl(control);
  }
  if (typeof document !== "undefined") {
    document.body.dataset.operationBusy = "true";
    if (markMainBusy) {
      element("main-content").setAttribute("aria-busy", "true");
    }
  }

  const progress = element("operation-progress");
  const compatibilityProgress = element("install-progress");
  if (showProgress) {
    element("install-progress-duration-note").textContent = progressNote;
    progress.hidden = false;
    compatibilityProgress.hidden = false;
    updateOperationProgress();
    compatibilityProgress.focus?.({ preventScroll: true });
  }

  if (
    typeof MutationObserver !== "undefined" &&
    typeof document !== "undefined" &&
    document.body
  ) {
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
  if (showProgress) {
    state.operationProgressTimer = window.setInterval(
      updateOperationProgress,
      1_000,
    );
  }
  return true;
}

function stopOperation(button) {
  if (!state.operationBusy) return false;
  if (state.operationProgressTimer !== null) {
    window.clearInterval(state.operationProgressTimer);
  }
  state.operationProgressTimer = null;
  state.operationControlObserver?.disconnect?.();
  state.operationControlObserver = null;
  state.operationBusy = false;

  for (const snapshot of state.operationControlStates) {
    if (snapshot.disabled !== null) snapshot.control.disabled = snapshot.disabled;
    if (snapshot.readOnly !== null) snapshot.control.readOnly = snapshot.readOnly;
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
  if (typeof document !== "undefined") {
    document.body.dataset.operationBusy = "false";
    element("main-content").setAttribute("aria-busy", "false");
  }

  const progress = element("operation-progress");
  const activeButton = state.operationButton ?? button ?? null;
  const restoreButtonFocus =
    typeof document !== "undefined" &&
    Boolean(document.activeElement) &&
    (document.activeElement === progress ||
      progress.contains?.(document.activeElement));
  progress.hidden = true;
  element("install-progress").hidden = true;
  element("install-progress-phase").textContent = "No operation is running.";
  element("install-progress-bar").setAttribute(
    "aria-valuetext",
    "No operation is running.",
  );
  const elapsedElement = element("install-elapsed");
  elapsedElement.textContent = "00:00";
  elapsedElement.dateTime = "PT0S";

  if (activeButton) {
    activeButton.setAttribute("aria-busy", "false");
    activeButton.textContent = activeButton.dataset.label;
    if (restoreButtonFocus && !activeButton.disabled && !activeButton.hidden) {
      activeButton.focus?.({ preventScroll: true });
    }
  }
  state.operationButton = null;
  state.operationLabel = "";
  state.operationProgressStartedAt = 0;
  return true;
}

function setBusy(button, busy, busyText) {
  return busy
    ? startOperation(button, busyText)
    : stopOperation(button);
}

function setButtonLabel(button, label) {
  button.textContent = label;
  button.dataset.label = label;
}

function startInstallProgress(button) {
  const panel = element("install-panel");
  if (!startOperation(button, "Installing locally…", {
    progressNote:
      "Docker may be downloading or building. Keep this page open until it finishes.",
  })) {
    return false;
  }
  panel.setAttribute("aria-busy", "true");
  return true;
}

function stopInstallProgress(button) {
  stopOperation(button);
  element("install-settings-button").disabled =
    !state.planId || !state.plan || !element("install-confirm").checked;
  // The operation lock snapshots controls before a successful install renders
  // its removal panel. Restore the private removal confirmation after that
  // snapshot so a ready sidecar can be removed only after a new confirmation.
  if (state.installedTarget === "n8n-supergrok-oauth") {
    element("remove-supergrok-confirm").checked = false;
    element("remove-supergrok-confirm").disabled = false;
    element("remove-supergrok-button").disabled = true;
  }
  // The same snapshot would re-enable the installed model select after a
  // finalization failure or an empty catalog.
  if (state.installedSiwcModelLocked) element("installed-siwc-model").disabled = true;
  element("install-panel").setAttribute("aria-busy", "false");
}

function blockOperationInteraction(event) {
  if (
    !state.operationBusy ||
    (event.type === "keydown" && event.key === "Tab") ||
    event.target?.closest?.("#operation-progress") ||
    isOperationAllowedControl(event.target)
  ) {
    return;
  }
  event.preventDefault?.();
  event.stopImmediatePropagation?.();
}

function preferredScrollBehavior() {
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches
    ? "auto"
    : "smooth";
}

if (typeof document !== "undefined") {
  for (const eventName of OPERATION_BLOCKED_EVENTS) {
    document.addEventListener(eventName, blockOperationInteraction, true);
  }
}

function showStep(step, { showSetupProgress = true } = {}) {
  state.step = step;
  document.body.dataset.currentStep = String(step);
  element("setup-progress").hidden = !showSetupProgress;
  element("done-step-caption").hidden = !showSetupProgress;
  element("success-mark").hidden = !showSetupProgress ||
    (step === 4 && state.installedTarget === "n8n-local-model" && !state.localModelReady);

  for (const panel of document.querySelectorAll("[data-step]")) {
    const active = Number(panel.dataset.step) === step;
    panel.hidden = !active;
    if (active) {
      panel.querySelector("h2")?.focus({ preventScroll: true });
    }
  }

  for (const marker of document.querySelectorAll("[data-step-marker]")) {
    const markerStep = Number(marker.dataset.stepMarker);
    if (showSetupProgress && markerStep < step) {
      marker.dataset.state = "done";
    } else {
      delete marker.dataset.state;
    }
    if (showSetupProgress && markerStep === step) {
      marker.setAttribute("aria-current", "step");
    } else {
      marker.removeAttribute("aria-current");
    }
  }

  window.scrollTo({ top: 0, behavior: preferredScrollBehavior() });
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
      "The local Relmio wizard is not reachable. For a persistent install, run relmio status, then relmio open. For NPX, use npx --yes --ignore-scripts relmio@latest status, then npx --yes --ignore-scripts relmio@latest open. For a hosted foreground launcher, keep its terminal open and restart that launcher if needed.",
    );
  }

  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error("The local wizard returned an unreadable response.");
  }

  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("The local wizard returned an unexpected response.");
  }
  if (!response.ok) {
    const error = siwcErrorFromResponse(result, response.status);
    error.retryablePlan = result.retryablePlan === true;
    error.retryableNgrokSetup = result.retryableNgrokSetup === true;
    error.managedPartialStack = result.managedPartialStack === true;
    error.oauthRetryBlocked = result.retryBlocked === true;
    throw error;
  }
  return result;
}

const siwc = createSiwcControls({
  root: element("local-siwc"),
  api,
  onChange(account) {
    state.n8nOAuthExists = n8nOAuthReadiness(account).ready;
    invalidatePlan();
    state.catalogLabels.clear();
    element("installed-siwc-model").replaceChildren();
    element("installed-siwc-models").hidden = true;
    void forgetChatTester({ announce: false });
    element("n8n-oauth-status").textContent = n8nOAuthReadiness(account).status;
    updateReviewAvailability();
  },
  onLogin(intent) {
    if (state.operationBusy) return;
    state.n8nOAuthIntent = intent;
    element("n8n-oauth-sign-in").click();
  },
  onError: showError,
});

const siwcRecovery = createSiwcRecovery({
  root: element("local-siwc-recovery"), api,
  getTarget({ target, action }) {
    if (target !== "n8n-openai-oauth" || action !== "resume") return {};
    const n8nContainerId = element("n8n-container").value;
    const dockerNetworkId = element("n8n-network").value;
    return n8nContainerId && dockerNetworkId ? { n8nContainerId, dockerNetworkId } : {};
  },
  onReview(result) {
    state.planId = result.planId;
    state.plan = result.plan;
    state.target = result.plan.target;
    renderPlan(result.plan);
    element("install-confirm").checked = false;
    updateLocalReviewApproval();
    showStep(2);
  },
  async onResult() { await siwc.load({ welcome: false }); },
  onError: showError,
});

function dashboardContractError() {
  return new Error("The local wizard returned an unexpected dashboard response.");
}

function assertDashboardKeys(value, names) {
  if (!hasExactKeys(value, names)) throw dashboardContractError();
}

function normalizeDashboardVersion(value) {
  if (value === null) return null;
  if (typeof value !== "string" || !/^[A-Za-z0-9.+-]{1,64}$/u.test(value)) {
    throw dashboardContractError();
  }
  return value;
}

function readDashboardLoopbackPort(value) {
  const match = /^(?:http|ws):\/\/127\.0\.0\.1:(\d{1,5})(?:\/|$)/u.exec(value);
  const port = Number(match?.[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw dashboardContractError();
  }
  return port;
}

function normalizeDashboardEndpoint(value, target) {
  if (typeof value !== "string" || value.length > 256) {
    throw dashboardContractError();
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw dashboardContractError();
  }
  const expectedProtocol = target === "codex-chatgpt" ? "ws:" : "http:";
  const expectedPath = "/";
  const port = readDashboardLoopbackPort(value);
  if (
    parsed.protocol !== expectedProtocol ||
    parsed.hostname !== "127.0.0.1" ||
    parsed.pathname !== expectedPath ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535
  ) {
    throw dashboardContractError();
  }
  return value;
}

function normalizeDashboardPublicUrl(value) {
  if (typeof value !== "string" || value.length > 256) {
    throw dashboardContractError();
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw dashboardContractError();
  }
  if (
    parsed.protocol !== "https:" ||
    parsed.port !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== "" ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(parsed.hostname)
  ) {
    throw dashboardContractError();
  }
  return value;
}

function normalizeDashboardBooleans(value, names) {
  assertDashboardKeys(value, names);
  const normalized = {};
  for (const name of names) {
    if (typeof value[name] !== "boolean") throw dashboardContractError();
    normalized[name] = value[name];
  }
  return normalized;
}

function normalizeInstalledSiwc(snapshot) {
  const legacy = snapshot.migrationRequired;
  if (typeof legacy !== "boolean" || typeof snapshot.auth?.configured !== "boolean") {
    throw dashboardContractError();
  }
  const account = snapshot.auth.account === undefined ? null : normalizeSiwcAccount(snapshot.auth.account);
  if (legacy ? (snapshot.registrationId !== undefined || account !== null || snapshot.auth.configured)
    : (typeof snapshot.registrationId !== "string" ||
      !/^[A-Za-z0-9_-]{8,128}$/u.test(snapshot.registrationId) ||
      (account && account.registrationId !== snapshot.registrationId) ||
      snapshot.auth.configured !== (account?.ownership === "owned" &&
        account?.session === "connected" && account?.planPermission === "granted" &&
        account?.planEnabled === true))) throw dashboardContractError();
  if (snapshot.migrationState !== undefined &&
      (!legacy || !["incomplete", "prepared", "stopped"].includes(snapshot.migrationState) ||
        snapshot.legacyResourcesPreserved !== true)) throw dashboardContractError();
  return {
    migrationRequired: legacy,
    ...(legacy ? {} : { registrationId: snapshot.registrationId }),
    ...(snapshot.migrationState ? { migrationState: snapshot.migrationState,
      legacyResourcesPreserved: true } : {}),
    auth: { configured: snapshot.auth.configured, ...(account ? { account } : {}) },
  };
}

function normalizeEndpointDashboardSnapshot(snapshot, definition) {
  const chatgpt = ["codex-chatgpt", "codex-chat"].includes(definition.target);
  assertDashboardKeys(snapshot, chatgpt
    ? ["target", "endpoint", "auth", "canRotateCredential", "migrationRequired",
      ...(snapshot.registrationId !== undefined ? ["registrationId"] : []),
      ...(snapshot.migrationState !== undefined ? ["migrationState", "legacyResourcesPreserved"] : [])]
    : ["target", "endpoint", "auth", "canRotateCredential"]);
  assertDashboardKeys(snapshot.auth, ["configured", "disclosure",
    ...(snapshot.auth.account !== undefined ? ["account"] : [])]);
  const siwc = chatgpt ? normalizeInstalledSiwc(snapshot) : null;
  if (snapshot.target !== definition.target ||
      snapshot.auth.disclosure !== "rotate-only" ||
      snapshot.canRotateCredential !== (chatgpt && snapshot.migrationRequired ? false : true) ||
      (!chatgpt && snapshot.auth.configured !== true)) throw dashboardContractError();
  return {
    target: definition.target,
    endpoint: normalizeDashboardEndpoint(snapshot.endpoint, definition.target),
    auth: { configured: snapshot.auth.configured, disclosure: "rotate-only",
      ...(siwc?.auth.account ? { account: siwc.auth.account } : {}) },
    ...(siwc ? { migrationRequired: siwc.migrationRequired,
      ...(siwc.registrationId ? { registrationId: siwc.registrationId } : {}),
      ...(siwc.migrationState ? { migrationState: siwc.migrationState,
        legacyResourcesPreserved: true } : {}) } : {}),
    canRotateCredential: snapshot.canRotateCredential,
  };
}

function normalizeStackDashboardSnapshot(snapshot) {
  assertDashboardKeys(snapshot, [
    "target",
    "assistantMode",
    "endpoints",
    "components",
    "canResume",
    "canRemove",
  ]);
  assertDashboardKeys(snapshot.endpoints, [
    "n8nLocal",
    "ngrokPublic",
    "ngrokInspector",
  ]);
  if (
    snapshot.target !== "local-n8n-stack" ||
    !DASHBOARD_ASSISTANT_MODES.has(snapshot.assistantMode) ||
    typeof snapshot.canResume !== "boolean" ||
    snapshot.canRemove !== true
  ) {
    throw dashboardContractError();
  }
  return {
    target: "local-n8n-stack",
    assistantMode: snapshot.assistantMode,
    endpoints: {
      n8nLocal: normalizeDashboardEndpoint(snapshot.endpoints.n8nLocal, "codex-chat"),
      ngrokPublic: normalizeDashboardPublicUrl(snapshot.endpoints.ngrokPublic),
      ngrokInspector: normalizeDashboardEndpoint(
        snapshot.endpoints.ngrokInspector,
        "codex-chat",
      ),
    },
    components: normalizeDashboardBooleans(snapshot.components, [
      "n8n",
      "ngrok",
      "codeSandbox",
      "searxng",
    ]),
    canResume: snapshot.canResume,
    canRemove: true,
  };
}

function normalizeBridgeDashboardSnapshot(snapshot) {
  assertDashboardKeys(snapshot, ["target", "endpoint", "auth", "canRefreshCredential",
    "canRemove", "migrationRequired",
    ...(snapshot.registrationId !== undefined ? ["registrationId"] : []),
    ...(snapshot.migrationState !== undefined ? ["migrationState", "legacyResourcesPreserved"] : [])]);
  assertDashboardKeys(snapshot.auth, ["configured", "disclosure",
    ...(snapshot.auth.account !== undefined ? ["account"] : [])]);
  if (snapshot.target !== "n8n-openai-oauth" ||
      snapshot.endpoint !== "http://n8n-openai-oauth:10531/v1" ||
      snapshot.auth.disclosure !== "server-managed" ||
      snapshot.canRefreshCredential !== false || snapshot.canRemove !== true) throw dashboardContractError();
  const siwc = normalizeInstalledSiwc(snapshot);
  return {
    target: "n8n-openai-oauth", endpoint: snapshot.endpoint,
    auth: { configured: siwc.auth.configured, disclosure: "server-managed",
      ...(siwc.auth.account ? { account: siwc.auth.account } : {}) },
    ...(siwc.registrationId ? { registrationId: siwc.registrationId } : {}),
    migrationRequired: siwc.migrationRequired,
    ...(siwc.migrationState ? { migrationState: siwc.migrationState, legacyResourcesPreserved: true } : {}),
    canRefreshCredential: false, canRemove: true,
  };
}

function normalizeAssistantDashboardSnapshot(snapshot) {
  assertDashboardKeys(snapshot, ["target", "components", "auth", "canRemove"]);
  assertDashboardKeys(snapshot.auth, ["sandboxConfigured", "disclosure"]);
  if (
    snapshot.target !== "local-n8n-assistant" ||
    snapshot.auth.sandboxConfigured !== true ||
    snapshot.auth.disclosure !== "one-time" ||
    snapshot.canRemove !== true
  ) {
    throw dashboardContractError();
  }
  return {
    target: "local-n8n-assistant",
    components: normalizeDashboardBooleans(snapshot.components, [
      "codeSandbox",
      "searxng",
    ]),
    auth: { sandboxConfigured: true, disclosure: "one-time" },
    canRemove: true,
  };
}

function normalizeN8nSuperGrokDashboardSnapshot(snapshot) {
  assertDashboardKeys(snapshot, ["target", "endpoint", "auth", "canRemove"]);
  assertDashboardKeys(snapshot.auth, ["configured", "disclosure"]);
  if (
    snapshot.target !== "n8n-supergrok-oauth" ||
    snapshot.endpoint !== "http://n8n-supergrok:14502/v1" ||
    snapshot.auth.configured !== true ||
    snapshot.auth.disclosure !== "one-time" ||
    snapshot.canRemove !== true
  ) {
    throw dashboardContractError();
  }
  return {
    target: "n8n-supergrok-oauth",
    endpoint: "http://n8n-supergrok:14502/v1",
    auth: { configured: true, disclosure: "one-time" },
    canRemove: true,
  };
}

const LOCAL_MODEL_IDS = new Set(["qwen3:0.6b", "qwen3:1.7b", "qwen3.5:2b", "qwen3.5:4b", "qwen3.5:9b"]);

function normalizeLocalModelDashboardSnapshot(snapshot) {
  assertDashboardKeys(snapshot, ["target", "endpoint", "model", "canRetry", "canRemove"]);
  assertDashboardKeys(snapshot.model, ["state", "id", "digest"]);
  if (snapshot.target !== "n8n-local-model" ||
    snapshot.endpoint !== "http://n8n-local-model:11434/v1" ||
    !["missing", "downloading", "ready", "failed", "partial"].includes(snapshot.model.state) ||
    !LOCAL_MODEL_IDS.has(snapshot.model.id) ||
    (snapshot.model.digest !== null && !/^[a-f0-9]{64}$/u.test(snapshot.model.digest)) ||
    snapshot.canRetry !== ["missing", "failed"].includes(snapshot.model.state) ||
    snapshot.canRemove !== (snapshot.model.state !== "downloading") ||
    (snapshot.model.state === "ready" && snapshot.model.digest === null)) throw dashboardContractError();
  return {
    target: snapshot.target, endpoint: snapshot.endpoint,
    model: { state: snapshot.model.state, id: snapshot.model.id, digest: snapshot.model.digest },
    canRetry: snapshot.canRetry, canRemove: snapshot.canRemove,
  };
}

function normalizeDashboardServiceSnapshot(snapshot, definition) {
  if (definition.kind === "endpoint") {
    return normalizeEndpointDashboardSnapshot(snapshot, definition);
  }
  if (definition.kind === "n8n-stack") {
    return normalizeStackDashboardSnapshot(snapshot);
  }
  if (definition.kind === "n8n-oauth-bridge") {
    return normalizeBridgeDashboardSnapshot(snapshot);
  }
  if (definition.kind === "n8n-supergrok") {
    return normalizeN8nSuperGrokDashboardSnapshot(snapshot);
  }
  if (definition.kind === "n8n-local-model") {
    return normalizeLocalModelDashboardSnapshot(snapshot);
  }
  return normalizeAssistantDashboardSnapshot(snapshot);
}

function expectedDashboardActions(definition, serviceState, snapshot, provider) {
  if (serviceState === "absent" || serviceState === "staged") return ["setup"];
  if (serviceState === "unavailable") return [];
  if (snapshot === null) return [];
  const actions = [];
  if (serviceState === "legacy") return snapshot.migrationRequired === true ? ["setup"] : [];
  if (serviceState === "partial" && snapshot.migrationState) return [];
  if (serviceState === "stopped" && snapshot.registrationId &&
      (["codex-chatgpt", "codex-chat"].includes(snapshot.target) ||
        definition.kind === "n8n-oauth-bridge")) actions.push("inspect-stopped-chatgpt");
  if (
    definition.kind === "n8n-stack" &&
    serviceState === "stopped" &&
    snapshot.canResume === true
  ) {
    actions.push("resume");
  }
  if (
    definition.kind === "endpoint" &&
    serviceState === "healthy" &&
    snapshot.canRotateCredential === true
  ) {
    if (["codex-chatgpt", "codex-chat"].includes(definition.target)) {
      actions.push("setup");
      if (snapshot.auth.account?.ownership === "owned") {
        actions.push("sign-out-chatgpt");
        if (snapshot.auth.account.planEnabled) actions.push("disable-chatgpt-plan");
      }
    } else if (definition.target === "xai-grok-build") {
      actions.push("sign-in-grok-build", "sign-out-grok-build");
    }
    actions.push("rotate-local-capability");
  }
  if (definition.kind === "n8n-oauth-bridge" && serviceState === "healthy") {
    actions.push("setup");
    if (snapshot.auth.account?.ownership === "owned") {
      actions.push("sign-out-chatgpt");
      if (snapshot.auth.account.planEnabled) actions.push("disable-chatgpt-plan");
    }
  }
  if (definition.kind === "n8n-local-model" && snapshot.canRetry === true) {
    actions.push("retry-model");
  }
  if (definition.kind === "n8n-supergrok" && serviceState === "healthy") {
    return ["sign-in-grok-build", "sign-out-grok-build", "remove-owned-supergrok"];
  }
  if (snapshot.canRemove === true) actions.push("remove");
  return actions;
}

function normalizeDashboardProvider(value, definition) {
  assertDashboardKeys(value, ["target", "label", "authentication", "readiness"]);
  if (
    value.target !== definition.target ||
    value.label !== definition.label ||
    value.authentication !== "provider-oauth" ||
    value.readiness !== "runtime-owned"
  ) {
    throw dashboardContractError();
  }
  return { ...definition };
}

function normalizeDashboardService(service, definition, provider) {
  assertDashboardKeys(service, [
    "target",
    "label",
    "kind",
    "managed",
    "state",
    "snapshot",
    "actions",
    ...(service.state === "staged" ? ["staging"] : []),
  ]);
  if (
    service.target !== definition.target ||
    service.label !== definition.label ||
    service.kind !== definition.kind ||
    typeof service.managed !== "boolean" ||
    !DASHBOARD_SERVICE_STATES.has(service.state) ||
    !Array.isArray(service.actions) ||
    service.actions.some((action) => !DASHBOARD_ACTION_SET.has(action)) ||
    new Set(service.actions).size !== service.actions.length
  ) {
    throw dashboardContractError();
  }
  if (["absent", "unavailable"].includes(service.state)) {
    if (service.managed !== false || service.snapshot !== null) {
      throw dashboardContractError();
    }
  } else if (
    service.managed !== true ||
    (service.snapshot === null && !["partial", "staged"].includes(service.state))
  ) {
    throw dashboardContractError();
  }
  if (service.state === "staged" &&
      (!["codex-chatgpt", "codex-chat", "n8n-openai-oauth"].includes(service.target) ||
        service.snapshot !== null || !/^[A-Za-z0-9_-]{8,128}$/u.test(service.staging?.installId ?? "") ||
        !/^[A-Za-z0-9_-]{8,128}$/u.test(service.staging?.registrationId ?? "") ||
        !/^[a-z][a-z0-9-]{0,63}$/u.test(service.staging?.stage ?? ""))) throw dashboardContractError();
  const snapshot = service.snapshot === null
    ? null
    : normalizeDashboardServiceSnapshot(service.snapshot, definition);
  const expectedActions = expectedDashboardActions(
    definition,
    service.state,
    snapshot,
    provider,
  );
  if (
    expectedActions.length !== service.actions.length ||
    expectedActions.some((action, index) => action !== service.actions[index])
  ) {
    throw dashboardContractError();
  }
  return {
    target: definition.target,
    label: definition.label,
    kind: definition.kind,
    managed: service.managed,
    state: service.state,
    snapshot,
    ...(service.state === "staged" ? { staging: service.staging } : {}),
    actions: [...service.actions],
  };
}

function normalizeDashboardSnapshot(value) {
  const topLevelNames = [
    "schemaVersion",
    "generatedAt",
    "docker",
    "auth",
    "services",
    "providers",
    ...(Object.hasOwn(value ?? {}, "previewMode") ? ["previewMode"] : []),
  ];
  assertDashboardKeys(value, topLevelNames);
  assertDashboardKeys(value.docker, ["available", "version", "composeVersion"]);
  assertDashboardKeys(value.auth, ["secretsRevealable"]);
  if (
    value.schemaVersion !== 1 ||
    (Object.hasOwn(value, "previewMode") && value.previewMode !== true) ||
    typeof value.generatedAt !== "string" ||
    value.generatedAt.length > 64 ||
    typeof value.docker.available !== "boolean" ||
    value.auth.secretsRevealable !== false ||
    !Array.isArray(value.services) ||
    value.services.length !== DASHBOARD_SERVICE_DEFINITIONS.length ||
    !Array.isArray(value.providers) ||
    value.providers.length !== DASHBOARD_PROVIDER_DEFINITIONS.length
  ) {
    throw dashboardContractError();
  }
  const providers = value.providers.map((provider, index) =>
    normalizeDashboardProvider(provider, DASHBOARD_PROVIDER_DEFINITIONS[index]));
  const providersByTarget = new Map(providers.map((provider) => [provider.target, provider]));
  const generatedAt = new Date(value.generatedAt);
  if (
    !Number.isFinite(generatedAt.getTime()) ||
    generatedAt.toISOString() !== value.generatedAt
  ) {
    throw dashboardContractError();
  }
  const version = normalizeDashboardVersion(value.docker.version);
  const composeVersion = normalizeDashboardVersion(value.docker.composeVersion);
  if (
    (value.docker.available && (!version || !composeVersion)) ||
    (!value.docker.available && (version !== null || composeVersion !== null))
  ) {
    throw dashboardContractError();
  }
  return {
    schemaVersion: 1,
    generatedAt: value.generatedAt,
    docker: {
      available: value.docker.available,
      version,
      composeVersion,
    },
    auth: { secretsRevealable: false },
    services: value.services.map((service, index) =>
      normalizeDashboardService(
        service,
        DASHBOARD_SERVICE_DEFINITIONS[index],
        providersByTarget.get(service.target),
      )),
    providers,
    ...(value.previewMode === true ? { previewMode: true } : {}),
  };
}

function dashboardStateLabel(serviceState) {
  return {
    checking: "Checking",
    healthy: "Healthy",
    stopped: "Stopped",
    staged: "Staged; review resume",
    partial: "Needs recovery",
    unavailable: "Unavailable",
    stale: "Stale",
    absent: "Not configured",
  }[serviceState] ?? "Unavailable";
}

function dashboardBoundary(service) {
  if (service.kind === "endpoint") return "Loopback only";
  if (service.kind === "n8n-stack") return "Loopback + authenticated tunnel";
  return "Docker network only";
}

function dashboardServiceDescription(service) {
  if (service.state === "absent") return "Choose a connection to install.";
  if (service.state === "unavailable") {
    return "Ownership could not be verified. No maintenance actions are available.";
  }
  if (service.state === "stopped") return "Owned service is present but stopped.";
  if (service.state === "partial") {
    if (service.snapshot === null) {
      return "Relmio found an incomplete install but could not confirm a safe recovery action.";
    }
    return "Owned resources need a recovery decision before setup can continue.";
  }
  if (service.kind === "n8n-local-model") {
    if (service.state === "healthy" && service.snapshot?.model.state === "ready") {
      return "Inference check passed. No provider account is involved. That does not prove every workflow.";
    }
    if (service.snapshot?.model.state === "downloading") {
      return "The model download is still running. Settings are not ready.";
    }
    return "The runtime is owned, but model inference is not verified. Review a retry if one is available.";
  }
  if (service.kind === "n8n-assistant") {
    return "Private Assistant tools are present. You still update n8n yourself.";
  }
  return "Owned service passed the latest local inventory check.";
}

function dashboardStateNode(serviceState, className = "dashboard-state-token") {
  const node = document.createElement("span");
  node.className = `rm-badge ${className} state-${serviceState}`;
  node.textContent = dashboardStateLabel(serviceState);
  return node;
}

function dashboardStatusDot(serviceState) {
  const dot = document.createElement("span");
  dot.className = `rm-status__dot dashboard-status-dot state-${serviceState}`;
  dot.setAttribute("aria-hidden", "true");
  return dot;
}

function formatDashboardTime(value) {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function isDashboardSnapshotStale(snapshot) {
  const age = Date.now() - new Date(snapshot.generatedAt).getTime();
  return age > DASHBOARD_STALE_AFTER_MS || age < -60_000;
}

function clearDashboardStaleTimer() {
  if (state.dashboardStaleTimer !== null) {
    window.clearTimeout(state.dashboardStaleTimer);
    state.dashboardStaleTimer = null;
  }
}

function scheduleDashboardStaleExpiry(snapshot) {
  clearDashboardStaleTimer();
  if (
    document.body.dataset.localView !== "dashboard" ||
    isDashboardSnapshotStale(snapshot)
  ) {
    return;
  }
  const expiresIn = Math.max(
    0,
    new Date(snapshot.generatedAt).getTime() +
      DASHBOARD_STALE_AFTER_MS -
      Date.now() +
      1,
  );
  state.dashboardStaleTimer = window.setTimeout(() => {
    state.dashboardStaleTimer = null;
    if (
      document.body.dataset.localView !== "dashboard" ||
      state.dashboardSnapshot !== snapshot
    ) {
      return;
    }
    if (isDashboardSnapshotStale(snapshot)) {
      renderDashboardSnapshot(snapshot, { stale: true });
    } else {
      scheduleDashboardStaleExpiry(snapshot);
    }
  }, expiresIn);
}

function captureDashboardFocusIdentity() {
  const active = document.activeElement;
  const service = active?.dataset?.dashboardService;
  if (!service) return null;
  return {
    service,
    action: active.dataset.dashboardAction ?? null,
    actionLocation: active.dataset.dashboardActionLocation ?? null,
    fact: active.dataset.dashboardFact ?? null,
  };
}

function restoreDashboardFocus(identity) {
  if (!identity) return;
  const controls = Array.from(
    document.querySelectorAll("[data-dashboard-service]"),
  );
  const exact = controls.find((control) => {
    if (control.dataset.dashboardService !== identity.service) return false;
    if (identity.fact !== null) {
      return control.dataset.dashboardFact === identity.fact;
    }
    if (identity.action === null) {
      return control.dataset.dashboardControl === "select";
    }
    return control.dataset.dashboardAction === identity.action &&
      control.dataset.dashboardActionLocation === identity.actionLocation;
  });
  const fallback = controls.find((control) =>
    control.dataset.dashboardService === identity.service &&
    control.dataset.dashboardControl === "select");
  const target = exact && !exact.disabled && !exact.hidden ? exact : fallback;
  if (target && !target.disabled && !target.hidden) {
    target.focus({ preventScroll: true });
  }
}

function appendDashboardFact(
  container,
  label,
  value,
  { copyLabel = null, service = null, fact = null } = {},
) {
  const row = document.createElement("div");
  const term = document.createElement("dt");
  const detail = document.createElement("dd");
  term.textContent = label;
  if (copyLabel) {
    detail.className = "dashboard-copyable-fact";
    const displayedValue = document.createElement("code");
    displayedValue.textContent = value;
    const button = document.createElement("button");
    button.type = "button";
    button.className = "rm-icon-button rm-icon-button--outline rm-icon-button--sm dashboard-fact-copy";
    button.dataset.copyLabel = copyLabel;
    button.dataset.dashboardService = service;
    button.dataset.dashboardFact = fact;
    const icon = document.createElement("span");
    icon.className = "rm-icon rm-icon--copy rm-icon--sm";
    icon.setAttribute("aria-hidden", "true");
    button.append(icon);
    button.setAttribute("aria-label", `Copy ${copyLabel}`);
    button.setAttribute("title", `Copy ${copyLabel}`);
    button.addEventListener("click", async () => {
      const error = element("dashboard-error");
      const status = element("dashboard-copy-status");
      error.hidden = true;
      error.textContent = "";
      status.textContent = "";
      try {
        await copyText(displayedValue.textContent, button);
        flashCopied(button);
        status.textContent = `${copyLabel} copied.`;
      } catch {
        error.textContent = `Copy failed. Select the ${copyLabel} manually.`;
        error.hidden = false;
        error.focus();
      }
    });
    detail.append(displayedValue, button);
  } else {
    detail.textContent = value;
  }
  row.append(term, detail);
  container.append(row);
}

function dashboardComponentSummary(components) {
  const labels = {
    n8n: "n8n",
    ngrok: "ngrok",
    codeSandbox: "Code Sandbox",
    searxng: "SearXNG",
  };
  return Object.entries(components)
    .filter(([, enabled]) => enabled)
    .map(([name]) => labels[name])
    .join(", ") || "None verified";
}

function dashboardToWizardTarget(target) {
  return target === "local-n8n-assistant" ? "n8n-ai-assistant" : target;
}

function resetDashboardActionReview() {
  invalidatePlan();
  element("install-result-list").hidden = true;
  element("one-time-note").hidden = true;
  element("credential-rotation-note").hidden = true;
  element("client-warning").hidden = true;
  element("codex-production-warning").hidden = true;
  element("chat-tester").hidden = true;
  element("n8n-sidecar-removal").hidden = true;
  element("n8n-supergrok-removal").hidden = true;
  element("n8n-assistant-removal").hidden = true;
  element("n8n-local-model-management").hidden = true;
  invalidateLocalModelReview();
  element("n8n-stack-removal").hidden = true;
  element("n8n-stack-resume").hidden = true;
  element("result-credential").textContent = "";
  element("result-sandbox-key").textContent = "";
  element("result-n8n-settings").textContent = "";
}

function renderInstalledSiwcOwner({ target, state: serviceState, snapshot, reviewedStopped = false }) {
  const ownerPanel = element("local-siwc-owner");
  const account = snapshot?.auth?.account ?? null;
  state.installedTarget = target;
  state.installedOwner = account ? { target, account, serviceState, reviewedStopped } :
    snapshot?.registrationId ? { target, registrationId: snapshot.registrationId, serviceState } : null;
  ownerPanel.hidden = !state.installedOwner;
  const needsInspection = serviceState === "stopped" && snapshot?.registrationId && !account;
  element("local-siwc-inspect-row").hidden = !needsInspection;
  element("local-siwc-inspect").hidden = !needsInspection;
  element("local-siwc-inspect-confirm").checked = false;
  element("local-siwc-owner-confirm").checked = false;
  element("local-siwc-background-confirm").checked = false;
  const mutable = account?.ownership === "owned" && account.session !== "signed-out" &&
    (serviceState === "healthy" || reviewedStopped);
  element("local-siwc-owner-actions").hidden = !mutable;
  element("local-siwc-enable").hidden = !mutable || account.planEnabled ||
    account.planPermission !== "granted";
  element("local-siwc-background-row").hidden =
    target !== "n8n-openai-oauth" || element("local-siwc-enable").hidden;
  element("local-siwc-disable").hidden = !mutable || !account.planEnabled;
  element("local-siwc-logout").hidden = !mutable;
  for (const id of ["local-siwc-enable", "local-siwc-disable", "local-siwc-logout"]) {
    element(id).disabled = true;
  }
  element("local-siwc-replace").hidden = !(account?.session === "signed-out" &&
    account.planEnabled === false && account.ownership === "owned" && reviewedStopped);
  element("local-siwc-owner-status").textContent = snapshot?.migrationRequired
    ? "Legacy sign-in is not a Relmio SIWC registration. Review a fresh migration; old volumes stay offline."
    : serviceState === "partial"
      ? "This installation owns the registration, but its runtime could not be verified. Do not send requests; inspect it manually."
      : account
        ? `${account.label}${account.email ? ` (${account.email})` : ""} · ${account.registrationId.slice(-8)}. ${account.session === "connected"
          ? account.planEnabled ? "Using ChatGPT plan." : "Plan use paused." : "Signed out."}`
      : needsInspection
        ? "This owned service is stopped. Confirm the separate owner inspection before changing its session."
        : "The installed account could not be attested. No provider action is available.";
}

function showDashboardSiwcOwner(service) {
  if (!["codex-chatgpt", "codex-chat", "n8n-openai-oauth"].includes(service.target) ||
      !["healthy", "stopped"].includes(service.state) || !service.snapshot) {
    throw new Error("The installed ChatGPT service must be checked again.");
  }
  resetDashboardActionReview();
  clearChatTesterState();
  renderInstalledSiwcOwner(service);
  element("local-siwc-owner").open = true;
  // Plan and usage starts closed; only the running n8n sidecar keeps request counts.
  const usage = service.target === "n8n-openai-oauth" && service.state === "healthy";
  state.installedUsage = usage ? { account: service.snapshot.auth?.account ?? null, listed: null } : null;
  element("installed-usage").hidden = !usage;
  element("installed-usage").open = false;
  const codexChat = isCodexChat(service.target);
  element("chat-tester").hidden = !codexChat || service.snapshot.auth?.configured !== true;
  if (codexChat && service.snapshot.auth?.configured === true) {
    element("chat-tester-endpoint").value = service.snapshot.endpoint;
    element("chat-tester-status").textContent =
      "Secure your saved local client key. The tester reads the installed account's current model list before sending.";
  }
  element("credential-rotation-note").hidden =
    !["codex-chatgpt", "codex-chat"].includes(service.target) ||
    service.snapshot.canRotateCredential !== true;
  element("done-title").textContent = `Manage ${service.label}`;
  element("done-detail").textContent =
    "Provider session changes run at this attested installation, not from the transferred source registration. A fresh sign-in for another installation needs its own reviewed transfer.";
  showStep(4);
}

function showDashboardRotationReview(service) {
  resetDashboardActionReview();
  state.installedTarget = service.target;
  element("credential-rotation-note").hidden = false;
  element("rotate-credential-button").disabled = false;
  element("credential-rotation-note").open = true;
  element("done-title").textContent = `Rotate local capability for ${service.label}`;
  element("done-detail").textContent =
    "A replacement will be shown once, then activated and verified. The existing credential stays active until that sequence succeeds.";
  showStep(4);
  setMessage("Review the one-time local capability rotation before continuing.");
}

function showDashboardProviderRuntimeGuidance(service, action) {
  if (!["xai-grok-build", "n8n-supergrok-oauth"].includes(service.target)) {
    throw new Error("This provider guidance is not available for ChatGPT.");
  }
  resetDashboardActionReview();
  const signingOut = action === "sign-out-grok-build";
  const command = `relmio grok ${signingOut ? "logout" : "login"}${service.target === "n8n-supergrok-oauth" ? " --n8n" : ""}`;
  element("done-title").textContent = `Guidance only: ${signingOut ? "sign out of" : "sign in to"} SuperGrok`;
  element("done-detail").textContent = `Run ${command} in your terminal. Opening this guidance does not change the provider session.`;
  showStep(4, { showSetupProgress: false });
  setMessage("Guidance only: Relmio did not change the SuperGrok provider session.");
}

function showDashboardRemovalReview(service) {
  resetDashboardActionReview();
  const wizardTarget = dashboardToWizardTarget(service.target);
  state.installedTarget = wizardTarget;
  if (service.kind === "n8n-stack") {
    state.localN8nStackState = service.state;
    element("n8n-stack-removal").hidden = false;
    element("remove-n8n-stack-confirm").checked = false;
    element("remove-n8n-stack-confirm").disabled = false;
    element("remove-n8n-stack-button").disabled = true;
    element("done-title").textContent = "Review owned n8n + ngrok removal";
  } else if (service.kind === "n8n-oauth-bridge") {
    element("n8n-sidecar-removal").hidden = false;
    element("remove-bridge-confirm").checked = false;
    element("remove-bridge-confirm").disabled = false;
    element("remove-bridge-button").disabled = true;
    element("done-title").textContent = "Review bridge removal";
  } else if (service.kind === "n8n-supergrok") {
    element("n8n-supergrok-removal").hidden = false;
    element("remove-supergrok-confirm").checked = false;
    element("remove-supergrok-confirm").disabled = false;
    element("remove-supergrok-button").disabled = true;
    element("done-title").textContent = "Review SuperGrok for n8n removal";
  } else if (service.kind === "n8n-local-model") {
    element("n8n-local-model-management").hidden = false;
    element("done-title").textContent = "Review owned local model removal";
    void refreshLocalModelStatus().catch(showError);
  } else {
    element("n8n-assistant-removal").hidden = false;
    element("remove-assistant-confirm").checked = false;
    element("remove-assistant-confirm").disabled = false;
    element("remove-assistant-button").disabled = true;
    element("done-title").textContent = "Review Assistant tools removal";
  }
  document.querySelector(".ready-optional:has(> .n8n-sidecar-removal:not([hidden]))")?.setAttribute("open", "");
  element("done-detail").textContent =
    "Nothing has changed. Read the exact ownership boundary and confirm separately only if you want to continue.";
  showStep(4);
  setMessage("No removal has started. Review the separate confirmation first.");
}

async function runDashboardAction(service, action) {
  if (state.dashboardBusy || !service.actions.includes(action)) return;
  if (
    !state.dashboardSnapshot ||
    isDashboardSnapshotStale(state.dashboardSnapshot)
  ) {
    if (state.dashboardSnapshot) {
      renderDashboardSnapshot(state.dashboardSnapshot, { stale: true });
    }
    const error = element("dashboard-error");
    error.textContent =
      "This inventory snapshot expired. Refresh status before using any action.";
    error.hidden = false;
    error.focus();
    return;
  }
  const wizardTarget = dashboardToWizardTarget(service.target);
  if (action === "setup") {
    await enterSetupView(wizardTarget);
    if (service.state === "staged") {
      element("local-siwc-recovery").querySelector("details").open = true;
      await siwcRecovery.load({ target: service.target, registrationId: service.staging.registrationId });
    }
    return;
  }
  if (["sign-out-chatgpt", "disable-chatgpt-plan", "inspect-stopped-chatgpt"].includes(action)) {
    await enterSetupView(wizardTarget, { checkDocker: false });
    showDashboardSiwcOwner(service);
    return;
  }
  if (["sign-in-grok-build", "sign-out-grok-build"].includes(action)) {
    await enterSetupView(wizardTarget, { checkDocker: false });
    showDashboardProviderRuntimeGuidance(service, action);
    return;
  }
  await enterSetupView(wizardTarget, { checkDocker: false });
  if (action === "resume") {
    showStoppedManagedLocalN8nStack();
  } else if (action === "rotate-local-capability") {
    showDashboardRotationReview(service);
  } else if (action === "retry-model") {
    element("n8n-local-model-management").hidden = false;
    showStep(4);
    await refreshLocalModelStatus();
    await reviewLocalModelAction("retry");
  } else if (action === "remove" || action === "remove-owned-supergrok") {
    showDashboardRemovalReview(service);
  }
}

function renderDashboardAction(service, action, { compact = false, disabled = false } = {}) {
  if (!DASHBOARD_ACTION_SET.has(action) || !service.actions.includes(action)) return null;
  const labels = {
    setup: "Set up",
    resume: "Resume",
    remove: compact ? "Remove" : "Review removal",
    "remove-owned-supergrok": compact ? "Remove" : "Review removal",
    "sign-out-chatgpt": "Manage ChatGPT sign-out",
    "disable-chatgpt-plan": "Pause ChatGPT plan",
    "inspect-stopped-chatgpt": "Inspect stopped owner",
    "sign-in-grok-build": "Grok Build sign-in guidance",
    "sign-out-grok-build": "Grok Build sign-out guidance",
    "rotate-local-capability": compact ? "Rotate" : "Rotate local capability",
    "retry-model": "Review model retry",
  };
  const button = document.createElement("button");
  button.type = "button";
  // Add connection is the view's one primary button. Setup, resume and sign-in
  // keep the standard 40 px size in the default style; the rest stay compact.
  button.className = ["setup", "resume", "sign-in-grok-build"].includes(action)
    ? "rm-button"
    : "rm-button rm-button--sm";
  button.dataset.dashboardService = service.target;
  button.dataset.dashboardAction = action;
  button.dataset.dashboardActionLocation = compact ? "row" : "detail";
  button.textContent = labels[action];
  if (compact) {
    const accessibleLabels = {
      setup: `Set up ${service.label}`,
      resume: `Resume ${service.label}`,
      remove: `Remove ${service.label}`,
      "remove-owned-supergrok": `Remove ${service.label}`,
      "sign-out-chatgpt": `Manage ChatGPT sign-out for ${service.label}`,
      "disable-chatgpt-plan": `Pause ChatGPT plan for ${service.label}`,
      "inspect-stopped-chatgpt": `Inspect stopped ChatGPT owner for ${service.label}`,
      "sign-in-grok-build": `Grok Build sign-in guidance for ${service.label}`,
      "sign-out-grok-build": `Grok Build sign-out guidance for ${service.label}`,
      "rotate-local-capability": `Rotate local capability for ${service.label}`,
      "retry-model": `Review model retry for ${service.label}`,
    };
    button.setAttribute("aria-label", accessibleLabels[action]);
  }
  const actionDisabled = disabled || state.dashboardBusy;
  button.disabled = actionDisabled;
  if (actionDisabled) {
    button.title = state.dashboardBusy
      ? "Wait for the local inventory check to finish."
      : "Refresh the local inventory before using this action.";
  } else {
    button.addEventListener("click", () => {
      runDashboardAction(service, action).catch(() => {
        const error = element("dashboard-error");
        error.textContent = "Relmio could not open that reviewed action. Refresh status and try again.";
        error.hidden = false;
        error.focus();
      });
    });
  }
  return button;
}

function dashboardProviderForTarget(target, snapshot = state.dashboardSnapshot) {
  return snapshot?.providers?.find((provider) => provider.target === target) ?? null;
}

function dashboardProviderState(provider) {
  return provider ? "absent" : "absent";
}

function dashboardProviderReadiness(provider) {
  return provider ? "Provider-managed · not inspected" : "Not applicable";
}

function dashboardProviderAuthentication(provider) {
  return provider ? "Provider sign-in" : "Not applicable";
}

function renderDashboardRelayPath(service, provider = dashboardProviderForTarget(service.target)) {
  const relay = element("dashboard-relay");
  relay.replaceChildren();
  const runtimeState = service.state === "healthy" ? "healthy" : service.state;
  const nodes = [
    {
      label: service.kind === "n8n-local-model" ? "n8n setup" : "Local app",
      state: service.kind === "n8n-local-model" ? "stopped" : service.state,
      detail: service.kind === "n8n-local-model"
        ? "Configure and test in n8n separately"
        : service.state === "healthy" ? "Local capability configured" : dashboardStateLabel(service.state),
    },
    {
      label: "Relmio runtime",
      state: runtimeState,
      detail: runtimeState === "healthy" ? "Runtime reachable" : dashboardStateLabel(runtimeState),
    },
    {
      label: service.kind === "n8n-local-model" ? "Model inference" : "Provider / integration",
      state: service.kind === "n8n-local-model"
        ? service.snapshot?.model.state === "ready" ? "healthy" : "stopped"
        : dashboardProviderState(provider),
      detail: service.kind === "n8n-local-model"
        ? service.snapshot?.model.state === "ready" ? "Verified private inference" : "Not verified"
        : dashboardProviderReadiness(provider),
    },
  ];
  // Services without a provider sign-in end at the runtime.
  if (!provider && service.kind !== "n8n-local-model") nodes.pop();
  relay.append(
    ...nodes.map((node) => {
      const item = document.createElement("li");
      const title = document.createElement("span");
      const detail = document.createElement("small");
      title.textContent = node.label;
      detail.textContent = node.detail;
      item.append(dashboardStatusDot(node.state), title, detail);
      return item;
    }),
  );
}

function renderDashboardProvider(provider) {
  const item = document.createElement("li");
  const providerState = dashboardProviderState(provider);
  const service = DASHBOARD_SERVICE_DEFINITIONS.find(
    ({ target }) => target === provider.target,
  );
  item.append(dashboardStatusDot(providerState));
  const copy = document.createElement("span");
  const title = document.createElement("strong");
  const detail = document.createElement("small");
  title.textContent = service?.label ?? provider.label;
  detail.textContent = `Provider: ${provider.label} · ${dashboardProviderReadiness(provider)}`;
  copy.append(title, detail);
  const badge = dashboardStateNode(providerState);
  badge.textContent = "Not inspected";
  item.append(copy, badge);
  return item;
}

function renderDashboardTruth(id, label, serviceState) {
  const truth = element(id);
  truth.textContent = label;
  truth.dataset.state = serviceState;
}

function renderDashboardServiceDetail(
  service,
  { stale = false, provider = dashboardProviderForTarget(service.target) } = {},
) {
  renderFooterForTarget(service.target);
  element("dashboard-service-detail-title").textContent = service.label;
  element("dashboard-service-detail-copy").textContent = dashboardServiceDescription(service);
  const facts = element("dashboard-service-facts");
  facts.replaceChildren();
  appendDashboardFact(facts, "Boundary", dashboardBoundary(service));
  appendDashboardFact(facts, "Ownership", service.managed ? "Relmio managed" : "Not attested");
  if (provider) {
    appendDashboardFact(facts, "Authentication", dashboardProviderAuthentication(provider));
  }
  if (service.snapshot?.endpoint) {
    appendDashboardFact(facts, "Endpoint", service.snapshot.endpoint, {
      copyLabel: `${service.label} endpoint`,
      service: service.target,
      fact: "endpoint",
    });
  }
  if (service.kind === "n8n-local-model" && service.snapshot) {
    appendDashboardFact(facts, "Model", service.snapshot.model.id);
    appendDashboardFact(facts, "Inference", service.snapshot.model.state === "ready" ? "Verified by generation" : service.snapshot.model.state);
    appendDashboardFact(facts, "Authentication", "None; placeholder ignored");
  }
  if (service.state === "staged") {
    appendDashboardFact(facts, "Installation", service.staging.installId.slice(0, 12));
    appendDashboardFact(facts, "Checkpoint", service.staging.stage);
  }
  if (service.kind === "n8n-stack" && service.snapshot) {
    appendDashboardFact(facts, "Local n8n", service.snapshot.endpoints.n8nLocal, {
      copyLabel: "local n8n URL",
      service: service.target,
      fact: "n8n-local",
    });
    appendDashboardFact(facts, "Public route", service.snapshot.endpoints.ngrokPublic, {
      copyLabel: "public n8n URL",
      service: service.target,
      fact: "n8n-public",
    });
    appendDashboardFact(facts, "Inspector", service.snapshot.endpoints.ngrokInspector, {
      copyLabel: "ngrok inspector URL",
      service: service.target,
      fact: "ngrok-inspector",
    });
    appendDashboardFact(facts, "Components", dashboardComponentSummary(service.snapshot.components));
    appendDashboardFact(facts, "Assistant mode", assistantModeLabel(service.snapshot.assistantMode));
  }
  if (service.kind === "n8n-assistant" && service.snapshot) {
    appendDashboardFact(facts, "Components", dashboardComponentSummary(service.snapshot.components));
    appendDashboardFact(facts, "Sandbox credential", "Configured; shown only at creation");
  }
  if (service.kind === "endpoint" && service.snapshot) {
    appendDashboardFact(facts, "Credential", "Configured; rotate only");
  }
  if (service.kind === "n8n-oauth-bridge" && service.snapshot) {
    appendDashboardFact(facts, "Credential", "Server managed; never revealed here");
  }
  if (service.kind === "n8n-supergrok" && service.snapshot) {
    appendDashboardFact(facts, "Client bearer", "Configured; shown only at creation");
  }
  renderDashboardRelayPath(service, provider);
  const actions = element("dashboard-service-actions");
  actions.replaceChildren(
    ...service.actions
      .map((action) => renderDashboardAction(service, action, { disabled: stale }))
      .filter(Boolean),
  );
  if (actions.childElementCount === 0) {
    const note = document.createElement("p");
    note.textContent = stale
      ? "Actions are paused until a fresh inventory is available."
      : "No safe maintenance action is available for this state.";
    actions.append(note);
  }
}

function renderDashboardServiceRow(service, { selected, stale }) {
  const item = document.createElement("li");
  item.className = "dashboard-service-row";
  const select = document.createElement("button");
  select.type = "button";
  select.className = "dashboard-service-select";
  select.dataset.dashboardService = service.target;
  select.dataset.dashboardControl = "select";
  select.setAttribute("aria-pressed", String(selected));
  select.setAttribute("aria-controls", "dashboard-service-detail");
  select.append(dashboardStatusDot(service.state));
  const copy = document.createElement("span");
  copy.className = "dashboard-service-copy";
  // The row names the service, its state and boundary in full; the selected
  // connection card holds the longer description.
  const title = document.createElement("strong");
  title.textContent = service.label;
  const detail = document.createElement("small");
  detail.textContent = `${dashboardStateLabel(service.state)} · ${dashboardBoundary(service)}`;
  copy.append(title, detail);
  select.append(copy);
  select.addEventListener("click", () => {
    state.dashboardSelectedTarget = service.target;
    for (const candidate of document.querySelectorAll(".dashboard-service-select")) {
      candidate.setAttribute("aria-pressed", String(candidate === select));
    }
    renderDashboardServiceDetail(service, { stale });
  });
  item.append(select);
  const rowActions = document.createElement("div");
  rowActions.className = "dashboard-service-row-actions";
  const primaryAction = service.actions.find((action) => action !== "remove");
  const actionButton = primaryAction
    ? renderDashboardAction(service, primaryAction, { compact: true, disabled: stale })
    : null;
  if (actionButton) rowActions.append(actionButton);
  if (rowActions.childElementCount > 0) item.append(rowActions);
  return item;
}

function renderDashboardCompactService(service) {
  const item = document.createElement("li");
  item.append(dashboardStatusDot(service.state));
  const copy = document.createElement("span");
  const title = document.createElement("strong");
  const detail = document.createElement("small");
  title.textContent = service.label;
  detail.textContent = dashboardBoundary(service);
  copy.append(title, detail);
  item.append(copy, dashboardStateNode(service.state));
  return item;
}

function renderDashboardSectionStatus(label, detail, serviceState) {
  const item = document.createElement("li");
  item.append(dashboardStatusDot(serviceState));
  const copy = document.createElement("span");
  const title = document.createElement("strong");
  const supporting = document.createElement("small");
  title.textContent = label;
  supporting.textContent = detail;
  copy.append(title, supporting);
  item.append(copy, dashboardStateNode(serviceState));
  return item;
}

function renderDashboardChecking() {
  clearDashboardStaleTimer();
  state.dashboardFocusIdentity = captureDashboardFocusIdentity();
  state.dashboardBusy = true;
  state.dashboardSnapshotStale = true;
  document.body.dataset.dashboardBusy = "true";
  element("dashboard-refresh").disabled = true;
  element("dashboard-services").setAttribute("aria-busy", "true");
  for (const control of document.querySelectorAll(
    "[data-dashboard-action], .dashboard-service-select",
  )) {
    control.disabled = true;
  }
  element("dashboard-environment").className = "dashboard-environment state-checking";
  const statusDot = element("dashboard-environment").querySelector(
    ".dashboard-status-dot",
  );
  if (statusDot) statusDot.className = "rm-status__dot dashboard-status-dot state-checking";
  element("dashboard-environment-title").textContent = "Checking Docker";
  element("dashboard-environment-detail").textContent =
    "Reading a non-secret inventory from this computer.";
  element("dashboard-environment-state").className =
    "rm-badge dashboard-state-token state-checking";
  element("dashboard-environment-state").textContent = "Checking";
  renderDashboardTruth("dashboard-runtime-health", "Checking", "checking");
  renderDashboardTruth("dashboard-provider-readiness", "Checking", "checking");
  renderDashboardTruth("dashboard-inventory-freshness", "Checking", "checking");
  element("dashboard-last-checked").textContent = "Checking now";
}

function renderDashboardSnapshot(snapshot, { stale = isDashboardSnapshotStale(snapshot) } = {}) {
  const focusIdentity =
    state.dashboardFocusIdentity ?? captureDashboardFocusIdentity();
  state.dashboardFocusIdentity = null;
  state.dashboardSnapshot = snapshot;
  state.dashboardSnapshotStale = stale;
  state.dashboardBusy = false;
  document.body.dataset.dashboardBusy = "false";
  document.body.dataset.dashboardStale = String(stale);
  element("dashboard-refresh").disabled = false;
  element("dashboard-services").setAttribute("aria-busy", "false");
  const attentionStates = new Set(["stopped", "partial", "unavailable"]);
  const healthy = snapshot.services.filter(({ state: serviceState }) => serviceState === "healthy").length;
  const attention = snapshot.services.filter(({ state: serviceState }) => attentionStates.has(serviceState)).length;
  const absent = snapshot.services.filter(({ state: serviceState }) => serviceState === "absent").length;
  const providerState = "absent";
  const runtimeState = snapshot.previewMode === true || !snapshot.docker.available
      ? "unavailable"
      : attention > 0
        ? "partial"
        : "healthy";
  renderDashboardTruth(
    "dashboard-runtime-health",
    runtimeState === "healthy" ? "Healthy" : dashboardStateLabel(runtimeState),
    runtimeState,
  );
  renderDashboardTruth(
    "dashboard-provider-readiness",
    "Provider-managed · not inspected",
    providerState,
  );
  renderDashboardTruth(
    "dashboard-inventory-freshness",
    stale ? "Refresh needed" : "Current",
    stale ? "stale" : "healthy",
  );
  element("dashboard-last-checked").textContent = stale
    ? `Last verified ${formatDashboardTime(snapshot.generatedAt)}`
    : `Checked ${formatDashboardTime(snapshot.generatedAt)}`;

  const environmentState = runtimeState;
  const environment = element("dashboard-environment");
  environment.className = `dashboard-environment state-${environmentState}`;
  environment.replaceChildren(
    dashboardStatusDot(environmentState),
    (() => {
      const copy = document.createElement("div");
      const title = document.createElement("strong");
      const detail = document.createElement("p");
      title.id = "dashboard-environment-title";
      detail.id = "dashboard-environment-detail";
      title.textContent = snapshot.previewMode === true
          ? "Sanitized preview"
        : snapshot.docker.available
          ? stale ? "Docker was available at last verification" : "Docker is available"
          : stale ? "Docker was unavailable at last verification" : "Docker is unavailable";
      detail.textContent = stale
        ? "Showing the last verified snapshot. Maintenance actions are paused."
        : snapshot.previewMode === true
          ? "Live Docker discovery and maintenance are disabled in this preview."
        : snapshot.docker.available
          ? `Engine ${snapshot.docker.version}; Compose ${snapshot.docker.composeVersion}`
          : "Start Docker, then refresh. No setup or maintenance action has run.";
      copy.append(title, detail);
      return copy;
    })(),
    (() => {
      const status = dashboardStateNode(environmentState);
      status.id = "dashboard-environment-state";
      return status;
    })(),
  );

  const allAbsent = absent === snapshot.services.length;
  element("dashboard-empty").hidden = !allAbsent;
  element("dashboard-services").hidden = false;
  element("dashboard-service-detail").hidden = false;
  const selected = snapshot.services.find(
    ({ target }) => target === state.dashboardSelectedTarget,
  ) ?? snapshot.services.find(({ state: serviceState }) => serviceState !== "absent")
    ?? snapshot.services[0];
  state.dashboardSelectedTarget = selected.target;
  element("dashboard-services").replaceChildren(
    ...snapshot.services.map((service) =>
      renderDashboardServiceRow(service, {
        selected: service.target === selected.target,
        stale,
      })),
  );
  renderDashboardServiceDetail(selected, {
    stale,
    provider: dashboardProviderForTarget(selected.target, snapshot),
  });

  const n8nServices = snapshot.services.filter(
    ({ kind, state: serviceState }) =>
      kind !== "endpoint" && serviceState !== "absent",
  );
  element("dashboard-n8n-services").replaceChildren(
    ...(n8nServices.length > 0
      ? n8nServices.map(renderDashboardCompactService)
      : [renderDashboardSectionStatus(
          "No n8n services configured",
          "Start one from the Connections inventory above.",
          "absent",
        )]),
  );
  const credentialList = element("dashboard-credential-list");
  credentialList.replaceChildren(
    ...snapshot.providers.map(renderDashboardProvider),
  );
  credentialList.hidden = snapshot.providers.length === 0;

  const activity = document.createElement("li");
  activity.append(dashboardStatusDot(stale ? "stale" : environmentState));
  const activityCopy = document.createElement("span");
  activityCopy.textContent = stale
    ? "Last verified inventory retained; actions paused"
    : `Inventory verified: ${healthy} healthy, ${attention} runtime checks need attention, ${absent} not configured`;
  const time = document.createElement("time");
  time.dateTime = snapshot.generatedAt;
  time.textContent = formatDashboardTime(snapshot.generatedAt);
  activity.append(activityCopy, time);
  element("dashboard-activity-list").replaceChildren(activity);
  if (stale) clearDashboardStaleTimer();
  else scheduleDashboardStaleExpiry(snapshot);
  restoreDashboardFocus(focusIdentity);
}

function renderDashboardFailure() {
  state.dashboardBusy = false;
  state.dashboardSnapshotStale = true;
  document.body.dataset.dashboardBusy = "false";
  document.body.dataset.dashboardStale = "false";
  element("dashboard-refresh").disabled = false;
  const error = element("dashboard-error");
  error.textContent = state.dashboardSnapshot
    ? "Relmio could not refresh the local inventory. The last verified snapshot is marked stale and all maintenance actions are paused."
    : "Relmio could not safely read the local inventory. No dashboard actions are available.";
  error.hidden = false;
  if (state.dashboardSnapshot) {
    renderDashboardSnapshot(state.dashboardSnapshot, { stale: true });
    return;
  }
  const unavailableServices = DASHBOARD_SERVICE_DEFINITIONS.map(
    ({ target, label, kind }) => ({
      target,
      label,
      kind,
      managed: false,
      state: "unavailable",
      snapshot: null,
      actions: [],
    }),
  );
  element("dashboard-services").setAttribute("aria-busy", "false");
  element("dashboard-services").hidden = false;
  element("dashboard-services").replaceChildren(
    ...unavailableServices.map((service) =>
      renderDashboardServiceRow(service, { selected: false, stale: true })),
  );
  element("dashboard-empty").hidden = true;
  element("dashboard-service-detail").hidden = false;
  element("dashboard-service-detail-title").textContent = "Inventory unavailable";
  element("dashboard-service-detail-copy").textContent =
    "Relmio will not infer ownership or expose maintenance controls from an unreadable response.";
  element("dashboard-service-facts").replaceChildren();
  renderDashboardRelayPath(unavailableServices[0], null);
  element("dashboard-service-actions").replaceChildren();
  renderDashboardTruth("dashboard-runtime-health", "Unavailable", "unavailable");
  renderDashboardTruth("dashboard-provider-readiness", "Unavailable", "unavailable");
  renderDashboardTruth("dashboard-inventory-freshness", "Unavailable", "unavailable");
  element("dashboard-last-checked").textContent = "Unavailable";
  const environment = element("dashboard-environment");
  environment.className = "dashboard-environment state-unavailable";
  const statusDot = environment.querySelector(".dashboard-status-dot");
  if (statusDot) statusDot.className = "rm-status__dot dashboard-status-dot state-unavailable";
  element("dashboard-environment-title").textContent = "Local inventory unavailable";
  element("dashboard-environment-detail").textContent = "Refresh when the local wizard and Docker are ready.";
  element("dashboard-environment-state").className =
    "rm-badge dashboard-state-token state-unavailable";
  element("dashboard-environment-state").textContent = "Unavailable";

  element("dashboard-n8n-services").replaceChildren(
    renderDashboardSectionStatus(
      "n8n inventory unavailable",
      "Refresh to verify managed n8n components.",
      "unavailable",
    ),
  );
  const credentialList = element("dashboard-credential-list");
  credentialList.replaceChildren(
    renderDashboardSectionStatus(
      "Credential status unavailable",
      "No stored credential can be viewed or changed from this state.",
      "unavailable",
    ),
  );
  credentialList.hidden = false;

  const activity = document.createElement("li");
  activity.append(dashboardStatusDot("unavailable"));
  const activityCopy = document.createElement("span");
  activityCopy.textContent = "Local inventory unavailable; no actions are available";
  activity.append(activityCopy);
  element("dashboard-activity-list").replaceChildren(activity);
}

async function loadLocalDashboard() {
  renderDashboardChecking();
  element("dashboard-error").hidden = true;
  element("dashboard-error").textContent = "";
  try {
    const snapshot = normalizeDashboardSnapshot(await api("/api/local/dashboard"));
    renderDashboardSnapshot(snapshot);
  } catch {
    renderDashboardFailure();
  }
  showDashboardUsage();
}

// Plan and usage for the installed n8n sidecar, on the dashboard and the installed view. The
// counts are read on demand, and the panel module loads on first use with its stylesheet to
// keep first paint light.
let usagePanel = null;

async function loadLocalUsage(name) {
  const panel = name === "dashboard" ? state.dashboardUsage : state.installedUsage;
  if (!panel) return;
  const run = (panel.run ?? 0) + 1;
  panel.run = run;
  const current = () => panel.run === run &&
    panel === (name === "dashboard" ? state.dashboardUsage : state.installedUsage);
  const refresh = element(`${name}-usage-refresh`);
  const parts = { status: element(`${name}-usage-status`), view: element(`${name}-usage-view`) };
  const info = { page: "local", account: panel.account, models: { listed: panel.listed } };
  usagePanel ??= import("./usage-panel.js");
  const { renderUsage } = await usagePanel;
  if (!current()) return;
  renderUsage(parts, { ...info, usage: panel.view, loading: true });
  refresh.disabled = true;
  refresh.setAttribute("aria-busy", "true");
  let error = null;
  try {
    panel.view = await api("/api/local/usage/status");
  } catch (caught) {
    error = caught;
  }
  if (!current()) return;
  refresh.disabled = false;
  refresh.removeAttribute("aria-busy");
  renderUsage(parts, { ...info, usage: panel.view, error });
}

// Runs while the Plan and usage section is on screen: after each inventory check, on
// navigation to the section and on Refresh usage.
function showDashboardUsage() {
  if (element("dashboard-usage").hidden) return;
  const service = state.dashboardSnapshot?.services.find(({ target }) => target === "n8n-openai-oauth");
  const healthy = service?.state === "healthy";
  element("dashboard-usage-refresh").hidden = !healthy;
  if (!healthy) {
    state.dashboardUsage = null;
    element("dashboard-usage-view").replaceChildren();
    element("dashboard-usage-status").textContent = !service
      ? "Plan and usage shows after the inventory check."
      : ["absent", "staged"].includes(service.state)
        ? "Plan and usage shows once n8n with ChatGPT sign-in is set up on this computer. Press Add connection to set it up."
        : "The ChatGPT plan sidecar is not running, so its counts can't be read. Check it under Connections.";
    return;
  }
  const account = service.snapshot?.auth?.account ?? null;
  const prior = state.dashboardUsage;
  state.dashboardUsage = { account, listed: null,
    view: prior?.account?.registrationId === account?.registrationId ? prior.view : null };
  void loadLocalUsage("dashboard");
}

function initializeLocalUsage() {
  window.addEventListener("hashchange", showDashboardUsage);
  element("dashboard-usage-refresh").addEventListener("click", showDashboardUsage);
  element("installed-usage").addEventListener("toggle", (event) => {
    if (event.currentTarget.open) void loadLocalUsage("installed");
  });
  element("installed-usage-refresh").addEventListener("click", () => {
    void loadLocalUsage("installed");
  });
}

function clearOneTimeSetupValues() {
  for (const id of [
    "result-endpoint",
    "result-n8n",
    "result-network",
    "result-publication",
    "result-deployment",
    "result-public-url",
    "result-assistant-mode",
    "result-credential",
    "result-sandbox-key",
    "result-searxng",
    "result-n8n-settings",
    "assistant-searxng-edit-sandbox",
    "assistant-searxng-edit-search",
    "assistant-searxng-edit-result",
    "assistant-searxng-edit-settings",
  ]) {
    element(id).textContent = "";
  }
  for (const id of [
    "ngrok-authtoken",
    "ngrok-basic-auth-username",
    "ngrok-basic-auth-password",
  ]) {
    element(id).value = "";
  }
  element("chat-tester-model").replaceChildren();
  state.installedOwner = null;
  clearChatTesterState();
}

function resetPendingSetupState() {
  invalidatePlan();
  state.dashboardFocusIdentity = null;
  state.installedTarget = null;
  state.assistantSearxngReviewId = null;
  state.assistantSearxngReview = null;
  clearOneTimeSetupValues();

  for (const id of [
    "local-migration-consent", "local-replacement-consent", "local-background-consent",
    "local-siwc-inspect-confirm", "local-siwc-owner-confirm", "local-siwc-background-confirm",
    "enable-assistant-searxng-confirm", "remove-bridge-confirm",
    "remove-supergrok-confirm", "remove-assistant-confirm",
    "remove-n8n-stack-confirm", "include-local-searxng",
  ]) {
    element(id).checked = false;
  }
  for (const id of [
    "enable-assistant-searxng-confirm", "remove-bridge-confirm",
    "remove-supergrok-confirm", "remove-assistant-confirm", "remove-n8n-stack-confirm",
  ]) {
    element(id).disabled = true;
  }
  for (const id of [
    "enable-assistant-searxng-button", "remove-bridge-button",
    "remove-supergrok-button", "remove-assistant-button", "remove-n8n-stack-button",
    "local-siwc-disable", "local-siwc-logout",
  ]) {
    element(id).disabled = true;
  }
  for (const id of [
    "assistant-searxng-edit-review",
    "assistant-searxng-edit-settings",
    "install-result-list",
    "one-time-note",
    "credential-rotation-note",
    "client-warning",
    "codex-production-warning",
    "chat-tester",
    "local-siwc-owner",
    "installed-usage",
    "n8n-sidecar-removal",
    "n8n-supergrok-removal",
    "n8n-assistant-removal",
    "n8n-stack-removal",
    "n8n-stack-resume",
  ]) {
    element(id).hidden = true;
  }
  for (const details of document.querySelectorAll(".ready-columns details[open]")) {
    details.open = false;
  }
  element("n8n-oauth-link").hidden = true;
  element("n8n-oauth-link").textContent = "Stop ChatGPT sign-in";
  element("local-siwc-owner-actions").hidden = true;
  element("local-siwc-inspect-row").hidden = true;
  element("local-siwc-inspect").hidden = true;
  element("assistant-searxng-edit-status").textContent =
    "This is available only for a Relmio-owned Assistant installation without SearXNG.";
}

function focusVisibleSetupHeading() {
  if (document.body.dataset.localView !== "setup") return;
  const active = document.activeElement;
  if (
    active &&
    active !== document.body &&
    active.hidden !== true &&
    active.isConnected !== false
  ) {
    return;
  }
  document.querySelector('[data-step]:not([hidden]) h2')?.focus({
    preventScroll: true,
  });
}

async function enterSetupView(target = null, { checkDocker = true } = {}) {
  clearDashboardStaleTimer();
  element("local-dashboard").hidden = true;
  element("local-setup").hidden = false;
  document.body.dataset.localView = "setup";
  // Management views skip the Docker check, so they show no Docker status.
  document.querySelector(".docker-status").hidden = !checkDocker;
  let refreshSelectedN8n = false;
  if (target) {
    const input = document.querySelector(`input[name="target"][value="${target}"]`);
    if (!input) throw new Error("The requested setup option is unavailable.");
    input.checked = true;
    state.suppressTargetRefresh = true;
    try {
      renderTarget();
      refreshSelectedN8n = checkDocker && isN8nDockerTarget(state.target);
    } finally {
      state.suppressTargetRefresh = false;
    }
  }
  showSetupStage(target ? "configure" : "choose", { focus: false });
  showStep(1);
  if (checkDocker) await initializeLocalWizard();
  if (refreshSelectedN8n) await refreshSelectedN8nContext();
  focusVisibleSetupHeading();
}

async function enterDashboardView({
  refresh = true,
  preserveFocus = false,
  preserveScroll = false,
} = {}) {
  clearLocalModelPoll();
  element("n8n-local-model-management").hidden = true;
  clearDashboardStaleTimer();
  await api("/api/local/discard", { method: "POST", body: {} });
  resetPendingSetupState();
  element("local-setup").hidden = true;
  element("local-dashboard").hidden = false;
  document.body.dataset.localView = "dashboard";
  if (!preserveScroll) {
    window.scrollTo({ top: 0, behavior: preferredScrollBehavior() });
  }
  if (!preserveFocus) {
    element("dashboard-title").focus?.({ preventScroll: true });
  }
  if (refresh) await loadLocalDashboard();
  else if (state.dashboardSnapshot) {
    scheduleDashboardStaleExpiry(state.dashboardSnapshot);
  }
}

// The dashboard shows one section at a time so each fits one screen. The hash
// picks the section; unknown or empty hashes fall back to the overview.
function syncDashboardNavigation(hash = window.location.hash) {
  const links = Array.from(
    document.querySelectorAll("#local-dashboard-nav a"),
  );
  const requestedHash = links.some(
    (link) => link.getAttribute("href") === hash,
  )
    ? hash
    : "#dashboard-overview";
  for (const link of links) {
    const href = link.getAttribute("href");
    const current = href === requestedHash;
    if (current) {
      link.setAttribute("aria-current", "location");
    } else {
      link.removeAttribute("aria-current");
    }
    const section = document.getElementById(href.slice(1));
    if (section) section.hidden = !current;
  }
}

function initializeLocalDashboard() {
  element("dashboard-new-setup").addEventListener("click", () => {
    enterSetupView().catch(showError);
  });
  element("dashboard-empty-setup").addEventListener("click", () => {
    enterSetupView().catch(showError);
  });
  element("setup-back-to-dashboard").addEventListener("click", () => {
    enterDashboardView().catch(showError);
  });
  element("dashboard-refresh").addEventListener("click", () => {
    enterDashboardView({
      preserveFocus: true,
      preserveScroll: true,
    }).catch(renderDashboardFailure);
  });
  for (const link of document.querySelectorAll("#local-dashboard-nav a")) {
    link.addEventListener("click", () => {
      syncDashboardNavigation(link.getAttribute("href"));
    });
  }
  window.addEventListener("hashchange", () => syncDashboardNavigation());
  syncDashboardNavigation();
  enterDashboardView().catch(renderDashboardFailure);
}

function parseRelmioStreamEvent(block) {
  const dataLines = [];
  let event;
  for (const line of block.split(/\r?\n/u)) {
    if (line.startsWith("event:")) {
      event = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      dataLines.push(line.slice(5).trimStart());
    }
  }
  if (!event || dataLines.length === 0) {
    throw new Error("The local wizard returned an unreadable stream.");
  }
  let data;
  try {
    data = JSON.parse(dataLines.join("\n"));
  } catch {
    throw new Error("The local wizard returned an unreadable stream.");
  }
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("The local wizard returned an unexpected stream event.");
  }
  return { event, data };
}

async function streamChatTesterMessage(body, onEvent, { signal } = {}) {
  if (!token) {
    throw new Error(
      "This wizard link is incomplete. Close this tab. For a persistent install, run relmio open. For an NPX run, use npx --yes --ignore-scripts relmio@latest open. For a hosted foreground launcher, return to the active terminal and press Enter to create a fresh private handoff.",
    );
  }
  let response;
  try {
    response = await fetch("/api/local/chat-test/message", {
      method: "POST",
      headers: {
        Accept: "text/event-stream",
        "Content-Type": "application/json",
        "X-Setup-Token": token,
      },
      body: JSON.stringify(body),
      signal,
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new Error("The local Relmio wizard is not reachable. For a persistent install, run relmio status, then relmio open. For NPX, use npx --yes --ignore-scripts relmio@latest status, then npx --yes --ignore-scripts relmio@latest open. For a hosted foreground launcher, keep its terminal open and restart that launcher if needed.");
  }
  if (
    !response.ok ||
    !response.body ||
    !/^text\/event-stream(?:\s*;|$)/iu.test(response.headers.get("content-type") ?? "") ||
    response.headers.get("x-relmio-stream") !== "v1"
  ) {
    throw new Error("The local wizard could not start a safe response stream.");
  }
  onEvent("accepted", {});

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let exhausted = false;
  let streamError;
  let terminal;
  const consume = (block) => {
    if (!block.trim() || block.trimStart().startsWith(":")) return;
    if (terminal) {
      throw new Error("The local wizard sent data after the terminal event.");
    }
    const item = parseRelmioStreamEvent(block);
    if (item.event === "start") return;
    if (item.event === "progress" || item.event === "delta") {
      onEvent(item.event, item.data);
      return;
    }
    if (item.event === "error") {
      streamError = siwcErrorFromResponse(item.data, item.data.status ?? 502);
      return;
    }
    if (item.event === "terminal") {
      terminal = item.data;
      return;
    }
    throw new Error("The local wizard returned an unexpected stream event.");
  };

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        exhausted = true;
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const blocks = buffer.split(/\r?\n\r?\n/u);
      buffer = blocks.pop() ?? "";
      for (const block of blocks) consume(block);
    }
    buffer += decoder.decode();
    if (buffer.trim()) consume(buffer);
  } finally {
    if (!exhausted) {
      try {
        await reader.cancel();
      } catch {
        // The same-origin stream may already have closed after a parse failure.
      }
    }
    reader.releaseLock();
  }

  if (streamError) throw streamError;
  if (!terminal || terminal.outcome !== "completed" || typeof terminal.conversationId !== "string") {
    const reason = !terminal || terminal.outcome === "interrupted"
      ? "The response was interrupted. Text already received remains visible."
      : terminal.outcome === "incomplete"
        ? "The response was incomplete. Text already received remains visible."
        : "The adapter did not complete this response.";
    const error = new Error(reason);
    error.code = !terminal || terminal.outcome === "interrupted"
      ? "request_interrupted" : terminal.outcome === "incomplete" ? "response_incomplete" : "upstream_failed";
    error.recovery = "review-again";
    throw error;
  }
  return { conversationId: terminal.conversationId };
}

function selectedTarget() {
  return document.querySelector('input[name="target"]:checked')?.value;
}

function isCodexChat(target) {
  return target === "codex-chat";
}

function isGrokBuild(target) {
  return target === "xai-grok-build";
}

function isN8nSidecar(target) {
  return target === "n8n-openai-oauth";
}

function isN8nSuperGrok(target) {
  return target === "n8n-supergrok-oauth";
}

function isN8nLocalModel(target) {
  return target === "n8n-local-model";
}

function isN8nAssistant(target) {
  return target === "n8n-ai-assistant";
}

function isN8nStack(target) {
  return target === "local-n8n-stack";
}

function isN8nDockerTarget(target) {
  return isN8nSidecar(target) || isN8nSuperGrok(target) || isN8nLocalModel(target) || isN8nAssistant(target);
}

function assistantModeLabel(mode) {
  return mode === "sandbox-with-searxng"
    ? "Code Sandbox + SearXNG"
    : mode === "sandbox"
      ? "Code Sandbox"
      : "Disabled";
}

function setSelectOptions(select, options, emptyLabel, promptLabel) {
  const currentValue = select.value;
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = options.length > 0 ? promptLabel : emptyLabel;
  placeholder.disabled = options.length > 0;
  const nodes = [placeholder, ...options.map(({ label, value }) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    return option;
  })];
  select.replaceChildren(...nodes);
  if (options.some(({ value }) => value === currentValue)) {
    select.value = currentValue;
  } else {
    select.value = "";
  }
  select.disabled = options.length === 0;
}

function isAssistantNetwork(networkName) {
  return (
    networkName === "assistant-shared" ||
    networkName.endsWith("_assistant-shared")
  );
}

function isNgrokEdgeNetwork(networkName) {
  return networkName === "edge" || networkName.endsWith("_edge");
}

function networkPriority(network) {
  if (isAssistantNetwork(network.networkName)) return 0;
  if (isNgrokEdgeNetwork(network.networkName)) return 2;
  return 1;
}

function networkOptionLabel(network) {
  const recommended = "Recommended, private Assistant network";
  if (isAssistantNetwork(network.networkName)) {
    return `${recommended}, ${network.networkName}`;
  }
  if (isNgrokEdgeNetwork(network.networkName)) {
    return `${network.networkName}, also contains ngrok`;
  }
  return network.disposable
    ? `${network.networkName}, disposable test network`
    : network.networkName;
}

function updateReviewAvailability() {
  const sidecar = isN8nSidecar(state.target);
  const stack = isN8nStack(state.target);
  const n8nTarget = isN8nDockerTarget(state.target);
  const n8nReady =
    (stack && state.localN8nStackState === null) || !n8nTarget ||
    ((!sidecar || state.n8nOAuthExists) &&
      element("n8n-container").value !== "" &&
      element("n8n-network").value !== "" &&
      (!isN8nLocalModel(state.target) || LOCAL_MODEL_IDS.has(element("local-model-id").value)));
  const chatGptTarget = sidecar || isCodexChat(state.target) || state.target === "codex-chatgpt";
  element("review-button").disabled =
    !state.dockerAvailable || !n8nReady || (chatGptTarget && !state.n8nOAuthExists);
}

function renderSidecarNetworkOptions() {
  const container = state.n8nContainers.find(
    ({ containerId }) => containerId === element("n8n-container").value,
  );
  const networks = container?.networks ?? [];
  const sortedNetworks = [...networks].sort(
    (left, right) =>
      networkPriority(left) - networkPriority(right) ||
      left.networkName.localeCompare(right.networkName),
  );
  setSelectOptions(
    element("n8n-network"),
    sortedNetworks.map((network) => ({
      label: networkOptionLabel(network),
      value: network.dockerNetworkId,
    })),
    "No shared Docker network found",
    "Choose a shared Docker network",
  );
  const selectedNetwork = networks.find(
    ({ dockerNetworkId }) => dockerNetworkId === element("n8n-network").value,
  );
  element("n8n-discovery-status").textContent = selectedNetwork && isNgrokEdgeNetwork(selectedNetwork.networkName)
    ? "This network also contains ngrok. The bridge still publishes no host port, but the private Assistant network is the recommended choice."
    : selectedNetwork && isAssistantNetwork(selectedNetwork.networkName)
      ? "Recommended private Assistant network selected. Remove the bridge before tearing down a disposable test stack."
    : selectedNetwork?.disposable
      ? "This is a disposable test network. Remove the bridge before tearing the test stack down."
    : container
      ? networks.length > 0
        ? "Choose one shared Docker network. The private Assistant network is recommended when available."
        : "The selected running n8n container has no eligible shared Docker network."
      : "No running n8n container is selected.";
  invalidatePlan();
  updateReviewAvailability();
}

function validateN8nDiscovery(result) {
  if (!result || !Array.isArray(result.containers)) {
    throw new Error("The local wizard returned unexpected n8n discovery data.");
  }
  return result.containers.map((container) => {
    if (
      typeof container.containerId !== "string" ||
      typeof container.containerName !== "string" ||
      typeof container.image !== "string" ||
      !Array.isArray(container.networks)
    ) {
      throw new Error("The local wizard returned unexpected n8n discovery data.");
    }
    return {
      containerId: container.containerId,
      containerName: container.containerName,
      image: container.image,
      networks: container.networks.map((network) => {
        if (
          typeof network.dockerNetworkId !== "string" ||
          typeof network.networkName !== "string"
        ) {
          throw new Error("The local wizard returned unexpected n8n discovery data.");
        }
        return {
          dockerNetworkId: network.dockerNetworkId,
          networkName: network.networkName,
          disposable: network.disposable === true,
        };
      }),
    };
  });
}

async function refreshN8nDiscovery() {
  element("n8n-discovery-status").textContent =
    "Discovering running n8n containers without changing Docker…";
  const result = await api("/api/local/n8n/discover");
  state.n8nContainers = validateN8nDiscovery(result);
  state.n8nDiscoveryLoaded = true;
  element("detected-local-integration-management").hidden =
    isN8nSuperGrok(state.target) || isN8nLocalModel(state.target) || state.n8nContainers.length === 0;
  setSelectOptions(
    element("n8n-container"),
    state.n8nContainers.map((container) => ({
      label: `${container.containerName}, ${container.image}`,
      value: container.containerId,
    })),
    "No running n8n container found",
    "Choose a running n8n container",
  );
  renderSidecarNetworkOptions();
}

function selectN8nManagementTarget(target) {
  const targetInput = document.querySelector(
    `input[name="target"][value="${target}"]`,
  );
  if (!targetInput) {
    throw new Error("The requested n8n management option is unavailable.");
  }
  targetInput.checked = true;
  renderTarget();
}


function hasExactKeys(value, expectedNames) {
  return (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.keys(value).length === expectedNames.length &&
    expectedNames.every((name) => Object.hasOwn(value, name))
  );
}

function isSafeAssistantUrl(value, prefix) {
  return typeof value === "string" &&
    new RegExp(`^http://${prefix}-[a-f0-9]{32}:8080$`, "u").test(value);
}

function isSafeDockerDisplayName(value) {
  return typeof value === "string" &&
    value.length > 0 &&
    value.length <= 128 &&
    /^[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(value);
}


function validateAssistantSearxngReview(value) {
  const expectedNames = [
    "reviewId",
    "target",
    "includeSearxng",
    "sandboxApiKeyRotated",
    "sandboxUrl",
    "searxngUrl",
    "n8nContainerName",
    "networkName",
    "hostPublication",
    "n8nConfigurationRequired",
  ];
  if (
    !hasExactKeys(value, expectedNames) ||
    typeof value.reviewId !== "string" ||
    !/^[0-9a-f-]{36}$/iu.test(value.reviewId) ||
    value.target !== "n8n-ai-assistant" ||
    value.includeSearxng !== true ||
    value.sandboxApiKeyRotated !== false ||
    !isSafeAssistantUrl(value.sandboxUrl, "relmio-ai-sandbox") ||
    !isSafeAssistantUrl(value.searxngUrl, "relmio-ai-searxng") ||
    !isSafeDockerDisplayName(value.n8nContainerName) ||
    !isSafeDockerDisplayName(value.networkName) ||
    value.hostPublication !== "none" ||
    value.n8nConfigurationRequired !== true
  ) {
    throw new Error("The local wizard returned an unexpected Assistant edit review.");
  }
  return value;
}

function validateAssistantSearxngEnablementResult(value) {
  const expectedNames = [
    "target",
    "endpoint",
    "sandboxUrl",
    "searxngUrl",
    "protocol",
    "includeSearxng",
    "networkName",
    "n8nContainerName",
    "hostPublication",
    "privilegedRunner",
    "n8nConfigurationRequired",
    "n8nSettings",
    "deploymentMode",
    "sandboxApiKeyRotated",
  ];
  if (
    !hasExactKeys(value, expectedNames) ||
    value.target !== "n8n-ai-assistant" ||
    value.endpoint !== value.sandboxUrl ||
    !isSafeAssistantUrl(value.sandboxUrl, "relmio-ai-sandbox") ||
    !isSafeAssistantUrl(value.searxngUrl, "relmio-ai-searxng") ||
    value.protocol !== "n8n-instance-ai-companion" ||
    value.includeSearxng !== true ||
    !isSafeDockerDisplayName(value.networkName) ||
    !isSafeDockerDisplayName(value.n8nContainerName) ||
    value.hostPublication !== "none" ||
    value.privilegedRunner !== true ||
    value.n8nConfigurationRequired !== true ||
    value.deploymentMode !== "searxng-enabled" ||
    value.sandboxApiKeyRotated !== false ||
    !hasExactKeys(value.n8nSettings, ["N8N_INSTANCE_AI_SEARXNG_URL"]) ||
    value.n8nSettings.N8N_INSTANCE_AI_SEARXNG_URL !== value.searxngUrl
  ) {
    throw new Error("The local wizard returned an unexpected Assistant SearXNG response.");
  }
  return value;
}

async function refreshN8nOAuthStatus({ announce = false } = {}) {
  const status = element("n8n-oauth-status");
  status.textContent = "Checking ChatGPT registrations…";
  const account = await siwc.load({ welcome: !element("local-siwc").hidden });
  const readiness = n8nOAuthReadiness(account);
  state.n8nOAuthExists = readiness.ready;
  status.textContent = readiness.status;
  if (announce) setMessage(readiness.message);
  updateReviewAvailability();
  return account;
}

// The account card above already shows plan use, a usage limit and identity-only
// sign-in, so the sidecar status line stays empty for those and names only the
// review gate otherwise. The full sentence is still announced on request.
function n8nOAuthReadiness(account) {
  const mode = accountUiState(account);
  const limited = siwc.isUsageLimited();
  const ready = mode === "plan-active" && account?.needsPlanWelcome !== true && !limited;
  const message = ready
    ? `Using ChatGPT plan: ${account.label} · ${account.registrationId.slice(-8)}.`
    : limited ? "ChatGPT usage limit reached. Manage usage before review."
      : mode === "identity-only"
        ? "Identity connected. Allow ChatGPT plan use separately before reviewing a sidecar."
        : "Select an owned account with ChatGPT plan use enabled before reviewing a sidecar.";
  return { ready, message, status: ready || limited || mode === "identity-only" ? "" : message };
}

async function refreshSelectedN8nContext(button = null) {
  const refreshDiscovery = !state.n8nDiscoveryLoaded;
  const refreshOAuth = isN8nSidecar(state.target);
  if (!refreshDiscovery && !refreshOAuth) return;
  const label = refreshOAuth
    ? "Checking local n8n and ChatGPT sign-in…"
    : "Checking local n8n…";
  if (!startOperation(button, label)) return;
  try {
    const checks = [
      ...(refreshDiscovery
        ? [{ kind: "discovery", promise: refreshN8nDiscovery() }]
        : []),
      ...(refreshOAuth
        ? [{ kind: "oauth", promise: refreshN8nOAuthStatus() }]
        : []),
    ];
    const results = await Promise.allSettled(
      checks.map(({ promise }) => promise),
    );
    const failures = results.flatMap((result, index) => {
      if (result.status !== "rejected") return [];
      if (checks[index].kind === "discovery") {
        state.n8nDiscoveryLoaded = false;
      }
      return [result.reason];
    });
    if (failures.length > 0) {
      showError(failures[0]);
    }
  } finally {
    stopOperation(button);
    if (state.n8nDiscoveryLoaded) {
      element("n8n-container").disabled = state.n8nContainers.length === 0;
      renderSidecarNetworkOptions();
    }
    updateReviewAvailability();
  }
}

function validateOAuthAttemptId(value) {
  if (typeof value !== "string" || !/^[0-9a-f-]{8,128}$/iu.test(value)) {
    throw new Error("The wizard returned an unexpected sign-in attempt.");
  }
  return value;
}

const N8N_OAUTH_RETRY_BLOCKED_MESSAGE =
  "ChatGPT sign-in could not be stopped safely. Close the sign-in helper, then restart Relmio.";

function oauthRetryBlockedError(result) {
  const error = siwcErrorFromResponse(result, result.upstreamStatus ?? 409);
  error.oauthRetryBlocked = true;
  return error;
}

function setN8nOAuthStopVisible(visible) {
  const button = element("n8n-oauth-link");
  button.hidden = !visible;
  button.disabled = !visible;
  button.textContent = "Stop ChatGPT sign-in";
}

function blockN8nOAuthRetry() {
  state.n8nOAuthRetryBlocked = true;
  state.n8nOAuthAttemptId = null;
  setN8nOAuthStopVisible(false);
  element("n8n-oauth-sign-in").disabled = true;
  element("refresh-local-n8n-chatgpt").disabled = true;
  element("n8n-oauth-status").textContent = N8N_OAUTH_RETRY_BLOCKED_MESSAGE;
}

function disableN8nOAuthRetryControls() {
  element("n8n-oauth-sign-in").disabled = true;
  element("refresh-local-n8n-chatgpt").disabled = true;
}

async function waitForN8nOAuth(expectedAttemptId, generation) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const result = await api("/api/oauth/status");
    if (state.n8nOAuthGeneration !== generation) return false;
    if (result.retryBlocked === true) throw oauthRetryBlockedError(result);
    if (result.attemptId !== expectedAttemptId) {
      throw new Error(
        "The ChatGPT sign-in was replaced by a newer attempt. Start again.",
      );
    }
    if (result.status === "success") return true;
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

function invalidateLocalModelReview() {
  state.localModelReview = null;
  element("local-model-action-review").hidden = true;
  element("local-model-action-confirm").checked = false;
  element("local-model-cache-confirm").checked = false;
  element("local-model-apply").disabled = true;
}

function invalidatePlan() {
  state.planId = null;
  state.plan = null;
  element("install-confirm").checked = false;
  element("local-migration-consent").checked = false;
  element("local-replacement-consent").checked = false;
  element("local-background-consent").checked = false;
  element("install-button").disabled = true;
  element("install-settings-button").disabled = true;
  invalidateLocalModelReview();
}

function showDetectedManagedLocalN8nStackRecovery() {
  invalidatePlan();
  state.localN8nStackState = "partial";
  state.installedTarget = "local-n8n-stack";
  element("install-result-list").hidden = true;
  element("one-time-note").hidden = true;
  element("credential-rotation-note").hidden = true;
  element("client-warning").hidden = true;
  element("codex-production-warning").hidden = true;
  element("chat-tester").hidden = true;
  element("n8n-sidecar-removal").hidden = true;
  element("n8n-assistant-removal").hidden = true;
  element("n8n-stack-resume").hidden = true;
  element("n8n-stack-removal").hidden = false;
  element("remove-n8n-stack-confirm").checked = false;
  element("remove-n8n-stack-confirm").disabled = false;
  element("remove-n8n-stack-button").disabled = true;
  element("remove-n8n-stack-status").textContent =
    "The detected Relmio-managed stack remains until this separate removal confirmation is checked.";
  element("done-title").textContent =
    "Managed local n8n + ngrok stack needs recovery";
  element("done-detail").textContent =
    "Relmio confirmed that this owned stack is partial. Remove it below before creating a fresh local n8n + ngrok stack.";
  showStep(4);
  setMessage(
    "Review and explicitly confirm removal of the detected Relmio-managed stack before starting another setup.",
  );
}

function showStoppedManagedLocalN8nStack() {
  invalidatePlan();
  state.localN8nStackState = "stopped";
  state.installedTarget = "local-n8n-stack";
  element("install-result-list").hidden = true;
  element("one-time-note").hidden = true;
  element("credential-rotation-note").hidden = true;
  element("client-warning").hidden = true;
  element("codex-production-warning").hidden = true;
  element("chat-tester").hidden = true;
  element("n8n-sidecar-removal").hidden = true;
  element("n8n-assistant-removal").hidden = true;
  element("n8n-stack-removal").hidden = true;
  element("n8n-stack-resume").hidden = false;
  element("resume-n8n-stack-button").disabled = false;
  element("resume-n8n-stack-status").textContent =
    "The complete Relmio-owned stack is stopped. Resume starts its existing containers only.";
  element("done-title").textContent = "Managed local n8n + ngrok is stopped";
  element("done-detail").textContent =
    "Resume the exact owned stack without creating, recreating, or removing Docker resources.";
  showStep(4);
  setMessage("A complete owned local n8n + ngrok stack is stopped. Resume it safely or leave it stopped.");
}


function renderFooterForTarget(target) {
  const localModel = isN8nLocalModel(target);
  const chatGptBridge = isN8nSidecar(target);
  element("local-footer-provider").hidden = localModel || chatGptBridge;
  element("local-footer-provider").lastElementChild.textContent =
    (isCodexChat(target) || target === "codex-chatgpt")
    ? "ChatGPT sign-in starts in Relmio. Plan permission and first-use acknowledgment are separate; the installed runtime owns refresh after final approval."
    : "Provider sign-in stays in its runtime. A local key is separate and is not a Platform API key.";
  element("local-footer-chatgpt").hidden = !chatGptBridge;
  element("local-footer-model").hidden = !localModel;
}

function renderTarget() {
  clearLocalModelPoll();
  element("n8n-local-model-management").hidden = true;
  state.target = selectedTarget();
  invalidatePlan();

  const grokBuild = isGrokBuild(state.target);
  const n8nSuperGrok = isN8nSuperGrok(state.target);
  const localModel = isN8nLocalModel(state.target);
  renderFooterForTarget(state.target);
  const codexChat = isCodexChat(state.target);
  const sidecar = isN8nSidecar(state.target);
  const assistant = isN8nAssistant(state.target);
  element("local-siwc").hidden = !(sidecar || codexChat || state.target === "codex-chatgpt");
  const stack = isN8nStack(state.target);
  const n8nTarget = isN8nDockerTarget(state.target);
  const advancedTarget = codexChat || state.target === "codex-chatgpt" || assistant;
  if (advancedTarget) element("more-connections-and-tools").open = true;
  const routeLabel = localModel
    ? "Local model for n8n"
    : n8nSuperGrok
    ? "Grok for n8n"
    : grokBuild
      ? "Grok on this computer"
      : sidecar
        ? "n8n with ChatGPT sign-in"
        : stack
          ? "New n8n"
          : assistant
            ? "Assistant tools"
            : "Codex on this computer";
  element("local-route-current-label").textContent = routeLabel;
  const endpointFields = element("endpoint-fields");
  const portInput = element("local-port");
  if (!n8nTarget) {
    portInput.value = grokBuild ? "14502" : codexChat ? "14501" : "14500";
    if (portInput.getAttribute("aria-invalid") === "true") clearError();
  }
  endpointFields.hidden = n8nTarget || stack;
  portInput.disabled = n8nTarget || stack;
  portInput.required = !n8nTarget && !stack;
  element("n8n-sidecar-fields").hidden = !n8nTarget;
  element("detected-local-integration-management").hidden =
    n8nSuperGrok || localModel || state.n8nContainers.length === 0;
  element("n8n-stack-fields").hidden = !stack;
  element("n8n-stack-secrets").hidden = true;
  element("local-model-selector").hidden = !localModel;
  element("local-model-id").disabled = !localModel;
  for (const id of ["ngrok-hostname", "n8n-stack-port", "ngrok-inspector-port", "n8n-stack-timezone", "n8n-stack-assistant-mode"]) {
    element(id).disabled = !stack;
    element(id).required = stack;
  }
  for (const id of ["ngrok-authtoken", "ngrok-basic-auth-username", "ngrok-basic-auth-password"]) {
    element(id).disabled = true;
    element(id).required = false;
    element(id).value = "";
  }
  element("n8n-sidecar-oauth").hidden = !sidecar;
  element("n8n-sidecar-scope").hidden = !sidecar;
  element("supergrok-n8n-reminder").hidden = !n8nSuperGrok;
  element("n8n-assistant-options").hidden = !assistant;
  element("n8n-assistant-searxng-edit").hidden = !assistant;
  element("boundary-title").textContent = stack
    ? "This computer, plus a public link"
    : n8nTarget ? "Docker network only" : "This computer only";
  element("boundary-detail").textContent = stack
    ? "n8n and the ngrok inspector stay on this computer. The public ngrok link requires Basic Auth."
    : n8nTarget
      ? "No host port is published. Only the selected n8n Docker network can reach these services."
      : "The selected port is published on 127.0.0.1 only, not your network or the internet.";
  // The ChatGPT account card and the rail safety note already state the sidecar's sign-in,
  // transfer and one-time key facts, so its guidance would only repeat them.
  element("target-guidance").hidden = sidecar;
  element("target-guidance-title").textContent = stack
    ? "Creates a separate n8n"
    : localModel ? "Runs a model with no sign-in"
    : n8nSuperGrok ? "Uses official SuperGrok sign-in"
    : assistant ? "Adds Assistant tools"
    : grokBuild ? "Uses official SuperGrok sign-in"
    : "Uses a separate Relmio SIWC sign-in";
  element("target-guidance-detail").textContent = stack
    ? "Existing n8n is not changed. Code Sandbox, if selected, uses a privileged host-root-equivalent runner. Add the ChatGPT bridge later as a separate choice."
    : localModel ? "No host port. Other containers on the selected network can reach the model API, which has no login. Relmio checks memory and disk, then downloads into an owned cache. No cloud fallback."
    : n8nSuperGrok ? "Adds only a private sidecar. Run relmio grok login --n8n after install. This browser does not ask for a provider token."
    : assistant ? "Code Sandbox is included. SearXNG is optional and off by default. The runner is privileged and host-root equivalent. For production, use Daytona. The sandbox key is shown once. Set model credentials in n8n."
    : grokBuild ? "Private Chat Completions for local apps. Official Grok sign-in uses its own session. Clients use a separate Relmio key."
    : codexChat ? "Exposes POST /chat for a trusted local backend. The selected account's verified SIWC plan is used through public Responses; no browser CORS."
    : "Relays Codex App Server JSON-RPC over WebSocket for a trusted native client, using the selected SIWC plan and public Responses. Browsers cannot connect directly.";
  if ((codexChat || state.target === "codex-chatgpt") &&
      !element("configure-stage").hidden) siwc.load().catch(showError);
  if (n8nTarget && !state.suppressTargetRefresh) refreshSelectedN8nContext().catch(showError);
  updateReviewAvailability();
}

function appendPolicyNotice(container, heading, detail) {
  const strong = document.createElement("strong");
  const paragraph = document.createElement("p");
  strong.textContent = heading;
  paragraph.textContent = detail;
  container.replaceChildren(strong, paragraph);
}

function replaceListItems(container, items) {
  container.replaceChildren(
    ...items.map((text) => {
      const item = document.createElement("li");
      item.textContent = text;
      return item;
    }),
  );
}

function modelGigabytes(bytes) {
  return `${(bytes / 1_000_000_000).toFixed(2)} GB`;
}

function validateLocalModelPlan(plan) {
  if (!hasExactKeys(plan, [
    "kind", "target", "label", "endpoint", "n8nContainerId", "n8nContainerName",
    "dockerNetworkId", "networkName", "modelId", "catalogRevision", "runtimeImage",
    "approvedModelDigest", "contextTokens",
    "memoryBytes", "cpus", "expectedDownloadBytes", "requiredDiskBytes",
    "reservedMemoryBytes", "hostResources", "managedPath", "hostPublication",
    "authentication", "apiKeyPlaceholder", "responsesApi", "cloudEnabled",
    "experimental", "disposableHarnessWarning",
  ]) ||
    plan.kind !== "n8n-local-model" || plan.target !== "n8n-local-model" ||
    plan.endpoint !== "http://n8n-local-model:11434/v1" ||
    !LOCAL_MODEL_IDS.has(plan.modelId) || plan.catalogRevision !== "2026-09-26" ||
    plan.runtimeImage !== "ollama/ollama:0.34.4@sha256:8262851b2846b87c649eddf3e76beb270c52f4d1bc94559f47efde16b0841551" ||
    !/^sha256:[a-f0-9]{64}$/u.test(plan.approvedModelDigest) ||
    plan.managedPath !== "~/.relmio/local/n8n-local-model" ||
    plan.hostPublication !== "none" || plan.authentication !== "none" ||
    plan.apiKeyPlaceholder !== "local-only" || plan.responsesApi !== false ||
    plan.cloudEnabled !== false || plan.experimental !== true ||
    typeof plan.disposableHarnessWarning !== "boolean" ||
    !isSafeDockerDisplayName(plan.networkName) ||
    !isSafeDockerDisplayName(plan.n8nContainerName) ||
    !Number.isSafeInteger(plan.contextTokens) || plan.contextTokens <= 0 ||
    !Number.isSafeInteger(plan.memoryBytes) || plan.memoryBytes <= 0 ||
    !Number.isFinite(plan.cpus) || plan.cpus <= 0 ||
    !Number.isSafeInteger(plan.expectedDownloadBytes) || plan.expectedDownloadBytes <= 0 ||
    !Number.isSafeInteger(plan.requiredDiskBytes) || plan.requiredDiskBytes <= 0 ||
    !Number.isSafeInteger(plan.reservedMemoryBytes) || plan.reservedMemoryBytes <= 0 ||
    !hasExactKeys(plan.hostResources, ["memoryBytes", "cpus", "diskAvailableBytes"]) ||
    !Number.isSafeInteger(plan.hostResources.memoryBytes) || plan.hostResources.memoryBytes <= 0 ||
    !Number.isFinite(plan.hostResources.cpus) || plan.hostResources.cpus <= 0 ||
    !Number.isSafeInteger(plan.hostResources.diskAvailableBytes) || plan.hostResources.diskAvailableBytes <= 0) {
    throw new Error("The reviewed local model plan is invalid. Inspect Docker again.");
  }
  return plan;
}

function renderPlan(plan) {
  const grokBuild = isGrokBuild(plan.target);
  const n8nSuperGrok = isN8nSuperGrok(plan.target);
  const localModel = isN8nLocalModel(plan.target);
  const codexChat = isCodexChat(plan.target);
  const sidecar = isN8nSidecar(plan.target);
  const assistant = isN8nAssistant(plan.target);
  const stack = isN8nStack(plan.target);
  const n8nTarget = isN8nDockerTarget(plan.target);
  const chatgpt = sidecar || codexChat || plan.target === "codex-chatgpt";
  const account = chatgpt ? normalizeSiwcAccount(plan.account) : null;
  if (chatgpt && !plan.resumeRequired && (accountUiState(account) !== "plan-active" || account.needsPlanWelcome)) {
    throw new Error("The reviewed ChatGPT account no longer has an enabled plan. Review it again.");
  }
  const migrating = chatgpt && plan.migrationRequired === true;
  if (migrating && (plan.legacyResourcesPreserved !== true ||
      plan.requiresMigrationConsent !== true)) throw new Error("The legacy migration plan is incomplete.");
  const replacing = chatgpt && plan.replacementRequired === true;
  if (replacing && (migrating || plan.oldSessionSignedOut !== true ||
      plan.oldHistoryRetained !== true || plan.requiresReplacementConsent !== true)) {
    throw new Error("The account replacement plan is incomplete.");
  }
  element("review-siwc-account-row").hidden = !chatgpt;
  element("review-siwc-usage").hidden = !chatgpt;
  element("review-siwc-account").textContent = chatgpt
    ? `${account.label}${account.email ? ` (${account.email})` : ""} · ${account.registrationId.slice(-8)}`
    : "";
  element("local-migration-consent-row").hidden = !migrating;
  element("local-migration-consent").checked = false;
  element("local-replacement-consent-row").hidden = !replacing;
  element("local-replacement-consent").checked = false;
  element("review-provider-context").textContent = localModel
    ? "Local model · Chat Completions"
    : n8nSuperGrok
    ? "SuperGrok for n8n · Chat Completions"
    : sidecar
      ? "n8n with ChatGPT sign-in · Responses API on"
      : grokBuild
        ? "Grok on this computer · sign-in after install"
        : stack
          ? "New n8n · separate from existing n8n"
          : assistant
            ? "Assistant tools · you set the model in n8n"
            : "Codex on this computer";
  element("review-endpoint-label").textContent = stack ? "Local n8n URL" : assistant ? "Support services" : "Endpoint";
  element("review-endpoint").textContent = stack ? plan.localUrl : assistant ? (plan.includeSearxng ? "Code Sandbox + SearXNG" : "Code Sandbox only") : plan.endpoint;
  element("review-protocol").textContent = localModel ? "Chat Completions /v1 inside Docker" : stack ? "New local n8n with ngrok Basic Auth" : sidecar ? "OpenAI-compatible /v1 inside Docker" : n8nSuperGrok ? "Chat Completions /v1 inside Docker" : assistant ? "n8n Assistant companion services" : grokBuild ? "SuperGrok Chat Completions: /v1/chat/completions" : codexChat ? "Relmio POST /chat" : "Codex App Server JSON-RPC over WebSocket";
  element("review-auth").textContent = localModel ? "None. n8n's API key is an ignored placeholder." : stack ? "ngrok token plus Basic Auth, entered only at install" : sidecar ? "Verified Relmio SIWC registration; one-time local client key is separate" : n8nSuperGrok ? "Official SuperGrok sign-in; local key shown once" : assistant ? "Model credential is set in n8n, not here" : grokBuild ? "Official SuperGrok sign-in" : "Verified Relmio SIWC registration, with separately granted ChatGPT plan use";
  element("review-browser-row").hidden = n8nTarget || stack;
  element("review-browser").textContent = codexChat ? "No. Trusted local backends and development servers only" : "No. Trusted native local clients only";
  element("review-origins-row").hidden = true;
  for (const id of ["review-n8n-row", "review-network-row", "review-publication-row"]) element(id).hidden = !n8nTarget;
  element("review-n8n").textContent = n8nTarget ? plan.n8nContainerName : "";
  element("review-network").textContent = n8nTarget ? plan.networkName : "";
  element("review-publication").textContent = n8nTarget ? "None" : "";
  element("review-public-url-row").hidden = !stack;
  element("review-assistant-mode-row").hidden = !stack;
  element("review-public-url").textContent = stack ? plan.ngrokPublicUrl : "";
  element("review-assistant-mode").textContent = stack ? assistantModeLabel(plan.assistantMode) : "";
  element("review-path").textContent = n8nSuperGrok
    ? "~/.relmio/local/n8n-supergrok-oauth"
    : plan.managedPath ?? "Managed by Relmio";
  for (const id of ["review-model-row", "review-model-budget-row", "review-model-disk-row", "review-model-host-row", "local-model-review-details"]) {
    element(id).hidden = !localModel;
  }
  if (localModel) {
    validateLocalModelPlan(plan);
    element("local-model-review-id").textContent = plan.modelId;
    element("local-model-review-budget").textContent = `${modelGigabytes(plan.memoryBytes)} memory, ${plan.cpus} CPUs`;
    element("local-model-review-disk").textContent = `${modelGigabytes(plan.expectedDownloadBytes)} download; needs ${modelGigabytes(plan.requiredDiskBytes)} free disk`;
    element("local-model-review-host").textContent = `${modelGigabytes(plan.hostResources.memoryBytes)} memory, ${plan.hostResources.cpus} CPUs, ${modelGigabytes(plan.hostResources.diskAvailableBytes)} free disk`;
    element("local-model-review-digest").textContent = plan.approvedModelDigest;
    element("local-model-review-context").textContent = `${plan.contextTokens} tokens`;
    element("local-model-review-reserve").textContent = `${modelGigabytes(plan.reservedMemoryBytes)} for the OS, n8n and helper`;
    element("local-model-review-runtime").textContent = plan.runtimeImage;
  }
  if (stack) {
    for (const id of ["review-n8n-row", "review-network-row", "review-publication-row"]) element(id).hidden = true;
    replaceListItems(element("review-will"), ["Create a new Relmio-owned n8n stack at the shown path.", `Bind n8n to ${plan.localUrl} and the ngrok inspector to this computer only.`, `Open ${plan.ngrokPublicUrl} only through ngrok with required Basic Auth.`, `Install the selected Assistant mode: ${assistantModeLabel(plan.assistantMode)}.`]);
    replaceListItems(element("review-will-not"), ["Find, edit, restart, stop, recreate, or reuse any existing n8n.", "Publish the n8n or ngrok inspector port on your network or the internet.", "Show the ngrok token, Basic Auth password, or generated n8n encryption key.", "Add the ChatGPT bridge. Choose that later as a separate option."]);
    element("install-confirm-copy").textContent = "I reviewed this exact plan and authorize Relmio to create a new owned n8n stack and a public ngrok URL that requires Basic Auth. Existing n8n stays untouched.";
    appendPolicyNotice(element("review-policy"), "Public link needs Basic Auth", "The ngrok token and Basic Auth are entered only after this review. Code Sandbox, if selected, uses a privileged host-root-equivalent runner. For production, use Daytona. The ChatGPT bridge stays a separate choice.");
  } else if (sidecar) {
    replaceListItems(element("review-will"), [
      ...(migrating ? ["Stop only the exact old Relmio sidecar. Keep its old auth volume offline."] :
        replacing ? ["Replace only the signed-out owned sidecar. Keep its old account mapping and history offline."] : []),
      "Transfer one selected, independently authorized registration to a new user-controlled sidecar.",
      "Join the reviewed Docker network and expose port 10531 inside it only.",
      "Show a one-time Relmio client key for you to enter in n8n.",
      "Let the sidecar keep daily request and token counts on this computer for 31 days, with no prompts or answers.",
    ]);
    replaceListItems(element("review-will-not"), [
      "Edit, rebuild, restart, stop, or recreate the selected n8n container.",
      "Publish port 10531 on this computer or the internet.",
      "Import old Codex credentials or use a Platform API key.",
    ]);
    element("install-confirm-copy").textContent = `I approve this reviewed sidecar for ${account.label} on ${plan.networkName}. n8n stays unchanged. Background plan use needs separate consent.`;
    appendPolicyNotice(element("review-policy"), "Separate plan and local key",
      migrating
        ? "The old bridge is stopped only after final approval. Its auth volume stays offline. Copy the new Relmio key into n8n yourself."
        : replacing
          ? "The old sidecar was signed out before this review. Its mapping stays offline; the new registration gets a separate token owner and local client key."
          : "The installed sidecar owns future refreshes. n8n uses the one-time Relmio key you enter yourself. A listed model does not prove a completed workflow.");
  } else if (localModel) {
    replaceListItems(element("review-will"), ["Start only the pinned private model runtime on the selected n8n Docker network.", `Download ${plan.modelId} into its owned cache. The download can continue after you leave this page.`, "Check model identity and one bounded inference request before reporting ready. That check does not prove every workflow."]);
    replaceListItems(element("review-will-not"), ["Read a ChatGPT credential or provider key. There is no cloud fallback.", "Change the selected n8n container or its network.", "Publish the model on a host port, tunnel, or your network."]);
    element("install-confirm-copy").textContent = `I reviewed the measured Docker limits and authorize install and download of ${plan.modelId} into the owned cache. Other containers on this network can reach the model API. It has no login.`;
    appendPolicyNotice(element("review-policy"), "Private network, no login on the model API", "Other containers on the selected network can reach the runtime management API. A failed download keeps the cache. Deleting it later needs a separate confirmation. CPU answers can be slow. This does not install Assistant tools.");
  } else if (n8nSuperGrok) {
    replaceListItems(element("review-will"), ["Create only the new SuperGrok sidecar and its private session volume.", "Join the selected Docker network.", "Expose port 14502 only inside that network.", "Check local health. Provider sign-in and model discovery stay separate."]);
    replaceListItems(element("review-will-not"), ["Change the selected n8n container or its network.", "Publish port 14502 on this computer, your network, ngrok, or the internet.", "Ask for, show, or store a SuperGrok provider token in this browser.", "Install Code Sandbox or SearXNG."]);
    element("install-confirm-copy").textContent = "I reviewed this exact plan and authorize Relmio to start only its SuperGrok sidecar. n8n stays unchanged and no host port is published.";
    appendPolicyNotice(element("review-policy"), "Private SuperGrok sidecar", "n8n uses http://n8n-supergrok:14502/v1 with the one-time local key and Chat Completions. Run relmio grok login --n8n separately, then pick a fresh model. For workflow nodes, turn Use Responses API off and choose From list. For Assistant, enter a discovered model name. For Chat, turn Use Responses API off in Settings > Chat > OpenAI.");
  } else if (assistant) {
    replaceListItems(element("review-will"), ["Create the Code Sandbox API, certificate initializer, and privileged Docker-in-Docker runner. The runner is host-root equivalent.", plan.includeSearxng ? "Create SearXNG with JSON search on the selected private network." : "Leave web search off. No SearXNG service, settings file, or URL is created.", "Join only the sandbox API and optional SearXNG to the selected Docker network.", "Check health and that no host port is published. A health check does not prove an n8n workflow."]);
    replaceListItems(element("review-will-not"), ["Change the selected n8n container or its network.", "Publish sandbox, runner, or SearXNG ports on this computer, your network, ngrok, or the internet.", "Store a model-provider credential for n8n.", "Apply the returned n8n settings or restart n8n for you."]);
    element("install-confirm-copy").textContent = "I reviewed this exact plan and authorize Relmio to start Code Sandbox with a privileged Docker-in-Docker runner, which is host-root equivalent, and the SearXNG option I chose. This is for local testing. Relmio will not change n8n or publish a companion port. For production, use Daytona.";
    appendPolicyNotice(element("review-policy"), "Privileged companion; you update n8n", plan.includeSearxng ? "Relmio installs Code Sandbox and private SearXNG. Copy the one-time sandbox key and returned URLs into n8n yourself. Any restart is yours. For production, use Daytona." : "Relmio installs Code Sandbox without web search. Copy the one-time sandbox key and returned URL into n8n yourself. Any restart is yours. For production, use Daytona.");
  } else if (grokBuild) {
    replaceListItems(element("review-will"), ["Build one Docker image for this connection.", "Publish the selected port on 127.0.0.1 only.", "Make a separate one-time local key.", "Keep provider sign-in in a private Docker volume."]);
    replaceListItems(element("review-will-not"), ["Publish the endpoint on your network or the internet.", "Turn provider sign-in into an API key.", "Change or restart n8n.", "Reuse an existing server deployment."]);
    element("install-confirm-copy").textContent = "I reviewed this exact plan and authorize Relmio to write its managed local files and start this container.";
    appendPolicyNotice(element("review-policy"), "Experimental SuperGrok integration", "Official Grok sign-in uses a fresh private session. Relmio exposes Chat Completions for local apps. It does not take API keys, imported tokens, or switch accounts for you.");
  } else {
    replaceListItems(element("review-will"), [
      ...(migrating ? ["Stop only the attested old Relmio Codex service. Keep its old credential and workspace volumes offline."] :
        replacing ? ["Replace only the signed-out owned Codex service. Keep its old account mapping and history offline."] : []),
      "Transfer one selected SIWC registration to a new Codex runtime.",
      "Bind a separate one-time Relmio client key to the selected local port.",
      "Keep the previous account's conversation history separate.",
    ]);
    replaceListItems(element("review-will-not"), [
      "Publish the endpoint outside 127.0.0.1.",
      "Read personal Codex credentials or silently reuse the old account.",
      "Change or restart n8n.",
    ]);
    element("install-confirm-copy").textContent = `I approve this reviewed ${plan.target === "codex-chat" ? "Codex Chat Adapter" : "Codex App Server"} for ${account.label}. I will update my trusted client with the new one-time key.`;
    appendPolicyNotice(element("review-policy"), codexChat ? "Experimental Chat Adapter" : "Experimental Codex App Server",
      migrating
        ? "Legacy Codex volumes remain offline after the attested service stops. A new SIWC runtime and client key are created only after separate migration approval."
        : replacing
          ? "The old signed-out Codex state stays offline. The new registration owns a separate project, history and one-time local client key."
          : "Relmio supplies its own verified SIWC token to the Codex app-server child using public Responses. The local client key is separate from OAuth.");
  }
  if (plan.resumeRequired) {
    element("review-provider-context").textContent = `Resume ${plan.staging.installId.slice(0, 12)} · ${plan.staging.stage}`;
    replaceListItems(element("review-will"), ["Resume only this ownership-attested installation without deleting its files.",
      "Keep one refresh owner. If transfer completed, rotate the one-time local client key."]);
  }
}

function prepareInstallPanel() {
  const grokBuild = isGrokBuild(state.plan.target);
  const n8nSuperGrok = isN8nSuperGrok(state.plan.target);
  const localModel = isN8nLocalModel(state.plan.target);
  const codexChat = isCodexChat(state.plan.target);
  const sidecar = isN8nSidecar(state.plan.target);
  const assistant = isN8nAssistant(state.plan.target);
  const stack = isN8nStack(state.plan.target);
  const n8nTarget = sidecar || n8nSuperGrok || localModel || assistant || stack;
  element("codex-install-warning").hidden = n8nTarget;
  element("local-background-consent-row").hidden = !sidecar;
  element("local-background-consent").checked = false;
  element("install-button").disabled = sidecar;
  element("sidecar-install-note").hidden = !sidecar;
  element("assistant-install-note").hidden = !assistant;
  element("n8n-stack-install-note").hidden = !stack;
  element("n8n-stack-secrets").hidden = !stack;
  for (const id of ["ngrok-authtoken", "ngrok-basic-auth-username", "ngrok-basic-auth-password"]) {
    element(id).required = stack;
    element(id).disabled = !stack;
    element(id).value = "";
    element(id).setCustomValidity("");
  }
  for (const id of ["generate-ngrok-basic-auth-password", "toggle-ngrok-basic-auth-password"]) element(id).disabled = !stack;
  resetBasicAuthPasswordVisibility();
  element("codex-install-warning-title").textContent = grokBuild ? "Local key for this endpoint" : codexChat ? "Local key for a trusted backend" : "High-trust local key";
  element("codex-install-warning-detail").textContent = grokBuild
    ? "Use the one-time key only with this Relmio endpoint on 127.0.0.1. It is not a Platform API key. Official SuperGrok sign-in stays in its private runtime."
    : codexChat
      ? "This key authorizes chat through your signed-in Codex container. Keep it in a trusted local backend. Do not put it in browser code."
      : "Anyone with this key can control Codex in its container, act through your ChatGPT sign-in, and may recover that container's ChatGPT session. Treat it like your ChatGPT password. Give it only to a trusted local app.";
  element("install-intro").textContent = stack
    ? "Enter the ngrok token and Basic Auth for the reviewed new stack. They stay in this local Relmio process."
    : sidecar
      ? "Relmio checks the selected n8n and the account again. Approve this account's background workflow use, then install only the reviewed sidecar."
      : n8nSuperGrok ? "Relmio checks the selected n8n again, then installs only its private SuperGrok sidecar."
        : assistant ? "Relmio checks n8n again, then installs only its Code Sandbox services and the SearXNG option you chose."
          : grokBuild ? "Relmio installs the reviewed SuperGrok runtime. Official sign-in happens afterward."
            : "Relmio transfers the selected SIWC registration to this owned Codex runtime. The one-time local client key is separate from ChatGPT sign-in.";
  setButtonLabel(element("install-button"), stack ? "Create new local n8n + ngrok" : sidecar ? "Install private n8n bridge" : n8nSuperGrok ? "Install SuperGrok for n8n" : assistant ? "Install n8n Assistant tools" : grokBuild ? "Install SuperGrok integration" : codexChat ? "Install Codex Chat Adapter" : "Install Codex App Server");
  if (localModel) {
    element("install-intro").textContent = "Relmio checks Docker again, starts only the private runtime, and downloads the model in the background. Return here for verified readiness.";
    setButtonLabel(element("install-button"), "Install private local model");
  }
}

const ASSISTANT_SANDBOX_IMAGE =
  "ghcr.io/n8n-io/n8n-sandbox-service-sandbox:1.1.0@sha256:16f62fb90a4ce61ef74925f62ea76bb11eb2a5598888b7c0651100c7944ed2d8";
const ASSISTANT_N8N_SETTINGS_NOTE =
  "Copy only the returned settings below into n8n. Keep your N8N_ENABLED_MODULES value and make sure it still includes instance-ai.";

function hasExactAssistantSettings(value, expectedSettings) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }
  const expectedNames = Object.keys(expectedSettings);
  return (
    Object.keys(value).length === expectedNames.length &&
    expectedNames.every(
      (name) =>
        Object.hasOwn(value, name) && value[name] === expectedSettings[name],
    )
  );
}


function validateLocalModelStatus(result) {
  if (!hasExactKeys(result, [
    "target", "managed", "status", "installId", "modelId", "modelDigest",
    "endpoint", "networkName", "containerName", "resourceBudget",
    "operationId", "progress", "reason",
  ]) || result.target !== "n8n-local-model" ||
    !["absent", "unavailable", "partial", "runtime-ready", "downloading", "model-ready", "model-error"].includes(result.status) ||
    result.managed !== !["absent", "unavailable"].includes(result.status)) {
    throw new Error("The private model status is invalid.");
  }
  if (["absent", "unavailable", "partial"].includes(result.status)) {
    if (result.installId !== null || result.modelId !== null || result.modelDigest !== null ||
      result.endpoint !== null || result.progress !== null) {
      throw new Error("An unverified model cannot be configured.");
    }
    return result;
  }
  if (!LOCAL_MODEL_IDS.has(result.modelId) ||
    result.endpoint !== "http://n8n-local-model:11434/v1" ||
    !isSafeDockerDisplayName(result.networkName) ||
    !isSafeDockerDisplayName(result.containerName) ||
    !/^[a-f0-9-]{16,64}$/iu.test(result.installId) ||
    (result.modelDigest !== null && !/^[a-f0-9]{64}$/u.test(result.modelDigest)) ||
    (result.status === "model-ready" && !result.modelDigest) ||
    !hasExactKeys(result.resourceBudget, ["contextTokens", "memoryBytes", "cpus"]) ||
    !Number.isSafeInteger(result.resourceBudget.contextTokens) || result.resourceBudget.contextTokens <= 0 ||
    !Number.isSafeInteger(result.resourceBudget.memoryBytes) || result.resourceBudget.memoryBytes <= 0 ||
    !Number.isFinite(result.resourceBudget.cpus) || result.resourceBudget.cpus <= 0 ||
    (result.operationId !== null && !/^[a-f0-9]{32}$/u.test(result.operationId))) {
    throw new Error("The installed model identity is invalid.");
  }
  if (result.progress !== null && (!hasExactKeys(result.progress, ["status", "completed", "total"]) ||
    !["downloading", "verifying", "model-ready", "model-error"].includes(result.progress.status) ||
    (result.progress.completed !== null && (!Number.isSafeInteger(result.progress.completed) || result.progress.completed < 0)) ||
    (result.progress.total !== null && (!Number.isSafeInteger(result.progress.total) || result.progress.total < 0)) ||
    (result.progress.completed !== null && result.progress.total !== null && result.progress.completed > result.progress.total))) {
    throw new Error("The model transfer status is invalid.");
  }
  return result;
}

function clearLocalModelPoll() {
  if (state.localModelPollTimer !== null) window.clearTimeout(state.localModelPollTimer);
  state.localModelPollTimer = null;
  state.localModelGeneration += 1;
}

function renderLocalModelStatus(status) {
  validateLocalModelStatus(status);
  const ready = status.status === "model-ready";
  const active = status.status === "downloading";
  const owned = ["partial", "runtime-ready", "downloading", "model-ready", "model-error"].includes(status.status);
  element("n8n-local-model-management").hidden = false;
  element("local-model-settings").hidden = !ready;
  element("local-model-review-retry").hidden = !["partial", "runtime-ready", "model-error"].includes(status.status);
  element("local-model-review-remove").hidden = !owned || active;
  const messages = {
    absent: "No managed private model is installed.",
    unavailable: "Ownership could not be verified. No model settings or removal action are available.",
    partial: "Installation is incomplete or ownership is ambiguous. No model settings are available; inspect the local Docker state.",
    "runtime-ready": "The private runtime is ready, but model inference is not verified. Review a retry to download the model.",
    downloading: "Model acquisition or verification is still running. Do not configure n8n yet.",
    "model-ready": `Verified private inference for ${status.modelId}. Configure n8n using this model ID.`,
    "model-error": "The model transfer or inference verification failed. Review a retry or cache-deleting removal.",
  };
  element("local-model-state").textContent = messages[status.status];
  state.localModelReady = ready;
  const completion = ready ? "Ready" : active
    ? status.progress?.status === "verifying" ? "Verifying inference" : "Downloading model"
    : status.status === "runtime-ready" ? "Model pending" : "Needs attention";
  element("done-step-caption").textContent = `Step 4 of 4 · ${completion}`;
  element("success-mark").hidden = !ready || element("done-step-caption").hidden;
  element("done-title").textContent = ready ? "Private local model is ready"
    : active ? "Private model acquisition in progress" : "Private model needs attention";
  element("done-detail").textContent = ready
    ? "Model settings are ready for n8n. Other containers on this network can reach the model API. It has no login."
    : messages[status.status];
  if (state.step === 4 && state.installedTarget === "n8n-local-model") setMessage(messages[status.status]);
  element("local-model-progress").hidden = !active;
  element("local-model-progress").textContent = active
    ? status.progress?.completed !== null && status.progress?.completed !== undefined && status.progress?.total
      ? `${status.progress.status}: ${modelGigabytes(status.progress.completed)} / ${modelGigabytes(status.progress.total)} transferred.`
      : `${status.progress?.status === "verifying" ? "Verifying inference" : "Downloading model"}; exact progress is not available yet.`
    : "";
  element("local-model-url").textContent = ready ? status.endpoint : "";
  element("local-model-installed-id").textContent = ready ? status.modelId : "";
  if (active) scheduleLocalModelPoll();
  else clearLocalModelPoll();
}

function scheduleLocalModelPoll() {
  if (state.localModelPollTimer !== null) return;
  const generation = state.localModelGeneration;
  state.localModelPollTimer = window.setTimeout(async () => {
    state.localModelPollTimer = null;
    if (generation !== state.localModelGeneration || element("n8n-local-model-management").hidden) return;
    try {
      const status = await api("/api/local/model/operation");
      if (generation !== state.localModelGeneration || element("n8n-local-model-management").hidden) return;
      renderLocalModelStatus(status);
    } catch (error) {
      if (generation !== state.localModelGeneration) return;
      element("local-model-settings").hidden = true;
      element("local-model-review-retry").hidden = true;
      element("local-model-review-remove").hidden = true;
      element("local-model-state").textContent = "Model status could not be verified. Refresh to inspect it again.";
      showError(error);
    }
  }, 3_000);
}

async function refreshLocalModelStatus() {
  clearLocalModelPoll();
  invalidateLocalModelReview();
  element("local-model-settings").hidden = true;
  const generation = state.localModelGeneration;
  const status = await api("/api/local/model/status");
  if (generation !== state.localModelGeneration) return;
  renderLocalModelStatus(status);
}

async function reviewLocalModelAction(action) {
  clearError();
  invalidateLocalModelReview();
  const generation = state.localModelGeneration;
  try {
    const review = await api("/api/local/model/plan", {
      method: "POST",
      body: action === "remove" ? { action, removeModelData: true } : { action },
    });
    if (generation !== state.localModelGeneration) return;
    if (!hasExactKeys(review, [
      "reviewId", "action", "installId", "modelId", "endpoint", "modelDigest",
      "networkName", "containerName", "resourceBudget", "removeModelData",
    ]) || review.action !== action || !/^[a-f0-9-]{16,64}$/iu.test(review.reviewId) ||
      !LOCAL_MODEL_IDS.has(review.modelId) ||
      review.endpoint !== "http://n8n-local-model:11434/v1" ||
      review.removeModelData !== (action === "remove") ||
      !isSafeDockerDisplayName(review.networkName) ||
      !isSafeDockerDisplayName(review.containerName) ||
      !hasExactKeys(review.resourceBudget, ["contextTokens", "memoryBytes", "cpus"])) {
      throw new Error("The model action review is invalid.");
    }
    state.localModelReview = review;
    // The review hides the Ready settings and the Refresh/Review buttons; move focus off them.
    const settingsFocused = Boolean(document.activeElement?.closest("#local-model-settings, #n8n-local-model-management > .actions"));
    element("local-model-action-review").hidden = false;
    element("local-model-action-title").textContent = action === "remove" ? "Remove owned model and delete cache" : "Retry model acquisition";
    element("local-model-action-detail").textContent = `${action === "remove" ? "Stop only the owned runtime and permanently delete its downloaded weights." : "Retry the download and inference check."} Model: ${review.modelId}. Selected n8n: ${review.containerName}. Network: ${review.networkName}. Runtime budget: ${modelGigabytes(review.resourceBudget.memoryBytes)} RAM, ${review.resourceBudget.cpus} CPUs, ${review.resourceBudget.contextTokens} context tokens. n8n stays unchanged.`;
    element("local-model-cache-confirm-row").hidden = action !== "remove";
    if (settingsFocused) element("local-model-action-title").focus();
    const apply = element("local-model-apply");
    setButtonLabel(apply, action === "remove" ? "Remove model and cached weights" : "Retry model download");
    apply.classList.toggle("rm-button--danger", action === "remove");
  } catch (error) {
    invalidateLocalModelReview();
    showError(error);
  }
}

function updateLocalModelActionConfirmation() {
  const review = state.localModelReview;
  element("local-model-apply").disabled = !review || !element("local-model-action-confirm").checked ||
    (review.action === "remove" && !element("local-model-cache-confirm").checked);
}

function renderInstalledSiwcModels(models, account, { readiness = "verified", catalogFailure, runtimeFailure, finalizationFailure, runtimeState = "running", hostPublication = "none" } = {}) {
  const selector = element("installed-siwc-model");
  selector.replaceChildren();
  if (!Array.isArray(models)) throw new Error("The installed account model catalog is invalid.");
  for (const slug of models) {
    if (typeof slug !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(slug)) {
      throw new Error("The installed account model catalog is invalid.");
    }
    const option = document.createElement("option");
    option.value = slug;
    option.textContent = state.catalogLabels.get(slug) ?? slug;
    selector.append(option);
  }
  selector.disabled = models.length === 0 || Boolean(finalizationFailure);
  state.installedSiwcModelLocked = selector.disabled;
  element("installed-siwc-models").hidden = false;
  element("installed-siwc-account").textContent =
    `${account.label}${account.email ? ` (${account.email})` : ""} · ${account.registrationId.slice(-8)}.`;
  element("installed-siwc-plan-badge").hidden = Boolean(finalizationFailure) || runtimeState !== "running" || !account.planEnabled;
  const failure = finalizationFailure ?? runtimeFailure ?? catalogFailure;
  const diagnostic = failure ? siwcErrorText(siwcErrorFromResponse(failure, failure.status ?? 502)) : "";
  element("installed-siwc-model-status").textContent = finalizationFailure
    ? `Finalization did not finish. ${diagnostic}`
    : runtimeState !== "running"
    ? `The destination owns this registration, but its runtime outcome is ${runtimeState}. ${hostPublication === "unknown" ? "Host publication could not be verified. " : ""}Do not send requests; inspect the installed service manually. ${diagnostic}`
    : readiness !== "verified"
      ? `The installed account model check did not complete. Save the one-time key; do not assume model access. ${diagnostic}`
      : models.length
        ? "This account listed these models during installation. A listed model does not prove a completed request."
        : "No models were listed during installation. Secure the local tester key to check the current catalog.";
  element("installed-siwc-usage-recovery").hidden = failure?.recovery !== "manage-usage";
}

function renderInstallResult(result) {
  if (isN8nLocalModel(result?.target)) {
    renderLocalModelStatus(result);
    state.installedTarget = result.target;
    element("install-result-list").hidden = true;
    element("one-time-note").hidden = true;
    element("credential-rotation-note").hidden = true;
    element("client-warning").hidden = true;
    element("codex-production-warning").hidden = true;
    element("chat-tester").hidden = true;
    element("n8n-sidecar-removal").hidden = true;
    element("n8n-supergrok-removal").hidden = true;
    element("n8n-assistant-removal").hidden = true;
    element("n8n-stack-removal").hidden = true;
    element("n8n-stack-resume").hidden = true;
    renderFooterForTarget(result.target);
    element("done-provider-context").textContent = "Managed private model · n8n Chat Completions";
    return;
  }
  const sidecar = isN8nSidecar(result.target);
  const n8nSuperGrok = isN8nSuperGrok(result.target);
  const assistant = isN8nAssistant(result.target);
  const stack = isN8nStack(result.target);
  const n8nTarget = sidecar || n8nSuperGrok || assistant || stack;
  const endpoint = stack ? result.localUrl : result.endpoint;
  const endpointTargets = ["codex-chatgpt", "codex-chat", "xai-grok-build"];
  const assistantSettings = result?.n8nSettings;
  const expectedAssistantSettings = assistant
    ? {
        N8N_INSTANCE_AI_SANDBOX_ENABLED: "true",
        N8N_INSTANCE_AI_SANDBOX_PROVIDER: "n8n-sandbox",
        N8N_INSTANCE_AI_SANDBOX_IMAGE: ASSISTANT_SANDBOX_IMAGE,
        N8N_SANDBOX_SERVICE_URL: result.sandboxUrl,
        N8N_SANDBOX_SERVICE_API_KEY: result.sandboxApiKey,
        ...(result.includeSearxng
          ? { N8N_INSTANCE_AI_SEARXNG_URL: result.searxngUrl }
          : {}),
      }
    : null;
  const assistantResultValid =
    assistant &&
    result.protocol === "n8n-instance-ai-companion" &&
    result.endpoint === result.sandboxUrl &&
    /^http:\/\/relmio-ai-sandbox-[a-f0-9]{32}:8080$/u.test(
      result.sandboxUrl ?? "",
    ) &&
    /^[A-Za-z0-9_-]{43}$/u.test(result.sandboxApiKey ?? "") &&
    typeof result.includeSearxng === "boolean" &&
    (!result.includeSearxng ||
      /^http:\/\/relmio-ai-searxng-[a-f0-9]{32}:8080$/u.test(
        result.searxngUrl ?? "",
      )) &&
    (result.includeSearxng || !Object.hasOwn(result, "searxngUrl")) &&
    result.hostPublication === "none" &&
    result.privilegedRunner === true &&
    result.n8nConfigurationRequired === true &&
    result.credentialShownOnce === true &&
    result.deploymentMode === "installed" &&
    typeof result.networkName === "string" &&
    hasExactAssistantSettings(assistantSettings, expectedAssistantSettings);
  const n8nSuperGrokResultValid =
    n8nSuperGrok &&
    hasExactKeys(result, [
      "target",
      "endpoint",
      "baseUrl",
      "protocol",
      "networkName",
      "n8nContainerName",
      "hostPublication",
      "clientCredential",
      "credentialShownOnce",
      "deploymentMode",
      "models",
    ]) &&
    result.endpoint === "http://n8n-supergrok:14502/v1" &&
    result.baseUrl === result.endpoint &&
    result.protocol === "openai-chat-completions" &&
    isSafeDockerDisplayName(result.networkName) &&
    isSafeDockerDisplayName(result.n8nContainerName) &&
    result.hostPublication === "none" &&
    /^[A-Za-z0-9_-]{32,256}$/u.test(result.clientCredential ?? "") &&
    result.credentialShownOnce === true &&
    result.deploymentMode === "installed" &&
    Array.isArray(result.models) &&
    result.models.length === 1 &&
    result.models[0] === "grok-build";
  if (
    (["codex-chatgpt", "codex-chat", "n8n-openai-oauth"].includes(result.target) &&
      !["verified", "unverified"].includes(result.readiness)) ||
    typeof endpoint !== "string" ||
    (!n8nTarget && typeof result.clientCredential !== "string") ||
    (!endpointTargets.includes(result.target) && !n8nTarget) ||
    (assistant && !assistantResultValid) ||
    (n8nSuperGrok && !n8nSuperGrokResultValid) ||
    (sidecar &&
      (result.endpoint !== "http://n8n-openai-oauth:10531/v1" ||
        (result.hostPublication !== "none" &&
          !(result.deploymentMode === "partial" && result.runtimeState === "unknown" &&
            result.hostPublication === "unknown")) ||
        typeof result.networkName !== "string" ||
        !["installed", "migrated", "replaced", "partial"].includes(result.deploymentMode) ||
        !/^[A-Za-z0-9_-]{32,256}$/u.test(result.clientCredential ?? "") ||
        result.credentialShownOnce !== true ||
        !Array.isArray(result.models) ||
        result.models.some((model) => typeof model !== "string" ||
          !/^[A-Za-z0-9_.:-]{1,128}$/u.test(model)) ||
        !result.account))
    || (stack &&
      (!/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/u.test(result.localUrl ?? "") ||
        !/^https:\/\/[a-z0-9][a-z0-9.-]*\.[a-z0-9.-]+$/u.test(result.ngrokPublicUrl ?? "") ||
        !/^relmio-local-n8n-[a-f0-9]{32}$/u.test(result.projectName ?? "") ||
        !Array.isArray(result.containerServices) ||
        !Array.isArray(result.networks) ||
        !["disabled", "sandbox", "sandbox-with-searxng"].includes(result.assistantMode) ||
        result.deploymentMode !== "new-disposable-stack"))
  ) {
    throw new Error("The local installer returned an unexpected response.");
  }
  element("n8n-local-model-management").hidden = true;
  clearLocalModelPoll();

  const grokBuild = isGrokBuild(result.target);
  const codexChat = isCodexChat(result.target);
  element("done-provider-context").textContent = n8nSuperGrok
    ? "SuperGrok · local n8n companion · finish official sign-in before use"
    : sidecar
      ? "OpenAI OAuth · local n8n bridge · Responses API on"
      : grokBuild
        ? "SuperGrok · local endpoint · complete official sign-in before use"
        : stack
          ? "Local n8n + ngrok · owned stack"
          : assistant
            ? "Local n8n Assistant tools · n8n configuration remains yours"
            : "ChatGPT/Codex · local endpoint";
  state.installedTarget = result.target;
  element("install-result-list").hidden = false;
  element("client-warning").hidden = false;
  element("n8n-sidecar-removal").hidden = !sidecar;
  element("n8n-supergrok-removal").hidden = !n8nSuperGrok;
  element("n8n-assistant-removal").hidden = !assistant;
  element("n8n-stack-removal").hidden = !stack;
  element("n8n-stack-resume").hidden = true;
  element("remove-bridge-confirm").checked = false;
  element("remove-bridge-confirm").disabled = false;
  element("remove-bridge-button").disabled = true;
  element("remove-bridge-status").textContent =
    "The bridge remains installed until this separate confirmation is checked.";
  element("remove-supergrok-confirm").checked = false;
  element("remove-supergrok-confirm").disabled = !n8nSuperGrok;
  element("remove-supergrok-button").disabled = true;
  element("remove-supergrok-status").textContent =
    "The sidecar remains installed until this separate confirmation is checked.";
  element("remove-assistant-confirm").checked = false;
  element("remove-assistant-confirm").disabled = false;
  element("remove-assistant-button").disabled = true;
  element("remove-assistant-status").textContent =
    "The companion stack remains installed until this separate confirmation is checked.";
  element("remove-n8n-stack-confirm").checked = false;
  element("remove-n8n-stack-confirm").disabled = false;
  element("remove-n8n-stack-button").disabled = true;
  element("remove-n8n-stack-status").textContent =
    "The owned stack remains installed until this separate confirmation is checked.";
  element("result-endpoint-label").textContent = stack
    ? "Local n8n URL"
    : assistant
    ? "Sandbox Service URL"
    : "Endpoint";
  element("result-endpoint").textContent = endpoint;
  element("one-time-note").hidden = stack;
  element("one-time-note-title").textContent = assistant
    ? "Copy this sandbox key now"
    : n8nSuperGrok
      ? "Copy this local key now"
      : "Copy this key now";
  element("one-time-note-detail").textContent = assistant
    ? "Relmio shows it only once. Save it before you leave."
    : n8nSuperGrok
      ? "Relmio shows the local key only now. It cannot recover it after you leave."
      : "Relmio shows this key only now. It cannot recover it after you leave.";
  element("credential-rotation-note").hidden = n8nTarget;
  element("result-credential-row").hidden = n8nTarget && !sidecar && !n8nSuperGrok;
  element("result-credential-label").textContent = sidecar ? "One-time Relmio client key" :
    n8nSuperGrok ? "Local client bearer" : "Client credential";
  element("result-credential").textContent = !n8nTarget || sidecar || n8nSuperGrok
    ? result.clientCredential : "";
  for (const id of [
    "result-n8n-row",
    "result-network-row",
    "result-publication-row",
    "result-deployment-row",
  ]) {
    element(id).hidden = !n8nTarget;
  }
  element("result-n8n").textContent = stack
    ? result.projectName
    : n8nTarget
    ? result.n8nContainerName ?? state.plan?.n8nContainerName ?? "Selected n8n container"
    : "";
  element("result-network").textContent = stack
    ? result.networks.join(", ")
    : n8nTarget ? result.networkName : "";
  element("result-publication").textContent = stack
    ? result.hostPublication
    : sidecar ? result.hostPublication : n8nTarget ? "None" : "";
  element("result-deployment").textContent = n8nTarget ? result.deploymentMode : "";
  element("result-public-url-row").hidden = !stack;
  element("result-assistant-mode-row").hidden = !stack;
  element("result-public-url").textContent = stack ? result.ngrokPublicUrl : "";
  element("result-assistant-mode").textContent = stack
    ? assistantModeLabel(result.assistantMode)
    : "";
  element("result-sandbox-key-row").hidden = !assistant;
  element("result-searxng-row").hidden = !assistant;
  element("copy-searxng-button").hidden =
    !assistant || result.includeSearxng !== true;
  element("result-n8n-settings-row").hidden = !assistant;
  element("result-sandbox-key").textContent = assistant
    ? result.sandboxApiKey
    : "";
  element("result-searxng").textContent = assistant
    ? result.includeSearxng
      ? result.searxngUrl
      : "Not installed"
    : "";
  element("result-n8n-settings").textContent = assistant
    ? Object.entries(assistantSettings)
      .map(([name, value]) => `${name}=${value}`)
      .join("\n")
    : "";
  element("codex-production-warning").hidden = grokBuild || n8nTarget;
  element("chat-tester").hidden = n8nTarget || !codexChat || Boolean(result.finalizationFailure) ||
    (result.runtimeState !== undefined && result.runtimeState !== "running");
  if (codexChat && !state.chatTester.keyId) {
    element("chat-tester-endpoint").value = result.endpoint;
  }
  element("codex-production-warning-title").textContent = codexChat
    ? "Experimental Chat Adapter"
    : "Experimental WebSocket";
  element("codex-production-warning-detail").textContent = codexChat
    ? "It uses POST /chat, has no browser CORS, and is not OpenAI /v1."
    : "Not for production.";
  element("done-title").textContent = result.finalizationFailure
    ? "Installation needs finalization"
    : result.runtimeState && result.runtimeState !== "running"
    ? "Installation owns the account; runtime needs inspection"
    : (sidecar || result.target === "codex-chatgpt" || codexChat) && result.readiness !== "verified"
      ? "Installed; model check unverified"
      : stack ? "New local n8n is ready"
        : sidecar ? "Private n8n sidecar is installed"
          : n8nSuperGrok ? "SuperGrok for n8n is ready"
            : assistant ? "Assistant tools are ready"
              : grokBuild ? "SuperGrok endpoint is installed"
                : codexChat ? "Codex Chat Adapter is installed"
                  : "Codex App Server is installed";
  // A finalization failure or an unverified runtime holds the one-time key: save it, but
  // never tell the person to use it yet.
  const siwcTarget = sidecar || result.target === "codex-chatgpt" || codexChat;
  const runtimeUncertain = siwcTarget && result.runtimeState !== undefined && result.runtimeState !== "running";
  element("done-detail").textContent = result.finalizationFailure
    ? "Save the one-time key now. Do not use it until finalization is resolved."
    : runtimeUncertain
      ? "Save the one-time key now. Do not use it until the installed service is inspected."
      : stack
        ? "Use the local n8n URL on this computer. Check that the public URL requires Basic Auth in a private window."
        : sidecar
          ? "Copy the one-time Relmio client key into n8n yourself. The installed sidecar owns this ChatGPT session."
          : n8nSuperGrok
            ? "Run relmio grok login --n8n in a terminal before first use."
            : assistant ? "Relmio did not change or restart n8n."
              : grokBuild ? "Use the endpoint and one-time Relmio key. Finish official SuperGrok sign-in before sending a request."
                : "The selected ChatGPT plan registration is owned by this Codex installation. Copy the one-time local key into your trusted client.";
  const keyUse = sidecar ? "you enter the key in n8n" : "a client uses this key";
  appendPolicyNotice(
    element("client-warning"),
    result.finalizationFailure || runtimeUncertain
      ? "Do not use this key yet"
      : stack
        ? "Public link needs Basic Auth"
        : sidecar
          ? "Turn Responses API on in n8n"
          : n8nSuperGrok
            ? "Selected n8n only"
            : assistant
              ? "You update n8n"
              : grokBuild
                ? "Trusted local apps"
                : codexChat
                  ? "Trusted local backends only"
                  : "Trusted local apps only",
    result.finalizationFailure
      ? `The installation owns the account, but finalization did not finish. Review the installed target again before ${keyUse}.`
      : runtimeUncertain
        ? `The installation owns the account, but its runtime${result.hostPublication === "unknown" ? " and host publication" : ""} could not be verified. Inspect the owned service before ${keyUse}.`
        : stack
          ? "Use the local n8n URL on this computer. Open the public URL in a private window first. It must stay blocked until Basic Auth succeeds. This does not publish the n8n or inspector port. Export workflows before you remove this stack. Existing n8n stays untouched."
          : sidecar
            ? "No Code Sandbox or SearXNG is installed with this bridge."
            : n8nSuperGrok
              ? "In n8n, set the base URL to http://n8n-supergrok:14502/v1 and use the one-time local key with Chat Completions. Workflow nodes: turn Use Responses API off and choose From list. Assistant: enter a discovered model name. Chat: turn Use Responses API off in Settings > Chat > OpenAI. No host port is published. Sign out with relmio grok logout --n8n."
              : assistant
                ? result.includeSearxng
                  ? `${ASSISTANT_N8N_SETTINGS_NOTE} Restart n8n yourself. Code Sandbox and SearXNG were checked. No host port is published. The runner is privileged and host-root equivalent. For production, use Daytona.`
                  : `${ASSISTANT_N8N_SETTINGS_NOTE} Restart n8n yourself. Code Sandbox was checked. SearXNG was not installed. No host port is published. The runner is privileged and host-root equivalent. For production, use Daytona.`
                : grokBuild
                  ? "Use the one-time key only with this Relmio endpoint. Sign-in stays in its private runtime. This binds to 127.0.0.1. A private Docker connection for n8n is a separate reviewed setup."
                  : codexChat
                    ? "Use this key only as a Bearer token from a trusted local backend. It is not a Platform API key."
                    : "This key is not a Platform API key. Treat it like your ChatGPT password. The client can control the container and may recover its ChatGPT session. It must speak Codex App Server JSON-RPC over WebSocket.",
  );
  if (sidecar || result.target === "codex-chatgpt" || codexChat) {
    const account = normalizeSiwcAccount(result.account);
    renderInstalledSiwcModels(result.models, account, result);
    renderInstalledSiwcOwner({ target: result.target,
      state: result.runtimeState && result.runtimeState !== "running" ? "partial" : "healthy",
      snapshot: { registrationId: account.registrationId,
        migrationRequired: false, auth: { configured: result.runtimeState !== "unknown" &&
          result.runtimeState !== "stopped" && account.planEnabled, account } } });
    // Session changes are a secondary task on the Ready step.
    element("local-siwc-owner").open = false;
    // Plan and usage reads the counts when opened; only the running n8n sidecar keeps them.
    const usage = sidecar && (result.runtimeState ?? "running") === "running" && !result.finalizationFailure;
    state.installedUsage = usage ? { account, listed: result.models.length } : null;
    element("installed-usage").hidden = !usage;
    element("installed-usage").open = false;
  } else {
    element("installed-siwc-models").hidden = true;
    element("local-siwc-owner").hidden = true;
    element("installed-usage").hidden = true;
  }
}

function setChatTesterStatus(text) {
  element("chat-tester-status").textContent = text;
}

function chatTesterStatusMessage(phase) {
  if (phase === "Sending") return "Sending the message to the local adapter.";
  if (phase === "Connecting") return "Connecting to the local adapter.";
  if (phase === "Waiting") return "The local adapter is preparing a response.";
  if (phase === "Streaming") return "The local adapter is responding.";
  if (phase === "Complete") return "Response complete. Continue this conversation or forget the tester.";
  if (phase === "Stopping") return "Stopping the local adapter response.";
  if (phase === "Stopped") return "Response stopped. Text already received remains visible.";
  if (phase === "Failed") return "Response failed. Review the error and retry when ready.";
  return "Secure the local client credential to begin.";
}

function clearChatTesterError() {
  element("chat-tester-error").textContent = "";
  element("chat-tester-error").hidden = true;
  element("chat-tester-usage").hidden = true;
}

function showChatTesterError(error) {
  const box = element("chat-tester-error");
  box.textContent = siwcErrorText(error);
  box.hidden = false;
  element("chat-tester-usage").hidden = error?.recovery !== "manage-usage";
  revealChatTesterError();
  box.focus({ preventScroll: true });
}

// Scrolls a shown error, then its Manage usage recovery, into the panel's
// visible area, so neither sits below the window or under the footer.
function revealChatTesterError() {
  const box = element("chat-tester-error");
  const usage = element("chat-tester-usage");
  if (box.hidden) return;
  box.scrollIntoView?.({ block: "nearest" });
  if (!usage.hidden) usage.scrollIntoView?.({ block: "nearest" });
}

function appendChatTesterTurn(kind, text) {
  const item = document.createElement("li");
  const heading = document.createElement("strong");
  const content = document.createElement("p");
  heading.textContent = kind === "user" ? "You" : "Local adapter";
  content.textContent = text;
  item.className = `chat-tester-turn chat-tester-turn-${kind}`;
  item.append(heading, content);
  element("chat-tester-transcript").append(item);
  return content;
}

function setChatTesterTurnState(content, status) {
  const item = content?.parentElement;
  if (!item) return;
  item.dataset.status = status;
  item.classList.toggle("chat-tester-turn-waiting", status === "waiting");
  item.classList.toggle(
    "chat-tester-turn-incomplete",
    ["incomplete", "stopped", "failed"].includes(status),
  );
  content.classList.toggle("chat-tester-stream-cursor", status === "streaming");
  if (status === "waiting") content.setAttribute("aria-hidden", "true");
  else content.removeAttribute("aria-hidden");
  const heading = item.querySelector("strong");
  if (heading) {
    heading.textContent = ["incomplete", "stopped", "failed"].includes(status)
      ? `Local adapter · ${status}`
      : "Local adapter";
  }
}

function updateChatTesterFeedback(event, assistantContent) {
  const previous = state.chatTester.feedback;
  const feedback = nextChatTesterFeedback(previous, event);
  state.chatTester.feedback = feedback;
  if (assistantContent) {
    setChatTesterTurnState(assistantContent, feedback.turnStatus);
  }
  if (feedback.phase !== previous.phase) {
    setChatTesterStatus(chatTesterStatusMessage(feedback.phase));
  }
  return feedback;
}

function clearChatTesterState() {
  state.chatTester.activeController?.abort();
  state.chatTester.activeController = null;
  state.chatTester.conversationId = null;
  state.chatTester.encryptedCredential = null;
  state.chatTester.endpointBaseUrl = null;
  state.chatTester.expiresAt = null;
  state.chatTester.keyId = null;
  state.chatTester.models = [];
  element("chat-tester-model").replaceChildren();
  state.chatTester.feedback = { ...INITIAL_CHAT_TESTER_FEEDBACK };
  state.chatTester.generation += 1;
  element("chat-tester-credential").value = "";
  element("chat-tester-endpoint").value = "";
  element("chat-tester-input").value = "";
  element("chat-tester-secure-form").hidden = false;
  element("chat-tester-message-form").hidden = true;
  element("chat-tester-send").hidden = false;
  element("chat-tester-stop").hidden = true;
  element("chat-tester-transcript").replaceChildren();
  clearChatTesterError();
}

function assertChatTesterKey(result) {
  if (
    !result ||
    typeof result !== "object" ||
    typeof result.keyId !== "string" ||
    typeof result.expiresAt !== "string" ||
    result.algorithm !== "RSA-OAEP-256" ||
    !result.publicKeyJwk ||
    result.publicKeyJwk.kty !== "RSA" ||
    typeof result.publicKeyJwk.n !== "string" ||
    typeof result.publicKeyJwk.e !== "string"
  ) {
    throw new Error("The local tester returned an unexpected encryption key.");
  }
  return result;
}

async function encryptChatTesterCredential(publicKeyJwk, clientCredential) {
  if (!window.crypto?.subtle) {
    throw new Error("This browser cannot create the required local test encryption key.");
  }
  const publicKey = await window.crypto.subtle.importKey(
    "jwk",
    publicKeyJwk,
    { name: "RSA-OAEP", hash: "SHA-256" },
    false,
    ["encrypt"],
  );
  const encrypted = await window.crypto.subtle.encrypt(
    { name: "RSA-OAEP" },
    publicKey,
    new TextEncoder().encode(clientCredential),
  );
  const bytes = new Uint8Array(encrypted);
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCodePoint(byte);
  }
  return window.btoa(binary);
}

async function forgetChatTester({ announce = true } = {}) {
  const keyId = state.chatTester.keyId;
  clearChatTesterState();
  if (!keyId) {
    if (announce) {
      setChatTesterStatus("The tester is cleared. Secure a credential to begin again.");
    }
    return;
  }
  try {
    await api("/api/local/chat-test/reset", {
      method: "POST",
      body: { keyId },
    });
    if (announce) {
      setChatTesterStatus("The tester key and transcript were forgotten.");
    }
  } catch (error) {
    if (announce) {
      showChatTesterError(error);
      setChatTesterStatus("The browser tester was cleared. The local key will expire shortly.");
    }
  }
}


const delay = (milliseconds) =>
  new Promise((resolve) => window.setTimeout(resolve, milliseconds));


// The wizard runs on 127.0.0.1, a secure context, so the Clipboard API is the
// normal path. The fallback briefly focuses a visually hidden (not
// aria-hidden) field, then returns focus to the copy button.
async function copyText(value, trigger) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(value);
      return;
    } catch {
      // Try the selection fallback below.
    }
  }
  const textarea = document.createElement("textarea");
  textarea.value = value;
  textarea.readOnly = true;
  textarea.className = "rm-visually-hidden";
  let copied = false;
  try {
    document.body.append(textarea);
    textarea.focus({ preventScroll: true });
    textarea.select();
    copied = document.execCommand("copy");
  } catch {
    copied = false;
  } finally {
    textarea.remove();
    trigger?.focus?.({ preventScroll: true });
  }
  // A generic message avoids repeating sensitive copied values.
  if (!copied) throw new Error("The browser refused clipboard access.");
}

// Visual confirmation only. The accessible name never changes; callers
// announce success through a polite status region.
function flashCopied(button) {
  button.classList.add("copied");
  window.setTimeout(() => button.classList.remove("copied"), 1_800);
}

element("target-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = element("review-button");
  if (setBusy(button, true, "Preparing plan…") === false) return;
  clearError();
  invalidatePlan();
  try {
    const sidecar = isN8nSidecar(state.target);
    const n8nSuperGrok = isN8nSuperGrok(state.target);
    const assistant = isN8nAssistant(state.target);
    const stack = isN8nStack(state.target);
    const n8nTarget = isN8nDockerTarget(state.target);
    if (
      n8nTarget &&
      ((sidecar && !state.n8nOAuthExists) ||
        element("n8n-container").value === "" ||
        element("n8n-network").value === "")
    ) {
      throw new Error(
        n8nSuperGrok || assistant || isN8nLocalModel(state.target)
          ? "Choose a running n8n container and shared Docker network."
          : "Choose a running n8n container and shared Docker network, then complete local ChatGPT sign-in.",
      );
    }
    if (sidecar || isCodexChat(state.target) || state.target === "codex-chatgpt") {
      const models = await siwc.catalog();
      if (!models.length) throw new Error("No models are listed for this selected ChatGPT account.");
      state.catalogLabels = new Map(models.map(({ slug, display_name }) => [slug, display_name]));
    }
    const result = await api("/api/local/plan", {
      method: "POST",
      body: stack
        ? {
            target: state.target,
            ngrokHostname: element("ngrok-hostname").value,
            n8nPort: element("n8n-stack-port").value,
            ngrokInspectorPort: element("ngrok-inspector-port").value,
            timezone: element("n8n-stack-timezone").value,
            assistantMode: element("n8n-stack-assistant-mode").value,
          }
        : n8nTarget
        ? {
            target: state.target,
            n8nContainerId: element("n8n-container").value,
            dockerNetworkId: element("n8n-network").value,
            ...(isN8nLocalModel(state.target) ? { modelId: element("local-model-id").value } : {}),
            ...(assistant
              ? {
                  includeSearxng: element("include-local-searxng").checked,
                }
              : {}),
          }
        : {
            target: state.target,
            port: element("local-port").value,
          },
    });
    if (
      typeof result.planId !== "string" ||
      !result.plan ||
      typeof result.plan !== "object" ||
      Array.isArray(result.plan)
    ) {
      throw new Error("The local wizard returned an unexpected plan.");
    }
    state.planId = result.planId;
    state.plan = result.plan;
    renderPlan(result.plan);
    showStep(2);
    setMessage(
      isN8nLocalModel(state.target)
        ? "Review the model identity, measured Docker resources and private-network risks. Nothing has been written yet."
        : stack
          ? "Review the exact new owned n8n + ngrok plan. Nothing has been written or exposed yet."
          : n8nTarget
            ? "Review the exact Docker-network-only plan. Nothing has been written yet."
            : "Review the exact loopback plan. Nothing has been written yet.",
    );
  } catch (error) {
    showError(error);
  } finally {
    setBusy(button, false);
  }
});

for (const input of document.querySelectorAll('input[name="target"]')) {
  input.addEventListener("change", renderTarget);
}

// The browser rejects step 1 fields (such as a port below 1024) before submit.
// Like the native bubble it replaces, the visible error reports the first
// rejected field and is linked to it; editing that field clears both. The
// short wording keeps the error within the rail at 1280 x 720.
let reportingRejectedField = false;
element("target-form").addEventListener("invalid", (event) => {
  event.preventDefault();
  if (reportingRejectedField) return;
  reportingRejectedField = true;
  window.setTimeout(() => {
    reportingRejectedField = false;
  });
  const field = event.target;
  const label = field.closest(".rm-field")?.querySelector(".rm-field__label")?.textContent.trim() ?? "This field";
  const problem = field.validity.valueMissing
    ? "enter a value."
    : field.type === "number"
      ? `use ${field.min} to ${field.max}.`
      : field.validationMessage;
  showError(new Error(`${label}: ${problem}`), [field]);
}, true);
element("target-form").addEventListener("input", (event) => {
  if (event.target.getAttribute("aria-invalid") === "true") clearError();
});

element("local-port").addEventListener("input", invalidatePlan);
element("include-local-searxng").addEventListener("change", invalidatePlan);
for (const id of ["ngrok-hostname", "n8n-stack-port", "ngrok-inspector-port", "n8n-stack-timezone", "n8n-stack-assistant-mode"]) {
  element(id).addEventListener("input", invalidatePlan);
  element(id).addEventListener("change", invalidatePlan);
}
element("n8n-container").addEventListener("change", () => {
  element("n8n-network").value = "";
  renderSidecarNetworkOptions();
});
element("n8n-network").addEventListener("change", () => {
  renderSidecarNetworkOptions();
});

element("n8n-discovery-refresh").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  if (setBusy(button, true, "Refreshing n8n…") === false) return;
  clearError();
  try {
    await refreshN8nDiscovery();
    setMessage("Running n8n containers and their existing Docker networks were refreshed read-only.");
  } catch (error) {
    state.n8nDiscoveryLoaded = false;
    showError(error);
  } finally {
    setBusy(button, false);
    if (state.n8nDiscoveryLoaded) {
      element("n8n-container").disabled = state.n8nContainers.length === 0;
      renderSidecarNetworkOptions();
    }
  }
});

element("manage-local-sidecar").addEventListener("click", async (event) => {
  clearError();
  state.suppressTargetRefresh = true;
  try {
    selectN8nManagementTarget("n8n-openai-oauth");
  } finally {
    state.suppressTargetRefresh = false;
  }
  const refresh = refreshSelectedN8nContext(event.currentTarget);
  setMessage(
    "Choose bridge setup or an ownership-attested credential refresh. Detecting n8n alone does not prove a Relmio bridge exists.",
  );
  await refresh;
});

element("manage-local-assistant").addEventListener("click", async (event) => {
  clearError();
  state.suppressTargetRefresh = true;
  try {
    selectN8nManagementTarget("n8n-ai-assistant");
  } finally {
    state.suppressTargetRefresh = false;
  }
  const refresh = refreshSelectedN8nContext(event.currentTarget);
  setMessage(
    "Choose Assistant setup or review SearXNG for an ownership-attested existing Assistant. n8n configuration and restarts remain your action.",
  );
  await refresh;
});

element("refresh-local-n8n-chatgpt").addEventListener("click", () => {
  if (state.n8nOAuthRetryBlocked) return;
  clearError();
  state.suppressTargetRefresh = true;
  try {
    selectN8nManagementTarget("n8n-openai-oauth");
  } finally {
    state.suppressTargetRefresh = false;
  }
  state.n8nOAuthIntent = { purpose: "sign-in" };
  element("n8n-oauth-sign-in").click();
});

element("n8n-oauth-refresh").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  if (setBusy(button, true, "Refreshing sign-in…") === false) return;
  clearError();
  try {
    await refreshN8nOAuthStatus({ announce: true });
  } catch (error) {
    showError(error);
  } finally {
    setBusy(button, false);
    updateReviewAvailability();
  }
});

element("n8n-oauth-sign-in").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  if (state.n8nOAuthRetryBlocked) return;
  if (setBusy(button, true, "Waiting for ChatGPT…") === false) return;
  const generation = state.n8nOAuthGeneration + 1;
  state.n8nOAuthGeneration = generation;
  state.n8nOAuthAttemptId = null;
  state.n8nOAuthExists = false;
  updateReviewAvailability();
  clearError();
  setN8nOAuthStopVisible(false);
  try {
    const existing = await api("/api/oauth/status");
    if (state.n8nOAuthGeneration !== generation) return;
    if (existing.retryBlocked === true) throw oauthRetryBlockedError(existing);
    let attemptId;
    let resumed = false;
    if (existing.status === "pending") {
      attemptId = validateOAuthAttemptId(existing.attemptId);
      resumed = true;
      setMessage(
        "A ChatGPT sign-in is still in progress. Finish it in the existing sign-in window, or use Stop and try again.",
      );
    } else {
      setMessage("Relmio opens a fresh ChatGPT sign-in in your system browser. No saved Codex credential is imported.");
      const result = await api("/api/oauth/login", {
        method: "POST",
        body: state.n8nOAuthIntent,
      });
      if (state.n8nOAuthGeneration !== generation) return;
      if (result.launchMode !== "system-browser") {
        throw new Error(
          "The wizard returned an unexpected sign-in launch mode. Update Relmio and try again.",
        );
      }
      attemptId = validateOAuthAttemptId(result.attemptId);
      setMessage(
        "Finish sign-in in the official ChatGPT sign-in window opened by Relmio. If no window opened, check your default browser, then use Stop and try again.",
      );
    }
    if (state.n8nOAuthGeneration !== generation) return;
    state.n8nOAuthAttemptId = attemptId;
    setN8nOAuthStopVisible(true);
    element("n8n-oauth-status").textContent = resumed
      ? "Waiting for the current ChatGPT sign-in to finish…"
      : "Waiting for the fresh ChatGPT sign-in to finish…";
    const completed = await waitForN8nOAuth(attemptId, generation);
    if (!completed || state.n8nOAuthGeneration !== generation) return;
    setN8nOAuthStopVisible(false);
    await siwc.authorized(state.n8nOAuthIntent);
    await refreshN8nOAuthStatus({ announce: true });
  } catch (error) {
    if (state.n8nOAuthGeneration === generation) {
      if (error.oauthRetryBlocked === true) blockN8nOAuthRetry();
      if (error.oauthRetryBlocked !== true) {
        element("n8n-oauth-status").textContent =
          "ChatGPT sign-in did not complete. Start a fresh sign-in or refresh status.";
      }
      await siwc.load({ welcome: false }).catch(() => {});
      showError(error);
    }
  } finally {
    if (state.n8nOAuthGeneration === generation) {
      state.n8nOAuthAttemptId = null;
      setN8nOAuthStopVisible(false);
      setBusy(button, false);
      if (state.n8nOAuthRetryBlocked) disableN8nOAuthRetryControls();
      updateReviewAvailability();
    }
    if (state.n8nOAuthCancellationMessage) {
      const cancellationMessage = state.n8nOAuthCancellationMessage;
      state.n8nOAuthCancellationMessage = "";
      setMessage(cancellationMessage);
    }
  }
});

async function stopN8nOAuthSignIn(event) {
  event?.preventDefault?.();
  const link = element("n8n-oauth-link");
  const attemptId = state.n8nOAuthAttemptId;
  const generation = state.n8nOAuthGeneration;
  if (typeof attemptId !== "string" || state.n8nOAuthRetryBlocked) return;
  if (link.getAttribute?.("aria-busy") === "true") return;
  clearError();
  const previousLabel = link.textContent;
  link.setAttribute("aria-busy", "true");
  link.textContent = "Stopping sign-in…";
  try {
    const result = await api("/api/oauth/cancel", {
      method: "POST",
      body: { attemptId },
    });
    if (
      state.n8nOAuthGeneration !== generation ||
      result.attemptId !== attemptId ||
      result.status !== "cancelled"
    ) {
      return;
    }
    state.n8nOAuthGeneration += 1;
    state.n8nOAuthAttemptId = null;
    link.setAttribute("aria-busy", "false");
    setN8nOAuthStopVisible(false);
    state.n8nOAuthCancellationMessage =
      "ChatGPT sign-in stopped. You can start again.";
    setBusy(element("n8n-oauth-sign-in"), false);
  } catch (error) {
    if (state.n8nOAuthGeneration !== generation) return;
    if (error.oauthRetryBlocked === true) {
      state.n8nOAuthGeneration += 1;
      blockN8nOAuthRetry();
      setBusy(element("n8n-oauth-sign-in"), false);
      disableN8nOAuthRetryControls();
    }
    showError(error);
  } finally {
    if (state.n8nOAuthGeneration === generation) {
      link.setAttribute("aria-busy", "false");
      link.textContent = previousLabel;
    }
  }
}

element("n8n-oauth-link").addEventListener("click", (event) => {
  void stopN8nOAuthSignIn(event);
});


function updateInstalledOwnerApproval() {
  const owner = state.installedOwner;
  const accepted = element("local-siwc-owner-confirm").checked &&
    owner?.account?.ownership === "owned" &&
    (owner.serviceState === "healthy" || owner.reviewedStopped === true);
  element("local-siwc-enable").disabled = !accepted ||
    (owner?.target === "n8n-openai-oauth" && !element("local-siwc-background-confirm").checked);
  element("local-siwc-disable").disabled = !accepted;
  element("local-siwc-logout").disabled = !accepted;
}
element("local-siwc-owner-confirm").addEventListener("change", updateInstalledOwnerApproval);
element("local-siwc-background-confirm").addEventListener("change", updateInstalledOwnerApproval);

element("local-siwc-inspect").addEventListener("click", async (event) => {
  const owner = state.installedOwner;
  if (!owner || owner.serviceState !== "stopped" || !owner.registrationId ||
      !element("local-siwc-inspect-confirm").checked) {
    showError(new Error("Confirm the stopped service inspection first."));
    return;
  }
  const button = event.currentTarget;
  if (setBusy(button, true, "Inspecting stopped owner…") === false) return;
  clearError();
  try {
    const sidecar = owner.target === "n8n-openai-oauth";
    const result = await api(sidecar
      ? "/api/local/n8n/siwc/inspect-stopped" : "/api/local/siwc/inspect-stopped", {
      method: "POST",
      body: { registrationId: owner.registrationId, confirmed: true,
        ...(sidecar ? {} : { target: owner.target }) },
    });
    const account = normalizeSiwcAccount(result.account);
    renderInstalledSiwcOwner({
      target: owner.target, state: "stopped", reviewedStopped: true,
      snapshot: { migrationRequired: false, registrationId: account.registrationId,
        auth: { configured: false, account } },
    });
    setMessage("Stopped owner verified. Changing its session needs a separate confirmation.");
  } catch (error) {
    showError(error);
  } finally {
    setBusy(button, false);
  }
});

async function manageInstalledSiwc(action, button) {
  const owner = state.installedOwner;
  if (!owner?.account || !element("local-siwc-owner-confirm").checked ||
      (owner.target === "n8n-openai-oauth" && action === "enable-plan" &&
        !element("local-siwc-background-confirm").checked)) {
    showError(new Error("Confirm this installed account action before continuing."));
    return;
  }
  if (setBusy(button, true, "Checking installed owner…") === false) return;
  clearError();
  try {
    const sidecar = owner.target === "n8n-openai-oauth";
    const result = await api(sidecar ? "/api/local/n8n/siwc/manage" : "/api/local/siwc/manage", {
      method: "POST",
      body: { registrationId: owner.account.registrationId,
        expectedGeneration: owner.account.generation, action, confirmed: true,
        ...(sidecar ? { ...(action === "enable-plan" ? { backgroundConsent: true } : {}) }
          : { target: owner.target }) },
    });
    const account = normalizeSiwcAccount(result.account);
    clearChatTesterState();
    renderInstalledSiwcOwner({
      target: owner.target, state: result.runtimeStopped ? "stopped" : "healthy",
      reviewedStopped: result.runtimeStopped === true,
      snapshot: { migrationRequired: false, registrationId: account.registrationId,
        auth: { configured: !result.runtimeStopped && account.planEnabled, account } },
    });
    if (owner.target === "codex-chat" && result.runtimeStopped === false) {
      element("chat-tester").hidden = false;
      element("chat-tester-status").textContent = "Secure the saved local client key again before testing.";
    } else element("chat-tester").hidden = true;
    const message = result.revocation === "unconfirmed"
      ? "Local credentials were cleared, but provider revocation was not confirmed. Disconnect Relmio in ChatGPT settings."
      : action === "sign-out"
        ? "The installed session was signed out. Old Codex credentials remain separate."
        : action === "disable-plan"
          ? "Plan use paused at this installation. Its Relmio service is stopped."
          : "Plan use was enabled at this installation. Only its owned Relmio service was started.";
    element("local-siwc-owner-status").textContent = message;
    setMessage(message);
  } catch (error) {
    showError(error);
  } finally {
    setBusy(button, false);
  }
}
for (const [id, action] of [
  ["local-siwc-enable", "enable-plan"],
  ["local-siwc-disable", "disable-plan"],
  ["local-siwc-logout", "sign-out"],
]) {
  element(id).addEventListener("click", (event) => { void manageInstalledSiwc(action, event.currentTarget); });
}
element("local-siwc-replace").addEventListener("click", async () => {
  const owner = state.installedOwner;
  if (!owner?.account || owner.account.session !== "signed-out" || owner.reviewedStopped !== true) return;
  await enterSetupView(owner.target);
  setMessage("Choose a fresh, independently authorized ChatGPT account, then review this signed-out target's replacement. Old history stays offline.");
});

element("review-assistant-searxng-edit").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  if (setBusy(button, true, "Reviewing owned Assistant…") === false) return;
  clearError();
  setMessage(
    "Reading the owned Assistant identity for a SearXNG-only review. Nothing is being changed.",
  );
  try {
    const review = validateAssistantSearxngReview(
      await api("/api/local/n8n/assistant/searxng/review", {
        method: "POST",
        body: { includeSearxng: true },
      }),
    );
    state.assistantSearxngReviewId = review.reviewId;
    state.assistantSearxngReview = review;
    element("assistant-searxng-edit-sandbox").textContent = review.sandboxUrl;
    element("assistant-searxng-edit-search").textContent = review.searxngUrl;
    element("assistant-searxng-edit-review").hidden = false;
    element("enable-assistant-searxng-confirm").checked = false;
    element("enable-assistant-searxng-confirm").disabled = false;
    element("enable-assistant-searxng-button").disabled = true;
    element("assistant-searxng-edit-result").textContent =
      "Review ready. Confirm the SearXNG-only change to continue.";
    element("assistant-searxng-edit-settings").hidden = true;
    element("assistant-searxng-edit-settings").textContent = "";
    element("assistant-searxng-edit-status").textContent =
      "Relmio verified a SearXNG-free owned Assistant installation. No Docker service or n8n setting has changed.";
    setMessage(
      "Review ready. SearXNG has not been enabled; confirm the separate change only if it is what you want.",
    );
  } catch (error) {
    state.assistantSearxngReviewId = null;
    state.assistantSearxngReview = null;
    element("assistant-searxng-edit-review").hidden = true;
    showError(error);
  } finally {
    setBusy(button, false);
  }
});

element("enable-assistant-searxng-confirm").addEventListener("change", (event) => {
  element("enable-assistant-searxng-button").disabled =
    !state.assistantSearxngReviewId || !event.currentTarget.checked;
});

element("enable-assistant-searxng-button").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  const confirmation = element("enable-assistant-searxng-confirm");
  const reviewId = state.assistantSearxngReviewId;
  let applied = false;
  clearError();
  if (!reviewId || !confirmation.checked) {
    showError(new Error("Review and confirm SearXNG enablement first."));
    return;
  }
  if (setBusy(button, true, "Enabling SearXNG…") === false) return;
  setMessage(
    "Enabling only the ownership-verified SearXNG companion. The sandbox key and n8n remain unchanged.",
  );
  try {
    const result = validateAssistantSearxngEnablementResult(
      await api("/api/local/n8n/assistant/searxng/enable", {
        method: "POST",
        body: { reviewId, confirmed: true },
      }),
    );
    applied = true;
    state.assistantSearxngReviewId = null;
    state.assistantSearxngReview = null;
    confirmation.checked = false;
    confirmation.disabled = true;
    button.disabled = true;
    element("assistant-searxng-edit-result").textContent =
      "SearXNG is enabled on the owned Assistant tools. The sandbox API key was not rotated or shown.";
    element("assistant-searxng-edit-settings").textContent =
      `Apply only this operator-managed n8n setting yourself: N8N_INSTANCE_AI_SEARXNG_URL=${result.n8nSettings.N8N_INSTANCE_AI_SEARXNG_URL}`;
    element("assistant-searxng-edit-settings").hidden = false;
    element("assistant-searxng-edit-status").textContent =
      "SearXNG-only enablement completed. n8n configuration and any restart remain your action.";
    setMessage(
      "SearXNG was enabled only on the owned Assistant tools. Relmio did not rotate the sandbox key or change n8n.",
    );
  } catch (error) {
    showError(error);
  } finally {
    setBusy(button, false);
    if (applied) {
      confirmation.disabled = true;
      button.disabled = true;
    }
  }
});

function updateLocalReviewApproval() {
  element("install-settings-button").disabled = !element("install-confirm").checked ||
    (state.plan?.migrationRequired === true && !element("local-migration-consent").checked) ||
    (state.plan?.replacementRequired === true && !element("local-replacement-consent").checked);
}
element("install-confirm").addEventListener("change", updateLocalReviewApproval);
element("local-migration-consent").addEventListener("change", updateLocalReviewApproval);
element("local-replacement-consent").addEventListener("change", updateLocalReviewApproval);
element("local-background-consent").addEventListener("change", () => {
  if (isN8nSidecar(state.plan?.target)) {
    element("install-button").disabled = !element("local-background-consent").checked;
  }
});

for (const id of ["ngrok-authtoken", "ngrok-basic-auth-username", "ngrok-basic-auth-password"]) {
  element(id).addEventListener("input", (event) => {
    event.currentTarget.setCustomValidity("");
  });
}

element("generate-ngrok-basic-auth-password").addEventListener("click", () => {
  clearError();
  try {
    const bytes = new Uint8Array(24);
    globalThis.crypto.getRandomValues(bytes);
    const password = Array.from(bytes, (byte) =>
      byte.toString(16).padStart(2, "0"),
    ).join("");
    const input = element("ngrok-basic-auth-password");
    input.value = password;
    input.setCustomValidity("");
    input.focus();
    setMessage(
      "A strong Basic Auth password was generated in the password field. Show it and save it in your password manager before installing.",
    );
  } catch {
    showError(
      new Error("This browser could not securely generate a password. Create one with at least 12 characters and no colon or line break."),
    );
  }
});

element("toggle-ngrok-basic-auth-password").addEventListener("click", (event) => {
  const input = element("ngrok-basic-auth-password");
  const showing = input.type === "text";
  input.type = showing ? "password" : "text";
  event.currentTarget.textContent = showing ? "Show password" : "Hide password";
  event.currentTarget.setAttribute("aria-pressed", String(!showing));
  input.focus();
});

element("install-settings-button").addEventListener("click", () => {
  clearError();
  if (!state.planId || !state.plan || !element("install-confirm").checked ||
      (state.plan.migrationRequired && !element("local-migration-consent").checked) ||
      (state.plan.replacementRequired && !element("local-replacement-consent").checked)) {
    showError(new Error("Review and confirm the local plan first."));
    return;
  }
  prepareInstallPanel();
  showStep(3);
  setMessage("The plan is confirmed. Installation has not started yet.");
});

element("install-button").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  if (state.operationBusy) return;
  const stack = isN8nStack(state.plan?.target);
  const stackSecretInputs = [
    element("ngrok-authtoken"),
    element("ngrok-basic-auth-username"),
    element("ngrok-basic-auth-password"),
  ];
  let retryStackCredentials = false;
  clearError();
  if (!state.planId || !state.plan || !element("install-confirm").checked ||
      (state.plan.migrationRequired && !element("local-migration-consent").checked) ||
      (state.plan.replacementRequired && !element("local-replacement-consent").checked)) {
    showStep(1);
    showError(new Error("Review and confirm a fresh local plan first."));
    return;
  }
  if (isN8nSidecar(state.plan.target) && !element("local-background-consent").checked) {
    showError(new Error("Approve this account's n8n background use before installing the sidecar."));
    return;
  }
  if (stack && !validateLocalN8nStackCredentials()) {
    return;
  }
  const requestBody = {
    planId: state.planId,
    confirmed: element("install-confirm").checked,
    ...(isN8nSidecar(state.plan.target)
      ? { backgroundConsent: element("local-background-consent").checked } : {}),
    ...(state.plan.migrationRequired
      ? { migrationConsent: element("local-migration-consent").checked } : {}),
    ...(state.plan.replacementRequired
      ? { replacementConsent: element("local-replacement-consent").checked } : {}),
    ...(stack
      ? {
          ngrokAuthtoken: stackSecretInputs[0].value,
          basicAuthUsername: stackSecretInputs[1].value,
          basicAuthPassword: stackSecretInputs[2].value,
        }
      : {}),
  };
  for (const input of stackSecretInputs) input.value = "";
  const installProgressStarted = startInstallProgress(button);
  if (!installProgressStarted) return;
  setMessage(
    isN8nLocalModel(state.plan.target)
      ? "Starting the private model runtime and detached acquisition…"
      : stack
      ? "Creating and verifying the new owned n8n stack and authenticated ngrok endpoint…"
      : isN8nSidecar(state.plan.target)
      ? "Creating and verifying only the private Docker-network sidecar…"
      : isN8nSuperGrok(state.plan.target)
      ? "Creating and verifying only the private SuperGrok n8n sidecar…"
      : isN8nAssistant(state.plan.target)
        ? "Creating and verifying the private Code Sandbox and selected SearXNG option…"
      : "Building and verifying the loopback-only Docker container…",
  );
  try {
    const result = await api("/api/local/install", {
      method: "POST",
      body: requestBody,
    });
    renderInstallResult(result);
    state.planId = null;
    showStep(4);
    const chatgptTarget = ["n8n-openai-oauth", "codex-chatgpt", "codex-chat"].includes(result.target);
    setMessage(
      result.finalizationFailure
        ? "Save the one-time key now. Do not use it until the reported finalization issue is resolved."
        : chatgptTarget && result.runtimeState !== "running"
        ? "The destination owns this session, but the runtime outcome is uncertain. Save the one-time key and inspect the owned service manually."
        : chatgptTarget && result.readiness !== "verified"
          ? "The selected ChatGPT account was installed, but its model check did not complete. Save the one-time key before leaving."
          : result.target === "n8n-local-model"
            ? element("local-model-state").textContent
            : result.target === "local-n8n-stack"
              ? "New local n8n stack verified. The public ngrok URL requires Basic Auth."
              : result.target === "n8n-openai-oauth"
                ? "The private n8n sidecar owns this registration. Enter its one-time Relmio client key in n8n yourself."
                : result.target === "n8n-supergrok-oauth"
                  ? "Private SuperGrok sidecar verified. Copy its one-time key and complete Grok sign-in separately."
                  : result.target === "n8n-ai-assistant"
                    ? "Code Sandbox companions verified. Copy the one-time n8n settings."
                    : result.target === "xai-grok-build"
                      ? "Grok Build integration verified. Complete its official sign-in separately."
                      : "The selected ChatGPT plan registration is owned by this Codex installation. Copy its one-time local key.",
    );
  } catch (error) {
    if (stack && error.managedPartialStack === true) {
      invalidatePlan();
      state.installedTarget = "local-n8n-stack";
      element("install-result-list").hidden = true;
      element("one-time-note").hidden = true;
      element("credential-rotation-note").hidden = true;
      element("client-warning").hidden = true;
      element("codex-production-warning").hidden = true;
      element("chat-tester").hidden = true;
      element("n8n-sidecar-removal").hidden = true;
      element("n8n-assistant-removal").hidden = true;
      element("n8n-stack-resume").hidden = true;
      element("n8n-stack-removal").hidden = false;
      element("remove-n8n-stack-confirm").checked = false;
      element("remove-n8n-stack-confirm").disabled = false;
      element("remove-n8n-stack-button").disabled = true;
      element("remove-n8n-stack-status").textContent =
        "The confirmed Relmio-owned partial stack remains until this separate removal confirmation is checked.";
      element("done-title").textContent = "Owned partial n8n + ngrok stack needs removal";
      element("done-detail").textContent =
        "Startup did not complete. Relmio confirmed that its attested partial stack remains; remove it below before creating a fresh plan.";
      showStep(4);
      setMessage(
        "Review and explicitly confirm removal of the Relmio-owned partial stack before retrying setup.",
      );
      showError(error);
      return;
    }
    if (stack && error.retryablePlan === true) {
      retryStackCredentials = true;
      showStep(3);
      setMessage(
        error.retryableNgrokSetup === true
          ? "Credentials were cleared for safety. Check the ngrok account and endpoint setup, reserved hostname, active agent token, and Basic Auth, then re-enter all three credentials and retry this reviewed plan."
          : "Credentials were cleared for safety. Address the reported Docker or service verification failure, then re-enter all three credentials and retry this reviewed plan.",
      );
      showError(error);
      return;
    }
    if (!stack && error.recovery === "resolve-handoff") {
      invalidatePlan();
      element("install-result-list").hidden = true;
      element("installed-siwc-models").hidden = true;
      element("chat-tester").hidden = true;
      element("local-siwc-owner").hidden = true;
      element("done-title").textContent = "Installation outcome needs owner inspection";
      element("done-detail").textContent =
        "A token handoff may have started. Do not start another sign-in or replay installation until the owned runtime is inspected.";
      showStep(4);
      showError(error);
      return;
    }
    invalidatePlan();
    if (stack) {
      state.installedTarget = null;
      element("n8n-stack-removal").hidden = true;
      element("n8n-stack-resume").hidden = true;
    }
    showStep(1);
    setMessage("The installation was not confirmed. Review the error and inspect any owned service before another plan.");
    showError(error);
  } finally {
    requestBody.ngrokAuthtoken = undefined;
    requestBody.basicAuthUsername = undefined;
    requestBody.basicAuthPassword = undefined;
      stopInstallProgress(button);
    for (const input of stackSecretInputs) {
      input.value = "";
      input.disabled = !retryStackCredentials;
      input.setCustomValidity("");
    }
    for (const id of ["generate-ngrok-basic-auth-password", "toggle-ngrok-basic-auth-password"]) {
      element(id).disabled = !retryStackCredentials;
    }
    resetBasicAuthPasswordVisibility();
    element("n8n-stack-secrets").hidden = !retryStackCredentials;
  }
});

element("remove-bridge-confirm").addEventListener("change", (event) => {
  element("remove-bridge-button").disabled = !event.currentTarget.checked;
});

element("local-model-id").addEventListener("change", () => {
  invalidatePlan();
  updateReviewAvailability();
});

element("local-model-refresh").addEventListener("click", async () => {
  clearError();
  try {
    await refreshLocalModelStatus();
  } catch (error) {
    element("local-model-settings").hidden = true;
    element("local-model-review-retry").hidden = true;
    element("local-model-review-remove").hidden = true;
    element("local-model-state").textContent = "Model status could not be verified.";
    showError(error);
  }
});
element("local-model-review-retry").addEventListener("click", () => reviewLocalModelAction("retry"));
element("local-model-review-remove").addEventListener("click", () => reviewLocalModelAction("remove"));
element("local-model-action-confirm").addEventListener("change", updateLocalModelActionConfirmation);
element("local-model-cache-confirm").addEventListener("change", updateLocalModelActionConfirmation);
element("local-model-cancel").addEventListener("click", () => {
  const opener = element(state.localModelReview?.action === "retry" ? "local-model-review-retry" : "local-model-review-remove");
  invalidateLocalModelReview();
  if (!opener.hidden) opener.focus();
});
element("local-model-apply").addEventListener("click", async (event) => {
  const review = state.localModelReview;
  if (!review || !element("local-model-action-confirm").checked ||
    (review.action === "remove" && !element("local-model-cache-confirm").checked)) return;
  if (setBusy(event.currentTarget, true, review.action === "remove" ? "Removing model…" : "Retrying download…") === false) return;
  clearError();
  invalidateLocalModelReview();
  try {
    const result = await api("/api/local/model/apply", {
      method: "POST",
      body: {
        reviewId: review.reviewId,
        confirmed: true,
        ...(review.action === "remove" ? { removeModelData: true } : {}),
      },
    });
    if (review.action === "remove") {
      if (!hasExactKeys(result, ["target", "removed", "cacheRetained"]) ||
        result.target !== "n8n-local-model" || result.removed !== true || result.cacheRetained !== false) {
        throw new Error("The model removal could not be verified.");
      }
    } else renderLocalModelStatus(result);
    await refreshLocalModelStatus();
  } catch (error) {
    element("local-model-settings").hidden = true;
    showError(error);
  } finally {
    setBusy(event.currentTarget, false);
  }
});

element("remove-bridge-button").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  const confirmation = element("remove-bridge-confirm");
  clearError();
  if (
    state.installedTarget !== "n8n-openai-oauth" ||
    !confirmation.checked
  ) {
    showError(new Error("Confirm removal of this managed bridge first."));
    return;
  }

  let removed = false;
  if (setBusy(button, true, "Removing bridge…") === false) return;
  setMessage("Removing only Relmio-owned bridge resources. n8n and its external network remain untouched.");
  try {
    const result = await api("/api/local/n8n/remove", {
      method: "POST",
      body: { confirmed: true },
    });
    if (result.target !== "n8n-openai-oauth" || result.removed !== true) {
      throw new Error("The local wizard returned an unexpected removal response.");
    }
    removed = true;
    state.installedTarget = null;
    confirmation.disabled = true;
    element("install-result-list").hidden = true;
    element("client-warning").hidden = true;
    element("done-title").textContent = "Private n8n bridge was removed";
    element("done-detail").textContent =
      "Relmio removed only its sidecar, private auth volume, and managed files. n8n and the external Docker network were left unchanged.";
    element("remove-bridge-status").textContent =
      "Bridge removed. The selected n8n container and external Docker network were not changed.";
    setMessage("Private n8n bridge removed; n8n and its external Docker network remain unchanged.");
  } catch (error) {
    showError(error);
  } finally {
    setBusy(button, false);
    if (removed) {
      confirmation.disabled = true;
      button.disabled = true;
    }
  }
});

element("remove-supergrok-confirm").addEventListener("change", (event) => {
  element("remove-supergrok-button").disabled = !event.currentTarget.checked;
});

element("remove-supergrok-button").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  const confirmation = element("remove-supergrok-confirm");
  clearError();
  if (state.installedTarget !== "n8n-supergrok-oauth" || !confirmation.checked) {
    showError(new Error("Confirm removal of this managed SuperGrok sidecar first."));
    return;
  }
  let removed = false;
  if (setBusy(button, true, "Removing SuperGrok sidecar…") === false) return;
  setMessage("Removing only Relmio-owned SuperGrok sidecar resources. n8n and its external network remain untouched.");
  try {
    const result = await api("/api/local/supergrok/remove", {
      method: "POST",
      body: { confirmed: true },
    });
    if (!hasExactKeys(result, ["target", "removed"]) || result.target !== "n8n-supergrok-oauth" || result.removed !== true) {
      throw new Error("The local wizard returned an unexpected SuperGrok removal response.");
    }
    removed = true;
    state.installedTarget = null;
    element("result-credential").textContent = "";
    confirmation.disabled = true;
    element("install-result-list").hidden = true;
    element("one-time-note").hidden = true;
    element("client-warning").hidden = true;
    element("done-title").textContent = "SuperGrok for n8n was removed";
    element("done-detail").textContent = "Relmio removed only its SuperGrok sidecar, private session volume, and managed files. n8n and the external Docker network were left unchanged.";
    element("remove-supergrok-status").textContent = "SuperGrok sidecar removed. The selected n8n container and external Docker network were not changed.";
    setMessage("SuperGrok for n8n removed; n8n and its external Docker network remain unchanged.");
  } catch (error) {
    showError(error);
  } finally {
    setBusy(button, false);
    if (removed) button.disabled = true;
  }
});

element("remove-assistant-confirm").addEventListener("change", (event) => {
  element("remove-assistant-button").disabled = !event.currentTarget.checked;
});

element("remove-assistant-button").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  const confirmation = element("remove-assistant-confirm");
  clearError();
  if (
    state.installedTarget !== "n8n-ai-assistant" ||
    !confirmation.checked
  ) {
    showError(new Error("Confirm removal of these managed Assistant tools first."));
    return;
  }

  let removed = false;
  if (setBusy(button, true, "Removing Assistant tools…") === false) return;
  setMessage(
    "Removing only Relmio-owned Code Sandbox and optional SearXNG resources. n8n and its external network remain untouched.",
  );
  try {
    const result = await api("/api/local/n8n/assistant/remove", {
      method: "POST",
      body: { confirmed: true },
    });
    if (result.target !== "n8n-ai-assistant" || result.removed !== true) {
      throw new Error("The local wizard returned an unexpected removal response.");
    }
    removed = true;
    state.installedTarget = null;
    element("result-sandbox-key").textContent = "";
    element("result-n8n-settings").textContent = "";
    confirmation.disabled = true;
    element("install-result-list").hidden = true;
    element("client-warning").hidden = true;
    element("done-title").textContent = "n8n Assistant tools were removed";
    element("done-detail").textContent =
      "Relmio removed only its Code Sandbox, optional SearXNG, private TLS volume, and managed files. n8n and the external Docker network were left unchanged.";
    element("remove-assistant-status").textContent =
      "Assistant tools removed. The selected n8n container and external Docker network were not changed.";
    setMessage(
      "Managed n8n Assistant tools removed; n8n and its external Docker network remain unchanged.",
    );
  } catch (error) {
    showError(error);
  } finally {
    setBusy(button, false);
    if (removed) {
      confirmation.disabled = true;
      button.disabled = true;
    }
  }
});

element("remove-n8n-stack-confirm").addEventListener("change", (event) => {
  element("remove-n8n-stack-button").disabled = !event.currentTarget.checked;
});

element("resume-n8n-stack-button").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  clearError();
  if (
    state.installedTarget !== "local-n8n-stack" ||
    state.localN8nStackState !== "stopped"
  ) {
    showError(new Error("Relmio can resume only the detected stopped owned n8n + ngrok stack."));
    return;
  }
  let resumed = false;
  if (setBusy(button, true, "Resuming owned stack…") === false) return;
  setMessage("Starting only the existing ownership-attested n8n, ngrok, and selected Assistant containers…");
  try {
    const result = await api("/api/local/n8n/stack/resume", {
      method: "POST",
      body: { confirmed: true },
    });
    if (
      result.target !== "local-n8n-stack" ||
      result.resumed !== true ||
      result.deploymentMode !== "resumed-owned-disposable-stack"
    ) {
      throw new Error("The local wizard returned an unexpected stack-resume response.");
    }
    resumed = true;
    state.installedTarget = null;
    state.localN8nStackState = "healthy";
    element("n8n-stack-resume").hidden = true;
    element("done-title").textContent = "Managed local n8n + ngrok resumed";
    element("done-detail").textContent =
      "Relmio started only the existing owned containers. No services were recreated, no volumes were removed, and no configuration was changed.";
    element("resume-n8n-stack-status").textContent =
      "Owned stack resumed. Local endpoint management and add-on choices are available again.";
    showStep(1);
    updateReviewAvailability();
    setMessage("The owned n8n + ngrok stack is healthy again. You can continue with normal local endpoint management.");
  } catch (error) {
    showError(error);
  } finally {
    setBusy(button, false);
    if (resumed) {
      button.disabled = true;
      updateReviewAvailability();
    }
  }
});

element("remove-n8n-stack-button").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  const confirmation = element("remove-n8n-stack-confirm");
  clearError();
  if (state.installedTarget !== "local-n8n-stack" || !confirmation.checked) {
    showError(new Error("Confirm removal of this owned n8n + ngrok stack first."));
    return;
  }
  let removed = false;
  if (setBusy(button, true, "Removing owned stack…") === false) return;
  setMessage("Removing only Relmio-owned n8n + ngrok resources. Existing n8n deployments remain untouched.");
  try {
    const result = await api("/api/local/n8n/stack/remove", {
      method: "POST",
      body: { confirmed: true },
    });
    if (result.target !== "local-n8n-stack" || result.removed !== true) {
      throw new Error("The local wizard returned an unexpected removal response.");
    }
    removed = true;
    state.installedTarget = null;
    state.localN8nStackState = null;
    confirmation.disabled = true;
    element("install-result-list").hidden = true;
    element("client-warning").hidden = true;
    element("done-title").textContent =
      "Relmio-managed local n8n + ngrok was removed";
    element("done-detail").textContent =
      "Relmio removed only its owned stack. Existing n8n deployments were not changed.";
    element("remove-n8n-stack-status").textContent =
      "Owned stack removed. Existing n8n deployments were not changed.";
    setMessage("Owned local n8n + ngrok stack removed; existing n8n deployments remain untouched.");
  } catch (error) {
    showError(error);
  } finally {
    setBusy(button, false);
    if (removed) {
      confirmation.disabled = true;
      button.disabled = true;
    }
  }
});

element("rotate-credential-button").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  clearError();
  if (!state.installedTarget) {
    showError(new Error("Install a local endpoint before rotating its credential."));
    return;
  }

  if (setBusy(button, true, "Rotating credential…") === false) return;
  let stagedCredential = null;
  setMessage("Generating a replacement local client key. The old one remains active until activation is verified.");
  try {
    if (isCodexChat(state.installedTarget)) {
      await forgetChatTester({ announce: false });
    }
    const staged = await api("/api/local/client-credential/rotate", {
      method: "POST",
      body: { target: state.installedTarget },
    });
    if (!/^[A-Za-z0-9_-]{32,256}$/u.test(staged.clientCredential ?? "") ||
        staged.credentialShownOnce !== true || staged.deploymentMode !== "staged") {
      throw new Error("The staged local client key could not be verified.");
    }
    stagedCredential = staged.clientCredential;
    element("result-credential-row").hidden = false;
    element("result-credential").textContent = stagedCredential;
    element("result-credential-label").textContent = "One-time replacement local key";
    element("one-time-note").hidden = false;
    element("one-time-note-title").textContent = "Save this local key";
    element("one-time-note-detail").textContent =
      "It is not active until Relmio confirms activation. Do not use it in another client yet.";
    setMessage("Replacement credential received. Activating and verifying it now…");
    await new Promise((resolvePromise) => window.requestAnimationFrame(resolvePromise));
    await new Promise((resolvePromise) => window.requestAnimationFrame(resolvePromise));
    const activated = await api("/api/local/client-credential/activate", {
      method: "POST",
      body: {
        rotationId: staged.rotationId,
        clientCredential: staged.clientCredential,
      },
    });
    if (activated.target !== staged.target || activated.deploymentMode !== "updated") {
      throw new Error("The replacement local key was not confirmed active.");
    }
    element("one-time-note-detail").textContent =
      "Activation was verified. Copy this one-time key into your trusted client; the previous key no longer works.";
    setMessage("Local client key rotated. The ChatGPT account was not changed.");
  } catch (error) {
    setMessage("The replacement local key was not confirmed active. Keep the previous key until the installed service is checked.");
    showError(error);
  } finally {
    setBusy(button, false);
  }
});

element("chat-tester-secure-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = element("chat-tester-secure");
  const resetButton = element("chat-tester-reset");
  const endpointInput = element("chat-tester-endpoint");
  const clientCredentialInput = element("chat-tester-credential");
  if (!form.reportValidity()) {
    return;
  }

  if (setBusy(button, true, "Securing credential…") === false) return;
  clearChatTesterError();
  let clientCredential = clientCredentialInput.value;
  clientCredentialInput.value = "";
  let issuedKey;
  let secured = false;
  resetButton.disabled = true;
  setChatTesterStatus("Creating a short-lived local encryption key…");
  try {
    issuedKey = assertChatTesterKey(
      await api("/api/local/chat-test/key", { method: "POST", body: {} }),
    );
    const encryptedCredential = await encryptChatTesterCredential(
      issuedKey.publicKeyJwk,
      clientCredential,
    );
    clientCredential = undefined;
    state.chatTester.conversationId = null;
    state.chatTester.encryptedCredential = encryptedCredential;
    state.chatTester.endpointBaseUrl = endpointInput.value;
    state.chatTester.expiresAt = issuedKey.expiresAt;
    state.chatTester.keyId = issuedKey.keyId;
    const catalog = await api("/api/local/chat-test/models", {
      method: "POST",
      body: {
        endpointBaseUrl: state.chatTester.endpointBaseUrl,
        keyId: state.chatTester.keyId,
        encryptedCredential: state.chatTester.encryptedCredential,
      },
    });
    if (!Array.isArray(catalog.models) || !catalog.models.length ||
        catalog.account?.registrationId !== state.installedOwner?.account?.registrationId) {
      throw new Error("The installed ChatGPT account has no available model catalog for this test.");
    }
    state.chatTester.models = catalog.models.map((model) => {
      if (typeof model?.slug !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(model.slug) ||
          typeof model.display_name !== "string" || model.display_name.length > 256) {
        throw new Error("The account model catalog could not be verified.");
      }
      return { slug: model.slug, display_name: model.display_name };
    });
    const modelSelect = element("chat-tester-model");
    modelSelect.replaceChildren(...state.chatTester.models.map(({ slug, display_name }) => {
      const option = document.createElement("option");
      option.value = slug;
      option.textContent = display_name;
      return option;
    }));
    state.catalogLabels = new Map(state.chatTester.models.map(({ slug, display_name }) => [slug, display_name]));
    renderInstalledSiwcModels(state.chatTester.models.map(({ slug }) => slug),
      normalizeSiwcAccount(catalog.account));
    element("installed-siwc-model-status").textContent =
      "Current models returned by the installed account. Choose one above to test; a listed model does not guarantee a completed response.";
    element("chat-tester-secure-form").hidden = true;
    element("chat-tester-message-form").hidden = false;
    setChatTesterStatus("Temporary test session secured. Send a message before the key expires.");
    secured = true;
  } catch (error) {
    clientCredential = undefined;
    if (issuedKey?.keyId) {
      try {
        await api("/api/local/chat-test/reset", {
          method: "POST",
          body: { keyId: issuedKey.keyId },
        });
      } catch {
        // The only remaining server material is an expiring private key.
      }
    }
    clearChatTesterState();
    showChatTesterError(error);
    setChatTesterStatus("The credential was cleared. Secure it again to retry.");
  } finally {
    clientCredential = undefined;
    clientCredentialInput.value = "";
    resetButton.disabled = false;
    setBusy(button, false);
    if (secured) element("chat-tester-input").focus();
  }
});

element("chat-tester-message-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const button = element("chat-tester-send");
  const resetButton = element("chat-tester-reset");
  const input = element("chat-tester-input");
  if (!form.reportValidity()) {
    return;
  }
  if (
    !state.chatTester.keyId ||
    !state.chatTester.encryptedCredential ||
    !state.chatTester.endpointBaseUrl
  ) {
    showChatTesterError(
      new Error("This test credential has expired or was forgotten. Secure it again."),
    );
    return;
  }

  const model = element("chat-tester-model").value;
  if (!state.chatTester.models.some((entry) => entry.slug === model)) {
    showChatTesterError(new Error("Choose a model from the installed account's current catalog."));
    return;
  }
  const controller = new AbortController();
  if (
    startOperation(button, "Waiting for response…", {
      markMainBusy: false,
      showProgress: false,
    }) ===
    false
  ) {
    return;
  }
  state.chatTester.activeController = controller;
  clearChatTesterError();
  const text = input.value;
  const generation = state.chatTester.generation;
  input.value = "";
  appendChatTesterTurn("user", text);
  const assistantContent = appendChatTesterTurn("assistant", "Preparing response");
  updateChatTesterFeedback({ type: "send" }, assistantContent);
  element("chat-tester-transcript").setAttribute("aria-busy", "true");
  button.hidden = true;
  element("chat-tester-stop").hidden = false;
  resetButton.disabled = true;
  try {
    const result = await streamChatTesterMessage(
      {
        endpointBaseUrl: state.chatTester.endpointBaseUrl,
        keyId: state.chatTester.keyId,
        encryptedCredential: state.chatTester.encryptedCredential,
        input: text,
        model,
        ...(state.chatTester.conversationId
          ? { conversationId: state.chatTester.conversationId }
          : {}),
      },
      (event, data) => {
        if (state.chatTester.generation !== generation) return;
        if (event === "accepted") {
          updateChatTesterFeedback({ type: "accepted" }, assistantContent);
        } else if (event === "progress") {
          updateChatTesterFeedback(
            { type: "progress", upstreamPhase: data.phase },
            assistantContent,
          );
        } else if (event === "delta" && typeof data.text === "string") {
          const hadText = state.chatTester.feedback.receivedText;
          const feedback = updateChatTesterFeedback(
            { type: "delta", text: data.text },
            assistantContent,
          );
          if (data.text.length === 0) return;
          if (!hadText) assistantContent.textContent = "";
          assistantContent.textContent += data.text;
          setChatTesterTurnState(assistantContent, feedback.turnStatus);
        }
      },
      { signal: controller.signal },
    );
    if (state.chatTester.generation !== generation) {
      return;
    }
    state.chatTester.conversationId = result.conversationId;
    if (!state.chatTester.feedback.receivedText) {
      throw new Error("The local adapter completed without a visible response.");
    }
    updateChatTesterFeedback({ type: "complete" }, assistantContent);
  } catch (error) {
    if (state.chatTester.generation === generation) {
      if (controller.signal.aborted) {
        if (!state.chatTester.feedback.receivedText) {
          assistantContent.textContent = "Stopped before output was returned.";
        }
        updateChatTesterFeedback({ type: "stopped" }, assistantContent);
      } else {
        if (!state.chatTester.feedback.receivedText) {
          assistantContent.textContent = "No response was returned.";
        }
        updateChatTesterFeedback({ type: "failed" }, assistantContent);
        showChatTesterError(error);
      }
    }
  } finally {
    if (state.chatTester.activeController === controller) {
      state.chatTester.activeController = null;
    }
    resetButton.disabled = false;
    element("chat-tester-stop").hidden = true;
    button.hidden = false;
    element("chat-tester-transcript").setAttribute("aria-busy", "false");
    stopOperation(button);
    // Restoring Send can move the error after it was scrolled into view.
    revealChatTesterError();
    // Send or Stop held focus and is now hidden; keep the person's place.
    if (!document.activeElement || document.activeElement === document.body) {
      input.focus();
    }
  }
});

element("chat-tester-stop").addEventListener("click", () => {
  const controller = state.chatTester.activeController;
  if (!controller || controller.signal.aborted) return;
  updateChatTesterFeedback({ type: "stopping" });
  controller.abort();
});

element("chat-tester-reset").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  if (setBusy(button, true, "Forgetting tester…") === false) return;
  clearChatTesterError();
  try {
    await forgetChatTester();
  } finally {
    setBusy(button, false);
  }
});


for (const button of document.querySelectorAll("[data-copy-target]")) {
  button.addEventListener("click", async (event) => {
    const copyButton = event.currentTarget;
    const value = element(copyButton.dataset.copyTarget).textContent;
    clearError();
    try {
      if (!value) {
        throw new Error("No displayed value is available to copy.");
      }
      await copyText(value, copyButton);
      flashCopied(copyButton);
      setMessage(`${copyButton.dataset.copyLabel} copied.`);
    } catch {
      showError(
        new Error(
          `Copy failed. Select the ${copyButton.dataset.copyLabel} manually.`,
        ),
      );
    }
  });
}

for (const button of document.querySelectorAll(".back-button")) {
  button.addEventListener("click", () => {
    if (state.operationBusy) return;
    clearError();
    if (isN8nStack(state.plan?.target)) {
      element("n8n-stack-secrets").hidden = true;
      for (const id of ["ngrok-authtoken", "ngrok-basic-auth-username", "ngrok-basic-auth-password"]) {
        element(id).value = "";
        element(id).disabled = true;
      }
    }
    showStep(Number(button.dataset.back));
    setMessage("No new local installation has started.");
  });
}

async function refreshDockerStatus() {
  clearError();
  const result = await api("/api/local/docker/status");
  state.dockerAvailable = result.dockerAvailable === true;
  const indicator = element("docker-indicator");
  const reviewButton = element("review-button");
  if (result.previewMode === true) {
    state.dockerAvailable = false;
    indicator.classList.remove("ready");
    element("docker-status-title").textContent = "Sanitized preview mode";
    element("docker-status-detail").textContent =
      "Local Docker discovery and installation are disabled in this preview.";
    reviewButton.disabled = true;
    setMessage("Preview mode shows the flow without accessing local Docker or credentials.");
    return;
  }
  if (result.unsupportedPlatform === true) {
    state.dockerAvailable = false;
    indicator.classList.remove("ready");
    element("docker-status-title").textContent =
      "Windows security check failed";
    element("docker-status-detail").textContent =
      "Relmio could not verify an owner-only NTFS ACL. Check Docker Desktop and Windows permissions, or use WSL2.";
    reviewButton.disabled = true;
    setMessage("No local Docker changes were made because the Windows security check failed.");
    return;
  }
  if (state.dockerAvailable) {
    indicator.classList.add("ready");
    state.localN8nStackState =
      ["healthy", "stopped", "partial", "unavailable"].includes(result.localN8nStackState)
        ? result.localN8nStackState
        : null;
    if (state.localN8nStackState === "partial") {
      element("docker-status-title").textContent =
        "Docker is ready. Partial managed stack needs recovery";
      element("docker-status-detail").textContent =
        "Relmio confirmed an owned partial local n8n + ngrok stack. Only the explicit removal recovery is available.";
      reviewButton.disabled = true;
      showDetectedManagedLocalN8nStackRecovery();
      return;
    }
    if (state.localN8nStackState === "stopped") {
      element("docker-status-title").textContent =
        "Docker is ready. Managed stack is stopped";
      element("docker-status-detail").textContent =
        "Relmio verified the complete owned stack. Resume starts its existing containers only.";
      reviewButton.disabled = true;
      showStoppedManagedLocalN8nStack();
      return;
    }
    if (state.localN8nStackState === "healthy") {
      element("docker-status-title").textContent = "Docker is ready. Managed stack is healthy";
      element("docker-status-detail").textContent =
        "The complete Relmio-owned n8n + ngrok stack is healthy. Normal local endpoint and add-on choices remain available.";
      updateReviewAvailability();
      setMessage("Docker and the owned local n8n + ngrok stack are ready. Choose the next local action.");
      return;
    }
    if (state.localN8nStackState === "unavailable") {
      element("docker-status-title").textContent = "Docker is ready. Managed stack status unavailable";
      element("docker-status-detail").textContent =
        "Relmio could not safely classify a prior managed stack. No automatic resume or removal control is available.";
      updateReviewAvailability();
      setMessage("Docker is ready, but Relmio could not verify a prior managed n8n stack. It will not guess or change it.");
      return;
    }
    element("docker-status-title").textContent = "Docker is ready";
    element("docker-status-detail").textContent =
      `Engine ${result.dockerVersion}; Compose ${result.composeVersion}`;
    updateReviewAvailability();
    setMessage("Docker is ready. Choose the credential path for your client.");
  } else {
    indicator.classList.remove("ready");
    element("docker-status-title").textContent = "Docker is not available";
    element("docker-status-detail").textContent =
      "Start Docker Desktop or install Docker Engine with Compose, then reopen this wizard.";
    reviewButton.disabled = true;
    setMessage("Docker is required before Relmio can create a local endpoint.");
  }
}

async function initializeLocalWizard() {
  if (!startOperation(null, "Checking local Docker…")) return;
  try {
    await refreshDockerStatus();
  } catch (error) {
    showError(error);
  } finally {
    stopOperation();
    if (
      !state.dockerAvailable ||
      state.localN8nStackState === "partial" ||
      state.localN8nStackState === "stopped"
    ) {
      element("review-button").disabled = true;
    } else {
      updateReviewAvailability();
    }
  }
}

renderTarget();
initializeLocalDashboard();
initializeLocalUsage();

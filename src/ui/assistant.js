import { bindWizardNavigation, readWizardSession } from "./session.js";

const token = readWizardSession();

const state = {
  fingerprint: null,
  network: null,
  reviewedIncludeSearxng: null,
  installAttempted: false,
  planId: null,
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

const element = (id) => document.getElementById(id);
const message = element("global-message-text");
const errorBox = element("global-error");
const errorMessage = element("global-error-text");

function setMessage(value) {
  message.textContent = value;
}

function clearError() {
  errorBox.hidden = true;
  errorMessage.textContent = "";
}

function showError(error) {
  errorMessage.textContent = error?.message ?? "The request could not be completed.";
  errorBox.hidden = false;
  errorBox.focus();
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
  state.reviewedIncludeSearxng = null;
  element("install-confirm").checked = false;
  element("install-button").disabled = true;
}

const OPERATION_INTERACTIVE_SELECTOR =
  'button, input, select, textarea, summary, a[href], [contenteditable]';
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
  "Timing varies with your remote server and network. Keep this page open. Relmio will unlock this setup when the current operation finishes or stops.";

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
  document.body.dataset.currentStep = String(step);
  let activePanel = null;
  for (const panel of document.querySelectorAll("[data-step]")) {
    const active = Number(panel.dataset.step) === step;
    panel.hidden = !active;
    if (active) activePanel = panel;
  }
  for (const marker of document.querySelectorAll("[data-step-marker]")) {
    const active = Number(marker.dataset.stepMarker) === step;
    marker.toggleAttribute("aria-current", active);
  }
  if (activePanel) activePanel.scrollTop = 0;
  activePanel?.querySelector("h2")?.focus({ preventScroll: true });
}

function resetFingerprint() {
  invalidateReviewedPlan();
  state.fingerprint = null;
  element("fingerprint-box").hidden = true;
  element("fingerprint-confirm").checked = false;
  element("password").value = "";
  element("password").disabled = true;
  updateConnectState();
}

function updateConnectState() {
  element("connect-button").disabled = !(
    state.fingerprint &&
    element("fingerprint-confirm").checked &&
    element("privileged-confirm").checked
  );
}

function renderFingerprint(fingerprint) {
  resetFingerprint();
  state.fingerprint = fingerprint;
  element("fingerprint-value").textContent = fingerprint;
  element("fingerprint-box").hidden = false;
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

function formatInstanceAiStatus(instanceAi) {
  switch (instanceAi?.status) {
    case "enabled":
      return "AI Assistant is enabled: N8N_ENABLED_MODULES includes instance-ai. Refresh discovery after n8n changes.";
    case "configured":
      return "AI Assistant is not enabled: N8N_ENABLED_MODULES does not include instance-ai. Add it as a separate comma-delimited value, keep existing values, then redeploy or restart n8n outside this wizard.";
    case "missing":
      return "AI Assistant is not enabled: add N8N_ENABLED_MODULES=instance-ai to the existing n8n service, then redeploy or restart n8n outside this wizard.";
    default:
      return "AI Assistant prerequisite could not be verified for this n8n container.";
  }
}

async function api(path, { method = "GET", body } = {}) {
  if (!token) throw new Error("The setup session is missing. Start the assistant command again.");
  const response = await fetch(path, {
    method,
    headers: {
      "Content-Type": "application/json",
      "X-Setup-Token": token,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  let result;
  try {
    result = await response.json();
  } catch {
    throw new Error("The wizard returned an unreadable response. Start again.");
  }
  if (!response.ok) throw new Error(result?.error ?? "The request failed.");
  return result;
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
  state.network = result;
  const instanceAiStatus = element("instance-ai-status");
  instanceAiStatus.textContent = formatInstanceAiStatus(result.instanceAi);
  instanceAiStatus.dataset.status = result.instanceAi?.status ?? "unknown";
  const prerequisiteReady = result.instanceAi?.status === "enabled";
  element("review-button").disabled = !prerequisiteReady;
  element("review-readiness").textContent = prerequisiteReady
    ? "Ready to review the companion and SearXNG choice. Nothing has been written."
    : "Enable instance-ai, restart or redeploy n8n, then reconnect before reviewing a plan.";
  fillSelect(
    element("network-select"),
    result.networks.map((network) => ({ value: network, label: network })),
    result.recommended,
  );
}

async function discover() {
  const discovery = await api("/api/discover", { method: "POST", body: {} });
  if (
    !Array.isArray(discovery.containers) ||
    discovery.containers.length === 0
  ) {
    throw new Error("No running official n8n container was found.");
  }
  const networks = await loadNetworks(discovery.containers[0].name);
  return { discovery, networks };
}

function renderDiscovery({ discovery, networks }) {
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
  showStep(2);
}

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
        body: { host: element("host").value, port: element("port").value },
      }),
    );
    if (!result) return;
    renderFingerprint(result.fingerprint);
    setMessage("Confirm the SSH host identity before supplying its password.");
  } catch (error) {
    showError(error);
  }
});

element("fingerprint-confirm").addEventListener("change", (event) => {
  invalidateReviewedPlan();
  element("password").disabled = !event.currentTarget.checked;
  if (!event.currentTarget.checked) element("password").value = "";
  updateConnectState();
});

element("privileged-confirm").addEventListener("change", () => {
  invalidateReviewedPlan();
  updateConnectState();
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
          "Relmio is opening the verified SSH connection and inspecting Docker with read-only commands. Timing varies with your remote server and network. Keep this page open.",
      },
    );
    if (!discovered) return;
    element("password").value = "";
    renderDiscovery(discovered);
    setMessage("n8n was found. Choose an existing Docker network.");
  } catch (error) {
    element("password").value = "";
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
    showError(error);
  }
});

element("network-select").addEventListener("change", () => {
  invalidateReviewedPlan();
  setMessage("Network changed. Review a fresh plan before installing.");
});

element("review-button").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  clearError();
  invalidateReviewedPlan();
  try {
    const networkName = element("network-select").value;
    const includeSearxng = element("include-searxng").checked;
    const plan = await runOperation(
      button,
      "Preparing the exact plan…",
      () => api("/api/assistant/plan", {
        method: "POST",
        body: {
          containerName: element("container-select").value,
          networkName,
          includeSearxng,
        },
      }),
    );
    if (!plan) return;
    const planId = validatePlanId(plan.planId);
    state.reviewedIncludeSearxng = plan.includeSearxng;
    element("review-network").textContent = networkName;
    element("review-instance-ai").textContent = formatInstanceAiStatus(plan.instanceAi);
    element("review-web-search").textContent = plan.includeSearxng
      ? `Attach optional SearXNG web search to ${networkName} with its private alias`
      : "Web search is off. No SearXNG service, settings file, or URL will be installed.";
    state.planId = planId;
    element("install-confirm").checked = false;
    element("install-button").disabled = true;
    showStep(3);
    setMessage("Review this privileged companion plan. The SSH host has not changed.");
  } catch (error) {
    showError(error);
  }
});

element("install-confirm").addEventListener("change", (event) => {
  element("install-button").disabled = !(
    event.currentTarget.checked && state.planId
  );
});

element("include-searxng").addEventListener("change", () => {
  invalidateReviewedPlan();
  setMessage("Web search choice changed. Review a fresh plan before installing.");
});

element("install-button").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  clearError();
  if (!state.planId || !element("install-confirm").checked) {
    invalidateReviewedPlan();
    showError(new Error("Review and confirm a fresh Assistant plan first."));
    return;
  }
  state.installAttempted = true;
  try {
    const result = await runOperation(
      button,
      "Starting the companion…",
      () => api("/api/assistant/install", {
        method: "POST",
        body: {
          containerName: element("container-select").value,
          networkName: element("network-select").value,
          includeSearxng: state.reviewedIncludeSearxng,
          confirmed: element("install-confirm").checked,
          planId: state.planId,
        },
      }),
      {
        progressNote:
          "Docker may be downloading images, building, or starting the reviewed companion. Timing varies with your remote server and network. Keep this page open until verification finishes.",
      },
    );
    if (!result) return;
    invalidateReviewedPlan();
    element("sandbox-url").textContent = result.sandboxUrl;
    element("sandbox-api-key").textContent = typeof result.sandboxApiKey === "string"
      ? result.sandboxApiKey
      : "Unchanged on this managed update; the key is not redisplayed.";
    if (result.includeSearxng === true && typeof result.searxngUrl === "string") {
      element("searxng-url").textContent = result.searxngUrl;
      element("searxng-note").textContent = "SearXNG keeps its server secret private. There is no SearXNG key for you to enter.";
    } else {
      element("searxng-url").textContent = "Web search disabled";
      element("searxng-note").textContent = "Web search is off, so no SearXNG service or settings file was installed. Its retained secret stays private.";
    }
    showStep(4);
    setMessage("Companion verified. Enter these values in n8n’s AI Assistant settings.");
  } catch (error) {
    invalidateReviewedPlan();
    showError(error);
  }
});

bindWizardNavigation(element("setup-another-assistant"), "/assistant", token);

for (const button of document.querySelectorAll(".back-button")) {
  button.addEventListener("click", () => {
    clearError();
    showStep(Number(button.dataset.back));
    setMessage("No new assistant installation has started.");
  });
}

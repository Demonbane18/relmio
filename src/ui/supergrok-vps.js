import { bindWizardNavigation, readWizardSession } from "./session.js";

const token = readWizardSession();
const element = (id) => document.getElementById(id);
const state = {
  busy: false,
  fingerprint: null,
  plan: null,
  requestGeneration: 0,
  loginGeneration: 0,
  pollTimer: null,
  progressTimer: null,
  progressStartedAt: 0,
  status: null,
};

const actionLabels = {
  install: "Install a fresh private SuperGrok companion",
  "sign-in": "Start a fresh official Grok device sign-in",
  "sign-out": "Sign out only this companion's Grok session",
  remove: "Remove this companion and its Grok session volume",
  "cancel-sign-in": "Cancel this companion's pending device sign-in",
};

bindWizardNavigation(element("back-link"), "/", token);
element("back-link").addEventListener("click", (event) => {
  if (!state.busy) return;
  event.preventDefault();
  event.stopImmediatePropagation();
}, true);

function setMessage(text) {
  element("status-message").textContent = text;
}

function showError(error) {
  element("error-message").textContent = error?.message ?? "The operation could not be completed.";
  element("error-message").hidden = false;
  element("error-message").focus();
}

function clearError() {
  element("error-message").hidden = true;
  element("error-message").textContent = "";
}

function setStage(stage) {
  document.body.dataset.stage = String(stage);
  for (const marker of document.querySelectorAll("[data-stage-marker]")) {
    const markerStage = Number(marker.dataset.stageMarker);
    marker.classList.toggle("complete", markerStage < stage);
    if (markerStage === stage) marker.setAttribute("aria-current", "step");
    else marker.removeAttribute("aria-current");
  }
}

function formatElapsed(seconds) {
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

function updateProgress() {
  const elapsed = Math.max(0, Math.floor((Date.now() - state.progressStartedAt) / 1_000));
  element("operation-progress-elapsed").textContent = formatElapsed(elapsed);
  element("operation-progress-elapsed").setAttribute("datetime", `PT${elapsed}S`);
}

function startProgress(label) {
  state.progressStartedAt = Date.now();
  element("operation-progress-label").textContent = label;
  element("operation-progress-bar").setAttribute("aria-valuetext", label);
  element("operation-progress").hidden = false;
  updateProgress();
  state.progressTimer = window.setInterval(updateProgress, 1_000);
}

function stopProgress() {
  window.clearInterval(state.progressTimer);
  state.progressTimer = null;
  element("operation-progress").hidden = true;
  element("operation-progress-label").textContent = "No operation is running.";
  element("operation-progress-elapsed").textContent = "00:00";
  element("operation-progress-elapsed").setAttribute("datetime", "PT0S");
  element("operation-progress-bar").setAttribute("aria-valuetext", "No operation is running.");
}

function controls() {
  return [...document.querySelectorAll("button, input, select, a[href]")];
}

async function perform(label, work) {
  if (state.busy) return undefined;
  state.busy = true;
  clearError();
  setMessage(label);
  document.body.dataset.operationBusy = "true";
  element("main-content").setAttribute("aria-busy", "true");
  const snapshots = controls().map((control) => ({
    control,
    disabled: typeof control.disabled === "boolean" ? control.disabled : null,
    tabIndex: control.getAttribute("tabindex"),
  }));
  for (const { control, disabled } of snapshots) {
    if (disabled !== null) control.disabled = true;
    else control.setAttribute("tabindex", "-1");
  }
  startProgress(label);
  try {
    return await work();
  } catch (error) {
    showError(error);
    return undefined;
  } finally {
    stopProgress();
    for (const { control, disabled, tabIndex } of snapshots) {
      if (disabled !== null) control.disabled = disabled;
      else if (tabIndex === null) control.removeAttribute("tabindex");
      else control.setAttribute("tabindex", tabIndex);
    }
    state.busy = false;
    document.body.dataset.operationBusy = "false";
    element("main-content").setAttribute("aria-busy", "false");
    syncConnectionControls();
  }
}

async function api(path, body = {}) {
  if (!token) {
    throw new Error("This private wizard session is missing. Return to Relmio and open a fresh setup link.");
  }
  let response;
  try {
    response = await fetch(path, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Setup-Token": token },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error("The local wizard server is not reachable. Keep its terminal open, then reopen Relmio.");
  }
  const result = await response.json().catch(() => null);
  if (!result || typeof result !== "object" || Array.isArray(result)) {
    throw new Error("The wizard returned an unreadable response. Start a fresh setup link.");
  }
  if (!response.ok) throw new Error(result.error || "The operation could not be completed.");
  return result;
}

function selectedBoundary() {
  return { containerName: element("container").value, networkName: element("network").value };
}

function boundaryKey(boundary = selectedBoundary()) {
  return `${boundary.containerName}\u0000${boundary.networkName}`;
}

function stopLoginPolling({ clearVisible = false } = {}) {
  state.loginGeneration += 1;
  window.clearTimeout(state.pollTimer);
  state.pollTimer = null;
  if (clearVisible) {
    element("login-panel").hidden = true;
    element("device-code").textContent = "";
    element("device-link").hidden = true;
    element("device-link").removeAttribute("href");
  }
}

function scheduleLoginPoll(installId, generation, delay = 2_000) {
  window.clearTimeout(state.pollTimer);
  state.pollTimer = null;
  if (
    generation !== state.loginGeneration ||
    state.status?.installId !== installId
  ) return;
  state.pollTimer = window.setTimeout(() => {
    state.pollTimer = null;
    void pollLogin(installId, generation);
  }, delay);
}

function invalidateReview({ hide = true } = {}) {
  state.plan = null;
  element("confirm-action").checked = false;
  element("apply-button").disabled = true;
  if (hide) element("review-panel").hidden = true;
}

function invalidateBoundaryState() {
  state.requestGeneration += 1;
  invalidateReview();
  stopLoginPolling({ clearVisible: true });
  state.status = null;
  element("client-key").value = "";
  element("settings-panel").hidden = true;
  element("models-result").textContent = "";
}

function syncConnectionControls() {
  const trusted = Boolean(state.fingerprint && element("trust-host").checked);
  element("password").disabled = !trusted;
  element("connect-button").disabled = !trusted;
  element("apply-button").disabled = !state.plan || !element("confirm-action").checked;
}

function selectOptions(node, values) {
  node.replaceChildren(...values.map(([value, label]) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    return option;
  }));
}

function renderStatus(next) {
  if (state.status?.installId !== next.installId) {
    element("client-key").value = "";
    element("models-result").textContent = "";
  }
  state.status = next;
  const copy = next.state === "absent"
    ? "No Relmio-managed SuperGrok companion is installed for this VPS."
    : next.state === "healthy"
      ? "The private companion is healthy. Complete official Grok sign-in, then check your account models."
      : "An incomplete companion was detected. Review its removal before installing again.";
  element("installation-state").textContent = copy;
  element("settings-panel").hidden = next.state !== "healthy";
  for (const button of document.querySelectorAll("[data-action]")) {
    const action = button.dataset.action;
    button.hidden = next.credentialActionRunning
      ? action !== "cancel-sign-in"
      : action === "cancel-sign-in" || (action === "install" ? next.state !== "absent" : action === "remove" ? next.state === "absent" : next.state !== "healthy");
  }
  setStage(next.state === "healthy" ? 4 : 2);
}

async function refreshStatus() {
  invalidateReview();
  const boundary = selectedBoundary();
  if (!boundary.networkName) return;
  const requestGeneration = ++state.requestGeneration;
  const next = await api("/api/vps/supergrok/status", boundary);
  if (requestGeneration !== state.requestGeneration || boundaryKey(boundary) !== boundaryKey()) return;
  renderStatus(next);
  setMessage("VPS status checked. Existing n8n is unchanged.");
}

async function loadNetworks() {
  invalidateBoundaryState();
  const containerName = element("container").value;
  const requestGeneration = ++state.requestGeneration;
  const result = await api("/api/networks", { containerName });
  if (requestGeneration !== state.requestGeneration || containerName !== element("container").value) return;
  selectOptions(element("network"), result.networks.map((name) => [name, name]));
  await refreshStatus();
}

async function discover() {
  invalidateBoundaryState();
  const requestGeneration = ++state.requestGeneration;
  const result = await api("/api/discover");
  if (requestGeneration !== state.requestGeneration) return;
  if (!Array.isArray(result.containers) || result.containers.length === 0) {
    throw new Error("No running n8n container was found on this VPS.");
  }
  selectOptions(element("container"), result.containers.map((item) => [item.name, `${item.name} — ${item.image}`]));
  element("ssh-panel").hidden = true;
  element("selection-panel").hidden = false;
  setStage(2);
  await loadNetworks();
}

function resetHost() {
  state.fingerprint = null;
  invalidateBoundaryState();
  element("trust-host").checked = false;
  element("fingerprint-box").hidden = true;
  element("fingerprint").textContent = "";
  element("password").value = "";
  syncConnectionControls();
}

async function prepareReview(action) {
  invalidateReview();
  const boundary = selectedBoundary();
  const reviewed = await api("/api/vps/supergrok/plan", { ...boundary, action });
  if (boundaryKey(boundary) !== boundaryKey()) return;
  state.plan = reviewed;
  element("review-summary").textContent = `${actionLabels[reviewed.action]}. ${reviewed.action === "remove" ? "Its saved OAuth session will be deleted; other companions and n8n data will remain." : "No existing provider credentials will be copied."}`;
  element("review-container").textContent = reviewed.containerName;
  element("review-network").textContent = reviewed.networkName;
  element("apply-button").textContent = actionLabels[reviewed.action];
  element("review-panel").hidden = false;
  setStage(3);
  element("review-title").focus({ preventScroll: true });
  element("review-panel").scrollIntoView({ block: "center", behavior: "smooth" });
  setMessage("Review the action and confirm when ready.");
}

async function pollLogin(installId, generation) {
  if (generation !== state.loginGeneration) return;
  if (state.busy) {
    scheduleLoginPoll(installId, generation, 500);
    return;
  }
  try {
    const result = await api("/api/vps/supergrok/login-status", { installId });
    if (generation !== state.loginGeneration || state.status?.installId !== installId) return;
    if (state.busy) {
      scheduleLoginPoll(installId, generation, 500);
      return;
    }
    element("login-panel").hidden = false;
    element("login-state").textContent = result.state === "pending"
      ? "Complete the sign-in on the official Grok page, then return here."
      : result.state === "complete"
        ? "The official Grok action completed. Check models to verify your account connection."
        : result.state === "expired"
          ? "This device code expired before sign-in completed. Start a fresh official Grok sign-in."
          : result.state === "cancelled"
            ? "This device sign-in was cancelled. Start a new official Grok sign-in when ready."
            : "The official Grok sign-in failed. Refresh status and start a new sign-in.";
    element("device-code").textContent = result.userCode || "";
    element("device-link").hidden = !result.verificationUrl;
    if (result.verificationUrl) element("device-link").href = result.verificationUrl;
    if (result.state === "pending") {
      scheduleLoginPoll(installId, generation);
    } else {
      await perform("Refreshing account state…", refreshStatus);
    }
  } catch {
    if (generation === state.loginGeneration) setMessage("The sign-in status could not be refreshed. Reconnect if the SSH session expired.");
  }
}

for (const id of ["host", "port"]) element(id).addEventListener("input", resetHost);

element("scan-button").addEventListener("click", () => {
  void perform("Checking VPS identity…", async () => {
    resetHost();
    const result = await api("/api/ssh/fingerprint", { host: element("host").value, port: element("port").value });
    state.fingerprint = result.fingerprint;
    element("fingerprint").textContent = state.fingerprint;
    element("fingerprint-box").hidden = false;
    setMessage("Compare the fingerprint before entering your password.");
  });
});

element("trust-host").addEventListener("change", () => {
  if (!element("trust-host").checked) element("password").value = "";
  syncConnectionControls();
});

element("ssh-form").addEventListener("submit", (event) => {
  event.preventDefault();
  if (!state.fingerprint || !element("trust-host").checked) return;
  void perform("Connecting and finding n8n…", async () => {
    const password = element("password").value;
    element("password").value = "";
    await api("/api/ssh/connect", { host: element("host").value, port: element("port").value, username: "root", password, expectedFingerprint: state.fingerprint });
    await discover();
  });
});

element("container").addEventListener("change", () => void perform("Reading private networks…", loadNetworks));
element("network").addEventListener("change", () => void perform("Checking companion…", refreshStatus));
element("refresh-button").addEventListener("click", () => void perform("Checking companion…", refreshStatus));

for (const button of document.querySelectorAll("[data-action]")) {
  button.addEventListener("click", () => void perform("Preparing the review…", () => prepareReview(button.dataset.action)));
}

element("confirm-action").addEventListener("change", syncConnectionControls);
element("cancel-review").addEventListener("click", () => {
  if (state.busy) return;
  invalidateReview();
  setStage(2);
  element("selection-title").focus({ preventScroll: true });
  setMessage("No companion action was applied.");
});

element("apply-button").addEventListener("click", () => {
  if (!state.plan || !element("confirm-action").checked) return;
  void perform("Applying the reviewed companion action…", async () => {
    const reviewed = state.plan;
    invalidateReview();
    const result = await api("/api/vps/supergrok/apply", { ...reviewed, confirmed: true });
    await refreshStatus();
    if (result.clientKey) element("client-key").value = result.clientKey;
    if (result.state === "pending") {
      stopLoginPolling();
      const generation = ++state.loginGeneration;
      scheduleLoginPoll(result.installId, generation, 1_500);
    }
    if (result.state === "cancelled" || result.removed) stopLoginPolling({ clearVisible: true });
    if (result.removed) element("client-key").value = "";
    setMessage(result.removed ? "The SuperGrok companion was removed. Existing n8n is unchanged." : "The reviewed companion action completed. Existing n8n is unchanged.");
  });
});

element("models-button").addEventListener("click", () => {
  void perform("Checking your account models…", async () => {
    const result = await api("/api/vps/supergrok/models", { installId: state.status?.installId, clientKey: element("client-key").value });
    element("models-result").textContent = result.status === 200
      ? `Available models: ${result.models.join(", ")}`
      : result.code === "login_required"
        ? "Sign-in is required. Start an official Grok device sign-in for this companion."
        : "Account model discovery failed. Try again after checking your Grok account.";
    setMessage("Model check finished.");
  });
});

element("copy-key").addEventListener("click", async () => {
  if (state.busy || !element("client-key").value) return;
  try {
    await navigator.clipboard.writeText(element("client-key").value);
    setMessage("Local bearer copied. Paste it directly into the n8n credential.");
  } catch {
    showError(new Error("Clipboard access was refused by the browser. Select the local bearer manually."));
  }
});

element("disconnect-button").addEventListener("click", () => {
  void perform("Disconnecting…", async () => {
    await api("/api/disconnect");
    invalidateBoundaryState();
    element("ssh-panel").hidden = false;
    element("selection-panel").hidden = true;
    resetHost();
    setStage(1);
    setMessage("Disconnected. Your installed companion remains on the VPS.");
  });
});

window.addEventListener("pagehide", () => {
  stopLoginPolling();
  element("client-key").value = "";
});

if (!token) {
  setMessage("Open this page from the Relmio wizard to establish a private session.");
} else {
  void perform("Checking the VPS connection…", async () => {
    try {
      await discover();
    } catch (error) {
      if (error.message !== "Connect to the VPS first.") throw error;
      element("ssh-panel").hidden = false;
      setStage(1);
      setMessage("Connect to your VPS to begin. No ChatGPT sign-in is required.");
    }
  });
}

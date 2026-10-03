import { bindSshAuthentication, clearFieldError, createCredentialSshGuard, markRejectedField } from "./ssh-form.js";
import { readWizardSession } from "./session.js";
import { initWizardTopbar } from "./topbar.js";

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
let sshIdentityDecision = 0;
const sshSession = createCredentialSshGuard({ token, onIdentityDecision() { sshIdentityDecision++; }, onMismatch() {
  invalidateBoundaryState();
  element("container").replaceChildren();
  element("network").replaceChildren();
  element("ssh-panel").hidden = false;
  element("selection-panel").hidden = true;
  resetHost();
  setStage(1);
} });

const actionLabels = {
  install: "Install a fresh private SuperGrok companion",
  "sign-in": "Start a fresh official Grok device sign-in",
  "sign-out": "Sign out only this companion's Grok session",
  remove: "Remove this companion and its Grok session volume",
  "cancel-sign-in": "Cancel this companion's pending device sign-in",
};

function setMessage(text) {
  element("status-message").textContent = text;
}

function showError(error) {
  const text = markRejectedField(error?.message ?? "The operation could not be completed.", element, "error-message");
  element("error-message").textContent = text;
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
    if (markerStage < stage) marker.dataset.state = "done";
    else delete marker.dataset.state;
    if (markerStage === stage) marker.setAttribute("aria-current", "step");
    else marker.removeAttribute("aria-current");
  }
  syncView();
}

// One step panel is visible at a time: the panel for the current stage, or the
// nearest available panel while a reviewed action is being applied.
const STAGE_VIEWS = {
  1: ["ssh-panel", "selection-panel"],
  2: ["selection-panel", "ssh-panel"],
  3: ["review-panel", "settings-panel", "selection-panel", "ssh-panel"],
  4: ["settings-panel", "selection-panel", "ssh-panel"],
};
let currentView = "ssh-panel";
function focusVisible(target) {
  target.focus({ preventScroll: true });
  const rect = target.getBoundingClientRect();
  const footer = target.closest(".rm-panel")?.querySelector(".rm-panel__footer");
  const bottom = footer && getComputedStyle(footer).position === "sticky"
    ? Math.min(innerHeight, footer.getBoundingClientRect().top) : innerHeight;
  if (rect.top < document.querySelector(".rm-topbar").getBoundingClientRect().bottom || rect.bottom > bottom) {
    target.scrollIntoView({ block: "start", behavior: "instant" });
  }
}

function syncView() {
  const order = STAGE_VIEWS[document.body.dataset.stage] ?? STAGE_VIEWS[1];
  const next = order.find((id) => !element(id).hidden) ?? "ssh-panel";
  const continueButton = element("selection-continue");
  // Write only real changes: this runs from a MutationObserver on `hidden`.
  if (continueButton.hidden !== element("settings-panel").hidden) continueButton.hidden = element("settings-panel").hidden;
  if (next === currentView) return;
  const previous = element(currentView);
  const active = document.activeElement;
  for (const id of STAGE_VIEWS[3]) element(id).toggleAttribute("data-current", id === next);
  currentView = next;
  const heading = element(next).querySelector("h2");
  if (active && previous.contains(active)) focusVisible(heading);
  else if (!active || active === document.body) focusVisible(heading);
}

async function readProjectMeta() {
  if (!token) throw new Error("This private wizard session is missing.");
  const response = await fetch("/api/local/project-meta", {
    headers: { "X-Setup-Token": token }, credentials: "omit", mode: "same-origin", redirect: "error", cache: "no-store",
  });
  if (!response.ok) throw new Error("Relmio project details are unavailable.");
  return response.json();
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
  // "nearest" scrolls only when the card is out of view, so the startup check does not move the page.
  element("operation-progress").scrollIntoView?.({ block: "nearest", behavior: "instant" });
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
  return [...document.querySelectorAll("button, input, select, textarea, summary, a[href]")];
}

for (const name of ["click", "pointerdown", "keydown", "beforeinput", "input", "change", "submit"]) {
  document.addEventListener(name, (event) => {
    if (!state.busy || (name === "keydown" && event.key === "Tab")) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
}

async function perform(label, work) {
  if (state.busy) return undefined;
  state.busy = true;
  clearError();
  setMessage(label);
  document.body.dataset.operationBusy = "true";
  element("route-steps-content").setAttribute("aria-busy", "true");
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
    element("route-steps-content").setAttribute("aria-busy", "false");
    syncConnectionControls();
  }
}

async function api(path, body = {}) {
  if (!token) {
    throw new Error("This private wizard session is missing. Return to Relmio and open a fresh setup link.");
  }
  await sshSession.before(path);
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
  await sshSession.after(path, result);
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
  sshAuthentication.sync({ trusted });
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
  if (reviewed.action !== action || reviewed.containerName !== boundary.containerName || reviewed.networkName !== boundary.networkName ||
    reviewed.operationLockPath !== "/docker/n8n-openai-oauth/.supergrok-operation.lock" ||
    reviewed.temporaryBuildStatePath !== (["install", "sign-in", "sign-out"].includes(action) ? "/docker/n8n-openai-oauth/.supergrok-operation.lock/buildx" : null)) {
    throw new Error("The reviewed SuperGrok build boundary is invalid. Review a fresh plan.");
  }
  if (boundaryKey(boundary) !== boundaryKey()) return;
  state.plan = reviewed;
  element("review-summary").textContent = `${actionLabels[reviewed.action]}. ${reviewed.action === "remove" ? "Its saved OAuth session will be deleted. Other companions and n8n data stay." : "No existing provider credentials will be copied."} Serializes with ${reviewed.operationLockPath}.`;
  if (reviewed.temporaryBuildStatePath) {
    element("review-summary").textContent += ` After you confirm, builds use a temporary root-only folder at ${reviewed.temporaryBuildStatePath}. If cleanup is uncertain, that folder and its lock may remain for you to inspect. Registry credentials are not copied or printed. Cleanup does not change n8n or model caches.`;
  }
  element("review-container").textContent = reviewed.containerName;
  element("review-network").textContent = reviewed.networkName;
  element("apply-button").textContent = actionLabels[reviewed.action];
  element("review-panel").hidden = false;
  setStage(3);
  focusVisible(element("review-title"));
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

for (const id of ["host", "port"]) element(id).addEventListener("input", () => {
  clearFieldError(element(id), "error-message");
  clearError();
  resetHost();
});
for (const id of ["username", "password"]) element(id).addEventListener("input", () => {
  clearFieldError(element(id), "error-message");
  clearError();
});
element("ssh-form").addEventListener("invalid", (event) => {
  const label = { host: "Hostname", port: "Port", username: "Username", password: "Password" }[event.target.id];
  if (!label) return;
  event.preventDefault();
  showError(new Error(`${label} is invalid.`));
}, true);

element("scan-button").addEventListener("click", () => {
  clearError();
  for (const id of ["host", "port"]) {
    if (!element(id).checkValidity()) {
      showError(new Error(id === "host" ? "Hostname is invalid." : "Port is invalid."));
      return;
    }
  }
  void perform("Checking VPS identity…", async () => {
    resetHost();
    const result = await api("/api/ssh/fingerprint", { host: element("host").value, port: element("port").value });
    for (const id of ["host", "port"]) clearFieldError(element(id), "error-message");
    state.fingerprint = result.fingerprint;
    element("fingerprint").textContent = state.fingerprint;
    element("fingerprint-box").hidden = false;
    setMessage("Compare the fingerprint before authenticating.");
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
    await api("/api/ssh/connect", sshAuthentication.request(state.fingerprint));
    for (const id of ["username", "password"]) clearFieldError(element(id), "error-message");
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
  focusVisible(element("selection-title"));
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

element("copy-key").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  const input = element("client-key");
  if (state.busy || !input.value) return;
  try {
    try {
      await navigator.clipboard.writeText(input.value);
    } catch {
      const fallback = document.createElement("textarea");
      fallback.value = input.value;
      fallback.style.position = "fixed";
      fallback.style.opacity = "0";
      document.body.append(fallback);
      try {
        fallback.focus();
        fallback.select();
        if (!document.execCommand("copy")) throw new Error("Clipboard unavailable.");
      } finally {
        fallback.remove();
        button.focus();
      }
    }
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

element("settings-back").addEventListener("click", () => {
  if (!state.busy) setStage(2);
});

element("selection-continue").addEventListener("click", () => {
  if (!state.busy && !element("settings-panel").hidden) setStage(4);
});

new MutationObserver(syncView).observe(element("main-content"), { subtree: true, attributeFilter: ["hidden"] });
initWizardTopbar({ session: token, isBusy: () => state.busy, loadProjectMeta: readProjectMeta });

const sshAuthentication = bindSshAuthentication({ token, trustId: "trust-host", onChange: invalidateBoundaryState, shouldApplyConnectionStatus: () => sshIdentityDecision === 0 });

if (!token) {
  setMessage("Open this page from the Relmio wizard to establish a private session.");
} else {
  void perform("Checking the VPS connection…", async () => {
    try {
      await sshSession.adoptCurrent();
      await discover();
    } catch (error) {
      if (error.message !== "Connect to the VPS first.") throw error;
      element("ssh-panel").hidden = false;
      setStage(1);
      setMessage("Connect to your VPS to begin. No ChatGPT sign-in is required.");
    }
  });
}

import { bindWizardNavigation, readWizardSession } from "./session.js";
import { initWizardTopbar } from "./topbar.js";
import { bindSshAuthentication, clearFieldError, markRejectedField, readSshIdentity, sameSshIdentity, setFieldError, validateSshIdentity } from "./ssh-form.js";
import { HOSTING_PROVIDERS, getHostingProvider } from "../domain/hosting-providers.js";

const token = readWizardSession();
const el = (id) => document.getElementById(id);
const MODELS = new Set(["qwen3:0.6b", "qwen3:1.7b", "qwen3.5:2b", "qwen3.5:4b", "qwen3.5:9b"]);
const STATES = new Set(["absent", "unavailable", "partial", "runtime-ready", "downloading", "model-ready", "model-error"]);
const ENDPOINT = "http://n8n-local-model:11434/v1";
const RUNTIME_IMAGE = "ollama/ollama:0.34.4@sha256:8262851b2846b87c649eddf3e76beb270c52f4d1bc94559f47efde16b0841551";
const state = { busy: false, fingerprint: null, connectedIdentity: null, generation: 0, plan: null, status: null, timer: null, manual: false };
const sshAuthentication = bindSshAuthentication({ token, trustId: "trust", onChange: invalidate, allowSudo: true });
function selectedHosting() {
  try { return getHostingProvider(el("hosting-provider").value); }
  catch { return null; }
}
function supportedHosting() { return selectedHosting()?.kind === "managed-vm"; }
function requireSupportedHosting() {
  if (!supportedHosting()) throw new Error("This product cannot use managed VPS SSH. Review its hosting options instead.");
}
function updateHosting() {
  const provider = selectedHosting();
  el("hosting-hint").textContent = provider?.sshHint ?? "Unknown hosting product. Managed VPS SSH is unavailable.";
  el("hosting-alternative").hidden = supportedHosting();
}
setOptions(el("hosting-provider"), HOSTING_PROVIDERS.map(({ id, label }) => [id, label]));
updateHosting();
el("hosting-provider").addEventListener("change", () => {
  invalidate();
  updateHosting();
  // Guidance never replaces a human-selected host, login, auth, or administrative context.
  syncTrust(); syncConfirm();
});

bindWizardNavigation(el("hosting-guide-link"), "/hosting", token);

function message(text) { el("message").textContent = text; }
function error(text) {
  el("error").textContent = markRejectedField(text, el, "error");
  el("error").hidden = false;
  el("error").focus();
}
function invalidate() {
  state.generation++;
  state.plan = null;
  el("review-panel").hidden = true;
  el("confirm").checked = false;
  el("cache-confirm").checked = false;
  el("apply").disabled = true;
  clearTimeout(state.timer);
  state.timer = null;
}
function connectedIdentityMatches() {
  return state.connectedIdentity !== null &&
    el("host").value === state.connectedIdentity.host &&
    Number(el("port").value) === state.connectedIdentity.port &&
    el("username").value === state.connectedIdentity.username &&
    el("ssh-authentication").value === state.connectedIdentity.authentication &&
    el("ssh-privilege").value === state.connectedIdentity.privilege &&
    state.fingerprint === state.connectedIdentity.fingerprint &&
    el("trust").checked;
}
function requireConnectedIdentity() {
  requireSupportedHosting();
  if (connectedIdentityMatches()) return state.connectedIdentity;
  invalidate();
  el("settings-panel").hidden = true;
  el("selection-panel").hidden = true;
  el("manual-recovery").hidden = true;
  throw new Error("The trusted VPS identity changed. Disconnect and reconnect before reviewing model actions.");
}
function adoptConnectedIdentity(identity) {
  validateSshIdentity(identity);
  state.connectedIdentity = { ...identity };
  el("host").value = identity.host;
  el("port").value = String(identity.port);
  el("username").value = identity.username;
  el("ssh-authentication").value = identity.authentication;
  el("ssh-privilege").value = identity.privilege;
  el("ssh-session").textContent = `Verified ${identity.username}@${identity.host}:${identity.port}, ${identity.authentication}, ${identity.privilege}, UID ${identity.loginUid} → ${identity.effectiveUid}; ${identity.scope}.`;
  el("ssh-disconnect").hidden = false;
  state.fingerprint = identity.fingerprint;
  el("fingerprint").textContent = identity.fingerprint;
  el("fingerprint-box").hidden = false;
  el("trust").checked = true;
  el("manual-recovery").hidden = true;
  syncTrust();
}

async function verifyConnectedIdentity() {
  const identity = requireConnectedIdentity();
  let authenticated;
  try { authenticated = await readSshIdentity(token, { allowModelOnly: true }); }
  catch (failure) {
    invalidate();
    el("settings-panel").hidden = true;
    el("selection-panel").hidden = true;
    el("manual-recovery").hidden = true;
    throw failure;
  }
  if (!sameSshIdentity(authenticated, identity)) {
    invalidate();
    el("settings-panel").hidden = true;
    el("selection-panel").hidden = true;
    el("manual-recovery").hidden = true;
    throw new Error("The authenticated VPS changed. Disconnect and reconnect before reviewing model actions.");
  }
  return identity;
}

function syncTrust() {
  const connected = state.connectedIdentity !== null;
  const eligible = supportedHosting();
  const trusted = Boolean(state.fingerprint && el("trust").checked);
  for (const id of ["host", "port", "trust"]) el(id).disabled = connected || !eligible;
  el("hosting-provider").disabled = connected;
  el("scan").disabled = connected || state.busy || !eligible;
  sshAuthentication.sync({ trusted: trusted && eligible, locked: connected || !eligible });
  el("connect").disabled = connected || !trusted || state.busy || !eligible;
}
function syncConfirm() {
  el("apply").disabled = !supportedHosting() || !connectedIdentityMatches() || !state.plan || !el("confirm").checked ||
    (state.plan.action === "remove" && !el("cache-confirm").checked) || state.busy;
}
function boundary() {
  return state.manual
    ? { containerName: el("manual-container").value, networkName: el("manual-network").value }
    : { containerName: el("container").value, networkName: el("network").value };
}
function current(key, generation) {
  const selected = boundary();
  return generation === state.generation && key === `${selected.containerName}\0${selected.networkName}`;
}
async function api(path, body) {
  if (!token) throw new Error("Open a fresh private Relmio wizard session.");
  const response = await fetch(path, {
    method: "POST", headers: { "Content-Type": "application/json", "X-Setup-Token": token },
    body: JSON.stringify(body), credentials: "omit", mode: "same-origin", redirect: "error",
  });
  const data = await response.json().catch(() => null);
  if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Unreadable wizard response. Reconnect and inspect again.");
  if (!response.ok) throw new Error(typeof data.error === "string" ? data.error : "The operation failed.");
  return data;
}
for (const name of ["click", "pointerdown", "keydown", "beforeinput", "input", "change", "submit"]) {
  document.addEventListener(name, (event) => {
    if (!state.busy || (name === "keydown" && event.key === "Tab")) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
}
async function perform(label, task) {
  if (state.busy) return;
  state.busy = true;
  el("error").hidden = true;
  el("progress").hidden = true;
  message(label);
  // "nearest" scrolls only when the status is out of view, so the startup check does not move the page.
  el("message").scrollIntoView?.({ block: "nearest", behavior: "instant" });
  el("route-steps-content").setAttribute("aria-busy", "true");
  const controls = [...document.querySelectorAll("button, input, select, textarea, summary, a[href]")].map((control) => ({
    control, disabled: typeof control.disabled === "boolean" ? control.disabled : null,
    tabIndex: control.getAttribute("tabindex"),
  }));
  for (const { control, disabled } of controls) {
    if (disabled !== null) control.disabled = true;
    else control.setAttribute("tabindex", "-1");
  }
  try { await task(); } catch (failure) { error(failure?.message || "The operation failed."); }
  finally {
    state.busy = false;
    el("route-steps-content").setAttribute("aria-busy", "false");
    for (const { control, disabled, tabIndex } of controls) {
      if (disabled !== null) control.disabled = disabled;
      else if (tabIndex === null) control.removeAttribute("tabindex");
      else control.setAttribute("tabindex", tabIndex);
    }
    syncTrust(); syncConfirm();
  }
}
function setOptions(select, values) {
  select.replaceChildren(...values.map(([value, label]) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    return option;
  }));
}
function validStatus(status) {
  if (!STATES.has(status?.state)) throw new Error("The model status is invalid. Reconnect and inspect again.");
  if (!["absent", "unavailable"].includes(status.state)) {
    if (!MODELS.has(status.modelId) || (status.endpoint != null && status.endpoint !== ENDPOINT)) {
      throw new Error("The selected model identity changed. Reconnect and inspect again.");
    }
  }
  return status;
}
function formatBytes(bytes) {
  return Number.isSafeInteger(bytes) && bytes >= 0 ? `${(bytes / 1_000_000_000).toFixed(2)} GB` : "not yet known";
}
function renderStatus(status) {
  state.status = validStatus(status);
  el("installation-state").textContent = {
    absent: "No owned local model found. Review a new install.",
    unavailable: "Docker or the owned model cannot be checked safely. Do not apply changes until the check succeeds.",
    partial: "An incomplete install may allow a reviewed retry after ownership checks. Ambiguous or active operations cannot be retried.",
    "runtime-ready": "The runtime is installed. Inference is not verified yet.",
    downloading: "The selected model is downloading or being checked.",
    "model-ready": "The selected model completed a bounded inference check.",
    "model-error": "Download or inference check failed. The model cache is kept. Review a retry.",
  }[status.state];
  const owned = !["absent", "unavailable"].includes(status.state);
  el("review-install").hidden = state.manual || status.state !== "absent";
  el("review-retry").hidden = state.manual || !["runtime-ready", "model-error", "partial"].includes(status.state);
  el("review-remove").hidden = status.state === "absent" || (!state.manual && !owned);
  el("settings-panel").hidden = status.state !== "model-ready";
  if (status.state === "model-ready") {
    el("selected-model").textContent = status.modelId;
    el("readiness").textContent = "The model answered a bounded check. Test your own n8n workflow separately. This is not proof that every workflow works.";
  }
  if (status.state === "downloading") schedulePoll();
  else {
    clearTimeout(state.timer);
    state.timer = null;
    el("progress").hidden = true;
    message(el("installation-state").textContent);
  }
}
async function refreshStatus() {
  await verifyConnectedIdentity();
  invalidate();
  el("settings-panel").hidden = true;
  const selected = boundary();
  if (!selected.networkName) return;
  const generation = state.generation;
  const key = `${selected.containerName}\0${selected.networkName}`;
  const result = await api("/api/vps/local-model/status", selected);
  if (!current(key, generation)) return;
  renderStatus(result);
}
async function loadNetworks() {
  await verifyConnectedIdentity();
  invalidate();
  state.manual = false;
  const containerName = el("container").value;
  const generation = state.generation;
  const result = await api("/api/networks", { containerName });
  if (generation !== state.generation || containerName !== el("container").value || !Array.isArray(result.networks)) return;
  setOptions(el("network"), result.networks.map((name) => [name, name]));
  await refreshStatus();
}
async function discover() {
  await verifyConnectedIdentity();
  invalidate();
  el("selection-panel").hidden = true;
  el("settings-panel").hidden = true;
  el("manual-recovery").hidden = true;
  const generation = state.generation;
  const result = await api("/api/discover", {});
  if (generation !== state.generation) return;
  if (!Array.isArray(result.containers)) throw new Error("The n8n discovery response is invalid.");
  if (result.containers.length === 0) {
    const failure = new Error("No running n8n container found.");
    failure.code = "NO_RUNNING_N8N";
    throw failure;
  }
  setOptions(el("container"), result.containers.map((container) => [container.name, container.name]));
  await loadNetworks();
  el("selection-panel").hidden = false;
}
function validPlan(plan, action) {
  if (!plan || plan.action !== action || typeof plan.planId !== "string" ||
    plan.containerName !== boundary().containerName || plan.networkName !== boundary().networkName ||
    !MODELS.has(plan.modelId) || plan.endpoint !== ENDPOINT ||
    plan.catalogRevision !== "2026-09-26" || plan.runtimeImage !== RUNTIME_IMAGE ||
    !/^sha256:[a-f0-9]{64}$/u.test(plan.approvedModelDigest) ||
    !Number.isSafeInteger(plan.memoryBytes) || plan.memoryBytes <= 0 ||
    !Number.isFinite(plan.cpus) || plan.cpus <= 0 ||
    !Number.isSafeInteger(plan.contextTokens) || plan.contextTokens <= 0 ||
    !Number.isSafeInteger(plan.expectedDownloadBytes) || plan.expectedDownloadBytes <= 0 ||
    !Number.isSafeInteger(plan.requiredDiskBytes) || plan.requiredDiskBytes <= 0 ||
    !Number.isSafeInteger(plan.reservedMemoryBytes) || plan.reservedMemoryBytes <= 0 ||
    !Number.isSafeInteger(plan.hostResources?.memoryBytes) || plan.hostResources.memoryBytes <= 0 ||
    !Number.isFinite(plan.hostResources.cpus) || plan.hostResources.cpus <= 0 ||
    !Number.isSafeInteger(plan.hostResources.diskAvailableBytes) || plan.hostResources.diskAvailableBytes <= 0 ||
    plan.installDirectory !== "/docker/n8n-openai-oauth/local-model" ||
    plan.operationLockPath !== "/docker/n8n-openai-oauth/.local-model-operation.lock" ||
    plan.temporaryBuildStatePath !== (action === "remove" ? null : "/docker/n8n-openai-oauth/.local-model-operation.lock/buildx") ||
    (action === "install"
      ? !plan.sharedRootBootstrap ||
        Object.keys(plan.sharedRootBootstrap).sort().join(",") !== "directory,markerPath,mayCreateDirectory,mayCreateMarker,preservesExistingMode" ||
        plan.sharedRootBootstrap.directory !== "/docker/n8n-openai-oauth" ||
        plan.sharedRootBootstrap.markerPath !== "/docker/n8n-openai-oauth/.managed-by-relmio-root" ||
        plan.sharedRootBootstrap.mayCreateDirectory !== true ||
        plan.sharedRootBootstrap.mayCreateMarker !== true ||
        plan.sharedRootBootstrap.preservesExistingMode !== true
      : plan.sharedRootBootstrap !== null) ||
    !Array.isArray(plan.publishedPorts) || plan.publishedPorts.length !== 0 ||
    !Array.isArray(plan.existingN8nChanges) || plan.existingN8nChanges.length !== 0 ||
    plan.existingN8nRestarts !== 0 ||
    (action === "remove" && plan.clearModelCache !== true)) {
    throw new Error("The reviewed model action is invalid. Inspect again.");
  }
  return plan;
}
async function review(action) {
  const identity = await verifyConnectedIdentity();
  invalidate();
  if (state.manual && action !== "remove") throw new Error("Recovery without running n8n can only remove attested owned files and cache.");
  const selected = boundary();
  const generation = state.generation;
  const key = `${selected.containerName}\0${selected.networkName}`;
  const body = { ...selected, action, ...(action === "install" ? { modelId: el("model").value } : {}), ...(action === "remove" ? { clearModelCache: true } : {}) };
  const plan = validPlan(await api("/api/vps/local-model/plan", body), action);
  await verifyConnectedIdentity();
  if (!current(key, generation)) return;
  state.plan = plan;
  el("review-action").textContent = action === "remove" ? "Permanently remove the owned runtime and model cache" : action === "retry" ? "Retry the same selected model" : "Install runtime and download selected model";
  el("review-action").textContent += action === "install"
    ? `; may create ${plan.sharedRootBootstrap.directory} and ${plan.sharedRootBootstrap.markerPath}, keeping an existing parent's mode.`
    : "; no shared-root creation.";
  // Lock, build, measurement, digest and runtime facts sit behind "Technical
  // details" so the review fits one screen (DESIGN.md); every fact stays on the
  // reviewed page.
  el("review-details").textContent = action === "install" ? `Uses lock ${plan.operationLockPath}.` : `Serializes with ${plan.operationLockPath}.`;
  if (plan.temporaryBuildStatePath) {
    el("review-details").textContent += ` After you confirm, builds use a temporary root-only folder at ${plan.temporaryBuildStatePath}. If cleanup is uncertain, that folder and its lock may remain for you to inspect. Registry credentials are not copied or printed. Cleanup does not change n8n or the model cache.`;
  }
  el("review-details").textContent += ` Measured server: ${formatBytes(plan.hostResources.memoryBytes)} memory, ${plan.hostResources.cpus} CPUs, ${formatBytes(plan.hostResources.diskAvailableBytes)} available disk; ${formatBytes(plan.reservedMemoryBytes)} reserved for OS, n8n and helper. Approved manifest ${plan.approvedModelDigest}. Runtime: ${plan.runtimeImage}.`;
  el("review-boundary").textContent = `${identity.username}@${identity.host}:${identity.port} (${identity.authentication}; ${identity.privilege}; UID ${identity.loginUid} → ${identity.effectiveUid}; SSH ${identity.fingerprint}) · ${plan.containerName} / ${plan.networkName}`;
  el("review-model").textContent = plan.modelId;
  el("review-budget").textContent = `${formatBytes(plan.memoryBytes)} model memory; ${plan.cpus} CPUs; ${plan.contextTokens} context tokens.`;
  el("review-download").textContent = action === "remove" ? "Owned model cache and weights will be deleted" : `${formatBytes(plan.expectedDownloadBytes)} expected model layers; ${formatBytes(plan.requiredDiskBytes)} estimated free disk requirement`;
  el("deletion-warning").hidden = action !== "remove";
  el("cache-confirm-row").hidden = action !== "remove";
  el("review-panel").hidden = false;
  el("review-panel").scrollIntoView?.({ block: "start" });
  message("Review the plan. Nothing has changed yet.");
  syncConfirm();
}
async function applyReview() {
  try { requireConnectedIdentity(); } catch (failure) { error(failure.message); return; }
  const plan = state.plan;
  if (!plan || !el("confirm").checked || (plan.action === "remove" && !el("cache-confirm").checked)) return;
  const selected = boundary();
  if (selected.containerName !== plan.containerName || selected.networkName !== plan.networkName) { invalidate(); return; }
  await perform("Applying only the confirmed model action…", async () => {
    await verifyConnectedIdentity();
    const result = await api("/api/vps/local-model/apply", { ...selected, planId: plan.planId, action: plan.action, confirmed: true, ...(plan.action === "remove" ? { clearModelCache: el("cache-confirm").checked } : {}) });
    invalidate();
    renderStatus(result);
    message("Action applied. Refresh or reopen the wizard at any time to inspect progress.");
  });
}
function schedulePoll() {
  clearTimeout(state.timer);
  const generation = state.generation;
  const selected = boundary();
  const key = `${selected.containerName}\0${selected.networkName}`;
  state.timer = setTimeout(async () => {
    if (state.busy || !current(key, generation)) return;
    if (!connectedIdentityMatches()) {
      invalidate();
      el("settings-panel").hidden = true;
      error("The trusted VPS identity changed. Disconnect and reconnect before inspecting the model.");
      return;
    }
    try {
      const result = await api("/api/vps/local-model/operation-status", { ...selected, installId: state.status?.installId });
      if (!current(key, generation)) return;
      if (result?.installId !== state.status?.installId || !MODELS.has(result.modelId)) throw new Error("The operation identity changed.");
      if (result.state !== "downloading") {
        await refreshStatus();
        return;
      }
      const progress = result.operation;
      if (!progress || !["downloading", "verifying", "model-ready", "model-error", "partial"].includes(progress.state)) throw new Error("Operation progress is invalid.");
      const wasHidden = el("progress").hidden;
      el("progress").hidden = false;
      el("progress").textContent = `${progress.phase}: ${formatBytes(progress.completedBytes)} of ${formatBytes(progress.totalBytes)} transferred. No ETA is available.`;
      if (wasHidden) el("progress").scrollIntoView?.({ block: "nearest", behavior: "instant" });
      schedulePoll();
    } catch (failure) { error(failure?.message ?? "Progress inspection failed. Refresh status."); }
  }, 2500);
}

el("scan").addEventListener("click", () => {
  for (const id of ["host", "port"]) {
    if (!el(id).checkValidity()) {
      error(id === "host" ? "Hostname is invalid." : "Port is invalid.");
      return;
    }
  }
  void perform("Checking VPS host identity…", async () => {
    if (state.connectedIdentity) throw new Error("Disconnect before scanning another VPS host.");
    requireSupportedHosting();
    invalidate(); state.fingerprint = null; el("trust").checked = false; syncTrust();
    const result = await api("/api/ssh/fingerprint", { host: el("host").value, port: Number(el("port").value) });
    if (typeof result.fingerprint !== "string" || !result.fingerprint) throw new Error("Host fingerprint is unavailable.");
    for (const id of ["host", "port"]) clearFieldError(el(id), "error");
    state.fingerprint = result.fingerprint;
    el("fingerprint").textContent = result.fingerprint;
    el("fingerprint-box").hidden = false;
    message("Check the server identity before you connect.");
  });
});
el("trust").addEventListener("change", () => { invalidate(); syncTrust(); });
for (const id of ["host", "port"]) el(id).addEventListener("input", () => {
  clearFieldError(el(id), "error");
  el("error").hidden = true;
  invalidate();
  el("settings-panel").hidden = true;
  if (!state.connectedIdentity) {
    state.fingerprint = null; el("fingerprint-box").hidden = true; el("trust").checked = false;
  }
  syncTrust();
});
for (const id of ["username", "password"]) el(id).addEventListener("input", () => {
  clearFieldError(el(id), "error");
  el("error").hidden = true;
});
el("ssh-form").addEventListener("invalid", (event) => {
  const label = { host: "Hostname", port: "Port", username: "Username", password: "Password" }[event.target.id];
  if (!label) return;
  event.preventDefault();
  error(`${label} is invalid.`);
}, true);
el("ssh-form").addEventListener("submit", (event) => { event.preventDefault(); if (state.connectedIdentity || !state.fingerprint || !el("trust").checked) return; void perform("Connecting to trusted VPS…", async () => {
  requireSupportedHosting();
  await api("/api/ssh/connect", sshAuthentication.request(state.fingerprint));
  for (const id of ["username", "password"]) clearFieldError(el(id), "error");
  adoptConnectedIdentity(await readSshIdentity(token, { allowModelOnly: true }));
  try {
    await discover();
    message("Connected. Choose n8n and review the measured resources.");
  } catch (failure) {
    if (failure?.code !== "NO_RUNNING_N8N") throw failure;
    el("manual-recovery").hidden = false;
    message("Connected; no running n8n container was found. Inspect an existing owned model for reviewed removal using its original exact names.");
  }
}); });
el("container").addEventListener("change", () => { void perform("Inspecting selected n8n…", loadNetworks); });
el("network").addEventListener("change", () => { void perform("Inspecting selected network…", refreshStatus); });
el("model").addEventListener("change", invalidate);
el("inspect-owned").addEventListener("click", () => { void perform("Inspecting only the specified owned model…", async () => {
  const name = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/u;
  const invalid = ["manual-container", "manual-network"].filter((id) => !name.test(el(id).value));
  if (invalid.length) {
    for (const id of invalid) setFieldError(el(id), "error");
    throw new Error("Enter the exact original Docker container and network names.");
  }
  for (const id of ["manual-container", "manual-network"]) clearFieldError(el(id), "error");
  state.manual = true;
  el("selection-panel").hidden = false;
  await refreshStatus();
}); });
for (const id of ["manual-container", "manual-network"]) el(id).addEventListener("input", () => {
  clearFieldError(el(id), "error");
  el("error").hidden = true;
  invalidate(); el("settings-panel").hidden = true;
  el("review-install").hidden = true; el("review-retry").hidden = true; el("review-remove").hidden = true;
});
el("refresh").addEventListener("click", () => { void perform("Refreshing owned model status…", refreshStatus); });
for (const [id, action] of [["review-install", "install"], ["review-retry", "retry"], ["review-remove", "remove"]]) {
  el(id).addEventListener("click", () => { void perform("Reviewing selected action…", () => review(action)); });
}
el("confirm").addEventListener("change", syncConfirm);
el("cache-confirm").addEventListener("change", syncConfirm);
el("cancel-review").addEventListener("click", invalidate);
el("apply").addEventListener("click", () => { void applyReview(); });
el("disconnect").addEventListener("click", () => { void perform("Disconnecting…", async () => {
  invalidate(); await api("/api/disconnect", {}); el("selection-panel").hidden = true; el("settings-panel").hidden = true; el("manual-recovery").hidden = true;
  state.connectedIdentity = null; state.fingerprint = null; el("trust").checked = false; el("fingerprint-box").hidden = true;
  el("ssh-session").textContent = "No authenticated VPS session."; el("ssh-disconnect").hidden = true;
  state.status = null; message("Disconnected. The owned model remains on your server.");
}); });
async function copyText(text, button) {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const input = document.createElement("textarea");
    input.value = text;
    input.style.position = "fixed";
    input.style.opacity = "0";
    document.body.append(input);
    try {
      input.focus();
      input.select();
      if (!document.execCommand("copy")) throw new Error("Clipboard unavailable.");
    } finally {
      input.remove();
      button.focus();
    }
  }
}
for (const [id, targetId] of [["copy-url", "base-url"], ["copy-model", "selected-model"], ["copy-key", "placeholder-key"]]) {
  el(id).addEventListener("click", async (event) => {
    if (state.busy) return;
    const text = el(targetId).textContent;
    if (!text) return;
    try {
      await copyText(text, event.currentTarget);
      message("Copied to clipboard.");
    } catch {
      error("Clipboard unavailable; select and copy the text manually.");
    }
  });
}
window.addEventListener("pagehide", () => { clearTimeout(state.timer); state.timer = null; });

// One step panel shows at a time (DESIGN.md one-screen rule): the furthest open
// step, or an earlier one the person went back to. Recovery without n8n shows
// the names it checks together with the owned-model status and actions.
const VIEWS = ["review-panel", "settings-panel", "selection-panel", "manual-recovery", "connection-panel"];
const VIEW_STAGES = { "connection-panel": 1, "manual-recovery": 2, "selection-panel": 2, "review-panel": 3, "settings-panel": 4 };
const view = { furthest: "connection-panel", shown: "connection-panel", returnedTo: null };
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
  const furthest = VIEWS.find((id) => !el(id).hidden);
  if (furthest !== view.furthest) { view.furthest = furthest; view.returnedTo = null; }
  const next = view.returnedTo && !el(view.returnedTo).hidden ? view.returnedTo : furthest;
  const shown = next === "selection-panel" && !el("manual-recovery").hidden ? ["manual-recovery", next] : [next];
  // Write only real changes: this runs from a MutationObserver on `hidden`.
  if (el("selection-continue").hidden !== el("settings-panel").hidden) el("selection-continue").hidden = el("settings-panel").hidden;
  if (shown.join() === view.shown) return;
  const active = document.activeElement;
  const leaving = VIEWS.filter((id) => el(id).hasAttribute("data-current")).some((id) => el(id).contains(active));
  for (const id of VIEWS) el(id).toggleAttribute("data-current", shown.includes(id));
  view.shown = shown.join();
  for (const marker of document.querySelectorAll("[data-stage-marker]")) {
    const markerStage = Number(marker.dataset.stageMarker);
    if (markerStage < VIEW_STAGES[next]) marker.dataset.state = "done";
    else delete marker.dataset.state;
    if (markerStage === VIEW_STAGES[next]) marker.setAttribute("aria-current", "step");
    else marker.removeAttribute("aria-current");
  }
  const heading = el(shown[0]).querySelector("h2");
  if (leaving) focusVisible(heading);
  else if (!active || active === document.body) focusVisible(heading);
}
function returnTo(id) {
  syncView();
  view.returnedTo = id;
  syncView();
}
el("cancel-review").addEventListener("click", () => returnTo("selection-panel"));
el("settings-back").addEventListener("click", () => { if (!state.busy) returnTo("selection-panel"); });
el("selection-continue").addEventListener("click", () => { if (!state.busy) returnTo(null); });
new MutationObserver(syncView).observe(el("main-content"), { subtree: true, attributeFilter: ["hidden"] });
initWizardTopbar({
  session: token,
  isBusy: () => state.busy,
  loadProjectMeta: token ? async () => {
    const response = await fetch("/api/local/project-meta", { headers: { "X-Setup-Token": token }, credentials: "omit", mode: "same-origin", redirect: "error", cache: "no-store" });
    if (!response.ok) throw new Error("Relmio project details are unavailable.");
    return response.json();
  } : undefined,
});

if (!token) {
  message("Open this page from a fresh Relmio wizard session.");
} else {
  void perform("Checking the VPS connection…", async () => {
    try {
      adoptConnectedIdentity(await readSshIdentity(token, { allowModelOnly: true }));
      await discover();
      message("Connected. Choose n8n and review the measured resources.");
    } catch (failure) {
      if (failure?.message === "Connect to the VPS first.") {
        message("Check the server identity to begin.");
      } else if (failure?.code === "NO_RUNNING_N8N") {
        el("manual-recovery").hidden = false;
        message("No running n8n container was found. Inspect an existing owned model for reviewed removal using its original exact names.");
      } else {
        el("selection-panel").hidden = true;
        el("settings-panel").hidden = true;
        el("manual-recovery").hidden = true;
        throw failure;
      }
    }
  });
}

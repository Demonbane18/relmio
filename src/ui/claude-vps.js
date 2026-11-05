import { bindSshAuthentication, clearFieldError, createCredentialSshGuard, markRejectedField } from "./ssh-form.js";
import { readWizardSession } from "./session.js";
import { initWizardTopbar } from "./topbar.js";

const token = readWizardSession();
const element = id => document.getElementById(id);
const state = { busy: false, fingerprint: null, status: null, plan: null, action: null, generation: 0 };
const actionLabels = {
  install: "Install Claude companion", replace: "Replace Claude companion and key",
  renew: "Renew Claude approval", "sign-out": "Sign out of Claude", remove: "Remove Claude companion",
};
const approvalActions = ["install", "replace", "renew"];
const reviewFields = ["officialBinaryReviewed", "effectivePolicyReviewed", "nativeAuthAndBillingReviewed", "policyChangesControlled"];
const panels = ["ssh-panel", "selection-panel", "approval-panel", "review-panel", "settings-panel"];
let currentView = "ssh-panel";
let sshIdentityDecision = 0;
const sshSession = createCredentialSshGuard({ token, onIdentityDecision() { sshIdentityDecision++; }, onMismatch() {
  invalidateBoundaryState();
  element("container").replaceChildren();
  element("network").replaceChildren();
  resetHost();
  showView("ssh-panel");
} });

function setMessage(text) { element("status-message").textContent = text; }
function clearError() {
  element("error-message").hidden = true;
  element("error-message").textContent = "";
  globalThis.relmioGuide?.clearError?.();
}
function showError(error) {
  const text = markRejectedField(error?.message ?? "The operation could not be completed.", element, "error-message");
  element("error-message").textContent = text;
  element("error-message").hidden = false;
  element("error-message").focus();
  globalThis.relmioGuide?.error?.(error);
}
function showView(id) {
  const previous = currentView;
  currentView = id;
  for (const panel of panels) {
    element(panel).hidden = panel !== id;
    element(panel).toggleAttribute("data-current", panel === id);
  }
  const stage = { "ssh-panel": 1, "selection-panel": 2, "approval-panel": 3, "review-panel": 3, "settings-panel": 4 }[id];
  document.body.dataset.stage = String(stage);
  for (const marker of document.querySelectorAll("[data-stage-marker]")) {
    const step = Number(marker.dataset.stageMarker);
    if (step < stage) marker.dataset.state = "done";
    else delete marker.dataset.state;
    if (step === stage) marker.setAttribute("aria-current", "step");
    else marker.removeAttribute("aria-current");
  }
  if (previous !== id) {
    const heading = element(id).querySelector("h2");
    heading.focus({ preventScroll: true });
    const rect = heading.getBoundingClientRect();
    if (rect.top < document.querySelector(".rm-topbar").getBoundingClientRect().bottom || rect.bottom > innerHeight) heading.scrollIntoView({ block: "start", behavior: "instant" });
  }
}

for (const name of ["click", "pointerdown", "keydown", "beforeinput", "input", "change", "submit"]) {
  document.addEventListener(name, event => {
    if (!state.busy || event.target?.closest?.(".rm-guide-layer") || (name === "keydown" && event.key === "Tab")) return;
    event.preventDefault();
    event.stopImmediatePropagation();
  }, true);
}

async function perform(label, work) {
  if (state.busy) return;
  state.busy = true;
  clearError();
  setMessage(label);
  document.body.dataset.operationBusy = "true";
  element("route-steps-content").setAttribute("aria-busy", "true");
  const snapshots = [...document.querySelectorAll("button, input, select, textarea, summary, a[href]")]
    .filter(control => !control.closest(".rm-guide-layer"))
    .map(control => ({ control, disabled: typeof control.disabled === "boolean" ? control.disabled : null, tabIndex: control.getAttribute("tabindex") }));
  for (const { control, disabled } of snapshots) {
    if (disabled !== null) control.disabled = true;
    else control.setAttribute("tabindex", "-1");
  }
  element("operation-progress-label").textContent = label;
  element("operation-progress-bar").setAttribute("aria-valuetext", label);
  element("operation-progress").hidden = false;
  const started = Date.now();
  const timer = window.setInterval(() => {
    const seconds = Math.floor((Date.now() - started) / 1000);
    element("operation-progress-elapsed").textContent = `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
    element("operation-progress-elapsed").setAttribute("datetime", `PT${seconds}S`);
  }, 1000);
  try { await work(); }
  catch (error) { showError(error); }
  finally {
    window.clearInterval(timer);
    element("operation-progress").hidden = true;
    element("operation-progress-elapsed").textContent = "00:00";
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

async function api(path, body = {}, method = "POST") {
  if (!token) throw new Error("This private wizard session is missing. Return to Relmio and open a fresh setup link.");
  await sshSession.before(path);
  let response;
  try {
    response = await fetch(path, {
      method, credentials: "omit", mode: "same-origin", redirect: "error", cache: "no-store",
      headers: { "Content-Type": "application/json", "X-Setup-Token": token },
      ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
    });
  } catch { throw new Error("The local wizard server is not reachable. Keep its terminal open, then reopen Relmio."); }
  const result = await response.json().catch(() => null);
  if (!result || typeof result !== "object" || Array.isArray(result)) throw new Error("The wizard returned an unreadable response. Start a fresh setup link.");
  if (!response.ok) throw new Error(result.error || "The operation could not be completed.");
  await sshSession.after(path, result);
  return result;
}

function selectedBoundary() { return { containerName: element("container").value, networkName: element("network").value }; }
function selectedModels() { return [...document.querySelectorAll('[name="claude-model"]:checked')].map(input => input.value); }
function ownerReview() { return Object.fromEntries(reviewFields.map(field => [field, document.querySelector(`[data-review="${field}"]`).checked])); }
function invalidateReview() {
  state.plan = null;
  element("confirm-action").checked = false;
  element("apply-button").disabled = true;
}
function invalidateBoundaryState() {
  state.generation++;
  invalidateReview();
  state.status = null;
  state.action = null;
  element("client-key").value = "";
  element("login-command").textContent = "";
  element("models-result").textContent = "";
  element("login-state").textContent = "Sign-in has not been checked.";
}
function syncConnectionControls() {
  const trusted = Boolean(state.fingerprint && element("trust-host").checked);
  sshAuthentication.sync({ trusted });
  element("connect-button").disabled = !trusted;
  element("apply-button").disabled = !state.plan || !element("confirm-action").checked;
  element("prepare-button").disabled = selectedModels().length === 0 || !Object.values(ownerReview()).every(Boolean);
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
  if (!["absent", "manual", "installed", "invalid"].includes(next.state)) throw new Error("Claude status is unreadable. Refresh status before continuing.");
  state.status = next;
  const installed = next.state === "installed" && next.installation;
  element("installation-state").textContent = {
    absent: "No Claude companion is installed on this VPS.",
    manual: "A manual Claude companion was found. Replacement keeps its Claude login volume and creates a new n8n key.",
    installed: "Claude companion found. Check its approval and sign-in before using it.",
    invalid: "This installation is unrecognized. Relmio will not change it. Inspect it with your server administrator.",
  }[next.state];
  element("login-command").textContent = installed ? next.loginCommand : "";
  if (installed) {
    element("approval-expiry").textContent = `${installed.approvalExpired ? "Approval expired" : "Approval expires"}: ${installed.expiresAt}`;
    if (installed.container !== "running") element("login-state").textContent = `Companion is ${installed.container}. Review replacement before signing in.`;
  } else {
    element("client-key").value = "";
    element("models-result").textContent = "";
  }
  element("selection-continue").hidden = !installed;
  for (const button of document.querySelectorAll("[data-action]")) {
    button.hidden = button.dataset.action === "install" ? next.state !== "absent"
      : button.dataset.action === "replace" ? !["manual", "installed"].includes(next.state) : !installed;
  }
  showView(installed ? "settings-panel" : "selection-panel");
}
async function refreshStatus() {
  invalidateReview();
  const generation = ++state.generation;
  const next = await api("/api/vps/claude/status", {}, "GET");
  if (generation !== state.generation) return;
  renderStatus(next);
  setMessage("VPS status checked. Existing n8n is unchanged.");
}
async function loadNetworks() {
  invalidateBoundaryState();
  const generation = ++state.generation;
  const result = await api("/api/networks", { containerName: element("container").value });
  if (generation !== state.generation) return;
  selectOptions(element("network"), result.networks.map(name => [name, name]));
  await refreshStatus();
}
async function discover() {
  invalidateBoundaryState();
  const generation = ++state.generation;
  const result = await api("/api/discover");
  if (generation !== state.generation) return;
  if (!Array.isArray(result.containers) || result.containers.length === 0) throw new Error("No running n8n container was found on this VPS.");
  selectOptions(element("container"), result.containers.map(item => [item.name, `${item.name} · ${item.image}`]));
  showView("selection-panel");
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

function beginAction(action) {
  invalidateReview();
  state.action = action;
  if (!approvalActions.includes(action)) return perform("Preparing the review…", () => prepareReview(action));
  const candidate = state.status?.candidate;
  if (!candidate) { showError(new Error("Claude's binary pin is unavailable. Refresh status before reviewing.")); return; }
  element("candidate-version").textContent = `${candidate.version} · ${candidate.platform}`;
  element("candidate-sha").textContent = candidate.executableSha256;
  for (const input of document.querySelectorAll("[data-review]")) input.checked = false;
  const models = state.status?.installation?.models;
  if (models) {
    const group = element("model-choices").querySelector(".rm-cluster");
    for (const model of models) {
      if ([...group.querySelectorAll("input")].some(input => input.value === model)) continue;
      const label = document.createElement("label");
      label.className = "rm-check";
      const input = document.createElement("input");
      input.type = "checkbox";
      input.name = "claude-model";
      input.value = model;
      const text = document.createElement("span");
      text.textContent = model;
      label.append(input, text);
      group.append(label);
    }
    for (const input of document.querySelectorAll('[name="claude-model"]')) input.checked = models.includes(input.value);
  }
  element("model-choices").disabled = action === "renew";
  syncConnectionControls();
  showView("approval-panel");
}
async function prepareReview(action) {
  invalidateReview();
  const boundary = selectedBoundary();
  const review = ownerReview();
  const models = selectedModels();
  if (approvalActions.includes(action) && (!models.length || !Object.values(review).every(Boolean))) throw new Error("Choose at least one model and complete all four owner reviews.");
  const result = await api("/api/vps/claude/plan", {
    action,
    ...(["install", "replace"].includes(action) ? { ...boundary, models, review } : action === "renew" ? { review } : {}),
  });
  const plan = result.plan;
  if (!result.planId || plan?.action !== action || plan.installDirectory !== "/docker/n8n-openai-oauth/claude" ||
    plan.endpoint !== "http://relmio-claude:14502/v1" || plan.operationLockPath !== "/docker/n8n-openai-oauth/.claude-operation.lock" ||
    plan.restarts !== 0 || !Array.isArray(plan.existingN8nChanges) || plan.existingN8nChanges.length || !Array.isArray(plan.publishedPorts) || plan.publishedPorts.length) {
    throw new Error("The reviewed Claude safety boundary is invalid. Review a fresh plan.");
  }
  if (JSON.stringify(boundary) !== JSON.stringify(selectedBoundary())) return;
  state.plan = result;
  element("review-summary").textContent = `${actionLabels[action]}. ${action === "remove" ? "This deletes its saved Claude login, files and companion. Other companions and n8n data stay."
    : action === "sign-out" ? "This signs out only this companion's Claude session."
      : plan.keepsClaudeLogin ? "The saved Claude login volume is kept." : "Sign in yourself after installation."}`;
  element("review-boundary").textContent = `${element("container").value} / ${plan.network}`;
  element("review-models").textContent = plan.models.join(", ");
  element("review-version").textContent = `${plan.version} · ${plan.arch}`;
  element("review-sha").textContent = plan.executableSha256;
  element("review-expiry").textContent = plan.expiresAt ?? "Not renewed by this action";
  element("apply-button").textContent = actionLabels[action];
  element("apply-button").classList.toggle("rm-button--danger", action === "remove");
  element("apply-button").classList.toggle("rm-button--primary", action !== "remove");
  showView("review-panel");
  setMessage("Review the exact plan and confirm when ready.");
}

for (const id of ["host", "port"]) element(id).addEventListener("input", () => {
  clearFieldError(element(id), "error-message"); clearError(); resetHost();
});
for (const id of ["username", "password"]) element(id).addEventListener("input", () => {
  clearFieldError(element(id), "error-message"); clearError();
});
element("ssh-form").addEventListener("invalid", event => {
  const label = { host: "Hostname", port: "Port", username: "Username", password: "Password" }[event.target.id];
  if (!label) return;
  event.preventDefault(); showError(new Error(`${label} is invalid.`));
}, true);
element("scan-button").addEventListener("click", () => {
  for (const id of ["host", "port"]) if (!element(id).checkValidity()) {
    showError(new Error(id === "host" ? "Hostname is invalid." : "Port is invalid.")); return;
  }
  void perform("Checking VPS identity…", async () => {
    resetHost();
    const result = await api("/api/ssh/fingerprint", { host: element("host").value, port: element("port").value });
    state.fingerprint = result.fingerprint;
    element("fingerprint").textContent = result.fingerprint;
    element("fingerprint-box").hidden = false;
    setMessage("Compare the fingerprint before authenticating.");
  });
});
element("trust-host").addEventListener("change", () => {
  if (!element("trust-host").checked) element("password").value = "";
  syncConnectionControls();
});
element("ssh-form").addEventListener("submit", event => {
  event.preventDefault();
  if (!state.fingerprint || !element("trust-host").checked) return;
  void perform("Connecting and finding n8n…", async () => {
    await api("/api/ssh/connect", sshAuthentication.request(state.fingerprint));
    await discover();
  });
});
element("container").addEventListener("change", () => void perform("Reading private networks…", loadNetworks));
element("network").addEventListener("change", () => { invalidateBoundaryState(); void perform("Checking companion…", refreshStatus); });
element("refresh-button").addEventListener("click", () => void perform("Checking companion…", refreshStatus));
for (const button of document.querySelectorAll("[data-action]")) button.addEventListener("click", () => { if (!state.busy) void beginAction(button.dataset.action); });
element("approval-panel").addEventListener("change", () => { invalidateReview(); syncConnectionControls(); });
element("prepare-button").addEventListener("click", () => void perform("Preparing the review…", () => prepareReview(state.action)));
element("confirm-action").addEventListener("change", syncConnectionControls);
for (const id of ["cancel-review", "cancel-approval"]) element(id).addEventListener("click", () => {
  if (state.busy) return;
  invalidateReview();
  showView(state.status?.state === "installed" ? "settings-panel" : "selection-panel");
  setMessage("No companion action was applied.");
});
element("apply-button").addEventListener("click", () => {
  if (!state.plan || !element("confirm-action").checked) return;
  void perform("Applying the reviewed companion action…", async () => {
    const reviewed = state.plan;
    invalidateReview();
    const result = await api("/api/vps/claude/apply", { planId: reviewed.planId, confirmed: true });
    if (result.clientKey) {
      element("client-key").value = result.clientKey;
      showView("settings-panel");
    }
    element("login-state").textContent = "Sign-in has not been checked.";
    element("models-result").textContent = "";
    await refreshStatus();
    setMessage("The reviewed Claude action completed. Existing n8n is unchanged.");
  });
});
element("auth-button").addEventListener("click", () => void perform("Checking Claude sign-in…", async () => {
  const result = await api("/api/vps/claude/auth-status");
  const signedIn = result.loggedIn === true && result.authMethod === "claude.ai";
  element("login-state").textContent = signedIn
    ? `Claude plan sign-in confirmed${result.subscriptionType ? ` (${result.subscriptionType})` : ""}. Check models next.`
    : "Claude plan sign-in is not ready. Complete sign-in in your own terminal, then check again.";
  setMessage("Sign-in check finished. Model availability is a separate check.");
}));
element("models-button").addEventListener("click", () => void perform("Checking approved models…", async () => {
  if (!element("client-key").value) throw new Error("Enter your saved n8n API key to check models.");
  const result = await api("/api/vps/claude/models", { clientKey: element("client-key").value });
  if (!Array.isArray(result.models)) throw new Error("The model response is unreadable. Check sign-in and approval before trying again.");
  element("models-result").textContent = `Listed models: ${result.models.join(", ")}. A listed model does not prove a workflow succeeds.`;
  setMessage("Model check finished.");
}));
for (const [id, source, message] of [["copy-key", "client-key", "n8n API key copied. Save it directly in n8n."], ["copy-login", "login-command", "Command copied. Run it in your own terminal."]]) {
  element(id).addEventListener("click", async () => {
    if (state.busy) return;
    const value = source === "client-key" ? element(source).value : element(source).textContent;
    if (!value) return;
    try { await navigator.clipboard.writeText(value); setMessage(message); }
    catch { showError(new Error("Clipboard access was refused. Select and copy the value manually.")); }
  });
}
element("disconnect-button").addEventListener("click", () => void perform("Disconnecting…", async () => {
  await api("/api/disconnect"); resetHost(); showView("ssh-panel");
  setMessage("Disconnected. Your installed companion remains on the VPS.");
}));
window.addEventListener("pagehide", () => { element("client-key").value = ""; });
element("settings-back").addEventListener("click", () => { if (!state.busy) showView("selection-panel"); });
element("selection-continue").addEventListener("click", () => { if (!state.busy && state.status?.state === "installed") showView("settings-panel"); });
initWizardTopbar({ session: token, isBusy: () => state.busy, loadProjectMeta: () => api("/api/local/project-meta", {}, "GET") });
const sshAuthentication = bindSshAuthentication({ token, trustId: "trust-host", onChange: invalidateBoundaryState, shouldApplyConnectionStatus: () => sshIdentityDecision === 0 });
if (!token) setMessage("Open this page from the Relmio wizard to establish a private session.");
else void perform("Checking the VPS connection…", async () => {
  try { await sshSession.adoptCurrent(); await discover(); }
  catch (error) {
    if (error.message !== "Connect to the VPS first.") throw error;
    showView("ssh-panel"); setMessage("Connect to your VPS to begin. Claude sign-in happens later in your own terminal.");
  }
});

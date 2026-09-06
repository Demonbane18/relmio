import { bindWizardNavigation, readWizardSession } from "./session.js";

const token = readWizardSession();
const el = id => document.getElementById(id);
bindWizardNavigation(el("back-link"), "/", token);
const labels = { install: "Install a fresh private SuperGrok companion", "sign-in": "Start a fresh official Grok device sign-in", "sign-out": "Sign out only this companion's Grok session", remove: "Remove this companion and its Grok session volume", "cancel-sign-in": "Cancel this companion's pending device sign-in" };
let fingerprint = null;
let plan = null;
let status = null;
let busy = false;
let generation = 0;
let pollTimer;
el("back-link").addEventListener("click", event => { if (busy) { event.preventDefault(); event.stopImmediatePropagation(); } }, true);

async function api(path, body = {}) {
  const response = await fetch(path, { method: "POST", headers: { "Content-Type": "application/json", "X-Setup-Token": token }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || "The operation could not be completed.");
  return result;
}
function message(text) { el("status-message").textContent = text; }
function invalidate() { plan = null; el("confirm-action").checked = false; el("apply-button").disabled = true; el("review-panel").hidden = true; }
function selection() { return { containerName: el("container").value, networkName: el("network").value }; }
async function perform(label, work) {
  if (busy) return;
  busy = true;
  el("error-message").hidden = true;
  message(label);
  document.body.setAttribute("aria-busy", "true");
  const controls = [...document.querySelectorAll("button,input,select")].map(node => [node, node.disabled]);
  for (const [node] of controls) node.disabled = true;
  try { await work(); }
  catch (error) { el("error-message").textContent = error.message || "The operation failed."; el("error-message").hidden = false; el("error-message").focus(); }
  finally {
    for (const [node, disabled] of controls) node.disabled = disabled;
    busy = false;
    document.body.removeAttribute("aria-busy");
    el("password").disabled = !fingerprint || !el("trust-host").checked;
    el("connect-button").disabled = el("password").disabled;
    el("apply-button").disabled = !plan || !el("confirm-action").checked;
  }
}
function options(node, values) {
  node.replaceChildren(...values.map(([value, label]) => { const option = document.createElement("option"); option.value = value; option.textContent = label; return option; }));
}
async function refresh() {
  invalidate();
  if (!el("network").value) return;
  const next = await api("/api/vps/supergrok/status", selection());
  if (status?.installId !== next.installId) el("client-key").value = "";
  status = next;
  el("installation-state").textContent = next.state === "absent" ? "No managed SuperGrok companion is installed for this VPS." : next.state === "healthy" ? "The private companion is healthy. Sign in, then check your account models." : "An incomplete companion was detected. Review its removal before installing again.";
  el("settings-panel").hidden = next.state !== "healthy";
  for (const button of document.querySelectorAll("[data-action]")) {
    const action = button.dataset.action;
    button.hidden = next.credentialActionRunning ? action !== "cancel-sign-in" : action === "cancel-sign-in" || (action === "install" ? next.state !== "absent" : action === "remove" ? next.state === "absent" : next.state !== "healthy");
  }
  message("VPS status checked. Existing n8n is unchanged.");
}
async function networks() {
  invalidate(); status = null; el("client-key").value = "";
  const result = await api("/api/networks", { containerName: el("container").value });
  options(el("network"), result.networks.map(name => [name, name]));
  await refresh();
}
async function discover() {
  const result = await api("/api/discover");
  if (!result.containers.length) throw new Error("No running n8n container was found on this VPS.");
  options(el("container"), result.containers.map(item => [item.name, `${item.name} — ${item.image}`]));
  el("ssh-panel").hidden = true;
  el("selection-panel").hidden = false;
  await networks();
}
function resetHost() {
  fingerprint = null; invalidate();
  el("trust-host").checked = false; el("fingerprint-box").hidden = true;
  el("password").value = ""; el("password").disabled = true; el("connect-button").disabled = true;
}
for (const id of ["host", "port"]) el(id).addEventListener("input", resetHost);
el("scan-button").addEventListener("click", () => perform("Checking VPS identity…", async () => {
  resetHost();
  const result = await api("/api/ssh/fingerprint", { host: el("host").value, port: el("port").value });
  fingerprint = result.fingerprint; el("fingerprint").textContent = fingerprint; el("fingerprint-box").hidden = false;
  message("Compare the fingerprint before entering your password.");
}));
el("trust-host").addEventListener("change", () => { el("password").disabled = !el("trust-host").checked; el("connect-button").disabled = el("password").disabled; if (el("password").disabled) el("password").value = ""; });
el("ssh-form").addEventListener("submit", event => {
  event.preventDefault();
  if (!fingerprint || !el("trust-host").checked) return;
  void perform("Connecting and finding n8n…", async () => {
    const password = el("password").value;
    el("password").value = "";
    await api("/api/ssh/connect", { host: el("host").value, port: el("port").value, username: "root", password, expectedFingerprint: fingerprint });
    await discover();
  });
});
el("container").addEventListener("change", () => perform("Reading networks…", networks));
el("network").addEventListener("change", () => perform("Checking companion…", refresh));
el("refresh-button").addEventListener("click", () => perform("Checking companion…", refresh));
for (const button of document.querySelectorAll("[data-action]")) button.addEventListener("click", () => perform("Preparing the review…", async () => {
  invalidate();
  plan = await api("/api/vps/supergrok/plan", { ...selection(), action: button.dataset.action });
  el("review-summary").textContent = `${labels[plan.action]}. ${plan.action === "remove" ? "Its saved OAuth session will be deleted; other companions and n8n data will remain." : "No existing provider credentials will be copied."}`;
  el("review-container").textContent = plan.containerName; el("review-network").textContent = plan.networkName;
  el("review-panel").hidden = false; el("review-title").scrollIntoView({ block: "center" });
  el("apply-button").textContent = labels[plan.action]; message("Review the action and confirm when ready.");
}));
el("confirm-action").addEventListener("change", () => { el("apply-button").disabled = !plan || !el("confirm-action").checked; });
el("cancel-review").addEventListener("click", invalidate);
async function pollLogin(installId, currentGeneration) {
  if (currentGeneration !== generation) return;
  try {
    const result = await api("/api/vps/supergrok/login-status", { installId });
    if (currentGeneration !== generation) return;
    el("login-panel").hidden = false;
    el("login-state").textContent = result.state === "pending" ? "Complete the sign-in in the official Grok page." : result.state === "complete" ? "The official Grok action completed. Check models to verify your account connection." : "The official action did not complete. Refresh status and start a new sign-in.";
    el("device-code").textContent = result.userCode || "";
    el("device-link").hidden = !result.verificationUrl;
    if (result.verificationUrl) el("device-link").href = result.verificationUrl;
    if (result.state === "pending") pollTimer = setTimeout(() => pollLogin(installId, currentGeneration), 2000);
    else await perform("Refreshing account state…", refresh);
  } catch { message("The sign-in status could not be refreshed. Reconnect if the SSH session expired."); }
}
el("apply-button").addEventListener("click", () => {
  if (!plan || !el("confirm-action").checked) return;
  void perform("Applying the reviewed companion action. Initial builds can take several minutes…", async () => {
    const reviewed = plan;
    invalidate();
    const result = await api("/api/vps/supergrok/apply", { ...reviewed, confirmed: true });
    await refresh();
    if (result.clientKey) el("client-key").value = result.clientKey;
    if (result.state === "pending") { clearTimeout(pollTimer); const currentGeneration = ++generation; pollTimer = setTimeout(() => pollLogin(result.installId, currentGeneration), 1500); }
    if (result.state === "cancelled") { generation++; clearTimeout(pollTimer); el("login-panel").hidden = true; }
    if (result.removed) { generation++; clearTimeout(pollTimer); el("login-panel").hidden = true; el("client-key").value = ""; }
    message(result.removed ? "The SuperGrok companion was removed. Existing n8n is unchanged." : "The companion action completed. Existing n8n is unchanged.");
  });
});
el("models-button").addEventListener("click", () => perform("Checking your account models…", async () => {
  const result = await api("/api/vps/supergrok/models", { installId: status?.installId, clientKey: el("client-key").value });
  el("models-result").textContent = result.status === 200 ? `Available models: ${result.models.join(", ")}` : result.code === "login_required" ? "Sign-in is required. Start an official Grok device sign-in for this companion." : "Account model discovery failed. Try again after checking your Grok account.";
  message("Model check finished.");
}));
el("copy-key").addEventListener("click", async () => {
  if (busy || !el("client-key").value) return;
  try { await navigator.clipboard.writeText(el("client-key").value); message("Local bearer copied. Paste it directly into the n8n credential."); }
  catch { message("Clipboard access was refused by the browser."); }
});
el("disconnect-button").addEventListener("click", () => perform("Disconnecting…", async () => {
  await api("/api/disconnect"); generation++; clearTimeout(pollTimer); invalidate(); status = null; el("client-key").value = "";
  el("ssh-panel").hidden = false; el("selection-panel").hidden = true; el("settings-panel").hidden = true; el("login-panel").hidden = true; resetHost(); message("Disconnected. Your installed companion remains on the VPS.");
}));
if (!token) { message("Open this page from the Relmio wizard to establish a private session."); }
else {
  // A link from the n8n management screen keeps its existing verified SSH session.
  void perform("Checking the VPS connection…", async () => {
    try { await discover(); } catch (error) {
      if (error.message !== "Connect to the VPS first.") throw error;
      el("ssh-panel").hidden = false; message("Connect to your VPS to begin. No ChatGPT sign-in is required.");
    }
  });
}

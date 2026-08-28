const token = new URLSearchParams(window.location.search).get("session");
window.history.replaceState(null, "", window.location.pathname);

const state = {
  fingerprint: null,
  network: null,
  reviewedIncludeSearxng: null,
  installAttempted: false,
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

function setBusy(button, busy, busyText) {
  if (!button.dataset.label) button.dataset.label = button.textContent;
  button.disabled = busy;
  button.setAttribute("aria-busy", String(busy));
  button.textContent = busy ? busyText : button.dataset.label;
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
      return "AI Assistant prerequisite enabled — N8N_ENABLED_MODULES includes instance-ai. Fresh rediscovery is required after n8n changes.";
    case "configured":
      return "AI Assistant prerequisite not met — N8N_ENABLED_MODULES is set but does not include instance-ai. Append instance-ai as a distinct comma-delimited token while preserving existing module entries, then redeploy or restart n8n outside this wizard.";
    case "missing":
      return "AI Assistant prerequisite not met — add N8N_ENABLED_MODULES=instance-ai to the existing n8n service, then redeploy or restart n8n outside this wizard.";
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

async function loadNetworks() {
  const containerName = element("container-select").value;
  const result = await api("/api/networks", {
    method: "POST",
    body: { containerName },
  });
  state.network = result;
  const instanceAiStatus = element("instance-ai-status");
  instanceAiStatus.textContent = formatInstanceAiStatus(result.instanceAi);
  instanceAiStatus.dataset.status = result.instanceAi?.status ?? "unknown";
  const prerequisiteReady = result.instanceAi?.status === "enabled";
  element("review-button").disabled = !prerequisiteReady;
  element("review-readiness").textContent = prerequisiteReady
    ? "Prerequisite verified. Review the exact companion and SearXNG selection before any write."
    : "Enable instance-ai, restart or redeploy n8n, then reconnect to Relmio before reviewing a plan.";
  fillSelect(
    element("network-select"),
    result.networks.map((network) => ({ value: network, label: network })),
    result.recommended,
  );
}

async function discover() {
  const result = await api("/api/discover", { method: "POST", body: {} });
  if (!Array.isArray(result.containers) || result.containers.length === 0) {
    throw new Error("No running official n8n container was found.");
  }
  element("docker-version").textContent = result.dockerVersion;
  element("compose-version").textContent = result.composeVersion;
  fillSelect(
    element("container-select"),
    result.containers.map((container) => ({
      value: container.name,
      label: `${container.name} - ${container.image}`,
    })),
    result.containers[0].name,
  );
  await loadNetworks();
  showStep(2);
  setMessage("n8n was found. Choose an existing Docker network.");
}

element("fingerprint-button").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  clearError();
  setBusy(button, true, "Checking identity…");
  try {
    const result = await api("/api/ssh/fingerprint", {
      method: "POST",
      body: { host: element("host").value, port: element("port").value },
    });
    state.fingerprint = result.fingerprint;
    element("fingerprint-value").textContent = result.fingerprint;
    element("fingerprint-box").hidden = false;
    setMessage("Confirm the VPS identity before supplying its password.");
  } catch (error) {
    showError(error);
  } finally {
    setBusy(button, false);
  }
});

element("fingerprint-confirm").addEventListener("change", (event) => {
  element("password").disabled = !event.currentTarget.checked;
  if (!event.currentTarget.checked) element("password").value = "";
  updateConnectState();
});

element("privileged-confirm").addEventListener("change", updateConnectState);
element("host").addEventListener("input", resetFingerprint);
element("port").addEventListener("input", resetFingerprint);

element("vps-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = element("connect-button");
  clearError();
  setBusy(button, true, "Connecting safely…");
  try {
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
    element("password").value = "";
    await discover();
  } catch (error) {
    element("password").value = "";
    showError(error);
  } finally {
    setBusy(button, false);
  }
});

element("container-select").addEventListener("change", () => {
  loadNetworks().catch(showError);
});

element("review-button").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  clearError();
  setBusy(button, true, "Preparing plan…");
  try {
    const networkName = element("network-select").value;
    const includeSearxng = element("include-searxng").checked;
    const plan = await api("/api/assistant/plan", {
      method: "POST",
      body: {
        containerName: element("container-select").value,
        networkName,
        includeSearxng,
      },
    });
    state.reviewedIncludeSearxng = plan.includeSearxng;
    element("review-network").textContent = networkName;
    element("review-instance-ai").textContent = formatInstanceAiStatus(plan.instanceAi);
    element("review-web-search").textContent = plan.includeSearxng
      ? `Attach optional SearXNG web search to ${networkName} with its private alias`
      : "Web search disabled — no SearXNG service, settings file, or URL will be installed";
    element("install-confirm").checked = false;
    element("install-button").disabled = true;
    showStep(3);
    setMessage("Review the privileged companion plan. The VPS has not changed.");
  } catch (error) {
    showError(error);
  } finally {
    setBusy(button, false);
  }
});

element("install-confirm").addEventListener("change", (event) => {
  element("install-button").disabled = !event.currentTarget.checked;
});

element("include-searxng").addEventListener("change", () => {
  state.reviewedIncludeSearxng = null;
});

element("install-button").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  clearError();
  setBusy(button, true, "Starting companion…");
  state.installAttempted = true;
  try {
    const result = await api("/api/assistant/install", {
      method: "POST",
      body: {
        containerName: element("container-select").value,
        networkName: element("network-select").value,
        includeSearxng: state.reviewedIncludeSearxng,
        confirmed: element("install-confirm").checked,
      },
    });
    element("sandbox-url").textContent = result.sandboxUrl;
    element("sandbox-api-key").textContent = typeof result.sandboxApiKey === "string"
      ? result.sandboxApiKey
      : "Unchanged on this managed update; the key is not redisplayed.";
    if (result.includeSearxng === true && typeof result.searxngUrl === "string") {
      element("searxng-url").textContent = result.searxngUrl;
      element("searxng-note").textContent = "SearXNG uses its private server secret internally. There is no user-facing SearXNG key.";
    } else {
      element("searxng-url").textContent = "Web search disabled";
      element("searxng-note").textContent = "Web search was disabled, so no SearXNG service or settings file was installed. Its retained private secret is never user-facing.";
    }
    showStep(4);
    setMessage("Companion verified. Enter the values directly in n8n’s AI Assistant settings.");
  } catch (error) {
    showError(error);
  } finally {
    setBusy(button, false);
  }
});

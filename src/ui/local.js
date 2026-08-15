const token = new URLSearchParams(window.location.search).get("session");
window.history.replaceState(null, "", window.location.pathname);

const element = (id) => document.getElementById(id);

const state = {
  step: 1,
  target: "openai-api",
  dockerAvailable: false,
  planId: null,
  plan: null,
  installedTarget: null,
};

const messageBox = element("global-message");
const messageText = element("global-message-text");
const errorBox = element("global-error");
const errorText = element("global-error-text");

function createWizardUrl(path) {
  return token ? `${path}?session=${encodeURIComponent(token)}` : path;
}

element("back-to-vps").href = createWizardUrl("/");
element("return-to-vps").href = createWizardUrl("/");

function setMessage(text) {
  messageText.textContent = text;
  messageBox.hidden = false;
}

function clearError() {
  errorText.textContent = "";
  errorBox.hidden = true;
}

function showError(error) {
  errorText.textContent = error?.message ?? "Something went wrong.";
  errorBox.hidden = false;
  errorBox.focus();
}

function setBusy(button, busy, busyText) {
  if (!button.dataset.label) {
    button.dataset.label = button.textContent.trim();
  }
  button.disabled = busy;
  button.setAttribute("aria-busy", String(busy));
  button.textContent = busy ? busyText : button.dataset.label;
}

function setButtonLabel(button, label) {
  button.textContent = label;
  button.dataset.label = label;
}

function showStep(step) {
  state.step = step;
  document.body.dataset.currentStep = String(step);

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
      "This wizard link is incomplete. Close this tab and open the full URL printed by the active Relmio terminal.",
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
      "The local Relmio wizard is not reachable. Keep its terminal open and try again.",
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
    throw new Error(result.error ?? "The local request failed.");
  }
  return result;
}

function selectedTarget() {
  return document.querySelector('input[name="target"]:checked')?.value;
}

function readAllowedOrigins() {
  return element("allowed-origins")
    .value.split(/\r?\n/u)
    .map((value) => value.trim())
    .filter((value) => value !== "");
}

function isCodexChat(target) {
  return target === "codex-chat";
}

function isOpenAiApi(target) {
  return target === "openai-api";
}

function invalidatePlan() {
  state.planId = null;
  state.plan = null;
  element("install-confirm").checked = false;
  element("install-settings-button").disabled = true;
}

function renderTarget() {
  state.target = selectedTarget();
  invalidatePlan();

  const openAiApi = isOpenAiApi(state.target);
  const codexChat = isCodexChat(state.target);
  element("local-port").value = openAiApi
    ? "12435"
    : codexChat
      ? "14501"
      : "14500";
  element("origins-field").hidden = !openAiApi;
  element("target-guidance-title").textContent = openAiApi
    ? "Uses an OpenAI Platform API key"
    : codexChat
      ? "Uses official Codex ChatGPT sign-in through the experimental Relmio-specific Chat Adapter"
      : "Uses the official Codex ChatGPT sign-in";
  element("target-guidance-detail").textContent = openAiApi
    ? "Your Platform key is seeded over stdin into a private Docker volume and is never returned to the browser. A separate local client credential is generated for your apps."
    : codexChat
      ? "This exposes Relmio-specific HTTP POST /chat for a trusted local backend or development server. It is not OpenAI /v1, has no CORS, and browser bundles must never connect directly."
      : "This runs Codex App Server as its own experimental protocol. It does not translate the ChatGPT session into a generic OpenAI /v1 API and it does not accept direct browser connections.";
}

function appendPolicyNotice(container, heading, detail) {
  const strong = document.createElement("strong");
  const paragraph = document.createElement("p");
  strong.textContent = heading;
  paragraph.textContent = detail;
  container.replaceChildren(strong, paragraph);
}

function renderPlan(plan) {
  const openAiApi = isOpenAiApi(plan.target);
  const codexChat = isCodexChat(plan.target);
  element("review-endpoint").textContent = plan.endpoint;
  element("review-protocol").textContent = openAiApi
    ? "OpenAI-compatible HTTP /v1"
    : codexChat
      ? "Relmio Codex Chat HTTP: POST /chat"
      : "Codex App Server JSON-RPC over WebSocket";
  element("review-auth").textContent = openAiApi
    ? "OpenAI Platform API key"
    : "ChatGPT sign-in through official Codex";
  element("review-browser").textContent = openAiApi
    ? plan.allowedOrigins.length > 0
      ? `Only ${plan.allowedOrigins.length} exact allowed origin(s)`
      : "Native clients only until exact origins are added"
    : codexChat
      ? "No — trusted local backends and development servers only"
      : "No — trusted native local clients only";
  element("review-origins-row").hidden = !openAiApi;
  element("review-origins").textContent = openAiApi
    ? plan.allowedOrigins.length > 0
      ? plan.allowedOrigins.join(", ")
      : "None"
    : "";
  element("review-path").textContent = plan.managedPath;

  if (openAiApi) {
    appendPolicyNotice(
      element("review-policy"),
      "OpenAI Platform terms and billing apply",
      "This option sends requests to the OpenAI API with your developer Platform key. ChatGPT subscriptions and open-source program benefits do not turn a ChatGPT credential into an API key.",
    );
  } else if (codexChat) {
    appendPolicyNotice(
      element("review-policy"),
      "Experimental Codex Chat Adapter — trusted local backends or development servers only",
      "This option runs a small authenticated Relmio HTTP adapter on loopback. It accepts only POST /chat from a trusted local backend or development server. It has no CORS and is not OpenAI /v1. ChatGPT credentials stay in the isolated Codex Docker volume and never become Platform API keys.",
    );
  } else {
    appendPolicyNotice(
      element("review-policy"),
      "Experimental, high-trust Codex integration",
      "This option exposes the official Codex App Server only on loopback. Its client capability controls Codex inside the isolated container, may act through the ChatGPT session you sign in with, and may recover that container's ChatGPT session credential. Treat it like your ChatGPT password. It is not a browser or OpenAI /v1 API.",
    );
  }
}

function prepareInstallPanel() {
  const openAiApi = isOpenAiApi(state.plan.target);
  const codexChat = isCodexChat(state.plan.target);
  const apiKey = element("platform-api-key");
  element("api-key-field").hidden = !openAiApi;
  element("codex-install-warning").hidden = openAiApi;
  element("codex-install-warning-title").textContent = codexChat
    ? "Credential for trusted local backends or development servers only"
    : "High-trust capability";
  element("codex-install-warning-detail").textContent = codexChat
    ? "The generated bearer authorizes chat turns through your signed-in Codex container. Keep it only in a trusted local backend or development server; never put it in browser code."
    : "Anyone holding the generated client credential can control Codex inside its isolated container, act through your signed-in ChatGPT session, and may be able to recover that container's ChatGPT session credential. Treat this capability like your ChatGPT password and give it only to a trusted native local app.";
  apiKey.required = openAiApi;
  apiKey.value = "";
  element("install-intro").textContent = openAiApi
    ? "Enter the OpenAI Platform API key this endpoint will use upstream. It is sent only to this local Relmio process."
    : codexChat
      ? "Relmio will install the experimental Codex Chat Adapter and official Codex App Server first. You will complete ChatGPT device sign-in after the container is ready."
      : "Relmio will install the official Codex App Server first. You will complete ChatGPT device sign-in after the container is ready.";
  setButtonLabel(
    element("install-button"),
    openAiApi
      ? "Install OpenAI API endpoint"
      : codexChat
        ? "Install Codex Chat Adapter"
        : "Install Codex App Server",
  );
}

function renderInstallResult(result) {
  if (
    typeof result.endpoint !== "string" ||
    typeof result.clientCredential !== "string" ||
    !["openai-api", "codex-chatgpt", "codex-chat"].includes(result.target)
  ) {
    throw new Error("The local installer returned an unexpected response.");
  }

  const openAiApi = isOpenAiApi(result.target);
  const codexChat = isCodexChat(result.target);
  state.installedTarget = result.target;
  element("result-endpoint").textContent = result.endpoint;
  element("result-credential").textContent = result.clientCredential;
  element("codex-production-warning").hidden = openAiApi;
  element("codex-login").hidden = openAiApi;
  element("codex-production-warning-title").textContent = codexChat
    ? "Experimental Chat Adapter — trusted local backends or development servers only"
    : "Experimental WebSocket transport";
  element("codex-production-warning-detail").textContent = codexChat
    ? "The adapter is for trusted local backends or development servers only. It has a Relmio-specific POST /chat contract, no CORS, and is not OpenAI /v1."
    : "Codex App Server WebSocket is experimental and unsupported for production workloads.";
  element("done-title").textContent = openAiApi
    ? "OpenAI API endpoint is ready"
    : codexChat
      ? "Codex Chat Adapter is installed"
      : "Codex App Server is installed";
  element("done-detail").textContent = openAiApi
    ? "Copy the endpoint and generated bearer credential into your local app."
    : codexChat
      ? "Copy the endpoint and generated bearer credential into your trusted local backend or development server, then sign the isolated Codex container in to ChatGPT."
      : "Copy the endpoint and capability, then sign the isolated Codex container in to ChatGPT.";
  appendPolicyNotice(
    element("client-warning"),
    openAiApi
      ? "For local OpenAI-compatible clients"
      : codexChat
        ? "For trusted local backends or development servers only"
        : "For trusted native Codex clients only",
    openAiApi
      ? "Use the generated client credential as the bearer API key. Your upstream Platform key remains private in the managed Docker volume."
      : codexChat
        ? "Use this one-time credential only as a Bearer token for the Relmio-specific POST /chat endpoint. It is not an OpenAI API key, has no browser CORS support, and must remain in a trusted local backend or development server."
        : "This capability is not an OpenAI API key. Treat it like your ChatGPT password: the client is trusted to control the isolated container and may recover its ChatGPT session credential. It must speak official Codex App Server JSON-RPC over WebSocket.",
  );
}

function validateVerificationUrl(value) {
  if (typeof value !== "string" || value.length > 2048) {
    throw new Error("Relmio refused an unexpected sign-in destination.");
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("Relmio refused an unexpected sign-in destination.");
  }

  if (
    url.origin !== "https://auth.openai.com" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== ""
  ) {
    throw new Error("Relmio refused an unexpected sign-in destination.");
  }
  return url.toString();
}

function validateDeviceCode(value) {
  if (
    typeof value !== "string" ||
    value.length < 4 ||
    value.length > 32 ||
    !/^[A-Z0-9]+(?:-[A-Z0-9]+)*$/u.test(value)
  ) {
    throw new Error("Codex returned an unexpected device code.");
  }
  return value;
}

const delay = (milliseconds) =>
  new Promise((resolve) => window.setTimeout(resolve, milliseconds));

async function waitForCodexLogin() {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const result = await api("/api/local/codex/login/status");
    if (result.status === "success") {
      return;
    }
    if (result.status === "error") {
      throw new Error(result.error ?? "ChatGPT sign-in did not finish.");
    }
    await delay(1_000);
  }
  throw new Error("ChatGPT device sign-in expired. Start it again.");
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
      // A generic message below avoids repeating sensitive copied values.
    }
  }
  throw new Error("The browser refused clipboard access.");
}

function flashCopied(button) {
  const originalLabel = button.textContent;
  button.textContent = "Copied";
  button.classList.add("copied");
  window.setTimeout(() => {
    button.textContent = originalLabel;
    button.classList.remove("copied");
  }, 1_800);
}

element("target-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const button = element("review-button");
  clearError();
  invalidatePlan();
  setBusy(button, true, "Preparing plan…");
  try {
    const result = await api("/api/local/plan", {
      method: "POST",
      body: {
        target: state.target,
        port: element("local-port").value,
        allowedOrigins:
          state.target === "openai-api" ? readAllowedOrigins() : [],
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
    setMessage("Review the exact loopback plan. Nothing has been written yet.");
  } catch (error) {
    showError(error);
  } finally {
    setBusy(button, false);
  }
});

for (const input of document.querySelectorAll('input[name="target"]')) {
  input.addEventListener("change", renderTarget);
}

element("local-port").addEventListener("input", invalidatePlan);
element("allowed-origins").addEventListener("input", invalidatePlan);

element("install-confirm").addEventListener("change", (event) => {
  element("install-settings-button").disabled = !event.currentTarget.checked;
});

element("install-settings-button").addEventListener("click", () => {
  clearError();
  if (!state.planId || !state.plan || !element("install-confirm").checked) {
    showError(new Error("Review and confirm the local plan first."));
    return;
  }
  prepareInstallPanel();
  showStep(3);
  setMessage("The plan is confirmed. Installation has not started yet.");
});

element("install-button").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  const apiKeyInput = element("platform-api-key");
  clearError();
  if (!state.planId || !state.plan || !element("install-confirm").checked) {
    showStep(1);
    showError(new Error("Review and confirm a fresh local plan first."));
    return;
  }
  if (state.plan.target === "openai-api" && !apiKeyInput.reportValidity()) {
    return;
  }
  const requestBody = {
    planId: state.planId,
    confirmed: element("install-confirm").checked,
    ...(state.plan.target === "openai-api"
      ? { apiKey: apiKeyInput.value }
      : {}),
  };
  apiKeyInput.value = "";
  setBusy(button, true, "Installing locally…");
  setMessage("Building and verifying the loopback-only Docker container…");
  try {
    const result = await api("/api/local/install", {
      method: "POST",
      body: requestBody,
    });
    renderInstallResult(result);
    state.planId = null;
    showStep(4);
    setMessage(
      result.target === "openai-api"
        ? "Local OpenAI API endpoint verified. Copy its one-time client credential now."
        : result.target === "codex-chat"
          ? "Codex Chat Adapter for trusted local backends or development servers verified. Copy its one-time bearer and complete ChatGPT sign-in."
          : "Codex App Server verified. Copy its one-time capability and complete ChatGPT sign-in.",
    );
  } catch (error) {
    invalidatePlan();
    showStep(1);
    setMessage("Installation stopped. Prepare and confirm a fresh plan before retrying.");
    showError(error);
  } finally {
    requestBody.apiKey = undefined;
    apiKeyInput.value = "";
    setBusy(button, false);
  }
});

element("rotate-credential-button").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  clearError();
  if (!state.installedTarget) {
    showError(new Error("Install a local endpoint before rotating its credential."));
    return;
  }

  setBusy(button, true, "Rotating credential…");
  setMessage(
    "Generating a replacement credential before activating it…",
  );
  try {
    const staged = await api("/api/local/client-credential/rotate", {
      method: "POST",
      body: { target: state.installedTarget },
    });
    renderInstallResult(staged);
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
    renderInstallResult({ ...staged, ...activated });
    setMessage("Client credential rotated. Copy the new one now; the previous one no longer works.");
  } catch (error) {
    setMessage("The replacement credential was not confirmed active. Follow the error guidance before retrying.");
    showError(error);
  } finally {
    setBusy(button, false);
  }
});

element("codex-login-button").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  const resultBox = element("device-code-result");
  const status = element("device-code-status");
  clearError();
  resultBox.hidden = true;
  setBusy(button, true, "Waiting for ChatGPT…");
  try {
    const result = await api("/api/local/codex/login", {
      method: "POST",
      body: { target: state.installedTarget },
    });
    const verificationUrl = validateVerificationUrl(result.verificationUrl);
    const userCode = validateDeviceCode(result.userCode);
    element("device-code").textContent = userCode;
    element("device-code-link").href = verificationUrl;
    status.textContent = "Waiting for sign-in in the isolated Codex container…";
    resultBox.hidden = false;
    setMessage("Open the official OpenAI page and enter the displayed device code.");
    await waitForCodexLogin();
    status.textContent = isCodexChat(state.installedTarget)
      ? "ChatGPT sign-in completed. Codex Chat Adapter is ready for your trusted local backend or development server."
      : "ChatGPT sign-in completed. Codex is ready for your trusted native client.";
    setMessage("Codex ChatGPT sign-in completed successfully.");
  } catch (error) {
    status.textContent = "ChatGPT sign-in did not complete.";
    showError(error);
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
      await copyText(value);
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
    clearError();
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
    indicator.classList.remove("ready");
    element("docker-status-title").textContent = "Sanitized preview mode";
    element("docker-status-detail").textContent =
      "Local Docker discovery and installation are disabled in this preview.";
    reviewButton.disabled = true;
    setMessage("Preview mode shows the flow without accessing local Docker or credentials.");
    return;
  }
  if (result.unsupportedPlatform === true) {
    indicator.classList.remove("ready");
    element("docker-status-title").textContent =
      "Native Windows is not supported";
    element("docker-status-detail").textContent =
      "Run Relmio on macOS, Linux, or under WSL2 so credentials retain POSIX owner-only file permissions.";
    reviewButton.disabled = true;
    setMessage("This local Docker feature requires a supported POSIX environment.");
    return;
  }
  if (state.dockerAvailable) {
    indicator.classList.add("ready");
    element("docker-status-title").textContent = "Docker is ready";
    element("docker-status-detail").textContent =
      `Engine ${result.dockerVersion}; Compose ${result.composeVersion}`;
    reviewButton.disabled = false;
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

async function refreshProjectMeta() {
  const result = await api("/api/local/project-meta");
  const stars = Number.isSafeInteger(result.stars) && result.stars >= 0
    ? new Intl.NumberFormat("en", {
        notation: result.stars >= 1_000 ? "compact" : "standard",
        maximumFractionDigits: 1,
      }).format(result.stars)
    : "?";
  element("local-repository-stars").textContent = stars;
  element("local-repository-button").setAttribute(
    "aria-label",
    `Open Relmio version ${result.version} on GitHub. ${
      stars === "?" ? "GitHub star count is unavailable." : `${result.stars} GitHub stars.`
    } Opens in a new tab.`,
  );
}

renderTarget();
refreshDockerStatus().catch(showError);
refreshProjectMeta().catch(() => {});

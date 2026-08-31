import { formatAuthUpdatedAt } from "./time.js";
import { prepareOAuthPopup } from "./oauth-popup.js";

const token = new URLSearchParams(window.location.search).get("session");
window.history.replaceState(null, "", window.location.pathname);

const state = {
  step: 1,
  fingerprint: null,
  discovery: null,
  networks: null,
  installAttempted: false,
  oauthAttemptId: null,
  oauthRetryBlocked: false,
  oauthLoginGeneration: 0,
  oauthLoginWindow: null,
};

const element = (id) => document.getElementById(id);
const localEndpointLink = element("local-endpoint-link");
if (token) {
  localEndpointLink.href = `/local?session=${encodeURIComponent(token)}`;
}
const messageToast = element("global-message");
const message = element("global-message-text");
const errorBox = element("global-error");
const errorMessage = element("global-error-text");
const toastTimers = new WeakMap();

function dismissToast(toast) {
  window.clearTimeout(toastTimers.get(toast));
  toast.hidden = true;
}

function resetFingerprint() {
  state.fingerprint = null;
  element("fingerprint-box").hidden = true;
  element("fingerprint-confirm").checked = false;
  element("password").value = "";
  element("password").disabled = true;
  element("connect-button").disabled = true;
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

function showError(error) {
  errorMessage.textContent = error.message ?? "Something went wrong.";
  errorBox.hidden = false;
  errorBox.focus();
}

function clearError() {
  errorBox.hidden = true;
  errorMessage.textContent = "";
}

function setBusy(button, busy, busyText) {
  if (!button.dataset.label) {
    button.dataset.label = button.textContent;
  }
  button.disabled = busy;
  button.setAttribute("aria-busy", String(busy));
  button.textContent = busy ? busyText : button.dataset.label;
}

const revertTimers = new WeakMap();

function flashCopied(button) {
  if (!button.dataset.label) {
    button.dataset.label = button.getAttribute("aria-label");
  }
  button.setAttribute("aria-label", `${button.dataset.copyLabel} copied`);
  button.setAttribute("title", `${button.dataset.copyLabel} copied`);
  button.classList.add("copied");
  window.clearTimeout(revertTimers.get(button));
  revertTimers.set(
    button,
    window.setTimeout(() => {
      button.setAttribute("aria-label", button.dataset.label);
      button.setAttribute("title", button.dataset.label);
      button.classList.remove("copied");
    }, 1800),
  );
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
      // The generic error below avoids exposing copied configuration values.
    }
  }

  throw new Error("The browser refused clipboard access.");
}

function renderHttpRequestBody(model) {
  element("result-http-body").textContent = JSON.stringify(
    {
      model: model === "Not detected" ? "gpt-5.6-sol" : model,
      messages: [
        {
          role: "user",
          content: "What is a robot?",
        },
      ],
      response_format: {
        type: "json_schema",
        json_schema: {
          name: "answer",
          schema: {
            type: "object",
            properties: {
              content: { type: "string" },
            },
            required: ["content"],
            additionalProperties: false,
          },
          strict: true,
        },
      },
    },
    null,
    2,
  );
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
    "Credential: openai-oauth",
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

element("setup-another-vps").href = token
  ? `/?session=${encodeURIComponent(token)}`
  : "/";

const delay = (milliseconds) =>
  new Promise((resolve) => window.setTimeout(resolve, milliseconds));

function validateAuthorizationUrl(value) {
  const url = new URL(value);
  if (
    url.origin !== "https://auth.openai.com" ||
    url.pathname !== "/oauth/authorize"
  ) {
    throw new Error("The wizard refused an unexpected sign-in destination.");
  }
  return url.toString();
}

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
  stopButton.hidden = !visible;
  stopButton.disabled = !visible;
  stopButton.setAttribute("aria-busy", "false");
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
  setBusy(loginButton, false);
  loginButton.disabled = true;
}

async function waitForOAuthCompletion(expectedAttemptId) {
  for (let attempt = 0; attempt < 330; attempt += 1) {
    const result = await api("/api/oauth/status");
    if (result.retryBlocked === true) {
      const error = new Error(
        result.error ??
          "ChatGPT sign-in could not be stopped safely. Close the sign-in helper, then restart Relmio.",
      );
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
      const error = new Error(
        result.error ?? "ChatGPT sign-in did not finish. Start again.",
      );
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

function showStep(step) {
  state.step = step;
  document.body.dataset.currentStep = String(step);
  if (step === 5) {
    dismissToast(element("global-safety"));
    dismissToast(element("global-backup"));
  }
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
      "This wizard link is incomplete. Close this tab and open the full URL printed by the active setup terminal.",
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
      "The local wizard server is not reachable. Keep its terminal window open and restart the latest command.",
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
    const error = new Error(result.error ?? "The request failed.");
    error.oauthRetryBlocked = result.retryBlocked === true;
    throw error;
  }
  return result;
}

function renderAuthUpdatedAt(value) {
  const row = element("auth-updated");
  const time = element("auth-updated-time");
  const formatted = formatAuthUpdatedAt(value);

  if (!formatted) {
    row.hidden = true;
    time.textContent = "";
    time.removeAttribute("datetime");
    return null;
  }

  time.textContent = formatted;
  time.setAttribute("datetime", value);
  row.hidden = false;
  return formatted;
}

async function refreshAuthStatus({ fresh = false } = {}) {
  clearError();
  const status = await api("/api/status");
  const indicator = element("auth-indicator");
  const loginButton = element("login-button");
  const next = element("signin-next");
  const formattedUpdatedAt = renderAuthUpdatedAt(status.authUpdatedAt);

  if (status.previewMode) {
    indicator.classList.add("ready");
    element("auth-title").textContent = "Sanitized preview credential";
    element("auth-detail").textContent =
      "Preview mode uses sample data and cannot start a real ChatGPT sign-in.";
    loginButton.textContent = "Preview sign-in disabled";
    loginButton.dataset.label = "Preview sign-in disabled";
    loginButton.disabled = true;
    next.disabled = false;
    setMessage("Sanitized preview mode: no live ChatGPT sign-in will open.");
    return;
  }

  loginButton.disabled = false;
  if (status.authExists) {
    indicator.classList.add("ready");
    element("auth-title").textContent = fresh
      ? "Fresh credential saved"
      : "Local credential found";
    element("auth-detail").textContent =
      "Continue uses it as-is. Refresh the sign-in if it is expired or was created by another client.";
    loginButton.textContent = "Refresh ChatGPT sign-in";
    loginButton.dataset.label = "Refresh ChatGPT sign-in";
    next.disabled = false;
    setMessage(
      fresh && formattedUpdatedAt
        ? `Fresh sign-in saved at ${formattedUpdatedAt} (local time).`
        : "Local sign-in is ready.",
    );
  } else {
    indicator.classList.remove("ready");
    element("auth-title").textContent = "Sign-in needed";
    element("auth-detail").textContent =
      "A browser sign-in will open and wait for up to five minutes.";
    loginButton.textContent = "Sign in with ChatGPT";
    loginButton.dataset.label = "Sign in with ChatGPT";
    next.disabled = true;
    setMessage("Sign in with ChatGPT to continue.");
  }
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

async function loadNetworks() {
  clearError();
  const containerName = element("container-select").value;
  const result = await api("/api/networks", {
    method: "POST",
    body: { containerName },
  });
  state.networks = result;
  fillSelect(
    element("network-select"),
    result.networks.map((network) => ({ value: network, label: network })),
    result.recommended,
  );
}

async function discover() {
  setMessage("Inspecting Docker with read-only commands…");
  const result = await api("/api/discover", {
    method: "POST",
    body: {},
  });
  if (result.containers.length === 0) {
    throw new Error("No running official n8n container was found.");
  }

  state.discovery = result;
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
  showStep(3);
  setMessage("n8n was found. Choose the network it shares with the sidecar.");
}

element("login-button").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  if (state.oauthRetryBlocked) {
    return;
  }
  const loginLink = element("login-link");
  const loginGeneration = state.oauthLoginGeneration + 1;
  state.oauthLoginGeneration = loginGeneration;
  state.oauthAttemptId = null;
  const loginWindow = window.open("about:blank", "_blank");
  state.oauthLoginWindow = loginWindow;
  let loginWindowNavigated = false;
  prepareOAuthPopup(loginWindow);
  clearError();
  loginLink.hidden = true;
  loginLink.removeAttribute("href");
  setOAuthStopControlVisible(false);
  setBusy(button, true, "Waiting for browser sign-in…");
  setMessage(
    "Preparing a fresh ChatGPT sign-in. The existing local credential will be replaced only after sign-in succeeds.",
  );
  try {
    const result = await api("/api/oauth/login", {
      method: "POST",
      body: {},
    });
    const authorizationUrl = validateAuthorizationUrl(result.authorizationUrl);
    const attemptId = validateOAuthAttemptId(result.attemptId);
    if (state.oauthLoginGeneration !== loginGeneration) {
      return;
    }
    state.oauthAttemptId = attemptId;
    setOAuthStopControlVisible(true);
    loginLink.href = authorizationUrl;
    loginLink.hidden = false;
    if (loginWindow) {
      loginWindow.location.replace(authorizationUrl);
      loginWindowNavigated = true;
      loginWindow.opener = null;
    }
    setMessage(
      "Complete the newly opened sign-in within five minutes. If no tab opened, use “Open fresh ChatGPT sign-in” below. If an OpenAI OAuth browser extension intercepts the callback, disable it temporarily and start again.",
    );
    await waitForOAuthCompletion(attemptId);
    if (state.oauthLoginGeneration !== loginGeneration) {
      return;
    }
    loginLink.hidden = true;
    loginLink.removeAttribute("href");
    await refreshAuthStatus({ fresh: true });
  } catch (error) {
    if (loginWindow && !loginWindowNavigated) {
      loginWindow.close();
    }
    if (state.oauthLoginGeneration === loginGeneration) {
      if (error.oauthRetryBlocked === true) {
        blockOAuthRetry();
      }
      showError(error);
    }
  } finally {
    if (state.oauthLoginGeneration === loginGeneration) {
      state.oauthAttemptId = null;
      state.oauthLoginWindow = null;
      setOAuthStopControlVisible(false);
      setBusy(button, false);
      if (state.oauthRetryBlocked) {
        button.disabled = true;
      }
    }
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
  setBusy(stopButton, true, "Stopping sign-in…");
  try {
    const result = await api("/api/oauth/cancel", {
      method: "POST",
      body: { attemptId },
    });
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
    setBusy(element("login-button"), false);
    setOAuthStopControlVisible(false);
    setMessage("ChatGPT sign-in stopped. You can start again.");
  } catch (error) {
    if (state.oauthLoginGeneration === loginGeneration) {
      if (error.oauthRetryBlocked === true) {
        state.oauthLoginGeneration += 1;
        blockOAuthRetry();
      }
      showError(error);
      if (!state.oauthRetryBlocked) {
        setBusy(stopButton, false);
      }
    }
  }
});

element("signin-next").addEventListener("click", () => {
  clearError();
  showStep(2);
  setMessage("Enter the VPS address exactly as Hostinger shows it.");
});

element("fingerprint-button").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  clearError();
  setBusy(button, true, "Checking identity…");
  try {
    const result = await api("/api/ssh/fingerprint", {
      method: "POST",
      body: {
        host: element("host").value,
        port: element("port").value,
      },
    });
    state.fingerprint = result.fingerprint;
    element("fingerprint-value").textContent = result.fingerprint;
    element("fingerprint-box").hidden = false;
    element("fingerprint-confirm").checked = false;
    element("password").value = "";
    element("password").disabled = true;
    element("connect-button").disabled = true;
    setMessage("Confirm the VPS identity before sending a password.");
  } catch (error) {
    showError(error);
  } finally {
    setBusy(button, false);
  }
});

element("fingerprint-confirm").addEventListener("change", (event) => {
  const confirmed = event.currentTarget.checked;
  element("password").disabled = !confirmed;
  element("connect-button").disabled = !confirmed;
  if (confirmed) {
    element("password").focus();
  } else {
    element("password").value = "";
  }
});

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

element("container-select").addEventListener("change", async () => {
  try {
    await loadNetworks();
  } catch (error) {
    element("install-confirm").checked = false;
    element("install-button").disabled = true;
    showStep(2);
    setMessage(
      "The install stopped and the VPS connection was closed. Reconnect to inspect the sidecar before retrying.",
    );
    showError(error);
  }
});

element("review-button").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  clearError();
  setBusy(button, true, "Preparing plan…");
  try {
    const networkName = element("network-select").value;
    const plan = await api("/api/plan", {
      method: "POST",
      body: {
        containerName: element("container-select").value,
        networkName,
      },
    });
    element("review-network").textContent = networkName;
    element("review-endpoint").textContent = plan.endpointHostname;
    element("install-confirm").checked = false;
    element("install-button").disabled = true;
    showStep(4);
    setMessage("Review the plan. The VPS has not been changed.");
  } catch (error) {
    showError(error);
  } finally {
    setBusy(button, false);
  }
});

element("install-confirm").addEventListener("change", (event) => {
  element("install-button").disabled = !event.currentTarget.checked;
});

element("install-button").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  clearError();
  setBusy(button, true, "Building the sidecar…");
  setMessage("Installing only the separate OAuth sidecar. This can take a minute.");
  state.installAttempted = true;
  try {
    const result = await api("/api/install", {
      method: "POST",
      body: {
        containerName: element("container-select").value,
        networkName: element("network-select").value,
        confirmed: element("install-confirm").checked,
      },
    });
    element("result-url").textContent = result.baseUrl;
    element("result-key").textContent = result.apiKeyPlaceholder;
    const firstModel = result.models[0] ?? "Not detected";
    element("result-model").textContent = firstModel;
    element("result-models").textContent = result.models.join(", ");
    element("result-http-url").textContent =
      `${result.baseUrl.replace(/\/$/u, "")}/chat/completions`;
    renderHttpRequestBody(firstModel);
    showStep(5);
    setMessage(
      result.deploymentMode === "updated"
        ? "OAuth refreshed on the existing wizard-managed sidecar. n8n was not restarted."
        : "Installation verified. Your existing n8n was not restarted.",
    );
  } catch (error) {
    showError(error);
  } finally {
    setBusy(button, false);
  }
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
  button.addEventListener("click", () => {
    clearError();
    showStep(Number(button.dataset.back));
    setMessage(
      state.installAttempted
        ? "The install was attempted. Reconnect to inspect the sidecar; n8n was not restarted."
        : "No VPS changes have been made.",
    );
  });
}

renderHttpRequestBody(element("result-model").textContent);
refreshAuthStatus().catch(showError);

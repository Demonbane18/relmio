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
  chatTester: {
    conversationId: null,
    encryptedCredential: null,
    endpointBaseUrl: null,
    expiresAt: null,
    generation: 0,
    keyId: null,
  },
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
  element("local-image-build-troubleshooting").hidden = true;
  errorBox.hidden = true;
}

function showError(error) {
  const localImageBuildFailed = error?.message === "Local image build failed.";
  errorText.textContent = localImageBuildFailed
    ? "Relmio could not build the local image. Check that Docker is running, has enough disk space, and can pull its base image."
    : error?.message ?? "Something went wrong.";
  element("local-image-build-troubleshooting").hidden = !localImageBuildFailed;
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

async function streamChatTesterMessage(body, onEvent) {
  if (!token) {
    throw new Error(
      "This wizard link is incomplete. Close this tab and open the full URL printed by the active Relmio terminal.",
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
    });
  } catch {
    throw new Error("The local Relmio wizard is not reachable. Keep its terminal open and try again.");
  }
  if (
    !response.ok ||
    !response.body ||
    !/^text\/event-stream(?:\s*;|$)/iu.test(response.headers.get("content-type") ?? "") ||
    response.headers.get("x-relmio-stream") !== "v1"
  ) {
    throw new Error("The local wizard could not start a safe response stream.");
  }

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
      const messages = {
        timeout: "The adapter test took too long. Try again.",
        upstream_failed: "The local adapter could not complete this response.",
      };
      streamError = messages[item.data.code] ?? messages.upstream_failed;
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

  if (!terminal || terminal.outcome !== "completed" || typeof terminal.conversationId !== "string") {
    throw new Error(streamError ?? "The adapter response ended before completion.");
  }
  return { conversationId: terminal.conversationId };
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
  element("chat-tester").hidden = !codexChat;
  if (codexChat && !state.chatTester.keyId) {
    element("chat-tester-endpoint").value = result.endpoint;
  }
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

function setChatTesterStatus(text) {
  element("chat-tester-status").textContent = text;
}

function clearChatTesterError() {
  element("chat-tester-error").textContent = "";
  element("chat-tester-error").hidden = true;
}

function showChatTesterError(error) {
  element("chat-tester-error").textContent =
    error?.message ?? "The local adapter test could not be completed.";
  element("chat-tester-error").hidden = false;
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

function clearChatTesterState() {
  state.chatTester.conversationId = null;
  state.chatTester.encryptedCredential = null;
  state.chatTester.endpointBaseUrl = null;
  state.chatTester.expiresAt = null;
  state.chatTester.keyId = null;
  state.chatTester.generation += 1;
  element("chat-tester-credential").value = "";
  element("chat-tester-endpoint").value = "";
  element("chat-tester-input").value = "";
  element("chat-tester-secure-form").hidden = false;
  element("chat-tester-message-form").hidden = true;
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
    if (isCodexChat(state.installedTarget)) {
      await forgetChatTester({ announce: false });
    }
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

  clearChatTesterError();
  let clientCredential = clientCredentialInput.value;
  clientCredentialInput.value = "";
  let issuedKey;
  resetButton.disabled = true;
  setBusy(button, true, "Securing credential…");
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
    element("chat-tester-secure-form").hidden = true;
    element("chat-tester-message-form").hidden = false;
    setChatTesterStatus("Temporary test session secured. Send a message before the key expires.");
    element("chat-tester-input").focus();
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

  clearChatTesterError();
  const text = input.value;
  const generation = state.chatTester.generation;
  input.value = "";
  appendChatTesterTurn("user", text);
  const assistantContent = appendChatTesterTurn("assistant", "");
  resetButton.disabled = true;
  setBusy(button, true, "Streaming response…");
  setChatTesterStatus("Connecting to the loopback adapter through the secured local wizard…");
  try {
    const result = await streamChatTesterMessage(
      {
        endpointBaseUrl: state.chatTester.endpointBaseUrl,
        keyId: state.chatTester.keyId,
        encryptedCredential: state.chatTester.encryptedCredential,
        input: text,
        ...(state.chatTester.conversationId
          ? { conversationId: state.chatTester.conversationId }
          : {}),
      },
      (event, data) => {
        if (state.chatTester.generation !== generation) return;
        if (event === "progress") {
          setChatTesterStatus("The adapter is working on the response…");
        } else if (event === "delta" && typeof data.text === "string") {
          assistantContent.textContent += data.text;
          setChatTesterStatus("Streaming the adapter response…");
        }
      },
    );
    if (state.chatTester.generation !== generation) {
      return;
    }
    state.chatTester.conversationId = result.conversationId;
    if (!assistantContent.textContent) {
      throw new Error("The local adapter completed without a visible response.");
    }
    setChatTesterStatus("Response received. Continue this conversation or forget the tester.");
  } catch (error) {
    if (state.chatTester.generation === generation) {
      if (!assistantContent.textContent) {
        assistantContent.parentElement?.remove();
        setChatTesterStatus("No completed adapter response was added. You can retry or forget this tester.");
      } else {
        const assistantTurn = assistantContent.parentElement;
        assistantTurn?.classList.add("chat-tester-turn-incomplete");
        const heading = assistantTurn?.querySelector("strong");
        if (heading) heading.textContent = "Local adapter · incomplete";
        setChatTesterStatus("The response stopped before completion. Partial text is marked incomplete and was not accepted.");
      }
      showChatTesterError(error);
    }
  } finally {
    resetButton.disabled = false;
    setBusy(button, false);
  }
});

element("chat-tester-reset").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  clearChatTesterError();
  setBusy(button, true, "Forgetting tester…");
  try {
    await forgetChatTester();
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

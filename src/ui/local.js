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
  n8nContainers: [],
  n8nDiscoveryLoaded: false,
  n8nOAuthExists: false,
  n8nOAuthGeneration: 0,
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
element("setup-another-local").href = createWizardUrl("/local");
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

function isN8nSidecar(target) {
  return target === "n8n-openai-oauth";
}

function isN8nAssistant(target) {
  return target === "n8n-ai-assistant";
}

function isN8nStack(target) {
  return target === "local-n8n-stack";
}

function isN8nDockerTarget(target) {
  return isN8nSidecar(target) || isN8nAssistant(target);
}

function assistantModeLabel(mode) {
  return mode === "sandbox-with-searxng"
    ? "Code Sandbox + SearXNG"
    : mode === "sandbox"
      ? "Code Sandbox"
      : "Disabled";
}

function setSelectOptions(select, options, emptyLabel, promptLabel) {
  const currentValue = select.value;
  const placeholder = document.createElement("option");
  placeholder.value = "";
  placeholder.textContent = options.length > 0 ? promptLabel : emptyLabel;
  placeholder.disabled = options.length > 0;
  const nodes = [placeholder, ...options.map(({ label, value }) => {
    const option = document.createElement("option");
    option.value = value;
    option.textContent = label;
    return option;
  })];
  select.replaceChildren(...nodes);
  if (options.some(({ value }) => value === currentValue)) {
    select.value = currentValue;
  } else {
    select.value = "";
  }
  select.disabled = options.length === 0;
}

function isAssistantNetwork(networkName) {
  return (
    networkName === "assistant-shared" ||
    networkName.endsWith("_assistant-shared")
  );
}

function isNgrokEdgeNetwork(networkName) {
  return networkName === "edge" || networkName.endsWith("_edge");
}

function networkPriority(network) {
  if (isAssistantNetwork(network.networkName)) return 0;
  if (isNgrokEdgeNetwork(network.networkName)) return 2;
  return 1;
}

function networkOptionLabel(network) {
  const recommended = "Recommended, private Assistant network";
  if (isAssistantNetwork(network.networkName)) {
    return `${recommended}, ${network.networkName}`;
  }
  if (isNgrokEdgeNetwork(network.networkName)) {
    return `${network.networkName}, also contains ngrok`;
  }
  return network.disposable
    ? `${network.networkName}, disposable test network`
    : network.networkName;
}

function updateReviewAvailability() {
  const sidecar = isN8nSidecar(state.target);
  const stack = isN8nStack(state.target);
  const n8nTarget = isN8nDockerTarget(state.target);
  const n8nReady =
    stack || !n8nTarget ||
    ((!sidecar || state.n8nOAuthExists) &&
      element("n8n-container").value !== "" &&
      element("n8n-network").value !== "");
  element("review-button").disabled = !state.dockerAvailable || !n8nReady;
}

function renderSidecarNetworkOptions() {
  const container = state.n8nContainers.find(
    ({ containerId }) => containerId === element("n8n-container").value,
  );
  const networks = container?.networks ?? [];
  const sortedNetworks = [...networks].sort(
    (left, right) =>
      networkPriority(left) - networkPriority(right) ||
      left.networkName.localeCompare(right.networkName),
  );
  setSelectOptions(
    element("n8n-network"),
    sortedNetworks.map((network) => ({
      label: networkOptionLabel(network),
      value: network.dockerNetworkId,
    })),
    "No shared Docker network found",
    "Choose a shared Docker network",
  );
  const selectedNetwork = networks.find(
    ({ dockerNetworkId }) => dockerNetworkId === element("n8n-network").value,
  );
  element("n8n-discovery-status").textContent = selectedNetwork && isNgrokEdgeNetwork(selectedNetwork.networkName)
    ? "This network also contains ngrok. The bridge still publishes no host port, but the private Assistant network is the recommended choice."
    : selectedNetwork && isAssistantNetwork(selectedNetwork.networkName)
      ? "Recommended private Assistant network selected. Remove the bridge before tearing down a disposable test stack."
    : selectedNetwork?.disposable
      ? "This is a disposable test network. Remove the bridge before tearing the test stack down."
    : container
      ? networks.length > 0
        ? "Choose one shared Docker network. The private Assistant network is recommended when available."
        : "The selected running n8n container has no eligible shared Docker network."
      : "No running n8n container is selected.";
  invalidatePlan();
  updateReviewAvailability();
}

function validateN8nDiscovery(result) {
  if (!result || !Array.isArray(result.containers)) {
    throw new Error("The local wizard returned unexpected n8n discovery data.");
  }
  return result.containers.map((container) => {
    if (
      typeof container.containerId !== "string" ||
      typeof container.containerName !== "string" ||
      typeof container.image !== "string" ||
      !Array.isArray(container.networks)
    ) {
      throw new Error("The local wizard returned unexpected n8n discovery data.");
    }
    return {
      containerId: container.containerId,
      containerName: container.containerName,
      image: container.image,
      networks: container.networks.map((network) => {
        if (
          typeof network.dockerNetworkId !== "string" ||
          typeof network.networkName !== "string"
        ) {
          throw new Error("The local wizard returned unexpected n8n discovery data.");
        }
        return {
          dockerNetworkId: network.dockerNetworkId,
          networkName: network.networkName,
          disposable: network.disposable === true,
        };
      }),
    };
  });
}

async function refreshN8nDiscovery() {
  element("n8n-discovery-status").textContent =
    "Discovering running n8n containers without changing Docker…";
  const result = await api("/api/local/n8n/discover");
  state.n8nContainers = validateN8nDiscovery(result);
  state.n8nDiscoveryLoaded = true;
  setSelectOptions(
    element("n8n-container"),
    state.n8nContainers.map((container) => ({
      label: `${container.containerName}, ${container.image}`,
      value: container.containerId,
    })),
    "No running n8n container found",
    "Choose a running n8n container",
  );
  renderSidecarNetworkOptions();
}

function sidecarOAuthExists(result) {
  return result?.authExists === true;
}

async function refreshN8nOAuthStatus({ announce = false } = {}) {
  const status = element("n8n-oauth-status");
  status.textContent = "Checking local ChatGPT sign-in…";
  const result = await api("/api/status");
  state.n8nOAuthExists = sidecarOAuthExists(result);
  if (state.n8nOAuthExists) {
    const updated = result.authUpdatedAt
      ? ` Last updated ${new Date(result.authUpdatedAt).toLocaleString()}.`
      : "";
    status.textContent = `Signed in locally.${updated}`;
    if (announce) {
      setMessage("Local ChatGPT OAuth credential is ready for the private n8n bridge.");
    }
  } else {
    status.textContent = "Not signed in. Complete ChatGPT sign-in before reviewing the bridge plan.";
    if (announce) {
      setMessage("A local ChatGPT OAuth credential is required before Relmio can prepare the bridge plan.");
    }
  }
  updateReviewAvailability();
  return result;
}

function validateOAuthAuthorizationUrl(value) {
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
    url.pathname !== "/oauth/authorize" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== ""
  ) {
    throw new Error("Relmio refused an unexpected sign-in destination.");
  }
  return url.toString();
}

function validateOAuthAttemptId(value) {
  if (typeof value !== "string" || !/^[0-9a-f-]{8,128}$/iu.test(value)) {
    throw new Error("The wizard returned an unexpected sign-in attempt.");
  }
  return value;
}

async function waitForN8nOAuth(expectedAttemptId, generation) {
  for (let attempt = 0; attempt < 300; attempt += 1) {
    const result = await api("/api/oauth/status");
    if (state.n8nOAuthGeneration !== generation) return false;
    if (result.attemptId && result.attemptId !== expectedAttemptId) {
      throw new Error("The ChatGPT sign-in was replaced by a newer attempt.");
    }
    if (result.status === "success") return true;
    if (result.status === "error" || result.status === "cancelled") {
      throw new Error(result.error ?? "ChatGPT sign-in did not finish.");
    }
    await delay(attempt < 40 ? 250 : 1_000);
  }
  throw new Error("The sign-in request expired. Start a fresh login.");
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
  const sidecar = isN8nSidecar(state.target);
  const assistant = isN8nAssistant(state.target);
  const stack = isN8nStack(state.target);
  const n8nTarget = sidecar || assistant;
  const endpointFields = element("endpoint-fields");
  const portInput = element("local-port");
  const originsInput = element("allowed-origins");
  if (!n8nTarget) {
    portInput.value = openAiApi ? "12435" : codexChat ? "14501" : "14500";
  }
  endpointFields.hidden = n8nTarget || stack;
  portInput.disabled = n8nTarget || stack;
  portInput.required = !n8nTarget && !stack;
  originsInput.disabled = n8nTarget || stack;
  element("origins-field").hidden = n8nTarget || stack || !openAiApi;
  element("n8n-sidecar-fields").hidden = !n8nTarget;
  element("n8n-stack-fields").hidden = !stack;
  element("n8n-stack-secrets").hidden = true;
  for (const id of [
    "ngrok-hostname",
    "n8n-stack-port",
    "ngrok-inspector-port",
    "n8n-stack-timezone",
    "n8n-stack-assistant-mode",
  ]) {
    element(id).disabled = !stack;
    element(id).required = stack;
  }
  for (const id of ["ngrok-authtoken", "ngrok-basic-auth-username", "ngrok-basic-auth-password"]) {
    element(id).disabled = true;
    element(id).required = false;
    element(id).value = "";
  }
  element("n8n-sidecar-oauth").hidden = !sidecar;
  element("n8n-sidecar-scope").hidden = !sidecar;
  element("n8n-assistant-options").hidden = !assistant;
  element("boundary-title").textContent = stack
    ? "Loopback n8n with authenticated public access"
    : n8nTarget
    ? "Docker-network-only guarantee"
    : "Loopback-only guarantee";
  element("boundary-detail").textContent = stack
    ? "n8n and the ngrok inspector bind only to loopback. The separately public ngrok URL requires mandatory Basic Auth."
    : n8nTarget
    ? "Relmio publishes no host port. Only the selected n8n Docker network can reach these managed services."
    : "Relmio publishes the selected port on 127.0.0.1, not your LAN or the public internet.";
  element("target-guidance-title").textContent = stack
    ? "Creates a separate Relmio-owned n8n stack"
    : sidecar
    ? "Uses a local ChatGPT OAuth credential"
    : assistant
      ? "Installs n8n AI Assistant support services"
    : openAiApi
    ? "Uses an OpenAI Platform API key"
    : codexChat
      ? "Uses official Codex ChatGPT sign-in through the experimental Relmio-specific Chat Adapter"
      : "Uses the official Codex ChatGPT sign-in";
  element("target-guidance-detail").textContent = stack
    ? "This never discovers, edits, restarts, or reuses existing n8n. Code Sandbox uses a privileged local runner; add the existing private OAuth bridge later as a separate option."
    : sidecar
    ? "Relmio copies the validated local credential into its own private managed volume. No credential is sent to or returned through this browser."
    : assistant
      ? "Code Sandbox is always included. SearXNG JSON web search is optional and off by default. The generated sandbox API key is shown once; model-provider credentials stay separate and are configured directly in n8n."
    : openAiApi
    ? "Your Platform key is seeded over stdin into a private Docker volume and is never returned to the browser. A separate local client credential is generated for your apps."
    : codexChat
      ? "This exposes Relmio-specific HTTP POST /chat for a trusted local backend or development server. It is not OpenAI /v1, has no CORS, and browser bundles must never connect directly."
      : "This runs Codex App Server as its own experimental protocol. It does not translate the ChatGPT session into a generic OpenAI /v1 API and it does not accept direct browser connections.";
  if (n8nTarget) {
    if (!state.n8nDiscoveryLoaded) {
      refreshN8nDiscovery().catch(showError);
    }
  }
  if (sidecar) {
    refreshN8nOAuthStatus().catch(showError);
  }
  updateReviewAvailability();
}

function appendPolicyNotice(container, heading, detail) {
  const strong = document.createElement("strong");
  const paragraph = document.createElement("p");
  strong.textContent = heading;
  paragraph.textContent = detail;
  container.replaceChildren(strong, paragraph);
}

function replaceListItems(container, items) {
  container.replaceChildren(
    ...items.map((text) => {
      const item = document.createElement("li");
      item.textContent = text;
      return item;
    }),
  );
}

function renderPlan(plan) {
  const openAiApi = isOpenAiApi(plan.target);
  const codexChat = isCodexChat(plan.target);
  const sidecar = isN8nSidecar(plan.target);
  const assistant = isN8nAssistant(plan.target);
  const stack = isN8nStack(plan.target);
  const n8nTarget = sidecar || assistant;
  element("review-endpoint-label").textContent = stack
    ? "Local n8n URL"
    : assistant
    ? "Support services"
    : "Endpoint";
  element("review-endpoint").textContent = stack
    ? plan.localUrl
    : assistant
    ? plan.includeSearxng
      ? "Code Sandbox + SearXNG"
      : "Code Sandbox only"
    : plan.endpoint;
  element("review-protocol").textContent = stack
    ? "New local n8n stack with ngrok Basic Auth"
    : sidecar
    ? "OpenAI-compatible HTTP /v1 inside Docker"
    : assistant
      ? "n8n Instance AI companion services"
    : openAiApi
    ? "OpenAI-compatible HTTP /v1"
    : codexChat
      ? "Relmio Codex Chat HTTP: POST /chat"
      : "Codex App Server JSON-RPC over WebSocket";
  element("review-auth").textContent = stack
    ? "ngrok authtoken + mandatory Basic Auth (entered only during installation)"
    : sidecar
    ? "Local ChatGPT OAuth credential (not Platform API key)"
    : assistant
      ? "Model-provider credential configured separately in n8n"
    : openAiApi
    ? "OpenAI Platform API key"
    : "ChatGPT sign-in through official Codex";
  element("review-browser-row").hidden = n8nTarget || stack;
  element("review-browser").textContent = openAiApi
    ? plan.allowedOrigins.length > 0
      ? `Only ${plan.allowedOrigins.length} exact allowed origin(s)`
      : "Native clients only until exact origins are added"
    : codexChat
      ? "No. Trusted local backends and development servers only"
      : "No. Trusted native local clients only";
  element("review-origins-row").hidden = n8nTarget || stack || !openAiApi;
  element("review-origins").textContent = openAiApi
    ? plan.allowedOrigins.length > 0
      ? plan.allowedOrigins.join(", ")
      : "None"
    : "";
  for (const id of ["review-n8n-row", "review-network-row", "review-publication-row"]) {
    element(id).hidden = !n8nTarget;
  }
  element("review-n8n").textContent = n8nTarget ? plan.n8nContainerName : "";
  element("review-network").textContent = n8nTarget ? plan.networkName : "";
  element("review-publication").textContent = n8nTarget ? "None" : "";
  element("review-public-url-row").hidden = !stack;
  element("review-assistant-mode-row").hidden = !stack;
  element("review-public-url").textContent = stack ? plan.ngrokPublicUrl : "";
  element("review-assistant-mode").textContent = stack
    ? assistantModeLabel(plan.assistantMode)
    : "";
  element("review-path").textContent = plan.managedPath;

  if (stack) {
    for (const id of ["review-n8n-row", "review-network-row", "review-publication-row"]) {
      element(id).hidden = true;
    }
    replaceListItems(element("review-will"), [
      "Create a brand-new Relmio-owned n8n stack at the displayed managed path.",
      `Bind n8n to ${plan.localUrl} and the ngrok inspector to loopback only.`,
      `Expose ${plan.ngrokPublicUrl} only through ngrok with mandatory Basic Auth.`,
      `Install the selected Assistant mode: ${assistantModeLabel(plan.assistantMode)}.`,
    ]);
    replaceListItems(element("review-will-not"), [
      "Discover, edit, restart, stop, recreate, or reuse any existing n8n deployment.",
      "Expose the n8n or ngrok inspector port to the LAN or public internet.",
      "Display or return the ngrok authtoken, Basic Auth password, or generated n8n encryption key.",
      "Add the existing private OAuth bridge; choose it afterward as a separate wizard option.",
    ]);
    element("install-confirm-copy").textContent =
      "I reviewed this exact plan and authorize Relmio to create a brand-new owned n8n stack and a public ngrok URL protected by mandatory Basic Auth. I understand existing n8n deployments are untouched.";
    appendPolicyNotice(
      element("review-policy"),
      "Public ngrok access is authenticated; local services remain loopback-only",
      "The ngrok authtoken and Basic Auth credentials are required only after review. Code Sandbox uses a privileged local runner. The existing private OAuth bridge remains a separate wizard choice.",
    );
  } else if (sidecar) {
    replaceListItems(element("review-will"), [
      "Create only the new openai-oauth sidecar and its private managed credential volume.",
      "Attach the sidecar to the exact selected existing Docker network.",
      "Expose port 10531 only inside that Docker network.",
      "Verify the private API and available models before reporting success.",
    ]);
    replaceListItems(element("review-will-not"), [
      "Edit, exec into, rebuild, restart, stop, recreate, or change network membership on the selected n8n container.",
      "Publish port 10531 to localhost, your LAN, ngrok, or the internet.",
      "Return or display your ChatGPT OAuth credential in this browser.",
      "Install n8n AI Assistant Code Sandbox or SearXNG.",
    ]);
    element("install-confirm-copy").textContent =
      "I reviewed this exact Docker-network-only plan and authorize Relmio to copy my local ChatGPT OAuth credential into its private managed volume and start only the new `openai-oauth` sidecar. I understand it is unofficial; Relmio will not edit, exec into, rebuild, restart, stop, recreate, or change n8n network membership, or publish port 10531.";
  } else if (assistant) {
    replaceListItems(element("review-will"), [
      "Create the ownership-bound Code Sandbox API, certificate initializer, and privileged Docker-in-Docker runner.",
      plan.includeSearxng
        ? "Create SearXNG with its JSON search API enabled on the selected private network."
        : "Keep web search disabled; no SearXNG service, settings file, or URL will be created.",
      "Attach only the sandbox API and optional SearXNG service to the exact selected existing Docker network.",
      "Verify service health, the exact running set, optional JSON search, and zero host publication.",
    ]);
    replaceListItems(element("review-will-not"), [
      "Edit, exec into, rebuild, restart, stop, recreate, or change network membership on the selected n8n container.",
      "Publish the sandbox, runner, or SearXNG ports to localhost, your LAN, ngrok, or the internet.",
      "Store or configure an AI model-provider credential for n8n.",
      "Apply the returned n8n environment settings or restart n8n for you.",
    ]);
    element("install-confirm-copy").textContent =
      "I reviewed this exact private companion plan and authorize Relmio to start its Code Sandbox services with a privileged Docker-in-Docker runner and the selected SearXNG option. I understand this is for local development and testing; Relmio will not edit, exec into, rebuild, restart, stop, recreate, or change n8n network membership, or publish any companion port.";
  } else {
    replaceListItems(element("review-will"), [
      "Build one target-specific Docker image.",
      "Bind the selected port exactly to 127.0.0.1.",
      "Generate a separate one-time client credential.",
      "Keep provider credentials in private Docker volumes.",
    ]);
    replaceListItems(element("review-will-not"), [
      "Publish the endpoint to your LAN or internet.",
      "Turn ChatGPT credentials into Platform API credentials.",
      "Modify or restart your n8n container.",
      "Reuse the existing Hostinger deployment.",
    ]);
    element("install-confirm-copy").textContent =
      "I reviewed this exact loopback plan and authorize Relmio to write its managed local files and start this Docker container.";
  }

  if (sidecar) {
    appendPolicyNotice(
      element("review-policy"),
      "Unofficial, private Docker-network bridge",
      "n8n will use http://n8n-openai-oauth:10531/v1 on the selected network. The API key placeholder is local-only. This option does not install Code Sandbox or SearXNG, and it does not turn ChatGPT OAuth into an OpenAI Platform API key.",
    );
  } else if (assistant) {
    appendPolicyNotice(
      element("review-policy"),
      "Privileged local companion; operator-owned n8n configuration",
      plan.includeSearxng
        ? "Relmio will install Code Sandbox and private SearXNG. After verification, copy the one-time sandbox API key and returned URLs into your own n8n environment. Any n8n restart remains your action. Use Daytona instead for production sandboxing."
        : "Relmio will install Code Sandbox without web search. After verification, copy the one-time sandbox API key and returned URL into your own n8n environment. Any n8n restart remains your action. Use Daytona instead for production sandboxing.",
    );
  } else if (openAiApi) {
    appendPolicyNotice(
      element("review-policy"),
      "OpenAI Platform terms and billing apply",
      "This option sends requests to the OpenAI API with your developer Platform key. ChatGPT subscriptions and open-source program benefits do not turn a ChatGPT credential into an API key.",
    );
  } else if (codexChat) {
    appendPolicyNotice(
      element("review-policy"),
      "Experimental Codex Chat Adapter. Trusted local backends or development servers only",
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
  const sidecar = isN8nSidecar(state.plan.target);
  const assistant = isN8nAssistant(state.plan.target);
  const stack = isN8nStack(state.plan.target);
  const n8nTarget = sidecar || assistant || stack;
  const apiKey = element("platform-api-key");
  element("api-key-field").hidden = !openAiApi;
  element("codex-install-warning").hidden = openAiApi || n8nTarget;
  element("sidecar-install-note").hidden = !sidecar;
  element("assistant-install-note").hidden = !assistant;
  element("n8n-stack-install-note").hidden = !stack;
  element("n8n-stack-secrets").hidden = !stack;
  for (const id of ["ngrok-authtoken", "ngrok-basic-auth-username", "ngrok-basic-auth-password"]) {
    element(id).required = stack;
    element(id).disabled = !stack;
    element(id).value = "";
  }
  element("codex-install-warning-title").textContent = codexChat
    ? "Credential for trusted local backends or development servers only"
    : "High-trust capability";
  element("codex-install-warning-detail").textContent = codexChat
    ? "The generated bearer authorizes chat turns through your signed-in Codex container. Keep it only in a trusted local backend or development server; never put it in browser code."
    : "Anyone holding the generated client credential can control Codex inside its isolated container, act through your signed-in ChatGPT session, and may be able to recover that container's ChatGPT session credential. Treat this capability like your ChatGPT password and give it only to a trusted native local app.";
  apiKey.required = openAiApi;
  apiKey.value = "";
  element("install-intro").textContent = stack
    ? "Enter the ngrok authtoken and mandatory Basic Auth credentials for the reviewed new owned stack. They are sent only to this local Relmio process and cleared immediately."
    : sidecar
    ? "Relmio will re-attest the selected running n8n container and Docker network, seed its private credential volume, and install only the new sidecar."
    : assistant
      ? "Relmio will re-attest the selected running n8n container and Docker network, then create and verify only its private Code Sandbox services and selected SearXNG option."
    : openAiApi
    ? "Enter the OpenAI Platform API key this endpoint will use upstream. It is sent only to this local Relmio process."
    : codexChat
      ? "Relmio will install the experimental Codex Chat Adapter and official Codex App Server first. You will complete ChatGPT device sign-in after the container is ready."
      : "Relmio will install the official Codex App Server first. You will complete ChatGPT device sign-in after the container is ready.";
  setButtonLabel(
    element("install-button"),
    stack
      ? "Create new local n8n + ngrok"
      : sidecar
      ? "Install private n8n bridge"
      : assistant
        ? "Install n8n Assistant tools"
      : openAiApi
      ? "Install OpenAI API endpoint"
      : codexChat
        ? "Install Codex Chat Adapter"
        : "Install Codex App Server",
  );
}

function renderInstallResult(result) {
  const sidecar = isN8nSidecar(result.target);
  const assistant = isN8nAssistant(result.target);
  const stack = isN8nStack(result.target);
  const n8nTarget = sidecar || assistant || stack;
  const endpoint = stack ? result.localUrl : result.endpoint;
  const endpointTargets = ["openai-api", "codex-chatgpt", "codex-chat"];
  const assistantSettings = result?.n8nSettings;
  const expectedAssistantSettings = assistant
    ? {
        N8N_ENABLED_MODULES: "instance-ai",
        N8N_INSTANCE_AI_SANDBOX_ENABLED: "true",
        N8N_INSTANCE_AI_SANDBOX_PROVIDER: "n8n-sandbox",
        N8N_INSTANCE_AI_SANDBOX_IMAGE:
          "ghcr.io/n8n-io/n8n-sandbox-service-sandbox:1.1.0@sha256:16f62fb90a4ce61ef74925f62ea76bb11eb2a5598888b7c0651100c7944ed2d8",
        N8N_SANDBOX_SERVICE_URL: result.sandboxUrl,
        N8N_SANDBOX_SERVICE_API_KEY: result.sandboxApiKey,
        ...(result.includeSearxng
          ? { N8N_INSTANCE_AI_SEARXNG_URL: result.searxngUrl }
          : {}),
      }
    : null;
  const assistantResultValid =
    assistant &&
    result.protocol === "n8n-instance-ai-companion" &&
    result.endpoint === result.sandboxUrl &&
    /^http:\/\/relmio-ai-sandbox-[a-f0-9]{32}:8080$/u.test(
      result.sandboxUrl ?? "",
    ) &&
    /^[A-Za-z0-9_-]{43}$/u.test(result.sandboxApiKey ?? "") &&
    typeof result.includeSearxng === "boolean" &&
    (!result.includeSearxng ||
      /^http:\/\/relmio-ai-searxng-[a-f0-9]{32}:8080$/u.test(
        result.searxngUrl ?? "",
      )) &&
    result.hostPublication === "none" &&
    result.privilegedRunner === true &&
    result.n8nConfigurationRequired === true &&
    result.credentialShownOnce === true &&
    result.deploymentMode === "installed" &&
    typeof result.networkName === "string" &&
    assistantSettings &&
    typeof assistantSettings === "object" &&
    !Array.isArray(assistantSettings) &&
    JSON.stringify(assistantSettings) === JSON.stringify(expectedAssistantSettings);
  if (
    typeof endpoint !== "string" ||
    (!n8nTarget && typeof result.clientCredential !== "string") ||
    (!endpointTargets.includes(result.target) && !n8nTarget) ||
    (assistant && !assistantResultValid) ||
    (sidecar &&
      (result.endpoint !== "http://n8n-openai-oauth:10531/v1" ||
        result.apiKeyPlaceholder !== "local-only" ||
        (result.responsesApi !== true && result.useResponsesApi !== true) ||
        result.hostPublication !== "none" ||
        typeof result.networkName !== "string" ||
        result.deploymentMode !== "installed" ||
        !Array.isArray(result.models) ||
        result.models.some((model) => typeof model !== "string")))
    || (stack &&
      (!/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/u.test(result.localUrl ?? "") ||
        !/^https:\/\/[a-z0-9][a-z0-9.-]*\.[a-z0-9.-]+$/u.test(result.ngrokPublicUrl ?? "") ||
        !/^relmio-local-n8n-[a-f0-9]{32}$/u.test(result.projectName ?? "") ||
        !Array.isArray(result.containerServices) ||
        !Array.isArray(result.networks) ||
        !["disabled", "sandbox", "sandbox-with-searxng"].includes(result.assistantMode) ||
        result.deploymentMode !== "new-disposable-stack"))
  ) {
    throw new Error("The local installer returned an unexpected response.");
  }

  const openAiApi = isOpenAiApi(result.target);
  const codexChat = isCodexChat(result.target);
  state.installedTarget = result.target;
  element("install-result-list").hidden = false;
  element("client-warning").hidden = false;
  element("n8n-sidecar-removal").hidden = !sidecar;
  element("n8n-assistant-removal").hidden = !assistant;
  element("n8n-stack-removal").hidden = !stack;
  element("remove-bridge-confirm").checked = false;
  element("remove-bridge-confirm").disabled = false;
  element("remove-bridge-button").disabled = true;
  element("remove-bridge-status").textContent =
    "The bridge remains installed until this separate confirmation is checked.";
  element("remove-assistant-confirm").checked = false;
  element("remove-assistant-confirm").disabled = false;
  element("remove-assistant-button").disabled = true;
  element("remove-assistant-status").textContent =
    "The companion stack remains installed until this separate confirmation is checked.";
  element("remove-n8n-stack-confirm").checked = false;
  element("remove-n8n-stack-confirm").disabled = false;
  element("remove-n8n-stack-button").disabled = true;
  element("remove-n8n-stack-status").textContent =
    "The owned stack remains installed until this separate confirmation is checked.";
  element("result-endpoint-label").textContent = stack
    ? "Local n8n URL"
    : assistant
    ? "Sandbox Service URL"
    : "Endpoint";
  element("result-endpoint").textContent = endpoint;
  element("one-time-note").hidden = sidecar || stack;
  element("one-time-note-title").textContent = assistant
    ? "Copy this sandbox key now"
    : "Copy this credential now";
  element("one-time-note-detail").textContent = assistant
    ? "Relmio shows the sandbox API key only in this install response. Copy the complete environment block before leaving this page."
    : "Relmio shows the generated client credential only in this install response. It cannot recover it after you leave this page.";
  element("credential-rotation-note").hidden = n8nTarget;
  element("result-credential-row").hidden = n8nTarget;
  if (!n8nTarget) {
    element("result-credential").textContent = result.clientCredential;
  } else {
    element("result-credential").textContent = "";
  }
  for (const id of [
    "result-n8n-row",
    "result-network-row",
    "result-publication-row",
    "result-deployment-row",
  ]) {
    element(id).hidden = !n8nTarget;
  }
  for (const id of [
    "result-api-key-row",
    "result-responses-row",
    "result-models-row",
  ]) {
    element(id).hidden = !sidecar;
  }
  element("result-api-key").textContent = sidecar ? "local-only" : "";
  element("result-responses").textContent = sidecar ? "On" : "";
  element("result-n8n").textContent = stack
    ? result.projectName
    : n8nTarget
    ? result.n8nContainerName ?? state.plan?.n8nContainerName ?? "Selected n8n container"
    : "";
  element("result-network").textContent = stack
    ? result.networks.join(", ")
    : n8nTarget ? result.networkName : "";
  element("result-publication").textContent = stack
    ? result.hostPublication
    : n8nTarget ? "None" : "";
  element("result-models").textContent = sidecar
    ? result.models.length > 0
      ? result.models.join(", ")
      : "No models reported"
    : "";
  element("result-deployment").textContent = n8nTarget ? result.deploymentMode : "";
  element("result-public-url-row").hidden = !stack;
  element("result-assistant-mode-row").hidden = !stack;
  element("result-public-url").textContent = stack ? result.ngrokPublicUrl : "";
  element("result-assistant-mode").textContent = stack
    ? assistantModeLabel(result.assistantMode)
    : "";
  element("result-sandbox-key-row").hidden = !assistant;
  element("result-searxng-row").hidden = !assistant;
  element("copy-searxng-button").hidden =
    !assistant || result.includeSearxng !== true;
  element("result-n8n-settings-row").hidden = !assistant;
  element("result-sandbox-key").textContent = assistant
    ? result.sandboxApiKey
    : "";
  element("result-searxng").textContent = assistant
    ? result.includeSearxng
      ? result.searxngUrl
      : "Not installed"
    : "";
  element("result-n8n-settings").textContent = assistant
    ? Object.entries(assistantSettings)
      .map(([name, value]) => `${name}=${value}`)
      .join("\n")
    : "";
  element("codex-production-warning").hidden = openAiApi || n8nTarget;
  element("codex-login").hidden = n8nTarget || openAiApi;
  element("chat-tester").hidden = n8nTarget || !codexChat;
  if (codexChat && !state.chatTester.keyId) {
    element("chat-tester-endpoint").value = result.endpoint;
  }
  element("codex-production-warning-title").textContent = codexChat
    ? "Experimental Chat Adapter. Trusted local backends or development servers only"
    : "Experimental WebSocket transport";
  element("codex-production-warning-detail").textContent = codexChat
    ? "The adapter is for trusted local backends or development servers only. It has a Relmio-specific POST /chat contract, no CORS, and is not OpenAI /v1."
    : "Codex App Server WebSocket is experimental and unsupported for production workloads.";
  element("done-title").textContent = stack
    ? "New local n8n + ngrok is ready"
    : sidecar
    ? "Private n8n bridge is ready"
    : assistant
      ? "n8n Assistant tools are ready"
    : openAiApi
    ? "OpenAI API endpoint is ready"
    : codexChat
      ? "Codex Chat Adapter is installed"
      : "Codex App Server is installed";
  element("done-detail").textContent = stack
    ? "Use the loopback n8n URL locally. Before relying on the public URL, verify manually that anonymous access is blocked and your Basic Auth credentials succeed."
    : sidecar
    ? "Use the private base URL and local-only API key placeholder in n8n on the selected Docker network."
    : assistant
      ? "Copy the one-time environment block into your own n8n deployment. Relmio did not change or restart n8n."
    : openAiApi
    ? "Copy the endpoint and generated bearer credential into your local app."
    : codexChat
      ? "Copy the endpoint and generated bearer credential into your trusted local backend or development server, then sign the isolated Codex container in to ChatGPT."
      : "Copy the endpoint and capability, then sign the isolated Codex container in to ChatGPT.";
  appendPolicyNotice(
    element("client-warning"),
    stack
      ? "Authenticated public ngrok route; owned disposable stack"
      : sidecar
      ? "For the selected self-hosted n8n container only"
      : assistant
        ? "Companions are ready; n8n configuration remains operator-owned"
      : openAiApi
      ? "For local OpenAI-compatible clients"
      : codexChat
        ? "For trusted local backends or development servers only"
        : "For trusted native Codex clients only",
    stack
      ? "Use the displayed local n8n URL on this computer. Open the public ngrok URL in an anonymous browser first: it must reject access until you enter the Basic Auth credentials you provided. This is not an n8n or inspector host-port publication. Export needed workflows and credentials first. Remove only this owned disposable stack with the separate confirmation; existing n8n deployments remain untouched."
      : sidecar
      ? "Set the base URL to http://n8n-openai-oauth:10531/v1, use local-only as the API key placeholder, and enable the Responses API. Host publication is None. This bridge is unofficial and installs neither AI Assistant Code Sandbox nor SearXNG."
      : assistant
        ? result.includeSearxng
          ? "Code Sandbox and SearXNG JSON search were verified with no host publication. Merge instance-ai into any existing N8N_ENABLED_MODULES value, apply the copied settings, and restart n8n yourself. The privileged runner is for local development and testing; use Daytona for production."
          : "Code Sandbox was verified with no host publication; SearXNG was not installed. Merge instance-ai into any existing N8N_ENABLED_MODULES value, apply the copied settings, and restart n8n yourself. The privileged runner is for local development and testing; use Daytona for production."
      : openAiApi
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
  const originalLabel = button.getAttribute("aria-label");
  const originalTitle = button.getAttribute("title");
  button.setAttribute("aria-label", `${button.dataset.copyLabel} copied`);
  button.setAttribute("title", `${button.dataset.copyLabel} copied`);
  button.classList.add("copied");
  window.setTimeout(() => {
    if (originalLabel) {
      button.setAttribute("aria-label", originalLabel);
    }
    if (originalTitle) {
      button.setAttribute("title", originalTitle);
    }
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
    const sidecar = isN8nSidecar(state.target);
    const assistant = isN8nAssistant(state.target);
    const stack = isN8nStack(state.target);
    const n8nTarget = sidecar || assistant;
    if (
      n8nTarget &&
      ((!assistant && !state.n8nOAuthExists) ||
        element("n8n-container").value === "" ||
        element("n8n-network").value === "")
    ) {
      throw new Error(
        assistant
          ? "Choose a running n8n container and shared Docker network."
          : "Choose a running n8n container and shared Docker network, then complete local ChatGPT sign-in.",
      );
    }
    const result = await api("/api/local/plan", {
      method: "POST",
      body: stack
        ? {
            target: state.target,
            ngrokHostname: element("ngrok-hostname").value,
            n8nPort: element("n8n-stack-port").value,
            ngrokInspectorPort: element("ngrok-inspector-port").value,
            timezone: element("n8n-stack-timezone").value,
            assistantMode: element("n8n-stack-assistant-mode").value,
          }
        : n8nTarget
        ? {
            target: state.target,
            n8nContainerId: element("n8n-container").value,
            dockerNetworkId: element("n8n-network").value,
            ...(assistant
              ? {
                  includeSearxng: element("include-local-searxng").checked,
                }
              : {}),
          }
        : {
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
    setMessage(
      stack
        ? "Review the exact new owned n8n + ngrok plan. Nothing has been written or exposed yet."
        : n8nTarget
        ? "Review the exact Docker-network-only plan. Nothing has been written yet."
        : "Review the exact loopback plan. Nothing has been written yet.",
    );
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
element("include-local-searxng").addEventListener("change", invalidatePlan);
for (const id of ["ngrok-hostname", "n8n-stack-port", "ngrok-inspector-port", "n8n-stack-timezone", "n8n-stack-assistant-mode"]) {
  element(id).addEventListener("input", invalidatePlan);
  element(id).addEventListener("change", invalidatePlan);
}
element("n8n-container").addEventListener("change", () => {
  element("n8n-network").value = "";
  renderSidecarNetworkOptions();
});
element("n8n-network").addEventListener("change", () => {
  renderSidecarNetworkOptions();
});

element("n8n-discovery-refresh").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  clearError();
  setBusy(button, true, "Refreshing n8n…");
  try {
    await refreshN8nDiscovery();
    setMessage("Running n8n containers and their existing Docker networks were refreshed read-only.");
  } catch (error) {
    state.n8nDiscoveryLoaded = false;
    showError(error);
  } finally {
    setBusy(button, false);
  }
});

element("n8n-oauth-refresh").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  clearError();
  setBusy(button, true, "Refreshing sign-in…");
  try {
    await refreshN8nOAuthStatus({ announce: true });
  } catch (error) {
    showError(error);
  } finally {
    setBusy(button, false);
  }
});

element("n8n-oauth-sign-in").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  const link = element("n8n-oauth-link");
  const generation = state.n8nOAuthGeneration + 1;
  state.n8nOAuthGeneration = generation;
  state.n8nOAuthExists = false;
  updateReviewAvailability();
  const loginWindow = window.open("about:blank", "_blank");
  if (loginWindow) loginWindow.opener = null;
  let navigated = false;
  clearError();
  link.hidden = true;
  link.removeAttribute("href");
  setBusy(button, true, "Waiting for ChatGPT…");
  setMessage("Preparing a fresh local ChatGPT sign-in. Existing credentials change only after sign-in succeeds.");
  try {
    const result = await api("/api/oauth/login", {
      method: "POST",
      body: {},
    });
    const authorizationUrl = validateOAuthAuthorizationUrl(result.authorizationUrl);
    const attemptId = validateOAuthAttemptId(result.attemptId);
    if (state.n8nOAuthGeneration !== generation) return;
    link.href = authorizationUrl;
    link.hidden = false;
    if (loginWindow) {
      loginWindow.location.replace(authorizationUrl);
      navigated = true;
    }
    element("n8n-oauth-status").textContent =
      "Waiting for the fresh ChatGPT sign-in to finish…";
    setMessage("Complete ChatGPT sign-in in the newly opened official OpenAI page.");
    await waitForN8nOAuth(attemptId, generation);
    if (state.n8nOAuthGeneration !== generation) return;
    link.hidden = true;
    link.removeAttribute("href");
    await refreshN8nOAuthStatus({ announce: true });
  } catch (error) {
    if (loginWindow && !navigated) loginWindow.close();
    if (state.n8nOAuthGeneration === generation) {
      element("n8n-oauth-status").textContent =
        "ChatGPT sign-in did not complete. Start a fresh sign-in or refresh status.";
      showError(error);
    }
  } finally {
    if (state.n8nOAuthGeneration === generation) {
      setBusy(button, false);
    }
  }
});

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
  const stack = isN8nStack(state.plan?.target);
  const stackSecretInputs = [
    element("ngrok-authtoken"),
    element("ngrok-basic-auth-username"),
    element("ngrok-basic-auth-password"),
  ];
  clearError();
  if (!state.planId || !state.plan || !element("install-confirm").checked) {
    showStep(1);
    showError(new Error("Review and confirm a fresh local plan first."));
    return;
  }
  if (state.plan.target === "openai-api" && !apiKeyInput.reportValidity()) {
    return;
  }
  if (stack && stackSecretInputs.some((input) => !input.reportValidity())) {
    return;
  }
  const requestBody = {
    planId: state.planId,
    confirmed: element("install-confirm").checked,
    ...(state.plan.target === "openai-api"
      ? { apiKey: apiKeyInput.value }
      : {}),
    ...(stack
      ? {
          ngrokAuthtoken: stackSecretInputs[0].value,
          basicAuthUsername: stackSecretInputs[1].value,
          basicAuthPassword: stackSecretInputs[2].value,
        }
      : {}),
  };
  apiKeyInput.value = "";
  for (const input of stackSecretInputs) input.value = "";
  setBusy(button, true, "Installing locally…");
  setMessage(
    stack
      ? "Creating and verifying the new owned n8n stack and authenticated ngrok endpoint…"
      : isN8nSidecar(state.plan.target)
      ? "Creating and verifying only the private Docker-network sidecar…"
      : isN8nAssistant(state.plan.target)
        ? "Creating and verifying the private Code Sandbox and selected SearXNG option…"
      : "Building and verifying the loopback-only Docker container…",
  );
  try {
    const result = await api("/api/local/install", {
      method: "POST",
      body: requestBody,
    });
    renderInstallResult(result);
    state.planId = null;
    showStep(4);
    setMessage(
      result.target === "local-n8n-stack"
        ? "New local n8n stack verified. The public ngrok URL is protected by mandatory Basic Auth."
        : result.target === "n8n-openai-oauth"
        ? "Private n8n bridge verified with no host publication. Configure its private URL in n8n."
        : result.target === "n8n-ai-assistant"
          ? "Code Sandbox companions verified with no host publication. Copy the one-time n8n settings before leaving this page."
        : result.target === "openai-api"
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
    requestBody.ngrokAuthtoken = undefined;
    requestBody.basicAuthUsername = undefined;
    requestBody.basicAuthPassword = undefined;
    apiKeyInput.value = "";
    for (const input of stackSecretInputs) {
      input.value = "";
      input.disabled = true;
    }
    element("n8n-stack-secrets").hidden = true;
    setBusy(button, false);
  }
});

element("remove-bridge-confirm").addEventListener("change", (event) => {
  element("remove-bridge-button").disabled = !event.currentTarget.checked;
});

element("remove-bridge-button").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  const confirmation = element("remove-bridge-confirm");
  clearError();
  if (
    state.installedTarget !== "n8n-openai-oauth" ||
    !confirmation.checked
  ) {
    showError(new Error("Confirm removal of this managed bridge first."));
    return;
  }

  let removed = false;
  setBusy(button, true, "Removing bridge…");
  setMessage("Removing only Relmio-owned bridge resources. n8n and its external network remain untouched.");
  try {
    const result = await api("/api/local/n8n/remove", {
      method: "POST",
      body: { confirmed: true },
    });
    if (result.target !== "n8n-openai-oauth" || result.removed !== true) {
      throw new Error("The local wizard returned an unexpected removal response.");
    }
    removed = true;
    state.installedTarget = null;
    confirmation.disabled = true;
    element("install-result-list").hidden = true;
    element("client-warning").hidden = true;
    element("done-title").textContent = "Private n8n bridge was removed";
    element("done-detail").textContent =
      "Relmio removed only its sidecar, private auth volume, and managed files. n8n and the external Docker network were left unchanged.";
    element("remove-bridge-status").textContent =
      "Bridge removed. The selected n8n container and external Docker network were not changed.";
    setMessage("Private n8n bridge removed; n8n and its external Docker network remain unchanged.");
  } catch (error) {
    showError(error);
  } finally {
    setBusy(button, false);
    if (removed) button.disabled = true;
  }
});

element("remove-assistant-confirm").addEventListener("change", (event) => {
  element("remove-assistant-button").disabled = !event.currentTarget.checked;
});

element("remove-assistant-button").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  const confirmation = element("remove-assistant-confirm");
  clearError();
  if (
    state.installedTarget !== "n8n-ai-assistant" ||
    !confirmation.checked
  ) {
    showError(new Error("Confirm removal of these managed Assistant tools first."));
    return;
  }

  let removed = false;
  setBusy(button, true, "Removing Assistant tools…");
  setMessage(
    "Removing only Relmio-owned Code Sandbox and optional SearXNG resources. n8n and its external network remain untouched.",
  );
  try {
    const result = await api("/api/local/n8n/assistant/remove", {
      method: "POST",
      body: { confirmed: true },
    });
    if (result.target !== "n8n-ai-assistant" || result.removed !== true) {
      throw new Error("The local wizard returned an unexpected removal response.");
    }
    removed = true;
    state.installedTarget = null;
    element("result-sandbox-key").textContent = "";
    element("result-n8n-settings").textContent = "";
    confirmation.disabled = true;
    element("install-result-list").hidden = true;
    element("client-warning").hidden = true;
    element("done-title").textContent = "n8n Assistant tools were removed";
    element("done-detail").textContent =
      "Relmio removed only its Code Sandbox, optional SearXNG, private TLS volume, and managed files. n8n and the external Docker network were left unchanged.";
    element("remove-assistant-status").textContent =
      "Assistant tools removed. The selected n8n container and external Docker network were not changed.";
    setMessage(
      "Managed n8n Assistant tools removed; n8n and its external Docker network remain unchanged.",
    );
  } catch (error) {
    showError(error);
  } finally {
    setBusy(button, false);
    if (removed) button.disabled = true;
  }
});

element("remove-n8n-stack-confirm").addEventListener("change", (event) => {
  element("remove-n8n-stack-button").disabled = !event.currentTarget.checked;
});

element("remove-n8n-stack-button").addEventListener("click", async (event) => {
  const button = event.currentTarget;
  const confirmation = element("remove-n8n-stack-confirm");
  clearError();
  if (state.installedTarget !== "local-n8n-stack" || !confirmation.checked) {
    showError(new Error("Confirm removal of this owned n8n + ngrok stack first."));
    return;
  }
  let removed = false;
  setBusy(button, true, "Removing owned stack…");
  setMessage("Removing only Relmio-owned n8n + ngrok resources. Existing n8n deployments remain untouched.");
  try {
    const result = await api("/api/local/n8n/stack/remove", {
      method: "POST",
      body: { confirmed: true },
    });
    if (result.target !== "local-n8n-stack" || result.removed !== true) {
      throw new Error("The local wizard returned an unexpected removal response.");
    }
    removed = true;
    state.installedTarget = null;
    confirmation.disabled = true;
    element("install-result-list").hidden = true;
    element("client-warning").hidden = true;
    element("done-title").textContent = "New local n8n + ngrok was removed";
    element("done-detail").textContent =
      "Relmio removed only its owned stack. Existing n8n deployments were not changed.";
    element("remove-n8n-stack-status").textContent =
      "Owned stack removed. Existing n8n deployments were not changed.";
    setMessage("Owned local n8n + ngrok stack removed; existing n8n deployments remain untouched.");
  } catch (error) {
    showError(error);
  } finally {
    setBusy(button, false);
    if (removed) button.disabled = true;
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
    if (isN8nStack(state.plan?.target)) {
      element("n8n-stack-secrets").hidden = true;
      for (const id of ["ngrok-authtoken", "ngrok-basic-auth-username", "ngrok-basic-auth-password"]) {
        element(id).value = "";
        element(id).disabled = true;
      }
    }
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
    state.dockerAvailable = false;
    indicator.classList.remove("ready");
    element("docker-status-title").textContent = "Sanitized preview mode";
    element("docker-status-detail").textContent =
      "Local Docker discovery and installation are disabled in this preview.";
    reviewButton.disabled = true;
    setMessage("Preview mode shows the flow without accessing local Docker or credentials.");
    return;
  }
  if (result.unsupportedPlatform === true) {
    state.dockerAvailable = false;
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
    updateReviewAvailability();
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

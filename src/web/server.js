import { randomUUID, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import packageManifest from "../../package.json" with { type: "json" };

import { discoverN8n, discoverNetworks } from "../services/discovery.js";
import { installSidecar } from "../services/installer.js";
import { installAssistant } from "../services/assistant-installer.js";
import {
  getAuthStatus,
  readAuthContents,
  startOAuthLogin,
} from "../services/oauth.js";
import {
  connectVerified,
  scanHostFingerprint,
} from "../infrastructure/ssh.js";
import {
  validateHostname,
  validatePort,
} from "../domain/validation.js";
import { SIDECAR_HOSTNAME } from "../domain/templates.js";
import {
  ASSISTANT_ROOT,
} from "../domain/assistant.js";
import {
  createLocalDeploymentPlan,
  validateLocalTarget,
} from "../domain/local-endpoints.js";
import {
  LOCAL_N8N_SIDECAR_ENDPOINT,
  LOCAL_N8N_SIDECAR_TARGET,
  createLocalN8nSidecarPlan,
} from "../domain/local-n8n-sidecar.js";
import {
  acquireLocalEndpointChangeLock,
  activateLocalClientCredentialRotation,
  attestLocalCodexInstallation,
  getLocalDockerStatus,
  installLocalEndpoint,
  resolveLocalInstallRoot,
  restartLocalCodex,
  prepareLocalClientCredentialRotation,
} from "../services/local-installer.js";
import {
  discoverLocalN8nSidecarTargets,
  installLocalN8nSidecar,
  removeLocalN8nSidecar,
} from "../services/local-n8n-sidecar-installer.js";
import { startCodexDeviceLogin } from "../services/codex-login.js";
import { createLocalChatTestService } from "../services/local-chat-test.js";

const MAX_BODY_BYTES = 32 * 1024;
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const RATE_LIMIT_MAX = 10;
const OAUTH_SHUTDOWN_WAIT_MS = 2_000;
const LOCAL_ROTATION_STAGE_TTL_MS = 2 * 60 * 1000;
const PACKAGE_VERSION = packageManifest.version;

async function getProjectMeta({ fetchImpl = fetch } = {}) {
  let stars = null;
  try {
    const response = await fetchImpl(
      "https://api.github.com/repos/Demonbane18/relmio",
      {
        headers: {
          Accept: "application/vnd.github+json",
          "User-Agent": `relmio/${PACKAGE_VERSION}`,
        },
        redirect: "error",
        signal: AbortSignal.timeout(5_000),
      },
    );
    if (response.ok) {
      const value = (await response.json())?.stargazers_count;
      if (Number.isSafeInteger(value) && value >= 0) {
        stars = value;
      }
    }
  } catch {
    // The local control keeps a visible fallback when GitHub is unavailable.
  }
  return { stars, version: PACKAGE_VERSION };
}

const defaultServices = {
  getAuthStatus,
  readAuthContents,
  startOAuthLogin,
  scanHostFingerprint,
  connectVerified,
  discoverN8n,
  discoverNetworks,
  installSidecar,
  installAssistant,
  attestLocalCodexInstallation,
  getLocalDockerStatus,
  discoverLocalN8nSidecarTargets,
  getProjectMeta,
  installLocalEndpoint,
  installLocalN8nSidecar,
  prepareLocalN8nSidecarPlan: createLocalN8nSidecarPlan,
  removeLocalN8nSidecar,
  acquireLocalEndpointChangeLock,
  activateLocalClientCredentialRotation,
  prepareLocalClientCredentialRotation,
  resolveLocalInstallRoot,
  restartLocalCodex,
  startCodexDeviceLogin,
  createLocalChatTestService,
};

function setSecurityHeaders(response) {
  response.setHeader(
    "Content-Security-Policy",
    "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
  );
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader(
    "Permissions-Policy",
    "camera=(), microphone=(), geolocation=()",
  );
  response.setHeader("Cache-Control", "no-store");
}

function sendJson(response, statusCode, body) {
  const contents = JSON.stringify(body);
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(contents),
  });
  response.end(contents);
}

function requestAcceptsEventStream(request) {
  const value = request.headers.accept;
  return (
    typeof value === "string" &&
    value
      .split(",")
      .some((entry) => entry.trim().split(";", 1)[0] === "text/event-stream")
  );
}

function startLocalChatTestStream(response) {
  let ended = false;
  response.writeHead(200, {
    "Content-Encoding": "none",
    "Content-Type": "text/event-stream; charset=utf-8",
    "X-Accel-Buffering": "no",
    "X-Relmio-Stream": "v1",
  });
  const send = (event, data) => {
    if (ended || response.writableEnded || response.destroyed) return;
    response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const keepalive = setInterval(() => {
    if (!ended && !response.writableEnded && !response.destroyed) {
      response.write(": keepalive\n\n");
    }
  }, 15_000);
  keepalive.unref?.();
  send("start", { requestId: randomUUID() });
  return {
    send(event, data) {
      if (event === "progress" || event === "delta") send(event, data);
    },
    complete(result) {
      if (ended) return;
      send("terminal", {
        outcome: "completed",
        conversationId: result.conversationId,
      });
      ended = true;
      clearInterval(keepalive);
      response.end();
    },
    fail(code = "upstream_failed") {
      if (ended) return;
      send("error", { code, retryable: true });
      send("terminal", { outcome: "failed" });
      ended = true;
      clearInterval(keepalive);
      response.end();
    },
    dispose() {
      ended = true;
      clearInterval(keepalive);
    },
  };
}

function tokenMatches(actual, expected) {
  if (typeof actual !== "string") {
    return false;
  }
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function requireApiToken(request, state) {
  if (!tokenMatches(request.headers["x-setup-token"], state.sessionToken)) {
    throw Object.assign(new Error("Unauthorized."), { statusCode: 401 });
  }
}

function requireSameOrigin(request, state) {
  if (request.method === "POST" && request.headers.origin !== state.origin) {
    throw Object.assign(new Error("Cross-origin request rejected."), {
      statusCode: 403,
    });
  }
}

function enforceRateLimit(state, key) {
  const now = Date.now();
  const previous = state.rateLimits.get(key) ?? [];
  const recent = previous.filter((time) => now - time < RATE_LIMIT_WINDOW_MS);
  if (recent.length >= RATE_LIMIT_MAX) {
    throw Object.assign(
      new Error("Too many attempts. Wait a few minutes and try again."),
      { statusCode: 429 },
    );
  }
  recent.push(now);
  state.rateLimits.set(key, recent);
}

function waitForBoundedResult(promise, milliseconds) {
  if (!promise) {
    return Promise.resolve(true);
  }
  return new Promise((resolvePromise) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (!settled) {
        settled = true;
        resolvePromise(false);
      }
    }, milliseconds);
    Promise.resolve(promise).then(
      () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolvePromise(true);
        }
      },
      () => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          resolvePromise(true);
        }
      },
    );
  });
}

function readJsonBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let tooLarge = false;

    request.on("data", (chunk) => {
      bytes += chunk.length;
      if (bytes > MAX_BODY_BYTES) {
        tooLarge = true;
        return;
      }
      chunks.push(Buffer.from(chunk));
    });
    request.once("error", () => {
      reject(new Error("The request body could not be read."));
    });
    request.once("end", () => {
      if (tooLarge) {
        reject(
          Object.assign(new Error("The request body is too large."), {
            statusCode: 413,
          }),
        );
        return;
      }

      try {
        const text = Buffer.concat(chunks).toString("utf8");
        resolve(text === "" ? {} : JSON.parse(text));
      } catch {
        reject(
          Object.assign(new Error("The request body must be valid JSON."), {
            statusCode: 400,
          }),
        );
      }
    });
  });
}

function requireConnection(state) {
  if (!state.connection) {
    throw new Error("Connect to the VPS first.");
  }
  return state.connection;
}

function rejectActiveVpsMutation(state) {
  if (state.closing) {
    throw Object.assign(new Error("The local wizard is closing."), {
      statusCode: 409,
    });
  }
  if (state.vpsMutationInFlight) {
    throw Object.assign(
      new Error("A VPS installation is already in progress. Wait for it to finish before trying another installation."),
      { statusCode: 409 },
    );
  }
}

function acquireVpsMutationLock(state) {
  rejectActiveVpsMutation(state);
  const lock = Symbol("vps-mutation");
  let resolveCompletion;
  state.vpsMutationInFlight = true;
  state.vpsMutationLock = lock;
  state.vpsMutationCompletion = new Promise((resolve) => {
    resolveCompletion = resolve;
  });
  return () => {
    if (state.vpsMutationLock === lock) {
      state.vpsMutationInFlight = false;
      state.vpsMutationLock = null;
      state.vpsMutationCompletion = null;
      resolveCompletion();
    }
  };
}

function requireReviewedVpsPlan(plan, body, label) {
  if (
    !plan ||
    plan.containerName !== body.containerName ||
    plan.networkName !== body.networkName
  ) {
    throw new Error(`Review a fresh ${label} plan before installing.`);
  }
}

function requireAssistantSearxngSelection(value) {
  if (typeof value !== "boolean") {
    throw new Error("Choose whether to include optional SearXNG web search.");
  }
  return value;
}

function requireEnabledInstanceAi(state, containerName) {
  const instanceAi = state.networksByContainer.get(containerName)?.instanceAi;
  if (instanceAi?.status === "enabled") return instanceAi;
  if (instanceAi?.status === "missing" || instanceAi?.status === "configured") {
    throw new Error(
      "The selected n8n container needs N8N_ENABLED_MODULES to include instance-ai. Update its existing deployment separately; restart n8n outside this wizard only if you later authorize that action.",
    );
  }
  throw new Error("The selected n8n container's AI Assistant prerequisite could not be verified.");
}

function requireReviewedAssistantPlan(state, plan, body) {
  requireReviewedVpsPlan(plan, body, "AI Assistant");
  if (plan.includeSearxng !== body.includeSearxng) {
    throw new Error("Review a fresh AI Assistant plan for the selected web-search option.");
  }
  const instanceAi = requireEnabledInstanceAi(state, body.containerName);
  if (plan.instanceAi?.status !== instanceAi.status) {
    throw new Error("Review a fresh AI Assistant plan after prerequisite discovery.");
  }
}

function requireFreshAssistantInstallState(plan, networks, body) {
  if (!Array.isArray(networks?.networks) || !networks.networks.includes(body.networkName)) {
    throw new Error(
      "The selected Docker network changed after plan review. Review a fresh AI Assistant plan before installing.",
    );
  }
  const instanceAi = networks.instanceAi;
  if (instanceAi?.status !== "enabled") {
    throw new Error(
      "The selected n8n container needs N8N_ENABLED_MODULES to include instance-ai. Update its existing deployment separately; restart n8n outside this wizard only if you later authorize that action.",
    );
  }
  if (plan.instanceAi?.status !== instanceAi.status) {
    throw new Error("Review a fresh AI Assistant plan after prerequisite discovery.");
  }
}

function requireDiscoveredContainer(state, containerName) {
  const container = state.discovery?.containers.find(
    (candidate) => candidate.name === containerName,
  );
  if (!container) {
    throw new Error("Select an n8n container found by this wizard.");
  }
  return container;
}

function requireDiscoveredNetwork(state, containerName, networkName) {
  requireDiscoveredContainer(state, containerName);
  const networks = state.networksByContainer.get(containerName)?.networks ?? [];
  if (!networks.includes(networkName)) {
    throw new Error("Select a Docker network found by this wizard.");
  }
  return networkName;
}

function safeErrorMessage(error) {
  const message =
    typeof error?.safeMessage === "string"
      ? error.safeMessage
      : typeof error?.message === "string"
        ? error.message
        : "Request failed.";
  if (
    message.length > 240 ||
    /[\r\n]/u.test(message) ||
    /(?:access|refresh)[_-]?token|private[_-]?key|\bsk-[A-Za-z0-9_-]{8,}|\bBearer\s+\S+|\/(?:Users|home|private|tmp|var|opt|docker)\/|[A-Za-z]:\\/iu.test(
      message,
    )
  ) {
    return "The request could not be completed safely.";
  }
  return message;
}

async function cancelOAuthLogin(state, login) {
  try {
    await login.attempt.cancel();
  } catch {
    if (state.oauthLogin === login) {
      login.status = "error";
      login.retryBlocked = true;
      login.error =
        "ChatGPT sign-in could not be stopped safely. Close the sign-in helper, then restart Relmio.";
    }
    state.oauthRetryBlocked = true;
    state.oauthStartupError =
      "ChatGPT sign-in could not be stopped safely. Close the sign-in helper, then restart Relmio.";
    throw Object.assign(
      new Error(
        "ChatGPT sign-in could not be stopped safely. Close the sign-in helper, then restart Relmio.",
      ),
      { retryBlocked: true, statusCode: 409 },
    );
  }

  if (state.oauthLogin === login && login.status === "pending") {
    login.status = "cancelled";
  }
}

async function loadDefaultUiFiles() {
  const files = await Promise.all([
    readFile(new URL("../ui/index.html", import.meta.url), "utf8"),
    readFile(new URL("../ui/local.html", import.meta.url), "utf8"),
    readFile(new URL("../ui/app.js", import.meta.url), "utf8"),
    readFile(new URL("../ui/local.js", import.meta.url), "utf8"),
    readFile(new URL("../ui/oauth-popup.js", import.meta.url), "utf8"),
    readFile(new URL("../ui/assistant.html", import.meta.url), "utf8"),
    readFile(new URL("../ui/assistant.js", import.meta.url), "utf8"),
    readFile(new URL("../ui/assistant.css", import.meta.url), "utf8"),
    readFile(new URL("../ui/theme.js", import.meta.url), "utf8"),
    readFile(new URL("../ui/time.js", import.meta.url), "utf8"),
    readFile(new URL("../ui/styles.css", import.meta.url), "utf8"),
    readFile(new URL("../ui/local.css", import.meta.url), "utf8"),
    readFile(new URL("../ui/icons/monitor.svg", import.meta.url), "utf8"),
    readFile(new URL("../ui/icons/sun.svg", import.meta.url), "utf8"),
    readFile(new URL("../ui/icons/moon.svg", import.meta.url), "utf8"),
    readFile(new URL("../ui/relmio-icon.png", import.meta.url)),
    readFile(new URL("../ui/relmio-icon-rounded.svg", import.meta.url), "utf8"),
  ]);

  return {
    "/": files[0],
    "/local": files[1].replaceAll("__RELMIO_PACKAGE_VERSION__", PACKAGE_VERSION),
    "/app.js": files[2],
    "/local.js": files[3],
    "/oauth-popup.js": files[4],
    "/assistant": files[5],
    "/assistant.js": files[6],
    "/assistant.css": files[7],
    "/theme.js": files[8],
    "/time.js": files[9],
    "/styles.css": files[10],
    "/local.css": files[11],
    "/icons/monitor.svg": files[12],
    "/icons/sun.svg": files[13],
    "/icons/moon.svg": files[14],
    "/relmio-icon.png": files[15],
    "/relmio-icon-rounded.svg": files[16],
  };
}

function createSafeLocalPlan(plan) {
  return {
    target: plan.target,
    label: plan.label,
    bindHost: plan.bindHost,
    port: plan.port,
    endpoint: plan.endpoint,
    protocol: plan.protocol,
    upstreamAuth: plan.upstreamAuth,
    allowedOrigins: [...plan.allowedOrigins],
    browserClients: plan.browserClients,
    experimental: plan.experimental,
    managedPath: plan.managedPath,
  };
}

function createSafeLocalInstallResult(result) {
  return {
    target: result.target,
    endpoint: result.endpoint,
    protocol: result.protocol,
    clientCredential: result.clientCredential,
    credentialShownOnce: result.credentialShownOnce === true,
    models: Array.isArray(result.models) ? [...result.models] : [],
    deploymentMode: result.deploymentMode,
    experimental: result.experimental === true,
    browserClients: result.browserClients === true,
  };
}

function createSafeLocalActivationResult(result) {
  return {
    target: result.target,
    endpoint: result.endpoint,
    protocol: result.protocol,
    models: Array.isArray(result.models) ? [...result.models] : [],
    deploymentMode: result.deploymentMode,
    experimental: result.experimental === true,
    browserClients: result.browserClients === true,
  };
}

function createSafeProjectMeta(result) {
  return {
    stars:
      Number.isSafeInteger(result?.stars) && result.stars >= 0
        ? result.stars
        : null,
    version: PACKAGE_VERSION,
  };
}

function createSafeLocalChatTestKey(result) {
  if (
    !result ||
    typeof result !== "object" ||
    Array.isArray(result) ||
    typeof result.keyId !== "string" ||
    result.keyId.length === 0 ||
    result.keyId.length > 128 ||
    !result.publicKeyJwk ||
    typeof result.publicKeyJwk !== "object" ||
    Array.isArray(result.publicKeyJwk) ||
    result.publicKeyJwk.kty !== "RSA" ||
    typeof result.publicKeyJwk.n !== "string" ||
    typeof result.publicKeyJwk.e !== "string" ||
    result.publicKeyJwk.n.length === 0 ||
    result.publicKeyJwk.n.length > 1_024 ||
    result.publicKeyJwk.e.length === 0 ||
    result.publicKeyJwk.e.length > 32 ||
    result.algorithm !== "RSA-OAEP-256" ||
    typeof result.expiresAt !== "string" ||
    Number.isNaN(Date.parse(result.expiresAt))
  ) {
    throw Object.assign(new Error("The local tester could not start safely."), {
      statusCode: 502,
    });
  }
  return {
    keyId: result.keyId,
    publicKeyJwk: {
      kty: "RSA",
      n: result.publicKeyJwk.n,
      e: result.publicKeyJwk.e,
    },
    algorithm: result.algorithm,
    expiresAt: result.expiresAt,
  };
}

function createSafeLocalChatTestResponse(result) {
  if (
    !result ||
    typeof result !== "object" ||
    Array.isArray(result) ||
    typeof result.conversationId !== "string" ||
    result.conversationId.length === 0 ||
    result.conversationId.length > 160 ||
    typeof result.output !== "string" ||
    result.output.length === 0 ||
    result.output.length > 12 * 1_024
  ) {
    throw Object.assign(
      new Error("The local adapter returned an unexpected response."),
      { statusCode: 502 },
    );
  }
  return {
    conversationId: result.conversationId,
    output: result.output,
  };
}

function getPendingLocalCredentialRotation(state) {
  if (
    state.localCredentialRotationPending &&
    state.localCredentialRotationPending.expiresAt <= Date.now()
  ) {
    state.localCredentialRotationPending = null;
  }
  return state.localCredentialRotationPending;
}

function createSafeDockerStatus(status, previewMode) {
  if (previewMode || status?.dockerAvailable !== true) {
    return {
      dockerAvailable: false,
      ...(previewMode ? { previewMode: true } : {}),
      ...(!previewMode && status?.unsupportedPlatform === true
        ? { unsupportedPlatform: true }
        : {}),
    };
  }
  return {
    dockerAvailable: true,
    dockerVersion: status.dockerVersion,
    composeVersion: status.composeVersion,
  };
}

function requireSafeDockerIdentifier(value, label) {
  if (typeof value !== "string" || !/^[a-f0-9]{12,64}$/u.test(value)) {
    throw Object.assign(new Error(`The discovered ${label} is invalid.`), {
      statusCode: 502,
    });
  }
  return value;
}

function requireSafeDockerName(value, label) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 128 ||
    !/^[A-Za-z0-9][A-Za-z0-9_.-]*$/u.test(value)
  ) {
    throw Object.assign(new Error(`The discovered ${label} is invalid.`), {
      statusCode: 502,
    });
  }
  return value;
}

function requireSafeDisplayValue(value, label, maximumLength = 512) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > maximumLength ||
    /[\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw Object.assign(new Error(`The discovered ${label} is invalid.`), {
      statusCode: 502,
    });
  }
  return value;
}

function createSafeLocalN8nDiscovery(discovery, previewMode) {
  if (previewMode) {
    return {
      dockerAvailable: false,
      previewMode: true,
      containers: [],
    };
  }
  if (discovery?.dockerAvailable !== true) {
    return { dockerAvailable: false, containers: [] };
  }
  if (!Array.isArray(discovery.containers)) {
    throw Object.assign(
      new Error("The local n8n discovery response is invalid."),
      { statusCode: 502 },
    );
  }
  return {
    dockerAvailable: true,
    ...(typeof discovery.dockerVersion === "string"
      ? {
          dockerVersion: requireSafeDisplayValue(
            discovery.dockerVersion,
            "Docker version",
            80,
          ),
        }
      : {}),
    ...(typeof discovery.composeVersion === "string"
      ? {
          composeVersion: requireSafeDisplayValue(
            discovery.composeVersion,
            "Compose version",
            80,
          ),
        }
      : {}),
    containers: discovery.containers.map((container) => {
      if (!Array.isArray(container?.networks)) {
        throw Object.assign(
          new Error("The discovered n8n network list is invalid."),
          { statusCode: 502 },
        );
      }
      return {
        containerId: requireSafeDockerIdentifier(
          container.containerId,
          "n8n container ID",
        ),
        containerName: requireSafeDockerName(
          container.containerName,
          "n8n container name",
        ),
        image: requireSafeDisplayValue(container.image, "n8n image"),
        networks: container.networks.map((network) => ({
          dockerNetworkId: requireSafeDockerIdentifier(
            network?.dockerNetworkId,
            "Docker network ID",
          ),
          networkName: requireSafeDockerName(
            network?.networkName,
            "Docker network name",
          ),
          disposable: network?.disposable === true,
        })),
      };
    }),
  };
}

function createSafeLocalN8nPlan(plan) {
  return {
    kind: plan.kind,
    target: plan.target,
    label: plan.label,
    n8nContainerId: plan.n8nContainerId,
    n8nContainerName: plan.n8nContainerName,
    dockerNetworkId: plan.dockerNetworkId,
    networkName: plan.networkName,
    endpoint: plan.endpoint,
    upstreamAuth: plan.upstreamAuth,
    hostPublication: plan.hostPublication,
    managedPath: plan.managedPath,
    disposableHarnessWarning: plan.disposableHarnessWarning === true,
  };
}

function createSafeLocalN8nInstallResult(result) {
  const endpoint = result?.endpoint ?? result?.baseUrl;
  const models = result?.models;
  if (
    result?.target !== LOCAL_N8N_SIDECAR_TARGET ||
    endpoint !== LOCAL_N8N_SIDECAR_ENDPOINT ||
    result.protocol !== "openai-v1" ||
    result.apiKeyPlaceholder !== "local-only" ||
    !Array.isArray(models) ||
    models.some(
      (model) =>
        typeof model !== "string" ||
        model.length === 0 ||
        model.length > 128 ||
        !/^[A-Za-z0-9_.:-]+$/u.test(model),
    ) ||
    result.deploymentMode !== "installed" ||
    typeof result.networkName !== "string" ||
    result.hostPublication !== "none" ||
    result.useResponsesApi !== true ||
    result.unofficial !== true
  ) {
    throw Object.assign(
      new Error("The local n8n sidecar returned an invalid result."),
      { statusCode: 502 },
    );
  }
  return {
    target: result.target,
    endpoint,
    apiKeyPlaceholder: result.apiKeyPlaceholder,
    protocol: result.protocol,
    models: [...models],
    deploymentMode: result.deploymentMode,
    networkName: requireSafeDockerName(
      result.networkName,
      "sidecar network name",
    ),
    hostPublication: result.hostPublication,
    responsesApi: result.useResponsesApi === true,
    unofficial: result.unofficial === true,
  };
}

function createSafeLocalN8nRemovalResult(result) {
  if (
    result?.target !== LOCAL_N8N_SIDECAR_TARGET ||
    result.removed !== true
  ) {
    throw Object.assign(
      new Error("The local n8n sidecar removal result is invalid."),
      { statusCode: 502 },
    );
  }
  return {
    target: result.target,
    removed: true,
  };
}

function requireLiveLocalAction(state, action) {
  if (state.previewMode) {
    throw Object.assign(
      new Error(`${action} is disabled in sanitized preview mode.`),
      { statusCode: 403 },
    );
  }
}

function localOAuthChangeInFlight(state) {
  return (
    state.oauthLoginStartInFlight || state.oauthLogin?.status === "pending"
  );
}

function requireReadyLocalChatTester(state) {
  if (state.localInstalledTarget !== "codex-chat") {
    throw Object.assign(
      new Error("Install the Codex Chat Adapter before starting its local tester."),
      { statusCode: 409 },
    );
  }
}

async function handleApi(request, response, path, state) {
  requireApiToken(request, state);
  requireSameOrigin(request, state);

  if (request.method === "GET" && path === "/api/status") {
    const status = await state.services.getAuthStatus();
    sendJson(response, 200, {
      authExists: status.exists,
      ...(status.exists ? { authUpdatedAt: status.updatedAt } : {}),
      ...(state.previewMode ? { previewMode: true } : {}),
    });
    return;
  }

  if (request.method === "GET" && path === "/api/oauth/status") {
    const login = state.oauthLogin;
    sendJson(response, 200, {
      status: login?.status ?? (state.oauthStartupError ? "error" : "idle"),
      ...(login ? { attemptId: login.attemptId } : {}),
      ...(login?.status === "error"
        ? { error: login.error }
        : state.oauthStartupError
          ? { error: state.oauthStartupError }
          : {}),
      ...(state.oauthRetryBlocked || login?.retryBlocked === true
        ? { retryBlocked: true }
        : {}),
    });
    return;
  }

  if (request.method === "GET" && path === "/api/local/docker/status") {
    const status = state.previewMode
      ? null
      : await state.services.getLocalDockerStatus();
    sendJson(
      response,
      200,
      createSafeDockerStatus(status, state.previewMode),
    );
    return;
  }

  if (request.method === "GET" && path === "/api/local/n8n/discover") {
    const discovery = state.previewMode
      ? null
      : await state.services.discoverLocalN8nSidecarTargets();
    state.localPlan = null;
    sendJson(
      response,
      200,
      createSafeLocalN8nDiscovery(discovery, state.previewMode),
    );
    return;
  }

  if (request.method === "GET" && path === "/api/local/project-meta") {
    sendJson(
      response,
      200,
      createSafeProjectMeta(await state.services.getProjectMeta()),
    );
    return;
  }

  if (
    request.method === "GET" &&
    path === "/api/local/codex/login/status"
  ) {
    const login = state.codexLogin;
    sendJson(response, 200, {
      status: login?.status ?? "idle",
      ...(login?.status === "error" ? { error: login.error } : {}),
      ...(state.previewMode ? { previewMode: true } : {}),
    });
    return;
  }

  if (request.method !== "POST") {
    sendJson(response, 405, { error: "Method not allowed." });
    return;
  }

  if (path === "/api/oauth/login") {
    if (state.previewMode) {
      throw Object.assign(
        new Error(
          "Live ChatGPT sign-in is disabled in sanitized preview mode.",
        ),
        { statusCode: 403 },
      );
    }
    if (state.closing) {
      throw Object.assign(new Error("The local wizard is closing."), {
        statusCode: 409,
      });
    }
    if (
      state.localInstallInFlight ||
      state.localCredentialRotationInFlight ||
      getPendingLocalCredentialRotation(state)
    ) {
      throw Object.assign(
        new Error("A local endpoint change is already in progress."),
        { statusCode: 409 },
      );
    }
    if (state.oauthRetryBlocked || state.oauthLogin?.retryBlocked === true) {
      throw Object.assign(
        new Error(
          "ChatGPT sign-in could not be stopped safely. Close the sign-in helper, then restart Relmio.",
        ),
        { retryBlocked: true, statusCode: 409 },
      );
    }
    if (state.oauthLoginStartInFlight) {
      throw Object.assign(
        new Error("A ChatGPT sign-in start is already in progress."),
        { statusCode: 409 },
      );
    }
    enforceRateLimit(state, path);
    state.oauthLoginStartInFlight = true;
    state.oauthStartupError = null;
    let startAttempted = false;
    let startPromise;
    try {
      const previousLogin = state.oauthLogin;
      if (previousLogin?.status === "pending") {
        await cancelOAuthLogin(state, previousLogin);
      }

      if (state.closing) {
        throw Object.assign(new Error("The local wizard is closing."), {
          statusCode: 409,
        });
      }
      if (
        state.oauthLogin === previousLogin &&
        previousLogin?.status !== "pending" &&
        previousLogin?.retryBlocked !== true
      ) {
        state.oauthLogin = null;
      }
      startAttempted = true;
      startPromise = Promise.resolve(state.services.startOAuthLogin());
      state.oauthLoginStartPromise = startPromise;
      const attempt = await startPromise;
      const login = {
        attempt,
        attemptId: randomUUID(),
        error: null,
        retryBlocked: false,
        status: "pending",
      };
      state.oauthLogin = login;
      attempt.completion.then(
        () => {
          if (
            state.oauthLogin === login &&
            login.status === "pending" &&
            !state.closing
          ) {
            login.status = "success";
          }
        },
        (error) => {
          if (
            state.oauthLogin === login &&
            login.status === "pending" &&
            !state.closing
          ) {
            login.status = "error";
            login.error = safeErrorMessage(error);
            if (error?.retryBlocked === true) {
              login.retryBlocked = true;
              state.oauthRetryBlocked = true;
              state.oauthStartupError = login.error;
            }
          }
        },
      );
      if (state.closing) {
        try {
          await cancelOAuthLogin(state, login);
        } catch {
          // The server is already closing and must not restart this helper.
        }
        throw Object.assign(new Error("The local wizard is closing."), {
          statusCode: 409,
        });
      }
      sendJson(response, 200, {
        authorizationUrl: attempt.authorizationUrl,
        attemptId: login.attemptId,
      });
      return;
    } catch (error) {
      const message = safeErrorMessage(error);
      if (startAttempted) {
        state.oauthStartupError = message;
      }
      if (error?.retryBlocked === true) {
        state.oauthRetryBlocked = true;
        state.oauthStartupError = message;
      }
      throw error;
    } finally {
      if (state.oauthLoginStartPromise === startPromise) {
        state.oauthLoginStartPromise = null;
      }
      state.oauthLoginStartInFlight = false;
    }
  }

  const body = await readJsonBody(request);

  if (path === "/api/local/chat-test/key") {
    requireLiveLocalAction(state, "Local chat testing");
    requireReadyLocalChatTester(state);
    enforceRateLimit(state, path);
    sendJson(
      response,
      200,
      createSafeLocalChatTestKey(await state.localChatTest.issueKey()),
    );
    return;
  }

  if (path === "/api/local/chat-test/message") {
    requireLiveLocalAction(state, "Local chat testing");
    requireReadyLocalChatTester(state);
    enforceRateLimit(state, path);
    const wantsStream = requestAcceptsEventStream(request);
    const stream = wantsStream ? startLocalChatTestStream(response) : null;
    const requestController = wantsStream ? new AbortController() : null;
    const abortOnClose = () => {
      if (!response.writableEnded) requestController?.abort();
    };
    response.once("close", abortOnClose);
    try {
      const result = createSafeLocalChatTestResponse(
        await state.localChatTest.message(body, {
          ...(stream
            ? {
                onEvent: (event, data) => stream.send(event, data),
                signal: requestController.signal,
              }
            : {}),
        }),
      );
      if (stream) stream.complete(result);
      else sendJson(response, 200, result);
    } catch (error) {
      if (stream) {
        stream.fail(error?.statusCode === 504 ? "timeout" : "upstream_failed");
      } else {
        throw error;
      }
    } finally {
      response.off("close", abortOnClose);
      stream?.dispose();
      if (body && typeof body === "object") {
        body.encryptedCredential = undefined;
        body.input = undefined;
      }
    }
    return;
  }

  if (path === "/api/local/chat-test/reset") {
    requireLiveLocalAction(state, "Local chat testing");
    requireReadyLocalChatTester(state);
    enforceRateLimit(state, path);
    await state.localChatTest.reset(body);
    sendJson(response, 200, { forgotten: true });
    return;
  }

  if (path === "/api/oauth/cancel") {
    requireLiveLocalAction(state, "Live ChatGPT sign-in");
    const login = state.oauthLogin;
    if (
      !login ||
      login.status !== "pending" ||
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      typeof body.attemptId !== "string" ||
      body.attemptId !== login.attemptId
    ) {
      throw Object.assign(
        new Error("The ChatGPT sign-in attempt has already changed. Start again."),
        { statusCode: 409 },
      );
    }
    await cancelOAuthLogin(state, login);
    sendJson(response, 200, {
      status: login.status,
      attemptId: login.attemptId,
    });
    return;
  }

  if (path === "/api/local/plan") {
    let plan;
    if (body?.target === "n8n-openai-oauth") {
      requireLiveLocalAction(state, "Local n8n sidecar planning");
      if (localOAuthChangeInFlight(state)) {
        throw Object.assign(
          new Error("ChatGPT sign-in is already in progress."),
          { statusCode: 409 },
        );
      }
      const discovery = await state.services.discoverLocalN8nSidecarTargets();
      if (discovery?.dockerAvailable !== true) {
        throw new Error("Docker is unavailable for local n8n discovery.");
      }
      const container = discovery.containers?.find(
        (candidate) => candidate?.containerId === body.n8nContainerId,
      );
      if (!container) {
        throw new Error("Select a running n8n container found by this wizard.");
      }
      const network = container.networks?.find(
        (candidate) => candidate?.dockerNetworkId === body.dockerNetworkId,
      );
      if (!network) {
        throw new Error("Select a Docker network attached to that n8n container.");
      }
      const authStatus = await state.services.getAuthStatus();
      if (
        authStatus?.exists !== true ||
        typeof authStatus.updatedAt !== "string" ||
        Number.isNaN(Date.parse(authStatus.updatedAt))
      ) {
        throw new Error("Sign in with ChatGPT before reviewing this sidecar plan.");
      }
      plan = {
        ...state.services.prepareLocalN8nSidecarPlan({
          dockerHost: discovery.dockerHost,
          n8nContainerId: container.containerId,
          n8nContainerName: container.containerName,
          dockerNetworkId: network.dockerNetworkId,
          networkName: network.networkName,
          authGeneration: authStatus.updatedAt,
        }),
        disposableHarnessWarning: network.disposable === true,
      };
    } else {
      plan = createLocalDeploymentPlan({
        target: body.target,
        port: body.port,
        allowedOrigins: body.allowedOrigins,
      });
    }
    const planId = randomUUID();
    state.localPlan = { planId, plan };
    sendJson(response, 200, {
      planId,
      plan:
        plan.kind === "n8n-sidecar"
          ? createSafeLocalN8nPlan(plan)
          : createSafeLocalPlan(plan),
    });
    return;
  }

  if (path === "/api/local/install") {
    let acquiredInstallLock = false;
    try {
      requireLiveLocalAction(state, "Local endpoint installation");
      enforceRateLimit(state, path);
      if (
        state.localInstallInFlight ||
        state.localCredentialRotationInFlight ||
        getPendingLocalCredentialRotation(state) ||
        state.codexLoginStartInFlight ||
        state.codexLogin?.status === "pending" ||
        localOAuthChangeInFlight(state)
      ) {
        throw Object.assign(
          new Error("A local endpoint change is already in progress."),
          { statusCode: 409 },
        );
      }
      const pending = state.localPlan;
      if (!pending || !tokenMatches(body.planId, pending.planId)) {
        throw new Error(
          "Review a fresh local endpoint plan before installing.",
        );
      }

      state.localInstallInFlight = true;
      acquiredInstallLock = true;
      state.localPlan = null;
      state.localInstalledTarget = null;
      let result;
      if (pending.plan.kind === "n8n-sidecar") {
        const authStatus = await state.services.getAuthStatus();
        if (
          authStatus?.exists !== true ||
          typeof authStatus.path !== "string" ||
          authStatus.updatedAt !== pending.plan.authGeneration
        ) {
          throw new Error(
            "The ChatGPT sign-in changed after plan review. Review a fresh local endpoint plan before installing.",
          );
        }
        result = await state.services.installLocalN8nSidecar({
          plan: pending.plan,
          authPath: authStatus.path,
          confirmed: body.confirmed,
        });
      } else {
        result = await state.services.installLocalEndpoint({
          plan: pending.plan,
          apiKey: body.apiKey,
          confirmed: body.confirmed,
        });
      }

      state.localInstalledTarget = pending.plan.target;
      sendJson(
        response,
        200,
        pending.plan.kind === "n8n-sidecar"
          ? createSafeLocalN8nInstallResult(result)
          : createSafeLocalInstallResult(result),
      );
    } finally {
      if (acquiredInstallLock) {
        state.localInstallInFlight = false;
      }
      body.apiKey = undefined;
    }
    return;
  }

  if (path === "/api/local/n8n/remove") {
    requireLiveLocalAction(state, "Local n8n sidecar removal");
    enforceRateLimit(state, path);
    if (body?.confirmed !== true) {
      throw new Error("Confirm removal of the managed local n8n sidecar.");
    }
    if (
      state.localInstallInFlight ||
      state.localCredentialRotationInFlight ||
      getPendingLocalCredentialRotation(state) ||
      state.codexLoginStartInFlight ||
      state.codexLogin?.status === "pending" ||
      localOAuthChangeInFlight(state)
    ) {
      throw Object.assign(
        new Error("A local endpoint change is already in progress."),
        { statusCode: 409 },
      );
    }
    state.localInstallInFlight = true;
    state.localPlan = null;
    state.localInstalledTarget = null;
    try {
      const result = await state.services.removeLocalN8nSidecar({
        confirmed: true,
      });
      sendJson(response, 200, createSafeLocalN8nRemovalResult(result));
    } finally {
      state.localInstallInFlight = false;
    }
    return;
  }

  if (path === "/api/local/client-credential/rotate") {
    requireLiveLocalAction(state, "Local client credential rotation");
    enforceRateLimit(state, path);
    if (
      state.localCredentialRotationInFlight ||
      state.localInstallInFlight ||
      getPendingLocalCredentialRotation(state) ||
      state.codexLoginStartInFlight ||
      state.codexLogin?.status === "pending"
    ) {
      throw Object.assign(
        new Error("A local endpoint change is already in progress."),
        { statusCode: 409 },
      );
    }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      throw new Error("Choose the installed local endpoint before rotating its credential.");
    }

    state.localCredentialRotationInFlight = true;
    try {
      state.localChatTest.resetAll?.();
      const result = await state.services.prepareLocalClientCredentialRotation({
        target: validateLocalTarget(body.target),
      });
      const rotationId = randomUUID();
      state.localCredentialRotationPending = {
        rotationId,
        target: result.target,
        tokenSha256: result.tokenSha256,
        expiresAt: Date.now() + LOCAL_ROTATION_STAGE_TTL_MS,
      };
      sendJson(response, 200, {
        ...createSafeLocalInstallResult(result),
        rotationId,
      });
    } finally {
      state.localCredentialRotationInFlight = false;
    }
    return;
  }

  if (path === "/api/local/client-credential/activate") {
    requireLiveLocalAction(state, "Local client credential activation");
    enforceRateLimit(state, path);
    if (
      state.localCredentialRotationInFlight ||
      state.localInstallInFlight ||
      state.codexLoginStartInFlight ||
      state.codexLogin?.status === "pending"
    ) {
      throw Object.assign(
        new Error("A local endpoint change is already in progress."),
        { statusCode: 409 },
      );
    }
    const pending = getPendingLocalCredentialRotation(state);
    if (!pending || !tokenMatches(body?.rotationId, pending.rotationId)) {
      throw new Error("Stage a fresh local client credential before activating it.");
    }

    state.localCredentialRotationPending = null;
    state.localCredentialRotationInFlight = true;
    try {
      state.localChatTest.resetAll?.();
      const result = await state.services.activateLocalClientCredentialRotation({
        target: pending.target,
        clientCredential: body.clientCredential,
        tokenSha256: pending.tokenSha256,
      });
      sendJson(response, 200, createSafeLocalActivationResult(result));
    } finally {
      state.localCredentialRotationInFlight = false;
    }
    return;
  }

  if (path === "/api/local/codex/login") {
    requireLiveLocalAction(state, "Local Codex sign-in");
    enforceRateLimit(state, path);
    if (
      state.codexLoginStartInFlight ||
      state.localInstallInFlight ||
      state.localCredentialRotationInFlight ||
      getPendingLocalCredentialRotation(state)
    ) {
      throw Object.assign(
        new Error("A local endpoint change is already in progress."),
        { statusCode: 409 },
      );
    }

    const target = validateLocalTarget(body?.target ?? "codex-chatgpt");
    if (target !== "codex-chatgpt" && target !== "codex-chat") {
      throw new Error("Choose a Codex local endpoint before signing in.");
    }
    state.codexLoginStartInFlight = true;
    let finishStart;
    const startPromise = new Promise((resolvePromise) => {
      finishStart = resolvePromise;
    });
    state.codexLoginStartPromise = startPromise;
    let releaseChangeLock;
    let lockTransferred = false;
    try {
      const previous = state.codexLogin;
      if (previous?.status === "pending") {
        state.codexLogin = null;
        previous.cancel();
        try {
          await previous.completion;
        } catch {
          // A fresh attempt intentionally supersedes the old device-code login.
        }
      }
      if (state.closing) {
        throw Object.assign(new Error("The local wizard is closing."), {
          statusCode: 409,
        });
      }

      releaseChangeLock = await state.services.acquireLocalEndpointChangeLock({
        target,
      });
      if (state.closing) {
        throw Object.assign(new Error("The local wizard is closing."), {
          statusCode: 409,
        });
      }
      const installDirectory = await state.services.resolveLocalInstallRoot({
        target,
      });
      const { dockerHost, projectName } =
        await state.services.attestLocalCodexInstallation({
          installDirectory,
          ...(target === "codex-chat" ? { target } : {}),
        });

      const attempt = await state.services.startCodexDeviceLogin({
        installDirectory,
        dockerHost,
        projectName,
      });
      if (state.closing) {
        attempt.cancel();
        try {
          await attempt.completion;
        } catch {
          // Shutdown intentionally cancels a helper that finished starting late.
        }
        throw Object.assign(new Error("The local wizard is closing."), {
          statusCode: 409,
        });
      }
      const login = {
        cancel: attempt.cancel,
        completion: null,
        error: null,
        status: "pending",
      };
      state.codexLogin = login;
      login.completion = (async () => {
        try {
          await attempt.completion;
          if (state.codexLogin !== login || state.closing) {
            return;
          }
          await state.services.restartLocalCodex(
            {
              installDirectory,
              ...(target === "codex-chat" ? { target } : {}),
            },
            { changeLockHeld: true },
          );
          if (state.codexLogin === login && !state.closing) {
            login.status = "success";
          }
        } catch (error) {
          if (state.codexLogin === login && !state.closing) {
            login.status = "error";
            login.error = safeErrorMessage(error);
          }
        } finally {
          await releaseChangeLock();
        }
      })();
      lockTransferred = true;
      sendJson(response, 200, {
        verificationUrl: attempt.verificationUrl,
        userCode: attempt.userCode,
      });
    } finally {
      if (!lockTransferred && releaseChangeLock) {
        await releaseChangeLock();
      }
      state.codexLoginStartInFlight = false;
      finishStart();
      if (state.codexLoginStartPromise === startPromise) {
        state.codexLoginStartPromise = null;
      }
    }
    return;
  }

  if (path === "/api/ssh/fingerprint") {
    rejectActiveVpsMutation(state);
    enforceRateLimit(state, path);
    const host = validateHostname(body.host);
    const port = validatePort(body.port);
    const fingerprint = await state.services.scanHostFingerprint({
      host,
      port,
    });
    rejectActiveVpsMutation(state);
    state.scannedHost = { host, port, fingerprint };
    sendJson(response, 200, { fingerprint });
    return;
  }

  if (path === "/api/ssh/connect") {
    rejectActiveVpsMutation(state);
    enforceRateLimit(state, path);
    const host = validateHostname(body.host);
    const port = validatePort(body.port);
    const scannedHost = state.scannedHost;
    if (
      !scannedHost ||
      scannedHost.host !== host ||
      scannedHost.port !== port ||
      !tokenMatches(body.expectedFingerprint, scannedHost.fingerprint)
    ) {
      throw new Error(
        "The VPS identity confirmation is missing or no longer matches. Check it again.",
      );
    }

    state.connection?.close();
    state.connection = null;

    let candidateConnection = null;
    try {
      candidateConnection = await state.services.connectVerified({
        host,
        port,
        username: body.username,
        password: body.password,
        agent: body.useAgent ? process.env.SSH_AUTH_SOCK : undefined,
        expectedFingerprint: scannedHost.fingerprint,
      });
      rejectActiveVpsMutation(state);
      state.connection = candidateConnection;
      candidateConnection = null;
    } finally {
      body.password = undefined;
      try {
        candidateConnection?.close();
      } catch {
        // A stale connection must never become the shared VPS connection.
      }
    }

    state.scannedHost = null;
    state.discovery = null;
    state.networksByContainer.clear();
    state.sidecarPlan = null;
    state.assistantPlan = null;
    sendJson(response, 200, { connected: true });
    return;
  }

  if (path === "/api/discover") {
    rejectActiveVpsMutation(state);
    const connection = requireConnection(state);
    const discovery = await state.services.discoverN8n(connection);
    rejectActiveVpsMutation(state);
    state.discovery = discovery;
    state.networksByContainer.clear();
    state.sidecarPlan = null;
    state.assistantPlan = null;
    sendJson(response, 200, state.discovery);
    return;
  }

  if (path === "/api/networks") {
    rejectActiveVpsMutation(state);
    const connection = requireConnection(state);
    requireDiscoveredContainer(state, body.containerName);
    const networks = await state.services.discoverNetworks(
      connection,
      body.containerName,
    );
    rejectActiveVpsMutation(state);
    state.networksByContainer.set(body.containerName, networks);
    state.sidecarPlan = null;
    state.assistantPlan = null;
    sendJson(response, 200, networks);
    return;
  }

  if (path === "/api/plan") {
    rejectActiveVpsMutation(state);
    requireDiscoveredNetwork(
      state,
      body.containerName,
      body.networkName,
    );
    state.sidecarPlan = {
      containerName: body.containerName,
      networkName: body.networkName,
    };
    sendJson(response, 200, {
      installDirectory: "/docker/n8n-openai-oauth",
      sidecarProject: "n8n-openai-oauth",
      endpointHostname: SIDECAR_HOSTNAME,
      networkName: body.networkName,
      existingN8nChanges: [],
      existingN8nRestarts: 0,
      publishedPorts: [],
    });
    return;
  }

  if (path === "/api/assistant/plan") {
    rejectActiveVpsMutation(state);
    const includeSearxng = requireAssistantSearxngSelection(body.includeSearxng);
    requireDiscoveredNetwork(
      state,
      body.containerName,
      body.networkName,
    );
    const instanceAi = requireEnabledInstanceAi(state, body.containerName);
    state.assistantPlan = {
      containerName: body.containerName,
      networkName: body.networkName,
      includeSearxng,
      instanceAi,
    };
    sendJson(response, 200, {
      installDirectory: ASSISTANT_ROOT,
      companionProject: "generated ownership-bound project after confirmation",
      sandboxUrl: "generated after verified installation",
      includeSearxng,
      webSearch: includeSearxng ? "enabled" : "disabled",
      ...(includeSearxng ? { searxngUrl: "generated after verified installation" } : {}),
      networkName: body.networkName,
      instanceAi,
      existingN8nChanges: [],
      existingN8nRestarts: 0,
      publishedPorts: [],
      privilegedRunner: true,
      preview: true,
    });
    return;
  }

  if (path === "/api/assistant/install") {
    rejectActiveVpsMutation(state);
    enforceRateLimit(state, path);
    const includeSearxng = requireAssistantSearxngSelection(body.includeSearxng);
    requireDiscoveredNetwork(
      state,
      body.containerName,
      body.networkName,
    );
    const reviewedPlan = state.assistantPlan;
    requireReviewedAssistantPlan(state, reviewedPlan, body);
    const connection = requireConnection(state);
    state.assistantPlan = null;
    const releaseVpsMutationLock = acquireVpsMutationLock(state);
    try {
      const freshNetworks = await state.services.discoverNetworks(
        connection,
        body.containerName,
      );
      requireFreshAssistantInstallState(reviewedPlan, freshNetworks, body);
      const result = await state.services.installAssistant({
        remote: connection,
        networkName: body.networkName,
        confirmed: body.confirmed,
        includeSearxng,
      });
      sendJson(response, 200, result);
    } finally {
      try {
        connection.close();
        if (state.connection === connection) {
          state.connection = null;
        }
      } finally {
        releaseVpsMutationLock();
      }
    }
    return;
  }

  if (path === "/api/install") {
    rejectActiveVpsMutation(state);
    enforceRateLimit(state, path);
    requireDiscoveredNetwork(
      state,
      body.containerName,
      body.networkName,
    );
    requireReviewedVpsPlan(state.sidecarPlan, body, "sidecar");
    const connection = requireConnection(state);
    state.sidecarPlan = null;
    const releaseVpsMutationLock = acquireVpsMutationLock(state);
    let result;
    try {
      const authStatus = await state.services.getAuthStatus();
      if (!authStatus.exists) {
        throw new Error("Sign in with ChatGPT before installing.");
      }
      const authContents = await state.services.readAuthContents({
        authPath: authStatus.path,
      });
      result = await state.services.installSidecar({
        remote: connection,
        networkName: body.networkName,
        authContents,
        confirmed: body.confirmed,
      });
    } finally {
      try {
        connection.close();
        if (state.connection === connection) {
          state.connection = null;
        }
      } finally {
        releaseVpsMutationLock();
      }
    }

    sendJson(response, 200, result);
    return;
  }

  if (path === "/api/disconnect") {
    rejectActiveVpsMutation(state);
    state.connection?.close();
    state.connection = null;
    state.sidecarPlan = null;
    state.assistantPlan = null;
    sendJson(response, 200, { disconnected: true });
    return;
  }

  sendJson(response, 404, { error: "Not found." });
}

function createRequestHandler(state) {
  return async (request, response) => {
    setSecurityHeaders(response);

    try {
      if (state.closing) {
        sendJson(response, 503, { error: "The local wizard is closing." });
        return;
      }
      const url = new URL(request.url, state.origin);
      const path = url.pathname;

      if (path.startsWith("/api/")) {
        await handleApi(request, response, path, state);
        return;
      }

      if (request.method !== "GET" || !(path in state.uiFiles)) {
        sendJson(response, 404, { error: "Not found." });
        return;
      }

      const contentType =
        path.endsWith(".js")
          ? "text/javascript; charset=utf-8"
          : path.endsWith(".svg")
            ? "image/svg+xml; charset=utf-8"
            : path.endsWith(".png")
              ? "image/png"
              : path.endsWith(".css")
                ? "text/css; charset=utf-8"
                : "text/html; charset=utf-8";
      const contents = state.uiFiles[path];
      response.writeHead(200, {
        "Content-Type": contentType,
        "Content-Length": Buffer.byteLength(contents),
      });
      response.end(contents);
    } catch (error) {
      if (!response.headersSent) {
        sendJson(response, error.statusCode ?? 400, {
          error: safeErrorMessage(error),
          ...(error.retryBlocked === true ? { retryBlocked: true } : {}),
        });
      } else {
        response.end();
      }
    }
  };
}

export async function startWizardServer({
  sessionToken,
  services = defaultServices,
  uiFiles,
  port = 0,
  previewMode = false,
  oauthShutdownWaitMs = OAUTH_SHUTDOWN_WAIT_MS,
} = {}) {
  if (typeof sessionToken !== "string" || sessionToken.length < 32) {
    throw new TypeError("A strong wizard session token is required.");
  }

  const resolvedServices = { ...defaultServices, ...services };
  const state = {
    sessionToken,
    services: resolvedServices,
    localChatTest:
      resolvedServices.localChatTest ??
      resolvedServices.createLocalChatTestService(),
    uiFiles: uiFiles ?? (await loadDefaultUiFiles()),
    origin: "http://127.0.0.1",
    connection: null,
    scannedHost: null,
    discovery: null,
    networksByContainer: new Map(),
    sidecarPlan: null,
    assistantPlan: null,
    vpsMutationInFlight: false,
    vpsMutationLock: null,
    vpsMutationCompletion: null,
    oauthLogin: null,
    oauthRetryBlocked: false,
    oauthStartupError: null,
    oauthLoginStartInFlight: false,
    oauthLoginStartPromise: null,
    localPlan: null,
    localInstalledTarget: null,
    localInstallInFlight: false,
    localCredentialRotationInFlight: false,
    localCredentialRotationPending: null,
    codexLogin: null,
    codexLoginStartInFlight: false,
    codexLoginStartPromise: null,
    rateLimits: new Map(),
    previewMode: previewMode === true,
    oauthShutdownWaitMs,
    closing: false,
  };
  const server = createServer(createRequestHandler(state));
  server.requestTimeout = 330_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", resolve);
  });

  const address = server.address();
  state.origin = `http://127.0.0.1:${address.port}`;

  return {
    origin: state.origin,
    async close() {
      state.closing = true;
      const serverClose = new Promise((resolve) => server.close(resolve));
      state.localChatTest.dispose?.();
      await waitForBoundedResult(
        state.oauthLoginStartPromise,
        state.oauthShutdownWaitMs,
      );
      if (state.oauthLogin?.status === "pending") {
        try {
          await cancelOAuthLogin(state, state.oauthLogin);
        } catch {
          // The bounded OAuth cancellation result must not prevent server shutdown.
        }
      }
      const codexLogin = state.codexLogin;
      state.codexLogin = null;
      codexLogin?.cancel();
      await waitForBoundedResult(
        state.codexLoginStartPromise,
        state.oauthShutdownWaitMs,
      );
      await waitForBoundedResult(
        codexLogin?.completion,
        state.oauthShutdownWaitMs,
      );
      const vpsMutationFinished = await waitForBoundedResult(
        state.vpsMutationCompletion,
        state.oauthShutdownWaitMs,
      );
      if (vpsMutationFinished) {
        state.connection?.close();
        state.connection = null;
      }
      await waitForBoundedResult(serverClose, state.oauthShutdownWaitMs);
    },
  };
}

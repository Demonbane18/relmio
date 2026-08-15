import { randomUUID, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import packageManifest from "../../package.json" with { type: "json" };

import { discoverN8n, discoverNetworks } from "../services/discovery.js";
import { installSidecar } from "../services/installer.js";
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
  createLocalDeploymentPlan,
  validateLocalTarget,
} from "../domain/local-endpoints.js";
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
  attestLocalCodexInstallation,
  getLocalDockerStatus,
  getProjectMeta,
  installLocalEndpoint,
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
    typeof error?.message === "string" ? error.message : "Request failed.";
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
    readFile(new URL("../ui/theme.js", import.meta.url), "utf8"),
    readFile(new URL("../ui/time.js", import.meta.url), "utf8"),
    readFile(new URL("../ui/styles.css", import.meta.url), "utf8"),
    readFile(new URL("../ui/local.css", import.meta.url), "utf8"),
    readFile(new URL("../ui/icons/monitor.svg", import.meta.url), "utf8"),
    readFile(new URL("../ui/icons/sun.svg", import.meta.url), "utf8"),
    readFile(new URL("../ui/icons/moon.svg", import.meta.url), "utf8"),
  ]);

  return {
    "/": files[0],
    "/local": files[1].replaceAll("__RELMIO_PACKAGE_VERSION__", PACKAGE_VERSION),
    "/app.js": files[2],
    "/local.js": files[3],
    "/oauth-popup.js": files[4],
    "/theme.js": files[5],
    "/time.js": files[6],
    "/styles.css": files[7],
    "/local.css": files[8],
    "/icons/monitor.svg": files[9],
    "/icons/sun.svg": files[10],
    "/icons/moon.svg": files[11],
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

function requireLiveLocalAction(state, action) {
  if (state.previewMode) {
    throw Object.assign(
      new Error(`${action} is disabled in sanitized preview mode.`),
      { statusCode: 403 },
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
    enforceRateLimit(state, path);
    try {
      sendJson(
        response,
        200,
        createSafeLocalChatTestResponse(await state.localChatTest.message(body)),
      );
    } finally {
      if (body && typeof body === "object") {
        body.encryptedCredential = undefined;
        body.input = undefined;
      }
    }
    return;
  }

  if (path === "/api/local/chat-test/reset") {
    requireLiveLocalAction(state, "Local chat testing");
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
    const plan = createLocalDeploymentPlan({
      target: body.target,
      port: body.port,
      allowedOrigins: body.allowedOrigins,
    });
    const planId = randomUUID();
    state.localPlan = { planId, plan };
    sendJson(response, 200, {
      planId,
      plan: createSafeLocalPlan(plan),
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
        state.codexLogin?.status === "pending"
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
      const result = await state.services.installLocalEndpoint({
        plan: pending.plan,
        apiKey: body.apiKey,
        confirmed: body.confirmed,
      });

      sendJson(response, 200, createSafeLocalInstallResult(result));
    } finally {
      if (acquiredInstallLock) {
        state.localInstallInFlight = false;
      }
      body.apiKey = undefined;
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
    enforceRateLimit(state, path);
    const host = validateHostname(body.host);
    const port = validatePort(body.port);
    const fingerprint = await state.services.scanHostFingerprint({
      host,
      port,
    });
    state.scannedHost = { host, port, fingerprint };
    sendJson(response, 200, { fingerprint });
    return;
  }

  if (path === "/api/ssh/connect") {
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

    try {
      state.connection = await state.services.connectVerified({
        host,
        port,
        username: body.username,
        password: body.password,
        agent: body.useAgent ? process.env.SSH_AUTH_SOCK : undefined,
        expectedFingerprint: scannedHost.fingerprint,
      });
    } finally {
      body.password = undefined;
    }

    state.scannedHost = null;
    state.discovery = null;
    state.networksByContainer.clear();
    sendJson(response, 200, { connected: true });
    return;
  }

  if (path === "/api/discover") {
    const connection = requireConnection(state);
    state.discovery = await state.services.discoverN8n(connection);
    state.networksByContainer.clear();
    sendJson(response, 200, state.discovery);
    return;
  }

  if (path === "/api/networks") {
    const connection = requireConnection(state);
    requireDiscoveredContainer(state, body.containerName);
    const networks = await state.services.discoverNetworks(
      connection,
      body.containerName,
    );
    state.networksByContainer.set(body.containerName, networks);
    sendJson(response, 200, networks);
    return;
  }

  if (path === "/api/plan") {
    requireDiscoveredNetwork(
      state,
      body.containerName,
      body.networkName,
    );
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

  if (path === "/api/install") {
    const connection = requireConnection(state);
    let result;
    try {
      enforceRateLimit(state, path);
      requireDiscoveredNetwork(
        state,
        body.containerName,
        body.networkName,
      );
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
      connection.close();
      if (state.connection === connection) {
        state.connection = null;
      }
    }

    sendJson(response, 200, result);
    return;
  }

  if (path === "/api/disconnect") {
    state.connection?.close();
    state.connection = null;
    sendJson(response, 200, { disconnected: true });
    return;
  }

  sendJson(response, 404, { error: "Not found." });
}

function createRequestHandler(state) {
  return async (request, response) => {
    setSecurityHeaders(response);

    try {
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
    oauthLogin: null,
    oauthRetryBlocked: false,
    oauthStartupError: null,
    oauthLoginStartInFlight: false,
    oauthLoginStartPromise: null,
    localPlan: null,
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
      state.connection?.close();
      state.connection = null;
      await waitForBoundedResult(
        new Promise((resolve) => server.close(resolve)),
        state.oauthShutdownWaitMs,
      );
    },
  };
}

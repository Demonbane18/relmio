import { timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";

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

const MAX_BODY_BYTES = 32 * 1024;
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const RATE_LIMIT_MAX = 10;

const defaultServices = {
  getAuthStatus,
  readAuthContents,
  startOAuthLogin,
  scanHostFingerprint,
  connectVerified,
  discoverN8n,
  discoverNetworks,
  installSidecar,
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
    /(?:access|refresh)[_-]?token|private[_-]?key|\/Users\//iu.test(message)
  ) {
    return "The request could not be completed safely.";
  }
  return message;
}

async function loadDefaultUiFiles() {
  const files = await Promise.all([
    readFile(new URL("../ui/index.html", import.meta.url), "utf8"),
    readFile(new URL("../ui/app.js", import.meta.url), "utf8"),
    readFile(new URL("../ui/time.js", import.meta.url), "utf8"),
    readFile(new URL("../ui/styles.css", import.meta.url), "utf8"),
  ]);

  return {
    "/": files[0],
    "/app.js": files[1],
    "/time.js": files[2],
    "/styles.css": files[3],
  };
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
      status: login?.status ?? "idle",
      ...(login?.status === "error" ? { error: login.error } : {}),
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
    enforceRateLimit(state, path);
    if (state.oauthLogin?.status === "pending") {
      state.oauthLogin.attempt.cancel();
      try {
        await state.oauthLogin.attempt.completion;
      } catch {
        // Starting again intentionally replaces the previous local attempt.
      }
    }

    const attempt = await state.services.startOAuthLogin();
    const login = {
      attempt,
      error: null,
      status: "pending",
    };
    state.oauthLogin = login;
    attempt.completion.then(
      () => {
        if (state.oauthLogin === login) {
          login.status = "success";
        }
      },
      (error) => {
        if (state.oauthLogin === login) {
          login.status = "error";
          login.error = safeErrorMessage(error);
        }
      },
    );
    sendJson(response, 200, { authorizationUrl: attempt.authorizationUrl });
    return;
  }

  const body = await readJsonBody(request);

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
    enforceRateLimit(state, path);
    const connection = requireConnection(state);
    let result;
    try {
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
          : path === "/styles.css"
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
} = {}) {
  if (typeof sessionToken !== "string" || sessionToken.length < 32) {
    throw new TypeError("A strong wizard session token is required.");
  }

  const state = {
    sessionToken,
    services,
    uiFiles: uiFiles ?? (await loadDefaultUiFiles()),
    origin: "http://127.0.0.1",
    connection: null,
    scannedHost: null,
    discovery: null,
    networksByContainer: new Map(),
    oauthLogin: null,
    rateLimits: new Map(),
    previewMode: previewMode === true,
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
      state.oauthLogin?.attempt.cancel();
      state.connection?.close();
      state.connection = null;
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

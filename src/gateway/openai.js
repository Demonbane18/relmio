#!/usr/bin/env node

import { createHash, timingSafeEqual } from "node:crypto";
import { readFile as readFileFromDisk } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createServer } from "node:http";
import { isIP } from "node:net";
import { request as httpsRequest } from "node:https";
import { pathToFileURL } from "node:url";

const DEFAULT_UPSTREAM = "https://api.openai.com";
const DEFAULT_HOST = "0.0.0.0";
const DEFAULT_PORT = 10531;
const DEFAULT_LIMITS = Object.freeze({
  maxHeaderBytes: 16 * 1024,
  maxPathBytes: 8 * 1024,
  maxBodyBytes: 8 * 1024 * 1024,
  maxConcurrentRequests: 32,
  upstreamResponseHeaderTimeoutMs: 5 * 60_000,
  upstreamIdleTimeoutMs: 2 * 60_000,
  downstreamStallTimeoutMs: 2 * 60_000,
});

const LOOPBACK_HOSTNAMES = new Set(["127.0.0.1", "localhost", "[::1]"]);
const HOP_BY_HOP_HEADERS = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);
const REQUEST_HEADERS_TO_STRIP = new Set([
  "authorization",
  "cookie",
  "cookie2",
  "expect",
  "forwarded",
  "host",
  "origin",
  "openai-organization",
  "openai-project",
  "referer",
  "via",
  "x-real-ip",
]);
const PREFLIGHT_HEADER_NAMES = new Set([
  "authorization",
  "content-type",
  "idempotency-key",
  "openai-beta",
]);
const PREFLIGHT_METHODS = new Set(["DELETE", "GET", "HEAD", "PATCH", "POST", "PUT"]);
const ALLOWED_ROUTES = new Map([
  ["/v1/models", new Set(["GET"])],
  ["/v1/responses", new Set(["POST"])],
  ["/v1/chat/completions", new Set(["POST"])],
]);

function byteLength(value) {
  return Buffer.byteLength(value, "utf8");
}

function normalizePositiveInteger(value, name, { allowZero = false } = {}) {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1)) {
    throw new TypeError(`${name} is invalid.`);
  }
  return value;
}

function normalizeVerifier(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/iu.test(value)) {
    throw new TypeError("The gateway token verifier is invalid.");
  }
  return value.toLowerCase();
}

function normalizePlatformApiKey(value) {
  if (
    typeof value !== "string" ||
    value.length < 8 ||
    value.length > 512 ||
    /[\s\u0000-\u001f\u007f]/u.test(value)
  ) {
    throw new TypeError("The Platform API key file is invalid.");
  }
  return value;
}

function normalizeOrigin(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) {
    throw new TypeError("The allowed origin configuration is invalid.");
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new TypeError("The allowed origin configuration is invalid.");
  }

  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.origin !== value
  ) {
    throw new TypeError("The allowed origin configuration is invalid.");
  }
  return value;
}

function normalizeAllowedOrigins(values) {
  if (!Array.isArray(values) || values.length > 10) {
    throw new TypeError("The allowed origin configuration is invalid.");
  }
  const normalized = values.map(normalizeOrigin);
  if (new Set(normalized).size !== normalized.length) {
    throw new TypeError("The allowed origin configuration is invalid.");
  }
  return new Set(normalized);
}

function normalizeUpstream(value) {
  const raw = value ?? DEFAULT_UPSTREAM;
  let parsed;
  try {
    parsed = raw instanceof URL ? new URL(raw.href) : new URL(raw);
  } catch {
    throw new TypeError("The upstream configuration is invalid.");
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    parsed.username !== "" ||
    parsed.password !== "" ||
    parsed.pathname !== "/" ||
    parsed.search !== "" ||
    parsed.hash !== ""
  ) {
    throw new TypeError("The upstream configuration is invalid.");
  }
  return parsed;
}

function normalizeHost(value) {
  if (typeof value !== "string" || (isIP(value) === 0 && value !== "localhost")) {
    throw new TypeError("The gateway host is invalid.");
  }
  return value;
}

function normalizePort(value, { allowZero = false } = {}) {
  if (!Number.isSafeInteger(value) || value < (allowZero ? 0 : 1) || value > 65535) {
    throw new TypeError("The gateway port is invalid.");
  }
  return value;
}

function strictBase64Decode(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(
      value,
    )
  ) {
    throw new TypeError("The allowed origin configuration is invalid.");
  }
  const decoded = Buffer.from(value, "base64");
  if (decoded.toString("base64") !== value) {
    throw new TypeError("The allowed origin configuration is invalid.");
  }
  return decoded.toString("utf8");
}

function parseAllowedOrigins(value) {
  let parsed;
  try {
    parsed = JSON.parse(strictBase64Decode(value));
  } catch (error) {
    if (error instanceof TypeError) {
      throw error;
    }
    throw new TypeError("The allowed origin configuration is invalid.");
  }
  return [...normalizeAllowedOrigins(parsed)];
}

function parsePort(value) {
  if (value === undefined || value === "") {
    return DEFAULT_PORT;
  }
  if (!/^[0-9]{1,5}$/u.test(value)) {
    throw new TypeError("The gateway port is invalid.");
  }
  return normalizePort(Number(value));
}

function sendJson(response, status, payload, headers = {}) {
  if (response.headersSent || response.destroyed) {
    return;
  }
  const body = Buffer.from(JSON.stringify(payload));
  response.writeHead(status, {
    "Cache-Control": "no-store",
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": body.length,
    "X-Content-Type-Options": "nosniff",
    ...headers,
  });
  response.end(body);
}

function errorResponse(response, status, code, origin, extraHeaders = {}) {
  const corsHeaders = origin
    ? {
        "Access-Control-Allow-Origin": origin,
        Vary: "Origin",
      }
    : {};
  sendJson(
    response,
    status,
    { error: { code, message: "The request was rejected by the local gateway." } },
    { ...corsHeaders, ...extraHeaders },
  );
}

function headerOccurrences(request, targetName) {
  let count = 0;
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index].toLowerCase() === targetName) {
      count += 1;
    }
  }
  return count;
}

function requestHeaderBytes(request) {
  let total = 2;
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    total += byteLength(request.rawHeaders[index]);
    total += byteLength(request.rawHeaders[index + 1]);
    total += 4;
  }
  return total;
}

function connectionHeaderNames(headers) {
  const value = headers.connection;
  if (typeof value !== "string") {
    return new Set();
  }
  return new Set(
    value
      .split(",")
      .map((name) => name.trim().toLowerCase())
      .filter(Boolean),
  );
}

function sanitizeRequestHeaders(request, platformApiKey) {
  const connectionNames = connectionHeaderNames(request.headers);
  const headers = {};
  for (const [rawName, rawValue] of Object.entries(request.headers)) {
    const name = rawName.toLowerCase();
    if (
      rawValue === undefined ||
      HOP_BY_HOP_HEADERS.has(name) ||
      REQUEST_HEADERS_TO_STRIP.has(name) ||
      connectionNames.has(name) ||
      name.startsWith("proxy-") ||
      name.startsWith("x-forwarded-")
    ) {
      continue;
    }
    headers[name] = rawValue;
  }
  headers.authorization = `Bearer ${platformApiKey}`;
  return headers;
}

function sanitizeResponseHeaders(upstreamResponse, origin) {
  const connectionNames = connectionHeaderNames(upstreamResponse.headers);
  const result = [];
  const varyValues = [];

  for (let index = 0; index < upstreamResponse.rawHeaders.length; index += 2) {
    const rawName = upstreamResponse.rawHeaders[index];
    const rawValue = upstreamResponse.rawHeaders[index + 1];
    const name = rawName.toLowerCase();
    if (
      HOP_BY_HOP_HEADERS.has(name) ||
      connectionNames.has(name) ||
      name.startsWith("access-control-") ||
      name === "location" ||
      name === "set-cookie" ||
      name === "set-cookie2"
    ) {
      continue;
    }
    if (name === "vary") {
      varyValues.push(rawValue);
      continue;
    }
    result.push(rawName, rawValue);
  }

  const varyNames = new Set(
    varyValues
      .join(",")
      .split(",")
      .map((name) => name.trim())
      .filter(Boolean),
  );
  if (origin) {
    if (![...varyNames].some((name) => name.toLowerCase() === "origin")) {
      varyNames.add("Origin");
    }
    result.push("Access-Control-Allow-Origin", origin);
  }
  if (varyNames.size > 0) {
    result.push("Vary", [...varyNames].join(", "));
  }
  return result;
}

function isExpectedHost(value, allowedHostnames) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 261 ||
    /[\s,@/?#\\]/u.test(value)
  ) {
    return false;
  }
  const authority = /^(\[[^\]]+\]|[^:[\]]+)(?::([0-9]{1,5}))?$/u.exec(value);
  if (!authority) {
    return false;
  }
  if (authority[2] !== undefined) {
    const port = Number(authority[2]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      return false;
    }
  }
  return allowedHostnames.has(authority[1].toLowerCase());
}

function isSafeTarget(value, maxPathBytes) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    byteLength(value) > maxPathBytes
  ) {
    return { safe: false, status: 414 };
  }
  if (
    value.startsWith("//") ||
    /^[A-Za-z][A-Za-z0-9+.-]*:/u.test(value) ||
    /[\u0000-\u001f\u007f\\#]/u.test(value)
  ) {
    return { safe: false, status: 400 };
  }

  let parsed;
  try {
    parsed = new URL(value, "http://relmio.invalid");
  } catch {
    return { safe: false, status: 400 };
  }
  if (!ALLOWED_ROUTES.has(parsed.pathname)) {
    return { safe: false, status: 404 };
  }
  return { safe: true, status: 0, pathname: parsed.pathname };
}

function hasValidBearer(request, verifierBuffer) {
  if (headerOccurrences(request, "authorization") !== 1) {
    return false;
  }
  const authorization = request.headers.authorization;
  if (typeof authorization !== "string" || authorization.length > 2048) {
    return false;
  }
  const match = /^Bearer ([^\s,]+)$/iu.exec(authorization);
  if (!match) {
    return false;
  }
  const candidate = createHash("sha256").update(match[1], "utf8").digest();
  return timingSafeEqual(candidate, verifierBuffer);
}

function readOrigin(request, allowedOrigins) {
  const count = headerOccurrences(request, "origin");
  if (count === 0) {
    return { present: false, valid: true, value: undefined };
  }
  const origin = request.headers.origin;
  const valid =
    count === 1 && typeof origin === "string" && allowedOrigins.has(origin);
  return { present: true, valid, value: valid ? origin : undefined };
}

function isAllowedPreflightHeader(name) {
  return PREFLIGHT_HEADER_NAMES.has(name) || name.startsWith("x-stainless-");
}

function handlePreflight(request, response, origin, pathname) {
  const requestedMethod = request.headers["access-control-request-method"];
  const requestedHeadersValue = request.headers["access-control-request-headers"] ?? "";
  if (
    typeof requestedMethod !== "string" ||
    !PREFLIGHT_METHODS.has(requestedMethod) ||
    !ALLOWED_ROUTES.get(pathname)?.has(requestedMethod) ||
    typeof requestedHeadersValue !== "string"
  ) {
    errorResponse(response, 403, "cors_preflight_rejected", origin);
    return;
  }

  const requestedHeaders = requestedHeadersValue
    .split(",")
    .map((name) => name.trim().toLowerCase())
    .filter(Boolean);
  if (
    requestedHeaders.length > 32 ||
    !requestedHeaders.includes("authorization") ||
    new Set(requestedHeaders).size !== requestedHeaders.length ||
    requestedHeaders.some((name) => !isAllowedPreflightHeader(name))
  ) {
    errorResponse(response, 403, "cors_preflight_rejected", origin);
    return;
  }

  response.writeHead(204, {
    "Access-Control-Allow-Headers": requestedHeaders.join(", "),
    "Access-Control-Allow-Methods": requestedMethod,
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Max-Age": "600",
    "Cache-Control": "no-store",
    Vary: "Origin, Access-Control-Request-Method, Access-Control-Request-Headers",
  });
  response.end();
}

function proxyRequest(request, response, state, origin) {
  state.activeRequests += 1;
  let released = false;
  let rejectedForSize = false;
  let responseHeaderTimedOut = false;
  let responseHeaderTimer;
  let upstreamResponse;
  let inboundDone = request.readableEnded;
  let downstreamDone = response.writableEnded;
  const releaseIfDone = () => {
    if (!released && inboundDone && downstreamDone) {
      released = true;
      state.activeRequests -= 1;
    }
  };
  const markInboundDone = () => {
    inboundDone = true;
    releaseIfDone();
  };
  const markDownstreamDone = () => {
    downstreamDone = true;
    releaseIfDone();
  };
  response.once("finish", markDownstreamDone);
  response.once("close", markDownstreamDone);

  const headers = sanitizeRequestHeaders(request, state.platformApiKey);
  const transport = state.upstream.protocol === "https:" ? httpsRequest : httpRequest;
  const upstreamRequest = transport(
    {
      protocol: state.upstream.protocol,
      hostname: state.upstream.hostname,
      port: state.upstream.port,
      method: request.method,
      path: request.url,
      headers,
    },
    (incoming) => {
      clearTimeout(responseHeaderTimer);
      upstreamResponse = incoming;
      if (response.destroyed) {
        incoming.destroy();
        return;
      }
      const responseHeaders = sanitizeResponseHeaders(incoming, origin);
      response.writeHead(
        incoming.statusCode ?? 502,
        incoming.statusMessage,
        responseHeaders,
      );
      const upstreamSocket = incoming.socket;
      let downstreamStallTimer;
      const disableIdleTimeout = () => upstreamSocket.setTimeout(0);
      const armIdleTimeout = () =>
        upstreamSocket.setTimeout(state.upstreamIdleTimeoutMs);
      const clearDownstreamStallTimeout = () => {
        clearTimeout(downstreamStallTimer);
        downstreamStallTimer = undefined;
      };
      const abortStreaming = () => {
        clearDownstreamStallTimeout();
        disableIdleTimeout();
        incoming.destroy();
        upstreamRequest.destroy();
        if (!response.destroyed) {
          response.destroy();
        }
      };
      const handlePause = () => {
        disableIdleTimeout();
        clearDownstreamStallTimeout();
        downstreamStallTimer = setTimeout(
          abortStreaming,
          state.downstreamStallTimeoutMs,
        );
        downstreamStallTimer.unref();
      };
      const handleResume = () => {
        clearDownstreamStallTimeout();
        armIdleTimeout();
      };
      const clearStreamTimeouts = () => {
        clearDownstreamStallTimeout();
        disableIdleTimeout();
        upstreamSocket.off("timeout", abortStreaming);
      };
      upstreamSocket.once("timeout", abortStreaming);
      incoming.on("pause", handlePause);
      incoming.on("resume", handleResume);
      incoming.once("close", clearStreamTimeouts);
      incoming.once("error", () => {
        clearStreamTimeouts();
        if (!response.destroyed) {
          response.destroy();
        }
      });
      armIdleTimeout();
      incoming.pipe(response);
      incoming.once("end", clearStreamTimeouts);
    },
  );

  responseHeaderTimer = setTimeout(() => {
    responseHeaderTimedOut = true;
    upstreamRequest.destroy();
    if (!response.headersSent) {
      errorResponse(response, 504, "upstream_timeout", origin);
    } else if (!response.destroyed) {
      response.destroy();
    }
  }, state.upstreamResponseHeaderTimeoutMs);
  responseHeaderTimer.unref();

  upstreamRequest.once("error", () => {
    clearTimeout(responseHeaderTimer);
    if (rejectedForSize || responseHeaderTimedOut || response.destroyed) {
      return;
    }
    if (!response.headersSent) {
      errorResponse(response, 502, "upstream_unavailable", origin);
    } else {
      response.destroy();
    }
  });

  const cancelUpstream = () => {
    clearTimeout(responseHeaderTimer);
    upstreamRequest.destroy();
    upstreamResponse?.destroy();
  };
  request.once("aborted", cancelUpstream);
  request.once("aborted", markInboundDone);
  response.once("close", () => {
    if (!response.writableEnded) {
      cancelUpstream();
    }
  });

  let receivedBytes = 0;
  request.on("data", (chunk) => {
    if (rejectedForSize) {
      return;
    }
    receivedBytes += chunk.length;
    if (receivedBytes > state.maxBodyBytes) {
      rejectedForSize = true;
      upstreamRequest.destroy();
      errorResponse(response, 413, "request_body_too_large", origin);
      return;
    }
    if (!upstreamRequest.write(chunk)) {
      request.pause();
    }
  });
  upstreamRequest.on("drain", () => request.resume());
  request.once("end", () => {
    markInboundDone();
    if (!rejectedForSize) {
      upstreamRequest.end();
    }
  });
  request.once("error", cancelUpstream);
  request.once("error", markInboundDone);
}

function createRequestHandler(state) {
  return (request, response) => {
    if (requestHeaderBytes(request) > state.maxHeaderBytes) {
      errorResponse(response, 431, "request_headers_too_large");
      return;
    }
    if (
      headerOccurrences(request, "host") !== 1 ||
      !isExpectedHost(request.headers.host, state.allowedHostnames)
    ) {
      errorResponse(response, 421, "unexpected_host");
      return;
    }

    if (request.method === "GET" && request.url === "/health") {
      sendJson(response, 200, { status: "ok" });
      return;
    }

    const target = isSafeTarget(request.url, state.maxPathBytes);
    if (!target.safe) {
      errorResponse(response, target.status, "invalid_target");
      return;
    }

    const originState = readOrigin(request, state.allowedOrigins);
    const origin = originState.value;
    if (request.method === "OPTIONS") {
      if (!originState.present || !originState.valid) {
        errorResponse(response, 403, "origin_rejected");
        return;
      }
      handlePreflight(request, response, origin, target.pathname);
      return;
    }

    if (!hasValidBearer(request, state.verifierBuffer)) {
      errorResponse(response, 401, "authentication_required", origin, {
        "WWW-Authenticate": "Bearer",
      });
      return;
    }
    if (originState.present && !originState.valid) {
      errorResponse(response, 403, "origin_rejected");
      return;
    }
    if (request.method === "TRACE" || request.method === "CONNECT") {
      errorResponse(response, 405, "method_not_allowed", origin);
      return;
    }
    if (!ALLOWED_ROUTES.get(target.pathname)?.has(request.method)) {
      errorResponse(response, 405, "method_not_allowed", origin);
      return;
    }

    const rawContentLength = request.headers["content-length"];
    if (
      rawContentLength !== undefined &&
      (typeof rawContentLength !== "string" ||
        !/^(?:0|[1-9][0-9]*)$/u.test(rawContentLength) ||
        Number(rawContentLength) > state.maxBodyBytes)
    ) {
      errorResponse(response, 413, "request_body_too_large", origin);
      return;
    }
    if (state.activeRequests >= state.maxConcurrentRequests) {
      errorResponse(response, 429, "gateway_overloaded", origin, {
        "Retry-After": "1",
      });
      return;
    }
    proxyRequest(request, response, state, origin);
  };
}

export function hashGatewayToken(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) {
    throw new TypeError("The gateway token is invalid.");
  }
  return createHash("sha256").update(value, "utf8").digest("hex");
}

export async function loadOpenAIGatewayConfig(
  environment = process.env,
  { readFile = readFileFromDisk } = {},
) {
  const keyFile = environment.OPENAI_API_KEY_FILE;
  if (typeof keyFile !== "string" || keyFile.length === 0 || keyFile.length > 4096) {
    throw new TypeError("The Platform API key file is invalid.");
  }
  const rawKey = await readFile(keyFile, "utf8");
  if (typeof rawKey !== "string") {
    throw new TypeError("The Platform API key file is invalid.");
  }
  const keyWithoutTerminator = rawKey.endsWith("\r\n")
    ? rawKey.slice(0, -2)
    : rawKey.endsWith("\n")
      ? rawKey.slice(0, -1)
      : rawKey;
  const platformApiKey = normalizePlatformApiKey(keyWithoutTerminator);
  const tokenVerifier = normalizeVerifier(
    environment.RELMIO_GATEWAY_TOKEN_SHA256,
  );
  const allowedOrigins = parseAllowedOrigins(
    environment.RELMIO_ALLOWED_ORIGINS_BASE64,
  );
  const host = normalizeHost(environment.RELMIO_GATEWAY_HOST ?? DEFAULT_HOST);
  const port = parsePort(environment.RELMIO_GATEWAY_PORT);
  return { platformApiKey, tokenVerifier, allowedOrigins, host, port };
}

export function createOpenAIGatewayServer(options) {
  if (!options || typeof options !== "object") {
    throw new TypeError("The gateway configuration is invalid.");
  }
  const verifier = normalizeVerifier(options.tokenVerifier);
  const allowedHostnames = new Set(
    options.allowedHostnames ?? LOOPBACK_HOSTNAMES,
  );
  if (
    allowedHostnames.size === 0 ||
    [...allowedHostnames].some(
      (hostname) => typeof hostname !== "string" || hostname !== hostname.toLowerCase(),
    )
  ) {
    throw new TypeError("The allowed Host configuration is invalid.");
  }
  const state = {
    activeRequests: 0,
    platformApiKey: normalizePlatformApiKey(options.platformApiKey),
    verifierBuffer: Buffer.from(verifier, "hex"),
    allowedOrigins: normalizeAllowedOrigins(options.allowedOrigins),
    allowedHostnames,
    upstream: normalizeUpstream(options.upstreamBaseUrl),
    maxHeaderBytes: normalizePositiveInteger(
      options.maxHeaderBytes ?? DEFAULT_LIMITS.maxHeaderBytes,
      "The maximum header size",
    ),
    maxPathBytes: normalizePositiveInteger(
      options.maxPathBytes ?? DEFAULT_LIMITS.maxPathBytes,
      "The maximum path size",
    ),
    maxBodyBytes: normalizePositiveInteger(
      options.maxBodyBytes ?? DEFAULT_LIMITS.maxBodyBytes,
      "The maximum body size",
    ),
    maxConcurrentRequests: normalizePositiveInteger(
      options.maxConcurrentRequests ?? DEFAULT_LIMITS.maxConcurrentRequests,
      "The maximum concurrent request count",
    ),
    upstreamResponseHeaderTimeoutMs: normalizePositiveInteger(
      options.upstreamResponseHeaderTimeoutMs ??
        DEFAULT_LIMITS.upstreamResponseHeaderTimeoutMs,
      "The upstream response-header timeout",
    ),
    upstreamIdleTimeoutMs: normalizePositiveInteger(
      options.upstreamIdleTimeoutMs ?? DEFAULT_LIMITS.upstreamIdleTimeoutMs,
      "The upstream idle timeout",
    ),
    downstreamStallTimeoutMs: normalizePositiveInteger(
      options.downstreamStallTimeoutMs ?? DEFAULT_LIMITS.downstreamStallTimeoutMs,
      "The downstream stall timeout",
    ),
  };
  const server = createServer(createRequestHandler(state));
  server.on("connect", (_request, socket) => {
    socket.end(
      "HTTP/1.1 405 Method Not Allowed\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
    );
  });
  server.on("clientError", (_error, socket) => {
    if (socket.writable) {
      socket.end(
        "HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
      );
    }
  });
  return server;
}

export async function startOpenAIGateway(options) {
  const host = normalizeHost(options?.host ?? DEFAULT_HOST);
  const port = normalizePort(options?.port ?? DEFAULT_PORT, { allowZero: true });
  const server = createOpenAIGatewayServer(options);
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  const publicHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  const originHost = publicHost.includes(":") ? `[${publicHost}]` : publicHost;
  return {
    server,
    origin: `http://${originHost}:${actualPort}`,
    async close() {
      await new Promise((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    },
  };
}

async function runFromEnvironment() {
  const config = await loadOpenAIGatewayConfig();
  const gateway = await startOpenAIGateway(config);
  const address = gateway.server.address();
  const port = typeof address === "object" && address ? address.port : config.port;
  process.stdout.write(`Relmio OpenAI API gateway listening on ${config.host}:${port}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runFromEnvironment().catch(() => {
    process.stderr.write("Relmio OpenAI API gateway failed to start.\n");
    process.exitCode = 1;
  });
}

import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { pathToFileURL } from "node:url";

const MAX_HEADER_BYTES = 16 * 1024;
const MAX_BODY_BYTES = 16 * 1024;
const MAX_INPUT_BYTES = 12 * 1024;
const MAX_OUTPUT_BYTES = 128 * 1024;
const MAX_PROTOCOL_LINE_BYTES = 64 * 1024;
const MAX_PROTOCOL_STDOUT_BYTES = 256 * 1024;
const MAX_PROTOCOL_STDERR_BYTES = 64 * 1024;
const TURN_TIMEOUT_MS = 120_000;
const TERMINATION_GRACE_MS = 2_000;
const KEEPALIVE_INTERVAL_MS = 15_000;
const CONVERSATIONAL_INSTRUCTION =
  "Provide a conversational answer only. Do not inspect or edit files, run commands, call tools, or access external resources.";

function isLoopbackListenHost(value) {
  return value === "127.0.0.1" || value === "0.0.0.0" || value === "::1";
}

function validateTokenVerifier(value) {
  if (!Buffer.isBuffer(value) || value.length !== 32) {
    throw new TypeError("A SHA-256 local client credential verifier is required.");
  }
  return Buffer.from(value);
}

function headerOccurrences(request, expectedName) {
  let count = 0;
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index].toLowerCase() === expectedName) {
      count += 1;
    }
  }
  return count;
}

function validLoopbackHost(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 261) {
    return false;
  }
  const match = /^(\[[^\]]+\]|[^:[\]]+)(?::([0-9]{1,5}))?$/u.exec(value);
  if (!match || /[\s,@/?#\\]/u.test(value)) {
    return false;
  }
  if (match[2] !== undefined && (Number(match[2]) < 1 || Number(match[2]) > 65535)) {
    return false;
  }
  return ["127.0.0.1", "localhost", "[::1]"].includes(match[1].toLowerCase());
}

function sendJson(response, status, body) {
  const contents = JSON.stringify(body);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(contents),
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(contents);
}

function sendError(response, status, code) {
  sendJson(response, status, { error: { code } });
}

function acceptsEventStream(request) {
  if (headerOccurrences(request, "accept") > 1) {
    return false;
  }
  const value = request.headers.accept;
  return (
    typeof value === "string" &&
    value
      .split(",")
      .some((entry) => entry.trim().split(";", 1)[0] === "text/event-stream")
  );
}

function startEventStream(response, keepaliveIntervalMs) {
  let ended = false;
  response.writeHead(200, {
    "Cache-Control": "no-store",
    Connection: "keep-alive",
    "Content-Encoding": "none",
    "Content-Type": "text/event-stream; charset=utf-8",
    "X-Accel-Buffering": "no",
    "X-Content-Type-Options": "nosniff",
    "X-Relmio-Stream": "v1",
  });
  const send = (event, data) => {
    if (ended || response.writableEnded || response.destroyed) {
      return;
    }
    response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  const keepalive = setInterval(() => {
    if (!ended && !response.writableEnded && !response.destroyed) {
      response.write(": keepalive\n\n");
    }
  }, keepaliveIntervalMs);
  keepalive.unref?.();
  send("start", { requestId: randomUUID() });
  return {
    send,
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
    fail(code = "upstream_failed", retryable = true) {
      if (ended) return;
      send("error", { code, retryable });
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

function hasValidBearer(request, verifier) {
  if (headerOccurrences(request, "authorization") !== 1) {
    return false;
  }
  const value = request.headers.authorization;
  if (typeof value !== "string" || value.length > 512) {
    return false;
  }
  const match = /^Bearer ([A-Za-z0-9_-]{1,256})$/u.exec(value);
  if (!match) {
    return false;
  }
  const candidate = createHash("sha256").update(match[1], "utf8").digest();
  return timingSafeEqual(candidate, verifier);
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isSafeIdentifier(value) {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(value)
  );
}

function validatePackageVersion(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9.+-]{1,64}$/u.test(value)) {
    throw new TypeError("The Relmio package version is invalid.");
  }
  return value;
}

function parseContentType(request) {
  if (headerOccurrences(request, "content-type") !== 1) {
    return false;
  }
  const value = request.headers["content-type"];
  return (
    typeof value === "string" &&
    /^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(value)
  );
}

function readChatRequest(request) {
  return new Promise((resolvePromise, rejectPromise) => {
    const chunks = [];
    let bytes = 0;
    let rejected = false;
    const reject = (code, status = 400) => {
      if (!rejected) {
        rejected = true;
        rejectPromise(Object.assign(new Error(code), { code, status }));
      }
    };
    request.on("data", (chunk) => {
      if (rejected) {
        return;
      }
      const value = Buffer.from(chunk);
      bytes += value.length;
      if (bytes > MAX_BODY_BYTES) {
        reject("body_too_large", 413);
        return;
      }
      chunks.push(value);
    });
    request.once("aborted", () => reject("client_disconnected", 499));
    request.once("error", () => reject("invalid_request"));
    request.once("end", () => {
      if (rejected) {
        return;
      }
      let body;
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        reject("invalid_json");
        return;
      }
      if (!isPlainObject(body)) {
        reject("invalid_request");
        return;
      }
      const keys = Object.keys(body).sort();
      if (
        !keys.includes("input") ||
        keys.some((key) => key !== "input" && key !== "conversationId")
      ) {
        reject("invalid_request");
        return;
      }
      if (
        typeof body.input !== "string" ||
        body.input.trim() === "" ||
        body.input.includes("\0") ||
        Buffer.byteLength(body.input, "utf8") > MAX_INPUT_BYTES
      ) {
        reject("invalid_request");
        return;
      }
      if (
        body.conversationId !== undefined &&
        !isSafeIdentifier(body.conversationId)
      ) {
        reject("invalid_request");
        return;
      }
      resolvePromise({
        input: body.input,
        conversationId: body.conversationId,
      });
    });
  });
}

function normalizeFinalMessage(value) {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= MAX_OUTPUT_BYTES
      ? value
      : null
  );
}

function createAppServerOperation({
  input,
  conversationId,
  packageVersion,
  onEvent,
  onFailure,
  signal,
  spawnProcess,
  terminationGraceMs,
  turnTimeoutMs,
}) {
  return new Promise((resolvePromise, rejectPromise) => {
    let child;
    try {
      child = spawnProcess(
        "codex",
        ["app-server", "--strict-config", "--stdio"],
        {
          cwd: "/workspace",
          shell: false,
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        },
      );
    } catch {
      rejectPromise(new Error("unavailable"));
      return;
    }
    if (
      !child ||
      typeof child.kill !== "function" ||
      typeof child.once !== "function" ||
      typeof child.stdout?.on !== "function" ||
      typeof child.stderr?.on !== "function" ||
      typeof child.stdin?.on !== "function" ||
      typeof child.stdin?.write !== "function"
    ) {
      rejectPromise(new Error("unavailable"));
      return;
    }

    let settled = false;
    let closing = false;
    let stdout = Buffer.alloc(0);
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let threadId = null;
    let turnId = null;
    let finalOutput = null;
    let latestDeltaItemId = null;
    let deltaBytes = 0;
    let emittedDeltaBytes = 0;
    const deltaOutputs = new Map();
    let phase = "initializing";
    let outcome = null;
    let timeout;
    let killTimeout;
    let reapTimeout;

    const clearTimers = () => {
      clearTimeout(timeout);
      clearTimeout(killTimeout);
      clearTimeout(reapTimeout);
      timeout = undefined;
      killTimeout = undefined;
      reapTimeout = undefined;
    };
    const complete = () => {
      if (settled || !outcome) {
        return;
      }
      settled = true;
      signal?.removeEventListener?.("abort", abortOperation);
      clearTimers();
      if (outcome.error) {
        rejectPromise(new Error("unavailable"));
      } else {
        resolvePromise(outcome.result);
      }
    };
    const terminate = () => {
      if (closing) {
        return;
      }
      closing = true;
      try {
        child.stdin.end?.();
      } catch {
        // The child is already being terminated.
      }
      try {
        child.kill("SIGTERM");
      } catch {
        // A failed termination still receives a redacted result.
      }
      killTimeout = setTimeout(() => {
        try {
          child.kill("SIGKILL");
        } catch {
          // There is no useful process detail to expose to the client.
        }
        reapTimeout = setTimeout(complete, terminationGraceMs);
      }, terminationGraceMs);
    };
    const settle = (error, result) => {
      if (settled || outcome) {
        return;
      }
      outcome = { error, result };
      if (error) {
        onFailure?.(error.message === "timeout" ? "timeout" : "upstream_failed");
      }
      signal?.removeEventListener?.("abort", abortOperation);
      clearTimeout(timeout);
      timeout = undefined;
      terminate();
    };
    const failProtocol = () => settle(new Error("protocol"));
    function abortOperation() {
      settle(new Error("disconnected"));
    }
    const write = (message) => {
      try {
        child.stdin.write(`${JSON.stringify(message)}\n`);
      } catch {
        failProtocol();
      }
    };
    const startThread = () => {
      phase = "thread";
      onEvent?.("progress", { phase: "starting_thread" });
      write({
        id: 1,
        method: conversationId ? "thread/resume" : "thread/start",
        params: conversationId
          ? {
              approvalPolicy: "never",
              cwd: "/workspace",
              developerInstructions: CONVERSATIONAL_INSTRUCTION,
              permissions: "relmio-chat-readonly",
              threadId: conversationId,
            }
          : {
              approvalPolicy: "never",
              cwd: "/workspace",
              developerInstructions: CONVERSATIONAL_INSTRUCTION,
              permissions: "relmio-chat-readonly",
            },
      });
    };
    const startTurn = () => {
      phase = "turn";
      onEvent?.("progress", { phase: "starting_turn" });
      write({
        id: 2,
        method: "turn/start",
        params: {
          approvalPolicy: "never",
          cwd: "/workspace",
          input: [{ text: input, type: "text" }],
          permissions: "relmio-chat-readonly",
          threadId,
        },
      });
    };
    const processMessage = (message) => {
      if (!isPlainObject(message) || settled || outcome) {
        failProtocol();
        return;
      }
      if (message.id === 0) {
        if (phase !== "initializing" || message.error !== undefined || !isPlainObject(message.result)) {
          failProtocol();
          return;
        }
        write({ method: "initialized", params: {} });
        startThread();
        return;
      }
      if (message.id === 1) {
        const candidate = message.result?.thread?.id;
        const activeProfile = message.result?.activePermissionProfile;
        if (
          phase !== "thread" ||
          message.error !== undefined ||
          !isSafeIdentifier(candidate) ||
          !isPlainObject(activeProfile) ||
          activeProfile.id !== "relmio-chat-readonly" ||
          activeProfile.extends !== ":read-only"
        ) {
          failProtocol();
          return;
        }
        threadId = candidate;
        startTurn();
        return;
      }
      if (message.id === 2) {
        const candidate = message.result?.turn?.id;
        if (phase !== "turn" || message.error !== undefined || !isSafeIdentifier(candidate)) {
          failProtocol();
          return;
        }
        turnId = candidate;
        phase = "waiting";
        return;
      }
      if (message.id !== undefined) {
        failProtocol();
        return;
      }
      if (typeof message.method !== "string" || !isPlainObject(message.params)) {
        failProtocol();
        return;
      }
      const params = message.params;
      if (message.method === "item/agentMessage/delta") {
        if (
          phase !== "waiting" ||
          params.threadId !== threadId ||
          params.turnId !== turnId ||
          !isSafeIdentifier(params.itemId) ||
          typeof params.delta !== "string" ||
          Buffer.byteLength(params.delta, "utf8") > MAX_OUTPUT_BYTES
        ) {
          failProtocol();
          return;
        }
        const partBytes = Buffer.byteLength(params.delta, "utf8");
        if (deltaBytes + partBytes > MAX_OUTPUT_BYTES) {
          failProtocol();
          return;
        }
        deltaBytes += partBytes;
        emittedDeltaBytes += partBytes;
        latestDeltaItemId = params.itemId;
        deltaOutputs.set(
          params.itemId,
          `${deltaOutputs.get(params.itemId) ?? ""}${params.delta}`,
        );
        onEvent?.("delta", { text: params.delta });
        return;
      }
      if (message.method === "item/completed") {
        if (phase !== "waiting" || params.threadId !== threadId || params.turnId !== turnId || !isPlainObject(params.item)) {
          failProtocol();
          return;
        }
        if (params.item.type === "agentMessage") {
          if (!isSafeIdentifier(params.item.id)) {
            failProtocol();
            return;
          }
          const output = normalizeFinalMessage(params.item.text);
          if (!output) {
            failProtocol();
            return;
          }
          finalOutput = output;
        }
        return;
      }
      if (message.method === "turn/completed") {
        if (
          phase !== "waiting" ||
          params.threadId !== threadId ||
          !isPlainObject(params.turn) ||
          params.turn.id !== turnId ||
          params.turn.status !== "completed"
        ) {
          failProtocol();
          return;
        }
        const completedItem = Array.isArray(params.turn.items)
          ? [...params.turn.items]
              .reverse()
              .find((item) => isPlainObject(item) && item.type === "agentMessage")
          : null;
        const output =
          finalOutput ??
          normalizeFinalMessage(completedItem?.text) ??
          normalizeFinalMessage(deltaOutputs.get(latestDeltaItemId));
        if (!output) {
          failProtocol();
          return;
        }
        if (emittedDeltaBytes === 0) {
          onEvent?.("delta", { text: output });
        }
        settle(null, { conversationId: threadId, output });
        return;
      }
      // App Server emits normal thread, turn, item, warning, and usage
      // notifications around the response. They are informational for this
      // deliberately narrow adapter and must not break a valid chat turn.
    };
    const processLine = (line) => {
      if (line.length > MAX_PROTOCOL_LINE_BYTES) {
        failProtocol();
        return;
      }
      const trimmed = line.at(-1) === 0x0d ? line.subarray(0, -1) : line;
      if (trimmed.length === 0) {
        return;
      }
      try {
        processMessage(JSON.parse(trimmed.toString("utf8")));
      } catch {
        failProtocol();
      }
    };

    child.stdout.on("data", (chunk) => {
      if (settled || outcome) {
        return;
      }
      const bytes = Buffer.from(chunk);
      stdoutBytes += bytes.length;
      if (stdoutBytes > MAX_PROTOCOL_STDOUT_BYTES) {
        failProtocol();
        return;
      }
      stdout = Buffer.concat([stdout, bytes]);
      let newline = stdout.indexOf(0x0a);
      while (newline >= 0 && !settled && !outcome) {
        const line = stdout.subarray(0, newline);
        stdout = stdout.subarray(newline + 1);
        processLine(line);
        newline = stdout.indexOf(0x0a);
      }
      if (!settled && !outcome && stdout.length > MAX_PROTOCOL_LINE_BYTES) {
        failProtocol();
      }
    });
    child.stderr.on("data", (chunk) => {
      if (!settled && !outcome) {
        stderrBytes += Buffer.byteLength(chunk);
        if (stderrBytes > MAX_PROTOCOL_STDERR_BYTES) {
          failProtocol();
        }
      }
    });
    const handleStreamError = () => settle(new Error("stream"));
    child.stdin.on("error", handleStreamError);
    child.stdout.on("error", handleStreamError);
    child.stderr.on("error", handleStreamError);
    child.once("error", () => settle(new Error("process")));
    child.once("close", () => {
      if (!outcome) {
        outcome = { error: new Error("closed"), result: undefined };
      }
      complete();
    });
    timeout = setTimeout(() => settle(new Error("timeout")), turnTimeoutMs);
    if (signal?.aborted) {
      abortOperation();
      return;
    }
    signal?.addEventListener?.("abort", abortOperation, { once: true });
    write({
      id: 0,
      method: "initialize",
      params: {
        capabilities: {
          experimentalApi: true,
        },
        clientInfo: {
          name: "relmio",
          title: "Relmio",
          version: packageVersion,
        },
      },
    });
    onEvent?.("progress", { phase: "initializing" });
  });
}

export function hashCodexChatCredential(value) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    value.length > 256 ||
    !/^[A-Za-z0-9_-]+$/u.test(value)
  ) {
    throw new TypeError("The local client credential is invalid.");
  }
  return createHash("sha256").update(value, "utf8").digest();
}

export function loadCodexChatGatewayConfig(environment = process.env) {
  const host = environment?.RELMIO_GATEWAY_HOST;
  const portText = environment?.RELMIO_GATEWAY_PORT;
  const verifier = environment?.RELMIO_GATEWAY_TOKEN_SHA256;
  const packageVersion = environment?.RELMIO_PACKAGE_VERSION;
  if (
    !isLoopbackListenHost(host) ||
    typeof portText !== "string" ||
    !/^[1-9][0-9]{0,4}$/u.test(portText) ||
    Number(portText) < 1024 ||
    Number(portText) > 65_535 ||
    typeof verifier !== "string" ||
    !/^[a-f0-9]{64}$/u.test(verifier)
  ) {
    throw new TypeError("Codex Chat gateway configuration is invalid.");
  }
  try {
    return {
      host,
      packageVersion: validatePackageVersion(packageVersion),
      port: Number(portText),
      tokenVerifier: Buffer.from(verifier, "hex"),
    };
  } catch {
    throw new TypeError("Codex Chat gateway configuration is invalid.");
  }
}

export async function startCodexChatGateway({
  host = "127.0.0.1",
  port = 14_501,
  tokenVerifier,
  packageVersion = "unknown",
  spawnProcess = spawn,
  terminationGraceMs = TERMINATION_GRACE_MS,
  turnTimeoutMs = TURN_TIMEOUT_MS,
  keepaliveIntervalMs = KEEPALIVE_INTERVAL_MS,
} = {}) {
  if (!isLoopbackListenHost(host)) {
    throw new TypeError("Codex Chat must listen on a literal loopback-safe host.");
  }
  if (!Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new TypeError("The Codex Chat port is invalid.");
  }
  if (typeof spawnProcess !== "function") {
    throw new TypeError("A Codex App Server process boundary is required.");
  }
  if (
    !Number.isSafeInteger(terminationGraceMs) ||
    terminationGraceMs < 1 ||
    terminationGraceMs > 10_000
  ) {
    throw new TypeError("The Codex Chat termination grace period is invalid.");
  }
  if (
    !Number.isSafeInteger(turnTimeoutMs) ||
    turnTimeoutMs < 1 ||
    turnTimeoutMs > 600_000
  ) {
    throw new TypeError("The Codex Chat turn timeout is invalid.");
  }
  if (
    !Number.isSafeInteger(keepaliveIntervalMs) ||
    keepaliveIntervalMs < 1 ||
    keepaliveIntervalMs > 60_000
  ) {
    throw new TypeError("The Codex Chat keepalive interval is invalid.");
  }
  const verifier = validateTokenVerifier(tokenVerifier);
  const safePackageVersion = validatePackageVersion(packageVersion);
  let activeOperation = false;
  const server = createServer({ maxHeaderSize: MAX_HEADER_BYTES }, (request, response) => {
    if (headerOccurrences(request, "host") !== 1 || !validLoopbackHost(request.headers.host)) {
      sendError(response, 421, "host_rejected");
      return;
    }
    if (headerOccurrences(request, "origin") > 0) {
      sendError(response, 403, "origin_rejected");
      return;
    }
    if (
      headerOccurrences(request, "authorization") > 1 ||
      headerOccurrences(request, "content-type") > 1
    ) {
      sendError(response, 400, "invalid_request");
      return;
    }
    if (request.method === "GET" && request.url === "/health") {
      sendJson(response, 200, { status: "ok" });
      return;
    }
    if (!hasValidBearer(request, verifier)) {
      sendError(response, 401, "unauthorized");
      return;
    }
    if (request.method === "GET" && request.url === "/auth/verify") {
      sendJson(response, 200, { status: "ok" });
      return;
    }
    if (request.method !== "POST" || request.url !== "/chat") {
      sendError(response, 404, "not_found");
      return;
    }
    if (!parseContentType(request)) {
      sendError(response, 415, "content_type_required");
      return;
    }
    if (activeOperation) {
      sendError(response, 429, "busy");
      return;
    }
    activeOperation = true;
    const controller = new AbortController();
    let disconnected = false;
    let eventStream;
    const onDisconnect = () => {
      if (request.aborted || !response.writableEnded) {
        disconnected = true;
        controller.abort();
      }
    };
    request.once("aborted", onDisconnect);
    response.once("close", onDisconnect);
    void readChatRequest(request)
      .then((chat) => {
        if (disconnected) {
          throw new Error("unavailable");
        }
        if (acceptsEventStream(request)) {
          eventStream = startEventStream(response, keepaliveIntervalMs);
        }
        return createAppServerOperation({
          ...chat,
          packageVersion: safePackageVersion,
          onEvent: eventStream?.send,
          onFailure: eventStream
            ? (code) => eventStream.fail(code)
            : undefined,
          signal: controller.signal,
          spawnProcess,
          terminationGraceMs,
          turnTimeoutMs,
        });
      })
      .then((result) => {
        if (!disconnected && !response.writableEnded) {
          if (eventStream) eventStream.complete(result);
          else sendJson(response, 200, result);
        }
      })
      .catch((error) => {
        if (disconnected || response.writableEnded) {
          return;
        }
        if (eventStream) {
          eventStream.fail();
          return;
        }
        const status = error?.status;
        const code = error?.code;
        if (status === 413 || status === 499 || code === "invalid_json" || code === "invalid_request") {
          sendError(response, status === 499 ? 400 : status ?? 400, code === "invalid_json" ? "invalid_json" : "invalid_request");
          return;
        }
        sendError(response, 503, "unavailable");
      })
      .finally(() => {
        eventStream?.dispose();
        activeOperation = false;
      });
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  server.keepAliveTimeout = 5_000;
  server.maxHeadersCount = 32;

  await new Promise((resolvePromise, rejectPromise) => {
    server.once("error", rejectPromise);
    server.listen(port, host, () => {
      server.off("error", rejectPromise);
      resolvePromise();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    server.close();
    throw new Error("Codex Chat could not determine its listener address.");
  }
  return {
    origin: `http://127.0.0.1:${address.port}`,
    async close() {
      await new Promise((resolvePromise, rejectPromise) => {
        server.close((error) => (error ? rejectPromise(error) : resolvePromise()));
      });
    },
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  startCodexChatGateway(loadCodexChatGatewayConfig()).catch(() => {
    process.stderr.write("Relmio Codex Chat could not start.\n");
    process.exitCode = 1;
  });
}

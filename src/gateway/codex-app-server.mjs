import { spawn } from "node:child_process";
import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { StringDecoder } from "node:string_decoder";
import { pathToFileURL } from "node:url";
import { WebSocketServer, WebSocket } from "ws";
import { getAccessToken, listSiwcThreadBindings, readRegistration, recordSiwcThreadBinding, resolveSiwcStorageRoot } from "../services/siwc-session.mjs";
import { listSiwcModels } from "./openai-oauth-sidecar.mjs";

export const appServerArgs = [
  "app-server", "--listen", "stdio://", "--strict-config",
  "-c", 'model_provider="openai_chatgpt_plan"',
  "-c", 'model_providers.openai_chatgpt_plan.name="ChatGPT plan"',
  "-c", 'model_providers.openai_chatgpt_plan.base_url="https://api.openai.com/v1"',
  "-c", 'model_providers.openai_chatgpt_plan.env_key="ACCESS_TOKEN"',
  "-c", 'model_providers.openai_chatgpt_plan.wire_api="responses"',
  "-c", "model_providers.openai_chatgpt_plan.requires_openai_auth=false",
  "-c", "model_providers.openai_chatgpt_plan.supports_websockets=false",
  "-c", "model_providers.openai_chatgpt_plan.stream_max_retries=0",
  "-c", "model_providers.openai_chatgpt_plan.request_max_retries=0",
  "-c", "shell_environment_policy.ignore_default_excludes=false",
  "-c", 'shell_environment_policy.filters.ACCESS_TOKEN="exclude"',
  "-c", 'shell_environment_policy.filters."*TOKEN*"="exclude"',
];
const MAX_LINE = 1024 * 1024;
const validId = (value) => typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(value);
const validHost = (value) => /^(?:localhost|127\.0\.0\.1|\[::1\])(?::[0-9]{1,5})?$/u.test(value ?? "");
const admission = (request, tokenVerifier) => {
  if (request.rawHeaders.filter((name, i) => i % 2 === 0 && name.toLowerCase() === "authorization").length !== 1 || request.headers.origin !== undefined || !validHost(request.headers.host) || request.url !== "/") return false;
  const match = /^Bearer ([A-Za-z0-9_-]{1,256})$/u.exec(request.headers.authorization ?? "");
  return Boolean(match && timingSafeEqual(createHash("sha256").update(match[1]).digest(), tokenVerifier));
};
function unsupportedToolConfig(value) {
  const pending = [value];
  let count = 0;
  while (pending.length) {
    if (++count > 10_000) return true;
    const current = pending.pop();
    if (!current || typeof current !== "object") continue;
    if (current.defer_loading === true || current.deferLoading === true ||
        ["tool_search", "image_generation", "file_search", "code_interpreter"].includes(current.type)) return true;
    for (const nested of Object.values(current)) if (nested && typeof nested === "object") pending.push(nested);
  }
  return false;
}
function unsafeThreadParams(method, params) {
  if (!params || typeof params !== "object" || Array.isArray(params)) return true;
  const unsafeKey = (key) => /^(?:config|provider|modelprovider|modelproviders|baseurl|envkey|wireapi|requiresopenaiauth|supportswebsockets|streammaxretries|requestmaxretries|allowprovidermodelfallback|agentsenabled)/u
    .test(key.replace(/[^a-z]/giu, "").toLowerCase());
  if (Object.keys(params).some(unsafeKey)) return true;
  if (["thread/resume", "thread/fork"].includes(method) &&
      Object.keys(params).some((key) => /^(?:path|history|rolloutpath|historyitems)$/u.test(key.replace(/[^a-z]/giu, "").toLowerCase()))) return true;
  return [params.collaborationMode?.settings, params.collaboration_mode?.settings]
    .some((settings) => settings && typeof settings === "object" && Object.keys(settings).some(unsafeKey));
}
export function loadCodexRelayConfig(environment = process.env) {
  const host = environment.RELMIO_GATEWAY_HOST;
  const port = Number(environment.RELMIO_GATEWAY_PORT);
  const registrationId = environment.RELMIO_REGISTRATION_ID;
  const runtimeId = environment.RELMIO_RUNTIME_ID;
  const tokenHash = environment.RELMIO_GATEWAY_TOKEN_SHA256;
  const version = environment.RELMIO_PACKAGE_VERSION;
  if (!["127.0.0.1", "0.0.0.0", "::1"].includes(host) || !Number.isInteger(port) || port < 1024 || port > 65535 || !validId(registrationId) || !validId(runtimeId) || !/^[a-f0-9]{64}$/u.test(tokenHash ?? "") || !/^[A-Za-z0-9.+-]{1,64}$/u.test(version ?? "")) throw new TypeError("Invalid Codex relay configuration.");
  return { host, port, registration: { storageRoot: resolveSiwcStorageRoot({ env: environment }), registrationId }, runtimeId, tokenVerifier: Buffer.from(tokenHash, "hex"), packageVersion: version };
}

export async function startCodexAppServerRelay({ host = "127.0.0.1", port = 4500, registration, runtimeId, tokenVerifier, packageVersion = "unknown", spawnProcess = spawn, getToken = getAccessToken, readAccount = readRegistration, listModels = listSiwcModels, readBindings = listSiwcThreadBindings, saveBinding = recordSiwcThreadBinding, childEnv = process.env } = {}) {
  if (!["127.0.0.1", "0.0.0.0", "::1"].includes(host) || !Number.isInteger(port) || port < 0 || port > 65535 || !registration?.storageRoot || !validId(registration.registrationId) || !validId(runtimeId) || !Buffer.isBuffer(tokenVerifier) || tokenVerifier.length !== 32 || !/^[A-Za-z0-9.+-]{1,64}$/u.test(packageVersion)) throw new TypeError("Invalid Codex relay configuration.");
  const server = createServer((request, response) => {
    if (request.headers.origin !== undefined) { response.writeHead(403); response.end(); return; }
    if (request.method === "GET" && ["/healthz", "/readyz"].includes(request.url)) { response.writeHead(200); response.end(); return; }
    response.writeHead(404); response.end();
  });
  const wsServer = new WebSocketServer({ noServer: true, maxPayload: MAX_LINE });
  const clients = new Map();
  const children = new Set();
  const pendingUpgrades = new Map();
  let quiescing = false;
  // The protected registry survives relay restarts; unknown threads fail closed.
  const threads = new Map();
  server.on("upgrade", async (request, socket, head) => {
    if (quiescing) { socket.destroy(); return; }
    if (!admission(request, tokenVerifier)) { socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n"); socket.destroy(); return; }
    const controller = new AbortController();
    pendingUpgrades.set(socket, controller);
    socket.once("close", () => controller.abort());
    let lease, account, models, persisted;
    try {
      [lease, account] = await Promise.all([
        getToken(registration, { runtimeId, minValidityMs: 60_000, signal: controller.signal })
          .catch((error) => { throw Object.assign(new Error("session_unavailable"), { sessionRecovery: error?.recovery }); }),
        readAccount(registration),
      ]);
      models = await listModels({ ...registration, runtimeId, getToken: async () => lease, signal: controller.signal });
      persisted = await readBindings(registration, { runtimeId });
      if (!account?.clientId || !account.identity?.issuer || !account.identity?.subject ||
          !Array.isArray(models) || !models.length || !Array.isArray(persisted)) throw new Error("unavailable");
      const selected = `${account.identity.issuer}\0${account.clientId}\0${account.identity.subject}`;
      for (const item of persisted) {
        if (!validId(item.threadId) || typeof item.model !== "string" ||
            `${item.identity?.issuer}\0${item.identity?.clientId}\0${item.identity?.subject}` !== selected) throw new Error("invalid_binding");
        threads.set(item.threadId, { binding: selected, model: item.model });
      }
    } catch (error) {
      if (!socket.destroyed) {
        const recovery = ["reauthorize", "enable-plan", "resolve-handoff", "fix-configuration"].includes(error?.sessionRecovery)
          ? error.sessionRecovery : "retry-later";
        const status = recovery === "reauthorize" || recovery === "resolve-handoff" ? 409
          : recovery === "enable-plan" ? 403 : 503;
        const reason = status === 409 ? "Conflict" : status === 403 ? "Forbidden" : "Service Unavailable";
        const body = JSON.stringify({ error: { code: "registration_unavailable" }, recovery });
        socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Type: application/json\r\nCache-Control: no-store\r\nContent-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
      }
      return;
    } finally { pendingUpgrades.delete(socket); }
    if (socket.destroyed || quiescing) { socket.destroy(); return; }
    wsServer.handleUpgrade(request, socket, head, (ws) => {
      clients.set(ws, null);
      let child;
      try {
        child = spawnProcess("codex", appServerArgs, { cwd: "/workspace", shell: false, stdio: ["pipe", "pipe", "pipe"], windowsHide: true, env: { ...childEnv, ACCESS_TOKEN: lease.accessToken } });
      } catch { ws.close(1011, "Child unavailable"); return; }
      if (!child?.stdin?.write || !child?.stdout?.on || !child?.stderr?.on || !child?.kill) { ws.close(1011, "Child unavailable"); return; }
      children.add(child);
      const identity = { issuer: account.identity.issuer, clientId: account.clientId, subject: account.identity.subject };
      const binding = `${identity.issuer}\0${identity.clientId}\0${identity.subject}`;
      const knownSecrets = [lease.accessToken, account.session?.accessToken, account.session?.refreshToken, account.session?.idToken]
        .filter((value) => typeof value === "string" && value.length >= 8);
      const allowedModels = new Set(models.map((model) => model.slug));
      const pending = new Map();
      const serverRequests = new Set();
      const decoder = new StringDecoder("utf8");
      let buffer = "";
      let closed = false;
      const close = (code = 1011) => {
        if (closed) return;
        closed = true;
        clearTimeout(expiry);
        clients.delete(ws);
        if (ws.readyState === WebSocket.OPEN) ws.close(code, code === 1000 ? "" : "Reconnect to continue");
        try { child.kill("SIGTERM"); } catch { /* The caller still receives a closed socket. */ }
        const killTimer = setTimeout(() => {
          if (children.has(child)) {
            try { child.kill("SIGKILL"); } catch { /* The container stop is the final boundary. */ }
          }
        }, 2000);
        killTimer.unref?.();
      };
      clients.set(ws, close);
      const expiryMs = typeof lease.expiresAt === "number" ? lease.expiresAt : Date.parse(lease.expiresAt);
      // Existing sockets are not silently moved to a new child or replayed after expiry.
      const expiry = setTimeout(() => close(1012), Number.isFinite(expiryMs) ? Math.max(1, expiryMs - Date.now() - 30_000) : 1);
      expiry.unref?.();
      const forward = async (line) => {
        if (closed) return;
        const message = JSON.parse(line);
        if (message?.method === undefined && message?.id !== undefined && pending.has(message.id)) {
          const requested = pending.get(message.id);
          pending.delete(message.id);
          if (!message.error && requested.method === "thread/resume" &&
              message.result?.thread?.id !== requested.threadId) throw new Error("foreign_resume");
          if (!message.error && ["thread/start", "thread/fork"].includes(requested.method)) {
            const threadId = message.result?.thread?.id;
            if (!validId(threadId) || !allowedModels.has(requested.model) ||
                requested.method === "thread/fork" && threadId === requested.threadId) throw new Error("invalid_thread");
            await saveBinding(registration, { runtimeId, threadId, model: requested.model, identity });
            if (closed) return;
            threads.set(threadId, { binding, model: requested.model });
          }
          if (!message.error && requested.method === "thread/list") {
            if (!Array.isArray(message.result?.data)) throw new Error("invalid_threads");
            message.result.data = message.result.data.filter((thread) => threads.get(thread?.id)?.binding === binding);
          }
        }
        if (message?.method !== undefined && message?.id !== undefined) {
          if (typeof message.method !== "string" || /^(?:account|auth|login|logout)(?:\/|$)/iu.test(message.method) ||
              message.method.startsWith("config/") || message.params?.threadId !== undefined && threads.get(message.params.threadId)?.binding !== binding ||
              serverRequests.size >= 128 || serverRequests.has(message.id)) throw new Error("invalid_server_request");
          serverRequests.add(message.id);
        }
        if (message?.method?.startsWith("account/") || message?.method?.startsWith("auth/")) return;
        if (ws.readyState === WebSocket.OPEN) {
          if (ws.bufferedAmount > MAX_LINE * 2) throw new Error("relay_overloaded");
          let outbound = JSON.stringify(message);
          for (const secret of knownSecrets) outbound = outbound.replaceAll(secret, "[redacted]");
          ws.send(outbound);
        }
      };
      let outputQueue = Promise.resolve();
      let queuedBytes = 0;
      child.stdout.on("data", (chunk) => {
        buffer += decoder.write(chunk);
        if (Buffer.byteLength(buffer) > MAX_LINE) { close(); return; }
        let newline;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline).trimEnd();
          buffer = buffer.slice(newline + 1);
          const bytes = Buffer.byteLength(line);
          queuedBytes += bytes;
          if (queuedBytes > MAX_LINE * 2) { close(1013); return; }
          outputQueue = outputQueue.then(async () => {
            try { await forward(line); } finally { queuedBytes -= bytes; }
          }).catch(() => close());
        }
      });
      child.stdout.once("error", () => close());
      child.stderr.on("data", () => {}); // Never expose provider or child stderr.
      child.stderr.once("error", () => close());
      child.stdin.once("error", () => close());
      child.once("error", () => close());
      child.once("close", () => { children.delete(child); close(1012); });
      ws.on("message", (data, binary) => {
        if (binary || data.length > MAX_LINE) { close(1008); return; }
        let message;
        try { message = JSON.parse(data.toString("utf8")); } catch { close(1008); return; }
        if (!message || typeof message !== "object" || Array.isArray(message) ||
            (message.id !== undefined && typeof message.id !== "number" && typeof message.id !== "string")) { close(1008); return; }
        if (message.method === undefined && message.id !== undefined && (message.result !== undefined || message.error !== undefined)) {
          if (!serverRequests.delete(message.id)) { close(1008); return; }
          try { child.stdin.write(`${JSON.stringify(message)}\n`); } catch { close(); }
          return;
        }
        if (typeof message.method !== "string") { close(1008); return; }
        const method = message.method;
        const blocked = /^(?:account|auth|app\/login|login|logout)(?:\/|$)/iu.test(method)
          || method.startsWith("config/") && method !== "config/read"
          || /^(?:marketplace\/(?:add|remove|upgrade)|plugin\/(?:install|uninstall)|externalAgentConfig\/import|experimentalFeature\/enablement\/set|mcpServer\/oauth\/login)$/iu.test(method)
          || method === "thread/loaded/list"
          || unsupportedToolConfig(message.params)
          || ["thread/start", "thread/resume", "thread/fork", "turn/start"].includes(method) && unsafeThreadParams(method, message.params);
        let allowed = !blocked;
        if (method === "initialize") {
          if (!message.params || typeof message.params !== "object" || Array.isArray(message.params)) allowed = false;
          else message.params.clientInfo = { name: "Relmio", title: "Relmio", version: packageVersion };
        }
        if (method === "thread/start") {
          const model = message.params?.model ?? models[0]?.slug;
          allowed = allowed && allowedModels.has(model);
          if (allowed) message.params = { ...message.params, model, serviceName: "Relmio" };
        }
        if (method === "thread/resume") {
          const known = threads.get(message.params?.threadId);
          const selectedModel = message.params?.model ?? known?.model;
          allowed = allowed && known?.binding === binding && allowedModels.has(selectedModel);
        } else if (message.params?.threadId !== undefined) {
          allowed = allowed && threads.get(message.params.threadId)?.binding === binding;
        }
        if (method === "thread/fork" && message.params?.model !== undefined) {
          allowed = allowed && allowedModels.has(message.params.model);
        }
        if (method === "turn/start") {
          if (message.params?.model !== undefined) allowed = allowed && allowedModels.has(message.params.model);
          for (const mode of [message.params?.collaborationMode, message.params?.collaboration_mode]) {
            const nestedModel = mode?.settings?.model;
            if (nestedModel !== undefined) allowed = allowed && allowedModels.has(nestedModel);
          }
        }
        if (!allowed) {
          if (message.id !== undefined && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ id: message.id, error: { code: -32602, message: "The method, model or thread is not available for this registration." } }));
          else close(1008);
          return;
        }
        if (pending.size >= 128 || message.id !== undefined && pending.has(message.id) || child.stdin.writableLength > MAX_LINE * 2) { close(1013); return; }
        if (message.id !== undefined) pending.set(message.id, { method, model: message.params?.model ?? threads.get(message.params?.threadId)?.model,
          threadId: message.params?.threadId });
        try { child.stdin.write(`${JSON.stringify(message)}\n`); } catch { close(); }
      });
      ws.once("close", () => close(1000));
      ws.once("error", () => close());
    });
  });
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(port, host, resolve); });
  const address = server.address();
  return { origin: `ws://127.0.0.1:${address.port}`, async close() {
    quiescing = true;
    for (const [socket, controller] of pendingUpgrades) { controller.abort(); socket.destroy(); }
    // Signal each owned child now instead of waiting for platform-ordered socket close events.
    for (const [ws, closeConnection] of clients) { closeConnection?.(1001); ws.terminate(); }
    wsServer.close();
    await new Promise((resolve) => server.close(resolve));
  } };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startCodexAppServerRelay(loadCodexRelayConfig()).then((relay) => {
    for (const signal of ["SIGTERM", "SIGINT"]) process.once(signal, () => { void relay.close(); });
  }).catch(() => { process.stderr.write("Relmio Codex relay could not start.\n"); process.exitCode = 1; });
}

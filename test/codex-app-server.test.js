import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter, once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import WebSocket from "ws";
import { appServerArgs, startCodexAppServerRelay } from "../src/gateway/codex-app-server.mjs";
import { commitAuthorization, setPlanEnabled } from "../src/services/siwc-session.mjs";

const credential = "direct_local_credential_123456789";
const registration = { storageRoot: "/tmp/relay-test", registrationId: "selected_1" };
function fakeChild({ resumeOverride } = {}) {
  const child = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.messages = [];
  child.signals = [];
  child.kill = (signal) => { child.signals.push(signal); queueMicrotask(() => child.emit("close", 0)); return true; };
  child.stdin.write = (line) => {
    const request = JSON.parse(line);
    child.messages.push(request);
    child.emit("written", request);
    const result = request.method === "thread/start" ? { thread: { id: "thread_123" } }
      : request.method === "thread/resume" ? { thread: { id: resumeOverride ?? request.params.threadId } }
      : request.method === "thread/fork" ? { thread: { id: "fork_456" } }
      : request.method === "thread/list" ? { data: [{ id: "thread_123" }, { id: "foreign_thread" }], nextCursor: null }
      : {};
    if (request.method && request.id !== undefined) queueMicrotask(() => child.stdout.emit("data", Buffer.from(`${JSON.stringify({ id: request.id, result })}\n`)));
    return true;
  };
  return child;
}
async function connect(origin, headers = { Authorization: `Bearer ${credential}` }) {
  const socket = new WebSocket(origin, { headers });
  await once(socket, "open");
  return socket;
}
async function rpc(socket, message) {
  const arrived = once(socket, "message");
  socket.send(JSON.stringify(message));
  const [data] = await arrived;
  return JSON.parse(data.toString("utf8"));
}
async function rejectedHandshake(origin, headers) {
  const socket = new WebSocket(origin, { headers });
  const connectionErrors = [];
  socket.on("error", (error) => connectionErrors.push(error));
  const [pending, response] = await once(socket, "unexpected-response");
  const chunks = [];
  try {
    for await (const chunk of response) chunks.push(Buffer.from(chunk));
  } catch (error) {
    if (response.statusCode !== 401) throw error;
  }
  const closed = socket.readyState === WebSocket.CLOSED ? Promise.resolve()
    : new Promise((resolve) => socket.once("close", resolve));
  pending.destroy();
  socket.terminate();
  await closed;
  assert.equal(socket.readyState, WebSocket.CLOSED);
  assert.ok(connectionErrors.length <= 1);
  return { status: response.statusCode, body: Buffer.concat(chunks).toString("utf8") };
}

function runtime() {
  const children = [];
  const envs = [];
  let clientId = "issued_1";
  let token = "token_1";
  const bindings = new Map();
  const start = () => startCodexAppServerRelay({
    host: "127.0.0.1", port: 0, registration, runtimeId: "runtime_1",
    packageVersion: "0.5.0", tokenVerifier: createHash("sha256").update(credential).digest(), childEnv: {},
    getToken: async (ref, options) => { assert.deepEqual(ref, registration); assert.equal(options.runtimeId, "runtime_1"); return { accessToken: token, expiresAt: Date.now() + 300_000 }; },
    readAccount: async () => ({ clientId, identity: { issuer: "https://auth.openai.com", subject: "sub_1" },
      session: { refreshToken: "refresh_secret_123456789", idToken: "id_secret_123456789" } }),
    listModels: async () => [{ slug: "gpt-6.1-sol", display_name: "GPT 6.1 Sol" }],
    readBindings: async () => [...bindings.values()].filter((item) => item.identity.clientId === clientId),
    saveBinding: async (_registration, binding) => {
      const saved = { threadId: binding.threadId, model: binding.model, identity: binding.identity };
      bindings.set(saved.threadId, saved);
      return saved;
    },
    spawnProcess(command, args, options) {
      assert.equal(command, "codex");
      assert.deepEqual(args, appServerArgs);
      envs.push(options.env.ACCESS_TOKEN);
      const child = fakeChild(); children.push(child); return child;
    },
  });
  return { start, children, envs, setClientId: (id) => { clientId = id; }, setToken: (value) => { token = value; } };
}

test("direct relay rejects missing bearer and Origin before starting app-server", async (t) => {
  const fixture = runtime();
  const relay = await fixture.start(); t.after(() => relay.close());
  for (const headers of [{}, { Authorization: "Bearer wrong" }, { Authorization: `Bearer ${credential}`, Origin: "https://example.test" }]) {
    const rejected = await rejectedHandshake(relay.origin, headers);
    assert.equal(rejected.status, 401);
  }
  assert.equal(fixture.children.length, 0);
});

test("authenticated WebSocket admission reports frozen rotating-session recovery without spawning", async (t) => {
  let spawnCount = 0;
  const relay = await startCodexAppServerRelay({
    host: "127.0.0.1", port: 0, registration, runtimeId: "runtime_1",
    packageVersion: "0.5.0", tokenVerifier: createHash("sha256").update(credential).digest(),
    getToken: async () => { throw Object.assign(new Error("unknown refresh outcome"), { recovery: "reauthorize" }); },
    readAccount: async () => ({ clientId: "issued_1", identity: { issuer: "https://auth.openai.com", subject: "sub_1" } }),
    listModels: async () => { throw new Error("catalog must not be fetched"); },
    readBindings: async () => [],
    spawnProcess() { spawnCount++; throw new Error("child must not start"); },
  });
  t.after(() => relay.close());
  const rejected = await rejectedHandshake(relay.origin, { Authorization: `Bearer ${credential}` });
  assert.equal(rejected.status, 409);
  assert.deepEqual(JSON.parse(rejected.body), {
    error: { code: "registration_unavailable" }, recovery: "reauthorize",
  });
  assert.equal(spawnCount, 0);
});

test("direct relay keeps JSON-RPC transport but pins identity, model and thread to selected registration", async (t) => {
  const fixture = runtime();
  const relay = await fixture.start(); t.after(() => relay.close());
  const first = await connect(relay.origin); t.after(() => first.terminate());
  assert.equal((await fetch(`${relay.origin.replace("ws:", "http:")}/healthz`)).status, 200);
  assert.deepEqual((await rpc(first, { id: 0, method: "initialize", params: { clientInfo: { name: "other", version: "1" }, capabilities: {} } })).result, {});
  assert.deepEqual(fixture.children[0].messages[0].params.clientInfo, { name: "Relmio", title: "Relmio", version: "0.5.0" });
  assert.deepEqual((await rpc(first, { id: 1, method: "thread/start", params: {} })).result.thread, { id: "thread_123" });
  assert.equal(fixture.children[0].messages[1].params.model, "gpt-6.1-sol");
  assert.equal(fixture.children[0].messages[1].params.serviceName, "Relmio");
  assert.equal((await rpc(first, { id: 2, method: "account/login/start", params: { type: "chatgptDeviceCode" } })).error.code, -32602);
  assert.equal((await rpc(first, { id: 3, method: "thread/start", params: { model: "not-entitled" } })).error.code, -32602);
  assert.equal((await rpc(first, { id: 4, method: "turn/start", params: { threadId: "foreign_thread" } })).error.code, -32602);
  assert.equal((await rpc(first, { id: 8, method: "config/batchWrite", params: { model_provider: "other" } })).error.code, -32602);
  assert.deepEqual((await rpc(first, { id: 6, method: "thread/list", params: {} })).result.data, [{ id: "thread_123" }]);
  assert.equal((await rpc(first, { id: 7, method: "turn/start", params: { threadId: "thread_123", model: "not-entitled", input: [{ type: "text", text: "Hi" }] } })).error.code, -32602);
  for (const [method, params] of [
    ["thread/start", { model: "gpt-6.1-sol", config: { "model_providers.openai_chatgpt_plan.base_url": "https://attacker.test/v1" } }],
    ["thread/start", { model: "gpt-6.1-sol", modelProvider: "openai" }],
    ["thread/resume", { threadId: "thread_123", config: { agents: { enabled: true } } }],
    ["thread/fork", { threadId: "thread_123", model_provider: "other" }],
    ["thread/fork", { threadId: "thread_123", model: "not-entitled" }],
    ["turn/start", { threadId: "thread_123", input: [{ type: "text", text: "Hi" }],
      collaborationMode: { settings: { model: "not-entitled" } } }],
  ]) {
    assert.equal((await rpc(first, { id: 30, method, params })).error.code, -32602);
  }
  assert.equal(fixture.children[0].messages.length, 3);
  fixture.setClientId("issued_2");
  const second = await connect(relay.origin); t.after(() => second.terminate());
  assert.equal((await rpc(second, { id: 5, method: "thread/resume", params: { threadId: "thread_123" } })).error.code, -32602);
  assert.equal(fixture.children[1].messages.length, 0);
});

test("inline client tools remain available while deferred tool search is rejected", async (t) => {
  const fixture = runtime();
  const relay = await fixture.start(); t.after(() => relay.close());
  const socket = await connect(relay.origin); t.after(() => socket.terminate());
  const inline = { name: "lookup", description: "Lookup locally", inputSchema: { type: "object", properties: {} } };
  assert.deepEqual((await rpc(socket, { id: 1, method: "thread/start",
    params: { model: "gpt-6.1-sol", dynamicTools: [inline] } })).result.thread, { id: "thread_123" });
  assert.deepEqual(fixture.children[0].messages[0].params.dynamicTools, [inline]);
  assert.equal((await rpc(socket, { id: 2, method: "thread/start",
    params: { model: "gpt-6.1-sol", dynamicTools: [{ ...inline, deferLoading: true }] } })).error.code, -32602);
  assert.equal((await rpc(socket, { id: 3, method: "experimentalFeature/enablement/set",
    params: { apps: true } })).error.code, -32602);
  assert.equal(fixture.children[0].messages.length, 1);
});

test("reconnect obtains a renewed token without replaying a previous turn", async (t) => {
  const fixture = runtime();
  const relay = await fixture.start(); t.after(() => relay.close());
  const first = await connect(relay.origin);
  await rpc(first, { id: 1, method: "thread/start", params: { model: "gpt-6.1-sol" } });
  first.close(); await once(first, "close");
  fixture.setToken("token_2");
  const second = await connect(relay.origin); t.after(() => second.terminate());
  assert.deepEqual(fixture.envs, ["token_1", "token_2"]);
  assert.deepEqual((await rpc(second, { id: 2, method: "thread/resume", params: { threadId: "thread_123" } })).result.thread, { id: "thread_123" });
  assert.equal(fixture.children[1].messages[0].params.model, undefined);
  assert.equal(fixture.children[1].messages.some((message) => message.method === "turn/start"), false);
});

test("relay shutdown closes active sockets and terminates their owned children", async (t) => {
  const fixture = runtime();
  const relay = await fixture.start(); t.after(() => relay.close().catch(() => {}));
  const socket = await connect(relay.origin);
  t.after(() => socket.terminate());
  const closed = once(socket, "close");
  const closing = relay.close();
  // Shutdown signals owned children itself; socket close-event order differs by platform.
  assert.deepEqual(fixture.children[0].signals, ["SIGTERM"]);
  await closing;
  await closed;
  assert.deepEqual(fixture.children[0].signals, ["SIGTERM"]);
  assert.equal(fixture.children[0].messages.length, 0);
});

test("direct relay redacts only known selected credentials from child protocol output", async (t) => {
  const fixture = runtime();
  fixture.setToken("provider_access_123456789");
  const relay = await fixture.start(); t.after(() => relay.close());
  const socket = await connect(relay.origin); t.after(() => socket.terminate());
  const received = once(socket, "message");
  fixture.children[0].stdout.emit("data", Buffer.from(`${JSON.stringify({
    method: "item/agentMessage/delta",
    params: { delta: "provider_access_123456789 refresh_secret_123456789 id_secret_123456789 Bearer unrelated" },
  })}\n`));
  const [bytes] = await received;
  const wire = bytes.toString("utf8");
  assert.doesNotMatch(wire, /provider_access_123456789|refresh_secret_123456789|id_secret_123456789/u);
  assert.match(wire, /Bearer unrelated/u);
});

test("relay preserves UTF-8 JSON-RPC frames split across child stdout chunks", async (t) => {
  const fixture = runtime();
  const relay = await fixture.start(); t.after(() => relay.close());
  const socket = await connect(relay.origin); t.after(() => socket.terminate());
  const message = Buffer.from(`${JSON.stringify({ method: "item/agentMessage/delta", params: { delta: "café" } })}\n`);
  const index = message.indexOf(Buffer.from("é")[0]);
  const received = once(socket, "message");
  fixture.children[0].stdout.emit("data", message.subarray(0, index + 1));
  fixture.children[0].stdout.emit("data", message.subarray(index + 1));
  const [bytes] = await received;
  assert.equal(JSON.parse(bytes.toString("utf8")).params.delta, "café");
});

test("relay forwards server-initiated JSON-RPC requests and only their matching replies", async (t) => {
  const fixture = runtime();
  const relay = await fixture.start(); t.after(() => relay.close());
  const socket = await connect(relay.origin); t.after(() => socket.terminate());
  await rpc(socket, { id: 1, method: "thread/start", params: { model: "gpt-6.1-sol" } });
  const incoming = once(socket, "message");
  fixture.children[0].stdout.emit("data", Buffer.from(`${JSON.stringify({
    id: 90, method: "approval/request", params: { threadId: "thread_123", reason: "Review action" },
  })}\n`));
  const [data] = await incoming;
  assert.equal(JSON.parse(data.toString("utf8")).method, "approval/request");
  const written = once(fixture.children[0], "written");
  socket.send(JSON.stringify({ id: 90, result: { decision: "deny" } }));
  const [reply] = await written;
  assert.deepEqual(reply, { id: 90, result: { decision: "deny" } });
});

test("protected thread ownership survives relay restart without crossing registrations", async (t) => {
  const storageRoot = await mkdtemp(join(tmpdir(), "relmio-relay-thread-"));
  const relays = new Set();
  t.after(async () => {
    for (const relay of relays) await relay.close().catch(() => {});
    await rm(storageRoot, { recursive: true, force: true });
  });
  async function authorize(clientId, subject) {
    const view = await commitAuthorization({
      storageRoot, runtimeId: "runtime_1", clientId,
      identity: { issuer: "https://auth.openai.com", subject },
      tokens: {
        access_token: `private-access-${subject}`, refresh_token: `private-refresh-${subject}`,
        token_type: "Bearer", expires_in: 3600,
        scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
      },
    });
    await setPlanEnabled({ storageRoot, registrationId: view.registrationId }, { enabled: true, expectedGeneration: view.generation });
    return { storageRoot, registrationId: view.registrationId };
  }
  const selected = await authorize("oaiapp_first", "first");
  const other = await authorize("oaiapp_other", "other");
  const children = [];
  async function start(registrationRef) {
    const relay = await startCodexAppServerRelay({
      host: "127.0.0.1", port: 0, registration: registrationRef, runtimeId: "runtime_1",
      packageVersion: "0.5.0", tokenVerifier: createHash("sha256").update(credential).digest(),
      listModels: async () => [
        { slug: "gpt-6.1-sol", display_name: "GPT 6.1 Sol" },
        { slug: "gpt-6.1-terra", display_name: "GPT 6.1 Terra" },
      ],
      spawnProcess() { const child = fakeChild(); children.push(child); return child; },
    });
    relays.add(relay);
    return relay;
  }
  const first = await start(selected);
  const initial = await connect(first.origin);
  assert.deepEqual((await rpc(initial, { id: 1, method: "thread/start", params: { model: "gpt-6.1-sol" } })).result.thread, { id: "thread_123" });
  initial.close(); await once(initial, "close");
  await first.close();

  const restarted = await start(selected);
  const continuing = await connect(restarted.origin); t.after(() => continuing.terminate());
  assert.deepEqual((await rpc(continuing, { id: 2, method: "thread/resume", params: { threadId: "thread_123" } })).result.thread, { id: "thread_123" });
  assert.equal(children[1].messages[0].method, "thread/resume");
  assert.equal(children[1].messages[0].params.model, undefined);
  assert.deepEqual((await rpc(continuing, { id: 5, method: "thread/resume",
    params: { threadId: "thread_123", model: "gpt-6.1-terra" } })).result.thread, { id: "thread_123" });
  assert.equal(children[1].messages[1].params.model, "gpt-6.1-terra");
  for (const attempt of [
    { method: "thread/resume", params: { threadId: "thread_123", path: "/foreign/rollout.jsonl" } },
    { method: "thread/resume", params: { threadId: "thread_123", history: [{ type: "message", role: "user", content: "foreign" }] } },
    { method: "thread/fork", params: { threadId: "thread_123", path: "/foreign/rollout.jsonl" } },
  ]) {
    assert.equal((await rpc(continuing, { id: 10, ...attempt })).error.code, -32602);
  }
  assert.equal(children[1].messages.length, 2);
  assert.equal((await rpc(continuing, { id: 3, method: "thread/resume", params: { threadId: "unknown" } })).error.code, -32602);
  assert.deepEqual((await rpc(continuing, { id: 8, method: "thread/fork",
    params: { threadId: "thread_123", model: "gpt-6.1-sol" } })).result.thread, { id: "fork_456" });
  continuing.close(); await once(continuing, "close");
  await restarted.close();
  const forkRestarted = await start(selected);
  const forked = await connect(forkRestarted.origin); t.after(() => forked.terminate());
  assert.deepEqual((await rpc(forked, { id: 9, method: "thread/resume",
    params: { threadId: "fork_456" } })).result.thread, { id: "fork_456" });

  const foreign = await start(other);
  const wrong = await connect(foreign.origin); t.after(() => wrong.terminate());
  assert.equal((await rpc(wrong, { id: 4, method: "thread/resume", params: { threadId: "thread_123" } })).error.code, -32602);
  assert.equal(children[3].messages.length, 0);
});

test("relay refuses a child resume response that names a different thread", async (t) => {
  const child = fakeChild({ resumeOverride: "foreign_777" });
  const relay = await startCodexAppServerRelay({
    host: "127.0.0.1", port: 0, registration, runtimeId: "runtime_1",
    packageVersion: "0.5.0", tokenVerifier: createHash("sha256").update(credential).digest(),
    getToken: async () => ({ accessToken: "provider_access_123456789", expiresAt: Date.now() + 300_000 }),
    readAccount: async () => ({ clientId: "issued_1", identity: { issuer: "https://auth.openai.com", subject: "sub_1" } }),
    listModels: async () => [{ slug: "gpt-6.1-sol" }],
    readBindings: async () => [{ threadId: "thread_123", model: "gpt-6.1-sol",
      identity: { issuer: "https://auth.openai.com", clientId: "issued_1", subject: "sub_1" } }],
    saveBinding: async () => assert.fail("foreign resume must not write binding"),
    spawnProcess() { return child; },
  });
  t.after(() => relay.close());
  const socket = await connect(relay.origin); t.after(() => socket.terminate());
  let forwarded = false;
  socket.on("message", () => { forwarded = true; });
  const closed = once(socket, "close");
  socket.send(JSON.stringify({ id: 1, method: "thread/resume", params: { threadId: "thread_123" } }));
  await closed;
  assert.equal(forwarded, false);
  assert.deepEqual(child.signals, ["SIGTERM"]);
});

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { request } from "node:http";
import test from "node:test";

import {
  hashCodexChatCredential,
  loadCodexChatGatewayConfig,
  startCodexChatGateway as startGateway,
} from "../src/gateway/codex-chat.js";

const clientCredential = "TEST_REL_MIO_CODEX_CHAT_CLIENT_CREDENTIAL_0123456789";
const registration = { storageRoot: "/tmp/test-siwc", registrationId: "account_1" };
const account = { clientId: "issued_1", identity: { issuer: "https://auth.openai.com", subject: "user_1" } };
const token = { accessToken: "fake-access-1", expiresAt: new Date(Date.now() + 3600_000).toISOString() };
const startCodexChatGateway = (options) => startGateway({
  registration, runtimeId: "runtime_1", childEnv: {},
  getToken: async () => token, readAccount: async () => account,
  listModels: async () => [{ slug: "gpt-6.1-sol", display_name: "GPT 6.1 Sol" }],
  ...options,
});

test("Codex Chat requires explicit registration, runtime and verifier configuration", () => {
  const config = loadCodexChatGatewayConfig({
    RELMIO_GATEWAY_HOST: "0.0.0.0",
    RELMIO_GATEWAY_PORT: "14501",
    RELMIO_GATEWAY_TOKEN_SHA256: hashCodexChatCredential(clientCredential).toString("hex"),
    RELMIO_REGISTRATION_ID: "account_1",
    RELMIO_RUNTIME_ID: "runtime_1",
    RELMIO_PACKAGE_VERSION: "0.5.0",
  });
  assert.equal(config.registration.registrationId, "account_1");
  assert.equal(config.runtimeId, "runtime_1");
  assert.deepEqual(config.tokenVerifier, hashCodexChatCredential(clientCredential));
  assert.equal(config.port, 14501);
  assert.equal(config.packageVersion, "0.5.0");
  for (const environment of [
    {},
    {
      RELMIO_GATEWAY_HOST: "example.test",
      RELMIO_GATEWAY_PORT: "14501",
      RELMIO_GATEWAY_TOKEN_SHA256: "a".repeat(64),
      RELMIO_PACKAGE_VERSION: "0.5.0",
    },
    {
      RELMIO_GATEWAY_HOST: "0.0.0.0",
      RELMIO_GATEWAY_PORT: "14501;id",
      RELMIO_GATEWAY_TOKEN_SHA256: "a".repeat(64),
      RELMIO_PACKAGE_VERSION: "0.5.0",
    },
  ]) {
    assert.throws(() => loadCodexChatGatewayConfig(environment), /Codex Chat/i);
  }
});

function createCompletingAppServer({
  activePermissionProfile = {
    extends: ":read-only",
    id: "relmio-chat-readonly",
  },
  delta = "draft output",
  finalText = "Final answer",
  includeCompletedItem = true,
  turnItems = [],
  turnStatus = "completed",
  turnError,
} = {}) {
  const messages = [];
  const signals = [];
  const child = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin.end = () => {};
  child.kill = (signal) => {
    signals.push(signal);
    queueMicrotask(() => child.emit("close", 0, signal));
    return true;
  };
  child.stdin.write = (wire) => {
    const message = JSON.parse(wire);
    messages.push(message);
    queueMicrotask(() => {
      if (message.method === "initialize") {
        child.stdout.emit("data", Buffer.from('{"id":0,"result":{}}\n'));
      } else if (
        message.method === "thread/start" ||
        message.method === "thread/resume"
      ) {
        child.stdout.emit(
          "data",
          Buffer.from(
            `${JSON.stringify({
              id: message.id,
              result: {
                activePermissionProfile,
                thread: { id: "thread_123" },
              },
            })}\n`,
          ),
        );
        child.stdout.emit(
          "data",
          Buffer.from(
            '{"method":"thread/started","params":{"thread":{"id":"thread_123"}}}\n',
          ),
        );
      } else if (message.method === "turn/start") {
        child.stdout.emit(
          "data",
          Buffer.from(`{\"id\":${message.id},\"result\":{\"turn\":{\"id\":\"turn_123\"}}}\n`),
        );
        child.stdout.emit(
          "data",
          Buffer.from(
            '{"method":"turn/started","params":{"threadId":"thread_123","turn":{"id":"turn_123","status":"inProgress","items":[]}}}\n',
          ),
        );
        for (const deltaEntry of Array.isArray(delta) ? delta : [delta]) {
          const deltaPart = typeof deltaEntry === "object"
            ? deltaEntry.text
            : deltaEntry;
          const itemId = typeof deltaEntry === "object"
            ? deltaEntry.itemId
            : "item_123";
          if (deltaPart === null) {
            continue;
          }
          child.stdout.emit(
            "data",
            Buffer.from(`${JSON.stringify({
              method: "item/agentMessage/delta",
              params: {
                threadId: "thread_123",
                turnId: "turn_123",
                itemId,
                delta: deltaPart,
              },
            })}\n`),
          );
        }
        if (includeCompletedItem) {
          child.stdout.emit(
            "data",
            Buffer.from(`${JSON.stringify({
              method: "item/completed",
              params: {
                threadId: "thread_123",
                turnId: "turn_123",
                completedAtMs: 1,
                item: { id: "item_123", type: "agentMessage", text: finalText },
              },
            })}\n`),
          );
        }
        if (turnError) child.stdout.emit("data", Buffer.from(`${JSON.stringify({
          method: "error", params: { threadId: "thread_123", turnId: "turn_123", error: turnError },
        })}\n`));
        child.stdout.emit(
          "data",
          Buffer.from(`${JSON.stringify({
            method: "turn/completed",
            params: {
              threadId: "thread_123",
              turn: { id: "turn_123", status: turnStatus, items: turnItems, ...(turnError && { error: turnError }) },
            },
          })}\n`),
        );
      }
    });
    return true;
  };
  return { child, messages, signals };
}

function rawRequest(origin, { body, headers = {}, method = "GET", path = "/health" }) {
  const url = new URL(origin);
  return new Promise((resolvePromise, rejectPromise) => {
    const pending = request(
      {
        hostname: url.hostname,
        port: url.port,
        path,
        method,
        headers,
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
        response.on("end", () => {
          resolvePromise({
            body: JSON.parse(Buffer.concat(chunks).toString("utf8")),
            status: response.statusCode,
          });
        });
      },
    );
    pending.once("error", rejectPromise);
    if (body !== undefined) {
      pending.write(body);
    }
    pending.end();
  });
}

function authenticatedHeaders() {
  return {
    Authorization: `Bearer ${clientCredential}`,
    "Content-Type": "application/json",
  };
}

async function readRelmioEvents(response) {
  const reader = response.body.getReader();
  const chunks = [];
  const deadline = setTimeout(() => {
    void reader.cancel("test stream deadline");
  }, 1_000);
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Buffer.from(value));
    }
  } finally {
    clearTimeout(deadline);
    reader.releaseLock();
  }
  const blocks = Buffer.concat(chunks)
    .toString("utf8")
    .split(/\r?\n\r?\n/u)
    .filter((block) => block.trim() && !block.trimStart().startsWith(":"));
  return blocks.map((block) => {
    const event = block
      .split(/\r?\n/u)
      .find((line) => line.startsWith("event:"))
      ?.slice(6)
      .trim();
    const data = block
      .split(/\r?\n/u)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart())
      .join("\n");
    return { event, data: JSON.parse(data) };
  });
}

function createStallingAppServer() {
  const child = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin.write = () => true;
  child.stdin.end = () => {};
  child.signals = [];
  child.kill = (signal) => {
    child.signals.push(signal);
    queueMicrotask(() => child.emit("close", 0, signal));
    return true;
  };
  return child;
}

test("Codex Chat health is public while chat requires its dedicated bearer credential", async (t) => {
  let spawnCalls = 0;
  const gateway = await startCodexChatGateway({
    host: "127.0.0.1",
    port: 0,
    tokenVerifier: hashCodexChatCredential(clientCredential),
    spawnProcess() {
      spawnCalls += 1;
      throw new Error("chat must not start for health or rejected requests");
    },
  });
  t.after(() => gateway.close());

  const health = await fetch(`${gateway.origin}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: "ok" });
  assert.equal(health.headers.get("cache-control"), "no-store");
  assert.equal(health.headers.get("x-content-type-options"), "nosniff");

  const unauthenticatedProbe = await fetch(
    `${gateway.origin}/auth/verify`,
  );
  assert.equal(unauthenticatedProbe.status, 401);
  const authenticatedProbe = await fetch(`${gateway.origin}/auth/verify`, {
    headers: { Authorization: `Bearer ${clientCredential}` },
  });
  assert.equal(authenticatedProbe.status, 200);
  assert.deepEqual(await authenticatedProbe.json(), { status: "ok" });
  const modelList = await fetch(`${gateway.origin}/models`, { headers: { Authorization: `Bearer ${clientCredential}` } });
  assert.equal(modelList.status, 200);
  assert.deepEqual(await modelList.json(), { models: [{ slug: "gpt-6.1-sol", display_name: "GPT 6.1 Sol" }] });
  assert.equal((await fetch(`${gateway.origin}/models`)).status, 401);
  assert.equal((await fetch(`${gateway.origin}/models`, { headers: { Authorization: `Bearer ${clientCredential}`, Origin: "https://example.test" } })).status, 403);

  const rejected = await fetch(`${gateway.origin}/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ input: "Hello" }),
  });
  assert.equal(rejected.status, 401);
  assert.deepEqual(await rejected.json(), { error: { code: "unauthorized" } });

  const browser = await fetch(`${gateway.origin}/chat`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${clientCredential}`,
      "Content-Type": "application/json",
      Origin: "https://example.test",
    },
    body: JSON.stringify({ input: "Hello" }),
  });
  assert.equal(browser.status, 403);
  assert.deepEqual(await browser.json(), { error: { code: "origin_rejected" } });

  const badHost = await rawRequest(gateway.origin, {
    headers: { Host: "example.test" },
  });
  assert.deepEqual(badHost, {
    body: { error: { code: "host_rejected" } },
    status: 421,
  });
  const unknownWithoutCredential = await fetch(`${gateway.origin}/unknown`);
  assert.equal(unknownWithoutCredential.status, 401);
  const unknownWithCredential = await fetch(`${gateway.origin}/unknown`, {
    headers: { Authorization: `Bearer ${clientCredential}` },
  });
  assert.equal(unknownWithCredential.status, 404);
  assert.equal(spawnCalls, 0);
});

test("Codex Chat rejects malformed, unexpected, and oversized request bodies before spawning", async (t) => {
  let spawnCalls = 0;
  const gateway = await startCodexChatGateway({
    host: "127.0.0.1",
    port: 0,
    tokenVerifier: hashCodexChatCredential(clientCredential),
    spawnProcess() {
      spawnCalls += 1;
      throw new Error("invalid requests must not spawn");
    },
  });
  t.after(() => gateway.close());

  for (const [body, expectedCode] of [
    ["{", "invalid_json"],
    [JSON.stringify({ input: "Hello", extra: true }), "invalid_request"],
    [JSON.stringify({ input: "x".repeat(17 * 1024) }), "invalid_request"],
  ]) {
    const response = await fetch(`${gateway.origin}/chat`, {
      method: "POST",
      headers: authenticatedHeaders(),
      body,
    });
    assert.equal(response.status, body.length > 16 * 1024 ? 413 : 400);
    assert.deepEqual(await response.json(), { error: { code: expectedCode } });
  }
  assert.equal(spawnCalls, 0);
});

test("Codex Chat starts a read-only conversation and returns the completed agent message", async (t) => {
  const appServer = createCompletingAppServer();
  const spawnCalls = [];
  const gateway = await startCodexChatGateway({
    host: "127.0.0.1",
    port: 0,
    packageVersion: "0.5.0",
    tokenVerifier: hashCodexChatCredential(clientCredential),
    spawnProcess(...args) {
      spawnCalls.push(args);
      return appServer.child;
    },
  });
  t.after(() => gateway.close());

  const response = await fetch(`${gateway.origin}/chat`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${clientCredential}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ input: "What is a semaphore?" }),
  });

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    conversationId: "thread_123",
    output: "Final answer",
  });
  assert.equal(spawnCalls[0][0], "codex");
  assert.deepEqual(spawnCalls[0][1].slice(0, 3), ["app-server", "--listen", "stdio://"]);
  assert.ok(spawnCalls[0][1].includes('model_providers.openai_chatgpt_plan.env_key="ACCESS_TOKEN"'));
  assert.ok(spawnCalls[0][1].includes("model_providers.openai_chatgpt_plan.supports_websockets=false"));
  assert.ok(spawnCalls[0][1].includes("model_providers.openai_chatgpt_plan.stream_max_retries=0"));
  assert.ok(spawnCalls[0][1].includes("model_providers.openai_chatgpt_plan.request_max_retries=0"));
  assert.ok(spawnCalls[0][1].includes("shell_environment_policy.ignore_default_excludes=false"));
  assert.ok(spawnCalls[0][1].includes('shell_environment_policy.filters.ACCESS_TOKEN="exclude"'));
  assert.equal(spawnCalls[0][2].env.ACCESS_TOKEN, token.accessToken);
  assert.deepEqual(appServer.messages.map((message) => message.method), [
    "initialize",
    "initialized",
    "thread/start",
    "turn/start",
  ]);
  assert.deepEqual(appServer.messages[0].params.clientInfo, {
    name: "Relmio",
    title: "Relmio",
    version: "0.5.0",
  });
  assert.deepEqual(appServer.messages[0].params.capabilities, {
    experimentalApi: true,
  });
  assert.deepEqual(appServer.messages[2].params, {
    approvalPolicy: "never",
    cwd: "/workspace",
    developerInstructions:
      "Provide a conversational answer only. Do not inspect or edit files, run commands, call tools, or access external resources.",
    model: "gpt-6.1-sol",
    permissions: "relmio-chat-readonly",
  });
  assert.deepEqual(appServer.messages[3].params, {
    approvalPolicy: "never",
    cwd: "/workspace",
    input: [{ text: "What is a semaphore?", type: "text" }],
    permissions: "relmio-chat-readonly",
    threadId: "thread_123",
  });
  assert.deepEqual(appServer.signals, ["SIGTERM"]);
});

test("Codex Chat renews child env and resumes only a thread owned by the selected registration", async (t) => {
  const children = [createCompletingAppServer(), createCompletingAppServer()];
  const envs = [];
  let accountId = "issued_1";
  let tokenIndex = 0;
  const gateway = await startCodexChatGateway({
    host: "127.0.0.1", port: 0, packageVersion: "0.5.0",
    tokenVerifier: hashCodexChatCredential(clientCredential),
    getToken: async () => ({ accessToken: `fresh-${++tokenIndex}` }),
    readAccount: async () => ({ ...account, clientId: accountId }),
    spawnProcess(_command, _args, options) { envs.push(options.env.ACCESS_TOKEN); return children[envs.length - 1].child; },
  });
  t.after(() => gateway.close());
  const first = await fetch(`${gateway.origin}/chat`, { method: "POST", headers: authenticatedHeaders(), body: JSON.stringify({ input: "Begin." }) });
  assert.equal(first.status, 200);
  assert.equal((await first.json()).conversationId, "thread_123");
  accountId = "issued_2";
  const wrong = await fetch(`${gateway.origin}/chat`, { method: "POST", headers: authenticatedHeaders(), body: JSON.stringify({ conversationId: "thread_123", input: "Continue." }) });
  assert.equal(wrong.status, 400);
  assert.deepEqual(envs, ["fresh-1"]);
  accountId = "issued_1";
  const resumed = await fetch(`${gateway.origin}/chat`, { method: "POST", headers: authenticatedHeaders(), body: JSON.stringify({ conversationId: "thread_123", input: "Continue." }) });
  assert.equal(resumed.status, 200);
  assert.equal(children[1].messages[2].method, "thread/resume");
  assert.equal(children[1].messages[2].params.model, "gpt-6.1-sol");
  assert.deepEqual(envs, ["fresh-1", "fresh-3"]);
});

test("Codex Chat prefers item completion, keeps delta item IDs separate, and bounds output", async (t) => {
  const fixtures = [
    {
      appServer: createCompletingAppServer({
        delta: "draft",
        finalText: "intermediate",
        turnItems: [{ type: "agentMessage", text: "authoritative" }],
      }),
      expected: { status: 200, output: "intermediate" },
    },
    {
      appServer: createCompletingAppServer({
        delta: ["bounded ", "fallback"],
        includeCompletedItem: false,
      }),
      expected: { status: 200, output: "bounded fallback" },
    },
    {
      appServer: createCompletingAppServer({
        delta: [
          { itemId: "old_item", text: "old" },
          { itemId: "new_item", text: "new" },
        ],
        includeCompletedItem: false,
      }),
      expected: { status: 200, output: "new" },
    },
    {
      appServer: createCompletingAppServer({
        delta: [
          { itemId: "first_item", text: "one" },
          { itemId: "second_item", text: "two" },
          { itemId: "first_item", text: "three" },
        ],
        includeCompletedItem: false,
      }),
      expected: { status: 200, output: "onethree" },
    },
    {
      appServer: createCompletingAppServer({ turnStatus: "failed" }),
      expected: { status: 503 },
    },
    {
      appServer: createCompletingAppServer({
        activePermissionProfile: {
          extends: ":read-only",
          id: ":read-only",
        },
      }),
      expected: { status: 503 },
    },
    {
      appServer: createCompletingAppServer({
        delta: Array.from({ length: 3 }, () => "x".repeat(50 * 1024)),
        includeCompletedItem: false,
      }),
      expected: { status: 503 },
    },
  ];

  for (const fixture of fixtures) {
    const gateway = await startCodexChatGateway({
      host: "127.0.0.1",
      port: 0,
      tokenVerifier: hashCodexChatCredential(clientCredential),
      spawnProcess() {
        return fixture.appServer.child;
      },
    });
    const response = await fetch(`${gateway.origin}/chat`, {
      method: "POST",
      headers: authenticatedHeaders(),
      body: JSON.stringify({ input: "Hello" }),
    });
    assert.equal(response.status, fixture.expected.status);
    const payload = await response.json();
    if (fixture.expected.output) {
      assert.equal(payload.output, fixture.expected.output);
    } else {
      assert.equal(payload.status, 503);
      assert.ok(["upstream_failed", "unavailable"].includes(payload.error.code));
    }
    await gateway.close();
  }
});

test("Codex Chat streams progress, text deltas, and one completed terminal event", async (t) => {
  const appServer = createCompletingAppServer({
    delta: ["A robot ", "is a programmable machine."],
    finalText: "A robot is a programmable machine.",
  });
  const gateway = await startCodexChatGateway({
    host: "127.0.0.1",
    port: 0,
    tokenVerifier: hashCodexChatCredential(clientCredential),
    spawnProcess() {
      return appServer.child;
    },
  });
  t.after(() => gateway.close());

  const response = await fetch(`${gateway.origin}/chat`, {
    method: "POST",
    headers: {
      ...authenticatedHeaders(),
      Accept: "text/event-stream",
    },
    body: JSON.stringify({ input: "What is a robot?" }),
  });

  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/event-stream\b/u);
  assert.equal(response.headers.get("x-relmio-stream"), "v1");
  const events = await readRelmioEvents(response);
  assert.equal(events[0].event, "start");
  assert.ok(events.some((event) => event.event === "progress"));
  assert.deepEqual(
    events.filter((event) => event.event === "delta").map((event) => event.data.text),
    ["A robot ", "is a programmable machine."],
  );
  assert.deepEqual(events.at(-1), {
    event: "terminal",
    data: { outcome: "completed", conversationId: "thread_123" },
  });
  assert.equal(events.filter((event) => event.event === "terminal").length, 1);
  const serialized = JSON.stringify(events);
  assert.doesNotMatch(serialized, /turn_123|item_123/u);
});

for (const status of ["failed", "interrupted"]) {
  test(`Codex Chat streams one redacted failed terminal event for ${status} turns`, async (t) => {
    const appServer = createCompletingAppServer({
      delta: [],
      includeCompletedItem: false,
      turnStatus: status,
    });
    const gateway = await startCodexChatGateway({
      host: "127.0.0.1",
      port: 0,
      tokenVerifier: hashCodexChatCredential(clientCredential),
      spawnProcess() {
        return appServer.child;
      },
    });
    t.after(() => gateway.close());

    const response = await fetch(`${gateway.origin}/chat`, {
      method: "POST",
      headers: { ...authenticatedHeaders(), Accept: "text/event-stream" },
      body: JSON.stringify({ input: "What is love?" }),
    });
    const events = await readRelmioEvents(response);
    assert.equal(events.filter((event) => event.event === "error").length, 1);
    assert.equal(events.filter((event) => event.event === "terminal").length, 1);
    assert.equal(events.at(-2).event, "error");
    assert.equal(events.at(-2).data.code, status === "interrupted" ? "turn_interrupted" : "upstream_failed");
    assert.equal(events.at(-2).data.status, 503);
    assert.equal(events.at(-2).data.retryable, false);
    assert.deepEqual(events.at(-1), {
      event: "terminal",
      data: { outcome: status },
    });
    assert.doesNotMatch(JSON.stringify(events), /turn_123|item_123|private/u);
  });
}

test("Codex Chat maps pinned usage and unauthorized turn errors without inventing provider fields", async (t) => {
  for (const { info, status, code, recovery } of [
    { info: "usageLimitExceeded", status: 429, code: "usage_limit", recovery: "manage-usage" },
    { info: "unauthorized", status: 401, code: "unauthorized", recovery: "reauthorize" },
  ]) {
    for (const streaming of [true, false]) {
      const appServer = createCompletingAppServer({ turnStatus: "failed", turnError: {
        message: "Failure Bearer fake-access-1", codexErrorInfo: info,
        additionalDetails: "untyped diagnostic: provider request req_hidden",
      } });
      const gateway = await startCodexChatGateway({
        host: "127.0.0.1", port: 0, tokenVerifier: hashCodexChatCredential(clientCredential),
        spawnProcess() { return appServer.child; },
      });
      t.after(() => gateway.close());
      const response = await fetch(`${gateway.origin}/chat`, {
        method: "POST", headers: { ...authenticatedHeaders(), ...(streaming && { Accept: "text/event-stream" }) },
        body: JSON.stringify({ input: "Spend?" }),
      });
      if (streaming) {
        const events = await readRelmioEvents(response);
        assert.equal(events.some((event) => event.event === "delta"), true);
        const failure = events.find((event) => event.event === "error").data;
        assert.equal(failure.status, status);
        assert.equal(failure.code, code);
        assert.equal(failure.recovery, recovery);
        assert.equal(failure.retryable, false);
        assert.equal(events.at(-1).data.outcome, "failed");
        assert.equal(failure.upstream, undefined);
        assert.doesNotMatch(JSON.stringify(events), /fake-access-1|req_hidden/u);
      } else {
        assert.equal(response.status, status);
        const failure = await response.json();
        assert.equal(failure.error.code, code);
        assert.equal(failure.recovery, recovery);
        assert.equal(failure.upstream, undefined);
        assert.equal(failure.requestId, undefined);
        assert.doesNotMatch(JSON.stringify(failure), /fake-access-1|req_hidden/u);
      }
    }
  }
});

test("Codex Chat forwards a pinned HTTP failure variant's numeric status", async (t) => {
  const appServer = createCompletingAppServer({ turnStatus: "failed", turnError: {
    message: "Routing unavailable", codexErrorInfo: { httpConnectionFailed: { httpStatusCode: 503 } },
    additionalDetails: null,
  } });
  const gateway = await startCodexChatGateway({
    host: "127.0.0.1", port: 0, tokenVerifier: hashCodexChatCredential(clientCredential),
    spawnProcess() { return appServer.child; },
  });
  t.after(() => gateway.close());
  const response = await fetch(`${gateway.origin}/chat`, {
    method: "POST", headers: authenticatedHeaders(), body: JSON.stringify({ input: "Hello" }),
  });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).recovery, "retry-later");
});

test("adapter strips actual access, refresh and ID tokens from child messages", async (t) => {
  const appServer = createCompletingAppServer({
    delta: "provider_access_123456789 Bearer unrelated",
    finalText: "refresh_secret_123456789 id_secret_123456789",
  });
  const gateway = await startCodexChatGateway({
    host: "127.0.0.1", port: 0, tokenVerifier: hashCodexChatCredential(clientCredential),
    getToken: async () => ({ accessToken: "provider_access_123456789" }),
    readAccount: async () => ({ ...account, session: { refreshToken: "refresh_secret_123456789", idToken: "id_secret_123456789" } }),
    spawnProcess() { return appServer.child; },
  });
  t.after(() => gateway.close());
  const response = await fetch(`${gateway.origin}/chat`, {
    method: "POST", headers: { ...authenticatedHeaders(), Accept: "text/event-stream" },
    body: JSON.stringify({ input: "Hello" }),
  });
  const events = await readRelmioEvents(response);
  const serialized = JSON.stringify(events);
  assert.doesNotMatch(serialized, /provider_access_123456789|refresh_secret_123456789|id_secret_123456789/u);
  assert.match(serialized, /Bearer unrelated/u);
  assert.equal(events.at(-1).data.outcome, "completed");
});

test("Codex Chat contains child stdio errors behind a generic failure", async () => {
  for (const streamName of ["stdin", "stdout", "stderr"]) {
    const child = createStallingAppServer();
    const gateway = await startCodexChatGateway({
      host: "127.0.0.1",
      port: 0,
      tokenVerifier: hashCodexChatCredential(clientCredential),
      spawnProcess() {
        queueMicrotask(() => {
          child[streamName].emit("error", new Error("sensitive pipe detail"));
        });
        return child;
      },
    });
    const response = await fetch(`${gateway.origin}/chat`, {
      method: "POST",
      headers: authenticatedHeaders(),
      body: JSON.stringify({ input: "Hello" }),
    });
    assert.equal(response.status, 503);
    const text = await response.text();
    assert.equal(text.includes("sensitive"), false);
    assert.equal(JSON.parse(text).status, 503);
    await gateway.close();
  }
});

test("Codex Chat rejects an overlong App Server protocol line without exposing it", async (t) => {
  const child = createStallingAppServer();
  child.stdin.write = () => {
    queueMicrotask(() => child.stdout.emit("data", Buffer.alloc(65 * 1024, 0x78)));
    return true;
  };
  const gateway = await startCodexChatGateway({
    host: "127.0.0.1",
    port: 0,
    tokenVerifier: hashCodexChatCredential(clientCredential),
    spawnProcess() {
      return child;
    },
  });
  t.after(() => gateway.close());

  const response = await fetch(`${gateway.origin}/chat`, {
    method: "POST",
    headers: authenticatedHeaders(),
    body: JSON.stringify({ input: "Hello" }),
  });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).status, 503);
});

test("Codex Chat permits only one active turn and cleans up a disconnected client", async (t) => {
  const child = createStallingAppServer();
  let markSpawned;
  const spawned = new Promise((resolvePromise) => {
    markSpawned = resolvePromise;
  });
  const gateway = await startCodexChatGateway({
    host: "127.0.0.1",
    port: 0,
    tokenVerifier: hashCodexChatCredential(clientCredential),
    spawnProcess() {
      markSpawned();
      return child;
    },
  });
  t.after(() => gateway.close());

  const controller = new AbortController();
  const first = fetch(`${gateway.origin}/chat`, {
    method: "POST",
    headers: authenticatedHeaders(),
    body: JSON.stringify({ input: "First" }),
    signal: controller.signal,
  }).catch((error) => error);
  await spawned;
  const second = await fetch(`${gateway.origin}/chat`, {
    method: "POST",
    headers: authenticatedHeaders(),
    body: JSON.stringify({ input: "Second" }),
  });
  assert.equal(second.status, 429);
  assert.deepEqual(await second.json(), { error: { code: "busy" } });

  controller.abort();
  await first;
  for (let attempt = 0; attempt < 10 && child.signals.length === 0; attempt += 1) {
    await new Promise((resolvePromise) => setImmediate(resolvePromise));
  }
  assert.deepEqual(child.signals, ["SIGTERM"]);
});

test("Codex Chat bounds a stalled App Server turn and returns only a generic failure", async (t) => {
  const child = createStallingAppServer();
  const gateway = await startCodexChatGateway({
    host: "127.0.0.1",
    port: 0,
    packageVersion: "0.5.0",
    tokenVerifier: hashCodexChatCredential(clientCredential),
    turnTimeoutMs: 5,
    spawnProcess() {
      return child;
    },
  });
  t.after(() => gateway.close());

  const response = await fetch(`${gateway.origin}/chat`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${clientCredential}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ input: "Hello" }),
  });
  assert.equal(response.status, 503);
  assert.equal((await response.json()).status, 503);
  assert.deepEqual(child.signals, ["SIGTERM"]);
});

test("Codex Chat holds its concurrency slot until the terminated child closes", async (t) => {
  const child = createStallingAppServer();
  child.kill = (signal) => {
    child.signals.push(signal);
    if (signal === "SIGKILL") {
      queueMicrotask(() => child.emit("close", 0, signal));
    }
    return true;
  };
  const gateway = await startCodexChatGateway({
    host: "127.0.0.1",
    port: 0,
    tokenVerifier: hashCodexChatCredential(clientCredential),
    terminationGraceMs: 30,
    turnTimeoutMs: 5,
    spawnProcess() {
      return child;
    },
  });
  t.after(() => gateway.close());

  const first = fetch(`${gateway.origin}/chat`, {
    method: "POST",
    headers: authenticatedHeaders(),
    body: JSON.stringify({ input: "First" }),
  });
  for (let attempt = 0; attempt < 20 && child.signals.length === 0; attempt += 1) {
    await new Promise((resolvePromise) => setTimeout(resolvePromise, 1));
  }
  assert.deepEqual(child.signals, ["SIGTERM"]);
  const second = await fetch(`${gateway.origin}/chat`, {
    method: "POST",
    headers: authenticatedHeaders(),
    body: JSON.stringify({ input: "Second" }),
  });
  assert.equal(second.status, 429);
  assert.equal((await first).status, 503);
  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
});

test("Codex Chat escalates an unresponsive App Server from SIGTERM to SIGKILL", async (t) => {
  const child = createStallingAppServer();
  child.kill = (signal) => {
    child.signals.push(signal);
    if (signal === "SIGKILL") {
      queueMicrotask(() => child.emit("close", 0, signal));
    }
    return true;
  };
  const gateway = await startCodexChatGateway({
    host: "127.0.0.1",
    port: 0,
    tokenVerifier: hashCodexChatCredential(clientCredential),
    terminationGraceMs: 5,
    turnTimeoutMs: 5,
    spawnProcess() {
      return child;
    },
  });
  t.after(() => gateway.close());

  const response = await fetch(`${gateway.origin}/chat`, {
    method: "POST",
    headers: authenticatedHeaders(),
    body: JSON.stringify({ input: "Hello" }),
  });
  assert.equal(response.status, 503);
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 15));
  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
});

test("Codex Chat returns after a bounded wait when SIGKILL cannot be reaped", async (t) => {
  const child = createStallingAppServer();
  child.kill = (signal) => {
    child.signals.push(signal);
    return true;
  };
  const gateway = await startCodexChatGateway({
    host: "127.0.0.1",
    port: 0,
    tokenVerifier: hashCodexChatCredential(clientCredential),
    terminationGraceMs: 5,
    turnTimeoutMs: 5,
    spawnProcess() {
      return child;
    },
  });
  t.after(() => gateway.close());

  const response = await fetch(`${gateway.origin}/chat`, {
    method: "POST",
    headers: authenticatedHeaders(),
    body: JSON.stringify({ input: "Hello" }),
  });
  assert.equal(response.status, 503);
  assert.deepEqual(child.signals, ["SIGTERM", "SIGKILL"]);
});

test("adapter shutdown cancels an active turn before its registration is signed out", async (t) => {
  const child = createStallingAppServer();
  let markSpawned;
  const spawned = new Promise((resolve) => { markSpawned = resolve; });
  const gateway = await startCodexChatGateway({
    host: "127.0.0.1", port: 0,
    tokenVerifier: hashCodexChatCredential(clientCredential),
    spawnProcess() { markSpawned(); return child; },
  });
  t.after(() => gateway.close().catch(() => {}));
  const pending = fetch(`${gateway.origin}/chat`, {
    method: "POST", headers: authenticatedHeaders(), body: JSON.stringify({ input: "Do not replay" }),
  });
  await spawned;
  await gateway.close();
  assert.equal((await pending).status, 503);
  assert.deepEqual(child.signals, ["SIGTERM"]);
});

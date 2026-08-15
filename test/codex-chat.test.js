import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { request } from "node:http";
import test from "node:test";

import {
  hashCodexChatCredential,
  loadCodexChatGatewayConfig,
  startCodexChatGateway,
} from "../src/gateway/codex-chat.js";

const clientCredential = "TEST_REL_MIO_CODEX_CHAT_CLIENT_CREDENTIAL_0123456789";

test("Codex Chat entrypoint accepts only an explicit verifier and literal listener settings", () => {
  assert.deepEqual(
    loadCodexChatGatewayConfig({
      RELMIO_GATEWAY_HOST: "0.0.0.0",
      RELMIO_GATEWAY_PORT: "14501",
      RELMIO_GATEWAY_TOKEN_SHA256: hashCodexChatCredential(clientCredential).toString("hex"),
      RELMIO_PACKAGE_VERSION: "0.5.0",
    }),
    {
      host: "0.0.0.0",
      packageVersion: "0.5.0",
      port: 14501,
      tokenVerifier: hashCodexChatCredential(clientCredential),
    },
  );
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
        child.stdout.emit(
          "data",
          Buffer.from(`${JSON.stringify({
            method: "turn/completed",
            params: {
              threadId: "thread_123",
              turn: { id: "turn_123", status: turnStatus, items: turnItems },
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
  assert.deepEqual(spawnCalls[0].slice(0, 2), [
    "codex",
    ["app-server", "--strict-config", "--stdio"],
  ]);
  assert.deepEqual(appServer.messages.map((message) => message.method), [
    "initialize",
    "initialized",
    "thread/start",
    "turn/start",
  ]);
  assert.deepEqual(appServer.messages[0].params.clientInfo, {
    name: "relmio",
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

test("Codex Chat resumes only the requested bounded conversation", async (t) => {
  const appServer = createCompletingAppServer();
  const gateway = await startCodexChatGateway({
    host: "127.0.0.1",
    port: 0,
    packageVersion: "0.5.0",
    tokenVerifier: hashCodexChatCredential(clientCredential),
    spawnProcess() {
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
    body: JSON.stringify({
      conversationId: "thread_123",
      input: "Continue.",
    }),
  });

  assert.equal(response.status, 200);
  assert.equal(appServer.messages[2].method, "thread/resume");
  assert.deepEqual(appServer.messages[2].params, {
    approvalPolicy: "never",
    cwd: "/workspace",
    developerInstructions:
      "Provide a conversational answer only. Do not inspect or edit files, run commands, call tools, or access external resources.",
    permissions: "relmio-chat-readonly",
    threadId: "thread_123",
  });
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
      assert.deepEqual(payload, { error: { code: "unavailable" } });
    }
    await gateway.close();
  }
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
    assert.deepEqual(JSON.parse(text), { error: { code: "unavailable" } });
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
  assert.deepEqual(await response.json(), { error: { code: "unavailable" } });
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
  assert.deepEqual(await response.json(), { error: { code: "unavailable" } });
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

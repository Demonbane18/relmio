import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import test from "node:test";

import { startCodexDeviceLogin } from "../src/services/codex-login.js";

const require = createRequire(import.meta.url);
const { version: RELMIO_VERSION } = require("../package.json");

const INSTALL_DIRECTORY = "/private/relmio/local/codex-chatgpt";
const VERIFICATION_URL = "https://auth.openai.com/codex/device";
const LOCAL_DOCKER_HOST = "unix:///var/run/docker.sock";
const PROJECT_NAME =
  "relmio-codex-chatgpt-0123456789abcdef0123456789abcdef";
const CHILD_ENVIRONMENT = Object.freeze({
  PATH: "/usr/bin",
  LANG: "C",
  DOCKER_HOST: "tcp://attacker.example.test:2375",
  DOCKER_CONTEXT: "remote",
  DOCKER_CONFIG: "/tmp/remote-docker-config",
  DOCKER_TLS_VERIFY: "1",
  DOCKER_CERT_PATH: "/tmp/remote-certificates",
  BUILDKIT_HOST: "tcp://attacker.example.test:1234",
});

function createFakeChild({ closeOnKill = true } = {}) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = new EventEmitter();
  child.stdin.writes = [];
  child.stdin.write = (chunk) => {
    child.stdin.writes.push(Buffer.from(chunk).toString("utf8"));
    return true;
  };
  child.stdin.end = () => {
    child.stdin.ended = true;
  };
  child.killSignals = [];
  child.closed = false;
  child.kill = (signal) => {
    child.killSignals.push(signal);
    if (closeOnKill && !child.closed) {
      queueMicrotask(() => {
        if (!child.closed) {
          child.closed = true;
          child.emit("close", 143);
        }
      });
    }
    return true;
  };
  return child;
}

function closeChild(child, code = 1) {
  if (!child.closed) {
    child.closed = true;
    child.emit("close", code);
  }
}

function createSpawnFixture(childOptions) {
  const child = createFakeChild(childOptions);
  const calls = [];
  return {
    child,
    calls,
    spawnProcess(command, args, options) {
      calls.push({ command, args, options });
      return child;
    },
  };
}

function startLogin(fixture, options = {}) {
  return startCodexDeviceLogin({
    installDirectory: INSTALL_DIRECTORY,
    dockerHost: LOCAL_DOCKER_HOST,
    projectName: PROJECT_NAME,
    environment: CHILD_ENVIRONMENT,
    spawnProcess: fixture.spawnProcess,
    ...options,
  });
}

function createManualTimers() {
  let nextId = 1;
  const scheduled = new Map();
  return {
    setTimer(callback, milliseconds) {
      const id = nextId;
      nextId += 1;
      scheduled.set(id, { callback, milliseconds });
      return id;
    },
    clearTimer(id) {
      scheduled.delete(id);
    },
    fire(milliseconds) {
      const entry = [...scheduled.entries()].find(
        ([, timer]) => timer.milliseconds === milliseconds,
      );
      assert.ok(entry, `Expected a ${milliseconds}ms timer.`);
      const [id, timer] = entry;
      scheduled.delete(id);
      timer.callback();
    },
    get activeCount() {
      return scheduled.size;
    },
  };
}

async function assertPromisePending(promise) {
  const state = await Promise.race([
    promise.then(
      () => "resolved",
      () => "rejected",
    ),
    new Promise((resolve) => queueMicrotask(() => resolve("pending"))),
  ]);
  assert.equal(state, "pending");
}

function emitJsonLine(child, message) {
  child.stdout.emit("data", Buffer.from(`${JSON.stringify(message)}\n`));
}

function emitInitializeResponse(child, result = {}) {
  emitJsonLine(child, { id: 0, result });
}

function emitDeviceResponse(
  child,
  {
    loginId = "login-fixture-1",
    type = "chatgptDeviceCode",
    userCode = "ABCD-EFGH",
    verificationUrl = VERIFICATION_URL,
    initialize = true,
  } = {},
) {
  if (initialize) {
    emitInitializeResponse(child);
  }
  emitJsonLine(child, {
    id: 1,
    result: { loginId, type, userCode, verificationUrl },
  });
}

function emitCompletion(
  child,
  {
    loginId = "login-fixture-1",
    success = true,
    error = null,
  } = {},
) {
  emitJsonLine(child, {
    method: "account/login/completed",
    params: { loginId, success, error },
  });
}

test("startCodexDeviceLogin pins Docker and waits for initialize before starting login", async () => {
  const fixture = createSpawnFixture();
  const loginPromise = startLogin(fixture);

  assert.deepEqual(fixture.calls, [
    {
      command: "docker",
      args: [
        "--host",
        LOCAL_DOCKER_HOST,
        "compose",
        "--project-name",
        PROJECT_NAME,
        "--file",
        "docker-compose.yml",
        "run",
        "--rm",
        "--no-deps",
        "codex",
        "app-server",
        "--strict-config",
        "--stdio",
      ],
      options: {
        cwd: INSTALL_DIRECTORY,
        env: { PATH: "/usr/bin", LANG: "C" },
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    },
  ]);
  assert.deepEqual(
    fixture.child.stdin.writes.map((write) => JSON.parse(write)),
    [
      {
        id: 0,
        method: "initialize",
        params: {
          clientInfo: {
            name: "relmio",
            title: "Relmio",
            version: RELMIO_VERSION,
          },
        },
      },
    ],
  );

  emitInitializeResponse(fixture.child);
  assert.deepEqual(
    fixture.child.stdin.writes.flatMap((write) =>
      write
        .trimEnd()
        .split("\n")
        .map((line) => JSON.parse(line)),
    ),
    [
      {
        id: 0,
        method: "initialize",
        params: {
          clientInfo: {
            name: "relmio",
            title: "Relmio",
            version: RELMIO_VERSION,
          },
        },
      },
      { method: "initialized", params: {} },
      {
        id: 1,
        method: "account/login/start",
        params: { type: "chatgptDeviceCode" },
      },
    ],
  );

  emitDeviceResponse(fixture.child, { initialize: false });
  const login = await loginPromise;
  assert.equal(login.verificationUrl, VERIFICATION_URL);
  assert.equal(login.userCode, "ABCD-EFGH");
  emitCompletion(fixture.child);
  await assertPromisePending(login.completion);
  closeChild(fixture.child, 0);
  assert.deepEqual(await login.completion, { success: true });
});

test("startCodexDeviceLogin rejects unpinned Docker hosts and foreign project identities", async () => {
  const invalidOptions = [
    {
      dockerHost: "tcp://attacker.example.test:2375",
      projectName: PROJECT_NAME,
    },
    {
      dockerHost: LOCAL_DOCKER_HOST,
      projectName: "relmio-codex-chatgpt",
    },
    {
      dockerHost: LOCAL_DOCKER_HOST,
      projectName:
        "relmio-openai-api-0123456789abcdef0123456789abcdef",
    },
    {
      dockerHost: LOCAL_DOCKER_HOST,
      projectName:
        "relmio-codex-chatgpt-0123456789ABCDEF0123456789ABCDEF",
    },
  ];

  for (const options of invalidOptions) {
    let spawned = false;
    await assert.rejects(
      () =>
        startCodexDeviceLogin({
          installDirectory: INSTALL_DIRECTORY,
          ...options,
          spawnProcess() {
            spawned = true;
          },
        }),
      /docker host|project|invalid|unsupported/i,
    );
    assert.equal(spawned, false);
  }
});

test("startCodexDeviceLogin rejects duplicate and out-of-order protocol messages", async (t) => {
  await t.test("login response before initialize", async () => {
    const fixture = createSpawnFixture();
    const loginPromise = startLogin(fixture);

    emitJsonLine(fixture.child, {
      id: 1,
      result: {
        loginId: "early-login",
        type: "chatgptDeviceCode",
        userCode: "ABCD-EFGH",
        verificationUrl: VERIFICATION_URL,
      },
    });

    await assert.rejects(loginPromise, /unexpected sign-in response/i);
  });

  await t.test("duplicate initialize response", async () => {
    const fixture = createSpawnFixture();
    const loginPromise = startLogin(fixture);

    emitInitializeResponse(fixture.child);
    emitInitializeResponse(fixture.child);

    await assert.rejects(loginPromise, /unexpected sign-in response/i);
  });

  await t.test("completion before login response", async () => {
    const fixture = createSpawnFixture();
    const loginPromise = startLogin(fixture);

    emitInitializeResponse(fixture.child);
    emitCompletion(fixture.child);

    await assert.rejects(loginPromise, /unexpected sign-in response/i);
  });

  await t.test("duplicate login response", async () => {
    const fixture = createSpawnFixture();
    const loginPromise = startLogin(fixture);
    emitDeviceResponse(fixture.child);
    const login = await loginPromise;

    emitDeviceResponse(fixture.child, { initialize: false });

    await assert.rejects(login.completion, /unexpected sign-in response/i);
  });
});

test("startCodexDeviceLogin requires a valid successful initialize response", async (t) => {
  for (const [label, message] of [
    ["initialize error", { id: 0, error: { code: -32_603 } }],
    ["missing result", { id: 0 }],
    ["non-object result", { id: 0, result: null }],
  ]) {
    await t.test(label, async () => {
      const fixture = createSpawnFixture();
      const loginPromise = startLogin(fixture);

      emitJsonLine(fixture.child, message);

      await assert.rejects(loginPromise, /could not be started|unexpected/i);
      assert.equal(fixture.child.stdin.writes.length, 1);
    });
  }
});

test("startCodexDeviceLogin parses complete JSONL records split across chunks", async () => {
  const fixture = createSpawnFixture();
  const loginPromise = startLogin(fixture);
  const response = Buffer.from(
    `${JSON.stringify({
      id: 1,
      result: {
        loginId: "login-partial",
        type: "chatgptDeviceCode",
        userCode: "ZXCV-1234",
        verificationUrl: `${VERIFICATION_URL}?flow=device`,
      },
    })}\r\n`,
  );

  emitInitializeResponse(fixture.child);
  fixture.child.stdout.emit("data", response.subarray(0, 7));
  fixture.child.stdout.emit("data", response.subarray(7, 29));
  fixture.child.stdout.emit("data", response.subarray(29));

  const login = await loginPromise;
  assert.equal(login.userCode, "ZXCV-1234");
  assert.equal(login.verificationUrl, `${VERIFICATION_URL}?flow=device`);
  emitCompletion(fixture.child, { loginId: "login-partial" });
  await assertPromisePending(login.completion);
  closeChild(fixture.child, 0);
  assert.deepEqual(await login.completion, { success: true });
});

test("completion resolves only for a successful notification with the matching login ID", async () => {
  const fixture = createSpawnFixture();
  const loginPromise = startLogin(fixture);
  emitDeviceResponse(fixture.child, { loginId: "matching-login" });
  const login = await loginPromise;

  emitCompletion(fixture.child, { loginId: "matching-login" });

  await assertPromisePending(login.completion);
  closeChild(fixture.child, 0);
  assert.deepEqual(await login.completion, { success: true });
  assert.equal(fixture.child.stdin.ended, true);
});

test("successful sign-in reclaims a child that ignores stdin EOF", async () => {
  const fixture = createSpawnFixture({ closeOnKill: false });
  const timers = createManualTimers();
  const loginPromise = startLogin(fixture, {
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    terminationGraceMs: 25,
  });
  emitDeviceResponse(fixture.child);
  const login = await loginPromise;

  emitCompletion(fixture.child);
  assert.equal(fixture.child.stdin.ended, true);
  await assertPromisePending(login.completion);

  timers.fire(25);
  assert.deepEqual(fixture.child.killSignals, ["SIGTERM"]);
  await assertPromisePending(login.completion);

  timers.fire(25);
  assert.deepEqual(fixture.child.killSignals, ["SIGTERM", "SIGKILL"]);
  await assertPromisePending(login.completion);

  timers.fire(25);
  assert.deepEqual(await login.completion, { success: true });
  assert.equal(timers.activeCount, 0);

  closeChild(fixture.child, 0);
});

test("completion rejects a failed notification without exposing its raw error", async () => {
  const fixture = createSpawnFixture();
  const loginPromise = startLogin(fixture);
  emitDeviceResponse(fixture.child);
  const login = await loginPromise;
  const secret = "access-token-that-must-not-leak";

  emitCompletion(fixture.child, { success: false, error: secret });

  await assert.rejects(login.completion, (error) => {
    assert.match(error.message, /sign-in.*not completed/i);
    assert.doesNotMatch(error.message, new RegExp(secret));
    assert.equal(error.cause, undefined);
    return true;
  });
  assert.deepEqual(fixture.child.killSignals, ["SIGTERM"]);
});

test("completion rejects a notification for a different login ID", async () => {
  const fixture = createSpawnFixture();
  const loginPromise = startLogin(fixture);
  emitDeviceResponse(fixture.child, { loginId: "expected-login" });
  const login = await loginPromise;

  emitCompletion(fixture.child, { loginId: "attacker-login" });

  await assert.rejects(login.completion, /unexpected sign-in response/i);
  assert.deepEqual(fixture.child.killSignals, ["SIGTERM"]);
});

for (const [label, result] of [
  ["wrong response type", { type: "chatgpt", loginId: "login-1", userCode: "ABCD-EFGH", verificationUrl: VERIFICATION_URL }],
  ["empty login ID", { type: "chatgptDeviceCode", loginId: "", userCode: "ABCD-EFGH", verificationUrl: VERIFICATION_URL }],
  ["invalid user code", { type: "chatgptDeviceCode", loginId: "login-1", userCode: "paste this command", verificationUrl: VERIFICATION_URL }],
  ["non-HTTPS URL", { type: "chatgptDeviceCode", loginId: "login-1", userCode: "ABCD-EFGH", verificationUrl: "http://auth.openai.com/device" }],
  ["lookalike host", { type: "chatgptDeviceCode", loginId: "login-1", userCode: "ABCD-EFGH", verificationUrl: "https://auth.openai.com.evil.test/device" }],
  ["URL credentials", { type: "chatgptDeviceCode", loginId: "login-1", userCode: "ABCD-EFGH", verificationUrl: "https://user:pass@auth.openai.com/device" }],
]) {
  test(`startCodexDeviceLogin rejects ${label}`, async () => {
    const fixture = createSpawnFixture();
    const loginPromise = startLogin(fixture);

    emitInitializeResponse(fixture.child);
    emitJsonLine(fixture.child, { id: 1, result });

    await assert.rejects(loginPromise, /unexpected sign-in response/i);
    assert.deepEqual(fixture.child.killSignals, ["SIGTERM"]);
  });
}

test("startCodexDeviceLogin rejects malformed JSON without echoing it", async () => {
  const fixture = createSpawnFixture();
  const loginPromise = startLogin(fixture);
  const secret = "raw-refresh-token-fixture";

  fixture.child.stdout.emit("data", Buffer.from(`{not-json:${secret}}\n`));

  await assert.rejects(loginPromise, (error) => {
    assert.match(error.message, /unexpected sign-in response/i);
    assert.doesNotMatch(error.message, new RegExp(secret));
    assert.equal(error.cause, undefined);
    return true;
  });
  assert.deepEqual(fixture.child.killSignals, ["SIGTERM"]);
});

test("startCodexDeviceLogin bounds both stdout lines and stderr output", async (t) => {
  await t.test("oversized stdout", async () => {
    const fixture = createSpawnFixture();
    const loginPromise = startLogin(fixture, {
      maxLineBytes: 32,
      maxStdoutBytes: 64,
    });

    fixture.child.stdout.emit("data", Buffer.from("x".repeat(33)));

    await assert.rejects(loginPromise, /too much data/i);
    assert.deepEqual(fixture.child.killSignals, ["SIGTERM"]);
  });

  await t.test("oversized stderr", async () => {
    const fixture = createSpawnFixture();
    const loginPromise = startLogin(fixture, {
      maxStderrBytes: 16,
    });

    fixture.child.stderr.emit("data", Buffer.from("secret-output-123"));

    await assert.rejects(loginPromise, (error) => {
      assert.match(error.message, /too much data/i);
      assert.doesNotMatch(error.message, /secret-output/u);
      return true;
    });
    assert.deepEqual(fixture.child.killSignals, ["SIGTERM"]);
  });
});

test("startCodexDeviceLogin waits for close before reporting output overflow", async () => {
  const fixture = createSpawnFixture({ closeOnKill: false });
  const timers = createManualTimers();
  const loginPromise = startLogin(fixture, {
    maxLineBytes: 32,
    maxStdoutBytes: 64,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    terminationGraceMs: 25,
  });

  fixture.child.stdout.emit("data", Buffer.from("x".repeat(33)));

  assert.deepEqual(fixture.child.killSignals, ["SIGTERM"]);
  await assertPromisePending(loginPromise);

  closeChild(fixture.child);
  await assert.rejects(loginPromise, /too much data/i);
  assert.equal(timers.activeCount, 0);
});

test("startCodexDeviceLogin sanitizes synchronous spawn failures and process errors", async (t) => {
  const secret = "docker-credential-secret";

  await t.test("synchronous spawn failure", async () => {
    await assert.rejects(
      () =>
        startCodexDeviceLogin({
          installDirectory: INSTALL_DIRECTORY,
          dockerHost: LOCAL_DOCKER_HOST,
          projectName: PROJECT_NAME,
          environment: CHILD_ENVIRONMENT,
          spawnProcess() {
            throw new Error(secret);
          },
        }),
      (error) => {
        assert.match(error.message, /could not start/i);
        assert.doesNotMatch(error.message, new RegExp(secret));
        assert.equal(error.cause, undefined);
        return true;
      },
    );
  });

  await t.test("asynchronous process error", async () => {
    const fixture = createSpawnFixture();
    const loginPromise = startLogin(fixture);

    fixture.child.emit("error", new Error(secret));

    await assert.rejects(loginPromise, (error) => {
      assert.match(error.message, /could not start/i);
      assert.doesNotMatch(error.message, new RegExp(secret));
      assert.equal(error.cause, undefined);
      return true;
    });
  });

  await t.test("process error after the device response", async () => {
    const fixture = createSpawnFixture();
    const loginPromise = startLogin(fixture);
    emitDeviceResponse(fixture.child);
    const login = await loginPromise;

    fixture.child.emit("error", new Error(secret));

    await assert.rejects(login.completion, (error) => {
      assert.match(error.message, /ended before sign-in completed/i);
      assert.doesNotMatch(error.message, new RegExp(secret));
      assert.equal(error.cause, undefined);
      return true;
    });
  });
});

test("startCodexDeviceLogin rejects close before the device response or completion", async (t) => {
  await t.test("close before device response", async () => {
    const fixture = createSpawnFixture();
    const loginPromise = startLogin(fixture);

    fixture.child.emit("close", 1);

    await assert.rejects(loginPromise, /ended before providing/i);
  });

  await t.test("close before completion", async () => {
    const fixture = createSpawnFixture();
    const loginPromise = startLogin(fixture);
    emitDeviceResponse(fixture.child);
    const login = await loginPromise;

    fixture.child.emit("close", 7);

    await assert.rejects(login.completion, /ended before sign-in completed/i);
  });
});

test("startCodexDeviceLogin settles after an ignored SIGKILL", async () => {
  const fixture = createSpawnFixture({ closeOnKill: false });
  const timers = createManualTimers();
  const loginPromise = startLogin(fixture, {
    responseTimeoutMs: 100,
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    terminationGraceMs: 25,
  });

  timers.fire(100);
  assert.deepEqual(fixture.child.killSignals, ["SIGTERM"]);
  await assertPromisePending(loginPromise);

  timers.fire(25);
  assert.deepEqual(fixture.child.killSignals, ["SIGTERM", "SIGKILL"]);
  await assertPromisePending(loginPromise);
  assert.equal(timers.activeCount, 1);

  timers.fire(25);
  await assert.rejects(loginPromise, /timed out/i);
  assert.equal(timers.activeCount, 0);

  closeChild(fixture.child);
});

test("completion times out and terminates the process", async () => {
  const fixture = createSpawnFixture();
  const loginPromise = startLogin(fixture, {
    completionTimeoutMs: 5,
  });
  emitDeviceResponse(fixture.child);
  const login = await loginPromise;

  await assert.rejects(login.completion, /timed out/i);
  assert.deepEqual(fixture.child.killSignals, ["SIGTERM"]);
});

test("cancel waits for process close and rejects completion with a safe error", async () => {
  const fixture = createSpawnFixture({ closeOnKill: false });
  const timers = createManualTimers();
  const loginPromise = startLogin(fixture, {
    setTimer: timers.setTimer,
    clearTimer: timers.clearTimer,
    terminationGraceMs: 25,
  });
  emitDeviceResponse(fixture.child);
  const login = await loginPromise;

  login.cancel();
  login.cancel();

  assert.deepEqual(fixture.child.killSignals, ["SIGTERM"]);
  await assertPromisePending(login.completion);

  closeChild(fixture.child);
  await assert.rejects(login.completion, /cancelled/i);
  assert.equal(timers.activeCount, 0);
});

test("errors never expose JSON-RPC error data or stderr", async () => {
  const fixture = createSpawnFixture();
  const loginPromise = startLogin(fixture);
  const token = "TEST_SECRET_SENTINEL_DO_NOT_LOG";
  fixture.child.stderr.emit("data", Buffer.from(`debug ${token}`));

  emitInitializeResponse(fixture.child);
  emitJsonLine(fixture.child, {
    id: 1,
    error: { code: -32603, message: `upstream rejected ${token}`, data: token },
  });

  await assert.rejects(loginPromise, (error) => {
    assert.match(error.message, /could not be started/i);
    assert.doesNotMatch(error.message, new RegExp(token.replaceAll(".", "\\.")));
    assert.equal(error.cause, undefined);
    return true;
  });
});

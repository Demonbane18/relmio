import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  getAuthStatus,
  readAuthContents,
  resolveAuthPath,
  startOAuthLogin,
} from "../src/services/oauth.js";

function createMemoryFileSystem(files) {
  return {
    async access(path) {
      if (!(path in files)) {
        const error = new Error("missing");
        error.code = "ENOENT";
        throw error;
      }
    },
    async readFile(path) {
      if (!(path in files)) {
        const error = new Error("missing");
        error.code = "ENOENT";
        throw error;
      }
      return Buffer.from(files[path]);
    },
    async stat(path) {
      if (!(path in files)) {
        const error = new Error("missing");
        error.code = "ENOENT";
        throw error;
      }
      return {
        mtime: new Date("2026-07-28T01:11:01.000Z"),
      };
    },
    async mkdir() {},
    async chmod() {},
    async copyFile(source, destination) {
      files[destination] = files[source];
    },
    async rm(path) {
      delete files[path];
    },
  };
}

test("resolveAuthPath uses wizard-only storage without exposing file contents", () => {
  assert.equal(
    resolveAuthPath({
      env: { N8N_OPENAI_OAUTH_HOME: "/safe/wizard" },
      homeDirectory: "/home/user",
    }),
    "/safe/wizard/auth.json",
  );
  assert.equal(
    resolveAuthPath({
      env: { CODEX_HOME: "/must/not/be/reused" },
      homeDirectory: "/home/user",
    }),
    "/home/user/.n8n-openai-oauth/auth.json",
  );
});

test("getAuthStatus reports the credential update time without its contents", async () => {
  const fileSystem = createMemoryFileSystem({
    "/home/user/.n8n-openai-oauth/auth.json": '{"fixture":true}',
  });

  const status = await getAuthStatus({
    fileSystem,
    env: {},
    homeDirectory: "/home/user",
  });

  assert.deepEqual(status, {
    exists: true,
    path: "/home/user/.n8n-openai-oauth/auth.json",
    updatedAt: "2026-07-28T01:11:01.000Z",
  });
  assert.equal(JSON.stringify(status).includes("fixture"), false);
});

test("readAuthContents rejects invalid or oversized credential files", async () => {
  const invalidFileSystem = createMemoryFileSystem({
    "/home/user/.n8n-openai-oauth/auth.json": "not-json",
  });

  await assert.rejects(
    () =>
      readAuthContents({
        fileSystem: invalidFileSystem,
        authPath: "/home/user/.n8n-openai-oauth/auth.json",
      }),
    /credential/i,
  );
});

test("startOAuthLogin returns one validated link and stores the credential after completion", async () => {
  const calls = [];
  const files = {};
  const fileSystem = createMemoryFileSystem(files);
  const spawnProcess = (command, args, options) => {
    const call = { command, args, options };
    calls.push(call);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = { resume() {} };
    child.kill = () => {};
    queueMicrotask(() => {
      const authorizationUrl = new URL(
        "https://auth.openai.com/oauth/authorize",
      );
      authorizationUrl.searchParams.set("response_type", "code");
      authorizationUrl.searchParams.set(
        "redirect_uri",
        "http://localhost:1455/auth/callback",
      );
      authorizationUrl.searchParams.set("state", "fixture-state");
      authorizationUrl.searchParams.set("code_challenge", "fixture-challenge");
      child.stdout.emit(
        "data",
        Buffer.from(`OpenAI OAuth login URL: ${authorizationUrl}\n`),
      );
      const oauthFileIndex = args.indexOf("--oauth-file");
      files[args[oauthFileIndex + 1]] = '{"fixture":true}';
      child.emit("exit", 0);
    });
    return child;
  };

  const login = await startOAuthLogin({
    fileSystem,
    env: {},
    homeDirectory: "/home/user",
    platform: "darwin",
    spawnProcess,
    createPendingId: () => "fixture",
  });

  assert.match(
    login.authorizationUrl,
    /^https:\/\/auth\.openai\.com\/oauth\/authorize\?/,
  );
  assert.deepEqual(await login.completion, { success: true });
  assert.equal(calls[0].command, "npx");
  assert.deepEqual(calls[0].args, [
    "--yes",
    "--ignore-scripts",
    "openai-oauth@2.0.0",
    "login",
    "--no-open",
    "--login-timeout-ms",
    "300000",
    "--oauth-file",
    "/home/user/.n8n-openai-oauth/auth.json.pending-fixture",
  ]);
  assert.equal(calls[0].options.shell, false);
  assert.deepEqual(calls[0].options.stdio, ["ignore", "pipe", "pipe"]);
  assert.equal(
    files["/home/user/.n8n-openai-oauth/auth.json"],
    '{"fixture":true}',
  );
  assert.equal(
    "/home/user/.n8n-openai-oauth/auth.json.pending-fixture" in files,
    false,
  );
});

test("startOAuthLogin saves a valid pending credential before the helper exits", async () => {
  const files = {};
  let child;
  let pendingAuthPath;
  let pollCount = 0;
  const spawnProcess = (_command, args) => {
    child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = { resume() {} };
    child.kill = () => {};
    pendingAuthPath = args[args.indexOf("--oauth-file") + 1];
    queueMicrotask(() => {
      const authorizationUrl = new URL(
        "https://auth.openai.com/oauth/authorize",
      );
      authorizationUrl.searchParams.set("response_type", "code");
      authorizationUrl.searchParams.set(
        "redirect_uri",
        "http://localhost:1455/auth/callback",
      );
      authorizationUrl.searchParams.set("state", "fixture-state");
      authorizationUrl.searchParams.set("code_challenge", "fixture-challenge");
      child.stdout.emit(
        "data",
        Buffer.from(`OpenAI OAuth login URL: ${authorizationUrl}\n`),
      );
    });
    return child;
  };

  const login = await startOAuthLogin({
    fileSystem: createMemoryFileSystem(files),
    env: {},
    homeDirectory: "/home/user",
    platform: "darwin",
    spawnProcess,
    createPendingId: () => "fresh",
    waitForCredentialPoll: async () => {
      pollCount += 1;
      files[pendingAuthPath] =
        pollCount === 1 ? "partially-written" : '{"fresh":true}';
    },
  });

  try {
    const result = await Promise.race([
      login.completion,
      new Promise((_, reject) => {
        setTimeout(
          () => reject(new Error("credential detection was too slow")),
          50,
        );
      }),
    ]);
    assert.deepEqual(result, { success: true });
    assert.equal(pollCount, 2);
    assert.equal(
      files["/home/user/.n8n-openai-oauth/auth.json"],
      '{"fresh":true}',
    );
  } finally {
    child.emit("exit", 1);
    login.cancel();
  }
});

test("startOAuthLogin rejects an unexpected authorization destination", async () => {
  const fileSystem = createMemoryFileSystem({});
  const spawnProcess = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = { resume() {} };
    child.kill = () => queueMicrotask(() => child.emit("exit", 1));
    queueMicrotask(() => {
      child.stdout.emit(
        "data",
        Buffer.from(
          "OpenAI OAuth login URL: https://example.test/oauth/authorize\n",
        ),
      );
    });
    return child;
  };

  await assert.rejects(
    () =>
      startOAuthLogin({
        fileSystem,
        env: {},
        homeDirectory: "/home/user",
        platform: "darwin",
        spawnProcess,
        createPendingId: () => "fixture",
      }),
    /unexpected destination/i,
  );
});

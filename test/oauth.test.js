import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  getAuthStatus,
  readAuthContents,
  resolveAuthPath,
  runOAuthLogin,
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
  };
}

test("resolveAuthPath respects CODEX_HOME without exposing file contents", () => {
  assert.equal(
    resolveAuthPath({
      env: { CODEX_HOME: "/safe/codex" },
      homeDirectory: "/home/user",
    }),
    "/safe/codex/auth.json",
  );
  assert.equal(
    resolveAuthPath({ env: {}, homeDirectory: "/home/user" }),
    "/home/user/.codex/auth.json",
  );
});

test("getAuthStatus reports only existence and path", async () => {
  const fileSystem = createMemoryFileSystem({
    "/home/user/.codex/auth.json": '{"fixture":true}',
  });

  const status = await getAuthStatus({
    fileSystem,
    env: {},
    homeDirectory: "/home/user",
  });

  assert.deepEqual(status, {
    exists: true,
    path: "/home/user/.codex/auth.json",
  });
  assert.equal(JSON.stringify(status).includes("fixture"), false);
});

test("readAuthContents rejects invalid or oversized credential files", async () => {
  const invalidFileSystem = createMemoryFileSystem({
    "/home/user/.codex/auth.json": "not-json",
  });

  await assert.rejects(
    () =>
      readAuthContents({
        fileSystem: invalidFileSystem,
        authPath: "/home/user/.codex/auth.json",
      }),
    /credential/i,
  );
});

test("runOAuthLogin invokes the pinned login and confirms the requested refresh", async () => {
  const calls = [];
  const fileSystem = createMemoryFileSystem({
    "/home/user/.codex/auth.json": '{"fixture":true}',
  });
  const spawnProcess = (command, args, options) => {
    const call = { command, args, options, stdin: "" };
    calls.push(call);
    const child = new EventEmitter();
    child.stdin = {
      end(contents) {
        call.stdin = contents;
      },
    };
    child.stdout = { resume() {} };
    child.stderr = { resume() {} };
    queueMicrotask(() => child.emit("exit", 0));
    return child;
  };

  const result = await runOAuthLogin({
    fileSystem,
    env: {},
    homeDirectory: "/home/user",
    platform: "darwin",
    spawnProcess,
  });

  assert.deepEqual(result, { success: true });
  assert.equal(calls[0].command, "npx");
  assert.deepEqual(calls[0].args, [
    "--yes",
    "openai-oauth@2.0.0",
    "login",
    "--open",
    "--login-timeout-ms",
    "300000",
  ]);
  assert.equal(calls[0].options.shell, false);
  assert.deepEqual(calls[0].options.stdio, ["pipe", "pipe", "pipe"]);
  assert.equal(calls[0].stdin, "y\n");
});

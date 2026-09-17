import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { dirname, resolve } from "node:path";
import test from "node:test";

import {
  getAuthStatus,
  readAuthContents,
  resolveAuthPath,
  startOAuthLogin,
} from "../src/services/oauth.js";

const noOpLockDownPath = async () => {};

function credentialContents(label = "fixture") {
  return JSON.stringify({
    auth_mode: "chatgpt",
    tokens: {
      access_token: `access-${label}`,
      id_token: `id-${label}`,
      refresh_token: `refresh-${label}`,
    },
  });
}

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
    async rename(source, destination) {
      files[destination] = files[source];
      delete files[source];
    },
    async rm(path) {
      delete files[path];
    },
  };
}

function finishChild(child, code) {
  child.emit("exit", code);
  child.emit("close", code);
}

function createAuthorizationUrl({
  redirectUri = "http://localhost:1455/auth/callback",
} = {}) {
  const authorizationUrl = new URL("https://auth.openai.com/oauth/authorize");
  authorizationUrl.searchParams.set("response_type", "code");
  authorizationUrl.searchParams.set("redirect_uri", redirectUri);
  authorizationUrl.searchParams.set("state", "fixture-state");
  authorizationUrl.searchParams.set("code_challenge", "fixture-challenge");
  return authorizationUrl;
}

function pendingAuthPathFromOptions(options) {
  return resolve(options.env.CODEX_HOME, "auth.json");
}

test("resolveAuthPath uses wizard-only storage without exposing file contents", () => {
  const configuredHomeDirectory = resolve("oauth-configured-home");
  const defaultHomeDirectory = resolve("oauth-default-home");
  assert.equal(
    resolveAuthPath({
      env: { N8N_OPENAI_OAUTH_HOME: configuredHomeDirectory },
      homeDirectory: defaultHomeDirectory,
    }),
    resolve(configuredHomeDirectory, "auth.json"),
  );
  assert.equal(
    resolveAuthPath({
      env: { CODEX_HOME: "/must/not/be/reused" },
      homeDirectory: defaultHomeDirectory,
    }),
    resolve(defaultHomeDirectory, ".n8n-openai-oauth", "auth.json"),
  );
});

test("getAuthStatus reports the credential update time without its contents", async () => {
  const homeDirectory = resolve("oauth-status-home");
  const authPath = resolve(homeDirectory, ".n8n-openai-oauth", "auth.json");
  const fileSystem = createMemoryFileSystem({
    [authPath]: '{"fixture":true}',
  });

  const status = await getAuthStatus({
    fileSystem,
    env: {},
    homeDirectory,
  });

  assert.deepEqual(status, {
    exists: true,
    path: authPath,
    updatedAt: "2026-07-28T01:11:01.000Z",
  });
  assert.equal(JSON.stringify(status).includes("fixture"), false);
});

test("readAuthContents accepts only complete ChatGPT credential files", async () => {
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

  invalidFileSystem.readFile = async () =>
    Buffer.from('{"auth_mode":"chatgpt","tokens":{"access_token":"partial"}}');
  await assert.rejects(
    () =>
      readAuthContents({
        fileSystem: invalidFileSystem,
        authPath: "/home/user/.n8n-openai-oauth/auth.json",
      }),
    /credential/i,
  );

  const expected = credentialContents("complete");
  invalidFileSystem.readFile = async () => Buffer.from(expected);
  assert.deepEqual(
    await readAuthContents({
      fileSystem: invalidFileSystem,
      authPath: "/home/user/.n8n-openai-oauth/auth.json",
    }),
    Buffer.from(expected),
  );
});

test("startOAuthLogin uses the pinned official Codex browser login in an isolated home", async () => {
  const calls = [];
  const files = {};
  const homeDirectory = resolve("oauth-official-login-home");
  const fileSystem = createMemoryFileSystem(files);
  const spawnProcess = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stderr.resume = () => {};
    child.kill = () => {};
    queueMicrotask(() => {
      if (typeof options.env.CODEX_HOME === "string") {
        files[resolve(options.env.CODEX_HOME, "auth.json")] =
          credentialContents("official");
      } else {
        const oauthFileIndex = args.indexOf("--oauth-file");
        if (oauthFileIndex >= 0) {
          files[args[oauthFileIndex + 1]] = '{"fixture":true}';
          child.stdout.emit(
            "data",
            Buffer.from(`OpenAI OAuth login URL: ${createAuthorizationUrl()}\n`),
          );
        }
      }
      finishChild(child, 0);
    });
    return child;
  };

  const login = await startOAuthLogin({
    fileSystem,
    env: { CODEX_HOME: "C:\\must-not-be-reused" },
    homeDirectory,
    platform: "win32",
    execPath: "C:\\portable\\node.exe",
    spawnProcess,
    createPendingId: () => "official-fixture",
    lockDownPath: noOpLockDownPath,
  });

  assert.equal(login.launchMode, "system-browser");
  assert.equal(Object.hasOwn(login, "authorizationUrl"), false);
  assert.deepEqual(await login.completion, { success: true });
  assert.deepEqual(calls[0].args.slice(1), [
    "--yes",
    "--ignore-scripts",
    "--package=@openai/codex@0.154.0",
    "--",
    "codex",
    "-c",
    'cli_auth_credentials_store="file"',
    "login",
  ]);
  assert.notEqual(calls[0].options.env.CODEX_HOME, "C:\\must-not-be-reused");
  assert.equal(
    files[resolve(homeDirectory, ".n8n-openai-oauth", "auth.json")],
    credentialContents("official"),
  );
});

test("startOAuthLogin stores the official Codex credential after process completion", async () => {
  const calls = [];
  const files = {};
  const homeDirectory = resolve("oauth-login-home");
  const authPath = resolve(homeDirectory, ".n8n-openai-oauth", "auth.json");
  const fileSystem = createMemoryFileSystem(files);
  const spawnProcess = (command, args, options) => {
    const call = { command, args, options };
    calls.push(call);
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = { resume() {} };
    child.kill = () => {};
    queueMicrotask(() => {
      files[pendingAuthPathFromOptions(options)] = credentialContents("stored");
      finishChild(child, 0);
    });
    return child;
  };

  const login = await startOAuthLogin({
    fileSystem,
    env: {},
    homeDirectory,
    platform: "darwin",
    spawnProcess,
    createPendingId: () => "fixture",
  });

  assert.equal(login.launchMode, "system-browser");
  assert.deepEqual(await login.completion, { success: true });
  assert.equal(calls[0].command, "npx");
  assert.deepEqual(calls[0].args, [
    "--yes",
    "--ignore-scripts",
    "--package=@openai/codex@0.154.0",
    "--",
    "codex",
    "-c",
    'cli_auth_credentials_store="file"',
    "login",
  ]);
  assert.equal(calls[0].options.shell, false);
  assert.deepEqual(calls[0].options.stdio, ["ignore", "pipe", "pipe"]);
  assert.equal(
    files[authPath],
    credentialContents("stored"),
  );
  assert.equal(Object.keys(files).some((path) => path.includes(".codex-login-")), false);
});

test("startOAuthLogin does not expose captured helper output to the browser UI", async () => {
  const files = {};
  const spawnProcess = (_command, _args, options) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stderr.resume = () => {};
    child.kill = () => {};
    queueMicrotask(() => {
      child.stdout.emit(
        "data",
        Buffer.from("Opening browser for ChatGPT sign-in. token=must-not-leak\n"),
      );
      files[pendingAuthPathFromOptions(options)] = credentialContents("captured");
      finishChild(child, 0);
    });
    return child;
  };

  const login = await startOAuthLogin({
    fileSystem: createMemoryFileSystem(files),
    env: {},
    homeDirectory: "/home/user",
    platform: "win32",
    execPath: "C:\\portable\\node.exe",
    spawnProcess,
    createPendingId: () => "captured-output",
    lockDownPath: noOpLockDownPath,
  });

  assert.equal(login.launchMode, "system-browser");
  assert.equal(Object.hasOwn(login, "authorizationUrl"), false);
  assert.doesNotMatch(JSON.stringify(login), /must-not-leak|token=/u);
  assert.deepEqual(await login.completion, { success: true });
});

test("startOAuthLogin waits for close after exit before committing success", async () => {
  const files = {};
  let child;
  let codexAuthPath;
  const spawnProcess = (_command, _args, options) => {
    child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stderr.resume = () => {};
    child.kill = () => {};
    codexAuthPath = pendingAuthPathFromOptions(options);
    queueMicrotask(() => {
      child.emit("exit", 0);
      files[codexAuthPath] = credentialContents("drained");
    });
    return child;
  };

  const login = await startOAuthLogin({
    fileSystem: createMemoryFileSystem(files),
    env: {},
    homeDirectory: "/home/user",
    platform: "win32",
    execPath: "C:\\portable\\node.exe",
    spawnProcess,
    createPendingId: () => "drained-output",
    lockDownPath: noOpLockDownPath,
  });

  let completionSettled = false;
  login.completion.finally(() => {
    completionSettled = true;
  });
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.equal(completionSettled, false);
  child.emit("close", 0);
  assert.deepEqual(await login.completion, { success: true });
});

test("startOAuthLogin surfaces a sanitized callback port conflict from stderr", async () => {
  const calls = [];
  const spawnProcess = (command, args) => {
    calls.push({ command, args });
    const child = new EventEmitter();
    if (command === "taskkill") {
      return child;
    }
    child.pid = 5150;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stderr.resume = () => {};
    child.kill = () => {};
    queueMicrotask(() => {
      child.emit("exit", 1);
      child.stderr.emit(
        "data",
        Buffer.from(
          "\u001B[31mOpenAI OAuth login needs http://localhost:1455/auth/callback, but port 1455 is already in use. Stop the process using that port and try again. token=not-for-users\u001B[0m\r\n",
        ),
      );
      child.emit("close", 1);
    });
    return child;
  };

  const login = await startOAuthLogin({
    fileSystem: createMemoryFileSystem({}),
    env: {},
    homeDirectory: "/home/user",
    platform: "win32",
    execPath: "C:\\portable\\node.exe",
    spawnProcess,
    createPendingId: () => "port-conflict",
    terminationGraceMs: 0,
    terminationForceWaitMs: 0,
    lockDownPath: noOpLockDownPath,
  });
  await assert.rejects(
    login.completion,
    (error) => {
      assert.equal(
        error.message,
        "ChatGPT sign-in could not open its local callback port. Close other sign-in helpers and try again.",
      );
      assert.doesNotMatch(error.message, /not-for-users|token=/u);
      assert.equal(error.retryBlocked, undefined);
      return true;
    },
  );
  assert.deepEqual(calls.slice(1), []);
});

test("startOAuthLogin uses the current Node runtime and commits only a pre-secured Windows credential", async () => {
  const calls = [];
  const files = {};
  const execPath =
    process.platform === "win32"
      ? "C:\\portable\\node.exe"
      : "/portable/node.exe";
  const homeDirectory = resolve("oauth-fixture-home");
  const authPath = resolve(homeDirectory, ".n8n-openai-oauth", "auth.json");
  const memoryFileSystem = createMemoryFileSystem(files);
  let credentialCommitted = false;
  const fileSystem = {
    ...memoryFileSystem,
    async chmod(path, mode) {
      if (credentialCommitted) {
        throw new Error("injected post-commit permission failure");
      }
      await memoryFileSystem.chmod(path, mode);
    },
    async rename(source, destination) {
      await memoryFileSystem.rename(source, destination);
      if (destination === authPath) credentialCommitted = true;
    },
  };
  const npmExecPath = "/custom/npm-cli.js";
  const expectedNpxCliPath = resolve(dirname(npmExecPath), "npx-cli.js");
  const aclCalls = [];
  const spawnProcess = (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = { resume() {} };
    child.kill = () => {};
    queueMicrotask(() => {
      files[pendingAuthPathFromOptions(options)] = credentialContents("windows");
      finishChild(child, 0);
    });
    return child;
  };

  const login = await startOAuthLogin({
    fileSystem,
    env: {
      npm_execpath: npmExecPath,
      NPM_CONFIG_LEGACY_PEER_DEPS: "true",
      NPM_CONFIG_OMIT: "peer",
    },
    homeDirectory,
    platform: "win32",
    execPath,
    spawnProcess,
    createPendingId: () => "windows-fixture",
    async lockDownPath(path, options) {
      if (credentialCommitted) {
        throw new Error("injected post-commit ACL failure");
      }
      aclCalls.push({ path, options });
    },
  });

  assert.equal(calls[0].command, execPath);
  assert.equal(calls[0].args[0], expectedNpxCliPath);
  assert.deepEqual(calls[0].args.slice(1), [
    "--yes",
    "--ignore-scripts",
    "--package=@openai/codex@0.154.0",
    "--",
    "codex",
    "-c",
    'cli_auth_credentials_store="file"',
    "login",
  ]);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.env.NPM_CONFIG_LEGACY_PEER_DEPS, "true");
  assert.equal(calls[0].options.env.NPM_CONFIG_OMIT, "peer");
  assert.deepEqual(await login.completion, { success: true });
  assert.equal(
    files[authPath],
    credentialContents("windows"),
  );
  assert.equal(credentialCommitted, true);
  const codexHome = calls[0].options.env.CODEX_HOME;
  const codexAuthPath = resolve(codexHome, "auth.json");
  assert.deepEqual(aclCalls, [
    { path: dirname(authPath), options: { platform: "win32", kind: "directory" } },
    { path: codexHome, options: { platform: "win32", kind: "directory" } },
    { path: codexAuthPath, options: { platform: "win32", kind: "file" } },
    { path: `${codexAuthPath}.ready`, options: { platform: "win32", kind: "file" } },
  ]);
});

test("startOAuthLogin hides synchronous process-launch errors", async () => {
  let invocation;
  const removed = [];
  const memoryFileSystem = createMemoryFileSystem({});
  const fileSystem = {
    ...memoryFileSystem,
    async rm(path, options) {
      removed.push({ path, options });
      await memoryFileSystem.rm(path, options);
    },
  };
  const spawnProcess = (command, args) => {
    invocation = { command, args };
    const error = new Error("spawn EINVAL");
    error.code = "EINVAL";
    throw error;
  };

  await assert.rejects(
    () =>
      startOAuthLogin({
        fileSystem,
        env: {},
        homeDirectory: resolve("oauth-sync-error-home"),
        platform: "win32",
        execPath: "/portable/node.exe",
        spawnProcess,
        createPendingId: () => "sync-error",
        lockDownPath: noOpLockDownPath,
      }),
    (error) => {
      assert.equal(
        error.message,
        "The local sign-in command could not start. Update Relmio and retry with Node.js 24 or newer.",
      );
      assert.equal(error.code, undefined);
      return true;
    },
  );
  assert.equal(invocation.command, "/portable/node.exe");
  assert.equal(
    invocation.args[0],
    resolve(
      dirname("/portable/node.exe"),
      "node_modules",
      "npm",
      "bin",
      "npx-cli.js",
    ),
  );
  assert.deepEqual(removed, [
    {
      path: resolve(
        "oauth-sync-error-home",
        ".n8n-openai-oauth",
        ".codex-login-sync-error",
      ),
      options: { recursive: true, force: true },
    },
  ]);
});

test("startOAuthLogin waits for the official helper to close before promoting a valid credential", async () => {
  const files = {};
  let child;
  let pendingAuthPath;
  let pollCount = 0;
  const homeDirectory = resolve("oauth-fresh-home");
  const authPath = resolve(homeDirectory, ".n8n-openai-oauth", "auth.json");
  const spawnProcess = (_command, _args, options) => {
    child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = { resume() {} };
    child.kill = () => queueMicrotask(() => finishChild(child, 1));
    pendingAuthPath = pendingAuthPathFromOptions(options);
    return child;
  };

  const login = await startOAuthLogin({
    fileSystem: createMemoryFileSystem(files),
    env: {},
    homeDirectory,
    platform: "darwin",
    spawnProcess,
    createPendingId: () => "fresh",
    terminationGraceMs: 0,
    terminationForceWaitMs: 0,
    waitForCredentialPoll: async () => {
      pollCount += 1;
      files[pendingAuthPath] =
        pollCount === 1 ? "partially-written" : credentialContents("fresh");
    },
  });

  await new Promise((resolvePromise) => setTimeout(resolvePromise, 20));
  assert.equal(pollCount, 2);
  assert.equal(Object.hasOwn(files, authPath), false);
  let completionSettled = false;
  login.completion.finally(() => {
    completionSettled = true;
  });
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.equal(completionSettled, false);
  finishChild(child, 0);
  assert.deepEqual(await login.completion, { success: true });
  assert.equal(files[authPath], credentialContents("fresh"));
});

test("startOAuthLogin rejects an unsafe attempt identifier before filesystem or process effects", async () => {
  let effects = 0;
  await assert.rejects(
    () => startOAuthLogin({
      fileSystem: {
        ...createMemoryFileSystem({}),
        async mkdir() {
          effects += 1;
        },
      },
      env: {},
      homeDirectory: "/home/user",
      spawnProcess() {
        effects += 1;
      },
      createPendingId: () => "../unsafe",
    }),
    /attempt identifier is invalid/u,
  );
  assert.equal(effects, 0);
});

test("startOAuthLogin cancels the detached helper process group with a bounded forceful fallback", async () => {
  const signals = [];
  let processGroupGone = false;
  let spawnOptions;
  const spawnProcess = (_command, _args, options) => {
    spawnOptions = options;
    const child = new EventEmitter();
    child.pid = 4242;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {
      throw new Error("The wrapper process must not be the only cancellation target.");
    };
    queueMicrotask(() => {
      child.stdout.emit(
        "data",
        Buffer.from(
          `OpenAI OAuth login URL: ${createAuthorizationUrl()}\n`,
        ),
      );
    });
    return child;
  };

  const login = await startOAuthLogin({
    fileSystem: createMemoryFileSystem({}),
    env: {},
    homeDirectory: "/home/user",
    platform: "darwin",
    spawnProcess,
    createPendingId: () => "process-tree",
    killProcess(pid, signal) {
      signals.push([pid, signal]);
      if (signal === "SIGKILL") {
        processGroupGone = true;
      }
      if (signal === 0 && processGroupGone) {
        const error = new Error("gone");
        error.code = "ESRCH";
        throw error;
      }
    },
    terminationGraceMs: 50,
    terminationForceWaitMs: 50,
  });

  await login.cancel();
  await assert.rejects(login.completion, /stopped|fresh login/i);
  assert.equal(spawnOptions.detached, true);
  assert.deepEqual(signals, [
    [-4242, "SIGTERM"],
    [-4242, 0],
    [-4242, 0],
    [-4242, "SIGKILL"],
    [-4242, 0],
  ]);
});

test("startOAuthLogin cancellation waits for a delayed promotion and keeps the older credential", async () => {
  const files = {};
  const homeDirectory = resolve("oauth-cancel-promotion-home");
  const authPath = resolve(homeDirectory, ".n8n-openai-oauth", "auth.json");
  files[authPath] = credentialContents("older");
  const memoryFileSystem = createMemoryFileSystem(files);
  let child;
  let pendingAuthPath;
  let releaseCopy;
  const copyRelease = new Promise((resolvePromise) => {
    releaseCopy = resolvePromise;
  });
  let markCopyStarted;
  const copyStarted = new Promise((resolvePromise) => {
    markCopyStarted = resolvePromise;
  });
  const fileSystem = {
    ...memoryFileSystem,
    async copyFile(source, destination) {
      markCopyStarted();
      await copyRelease;
      files[destination] = files[source];
    },
  };
  const spawnProcess = (_command, _args, options) => {
    child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => queueMicrotask(() => finishChild(child, 1));
    pendingAuthPath = pendingAuthPathFromOptions(options);
    queueMicrotask(() => {
      child.stdout.emit(
        "data",
        Buffer.from(`OpenAI OAuth login URL: ${createAuthorizationUrl()}\n`),
      );
    });
    return child;
  };

  const login = await startOAuthLogin({
    fileSystem,
    env: {},
    homeDirectory,
    platform: "darwin",
    spawnProcess,
    createPendingId: () => "cancel-promotion",
    terminationGraceMs: 50,
    terminationForceWaitMs: 50,
    waitForCredentialPoll: async () => {
      files[pendingAuthPath] = credentialContents("newer");
      finishChild(child, 0);
    },
  });

  await copyStarted;
  let cancellationFinished = false;
  const cancellation = login.cancel().then(() => {
    cancellationFinished = true;
  });
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  assert.equal(cancellationFinished, false);

  releaseCopy();
  await cancellation;
  await assert.rejects(login.completion, /stopped|fresh login/i);
  assert.equal(files[authPath], credentialContents("older"));
});

test("startOAuthLogin rejects cancellation when the detached process group survives both signals", async () => {
  const signals = [];
  const spawnProcess = () => {
    const child = new EventEmitter();
    child.pid = 4343;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {
      throw new Error("The detached process group must be signalled instead.");
    };
    queueMicrotask(() => {
      child.stdout.emit(
        "data",
        Buffer.from(`OpenAI OAuth login URL: ${createAuthorizationUrl()}\n`),
      );
    });
    return child;
  };

  const login = await startOAuthLogin({
    fileSystem: createMemoryFileSystem({}),
    env: {},
    homeDirectory: "/home/user",
    platform: "darwin",
    spawnProcess,
    createPendingId: () => "surviving-process-group",
    killProcess(pid, signal) {
      signals.push([pid, signal]);
    },
    terminationGraceMs: 0,
    terminationForceWaitMs: 0,
    lockDownPath: noOpLockDownPath,
  });

  await assert.rejects(
    login.cancel(),
    /could not be stopped safely/i,
  );
  assert.deepEqual(signals, [
    [-4343, "SIGTERM"],
    [-4343, 0],
    [-4343, 0],
    [-4343, "SIGKILL"],
    [-4343, 0],
    [-4343, 0],
  ]);
});

test("startOAuthLogin rejects cancellation when Windows taskkill cannot confirm its tree", async () => {
  const calls = [];
  const spawnProcess = (command, args) => {
    calls.push({ command, args });
    const child = new EventEmitter();
    if (command === "taskkill") {
      queueMicrotask(() => finishChild(child, 1));
      return child;
    }
    child.pid = 5454;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {
      throw new Error("taskkill must own the Windows process tree.");
    };
    queueMicrotask(() => {
      child.stdout.emit(
        "data",
        Buffer.from(`OpenAI OAuth login URL: ${createAuthorizationUrl()}\n`),
      );
    });
    return child;
  };

  const login = await startOAuthLogin({
    fileSystem: createMemoryFileSystem({}),
    env: {},
    homeDirectory: "/home/user",
    platform: "win32",
    execPath: "C:\\portable\\node.exe",
    spawnProcess,
    createPendingId: () => "taskkill-nonzero",
    terminationGraceMs: 0,
    terminationForceWaitMs: 0,
    lockDownPath: noOpLockDownPath,
  });

  await assert.rejects(
    login.cancel(),
    /could not be stopped safely/i,
  );
  assert.deepEqual(calls.slice(1), [
    { command: "taskkill", args: ["/pid", "5454", "/t"] },
    { command: "taskkill", args: ["/pid", "5454", "/t", "/f"] },
  ]);
});

test("startOAuthLogin bounds a hung Windows taskkill and reports unconfirmed termination", async () => {
  const calls = [];
  const spawnProcess = (command, args) => {
    calls.push({ command, args });
    const child = new EventEmitter();
    if (command === "taskkill") {
      return child;
    }
    child.pid = 5555;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {
      throw new Error("taskkill must own the Windows process tree.");
    };
    queueMicrotask(() => {
      child.stdout.emit(
        "data",
        Buffer.from(`OpenAI OAuth login URL: ${createAuthorizationUrl()}\n`),
      );
    });
    return child;
  };

  const login = await startOAuthLogin({
    fileSystem: createMemoryFileSystem({}),
    env: {},
    homeDirectory: "/home/user",
    platform: "win32",
    execPath: "C:\\portable\\node.exe",
    spawnProcess,
    createPendingId: () => "taskkill-hung",
    terminationGraceMs: 0,
    terminationForceWaitMs: 0,
    lockDownPath: noOpLockDownPath,
  });

  await assert.rejects(
    login.cancel(),
    /could not be stopped safely/i,
  );
  assert.deepEqual(calls.slice(1), [
    { command: "taskkill", args: ["/pid", "5555", "/t"] },
    { command: "taskkill", args: ["/pid", "5555", "/t", "/f"] },
  ]);
});

test("startOAuthLogin reports cancellation as indeterminate after final credential commit begins", async () => {
  const files = {};
  const homeDirectory = resolve("oauth-rename-barrier-home");
  const authPath = resolve(homeDirectory, ".n8n-openai-oauth", "auth.json");
  files[authPath] = credentialContents("older");
  const memoryFileSystem = createMemoryFileSystem(files);
  let child;
  let pendingAuthPath;
  let releaseRename;
  const renameRelease = new Promise((resolvePromise) => {
    releaseRename = resolvePromise;
  });
  let markRenameStarted;
  const renameStarted = new Promise((resolvePromise) => {
    markRenameStarted = resolvePromise;
  });
  const fileSystem = {
    ...memoryFileSystem,
    async rename(source, destination) {
      markRenameStarted();
      await renameRelease;
      files[destination] = files[source];
      delete files[source];
    },
  };
  const spawnProcess = (_command, _args, options) => {
    child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => queueMicrotask(() => finishChild(child, 1));
    pendingAuthPath = pendingAuthPathFromOptions(options);
    queueMicrotask(() => {
      child.stdout.emit(
        "data",
        Buffer.from(`OpenAI OAuth login URL: ${createAuthorizationUrl()}\n`),
      );
    });
    return child;
  };

  const login = await startOAuthLogin({
    fileSystem,
    env: {},
    homeDirectory,
    platform: "darwin",
    spawnProcess,
    createPendingId: () => "rename-barrier",
    terminationGraceMs: 50,
    terminationForceWaitMs: 50,
    waitForCredentialPoll: async () => {
      files[pendingAuthPath] = credentialContents("newer");
      finishChild(child, 0);
    },
  });

  await renameStarted;
  let cancellationSettled = false;
  const cancellation = login.cancel().finally(() => {
    cancellationSettled = true;
  });
  await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
  assert.equal(cancellationSettled, false);

  releaseRename();
  await assert.rejects(cancellation, /could not be stopped safely/i);
  assert.equal(files[authPath], credentialContents("newer"));
});

test("startOAuthLogin bounds a never-settling staged promotion and blocks its later final write", async () => {
  const files = {};
  const homeDirectory = resolve("oauth-never-settling-promotion-home");
  const authPath = resolve(homeDirectory, ".n8n-openai-oauth", "auth.json");
  files[authPath] = credentialContents("older");
  const memoryFileSystem = createMemoryFileSystem(files);
  let child;
  let pendingAuthPath;
  let releaseCopy;
  const copyRelease = new Promise((resolvePromise) => {
    releaseCopy = resolvePromise;
  });
  let markCopyStarted;
  const copyStarted = new Promise((resolvePromise) => {
    markCopyStarted = resolvePromise;
  });
  const fileSystem = {
    ...memoryFileSystem,
    async copyFile(source, destination) {
      markCopyStarted();
      await copyRelease;
      files[destination] = files[source];
    },
  };
  const spawnProcess = (_command, _args, options) => {
    child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => queueMicrotask(() => finishChild(child, 1));
    pendingAuthPath = pendingAuthPathFromOptions(options);
    queueMicrotask(() => {
      child.stdout.emit(
        "data",
        Buffer.from(`OpenAI OAuth login URL: ${createAuthorizationUrl()}\n`),
      );
    });
    return child;
  };

  const login = await startOAuthLogin({
    fileSystem,
    env: {},
    homeDirectory,
    platform: "darwin",
    spawnProcess,
    createPendingId: () => "never-settling-promotion",
    terminationGraceMs: 0,
    terminationForceWaitMs: 0,
    waitForCredentialPoll: async () => {
      files[pendingAuthPath] = credentialContents("newer");
      finishChild(child, 0);
    },
  });

  await copyStarted;
  try {
    const result = await Promise.race([
      login.cancel().then(
        () => "resolved",
        () => "rejected",
      ),
      new Promise((resolvePromise) => {
        setTimeout(() => resolvePromise("timed out"), 50);
      }),
    ]);
    assert.equal(result, "rejected");
  } finally {
    releaseCopy();
  }
  await new Promise((resolvePromise) => setImmediate(resolvePromise));
  assert.equal(files[authPath], credentialContents("older"));
});

test("startOAuthLogin marks a timeout retry-blocked when final credential commit has started", async () => {
  const files = {};
  const homeDirectory = resolve("oauth-timeout-rename-home");
  const authPath = resolve(homeDirectory, ".n8n-openai-oauth", "auth.json");
  files[authPath] = credentialContents("older");
  const memoryFileSystem = createMemoryFileSystem(files);
  let child;
  let pendingAuthPath;
  let releaseRename;
  const renameRelease = new Promise((resolvePromise) => {
    releaseRename = resolvePromise;
  });
  let markRenameStarted;
  const renameStarted = new Promise((resolvePromise) => {
    markRenameStarted = resolvePromise;
  });
  const fileSystem = {
    ...memoryFileSystem,
    async rename(source, destination) {
      markRenameStarted();
      await renameRelease;
      files[destination] = files[source];
      delete files[source];
    },
  };
  let fireProcessTimeout;
  const createTimer = (callback, milliseconds) => {
    if (milliseconds === 315_000) {
      fireProcessTimeout = callback;
      return { milliseconds };
    }
    if (milliseconds === 0) {
      queueMicrotask(callback);
    }
    return { milliseconds };
  };
  const spawnProcess = (_command, _args, options) => {
    child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => queueMicrotask(() => finishChild(child, 1));
    pendingAuthPath = pendingAuthPathFromOptions(options);
    queueMicrotask(() => {
      child.stdout.emit(
        "data",
        Buffer.from(`OpenAI OAuth login URL: ${createAuthorizationUrl()}\n`),
      );
    });
    return child;
  };

  const login = await startOAuthLogin({
    fileSystem,
    env: {},
    homeDirectory,
    platform: "darwin",
    spawnProcess,
    createPendingId: () => "timeout-rename",
    createTimer,
    clearTimer() {},
    terminationGraceMs: 50,
    terminationForceWaitMs: 50,
    waitForCredentialPoll: async () => {
      files[pendingAuthPath] = credentialContents("newer");
      finishChild(child, 0);
    },
  });

  await renameStarted;
  fireProcessTimeout();
  releaseRename();
  await assert.rejects(login.completion, (error) => {
    assert.equal(error.retryBlocked, true);
    assert.match(error.message, /could not be stopped safely/i);
    return true;
  });
  assert.equal(files[authPath], credentialContents("newer"));
});

test("startOAuthLogin does not signal an already-closed failed helper", async () => {
  const signals = [];
  let child;
  const spawnProcess = () => {
    child = new EventEmitter();
    child.pid = 6262;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {
      throw new Error("The detached process group must be signalled instead.");
    };
    queueMicrotask(() => {
      child.stdout.emit(
        "data",
        Buffer.from(`OpenAI OAuth login URL: ${createAuthorizationUrl()}\n`),
      );
    });
    return child;
  };

  const login = await startOAuthLogin({
    fileSystem: createMemoryFileSystem({}),
    env: {},
    homeDirectory: "/home/user",
    platform: "darwin",
    spawnProcess,
    createPendingId: () => "unconfirmed-after-url",
    killProcess(pid, signal) {
      signals.push([pid, signal]);
    },
    terminationGraceMs: 0,
    terminationForceWaitMs: 0,
  });

  finishChild(child, 1);
  await assert.rejects(login.completion, (error) => {
    assert.equal(error.retryBlocked, undefined);
    assert.match(error.message, /did not finish/u);
    return true;
  });
  assert.deepEqual(signals, []);
});

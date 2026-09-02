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

  assert.match(
    login.authorizationUrl,
    /^https:\/\/auth\.openai\.com\/oauth\/authorize\?/,
  );
  assert.deepEqual(await login.completion, { success: true });
  assert.equal(calls[0].command, "npx");
  assert.deepEqual(calls[0].args, [
    "--yes",
    "--ignore-scripts",
    "--legacy-peer-deps=false",
    "--include=peer",
    "--package=openai-oauth@2.0.0",
    "--package=zod@4.1.8",
    "--",
    "openai-oauth",
    "login",
    "--no-open",
    "--login-timeout-ms",
    "300000",
    "--oauth-file",
    `${authPath}.pending-fixture`,
  ]);
  assert.equal(calls[0].options.shell, false);
  assert.deepEqual(calls[0].options.stdio, ["ignore", "pipe", "pipe"]);
  assert.equal(
    files[authPath],
    '{"fixture":true}',
  );
  assert.equal(
    `${authPath}.pending-fixture` in files,
    false,
  );
});

test("startOAuthLogin reads the supported CLI login line across ANSI, CRLF, and chunks", async () => {
  const files = {};
  const fileSystem = createMemoryFileSystem(files);
  const spawnProcess = (_command, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stderr.resume = () => {};
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
      authorizationUrl.searchParams.set("state", "windows-state");
      authorizationUrl.searchParams.set("code_challenge", "windows-challenge");
      child.stderr.emit("data", Buffer.from("\u001B[90mnpm notice\u001B[0m\r\n"));
      child.stdout.emit("data", Buffer.from("\u001B[2"));
      child.stdout.emit(
        "data",
        Buffer.from(`KOpenAI OAuth login URL: ${authorizationUrl}\r`),
      );
      child.stdout.emit("data", Buffer.from("\n"));
      const oauthFileIndex = args.indexOf("--oauth-file");
      files[args[oauthFileIndex + 1]] = '{"windows":true}';
      finishChild(child, 0);
    });
    return child;
  };

  const login = await startOAuthLogin({
    fileSystem,
    env: {},
    homeDirectory: "/home/user",
    platform: "win32",
    execPath: "C:\\portable\\node.exe",
    spawnProcess,
    createPendingId: () => "windows-output",
    lockDownPath: noOpLockDownPath,
  });

  assert.match(
    login.authorizationUrl,
    /^https:\/\/auth\.openai\.com\/oauth\/authorize\?/u,
  );
  assert.deepEqual(await login.completion, { success: true });
});

test("startOAuthLogin reads the supported Windows login line from stderr", async () => {
  const files = {};
  const fileSystem = createMemoryFileSystem(files);
  const authorizationUrl = createAuthorizationUrl();
  const spawnProcess = (_command, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    queueMicrotask(() => {
      child.stderr.emit("data", Buffer.from("\u001B[2"));
      child.stderr.emit(
        "data",
        Buffer.from(`KOpenAI OAuth login URL: ${authorizationUrl}\r`),
      );
      child.stderr.emit("data", Buffer.from("\n"));
      const oauthFileIndex = args.indexOf("--oauth-file");
      files[args[oauthFileIndex + 1]] = '{"stderr":true}';
      finishChild(child, 0);
    });
    return child;
  };

  const login = await startOAuthLogin({
    fileSystem,
    env: {},
    homeDirectory: "/home/user",
    platform: "win32",
    execPath: "C:\\portable\\node.exe",
    spawnProcess,
    createPendingId: () => "windows-stderr",
    lockDownPath: noOpLockDownPath,
  });

  assert.equal(login.authorizationUrl, authorizationUrl.toString());
  assert.deepEqual(await login.completion, { success: true });
});

test("startOAuthLogin waits for every byte boundary of the supported CRLF login line", async () => {
  const authorizationUrl = new URL("https://auth.openai.com/oauth/authorize");
  authorizationUrl.searchParams.set("response_type", "code");
  authorizationUrl.searchParams.set(
    "redirect_uri",
    "http://localhost:1455/auth/callback",
  );
  authorizationUrl.searchParams.set("state", "split-state");
  authorizationUrl.searchParams.set("code_challenge", "split-challenge");
  const loginLine = Buffer.from(
    `OpenAI OAuth login URL: ${authorizationUrl}\r\n`,
  );

  for (let splitAt = 1; splitAt < loginLine.length; splitAt += 1) {
    const files = {};
    let child;
    let pendingAuthPath;
    const spawnProcess = (_command, args) => {
      child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stderr.resume = () => {};
      child.kill = () => finishChild(child, 1);
      pendingAuthPath = args[args.indexOf("--oauth-file") + 1];
      queueMicrotask(() => {
        child.stdout.emit("data", loginLine.subarray(0, splitAt));
      });
      return child;
    };

    const loginPromise = startOAuthLogin({
      fileSystem: createMemoryFileSystem(files),
      env: {},
      homeDirectory: "/home/user",
      platform: "win32",
      execPath: "C:\\portable\\node.exe",
      spawnProcess,
      createPendingId: () => `split-${splitAt}`,
      lockDownPath: noOpLockDownPath,
    });
    let earlyOutcome;
    loginPromise.then(
      () => {
        earlyOutcome = "resolved";
      },
      () => {
        earlyOutcome = "rejected";
      },
    );
    await new Promise((resolvePromise) => setImmediate(resolvePromise));

    assert.equal(
      earlyOutcome,
      undefined,
      `split at byte ${splitAt} settled before the complete CRLF line`,
    );

    child.stdout.emit("data", loginLine.subarray(splitAt));
    files[pendingAuthPath] = '{"split":true}';
    finishChild(child, 0);

    const login = await loginPromise;
    assert.equal(login.authorizationUrl, authorizationUrl.toString());
    assert.deepEqual(await login.completion, { success: true });
  }
});

test("startOAuthLogin accepts a complete supported login line without a final newline on exit", async () => {
  const files = {};
  let child;
  let pendingAuthPath;
  const authorizationUrl = new URL("https://auth.openai.com/oauth/authorize");
  authorizationUrl.searchParams.set("response_type", "code");
  authorizationUrl.searchParams.set(
    "redirect_uri",
    "http://localhost:1455/auth/callback",
  );
  authorizationUrl.searchParams.set("state", "unterminated-state");
  authorizationUrl.searchParams.set("code_challenge", "unterminated-challenge");
  const loginLine = `OpenAI OAuth login URL: ${authorizationUrl}`;
  const spawnProcess = (_command, args) => {
    child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stderr.resume = () => {};
    child.kill = () => finishChild(child, 1);
    pendingAuthPath = args[args.indexOf("--oauth-file") + 1];
    queueMicrotask(() => {
      child.stdout.emit("data", Buffer.from(loginLine));
    });
    return child;
  };

  const loginPromise = startOAuthLogin({
    fileSystem: createMemoryFileSystem(files),
    env: {},
    homeDirectory: "/home/user",
    platform: "win32",
    execPath: "C:\\portable\\node.exe",
    spawnProcess,
    createPendingId: () => "unterminated",
    lockDownPath: noOpLockDownPath,
  });
  let earlyOutcome;
  loginPromise.then(
    () => {
      earlyOutcome = "resolved";
    },
    () => {
      earlyOutcome = "rejected";
    },
  );
  await new Promise((resolvePromise) => setImmediate(resolvePromise));

  assert.equal(earlyOutcome, undefined);

  files[pendingAuthPath] = '{"unterminated":true}';
  finishChild(child, 0);

  const login = await loginPromise;
  assert.equal(login.authorizationUrl, authorizationUrl.toString());
  assert.deepEqual(await login.completion, { success: true });
});

test("startOAuthLogin waits for close after exit before finalizing stdout", async () => {
  const files = {};
  let child;
  let pendingAuthPath;
  const authorizationUrl = createAuthorizationUrl({
    redirectUri: "http://localhost:1455/auth/callback",
  });
  const spawnProcess = (_command, args) => {
    child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stderr.resume = () => {};
    child.kill = () => {};
    pendingAuthPath = args[args.indexOf("--oauth-file") + 1];
    queueMicrotask(() => {
      child.emit("exit", 0);
      child.stdout.emit(
        "data",
        Buffer.from(`OpenAI OAuth login URL: ${authorizationUrl}`),
      );
      files[pendingAuthPath] = '{"drained":true}';
      child.emit("close", 0);
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

  assert.equal(login.authorizationUrl, authorizationUrl.toString());
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

  await assert.rejects(
    () =>
      startOAuthLogin({
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
      }),
    (error) => {
      assert.equal(
        error.message,
        "OpenAI OAuth login needs http://localhost:1455/auth/callback, but port 1455 is already in use. Stop the process using that port and try again.",
      );
      assert.doesNotMatch(error.message, /not-for-users|token=/u);
      assert.equal(error.retryBlocked, true);
      return true;
    },
  );
  assert.deepEqual(calls.slice(1), [
    { command: "taskkill", args: ["/pid", "5150", "/t"] },
    { command: "taskkill", args: ["/pid", "5150", "/t", "/f"] },
  ]);
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
      const authorizationUrl = new URL(
        "https://auth.openai.com/oauth/authorize",
      );
      authorizationUrl.searchParams.set("response_type", "code");
      authorizationUrl.searchParams.set(
        "redirect_uri",
        "http://localhost:1455/auth/callback",
      );
      authorizationUrl.searchParams.set("state", "windows-state");
      authorizationUrl.searchParams.set("code_challenge", "windows-challenge");
      child.stdout.emit(
        "data",
        Buffer.from(`OpenAI OAuth login URL: ${authorizationUrl}\n`),
      );
      const oauthFileIndex = args.indexOf("--oauth-file");
      files[args[oauthFileIndex + 1]] = '{"windows":true}';
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
    "--legacy-peer-deps=false",
    "--include=peer",
    "--package=openai-oauth@2.0.0",
    "--package=zod@4.1.8",
    "--",
    "openai-oauth",
    "login",
    "--no-open",
    "--login-timeout-ms",
    "300000",
    "--oauth-file",
    `${authPath}.pending-windows-fixture`,
  ]);
  assert.equal(calls[0].options.shell, false);
  assert.equal(calls[0].options.env.NPM_CONFIG_LEGACY_PEER_DEPS, "true");
  assert.equal(calls[0].options.env.NPM_CONFIG_OMIT, "peer");
  assert.deepEqual(await login.completion, { success: true });
  assert.equal(
    files[authPath],
    '{"windows":true}',
  );
  assert.equal(credentialCommitted, true);
  const pendingAuthPath = `${authPath}.pending-windows-fixture`;
  assert.deepEqual(aclCalls, [
    { path: dirname(authPath), options: { platform: "win32", kind: "directory" } },
    { path: pendingAuthPath, options: { platform: "win32", kind: "file" } },
    { path: `${pendingAuthPath}.ready`, options: { platform: "win32", kind: "file" } },
  ]);
});

test("startOAuthLogin hides synchronous process-launch errors", async () => {
  let invocation;
  const spawnProcess = (command, args) => {
    invocation = { command, args };
    const error = new Error("spawn EINVAL");
    error.code = "EINVAL";
    throw error;
  };

  await assert.rejects(
    () =>
      startOAuthLogin({
        fileSystem: createMemoryFileSystem({}),
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
        "The local sign-in command could not start. Update Relmio and retry with Node.js 22 or newer.",
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
});

test("startOAuthLogin saves a valid pending credential before the helper exits", async () => {
  const files = {};
  let child;
  let pendingAuthPath;
  let pollCount = 0;
  const homeDirectory = resolve("oauth-fresh-home");
  const authPath = resolve(homeDirectory, ".n8n-openai-oauth", "auth.json");
  const spawnProcess = (_command, args) => {
    child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = { resume() {} };
    child.kill = () => queueMicrotask(() => finishChild(child, 1));
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
    homeDirectory,
    platform: "darwin",
    spawnProcess,
    createPendingId: () => "fresh",
    terminationGraceMs: 0,
    terminationForceWaitMs: 0,
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
      files[authPath],
      '{"fresh":true}',
    );
  } finally {
    finishChild(child, 1);
  }
});

test("startOAuthLogin rejects an unexpected authorization destination", async () => {
  const fileSystem = createMemoryFileSystem({});
  const spawnProcess = () => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = { resume() {} };
    child.kill = () => queueMicrotask(() => finishChild(child, 1));
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

test("startOAuthLogin only accepts exact supported authorization and callback URLs", async () => {
  const startWithAuthorizationUrl = (authorizationUrl) => {
    const files = {};
    const spawnProcess = (_command, args) => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stderr.resume = () => {};
      child.kill = () => {};
      queueMicrotask(() => {
        child.stdout.emit(
          "data",
          Buffer.from(`OpenAI OAuth login URL: ${authorizationUrl}\n`),
        );
        files[args[args.indexOf("--oauth-file") + 1]] = '{"valid":true}';
        finishChild(child, 0);
      });
      return child;
    };

    return startOAuthLogin({
      fileSystem: createMemoryFileSystem(files),
      env: {},
      homeDirectory: "/home/user",
      platform: "win32",
      execPath: "C:\\portable\\node.exe",
      spawnProcess,
      createPendingId: () => "exact-url-shape",
      lockDownPath: noOpLockDownPath,
    });
  };

  for (const redirectUri of [
    "https://localhost:1455/auth/callback",
    "http://user@localhost:1455/auth/callback",
    "http://localhost:1455/auth/callback?unexpected=value",
    "http://localhost:1455/auth/callback#unexpected",
  ]) {
    await assert.rejects(
      () => startWithAuthorizationUrl(createAuthorizationUrl({ redirectUri })),
      /unexpected callback/i,
    );
  }

  const authorizationUrlWithCredentials = createAuthorizationUrl();
  authorizationUrlWithCredentials.username = "unexpected";
  await assert.rejects(
    () => startWithAuthorizationUrl(authorizationUrlWithCredentials),
    /unexpected destination/i,
  );

  const authorizationUrlWithFragment = createAuthorizationUrl();
  authorizationUrlWithFragment.hash = "unexpected";
  await assert.rejects(
    () => startWithAuthorizationUrl(authorizationUrlWithFragment),
    /unexpected destination/i,
  );

  const ipv6AuthorizationUrl = createAuthorizationUrl({
    redirectUri: "http://[::1]:1455/auth/callback",
  });
  const ipv6Login = await startWithAuthorizationUrl(ipv6AuthorizationUrl);
  assert.equal(ipv6Login.authorizationUrl, ipv6AuthorizationUrl.toString());
  assert.deepEqual(await ipv6Login.completion, { success: true });
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
  files[authPath] = '{"older":true}';
  const memoryFileSystem = createMemoryFileSystem(files);
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
  const spawnProcess = (_command, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => queueMicrotask(() => finishChild(child, 1));
    pendingAuthPath = args[args.indexOf("--oauth-file") + 1];
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
      files[pendingAuthPath] = '{"newer":true}';
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
  assert.equal(files[authPath], '{"older":true}');
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
  files[authPath] = '{"older":true}';
  const memoryFileSystem = createMemoryFileSystem(files);
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
  const spawnProcess = (_command, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => queueMicrotask(() => finishChild(child, 1));
    pendingAuthPath = args[args.indexOf("--oauth-file") + 1];
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
      files[pendingAuthPath] = '{"newer":true}';
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
  assert.equal(files[authPath], '{"newer":true}');
});

test("startOAuthLogin bounds a never-settling staged promotion and blocks its later final write", async () => {
  const files = {};
  const homeDirectory = resolve("oauth-never-settling-promotion-home");
  const authPath = resolve(homeDirectory, ".n8n-openai-oauth", "auth.json");
  files[authPath] = '{"older":true}';
  const memoryFileSystem = createMemoryFileSystem(files);
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
  const spawnProcess = (_command, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => queueMicrotask(() => finishChild(child, 1));
    pendingAuthPath = args[args.indexOf("--oauth-file") + 1];
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
      files[pendingAuthPath] = '{"newer":true}';
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
  assert.equal(files[authPath], '{"older":true}');
});

test("startOAuthLogin marks a timeout retry-blocked when final credential commit has started", async () => {
  const files = {};
  const homeDirectory = resolve("oauth-timeout-rename-home");
  const authPath = resolve(homeDirectory, ".n8n-openai-oauth", "auth.json");
  files[authPath] = '{"older":true}';
  const memoryFileSystem = createMemoryFileSystem(files);
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
  const spawnProcess = (_command, args) => {
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => queueMicrotask(() => finishChild(child, 1));
    pendingAuthPath = args[args.indexOf("--oauth-file") + 1];
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
      files[pendingAuthPath] = '{"newer":true}';
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
  assert.equal(files[authPath], '{"newer":true}');
});

test("startOAuthLogin marks unconfirmed cleanup retry-blocked after returning a URL", async () => {
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
    assert.equal(error.retryBlocked, true);
    assert.match(error.message, /could not be stopped safely/i);
    return true;
  });
  assert.deepEqual(signals, [
    [-6262, "SIGTERM"],
    [-6262, 0],
    [-6262, 0],
    [-6262, "SIGKILL"],
    [-6262, 0],
    [-6262, 0],
  ]);
});

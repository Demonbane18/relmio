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
  });

  assert.equal(login.authorizationUrl, authorizationUrl.toString());
  assert.deepEqual(await login.completion, { success: true });
});

test("startOAuthLogin surfaces a sanitized callback port conflict from stderr", async () => {
  const spawnProcess = () => {
    const child = new EventEmitter();
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
      }),
    (error) => {
      assert.equal(
        error.message,
        "OpenAI OAuth login needs http://localhost:1455/auth/callback, but port 1455 is already in use. Stop the process using that port and try again.",
      );
      assert.doesNotMatch(error.message, /not-for-users|token=/u);
      return true;
    },
  );
});

test("startOAuthLogin uses the current Node runtime for Windows npm launchers", async () => {
  const calls = [];
  const files = {};
  const fileSystem = createMemoryFileSystem(files);
  const execPath =
    process.platform === "win32"
      ? "C:\\portable\\node.exe"
      : "/portable/node.exe";
  const homeDirectory = resolve("oauth-fixture-home");
  const authPath = resolve(homeDirectory, ".n8n-openai-oauth", "auth.json");
  const npmExecPath = "/custom/npm-cli.js";
  const expectedNpxCliPath = resolve(dirname(npmExecPath), "npx-cli.js");
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
    homeDirectory,
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
      files[authPath],
      '{"fresh":true}',
    );
  } finally {
    finishChild(child, 1);
    login.cancel();
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

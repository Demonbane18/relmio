import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import * as nodeFileSystem from "node:fs/promises";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  utimes,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createLocalDeploymentPlan } from "../src/domain/local-endpoints.js";
import {
  acquireLocalEndpointChangeLock as acquireLocalEndpointChangeLockService,
  activateLocalClientCredentialRotation as activateLocalClientCredentialRotationService,
  attestLocalCodexInstallation,
  getLocalDockerStatus,
  installLocalEndpoint as installLocalEndpointService,
  restartLocalCodex as restartLocalCodexService,
  prepareLocalClientCredentialRotation,
  resolveLocalInstallRoot,
  verifyCodexWebSocketCapability,
} from "../src/services/local-installer.js";
import { withTestLocalSecurity } from "./helpers/local-security.js";

const acquireLocalEndpointChangeLock = (request, dependencies) =>
  acquireLocalEndpointChangeLockService(request, withTestLocalSecurity(dependencies));
const activateLocalClientCredentialRotation = (request, dependencies) =>
  activateLocalClientCredentialRotationService(request, withTestLocalSecurity(dependencies));
const installLocalEndpoint = (request, dependencies) =>
  installLocalEndpointService(request, withTestLocalSecurity(dependencies));
const restartLocalCodex = (request, dependencies) =>
  restartLocalCodexService(request, withTestLocalSecurity(dependencies));

const platformKey = `sk-${"p".repeat(48)}`;
const rotatedPlatformKey = `sk-${"q".repeat(48)}`;
const capability = Buffer.alloc(32, 7).toString("base64url");
const TEST_DOCKER_HOST = process.platform === "win32"
  ? "npipe:////./pipe/dockerDesktopLinuxEngine"
  : "unix:///var/run/docker.sock";
const TEST_DOCKER_CONTEXT = process.platform === "win32" ? "desktop-linux" : "default";

async function createTestHome(t) {
  const root = await import("node:fs/promises").then(({ mkdtemp }) =>
    mkdtemp(join(tmpdir(), "relmio-local-test-")),
  );
  t.after(async () => rm(root, { recursive: true, force: true }));
  return realpath(root);
}

function createRunner({
  cleanupCode = 0,
  cleanupStillRunning = false,
  contextHost = TEST_DOCKER_HOST,
  contextName = TEST_DOCKER_CONTEXT,
  foreignOwnership = false,
  publisherHost = "127.0.0.1",
  publishedPort = 12435,
  replaceFailureCount = 0,
} = {}) {
  const calls = [];
  let replacementFailures = replaceFailureCount;
  const runner = async (spec) => {
    calls.push(spec);
    const args = spec.args.join(" ");
    if (args === "context inspect --format {{json .Endpoints.docker.Host}}") {
      return {
        stdout: `${JSON.stringify(contextHost)}\n`,
        stderr: "",
        code: 0,
      };
    }
    if (args === "context show") {
      return { stdout: `${contextName}\n`, stderr: "", code: 0 };
    }
    if (args === "version --format {{.Server.Version}}") {
      return { stdout: "27.1.1\n", stderr: "", code: 0 };
    }
    if (args === "compose version --short") {
      return { stdout: "2.29.2\n", stderr: "", code: 0 };
    }
    if (args.includes("ps --status running --services")) {
      return {
        stdout: args.includes("relmio-openai-api")
          ? "gateway\n"
          : args.includes("relmio-codex-chat-")
            ? "codex-chat\n"
            : "codex\n",
        stderr: "",
        code: 0,
      };
    }
    if (args.includes("ps --format json")) {
      const targetPort = args.includes("relmio-openai-api")
        ? 10_531
        : args.includes("relmio-codex-chat-")
          ? 14_501
          : 4_500;
      return {
        stdout: JSON.stringify({
          Publishers: [
            {
              URL: publisherHost,
              TargetPort: targetPort,
              PublishedPort: publishedPort,
              Protocol: "tcp",
            },
          ],
        }),
        stderr: "",
        code: 0,
      };
    }
    if (args.includes("up -d --wait") && args.includes("--force-recreate")) {
      if (replacementFailures > 0) {
        replacementFailures -= 1;
        return { stdout: "", stderr: "", code: 1 };
      }
      return { stdout: "", stderr: "", code: 0 };
    }
    if (args.includes("rm --force --stop")) {
      return { stdout: "", stderr: "", code: cleanupCode };
    }
    if (args.includes("ps --all --services")) {
      return {
        stdout: cleanupStillRunning
          ? `${args.endsWith(" codex") ? "codex" : "gateway"}\n`
          : "",
        stderr: "",
        code: 0,
      };
    }
    if (
      args.includes("--filter label=com.docker.compose.project=") &&
      (foreignOwnership === true ||
        (foreignOwnership === "container" && args.startsWith("ps ")) ||
        (foreignOwnership === "network" && args.startsWith("network ls ")) ||
        (foreignOwnership === "volume" && args.startsWith("volume ls ")))
    ) {
      return {
        stdout: `${JSON.stringify({
          Labels: "com.docker.compose.project=foreign,io.relmio.managed=false",
        })}\n`,
        stderr: "",
        code: 0,
      };
    }
    return { stdout: "", stderr: "", code: 0 };
  };
  runner.calls = calls;
  return runner;
}

function createFetch() {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url, options });
    if (String(url).endsWith("/v1/models")) {
      return new Response(
        JSON.stringify({ data: [{ id: "gpt-5.6-terra" }] }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    return new Response("ok", { status: 200 });
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

function createCodexCapabilityVerifier({ error } = {}) {
  const calls = [];
  const verify = async (input) => {
    calls.push(input);
    if (error) {
      throw error;
    }
  };
  verify.calls = calls;
  return verify;
}

test("Codex capability verification performs an authenticated WebSocket upgrade", async () => {
  const socket = new EventEmitter();
  let connectionOptions;
  let request;
  let destroyed = false;
  socket.setTimeout = () => {};
  socket.destroy = () => {
    destroyed = true;
  };
  socket.write = (value) => {
    request = value;
    const websocketKey = /^Sec-WebSocket-Key: (.+)$/mu.exec(value)?.[1];
    const accept = createHash("sha1")
      .update(`${websocketKey}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
      .digest("base64");
    queueMicrotask(() => {
      socket.emit(
        "data",
        Buffer.from(
          [
            "HTTP/1.1 101 Switching Protocols",
            "Upgrade: websocket",
            "Connection: Upgrade",
            `Sec-WebSocket-Accept: ${accept}`,
            "",
            "",
          ].join("\r\n"),
          "latin1",
        ),
      );
    });
  };

  await verifyCodexWebSocketCapability(
    { port: 14500, clientCredential: capability },
    {
      connectSocket(options, onConnect) {
        connectionOptions = options;
        queueMicrotask(onConnect);
        return socket;
      },
      randomBytes: () => Buffer.alloc(16, 5),
    },
  );

  assert.deepEqual(connectionOptions, { host: "127.0.0.1", port: 14500 });
  assert.match(request, new RegExp(`^Authorization: Bearer ${capability}$`, "mu"));
  assert.equal(destroyed, true);
});

test("Codex capability verification rejects non-RFC WebSocket handshakes", async (t) => {
  for (const [name, statusLine, upgradeHeader] of [
    ["HTTP 1.0", "HTTP/1.0 101 Switching Protocols", "Upgrade: websocket"],
    ["whitespace before colon", "HTTP/1.1 101 Switching Protocols", "Upgrade : websocket"],
  ]) {
    await t.test(name, async () => {
      const socket = new EventEmitter();
      socket.setTimeout = () => {};
      socket.destroy = () => {};
      socket.write = (value) => {
        const websocketKey = /^Sec-WebSocket-Key: (.+)$/mu.exec(value)?.[1];
        const accept = createHash("sha1")
          .update(`${websocketKey}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
          .digest("base64");
        queueMicrotask(() => {
          socket.emit(
            "data",
            Buffer.from(
              [
                statusLine,
                upgradeHeader,
                "Connection: Upgrade",
                `Sec-WebSocket-Accept: ${accept}`,
                "",
                "",
              ].join("\r\n"),
              "latin1",
            ),
          );
        });
      };

      await assert.rejects(
        () =>
          verifyCodexWebSocketCapability(
            { port: 14500, clientCredential: capability },
            {
              connectSocket(_options, onConnect) {
                queueMicrotask(onConnect);
                return socket;
              },
              randomBytes: () => Buffer.alloc(16, 5),
            },
          ),
        /Codex client credential could not be verified/u,
      );
    });
  }
});

test("local Docker discovery is read-only and sanitizes versions", async () => {
  const runProcess = createRunner();
  const result = await getLocalDockerStatus({ runProcess, cwd: "/tmp" });

  assert.deepEqual(result, {
    dockerAvailable: true,
    dockerVersion: "27.1.1",
    composeVersion: "2.29.2",
    dockerHost: TEST_DOCKER_HOST,
  });
  assert.deepEqual(
    runProcess.calls.map(({ file, args }) => ({ file, args })),
    [
      {
        file: "docker",
        args: [
          "context",
          "inspect",
          "--format",
          "{{json .Endpoints.docker.Host}}",
        ],
      },
      ...(process.platform === "win32"
        ? [{ file: "docker", args: ["context", "show"] }]
        : []),
      { file: "docker", args: ["version", "--format", "{{.Server.Version}}"] },
      { file: "docker", args: ["compose", "version", "--short"] },
    ],
  );
});

test("local Docker discovery rejects remote contexts and overrides while accepting the attested Docker Desktop Linux engine", async () => {
  assert.deepEqual(
    await getLocalDockerStatus({
      runProcess: createRunner({ contextHost: "ssh://remote.example" }),
      cwd: "/tmp",
      env: {},
    }),
    { dockerAvailable: false },
  );
  assert.deepEqual(
    await getLocalDockerStatus({
      runProcess: createRunner(),
      cwd: "/tmp",
      env: { DOCKER_HOST: "tcp://remote.example:2376" },
    }),
    { dockerAvailable: false },
  );
  assert.deepEqual(
    await getLocalDockerStatus({
      runProcess: createRunner({
        contextHost: "npipe:////./pipe/dockerDesktopLinuxEngine",
        contextName: "desktop-linux",
      }),
      cwd: "/tmp",
      env: {},
      platform: "win32",
    }),
    {
      dockerAvailable: true,
      dockerVersion: "27.1.1",
      composeVersion: "2.29.2",
      dockerHost: "npipe:////./pipe/dockerDesktopLinuxEngine",
    },
  );
});

test("Codex credential reload attests, restarts, and waits for only the managed service", async (t) => {
  const home = await createTestHome(t);
  const runProcess = createRunner();
  const env = { RELMIO_HOME: join(home, ".relmio") };
  const plan = createLocalDeploymentPlan({ target: "codex-chatgpt", port: 12435 });
  await installLocalEndpoint(
    { plan, confirmed: true },
    {
      env,
      runProcess,
      randomBytes: () => Buffer.alloc(32, 7),
      isPortAvailable: async () => true,
      fetchImpl: createFetch(),
      verifyCodexCapability: createCodexCapabilityVerifier(),
    },
  );
  const installDirectory = await resolveLocalInstallRoot({
    target: "codex-chatgpt",
    env,
  });
  runProcess.calls.length = 0;

  assert.deepEqual(
    await restartLocalCodex({ installDirectory }, { runProcess }),
    { restarted: true },
  );
  assert.ok(
    runProcess.calls.some(({ args, cwd, dockerHost }) =>
      args.join(" ").includes(
        `compose --project-name relmio-codex-chatgpt-${"07".repeat(16)} --file docker-compose.yml restart --timeout 10 codex`,
      ) &&
      cwd === installDirectory &&
      dockerHost === TEST_DOCKER_HOST,
    ),
  );
  assert.ok(
    runProcess.calls.some(({ args }) =>
      args.join(" ").includes(
        "up -d --wait --wait-timeout 90 --no-deps codex",
      ),
    ),
  );
  await assert.rejects(
    () => restartLocalCodex({ installDirectory: "/tmp/not-managed" }, { runProcess }),
    /invalid/i,
  );
});

test("credential rotation recreates and verifies the managed Codex service before returning a fresh capability", async (t) => {
  const home = await createTestHome(t);
  const runProcess = createRunner({ publishedPort: 14500 });
  const fetchImpl = createFetch();
  const verifyCodexCapability = createCodexCapabilityVerifier();
  const env = { RELMIO_HOME: join(home, ".relmio") };
  const randomValues = [
    Buffer.alloc(32, 1),
    Buffer.alloc(32, 7),
    Buffer.alloc(32, 9),
  ];
  const randomBytes = () => randomValues.shift();
  const plan = createLocalDeploymentPlan({ target: "codex-chatgpt", port: 14500 });
  const installed = await installLocalEndpoint(
    { plan, confirmed: true },
    {
      env,
      runProcess,
      randomBytes,
      isPortAvailable: async () => true,
      fetchImpl,
      verifyCodexCapability,
    },
  );
  const installDirectory = await resolveLocalInstallRoot({
    target: "codex-chatgpt",
    env,
  });
  const composePath = join(installDirectory, "docker-compose.yml");
  const originalCompose = await readFile(composePath, "utf8");
  runProcess.calls.length = 0;
  fetchImpl.calls.length = 0;
  verifyCodexCapability.calls.length = 0;

  const staged = await prepareLocalClientCredentialRotation(
    { target: "codex-chatgpt" },
    { env, runProcess, randomBytes, fetchImpl },
  );
  assert.equal(await readFile(composePath, "utf8"), originalCompose);
  const activated = await activateLocalClientCredentialRotation(
    staged,
    { env, runProcess, fetchImpl, verifyCodexCapability },
  );
  const rotated = { ...staged, ...activated };

  assert.equal(rotated.target, "codex-chatgpt");
  assert.equal(rotated.endpoint, "ws://127.0.0.1:14500");
  assert.equal(rotated.protocol, "codex-app-server-json-rpc");
  assert.equal(rotated.credentialShownOnce, true);
  assert.notEqual(rotated.clientCredential, installed.clientCredential);
  assert.deepEqual(rotated.models, []);
  assert.equal(rotated.deploymentMode, "updated");
  assert.equal(rotated.experimental, true);
  assert.equal(rotated.browserClients, false);
  assert.match(
    await readFile(composePath, "utf8"),
    /--ws-token-sha256\n\s+- [a-f0-9]{64}/u,
  );
  assert.notEqual(await readFile(composePath, "utf8"), originalCompose);
  assert.ok(
    runProcess.calls.some(({ args }) =>
      args.join(" ").includes("config --quiet"),
    ),
  );
  assert.ok(
    runProcess.calls.some(({ args }) =>
      args
        .join(" ")
        .includes("up -d --wait --wait-timeout 90 --force-recreate --no-deps codex"),
    ),
  );
  assert.equal(
    runProcess.calls.some(({ args }) => args.includes("credential-seed")),
    false,
  );
  assert.equal(fetchImpl.calls.length, 1);
  assert.equal(fetchImpl.calls[0].options.headers, undefined);
  assert.deepEqual(verifyCodexCapability.calls, [
    { port: 14500, clientCredential: rotated.clientCredential },
  ]);
});

test("Codex Chat rotation authenticates the fresh bearer without starting a model turn", async (t) => {
  const home = await createTestHome(t);
  const runProcess = createRunner({ publishedPort: 14501 });
  const fetchImpl = createFetch();
  const env = { RELMIO_HOME: join(home, ".relmio") };
  const randomValues = [
    Buffer.alloc(32, 4),
    Buffer.alloc(32, 7),
    Buffer.alloc(32, 9),
  ];
  const randomBytes = () => randomValues.shift();
  const plan = createLocalDeploymentPlan({
    target: "codex-chat",
    port: 14501,
  });
  await installLocalEndpoint(
    { plan, confirmed: true },
    {
      env,
      runProcess,
      randomBytes,
      isPortAvailable: async () => true,
      readCodexChatSource: async () => "export const fixture = true;\n",
      fetchImpl,
    },
  );
  fetchImpl.calls.length = 0;

  const staged = await prepareLocalClientCredentialRotation(
    { target: "codex-chat" },
    { env, runProcess, randomBytes },
  );
  const activated = await activateLocalClientCredentialRotation(staged, {
    env,
    runProcess,
    fetchImpl,
  });

  assert.equal(activated.target, "codex-chat");
  assert.deepEqual(
    fetchImpl.calls.map(({ url }) => url),
    [
      "http://127.0.0.1:14501/health",
      "http://127.0.0.1:14501/auth/verify",
    ],
  );
  assert.equal(
    fetchImpl.calls[1].options.headers.Authorization,
    `Bearer ${staged.clientCredential}`,
  );
  assert.ok(
    runProcess.calls.some(({ args }) =>
      args
        .join(" ")
        .includes(
          "up -d --wait --wait-timeout 90 --force-recreate --no-deps codex-chat",
        ),
    ),
  );
});

test("Codex credential rotation rolls back when the fresh WebSocket capability is rejected", async (t) => {
  const home = await createTestHome(t);
  const env = { RELMIO_HOME: join(home, ".relmio") };
  const runProcess = createRunner({ publishedPort: 14500 });
  const randomValues = [
    Buffer.alloc(32, 3),
    Buffer.alloc(32, 7),
    Buffer.alloc(32, 9),
  ];
  const randomBytes = () => randomValues.shift();
  const plan = createLocalDeploymentPlan({ target: "codex-chatgpt", port: 14500 });
  await installLocalEndpoint(
    { plan, confirmed: true },
    {
      env,
      runProcess,
      randomBytes,
      isPortAvailable: async () => true,
      fetchImpl: createFetch(),
      verifyCodexCapability: createCodexCapabilityVerifier(),
    },
  );
  const installDirectory = await resolveLocalInstallRoot({
    target: "codex-chatgpt",
    env,
  });
  const composePath = join(installDirectory, "docker-compose.yml");
  const originalCompose = await readFile(composePath, "utf8");
  const staged = await prepareLocalClientCredentialRotation(
    { target: "codex-chatgpt" },
    { env, runProcess, randomBytes },
  );
  runProcess.calls.length = 0;

  await assert.rejects(
    () =>
      activateLocalClientCredentialRotation(staged, {
        env,
        runProcess,
        fetchImpl: createFetch(),
        verifyCodexCapability: createCodexCapabilityVerifier({
          error: new Error("rejected capability"),
        }),
      }),
    /previous verifier was restored and the managed endpoint was re-attested/u,
  );

  assert.equal(await readFile(composePath, "utf8"), originalCompose);
  assert.equal(
    runProcess.calls.filter(({ args }) => args.includes("--force-recreate")).length,
    2,
  );
});

test("credential rotation preserves the OpenAI upstream volume and verifies the fresh local credential", async (t) => {
  const home = await createTestHome(t);
  const runProcess = createRunner();
  const fetchImpl = createFetch();
  const env = { RELMIO_HOME: join(home, ".relmio") };
  const randomValues = [
    Buffer.alloc(32, 2),
    Buffer.alloc(32, 7),
    Buffer.alloc(32, 9),
  ];
  const randomBytes = () => randomValues.shift();
  const plan = createLocalDeploymentPlan({
    target: "openai-api",
    port: 12435,
    allowedOrigins: ["http://localhost:3000"],
  });
  const installed = await installLocalEndpoint(
    { plan, apiKey: platformKey, confirmed: true },
    { env, runProcess, randomBytes, isPortAvailable: async () => true, fetchImpl },
  );
  runProcess.calls.length = 0;
  fetchImpl.calls.length = 0;

  const staged = await prepareLocalClientCredentialRotation(
    { target: "openai-api" },
    { env, runProcess, randomBytes, fetchImpl },
  );
  const activated = await activateLocalClientCredentialRotation(
    staged,
    { env, runProcess, fetchImpl },
  );
  const rotated = { ...staged, ...activated };

  assert.equal(rotated.target, "openai-api");
  assert.equal(rotated.endpoint, "http://127.0.0.1:12435/v1");
  assert.notEqual(rotated.clientCredential, installed.clientCredential);
  assert.deepEqual(rotated.models, ["gpt-5.6-terra"]);
  assert.equal(rotated.deploymentMode, "updated");
  assert.equal(rotated.experimental, false);
  assert.equal(rotated.browserClients, true);
  assert.equal(
    runProcess.calls.some(({ args, input }) =>
      args.includes("credential-seed") || input !== undefined,
    ),
    false,
  );
  const modelRequest = fetchImpl.calls.find(({ url }) =>
    String(url).endsWith("/v1/models"),
  );
  assert.equal(
    modelRequest.options.headers.Authorization,
    `Bearer ${rotated.clientCredential}`,
  );
});

test("credential rotation restores the prior verifier when service recreation fails", async (t) => {
  const home = await createTestHome(t);
  const runProcess = createRunner({
    publishedPort: 14500,
    replaceFailureCount: 1,
  });
  const env = { RELMIO_HOME: join(home, ".relmio") };
  const randomValues = [
    Buffer.alloc(32, 3),
    Buffer.alloc(32, 7),
    Buffer.alloc(32, 9),
  ];
  const randomBytes = () => randomValues.shift();
  const plan = createLocalDeploymentPlan({ target: "codex-chatgpt", port: 14500 });
  await installLocalEndpoint(
    { plan, confirmed: true },
    {
      env,
      runProcess,
      randomBytes,
      isPortAvailable: async () => true,
      fetchImpl: createFetch(),
      verifyCodexCapability: createCodexCapabilityVerifier(),
    },
  );
  const installDirectory = await resolveLocalInstallRoot({
    target: "codex-chatgpt",
    env,
  });
  const composePath = join(installDirectory, "docker-compose.yml");
  const originalCompose = await readFile(composePath, "utf8");
  runProcess.calls.length = 0;

  await assert.rejects(
    () =>
      prepareLocalClientCredentialRotation(
        { target: "codex-chatgpt" },
        { env, runProcess, randomBytes, fetchImpl: createFetch() },
      ).then((staged) =>
        activateLocalClientCredentialRotation(staged, {
          env,
          runProcess,
          fetchImpl: createFetch(),
        }),
      ),
    /rotation failed safely/u,
  );

  assert.equal(await readFile(composePath, "utf8"), originalCompose);
  assert.equal(
    runProcess.calls.filter(({ args }) => args.includes("--force-recreate")).length,
    2,
  );
});

test("credential rotation removes only the exact service when replacement and rollback recreation both fail", async (t) => {
  const home = await createTestHome(t);
  const runProcess = createRunner({
    publishedPort: 14500,
    replaceFailureCount: 2,
  });
  const env = { RELMIO_HOME: join(home, ".relmio") };
  const randomValues = [
    Buffer.alloc(32, 3),
    Buffer.alloc(32, 7),
    Buffer.alloc(32, 9),
  ];
  const randomBytes = () => randomValues.shift();
  const plan = createLocalDeploymentPlan({ target: "codex-chatgpt", port: 14500 });
  await installLocalEndpoint(
    { plan, confirmed: true },
    {
      env,
      runProcess,
      randomBytes,
      isPortAvailable: async () => true,
      fetchImpl: createFetch(),
      verifyCodexCapability: createCodexCapabilityVerifier(),
    },
  );
  const installDirectory = await resolveLocalInstallRoot({
    target: "codex-chatgpt",
    env,
  });
  const composePath = join(installDirectory, "docker-compose.yml");
  const originalCompose = await readFile(composePath, "utf8");
  runProcess.calls.length = 0;

  await assert.rejects(
    () =>
      prepareLocalClientCredentialRotation(
        { target: "codex-chatgpt" },
        { env, runProcess, randomBytes, fetchImpl: createFetch() },
      ).then((staged) =>
        activateLocalClientCredentialRotation(staged, {
          env,
          runProcess,
          fetchImpl: createFetch(),
        }),
      ),
    /local endpoint was stopped/u,
  );

  assert.equal(await readFile(composePath, "utf8"), originalCompose);
  assert.equal(
    runProcess.calls.filter(({ args }) => args.includes("--force-recreate")).length,
    2,
  );
  const cleanup = runProcess.calls.find(({ args }) => args.includes("rm"));
  const verification = runProcess.calls.find(
    ({ args }) => args.includes("--all") && args.includes("--services"),
  );
  assert.deepEqual(cleanup.args.slice(-4), ["rm", "--force", "--stop", "codex"]);
  assert.deepEqual(verification.args.slice(-4), [
    "ps",
    "--all",
    "--services",
    "codex",
  ]);
});

test("credential rotation reports uncertainty when exact-service removal cannot be confirmed", async (t) => {
  const home = await createTestHome(t);
  const runProcess = createRunner({
    cleanupStillRunning: true,
    publishedPort: 14500,
    replaceFailureCount: 2,
  });
  const env = { RELMIO_HOME: join(home, ".relmio") };
  const randomValues = [
    Buffer.alloc(32, 3),
    Buffer.alloc(32, 7),
    Buffer.alloc(32, 9),
  ];
  const randomBytes = () => randomValues.shift();
  const plan = createLocalDeploymentPlan({ target: "codex-chatgpt", port: 14500 });
  await installLocalEndpoint(
    { plan, confirmed: true },
    {
      env,
      runProcess,
      randomBytes,
      isPortAvailable: async () => true,
      fetchImpl: createFetch(),
      verifyCodexCapability: createCodexCapabilityVerifier(),
    },
  );
  runProcess.calls.length = 0;

  await assert.rejects(
    () =>
      prepareLocalClientCredentialRotation(
        { target: "codex-chatgpt" },
        { env, runProcess, randomBytes, fetchImpl: createFetch() },
      ).then((staged) =>
        activateLocalClientCredentialRotation(staged, {
          env,
          runProcess,
          fetchImpl: createFetch(),
        }),
      ),
    /could not confirm that the failed credential rotation was stopped/u,
  );

  const cleanup = runProcess.calls.find(({ args }) => args.includes("rm"));
  const verification = runProcess.calls.find(
    ({ args }) => args.includes("--all") && args.includes("--services"),
  );
  assert.deepEqual(cleanup.args.slice(-4), ["rm", "--force", "--stop", "codex"]);
  assert.deepEqual(verification.args.slice(-4), [
    "ps",
    "--all",
    "--services",
    "codex",
  ]);
});

test("credential rotation rolls back when managed-file permission repair fails after rename", async (t) => {
  const home = await createTestHome(t);
  const env = { RELMIO_HOME: join(home, ".relmio") };
  const runProcess = createRunner({ publishedPort: 14500 });
  const randomValues = [
    Buffer.alloc(32, 3),
    Buffer.alloc(32, 7),
    Buffer.alloc(32, 9),
  ];
  const randomBytes = () => randomValues.shift();
  const plan = createLocalDeploymentPlan({ target: "codex-chatgpt", port: 14500 });
  await installLocalEndpoint(
    { plan, confirmed: true },
    {
      env,
      runProcess,
      randomBytes,
      isPortAvailable: async () => true,
      fetchImpl: createFetch(),
      verifyCodexCapability: createCodexCapabilityVerifier(),
    },
  );
  const installDirectory = await resolveLocalInstallRoot({
    target: "codex-chatgpt",
    env,
  });
  const composePath = join(installDirectory, "docker-compose.yml");
  const originalCompose = await readFile(composePath, "utf8");
  const staged = await prepareLocalClientCredentialRotation(
    { target: "codex-chatgpt" },
    { env, runProcess, randomBytes },
  );
  runProcess.calls.length = 0;

  let replacementRenamed = false;
  let injectedFailure = false;
  const fileSystem = {
    ...nodeFileSystem,
    async rename(source, destination) {
      await nodeFileSystem.rename(source, destination);
      if (destination === composePath && !injectedFailure) {
        replacementRenamed = true;
      }
    },
    async chmod(path, mode) {
      if (path === composePath && replacementRenamed && !injectedFailure) {
        injectedFailure = true;
        throw new Error("injected post-rename chmod failure");
      }
      return nodeFileSystem.chmod(path, mode);
    },
  };

  await assert.rejects(
    () =>
      activateLocalClientCredentialRotation(staged, {
        env,
        fileSystem,
        runProcess,
        fetchImpl: createFetch(),
      }),
    /previous verifier was restored and the managed endpoint was re-attested/u,
  );

  assert.equal(injectedFailure, true);
  assert.equal(await readFile(composePath, "utf8"), originalCompose);
  assert.equal(
    runProcess.calls.filter(({ args }) => args.includes("--force-recreate")).length,
    1,
  );
});

test("project lock prevents independent Relmio processes from installing during credential activation", async (t) => {
  const home = await createTestHome(t);
  const env = { RELMIO_HOME: join(home, ".relmio") };
  const plan = createLocalDeploymentPlan({ target: "codex-chatgpt", port: 14500 });
  await installLocalEndpoint(
    { plan, confirmed: true },
    {
      env,
      runProcess: createRunner({ publishedPort: 14500 }),
      randomBytes: () => Buffer.alloc(32, 7),
      isPortAvailable: async () => true,
      fetchImpl: createFetch(),
      verifyCodexCapability: createCodexCapabilityVerifier(),
      processId: 40_001,
      isProcessAlive: () => true,
    },
  );
  const staged = await prepareLocalClientCredentialRotation(
    { target: "codex-chatgpt" },
    {
      env,
      runProcess: createRunner({ publishedPort: 14500 }),
      randomBytes: () => Buffer.alloc(32, 9),
    },
  );

  let releaseActivation;
  let notifyActivationStarted;
  const activationStarted = new Promise((resolvePromise) => {
    notifyActivationStarted = resolvePromise;
  });
  const activationGate = new Promise((resolvePromise) => {
    releaseActivation = resolvePromise;
  });
  t.after(() => releaseActivation());
  const baseRunner = createRunner({ publishedPort: 14500 });
  let blocked = false;
  const blockingRunner = async (spec) => {
    if (!blocked && spec.args.includes("--force-recreate")) {
      blocked = true;
      notifyActivationStarted();
      await activationGate;
    }
    return baseRunner(spec);
  };

  const activation = activateLocalClientCredentialRotation(staged, {
    env,
    runProcess: blockingRunner,
    fetchImpl: createFetch(),
    verifyCodexCapability: createCodexCapabilityVerifier(),
    processId: 40_002,
    isProcessAlive: () => true,
  });
  await activationStarted;

  await assert.rejects(
    () =>
      installLocalEndpoint(
        { plan, confirmed: true },
        {
          env,
          runProcess: createRunner({ publishedPort: 14500 }),
          randomBytes: () => Buffer.alloc(32, 11),
          isPortAvailable: async () => true,
          fetchImpl: createFetch(),
          processId: 40_003,
          isProcessAlive: () => true,
        },
      ),
    /Another Relmio process is changing this local endpoint/u,
  );

  releaseActivation();
  assert.equal((await activation).deploymentMode, "updated");
});

test("Codex sign-in project lock excludes independent installation, activation, and restart", async (t) => {
  const home = await createTestHome(t);
  const env = { RELMIO_HOME: join(home, ".relmio") };
  const plan = createLocalDeploymentPlan({ target: "codex-chatgpt", port: 14500 });
  const runProcess = createRunner({ publishedPort: 14500 });
  await installLocalEndpoint(
    { plan, confirmed: true },
    {
      env,
      runProcess,
      randomBytes: () => Buffer.alloc(32, 7),
      isPortAvailable: async () => true,
      fetchImpl: createFetch(),
      verifyCodexCapability: createCodexCapabilityVerifier(),
      processId: 41_001,
      isProcessAlive: () => true,
    },
  );
  const staged = await prepareLocalClientCredentialRotation(
    { target: "codex-chatgpt" },
    {
      env,
      runProcess,
      randomBytes: () => Buffer.alloc(32, 9),
    },
  );
  const installDirectory = await resolveLocalInstallRoot({
    target: "codex-chatgpt",
    env,
  });
  const releaseLoginLock = await acquireLocalEndpointChangeLock(
    { target: "codex-chatgpt" },
    {
      env,
      processId: 41_002,
      isProcessAlive: () => true,
    },
  );

  const lockError = /Another Relmio process is changing this local endpoint/u;
  await assert.rejects(
    () =>
      installLocalEndpoint(
        { plan, confirmed: true },
        {
          env,
          runProcess,
          randomBytes: () => Buffer.alloc(32, 11),
          isPortAvailable: async () => true,
          fetchImpl: createFetch(),
          processId: 41_003,
          isProcessAlive: () => true,
        },
      ),
    lockError,
  );
  await assert.rejects(
    () =>
      activateLocalClientCredentialRotation(staged, {
        env,
        runProcess,
        fetchImpl: createFetch(),
        processId: 41_004,
        isProcessAlive: () => true,
      }),
    lockError,
  );
  await assert.rejects(
    () =>
      restartLocalCodex(
        { installDirectory },
        {
          env,
          runProcess,
          processId: 41_005,
          isProcessAlive: () => true,
        },
      ),
    lockError,
  );

  await releaseLoginLock();
  assert.equal(
    (await activateLocalClientCredentialRotation(staged, {
      env,
      runProcess,
      fetchImpl: createFetch(),
      verifyCodexCapability: createCodexCapabilityVerifier(),
      processId: 41_006,
      isProcessAlive: () => true,
    })).deploymentMode,
    "updated",
  );
});

test("only one independent process can reclaim the same stale project lock", async (t) => {
  const home = await createTestHome(t);
  const env = { RELMIO_HOME: join(home, ".relmio") };
  const lockPath = join(home, ".relmio-local-codex-chatgpt.lock");
  const ownerPath = join(lockPath, "owner.json");
  await mkdir(lockPath, { mode: 0o700 });
  await writeFile(
    ownerPath,
    `${JSON.stringify({ processId: 39_999, ownerToken: "stale-owner" })}\n`,
    { mode: 0o600 },
  );

  let ownerReads = 0;
  let releaseOwnerReads;
  const bothOwnersRead = new Promise((resolvePromise) => {
    releaseOwnerReads = resolvePromise;
  });
  const fileSystem = {
    ...nodeFileSystem,
    async readFile(path, ...args) {
      const contents = await nodeFileSystem.readFile(path, ...args);
      if (path === ownerPath && ownerReads < 2) {
        ownerReads += 1;
        if (ownerReads === 2) {
          releaseOwnerReads();
        }
        await bothOwnersRead;
      }
      return contents;
    },
  };
  const plan = createLocalDeploymentPlan({ target: "codex-chatgpt", port: 14500 });
  const createInstall = (processId) =>
    installLocalEndpoint(
      { plan, confirmed: true },
      {
        env,
        fileSystem,
        runProcess: createRunner({ publishedPort: 14500 }),
        randomBytes: () => Buffer.alloc(32, processId % 255),
        isPortAvailable: async () => true,
        fetchImpl: createFetch(),
        verifyCodexCapability: createCodexCapabilityVerifier(),
        processId,
        isProcessAlive: () => false,
      },
    );

  const results = await Promise.allSettled([
    createInstall(40_010),
    createInstall(40_011),
  ]);
  assert.equal(results.filter(({ status }) => status === "fulfilled").length, 1);
  const rejected = results.find(({ status }) => status === "rejected");
  assert.match(
    rejected.reason.message,
    /Another Relmio process is changing this local endpoint/u,
  );
});

test("project locks distinguish an active owner from PID reuse and ambiguous identity", async (t) => {
  for (const variant of ["reused", "active", "ambiguous"]) {
    await t.test(variant, async (subtest) => {
      const home = await createTestHome(subtest);
      const env = { RELMIO_HOME: join(home, ".relmio") };
      const lockPath = join(home, ".relmio-local-codex-chatgpt.lock");
      await mkdir(lockPath, { mode: 0o700 });
      await writeFile(
        join(lockPath, "owner.json"),
        `${JSON.stringify({
          processId: 39_998,
          ownerToken: "published-owner",
          processStartIdentity: "owner-start",
        })}\n`,
        { mode: 0o600 },
      );
      const getProcessIdentity = async (processId) => {
        if (processId === 41_009) {
          return { state: "active", startIdentity: "self-start" };
        }
        if (variant === "ambiguous") return { state: "ambiguous" };
        return {
          state: "active",
          startIdentity: variant === "active" ? "owner-start" : "reused-start",
        };
      };
      const acquisition = acquireLocalEndpointChangeLock(
        { target: "codex-chatgpt" },
        { env, processId: 41_009, getProcessIdentity },
      );
      if (variant === "reused") {
        const releaseLock = await acquisition;
        await releaseLock();
        await assert.rejects(() => lstat(lockPath), /ENOENT/u);
      } else {
        await assert.rejects(
          acquisition,
          /Another Relmio process is changing this local endpoint/u,
        );
      }
    });
  }
});

test("a crashed stale-lock reclaimer can be recovered by a later process", async (t) => {
  const home = await createTestHome(t);
  const env = { RELMIO_HOME: join(home, ".relmio") };
  const lockPath = join(home, ".relmio-local-codex-chatgpt.lock");
  const reclaimPath = join(lockPath, ".reclaim");
  await mkdir(reclaimPath, { recursive: true, mode: 0o700 });
  await writeFile(
    join(lockPath, "owner.json"),
    `${JSON.stringify({ processId: 39_990, ownerToken: "stale-owner" })}\n`,
    { mode: 0o600 },
  );
  await writeFile(
    join(reclaimPath, "owner.json"),
    `${JSON.stringify({ processId: 39_991, ownerToken: "crashed-reclaimer" })}\n`,
    { mode: 0o600 },
  );
  const plan = createLocalDeploymentPlan({ target: "codex-chatgpt", port: 14500 });
  const result = await installLocalEndpoint(
    { plan, confirmed: true },
    {
      env,
      runProcess: createRunner({ publishedPort: 14500 }),
      randomBytes: () => Buffer.alloc(32, 13),
      isPortAvailable: async () => true,
      fetchImpl: createFetch(),
      verifyCodexCapability: createCodexCapabilityVerifier(),
      processId: 41_010,
      isProcessAlive: () => false,
    },
  );
  assert.equal(result.deploymentMode, "installed");
});

test("detached stale-lock cleanup failures do not orphan the new canonical lock", async (t) => {
  for (const branch of ["primary", "reclaim"]) {
    await t.test(branch, async (subtest) => {
      const home = await createTestHome(subtest);
      const env = { RELMIO_HOME: join(home, ".relmio") };
      const lockPath = join(home, ".relmio-local-codex-chatgpt.lock");
      const reclaimPath = join(lockPath, ".reclaim");
      await mkdir(branch === "reclaim" ? reclaimPath : lockPath, {
        recursive: true,
        mode: 0o700,
      });
      await writeFile(
        join(lockPath, "owner.json"),
        `${JSON.stringify({ processId: 39_970, ownerToken: "stale-owner" })}\n`,
        { mode: 0o600 },
      );
      if (branch === "reclaim") {
        await writeFile(
          join(reclaimPath, "owner.json"),
          `${JSON.stringify({ processId: 39_971, ownerToken: "stale-reclaimer" })}\n`,
          { mode: 0o600 },
        );
      }

      let injectedFailures = 0;
      const fileSystem = {
        ...nodeFileSystem,
        async rmdir(path, options) {
          const shouldFail = branch === "primary"
            ? path.startsWith(`${lockPath}.stale-`)
            : path.startsWith(`${reclaimPath}.stale-`);
          if (shouldFail && injectedFailures === 0) {
            injectedFailures += 1;
            throw new Error("injected detached stale cleanup failure");
          }
          return nodeFileSystem.rmdir(path, options);
        },
      };

      const releaseLock = await acquireLocalEndpointChangeLock(
        { target: "codex-chatgpt" },
        {
          env,
          fileSystem,
          processId: branch === "primary" ? 41_011 : 41_012,
          isProcessAlive: () => false,
        },
      );
      assert.equal(injectedFailures, 1);
      await releaseLock();
      await assert.rejects(() => lstat(lockPath), /ENOENT/u);
    });
  }
});

test("stale primary locks recover from missing and truncated owner metadata", async (t) => {
  for (const variant of ["missing", "truncated"]) {
    await t.test(variant, async (subtest) => {
      const home = await createTestHome(subtest);
      const env = { RELMIO_HOME: join(home, ".relmio") };
      const lockPath = join(home, ".relmio-local-codex-chatgpt.lock");
      const ownerPath = join(lockPath, "owner.json");
      await mkdir(lockPath, { mode: 0o700 });
      if (variant === "truncated") {
        await writeFile(ownerPath, '{"processId":', { mode: 0o600 });
      }
      const staleTime = new Date(Date.now() - 60_000);
      await utimes(variant === "missing" ? lockPath : ownerPath, staleTime, staleTime);

      const releaseLock = await acquireLocalEndpointChangeLock(
        { target: "codex-chatgpt" },
        {
          env,
          processId: variant === "missing" ? 41_020 : 41_021,
          isProcessAlive: () => false,
        },
      );
      await releaseLock();
      await assert.rejects(() => lstat(lockPath), /ENOENT/u);
    });
  }
});

test("stale reclaim locks recover from missing and truncated owner metadata", async (t) => {
  for (const variant of ["missing", "truncated"]) {
    await t.test(variant, async (subtest) => {
      const home = await createTestHome(subtest);
      const env = { RELMIO_HOME: join(home, ".relmio") };
      const lockPath = join(home, ".relmio-local-codex-chatgpt.lock");
      const ownerPath = join(lockPath, "owner.json");
      const reclaimPath = join(lockPath, ".reclaim");
      const reclaimOwnerPath = join(reclaimPath, "owner.json");
      await mkdir(reclaimPath, { recursive: true, mode: 0o700 });
      await writeFile(
        ownerPath,
        `${JSON.stringify({ processId: 39_980, ownerToken: "stale-owner" })}\n`,
        { mode: 0o600 },
      );
      if (variant === "truncated") {
        await writeFile(reclaimOwnerPath, '{"processId":', { mode: 0o600 });
      }
      const staleTime = new Date(Date.now() - 60_000);
      await utimes(
        variant === "missing" ? reclaimPath : reclaimOwnerPath,
        staleTime,
        staleTime,
      );

      const releaseLock = await acquireLocalEndpointChangeLock(
        { target: "codex-chatgpt" },
        {
          env,
          processId: variant === "missing" ? 41_022 : 41_023,
          isProcessAlive: () => false,
        },
      );
      await releaseLock();
      await assert.rejects(() => lstat(lockPath), /ENOENT/u);
    });
  }
});

test("a paused primary-lock creator cannot delete a successor lock after stale recovery", async (t) => {
  const home = await createTestHome(t);
  const env = { RELMIO_HOME: join(home, ".relmio") };
  const lockPath = join(home, ".relmio-local-codex-chatgpt.lock");
  const ownerPath = join(lockPath, "owner.json");
  let resumeOwnerWrite;
  let notifyOwnerWrite;
  const ownerWriteStarted = new Promise((resolvePromise) => {
    notifyOwnerWrite = resolvePromise;
  });
  const ownerWriteGate = new Promise((resolvePromise) => {
    resumeOwnerWrite = resolvePromise;
  });
  const pausedFileSystem = {
    ...nodeFileSystem,
    async writeFile(path, ...args) {
      if (path === ownerPath) {
        notifyOwnerWrite();
        await ownerWriteGate;
      }
      return nodeFileSystem.writeFile(path, ...args);
    },
  };

  const pausedAcquisition = acquireLocalEndpointChangeLock(
    { target: "codex-chatgpt" },
    {
      env,
      fileSystem: pausedFileSystem,
      processId: 41_030,
      isProcessAlive: () => false,
    },
  );
  void pausedAcquisition.catch(() => {});
  await ownerWriteStarted;
  const staleTime = new Date(Date.now() - 60_000);
  await utimes(lockPath, staleTime, staleTime);

  const releaseSuccessor = await acquireLocalEndpointChangeLock(
    { target: "codex-chatgpt" },
    { env, processId: 41_031, isProcessAlive: () => false },
  );
  resumeOwnerWrite();
  await assert.rejects(pausedAcquisition, /could not create its local project lock/u);
  assert.equal(JSON.parse(await readFile(ownerPath, "utf8")).processId, 41_031);
  await releaseSuccessor();
});

test("a paused reclaim creator cannot delete a successor lock after stale recovery", async (t) => {
  const home = await createTestHome(t);
  const env = { RELMIO_HOME: join(home, ".relmio") };
  const lockPath = join(home, ".relmio-local-codex-chatgpt.lock");
  const ownerPath = join(lockPath, "owner.json");
  const reclaimPath = join(lockPath, ".reclaim");
  const reclaimOwnerPath = join(reclaimPath, "owner.json");
  await mkdir(lockPath, { mode: 0o700 });
  await writeFile(
    ownerPath,
    `${JSON.stringify({ processId: 39_970, ownerToken: "stale-owner" })}\n`,
    { mode: 0o600 },
  );
  let resumeReclaimWrite;
  let notifyReclaimWrite;
  const reclaimWriteStarted = new Promise((resolvePromise) => {
    notifyReclaimWrite = resolvePromise;
  });
  const reclaimWriteGate = new Promise((resolvePromise) => {
    resumeReclaimWrite = resolvePromise;
  });
  const pausedFileSystem = {
    ...nodeFileSystem,
    async writeFile(path, ...args) {
      if (path === reclaimOwnerPath) {
        notifyReclaimWrite();
        await reclaimWriteGate;
      }
      return nodeFileSystem.writeFile(path, ...args);
    },
  };

  const pausedAcquisition = acquireLocalEndpointChangeLock(
    { target: "codex-chatgpt" },
    {
      env,
      fileSystem: pausedFileSystem,
      processId: 41_032,
      isProcessAlive: () => false,
    },
  );
  void pausedAcquisition.catch(() => {});
  await reclaimWriteStarted;
  const staleTime = new Date(Date.now() - 60_000);
  await utimes(reclaimPath, staleTime, staleTime);

  const releaseSuccessor = await acquireLocalEndpointChangeLock(
    { target: "codex-chatgpt" },
    { env, processId: 41_033, isProcessAlive: () => false },
  );
  resumeReclaimWrite();
  await assert.rejects(
    pausedAcquisition,
    /Another Relmio process is changing this local endpoint/u,
  );
  assert.equal(JSON.parse(await readFile(ownerPath, "utf8")).processId, 41_033);
  await releaseSuccessor();
});

test("an older stale reclaimer cannot detach a successor during owner publication", async (t) => {
  const home = await createTestHome(t);
  const env = { RELMIO_HOME: join(home, ".relmio") };
  const lockPath = join(home, ".relmio-local-codex-chatgpt.lock");
  const ownerPath = join(lockPath, "owner.json");
  const reclaimPath = join(lockPath, ".reclaim");
  await mkdir(lockPath, { mode: 0o700 });
  const staleTime = new Date(Date.now() - 60_000);
  await utimes(lockPath, staleTime, staleTime);

  let resumeOlderReclaim;
  let notifyOlderReclaim;
  const olderReclaimStarted = new Promise((resolvePromise) => {
    notifyOlderReclaim = resolvePromise;
  });
  const olderReclaimGate = new Promise((resolvePromise) => {
    resumeOlderReclaim = resolvePromise;
  });
  let pauseOlderReclaim = true;
  const olderFileSystem = {
    ...nodeFileSystem,
    async mkdir(path, options) {
      if (path === reclaimPath && pauseOlderReclaim) {
        pauseOlderReclaim = false;
        notifyOlderReclaim();
        await olderReclaimGate;
      }
      return nodeFileSystem.mkdir(path, options);
    },
  };

  let resumeSuccessorOwner;
  let notifySuccessorOwner;
  const successorOwnerStarted = new Promise((resolvePromise) => {
    notifySuccessorOwner = resolvePromise;
  });
  const successorOwnerGate = new Promise((resolvePromise) => {
    resumeSuccessorOwner = resolvePromise;
  });
  let pauseSuccessorOwner = true;
  const successorFileSystem = {
    ...nodeFileSystem,
    async writeFile(path, ...args) {
      if (path === ownerPath && pauseSuccessorOwner) {
        pauseSuccessorOwner = false;
        notifySuccessorOwner();
        await successorOwnerGate;
      }
      return nodeFileSystem.writeFile(path, ...args);
    },
  };

  const olderAcquisition = acquireLocalEndpointChangeLock(
    { target: "codex-chatgpt" },
    {
      env,
      fileSystem: olderFileSystem,
      processId: 41_038,
      isProcessAlive: () => false,
    },
  );
  void olderAcquisition.catch(() => {});
  await olderReclaimStarted;

  const successorAcquisition = acquireLocalEndpointChangeLock(
    { target: "codex-chatgpt" },
    {
      env,
      fileSystem: successorFileSystem,
      processId: 41_039,
      isProcessAlive: () => false,
    },
  );
  await successorOwnerStarted;
  resumeOlderReclaim();
  await assert.rejects(
    olderAcquisition,
    /Another Relmio process is changing this local endpoint/u,
  );
  resumeSuccessorOwner();
  const releaseSuccessor = await successorAcquisition;
  assert.equal(JSON.parse(await readFile(ownerPath, "utf8")).processId, 41_039);
  await releaseSuccessor();
});

test("a project-lock release failure restores a reclaimable owner publication", async (t) => {
  const home = await createTestHome(t);
  const env = { RELMIO_HOME: join(home, ".relmio") };
  const lockPath = join(home, ".relmio-local-codex-chatgpt.lock");
  let failReleasedDirectory = true;
  const fileSystem = {
    ...nodeFileSystem,
    async rmdir(path, options) {
      if (failReleasedDirectory && path.startsWith(`${lockPath}.released-`)) {
        failReleasedDirectory = false;
        throw new Error("injected release failure");
      }
      return nodeFileSystem.rmdir(path, options);
    },
  };
  const releaseLock = await acquireLocalEndpointChangeLock(
    { target: "codex-chatgpt" },
    {
      env,
      fileSystem,
      processId: 41_060,
      getProcessIdentity: async () => ({
        state: "active",
        startIdentity: "first-owner-start",
      }),
    },
  );
  await assert.rejects(releaseLock, /could not safely release/u);
  const restoredOwner = JSON.parse(
    await readFile(join(lockPath, "owner.json"), "utf8"),
  );
  assert.equal(restoredOwner.processId, 41_060);
  assert.match(restoredOwner.ownerToken, /^[a-f0-9-]{36}$/u);
  assert.equal(restoredOwner.processStartIdentity, "first-owner-start");

  const releaseRecovered = await acquireLocalEndpointChangeLock(
    { target: "codex-chatgpt" },
    {
      env,
      processId: 41_061,
      getProcessIdentity: async (processId) => processId === 41_061
        ? { state: "active", startIdentity: "second-owner-start" }
        : { state: "dead" },
    },
  );
  await releaseRecovered();
  await assert.rejects(() => lstat(lockPath), /ENOENT/u);
});

test("a post-open primary owner write cannot survive stale lock replacement", { skip: process.platform === "win32" }, async (t) => {
  const home = await createTestHome(t);
  const env = { RELMIO_HOME: join(home, ".relmio") };
  const lockPath = join(home, ".relmio-local-codex-chatgpt.lock");
  const ownerPath = join(lockPath, "owner.json");
  let resumeOwnerWrite;
  let notifyOwnerOpened;
  const ownerOpened = new Promise((resolvePromise) => {
    notifyOwnerOpened = resolvePromise;
  });
  const ownerWriteGate = new Promise((resolvePromise) => {
    resumeOwnerWrite = resolvePromise;
  });
  const pausedFileSystem = {
    ...nodeFileSystem,
    async writeFile(path, contents, options) {
      if (path !== ownerPath) {
        return nodeFileSystem.writeFile(path, contents, options);
      }
      const handle = await nodeFileSystem.open(path, options.flag, options.mode);
      notifyOwnerOpened();
      await ownerWriteGate;
      try {
        await handle.writeFile(contents);
      } finally {
        await handle.close();
      }
    },
  };

  const pausedAcquisition = acquireLocalEndpointChangeLock(
    { target: "codex-chatgpt" },
    {
      env,
      fileSystem: pausedFileSystem,
      processId: 41_034,
      isProcessAlive: () => false,
    },
  );
  void pausedAcquisition.catch(() => {});
  await ownerOpened;
  const staleTime = new Date(Date.now() - 60_000);
  await utimes(ownerPath, staleTime, staleTime);

  const releaseSuccessor = await acquireLocalEndpointChangeLock(
    { target: "codex-chatgpt" },
    { env, processId: 41_035, isProcessAlive: () => false },
  );
  resumeOwnerWrite();
  await assert.rejects(pausedAcquisition, /could not create its local project lock/u);
  assert.equal(JSON.parse(await readFile(ownerPath, "utf8")).processId, 41_035);
  await releaseSuccessor();
});

test("a post-open reclaim owner write cannot survive stale lock replacement", { skip: process.platform === "win32" }, async (t) => {
  const home = await createTestHome(t);
  const env = { RELMIO_HOME: join(home, ".relmio") };
  const lockPath = join(home, ".relmio-local-codex-chatgpt.lock");
  const ownerPath = join(lockPath, "owner.json");
  const reclaimPath = join(lockPath, ".reclaim");
  const reclaimOwnerPath = join(reclaimPath, "owner.json");
  await mkdir(lockPath, { mode: 0o700 });
  await writeFile(
    ownerPath,
    `${JSON.stringify({ processId: 39_960, ownerToken: "stale-owner" })}\n`,
    { mode: 0o600 },
  );
  let resumeReclaimWrite;
  let notifyReclaimOpened;
  const reclaimOpened = new Promise((resolvePromise) => {
    notifyReclaimOpened = resolvePromise;
  });
  const reclaimWriteGate = new Promise((resolvePromise) => {
    resumeReclaimWrite = resolvePromise;
  });
  const pausedFileSystem = {
    ...nodeFileSystem,
    async writeFile(path, contents, options) {
      if (path !== reclaimOwnerPath) {
        return nodeFileSystem.writeFile(path, contents, options);
      }
      const handle = await nodeFileSystem.open(path, options.flag, options.mode);
      notifyReclaimOpened();
      await reclaimWriteGate;
      try {
        await handle.writeFile(contents);
      } finally {
        await handle.close();
      }
    },
  };

  const pausedAcquisition = acquireLocalEndpointChangeLock(
    { target: "codex-chatgpt" },
    {
      env,
      fileSystem: pausedFileSystem,
      processId: 41_036,
      isProcessAlive: () => false,
    },
  );
  void pausedAcquisition.catch(() => {});
  await reclaimOpened;
  const staleTime = new Date(Date.now() - 60_000);
  await utimes(reclaimOwnerPath, staleTime, staleTime);

  const releaseSuccessor = await acquireLocalEndpointChangeLock(
    { target: "codex-chatgpt" },
    { env, processId: 41_037, isProcessAlive: () => false },
  );
  resumeReclaimWrite();
  await assert.rejects(
    pausedAcquisition,
    /Another Relmio process is changing this local endpoint/u,
  );
  assert.equal(JSON.parse(await readFile(ownerPath, "utf8")).processId, 41_037);
  await releaseSuccessor();
});

test("install refuses missing confirmation before filesystem or Docker actions", async (t) => {
  const home = await createTestHome(t);
  const runProcess = createRunner();
  const plan = createLocalDeploymentPlan({ target: "openai-api", port: 12435 });

  await assert.rejects(
    () =>
      installLocalEndpoint(
        { plan, apiKey: platformKey, confirmed: false },
        {
          env: { RELMIO_HOME: join(home, ".relmio") },
          runProcess,
          randomBytes: () => Buffer.alloc(32, 7),
          isPortAvailable: async () => true,
          readGatewaySource: async () => "export {};",
          fetchImpl: createFetch(),
        },
      ),
    /confirm/i,
  );
  await assert.rejects(() => lstat(join(home, ".relmio")), /ENOENT/);
  assert.deepEqual(runProcess.calls, []);
});

test("install validates provider credentials before writes", async (t) => {
  const home = await createTestHome(t);
  const runProcess = createRunner();
  const plan = createLocalDeploymentPlan({ target: "openai-api", port: 12435 });

  await assert.rejects(
    () =>
      installLocalEndpoint(
        { plan, apiKey: "chatgpt-access-token", confirmed: true },
        {
          env: { RELMIO_HOME: join(home, ".relmio") },
          runProcess,
        },
      ),
    /Platform API key/i,
  );
  await assert.rejects(() => lstat(join(home, ".relmio")), /ENOENT/);
  assert.deepEqual(runProcess.calls, []);
});

test("fresh endpoint root initialization removes only an empty failed root and retries immediately", async (t) => {
  const home = await createTestHome(t);
  const env = { RELMIO_HOME: join(home, ".relmio") };
  const relmioHome = env.RELMIO_HOME;
  const runner = createRunner({
    contextHost: "unix:///var/run/docker.sock",
    contextName: "default",
  });
  let failRootChmod = true;
  const fileSystem = {
    ...nodeFileSystem,
    async chmod(path, mode) {
      if (path === relmioHome && failRootChmod) {
        failRootChmod = false;
        throw new Error("injected fresh-root chmod failure");
      }
      return nodeFileSystem.chmod(path, mode);
    },
  };
  const request = { apiKey: platformKey, confirmed: true };
  const dependencies = {
    env,
    fileSystem,
    getProcessIdentity: async () => ({
      state: "active",
      startIdentity: "test-fresh-root-owner",
    }),
    platform: "linux",
    runProcess: runner,
    randomBytes: () => Buffer.alloc(32, 7),
    isPortAvailable: async () => true,
    readGatewaySource: async () => "export {};",
    fetchImpl: createFetch(),
  };

  await assert.rejects(
    () => installLocalEndpoint({ plan: createLocalDeploymentPlan({ target: "openai-api", port: 12435 }), ...request }, dependencies),
    /injected fresh-root chmod failure/iu,
  );
  await assert.rejects(() => lstat(relmioHome), /ENOENT/u);

  const result = await installLocalEndpoint(
    { plan: createLocalDeploymentPlan({ target: "openai-api", port: 12435 }), ...request },
    dependencies,
  );
  assert.equal(result.deploymentMode, "installed");
  assert.equal((await lstat(relmioHome)).isDirectory(), true);
});

test("fresh endpoint root initialization rolls back after Windows ACL setup fails", async (t) => {
  const home = await createTestHome(t);
  const env = { RELMIO_HOME: join(home, ".relmio") };
  const relmioHome = env.RELMIO_HOME;
  const runner = createRunner();
  let failRootAcl = true;
  const lockDownPath = async (path) => {
    if (path === relmioHome && failRootAcl) {
      failRootAcl = false;
      throw new Error("injected fresh-root ACL failure");
    }
  };
  const request = { apiKey: platformKey, confirmed: true };
  const dependencies = {
    env,
    getProcessIdentity: async () => ({
      state: "active",
      startIdentity: "test-windows-acl-owner",
    }),
    platform: "win32",
    runProcess: runner,
    lockDownPath,
    randomBytes: () => Buffer.alloc(32, 7),
    isPortAvailable: async () => true,
    readGatewaySource: async () => "export {};",
    fetchImpl: createFetch(),
  };

  await assert.rejects(
    () => installLocalEndpoint({ plan: createLocalDeploymentPlan({ target: "openai-api", port: 12435 }), ...request }, dependencies),
    /injected fresh-root ACL failure/iu,
  );
  await assert.rejects(() => lstat(relmioHome), /ENOENT/u);

  const result = await installLocalEndpoint(
    { plan: createLocalDeploymentPlan({ target: "openai-api", port: 12435 }), ...request },
    dependencies,
  );
  assert.equal(result.deploymentMode, "installed");
  assert.equal((await lstat(relmioHome)).isDirectory(), true);
});

test("OpenAI install keeps the Platform key only in a private seeded Docker volume", async (t) => {
  const home = await createTestHome(t);
  const runProcess = createRunner();
  const fetchImpl = createFetch();
  const env = { RELMIO_HOME: join(home, ".relmio") };
  const plan = createLocalDeploymentPlan({
    target: "openai-api",
    port: 12435,
    allowedOrigins: ["http://localhost:3000"],
  });

  const result = await installLocalEndpoint(
    { plan, apiKey: platformKey, confirmed: true },
    {
      env,
      runProcess,
      randomBytes: () => Buffer.alloc(32, 7),
      isPortAvailable: async () => true,
      readGatewaySource: async () => "export const runtimeFixture = true;\n",
      fetchImpl,
    },
  );

  assert.deepEqual(result, {
    target: "openai-api",
    endpoint: "http://127.0.0.1:12435/v1",
    protocol: "openai-v1",
    clientCredential: capability,
    credentialShownOnce: true,
    models: ["gpt-5.6-terra"],
    deploymentMode: "installed",
    experimental: false,
    browserClients: true,
  });

  const installRoot = await resolveLocalInstallRoot({ target: "openai-api", env });
  const secretPath = join(installRoot, "secrets", "openai-api-key");
  await assert.rejects(() => lstat(secretPath), /ENOENT/);
  assert.deepEqual((await readdir(installRoot)).sort(), [
    ".dockerignore",
    ".managed-by-relmio.json",
    "Dockerfile",
    "docker-compose.yml",
    "gateway.mjs",
  ]);
  if (process.platform !== "win32") {
    assert.equal((await stat(installRoot)).mode & 0o777, 0o700);
  }
  assert.equal(
    await readFile(join(installRoot, ".dockerignore"), "utf8"),
    "**\n!Dockerfile\n!gateway.mjs\n",
  );
  const compose = await readFile(join(installRoot, "docker-compose.yml"), "utf8");
  assert.doesNotMatch(compose, new RegExp(platformKey));
  assert.doesNotMatch(compose, new RegExp(capability));
  assert.match(compose, /127\.0\.0\.1:12435:10531/);
  assert.match(compose, new RegExp(`io\\.relmio\\.install: "${"07".repeat(16)}"`));
  assert.deepEqual(
    JSON.parse(
      await readFile(join(installRoot, ".managed-by-relmio.json"), "utf8"),
    ),
    {
      schemaVersion: 2,
      target: "openai-api",
      port: 12435,
      dockerHost: TEST_DOCKER_HOST,
      installId: "07".repeat(16),
      projectName: `relmio-openai-api-${"07".repeat(16)}`,
    },
  );
  assert.equal(await readFile(join(installRoot, "gateway.mjs"), "utf8"), "export const runtimeFixture = true;\n");
  for (const artifactName of await readdir(installRoot)) {
    assert.doesNotMatch(
      await readFile(join(installRoot, artifactName), "utf8"),
      new RegExp(platformKey),
    );
  }

  const seedCalls = runProcess.calls.filter(({ input }) => input !== undefined);
  assert.equal(seedCalls.length, 1);
  assert.deepEqual(seedCalls[0].input, Buffer.from(platformKey, "utf8"));
  assert.equal(seedCalls[0].file, "docker");
  assert.deepEqual(seedCalls[0].args.slice(-6), [
    "run",
    "--rm",
    "--no-deps",
    "--no-build",
    "-T",
    "credential-seed",
  ]);
  const processMetadata = runProcess.calls.map(({ input, ...spec }) => spec);
  assert.doesNotMatch(JSON.stringify(processMetadata), new RegExp(platformKey));
  assert.doesNotMatch(JSON.stringify(result), new RegExp(platformKey));
  assert.ok(processMetadata.every(({ shell, env: processEnv }) =>
    shell === undefined && processEnv === undefined
  ));
  const buildIndex = runProcess.calls.findIndex(({ args }) =>
    args.at(-2) === "build" && args.at(-1) === "gateway"
  );
  const seedIndex = runProcess.calls.indexOf(seedCalls[0]);
  const startIndex = runProcess.calls.findIndex(({ args }) =>
    args.includes("up")
  );
  assert.ok(buildIndex !== -1 && buildIndex < seedIndex && seedIndex < startIndex);
  assert.ok(
    runProcess.calls.some(({ args }) =>
      args.join(" ").startsWith("volume ls --filter label=com.docker.compose.project=")
    ),
  );

  assert.ok(
    runProcess.calls.every(
      ({ file, args }) =>
        file === "docker" &&
        !args.join(" ").match(/n8n|openai-oauth|--remove-orphans/i),
    ),
  );
  assert.ok(
    runProcess.calls
      .filter(({ args }) => args.includes("compose"))
      .every(
        ({ cwd, dockerHost }) =>
          cwd === installRoot &&
          dockerHost === TEST_DOCKER_HOST,
      ),
  );
  assert.ok(
    runProcess.calls.some(({ args }) =>
      args.join(" ").includes(
        `compose --project-name relmio-openai-api-${"07".repeat(16)} --file docker-compose.yml up -d --wait --wait-timeout 90 --no-deps gateway`,
      ),
    ),
  );
  assert.equal(
    fetchImpl.calls.at(-1).options.headers.Authorization,
    `Bearer ${capability}`,
  );
});

test("Codex install has no Platform secret and returns native App Server details", async (t) => {
  const home = await createTestHome(t);
  const runProcess = createRunner({ publishedPort: 14500 });
  const verifyCodexCapability = createCodexCapabilityVerifier();
  const plan = createLocalDeploymentPlan({ target: "codex-chatgpt", port: 14500 });

  const result = await installLocalEndpoint(
    { plan, confirmed: true },
    {
      env: { RELMIO_HOME: join(home, ".relmio") },
      runProcess,
      randomBytes: () => Buffer.alloc(32, 7),
      isPortAvailable: async () => true,
      fetchImpl: createFetch(),
      verifyCodexCapability,
    },
  );

  assert.deepEqual(result, {
    target: "codex-chatgpt",
    endpoint: "ws://127.0.0.1:14500",
    protocol: "codex-app-server-json-rpc",
    clientCredential: capability,
    credentialShownOnce: true,
    models: [],
    deploymentMode: "installed",
    experimental: true,
    browserClients: false,
  });
  assert.deepEqual(verifyCodexCapability.calls, [
    { port: 14500, clientCredential: capability },
  ]);
  const installRoot = await resolveLocalInstallRoot({
    target: "codex-chatgpt",
    env: { RELMIO_HOME: join(home, ".relmio") },
  });
  await assert.rejects(
    () => readFile(join(installRoot, "secrets", "openai-api-key")),
    /ENOENT/,
  );
  const compose = await readFile(join(installRoot, "docker-compose.yml"), "utf8");
  assert.match(compose, /@openai\/codex|codex-home|127\.0\.0\.1:14500:4500/);
  assert.doesNotMatch(compose, new RegExp(capability));
  const requirements = await readFile(
    join(installRoot, "requirements.toml"),
    "utf8",
  );
  assert.match(requirements, /default_permissions = "relmio-workspace"/);
  assert.match(requirements, /"relmio-workspace" = true/);
  assert.doesNotMatch(requirements, /allowed_sandbox_modes/);
  if (process.platform !== "win32") {
    assert.equal((await stat(join(installRoot, "requirements.toml"))).mode & 0o777, 0o600);
  }
});

test("Codex Chat install packages the adapter and verifies only its non-billing readiness route", async (t) => {
  const home = await createTestHome(t);
  const runProcess = createRunner({ publishedPort: 14501 });
  const fetchImpl = createFetch();
  const env = { RELMIO_HOME: join(home, ".relmio") };
  const plan = createLocalDeploymentPlan({ target: "codex-chat", port: 14501 });

  const result = await installLocalEndpoint(
    { plan, confirmed: true },
    {
      env,
      runProcess,
      randomBytes: () => Buffer.alloc(32, 7),
      isPortAvailable: async () => true,
      readCodexChatSource: async () => "export const adapterFixture = true;\n",
      fetchImpl,
    },
  );

  assert.deepEqual(result, {
    target: "codex-chat",
    endpoint: "http://127.0.0.1:14501",
    protocol: "relmio-codex-chat-http",
    clientCredential: capability,
    credentialShownOnce: true,
    models: [],
    deploymentMode: "installed",
    experimental: true,
    browserClients: false,
  });
  assert.deepEqual(fetchImpl.calls, [
    {
      url: "http://127.0.0.1:14501/health",
      options: { method: "GET", signal: fetchImpl.calls[0].options.signal },
    },
    {
      url: "http://127.0.0.1:14501/auth/verify",
      options: {
        method: "GET",
        headers: { Authorization: `Bearer ${capability}` },
        signal: fetchImpl.calls[1].options.signal,
      },
    },
  ]);
  const installRoot = await resolveLocalInstallRoot({ target: "codex-chat", env });
  assert.equal(
    await readFile(join(installRoot, "gateway.mjs"), "utf8"),
    "export const adapterFixture = true;\n",
  );
  const compose = await readFile(join(installRoot, "docker-compose.yml"), "utf8");
  assert.match(compose, /127\.0\.0\.1:14501:14501/);
  assert.doesNotMatch(compose, new RegExp(capability));
  assert.ok(
    runProcess.calls.some(({ args }) =>
      args.join(" ").includes("build codex-chat"),
    ),
  );
  assert.ok(
    fetchImpl.calls.every(({ url }) => !String(url).includes("/v1/models")),
  );
});

test("Codex install removes only its exact service when capability authentication fails", async (t) => {
  const home = await createTestHome(t);
  const runProcess = createRunner({ publishedPort: 14500 });
  const verifyCodexCapability = createCodexCapabilityVerifier({
    error: new Error("The Codex client credential could not be verified."),
  });
  const plan = createLocalDeploymentPlan({ target: "codex-chatgpt", port: 14500 });

  await assert.rejects(
    () =>
      installLocalEndpoint(
        { plan, confirmed: true },
        {
          env: { RELMIO_HOME: join(home, ".relmio") },
          runProcess,
          randomBytes: () => Buffer.alloc(32, 7),
          isPortAvailable: async () => true,
          fetchImpl: createFetch(),
          verifyCodexCapability,
        },
      ),
    /Codex client credential could not be verified/u,
  );

  assert.deepEqual(verifyCodexCapability.calls, [
    { port: 14500, clientCredential: capability },
  ]);
  const cleanup = runProcess.calls.find(({ args }) => args.includes("rm"));
  const verification = runProcess.calls.find(
    ({ args }) => args.includes("--all") && args.includes("--services"),
  );
  assert.deepEqual(cleanup.args.slice(-4), ["rm", "--force", "--stop", "codex"]);
  assert.deepEqual(verification.args.slice(-4), [
    "ps",
    "--all",
    "--services",
    "codex",
  ]);
});

test("installer refuses unmanaged and symlinked managed roots", async (t) => {
  const home = await createTestHome(t);
  const stateRoot = join(home, ".relmio");
  const localRoot = join(stateRoot, "local");
  const targetRoot = join(localRoot, "openai-api");
  await mkdir(targetRoot, { recursive: true });
  const plan = createLocalDeploymentPlan({ target: "openai-api", port: 12435 });

  await assert.rejects(
    () =>
      installLocalEndpoint(
        { plan, apiKey: platformKey, confirmed: true },
        { env: { RELMIO_HOME: stateRoot }, runProcess: createRunner() },
      ),
    /managed-root marker|managed marker/i,
  );
  if (process.platform !== "win32") {
    assert.equal((await stat(stateRoot)).mode & 0o777, 0o755);
  }

  await rm(targetRoot, { recursive: true });
  await writeFile(
    join(stateRoot, ".managed-by-relmio-root.json"),
    `${JSON.stringify({ schemaVersion: 1, kind: "relmio-local-root" })}\n`,
  );
  const outside = join(home, "outside");
  await mkdir(outside);
  await symlink(outside, targetRoot, process.platform === "win32" ? "junction" : undefined);
  await assert.rejects(
    () =>
      installLocalEndpoint(
        { plan, apiKey: platformKey, confirmed: true },
        { env: { RELMIO_HOME: stateRoot }, runProcess: createRunner() },
      ),
    /symbolic link|symlink/i,
  );
});

test("managed marker files themselves cannot be symbolic links", { skip: process.platform === "win32" }, async (t) => {
  const home = await createTestHome(t);
  const stateRoot = join(home, ".relmio");
  const localRoot = join(stateRoot, "local");
  const codexRoot = join(localRoot, "codex-chatgpt");
  const plan = createLocalDeploymentPlan({ target: "openai-api", port: 12435 });
  await mkdir(stateRoot, { recursive: true });

  const outsideRootMarker = join(home, "outside-root-marker.json");
  await writeFile(
    outsideRootMarker,
    `${JSON.stringify({ schemaVersion: 1, kind: "relmio-local-root" })}\n`,
  );
  await symlink(
    outsideRootMarker,
    join(stateRoot, ".managed-by-relmio-root.json"),
  );
  await assert.rejects(
    () =>
      installLocalEndpoint(
        { plan, apiKey: platformKey, confirmed: true },
        { env: { RELMIO_HOME: stateRoot }, runProcess: createRunner() },
      ),
    /managed-root marker/i,
  );

  await rm(join(stateRoot, ".managed-by-relmio-root.json"));
  await writeFile(
    join(stateRoot, ".managed-by-relmio-root.json"),
    `${JSON.stringify({ schemaVersion: 1, kind: "relmio-local-root" })}\n`,
  );
  await mkdir(codexRoot, { recursive: true });
  const installId = "0123456789abcdef0123456789abcdef";
  const outsideTargetMarker = join(home, "outside-target-marker.json");
  await writeFile(
    outsideTargetMarker,
    `${JSON.stringify({
      schemaVersion: 2,
      target: "codex-chatgpt",
      port: 14500,
      dockerHost: TEST_DOCKER_HOST,
      installId,
      projectName: `relmio-codex-chatgpt-${installId}`,
    })}\n`,
  );
  await symlink(
    outsideTargetMarker,
    join(codexRoot, ".managed-by-relmio.json"),
  );
  await assert.rejects(
    () =>
      attestLocalCodexInstallation(
        { installDirectory: codexRoot },
        { runProcess: createRunner() },
      ),
    /managed marker/i,
  );
});

test("Windows reparse-point marker metadata is rejected before Docker mutation", async (t) => {
  const home = await createTestHome(t);
  const stateRoot = join(home, ".relmio");
  const rootMarkerPath = join(stateRoot, ".managed-by-relmio-root.json");
  await mkdir(stateRoot, { recursive: true });
  await writeFile(
    rootMarkerPath,
    `${JSON.stringify({ schemaVersion: 1, kind: "relmio-local-root" })}\n`,
  );
  const runProcess = createRunner();
  const fileSystem = {
    ...nodeFileSystem,
    async lstat(path) {
      const metadata = await nodeFileSystem.lstat(path);
      if (path === rootMarkerPath) {
        return {
          isDirectory: () => false,
          isFile: () => true,
          isSymbolicLink: () => true,
        };
      }
      return metadata;
    },
  };
  await assert.rejects(
    () => installLocalEndpoint(
      {
        plan: createLocalDeploymentPlan({ target: "openai-api", port: 12435 }),
        apiKey: platformKey,
        confirmed: true,
      },
      {
        env: { RELMIO_HOME: stateRoot },
        fileSystem,
        runProcess,
        platform: "win32",
        processId: 41_050,
        isProcessAlive: () => true,
      },
    ),
    /managed-root marker/i,
  );
  assert.equal(runProcess.calls.length, 0);
});

test("installer rejects unsafe managed bases and ancestor symlinks", async (t) => {
  const home = await createTestHome(t);
  const plan = createLocalDeploymentPlan({ target: "openai-api", port: 12435 });
  const common = {
    runProcess: createRunner(),
    randomBytes: () => Buffer.alloc(32, 7),
    isPortAvailable: async () => true,
    readGatewaySource: async () => "export {};",
    fetchImpl: createFetch(),
  };

  await assert.rejects(
    () =>
      installLocalEndpoint(
        { plan, apiKey: platformKey, confirmed: true },
        { ...common, env: { RELMIO_HOME: home } },
      ),
    /storage path/i,
  );
  await assert.rejects(
    () =>
      installLocalEndpoint(
        { plan, apiKey: platformKey, confirmed: true },
        {
          ...common,
          env: {
            RELMIO_HOME: join(home, ".relmio"),
            DOCKER_CONTEXT: "remote",
          },
        },
      ),
    /Docker environment overrides/i,
  );

  const realParent = join(home, "real-parent");
  const linkedParent = join(home, "linked-parent");
  await mkdir(realParent);
  await symlink(realParent, linkedParent, process.platform === "win32" ? "junction" : undefined);
  await assert.rejects(
    () =>
      installLocalEndpoint(
        { plan, apiKey: platformKey, confirmed: true },
        {
          ...common,
          env: { RELMIO_HOME: join(linkedParent, ".relmio") },
        },
      ),
    /symbolic-link ancestor/i,
  );
});

test("installer refuses foreign Docker containers, networks, and named volumes before writing", async (t) => {
  const plan = createLocalDeploymentPlan({ target: "openai-api", port: 12435 });
  for (const foreignOwnership of ["container", "network", "volume"]) {
    const home = await createTestHome(t);
    await assert.rejects(
      () =>
        installLocalEndpoint(
          { plan, apiKey: platformKey, confirmed: true },
          {
            env: { RELMIO_HOME: join(home, ".relmio") },
            runProcess: createRunner({ foreignOwnership }),
            randomBytes: () => Buffer.alloc(32, 7),
            isPortAvailable: async () => true,
            readGatewaySource: async () => "export {};",
            fetchImpl: createFetch(),
          },
        ),
      /without matching ownership/i,
    );
    await assert.rejects(() => lstat(join(home, ".relmio")), /ENOENT/);
  }
});

test("installer rejects occupied and non-loopback publication ports", async (t) => {
  const home = await createTestHome(t);
  const plan = createLocalDeploymentPlan({ target: "openai-api", port: 12435 });
  const common = {
    env: { RELMIO_HOME: join(home, ".relmio") },
    randomBytes: () => Buffer.alloc(32, 7),
    readGatewaySource: async () => "export {};",
    fetchImpl: createFetch(),
  };

  await assert.rejects(
    () =>
      installLocalEndpoint(
        { plan, apiKey: platformKey, confirmed: true },
        { ...common, runProcess: createRunner(), isPortAvailable: async () => false },
      ),
    /port.*use|available/i,
  );

  await rm(join(home, ".relmio"), { recursive: true, force: true });
  await assert.rejects(
    () =>
      installLocalEndpoint(
        { plan, apiKey: platformKey, confirmed: true },
        {
          ...common,
          runProcess: createRunner({ publisherHost: "0.0.0.0" }),
          isPortAvailable: async () => true,
        },
      ),
    /loopback|publication/i,
  );
});

test("installer stops only its own service when publication verification fails", async (t) => {
  const home = await createTestHome(t);
  const runProcess = createRunner({ publisherHost: "0.0.0.0" });
  const plan = createLocalDeploymentPlan({ target: "openai-api", port: 12435 });

  await assert.rejects(
    () =>
      installLocalEndpoint(
        { plan, apiKey: platformKey, confirmed: true },
        {
          env: { RELMIO_HOME: join(home, ".relmio") },
          runProcess,
          randomBytes: () => Buffer.alloc(32, 7),
          isPortAvailable: async () => true,
          readGatewaySource: async () => "export {};",
          fetchImpl: createFetch(),
        },
      ),
    /loopback|publication/i,
  );

  assert.ok(
    runProcess.calls.some(({ args }) =>
      args.join(" ").includes(
        `compose --project-name relmio-openai-api-${"07".repeat(16)} --file docker-compose.yml rm --force --stop gateway`,
      ),
    ),
  );
  assert.ok(
    runProcess.calls.every(({ args }) => !args.join(" ").match(/n8n|--volumes/i)),
  );
  assert.ok(
    runProcess.calls.some(({ args }) =>
      args.join(" ").includes("ps --all --services gateway"),
    ),
  );
});

test("installer fails loudly when unsafe-service cleanup cannot be confirmed", async (t) => {
  for (const options of [
    { cleanupCode: 1 },
    { cleanupStillRunning: true },
  ]) {
    const home = await createTestHome(t);
    const plan = createLocalDeploymentPlan({ target: "openai-api", port: 12435 });

    await assert.rejects(
      () =>
        installLocalEndpoint(
          { plan, apiKey: platformKey, confirmed: true },
          {
            env: { RELMIO_HOME: join(home, ".relmio") },
            runProcess: createRunner({ publisherHost: "0.0.0.0", ...options }),
            randomBytes: () => Buffer.alloc(32, 7),
            isPortAvailable: async () => true,
            readGatewaySource: async () => "export {};",
            fetchImpl: createFetch(),
          },
        ),
      /could not confirm.*stopped/i,
    );
  }
});

test("managed update re-seeds the named volume and rotates the client key", async (t) => {
  const home = await createTestHome(t);
  const env = { RELMIO_HOME: join(home, ".relmio") };
  const plan = createLocalDeploymentPlan({ target: "openai-api", port: 12435 });
  const runProcess = createRunner();
  const install = (randomByte, apiKey) =>
    installLocalEndpoint(
      { plan, apiKey, confirmed: true },
      {
        env,
        runProcess,
        randomBytes: () => Buffer.alloc(32, randomByte),
        isPortAvailable: async () => {
          if (randomByte === 8) {
            throw new Error("same managed port must not be probed");
          }
          return true;
        },
        readGatewaySource: async () => "export {};",
        fetchImpl: createFetch(),
      },
    );

  const first = await install(7, platformKey);
  const second = await install(8, rotatedPlatformKey);
  assert.equal(first.deploymentMode, "installed");
  assert.equal(second.deploymentMode, "updated");
  assert.notEqual(first.clientCredential, second.clientCredential);
  assert.deepEqual(
    runProcess.calls
      .filter(({ input }) => input !== undefined)
      .map(({ input }) => input),
    [
      Buffer.from(platformKey, "utf8"),
      Buffer.from(rotatedPlatformKey, "utf8"),
    ],
  );
  const installRoot = await resolveLocalInstallRoot({
    target: "openai-api",
    env,
  });
  for (const artifactName of await readdir(installRoot)) {
    const contents = await readFile(join(installRoot, artifactName), "utf8");
    assert.doesNotMatch(contents, new RegExp(platformKey));
    assert.doesNotMatch(contents, new RegExp(rotatedPlatformKey));
  }
});

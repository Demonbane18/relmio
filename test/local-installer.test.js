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
import { pathToFileURL } from "node:url";
import test from "node:test";

import {
  createGrokBuildComposeFile,
  createGrokBuildDockerfile,
  createLocalDeploymentPlan,
} from "../src/domain/local-endpoints.js";
import {
  acquireLocalEndpointChangeLock as acquireLocalEndpointChangeLockService,
  activateLocalClientCredentialRotation as activateLocalClientCredentialRotationService,
  attestLocalCodexInstallation,
  attestLocalGrokBuildInstallation,
  getLocalDockerStatus,
  installLocalEndpoint as installLocalEndpointService,
  restartLocalCodex as restartLocalCodexService,
  prepareLocalClientCredentialRotation as prepareLocalClientCredentialRotationService,
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
const prepareLocalClientCredentialRotation = (request, dependencies) =>
  prepareLocalClientCredentialRotationService(request, withTestLocalSecurity(dependencies));
const restartLocalCodex = (request, dependencies) =>
  restartLocalCodexService(request, withTestLocalSecurity(dependencies));
const attestLocalGrokBuild = (request, dependencies) =>
  attestLocalGrokBuildInstallation(request, withTestLocalSecurity(dependencies));

const capability = Buffer.alloc(32, 7).toString("base64url");
const TEST_DOCKER_HOST = process.platform === "win32"
  ? "npipe:////./pipe/dockerDesktopLinuxEngine"
  : "unix:///var/run/docker.sock";
const TEST_DOCKER_CONTEXT = process.platform === "win32" ? "desktop-linux" : "default";

test("direct OAuth endpoint installation rejects retired API-key fields before process work", async () => {
  let processCalls = 0;
  await assert.rejects(
    () => installLocalEndpoint({
      plan: createLocalDeploymentPlan({ target: "xai-grok-build" }),
      confirmed: true,
      apiKey: "retired-api-key-field",
    }, {
      runProcess: async () => {
        processCalls += 1;
        throw new Error("must not run");
      },
    }),
    /OAuth local endpoint install request is invalid/u,
  );
  assert.equal(processCalls, 0);
});

async function createTestHome(t) {
  const root = await import("node:fs/promises").then(({ mkdtemp }) =>
    mkdtemp(join(tmpdir(), "relmio-local-test-")),
  );
  t.after(async () => rm(root, { recursive: true, force: true }));
  return realpath(root);
}

function expectedWindowsManagedEndpointAclCalls(relmioHome, installRoot) {
  return [
    { path: relmioHome, options: { platform: "win32", verifyOnly: true } },
    {
      path: join(relmioHome, "local"),
      options: { platform: "win32", verifyOnly: true },
    },
    { path: installRoot, options: { platform: "win32", verifyOnly: true } },
    {
      path: join(relmioHome, ".managed-by-relmio-root.json"),
      options: { platform: "win32", kind: "file", verifyOnly: true, verifyEffectiveOwnerOnly: true },
    },
    {
      path: join(installRoot, ".managed-by-relmio.json"),
      options: { platform: "win32", kind: "file", verifyOnly: true, verifyEffectiveOwnerOnly: true },
    },
    {
      path: join(installRoot, "docker-compose.yml"),
      options: { platform: "win32", kind: "file", verifyOnly: true, verifyEffectiveOwnerOnly: true },
    },
  ];
}

function isManagedEndpointComposeMutation({ args }) {
  return args[0] === "compose" && (
    args.includes("restart") ||
    args.includes("up") ||
    args.includes("--force-recreate")
  );
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
  grokVersion = "grok 1.0.13 (5e9a58528b76)\n",
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
    if (args.endsWith("grok-build --version")) {
      return { stdout: grokVersion, stderr: "", code: 0 };
    }
    if (args.includes("ps --status running --services")) {
      return {
        stdout: args.includes("relmio-openai-api") || args.includes("relmio-xai-inference")
          ? "gateway\n"
          : args.includes("relmio-xai-grok-build-")
            ? "grok-build\n"
            : args.includes("relmio-codex-chat-")
            ? "codex-chat\n"
            : "codex\n",
        stderr: "",
        code: 0,
      };
    }
    if (args.includes("ps --format json")) {
      const targetPort = args.includes("relmio-openai-api") || args.includes("relmio-xai-inference")
        ? 10_531
        : args.includes("relmio-xai-grok-build-")
          ? 14_502
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

test("Windows Codex mutation attestations inject exact verify-only managed ACL checks", async (t) => {
  const home = await createTestHome(t);
  const relmioHome = join(home, ".relmio");
  const env = { RELMIO_HOME: relmioHome };
  const runProcess = createRunner({ publishedPort: 14500 });
  const fetchImpl = createFetch();
  const verifyCodexCapability = createCodexCapabilityVerifier();
  const plan = createLocalDeploymentPlan({ target: "codex-chatgpt", port: 14500 });
  await installLocalEndpoint(
    { plan, confirmed: true },
    {
      env,
      runProcess,
      randomBytes: () => Buffer.alloc(32, 7),
      isPortAvailable: async () => true,
      fetchImpl,
      verifyCodexCapability,
    },
  );
  const installDirectory = await resolveLocalInstallRoot({
    target: "codex-chatgpt",
    env,
  });
  const expectedAclCalls = expectedWindowsManagedEndpointAclCalls(
    relmioHome,
    installDirectory,
  );

  function operationBoundaries() {
    const aclCalls = [];
    const events = [];
    return {
      aclCalls,
      events,
      async lockDownPath(path, options) {
        aclCalls.push({ path, options });
        events.push({ kind: "acl", path, options });
      },
      async operationRunner(spec) {
        events.push({ kind: "docker", spec });
        return runProcess(spec);
      },
    };
  }

  const preparedBoundaries = operationBoundaries();
  const staged = await prepareLocalClientCredentialRotation(
    { target: "codex-chatgpt" },
    {
      env,
      platform: "win32",
      runProcess: preparedBoundaries.operationRunner,
      randomBytes: () => Buffer.alloc(32, 9),
      lockDownPath: preparedBoundaries.lockDownPath,
    },
  );
  assert.deepEqual(preparedBoundaries.aclCalls, expectedAclCalls);
  assert.deepEqual(
    preparedBoundaries.events.slice(0, expectedAclCalls.length),
    expectedAclCalls.map((call) => ({ kind: "acl", ...call })),
  );

  const activationBoundaries = operationBoundaries();
  const activated = await activateLocalClientCredentialRotation(staged, {
    env,
    platform: "win32",
    runProcess: activationBoundaries.operationRunner,
    fetchImpl,
    verifyCodexCapability,
    lockDownPath: activationBoundaries.lockDownPath,
  });
  assert.equal(activated.deploymentMode, "updated");
  assert.deepEqual(
    activationBoundaries.aclCalls,
    [...expectedAclCalls, ...expectedAclCalls],
  );
  const activationMutationIndex = activationBoundaries.events.findIndex(
    (event) => event.kind === "docker" && isManagedEndpointComposeMutation(event.spec),
  );
  assert.ok(activationMutationIndex >= expectedAclCalls.length);
  assert.deepEqual(
    activationBoundaries.events.slice(0, expectedAclCalls.length),
    expectedAclCalls.map((call) => ({ kind: "acl", ...call })),
  );

  const restartBoundaries = operationBoundaries();
  await restartLocalCodex(
    { installDirectory },
    {
      changeLockHeld: true,
      platform: "win32",
      runProcess: restartBoundaries.operationRunner,
      lockDownPath: restartBoundaries.lockDownPath,
    },
  );
  assert.deepEqual(restartBoundaries.aclCalls, expectedAclCalls);
  const restartMutationIndex = restartBoundaries.events.findIndex(
    (event) => event.kind === "docker" && isManagedEndpointComposeMutation(event.spec),
  );
  assert.ok(restartMutationIndex >= expectedAclCalls.length);
  assert.deepEqual(
    restartBoundaries.events.slice(0, expectedAclCalls.length),
    expectedAclCalls.map((call) => ({ kind: "acl", ...call })),
  );
});

test("Windows managed ACL drift blocks Codex restart and rotation before Docker mutation", async (t) => {
  const home = await createTestHome(t);
  const relmioHome = join(home, ".relmio");
  const env = { RELMIO_HOME: relmioHome };
  const runProcess = createRunner({ publishedPort: 14500 });
  const fetchImpl = createFetch();
  const verifyCodexCapability = createCodexCapabilityVerifier();
  const plan = createLocalDeploymentPlan({ target: "codex-chatgpt", port: 14500 });
  await installLocalEndpoint(
    { plan, confirmed: true },
    {
      env,
      runProcess,
      randomBytes: () => Buffer.alloc(32, 7),
      isPortAvailable: async () => true,
      fetchImpl,
      verifyCodexCapability,
    },
  );
  const installDirectory = await resolveLocalInstallRoot({
    target: "codex-chatgpt",
    env,
  });
  const expectedAclCalls = expectedWindowsManagedEndpointAclCalls(
    relmioHome,
    installDirectory,
  );
  const composePath = join(installDirectory, "docker-compose.yml");
  const originalCompose = await readFile(composePath, "utf8");
  const staged = await prepareLocalClientCredentialRotation(
    { target: "codex-chatgpt" },
    {
      env,
      runProcess,
      randomBytes: () => Buffer.alloc(32, 9),
    },
  );

  async function rejectsAclDrift(operation) {
    const aclCalls = [];
    runProcess.calls.length = 0;
    await assert.rejects(
      operation(async (path, options) => {
        aclCalls.push({ path, options });
        if (path === composePath) {
          throw new Error("fixture managed ACL drift");
        }
      }),
      /fixture managed ACL drift/u,
    );
    assert.deepEqual(aclCalls, expectedAclCalls);
    assert.equal(runProcess.calls.some(isManagedEndpointComposeMutation), false);
  }

  await rejectsAclDrift((lockDownPath) =>
    restartLocalCodex(
      { installDirectory },
      {
        changeLockHeld: true,
        platform: "win32",
        runProcess,
        lockDownPath,
      },
    ),
  );
  await rejectsAclDrift((lockDownPath) =>
    activateLocalClientCredentialRotation(staged, {
      env,
      platform: "win32",
      runProcess,
      fetchImpl,
      verifyCodexCapability,
      lockDownPath,
    }),
  );
  assert.equal(await readFile(composePath, "utf8"), originalCompose);
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
        isProcessAlive: (candidateProcessId) => candidateProcessId !== 39_999,
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

test("Grok Build install packages its direct OAuth runtime dependencies and verifies its local bearer", async (t) => {
  const home = await createTestHome(t);
  const runProcess = createRunner({ publishedPort: 14502 });
  const fetchImpl = createFetch();
  const env = { RELMIO_HOME: join(home, ".relmio") };
  const plan = createLocalDeploymentPlan({ target: "xai-grok-build" });
  const result = await installLocalEndpoint({ plan, confirmed: true }, {
    env, runProcess, randomBytes: () => Buffer.alloc(32, 7), isPortAvailable: async () => true,
    readGrokBuildSource: async () => "export const runtimeFixture = true;\n",
    readGrokBuildChatSource: async () => "export const chatFixture = true;\n",
    readGrokBuildSessionSource: async () => "export const sessionFixture = true;\n",
    fetchImpl,
  });
  assert.equal(result.target, "xai-grok-build");
  assert.equal(result.endpoint, "http://127.0.0.1:14502");
  assert.equal(result.experimental, true);
  assert.deepEqual(fetchImpl.calls.map(({ url }) => url), [
    "http://127.0.0.1:14502/health", "http://127.0.0.1:14502/auth/verify",
  ]);
  const installRoot = await resolveLocalInstallRoot({ target: "xai-grok-build", env });
  assert.equal(await readFile(join(installRoot, "gateway.js"), "utf8"), "export const runtimeFixture = true;\n");
  assert.equal(await readFile(join(installRoot, "chat.js"), "utf8"), "export const chatFixture = true;\n");
  assert.equal(await readFile(join(installRoot, "session.js"), "utf8"), "export const sessionFixture = true;\n");
  assert.equal((await stat(join(installRoot, "gateway.js"))).mode & 0o777, 0o600);
  assert.equal((await stat(join(installRoot, "chat.js"))).mode & 0o777, 0o600);
  assert.equal((await stat(join(installRoot, "session.js"))).mode & 0o777, 0o600);
  const compose = await readFile(join(installRoot, "docker-compose.yml"), "utf8");
  assert.match(compose, /127\.0\.0\.1:14502:14502/);
  assert.match(compose, /grok-home:\/home\/node\/\.grok/);
  assert.doesNotMatch(compose, /xai_api_key|codex|workspace|n8n/i);
  const grokVerification = runProcess.calls.find(({ args }) => args.join(" ").endsWith("grok-build --version"));
  assert.ok(grokVerification);
  assert.deepEqual(grokVerification.args.slice(-9), [
    "run", "--rm", "--no-deps", "--pull", "never", "--entrypoint", "grok", "grok-build", "--version",
  ]);
});

test("Grok Build attestation refuses a tampered Compose or packaged runtime before a login can launch", async (t) => {
  const home = await createTestHome(t);
  const runProcess = createRunner({ publishedPort: 14502 });
  const env = { RELMIO_HOME: join(home, ".relmio") };
  const sources = {
    readGrokBuildSource: async () => "export const runtimeFixture = true;\n",
    readGrokBuildChatSource: async () => "export const chatFixture = true;\n",
    readGrokBuildSessionSource: async () => "export const sessionFixture = true;\n",
  };
  await installLocalEndpoint({ plan: createLocalDeploymentPlan({ target: "xai-grok-build" }), confirmed: true }, {
    env, runProcess, randomBytes: () => Buffer.alloc(32, 7), isPortAvailable: async () => true,
    ...sources, fetchImpl: createFetch(),
  });
  const installRoot = await resolveLocalInstallRoot({ target: "xai-grok-build", env });
  await attestLocalGrokBuild({ installDirectory: installRoot }, { runProcess, ...sources });
  await writeFile(join(installRoot, "docker-compose.yml"), "services: { attacker: {} }\n");
  const callsBeforeCompose = runProcess.calls.length;
  await assert.rejects(
    () => attestLocalGrokBuild({ installDirectory: installRoot }, { runProcess, ...sources }),
    /managed Grok Build files changed/u,
  );
  assert.equal(runProcess.calls.length, callsBeforeCompose);
  const marker = JSON.parse(await readFile(join(installRoot, ".managed-by-relmio.json"), "utf8"));
  await writeFile(
    join(installRoot, "docker-compose.yml"),
    createGrokBuildComposeFile({
      port: marker.port,
      tokenSha256: marker.tokenSha256,
      installId: marker.installId,
    }),
  );
  await writeFile(join(installRoot, "Dockerfile"), "FROM attacker\n");
  const callsBeforeDockerfile = runProcess.calls.length;
  await assert.rejects(
    () => attestLocalGrokBuild({ installDirectory: installRoot }, { runProcess, ...sources }),
    /managed Grok Build files changed/u,
  );
  assert.equal(runProcess.calls.length, callsBeforeDockerfile);
  await writeFile(join(installRoot, "Dockerfile"), createGrokBuildDockerfile());
  await writeFile(join(installRoot, "gateway.js"), "export const attacker = true;\n");
  const callsBeforeRuntime = runProcess.calls.length;
  await assert.rejects(
    () => attestLocalGrokBuild({ installDirectory: installRoot }, { runProcess, ...sources }),
    /managed Grok Build files changed/u,
  );
  assert.equal(runProcess.calls.length, callsBeforeRuntime);
});

test("a legacy Grok Build installation blocks setup before changing files or its saved session", async (t) => {
  const home = await createTestHome(t);
  const runProcess = createRunner({ publishedPort: 14502 });
  const env = { RELMIO_HOME: join(home, ".relmio") };
  const sources = {
    readGrokBuildSource: async () => "export const runtimeFixture = true;\n",
    readGrokBuildChatSource: async () => "export const chatFixture = true;\n",
    readGrokBuildSessionSource: async () => "export const sessionFixture = true;\n",
  };
  const plan = createLocalDeploymentPlan({ target: "xai-grok-build" });
  await installLocalEndpoint({ plan, confirmed: true }, {
    env, runProcess, randomBytes: () => Buffer.alloc(32, 7), isPortAvailable: async () => true,
    ...sources, fetchImpl: createFetch(),
  });
  const installRoot = await resolveLocalInstallRoot({ target: "xai-grok-build", env });
  const markerPath = join(installRoot, ".managed-by-relmio.json");
  const legacyMarker = JSON.parse(await readFile(markerPath, "utf8"));
  delete legacyMarker.tokenSha256;
  await writeFile(markerPath, `${JSON.stringify(legacyMarker)}\n`);

  const callsBeforeLogin = runProcess.calls.length;
  await assert.rejects(
    () => attestLocalGrokBuild({ installDirectory: installRoot }, { runProcess, ...sources }),
    /verifier is missing/u,
  );
  assert.equal(runProcess.calls.length, callsBeforeLogin);

  const names = await readdir(installRoot);
  const before = await Promise.all(names.map((name) => readFile(join(installRoot, name))));
  const callsBeforeSetup = runProcess.calls.length;
  await assert.rejects(() => installLocalEndpoint({ plan, confirmed: true }, {
    env, runProcess, randomBytes: () => { throw new Error("must not rotate a credential"); },
    isPortAvailable: async () => true, ...sources, fetchImpl: createFetch(),
  }), /legacy Grok installation requires a separately reviewed migration/u);
  assert.equal(runProcess.calls.length, callsBeforeSetup, "must not inspect, mount, replace or remove the existing Docker session volume");
  assert.deepEqual(await readdir(installRoot), names);
  assert.deepEqual(await Promise.all(names.map((name) => readFile(join(installRoot, name)))), before);
});

test("Grok Build install rolls back when its exact managed CLI cannot be attested", async (t) => {
  const home = await createTestHome(t);
  const runProcess = createRunner({ publishedPort: 14502, grokVersion: "grok 1.0.12 (badc0ffee)\n" });
  await assert.rejects(() => installLocalEndpoint({ plan: createLocalDeploymentPlan({ target: "xai-grok-build" }), confirmed: true }, {
    env: { RELMIO_HOME: join(home, ".relmio") }, runProcess,
    randomBytes: () => Buffer.alloc(32, 7), isPortAvailable: async () => true,
    readGrokBuildSource: async () => "export const fixture = true;\n",
    readGrokBuildChatSource: async () => "export const chat = true;\n",
    readGrokBuildSessionSource: async () => "export const session = true;\n",
    fetchImpl: createFetch(),
  }), /CLI version/u);
  assert.ok(runProcess.calls.some(({ args }) => args.includes("rm") && args.includes("grok-build")));
});

test("Grok Build install rejects an invalid packaged direct OAuth dependency before build or deployment", async (t) => {
  const home = await createTestHome(t);
  const processCalls = [];
  await assert.rejects(
    () => installLocalEndpoint({
      plan: createLocalDeploymentPlan({ target: "xai-grok-build" }),
      confirmed: true,
    }, {
      env: { RELMIO_HOME: join(home, ".relmio") },
      runProcess: async (spec) => {
        processCalls.push(spec);
        return createRunner()(spec);
      },
      randomBytes: () => Buffer.alloc(32, 7),
      isPortAvailable: async () => true,
      readGrokBuildSource: async () => "export const runtime = true;\n",
      readGrokBuildChatSource: async () => "",
      readGrokBuildSessionSource: async () => "export const session = true;\n",
      fetchImpl: createFetch(),
    }),
    /packaged Grok Build runtime is invalid/u,
  );
  assert.ok(processCalls.length > 0, "read-only Docker ownership checks may precede packaged-source validation");
  assert.ok(
    processCalls.every(({ args }) => !args.includes("build") && !args.includes("up")),
    "invalid sources must prevent build and deployment",
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

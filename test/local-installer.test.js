import assert from "node:assert/strict";
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createLocalDeploymentPlan } from "../src/domain/local-endpoints.js";
import {
  attestLocalCodexInstallation,
  getLocalDockerStatus,
  installLocalEndpoint,
  restartLocalCodex,
  resolveLocalInstallRoot,
} from "../src/services/local-installer.js";

const platformKey = `sk-${"p".repeat(48)}`;
const rotatedPlatformKey = `sk-${"q".repeat(48)}`;
const capability = Buffer.alloc(32, 7).toString("base64url");

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
  contextHost = "unix:///var/run/docker.sock",
  foreignOwnership = false,
  publisherHost = "127.0.0.1",
  publishedPort = 12435,
} = {}) {
  const calls = [];
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
    if (args === "version --format {{.Server.Version}}") {
      return { stdout: "27.1.1\n", stderr: "", code: 0 };
    }
    if (args === "compose version --short") {
      return { stdout: "2.29.2\n", stderr: "", code: 0 };
    }
    if (args.includes("ps --status running --services")) {
      return {
        stdout: args.includes("relmio-openai-api") ? "gateway\n" : "codex\n",
        stderr: "",
        code: 0,
      };
    }
    if (args.includes("ps --format json")) {
      const targetPort = args.includes("relmio-openai-api") ? 10_531 : 4_500;
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
    if (args.includes("rm --force --stop")) {
      return { stdout: "", stderr: "", code: cleanupCode };
    }
    if (args.includes("ps --all --services")) {
      return {
        stdout: cleanupStillRunning ? "gateway\n" : "",
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

test("local Docker discovery is read-only and sanitizes versions", async () => {
  const runProcess = createRunner();
  const result = await getLocalDockerStatus({ runProcess, cwd: "/tmp" });

  assert.deepEqual(result, {
    dockerAvailable: true,
    dockerVersion: "27.1.1",
    composeVersion: "2.29.2",
    dockerHost: "unix:///var/run/docker.sock",
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
      { file: "docker", args: ["version", "--format", "{{.Server.Version}}"] },
      { file: "docker", args: ["compose", "version", "--short"] },
    ],
  );
});

test("local Docker discovery rejects remote contexts, overrides, and native Windows", async () => {
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
      runProcess: createRunner(),
      cwd: "/tmp",
      env: {},
      platform: "win32",
    }),
    { dockerAvailable: false, unsupportedPlatform: true },
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
      dockerHost === "unix:///var/run/docker.sock",
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
  assert.equal((await stat(installRoot)).mode & 0o777, 0o700);
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
      dockerHost: "unix:///var/run/docker.sock",
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
          dockerHost === "unix:///var/run/docker.sock",
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
  const plan = createLocalDeploymentPlan({ target: "codex-chatgpt", port: 14500 });

  const result = await installLocalEndpoint(
    { plan, confirmed: true },
    {
      env: { RELMIO_HOME: join(home, ".relmio") },
      runProcess,
      randomBytes: () => Buffer.alloc(32, 7),
      isPortAvailable: async () => true,
      fetchImpl: createFetch(),
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
  assert.equal((await stat(join(installRoot, "requirements.toml"))).mode & 0o777, 0o600);
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
  assert.equal((await stat(stateRoot)).mode & 0o777, 0o755);

  await rm(targetRoot, { recursive: true });
  await writeFile(
    join(stateRoot, ".managed-by-relmio-root.json"),
    `${JSON.stringify({ schemaVersion: 1, kind: "relmio-local-root" })}\n`,
  );
  const outside = join(home, "outside");
  await mkdir(outside);
  await symlink(outside, targetRoot);
  await assert.rejects(
    () =>
      installLocalEndpoint(
        { plan, apiKey: platformKey, confirmed: true },
        { env: { RELMIO_HOME: stateRoot }, runProcess: createRunner() },
      ),
    /symbolic link|symlink/i,
  );
});

test("managed marker files themselves cannot be symbolic links", async (t) => {
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
      dockerHost: "unix:///var/run/docker.sock",
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

test("installer rejects unsafe managed bases, ancestor symlinks, and native Windows", async (t) => {
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
          env: { RELMIO_HOME: join(home, ".relmio") },
          platform: "win32",
        },
      ),
    /not supported.*Windows/i,
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
  await symlink(realParent, linkedParent);
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

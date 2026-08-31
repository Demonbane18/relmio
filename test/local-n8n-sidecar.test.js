import assert from "node:assert/strict";
import * as nodeFileSystem from "node:fs/promises";
import { mkdtemp, mkdir, readFile, realpath, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  LOCAL_N8N_SIDECAR_TARGET,
  createLocalN8nSidecarComposeFile,
  createLocalN8nSidecarDockerfile,
  createLocalN8nSidecarPlan,
  normalizeLocalN8nSidecarPlan,
} from "../src/domain/local-n8n-sidecar.js";
import {
  discoverLocalN8nSidecarTargets,
  installLocalN8nSidecar,
  removeLocalN8nSidecar,
  resolveLocalN8nSidecarInstallRoot,
} from "../src/services/local-n8n-sidecar-installer.js";

const DOCKER_HOST = "unix:///var/run/docker.sock";
const N8N_ID = "a".repeat(64);
const NETWORK_ID = "b".repeat(64);
const SIDECAR_ID = "c".repeat(64);
const AUTH_GENERATION = "2026-08-31T04:05:06.000Z";
const AUTH_CONTENTS = Buffer.from(JSON.stringify({ access_token: "fixture-secret" }));

function createPlan(overrides = {}) {
  return createLocalN8nSidecarPlan({
    dockerHost: DOCKER_HOST,
    n8nContainerId: N8N_ID,
    n8nContainerName: "relmio-test-n8n",
    dockerNetworkId: NETWORK_ID,
    networkName: "relmio-test-assistant-shared",
    authGeneration: AUTH_GENERATION,
    ...overrides,
  });
}

function n8nInspect(
  overrides = {},
  image = "docker.n8n.io/n8nio/n8n:2.36.8",
) {
  return {
    Id: N8N_ID,
    Name: "/relmio-test-n8n",
    Config: {
      Image: image,
      Labels: { "com.docker.compose.project": "relmio-test" },
    },
    State: { Running: true },
    NetworkSettings: {
      Networks: {
        "relmio-test-assistant-shared": {
          NetworkID: NETWORK_ID,
          Aliases: ["relmio-test-n8n", "n8n"],
        },
      },
    },
    ...overrides,
  };
}

function networkInspect(overrides = {}) {
  return {
    Id: NETWORK_ID,
    Name: "relmio-test-assistant-shared",
    Driver: "bridge",
    Scope: "local",
    Labels: { "com.relmio.disposable": "true" },
    Containers: {
      [N8N_ID]: { Name: "relmio-test-n8n" },
    },
    ...overrides,
  };
}

function sidecarInspect(projectName, installId, overrides = {}) {
  return {
    Id: SIDECAR_ID,
    Name: `/${projectName}-openai-oauth-1`,
    Config: {
      Image: `${projectName}:local`,
      Labels: {
        "com.docker.compose.project": projectName,
        "com.docker.compose.service": "openai-oauth",
        "io.relmio.managed": "true",
        "io.relmio.target": LOCAL_N8N_SIDECAR_TARGET,
        "io.relmio.install": installId,
      },
    },
    State: { Running: true },
    NetworkSettings: {
      Networks: {
        "relmio-test-assistant-shared": {
          NetworkID: NETWORK_ID,
          Aliases: ["n8n-openai-oauth"],
        },
      },
      Ports: { "10531/tcp": null },
    },
    ...overrides,
  };
}

async function createTestHome(t) {
  const root = await mkdtemp(join(tmpdir(), "relmio-n8n-sidecar-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return realpath(root);
}

async function createAuthFixture(homeDirectory) {
  const authDirectory = join(homeDirectory, ".n8n-openai-oauth");
  const authPath = join(authDirectory, "auth.json");
  await mkdir(authDirectory, { recursive: true, mode: 0o700 });
  await writeFile(authPath, AUTH_CONTENTS, { mode: 0o600 });
  await (await import("node:fs/promises")).utimes(
    authPath,
    new Date(AUTH_GENERATION),
    new Date(AUTH_GENERATION),
  );
  return authPath;
}

function createRunner({
  aliasCollision = false,
  nameCollision = false,
  n8nDrift = false,
  networkDrift = false,
  published = false,
  verifierCode = 0,
  verifierOutput = JSON.stringify({ data: [{ id: "gpt-5.6-terra" }] }),
  ownedResources = true,
  imageListFailure = false,
  n8nImage = "docker.n8n.io/n8nio/n8n:2.36.8",
} = {}) {
  const calls = [];
  const installId = "d".repeat(32);
  const projectName = `relmio-n8n-openai-oauth-${installId}`;
  let installed = false;
  let removed = false;
  const foreignId = "e".repeat(64);
  const runner = async (spec) => {
    calls.push(spec);
    const args = spec.args;
    const joined = args.join(" ");
    if (joined === "context inspect --format {{json .Endpoints.docker.Host}}") {
      return { stdout: `${JSON.stringify(DOCKER_HOST)}\n`, stderr: "", code: 0 };
    }
    if (joined === "version --format {{.Server.Version}}") {
      return { stdout: "27.1.1\n", stderr: "", code: 0 };
    }
    if (joined === "compose version --short") {
      return { stdout: "2.29.2\n", stderr: "", code: 0 };
    }
    if (joined === "ps --filter status=running --format {{json .}}") {
      return {
        stdout: `${JSON.stringify({
          ID: N8N_ID.slice(0, 12),
          Image: n8nImage,
          Names: "relmio-test-n8n",
        })}\n${JSON.stringify({
          ID: "f".repeat(12),
          Image: "attacker/n8n:latest",
          Names: "not-official",
        })}\n`,
        stderr: "",
        code: 0,
      };
    }
    if (
      args[0] === "container" &&
      args[1] === "inspect" &&
      args.at(-1) === N8N_ID
    ) {
      const inspected = n8nInspect(
        n8nDrift ? { Id: "9".repeat(64) } : {},
        n8nImage,
      );
      return { stdout: `${JSON.stringify(inspected)}\n`, stderr: "", code: 0 };
    }
    if (
      args[0] === "container" &&
      args[1] === "inspect" &&
      args.at(-1) === N8N_ID.slice(0, 12)
    ) {
      return {
        stdout: `${JSON.stringify(n8nInspect({}, n8nImage))}\n`,
        stderr: "",
        code: 0,
      };
    }
    if (
      args[0] === "network" &&
      args[1] === "inspect" &&
      args.at(-1) === "relmio-test-assistant-shared"
    ) {
      const containers = aliasCollision || nameCollision
        ? {
            [N8N_ID]: { Name: "relmio-test-n8n" },
            [foreignId]: {
              Name: nameCollision ? "n8n-openai-oauth" : "foreign",
            },
          }
        : installed && !removed
          ? {
              [N8N_ID]: { Name: "relmio-test-n8n" },
              [SIDECAR_ID]: { Name: `${projectName}-openai-oauth-1` },
            }
          : { [N8N_ID]: { Name: "relmio-test-n8n" } };
      return {
        stdout: `${JSON.stringify(
          networkInspect({
            ...(networkDrift ? { Id: "8".repeat(64) } : {}),
            Containers: containers,
          }),
        )}\n`,
        stderr: "",
        code: 0,
      };
    }
    if (
      args[0] === "container" &&
      args[1] === "inspect" &&
      args.at(-1) === foreignId
    ) {
      return {
        stdout: `${JSON.stringify({
          Id: foreignId,
          Name: nameCollision ? "/n8n-openai-oauth" : "/foreign",
          Config: { Image: "example/foreign:latest", Labels: {} },
          State: { Running: true },
          NetworkSettings: {
            Networks: {
              "relmio-test-assistant-shared": {
                NetworkID: NETWORK_ID,
                Aliases: aliasCollision ? ["n8n-openai-oauth"] : ["foreign"],
              },
            },
          },
        })}\n`,
        stderr: "",
        code: 0,
      };
    }
    if (
      args[0] === "container" &&
      args[1] === "inspect" &&
      args.at(-1) === SIDECAR_ID
    ) {
      const inspected = sidecarInspect(projectName, installId);
      if (!ownedResources) {
        inspected.Config.Labels = {
          "com.docker.compose.project": projectName,
        };
      }
      return {
        stdout: `${JSON.stringify(inspected)}\n`,
        stderr: "",
        code: 0,
      };
    }
    if (joined.includes("ps -q openai-oauth")) {
      return {
        stdout: installed && !removed ? `${SIDECAR_ID}\n` : "",
        stderr: "",
        code: 0,
      };
    }
    if (joined.includes("ps --status running --services openai-oauth")) {
      return {
        stdout: installed && !removed ? "openai-oauth\n" : "",
        stderr: "",
        code: 0,
      };
    }
    if (joined.includes("ps --format json openai-oauth")) {
      return {
        stdout: JSON.stringify({
          Publishers: published
            ? [
                {
                  URL: "0.0.0.0",
                  TargetPort: 10531,
                  PublishedPort: 10531,
                  Protocol: "tcp",
                },
              ]
            : [
                {
                  URL: "",
                  TargetPort: 10531,
                  PublishedPort: 0,
                  Protocol: "tcp",
                },
              ],
        }),
        stderr: "",
        code: 0,
      };
    }
    if (args[0] === "ps" && args.includes(`label=com.docker.compose.project=${projectName}`)) {
      return {
        stdout:
          installed && !removed
            ? `${JSON.stringify({
                ID: SIDECAR_ID,
                Labels: ownedResources
                  ? `com.docker.compose.project=${projectName},com.docker.compose.service=openai-oauth,io.relmio.managed=true,io.relmio.target=${LOCAL_N8N_SIDECAR_TARGET},io.relmio.install=${installId}`
                  : `com.docker.compose.project=${projectName}`,
              })}\n`
            : "",
        stderr: "",
        code: 0,
      };
    }
    if (args[0] === "volume" && args[1] === "ls") {
      return {
        stdout:
          installed && !removed
            ? `${JSON.stringify({
                Name: `${projectName}_oauth-auth`,
                Labels: ownedResources
                  ? `com.docker.compose.project=${projectName},io.relmio.managed=true,io.relmio.target=${LOCAL_N8N_SIDECAR_TARGET},io.relmio.install=${installId}`
                  : `com.docker.compose.project=${projectName}`,
              })}\n`
            : "",
        stderr: "",
        code: 0,
      };
    }
    if (args[0] === "volume" && args[1] === "inspect") {
      return {
        stdout: `${JSON.stringify(
          ownedResources
            ? {
                "com.docker.compose.project": projectName,
                "io.relmio.managed": "true",
                "io.relmio.target": LOCAL_N8N_SIDECAR_TARGET,
                "io.relmio.install": installId,
              }
            : { "com.docker.compose.project": projectName },
        )}\n`,
        stderr: "",
        code: 0,
      };
    }
    if (args[0] === "image" && args[1] === "inspect") {
      return { stdout: "", stderr: "not found", code: 1 };
    }
    if (args[0] === "image" && args[1] === "ls") {
      return imageListFailure
        ? { stdout: "", stderr: "permission denied", code: 125 }
        : { stdout: "", stderr: "", code: 0 };
    }
    if (joined.includes("up -d --wait")) {
      installed = true;
      removed = false;
      return { stdout: "", stderr: "", code: 0 };
    }
    if (
      args.includes("run") &&
      args.includes("--entrypoint") &&
      args.includes("node") &&
      args.includes("-e")
    ) {
      return { stdout: verifierOutput, stderr: "", code: verifierCode };
    }
    if (joined.includes("down --volumes --remove-orphans")) {
      installed = false;
      removed = true;
      return { stdout: "", stderr: "", code: 0 };
    }
    return { stdout: "", stderr: "", code: 0 };
  };
  runner.calls = calls;
  runner.projectName = projectName;
  runner.installId = installId;
  return runner;
}

test("the sidecar plan binds exact Docker identities and contains no credential", () => {
  const plan = createPlan();

  assert.deepEqual(plan, {
    kind: "n8n-sidecar",
    target: "n8n-openai-oauth",
    label: "Self-hosted n8n bridge",
    endpoint: "http://n8n-openai-oauth:10531/v1",
    baseUrl: "http://n8n-openai-oauth:10531/v1",
    protocol: "openai-v1",
    upstreamAuth: "chatgpt-oauth",
    dockerHost: DOCKER_HOST,
    n8nContainerId: N8N_ID,
    n8nContainerName: "relmio-test-n8n",
    dockerNetworkId: NETWORK_ID,
    networkName: "relmio-test-assistant-shared",
    authGeneration: AUTH_GENERATION,
    managedPath: "~/.relmio/local/n8n-openai-oauth",
    hostPublication: "none",
    unofficial: true,
  });
  assert.equal(JSON.stringify(plan).includes("fixture-secret"), false);
});

test("sidecar plan validation rejects injection and identity drift", () => {
  for (const overrides of [
    { dockerHost: "tcp://attacker.test:2375" },
    { n8nContainerId: `${N8N_ID}\n--force` },
    { n8nContainerName: "--name" },
    { dockerNetworkId: "not-an-id" },
    { networkName: "network\n--privileged" },
    { authGeneration: "yesterday" },
  ]) {
    assert.throws(() => createPlan(overrides), /invalid|Unix socket|generation/iu);
  }
  assert.throws(
    () => normalizeLocalN8nSidecarPlan({ ...createPlan(), endpoint: "http://evil.test/v1" }),
    /plan/iu,
  );
});

test("generated sidecar artifacts pin openai-oauth and never publish a host port", () => {
  const dockerfile = createLocalN8nSidecarDockerfile({ installId: "d".repeat(32) });
  const compose = createLocalN8nSidecarComposeFile({
    installId: "d".repeat(32),
    networkName: "relmio-test-assistant-shared",
  });

  assert.match(dockerfile, /openai-oauth@2\.0\.0/u);
  assert.match(dockerfile, /USER node/u);
  assert.match(compose, /expose:\n\s+- "10531"/u);
  assert.doesNotMatch(compose, /\n\s+ports:/u);
  assert.match(compose, /aliases:\n\s+- n8n-openai-oauth/u);
  assert.match(compose, /external: true/u);
  assert.match(compose, /network_mode: none/u);
  assert.match(compose, /logging:\n\s+driver: "none"/u);
  assert.match(compose, /oauth-auth:\/home\/node\/\.codex\n/u);
  assert.doesNotMatch(compose, /oauth-auth:\/home\/node\/\.codex:ro/u);
  assert.match(compose, /cat > \/run\/relmio-auth\/\.auth\.json\.next/u);
  assert.match(compose, /chown 0:0 \/run\/relmio-auth/u);
  assert.match(compose, /chmod 0600 \/run\/relmio-auth\/\.auth\.json\.next/u);
  assert.match(compose, /chown 1000:1000 \/run\/relmio-auth\n/u);
  assert.ok(
    compose.indexOf("chown 0:0 /run/relmio-auth") <
      compose.indexOf("cat > /run/relmio-auth/.auth.json.next"),
  );
  assert.ok(
    compose.indexOf("mv -f -- /run/relmio-auth/.auth.json.next") <
      compose.lastIndexOf("chown 1000:1000 /run/relmio-auth"),
  );
  assert.match(compose, /chown 1000:1000/u);
  assert.doesNotMatch(compose, /fixture-secret|access_token/u);
});

test("discovery returns only running official n8n containers on local bridge networks", async () => {
  const runner = createRunner();
  const result = await discoverLocalN8nSidecarTargets({
    runProcess: runner,
    cwd: "/private/tmp",
    env: {},
    platform: "linux",
  });

  assert.equal(result.dockerAvailable, true);
  assert.equal(result.dockerHost, DOCKER_HOST);
  assert.deepEqual(result.containers, [
    {
      containerId: N8N_ID,
      containerName: "relmio-test-n8n",
      image: "docker.n8n.io/n8nio/n8n:2.36.8",
      networks: [
        {
          dockerNetworkId: NETWORK_ID,
          networkName: "relmio-test-assistant-shared",
          disposable: true,
        },
      ],
    },
  ]);
  assert.ok(runner.calls.every((call) => call.file === "docker"));
  assert.ok(runner.calls.every((call) => call.shell === undefined));
});

test("discovery accepts Docker Desktop's official docker.io n8n image name", async () => {
  const image =
    "docker.io/n8nio/n8n:2.36.8@sha256:" + "c".repeat(64);
  const runner = createRunner({ n8nImage: image });

  const result = await discoverLocalN8nSidecarTargets({
    runProcess: runner,
    cwd: "/private/tmp",
    env: {},
    platform: "linux",
  });

  assert.equal(result.containers.length, 1);
  assert.equal(result.containers[0].image, image);
});

test("discovery rejects Docker selector environment overrides before running Docker", async () => {
  const runner = createRunner();
  await assert.rejects(
    () =>
      discoverLocalN8nSidecarTargets({
        runProcess: runner,
        cwd: "/private/tmp",
        env: { docker_host: DOCKER_HOST },
        platform: "linux",
      }),
    /environment override|selected Docker context/iu,
  );
  assert.deepEqual(runner.calls, []);
});

test("local n8n sidecar install root stays inside the managed Relmio root", async (t) => {
  const homeDirectory = await createTestHome(t);
  assert.equal(
    await resolveLocalN8nSidecarInstallRoot({ homeDirectory, env: {} }),
    join(homeDirectory, ".relmio", "local", "n8n-openai-oauth"),
  );
  await assert.rejects(
    () =>
      resolveLocalN8nSidecarInstallRoot({
        homeDirectory,
        env: { RELMIO_HOME: join(homeDirectory, "unsafe") },
      }),
    /storage path/iu,
  );
});

test("installation requires confirmation before reading auth or invoking Docker", async () => {
  const runner = createRunner();
  await assert.rejects(
    () => installLocalN8nSidecar({ plan: createPlan(), confirmed: false }, { runProcess: runner }),
    /confirm/iu,
  );
  assert.deepEqual(runner.calls, []);
});

test("installation rejects missing, invalid, permissive, and drifted OAuth credentials", async (t) => {
  const homeDirectory = await createTestHome(t);
  const runner = createRunner();
  const authPath = join(homeDirectory, ".n8n-openai-oauth", "auth.json");

  await assert.rejects(
    () =>
      installLocalN8nSidecar(
        { plan: createPlan(), authPath, confirmed: true },
        { homeDirectory, env: {}, runProcess: runner, randomBytes: () => Buffer.alloc(32, 0xdd) },
      ),
    /OAuth credential/iu,
  );
  assert.deepEqual(runner.calls, []);

  await mkdir(join(homeDirectory, ".n8n-openai-oauth"), { recursive: true });
  await writeFile(authPath, "not-json", { mode: 0o600 });
  const invalidGeneration = (await stat(authPath)).mtime.toISOString();
  await assert.rejects(
    () =>
      installLocalN8nSidecar(
        {
          plan: createPlan({ authGeneration: invalidGeneration }),
          authPath,
          confirmed: true,
        },
        { homeDirectory, env: {}, runProcess: runner, randomBytes: () => Buffer.alloc(32, 0xdd) },
      ),
    /OAuth credential/iu,
  );

  await writeFile(authPath, AUTH_CONTENTS, { mode: 0o644 });
  await (await import("node:fs/promises")).chmod(authPath, 0o644);
  const permissiveGeneration = (await stat(authPath)).mtime.toISOString();
  await assert.rejects(
    () =>
      installLocalN8nSidecar(
        { plan: createPlan({ authGeneration: permissiveGeneration }), authPath, confirmed: true },
        { homeDirectory, env: {}, runProcess: runner, randomBytes: () => Buffer.alloc(32, 0xdd) },
      ),
    /permissions/iu,
  );

  await (await import("node:fs/promises")).chmod(authPath, 0o600);
  await assert.rejects(
    () =>
      installLocalN8nSidecar(
        { plan: createPlan({ authGeneration: "2025-01-01T00:00:00.000Z" }), authPath, confirmed: true },
        { homeDirectory, env: {}, runProcess: runner, randomBytes: () => Buffer.alloc(32, 0xdd) },
      ),
    /changed|fresh plan/iu,
  );
  assert.deepEqual(runner.calls, []);
});

test("installation seeds auth over stdin, starts only the sidecar, and returns sanitized proof", async (t) => {
  const homeDirectory = await createTestHome(t);
  const authPath = await createAuthFixture(homeDirectory);
  const runner = createRunner();

  const result = await installLocalN8nSidecar(
    { plan: createPlan(), authPath, confirmed: true },
    {
      homeDirectory,
      env: {},
      runProcess: runner,
      randomBytes: () => Buffer.alloc(32, 0xdd),
    },
  );

  assert.deepEqual(result, {
    target: "n8n-openai-oauth",
    endpoint: "http://n8n-openai-oauth:10531/v1",
    baseUrl: "http://n8n-openai-oauth:10531/v1",
    protocol: "openai-v1",
    apiKeyPlaceholder: "local-only",
    useResponsesApi: true,
    models: ["gpt-5.6-terra"],
    networkName: "relmio-test-assistant-shared",
    n8nContainerName: "relmio-test-n8n",
    hostPublication: "none",
    deploymentMode: "installed",
    unofficial: true,
  });
  const seed = runner.calls.find((call) => call.args.includes("credential-seed"));
  assert.deepEqual(seed.input, AUTH_CONTENTS);
  assert.ok(runner.calls.every((call) => !call.args.includes("--no-build")));
  assert.ok(
    runner.calls.every(
      (call) =>
        !call.args.some((argument) => /^(?:stop|restart|kill)$/u.test(argument)) &&
        !(call.args.includes("rm") && call.args.includes("relmio-test-n8n")),
    ),
  );
  assert.ok(
    runner.calls.every((call) =>
      call.args.every((argument) => !/[\r\n]/u.test(argument)),
    ),
  );
  assert.equal(JSON.stringify(runner.calls).includes("fixture-secret"), false);
  assert.deepEqual(await readFile(authPath), AUTH_CONTENTS);
  assert.equal((await stat(authPath)).mode & 0o777, 0o600);
});

test("an installed bridge must be removed before a fresh install", async (t) => {
  const homeDirectory = await createTestHome(t);
  const authPath = await createAuthFixture(homeDirectory);
  const runner = createRunner();
  const options = {
    homeDirectory,
    env: {},
    runProcess: runner,
    randomBytes: () => Buffer.alloc(32, 0xdd),
  };

  await installLocalN8nSidecar(
    { plan: createPlan(), authPath, confirmed: true },
    options,
  );
  const callCount = runner.calls.length;

  await assert.rejects(
    () =>
      installLocalN8nSidecar(
        { plan: createPlan(), authPath, confirmed: true },
        options,
      ),
    /already installed|Remove bridge/iu,
  );
  assert.equal(runner.calls.length, callCount);
  assert.deepEqual(await readFile(authPath), AUTH_CONTENTS);
});

test("installation re-reads the OAuth source immediately before Docker mutation", async (t) => {
  const homeDirectory = await createTestHome(t);
  const authPath = await createAuthFixture(homeDirectory);
  const runner = createRunner();
  let authReadCount = 0;
  const driftingFileSystem = {
    ...nodeFileSystem,
    async readFile(path, ...args) {
      if (path === authPath) {
        authReadCount += 1;
        return authReadCount === 1
          ? AUTH_CONTENTS
          : Buffer.from(JSON.stringify({ access_token: "changed-secret" }));
      }
      return nodeFileSystem.readFile(path, ...args);
    },
  };

  await assert.rejects(
    () =>
      installLocalN8nSidecar(
        { plan: createPlan(), authPath, confirmed: true },
        {
          fileSystem: driftingFileSystem,
          homeDirectory,
          env: {},
          runProcess: runner,
          randomBytes: () => Buffer.alloc(32, 0xdd),
        },
      ),
    /OAuth credential changed|fresh plan/iu,
  );
  assert.equal(authReadCount, 2);
  assert.equal(runner.calls.some((call) => call.args.includes("build")), false);
  assert.equal(JSON.stringify(runner.calls).includes("changed-secret"), false);
});

test("installation rejects n8n, network, and hostname drift before Docker mutation", async (t) => {
  for (const condition of ["n8n", "network", "alias", "name"]) {
    await t.test(condition, async () => {
      const homeDirectory = await createTestHome(t);
      const authPath = await createAuthFixture(homeDirectory);
      const runner = createRunner({
        n8nDrift: condition === "n8n",
        networkDrift: condition === "network",
        aliasCollision: condition === "alias",
        nameCollision: condition === "name",
      });
      await assert.rejects(
        () =>
          installLocalN8nSidecar(
            { plan: createPlan(), authPath, confirmed: true },
            {
              homeDirectory,
              env: {},
              runProcess: runner,
              randomBytes: () => Buffer.alloc(32, 0xdd),
            },
          ),
        /changed|collision|fresh plan/iu,
      );
      assert.equal(
        runner.calls.some((call) => call.args.includes("build")),
        false,
      );
    });
  }
});

test("image absence must be proved instead of inferred from a Docker failure", async (t) => {
  const homeDirectory = await createTestHome(t);
  const authPath = await createAuthFixture(homeDirectory);
  const runner = createRunner({ imageListFailure: true });

  await assert.rejects(
    () =>
      installLocalN8nSidecar(
        { plan: createPlan(), authPath, confirmed: true },
        {
          homeDirectory,
          env: {},
          runProcess: runner,
          randomBytes: () => Buffer.alloc(32, 0xdd),
        },
      ),
    /image existence check failed/iu,
  );
  assert.equal(runner.calls.some((call) => call.args.includes("build")), false);
});

test("a published host port fails closed and removes only the sidecar project", async (t) => {
  const homeDirectory = await createTestHome(t);
  const authPath = await createAuthFixture(homeDirectory);
  const runner = createRunner({ published: true });
  await assert.rejects(
    () =>
      installLocalN8nSidecar(
        { plan: createPlan(), authPath, confirmed: true },
        {
          homeDirectory,
          env: {},
          runProcess: runner,
          randomBytes: () => Buffer.alloc(32, 0xdd),
        },
      ),
    /published|host port|safety/iu,
  );
  const cleanup = runner.calls.find((call) => call.args.includes("down"));
  assert.ok(cleanup);
  assert.ok(cleanup.args.includes("--volumes"));
  assert.equal(cleanup.args.includes("relmio-test-n8n"), false);
  assert.equal(cleanup.args.includes("network"), false);
});

test("removal requires owned resources and deletes only the managed sidecar directory", async (t) => {
  const homeDirectory = await createTestHome(t);
  const authPath = await createAuthFixture(homeDirectory);
  const runner = createRunner();
  await installLocalN8nSidecar(
    { plan: createPlan(), authPath, confirmed: true },
    {
      homeDirectory,
      env: {},
      runProcess: runner,
      randomBytes: () => Buffer.alloc(32, 0xdd),
    },
  );
  const installRoot = await resolveLocalN8nSidecarInstallRoot({ homeDirectory, env: {} });

  const result = await removeLocalN8nSidecar(
    { confirmed: true },
    { homeDirectory, env: {}, runProcess: runner },
  );

  assert.deepEqual(result, { removed: true, target: LOCAL_N8N_SIDECAR_TARGET });
  await assert.rejects(() => stat(installRoot), /ENOENT/u);
  assert.deepEqual(await readFile(authPath), AUTH_CONTENTS);
  const removal = runner.calls.filter((call) => call.args.includes("down")).at(-1);
  assert.ok(removal.args.includes("--volumes"));
  assert.equal(removal.args.includes("relmio-test-n8n"), false);
  assert.equal(removal.args.includes("relmio-test-assistant-shared"), false);
});

test("removal refuses foreign Docker resources without mutating them", async (t) => {
  const homeDirectory = await createTestHome(t);
  const authPath = await createAuthFixture(homeDirectory);
  const installRunner = createRunner();
  await installLocalN8nSidecar(
    { plan: createPlan(), authPath, confirmed: true },
    {
      homeDirectory,
      env: {},
      runProcess: installRunner,
      randomBytes: () => Buffer.alloc(32, 0xdd),
    },
  );
  const foreignRunner = createRunner({ ownedResources: false });
  // Prime the fake runner's installed state using only its simulated sidecar start.
  await foreignRunner({
    file: "docker",
    args: ["compose", "up", "-d", "--wait"],
    cwd: "/private/tmp",
    dockerHost: DOCKER_HOST,
  });

  await assert.rejects(
    () =>
      removeLocalN8nSidecar(
        { confirmed: true },
        { homeDirectory, env: {}, runProcess: foreignRunner },
      ),
    /ownership|matching ownership/iu,
  );
  assert.equal(foreignRunner.calls.some((call) => call.args.includes("down")), false);
});

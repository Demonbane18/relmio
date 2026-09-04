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
  installLocalN8nSidecar as installLocalN8nSidecarService,
  refreshLocalN8nSidecarCredential as refreshLocalN8nSidecarCredentialService,
  removeLocalN8nSidecar as removeLocalN8nSidecarService,
  resolveLocalN8nSidecarInstallRoot,
} from "../src/services/local-n8n-sidecar-installer.js";
import { runLocalProcess } from "../src/infrastructure/local-process.js";
import { withTestLocalSecurity } from "./helpers/local-security.js";

const installLocalN8nSidecar = (request, dependencies) =>
  installLocalN8nSidecarService(request, withTestLocalSecurity(dependencies));
const refreshLocalN8nSidecarCredential = (request, dependencies) =>
  refreshLocalN8nSidecarCredentialService(request, withTestLocalSecurity(dependencies));
const removeLocalN8nSidecar = (request, dependencies) =>
  removeLocalN8nSidecarService(request, withTestLocalSecurity(dependencies));

const UNIX_DOCKER_HOST = "unix:///var/run/docker.sock";
const DOCKER_HOST = process.platform === "win32"
  ? "npipe:////./pipe/dockerDesktopLinuxEngine"
  : UNIX_DOCKER_HOST;
const DOCKER_CONTEXT = process.platform === "win32" ? "desktop-linux" : "default";
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
    State: { Paused: false, Running: true },
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
    Internal: false,
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
    State: { Paused: false, Running: true },
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

function expectedWindowsSidecarManagedAclCalls(homeDirectory, installRoot) {
  const relmioHome = join(homeDirectory, ".relmio");
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
  internalNetwork = false,
  published = false,
  verifierCode = 0,
  verifierOutput = JSON.stringify({ data: [{ id: "gpt-5.6-terra" }] }),
  ownedResources = true,
  retainOwnedVolumeAfterDown = false,
  imageListFailure = false,
  n8nImage = "docker.n8n.io/n8nio/n8n:2.36.8",
  contextHost = DOCKER_HOST,
  contextName = DOCKER_CONTEXT,
  refreshJournalState = "clean",
  invalidateRefreshAuthOnPause = false,
  failQuiesceRefresh = false,
} = {}) {
  const calls = [];
  const installId = "d".repeat(32);
  const projectName = `relmio-n8n-openai-oauth-${installId}`;
  let installed = false;
  let removed = false;
  let sidecarRunning = false;
  let sidecarPaused = false;
  let activeVerifierCode = verifierCode;
  let activeRefreshJournalState = refreshJournalState;
  let refreshCurrentAuthValid = true;
  const foreignId = "e".repeat(64);
  const runner = async (spec) => {
    calls.push(spec);
    const args = spec.args;
    const joined = args.join(" ");
    if (joined === "context inspect --format {{json .Endpoints.docker.Host}}") {
      return { stdout: `${JSON.stringify(contextHost)}\n`, stderr: "", code: 0 };
    }
    if (joined === "context show") {
      return { stdout: `${contextName}\n`, stderr: "", code: 0 };
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
            Internal: internalNetwork,
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
      const inspected = sidecarInspect(projectName, installId, {
        State: { Paused: sidecarPaused, Running: sidecarRunning },
      });
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
    if (
      joined.includes("ps -q openai-oauth") ||
      joined.includes("ps --all -q openai-oauth")
    ) {
      return {
        stdout: installed && !removed ? `${SIDECAR_ID}\n` : "",
        stderr: "",
        code: 0,
      };
    }
    if (joined.includes("ps --status running --services openai-oauth")) {
      return {
        stdout: installed && !removed && sidecarRunning ? "openai-oauth\n" : "",
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
          (installed && !removed) || retainOwnedVolumeAfterDown
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
      sidecarRunning = true;
      sidecarPaused = false;
      return { stdout: "", stderr: "", code: 0 };
    }
    if (
      args[0] === "container" &&
      args[1] === "pause" &&
      args.at(-1) === SIDECAR_ID
    ) {
      sidecarPaused = true;
      if (invalidateRefreshAuthOnPause) refreshCurrentAuthValid = false;
      return { stdout: `${SIDECAR_ID}\n`, stderr: "", code: 0 };
    }
    if (
      args[0] === "container" &&
      args[1] === "unpause" &&
      args.at(-1) === SIDECAR_ID
    ) {
      sidecarPaused = false;
      refreshCurrentAuthValid = true;
      return { stdout: `${SIDECAR_ID}\n`, stderr: "", code: 0 };
    }
    if (
      args[0] === "container" &&
      args[1] === "kill" &&
      args.at(-1) === SIDECAR_ID
    ) {
      sidecarRunning = false;
      sidecarPaused = false;
      return { stdout: `${SIDECAR_ID}\n`, stderr: "", code: 0 };
    }
    if (joined.includes("stop --timeout 30 openai-oauth")) {
      sidecarRunning = false;
      sidecarPaused = false;
      return { stdout: "", stderr: "", code: 0 };
    }
    if (
      args.includes("run") &&
      args.includes("--entrypoint") &&
      args.includes("node") &&
      args.includes("-e")
    ) {
      return { stdout: verifierOutput, stderr: "", code: activeVerifierCode };
    }
    if (
      args.includes("credential-seed") &&
      args.some((argument) =>
        argument.includes("printf rollback-pending") && argument.includes("printf clean"),
      )
    ) {
      const script = args.find((argument) =>
        argument.includes("printf rollback-pending") && argument.includes("printf clean"),
      );
      const previousBranchIndex = script.indexOf(
        "if test -e /run/relmio-auth/.auth.json.previous",
      );
      const currentAuthCheckIndex = script.indexOf(
        "test -f /run/relmio-auth/auth.json",
      );
      if (
        activeRefreshJournalState === "rollback-pending" &&
        !refreshCurrentAuthValid &&
        currentAuthCheckIndex >= 0 &&
        (previousBranchIndex < 0 || currentAuthCheckIndex < previousBranchIndex)
      ) {
        return { stdout: "", stderr: "current auth is invalid", code: 1 };
      }
      return { stdout: `${activeRefreshJournalState}\n`, stderr: "", code: 0 };
    }
    if (
      args.includes("credential-seed") &&
      args.some((argument) =>
        argument.includes(
          "cp /run/relmio-auth/auth.json /run/relmio-auth/.auth.json.quiesce.next",
        ),
      )
    ) {
      const snapshotScript = args.find((argument) =>
        argument.includes(
          "cp /run/relmio-auth/auth.json /run/relmio-auth/.auth.json.quiesce.next",
        ),
      );
      const refreshesExistingSnapshot = snapshotScript.includes(
        "printf retained-invalid-current",
      );
      if (refreshesExistingSnapshot) {
        if (failQuiesceRefresh) {
          return { stdout: "", stderr: "snapshot helper failed", code: 1 };
        }
        return {
          stdout: refreshCurrentAuthValid ? "refreshed" : "retained-invalid-current",
          stderr: "",
          code: 0,
        };
      }
      if (!refreshCurrentAuthValid) {
        return { stdout: "", stderr: "current auth is invalid", code: 1 };
      }
      activeRefreshJournalState = "quiesce-pending";
      return { stdout: "", stderr: "", code: 0 };
    }
    if (
      args.includes("credential-seed") &&
      args.some((argument) =>
        argument.includes(
          "mv /run/relmio-auth/.auth.json.quiesce /run/relmio-auth/.auth.json.previous",
        ),
      )
    ) {
      activeRefreshJournalState = "rollback-pending";
      return { stdout: "", stderr: "", code: 0 };
    }
    if (
      args.includes("credential-seed") &&
      args.some((argument) =>
        argument.includes("cp /run/relmio-auth/.auth.json.previous"),
      )
    ) {
      refreshCurrentAuthValid = true;
      return { stdout: "", stderr: "", code: 0 };
    }
    if (
      args.includes("credential-seed") &&
      args.some((argument) =>
        argument.includes(
          "rm -f /run/relmio-auth/.auth.json.previous /run/relmio-auth/.auth.json.quiesce",
        ),
      )
    ) {
      activeRefreshJournalState = "clean";
      return { stdout: "", stderr: "", code: 0 };
    }
    if (joined.includes("down --volumes --remove-orphans")) {
      installed = false;
      removed = true;
      sidecarRunning = false;
      sidecarPaused = false;
      return { stdout: "", stderr: "", code: 0 };
    }
    return { stdout: "", stderr: "", code: 0 };
  };
  runner.calls = calls;
  runner.projectName = projectName;
  runner.installId = installId;
  runner.setVerifierCode = (code) => { activeVerifierCode = code; };
  runner.setSidecarRunning = (running) => { sidecarRunning = running; };
  runner.setRefreshCurrentAuthValid = (valid) => { refreshCurrentAuthValid = valid; };
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
  const runner = createRunner({ contextHost: UNIX_DOCKER_HOST, contextName: "default" });
  const result = await discoverLocalN8nSidecarTargets({
    runProcess: runner,
    cwd: "/private/tmp",
    env: {},
    platform: "linux",
  });

  assert.equal(result.dockerAvailable, true);
  assert.equal(result.dockerHost, UNIX_DOCKER_HOST);
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
  const runner = createRunner({
    n8nImage: image,
    contextHost: UNIX_DOCKER_HOST,
    contextName: "default",
  });

  const result = await discoverLocalN8nSidecarTargets({
    runProcess: runner,
    cwd: "/private/tmp",
    env: {},
    platform: "linux",
  });

  assert.equal(result.containers.length, 1);
  assert.equal(result.containers[0].image, image);
});

test("discovery accepts Docker Desktop's attested local Linux engine", async () => {
  const result = await discoverLocalN8nSidecarTargets({
    runProcess: createRunner({
      contextHost: "npipe:////./pipe/dockerDesktopLinuxEngine",
      contextName: "desktop-linux",
    }),
    cwd: "/private/tmp",
    env: {},
    platform: "win32",
  });
  assert.equal(result.dockerHost, "npipe:////./pipe/dockerDesktopLinuxEngine");
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
  if (process.platform !== "win32") {
    await assert.rejects(
      () =>
        installLocalN8nSidecar(
          { plan: createPlan({ authGeneration: permissiveGeneration }), authPath, confirmed: true },
          { homeDirectory, env: {}, runProcess: runner, randomBytes: () => Buffer.alloc(32, 0xdd) },
        ),
      /permissions/iu,
    );
  }

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
  const authAclCalls = [];

  const result = await installLocalN8nSidecar(
    { plan: createPlan(), authPath, confirmed: true },
    {
      homeDirectory,
      env: {},
      runProcess: runner,
      randomBytes: () => Buffer.alloc(32, 0xdd),
      async lockDownPath(path, options) {
        authAclCalls.push({ path, options });
      },
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
  const lifecycleLockCalls = authAclCalls.filter(({ path }) =>
    path.includes(".relmio-local-n8n-openai-oauth.lock"),
  );
  const managedAclCalls = authAclCalls.filter(({ path }) =>
    !path.includes(".relmio-local-n8n-openai-oauth.lock"),
  );
  assert.equal(
    lifecycleLockCalls.some(({ options }) => options.verifyOnly === true),
    process.platform === "win32",
  );
  assert.ok(lifecycleLockCalls.some(({ options }) => options.kind === "file"));
  if (process.platform !== "win32") {
    assert.equal((await stat(authPath)).mode & 0o777, 0o600);
    assert.deepEqual(managedAclCalls, []);
  } else {
    const relmioHome = join(homeDirectory, ".relmio");
    const localRoot = join(relmioHome, "local");
    const installRoot = join(localRoot, "n8n-openai-oauth");
    assert.deepEqual(managedAclCalls, [
      { path: authPath, options: { platform: "win32", kind: "file" } },
      { path: relmioHome, options: { platform: "win32" } },
      { path: relmioHome, options: { platform: "win32" } },
      { path: localRoot, options: { platform: "win32" } },
      { path: installRoot, options: { platform: "win32" } },
      { path: authPath, options: { platform: "win32", kind: "file" } },
    ]);
  }
});

test("sidecar installation rejects an internal selected network before managed writes", async (t) => {
  const homeDirectory = await createTestHome(t);
  const authPath = await createAuthFixture(homeDirectory);
  const runner = createRunner({ internalNetwork: true });
  await assert.rejects(
    () => installLocalN8nSidecar(
      { plan: createPlan(), authPath, confirmed: true },
      {
        homeDirectory,
        env: {},
        platform: process.platform,
        runProcess: runner,
        randomBytes: () => Buffer.alloc(32, 0xdd),
      },
    ),
    /no outbound Internet access|non-internal/iu,
  );
  assert.equal(runner.calls.some((call) => call.args.includes("build")), false);
  await assert.rejects(
    () => stat(join(homeDirectory, ".relmio", "local", LOCAL_N8N_SIDECAR_TARGET)),
    /ENOENT/u,
  );
});

test("fresh sidecar root initialization removes only an empty failed root and retries immediately", async (t) => {
  const homeDirectory = await createTestHome(t);
  const authPath = await createAuthFixture(homeDirectory);
  const relmioHome = join(homeDirectory, ".relmio");
  const runner = createRunner();
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
  const request = { plan: createPlan(), authPath, confirmed: true };
  const dependencies = {
    homeDirectory,
    env: {},
    fileSystem,
    platform: process.platform,
    runProcess: runner,
    lockDownPath: async () => {},
    randomBytes: () => Buffer.alloc(32, 0xdd),
  };

  await assert.rejects(
    () => installLocalN8nSidecar(request, dependencies),
    /injected fresh-root chmod failure/iu,
  );
  await assert.rejects(() => stat(relmioHome), /ENOENT/u);

  const result = await installLocalN8nSidecar(request, dependencies);
  assert.equal(result.deploymentMode, "installed");
  assert.equal((await stat(relmioHome)).isDirectory(), true);
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
  assert.ok(runner.calls.some((call) => call.args[0] === "container" && call.args[1] === "ls"));
  assert.ok(runner.calls.some((call) => call.args[0] === "volume" && call.args[1] === "ls"));
});

test("credential refresh reseeds and recreates only the owned sidecar", async (t) => {
  const homeDirectory = await createTestHome(t);
  const authPath = await createAuthFixture(homeDirectory);
  const runner = createRunner();
  await installLocalN8nSidecar(
    { plan: createPlan(), authPath, confirmed: true },
    { homeDirectory, env: {}, runProcess: runner, randomBytes: () => Buffer.alloc(32, 0xdd) },
  );
  const before = runner.calls.length;
  const result = await refreshLocalN8nSidecarCredential(
    { authPath, confirmed: true },
    { homeDirectory, env: {}, runProcess: runner },
  );
  assert.deepEqual(result, {
    target: LOCAL_N8N_SIDECAR_TARGET,
    credentialRefreshed: true,
    models: ["gpt-5.6-terra"],
    hostPublication: "none",
  });
  const refreshCalls = runner.calls.slice(before);
  for (const call of refreshCalls) {
    await assert.rejects(
      runLocalProcess(call, {
        spawnProcess() {
          throw new Error("test process boundary");
        },
      }),
      /could not start/iu,
    );
  }
  const secretBearingCalls = refreshCalls.filter((call) => call.input !== undefined);
  assert.equal(secretBearingCalls.length, 1);
  assert.deepEqual(secretBearingCalls[0].input, AUTH_CONTENTS);
  assert.equal(secretBearingCalls[0].args.join(" ").includes("fixture-secret"), false);
  const pauseIndex = refreshCalls.findIndex((call) =>
    call.args[0] === "container" && call.args[1] === "pause",
  );
  const snapshotIndex = refreshCalls.findIndex((call) =>
    call.args.some((argument) =>
      argument.includes(
        "cp /run/relmio-auth/auth.json /run/relmio-auth/.auth.json.quiesce.next",
      ),
    ),
  );
  const killIndex = refreshCalls.findIndex((call) =>
    call.args[0] === "container" && call.args[1] === "kill",
  );
  const promoteIndex = refreshCalls.findIndex((call) =>
    call.args.some((argument) =>
      argument.includes(
        "mv /run/relmio-auth/.auth.json.quiesce /run/relmio-auth/.auth.json.previous",
      ),
    ),
  );
  const seedIndex = refreshCalls.indexOf(secretBearingCalls[0]);
  assert.ok(pauseIndex >= 0);
  assert.ok(snapshotIndex > pauseIndex);
  assert.ok(killIndex > snapshotIndex);
  assert.ok(promoteIndex > killIndex);
  assert.ok(seedIndex > promoteIndex);
  const credentialHelpers = refreshCalls.filter((call) =>
    call.args.includes("credential-seed") && call.args.includes("--entrypoint"),
  );
  assert.equal(credentialHelpers.length, 6);
  for (const helper of credentialHelpers) {
    const user = helper.args[helper.args.indexOf("--user") + 1];
    assert.equal(user, "1000:1000");
  }
  const recreate = refreshCalls.find((call) => call.args.includes("--force-recreate"));
  assert.ok(recreate);
  assert.equal(recreate.args.includes("relmio-test-n8n"), false);
  assert.equal(refreshCalls.some((call) => call.args.includes("build")), false);
  assert.equal(refreshCalls.some((call) => call.args.includes("stop")), false);
  assert.equal(refreshCalls.some((call) => call.args.includes("down")), false);
});

test("Windows credential refresh injects exact verify-only managed ACL checks", async (t) => {
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
  const installRoot = await resolveLocalN8nSidecarInstallRoot({
    homeDirectory,
    env: {},
  });
  const expectedAclCalls = expectedWindowsSidecarManagedAclCalls(
    homeDirectory,
    installRoot,
  );
  const managedPaths = new Set(expectedAclCalls.map(({ path }) => path));
  const aclCalls = [];

  const result = await refreshLocalN8nSidecarCredential(
    { authPath, confirmed: true },
    {
      homeDirectory,
      env: {},
      platform: "win32",
      runProcess: runner,
      async lockDownPath(path, options) {
        aclCalls.push({ path, options });
      },
    },
  );

  assert.equal(result.credentialRefreshed, true);
  assert.deepEqual(
    aclCalls.filter(({ path }) => managedPaths.has(path)),
    expectedAclCalls,
  );
});

test("Windows sidecar ACL drift blocks refresh and removal before Compose mutation", async (t) => {
  for (const action of ["refresh", "remove"]) {
    await t.test(action, async (subtest) => {
      const homeDirectory = await createTestHome(subtest);
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
      const installRoot = await resolveLocalN8nSidecarInstallRoot({
        homeDirectory,
        env: {},
      });
      const expectedAclCalls = expectedWindowsSidecarManagedAclCalls(
        homeDirectory,
        installRoot,
      );
      const managedPaths = new Set(expectedAclCalls.map(({ path }) => path));
      const composePath = join(installRoot, "docker-compose.yml");
      const aclCalls = [];
      const before = runner.calls.length;
      const dependencies = {
        homeDirectory,
        env: {},
        platform: "win32",
        runProcess: runner,
        async lockDownPath(path, options) {
          aclCalls.push({ path, options });
          if (path === composePath) {
            throw new Error("fixture sidecar ACL drift");
          }
        },
      };

      await assert.rejects(
        action === "refresh"
          ? () => refreshLocalN8nSidecarCredential(
              { authPath, confirmed: true },
              dependencies,
            )
          : () => removeLocalN8nSidecar(
              { confirmed: true },
              dependencies,
            ),
        /fixture sidecar ACL drift/u,
      );

      assert.deepEqual(
        aclCalls.filter(({ path }) => managedPaths.has(path)),
        expectedAclCalls,
      );
      assert.deepEqual(runner.calls.slice(before), []);
      await stat(installRoot);
    });
  }
});

test("credential refresh resumes unchanged when a frozen credential cannot be snapshotted", async (t) => {
  const homeDirectory = await createTestHome(t);
  const authPath = await createAuthFixture(homeDirectory);
  const runner = createRunner({ invalidateRefreshAuthOnPause: true });
  await installLocalN8nSidecar(
    { plan: createPlan(), authPath, confirmed: true },
    { homeDirectory, env: {}, runProcess: runner, randomBytes: () => Buffer.alloc(32, 0xdd) },
  );
  const before = runner.calls.length;

  await assert.rejects(
    () => refreshLocalN8nSidecarCredential(
      { authPath, confirmed: true },
      { homeDirectory, env: {}, runProcess: runner },
    ),
    /could not capture a stable snapshot|resumed unchanged/iu,
  );

  const refreshCalls = runner.calls.slice(before);
  const pauseIndex = refreshCalls.findIndex((call) => call.args[1] === "pause");
  const unpauseIndex = refreshCalls.findIndex((call) => call.args[1] === "unpause");
  assert.ok(pauseIndex >= 0);
  assert.ok(unpauseIndex > pauseIndex);
  assert.equal(refreshCalls.some((call) => call.args[1] === "kill"), false);
  assert.equal(refreshCalls.some((call) => call.input !== undefined), false);
  assert.equal(refreshCalls.some((call) => call.args.includes("--force-recreate")), false);
});

test("credential refresh restarts the unchanged sidecar when the source changes after quiescence", async (t) => {
  const homeDirectory = await createTestHome(t);
  const authPath = await createAuthFixture(homeDirectory);
  const runner = createRunner();
  await installLocalN8nSidecar(
    { plan: createPlan(), authPath, confirmed: true },
    { homeDirectory, env: {}, runProcess: runner, randomBytes: () => Buffer.alloc(32, 0xdd) },
  );

  let authReadCount = 0;
  const changedAuth = Buffer.from(JSON.stringify({ access_token: "changed-secret" }));
  const driftingFileSystem = {
    ...nodeFileSystem,
    async readFile(path, ...args) {
      if (path === authPath) {
        authReadCount += 1;
        return authReadCount < 3 ? AUTH_CONTENTS : changedAuth;
      }
      return nodeFileSystem.readFile(path, ...args);
    },
  };
  const before = runner.calls.length;

  await assert.rejects(
    () => refreshLocalN8nSidecarCredential(
      { authPath, confirmed: true },
      {
        fileSystem: driftingFileSystem,
        homeDirectory,
        env: {},
        runProcess: runner,
      },
    ),
    /stopped before replacement|restored and restarted/iu,
  );

  const refreshCalls = runner.calls.slice(before);
  assert.equal(authReadCount, 3);
  assert.ok(refreshCalls.some((call) => call.args[1] === "pause"));
  assert.ok(refreshCalls.some((call) => call.args[1] === "kill"));
  assert.equal(
    refreshCalls.filter((call) => call.args.includes("--force-recreate")).length,
    1,
  );
  assert.equal(refreshCalls.some((call) => call.input !== undefined), false);
  assert.equal(
    refreshCalls.some((call) =>
      call.args.some((argument) =>
        argument.includes(
          "cp /run/relmio-auth/auth.json /run/relmio-auth/.auth.json.quiesce.next",
        ),
      ),
    ),
    true,
  );
  assert.equal(JSON.stringify(refreshCalls).includes("changed-secret"), false);
});

test("credential refresh requires confirmation and preserves the owned sidecar on failed verification", async (t) => {
  const homeDirectory = await createTestHome(t);
  const authPath = await createAuthFixture(homeDirectory);
  const runner = createRunner();
  await installLocalN8nSidecar(
    { plan: createPlan(), authPath, confirmed: true },
    { homeDirectory, env: {}, runProcess: runner, randomBytes: () => Buffer.alloc(32, 0xdd) },
  );
  await assert.rejects(
    () => refreshLocalN8nSidecarCredential(
      { authPath, confirmed: false },
      { homeDirectory, env: {}, runProcess: runner },
    ),
    /confirm/iu,
  );
  assert.equal(runner.calls.filter((call) => call.args.includes("down")).length, 0);
  runner.setVerifierCode(1);
  const before = runner.calls.length;
  await assert.rejects(
    () => refreshLocalN8nSidecarCredential(
      { authPath, confirmed: true },
      { homeDirectory, env: {}, runProcess: runner },
    ),
    /restored the previous credential|did not touch n8n/iu,
  );
  const failedRefreshCalls = runner.calls.slice(before);
  assert.equal(
    failedRefreshCalls.filter((call) => call.args.includes("--force-recreate")).length,
    2,
  );
  assert.ok(
    failedRefreshCalls.some((call) =>
      call.args.some((argument) => argument.includes(".auth.json.previous")),
    ),
  );
  const rollback = failedRefreshCalls.find((call) =>
    call.args.some((argument) =>
      argument.includes("cp /run/relmio-auth/.auth.json.previous"),
    ),
  );
  assert.equal(rollback.args[rollback.args.indexOf("--user") + 1], "1000:1000");
  assert.equal(
    failedRefreshCalls.some((call) => call.args.join(" ").includes("fixture-secret")),
    false,
  );
  assert.equal(failedRefreshCalls.some((call) => call.args.includes("down")), false);
  await stat(await resolveLocalN8nSidecarInstallRoot({ homeDirectory, env: {} }));
});

test("credential refresh promotes an interrupted quiesce snapshot after freezing the exact writer", async (t) => {
  const homeDirectory = await createTestHome(t);
  const authPath = await createAuthFixture(homeDirectory);
  const runner = createRunner({ refreshJournalState: "quiesce-pending" });
  await installLocalN8nSidecar(
    { plan: createPlan(), authPath, confirmed: true },
    { homeDirectory, env: {}, runProcess: runner, randomBytes: () => Buffer.alloc(32, 0xdd) },
  );
  runner.setRefreshCurrentAuthValid(false);
  const before = runner.calls.length;

  const result = await refreshLocalN8nSidecarCredential(
    { authPath, confirmed: true },
    { homeDirectory, env: {}, runProcess: runner },
  );

  assert.equal(result.credentialRefreshed, true);
  const refreshCalls = runner.calls.slice(before);
  const pauseIndex = refreshCalls.findIndex((call) => call.args[1] === "pause");
  const killIndex = refreshCalls.findIndex((call) => call.args[1] === "kill");
  const promoteIndex = refreshCalls.findIndex((call) =>
    call.args.some((argument) =>
      argument.includes(
        "mv /run/relmio-auth/.auth.json.quiesce /run/relmio-auth/.auth.json.previous",
      ),
    ),
  );
  const rollbackIndex = refreshCalls.findIndex((call) =>
    call.args.some((argument) =>
      argument.includes("cp /run/relmio-auth/.auth.json.previous"),
    ),
  );
  assert.ok(pauseIndex >= 0);
  assert.ok(killIndex > pauseIndex);
  assert.ok(promoteIndex > killIndex);
  assert.ok(rollbackIndex > promoteIndex);
});

test("credential refresh preserves a quiesce snapshot when refreshing it fails ambiguously", async (t) => {
  const homeDirectory = await createTestHome(t);
  const authPath = await createAuthFixture(homeDirectory);
  const runner = createRunner({
    failQuiesceRefresh: true,
    refreshJournalState: "quiesce-pending",
  });
  await installLocalN8nSidecar(
    { plan: createPlan(), authPath, confirmed: true },
    { homeDirectory, env: {}, runProcess: runner, randomBytes: () => Buffer.alloc(32, 0xdd) },
  );
  const before = runner.calls.length;

  await assert.rejects(
    () => refreshLocalN8nSidecarCredential(
      { authPath, confirmed: true },
      { homeDirectory, env: {}, runProcess: runner },
    ),
    /could not prove.*quiesce snapshot.*refreshed|retry only after inspecting/iu,
  );

  const refreshCalls = runner.calls.slice(before);
  assert.ok(refreshCalls.some((call) => call.args[1] === "pause"));
  assert.equal(refreshCalls.some((call) => call.args[1] === "kill"), false);
  assert.equal(refreshCalls.some((call) => call.input !== undefined), false);
  assert.equal(
    refreshCalls.some((call) =>
      call.args.some((argument) =>
        argument.includes(
          "mv /run/relmio-auth/.auth.json.quiesce /run/relmio-auth/.auth.json.previous",
        ),
      ),
    ),
    false,
  );
});

test("credential refresh never promotes a stale quiesce snapshot after a stopped-writer refresh error", async (t) => {
  const homeDirectory = await createTestHome(t);
  const authPath = await createAuthFixture(homeDirectory);
  const runner = createRunner({
    failQuiesceRefresh: true,
    refreshJournalState: "quiesce-pending",
  });
  await installLocalN8nSidecar(
    { plan: createPlan(), authPath, confirmed: true },
    { homeDirectory, env: {}, runProcess: runner, randomBytes: () => Buffer.alloc(32, 0xdd) },
  );
  runner.setSidecarRunning(false);
  const before = runner.calls.length;

  await assert.rejects(
    () => refreshLocalN8nSidecarCredential(
      { authPath, confirmed: true },
      { homeDirectory, env: {}, runProcess: runner },
    ),
    /could not prove.*quiesce snapshot.*refreshed|state were preserved/iu,
  );

  const refreshCalls = runner.calls.slice(before);
  assert.equal(refreshCalls.some((call) => call.args[1] === "pause"), false);
  assert.equal(refreshCalls.some((call) => call.args[1] === "kill"), false);
  assert.equal(refreshCalls.some((call) => call.args.includes("--force-recreate")), false);
  assert.equal(refreshCalls.some((call) => call.input !== undefined), false);
  assert.equal(
    refreshCalls.some((call) =>
      call.args.some((argument) =>
        argument.includes(
          "mv /run/relmio-auth/.auth.json.quiesce /run/relmio-auth/.auth.json.previous",
        ),
      ),
    ),
    false,
  );
});

test("credential refresh recovers an interrupted journal before reading a corrupt current credential", async (t) => {
  const homeDirectory = await createTestHome(t);
  const authPath = await createAuthFixture(homeDirectory);
  const runner = createRunner({ refreshJournalState: "rollback-pending" });
  await installLocalN8nSidecar(
    { plan: createPlan(), authPath, confirmed: true },
    { homeDirectory, env: {}, runProcess: runner, randomBytes: () => Buffer.alloc(32, 0xdd) },
  );
  runner.setSidecarRunning(false);
  runner.setRefreshCurrentAuthValid(false);
  const before = runner.calls.length;

  const result = await refreshLocalN8nSidecarCredential(
    { authPath, confirmed: true },
    { homeDirectory, env: {}, runProcess: runner },
  );

  assert.equal(result.credentialRefreshed, true);
  const refreshCalls = runner.calls.slice(before);
  const recreates = refreshCalls.filter((call) => call.args.includes("--force-recreate"));
  assert.equal(recreates.length, 1);
  const rollbackIndex = refreshCalls.findIndex((call) =>
    call.args.some((argument) =>
      argument.includes("cp /run/relmio-auth/.auth.json.previous"),
    ),
  );
  const seedIndex = refreshCalls.findIndex((call) => call.input !== undefined);
  assert.ok(rollbackIndex >= 0);
  assert.ok(seedIndex > rollbackIndex);
  assert.equal(refreshCalls.some((call) => call.args.includes("down")), false);
  assert.equal(refreshCalls.some((call) => call.args.includes("build")), false);
  assert.equal(refreshCalls.some((call) => call.args.includes("relmio-test-n8n")), false);
});

test("removal keeps the managed directory when an owned credential volume remains", async (t) => {
  const homeDirectory = await createTestHome(t);
  const authPath = await createAuthFixture(homeDirectory);
  const runner = createRunner({ retainOwnedVolumeAfterDown: true });
  await installLocalN8nSidecar(
    { plan: createPlan(), authPath, confirmed: true },
    { homeDirectory, env: {}, runProcess: runner, randomBytes: () => Buffer.alloc(32, 0xdd) },
  );
  const installRoot = await resolveLocalN8nSidecarInstallRoot({ homeDirectory, env: {} });
  await assert.rejects(
    () => removeLocalN8nSidecar(
      { confirmed: true },
      { homeDirectory, env: {}, runProcess: runner },
    ),
    /credential volumes|managed directory was kept/iu,
  );
  await stat(installRoot);
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

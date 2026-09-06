import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { getLocalDashboardStatus } from "../src/services/local-dashboard.js";
import {
  getManagedLocalEndpointStatus as getManagedLocalEndpointStatusService,
} from "../src/services/local-installer.js";
import {
  getLocalN8nSidecarStatus as getLocalN8nSidecarStatusService,
} from "../src/services/local-n8n-sidecar-installer.js";
import {
  getLocalN8nAssistantStatus as getLocalN8nAssistantStatusService,
} from "../src/services/local-n8n-assistant-installer.js";
import { withTestLocalSecurity } from "./helpers/local-security.js";

const getManagedLocalEndpointStatus = (request, dependencies) =>
  getManagedLocalEndpointStatusService(request, withTestLocalSecurity(dependencies));
const getLocalN8nSidecarStatus = (dependencies) =>
  getLocalN8nSidecarStatusService(withTestLocalSecurity(dependencies));
const getLocalN8nAssistantStatus = (dependencies) =>
  getLocalN8nAssistantStatusService(withTestLocalSecurity(dependencies));

const DOCKER_HOST = process.platform === "win32"
  ? "npipe:////./pipe/dockerDesktopLinuxEngine"
  : "unix:///var/run/docker.sock";
const MUTATING_DOCKER_ARGUMENTS = new Set([
  "build",
  "down",
  "exec",
  "pull",
  "restart",
  "rm",
  "run",
  "start",
  "stop",
  "up",
]);

function assertReadOnlyDockerCalls(calls) {
  assert.equal(
    calls.some(({ args }) => args.some((argument) => MUTATING_DOCKER_ARGUMENTS.has(argument))),
    false,
  );
}

async function createManagedRoot(t, target, markerOverrides = {}) {
  const homeDirectory = await mkdtemp(join(tmpdir(), "relmio-dashboard-test-"));
  t.after(() => rm(homeDirectory, { recursive: true, force: true }));
  const canonicalHome = await realpath(homeDirectory);
  const relmioHome = join(canonicalHome, ".relmio");
  const installRoot = join(relmioHome, "local", target);
  await mkdir(installRoot, { recursive: true });
  await writeFile(
    join(relmioHome, ".managed-by-relmio-root.json"),
    JSON.stringify({ schemaVersion: 1, kind: "relmio-local-root" }),
  );
  const installId = "a".repeat(32);
  const prefix = {
    "openai-api": "relmio-openai-api",
    "codex-chatgpt": "relmio-codex-chatgpt",
    "codex-chat": "relmio-codex-chat",
  }[target];
  await writeFile(
    join(installRoot, ".managed-by-relmio.json"),
    JSON.stringify({
      schemaVersion: 2,
      target,
      port: 12435,
      dockerHost: DOCKER_HOST,
      installId,
      projectName: `${prefix}-${installId}`,
      ...markerOverrides,
    }),
  );
  await writeFile(join(installRoot, "docker-compose.yml"), "services: {}\n");
  return canonicalHome;
}

function createEndpointInventoryRunner({
  target = "openai-api",
  state = "running",
  health = state === "running" ? "healthy" : "",
  foreign = false,
  missing = false,
  wrongContainerName = false,
  wrongNetworkName = false,
  wrongVolumeName = false,
  wrongServiceLabel = false,
  wrongNetworkLabel = false,
  wrongVolumeLabel = false,
  duplicateResource = null,
  duplicateStatus = false,
  wrongStatusService = false,
  wrongStatusName = false,
} = {}) {
  const calls = [];
  const installId = "a".repeat(32);
  const project = {
    "openai-api": {
      prefix: "relmio-openai-api",
      service: "gateway",
      targetPort: 10_531,
      volumes: ["openai-api-key"],
    },
    "codex-chatgpt": {
      prefix: "relmio-codex-chatgpt",
      service: "codex",
      targetPort: 4_500,
      volumes: ["codex-home", "codex-workspace"],
    },
    "codex-chat": {
      prefix: "relmio-codex-chat",
      service: "codex-chat",
      targetPort: 14_501,
      volumes: ["codex-home", "codex-workspace"],
    },
  }[target];
  const projectName = `${project.prefix}-${installId}`;
  const commonLabels = foreign
    ? ["com.docker.compose.project=foreign", "io.relmio.managed=false"]
    : [
        `com.docker.compose.project=${projectName}`,
        "io.relmio.managed=true",
        `io.relmio.target=${target}`,
        `io.relmio.install=${installId}`,
      ];
  const resources = {
    container: {
      Names: wrongContainerName
        ? `${projectName}-wrong-1`
        : `${projectName}-${project.service}-1`,
      Labels: [
        ...commonLabels,
        `com.docker.compose.service=${wrongServiceLabel ? "wrong" : project.service}`,
      ].join(","),
    },
    network: {
      Name: wrongNetworkName ? `${projectName}_wrong` : `${projectName}_default`,
      Labels: [
        ...commonLabels,
        `com.docker.compose.network=${wrongNetworkLabel ? "wrong" : "default"}`,
      ].join(","),
    },
    volume: project.volumes.map((volume, index) => ({
      Name: wrongVolumeName && index === 0
        ? `${projectName}_wrong`
        : `${projectName}_${volume}`,
      Labels: [
        ...commonLabels,
        `com.docker.compose.volume=${wrongVolumeLabel && index === 0 ? "wrong" : volume}`,
      ].join(","),
    })),
  };
  const resourceOutput = (kind) => {
    if (missing) return "";
    const expectedRows = Array.isArray(resources[kind])
      ? resources[kind]
      : [resources[kind]];
    const rows = duplicateResource === kind
      ? [...expectedRows, expectedRows[0]]
      : expectedRows;
    return `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
  };
  const runner = async (spec) => {
    calls.push(spec);
    const command = spec.args.join(" ");
    if (command === "context inspect --format {{json .Endpoints.docker.Host}}") {
      return { code: 0, stdout: `${JSON.stringify(DOCKER_HOST)}\n`, stderr: "" };
    }
    if (command === "context show") {
      return { code: 0, stdout: "desktop-linux\n", stderr: "" };
    }
    if (command.startsWith("ps --all --filter")) {
      return { code: 0, stdout: resourceOutput("container"), stderr: "" };
    }
    if (command.startsWith("network ls")) {
      return { code: 0, stdout: resourceOutput("network"), stderr: "" };
    }
    if (command.startsWith("volume ls")) {
      return { code: 0, stdout: resourceOutput("volume"), stderr: "" };
    }
    if (command.includes(`ps --all --format json ${project.service}`)) {
      const record = {
        Name: wrongStatusName
          ? `${projectName}-wrong-1`
          : `${projectName}-${project.service}-1`,
        Service: wrongStatusService ? "wrong" : project.service,
        State: state,
        Health: health,
        Publishers: [{
          URL: "127.0.0.1",
          PublishedPort: 12435,
          TargetPort: project.targetPort,
          Protocol: "tcp",
        }],
      };
      return {
        code: 0,
        stdout: missing
          ? ""
          : JSON.stringify(duplicateStatus ? [record, record] : record),
        stderr: "sk-secret-canary",
      };
    }
    return { code: 1, stdout: "", stderr: "unexpected" };
  };
  runner.calls = calls;
  return runner;
}

async function createManagedSidecarRoot(t) {
  const homeDirectory = await mkdtemp(join(tmpdir(), "relmio-sidecar-dashboard-test-"));
  t.after(() => rm(homeDirectory, { recursive: true, force: true }));
  const canonicalHome = await realpath(homeDirectory);
  const relmioHome = join(canonicalHome, ".relmio");
  const installRoot = join(relmioHome, "local", "n8n-openai-oauth");
  await mkdir(installRoot, { recursive: true });
  await writeFile(
    join(relmioHome, ".managed-by-relmio-root.json"),
    JSON.stringify({ schemaVersion: 1, kind: "relmio-local-root" }),
  );
  const installId = "b".repeat(32);
  const marker = {
    schemaVersion: 1,
    kind: "relmio-local-n8n-sidecar",
    target: "n8n-openai-oauth",
    installId,
    projectName: `relmio-n8n-openai-oauth-${installId}`,
    dockerHost: DOCKER_HOST,
    n8nContainerId: "c".repeat(64),
    n8nContainerName: "fixture-n8n",
    dockerNetworkId: "d".repeat(64),
    networkName: "fixture-shared",
  };
  await writeFile(join(installRoot, ".managed-by-relmio.json"), JSON.stringify(marker));
  await writeFile(join(installRoot, "docker-compose.yml"), "services: {}\n");
  return { homeDirectory: canonicalHome, marker };
}

function createSidecarInventoryRunner(marker, {
  running = true,
  state = running ? "running" : "exited",
  health = running ? "healthy" : "",
  paused = false,
  foreign = false,
  missing = false,
  n8nNameDrift = false,
  networkDrift = false,
  aliasDrift = false,
} = {}) {
  const calls = [];
  const containerId = "e".repeat(64);
  const labels = {
    "com.docker.compose.project": marker.projectName,
    "com.docker.compose.service": "openai-oauth",
    "io.relmio.managed": foreign ? "false" : "true",
    "io.relmio.target": "n8n-openai-oauth",
    "io.relmio.install": marker.installId,
  };
  const inspect = {
    Id: containerId,
    Name: `/${marker.projectName}-openai-oauth-1`,
    Config: { Labels: labels },
    State: { Running: running, Paused: paused, Health: { Status: health } },
    NetworkSettings: {
      Networks: {
        [marker.networkName]: {
          NetworkID: marker.dockerNetworkId,
          Aliases: ["n8n-openai-oauth"],
        },
      },
      Ports: { "10531/tcp": null },
    },
  };
  const n8nInspect = {
    Id: marker.n8nContainerId,
    Name: n8nNameDrift ? "/drifted-n8n" : `/${marker.n8nContainerName}`,
    Config: { Image: "n8nio/n8n:1.120.0", Labels: {} },
    State: { Running: true },
    NetworkSettings: {
      Networks: {
        [marker.networkName]: {
          NetworkID: networkDrift ? "f".repeat(64) : marker.dockerNetworkId,
          Aliases: [marker.n8nContainerName],
        },
      },
    },
  };
  const networkInspect = {
    Id: networkDrift ? "f".repeat(64) : marker.dockerNetworkId,
    Name: marker.networkName,
    Driver: "bridge",
    Scope: "local",
    Internal: false,
    Labels: {},
    Containers: {
      [marker.n8nContainerId]: { Name: marker.n8nContainerName },
      ...(missing ? {} : {
        [containerId]: {
          Name: `${marker.projectName}-openai-oauth-1`,
        },
      }),
      ...(aliasDrift ? {
        ["9".repeat(64)]: {
          Name: "foreign-sidecar",
          Aliases: ["n8n-openai-oauth"],
        },
      } : {}),
    },
  };
  const aliasDriftInspect = {
    Id: "9".repeat(64),
    Name: "/foreign-sidecar",
    Config: { Labels: {} },
    State: { Running: true },
    NetworkSettings: {
      Networks: {
        [marker.networkName]: {
          NetworkID: marker.dockerNetworkId,
          Aliases: ["n8n-openai-oauth"],
        },
      },
    },
  };
  const runner = async (spec) => {
    calls.push(spec);
    const command = spec.args.join(" ");
    if (command === "context inspect --format {{json .Endpoints.docker.Host}}") {
      return { code: 0, stdout: `${JSON.stringify(DOCKER_HOST)}\n`, stderr: "" };
    }
    if (command === "context show") {
      return { code: 0, stdout: "desktop-linux\n", stderr: "" };
    }
    if (command === `container inspect --format {{json .}} ${marker.n8nContainerId}`) {
      return { code: 0, stdout: JSON.stringify(n8nInspect), stderr: "" };
    }
    if (command === `network inspect --format {{json .}} ${marker.networkName}`) {
      return { code: 0, stdout: JSON.stringify(networkInspect), stderr: "" };
    }
    if (command === `container inspect --format {{json .}} ${"9".repeat(64)}`) {
      return { code: 0, stdout: JSON.stringify(aliasDriftInspect), stderr: "" };
    }
    if (command.startsWith("ps --all --no-trunc --filter")) {
      return { code: 0, stdout: missing ? "" : `${JSON.stringify({ ID: containerId })}\n`, stderr: "" };
    }
    if (command === `container inspect --format {{json .}} ${containerId}`) {
      return { code: 0, stdout: JSON.stringify(inspect), stderr: "" };
    }
    if (command.startsWith("volume ls")) {
      return {
        code: 0,
        stdout: missing
          ? ""
          : `${JSON.stringify({ Name: `${marker.projectName}_oauth-auth` })}\n`,
        stderr: "",
      };
    }
    if (command === `volume inspect --format {{json .Labels}} ${marker.projectName}_oauth-auth`) {
      return { code: 0, stdout: JSON.stringify(labels), stderr: "" };
    }
    if (command.startsWith("image ls")) {
      return {
        code: 0,
        stdout: missing ? "" : `${JSON.stringify({ Repository: marker.projectName, Tag: "local" })}\n`,
        stderr: "",
      };
    }
    if (command.includes("image inspect --format {{json .Config.Labels}}")) {
      return { code: 0, stdout: JSON.stringify(labels), stderr: "" };
    }
    if (command.includes("ps --all -q openai-oauth")) {
      return { code: 0, stdout: missing ? "" : `${containerId}\n`, stderr: "" };
    }
    if (command.includes("ps --status running --services openai-oauth")) {
      return { code: 0, stdout: running ? "openai-oauth\n" : "", stderr: "" };
    }
    if (
      command.includes("ps --format json openai-oauth") ||
      command.includes("ps --all --format json openai-oauth")
    ) {
      return {
        code: 0,
        stdout: JSON.stringify({
          Name: `${marker.projectName}-openai-oauth-1`,
          Service: "openai-oauth",
          State: state,
          Health: health,
          Publishers: [],
        }),
        stderr: "",
      };
    }
    if (command.endsWith("ps -q openai-oauth")) {
      return { code: 0, stdout: `${containerId}\n`, stderr: "" };
    }
    return { code: 1, stdout: "", stderr: "sk-sidecar-secret-canary" };
  };
  runner.calls = calls;
  return runner;
}

async function createManagedAssistantRoot(t, { includeSearxng = true } = {}) {
  const homeDirectory = await mkdtemp(join(tmpdir(), "relmio-assistant-dashboard-test-"));
  t.after(() => rm(homeDirectory, { recursive: true, force: true }));
  const canonicalHome = await realpath(homeDirectory);
  const relmioHome = join(canonicalHome, ".relmio");
  const installRoot = join(relmioHome, "local", "n8n-ai-assistant");
  await mkdir(installRoot, { recursive: true });
  await writeFile(
    join(relmioHome, ".managed-by-relmio-root.json"),
    JSON.stringify({ schemaVersion: 1, kind: "relmio-local-root" }),
  );
  const installation = {
    version: 2,
    installId: "1".repeat(32),
    projectName: `relmio-ai-${"2".repeat(32)}`,
    sandboxAlias: `relmio-ai-sandbox-${"3".repeat(32)}`,
    searxngAlias: `relmio-ai-searxng-${"4".repeat(32)}`,
    includeSearxng,
  };
  const plan = {
    kind: "n8n-assistant",
    target: "n8n-ai-assistant",
    label: "n8n AI Assistant tools",
    protocol: "n8n-instance-ai-companion",
    dockerHost: DOCKER_HOST,
    n8nContainerId: "5".repeat(64),
    n8nContainerName: "fixture-n8n",
    dockerNetworkId: "6".repeat(64),
    networkName: "fixture-shared",
    includeSearxng,
    codeSandbox: true,
    privilegedRunner: true,
    hostPublication: "none",
    managedPath: "~/.relmio/local/n8n-ai-assistant",
    n8nConfigurationRequired: true,
  };
  await writeFile(
    join(installRoot, ".managed-by-relmio.json"),
    JSON.stringify({
      schemaVersion: 1,
      kind: "relmio-local-n8n-assistant",
      target: "n8n-ai-assistant",
      plan,
      installation,
    }),
  );
  await writeFile(
    join(installRoot, ".env"),
    [
      `SANDBOX_API_KEYS=${"A".repeat(43)}`,
      `SANDBOX_API_RUNNER_REGISTRATION_TOKEN=${"B".repeat(43)}`,
      `SANDBOX_API_RUNNER_API_KEY=${"C".repeat(43)}`,
      `SEARXNG_SECRET=${"D".repeat(43)}`,
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  await writeFile(join(installRoot, "docker-compose.yml"), "services: {}\n");
  if (includeSearxng) {
    await writeFile(join(installRoot, "searxng-settings.yml"), "use_default_settings: true\n");
  }
  return { homeDirectory: canonicalHome, installation, plan };
}

function createAssistantInventoryRunner(
  installation,
  {
    plan,
    state = "running",
    health = state === "running" ? "healthy" : "",
    foreign = false,
    missing = false,
    n8nNameDrift = false,
    networkDrift = false,
  } = {},
) {
  const calls = [];
  const prefix = `relmio-ai-${installation.installId.slice(0, 16)}-`;
  const containers = [
    `${prefix}certs`,
    `${prefix}api`,
    `${prefix}runner`,
    ...(installation.includeSearxng ? [`${prefix}search`] : []),
  ];
  const labels = [
    `com.docker.compose.project=${installation.projectName}`,
    `io.relmio.ai-assistant.managed=${foreign ? "false" : "true"}`,
    `io.relmio.ai-assistant.install-id=${installation.installId}`,
  ].join(",");
  const records = [
    "relmio-sandbox-api",
    "relmio-sandbox-runner-1",
    ...(installation.includeSearxng ? ["relmio-searxng"] : []),
  ].map((service) => ({
    Service: service,
    State: state,
    Health: service === "relmio-sandbox-api" ? health : "",
    Publishers: [],
  }));
  const reviewedPlan = plan ?? {
    dockerHost: DOCKER_HOST,
    n8nContainerId: "5".repeat(64),
    n8nContainerName: "fixture-n8n",
    dockerNetworkId: "6".repeat(64),
    networkName: "fixture-shared",
  };
  const n8nInspect = {
    Id: reviewedPlan.n8nContainerId,
    Name: n8nNameDrift ? "/drifted-n8n" : `/${reviewedPlan.n8nContainerName}`,
    Config: { Image: "n8nio/n8n:1.120.0" },
    State: { Running: true },
    NetworkSettings: {
      Networks: {
        [reviewedPlan.networkName]: {
          NetworkID: networkDrift ? "7".repeat(64) : reviewedPlan.dockerNetworkId,
        },
      },
    },
  };
  const networkInspect = {
    Id: networkDrift ? "7".repeat(64) : reviewedPlan.dockerNetworkId,
    Name: reviewedPlan.networkName,
    Driver: "bridge",
    Scope: "local",
    Internal: false,
    Labels: {},
    Containers: {
      [reviewedPlan.n8nContainerId]: { Name: reviewedPlan.n8nContainerName },
    },
  };
  const runner = async (spec) => {
    calls.push(spec);
    const command = spec.args.join(" ");
    if (command === "context inspect --format {{json .Endpoints.docker.Host}}") {
      return { code: 0, stdout: `${JSON.stringify(DOCKER_HOST)}\n`, stderr: "" };
    }
    if (command === "context show") {
      return { code: 0, stdout: "desktop-linux\n", stderr: "" };
    }
    if (command === "version --format {{.Server.Version}}") {
      return { code: 0, stdout: "28.3.3\n", stderr: "" };
    }
    if (command === "compose version --short") {
      return { code: 0, stdout: "2.39.1\n", stderr: "" };
    }
    if (command === "ps --filter status=running --format {{json .}}") {
      return {
        code: 0,
        stdout: `${JSON.stringify({ ID: reviewedPlan.n8nContainerId, Image: "n8nio/n8n:1.120.0" })}\n`,
        stderr: "",
      };
    }
    if (command === `container inspect --format {{json .}} ${reviewedPlan.n8nContainerId}`) {
      return { code: 0, stdout: JSON.stringify(n8nInspect), stderr: "" };
    }
    if (command === `network inspect --format {{json .}} ${reviewedPlan.networkName}`) {
      return { code: 0, stdout: JSON.stringify(networkInspect), stderr: "" };
    }
    if (command.startsWith("container ls -a")) {
      return {
        code: 0,
        stdout: missing ? "" : containers.map((Names) => JSON.stringify({ Names, Labels: labels })).join("\n"),
        stderr: "",
      };
    }
    if (command.startsWith("network ls")) {
      return {
        code: 0,
        stdout: missing ? "" : JSON.stringify({ Name: `${installation.projectName}-internal`, Labels: labels }),
        stderr: "",
      };
    }
    if (command.startsWith("volume ls")) {
      return {
        code: 0,
        stdout: missing ? "" : JSON.stringify({ Name: `${installation.projectName}-sandbox-tls`, Labels: labels }),
        stderr: "",
      };
    }
    if (command.includes("ps --all --format json")) {
      return {
        code: 0,
        stdout: missing ? "" : records.map((record) => JSON.stringify(record)).join("\n"),
        stderr: "sk-assistant-secret-canary",
      };
    }
    return { code: 1, stdout: "", stderr: "unexpected" };
  };
  runner.calls = calls;
  return runner;
}

test("both Codex targets derive sign-in after exact Docker rediscovery", async (t) => {
  for (const target of ["codex-chatgpt", "codex-chat"]) {
    await t.test(target, async (subtest) => {
      const homeDirectory = await createManagedRoot(subtest, target);
      const runProcess = createEndpointInventoryRunner({ target });
      const rediscovered = await getManagedLocalEndpointStatus(
        { target },
        { homeDirectory, env: {}, runProcess },
      );
      assert.equal(rediscovered.state, "healthy");
      const dashboard = await getLocalDashboardStatus({
        getDockerStatus: async () => ({ dockerAvailable: false }),
        inspectLocalEndpoint: async ({ target: requestedTarget }) => requestedTarget === target
          ? rediscovered
          : { target: requestedTarget, managed: false, state: "absent" },
        inspectLocalN8nStack: async () => ({ managed: false, state: "absent" }),
        inspectLocalN8nSidecar: async () => ({ managed: false, state: "absent" }),
        inspectLocalN8nAssistant: async () => ({ managed: false, state: "absent" }),
      });
      assert.deepEqual(
        dashboard.services.find((service) => service.target === target).actions,
        ["sign-in-chatgpt", "sign-out-chatgpt", "rotate-local-capability"],
      );
      assertReadOnlyDockerCalls(runProcess.calls);
    });
  }
});

test("local dashboard rejects malformed snapshots instead of reflecting unknown fields", async () => {
  const result = await getLocalDashboardStatus({
    getDockerStatus: async () => ({ dockerAvailable: false, rawError: "secret" }),
    inspectLocalEndpoint: async ({ target }) => ({
      target,
      managed: true,
      state: "healthy",
      snapshot: { target, endpoint: "https://attacker.example", auth: {} },
    }),
    inspectLocalN8nStack: async () => ({ managed: false, state: "absent" }),
    inspectLocalN8nSidecar: async () => ({ managed: false, state: "absent" }),
    inspectLocalN8nAssistant: async () => ({ managed: false, state: "absent" }),
  });

  assert.deepEqual(result.docker, {
    available: false,
    version: null,
    composeVersion: null,
  });
  assert.deepEqual(
    result.services.slice(0, 3).map(({ state }) => state),
    ["unavailable", "unavailable", "unavailable"],
  );
});

test("restarted Codex Chat remains partial while its generated healthcheck is starting", async (t) => {
  const homeDirectory = await createManagedRoot(t, "codex-chat");
  const runProcess = createEndpointInventoryRunner({
    target: "codex-chat",
    state: "running",
    health: "starting",
  });
  const result = await getManagedLocalEndpointStatus(
    { target: "codex-chat" },
    { homeDirectory, env: {}, runProcess },
  );
  assert.deepEqual(result, {
    target: "codex-chat",
    managed: true,
    state: "partial",
  });
  assertReadOnlyDockerCalls(runProcess.calls);
});

test("OAuth bridge inventory reports healthy, stopped, partial, and foreign states read-only", async (t) => {
  const { homeDirectory, marker } = await createManagedSidecarRoot(t);
  for (const [options, expected] of [
    [{}, "healthy"],
    [{ running: false }, "stopped"],
    [{ missing: true }, "partial"],
    [{ foreign: true }, "unavailable"],
  ]) {
    const runProcess = createSidecarInventoryRunner(marker, options);
    const result = await getLocalN8nSidecarStatus({
      homeDirectory,
      env: {},
      runProcess,
    });
    assert.equal(result.state, expected);
    if (expected === "unavailable") {
      assert.equal(result.managed, false);
      assert.equal(result.snapshot, undefined);
    } else if (expected === "partial") {
      assert.equal(result.managed, true);
      assert.equal(result.snapshot, undefined);
    } else {
      assert.equal(result.managed, true);
      assert.deepEqual(result.snapshot, {
        target: "n8n-openai-oauth",
        endpoint: "http://n8n-openai-oauth:10531/v1",
        auth: { configured: true, disclosure: "server-managed" },
        canRefreshCredential: true,
        canRemove: true,
      });
    }
    assert.equal(JSON.stringify(result).includes("secret-canary"), false);
    assert.equal(JSON.stringify(result).includes(marker.installId), false);
    assertReadOnlyDockerCalls(runProcess.calls);
  }
});

test("OAuth bridge status re-attests n8n/network identity and health without refresh actions", async (t) => {
  const { homeDirectory, marker } = await createManagedSidecarRoot(t);
  for (const options of [
    { health: "starting" },
    { health: "unhealthy" },
    { state: "restarting", health: "starting" },
    { state: "dead", health: "unhealthy" },
  ]) {
    const runProcess = createSidecarInventoryRunner(marker, options);
    const result = await getLocalN8nSidecarStatus({ homeDirectory, env: {}, runProcess });
    assert.equal(result.state, "partial");
    assert.equal(result.snapshot, undefined);
    assertReadOnlyDockerCalls(runProcess.calls);
  }
  for (const options of [
    { n8nNameDrift: true },
    { networkDrift: true },
    { aliasDrift: true },
  ]) {
    const runProcess = createSidecarInventoryRunner(marker, options);
    assert.deepEqual(
      await getLocalN8nSidecarStatus({ homeDirectory, env: {}, runProcess }),
      { target: "n8n-openai-oauth", managed: false, state: "unavailable" },
    );
    assertReadOnlyDockerCalls(runProcess.calls);
  }
});

test("Assistant inventory validates its private environment and owned resources read-only", async (t) => {
  const { homeDirectory, installation, plan } = await createManagedAssistantRoot(t);
  for (const [options, expected] of [
    [{}, "healthy"],
    [{ state: "exited" }, "stopped"],
    [{ missing: true }, "partial"],
    [{ foreign: true }, "unavailable"],
  ]) {
    const runProcess = createAssistantInventoryRunner(installation, { plan, ...options });
    const result = await getLocalN8nAssistantStatus({
      homeDirectory,
      env: {},
      runProcess,
    });
    assert.equal(result.state, expected);
    if (expected === "unavailable") {
      assert.equal(result.managed, false);
      assert.equal(result.snapshot, undefined);
    } else if (expected === "partial") {
      assert.equal(result.managed, true);
      assert.equal(result.snapshot, undefined);
    } else {
      assert.equal(result.managed, true);
      assert.deepEqual(result.snapshot, {
        target: "local-n8n-assistant",
        components: { codeSandbox: true, searxng: true },
        auth: { sandboxConfigured: true, disclosure: "one-time" },
        canRemove: true,
      });
    }
    assert.equal(JSON.stringify(result).includes("secret-canary"), false);
    assert.equal(JSON.stringify(result).includes(installation.installId), false);
    assert.equal(JSON.stringify(result).includes("A".repeat(43)), false);
    assertReadOnlyDockerCalls(runProcess.calls);
  }
});

test("Assistant status re-attests its reviewed n8n target and generated healthchecks", async (t) => {
  const { homeDirectory, installation, plan } = await createManagedAssistantRoot(t);
  for (const options of [
    { health: "starting" },
    { health: "unhealthy" },
    { state: "restarting", health: "starting" },
    { state: "dead", health: "unhealthy" },
  ]) {
    const runProcess = createAssistantInventoryRunner(installation, { plan, ...options });
    const result = await getLocalN8nAssistantStatus({ homeDirectory, env: {}, runProcess });
    assert.equal(result.state, "partial");
    assert.equal(result.snapshot, undefined);
    assertReadOnlyDockerCalls(runProcess.calls);
  }
  for (const options of [{ n8nNameDrift: true }, { networkDrift: true }]) {
    const runProcess = createAssistantInventoryRunner(installation, { plan, ...options });
    assert.deepEqual(
      await getLocalN8nAssistantStatus({ homeDirectory, env: {}, runProcess }),
      { target: "local-n8n-assistant", managed: false, state: "unavailable" },
    );
    assertReadOnlyDockerCalls(runProcess.calls);
  }
});

test("standalone n8n inventories do not query Docker when their managed paths are absent", async (t) => {
  const temporaryHome = await mkdtemp(join(tmpdir(), "relmio-dashboard-absent-"));
  t.after(() => rm(temporaryHome, { recursive: true, force: true }));
  const homeDirectory = await realpath(temporaryHome);
  const runProcess = async () => {
    throw new Error("Docker must not be queried");
  };
  assert.deepEqual(
    await getLocalN8nSidecarStatus({ homeDirectory, env: {}, runProcess }),
    { target: "n8n-openai-oauth", managed: false, state: "absent" },
  );
  assert.deepEqual(
    await getLocalN8nAssistantStatus({ homeDirectory, env: {}, runProcess }),
    { target: "local-n8n-assistant", managed: false, state: "absent" },
  );
});

test("Assistant inventory fails closed when its private environment is malformed", async (t) => {
  const { homeDirectory, installation } = await createManagedAssistantRoot(t);
  await writeFile(
    join(homeDirectory, ".relmio", "local", "n8n-ai-assistant", ".env"),
    "SANDBOX_API_KEYS=sk-secret-canary\n",
    { mode: 0o600 },
  );
  const result = await getLocalN8nAssistantStatus({
    homeDirectory,
    env: {},
    runProcess: createAssistantInventoryRunner(installation),
  });
  assert.deepEqual(result, {
    target: "local-n8n-assistant",
    managed: false,
    state: "unavailable",
  });
  assert.equal(JSON.stringify(result).includes("secret-canary"), false);
});


test("OAuth dashboard contract has exactly seven services and four runtime-owned providers", async () => {
  const status = await getLocalDashboardStatus({
    inspectLocalEndpoint: async ({ target }) => ({ managed: false, state: "absent", snapshot: null }),
    inspectLocalN8nStack: async () => ({ managed: false, state: "absent", snapshot: null }),
    inspectLocalN8nSidecar: async () => ({ managed: false, state: "absent", snapshot: null }),
    inspectLocalN8nAssistant: async () => ({ managed: false, state: "absent", snapshot: null }),
    inspectLocalN8nSuperGrok: async () => ({ managed: false, state: "absent", snapshot: null }),
  });
  assert.deepEqual(status.services.map(({ target }) => target), ["codex-chatgpt", "codex-chat", "xai-grok-build", "local-n8n-stack", "n8n-openai-oauth", "local-n8n-assistant", "n8n-supergrok-oauth"]);
  assert.deepEqual(status.providers, [
    { target: "codex-chatgpt", label: "ChatGPT", authentication: "provider-oauth", readiness: "runtime-owned" },
    { target: "codex-chat", label: "ChatGPT", authentication: "provider-oauth", readiness: "runtime-owned" },
    { target: "xai-grok-build", label: "SuperGrok", authentication: "provider-oauth", readiness: "runtime-owned" },
    { target: "n8n-supergrok-oauth", label: "SuperGrok (n8n)", authentication: "provider-oauth", readiness: "runtime-owned" },
  ]);
  assert.equal(JSON.stringify(status).includes("api-key"), false);
});

test("private SuperGrok inventory keeps provider readiness neutral and strips secret fields", async () => {
  const snapshot = { target: "n8n-supergrok-oauth", endpoint: "http://n8n-supergrok:14502/v1", auth: { configured: true, disclosure: "one-time" }, canRemove: true };
  const inspectors = {
    getDockerStatus: async () => ({ dockerAvailable: false }),
    inspectLocalEndpoint: async () => ({ managed: false, state: "absent" }),
    inspectLocalN8nStack: async () => ({ managed: false, state: "absent" }),
    inspectLocalN8nSidecar: async () => ({ managed: false, state: "absent" }),
    inspectLocalN8nAssistant: async () => ({ managed: false, state: "absent" }),
  };
  const read = async (value) => getLocalDashboardStatus({ ...inspectors, inspectLocalN8nSuperGrok: async () => value });
  const status = await read({ managed: true, state: "healthy", snapshot: { ...snapshot, token: "secret-must-not-escape" } });
  const entry = status.services.find(item => item.target === snapshot.target);
  assert.deepEqual(entry.snapshot, snapshot);
  assert.deepEqual(entry.actions, ["sign-in-grok-build", "sign-out-grok-build", "remove-owned-supergrok"]);
  assert.equal(status.providers.find(item => item.target === snapshot.target).readiness, "runtime-owned");
  assert.equal(JSON.stringify(status).includes("secret-must-not-escape"), false);
  for (const badSnapshot of [{ ...snapshot, endpoint: "http://evil:14502/v1" }, { ...snapshot, auth: { configured: true, disclosure: "server-managed" } }]) {
    const invalid = await read({ managed: true, state: "healthy", snapshot: badSnapshot });
    assert.equal(invalid.services.find(item => item.target === snapshot.target).state, "unavailable");
  }
  const stopped = await read({ managed: true, state: "stopped", snapshot });
  assert.deepEqual(stopped.services.find(item => item.target === snapshot.target).actions, ["remove-owned-supergrok"]);
});

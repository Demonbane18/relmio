import assert from "node:assert/strict";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { getLocalDashboardStatus } from "../src/services/local-dashboard.js";
import { getManagedLocalEndpointStatus } from "../src/services/local-installer.js";
import { getLocalN8nSidecarStatus } from "../src/services/local-n8n-sidecar-installer.js";
import { getLocalN8nAssistantStatus } from "../src/services/local-n8n-assistant-installer.js";

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

test("local dashboard returns a fixed sanitized inventory and isolates leaf failures", async () => {
  const secret = "sk-secret-canary";
  const result = await getLocalDashboardStatus({
    now: () => new Date("2026-09-04T00:00:00.000Z"),
    getDockerStatus: async () => ({
      dockerAvailable: true,
      dockerVersion: "28.3.3",
      composeVersion: "2.39.1",
      dockerHost: "unix:///secret/docker.sock",
    }),
    inspectLocalEndpoint: async ({ target }) => {
      if (target === "codex-chatgpt") throw new Error(`${secret}: raw Docker failure`);
      return {
        target,
        managed: true,
        state: "healthy",
        snapshot: {
          target,
          endpoint: target === "openai-api"
            ? "http://127.0.0.1:10531/v1"
            : "http://127.0.0.1:14501",
          auth: { configured: true, disclosure: "rotate-only", token: secret },
          canRotateCredential: true,
          installId: secret,
        },
      };
    },
    inspectLocalN8nStack: async () => ({
      target: "local-n8n-stack",
      managed: true,
      state: "stopped",
      snapshot: {
        target: "local-n8n-stack",
        assistantMode: "sandbox-with-searxng",
        endpoints: {
          n8nLocal: "http://127.0.0.1:80",
          ngrokPublic: "https://example.ngrok-free.app",
          ngrokInspector: "http://127.0.0.1:81",
          secret,
        },
        components: { n8n: true, ngrok: true, codeSandbox: true, searxng: true },
        canResume: true,
        canRemove: true,
        projectName: secret,
      },
    }),
    inspectLocalN8nSidecar: async () => ({ managed: false, state: "absent" }),
    inspectLocalN8nAssistant: async () => ({
      managed: true,
      state: "healthy",
      snapshot: {
        target: "local-n8n-assistant",
        components: { codeSandbox: true, searxng: false },
        auth: { sandboxConfigured: true, disclosure: "one-time", token: secret },
        canRemove: true,
      },
    }),
  });

  assert.equal(result.schemaVersion, 1);
  assert.equal(result.generatedAt, "2026-09-04T00:00:00.000Z");
  assert.deepEqual(result.docker, {
    available: true,
    version: "28.3.3",
    composeVersion: "2.39.1",
  });
  assert.deepEqual(result.auth, { secretsRevealable: false });
  assert.deepEqual(
    result.services.map(({ target, state }) => ({ target, state })),
    [
      { target: "openai-api", state: "healthy" },
      { target: "codex-chatgpt", state: "unavailable" },
      { target: "codex-chat", state: "healthy" },
      { target: "local-n8n-stack", state: "stopped" },
      { target: "n8n-openai-oauth", state: "absent" },
      { target: "local-n8n-assistant", state: "healthy" },
    ],
  );
  assert.equal(result.services[1].managed, false);
  assert.equal(result.services[1].snapshot, null);
  assert.deepEqual(result.services[1].actions, []);
  assert.deepEqual(
    result.services.map(({ actions }) => actions),
    [
      ["rotate-credential"],
      [],
      ["sign-in", "rotate-credential"],
      ["resume", "remove"],
      ["setup"],
      ["remove"],
    ],
  );
  assert.deepEqual(result.services[3].snapshot.endpoints, {
    n8nLocal: "http://127.0.0.1:80",
    ngrokPublic: "https://example.ngrok-free.app",
    ngrokInspector: "http://127.0.0.1:81",
  });
  assert.equal(JSON.stringify(result).includes(secret), false);
  assert.equal(JSON.stringify(result).includes("docker.sock"), false);
  assert.equal(JSON.stringify(result).includes("projectName"), false);
});

test("local dashboard derives sign-in only for healthy attested Codex endpoints", async (t) => {
  const endpointSnapshot = (target) => ({
    target,
    endpoint: target === "codex-chatgpt"
      ? "ws://127.0.0.1:14500"
      : target === "codex-chat"
        ? "http://127.0.0.1:14501"
        : "http://127.0.0.1:10531/v1",
    auth: { configured: true, disclosure: "rotate-only" },
    canRotateCredential: true,
  });
  const scenarios = [
    { state: "healthy", expected: ["sign-in", "rotate-credential"] },
    { state: "stopped", expected: [] },
    { state: "partial", expected: [] },
    { state: "unavailable", expected: [] },
    { state: "absent", expected: ["setup"] },
  ];
  for (const target of ["codex-chatgpt", "codex-chat"]) {
    for (const scenario of scenarios) {
      await t.test(`${target}-${scenario.state}`, async () => {
        const result = await getLocalDashboardStatus({
          getDockerStatus: async () => ({ dockerAvailable: false }),
          inspectLocalEndpoint: async ({ target: requestedTarget }) => {
            if (requestedTarget === "openai-api") {
              return {
                target: requestedTarget,
                managed: true,
                state: "healthy",
                snapshot: endpointSnapshot(requestedTarget),
              };
            }
            if (requestedTarget !== target) {
              return { target: requestedTarget, managed: false, state: "absent" };
            }
            if (scenario.state === "absent" || scenario.state === "unavailable") {
              return { target, managed: false, state: scenario.state };
            }
            if (scenario.state === "partial") {
              return { target, managed: true, state: "partial" };
            }
            return {
              target,
              managed: true,
              state: scenario.state,
              snapshot: endpointSnapshot(target),
            };
          },
          inspectLocalN8nStack: async () => ({ managed: false, state: "absent" }),
          inspectLocalN8nSidecar: async () => ({ managed: false, state: "absent" }),
          inspectLocalN8nAssistant: async () => ({ managed: false, state: "absent" }),
        });
        const selected = result.services.find((service) => service.target === target);
        const openAi = result.services.find((service) => service.target === "openai-api");
        assert.deepEqual(selected.actions, scenario.expected);
        assert.deepEqual(openAi.actions, ["rotate-credential"]);
        assert.equal(openAi.actions.includes("sign-in"), false);
      });
    }
  }

  const unsafe = await getLocalDashboardStatus({
    getDockerStatus: async () => ({ dockerAvailable: false }),
    inspectLocalEndpoint: async ({ target }) => target === "codex-chat"
      ? {
          target,
          managed: true,
          state: "healthy",
          snapshot: {
            ...endpointSnapshot(target),
            endpoint: "https://attacker.example",
            canSignIn: true,
          },
        }
      : { target, managed: false, state: "absent" },
    inspectLocalN8nStack: async () => ({ managed: false, state: "absent" }),
    inspectLocalN8nSidecar: async () => ({ managed: false, state: "absent" }),
    inspectLocalN8nAssistant: async () => ({ managed: false, state: "absent" }),
  });
  const unsafeCodex = unsafe.services.find((service) => service.target === "codex-chat");
  assert.equal(unsafeCodex.state, "unavailable");
  assert.deepEqual(unsafeCodex.actions, []);
  assert.equal(JSON.stringify(unsafeCodex).includes("canSignIn"), false);
});

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
        ["sign-in", "rotate-credential"],
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

test("local dashboard fails closed on a contradictory absent inspection", async () => {
  const result = await getLocalDashboardStatus({
    getDockerStatus: async () => ({ dockerAvailable: false }),
    inspectLocalEndpoint: async ({ target }) => target === "openai-api"
      ? {
          target,
          managed: true,
          state: "absent",
          snapshot: { target, endpoint: "http://127.0.0.1:12435/v1" },
        }
      : { target, managed: false, state: "absent" },
    inspectLocalN8nStack: async () => ({ managed: false, state: "absent" }),
    inspectLocalN8nSidecar: async () => ({ managed: false, state: "absent" }),
    inspectLocalN8nAssistant: async () => ({ managed: false, state: "absent" }),
  });

  assert.deepEqual(result.services[0], {
    target: "openai-api",
    label: "OpenAI API",
    kind: "endpoint",
    managed: false,
    state: "unavailable",
    snapshot: null,
    actions: [],
  });
});

test("local dashboard preserves a non-exact partial state without exposing capabilities", async () => {
  const result = await getLocalDashboardStatus({
    getDockerStatus: async () => ({ dockerAvailable: false }),
    inspectLocalEndpoint: async ({ target }) =>
      target === "openai-api"
        ? { target, managed: true, state: "partial" }
        : { target, managed: false, state: "absent" },
    inspectLocalN8nStack: async () => ({ managed: false, state: "absent" }),
    inspectLocalN8nSidecar: async () => ({ managed: false, state: "absent" }),
    inspectLocalN8nAssistant: async () => ({ managed: false, state: "absent" }),
  });

  assert.deepEqual(result.services[0], {
    target: "openai-api",
    label: "OpenAI API",
    kind: "endpoint",
    managed: true,
    state: "partial",
    snapshot: null,
    actions: [],
  });
});

test("generic endpoint inventory rediscovers only strictly owned resources without mutations", async (t) => {
  const emptyHome = await mkdtemp(join(tmpdir(), "relmio-dashboard-empty-"));
  t.after(() => rm(emptyHome, { recursive: true, force: true }));
  assert.deepEqual(
    await getManagedLocalEndpointStatus(
      { target: "openai-api" },
      { homeDirectory: await realpath(emptyHome), env: {} },
    ),
    { target: "openai-api", managed: false, state: "absent" },
  );

  const homeDirectory = await createManagedRoot(t, "openai-api");
  for (const [dockerState, expected] of [
    ["running", "healthy"],
    ["exited", "stopped"],
    ["restarting", "partial"],
  ]) {
    const runProcess = createEndpointInventoryRunner({ state: dockerState });
    const result = await getManagedLocalEndpointStatus(
      { target: "openai-api" },
      { homeDirectory, env: {}, runProcess },
    );
    assert.equal(result.state, expected);
    assert.equal(result.managed, true);
    if (expected === "partial") {
      assert.equal(result.snapshot, undefined);
    } else {
      assert.deepEqual(result.snapshot, {
        target: "openai-api",
        endpoint: "http://127.0.0.1:12435/v1",
        auth: { configured: true, disclosure: "rotate-only" },
        canRotateCredential: true,
      });
    }
    assert.equal(JSON.stringify(result).includes("secret-canary"), false);
    assertReadOnlyDockerCalls(runProcess.calls);
  }

  const partial = await getManagedLocalEndpointStatus(
    { target: "openai-api" },
    { homeDirectory, env: {}, runProcess: createEndpointInventoryRunner({ missing: true }) },
  );
  assert.equal(partial.state, "partial");

  const foreign = await getManagedLocalEndpointStatus(
    { target: "openai-api" },
    { homeDirectory, env: {}, runProcess: createEndpointInventoryRunner({ foreign: true }) },
  );
  assert.deepEqual(foreign, {
    target: "openai-api",
    managed: false,
    state: "unavailable",
  });
});

test("generic endpoint status requires exact generated names and logical Compose identities", async (t) => {
  const homeDirectory = await createManagedRoot(t, "openai-api");
  for (const options of [
    { wrongContainerName: true },
    { wrongNetworkName: true },
    { wrongVolumeName: true },
    { wrongServiceLabel: true },
    { wrongNetworkLabel: true },
    { wrongVolumeLabel: true },
    { duplicateResource: "container" },
    { duplicateResource: "network" },
    { duplicateResource: "volume" },
    { duplicateStatus: true },
    { wrongStatusService: true },
    { wrongStatusName: true },
  ]) {
    const runProcess = createEndpointInventoryRunner(options);
    assert.deepEqual(
      await getManagedLocalEndpointStatus(
        { target: "openai-api" },
        { homeDirectory, env: {}, runProcess },
      ),
      { target: "openai-api", managed: false, state: "unavailable" },
    );
    assertReadOnlyDockerCalls(runProcess.calls);
  }
});

test("generic endpoint status exposes no rotation action until generated healthchecks are healthy", async (t) => {
  const homeDirectory = await createManagedRoot(t, "openai-api");
  for (const options of [
    { health: "starting" },
    { health: "unhealthy" },
    { health: "" },
    { state: "restarting", health: "starting" },
    { state: "dead", health: "unhealthy" },
  ]) {
    const runProcess = createEndpointInventoryRunner(options);
    const result = await getManagedLocalEndpointStatus(
      { target: "openai-api" },
      { homeDirectory, env: {}, runProcess },
    );
    assert.equal(result.state, "partial");
    assert.equal(result.snapshot, undefined);
    assert.equal(JSON.stringify(result).includes("secret-canary"), false);
    assertReadOnlyDockerCalls(runProcess.calls);
  }
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

test("generic endpoint inventory fails closed on a malformed managed marker", async (t) => {
  const homeDirectory = await createManagedRoot(t, "openai-api", { projectName: "foreign" });
  const result = await getManagedLocalEndpointStatus(
    { target: "openai-api" },
    { homeDirectory, env: {}, runProcess: createEndpointInventoryRunner() },
  );
  assert.deepEqual(result, {
    target: "openai-api",
    managed: false,
    state: "unavailable",
  });
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

test("Windows status checks verify managed ACLs without normalizing or querying Docker on failure", async (t) => {
  const endpointHome = await createManagedRoot(t, "openai-api");
  const sidecar = await createManagedSidecarRoot(t);
  const assistant = await createManagedAssistantRoot(t);
  await writeFile(
    join(endpointHome, ".relmio", "local", "openai-api", "docker-compose.yml"),
    "services: {}\n",
  );
  await writeFile(
    join(sidecar.homeDirectory, ".relmio", "local", "n8n-openai-oauth", "docker-compose.yml"),
    "services: {}\n",
  );
  await writeFile(
    join(assistant.homeDirectory, ".relmio", "local", "n8n-ai-assistant", "docker-compose.yml"),
    "services: {}\n",
  );
  const dockerCalls = [];
  const runProcess = async (spec) => {
    dockerCalls.push(spec);
    throw new Error("Docker must not be queried after an unsafe ACL");
  };
  const cases = [
    {
      sensitiveSuffix: "docker-compose.yml",
      invoke: (lockDownPath) => getManagedLocalEndpointStatus(
        { target: "openai-api" },
        { homeDirectory: endpointHome, env: {}, platform: "win32", lockDownPath, runProcess },
      ),
      expected: { target: "openai-api", managed: false, state: "unavailable" },
    },
    {
      sensitiveSuffix: "docker-compose.yml",
      invoke: (lockDownPath) => getLocalN8nSidecarStatus({
        homeDirectory: sidecar.homeDirectory,
        env: {},
        platform: "win32",
        lockDownPath,
        runProcess,
      }),
      expected: { target: "n8n-openai-oauth", managed: false, state: "unavailable" },
    },
    {
      sensitiveSuffix: ".env",
      invoke: (lockDownPath) => getLocalN8nAssistantStatus({
        homeDirectory: assistant.homeDirectory,
        env: {},
        platform: "win32",
        lockDownPath,
        runProcess,
      }),
      expected: { target: "local-n8n-assistant", managed: false, state: "unavailable" },
    },
  ];
  for (const entry of cases) {
    const aclCalls = [];
    const lockDownPath = async (path, options) => {
      aclCalls.push({ path, options });
      assert.equal(options.platform, "win32");
      assert.equal(options.verifyOnly, true);
      if (path.endsWith(entry.sensitiveSuffix)) {
        throw new Error("unsafe owner ACL");
      }
    };
    assert.deepEqual(await entry.invoke(lockDownPath), entry.expected);
    assert.equal(aclCalls.some(({ options }) => options.kind === "file"), true);
    assert.equal(aclCalls.some(({ path }) => path.endsWith(entry.sensitiveSuffix)), true);
  }
  assert.deepEqual(dockerCalls, []);
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

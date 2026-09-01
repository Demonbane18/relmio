import assert from "node:assert/strict";
import * as nodeFileSystem from "node:fs/promises";
import {
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  LOCAL_N8N_ASSISTANT_TARGET,
  createLocalN8nAssistantPlan,
  normalizeLocalN8nAssistantPlan,
} from "../src/domain/local-n8n-assistant.js";
import {
  createAssistantInstallation,
  getAssistantContainerNames,
} from "../src/domain/assistant.js";
import {
  ASSISTANT_COMPANION_IMAGES,
  createAssistantComposeFile,
  createSearxngSettings,
} from "../src/domain/assistant-templates.js";
import {
  editLocalN8nAssistantSearxng,
  installLocalN8nAssistant,
  prepareLocalN8nAssistantSearxngUpdate,
  removeLocalN8nAssistant,
  resolveLocalN8nAssistantInstallRoot,
} from "../src/services/local-n8n-assistant-installer.js";

const DOCKER_HOST = "unix:///var/run/docker.sock";
const WINDOWS_DOCKER_HOST = "npipe:////./pipe/dockerDesktopLinuxEngine";
const N8N_ID = "a".repeat(64);
const NETWORK_ID = "b".repeat(64);

async function createTestHome(t) {
  const path = await mkdtemp(join(tmpdir(), "relmio-local-assistant-test-"));
  t.after(() => rm(path, { recursive: true, force: true }));
  return realpath(path);
}

function dockerResult(stdout = "", code = 0) {
  return { stdout, stderr: code === 0 ? "" : "not found", code };
}

function createRunner({
  published = false,
  internalNetwork = false,
  invalidSearch = false,
  publicationRecords,
  reservedAlias = null,
  searxngAliasCollision = false,
  searxngContainerCollision = false,
  searxngStartFailure = false,
  searxngRollbackFailure = false,
  upFailure = null,
  contextHost = DOCKER_HOST,
} = {}) {
  const calls = [];
  let installed = false;
  let removed = false;
  let resourceMode = "full";
  let foreignOwnership = false;
  let projectName = null;
  let installId = null;
  let includeSearxng = false;
  let searxngRunning = false;
  const containerIds = {
    certs: "1".repeat(64),
    api: "2".repeat(64),
    runner: "3".repeat(64),
    search: "4".repeat(64),
  };

  const runner = async (spec) => {
    calls.push(spec);
    const { args } = spec;
    const joined = args.join(" ");

    if (joined === "context inspect --format {{json .Endpoints.docker.Host}}") {
      return dockerResult(`${JSON.stringify(contextHost)}\n`);
    }
    if (joined === "context show") {
      return dockerResult(`${process.platform === "win32" ? "desktop-linux" : "default"}\n`);
    }
    if (joined === "version --format {{.Server.Version}}") {
      return dockerResult("28.3.3\n");
    }
    if (joined === "compose version --short") {
      return dockerResult("2.39.1\n");
    }
    if (args[0] === "ps" && args.includes("status=running")) {
      return dockerResult(`${JSON.stringify({
        ID: N8N_ID.slice(0, 12),
        Image: "docker.n8n.io/n8nio/n8n:2.36.8",
      })}\n`);
    }
    if (joined.includes(`container inspect --format {{json .}} ${N8N_ID.slice(0, 12)}`) ||
        joined.includes(`container inspect --format {{json .}} ${N8N_ID}`)) {
      return dockerResult(`${JSON.stringify({
        Id: N8N_ID,
        Name: "/local-n8n",
        Config: { Image: "docker.n8n.io/n8nio/n8n:2.36.8" },
        State: { Running: true },
        NetworkSettings: {
          Networks: { "local-assistant-shared": {} },
        },
      })}\n`);
    }
    if (joined.includes("network inspect --format {{json .}} local-assistant-shared")) {
      return dockerResult(`${JSON.stringify({
        Id: NETWORK_ID,
        Name: "local-assistant-shared",
        Driver: "bridge",
        Scope: "local",
        Internal: internalNetwork,
        Labels: {},
        Containers: {
          [N8N_ID]: {
            Name: "local-n8n",
            Aliases: [
              "local-n8n",
              ...(reservedAlias === null ? [] : [reservedAlias]),
            ],
          },
          ...(searxngAliasCollision && installId
            ? {
                [`f${"0".repeat(63)}`]: {
                  Name: "foreign-searxng",
                  Aliases: [`relmio-ai-searxng-${"e".repeat(32)}`],
                },
              }
            : {}),
        },
      })}\n`);
    }
    if (args[0] === "compose") {
      const projectIndex = args.indexOf("--project-name");
      if (projectIndex >= 0) projectName = args[projectIndex + 1];
      if (args.includes("config")) {
        const compose = await readFile(join(spec.cwd, "docker-compose.yml"), "utf8");
        installId = compose.match(/io\.relmio\.ai-assistant\.install-id: "([a-f0-9]{32})"/u)?.[1] ?? null;
        includeSearxng = /^\s{2}relmio-searxng:/mu.test(compose);
        return dockerResult();
      }
      if (joined.includes("up -d --wait")) {
        const searxngOnly = args.includes("relmio-searxng");
        if (searxngOnly && searxngStartFailure) {
          searxngRunning = true;
          return dockerResult("", 1);
        }
        if (upFailure === "zero") return dockerResult("", 1);
        installed = true;
        removed = false;
        if (upFailure === "partial") {
          resourceMode = "partial";
          return dockerResult("", 1);
        }
        if (searxngOnly) searxngRunning = true;
        else searxngRunning = includeSearxng;
        return dockerResult();
      }
      if (args.includes("ps") && args.includes("--status") && args.includes("--services")) {
        return dockerResult(installed && !removed
          ? [
              "relmio-sandbox-api",
              "relmio-sandbox-runner-1",
              ...(searxngRunning ? ["relmio-searxng"] : []),
            ].join("\n") + "\n"
          : "");
      }
      if (args.includes("ps") && args.includes("--format") && args.includes("json")) {
        const publishers = published
          ? [{ TargetPort: 8080, PublishedPort: 18080, Protocol: "tcp" }]
          : [];
        const records = publicationRecords ?? [
          { Service: "relmio-sandbox-api", Publishers: publishers },
          { Service: "relmio-sandbox-runner-1", Publishers: [] },
          ...(searxngRunning
            ? [{ Service: "relmio-searxng", Publishers: [] }]
            : []),
        ];
        return dockerResult(
          records.map((entry) => JSON.stringify(entry)).join("\n") +
            (records.length > 0 ? "\n" : ""),
        );
      }
      if (args.includes("exec") && joined.includes("127.0.0.1:8080/healthz")) {
        return dockerResult("ok\n");
      }
      if (args.includes("exec") && joined.includes("format=json")) {
        return dockerResult(invalidSearch ? "not-json" : '{"results":[{"title":"Relmio"}]}\n');
      }
      if (joined.includes("down --volumes --remove-orphans")) {
        installed = false;
        removed = true;
        searxngRunning = false;
        return dockerResult();
      }
    }
    if (args[0] === "container" && args[1] === "rm") {
      if (searxngRollbackFailure) return dockerResult("", 1);
      if (args.at(-1) !== containerIds.search) return dockerResult("", 1);
      searxngRunning = false;
      return dockerResult();
    }
    if (args[0] === "container" && args[1] === "ls") {
      if (args.some((value) => value.startsWith("name="))) {
        if (searxngContainerCollision && args.some((value) => value.includes("search"))) {
          return dockerResult(`${JSON.stringify({ Names: "foreign-searxng", Labels: "" })}\n`);
        }
        if (searxngRunning && args.some((value) => value.includes("search"))) {
          const name = `relmio-ai-${installId?.slice(0, 16)}-search`;
          return dockerResult(`${JSON.stringify({
            ID: containerIds.search,
            Names: name,
            Labels: `com.docker.compose.project=${projectName},com.docker.compose.service=relmio-searxng,io.relmio.ai-assistant.managed=true,io.relmio.ai-assistant.install-id=${installId}`,
          })}\n`);
        }
        return dockerResult();
      }
      const names = [
        "certs",
        "api",
        "runner",
        ...(searxngRunning ? ["search"] : []),
      ];
      const selectedNames = resourceMode === "partial" ? ["api"] : names;
      return dockerResult(installed && !removed
        ? selectedNames.map(
        (service) => `relmio-ai-${installId?.slice(0, 16)}-${service}`,
      ).map((name) => {
        const service = name.split("-").at(-1);
        return JSON.stringify({
            ID: containerIds[service],
            Names: name,
            Labels: `com.docker.compose.project=${projectName},com.docker.compose.service=${service === "search" ? "relmio-searxng" : `relmio-sandbox-${service}`},io.relmio.ai-assistant.managed=${foreignOwnership ? "false" : "true"},io.relmio.ai-assistant.install-id=${installId}`,
          });
      }).join("\n") + "\n"
        : "");
    }
    if (args[0] === "network" && args[1] === "ls") {
      if (args.some((value) => value.startsWith("name="))) return dockerResult();
      return dockerResult(installed && !removed
        ? `${JSON.stringify({
            Name: `${projectName}-internal`,
            Labels: `com.docker.compose.project=${projectName},io.relmio.ai-assistant.managed=true,io.relmio.ai-assistant.install-id=${installId}`,
          })}\n`
        : "");
    }
    if (args[0] === "volume" && args[1] === "ls") {
      if (args.some((value) => value.startsWith("name="))) return dockerResult();
      return dockerResult(installed && !removed
        ? `${JSON.stringify({
            Name: `${projectName}-sandbox-tls`,
            Labels: `com.docker.compose.project=${projectName},io.relmio.ai-assistant.managed=true,io.relmio.ai-assistant.install-id=${installId}`,
          })}\n`
        : "");
    }
    return dockerResult();
  };
  runner.calls = calls;
  runner.setForeignOwnership = (value) => {
    foreignOwnership = value;
  };
  runner.setResourceMode = (value) => {
    resourceMode = value;
  };
  return runner;
}

function createPlan(overrides = {}) {
  return createLocalN8nAssistantPlan({
    dockerHost: DOCKER_HOST,
    n8nContainerId: N8N_ID,
    n8nContainerName: "local-n8n",
    dockerNetworkId: NETWORK_ID,
    networkName: "local-assistant-shared",
    includeSearxng: false,
    ...overrides,
  });
}

test("local n8n Assistant plan binds the exact private Docker boundary", () => {
  assert.deepEqual(createPlan(), {
    kind: "n8n-assistant",
    target: LOCAL_N8N_ASSISTANT_TARGET,
    label: "n8n AI Assistant tools",
    protocol: "n8n-instance-ai-companion",
    dockerHost: DOCKER_HOST,
    n8nContainerId: N8N_ID,
    n8nContainerName: "local-n8n",
    dockerNetworkId: NETWORK_ID,
    networkName: "local-assistant-shared",
    includeSearxng: false,
    codeSandbox: true,
    privilegedRunner: true,
    hostPublication: "none",
    managedPath: "~/.relmio/local/n8n-ai-assistant",
    n8nConfigurationRequired: true,
  });
});

test("local n8n Assistant plan rejects drift and requires an explicit SearXNG choice", () => {
  assert.throws(
    () => createPlan({ includeSearxng: undefined }),
    /SearXNG|choose/iu,
  );
  assert.throws(
    () => createPlan({ dockerHost: "tcp://attacker.test:2375" }),
    /Unix socket|Docker/iu,
  );
  assert.throws(
    () => createPlan({ networkName: "network\n--privileged" }),
    /invalid/iu,
  );
  assert.throws(
    () =>
      normalizeLocalN8nAssistantPlan({
        ...createPlan(),
        hostPublication: "127.0.0.1:8080",
      }),
    /plan/iu,
  );
});

test("Assistant artifacts pin the sandbox stack and keep every service private", () => {
  let byte = 0xc0;
  const installation = createAssistantInstallation({
    randomBytes: (size) => Buffer.alloc(size, (byte += 1)),
    includeSearxng: true,
  });
  const compose = createAssistantComposeFile({
    networkName: "local-assistant-shared",
    installation,
  });
  const names = getAssistantContainerNames(installation);

  assert.match(compose, new RegExp(ASSISTANT_COMPANION_IMAGES.api.replaceAll("/", "\\/"), "u"));
  assert.match(compose, new RegExp(ASSISTANT_COMPANION_IMAGES.runner.replaceAll("/", "\\/"), "u"));
  assert.match(compose, new RegExp(ASSISTANT_COMPANION_IMAGES.sandbox.replaceAll("/", "\\/"), "u"));
  assert.match(compose, new RegExp(ASSISTANT_COMPANION_IMAGES.searxng.replaceAll("/", "\\/"), "u"));
  assert.match(compose, /privileged: true/u);
  assert.match(compose, /external: true\n\s+name: local-assistant-shared/u);
  assert.doesNotMatch(compose, /\n\s+ports:/u);
  assert.match(compose, new RegExp(`container_name: ${names.api}`, "u"));
  assert.match(compose, new RegExp(`container_name: ${names.runner}`, "u"));
  assert.match(compose, new RegExp(`container_name: ${names.searxng}`, "u"));
  assert.match(createSearxngSettings(), /- json/u);
});

test("local Assistant install root stays inside Relmio's owner-only managed root", async (t) => {
  const homeDirectory = await createTestHome(t);
  assert.equal(
    await resolveLocalN8nAssistantInstallRoot({ homeDirectory, env: {} }),
    join(homeDirectory, ".relmio", "local", "n8n-ai-assistant"),
  );
});

test("local Assistant rejects Docker selector overrides before mutation", async () => {
  for (const dependencies of [
    { platform: "linux", env: { DOCKER_HOST: "unix:///tmp/other.sock" } },
    { platform: "linux", env: { DOCKER_CONTEXT: "other" } },
  ]) {
    const runner = createRunner();
    await assert.rejects(
      () => installLocalN8nAssistant(
        { plan: createPlan(), confirmed: true },
        { ...dependencies, runProcess: runner },
      ),
      /environment override/iu,
    );
    assert.deepEqual(runner.calls, []);
  }
});

test("local Assistant refuses unmanaged and symbolic-link managed roots before Docker mutation", async (t) => {
  const unmanagedHome = await createTestHome(t);
  await mkdir(join(unmanagedHome, ".relmio"));
  const unmanagedRunner = createRunner();
  await assert.rejects(
    () => installLocalN8nAssistant(
      { plan: createPlan(), confirmed: true },
      {
        homeDirectory: unmanagedHome,
        env: {},
        platform: "darwin",
        runProcess: unmanagedRunner,
      },
    ),
    /owned managed root|marker/iu,
  );
  assert.deepEqual(unmanagedRunner.calls, []);

  const symlinkHome = await createTestHome(t);
  const symlinkTarget = await createTestHome(t);
  await symlink(
    symlinkTarget,
    join(symlinkHome, ".relmio"),
    process.platform === "win32" ? "junction" : "dir",
  );
  const symlinkRunner = createRunner();
  await assert.rejects(
    () => installLocalN8nAssistant(
      { plan: createPlan(), confirmed: true },
      {
        homeDirectory: symlinkHome,
        env: {},
        platform: process.platform,
        runProcess: symlinkRunner,
      },
    ),
    /unsafe|symbolic/iu,
  );
  assert.deepEqual(symlinkRunner.calls, []);
});

test("local Assistant rejects an internal selected n8n network before writing companions", async (t) => {
  const homeDirectory = await createTestHome(t);
  const runner = createRunner({ internalNetwork: true });
  await assert.rejects(
    () => installLocalN8nAssistant(
      { plan: createPlan(), confirmed: true },
      {
        homeDirectory,
        env: {},
        platform: "darwin",
        runProcess: runner,
      },
    ),
    /no outbound Internet access|non-internal/iu,
  );
  assert.equal(runner.calls.some((call) => call.args.includes("up")), false);
  await assert.rejects(
    () => stat(join(homeDirectory, ".relmio", "local", LOCAL_N8N_ASSISTANT_TARGET)),
    /ENOENT/u,
  );
});

test("local Assistant installation requires confirmation before Docker or files", async () => {
  const runner = createRunner();
  await assert.rejects(
    () => installLocalN8nAssistant(
      { plan: createPlan({ includeSearxng: true }), confirmed: false },
      { runProcess: runner },
    ),
    /confirm/iu,
  );
  assert.deepEqual(runner.calls, []);
});

test("local Assistant refuses a generated private alias collision before mutation", async (t) => {
  const homeDirectory = await createTestHome(t);
  const reservedAlias = `relmio-ai-sandbox-${"73".repeat(16)}`;
  const runner = createRunner({ reservedAlias });
  let byte = 0x70;
  await assert.rejects(
    () => installLocalN8nAssistant(
      { plan: createPlan(), confirmed: true },
      {
        homeDirectory,
        env: {},
        platform: "linux",
        runProcess: runner,
        randomBytes: (size) => Buffer.alloc(size, (byte += 1)),
      },
    ),
    /alias.*collision/iu,
  );
  assert.equal(runner.calls.some((call) => call.args.includes("up")), false);
  const installRoot = await resolveLocalN8nAssistantInstallRoot({
    homeDirectory,
    env: {},
  });
  await assert.rejects(() => stat(installRoot), /ENOENT/u);
});

test("local Assistant installation provisions sandbox and optional SearXNG without touching n8n", async (t) => {
  const homeDirectory = await createTestHome(t);
  const runner = createRunner();
  let byte = 0x20;

  const result = await installLocalN8nAssistant(
    { plan: createPlan({ includeSearxng: true }), confirmed: true },
    {
      homeDirectory,
      env: {},
      platform: "darwin",
      runProcess: runner,
      randomBytes: (size) => Buffer.alloc(size, (byte += 1)),
    },
  );

  assert.equal(result.target, LOCAL_N8N_ASSISTANT_TARGET);
  assert.match(result.sandboxUrl, /^http:\/\/relmio-ai-sandbox-[a-f0-9]{32}:8080$/u);
  assert.match(result.sandboxApiKey, /^[A-Za-z0-9_-]{43}$/u);
  assert.match(result.searxngUrl, /^http:\/\/relmio-ai-searxng-[a-f0-9]{32}:8080$/u);
  assert.equal(result.includeSearxng, true);
  assert.equal(result.hostPublication, "none");
  assert.equal(result.privilegedRunner, true);
  assert.equal(result.n8nConfigurationRequired, true);
  assert.deepEqual(result.n8nSettings, {
    N8N_INSTANCE_AI_SANDBOX_ENABLED: "true",
    N8N_INSTANCE_AI_SANDBOX_PROVIDER: "n8n-sandbox",
    N8N_INSTANCE_AI_SANDBOX_IMAGE: ASSISTANT_COMPANION_IMAGES.sandbox,
    N8N_SANDBOX_SERVICE_URL: result.sandboxUrl,
    N8N_SANDBOX_SERVICE_API_KEY: result.sandboxApiKey,
    N8N_INSTANCE_AI_SEARXNG_URL: result.searxngUrl,
  });
  assert.equal("N8N_ENABLED_MODULES" in result.n8nSettings, false);

  const installRoot = await resolveLocalN8nAssistantInstallRoot({ homeDirectory, env: {} });
  if (process.platform !== "win32") {
    assert.equal((await stat(installRoot)).mode & 0o777, 0o700);
    assert.equal((await stat(join(installRoot, ".env"))).mode & 0o777, 0o600);
    assert.equal((await stat(join(installRoot, ".managed-by-relmio.json"))).mode & 0o777, 0o600);
  }
  assert.match(await readFile(join(installRoot, "searxng-settings.yml"), "utf8"), /- json/u);

  const serializedCalls = JSON.stringify(runner.calls);
  assert.equal(serializedCalls.includes(result.sandboxApiKey), false);
  assert.ok(runner.calls.every((call) => call.file === "docker"));
  assert.ok(runner.calls.every((call) => !call.args.includes("restart")));
  assert.ok(runner.calls.every((call) => !call.args.includes("stop")));
  assert.ok(runner.calls.every((call) => !(
    call.args.includes("exec") && call.args.includes("local-n8n")
  )));
});

test("fresh Assistant root initialization removes only an empty failed root and retries immediately", async (t) => {
  const homeDirectory = await createTestHome(t);
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
  let byte = 0x50;
  const request = { plan: createPlan({ includeSearxng: true }), confirmed: true };
  const dependencies = {
    homeDirectory,
    env: {},
    fileSystem,
    platform: "linux",
    runProcess: runner,
    randomBytes: (size) => Buffer.alloc(size, (byte += 1)),
  };

  await assert.rejects(
    () => installLocalN8nAssistant(request, dependencies),
    /injected fresh-root chmod failure/iu,
  );
  await assert.rejects(() => stat(relmioHome), /ENOENT/u);

  const result = await installLocalN8nAssistant(request, dependencies);
  assert.equal(result.deploymentMode, "installed");
  assert.equal((await stat(relmioHome)).isDirectory(), true);
});

test("local Assistant installation keeps SearXNG absent when web search is not selected", async (t) => {
  const homeDirectory = await createTestHome(t);
  const runner = createRunner();
  let byte = 0x30;

  const result = await installLocalN8nAssistant(
    { plan: createPlan({ includeSearxng: false }), confirmed: true },
    {
      homeDirectory,
      env: {},
      platform: "linux",
      runProcess: runner,
      randomBytes: (size) => Buffer.alloc(size, (byte += 1)),
    },
  );

  assert.equal(result.includeSearxng, false);
  assert.equal("searxngUrl" in result, false);
  assert.equal("N8N_INSTANCE_AI_SEARXNG_URL" in result.n8nSettings, false);
  const installRoot = await resolveLocalN8nAssistantInstallRoot({ homeDirectory, env: {} });
  await assert.rejects(
    () => stat(join(installRoot, "searxng-settings.yml")),
    /ENOENT/u,
  );
  const compose = await readFile(join(installRoot, "docker-compose.yml"), "utf8");
  assert.doesNotMatch(compose, /^\s{2}relmio-searxng:/mu);
  assert.equal(
    runner.calls.some((call) => call.args.join(" ").includes("format=json")),
    false,
  );
});

test("local Assistant accepts Docker Compose unpublished-port metadata", async (t) => {
  const homeDirectory = await createTestHome(t);
  const unpublishedPort = (targetPort) => ({
    URL: "",
    TargetPort: targetPort,
    PublishedPort: 0,
    Protocol: "tcp",
  });
  const runner = createRunner({
    publicationRecords: [
      {
        Service: "relmio-sandbox-api",
        Publishers: [unpublishedPort(8080)],
      },
      {
        Service: "relmio-sandbox-runner-1",
        Publishers: [unpublishedPort(8080), unpublishedPort(9091)],
      },
      {
        Service: "relmio-searxng",
        Publishers: [unpublishedPort(8080)],
      },
    ],
  });
  let byte = 0x34;

  const result = await installLocalN8nAssistant(
    { plan: createPlan({ includeSearxng: true }), confirmed: true },
    {
      homeDirectory,
      env: {},
      platform: "darwin",
      runProcess: runner,
      randomBytes: (size) => Buffer.alloc(size, (byte += 1)),
    },
  );

  assert.equal(result.hostPublication, "none");
  assert.equal(result.includeSearxng, true);
  assert.equal(runner.calls.some((call) => call.args.includes("down")), false);
});

test("local Assistant installation refuses to overwrite an existing managed stack", async (t) => {
  const homeDirectory = await createTestHome(t);
  const runner = createRunner();
  let byte = 0x38;
  const dependencies = {
    homeDirectory,
    env: {},
    platform: "linux",
    runProcess: runner,
    randomBytes: (size) => Buffer.alloc(size, (byte += 1)),
  };
  await installLocalN8nAssistant(
    { plan: createPlan({ includeSearxng: false }), confirmed: true },
    dependencies,
  );
  const callCount = runner.calls.length;

  await assert.rejects(
    () => installLocalN8nAssistant(
      { plan: createPlan({ includeSearxng: true }), confirmed: true },
      dependencies,
    ),
    /already installed|Remove them/iu,
  );
  assert.equal(runner.calls.length, callCount);
});

test("local Assistant installation fails closed on host publication and removes only its project", async (t) => {
  const homeDirectory = await createTestHome(t);
  const runner = createRunner({ published: true });
  let byte = 0x40;

  await assert.rejects(
    () => installLocalN8nAssistant(
      { plan: createPlan({ includeSearxng: true }), confirmed: true },
      {
        homeDirectory,
        env: {},
        platform: "linux",
        runProcess: runner,
        randomBytes: (size) => Buffer.alloc(size, (byte += 1)),
      },
    ),
    /published|host port/iu,
  );
  const cleanup = runner.calls.find((call) =>
    call.args.includes("down") && call.args.includes("--volumes"),
  );
  assert.ok(cleanup);
  assert.equal(cleanup.args.includes("local-n8n"), false);
  assert.equal(cleanup.args.includes("local-assistant-shared"), false);
});

test("local Assistant host-publication proof requires the exact well-formed service set", async (t) => {
  const cases = [
    { label: "empty records", records: [] },
    {
      label: "missing runner",
      records: [{ Service: "relmio-sandbox-api", Publishers: [] }],
    },
    {
      label: "missing publishers",
      records: [
        { Service: "relmio-sandbox-api" },
        { Service: "relmio-sandbox-runner-1", Publishers: [] },
      ],
    },
    {
      label: "string published port",
      records: [
        {
          Service: "relmio-sandbox-api",
          Publishers: [{ PublishedPort: "18080" }],
        },
        { Service: "relmio-sandbox-runner-1", Publishers: [] },
      ],
    },
    {
      label: "missing publisher URL",
      records: [
        {
          Service: "relmio-sandbox-api",
          Publishers: [{ PublishedPort: 0 }],
        },
        { Service: "relmio-sandbox-runner-1", Publishers: [] },
      ],
    },
    {
      label: "non-empty publisher URL",
      records: [
        {
          Service: "relmio-sandbox-api",
          Publishers: [{ PublishedPort: 0, URL: "0.0.0.0" }],
        },
        { Service: "relmio-sandbox-runner-1", Publishers: [] },
      ],
    },
    {
      label: "whitespace publisher URL",
      records: [
        {
          Service: "relmio-sandbox-api",
          Publishers: [{ PublishedPort: 0, URL: " " }],
        },
        { Service: "relmio-sandbox-runner-1", Publishers: [] },
      ],
    },
    {
      label: "negative published port",
      records: [
        {
          Service: "relmio-sandbox-api",
          Publishers: [{ PublishedPort: -1, URL: "" }],
        },
        { Service: "relmio-sandbox-runner-1", Publishers: [] },
      ],
    },
    {
      label: "fractional published port",
      records: [
        {
          Service: "relmio-sandbox-api",
          Publishers: [{ PublishedPort: 0.5, URL: "" }],
        },
        { Service: "relmio-sandbox-runner-1", Publishers: [] },
      ],
    },
    {
      label: "null publisher",
      records: [
        {
          Service: "relmio-sandbox-api",
          Publishers: [null],
        },
        { Service: "relmio-sandbox-runner-1", Publishers: [] },
      ],
    },
  ];
  for (const [index, entry] of cases.entries()) {
    await t.test(entry.label, async (subtest) => {
      const homeDirectory = await createTestHome(subtest);
      const runner = createRunner({ publicationRecords: entry.records });
      let byte = 0x80 + index * 8;
      await assert.rejects(
        () => installLocalN8nAssistant(
          { plan: createPlan(), confirmed: true },
          {
            homeDirectory,
            env: {},
            platform: "linux",
            runProcess: runner,
            randomBytes: (size) => Buffer.alloc(size, (byte += 1)),
          },
        ),
        /publication|published-port|host port/iu,
      );
      assert.ok(runner.calls.some((call) => call.args.includes("down")));
    });
  }
});

test("local Assistant startup failure cleans zero or partially created owned projects", async (t) => {
  for (const [index, upFailure] of ["zero", "partial"].entries()) {
    await t.test(`${upFailure} resources`, async (subtest) => {
      const homeDirectory = await createTestHome(subtest);
      const runner = createRunner({ upFailure });
      let byte = 0xa0 + index * 8;
      await assert.rejects(
        () => installLocalN8nAssistant(
          { plan: createPlan(), confirmed: true },
          {
            homeDirectory,
            env: {},
            platform: "linux",
            runProcess: runner,
            randomBytes: (size) => Buffer.alloc(size, (byte += 1)),
          },
        ),
        /companion start failed/iu,
      );
      const installRoot = await resolveLocalN8nAssistantInstallRoot({
        homeDirectory,
        env: {},
      });
      await assert.rejects(() => stat(installRoot), /ENOENT/u);
      assert.equal(
        runner.calls.some((call) => call.args.includes("down")),
        upFailure === "partial",
      );
    });
  }
});

test("local Assistant installation removes its own project when SearXNG verification is invalid", async (t) => {
  const homeDirectory = await createTestHome(t);
  const runner = createRunner({ invalidSearch: true });
  let byte = 0x50;

  await assert.rejects(
    () => installLocalN8nAssistant(
      { plan: createPlan({ includeSearxng: true }), confirmed: true },
      {
        homeDirectory,
        env: {},
        platform: "linux",
        runProcess: runner,
        randomBytes: (size) => Buffer.alloc(size, (byte += 1)),
      },
    ),
    /SearXNG service did not return JSON/iu,
  );
  const cleanup = runner.calls.find((call) =>
    call.args.includes("down") && call.args.includes("--volumes"),
  );
  assert.ok(cleanup);
  assert.equal(cleanup.args.includes("local-n8n"), false);
  assert.equal(cleanup.args.includes("local-assistant-shared"), false);
});

test("local Assistant can separately enable SearXNG without rotating or returning the sandbox key", async (t) => {
  const homeDirectory = await createTestHome(t);
  const runner = createRunner();
  let byte = 0x91;
  const dependencies = {
    homeDirectory,
    env: {},
    platform: "linux",
    runProcess: runner,
    randomBytes: (size) => Buffer.alloc(size, (byte += 1)),
    lockDownPath: async () => {},
  };
  await installLocalN8nAssistant(
    { plan: createPlan({ includeSearxng: false }), confirmed: true },
    dependencies,
  );
  const installRoot = await resolveLocalN8nAssistantInstallRoot({ homeDirectory, env: {} });
  const oldEnv = await readFile(join(installRoot, ".env"), "utf8");
  const review = await prepareLocalN8nAssistantSearxngUpdate(
    { includeSearxng: true },
    dependencies,
  );
  const callCount = runner.calls.length;

  const result = await editLocalN8nAssistantSearxng(
    { review, confirmed: true },
    dependencies,
  );

  assert.equal(result.includeSearxng, true);
  assert.equal(result.sandboxApiKeyRotated, false);
  assert.equal("sandboxApiKey" in result, false);
  assert.deepEqual(result.n8nSettings, {
    N8N_INSTANCE_AI_SEARXNG_URL: result.searxngUrl,
  });
  assert.equal(await readFile(join(installRoot, ".env"), "utf8"), oldEnv);
  assert.match(await readFile(join(installRoot, "docker-compose.yml"), "utf8"), /^\s{2}relmio-searxng:/mu);
  assert.match(await readFile(join(installRoot, "searxng-settings.yml"), "utf8"), /- json/u);
  const marker = JSON.parse(await readFile(join(installRoot, ".managed-by-relmio.json"), "utf8"));
  assert.equal(marker.plan.includeSearxng, true);
  assert.equal(marker.installation.includeSearxng, true);
  const updateCalls = runner.calls.slice(callCount);
  const start = updateCalls.find((call) =>
    call.args.includes("up") && call.args.includes("relmio-searxng"),
  );
  assert.ok(start);
  assert.ok(start.args.includes("--no-deps"));
  assert.equal(start.args.includes("relmio-sandbox-api"), false);
  assert.equal(updateCalls.some((call) => call.args.includes("down")), false);
  assert.equal(JSON.stringify(updateCalls).includes(oldEnv.match(/SANDBOX_API_KEYS=([^\n]+)/u)?.[1]), false);
});

test(
  "native Windows Assistant files keep owner-only ACLs through SearXNG enablement",
  { skip: process.platform !== "win32" },
  async (t) => {
    const homeDirectory = await createTestHome(t);
    const runner = createRunner({ contextHost: WINDOWS_DOCKER_HOST });
    let byte = 0xa2;
    const dependencies = {
      homeDirectory,
      env: {},
      platform: "win32",
      runProcess: runner,
      randomBytes: (size) => Buffer.alloc(size, (byte += 1)),
    };
    await installLocalN8nAssistant(
      { plan: createPlan({ dockerHost: WINDOWS_DOCKER_HOST }), confirmed: true },
      dependencies,
    );
    const review = await prepareLocalN8nAssistantSearxngUpdate(
      { includeSearxng: true },
      dependencies,
    );

    const result = await editLocalN8nAssistantSearxng(
      { review, confirmed: true },
      dependencies,
    );

    assert.equal(result.deploymentMode, "searxng-enabled");
    assert.equal(result.sandboxApiKeyRotated, false);
  },
);

test("local Assistant SearXNG enablement rejects no-op, disable, and changed reviewed identity before mutation", async (t) => {
  const homeDirectory = await createTestHome(t);
  const runner = createRunner();
  let byte = 0xb0;
  const dependencies = {
    homeDirectory,
    env: {},
    platform: "linux",
    runProcess: runner,
    randomBytes: (size) => Buffer.alloc(size, (byte += 1)),
    lockDownPath: async () => {},
  };
  await assert.rejects(
    () => prepareLocalN8nAssistantSearxngUpdate({ includeSearxng: false }, dependencies),
    /only enable/iu,
  );
  await installLocalN8nAssistant(
    { plan: createPlan(), confirmed: true },
    dependencies,
  );
  const review = await prepareLocalN8nAssistantSearxngUpdate({ includeSearxng: true }, dependencies);
  const callCount = runner.calls.length;
  await assert.rejects(
    () => editLocalN8nAssistantSearxng({ review, confirmed: false }, dependencies),
    /confirm/iu,
  );
  await assert.rejects(
    () => editLocalN8nAssistantSearxng({
      review: { ...review, installation: { ...review.installation, installId: "f".repeat(32) } },
      confirmed: true,
    }, dependencies),
    /changed after review|fresh/iu,
  );
  assert.equal(runner.calls.slice(callCount).some((call) => call.args.includes("up")), false);
});

test("local Assistant SearXNG enablement proves its generated container name is free before writing", async (t) => {
  const homeDirectory = await createTestHome(t);
  const runner = createRunner({ searxngContainerCollision: true });
  let byte = 0xbd;
  const dependencies = {
    homeDirectory,
    env: {},
    platform: "linux",
    runProcess: runner,
    randomBytes: (size) => Buffer.alloc(size, (byte += 1)),
    lockDownPath: async () => {},
  };
  await installLocalN8nAssistant({ plan: createPlan(), confirmed: true }, dependencies);
  const installRoot = await resolveLocalN8nAssistantInstallRoot({ homeDirectory, env: {} });
  const oldCompose = await readFile(join(installRoot, "docker-compose.yml"), "utf8");
  const review = await prepareLocalN8nAssistantSearxngUpdate({ includeSearxng: true }, dependencies);

  await assert.rejects(
    () => editLocalN8nAssistantSearxng({ review, confirmed: true }, dependencies),
    /SearXNG identity/iu,
  );
  assert.equal(await readFile(join(installRoot, "docker-compose.yml"), "utf8"), oldCompose);
  await assert.rejects(() => stat(join(installRoot, "searxng-settings.yml")), /ENOENT/u);
});

test("local Assistant SearXNG enablement rolls back only SearXNG and its new files on start failure", async (t) => {
  const homeDirectory = await createTestHome(t);
  const runner = createRunner({ searxngStartFailure: true });
  let byte = 0xc8;
  const dependencies = {
    homeDirectory,
    env: {},
    platform: "linux",
    runProcess: runner,
    randomBytes: (size) => Buffer.alloc(size, (byte += 1)),
    lockDownPath: async () => {},
  };
  await installLocalN8nAssistant({ plan: createPlan(), confirmed: true }, dependencies);
  const installRoot = await resolveLocalN8nAssistantInstallRoot({ homeDirectory, env: {} });
  const oldEnv = await readFile(join(installRoot, ".env"), "utf8");
  const oldCompose = await readFile(join(installRoot, "docker-compose.yml"), "utf8");
  const oldMarker = await readFile(join(installRoot, ".managed-by-relmio.json"), "utf8");
  const review = await prepareLocalN8nAssistantSearxngUpdate({ includeSearxng: true }, dependencies);

  await assert.rejects(
    () => editLocalN8nAssistantSearxng({ review, confirmed: true }, dependencies),
    /SearXNG start failed/iu,
  );
  assert.equal(await readFile(join(installRoot, ".env"), "utf8"), oldEnv);
  assert.equal(await readFile(join(installRoot, "docker-compose.yml"), "utf8"), oldCompose);
  assert.equal(await readFile(join(installRoot, ".managed-by-relmio.json"), "utf8"), oldMarker);
  await assert.rejects(() => stat(join(installRoot, "searxng-settings.yml")), /ENOENT/u);
  const removal = runner.calls.find((call) =>
    call.args[0] === "container" && call.args[1] === "rm",
  );
  assert.ok(removal);
  assert.equal(removal.args.at(-1), "4".repeat(64));
  assert.equal(runner.calls.some((call) => call.args.includes("down")), false);
});

test("local Assistant preserves evidence when SearXNG rollback cannot be confirmed", async (t) => {
  const homeDirectory = await createTestHome(t);
  const runner = createRunner({ invalidSearch: true, searxngRollbackFailure: true });
  let byte = 0xd0;
  const dependencies = {
    homeDirectory,
    env: {},
    platform: "linux",
    runProcess: runner,
    randomBytes: (size) => Buffer.alloc(size, (byte += 1)),
    lockDownPath: async () => {},
  };
  await installLocalN8nAssistant({ plan: createPlan(), confirmed: true }, dependencies);
  const installRoot = await resolveLocalN8nAssistantInstallRoot({ homeDirectory, env: {} });
  const review = await prepareLocalN8nAssistantSearxngUpdate({ includeSearxng: true }, dependencies);

  await assert.rejects(
    () => editLocalN8nAssistantSearxng({ review, confirmed: true }, dependencies),
    /rollback could not be confirmed/iu,
  );
  assert.match(await readFile(join(installRoot, "docker-compose.yml"), "utf8"), /^\s{2}relmio-searxng:/mu);
  assert.equal((await stat(join(installRoot, "searxng-settings.yml"))).isFile(), true);
  assert.equal(runner.calls.some((call) => call.args.includes("down")), false);
});

test("local Assistant removal deletes only the owned companion project", async (t) => {
  const homeDirectory = await createTestHome(t);
  const runner = createRunner();
  let byte = 0x60;
  await installLocalN8nAssistant(
    { plan: createPlan({ includeSearxng: true }), confirmed: true },
    {
      homeDirectory,
      env: {},
      platform: "linux",
      runProcess: runner,
      randomBytes: (size) => Buffer.alloc(size, (byte += 1)),
    },
  );

  assert.deepEqual(
    await removeLocalN8nAssistant(
      { confirmed: true },
      { homeDirectory, env: {}, platform: "linux", runProcess: runner },
    ),
    { target: LOCAL_N8N_ASSISTANT_TARGET, removed: true },
  );
  const installRoot = await resolveLocalN8nAssistantInstallRoot({ homeDirectory, env: {} });
  await assert.rejects(() => stat(installRoot), /ENOENT/u);
  assert.ok(runner.calls.some((call) => call.args.includes("down")));
  assert.ok(runner.calls.every((call) => !call.args.includes("local-n8n")));
});

test("local Assistant removal preserves foreign or incomplete Docker resources", async (t) => {
  for (const [index, drift] of ["foreign", "partial"].entries()) {
    await t.test(drift, async (subtest) => {
      const homeDirectory = await createTestHome(subtest);
      const runner = createRunner();
      let byte = 0xc0 + index * 8;
      await installLocalN8nAssistant(
        { plan: createPlan(), confirmed: true },
        {
          homeDirectory,
          env: {},
          platform: "linux",
          runProcess: runner,
          randomBytes: (size) => Buffer.alloc(size, (byte += 1)),
        },
      );
      const callCount = runner.calls.length;
      if (drift === "foreign") runner.setForeignOwnership(true);
      else runner.setResourceMode("partial");

      await assert.rejects(
        () => removeLocalN8nAssistant(
          { confirmed: true },
          { homeDirectory, env: {}, platform: "linux", runProcess: runner },
        ),
        /ownership|incomplete/iu,
      );
      assert.equal(
        runner.calls.slice(callCount).some((call) => call.args.includes("down")),
        false,
      );
      const installRoot = await resolveLocalN8nAssistantInstallRoot({
        homeDirectory,
        env: {},
      });
      assert.equal((await stat(installRoot)).isDirectory(), true);
    });
  }
});

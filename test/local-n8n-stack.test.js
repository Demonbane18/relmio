import assert from "node:assert/strict";
import test from "node:test";
import * as nodeFileSystem from "node:fs/promises";
import { mkdir, mkdtemp, realpath, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  LOCAL_N8N_STACK_TARGET,
  createLocalN8nStackInstallation,
  createLocalN8nStackPlan,
  normalizeLocalN8nStackPlan,
} from "../src/domain/local-n8n-stack.js";
import {
  createLocalN8nStackEnv,
  createLocalN8nStackComposeFile,
  createNgrokTrafficPolicy,
  LOCAL_N8N_STACK_IMAGES,
  LOCAL_N8N_STACK_HEALTHY_SERVICES,
  validateLocalN8nStackSecrets,
} from "../src/templates/local-n8n-stack/index.js";
import { lockDownLocalPath } from "../src/infrastructure/local-process.js";
import {
  LOCAL_N8N_LIFECYCLE_LOCK_RELEASE_ERROR_CODE,
  LOCAL_N8N_MANAGED_PARTIAL_STACK_ERROR_CODE,
  LOCAL_N8N_STACK_NGROK_SETUP_REJECTED_FAILURE_KIND,
  LOCAL_N8N_STACK_DOCKER_ENGINE_RESOURCES_FAILURE_KIND,
  LOCAL_N8N_STACK_RETRYABLE_STARTUP_ERROR_CODE,
  LOCAL_N8N_STACK_COMPOSE_PULL_TIMEOUT_MS,
  LOCAL_N8N_STACK_COMPOSE_UP_TIMEOUT_MS,
  LOCAL_N8N_STACK_COMPOSE_WAIT_TIMEOUT_SECONDS,
  getLocalN8nStackStatus,
  installLocalN8nStack as installLocalN8nStackService,
  removeLocalN8nStack as removeLocalN8nStackService,
  resolveLocalN8nStackInstallRoot,
  resumeLocalN8nStack as resumeLocalN8nStackService,
} from "../src/services/local-n8n-stack-installer.js";
import { withTestLocalSecurity } from "./helpers/local-security.js";

const installLocalN8nStack = (dependencies) =>
  installLocalN8nStackService(withTestLocalSecurity(dependencies));
const removeLocalN8nStack = (dependencies) =>
  removeLocalN8nStackService(withTestLocalSecurity(dependencies));
const resumeLocalN8nStack = (dependencies) =>
  resumeLocalN8nStackService(withTestLocalSecurity(dependencies));

const DOCKER_HOST = process.platform === "win32"
  ? "npipe:////./pipe/dockerDesktopLinuxEngine"
  : "unix:///var/run/docker.sock";
const DOCKER_CONTEXT = process.platform === "win32" ? "desktop-linux" : "default";
const WINDOWS_DOCKER_HOST = "npipe:////./pipe/dockerDesktopLinuxEngine";
const OWNERSHIP_LABEL_KEYS = [
  "com.docker.compose.project",
  "io.relmio.managed",
  "io.relmio.target",
  "io.relmio.install",
  "io.relmio.project",
];

function plan(overrides = {}) {
  return createLocalN8nStackPlan({
    dockerHost: DOCKER_HOST,
    ngrokHostname: "relmio-demo.ngrok.app",
    n8nPort: 5678,
    ngrokInspectorPort: 4040,
    timezone: "Asia/Manila",
    assistantMode: "disabled",
    ...overrides,
  });
}

test("local n8n plan accepts only public choices and rejects unsafe bindings", () => {
  const value = plan();
  assert.equal(value.target, LOCAL_N8N_STACK_TARGET);
  assert.equal(value.localUrl, "http://127.0.0.1:5678");
  assert.equal(value.ngrokPublicUrl, "https://relmio-demo.ngrok.app");
  assert.equal(value.hostPublication, "loopback-only");
  assert.deepEqual(normalizeLocalN8nStackPlan(value), value);

  for (const override of [
    { ngrokHostname: "https://relmio-demo.ngrok.app" },
    { ngrokHostname: "127.0.0.1" },
    { ngrokHostname: "relmio-demo.local" },
    { n8nPort: 10531 },
    { ngrokInspectorPort: 10531 },
    { n8nPort: 4040 },
    { timezone: "not/a-timezone" },
    { assistantMode: "anything" },
    { dockerHost: "tcp://remote.example:2376" },
  ]) {
    assert.throws(() => plan(override));
  }
});

test("install identity is collision resistant and carries a strict ownership marker", () => {
  let byte = 0;
  const installation = createLocalN8nStackInstallation({
    plan: plan({ assistantMode: "sandbox-with-searxng" }),
    randomBytes(length) {
      return Buffer.alloc(length, ++byte);
    },
  });
  assert.match(installation.installId, /^[a-f0-9]{32}$/);
  assert.match(installation.projectName, /^relmio-local-n8n-[a-f0-9]{32}$/);
  assert.equal(installation.projectName.slice(-32), installation.installId);
  assert.equal(installation.marker.kind, "relmio-local-n8n-stack");
  assert.equal(installation.marker.assistantMode, "sandbox-with-searxng");
  assert.throws(() => createLocalN8nStackInstallation({
    plan: plan(),
    randomBytes: () => Buffer.alloc(1),
  }));
});

test("generated compose keeps n8n and ngrok loopback-only and isolates assistants from edge", () => {
  const installation = createLocalN8nStackInstallation({
    plan: plan({ assistantMode: "sandbox-with-searxng" }),
    randomBytes: (() => {
      let byte = 6;
      return (length) => Buffer.alloc(length, ++byte);
    })(),
  });
  const compose = createLocalN8nStackComposeFile({ installation });
  assert.match(compose, /127\.0\.0\.1:5678:5678/);
  assert.match(compose, /127\.0\.0\.1:4040:4040/);
  assert.match(compose, /http:\/\/n8n:5678/);
  assert.match(compose, /ngrok:\n[\s\S]*networks:\n      - edge/);
  assert.match(compose, /relmio-sandbox-api:[\s\S]*?networks: \[assistant-internal, assistant-shared\]/);
  assert.match(compose, /relmio-sandbox-runner-1:[\s\S]*?networks: \[assistant-internal\]/);
  assert.match(compose, /relmio-searxng:[\s\S]*?networks: \[assistant-shared\]/);
  assert.doesNotMatch(compose, /assistant-(?:shared|internal):\n\s+internal: true/u);
  assert.doesNotMatch(compose, /10531/);
  assert.match(compose, /io\.relmio\.target: "local-n8n-stack"/);
  assert.match(compose, /N8N_ENFORCE_SETTINGS_FILE_PERMISSIONS: "true"/);
  assert.match(compose, /--traffic-policy-file=\/run\/secrets\/ngrok-traffic-policy\.yml/u);
  assert.match(compose, /ngrok-traffic-policy:\n    file: \.\/\.runtime\/traffic-policy\.yml/u);
  assert.doesNotMatch(compose, /\.runtime\/traffic-policy\.yml:\/etc\/ngrok/u);
  for (const service of ["relmio-sandbox-certs", "relmio-sandbox-api", "relmio-sandbox-runner-1", "relmio-searxng"]) {
    assert.match(compose, new RegExp(`${service}:[\\s\\S]*?restart: "no"`));
  }
});
test("generated SearXNG compose uses block-style secret interpolation", () => {
  const installation = createLocalN8nStackInstallation({
    plan: plan({ assistantMode: "sandbox-with-searxng" }),
    randomBytes: (length) => Buffer.alloc(length, 9),
  });
  const compose = createLocalN8nStackComposeFile({ installation });
  assert.match(compose, /relmio-searxng:\r?\n(?:.*\r?\n)*?    environment:\r?\n      SEARXNG_SECRET: \$\{SEARXNG_SECRET\}/);
  assert.doesNotMatch(compose, /environment:\s*\{[^}]*\$\{/u);
});

test("compose validation failure is reported and managed files are removed", async (t) => {
  const homeDirectory = await testHome(t);
  const { runner } = createStackRunner();
  const failingRunner = async (spec) => {
    if (spec.args.join(" ").includes("config --quiet")) {
      return {
        code: 1,
        stdout: "",
        stderr: "failed to parse docker-compose.yml: go-yaml load error in parser",
      };
    }
    return runner(spec);
  };

  await assert.rejects(
    () => installLocalN8nStack({
      plan: plan({ assistantMode: "sandbox-with-searxng" }),
      secrets: {
        ngrokAuthtoken: "ngrok-private-token",
        basicAuthUsername: "operator",
        basicAuthPassword: "long-private-password",
      },
      publicExposureConfirmation: "EXPOSE_LOCAL_N8N_VIA_NGROK",
      homeDirectory,
      runProcess: failingRunner,
    }),
    (error) => {
      assert.match(error.message, /Local n8n Compose validation failed\./u);
      assert.equal(error.message.includes("go-yaml"), false);
      assert.equal(error.message.includes("docker-compose.yml"), false);
      return true;
    },
  );
  await assert.rejects(() => stat(join(homeDirectory, ".relmio", "local", "n8n-stack")));
});


test("every local n8n production image is pinned by immutable digest", () => {
  for (const image of Object.values(LOCAL_N8N_STACK_IMAGES)) {
    assert.match(image, /@sha256:[a-f0-9]{64}$/u);
  }
});

test("generated Compose healthchecks stay coupled to the installer readiness contract", () => {
  const installation = createLocalN8nStackInstallation({
    plan: plan({ assistantMode: "sandbox-with-searxng" }),
    randomBytes: (length) => Buffer.alloc(length, 9),
  });
  const compose = createLocalN8nStackComposeFile({ installation });
  const expectedHealthyServices = ["n8n", "ngrok", "relmio-sandbox-api"];

  assert.deepEqual(
    [...LOCAL_N8N_STACK_HEALTHY_SERVICES].sort(),
    [...expectedHealthyServices].sort(),
    "the readiness contract must retain the independently reviewed service set",
  );

  for (const service of expectedHealthyServices) {
    const serviceBlock = compose.match(
      new RegExp(`^  ${service}:\\n[\\s\\S]*?(?=^  [^ \\n][^\\n]*:\\n|^volumes:)`, "mu"),
    )?.[0];
    assert.equal(typeof serviceBlock, "string", `${service} must be generated`);
    assert.match(serviceBlock, /^    healthcheck:\n/m, `${service} must define a healthcheck`);
    assert.match(serviceBlock, /^      test: \[/m, `${service} healthcheck must have a test`);
  }

  const disabledCompose = createLocalN8nStackComposeFile({
    installation: createLocalN8nStackInstallation({
      plan: plan(),
      randomBytes: (length) => Buffer.alloc(length, 10),
    }),
  });
  assert.doesNotMatch(disabledCompose, /^  relmio-sandbox-api:/mu);
  assert.doesNotMatch(disabledCompose, /^  relmio-sandbox-api:[\\s\\S]*?healthcheck:/mu);
});

function expandComposeDoubleQuotedValue(value) {
  let expanded = "";
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character !== "\\") {
      expanded += character;
      continue;
    }

    const escaped = value[index + 1];
    const replacements = {
      "\\": "\\",
      "\"": "\"",
      "$": "$",
      a: "\x07",
      b: "\b",
      f: "\f",
      n: "\n",
      r: "\r",
      t: "\t",
      v: "\v",
    };
    if (Object.hasOwn(replacements, escaped)) {
      expanded += replacements[escaped];
      index += 1;
    } else {
      expanded += character;
    }
  }
  return expanded;
}

function parseComposeQuotedLiteral(literal) {
  const quote = literal[0];
  assert.ok(quote === "'" || quote === "\"");
  let previousCharacterIsEscape = false;
  let value = "";

  for (let index = 1; index < literal.length; index += 1) {
    const character = literal[index];
    if (character !== quote) {
      if (!previousCharacterIsEscape && character === "\\") {
        previousCharacterIsEscape = true;
        continue;
      }
      if (previousCharacterIsEscape) {
        previousCharacterIsEscape = false;
        value += "\\";
      }
      value += character;
      continue;
    }
    if (previousCharacterIsEscape) {
      previousCharacterIsEscape = false;
      value += character;
      continue;
    }

    assert.equal(literal.slice(index + 1), "");
    return quote === "'" ? value : expandComposeDoubleQuotedValue(value);
  }

  assert.fail("Compose quoted value was not terminated.");
}

function parseComposeQuotedEnvironment(content) {
  return Object.fromEntries(
    content.trimEnd().split("\n").map((line) => {
      const delimiter = line.indexOf("=");
      const name = line.slice(0, delimiter);
      const literal = line.slice(delimiter + 1);
      return [name, parseComposeQuotedLiteral(literal)];
    }),
  );
}

test("local n8n dotenv values round-trip Compose quoting edge combinations", () => {
  const installation = createLocalN8nStackInstallation({
    plan: plan({ assistantMode: "sandbox-with-searxng" }),
    randomBytes: (length) => Buffer.alloc(length, 0x19),
  });
  const runtimeSecrets = {
    n8nEncryptionKey: "a".repeat(64),
    sandboxApiKey: "b".repeat(43),
    runnerRegistrationToken: "c".repeat(43),
    runnerApiKey: "d".repeat(43),
    searxngSecret: "e".repeat(43),
  };

  for (const ngrokAuthtoken of [
    "ngrok-$UNBRACED",
    "ngrok-${BRACED}",
    "ngrok-'apostrophe",
    "ngrok-\\backslash",
    "ngrok-\\'backslash-before-apostrophe",
    "ngrok-\\\\'two-backslashes-before-apostrophe",
    "ngrok-\\\\\\'three-backslashes-before-apostrophe",
    'ngrok-"double-quote',
    'ngrok-\\$\'"${MIXED}',
  ]) {
    const environment = createLocalN8nStackEnv({
      installation,
      secrets: {
        ngrokAuthtoken,
        basicAuthUsername: "operator",
        basicAuthPassword: "long-private-password",
      },
      runtimeSecrets,
    });

    assert.deepEqual(parseComposeQuotedEnvironment(environment), {
      NGROK_AUTHTOKEN: ngrokAuthtoken,
      N8N_ENCRYPTION_KEY: runtimeSecrets.n8nEncryptionKey,
      NGROK_DOMAIN: installation.marker.ngrokHostname,
      N8N_LOCAL_PORT: String(installation.marker.n8nPort),
      NGROK_INSPECTOR_PORT: String(installation.marker.ngrokInspectorPort),
      GENERIC_TIMEZONE: installation.marker.timezone,
      SANDBOX_API_KEYS: runtimeSecrets.sandboxApiKey,
      SANDBOX_API_RUNNER_REGISTRATION_TOKEN:
        runtimeSecrets.runnerRegistrationToken,
      SANDBOX_API_RUNNER_API_KEY: runtimeSecrets.runnerApiKey,
      SEARXNG_SECRET: runtimeSecrets.searxngSecret,
    });
  }
});

test("traffic policy requires basic authentication without disclosing it in errors", () => {
  const policy = createNgrokTrafficPolicy({
    username: "operator",
    password: "very-secret-password",
  });
  assert.match(policy, /basic-auth/);
  assert.match(policy, /operator:very-secret-password/);
  const invalidPassword = "secret:colon-value";
  let errorMessage = "";
  assert.throws(
    () => {
      try {
        createNgrokTrafficPolicy({ username: "operator", password: invalidPassword });
      } catch (error) {
        errorMessage = error.message;
        throw error;
      }
    },
    /Basic Auth password must be 12–512 characters with no colon or line breaks\./,
  );
  assert.equal(errorMessage.includes(invalidPassword), false);
});

test("ngrok authtoken validation rejects pasted commands and whitespace without disclosing the value", async (t) => {
  for (const invalidAuthtoken of [
    " ngrok-private-token",
    "ngrok-private-token ",
    "ngrok private token",
    "ngrok config add-authtoken ngrok-private-token",
  ]) {
    let errorMessage = "";
    assert.throws(
      () => {
        try {
          validateLocalN8nStackSecrets({
            ngrokAuthtoken: invalidAuthtoken,
            basicAuthUsername: "operator",
            basicAuthPassword: "long-private-password",
          });
        } catch (error) {
          errorMessage = error.message;
          throw error;
        }
      },
      /Paste only the token value, not an ngrok command\./u,
    );
    assert.equal(errorMessage.includes(invalidAuthtoken), false);
  }

  const homeDirectory = await testHome(t);
  const { calls, runner } = createStackRunner();
  await assert.rejects(() => installLocalN8nStack({
    plan: plan(),
    secrets: {
      ngrokAuthtoken: "ngrok config add-authtoken ngrok-private-token",
      basicAuthUsername: "operator",
      basicAuthPassword: "long-private-password",
    },
    publicExposureConfirmation: "EXPOSE_LOCAL_N8N_VIA_NGROK",
    homeDirectory,
    runProcess: runner,
  }), /Paste only the token value, not an ngrok command\./u);
  assert.equal(calls.length, 0);
  await assert.rejects(() => stat(join(homeDirectory, ".relmio", "local", "n8n-stack")));
});

async function testHome(t) {
  const value = await realpath(await mkdtemp(join(tmpdir(), "relmio-local-stack-")));
  t.after(() => rm(value, { recursive: true, force: true }));
  return value;
}

const TEST_PROCESS_START_IDENTITY = "relmio-test-process-start";
const STALE_LOCK_PID = 424_242;
const RECLAIM_LOCK_PID = 424_243;

function testProcessIdentity({ staleState = "dead" } = {}) {
  return async (pid) => {
    if (pid === process.pid) {
      return { state: "active", startIdentity: TEST_PROCESS_START_IDENTITY };
    }
    if (pid === STALE_LOCK_PID) {
      return staleState === "active"
        ? { state: "active", startIdentity: "reused-process-start" }
        : { state: staleState };
    }
    return { state: "ambiguous" };
  };
}

async function writeLifecycleLock(homeDirectory, {
  owner = {
    schemaVersion: 2,
    pid: STALE_LOCK_PID,
    processStartIdentity: "original-process-start",
    token: "11111111-1111-4111-8111-111111111111",
    publishedAtMs: Date.now() - 60_000,
  },
  modifiedAtMs = Date.now(),
} = {}) {
  const relmioRoot = join(homeDirectory, ".relmio");
  const localRoot = join(relmioRoot, "local");
  const lockPath = join(localRoot, "n8n-stack.lock");
  await mkdir(localRoot, { recursive: true, mode: 0o700 });
  await nodeFileSystem.writeFile(
    join(relmioRoot, ".managed-by-relmio-root.json"),
    `${JSON.stringify({ schemaVersion: 1, kind: "relmio-local-root" })}\n`,
    { mode: 0o600 },
  );
  await mkdir(lockPath, { mode: 0o700 });
  if (owner !== null) {
    const ownerPath = join(lockPath, ".owner.json");
    const contents = typeof owner === "string" ? owner : `${JSON.stringify(owner)}\n`;
    await nodeFileSystem.writeFile(ownerPath, contents, { mode: 0o600 });
    await nodeFileSystem.utimes(ownerPath, modifiedAtMs / 1000, modifiedAtMs / 1000);
    if (process.platform === "win32") {
      await lockDownLocalPath(lockPath, { platform: "win32" });
      await lockDownLocalPath(ownerPath, { platform: "win32", kind: "file" });
    }
  } else {
    await nodeFileSystem.utimes(lockPath, modifiedAtMs / 1000, modifiedAtMs / 1000);
    if (process.platform === "win32") {
      await lockDownLocalPath(lockPath, { platform: "win32" });
    }
  }
  return lockPath;
}

async function writeLifecycleReclaim(lockPath, {
  owner = {
    schemaVersion: 2,
    pid: RECLAIM_LOCK_PID,
    processStartIdentity: "reclaim-process-start",
    token: "33333333-3333-4333-8333-333333333333",
    publishedAtMs: Date.now() - 60_000,
  },
  modifiedAtMs = Date.now(),
} = {}) {
  const reclaimPath = join(lockPath, ".reclaim");
  await mkdir(reclaimPath, { mode: 0o700 });
  if (owner !== null) {
    const ownerPath = join(reclaimPath, ".owner.json");
    const contents = typeof owner === "string" ? owner : `${JSON.stringify(owner)}\n`;
    await nodeFileSystem.writeFile(ownerPath, contents, { mode: 0o600 });
    await nodeFileSystem.utimes(ownerPath, modifiedAtMs / 1000, modifiedAtMs / 1000);
    if (process.platform === "win32") {
      await lockDownLocalPath(reclaimPath, { platform: "win32" });
      await lockDownLocalPath(ownerPath, { platform: "win32", kind: "file" });
    }
  } else {
    await nodeFileSystem.utimes(reclaimPath, modifiedAtMs / 1000, modifiedAtMs / 1000);
    if (process.platform === "win32") {
      await lockDownLocalPath(reclaimPath, { platform: "win32" });
    }
  }
  return reclaimPath;
}

async function writeManagedStackMarker(homeDirectory, overrides = {}) {
  const installation = createLocalN8nStackInstallation({
    plan: plan(overrides),
    randomBytes: (length) => Buffer.alloc(length, 0x2a),
  });
  const installRoot = join(homeDirectory, ".relmio", "local", "n8n-stack");
  await mkdir(installRoot, { recursive: true, mode: 0o700 });
  await nodeFileSystem.writeFile(
    join(homeDirectory, ".relmio", ".managed-by-relmio-root.json"),
    `${JSON.stringify({ schemaVersion: 1, kind: "relmio-local-root" })}\n`,
    { mode: 0o600 },
  );
  await nodeFileSystem.writeFile(
    join(installRoot, ".managed-by-relmio.json"),
    `${JSON.stringify(installation.marker)}\n`,
    { mode: 0o600 },
  );
  return { installRoot, marker: installation.marker };
}

function createStatusFileSystem() {
  const mutations = [];
  const fileSystem = { ...nodeFileSystem };
  for (const method of [
    "appendFile",
    "chmod",
    "mkdir",
    "rename",
    "rm",
    "rmdir",
    "truncate",
    "unlink",
    "writeFile",
  ]) {
    fileSystem[method] = async (...args) => {
      mutations.push({ method, args });
      throw new Error(`Unexpected status mutation through ${method}.`);
    };
  }
  return { fileSystem, mutations };
}

function assertStatusProcessCallsAreReadOnly(calls) {
  for (const call of calls) {
    assert.equal(call.file, "docker");
    assert.ok(
      call.args.join(" ") ===
        "context inspect --format {{json .Endpoints.docker.Host}}" ||
      call.args.join(" ") === "context show" ||
      (call.args[0] === "compose" && call.args.includes("ps")) ||
      (call.args[0] === "ps" && call.args[1] === "--all") ||
      (["network", "volume"].includes(call.args[0]) && ["ls", "inspect"].includes(call.args[1])),
    );
  }
}

function assertOwnershipFormatsUseExplicitLabels(calls) {
  const ownershipCalls = calls.filter((call) =>
    (call.args[0] === "ps" && call.args[1] === "--all") ||
    (["network", "volume"].includes(call.args[0]) && call.args[1] === "ls"),
  );
  assert.notEqual(ownershipCalls.length, 0);
  for (const call of ownershipCalls) {
    const format = call.args.at(call.args.indexOf("--format") + 1);
    assert.equal(typeof format, "string");
    assert.doesNotMatch(format, /\.Labels|\{\{json \.\}\}/u);
    for (const label of OWNERSHIP_LABEL_KEYS) {
      assert.equal(format.includes(`.Label "${label}"`), true);
    }
  }
}

function createStackRunner({
  malformedPublisher = false,
  assistantMode = "disabled",
  assistantPublishers = [],
  assistantPublishersByService = {},
  contextHost = DOCKER_HOST,
  contextName = DOCKER_CONTEXT,
  ngrokExitedDuringStartup = false,
  partialUpFailure = false,
  partialResources = false,
  foreignProjectResource = false,
  downFailure = false,
  resourcesRemainAfterDown = false,
  resourcesRemainAfterDownAttempts = 0,
  initialResources = false,
  emptyComposeDependsOnLabel = false,
  malformedComposeLabel = null,
  ambiguousOwnershipMetadata = null,
  resourceInspectionFailure = false,
  resourceInspectionFailureAfterDown = false,
  initialServiceStates = {},
  assistantEgressNetworkInternal = false,
  serviceHealth = {},
  searxngSearchResult = {
    code: 0,
    stdout: JSON.stringify({ results: [] }),
    stderr: "",
  },
  startFailure = false,
  startupFailureOutput = null,
} = {}) {
  const calls = [];
  let up = false;
  let resourcesExist = initialResources;
  let downAttempts = 0;
  const services = [
    "n8n",
    "ngrok",
    ...(assistantMode === "disabled"
      ? []
      : ["relmio-sandbox-certs", "relmio-sandbox-api", "relmio-sandbox-runner-1"]),
    ...(assistantMode === "sandbox-with-searxng" ? ["relmio-searxng"] : []),
  ];
  const runningServices = services.filter(
    (service) => service !== "relmio-sandbox-certs" && !(ngrokExitedDuringStartup && service === "ngrok"),
  );
  const serviceState = (service) => {
    if (Object.hasOwn(initialServiceStates, service)) return initialServiceStates[service];
    if (!up) return "exited";
    if (service === "relmio-sandbox-certs") return "exited";
    if (ngrokExitedDuringStartup && service === "ngrok") return "exited";
    return "running";
  };
  const runner = async (spec) => {
    calls.push(spec);
    const joined = spec.args.join(" ");
    if (joined === "context inspect --format {{json .Endpoints.docker.Host}}") {
      return { code: 0, stdout: JSON.stringify(contextHost), stderr: "" };
    }
    if (joined === "context show") {
      return { code: 0, stdout: `${contextName}\n`, stderr: "" };
    }
    if (joined.includes("config --quiet")) return { code: 0, stdout: "", stderr: "" };
    if (joined.includes("up -d --wait")) {
      up = true;
      resourcesExist = true;
      return partialUpFailure || ngrokExitedDuringStartup
        ? startupFailureOutput ?? {
            code: 1,
            stdout: "n8n Healthy\nngrok Exited (1)\n",
            stderr: "dependency failed to start: ngrok exited (1)",
          }
        : { code: 0, stdout: "", stderr: "" };
    }
    if (joined.includes(" start ")) {
      if (startFailure) return { code: 1, stdout: "", stderr: "start failed" };
      up = true;
      return { code: 0, stdout: "", stderr: "" };
    }
    if (joined.includes("down --volumes --remove-orphans")) {
      up = false;
      downAttempts += 1;
      if (!resourcesRemainAfterDown && downAttempts > resourcesRemainAfterDownAttempts) {
        resourcesExist = false;
      }
      return downFailure
        ? { code: 1, stdout: "", stderr: "compose reported cleanup failure" }
        : { code: 0, stdout: "", stderr: "" };
    }
    if (joined.includes("ps --status running --services")) {
      const currentRunningServices = runningServices.filter(
        (service) => serviceState(service) === "running",
      );
      return {
        code: 0,
        stdout: currentRunningServices.length > 0 ? `${currentRunningServices.join("\n")}\n` : "",
        stderr: "",
      };
    }
    if (
      joined.includes("exec -T relmio-sandbox-api wget -qO-") &&
      joined.includes("http://relmio-searxng:8080/search?q=relmio&format=json")
    ) {
      return searxngSearchResult;
    }
    if (joined.includes("ps --all --format json") || joined.includes("ps --format json")) {
      const service = spec.args.at(-1);
      const expected = service === "n8n" ? 5678 : 4040;
      const isAssistant = !["n8n", "ngrok"].includes(service);
      if (!resourcesExist) return { code: 0, stdout: "", stderr: "" };
      const state = serviceState(service);
      return {
        code: 0,
        stdout: JSON.stringify({
          Service: service,
          State: state,
          Health: Object.hasOwn(serviceHealth, service)
            ? serviceHealth[service]
            : state === "running" ? "healthy" : "",
          Publishers: isAssistant
            ? assistantPublishersByService[service] ?? assistantPublishers
            : [{
              URL: malformedPublisher && service === "ngrok" ? "0.0.0.0" : "127.0.0.1",
              PublishedPort: expected,
              TargetPort: expected,
              Protocol: "tcp",
            }],
        }),
        stderr: "",
      };
    }
    if (spec.args[0] === "network" && spec.args[1] === "inspect") {
      return {
        code: 0,
        stdout: assistantEgressNetworkInternal ? "true\n" : "false\n",
        stderr: "",
      };
    }
    const project = spec.args.find((value) => value.startsWith("label=com.docker.compose.project="))?.split("=").at(-1);
    const installId = project?.slice(-32);
    const availableLabels = {
      "com.docker.compose.project": project,
      ...(emptyComposeDependsOnLabel ? { "com.docker.compose.depends_on": "" } : {}),
      ...(ambiguousOwnershipMetadata === "embedded-comma-pseudo"
        ? { "com.example.note": "untrusted,io.relmio.managed=true" }
        : {
            "io.relmio.managed": ambiguousOwnershipMetadata === "duplicate-expected"
              ? "false,io.relmio.managed=true"
              : "true",
          }),
      "io.relmio.target": LOCAL_N8N_STACK_TARGET,
      "io.relmio.install": installId,
      "io.relmio.project": project,
    };
    const labels = [
      ...Object.entries(availableLabels).map(([key, value]) => `${key}=${value}`),
      ...(malformedComposeLabel === null ? [] : [malformedComposeLabel]),
    ].join(",");
    const explicitLabels = Object.fromEntries(
      OWNERSHIP_LABEL_KEYS.map((key) => [key, availableLabels[key] ?? ""]),
    );
    const explicitOwnershipFormat = spec.args.find(
      (value) => typeof value === "string" && value.includes('.Label "io.relmio.managed"'),
    );
    const ownershipRow = (Name, Labels = explicitLabels) => explicitOwnershipFormat
      ? { Name, Labels }
      : { Name, Labels: labels };
    if (spec.args[0] === "ps" && project) {
      if (resourceInspectionFailure || (resourceInspectionFailureAfterDown && downAttempts > 0)) {
        return { code: 1, stdout: "", stderr: "post-cleanup inspection unavailable" };
      }
      if (!resourcesExist) return { code: 0, stdout: "", stderr: "" };
      const listedServices = partialResources ? ["n8n"] : services;
      const rows = listedServices.map((service) => JSON.stringify(
        ownershipRow(`${project}-${service}-1`),
      ));
      if (foreignProjectResource) {
        rows.push(JSON.stringify({
          ...ownershipRow(`${project}-foreign-1`, {
            ...explicitLabels,
            "io.relmio.install": "f".repeat(32),
          }),
          ...(explicitOwnershipFormat ? {} : {
            Labels: `com.docker.compose.project=${project},io.relmio.managed=true,io.relmio.target=${LOCAL_N8N_STACK_TARGET},io.relmio.install=${"f".repeat(32)},io.relmio.project=${project},com.docker.compose.service=foreign`,
          }),
        }));
      }
      return {
        code: 0,
        stdout: rows.join("\n"),
        stderr: "",
      };
    }
    if ((spec.args[0] === "volume" || spec.args[0] === "network") && project) {
      if (!resourcesExist) return { code: 0, stdout: "", stderr: "" };
      const names = spec.args[0] === "volume"
        ? [`${project}_n8n-data`, ...(assistantMode === "disabled" ? [] : [`${project}_sandbox-tls`])]
        : [`${project}_edge`, ...(assistantMode === "disabled" ? [] : [`${project}_assistant-shared`, `${project}_assistant-internal`])];
      return {
        code: 0,
        stdout: (partialResources ? [] : names).map((Name) => JSON.stringify(ownershipRow(Name))).join("\n"),
        stderr: "",
      };
    }
    return { code: 0, stdout: "", stderr: "" };
  };
  return { calls, runner };
}

test("managed local n8n status is safely negative when the install root is absent", async (t) => {
  const homeDirectory = await testHome(t);
  const { calls, runner } = createStackRunner();
  const { fileSystem, mutations } = createStatusFileSystem();

  assert.deepEqual(await getLocalN8nStackStatus({
    homeDirectory,
    runProcess: runner,
    fileSystem,
  }), { managed: false, state: "absent" });
  assert.deepEqual(calls, []);
  assert.deepEqual(mutations, []);
});

test("restart status confirms valid root ownership and an owned resource subset without mutations", async (t) => {
  const homeDirectory = await testHome(t);
  await writeManagedStackMarker(homeDirectory);
  const { calls, runner } = createStackRunner({
    initialResources: true,
    partialResources: true,
    emptyComposeDependsOnLabel: true,
  });
  const { fileSystem, mutations } = createStatusFileSystem();

  assert.deepEqual(await getLocalN8nStackStatus({
    homeDirectory,
    runProcess: runner,
    fileSystem,
  }), { managed: true, state: "partial" });
  assertStatusProcessCallsAreReadOnly(calls);
  assertOwnershipFormatsUseExplicitLabels(calls);
  assert.deepEqual(mutations, []);
});

test("restart status requires a valid managed-root ownership marker", async (t) => {
  for (const rootMarkerState of ["absent", "corrupt"]) {
    await t.test(rootMarkerState, async (subtest) => {
      const homeDirectory = await testHome(subtest);
      await writeManagedStackMarker(homeDirectory);
      const rootMarkerPath = join(homeDirectory, ".relmio", ".managed-by-relmio-root.json");
      if (rootMarkerState === "absent") await rm(rootMarkerPath);
      else await nodeFileSystem.writeFile(rootMarkerPath, "{\"schemaVersion\":1,\"kind\":\"foreign-root\"}\n");
      const { calls, runner } = createStackRunner({ initialResources: true });
      const { fileSystem, mutations } = createStatusFileSystem();

      assert.deepEqual(await getLocalN8nStackStatus({
        homeDirectory,
        runProcess: runner,
        fileSystem,
      }), { managed: false, state: "unavailable" });
      assert.deepEqual(calls, []);
      assert.deepEqual(mutations, []);
    });
  }
});

test("restart status rejects a symbolic-link managed-root marker", async (t) => {
  const homeDirectory = await testHome(t);
  await writeManagedStackMarker(homeDirectory);
  const rootMarkerPath = join(homeDirectory, ".relmio", ".managed-by-relmio-root.json");
  const { calls, runner } = createStackRunner({ initialResources: true });
  const { fileSystem: readOnlyFileSystem, mutations } = createStatusFileSystem();
  const fileSystem = {
    ...readOnlyFileSystem,
    async lstat(path) {
      if (path === rootMarkerPath) {
        return {
          isFile: () => true,
          isSymbolicLink: () => true,
        };
      }
      return readOnlyFileSystem.lstat(path);
    },
  };

  assert.deepEqual(await getLocalN8nStackStatus({
    homeDirectory,
    runProcess: runner,
    fileSystem,
  }), { managed: false, state: "unavailable" });
  assert.deepEqual(calls, []);
  assert.deepEqual(mutations, []);
});

test("restart status rejects an unsafe managed root without mutating it", async (t) => {
  const homeDirectory = await testHome(t);
  await writeManagedStackMarker(homeDirectory);
  const relmioRoot = join(homeDirectory, ".relmio");
  const { calls, runner } = createStackRunner({ initialResources: true });
  const { fileSystem: readOnlyFileSystem, mutations } = createStatusFileSystem();
  const fileSystem = {
    ...readOnlyFileSystem,
    async lstat(path) {
      if (path === relmioRoot) {
        return {
          isDirectory: () => false,
          isSymbolicLink: () => false,
        };
      }
      return readOnlyFileSystem.lstat(path);
    },
  };

  assert.deepEqual(await getLocalN8nStackStatus({
    homeDirectory,
    runProcess: runner,
    fileSystem,
  }), { managed: false, state: "unavailable" });
  assert.deepEqual(calls, []);
  assert.deepEqual(mutations, []);
});

test("restart status keeps stale exact-marker files recoverable with a valid root and zero resources", async (t) => {
  const homeDirectory = await testHome(t);
  await writeManagedStackMarker(homeDirectory);
  const { calls, runner } = createStackRunner();
  const { fileSystem, mutations } = createStatusFileSystem();

  assert.deepEqual(await getLocalN8nStackStatus({
    homeDirectory,
    runProcess: runner,
    fileSystem,
  }), { managed: true, state: "partial" });
  assertStatusProcessCallsAreReadOnly(calls);
  assert.deepEqual(mutations, []);
});

test("managed local n8n status fails closed for unmanaged markers and foreign resources", async (t) => {
  const unmanagedHome = await testHome(t);
  const { installRoot, marker } = await writeManagedStackMarker(unmanagedHome);
  await nodeFileSystem.writeFile(
    join(installRoot, ".managed-by-relmio.json"),
    `${JSON.stringify({ ...marker, foreign: true })}\n`,
  );
  const unmanagedRunner = createStackRunner({ initialResources: true });
  assert.deepEqual(await getLocalN8nStackStatus({
    homeDirectory: unmanagedHome,
    runProcess: unmanagedRunner.runner,
  }), { managed: false, state: "unavailable" });
  assert.deepEqual(unmanagedRunner.calls, []);

  const foreignHome = await testHome(t);
  await writeManagedStackMarker(foreignHome);
  const foreignRunner = createStackRunner({
    initialResources: true,
    foreignProjectResource: true,
  });
  assert.deepEqual(await getLocalN8nStackStatus({
    homeDirectory: foreignHome,
    runProcess: foreignRunner.runner,
  }), { managed: false, state: "unavailable" });
  assertStatusProcessCallsAreReadOnly(foreignRunner.calls);
});

test("managed local n8n status fails closed when resource attestation is unavailable", async (t) => {
  const homeDirectory = await testHome(t);
  await writeManagedStackMarker(homeDirectory);
  const { calls, runner } = createStackRunner({
    initialResources: true,
    resourceInspectionFailure: true,
  });

  assert.deepEqual(await getLocalN8nStackStatus({
    homeDirectory,
    runProcess: runner,
  }), { managed: false, state: "unavailable" });
  assertStatusProcessCallsAreReadOnly(calls);
});

test("managed local n8n status isolates ownership from unrelated malformed aggregate labels", async (t) => {
  for (const malformedComposeLabel of ["=missing-key", "missing-equals"]) {
    await t.test(malformedComposeLabel, async (subtest) => {
      const homeDirectory = await testHome(subtest);
      await writeManagedStackMarker(homeDirectory);
      const { calls, runner } = createStackRunner({
        initialResources: true,
        malformedComposeLabel,
      });

      assert.deepEqual(await getLocalN8nStackStatus({
        homeDirectory,
        runProcess: runner,
      }), { managed: true, state: "stopped" });
      assertStatusProcessCallsAreReadOnly(calls);
      assertOwnershipFormatsUseExplicitLabels(calls);
    });
  }
});

const AMBIGUOUS_OWNERSHIP_METADATA_CASES = [
  "duplicate-expected",
  "embedded-comma-pseudo",
];

test("status fails closed for duplicate and comma-injected ownership label metadata", async (t) => {
  for (const ambiguousOwnershipMetadata of AMBIGUOUS_OWNERSHIP_METADATA_CASES) {
    await t.test(ambiguousOwnershipMetadata, async (subtest) => {
      const homeDirectory = await testHome(subtest);
      await writeManagedStackMarker(homeDirectory);
      const { calls, runner } = createStackRunner({
        initialResources: true,
        ambiguousOwnershipMetadata,
      });

      assert.deepEqual(await getLocalN8nStackStatus({
        homeDirectory,
        runProcess: runner,
      }), { managed: false, state: "unavailable" });
      assertStatusProcessCallsAreReadOnly(calls);
      assertOwnershipFormatsUseExplicitLabels(calls);
    });
  }
});

test("install refuses duplicate and comma-injected ownership metadata without cleanup", async (t) => {
  for (const ambiguousOwnershipMetadata of AMBIGUOUS_OWNERSHIP_METADATA_CASES) {
    await t.test(ambiguousOwnershipMetadata, async (subtest) => {
      const homeDirectory = await testHome(subtest);
      const { calls, runner } = createStackRunner({ ambiguousOwnershipMetadata });

      await assert.rejects(() => installLocalN8nStack({
        plan: plan(),
        secrets: {
          ngrokAuthtoken: "ngrok-private-token",
          basicAuthUsername: "operator",
          basicAuthPassword: "long-private-password",
        },
        publicExposureConfirmation: "EXPOSE_LOCAL_N8N_VIA_NGROK",
        homeDirectory,
        runProcess: runner,
      }), /ownership could not be safely confirmed/u);
      assert.equal(
        calls.some((call) => call.args.join(" ").includes("down --volumes --remove-orphans")),
        false,
      );
      assertOwnershipFormatsUseExplicitLabels(calls);
      await stat(join(homeDirectory, ".relmio", "local", "n8n-stack", ".managed-by-relmio.json"));
    });
  }
});

test("removal refuses duplicate and comma-injected ownership metadata without Docker writes", async (t) => {
  for (const ambiguousOwnershipMetadata of AMBIGUOUS_OWNERSHIP_METADATA_CASES) {
    await t.test(ambiguousOwnershipMetadata, async (subtest) => {
      const homeDirectory = await testHome(subtest);
      await writeManagedStackMarker(homeDirectory);
      const { calls, runner } = createStackRunner({
        initialResources: true,
        ambiguousOwnershipMetadata,
      });

      await assert.rejects(() => removeLocalN8nStack({
        homeDirectory,
        runProcess: runner,
        confirmation: "REMOVE_LOCAL_N8N_STACK",
      }), /ownership could not be safely confirmed/u);
      assert.equal(
        calls.some((call) => call.args.join(" ").includes("down --volumes --remove-orphans")),
        false,
      );
      assertOwnershipFormatsUseExplicitLabels(calls);
      await stat(join(homeDirectory, ".relmio", "local", "n8n-stack", ".managed-by-relmio.json"));
    });
  }
});

test("managed local n8n status fails closed when the current Docker host or context differs", async (t) => {
  const homeDirectory = await testHome(t);
  await writeManagedStackMarker(homeDirectory);
  const { calls, runner } = createStackRunner({
    initialResources: true,
    contextHost: process.platform === "win32"
      ? DOCKER_HOST
      : "unix:///run/user/1000/docker.sock",
    contextName: process.platform === "win32" ? "default" : DOCKER_CONTEXT,
  });

  assert.deepEqual(await getLocalN8nStackStatus({
    homeDirectory,
    runProcess: runner,
  }), { managed: false, state: "unavailable" });
  assertStatusProcessCallsAreReadOnly(calls);
  assert.equal(calls.some((entry) => ["ps", "network", "volume"].includes(entry.args[0])), false);
});

test("managed local n8n status distinguishes exact healthy, exact stopped, partial, and unavailable states", async (t) => {
  const cases = [
    {
      name: "healthy exact stack",
      runner: () => createStackRunner({
        initialResources: true,
        initialServiceStates: { n8n: "running", ngrok: "running" },
      }),
      expected: { managed: true, state: "healthy" },
    },
    {
      name: "stopped exact stack",
      runner: () => createStackRunner({ initialResources: true }),
      expected: { managed: true, state: "stopped" },
    },
    {
      name: "mixed runtime state",
      runner: () => createStackRunner({
        initialResources: true,
        initialServiceStates: { n8n: "running", ngrok: "exited" },
      }),
      expected: { managed: true, state: "partial" },
    },
    {
      name: "unavailable ownership metadata",
      runner: () => createStackRunner({
        initialResources: true,
        ambiguousOwnershipMetadata: "duplicate-expected",
      }),
      expected: { managed: false, state: "unavailable" },
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async (subtest) => {
      const homeDirectory = await testHome(subtest);
      await writeManagedStackMarker(homeDirectory);
      const { calls, runner } = scenario.runner();
      const { fileSystem, mutations } = createStatusFileSystem();
      assert.deepEqual(await getLocalN8nStackStatus({
        homeDirectory,
        runProcess: runner,
        fileSystem,
      }), scenario.expected);
      assertStatusProcessCallsAreReadOnly(calls);
      assert.deepEqual(mutations, []);
    });
  }
});

test("resume starts only an exact owner-attested stopped stack", async (t) => {
  const homeDirectory = await testHome(t);
  await writeManagedStackMarker(homeDirectory, { assistantMode: "sandbox" });
  const { calls, runner } = createStackRunner({
    assistantMode: "sandbox",
    initialResources: true,
  });

  const result = await resumeLocalN8nStack({
    confirmed: true,
    homeDirectory,
    runProcess: runner,
  });

  assert.deepEqual(result, {
    target: "local-n8n-stack",
    resumed: true,
    deploymentMode: "resumed-owned-disposable-stack",
  });
  const start = calls.find((call) => call.args.includes("start"));
  assert.ok(start);
  assert.deepEqual(start.args.slice(-4), [
    "n8n",
    "ngrok",
    "relmio-sandbox-api",
    "relmio-sandbox-runner-1",
  ]);
  assert.equal(calls.some((call) => call.args.includes("up")), false);
  assert.equal(calls.some((call) => call.args.includes("down")), false);
  assert.equal(calls.some((call) => call.args.includes("--volumes")), false);
  assert.equal(calls.some((call) => call.args.includes("relmio-sandbox-certs") && call.args.includes("start")), false);
  assert.equal(calls.filter((call) =>
    call.args[0] === "network" && call.args[1] === "inspect" &&
    call.args.includes("{{json .Internal}}")
  ).length, 4);
});

test("resume refuses partial or unavailable stacks without starting containers", async (t) => {
  const cases = [
    {
      name: "partial resource set",
      runner: () => createStackRunner({ initialResources: true, partialResources: true }),
    },
    {
      name: "ambiguous ownership metadata",
      runner: () => createStackRunner({
        initialResources: true,
        ambiguousOwnershipMetadata: "duplicate-expected",
      }),
    },
    {
      name: "Assistant network unexpectedly internal",
      planOverrides: { assistantMode: "sandbox" },
      runner: () => createStackRunner({
        assistantMode: "sandbox",
        initialResources: true,
        assistantEgressNetworkInternal: true,
      }),
    },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async (subtest) => {
      const homeDirectory = await testHome(subtest);
      await writeManagedStackMarker(homeDirectory, scenario.planOverrides);
      const { calls, runner } = scenario.runner();
      await assert.rejects(() => resumeLocalN8nStack({
        confirmed: true,
        homeDirectory,
        runProcess: runner,
      }), /can resume only|ownership-attested stopped/u);
      assert.equal(calls.some((call) => call.args.includes("start")), false);
      assert.equal(calls.some((call) => call.args.includes("up")), false);
      assert.equal(calls.some((call) => call.args.includes("down")), false);
    });
  }
});

test("ready verification rejects internal Assistant egress networks without changing unrelated resources", async (t) => {
  const homeDirectory = await testHome(t);
  const { calls, runner } = createStackRunner({
    assistantMode: "sandbox",
    assistantEgressNetworkInternal: true,
  });
  let captured;
  await assert.rejects(async () => {
    try {
      await installLocalN8nStack({
        plan: plan({ assistantMode: "sandbox" }),
        secrets: {
          ngrokAuthtoken: "ngrok-private-token",
          basicAuthUsername: "operator",
          basicAuthPassword: "long-private-password",
        },
        publicExposureConfirmation: "EXPOSE_LOCAL_N8N_VIA_NGROK",
        homeDirectory,
        runProcess: runner,
      });
    } catch (error) {
      captured = error;
      throw error;
    }
  }, /Assistant services did not pass runtime or network isolation verification/u);
  assert.equal(captured.code, LOCAL_N8N_STACK_RETRYABLE_STARTUP_ERROR_CODE);
  assert.equal(
    captured.failureKind,
    "assistant-verification",
  );
  assert.doesNotMatch(captured.message, /authtoken|reserved ngrok hostname/u);
  const inspections = calls.filter((call) =>
    call.args[0] === "network" && call.args[1] === "inspect",
  );
  assert.equal(inspections.length, 1);
  assert.ok(inspections.every((call) => call.args.includes("{{json .Internal}}")));
  assert.match(inspections[0].args.at(-1), /_assistant-shared$/u);
  assert.equal(calls.some((call) => call.args.includes("docker.sock")), false);
});

test("a safely cleaned n8n health failure remains an n8n failure and releases the lifecycle lock", async (t) => {
  const homeDirectory = await testHome(t);
  const failed = createStackRunner({ serviceHealth: { n8n: "unhealthy" } });
  let captured;
  await assert.rejects(async () => {
    try {
      await installLocalN8nStack({
        plan: plan(),
        secrets: {
          ngrokAuthtoken: "ngrok-private-token",
          basicAuthUsername: "operator",
          basicAuthPassword: "long-private-password",
        },
        publicExposureConfirmation: "EXPOSE_LOCAL_N8N_VIA_NGROK",
        homeDirectory,
        runProcess: failed.runner,
      });
    } catch (error) {
      captured = error;
      throw error;
    }
  }, /n8n service did not pass health verification/u);
  assert.equal(captured.code, LOCAL_N8N_STACK_RETRYABLE_STARTUP_ERROR_CODE);
  assert.equal(
    captured.failureKind,
    "n8n-verification",
  );
  assert.doesNotMatch(captured.message, /authtoken|reserved ngrok hostname/u);
  assert.equal(
    failed.calls.filter((entry) => entry.args.join(" ").includes("down --volumes --remove-orphans")).length,
    1,
  );

  const retry = createStackRunner();
  const result = await installLocalN8nStack({
    plan: plan(),
    secrets: {
      ngrokAuthtoken: "replacement-token",
      basicAuthUsername: "operator",
      basicAuthPassword: "replacement-password",
    },
    publicExposureConfirmation: "EXPOSE_LOCAL_N8N_VIA_NGROK",
    homeDirectory,
    runProcess: retry.runner,
  });
  assert.equal(result.target, LOCAL_N8N_STACK_TARGET);
});

test("install and cleanup attestation accept realistic Compose labels with empty values", async (t) => {
  const homeDirectory = await testHome(t);
  const { calls, runner } = createStackRunner({ emptyComposeDependsOnLabel: true });
  await installLocalN8nStack({
    plan: plan(),
    secrets: {
      ngrokAuthtoken: "ngrok-private-token",
      basicAuthUsername: "operator",
      basicAuthPassword: "long-private-password",
    },
    publicExposureConfirmation: "EXPOSE_LOCAL_N8N_VIA_NGROK",
    homeDirectory,
    runProcess: runner,
  });
  const removed = await removeLocalN8nStack({
    homeDirectory,
    runProcess: runner,
    confirmation: "REMOVE_LOCAL_N8N_STACK",
  });
  assert.equal(removed.removed, true);
  assert.equal(calls.some((entry) => entry.args.join(" ").includes("down --volumes --remove-orphans")), true);
  assertOwnershipFormatsUseExplicitLabels(calls);
});

test("installer creates only the new owned project and returns a redacted result", async (t) => {
  const homeDirectory = await testHome(t);
  const { calls, runner } = createStackRunner();
  const result = await installLocalN8nStack({
    plan: plan(),
    secrets: {
      ngrokAuthtoken: "ngrok-private-token",
      basicAuthUsername: "operator",
      basicAuthPassword: "long-private-password",
    },
    publicExposureConfirmation: "EXPOSE_LOCAL_N8N_VIA_NGROK",
    homeDirectory,
    runProcess: runner,
    randomBytes: (() => { let value = 10; return (length) => Buffer.alloc(length, ++value); })(),
  });
  assert.equal(result.target, LOCAL_N8N_STACK_TARGET);
  assert.equal(result.localUrl, "http://127.0.0.1:5678");
  assert.equal(result.ngrokPublicUrl, "https://relmio-demo.ngrok.app");
  assert.equal(JSON.stringify(result).includes("private"), false);
  assert.equal(calls.some((entry) => entry.args.join(" ").includes("container inspect")), false);
  assert.equal(calls.some((entry) => /\b(restart|recreate|exec)\b/u.test(entry.args.join(" "))), false);
  const pullCall = calls.find((entry) => entry.args.includes("pull") && entry.args.includes("compose"));
  const upCall = calls.find((entry) => entry.args.includes("up") && entry.args.includes("--wait"));
  assert.equal(pullCall?.timeoutMs, LOCAL_N8N_STACK_COMPOSE_PULL_TIMEOUT_MS);
  assert.equal(upCall?.timeoutMs, LOCAL_N8N_STACK_COMPOSE_UP_TIMEOUT_MS);
  assert.deepEqual(
    upCall?.args.slice(upCall.args.indexOf("up")),
    ["up", "-d", "--wait", "--wait-timeout", String(LOCAL_N8N_STACK_COMPOSE_WAIT_TIMEOUT_SECONDS)],
  );
  assert.equal(LOCAL_N8N_STACK_COMPOSE_WAIT_TIMEOUT_SECONDS >= 180, true);
  const installRoot = join(homeDirectory, ".relmio", "local", "n8n-stack");
  if (process.platform !== "win32") {
    assert.equal((await stat(installRoot)).mode & 0o777, 0o700);
    assert.equal((await stat(join(installRoot, ".env"))).mode & 0o777, 0o600);
    assert.equal((await stat(join(installRoot, ".managed-by-relmio.json"))).mode & 0o777, 0o600);
    assert.equal((await stat(join(installRoot, "docker-compose.yml"))).mode & 0o777, 0o600);
    assert.equal((await stat(join(installRoot, "ngrok.yml"))).mode & 0o777, 0o644);
    assert.equal((await stat(join(installRoot, ".runtime", "traffic-policy.yml"))).mode & 0o777, 0o600);
  }
  const removed = await removeLocalN8nStack({
    homeDirectory,
    runProcess: runner,
    confirmation: "REMOVE_LOCAL_N8N_STACK",
  });
  assert.deepEqual(removed, {
    target: LOCAL_N8N_STACK_TARGET,
    removed: true,
    deploymentMode: "removed-owned-disposable-stack",
  });
  await assert.rejects(() => stat(installRoot));
});

test("malformed host publication fails closed, rolls back only an attested project, and removal needs confirmation", async (t) => {
  const homeDirectory = await testHome(t);
  const { calls, runner } = createStackRunner({ malformedPublisher: true });
  await assert.rejects(() => installLocalN8nStack({
    plan: plan(),
    secrets: {
      ngrokAuthtoken: "ngrok-private-token",
      basicAuthUsername: "operator",
      basicAuthPassword: "long-private-password",
    },
    publicExposureConfirmation: "EXPOSE_LOCAL_N8N_VIA_NGROK",
    homeDirectory,
    runProcess: runner,
  }));
  assert.equal(calls.some((entry) => entry.args.join(" ").includes("down --volumes --remove-orphans")), true);
  await assert.rejects(() => removeLocalN8nStack({
    homeDirectory,
    runProcess: runner,
    confirmation: "wrong",
  }));
});

test("Assistant services accept only empty or Compose placeholder unpublished publishers", async (t) => {
  for (const publishers of [
    [],
    [{ URL: "", PublishedPort: 0, TargetPort: 8080, Protocol: "tcp" }],
    [
      { URL: "", PublishedPort: 0, TargetPort: 8080, Protocol: "tcp" },
      { URL: "", PublishedPort: 0, TargetPort: 9090, Protocol: "tcp" },
    ],
  ]) {
    const homeDirectory = await testHome(t);
    const { calls, runner } = createStackRunner({
      assistantMode: "sandbox-with-searxng",
      assistantPublishers: publishers,
    });
    const result = await installLocalN8nStack({
      plan: plan({ assistantMode: "sandbox-with-searxng" }),
      secrets: {
        ngrokAuthtoken: "ngrok-private-token",
        basicAuthUsername: "operator",
        basicAuthPassword: "long-private-password",
      },
      publicExposureConfirmation: "EXPOSE_LOCAL_N8N_VIA_NGROK",
      homeDirectory,
      runProcess: runner,
    });
    assert.equal(result.assistantMode, "sandbox-with-searxng");
    const searchProbes = calls.filter((entry) =>
      entry.args.join(" ").includes(
        "exec -T relmio-sandbox-api wget -qO- http://relmio-searxng:8080/search?q=relmio&format=json",
      ),
    );
    assert.equal(searchProbes.length, 1);
    assert.equal(
      searchProbes[0].args.some((value) => /(?:localhost|127\.0\.0\.1):\d+\/search/u.test(value)),
      false,
    );
    assert.equal(
      calls.some((entry) => entry.args.includes("relmio-searxng") && entry.args.includes("ports")),
      false,
    );
    if (process.platform !== "win32") {
      assert.equal(
        (await stat(join(homeDirectory, ".relmio", "local", "n8n-stack", ".runtime", "searxng-settings.yml"))).mode & 0o777,
        0o644,
      );
    }
  }

  for (const publishers of [
    [{ URL: "", PublishedPort: 0, TargetPort: 8080, Protocol: "udp" }],
    [{ URL: "", PublishedPort: 0, TargetPort: 7070, Protocol: "tcp" }],
    [{ URL: "127.0.0.1", PublishedPort: 19090, TargetPort: 9090, Protocol: "tcp" }],
  ]) {
    const homeDirectory = await testHome(t);
    const { calls, runner } = createStackRunner({
      assistantMode: "sandbox",
      assistantPublishers: publishers,
    });
    await assert.rejects(() => installLocalN8nStack({
      plan: plan({ assistantMode: "sandbox" }),
      secrets: {
        ngrokAuthtoken: "ngrok-private-token",
        basicAuthUsername: "operator",
        basicAuthPassword: "long-private-password",
      },
      publicExposureConfirmation: "EXPOSE_LOCAL_N8N_VIA_NGROK",
      homeDirectory,
      runProcess: runner,
    }));
    assert.equal(calls.some((entry) => entry.args.join(" ").includes("down --volumes --remove-orphans")), true);
  }
});

test("stack unit operations use the injected Windows ACL adapter", async (t) => {
  const homeDirectory = await testHome(t);
  const installRoot = await resolveLocalN8nStackInstallRoot({
    homeDirectory,
    platform: "win32",
  });
  const { runner } = createStackRunner({
    contextHost: WINDOWS_DOCKER_HOST,
    contextName: "desktop-linux",
  });
  const lockCalls = [];

  await installLocalN8nStack({
    plan: plan({ dockerHost: WINDOWS_DOCKER_HOST }),
    secrets: {
      ngrokAuthtoken: "ngrok-private-token",
      basicAuthUsername: "operator",
      basicAuthPassword: "long-private-password",
    },
    publicExposureConfirmation: "EXPOSE_LOCAL_N8N_VIA_NGROK",
    homeDirectory,
    platform: "win32",
    runProcess: runner,
    async lockDownPath(path, options) {
      lockCalls.push({ path, options });
    },
  });

  for (const path of [
    join(homeDirectory, ".relmio"),
    join(homeDirectory, ".relmio", "local"),
    installRoot,
    join(installRoot, ".runtime"),
  ]) {
    assert.ok(lockCalls.some((call) => call.path === path && call.options.verifyOnly !== true));
  }
  const lifecyclePath = join(homeDirectory, ".relmio", "local", "n8n-stack.lock");
  const ownerPath = join(lifecyclePath, ".owner.json");
  assert.ok(lockCalls.some((call) => call.path === lifecyclePath && call.options.verifyOnly === true));
  assert.ok(lockCalls.some((call) =>
    call.path === ownerPath && call.options.kind === "file" && call.options.verifyOnly === true,
  ));
});

test("managed SearXNG status stays structural and never issues a functional search probe", async (t) => {
  const homeDirectory = await testHome(t);
  await writeManagedStackMarker(homeDirectory, {
    assistantMode: "sandbox-with-searxng",
  });
  const { calls, runner } = createStackRunner({
    assistantMode: "sandbox-with-searxng",
    initialResources: true,
    initialServiceStates: {
      n8n: "running",
      ngrok: "running",
      "relmio-sandbox-certs": "exited",
      "relmio-sandbox-api": "running",
      "relmio-sandbox-runner-1": "running",
      "relmio-searxng": "running",
    },
    searxngSearchResult: {
      code: 1,
      stdout: "",
      stderr: "transient search failure",
    },
  });
  const { fileSystem, mutations } = createStatusFileSystem();

  assert.deepEqual(await getLocalN8nStackStatus({
    homeDirectory,
    runProcess: runner,
    fileSystem,
  }), { managed: true, state: "healthy" });
  assertStatusProcessCallsAreReadOnly(calls);
  assert.equal(calls.some((entry) => entry.args.includes("exec")), false);
  assert.equal(
    calls.some((entry) => entry.args.join(" ").includes("format=json")),
    false,
  );
  assert.deepEqual(mutations, []);
});

test("SearXNG success requires a JSON search results array and failures clean up without ngrok guidance", async (t) => {
  const cases = [
    {
      name: "probe command failure",
      result: {
        code: 1,
        stdout: "",
        stderr: "wget failed in C:\\private\\stack with ngrok-private-token",
      },
    },
    {
      name: "non-JSON response",
      result: { code: 0, stdout: "<html>not json</html>", stderr: "" },
    },
    {
      name: "missing results array",
      result: { code: 0, stdout: JSON.stringify({ answers: [] }), stderr: "" },
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async (subtest) => {
      const homeDirectory = await testHome(subtest);
      const { calls, runner } = createStackRunner({
        assistantMode: "sandbox-with-searxng",
        searxngSearchResult: scenario.result,
      });
      let captured;
      await assert.rejects(async () => {
        try {
          await installLocalN8nStack({
            plan: plan({ assistantMode: "sandbox-with-searxng" }),
            secrets: {
              ngrokAuthtoken: "ngrok-private-token",
              basicAuthUsername: "operator",
              basicAuthPassword: "long-private-password",
            },
            publicExposureConfirmation: "EXPOSE_LOCAL_N8N_VIA_NGROK",
            homeDirectory,
            runProcess: runner,
          });
        } catch (error) {
          captured = error;
          throw error;
        }
      }, /SearXNG service did not return a valid JSON search result/u);
      assert.equal(captured.code, LOCAL_N8N_STACK_RETRYABLE_STARTUP_ERROR_CODE);
      assert.equal(
        captured.failureKind,
        "searxng-search-verification",
      );
      assert.doesNotMatch(
        captured.message,
        /ngrok-private-token|C:\\private|<html>|authtoken|reserved ngrok hostname/u,
      );
      assert.equal(
        calls.filter((entry) => entry.args.join(" ").includes("down --volumes --remove-orphans")).length,
        1,
      );
      await assert.rejects(() =>
        stat(join(homeDirectory, ".relmio", "local", "n8n-stack")),
      );
    });
  }
});

test("SearXNG host publication fails before the functional search probe", async (t) => {
  const homeDirectory = await testHome(t);
  const { calls, runner } = createStackRunner({
    assistantMode: "sandbox-with-searxng",
    assistantPublishersByService: {
      "relmio-searxng": [{
        URL: "127.0.0.1",
        PublishedPort: 18080,
        TargetPort: 8080,
        Protocol: "tcp",
      }],
    },
  });
  let captured;
  await assert.rejects(async () => {
    try {
      await installLocalN8nStack({
        plan: plan({ assistantMode: "sandbox-with-searxng" }),
        secrets: {
          ngrokAuthtoken: "ngrok-private-token",
          basicAuthUsername: "operator",
          basicAuthPassword: "long-private-password",
        },
        publicExposureConfirmation: "EXPOSE_LOCAL_N8N_VIA_NGROK",
        homeDirectory,
        runProcess: runner,
      });
    } catch (error) {
      captured = error;
      throw error;
    }
  }, /Assistant services did not pass runtime or network isolation verification/u);
  assert.equal(captured.code, LOCAL_N8N_STACK_RETRYABLE_STARTUP_ERROR_CODE);
  assert.equal(captured.failureKind, "assistant-verification");
  assert.equal(
    calls.some((entry) => entry.args.join(" ").includes("format=json")),
    false,
  );
  assert.equal(
    calls.filter((entry) =>
      entry.args.join(" ").includes("down --volumes --remove-orphans")
    ).length,
    1,
  );
});

test("project-wide ownership attestation exposes foreign project resources and refuses cleanup", async (t) => {
  const homeDirectory = await testHome(t);
  const { calls, runner } = createStackRunner({ foreignProjectResource: true });
  let errorCode;
  await assert.rejects(async () => {
    try {
      await installLocalN8nStack({
        plan: plan(),
        secrets: {
          ngrokAuthtoken: "ngrok-private-token",
          basicAuthUsername: "operator",
          basicAuthPassword: "long-private-password",
        },
        publicExposureConfirmation: "EXPOSE_LOCAL_N8N_VIA_NGROK",
        homeDirectory,
        runProcess: runner,
      });
    } catch (error) {
      errorCode = error.code;
      throw error;
    }
  });
  const ownershipCalls = calls.filter((entry) => entry.args[0] === "ps" && entry.args.includes("--all"));
  assert.equal(ownershipCalls.length > 0, true);
  assert.equal(ownershipCalls.every((entry) => !entry.args.some((value) => value.startsWith("label=io.relmio.install="))), true);
  assert.equal(calls.some((entry) => entry.args.join(" ").includes("down --volumes --remove-orphans")), false);
  await stat(join(homeDirectory, ".relmio", "local", "n8n-stack"));
  await assert.rejects(() => removeLocalN8nStack({
    homeDirectory,
    runProcess: runner,
    confirmation: "REMOVE_LOCAL_N8N_STACK",
  }));
  assert.equal(calls.some((entry) => entry.args.join(" ").includes("down --volumes --remove-orphans")), false);
  assert.equal(errorCode, undefined);
});

test("a non-ngrok Compose failure is safely rolled back without credential-rejection guidance", async (t) => {
  const homeDirectory = await testHome(t);
  const { calls, runner } = createStackRunner({
    partialUpFailure: true,
    partialResources: true,
    emptyComposeDependsOnLabel: true,
    startupFailureOutput: {
      code: 1,
      stdout: "pull access denied for private.registry.invalid/n8n",
      stderr: "image pull failed in C:\\private\\stack with ngrok-private-token",
    },
  });
  let errorMessage = "";
  let errorCode;
  let failureKind;
  await assert.rejects(async () => {
    try {
      await installLocalN8nStack({
        plan: plan(),
        secrets: {
          ngrokAuthtoken: "ngrok-private-token",
          basicAuthUsername: "operator",
          basicAuthPassword: "long-private-password",
        },
        publicExposureConfirmation: "EXPOSE_LOCAL_N8N_VIA_NGROK",
        homeDirectory,
        runProcess: runner,
      });
    } catch (error) {
      errorMessage = error.message;
      errorCode = error.code;
      failureKind = error.failureKind;
      throw error;
    }
  }, /could not download a required n8n, ngrok, Code Sandbox, or SearXNG image/u);
  assert.equal(errorCode, LOCAL_N8N_STACK_RETRYABLE_STARTUP_ERROR_CODE);
  assert.equal(
    failureKind,
    "stack-image-pull",
  );
  assert.equal(errorMessage.length <= 240, true);
  assert.equal(
    errorMessage.includes("reserved ngrok hostname"),
    false,
  );
  assert.doesNotMatch(
    errorMessage,
    /private\.registry\.invalid|C:\\private|ngrok-private-token|pull access denied/u,
  );
  assert.match(errorMessage, /could not download a required n8n, ngrok, Code Sandbox, or SearXNG image/u);
  assert.equal(
    calls.filter((entry) => entry.args.join(" ").includes("down --volumes --remove-orphans")).length,
    1,
  );
  await assert.rejects(() => stat(join(homeDirectory, ".relmio", "local", "n8n-stack")));
  assert.doesNotMatch(errorMessage, /ownership could not be safely confirmed|rollback could not be confirmed/u);
  assertOwnershipFormatsUseExplicitLabels(calls);
});

test("a Compose wait-timeout is cleaned as a retryable first-start delay", async (t) => {
  const homeDirectory = await testHome(t);
  const { calls, runner } = createStackRunner({
    partialUpFailure: true,
    startupFailureOutput: {
      code: 1,
      stdout: "n8n Starting\nngrok Waiting",
      stderr: "service n8n didn't become healthy: wait-timeout reached",
    },
  });
  let captured;
  await assert.rejects(async () => {
    try {
      await installLocalN8nStack({
        plan: plan(),
        secrets: {
          ngrokAuthtoken: "ngrok-private-token",
          basicAuthUsername: "operator",
          basicAuthPassword: "long-private-password",
        },
        publicExposureConfirmation: "EXPOSE_LOCAL_N8N_VIA_NGROK",
        homeDirectory,
        runProcess: runner,
      });
    } catch (error) {
      captured = error;
      throw error;
    }
  }, /did not become ready in time/u);
  assert.equal(captured.code, LOCAL_N8N_STACK_RETRYABLE_STARTUP_ERROR_CODE);
  assert.equal(captured.failureKind, "stack-startup-wait");
  assert.doesNotMatch(captured.message, /ngrok-private-token|wait-timeout reached/u);
  assert.equal(
    calls.filter((entry) => entry.args.join(" ").includes("down --volumes --remove-orphans")).length,
    1,
  );
});

test("a non-allowlisted ngrok runtime code stays a generic cleaned startup failure", async (t) => {
  const homeDirectory = await testHome(t);
  const { calls, runner } = createStackRunner({
    partialUpFailure: true,
    startupFailureOutput: {
      code: 1,
      stdout: "",
      stderr: "ngrok session limit reached: ERR_NGROK_108",
    },
  });
  let captured;
  await assert.rejects(async () => {
    try {
      await installLocalN8nStack({
        plan: plan(),
        secrets: {
          ngrokAuthtoken: "ngrok-private-token",
          basicAuthUsername: "operator",
          basicAuthPassword: "long-private-password",
        },
        publicExposureConfirmation: "EXPOSE_LOCAL_N8N_VIA_NGROK",
        homeDirectory,
        runProcess: runner,
      });
    } catch (error) {
      captured = error;
      throw error;
    }
  }, /Docker could not create the new n8n stack/u);
  assert.equal(captured.code, LOCAL_N8N_STACK_RETRYABLE_STARTUP_ERROR_CODE);
  assert.equal(captured.failureKind, "stack-creation");
  assert.doesNotMatch(
    captured.message,
    /account, endpoint, or credential setup|reserved hostname|authtoken|ERR_NGROK_108/u,
  );
  assert.equal(
    calls.filter((entry) =>
      entry.args.join(" ").includes("down --volumes --remove-orphans")
    ).length,
    1,
  );
});

test("a Windows WSL CreateVm resource failure is classified instead of a generic compose error", async (t) => {
  const homeDirectory = await testHome(t);
  const { calls, runner } = createStackRunner({
    partialUpFailure: true,
    startupFailureOutput: {
      code: 1,
      stdout: "Insufficient system resources exist to complete the requested service. Error code: Wsl/Service/CreateInstance/CreateVm/HCS/0x800705aa",
      stderr: "running wslexec: C:\\users\\operator\\appdata\\local\\docker\\wsl\\disk\\docker_data.vhdx",
    },
  });
  let captured;
  await assert.rejects(async () => {
    try {
      await installLocalN8nStack({
        plan: plan(),
        secrets: {
          ngrokAuthtoken: "ngrok-private-token",
          basicAuthUsername: "operator",
          basicAuthPassword: "long-private-password",
        },
        publicExposureConfirmation: "EXPOSE_LOCAL_N8N_VIA_NGROK",
        homeDirectory,
        runProcess: runner,
      });
    } catch (error) {
      captured = error;
      throw error;
    }
  }, /WSL engine/u);
  assert.equal(captured.code, LOCAL_N8N_STACK_RETRYABLE_STARTUP_ERROR_CODE);
  assert.equal(
    captured.failureKind,
    LOCAL_N8N_STACK_DOCKER_ENGINE_RESOURCES_FAILURE_KIND,
  );
  assert.match(captured.message, /not have enough free memory/u);
  assert.match(captured.message, /wsl --shutdown/u);
  assert.equal(captured.message.length <= 240, true);
  assert.doesNotMatch(
    captured.message,
    /operator|appdata|docker_data|0x800705aa|CreateVm/iu,
  );
  assert.equal(
    calls.filter((entry) =>
      entry.args.join(" ").includes("down --volumes --remove-orphans")
    ).length,
    1,
  );
  await assert.rejects(() => stat(join(homeDirectory, ".relmio", "local", "n8n-stack")));
});

test("an explicit ngrok account rejection is cleaned once and retains ngrok retry guidance", async (t) => {
  const homeDirectory = await testHome(t);
  const { calls, runner } = createStackRunner({
    ngrokExitedDuringStartup: true,
    downFailure: true,
    startupFailureOutput: {
      code: 1,
      stdout: "n8n Healthy\nngrok Exited (1)\n",
      stderr: "ngrok rejected the token: ERR_NGROK_107 ngrok-private-token",
    },
  });
  let errorMessage = "";
  let errorCode;
  let failureKind;
  await assert.rejects(
    async () => {
      try {
        await installLocalN8nStack({
          plan: plan(),
          secrets: {
            ngrokAuthtoken: "ngrok-private-token",
            basicAuthUsername: "operator",
            basicAuthPassword: "long-private-password",
          },
          publicExposureConfirmation: "EXPOSE_LOCAL_N8N_VIA_NGROK",
          homeDirectory,
          runProcess: runner,
        });
      } catch (error) {
        errorMessage = error.message;
        errorCode = error.code;
        failureKind = error.failureKind;
        throw error;
      }
    },
    /ngrok stack did not start/u,
  );
  const cleanupCalls = calls.filter((entry) => entry.args.join(" ").includes("down --volumes --remove-orphans"));
  const ownershipCalls = calls.filter((entry) => entry.args[0] === "ps" && entry.args.includes("--all"));
  assert.equal(cleanupCalls.length, 1);
  assert.equal(ownershipCalls.length, 2);
  assert.equal(errorCode, LOCAL_N8N_STACK_RETRYABLE_STARTUP_ERROR_CODE);
  assert.equal(
    failureKind,
    LOCAL_N8N_STACK_NGROK_SETUP_REJECTED_FAILURE_KIND,
  );
  assert.equal(errorMessage.length <= 240, true);
  assert.match(errorMessage, /account, endpoint, or credential setup/u);
  assert.match(errorMessage, /reserved hostname, active agent authtoken, and Basic Auth/u);
  assert.doesNotMatch(errorMessage, /could not be confirmed|ngrok-private-token/u);
  await assert.rejects(() => stat(join(homeDirectory, ".relmio", "local", "n8n-stack")));
});

test("a failed startup preserves one still-owned partial stack with safe recovery guidance", async (t) => {
  const homeDirectory = await testHome(t);
  const { calls, runner } = createStackRunner({
    ngrokExitedDuringStartup: true,
    downFailure: true,
    resourcesRemainAfterDownAttempts: 1,
    emptyComposeDependsOnLabel: true,
    startupFailureOutput: {
      code: 1,
      stdout: "",
      stderr: "ngrok rejected the token: ERR_NGROK_107 ngrok-private-token",
    },
  });
  let errorMessage = "";
  let errorCode;
  await assert.rejects(
    async () => {
      try {
        await installLocalN8nStack({
          plan: plan(),
          secrets: {
            ngrokAuthtoken: "ngrok-private-token",
            basicAuthUsername: "operator",
            basicAuthPassword: "long-private-password",
          },
          publicExposureConfirmation: "EXPOSE_LOCAL_N8N_VIA_NGROK",
          homeDirectory,
          runProcess: runner,
        });
      } catch (error) {
        errorMessage = error.message;
        errorCode = error.code;
        throw error;
      }
    },
    /Relmio-managed partial stack remains[\s\S]*Inspect or remove it through Relmio before retrying/u,
  );
  const cleanupCalls = calls.filter((entry) => entry.args.join(" ").includes("down --volumes --remove-orphans"));
  assert.equal(cleanupCalls.length, 1);
  assert.equal(errorCode, LOCAL_N8N_MANAGED_PARTIAL_STACK_ERROR_CODE);
  assert.doesNotMatch(errorMessage, /https?:\/\/|ngrok-private-token/u);
  assert.doesNotMatch(errorMessage, /ownership could not be safely confirmed|rollback could not be confirmed/u);
  assertOwnershipFormatsUseExplicitLabels(calls);
  await stat(join(homeDirectory, ".relmio", "local", "n8n-stack", ".managed-by-relmio.json"));
  const removed = await removeLocalN8nStack({
    homeDirectory,
    runProcess: runner,
    confirmation: "REMOVE_LOCAL_N8N_STACK",
  });
  assert.equal(removed.removed, true);
  assert.equal(calls.filter((entry) => entry.args.join(" ").includes("down --volumes --remove-orphans")).length, 2);
  await assert.rejects(() => stat(join(homeDirectory, ".relmio", "local", "n8n-stack")));
});

test("an unconfirmed post-cleanup state does not claim that owned resources remain", async (t) => {
  const homeDirectory = await testHome(t);
  const { calls, runner } = createStackRunner({
    ngrokExitedDuringStartup: true,
    resourceInspectionFailureAfterDown: true,
  });
  let errorCode;
  await assert.rejects(
    async () => {
      try {
        await installLocalN8nStack({
          plan: plan(),
          secrets: {
            ngrokAuthtoken: "ngrok-private-token",
            basicAuthUsername: "operator",
            basicAuthPassword: "long-private-password",
          },
          publicExposureConfirmation: "EXPOSE_LOCAL_N8N_VIA_NGROK",
          homeDirectory,
          runProcess: runner,
        });
      } catch (error) {
        errorCode = error.code;
        throw error;
      }
    },
    /final resource state could not be confirmed/u,
  );
  assert.equal(errorCode, undefined);
  assert.equal(
    calls.filter((entry) => entry.args.join(" ").includes("down --volumes --remove-orphans")).length,
    1,
  );
  await stat(join(homeDirectory, ".relmio", "local", "n8n-stack", ".managed-by-relmio.json"));
});

test("removal preserves ownership evidence when Docker resources remain after Compose down", async (t) => {
  const homeDirectory = await testHome(t);
  const { runner } = createStackRunner({ resourcesRemainAfterDown: true });
  await installLocalN8nStack({
    plan: plan(),
    secrets: {
      ngrokAuthtoken: "ngrok-private-token",
      basicAuthUsername: "operator",
      basicAuthPassword: "long-private-password",
    },
    publicExposureConfirmation: "EXPOSE_LOCAL_N8N_VIA_NGROK",
    homeDirectory,
    runProcess: runner,
  });
  let errorCode;
  await assert.rejects(async () => {
    try {
      await removeLocalN8nStack({
        homeDirectory,
        runProcess: runner,
        confirmation: "REMOVE_LOCAL_N8N_STACK",
      });
    } catch (error) {
      errorCode = error.code;
      throw error;
    }
  });
  assert.equal(errorCode, LOCAL_N8N_MANAGED_PARTIAL_STACK_ERROR_CODE);
  await stat(join(homeDirectory, ".relmio", "local", "n8n-stack", ".managed-by-relmio.json"));
});

test("managed-file creation failures leave the install retryable", async (t) => {
  for (const failAt of [1, 2, 3, 4, 5, 6, 7]) {
    const homeDirectory = await testHome(t);
    const { runner } = createStackRunner();
    let writes = 0;
    const fileSystem = {
      ...nodeFileSystem,
      async writeFile(...args) {
        writes += 1;
        if (writes === failAt) throw Object.assign(new Error("injected write failure"), { code: "EIO" });
        return nodeFileSystem.writeFile(...args);
      },
    };
    await assert.rejects(() => installLocalN8nStack({
      plan: plan(),
      secrets: {
        ngrokAuthtoken: "ngrok-private-token",
        basicAuthUsername: "operator",
        basicAuthPassword: "long-private-password",
      },
      publicExposureConfirmation: "EXPOSE_LOCAL_N8N_VIA_NGROK",
      homeDirectory,
      runProcess: runner,
      fileSystem,
    }));
    await assert.rejects(() => stat(join(homeDirectory, ".relmio", "local", "n8n-stack")));
    await installLocalN8nStack({
      plan: plan(),
      secrets: {
        ngrokAuthtoken: "ngrok-private-token",
        basicAuthUsername: "operator",
        basicAuthPassword: "long-private-password",
      },
      publicExposureConfirmation: "EXPOSE_LOCAL_N8N_VIA_NGROK",
      homeDirectory,
      runProcess: runner,
    });
  }
});

test("an install-directory chmod failure leaves the install retryable", async (t) => {
  const homeDirectory = await testHome(t);
  const { runner } = createStackRunner();
  const installRoot = join(homeDirectory, ".relmio", "local", "n8n-stack");
  let failed = false;
  const fileSystem = {
    ...nodeFileSystem,
    async chmod(path, mode) {
      if (!failed && path === installRoot) {
        failed = true;
        throw Object.assign(new Error("injected chmod failure"), { code: "EIO" });
      }
      return nodeFileSystem.chmod(path, mode);
    },
  };
  await assert.rejects(() => installLocalN8nStack({
    plan: plan(),
    secrets: {
      ngrokAuthtoken: "ngrok-private-token",
      basicAuthUsername: "operator",
      basicAuthPassword: "long-private-password",
    },
    publicExposureConfirmation: "EXPOSE_LOCAL_N8N_VIA_NGROK",
    homeDirectory,
    runProcess: runner,
    fileSystem,
  }));
  await assert.rejects(() => stat(installRoot));
  await installLocalN8nStack({
    plan: plan(),
    secrets: {
      ngrokAuthtoken: "ngrok-private-token",
      basicAuthUsername: "operator",
      basicAuthPassword: "long-private-password",
    },
    publicExposureConfirmation: "EXPOSE_LOCAL_N8N_VIA_NGROK",
    homeDirectory,
    runProcess: runner,
  });
});

test("stale published lifecycle locks recover after process death or PID reuse", async (t) => {
  for (const staleState of ["dead", "active"]) {
    await t.test(staleState, async (subtest) => {
      const homeDirectory = await testHome(subtest);
      const lockPath = await writeLifecycleLock(homeDirectory);
      const { runner } = createStackRunner();
      const result = await installLocalN8nStack({
        plan: plan(),
        secrets: {
          ngrokAuthtoken: "ngrok-private-token",
          basicAuthUsername: "operator",
          basicAuthPassword: "long-private-password",
        },
        publicExposureConfirmation: "EXPOSE_LOCAL_N8N_VIA_NGROK",
        homeDirectory,
        runProcess: runner,
        processIdentity: testProcessIdentity({ staleState }),
      });
      assert.equal(result.kind, "local-n8n-stack");
      await assert.rejects(() => stat(lockPath));
    });
  }
});

test("fresh or ambiguous lifecycle claims fail closed without Compose mutation", async (t) => {
  for (const fixture of ["active", "ambiguous", "fresh-incomplete"]) {
    await t.test(fixture, async (subtest) => {
      const homeDirectory = await testHome(subtest);
      if (fixture === "fresh-incomplete") {
        await writeLifecycleLock(homeDirectory, { owner: null });
      } else {
        await writeLifecycleLock(homeDirectory, {
          owner: {
            schemaVersion: 2,
            pid: STALE_LOCK_PID,
            processStartIdentity: fixture === "active"
              ? "reused-process-start"
              : "original-process-start",
            token: "22222222-2222-4222-8222-222222222222",
            publishedAtMs: Date.now(),
          },
        });
      }
      const { calls, runner } = createStackRunner();
      await assert.rejects(() => installLocalN8nStack({
        plan: plan(),
        secrets: {
          ngrokAuthtoken: "ngrok-private-token",
          basicAuthUsername: "operator",
          basicAuthPassword: "long-private-password",
        },
        publicExposureConfirmation: "EXPOSE_LOCAL_N8N_VIA_NGROK",
        homeDirectory,
        runProcess: runner,
        processIdentity: testProcessIdentity({
          staleState: fixture === "ambiguous" ? "ambiguous" : "active",
        }),
      }), /already running|could not verify/u);
      assert.equal(calls.some((call) => call.args[0] === "compose"), false);
    });
  }
});

test("old missing and malformed lifecycle publications recover after the bounded grace", async (t) => {
  for (const owner of [null, "{truncated"]) {
    await t.test(owner === null ? "missing" : "malformed", async (subtest) => {
      const homeDirectory = await testHome(subtest);
      const old = Date.now() - 60_000;
      await writeLifecycleLock(homeDirectory, { owner, modifiedAtMs: old });
      const { runner } = createStackRunner();
      const result = await installLocalN8nStack({
        plan: plan(),
        secrets: {
          ngrokAuthtoken: "ngrok-private-token",
          basicAuthUsername: "operator",
          basicAuthPassword: "long-private-password",
        },
        publicExposureConfirmation: "EXPOSE_LOCAL_N8N_VIA_NGROK",
        homeDirectory,
        runProcess: runner,
        processIdentity: testProcessIdentity(),
      });
      assert.equal(result.kind, "local-n8n-stack");
    });
  }
});

test("nested reclaim claims recover only when stale and block when fresh, active, or ambiguous", async (t) => {
  const stalePrimaryOwner = {
    schemaVersion: 2,
    pid: STALE_LOCK_PID,
    processStartIdentity: "original-process-start",
    token: "11111111-1111-4111-8111-111111111111",
    publishedAtMs: Date.now() - 60_000,
  };
  const cases = [
    {
      name: "stale published reclaim",
      reclaim: {},
      identity: async (pid) => {
        if (pid === process.pid) return { state: "active", startIdentity: TEST_PROCESS_START_IDENTITY };
        if ([STALE_LOCK_PID, RECLAIM_LOCK_PID].includes(pid)) return { state: "dead" };
        return { state: "ambiguous" };
      },
      succeeds: true,
    },
    {
      name: "old malformed reclaim",
      reclaim: { owner: "{truncated", modifiedAtMs: Date.now() - 60_000 },
      identity: testProcessIdentity(),
      succeeds: true,
    },
    {
      name: "fresh incomplete reclaim",
      reclaim: { owner: null },
      identity: testProcessIdentity(),
      succeeds: false,
    },
    {
      name: "active reclaim",
      reclaim: {},
      identity: async (pid) => {
        if (pid === process.pid) return { state: "active", startIdentity: TEST_PROCESS_START_IDENTITY };
        if (pid === STALE_LOCK_PID) return { state: "dead" };
        if (pid === RECLAIM_LOCK_PID) return { state: "active", startIdentity: "reclaim-process-start" };
        return { state: "ambiguous" };
      },
      succeeds: false,
    },
    {
      name: "ambiguous reclaim",
      reclaim: {},
      identity: async (pid) => {
        if (pid === process.pid) return { state: "active", startIdentity: TEST_PROCESS_START_IDENTITY };
        if (pid === STALE_LOCK_PID) return { state: "dead" };
        return { state: "ambiguous" };
      },
      succeeds: false,
    },
  ];
  for (const scenario of cases) {
    await t.test(scenario.name, async (subtest) => {
      const homeDirectory = await testHome(subtest);
      const lockPath = await writeLifecycleLock(homeDirectory, { owner: stalePrimaryOwner });
      const reclaimPath = await writeLifecycleReclaim(lockPath, scenario.reclaim);
      const { calls, runner } = createStackRunner();
      const operation = installLocalN8nStack({
        plan: plan(),
        secrets: {
          ngrokAuthtoken: "ngrok-private-token",
          basicAuthUsername: "operator",
          basicAuthPassword: "long-private-password",
        },
        publicExposureConfirmation: "EXPOSE_LOCAL_N8N_VIA_NGROK",
        homeDirectory,
        runProcess: runner,
        processIdentity: scenario.identity,
      });
      if (scenario.succeeds) {
        assert.equal((await operation).kind, "local-n8n-stack");
        await assert.rejects(() => stat(lockPath));
      } else {
        await assert.rejects(operation, /already running|could not verify/u);
        await stat(lockPath);
        await stat(reclaimPath);
        assert.equal(calls.some((call) => call.args[0] === "compose"), false);
      }
    });
  }
});

test("a paused stale inspector cannot detach a successor's active lifecycle lock", async (t) => {
  const homeDirectory = await testHome(t);
  const lockPath = await writeLifecycleLock(homeDirectory);
  let reportInitialInspection;
  const initialInspection = new Promise((resolve) => { reportInitialInspection = resolve; });
  let resumeInitialInspector;
  const resumeInspection = new Promise((resolve) => { resumeInitialInspector = resolve; });
  const firstIdentity = async (pid) => {
    if (pid === process.pid) return { state: "active", startIdentity: TEST_PROCESS_START_IDENTITY };
    if (pid === STALE_LOCK_PID) {
      reportInitialInspection();
      await resumeInspection;
      return { state: "dead" };
    }
    return { state: "ambiguous" };
  };

  const firstRunner = createStackRunner().runner;
  const firstOperation = installLocalN8nStack({
    plan: plan(),
    secrets: {
      ngrokAuthtoken: "ngrok-private-token",
      basicAuthUsername: "operator",
      basicAuthPassword: "long-private-password",
    },
    publicExposureConfirmation: "EXPOSE_LOCAL_N8N_VIA_NGROK",
    homeDirectory,
    runProcess: firstRunner,
    processIdentity: firstIdentity,
  });
  await initialInspection;

  let reportSuccessorLock;
  const successorLockPublished = new Promise((resolve) => { reportSuccessorLock = resolve; });
  let resumeSuccessor;
  const resumeSuccessorOperation = new Promise((resolve) => { resumeSuccessor = resolve; });
  const { runner: successorBaseRunner } = createStackRunner();
  let successorPaused = false;
  const successorRunner = async (spec) => {
    if (!successorPaused && spec.args.join(" ").includes("config --quiet")) {
      successorPaused = true;
      reportSuccessorLock();
      await resumeSuccessorOperation;
    }
    return successorBaseRunner(spec);
  };
  const successorOperation = installLocalN8nStack({
    plan: plan(),
    secrets: {
      ngrokAuthtoken: "ngrok-private-token",
      basicAuthUsername: "operator",
      basicAuthPassword: "long-private-password",
    },
    publicExposureConfirmation: "EXPOSE_LOCAL_N8N_VIA_NGROK",
    homeDirectory,
    runProcess: successorRunner,
    processIdentity: testProcessIdentity(),
  });
  await successorLockPublished;
  const successorOwnerBefore = await nodeFileSystem.readFile(join(lockPath, ".owner.json"), "utf8");

  resumeInitialInspector();
  await assert.rejects(firstOperation, /refuses to reclaim a replaced|already running/u);
  assert.equal(
    await nodeFileSystem.readFile(join(lockPath, ".owner.json"), "utf8"),
    successorOwnerBefore,
  );

  await assert.rejects(() => installLocalN8nStack({
    plan: plan(),
    secrets: {
      ngrokAuthtoken: "ngrok-private-token",
      basicAuthUsername: "operator",
      basicAuthPassword: "long-private-password",
    },
    publicExposureConfirmation: "EXPOSE_LOCAL_N8N_VIA_NGROK",
    homeDirectory,
    runProcess: successorBaseRunner,
    processIdentity: testProcessIdentity(),
  }), /already running/u);

  resumeSuccessor();
  assert.equal((await successorOperation).kind, "local-n8n-stack");
});

function releaseFailingFileSystem() {
  let failed = false;
  return {
    ...nodeFileSystem,
    async rmdir(path, ...args) {
      if (!failed && String(path).includes("n8n-stack.lock.quarantine-")) {
        failed = true;
        throw Object.assign(new Error("injected release failure"), { code: "EIO" });
      }
      return nodeFileSystem.rmdir(path, ...args);
    },
  };
}

test("a completed stack action reports lock-release recovery explicitly", async (t) => {
  const homeDirectory = await testHome(t);
  const { runner } = createStackRunner();
  let errorCode;
  await assert.rejects(async () => {
    try {
      await installLocalN8nStack({
        plan: plan(),
        secrets: {
          ngrokAuthtoken: "ngrok-private-token",
          basicAuthUsername: "operator",
          basicAuthPassword: "long-private-password",
        },
        publicExposureConfirmation: "EXPOSE_LOCAL_N8N_VIA_NGROK",
        homeDirectory,
        runProcess: runner,
        fileSystem: releaseFailingFileSystem(),
        processIdentity: testProcessIdentity(),
      });
    } catch (error) {
      errorCode = error.code;
      throw error;
    }
  }, /completed, but Relmio could not release its operation lock/u);
  assert.equal(errorCode, LOCAL_N8N_LIFECYCLE_LOCK_RELEASE_ERROR_CODE);
  await stat(join(homeDirectory, ".relmio", "local", "n8n-stack", ".managed-by-relmio.json"));
  const localRoot = join(homeDirectory, ".relmio", "local");
  const lockPath = join(localRoot, "n8n-stack.lock");
  const restoredOwner = JSON.parse(await nodeFileSystem.readFile(join(lockPath, ".owner.json"), "utf8"));
  assert.equal(restoredOwner.pid, process.pid);
  assert.equal(restoredOwner.processStartIdentity, TEST_PROCESS_START_IDENTITY);
  assert.deepEqual((await nodeFileSystem.readdir(localRoot)).filter((entry) =>
    entry.startsWith("n8n-stack.lock.quarantine-"),
  ), []);
});

test("successful owned removal with a release failure restores its canonical claim and remains reclaimable", async (t) => {
  const homeDirectory = await testHome(t);
  const { runner } = createStackRunner();
  await installLocalN8nStack({
    plan: plan(),
    secrets: {
      ngrokAuthtoken: "ngrok-private-token",
      basicAuthUsername: "operator",
      basicAuthPassword: "long-private-password",
    },
    publicExposureConfirmation: "EXPOSE_LOCAL_N8N_VIA_NGROK",
    homeDirectory,
    runProcess: runner,
  });

  let removalError;
  await assert.rejects(async () => {
    try {
      await removeLocalN8nStack({
        homeDirectory,
        runProcess: runner,
        confirmation: "REMOVE_LOCAL_N8N_STACK",
        fileSystem: releaseFailingFileSystem(),
        processIdentity: testProcessIdentity(),
      });
    } catch (error) {
      removalError = error;
      throw error;
    }
  }, /completed, but Relmio could not release its operation lock/u);
  assert.equal(removalError.code, LOCAL_N8N_LIFECYCLE_LOCK_RELEASE_ERROR_CODE);
  await assert.rejects(() => stat(join(homeDirectory, ".relmio", "local", "n8n-stack")));
  const lockPath = join(homeDirectory, ".relmio", "local", "n8n-stack.lock");
  const restoredOwner = JSON.parse(await nodeFileSystem.readFile(join(lockPath, ".owner.json"), "utf8"));
  assert.equal(restoredOwner.pid, process.pid);
  assert.deepEqual((await nodeFileSystem.readdir(join(homeDirectory, ".relmio", "local"))).filter((entry) =>
    entry.startsWith("n8n-stack.lock.quarantine-"),
  ), []);

  let identityCalls = 0;
  const reclaimed = await installLocalN8nStack({
    plan: plan(),
    secrets: {
      ngrokAuthtoken: "ngrok-private-token",
      basicAuthUsername: "operator",
      basicAuthPassword: "long-private-password",
    },
    publicExposureConfirmation: "EXPOSE_LOCAL_N8N_VIA_NGROK",
    homeDirectory,
    runProcess: runner,
    processIdentity: async () => {
      identityCalls += 1;
      return identityCalls === 1
        ? { state: "active", startIdentity: TEST_PROCESS_START_IDENTITY }
        : { state: "dead" };
    },
  });
  assert.equal(reclaimed.kind, "local-n8n-stack");
  await assert.rejects(() => stat(lockPath));
});

test("a lock-release failure preserves the authoritative partial-stack recovery code", async (t) => {
  const homeDirectory = await testHome(t);
  const { runner } = createStackRunner({
    ngrokExitedDuringStartup: true,
    resourcesRemainAfterDownAttempts: 1,
  });
  let captured;
  await assert.rejects(async () => {
    try {
      await installLocalN8nStack({
        plan: plan(),
        secrets: {
          ngrokAuthtoken: "ngrok-private-token",
          basicAuthUsername: "operator",
          basicAuthPassword: "long-private-password",
        },
        publicExposureConfirmation: "EXPOSE_LOCAL_N8N_VIA_NGROK",
        homeDirectory,
        runProcess: runner,
        fileSystem: releaseFailingFileSystem(),
        processIdentity: testProcessIdentity(),
      });
    } catch (error) {
      captured = error;
      throw error;
    }
  }, /Relmio-managed partial stack remains/u);
  assert.equal(captured.code, LOCAL_N8N_MANAGED_PARTIAL_STACK_ERROR_CODE);
  assert.match(captured.cause?.message ?? "", /operation lock/u);
});

test("a lock-release failure preserves a safely cleaned non-ngrok startup classification", async (t) => {
  const homeDirectory = await testHome(t);
  const { runner } = createStackRunner({
    partialUpFailure: true,
    startupFailureOutput: {
      code: 1,
      stdout: "",
      stderr: "image pull failed with no ngrok rejection code",
    },
  });
  let captured;
  await assert.rejects(async () => {
    try {
      await installLocalN8nStack({
        plan: plan(),
        secrets: {
          ngrokAuthtoken: "ngrok-private-token",
          basicAuthUsername: "operator",
          basicAuthPassword: "long-private-password",
        },
        publicExposureConfirmation: "EXPOSE_LOCAL_N8N_VIA_NGROK",
        homeDirectory,
        runProcess: runner,
        fileSystem: releaseFailingFileSystem(),
        processIdentity: testProcessIdentity(),
      });
    } catch (error) {
      captured = error;
      throw error;
    }
  }, /Docker could not create the new n8n stack/u);
  assert.equal(captured.code, LOCAL_N8N_STACK_RETRYABLE_STARTUP_ERROR_CODE);
  assert.equal(captured.failureKind, "stack-creation");
  assert.match(captured.cause?.message ?? "", /operation lock/u);
});

test("installation identity failure releases its lifecycle lock for retry", async (t) => {
  const homeDirectory = await testHome(t);
  const { runner } = createStackRunner();
  await assert.rejects(() => installLocalN8nStack({
    plan: plan(),
    secrets: {
      ngrokAuthtoken: "ngrok-private-token",
      basicAuthUsername: "operator",
      basicAuthPassword: "long-private-password",
    },
    publicExposureConfirmation: "EXPOSE_LOCAL_N8N_VIA_NGROK",
    homeDirectory,
    runProcess: runner,
    randomBytes: () => Buffer.alloc(1),
  }));
  await assert.rejects(() => stat(join(homeDirectory, ".relmio", "local", "n8n-stack.lock")));
  await installLocalN8nStack({
    plan: plan(),
    secrets: {
      ngrokAuthtoken: "ngrok-private-token",
      basicAuthUsername: "operator",
      basicAuthPassword: "long-private-password",
    },
    publicExposureConfirmation: "EXPOSE_LOCAL_N8N_VIA_NGROK",
    homeDirectory,
    runProcess: runner,
  });
});

test("an older operation cannot remove a replacement lifecycle lock", async (t) => {
  const homeDirectory = await testHome(t);
  const lockPath = join(homeDirectory, ".relmio", "local", "n8n-stack.lock");
  const { runner: baseRunner } = createStackRunner();
  let replaced = false;
  const runner = async (spec) => {
    const result = await baseRunner(spec);
    if (!replaced && spec.args.join(" ").includes("up -d --wait")) {
      replaced = true;
      await rm(lockPath, { recursive: true, force: false });
      await mkdir(lockPath, { mode: 0o700 });
      await nodeFileSystem.writeFile(join(lockPath, ".owner.json"), `${JSON.stringify({ token: "replacement" })}\n`, { mode: 0o600 });
    }
    return result;
  };
  await assert.rejects(() => installLocalN8nStack({
    plan: plan(),
    secrets: {
      ngrokAuthtoken: "ngrok-private-token",
      basicAuthUsername: "operator",
      basicAuthPassword: "long-private-password",
    },
    publicExposureConfirmation: "EXPOSE_LOCAL_N8N_VIA_NGROK",
    homeDirectory,
    runProcess: runner,
  }));
  await stat(join(lockPath, ".owner.json"));
});

test("an active lifecycle lock blocks destructive stack removal", async (t) => {
  const homeDirectory = await testHome(t);
  const { runner } = createStackRunner();
  await installLocalN8nStack({
    plan: plan(),
    secrets: {
      ngrokAuthtoken: "ngrok-private-token",
      basicAuthUsername: "operator",
      basicAuthPassword: "long-private-password",
    },
    publicExposureConfirmation: "EXPOSE_LOCAL_N8N_VIA_NGROK",
    homeDirectory,
    runProcess: runner,
  });
  await mkdir(join(homeDirectory, ".relmio", "local", "n8n-stack.lock"), { mode: 0o700 });
  await assert.rejects(() => removeLocalN8nStack({
    homeDirectory,
    runProcess: runner,
    confirmation: "REMOVE_LOCAL_N8N_STACK",
  }));
  await stat(join(homeDirectory, ".relmio", "local", "n8n-stack", ".managed-by-relmio.json"));
});

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  COMPOSE_PROJECT,
  createComposeArguments,
  renderTrafficPolicy,
  validateHarnessEnvironment,
} from "../dev/selfhosted-n8n/harness.mjs";
import {
  ASSISTANT_COMPANION_IMAGES,
  createSearxngSettings,
} from "../src/domain/assistant-templates.js";

const fixtureRoot = new URL("../dev/selfhosted-n8n/", import.meta.url);
const fixturePath = fileURLToPath(fixtureRoot);
const localProcessPath = fileURLToPath(
  new URL("../src/infrastructure/local-process.js", import.meta.url),
);
const LOCAL_DOCKER_HOST = "unix:///var/run/docker.sock";

function validEnvironment(overrides = {}) {
  return {
    NGROK_AUTHTOKEN: "test_authtoken_0123456789abcdef",
    NGROK_DOMAIN: "relmio-local-test.ngrok.app",
    NGROK_BASIC_AUTH_USER: "relmio-test",
    NGROK_BASIC_AUTH_PASSWORD: "local-only-password-1234",
    N8N_ENCRYPTION_KEY:
      "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef",
    N8N_LOCAL_PORT: "5678",
    NGROK_INSPECTOR_PORT: "4040",
    RELMIO_TEST_PUBLIC_CONFIRMATION: "EXPOSE_DISPOSABLE_N8N",
    RELMIO_TEST_ASSISTANT_MODE: "disabled",
    RELMIO_TEST_PRIVILEGED_SANDBOX_CONFIRMATION: "not-confirmed",
    ...overrides,
  };
}

function enabledAssistantEnvironment(overrides = {}) {
  return validEnvironment({
    RELMIO_TEST_ASSISTANT_MODE: "sandbox-with-searxng",
    RELMIO_TEST_PRIVILEGED_SANDBOX_CONFIRMATION:
      "RUN_PRIVILEGED_CODE_SANDBOX",
    ...overrides,
  });
}

function serializeEnvironment(overrides = {}) {
  return `${Object.entries({
    ...validEnvironment(),
    GENERIC_TIMEZONE: "Asia/Manila",
    ...overrides,
  })
    .map(([key, value]) => `${key}=${value}`)
    .join("\n")}\n`;
}

async function createTemporaryCheckout(t, name) {
  const checkout = await mkdtemp(join(tmpdir(), `${name}-`));
  t.after(() => rm(checkout, { force: true, recursive: true }));

  const harnessDirectory = join(checkout, "dev", "selfhosted-n8n");
  const fakeBin = join(checkout, "fake-bin");
  const domainDirectory = join(checkout, "src", "domain");
  const infrastructureDirectory = join(checkout, "src", "infrastructure");
  const dockerLog = join(checkout, "docker-calls.jsonl");
  await Promise.all([
    mkdir(harnessDirectory, { recursive: true }),
    mkdir(fakeBin, { recursive: true }),
    mkdir(domainDirectory, { recursive: true }),
    mkdir(infrastructureDirectory, { recursive: true }),
  ]);
  await Promise.all([
    copyFile(join(fixturePath, "harness.mjs"), join(harnessDirectory, "harness.mjs")),
    copyFile(join(fixturePath, "compose.yml"), join(harnessDirectory, "compose.yml")),
    ...[
      "assistant.js",
      "assistant-templates.js",
      "safety.js",
      "validation.js",
    ].map((name) =>
      copyFile(
        fileURLToPath(new URL(`../src/domain/${name}`, import.meta.url)),
        join(domainDirectory, name),
      ),
    ),
    copyFile(
      localProcessPath,
      join(infrastructureDirectory, "local-process.js"),
    ),
    writeFile(join(harnessDirectory, ".env"), serializeEnvironment(), {
      mode: 0o600,
    }),
    writeFile(
      join(fakeBin, "docker"),
      [
        "#!/usr/bin/env node",
        'const { appendFileSync } = require("node:fs");',
        "const args = process.argv.slice(2);",
        'appendFileSync(process.env.FAKE_DOCKER_LOG, `${JSON.stringify(args)}\\n`);',
        'if (args[0] === "context" && args[1] === "inspect") {',
        '  process.stdout.write(JSON.stringify(process.env.FAKE_DOCKER_CONTEXT_HOST || "unix:///var/run/docker.sock"));',
        "  process.exit(0);",
        "}",
        'if (process.env.FAKE_DOCKER_FAIL_UP === "1" && args.includes("up")) {',
        "  process.exit(23);",
        "}",
        "",
      ].join("\n"),
      { mode: 0o700 },
    ),
  ]);
  await Promise.all([
    chmod(join(harnessDirectory, ".env"), 0o600),
    chmod(join(fakeBin, "docker"), 0o700),
  ]);

  return {
    checkout,
    dockerLog,
    fakeBin,
    harnessDirectory,
    harnessPath: join(harnessDirectory, "harness.mjs"),
  };
}

function runTemporaryHarness(checkout, action, environment = {}) {
  return spawnSync(process.execPath, [checkout.harnessPath, action], {
    cwd: checkout.harnessDirectory,
    encoding: "utf8",
    env: {
      ...process.env,
      ...environment,
      FAKE_DOCKER_LOG: checkout.dockerLog,
      PATH: `${checkout.fakeBin}${delimiter}${process.env.PATH ?? ""}`,
    },
  });
}

async function readDockerCalls(checkout) {
  try {
    return (await readFile(checkout.dockerLog, "utf8"))
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

test("self-hosted n8n fixture pins private Assistant dependencies and exposes only n8n", async () => {
  const [compose, ngrokConfig] = await Promise.all([
    readFile(new URL("compose.yml", fixtureRoot), "utf8"),
    readFile(new URL("ngrok.yml", fixtureRoot), "utf8"),
  ]);
  const servicesBlock = compose.split(/\r?\nvolumes:\r?\n/u, 1)[0];
  const serviceNames = [...servicesBlock.matchAll(/^  ([a-z][a-z0-9-]*):$/gmu)]
    .map((match) => match[1]);

  assert.deepEqual(serviceNames, [
    "n8n",
    "ngrok",
    "relmio-sandbox-certs",
    "relmio-sandbox-api",
    "relmio-sandbox-runner-1",
    "relmio-searxng",
  ]);

  assert.match(
    compose,
    /image:\s+docker\.io\/n8nio\/n8n:2\.36\.8@sha256:cfe2704ff858395503d42548206c2c99ea351a205e941063a9d9b77b0f404478/u,
  );
  assert.match(
    compose,
    /image:\s+docker\.io\/ngrok\/ngrok:3\.39\.11-alpine-6a536c4/u,
  );
  for (const image of Object.values(ASSISTANT_COMPANION_IMAGES)) {
    assert.ok(compose.includes(image), `missing reviewed image ${image}`);
  }
  assert.doesNotMatch(compose, /image:\s+\S+:(?:latest|stable|beta)(?:@|\s|$)/mu);
  assert.match(compose, /N8N_ENABLED_MODULES:\s+instance-ai/u);
  assert.match(compose, /N8N_INSTANCE_AI_SANDBOX_ENABLED/u);
  assert.match(compose, /N8N_INSTANCE_AI_SANDBOX_PROVIDER:\s+n8n-sandbox/u);
  assert.match(compose, /N8N_SANDBOX_SERVICE_URL/u);
  assert.match(compose, /N8N_SANDBOX_SERVICE_API_KEY/u);
  assert.match(compose, /N8N_INSTANCE_AI_SEARXNG_URL/u);
  assert.match(compose, /N8N_WEBHOOK_URL:\s+https:\/\/\$\{NGROK_DOMAIN/u);
  assert.match(compose, /N8N_EDITOR_BASE_URL:\s+https:\/\/\$\{NGROK_DOMAIN/u);
  assert.match(compose, /N8N_PROXY_HOPS:\s+"1"/u);
  assert.match(compose, /N8N_SECURE_COOKIE:\s+"true"/u);
  assert.doesNotMatch(compose, /^\s+WEBHOOK_URL:/mu);
  assert.match(compose, /127\.0\.0\.1:\$\{N8N_LOCAL_PORT/u);
  assert.match(compose, /127\.0\.0\.1:\$\{NGROK_INSPECTOR_PORT/u);
  assert.match(compose, /http:\/\/n8n:5678/u);
  assert.match(compose, /NGROK_CONFIG:\s+\/etc\/ngrok\/ngrok\.yml/u);
  assert.match(compose, /ngrok\.yml:\/etc\/ngrok\/ngrok\.yml:ro,Z/u);
  assert.match(
    compose,
    /traffic-policy\.yml:\/etc\/ngrok\/traffic-policy\.yml:ro,Z/u,
  );
  assert.match(compose, /\/healthz\/readiness/u);
  assert.match(compose, /profiles:\s*\n\s+- code-sandbox/u);
  assert.match(compose, /profiles:\s*\n\s+- web-search/u);
  assert.match(compose, /privileged:\s+true/u);
  assert.match(compose, /SANDBOX_RUNNER_DOCKER_SANDBOX_IMAGE/u);
  assert.match(compose, /bootstrap-mtls\.sh/u);
  assert.match(compose, /http:\/\/localhost:8080\/healthz/u);
  assert.match(
    compose,
    /\.\/\.runtime\/searxng-settings\.yml:\/etc\/searxng\/settings\.yml:ro,Z/u,
  );
  assert.match(compose, /n8n-data:\/home\/node\/\.n8n/u);
  assert.match(
    compose,
    /\/home\/node\/\.cache:rw,noexec,nosuid,nodev,size=256m,uid=1000,gid=1000,mode=0700/u,
  );
  assert.doesNotMatch(
    compose,
    /\/home\/node\/\.cache:[^\n]*size=64m/u,
  );
  assert.match(
    compose,
    /\/var\/lib\/ngrok:rw,noexec,nosuid,nodev,size=1m/u,
  );
  assert.match(
    compose,
    /com\.relmio\.owner:\s+\$\{COMPOSE_PROJECT_NAME\}/u,
  );
  assert.equal((compose.match(/^    ports:/gmu) ?? []).length, 2);
  assert.equal((compose.match(/^      - "127\.0\.0\.1:/gmu) ?? []).length, 2);
  assert.match(
    compose,
    /relmio-sandbox-api:[\s\S]*?networks:[\s\S]*?assistant-internal:[\s\S]*?assistant-shared:/u,
  );
  assert.match(
    compose,
    /relmio-sandbox-runner-1:[\s\S]*?networks:\s*\n\s+- assistant-internal/u,
  );
  assert.match(
    compose,
    /relmio-searxng:[\s\S]*?networks:\s*\n\s+- assistant-shared/u,
  );
  assert.doesNotMatch(compose, /relmio-selfhosted-n8n-test/u);
  assert.doesNotMatch(compose, /10531|docker\.sock|host\.docker\.internal/u);
  assert.doesNotMatch(compose, /^\s+name:\s+proxy\s*$/mu);
  assert.match(ngrokConfig, /^version:\s+3$/mu);
  assert.match(ngrokConfig, /^\s+web_addr:\s+0\.0\.0\.0:4040$/mu);
  assert.doesNotMatch(ngrokConfig, /authtoken|credentials|password/iu);
});

test("harness configuration requires explicit public exposure and validates secrets", () => {
  const configuration = validateHarnessEnvironment(validEnvironment());
  assert.equal(configuration.domain, "relmio-local-test.ngrok.app");
  assert.equal(configuration.localPort, 5678);
  assert.equal(configuration.inspectorPort, 4040);
  assert.equal(configuration.assistantMode, "disabled");
  assert.equal(configuration.enableCodeSandbox, false);
  assert.equal(configuration.enableSearxng, false);

  const assistantConfiguration = validateHarnessEnvironment(
    enabledAssistantEnvironment(),
  );
  assert.equal(assistantConfiguration.assistantMode, "sandbox-with-searxng");
  assert.equal(assistantConfiguration.enableCodeSandbox, true);
  assert.equal(assistantConfiguration.enableSearxng, true);

  for (const overrides of [
    { RELMIO_TEST_PUBLIC_CONFIRMATION: "true" },
    { NGROK_DOMAIN: "https://relmio-local-test.ngrok.app" },
    { NGROK_DOMAIN: "127.0.0.1" },
    { NGROK_BASIC_AUTH_USER: "bad:user" },
    { NGROK_BASIC_AUTH_PASSWORD: "short" },
    { NGROK_BASIC_AUTH_PASSWORD: "long-enough-password\nheader" },
    { N8N_ENCRYPTION_KEY: "invalid" },
    { N8N_LOCAL_PORT: "0" },
    { N8N_LOCAL_PORT: "10531" },
    { NGROK_INSPECTOR_PORT: "10531" },
    { NGROK_INSPECTOR_PORT: "70000" },
    { RELMIO_TEST_ASSISTANT_MODE: "true" },
    {
      RELMIO_TEST_ASSISTANT_MODE: "sandbox",
      RELMIO_TEST_PRIVILEGED_SANDBOX_CONFIRMATION: "yes",
    },
  ]) {
    assert.throws(() => validateHarnessEnvironment(validEnvironment(overrides)));
  }

  assert.throws(() =>
    validateHarnessEnvironment(
      enabledAssistantEnvironment({
        RELMIO_TEST_PRIVILEGED_SANDBOX_CONFIRMATION: "not-confirmed",
      }),
    ),
  );
});

test("traffic policy contains only one safely quoted basic-auth credential", () => {
  const configuration = validateHarnessEnvironment(validEnvironment({
    NGROK_BASIC_AUTH_PASSWORD: "quotes-are-safe-\"-password",
  }));
  const policy = renderTrafficPolicy(configuration);

  assert.match(policy, /^on_http_request:/u);
  assert.match(policy, /type:\s+basic-auth/u);
  assert.ok(policy.includes('"relmio-test:quotes-are-safe-\\\"-password"'));
  assert.equal((policy.match(/credentials:/gu) ?? []).length, 1);
  assert.doesNotMatch(policy, /authtoken|encryption/i);
});

test("harness lifecycle uses only its collision-resistant checkout project", () => {
  assert.match(COMPOSE_PROJECT, /^relmio-selfhosted-n8n-[a-f0-9]{24}$/u);
  assert.deepEqual(createComposeArguments("config"), [
    "compose",
    "--project-name",
    COMPOSE_PROJECT,
    "--env-file",
    ".env",
    "--file",
    "compose.yml",
    "config",
    "--quiet",
  ]);
  assert.deepEqual(createComposeArguments("up"), [
    "compose",
    "--project-name",
    COMPOSE_PROJECT,
    "--env-file",
    ".env",
    "--file",
    "compose.yml",
    "up",
    "--detach",
    "--wait",
    "--wait-timeout",
    "90",
  ]);
  assert.deepEqual(
    createComposeArguments("up", "sandbox-with-searxng"),
    [
      "compose",
      "--project-name",
      COMPOSE_PROJECT,
      "--env-file",
      ".env",
      "--file",
      "compose.yml",
      "--profile",
      "code-sandbox",
      "--profile",
      "web-search",
      "up",
      "--detach",
      "--wait",
      "--wait-timeout",
      "90",
    ],
  );
  assert.deepEqual(createComposeArguments("status", "sandbox"), [
    "compose",
    "--project-name",
    COMPOSE_PROJECT,
    "--env-file",
    ".env",
    "--file",
    "compose.yml",
    "--profile",
    "code-sandbox",
    "ps",
  ]);
  assert.deepEqual(createComposeArguments("down"), [
    "compose",
    "--project-name",
    COMPOSE_PROJECT,
    "--env-file",
    ".env",
    "--file",
    "compose.yml",
    "down",
    "--volumes",
    "--remove-orphans",
  ]);
  assert.throws(() => createComposeArguments("prune"));
  assert.throws(() => createComposeArguments("up", "search-only"));
});

test("Compose project identity is stable per checkout and differs across checkouts", async (t) => {
  const first = await createTemporaryCheckout(t, "relmio-checkout-a");
  const second = await createTemporaryCheckout(t, "relmio-checkout-b");
  const firstUrl = pathToFileURL(first.harnessPath).href;
  const secondUrl = pathToFileURL(second.harnessPath).href;

  const [firstImport, repeatedImport, secondImport] = await Promise.all([
    import(`${firstUrl}?load=first`),
    import(`${firstUrl}?load=repeated`),
    import(`${secondUrl}?load=second`),
  ]);

  assert.equal(firstImport.COMPOSE_PROJECT, repeatedImport.COMPOSE_PROJECT);
  assert.notEqual(firstImport.COMPOSE_PROJECT, secondImport.COMPOSE_PROJECT);
  assert.match(
    firstImport.COMPOSE_PROJECT,
    /^relmio-selfhosted-n8n-[a-f0-9]{24}$/u,
  );
  for (const action of ["config", "up", "status", "down"]) {
    const argumentsForAction = firstImport.createComposeArguments(action);
    assert.equal(argumentsForAction[2], firstImport.COMPOSE_PROJECT);
    assert.equal(argumentsForAction.includes(secondImport.COMPOSE_PROJECT), false);
  }
});

test("down fails closed on missing or mismatched checkout ownership", async (t) => {
  if (process.platform === "win32") {
    t.skip("executable fake Docker boundary is POSIX-only");
    return;
  }
  const checkout = await createTemporaryCheckout(t, "relmio-owner-check");

  const missingMarker = runTemporaryHarness(checkout, "down");
  assert.notEqual(missingMarker.status, 0);
  assert.match(missingMarker.stderr, /ownership marker/iu);
  assert.deepEqual(await readDockerCalls(checkout), []);

  const started = runTemporaryHarness(checkout, "up");
  assert.equal(started.status, 0, started.stderr);
  const runtimePath = join(checkout.harnessDirectory, ".runtime");
  const markerPath = join(checkout.harnessDirectory, ".runtime", "owner.json");
  const policyPath = join(
    checkout.harnessDirectory,
    ".runtime",
    "traffic-policy.yml",
  );
  const [runtimeMetadata, markerMetadata, policyMetadata] = await Promise.all([
    stat(runtimePath),
    stat(markerPath),
    stat(policyPath),
  ]);
  assert.equal(runtimeMetadata.mode & 0o777, 0o700);
  assert.equal(markerMetadata.mode & 0o777, 0o600);
  assert.equal(policyMetadata.mode & 0o777, 0o644);
  const marker = JSON.parse(await readFile(markerPath, "utf8"));
  const callsAfterUp = await readDockerCalls(checkout);
  assert.equal(marker.dockerHost, LOCAL_DOCKER_HOST);
  assert.equal(marker.assistantMode, "disabled");
  assert.equal(callsAfterUp.length, 3);
  assert.equal(callsAfterUp[0][0], "context");
  assert.ok(
    callsAfterUp.slice(1).every(
      (call) =>
        call[0] === "--host" &&
        call[1] === marker.dockerHost &&
        call[2] === "compose" &&
        call[4] === marker.project,
    ),
  );

  await writeFile(
    markerPath,
    `${JSON.stringify({ ...marker, project: `${marker.project}-other` })}\n`,
    { mode: 0o600 },
  );
  await chmod(markerPath, 0o600);
  const ambiguousDown = runTemporaryHarness(checkout, "down");
  assert.notEqual(ambiguousDown.status, 0);
  assert.match(ambiguousDown.stderr, /ownership marker/iu);
  assert.equal((await readDockerCalls(checkout)).length, callsAfterUp.length);

  await writeFile(markerPath, `${JSON.stringify(marker)}\n`, { mode: 0o600 });
  await chmod(markerPath, 0o600);
  const cleaned = runTemporaryHarness(checkout, "down", {
    FAKE_DOCKER_CONTEXT_HOST: "unix:///tmp/changed-context.sock",
  });
  assert.equal(cleaned.status, 0, cleaned.stderr);
  const cleanupCall = (await readDockerCalls(checkout)).at(-1);
  assert.equal(cleanupCall[0], "--host");
  assert.equal(cleanupCall[1], marker.dockerHost);
  assert.equal(cleanupCall[4], marker.project);
  await assert.rejects(stat(markerPath), { code: "ENOENT" });
  await assert.rejects(
    stat(join(checkout.harnessDirectory, ".runtime", "traffic-policy.yml")),
    { code: "ENOENT" },
  );
});

test("Assistant mode persists generated secrets and drives exact profile cleanup", async (t) => {
  if (process.platform === "win32") {
    t.skip("executable fake Docker boundary is POSIX-only");
    return;
  }
  const checkout = await createTemporaryCheckout(t, "relmio-assistant-mode");
  const environmentPath = join(checkout.harnessDirectory, ".env");
  await writeFile(
    environmentPath,
    serializeEnvironment(enabledAssistantEnvironment()),
    { mode: 0o600 },
  );
  await chmod(environmentPath, 0o600);

  const started = runTemporaryHarness(checkout, "up");
  assert.equal(started.status, 0, started.stderr);

  const runtimePath = join(checkout.harnessDirectory, ".runtime");
  const markerPath = join(runtimePath, "owner.json");
  const secretsPath = join(runtimePath, "assistant-secrets.env");
  const settingsPath = join(runtimePath, "searxng-settings.yml");
  const [marker, secrets, secretsMetadata, settings, settingsMetadata] =
    await Promise.all([
      readFile(markerPath, "utf8").then(JSON.parse),
      readFile(secretsPath, "utf8"),
      stat(secretsPath),
      readFile(settingsPath, "utf8"),
      stat(settingsPath),
    ]);
  assert.equal(marker.assistantMode, "sandbox-with-searxng");
  assert.equal(secretsMetadata.mode & 0o777, 0o600);
  assert.equal(settingsMetadata.mode & 0o777, 0o644);
  assert.equal(settings, createSearxngSettings());
  const secretValues = secrets
    .trim()
    .split("\n")
    .map((line) => line.slice(line.indexOf("=") + 1));
  assert.equal(secretValues.length, 4);
  assert.equal(new Set(secretValues).size, 4);
  assert.ok(secretValues.every((value) => /^[A-Za-z0-9_-]{43}$/u.test(value)));

  const upCalls = await readDockerCalls(checkout);
  for (const call of upCalls.slice(1)) {
    assert.ok(call.includes("code-sandbox"));
    assert.ok(call.includes("web-search"));
  }

  await writeFile(environmentPath, serializeEnvironment(), { mode: 0o600 });
  await chmod(environmentPath, 0o600);
  const cleaned = runTemporaryHarness(checkout, "down");
  assert.equal(cleaned.status, 0, cleaned.stderr);
  const cleanupCall = (await readDockerCalls(checkout)).at(-1);
  assert.ok(cleanupCall.includes("code-sandbox"));
  assert.ok(cleanupCall.includes("web-search"));
  await assert.rejects(stat(secretsPath), { code: "ENOENT" });
  await assert.rejects(stat(settingsPath), { code: "ENOENT" });
});

test("failed up preserves diagnostic state and reports the exact cleanup", async (t) => {
  if (process.platform === "win32") {
    t.skip("executable fake Docker boundary is POSIX-only");
    return;
  }
  const checkout = await createTemporaryCheckout(t, "relmio-failed-up");
  const failed = runTemporaryHarness(checkout, "up", {
    FAKE_DOCKER_FAIL_UP: "1",
  });

  assert.notEqual(failed.status, 0);
  assert.match(failed.stderr, /node harness\.mjs down/u);
  await stat(join(checkout.harnessDirectory, ".runtime", "owner.json"));
  await stat(
    join(checkout.harnessDirectory, ".runtime", "traffic-policy.yml"),
  );

  const cleaned = runTemporaryHarness(checkout, "down");
  assert.equal(cleaned.status, 0, cleaned.stderr);
  await assert.rejects(
    stat(join(checkout.harnessDirectory, ".runtime", "owner.json")),
    { code: "ENOENT" },
  );
});

test("successful config removes its generated policy without creating ownership", async (t) => {
  if (process.platform === "win32") {
    t.skip("executable fake Docker boundary is POSIX-only");
    return;
  }
  const checkout = await createTemporaryCheckout(t, "relmio-config-clean");

  const configured = runTemporaryHarness(checkout, "config");

  assert.equal(configured.status, 0, configured.stderr);
  const calls = await readDockerCalls(checkout);
  assert.equal(calls.length, 2);
  assert.equal(calls[0][0], "context");
  assert.equal(calls[1][0], "--host");
  assert.equal(calls[1][1], LOCAL_DOCKER_HOST);
  await assert.rejects(
    stat(join(checkout.harnessDirectory, ".runtime", "traffic-policy.yml")),
    { code: "ENOENT" },
  );
  await assert.rejects(
    stat(join(checkout.harnessDirectory, ".runtime", "owner.json")),
    { code: "ENOENT" },
  );
});

test("Assistant config validation leaves no generated secret or search files", async (t) => {
  if (process.platform === "win32") {
    t.skip("executable fake Docker boundary is POSIX-only");
    return;
  }
  const checkout = await createTemporaryCheckout(t, "relmio-assistant-config-clean");
  const environmentPath = join(checkout.harnessDirectory, ".env");
  await writeFile(
    environmentPath,
    serializeEnvironment(enabledAssistantEnvironment()),
    { mode: 0o600 },
  );
  await chmod(environmentPath, 0o600);

  const configured = runTemporaryHarness(checkout, "config");
  assert.equal(configured.status, 0, configured.stderr);
  const calls = await readDockerCalls(checkout);
  assert.ok(calls.at(-1).includes("code-sandbox"));
  assert.ok(calls.at(-1).includes("web-search"));
  await assert.rejects(
    stat(join(checkout.harnessDirectory, ".runtime", "assistant-secrets.env")),
    { code: "ENOENT" },
  );
  await assert.rejects(
    stat(join(checkout.harnessDirectory, ".runtime", "searxng-settings.yml")),
    { code: "ENOENT" },
  );
});

test("config rejects a group or world-readable .env on POSIX", async (t) => {
  if (process.platform === "win32") {
    t.skip("POSIX permission bits are unavailable on Windows");
    return;
  }
  const checkout = await createTemporaryCheckout(t, "relmio-env-mode");
  await chmod(join(checkout.harnessDirectory, ".env"), 0o644);

  const result = runTemporaryHarness(checkout, "config");

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /chmod 600 \.env/u);
  assert.deepEqual(await readDockerCalls(checkout), []);
});

test("Docker selection overrides and remote contexts fail before Compose mutation", async (t) => {
  if (process.platform === "win32") {
    t.skip("executable fake Docker boundary is POSIX-only");
    return;
  }

  for (const overrides of [
    { DOCKER_HOST: "tcp://remote.example:2375" },
    { DOCKER_CONTEXT: "remote" },
    { DOCKER_CONFIG: "/tmp/foreign-docker-config" },
    { DOCKER_TLS_VERIFY: "1" },
  ]) {
    const checkout = await createTemporaryCheckout(t, "relmio-docker-override");
    const rejected = runTemporaryHarness(checkout, "config", overrides);
    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /Docker environment override/iu);
    assert.deepEqual(await readDockerCalls(checkout), []);
  }

  const remote = await createTemporaryCheckout(t, "relmio-remote-context");
  const rejectedRemote = runTemporaryHarness(remote, "config", {
    FAKE_DOCKER_CONTEXT_HOST: "tcp://remote.example:2375",
  });
  assert.notEqual(rejectedRemote.status, 0);
  assert.match(rejectedRemote.stderr, /local Docker daemon|Unix socket/iu);
  const remoteCalls = await readDockerCalls(remote);
  assert.equal(remoteCalls.length, 1);
  assert.equal(remoteCalls[0][0], "context");
});

test("fixture documentation states its proof and cleanup boundaries", async () => {
  const [guide, environmentExample, ignoreFile] = await Promise.all([
    readFile(new URL("README.md", fixtureRoot), "utf8"),
    readFile(new URL(".env.example", fixtureRoot), "utf8"),
    readFile(new URL(".gitignore", fixtureRoot), "utf8"),
  ]);

  assert.match(guide, /Opera GX/u);
  assert.match(guide, /does not prove[\s\S]*SSH/u);
  assert.match(guide, /dedicated[\s\S]*ngrok authtoken/iu);
  assert.match(guide, /port `10531`[\s\S]*never/iu);
  assert.match(guide, /down --volumes --remove-orphans/u);
  assert.match(guide, /per-checkout[\s\S]*ownership marker/iu);
  assert.match(guide, /local Unix socket[\s\S]*pinned/iu);
  assert.match(guide, /90 seconds[\s\S]*n8n healthy/iu);
  assert.match(guide, /Node\.js 22[\s\S]*Windows hosts[\s\S]*unsupported/iu);
  assert.match(guide, /Docker Compose v2\.17\.0[\s\S]*docker compose version/iu);
  assert.match(guide, /mode-`0700`[\s\S]*mode `0644`[\s\S]*non-root/iu);
  assert.match(guide, /private `Z` relabel[\s\S]*SELinux-enforcing/iu);
  assert.match(guide, /does not check the ngrok inspector/iu);
  assert.match(guide, /N8N_WEBHOOK_URL/u);
  assert.match(guide, /sandbox-with-searxng/u);
  assert.match(guide, /RUN_PRIVILEGED_CODE_SANDBOX/u);
  assert.match(guide, /privileged[\s\S]*host-root-equivalent/iu);
  assert.match(guide, /local development[\s\S]*(?:Daytona|Sysbox)/iu);
  assert.match(guide, /SearXNG[\s\S]*JSON/iu);
  assert.match(guide, /not[\s\S]*Code node task runner/iu);
  assert.match(guide, /only n8n[\s\S]*ngrok/iu);
  assert.match(guide, /untrusted[\s\S]*prompt injection/iu);
  assert.match(
    guide,
    /docs\.n8n\.io\/deploy\/host-n8n\/configure-n8n\/basic-configuration\/configuration-examples\/configure-webhook-urls-with-reverse-proxy\//u,
  );
  assert.match(environmentExample, /^NGROK_AUTHTOKEN=replace-/mu);
  assert.match(environmentExample, /^NGROK_DOMAIN=.+\.ngrok\.app$/mu);
  assert.match(environmentExample, /^RELMIO_TEST_ASSISTANT_MODE=disabled$/mu);
  assert.match(
    environmentExample,
    /^RELMIO_TEST_PRIVILEGED_SANDBOX_CONFIRMATION=not-confirmed$/mu,
  );
  assert.doesNotMatch(
    environmentExample,
    /SANDBOX_API_KEYS|SANDBOX_API_RUNNER|SEARXNG_SECRET/u,
  );
  assert.doesNotMatch(environmentExample, /sk-[A-Za-z0-9]|eyJ[A-Za-z0-9_-]+\./u);
  assert.match(ignoreFile, /^\.env$/mu);
  assert.match(ignoreFile, /^\.runtime\/$/mu);
});

#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { isIP } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  runLocalProcess,
  validateLocalDockerHost,
} from "../../src/infrastructure/local-process.js";

const PUBLIC_CONFIRMATION = "EXPOSE_DISPOSABLE_N8N";
const RESERVED_RELMIO_PORT = 10_531;
const OWNER_MARKER_VERSION = 2;
const CONTEXT_INSPECTION_TIMEOUT_MS = 10_000;
const COMPOSE_TIMEOUT_MS = Object.freeze({
  config: 30_000,
  down: 120_000,
  status: 30_000,
  up: 600_000,
});
const harnessDirectory = dirname(fileURLToPath(import.meta.url));
const checkoutRoot = realpathSync(resolve(harnessDirectory, "..", ".."));
const environmentPath = join(harnessDirectory, ".env");
const runtimeDirectory = join(harnessDirectory, ".runtime");
const lifecycleLockPath = join(runtimeDirectory, "lifecycle.lock");
const ownershipMarkerPath = join(runtimeDirectory, "owner.json");
const trafficPolicyPath = join(runtimeDirectory, "traffic-policy.yml");

export const COMPOSE_PROJECT = `relmio-selfhosted-n8n-${createHash("sha256")
  .update(checkoutRoot)
  .digest("hex")
  .slice(0, 24)}`;

const dockerSelectionEnvironmentVariables = new Set([
  "BUILDKIT_HOST",
  "DOCKER_CERT_PATH",
  "DOCKER_CONFIG",
  "DOCKER_CONTEXT",
  "DOCKER_HOST",
  "DOCKER_TLS_VERIFY",
]);

const allowedEnvironmentKeys = new Set([
  "GENERIC_TIMEZONE",
  "NGROK_AUTHTOKEN",
  "NGROK_BASIC_AUTH_PASSWORD",
  "NGROK_BASIC_AUTH_USER",
  "NGROK_DOMAIN",
  "NGROK_INSPECTOR_PORT",
  "N8N_ENCRYPTION_KEY",
  "N8N_LOCAL_PORT",
  "RELMIO_TEST_PUBLIC_CONFIRMATION",
]);

const composeActions = Object.freeze({
  config: ["config", "--quiet"],
  down: ["down", "--volumes", "--remove-orphans"],
  status: ["ps"],
  up: ["up", "--detach", "--wait", "--wait-timeout", "90"],
});

const reservedDomainSuffixes = [
  ".example",
  ".internal",
  ".invalid",
  ".lan",
  ".local",
  ".localhost",
  ".test",
];

function createExpectedOwnershipMarker(dockerHost) {
  return Object.freeze({
    checkoutRoot,
    dockerHost: validateLocalDockerHost(dockerHost),
    project: COMPOSE_PROJECT,
    version: OWNER_MARKER_VERSION,
  });
}

function rejectDockerEnvironmentOverrides(environment) {
  for (const [name, value] of Object.entries(environment)) {
    if (
      dockerSelectionEnvironmentVariables.has(name.toUpperCase()) &&
      typeof value === "string" &&
      value.length > 0
    ) {
      throw new Error(
        "Docker environment overrides are unsupported; use a selected local Docker context.",
      );
    }
  }
}

async function resolveLocalDockerHost(environment) {
  const result = await runLocalProcess(
    {
      file: "docker",
      args: [
        "context",
        "inspect",
        "--format",
        "{{json .Endpoints.docker.Host}}",
      ],
      cwd: harnessDirectory,
      timeoutMs: CONTEXT_INSPECTION_TIMEOUT_MS,
    },
    { environment },
  ).catch(() => {
    throw new Error("The selected Docker context could not be inspected.");
  });
  if (result.code !== 0) {
    throw new Error("The selected Docker context could not be inspected.");
  }

  let candidate;
  try {
    candidate = JSON.parse(result.stdout.trim());
  } catch {
    throw new Error("The selected Docker context is not a local Docker daemon.");
  }
  try {
    return validateLocalDockerHost(candidate);
  } catch {
    throw new Error("The selected Docker context is not a local Docker daemon with a Unix socket.");
  }
}

function requiredString(environment, name) {
  const value = environment?.[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} is required.`);
  }
  if (value !== value.trim() || /[\0\r\n]/u.test(value)) {
    throw new Error(`${name} contains unsupported whitespace or control characters.`);
  }
  return value;
}

function parsePort(environment, name) {
  const value = requiredString(environment, name);
  if (!/^[1-9][0-9]{0,4}$/u.test(value)) {
    throw new Error(`${name} must be an integer from 1 through 65535.`);
  }
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port > 65_535) {
    throw new Error(`${name} must be an integer from 1 through 65535.`);
  }
  return port;
}

function validateDomain(environment) {
  const value = requiredString(environment, "NGROK_DOMAIN");
  const domain = value.toLowerCase();
  const labels = domain.split(".");
  const hasValidLabels =
    domain.length <= 253 &&
    labels.length >= 2 &&
    labels.every(
      (label) =>
        label.length >= 1 &&
        label.length <= 63 &&
        /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/u.test(label),
    );
  const topLevelDomain = labels.at(-1) ?? "";

  if (
    !hasValidLabels ||
    isIP(domain) !== 0 ||
    !/^(?:[a-z]{2,63}|xn--[a-z0-9-]{2,59})$/u.test(topLevelDomain) ||
    reservedDomainSuffixes.some(
      (suffix) => domain === suffix.slice(1) || domain.endsWith(suffix),
    ) ||
    domain.startsWith("replace-")
  ) {
    throw new Error("NGROK_DOMAIN must be a normal public DNS hostname without a scheme or port.");
  }

  return domain;
}

export function validateHarnessEnvironment(environment) {
  const authtoken = requiredString(environment, "NGROK_AUTHTOKEN");
  if (
    !/^[A-Za-z0-9_-]{20,256}$/u.test(authtoken) ||
    authtoken.startsWith("replace-")
  ) {
    throw new Error("NGROK_AUTHTOKEN must be a dedicated ngrok agent authtoken.");
  }

  const basicAuthUsername = requiredString(
    environment,
    "NGROK_BASIC_AUTH_USER",
  );
  if (
    !/^[A-Za-z0-9._@-]{1,64}$/u.test(basicAuthUsername) ||
    basicAuthUsername.startsWith("replace-")
  ) {
    throw new Error(
      "NGROK_BASIC_AUTH_USER must be 1-64 characters and cannot contain a colon.",
    );
  }

  const basicAuthPassword = requiredString(
    environment,
    "NGROK_BASIC_AUTH_PASSWORD",
  );
  if (
    !/^[\x21-\x7e]{16,128}$/u.test(basicAuthPassword) ||
    basicAuthPassword.startsWith("replace-")
  ) {
    throw new Error(
      "NGROK_BASIC_AUTH_PASSWORD must be 16-128 printable characters without spaces.",
    );
  }

  const n8nEncryptionKey = requiredString(environment, "N8N_ENCRYPTION_KEY");
  if (!/^[A-Fa-f0-9]{64}$/u.test(n8nEncryptionKey)) {
    throw new Error("N8N_ENCRYPTION_KEY must contain exactly 64 hexadecimal characters.");
  }

  const confirmation = requiredString(
    environment,
    "RELMIO_TEST_PUBLIC_CONFIRMATION",
  );
  if (confirmation !== PUBLIC_CONFIRMATION) {
    throw new Error(
      `RELMIO_TEST_PUBLIC_CONFIRMATION must equal ${PUBLIC_CONFIRMATION}.`,
    );
  }

  const localPort = parsePort(environment, "N8N_LOCAL_PORT");
  const inspectorPort = parsePort(environment, "NGROK_INSPECTOR_PORT");
  if (
    localPort === RESERVED_RELMIO_PORT ||
    inspectorPort === RESERVED_RELMIO_PORT
  ) {
    throw new Error("Port 10531 is reserved for Relmio and cannot be bound by this harness.");
  }
  if (localPort === inspectorPort) {
    throw new Error("N8N_LOCAL_PORT and NGROK_INSPECTOR_PORT must be different.");
  }

  const timezone = environment.GENERIC_TIMEZONE ?? "Asia/Manila";
  if (
    typeof timezone !== "string" ||
    timezone !== timezone.trim() ||
    !/^[A-Za-z0-9_+.-]+(?:\/[A-Za-z0-9_+.-]+)*$/u.test(timezone)
  ) {
    throw new Error("GENERIC_TIMEZONE must be an IANA-style timezone name.");
  }

  return Object.freeze({
    authtoken,
    basicAuthPassword,
    basicAuthUsername,
    confirmation,
    domain: validateDomain(environment),
    inspectorPort,
    localPort,
    n8nEncryptionKey,
    timezone,
  });
}

export function renderTrafficPolicy(configuration) {
  if (
    configuration === null ||
    typeof configuration !== "object" ||
    typeof configuration.basicAuthUsername !== "string" ||
    typeof configuration.basicAuthPassword !== "string"
  ) {
    throw new Error("A validated harness configuration is required.");
  }

  const credential = JSON.stringify(
    `${configuration.basicAuthUsername}:${configuration.basicAuthPassword}`,
  );
  return [
    "on_http_request:",
    "  - actions:",
    "      - type: basic-auth",
    "        config:",
    "          credentials:",
    `            - ${credential}`,
    "          enforce: true",
    "",
  ].join("\n");
}

export function createComposeArguments(action) {
  if (!Object.hasOwn(composeActions, action)) {
    throw new Error("Unsupported harness action.");
  }
  return [
    "compose",
    "--project-name",
    COMPOSE_PROJECT,
    "--env-file",
    ".env",
    "--file",
    "compose.yml",
    ...composeActions[action],
  ];
}

function parseEnvironmentFile(contents) {
  if (contents.startsWith("\uFEFF")) {
    throw new Error(".env must not contain a byte-order mark.");
  }

  const environment = Object.create(null);
  const lines = contents.split(/\r?\n/u);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith("#")) {
      continue;
    }

    const match = /^([A-Z][A-Z0-9_]*)=(.*)$/u.exec(line);
    if (match === null) {
      throw new Error(`.env line ${index + 1} is not a KEY=value assignment.`);
    }

    const [, key, value] = match;
    if (!allowedEnvironmentKeys.has(key)) {
      throw new Error(`.env contains unsupported key ${key}.`);
    }
    if (Object.hasOwn(environment, key)) {
      throw new Error(`.env contains duplicate key ${key}.`);
    }
    if (value !== value.trim()) {
      throw new Error(`.env value for ${key} has leading or trailing whitespace.`);
    }
    environment[key] = value;
  }

  return environment;
}

async function loadLocalEnvironment(requirePrivatePermissions) {
  let metadata;
  try {
    metadata = await lstat(environmentPath);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new Error("Missing dev/selfhosted-n8n/.env; copy .env.example first.");
    }
    throw new Error("Unable to inspect dev/selfhosted-n8n/.env.");
  }
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error("dev/selfhosted-n8n/.env must be a regular local file.");
  }
  if (
    requirePrivatePermissions &&
    process.platform !== "win32" &&
    (metadata.mode & 0o077) !== 0
  ) {
    throw new Error("dev/selfhosted-n8n/.env must have mode 0600; run chmod 600 .env.");
  }

  let contents;
  try {
    contents = await readFile(environmentPath, "utf8");
  } catch {
    throw new Error("Unable to read dev/selfhosted-n8n/.env.");
  }
  return parseEnvironmentFile(contents);
}

async function ensureRuntimeDirectory() {
  try {
    const metadata = await lstat(runtimeDirectory);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error(".runtime must be a regular local directory.");
    }
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw error;
    }
    await mkdir(runtimeDirectory, { mode: 0o700 });
  }
  await chmod(runtimeDirectory, 0o700);
}

function ownershipError() {
  return new Error(
    "The ownership marker is missing, invalid, or belongs to another checkout; refusing Docker cleanup.",
  );
}

async function readOwnershipMarker(allowMissing = false) {
  let metadata;
  try {
    metadata = await lstat(ownershipMarkerPath);
  } catch (error) {
    if (error?.code === "ENOENT" && allowMissing) {
      return null;
    }
    throw ownershipError();
  }

  if (
    !metadata.isFile() ||
    metadata.isSymbolicLink() ||
    metadata.size > 4096 ||
    (process.platform !== "win32" && (metadata.mode & 0o077) !== 0)
  ) {
    throw ownershipError();
  }

  let marker;
  try {
    marker = JSON.parse(await readFile(ownershipMarkerPath, "utf8"));
  } catch {
    throw ownershipError();
  }

  const keys =
    marker !== null && typeof marker === "object"
      ? Object.keys(marker).sort()
      : [];
  let expectedMarker;
  try {
    expectedMarker = createExpectedOwnershipMarker(marker?.dockerHost);
  } catch {
    throw ownershipError();
  }
  if (
    keys.join(",") !== "checkoutRoot,dockerHost,project,version" ||
    marker.version !== expectedMarker.version ||
    marker.project !== expectedMarker.project ||
    marker.checkoutRoot !== expectedMarker.checkoutRoot
  ) {
    throw ownershipError();
  }

  return marker;
}

async function ensureOwnershipMarker(dockerHost) {
  const expectedMarker = createExpectedOwnershipMarker(dockerHost);
  const existingMarker = await readOwnershipMarker(true);
  if (existingMarker !== null) {
    if (existingMarker.dockerHost !== expectedMarker.dockerHost) {
      throw ownershipError();
    }
    return;
  }

  const temporaryPath = join(
    runtimeDirectory,
    `.owner-${process.pid}-${randomUUID()}.tmp`,
  );
  try {
    await writeFile(
      temporaryPath,
      `${JSON.stringify(expectedMarker)}\n`,
      {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      },
    );
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, ownershipMarkerPath);
    await chmod(ownershipMarkerPath, 0o600);
    await readOwnershipMarker();
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

async function removeOwnershipMarker() {
  await readOwnershipMarker();
  try {
    await unlink(ownershipMarkerPath);
  } catch {
    throw new Error(
      "The Compose project stopped, but its ownership marker could not be removed.",
    );
  }
}

async function acquireLifecycleLock() {
  await ensureRuntimeDirectory();
  let handle;
  try {
    handle = await open(lifecycleLockPath, "wx", 0o600);
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new Error(
        "Another harness command is active, or .runtime/lifecycle.lock is stale. Confirm no harness command is running before removing that lock.",
      );
    }
    throw new Error("Unable to create the harness lifecycle lock.");
  }

  try {
    await handle.writeFile(
      `${JSON.stringify({ pid: process.pid, project: COMPOSE_PROJECT })}\n`,
      "utf8",
    );
    await handle.close();
    await chmod(lifecycleLockPath, 0o600);
  } catch (error) {
    await handle.close().catch(() => {});
    await unlink(lifecycleLockPath).catch(() => {});
    throw error;
  }

  let released = false;
  return async () => {
    if (released) {
      return;
    }
    released = true;
    try {
      await unlink(lifecycleLockPath);
    } catch (error) {
      if (error?.code !== "ENOENT") {
        throw new Error("Unable to release the harness lifecycle lock.");
      }
    }
  };
}

async function writeTrafficPolicy(configuration) {
  await ensureRuntimeDirectory();
  const temporaryPath = join(
    runtimeDirectory,
    `.traffic-policy-${process.pid}-${randomUUID()}.tmp`,
  );
  try {
    await writeFile(temporaryPath, renderTrafficPolicy(configuration), {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    await chmod(temporaryPath, 0o600);
    await rename(temporaryPath, trafficPolicyPath);
    // Docker bind mounts preserve host ownership. The ngrok image runs as a
    // non-root UID, so the mounted file must be world-readable inside the
    // container. Its parent directory remains mode 0700 on the host.
    await chmod(trafficPolicyPath, 0o644);
  } catch (error) {
    await unlink(temporaryPath).catch(() => {});
    throw error;
  }
}

async function removeTrafficPolicy() {
  try {
    await unlink(trafficPolicyPath);
  } catch (error) {
    if (error?.code !== "ENOENT") {
      throw new Error("The Compose project stopped, but its local traffic policy could not be removed.");
    }
  }
}

async function runDockerCompose(action, environment, dockerHost) {
  let result;
  try {
    result = await runLocalProcess(
      {
        file: "docker",
        args: createComposeArguments(action),
        cwd: harnessDirectory,
        dockerHost,
        timeoutMs: COMPOSE_TIMEOUT_MS[action],
      },
      {
        environment: {
          ...process.env,
          ...environment,
          COMPOSE_PROJECT_NAME: COMPOSE_PROJECT,
        },
      },
    );
  } catch {
    throw new Error(
      `Docker Compose ${action} timed out or could not start on the attested local daemon.`,
    );
  }
  if (result.code !== 0) {
    throw new Error(`Docker Compose ${action} failed with exit code ${result.code}.`);
  }
  if (result.stdout.length > 0) {
    process.stdout.write(result.stdout);
  }
  if (result.stderr.length > 0) {
    process.stderr.write(result.stderr);
  }
}

async function runCli() {
  const [action, ...extraArguments] = process.argv.slice(2);
  if (
    extraArguments.length !== 0 ||
    typeof action !== "string" ||
    !Object.hasOwn(composeActions, action)
  ) {
    throw new Error("Usage: node harness.mjs <config|up|status|down>");
  }

  const releaseLifecycleLock = await acquireLifecycleLock();
  try {
    rejectDockerEnvironmentOverrides(process.env);
    const environment = await loadLocalEnvironment(true);

    if (action === "config") {
      const existingOwnership = await readOwnershipMarker(true);
      const dockerHost =
        existingOwnership?.dockerHost ??
        (await resolveLocalDockerHost(process.env));
      const configuration = validateHarnessEnvironment({
        ...environment,
        RELMIO_TEST_PUBLIC_CONFIRMATION: PUBLIC_CONFIRMATION,
      });
      await writeTrafficPolicy(configuration);
      try {
        await runDockerCompose("config", environment, dockerHost);
      } finally {
        if (existingOwnership === null) {
          await removeTrafficPolicy();
        }
      }
      return;
    }

    if (action === "up") {
      const existingOwnership = await readOwnershipMarker(true);
      const dockerHost =
        existingOwnership?.dockerHost ??
        (await resolveLocalDockerHost(process.env));
      const configuration = validateHarnessEnvironment(environment);
      await writeTrafficPolicy(configuration);
      try {
        await runDockerCompose("config", environment, dockerHost);
      } catch (error) {
        if (existingOwnership === null) {
          await removeTrafficPolicy();
        }
        throw new Error(
          `${error.message} Compose validation failed before this checkout started Docker resources.`,
        );
      }
      await ensureOwnershipMarker(dockerHost);
      try {
        await runDockerCompose("up", environment, dockerHost);
      } catch (error) {
        throw new Error(
          `${error.message} Diagnostic state was preserved. Run node harness.mjs down from dev/selfhosted-n8n for the exact owned-project cleanup.`,
        );
      }
      return;
    }

    if (action === "status") {
      const existingOwnership = await readOwnershipMarker(true);
      const dockerHost =
        existingOwnership?.dockerHost ??
        (await resolveLocalDockerHost(process.env));
      await runDockerCompose("status", environment, dockerHost);
      return;
    }

    const existingOwnership = await readOwnershipMarker();
    await runDockerCompose(
      "down",
      environment,
      existingOwnership.dockerHost,
    );
    await removeTrafficPolicy();
    await removeOwnershipMarker();
  } finally {
    await releaseLifecycleLock();
  }
}

let invokedPath = "";
try {
  invokedPath = process.argv[1]
    ? realpathSync(resolve(process.argv[1]))
    : "";
} catch {
  invokedPath = "";
}
if (invokedPath === realpathSync(fileURLToPath(import.meta.url))) {
  runCli().catch((error) => {
    console.error(`Harness error: ${error.message}`);
    process.exitCode = 1;
  });
}

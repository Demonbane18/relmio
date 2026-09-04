import { randomBytes as cryptoRandomBytes, randomUUID } from "node:crypto";
import * as defaultFileSystem from "node:fs/promises";
import { homedir, platform as hostPlatform } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import {
  LOCAL_N8N_STACK_PUBLIC_CONFIRMATION,
  LOCAL_N8N_STACK_REMOVE_CONFIRMATION,
  LOCAL_N8N_STACK_TARGET,
  createLocalN8nStackInstallation,
  getLocalN8nStackLabels,
  getLocalN8nStackServiceNames,
  normalizeLocalN8nStackPlan,
  validateLocalN8nStackMarker,
} from "../domain/local-n8n-stack.js";
import { createAssistantSecrets } from "../domain/assistant-templates.js";
import {
  createLocalN8nStackComposeFile,
  createLocalN8nStackEnv,
  createNgrokConfig,
  createNgrokTrafficPolicy,
  createSearxngSettings,
  LOCAL_N8N_STACK_HEALTHY_SERVICES,
  validateLocalN8nStackSecrets,
} from "../templates/local-n8n-stack/index.js";
import { lockDownLocalPath, runLocalProcess, validateLocalDockerHost } from "../infrastructure/local-process.js";
import { getLocalProcessIdentity } from "../infrastructure/process-identity.js";

const MANAGED_ROOT = ".relmio";
const LOCAL_DIRECTORY = "local";
const INSTALL_DIRECTORY = "n8n-stack";
const ROOT_MARKER = ".managed-by-relmio-root.json";
const MARKER = ".managed-by-relmio.json";
const COMPOSE_FILE = "docker-compose.yml";
const ENV_FILE = ".env";
const RUNTIME_DIRECTORY = ".runtime";
const TRAFFIC_POLICY = "traffic-policy.yml";
const LOCK_DIRECTORY = `${INSTALL_DIRECTORY}.lock`;
const LOCK_OWNER_FILE = ".owner.json";
const LOCK_RECLAIM_DIRECTORY = ".reclaim";
const LIFECYCLE_LOCK_SCHEMA_VERSION = 2;
const LIFECYCLE_LOCK_PUBLICATION_GRACE_MS = 30_000;
const MAX_LIFECYCLE_LOCK_RECLAIM_ATTEMPTS = 4;
const MAX_LIFECYCLE_LOCK_OWNER_BYTES = 4 * 1024;
const MAX_DOCKER_METADATA_BYTES = 1024 * 1024;
const MAX_COMPOSE_VALIDATION_DETAIL_BYTES = 180;
export const LOCAL_N8N_MANAGED_PARTIAL_STACK_ERROR_CODE = "LOCAL_N8N_MANAGED_PARTIAL_STACK";
export const LOCAL_N8N_LIFECYCLE_LOCK_RELEASE_ERROR_CODE = "LOCAL_N8N_LIFECYCLE_LOCK_RELEASE";
export const LOCAL_N8N_STACK_RETRYABLE_STARTUP_ERROR_CODE = "LOCAL_N8N_STACK_RETRYABLE_STARTUP";
export const LOCAL_N8N_STACK_NGROK_SETUP_REJECTED_FAILURE_KIND = "ngrok-setup-rejected";
export const LOCAL_N8N_STACK_DOCKER_ENGINE_RESOURCES_FAILURE_KIND = "docker-engine-resources";
const STACK_STARTUP_FAILURE_KINDS = Object.freeze({
  STACK_CREATION: "stack-creation",
  STACK_STARTUP_WAIT: "stack-startup-wait",
  STACK_IMAGE_PULL: "stack-image-pull",
  STACK_BIND_MOUNT: "stack-bind-mount",
  OWNERSHIP_VERIFICATION: "ownership-verification",
  STACK_RUNTIME_VERIFICATION: "stack-runtime-verification",
  N8N_VERIFICATION: "n8n-verification",
  NGROK_RUNTIME_VERIFICATION: "ngrok-runtime-verification",
  NGROK_SETUP_REJECTED: LOCAL_N8N_STACK_NGROK_SETUP_REJECTED_FAILURE_KIND,
  DOCKER_ENGINE_RESOURCES: LOCAL_N8N_STACK_DOCKER_ENGINE_RESOURCES_FAILURE_KIND,
  ASSISTANT_VERIFICATION: "assistant-verification",
  SEARXNG_SEARCH_VERIFICATION: "searxng-search-verification",
});
export const LOCAL_N8N_STACK_COMPOSE_WAIT_TIMEOUT_SECONDS = 180;
export const LOCAL_N8N_STACK_COMPOSE_PULL_TIMEOUT_MS = 540_000;
export const LOCAL_N8N_STACK_COMPOSE_UP_TIMEOUT_MS = 360_000;
export const LOCAL_N8N_STACK_STATUS_STATES = Object.freeze([
  "absent",
  "healthy",
  "stopped",
  "partial",
  "unavailable",
]);
const LOCAL_N8N_STACK_NOT_MANAGED = Object.freeze({ managed: false, state: "absent" });
const LOCAL_N8N_STACK_UNAVAILABLE = Object.freeze({ managed: false, state: "unavailable" });
const LOCAL_N8N_STACK_HEALTHY = Object.freeze({ managed: true, state: "healthy" });
const LOCAL_N8N_STACK_STOPPED = Object.freeze({ managed: true, state: "stopped" });
const LOCAL_N8N_STACK_PARTIAL = Object.freeze({ managed: true, state: "partial" });
const OWNERSHIP_LABEL_KEYS = Object.freeze([
  "com.docker.compose.project",
  "io.relmio.managed",
  "io.relmio.target",
  "io.relmio.install",
  "io.relmio.project",
]);
const OWNERSHIP_LABEL_FORMAT = OWNERSHIP_LABEL_KEYS
  .map((key) => `"${key}":{{json (.Label "${key}")}}`)
  .join(",");
const CONTAINER_OWNERSHIP_FORMAT = `{"Name":{{json .Names}},"Labels":{${OWNERSHIP_LABEL_FORMAT}}}`;
const NAMED_RESOURCE_OWNERSHIP_FORMAT = `{"Name":{{json .Name}},"Labels":{${OWNERSHIP_LABEL_FORMAT}}}`;
const DOCKER_SELECTION_VARIABLES = new Set([
  "BUILDKIT_HOST", "DOCKER_CERT_PATH", "DOCKER_CONFIG", "DOCKER_CONTEXT",
  "DOCKER_HOST", "DOCKER_TLS_VERIFY",
]);
const STARTUP_FAILURE_KIND = Symbol("local-n8n-stack-startup-failure-kind");
const NGROK_SETUP_REJECTION_CODES = new Set([
  "ERR_NGROK_105",
  "ERR_NGROK_106",
  "ERR_NGROK_107",
  "ERR_NGROK_109",
  "ERR_NGROK_110",
  "ERR_NGROK_300",
  "ERR_NGROK_307",
  "ERR_NGROK_308",
  "ERR_NGROK_309",
  "ERR_NGROK_316",
  "ERR_NGROK_318",
  "ERR_NGROK_319",
  "ERR_NGROK_320",
  "ERR_NGROK_321",
  "ERR_NGROK_322",
  "ERR_NGROK_343",
  "ERR_NGROK_354",
  "ERR_NGROK_360",
  "ERR_NGROK_2257",
  "ERR_NGROK_4018",
  "ERR_NGROK_6022",
  "ERR_NGROK_15002",
  "ERR_NGROK_15008",
  "ERR_NGROK_15009",
  "ERR_NGROK_15011",
  "ERR_NGROK_15012",
  "ERR_NGROK_15013",
]);

function assertSupportedPlatform(platform) {
  if (typeof platform !== "string" || platform.length === 0) {
    throw new TypeError("The local platform is invalid.");
  }
}

function rejectDockerEnvironmentOverrides(env) {
  if (!env || typeof env !== "object" || Array.isArray(env)) {
    throw new TypeError("The local process environment is invalid.");
  }
  for (const [name, value] of Object.entries(env)) {
    if (DOCKER_SELECTION_VARIABLES.has(name.toUpperCase()) && value !== "" && value !== undefined) {
      throw new Error("Relmio requires an attested local Docker context without selector overrides.");
    }
  }
}

function validateAbsolutePath(value) {
  if (typeof value !== "string" || !isAbsolute(value) || value.includes("\0")) {
    throw new TypeError("Relmio local storage path is invalid.");
  }
  return resolve(value);
}

async function lstatIfExists(fileSystem, path) {
  try {
    return await fileSystem.lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw new Error("Relmio could not inspect its local n8n managed directory.");
  }
}

function assertPrivateDirectory(metadata, label) {
  if (!metadata?.isDirectory?.() || metadata.isSymbolicLink()) {
    throw new Error(`Relmio refuses an unsafe ${label}.`);
  }
}

async function ensureDirectory(fileSystem, path, platform, lockDownPath) {
  const metadata = await lstatIfExists(fileSystem, path);
  if (metadata) assertPrivateDirectory(metadata, "local n8n managed directory");
  else await fileSystem.mkdir(path, { mode: 0o700 });
  await fileSystem.chmod(path, 0o700);
  await lockDownPath(path, { platform });
}

async function writePrivateFile(
  fileSystem,
  path,
  contents,
  mode,
  { platform, lockDownPath },
) {
  const existing = await lstatIfExists(fileSystem, path);
  if (existing) {
    throw new Error("Relmio refuses to overwrite a local n8n managed file.");
  }
  const temporary = `${path}.tmp-${randomUUID()}`;
  try {
    await fileSystem.writeFile(temporary, contents, { flag: "wx", mode });
    await fileSystem.chmod(temporary, mode);
    await lockDownPath(temporary, { platform, kind: "file" });
    await fileSystem.rename(temporary, path);
    await fileSystem.chmod(path, mode);
    await lockDownPath(path, {
      platform,
      kind: "file",
      verifyOnly: true,
    });
  } catch (error) {
    try { await fileSystem.unlink(temporary); } catch { /* no temporary file */ }
    throw error;
  }
}

export async function resolveLocalN8nStackInstallRoot({
  env = process.env,
  homeDirectory = homedir(),
  fileSystem = defaultFileSystem,
  platform = hostPlatform(),
} = {}) {
  assertSupportedPlatform(platform);
  const configured = typeof env.RELMIO_HOME === "string" && env.RELMIO_HOME.trim() !== ""
    ? env.RELMIO_HOME : join(homeDirectory, MANAGED_ROOT);
  const root = validateAbsolutePath(configured);
  if (basename(root) !== MANAGED_ROOT) {
    throw new TypeError("Relmio local storage path is invalid.");
  }
  const parent = dirname(root);
  let canonicalParent;
  try { canonicalParent = await fileSystem.realpath(parent); } catch {
    throw new Error("The parent of the Relmio local storage directory is invalid.");
  }
  if (canonicalParent !== resolve(parent)) {
    throw new Error("Relmio refuses a local storage path with a symbolic-link ancestor.");
  }
  return join(canonicalParent, MANAGED_ROOT, LOCAL_DIRECTORY, INSTALL_DIRECTORY);
}

async function resolveAttestedDockerHost({ runProcess, cwd, env, platform }) {
  assertSupportedPlatform(platform);
  rejectDockerEnvironmentOverrides(env);
  const result = await runProcess({
    file: "docker",
    args: ["context", "inspect", "--format", "{{json .Endpoints.docker.Host}}"],
    cwd,
  });
  if (result.code !== 0) throw new Error("The selected Docker context could not be inspected.");
  let dockerHost;
  try {
    dockerHost = validateLocalDockerHost(JSON.parse(result.stdout.trim()), { platform });
  } catch {
    throw new Error("The selected Docker context is not the local Docker engine.");
  }
  if (platform === "win32" && dockerHost.startsWith("npipe:")) {
    const selectedContext = await runProcess({ file: "docker", args: ["context", "show"], cwd });
    if (selectedContext.code !== 0 || selectedContext.stdout.trim() !== "desktop-linux") {
      throw new Error("Docker Desktop's local Linux engine must be selected.");
    }
  }
  return dockerHost;
}

function assertPrivateLifecycleLockDirectory(metadata, { platform, label }) {
  assertPrivateDirectory(metadata, label);
  if (
    platform !== "win32" &&
    (!Number.isInteger(metadata.mode) || (metadata.mode & 0o077) !== 0)
  ) {
    throw new Error(`Relmio refuses an unsafe ${label}.`);
  }
}

function assertPrivateLifecycleLockOwner(metadata, { platform }) {
  if (
    !metadata?.isFile?.() || metadata.isSymbolicLink() ||
    !Number.isInteger(metadata.size) || metadata.size < 0 ||
    metadata.size > MAX_LIFECYCLE_LOCK_OWNER_BYTES ||
    (platform !== "win32" && (
      !Number.isInteger(metadata.mode) || (metadata.mode & 0o077) !== 0
    ))
  ) {
    throw new Error("Relmio refuses an unsafe local n8n operation lock owner.");
  }
}

function composeArgs(marker, suffix) {
  const safe = validateLocalN8nStackMarker(marker);
  return ["compose", "--project-name", safe.projectName, "--env-file", ENV_FILE, "--file", COMPOSE_FILE, ...suffix];
}

async function runOrThrow(runProcess, spec, label) {
  const result = await runProcess(spec);
  if (result.code !== 0) throw new Error(`${label} failed.`);
  return result;
}

function preserveSafeInstallError(error, fallbackMessage) {
  const message = error?.message;
  if (
    typeof message === "string" &&
    message.length > 0 &&
    message.length <= 240 &&
    !/[\r\n]/u.test(message) &&
    !/(?:access|refresh)[_-]?token|private[_-]?key|\bsk-[A-Za-z0-9_-]{8,}|\bBearer\s+\S+|\/(?:Users|home|private|tmp|var|opt|docker)\/|[A-Za-z]:\\/iu.test(message)
  ) {
    return error instanceof Error ? error : new Error(message);
  }
  return new Error(fallbackMessage);
}

function parseJsonLines(value, label) {
  if (typeof value !== "string" || Buffer.byteLength(value) > MAX_DOCKER_METADATA_BYTES) {
    throw new Error(`${label} returned invalid Docker metadata.`);
  }
  if (value.trim() === "") return [];
  try { return value.trim().split("\n").map((line) => JSON.parse(line)); } catch {
    throw new Error(`${label} returned invalid Docker metadata.`);
  }
}

function labelsAreOwned(labels, marker) {
  const expected = {
    "com.docker.compose.project": marker.projectName,
    ...getLocalN8nStackLabels(marker),
  };
  return (
    labels &&
    typeof labels === "object" &&
    !Array.isArray(labels) &&
    Object.keys(labels).length === OWNERSHIP_LABEL_KEYS.length &&
    OWNERSHIP_LABEL_KEYS.every((key) => Object.hasOwn(labels, key) && labels[key] === expected[key])
  );
}

function expectedResourceNames(marker) {
  const services = getLocalN8nStackServiceNames(marker);
  const networks = [
    `${marker.projectName}_edge`,
    ...(marker.assistantMode === "disabled"
      ? []
      : [`${marker.projectName}_assistant-shared`, `${marker.projectName}_assistant-internal`]),
  ];
  const volumes = [
    `${marker.projectName}_n8n-data`,
    ...(marker.assistantMode === "disabled" ? [] : [`${marker.projectName}_sandbox-tls`]),
  ];
  return {
    containers: services.map((service) => `${marker.projectName}-${service}-1`),
    networks,
    volumes,
  };
}

function assertExactOrOwnedSubset({ rows, expectedNames, marker, kind, resourcePolicy }) {
  if (
    !Array.isArray(rows) ||
    (resourcePolicy === "exact" && rows.length !== expectedNames.size) ||
    (resourcePolicy === "subset" && rows.length > expectedNames.size)
  ) {
    throw new Error(`Local n8n ${kind} ownership check failed closed.`);
  }
  const seen = new Set();
  for (const row of rows) {
    const validRow = (
      row &&
      typeof row === "object" &&
      !Array.isArray(row) &&
      Object.keys(row).length === 2 &&
      Object.hasOwn(row, "Name") &&
      Object.hasOwn(row, "Labels")
    );
    const name = row?.Name;
    if (!validRow || !labelsAreOwned(row.Labels, marker) || !expectedNames.has(name) || seen.has(name)) {
      throw new Error(`Local n8n ${kind} ownership check failed closed.`);
    }
    seen.add(name);
  }
}

async function attestOwnedResources({ runProcess, cwd, marker, resourcePolicy = "exact" }) {
  if (resourcePolicy !== "exact" && resourcePolicy !== "subset") {
    throw new TypeError("Local n8n resource attestation policy is invalid.");
  }
  const projectFilter = `label=com.docker.compose.project=${marker.projectName}`;
  const expected = expectedResourceNames(marker);
  const containers = await runOrThrow(runProcess, {
    file: "docker", args: ["ps", "--all", "--no-trunc", "--filter", projectFilter, "--format", CONTAINER_OWNERSHIP_FORMAT], cwd, dockerHost: marker.dockerHost,
  }, "Local n8n container ownership check");
  const containerRows = parseJsonLines(containers.stdout, "Local n8n container ownership check");
  let ownedResourceCount = containerRows.length;
  assertExactOrOwnedSubset({
    rows: containerRows,
    expectedNames: new Set(expected.containers),
    marker,
    kind: "container",
    resourcePolicy,
  });
  for (const [commandKind, kind] of [["network", "network"], ["volume", "volume"]]) {
    const result = await runOrThrow(runProcess, {
      file: "docker", args: [commandKind, "ls", "--filter", projectFilter, "--format", NAMED_RESOURCE_OWNERSHIP_FORMAT], cwd, dockerHost: marker.dockerHost,
    }, `Local n8n ${kind} ownership check`);
    const rows = parseJsonLines(result.stdout, `Local n8n ${kind} ownership check`);
    ownedResourceCount += rows.length;
    assertExactOrOwnedSubset({
      rows,
      expectedNames: new Set(expected[`${kind}s`]),
      marker,
      kind,
      resourcePolicy,
    });
  }
  return Object.freeze({ hasOwnedResources: ownedResourceCount > 0 });
}

async function attemptOwnershipAttestedCleanup({ runProcess, cwd, marker }) {
  try {
    await attestOwnedResources({ runProcess, cwd, marker, resourcePolicy: "subset" });
  } catch {
    return "ownership-unconfirmed";
  }

  try {
    await runProcess({
      file: "docker",
      args: composeArgs(marker, ["down", "--volumes", "--remove-orphans"]),
      cwd,
      dockerHost: marker.dockerHost,
    });
  } catch { /* post-cleanup attestation is authoritative */ }

  try {
    const state = await attestOwnedResources({ runProcess, cwd, marker, resourcePolicy: "subset" });
    return state.hasOwnedResources ? "resources-remain" : "removed";
  } catch {
    return "cleanup-unconfirmed";
  }
}

function createManagedPartialStackError(message) {
  return Object.assign(new Error(message), {
    code: LOCAL_N8N_MANAGED_PARTIAL_STACK_ERROR_CODE,
  });
}

function createTypedStartupFailure(failureKind, message) {
  const error = new Error(message);
  Object.defineProperty(error, STARTUP_FAILURE_KIND, {
    value: failureKind,
  });
  return error;
}

function startupFailureKind(error) {
  return Object.values(STACK_STARTUP_FAILURE_KINDS).includes(
    error?.[STARTUP_FAILURE_KIND],
  )
    ? error[STARTUP_FAILURE_KIND]
    : STACK_STARTUP_FAILURE_KINDS.STACK_RUNTIME_VERIFICATION;
}

function hasNgrokSetupRejectionEvidence(result) {
  const output = [result?.stdout, result?.stderr]
    .filter((value) => typeof value === "string")
    .join("\n");
  const codes = output.match(/\bERR_NGROK_[0-9]{2,5}\b/gu) ?? [];
  return codes.some((code) => NGROK_SETUP_REJECTION_CODES.has(code));
}

function composeFailureOutput(result, error) {
  return [result?.stdout, result?.stderr, error instanceof Error ? error.message : ""]
    .filter((value) => typeof value === "string" && value)
    .join("\n");
}

function safeComposeValidationDetail(result, error) {
  const fragments = [
    result?.stdout,
    result?.stderr,
    error instanceof Error ? error.message : "",
  ].filter((value) => typeof value === "string" && value.trim() !== "");
  if (fragments.length !== 1) return null;
  const detail = fragments[0].trim();
  if (
    detail === "" ||
    Buffer.byteLength(detail) > MAX_COMPOSE_VALIDATION_DETAIL_BYTES ||
    /[\u0000-\u001f\u007f]/u.test(detail) ||
    /(?:^|\s)(?:https?|file|unix|npipe):\/\//iu.test(detail) ||
    /\/(?:Users|home|private|tmp|var|opt|docker)\//iu.test(detail) ||
    /[A-Za-z]:\\/u.test(detail) ||
    /\b(?:docker-)?compose\.ya?ml\b|(?:^|\s)\.env\b/iu.test(detail) ||
    /(?:access|refresh)?[_-]?token|private[_-]?key|password|authorization|cookie|secret|\bsk-[A-Za-z0-9_-]{8,}|\bBearer\s+\S+/iu.test(detail) ||
    /\b[A-Za-z0-9_-]{32,}\b/u.test(detail) ||
    !/^(?:services|networks|volumes|configs)\.[a-z0-9][a-z0-9_.-]{0,95} (?:(?:must be (?:a |an )?(?:mapping|list|string|number|boolean|integer))|is required|Additional property [a-z0-9_.-]{1,64} is not allowed)$/iu.test(detail)
  ) return null;
  return detail;
}

async function validateComposeConfiguration(runProcess, spec) {
  let result;
  try {
    result = await runProcess(spec);
  } catch (error) {
    const detail = safeComposeValidationDetail(undefined, error);
    throw new Error(detail
      ? `Local n8n Compose validation failed: ${detail}`
      : "Local n8n Compose validation failed.");
  }
  if (result?.code === 0) return result;
  const detail = safeComposeValidationDetail(result);
  throw new Error(detail
    ? `Local n8n Compose validation failed: ${detail}`
    : "Local n8n Compose validation failed.");
}

function hasWindowsWslEngineResourceFailure(result, error) {
  const output = composeFailureOutput(result, error);
  return (
    /0x800705aa/iu.test(output) ||
    /Wsl\/Service\/(?:CreateInstance|AttachDisk)\/CreateVm/u.test(output) ||
    /Insufficient system resources exist to complete the requested service/u.test(
      output,
    )
  );
}

function classifyStackCreationFailure(result, error, phase) {
  if (hasNgrokSetupRejectionEvidence(result)) {
    return STACK_STARTUP_FAILURE_KINDS.NGROK_SETUP_REJECTED;
  }
  if (hasWindowsWslEngineResourceFailure(result, error)) {
    return STACK_STARTUP_FAILURE_KINDS.DOCKER_ENGINE_RESOURCES;
  }
  const output = composeFailureOutput(result, error);
  if (
    phase === "pull" &&
    (
      /\bTLS handshake timeout\b/iu.test(output) ||
      /\btoo\s*many\s*requests\b|\btoomanyrequests\b|\brate[- ]limit(?:ed| exceeded)?\b/iu.test(output) ||
      /\bunexpected EOF\b/iu.test(output) ||
      /\bcontext deadline exceeded\b/iu.test(output) ||
      /The local Docker process timed out\./u.test(output)
    )
  ) {
    return STACK_STARTUP_FAILURE_KINDS.STACK_IMAGE_PULL;
  }
  if (
    phase === "start" &&
    (/\bunhealthy\b/iu.test(output) || /\bhealth[- ]?check failed\b/iu.test(output))
  ) {
    return STACK_STARTUP_FAILURE_KINDS.STACK_STARTUP_WAIT;
  }
  if (
    /\bwait[- ]timeout\b/iu.test(output) ||
    /\btimed out waiting\b/iu.test(output) ||
    /\bcontext deadline exceeded\b/iu.test(output) ||
    /The local Docker process timed out\./u.test(output)
  ) {
    return STACK_STARTUP_FAILURE_KINDS.STACK_STARTUP_WAIT;
  }
  if (
    /\bpull access denied\b/iu.test(output) ||
    /\bmanifest unknown\b/iu.test(output) ||
    /\bno matching manifest\b/iu.test(output) ||
    /\bfailed to resolve reference\b/iu.test(output)
  ) {
    return STACK_STARTUP_FAILURE_KINDS.STACK_IMAGE_PULL;
  }
  if (
    /\berror while creating mount source path\b/iu.test(output) ||
    /\binvalid mount config\b/iu.test(output)
  ) {
    return STACK_STARTUP_FAILURE_KINDS.STACK_BIND_MOUNT;
  }
  return STACK_STARTUP_FAILURE_KINDS.STACK_CREATION;
}

function stackCreationFailureMessage(failureKind) {
  switch (failureKind) {
    case STACK_STARTUP_FAILURE_KINDS.NGROK_SETUP_REJECTED:
      return "ngrok rejected the reviewed setup.";
    case STACK_STARTUP_FAILURE_KINDS.DOCKER_ENGINE_RESOURCES:
      return "Docker Desktop could not start its WSL engine.";
    case STACK_STARTUP_FAILURE_KINDS.STACK_STARTUP_WAIT:
      return "The new n8n stack did not become ready in time.";
    case STACK_STARTUP_FAILURE_KINDS.STACK_IMAGE_PULL:
      return "Docker could not download a required n8n stack image.";
    case STACK_STARTUP_FAILURE_KINDS.STACK_BIND_MOUNT:
      return "Docker could not read Relmio's managed n8n files.";
    default:
      return "Docker could not create the new n8n stack.";
  }
}

async function createStackWithCompose({ runProcess, spec, phase }) {
  if (phase !== "pull" && phase !== "start") {
    throw new TypeError("Local n8n Compose startup phase is invalid.");
  }
  let result;
  try {
    result = await runProcess(spec);
  } catch (error) {
    const failureKind = classifyStackCreationFailure(undefined, error, phase);
    throw createTypedStartupFailure(failureKind, stackCreationFailureMessage(failureKind));
  }
  if (result?.code === 0) return result;
  const failureKind = classifyStackCreationFailure(result, undefined, phase);
  throw createTypedStartupFailure(failureKind, stackCreationFailureMessage(failureKind));
}

function retryableStartupMessage(failureKind) {
  switch (failureKind) {
    case STACK_STARTUP_FAILURE_KINDS.NGROK_SETUP_REJECTED:
      return "The n8n + ngrok stack did not start because ngrok rejected its account, endpoint, or credential setup. Check the reserved hostname, active agent authtoken, and Basic Auth. Relmio removed the failed owned resources; retry is safe.";
    case STACK_STARTUP_FAILURE_KINDS.DOCKER_ENGINE_RESOURCES:
      return "Docker Desktop could not start its WSL engine because Windows does not have enough free memory. Close other apps, run wsl --shutdown, start Docker Desktop, wait until it is running, then retry. Relmio removed the failed owned resources.";
    case STACK_STARTUP_FAILURE_KINDS.STACK_CREATION:
      return "Docker could not create the new n8n stack. Relmio removed the failed owned resources. Check Docker image availability and local service startup, then retry.";
    case STACK_STARTUP_FAILURE_KINDS.STACK_STARTUP_WAIT:
      return "The new n8n stack did not become ready in time. Relmio removed the incomplete owned resources. The first start can take several minutes while Docker images download and n8n initializes; keep Docker Desktop running and retry.";
    case STACK_STARTUP_FAILURE_KINDS.STACK_IMAGE_PULL:
      return "Docker could not download a required n8n, ngrok, Code Sandbox, or SearXNG image. Relmio removed the failed owned resources. Check network access to Docker Hub and ghcr.io, then retry.";
    case STACK_STARTUP_FAILURE_KINDS.STACK_BIND_MOUNT:
      return "Docker could not read Relmio's managed n8n files. Relmio removed the failed owned resources. Confirm Docker Desktop can access your user profile, then retry.";
    case STACK_STARTUP_FAILURE_KINDS.OWNERSHIP_VERIFICATION:
      return "Relmio could not verify the new stack's complete ownership metadata. Relmio removed the failed owned resources; retry is safe.";
    case STACK_STARTUP_FAILURE_KINDS.N8N_VERIFICATION:
      return "The new n8n service did not pass health verification. Relmio removed the failed owned resources. Check Docker resources, then retry.";
    case STACK_STARTUP_FAILURE_KINDS.NGROK_RUNTIME_VERIFICATION:
      return "The new ngrok service did not pass runtime verification. Relmio removed the failed owned resources. Check Docker resources, then retry.";
    case STACK_STARTUP_FAILURE_KINDS.ASSISTANT_VERIFICATION:
      return "The selected Assistant services did not pass runtime or network isolation verification. Relmio removed the failed owned resources; retry is safe.";
    case STACK_STARTUP_FAILURE_KINDS.SEARXNG_SEARCH_VERIFICATION:
      return "The selected SearXNG service did not return a valid JSON search result. Relmio removed the failed owned resources; retry is safe.";
    default:
      return "The new n8n stack did not pass runtime verification. Relmio removed the failed owned resources; retry is safe.";
  }
}

function createRetryableStackStartupError(failureKind) {
  return Object.assign(new Error(retryableStartupMessage(failureKind)), {
    code: LOCAL_N8N_STACK_RETRYABLE_STARTUP_ERROR_CODE,
    failureKind,
  });
}

function validatePublication(value, { hostPort, targetPort, requirePublication }) {
  const publishers = value?.Publishers;
  if (!Array.isArray(publishers) || publishers.length !== 1) {
    throw new Error("Local n8n host publication verification failed closed.");
  }
  const publisher = publishers[0];
  if (
    !publisher || publisher.URL !== "127.0.0.1" ||
    publisher.PublishedPort !== hostPort || publisher.TargetPort !== targetPort ||
    publisher.Protocol !== "tcp" || !requirePublication
  ) throw new Error("Local n8n host publication verification failed closed.");
}

function serviceFailureKind(service) {
  if (service === "n8n") {
    return STACK_STARTUP_FAILURE_KINDS.N8N_VERIFICATION;
  }
  if (service === "ngrok") {
    return STACK_STARTUP_FAILURE_KINDS.NGROK_RUNTIME_VERIFICATION;
  }
  return STACK_STARTUP_FAILURE_KINDS.ASSISTANT_VERIFICATION;
}

function serviceFailureMessage(service) {
  if (service === "n8n") return "The new n8n service did not pass health verification.";
  if (service === "ngrok") return "The new ngrok service did not pass runtime verification.";
  return "The selected Assistant services did not pass runtime verification.";
}

async function runTypedStartupCheck({ runProcess, spec, label, failureKind, message }) {
  try {
    return await runOrThrow(runProcess, spec, label);
  } catch {
    throw createTypedStartupFailure(failureKind, message);
  }
}

async function verifyRunningStack({ runProcess, cwd, marker }) {
  const services = getLocalN8nStackServiceNames(marker).filter(
    (service) => service !== "relmio-sandbox-certs",
  );
  const running = await runTypedStartupCheck({
    runProcess,
    spec: {
      file: "docker", args: composeArgs(marker, ["ps", "--status", "running", "--services"]), cwd, dockerHost: marker.dockerHost,
    },
    label: "Local n8n readiness check",
    failureKind: STACK_STARTUP_FAILURE_KINDS.STACK_RUNTIME_VERIFICATION,
    message: "The new n8n stack did not reach the required running service set.",
  });
  const actual = new Set(running.stdout.split(/\s+/u).filter(Boolean));
  if (actual.size !== services.length || services.some((service) => !actual.has(service))) {
    throw createTypedStartupFailure(
      STACK_STARTUP_FAILURE_KINDS.STACK_RUNTIME_VERIFICATION,
      "The new n8n stack did not reach the required running service set.",
    );
  }
  for (const service of services) {
    const failureKind = serviceFailureKind(service);
    const message = serviceFailureMessage(service);
    const result = await runTypedStartupCheck({
      runProcess,
      spec: {
        file: "docker", args: composeArgs(marker, ["ps", "--format", "json", service]), cwd, dockerHost: marker.dockerHost,
      },
      label: "Local n8n service verification",
      failureKind,
      message,
    });
    let rows;
    try {
      rows = parseJsonLines(result.stdout, "Local n8n service verification");
    } catch {
      throw createTypedStartupFailure(failureKind, message);
    }
    if (rows.length !== 1 || rows[0]?.Service !== service || rows[0]?.State !== "running") {
      throw createTypedStartupFailure(failureKind, message);
    }
    if (LOCAL_N8N_STACK_HEALTHY_SERVICES.includes(service) && rows[0]?.Health !== "healthy") {
      throw createTypedStartupFailure(failureKind, message);
    }
    try {
      if (service === "n8n") validatePublication(rows[0], { hostPort: marker.n8nPort, targetPort: 5678, requirePublication: true });
      else if (service === "ngrok") validatePublication(rows[0], { hostPort: marker.ngrokInspectorPort, targetPort: 4040, requirePublication: true });
      else if (!isUnpublishedAssistantService(rows[0]?.Publishers)) {
        throw new Error("An Assistant service published an unexpected host port.");
      }
    } catch {
      throw createTypedStartupFailure(failureKind, message);
    }
  }
  await verifyAssistantEgressNetworks({ runProcess, cwd, marker });
}

function assistantEgressNetworkNames(marker) {
  return marker.assistantMode === "disabled"
    ? []
    : [`${marker.projectName}_assistant-shared`, `${marker.projectName}_assistant-internal`];
}

async function verifyAssistantEgressNetworks({ runProcess, cwd, marker }) {
  for (const network of assistantEgressNetworkNames(marker)) {
    const result = await runTypedStartupCheck({
      runProcess,
      spec: {
        file: "docker",
        args: ["network", "inspect", "--format", "{{json .Internal}}", network],
        cwd,
        dockerHost: marker.dockerHost,
      },
      label: "Local n8n Assistant network verification",
      failureKind: STACK_STARTUP_FAILURE_KINDS.ASSISTANT_VERIFICATION,
      message: "The selected Assistant network isolation verification failed.",
    });
    let internal;
    try { internal = JSON.parse(result.stdout.trim()); } catch {
      throw createTypedStartupFailure(
        STACK_STARTUP_FAILURE_KINDS.ASSISTANT_VERIFICATION,
        "The selected Assistant network isolation verification failed.",
      );
    }
    if (internal !== false) {
      throw createTypedStartupFailure(
        STACK_STARTUP_FAILURE_KINDS.ASSISTANT_VERIFICATION,
        "The selected Assistant network isolation verification failed.",
      );
    }
  }
}

async function verifySearxngSearch({ runProcess, cwd, marker }) {
  if (marker.assistantMode !== "sandbox-with-searxng") return;
  const failureKind =
    STACK_STARTUP_FAILURE_KINDS.SEARXNG_SEARCH_VERIFICATION;
  const message =
    "The selected SearXNG service did not return a valid JSON search result.";
  const search = await runTypedStartupCheck({
    runProcess,
    spec: {
      file: "docker",
      args: composeArgs(marker, [
        "exec",
        "-T",
        "relmio-sandbox-api",
        "wget",
        "-qO-",
        "http://relmio-searxng:8080/search?q=relmio&format=json",
      ]),
      cwd,
      dockerHost: marker.dockerHost,
    },
    label: "Local n8n SearXNG JSON verification",
    failureKind,
    message,
  });
  let payload;
  try {
    payload = JSON.parse(search.stdout);
  } catch {
    throw createTypedStartupFailure(failureKind, message);
  }
  if (!Array.isArray(payload?.results)) {
    throw createTypedStartupFailure(failureKind, message);
  }
}

function isUnpublishedAssistantService(publishers) {
  if (!Array.isArray(publishers)) return false;
  const seenTargetPorts = new Set();
  return publishers.every((publisher) => {
    const valid = (
      publisher && publisher.URL === "" && publisher.PublishedPort === 0 &&
      (publisher.TargetPort === 8080 || publisher.TargetPort === 9090) &&
      publisher.Protocol === "tcp" && !seenTargetPorts.has(publisher.TargetPort)
    );
    if (valid) seenTargetPorts.add(publisher.TargetPort);
    return valid;
  });
}

function runningStackServiceNames(marker) {
  return getLocalN8nStackServiceNames(marker).filter(
    (service) => service !== "relmio-sandbox-certs",
  );
}

function hasExactStoppedState(rows, marker) {
  const services = getLocalN8nStackServiceNames(marker);
  if (!Array.isArray(rows) || rows.length !== services.length) return false;
  const states = new Map();
  for (const row of rows) {
    if (
      !row || typeof row !== "object" || Array.isArray(row) ||
      typeof row.Service !== "string" || typeof row.State !== "string" ||
      !services.includes(row.Service) || states.has(row.Service)
    ) return false;
    states.set(row.Service, row.State);
  }
  return services.every((service) =>
    states.get(service) === "exited",
  );
}

function hasExactRunningState(rows, marker) {
  const services = getLocalN8nStackServiceNames(marker);
  if (!Array.isArray(rows) || rows.length !== services.length) return false;
  const states = new Map();
  for (const row of rows) {
    if (
      !row || typeof row !== "object" || Array.isArray(row) ||
      typeof row.Service !== "string" || typeof row.State !== "string" ||
      !services.includes(row.Service) || states.has(row.Service)
    ) return false;
    states.set(row.Service, row.State);
  }
  return services.every((service) =>
    service === "relmio-sandbox-certs"
      ? states.get(service) === "exited"
      : states.get(service) === "running",
  );
}

async function readOwnedStackServiceStates({ runProcess, cwd, marker }) {
  const rows = [];
  for (const service of getLocalN8nStackServiceNames(marker)) {
    const result = await runOrThrow(runProcess, {
      file: "docker",
      args: composeArgs(marker, ["ps", "--all", "--format", "json", service]),
      cwd,
      dockerHost: marker.dockerHost,
    }, "Local n8n service state inspection");
    const serviceRows = parseJsonLines(result.stdout, "Local n8n service state inspection");
    if (serviceRows.length !== 1) {
      throw new Error("The owned local n8n service state could not be inspected.");
    }
    rows.push(serviceRows[0]);
  }
  return rows;
}

async function classifyOwnedStackRuntime({ runProcess, cwd, marker }) {
  try {
    await attestOwnedResources({
      runProcess,
      cwd,
      marker,
      resourcePolicy: "subset",
    });
  } catch {
    return Object.freeze({ state: "unavailable", exactOwnership: false });
  }

  try {
    await attestOwnedResources({
      runProcess,
      cwd,
      marker,
      resourcePolicy: "exact",
    });
  } catch {
    // A valid owned subset is enough to offer the already-confirmed removal
    // recovery, but never enough to start or recreate anything.
    // An empty resource set with an exact owned marker is also partial: the
    // separately confirmed remover can then delete only the stale managed
    // files after re-attesting the empty Docker set.
    return Object.freeze({ state: "partial", exactOwnership: false });
  }

  let rows;
  try {
    rows = await readOwnedStackServiceStates({ runProcess, cwd, marker });
  } catch {
    return Object.freeze({ state: "unavailable", exactOwnership: true });
  }
  if (hasExactStoppedState(rows, marker)) {
    try {
      await verifyAssistantEgressNetworks({ runProcess, cwd, marker });
      return Object.freeze({ state: "stopped", exactOwnership: true });
    } catch {
      return Object.freeze({ state: "partial", exactOwnership: true });
    }
  }
  if (!hasExactRunningState(rows, marker)) {
    return Object.freeze({ state: "partial", exactOwnership: true });
  }

  try {
    await verifyRunningStack({ runProcess, cwd, marker });
    return Object.freeze({ state: "healthy", exactOwnership: true });
  } catch {
    return Object.freeze({ state: "partial", exactOwnership: true });
  }
}

async function removeManagedFiles({ fileSystem, installRoot }) {
  const metadata = await lstatIfExists(fileSystem, installRoot);
  if (!metadata) return;
  assertPrivateDirectory(metadata, "local n8n managed directory");
  await fileSystem.rm(installRoot, { recursive: true, force: false });
}

async function readOwnedMarker({ fileSystem, installRoot }) {
  const directory = await lstatIfExists(fileSystem, installRoot);
  if (!directory) throw new Error("No Relmio-owned local n8n stack is installed.");
  assertPrivateDirectory(directory, "local n8n managed directory");
  const markerPath = join(installRoot, MARKER);
  const markerMetadata = await lstatIfExists(fileSystem, markerPath);
  if (!markerMetadata?.isFile?.() || markerMetadata.isSymbolicLink()) {
    throw new Error("The local n8n stack directory is unmanaged. Nothing was changed.");
  }
  try { return validateLocalN8nStackMarker(JSON.parse(await fileSystem.readFile(markerPath, "utf8"))); } catch {
    throw new Error("The local n8n stack ownership marker is invalid.");
  }
}

function managedLocalRootPaths(installRoot) {
  const relmioRoot = resolve(installRoot, "..", "..");
  return Object.freeze({
    relmioRoot,
    localRoot: join(relmioRoot, LOCAL_DIRECTORY),
    rootMarkerPath: join(relmioRoot, ROOT_MARKER),
  });
}

async function validateManagedLocalRootOwnership({ fileSystem, installRoot }) {
  const paths = managedLocalRootPaths(installRoot);
  const rootMetadata = await lstatIfExists(fileSystem, paths.relmioRoot);
  assertPrivateDirectory(rootMetadata, "Relmio local storage directory");
  const rootMarker = await lstatIfExists(fileSystem, paths.rootMarkerPath);
  if (!rootMarker?.isFile?.() || rootMarker.isSymbolicLink()) {
    throw new Error("The Relmio local storage directory is not an owned managed root. Nothing was changed.");
  }
  try {
    const parsed = JSON.parse(await fileSystem.readFile(paths.rootMarkerPath, "utf8"));
    if (parsed?.schemaVersion !== 1 || parsed?.kind !== "relmio-local-root") throw new Error("mismatch");
  } catch {
    throw new Error("The Relmio local storage directory is not an owned managed root. Nothing was changed.");
  }
  return paths;
}

async function verifyWindowsStatusPathSecurity({
  fileSystem,
  installRoot,
  marker,
  platform,
  lockDownPath,
}) {
  if (platform !== "win32") return;
  const safeMarker = validateLocalN8nStackMarker(marker);
  const { relmioRoot, localRoot, rootMarkerPath } = managedLocalRootPaths(installRoot);
  for (const path of [
    relmioRoot,
    localRoot,
    installRoot,
    join(installRoot, RUNTIME_DIRECTORY),
  ]) {
    assertPrivateDirectory(
      await lstatIfExists(fileSystem, path),
      "local n8n managed directory",
    );
    await lockDownPath(path, { platform, verifyOnly: true });
  }
  for (const path of [
    rootMarkerPath,
    join(installRoot, MARKER),
    join(installRoot, ENV_FILE),
    join(installRoot, COMPOSE_FILE),
    join(installRoot, "ngrok.yml"),
    join(installRoot, RUNTIME_DIRECTORY, TRAFFIC_POLICY),
    ...(safeMarker.assistantMode === "sandbox-with-searxng"
      ? [join(installRoot, RUNTIME_DIRECTORY, "searxng-settings.yml")]
      : []),
  ]) {
    const metadata = await lstatIfExists(fileSystem, path);
    if (!metadata?.isFile?.() || metadata.isSymbolicLink()) {
      throw new Error("Relmio refuses an unsafe local n8n managed file.");
    }
    await lockDownPath(path, {
      platform,
      kind: "file",
      verifyOnly: true,
      verifyEffectiveOwnerOnly: true,
    });
  }
}

function createLocalN8nStackStatusSnapshot(marker, state) {
  const safe = validateLocalN8nStackMarker(marker);
  const codeSandbox = safe.assistantMode !== "disabled";
  return Object.freeze({
    target: LOCAL_N8N_STACK_TARGET,
    assistantMode: safe.assistantMode,
    endpoints: Object.freeze({
      n8nLocal: `http://127.0.0.1:${safe.n8nPort}`,
      ngrokPublic: `https://${safe.ngrokHostname}`,
      ngrokInspector: `http://127.0.0.1:${safe.ngrokInspectorPort}`,
    }),
    components: Object.freeze({
      n8n: true,
      ngrok: true,
      codeSandbox,
      searxng: safe.assistantMode === "sandbox-with-searxng",
    }),
    canResume: state === "stopped",
    canRemove: true,
  });
}

function withLocalN8nStackStatusSnapshot(coarseStatus, marker) {
  const result = { ...coarseStatus };
  Object.defineProperty(result, "snapshot", {
    configurable: false,
    enumerable: false,
    value: createLocalN8nStackStatusSnapshot(marker, coarseStatus.state),
    writable: false,
  });
  return Object.freeze(result);
}

export async function getLocalN8nStackStatus({
  runProcess = runLocalProcess,
  fileSystem = defaultFileSystem,
  homeDirectory = homedir(),
  cwd = process.cwd(),
  env = process.env,
  platform = hostPlatform(),
  lockDownPath = lockDownLocalPath,
} = {}) {
  let installRoot;
  try {
    installRoot = await resolveLocalN8nStackInstallRoot({
      env,
      homeDirectory,
      fileSystem,
      platform,
    });
    if (!await lstatIfExists(fileSystem, installRoot)) {
      return LOCAL_N8N_STACK_NOT_MANAGED;
    }
    const { localRoot } = await validateManagedLocalRootOwnership({ fileSystem, installRoot });
    assertPrivateDirectory(
      await lstatIfExists(fileSystem, localRoot),
      "local n8n managed directory",
    );
    const marker = await readOwnedMarker({ fileSystem, installRoot });
    await verifyWindowsStatusPathSecurity({
      fileSystem,
      installRoot,
      marker,
      platform,
      lockDownPath,
    });
    const dockerHost = await resolveAttestedDockerHost({
      runProcess,
      cwd,
      env,
      platform,
    });
    if (dockerHost !== marker.dockerHost) {
      return LOCAL_N8N_STACK_UNAVAILABLE;
    }
    const runtime = await classifyOwnedStackRuntime({
      runProcess,
      cwd: installRoot,
      marker,
    });
    if (runtime.state === "unavailable") return LOCAL_N8N_STACK_UNAVAILABLE;
    const coarseStatus = runtime.state === "healthy"
      ? LOCAL_N8N_STACK_HEALTHY
      : runtime.state === "stopped"
        ? LOCAL_N8N_STACK_STOPPED
        : LOCAL_N8N_STACK_PARTIAL;
    return runtime.exactOwnership
      ? withLocalN8nStackStatusSnapshot(coarseStatus, marker)
      : coarseStatus;
  } catch {
    return LOCAL_N8N_STACK_UNAVAILABLE;
  }
}

async function ensureManagedLocalRoot({ fileSystem, installRoot, platform, lockDownPath }) {
  const { relmioRoot, localRoot, rootMarkerPath } = managedLocalRootPaths(installRoot);
  let rootCreated = false;
  let localCreated = false;
  try {
    const rootMetadata = await lstatIfExists(fileSystem, relmioRoot);
    if (rootMetadata) {
      await validateManagedLocalRootOwnership({ fileSystem, installRoot });
    } else {
      await fileSystem.mkdir(relmioRoot, { mode: 0o700 });
      rootCreated = true;
      await fileSystem.chmod(relmioRoot, 0o700);
      await lockDownPath(relmioRoot, { platform });
      await writePrivateFile(
        fileSystem,
        rootMarkerPath,
        `${JSON.stringify({ schemaVersion: 1, kind: "relmio-local-root" })}\n`,
        0o600,
        { platform, lockDownPath },
      );
    }
    await fileSystem.chmod(relmioRoot, 0o700);
    await lockDownPath(relmioRoot, { platform });
    const localMetadata = await lstatIfExists(fileSystem, localRoot);
    if (localMetadata) assertPrivateDirectory(localMetadata, "local n8n managed directory");
    else {
      await fileSystem.mkdir(localRoot, { mode: 0o700 });
      localCreated = true;
    }
    await fileSystem.chmod(localRoot, 0o700);
    await lockDownPath(localRoot, { platform });
    return localRoot;
  } catch (error) {
    if (localCreated) {
      try { await fileSystem.rmdir(localRoot); } catch { /* preserve unexpected state */ }
    }
    if (rootCreated) {
      try { await fileSystem.unlink(rootMarkerPath); } catch { /* marker may not exist */ }
      try { await fileSystem.rmdir(relmioRoot); } catch { /* preserve unexpected state */ }
    }
    throw error;
  }
}

async function createManagedFiles({
  fileSystem,
  installRoot,
  installation,
  secrets,
  randomBytes,
  platform,
  lockDownPath,
}) {
  const existingInstall = await lstatIfExists(fileSystem, installRoot);
  if (existingInstall) throw new Error("A local n8n stack directory already exists. Nothing was overwritten.");
  await ensureManagedLocalRoot({ fileSystem, installRoot, platform, lockDownPath });
  let installDirectoryCreated = false;
  try {
    await fileSystem.mkdir(installRoot, { mode: 0o700 });
    installDirectoryCreated = true;
    await fileSystem.chmod(installRoot, 0o700);
    await lockDownPath(installRoot, { platform });
    await ensureDirectory(fileSystem, join(installRoot, RUNTIME_DIRECTORY), platform, lockDownPath);
    const n8nKey = randomBytes(32);
    if (!Buffer.isBuffer(n8nKey) || n8nKey.length !== 32) throw new TypeError("A cryptographic local n8n secret generator is required.");
    const assistantSecrets = installation.assistantMode === "disabled"
      ? null : createAssistantSecrets({ randomBytes, includeSearxng: installation.assistantMode === "sandbox-with-searxng" });
    const runtimeSecrets = { n8nEncryptionKey: n8nKey.toString("hex"), ...assistantSecrets };
    const privateFileOptions = { platform, lockDownPath };
    await writePrivateFile(fileSystem, join(installRoot, MARKER), `${JSON.stringify(installation.marker)}\n`, 0o600, privateFileOptions);
    await writePrivateFile(fileSystem, join(installRoot, ENV_FILE), createLocalN8nStackEnv({ installation, secrets, runtimeSecrets }), 0o600, privateFileOptions);
    await writePrivateFile(fileSystem, join(installRoot, COMPOSE_FILE), createLocalN8nStackComposeFile({ installation }), 0o600, privateFileOptions);
    await writePrivateFile(fileSystem, join(installRoot, "ngrok.yml"), createNgrokConfig(), 0o644, privateFileOptions);
    await writePrivateFile(fileSystem, join(installRoot, RUNTIME_DIRECTORY, TRAFFIC_POLICY), createNgrokTrafficPolicy({ username: secrets.basicAuthUsername, password: secrets.basicAuthPassword }), 0o600, privateFileOptions);
    if (installation.assistantMode === "sandbox-with-searxng") {
      await writePrivateFile(fileSystem, join(installRoot, RUNTIME_DIRECTORY, "searxng-settings.yml"), createSearxngSettings(), 0o644, privateFileOptions);
    }
  } catch (error) {
    if (installDirectoryCreated) {
      try { await removeManagedFiles({ fileSystem, installRoot }); } catch {
        throw new Error("Local n8n managed-file creation failed and its partial directory could not be removed.");
      }
    }
    throw error;
  }
}

function validLifecycleLockPublication(value) {
  return (
    value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === 5 &&
    value.schemaVersion === LIFECYCLE_LOCK_SCHEMA_VERSION &&
    Number.isSafeInteger(value.pid) && value.pid > 0 && value.pid <= 2_147_483_647 &&
    typeof value.processStartIdentity === "string" && value.processStartIdentity.length > 0 &&
    Buffer.byteLength(value.processStartIdentity) <= 512 && !/[\0\r\n]/u.test(value.processStartIdentity) &&
    typeof value.token === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(value.token) &&
    Number.isSafeInteger(value.publishedAtMs) && value.publishedAtMs > 0
  );
}

function sameLifecycleLockPublication(left, right) {
  return validLifecycleLockPublication(left) && validLifecycleLockPublication(right) &&
    left.schemaVersion === right.schemaVersion &&
    left.pid === right.pid &&
    left.processStartIdentity === right.processStartIdentity &&
    left.token === right.token &&
    left.publishedAtMs === right.publishedAtMs;
}

function lockOwnerFingerprint(metadata, raw) {
  return Object.freeze({
    raw,
    size: metadata.size,
    dev: metadata.dev,
    ino: metadata.ino,
    mtimeMs: metadata.mtimeMs,
    ctimeMs: metadata.ctimeMs,
  });
}

function lockDirectoryFingerprint(metadata) {
  if (
    !Number.isInteger(metadata?.dev) || !Number.isInteger(metadata?.ino) ||
    !Number.isFinite(metadata?.birthtimeMs) || metadata.birthtimeMs < 0
  ) {
    throw new Error("Relmio could not inspect the local n8n operation lock.");
  }
  return Object.freeze({
    dev: metadata.dev,
    ino: metadata.ino,
    birthtimeMs: metadata.birthtimeMs,
  });
}

function sameLockDirectoryFingerprint(left, right) {
  return left?.dev === right?.dev && left?.ino === right?.ino &&
    left?.birthtimeMs === right?.birthtimeMs;
}

function sameLockOwnerFingerprint(left, right) {
  return left?.raw === right?.raw && left?.size === right?.size &&
    left?.dev === right?.dev && left?.ino === right?.ino &&
    left?.mtimeMs === right?.mtimeMs && left?.ctimeMs === right?.ctimeMs;
}

function lifecycleLockNow(now) {
  const value = now();
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error("Relmio could not inspect the local n8n operation lock.");
  }
  return value;
}

function lifecycleLockPublicationTime(metadata) {
  const value = metadata?.mtimeMs;
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : null;
}

function incompletePublicationIsPastGrace(metadata, { now, graceMs }) {
  const publishedAt = lifecycleLockPublicationTime(metadata);
  const currentTime = lifecycleLockNow(now);
  if (publishedAt === null || publishedAt > currentTime) return false;
  return currentTime - publishedAt >= graceMs;
}

function validateLifecycleLockIdentity(identity) {
  return (
    identity && typeof identity === "object" && !Array.isArray(identity) &&
    (identity.state === "dead" || identity.state === "ambiguous" || (
      identity.state === "active" && typeof identity.startIdentity === "string" &&
      identity.startIdentity.length > 0 && Buffer.byteLength(identity.startIdentity) <= 512 &&
      !/[\0\r\n]/u.test(identity.startIdentity)
    ))
  );
}

async function inspectLifecycleLockClaim({ fileSystem, lockPath, platform, lockDownPath }) {
  let lockMetadata = await lstatIfExists(fileSystem, lockPath);
  assertPrivateLifecycleLockDirectory(lockMetadata, {
    platform,
    label: "local n8n operation lock",
  });
  if (platform === "win32") {
    await lockDownPath(lockPath, { platform, verifyOnly: true });
    lockMetadata = await lstatIfExists(fileSystem, lockPath);
    assertPrivateLifecycleLockDirectory(lockMetadata, {
      platform,
      label: "local n8n operation lock",
    });
  }
  const directoryFingerprint = lockDirectoryFingerprint(lockMetadata);
  const ownerPath = join(lockPath, LOCK_OWNER_FILE);
  let ownerMetadata = await lstatIfExists(fileSystem, ownerPath);
  if (!ownerMetadata) {
    return Object.freeze({
      kind: "incomplete",
      source: "missing",
      ownerPath,
      ageMetadata: lockMetadata,
      directoryFingerprint,
    });
  }
  assertPrivateLifecycleLockOwner(ownerMetadata, { platform });
  if (platform === "win32") {
    await lockDownPath(ownerPath, { platform, kind: "file", verifyOnly: true });
    ownerMetadata = await lstatIfExists(fileSystem, ownerPath);
    assertPrivateLifecycleLockOwner(ownerMetadata, { platform });
  }
  let raw;
  try {
    raw = await fileSystem.readFile(ownerPath, "utf8");
  } catch {
    throw new Error("Relmio could not inspect the local n8n operation lock.");
  }
  const ownerAfterRead = await lstatIfExists(fileSystem, ownerPath);
  assertPrivateLifecycleLockOwner(ownerAfterRead, { platform });
  const fingerprint = lockOwnerFingerprint(ownerMetadata, raw);
  if (!sameLockOwnerFingerprint(fingerprint, lockOwnerFingerprint(ownerAfterRead, raw))) {
    throw new Error("Relmio could not inspect the local n8n operation lock.");
  }
  try {
    const publication = JSON.parse(raw);
    if (validLifecycleLockPublication(publication)) {
      return Object.freeze({
        kind: "published",
        publication: Object.freeze(publication),
        ownerPath,
        fingerprint,
        directoryFingerprint,
      });
    }
  } catch { /* malformed publication receives only the bounded startup grace. */ }
  return Object.freeze({
    kind: "incomplete",
    source: "malformed",
    ownerPath,
    fingerprint,
    ageMetadata: ownerAfterRead,
    directoryFingerprint,
  });
}

async function lifecycleLockClaimState(claim, { getProcessIdentity, now, platform, graceMs }) {
  if (claim.kind === "incomplete") {
    return incompletePublicationIsPastGrace(claim.ageMetadata, { now, graceMs }) ? "stale" : "starting";
  }
  let identity;
  try {
    identity = await getProcessIdentity(claim.publication.pid, { platform });
  } catch {
    return "ambiguous";
  }
  if (!validateLifecycleLockIdentity(identity) || identity.state === "ambiguous") return "ambiguous";
  if (identity.state === "dead") return "stale";
  return identity.startIdentity === claim.publication.processStartIdentity ? "active" : "stale";
}

async function detachLifecycleLock({ fileSystem, lockPath }) {
  for (let attempt = 0; attempt < MAX_LIFECYCLE_LOCK_RECLAIM_ATTEMPTS; attempt += 1) {
    const quarantinePath = `${lockPath}.quarantine-${randomUUID()}`;
    if (await lstatIfExists(fileSystem, quarantinePath)) continue;
    try {
      await fileSystem.rename(lockPath, quarantinePath);
      return quarantinePath;
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      if (error?.code === "EEXIST" || error?.code === "ENOTEMPTY") continue;
      throw new Error("Relmio could not safely detach the local n8n operation lock.");
    }
  }
  throw new Error("Relmio could not safely detach the local n8n operation lock.");
}

function claimsMatch(before, after) {
  if (!sameLockDirectoryFingerprint(before.directoryFingerprint, after.directoryFingerprint)) return false;
  if (before.kind !== after.kind || before.source !== after.source) return false;
  if (before.kind === "published") return sameLifecycleLockPublication(before.publication, after.publication);
  if (before.source === "missing") return true;
  return sameLockOwnerFingerprint(before.fingerprint, after.fingerprint);
}

function staleClaimStillMatches(before, after, afterState) {
  if (!claimsMatch(before, after)) return false;
  // Publishing the nested arbitration directory necessarily updates the
  // parent directory mtime used for a missing-owner grace calculation. The
  // unchanged directory identity plus unchanged missing-owner state remains
  // authoritative after the original claim has already aged past the grace.
  if (before.kind === "incomplete" && before.source === "missing") return true;
  return afterState === "stale";
}

async function removeDetachedLifecycleLock({
  fileSystem,
  claim,
  quarantinePath,
  platform,
  lockDownPath,
}) {
  let entries;
  try { entries = (await fileSystem.readdir(quarantinePath)).sort(); } catch {
    throw new Error("Relmio could not inspect the detached local n8n operation lock.");
  }
  const expectedEntries = claim.source === "missing" ? [] : [LOCK_OWNER_FILE];
  if (
    entries.length !== expectedEntries.length ||
    entries.some((entry, index) => entry !== expectedEntries[index])
  ) {
    throw new Error("Relmio refuses to remove a local n8n operation lock with unexpected contents.");
  }
  const ownerPath = join(quarantinePath, LOCK_OWNER_FILE);
  let removedOwner = false;
  try {
    if (claim.source !== "missing") {
      await fileSystem.unlink(ownerPath);
      removedOwner = true;
    }
    await fileSystem.rmdir(quarantinePath);
  } catch (error) {
    if (removedOwner && typeof claim.fingerprint?.raw === "string") {
      try {
        await fileSystem.writeFile(ownerPath, claim.fingerprint.raw, {
          flag: "wx",
          mode: 0o600,
        });
        await fileSystem.chmod(ownerPath, 0o600);
        await lockDownPath(ownerPath, { platform, kind: "file" });
      } catch {
        // The detached directory is intentionally preserved; callers never
        // claim successful release or reclamation when owner restoration
        // itself cannot be proven.
      }
    }
    throw error;
  }
}

async function restoreDetachedLifecycleLock({ fileSystem, lockPath, quarantinePath }) {
  try {
    if (await lstatIfExists(fileSystem, lockPath)) return false;
    await fileSystem.rename(quarantinePath, lockPath);
    return true;
  } catch {
    return false;
  }
}

async function createdLifecycleLockStillMatches({
  expectedDirectoryFingerprint,
  fileSystem,
  lockPath,
  ownerPublication,
  requireReclaim = false,
}) {
  try {
    const metadata = await lstatIfExists(fileSystem, lockPath);
    assertPrivateDirectory(metadata, "local n8n operation lock");
    if (!sameLockDirectoryFingerprint(
      expectedDirectoryFingerprint,
      lockDirectoryFingerprint(metadata),
    )) return false;
    const entries = (await fileSystem.readdir(lockPath)).sort();
    const hasReclaim = entries.includes(LOCK_RECLAIM_DIRECTORY);
    if (hasReclaim !== requireReclaim) return false;
    const remainingEntries = entries.filter((entry) => entry !== LOCK_RECLAIM_DIRECTORY);
    if (remainingEntries.length === 0) return true;
    if (remainingEntries.length !== 1 || remainingEntries[0] !== LOCK_OWNER_FILE) return false;
    const ownerPath = join(lockPath, LOCK_OWNER_FILE);
    const ownerMetadata = await lstatIfExists(fileSystem, ownerPath);
    if (
      !ownerMetadata?.isFile?.() || ownerMetadata.isSymbolicLink() ||
      !Number.isInteger(ownerMetadata.size) || ownerMetadata.size < 0 ||
      ownerMetadata.size > MAX_LIFECYCLE_LOCK_OWNER_BYTES
    ) return false;
    const raw = await fileSystem.readFile(ownerPath, "utf8");
    const ownerAfterRead = await lstatIfExists(fileSystem, ownerPath);
    if (!sameLockOwnerFingerprint(
      lockOwnerFingerprint(ownerMetadata, raw),
      lockOwnerFingerprint(ownerAfterRead, raw),
    )) return false;
    return sameLifecycleLockPublication(JSON.parse(raw), ownerPublication);
  } catch {
    return false;
  }
}

async function safelyAbandonCreatedLifecycleLock({
  expectedDirectoryFingerprint,
  fileSystem,
  lockPath,
  ownerPublication,
}) {
  if (!await createdLifecycleLockStillMatches({
    expectedDirectoryFingerprint,
    fileSystem,
    lockPath,
    ownerPublication,
  })) return;
  const reclaimPath = join(lockPath, LOCK_RECLAIM_DIRECTORY);
  try {
    await fileSystem.mkdir(reclaimPath, { mode: 0o700 });
  } catch {
    return;
  }
  if (!await createdLifecycleLockStillMatches({
    expectedDirectoryFingerprint,
    fileSystem,
    lockPath,
    ownerPublication,
    requireReclaim: true,
  })) {
    try { await fileSystem.rmdir(reclaimPath); } catch { /* Preserve changed contents. */ }
    return;
  }
  let quarantinePath;
  try { quarantinePath = await detachLifecycleLock({ fileSystem, lockPath }); } catch { return; }
  if (!quarantinePath) return;
  try {
    if (!await createdLifecycleLockStillMatches({
      expectedDirectoryFingerprint,
      fileSystem,
      lockPath: quarantinePath,
      ownerPublication,
      requireReclaim: true,
    })) return;
    const entries = (await fileSystem.readdir(quarantinePath)).sort();
    await fileSystem.rmdir(join(quarantinePath, LOCK_RECLAIM_DIRECTORY));
    if (entries.includes(LOCK_OWNER_FILE)) {
      await fileSystem.unlink(join(quarantinePath, LOCK_OWNER_FILE));
    }
    await fileSystem.rmdir(quarantinePath);
  } catch { /* Keep unexpected or replaced data in its unique quarantine. */ }
}

async function createLifecycleLockDirectory({
  fileSystem,
  lockPath,
  ownerPublication,
  platform,
  lockDownPath,
}) {
  await fileSystem.mkdir(lockPath, { mode: 0o700 });
  let directoryFingerprint;
  try {
    directoryFingerprint = lockDirectoryFingerprint(await fileSystem.lstat(lockPath));
    await fileSystem.chmod(lockPath, 0o700);
    await lockDownPath(lockPath, { platform });
    const ownerPath = join(lockPath, LOCK_OWNER_FILE);
    await writePrivateFile(
      fileSystem,
      ownerPath,
      `${JSON.stringify(ownerPublication)}\n`,
      0o600,
      { platform, lockDownPath },
    );
    await lockDownPath(ownerPath, { platform, kind: "file" });
    const published = await inspectLifecycleLockClaim({
      fileSystem, lockPath, platform, lockDownPath,
    });
    if (
      published.kind !== "published" ||
      !sameLifecycleLockPublication(published.publication, ownerPublication) ||
      !sameLockDirectoryFingerprint(published.directoryFingerprint, directoryFingerprint)
    ) throw new Error("The local n8n operation lock publication changed.");
    return published;
  } catch (error) {
    if (directoryFingerprint) {
      await safelyAbandonCreatedLifecycleLock({
        expectedDirectoryFingerprint: directoryFingerprint,
        fileSystem,
        lockPath,
        ownerPublication,
      });
    }
    throw error;
  }
}

async function reclaimStaleArbitrationLock({
  fileSystem,
  getProcessIdentity,
  graceMs,
  lockPath,
  now,
  platform,
  lockDownPath,
}) {
  const initial = await inspectLifecycleLockClaim({
    fileSystem, lockPath, platform, lockDownPath,
  });
  const initialState = await lifecycleLockClaimState(initial, {
    getProcessIdentity, now, platform, graceMs,
  });
  if (initialState !== "stale") return initialState;
  const quarantinePath = await detachLifecycleLock({ fileSystem, lockPath });
  if (!quarantinePath) return "changed";
  try {
    const detached = await inspectLifecycleLockClaim({
      fileSystem,
      lockPath: quarantinePath,
      platform,
      lockDownPath,
    });
    const detachedState = await lifecycleLockClaimState(detached, {
      getProcessIdentity, now, platform, graceMs,
    });
    if (!claimsMatch(initial, detached) || detachedState !== "stale") {
      await restoreDetachedLifecycleLock({ fileSystem, lockPath, quarantinePath });
      return "changed";
    }
    await removeDetachedLifecycleLock({
      fileSystem, claim: detached, quarantinePath, platform, lockDownPath,
    });
    return "reclaimed";
  } catch {
    await restoreDetachedLifecycleLock({ fileSystem, lockPath, quarantinePath });
    throw new Error("Relmio could not safely reclaim the local n8n operation arbitration lock.");
  }
}

async function acquireLifecycleReclaimLock({
  fileSystem,
  getProcessIdentity,
  graceMs,
  lockPath,
  now,
  platform,
  selfIdentity,
  lockDownPath,
}) {
  const reclaimPath = join(lockPath, LOCK_RECLAIM_DIRECTORY);
  const ownerPublication = Object.freeze({
    schemaVersion: LIFECYCLE_LOCK_SCHEMA_VERSION,
    pid: process.pid,
    processStartIdentity: selfIdentity.startIdentity,
    token: randomUUID(),
    publishedAtMs: lifecycleLockNow(now),
  });
  for (let attempt = 0; attempt < MAX_LIFECYCLE_LOCK_RECLAIM_ATTEMPTS; attempt += 1) {
    try {
      await createLifecycleLockDirectory({
        fileSystem, lockPath: reclaimPath, ownerPublication, platform, lockDownPath,
      });
      return Object.freeze({ state: "owned", ownerPublication, reclaimPath });
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw new Error("Relmio could not publish the local n8n operation reclaim claim.");
      }
    }
    const state = await reclaimStaleArbitrationLock({
      fileSystem,
      getProcessIdentity,
      graceMs,
      lockPath: reclaimPath,
      now,
      platform,
      lockDownPath,
    });
    if (state === "reclaimed" || state === "changed") continue;
    return Object.freeze({ state });
  }
  return Object.freeze({ state: "active" });
}

async function reclaimStaleLifecycleLock({
  fileSystem,
  getProcessIdentity,
  graceMs,
  lockPath,
  now,
  platform,
  selfIdentity,
  lockDownPath,
}) {
  const initial = await inspectLifecycleLockClaim({
    fileSystem, lockPath, platform, lockDownPath,
  });
  const initialState = await lifecycleLockClaimState(initial, { getProcessIdentity, now, platform, graceMs });
  if (initialState !== "stale") return initialState;
  const reclaim = await acquireLifecycleReclaimLock({
    fileSystem,
    getProcessIdentity,
    graceMs,
    lockPath,
    now,
    platform,
    selfIdentity,
    lockDownPath,
  });
  if (reclaim.state !== "owned") return reclaim.state;
  let quarantinePath = null;
  try {
    const current = await inspectLifecycleLockClaim({
      fileSystem, lockPath, platform, lockDownPath,
    });
    const currentState = await lifecycleLockClaimState(current, {
      getProcessIdentity, now, platform, graceMs,
    });
    if (!staleClaimStillMatches(initial, current, currentState)) {
      throw new Error("Relmio refuses to reclaim a replaced local n8n operation lock.");
    }
    const reclaimClaim = await inspectLifecycleLockClaim({
      fileSystem,
      lockPath: reclaim.reclaimPath,
      platform,
      lockDownPath,
    });
    if (
      reclaimClaim.kind !== "published" ||
      !sameLifecycleLockPublication(reclaimClaim.publication, reclaim.ownerPublication)
    ) throw new Error("Relmio refuses to reclaim without its exact arbitration claim.");
    quarantinePath = await detachLifecycleLock({ fileSystem, lockPath });
    if (!quarantinePath) return "changed";
    const detached = await inspectLifecycleLockClaim({
      fileSystem, lockPath: quarantinePath, platform, lockDownPath,
    });
    const detachedState = await lifecycleLockClaimState(detached, {
      getProcessIdentity, now, platform, graceMs,
    });
    if (!staleClaimStillMatches(initial, detached, detachedState)) {
      throw new Error("Relmio refuses to reclaim a replaced local n8n operation lock.");
    }
    await releaseLifecycleLock({
      fileSystem,
      lockPath: join(quarantinePath, LOCK_RECLAIM_DIRECTORY),
      ownerPublication: reclaim.ownerPublication,
      platform,
      lockDownPath,
    });
    await removeDetachedLifecycleLock({
      fileSystem, claim: detached, quarantinePath, platform, lockDownPath,
    });
    return "reclaimed";
  } catch (error) {
    if (quarantinePath) {
      await restoreDetachedLifecycleLock({ fileSystem, lockPath, quarantinePath });
    } else {
      try {
        await releaseLifecycleLock({
          fileSystem,
          lockPath: reclaim.reclaimPath,
          ownerPublication: reclaim.ownerPublication,
          platform,
          lockDownPath,
        });
      } catch { /* A changed arbitration claim must be preserved. */ }
    }
    if (error.message.startsWith("Relmio refuses")) throw error;
    throw new Error("Relmio could not safely reclaim the local n8n operation lock.");
  }
}

async function releaseLifecycleLock({
  fileSystem,
  lockPath,
  ownerPublication,
  platform,
  lockDownPath,
}) {
  const initial = await inspectLifecycleLockClaim({
    fileSystem, lockPath, platform, lockDownPath,
  });
  if (initial.kind !== "published" || !sameLifecycleLockPublication(initial.publication, ownerPublication)) {
    throw new Error("Relmio refuses to release a replaced local n8n operation lock.");
  }
  if (await lstatIfExists(fileSystem, join(lockPath, LOCK_RECLAIM_DIRECTORY))) {
    throw new Error("Relmio refuses to release a contended local n8n operation lock.");
  }
  const quarantinePath = await detachLifecycleLock({ fileSystem, lockPath });
  if (!quarantinePath) throw new Error("Relmio refuses to release a replaced local n8n operation lock.");
  try {
    const detached = await inspectLifecycleLockClaim({
      fileSystem, lockPath: quarantinePath, platform, lockDownPath,
    });
    if (
      detached.kind !== "published" ||
      !sameLifecycleLockPublication(detached.publication, ownerPublication) ||
      !claimsMatch(initial, detached) ||
      await lstatIfExists(fileSystem, join(quarantinePath, LOCK_RECLAIM_DIRECTORY))
    ) {
      throw new Error("Relmio refuses to release a replaced local n8n operation lock.");
    }
    await removeDetachedLifecycleLock({
      fileSystem, claim: detached, quarantinePath, platform, lockDownPath,
    });
  } catch (error) {
    await restoreDetachedLifecycleLock({ fileSystem, lockPath, quarantinePath });
    if (error.message.startsWith("Relmio refuses")) throw error;
    throw new Error("Relmio could not release the local n8n operation lock safely.");
  }
}

async function acquireLifecycleLock({
  fileSystem,
  getProcessIdentity = getLocalProcessIdentity,
  installRoot,
  now = Date.now,
  platform,
  lockDownPath = lockDownLocalPath,
}) {
  if (typeof getProcessIdentity !== "function" || typeof now !== "function") {
    throw new TypeError("The local n8n lifecycle lock adapter is invalid.");
  }
  const localRoot = await ensureManagedLocalRoot({
    fileSystem, installRoot, platform, lockDownPath,
  });
  const lockPath = join(localRoot, LOCK_DIRECTORY);
  let selfIdentity;
  try { selfIdentity = await getProcessIdentity(process.pid, { platform }); } catch { selfIdentity = null; }
  if (!validateLifecycleLockIdentity(selfIdentity) || selfIdentity.state !== "active") {
    throw new Error("Relmio could not verify this local n8n operation identity.");
  }
  const ownerPublication = Object.freeze({
    schemaVersion: LIFECYCLE_LOCK_SCHEMA_VERSION,
    pid: process.pid,
    processStartIdentity: selfIdentity.startIdentity,
    token: randomUUID(),
    publishedAtMs: lifecycleLockNow(now),
  });
  for (let attempt = 0; attempt < MAX_LIFECYCLE_LOCK_RECLAIM_ATTEMPTS; attempt += 1) {
    try {
      await createLifecycleLockDirectory({
        fileSystem,
        lockPath,
        ownerPublication,
        platform,
        lockDownPath,
      });
      return async () => releaseLifecycleLock({
        fileSystem, lockPath, ownerPublication, platform, lockDownPath,
      });
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw new Error("Relmio could not acquire the local n8n stack operation lock.");
      }
    }
    let reclaimState;
    try {
      reclaimState = await reclaimStaleLifecycleLock({
        fileSystem,
        getProcessIdentity,
        graceMs: LIFECYCLE_LOCK_PUBLICATION_GRACE_MS,
        lockPath,
        now,
        platform,
        selfIdentity,
        lockDownPath,
      });
    } catch (error) {
      if (error.message.startsWith("Relmio refuses")) throw error;
      throw new Error("Relmio could not safely inspect the local n8n operation lock.");
    }
    if (reclaimState === "reclaimed" || reclaimState === "changed") continue;
    if (reclaimState === "active" || reclaimState === "starting") {
      throw new Error("Another local n8n stack operation is already running.");
    }
    throw new Error("Relmio could not verify the existing local n8n stack operation lock.");
  }
  throw new Error("Another local n8n stack operation is already running.");
}

async function settleLifecycleOperation({ completionLabel, operation, releaseLock }) {
  let result;
  let operationError;
  try { result = await operation(); } catch (error) { operationError = error; }

  let releaseError;
  try { await releaseLock(); } catch (error) { releaseError = error; }

  if (operationError) {
    if (releaseError && operationError.cause === undefined) {
      try {
        Object.defineProperty(operationError, "cause", {
          configurable: true,
          value: releaseError,
        });
      } catch { /* Preserve the authoritative operation error unchanged. */ }
    }
    throw operationError;
  }
  if (releaseError) {
    throw Object.assign(new Error(
      `${completionLabel} completed, but Relmio could not release its operation lock. ` +
      "Restart Relmio before another local n8n stack action, then use the wizard to verify the owned stack.",
      { cause: releaseError },
    ), { code: LOCAL_N8N_LIFECYCLE_LOCK_RELEASE_ERROR_CODE });
  }
  return result;
}

function toSanitizedResult(marker) {
  return Object.freeze({
    kind: "local-n8n-stack",
    target: LOCAL_N8N_STACK_TARGET,
    localUrl: `http://127.0.0.1:${marker.n8nPort}`,
    ngrokPublicUrl: `https://${marker.ngrokHostname}`,
    projectName: marker.projectName,
    containerServices: getLocalN8nStackServiceNames(marker),
    networks: marker.assistantMode === "disabled" ? ["edge"] : ["edge", "assistant-shared", "assistant-internal"],
    assistantSettings: marker.assistantMode === "disabled" ? null : {
      sandboxUrl: "http://relmio-sandbox-api:8080",
      ...(marker.assistantMode === "sandbox-with-searxng" ? { searxngUrl: "http://relmio-searxng:8080" } : {}),
    },
    hostPublication: `n8n http://127.0.0.1:${marker.n8nPort}; ngrok inspector http://127.0.0.1:${marker.ngrokInspectorPort}`,
    deploymentMode: "new-disposable-stack",
    assistantMode: marker.assistantMode,
  });
}

export async function installLocalN8nStack({
  plan,
  secrets,
  publicExposureConfirmation,
  runProcess = runLocalProcess,
  fileSystem = defaultFileSystem,
  homeDirectory = homedir(),
  cwd = process.cwd(),
  env = process.env,
  platform = hostPlatform(),
  randomBytes = cryptoRandomBytes,
  processIdentity = getLocalProcessIdentity,
  now = Date.now,
  lockDownPath = lockDownLocalPath,
} = {}) {
  const safePlan = normalizeLocalN8nStackPlan(plan);
  if (publicExposureConfirmation !== LOCAL_N8N_STACK_PUBLIC_CONFIRMATION) {
    throw new Error("Exact public-exposure confirmation is required before creating a public ngrok endpoint.");
  }
  const safeSecrets = validateLocalN8nStackSecrets(secrets);
  const dockerHost = await resolveAttestedDockerHost({ runProcess, cwd, env, platform });
  if (dockerHost !== safePlan.dockerHost) throw new Error("The local Docker context changed. Create and confirm a fresh plan.");
  const installRoot = await resolveLocalN8nStackInstallRoot({ env, homeDirectory, fileSystem, platform });
  const releaseLock = await acquireLifecycleLock({
    fileSystem,
    getProcessIdentity: processIdentity,
    installRoot,
    now,
    platform,
    lockDownPath,
  });
  let installation;
  let filesCreated = false;
  let creationAttempted = false;
  return settleLifecycleOperation({
    completionLabel: "Local n8n stack installation",
    releaseLock,
    operation: async () => {
      try {
        installation = createLocalN8nStackInstallation({ plan: safePlan, randomBytes });
        await createManagedFiles({
          fileSystem,
          installRoot,
          installation,
          secrets: safeSecrets,
          randomBytes,
          platform,
          lockDownPath,
        });
        filesCreated = true;
        await validateComposeConfiguration(runProcess, {
          file: "docker",
          args: composeArgs(installation.marker, ["config", "--quiet"]),
          cwd: installRoot,
          dockerHost,
        });
        creationAttempted = true;
        await createStackWithCompose({
          runProcess,
          phase: "pull",
          spec: {
            file: "docker",
            args: composeArgs(installation.marker, ["pull"]),
            cwd: installRoot,
            dockerHost,
            timeoutMs: LOCAL_N8N_STACK_COMPOSE_PULL_TIMEOUT_MS,
          },
        });
        await createStackWithCompose({
          runProcess,
          phase: "start",
          spec: {
            file: "docker",
            args: composeArgs(installation.marker, [
              "up",
              "-d",
              "--wait",
              "--wait-timeout",
              String(LOCAL_N8N_STACK_COMPOSE_WAIT_TIMEOUT_SECONDS),
            ]),
            cwd: installRoot,
            dockerHost,
            timeoutMs: LOCAL_N8N_STACK_COMPOSE_UP_TIMEOUT_MS,
          },
        });
        try {
          await attestOwnedResources({ runProcess, cwd: installRoot, marker: installation.marker });
        } catch {
          throw createTypedStartupFailure(
            STACK_STARTUP_FAILURE_KINDS.OWNERSHIP_VERIFICATION,
            "Relmio could not verify the new stack's complete ownership metadata.",
          );
        }
        await verifyRunningStack({ runProcess, cwd: installRoot, marker: installation.marker });
        await verifySearxngSearch({
          runProcess,
          cwd: installRoot,
          marker: installation.marker,
        });
        return toSanitizedResult(installation.marker);
      } catch (error) {
        if (creationAttempted) {
          const cleanupState = await attemptOwnershipAttestedCleanup({
            runProcess,
            cwd: installRoot,
            marker: installation.marker,
          });
          if (cleanupState === "ownership-unconfirmed") {
            throw new Error("Local n8n stack startup failed and cleanup was not attempted because ownership could not be safely confirmed. Relmio preserved the managed files for inspection; existing n8n deployments were not changed.");
          }
          if (cleanupState === "cleanup-unconfirmed") {
            throw new Error("Local n8n stack startup failed after one ownership-attested cleanup attempt, but the final resource state could not be confirmed. Relmio preserved the managed files for safe inspection; existing n8n deployments were not changed.");
          }
          if (cleanupState === "resources-remain") {
            throw createManagedPartialStackError("Local n8n stack startup failed and a Relmio-managed partial stack remains. Inspect or remove it through Relmio before retrying; existing n8n deployments were not inspected or changed.");
          }
          try {
            await removeManagedFiles({ fileSystem, installRoot });
          } catch {
            throw new Error("Local n8n stack startup failed and its owned Docker resources were removed, but Relmio could not remove the managed files. Inspect the managed installation directory before retrying; existing n8n deployments were not changed.");
          }
          throw createRetryableStackStartupError(startupFailureKind(error));
        }
        if (filesCreated && !creationAttempted) await removeManagedFiles({ fileSystem, installRoot });
        throw preserveSafeInstallError(
          error,
          "Local n8n stack installation failed. Existing n8n deployments were not inspected or changed.",
        );
      }
    },
  });
}

export async function resumeLocalN8nStack({
  confirmed,
  runProcess = runLocalProcess,
  fileSystem = defaultFileSystem,
  homeDirectory = homedir(),
  cwd = process.cwd(),
  env = process.env,
  platform = hostPlatform(),
  processIdentity = getLocalProcessIdentity,
  now = Date.now,
  lockDownPath = lockDownLocalPath,
} = {}) {
  if (confirmed !== true) {
    throw new Error("Confirm resuming the managed local n8n stack.");
  }
  const installRoot = await resolveLocalN8nStackInstallRoot({ env, homeDirectory, fileSystem, platform });
  const releaseLock = await acquireLifecycleLock({
    fileSystem,
    getProcessIdentity: processIdentity,
    installRoot,
    now,
    platform,
    lockDownPath,
  });
  return settleLifecycleOperation({
    completionLabel: "Local n8n stack resume",
    releaseLock,
    operation: async () => {
      const marker = await readOwnedMarker({ fileSystem, installRoot });
      const dockerHost = await resolveAttestedDockerHost({ runProcess, cwd, env, platform });
      if (dockerHost !== marker.dockerHost) {
        throw new Error("The local Docker context changed. The owned stack was not started.");
      }
      const runtimeState = (await classifyOwnedStackRuntime({
        runProcess,
        cwd: installRoot,
        marker,
      })).state;
      if (runtimeState !== "stopped") {
        throw new Error(
          "Relmio can resume only an exact, ownership-attested stopped local n8n stack. No containers, volumes, or configuration were changed.",
        );
      }
      await verifyWindowsStatusPathSecurity({
        fileSystem,
        installRoot,
        marker,
        platform,
        lockDownPath,
      });
      await runOrThrow(runProcess, {
        file: "docker",
        // Compose start acts on the exact existing container names. It never
        // creates, recreates, or rebuilds a service, and it leaves volumes and
        // the generated configuration untouched.
        args: composeArgs(marker, ["start", ...runningStackServiceNames(marker)]),
        cwd: installRoot,
        dockerHost,
      }, "Local n8n stack resume");
      await attestOwnedResources({
        runProcess,
        cwd: installRoot,
        marker,
        resourcePolicy: "exact",
      });
      await verifyRunningStack({ runProcess, cwd: installRoot, marker });
      return Object.freeze({
        target: LOCAL_N8N_STACK_TARGET,
        resumed: true,
        deploymentMode: "resumed-owned-disposable-stack",
      });
    },
  });
}

export async function removeLocalN8nStack({
  confirmation,
  runProcess = runLocalProcess,
  fileSystem = defaultFileSystem,
  homeDirectory = homedir(),
  cwd = process.cwd(),
  env = process.env,
  platform = hostPlatform(),
  processIdentity = getLocalProcessIdentity,
  now = Date.now,
  lockDownPath = lockDownLocalPath,
} = {}) {
  if (confirmation !== LOCAL_N8N_STACK_REMOVE_CONFIRMATION) {
    throw new Error("Exact removal confirmation is required.");
  }
  const installRoot = await resolveLocalN8nStackInstallRoot({ env, homeDirectory, fileSystem, platform });
  const releaseLock = await acquireLifecycleLock({
    fileSystem,
    getProcessIdentity: processIdentity,
    installRoot,
    now,
    platform,
    lockDownPath,
  });
  return settleLifecycleOperation({
    completionLabel: "Local n8n stack removal",
    releaseLock,
    operation: async () => {
      const marker = await readOwnedMarker({ fileSystem, installRoot });
      const dockerHost = await resolveAttestedDockerHost({ runProcess, cwd, env, platform });
      if (dockerHost !== marker.dockerHost) throw new Error("The local Docker context changed. Nothing was removed.");
      await verifyWindowsStatusPathSecurity({
        fileSystem,
        installRoot,
        marker,
        platform,
        lockDownPath,
      });
      const cleanupState = await attemptOwnershipAttestedCleanup({ runProcess, cwd: installRoot, marker });
      if (cleanupState === "ownership-unconfirmed") {
        throw new Error("Local n8n removal was not attempted because ownership could not be safely confirmed. Managed files were preserved and unrelated n8n deployments were not changed.");
      }
      if (cleanupState === "cleanup-unconfirmed") {
        throw new Error("Local n8n removal was attempted once, but the final owned-resource state could not be confirmed. Managed files were preserved for safe inspection.");
      }
      if (cleanupState === "resources-remain") {
        throw createManagedPartialStackError("Relmio-managed local n8n resources remain after one removal attempt. Managed files were preserved so removal can be retried safely.");
      }
      await removeManagedFiles({ fileSystem, installRoot });
      return Object.freeze({ target: LOCAL_N8N_STACK_TARGET, removed: true, deploymentMode: "removed-owned-disposable-stack" });
    },
  });
}

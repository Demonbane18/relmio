import { randomBytes as createRandomBytes, randomUUID } from "node:crypto";
import * as defaultFileSystem from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import {
  createAssistantInstallation,
  getAssistantContainerNames,
  getAssistantManagedResourceNames,
  getAssistantServiceNames,
  validateAssistantInstallation,
} from "../domain/assistant.js";
import {
  ASSISTANT_COMPANION_IMAGES,
  createAssistantComposeFile,
  createAssistantEnv,
  createAssistantSecrets,
  createSearxngSettings,
} from "../domain/assistant-templates.js";
import {
  LOCAL_N8N_ASSISTANT_TARGET,
  normalizeLocalN8nAssistantPlan,
} from "../domain/local-n8n-assistant.js";
import { validateDockerObjectId } from "../domain/local-n8n-sidecar.js";
import {
  runLocalProcess,
  lockDownLocalPath,
  validateLocalDockerHost,
} from "../infrastructure/local-process.js";
import { discoverLocalN8nSidecarTargets } from "./local-n8n-sidecar-installer.js";
import { getLocalDockerStatus } from "./local-installer.js";
import {
  acquireLocalIntegrationLifecycleLock,
  settleLocalIntegrationLifecycleOperation,
} from "./local-integration-lifecycle-lock.js";

const COMPOSE_FILENAME = "docker-compose.yml";
const MANAGED_MARKER = ".managed-by-relmio.json";
const ROOT_MARKER = ".managed-by-relmio-root.json";
const MARKER_SCHEMA_VERSION = 1;
const ROOT_MARKER_SCHEMA_VERSION = 1;
const SEARXNG_UPDATE_REVIEW_SCHEMA_VERSION = 1;
const SEARXNG_UPDATE_REVIEW_KIND = "relmio-local-n8n-assistant-searxng-update";
const MAX_DOCKER_METADATA_BYTES = 1024 * 1024;
const DOCKER_SELECTION_VARIABLES = new Set([
  "BUILDKIT_HOST",
  "DOCKER_CERT_PATH",
  "DOCKER_CONFIG",
  "DOCKER_CONTEXT",
  "DOCKER_HOST",
  "DOCKER_TLS_VERIFY",
]);

function isMissing(error) {
  return error?.code === "ENOENT";
}

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
    if (
      DOCKER_SELECTION_VARIABLES.has(name.toUpperCase()) &&
      typeof value === "string" &&
      value !== ""
    ) {
      throw new Error(
        "Relmio local companions require the selected Docker context without a Docker environment override.",
      );
    }
  }
}

function validateAbsolutePath(value) {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    value.includes("\0") ||
    !isAbsolute(value)
  ) {
    throw new TypeError("Relmio local storage path is invalid.");
  }
  return resolve(value);
}

function validateManagedBase(value) {
  const resolved = validateAbsolutePath(value);
  if (basename(resolved) !== ".relmio") {
    throw new TypeError("Relmio local storage path is invalid.");
  }
  return resolved;
}

function validateInstallRoot(value) {
  const resolved = validateAbsolutePath(value);
  if (
    basename(resolved) !== LOCAL_N8N_ASSISTANT_TARGET ||
    basename(dirname(resolved)) !== "local" ||
    basename(resolve(resolved, "..", "..")) !== ".relmio"
  ) {
    throw new TypeError("The local n8n Assistant install directory is invalid.");
  }
  return resolved;
}

export async function resolveLocalN8nAssistantInstallRoot({
  env = process.env,
  homeDirectory = homedir(),
  fileSystem = defaultFileSystem,
  platform = process.platform,
} = {}) {
  assertSupportedPlatform(platform);
  const configuredHome =
    typeof env.RELMIO_HOME === "string" && env.RELMIO_HOME.trim() !== ""
      ? env.RELMIO_HOME
      : resolve(homeDirectory, ".relmio");
  const requestedHome = validateManagedBase(configuredHome);
  const requestedParent = dirname(requestedHome);
  let canonicalParent;
  try {
    canonicalParent = await fileSystem.realpath(requestedParent);
  } catch {
    throw new Error("The parent of the Relmio local storage directory is invalid.");
  }
  if (canonicalParent !== resolve(requestedParent)) {
    throw new Error(
      "Relmio refuses a local storage path with a symbolic-link ancestor.",
    );
  }
  return join(
    canonicalParent,
    ".relmio",
    "local",
    LOCAL_N8N_ASSISTANT_TARGET,
  );
}

function validateAssistantInventoryRecords(records, expectedServices) {
  const seen = new Set();
  for (const record of records) {
    if (
      typeof record?.Service !== "string" ||
      !expectedServices.includes(record.Service) ||
      seen.has(record.Service) ||
      typeof record.State !== "string" ||
      typeof record.Health !== "string" ||
      !Array.isArray(record.Publishers)
    ) {
      throw new Error("The local companion status metadata is invalid.");
    }
    seen.add(record.Service);
    for (const publisher of record.Publishers) {
      if (
        !publisher ||
        publisher.PublishedPort !== 0 ||
        publisher.URL !== ""
      ) {
        throw new Error("A local companion published a host port.");
      }
    }
  }
}

function runningAssistantHealthchecksAreHealthy(records) {
  return records.every((record) => {
    if (record.State !== "running") return true;
    if (record.Service === "relmio-sandbox-api") {
      return record.Health === "healthy";
    }
    return record.Health === "" || record.Health === "healthy";
  });
}

function localN8nAssistantSnapshot(installation) {
  return {
    target: "local-n8n-assistant",
    components: {
      codeSandbox: true,
      searxng: installation.includeSearxng,
    },
    auth: { sandboxConfigured: true, disclosure: "one-time" },
    canRemove: true,
  };
}

async function verifyWindowsAssistantStatusPathSecurity({
  fileSystem,
  installRoot,
  installation,
  platform,
  lockDownPath,
}) {
  if (platform !== "win32") return;
  const safeInstallation = validateAssistantInstallation(installation);
  const relmioHome = resolve(installRoot, "..", "..");
  for (const path of [relmioHome, join(relmioHome, "local"), installRoot]) {
    assertDirectory(await lstatIfExists(fileSystem, path));
    await lockDownPath(path, { platform, verifyOnly: true });
  }
  for (const path of [
    join(relmioHome, ROOT_MARKER),
    join(installRoot, MANAGED_MARKER),
    join(installRoot, COMPOSE_FILENAME),
    join(installRoot, ".env"),
    ...(safeInstallation.includeSearxng
      ? [join(installRoot, "searxng-settings.yml")]
      : []),
  ]) {
    const metadata = await lstatIfExists(fileSystem, path);
    if (!metadata?.isFile?.() || metadata.isSymbolicLink()) {
      throw new Error("Relmio refuses an unsafe local companion managed file.");
    }
    await lockDownPath(path, {
      platform,
      kind: "file",
      verifyOnly: true,
      verifyEffectiveOwnerOnly: true,
    });
  }
}

export async function getLocalN8nAssistantStatus({
  env = process.env,
  homeDirectory = homedir(),
  fileSystem = defaultFileSystem,
  runProcess = runLocalProcess,
  platform = process.platform,
  lockDownPath = lockDownLocalPath,
} = {}) {
  const target = "local-n8n-assistant";
  const absent = { target, managed: false, state: "absent" };
  const unavailable = { target, managed: false, state: "unavailable" };
  try {
    const installRoot = await resolveLocalN8nAssistantInstallRoot({
      env,
      homeDirectory,
      fileSystem,
      platform,
    });
    const managed = await inspectManagedInstall({ fileSystem, installRoot });
    if (!managed.marker) return absent;
    const { plan, installation } = validateMarker(managed.marker);
    await verifyWindowsAssistantStatusPathSecurity({
      fileSystem,
      installRoot,
      installation,
      platform,
      lockDownPath,
    });
    const docker = await getLocalDockerStatus({
      runProcess,
      cwd: installRoot,
      env,
      platform,
    });
    if (!docker.dockerAvailable || docker.dockerHost !== plan.dockerHost) {
      return unavailable;
    }
    await attestReviewedTarget({
      plan,
      runProcess,
      cwd: installRoot,
      env,
      platform,
    });
    const environment = await readCanonicalPrivateManagedFile({
      fileSystem,
      path: join(installRoot, ".env"),
      platform,
      lockDownPath,
      label: "private environment",
    });
    validateCanonicalAssistantEnv(environment.contents);
    const resources = await inspectOwnedProject({
      installation,
      runProcess,
      cwd: installRoot,
      dockerHost: plan.dockerHost,
      allowAbsent: true,
      allowPartial: true,
      returnDetails: true,
    });
    const snapshot = localN8nAssistantSnapshot(installation);
    if (!resources.exists || !resources.exact) {
      return { target, managed: true, state: "partial" };
    }
    const expectedServices = getAssistantServiceNames(installation).filter(
      (service) => service !== "relmio-sandbox-certs",
    );
    const status = await runOrThrow(
      runProcess,
      {
        file: "docker",
        args: createComposeArgs(installation.projectName, [
          "ps",
          "--all",
          "--format",
          "json",
          ...expectedServices,
        ]),
        cwd: installRoot,
        dockerHost: plan.dockerHost,
      },
      "Local companion inventory check",
    );
    const records = parseJsonRecords(status.stdout, "Local companion inventory check");
    validateAssistantInventoryRecords(records, expectedServices);
    if (records.length !== expectedServices.length) {
      return { target, managed: true, state: "partial", snapshot };
    }
    const states = records.map((record) => record.State);
    if (
      states.every((value) => value === "running") &&
      runningAssistantHealthchecksAreHealthy(records)
    ) {
      return { target, managed: true, state: "healthy", snapshot };
    }
    if (
      states.every((value) => ["created", "exited"].includes(value)) &&
      records.every((record) => !["starting", "unhealthy"].includes(record.Health))
    ) {
      return { target, managed: true, state: "stopped", snapshot };
    }
    return { target, managed: true, state: "partial" };
  } catch {
    return unavailable;
  }
}

async function lstatIfExists(fileSystem, path) {
  try {
    return await fileSystem.lstat(path);
  } catch (error) {
    if (isMissing(error)) return null;
    throw new Error("Relmio could not inspect its local managed directory.");
  }
}

function assertDirectory(metadata) {
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error("Relmio refuses an unsafe local managed directory.");
  }
}

async function ensurePrivateDirectory(fileSystem, path, platform, lockDownPath) {
  const metadata = await lstatIfExists(fileSystem, path);
  if (metadata) {
    assertDirectory(metadata);
  } else {
    await fileSystem.mkdir(path, { mode: 0o700 });
  }
  await fileSystem.chmod(path, 0o700);
  if (platform === "win32") await lockDownPath(path, { platform });
}

async function writeManagedFile(
  fileSystem,
  path,
  contents,
  mode,
  lockDownPath = lockDownLocalPath,
) {
  const existing = await lstatIfExists(fileSystem, path);
  if (existing && (existing.isSymbolicLink() || !existing.isFile())) {
    throw new Error("Relmio refuses to replace a non-file in its managed directory.");
  }
  const temporaryPath = `${path}.tmp-${randomUUID()}`;
  try {
    await fileSystem.writeFile(temporaryPath, contents, { flag: "wx", mode });
    await fileSystem.chmod(temporaryPath, mode);
    if (process.platform === "win32") {
      await lockDownPath(temporaryPath, {
        platform: process.platform,
        kind: "file",
      });
    }
    await fileSystem.rename(temporaryPath, path);
  } catch {
    try {
      await fileSystem.unlink(temporaryPath);
    } catch {
      // The temporary file may not have been created.
    }
    throw new Error("Relmio could not write its local n8n Assistant files.");
  }
}

function validateMarker(marker) {
  if (
    marker?.schemaVersion !== MARKER_SCHEMA_VERSION ||
    marker?.kind !== "relmio-local-n8n-assistant" ||
    marker?.target !== LOCAL_N8N_ASSISTANT_TARGET
  ) {
    throw new TypeError("The local n8n Assistant marker is invalid.");
  }
  const plan = normalizeLocalN8nAssistantPlan(marker.plan);
  const installation = validateAssistantInstallation(marker.installation);
  validateLocalDockerHost(plan.dockerHost);
  return { plan, installation };
}

function sameCanonicalValue(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function createSearxngUpdateReview({ plan, installation }) {
  if (installation.includeSearxng) {
    throw new Error("SearXNG web search is already enabled for this local n8n Assistant installation.");
  }
  return Object.freeze({
    schemaVersion: SEARXNG_UPDATE_REVIEW_SCHEMA_VERSION,
    kind: SEARXNG_UPDATE_REVIEW_KIND,
    target: LOCAL_N8N_ASSISTANT_TARGET,
    plan,
    installation,
    includeSearxng: true,
    sandboxApiKeyRotated: false,
  });
}

function validateSearxngUpdateReview(value) {
  const expectedKeys = [
    "schemaVersion",
    "kind",
    "target",
    "plan",
    "installation",
    "includeSearxng",
    "sandboxApiKeyRotated",
  ];
  if (
    !value || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).length !== expectedKeys.length ||
    expectedKeys.some((key) => !Object.hasOwn(value, key)) ||
    value.schemaVersion !== SEARXNG_UPDATE_REVIEW_SCHEMA_VERSION ||
    value.kind !== SEARXNG_UPDATE_REVIEW_KIND ||
    value.target !== LOCAL_N8N_ASSISTANT_TARGET ||
    value.includeSearxng !== true ||
    value.sandboxApiKeyRotated !== false
  ) {
    throw new TypeError("Review a fresh SearXNG enablement plan before updating the local n8n Assistant tools.");
  }
  const plan = normalizeLocalN8nAssistantPlan(value.plan);
  const installation = validateAssistantInstallation(value.installation);
  if (plan.includeSearxng || installation.includeSearxng) {
    throw new Error("SearXNG web search is already enabled for this local n8n Assistant installation.");
  }
  return createSearxngUpdateReview({ plan, installation });
}

async function inspectManagedInstall({ fileSystem, installRoot }) {
  const relmioHome = resolve(installRoot, "..", "..");
  const localRoot = join(relmioHome, "local");
  const homeMetadata = await lstatIfExists(fileSystem, relmioHome);
  if (!homeMetadata) return { baseExists: false, marker: null };
  assertDirectory(homeMetadata);

  const rootMarkerPath = join(relmioHome, ROOT_MARKER);
  const rootMarkerMetadata = await lstatIfExists(fileSystem, rootMarkerPath);
  if (
    !rootMarkerMetadata ||
    rootMarkerMetadata.isSymbolicLink() ||
    !rootMarkerMetadata.isFile()
  ) {
    throw new Error(
      "The Relmio local storage directory is not an owned managed root. Nothing was changed.",
    );
  }
  try {
    const rootMarker = JSON.parse(
      await fileSystem.readFile(rootMarkerPath, "utf8"),
    );
    if (
      rootMarker?.schemaVersion !== ROOT_MARKER_SCHEMA_VERSION ||
      rootMarker?.kind !== "relmio-local-root"
    ) {
      throw new TypeError();
    }
  } catch {
    throw new Error("The Relmio local managed-root marker is invalid.");
  }

  for (const path of [localRoot, installRoot]) {
    const metadata = await lstatIfExists(fileSystem, path);
    if (metadata) assertDirectory(metadata);
  }
  const installMetadata = await lstatIfExists(fileSystem, installRoot);
  if (!installMetadata) return { baseExists: true, marker: null };

  const markerPath = join(installRoot, MANAGED_MARKER);
  const markerMetadata = await lstatIfExists(fileSystem, markerPath);
  if (
    !markerMetadata ||
    markerMetadata.isSymbolicLink() ||
    !markerMetadata.isFile()
  ) {
    throw new Error(
      "The local n8n Assistant directory is unmanaged. Nothing was overwritten.",
    );
  }
  try {
    const marker = JSON.parse(await fileSystem.readFile(markerPath, "utf8"));
    validateMarker(marker);
    return { baseExists: true, marker };
  } catch {
    throw new Error("The local n8n Assistant managed marker is invalid.");
  }
}

async function initializeManagedDirectories({
  fileSystem,
  installRoot,
  baseExists,
  platform,
  lockDownPath,
}) {
  const relmioHome = resolve(installRoot, "..", "..");
  if (!baseExists) {
    let createdIdentity = null;
    try {
      await fileSystem.mkdir(relmioHome, { mode: 0o700 });
      createdIdentity = await captureFreshDirectoryIdentity(fileSystem, relmioHome);
      await fileSystem.chmod(relmioHome, 0o700);
      if (platform === "win32") await lockDownPath(relmioHome, { platform });
      await writeManagedFile(
        fileSystem,
        join(relmioHome, ROOT_MARKER),
        `${JSON.stringify({
          schemaVersion: ROOT_MARKER_SCHEMA_VERSION,
          kind: "relmio-local-root",
        })}\n`,
        0o600,
        lockDownPath,
      );
    } catch (error) {
      await removeFreshEmptyManagedRoot({
        fileSystem,
        relmioHome,
        createdIdentity,
      });
      throw error;
    }
  }
  await fileSystem.chmod(relmioHome, 0o700);
  if (platform === "win32") await lockDownPath(relmioHome, { platform });
  await ensurePrivateDirectory(fileSystem, join(relmioHome, "local"), platform, lockDownPath);
  await ensurePrivateDirectory(fileSystem, installRoot, platform, lockDownPath);
}

function privateFileFingerprint(metadata, contents) {
  return Object.freeze({
    dev: metadata.dev,
    ino: metadata.ino,
    size: metadata.size,
    mtimeMs: metadata.mtimeMs,
    ctimeMs: metadata.ctimeMs,
    contents,
  });
}

function samePrivateFileFingerprint(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs &&
    left.contents === right.contents
  );
}

async function readCanonicalPrivateManagedFile({
  fileSystem,
  path,
  expectedContents,
  platform,
  lockDownPath,
  label,
}) {
  let metadata = await lstatIfExists(fileSystem, path);
  if (!metadata || metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`The local n8n Assistant ${label} is missing or unsafe.`);
  }
  // `platform` may describe a synthetic Docker fixture in tests; filesystem
  // protection must always follow the host running Relmio.
  if (process.platform !== "win32" && (metadata.mode & 0o777) !== 0o600) {
    throw new Error(`The local n8n Assistant ${label} is not private.`);
  }
  if (process.platform === "win32") {
    await lockDownPath(path, { platform: process.platform, kind: "file", verifyOnly: true });
    metadata = await lstatIfExists(fileSystem, path);
    if (!metadata || metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error(`The local n8n Assistant ${label} changed during inspection.`);
    }
  }
  let contents;
  try {
    contents = await fileSystem.readFile(path, "utf8");
  } catch {
    throw new Error(`Relmio could not read the local n8n Assistant ${label}.`);
  }
  const afterRead = await lstatIfExists(fileSystem, path);
  if (!afterRead || afterRead.isSymbolicLink() || !afterRead.isFile()) {
    throw new Error(`The local n8n Assistant ${label} changed during inspection.`);
  }
  const before = privateFileFingerprint(metadata, contents);
  const after = privateFileFingerprint(afterRead, contents);
  if (!samePrivateFileFingerprint(before, after)) {
    throw new Error(`The local n8n Assistant ${label} changed during inspection.`);
  }
  if (expectedContents !== undefined && contents !== expectedContents) {
    throw new Error(`The local n8n Assistant ${label} is not the reviewed canonical file.`);
  }
  return before;
}

function validateCanonicalAssistantEnv(contents) {
  const fields = [
    "SANDBOX_API_KEYS",
    "SANDBOX_API_RUNNER_REGISTRATION_TOKEN",
    "SANDBOX_API_RUNNER_API_KEY",
    "SEARXNG_SECRET",
  ];
  const expression = new RegExp(
    `^${fields.map((field) => `${field}=([A-Za-z0-9_-]{43})`).join("\\n")}\\n$`,
    "u",
  );
  const match = expression.exec(contents);
  if (!match || new Set(match.slice(1)).size !== fields.length) {
    throw new Error("The local n8n Assistant private environment is not canonical.");
  }
}

async function assertNewManagedFileAbsent({ fileSystem, path, label }) {
  const metadata = await lstatIfExists(fileSystem, path);
  if (metadata) {
    throw new Error(`The local n8n Assistant ${label} already exists or changed. Nothing was overwritten.`);
  }
}

function isDirectoryIdentity(metadata, identity) {
  return (
    metadata !== null &&
    !metadata.isSymbolicLink() &&
    metadata.isDirectory() &&
    identity !== null &&
    metadata.dev === identity.dev &&
    metadata.ino === identity.ino
  );
}

async function captureFreshDirectoryIdentity(fileSystem, path) {
  const metadata = await lstatIfExists(fileSystem, path);
  if (!metadata || metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error("Relmio could not verify its newly created local storage directory.");
  }
  return { dev: metadata.dev, ino: metadata.ino };
}

async function removeFreshEmptyManagedRoot({
  fileSystem,
  relmioHome,
  createdIdentity,
}) {
  if (!createdIdentity) return;
  try {
    let metadata = await lstatIfExists(fileSystem, relmioHome);
    if (!isDirectoryIdentity(metadata, createdIdentity)) return;
    if ((await fileSystem.readdir(relmioHome)).length !== 0) return;
    metadata = await lstatIfExists(fileSystem, relmioHome);
    if (!isDirectoryIdentity(metadata, createdIdentity)) return;
    await fileSystem.rmdir(relmioHome);
  } catch {
    // Only an exact, still-empty root may be removed during recovery.
  }
}

async function acquireAssistantLock({
  fileSystem,
  getProcessIdentity,
  installRoot,
  lockDownPath,
  now,
  platform,
}) {
  const safeInstallRoot = validateInstallRoot(installRoot);
  const lockPath = join(
    dirname(resolve(safeInstallRoot, "..", "..")),
    ".relmio-local-n8n-ai-assistant.lock",
  );
  return acquireLocalIntegrationLifecycleLock({
    fileSystem,
    getProcessIdentity,
    lockDownPath,
    lockPath,
    now,
    // Process identity and ACL evidence must describe the host that is
    // actually running Relmio. `platform` can be a synthetic Docker fixture.
    platform: process.platform,
    label: "local n8n Assistant operation lock",
  });
}

async function runOrThrow(runProcess, spec, label) {
  const result = await runProcess(spec);
  if (result.code !== 0) throw new Error(`${label} failed.`);
  return result;
}

function parseJson(value, label) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value) > MAX_DOCKER_METADATA_BYTES
  ) {
    throw new Error(`${label} returned invalid Docker metadata.`);
  }
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${label} returned invalid Docker metadata.`);
  }
}

function parseJsonRecords(value, label) {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value) > MAX_DOCKER_METADATA_BYTES
  ) {
    throw new Error(`${label} returned invalid Docker metadata.`);
  }
  if (value.trim() === "") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return value.trim().split("\n").map((line) => parseJson(line, label));
  }
}

function parseLabels(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value;
  }
  if (typeof value !== "string") return null;
  const labels = {};
  for (const entry of value.split(",")) {
    const separator = entry.indexOf("=");
    if (separator <= 0) continue;
    labels[entry.slice(0, separator)] = entry.slice(separator + 1);
  }
  return labels;
}

function createComposeArgs(projectName, tail) {
  return [
    "compose",
    "--project-name",
    projectName,
    "--file",
    COMPOSE_FILENAME,
    ...tail,
  ];
}

async function attestReviewedTarget({
  plan,
  runProcess,
  cwd,
  env,
  platform,
}) {
  const discovery = await discoverLocalN8nSidecarTargets({
    runProcess,
    cwd,
    env,
    platform,
  });
  if (discovery.dockerHost !== plan.dockerHost) {
    throw new Error(
      "The selected Docker context changed. Review a fresh n8n Assistant plan.",
    );
  }
  const container = discovery.containers.find(
    (candidate) =>
      candidate.containerId === plan.n8nContainerId &&
      candidate.containerName === plan.n8nContainerName,
  );
  const network = container?.networks.find(
    (candidate) =>
      candidate.dockerNetworkId === plan.dockerNetworkId &&
      candidate.networkName === plan.networkName,
  );
  if (!container || !network) {
    const selected = await inspectSelectedNetwork({ plan, runProcess, cwd });
    if (
      selected?.Id === plan.dockerNetworkId &&
      selected?.Name === plan.networkName &&
      selected?.Internal === true
    ) {
      throw new Error(
        "The selected n8n Docker network has no outbound Internet access. Choose a non-internal Docker network and review a fresh plan.",
      );
    }
    throw new Error(
      "The selected n8n container or Docker network changed. Review a fresh plan.",
    );
  }
}

async function inspectSelectedNetwork({ plan, runProcess, cwd }) {
  const result = await runOrThrow(
    runProcess,
    {
      file: "docker",
      args: [
        "network",
        "inspect",
        "--format",
        "{{json .}}",
        plan.networkName,
      ],
      cwd,
      dockerHost: plan.dockerHost,
    },
    "Selected n8n network inspection",
  );
  return parseJson(result.stdout.trim(), "Selected n8n network inspection");
}

async function attestAliasesAreFree({
  plan,
  installation,
  runProcess,
  cwd,
}) {
  const network = await inspectSelectedNetwork({ plan, runProcess, cwd });
  if (network?.Id !== plan.dockerNetworkId || network?.Name !== plan.networkName) {
    throw new Error(
      "The selected n8n Docker network changed. Review a fresh plan.",
    );
  }
  if (network.Internal !== false) {
    throw new Error(
      "The selected n8n Docker network has no outbound Internet access. Choose a non-internal Docker network and review a fresh plan.",
    );
  }
  const reserved = new Set([
    installation.sandboxAlias,
    ...(installation.includeSearxng ? [installation.searxngAlias] : []),
  ]);
  const endpoints = network?.Containers;
  if (!endpoints || typeof endpoints !== "object" || Array.isArray(endpoints)) {
    throw new Error("The selected n8n Docker network metadata is invalid.");
  }
  for (const endpoint of Object.values(endpoints)) {
    const names = [
      endpoint?.Name,
      ...(Array.isArray(endpoint?.Aliases) ? endpoint.Aliases : []),
    ];
    if (names.some((name) => typeof name === "string" && reserved.has(name))) {
      throw new Error(
        "A generated n8n Assistant network alias has a collision. Nothing was changed.",
      );
    }
  }
}

async function listDockerResources({
  kind,
  filter,
  runProcess,
  cwd,
  dockerHost,
}) {
  const args = kind === "container"
    ? [
        "container",
        "ls",
        "-a",
        "--no-trunc",
        "--filter",
        filter,
        "--format",
        "{{json .}}",
      ]
    : [kind, "ls", "--filter", filter, "--format", "{{json .}}"];
  const result = await runOrThrow(
    runProcess,
    { file: "docker", args, cwd, dockerHost },
    `Docker ${kind} ownership inspection`,
  );
  return parseJsonRecords(result.stdout, `Docker ${kind} ownership inspection`);
}

async function attestNoResourceCollisions({
  installation,
  runProcess,
  cwd,
  dockerHost,
}) {
  const names = getAssistantManagedResourceNames(installation);
  for (const name of names.containers) {
    const records = await listDockerResources({
      kind: "container",
      filter: `name=^/${name}$`,
      runProcess,
      cwd,
      dockerHost,
    });
    if (records.length !== 0) {
      throw new Error("A Docker container uses the generated companion identity.");
    }
  }
  for (const [kind, name] of [
    ["network", names.network],
    ["volume", names.volume],
  ]) {
    const records = await listDockerResources({
      kind,
      filter: `name=^${name}$`,
      runProcess,
      cwd,
      dockerHost,
    });
    if (records.length !== 0) {
      throw new Error(`A Docker ${kind} uses the generated companion identity.`);
    }
  }
  for (const kind of ["container", "network", "volume"]) {
    const records = await listDockerResources({
      kind,
      filter: `label=com.docker.compose.project=${installation.projectName}`,
      runProcess,
      cwd,
      dockerHost,
    });
    if (records.length !== 0) {
      throw new Error("A Docker resource uses the generated companion project identity.");
    }
  }
}

function requireOwnedLabels(record, installation) {
  const labels = parseLabels(record?.Labels);
  if (
    !labels ||
    labels["com.docker.compose.project"] !== installation.projectName ||
    labels["io.relmio.ai-assistant.managed"] !== "true" ||
    labels["io.relmio.ai-assistant.install-id"] !== installation.installId
  ) {
    throw new Error(
      "A local companion Docker resource does not have matching Relmio ownership.",
    );
  }
}

async function inspectOwnedProject({
  installation,
  runProcess,
  cwd,
  dockerHost,
  allowAbsent = false,
  allowPartial = false,
  returnDetails = false,
}) {
  const expectedNames = getAssistantManagedResourceNames(installation);
  const resources = {
    containers: await listDockerResources({
      kind: "container",
      filter: `label=com.docker.compose.project=${installation.projectName}`,
      runProcess,
      cwd,
      dockerHost,
    }),
    networks: await listDockerResources({
      kind: "network",
      filter: `label=com.docker.compose.project=${installation.projectName}`,
      runProcess,
      cwd,
      dockerHost,
    }),
    volumes: await listDockerResources({
      kind: "volume",
      filter: `label=com.docker.compose.project=${installation.projectName}`,
      runProcess,
      cwd,
      dockerHost,
    }),
  };
  const count = Object.values(resources).reduce(
    (total, records) => total + records.length,
    0,
  );
  if (count === 0) {
    if (allowAbsent) {
      return returnDetails ? { exists: false, exact: false } : false;
    }
    throw new Error("The local companion Docker resource set is incomplete.");
  }
  for (const record of [
    ...resources.containers,
    ...resources.networks,
    ...resources.volumes,
  ]) {
    requireOwnedLabels(record, installation);
  }
  const containerNames = new Set(resources.containers.map((record) => record.Names));
  const exactResourceSet =
    resources.containers.length === expectedNames.containers.length &&
    resources.networks.length === 1 &&
    resources.volumes.length === 1 &&
    expectedNames.containers.every((name) => containerNames.has(name)) &&
    resources.networks[0]?.Name === expectedNames.network &&
    resources.volumes[0]?.Name === expectedNames.volume;
  if (!allowPartial && !exactResourceSet) {
    throw new Error("The local companion Docker resource set is incomplete.");
  }
  if (
    containerNames.size !== resources.containers.length ||
    [...containerNames].some((name) => !expectedNames.containers.includes(name)) ||
    resources.networks.length > 1 ||
    resources.networks.some((record) => record.Name !== expectedNames.network) ||
    resources.volumes.length > 1 ||
    resources.volumes.some((record) => record.Name !== expectedNames.volume)
  ) {
    throw new Error("The local companion Docker resource identity is invalid.");
  }
  return returnDetails ? { exists: true, exact: exactResourceSet } : true;
}

function assertNoPublishedPorts(records, expectedServices) {
  if (
    records.length !== expectedServices.length ||
    new Set(records.map((record) => record?.Service)).size !== records.length ||
    expectedServices.some(
      (service) => !records.some((record) => record?.Service === service),
    )
  ) {
    throw new Error(
      "The local companion host-publication service set is invalid.",
    );
  }
  for (const record of records) {
    const publishers = record?.Publishers;
    if (!Array.isArray(publishers)) {
      throw new Error("The local companion published-port metadata is invalid.");
    }
    for (const publisher of publishers) {
      if (
        !publisher ||
        !Number.isInteger(publisher.PublishedPort) ||
        typeof publisher.URL !== "string" ||
        publisher.PublishedPort < 0
      ) {
        throw new Error("The local companion published-port metadata is invalid.");
      }
      if (publisher.PublishedPort > 0 || publisher.URL !== "") {
        throw new Error("A local companion published a host port.");
      }
    }
  }
}

async function verifyRunningCompanions({
  plan,
  installation,
  runProcess,
  installRoot,
}) {
  await inspectOwnedProject({
    installation,
    runProcess,
    cwd: installRoot,
    dockerHost: plan.dockerHost,
  });
  const expectedServices = getAssistantServiceNames(installation).filter(
    (service) => service !== "relmio-sandbox-certs",
  );
  const running = await runOrThrow(
    runProcess,
    {
      file: "docker",
      args: createComposeArgs(installation.projectName, [
        "ps",
        "--status",
        "running",
        "--services",
      ]),
      cwd: installRoot,
      dockerHost: plan.dockerHost,
    },
    "Local companion running-service verification",
  );
  const runningServices = running.stdout.trim() === ""
    ? []
    : running.stdout.trim().split("\n").sort();
  if (
    runningServices.length !== expectedServices.length ||
    expectedServices.some((service) => !runningServices.includes(service))
  ) {
    throw new Error("The local companion service set is not running.");
  }
  const publication = await runOrThrow(
    runProcess,
    {
      file: "docker",
      args: createComposeArgs(installation.projectName, ["ps", "--format", "json"]),
      cwd: installRoot,
      dockerHost: plan.dockerHost,
    },
    "Local companion host-publication verification",
  );
  assertNoPublishedPorts(
    parseJsonRecords(publication.stdout, "Local companion host-publication verification"),
    expectedServices,
  );
  await runOrThrow(
    runProcess,
    {
      file: "docker",
      args: createComposeArgs(installation.projectName, [
        "exec",
        "-T",
        "relmio-sandbox-api",
        "wget",
        "-qO-",
        "http://127.0.0.1:8080/healthz",
      ]),
      cwd: installRoot,
      dockerHost: plan.dockerHost,
    },
    "Local Code Sandbox health verification",
  );
  if (installation.includeSearxng) {
    const search = await runOrThrow(
      runProcess,
      {
        file: "docker",
        args: createComposeArgs(installation.projectName, [
          "exec",
          "-T",
          "relmio-sandbox-api",
          "wget",
          "-qO-",
          `http://${installation.searxngAlias}:8080/search?q=relmio&format=json`,
        ]),
        cwd: installRoot,
        dockerHost: plan.dockerHost,
      },
      "Local SearXNG JSON verification",
    );
    let payload;
    try {
      payload = JSON.parse(search.stdout);
    } catch {
      throw new Error("The local SearXNG service did not return JSON.");
    }
    if (!Array.isArray(payload?.results)) {
      throw new Error("The local SearXNG service returned an invalid result.");
    }
  }
}

async function cleanupCompanionProject({
  installation,
  runProcess,
  installRoot,
  dockerHost,
}) {
  await runOrThrow(
    runProcess,
    {
      file: "docker",
      args: createComposeArgs(installation.projectName, [
        "down",
        "--volumes",
        "--remove-orphans",
      ]),
      cwd: installRoot,
      dockerHost,
    },
    "Local companion cleanup",
  );
  const remains = await inspectOwnedProject({
    installation,
    runProcess,
    cwd: installRoot,
    dockerHost,
    allowAbsent: true,
  });
  if (remains) {
    throw new Error("Relmio could not confirm local companion cleanup.");
  }
}

async function removeNewSearxngFile({
  fileSystem,
  path,
  expectedFingerprint,
  expectedContents,
  label,
}) {
  let metadata = await lstatIfExists(fileSystem, path);
  if (!metadata || metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(`The local n8n Assistant ${label} changed during rollback.`);
  }
  let contents;
  try {
    contents = await fileSystem.readFile(path, "utf8");
  } catch {
    throw new Error(`Relmio could not inspect the local n8n Assistant ${label} during rollback.`);
  }
  const afterRead = await lstatIfExists(fileSystem, path);
  if (!afterRead || afterRead.isSymbolicLink() || !afterRead.isFile()) {
    throw new Error(`The local n8n Assistant ${label} changed during rollback.`);
  }
  const current = privateFileFingerprint(afterRead, contents);
  if (
    contents !== expectedContents ||
    !samePrivateFileFingerprint(expectedFingerprint, current)
  ) {
    throw new Error(`The local n8n Assistant ${label} changed during rollback.`);
  }
  await fileSystem.unlink(path);
  metadata = await lstatIfExists(fileSystem, path);
  if (metadata) {
    throw new Error(`Relmio could not remove the local n8n Assistant ${label}.`);
  }
}

async function restoreCanonicalManagedFile({
  fileSystem,
  path,
  expectedCurrentContents,
  restoreContents,
  platform,
  lockDownPath,
  label,
}) {
  await readCanonicalPrivateManagedFile({
    fileSystem,
    path,
    expectedContents: expectedCurrentContents,
    platform,
    lockDownPath,
    label,
  });
  await writeManagedFile(
    fileSystem,
    path,
    restoreContents,
    0o600,
    lockDownPath,
  );
  await readCanonicalPrivateManagedFile({
    fileSystem,
    path,
    expectedContents: restoreContents,
    platform,
    lockDownPath,
    label,
  });
}

function createN8nSettings({ installation, secrets }) {
  const sandboxUrl = `http://${installation.sandboxAlias}:8080`;
  const settings = {
    N8N_INSTANCE_AI_SANDBOX_ENABLED: "true",
    N8N_INSTANCE_AI_SANDBOX_PROVIDER: "n8n-sandbox",
    N8N_INSTANCE_AI_SANDBOX_IMAGE: ASSISTANT_COMPANION_IMAGES.sandbox,
    N8N_SANDBOX_SERVICE_URL: sandboxUrl,
    N8N_SANDBOX_SERVICE_API_KEY: secrets.sandboxApiKey,
  };
  if (installation.includeSearxng) {
    settings.N8N_INSTANCE_AI_SEARXNG_URL =
      `http://${installation.searxngAlias}:8080`;
  }
  return settings;
}

function createSanitizedSearxngUpdateResult({ plan, installation }) {
  const sandboxUrl = `http://${installation.sandboxAlias}:8080`;
  const searxngUrl = `http://${installation.searxngAlias}:8080`;
  return Object.freeze({
    target: LOCAL_N8N_ASSISTANT_TARGET,
    endpoint: sandboxUrl,
    sandboxUrl,
    searxngUrl,
    protocol: "n8n-instance-ai-companion",
    includeSearxng: true,
    networkName: plan.networkName,
    n8nContainerName: plan.n8nContainerName,
    hostPublication: "none",
    privilegedRunner: true,
    n8nConfigurationRequired: true,
    n8nSettings: Object.freeze({
      N8N_INSTANCE_AI_SEARXNG_URL: searxngUrl,
    }),
    deploymentMode: "searxng-enabled",
    sandboxApiKeyRotated: false,
  });
}

export async function installLocalN8nAssistant(
  { plan, confirmed },
  {
    fileSystem = defaultFileSystem,
    env = process.env,
    homeDirectory = homedir(),
    runProcess = runLocalProcess,
    randomBytes = createRandomBytes,
    platform = process.platform,
    lockDownPath = lockDownLocalPath,
    getProcessIdentity,
    lifecycleLockNow = Date.now,
  } = {},
) {
  if (confirmed !== true) {
    throw new Error(
      "Confirm the reviewed privileged n8n Assistant companion plan before installing.",
    );
  }
  assertSupportedPlatform(platform);
  rejectDockerEnvironmentOverrides(env);
  const normalizedPlan = normalizeLocalN8nAssistantPlan(plan);
  const installRoot = await resolveLocalN8nAssistantInstallRoot({
    env,
    homeDirectory,
    fileSystem,
    platform,
  });
  const releaseLock = await acquireAssistantLock({
    fileSystem,
    getProcessIdentity,
    installRoot,
    lockDownPath,
    now: lifecycleLockNow,
    platform,
  });
  return settleLocalIntegrationLifecycleOperation({
    completionLabel: "Local n8n Assistant companion installation",
    releaseLock,
    operation: async () => {
      let installation;
      let managedDirectoryCreated = false;
      let deploymentStarted = false;
      try {
    const managed = await inspectManagedInstall({ fileSystem, installRoot });
    if (managed.marker) {
      throw new Error(
        "The managed local n8n Assistant tools are already installed. Remove them before installing a fresh companion stack.",
      );
    }
    const workingDirectory = dirname(resolve(installRoot, "..", ".."));
    await attestReviewedTarget({
      plan: normalizedPlan,
      runProcess,
      cwd: workingDirectory,
      env,
      platform,
    });
    installation = createAssistantInstallation({
      randomBytes,
      includeSearxng: normalizedPlan.includeSearxng,
    });
    const secrets = createAssistantSecrets({
      randomBytes,
      includeSearxng: normalizedPlan.includeSearxng,
    });
    await attestAliasesAreFree({
      plan: normalizedPlan,
      installation,
      runProcess,
      cwd: workingDirectory,
    });
    await attestNoResourceCollisions({
      installation,
      runProcess,
      cwd: workingDirectory,
      dockerHost: normalizedPlan.dockerHost,
    });
    await initializeManagedDirectories({
      fileSystem,
      installRoot,
      baseExists: managed.baseExists,
      platform,
      lockDownPath,
    });
    managedDirectoryCreated = true;
    await writeManagedFile(
      fileSystem,
      join(installRoot, COMPOSE_FILENAME),
      createAssistantComposeFile({
        networkName: normalizedPlan.networkName,
        installation,
      }),
      0o600,
      lockDownPath,
    );
    await writeManagedFile(
      fileSystem,
      join(installRoot, ".env"),
      createAssistantEnv(secrets, {
        includeSearxng: normalizedPlan.includeSearxng,
      }),
      0o600,
      lockDownPath,
    );
    if (normalizedPlan.includeSearxng) {
      await writeManagedFile(
        fileSystem,
        join(installRoot, "searxng-settings.yml"),
        createSearxngSettings(),
        0o600,
        lockDownPath,
      );
    }
    await writeManagedFile(
      fileSystem,
      join(installRoot, MANAGED_MARKER),
      `${JSON.stringify({
        schemaVersion: MARKER_SCHEMA_VERSION,
        kind: "relmio-local-n8n-assistant",
        target: LOCAL_N8N_ASSISTANT_TARGET,
        plan: normalizedPlan,
        installation,
      })}\n`,
      0o600,
      lockDownPath,
    );
    await runOrThrow(
      runProcess,
      {
        file: "docker",
        args: createComposeArgs(installation.projectName, ["config", "--quiet"]),
        cwd: installRoot,
        dockerHost: normalizedPlan.dockerHost,
      },
      "Local n8n Assistant Compose validation",
    );
    await attestReviewedTarget({
      plan: normalizedPlan,
      runProcess,
      cwd: installRoot,
      env,
      platform,
    });
    await attestAliasesAreFree({
      plan: normalizedPlan,
      installation,
      runProcess,
      cwd: installRoot,
    });
    await attestNoResourceCollisions({
      installation,
      runProcess,
      cwd: installRoot,
      dockerHost: normalizedPlan.dockerHost,
    });

    deploymentStarted = true;
    await runOrThrow(
      runProcess,
      {
        file: "docker",
        args: createComposeArgs(installation.projectName, [
          "up",
          "-d",
          "--wait",
          "--wait-timeout",
          "90",
          ...getAssistantServiceNames(installation),
        ]),
        cwd: installRoot,
        dockerHost: normalizedPlan.dockerHost,
      },
      "Local n8n Assistant companion start",
    );
    await verifyRunningCompanions({
      plan: normalizedPlan,
      installation,
      runProcess,
      installRoot,
    });
    const n8nSettings = createN8nSettings({ installation, secrets });
    return {
      target: LOCAL_N8N_ASSISTANT_TARGET,
      endpoint: n8nSettings.N8N_SANDBOX_SERVICE_URL,
      sandboxUrl: n8nSettings.N8N_SANDBOX_SERVICE_URL,
      sandboxApiKey: secrets.sandboxApiKey,
      ...(installation.includeSearxng
        ? { searxngUrl: n8nSettings.N8N_INSTANCE_AI_SEARXNG_URL }
        : {}),
      protocol: "n8n-instance-ai-companion",
      includeSearxng: installation.includeSearxng,
      networkName: normalizedPlan.networkName,
      n8nContainerName: normalizedPlan.n8nContainerName,
      hostPublication: "none",
      privilegedRunner: true,
      n8nConfigurationRequired: true,
      n8nSettings,
      deploymentMode: "installed",
      credentialShownOnce: true,
    };
      } catch (error) {
    if (deploymentStarted && installation) {
      try {
        const resourcesExist = await inspectOwnedProject({
          installation,
          runProcess,
          cwd: installRoot,
          dockerHost: normalizedPlan.dockerHost,
          allowAbsent: true,
          allowPartial: true,
        });
        if (resourcesExist) {
          await cleanupCompanionProject({
            installation,
            runProcess,
            installRoot,
            dockerHost: normalizedPlan.dockerHost,
          });
        }
      } catch {
        throw new Error(
          "Local companion verification failed and automatic cleanup could not be confirmed. Inspect only the Relmio n8n Assistant project before retrying.",
        );
      }
    }
    if (managedDirectoryCreated) {
      try {
        await fileSystem.rm(installRoot, { recursive: true, force: false });
      } catch {
        throw new Error(
          "Local companion installation failed and managed-file cleanup could not be confirmed.",
        );
      }
    }
        throw error;
      }
    },
  });
}

/**
 * Read the identity of an existing SearXNG-free local Assistant installation
 * for a separately confirmed additive update. This changes neither Docker nor
 * the private environment.
 */
export async function prepareLocalN8nAssistantSearxngUpdate(
  { includeSearxng },
  {
    fileSystem = defaultFileSystem,
    env = process.env,
    homeDirectory = homedir(),
    platform = process.platform,
  } = {},
) {
  if (includeSearxng !== true) {
    throw new Error("This local n8n Assistant edit can only enable SearXNG web search.");
  }
  assertSupportedPlatform(platform);
  rejectDockerEnvironmentOverrides(env);
  const installRoot = await resolveLocalN8nAssistantInstallRoot({
    env,
    homeDirectory,
    fileSystem,
    platform,
  });
  const managed = await inspectManagedInstall({ fileSystem, installRoot });
  if (!managed.marker) {
    throw new Error("The managed local n8n Assistant tools are not installed.");
  }
  return createSearxngUpdateReview(validateMarker(managed.marker));
}

async function attestSearxngIdentityIsFree({
  plan,
  installation,
  runProcess,
  cwd,
}) {
  const network = await inspectSelectedNetwork({ plan, runProcess, cwd });
  if (
    network?.Id !== plan.dockerNetworkId ||
    network?.Name !== plan.networkName ||
    network?.Internal !== false ||
    !network.Containers ||
    typeof network.Containers !== "object" ||
    Array.isArray(network.Containers)
  ) {
    throw new Error("The selected n8n Docker network changed. Review a fresh SearXNG enablement plan.");
  }
  for (const endpoint of Object.values(network.Containers)) {
    const aliases = Array.isArray(endpoint?.Aliases) ? endpoint.Aliases : [];
    if (endpoint?.Name === installation.searxngAlias || aliases.includes(installation.searxngAlias)) {
      throw new Error("The generated SearXNG network alias is already in use. Nothing was changed.");
    }
  }
  const names = getAssistantContainerNames(installation);
  const containers = await listDockerResources({
    kind: "container",
    filter: `name=^/${names.searxng}$`,
    runProcess,
    cwd,
    dockerHost: plan.dockerHost,
  });
  if (containers.length !== 0) {
    throw new Error("A Docker container uses the generated SearXNG identity. Nothing was changed.");
  }
}

async function rollbackSearxngEnablement({
  fileSystem,
  installRoot,
  lockDownPath,
  newCompose,
  newInstallation,
  oldCompose,
  oldEnv,
  oldInstallation,
  oldMarkerContents,
  oldPlan,
  platform,
  runProcess,
  searxngSettingsFingerprint,
  searxngStartAttempted,
}) {
  if (searxngStartAttempted) {
    const names = getAssistantContainerNames(newInstallation);
    const containers = await listDockerResources({
      kind: "container",
      filter: `name=^/${names.searxng}$`,
      runProcess,
      cwd: installRoot,
      dockerHost: oldPlan.dockerHost,
    });
    if (containers.length > 1) {
      throw new Error("The local SearXNG rollback identity is ambiguous.");
    }
    if (containers.length === 1) {
      const [container] = containers;
      const labels = parseLabels(container?.Labels);
      const containerId = validateDockerObjectId(
        container?.ID,
        "local SearXNG container",
      );
      if (
        container?.Names !== names.searxng ||
        labels?.["com.docker.compose.project"] !== oldInstallation.projectName ||
        labels?.["com.docker.compose.service"] !== "relmio-searxng" ||
        labels?.["io.relmio.ai-assistant.managed"] !== "true" ||
        labels?.["io.relmio.ai-assistant.install-id"] !== oldInstallation.installId
      ) {
        throw new Error("The local SearXNG rollback ownership could not be verified.");
      }
      await runOrThrow(
        runProcess,
        {
          file: "docker",
          args: ["container", "rm", "--force", containerId],
          cwd: installRoot,
          dockerHost: oldPlan.dockerHost,
        },
        "Local SearXNG rollback",
      );
    }
  }
  await inspectOwnedProject({
    installation: oldInstallation,
    runProcess,
    cwd: installRoot,
    dockerHost: oldPlan.dockerHost,
  });
  await restoreCanonicalManagedFile({
    fileSystem,
    path: join(installRoot, COMPOSE_FILENAME),
    expectedCurrentContents: newCompose,
    restoreContents: oldCompose,
    platform,
    lockDownPath,
    label: "Compose file",
  });
  await removeNewSearxngFile({
    fileSystem,
    path: join(installRoot, "searxng-settings.yml"),
    expectedFingerprint: searxngSettingsFingerprint,
    expectedContents: createSearxngSettings(),
    label: "SearXNG settings file",
  });
  const environment = await readCanonicalPrivateManagedFile({
    fileSystem,
    path: join(installRoot, ".env"),
    expectedContents: oldEnv,
    platform,
    lockDownPath,
    label: "private environment",
  });
  validateCanonicalAssistantEnv(environment.contents);
  await readCanonicalPrivateManagedFile({
    fileSystem,
    path: join(installRoot, MANAGED_MARKER),
    expectedContents: oldMarkerContents,
    platform,
    lockDownPath,
    label: "managed marker",
  });
  await verifyRunningCompanions({
    plan: oldPlan,
    installation: oldInstallation,
    runProcess,
    installRoot,
  });
}

/**
 * Enable SearXNG for one exact reviewed local Assistant installation. The
 * sandbox environment and credential are never written or returned here.
 */
export async function editLocalN8nAssistantSearxng(
  { review, confirmed },
  {
    fileSystem = defaultFileSystem,
    env = process.env,
    homeDirectory = homedir(),
    runProcess = runLocalProcess,
    platform = process.platform,
    lockDownPath = lockDownLocalPath,
    getProcessIdentity,
    lifecycleLockNow = Date.now,
  } = {},
) {
  if (confirmed !== true) {
    throw new Error("Confirm enabling SearXNG web search for the reviewed local n8n Assistant installation.");
  }
  assertSupportedPlatform(platform);
  rejectDockerEnvironmentOverrides(env);
  const reviewed = validateSearxngUpdateReview(review);
  const installRoot = await resolveLocalN8nAssistantInstallRoot({
    env,
    homeDirectory,
    fileSystem,
    platform,
  });
  const releaseLock = await acquireAssistantLock({
    fileSystem,
    getProcessIdentity,
    installRoot,
    lockDownPath,
    now: lifecycleLockNow,
    platform,
  });
  return settleLocalIntegrationLifecycleOperation({
    completionLabel: "Local n8n Assistant SearXNG enablement",
    releaseLock,
    operation: async () => {
      const managed = await inspectManagedInstall({ fileSystem, installRoot });
      if (!managed.marker) {
        throw new Error("The managed local n8n Assistant tools are not installed.");
      }
      const { plan: oldPlan, installation: oldInstallation } = validateMarker(managed.marker);
      if (
        !sameCanonicalValue(reviewed.plan, oldPlan) ||
        !sameCanonicalValue(reviewed.installation, oldInstallation)
      ) {
        throw new Error("The local n8n Assistant installation changed after review. Review a fresh SearXNG enablement plan.");
      }
      if (oldPlan.includeSearxng || oldInstallation.includeSearxng) {
        throw new Error("SearXNG web search is already enabled for this local n8n Assistant installation.");
      }
      await verifyWindowsAssistantStatusPathSecurity({
        fileSystem,
        installRoot,
        installation: oldInstallation,
        platform,
        lockDownPath,
      });
      const newPlan = normalizeLocalN8nAssistantPlan({ ...oldPlan, includeSearxng: true });
      const newInstallation = validateAssistantInstallation({
        ...oldInstallation,
        includeSearxng: true,
      });
      const oldCompose = createAssistantComposeFile({
        networkName: oldPlan.networkName,
        installation: oldInstallation,
      });
      const newCompose = createAssistantComposeFile({
        networkName: newPlan.networkName,
        installation: newInstallation,
      });
      const oldMarkerContents = `${JSON.stringify(managed.marker)}\n`;
      const workingDirectory = dirname(resolve(installRoot, "..", ".."));
      await readCanonicalPrivateManagedFile({
        fileSystem,
        path: join(installRoot, MANAGED_MARKER),
        expectedContents: oldMarkerContents,
        platform,
        lockDownPath,
        label: "managed marker",
      });
      await readCanonicalPrivateManagedFile({
        fileSystem,
        path: join(installRoot, COMPOSE_FILENAME),
        expectedContents: oldCompose,
        platform,
        lockDownPath,
        label: "Compose file",
      });
      const environment = await readCanonicalPrivateManagedFile({
        fileSystem,
        path: join(installRoot, ".env"),
        platform,
        lockDownPath,
        label: "private environment",
      });
      const oldEnv = environment.contents;
      validateCanonicalAssistantEnv(oldEnv);
      await assertNewManagedFileAbsent({
        fileSystem,
        path: join(installRoot, "searxng-settings.yml"),
        label: "SearXNG settings file",
      });
      await attestReviewedTarget({
        plan: oldPlan,
        runProcess,
        cwd: workingDirectory,
        env,
        platform,
      });
      await verifyRunningCompanions({
        plan: oldPlan,
        installation: oldInstallation,
        runProcess,
        installRoot,
      });
      await attestSearxngIdentityIsFree({
        plan: oldPlan,
        installation: newInstallation,
        runProcess,
        cwd: installRoot,
      });

      let searxngSettingsFingerprint = null;
      let composeChanged = false;
      let searxngStartAttempted = false;
      try {
        await writeManagedFile(
          fileSystem,
          join(installRoot, "searxng-settings.yml"),
          createSearxngSettings(),
          0o600,
          lockDownPath,
        );
        searxngSettingsFingerprint = await readCanonicalPrivateManagedFile({
          fileSystem,
          path: join(installRoot, "searxng-settings.yml"),
          expectedContents: createSearxngSettings(),
          platform,
          lockDownPath,
          label: "SearXNG settings file",
        });
        await writeManagedFile(
          fileSystem,
          join(installRoot, COMPOSE_FILENAME),
          newCompose,
          0o600,
          lockDownPath,
        );
        composeChanged = true;
        searxngStartAttempted = true;
        await runOrThrow(
          runProcess,
          {
            file: "docker",
            args: createComposeArgs(newInstallation.projectName, ["config", "--quiet"]),
            cwd: installRoot,
            dockerHost: newPlan.dockerHost,
          },
          "Local n8n Assistant SearXNG Compose validation",
        );
        await attestReviewedTarget({
          plan: oldPlan,
          runProcess,
          cwd: installRoot,
          env,
          platform,
        });
        await verifyRunningCompanions({
          plan: oldPlan,
          installation: oldInstallation,
          runProcess,
          installRoot,
        });
        await attestSearxngIdentityIsFree({
          plan: oldPlan,
          installation: newInstallation,
          runProcess,
          cwd: installRoot,
        });
        await runOrThrow(
          runProcess,
          {
            file: "docker",
            args: createComposeArgs(newInstallation.projectName, [
              "up", "-d", "--wait", "--wait-timeout", "90", "--no-deps", "relmio-searxng",
            ]),
            cwd: installRoot,
            dockerHost: newPlan.dockerHost,
          },
          "Local SearXNG start",
        );
        await verifyRunningCompanions({
          plan: newPlan,
          installation: newInstallation,
          runProcess,
          installRoot,
        });
        const unchangedEnvironment = await readCanonicalPrivateManagedFile({
          fileSystem,
          path: join(installRoot, ".env"),
          expectedContents: oldEnv,
          platform,
          lockDownPath,
          label: "private environment",
        });
        validateCanonicalAssistantEnv(unchangedEnvironment.contents);
        await writeManagedFile(
          fileSystem,
          join(installRoot, MANAGED_MARKER),
          `${JSON.stringify({
            schemaVersion: MARKER_SCHEMA_VERSION,
            kind: "relmio-local-n8n-assistant",
            target: LOCAL_N8N_ASSISTANT_TARGET,
            plan: newPlan,
            installation: newInstallation,
          })}\n`,
          0o600,
          lockDownPath,
        );
        return createSanitizedSearxngUpdateResult({ plan: newPlan, installation: newInstallation });
      } catch (error) {
        if (!searxngSettingsFingerprint) {
          throw new Error(
            "Local SearXNG enablement failed and the new settings file could not be safely inspected for rollback. Inspect only the Relmio n8n Assistant project before retrying.",
          );
        }
        try {
          if (!composeChanged) {
            await removeNewSearxngFile({
              fileSystem,
              path: join(installRoot, "searxng-settings.yml"),
              expectedFingerprint: searxngSettingsFingerprint,
              expectedContents: createSearxngSettings(),
              label: "SearXNG settings file",
            });
            const environment = await readCanonicalPrivateManagedFile({
              fileSystem,
              path: join(installRoot, ".env"),
              expectedContents: oldEnv,
              platform,
              lockDownPath,
              label: "private environment",
            });
            validateCanonicalAssistantEnv(environment.contents);
            await readCanonicalPrivateManagedFile({
              fileSystem,
              path: join(installRoot, MANAGED_MARKER),
              expectedContents: oldMarkerContents,
              platform,
              lockDownPath,
              label: "managed marker",
            });
          } else {
            await rollbackSearxngEnablement({
              fileSystem,
              installRoot,
              lockDownPath,
              newCompose,
              newInstallation,
              oldCompose,
              oldEnv,
              oldInstallation,
              oldMarkerContents,
              oldPlan,
              platform,
              runProcess,
              searxngSettingsFingerprint,
              searxngStartAttempted,
            });
          }
        } catch {
          throw new Error(
            "Local SearXNG enablement failed and rollback could not be confirmed. Inspect only the Relmio n8n Assistant project before retrying.",
          );
        }
        throw error;
      }
    },
  });
}

export async function removeLocalN8nAssistant(
  { confirmed },
  {
    fileSystem = defaultFileSystem,
    env = process.env,
    homeDirectory = homedir(),
    runProcess = runLocalProcess,
    platform = process.platform,
    lockDownPath = lockDownLocalPath,
    getProcessIdentity,
    lifecycleLockNow = Date.now,
  } = {},
) {
  if (confirmed !== true) {
    throw new Error("Confirm removal of the managed local n8n Assistant tools.");
  }
  assertSupportedPlatform(platform);
  rejectDockerEnvironmentOverrides(env);
  const installRoot = await resolveLocalN8nAssistantInstallRoot({
    env,
    homeDirectory,
    fileSystem,
    platform,
  });
  const releaseLock = await acquireAssistantLock({
    fileSystem,
    getProcessIdentity,
    installRoot,
    lockDownPath,
    now: lifecycleLockNow,
    platform,
  });
  return settleLocalIntegrationLifecycleOperation({
    completionLabel: "Local n8n Assistant companion removal",
    releaseLock,
    operation: async () => {
    const managed = await inspectManagedInstall({ fileSystem, installRoot });
    if (!managed.marker) {
      throw new Error("The managed local n8n Assistant tools are not installed.");
    }
    const { plan, installation } = validateMarker(managed.marker);
    await verifyWindowsAssistantStatusPathSecurity({
      fileSystem,
      installRoot,
      installation,
      platform,
      lockDownPath,
    });
    await inspectOwnedProject({
      installation,
      runProcess,
      cwd: installRoot,
      dockerHost: plan.dockerHost,
    });
    await cleanupCompanionProject({
      installation,
      runProcess,
      installRoot,
      dockerHost: plan.dockerHost,
    });
    await fileSystem.rm(installRoot, { recursive: true, force: false });
      return { target: LOCAL_N8N_ASSISTANT_TARGET, removed: true };
    },
  });
}

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
  validateLocalN8nStackSecrets,
} from "../templates/local-n8n-stack/index.js";
import { runLocalProcess, validateLocalDockerHost } from "../infrastructure/local-process.js";

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
const MAX_DOCKER_METADATA_BYTES = 1024 * 1024;
const DOCKER_SELECTION_VARIABLES = new Set([
  "BUILDKIT_HOST", "DOCKER_CERT_PATH", "DOCKER_CONFIG", "DOCKER_CONTEXT",
  "DOCKER_HOST", "DOCKER_TLS_VERIFY",
]);

function assertSupportedPlatform(platform) {
  if (platform === "win32") {
    throw new Error("Local n8n + ngrok is supported only on macOS, Linux, or WSL2.");
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

async function ensureDirectory(fileSystem, path) {
  const metadata = await lstatIfExists(fileSystem, path);
  if (metadata) assertPrivateDirectory(metadata, "local n8n managed directory");
  else await fileSystem.mkdir(path, { mode: 0o700 });
  await fileSystem.chmod(path, 0o700);
}

async function writePrivateFile(fileSystem, path, contents, mode) {
  const existing = await lstatIfExists(fileSystem, path);
  if (existing) {
    throw new Error("Relmio refuses to overwrite a local n8n managed file.");
  }
  const temporary = `${path}.tmp-${randomUUID()}`;
  try {
    await fileSystem.writeFile(temporary, contents, { flag: "wx", mode });
    await fileSystem.chmod(temporary, mode);
    await fileSystem.rename(temporary, path);
    await fileSystem.chmod(path, mode);
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
  try {
    return validateLocalDockerHost(JSON.parse(result.stdout.trim()), { platform });
  } catch {
    throw new Error("The selected Docker context is not a local Docker Unix socket.");
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

function parseJsonLines(value, label) {
  if (typeof value !== "string" || Buffer.byteLength(value) > MAX_DOCKER_METADATA_BYTES) {
    throw new Error(`${label} returned invalid Docker metadata.`);
  }
  if (value.trim() === "") return [];
  try { return value.trim().split("\n").map((line) => JSON.parse(line)); } catch {
    throw new Error(`${label} returned invalid Docker metadata.`);
  }
}

function parseLabelString(value) {
  if (typeof value !== "string" || value.length > 16 * 1024) return null;
  const parsed = {};
  for (const part of value.split(",")) {
    const index = part.indexOf("=");
    if (index < 1 || !part.slice(0, index) || !part.slice(index + 1)) return null;
    parsed[part.slice(0, index)] = part.slice(index + 1);
  }
  return parsed;
}

function labelsAreOwned(labels, marker) {
  const expected = getLocalN8nStackLabels(marker);
  return labels && Object.entries(expected).every(([key, value]) => labels[key] === value);
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
    const labels = parseLabelString(row?.Labels);
    const name = typeof row?.Names === "string" ? row.Names : row?.Name;
    if (!labelsAreOwned(labels, marker) || !expectedNames.has(name) || seen.has(name)) {
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
    file: "docker", args: ["ps", "--all", "--no-trunc", "--filter", projectFilter, "--format", "{{json .}}"], cwd, dockerHost: marker.dockerHost,
  }, "Local n8n container ownership check");
  const containerRows = parseJsonLines(containers.stdout, "Local n8n container ownership check");
  assertExactOrOwnedSubset({
    rows: containerRows,
    expectedNames: new Set(expected.containers),
    marker,
    kind: "container",
    resourcePolicy,
  });
  for (const [commandKind, kind] of [["network", "network"], ["volume", "volume"]]) {
    const result = await runOrThrow(runProcess, {
      file: "docker", args: [commandKind, "ls", "--filter", projectFilter, "--format", "{{json .}}"], cwd, dockerHost: marker.dockerHost,
    }, `Local n8n ${kind} ownership check`);
    const rows = parseJsonLines(result.stdout, `Local n8n ${kind} ownership check`);
    assertExactOrOwnedSubset({
      rows,
      expectedNames: new Set(expected[`${kind}s`]),
      marker,
      kind,
      resourcePolicy,
    });
  }
}

async function assertOwnedProjectAbsent({ runProcess, cwd, marker }) {
  const projectFilter = `label=com.docker.compose.project=${marker.projectName}`;
  for (const [command, label] of [
    [["ps", "--all", "--no-trunc", "--filter", projectFilter, "--format", "{{json .}}"], "container"],
    [["network", "ls", "--filter", projectFilter, "--format", "{{json .}}"], "network"],
    [["volume", "ls", "--filter", projectFilter, "--format", "{{json .}}"], "volume"],
  ]) {
    const result = await runOrThrow(runProcess, {
      file: "docker", args: command, cwd, dockerHost: marker.dockerHost,
    }, `Local n8n ${label} absence check`);
    if (parseJsonLines(result.stdout, `Local n8n ${label} absence check`).length !== 0) {
      throw new Error("Relmio could not confirm that the owned local n8n stack was removed.");
    }
  }
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

async function verifyRunningStack({ runProcess, cwd, marker }) {
  const services = getLocalN8nStackServiceNames(marker).filter(
    (service) => service !== "relmio-sandbox-certs",
  );
  const running = await runOrThrow(runProcess, {
    file: "docker", args: composeArgs(marker, ["ps", "--status", "running", "--services"]), cwd, dockerHost: marker.dockerHost,
  }, "Local n8n readiness check");
  const actual = new Set(running.stdout.split(/\s+/u).filter(Boolean));
  if (actual.size !== services.length || services.some((service) => !actual.has(service))) {
    throw new Error("The owned local n8n stack did not reach the running state.");
  }
  for (const service of services) {
    const result = await runOrThrow(runProcess, {
      file: "docker", args: composeArgs(marker, ["ps", "--format", "json", service]), cwd, dockerHost: marker.dockerHost,
    }, "Local n8n service verification");
    const rows = parseJsonLines(result.stdout, "Local n8n service verification");
    if (rows.length !== 1 || rows[0]?.Service !== service || rows[0]?.State !== "running") {
      throw new Error("The owned local n8n service state could not be verified.");
    }
    if (
      (service === "n8n" || service === "ngrok" || service === "relmio-sandbox-api") &&
      rows[0]?.Health !== "healthy"
    ) {
      throw new Error("The owned local n8n service health could not be verified.");
    }
    if (service === "n8n") validatePublication(rows[0], { hostPort: marker.n8nPort, targetPort: 5678, requirePublication: true });
    else if (service === "ngrok") validatePublication(rows[0], { hostPort: marker.ngrokInspectorPort, targetPort: 4040, requirePublication: true });
    else if (!isUnpublishedAssistantService(rows[0]?.Publishers)) {
      throw new Error("An Assistant service published an unexpected host port.");
    }
  }
}

function isUnpublishedAssistantService(publishers) {
  if (!Array.isArray(publishers)) return false;
  return publishers.length === 0 || (
    publishers.length === 1 &&
    publishers[0] &&
    publishers[0].PublishedPort === 0 &&
    publishers[0].URL === "" &&
    Number.isInteger(publishers[0].TargetPort) &&
    publishers[0].TargetPort > 0 &&
    publishers[0].Protocol === "tcp"
  );
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

async function ensureManagedLocalRoot({ fileSystem, installRoot }) {
  const relmioRoot = resolve(installRoot, "..", "..");
  const localRoot = join(relmioRoot, LOCAL_DIRECTORY);
  const rootMarkerPath = join(relmioRoot, ROOT_MARKER);
  let rootCreated = false;
  let localCreated = false;
  try {
    const rootMetadata = await lstatIfExists(fileSystem, relmioRoot);
    if (rootMetadata) {
      assertPrivateDirectory(rootMetadata, "Relmio local storage directory");
      const rootMarker = await lstatIfExists(fileSystem, rootMarkerPath);
      if (!rootMarker?.isFile?.() || rootMarker.isSymbolicLink()) {
        throw new Error("The Relmio local storage directory is not an owned managed root. Nothing was changed.");
      }
      try {
        const parsed = JSON.parse(await fileSystem.readFile(rootMarkerPath, "utf8"));
        if (parsed?.schemaVersion !== 1 || parsed?.kind !== "relmio-local-root") throw new Error("mismatch");
      } catch {
        throw new Error("The Relmio local storage directory is not an owned managed root. Nothing was changed.");
      }
    } else {
      await fileSystem.mkdir(relmioRoot, { mode: 0o700 });
      rootCreated = true;
      await fileSystem.chmod(relmioRoot, 0o700);
      await writePrivateFile(fileSystem, rootMarkerPath, `${JSON.stringify({ schemaVersion: 1, kind: "relmio-local-root" })}\n`, 0o600);
    }
    const localMetadata = await lstatIfExists(fileSystem, localRoot);
    if (localMetadata) assertPrivateDirectory(localMetadata, "local n8n managed directory");
    else {
      await fileSystem.mkdir(localRoot, { mode: 0o700 });
      localCreated = true;
    }
    await fileSystem.chmod(localRoot, 0o700);
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

async function createManagedFiles({ fileSystem, installRoot, installation, secrets, randomBytes }) {
  const existingInstall = await lstatIfExists(fileSystem, installRoot);
  if (existingInstall) throw new Error("A local n8n stack directory already exists. Nothing was overwritten.");
  await ensureManagedLocalRoot({ fileSystem, installRoot });
  let installDirectoryCreated = false;
  try {
    await fileSystem.mkdir(installRoot, { mode: 0o700 });
    installDirectoryCreated = true;
    await fileSystem.chmod(installRoot, 0o700);
    await ensureDirectory(fileSystem, join(installRoot, RUNTIME_DIRECTORY));
    const n8nKey = randomBytes(32);
    if (!Buffer.isBuffer(n8nKey) || n8nKey.length !== 32) throw new TypeError("A cryptographic local n8n secret generator is required.");
    const assistantSecrets = installation.assistantMode === "disabled"
      ? null : createAssistantSecrets({ randomBytes, includeSearxng: installation.assistantMode === "sandbox-with-searxng" });
    const runtimeSecrets = { n8nEncryptionKey: n8nKey.toString("hex"), ...assistantSecrets };
    await writePrivateFile(fileSystem, join(installRoot, MARKER), `${JSON.stringify(installation.marker)}\n`, 0o600);
    await writePrivateFile(fileSystem, join(installRoot, ENV_FILE), createLocalN8nStackEnv({ installation, secrets, runtimeSecrets }), 0o600);
    await writePrivateFile(fileSystem, join(installRoot, COMPOSE_FILE), createLocalN8nStackComposeFile({ installation }), 0o600);
    await writePrivateFile(fileSystem, join(installRoot, "ngrok.yml"), createNgrokConfig(), 0o644);
    await writePrivateFile(fileSystem, join(installRoot, RUNTIME_DIRECTORY, TRAFFIC_POLICY), createNgrokTrafficPolicy({ username: secrets.basicAuthUsername, password: secrets.basicAuthPassword }), 0o600);
    if (installation.assistantMode === "sandbox-with-searxng") {
      await writePrivateFile(fileSystem, join(installRoot, RUNTIME_DIRECTORY, "searxng-settings.yml"), createSearxngSettings(), 0o644);
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

async function acquireLifecycleLock({ fileSystem, installRoot }) {
  const localRoot = await ensureManagedLocalRoot({ fileSystem, installRoot });
  const lockPath = join(localRoot, LOCK_DIRECTORY);
  const ownerPath = join(lockPath, LOCK_OWNER_FILE);
  const ownerToken = randomUUID();
  let lockCreated = false;
  try {
    await fileSystem.mkdir(lockPath, { mode: 0o700 });
    lockCreated = true;
    await fileSystem.chmod(lockPath, 0o700);
    await writePrivateFile(
      fileSystem,
      ownerPath,
      `${JSON.stringify({ schemaVersion: 1, token: ownerToken })}\n`,
      0o600,
    );
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new Error("Another local n8n stack operation is already running.");
    }
    if (lockCreated) {
      try { await fileSystem.unlink(ownerPath); } catch { /* owner may not exist */ }
      try { await fileSystem.rmdir(lockPath); } catch { /* preserve unexpected state */ }
    }
    throw new Error("Relmio could not acquire the local n8n stack operation lock.");
  }
  return async () => {
    const metadata = await lstatIfExists(fileSystem, lockPath);
    assertPrivateDirectory(metadata, "local n8n operation lock");
    const ownerMetadata = await lstatIfExists(fileSystem, ownerPath);
    if (!ownerMetadata?.isFile?.() || ownerMetadata.isSymbolicLink()) {
      throw new Error("Relmio refuses to release a replaced local n8n operation lock.");
    }
    let owner;
    try { owner = JSON.parse(await fileSystem.readFile(ownerPath, "utf8")); } catch {
      throw new Error("Relmio refuses to release a replaced local n8n operation lock.");
    }
    if (owner?.schemaVersion !== 1 || owner?.token !== ownerToken) {
      throw new Error("Relmio refuses to release a replaced local n8n operation lock.");
    }
    await fileSystem.unlink(ownerPath);
    await fileSystem.rmdir(lockPath);
  };
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
} = {}) {
  const safePlan = normalizeLocalN8nStackPlan(plan);
  if (publicExposureConfirmation !== LOCAL_N8N_STACK_PUBLIC_CONFIRMATION) {
    throw new Error("Exact public-exposure confirmation is required before creating a public ngrok endpoint.");
  }
  const safeSecrets = validateLocalN8nStackSecrets(secrets);
  const dockerHost = await resolveAttestedDockerHost({ runProcess, cwd, env, platform });
  if (dockerHost !== safePlan.dockerHost) throw new Error("The local Docker context changed. Create and confirm a fresh plan.");
  const installRoot = await resolveLocalN8nStackInstallRoot({ env, homeDirectory, fileSystem, platform });
  const releaseLock = await acquireLifecycleLock({ fileSystem, installRoot });
  let installation;
  let filesCreated = false;
  let creationAttempted = false;
  try {
    installation = createLocalN8nStackInstallation({ plan: safePlan, randomBytes });
    await createManagedFiles({ fileSystem, installRoot, installation, secrets: safeSecrets, randomBytes });
    filesCreated = true;
    await runOrThrow(runProcess, { file: "docker", args: composeArgs(installation.marker, ["config", "--quiet"]), cwd: installRoot, dockerHost }, "Local n8n Compose validation");
    creationAttempted = true;
    await runOrThrow(runProcess, { file: "docker", args: composeArgs(installation.marker, ["up", "-d", "--wait", "--wait-timeout", "90"]), cwd: installRoot, dockerHost }, "Local n8n stack creation");
    await attestOwnedResources({ runProcess, cwd: installRoot, marker: installation.marker });
    await verifyRunningStack({ runProcess, cwd: installRoot, marker: installation.marker });
    return toSanitizedResult(installation.marker);
  } catch (error) {
    if (creationAttempted) {
      try {
        await attestOwnedResources({ runProcess, cwd: installRoot, marker: installation.marker, resourcePolicy: "subset" });
        await runOrThrow(runProcess, { file: "docker", args: composeArgs(installation.marker, ["down", "--volumes", "--remove-orphans"]), cwd: installRoot, dockerHost }, "Owned local n8n rollback");
        await assertOwnedProjectAbsent({ runProcess, cwd: installRoot, marker: installation.marker });
        await removeManagedFiles({ fileSystem, installRoot });
      } catch {
        throw new Error("Local n8n stack verification failed and ownership-attested rollback could not be confirmed. Do not use the endpoint until its owned state is inspected.");
      }
    }
    if (filesCreated && !creationAttempted) await removeManagedFiles({ fileSystem, installRoot });
    throw new Error("Local n8n stack installation failed. Existing n8n deployments were not inspected or changed.");
  } finally {
    await releaseLock();
  }
}

export async function removeLocalN8nStack({
  confirmation,
  runProcess = runLocalProcess,
  fileSystem = defaultFileSystem,
  homeDirectory = homedir(),
  cwd = process.cwd(),
  env = process.env,
  platform = hostPlatform(),
} = {}) {
  if (confirmation !== LOCAL_N8N_STACK_REMOVE_CONFIRMATION) {
    throw new Error("Exact removal confirmation is required.");
  }
  const installRoot = await resolveLocalN8nStackInstallRoot({ env, homeDirectory, fileSystem, platform });
  const releaseLock = await acquireLifecycleLock({ fileSystem, installRoot });
  try {
    const marker = await readOwnedMarker({ fileSystem, installRoot });
    const dockerHost = await resolveAttestedDockerHost({ runProcess, cwd, env, platform });
    if (dockerHost !== marker.dockerHost) throw new Error("The local Docker context changed. Nothing was removed.");
    await attestOwnedResources({ runProcess, cwd: installRoot, marker });
    await runOrThrow(runProcess, { file: "docker", args: composeArgs(marker, ["down", "--volumes", "--remove-orphans"]), cwd: installRoot, dockerHost }, "Owned local n8n removal");
    await assertOwnedProjectAbsent({ runProcess, cwd: installRoot, marker });
    await removeManagedFiles({ fileSystem, installRoot });
    return Object.freeze({ target: LOCAL_N8N_STACK_TARGET, removed: true, deploymentMode: "removed-owned-disposable-stack" });
  } finally {
    await releaseLock();
  }
}

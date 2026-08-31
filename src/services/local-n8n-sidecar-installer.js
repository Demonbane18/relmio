import { randomBytes as createRandomBytes, randomUUID } from "node:crypto";
import * as defaultFileSystem from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import {
  LOCAL_N8N_SIDECAR_ENDPOINT,
  LOCAL_N8N_SIDECAR_HOSTNAME,
  LOCAL_N8N_SIDECAR_TARGET,
  createLocalN8nSidecarComposeFile,
  createLocalN8nSidecarDockerfile,
  createLocalN8nSidecarDockerignore,
  normalizeLocalN8nSidecarPlan,
  validateDockerObjectId,
} from "../domain/local-n8n-sidecar.js";
import { validateDockerName } from "../domain/validation.js";
import {
  runLocalProcess,
  validateLocalDockerHost,
} from "../infrastructure/local-process.js";
import { readAuthContents, resolveAuthPath } from "./oauth.js";

const COMPOSE_FILENAME = "docker-compose.yml";
const MANAGED_MARKER = ".managed-by-relmio.json";
const ROOT_MARKER = ".managed-by-relmio-root.json";
const ROOT_MARKER_SCHEMA_VERSION = 1;
const MARKER_SCHEMA_VERSION = 1;
const PROJECT_PREFIX = "relmio-n8n-openai-oauth";
const SERVICE_NAME = "openai-oauth";
const MAX_DISCOVERED_CONTAINERS = 100;
const MAX_DOCKER_METADATA_BYTES = 1024 * 1024;
const DOCKER_SELECTION_VARIABLES = new Set([
  "BUILDKIT_HOST",
  "DOCKER_CERT_PATH",
  "DOCKER_CONFIG",
  "DOCKER_CONTEXT",
  "DOCKER_HOST",
  "DOCKER_TLS_VERIFY",
]);
const OFFICIAL_N8N_IMAGE = /^(?:(?:(?:docker\.n8n\.io|docker\.io)\/)?n8nio\/n8n)(?::[A-Za-z0-9_.-]{1,128})?(?:@sha256:[a-f0-9]{64})?$/u;
const VERIFIER_SCRIPT = [
  'const headers={Authorization:"Bearer local-only"};',
  'Promise.all([fetch("http://n8n-openai-oauth:10531/health"),',
  'fetch("http://n8n-openai-oauth:10531/v1/models",{headers})])',
  '.then(async([health,models])=>{if(!health.ok||!models.ok)process.exit(1);',
  'process.stdout.write(JSON.stringify(await models.json()));})',
  '.catch(()=>process.exit(1));',
].join("");

function isMissing(error) {
  return error?.code === "ENOENT";
}

function assertSupportedPlatform(platform) {
  if (platform === "win32") {
    throw new Error(
      "Local Docker sidecars are not supported on native Windows in this release.",
    );
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
        "Relmio local sidecars require the selected Docker context without a Docker environment override.",
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
    basename(resolved) !== LOCAL_N8N_SIDECAR_TARGET ||
    basename(dirname(resolved)) !== "local" ||
    basename(resolve(resolved, "..", "..")) !== ".relmio"
  ) {
    throw new TypeError("The local n8n sidecar install directory is invalid.");
  }
  return resolved;
}

export async function resolveLocalN8nSidecarInstallRoot({
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
  return join(canonicalParent, ".relmio", "local", LOCAL_N8N_SIDECAR_TARGET);
}

async function resolveLocalDockerHost({ runProcess, cwd, env, platform }) {
  assertSupportedPlatform(platform);
  rejectDockerEnvironmentOverrides(env);
  const context = await runProcess({
    file: "docker",
    args: [
      "context",
      "inspect",
      "--format",
      "{{json .Endpoints.docker.Host}}",
    ],
    cwd,
  });
  if (context.code !== 0) {
    throw new Error("The selected Docker context could not be inspected.");
  }
  let candidate;
  try {
    candidate = JSON.parse(context.stdout.trim());
  } catch {
    throw new Error("The selected Docker context is not a local Docker daemon.");
  }
  try {
    return validateLocalDockerHost(candidate, { platform });
  } catch {
    throw new Error("The selected Docker context is not a local Docker daemon.");
  }
}

async function runOrThrow(runProcess, spec, label) {
  const result = await runProcess(spec);
  if (result.code !== 0) {
    throw new Error(`${label} failed.`);
  }
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

function parseJsonLines(value, label) {
  if (typeof value !== "string" || Buffer.byteLength(value) > MAX_DOCKER_METADATA_BYTES) {
    throw new Error(`${label} returned invalid Docker metadata.`);
  }
  if (value.trim() === "") {
    return [];
  }
  return value
    .trim()
    .split("\n")
    .map((line) => parseJson(line, label));
}

function validateVersion(value, label) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!/^[A-Za-z0-9.+-]{1,64}$/u.test(normalized)) {
    throw new Error(`${label} returned an invalid version.`);
  }
  return normalized;
}

function isOfficialN8nImage(value) {
  return typeof value === "string" && OFFICIAL_N8N_IMAGE.test(value);
}

function parseContainerName(value) {
  const normalized = typeof value === "string" && value.startsWith("/")
    ? value.slice(1)
    : value;
  return validateDockerName(normalized);
}

async function inspectContainer({ runProcess, cwd, dockerHost, containerId }) {
  const result = await runOrThrow(
    runProcess,
    {
      file: "docker",
      args: ["container", "inspect", "--format", "{{json .}}", containerId],
      cwd,
      dockerHost,
    },
    "Docker container inspection",
  );
  return parseJson(result.stdout.trim(), "Docker container inspection");
}

async function inspectNetwork({ runProcess, cwd, dockerHost, networkName }) {
  const result = await runOrThrow(
    runProcess,
    {
      file: "docker",
      args: ["network", "inspect", "--format", "{{json .}}", networkName],
      cwd,
      dockerHost,
    },
    "Docker network inspection",
  );
  return parseJson(result.stdout.trim(), "Docker network inspection");
}

function validateDiscoveredN8nContainer(inspected) {
  const containerId = validateDockerObjectId(inspected?.Id, "n8n container");
  const containerName = parseContainerName(inspected?.Name);
  const image = inspected?.Config?.Image;
  if (!isOfficialN8nImage(image) || inspected?.State?.Running !== true) {
    throw new Error("The selected container is not a running official n8n container.");
  }
  if (
    !inspected.NetworkSettings?.Networks ||
    typeof inspected.NetworkSettings.Networks !== "object" ||
    Array.isArray(inspected.NetworkSettings.Networks)
  ) {
    throw new Error("The selected n8n container network metadata is invalid.");
  }
  return { containerId, containerName, image };
}

function validateSelectedNetwork(inspected, { n8nContainerId, expectedName }) {
  const dockerNetworkId = validateDockerObjectId(
    inspected?.Id,
    "Docker network",
  );
  const networkName = validateDockerName(inspected?.Name);
  if (
    networkName !== expectedName ||
    inspected?.Driver !== "bridge" ||
    inspected?.Scope !== "local" ||
    !inspected?.Containers ||
    typeof inspected.Containers !== "object" ||
    Array.isArray(inspected.Containers) ||
    !Object.prototype.hasOwnProperty.call(inspected.Containers, n8nContainerId)
  ) {
    throw new Error("The selected n8n Docker network is invalid.");
  }
  const labels = inspected.Labels;
  return {
    dockerNetworkId,
    networkName,
    disposable:
      labels &&
      typeof labels === "object" &&
      labels["com.relmio.disposable"] === "true",
  };
}

export async function discoverLocalN8nSidecarTargets({
  runProcess = runLocalProcess,
  cwd = process.cwd(),
  env = process.env,
  platform = process.platform,
} = {}) {
  const dockerHost = await resolveLocalDockerHost({
    runProcess,
    cwd,
    env,
    platform,
  });
  const docker = await runOrThrow(
    runProcess,
    {
      file: "docker",
      args: ["version", "--format", "{{.Server.Version}}"],
      cwd,
      dockerHost,
    },
    "Docker version check",
  );
  const compose = await runOrThrow(
    runProcess,
    {
      file: "docker",
      args: ["compose", "version", "--short"],
      cwd,
      dockerHost,
    },
    "Docker Compose version check",
  );
  const listed = await runOrThrow(
    runProcess,
    {
      file: "docker",
      args: ["ps", "--filter", "status=running", "--format", "{{json .}}"],
      cwd,
      dockerHost,
    },
    "n8n container discovery",
  );
  const candidates = parseJsonLines(listed.stdout, "n8n container discovery")
    .filter((entry) => isOfficialN8nImage(entry?.Image))
    .slice(0, MAX_DISCOVERED_CONTAINERS);
  const containers = [];
  for (const candidate of candidates) {
    if (typeof candidate?.ID !== "string" || !/^[a-f0-9]{12,64}$/u.test(candidate.ID)) {
      continue;
    }
    const inspected = await inspectContainer({
      runProcess,
      cwd,
      dockerHost,
      containerId: candidate.ID,
    });
    const container = validateDiscoveredN8nContainer(inspected);
    const networks = [];
    for (const networkName of Object.keys(inspected.NetworkSettings.Networks)) {
      let safeNetworkName;
      try {
        safeNetworkName = validateDockerName(networkName);
      } catch {
        continue;
      }
      if (["bridge", "host", "none"].includes(safeNetworkName)) {
        continue;
      }
      const network = await inspectNetwork({
        runProcess,
        cwd,
        dockerHost,
        networkName: safeNetworkName,
      });
      try {
        networks.push(
          validateSelectedNetwork(network, {
            n8nContainerId: container.containerId,
            expectedName: safeNetworkName,
          }),
        );
      } catch {
        // Discovery omits networks that cannot safely host the private sidecar.
      }
    }
    if (networks.length > 0) {
      containers.push({ ...container, networks });
    }
  }
  return {
    dockerAvailable: true,
    dockerVersion: validateVersion(docker.stdout, "Docker"),
    composeVersion: validateVersion(compose.stdout, "Docker Compose"),
    dockerHost,
    containers,
  };
}

async function lstatIfExists(fileSystem, path) {
  try {
    return await fileSystem.lstat(path);
  } catch (error) {
    if (isMissing(error)) {
      return null;
    }
    throw new Error("Relmio could not inspect its local managed directory.");
  }
}

function assertDirectory(metadata) {
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error("Relmio refuses an unsafe local managed directory.");
  }
}

async function writeManagedFile(fileSystem, path, contents, mode) {
  const existing = await lstatIfExists(fileSystem, path);
  if (existing && (existing.isSymbolicLink() || !existing.isFile())) {
    throw new Error("Relmio refuses to replace a non-file in its managed directory.");
  }
  const temporaryPath = `${path}.tmp-${randomUUID()}`;
  try {
    await fileSystem.writeFile(temporaryPath, contents, { flag: "wx", mode });
    await fileSystem.chmod(temporaryPath, mode);
    await fileSystem.rename(temporaryPath, path);
    await fileSystem.chmod(path, mode);
  } catch {
    try {
      await fileSystem.unlink(temporaryPath);
    } catch {
      // The temporary file may not have been created.
    }
    throw new Error("Relmio could not write its local n8n sidecar files.");
  }
}

async function ensurePrivateDirectory(fileSystem, path) {
  const metadata = await lstatIfExists(fileSystem, path);
  if (metadata) {
    assertDirectory(metadata);
  } else {
    await fileSystem.mkdir(path, { mode: 0o700 });
  }
  await fileSystem.chmod(path, 0o700);
}

async function inspectManagedInstall({ fileSystem, installRoot }) {
  const relmioHome = resolve(installRoot, "..", "..");
  const localRoot = join(relmioHome, "local");
  const homeMetadata = await lstatIfExists(fileSystem, relmioHome);
  if (!homeMetadata) {
    return { baseExists: false, marker: null, deploymentMode: "installed" };
  }
  assertDirectory(homeMetadata);
  const rootMarkerMetadata = await lstatIfExists(
    fileSystem,
    join(relmioHome, ROOT_MARKER),
  );
  if (
    !rootMarkerMetadata ||
    rootMarkerMetadata.isSymbolicLink() ||
    !rootMarkerMetadata.isFile()
  ) {
    throw new Error(
      "The Relmio local storage directory is not an owned managed root. Nothing was changed.",
    );
  }
  let rootMarker;
  try {
    rootMarker = JSON.parse(
      await fileSystem.readFile(join(relmioHome, ROOT_MARKER), "utf8"),
    );
  } catch {
    throw new Error("The Relmio local managed-root marker is invalid.");
  }
  if (
    rootMarker?.schemaVersion !== ROOT_MARKER_SCHEMA_VERSION ||
    rootMarker?.kind !== "relmio-local-root"
  ) {
    throw new Error("The Relmio local managed-root marker is invalid.");
  }
  for (const path of [localRoot, installRoot]) {
    const metadata = await lstatIfExists(fileSystem, path);
    if (metadata) {
      assertDirectory(metadata);
    }
  }
  const installMetadata = await lstatIfExists(fileSystem, installRoot);
  if (!installMetadata) {
    return { baseExists: true, marker: null, deploymentMode: "installed" };
  }
  const markerMetadata = await lstatIfExists(
    fileSystem,
    join(installRoot, MANAGED_MARKER),
  );
  if (
    !markerMetadata ||
    markerMetadata.isSymbolicLink() ||
    !markerMetadata.isFile()
  ) {
    throw new Error(
      "The local n8n sidecar directory is unmanaged. Nothing was overwritten.",
    );
  }
  let marker;
  try {
    marker = JSON.parse(
      await fileSystem.readFile(join(installRoot, MANAGED_MARKER), "utf8"),
    );
    validateMarker(marker);
  } catch {
    throw new Error("The local n8n sidecar managed marker is invalid.");
  }
  return { baseExists: true, marker, deploymentMode: "updated" };
}

function validateMarker(marker) {
  const installId =
    typeof marker?.installId === "string" && /^[a-f0-9]{32}$/u.test(marker.installId)
      ? marker.installId
      : null;
  const expectedProjectName = installId ? `${PROJECT_PREFIX}-${installId}` : null;
  if (
    marker?.schemaVersion !== MARKER_SCHEMA_VERSION ||
    marker?.kind !== "relmio-local-n8n-sidecar" ||
    marker?.target !== LOCAL_N8N_SIDECAR_TARGET ||
    marker?.projectName !== expectedProjectName
  ) {
    throw new TypeError("The local n8n sidecar marker is invalid.");
  }
  validateLocalDockerHost(marker.dockerHost);
  validateDockerObjectId(marker.n8nContainerId, "n8n container");
  validateDockerName(marker.n8nContainerName);
  validateDockerObjectId(marker.dockerNetworkId, "Docker network");
  validateDockerName(marker.networkName);
  return marker;
}

async function initializeManagedDirectories({
  fileSystem,
  installRoot,
  baseExists,
}) {
  const relmioHome = resolve(installRoot, "..", "..");
  if (!baseExists) {
    await fileSystem.mkdir(relmioHome, { mode: 0o700 });
    await writeManagedFile(
      fileSystem,
      join(relmioHome, ROOT_MARKER),
      `${JSON.stringify({
        schemaVersion: ROOT_MARKER_SCHEMA_VERSION,
        kind: "relmio-local-root",
      })}\n`,
      0o600,
    );
  }
  await fileSystem.chmod(relmioHome, 0o700);
  await ensurePrivateDirectory(fileSystem, join(relmioHome, "local"));
  await ensurePrivateDirectory(fileSystem, installRoot);
}

async function acquireSidecarLock({ fileSystem, installRoot }) {
  const safeInstallRoot = validateInstallRoot(installRoot);
  const lockPath = join(
    dirname(resolve(safeInstallRoot, "..", "..")),
    ".relmio-local-n8n-openai-oauth.lock",
  );
  const ownerPath = join(lockPath, "owner.json");
  const ownerToken = randomUUID();
  try {
    await fileSystem.mkdir(lockPath, { mode: 0o700 });
    await fileSystem.writeFile(
      ownerPath,
      `${JSON.stringify({ processId: process.pid, ownerToken })}\n`,
      { flag: "wx", mode: 0o600 },
    );
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new Error("Another Relmio process is changing this local sidecar.");
    }
    throw new Error("Relmio could not create its local sidecar lock.");
  }
  return async () => {
    try {
      const owner = JSON.parse(await fileSystem.readFile(ownerPath, "utf8"));
      if (owner?.ownerToken === ownerToken) {
        await fileSystem.rm(lockPath, { recursive: true, force: true });
      }
    } catch {
      // Lock cleanup must not hide the completed operation.
    }
  };
}

function requireOwnershipLabels(labels, { installId, projectName, service }) {
  if (!labels || typeof labels !== "object" || Array.isArray(labels)) {
    throw new Error("The local sidecar Docker ownership metadata is invalid.");
  }
  if (
    labels["com.docker.compose.project"] !== projectName ||
    labels["io.relmio.managed"] !== "true" ||
    labels["io.relmio.target"] !== LOCAL_N8N_SIDECAR_TARGET ||
    labels["io.relmio.install"] !== installId ||
    (service && labels["com.docker.compose.service"] !== SERVICE_NAME)
  ) {
    throw new Error(
      "A Docker resource uses this Relmio project identity without matching ownership. Nothing was changed.",
    );
  }
}

async function attestProjectOwnership({
  runProcess,
  cwd,
  dockerHost,
  installId,
  projectName,
}) {
  const projectFilter = `label=com.docker.compose.project=${projectName}`;
  const containers = await runOrThrow(
    runProcess,
    {
      file: "docker",
      args: [
        "ps",
        "--all",
        "--no-trunc",
        "--filter",
        projectFilter,
        "--format",
        "{{json .}}",
      ],
      cwd,
      dockerHost,
    },
    "Local sidecar container ownership check",
  );
  const containerRows = parseJsonLines(
    containers.stdout,
    "Local sidecar container ownership check",
  );
  if (containerRows.length > MAX_DISCOVERED_CONTAINERS) {
    throw new Error("The local sidecar container ownership check failed closed.");
  }
  for (const row of containerRows) {
    const containerId = validateDockerObjectId(
      row?.ID,
      "local sidecar container",
    );
    const inspected = await inspectContainer({
      runProcess,
      cwd,
      dockerHost,
      containerId,
    });
    if (inspected?.Id !== containerId) {
      throw new Error("The local sidecar Docker ownership metadata is invalid.");
    }
    requireOwnershipLabels(inspected.Config?.Labels, {
      installId,
      projectName,
      service: true,
    });
  }
  const volumes = await runOrThrow(
    runProcess,
    {
      file: "docker",
      args: ["volume", "ls", "--filter", projectFilter, "--format", "{{json .}}"],
      cwd,
      dockerHost,
    },
    "Local sidecar volume ownership check",
  );
  const volumeRows = parseJsonLines(
    volumes.stdout,
    "Local sidecar volume ownership check",
  );
  if (volumeRows.length > MAX_DISCOVERED_CONTAINERS) {
    throw new Error("The local sidecar volume ownership check failed closed.");
  }
  for (const row of volumeRows) {
    const volumeName = validateDockerName(row?.Name);
    const inspected = await runOrThrow(
      runProcess,
      {
        file: "docker",
        args: [
          "volume",
          "inspect",
          "--format",
          "{{json .Labels}}",
          volumeName,
        ],
        cwd,
        dockerHost,
      },
      "Local sidecar volume ownership inspection",
    );
    requireOwnershipLabels(
      parseJson(
        inspected.stdout.trim(),
        "Local sidecar volume ownership inspection",
      ),
      { installId, projectName, service: false },
    );
  }
  await inspectOwnedImageIfPresent({
    runProcess,
    cwd,
    dockerHost,
    installId,
    projectName,
  });
}

async function inspectOwnedImageIfPresent({
  runProcess,
  cwd,
  dockerHost,
  installId,
  projectName,
}) {
  const imageName = `${projectName}:local`;
  const listed = await runOrThrow(
    runProcess,
    {
      file: "docker",
      args: [
        "image",
        "ls",
        "--filter",
        `reference=${imageName}`,
        "--format",
        "{{json .}}",
      ],
      cwd,
      dockerHost,
    },
    "Local sidecar image existence check",
  );
  const rows = parseJsonLines(
    listed.stdout,
    "Local sidecar image existence check",
  );
  if (rows.length === 0) {
    return false;
  }
  if (
    rows.length !== 1 ||
    rows[0]?.Repository !== projectName ||
    rows[0]?.Tag !== "local"
  ) {
    throw new Error("The local sidecar image existence check failed closed.");
  }
  const image = await runOrThrow(
    runProcess,
    {
      file: "docker",
      args: [
        "image",
        "inspect",
        "--format",
        "{{json .Config.Labels}}",
        imageName,
      ],
      cwd,
      dockerHost,
    },
    "Local sidecar image ownership check",
  );
  const labels = parseJson(
    image.stdout.trim(),
    "Local sidecar image ownership check",
  );
  if (
    !labels ||
    labels["io.relmio.managed"] !== "true" ||
    labels["io.relmio.target"] !== LOCAL_N8N_SIDECAR_TARGET ||
    labels["io.relmio.install"] !== installId
  ) {
    throw new Error(
      "A Docker image uses this Relmio project identity without matching ownership. Nothing was changed.",
    );
  }
  return true;
}

function labelsMatchOwnedSidecar(labels, { installId, projectName }) {
  return (
    labels?.["com.docker.compose.project"] === projectName &&
    labels?.["com.docker.compose.service"] === SERVICE_NAME &&
    labels?.["io.relmio.managed"] === "true" &&
    labels?.["io.relmio.target"] === LOCAL_N8N_SIDECAR_TARGET &&
    labels?.["io.relmio.install"] === installId
  );
}

async function attestPlanAndAlias({
  plan,
  runProcess,
  cwd,
  installId,
  projectName,
}) {
  const n8n = await inspectContainer({
    runProcess,
    cwd,
    dockerHost: plan.dockerHost,
    containerId: plan.n8nContainerId,
  });
  const normalizedN8n = validateDiscoveredN8nContainer(n8n);
  const n8nNetwork = n8n.NetworkSettings.Networks?.[plan.networkName];
  if (
    normalizedN8n.containerId !== plan.n8nContainerId ||
    normalizedN8n.containerName !== plan.n8nContainerName ||
    n8nNetwork?.NetworkID !== plan.dockerNetworkId
  ) {
    throw new Error(
      "The selected n8n container changed. Create and confirm a fresh plan.",
    );
  }
  const network = await inspectNetwork({
    runProcess,
    cwd,
    dockerHost: plan.dockerHost,
    networkName: plan.networkName,
  });
  const normalizedNetwork = validateSelectedNetwork(network, {
    n8nContainerId: plan.n8nContainerId,
    expectedName: plan.networkName,
  });
  if (normalizedNetwork.dockerNetworkId !== plan.dockerNetworkId) {
    throw new Error(
      "The selected n8n Docker network changed. Create and confirm a fresh plan.",
    );
  }
  const connectedIds = Object.keys(network.Containers);
  if (connectedIds.length > MAX_DISCOVERED_CONTAINERS) {
    throw new Error("The selected n8n Docker network is too large to attest safely.");
  }
  for (const connectedId of connectedIds) {
    validateDockerObjectId(connectedId, "connected container");
    const connected = connectedId === plan.n8nContainerId
      ? n8n
      : await inspectContainer({
          runProcess,
          cwd,
          dockerHost: plan.dockerHost,
          containerId: connectedId,
        });
    const connectedName = parseContainerName(connected?.Name);
    const endpointName = parseContainerName(
      network.Containers?.[connectedId]?.Name,
    );
    const networkState = connected.NetworkSettings?.Networks?.[plan.networkName];
    const ownsReservedIdentity = labelsMatchOwnedSidecar(
      connected.Config?.Labels,
      { installId, projectName },
    );
    if (
      (connectedName === LOCAL_N8N_SIDECAR_HOSTNAME ||
        endpointName === LOCAL_N8N_SIDECAR_HOSTNAME ||
        (Array.isArray(networkState?.Aliases) &&
          networkState.Aliases.includes(LOCAL_N8N_SIDECAR_HOSTNAME))) &&
      !ownsReservedIdentity
    ) {
      throw new Error(
        "The n8n-openai-oauth Docker network alias has a collision. Nothing was changed.",
      );
    }
  }
}

function createComposeArgs(projectName, suffix) {
  if (!new RegExp(`^${PROJECT_PREFIX}-[a-f0-9]{32}$`, "u").test(projectName)) {
    throw new TypeError("The local sidecar Docker project identity is invalid.");
  }
  return [
    "compose",
    "--project-name",
    projectName,
    "--file",
    COMPOSE_FILENAME,
    ...suffix,
  ];
}

function parseModels(output) {
  const parsed = parseJson(output.trim(), "Local OAuth model check");
  if (!Array.isArray(parsed?.data)) {
    throw new Error("The local OAuth model response could not be verified.");
  }
  const models = parsed.data
    .map((entry) => entry?.id)
    .filter(
      (id) =>
        typeof id === "string" &&
        id.length > 0 &&
        id.length <= 128 &&
        /^[A-Za-z0-9_.:-]+$/u.test(id),
    );
  if (models.length === 0) {
    throw new Error("The local OAuth model response could not be verified.");
  }
  return models;
}

function assertNoPublishedHostPort(output) {
  let services;
  try {
    const parsed = JSON.parse(output);
    services = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    throw new Error("The local sidecar published-port safety check failed.");
  }
  if (services.length !== 1 || !Array.isArray(services[0]?.Publishers)) {
    throw new Error("The local sidecar published-port safety check failed.");
  }
  for (const publisher of services[0].Publishers) {
    if (
      !publisher ||
      !Number.isInteger(publisher.PublishedPort) ||
      typeof publisher.URL !== "string" ||
      publisher.PublishedPort !== 0 ||
      publisher.URL !== ""
    ) {
      throw new Error(
        "Safety check failed: the local sidecar published an unexpected host port.",
      );
    }
  }
}

async function verifyRunningSidecar({
  runProcess,
  installRoot,
  plan,
  installId,
  projectName,
}) {
  const running = await runOrThrow(
    runProcess,
    {
      file: "docker",
      args: createComposeArgs(projectName, [
        "ps",
        "--status",
        "running",
        "--services",
        SERVICE_NAME,
      ]),
      cwd: installRoot,
      dockerHost: plan.dockerHost,
    },
    "Local sidecar status check",
  );
  if (!running.stdout.split(/\s+/u).includes(SERVICE_NAME)) {
    throw new Error("The local n8n sidecar did not reach the running state.");
  }
  const publication = await runOrThrow(
    runProcess,
    {
      file: "docker",
      args: createComposeArgs(projectName, [
        "ps",
        "--format",
        "json",
        SERVICE_NAME,
      ]),
      cwd: installRoot,
      dockerHost: plan.dockerHost,
    },
    "Local sidecar publication check",
  );
  assertNoPublishedHostPort(publication.stdout);
  const containerIdResult = await runOrThrow(
    runProcess,
    {
      file: "docker",
      args: createComposeArgs(projectName, ["ps", "-q", SERVICE_NAME]),
      cwd: installRoot,
      dockerHost: plan.dockerHost,
    },
    "Local sidecar identity check",
  );
  const containerId = validateDockerObjectId(
    containerIdResult.stdout.trim(),
    "local sidecar container",
  );
  const sidecar = await inspectContainer({
    runProcess,
    cwd: installRoot,
    dockerHost: plan.dockerHost,
    containerId,
  });
  const sidecarNetwork = sidecar.NetworkSettings?.Networks?.[plan.networkName];
  if (
    sidecar?.Id !== containerId ||
    sidecar?.State?.Running !== true ||
    !labelsMatchOwnedSidecar(sidecar.Config?.Labels, {
      installId,
      projectName,
    }) ||
    sidecarNetwork?.NetworkID !== plan.dockerNetworkId ||
    !Array.isArray(sidecarNetwork?.Aliases) ||
    !sidecarNetwork.Aliases.includes(LOCAL_N8N_SIDECAR_HOSTNAME)
  ) {
    throw new Error("The local sidecar Docker identity could not be verified.");
  }
  const ports = sidecar.NetworkSettings?.Ports;
  if (
    !ports ||
    typeof ports !== "object" ||
    Array.isArray(ports) ||
    Object.values(ports).some((bindings) => bindings !== null)
  ) {
    throw new Error("The local sidecar published-port safety check failed.");
  }
  const verifier = await runOrThrow(
    runProcess,
    {
      file: "docker",
      args: createComposeArgs(projectName, [
        "run",
        "--rm",
        "--no-deps",
        "-T",
        "--entrypoint",
        "node",
        SERVICE_NAME,
        "-e",
        VERIFIER_SCRIPT,
      ]),
      cwd: installRoot,
      dockerHost: plan.dockerHost,
    },
    "Local sidecar private-network verification",
  );
  return parseModels(verifier.stdout);
}

async function cleanupSidecarProject({
  runProcess,
  installRoot,
  dockerHost,
  projectName,
}) {
  await runOrThrow(
    runProcess,
    {
      file: "docker",
      args: createComposeArgs(projectName, [
        "down",
        "--volumes",
        "--remove-orphans",
      ]),
      cwd: installRoot,
      dockerHost,
    },
    "Local sidecar cleanup",
  );
  const remaining = await runOrThrow(
    runProcess,
    {
      file: "docker",
      args: createComposeArgs(projectName, ["ps", "-q", SERVICE_NAME]),
      cwd: installRoot,
      dockerHost,
    },
    "Local sidecar cleanup verification",
  );
  if (remaining.stdout.trim() !== "") {
    throw new Error("Relmio could not confirm local sidecar cleanup.");
  }
}

async function readCurrentAuth({
  authPath,
  plan,
  fileSystem,
  env,
  homeDirectory,
}) {
  const expectedPath = resolveAuthPath({ env, homeDirectory });
  if (authPath !== expectedPath) {
    throw new Error("The local OAuth credential path is invalid.");
  }
  let metadata;
  try {
    metadata = await fileSystem.lstat(expectedPath);
  } catch {
    throw new Error("The local OAuth credential is missing or invalid.");
  }
  if (
    metadata.isSymbolicLink() ||
    !metadata.isFile() ||
    (metadata.mode & 0o077) !== 0
  ) {
    throw new Error(
      metadata.isFile() && (metadata.mode & 0o077) !== 0
        ? "The local OAuth credential permissions are too broad."
        : "The local OAuth credential is missing or invalid.",
    );
  }
  if (metadata.mtime.toISOString() !== plan.authGeneration) {
    throw new Error(
      "The local OAuth credential changed. Create and confirm a fresh plan.",
    );
  }
  return readAuthContents({ authPath: expectedPath, fileSystem });
}

export async function installLocalN8nSidecar(
  { plan, authPath, confirmed },
  {
    fileSystem = defaultFileSystem,
    env = process.env,
    homeDirectory = homedir(),
    runProcess = runLocalProcess,
    randomBytes = createRandomBytes,
    platform = process.platform,
  } = {},
) {
  if (confirmed !== true) {
    throw new Error("Confirm the reviewed private n8n bridge plan before installing.");
  }
  assertSupportedPlatform(platform);
  rejectDockerEnvironmentOverrides(env);
  const normalizedPlan = normalizeLocalN8nSidecarPlan(plan);
  const authContents = await readCurrentAuth({
    authPath,
    plan: normalizedPlan,
    fileSystem,
    env,
    homeDirectory,
  });
  const installRoot = await resolveLocalN8nSidecarInstallRoot({
    env,
    homeDirectory,
    fileSystem,
    platform,
  });
  const releaseLock = await acquireSidecarLock({ fileSystem, installRoot });
  try {
    const managed = await inspectManagedInstall({ fileSystem, installRoot });
    if (managed.marker) {
      throw new Error(
        "The managed local n8n bridge is already installed. Use the separately confirmed Remove bridge action before installing it again.",
      );
    }
    const identityBytes = randomBytes(32);
    if (
      (!Buffer.isBuffer(identityBytes) || identityBytes.length !== 32)
    ) {
      throw new Error("Relmio could not create a strong sidecar identity.");
    }
    const installId = identityBytes.subarray(0, 16).toString("hex");
    const projectName = `${PROJECT_PREFIX}-${installId}`;
    await attestProjectOwnership({
      runProcess,
      cwd: dirname(resolve(installRoot, "..", "..")),
      dockerHost: normalizedPlan.dockerHost,
      installId,
      projectName,
    });
    await attestPlanAndAlias({
      plan: normalizedPlan,
      runProcess,
      cwd: dirname(resolve(installRoot, "..", "..")),
      installId,
      projectName,
    });
    await initializeManagedDirectories({
      fileSystem,
      installRoot,
      baseExists: managed.baseExists,
    });
    await writeManagedFile(
      fileSystem,
      join(installRoot, "Dockerfile"),
      createLocalN8nSidecarDockerfile({ installId }),
      0o600,
    );
    await writeManagedFile(
      fileSystem,
      join(installRoot, ".dockerignore"),
      createLocalN8nSidecarDockerignore(),
      0o600,
    );
    await writeManagedFile(
      fileSystem,
      join(installRoot, COMPOSE_FILENAME),
      createLocalN8nSidecarComposeFile({
        installId,
        networkName: normalizedPlan.networkName,
      }),
      0o600,
    );
    await writeManagedFile(
      fileSystem,
      join(installRoot, MANAGED_MARKER),
      `${JSON.stringify({
        schemaVersion: MARKER_SCHEMA_VERSION,
        kind: "relmio-local-n8n-sidecar",
        target: LOCAL_N8N_SIDECAR_TARGET,
        installId,
        projectName,
        dockerHost: normalizedPlan.dockerHost,
        n8nContainerId: normalizedPlan.n8nContainerId,
        n8nContainerName: normalizedPlan.n8nContainerName,
        dockerNetworkId: normalizedPlan.dockerNetworkId,
        networkName: normalizedPlan.networkName,
      })}\n`,
      0o600,
    );
    await runOrThrow(
      runProcess,
      {
        file: "docker",
        args: createComposeArgs(projectName, ["config", "--quiet"]),
        cwd: installRoot,
        dockerHost: normalizedPlan.dockerHost,
      },
      "Local sidecar Compose validation",
    );
    await attestProjectOwnership({
      runProcess,
      cwd: installRoot,
      dockerHost: normalizedPlan.dockerHost,
      installId,
      projectName,
    });
    await attestPlanAndAlias({
      plan: normalizedPlan,
      runProcess,
      cwd: installRoot,
      installId,
      projectName,
    });
    const reattestedAuthContents = await readCurrentAuth({
      authPath,
      plan: normalizedPlan,
      fileSystem,
      env,
      homeDirectory,
    });
    if (!authContents.equals(reattestedAuthContents)) {
      throw new Error(
        "The local OAuth credential changed. Create and confirm a fresh plan.",
      );
    }

    let deploymentStarted = false;
    try {
      deploymentStarted = true;
      await runOrThrow(
        runProcess,
        {
          file: "docker",
          args: createComposeArgs(projectName, ["build", SERVICE_NAME]),
          cwd: installRoot,
          dockerHost: normalizedPlan.dockerHost,
        },
        "Local sidecar image build",
      );
      await runOrThrow(
        runProcess,
        {
          file: "docker",
          args: createComposeArgs(projectName, [
            "run",
            "--rm",
            "--no-deps",
            "-T",
            "credential-seed",
          ]),
          cwd: installRoot,
          dockerHost: normalizedPlan.dockerHost,
          input: reattestedAuthContents,
        },
        "Local OAuth credential seed",
      );
      await runOrThrow(
        runProcess,
        {
          file: "docker",
          args: createComposeArgs(projectName, [
            "up",
            "-d",
            "--wait",
            "--wait-timeout",
            "90",
            "--no-deps",
            SERVICE_NAME,
          ]),
          cwd: installRoot,
          dockerHost: normalizedPlan.dockerHost,
        },
        "Local sidecar start",
      );
      const models = await verifyRunningSidecar({
        runProcess,
        installRoot,
        plan: normalizedPlan,
        installId,
        projectName,
      });
      return {
        target: LOCAL_N8N_SIDECAR_TARGET,
        endpoint: LOCAL_N8N_SIDECAR_ENDPOINT,
        baseUrl: LOCAL_N8N_SIDECAR_ENDPOINT,
        protocol: "openai-v1",
        apiKeyPlaceholder: "local-only",
        useResponsesApi: true,
        models,
        networkName: normalizedPlan.networkName,
        n8nContainerName: normalizedPlan.n8nContainerName,
        hostPublication: "none",
        deploymentMode: "installed",
        unofficial: true,
      };
    } catch (error) {
      if (deploymentStarted) {
        try {
          await attestProjectOwnership({
            runProcess,
            cwd: installRoot,
            dockerHost: normalizedPlan.dockerHost,
            installId,
            projectName,
          });
          await cleanupSidecarProject({
            runProcess,
            installRoot,
            dockerHost: normalizedPlan.dockerHost,
            projectName,
          });
        } catch {
          throw new Error(
            "Local sidecar verification failed and automatic cleanup could not be confirmed. Inspect only the Relmio sidecar project before retrying.",
          );
        }
      }
      throw error;
    }
  } finally {
    await releaseLock();
  }
}

export async function removeLocalN8nSidecar(
  { confirmed },
  {
    fileSystem = defaultFileSystem,
    env = process.env,
    homeDirectory = homedir(),
    runProcess = runLocalProcess,
    platform = process.platform,
  } = {},
) {
  if (confirmed !== true) {
    throw new Error("Confirm removal of the managed local n8n bridge.");
  }
  assertSupportedPlatform(platform);
  rejectDockerEnvironmentOverrides(env);
  const installRoot = await resolveLocalN8nSidecarInstallRoot({
    env,
    homeDirectory,
    fileSystem,
    platform,
  });
  const releaseLock = await acquireSidecarLock({ fileSystem, installRoot });
  try {
    const managed = await inspectManagedInstall({ fileSystem, installRoot });
    if (!managed.marker) {
      throw new Error("The managed local n8n bridge is not installed.");
    }
    const marker = validateMarker(managed.marker);
    await attestProjectOwnership({
      runProcess,
      cwd: installRoot,
      dockerHost: marker.dockerHost,
      installId: marker.installId,
      projectName: marker.projectName,
    });
    await cleanupSidecarProject({
      runProcess,
      installRoot,
      dockerHost: marker.dockerHost,
      projectName: marker.projectName,
    });
    const imageName = `${marker.projectName}:local`;
    if (
      await inspectOwnedImageIfPresent({
        runProcess,
        cwd: installRoot,
        dockerHost: marker.dockerHost,
        installId: marker.installId,
        projectName: marker.projectName,
      })
    ) {
      await runOrThrow(
        runProcess,
        {
          file: "docker",
          args: ["image", "rm", imageName],
          cwd: installRoot,
          dockerHost: marker.dockerHost,
        },
        "Local sidecar image removal",
      );
    }
    await fileSystem.rm(installRoot, { recursive: true, force: false });
    return { removed: true, target: LOCAL_N8N_SIDECAR_TARGET };
  } finally {
    await releaseLock();
  }
}

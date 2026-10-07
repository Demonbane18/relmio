import { createHash, randomBytes as createRandomBytes, randomUUID } from "node:crypto";
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
import {
  safeSiwcCatalogFailure, safeSiwcRuntimeFailure,
  validateSiwcAuthBinding, validateSiwcRegistrationId,
} from "../domain/safety.js";
import { validateDockerName } from "../domain/validation.js";
import { readCodexImagesCliResult } from "../domain/codex-images.js";
import {
  runLocalProcess,
  lockDownLocalPath,
  validateLocalDockerHost,
} from "../infrastructure/local-process.js";
import { collectSiwcRuntimeAssets } from "./siwc-runtime-assets.js";
import {
  finishAuthHandoff, prepareAuthHandoff, readAuthHandoff, readPendingAuthHandoff, readRegistration, listRegistrations,
  validateSiwcBackgroundConsent, validateSiwcHostId,
} from "./siwc-session.mjs";
import {
  acquireLocalIntegrationLifecycleLock,
  settleLocalIntegrationLifecycleOperation,
  fingerprintLocalSiwcFiles, fingerprintLocalSiwcResources, localSiwcFinalizationFailure,
  localSiwcStagingPath, readLocalSiwcStaging, readLocalSiwcResumeAuthBinding,
  assertNoLocalSiwcOneOffContainers,
} from "./local-integration-lifecycle-lock.js";
import { usageRecordFromCli } from "./model-discovery.mjs";

const COMPOSE_FILENAME = "docker-compose.yml";
const MANAGED_MARKER = ".managed-by-relmio.json";
const ROOT_MARKER = ".managed-by-relmio-root.json";
const ROOT_MARKER_SCHEMA_VERSION = 1;
const MARKER_SCHEMA_VERSION = 2;
const PROJECT_PREFIX = "relmio-n8n-openai-oauth";
const SERVICE_NAME = "openai-oauth";
const MAX_DISCOVERED_CONTAINERS = 100;
const MAX_DOCKER_METADATA_BYTES = 1024 * 1024;
const DOCKER_IMAGE_DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const DOCKER_SELECTION_VARIABLES = new Set([
  "BUILDKIT_HOST",
  "DOCKER_CERT_PATH",
  "DOCKER_CONFIG",
  "DOCKER_CONTEXT",
  "DOCKER_HOST",
  "DOCKER_TLS_VERIFY",
]);
const SIWC_ASSET_PATHS = new Set([
  "gateway/openai-oauth-sidecar.mjs", "gateway/codex-chat.js",
  "gateway/codex-app-server.mjs", "services/siwc-session.mjs",
  "services/siwc-handoff.mjs", "infrastructure/local-process.js",
  "services/local-integration-lifecycle-lock.js", "services/codex-images.mjs", "services/model-discovery.mjs",
  "infrastructure/process-identity.js",
]);
const OFFICIAL_N8N_IMAGE = /^(?:(?:(?:docker\.n8n\.io|docker\.io)\/)?n8nio\/n8n)(?::[A-Za-z0-9_.-]{1,128})?(?:@sha256:[a-f0-9]{64})?$/u;
const VERIFIER_SCRIPT = [
  '(async()=>{let key="";for await(const chunk of process.stdin){key+=chunk;',
  'if(key.length>128)process.exit(1)}',
  'const headers={Authorization:"Bearer "+key};',
  'const [health,models]=await Promise.all([fetch("http://n8n-openai-oauth:10531/health"),',
  'fetch("http://n8n-openai-oauth:10531/v1/models",{headers})]);',
  'if(!health.ok||!models.ok)process.exit(1);',
  'process.stdout.write(JSON.stringify(await models.json()))})().catch(()=>process.exit(1));',
].join("");

function isMissing(error) {
  return error?.code === "ENOENT";
}

function validateDockerImageDigest(value) {
  if (typeof value !== "string" || !DOCKER_IMAGE_DIGEST_PATTERN.test(value)) {
    throw new TypeError("Local sidecar runtime image identity is invalid.");
  }
  return value;
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

function localN8nSidecarSnapshot(marker, account = null) {
  const migrationRequired = marker.schemaVersion !== MARKER_SCHEMA_VERSION;
  const connected = !migrationRequired && account?.ownership === "owned" &&
    account?.session === "connected" && account?.planEnabled === true;
  return {
    target: LOCAL_N8N_SIDECAR_TARGET,
    endpoint: LOCAL_N8N_SIDECAR_ENDPOINT,
    auth: {
      configured: connected,
      disclosure: "server-managed",
      ...(!migrationRequired && account ? { account } : {}),
    },
    ...(!migrationRequired ? { registrationId: marker.registrationId } : {}),
    migrationRequired,
    canRefreshCredential: false,
    canRemove: true,
  };
}

function parseSidecarStatusRecord(output, marker) {
  let records;
  try {
    const parsed = JSON.parse(output);
    records = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    throw new Error("The local sidecar status metadata is invalid.");
  }
  const record = records[0];
  if (
    records.length !== 1 ||
    record?.Name !== `${marker.projectName}-${SERVICE_NAME}-1` ||
    record?.Service !== SERVICE_NAME ||
    typeof record?.State !== "string" ||
    typeof record?.Health !== "string"
  ) {
    throw new Error("The local sidecar status metadata is invalid.");
  }
  assertNoPublishedHostPort(output);
  return record;
}

async function verifyWindowsSidecarStatusPathSecurity({
  fileSystem,
  installRoot,
  platform,
  lockDownPath,
}) {
  if (platform !== "win32") return;
  const relmioHome = resolve(installRoot, "..", "..");
  for (const path of [relmioHome, join(relmioHome, "local"), installRoot]) {
    assertDirectory(await lstatIfExists(fileSystem, path));
    await lockDownPath(path, { platform, verifyOnly: true });
  }
  for (const path of [
    join(relmioHome, ROOT_MARKER),
    join(installRoot, MANAGED_MARKER),
    join(installRoot, COMPOSE_FILENAME),
  ]) {
    const metadata = await lstatIfExists(fileSystem, path);
    if (!metadata?.isFile?.() || metadata.isSymbolicLink()) {
      throw new Error("Relmio refuses an unsafe local sidecar managed file.");
    }
    await lockDownPath(path, {
      platform,
      kind: "file",
      verifyOnly: true,
      verifyEffectiveOwnerOnly: true,
    });
  }
}

export async function getLocalN8nSidecarStatus({
  env = process.env,
  homeDirectory = homedir(),
  fileSystem = defaultFileSystem,
  runProcess = runLocalProcess,
  platform = process.platform,
  lockDownPath = lockDownLocalPath,
} = {}) {
  const absent = {
    target: LOCAL_N8N_SIDECAR_TARGET,
    managed: false,
    state: "absent",
  };
  const unavailable = {
    target: LOCAL_N8N_SIDECAR_TARGET,
    managed: false,
    state: "unavailable",
  };
  try {
    const installRoot = await resolveLocalN8nSidecarInstallRoot({
      env,
      homeDirectory,
      fileSystem,
      platform,
    });
    const staged = await readLocalSiwcStaging({ fileSystem, installRoot, platform, lockDownPath });
    if (staged && staged.checkpoint.stage !== "completed") {
      await fingerprintLocalSiwcFiles({ fileSystem, installRoot, platform, lockDownPath });
      const { installId, registrationId, stage } = staged.checkpoint;
      return { target: LOCAL_N8N_SIDECAR_TARGET, managed: true, state: "staged",
        staging: { installId, registrationId, stage } };
    }
    if (await lstatIfExists(fileSystem, installRoot)) {
      await verifyWindowsSidecarStatusPathSecurity({
        fileSystem,
        installRoot,
        platform,
        lockDownPath,
      });
    }
    const managed = await inspectManagedInstall({ fileSystem, installRoot });
    if (!managed.marker) return absent;
    const marker = validateMarker(managed.marker);
    if (platform === "win32" && marker.schemaVersion === MARKER_SCHEMA_VERSION) {
      for (const relative of [
        "Dockerfile", ".dockerignore", "package.json", "package-lock.json",
        "services/siwc-session.mjs", "services/siwc-handoff.mjs",
        "gateway/openai-oauth-sidecar.mjs", "infrastructure/local-process.js",
        "services/local-integration-lifecycle-lock.js", "services/codex-images.mjs", "services/model-discovery.mjs",
        "infrastructure/process-identity.js",
      ]) {
        const path = join(installRoot, relative);
        const metadata = await lstatIfExists(fileSystem, path);
        // Installs made before the image add-on or model discovery lack these files; verify them whenever present.
        if (!metadata && ["services/codex-images.mjs", "services/model-discovery.mjs"].includes(relative)) continue;
        if (!metadata?.isFile?.() || metadata.isSymbolicLink()) {
          throw new Error("The installed SIWC runtime asset is missing or unsafe.");
        }
        await lockDownPath(path, {
          platform, kind: "file", verifyOnly: true, verifyEffectiveOwnerOnly: true,
        });
      }
    }
    if (marker.schemaVersion === MARKER_SCHEMA_VERSION) {
      await assertManagedSiwcCompose(fileSystem, installRoot, marker);
    }
    const selectedDockerHost = await resolveLocalDockerHost({
      runProcess,
      cwd: installRoot,
      env,
      platform,
    });
    if (selectedDockerHost !== marker.dockerHost) return unavailable;
    if (marker.schemaVersion === MARKER_SCHEMA_VERSION && marker.legacyInstallId) {
      const migrationState = await readLegacyN8nMigrationState(
        fileSystem, installRoot, marker.legacyInstallId,
      );
      if (migrationState !== "transferred") {
        return {
          target: LOCAL_N8N_SIDECAR_TARGET, managed: true, state: "partial",
          snapshot: {
            target: LOCAL_N8N_SIDECAR_TARGET,
            endpoint: LOCAL_N8N_SIDECAR_ENDPOINT,
            auth: { configured: false, disclosure: "server-managed" },
            canRefreshCredential: false, canRemove: true,
            migrationRequired: !marker.previousWasSiwc,
            replacementRequired: !!marker.previousWasSiwc,
            migrationState: migrationState ?? "incomplete",
            legacyResourcesPreserved: true,
          },
        };
      }
    }
    await attestPlanAndAlias({
      plan: marker,
      runProcess,
      cwd: installRoot,
      installId: marker.installId,
      projectName: marker.projectName,
    });
    const ownership = await attestProjectOwnership({
      runProcess,
      cwd: installRoot,
      dockerHost: marker.dockerHost,
      installId: marker.installId,
      projectName: marker.projectName,
      returnDetails: true,
      volumeName: marker.schemaVersion === MARKER_SCHEMA_VERSION ? "siwc-store" : "oauth-auth",
    });
    if (!ownership.exact) {
      return {
        target: LOCAL_N8N_SIDECAR_TARGET,
        managed: true,
        state: "partial",
      };
    }
    if (marker.schemaVersion !== MARKER_SCHEMA_VERSION) {
      const migrationState = await readLegacyN8nMigrationState(
        fileSystem, installRoot, marker.installId,
      );
      if (migrationState === "transferred") {
        throw new Error("The legacy n8n migration metadata is inconsistent.");
      }
      return {
        target: LOCAL_N8N_SIDECAR_TARGET,
        managed: true, state: migrationState ? "partial" : "legacy",
        snapshot: {
          ...localN8nSidecarSnapshot(marker),
          ...(migrationState ? { migrationState, legacyResourcesPreserved: true } : {}),
        },
      };
    }
    const publication = await runOrThrow(
      runProcess,
      {
        file: "docker",
        args: createComposeArgs(marker.projectName, [
          "ps",
          "--all",
          "--format",
          "json",
          SERVICE_NAME,
        ]),
        cwd: installRoot,
        dockerHost: marker.dockerHost,
      },
      "Local sidecar inventory publication check",
    );
    const statusRecord = parseSidecarStatusRecord(publication.stdout, marker);
    const runtime = await inspectOwnedSidecarRuntime({
      runProcess,
      installRoot,
      marker,
    });
    let account = null;
    if (runtime?.running && !runtime.paused &&
        statusRecord.State === "running") {
      try {
        account = (await runSiwcCli({
          runProcess, installRoot, marker, command: "account-live",
        })).account;
        if (account?.registrationId !== marker.registrationId ||
            account?.ownerHostId !== marker.ownerHostId ||
            account?.ownerRuntimeId !== marker.installId ||
            account?.ownership !== "owned") {
          throw new Error("The installed SIWC account cannot be attested.");
        }
      } catch {
        return {
          target: LOCAL_N8N_SIDECAR_TARGET,
          managed: true, state: "partial",
          snapshot: localN8nSidecarSnapshot(marker),
        };
      }
    }
    const snapshot = localN8nSidecarSnapshot(marker, account);
    if (!runtime) {
      return {
        target: LOCAL_N8N_SIDECAR_TARGET,
        managed: true,
        state: "partial",
      };
    }
    if (runtime.paused) {
      return {
        target: LOCAL_N8N_SIDECAR_TARGET,
        managed: true,
        state: "partial",
      };
    }
    if (!runtime.running) {
      return ["created", "exited"].includes(statusRecord.State) &&
        !["starting", "unhealthy"].includes(statusRecord.Health)
        ? {
            target: LOCAL_N8N_SIDECAR_TARGET,
            managed: true,
            state: "stopped",
            snapshot,
          }
        : {
            target: LOCAL_N8N_SIDECAR_TARGET,
            managed: true,
            state: "partial",
          };
    }
    if (
      statusRecord.State !== "running" ||
      statusRecord.Health !== "healthy" ||
      runtime.health !== "healthy"
    ) {
      return {
        target: LOCAL_N8N_SIDECAR_TARGET,
        managed: true,
        state: "partial",
      };
    }
    await verifyRunningSidecar({
      runProcess,
      installRoot,
      plan: marker,
      installId: marker.installId,
      projectName: marker.projectName,
    });
    return {
      target: LOCAL_N8N_SIDECAR_TARGET,
      managed: true,
      state: "healthy",
      snapshot,
    };
  } catch {
    return unavailable;
  }
}

// Read-only: the installed local sidecar's stored request counts, as usageRecordFromCli reads them, or
// undefined when no running SIWC sidecar owned by this install can be attested. Nothing is changed.
export async function getLocalN8nSidecarUsage({
  env = process.env,
  homeDirectory = homedir(),
  fileSystem = defaultFileSystem,
  runProcess = runLocalProcess,
  platform = process.platform,
  lockDownPath = lockDownLocalPath,
} = {}) {
  try {
    const installRoot = await resolveLocalN8nSidecarInstallRoot({ env, homeDirectory, fileSystem, platform });
    if (!await lstatIfExists(fileSystem, installRoot)) return undefined;
    await verifyWindowsSidecarStatusPathSecurity({ fileSystem, installRoot, platform, lockDownPath });
    const managed = await inspectManagedInstall({ fileSystem, installRoot });
    if (!managed.marker) return undefined;
    const marker = validateMarker(managed.marker);
    await assertManagedSiwcCompose(fileSystem, installRoot, marker);
    if (await resolveLocalDockerHost({ runProcess, cwd: installRoot, env, platform }) !== marker.dockerHost) return undefined;
    const runtime = await inspectOwnedSidecarRuntime({ runProcess, installRoot, marker });
    if (!runtime?.running || runtime.paused) return undefined;
    await attestProjectOwnership({ runProcess, cwd: installRoot, dockerHost: marker.dockerHost,
      installId: marker.installId, projectName: marker.projectName });
    return usageRecordFromCli(await runProcess({
      file: "docker",
      args: createComposeArgs(marker.projectName, [
        "exec", "-T", SERVICE_NAME, "node", "/app/services/model-discovery.mjs", "usage",
      ]),
      cwd: installRoot,
      dockerHost: marker.dockerHost,
    }), marker.registrationId);
  } catch {
    return undefined;
  }
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
  let dockerHost;
  try {
    dockerHost = validateLocalDockerHost(candidate, { platform });
  } catch {
    throw new Error("The selected Docker context is not a local Docker daemon.");
  }
  if (platform === "win32" && dockerHost.startsWith("npipe:")) {
    const selectedContext = await runProcess({ file: "docker", args: ["context", "show"], cwd });
    if (selectedContext.code !== 0 || selectedContext.stdout.trim() !== "desktop-linux") {
      throw new Error("Docker Desktop's local Linux engine must be selected.");
    }
  }
  return dockerHost;
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
    inspected?.Internal !== false ||
    !inspected?.Containers ||
    typeof inspected.Containers !== "object" ||
    Array.isArray(inspected.Containers) ||
    (n8nContainerId !== undefined && !Object.prototype.hasOwnProperty.call(inspected.Containers, n8nContainerId))
  ) {
    if (inspected?.Internal === true) {
      throw new Error(
        "The selected n8n Docker network has no outbound Internet access. Choose a non-internal Docker network and review a fresh plan.",
      );
    }
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

async function inspectManagedInstall({ fileSystem, installRoot, staging }) {
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
  if (staging && !(await lstatIfExists(fileSystem, join(installRoot, MANAGED_MARKER)))) {
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
    ![1, MARKER_SCHEMA_VERSION].includes(marker?.schemaVersion) ||
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
  if (marker.schemaVersion === MARKER_SCHEMA_VERSION) {
    validateSiwcRegistrationId(marker.registrationId);
    validateSiwcHostId(marker.ownerHostId);
    if (typeof marker.clientId !== "string" || !/^[!-~]{1,256}$/u.test(marker.clientId) ||
        typeof marker.tokenSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(marker.tokenSha256)) {
      throw new TypeError("The local n8n sidecar marker is invalid.");
    }
    if (marker.legacyInstallId !== undefined) {
      if (typeof marker.legacyInstallId !== "string" ||
          !/^[a-f0-9]{32}$/u.test(marker.legacyInstallId) ||
          marker.legacyInstallId === installId) {
        throw new TypeError("The local n8n migration marker is invalid.");
      }
    }
    if (marker.previousWasSiwc !== undefined &&
        (marker.previousWasSiwc !== true || !marker.legacyInstallId)) {
      throw new TypeError("The local n8n replacement marker is invalid.");
    }
  }
  return marker;
}

async function readLegacyN8nMigrationState(fileSystem, installRoot, installId) {
  const legacyRoot = join(installRoot, "legacy");
  const parent = await lstatIfExists(fileSystem, legacyRoot);
  if (!parent) return null;
  assertDirectory(parent);
  const archive = join(legacyRoot, installId);
  const metadata = await lstatIfExists(fileSystem, archive);
  if (!metadata) return null;
  assertDirectory(metadata);
  const journalPath = join(archive, "migration.json");
  const journal = await lstatIfExists(fileSystem, journalPath);
  if (!journal) return "incomplete";
  if (!journal.isFile() || journal.isSymbolicLink() || journal.size > 4096) {
    throw new Error("The local n8n migration journal is unsafe.");
  }
  let record;
  try { record = JSON.parse(await fileSystem.readFile(journalPath, "utf8")); }
  catch { throw new Error("The local n8n migration journal is invalid."); }
  if (record?.schemaVersion !== 1 ||
      record?.reviewedLegacy?.installId !== installId ||
      !["prepared", "stopped", "transferred"].includes(record?.state)) {
    throw new Error("The local n8n migration journal needs manual inspection.");
  }
  return record.state;
}

async function assertManagedSiwcCompose(fileSystem, installRoot, marker) {
  if (marker.schemaVersion !== MARKER_SCHEMA_VERSION) {
    throw new Error("The legacy bridge needs a fresh SIWC sign-in and reviewed migration.");
  }
  const path = join(installRoot, COMPOSE_FILENAME);
  const metadata = await lstatIfExists(fileSystem, path);
  if (!metadata?.isFile?.() || metadata.isSymbolicLink()) {
    throw new Error("The installed SIWC Compose file is missing or unsafe.");
  }
  const expected = createLocalN8nSidecarComposeFile({
    installId: marker.installId,
    networkName: marker.networkName,
    registrationId: marker.registrationId,
    tokenSha256: marker.tokenSha256,
  });
  if (await fileSystem.readFile(path, "utf8") !== expected) {
    throw new Error("The installed SIWC Compose file changed; the owned service was not mutated.");
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

async function acquireSidecarLock({
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
    ".relmio-local-n8n-openai-oauth.lock",
  );
  return acquireLocalIntegrationLifecycleLock({
    fileSystem,
    getProcessIdentity,
    lockDownPath,
    lockPath,
    now,
    // Lock ownership is local-process state, not the caller's Docker fixture.
    platform: process.platform,
    label: "local n8n OAuth sidecar operation lock",
  });
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
  returnDetails = false,
  volumeName = "siwc-store",
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
  const volumeNames = [];
  for (const row of volumeRows) {
    const volumeName = validateDockerName(row?.Name);
    volumeNames.push(volumeName);
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
  const imagePresent = await inspectOwnedImageIfPresent({
    runProcess,
    cwd,
    dockerHost,
    installId,
    projectName,
  });
  if (returnDetails) {
    return {
      exact:
        containerRows.length === 1 &&
        volumeNames.length === 1 &&
        volumeNames[0] === `${projectName}_${volumeName}` &&
        imagePresent,
    };
  }
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
  attestN8n = true,
}) {
  let n8n;
  if (attestN8n) {
  n8n = await inspectContainer({
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
  }
  const network = await inspectNetwork({
    runProcess,
    cwd,
    dockerHost: plan.dockerHost,
    networkName: plan.networkName,
  });
  const normalizedNetwork = validateSelectedNetwork(network, {
    n8nContainerId: attestN8n ? plan.n8nContainerId : undefined,
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
    const connected = attestN8n && connectedId === plan.n8nContainerId
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

async function runSiwcCli({ runProcess, installRoot, marker, command, input }) {
  if (!["host", "accept", "receipt", "account", "account-live", "sign-out", "disable-plan", "enable-plan"].includes(command)) {
    throw new TypeError("The SIWC installation operation is invalid.");
  }
  if (["accept", "receipt"].includes(command)) validateSiwcRegistrationId(marker.registrationId);
  if (command === "receipt" && (!Buffer.isBuffer(input) || input.length > 8192)) {
    throw new TypeError("The handoff receipt request is invalid.");
  }
  const result = await runOrThrow(runProcess, {
    file: "docker",
    args: command === "account-live"
      ? createComposeArgs(marker.projectName, [
          "exec", "-T", SERVICE_NAME, "node", "/app/services/siwc-handoff.mjs", "account",
        ])
      : createComposeArgs(marker.projectName, [
          "run", "--rm", "--no-deps", "-T",
          ...(["accept", "receipt"].includes(command)
            ? ["--env", `RELMIO_REGISTRATION_ID=${marker.registrationId}`] : []),
          "--entrypoint", "node", SERVICE_NAME, "/app/services/siwc-handoff.mjs", command,
        ]),
    cwd: installRoot,
    dockerHost: marker.dockerHost,
    ...(input === undefined ? {} : { input }),
  }, "Local SIWC installation operation");
  if (Buffer.byteLength(result.stdout) > 4096) {
    throw new Error("The SIWC installation returned excessive status data.");
  }
  return parseJson(result.stdout, "SIWC installation status");
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
}

async function verifySidecarCatalog({
  runProcess, installRoot, plan, projectName, clientCredential,
}) {
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
      input: clientCredential,
    },
    "Local sidecar private-network verification",
  );
  return parseModels(verifier.stdout);
}







async function inspectOwnedSidecarRuntime({
  runProcess,
  installRoot,
  marker,
}) {
  const containerIdResult = await runOrThrow(
    runProcess,
    {
      file: "docker",
      args: createComposeArgs(marker.projectName, [
        "ps",
        "--all",
        "-q",
        SERVICE_NAME,
      ]),
      cwd: installRoot,
      dockerHost: marker.dockerHost,
    },
    "Local sidecar refresh identity check",
  );
  if (containerIdResult.stdout.trim() === "") {
    return null;
  }
  const containerId = validateDockerObjectId(
    containerIdResult.stdout.trim(),
    "local sidecar container",
  );
  const sidecar = await inspectContainer({
    runProcess,
    cwd: installRoot,
    dockerHost: marker.dockerHost,
    containerId,
  });
  const sidecarNetwork = sidecar.NetworkSettings?.Networks?.[marker.networkName];
  const ports = sidecar.NetworkSettings?.Ports;
  let imageId;
  try {
    imageId = validateDockerImageDigest(sidecar?.Image);
  } catch {
    throw new Error("The local sidecar refresh identity could not be verified.");
  }
  if (
    sidecar?.Id !== containerId ||
    sidecar?.Config?.Image !== `${marker.projectName}:local` ||
    typeof sidecar?.State?.Running !== "boolean" ||
    typeof sidecar?.State?.Paused !== "boolean" ||
    !labelsMatchOwnedSidecar(sidecar.Config?.Labels, {
      installId: marker.installId,
      projectName: marker.projectName,
    }) ||
    (sidecarNetwork && sidecarNetwork.NetworkID !== marker.dockerNetworkId) ||
    (sidecar.State.Running && (
      sidecarNetwork?.NetworkID !== marker.dockerNetworkId ||
      !Array.isArray(sidecarNetwork?.Aliases) ||
      !sidecarNetwork.Aliases.includes(LOCAL_N8N_SIDECAR_HOSTNAME)
    )) ||
    (sidecar.State.Running && (!ports || typeof ports !== "object" || Array.isArray(ports))) ||
    (ports && (typeof ports !== "object" || Array.isArray(ports) ||
      Object.values(ports).some((bindings) => bindings !== null)))
  ) {
    throw new Error("The local sidecar refresh identity could not be verified.");
  }
  const logicalVolume = marker.schemaVersion === MARKER_SCHEMA_VERSION ? "siwc-store" : "oauth-auth";
  const destination = marker.schemaVersion === MARKER_SCHEMA_VERSION ? "/home/node/.relmio-siwc" : "/home/node/.codex";
  const mounts = sidecar.Mounts;
  if (!Array.isArray(mounts) || mounts.length !== 1 ||
      mounts[0].Type !== "volume" || mounts[0].Name !== `${marker.projectName}_${logicalVolume}` ||
      mounts[0].Destination !== destination || mounts[0].RW !== true) {
    throw new Error("The owned sidecar credential mount changed.");
  }
  return Object.freeze({
    containerId,
    imageId,
    credentialMount: { type: mounts[0].Type, name: mounts[0].Name, destination: mounts[0].Destination },
    health: sidecar.State.Health?.Status,
    paused: sidecar.State.Paused,
    running: sidecar.State.Running,
  });
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
  const projectFilter = `label=com.docker.compose.project=${projectName}`;
  for (const [resource, args, label] of [
    [
      "container",
      ["container", "ls", "--all", "--filter", projectFilter, "--format", "{{json .}}"],
      "containers",
    ],
    [
      "volume",
      ["volume", "ls", "--filter", projectFilter, "--format", "{{json .}}"],
      "credential volumes",
    ],
  ]) {
    const result = await runOrThrow(
      runProcess,
      { file: "docker", args, cwd: installRoot, dockerHost },
      `Local sidecar ${resource} cleanup verification`,
    );
    const records = parseJsonLines(
      result.stdout,
      `Local sidecar ${resource} cleanup verification`,
    );
    if (records.length !== 0) {
      throw new Error(
        `Relmio could not confirm removal of its local sidecar ${label}. The managed directory was kept.`,
      );
    }
  }
}

async function validateReviewedLocalAccount(registration, binding) {
  const record = await readRegistration(registration);
  if (
    record?.registrationId !== binding.registrationId ||
    record?.clientId !== binding.clientId ||
    record?.generation !== binding.generation ||
    record?.owner?.hostId !== binding.ownerHostId ||
    record?.owner?.runtimeId !== binding.ownerRuntimeId ||
    record?.handoff?.state !== "owned" ||
    !record.planEnabled ||
    !record.session?.refreshToken ||
    !record.session?.scopes?.includes("chatgpt.tokens.use.direct")
  ) throw new Error("The selected SIWC account changed. Review the installation again.");
}

async function reviewOwnedN8nReplacement(
  { plan, existingSiwc = false },
  {
    fileSystem = defaultFileSystem, env = process.env,
    homeDirectory = homedir(), runProcess = runLocalProcess,
    platform = process.platform, lockDownPath = lockDownLocalPath,
  } = {},
) {
  assertSupportedPlatform(platform);
  rejectDockerEnvironmentOverrides(env);
  const selected = normalizeLocalN8nSidecarPlan(plan);
  const installRoot = await resolveLocalN8nSidecarInstallRoot({
    env, homeDirectory, fileSystem, platform,
  });
  await verifyWindowsSidecarStatusPathSecurity({
    fileSystem, installRoot, platform, lockDownPath,
  });
  const managed = await inspectManagedInstall({ fileSystem, installRoot });
  const marker = validateMarker(managed.marker);
  if (marker.schemaVersion !== (existingSiwc ? MARKER_SCHEMA_VERSION : 1) ||
      marker.dockerHost !== selected.dockerHost ||
      marker.n8nContainerId !== selected.n8nContainerId ||
      marker.dockerNetworkId !== selected.dockerNetworkId ||
      marker.networkName !== selected.networkName ||
      marker.n8nContainerName !== selected.n8nContainerName) {
    throw new Error("The selected n8n target or old bridge changed before migration.");
  }
  const selectedDockerHost = await resolveLocalDockerHost({
    runProcess, cwd: installRoot, env, platform,
  });
  if (selectedDockerHost !== marker.dockerHost) {
    throw new Error("The selected local Docker context changed.");
  }
  await attestPlanAndAlias({
    plan: selected, runProcess, cwd: installRoot,
    installId: marker.installId, projectName: marker.projectName,
  });
  const ownership = await attestProjectOwnership({
    runProcess, cwd: installRoot, dockerHost: marker.dockerHost,
    installId: marker.installId, projectName: marker.projectName,
    returnDetails: true, volumeName: existingSiwc ? "siwc-store" : "oauth-auth",
  });
  if (!ownership.exact) {
    throw new Error("The old bridge container, image or credential volume is not exactly owned.");
  }
  const runtime = await inspectOwnedSidecarRuntime({
    runProcess, installRoot, marker,
  });
  if (!runtime || runtime.paused) {
    throw new Error("The old bridge refresh writer is missing or ambiguous.");
  }
  const logicalVolume = existingSiwc ? "siwc-store" : "oauth-auth";
  const effective = parseJson((await runOrThrow(runProcess, {
    file: "docker", args: createComposeArgs(marker.projectName, ["config", "--format", "json"]),
    cwd: installRoot, dockerHost: marker.dockerHost,
  }, "Owned sidecar effective Compose check")).stdout, "Owned sidecar effective Compose check");
  const current = effective?.services?.[SERVICE_NAME];
  if (Object.keys(effective?.services ?? {}).length !== (existingSiwc ? 2 : 1) ||
      current?.image !== `${marker.projectName}:local` ||
      current?.volumes?.length !== 1 || current.volumes[0]?.type !== "volume" ||
      current.volumes[0]?.source !== logicalVolume ||
      current.volumes[0]?.target !== runtime.credentialMount.destination ||
      current.volumes[0]?.read_only === true ||
      effective?.volumes?.[logicalVolume]?.name !== runtime.credentialMount.name) {
    throw new Error("The owned sidecar effective credential mapping changed.");
  }
  const volumeIdentity = await readOwnedCredentialVolumeIdentity({
    runProcess, installRoot, marker, volumeName: runtime.credentialMount.name,
  });
  return Object.freeze({
    installId: marker.installId, projectName: marker.projectName,
    dockerHost: marker.dockerHost,
    n8nContainerId: marker.n8nContainerId,
    dockerNetworkId: marker.dockerNetworkId,
    networkName: marker.networkName,
    containerId: runtime.containerId, imageId: runtime.imageId,
    volumeName: runtime.credentialMount.name,
    credentialMount: runtime.credentialMount, volumeIdentity,
    ...(existingSiwc ? {
      registrationId: marker.registrationId,
      ownerHostId: marker.ownerHostId,
    } : {}),
    running: runtime.running,
  });
}

export function reviewLocalN8nLegacyMigration({ plan }, deps = {}) {
  return reviewOwnedN8nReplacement({ plan }, deps);
}

export function reviewLocalN8nSiwcReplacement({ plan }, deps = {}) {
  return reviewOwnedN8nReplacement({ plan, existingSiwc: true }, deps);
}

async function readOwnedCredentialVolumeIdentity({ runProcess, installRoot, marker, volumeName }) {
  validateDockerName(volumeName);
  const volume = parseJson((await runOrThrow(runProcess, {
    file: "docker", args: ["volume", "inspect", "--format", "{{json .}}", volumeName],
    cwd: installRoot, dockerHost: marker.dockerHost,
  }, "Owned credential volume identity check")).stdout, "Owned credential volume identity check");
  requireOwnershipLabels(volume?.Labels, { installId: marker.installId, projectName: marker.projectName, service: false });
  if (volume?.Name !== volumeName || volume.Driver !== "local" ||
      typeof volume.CreatedAt !== "string" || !Number.isFinite(Date.parse(volume.CreatedAt)) ||
      typeof volume.Mountpoint !== "string" || !volume.Mountpoint.startsWith("/") ||
      (volume.Options !== null && Object.keys(volume.Options ?? {}).length !== 0)) {
    throw new Error("The owned credential volume identity changed.");
  }
  return createHash("sha256").update(JSON.stringify({
    name: volume.Name, createdAt: volume.CreatedAt, driver: volume.Driver,
    mountpoint: volume.Mountpoint, options: volume.Options, labels: volume.Labels,
  })).digest("hex");
}

async function attestRetiredN8n({ fileSystem, runProcess, installRoot, binding }) {
  if (!/^[a-f0-9]{32}$/u.test(binding?.installId)) throw new Error("The retired sidecar identity is invalid.");
  const archive = join(installRoot, "legacy", binding.installId);
  const marker = validateMarker(JSON.parse(await fileSystem.readFile(join(archive, MANAGED_MARKER), "utf8")));
  const runtime = await inspectOwnedSidecarRuntime({ runProcess, installRoot: archive, marker });
  if (!runtime || runtime.running || runtime.paused || runtime.containerId !== binding.containerId ||
      runtime.imageId !== binding.imageId ||
      JSON.stringify(runtime.credentialMount) !== JSON.stringify(binding.credentialMount) ||
      await readOwnedCredentialVolumeIdentity({ runProcess, installRoot: archive, marker,
        volumeName: binding.volumeName }) !== binding.volumeIdentity) {
    throw new Error("The retained old sidecar writer or credential volume changed.");
  }
}

export async function reviewLocalN8nSiwcResume(
  { registration, plan: reviewedPlan } = {},
  { fileSystem = defaultFileSystem, env = process.env, homeDirectory = homedir(),
    runProcess = runLocalProcess, platform = process.platform, lockDownPath = lockDownLocalPath } = {},
) {
  rejectDockerEnvironmentOverrides(env);
  const installRoot = await resolveLocalN8nSidecarInstallRoot({ env, homeDirectory, fileSystem, platform });
  const staged = await readLocalSiwcStaging({ fileSystem, installRoot, platform, lockDownPath });
  if (!staged || staged.checkpoint.stage === "completed") throw new Error("There is no interrupted SIWC sidecar to resume.");
  const { checkpoint, checkpointSha256 } = staged;
  let plan = normalizeLocalN8nSidecarPlan(reviewedPlan ?? checkpoint.plan);
  if (reviewedPlan && reviewedPlan.authBinding?.registrationId !== registration?.registrationId) {
    throw new Error("The selected SIWC account does not match the fresh n8n review.");
  }
  for (const field of ["dockerHost", "networkName", "dockerNetworkId"]) {
    if (plan[field] !== checkpoint.plan[field]) throw new Error("The stable SIWC destination changed.");
  }
  if (checkpoint.projectName !== `${PROJECT_PREFIX}-${checkpoint.installId}` ||
      await resolveLocalDockerHost({ runProcess, cwd: homeDirectory, env, platform }) !== checkpoint.dockerHost) {
    throw new Error("The staged SIWC destination changed.");
  }
  await attestProjectOwnership({ runProcess, cwd: homeDirectory, dockerHost: checkpoint.dockerHost,
    installId: checkpoint.installId, projectName: checkpoint.projectName });
  const aliasOwner = checkpoint.reviewedLegacy && !checkpoint.oldStopped ? checkpoint.reviewedLegacy : checkpoint;
  await attestPlanAndAlias({ plan, runProcess, cwd: homeDirectory,
    installId: aliasOwner.installId, projectName: aliasOwner.projectName });
  if (checkpoint.reviewedLegacy && checkpoint.oldStopped) {
    await attestRetiredN8n({ fileSystem, runProcess, installRoot, binding: checkpoint.reviewedLegacy });
  }
  const filesSha256 = await fingerprintLocalSiwcFiles({ fileSystem, installRoot, platform, lockDownPath });
  const resourcesSha256 = await fingerprintLocalSiwcResources({ runProcess, installRoot, checkpoint });
  if (checkpoint.ownerHostId) {
    const { marker } = await inspectManagedInstall({ fileSystem, installRoot });
    if (marker?.installId !== checkpoint.installId || marker?.ownerHostId !== checkpoint.ownerHostId) {
      throw new Error("The staged SIWC owner marker changed.");
    }
    await assertManagedSiwcCompose(fileSystem, installRoot, marker);
  }
  const authBinding = await readLocalSiwcResumeAuthBinding({ checkpoint, registration, readRegistration, readPendingAuthHandoff,
    readReceipt: pending => runSiwcCli({ runProcess, installRoot, marker: checkpoint, command: "receipt",
      input: Buffer.from(JSON.stringify({ handoffId: pending.handoffId, binding: pending.binding, identity: pending.identity })) }) });
  plan = normalizeLocalN8nSidecarPlan({ ...plan, authBinding });
  return { target: LOCAL_N8N_SIDECAR_TARGET, installId: checkpoint.installId,
    registrationId: plan.authBinding.registrationId, stage: checkpoint.stage, plan, checkpointSha256,
    ...(checkpoint.migration ? { migration: checkpoint.migration } : {}),
    filesSha256, resourcesSha256 };
}

export async function reconcileLocalN8nSiwcHandoff(
  { registration, confirmed },
  { fileSystem = defaultFileSystem, env = process.env, homeDirectory = homedir(),
    runProcess = runLocalProcess, platform = process.platform, lockDownPath = lockDownLocalPath,
    getProcessIdentity, lifecycleLockNow = Date.now } = {},
) {
  if (confirmed !== true) throw new Error("Confirm reconciliation of the selected SIWC handoff.");
  validateSiwcRegistrationId(registration?.registrationId);
  rejectDockerEnvironmentOverrides(env);
  const installRoot = await resolveLocalN8nSidecarInstallRoot({ env, homeDirectory, fileSystem, platform });
  const releaseLock = await acquireSidecarLock({ fileSystem, getProcessIdentity, installRoot,
    lockDownPath, now: lifecycleLockNow, platform });
  return settleLocalIntegrationLifecycleOperation({ completionLabel: "Local n8n SIWC handoff reconciliation",
    releaseLock, operation: async () => {
      await fingerprintLocalSiwcFiles({ fileSystem, installRoot, platform, lockDownPath });
      const managed = await inspectManagedInstall({ fileSystem, installRoot });
      const marker = validateMarker(managed.marker);
      if (marker.registrationId !== registration.registrationId) throw new Error("The selected SIWC destination changed.");
      await assertManagedSiwcCompose(fileSystem, installRoot, marker);
      if (await resolveLocalDockerHost({ runProcess, cwd: installRoot, env, platform }) !== marker.dockerHost) {
        throw new Error("The selected Docker context changed.");
      }
      await attestPlanAndAlias({ plan: marker, runProcess, cwd: installRoot,
        installId: marker.installId, projectName: marker.projectName, attestN8n: false });
      await attestProjectOwnership({ runProcess, cwd: installRoot, dockerHost: marker.dockerHost,
        installId: marker.installId, projectName: marker.projectName });
      const source = await readRegistration(registration);
      const pending = await readPendingAuthHandoff(registration);
      const request = pending ?? (source?.handoff?.state === "transferred" ? {
        handoffId: source.handoff.handoffId, binding: source.handoff.receipt.binding,
        target: source.handoff.receipt.binding.target,
        identity: { issuer: source.identity.issuer, clientId: source.clientId, subject: source.identity.subject },
      } : null);
      if (!request || request.target.hostId !== marker.ownerHostId || request.target.runtimeId !== marker.installId) {
        throw new Error("The frozen handoff does not match this destination.");
      }
      let receipt;
      try {
        ({ receipt } = await runSiwcCli({ runProcess, installRoot, marker, command: "receipt",
          input: Buffer.from(JSON.stringify({ handoffId: request.handoffId,
            binding: request.binding, identity: request.identity })) }));
      } catch {
        throw Object.assign(new Error("The SIWC receipt outcome is unresolved. The source remains frozen."), { remoteOutcomeUnknown: true });
      }
      if (receipt === null) {
        await assertNoLocalSiwcOneOffContainers({ runProcess, installRoot,
          dockerHost: marker.dockerHost, projectName: marker.projectName });
        const staged = await readLocalSiwcStaging({ fileSystem, installRoot, platform, lockDownPath });
        if (!staged || staged.checkpoint.registrationId !== registration.registrationId) {
          throw new Error("The original SIWC checkpoint changed.");
        }
        staged.checkpoint.notAccepted = true;
        const path = localSiwcStagingPath(installRoot);
        await writeManagedFile(fileSystem, path, `${JSON.stringify(staged.checkpoint)}\n`, 0o600);
        if (platform === "win32") await lockDownPath(path, { platform, kind: "file" });
        return { outcome: "not-accepted",
          account: (await listRegistrations({ storageRoot: registration.storageRoot })).find(
            account => account.registrationId === registration.registrationId) };
      }
      if (receipt?.handoffId !== request.handoffId ||
          JSON.stringify(receipt.binding) !== JSON.stringify(request.binding)) throw new Error("The SIWC receipt binding changed.");
      return { outcome: "finished", account: await finishAuthHandoff(registration, {
        handoffId: request.handoffId, receipt: receipt.receipt }) };
    } });
}

export async function installLocalN8nSidecar(
  { plan, registration, backgroundConsent, confirmed, migrationConsent, legacyBinding, replacementConsent, existingBinding, resume },
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
    collectAssets = collectSiwcRuntimeAssets,
  } = {},
) {
  if (confirmed !== true) {
    throw new Error("Confirm the reviewed private n8n bridge plan before installing.");
  }
  assertSupportedPlatform(platform);
  rejectDockerEnvironmentOverrides(env);
  const selected = normalizeLocalN8nSidecarPlan(plan);
  const binding = validateSiwcAuthBinding(selected.authBinding);
  if (registration?.registrationId !== binding.registrationId || !registration.storageRoot) {
    throw new Error("The selected SIWC account does not match the reviewed bridge.");
  }
  const safeConsent = Object.freeze({
    ...validateSiwcBackgroundConsent(backgroundConsent, { target: "local-n8n" }),
  });
  if (!resume) await validateReviewedLocalAccount(registration, binding);
  const installRoot = await resolveLocalN8nSidecarInstallRoot({
    env, homeDirectory, fileSystem, platform,
  });
  const releaseLock = await acquireSidecarLock({
    fileSystem, getProcessIdentity, installRoot, lockDownPath,
    now: lifecycleLockNow, platform,
  });
  let preservedResult;
  return settleLocalIntegrationLifecycleOperation({
    completionLabel: "Local n8n SIWC sidecar installation",
    releaseLock,
    operation: async () => {
      try {
      const staged = await readLocalSiwcStaging({ fileSystem, installRoot, platform, lockDownPath });
      if (staged && staged.checkpoint.stage !== "completed" && !resume) {
        throw new Error("Review the interrupted SIWC sidecar before resuming.");
      }
      let handoffCommitted = false;
      if (resume) {
        const reviewed = await reviewLocalN8nSiwcResume({ registration, plan: selected },
          { fileSystem, env, homeDirectory, runProcess, platform, lockDownPath });
        if (JSON.stringify(reviewed) !== JSON.stringify(resume) ||
            JSON.stringify(reviewed.plan) !== JSON.stringify(selected)) {
          throw new Error("The reviewed SIWC resume binding changed.");
        }
        const source = await readRegistration(registration);
        if (source?.handoff?.state === "handoff-pending") throw new Error("Reconcile the frozen handoff before resuming.");
        handoffCommitted = source?.handoff?.state === "transferred";
        if (!handoffCommitted) await validateReviewedLocalAccount(registration, binding);
        else if (source.handoff.receipt.binding.target.runtimeId !== staged.checkpoint.installId ||
                 source.handoff.receipt.binding.target.hostId !== staged.checkpoint.ownerHostId) {
          throw new Error("The completed handoff belongs to another destination.");
        }
      }
      const managed = await inspectManagedInstall({ fileSystem, installRoot, staging: staged?.checkpoint });
      const migrating = migrationConsent !== undefined || legacyBinding !== undefined || resume?.migration === "legacy";
      const replacing = replacementConsent !== undefined || existingBinding !== undefined || resume?.migration === "replacement";
      const retiring = migrating || replacing;
      let reviewedLegacy = resume ? staged.checkpoint.reviewedLegacy ?? null : null;
      if (retiring && !(resume && staged.checkpoint.oldStopped)) {
        const expectedSchema = replacing ? MARKER_SCHEMA_VERSION : 1;
        if ((migrating && replacing) ||
            (!resume && migrating && migrationConsent !== true) ||
            (!resume && replacing && replacementConsent !== true) ||
            managed.marker?.schemaVersion !== expectedSchema) {
          throw new Error("Explicit reviewed old-bridge replacement consent is required.");
        }
        const inspect = replacing
          ? reviewLocalN8nSiwcReplacement : reviewLocalN8nLegacyMigration;
        reviewedLegacy = await inspect(
          { plan: selected },
          { fileSystem, env, homeDirectory, runProcess, platform, lockDownPath },
        );
        const expected = resume ? staged.checkpoint.reviewedLegacy : replacing ? existingBinding : legacyBinding;
        for (const field of [
          "installId", "projectName", "dockerHost", "n8nContainerId",
          "dockerNetworkId", "networkName", "containerId", "imageId",
          "volumeName", "volumeIdentity", "running",
          ...(replacing ? ["registrationId", "ownerHostId"] : []),
        ]) {
          if (expected?.[field] !== reviewedLegacy[field]) {
            throw new Error("The reviewed old n8n sidecar identity changed.");
          }
        }
        if (JSON.stringify(expected?.credentialMount) !== JSON.stringify(reviewedLegacy.credentialMount)) {
          throw new Error("The reviewed credential mount changed.");
        }
        if (replacing && reviewedLegacy.registrationId === binding.registrationId) {
          throw new Error("A replacement requires a fresh independently authorized SIWC registration.");
        }
      } else if (managed.marker && !resume) {
        throw new Error("The existing bridge requires a separately reviewed migration or account replacement.");
      }
      const identityBytes = randomBytes(32);
      const capabilityBytes = randomBytes(32);
      if (!Buffer.isBuffer(identityBytes) || identityBytes.length !== 32 ||
          !Buffer.isBuffer(capabilityBytes) || capabilityBytes.length !== 32) {
        throw new Error("Relmio could not generate a strong installation identity and local capability.");
      }
      const installId = resume ? staged.checkpoint.installId : identityBytes.subarray(0, 16).toString("hex");
      if (retiring && installId === reviewedLegacy.installId) {
        throw new Error("The fresh SIWC sidecar identity collided with the old project.");
      }
      const projectName = `${PROJECT_PREFIX}-${installId}`;
      const clientCredential = capabilityBytes.toString("base64url");
      const tokenSha256 = createHash("sha256").update(clientCredential).digest("hex");
      const runtime = { installId, projectName, dockerHost: selected.dockerHost, registrationId: binding.registrationId };
      if (handoffCommitted) {
        const account = (await runSiwcCli({ runProcess, installRoot, marker: runtime, command: "account" })).account;
        if (account?.registrationId !== binding.registrationId || account?.ownerHostId !== staged.checkpoint.ownerHostId ||
            account?.ownerRuntimeId !== installId || account?.ownership !== "owned") {
          throw new Error("The resumed destination account changed.");
        }
        preservedResult = { target: LOCAL_N8N_SIDECAR_TARGET, endpoint: LOCAL_N8N_SIDECAR_ENDPOINT,
          protocol: "openai-v1", clientCredential, credentialShownOnce: true, models: [],
          networkName: selected.networkName, hostPublication: "unknown", account, runtimeState: "unknown" };
      }
      const cwd = dirname(resolve(installRoot, "..", ".."));
      await attestProjectOwnership({
        runProcess, cwd, dockerHost: selected.dockerHost, installId, projectName,
      });
      if (!retiring) {
        await attestPlanAndAlias({
          plan: selected, runProcess, cwd, installId, projectName,
        });
      }
      const checkpoint = resume ? staged.checkpoint : {
        schemaVersion: 1, target: LOCAL_N8N_SIDECAR_TARGET, installId, projectName,
        dockerHost: selected.dockerHost, registrationId: binding.registrationId,
        plan: selected, stage: "staged",
        ...(retiring ? { reviewedLegacy, migration: replacing ? "replacement" : "legacy",
          ...(replacing ? { previousGeneration: existingBinding.expectedGeneration } : {}) } : {}),
      };
      if (resume) {
        if (checkpoint.registrationId !== binding.registrationId) {
          await assertNoLocalSiwcOneOffContainers({ runProcess, installRoot,
            dockerHost: selected.dockerHost, projectName });
        }
        checkpoint.registrationId = binding.registrationId;
        checkpoint.plan = selected;
        checkpoint.notAccepted = false;
      }
      const saveStage = async stage => {
        checkpoint.stage = stage;
        const path = localSiwcStagingPath(installRoot);
        await writeManagedFile(fileSystem, path, `${JSON.stringify(checkpoint)}\n`, 0o600);
        if (platform === "win32") await lockDownPath(path, { platform, kind: "file" });
      };
      await saveStage(checkpoint.stage);
      await initializeManagedDirectories({
        fileSystem, installRoot, baseExists: managed.baseExists, platform, lockDownPath,
      });
      const write = async (path, contents) => {
        const fullPath = join(installRoot, path);
        await writeManagedFile(fileSystem, fullPath, contents, 0o600);
        if (platform === "win32") await lockDownPath(fullPath, { platform, kind: "file" });
      };
      let legacyArchive = retiring ? join(installRoot, "legacy", reviewedLegacy.installId) : null;
      if (retiring && !(resume && checkpoint.oldStopped)) {
        await validateReviewedLocalAccount(registration, binding);
        const inspect = replacing
          ? reviewLocalN8nSiwcReplacement : reviewLocalN8nLegacyMigration;
        const freshPrevious = await inspect(
          { plan: selected },
          { fileSystem, env, homeDirectory, runProcess, platform, lockDownPath },
        );
        for (const field of [
          "installId", "projectName", "dockerHost", "n8nContainerId",
          "dockerNetworkId", "networkName", "containerId", "imageId",
          "volumeName", "volumeIdentity", "running",
          ...(replacing ? ["registrationId", "ownerHostId"] : []),
        ]) {
          if (freshPrevious[field] !== reviewedLegacy[field]) {
            throw new Error("The old n8n sidecar changed before replacement. Review again.");
          }
        }
        if (JSON.stringify(freshPrevious.credentialMount) !== JSON.stringify(reviewedLegacy.credentialMount)) {
          throw new Error("The old credential mount changed before replacement.");
        }
        if (replacing) {
          const old = (await runSiwcCli({
            runProcess, installRoot, marker: managed.marker, command: "account",
          })).account;
          if (old?.registrationId !== reviewedLegacy.registrationId ||
              old?.ownerHostId !== reviewedLegacy.ownerHostId ||
              old?.generation !== (resume ? checkpoint.previousGeneration : existingBinding.expectedGeneration) ||
              old?.session !== "signed-out" || old?.planEnabled !== false) {
            throw new Error("Sign out of the exact old SIWC account before reviewed replacement.");
          }
        }
        const legacyRoot = join(installRoot, "legacy");
        legacyArchive = join(legacyRoot, reviewedLegacy.installId);
        if (!resume && await lstatIfExists(fileSystem, legacyArchive)) {
          throw new Error("A prior n8n sidecar replacement is incomplete. Inspect it before retrying.");
        }
        await ensurePrivateDirectory(fileSystem, legacyRoot, platform, lockDownPath);
        await ensurePrivateDirectory(fileSystem, legacyArchive, platform, lockDownPath);
        const retain = async (filename, contents) => {
          const path = join(legacyArchive, filename);
          await writeManagedFile(fileSystem, path, contents, 0o600);
          if (platform === "win32") await lockDownPath(path, { platform, kind: "file" });
        };
        for (const filename of [
          MANAGED_MARKER, COMPOSE_FILENAME, "Dockerfile", ".dockerignore",
          ...(replacing ? ["package.json", "package-lock.json"] : []),
        ]) {
          const oldPath = join(installRoot, filename);
          const metadata = await lstatIfExists(fileSystem, oldPath);
          if (!metadata?.isFile?.() || metadata.isSymbolicLink() ||
              metadata.size > 1024 * 1024 ||
              (platform !== "win32" && (metadata.mode & 0o077) !== 0)) {
            throw new Error("The old bridge generated files are missing or unsafe.");
          }
          if (platform === "win32") {
            await lockDownPath(oldPath, {
              platform, kind: "file", verifyOnly: true, verifyEffectiveOwnerOnly: true,
            });
          }
          await retain(filename, await fileSystem.readFile(oldPath));
        }
        const oldRuntimePath = join(installRoot, "openai-oauth-sidecar.mjs");
        const oldRuntime = await lstatIfExists(fileSystem, oldRuntimePath);
        if (oldRuntime) {
          if (!oldRuntime.isFile() || oldRuntime.isSymbolicLink() ||
              oldRuntime.size > 1024 * 1024) {
            throw new Error("The old bridge runtime file is unsafe.");
          }
          await retain("openai-oauth-sidecar.mjs", await fileSystem.readFile(oldRuntimePath));
        }
        const journal = async state => retain("migration.json", Buffer.from(
          `${JSON.stringify({
            schemaVersion: 1, state, reviewedLegacy,
            replacementInstallId: installId, previousWasSiwc: replacing,
          })}\n`,
        ));
        await journal("prepared");
        if (reviewedLegacy.running) {
          await runOrThrow(runProcess, {
            file: "docker",
            args: createComposeArgs(reviewedLegacy.projectName, [
              "stop", "--timeout", "30", SERVICE_NAME,
            ]),
            cwd: installRoot, dockerHost: reviewedLegacy.dockerHost,
          }, "Attested old n8n sidecar drain");
        }
        const stoppedPrevious = await inspect(
          { plan: selected },
          { fileSystem, env, homeDirectory, runProcess, platform, lockDownPath },
        );
        for (const field of [
          "installId", "projectName", "dockerHost", "n8nContainerId",
          "dockerNetworkId", "networkName", "containerId", "imageId", "volumeName", "volumeIdentity",
          ...(replacing ? ["registrationId", "ownerHostId"] : []),
        ]) {
          if (stoppedPrevious[field] !== reviewedLegacy[field]) {
            throw new Error("The old sidecar identity changed while stopping. It will not be resumed automatically.");
          }
        }
        if (stoppedPrevious.running) {
          throw new Error("The old credential refresh writer did not stop.");
        }
        if (JSON.stringify(stoppedPrevious.credentialMount) !== JSON.stringify(reviewedLegacy.credentialMount)) {
          throw new Error("The old credential mount changed while stopping.");
        }
        if (replacing) {
          const old = (await runSiwcCli({
            runProcess, installRoot, marker: managed.marker, command: "account",
          })).account;
          if (old?.registrationId !== reviewedLegacy.registrationId ||
              old?.generation !== (resume ? checkpoint.previousGeneration : existingBinding.expectedGeneration) ||
              old?.session !== "signed-out" || old?.planEnabled !== false) {
            throw new Error("The old signed-out SIWC account changed. The retired bridge remains stopped.");
          }
        }
        await journal("stopped");
        checkpoint.oldStopped = true;
        await saveStage("staged");
      }
      if (handoffCommitted) {
        await runOrThrow(runProcess, { file: "docker",
          args: createComposeArgs(projectName, ["stop", "--timeout", "30", SERVICE_NAME]),
          cwd: installRoot, dockerHost: selected.dockerHost }, "Resumed owned sidecar stop");
        const running = await runOrThrow(runProcess, { file: "docker",
          args: createComposeArgs(projectName, ["ps", "--status", "running", "--services", SERVICE_NAME]),
          cwd: installRoot, dockerHost: selected.dockerHost }, "Resumed owned sidecar stopped check");
        if (running.stdout.trim() !== "") throw new Error("The resumed sidecar did not stop.");
      }
      const assets = await collectAssets();
      for (const folder of ["services", "gateway", "infrastructure"]) {
        await ensurePrivateDirectory(fileSystem, join(installRoot, folder), platform, lockDownPath);
      }
      await write("Dockerfile", createLocalN8nSidecarDockerfile({ installId }));
      await write(".dockerignore", createLocalN8nSidecarDockerignore());
      await write("package.json", assets.packageJson);
      await write("package-lock.json", assets.packageLock);
      for (const asset of assets.files) {
        if (!SIWC_ASSET_PATHS.has(asset.path) || !Buffer.isBuffer(asset.contents)) {
          throw new Error("The packaged SIWC runtime assets are invalid.");
        }
        await write(asset.path, asset.contents);
      }
      await write(COMPOSE_FILENAME, createLocalN8nSidecarComposeFile({
        installId, networkName: selected.networkName,
        registrationId: binding.registrationId, tokenSha256,
      }));
      await runOrThrow(runProcess, {
        file: "docker", args: createComposeArgs(projectName, ["config", "--quiet"]),
        cwd: installRoot, dockerHost: selected.dockerHost,
      }, "Local sidecar Compose validation");
      await attestProjectOwnership({
        runProcess, cwd: installRoot, dockerHost: selected.dockerHost,
        installId, projectName,
      });
      await attestPlanAndAlias({
        plan: selected, runProcess, cwd: installRoot, installId, projectName,
      });
      await runOrThrow(runProcess, {
        file: "docker", args: createComposeArgs(projectName, ["build", SERVICE_NAME]),
        cwd: installRoot, dockerHost: selected.dockerHost,
      }, "Local SIWC image build");
      await runOrThrow(runProcess, {
        file: "docker", args: createComposeArgs(projectName, [
          "run", "--rm", "--no-deps", "-T", "credential-seed",
        ]),
        cwd: installRoot, dockerHost: selected.dockerHost,
      }, "Local SIWC private volume initialization");
      const destination = await runSiwcCli({
        runProcess, installRoot, marker: runtime, command: "host",
      });
      validateSiwcHostId(destination?.hostId);
      if (destination.runtimeId !== installId || destination.hostId === binding.ownerHostId ||
          (handoffCommitted && destination.hostId !== checkpoint.ownerHostId)) {
        throw new Error("The local SIWC destination host identity is invalid.");
      }
      await write(MANAGED_MARKER, `${JSON.stringify({
        schemaVersion: MARKER_SCHEMA_VERSION, kind: "relmio-local-n8n-sidecar",
        target: LOCAL_N8N_SIDECAR_TARGET, installId, projectName,
        dockerHost: selected.dockerHost,
        n8nContainerId: selected.n8nContainerId,
        n8nContainerName: selected.n8nContainerName,
        dockerNetworkId: selected.dockerNetworkId,
        networkName: selected.networkName,
        registrationId: binding.registrationId, clientId: binding.clientId,
        ownerHostId: destination.hostId, tokenSha256,
        ...(retiring ? {
          legacyInstallId: reviewedLegacy.installId,
          ...(replacing ? { previousWasSiwc: true } : {}),
        } : {}),
      })}\n`);
      checkpoint.ownerHostId = destination.hostId;
      await saveStage("prepared");
      await attestPlanAndAlias({
        plan: selected, runProcess, cwd: installRoot, installId, projectName,
      });
      let accepted;
      if (handoffCommitted) {
        const account = (await runSiwcCli({ runProcess, installRoot, marker: runtime, command: "account" })).account;
        if (account?.registrationId !== binding.registrationId || account?.ownerHostId !== destination.hostId ||
            account?.ownerRuntimeId !== installId || account?.ownership !== "owned") {
          throw new Error("The resumed SIWC destination account changed.");
        }
        accepted = { account };
      } else {
      await validateReviewedLocalAccount(registration, binding);
      const { handoffId } = await prepareAuthHandoff(registration, {
        expectedGeneration: binding.generation, target: destination, backgroundConsent: safeConsent,
      });
      await saveStage("handoff-pending");
      const contents = await readAuthHandoff(registration, {
        handoffId, expectedGeneration: binding.generation,
      });
      // Acceptance is attempted once; recovery reads its durable receipt.
      try {
        accepted = await runSiwcCli({
          runProcess, installRoot, marker: runtime, command: "accept", input: contents,
        });
      } catch (error) {
        throw Object.assign(new Error("The SIWC transfer outcome is unresolved. The source remains frozen; reconcile the destination before retrying."),
          { remoteOutcomeUnknown: true });
      }
      if (accepted?.handoffId !== handoffId ||
          accepted.account?.registrationId !== binding.registrationId ||
          accepted.account?.ownerHostId !== destination.hostId ||
          accepted.account?.ownerRuntimeId !== installId ||
          accepted.account?.ownership !== "owned") {
        throw new Error("The SIWC handoff receipt or destination account did not match. The source remains frozen.");
      }
      preservedResult = { target: LOCAL_N8N_SIDECAR_TARGET, endpoint: LOCAL_N8N_SIDECAR_ENDPOINT,
        protocol: "openai-v1", clientCredential, credentialShownOnce: true, models: [],
        networkName: selected.networkName, hostPublication: "none",
        account: accepted.account, runtimeState: "stopped" };
      await finishAuthHandoff(registration, { handoffId, receipt: accepted.receipt });
      handoffCommitted = true;
      }
      try {
        await saveStage("transferred");
        await runOrThrow(runProcess, {
          file: "docker",
          args: createComposeArgs(projectName, [
            "up", "-d", "--wait", "--wait-timeout", "90", "--no-deps", SERVICE_NAME,
          ]),
          cwd: installRoot, dockerHost: selected.dockerHost,
        }, "Local SIWC sidecar start");
        await verifyRunningSidecar({
          runProcess, installRoot, plan: selected, installId, projectName,
        });
      } catch (error) {
        let stopped = false;
        try {
          await runOrThrow(runProcess, {
            file: "docker",
            args: createComposeArgs(projectName, [
              "stop", "--timeout", "30", SERVICE_NAME,
            ]),
            cwd: installRoot, dockerHost: selected.dockerHost,
          }, "Unverified sidecar stop");
          const running = await runOrThrow(runProcess, {
            file: "docker",
            args: createComposeArgs(projectName, [
              "ps", "--status", "running", "--services", SERVICE_NAME,
            ]),
            cwd: installRoot, dockerHost: selected.dockerHost,
          }, "Unverified sidecar stopped check");
          stopped = running.stdout.trim() === "";
        } catch {
          // A disconnected Docker operation leaves this owned service uncertain.
        }
        const unsafePublication = /published.*host port/iu.test(error?.message ?? "");
        return {
          target: LOCAL_N8N_SIDECAR_TARGET,
          endpoint: LOCAL_N8N_SIDECAR_ENDPOINT,
          protocol: "openai-v1", clientCredential, credentialShownOnce: true,
          models: [], networkName: selected.networkName,
          hostPublication: stopped ? "none" : "unknown",
          deploymentMode: "partial", account: accepted.account,
          readiness: "unverified", runtimeState: stopped ? "stopped" : "unknown",
          runtimeFailure: unsafePublication
            ? { error: "The sidecar may have published a host port. Inspect it before use.",
                status: 503, recovery: "resolve-handoff" }
            : safeSiwcRuntimeFailure(),
          finalizationFailure: {
            error: "Ownership transferred, but the runtime could not be verified. Save the one-time key and resolve recovery before use.",
            recovery: "resolve-handoff",
          },
          ...(migrating ? { migrationPending: true, legacyRetained: true } : {}),
          ...(replacing ? { replacementPending: true, oldHistoryRetained: true } : {}),
        };
      }
      let models = [];
      let catalogFailure;
      try {
        models = await verifySidecarCatalog({
          runProcess, installRoot, plan: selected, projectName, clientCredential,
        });
      } catch (error) {
        catalogFailure = safeSiwcCatalogFailure(error);
      }
      let account = accepted.account;
      let status;
      try {
        status = await runSiwcCli({
          runProcess, installRoot, marker: runtime, command: "account-live",
        });
      } catch {
        catalogFailure ??= safeSiwcCatalogFailure({
          code: "owner_status_unavailable", recovery: "retry-later",
        });
      }
      if (status) {
        if (status.account?.registrationId !== binding.registrationId ||
            status.account.ownerHostId !== destination.hostId ||
            status.account.ownerRuntimeId !== installId ||
            status.account.ownership !== "owned") {
          return localSiwcFinalizationFailure({
            target: LOCAL_N8N_SIDECAR_TARGET, endpoint: LOCAL_N8N_SIDECAR_ENDPOINT,
            protocol: "openai-v1", clientCredential, credentialShownOnce: true,
            models: [], networkName: selected.networkName, hostPublication: "none",
            account, runtimeState: "running",
          }, "resolve-handoff");
        }
        account = status.account;
      }
      try {
      if (retiring) {
        const journalPath = join(legacyArchive, "migration.json");
        await writeManagedFile(fileSystem, journalPath, Buffer.from(
          `${JSON.stringify({
            schemaVersion: 1, state: "transferred",
            reviewedLegacy, replacementInstallId: installId,
            previousWasSiwc: replacing,
          })}\n`,
        ), 0o600);
        if (platform === "win32") {
          await lockDownPath(journalPath, { platform, kind: "file" });
        }
      }
      await saveStage("completed");
      } catch {
        return localSiwcFinalizationFailure({
          target: LOCAL_N8N_SIDECAR_TARGET, endpoint: LOCAL_N8N_SIDECAR_ENDPOINT,
          protocol: "openai-v1", clientCredential, credentialShownOnce: true,
          models, networkName: selected.networkName, hostPublication: "none",
          account, runtimeState: "running",
          ...(migrating ? { migrationPending: true, legacyRetained: true } : {}),
          ...(replacing ? { replacementPending: true, oldHistoryRetained: true } : {}),
        });
      }
      return {
        target: LOCAL_N8N_SIDECAR_TARGET,
        endpoint: LOCAL_N8N_SIDECAR_ENDPOINT,
        protocol: "openai-v1", clientCredential, credentialShownOnce: true,
        models, networkName: selected.networkName, hostPublication: "none",
        deploymentMode: migrating ? "migrated" : replacing ? "replaced" : "installed", account,
        readiness: catalogFailure ? "unverified" : "verified",
        runtimeState: "running",
        ...(catalogFailure ? { catalogFailure } : {}),
        ...(migrating ? { migratedLegacy: true, legacyRetained: true } : {}),
        ...(replacing ? { replacedAccount: true, oldHistoryRetained: true } : {}),
      };
      } catch (error) {
        if (preservedResult) return localSiwcFinalizationFailure(preservedResult, "resolve-handoff");
        throw error;
      }
    },
  });
}






export async function inspectStoppedLocalN8nSiwcInstallation(
  { registrationId, confirmed },
  {
    fileSystem = defaultFileSystem, env = process.env,
    homeDirectory = homedir(), runProcess = runLocalProcess,
    platform = process.platform, lockDownPath = lockDownLocalPath,
    getProcessIdentity, lifecycleLockNow = Date.now,
  } = {},
) {
  if (confirmed !== true) {
    throw new Error("Confirm inspection of the stopped local n8n SIWC account.");
  }
  validateSiwcRegistrationId(registrationId);
  assertSupportedPlatform(platform);
  rejectDockerEnvironmentOverrides(env);
  const installRoot = await resolveLocalN8nSidecarInstallRoot({
    env, homeDirectory, fileSystem, platform,
  });
  const releaseLock = await acquireSidecarLock({
    fileSystem, getProcessIdentity, installRoot, lockDownPath,
    now: lifecycleLockNow, platform,
  });
  return settleLocalIntegrationLifecycleOperation({
    completionLabel: "Stopped local n8n SIWC inspection",
    releaseLock,
    operation: async () => {
      await verifyWindowsSidecarStatusPathSecurity({
        fileSystem, installRoot, platform, lockDownPath,
      });
      const managed = await inspectManagedInstall({ fileSystem, installRoot });
      const marker = validateMarker(managed.marker);
      if (marker.registrationId !== registrationId) {
        throw new Error("The selected account is not installed in this bridge.");
      }
      await assertManagedSiwcCompose(fileSystem, installRoot, marker);
      const selectedDockerHost = await resolveLocalDockerHost({
        runProcess, cwd: installRoot, env, platform,
      });
      if (selectedDockerHost !== marker.dockerHost) {
        throw new Error("The selected Docker context changed.");
      }
      await attestPlanAndAlias({
        plan: marker, runProcess, cwd: installRoot,
        installId: marker.installId, projectName: marker.projectName,
      });
      const ownership = await attestProjectOwnership({
        runProcess, cwd: installRoot, dockerHost: marker.dockerHost,
        installId: marker.installId, projectName: marker.projectName,
        returnDetails: true,
      });
      if (!ownership.exact) throw new Error("The exact owned bridge is missing.");
      const runtime = await inspectOwnedSidecarRuntime({ runProcess, installRoot, marker });
      if (!runtime || runtime.running || runtime.paused) {
        throw new Error("The owned sidecar is not safely stopped.");
      }
      const account = (await runSiwcCli({
        runProcess, installRoot, marker, command: "account",
      })).account;
      if (account?.registrationId !== registrationId ||
          account?.ownerHostId !== marker.ownerHostId ||
          account?.ownerRuntimeId !== marker.installId ||
          account?.ownership !== "owned") {
        throw new Error("The stopped SIWC account could not be attested.");
      }
      return { account };
    },
  });
}

export async function manageLocalN8nSiwcInstallation(
  { registrationId, action, expectedGeneration, backgroundConsent, confirmed },
  {
    fileSystem = defaultFileSystem, env = process.env,
    homeDirectory = homedir(), runProcess = runLocalProcess,
    platform = process.platform, lockDownPath = lockDownLocalPath,
    getProcessIdentity, lifecycleLockNow = Date.now,
  } = {},
) {
  if (confirmed !== true ||
      !["sign-out", "disable-plan", "enable-plan"].includes(action) ||
      (action === "enable-plan" && backgroundConsent !== true)) {
    throw new Error("Confirm the selected installed SIWC account and background workflow consent.");
  }
  validateSiwcRegistrationId(registrationId);
  if (typeof expectedGeneration !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(expectedGeneration)) {
    throw new TypeError("The selected SIWC account generation is invalid.");
  }
  assertSupportedPlatform(platform);
  rejectDockerEnvironmentOverrides(env);
  const installRoot = await resolveLocalN8nSidecarInstallRoot({
    env, homeDirectory, fileSystem, platform,
  });
  const releaseLock = await acquireSidecarLock({
    fileSystem, getProcessIdentity, installRoot, lockDownPath,
    now: lifecycleLockNow, platform,
  });
  return settleLocalIntegrationLifecycleOperation({
    completionLabel: "Installed local n8n SIWC account operation",
    releaseLock,
    operation: async () => {
      await verifyWindowsSidecarStatusPathSecurity({
        fileSystem, installRoot, platform, lockDownPath,
      });
      const managed = await inspectManagedInstall({ fileSystem, installRoot });
      const marker = validateMarker(managed.marker);
      if (marker.registrationId !== registrationId) {
        throw new Error("The selected SIWC account is not installed in this bridge.");
      }
      await assertManagedSiwcCompose(fileSystem, installRoot, marker);
      const selectedDockerHost = await resolveLocalDockerHost({
        runProcess, cwd: installRoot, env, platform,
      });
      if (selectedDockerHost !== marker.dockerHost) {
        throw new Error("The selected Docker context changed.");
      }
      await attestPlanAndAlias({
        plan: marker, runProcess, cwd: installRoot,
        installId: marker.installId, projectName: marker.projectName,
      });
      const ownership = await attestProjectOwnership({
        runProcess, cwd: installRoot, dockerHost: marker.dockerHost,
        installId: marker.installId, projectName: marker.projectName,
        returnDetails: true,
      });
      if (!ownership.exact) throw new Error("The exact owned sidecar project is missing.");
      const runtime = await inspectOwnedSidecarRuntime({ runProcess, installRoot, marker });
      if (!runtime || runtime.paused) {
        throw new Error("The owned sidecar state is ambiguous; account mutation was not attempted.");
      }
      const before = (await runSiwcCli({
        runProcess, installRoot, marker, command: "account",
      })).account;
      if (before?.registrationId !== registrationId ||
          before?.generation !== expectedGeneration ||
          before?.ownerHostId !== marker.ownerHostId ||
          before?.ownerRuntimeId !== marker.installId ||
          before?.ownership !== "owned") {
        throw new Error("The installed SIWC account changed; review it again.");
      }
      if (action === "enable-plan" &&
          (before.planPermission !== "granted" || before.session !== "connected")) {
        throw new Error("This installed account needs a fresh authorized SIWC sign-in before plan use can resume.");
      }
      // Before the account goes and while the sidecar still runs, as on a VPS: a later sign-in on this
      // volume must not inherit the image sign-in.
      const imagesRevocation = action === "sign-out"
        ? await signOutLocalCodexImages({ runProcess, installRoot, marker, running: runtime.running })
        : undefined;
      await runOrThrow(runProcess, {
        file: "docker",
        args: createComposeArgs(marker.projectName, ["stop", "--timeout", "30", SERVICE_NAME]),
        cwd: installRoot, dockerHost: marker.dockerHost,
      }, "Owned local sidecar stop");
      const stopped = await inspectOwnedSidecarRuntime({ runProcess, installRoot, marker });
      if (!stopped || stopped.containerId !== runtime.containerId ||
          stopped.running || stopped.paused) {
        throw new Error("The owned sidecar did not stop; account mutation was not attempted.");
      }
      const changed = await runSiwcCli({
        runProcess, installRoot, marker, command: action,
        input: Buffer.from(JSON.stringify({
          registrationId, expectedGeneration,
          ...(action === "enable-plan" ? { backgroundConsent: true } : {}),
        })),
      });
      if (changed.account?.registrationId !== registrationId ||
          changed.account?.ownerHostId !== marker.ownerHostId ||
          changed.account?.ownerRuntimeId !== marker.installId ||
          changed.account?.ownership !== "owned") {
        throw new Error("The installed SIWC account result could not be attested.");
      }
      if (action === "enable-plan") {
        if (changed.account.planEnabled !== true ||
            changed.account.planPermission !== "granted") {
          throw new Error("The installed SIWC grant could not be confirmed. The sidecar remains stopped.");
        }
        try {
        await runOrThrow(runProcess, {
          file: "docker",
          args: createComposeArgs(marker.projectName, [
            "up", "-d", "--wait", "--wait-timeout", "90",
            "--no-build", "--no-deps", SERVICE_NAME,
          ]),
          cwd: installRoot, dockerHost: marker.dockerHost,
        }, "Owned SIWC sidecar start");
        await verifyRunningSidecar({
          runProcess, installRoot, plan: marker,
          installId: marker.installId, projectName: marker.projectName,
        });
        } catch {
          let stoppedAfterFailure = false;
          try {
            await runOrThrow(runProcess, { file: "docker",
              args: createComposeArgs(marker.projectName, ["stop", "--timeout", "30", SERVICE_NAME]),
              cwd: installRoot, dockerHost: marker.dockerHost }, "Unverified enabled sidecar stop");
            const verified = await inspectOwnedSidecarRuntime({ runProcess, installRoot, marker });
            stoppedAfterFailure = !!verified && !verified.running && !verified.paused &&
              verified.containerId === runtime.containerId && verified.imageId === runtime.imageId;
          } catch { /* Preserve the unknown runtime outcome. */ }
          throw Object.assign(new Error(stoppedAfterFailure
            ? "The enabled sidecar failed verification and its stopped state was confirmed."
            : "The enabled sidecar outcome is unknown. Inspect and stop the owned service before use."),
          { runtimeStopped: stoppedAfterFailure, remoteOutcomeUnknown: !stoppedAfterFailure });
        }
      }
      return {
        account: changed.account, revocation: changed.revocation,
        runtimeStopped: action !== "enable-plan",
        ...(imagesRevocation === undefined ? {} : { imagesRevocation }),
      };
    },
  });
}

// Best effort: signs out of the image add-on in the running sidecar, or in a one-off container
// when it is stopped, and returns OpenAI's revocation result. "unknown" means the step could not
// run or failed; a sidecar built before the add-on has no image module.
async function signOutLocalCodexImages({ runProcess, installRoot, marker, running }) {
  try {
    const { revocation } = readCodexImagesCliResult(await runProcess({
      file: "docker",
      args: createComposeArgs(marker.projectName, [
        ...(running ? ["exec", "-T", SERVICE_NAME, "node"]
          : ["run", "--rm", "--no-deps", "-T", "--entrypoint", "node", SERVICE_NAME]),
        "/app/services/codex-images.mjs", "sign-out",
      ]),
      cwd: installRoot, dockerHost: marker.dockerHost,
    }));
    return ["confirmed", "unconfirmed", "not-applicable"].includes(revocation) ? revocation : "unknown";
  } catch {
    return "unknown";
  }
}

const CODEX_IMAGES_ACTIONS = new Set(["login-start", "login-poll", "login-cancel", "sign-out"]);
const CODEX_IMAGES_NOT_RUNNING = "The installed SIWC sidecar is not running for the reviewed account.";

// The image add-on's CLI runs in the exact running owned container, one fixed command per action.
// Status, sign-in start and sign-out re-attest the whole owned project; polling and cancelling a
// pending sign-in check only that the container from the status check still runs.
async function runLocalCodexImages(
  { registrationId, action, expectedContainerId },
  {
    fileSystem = defaultFileSystem, env = process.env,
    homeDirectory = homedir(), runProcess = runLocalProcess,
    platform = process.platform, lockDownPath = lockDownLocalPath,
    getProcessIdentity, lifecycleLockNow = Date.now,
  } = {},
) {
  validateSiwcRegistrationId(registrationId);
  assertSupportedPlatform(platform);
  rejectDockerEnvironmentOverrides(env);
  const installRoot = await resolveLocalN8nSidecarInstallRoot({ env, homeDirectory, fileSystem, platform });
  const releaseLock = await acquireSidecarLock({
    fileSystem, getProcessIdentity, installRoot, lockDownPath, now: lifecycleLockNow, platform,
  });
  return settleLocalIntegrationLifecycleOperation({
    completionLabel: "Local n8n Codex image sign-in operation",
    releaseLock,
    operation: async () => {
      await verifyWindowsSidecarStatusPathSecurity({ fileSystem, installRoot, platform, lockDownPath });
      const marker = validateMarker((await inspectManagedInstall({ fileSystem, installRoot })).marker);
      if (marker.registrationId !== registrationId) throw new Error(CODEX_IMAGES_NOT_RUNNING);
      await assertManagedSiwcCompose(fileSystem, installRoot, marker);
      if (await resolveLocalDockerHost({ runProcess, cwd: installRoot, env, platform }) !== marker.dockerHost) {
        throw new Error("The selected Docker context changed.");
      }
      if (["status", "login-start", "sign-out"].includes(action)) {
        await attestPlanAndAlias({
          plan: marker, runProcess, cwd: installRoot,
          installId: marker.installId, projectName: marker.projectName,
        });
        const ownership = await attestProjectOwnership({
          runProcess, cwd: installRoot, dockerHost: marker.dockerHost,
          installId: marker.installId, projectName: marker.projectName, returnDetails: true,
        });
        if (!ownership.exact) throw new Error("The exact owned sidecar project is missing.");
      }
      const runtime = await inspectOwnedSidecarRuntime({ runProcess, installRoot, marker });
      if (!runtime?.running || runtime.paused) throw new Error(CODEX_IMAGES_NOT_RUNNING);
      if (expectedContainerId !== undefined && runtime.containerId !== expectedContainerId) {
        throw new Error("The installed sidecar changed. Check image generation again.");
      }
      const result = await runProcess({
        file: "docker",
        args: createComposeArgs(marker.projectName, [
          "exec", "-T", SERVICE_NAME, "node", "/app/services/codex-images.mjs", action,
        ]),
        cwd: installRoot, dockerHost: marker.dockerHost,
      });
      return {
        ...readCodexImagesCliResult(result, { allowUnavailable: action === "status" }),
        containerId: runtime.containerId,
      };
    },
  });
}

// "unavailable" means the running sidecar predates the image add-on.
export function getLocalN8nCodexImagesStatus({ registrationId }, deps = {}) {
  return runLocalCodexImages({ registrationId, action: "status" }, deps);
}

export async function changeLocalN8nCodexImages(
  { registrationId, action, expectedContainerId, confirmed }, deps = {},
) {
  if (!CODEX_IMAGES_ACTIONS.has(action)) throw new TypeError("The image sign-in action is invalid.");
  if ((action === "login-start" || action === "sign-out") && confirmed !== true) {
    throw new Error("Confirm the Codex image sign-in change for this computer.");
  }
  validateDockerObjectId(expectedContainerId, "reviewed sidecar container");
  return runLocalCodexImages({ registrationId, action, expectedContainerId }, deps);
}

export async function removeLocalN8nSidecar(
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
  const releaseLock = await acquireSidecarLock({
    fileSystem,
    getProcessIdentity,
    installRoot,
    lockDownPath,
    now: lifecycleLockNow,
    platform,
  });
  return settleLocalIntegrationLifecycleOperation({
    completionLabel: "Local n8n OAuth sidecar removal",
    releaseLock,
    operation: async () => {
      await verifyWindowsSidecarStatusPathSecurity({
        fileSystem,
        installRoot,
        platform,
        lockDownPath,
      });
      const managed = await inspectManagedInstall({ fileSystem, installRoot });
    if (!managed.marker) {
      throw new Error("The managed local n8n bridge is not installed.");
    }
    const marker = validateMarker(managed.marker);
    if (marker.legacyInstallId) {
      throw new Error("This bridge retains an offline legacy credential volume and migration archive. Removal needs a separate reviewed cleanup; nothing was deleted.");
    }
    await attestProjectOwnership({
      runProcess,
      cwd: installRoot,
      dockerHost: marker.dockerHost,
      installId: marker.installId,
      projectName: marker.projectName,
    });
    let imagesRevocation;
    if (marker.schemaVersion === MARKER_SCHEMA_VERSION) {
      await assertManagedSiwcCompose(fileSystem, installRoot, marker);
      const status = await runSiwcCli({
        runProcess, installRoot, marker, command: "account",
      });
      if (status.account?.registrationId !== marker.registrationId ||
          status.account?.ownerHostId !== marker.ownerHostId ||
          status.account?.session !== "signed-out" ||
          status.account?.planEnabled !== false) {
        throw new Error("Sign out of the installed SIWC account before removing its protected storage.");
      }
      // The volume delete below would drop a live image refresh token without revoking it.
      const runtime = await inspectOwnedSidecarRuntime({ runProcess, installRoot, marker }).catch(() => null);
      imagesRevocation = await signOutLocalCodexImages({
        runProcess, installRoot, marker, running: runtime?.running === true && !runtime.paused,
      });
    }
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
      return { removed: true, target: LOCAL_N8N_SIDECAR_TARGET,
        ...(imagesRevocation === undefined ? {} : { imagesRevocation }) };
    },
  });
}

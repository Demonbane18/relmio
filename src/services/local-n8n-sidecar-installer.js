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
  lockDownLocalPath,
  validateLocalDockerHost,
} from "../infrastructure/local-process.js";
import { readAuthContents, resolveAuthPath } from "./oauth.js";
import {
  acquireLocalIntegrationLifecycleLock,
  settleLocalIntegrationLifecycleOperation,
} from "./local-integration-lifecycle-lock.js";

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
const CREDENTIAL_REFRESH_PREFLIGHT_SCRIPT = [
  "set -eu",
  "rm -f /run/relmio-auth/.auth.json.previous.next /run/relmio-auth/.auth.json.quiesce.next",
  "if test -e /run/relmio-auth/.auth.json.previous; then test ! -e /run/relmio-auth/.auth.json.quiesce; test -f /run/relmio-auth/.auth.json.previous; node -e 'JSON.parse(require(\"node:fs\").readFileSync(process.argv[1],\"utf8\"))' /run/relmio-auth/.auth.json.previous; rm -f /run/relmio-auth/.auth.json.next; printf rollback-pending; elif test -e /run/relmio-auth/.auth.json.quiesce; then test -f /run/relmio-auth/.auth.json.quiesce; node -e 'JSON.parse(require(\"node:fs\").readFileSync(process.argv[1],\"utf8\"))' /run/relmio-auth/.auth.json.quiesce; test ! -e /run/relmio-auth/.auth.json.next; printf quiesce-pending; else test ! -e /run/relmio-auth/.auth.json.next; printf clean; fi",
].join("; ");
const CREDENTIAL_REFRESH_QUIESCE_BACKUP_SCRIPT = [
  "set -eu",
  "umask 077",
  "trap 'rm -f /run/relmio-auth/.auth.json.quiesce.next' EXIT HUP INT TERM",
  "test -f /run/relmio-auth/auth.json",
  "test ! -e /run/relmio-auth/.auth.json.previous",
  "test ! -e /run/relmio-auth/.auth.json.quiesce",
  "cp /run/relmio-auth/auth.json /run/relmio-auth/.auth.json.quiesce.next",
  'node -e \'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))\' /run/relmio-auth/.auth.json.quiesce.next',
  "chmod 0600 /run/relmio-auth/.auth.json.quiesce.next",
  "mv -f /run/relmio-auth/.auth.json.quiesce.next /run/relmio-auth/.auth.json.quiesce",
  "trap - EXIT HUP INT TERM",
].join("; ");
const CREDENTIAL_REFRESH_QUIESCE_REFRESH_SCRIPT = [
  "set -eu",
  "umask 077",
  "trap 'rm -f /run/relmio-auth/.auth.json.quiesce.next' EXIT HUP INT TERM",
  "test ! -e /run/relmio-auth/.auth.json.previous",
  "test -f /run/relmio-auth/.auth.json.quiesce",
  'node -e \'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))\' /run/relmio-auth/.auth.json.quiesce',
  "if test -f /run/relmio-auth/auth.json && node -e 'JSON.parse(require(\"node:fs\").readFileSync(process.argv[1],\"utf8\"))' /run/relmio-auth/auth.json; then cp /run/relmio-auth/auth.json /run/relmio-auth/.auth.json.quiesce.next; node -e 'JSON.parse(require(\"node:fs\").readFileSync(process.argv[1],\"utf8\"))' /run/relmio-auth/.auth.json.quiesce.next; chmod 0600 /run/relmio-auth/.auth.json.quiesce.next; mv -f /run/relmio-auth/.auth.json.quiesce.next /run/relmio-auth/.auth.json.quiesce; printf refreshed; else printf retained-invalid-current; fi",
  "trap - EXIT HUP INT TERM",
].join("; ");
const CREDENTIAL_REFRESH_PROMOTE_SCRIPT = [
  "set -eu",
  "test ! -e /run/relmio-auth/.auth.json.previous",
  "test -f /run/relmio-auth/.auth.json.quiesce",
  'node -e \'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))\' /run/relmio-auth/.auth.json.quiesce',
  "mv /run/relmio-auth/.auth.json.quiesce /run/relmio-auth/.auth.json.previous",
  'node -e \'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))\' /run/relmio-auth/.auth.json.previous',
].join("; ");
const CREDENTIAL_REFRESH_SEED_SCRIPT = [
  "set -eu",
  "umask 077",
  "trap 'rm -f /run/relmio-auth/.auth.json.next' EXIT HUP INT TERM",
  "test -f /run/relmio-auth/.auth.json.previous",
  "cat > /run/relmio-auth/.auth.json.next",
  'node -e \'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))\' /run/relmio-auth/.auth.json.next',
  "chmod 0600 /run/relmio-auth/.auth.json.next",
  "mv -f /run/relmio-auth/.auth.json.next /run/relmio-auth/auth.json",
  "trap - EXIT HUP INT TERM",
].join("; ");
const CREDENTIAL_REFRESH_ROLLBACK_SCRIPT = [
  "set -eu",
  "test -f /run/relmio-auth/.auth.json.previous",
  'node -e \'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))\' /run/relmio-auth/.auth.json.previous',
  "rm -f /run/relmio-auth/.auth.json.next",
  "cp /run/relmio-auth/.auth.json.previous /run/relmio-auth/.auth.json.next",
  "chmod 0600 /run/relmio-auth/.auth.json.next",
  "mv -f /run/relmio-auth/.auth.json.next /run/relmio-auth/auth.json",
].join("; ");
const CREDENTIAL_REFRESH_COMMIT_SCRIPT = [
  "set -eu",
  "test -f /run/relmio-auth/auth.json",
  "rm -f /run/relmio-auth/.auth.json.previous /run/relmio-auth/.auth.json.quiesce /run/relmio-auth/.auth.json.next /run/relmio-auth/.auth.json.quiesce.next",
].join("; ");

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

function localN8nSidecarSnapshot() {
  return {
    target: LOCAL_N8N_SIDECAR_TARGET,
    endpoint: LOCAL_N8N_SIDECAR_ENDPOINT,
    auth: { configured: true, disclosure: "server-managed" },
    canRefreshCredential: true,
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
    const selectedDockerHost = await resolveLocalDockerHost({
      runProcess,
      cwd: installRoot,
      env,
      platform,
    });
    if (selectedDockerHost !== marker.dockerHost) return unavailable;
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
    });
    if (!ownership.exact) {
      return {
        target: LOCAL_N8N_SIDECAR_TARGET,
        managed: true,
        state: "partial",
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
    const snapshot = localN8nSidecarSnapshot();
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
      verifyModels: false,
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
    !Object.prototype.hasOwnProperty.call(inspected.Containers, n8nContainerId)
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
        volumeNames[0] === `${projectName}_oauth-auth` &&
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
  verifyModels = true,
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
  if (!verifyModels) {
    return [];
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

async function runCredentialVolumeScript({
  runProcess,
  installRoot,
  marker,
  script,
  label,
  input,
  user,
}) {
  if (user !== "1000:1000") {
    throw new TypeError("The local credential helper identity is invalid.");
  }
  return runOrThrow(
    runProcess,
    {
      file: "docker",
      args: createComposeArgs(marker.projectName, [
        "run",
        "--rm",
        "--no-deps",
        "-T",
        "--user",
        user,
        "--entrypoint",
        "/bin/sh",
        "credential-seed",
        "-c",
        script,
      ]),
      cwd: installRoot,
      dockerHost: marker.dockerHost,
      ...(input === undefined ? {} : { input }),
    },
    label,
  );
}

function parseCredentialRefreshJournalState(output) {
  const state = output.trim();
  if (
    state !== "clean" &&
    state !== "quiesce-pending" &&
    state !== "rollback-pending"
  ) {
    throw new Error("The local OAuth credential refresh journal is invalid.");
  }
  return state;
}

function parseCredentialQuiesceRefreshOutcome(output) {
  const outcome = output.trim();
  if (outcome !== "refreshed" && outcome !== "retained-invalid-current") {
    throw new Error("The local OAuth credential quiesce snapshot result is invalid.");
  }
  return outcome;
}

async function inspectCredentialRefreshJournal({
  runProcess,
  installRoot,
  marker,
  label,
}) {
  const result = await runCredentialVolumeScript({
    runProcess,
    installRoot,
    marker,
    script: CREDENTIAL_REFRESH_PREFLIGHT_SCRIPT,
    label,
    user: "1000:1000",
  });
  return parseCredentialRefreshJournalState(result.stdout);
}

async function promoteCredentialRefreshSnapshot({
  runProcess,
  installRoot,
  marker,
  label,
}) {
  await runCredentialVolumeScript({
    runProcess,
    installRoot,
    marker,
    script: CREDENTIAL_REFRESH_PROMOTE_SCRIPT,
    label,
    user: "1000:1000",
  });
}

async function recreateOwnedSidecar({
  runProcess,
  installRoot,
  marker,
  label,
}) {
  await runOrThrow(
    runProcess,
    {
      file: "docker",
      args: createComposeArgs(marker.projectName, [
        "up",
        "-d",
        "--wait",
        "--wait-timeout",
        "90",
        "--no-deps",
        "--force-recreate",
        SERVICE_NAME,
      ]),
      cwd: installRoot,
      dockerHost: marker.dockerHost,
    },
    label,
  );
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
  if (
    sidecar?.Id !== containerId ||
    typeof sidecar?.State?.Running !== "boolean" ||
    typeof sidecar?.State?.Paused !== "boolean" ||
    !labelsMatchOwnedSidecar(sidecar.Config?.Labels, {
      installId: marker.installId,
      projectName: marker.projectName,
    }) ||
    sidecarNetwork?.NetworkID !== marker.dockerNetworkId ||
    !Array.isArray(sidecarNetwork?.Aliases) ||
    !sidecarNetwork.Aliases.includes(LOCAL_N8N_SIDECAR_HOSTNAME) ||
    !ports ||
    typeof ports !== "object" ||
    Array.isArray(ports) ||
    Object.values(ports).some((bindings) => bindings !== null)
  ) {
    throw new Error("The local sidecar refresh identity could not be verified.");
  }
  return Object.freeze({
    containerId,
    health: sidecar.State.Health?.Status,
    paused: sidecar.State.Paused,
    running: sidecar.State.Running,
  });
}

async function setOwnedSidecarPaused({
  runProcess,
  installRoot,
  marker,
  expectedContainerId,
  paused,
}) {
  let commandError;
  try {
    await runOrThrow(
      runProcess,
      {
        file: "docker",
        args: ["container", paused ? "pause" : "unpause", expectedContainerId],
        cwd: installRoot,
        dockerHost: marker.dockerHost,
      },
      paused
        ? "Local sidecar credential writer freeze"
        : "Local sidecar credential writer resume",
    );
  } catch (error) {
    commandError = error;
  }
  const inspected = await inspectOwnedSidecarRuntime({
    runProcess,
    installRoot,
    marker,
  });
  if (
    !inspected ||
    inspected.containerId !== expectedContainerId ||
    !inspected.running ||
    inspected.paused !== paused
  ) {
    throw new Error(
      paused
        ? "The local sidecar credential writer did not freeze safely."
        : "The local sidecar credential writer did not resume safely.",
      { cause: commandError },
    );
  }
}

async function killFrozenOwnedSidecar({
  runProcess,
  installRoot,
  marker,
  expectedContainerId,
}) {
  const frozen = await inspectOwnedSidecarRuntime({
    runProcess,
    installRoot,
    marker,
  });
  if (
    !frozen ||
    frozen.containerId !== expectedContainerId ||
    !frozen.running ||
    !frozen.paused
  ) {
    throw new Error("The frozen local sidecar identity could not be verified.");
  }
  let commandError;
  try {
    await runOrThrow(
      runProcess,
      {
        file: "docker",
        args: ["container", "kill", "--signal", "KILL", expectedContainerId],
        cwd: installRoot,
        dockerHost: marker.dockerHost,
      },
      "Frozen local sidecar credential writer termination",
    );
  } catch (error) {
    commandError = error;
  }
  const stopped = await inspectOwnedSidecarRuntime({
    runProcess,
    installRoot,
    marker,
  });
  if (
    !stopped ||
    stopped.containerId !== expectedContainerId ||
    stopped.running ||
    stopped.paused
  ) {
    throw new Error(
      "The local sidecar credential writer was not terminated safely.",
      { cause: commandError },
    );
  }
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

async function readCurrentAuth({
  authPath,
  plan,
  fileSystem,
  env,
  homeDirectory,
  platform,
  lockDownPath,
  requireStableGeneration = true,
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
    (platform !== "win32" && (metadata.mode & 0o077) !== 0)
  ) {
    throw new Error(
      platform !== "win32" && metadata.isFile() && (metadata.mode & 0o077) !== 0
        ? "The local OAuth credential permissions are too broad."
        : "The local OAuth credential is missing or invalid.",
    );
  }
  if (requireStableGeneration && metadata.mtime.toISOString() !== plan.authGeneration) {
    throw new Error(
      "The local OAuth credential changed. Create and confirm a fresh plan.",
    );
  }
  if (platform === "win32") {
    await lockDownPath(expectedPath, { platform, kind: "file" });
    try {
      metadata = await fileSystem.lstat(expectedPath);
    } catch {
      throw new Error("The local OAuth credential is missing or invalid.");
    }
    if (
      metadata.isSymbolicLink() ||
      !metadata.isFile() ||
      (requireStableGeneration && metadata.mtime.toISOString() !== plan.authGeneration)
    ) {
      throw new Error(
        "The local OAuth credential changed. Create and confirm a fresh plan.",
      );
    }
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
    lockDownPath = lockDownLocalPath,
    getProcessIdentity,
    lifecycleLockNow = Date.now,
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
    platform,
    lockDownPath,
  });
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
    completionLabel: "Local n8n OAuth sidecar installation",
    releaseLock,
    operation: async () => {
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
      platform,
      lockDownPath,
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
      platform,
      lockDownPath,
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
    },
  });
}

/**
 * Replace the credential in the already-owned sidecar volume and recreate only
 * the owned service. This never inspects, recreates, or restarts n8n itself.
 */
export async function refreshLocalN8nSidecarCredential(
  { authPath, confirmed },
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
    throw new Error("Confirm refreshing the owned local n8n bridge credential.");
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
    completionLabel: "Local n8n OAuth sidecar credential refresh",
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
      const firstAuth = await readCurrentAuth({
        authPath,
        plan: marker,
        fileSystem,
        env,
        homeDirectory,
        platform,
        lockDownPath,
        requireStableGeneration: false,
      });
      await attestProjectOwnership({
        runProcess,
        cwd: installRoot,
        dockerHost: marker.dockerHost,
        installId: marker.installId,
        projectName: marker.projectName,
      });
      await attestPlanAndAlias({
        plan: marker,
        runProcess,
        cwd: installRoot,
        installId: marker.installId,
        projectName: marker.projectName,
      });
      const reattestedAuth = await readCurrentAuth({
        authPath,
        plan: marker,
        fileSystem,
        env,
        homeDirectory,
        platform,
        lockDownPath,
        requireStableGeneration: false,
      });
      if (!firstAuth.equals(reattestedAuth)) {
        throw new Error("The local OAuth credential changed. Confirm the refresh again.");
      }
      const journalState = await inspectCredentialRefreshJournal({
        runProcess,
        installRoot,
        marker,
        label: "Local OAuth credential refresh preflight",
      });
      let sidecarQuiesced = false;
      let rollbackJournalReady = journalState === "rollback-pending";
      let quiesceSnapshotReady = journalState === "quiesce-pending";
      let ambiguousQuiesceRefresh = false;
      let snapshotFailureResumed = false;
      let credentialSeedAttempted = false;
      try {
        const sidecarRuntime = await inspectOwnedSidecarRuntime({
          runProcess,
          installRoot,
          marker,
        });
        sidecarQuiesced = sidecarRuntime === null || !sidecarRuntime.running;
        if (sidecarRuntime?.running) {
          if (!sidecarRuntime.paused) {
            await setOwnedSidecarPaused({
              runProcess,
              installRoot,
              marker,
              expectedContainerId: sidecarRuntime.containerId,
              paused: true,
            });
          }
          if (!rollbackJournalReady) {
            if (quiesceSnapshotReady) {
              ambiguousQuiesceRefresh = true;
              const snapshotRefresh = await runCredentialVolumeScript({
                runProcess,
                installRoot,
                marker,
                script: CREDENTIAL_REFRESH_QUIESCE_REFRESH_SCRIPT,
                label: "Frozen local OAuth credential quiesce snapshot refresh",
                user: "1000:1000",
              });
              parseCredentialQuiesceRefreshOutcome(snapshotRefresh.stdout);
              ambiguousQuiesceRefresh = false;
            } else {
              try {
                await runCredentialVolumeScript({
                  runProcess,
                  installRoot,
                  marker,
                  script: CREDENTIAL_REFRESH_QUIESCE_BACKUP_SCRIPT,
                  label: "Frozen local OAuth credential quiesce snapshot",
                  user: "1000:1000",
                });
                quiesceSnapshotReady = true;
              } catch (backupError) {
                const backupJournalState = await inspectCredentialRefreshJournal({
                  runProcess,
                  installRoot,
                  marker,
                  label: "Frozen local OAuth credential quiesce snapshot check",
                });
                quiesceSnapshotReady = backupJournalState === "quiesce-pending";
                if (!quiesceSnapshotReady) {
                  if (backupJournalState !== "clean") {
                    throw new Error(
                      "The local OAuth credential refresh journal changed unexpectedly.",
                    );
                  }
                  await setOwnedSidecarPaused({
                    runProcess,
                    installRoot,
                    marker,
                    expectedContainerId: sidecarRuntime.containerId,
                    paused: false,
                  });
                  snapshotFailureResumed = true;
                  throw backupError;
                }
              }
            }
          }
          await killFrozenOwnedSidecar({
            runProcess,
            installRoot,
            marker,
            expectedContainerId: sidecarRuntime.containerId,
          });
          sidecarQuiesced = true;
        } else if (!rollbackJournalReady) {
          if (quiesceSnapshotReady) {
            ambiguousQuiesceRefresh = true;
            const snapshotRefresh = await runCredentialVolumeScript({
              runProcess,
              installRoot,
              marker,
              script: CREDENTIAL_REFRESH_QUIESCE_REFRESH_SCRIPT,
              label: "Stopped local OAuth credential quiesce snapshot refresh",
              user: "1000:1000",
            });
            parseCredentialQuiesceRefreshOutcome(snapshotRefresh.stdout);
            ambiguousQuiesceRefresh = false;
          } else {
            await runCredentialVolumeScript({
              runProcess,
              installRoot,
              marker,
              script: CREDENTIAL_REFRESH_QUIESCE_BACKUP_SCRIPT,
              label: "Stopped local OAuth credential quiesce snapshot",
              user: "1000:1000",
            });
            quiesceSnapshotReady = true;
          }
        }
        if (!rollbackJournalReady) {
          if (!quiesceSnapshotReady) {
            throw new Error("The local OAuth credential quiesce snapshot is missing.");
          }
          await promoteCredentialRefreshSnapshot({
            runProcess,
            installRoot,
            marker,
            label: "Local OAuth credential rollback snapshot promotion",
          });
          quiesceSnapshotReady = false;
          rollbackJournalReady = true;
        }
        await runCredentialVolumeScript({
          runProcess,
          installRoot,
          marker,
          script: CREDENTIAL_REFRESH_ROLLBACK_SCRIPT,
          label: journalState === "rollback-pending"
            ? "Interrupted local OAuth credential refresh rollback"
            : "Local OAuth credential pre-seed restoration",
          user: "1000:1000",
        });
        const finalAuth = await readCurrentAuth({
          authPath,
          plan: marker,
          fileSystem,
          env,
          homeDirectory,
          platform,
          lockDownPath,
          requireStableGeneration: false,
        });
        if (!reattestedAuth.equals(finalAuth)) {
          throw new Error("The local OAuth credential changed. Confirm the refresh again.");
        }
        credentialSeedAttempted = true;
        await runCredentialVolumeScript({
          runProcess,
          installRoot,
          marker,
          script: CREDENTIAL_REFRESH_SEED_SCRIPT,
          label: "Local OAuth credential refresh seed",
          input: finalAuth,
          user: "1000:1000",
        });
        await recreateOwnedSidecar({
          runProcess,
          installRoot,
          marker,
          label: "Local sidecar credential refresh",
        });
        const models = await verifyRunningSidecar({
          runProcess,
          installRoot,
          plan: marker,
          installId: marker.installId,
          projectName: marker.projectName,
        });
        await runCredentialVolumeScript({
          runProcess,
          installRoot,
          marker,
          script: CREDENTIAL_REFRESH_COMMIT_SCRIPT,
          label: "Local OAuth credential refresh commit",
          user: "1000:1000",
        });
        return Object.freeze({
          target: LOCAL_N8N_SIDECAR_TARGET,
          credentialRefreshed: true,
          models,
          hostPublication: "none",
        });
      } catch (error) {
        if (ambiguousQuiesceRefresh) {
          throw new Error(
            "Relmio could not prove that the existing quiesce snapshot was refreshed. The snapshot and exact sidecar state were preserved, no credential was replaced, and n8n was not touched. Retry only after inspecting the owned sidecar.",
            { cause: error },
          );
        }
        if (snapshotFailureResumed) {
          throw new Error(
            "Relmio could not capture a stable snapshot of the owned sidecar credential. The exact sidecar was resumed unchanged and n8n was not touched. Wait a moment, then confirm the refresh again.",
            { cause: error },
          );
        }
        if (!sidecarQuiesced) {
          throw new Error(
            "Relmio could not confirm that the frozen owned sidecar credential writer was terminated. Any quiesce or rollback journal was preserved and n8n was not touched; retry only after inspecting the owned sidecar.",
            { cause: error },
          );
        }
        try {
          if (!rollbackJournalReady) {
            const recoveryJournalState = await inspectCredentialRefreshJournal({
              runProcess,
              installRoot,
              marker,
              label: "Local OAuth credential refresh recovery preflight",
            });
            if (recoveryJournalState === "quiesce-pending") {
              await promoteCredentialRefreshSnapshot({
                runProcess,
                installRoot,
                marker,
                label: "Local OAuth credential recovery snapshot promotion",
              });
              rollbackJournalReady = true;
            } else {
              rollbackJournalReady = recoveryJournalState === "rollback-pending";
            }
          }
          if (rollbackJournalReady) {
            await runCredentialVolumeScript({
              runProcess,
              installRoot,
              marker,
              script: CREDENTIAL_REFRESH_ROLLBACK_SCRIPT,
              label: "Local OAuth credential refresh rollback",
              user: "1000:1000",
            });
          }
          await recreateOwnedSidecar({
            runProcess,
            installRoot,
            marker,
            label: "Local sidecar credential rollback",
          });
          await verifyRunningSidecar({
            runProcess,
            installRoot,
            plan: marker,
            installId: marker.installId,
            projectName: marker.projectName,
            verifyModels: false,
          });
          if (rollbackJournalReady) {
            await runCredentialVolumeScript({
              runProcess,
              installRoot,
              marker,
              script: CREDENTIAL_REFRESH_COMMIT_SCRIPT,
              label: "Local OAuth credential rollback commit",
              user: "1000:1000",
            });
          }
        } catch (rollbackError) {
          throw new Error(
            "The owned local sidecar credential refresh failed and Relmio could not verify rollback. Relmio preserved the attested sidecar evidence and did not touch n8n. Do not retry until the owned sidecar is inspected.",
            { cause: rollbackError },
          );
        }
        if (!credentialSeedAttempted) {
          throw new Error(
            "The local sidecar credential refresh stopped before replacement. Relmio restored and restarted the owned sidecar without touching n8n. Confirm the refresh again.",
            { cause: error },
          );
        }
        throw new Error(
          "The new local sidecar credential could not be verified, so Relmio restored the previous credential and did not touch n8n. Confirm a fresh ChatGPT sign-in before retrying.",
          { cause: error },
        );
      }
    },
  });
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
    },
  });
}

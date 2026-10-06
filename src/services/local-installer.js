import { createHash, randomBytes as createRandomBytes, randomUUID } from "node:crypto";
import { constants as fileSystemConstants } from "node:fs";
import * as defaultFileSystem from "node:fs/promises";
import { createConnection, createServer } from "node:net";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import {
  createCodexComposeFile,
  createCodexChatComposeFile,
  createCodexChatConfig,
  createCodexChatDockerfile,
  createCodexChatRequirements,
  createCodexConfig,
  createCodexDockerfile,
  createCodexRequirements,
  createGrokBuildComposeFile,
  createGrokBuildDockerfile,
  GROK_BUILD_CLI_VERSION,
  createLocalDeploymentPlan,
  createLocalDockerignore,
  validateInstallId,
  validateLocalPort,
  validateLocalTarget,
} from "../domain/local-endpoints.js";
import {
  safeSiwcCatalogFailure, safeSiwcRuntimeFailure,
  validateSiwcAuthBinding, validateSiwcRegistrationId,
} from "../domain/safety.js";
import {
  runLocalProcess,
  lockDownLocalPath,
  validateLocalDockerHost,
} from "../infrastructure/local-process.js";
import { getLocalProcessIdentity } from "../infrastructure/process-identity.js";
import { runCodexSiwcCommand } from "./codex-login.js";
import { collectSiwcRuntimeAssets } from "./siwc-runtime-assets.js";
import {
  finishAuthHandoff, prepareAuthHandoff, readAuthHandoff, readPendingAuthHandoff, readRegistration, listRegistrations,
  validateSiwcHostId,
} from "./siwc-session.mjs";
import {
  fingerprintLocalSiwcFiles, fingerprintLocalSiwcResources, localSiwcFinalizationFailure,
  localSiwcStagingPath, readLocalSiwcStaging, readLocalSiwcResumeAuthBinding,
  assertNoLocalSiwcOneOffContainers,
} from "./local-integration-lifecycle-lock.js";

const MANAGED_MARKER = ".managed-by-relmio.json";
const ROOT_MARKER = ".managed-by-relmio-root.json";
const MARKER_SCHEMA_VERSION = 2;
const CODEX_SIWC_MARKER_SCHEMA_VERSION = 3;
const ROOT_MARKER_SCHEMA_VERSION = 1;
const COMPOSE_FILENAME = "docker-compose.yml";
const INCOMPLETE_LOCK_STALE_MS = 30_000;
const PROJECTS = Object.freeze({
  "codex-chatgpt": Object.freeze({
    projectPrefix: "relmio-codex-chatgpt",
    serviceName: "codex",
    containerPort: 4_500,
    volumeNames: Object.freeze(["codex-state", "siwc-store", "codex-workspace"]),
  }),
  "codex-chat": Object.freeze({
    projectPrefix: "relmio-codex-chat",
    serviceName: "codex-chat",
    containerPort: 14_501,
    volumeNames: Object.freeze(["codex-state", "siwc-store", "codex-workspace"]),
  }),
  "xai-grok-build": Object.freeze({
    projectPrefix: "relmio-xai-grok-build",
    serviceName: "grok-build",
    containerPort: 14_502,
    volumeNames: Object.freeze(["grok-home"]),
  }),
});
const SIWC_ASSET_PATHS = new Set([
  "gateway/openai-oauth-sidecar.mjs", "gateway/codex-chat.js",
  "gateway/codex-app-server.mjs", "services/siwc-session.mjs",
  "services/siwc-handoff.mjs", "infrastructure/local-process.js",
  "services/local-integration-lifecycle-lock.js", "services/codex-images.mjs", "services/model-discovery.mjs",
  "infrastructure/process-identity.js",
]);
const DOCKER_SELECTION_VARIABLES = Object.freeze([
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
  "DOCKER_CONFIG",
  "DOCKER_TLS_VERIFY",
  "DOCKER_CERT_PATH",
  "BUILDKIT_HOST",
]);

function isMissing(error) {
  return error?.code === "ENOENT";
}

function errorWithCode(message, code) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function assertSupportedPlatform(platform) {
  if (typeof platform !== "string" || platform.length === 0) {
    throw new TypeError("The local platform is invalid.");
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

function validateInstallDirectory(value, target) {
  const resolved = validateAbsolutePath(value);
  if (
    basename(resolved) !== target ||
    basename(dirname(resolved)) !== "local" ||
    basename(resolve(resolved, "..", "..")) !== ".relmio"
  ) {
    throw new TypeError("The local endpoint install directory is invalid.");
  }
  return resolved;
}

export async function resolveLocalInstallRoot({
  target,
  env = process.env,
  homeDirectory = homedir(),
  fileSystem = defaultFileSystem,
  platform = process.platform,
} = {}) {
  assertSupportedPlatform(platform);
  const safeTarget = validateLocalTarget(target);
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
  const relmioHome = join(canonicalParent, ".relmio");
  return join(relmioHome, "local", safeTarget);
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

function assertDirectoryMetadata(metadata) {
  if (metadata.isSymbolicLink()) {
    throw new Error("Relmio refuses to use a symbolic link in its managed path.");
  }
  if (!metadata.isDirectory()) {
    throw new Error("Relmio local managed path is not a directory.");
  }
}

async function assertRegularManagedMarker(fileSystem, path, errorMessage) {
  const metadata = await lstatIfExists(fileSystem, path);
  if (!metadata || metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(errorMessage);
  }
}

async function inspectManagedRoot({ fileSystem, relmioHome, installRoot, target, staging }) {
  const localRoot = join(relmioHome, "local");
  const homeMetadata = await lstatIfExists(fileSystem, relmioHome);
  if (!homeMetadata) {
    return {
      baseExists: false,
      deploymentMode: "installed",
      marker: null,
      previousPort: null,
    };
  }
  assertDirectoryMetadata(homeMetadata);

  let rootMarkerContents;
  const rootMarkerPath = join(relmioHome, ROOT_MARKER);
  await assertRegularManagedMarker(
    fileSystem,
    rootMarkerPath,
    "The Relmio local storage directory already exists without a valid managed-root marker. Nothing was changed.",
  );
  try {
    rootMarkerContents = await fileSystem.readFile(rootMarkerPath, "utf8");
  } catch {
    throw new Error(
      "The Relmio local storage directory already exists without a valid managed-root marker. Nothing was changed.",
    );
  }
  try {
    const rootMarker = JSON.parse(rootMarkerContents);
    if (
      rootMarker?.schemaVersion !== ROOT_MARKER_SCHEMA_VERSION ||
      rootMarker?.kind !== "relmio-local-root"
    ) {
      throw new TypeError();
    }
  } catch {
    throw new Error(
      "The Relmio local storage managed-root marker is invalid. Nothing was changed.",
    );
  }

  for (const path of [localRoot, installRoot]) {
    const metadata = await lstatIfExists(fileSystem, path);
    if (metadata) {
      assertDirectoryMetadata(metadata);
    }
  }

  const installMetadata = await lstatIfExists(fileSystem, installRoot);
  if (!installMetadata) {
    return {
      baseExists: true,
      deploymentMode: "installed",
      marker: null,
      previousPort: null,
    };
  }

  if (staging && !(await lstatIfExists(fileSystem, join(installRoot, MANAGED_MARKER)))) {
    return { baseExists: true, deploymentMode: "installed", marker: null, previousPort: null };
  }
  let markerContents;
  const markerPath = join(installRoot, MANAGED_MARKER);
  await assertRegularManagedMarker(
    fileSystem,
    markerPath,
    "The local endpoint directory already exists without a Relmio managed marker. Nothing was overwritten.",
  );
  try {
    markerContents = await fileSystem.readFile(markerPath, "utf8");
  } catch (error) {
    if (isMissing(error)) {
      throw new Error(
        "The local endpoint directory already exists without a Relmio managed marker. Nothing was overwritten.",
      );
    }
    throw new Error("Relmio could not read its local managed marker.");
  }

  try {
    const marker = JSON.parse(markerContents);
    const installId = validateInstallId(marker?.installId);
    const dockerHost = validateLocalDockerHost(marker?.dockerHost);
    const projectName = `${PROJECTS[target].projectPrefix}-${installId}`;
    const tokenSha256 = marker?.tokenSha256;
    if (
      !(
        marker?.schemaVersion === MARKER_SCHEMA_VERSION ||
        (target !== "xai-grok-build" && marker?.schemaVersion === CODEX_SIWC_MARKER_SCHEMA_VERSION)
      ) ||
      marker?.target !== target ||
      !Number.isInteger(marker?.port) ||
      marker?.projectName !== projectName ||
      (tokenSha256 !== undefined &&
        (typeof tokenSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(tokenSha256)))
    ) {
      throw new TypeError();
    }
    const siwc = marker.schemaVersion === CODEX_SIWC_MARKER_SCHEMA_VERSION
      ? validateSiwcAuthBinding(marker.authBinding)
      : null;
    if (siwc && (
      marker.registrationId !== siwc.registrationId ||
      marker.clientId !== siwc.clientId ||
      typeof marker.ownerHostId !== "string" ||
      marker.ownerHostId === siwc.ownerHostId
    )) throw new TypeError();
    if (siwc && marker.legacyInstallId !== undefined) {
      validateInstallId(marker.legacyInstallId);
      if (marker.legacyInstallId === installId) throw new TypeError();
    }
    if (siwc && marker.previousWasSiwc !== undefined &&
        (marker.previousWasSiwc !== true || !marker.legacyInstallId)) {
      throw new TypeError();
    }
    return {
      baseExists: true,
      deploymentMode: "updated",
      marker: {
        schemaVersion: marker.schemaVersion,
        target,
        port: marker.port,
        dockerHost,
        installId,
        projectName,
        ...(siwc ? {
          authBinding: siwc,
          registrationId: siwc.registrationId,
          clientId: siwc.clientId,
          ownerHostId: validateSiwcHostId(marker.ownerHostId),
          ...(marker.legacyInstallId ? { legacyInstallId: marker.legacyInstallId } : {}),
          ...(marker.previousWasSiwc ? { previousWasSiwc: true } : {}),
        } : {}),
        ...(target === "xai-grok-build" && typeof tokenSha256 === "string"
          ? { tokenSha256 }
          : {}),
      },
      previousPort: marker.port,
    };
  } catch {
    throw new Error("The local endpoint managed marker is invalid. Nothing was overwritten.");
  }
}

async function initializeManagedBase({
  fileSystem,
  relmioHome,
  baseExists,
  platform,
  lockDownPath,
}) {
  if (baseExists) {
    await fileSystem.chmod(relmioHome, 0o700);
    if (platform === "win32") await lockDownPath(relmioHome, { platform });
    return;
  }
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

async function ensurePrivateDirectory(fileSystem, path, platform, lockDownPath) {
  const existing = await lstatIfExists(fileSystem, path);
  if (existing) {
    assertDirectoryMetadata(existing);
  } else {
    await fileSystem.mkdir(path, { mode: 0o700 });
  }
  await fileSystem.chmod(path, 0o700);
  if (platform === "win32") await lockDownPath(path, { platform });
}

async function writeManagedFile(fileSystem, path, contents, mode) {
  const existing = await lstatIfExists(fileSystem, path);
  if (existing && (existing.isSymbolicLink() || !existing.isFile())) {
    throw new Error("Relmio refuses to replace a non-file in its managed directory.");
  }

  const temporaryPath = `${path}.tmp-${randomUUID()}`;
  let committed = false;
  try {
    await fileSystem.writeFile(temporaryPath, contents, { flag: "wx", mode });
    await fileSystem.chmod(temporaryPath, mode);
    await fileSystem.rename(temporaryPath, path);
    committed = true;
    await fileSystem.chmod(path, mode);
  } catch {
    try {
      await fileSystem.unlink(temporaryPath);
    } catch {
      // The temporary file may not have been created.
    }
    const error = new Error("Relmio could not write its local managed files.");
    error.committed = committed;
    throw error;
  }
}

function createClientCredential(randomBytes) {
  const capabilityBytes = randomBytes(32);
  if (!Buffer.isBuffer(capabilityBytes) || capabilityBytes.length !== 32) {
    throw new Error("Relmio could not generate a strong local capability.");
  }
  const clientCredential = capabilityBytes.toString("base64url");
  const tokenSha256 = createHash("sha256")
    .update(clientCredential)
    .digest("hex");
  return { clientCredential, tokenSha256 };
}

function validateClientCredentialVerifier(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new TypeError("The staged local client credential is invalid.");
  }
  return value;
}

function defaultIsProcessAlive(processId) {
  try {
    process.kill(processId, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function parseLockOwner(value) {
  try {
    const owner = JSON.parse(value);
    if (
      Number.isSafeInteger(owner?.processId) &&
      owner.processId > 0 &&
      typeof owner?.ownerToken === "string" &&
      owner.ownerToken.length > 0 &&
      owner.ownerToken.length <= 128 &&
      (owner.processStartIdentity === undefined || (
        typeof owner.processStartIdentity === "string" &&
        owner.processStartIdentity.length > 0 &&
        Buffer.byteLength(owner.processStartIdentity) <= 512 &&
        !/[\0\r\n]/u.test(owner.processStartIdentity)
      ))
    ) {
      return owner;
    }
  } catch {
    // An incomplete owner record is recoverable only after its metadata is stale.
  }
  return null;
}

async function readLockOwnerState(fileSystem, ownerPath, directoryPath) {
  const directoryMetadata = await fileSystem.lstat(directoryPath);
  const directoryFingerprint = Object.freeze({
    dev: directoryMetadata.dev,
    ino: directoryMetadata.ino,
    birthtimeMs: directoryMetadata.birthtimeMs,
  });
  let serialized;
  let ownerMetadata;
  try {
    ownerMetadata = await fileSystem.lstat(ownerPath);
    serialized = await fileSystem.readFile(ownerPath, "utf8");
  } catch (error) {
    if (!isMissing(error)) {
      throw error;
    }
  }
  let ownerFingerprint = null;
  if (serialized !== undefined) {
    const ownerAfterRead = await fileSystem.lstat(ownerPath);
    ownerFingerprint = Object.freeze({
      raw: serialized,
      size: ownerMetadata.size,
      dev: ownerMetadata.dev,
      ino: ownerMetadata.ino,
      mtimeMs: ownerMetadata.mtimeMs,
      ctimeMs: ownerMetadata.ctimeMs,
    });
    const afterFingerprint = {
      raw: serialized,
      size: ownerAfterRead.size,
      dev: ownerAfterRead.dev,
      ino: ownerAfterRead.ino,
      mtimeMs: ownerAfterRead.mtimeMs,
      ctimeMs: ownerAfterRead.ctimeMs,
    };
    if (!lockOwnerFingerprintMatches(ownerFingerprint, afterFingerprint)) {
      throw new Error("The local project lock changed during inspection.");
    }
  }
  return {
    owner: serialized === undefined ? null : parseLockOwner(serialized),
    serialized,
    modifiedAtMs: serialized === undefined ? directoryMetadata.mtimeMs : ownerMetadata.mtimeMs,
    directoryFingerprint,
    ownerFingerprint,
  };
}

function lockDirectoryFingerprintMatches(left, right) {
  return left?.dev === right?.dev && left?.ino === right?.ino &&
    left?.birthtimeMs === right?.birthtimeMs;
}

function lockOwnerFingerprintMatches(left, right) {
  if (left === null || right === null) return left === right;
  return left?.raw === right?.raw && left?.size === right?.size &&
    left?.dev === right?.dev && left?.ino === right?.ino &&
    left?.mtimeMs === right?.mtimeMs && left?.ctimeMs === right?.ctimeMs;
}

function isIncompleteLockStale(state) {
  return (
    state.owner === null &&
    Number.isFinite(state.modifiedAtMs) &&
    Date.now() - state.modifiedAtMs >= INCOMPLETE_LOCK_STALE_MS
  );
}

function lockOwnerStateMatches(left, right) {
  if (!lockDirectoryFingerprintMatches(
    left.directoryFingerprint,
    right.directoryFingerprint,
  )) return false;
  if (!lockOwnerFingerprintMatches(left.ownerFingerprint, right.ownerFingerprint)) {
    return false;
  }
  if (left.owner && right.owner) {
    return (
      left.owner.processId === right.owner.processId &&
      left.owner.ownerToken === right.owner.ownerToken &&
      left.owner.processStartIdentity === right.owner.processStartIdentity
    );
  }
  return left.owner === null && right.owner === null && left.serialized === right.serialized;
}

async function assertPublishedLockOwner(
  fileSystem,
  ownerPath,
  directoryPath,
  { processId, ownerToken, processStartIdentity },
) {
  const state = await readLockOwnerState(fileSystem, ownerPath, directoryPath);
  if (
    state.owner?.processId !== processId ||
    state.owner?.ownerToken !== ownerToken ||
    state.owner?.processStartIdentity !== processStartIdentity
  ) {
    throw new Error("The local lock owner changed during publication.");
  }
  return state;
}

async function exactLockEntriesMatch(fileSystem, path, state, nestedState = null) {
  const entries = (await fileSystem.readdir(path)).sort();
  const expected = [
    ...(nestedState ? [".reclaim"] : []),
    ...(state.serialized === undefined ? [] : ["owner.json"]),
  ].sort();
  if (
    entries.length !== expected.length ||
    entries.some((entry, index) => entry !== expected[index])
  ) return false;
  const current = await readLockOwnerState(
    fileSystem,
    join(path, "owner.json"),
    path,
  );
  if (!lockOwnerStateMatches(current, state)) return false;
  if (nestedState) {
    const nestedPath = join(path, ".reclaim");
    const nested = await readLockOwnerState(
      fileSystem,
      join(nestedPath, "owner.json"),
      nestedPath,
    );
    if (!lockOwnerStateMatches(nested, nestedState)) return false;
  }
  return true;
}

async function removeExactDetachedLock(fileSystem, path, state, nestedState = null) {
  if (!await exactLockEntriesMatch(fileSystem, path, state, nestedState)) {
    throw new Error("The detached local project lock changed.");
  }
  if (nestedState) {
    const nestedPath = join(path, ".reclaim");
    if (nestedState.serialized !== undefined) {
      await fileSystem.unlink(join(nestedPath, "owner.json"));
    }
    await fileSystem.rmdir(nestedPath);
  }
  if (state.serialized !== undefined) {
    await fileSystem.unlink(join(path, "owner.json"));
  }
  await fileSystem.rmdir(path);
}

async function removeDetachedStaleLock(fileSystem, path, state, nestedState = null) {
  try {
    await removeExactDetachedLock(fileSystem, path, state, nestedState);
  } catch {
    // A uniquely renamed stale artifact is outside the canonical lock path and
    // must not strand the newly published owner when best-effort cleanup fails.
  }
}

async function acquireLocalProjectLock(
  { installRoot, target, lockName = target },
  {
    fileSystem = defaultFileSystem,
    processId = process.pid,
    isProcessAlive = defaultIsProcessAlive,
    getProcessIdentity,
    platform = process.platform,
  } = {},
) {
  const safeTarget = validateLocalTarget(target);
  if (
    typeof lockName !== "string" ||
    lockName !== safeTarget
  ) {
    throw new TypeError("The local project lock name is invalid.");
  }
  const safeInstallRoot = validateInstallDirectory(installRoot, safeTarget);
  const lockPath = join(
    dirname(resolve(safeInstallRoot, "..", "..")),
    `.relmio-local-${lockName}.lock`,
  );
  const ownerPath = join(lockPath, "owner.json");
  const ownerToken = randomUUID();
  const useProcessIdentity = typeof getProcessIdentity === "function" || (
    getProcessIdentity === undefined &&
    processId === process.pid &&
    isProcessAlive === defaultIsProcessAlive
  );
  const identityReader = typeof getProcessIdentity === "function"
    ? getProcessIdentity
    : getLocalProcessIdentity;
  let processStartIdentity;
  if (useProcessIdentity) {
    let identity;
    try { identity = await identityReader(processId, { platform }); } catch {
      throw new Error("Relmio could not verify its local project lock identity.");
    }
    if (
      identity?.state !== "active" ||
      typeof identity.startIdentity !== "string" ||
      identity.startIdentity.length === 0
    ) {
      throw new Error("Relmio could not verify its local project lock identity.");
    }
    processStartIdentity = identity.startIdentity;
  }
  const ownerPublication = Object.freeze({
    processId,
    ownerToken,
    ...(processStartIdentity === undefined ? {} : { processStartIdentity }),
  });
  let ownedLockState;

  async function lockOwnerIsActive(owner) {
    if (owner.ownerToken === ownerToken || owner.processId === processId) return true;
    if (owner.processStartIdentity !== undefined && useProcessIdentity) {
      let identity;
      try { identity = await identityReader(owner.processId, { platform }); } catch {
        return true;
      }
      if (identity?.state === "dead") return false;
      if (identity?.state !== "active" || typeof identity.startIdentity !== "string") {
        return true;
      }
      return identity.startIdentity === owner.processStartIdentity;
    }
    return isProcessAlive(owner.processId);
  }

  async function createLock() {
    await fileSystem.mkdir(lockPath, { mode: 0o700 });
    try {
      await fileSystem.writeFile(
        ownerPath,
        `${JSON.stringify(ownerPublication)}\n`,
        { flag: "wx", mode: 0o600 },
      );
      return await assertPublishedLockOwner(
        fileSystem,
        ownerPath,
        lockPath,
        ownerPublication,
      );
    } catch {
      // Leave an incomplete directory for stale recovery. Removing the shared
      // path here could delete a successor lock after this creator was paused.
      throw new Error("Relmio could not create its local project lock.");
    }
  }

  try {
    ownedLockState = await createLock();
  } catch (error) {
    if (error?.code !== "EEXIST") {
      throw error;
    }

    let ownerState;
    try {
      ownerState = await readLockOwnerState(fileSystem, ownerPath, lockPath);
    } catch {
      throw new Error("Another Relmio process is changing this local endpoint.");
    }
    const owner = ownerState.owner;
    if (
      (owner === null && !isIncompleteLockStale(ownerState)) ||
      (owner !== null && await lockOwnerIsActive(owner))
    ) {
      throw new Error("Another Relmio process is changing this local endpoint.");
    }

    const reclaimPath = join(lockPath, ".reclaim");
    const reclaimOwnerPath = join(reclaimPath, "owner.json");
    let reclaimClaimed = false;
    let ownedReclaimState;
    async function createReclaimClaim() {
      await fileSystem.mkdir(reclaimPath, { mode: 0o700 });
      try {
        await fileSystem.writeFile(
          reclaimOwnerPath,
          `${JSON.stringify(ownerPublication)}\n`,
          { flag: "wx", mode: 0o600 },
        );
        return await assertPublishedLockOwner(
          fileSystem,
          reclaimOwnerPath,
          reclaimPath,
          ownerPublication,
        );
      } catch {
        // The same identity rule applies to reclaim publication: never remove
        // a shared path after an owner write that may have lost a race.
        throw new Error("Relmio could not create its reclaim lock.");
      }
    }
    try {
      try {
        ownedReclaimState = await createReclaimClaim();
      } catch (error) {
        if (error?.code !== "EEXIST") {
          throw error;
        }
        const reclaimState = await readLockOwnerState(
          fileSystem,
          reclaimOwnerPath,
          reclaimPath,
        );
        const reclaimOwner = reclaimState.owner;
        if (
          (reclaimOwner === null && !isIncompleteLockStale(reclaimState)) ||
          (reclaimOwner !== null && await lockOwnerIsActive(reclaimOwner))
        ) {
          throw new Error("Another process owns the reclaim lock.");
        }
        const staleReclaimPath = `${reclaimPath}.stale-${randomUUID()}`;
        await fileSystem.rename(reclaimPath, staleReclaimPath);
        const detachedReclaimState = await readLockOwnerState(
          fileSystem,
          join(staleReclaimPath, "owner.json"),
          staleReclaimPath,
        );
        if (!lockOwnerStateMatches(detachedReclaimState, reclaimState)) {
          try { await fileSystem.rename(staleReclaimPath, reclaimPath); } catch {
            // Preserve both paths when the exact stale claim cannot be restored.
          }
          throw new Error("The reclaim lock owner changed.");
        }
        ownedReclaimState = await createReclaimClaim();
        await removeDetachedStaleLock(
          fileSystem,
          staleReclaimPath,
          detachedReclaimState,
        );
      }
      reclaimClaimed = true;
      const reclaimOwner = JSON.parse(
        await fileSystem.readFile(reclaimOwnerPath, "utf8"),
      );
      if (reclaimOwner?.ownerToken !== ownerToken) {
        throw new Error("The reclaim lock owner changed.");
      }
      const currentOwnerState = await readLockOwnerState(
        fileSystem,
        ownerPath,
        lockPath,
      );
      if (!lockOwnerStateMatches(currentOwnerState, ownerState)) {
        throw new Error("The local project lock owner changed.");
      }
      const stalePath = `${lockPath}.stale-${randomUUID()}`;
      await fileSystem.rename(lockPath, stalePath);
      const detachedOwnerState = await readLockOwnerState(
        fileSystem,
        join(stalePath, "owner.json"),
        stalePath,
      );
      const detachedReclaimState = await readLockOwnerState(
        fileSystem,
        join(stalePath, ".reclaim", "owner.json"),
        join(stalePath, ".reclaim"),
      );
      if (
        !lockOwnerStateMatches(detachedOwnerState, ownerState) ||
        !lockOwnerStateMatches(detachedReclaimState, ownedReclaimState)
      ) {
        try { await fileSystem.rename(stalePath, lockPath); } catch {
          // A changed or replaced path must be preserved for manual inspection.
        }
        throw new Error("The local project lock owner changed.");
      }
      reclaimClaimed = false;
      ownedLockState = await createLock();
      await removeDetachedStaleLock(
        fileSystem,
        stalePath,
        detachedOwnerState,
        detachedReclaimState,
      );
    } catch {
      if (reclaimClaimed) {
        try {
          const reclaimState = await readLockOwnerState(
            fileSystem,
            reclaimOwnerPath,
            reclaimPath,
          );
          if (
            ownedReclaimState &&
            lockOwnerStateMatches(reclaimState, ownedReclaimState)
          ) {
            await removeExactDetachedLock(
              fileSystem,
              reclaimPath,
              reclaimState,
            );
          }
        } catch {
          // A changed or contended lock remains owned by the other process.
        }
      }
      throw new Error("Another Relmio process is changing this local endpoint.");
    }
  }

  return async () => {
    let detachedPath;
    try {
      const current = await readLockOwnerState(fileSystem, ownerPath, lockPath);
      if (!ownedLockState || !lockOwnerStateMatches(current, ownedLockState)) {
        throw new Error("The local project lock owner changed.");
      }
      if ((await fileSystem.readdir(lockPath)).includes(".reclaim")) {
        throw new Error("The local project lock is contended.");
      }
      detachedPath = `${lockPath}.released-${randomUUID()}`;
      await fileSystem.rename(lockPath, detachedPath);
      const detached = await readLockOwnerState(
        fileSystem,
        join(detachedPath, "owner.json"),
        detachedPath,
      );
      if (!lockOwnerStateMatches(detached, ownedLockState)) {
        throw new Error("The local project lock changed during release.");
      }
      await removeExactDetachedLock(fileSystem, detachedPath, detached);
      detachedPath = undefined;
    } catch (error) {
      if (detachedPath) {
        try {
          await fileSystem.lstat(join(detachedPath, "owner.json"));
        } catch (ownerError) {
          if (isMissing(ownerError) && ownedLockState?.serialized !== undefined) {
            try {
              await fileSystem.writeFile(
                join(detachedPath, "owner.json"),
                ownedLockState.serialized,
                { flag: "wx", mode: 0o600 },
              );
              await fileSystem.chmod(join(detachedPath, "owner.json"), 0o600);
            } catch {
              // Preserve the detached directory if its exact owner cannot be restored.
            }
          }
        }
        try {
          await fileSystem.lstat(lockPath);
        } catch (error) {
          if (isMissing(error)) {
            try { await fileSystem.rename(detachedPath, lockPath); } catch {
              // Preserve a changed detached lock instead of deleting it.
            }
          }
        }
      }
      throw new Error("Relmio could not safely release its local project lock.", {
        cause: error,
      });
    }
  };
}

async function settleLocalProjectOperation({ completionLabel, operation, releaseLock }) {
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
    if (result?.credentialShownOnce === true && result.account?.ownership === "owned") {
      return localSiwcFinalizationFailure(result);
    }
    throw new Error(
      `${completionLabel} completed, but Relmio could not release its operation lock. ` +
      "Restart Relmio before another action, then verify the managed endpoint.",
      { cause: releaseError },
    );
  }
  return result;
}

export async function acquireLocalEndpointChangeLock(
  { target },
  {
    fileSystem = defaultFileSystem,
    env = process.env,
    homeDirectory = homedir(),
    platform = process.platform,
    processId = process.pid,
    isProcessAlive = defaultIsProcessAlive,
    getProcessIdentity,
  } = {},
) {
  assertSupportedPlatform(platform);
  rejectDockerEnvironmentOverrides(env);
  const safeTarget = validateLocalTarget(target);
  const installRoot = await resolveLocalInstallRoot({
    target: safeTarget,
    env,
    homeDirectory,
    fileSystem,
    platform,
  });
  return acquireLocalProjectLock(
    { installRoot, target: safeTarget },
    { fileSystem, processId, isProcessAlive, getProcessIdentity, platform },
  );
}

function replaceClientCredentialVerifier({ target, composeFile, tokenSha256 }) {
  if (typeof composeFile !== "string" || composeFile.length > 512 * 1024) {
    throw new Error("The managed local endpoint configuration is invalid.");
  }

  const pattern = /^([ \t]*RELMIO_GATEWAY_TOKEN_SHA256:[ \t]*)[a-f0-9]{64}([ \t]*)$/gmu;
  const matches = [...composeFile.matchAll(pattern)];
  if (matches.length !== 1) {
    throw new Error("The managed local endpoint configuration is invalid.");
  }
  return composeFile.replace(pattern, `$1${tokenSha256}$2`);
}

export function isLoopbackPortAvailable(port) {
  return new Promise((resolvePromise, rejectPromise) => {
    const server = createServer();
    server.unref();
    server.once("error", (error) => {
      if (error?.code === "EADDRINUSE" || error?.code === "EACCES") {
        resolvePromise(false);
      } else {
        rejectPromise(new Error("Relmio could not check the local endpoint port."));
      }
    });
    server.listen(port, "127.0.0.1", () => {
      server.close((error) => {
        if (error) {
          rejectPromise(new Error("Relmio could not finish checking the local port."));
        } else {
          resolvePromise(true);
        }
      });
    });
  });
}

function validateVersion(value, label) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!/^[A-Za-z0-9.+-]{1,64}$/u.test(normalized)) {
    throw new Error(`${label} returned an invalid version.`);
  }
  return normalized;
}

function rejectDockerEnvironmentOverrides(env) {
  for (const name of DOCKER_SELECTION_VARIABLES) {
    if (typeof env[name] === "string" && env[name] !== "") {
      throw new Error(
        "Relmio local endpoints require the selected Docker context without Docker environment overrides.",
      );
    }
  }
}

async function resolveLocalDockerHost({
  runProcess,
  cwd,
  env,
  platform,
}) {
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

export async function getLocalDockerStatus({
  runProcess = runLocalProcess,
  cwd = process.cwd(),
  env = process.env,
  platform = process.platform,
} = {}) {
  try {
    const dockerHost = await resolveLocalDockerHost({
      runProcess,
      cwd,
      env,
      platform,
    });
    const docker = await runProcess({
      file: "docker",
      args: ["version", "--format", "{{.Server.Version}}"],
      cwd,
      dockerHost,
    });
    if (docker.code !== 0) {
      throw new Error();
    }
    const compose = await runProcess({
      file: "docker",
      args: ["compose", "version", "--short"],
      cwd,
      dockerHost,
    });
    if (compose.code !== 0) {
      throw new Error();
    }
    return {
      dockerAvailable: true,
      dockerVersion: validateVersion(docker.stdout, "Docker"),
      composeVersion: validateVersion(compose.stdout, "Docker Compose"),
      dockerHost,
    };
  } catch {
    return {
      dockerAvailable: false,
    };
  }
}


function createServiceRecreateSpec({
  target,
  installRoot,
  dockerHost,
  projectName,
}) {
  const project = PROJECTS[target];
  return {
    label: "Local client credential rotation",
    file: "docker",
    args: createComposeArgs(target, projectName, [
      "up",
      "-d",
      "--wait",
      "--wait-timeout",
      "90",
      "--force-recreate",
      "--no-deps",
      project.serviceName,
    ]),
    cwd: installRoot,
    dockerHost,
  };
}

function createProjectName(target, installId) {
  return `${PROJECTS[target].projectPrefix}-${validateInstallId(installId)}`;
}

function createComposeArgs(target, projectName, suffix) {
  if (projectName !== createProjectName(target, projectName.slice(-32))) {
    throw new TypeError("The local Docker project identity is invalid.");
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

function createDeploymentSpecs({
  target,
  installRoot,
  dockerHost,
  projectName,
}) {
  const project = PROJECTS[target];
  const specs = [
    {
      label: "Local Compose validation",
      file: "docker",
      args: createComposeArgs(target, projectName, ["config", "--quiet"]),
      cwd: installRoot,
      dockerHost,
    },
    {
      label: "Local image build",
      file: "docker",
      args: createComposeArgs(target, projectName, ["build", project.serviceName]),
      cwd: installRoot,
      dockerHost,
    },
  ];
  specs.push({
    label: "Local endpoint start",
    file: "docker",
    args: createComposeArgs(target, projectName, [
      "up",
      "-d",
      "--wait",
      "--wait-timeout",
      "90",
      "--no-deps",
      project.serviceName,
    ]),
    cwd: installRoot,
    dockerHost,
  });
  return specs;
}

function createVerificationSpecs({ target, installRoot, dockerHost, projectName }) {
  const project = PROJECTS[target];
  return {
    running: {
      label: "Local endpoint status check",
      file: "docker",
      args: createComposeArgs(target, projectName, ["ps", "--status", "running", "--services"]),
      cwd: installRoot,
      dockerHost,
    },
    publication: {
      label: "Local endpoint publication check",
      file: "docker",
      args: createComposeArgs(target, projectName, ["ps", "--format", "json", project.serviceName]),
      cwd: installRoot,
      dockerHost,
    },
  };
}

function createCleanupSpec({ target, installRoot, dockerHost, projectName }) {
  const project = PROJECTS[target];
  return {
    label: "Unsafe local endpoint cleanup",
    file: "docker",
    args: createComposeArgs(target, projectName, [
      "rm",
      "--force",
      "--stop",
      project.serviceName,
    ]),
    cwd: installRoot,
    dockerHost,
  };
}

function createCleanupVerificationSpec({ target, installRoot, dockerHost, projectName }) {
  const project = PROJECTS[target];
  return {
    label: "Local endpoint cleanup verification",
    file: "docker",
    args: createComposeArgs(target, projectName, [
      "ps",
      "--all",
      "--services",
      project.serviceName,
    ]),
    cwd: installRoot,
    dockerHost,
  };
}

function createOwnershipPreflightSpecs({
  target,
  installRoot,
  dockerHost,
  projectName,
}) {
  const format = "{{json .}}";
  const projectFilter = `label=com.docker.compose.project=${projectName}`;
  return [
    {
      resource: "container",
      label: "Local container ownership check",
      file: "docker",
      args: ["ps", "--all", "--filter", projectFilter, "--format", format],
      cwd: installRoot,
      dockerHost,
    },
    {
      resource: "network",
      label: "Local network ownership check",
      file: "docker",
      args: ["network", "ls", "--filter", projectFilter, "--format", format],
      cwd: installRoot,
      dockerHost,
    },
    {
      resource: "volume",
      label: "Local volume ownership check",
      file: "docker",
      args: ["volume", "ls", "--filter", projectFilter, "--format", format],
      cwd: installRoot,
      dockerHost,
    },
  ];
}

function parseDockerLabels(value) {
  if (typeof value !== "string" || value.length > 16 * 1024) {
    throw new Error("The local Docker ownership metadata is invalid.");
  }
  const labels = new Map();
  for (const entry of value.split(",")) {
    const separator = entry.indexOf("=");
    const name = separator > 0 ? entry.slice(0, separator) : "";
    if (name === "" || labels.has(name)) {
      throw new Error("The local Docker ownership metadata is invalid.");
    }
    labels.set(name, entry.slice(separator + 1));
  }
  return labels;
}

function expectedLocalEndpointResourceIdentities(target, projectName) {
  const project = PROJECTS[target];
  return {
    container: new Map([
      [`${projectName}-${project.serviceName}-1`, project.serviceName],
    ]),
    network: new Map([[`${projectName}_default`, "default"]]),
    volume: new Map(
      project.volumeNames.map((name) => [`${projectName}_${name}`, name]),
    ),
  };
}

function validateOwnershipOutput(
  output,
  { target, installId, projectName, resource, strictResourceIdentities = false },
) {
  const rows = output.trim() === "" ? [] : output.trim().split("\n");
  const expectedIdentities = (
    strictResourceIdentities === true ||
    strictResourceIdentities?.[resource] === true
  )
    ? expectedLocalEndpointResourceIdentities(target, projectName)[resource]
    : null;
  const seenNames = new Set();
  for (const row of rows) {
    let parsed;
    try {
      parsed = JSON.parse(row);
    } catch {
      throw new Error("The local Docker ownership metadata is invalid.");
    }
    const labels = parseDockerLabels(parsed?.Labels);
    for (const [name, expected] of Object.entries({
      "com.docker.compose.project": projectName,
      "io.relmio.managed": "true",
      "io.relmio.target": target,
      "io.relmio.install": installId,
    })) {
      if (labels.get(name) !== expected) {
        throw new Error(
          "A Docker resource already uses this Relmio project identity without matching ownership. Nothing was changed.",
        );
      }
    }
    if (
      resource === "container" &&
      labels.get("com.docker.compose.service") !== PROJECTS[target].serviceName
    ) {
      throw new Error(
        "A Docker resource already uses this Relmio project identity without matching ownership. Nothing was changed.",
      );
    }
    if (expectedIdentities) {
      const name = resource === "container" ? parsed?.Names : parsed?.Name;
      const logicalLabel = resource === "container"
        ? "com.docker.compose.service"
        : `com.docker.compose.${resource}`;
      if (
        typeof name !== "string" ||
        !expectedIdentities.has(name) ||
        seenNames.has(name) ||
        labels.get(logicalLabel) !== expectedIdentities.get(name)
      ) {
        throw new Error(
          `The local ${resource} identity does not match the generated Compose plan.`,
        );
      }
      seenNames.add(name);
    }
  }
  return rows.length;
}

async function attestDockerOwnership({
  target,
  installRoot,
  dockerHost,
  installId,
  projectName,
  runProcess,
  strictResourceIdentities = false,
}) {
  const counts = {};
  for (const spec of createOwnershipPreflightSpecs({
    target,
    installRoot,
    dockerHost,
    projectName,
  })) {
    const result = await runOrThrow(runProcess, spec);
    counts[spec.resource] = validateOwnershipOutput(result.stdout, {
      target,
      installId,
      projectName,
      resource: spec.resource,
      strictResourceIdentities,
    });
  }
  return counts;
}

async function runOrThrow(runProcess, spec) {
  const result = await runProcess({
    file: spec.file,
    args: spec.args,
    cwd: spec.cwd,
    ...(spec.dockerHost ? { dockerHost: spec.dockerHost } : {}),
    ...(spec.input !== undefined ? { input: spec.input } : {}),
  });
  if (result.code !== 0) {
    throw new Error(`${spec.label} failed.`);
  }
  return result;
}

function validatePublishedEndpoint(output, { target, port }) {
  let services;
  try {
    const parsed = JSON.parse(output);
    services = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    throw new Error("The local endpoint publication metadata is invalid.");
  }
  if (services.length !== 1 || !Array.isArray(services[0]?.Publishers)) {
    throw new Error("The local endpoint publication check failed closed.");
  }
  const publishers = services[0].Publishers;
  const expected = PROJECTS[target];
  if (
    publishers.length !== 1 ||
    publishers[0]?.URL !== "127.0.0.1" ||
    publishers[0]?.PublishedPort !== port ||
    publishers[0]?.TargetPort !== expected.containerPort ||
    publishers[0]?.Protocol !== "tcp"
  ) {
    throw new Error(
      "The local endpoint publication is not the exact planned loopback binding.",
    );
  }
}

function parseComposeStatusRecords(output) {
  if (typeof output !== "string" || Buffer.byteLength(output) > 1024 * 1024) {
    throw new Error("The local endpoint status metadata is invalid.");
  }
  if (output.trim() === "") return [];
  try {
    const parsed = JSON.parse(output);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    try {
      return output.trim().split("\n").map((line) => JSON.parse(line));
    } catch {
      throw new Error("The local endpoint status metadata is invalid.");
    }
  }
}

function localEndpointSnapshot(plan, marker, account = null) {
  const siwc = marker?.schemaVersion === CODEX_SIWC_MARKER_SCHEMA_VERSION;
  return {
    target: plan.target,
    endpoint: plan.endpoint,
    auth: {
      configured: siwc ? account?.ownership === "owned" &&
        account?.session === "connected" && account?.planEnabled === true : true,
      disclosure: "rotate-only",
      ...(siwc && account ? { account } : {}),
    },
    ...(siwc ? { registrationId: marker.registrationId } : {}),
    migrationRequired: false,
    canRotateCredential: true,
  };
}

async function readLegacyMigrationState(fileSystem, installRoot, installId) {
  const legacyRoot = join(installRoot, "legacy");
  const parent = await lstatIfExists(fileSystem, legacyRoot);
  if (!parent) return null;
  assertDirectoryMetadata(parent);
  const archive = join(legacyRoot, validateInstallId(installId));
  const metadata = await lstatIfExists(fileSystem, archive);
  if (!metadata) return null;
  assertDirectoryMetadata(metadata);
  const journalPath = join(archive, "migration.json");
  const journal = await lstatIfExists(fileSystem, journalPath);
  if (!journal) return "incomplete";
  if (!journal.isFile() || journal.isSymbolicLink() || journal.size > 4096) {
    throw new Error("The legacy migration journal is unsafe.");
  }
  let record;
  try { record = JSON.parse(await fileSystem.readFile(journalPath, "utf8")); }
  catch { throw new Error("The legacy migration journal is invalid."); }
  if (record?.schemaVersion !== 1 ||
      record?.reviewedLegacy?.installId !== installId ||
      !["prepared", "stopped", "transferred"].includes(record?.state)) {
    throw new Error("The legacy migration journal needs manual inspection.");
  }
  return record.state;
}

async function assertInstalledCodexCompose({ fileSystem, installRoot, marker }) {
  if (marker.schemaVersion !== CODEX_SIWC_MARKER_SCHEMA_VERSION) {
    throw new Error("The native Codex login installation requires fresh SIWC sign-in and reviewed migration.");
  }
  const composePath = join(installRoot, COMPOSE_FILENAME);
  await assertRegularManagedMarker(
    fileSystem, composePath, "The installed Codex Compose file is unsafe.",
  );
  const contents = await fileSystem.readFile(composePath, "utf8");
  if (contents.length > 512 * 1024) {
    throw new Error("The installed Codex Compose file is invalid.");
  }
  const values = [...contents.matchAll(/^[ \t]*RELMIO_GATEWAY_TOKEN_SHA256:[ \t]*([a-f0-9]{64})[ \t]*$/gmu)];
  if (values.length !== 1) throw new Error("The installed Codex capability verifier is invalid.");
  const options = {
    port: marker.port, tokenSha256: values[0][1],
    installId: marker.installId, registrationId: marker.registrationId,
  };
  const expected = marker.target === "codex-chat"
    ? createCodexChatComposeFile(options)
    : createCodexComposeFile(options);
  if (contents !== expected) throw new Error("The installed Codex Compose file changed.");
}

async function verifyWindowsManagedLocalEndpointPathSecurity({
  fileSystem,
  installRoot,
  platform,
  lockDownPath,
}) {
  if (platform !== "win32") return;
  const relmioHome = resolve(installRoot, "..", "..");
  for (const path of [relmioHome, join(relmioHome, "local"), installRoot]) {
    assertDirectoryMetadata(await lstatIfExists(fileSystem, path));
    await lockDownPath(path, { platform, verifyOnly: true });
  }
  for (const path of [
    join(relmioHome, ROOT_MARKER),
    join(installRoot, MANAGED_MARKER),
    join(installRoot, COMPOSE_FILENAME),
  ]) {
    await assertRegularManagedMarker(
      fileSystem,
      path,
      "Relmio refuses an unsafe local endpoint managed file.",
    );
    await lockDownPath(path, {
      platform,
      kind: "file",
      verifyOnly: true,
      verifyEffectiveOwnerOnly: true,
    });
  }
}

export async function getManagedLocalEndpointStatus(
  { target },
  {
    fileSystem = defaultFileSystem,
    runProcess = runLocalProcess,
    platform = process.platform,
    env = process.env,
    homeDirectory = homedir(),
    lockDownPath = lockDownLocalPath,
  } = {},
) {
  const safeTarget = validateLocalTarget(target);
  const absent = { target: safeTarget, managed: false, state: "absent" };
  const unavailable = { target: safeTarget, managed: false, state: "unavailable" };
  try {
    assertSupportedPlatform(platform);
    const installRoot = await resolveLocalInstallRoot({
      target: safeTarget,
      env,
      homeDirectory,
      fileSystem,
      platform,
    });
    const relmioHome = resolve(installRoot, "..", "..");
    if (safeTarget !== "xai-grok-build") {
      const staged = await readLocalSiwcStaging({ fileSystem, installRoot, platform, lockDownPath });
      if (staged && staged.checkpoint.stage !== "completed") {
        await fingerprintLocalSiwcFiles({ fileSystem, installRoot, platform, lockDownPath });
        const { installId, registrationId, stage } = staged.checkpoint;
        return { target: safeTarget, managed: true, state: "staged",
          staging: { installId, registrationId, stage } };
      }
    }
    if (await lstatIfExists(fileSystem, installRoot)) {
      await verifyWindowsManagedLocalEndpointPathSecurity({
        fileSystem,
        installRoot,
        platform,
        lockDownPath,
      });
    }
    const managed = await inspectManagedRoot({
      fileSystem,
      relmioHome,
      installRoot,
      target: safeTarget,
    });
    if (!managed.marker) return absent;
    const selectedDockerHost = await resolveLocalDockerHost({
      runProcess,
      cwd: installRoot,
      env,
      platform,
    });
    if (selectedDockerHost !== managed.marker.dockerHost) return unavailable;
    if (safeTarget !== "xai-grok-build" &&
        managed.marker.schemaVersion !== CODEX_SIWC_MARKER_SCHEMA_VERSION) {
      const port = validateLocalPort(managed.marker.port);
      const migrationState = await readLegacyMigrationState(
        fileSystem, installRoot, managed.marker.installId,
      );
      if (migrationState === "transferred") {
        throw new Error("The legacy migration metadata is inconsistent.");
      }
      return {
        target: safeTarget, managed: true,
        state: migrationState ? "partial" : "legacy",
        snapshot: {
          target: safeTarget,
          endpoint: safeTarget === "codex-chatgpt"
            ? `ws://127.0.0.1:${port}` : `http://127.0.0.1:${port}`,
          auth: { configured: false, disclosure: "rotate-only" },
          canRotateCredential: false, migrationRequired: true,
          ...(migrationState ? {
            migrationState, legacyResourcesPreserved: true,
          } : {}),
        },
      };
    }
    if (safeTarget !== "xai-grok-build") {
      if (managed.marker.legacyInstallId) {
        const migrationState = await readLegacyMigrationState(
          fileSystem, installRoot, managed.marker.legacyInstallId,
        );
        if (migrationState !== "transferred") {
          const port = validateLocalPort(managed.marker.port);
          return {
            target: safeTarget, managed: true, state: "partial",
            snapshot: {
              target: safeTarget,
              endpoint: safeTarget === "codex-chatgpt"
                ? `ws://127.0.0.1:${port}` : `http://127.0.0.1:${port}`,
              auth: { configured: false, disclosure: "rotate-only" },
              canRotateCredential: false,
              migrationRequired: !managed.marker.previousWasSiwc,
              replacementRequired: !!managed.marker.previousWasSiwc,
              migrationState: migrationState ?? "incomplete",
              legacyResourcesPreserved: true,
            },
          };
        }
      }
      await assertInstalledCodexCompose({
        fileSystem, installRoot, marker: managed.marker,
      });
      if (platform === "win32") {
        for (const relative of [
          "Dockerfile", ".dockerignore", "config.toml", "requirements.toml",
          "package.json", "package-lock.json", "services/siwc-session.mjs",
          "services/siwc-handoff.mjs", "infrastructure/local-process.js",
          "services/local-integration-lifecycle-lock.js", "services/codex-images.mjs", "services/model-discovery.mjs",
          "infrastructure/process-identity.js",
          safeTarget === "codex-chat" ? "gateway/codex-chat.js" : "gateway/codex-app-server.mjs",
        ]) {
          const path = join(installRoot, relative);
          // Installs made before the image add-on or model discovery lack these files; verify them whenever present.
          if (["services/codex-images.mjs", "services/model-discovery.mjs"].includes(relative) &&
              !await lstatIfExists(fileSystem, path)) continue;
          await assertRegularManagedMarker(fileSystem, path, "The installed Codex SIWC asset is unsafe.");
          await lockDownPath(path, {
            platform, kind: "file", verifyOnly: true, verifyEffectiveOwnerOnly: true,
          });
        }
      }
    }
    const plan = createLocalDeploymentPlan({
      target: safeTarget,
      port: managed.marker.port,
      authBinding: managed.marker.authBinding,
    });
    const counts = await attestDockerOwnership({
      target: safeTarget,
      installRoot,
      dockerHost: managed.marker.dockerHost,
      installId: managed.marker.installId,
      projectName: managed.marker.projectName,
      runProcess,
      strictResourceIdentities: true,
    });
    const expectedCounts = {
      container: 1,
      network: 1,
      volume: PROJECTS[safeTarget].volumeNames.length,
    };
    if (Object.keys(expectedCounts).some((key) => counts[key] > expectedCounts[key])) {
      return unavailable;
    }
    const result = await runOrThrow(runProcess, {
      label: "Local endpoint inventory check",
      file: "docker",
      args: createComposeArgs(safeTarget, managed.marker.projectName, [
        "ps",
        "--all",
        "--format",
        "json",
        PROJECTS[safeTarget].serviceName,
      ]),
      cwd: installRoot,
      dockerHost: managed.marker.dockerHost,
    });
    const records = parseComposeStatusRecords(result.stdout);
    let account = null;
    if (safeTarget !== "xai-grok-build" &&
        records.length === 1 && records[0]?.State === "running") {
      try {
        account = (await runCodexSiwcCommand({
          target: safeTarget, installRoot,
          dockerHost: managed.marker.dockerHost,
          projectName: managed.marker.projectName,
          command: "account-live", runProcess,
        })).account;
        if (account?.registrationId !== managed.marker.registrationId ||
            account?.ownerHostId !== managed.marker.ownerHostId ||
            account?.ownerRuntimeId !== managed.marker.installId ||
            account?.ownership !== "owned") {
          throw new Error("The installed Codex SIWC account could not be attested.");
        }
      } catch {
        return {
          target: safeTarget, managed: true, state: "partial",
          snapshot: localEndpointSnapshot(plan, managed.marker),
        };
      }
    }
    const snapshot = localEndpointSnapshot(plan, managed.marker, account);
    if (records.length === 0) {
      return { target: safeTarget, managed: true, state: "partial" };
    }
    if (records.length !== 1) {
      return unavailable;
    }
    const record = records[0];
    const expectedName = `${managed.marker.projectName}-${PROJECTS[safeTarget].serviceName}-1`;
    if (
      record.Name !== expectedName ||
      record.Service !== PROJECTS[safeTarget].serviceName ||
      typeof record.State !== "string"
    ) {
      return unavailable;
    }
    validatePublishedEndpoint(JSON.stringify(record), {
      target: safeTarget,
      port: plan.port,
    });
    if (Object.keys(expectedCounts).some((key) => counts[key] !== expectedCounts[key])) {
      return { target: safeTarget, managed: true, state: "partial" };
    }
    if (record.State === "running") {
      return record.Health === "healthy"
        ? { target: safeTarget, managed: true, state: "healthy", snapshot }
        : { target: safeTarget, managed: true, state: "partial" };
    }
    if (
      ["created", "exited"].includes(record.State) &&
      !["starting", "unhealthy"].includes(record.Health)
    ) {
      return { target: safeTarget, managed: true, state: "stopped", snapshot };
    }
    return { target: safeTarget, managed: true, state: "partial" };
  } catch {
    return unavailable;
  }
}

async function verifyHttpEndpoint({ plan, clientCredential, fetchImpl }) {
  const healthPath = plan.target === "codex-chatgpt" ? "/readyz" : "/health";
  let health;
  try {
    health = await fetchImpl(`http://127.0.0.1:${plan.port}${healthPath}`, {
      method: "GET",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new Error("The local endpoint did not answer its readiness check.");
  }
  if (!health.ok) throw new Error("The local endpoint did not pass its readiness check.");
  if (["codex-chat", "xai-grok-build"].includes(plan.target) && clientCredential !== undefined) {
    let verification;
    try {
      verification = await fetchImpl(`http://127.0.0.1:${plan.port}/auth/verify`, {
        method: "GET", headers: { Authorization: `Bearer ${clientCredential}` }, signal: AbortSignal.timeout(10_000),
      });
    } catch {
      throw new Error("The local agent client credential could not be verified.");
    }
    if (!verification.ok) throw new Error("The local agent client credential could not be verified.");
  }
  return [];
}

async function verifyCodexChatCatalog({ port, clientCredential, fetchImpl }) {
  const response = await fetchImpl(`http://127.0.0.1:${port}/models`, {
    method: "GET",
    headers: { Authorization: `Bearer ${clientCredential}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw Object.assign(new Error("The selected account catalog is unavailable."), {
    status: response.status,
  });
  const payload = await response.json();
  if (!Array.isArray(payload?.models) ||
      !payload.models.every(model => typeof model?.slug === "string" &&
        /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(model.slug))) {
    throw new Error("The selected account model catalog is invalid.");
  }
  return payload.models.map(model => model.slug);
}

async function verifyGrokBuildCli({ installRoot, dockerHost, projectName, runProcess }) {
  const result = await runOrThrow(runProcess, {
    label: "Grok Build CLI version verification",
    file: "docker",
    args: createComposeArgs("xai-grok-build", projectName, [
      "run", "--rm", "--no-deps", "--pull", "never", "--entrypoint", "grok", "grok-build", "--version",
    ]),
    cwd: installRoot,
    dockerHost,
  });
  if (!new RegExp(`^grok ${GROK_BUILD_CLI_VERSION.replaceAll(".", "\\.")} \\([0-9a-f]{7,64}\\)\\r?\\n?$`, "u").test(result.stdout)) {
    throw new Error("The managed Grok Build CLI version could not be verified.");
  }
}

export function verifyCodexWebSocketCapability(
  { port, clientCredential },
  {
    connectSocket = createConnection,
    randomBytes = createRandomBytes,
    timeoutMs = 10_000,
  } = {},
) {
  const safePort = validateLocalPort(port);
  if (
    typeof clientCredential !== "string" ||
    !/^[A-Za-z0-9_-]{43}$/u.test(clientCredential)
  ) {
    throw new TypeError("The staged local client credential is invalid.");
  }
  const keyBytes = randomBytes(16);
  if (!Buffer.isBuffer(keyBytes) || keyBytes.length !== 16) {
    throw new Error("Relmio could not verify the Codex client capability.");
  }
  const websocketKey = keyBytes.toString("base64");
  const expectedAccept = createHash("sha1")
    .update(`${websocketKey}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");

  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    let response = "";
    const socket = connectSocket(
      { host: "127.0.0.1", port: safePort },
      () => {
        socket.write(
          [
            "GET / HTTP/1.1",
            `Host: 127.0.0.1:${safePort}`,
            "Upgrade: websocket",
            "Connection: Upgrade",
            `Sec-WebSocket-Key: ${websocketKey}`,
            "Sec-WebSocket-Version: 13",
            `Authorization: Bearer ${clientCredential}`,
            "",
            "",
          ].join("\r\n"),
        );
      },
    );

    const finish = (error) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      if (error) {
        rejectPromise(
          new Error("The Codex client credential could not be verified."),
        );
      } else {
        resolvePromise();
      }
    };

    socket.setTimeout(timeoutMs, () => finish(new Error("timeout")));
    socket.on("error", finish);
    socket.on("close", () => finish(new Error("closed")));
    socket.on("data", (chunk) => {
      response += chunk.toString("latin1");
      if (response.length > 16 * 1024) {
        finish(new Error("oversized"));
        return;
      }
      const headerEnd = response.indexOf("\r\n\r\n");
      if (headerEnd === -1) {
        return;
      }
      const lines = response.slice(0, headerEnd).split("\r\n");
      if (!/^HTTP\/1\.1 101(?: |$)/u.test(lines.shift() ?? "")) {
        finish(new Error("unauthorized"));
        return;
      }
      const headers = new Map();
      for (const line of lines) {
        const separator = line.indexOf(":");
        if (separator <= 0) {
          finish(new Error("malformed"));
          return;
        }
        const rawName = line.slice(0, separator);
        if (!/^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/u.test(rawName)) {
          finish(new Error("malformed"));
          return;
        }
        const name = rawName.toLowerCase();
        const value = line.slice(separator + 1).trim();
        if (headers.has(name)) {
          finish(new Error("duplicate"));
          return;
        }
        headers.set(name, value);
      }
      if (
        headers.get("upgrade")?.toLowerCase() !== "websocket" ||
        !headers
          .get("connection")
          ?.split(",")
          .some((value) => value.trim().toLowerCase() === "upgrade") ||
        headers.get("sec-websocket-accept") !== expectedAccept
      ) {
        finish(new Error("invalid upgrade"));
        return;
      }
      finish();
    });
  });
}


async function defaultReadGrokBuildSource() {
  return defaultFileSystem.readFile(
    new URL("../supergrok/runtime.js", import.meta.url),
    "utf8",
  );
}

async function defaultReadGrokBuildChatSource() {
  return defaultFileSystem.readFile(
    new URL("../supergrok/chat.js", import.meta.url),
    "utf8",
  );
}

async function defaultReadGrokBuildSessionSource() {
  return defaultFileSystem.readFile(
    new URL("../supergrok/session.js", import.meta.url),
    "utf8",
  );
}

async function attestManagedGrokBuildFiles({
  fileSystem,
  installRoot,
  marker,
  readGrokBuildSource,
  readGrokBuildChatSource,
  readGrokBuildSessionSource,
}) {
  const expected = {
    Dockerfile: createGrokBuildDockerfile(),
    ".dockerignore": createLocalDockerignore("xai-grok-build"),
    [COMPOSE_FILENAME]: createGrokBuildComposeFile({
      port: marker.port,
      tokenSha256: marker.tokenSha256,
      installId: marker.installId,
    }),
    "gateway.js": validateGrokBuildPackagedSource(await readGrokBuildSource()),
    "chat.js": validateGrokBuildPackagedSource(await readGrokBuildChatSource()),
    "session.js": validateGrokBuildPackagedSource(await readGrokBuildSessionSource()),
  };
  for (const [name, contents] of Object.entries(expected)) {
    const path = join(installRoot, name);
    const metadata = await lstatIfExists(fileSystem, path);
    if (!metadata?.isFile?.() || metadata.isSymbolicLink()) {
      throw new Error("The managed Grok Build files could not be attested.");
    }
    const actual = await fileSystem.readFile(path, "utf8");
    if (actual !== contents) {
      throw new Error("The managed Grok Build files changed. Nothing was launched.");
    }
  }
}

function validateGrokBuildPackagedSource(source) {
  if (
    typeof source !== "string" ||
    source.length === 0 ||
    source.length > 512 * 1024
  ) {
    throw new Error("The packaged Grok Build runtime is invalid.");
  }
  return source;
}

async function attestManagedLocalEndpoint(
  {
    target,
    installDirectory,
    missingMessage,
    notRunningMessage,
    allowStopped = false,
    requireExactGatewayIdentity = false,
  },
  {
    fileSystem = defaultFileSystem,
    runProcess = runLocalProcess,
    platform = process.platform,
    lockDownPath = lockDownLocalPath,
    readGrokBuildSource = defaultReadGrokBuildSource,
    readGrokBuildChatSource = defaultReadGrokBuildChatSource,
    readGrokBuildSessionSource = defaultReadGrokBuildSessionSource,
  } = {},
) {
  assertSupportedPlatform(platform);
  const safeTarget = validateLocalTarget(target);
  const safeDirectory = validateInstallDirectory(
    installDirectory,
    safeTarget,
  );
  const relmioHome = resolve(safeDirectory, "..", "..");
  await verifyWindowsManagedLocalEndpointPathSecurity({
    fileSystem,
    installRoot: safeDirectory,
    platform,
    lockDownPath,
  });
  const managed = await inspectManagedRoot({
    fileSystem,
    relmioHome,
    installRoot: safeDirectory,
    target: safeTarget,
  });
  if (managed.deploymentMode !== "updated" || !managed.marker) {
    throw new Error(missingMessage);
  }
  if (safeTarget === "xai-grok-build") {
    if (typeof managed.marker.tokenSha256 !== "string") {
      throw new Error(
        "The managed Grok Build verifier is missing. This legacy installation requires a separately reviewed migration; its saved session has not been changed.",
      );
    }
    await attestManagedGrokBuildFiles({
      fileSystem,
      installRoot: safeDirectory,
      marker: managed.marker,
      readGrokBuildSource,
      readGrokBuildChatSource,
      readGrokBuildSessionSource,
    });
  } else {
    await assertInstalledCodexCompose({
      fileSystem, installRoot: safeDirectory, marker: managed.marker,
    });
  }
  const ownership = await attestDockerOwnership({
    target: safeTarget,
    installRoot: safeDirectory,
    dockerHost: managed.marker.dockerHost,
    installId: managed.marker.installId,
    projectName: managed.marker.projectName,
    runProcess,
    strictResourceIdentities: requireExactGatewayIdentity ? { container: true } : false,
  });
  if (requireExactGatewayIdentity && ownership.container !== 1) {
    throw new Error("The managed local gateway identity is not exact.");
  }
  const verification = createVerificationSpecs({
    target: safeTarget,
    installRoot: safeDirectory,
    dockerHost: managed.marker.dockerHost,
    projectName: managed.marker.projectName,
  });
  const running = await runOrThrow(runProcess, verification.running);
  const runningServices = running.stdout.trim() === ""
    ? []
    : running.stdout.trim().split(/\s+/u);
  const gatewayIsRunning =
    runningServices.length === 1 &&
    runningServices[0] === PROJECTS[safeTarget].serviceName;
  if (!gatewayIsRunning) {
    if (allowStopped === true && runningServices.length === 0) {
      return {
        target: safeTarget,
        installDirectory: safeDirectory,
        port: managed.marker.port,
        dockerHost: managed.marker.dockerHost,
        installId: managed.marker.installId,
        projectName: managed.marker.projectName,
        ...(safeTarget === "xai-grok-build" ? {} : { authBinding: managed.marker.authBinding }),
        running: false,
      };
    }
    throw new Error(
      notRunningMessage ?? "The managed local endpoint is not running.",
    );
  }
  const publication = await runOrThrow(runProcess, verification.publication);
  validatePublishedEndpoint(publication.stdout, {
    target: safeTarget,
    port: managed.marker.port,
  });
  return {
    target: safeTarget,
    installDirectory: safeDirectory,
    port: managed.marker.port,
    dockerHost: managed.marker.dockerHost,
    installId: managed.marker.installId,
    projectName: managed.marker.projectName,
    ...(safeTarget === "xai-grok-build" ? {} : { authBinding: managed.marker.authBinding }),
    running: true,
  };
}


export async function attestLocalGrokBuildInstallation(
  { installDirectory },
  dependencies = {},
) {
  const attested = await attestManagedLocalEndpoint(
    {
      target: "xai-grok-build",
      installDirectory,
      missingMessage: "Install the local Grok Build endpoint before signing in.",
      notRunningMessage: "The managed local Grok Build endpoint is not running.",
    },
    dependencies,
  );
  return {
    installDirectory: attested.installDirectory,
    dockerHost: attested.dockerHost,
    projectName: attested.projectName,
  };
}

export async function prepareLocalClientCredentialRotation(
  { target },
  {
    fileSystem = defaultFileSystem,
    env = process.env,
    homeDirectory = homedir(),
    runProcess = runLocalProcess,
    randomBytes = createRandomBytes,
    platform = process.platform,
    lockDownPath = lockDownLocalPath,
  } = {},
) {
  assertSupportedPlatform(platform);
  rejectDockerEnvironmentOverrides(env);
  const safeTarget = validateLocalTarget(target);
  const installDirectory = await resolveLocalInstallRoot({
    target: safeTarget,
    env,
    homeDirectory,
    fileSystem,
    platform,
  });
  const attested = await attestManagedLocalEndpoint(
    {
      target: safeTarget,
      installDirectory,
      missingMessage:
        "Install the local endpoint before rotating its client credential.",
    },
    { fileSystem, runProcess, platform, lockDownPath },
  );
  let selectedAccount = null;
  if (safeTarget !== "xai-grok-build") {
    selectedAccount = (await runCodexSiwcCommand({
      target: safeTarget, installRoot: installDirectory,
      dockerHost: attested.dockerHost, projectName: attested.projectName,
      command: "account-live", runProcess,
    })).account;
    if (selectedAccount?.registrationId !== attested.authBinding.registrationId ||
        selectedAccount?.ownerRuntimeId !== attested.installId ||
        selectedAccount?.ownership !== "owned") {
      throw new Error("The installed SIWC account could not be reviewed for local capability rotation.");
    }
  }
  const { clientCredential, tokenSha256 } = createClientCredential(randomBytes);
  const plan = createLocalDeploymentPlan({
    target: safeTarget,
    port: attested.port,
    authBinding: attested.authBinding,
  });
  return {
    target: plan.target,
    endpoint: plan.endpoint,
    protocol: plan.protocol,
    clientCredential,
    tokenSha256,
    ...(selectedAccount ? {
      registrationId: selectedAccount.registrationId,
      expectedGeneration: selectedAccount.generation,
    } : {}),
    credentialShownOnce: true,
    models: [],
    deploymentMode: "staged",
    experimental: plan.experimental,
    browserClients: plan.browserClients,
  };
}

export async function activateLocalClientCredentialRotation(
  { target, clientCredential, tokenSha256, registrationId, expectedGeneration },
  {
    fileSystem = defaultFileSystem,
    env = process.env,
    homeDirectory = homedir(),
    runProcess = runLocalProcess,
    fetchImpl = fetch,
    verifyCodexCapability = verifyCodexWebSocketCapability,
    platform = process.platform,
    lockDownPath = lockDownLocalPath,
    processId = process.pid,
    isProcessAlive = defaultIsProcessAlive,
    getProcessIdentity,
    runSiwcCommand = runCodexSiwcCommand,
  } = {},
) {
  assertSupportedPlatform(platform);
  rejectDockerEnvironmentOverrides(env);
  const safeTarget = validateLocalTarget(target);
  const safeVerifier = validateClientCredentialVerifier(tokenSha256);
  if (
    typeof clientCredential !== "string" ||
    createHash("sha256").update(clientCredential).digest("hex") !== safeVerifier
  ) {
    throw new TypeError("The staged local client credential is invalid.");
  }
  const installDirectory = await resolveLocalInstallRoot({
    target: safeTarget,
    env,
    homeDirectory,
    fileSystem,
    platform,
  });
  const releaseLock = await acquireLocalProjectLock(
    { installRoot: installDirectory, target: safeTarget },
    { fileSystem, processId, isProcessAlive, getProcessIdentity, platform },
  );
  return settleLocalProjectOperation({
    completionLabel: "Local credential rotation",
    releaseLock,
    operation: async () => {
  const attested = await attestManagedLocalEndpoint(
    {
      target: safeTarget,
      installDirectory,
      missingMessage:
        "Install the local endpoint before rotating its client credential.",
    },
    { fileSystem, runProcess, platform, lockDownPath },
  );
  const composePath = join(installDirectory, COMPOSE_FILENAME);
  await assertRegularManagedMarker(
    fileSystem,
    composePath,
    "The managed local endpoint configuration is invalid.",
  );
  let previousCompose;
  try {
    previousCompose = await fileSystem.readFile(composePath, "utf8");
  } catch {
    throw new Error("The managed local endpoint configuration is invalid.");
  }

  const replacementCompose = replaceClientCredentialVerifier({
    target: safeTarget,
    composeFile: previousCompose,
    tokenSha256: safeVerifier,
  });
  const plan = createLocalDeploymentPlan({
    target: safeTarget,
    port: attested.port,
    authBinding: attested.authBinding,
  });
  const validateCompose = () =>
    runOrThrow(runProcess, {
      label: "Local Compose validation",
      file: "docker",
      args: createComposeArgs(safeTarget, attested.projectName, [
        "config",
        "--quiet",
      ]),
      cwd: installDirectory,
      dockerHost: attested.dockerHost,
    });
  if (safeTarget !== "xai-grok-build") {
    validateSiwcRegistrationId(registrationId);
    if (typeof expectedGeneration !== "string" ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(expectedGeneration) ||
        attested.authBinding.registrationId !== registrationId) {
      throw new Error("The selected Codex SIWC account changed before local credential rotation.");
    }
    const current = (await runSiwcCommand({
      target: safeTarget, installRoot: installDirectory,
      dockerHost: attested.dockerHost, projectName: attested.projectName,
      command: "account-live", runProcess,
    })).account;
    if (current?.registrationId !== registrationId ||
        current?.generation !== expectedGeneration ||
        current?.ownerRuntimeId !== attested.installId ||
        current?.ownership !== "owned") {
      throw new Error("The installed SIWC account changed. Review the rotation again.");
    }
    await runOrThrow(runProcess, {
      label: "Owned Codex endpoint drain", file: "docker",
      args: createComposeArgs(safeTarget, attested.projectName, [
        "stop", "--timeout", "30", PROJECTS[safeTarget].serviceName,
      ]),
      cwd: installDirectory, dockerHost: attested.dockerHost,
    });
    const stopped = await runOrThrow(runProcess, createVerificationSpecs({
      target: safeTarget, installRoot: installDirectory,
      dockerHost: attested.dockerHost, projectName: attested.projectName,
    }).running);
    if (stopped.stdout.trim() !== "") {
      throw new Error("The owned Codex endpoint did not drain; no verifier was replaced.");
    }
    const frozen = (await runSiwcCommand({
      target: safeTarget, installRoot: installDirectory,
      dockerHost: attested.dockerHost, projectName: attested.projectName,
      command: "account", runProcess,
    })).account;
    if (frozen?.registrationId !== registrationId ||
        frozen?.generation !== expectedGeneration ||
        frozen?.ownerRuntimeId !== attested.installId ||
        frozen?.ownership !== "owned") {
      throw new Error("The installed SIWC account changed while draining. The endpoint remains stopped.");
    }
  }
  let configurationWritten = false;

  try {
    await writeManagedFile(fileSystem, composePath, replacementCompose, 0o600);
    configurationWritten = true;
    await validateCompose();
    await runOrThrow(
      runProcess,
      createServiceRecreateSpec({
        target: safeTarget,
        installRoot: installDirectory,
        dockerHost: attested.dockerHost,
        projectName: attested.projectName,
      }),
    );
    await attestManagedLocalEndpoint(
      {
        target: safeTarget,
        installDirectory,
        missingMessage:
          "Install the local endpoint before rotating its client credential.",
      },
      { fileSystem, runProcess, platform, lockDownPath },
    );
    const models = await verifyHttpEndpoint({
      plan,
      clientCredential,
      fetchImpl,
    });
    if (safeTarget === "codex-chatgpt") {
      await verifyCodexCapability({
        port: plan.port,
        clientCredential,
      });
    }
    return {
      target: plan.target,
      endpoint: plan.endpoint,
      protocol: plan.protocol,
      models,
      deploymentMode: "updated",
      experimental: plan.experimental,
      browserClients: plan.browserClients,
    };
  } catch (error) {
    if (error?.committed === true) {
      configurationWritten = true;
    }
    if (!configurationWritten) {
      throw new Error("Relmio could not rotate the local client credential.");
    }

    try {
      await writeManagedFile(fileSystem, composePath, previousCompose, 0o600);
      await validateCompose();
      await runOrThrow(
        runProcess,
        createServiceRecreateSpec({
          target: safeTarget,
          installRoot: installDirectory,
          dockerHost: attested.dockerHost,
          projectName: attested.projectName,
        }),
      );
      await attestManagedLocalEndpoint(
        {
          target: safeTarget,
          installDirectory,
          missingMessage:
            "Install the local endpoint before rotating its client credential.",
        },
        { fileSystem, runProcess, platform, lockDownPath },
      );
      await verifyHttpEndpoint({ plan, fetchImpl });
    } catch {
      let stopped = false;
      try {
        await runOrThrow(
          runProcess,
          createCleanupSpec({
            target: safeTarget,
            installRoot: installDirectory,
            dockerHost: attested.dockerHost,
            projectName: attested.projectName,
          }),
        );
        const remaining = await runOrThrow(
          runProcess,
          createCleanupVerificationSpec({
            target: safeTarget,
            installRoot: installDirectory,
            dockerHost: attested.dockerHost,
            projectName: attested.projectName,
          }),
        );
        stopped = !remaining.stdout
          .split(/\s+/u)
          .includes(PROJECTS[safeTarget].serviceName);
      } catch {
        // The endpoint is left stopped only when Docker confirms the exact service is gone.
      }
      if (stopped) {
        throw new Error(
          "Local credential rotation failed safely. The local endpoint was stopped.",
        );
      }
      throw new Error(
        "Relmio could not confirm that the failed credential rotation was stopped. Inspect the Relmio Docker project before retrying.",
      );
    }

    throw new Error(
      "Local credential rotation failed safely. The previous verifier was restored and the managed endpoint was re-attested.",
    );
  }
    },
  });
}

async function validateReviewedCodexAccount(registration, binding) {
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
  ) throw new Error("The selected SIWC account changed. Review and confirm it again.");
}

async function reviewCodexOwnedReplacement(
  { target, existingSiwc = false },
  {
    fileSystem = defaultFileSystem, env = process.env,
    homeDirectory = homedir(), runProcess = runLocalProcess,
    platform = process.platform, lockDownPath = lockDownLocalPath,
  } = {},
) {
  const safeTarget = validateLocalTarget(target);
  if (safeTarget === "xai-grok-build") {
    throw new TypeError("Only a managed legacy Codex endpoint can be migrated.");
  }
  assertSupportedPlatform(platform);
  rejectDockerEnvironmentOverrides(env);
  const installRoot = await resolveLocalInstallRoot({
    target: safeTarget, env, homeDirectory, fileSystem, platform,
  });
  await verifyWindowsManagedLocalEndpointPathSecurity({
    fileSystem, installRoot, platform, lockDownPath,
  });
  const managed = await inspectManagedRoot({
    fileSystem, relmioHome: resolve(installRoot, "..", ".."),
    installRoot, target: safeTarget,
  });
  const marker = managed.marker;
  const expectedSchema = existingSiwc ? CODEX_SIWC_MARKER_SCHEMA_VERSION : MARKER_SCHEMA_VERSION;
  if (marker?.schemaVersion !== expectedSchema) {
    throw new Error("The selected Codex installation is not the reviewed owned runtime.");
  }
  const selectedDockerHost = await resolveLocalDockerHost({
    runProcess, cwd: installRoot, env, platform,
  });
  if (selectedDockerHost !== marker.dockerHost) {
    throw new Error("The selected Docker context changed.");
  }
  const ownership = await attestDockerOwnership({
    target: safeTarget, installRoot, dockerHost: marker.dockerHost,
    installId: marker.installId, projectName: marker.projectName, runProcess,
  });
  const logicalVolumes = existingSiwc
    ? ["codex-state", "siwc-store", "codex-workspace"]
    : ["codex-home", "codex-workspace"];
  const destinations = existingSiwc
    ? ["/home/node/.codex", "/home/node/.relmio-siwc", "/workspace"]
    : ["/home/node/.codex", "/workspace"];
  if (ownership.container !== 1 || ownership.network !== 1 ||
      ownership.volume !== logicalVolumes.length) {
    throw new Error("The exact owned Codex project is missing or has unexpected resources.");
  }
  const volumes = logicalVolumes.map(name => `${marker.projectName}_${name}`);
  const listed = await runOrThrow(runProcess, {
    label: "Legacy Codex volume identity check", file: "docker",
    args: ["volume", "ls", "--filter",
      `label=com.docker.compose.project=${marker.projectName}`,
      "--format", "{{json .}}"],
    cwd: installRoot, dockerHost: marker.dockerHost,
  });
  const volumeNames = listed.stdout.trim().split("\n").map(row => {
    try { return JSON.parse(row).Name; } catch { return null; }
  }).sort();
  if (JSON.stringify(volumeNames) !== JSON.stringify([...volumes].sort())) {
    throw new Error("The legacy credential and workspace volumes changed.");
  }
  const configResult = await runOrThrow(runProcess, {
    label: "Legacy Codex Compose validation", file: "docker",
    args: createComposeArgs(safeTarget, marker.projectName, ["config", "--format", "json"]),
    cwd: installRoot, dockerHost: marker.dockerHost,
  });
  let config;
  try { config = JSON.parse(configResult.stdout); } catch {
    throw new Error("The legacy Codex Compose metadata is invalid.");
  }
  const service = PROJECTS[safeTarget].serviceName;
  const current = config?.services?.[service];
  const port = validateLocalPort(marker.port);
  const mounted = Array.isArray(current?.volumes) ? current.volumes : [];
  if (Object.keys(config?.services ?? {}).length !== 1 ||
      Object.keys(config?.networks ?? {}).length !== 1 ||
      config?.networks?.default?.name !== `${marker.projectName}_default` ||
      (existingSiwc && (
        current?.environment?.RELMIO_REGISTRATION_ID !== marker.registrationId ||
        current?.environment?.RELMIO_RUNTIME_ID !== marker.installId ||
        current?.environment?.N8N_OPENAI_OAUTH_HOME !== "/home/node/.relmio-siwc"
      )) ||
      logicalVolumes.some((name, index) => config?.volumes?.[name]?.name !== volumes[index]) ||
      logicalVolumes.some((name, index) => !mounted.some(item =>
        item.source === name && item.target === destinations[index])) ||
      mounted.length !== logicalVolumes.length ||
      !Array.isArray(current?.ports) || current.ports.length !== 1 ||
      String(current.ports[0]?.published) !== String(port) ||
      current.ports[0]?.host_ip !== "127.0.0.1" ||
      current.ports[0]?.target !== PROJECTS[safeTarget].containerPort) {
    throw new Error("The legacy Codex Compose deployment differs from the owned installation.");
  }
  const containerResult = await runOrThrow(runProcess, {
    label: "Legacy Codex container identity check", file: "docker",
    args: createComposeArgs(safeTarget, marker.projectName, [
      "ps", "--all", "-q", service,
    ]),
    cwd: installRoot, dockerHost: marker.dockerHost,
  });
  const containerId = containerResult.stdout.trim();
  if (!/^[a-f0-9]{64}$/u.test(containerId)) {
    throw new Error("The legacy Codex container identity is invalid.");
  }
  const inspected = await runOrThrow(runProcess, {
    label: "Legacy Codex container inspection", file: "docker",
    args: ["container", "inspect", "--format", "{{json .}}", containerId],
    cwd: installRoot, dockerHost: marker.dockerHost,
  });
  let container;
  try { container = JSON.parse(inspected.stdout); } catch {
    throw new Error("The legacy Codex container metadata is invalid.");
  }
  const imageId = container?.Image;
  const networkResult = await runOrThrow(runProcess, {
    label: "Owned Codex network identity check", file: "docker",
    args: ["network", "inspect", "--format", "{{json .}}", `${marker.projectName}_default`],
    cwd: installRoot, dockerHost: marker.dockerHost,
  });
  let network;
  try { network = JSON.parse(networkResult.stdout); } catch {
    throw new Error("The owned Codex network identity is invalid.");
  }
  const networkId = network?.Id;
  const containerNetworkId =
    container?.NetworkSettings?.Networks?.[`${marker.projectName}_default`]?.NetworkID;
  const mounts = container?.Mounts;
  if (container?.Id !== containerId ||
      !/^sha256:[a-f0-9]{64}$/u.test(imageId) ||
      !/^[a-f0-9]{64}$/u.test(networkId) ||
      network?.Name !== `${marker.projectName}_default` ||
      (container?.State?.Running && containerNetworkId !== networkId) ||
      (container?.State?.Running === false && containerNetworkId !== undefined &&
        containerNetworkId !== networkId) ||
      container?.State?.Paused !== false ||
      typeof container?.State?.Running !== "boolean" ||
      container?.Config?.Labels?.["com.docker.compose.project"] !== marker.projectName ||
      container?.Config?.Labels?.["com.docker.compose.service"] !== service ||
      container?.Config?.Labels?.["io.relmio.managed"] !== "true" ||
      container?.Config?.Labels?.["io.relmio.target"] !== safeTarget ||
      container?.Config?.Labels?.["io.relmio.install"] !== marker.installId ||
      !Array.isArray(mounts) || mounts.length !== logicalVolumes.length ||
      logicalVolumes.some((name, index) => !mounts.some(item =>
        item.Type === "volume" && item.Name === volumes[index] &&
        item.Destination === destinations[index]))) {
    throw new Error("The old Codex container, image, network or volumes changed.");
  }
  return Object.freeze({
    target: safeTarget, installId: marker.installId,
    projectName: marker.projectName, dockerHost: marker.dockerHost,
    port, containerId, imageId, networkId,
    volumeNames: Object.freeze(volumes),
    ...(existingSiwc ? {
      registrationId: marker.registrationId,
      ownerHostId: marker.ownerHostId,
    } : {}),
    running: container.State.Running,
  });
}

export function reviewLocalCodexLegacyMigration({ target }, deps = {}) {
  return reviewCodexOwnedReplacement({ target }, deps);
}

export function reviewLocalCodexSiwcReplacement({ target }, deps = {}) {
  return reviewCodexOwnedReplacement({ target, existingSiwc: true }, deps);
}

async function attestRetiredCodex({ runProcess, installRoot, binding }) {
  validateInstallId(binding?.installId);
  if (!/^[a-f0-9]{64}$/u.test(binding.containerId)) throw new Error("The retained Codex identity is invalid.");
  const container = JSON.parse((await runOrThrow(runProcess, {
    label: "Retired Codex writer check", file: "docker",
    args: ["container", "inspect", "--format", "{{json .}}", binding.containerId],
    cwd: installRoot, dockerHost: binding.dockerHost,
  })).stdout);
  if (container?.Id !== binding.containerId || container.Image !== binding.imageId ||
      container.State?.Running !== false || container.State?.Paused !== false ||
      container.Config?.Labels?.["io.relmio.install"] !== binding.installId ||
      container.Config?.Labels?.["com.docker.compose.project"] !== binding.projectName ||
      !Array.isArray(container.Mounts) ||
      JSON.stringify(container.Mounts.map(item => item.Name).sort()) !== JSON.stringify([...binding.volumeNames].sort())) {
    throw new Error("The retained old Codex writer or volumes changed.");
  }
}

export async function reviewLocalSiwcResume(
  { target, registration },
  { fileSystem = defaultFileSystem, env = process.env, homeDirectory = homedir(),
    runProcess = runLocalProcess, platform = process.platform, lockDownPath = lockDownLocalPath,
    runSiwcCommand = runCodexSiwcCommand } = {},
) {
  const safeTarget = validateLocalTarget(target);
  rejectDockerEnvironmentOverrides(env);
  const installRoot = await resolveLocalInstallRoot({ target: safeTarget, env, homeDirectory, fileSystem, platform });
  const staged = await readLocalSiwcStaging({ fileSystem, installRoot, platform, lockDownPath });
  if (!staged || staged.checkpoint.stage === "completed") throw new Error("There is no interrupted SIWC installation to resume.");
  const { checkpoint, checkpointSha256 } = staged;
  let plan = createLocalDeploymentPlan(checkpoint.plan);
  if (checkpoint.projectName !== createProjectName(safeTarget, checkpoint.installId) ||
      plan.target !== safeTarget ||
      await resolveLocalDockerHost({ runProcess, cwd: homeDirectory, env, platform }) !== checkpoint.dockerHost) {
    throw new Error("The staged SIWC destination changed.");
  }
  await attestDockerOwnership({ target: safeTarget, installRoot: homeDirectory,
    dockerHost: checkpoint.dockerHost, installId: checkpoint.installId,
    projectName: checkpoint.projectName, runProcess, strictResourceIdentities: true });
  if (checkpoint.reviewedLegacy && checkpoint.oldStopped) {
    await attestRetiredCodex({ runProcess, installRoot, binding: checkpoint.reviewedLegacy });
  }
  const filesSha256 = await fingerprintLocalSiwcFiles({ fileSystem, installRoot, platform, lockDownPath });
  const resourcesSha256 = await fingerprintLocalSiwcResources({ runProcess, installRoot, checkpoint });
  if (checkpoint.ownerHostId) {
    const { marker } = await inspectManagedRoot({ fileSystem, installRoot,
      relmioHome: resolve(installRoot, "..", ".."), target: safeTarget });
    if (marker?.installId !== checkpoint.installId || marker?.ownerHostId !== checkpoint.ownerHostId) {
      throw new Error("The staged SIWC owner marker changed.");
    }
    await assertInstalledCodexCompose({ fileSystem, installRoot, marker });
  }
  const authBinding = await readLocalSiwcResumeAuthBinding({ checkpoint, registration, readRegistration, readPendingAuthHandoff,
    readReceipt: pending => runSiwcCommand({ target: safeTarget, installRoot,
      dockerHost: checkpoint.dockerHost, projectName: checkpoint.projectName,
      registrationId: checkpoint.registrationId, command: "receipt", runProcess,
      input: Buffer.from(JSON.stringify({ handoffId: pending.handoffId, binding: pending.binding, identity: pending.identity })) }) });
  plan = createLocalDeploymentPlan({ ...checkpoint.plan, authBinding });
  return { target: safeTarget, installId: checkpoint.installId,
    registrationId: plan.authBinding.registrationId, stage: checkpoint.stage, plan, checkpointSha256,
    ...(checkpoint.migration ? { migration: checkpoint.migration } : {}),
    filesSha256, resourcesSha256 };
}

export async function reconcileLocalSiwcHandoff(
  { target, registration, confirmed },
  { fileSystem = defaultFileSystem, env = process.env, homeDirectory = homedir(),
    runProcess = runLocalProcess, platform = process.platform, lockDownPath = lockDownLocalPath,
    processId = process.pid, isProcessAlive = defaultIsProcessAlive, getProcessIdentity,
    runSiwcCommand = runCodexSiwcCommand } = {},
) {
  const safeTarget = validateLocalTarget(target);
  if (safeTarget === "xai-grok-build" || confirmed !== true) throw new Error("Confirm reconciliation of the selected SIWC handoff.");
  validateSiwcRegistrationId(registration?.registrationId);
  rejectDockerEnvironmentOverrides(env);
  const installRoot = await resolveLocalInstallRoot({ target: safeTarget, env, homeDirectory, fileSystem, platform });
  const releaseLock = await acquireLocalProjectLock({ installRoot, target: safeTarget },
    { fileSystem, processId, isProcessAlive, getProcessIdentity, platform });
  return settleLocalProjectOperation({ completionLabel: "SIWC handoff reconciliation", releaseLock,
    operation: async () => {
      await fingerprintLocalSiwcFiles({ fileSystem, installRoot, platform, lockDownPath });
      const { marker } = await inspectManagedRoot({ fileSystem, installRoot,
        relmioHome: resolve(installRoot, "..", ".."), target: safeTarget });
      if (marker?.registrationId !== registration.registrationId) throw new Error("The selected SIWC destination changed.");
      await assertInstalledCodexCompose({ fileSystem, installRoot, marker });
      if (await resolveLocalDockerHost({ runProcess, cwd: installRoot, env, platform }) !== marker.dockerHost) {
        throw new Error("The selected Docker context changed.");
      }
      await attestDockerOwnership({ target: safeTarget, installRoot, dockerHost: marker.dockerHost,
        installId: marker.installId, projectName: marker.projectName, runProcess, strictResourceIdentities: true });
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
        ({ receipt } = await runSiwcCommand({ target: safeTarget, installRoot,
          dockerHost: marker.dockerHost, projectName: marker.projectName, registrationId: marker.registrationId,
          command: "receipt", input: Buffer.from(JSON.stringify({
            handoffId: request.handoffId, binding: request.binding, identity: request.identity,
          })), runProcess }));
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
      const account = await finishAuthHandoff(registration, { handoffId: request.handoffId, receipt: receipt.receipt });
      return { outcome: "finished", account };
    } });
}

export async function installLocalEndpoint(
  request,
  {
    fileSystem = defaultFileSystem,
    env = process.env,
    homeDirectory = homedir(),
    runProcess = runLocalProcess,
    randomBytes = createRandomBytes,
    isPortAvailable = isLoopbackPortAvailable,
    collectAssets = collectSiwcRuntimeAssets,
    runSiwcCommand = runCodexSiwcCommand,
    readGrokBuildSource = defaultReadGrokBuildSource,
    readGrokBuildChatSource = defaultReadGrokBuildChatSource,
    readGrokBuildSessionSource = defaultReadGrokBuildSessionSource,
    fetchImpl = fetch,
    verifyCodexCapability = verifyCodexWebSocketCapability,
    platform = process.platform,
    lockDownPath = lockDownLocalPath,
    processId = process.pid,
    isProcessAlive = defaultIsProcessAlive,
    getProcessIdentity,
  } = {},
) {
  const isSiwc = request?.plan?.target !== "xai-grok-build";
  const migrating = request?.migrationConsent !== undefined ||
    request?.legacyBinding !== undefined || request?.resume?.migration === "legacy";
  const replacing = request?.replacementConsent !== undefined ||
    request?.existingBinding !== undefined || request?.resume?.migration === "replacement";
  if (
    !request ||
    typeof request !== "object" ||
    Array.isArray(request) ||
    Object.keys(request).length !== (isSiwc ? ((migrating || replacing) && !request.resume ? 5 : 3) : 2) + (request.resume === undefined ? 0 : 1) ||
    !Object.hasOwn(request, "plan") ||
    !Object.hasOwn(request, "confirmed") ||
    (isSiwc && !Object.hasOwn(request, "registration")) ||
    (!request.resume && migrating && (!isSiwc || replacing || request.migrationConsent !== true ||
      !Object.hasOwn(request, "legacyBinding"))) ||
    (!request.resume && replacing && (!isSiwc || request.replacementConsent !== true ||
      !Object.hasOwn(request, "existingBinding")))
  ) {
    throw new TypeError("The local endpoint install request is invalid.");
  }
  const { plan, confirmed, registration, legacyBinding, existingBinding, resume } = request;
  if (confirmed !== true) {
    throw new Error("Confirm the reviewed local endpoint plan before installing.");
  }
  assertSupportedPlatform(platform);
  rejectDockerEnvironmentOverrides(env);

  const normalizedPlan = createLocalDeploymentPlan({
    target: plan?.target,
    port: plan?.port,
    authBinding: plan?.authBinding,
  });
  const binding = isSiwc ? validateSiwcAuthBinding(normalizedPlan.authBinding) : null;
  if (isSiwc) {
    if (registration?.registrationId !== binding.registrationId || !registration.storageRoot) {
      throw new Error("The selected SIWC account does not match the reviewed endpoint.");
    }
    if (!resume) await validateReviewedCodexAccount(registration, binding);
  }
  const installRoot = await resolveLocalInstallRoot({
    target: normalizedPlan.target,
    env,
    homeDirectory,
    fileSystem,
    platform,
  });
  const releaseLock = await acquireLocalProjectLock(
    { installRoot, target: normalizedPlan.target },
    { fileSystem, processId, isProcessAlive, getProcessIdentity, platform },
  );
  let preservedResult;
  return settleLocalProjectOperation({
    completionLabel: "Local endpoint installation",
    releaseLock,
    operation: async () => {
  try {
  const relmioHome = resolve(installRoot, "..", "..");
  const staged = isSiwc ? await readLocalSiwcStaging({ fileSystem, installRoot, platform, lockDownPath }) : null;
  if (staged && staged.checkpoint.stage !== "completed" && !resume) {
    throw new Error("Review the interrupted SIWC installation before resuming.");
  }
  if (resume) {
    const reviewed = await reviewLocalSiwcResume({ target: normalizedPlan.target, registration },
      { fileSystem, env, homeDirectory, runProcess, platform, lockDownPath });
    if (JSON.stringify(reviewed) !== JSON.stringify(resume) ||
        JSON.stringify(reviewed.plan) !== JSON.stringify(normalizedPlan)) {
      throw new Error("The reviewed SIWC resume binding changed.");
    }
    const source = await readRegistration(registration);
    if (source?.handoff?.state === "handoff-pending") throw new Error("Reconcile the frozen handoff before resuming.");
    if (source?.handoff?.state !== "transferred") await validateReviewedCodexAccount(registration, binding);
    else if (source.handoff.receipt.binding.target.runtimeId !== staged.checkpoint.installId ||
             source.handoff.receipt.binding.target.hostId !== staged.checkpoint.ownerHostId) {
      throw new Error("The completed handoff belongs to another destination.");
    }
  }
  const managed = await inspectManagedRoot({
    fileSystem,
    relmioHome,
    installRoot,
    target: normalizedPlan.target,
    staging: staged?.checkpoint,
  });
  let reviewedLegacy = resume ? staged.checkpoint.reviewedLegacy ?? null : null;
  const retiring = migrating || replacing;
  if (retiring && !(resume && staged.checkpoint.oldStopped)) {
    const expectedSchema = replacing
      ? CODEX_SIWC_MARKER_SCHEMA_VERSION : MARKER_SCHEMA_VERSION;
    if (managed.marker?.schemaVersion !== expectedSchema) {
      throw new Error("The reviewed Codex installation is no longer available.");
    }
    const inspect = replacing
      ? reviewLocalCodexSiwcReplacement : reviewLocalCodexLegacyMigration;
    reviewedLegacy = await inspect(
      { target: normalizedPlan.target },
      { fileSystem, env, homeDirectory, runProcess, platform, lockDownPath },
    );
    const expected = resume ? staged.checkpoint.reviewedLegacy : replacing ? existingBinding : legacyBinding;
    for (const field of [
      "target", "installId", "projectName", "dockerHost", "port",
      "containerId", "imageId", "networkId", "running",
      ...(replacing ? ["registrationId", "ownerHostId"] : []),
    ]) {
      if (expected?.[field] !== reviewedLegacy[field]) {
        throw new Error("The reviewed old Codex installation changed. Review replacement again.");
      }
    }
    if (JSON.stringify(expected?.volumeNames) !==
        JSON.stringify(reviewedLegacy.volumeNames) ||
        (replacing && reviewedLegacy.registrationId === binding.registrationId)) {
      throw new Error("The reviewed old account or protected volumes changed.");
    }
  } else if (isSiwc && managed.marker && !resume) {
    throw new Error("The existing Codex installation needs a separately reviewed replacement or legacy migration.");
  }
  if (
    normalizedPlan.target === "xai-grok-build" && managed.marker &&
    typeof managed.marker.tokenSha256 !== "string"
  ) {
    throw new Error(
      "This legacy Grok installation requires a separately reviewed migration to a fresh OAuth session. Its files, containers, and saved session have not been changed.",
    );
  }
  const dockerHost = managed.marker?.dockerHost ??
    (await resolveLocalDockerHost({
      runProcess,
      cwd: dirname(relmioHome),
      env,
      platform,
    }));
  const installIdBytes = isSiwc || !managed.marker ? randomBytes(32) : null;
  if (
    installIdBytes !== null &&
    (!Buffer.isBuffer(installIdBytes) || installIdBytes.length !== 32)
  ) {
    throw new Error("Relmio could not generate a strong installation identity.");
  }
  const installId = resume ? staged.checkpoint.installId : isSiwc
    ? installIdBytes.subarray(0, 16).toString("hex")
    : managed.marker?.installId ?? installIdBytes.subarray(0, 16).toString("hex");
  validateInstallId(installId);
  if (retiring && installId === reviewedLegacy.installId) {
    throw new Error("The fresh SIWC installation identity collided with the old Codex project.");
  }
  const projectName = createProjectName(normalizedPlan.target, installId);
  await attestDockerOwnership({
    target: normalizedPlan.target,
    installRoot: managed.marker ? installRoot : dirname(relmioHome),
    dockerHost, installId, projectName, runProcess,
  });
  if (managed.previousPort !== normalizedPlan.port &&
      !(await isPortAvailable(normalizedPlan.port))) {
    throw new Error("The selected local endpoint port is already in use.");
  }
  const capabilityBytes = randomBytes(32);
  if (!Buffer.isBuffer(capabilityBytes) || capabilityBytes.length !== 32) {
    throw new Error("Relmio could not generate a strong local capability.");
  }
  const clientCredential = capabilityBytes.toString("base64url");
  const tokenSha256 = createHash("sha256").update(clientCredential).digest("hex");
  if (resume && (await readRegistration(registration))?.handoff?.state === "transferred") {
    const account = (await runSiwcCommand({ target: normalizedPlan.target, installRoot, dockerHost,
      projectName, command: "account", runProcess })).account;
    if (account?.registrationId !== binding.registrationId || account?.ownerHostId !== staged.checkpoint.ownerHostId ||
        account?.ownerRuntimeId !== installId || account?.ownership !== "owned") {
      throw new Error("The resumed destination account changed.");
    }
    preservedResult = { target: normalizedPlan.target, endpoint: normalizedPlan.endpoint,
      protocol: normalizedPlan.protocol, clientCredential, credentialShownOnce: true,
      models: [], account, runtimeState: "unknown", readiness: "unverified",
      experimental: normalizedPlan.experimental, browserClients: normalizedPlan.browserClients };
  }
  const checkpoint = resume ? staged.checkpoint : {
    schemaVersion: 1, target: normalizedPlan.target, installId, projectName, dockerHost,
    registrationId: binding?.registrationId, plan: normalizedPlan, stage: "staged",
    ...(retiring ? { reviewedLegacy, migration: replacing ? "replacement" : "legacy",
      ...(replacing ? { previousGeneration: existingBinding.expectedGeneration } : {}) } : {}),
  };
  if (resume) {
    if (checkpoint.registrationId !== binding.registrationId) {
      await assertNoLocalSiwcOneOffContainers({ runProcess, installRoot, dockerHost, projectName });
    }
    checkpoint.registrationId = binding.registrationId;
    checkpoint.plan = normalizedPlan;
    checkpoint.notAccepted = false;
  }
  const saveStage = async stage => {
    if (!isSiwc) return;
    checkpoint.stage = stage;
    const path = localSiwcStagingPath(installRoot);
    await writeManagedFile(fileSystem, path, `${JSON.stringify(checkpoint)}\n`, 0o600);
    if (platform === "win32") await lockDownPath(path, { platform, kind: "file" });
  };
  if (isSiwc) await saveStage(checkpoint.stage);
  let legacyArchive = retiring ? join(installRoot, "legacy", reviewedLegacy.installId) : null;
  if (retiring && !(resume && checkpoint.oldStopped)) {
    await validateReviewedCodexAccount(registration, binding);
    const inspect = replacing
      ? reviewLocalCodexSiwcReplacement : reviewLocalCodexLegacyMigration;
    const freshPrevious = await inspect(
      { target: normalizedPlan.target },
      { fileSystem, env, homeDirectory, runProcess, platform, lockDownPath },
    );
    for (const field of [
      "target", "installId", "projectName", "dockerHost", "port",
      "containerId", "imageId", "networkId", "running",
      ...(replacing ? ["registrationId", "ownerHostId"] : []),
    ]) {
      if (freshPrevious[field] !== reviewedLegacy[field]) {
        throw new Error("The old Codex service changed before replacement. Review again.");
      }
    }
    if (JSON.stringify(freshPrevious.volumeNames) !==
        JSON.stringify(reviewedLegacy.volumeNames)) {
      throw new Error("The old Codex volumes changed before replacement.");
    }
    if (replacing) {
      const old = (await runSiwcCommand({
        target: normalizedPlan.target, installRoot,
        dockerHost: reviewedLegacy.dockerHost,
        projectName: reviewedLegacy.projectName,
        command: "account", runProcess,
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
      throw new Error("A prior Codex replacement is incomplete. Inspect the retained project before retrying.");
    }
    await ensurePrivateDirectory(fileSystem, legacyRoot, platform, lockDownPath);
    await ensurePrivateDirectory(fileSystem, legacyArchive, platform, lockDownPath);
    const retain = async (filename, bytes) => {
      const path = join(legacyArchive, filename);
      await writeManagedFile(fileSystem, path, bytes, 0o600);
      if (platform === "win32") await lockDownPath(path, { platform, kind: "file" });
    };
    for (const filename of [
      MANAGED_MARKER, COMPOSE_FILENAME, "Dockerfile", ".dockerignore",
      "config.toml", "requirements.toml",
      ...(migrating && normalizedPlan.target === "codex-chat" ? ["gateway.mjs"] : []),
      ...(replacing ? ["package.json", "package-lock.json"] : []),
    ]) {
      const oldPath = join(installRoot, filename);
      const metadata = await lstatIfExists(fileSystem, oldPath);
      if (!metadata?.isFile?.() || metadata.isSymbolicLink() ||
          metadata.size > 1024 * 1024 ||
          (platform !== "win32" && (metadata.mode & 0o077) !== 0)) {
        throw new Error("An old Codex managed file is missing or unsafe. The old service has not been resumed.");
      }
      if (platform === "win32") {
        await lockDownPath(oldPath, {
          platform, kind: "file", verifyOnly: true, verifyEffectiveOwnerOnly: true,
        });
      }
      await retain(filename, await fileSystem.readFile(oldPath));
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
        label: "Attested old Codex service drain", file: "docker",
        args: createComposeArgs(normalizedPlan.target, reviewedLegacy.projectName, [
          "stop", "--timeout", "30", PROJECTS[normalizedPlan.target].serviceName,
        ]),
        cwd: installRoot, dockerHost: reviewedLegacy.dockerHost,
      });
    }
    const stoppedPrevious = await inspect(
      { target: normalizedPlan.target },
      { fileSystem, env, homeDirectory, runProcess, platform, lockDownPath },
    );
    for (const field of [
      "target", "installId", "projectName", "dockerHost", "port",
      "containerId", "imageId", "networkId",
      ...(replacing ? ["registrationId", "ownerHostId"] : []),
    ]) {
      if (stoppedPrevious[field] !== reviewedLegacy[field]) {
        throw new Error("The old Codex service changed while stopping; it will not be resumed automatically.");
      }
    }
    if (stoppedPrevious.running ||
        JSON.stringify(stoppedPrevious.volumeNames) !==
          JSON.stringify(reviewedLegacy.volumeNames)) {
      throw new Error("The old refresh writer or protected volumes could not be proved stopped.");
    }
    if (replacing) {
      const old = (await runSiwcCommand({
        target: normalizedPlan.target, installRoot,
        dockerHost: reviewedLegacy.dockerHost,
        projectName: reviewedLegacy.projectName,
        command: "account", runProcess,
      })).account;
      if (old?.registrationId !== reviewedLegacy.registrationId ||
          old?.generation !== (resume ? checkpoint.previousGeneration : existingBinding.expectedGeneration) ||
          old?.session !== "signed-out" || old?.planEnabled !== false) {
        throw new Error("The old signed-out SIWC account changed. The retired service remains stopped.");
      }
    }
    await journal("stopped");
    checkpoint.oldStopped = true;
    await saveStage("staged");
  }
  await initializeManagedBase({
    fileSystem, relmioHome, baseExists: managed.baseExists, platform, lockDownPath,
  });
  await ensurePrivateDirectory(fileSystem, join(relmioHome, "local"), platform, lockDownPath);
  await ensurePrivateDirectory(fileSystem, installRoot, platform, lockDownPath);
  if (resume && (await readRegistration(registration))?.handoff?.state === "transferred") {
    await runOrThrow(runProcess, { label: "Resumed owned endpoint stop", file: "docker",
      args: createComposeArgs(normalizedPlan.target, projectName, ["stop", "--timeout", "30", PROJECTS[normalizedPlan.target].serviceName]),
      cwd: installRoot, dockerHost });
    const running = await runOrThrow(runProcess, createVerificationSpecs({
      target: normalizedPlan.target, installRoot, dockerHost, projectName }).running);
    if (running.stdout.trim() !== "") throw new Error("The resumed owner did not stop.");
  }

  let dockerfile;
  let composeFile;
  if (normalizedPlan.target === "xai-grok-build") {
    const [gatewaySource, chatSource, sessionSource] = await Promise.all([
      readGrokBuildSource(),
      readGrokBuildChatSource(),
      readGrokBuildSessionSource(),
    ]);
    validateGrokBuildPackagedSource(gatewaySource);
    validateGrokBuildPackagedSource(chatSource);
    validateGrokBuildPackagedSource(sessionSource);
    dockerfile = createGrokBuildDockerfile();
    composeFile = createGrokBuildComposeFile({
      port: normalizedPlan.port,
      tokenSha256,
      installId,
    });
    await writeManagedFile(fileSystem, join(installRoot, "gateway.js"), gatewaySource, 0o600);
    await writeManagedFile(fileSystem, join(installRoot, "chat.js"), chatSource, 0o600);
    await writeManagedFile(fileSystem, join(installRoot, "session.js"), sessionSource, 0o600);
  } else {
    const codexChat = normalizedPlan.target === "codex-chat";
    const options = {
      port: normalizedPlan.port, tokenSha256, installId,
      registrationId: binding.registrationId,
    };
    dockerfile = codexChat ? createCodexChatDockerfile() : createCodexDockerfile();
    composeFile = codexChat
      ? createCodexChatComposeFile(options)
      : createCodexComposeFile(options);
    const writeSiwcAsset = async (relative, contents) => {
      const path = join(installRoot, relative);
      await writeManagedFile(fileSystem, path, contents, 0o600);
      if (platform === "win32") await lockDownPath(path, { platform, kind: "file" });
    };
    for (const folder of ["services", "gateway", "infrastructure"]) {
      await ensurePrivateDirectory(fileSystem, join(installRoot, folder), platform, lockDownPath);
    }
    const assets = await collectAssets();
    await writeSiwcAsset("package.json", assets.packageJson);
    await writeSiwcAsset("package-lock.json", assets.packageLock);
    for (const asset of assets.files) {
      if (!SIWC_ASSET_PATHS.has(asset.path) || !Buffer.isBuffer(asset.contents)) {
        throw new Error("The packaged Codex SIWC assets are invalid.");
      }
      await writeSiwcAsset(asset.path, asset.contents);
    }
    await writeSiwcAsset("config.toml",
      codexChat ? createCodexChatConfig() : createCodexConfig());
    await writeSiwcAsset("requirements.toml",
      codexChat ? createCodexChatRequirements() : createCodexRequirements());
  }

  await writeManagedFile(
    fileSystem,
    join(installRoot, "Dockerfile"),
    dockerfile,
    0o600,
  );
  await writeManagedFile(
    fileSystem,
    join(installRoot, ".dockerignore"),
    createLocalDockerignore(normalizedPlan.target),
    0o600,
  );
  await writeManagedFile(
    fileSystem,
    join(installRoot, COMPOSE_FILENAME),
    composeFile,
    0o600,
  );
  if (isSiwc && platform === "win32") {
    for (const filename of ["Dockerfile", ".dockerignore", COMPOSE_FILENAME]) {
      await lockDownPath(join(installRoot, filename), { platform, kind: "file" });
    }
  }
  if (!isSiwc) {
    await writeManagedFile(
      fileSystem,
      join(installRoot, MANAGED_MARKER),
      `${JSON.stringify({
        schemaVersion: MARKER_SCHEMA_VERSION,
        target: normalizedPlan.target,
        port: normalizedPlan.port,
        dockerHost,
        installId,
        projectName,
        tokenSha256,
      })}\n`,
      0o600,
    );
  }

  let deploymentStarted = false;
  let models = [];
  let account;
  let catalogFailure;
  let destinationHostId;
  let handoffCommitted = resume && (await readRegistration(registration))?.handoff?.state === "transferred";
  let runtimeAttested = false;
  try {
    for (const spec of createDeploymentSpecs({
      target: normalizedPlan.target,
      installRoot,
      dockerHost,
      projectName,
    })) {
      if (isSiwc && spec.args.includes("up")) {
        const destination = await runSiwcCommand({
          target: normalizedPlan.target, installRoot, dockerHost,
          projectName, command: "host", runProcess,
        });
        validateSiwcHostId(destination?.hostId);
        if (destination.runtimeId !== installId ||
            destination.hostId === binding.ownerHostId) {
          throw new Error("The Codex SIWC destination host identity is invalid.");
        }
        destinationHostId = destination.hostId;
        const markerPath = join(installRoot, MANAGED_MARKER);
        await writeManagedFile(fileSystem, markerPath, `${JSON.stringify({
          schemaVersion: CODEX_SIWC_MARKER_SCHEMA_VERSION,
          target: normalizedPlan.target,
          port: normalizedPlan.port, dockerHost, installId, projectName,
          authBinding: binding, registrationId: binding.registrationId,
          clientId: binding.clientId, ownerHostId: destination.hostId,
          ...(retiring ? {
            legacyInstallId: reviewedLegacy.installId,
            ...(replacing ? { previousWasSiwc: true } : {}),
          } : {}),
        })}\n`, 0o600);
        if (platform === "win32") {
          await lockDownPath(markerPath, { platform, kind: "file" });
        }
        checkpoint.ownerHostId = destination.hostId;
        await saveStage("prepared");
        const identities = await attestDockerOwnership({
          target: normalizedPlan.target, installRoot, dockerHost,
          installId, projectName, runProcess,
          strictResourceIdentities: { network: true, volume: true },
        });
        if ((!handoffCommitted && identities.container !== 0) || identities.network !== 1 ||
            identities.volume !== PROJECTS[normalizedPlan.target].volumeNames.length) {
          throw new Error("The exact Codex SIWC destination resources are not ready.");
        }
        if (handoffCommitted) {
          account = (await runSiwcCommand({ target: normalizedPlan.target, installRoot, dockerHost,
            projectName, command: "account", runProcess })).account;
          if (account?.ownerHostId !== destination.hostId || account?.ownerRuntimeId !== installId ||
              account?.registrationId !== binding.registrationId || account?.ownership !== "owned") {
            throw new Error("The resumed SIWC destination account changed.");
          }
        } else {
        await validateReviewedCodexAccount(registration, binding);
        const { handoffId } = await prepareAuthHandoff(registration, {
          expectedGeneration: binding.generation,
          target: destination, backgroundConsent: false,
        });
        await saveStage("handoff-pending");
        const contents = await readAuthHandoff(registration, {
          handoffId, expectedGeneration: binding.generation,
        });
        let accepted;
        try {
          accepted = await runSiwcCommand({
            target: normalizedPlan.target, installRoot, dockerHost,
            projectName, registrationId: binding.registrationId, command: "accept", input: contents, runProcess,
          });
        } catch (error) {
          throw Object.assign(new Error("The Codex SIWC transfer outcome is unresolved. The source remains frozen; reconcile the destination before retrying."),
            { remoteOutcomeUnknown: true });
        }
        if (accepted?.handoffId !== handoffId ||
            accepted.account?.registrationId !== binding.registrationId ||
            accepted.account?.ownerHostId !== destination.hostId ||
            accepted.account?.ownerRuntimeId !== installId ||
            accepted.account?.ownership !== "owned") {
          throw new Error("The Codex SIWC receipt or destination account does not match. The source remains frozen.");
        }
        account = accepted.account;
        preservedResult = { target: normalizedPlan.target, endpoint: normalizedPlan.endpoint,
          protocol: normalizedPlan.protocol, clientCredential, credentialShownOnce: true,
          models: [], account, runtimeState: "stopped", readiness: "unverified",
          experimental: normalizedPlan.experimental, browserClients: normalizedPlan.browserClients };
        await finishAuthHandoff(registration, { handoffId, receipt: accepted.receipt });
        handoffCommitted = true;
        }
        await saveStage("transferred");
        deploymentStarted = true;
      } else if (spec.args.includes("up")) {
        deploymentStarted = true;
      }
      await runOrThrow(runProcess, spec);
    }
    const verification = createVerificationSpecs({
      target: normalizedPlan.target,
      installRoot,
      dockerHost,
      projectName,
    });
    const running = await runOrThrow(runProcess, verification.running);
    if (
      !running.stdout
        .split(/\s+/u)
        .includes(PROJECTS[normalizedPlan.target].serviceName)
    ) {
      throw new Error("The local endpoint did not reach the running state.");
    }
    const publication = await runOrThrow(runProcess, verification.publication);
    validatePublishedEndpoint(publication.stdout, {
      target: normalizedPlan.target,
      port: normalizedPlan.port,
    });
    runtimeAttested = true;
    if (preservedResult) preservedResult.runtimeState = "running";
    if (isSiwc) {
      try {
        await verifyHttpEndpoint({ plan: normalizedPlan, clientCredential, fetchImpl });
        if (normalizedPlan.target === "codex-chatgpt") {
          await verifyCodexCapability({
            port: normalizedPlan.port, clientCredential,
          });
          const catalog = (await runSiwcCommand({
            target: normalizedPlan.target, installRoot, dockerHost,
            projectName, command: "models", runProcess,
          })).models;
          if (!Array.isArray(catalog) ||
              !catalog.every(model => typeof model?.slug === "string" &&
                /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(model.slug))) {
            throw new Error("The selected account model catalog is invalid.");
          }
          models = catalog.map(model => model.slug);
        } else {
          models = await verifyCodexChatCatalog({
            port: normalizedPlan.port, clientCredential, fetchImpl,
          });
        }
      } catch (error) {
        catalogFailure = safeSiwcCatalogFailure(error);
      }
      let current;
      try {
        current = (await runSiwcCommand({
          target: normalizedPlan.target, installRoot, dockerHost,
          projectName, command: "account-live", runProcess,
        })).account;
      } catch {
        catalogFailure ??= safeSiwcCatalogFailure({
          code: "owner_status_unavailable", recovery: "retry-later",
        });
      }
      if (current) {
        if (current.registrationId !== binding.registrationId ||
            current.ownerHostId !== destinationHostId ||
            current.ownerRuntimeId !== installId ||
            current.ownership !== "owned") {
          throw new Error("The installed Codex SIWC account changed.");
        }
        account = current;
      }
    } else {
      models = await verifyHttpEndpoint({
        plan: normalizedPlan, clientCredential, fetchImpl,
      });
    }
    if (normalizedPlan.target === "xai-grok-build") {
      await verifyGrokBuildCli({
        installRoot,
        dockerHost,
        projectName,
        runProcess,
      });
    }
  } catch (error) {
    if (isSiwc) {
      if (!handoffCommitted) throw error;
      let stopped = false;
      try {
        await runOrThrow(runProcess, {
          label: "Unverified owned Codex endpoint stop", file: "docker",
          args: createComposeArgs(normalizedPlan.target, projectName, [
            "stop", "--timeout", "30", PROJECTS[normalizedPlan.target].serviceName,
          ]),
          cwd: installRoot, dockerHost,
        });
        const running = await runOrThrow(runProcess, createVerificationSpecs({
          target: normalizedPlan.target, installRoot, dockerHost, projectName,
        }).running);
        stopped = running.stdout.trim() === "";
      } catch {
        // A disconnected Docker operation leaves the owned runtime outcome unknown.
      }
      const failureResult = {
        target: normalizedPlan.target, endpoint: normalizedPlan.endpoint,
        protocol: normalizedPlan.protocol, clientCredential, credentialShownOnce: true,
        models: [], deploymentMode: "partial", account,
        experimental: normalizedPlan.experimental, browserClients: normalizedPlan.browserClients,
        readiness: "unverified", runtimeState: stopped ? "stopped" : "unknown",
      };
      if (runtimeAttested) return localSiwcFinalizationFailure(failureResult, "resolve-handoff");
      return {
        target: normalizedPlan.target, endpoint: normalizedPlan.endpoint,
        protocol: normalizedPlan.protocol, clientCredential,
        credentialShownOnce: true, models: [],
        deploymentMode: "partial", account,
        experimental: normalizedPlan.experimental,
        browserClients: normalizedPlan.browserClients,
        readiness: "unverified",
        runtimeState: stopped ? "stopped" : "unknown",
        runtimeFailure: stopped ? safeSiwcRuntimeFailure() : {
          error: "The owned endpoint may be running with an unverified binding. Inspect and stop it before use.",
          status: 503, recovery: "resolve-handoff",
        },
        finalizationFailure: {
          error: "Ownership transferred, but runtime verification failed. Save the one-time key and resolve recovery before use.",
          recovery: "resolve-handoff",
        },
        ...(migrating ? { migrationPending: true, legacyRetained: true } : {}),
        ...(replacing ? { replacementPending: true, oldHistoryRetained: true } : {}),
      };
    }
    if (deploymentStarted) {
      let cleanupConfirmed = false;
      try {
        await runOrThrow(
          runProcess,
          createCleanupSpec({
            target: normalizedPlan.target,
            installRoot,
            dockerHost,
            projectName,
          }),
        );
        const remaining = await runOrThrow(
          runProcess,
          createCleanupVerificationSpec({
            target: normalizedPlan.target,
            installRoot,
            dockerHost,
            projectName,
          }),
        );
        cleanupConfirmed = !remaining.stdout
          .split(/\s+/u)
          .includes(PROJECTS[normalizedPlan.target].serviceName);
      } catch {
        // The caller receives a stronger fail-closed error below.
      }
      if (!cleanupConfirmed) {
        throw new Error(
          "Relmio could not confirm that the failed local endpoint was stopped. Inspect the Relmio Docker project before retrying.",
        );
      }
    }
    throw error;
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
    if (handoffCommitted) return localSiwcFinalizationFailure({
      target: normalizedPlan.target, endpoint: normalizedPlan.endpoint,
      protocol: normalizedPlan.protocol, clientCredential, credentialShownOnce: true,
      models, account, runtimeState: "running", readiness: "unverified",
      experimental: normalizedPlan.experimental, browserClients: normalizedPlan.browserClients,
      ...(migrating ? { migrationPending: true, legacyRetained: true } : {}),
      ...(replacing ? { replacementPending: true, oldHistoryRetained: true } : {}),
    });
    throw new Error("Local installation finalization failed.");
  }

  return {
    target: normalizedPlan.target,
    endpoint: normalizedPlan.endpoint,
    protocol: normalizedPlan.protocol,
    clientCredential,
    credentialShownOnce: true,
    models,
    deploymentMode: migrating ? "migrated" : replacing ? "replaced" : managed.deploymentMode,
    experimental: normalizedPlan.experimental,
    browserClients: normalizedPlan.browserClients,
    ...(isSiwc ? {
      account,
      runtimeState: "running",
      readiness: catalogFailure ? "unverified" : "verified",
      ...(catalogFailure ? { catalogFailure } : {}),
    } : {}),
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

export async function inspectStoppedLocalSiwcInstallation(
  { target, registrationId, confirmed },
  {
    fileSystem = defaultFileSystem, env = process.env,
    homeDirectory = homedir(), runProcess = runLocalProcess,
    platform = process.platform, lockDownPath = lockDownLocalPath,
    processId = process.pid, isProcessAlive = defaultIsProcessAlive,
    getProcessIdentity, runSiwcCommand = runCodexSiwcCommand,
  } = {},
) {
  const safeTarget = validateLocalTarget(target);
  if (safeTarget === "xai-grok-build" || confirmed !== true) {
    throw new Error("Confirm inspection of the stopped Codex SIWC account.");
  }
  validateSiwcRegistrationId(registrationId);
  assertSupportedPlatform(platform);
  rejectDockerEnvironmentOverrides(env);
  const installRoot = await resolveLocalInstallRoot({
    target: safeTarget, env, homeDirectory, fileSystem, platform,
  });
  const releaseLock = await acquireLocalProjectLock(
    { installRoot, target: safeTarget },
    { fileSystem, processId, isProcessAlive, getProcessIdentity, platform },
  );
  return settleLocalProjectOperation({
    completionLabel: "Stopped Codex SIWC account inspection",
    releaseLock,
    operation: async () => {
      await verifyWindowsManagedLocalEndpointPathSecurity({
        fileSystem, installRoot, platform, lockDownPath,
      });
      const managed = await inspectManagedRoot({
        fileSystem, relmioHome: resolve(installRoot, "..", ".."),
        installRoot, target: safeTarget,
      });
      const marker = managed.marker;
      if (marker?.schemaVersion !== CODEX_SIWC_MARKER_SCHEMA_VERSION ||
          marker.registrationId !== registrationId) {
        throw new Error("The selected registration is not installed in this Codex endpoint.");
      }
      await assertInstalledCodexCompose({ fileSystem, installRoot, marker });
      const selectedDockerHost = await resolveLocalDockerHost({
        runProcess, cwd: installRoot, env, platform,
      });
      if (selectedDockerHost !== marker.dockerHost) {
        throw new Error("The selected Docker context changed.");
      }
      const ownership = await attestDockerOwnership({
        target: safeTarget, installRoot, dockerHost: marker.dockerHost,
        installId: marker.installId, projectName: marker.projectName,
        runProcess, strictResourceIdentities: true,
      });
      if (ownership.container !== 1 || ownership.network !== 1 ||
          ownership.volume !== PROJECTS[safeTarget].volumeNames.length) {
        throw new Error("The exact owned Codex endpoint is missing.");
      }
      const running = await runOrThrow(runProcess, createVerificationSpecs({
        target: safeTarget, installRoot, dockerHost: marker.dockerHost,
        projectName: marker.projectName,
      }).running);
      if (running.stdout.trim() !== "") {
        throw new Error("The Codex endpoint is running; use read-only status instead.");
      }
      const account = (await runSiwcCommand({
        target: safeTarget, installRoot, dockerHost: marker.dockerHost,
        projectName: marker.projectName, command: "account", runProcess,
      })).account;
      if (account?.registrationId !== registrationId ||
          account?.ownerHostId !== marker.ownerHostId ||
          account?.ownerRuntimeId !== marker.installId ||
          account?.ownership !== "owned") {
        throw new Error("The stopped Codex SIWC account could not be attested.");
      }
      return { account };
    },
  });
}

export async function manageLocalSiwcInstallation(
  { target, registrationId, action, expectedGeneration, confirmed },
  {
    fileSystem = defaultFileSystem, env = process.env,
    homeDirectory = homedir(), runProcess = runLocalProcess,
    platform = process.platform, lockDownPath = lockDownLocalPath,
    processId = process.pid, isProcessAlive = defaultIsProcessAlive,
    getProcessIdentity, runSiwcCommand = runCodexSiwcCommand,
  } = {},
) {
  const safeTarget = validateLocalTarget(target);
  if (safeTarget === "xai-grok-build" ||
      confirmed !== true ||
      !["sign-out", "disable-plan", "enable-plan"].includes(action)) {
    throw new Error("Confirm the selected installed Codex SIWC account operation.");
  }
  validateSiwcRegistrationId(registrationId);
  if (typeof expectedGeneration !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(expectedGeneration)) {
    throw new TypeError("The selected SIWC account generation is invalid.");
  }
  assertSupportedPlatform(platform);
  rejectDockerEnvironmentOverrides(env);
  const installRoot = await resolveLocalInstallRoot({
    target: safeTarget, env, homeDirectory, fileSystem, platform,
  });
  const releaseLock = await acquireLocalProjectLock(
    { installRoot, target: safeTarget },
    { fileSystem, processId, isProcessAlive, getProcessIdentity, platform },
  );
  return settleLocalProjectOperation({
    completionLabel: "Installed Codex SIWC account operation",
    releaseLock,
    operation: async () => {
      await verifyWindowsManagedLocalEndpointPathSecurity({
        fileSystem, installRoot, platform, lockDownPath,
      });
      const managed = await inspectManagedRoot({
        fileSystem, relmioHome: resolve(installRoot, "..", ".."),
        installRoot, target: safeTarget,
      });
      const marker = managed.marker;
      if (marker?.schemaVersion !== CODEX_SIWC_MARKER_SCHEMA_VERSION ||
          marker.registrationId !== registrationId) {
        throw new Error("The selected registration is not installed in this Codex endpoint.");
      }
      await assertInstalledCodexCompose({ fileSystem, installRoot, marker });
      const selectedDockerHost = await resolveLocalDockerHost({
        runProcess, cwd: installRoot, env, platform,
      });
      if (selectedDockerHost !== marker.dockerHost) {
        throw new Error("The selected Docker context changed.");
      }
      const ownership = await attestDockerOwnership({
        target: safeTarget, installRoot, dockerHost: marker.dockerHost,
        installId: marker.installId, projectName: marker.projectName,
        runProcess, strictResourceIdentities: true,
      });
      if (ownership.container !== 1 || ownership.network !== 1 ||
          ownership.volume !== PROJECTS[safeTarget].volumeNames.length) {
        throw new Error("The exact owned Codex endpoint is missing.");
      }
      const identitySpec = {
        label: "Owned Codex endpoint identity check", file: "docker",
        args: createComposeArgs(safeTarget, marker.projectName, [
          "ps", "--all", "-q", PROJECTS[safeTarget].serviceName,
        ]),
        cwd: installRoot, dockerHost: marker.dockerHost,
      };
      const containerId = (await runOrThrow(runProcess, identitySpec)).stdout.trim();
      if (!/^[a-f0-9]{64}$/u.test(containerId)) {
        throw new Error("The owned Codex endpoint identity is invalid.");
      }
      const before = (await runSiwcCommand({
        target: safeTarget, installRoot, dockerHost: marker.dockerHost,
        projectName: marker.projectName, command: "account", runProcess,
      })).account;
      if (before?.registrationId !== registrationId ||
          before?.ownerHostId !== marker.ownerHostId ||
          before?.ownerRuntimeId !== marker.installId ||
          before?.generation !== expectedGeneration ||
          before?.ownership !== "owned") {
        throw new Error("The installed SIWC account changed; review it again.");
      }
      if (action === "enable-plan" &&
          (before.planPermission !== "granted" || before.session !== "connected")) {
        throw new Error("This installed account needs a fresh authorized SIWC sign-in before plan use can resume.");
      }
      await runOrThrow(runProcess, {
        label: "Owned Codex endpoint stop", file: "docker",
        args: createComposeArgs(safeTarget, marker.projectName, [
          "stop", "--timeout", "30", PROJECTS[safeTarget].serviceName,
        ]),
        cwd: installRoot, dockerHost: marker.dockerHost,
      });
      const afterId = (await runOrThrow(runProcess, identitySpec)).stdout.trim();
      const running = await runOrThrow(runProcess, createVerificationSpecs({
        target: safeTarget, installRoot, dockerHost: marker.dockerHost,
        projectName: marker.projectName,
      }).running);
      if (afterId !== containerId || running.stdout.trim() !== "") {
        throw new Error("The owned Codex endpoint did not stop; account mutation was not attempted.");
      }
      const changed = await runSiwcCommand({
        target: safeTarget, installRoot, dockerHost: marker.dockerHost,
        projectName: marker.projectName, command: action,
        input: Buffer.from(JSON.stringify({ registrationId, expectedGeneration })),
        runProcess,
      });
      if (changed.account?.registrationId !== registrationId ||
          changed.account?.ownerHostId !== marker.ownerHostId ||
          changed.account?.ownerRuntimeId !== marker.installId ||
          changed.account?.ownership !== "owned") {
        throw new Error("The installed SIWC result could not be attested.");
      }
      if (action === "enable-plan") {
        if (changed.account.planEnabled !== true ||
            changed.account.planPermission !== "granted") {
          throw new Error("The installed SIWC grant could not be confirmed. The Codex endpoint remains stopped.");
        }
        try {
        await runOrThrow(runProcess, {
          label: "Owned Codex SIWC endpoint start", file: "docker",
          args: createComposeArgs(safeTarget, marker.projectName, [
            "up", "-d", "--wait", "--wait-timeout", "90",
            "--no-build", "--no-deps", PROJECTS[safeTarget].serviceName,
          ]),
          cwd: installRoot, dockerHost: marker.dockerHost,
        });
        const verification = createVerificationSpecs({
          target: safeTarget, installRoot, dockerHost: marker.dockerHost,
          projectName: marker.projectName,
        });
        const started = await runOrThrow(runProcess, verification.running);
        if (!started.stdout.split(/\s+/u).includes(PROJECTS[safeTarget].serviceName)) {
          throw new Error("The owned Codex endpoint did not reach the running state.");
        }
          const publication = await runOrThrow(runProcess, verification.publication);
          validatePublishedEndpoint(publication.stdout, {
            target: safeTarget, port: marker.port,
          });
        } catch {
          let stoppedAfterFailure = false;
          try {
            await runOrThrow(runProcess, {
              label: "Unverified enabled endpoint stop", file: "docker",
              args: createComposeArgs(safeTarget, marker.projectName, [
                "stop", "--timeout", "30", PROJECTS[safeTarget].serviceName,
              ]),
              cwd: installRoot, dockerHost: marker.dockerHost,
            });
            const afterId = (await runOrThrow(runProcess, identitySpec)).stdout.trim();
            const stopped = await runOrThrow(runProcess, createVerificationSpecs({
              target: safeTarget, installRoot, dockerHost: marker.dockerHost, projectName: marker.projectName }).running);
            stoppedAfterFailure = afterId === containerId && stopped.stdout.trim() === "";
          } catch { /* Preserve the unknown runtime outcome. */ }
          throw Object.assign(new Error(stoppedAfterFailure
            ? "The enabled endpoint failed verification and its stopped state was confirmed."
            : "The enabled endpoint outcome is unknown. Inspect and stop the owned service before use."),
          { runtimeStopped: stoppedAfterFailure, remoteOutcomeUnknown: !stoppedAfterFailure });
        }
      }
      return {
        account: changed.account, revocation: changed.revocation,
        runtimeStopped: action !== "enable-plan",
      };
    },
  });
}

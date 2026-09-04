import { createHash, randomBytes as createRandomBytes, randomUUID } from "node:crypto";
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
  createLocalDeploymentPlan,
  createLocalDockerignore,
  createOpenAiGatewayComposeFile,
  createOpenAiGatewayDockerfile,
  validateInstallId,
  validateLocalTarget,
  validatePlatformApiKey,
} from "../domain/local-endpoints.js";
import {
  runLocalProcess,
  lockDownLocalPath,
  validateLocalDockerHost,
} from "../infrastructure/local-process.js";
import { getLocalProcessIdentity } from "../infrastructure/process-identity.js";

const MANAGED_MARKER = ".managed-by-relmio.json";
const ROOT_MARKER = ".managed-by-relmio-root.json";
const MARKER_SCHEMA_VERSION = 2;
const ROOT_MARKER_SCHEMA_VERSION = 1;
const COMPOSE_FILENAME = "docker-compose.yml";
const INCOMPLETE_LOCK_STALE_MS = 30_000;
const PROJECTS = Object.freeze({
  "openai-api": Object.freeze({
    projectPrefix: "relmio-openai-api",
    serviceName: "gateway",
    containerPort: 10_531,
    volumeNames: Object.freeze(["openai-api-key"]),
  }),
  "codex-chatgpt": Object.freeze({
    projectPrefix: "relmio-codex-chatgpt",
    serviceName: "codex",
    containerPort: 4_500,
    volumeNames: Object.freeze(["codex-home", "codex-workspace"]),
  }),
  "codex-chat": Object.freeze({
    projectPrefix: "relmio-codex-chat",
    serviceName: "codex-chat",
    containerPort: 14_501,
    volumeNames: Object.freeze(["codex-home", "codex-workspace"]),
  }),
});
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

async function inspectManagedRoot({ fileSystem, relmioHome, installRoot, target }) {
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
    if (
      marker?.schemaVersion !== MARKER_SCHEMA_VERSION ||
      marker?.target !== target ||
      !Number.isInteger(marker?.port) ||
      marker?.projectName !== projectName
    ) {
      throw new TypeError();
    }
    return {
      baseExists: true,
      deploymentMode: "updated",
      marker: {
        schemaVersion: MARKER_SCHEMA_VERSION,
        target,
        port: marker.port,
        dockerHost,
        installId,
        projectName,
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
  { installRoot, target },
  {
    fileSystem = defaultFileSystem,
    processId = process.pid,
    isProcessAlive = defaultIsProcessAlive,
    getProcessIdentity,
    platform = process.platform,
  } = {},
) {
  const safeTarget = validateLocalTarget(target);
  const safeInstallRoot = validateInstallDirectory(installRoot, safeTarget);
  const lockPath = join(
    dirname(resolve(safeInstallRoot, "..", "..")),
    `.relmio-local-${safeTarget}.lock`,
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

  const pattern = target === "openai-api" || target === "codex-chat"
    ? /^([ \t]*RELMIO_GATEWAY_TOKEN_SHA256:[ \t]*)[a-f0-9]{64}([ \t]*)$/gmu
    : /^([ \t]*-[ \t]+--ws-token-sha256[ \t]*\n[ \t]*-[ \t]+)[a-f0-9]{64}([ \t]*)$/gmu;
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

export async function restartLocalCodex(
  { installDirectory, target = "codex-chatgpt" },
  dependencies = {},
) {
  const safeTarget = validateLocalTarget(target);
  if (safeTarget !== "codex-chatgpt" && safeTarget !== "codex-chat") {
    throw new TypeError("The Codex login target is invalid.");
  }
  const runProcess = dependencies.runProcess ?? runLocalProcess;
  const releaseLock = dependencies.changeLockHeld === true
    ? async () => {}
    : await acquireLocalProjectLock(
        { installRoot: installDirectory, target: safeTarget },
        dependencies,
      );
  return settleLocalProjectOperation({
    completionLabel: "Local Codex restart",
    releaseLock,
    operation: async () => {
  const attested = await attestLocalCodexInstallation(
    { installDirectory, target: safeTarget },
    dependencies,
  );

  await runOrThrow(runProcess, {
    label: "Codex credential reload",
    file: "docker",
    args: createComposeArgs(safeTarget, attested.projectName, [
      "restart",
      "--timeout",
      "10",
      PROJECTS[safeTarget].serviceName,
    ]),
    cwd: installDirectory,
    dockerHost: attested.dockerHost,
  });
  await runOrThrow(runProcess, {
    label: "Codex readiness wait",
    file: "docker",
    args: createComposeArgs(safeTarget, attested.projectName, [
      "up",
      "-d",
      "--wait",
      "--wait-timeout",
      "90",
      "--no-deps",
      PROJECTS[safeTarget].serviceName,
    ]),
    cwd: installDirectory,
    dockerHost: attested.dockerHost,
  });
  return { restarted: true };
    },
  });
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
  apiKey,
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
  if (target === "openai-api") {
    specs.push({
      label: "OpenAI Platform credential seed",
      file: "docker",
      args: createComposeArgs(target, projectName, [
        "run",
        "--rm",
        "--no-deps",
        "--no-build",
        "-T",
        "credential-seed",
      ]),
      cwd: installRoot,
      dockerHost,
      input: Buffer.from(validatePlatformApiKey(apiKey), "utf8"),
    });
  }
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
  const expectedIdentities = strictResourceIdentities
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

function localEndpointSnapshot(plan) {
  return {
    target: plan.target,
    endpoint: plan.endpoint,
    auth: { configured: true, disclosure: "rotate-only" },
    canRotateCredential: true,
  };
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
    const plan = createLocalDeploymentPlan({
      target: safeTarget,
      port: managed.marker.port,
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
    const snapshot = localEndpointSnapshot(plan);
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

function parseModelIds(value) {
  if (!Array.isArray(value?.data)) {
    throw new Error("The OpenAI Platform model response could not be verified.");
  }
  const models = value.data
    .map((entry) => entry?.id)
    .filter(
      (id) =>
        typeof id === "string" &&
        id.length > 0 &&
        id.length <= 128 &&
        /^[A-Za-z0-9_.:-]+$/u.test(id),
    );
  if (models.length === 0) {
    throw new Error("The OpenAI Platform model response could not be verified.");
  }
  return models;
}

async function verifyHttpEndpoint({ plan, clientCredential, fetchImpl }) {
  const healthPath = plan.target === "codex-chatgpt" ? "/readyz" : "/health";
  const httpEndpoint = `http://127.0.0.1:${plan.port}${healthPath}`;
  let health;
  try {
    health = await fetchImpl(httpEndpoint, {
      method: "GET",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new Error("The local endpoint did not answer its readiness check.");
  }
  if (!health.ok) {
    throw new Error("The local endpoint did not pass its readiness check.");
  }

  if (plan.target === "codex-chat" && clientCredential !== undefined) {
    let verification;
    try {
      verification = await fetchImpl(
        `http://127.0.0.1:${plan.port}/auth/verify`,
        {
          method: "GET",
          headers: { Authorization: `Bearer ${clientCredential}` },
          signal: AbortSignal.timeout(10_000),
        },
      );
    } catch {
      throw new Error(
        "The Codex Chat client credential could not be verified.",
      );
    }
    if (!verification.ok) {
      throw new Error(
        "The Codex Chat client credential could not be verified.",
      );
    }
  }

  if (plan.target !== "openai-api" || clientCredential === undefined) {
    return [];
  }

  let response;
  try {
    response = await fetchImpl(`http://127.0.0.1:${plan.port}/v1/models`, {
      method: "GET",
      headers: { Authorization: `Bearer ${clientCredential}` },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error("The OpenAI Platform credential could not be verified.");
  }
  if (!response.ok) {
    throw new Error("The OpenAI Platform credential could not be verified.");
  }
  try {
    return parseModelIds(await response.json());
  } catch (error) {
    if (error?.message?.includes("model response")) {
      throw error;
    }
    throw new Error("The OpenAI Platform model response could not be verified.");
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
  const plan = createLocalDeploymentPlan({ target: "codex-chatgpt", port });
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
      { host: "127.0.0.1", port: plan.port },
      () => {
        socket.write(
          [
            "GET / HTTP/1.1",
            `Host: 127.0.0.1:${plan.port}`,
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

async function defaultReadGatewaySource() {
  return defaultFileSystem.readFile(
    new URL("../gateway/openai.js", import.meta.url),
    "utf8",
  );
}

async function defaultReadCodexChatSource() {
  return defaultFileSystem.readFile(
    new URL("../gateway/codex-chat.js", import.meta.url),
    "utf8",
  );
}

async function attestManagedLocalEndpoint(
  { target, installDirectory, missingMessage, notRunningMessage },
  {
    fileSystem = defaultFileSystem,
    runProcess = runLocalProcess,
    platform = process.platform,
    lockDownPath = lockDownLocalPath,
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
  await attestDockerOwnership({
    target: safeTarget,
    installRoot: safeDirectory,
    dockerHost: managed.marker.dockerHost,
    installId: managed.marker.installId,
    projectName: managed.marker.projectName,
    runProcess,
  });
  const verification = createVerificationSpecs({
    target: safeTarget,
    installRoot: safeDirectory,
    dockerHost: managed.marker.dockerHost,
    projectName: managed.marker.projectName,
  });
  const running = await runOrThrow(runProcess, verification.running);
  if (!running.stdout.split(/\s+/u).includes(PROJECTS[safeTarget].serviceName)) {
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
    projectName: managed.marker.projectName,
  };
}

export async function attestLocalCodexInstallation(
  { installDirectory, target = "codex-chatgpt" },
  dependencies = {},
) {
  const safeTarget = validateLocalTarget(target);
  if (safeTarget !== "codex-chatgpt" && safeTarget !== "codex-chat") {
    throw new TypeError("The Codex login target is invalid.");
  }
  const attested = await attestManagedLocalEndpoint(
    {
      target: safeTarget,
      installDirectory,
      missingMessage: "Install the local Codex endpoint before signing in.",
      notRunningMessage: "The managed local Codex endpoint is not running.",
    },
    dependencies,
  );
  return {
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
  const { clientCredential, tokenSha256 } = createClientCredential(randomBytes);
  const plan = createLocalDeploymentPlan({
    target: safeTarget,
    port: attested.port,
    allowedOrigins: [],
  });
  return {
    target: plan.target,
    endpoint: plan.endpoint,
    protocol: plan.protocol,
    clientCredential,
    tokenSha256,
    credentialShownOnce: true,
    models: [],
    deploymentMode: "staged",
    experimental: plan.experimental,
    browserClients: plan.browserClients,
  };
}

export async function activateLocalClientCredentialRotation(
  { target, clientCredential, tokenSha256 },
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
    allowedOrigins: [],
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

export async function installLocalEndpoint(
  { plan, apiKey, confirmed },
  {
    fileSystem = defaultFileSystem,
    env = process.env,
    homeDirectory = homedir(),
    runProcess = runLocalProcess,
    randomBytes = createRandomBytes,
    isPortAvailable = isLoopbackPortAvailable,
    readGatewaySource = defaultReadGatewaySource,
    readCodexChatSource = defaultReadCodexChatSource,
    fetchImpl = fetch,
    verifyCodexCapability = verifyCodexWebSocketCapability,
    platform = process.platform,
    lockDownPath = lockDownLocalPath,
    processId = process.pid,
    isProcessAlive = defaultIsProcessAlive,
    getProcessIdentity,
  } = {},
) {
  if (confirmed !== true) {
    throw new Error("Confirm the reviewed local endpoint plan before installing.");
  }
  assertSupportedPlatform(platform);
  rejectDockerEnvironmentOverrides(env);

  const normalizedPlan = createLocalDeploymentPlan({
    target: plan?.target,
    port: plan?.port,
    allowedOrigins: plan?.allowedOrigins,
  });
  const safeApiKey =
    normalizedPlan.target === "openai-api"
      ? validatePlatformApiKey(apiKey)
      : null;
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
  return settleLocalProjectOperation({
    completionLabel: "Local endpoint installation",
    releaseLock,
    operation: async () => {
  const relmioHome = resolve(installRoot, "..", "..");
  const managed = await inspectManagedRoot({
    fileSystem,
    relmioHome,
    installRoot,
    target: normalizedPlan.target,
  });
  const dockerHost = managed.marker?.dockerHost ??
    (await resolveLocalDockerHost({
      runProcess,
      cwd: dirname(relmioHome),
      env,
      platform,
    }));
  const installIdBytes = managed.marker ? null : randomBytes(32);
  if (
    installIdBytes !== null &&
    (!Buffer.isBuffer(installIdBytes) || installIdBytes.length !== 32)
  ) {
    throw new Error("Relmio could not generate a strong installation identity.");
  }
  const installId = managed.marker?.installId ??
    installIdBytes.subarray(0, 16).toString("hex");
  validateInstallId(installId);
  const projectName = createProjectName(normalizedPlan.target, installId);
  await attestDockerOwnership({
    target: normalizedPlan.target,
    installRoot: managed.marker ? installRoot : dirname(relmioHome),
    dockerHost,
    installId,
    projectName,
    runProcess,
  });

  if (
    managed.previousPort !== normalizedPlan.port &&
    !(await isPortAvailable(normalizedPlan.port))
  ) {
    throw new Error("The selected local endpoint port is already in use.");
  }

  const capabilityBytes = randomBytes(32);
  if (!Buffer.isBuffer(capabilityBytes) || capabilityBytes.length !== 32) {
    throw new Error("Relmio could not generate a strong local capability.");
  }
  const clientCredential = capabilityBytes.toString("base64url");
  const tokenSha256 = createHash("sha256")
    .update(clientCredential)
    .digest("hex");

  await initializeManagedBase({
    fileSystem,
    relmioHome,
    baseExists: managed.baseExists,
    platform,
    lockDownPath,
  });
  await ensurePrivateDirectory(fileSystem, join(relmioHome, "local"), platform, lockDownPath);
  await ensurePrivateDirectory(fileSystem, installRoot, platform, lockDownPath);

  let dockerfile;
  let composeFile;
  if (normalizedPlan.target === "openai-api") {
    const gatewaySource = await readGatewaySource();
    if (
      typeof gatewaySource !== "string" ||
      gatewaySource.length === 0 ||
      gatewaySource.length > 512 * 1024
    ) {
      throw new Error("The packaged local gateway runtime is invalid.");
    }
    dockerfile = createOpenAiGatewayDockerfile();
    composeFile = createOpenAiGatewayComposeFile({
      port: normalizedPlan.port,
      tokenSha256,
      allowedOrigins: normalizedPlan.allowedOrigins,
      installId,
    });
    await writeManagedFile(
      fileSystem,
      join(installRoot, "gateway.mjs"),
      gatewaySource,
      0o600,
    );
  } else if (normalizedPlan.target === "codex-chat") {
    const gatewaySource = await readCodexChatSource();
    if (
      typeof gatewaySource !== "string" ||
      gatewaySource.length === 0 ||
      gatewaySource.length > 512 * 1024
    ) {
      throw new Error("The packaged Codex Chat runtime is invalid.");
    }
    dockerfile = createCodexChatDockerfile();
    composeFile = createCodexChatComposeFile({
      port: normalizedPlan.port,
      tokenSha256,
      installId,
    });
    await writeManagedFile(
      fileSystem,
      join(installRoot, "gateway.mjs"),
      gatewaySource,
      0o600,
    );
    await writeManagedFile(
      fileSystem,
      join(installRoot, "config.toml"),
      createCodexChatConfig(),
      0o600,
    );
    await writeManagedFile(
      fileSystem,
      join(installRoot, "requirements.toml"),
      createCodexChatRequirements(),
      0o600,
    );
  } else {
    dockerfile = createCodexDockerfile();
    composeFile = createCodexComposeFile({
      port: normalizedPlan.port,
      tokenSha256,
      installId,
    });
    await writeManagedFile(
      fileSystem,
      join(installRoot, "config.toml"),
      createCodexConfig(),
      0o600,
    );
    await writeManagedFile(
      fileSystem,
      join(installRoot, "requirements.toml"),
      createCodexRequirements(),
      0o600,
    );
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
    })}\n`,
    0o600,
  );

  let deploymentStarted = false;
  let models;
  try {
    for (const spec of createDeploymentSpecs({
      target: normalizedPlan.target,
      installRoot,
      dockerHost,
      projectName,
      apiKey: safeApiKey,
    })) {
      if (spec.args.includes("up")) {
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
    models = await verifyHttpEndpoint({
      plan: normalizedPlan,
      clientCredential,
      fetchImpl,
    });
    if (normalizedPlan.target === "codex-chatgpt") {
      await verifyCodexCapability({
        port: normalizedPlan.port,
        clientCredential,
      });
    }
  } catch (error) {
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

  return {
    target: normalizedPlan.target,
    endpoint: normalizedPlan.endpoint,
    protocol: normalizedPlan.protocol,
    clientCredential,
    credentialShownOnce: true,
    models,
    deploymentMode: managed.deploymentMode,
    experimental: normalizedPlan.experimental,
    browserClients: normalizedPlan.browserClients,
  };
    },
  });
}

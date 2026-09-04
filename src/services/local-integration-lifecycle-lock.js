import { randomUUID } from "node:crypto";
import { join } from "node:path";

import { lockDownLocalPath } from "../infrastructure/local-process.js";
import { getLocalProcessIdentity } from "../infrastructure/process-identity.js";

const OWNER_FILE = ".owner.json";
const RECLAIM_DIRECTORY = ".reclaim";
const SCHEMA_VERSION = 2;
const PUBLICATION_GRACE_MS = 30_000;
const MAX_RECLAIM_ATTEMPTS = 4;
const MAX_OWNER_BYTES = 4 * 1024;
const MAX_PROCESS_ID = 2_147_483_647;
const MAX_IDENTITY_BYTES = 512;

function failure(label, message) {
  return new Error(`Relmio ${message} ${label}.`);
}

async function lstatIfExists(fileSystem, path, label) {
  try {
    return await fileSystem.lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw failure(label, "could not inspect the");
  }
}

function assertPrivateDirectory(metadata, { label, platform }) {
  if (
    !metadata?.isDirectory?.() || metadata.isSymbolicLink() ||
    (platform !== "win32" && (
      !Number.isInteger(metadata.mode) || (metadata.mode & 0o077) !== 0
    ))
  ) {
    throw failure(label, "refuses an unsafe");
  }
}

function assertPrivateOwner(metadata, { label, platform }) {
  if (
    !metadata?.isFile?.() || metadata.isSymbolicLink() ||
    !Number.isInteger(metadata.size) || metadata.size < 0 ||
    metadata.size > MAX_OWNER_BYTES ||
    (platform !== "win32" && (
      !Number.isInteger(metadata.mode) || (metadata.mode & 0o077) !== 0
    ))
  ) {
    throw failure(label, "refuses an unsafe owner for the");
  }
}

function validPublication(value) {
  return (
    value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === 5 &&
    value.schemaVersion === SCHEMA_VERSION &&
    Number.isSafeInteger(value.pid) && value.pid > 0 && value.pid <= MAX_PROCESS_ID &&
    typeof value.processStartIdentity === "string" &&
    value.processStartIdentity.length > 0 &&
    Buffer.byteLength(value.processStartIdentity) <= MAX_IDENTITY_BYTES &&
    !/[\0\r\n]/u.test(value.processStartIdentity) &&
    typeof value.token === "string" &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu.test(value.token) &&
    Number.isSafeInteger(value.publishedAtMs) && value.publishedAtMs > 0
  );
}

function samePublication(left, right) {
  return validPublication(left) && validPublication(right) &&
    left.schemaVersion === right.schemaVersion &&
    left.pid === right.pid &&
    left.processStartIdentity === right.processStartIdentity &&
    left.token === right.token &&
    left.publishedAtMs === right.publishedAtMs;
}

function directoryFingerprint(metadata, label) {
  if (
    !Number.isInteger(metadata?.dev) || !Number.isInteger(metadata?.ino) ||
    !Number.isFinite(metadata?.birthtimeMs) || metadata.birthtimeMs < 0
  ) {
    throw failure(label, "could not inspect the");
  }
  return Object.freeze({
    dev: metadata.dev,
    ino: metadata.ino,
    birthtimeMs: metadata.birthtimeMs,
  });
}

function sameDirectoryFingerprint(left, right) {
  return left?.dev === right?.dev && left?.ino === right?.ino &&
    left?.birthtimeMs === right?.birthtimeMs;
}

function ownerFingerprint(metadata, raw) {
  return Object.freeze({
    raw,
    size: metadata.size,
    dev: metadata.dev,
    ino: metadata.ino,
    mtimeMs: metadata.mtimeMs,
    ctimeMs: metadata.ctimeMs,
  });
}

function sameOwnerFingerprint(left, right) {
  return left?.raw === right?.raw && left?.size === right?.size &&
    left?.dev === right?.dev && left?.ino === right?.ino &&
    left?.mtimeMs === right?.mtimeMs && left?.ctimeMs === right?.ctimeMs;
}

function timestamp(now, label) {
  const value = now();
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw failure(label, "could not inspect the");
  }
  return value;
}

function pastGrace(metadata, { now, graceMs, label }) {
  const publishedAt = metadata?.mtimeMs;
  const current = timestamp(now, label);
  if (!Number.isFinite(publishedAt) || publishedAt <= 0 || publishedAt > current) return false;
  return current - Math.floor(publishedAt) >= graceMs;
}

function validProcessIdentity(identity) {
  return (
    identity && typeof identity === "object" && !Array.isArray(identity) &&
    (identity.state === "dead" || identity.state === "ambiguous" || (
      identity.state === "active" &&
      typeof identity.startIdentity === "string" && identity.startIdentity.length > 0 &&
      Buffer.byteLength(identity.startIdentity) <= MAX_IDENTITY_BYTES &&
      !/[\0\r\n]/u.test(identity.startIdentity)
    ))
  );
}

async function inspectClaim({ fileSystem, lockPath, lockDownPath, platform, label }) {
  let lockMetadata = await lstatIfExists(fileSystem, lockPath, label);
  assertPrivateDirectory(lockMetadata, { label, platform });
  if (platform === "win32") {
    await lockDownPath(lockPath, { platform, verifyOnly: true });
    lockMetadata = await lstatIfExists(fileSystem, lockPath, label);
    assertPrivateDirectory(lockMetadata, { label, platform });
  }
  const claimDirectoryFingerprint = directoryFingerprint(lockMetadata, label);
  const ownerPath = join(lockPath, OWNER_FILE);
  let ownerMetadata = await lstatIfExists(fileSystem, ownerPath, label);
  if (!ownerMetadata) {
    return Object.freeze({
      kind: "incomplete",
      source: "missing",
      ownerPath,
      ageMetadata: lockMetadata,
      directoryFingerprint: claimDirectoryFingerprint,
    });
  }
  assertPrivateOwner(ownerMetadata, { label, platform });
  if (platform === "win32") {
    await lockDownPath(ownerPath, { platform, kind: "file", verifyOnly: true });
    ownerMetadata = await lstatIfExists(fileSystem, ownerPath, label);
    assertPrivateOwner(ownerMetadata, { label, platform });
  }
  let raw;
  try {
    raw = await fileSystem.readFile(ownerPath, "utf8");
  } catch {
    throw failure(label, "could not inspect the");
  }
  const ownerAfterRead = await lstatIfExists(fileSystem, ownerPath, label);
  assertPrivateOwner(ownerAfterRead, { label, platform });
  const fingerprint = ownerFingerprint(ownerMetadata, raw);
  if (!sameOwnerFingerprint(fingerprint, ownerFingerprint(ownerAfterRead, raw))) {
    throw failure(label, "could not inspect the");
  }
  try {
    const publication = JSON.parse(raw);
    if (validPublication(publication)) {
      return Object.freeze({
        kind: "published",
        publication: Object.freeze(publication),
        ownerPath,
        fingerprint,
        directoryFingerprint: claimDirectoryFingerprint,
      });
    }
  } catch { /* A malformed in-progress write gets only the bounded grace. */ }
  return Object.freeze({
    kind: "incomplete",
    source: "malformed",
    ownerPath,
    fingerprint,
    ageMetadata: ownerAfterRead,
    directoryFingerprint: claimDirectoryFingerprint,
  });
}

async function claimState(claim, { getProcessIdentity, now, graceMs, label }) {
  if (claim.kind === "incomplete") {
    return pastGrace(claim.ageMetadata, { now, graceMs, label }) ? "stale" : "starting";
  }
  let identity;
  try {
    identity = await getProcessIdentity(claim.publication.pid);
  } catch {
    return "ambiguous";
  }
  if (!validProcessIdentity(identity) || identity.state === "ambiguous") return "ambiguous";
  if (identity.state === "dead") return "stale";
  return identity.startIdentity === claim.publication.processStartIdentity ? "active" : "stale";
}

async function detach({ fileSystem, lockPath, label }) {
  for (let attempt = 0; attempt < MAX_RECLAIM_ATTEMPTS; attempt += 1) {
    const quarantinePath = `${lockPath}.quarantine-${randomUUID()}`;
    if (await lstatIfExists(fileSystem, quarantinePath, label)) continue;
    try {
      await fileSystem.rename(lockPath, quarantinePath);
      return quarantinePath;
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      if (error?.code === "EEXIST" || error?.code === "ENOTEMPTY") continue;
      throw failure(label, "could not safely detach the");
    }
  }
  throw failure(label, "could not safely detach the");
}

function claimsMatch(before, after) {
  if (!sameDirectoryFingerprint(before.directoryFingerprint, after.directoryFingerprint)) return false;
  if (before.kind !== after.kind || before.source !== after.source) return false;
  if (before.kind === "published") return samePublication(before.publication, after.publication);
  if (before.source === "missing") return true;
  return sameOwnerFingerprint(before.fingerprint, after.fingerprint);
}

function staleClaimStillMatches(before, after, state) {
  if (!claimsMatch(before, after)) return false;
  // Adding the arbitration child changes the parent mtime. Once its missing
  // owner aged past the grace period, unchanged identity is sufficient proof.
  if (before.kind === "incomplete" && before.source === "missing") return true;
  return state === "stale";
}

async function removeDetached({ fileSystem, claim, quarantinePath, label }) {
  let entries;
  try {
    entries = (await fileSystem.readdir(quarantinePath)).sort();
  } catch {
    throw failure(label, "could not inspect the detached");
  }
  const expectedEntries = claim.source === "missing" ? [] : [OWNER_FILE];
  if (
    entries.length !== expectedEntries.length ||
    entries.some((entry, index) => entry !== expectedEntries[index])
  ) {
    throw failure(label, "refuses to remove a");
  }
  if (claim.source !== "missing") await fileSystem.unlink(join(quarantinePath, OWNER_FILE));
  await fileSystem.rmdir(quarantinePath);
}

async function restoreDetached({ fileSystem, lockPath, quarantinePath, label }) {
  try {
    if (await lstatIfExists(fileSystem, lockPath, label)) return false;
    await fileSystem.rename(quarantinePath, lockPath);
    return true;
  } catch {
    return false;
  }
}

async function createdClaimStillMatches({
  expectedDirectoryFingerprint,
  fileSystem,
  lockPath,
  ownerPublication,
  platform,
  requireReclaim = false,
  label,
}) {
  try {
    const metadata = await lstatIfExists(fileSystem, lockPath, label);
    assertPrivateDirectory(metadata, { label, platform });
    if (!sameDirectoryFingerprint(expectedDirectoryFingerprint, directoryFingerprint(metadata, label))) return false;
    const entries = (await fileSystem.readdir(lockPath)).sort();
    const hasReclaim = entries.includes(RECLAIM_DIRECTORY);
    if (hasReclaim !== requireReclaim) return false;
    const remaining = entries.filter((entry) => entry !== RECLAIM_DIRECTORY);
    if (remaining.length === 0) return true;
    if (remaining.length !== 1 || remaining[0] !== OWNER_FILE) return false;
    const ownerPath = join(lockPath, OWNER_FILE);
    const ownerMetadata = await lstatIfExists(fileSystem, ownerPath, label);
    if (
      !ownerMetadata?.isFile?.() || ownerMetadata.isSymbolicLink() ||
      !Number.isInteger(ownerMetadata.size) || ownerMetadata.size < 0 ||
      ownerMetadata.size > MAX_OWNER_BYTES
    ) return false;
    const raw = await fileSystem.readFile(ownerPath, "utf8");
    const ownerAfterRead = await lstatIfExists(fileSystem, ownerPath, label);
    if (!sameOwnerFingerprint(ownerFingerprint(ownerMetadata, raw), ownerFingerprint(ownerAfterRead, raw))) return false;
    return samePublication(JSON.parse(raw), ownerPublication);
  } catch {
    return false;
  }
}

async function safelyAbandonCreatedClaim({
  expectedDirectoryFingerprint,
  fileSystem,
  lockPath,
  ownerPublication,
  platform,
  label,
}) {
  if (!await createdClaimStillMatches({ expectedDirectoryFingerprint, fileSystem, lockPath, ownerPublication, platform, label })) return;
  const reclaimPath = join(lockPath, RECLAIM_DIRECTORY);
  try { await fileSystem.mkdir(reclaimPath, { mode: 0o700 }); } catch { return; }
  if (!await createdClaimStillMatches({
    expectedDirectoryFingerprint, fileSystem, lockPath, ownerPublication, platform, requireReclaim: true, label,
  })) {
    try { await fileSystem.rmdir(reclaimPath); } catch { /* Preserve changed contents. */ }
    return;
  }
  let quarantinePath;
  try { quarantinePath = await detach({ fileSystem, lockPath, label }); } catch { return; }
  if (!quarantinePath) return;
  try {
    if (!await createdClaimStillMatches({
      expectedDirectoryFingerprint, fileSystem, lockPath: quarantinePath, ownerPublication, platform, requireReclaim: true, label,
    })) return;
    await fileSystem.rmdir(join(quarantinePath, RECLAIM_DIRECTORY));
    if (await lstatIfExists(fileSystem, join(quarantinePath, OWNER_FILE), label)) {
      await fileSystem.unlink(join(quarantinePath, OWNER_FILE));
    }
    await fileSystem.rmdir(quarantinePath);
  } catch { /* Keep unexpected or replaced data safely quarantined. */ }
}

async function createDirectory({ fileSystem, lockPath, ownerPublication, platform, lockDownPath, label }) {
  await fileSystem.mkdir(lockPath, { mode: 0o700 });
  let expectedDirectoryFingerprint;
  try {
    expectedDirectoryFingerprint = directoryFingerprint(await fileSystem.lstat(lockPath), label);
    await fileSystem.chmod(lockPath, 0o700);
    await lockDownPath(lockPath, { platform });
    const ownerPath = join(lockPath, OWNER_FILE);
    await fileSystem.writeFile(ownerPath, `${JSON.stringify(ownerPublication)}\n`, { flag: "wx", mode: 0o600 });
    await fileSystem.chmod(ownerPath, 0o600);
    await lockDownPath(ownerPath, { platform, kind: "file" });
    const published = await inspectClaim({ fileSystem, lockPath, lockDownPath, platform, label });
    if (
      published.kind !== "published" ||
      !samePublication(published.publication, ownerPublication) ||
      !sameDirectoryFingerprint(published.directoryFingerprint, expectedDirectoryFingerprint)
    ) throw failure(label, "detected a changed publication for the");
    return published;
  } catch (error) {
    if (expectedDirectoryFingerprint) {
      await safelyAbandonCreatedClaim({
        expectedDirectoryFingerprint, fileSystem, lockPath, ownerPublication, platform, label,
      });
    }
    throw error;
  }
}

async function reclaimArbitration({
  fileSystem, getProcessIdentity, graceMs, lockPath, now, platform, lockDownPath, label,
}) {
  const initial = await inspectClaim({ fileSystem, lockPath, lockDownPath, platform, label });
  const initialState = await claimState(initial, { getProcessIdentity, now, graceMs, label });
  if (initialState !== "stale") return initialState;
  const quarantinePath = await detach({ fileSystem, lockPath, label });
  if (!quarantinePath) return "changed";
  try {
    const detached = await inspectClaim({ fileSystem, lockPath: quarantinePath, lockDownPath, platform, label });
    const state = await claimState(detached, { getProcessIdentity, now, graceMs, label });
    if (!claimsMatch(initial, detached) || state !== "stale") {
      await restoreDetached({ fileSystem, lockPath, quarantinePath, label });
      return "changed";
    }
    await removeDetached({ fileSystem, claim: detached, quarantinePath, label });
    return "reclaimed";
  } catch {
    await restoreDetached({ fileSystem, lockPath, quarantinePath, label });
    throw failure(label, "could not safely reclaim the arbitration");
  }
}

async function acquireArbitration({
  fileSystem, getProcessIdentity, graceMs, lockPath, now, platform, lockDownPath, selfIdentity, label,
}) {
  const reclaimPath = join(lockPath, RECLAIM_DIRECTORY);
  const ownerPublication = Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    pid: process.pid,
    processStartIdentity: selfIdentity.startIdentity,
    token: randomUUID(),
    publishedAtMs: timestamp(now, label),
  });
  for (let attempt = 0; attempt < MAX_RECLAIM_ATTEMPTS; attempt += 1) {
    try {
      await createDirectory({ fileSystem, lockPath: reclaimPath, ownerPublication, platform, lockDownPath, label });
      return Object.freeze({ state: "owned", ownerPublication, reclaimPath });
    } catch (error) {
      if (error?.code !== "EEXIST") throw failure(label, "could not publish an arbitration claim for the");
    }
    const state = await reclaimArbitration({
      fileSystem, getProcessIdentity, graceMs, lockPath: reclaimPath, now, platform, lockDownPath, label,
    });
    if (state === "reclaimed" || state === "changed") continue;
    return Object.freeze({ state });
  }
  return Object.freeze({ state: "active" });
}

async function release({ fileSystem, lockPath, ownerPublication, platform, lockDownPath, label }) {
  const initial = await inspectClaim({ fileSystem, lockPath, lockDownPath, platform, label });
  if (initial.kind !== "published" || !samePublication(initial.publication, ownerPublication)) {
    throw failure(label, "refuses to release a replaced");
  }
  if (await lstatIfExists(fileSystem, join(lockPath, RECLAIM_DIRECTORY), label)) {
    throw failure(label, "refuses to release a contended");
  }
  const quarantinePath = await detach({ fileSystem, lockPath, label });
  if (!quarantinePath) throw failure(label, "refuses to release a replaced");
  try {
    const detached = await inspectClaim({ fileSystem, lockPath: quarantinePath, lockDownPath, platform, label });
    if (
      detached.kind !== "published" ||
      !samePublication(detached.publication, ownerPublication) ||
      !claimsMatch(initial, detached) ||
      await lstatIfExists(fileSystem, join(quarantinePath, RECLAIM_DIRECTORY), label)
    ) throw failure(label, "refuses to release a replaced");
    await removeDetached({ fileSystem, claim: detached, quarantinePath, label });
  } catch (error) {
    await restoreDetached({ fileSystem, lockPath, quarantinePath, label });
    if (error?.message?.startsWith("Relmio refuses")) throw error;
    throw failure(label, "could not release the safely");
  }
}

async function reclaimStale({
  fileSystem, getProcessIdentity, graceMs, lockPath, now, platform, lockDownPath, selfIdentity, label,
}) {
  const initial = await inspectClaim({ fileSystem, lockPath, lockDownPath, platform, label });
  const initialState = await claimState(initial, { getProcessIdentity, now, graceMs, label });
  if (initialState !== "stale") return initialState;
  const arbitration = await acquireArbitration({
    fileSystem, getProcessIdentity, graceMs, lockPath, now, platform, lockDownPath, selfIdentity, label,
  });
  if (arbitration.state !== "owned") return arbitration.state;
  let quarantinePath = null;
  try {
    const current = await inspectClaim({ fileSystem, lockPath, lockDownPath, platform, label });
    const currentState = await claimState(current, { getProcessIdentity, now, graceMs, label });
    if (!staleClaimStillMatches(initial, current, currentState)) {
      throw failure(label, "refuses to reclaim a replaced");
    }
    const arbitrationClaim = await inspectClaim({
      fileSystem, lockPath: arbitration.reclaimPath, lockDownPath, platform, label,
    });
    if (
      arbitrationClaim.kind !== "published" ||
      !samePublication(arbitrationClaim.publication, arbitration.ownerPublication)
    ) throw failure(label, "refuses to reclaim without its exact arbitration claim for the");
    quarantinePath = await detach({ fileSystem, lockPath, label });
    if (!quarantinePath) return "changed";
    const detached = await inspectClaim({ fileSystem, lockPath: quarantinePath, lockDownPath, platform, label });
    const state = await claimState(detached, { getProcessIdentity, now, graceMs, label });
    if (!staleClaimStillMatches(initial, detached, state)) {
      throw failure(label, "refuses to reclaim a replaced");
    }
    await release({
      fileSystem,
      lockPath: join(quarantinePath, RECLAIM_DIRECTORY),
      ownerPublication: arbitration.ownerPublication,
      platform,
      lockDownPath,
      label,
    });
    await removeDetached({ fileSystem, claim: detached, quarantinePath, label });
    return "reclaimed";
  } catch (error) {
    if (quarantinePath) {
      await restoreDetached({ fileSystem, lockPath, quarantinePath, label });
    } else {
      try {
        await release({
          fileSystem,
          lockPath: arbitration.reclaimPath,
          ownerPublication: arbitration.ownerPublication,
          platform,
          lockDownPath,
          label,
        });
      } catch { /* A changed arbitration claim must remain preserved. */ }
    }
    if (error?.message?.startsWith("Relmio refuses")) throw error;
    throw failure(label, "could not safely reclaim the");
  }
}

/**
 * Acquire a crash-recoverable, filesystem-only lifecycle lock for one local
 * integration. Call the returned release function exactly once and surface a
 * release failure to the caller; hiding it can otherwise leave a safe lock
 * that looks like a broken installer on the next launch.
 */
export async function acquireLocalIntegrationLifecycleLock({
  fileSystem,
  getProcessIdentity = getLocalProcessIdentity,
  lockDownPath = lockDownLocalPath,
  lockPath,
  now = Date.now,
  platform = process.platform,
  label = "local integration operation lock",
}) {
  if (
    !fileSystem || typeof fileSystem.mkdir !== "function" ||
    typeof fileSystem.lstat !== "function" || typeof fileSystem.readFile !== "function" ||
    typeof fileSystem.writeFile !== "function" || typeof fileSystem.rename !== "function" ||
    typeof fileSystem.readdir !== "function" || typeof fileSystem.rmdir !== "function" ||
    typeof fileSystem.unlink !== "function" || typeof fileSystem.chmod !== "function" ||
    typeof getProcessIdentity !== "function" || typeof lockDownPath !== "function" ||
    typeof now !== "function" || typeof lockPath !== "string" || lockPath.length === 0 ||
    typeof platform !== "string" || platform.length === 0 ||
    typeof label !== "string" || label.length === 0
  ) {
    throw new TypeError("The local integration lifecycle lock adapter is invalid.");
  }
  const inspectProcessIdentity = (pid) => getProcessIdentity(pid, { platform });
  let selfIdentity;
  try { selfIdentity = await inspectProcessIdentity(process.pid); } catch { selfIdentity = null; }
  if (!validProcessIdentity(selfIdentity) || selfIdentity.state !== "active") {
    throw failure(label, "could not verify this process identity for the");
  }
  const ownerPublication = Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    pid: process.pid,
    processStartIdentity: selfIdentity.startIdentity,
    token: randomUUID(),
    publishedAtMs: timestamp(now, label),
  });
  for (let attempt = 0; attempt < MAX_RECLAIM_ATTEMPTS; attempt += 1) {
    try {
      await createDirectory({ fileSystem, lockPath, ownerPublication, platform, lockDownPath, label });
      return async () => release({ fileSystem, lockPath, ownerPublication, platform, lockDownPath, label });
    } catch (error) {
      if (error?.code !== "EEXIST") throw failure(label, "could not acquire the");
    }
    let state;
    try {
      state = await reclaimStale({
        fileSystem,
        getProcessIdentity: inspectProcessIdentity,
        graceMs: PUBLICATION_GRACE_MS,
        lockPath,
        now,
        platform,
        lockDownPath,
        selfIdentity,
        label,
      });
    } catch (error) {
      if (error?.message?.startsWith("Relmio refuses")) throw error;
      throw failure(label, "could not safely inspect the");
    }
    if (state === "reclaimed" || state === "changed") continue;
    if (state === "active" || state === "starting") {
      throw new Error(`Another Relmio process is changing ${label}.`);
    }
    throw failure(label, "could not verify the existing");
  }
  throw new Error(`Another Relmio process is changing ${label}.`);
}

export async function settleLocalIntegrationLifecycleOperation({
  completionLabel,
  operation,
  releaseLock,
}) {
  let result;
  let operationError;
  try { result = await operation(); } catch (error) { operationError = error; }
  let releaseError;
  try { await releaseLock(); } catch (error) { releaseError = error; }
  if (operationError) {
    if (releaseError && operationError.cause === undefined) {
      try { Object.defineProperty(operationError, "cause", { configurable: true, value: releaseError }); } catch { /* Preserve the action error. */ }
    }
    throw operationError;
  }
  if (releaseError) {
    throw Object.assign(new Error(
      `${completionLabel} completed, but Relmio could not release its operation lock. Restart Relmio before another local integration action.`,
      { cause: releaseError },
    ), { code: "LOCAL_INTEGRATION_LIFECYCLE_LOCK_RELEASE" });
  }
  return result;
}

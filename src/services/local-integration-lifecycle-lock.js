import { createHash, randomUUID } from "node:crypto";
import { basename, dirname, join, resolve } from "node:path";

import {
  lockDownLocalPath, recallWindowsLockdown, refreshWindowsLockdown, rememberWindowsLockdown, validateLocalDockerHost,
} from "../infrastructure/local-process.js";
import { getLocalProcessIdentity, getLocalPidNamespaceIdentity } from "../infrastructure/process-identity.js";

const OWNER_FILE = ".owner.json";
const RECLAIM_DIRECTORY = ".reclaim";
const SCHEMA_VERSION = 3;
const PUBLICATION_GRACE_MS = 30_000;
const MAX_RECLAIM_ATTEMPTS = 4;
const MAX_OWNER_BYTES = 4 * 1024;
const MAX_PROCESS_ID = 2_147_483_647;
const MAX_IDENTITY_BYTES = 512;
const failedAtomicReleases = new Map();
// A process's own start identity never changes, so each identity adapter is asked once per platform.
const verifiedSelfIdentities = new WeakMap();

function failure(label, message, code) {
  const error = new Error(`Relmio ${message} ${label}.`);
  if (code) error.code = code;
  return error;
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

function validNamespaceIdentity(value) {
  return typeof value === "string" && value.length > 0 &&
    Buffer.byteLength(value) <= MAX_IDENTITY_BYTES && !/[\0\r\n]/u.test(value);
}

function defaultLeaseNow() {
  return Number(process.hrtime.bigint() / 1_000_000n);
}

function validLeaseTime(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

function leaseTimestamp(leaseNow, label) {
  const value = leaseNow();
  if (!validLeaseTime(value)) throw failure(label, "could not inspect the lease clock for the");
  return value;
}

function namespaceBootIdentity(namespace) {
  return /^linux:([a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}):pid:[1-9][0-9]{0,19}$/iu
    .exec(namespace)?.[1].toLowerCase() ?? null;
}

function validPublication(value) {
  return (
    value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).length === (Object.hasOwn(value, "acquiredAt") ? 7 : 6) &&
    value.schemaVersion === SCHEMA_VERSION &&
    Number.isSafeInteger(value.pid) && value.pid > 0 && value.pid <= MAX_PROCESS_ID &&
    typeof value.processStartIdentity === "string" &&
    value.processStartIdentity.length > 0 &&
    Buffer.byteLength(value.processStartIdentity) <= MAX_IDENTITY_BYTES &&
    !/[\0\r\n]/u.test(value.processStartIdentity) &&
    validNamespaceIdentity(value.processNamespaceIdentity) &&
    (!Object.hasOwn(value, "acquiredAt") || validLeaseTime(value.acquiredAt)) &&
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
    left.processNamespaceIdentity === right.processNamespaceIdentity &&
    left.acquiredAt === right.acquiredAt &&
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

// Only a verified active identity is kept; a failed or ambiguous query is asked again next time.
async function currentProcessIdentity(getProcessIdentity, platform) {
  const cached = verifiedSelfIdentities.get(getProcessIdentity)?.get(platform);
  if (cached) return cached;
  let identity;
  try { identity = await getProcessIdentity(process.pid, { platform }); } catch { return null; }
  if (!validProcessIdentity(identity) || identity.state !== "active") return null;
  const verified = Object.freeze({ state: "active", startIdentity: identity.startIdentity });
  let byPlatform = verifiedSelfIdentities.get(getProcessIdentity);
  if (!byPlatform) {
    byPlatform = new Map();
    verifiedSelfIdentities.set(getProcessIdentity, byPlatform);
  }
  byPlatform.set(platform, verified);
  return verified;
}

async function inspectClaim({ fileSystem, lockPath, lockDownPath, platform, label }) {
  let lockMetadata = await lstatIfExists(fileSystem, lockPath, label);
  if (!lockMetadata) throw failure(label, "detected a changed", "RELMIO_LOCK_CHANGED");
  assertPrivateDirectory(lockMetadata, { label, platform });
  if (platform === "win32") {
    await lockDownPath(lockPath, { platform, verifyOnly: true });
    lockMetadata = await lstatIfExists(fileSystem, lockPath, label);
    if (!lockMetadata) throw failure(label, "detected a changed", "RELMIO_LOCK_CHANGED");
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
    if (!ownerMetadata) throw failure(label, "detected a changed owner for the", "RELMIO_LOCK_CHANGED");
    assertPrivateOwner(ownerMetadata, { label, platform });
  }
  let raw;
  try {
    raw = await fileSystem.readFile(ownerPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") throw failure(label, "detected a changed owner for the", "RELMIO_LOCK_CHANGED");
    throw failure(label, "could not inspect the");
  }
  const ownerAfterRead = await lstatIfExists(fileSystem, ownerPath, label);
  if (!ownerAfterRead) throw failure(label, "detected a changed owner for the", "RELMIO_LOCK_CHANGED");
  assertPrivateOwner(ownerAfterRead, { label, platform });
  const fingerprint = ownerFingerprint(ownerMetadata, raw);
  if (!sameOwnerFingerprint(fingerprint, ownerFingerprint(ownerAfterRead, raw))) {
    throw failure(label, "detected a changed owner for the", "RELMIO_LOCK_CHANGED");
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
  } catch { /* Preserve a claim without attested namespace ownership. */ }
  return Object.freeze({
    kind: "ambiguous",
    source: "malformed",
    ownerPath,
    fingerprint,
    directoryFingerprint: claimDirectoryFingerprint,
  });
}

// Only deadline-fenced callers may opt into reclaiming an ambiguous lease.
function leaseClaimState(claim, { processNamespaceIdentity, leaseMs, leaseNow }) {
  if (leaseMs === null) return "ambiguous";
  const ownerBoot = namespaceBootIdentity(claim.publication.processNamespaceIdentity);
  const currentBoot = namespaceBootIdentity(processNamespaceIdentity);
  if (!ownerBoot || !currentBoot) return "ambiguous";
  if (ownerBoot !== currentBoot) return "stale";
  if (!validLeaseTime(claim.publication.acquiredAt)) return "ambiguous";
  let current;
  try { current = leaseNow(); } catch { return "ambiguous"; }
  if (!validLeaseTime(current) || current < claim.publication.acquiredAt) return "ambiguous";
  return current - claim.publication.acquiredAt > leaseMs ? "stale" : "active";
}

async function claimState(claim, { getProcessIdentity, processNamespaceIdentity, leaseMs, leaseNow, now, graceMs, label }) {
  if (claim.kind === "ambiguous") return "ambiguous";
  if (claim.kind === "incomplete") {
    return pastGrace(claim.ageMetadata, { now, graceMs, label }) ? "stale" : "starting";
  }
  if (!validNamespaceIdentity(processNamespaceIdentity)) return "ambiguous";
  if (claim.publication.processNamespaceIdentity !== processNamespaceIdentity) {
    return leaseClaimState(claim, { processNamespaceIdentity, leaseMs, leaseNow });
  }
  let identity;
  try { identity = await getProcessIdentity(claim.publication.pid); }
  catch { return leaseClaimState(claim, { processNamespaceIdentity, leaseMs, leaseNow }); }
  if (!validProcessIdentity(identity) || identity.state === "ambiguous") {
    return leaseClaimState(claim, { processNamespaceIdentity, leaseMs, leaseNow });
  }
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
  fileSystem, getProcessIdentity, processNamespaceIdentity, leaseMs, leaseNow, graceMs, lockPath, now, platform, lockDownPath, label,
}) {
  const initial = await inspectClaim({ fileSystem, lockPath, lockDownPath, platform, label });
  const initialState = await claimState(initial, { getProcessIdentity, processNamespaceIdentity, leaseMs, leaseNow, now, graceMs, label });
  if (initialState !== "stale") return initialState;
  const quarantinePath = await detach({ fileSystem, lockPath, label });
  if (!quarantinePath) return "changed";
  try {
    const detached = await inspectClaim({ fileSystem, lockPath: quarantinePath, lockDownPath, platform, label });
    const state = await claimState(detached, { getProcessIdentity, processNamespaceIdentity, leaseMs, leaseNow, now, graceMs, label });
    if (!claimsMatch(initial, detached) || state !== "stale") {
      await restoreDetached({ fileSystem, lockPath, quarantinePath, label });
      return "changed";
    }
    await removeDetached({ fileSystem, claim: detached, quarantinePath, label });
    return "reclaimed";
  } catch (error) {
    await restoreDetached({ fileSystem, lockPath, quarantinePath, label });
    if (error?.code === "RELMIO_LOCK_CHANGED") throw error;
    throw failure(label, "could not safely reclaim the arbitration");
  }
}

async function acquireArbitration({
  fileSystem, getProcessIdentity, processNamespaceIdentity, leaseMs, leaseNow, graceMs, lockPath, now, platform, lockDownPath, selfIdentity, label,
}) {
  const reclaimPath = join(lockPath, RECLAIM_DIRECTORY);
  const ownerPublication = Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    pid: process.pid,
    processStartIdentity: selfIdentity.startIdentity,
    processNamespaceIdentity,
    acquiredAt: leaseTimestamp(leaseNow, label),
    token: randomUUID(),
    publishedAtMs: timestamp(now, label),
  });
  for (let attempt = 0; attempt < MAX_RECLAIM_ATTEMPTS; attempt += 1) {
    try {
      await createDirectory({ fileSystem, lockPath: reclaimPath, ownerPublication, platform, lockDownPath, label });
      return Object.freeze({ state: "owned", ownerPublication, reclaimPath });
    } catch (error) {
      if (error?.code === "RELMIO_LOCK_CHANGED") throw error;
      if (error?.code !== "EEXIST") throw failure(label, "could not publish an arbitration claim for the");
    }
    const state = await reclaimArbitration({
      fileSystem, getProcessIdentity, processNamespaceIdentity, leaseMs, leaseNow, graceMs, lockPath: reclaimPath, now, platform, lockDownPath, label,
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
  fileSystem, getProcessIdentity, processNamespaceIdentity, leaseMs, leaseNow, graceMs, lockPath, now, platform, lockDownPath, selfIdentity, label,
}) {
  const initial = await inspectClaim({ fileSystem, lockPath, lockDownPath, platform, label });
  const initialState = await claimState(initial, { getProcessIdentity, processNamespaceIdentity, leaseMs, leaseNow, now, graceMs, label });
  if (initialState !== "stale") return initialState;
  const arbitration = await acquireArbitration({
    fileSystem, getProcessIdentity, processNamespaceIdentity, leaseMs, leaseNow, graceMs, lockPath, now, platform, lockDownPath, selfIdentity, label,
  });
  if (arbitration.state !== "owned") return arbitration.state;
  let quarantinePath = null;
  try {
    const current = await inspectClaim({ fileSystem, lockPath, lockDownPath, platform, label });
    const currentState = await claimState(current, { getProcessIdentity, processNamespaceIdentity, leaseMs, leaseNow, now, graceMs, label });
    if (!staleClaimStillMatches(initial, current, currentState)) {
      throw failure(label, "detected a changed", "RELMIO_LOCK_CHANGED");
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
    const state = await claimState(detached, { getProcessIdentity, processNamespaceIdentity, leaseMs, leaseNow, now, graceMs, label });
    if (!staleClaimStillMatches(initial, detached, state)) {
      throw failure(label, "detected a changed", "RELMIO_LOCK_CHANGED");
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
    if (error?.code === "RELMIO_LOCK_CHANGED") throw error;
    throw failure(label, "could not safely reclaim the");
  }
}

// `identityOnly` is only for deciding whether to unlink this process's own name for
// an inode that must still equal a claim verified moments earlier; deleting it needs no ACL trust.
async function inspectAtomicClaim({ fileSystem, lockPath, lockDownPath, platform, label, identityOnly = false }) {
  const metadata = await lstatIfExists(fileSystem, lockPath, label);
  if (!metadata) return null;
  assertPrivateOwner(metadata, { label, platform });
  if (![1, 2].includes(metadata.nlink)) throw failure(label, "refuses an unsafe owner for the");
  if (platform !== "win32" && metadata.uid !== process.getuid()) {
    throw failure(label, "refuses an unsafe owner for the");
  }
  let raw;
  try { raw = await fileSystem.readFile(lockPath, "utf8"); }
  catch (error) {
    if (error?.code === "ENOENT") throw failure(label, "detected a changed", "RELMIO_LOCK_CHANGED");
    throw failure(label, "could not inspect the");
  }
  const after = await lstatIfExists(fileSystem, lockPath, label);
  if (!after) throw failure(label, "detected a changed", "RELMIO_LOCK_CHANGED");
  assertPrivateOwner(after, { label, platform });
  const fingerprint = ownerFingerprint(metadata, raw);
  if (!sameOwnerFingerprint(fingerprint, ownerFingerprint(after, raw))) {
    throw failure(label, "detected a changed", "RELMIO_LOCK_CHANGED");
  }
  // Each Windows ACL check spawns PowerShell. Only an unchanged inode this process
  // locked down itself skips it; foreign or changed inodes are always verified.
  if (platform === "win32" && !identityOnly && !recallWindowsLockdown(lockDownPath, metadata, raw)) {
    await lockDownPath(lockPath, { platform, kind: "file", verifyOnly: true, verifyEffectiveOwnerOnly: true });
    const verified = await lstatIfExists(fileSystem, lockPath, label);
    if (!verified) throw failure(label, "detected a changed", "RELMIO_LOCK_CHANGED");
    assertPrivateOwner(verified, { label, platform });
    if (!sameOwnerFingerprint(fingerprint, ownerFingerprint(verified, raw))) {
      throw failure(label, "detected a changed", "RELMIO_LOCK_CHANGED");
    }
    refreshWindowsLockdown(lockDownPath, metadata, raw);
  }
  let publication;
  try { publication = JSON.parse(raw); } catch { /* Preserve malformed claims. */ }
  return { kind: validPublication(publication) ? "published" : "ambiguous", publication, fingerprint };
}

function sameAtomicClaim(left, right) {
  return left?.kind === "published" && right?.kind === "published" &&
    left.fingerprint.dev === right.fingerprint.dev && left.fingerprint.ino === right.fingerprint.ino &&
    left.fingerprint.raw === right.fingerprint.raw && samePublication(left.publication, right.publication);
}

// Windows cannot fsync a directory handle (Node reports EPERM), so publication
// there relies on NTFS metadata journaling; exclusive link publication still applies.
async function syncAtomicParent({ fileSystem, lockPath, platform, label }) {
  if (platform === "win32") return;
  let handle;
  try {
    handle = await fileSystem.open(dirname(lockPath), "r");
    await handle.sync();
  } catch { throw failure(label, "could not durably publish the", "RELMIO_LOCK_UNAVAILABLE"); }
  finally { if (handle) await handle.close(); }
}

async function publishAtomicClaim({ fileSystem, lockPath, ownerPublication, lockDownPath, platform, label }) {
  const temporaryPath = `${lockPath}.publication-${randomUUID()}`;
  const raw = `${JSON.stringify(ownerPublication)}\n`;
  let handle;
  let metadata;
  let linked = false;
  try {
    handle = await fileSystem.open(temporaryPath, "wx", 0o600);
    await handle.writeFile(raw, "utf8");
    await handle.chmod(0o600);
    await lockDownPath(temporaryPath, { platform, kind: "file" });
    await handle.sync();
    metadata = await handle.stat();
    assertPrivateOwner(metadata, { label, platform });
    if (platform === "win32") rememberWindowsLockdown(lockDownPath, metadata, raw);
    await handle.close();
    handle = null;
    // link is exclusive for files, directories and symlinks, unlike POSIX rename.
    await fileSystem.link(temporaryPath, lockPath);
    linked = true;
    const temporary = await inspectAtomicClaim({ fileSystem, lockPath: temporaryPath, lockDownPath, platform, label,
      identityOnly: true });
    if (temporary?.fingerprint.dev !== metadata.dev || temporary?.fingerprint.ino !== metadata.ino ||
        temporary?.fingerprint.raw !== raw) {
      throw failure(label, "detected a changed publication for the", "RELMIO_LOCK_CHANGED");
    }
    await fileSystem.unlink(temporaryPath);
    await syncAtomicParent({ fileSystem, lockPath, platform, label });
    const published = await inspectAtomicClaim({ fileSystem, lockPath, lockDownPath, platform, label });
    if (published?.fingerprint.dev !== metadata.dev || published?.fingerprint.ino !== metadata.ino ||
        !samePublication(published?.publication, ownerPublication)) {
      throw failure(label, "detected a changed publication for the", "RELMIO_LOCK_CHANGED");
    }
    return published;
  } catch (error) {
    if (error?.code === "EEXIST") throw error;
    if (error?.code === "RELMIO_LOCK_CHANGED") throw error;
    if (linked && metadata) {
      const published = await inspectAtomicClaim({ fileSystem, lockPath, lockDownPath, platform, label }).catch(() => null);
      if (published?.fingerprint.dev === metadata.dev && published?.fingerprint.ino === metadata.ino &&
          samePublication(published?.publication, ownerPublication)) {
        await removeAtomicClaim({ fileSystem, lockPath, expected: published, lockDownPath, platform, label }).catch(() => {});
      }
    }
    // Unpublished crash leftovers are ignored; no other invocation deletes them.
    throw failure(label, "could not atomically publish the", "RELMIO_LOCK_UNAVAILABLE");
  } finally { if (handle) await handle.close(); }
}

async function removeAtomicClaim({ fileSystem, lockPath, expected, lockDownPath, platform, label }) {
  const current = await inspectAtomicClaim({ fileSystem, lockPath, lockDownPath, platform, label });
  if (!sameAtomicClaim(current, expected)) throw failure(label, "detected a changed", "RELMIO_LOCK_CHANGED");
  const detachedPath = `${lockPath}.released-${randomUUID()}`;
  await fileSystem.rename(lockPath, detachedPath);
  const detached = await inspectAtomicClaim({ fileSystem, lockPath: detachedPath, lockDownPath, platform, label,
    identityOnly: true });
  if (!sameAtomicClaim(detached, expected)) {
    try {
      await fileSystem.link(detachedPath, lockPath);
      await fileSystem.unlink(detachedPath);
      await syncAtomicParent({ fileSystem, lockPath, platform, label });
    } catch { /* Never replace a successor record when restoring a changed claim. */ }
    throw failure(label, "detected a changed", "RELMIO_LOCK_CHANGED");
  }
  await fileSystem.unlink(detachedPath);
  await syncAtomicParent({ fileSystem, lockPath, platform, label });
}

function ownFailedAtomicRelease(context, claim, path = context.lockPath) {
  const failed = failedAtomicReleases.get(path);
  if (!failed) return null;
  if (!claim) {
    failed.onRecovered?.();
    failedAtomicReleases.delete(path);
    return null;
  }
  if (!sameAtomicClaim(failed.claim, claim)) {
    failedAtomicReleases.delete(path);
    return null;
  }
  return claim.publication.pid === process.pid &&
    claim.publication.processStartIdentity === context.ownerPublication.processStartIdentity &&
    claim.publication.processNamespaceIdentity === context.processNamespaceIdentity ? failed : null;
}

function completeFailedAtomicRelease(path, failed) {
  if (!failed || failedAtomicReleases.get(path) !== failed) return;
  failed.onRecovered?.();
  failedAtomicReleases.delete(path);
}

async function releaseAtomicGuard(context, guard) {
  try {
    await removeAtomicClaim({ ...context, lockPath: guard.guardPath, expected: guard.claim });
  } catch (error) {
    failedAtomicReleases.set(guard.guardPath, { claim: guard.claim });
    throw error;
  }
}

async function acquireAtomicGuard(context) {
  const { fileSystem, lockPath, ownerPublication, lockDownPath, platform, label, leaseNow, now } = context;
  const guardPath = `${lockPath}.publication-lock`;
  for (let attempt = 0; attempt < MAX_RECLAIM_ATTEMPTS; attempt += 1) {
    const existing = await inspectAtomicClaim({ fileSystem, lockPath: guardPath, lockDownPath, platform, label });
    if (existing) {
      const failed = ownFailedAtomicRelease(context, existing, guardPath);
      const state = failed ? "stale" : await claimState(existing, context);
      if (state === "active") throw failure(label, "found contention for the", "RELMIO_LOCK_BUSY");
      if (state !== "stale") throw failure(label, "could not verify the publication guard for the");
      await removeAtomicClaim({ fileSystem, lockPath: guardPath, expected: existing, lockDownPath, platform, label });
      completeFailedAtomicRelease(guardPath, failed);
    }
    try {
      const publication = { ...ownerPublication, token: randomUUID(),
        acquiredAt: leaseTimestamp(leaseNow, label), publishedAtMs: timestamp(now, label) };
      const claim = await publishAtomicClaim({ fileSystem, lockPath: guardPath, ownerPublication: publication,
        lockDownPath, platform, label });
      return { claim, guardPath };
    } catch (error) { if (error?.code !== "EEXIST") throw error; }
  }
  throw failure(label, "found contention for the", "RELMIO_LOCK_BUSY");
}

async function assertAtomicGuard(context, guard) {
  const { fileSystem, lockDownPath, platform, label, leaseMs, leaseNow } = context;
  const current = await inspectAtomicClaim({ fileSystem, lockPath: guard.guardPath, lockDownPath, platform, label });
  if (!sameAtomicClaim(current, guard.claim)) throw failure(label, "detected a changed publication guard for the", "RELMIO_LOCK_CHANGED");
  if (leaseMs !== null) {
    const age = leaseTimestamp(leaseNow, label) - guard.claim.publication.acquiredAt;
    if (age < 0 || age > leaseMs) throw failure(label, "could not use an expired publication guard for the", "RELMIO_LOCK_UNAVAILABLE");
  }
}

async function acquireAtomicLifecycleLock(context) {
  const { fileSystem, lockPath, ownerPublication, lockDownPath, platform, label, leaseMs, leaseNow, releaseWaitMs } = context;
  const existing = await inspectAtomicClaim(context);
  const failed = ownFailedAtomicRelease(context, existing);
  if (existing) {
    const state = failed ? "stale" : await claimState(existing, context);
    if (state === "active") throw failure(label, "found contention for the", "RELMIO_LOCK_BUSY");
    if (state !== "stale") throw failure(label, "could not verify the existing");
  }
  const guard = await acquireAtomicGuard(context);
  let published;
  try {
    const current = await inspectAtomicClaim(context);
    if (current) {
      const failedCurrent = ownFailedAtomicRelease(context, current);
      const state = failedCurrent ? "stale" : await claimState(current, context);
      if (state === "active") throw failure(label, "found contention for the", "RELMIO_LOCK_BUSY");
      if (state !== "stale") throw failure(label, "could not verify the existing");
      await assertAtomicGuard(context, guard);
      await removeAtomicClaim({ fileSystem, lockPath, expected: current, lockDownPath, platform, label });
      completeFailedAtomicRelease(lockPath, failedCurrent);
    }
    await assertAtomicGuard(context, guard);
    if (leaseMs !== null && leaseTimestamp(leaseNow, label) - ownerPublication.acquiredAt > leaseMs) {
      throw failure(label, "could not publish an expired lease for the", "RELMIO_LOCK_UNAVAILABLE");
    }
    try { published = await publishAtomicClaim(context); }
    catch (error) {
      if (error?.code === "EEXIST") throw failure(label, "found contention for the", "RELMIO_LOCK_BUSY");
      throw error;
    }
  } finally {
    try { await releaseAtomicGuard(context, guard); }
    catch (error) {
      if (published) failedAtomicReleases.set(lockPath, { claim: published });
      throw error;
    }
  }
  let released = false;
  const releaseClaim = async () => {
    if (released) return;
    const deadline = defaultLeaseNow() + releaseWaitMs;
    let delay = 5;
    for (;;) {
      try {
        if (released) return;
        const current = await inspectAtomicClaim(context);
        if (!sameAtomicClaim(current, published)) throw failure(label, "refuses to release a replaced");
        const releaseGuard = await acquireAtomicGuard(context);
        try {
          if (!released) {
            await assertAtomicGuard(context, releaseGuard);
            const afterWait = await inspectAtomicClaim(context);
            if (!sameAtomicClaim(afterWait, published)) throw failure(label, "refuses to release a replaced");
            await removeAtomicClaim({ fileSystem, lockPath, expected: published, lockDownPath, platform, label });
            released = true;
            completeFailedAtomicRelease(lockPath, ownFailedAtomicRelease(context, published));
          }
        } finally { await releaseAtomicGuard(context, releaseGuard); }
        return;
      } catch (error) {
        const remaining = deadline - defaultLeaseNow();
        if (["RELMIO_LOCK_BUSY", "RELMIO_LOCK_CHANGED"].includes(error?.code) && remaining > 0) {
          await new Promise(resolve => setTimeout(resolve, Math.min(delay, remaining)));
          delay = Math.min(delay * 2, 50);
          continue;
        }
        if (!released) failedAtomicReleases.set(lockPath, {
          claim: published, onRecovered: () => { released = true; },
        });
        throw error;
      }
    }
  };
  Object.defineProperty(releaseClaim, "acquiredAt", { value: ownerPublication.acquiredAt });
  return releaseClaim;
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
  getPidNamespaceIdentity = getLocalPidNamespaceIdentity,
  lockDownPath = lockDownLocalPath,
  lockPath,
  now = Date.now,
  platform = process.platform,
  label = "local integration operation lock",
  reclaimIncomplete = true,
  leaseMs = null,
  leaseNow = defaultLeaseNow,
  atomicPublication = false,
  releaseWaitMs = leaseMs ?? PUBLICATION_GRACE_MS,
}) {
  if (
    !fileSystem || typeof fileSystem.mkdir !== "function" ||
    typeof fileSystem.lstat !== "function" || typeof fileSystem.readFile !== "function" ||
    typeof fileSystem.writeFile !== "function" || typeof fileSystem.rename !== "function" ||
    typeof fileSystem.readdir !== "function" || typeof fileSystem.rmdir !== "function" ||
    typeof fileSystem.unlink !== "function" || typeof fileSystem.chmod !== "function" ||
    typeof getProcessIdentity !== "function" || typeof getPidNamespaceIdentity !== "function" ||
    typeof lockDownPath !== "function" ||
    typeof now !== "function" || typeof lockPath !== "string" || lockPath.length === 0 ||
    typeof platform !== "string" || platform.length === 0 ||
    typeof label !== "string" || label.length === 0 || typeof reclaimIncomplete !== "boolean" ||
    typeof leaseNow !== "function" ||
    (leaseMs !== null && (!Number.isSafeInteger(leaseMs) || leaseMs <= 0)) ||
    typeof atomicPublication !== "boolean" ||
    !Number.isSafeInteger(releaseWaitMs) || releaseWaitMs <= 0 ||
    (atomicPublication && (typeof fileSystem.open !== "function" || typeof fileSystem.link !== "function"))
  ) {
    throw new TypeError("The local integration lifecycle lock adapter is invalid.");
  }
  const inspectProcessIdentity = (pid) => getProcessIdentity(pid, { platform });
  const selfIdentity = await currentProcessIdentity(getProcessIdentity, platform);
  if (!selfIdentity) {
    throw failure(label, "could not verify this process identity for the", "RELMIO_LOCK_IDENTITY_UNAVAILABLE");
  }
  let processNamespaceIdentity;
  try { processNamespaceIdentity = await getPidNamespaceIdentity({ platform }); } catch { processNamespaceIdentity = null; }
  if (!validNamespaceIdentity(processNamespaceIdentity)) {
    throw failure(label, "could not verify this process namespace for the");
  }
  const ownerPublication = Object.freeze({
    schemaVersion: SCHEMA_VERSION,
    pid: process.pid,
    processStartIdentity: selfIdentity.startIdentity,
    processNamespaceIdentity,
    acquiredAt: leaseTimestamp(leaseNow, label),
    token: randomUUID(),
    publishedAtMs: timestamp(now, label),
  });
  if (atomicPublication) {
    return acquireAtomicLifecycleLock({
      fileSystem, lockPath, ownerPublication, lockDownPath, platform, label, now, leaseMs, leaseNow, releaseWaitMs,
      getProcessIdentity: inspectProcessIdentity, processNamespaceIdentity,
    });
  }
  for (let attempt = 0; attempt < MAX_RECLAIM_ATTEMPTS; attempt += 1) {
    try {
      await createDirectory({ fileSystem, lockPath, ownerPublication, platform, lockDownPath, label });
      return async () => release({ fileSystem, lockPath, ownerPublication, platform, lockDownPath, label });
    } catch (error) {
      if (error?.code === "RELMIO_LOCK_CHANGED") throw error;
      if (error?.code !== "EEXIST") throw failure(label, "could not acquire the");
    }
    let state;
    try {
      state = await reclaimStale({
        fileSystem,
        getProcessIdentity: inspectProcessIdentity,
        processNamespaceIdentity,
        leaseMs, leaseNow,
        graceMs: reclaimIncomplete ? PUBLICATION_GRACE_MS : Infinity,
        lockPath,
        now,
        platform,
        lockDownPath,
        selfIdentity,
        label,
      });
    } catch (error) {
      if (error?.message?.startsWith("Relmio refuses")) throw error;
      if (error?.code === "RELMIO_LOCK_CHANGED") throw error;
      throw failure(label, "could not safely inspect the");
    }
    if (state === "reclaimed" || state === "changed") continue;
    if (state === "active" || state === "starting") {
      throw Object.assign(new Error(`Another Relmio process is changing ${label}.`), { code: "RELMIO_LOCK_BUSY" });
    }
    throw failure(label, "could not verify the existing");
  }
  throw Object.assign(new Error(`Another Relmio process is changing ${label}.`), { code: "RELMIO_LOCK_BUSY" });
}

export async function assertNoLocalSiwcOneOffContainers({ runProcess, installRoot, dockerHost, projectName }) {
  validateLocalDockerHost(dockerHost);
  if (!/^relmio-(?:codex-chat|codex-chatgpt|n8n-openai-oauth)-[a-f0-9]{32}$/u.test(projectName)) {
    throw new TypeError("The frozen SIWC project identity is invalid.");
  }
  try {
    const result = await runProcess({ file: "docker",
      args: ["ps", "--all", "--filter", `label=com.docker.compose.project=${projectName}`,
        "--filter", "label=com.docker.compose.oneoff=True", "--format", "{{json .}}"],
      cwd: installRoot, dockerHost });
    if (result.code !== 0 || typeof result.stdout !== "string" || result.stdout.trim() !== "") {
      throw new Error("An installed SIWC operation may still be running.");
    }
  } catch {
    throw Object.assign(new Error("The SIWC handoff may still be running. The sender remains frozen."),
      { remoteOutcomeUnknown: true });
  }
}

export async function readLocalSiwcResumeAuthBinding({
  checkpoint, registration, readReceipt, readRegistration, readPendingAuthHandoff,
}) {
  if (!registration) throw new Error("Select the SIWC account before reviewing resume.");
  const record = await readRegistration(registration);
  if (registration.registrationId === checkpoint.registrationId) {
    if (record?.handoff?.state === "transferred" || record?.handoff?.state === "handoff-pending") {
      return checkpoint.plan.authBinding;
    }
    const binding = checkpoint.plan.authBinding;
    if (record?.handoff?.state !== "owned" || record.registrationId !== binding.registrationId ||
        record.clientId !== binding.clientId || record.owner.hostId !== binding.ownerHostId ||
        record.owner.runtimeId !== binding.ownerRuntimeId) {
      throw new Error("The staged SIWC account identity changed.");
    }
    return { registrationId: record.registrationId, clientId: record.clientId,
      generation: record.generation, ownerHostId: record.owner.hostId, ownerRuntimeId: record.owner.runtimeId };
  }
  if (checkpoint.notAccepted !== true) throw new Error("Reconcile the original handoff before selecting a fresh sign-in.");
  const pending = await readPendingAuthHandoff({
    storageRoot: registration.storageRoot, registrationId: checkpoint.registrationId,
  });
  if (!pending || pending.target.runtimeId !== checkpoint.installId ||
      pending.target.hostId !== checkpoint.ownerHostId ||
      record?.handoff?.state !== "owned" || record.owner.hostId !== checkpoint.plan.authBinding.ownerHostId ||
      !record.planEnabled || !record.session?.refreshToken ||
      !record.session.scopes?.includes("chatgpt.tokens.use.direct")) {
    throw new Error("The fresh SIWC registration or original handoff changed.");
  }
  let result;
  try { result = await readReceipt(pending); }
  catch { throw Object.assign(new Error("The original destination receipt remains unresolved."), { remoteOutcomeUnknown: true }); }
  if (result?.receipt !== null) throw new Error("The original handoff was accepted; reconcile it before resuming.");
  return { registrationId: record.registrationId, clientId: record.clientId,
    generation: record.generation, ownerHostId: record.owner.hostId, ownerRuntimeId: record.owner.runtimeId };
}

export async function fingerprintLocalSiwcResources({ runProcess, installRoot, checkpoint }) {
  const { projectName, dockerHost, target, installId } = checkpoint;
  if (!/^[a-f0-9]{32}$/u.test(installId) || projectName !== `relmio-${target}-${installId}`) {
    throw new Error("The staged SIWC project identity is invalid.");
  }
  const resources = [];
  for (const resource of ["container", "volume", ...(target === "n8n-openai-oauth" ? [] : ["network"])]) {
    const result = await runProcess({
      file: "docker", args: [resource === "container" ? "ps" : resource,
        ...(resource === "container" ? ["--all"] : ["ls"]),
        "--filter", `label=com.docker.compose.project=${projectName}`, "--format", "{{json .}}"],
      cwd: dirname(resolve(installRoot, "..", "..")), dockerHost,
    });
    if (result.code !== 0 || typeof result.stdout !== "string" || result.stdout.length > 64 * 1024) {
      throw new Error("The staged SIWC resources could not be inspected.");
    }
    const rows = result.stdout.trim() ? result.stdout.trim().split("\n").map(row => JSON.parse(row)) : [];
    if (rows.length > 10) throw new Error("The staged SIWC resources are ambiguous.");
    for (const row of rows) {
      const identity = resource === "container" ? row.ID : row.Name;
      if (typeof identity !== "string" ||
          (resource === "container" ? !/^[a-f0-9]{12,64}$/u.test(identity) : !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,255}$/u.test(identity))) {
        throw new Error("The staged SIWC resource identity is invalid.");
      }
      const inspected = await runProcess({ file: "docker",
        args: [resource, "inspect", "--format", "{{json .}}", identity],
        cwd: dirname(resolve(installRoot, "..", "..")), dockerHost });
      if (inspected.code !== 0) throw new Error("The staged SIWC resource changed.");
      const value = JSON.parse(inspected.stdout);
      if (resource === "container"
        ? !/^[a-f0-9]{64}$/u.test(value.Id) || !/^sha256:[a-f0-9]{64}$/u.test(value.Image) || !Array.isArray(value.Mounts)
        : resource === "network"
          ? value.Name !== identity || !/^[a-f0-9]{64}$/u.test(value.Id)
          : value.Name !== identity || typeof value.CreatedAt !== "string" ||
            !Number.isFinite(Date.parse(value.CreatedAt)) || typeof value.Mountpoint !== "string") {
        throw new Error("The staged SIWC resource identity could not be attested.");
      }
      resources.push(resource === "container"
        ? [resource, value.Id, value.Image, value.Mounts, value.State?.Running]
        : [resource, value.Name, value.Id, value.CreatedAt, value.Driver, value.Mountpoint, value.Labels]);
    }
  }
  return createHash("sha256").update(JSON.stringify(resources.sort((a, b) =>
    JSON.stringify(a).localeCompare(JSON.stringify(b))))).digest("hex");
}

export function localSiwcStagingPath(installRoot) {
  const target = basename(installRoot);
  if (!["codex-chat", "codex-chatgpt", "n8n-openai-oauth"].includes(target) ||
      basename(dirname(installRoot)) !== "local" ||
      basename(resolve(installRoot, "..", "..")) !== ".relmio") {
    throw new TypeError("The SIWC staging target is invalid.");
  }
  return join(dirname(resolve(installRoot, "..", "..")), `.relmio-local-${target}.siwc-staging.json`);
}

export async function readLocalSiwcStaging({ fileSystem, installRoot, platform = process.platform, lockDownPath = lockDownLocalPath }) {
  const path = localSiwcStagingPath(installRoot);
  let metadata;
  try { metadata = await fileSystem.lstat(path); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 ||
      metadata.size > 32 * 1024 ||
      (platform !== "win32" && (metadata.uid !== process.getuid() || (metadata.mode & 0o077) !== 0))) {
    throw new Error("The SIWC staging checkpoint is unsafe.");
  }
  if (platform === "win32") {
    await lockDownPath(path, { platform, kind: "file", verifyOnly: true, verifyEffectiveOwnerOnly: true });
  }
  const raw = await fileSystem.readFile(path, "utf8");
  const checkpoint = JSON.parse(raw);
  if (checkpoint.schemaVersion !== 1 || checkpoint.target !== basename(installRoot) ||
      !/^[a-f0-9]{32}$/u.test(checkpoint.installId) ||
      checkpoint.registrationId !== checkpoint.plan?.authBinding?.registrationId ||
      !["staged", "retiring", "prepared", "handoff-pending", "transferred", "completed"].includes(checkpoint.stage)) {
    throw new Error("The SIWC staging checkpoint is invalid.");
  }
  return { checkpoint, checkpointSha256: createHash("sha256").update(raw).digest("hex") };
}

export async function fingerprintLocalSiwcFiles({ fileSystem, installRoot, platform = process.platform, lockDownPath = lockDownLocalPath }) {
  const hash = createHash("sha256");
  let count = 0;
  const visit = async (path, relative = "") => {
    let metadata;
    try { metadata = await fileSystem.lstat(path); }
    catch (error) { if (error.code === "ENOENT" && relative === "") return; throw error; }
    if (++count > 200 || metadata.isSymbolicLink() ||
        (!metadata.isDirectory() && !metadata.isFile()) ||
        (metadata.isFile() && (metadata.nlink !== 1 || metadata.size > 2 * 1024 * 1024)) ||
        (platform !== "win32" && (metadata.uid !== process.getuid() || (metadata.mode & 0o077) !== 0))) {
      throw new Error("The staged SIWC files are unsafe.");
    }
    if (platform === "win32") {
      await lockDownPath(path, { platform, kind: metadata.isFile() ? "file" : "directory",
        verifyOnly: true, verifyEffectiveOwnerOnly: true });
    }
    hash.update(JSON.stringify([relative, metadata.dev, metadata.ino, metadata.mode, metadata.uid]));
    if (metadata.isFile()) hash.update(await fileSystem.readFile(path));
    else for (const name of (await fileSystem.readdir(path)).sort()) {
      await visit(join(path, name), `${relative}/${name}`);
    }
  };
  for (const parent of [resolve(installRoot, "..", ".."), dirname(installRoot)]) {
    let metadata;
    try { metadata = await fileSystem.lstat(parent); }
    catch (error) { if (error.code === "ENOENT") continue; throw error; }
    if (!metadata.isDirectory() || metadata.isSymbolicLink() ||
        (platform !== "win32" && (metadata.uid !== process.getuid() || (metadata.mode & 0o077) !== 0))) {
      throw new Error("The staged SIWC parent directory is unsafe.");
    }
  }
  await visit(installRoot);
  return hash.digest("hex");
}

export function localSiwcFinalizationFailure(result, recovery = "review-again") {
  return {
    ...result, deploymentMode: "partial", readiness: "unverified",
    finalizationFailure: {
      error: "Ownership transferred, but installation finalization failed. Save the one-time key and review recovery before use.",
      recovery,
    },
  };
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
    if (result?.credentialShownOnce === true && typeof result.clientCredential === "string" &&
        result.account?.ownership === "owned") {
      return localSiwcFinalizationFailure(result);
    }
    throw Object.assign(new Error(
      `${completionLabel} completed, but Relmio could not release its operation lock. Restart Relmio before another local integration action.`,
      { cause: releaseError },
    ), { code: "LOCAL_INTEGRATION_LIFECYCLE_LOCK_RELEASE" });
  }
  return result;
}

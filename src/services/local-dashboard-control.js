import {
  createHash,
  randomBytes as createRandomBytes,
  randomUUID as createRandomUUID,
} from "node:crypto";
import { spawn } from "node:child_process";
import * as defaultFileSystem from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import packageManifest from "../../package.json" with { type: "json" };

import { lockDownLocalPath } from "../infrastructure/local-process.js";
import { isPrivateBrowserLaunchUrl } from "../browser.js";
import { getLocalProcessIdentity } from "../infrastructure/process-identity.js";
import { acquireLocalIntegrationLifecycleLock } from "./local-integration-lifecycle-lock.js";

const CONTROL_DIRECTORY = "control";
const PUBLICATION_FILE = "dashboard.json";
const CONTROL_KEY_FILE = "control.key";
const BROWSER_KEY_FILE = "browser.key";
const BROWSER_LAUNCH_DIRECTORY = "browser-launches";
const CONTROL_STATE_PREFIX = ".state-v1-";
const CONTROL_PUBLISHING_PREFIX = ".publishing-v1-";
const CONTROL_FINALIZING_PREFIX = ".finalizing-v1-";
const RETIRING_DIRECTORY = "retiring";
const RETIREMENT_PAYLOAD_FILE = "payload";
const ROOT_MARKER_FILE = ".managed-by-relmio-root.json";
const LOCK_DIRECTORY = "dashboard.lock";
const ROOT_MARKER_KEYS = Object.freeze(["kind", "schemaVersion"]);
const PUBLICATION_KEYS = Object.freeze([
  "instanceId",
  "kind",
  "origin",
  "packageVersion",
  "pid",
  "processStartIdentity",
  "protocolVersion",
  "publishedAtMs",
  "schemaVersion",
]);
const ROOT_MARKER = Object.freeze({ schemaVersion: 1, kind: "relmio-local-root" });
const PUBLICATION_SCHEMA_VERSION = 1;
const CONTROL_PROTOCOL_VERSION = 1;
const CONTROL_KIND = "relmio-dashboard-control";
const PACKAGE_VERSION_PATTERN =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*)|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:(?:0|[1-9]\d*)|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;
const CURRENT_PACKAGE_VERSION = packageManifest.version;
if (!PACKAGE_VERSION_PATTERN.test(CURRENT_PACKAGE_VERSION)) {
  throw new TypeError("The Relmio package version is invalid.");
}
const MAX_PUBLICATION_BYTES = 4 * 1024;
const MAX_MARKER_BYTES = 1024;
const MAX_PROCESS_ID = 2_147_483_647;
const MAX_IDENTITY_BYTES = 512;
const SESSION_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const CONTROL_TOKEN_PATTERN = /^[A-P][A-Za-z0-9_-]{42}$/u;
const BROWSER_TOKEN_PATTERN = /^[w-z0-9_-][A-Za-z0-9_-]{42}$/u;
const INSTANCE_ID_PATTERN = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/iu;
const CONTENT_DIGEST_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const CONTROL_STATE_PATTERN = /^\.state-v1-([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})-([A-Za-z0-9_-]{43})-([A-Za-z0-9_-]{43})-([A-Za-z0-9_-]{43})$/iu;
const CONTROL_PUBLISHING_PATTERN = /^\.publishing-v1-([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})-([A-Za-z0-9_-]{43})-([A-Za-z0-9_-]{43})-([A-Za-z0-9_-]{43})$/iu;
const CONTROL_FINALIZING_PATTERN = /^\.finalizing-v1-([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})-([A-Za-z0-9_-]{43})-([A-Za-z0-9_-]{43})-([A-Za-z0-9_-]{43})$/iu;
const RETIREMENT_SLOT_PATTERN = /^\.slot-v1-(root|publication|control|browser)-([0-9]+)-([0-9]+)-([0-9]+)-([A-Za-z0-9_-]{43})$/u;
const HEALTH_PATH = "/__relmio/control/status";
const STOP_PATH = "/__relmio/control/stop";
const BROWSER_PREPARE_PATH = "/__relmio/browser/prepare";
const DEFAULT_REQUEST_TIMEOUT_MS = 3_000;
const DEFAULT_STARTUP_TIMEOUT_MS = 10_000;
const PRIVATE_DAEMON_COMMAND = "__relmio-dashboard-daemon";
const DEFAULT_CLI_PATH = fileURLToPath(new URL("../cli.js", import.meta.url));
const DAEMON_ENVIRONMENT_NAMES = new Set([
  "PATH", "Path", "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH",
  "LOCALAPPDATA", "APPDATA", "TMPDIR", "TMP", "TEMP",
  "SystemRoot", "SYSTEMROOT", "WINDIR", "COMSPEC", "ComSpec", "PATHEXT",
  "LANG", "TZ", "RELMIO_HOME", "CODEX_HOME", "SSH_AUTH_SOCK",
  "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "DOCKER_TLS_VERIFY",
  "DOCKER_CERT_PATH", "BUILDKIT_HOST",
]);
const LOCALE_ENVIRONMENT_NAME = /^LC_(?:ALL|COLLATE|CTYPE|MESSAGES|MONETARY|NUMERIC|TIME)$/u;

function fail(message) {
  return new Error(`Relmio ${message}.`);
}

function isMissing(error) {
  return error?.code === "ENOENT";
}

function exactKeys(value, expected) {
  return value && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
}

function validateManagedHome(value) {
  if (
    typeof value !== "string" || value.trim() === "" || value.includes("\0") ||
    !isAbsolute(value)
  ) {
    throw new TypeError("Relmio local storage path is invalid.");
  }
  const normalized = resolve(value);
  if (basename(normalized) !== ".relmio") {
    throw new TypeError("Relmio local storage path is invalid.");
  }
  return normalized;
}

async function resolveControlPaths({ env, homeDirectory, fileSystem }) {
  if (!env || typeof env !== "object" || typeof homeDirectory !== "string") {
    throw new TypeError("The local dashboard control adapter is invalid.");
  }
  const usesCustomRoot = typeof env.RELMIO_HOME === "string" && env.RELMIO_HOME.trim() !== "";
  const requested = validateManagedHome(
    usesCustomRoot
      ? env.RELMIO_HOME
      : resolve(homeDirectory, ".relmio"),
  );
  let canonicalParent;
  try {
    canonicalParent = await fileSystem.realpath(dirname(requested));
  } catch {
    throw fail("could not verify the parent of its local storage directory");
  }
  if (canonicalParent !== resolve(dirname(requested))) {
    throw fail("refuses a local storage path with a symbolic-link ancestor");
  }
  const relmioHome = join(canonicalParent, ".relmio");
  const controlRoot = join(relmioHome, CONTROL_DIRECTORY);
  return Object.freeze({
    relmioHome,
    rootMarkerPath: join(relmioHome, ROOT_MARKER_FILE),
    controlRoot,
    publicationPath: join(controlRoot, PUBLICATION_FILE),
    controlKeyPath: join(controlRoot, CONTROL_KEY_FILE),
    browserKeyPath: join(controlRoot, BROWSER_KEY_FILE),
    browserLaunchRoot: join(relmioHome, BROWSER_LAUNCH_DIRECTORY),
    lockPath: join(relmioHome, `${CONTROL_DIRECTORY}.lock`),
    stagingRoot: join(relmioHome, `${CONTROL_DIRECTORY}.staging`),
    retiredRoot: join(relmioHome, `${CONTROL_DIRECTORY}.retired`),
    changedMarkerPath: join(relmioHome, `${CONTROL_DIRECTORY}.changed`),
    bootstrapRoot: join(canonicalParent, ".relmio.bootstrap"),
    bootstrapLockPath: join(canonicalParent, ".relmio.bootstrap.lock"),
    parentPath: canonicalParent,
    requirePrivateParentAcl: usesCustomRoot,
  });
}

async function lstatIfExists(fileSystem, path) {
  try {
    return await fileSystem.lstat(path);
  } catch (error) {
    if (isMissing(error)) return null;
    throw fail("could not inspect its local dashboard control state");
  }
}

function assertPrivateMetadata(metadata, { kind, platform, maxBytes, expectedUid }) {
  const expectedType = kind === "directory" ? metadata?.isDirectory?.() : metadata?.isFile?.();
  const expectedMode = kind === "directory" ? 0o700 : 0o600;
  if (
    !expectedType || metadata.isSymbolicLink?.() ||
    (kind === "file" && (
      !Number.isSafeInteger(metadata.size) || metadata.size < 0 || metadata.size > maxBytes
    )) ||
    (platform !== "win32" && (
      !Number.isInteger(metadata.mode) || (metadata.mode & 0o777) !== expectedMode ||
      (expectedUid !== null && metadata.uid !== expectedUid)
    ))
  ) {
    throw fail("refuses unsafe local dashboard control state");
  }
}

function fingerprint(metadata, raw) {
  return Object.freeze({
    raw,
    dev: metadata.dev,
    ino: metadata.ino,
    size: metadata.size,
    mtimeMs: metadata.mtimeMs,
    ctimeMs: metadata.ctimeMs,
  });
}

function sameFingerprint(left, right) {
  return left.raw === right.raw && left.dev === right.dev && left.ino === right.ino &&
    left.size === right.size && left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs;
}

function sameMovedFingerprint(left, right) {
  return left.raw === right.raw && left.dev === right.dev && left.ino === right.ino &&
    left.size === right.size && left.mtimeMs === right.mtimeMs;
}

function pathFingerprint(metadata) {
  if (
    !Number.isSafeInteger(metadata?.dev) || metadata.dev < 0 ||
    !Number.isSafeInteger(metadata?.ino) || metadata.ino < 1
  ) {
    throw fail("could not fingerprint local dashboard control state");
  }
  return Object.freeze({ dev: metadata.dev, ino: metadata.ino });
}

function samePathFingerprint(left, right) {
  return left?.dev === right?.dev && left?.ino === right?.ino;
}

function sameOpenFile(metadata, other) {
  return metadata?.dev === other?.dev && metadata?.ino === other?.ino &&
    metadata?.size === other?.size && metadata?.mtimeMs === other?.mtimeMs &&
    metadata?.ctimeMs === other?.ctimeMs;
}

async function inspectPrivatePath({
  fileSystem, path, kind, platform, lockDownPath, maxBytes, expectedUid,
  verifyEffectiveOwnerOnly = false,
}) {
  let metadata = await lstatIfExists(fileSystem, path);
  if (!metadata) return null;
  assertPrivateMetadata(metadata, { kind, platform, maxBytes, expectedUid });
  if (platform === "win32") {
    await lockDownPath(path, {
      platform,
      ...(kind === "file" ? { kind: "file" } : {}),
      verifyOnly: true,
      ...(verifyEffectiveOwnerOnly ? { verifyEffectiveOwnerOnly: true } : {}),
    });
    metadata = await lstatIfExists(fileSystem, path);
    assertPrivateMetadata(metadata, { kind, platform, maxBytes, expectedUid });
  }
  return metadata;
}

async function verifyParentBoundary({
  fileSystem, path, platform, lockDownPath, expectedUid, requirePrivateAcl = false,
}) {
  // The signed-in OS account and local Administrators are trust anchors. Windows
  // default profile directories legitimately grant SYSTEM/Administrators access,
  // so strict owner-only ACL verification starts at the managed .relmio root.
  // A caller-selected parent must itself meet that stricter ACL contract.
  let metadata = await lstatIfExists(fileSystem, path);
  if (!metadata?.isDirectory?.() || metadata.isSymbolicLink?.()) {
    throw fail("refuses an unsafe local dashboard storage parent");
  }
  if (platform === "win32") {
    if (requirePrivateAcl) {
      await lockDownPath(path, { platform, verifyOnly: true });
      metadata = await lstatIfExists(fileSystem, path);
      if (!metadata?.isDirectory?.() || metadata.isSymbolicLink?.()) {
        throw fail("refuses an unsafe local dashboard storage parent");
      }
    }
  } else {
    const mode = metadata.mode & 0o7777;
    const writableByOthers = (mode & 0o022) !== 0;
    const sticky = (mode & 0o1000) !== 0;
    if (
      !Number.isInteger(metadata.mode) ||
      (expectedUid !== null && metadata.uid !== expectedUid) ||
      (writableByOthers && !sticky)
    ) throw fail("refuses an unsafe local dashboard storage parent");
  }
  return pathFingerprint(metadata);
}

async function captureDirectoryAnchor({
  fileSystem, path, platform, lockDownPath, expectedUid,
}) {
  const metadata = await inspectPrivatePath({
    fileSystem, path, kind: "directory", platform, lockDownPath, expectedUid,
  });
  if (!metadata) throw fail("detected a missing local dashboard storage boundary");
  return Object.freeze({ path, fingerprint: pathFingerprint(metadata) });
}

async function assertDirectoryAnchors({
  fileSystem, anchors, platform, lockDownPath, expectedUid,
}) {
  if (!Array.isArray(anchors) || anchors.length === 0) {
    throw new TypeError("The local dashboard storage anchors are invalid.");
  }
  for (const anchor of anchors) {
    let currentFingerprint;
    if (anchor.kind === "parent") {
      currentFingerprint = await verifyParentBoundary({
        fileSystem,
        path: anchor.path,
        platform,
        lockDownPath,
        expectedUid,
        requirePrivateAcl: anchor.requirePrivateAcl,
      });
    } else {
      const metadata = await inspectPrivatePath({
        fileSystem,
        path: anchor.path,
        kind: "directory",
        platform,
        lockDownPath,
        expectedUid,
      });
      if (!metadata) throw fail("detected a missing local dashboard storage boundary");
      currentFingerprint = pathFingerprint(metadata);
    }
    if (!samePathFingerprint(currentFingerprint, anchor.fingerprint)) {
      throw fail("detected a changed local dashboard storage boundary");
    }
  }
}

async function readPrivateFile(options) {
  const {
    fileSystem,
    path,
    platform,
    lockDownPath,
    maxBytes,
    expectedUid,
    verifyEffectiveOwnerOnly = false,
  } = options;
  const before = await inspectPrivatePath({
    fileSystem, path, kind: "file", platform, lockDownPath, maxBytes, expectedUid,
    verifyEffectiveOwnerOnly,
  });
  if (!before) return null;
  let handle;
  let openedBefore;
  let openedAfter;
  let raw;
  try {
    handle = await fileSystem.open(path, "r");
    openedBefore = await handle.stat();
    assertPrivateMetadata(openedBefore, {
      kind: "file", platform, maxBytes, expectedUid,
    });
    if (!sameOpenFile(before, openedBefore)) throw new TypeError();
    raw = await handle.readFile("utf8");
    openedAfter = await handle.stat();
    if (!sameOpenFile(openedBefore, openedAfter)) throw new TypeError();
  } catch {
    throw fail("could not safely read its local dashboard control state");
  } finally {
    try { await handle?.close(); } catch { /* A later path check still fails closed. */ }
  }
  const rawBytes = Buffer.byteLength(raw);
  if (rawBytes > maxBytes || rawBytes !== openedAfter.size) {
    throw fail("refuses oversized or changed local dashboard control state");
  }
  const after = await inspectPrivatePath({
    fileSystem, path, kind: "file", platform, lockDownPath, maxBytes, expectedUid,
    verifyEffectiveOwnerOnly,
  });
  if (
    !after || !sameOpenFile(before, after) ||
    !sameFingerprint(fingerprint(before, raw), fingerprint(after, raw))
  ) {
    throw fail("detected changed local dashboard control state");
  }
  return Object.freeze({ raw, fingerprint: fingerprint(after, raw) });
}

function validateOrigin(origin) {
  if (typeof origin !== "string" || origin.length > 64) throw new TypeError();
  const match = /^http:\/\/127\.0\.0\.1:([1-9][0-9]{0,4})$/u.exec(origin);
  if (!match) throw new TypeError();
  const port = Number(match[1]);
  if (!Number.isInteger(port) || port > 65_535) throw new TypeError();
  const parsed = new URL(origin);
  if (
    parsed.protocol !== "http:" || parsed.hostname !== "127.0.0.1" ||
    parsed.pathname !== "/" || parsed.search || parsed.hash || parsed.username || parsed.password
  ) throw new TypeError();
  return origin;
}

function validatePublication(value) {
  try {
    if (
      !exactKeys(value, PUBLICATION_KEYS) ||
      value.schemaVersion !== PUBLICATION_SCHEMA_VERSION ||
      value.kind !== CONTROL_KIND ||
      value.protocolVersion !== CONTROL_PROTOCOL_VERSION ||
      !PACKAGE_VERSION_PATTERN.test(value.packageVersion) ||
      !Number.isSafeInteger(value.pid) || value.pid < 1 || value.pid > MAX_PROCESS_ID ||
      typeof value.processStartIdentity !== "string" || value.processStartIdentity.length === 0 ||
      Buffer.byteLength(value.processStartIdentity) > MAX_IDENTITY_BYTES || /[\0\r\n]/u.test(value.processStartIdentity) ||
      !INSTANCE_ID_PATTERN.test(value.instanceId) || validateOrigin(value.origin) !== value.origin ||
      !Number.isSafeInteger(value.publishedAtMs) || value.publishedAtMs < 1
    ) throw new TypeError();
    return Object.freeze({ ...value });
  } catch {
    throw fail("refuses malformed local dashboard control state");
  }
}

function parseExactJson(raw, keys, expected) {
  try {
    const value = JSON.parse(raw);
    if (!exactKeys(value, keys)) throw new TypeError();
    for (const [key, expectedValue] of Object.entries(expected)) {
      if (value[key] !== expectedValue) throw new TypeError();
    }
    return value;
  } catch {
    throw fail("refuses an invalid local managed-root marker");
  }
}

function validateSecret(raw, role) {
  const rolePattern = role === "control" ? CONTROL_TOKEN_PATTERN : BROWSER_TOKEN_PATTERN;
  if (!SESSION_TOKEN_PATTERN.test(raw) || !rolePattern.test(raw)) {
    throw fail("refuses an invalid local dashboard control key");
  }
  return raw;
}

function digestContent(raw) {
  return createHash("sha256").update(raw, "utf8").digest("base64url");
}

function createControlStateDescriptor({ publicationRaw, controlToken, browserToken, instanceId }) {
  if (!INSTANCE_ID_PATTERN.test(instanceId)) {
    throw fail("could not create a dashboard state identity");
  }
  const digests = [publicationRaw, controlToken, browserToken].map(digestContent);
  if (digests.some((digest) => !CONTENT_DIGEST_PATTERN.test(digest))) {
    throw fail("could not create dashboard state fingerprints");
  }
  const name = `${CONTROL_STATE_PREFIX}${instanceId}-${digests.join("-")}`;
  const publishingName = `${CONTROL_PUBLISHING_PREFIX}${instanceId}-${digests.join("-")}`;
  const finalizingName = `${CONTROL_FINALIZING_PREFIX}${instanceId}-${digests.join("-")}`;
  return Object.freeze({
    name,
    readyName: name,
    publishingName,
    finalizingName,
    instanceId,
    publicationDigest: digests[0],
    controlDigest: digests[1],
    browserDigest: digests[2],
  });
}

function parseControlStateDescriptor(name, phase = "ready") {
  const pattern = phase === "publishing"
    ? CONTROL_PUBLISHING_PATTERN
    : phase === "finalizing"
      ? CONTROL_FINALIZING_PATTERN
      : CONTROL_STATE_PATTERN;
  const match = pattern.exec(name);
  if (!match) throw fail("refuses an invalid local dashboard state marker");
  const suffix = `${match[1]}-${match[2]}-${match[3]}-${match[4]}`;
  return Object.freeze({
    name,
    readyName: `${CONTROL_STATE_PREFIX}${suffix}`,
    publishingName: `${CONTROL_PUBLISHING_PREFIX}${suffix}`,
    finalizingName: `${CONTROL_FINALIZING_PREFIX}${suffix}`,
    instanceId: match[1],
    publicationDigest: match[2],
    controlDigest: match[3],
    browserDigest: match[4],
  });
}

function sameControlStateDescriptor(left, right) {
  return Boolean(left && right && left.readyName === right.readyName);
}

const CONTROL_ENTRY_DETAILS = Object.freeze([
  Object.freeze({
    name: PUBLICATION_FILE,
    property: "publicationRecord",
    role: "publication",
    maxBytes: MAX_PUBLICATION_BYTES,
    digestProperty: "publicationDigest",
  }),
  Object.freeze({
    name: CONTROL_KEY_FILE,
    property: "controlKeyRecord",
    role: "control",
    maxBytes: 43,
    digestProperty: "controlDigest",
  }),
  Object.freeze({
    name: BROWSER_KEY_FILE,
    property: "browserKeyRecord",
    role: "browser",
    maxBytes: 43,
    digestProperty: "browserDigest",
  }),
]);

function parseRetirementSlot(name) {
  const match = RETIREMENT_SLOT_PATTERN.exec(name);
  if (!match) throw fail("refuses changed local dashboard retirement state");
  const dev = Number(match[2]);
  const ino = Number(match[3]);
  const size = Number(match[4]);
  if (
    !Number.isSafeInteger(dev) || dev < 0 ||
    !Number.isSafeInteger(ino) || ino < 1 ||
    !Number.isSafeInteger(size) || size < 0
  ) throw fail("refuses changed local dashboard retirement state");
  return Object.freeze({
    name,
    role: match[1],
    dev,
    ino,
    size,
    digest: match[5],
  });
}

function createRetirementSlotDescriptor(role, record) {
  const { dev, ino, size } = record?.fingerprint ?? {};
  if (
    !["root", "publication", "control", "browser"].includes(role) ||
    !Number.isSafeInteger(dev) || dev < 0 ||
    !Number.isSafeInteger(ino) || ino < 1 ||
    !Number.isSafeInteger(size) || size < 0
  ) throw fail("could not reserve local dashboard retirement state");
  const digest = digestContent(record.raw);
  return parseRetirementSlot(`.slot-v1-${role}-${dev}-${ino}-${size}-${digest}`);
}

function maxBytesForRetirementRole(role) {
  if (role === "root") return MAX_MARKER_BYTES;
  const detail = CONTROL_ENTRY_DETAILS.find((entry) => entry.role === role);
  if (!detail) throw fail("refuses changed local dashboard retirement state");
  return detail.maxBytes;
}

function recordMatchesRetirementSlot(record, slot) {
  return Boolean(
    record && record.fingerprint.dev === slot.dev && record.fingerprint.ino === slot.ino &&
    record.fingerprint.size === slot.size && digestContent(record.raw) === slot.digest
  );
}

async function inspectRetirementSlots({
  fileSystem, retiringPath, platform, lockDownPath, expectedUid,
}) {
  const metadata = await inspectPrivatePath({
    fileSystem,
    path: retiringPath,
    kind: "directory",
    platform,
    lockDownPath,
    expectedUid,
  });
  if (!metadata) throw fail("refuses changed local dashboard retirement state");
  let entries;
  try { entries = (await fileSystem.readdir(retiringPath)).sort(); } catch {
    throw fail("could not inspect its local dashboard retirement state");
  }
  const slots = new Map();
  for (const entry of entries) {
    const descriptor = parseRetirementSlot(entry);
    if (slots.has(descriptor.role)) {
      throw fail("refuses changed local dashboard retirement state");
    }
    const slotPath = join(retiringPath, entry);
    await inspectPrivatePath({
      fileSystem,
      path: slotPath,
      kind: "directory",
      platform,
      lockDownPath,
      expectedUid,
    });
    let slotEntries;
    try { slotEntries = (await fileSystem.readdir(slotPath)).sort(); } catch {
      throw fail("could not inspect its local dashboard retirement state");
    }
    if (
      slotEntries.length > 1 ||
      (slotEntries.length === 1 && slotEntries[0] !== RETIREMENT_PAYLOAD_FILE)
    ) throw fail("refuses changed local dashboard retirement state");
    let payloadRecord = null;
    if (slotEntries.length === 1) {
      payloadRecord = await readPrivateFile({
        fileSystem,
        path: join(slotPath, RETIREMENT_PAYLOAD_FILE),
        platform,
        lockDownPath,
        expectedUid,
        maxBytes: maxBytesForRetirementRole(descriptor.role),
        verifyEffectiveOwnerOnly: descriptor.role === "root",
      });
      if (!recordMatchesRetirementSlot(payloadRecord, descriptor)) {
        throw fail("refuses changed local dashboard retirement state");
      }
    }
    slots.set(descriptor.role, Object.freeze({
      descriptor,
      slotPath,
      payloadPath: join(slotPath, RETIREMENT_PAYLOAD_FILE),
      payloadRecord,
    }));
  }
  return slots;
}

function safeResult(state, publication) {
  if (!publication) return Object.freeze({ state });
  return Object.freeze({
    state,
    pid: publication.pid,
    instanceId: publication.instanceId,
    origin: publication.origin,
    publishedAtMs: publication.publishedAtMs,
    packageVersion: publication.packageVersion,
  });
}

function validIdentity(value) {
  return value && typeof value === "object" && !Array.isArray(value) && (
    value.state === "dead" || value.state === "ambiguous" || (
      value.state === "active" && typeof value.startIdentity === "string" &&
      value.startIdentity.length > 0 && Buffer.byteLength(value.startIdentity) <= MAX_IDENTITY_BYTES &&
      !/[\0\r\n]/u.test(value.startIdentity)
    )
  );
}

function exactHealth(value, publication) {
  return exactKeys(value, [
    "instanceId",
    "kind",
    "origin",
    "packageVersion",
    "pid",
    "protocolVersion",
  ]) &&
    value.kind === CONTROL_KIND && value.protocolVersion === CONTROL_PROTOCOL_VERSION &&
    value.instanceId === publication.instanceId && value.pid === publication.pid &&
    value.origin === publication.origin && value.packageVersion === publication.packageVersion;
}

async function fetchJson(fetchImpl, url, options, timeoutMs, expectedStatus = 200) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetchImpl(url, { ...options, signal: controller.signal, redirect: "error" });
    if (
      !response || response.status !== expectedStatus || response.ok !== true ||
      typeof response.json !== "function"
    ) {
      return null;
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchStopResponse(fetchImpl, url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  try {
    const response = await fetchImpl(url, {
      ...options,
      signal: controller.signal,
      redirect: "error",
    });
    if (response?.status === 409) return Object.freeze({ state: "busy" });
    if (
      !response || response.status !== 202 || response.ok !== true ||
      typeof response.json !== "function"
    ) {
      return Object.freeze({ state: "invalid" });
    }
    try {
      return Object.freeze({ state: "accepted", value: await response.json() });
    } catch {
      return Object.freeze({ state: "invalid" });
    }
  } finally {
    clearTimeout(timer);
  }
}

async function inspectControlLayout({
  paths, fileSystem, platform, lockDownPath, expectedUid,
}) {
  const controlMetadata = await inspectPrivatePath({
    fileSystem, path: paths.controlRoot, kind: "directory", platform, lockDownPath, expectedUid,
  });
  if (!controlMetadata) return Object.freeze({ kind: "absent", paths });
  let entries;
  try { entries = (await fileSystem.readdir(paths.controlRoot)).sort(); } catch {
    throw fail("could not inspect its local dashboard control directory");
  }
  const controlDirectoryFingerprint = pathFingerprint(controlMetadata);
  if (entries.length === 0) {
    return Object.freeze({
      kind: "incomplete",
      paths,
      controlDirectoryFingerprint,
      descriptor: null,
    });
  }
  const readyMarkerNames = entries.filter((entry) => entry.startsWith(CONTROL_STATE_PREFIX));
  const publishingMarkerNames = entries.filter((entry) => entry.startsWith(CONTROL_PUBLISHING_PREFIX));
  const finalizingMarkerNames = entries.filter((entry) => entry.startsWith(CONTROL_FINALIZING_PREFIX));
  const dataNames = new Set([PUBLICATION_FILE, CONTROL_KEY_FILE, BROWSER_KEY_FILE]);
  if (
    readyMarkerNames.length > 1 || publishingMarkerNames.length > 1 ||
    finalizingMarkerNames.length > 1 ||
    readyMarkerNames.length + publishingMarkerNames.length + finalizingMarkerNames.length === 0 ||
    entries.some((entry) => (
      !dataNames.has(entry) && !readyMarkerNames.includes(entry) &&
      !publishingMarkerNames.includes(entry) && !finalizingMarkerNames.includes(entry)
    ))
  ) {
    throw fail("refuses unexpected local dashboard control files");
  }
  const readyDescriptor = readyMarkerNames.length === 1
    ? parseControlStateDescriptor(readyMarkerNames[0], "ready")
    : null;
  const publishingDescriptor = publishingMarkerNames.length === 1
    ? parseControlStateDescriptor(publishingMarkerNames[0], "publishing")
    : null;
  const finalizingDescriptor = finalizingMarkerNames.length === 1
    ? parseControlStateDescriptor(finalizingMarkerNames[0], "finalizing")
    : null;
  const descriptors = [readyDescriptor, publishingDescriptor, finalizingDescriptor].filter(Boolean);
  if (descriptors.some((descriptor) => (
    !sameControlStateDescriptor(descriptor, descriptors[0])
  ))) throw fail("refuses mismatched local dashboard publication phases");

  const inspectMarker = async (descriptor) => {
    if (!descriptor) return null;
    const markerPath = join(paths.controlRoot, descriptor.name);
    await inspectPrivatePath({
      fileSystem, path: markerPath, kind: "directory", platform, lockDownPath, expectedUid,
    });
    let markerEntries;
    try { markerEntries = (await fileSystem.readdir(markerPath)).sort(); } catch {
      throw fail("could not inspect its local dashboard state marker");
    }
    if (
      markerEntries.length > 1 ||
      (markerEntries.length === 1 && markerEntries[0] !== RETIRING_DIRECTORY)
    ) throw fail("refuses unexpected local dashboard retirement state");
    const retiringPath = markerEntries.length === 1
      ? join(markerPath, RETIRING_DIRECTORY)
      : null;
    const retirementSlots = retiringPath
      ? await inspectRetirementSlots({
        fileSystem, retiringPath, platform, lockDownPath, expectedUid,
      })
      : new Map();
    return Object.freeze({ markerPath, retiringPath, retirementSlots });
  };
  const readyMarker = await inspectMarker(readyDescriptor);
  const publishingMarker = await inspectMarker(publishingDescriptor);
  const finalizingMarker = await inspectMarker(finalizingDescriptor);
  if (finalizingMarker?.retiringPath) {
    throw fail("refuses changed local dashboard finalization state");
  }
  if (readyMarker && publishingMarker?.retiringPath) {
    throw fail("refuses conflicting local dashboard publication phases");
  }
  if (finalizingMarker && publishingMarker?.retiringPath) {
    throw fail("refuses conflicting local dashboard finalization state");
  }
  const committed = Boolean(readyDescriptor || finalizingDescriptor);
  const descriptor = readyDescriptor ?? finalizingDescriptor ?? publishingDescriptor;
  const activeMarker = readyMarker ?? publishingMarker;
  const retiringPath = activeMarker?.retiringPath ?? null;
  const retirementSlots = activeMarker?.retirementSlots ?? new Map();
  const retiring = Boolean(retiringPath || finalizingMarker);

  const records = {};
  for (const { name, property, maxBytes, digestProperty } of CONTROL_ENTRY_DETAILS) {
    if (!entries.includes(name)) continue;
    const record = await readPrivateFile({
      fileSystem,
      path: join(paths.controlRoot, name),
      platform,
      lockDownPath,
      expectedUid,
      maxBytes,
    });
    if (!record || (committed && digestContent(record.raw) !== descriptor[digestProperty])) {
      throw fail("refuses changed local dashboard control state");
    }
    records[property] = record;
  }

  let publication;
  if (committed && records.publicationRecord) {
    let parsed;
    try { parsed = JSON.parse(records.publicationRecord.raw); } catch {
      throw fail("refuses malformed local dashboard control state");
    }
    publication = validatePublication(parsed);
    if (publication.instanceId !== descriptor.instanceId) {
      throw fail("refuses mismatched local dashboard state identity");
    }
  }
  if (committed && records.controlKeyRecord) validateSecret(records.controlKeyRecord.raw, "control");
  if (committed && records.browserKeyRecord) validateSecret(records.browserKeyRecord.raw, "browser");
  if (
    committed && records.controlKeyRecord && records.browserKeyRecord &&
    records.controlKeyRecord.raw === records.browserKeyRecord.raw
  ) throw fail("refuses reused local dashboard control keys");

  const complete = Boolean(
    records.publicationRecord && records.controlKeyRecord && records.browserKeyRecord,
  );
  if (finalizingMarker && !retiringPath && Object.keys(records).length !== 0) {
    throw fail("refuses changed local dashboard finalization state");
  }
  if (committed && !retiring && !complete) {
    throw fail("refuses incomplete committed local dashboard control state");
  }
  if (retiring) {
    for (const slot of retirementSlots.values()) {
      if (slot.descriptor.role === "root") {
        throw fail("refuses changed local dashboard retirement state");
      }
      const detail = CONTROL_ENTRY_DETAILS.find(({ role }) => role === slot.descriptor.role);
      const record = detail ? records[detail.property] : null;
      if (record && slot.payloadRecord) {
        throw fail("refuses changed local dashboard retirement state");
      }
      if (record && !slot.payloadRecord && !recordMatchesRetirementSlot(record, slot.descriptor)) {
        throw fail("refuses changed local dashboard retirement state");
      }
      if (committed && slot.descriptor.digest !== descriptor[detail.digestProperty]) {
        throw fail("refuses changed local dashboard retirement state");
      }
    }
  }
  return Object.freeze({
    kind: retiring ? "retiring" : committed ? "ready" : "publishing",
    paths,
    controlDirectoryFingerprint,
    descriptor,
    markerPath: activeMarker?.markerPath ?? finalizingMarker.markerPath,
    readyMarkerPath: readyMarker?.markerPath ?? null,
    finalizingMarkerPath: finalizingMarker?.markerPath ?? null,
    retiringPath,
    retirementSlots,
    publishingMarkerPath: publishingMarker?.markerPath ?? null,
    publication,
    ...records,
  });
}

async function inspectInternal({
  env, homeDirectory, fileSystem, platform, lockDownPath,
  getProcessIdentity, fetchImpl, requestTimeoutMs, expectedUid,
}) {
  const paths = await resolveControlPaths({ env, homeDirectory, fileSystem });
  await verifyParentBoundary({
    fileSystem,
    path: paths.parentPath,
    platform,
    lockDownPath,
    expectedUid,
    requirePrivateAcl: paths.requirePrivateParentAcl,
  });
  const homeMetadata = await inspectPrivatePath({
    fileSystem, path: paths.relmioHome, kind: "directory", platform, lockDownPath, expectedUid,
  });
  if (!homeMetadata) return Object.freeze({ state: "absent", paths });

  const markerRecord = await readPrivateFile({
    fileSystem, path: paths.rootMarkerPath, platform, lockDownPath, maxBytes: MAX_MARKER_BYTES, expectedUid,
    verifyEffectiveOwnerOnly: true,
  });
  if (!markerRecord) throw fail("refuses a local storage directory without its managed-root marker");
  parseExactJson(markerRecord.raw, ROOT_MARKER_KEYS, ROOT_MARKER);

  const layout = await inspectControlLayout({
    paths, fileSystem, platform, lockDownPath, expectedUid,
  });
  if (layout.kind === "absent") return Object.freeze({ state: "absent", paths });
  if (
    layout.kind === "incomplete" || layout.kind === "publishing" ||
    layout.kind === "retiring"
  ) {
    return Object.freeze({ state: layout.kind, ...layout });
  }
  const {
    publication, publicationRecord, controlKeyRecord, browserKeyRecord,
    controlDirectoryFingerprint, descriptor, markerPath,
  } = layout;
  const controlToken = controlKeyRecord.raw;

  let identity;
  try { identity = await getProcessIdentity(publication.pid); } catch { identity = null; }
  const details = {
    paths,
    controlDirectoryFingerprint,
    descriptor,
    markerPath,
    publication,
    publicationRecord,
    controlKeyRecord,
    browserKeyRecord,
  };
  if (!validIdentity(identity) || identity.state === "ambiguous") {
    return Object.freeze({ ...safeResult("ambiguous", publication), ...details });
  }
  if (identity.state === "dead") {
    return Object.freeze({ ...safeResult("dead", publication), ...details });
  }
  if (identity.startIdentity !== publication.processStartIdentity) {
    return Object.freeze({ ...safeResult("pid-reused", publication), ...details });
  }
  let response = null;
  try {
    response = await fetchJson(fetchImpl, `${publication.origin}${HEALTH_PATH}`, {
      method: "GET",
      headers: { "X-Relmio-Control": controlToken },
    }, requestTimeoutMs);
  } catch { /* An active process without an exact response is unresponsive. */ }
  const state = exactHealth(response, publication)
    ? publication.packageVersion === CURRENT_PACKAGE_VERSION
      ? "healthy"
      : "version-mismatch"
    : "unresponsive";
  return Object.freeze({ ...safeResult(state, publication), ...details });
}

function currentUid(platform, getUid) {
  if (platform === "win32" || getUid === undefined) return null;
  if (typeof getUid !== "function") {
    throw new TypeError("The local dashboard control adapter is invalid.");
  }
  const uid = getUid();
  if (!Number.isSafeInteger(uid) || uid < 0) {
    throw new TypeError("The local dashboard control adapter is invalid.");
  }
  return uid;
}

function validateAdapters({ fileSystem, lockDownPath, getProcessIdentity, fetchImpl, requestTimeoutMs, platform }) {
  if (
    !fileSystem || typeof fileSystem.realpath !== "function" || typeof fileSystem.lstat !== "function" ||
    typeof fileSystem.open !== "function" || typeof fileSystem.readFile !== "function" || typeof lockDownPath !== "function" ||
    typeof getProcessIdentity !== "function" || typeof fetchImpl !== "function" ||
    !Number.isSafeInteger(requestTimeoutMs) || requestTimeoutMs < 1 || requestTimeoutMs > 30_000 ||
    typeof platform !== "string" || platform.length === 0
  ) {
    throw new TypeError("The local dashboard control adapter is invalid.");
  }
}

export async function inspectLocalDashboardControlPlane({
  env = process.env,
  homeDirectory = homedir(),
  fileSystem = defaultFileSystem,
  platform = process.platform,
  lockDownPath = lockDownLocalPath,
  getProcessIdentity = getLocalProcessIdentity,
  fetchImpl = fetch,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  getUid = process.getuid?.bind(process),
} = {}) {
  validateAdapters({ fileSystem, lockDownPath, getProcessIdentity, fetchImpl, requestTimeoutMs, platform });
  const expectedUid = currentUid(platform, getUid);
  const result = await inspectInternal({
    env, homeDirectory, fileSystem, platform, lockDownPath,
    getProcessIdentity, fetchImpl, requestTimeoutMs, expectedUid,
  });
  return safeResult(result.state, result.publication);
}

async function createPrivateDirectory({
  fileSystem,
  path,
  platform,
  lockDownPath,
  expectedUid,
  anchors = null,
  requireNew = false,
}) {
  if (anchors) {
    await assertDirectoryAnchors({
      fileSystem, anchors, platform, lockDownPath, expectedUid,
    });
  }
  let created = false;
  try {
    await fileSystem.mkdir(path, { mode: 0o700 });
    created = true;
  } catch (error) {
    if (error?.code !== "EEXIST") {
      throw fail("could not create its private dashboard control directory");
    }
    if (requireNew) {
      throw fail("refuses to overwrite an existing dashboard control destination");
    }
  }
  if (created) {
    try {
      await fileSystem.chmod(path, 0o700);
      await lockDownPath(path, { platform });
    } catch {
      try { await fileSystem.rmdir(path); } catch { /* Preserve any changed/non-empty path. */ }
      throw fail("could not protect its private dashboard control directory");
    }
  }
  await inspectPrivatePath({
    fileSystem, path, kind: "directory", platform, lockDownPath, expectedUid,
  });
  if (anchors) {
    await assertDirectoryAnchors({
      fileSystem, anchors, platform, lockDownPath, expectedUid,
    });
  }
  return created;
}

async function writePrivateFile({
  fileSystem, path, raw, platform, lockDownPath, expectedUid, maxBytes, anchors,
}) {
  if (
    typeof raw !== "string" || Buffer.byteLength(raw) > maxBytes ||
    !Array.isArray(anchors) || anchors.length === 0
  ) {
    throw new TypeError("The local dashboard private file is invalid.");
  }
  await assertDirectoryAnchors({
    fileSystem, anchors, platform, lockDownPath, expectedUid,
  });
  let handle;
  let createdMetadata;
  try {
    handle = await fileSystem.open(path, "wx", 0o600);
    await handle.chmod(0o600);
    createdMetadata = await handle.stat();
    assertPrivateMetadata(createdMetadata, {
      kind: "file", platform, maxBytes, expectedUid,
    });
    await assertDirectoryAnchors({
      fileSystem, anchors, platform, lockDownPath, expectedUid,
    });
    await lockDownPath(path, { platform, kind: "file" });
    const protectedMetadata = await inspectPrivatePath({
      fileSystem, path, kind: "file", platform, lockDownPath, maxBytes, expectedUid,
    });
    if (
      !protectedMetadata ||
      !samePathFingerprint(pathFingerprint(createdMetadata), pathFingerprint(protectedMetadata))
    ) {
      throw fail("detected a replaced private dashboard control file");
    }
    await assertDirectoryAnchors({
      fileSystem, anchors, platform, lockDownPath, expectedUid,
    });
    await handle.writeFile(raw, "utf8");
    await handle.sync?.();
    const writtenMetadata = await handle.stat();
    if (
      writtenMetadata.dev !== createdMetadata.dev || writtenMetadata.ino !== createdMetadata.ino ||
      writtenMetadata.size !== Buffer.byteLength(raw)
    ) {
      throw fail("could not verify its private dashboard control write");
    }
    await assertDirectoryAnchors({
      fileSystem, anchors, platform, lockDownPath, expectedUid,
    });
  } catch (error) {
    if (error?.code === "EEXIST") throw fail("refuses to overwrite existing local dashboard control state");
    try { await handle?.close(); } catch { /* Preserve the original failure. */ }
    // Leave the file inside its durable publishing directory. Recovery moves
    // that reserved entry before deleting it, so a partial write is retryable
    // without a check-then-unlink race against a final pathname.
    if (error?.message?.startsWith("Relmio ")) throw error;
    throw fail("could not publish its private dashboard control state");
  }
  try { await handle.close(); } catch {
    throw fail("could not close its private dashboard control state");
  }
  const record = await readPrivateFile({
    fileSystem, path, platform, lockDownPath, maxBytes, expectedUid,
  });
  if (!record || record.raw !== raw) throw fail("could not verify its private dashboard control state");
  return record;
}

async function finishRetirementSlot({
  fileSystem,
  sourcePath,
  expectedRecord,
  slot,
  platform,
  lockDownPath,
  expectedUid,
  maxBytes,
  anchors,
  verifyEffectiveOwnerOnly = false,
}) {
  let payloadRecord = slot.payloadRecord;
  let sourceRecord = await readPrivateFile({
    fileSystem, path: sourcePath, platform, lockDownPath, expectedUid, maxBytes,
    verifyEffectiveOwnerOnly,
  });
  if (sourceRecord && expectedRecord && !sameFingerprint(
    sourceRecord.fingerprint,
    expectedRecord.fingerprint,
  )) throw fail("refuses to retire changed local dashboard control state");
  if (sourceRecord && !recordMatchesRetirementSlot(sourceRecord, slot.descriptor)) {
    throw fail("refuses to retire changed local dashboard control state");
  }
  if (sourceRecord && payloadRecord) {
    throw fail("refuses changed local dashboard retirement state");
  }

  const slotAnchor = await captureDirectoryAnchor({
    fileSystem, path: slot.slotPath, platform, lockDownPath, expectedUid,
  });
  const guardedAnchors = [...anchors, slotAnchor];
  if (sourceRecord) {
    await assertDirectoryAnchors({
      fileSystem, anchors: guardedAnchors, platform, lockDownPath, expectedUid,
    });
    try { await fileSystem.rename(sourcePath, slot.payloadPath); } catch {
      throw fail("could not move verified local dashboard state into retirement");
    }
    await assertDirectoryAnchors({
      fileSystem, anchors: guardedAnchors, platform, lockDownPath, expectedUid,
    });
    payloadRecord = await readPrivateFile({
      fileSystem,
      path: slot.payloadPath,
      platform,
      lockDownPath,
      expectedUid,
      maxBytes,
      verifyEffectiveOwnerOnly,
    });
    if (
      !recordMatchesRetirementSlot(payloadRecord, slot.descriptor) ||
      !sameMovedFingerprint(sourceRecord.fingerprint, payloadRecord.fingerprint)
    ) {
      // Preserve the moved replacement for inspection. The signed-in account is
      // the local trust boundary; the lifecycle lock excludes every conforming
      // same-account writer, and Node has no portable unlink-by-handle primitive.
      throw fail("detected changed local dashboard state while moving it into retirement");
    }
    if (await lstatIfExists(fileSystem, sourcePath)) {
      throw fail("detected replaced local dashboard control state after retirement move");
    }
  }

  if (payloadRecord) {
    const verifiedPayload = await readPrivateFile({
      fileSystem,
      path: slot.payloadPath,
      platform,
      lockDownPath,
      expectedUid,
      maxBytes,
      verifyEffectiveOwnerOnly,
    });
    if (
      !recordMatchesRetirementSlot(verifiedPayload, slot.descriptor) ||
      !sameFingerprint(verifiedPayload.fingerprint, payloadRecord.fingerprint)
    ) throw fail("refuses to remove changed local dashboard retirement payload");
    await assertDirectoryAnchors({
      fileSystem, anchors: guardedAnchors, platform, lockDownPath, expectedUid,
    });
    try { await fileSystem.unlink(slot.payloadPath); } catch {
      throw fail("could not remove verified local dashboard retirement payload");
    }
    if (await lstatIfExists(fileSystem, slot.payloadPath)) {
      throw fail("detected replaced local dashboard retirement payload after removal");
    }
  }
  await assertDirectoryAnchors({
    fileSystem, anchors, platform, lockDownPath, expectedUid,
  });
  try { await fileSystem.rmdir(slot.slotPath); } catch {
    throw fail("could not finish local dashboard retirement slot");
  }
}

async function retirePrivateFile({
  fileSystem,
  sourcePath,
  expectedRecord,
  role,
  retiringPath,
  existingSlot = null,
  platform,
  lockDownPath,
  expectedUid,
  maxBytes,
  anchors,
  verifyEffectiveOwnerOnly = false,
}) {
  let slot = existingSlot;
  if (!slot) {
    if (!expectedRecord) return;
    const descriptor = createRetirementSlotDescriptor(role, expectedRecord);
    const slotPath = join(retiringPath, descriptor.name);
    await createPrivateDirectory({
      fileSystem,
      path: slotPath,
      platform,
      lockDownPath,
      expectedUid,
      anchors,
      requireNew: true,
    });
    slot = Object.freeze({
      descriptor,
      slotPath,
      payloadPath: join(slotPath, RETIREMENT_PAYLOAD_FILE),
      payloadRecord: null,
    });
  }
  if (slot.descriptor.role !== role) {
    throw fail("refuses changed local dashboard retirement state");
  }
  await finishRetirementSlot({
    fileSystem,
    sourcePath,
    expectedRecord,
    slot,
    platform,
    lockDownPath,
    expectedUid,
    maxBytes,
    anchors,
    verifyEffectiveOwnerOnly,
  });
}

async function directoryEntries(fileSystem, path, message) {
  try { return (await fileSystem.readdir(path)).sort(); } catch { throw fail(message); }
}

async function finishRootRetirement({
  paths,
  fileSystem,
  platform,
  lockDownPath,
  expectedUid,
  parentAnchor,
  bootstrapAnchor,
  sourcePath,
  sourceRecord,
  removeHome,
}) {
  const retiringPath = join(paths.bootstrapRoot, RETIRING_DIRECTORY);
  const retiringMetadata = await inspectPrivatePath({
    fileSystem,
    path: retiringPath,
    kind: "directory",
    platform,
    lockDownPath,
    expectedUid,
  });
  if (!retiringMetadata) {
    await createPrivateDirectory({
      fileSystem,
      path: retiringPath,
      platform,
      lockDownPath,
      expectedUid,
      anchors: [parentAnchor, bootstrapAnchor],
      requireNew: true,
    });
  }
  const retiringAnchor = await captureDirectoryAnchor({
    fileSystem, path: retiringPath, platform, lockDownPath, expectedUid,
  });
  const slots = await inspectRetirementSlots({
    fileSystem, retiringPath, platform, lockDownPath, expectedUid,
  });
  if (slots.size > 1 || (slots.size === 1 && !slots.has("root"))) {
    throw fail("refuses changed dashboard root bootstrap retirement state");
  }
  const anchors = [parentAnchor, bootstrapAnchor, retiringAnchor];
  if (removeHome) {
    const homeMetadata = await inspectPrivatePath({
      fileSystem,
      path: paths.relmioHome,
      kind: "directory",
      platform,
      lockDownPath,
      expectedUid,
    });
    if (homeMetadata) {
      anchors.push(await captureDirectoryAnchor({
        fileSystem, path: paths.relmioHome, platform, lockDownPath, expectedUid,
      }));
    }
  }
  await retirePrivateFile({
    fileSystem,
    sourcePath,
    expectedRecord: sourceRecord,
    role: "root",
    retiringPath,
    existingSlot: slots.get("root") ?? null,
    platform,
    lockDownPath,
    expectedUid,
    maxBytes: MAX_MARKER_BYTES,
    anchors,
    verifyEffectiveOwnerOnly: true,
  });
  if (removeHome && await lstatIfExists(fileSystem, paths.relmioHome)) {
    const entries = await directoryEntries(
      fileSystem,
      paths.relmioHome,
      "could not inspect its incomplete local storage directory",
    );
    if (entries.length !== 0) {
      throw fail("refuses changed dashboard root bootstrap state");
    }
    try { await fileSystem.rmdir(paths.relmioHome); } catch {
      throw fail("could not recover its incomplete local storage directory");
    }
  }
  try { await fileSystem.rmdir(retiringPath); } catch {
    throw fail("could not finish dashboard root bootstrap retirement");
  }
  try { await fileSystem.rmdir(paths.bootstrapRoot); } catch {
    throw fail("could not finish legacy dashboard root bootstrap recovery");
  }
}

async function recoverRootBootstrap({
  paths, fileSystem, platform, lockDownPath, expectedUid, parentAnchor,
}) {
  const metadata = await inspectPrivatePath({
    fileSystem,
    path: paths.bootstrapRoot,
    kind: "directory",
    platform,
    lockDownPath,
    expectedUid,
  });
  if (!metadata) return;
  const bootstrapAnchor = Object.freeze({
    path: paths.bootstrapRoot,
    fingerprint: pathFingerprint(metadata),
  });
  const entries = await directoryEntries(
    fileSystem,
    paths.bootstrapRoot,
    "could not inspect dashboard root bootstrap state",
  );
  const legacyNames = [ROOT_MARKER_FILE, `${ROOT_MARKER_FILE}.retired`];
  const directMarkers = entries.filter((entry) => legacyNames.includes(entry));
  if (
    directMarkers.length > 1 ||
    entries.some((entry) => entry !== RETIRING_DIRECTORY && !legacyNames.includes(entry)) ||
    (directMarkers.length === 1 && entries.length > 2)
  ) throw fail("refuses unexpected dashboard root bootstrap state");

  if (directMarkers.length === 1) {
    const sourcePath = join(paths.bootstrapRoot, directMarkers[0]);
    const sourceRecord = await readPrivateFile({
      fileSystem,
      path: sourcePath,
      platform,
      lockDownPath,
      expectedUid,
      maxBytes: MAX_MARKER_BYTES,
      verifyEffectiveOwnerOnly: true,
    });
    if (!sourceRecord) throw fail("refuses changed dashboard root bootstrap state");
    parseExactJson(sourceRecord.raw, ROOT_MARKER_KEYS, ROOT_MARKER);
    await finishRootRetirement({
      paths,
      fileSystem,
      platform,
      lockDownPath,
      expectedUid,
      parentAnchor,
      bootstrapAnchor,
      sourcePath,
      sourceRecord,
      removeHome: false,
    });
    return;
  }

  const retiring = entries.includes(RETIRING_DIRECTORY);
  const homeMetadata = await inspectPrivatePath({
    fileSystem,
    path: paths.relmioHome,
    kind: "directory",
    platform,
    lockDownPath,
    expectedUid,
  });
  let homeEntries = [];
  let rootRecord = null;
  if (homeMetadata) {
    homeEntries = await directoryEntries(
      fileSystem,
      paths.relmioHome,
      "could not inspect its incomplete local storage directory",
    );
    if (homeEntries.some((entry) => entry !== ROOT_MARKER_FILE) || homeEntries.length > 1) {
      throw fail("refuses changed dashboard root bootstrap state");
    }
    if (homeEntries.includes(ROOT_MARKER_FILE)) {
      rootRecord = await readPrivateFile({
        fileSystem,
        path: paths.rootMarkerPath,
        platform,
        lockDownPath,
        expectedUid,
        maxBytes: MAX_MARKER_BYTES,
        verifyEffectiveOwnerOnly: true,
      });
      if (!rootRecord) throw fail("refuses changed dashboard root bootstrap state");
    }
  }

  if (!retiring && rootRecord) {
    let complete = false;
    try {
      parseExactJson(rootRecord.raw, ROOT_MARKER_KEYS, ROOT_MARKER);
      complete = true;
    } catch (error) {
      if (!error?.message?.startsWith("Relmio refuses an invalid local managed-root marker")) {
        throw error;
      }
      // A malformed marker is retryable only while this exclusive bootstrap
      // phase proves that the first publication never committed.
    }
    if (complete) {
      await assertDirectoryAnchors({
        fileSystem,
        anchors: [parentAnchor, bootstrapAnchor],
        platform,
        lockDownPath,
        expectedUid,
      });
      try { await fileSystem.rmdir(paths.bootstrapRoot); } catch {
        throw fail("could not commit its local managed-root marker");
      }
      return;
    }
  }
  if (!retiring && !homeMetadata) {
    try { await fileSystem.rmdir(paths.bootstrapRoot); } catch {
      throw fail("could not finish dashboard root bootstrap recovery");
    }
    return;
  }
  await finishRootRetirement({
    paths,
    fileSystem,
    platform,
    lockDownPath,
    expectedUid,
    parentAnchor,
    bootstrapAnchor,
    sourcePath: paths.rootMarkerPath,
    sourceRecord: rootRecord,
    removeHome: true,
  });
}

async function ensureManagedControlRoot({
  env, homeDirectory, fileSystem, platform, lockDownPath, expectedUid,
  getProcessIdentity, now,
}) {
  const paths = await resolveControlPaths({ env, homeDirectory, fileSystem });
  const initialParentFingerprint = await verifyParentBoundary({
    fileSystem,
    path: paths.parentPath,
    platform,
    lockDownPath,
    expectedUid,
    requirePrivateAcl: paths.requirePrivateParentAcl,
  });
  const parentAnchor = Object.freeze({
    kind: "parent",
    path: paths.parentPath,
    fingerprint: initialParentFingerprint,
    requirePrivateAcl: paths.requirePrivateParentAcl,
  });
  let releaseBootstrapLock;
  try {
    releaseBootstrapLock = await acquireLocalIntegrationLifecycleLock({
      fileSystem,
      getProcessIdentity,
      lockDownPath,
      lockPath: paths.bootstrapLockPath,
      now,
      platform,
      label: "local dashboard root bootstrap lock",
    });
    await assertDirectoryAnchors({
      fileSystem, anchors: [parentAnchor], platform, lockDownPath, expectedUid,
    });
    await recoverRootBootstrap({
      paths, fileSystem, platform, lockDownPath, expectedUid, parentAnchor,
    });

    let homeMetadata = await inspectPrivatePath({
      fileSystem, path: paths.relmioHome, kind: "directory", platform, lockDownPath, expectedUid,
    });
    if (homeMetadata) {
      const marker = await readPrivateFile({
        fileSystem, path: paths.rootMarkerPath, platform, lockDownPath,
        expectedUid, maxBytes: MAX_MARKER_BYTES,
        verifyEffectiveOwnerOnly: true,
      });
      if (!marker) {
        let entries;
        try { entries = await fileSystem.readdir(paths.relmioHome); } catch {
          throw fail("could not inspect its incomplete local storage directory");
        }
        if (entries.length !== 0) {
          throw fail("refuses a local storage directory without its managed-root marker");
        }
        await assertDirectoryAnchors({
          fileSystem, anchors: [parentAnchor], platform, lockDownPath, expectedUid,
        });
        try { await fileSystem.rmdir(paths.relmioHome); } catch {
          throw fail("could not recover its empty local storage directory");
        }
        homeMetadata = null;
      } else {
        parseExactJson(marker.raw, ROOT_MARKER_KEYS, ROOT_MARKER);
      }
    }

    if (!homeMetadata) {
      await createPrivateDirectory({
        fileSystem,
        path: paths.bootstrapRoot,
        platform,
        lockDownPath,
        expectedUid,
        anchors: [parentAnchor],
        requireNew: true,
      });
      const bootstrapAnchor = await captureDirectoryAnchor({
        fileSystem, path: paths.bootstrapRoot, platform, lockDownPath, expectedUid,
      });
      await createPrivateDirectory({
        fileSystem,
        path: paths.relmioHome,
        platform,
        lockDownPath,
        expectedUid,
        anchors: [parentAnchor],
        requireNew: true,
      });
      const homeAnchor = await captureDirectoryAnchor({
        fileSystem, path: paths.relmioHome, platform, lockDownPath, expectedUid,
      });
      try {
        const marker = await writePrivateFile({
          fileSystem,
          path: paths.rootMarkerPath,
          raw: `${JSON.stringify(ROOT_MARKER)}\n`,
          platform,
          lockDownPath,
          expectedUid,
          maxBytes: MAX_MARKER_BYTES,
          anchors: [parentAnchor, bootstrapAnchor, homeAnchor],
        });
        parseExactJson(marker.raw, ROOT_MARKER_KEYS, ROOT_MARKER);
      } catch (error) {
        throw error;
      }
      await assertDirectoryAnchors({
        fileSystem,
        anchors: [parentAnchor, bootstrapAnchor, homeAnchor],
        platform,
        lockDownPath,
        expectedUid,
      });
      try { await fileSystem.rmdir(paths.bootstrapRoot); } catch {
        throw fail("could not commit its local managed-root marker");
      }
    }

    const finalHomeAnchor = await captureDirectoryAnchor({
      fileSystem, path: paths.relmioHome, platform, lockDownPath, expectedUid,
    });
    await assertDirectoryAnchors({
      fileSystem,
      anchors: [parentAnchor, finalHomeAnchor],
      platform,
      lockDownPath,
      expectedUid,
    });
  } catch (error) {
    try { await releaseBootstrapLock?.(); } catch { /* Preserve the root failure. */ }
    throw error;
  }
  await releaseBootstrapLock();
  return paths;
}

async function ensurePrivateBrowserLaunchRoot({
  paths, fileSystem, platform, lockDownPath, expectedUid,
}) {
  const homeAnchor = await captureDirectoryAnchor({
    fileSystem,
    path: paths.relmioHome,
    platform,
    lockDownPath,
    expectedUid,
  });
  await createPrivateDirectory({
    fileSystem,
    path: paths.browserLaunchRoot,
    platform,
    lockDownPath,
    expectedUid,
    anchors: [homeAnchor],
  });
  await assertDirectoryAnchors({
    fileSystem,
    anchors: [homeAnchor],
    platform,
    lockDownPath,
    expectedUid,
  });
  return paths.browserLaunchRoot;
}

function createRoleToken(randomBytes, role) {
  let bytes;
  try { bytes = Buffer.from(randomBytes(32)); } catch { throw fail("could not create a strong dashboard control key"); }
  if (bytes.length !== 32) throw fail("could not create a strong dashboard control key");
  bytes[0] = role === "control" ? bytes[0] & 0x3f : bytes[0] | 0xc0;
  return validateSecret(bytes.toString("base64url"), role);
}

async function cleanupLegacyControlArtifacts(options) {
  const { paths, fileSystem } = options;
  for (const path of [
    paths.changedMarkerPath,
    paths.retiredRoot,
    paths.stagingRoot,
    `${paths.stagingRoot}.retired`,
  ]) {
    if (await lstatIfExists(fileSystem, path)) {
      // These names came from an unreleased rename-based prototype. There is no
      // durable content fingerprint to distinguish its crash residue from
      // same-account replacement, so preserving it is the only safe recovery.
      throw fail("refuses unsupported legacy dashboard control state");
    }
  }
}

async function removeExactControlState(state, options) {
  const { fileSystem, platform, lockDownPath, expectedUid } = options;
  const paths = state.paths;
  let current = await inspectControlLayout({
    paths, fileSystem, platform, lockDownPath, expectedUid,
  });
  if (current.kind === "absent") return;
  if (
    state.controlDirectoryFingerprint &&
    !samePathFingerprint(current.controlDirectoryFingerprint, state.controlDirectoryFingerprint)
  ) {
    throw fail("refuses to remove replaced local dashboard control state");
  }
  if (state.descriptor && !sameControlStateDescriptor(current.descriptor, state.descriptor)) {
    throw fail("refuses to remove replaced local dashboard state marker");
  }
  if (!current.descriptor) {
    try { await fileSystem.rmdir(paths.controlRoot); } catch {
      throw fail("refuses changed incomplete local dashboard control state");
    }
    return;
  }

  const homeAnchor = await captureDirectoryAnchor({
    fileSystem, path: paths.relmioHome, platform, lockDownPath, expectedUid,
  });
  const controlAnchor = Object.freeze({
    path: paths.controlRoot,
    fingerprint: current.controlDirectoryFingerprint,
  });
  const markerAnchor = await captureDirectoryAnchor({
    fileSystem, path: current.markerPath, platform, lockDownPath, expectedUid,
  });
  const requestedRetiringPath = join(current.markerPath, RETIRING_DIRECTORY);
  if (current.kind !== "retiring") {
    await createPrivateDirectory({
      fileSystem,
      path: requestedRetiringPath,
      platform,
      lockDownPath,
      expectedUid,
      anchors: [homeAnchor, controlAnchor, markerAnchor],
      requireNew: true,
    });
  }

  current = await inspectControlLayout({
    paths, fileSystem, platform, lockDownPath, expectedUid,
  });
  if (
    current.kind !== "retiring" ||
    !sameControlStateDescriptor(current.descriptor, state.descriptor) ||
    !samePathFingerprint(current.controlDirectoryFingerprint, controlAnchor.fingerprint)
  ) {
    throw fail("refuses changed local dashboard retirement state");
  }

  if (current.retiringPath) {
    const retiringAnchor = await captureDirectoryAnchor({
      fileSystem, path: current.retiringPath, platform, lockDownPath, expectedUid,
    });
    const retirementAnchors = [homeAnchor, controlAnchor, markerAnchor, retiringAnchor];
    for (const { name, property, role, maxBytes } of CONTROL_ENTRY_DETAILS) {
      const record = current[property] ?? null;
      const slot = current.retirementSlots.get(role) ?? null;
      if (!record && !slot) continue;
      await retirePrivateFile({
        fileSystem,
        sourcePath: join(paths.controlRoot, name),
        expectedRecord: record,
        role,
        retiringPath: current.retiringPath,
        existingSlot: slot,
        platform,
        lockDownPath,
        expectedUid,
        maxBytes,
        anchors: retirementAnchors,
      });
    }
  }

  const committed = Boolean(current.readyMarkerPath || current.finalizingMarkerPath);
  let finalizingMarkerPath = current.finalizingMarkerPath;
  if (committed && !finalizingMarkerPath) {
    finalizingMarkerPath = join(paths.controlRoot, current.descriptor.finalizingName);
    await createPrivateDirectory({
      fileSystem,
      path: finalizingMarkerPath,
      platform,
      lockDownPath,
      expectedUid,
      anchors: [homeAnchor, controlAnchor, markerAnchor],
      requireNew: true,
    });
    const finalizingState = await inspectControlLayout({
      paths, fileSystem, platform, lockDownPath, expectedUid,
    });
    if (
      finalizingState.kind !== "retiring" ||
      finalizingState.finalizingMarkerPath !== finalizingMarkerPath ||
      !sameControlStateDescriptor(finalizingState.descriptor, current.descriptor)
    ) throw fail("could not verify local dashboard finalization state");
  }

  if (current.retiringPath) {
    try { await fileSystem.rmdir(current.retiringPath); } catch {
      throw fail("could not finish dashboard retirement cleanup");
    }
  }

  const markerPaths = [current.publishingMarkerPath, current.readyMarkerPath]
    .filter((path, index, pathsToRemove) => (
      path && path !== finalizingMarkerPath && pathsToRemove.indexOf(path) === index
    ));
  for (const markerPath of markerPaths) {
    const markerToRemoveAnchor = await captureDirectoryAnchor({
      fileSystem, path: markerPath, platform, lockDownPath, expectedUid,
    });
    await assertDirectoryAnchors({
      fileSystem,
      anchors: [homeAnchor, controlAnchor, markerToRemoveAnchor],
      platform,
      lockDownPath,
      expectedUid,
    });
    try { await fileSystem.rmdir(markerPath); } catch {
      throw fail("refuses changed local dashboard state marker");
    }
  }
  if (finalizingMarkerPath) {
    const finalizingAnchor = await captureDirectoryAnchor({
      fileSystem, path: finalizingMarkerPath, platform, lockDownPath, expectedUid,
    });
    await assertDirectoryAnchors({
      fileSystem,
      anchors: [homeAnchor, controlAnchor, finalizingAnchor],
      platform,
      lockDownPath,
      expectedUid,
    });
    try { await fileSystem.rmdir(finalizingMarkerPath); } catch {
      throw fail("refuses changed local dashboard finalization state");
    }
  }
  try { await fileSystem.rmdir(paths.controlRoot); } catch {
    throw fail("refuses changed local dashboard control directory");
  }
}

async function publishControlState({
  paths,
  publication,
  controlToken,
  browserToken,
  fileSystem,
  platform,
  lockDownPath,
  expectedUid,
}) {
  await cleanupLegacyControlArtifacts({
    paths, fileSystem, platform, lockDownPath, expectedUid,
  });
  const existing = await inspectControlLayout({
    paths, fileSystem, platform, lockDownPath, expectedUid,
  });
  if (existing.kind !== "absent") {
    if (existing.kind === "ready") {
      throw fail("refuses to replace existing local dashboard control state");
    }
    await removeExactControlState(existing, {
      fileSystem, platform, lockDownPath, expectedUid,
    });
  }

  const parentFingerprint = await verifyParentBoundary({
    fileSystem,
    path: paths.parentPath,
    platform,
    lockDownPath,
    expectedUid,
    requirePrivateAcl: paths.requirePrivateParentAcl,
  });
  const parentAnchor = Object.freeze({
    kind: "parent",
    path: paths.parentPath,
    fingerprint: parentFingerprint,
    requirePrivateAcl: paths.requirePrivateParentAcl,
  });
  const homeAnchor = await captureDirectoryAnchor({
    fileSystem, path: paths.relmioHome, platform, lockDownPath, expectedUid,
  });
  await createPrivateDirectory({
    fileSystem,
    path: paths.controlRoot,
    platform,
    lockDownPath,
    expectedUid,
    anchors: [parentAnchor, homeAnchor],
    requireNew: true,
  });
  const controlAnchor = await captureDirectoryAnchor({
    fileSystem, path: paths.controlRoot, platform, lockDownPath, expectedUid,
  });
  const publicationRaw = `${JSON.stringify(publication)}\n`;
  const descriptor = createControlStateDescriptor({
    publicationRaw, controlToken, browserToken, instanceId: publication.instanceId,
  });
  const publishingMarkerPath = join(paths.controlRoot, descriptor.publishingName);
  await createPrivateDirectory({
    fileSystem,
    path: publishingMarkerPath,
    platform,
    lockDownPath,
    expectedUid,
    anchors: [parentAnchor, homeAnchor, controlAnchor],
    requireNew: true,
  });
  const publishingAnchor = await captureDirectoryAnchor({
    fileSystem, path: publishingMarkerPath, platform, lockDownPath, expectedUid,
  });
  const publishingAnchors = [parentAnchor, homeAnchor, controlAnchor, publishingAnchor];
  try {
    await writePrivateFile({
      fileSystem,
      path: paths.controlKeyPath,
      raw: controlToken,
      platform,
      lockDownPath,
      expectedUid,
      maxBytes: 43,
      anchors: publishingAnchors,
    });
    await writePrivateFile({
      fileSystem,
      path: paths.browserKeyPath,
      raw: browserToken,
      platform,
      lockDownPath,
      expectedUid,
      maxBytes: 43,
      anchors: publishingAnchors,
    });
    await writePrivateFile({
      fileSystem,
      path: paths.publicationPath,
      raw: publicationRaw,
      platform,
      lockDownPath,
      expectedUid,
      maxBytes: MAX_PUBLICATION_BYTES,
      anchors: publishingAnchors,
    });
    const completePublishing = await inspectControlLayout({
      paths, fileSystem, platform, lockDownPath, expectedUid,
    });
    if (
      completePublishing.kind !== "publishing" ||
      !sameControlStateDescriptor(completePublishing.descriptor, descriptor) ||
      digestContent(completePublishing.publicationRecord?.raw ?? "") !== descriptor.publicationDigest ||
      digestContent(completePublishing.controlKeyRecord?.raw ?? "") !== descriptor.controlDigest ||
      digestContent(completePublishing.browserKeyRecord?.raw ?? "") !== descriptor.browserDigest
    ) {
      throw fail("could not verify its complete dashboard control publication");
    }
    const readyMarkerPath = join(paths.controlRoot, descriptor.readyName);
    await createPrivateDirectory({
      fileSystem,
      path: readyMarkerPath,
      platform,
      lockDownPath,
      expectedUid,
      anchors: publishingAnchors,
      requireNew: true,
    });
    const ready = await inspectControlLayout({
      paths, fileSystem, platform, lockDownPath, expectedUid,
    });
    if (ready.kind !== "ready" || !sameControlStateDescriptor(ready.descriptor, descriptor)) {
      throw fail("could not verify its committed dashboard control publication");
    }
    try { await fileSystem.rmdir(publishingMarkerPath); } catch {
      // The ready marker is the exclusive commit point. An empty publishing
      // phase left by interruption is harmless and is recognized on recovery.
    }
    return Object.freeze(ready);
  } catch (error) {
    try {
      const partial = await inspectControlLayout({
        paths, fileSystem, platform, lockDownPath, expectedUid,
      });
      if (
        partial.kind !== "absent" &&
        sameControlStateDescriptor(partial.descriptor, descriptor)
      ) {
        await removeExactControlState(partial, {
          fileSystem, platform, lockDownPath, expectedUid,
        });
      }
    } catch { /* Preserve any changed canonical state. */ }
    throw error;
  }
}

function safeDaemonError() {
  return "Relmio dashboard daemon could not start.";
}

/**
 * Owns the control-plane lock for the life of one loopback dashboard daemon.
 * The caller keeps the returned completion promise alive until a signal or the
 * authenticated control callback requests shutdown.
 */
export async function runLocalDashboardDaemon({
  env = process.env,
  homeDirectory = homedir(),
  fileSystem = defaultFileSystem,
  platform = process.platform,
  lockDownPath = lockDownLocalPath,
  getProcessIdentity = getLocalProcessIdentity,
  getUid = process.getuid?.bind(process),
  fetchImpl = fetch,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  randomBytes = createRandomBytes,
  randomUUID = createRandomUUID,
  now = Date.now,
  startServer,
  sendMessage = process.send?.bind(process),
  scheduleStop = (callback) => setImmediate(callback),
  signalTarget = process,
} = {}) {
  validateAdapters({ fileSystem, lockDownPath, getProcessIdentity, fetchImpl, requestTimeoutMs, platform });
  if (
    typeof startServer !== "function" || typeof randomBytes !== "function" ||
    typeof randomUUID !== "function" || typeof now !== "function" ||
    (sendMessage !== undefined && typeof sendMessage !== "function") ||
    typeof scheduleStop !== "function" || !signalTarget ||
    typeof signalTarget.once !== "function" || typeof signalTarget.removeListener !== "function"
  ) throw new TypeError("The local dashboard daemon adapter is invalid.");
  const expectedUid = currentUid(platform, getUid);
  const paths = await ensureManagedControlRoot({
    env, homeDirectory, fileSystem, platform, lockDownPath, expectedUid,
    getProcessIdentity, now,
  });
  await ensurePrivateBrowserLaunchRoot({
    paths, fileSystem, platform, lockDownPath, expectedUid,
  });
  let releaseLock;
  let wizard;
  let ownedState;
  let stopPromise;
  let completionResolve;
  let completionReject;
  const completion = new Promise((resolveCompletion, rejectCompletion) => {
    completionResolve = resolveCompletion;
    completionReject = rejectCompletion;
  });
  completion.catch(() => {});

  const stop = () => {
    if (stopPromise) return stopPromise;
    stopPromise = (async () => {
      try {
        await wizard?.close();
      } catch (error) {
        signalTarget.removeListener("SIGINT", onSignal);
        signalTarget.removeListener("SIGTERM", onSignal);
        completionReject(error);
        throw error;
      }
      try {
        if (ownedState) {
          await removeExactControlState(ownedState, {
            fileSystem, platform, lockDownPath, expectedUid,
          });
        }
      } catch (error) {
        signalTarget.removeListener("SIGINT", onSignal);
        signalTarget.removeListener("SIGTERM", onSignal);
        completionReject(error);
        throw error;
      }
      try {
        await releaseLock?.();
      } catch (error) {
        signalTarget.removeListener("SIGINT", onSignal);
        signalTarget.removeListener("SIGTERM", onSignal);
        completionReject(error);
        throw error;
      }
      signalTarget.removeListener("SIGINT", onSignal);
      signalTarget.removeListener("SIGTERM", onSignal);
      completionResolve();
    })();
    return stopPromise;
  };
  const onSignal = () => { void stop().catch(() => {}); };

  try {
    releaseLock = await acquireLocalIntegrationLifecycleLock({
      fileSystem,
      getProcessIdentity,
      lockDownPath,
      lockPath: paths.lockPath,
      now,
      platform,
      label: "local dashboard lifetime lock",
    });

    const prior = await inspectInternal({
      env, homeDirectory, fileSystem, platform, lockDownPath, expectedUid,
      getProcessIdentity, fetchImpl, requestTimeoutMs,
    });
    if (
      prior.state === "dead" || prior.state === "pid-reused" ||
      prior.state === "incomplete" || prior.state === "publishing" ||
      prior.state === "retiring"
    ) {
      await removeExactControlState(prior, {
        fileSystem, platform, lockDownPath, expectedUid,
      });
    } else if (prior.state !== "absent") {
      throw fail("refuses to replace an active or ambiguous dashboard daemon");
    }

    const controlToken = createRoleToken(randomBytes, "control");
    const browserToken = createRoleToken(randomBytes, "browser");
    if (controlToken === browserToken) throw fail("could not create separated dashboard control keys");
    const instanceId = randomUUID();
    if (!INSTANCE_ID_PATTERN.test(instanceId)) throw fail("could not create a dashboard instance identity");
    const publishedAtMs = now();
    if (!Number.isSafeInteger(publishedAtMs) || publishedAtMs < 1) {
      throw fail("could not create a dashboard publication time");
    }
    const selfIdentity = await getProcessIdentity(process.pid);
    if (!validIdentity(selfIdentity) || selfIdentity.state !== "active") {
      throw fail("could not verify the dashboard daemon process identity");
    }
    const onControlStop = () => {
      scheduleStop(() => { void stop().catch(() => {}); });
      return Object.freeze({ stopping: true, instanceId });
    };
    wizard = await startServer({
      sessionToken: browserToken,
      controlToken,
      controlInstanceId: instanceId,
      onControlStop,
      browserHandoffRoot: paths.browserLaunchRoot,
    });
    const publication = validatePublication({
      schemaVersion: PUBLICATION_SCHEMA_VERSION,
      kind: CONTROL_KIND,
      protocolVersion: CONTROL_PROTOCOL_VERSION,
      packageVersion: CURRENT_PACKAGE_VERSION,
      pid: process.pid,
      processStartIdentity: selfIdentity.startIdentity,
      instanceId,
      origin: wizard?.origin,
      publishedAtMs,
    });
    ownedState = await publishControlState({
      paths,
      publication,
      controlToken,
      browserToken,
      fileSystem,
      platform,
      lockDownPath,
      expectedUid,
    });
    signalTarget.once("SIGINT", onSignal);
    signalTarget.once("SIGTERM", onSignal);
    sendMessage?.(Object.freeze({ type: "ready" }));
    return Object.freeze({
      publication: safeResult("healthy", publication),
      stop,
      completion,
    });
  } catch (error) {
    try { await wizard?.close(); } catch { /* Preserve the startup failure. */ }
    try {
      if (ownedState) {
        await removeExactControlState(ownedState, {
          fileSystem, platform, lockDownPath, expectedUid,
        });
      }
    } catch { /* Never remove changed state during failed startup cleanup. */ }
    try { await releaseLock?.(); } catch { /* Preserve the startup failure. */ }
    sendMessage?.(Object.freeze({ type: "error", message: safeDaemonError() }));
    completionReject(error);
    throw error;
  }
}

function privateDaemonEnvironment(environment) {
  if (!environment || typeof environment !== "object" || Array.isArray(environment)) {
    throw new TypeError("The local dashboard daemon environment is invalid.");
  }
  const selected = {};
  for (const [name, value] of Object.entries(environment)) {
    if (typeof value !== "string") continue;
    if (!DAEMON_ENVIRONMENT_NAMES.has(name) && !LOCALE_ENVIRONMENT_NAME.test(name)) continue;
    if (
      SESSION_TOKEN_PATTERN.test(value) &&
      (CONTROL_TOKEN_PATTERN.test(value) || BROWSER_TOKEN_PATTERN.test(value))
    ) {
      throw new Error("Relmio refuses to pass a dashboard key through the daemon environment.");
    }
    if (/\0|\r|\n/u.test(value) || Buffer.byteLength(value) > 32 * 1024) {
      throw new TypeError("The local dashboard daemon environment is invalid.");
    }
    selected[name] = value;
  }
  return selected;
}

function validateExecutablePath(value) {
  return typeof value === "string" && isAbsolute(value) && !/[\0\r\n]/u.test(value);
}

/** Spawn the package CLI in its private daemon mode and await IPC readiness. */
export function spawnLocalDashboardDaemon({
  spawnProcess = spawn,
  execPath = process.execPath,
  cliPath = DEFAULT_CLI_PATH,
  environment = process.env,
  startupTimeoutMs = DEFAULT_STARTUP_TIMEOUT_MS,
} = {}) {
  if (
    typeof spawnProcess !== "function" || !validateExecutablePath(execPath) ||
    !validateExecutablePath(cliPath) || !Number.isSafeInteger(startupTimeoutMs) ||
    startupTimeoutMs < 1 || startupTimeoutMs > 60_000
  ) {
    throw new TypeError("The local dashboard daemon spawn adapter is invalid.");
  }
  const childEnvironment = privateDaemonEnvironment(environment);
  return new Promise((resolveReady, rejectReady) => {
    let child;
    let settled = false;
    let timer;
    const settle = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child?.removeListener?.("message", onMessage);
      child?.removeListener?.("error", onError);
      child?.removeListener?.("exit", onExit);
      child?.removeListener?.("disconnect", onDisconnect);
      try { if (child?.connected) child.disconnect(); } catch { /* Readiness remains bounded. */ }
      try { child?.unref?.(); } catch { /* Detachment is already requested at spawn. */ }
      if (error) rejectReady(error);
      else resolveReady(Object.freeze({ state: "ready" }));
    };
    const onError = () => settle(fail("dashboard daemon could not start"));
    const onExit = () => settle(fail("dashboard daemon exited before readiness"));
    const onDisconnect = () => settle(fail("dashboard daemon disconnected before readiness"));
    const onMessage = (message) => {
      if (exactKeys(message, ["type"]) && message.type === "ready") {
        settle();
        return;
      }
      if (
        exactKeys(message, ["message", "type"]) && message.type === "error" &&
        message.message === safeDaemonError()
      ) {
        settle(new Error(message.message));
        return;
      }
      settle(fail("received an invalid readiness message from the dashboard daemon"));
    };
    try {
      child = spawnProcess(execPath, [cliPath, PRIVATE_DAEMON_COMMAND], {
        cwd: dirname(execPath),
        detached: true,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        env: childEnvironment,
      });
    } catch {
      rejectReady(fail("dashboard daemon could not start"));
      return;
    }
    if (
      !child || typeof child.once !== "function" || typeof child.removeListener !== "function" ||
      typeof child.disconnect !== "function" || typeof child.unref !== "function"
    ) {
      settle(fail("dashboard daemon could not start"));
      return;
    }
    child.once("message", onMessage);
    child.once("error", onError);
    child.once("exit", onExit);
    child.once("disconnect", onDisconnect);
    timer = setTimeout(
      () => settle(fail("dashboard daemon readiness timed out")),
      startupTimeoutMs,
    );
  });
}

function runtimeOptions(options = {}) {
  const resolved = {
    env: options.env ?? process.env,
    homeDirectory: options.homeDirectory ?? homedir(),
    fileSystem: options.fileSystem ?? defaultFileSystem,
    platform: options.platform ?? process.platform,
    lockDownPath: options.lockDownPath ?? lockDownLocalPath,
    getProcessIdentity: options.getProcessIdentity ?? getLocalProcessIdentity,
    fetchImpl: options.fetchImpl ?? fetch,
    requestTimeoutMs: options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS,
    getUid: options.getUid ?? process.getuid?.bind(process),
    now: options.now ?? Date.now,
  };
  validateAdapters(resolved);
  if (typeof resolved.now !== "function") {
    throw new TypeError("The local dashboard control adapter is invalid.");
  }
  resolved.expectedUid = currentUid(resolved.platform, resolved.getUid);
  return resolved;
}

/** Ensure the browser handoff parent exists beneath Relmio's verified private root. */
export async function ensureLocalDashboardBrowserLaunchRoot(options = {}) {
  const runtime = runtimeOptions(options);
  const paths = await ensureManagedControlRoot(runtime);
  return await ensurePrivateBrowserLaunchRoot({ paths, ...runtime });
}

async function inspectRuntime(options) {
  return inspectInternal({
    env: options.env,
    homeDirectory: options.homeDirectory,
    fileSystem: options.fileSystem,
    platform: options.platform,
    lockDownPath: options.lockDownPath,
    expectedUid: options.expectedUid,
    getProcessIdentity: options.getProcessIdentity,
    fetchImpl: options.fetchImpl,
    requestTimeoutMs: options.requestTimeoutMs,
  });
}

async function recoverStaleRuntime(options) {
  let releaseLock;
  let result;
  let failure;
  try {
    const paths = await resolveControlPaths(options);
    releaseLock = await acquireLocalIntegrationLifecycleLock({
      fileSystem: options.fileSystem,
      getProcessIdentity: options.getProcessIdentity,
      lockDownPath: options.lockDownPath,
      lockPath: paths.lockPath,
      now: options.now,
      platform: options.platform,
      label: "local dashboard lifetime lock",
    });
    const current = await inspectRuntime(options);
    if (
      current.state === "dead" || current.state === "pid-reused" ||
      current.state === "incomplete" || current.state === "publishing" ||
      current.state === "retiring"
    ) {
      await removeExactControlState(current, {
        fileSystem: options.fileSystem,
        platform: options.platform,
        lockDownPath: options.lockDownPath,
        expectedUid: options.expectedUid,
      });
      result = "recovered";
    } else if (current.state === "absent") {
      result = "absent";
    } else {
      throw fail("refuses to replace active, unresponsive, or ambiguous dashboard state");
    }
  } catch (error) {
    failure = error;
  }
  try { await releaseLock?.(); } catch (error) { failure ??= error; }
  if (failure) throw failure;
  return result;
}

/** Start the persistent dashboard, returning only non-secret status metadata. */
export async function startLocalDashboardControlPlane(options = {}) {
  const runtime = runtimeOptions(options);
  const spawnDaemon = options.spawnDaemon ?? spawnLocalDashboardDaemon;
  if (typeof spawnDaemon !== "function") {
    throw new TypeError("The local dashboard control adapter is invalid.");
  }
  let current = await inspectRuntime(runtime);
  if (current.state === "healthy") return safeResult("existing", current.publication);
  if (current.state === "version-mismatch") {
    throw fail("found a dashboard from another Relmio version; run relmio stop, then retry");
  }
  if (current.state === "ambiguous" || current.state === "unresponsive") {
    throw fail(`refuses ${current.state} local dashboard state`);
  }
  if (
    current.state === "dead" || current.state === "pid-reused" ||
    current.state === "incomplete" || current.state === "publishing" ||
    current.state === "retiring"
  ) {
    await recoverStaleRuntime(runtime);
  }
  const spawnOptions = { environment: runtime.env };
  for (const name of ["execPath", "cliPath", "spawnProcess", "startupTimeoutMs"]) {
    if (options[name] !== undefined) spawnOptions[name] = options[name];
  }
  try {
    await spawnDaemon(spawnOptions);
  } catch (error) {
    current = await inspectRuntime(runtime);
    if (current.state === "healthy") return safeResult("existing", current.publication);
    throw error;
  }
  current = await inspectRuntime(runtime);
  if (current.state !== "healthy") {
    throw fail("could not verify the dashboard daemon after readiness");
  }
  return safeResult("started", current.publication);
}

/** Re-read the protected browser capability immediately before opening it. */
export async function readLocalDashboardBrowserUrl(options = {}) {
  const runtime = runtimeOptions(options);
  const route = options.route ?? "/local";
  if (!["/", "/assistant", "/local"].includes(route)) {
    throw new TypeError("Relmio dashboard route is invalid.");
  }
  const current = await inspectRuntime(runtime);
  if (current.state !== "healthy") {
    throw fail("cannot open a dashboard that is not healthy");
  }
  let response;
  try {
    response = await fetchJson(
      runtime.fetchImpl,
      `${current.publication.origin}${BROWSER_PREPARE_PATH}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Origin": current.publication.origin,
          "X-Setup-Token": current.browserKeyRecord.raw,
        },
        body: JSON.stringify({ route }),
      },
      runtime.requestTimeoutMs,
      201,
    );
  } catch {
    throw fail("could not prepare a private dashboard browser launch");
  }
  if (
    !exactKeys(response, ["launchUrl"]) ||
    !isPrivateBrowserLaunchUrl(response.launchUrl)
  ) {
    throw fail("received an invalid private dashboard browser launch");
  }
  return response.launchUrl;
}

function exactStopResponse(value, publication) {
  return exactKeys(value, ["instanceId", "stopping"]) &&
    value.stopping === true && value.instanceId === publication.instanceId;
}

function defaultSleep(milliseconds) {
  return new Promise((resolveSleep) => {
    setTimeout(resolveSleep, milliseconds);
  });
}

/** Stop only the exact authenticated daemon; never fall back to a PID kill. */
export async function stopLocalDashboardControlPlane(options = {}) {
  const runtime = runtimeOptions(options);
  const sleep = options.sleep ?? defaultSleep;
  const stopChecks = options.stopChecks ?? 100;
  const stopPollMs = options.stopPollMs ?? 50;
  if (
    typeof sleep !== "function" || !Number.isSafeInteger(stopChecks) || stopChecks < 1 || stopChecks > 1_000 ||
    !Number.isSafeInteger(stopPollMs) || stopPollMs < 0 || stopPollMs > 1_000
  ) throw new TypeError("The local dashboard stop adapter is invalid.");

  let current = await inspectRuntime(runtime);
  if (current.state === "absent") return Object.freeze({ state: "absent" });
  if (
    current.state === "dead" || current.state === "pid-reused" ||
    current.state === "incomplete" || current.state === "publishing" ||
    current.state === "retiring"
  ) {
    await recoverStaleRuntime(runtime);
    return Object.freeze({ state: "stopped" });
  }
  if (current.state !== "healthy" && current.state !== "version-mismatch") {
    throw fail(`refuses to stop ${current.state} local dashboard state`);
  }
  const targetInstanceId = current.publication.instanceId;
  let response;
  try {
    response = await fetchStopResponse(
      runtime.fetchImpl,
      `${current.publication.origin}${STOP_PATH}`,
      {
        method: "POST",
        headers: { "X-Relmio-Control": current.controlKeyRecord.raw },
      },
      runtime.requestTimeoutMs,
    );
  } catch {
    throw fail("could not authenticate a dashboard stop request");
  }
  if (response.state === "busy") {
    throw fail("dashboard is busy; wait for active work to finish, then retry");
  }
  if (response.state !== "accepted" || !exactStopResponse(response.value, current.publication)) {
    throw fail("refuses an invalid dashboard stop response");
  }

  for (let check = 0; check < stopChecks; check += 1) {
    current = await inspectRuntime(runtime);
    if (current.state === "absent") return Object.freeze({ state: "stopped" });
    if (current.state === "retiring" || current.state === "incomplete") {
      const retiringInstanceId = current.descriptor?.instanceId;
      if (retiringInstanceId && retiringInstanceId !== targetInstanceId) {
        throw fail("refuses to follow a replaced dashboard during stop");
      }
      if (check + 1 < stopChecks) await sleep(stopPollMs);
      continue;
    }
    if (current.instanceId !== targetInstanceId) {
      throw fail("refuses to follow a replaced dashboard during stop");
    }
    if (current.state === "dead" || current.state === "pid-reused") {
      await recoverStaleRuntime(runtime);
      return Object.freeze({ state: "stopped" });
    }
    if (current.state === "ambiguous") {
      throw fail("could not verify dashboard identity during stop");
    }
    if (check + 1 < stopChecks) await sleep(stopPollMs);
  }
  throw fail("dashboard stop timed out while the exact process remained active");
}

export const LOCAL_DASHBOARD_CONTROL_PATHS = Object.freeze({
  browserPrepare: BROWSER_PREPARE_PATH,
  health: HEALTH_PATH,
  stop: STOP_PATH,
});

export const LOCAL_DASHBOARD_DAEMON_COMMAND = PRIVATE_DAEMON_COMMAND;

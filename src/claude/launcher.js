import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants, lstatSync, readdirSync, realpathSync } from "node:fs";
import { lstat, mkdir, open, readdir, realpath, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { COMPANION_HOST, startClaudeChatGateway } from "../gateway/claude-chat.js";

export const CANDIDATE_VERSION = "2.1.317";
export const MAX_QUALIFICATION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_CONFIG_BYTES = 16 * 1024;
const SHA256 = /^[a-f0-9]{64}$/u;
const MODEL = /^claude-[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const QUALIFICATION_CHECKS = [
  "officialBinaryReviewed", "effectivePolicyReviewed",
  "nativeAuthAndBillingReviewed", "policyChangesControlled",
];
const SAFE_CODES = new Set([
  "launch_config_invalid", "runtime_unqualified", "unsafe_runtime_path",
  "binary_pin_mismatch", "account_locked", "runtime_changed",
  "launch_cancelled", "launch_failed", "cleanup_failed",
]);

function refusal(code) {
  return Object.assign(new Error(`Claude launcher refused (${code}).`), { code });
}

function hasKeys(value, required, optional = []) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    required.every((key) => Object.hasOwn(value, key)) &&
    Object.keys(value).every((key) => required.includes(key) || optional.includes(key));
}

// 1 to 8 unique exact IDs. Fable is refused because `claude -p` can bill its usage credits without asking.
export const MODEL_RULES = "Use 1 to 8 unique model IDs such as claude-sonnet-5-5. Fable models are refused.";
export function validModels(models) {
  return Array.isArray(models) && models.length >= 1 && models.length <= 8 &&
    new Set(models).size === models.length &&
    models.every((model) => typeof model === "string" && model.length <= 128 &&
      MODEL.test(model) && !model.includes("fable"));
}

function absolutePath(value) {
  return typeof value === "string" && value.length > 1 && value.length <= 4096 &&
    !/[\0\r\n]/u.test(value) && isAbsolute(value) && resolve(value) === value;
}

function inside(parent, path) {
  const child = relative(parent, path);
  return child === "" || (child !== ".." && !child.startsWith(`..${sep}`) && !isAbsolute(child));
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino && left.size === right.size &&
    left.mtimeMs === right.mtimeMs && left.ctimeMs === right.ctimeMs &&
    left.mode === right.mode && left.uid === right.uid && left.nlink === right.nlink;
}

export function privateDirectory(metadata, readOnly = false) {
  return metadata.isDirectory() && !metadata.isSymbolicLink() &&
    metadata.uid === process.getuid() && (metadata.mode & 0o077) === 0 &&
    (!readOnly || (metadata.mode & 0o222) === 0);
}

async function assertParents(path) {
  for (let parent = dirname(path);; parent = dirname(parent)) {
    const metadata = await lstat(parent);
    if (!metadata.isDirectory() || await realpath(parent) !== parent ||
      ![0, process.getuid()].includes(metadata.uid) ||
      ((metadata.mode & 0o022) !== 0 && !(metadata.uid === 0 && (metadata.mode & 0o1000) !== 0))) {
      throw refusal("unsafe_runtime_path");
    }
    if (dirname(parent) === parent) return;
  }
}

async function ensureDirectory(path, readOnly = false) {
  try {
    await mkdir(path, { mode: readOnly ? 0o500 : 0o700 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw refusal("unsafe_runtime_path");
  }
  const metadata = await lstat(path);
  if (!privateDirectory(metadata, readOnly) || await realpath(path) !== path) {
    throw refusal("unsafe_runtime_path");
  }
  return metadata;
}

async function readConfiguration(path) {
  if (!absolutePath(path) || await realpath(path) !== path) throw refusal("launch_config_invalid");
  await assertParents(path);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    // Root-owned is as trusted as self-owned (Docker bind mounts on macOS present files as root).
    if (!before.isFile() || ![0, process.getuid()].includes(before.uid) || before.nlink !== 1 ||
      (before.mode & 0o077) !== 0 || before.size > MAX_CONFIG_BYTES) {
      throw refusal("launch_config_invalid");
    }
    const bytes = Buffer.alloc(MAX_CONFIG_BYTES + 1);
    const { bytesRead } = await file.read(bytes, 0, bytes.length, 0);
    if (bytesRead > MAX_CONFIG_BYTES || bytesRead !== before.size || !sameFile(before, await file.stat())) {
      throw refusal("launch_config_invalid");
    }
    return {
      config: JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, bytesRead))),
      identity: before,
    };
  } catch {
    throw refusal("launch_config_invalid");
  } finally {
    await file.close();
  }
}

// The hash is not secret, but whoever can replace this file can admit their own key.
export async function readKeyHashFile(path) {
  let file;
  try {
    if (absolutePath(path) && await realpath(path) === path) {
      await assertParents(path);
      file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      const metadata = await file.stat();
      if (metadata.isFile() && [0, process.getuid()].includes(metadata.uid) && metadata.nlink === 1 &&
        (metadata.mode & 0o077) === 0 && metadata.size <= 65) {
        const match = /^([a-f0-9]{64})\n?$/u.exec(await file.readFile("utf8"));
        if (match) return match[1];
      }
    }
  } catch {
    // Every unreadable or unsafe file gets the same fixed refusal.
  } finally {
    await file?.close();
  }
  throw refusal("launch_config_invalid");
}

function assertQualification(qualification, runtime, digest, now) {
  const runtimeScope = { ...runtime, executableSha256: digest };
  if (!hasKeys(qualification, ["reviewedBy", "reviewedAt", "expiresAt", "runtime", ...QUALIFICATION_CHECKS]) ||
    typeof qualification.reviewedBy !== "string" || qualification.reviewedBy.trim().length === 0 ||
    qualification.reviewedBy.length > 128 || /[\0\r\n]/u.test(qualification.reviewedBy) ||
    QUALIFICATION_CHECKS.some((key) => qualification[key] !== true) ||
    !hasKeys(qualification.runtime, Object.keys(runtimeScope)) ||
    Object.entries(runtimeScope).some(([key, value]) => key !== "models" && qualification.runtime[key] !== value) ||
    !Array.isArray(qualification.runtime.models) || qualification.runtime.models.length !== runtime.models.length ||
    runtime.models.some((model, index) => qualification.runtime.models[index] !== model)) {
    throw refusal("runtime_unqualified");
  }
  const reviewedAt = Date.parse(qualification.reviewedAt);
  const expiresAt = Date.parse(qualification.expiresAt);
  if (typeof qualification.reviewedAt !== "string" || typeof qualification.expiresAt !== "string" ||
    !Number.isFinite(reviewedAt) || !Number.isFinite(expiresAt) ||
    new Date(reviewedAt).toISOString() !== qualification.reviewedAt ||
    new Date(expiresAt).toISOString() !== qualification.expiresAt ||
    reviewedAt > now || expiresAt <= now || expiresAt <= reviewedAt ||
    expiresAt - reviewedAt > MAX_QUALIFICATION_MS) {
    throw refusal("runtime_unqualified");
  }
}

// Offline SHA256 of the reviewed executable after the same file checks the launcher pins.
export async function hashExecutable(path) {
  if (await realpath(path) !== path) throw refusal("unsafe_runtime_path");
  await assertParents(path);
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await file.stat();
    if (!before.isFile() || before.nlink !== 1 || before.size === 0 ||
      ![0, process.getuid()].includes(before.uid) || (before.mode & 0o022) !== 0 ||
      (before.mode & 0o111) === 0) throw refusal("unsafe_runtime_path");
    const hash = createHash("sha256");
    const bytes = Buffer.alloc(64 * 1024);
    for (;;) {
      const { bytesRead } = await file.read(bytes, 0, bytes.length, null);
      if (bytesRead === 0) break;
      hash.update(bytes.subarray(0, bytesRead));
    }
    if (!sameFile(before, await file.stat())) throw refusal("binary_pin_mismatch");
    return { identity: before, digest: hash.digest("hex") };
  } finally {
    await file.close();
  }
}

async function pinExecutable(path, digest) {
  const { identity, digest: actual } = await hashExecutable(path);
  if (actual !== digest) throw refusal("binary_pin_mismatch");
  return identity;
}

// The account root may not sit inside the installed package or checkout, contain it, or contain the owner's home.
export async function unsafeAccountRoot(accountRoot, personalHome) {
  const packageRoot = await realpath(fileURLToPath(new URL("../..", import.meta.url)));
  return inside(packageRoot, accountRoot) || inside(accountRoot, packageRoot) || inside(accountRoot, personalHome);
}

async function acquireAccountLock(accountRoot) {
  const lockPath = join(accountRoot, ".relmio-claude.lock");
  let file;
  try {
    file = await open(lockPath, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
  } catch (error) {
    throw refusal(error?.code === "EEXIST" ? "account_locked" : "unsafe_runtime_path");
  }
  let identity;
  try {
    identity = await file.stat();
    await file.writeFile(`${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`);
    await file.sync();
  } catch {
    // An incomplete claim stays locked; never guess whether an earlier owner died.
    throw refusal("account_locked");
  } finally {
    // O_EXCL protects the pathname; retaining an open descriptor adds no lock.
    await file.close();
  }
  const ownsClaim = (current) => current.isFile() && current.dev === identity.dev &&
    current.ino === identity.ino && current.nlink === 1 && current.uid === process.getuid() &&
    (current.mode & 0o077) === 0;
  return {
    assertHeld() {
      if (!ownsClaim(lstatSync(lockPath))) throw refusal("runtime_changed");
    },
    async release() {
      if (!ownsClaim(await lstat(lockPath))) throw refusal("cleanup_failed");
      await unlink(lockPath);
    },
  };
}

/**
 * Qualification is an explicit owner assertion, not automatic policy inspection.
 * It must cover endpoint/drop-in/MDM/cloud/cache policy, managed MCP, even shadowed
 * policyHelper, custom auth/cloud/telemetry executables, managed hooks, env/model
 * overrides, native subscription auth and account/model extra-usage controls.
 * Those sources can change after review. Keep them controlled; requalify changes.
 * This code never opens native credentials or dedicated native config contents.
 */
export async function runClaudeChat({
  env = process.env,
  argv = [],
  startGateway = startClaudeChatGateway,
  signalTarget = process,
  now = Date.now,
  log = console.log,
  logError = console.error,
} = {}) {
  let releaseLock;
  let gatewayPromise;
  let closePromise;
  let signalReceived = false;

  function close() {
    if (closePromise) return closePromise;
    closePromise = (async () => {
      try {
        // A failed listener startup never starts a native request.
        const gateway = await gatewayPromise?.catch(() => null);
        await gateway?.close();
        if (releaseLock) await releaseLock();
      } catch {
        // Failed reap or changed claim deliberately retains the account lock.
        throw refusal("cleanup_failed");
      } finally {
        signalTarget.removeListener("SIGINT", onSignal);
        signalTarget.removeListener("SIGTERM", onSignal);
      }
    })();
    return closePromise;
  }

  function onSignal() {
    signalReceived = true;
    void close().catch(() => {
      signalTarget.exitCode = 1;
      logError("Claude shutdown failed (cleanup_failed); account lock retained.");
    });
  }

  try {
    if (process.platform !== "darwin" && process.platform !== "linux") throw refusal("unsafe_runtime_path");
    if (!Array.isArray(argv) || argv.length !== 0 || !SHA256.test(env.RELMIO_CLAUDE_CHAT_TOKEN_SHA256 ?? "")) {
      throw refusal("launch_config_invalid");
    }
    const { config, identity: configIdentity } = await readConfiguration(env.RELMIO_CLAUDE_LAUNCH_CONFIG);
    if (!hasKeys(config, ["schemaVersion", "accountRoot", "executable", "executableSha256", "version", "models", "qualification"], ["port", "companionHost"]) ||
      config.schemaVersion !== 2 || !absolutePath(config.accountRoot) || !absolutePath(config.executable) ||
      !SHA256.test(config.executableSha256) || config.version !== CANDIDATE_VERSION ||
      !validModels(config.models) ||
      (config.port !== undefined && (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535)) ||
      (config.companionHost !== undefined && !(typeof config.companionHost === "string" && COMPANION_HOST.test(config.companionHost)))) {
      throw refusal("launch_config_invalid");
    }
    // Native Claude finds the macOS login Keychain through HOME, so it runs with the real home.
    // CLAUDE_CONFIG_DIR keeps its settings, state and Keychain entry separate from personal Claude.
    const personalHome = await realpath(homedir());
    const runtime = Object.freeze({
      executable: config.executable,
      cwd: join(config.accountRoot, "empty"),
      home: personalHome,
      configDir: join(config.accountRoot, "config"),
      version: config.version,
      models: Object.freeze(config.models),
    });
    assertQualification(config.qualification, runtime, config.executableSha256, now());
    if (await unsafeAccountRoot(config.accountRoot, personalHome) ||
      await realpath(dirname(config.accountRoot)) !== dirname(config.accountRoot)) {
      throw refusal("unsafe_runtime_path");
    }
    await assertParents(config.accountRoot);
    const executableIdentity = await pinExecutable(runtime.executable, config.executableSha256);
    const rootIdentity = await ensureDirectory(config.accountRoot);
    const accountLock = await acquireAccountLock(config.accountRoot);
    releaseLock = () => accountLock.release();
    const directories = new Map([[config.accountRoot, rootIdentity]]);
    for (const path of [runtime.configDir, runtime.cwd]) {
      directories.set(path, await ensureDirectory(path, path === runtime.cwd));
    }
    if ((await readdir(runtime.cwd)).length !== 0) throw refusal("unsafe_runtime_path");

    const spawnQualified = (executable, args, options) => {
      assertQualification(config.qualification, runtime, config.executableSha256, now());
      try {
        accountLock.assertHeld();
        if (!sameFile(configIdentity, lstatSync(env.RELMIO_CLAUDE_LAUNCH_CONFIG)) ||
          realpathSync(env.RELMIO_CLAUDE_LAUNCH_CONFIG) !== env.RELMIO_CLAUDE_LAUNCH_CONFIG ||
          executable !== runtime.executable || realpathSync(executable) !== executable ||
          !sameFile(executableIdentity, lstatSync(executable))) throw refusal("runtime_changed");
        for (const [path, identity] of directories) {
          const current = lstatSync(path);
          if (!privateDirectory(current, path === runtime.cwd) || current.dev !== identity.dev ||
            current.ino !== identity.ino || current.mode !== identity.mode || realpathSync(path) !== path) {
            throw refusal("runtime_changed");
          }
        }
        if (readdirSync(runtime.cwd).length !== 0) throw refusal("runtime_changed");
      } catch {
        throw refusal("runtime_changed");
      }
      return spawn(executable, args, options);
    };
    gatewayPromise = Promise.resolve().then(() => startGateway({
      runtime,
      tokenVerifier: Buffer.from(env.RELMIO_CLAUDE_CHAT_TOKEN_SHA256, "hex"),
      port: config.port ?? 14502,
      companionHost: config.companionHost,
      spawnProcess: spawnQualified,
    }));
    signalTarget.once("SIGINT", onSignal);
    signalTarget.once("SIGTERM", onSignal);
    const gateway = await gatewayPromise;
    if (signalReceived) {
      await close();
      throw refusal("launch_cancelled");
    }
    log(`Claude prompt adapter listening at ${gateway.origin}; provider readiness not probed.`);
    return Object.freeze({ origin: gateway.origin, close });
  } catch (error) {
    await close();
    throw refusal(SAFE_CODES.has(error?.code) ? error.code : "launch_failed");
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  try {
    await runClaudeChat({ argv: process.argv.slice(2) });
  } catch (error) {
    console.error(`Claude launcher refused (${SAFE_CODES.has(error?.code) ? error.code : "launch_failed"}).`);
    process.exitCode = 1;
  }
}

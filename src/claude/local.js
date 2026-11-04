// Owner-run native setup. One private folder holds the dedicated Claude account root (`account/`),
// launch.json, key.sha256 and, until the owner deletes it, n8n-api-key.txt.
// init only creates the account layout so the owner can sign in first; prepare writes the approval
// after the owner's answers. Neither runs Claude or reads its login.
import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, readdir, realpath, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";

import {
  CANDIDATE_VERSION, MAX_QUALIFICATION_MS, MODEL_RULES, hashExecutable, privateDirectory, readKeyHashFile,
  unsafeAccountRoot, validModels,
} from "./launcher.js";

export const MAX_APPROVAL_HOURS = MAX_QUALIFICATION_MS / 3_600_000;
const FOLDER_ENTRIES = new Set(["account", "launch.json", "key.sha256", "n8n-api-key.txt"]);
// A staging file left by an interrupted renewal; the next renewal writes a new one and renames it.
const STAGING_ENTRY = /^\.launch-[0-9a-f]{32}\.json$/u;

async function inspectFolder(directory) {
  const path = resolve(directory);
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    // A new folder needs an existing parent, so its canonical path is known before anything is created.
    const parent = await realpath(dirname(path)).catch(() => {
      throw new Error(`Create the parent folder of ${path} first.`);
    });
    return { root: join(parent, basename(path)), entries: null };
  }
  if (!privateDirectory(metadata)) throw new Error(`${path} must be a private folder you own (mode 0700).`);
  const entries = await readdir(path);
  if (entries.some((name) => !FOLDER_ENTRIES.has(name) && !STAGING_ENTRY.test(name))) {
    throw new Error(`${path} must be empty or a folder created by relmio claude local init.`);
  }
  return { root: await realpath(path), entries };
}

async function accountPaths(root) {
  const home = await realpath(homedir());
  const accountRoot = join(root, "account");
  if (await unsafeAccountRoot(accountRoot, home)) {
    throw new Error(`${root} must be outside the Relmio package and must not contain your home folder.`);
  }
  return { home, accountRoot };
}
async function requirePrivateDirectory(path, { create = false, readOnly = false } = {}) {
  if (create) {
    try {
      await mkdir(path, { mode: readOnly ? 0o500 : 0o700 });
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  }
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error(`Run relmio claude local init and sign in before using ${path}.`);
    throw error;
  }
  // Same lstat/realpath/owner/mode rules as the launcher. A link fails closed before any child is created.
  if (!privateDirectory(metadata, readOnly) || await realpath(path) !== path) {
    throw new Error(`${path} must be a private${readOnly ? " read-only" : ""} folder you own, not a link.`);
  }
}

async function requireAccountLayout(accountRoot, { create }) {
  await requirePrivateDirectory(accountRoot, { create });
  const empty = join(accountRoot, "empty");
  await requirePrivateDirectory(join(accountRoot, "config"), { create });
  await requirePrivateDirectory(empty, { create, readOnly: true });
  if ((await readdir(empty)).length !== 0) throw new Error(`${empty} must be empty.`);
}


async function inspectExecutable(executable) {
  try {
    const path = await realpath(resolve(executable));
    return { executable: path, executableSha256: (await hashExecutable(path)).digest };
  } catch {
    throw new Error(
      `${executable} must be the Claude Code executable: a regular file owned by you or root that others cannot change.`,
    );
  }
}

export async function initLocalClaude({ directory, executable }) {
  const { root, entries } = await inspectFolder(directory);
  const { home, accountRoot } = await accountPaths(root);
  const binary = await inspectExecutable(executable);
  if (entries === null) await mkdir(root, { mode: 0o700 });
  // Checked before descending or reporting success: private canonical account/config, read-only empty cwd.
  await requireAccountLayout(accountRoot, { create: true });
  return { directory: root, accountRoot, home, ...binary };
}

// `confirm` receives the review summary and resolves true only after the owner confirmed every item.
export async function prepareLocalClaude({
  directory, executable, models, hours = 1, confirm, now = Date.now, write = writeFile,
}) {
  if (!validModels(models)) throw new Error(MODEL_RULES);
  if (!Number.isInteger(hours) || hours < 1 || hours > MAX_APPROVAL_HOURS) {
    throw new Error(`Approval hours must be a whole number from 1 to ${MAX_APPROVAL_HOURS}.`);
  }
  const { root, entries } = await inspectFolder(directory);
  if (!entries?.includes("account")) throw new Error(`Run relmio claude local init for ${root} and sign in first.`);
  const { home, accountRoot } = await accountPaths(root);
  await requireAccountLayout(accountRoot, { create: false });
  const binary = await inspectExecutable(executable);
  const keyHashPath = join(root, "key.sha256");
  const renewing = entries.includes("key.sha256");
  if (renewing) {
    await readKeyHashFile(keyHashPath).catch(() => {
      throw new Error(`${keyHashPath} is not a private key hash. Move it away to create a new access key.`);
    });
  }
  if (await confirm({ directory: root, ...binary, version: CANDIDATE_VERSION, models, hours }) !== true) return null;
  await requireAccountLayout(accountRoot, { create: false });

  const secret = { mode: 0o600, flag: "wx" };
  let keyPath = null;
  if (!renewing) {
    const key = randomBytes(32).toString("base64url");
    keyPath = join(root, "n8n-api-key.txt");
    await writeFile(keyPath, `${key}\n`, secret);
    await writeFile(keyHashPath, `${createHash("sha256").update(key).digest("hex")}\n`, secret);
  }
  const reviewedAt = now();
  const expiresAt = new Date(reviewedAt + hours * 3_600_000).toISOString();
  const runtime = {
    executable: binary.executable, executableSha256: binary.executableSha256, version: CANDIDATE_VERSION, models, home,
    configDir: join(accountRoot, "config"), cwd: join(accountRoot, "empty"),
  };
  const config = {
    schemaVersion: 2, accountRoot, executable: binary.executable, executableSha256: binary.executableSha256,
    version: CANDIDATE_VERSION, models,
    qualification: {
      reviewedBy: "owner", reviewedAt: new Date(reviewedAt).toISOString(), expiresAt,
      officialBinaryReviewed: true, effectivePolicyReviewed: true, nativeAuthAndBillingReviewed: true, policyChangesControlled: true,
      runtime,
    },
  };
  // Replace rather than rewrite in place: a running launcher then refuses later prompts until restarted.
  const launchPath = join(root, "launch.json");
  const stagingPath = join(root, `.launch-${randomBytes(16).toString("hex")}.json`);
  try {
    await write(stagingPath, `${JSON.stringify(config, null, 2)}\n`, secret);
    await rename(stagingPath, launchPath);
  } catch (error) {
    if (error?.code !== "EEXIST") await rm(stagingPath, { force: true });
    throw error;
  }
  return { directory: root, launchPath, keyHashPath, keyPath, expiresAt };
}

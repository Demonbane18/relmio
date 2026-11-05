// Builds the owner-only Claude companion bundle for one Docker host: the build context plus
// .env (network, platform and key hash) and launch.json (approval just under seven days).
// The builders are pure: the CLI, the VPS wizard and the local wizard decide where the files go.
// `relmio claude companion prepare` writes nothing, not even the output folder, until the owner
// confirms every review item; launch.json records those answers, Relmio does not check them.
import { createHash, randomBytes } from "node:crypto";
import { lstat, mkdir, open, readFile, readdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

import { CANDIDATE_VERSION, MAX_QUALIFICATION_MS, MODEL_RULES, privateDirectory, validModels } from "./launcher.js";

export const CLAUDE_COMPANION = Object.freeze({
  alias: "relmio-claude", port: 14502, endpoint: "http://relmio-claude:14502/v1", project: "relmio-claude",
});
const NETWORK = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u;
const KEY = /^[A-Za-z0-9_-]{43}$/u;
const SAFE_STATUS_VALUE = /^[A-Za-z0-9_.:-]{1,64}$/u;
const MAX_STATUS_BYTES = 64 * 1024;
// Official Linux checksums from https://downloads.claude.ai/claude-code-releases/2.1.317/manifest.json.
// The image pins one executable path; the launcher pins whichever binary the Dockerfile verified.
const TARGETS = Object.freeze({
  amd64: { platform: "linux-x64", executableSha256: "eb224419e344575faa4a1f39b290b649425a10cd5ee2ef1d003480cd9ae57eb0" },
  arm64: { platform: "linux-arm64", executableSha256: "563a0d60ad0c223d9415768210997acb0f7134ea51dc3c238e88bc2e18ddeefa" },
});
const EXECUTABLE = `/opt/claude/${CANDIDATE_VERSION}/claude`;
const PACKAGE_JSON = '{\n  "name": "relmio-claude-companion",\n  "private": true,\n  "type": "module"\n}\n';
// Bundle path -> packaged source. The image copies app/ with these modes, so they must stay world-readable.
const SOURCES = Object.freeze([
  ["Dockerfile", "../templates/claude-companion/Dockerfile"],
  ["compose.yml", "../templates/claude-companion/compose.yml"],
  ["login.sh", "../templates/claude-companion/login.sh"],
  ["renew.sh", "../templates/claude-companion/renew.sh"],
  ["app/src/gateway/claude-chat.js", "../gateway/claude-chat.js"],
  ["app/src/claude/launcher.js", "./launcher.js"],
]);
const packaged = (path) => fileURLToPath(new URL(path, import.meta.url));
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

// `uname -m` on a VPS or `docker info --format {{.Architecture}}` locally.
export function claudeArchFromMachine(text) {
  const machine = typeof text === "string" ? text.trim() : "";
  if (machine === "x86_64") return "amd64";
  if (machine === "aarch64" || machine === "arm64") return "arm64";
  throw new Error("This Docker host is not amd64 (x86_64) or arm64 (aarch64), so the Claude companion cannot run on it.");
}

// The pinned official binary for one architecture, shown to the owner before any review answer.
export function claudeCompanionPin(arch) {
  if (typeof arch !== "string" || !Object.hasOwn(TARGETS, arch)) throw new Error("The architecture must be amd64 or arm64.");
  const { platform, executableSha256 } = TARGETS[arch];
  return { arch, platform, executable: EXECUTABLE, executableSha256, version: CANDIDATE_VERSION };
}

// The pinned binary the owner reviews before any bundle exists. Throws on any invalid input.
export function reviewClaudeCompanion({ network, arch, models }) {
  if (typeof network !== "string" || !NETWORK.test(network)) {
    throw new Error("The Docker network name must be 1 to 128 letters, digits, '.', '_' or '-', starting with a letter or digit.");
  }
  const pin = claudeCompanionPin(arch);
  if (!validModels(models)) throw new Error(MODEL_RULES);
  return { network, ...pin, models: [...models] };
}

function companionLaunchConfig(arch, models, time) {
  if (!Number.isFinite(time)) throw new TypeError("The approval time is invalid.");
  const { executableSha256 } = TARGETS[arch];
  return {
    schemaVersion: 2, accountRoot: "/data/account", executable: EXECUTABLE, executableSha256, version: CANDIDATE_VERSION,
    models: [...models], companionHost: CLAUDE_COMPANION.alias, port: CLAUDE_COMPANION.port,
    qualification: {
      reviewedBy: "owner", reviewedAt: new Date(time - 1000).toISOString(),
      expiresAt: new Date(time + MAX_QUALIFICATION_MS - 3600 * 1000).toISOString(),
      officialBinaryReviewed: true, effectivePolicyReviewed: true, nativeAuthAndBillingReviewed: true, policyChangesControlled: true,
      runtime: {
        executable: EXECUTABLE, executableSha256, version: CANDIDATE_VERSION, models: [...models], home: "/home/claude",
        configDir: "/data/account/config", cwd: "/data/account/empty",
      },
    },
  };
}

/**
 * Every bundle file with its contents and mode, paths relative to the bundle folder.
 * The access key is returned, never written into a file; .env holds only its hash.
 */
export async function buildClaudeCompanionBundle({ network, arch, models, now = Date.now, key = randomBytes(32).toString("base64url") }) {
  const review = reviewClaudeCompanion({ network, arch, models });
  if (typeof key !== "string" || !KEY.test(key)) throw new TypeError("The companion access key is invalid.");
  const keySha256 = sha256(key);
  const launchConfig = companionLaunchConfig(arch, review.models, now());
  const sources = await Promise.all(SOURCES.map(async ([path, source]) => ({
    path, contents: await readFile(packaged(source), "utf8"), mode: 0o644,
  })));
  const files = [
    ...sources,
    { path: "app/package.json", contents: PACKAGE_JSON, mode: 0o644 },
    { path: ".env", contents: `N8N_DOCKER_NETWORK=${network}\nRELMIO_PLATFORM=linux/${arch}\nRELMIO_CLAUDE_CHAT_TOKEN_SHA256=${keySha256}\n`, mode: 0o600 },
    { path: "launch.json", contents: `${JSON.stringify(launchConfig, null, 2)}\n`, mode: 0o600 },
  ];
  return { files, key, keySha256, launchConfig, expiresAt: launchConfig.qualification.expiresAt, review };
}

// A renewal changes only the two timestamps; anything else differing from the bundle's own config is refused.
export function renewClaudeLaunchConfig(config, now = Date.now) {
  const arch = Object.keys(TARGETS).find((name) => TARGETS[name].executableSha256 === config?.executableSha256);
  if (!arch || !validModels(config.models)) throw new TypeError("launch.json is not a Claude companion approval.");
  const renewed = companionLaunchConfig(arch, config.models, now());
  const scope = (value) => ({ ...value, qualification: { ...value.qualification, reviewedAt: null, expiresAt: null } });
  if (typeof config.qualification !== "object" || config.qualification === null || Array.isArray(config.qualification) ||
    !isDeepStrictEqual(scope(config), scope(renewed))) {
    throw new TypeError("launch.json is not a Claude companion approval.");
  }
  return renewed;
}

// Only these three fields ever leave `claude auth status --json`; email and organization never do.
export function parseClaudeAuthStatus(stdout) {
  let status = null;
  if (typeof stdout === "string" && Buffer.byteLength(stdout) <= MAX_STATUS_BYTES) {
    try { status = JSON.parse(stdout.trim()); } catch { /* Unreadable output counts as signed out. */ }
  }
  const field = (value) => (typeof value === "string" && SAFE_STATUS_VALUE.test(value) ? value : null);
  const object = status !== null && typeof status === "object" && !Array.isArray(status);
  return {
    loggedIn: object && status.loggedIn === true,
    authMethod: object ? field(status.authMethod) : null,
    subscriptionType: object ? field(status.subscriptionType) : null,
  };
}

// A missing folder is fine until it is created after confirmation.
async function assertEmptyOutput(out) {
  let metadata;
  try {
    metadata = await lstat(out);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (!privateDirectory(metadata)) throw new Error("The output folder must be a private folder you own (mode 0700).");
  if ((await readdir(out)).length) throw new Error("Output folder must be empty.");
}

// Exclusive create; the explicit chmod keeps the image's app files readable under a strict umask.
async function writeBundleFile(out, { path, contents, mode }) {
  const target = join(out, path);
  await mkdir(dirname(target), { recursive: true });
  const file = await open(target, "wx", mode);
  try {
    await file.chmod(mode);
    await file.writeFile(contents);
  } finally {
    await file.close();
  }
}

// `confirm` receives the review summary and resolves true only after the owner confirmed every item.
export async function prepareClaudeCompanion({ directory, network, arch = "amd64", models, confirm, now = Date.now }) {
  const review = reviewClaudeCompanion({ network, arch, models });
  const out = resolve(directory);
  await assertEmptyOutput(out);
  if (await confirm({ directory: out, ...review }) !== true) return null;
  const bundle = await buildClaudeCompanionBundle({ network, arch, models, now });
  await mkdir(out, { recursive: true, mode: 0o700 });
  await assertEmptyOutput(out);
  for (const file of bundle.files) await writeBundleFile(out, file);
  await writeBundleFile(out, { path: "n8n-api-key.txt", contents: `${bundle.key}\n`, mode: 0o600 });
  return { directory: out, network, arch, models, expiresAt: bundle.expiresAt };
}

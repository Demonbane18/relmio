// Prepares an owner-only Claude companion bundle for one Docker host: the build context plus
// .env (network, platform and key hash), launch.json (approval just under seven days) and n8n-api-key.txt.
// Nothing is written, not even the output folder, until the owner confirms every review item;
// launch.json records those answers, Relmio does not check them.
import { createHash, randomBytes } from "node:crypto";
import { copyFile, lstat, mkdir, readdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { CANDIDATE_VERSION, MAX_QUALIFICATION_MS, MODEL_RULES, privateDirectory, validModels } from "./launcher.js";

const NETWORK = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/u;
// Official Linux checksums from https://downloads.claude.ai/claude-code-releases/2.1.317/manifest.json.
// The image pins one executable path; the launcher pins whichever binary the Dockerfile verified.
const TARGETS = Object.freeze({
  amd64: { platform: "linux-x64", executableSha256: "eb224419e344575faa4a1f39b290b649425a10cd5ee2ef1d003480cd9ae57eb0" },
  arm64: { platform: "linux-arm64", executableSha256: "563a0d60ad0c223d9415768210997acb0f7134ea51dc3c238e88bc2e18ddeefa" },
});
const EXECUTABLE = `/opt/claude/${CANDIDATE_VERSION}/claude`;
const packaged = (path) => fileURLToPath(new URL(path, import.meta.url));

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

// `confirm` receives the review summary and resolves true only after the owner confirmed every item.
export async function prepareClaudeCompanion({ directory, network, arch = "amd64", models, confirm, now = Date.now }) {
  if (typeof network !== "string" || !NETWORK.test(network)) {
    throw new Error("The Docker network name must be 1 to 128 letters, digits, '.', '_' or '-', starting with a letter or digit.");
  }
  if (!Object.hasOwn(TARGETS, arch)) throw new Error("The architecture must be amd64 or arm64.");
  if (!validModels(models)) throw new Error(MODEL_RULES);
  const out = resolve(directory);
  await assertEmptyOutput(out);
  const { platform, executableSha256 } = TARGETS[arch];
  const review = { directory: out, network, platform, executable: EXECUTABLE, executableSha256, version: CANDIDATE_VERSION, models };
  if (await confirm(review) !== true) return null;
  await mkdir(out, { recursive: true, mode: 0o700 });
  await assertEmptyOutput(out);

  for (const file of ["Dockerfile", "compose.yml", "login.sh", "renew.sh"]) {
    await copyFile(packaged(`../templates/claude-companion/${file}`), join(out, file));
  }
  await mkdir(join(out, "app/src/gateway"), { recursive: true });
  await mkdir(join(out, "app/src/claude"), { recursive: true });
  await copyFile(packaged("../gateway/claude-chat.js"), join(out, "app/src/gateway/claude-chat.js"));
  await copyFile(packaged("./launcher.js"), join(out, "app/src/claude/launcher.js"));
  await writeFile(join(out, "app/package.json"), '{\n  "name": "relmio-claude-companion",\n  "private": true,\n  "type": "module"\n}\n');

  const secret = { mode: 0o600, flag: "wx" };
  const key = randomBytes(32).toString("base64url");
  await writeFile(join(out, "n8n-api-key.txt"), `${key}\n`, secret);
  await writeFile(join(out, ".env"),
    `N8N_DOCKER_NETWORK=${network}\nRELMIO_PLATFORM=linux/${arch}\nRELMIO_CLAUDE_CHAT_TOKEN_SHA256=${createHash("sha256").update(key).digest("hex")}\n`, secret);

  const time = now();
  const expiresAt = new Date(time + MAX_QUALIFICATION_MS - 3600 * 1000).toISOString();
  const config = {
    schemaVersion: 2, accountRoot: "/data/account", executable: EXECUTABLE, executableSha256, version: CANDIDATE_VERSION,
    models, companionHost: "relmio-claude", port: 14502,
    qualification: {
      reviewedBy: "owner", reviewedAt: new Date(time - 1000).toISOString(), expiresAt,
      officialBinaryReviewed: true, effectivePolicyReviewed: true, nativeAuthAndBillingReviewed: true, policyChangesControlled: true,
      runtime: {
        executable: EXECUTABLE, executableSha256, version: CANDIDATE_VERSION, models, home: "/home/claude",
        configDir: "/data/account/config", cwd: "/data/account/empty",
      },
    },
  };
  await writeFile(join(out, "launch.json"), `${JSON.stringify(config, null, 2)}\n`, secret);
  return { directory: out, network, arch, models, expiresAt };
}

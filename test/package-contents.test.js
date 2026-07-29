import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

const execFileAsync = promisify(execFile);
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const expectedPackedFiles = new Set([
  "CHANGELOG.md",
  "LICENSE",
  "README.md",
  "SPEC.md",
  "package.json",
  "docs/architecture.md",
  "docs/brand.md",
  "docs/images/brand/planrelay-concept-source.png",
  "docs/images/brand/planrelay-mark.svg",
  "docs/images/setup/01-local-sign-in-ready.png",
  "docs/images/setup/02-vps-identity-confirmed.png",
  "docs/images/setup/03-n8n-detected.png",
  "docs/images/setup/04-install-plan.png",
  "docs/images/setup/05-bridge-ready.png",
  "docs/maintenance.md",
  "docs/manual-install.md",
  "docs/n8n-configuration.md",
  "docs/npm-publish.md",
  "docs/security.md",
  "docs/troubleshooting.md",
  "docs/video-outline.md",
  "scripts/check-release-metadata.js",
  "scripts/check-syntax.js",
  "scripts/preview.js",
  "src/cli.js",
  "src/domain/safety.js",
  "src/domain/templates.js",
  "src/domain/validation.js",
  "src/infrastructure/ssh.js",
  "src/services/discovery.js",
  "src/services/installer.js",
  "src/services/oauth.js",
  "src/ui/app.js",
  "src/ui/index.html",
  "src/ui/styles.css",
  "src/ui/time.js",
  "src/web/server.js",
]);
const reviewedBinaryFiles = new Set(
  [...expectedPackedFiles].filter((path) => path.endsWith(".png")),
);
const forbiddenBasename =
  /^(?:\.env(?:\..*)?|auth\.json|credentials?\.json|.*\.(?:key|p12|pem|pfx|ppk))$/iu;
const textExtensions = new Set([
  "",
  ".css",
  ".html",
  ".js",
  ".json",
  ".md",
  ".svg",
  ".txt",
  ".yaml",
  ".yml",
]);
const forbiddenContent = [
  {
    label: "private key",
    pattern: /-----BEGIN (?:[A-Z]+ )?PRIVATE KEY-----/u,
  },
  {
    label: "npm access token",
    pattern: /\bnpm_[A-Za-z0-9]{20,}\b/u,
  },
  {
    label: "GitHub access token",
    pattern:
      /\b(?:gh[oprsu]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/u,
  },
  {
    label: "OpenAI secret key",
    pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/u,
  },
  {
    label: "live wizard session URL",
    pattern:
      /https?:\/\/(?:127\.0\.0\.1|localhost):\d+\/\?session=[A-Za-z0-9_-]{16,}/u,
  },
];

test("npm package contains only allowed files and every advertised local script", async (t) => {
  const cacheDirectory = await mkdtemp(join(tmpdir(), "npm-pack-cache-"));
  t.after(() => rm(cacheDirectory, { recursive: true, force: true }));

  const { stdout } = await execFileAsync(
    npmCommand,
    ["pack", "--dry-run", "--json", "--ignore-scripts"],
    {
      cwd: projectRoot,
      env: { ...process.env, npm_config_cache: cacheDirectory },
    },
  );
  const [packedPackage] = JSON.parse(stdout);
  const packedPaths = packedPackage.files.map(({ path }) => path).sort();

  assert.deepEqual(packedPaths, [...expectedPackedFiles].sort());
  assert.deepEqual(
    packedPaths.filter((path) => forbiddenBasename.test(path.split("/").at(-1))),
    [],
  );
  for (const path of packedPaths) {
    if (!textExtensions.has(extname(path))) {
      assert.ok(reviewedBinaryFiles.has(path), `unreviewed binary file: ${path}`);
      continue;
    }
    const contents = await readFile(join(projectRoot, path), "utf8");
    for (const { label, pattern } of forbiddenContent) {
      assert.doesNotMatch(contents, pattern, `${path} contains a ${label}`);
    }
  }
});

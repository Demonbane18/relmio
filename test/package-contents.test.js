import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import {
  buildNpmPackage,
  resolveNpmInvocation,
  stageNpmPackage,
} from "../scripts/build-npm-package.js";

const execFileAsync = promisify(execFile);
const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const expectedPackedFiles = new Set([
  "CHANGELOG.md",
  "LICENSE",
  "NOTICE",
  "README.md",
  "SPEC.md",
  "package.json",
  "docs/ai-assistant.md",
  "docs/architecture.md",
  "docs/brand.md",
  "docs/faq.md",
  "docs/getting-started.md",
  "docs/local-endpoints-spec.md",
  "docs/local-endpoints.md",
  "docs/images/brand/relmio-concept-source.png",
  "docs/images/brand/relmio-logo.png",
  "docs/images/brand/relmio-logo-rounded.svg",
  "docs/images/examples/gpt-56-ai-agent-luna-run.png",
  "docs/images/examples/gpt-56-ai-agent-sol-run.png",
  "docs/images/examples/gpt-56-ai-agent-workflow.png",
  "docs/images/examples/gpt-56-luna-chat-model-run.png",
  "docs/images/examples/gpt-56-model-selector.png",
  "docs/images/examples/gpt-56-sol-chat-model-run.png",
  "docs/images/examples/hosted-chat-connected.png",
  "docs/images/examples/n8n-openai-credential-connected.png",
  "docs/images/examples/sidecar-docker-containers-running.png",
  "docs/images/examples/telegram-model-results.png",
  "docs/images/examples/telegram-n8n-workflow-execution.png",
  "docs/images/setup/00-install-methods.png",
  "docs/images/setup/01-local-sign-in-ready.png",
  "docs/images/setup/02-vps-identity-confirmed.png",
  "docs/images/setup/03-n8n-detected.png",
  "docs/images/setup/04-install-plan.png",
  "docs/images/setup/05-bridge-ready.png",
  "docs/maintenance.md",
  "docs/manual-install.md",
  "docs/n8n-configuration.md",
  "docs/npm-publish.md",
  "docs/reference.md",
  "docs/roadmap.md",
  "docs/security.md",
  "docs/troubleshooting.md",
  "docs/video-outline.md",
  "docs/vps-and-n8n.md",
  "scripts/build-npm-package.js",
  "scripts/check-release-metadata.js",
  "scripts/check-syntax.js",
  "scripts/preview.js",
  "src/browser.js",
  "src/cli.js",
  "src/domain/assistant-templates.js",
  "src/domain/assistant.js",
  "src/domain/safety.js",
  "src/domain/templates.js",
  "src/domain/validation.js",
  "src/domain/local-endpoints.js",
  "src/gateway/codex-chat.js",
  "src/gateway/openai.js",
  "src/infrastructure/local-process.js",
  "src/infrastructure/ssh.js",
  "src/services/codex-login.js",
  "src/services/assistant-installer.js",
  "src/services/discovery.js",
  "src/services/installer.js",
  "src/services/local-chat-test.js",
  "src/services/local-installer.js",
  "src/services/oauth.js",
  "src/ui/app.js",
  "src/ui/assistant.css",
  "src/ui/assistant.html",
  "src/ui/assistant.js",
  "src/ui/icons/moon.svg",
  "src/ui/icons/monitor.svg",
  "src/ui/icons/sun.svg",
  "src/ui/index.html",
  "src/ui/local.css",
  "src/ui/local.html",
  "src/ui/local.js",
  "src/ui/oauth-popup.js",
  "src/ui/relmio-icon.png",
  "src/ui/relmio-icon-rounded.svg",
  "src/ui/styles.css",
  "src/ui/theme.js",
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

test("resolveNpmInvocation uses Node with npm-cli.js on Windows", () => {
  assert.deepEqual(
    resolveNpmInvocation({
      env: {},
      execPath: "/portable/node.exe",
      platform: "darwin",
    }),
    { command: "npm", prefixArgs: [] },
  );

  assert.deepEqual(
    resolveNpmInvocation({
      env: { NPM_EXECPATH: "/custom/npm-cli.js" },
      execPath: "/portable/node.exe",
      platform: "win32",
    }),
    {
      command: "/portable/node.exe",
      prefixArgs: [resolve("/custom/npm-cli.js")],
    },
  );

  assert.deepEqual(
    resolveNpmInvocation({
      env: { npm_execpath: "/custom/npx-cli.js" },
      execPath: "/portable/node.exe",
      platform: "win32",
    }),
    {
      command: "/portable/node.exe",
      prefixArgs: [resolve("/custom/npm-cli.js")],
    },
  );

  assert.deepEqual(
    resolveNpmInvocation({
      env: {},
      execPath: "/portable/node.exe",
      platform: "win32",
    }),
    {
      command: "/portable/node.exe",
      prefixArgs: [
        resolve("/portable", "node_modules", "npm", "bin", "npm-cli.js"),
      ],
    },
  );
});

test("npm package contains only allowed files and every advertised local script", async (t) => {
  const workspaceDirectory = await mkdtemp(join(tmpdir(), "npm-pack-test-"));
  const cacheDirectory = join(workspaceDirectory, "cache");
  const stagingDirectory = join(workspaceDirectory, "staging");
  t.after(() => rm(workspaceDirectory, { recursive: true, force: true }));

  await stageNpmPackage(stagingDirectory);

  const npmInvocation = resolveNpmInvocation();
  const { stdout } = await execFileAsync(
    npmInvocation.command,
    [
      ...npmInvocation.prefixArgs,
      "pack",
      "--dry-run",
      "--json",
      "--ignore-scripts",
    ],
    {
      cwd: stagingDirectory,
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
    const contents = await readFile(join(stagingDirectory, path), "utf8");
    for (const { label, pattern } of forbiddenContent) {
      assert.doesNotMatch(contents, pattern, `${path} contains a ${label}`);
    }
  }
});

test("npm package substitutes the concise registry-safe package README", async (t) => {
  const workspaceDirectory = await mkdtemp(join(tmpdir(), "npm-readme-test-"));
  const stagingDirectory = join(workspaceDirectory, "staging");
  t.after(() => rm(workspaceDirectory, { recursive: true, force: true }));

  await stageNpmPackage(stagingDirectory);

  const [expectedNpmReadme, npmReadme] = await Promise.all([
    readFile(join(projectRoot, "npm", "README.md"), "utf8"),
    readFile(join(stagingDirectory, "README.md"), "utf8"),
  ]);

  assert.equal(npmReadme, expectedNpmReadme);
  assert.doesNotMatch(npmReadme, /```mermaid/u);
  assert.match(npmReadme, /npx --yes --ignore-scripts relmio@latest/u);
  assert.match(npmReadme, /## What it can install/u);
  assert.match(npmReadme, /https:\/\/relmio\.vercel\.app\/docs\/reference/u);
  assert.doesNotMatch(npmReadme, /relmio\.jpfusin\.tech/u);
  assert.doesNotMatch(npmReadme, /\]\((?!https:\/\/)/u);
});

test("npm package builder emits the reviewed Relmio tarball", async (t) => {
  const outputDirectory = await mkdtemp(join(tmpdir(), "npm-build-test-"));
  t.after(() => rm(outputDirectory, { recursive: true, force: true }));

  const { packedPackage, tarballPath } = await buildNpmPackage({
    outputDirectory,
  });
  const packageJson = JSON.parse(
    await readFile(join(projectRoot, "package.json"), "utf8"),
  );

  assert.equal(
    basename(tarballPath),
    `relmio-${packageJson.version}.tgz`,
  );
  assert.deepEqual(
    packedPackage.files.map(({ path }) => path).sort(),
    [...expectedPackedFiles].sort(),
  );
  assert.ok((await stat(tarballPath)).size > 0);
});

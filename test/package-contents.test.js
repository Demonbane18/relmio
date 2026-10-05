import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  buildNpmPackage,
  resolveNpmInvocation,
  stageNpmPackage,
} from "../scripts/build-npm-package.js";

const execFileAsync = promisify(execFile);
const reviewedBinaryFiles = new Set([
  "docs/images/brand/relmio-concept-source.png",
  "docs/images/brand/relmio-logo.png",
  "docs/images/diagrams/relmio-two-lanes.png",
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
  "src/ui/fonts/bricolage-grotesque-latin.woff2",
  "src/ui/fonts/geist-latin.woff2",
  "src/ui/relmio-icon.png",
  "src/ui/relmio-icon-96.png",
]);
const forbiddenBasename =
  /^(?:\.env(?:\..*)?|auth\.json|credentials?\.json|.*\.(?:key|p12|pem|pfx|ppk))$/iu;
const textExtensions = new Set([
  "",
  ".css",
  ".html",
  ".js",
  ".mjs",
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
      /https?:\/\/(?:127\.0\.0\.1|localhost):\d+(?:\/|\/assistant|\/local)\?session=[A-Za-z0-9_-]{16,}/u,
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

  const manifest = JSON.parse(await readFile(join(stagingDirectory, "package.json"), "utf8"));
  for (const entry of Object.values(manifest.bin)) {
    assert.ok(packedPaths.includes(entry), `missing advertised executable: ${entry}`);
  }
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


test("npm package builder returns a tarball matching npm's integrity digest", async (t) => {
  const outputDirectory = await mkdtemp(join(tmpdir(), "npm-build-test-"));
  t.after(() => rm(outputDirectory, { recursive: true, force: true }));

  const { packedPackage, tarballPath } = await buildNpmPackage({ outputDirectory });
  const contents = await readFile(tarballPath);
  assert.equal(
    `sha512-${createHash("sha512").update(contents).digest("base64")}`,
    packedPackage.integrity,
  );
  assert.deepEqual(
    packedPackage.files.filter(({ path }) => forbiddenBasename.test(path.split("/").at(-1))),
    [],
  );
});

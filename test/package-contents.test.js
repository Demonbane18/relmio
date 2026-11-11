import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { extname, join, posix, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  buildNpmPackage,
  resolveNpmInvocation,
  stageNpmPackage,
} from "../scripts/build-npm-package.js";

const execFileAsync = promisify(execFile);
// The complete set of published binary files. Screenshots and source art stay in the repository only.
const reviewedBinaryFiles = [
  "docs/images/brand/relmio-logo.png",
  "src/ui/fonts/bricolage-grotesque-latin.woff2",
  "src/ui/fonts/geist-latin.woff2",
  "src/ui/relmio-icon-96.png",
];
// Everything published outside src/ and the documentation pages, listed exactly. npm-shrinkwrap.json is the
// repository lockfile: it pins the packages below the direct dependencies for registry installs.
const reviewedFilesOutsideSource = [
  "CHANGELOG.md",
  "LICENSE",
  "NOTICE",
  "README.md",
  "SPEC.md",
  "docs/images/brand/relmio-banner-animated.svg",
  "docs/images/brand/relmio-logo-rounded.svg",
  "docs/images/brand/relmio-logo.png",
  "npm-shrinkwrap.json",
  "package.json",
  "scripts/build-npm-package.js",
  "scripts/check-release-metadata.js",
  "scripts/check-syntax.js",
  "scripts/preview.js",
];
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
  ".sh",
  ".svg",
  ".txt",
  ".yaml",
  ".yml",
]);
// `relmio claude companion prepare` and the Claude VPS wizard copy these from the installed package; the docs explain the adapter.
const claudeAdapterFiles = [
  "src/claude/command.js",
  "src/claude/companion.js",
  "src/claude/launcher.js",
  "src/claude/local.js",
  "src/services/vps-claude.js",
  "src/ui/claude-vps.html",
  "src/ui/claude-vps.js",
  "src/ui/claude-vps.css",
  "src/ui/guide/content-claude-vps.js",
  "src/gateway/claude-chat.js",
  "src/templates/claude-companion/Dockerfile",
  "src/templates/claude-companion/compose.yml",
  "src/templates/claude-companion/login.sh",
  "src/templates/claude-companion/renew.sh",
  "docs/claude-native-prompt.md",
  "docs/claude-native-prompt-source-check-2026-11-03.md",
  "docs/claude-native-prompt-source-check-2026-11-04.md",
  "docs/claude-subscription-n8n-research-2026-11-03.md",
  "docs/claude-subscription.md",
];
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
  assert.ok(packedPaths.includes("src/ui/guide/context.js"), "missing bundled contextual help");
  for (const path of claudeAdapterFiles) {
    assert.ok(packedPaths.includes(path), `missing Claude adapter file: ${path}`);
  }

  const manifest = JSON.parse(await readFile(join(stagingDirectory, "package.json"), "utf8"));
  for (const entry of Object.values(manifest.bin)) {
    assert.ok(packedPaths.includes(entry), `missing advertised executable: ${entry}`);
  }
  assert.deepEqual(
    packedPaths.filter((path) => forbiddenBasename.test(path.split("/").at(-1))),
    [],
  );
  assert.deepEqual(
    packedPaths.filter((path) => !path.startsWith("src/") && !/^docs\/[^/]+\.md$/u.test(path)),
    reviewedFilesOutsideSource,
  );
  assert.deepEqual(
    packedPaths.filter((path) => !textExtensions.has(extname(path))),
    reviewedBinaryFiles,
  );
  assert.equal(
    await readFile(join(stagingDirectory, "npm-shrinkwrap.json"), "utf8"),
    await readFile("package-lock.json", "utf8"),
  );
  // A `!path` entry in `files` stays in the repository and reaches neither the tarball nor the
  // staging folder, which the Windows portable archive copies whole.
  const unpublished = manifest.files.filter((entry) => entry.startsWith("!")).map((entry) => entry.slice(1));
  assert.deepEqual(unpublished, [
    "src/ui/relmio-icon.png",
    "docs/images/setup",
    "docs/images/examples",
    "docs/images/diagrams",
    "docs/images/brand/relmio-concept-source.png",
  ]);
  for (const path of unpublished) {
    await access(path);
    await assert.rejects(access(join(stagingDirectory, path)), { code: "ENOENT" }, path);
    assert.equal(packedPaths.some((packed) => packed === path || packed.startsWith(`${path}/`)), false, path);
  }
  for (const path of packedPaths) {
    if (!textExtensions.has(extname(path))) continue;
    const contents = await readFile(join(stagingDirectory, path), "utf8");
    for (const { label, pattern } of forbiddenContent) {
      assert.doesNotMatch(contents, pattern, `${path} contains a ${label}`);
    }
    if (extname(path) !== ".md") continue;
    // Every image a published document displays must be published too: relative Markdown or HTML
    // images, and files the README loads from this package through jsDelivr.
    const displayed = [
      ...[...contents.matchAll(/!\[[^\]]*\]\(([^)\s]+)/gu), ...contents.matchAll(/<img[^>]+src="([^"]+)"/gu)]
        .map(([, target]) => target)
        .filter((target) => !/^[a-z][a-z0-9+.-]*:/iu.test(target))
        .map((target) => posix.join(posix.dirname(path), target.split("#", 1)[0])),
      ...[...contents.matchAll(/cdn\.jsdelivr\.net\/npm\/relmio@[^/\s"]+\/([^\s")]+)/gu)].map(([, target]) => target),
    ];
    for (const target of displayed) {
      assert.ok(packedPaths.includes(target), `${path} displays an unpublished file: ${target}`);
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

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import test from "node:test";
import ts from "typescript";
import nextConfig from "../next.config.ts";
import { preparedReleaseVersion } from "../app/project-version.ts";

const require = createRequire(import.meta.url);
const { unstable_doesMiddlewareMatch } = require("next/experimental/testing/server");

test("builds the hosted app as a Node.js 24 Next.js project on Vercel", async () => {
  const [packageJsonSource, vercelConfigSource] = await Promise.all([
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../vercel.json", import.meta.url), "utf8"),
  ]);

  const packageJson = JSON.parse(packageJsonSource);
  const vercelConfig = JSON.parse(vercelConfigSource);

  assert.equal(packageJson.engines.node, "24.x");
  assert.match(packageJson.devDependencies["@types/node"], /^24\./u);
  assert.equal(packageJson.scripts["build:vercel"], "next build");
  assert.equal(vercelConfig.framework, "nextjs");
  assert.equal(vercelConfig.buildCommand, "npm run build:vercel");
  assert.equal(vercelConfig.installCommand, "npm ci --ignore-scripts");
});

test("runs web quality gates in GitHub CI for repository-driven deploys", async () => {
  const [packageJsonSource, workflow] = await Promise.all([
    readFile(new URL("../package.json", import.meta.url), "utf8"),
    readFile(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8"),
  ]);
  const packageJson = JSON.parse(packageJsonSource);

  assert.equal(packageJson.scripts.typecheck, "tsc --noEmit");
  assert.match(workflow, /web-quality:/u);
  assert.match(workflow, /working-directory: web/u);
  assert.match(workflow, /run: npm run lint/u);
  assert.match(workflow, /run: npm run typecheck/u);
  assert.match(workflow, /run: npm run build:vercel/u);
  assert.match(workflow, /run: npm test/u);
  assert.match(workflow, /run: npm audit --omit=dev --audit-level=high/u);
});

test("the website fallback names the current stable package release", async () => {
  const { version } = JSON.parse(await readFile(new URL("../../package.json", import.meta.url), "utf8"));
  assert.match(preparedReleaseVersion, /^\d+\.\d+\.\d+$/u, "the installer uses the stable channel");
  // Prereleases keep advertising the last stable version, like the release check.
  if (!version.split("+", 1)[0].includes("-")) {
    assert.equal(preparedReleaseVersion, version);
  }
});

test("fonts keep a long-lived cache policy without declaring unversioned files immutable", async () => {
  const headers = await nextConfig.headers();
  const fonts = headers.find((rule) => rule.source === "/fonts/:path*");
  assert.ok(fonts, "font cache rule");
  assert.equal(
    fonts.headers.find((header) => header.key.toLowerCase() === "cache-control")?.value,
    "public, max-age=2592000, stale-while-revalidate=31536000",
  );
  assert.equal(nextConfig.poweredByHeader, false);
  const pages = headers.find((rule) => rule.source === "/:path*");
  assert.ok(pages, "shared security headers still apply");
  assert.ok(!pages.headers.some((header) => header.key.toLowerCase() === "cache-control"));
});

test("the nonce proxy matches documents but skips static files and router prefetches", async () => {
  const source = await readFile(new URL("../proxy.ts", import.meta.url), "utf8");
  const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS },
  }).outputText;
  const exports = {};
  runInNewContext(compiled, { exports, require });
  const config = exports.config;

  for (const url of ["/", "/install", "/docs", "/docs/security", "/missing-page"]) {
    assert.equal(unstable_doesMiddlewareMatch({ config, nextConfig, url }), true, url);
    for (const headers of [{ "next-router-prefetch": "1" }, { purpose: "prefetch" }]) {
      assert.equal(unstable_doesMiddlewareMatch({ config, nextConfig, url, headers }), false, `${url} prefetch`);
    }
  }
  for (const url of [
    "/api/project-meta",
    "/_next/static/chunks/site.js",
    "/_next/image?url=%2Fog.png&w=1200&q=75",
    "/fonts/geist-latin.woff2",
    "/fonts/bricolage-grotesque-latin.woff2",
    "/fonts/Geist-OFL.txt",
    "/favicon.ico",
    "/relmio-icon-96.png",
    "/relmio-icon-rounded.svg",
    "/og.png",
    "/install.sh",
    "/install.ps1",
    "/install.cmd",
  ]) {
    assert.equal(unstable_doesMiddlewareMatch({ config, nextConfig, url }), false, url);
  }
});

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

test("builds the hosted app as a Node.js 22 Next.js project on Vercel", async () => {
  const [packageJsonSource, vercelConfigSource, nextConfig, chatRoute] =
    await Promise.all([
      readFile(new URL("../package.json", import.meta.url), "utf8"),
      readFile(new URL("../vercel.json", import.meta.url), "utf8"),
      readFile(new URL("../next.config.ts", import.meta.url), "utf8"),
      readFile(new URL("../app/api/chat/route.ts", import.meta.url), "utf8"),
    ]);

  const packageJson = JSON.parse(packageJsonSource);
  const vercelConfig = JSON.parse(vercelConfigSource);

  assert.equal(packageJson.engines.node, "22.x");
  assert.equal(packageJson.scripts["build:vercel"], "next build");
  assert.equal(vercelConfig.framework, "nextjs");
  assert.equal(vercelConfig.buildCommand, "npm run build:vercel");
  assert.equal(vercelConfig.installCommand, "npm ci --ignore-scripts");
  assert.match(nextConfig, /turbopack:\s*\{\s*root: process\.cwd\(\),?\s*\}/u);
  assert.match(chatRoute, /export const runtime = "nodejs";/u);
});

test("returns OAuth callbacks to whichever deployment started sign-in", async () => {
  const chatConsole = await readFile(
    new URL("../app/components/ChatConsole.tsx", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(chatConsole, /callbackPath=/u);
  assert.doesNotMatch(chatConsole, /relmio\.jpfusin\.tech/u);
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
  assert.match(workflow, /run: npm audit --audit-level=high/u);
});

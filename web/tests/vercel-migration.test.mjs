import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

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
  assert.match(workflow, /run: npm audit --audit-level=high/u);
});

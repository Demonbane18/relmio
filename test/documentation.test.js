import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  createComposeFile,
  createDockerfile,
} from "../src/domain/templates.js";

function assertOnlyDocumentationAddresses(contents) {
  const allowed = new Set(["0.0.0.0", "127.0.0.1", "192.0.2.10"]);
  const addresses = contents.match(/\b(?:\d{1,3}\.){3}\d{1,3}\b/gu) ?? [];

  for (const address of addresses) {
    assert.ok(
      allowed.has(address),
      "documentation contains a non-documentation IPv4 address",
    );
  }
}

test("README and manual guide copy the generated sidecar files exactly", async () => {
  const guides = await Promise.all(
    ["README.md", "docs/manual-install.md"].map((path) =>
      readFile(path, "utf8"),
    ),
  );

  for (const guide of guides) {
    const normalizedGuide = guide.replaceAll("\r\n", "\n");
    assert.ok(normalizedGuide.includes(createDockerfile().trim()));
    assert.ok(
      normalizedGuide.includes(
        createComposeFile({ networkName: "proxy" }).trim(),
      ),
    );
    assert.match(
      guide,
      /up -d --wait --wait-timeout 60 --no-deps openai-oauth/,
    );
    assert.match(guide, /http:\/\/n8n-openai-oauth:10531\/v1/);
    assertOnlyDocumentationAddresses(guide);
  }
});

test("README keeps every local install path and layman diagrams visible", async () => {
  const readme = await readFile("README.md", "utf8");
  const mermaidBlocks = readme.match(/```mermaid/gu) ?? [];

  assert.match(readme, /## Choose a setup path/u);
  assert.match(readme, /## Quick start with the npm package/u);
  assert.match(
    readme,
    /curl -fsSL https:\/\/relmio\.vercel\.app\/install\.sh \| sh/u,
  );
  assert.match(
    readme,
    /irm https:\/\/relmio\.vercel\.app\/install\.ps1 \| iex/u,
  );
  assert.match(readme, /Windows Command Prompt/u);
  assert.match(readme, /without installing Node\.js or Git Bash first/u);
  assert.match(readme, /## Manual setup and debugging/u);
  assert.match(readme, /The wizard is a convenience layer, not a requirement/u);
  assert.ok(mermaidBlocks.length >= 4);
  assert.doesNotMatch(readme, /—/u);
});

test("beginner documentation states the critical safety and product limits", async () => {
  const files = await Promise.all(
    [
      "README.md",
      "docs/troubleshooting.md",
      "docs/security.md",
      "docs/maintenance.md",
    ].map((path) => readFile(path, "utf8")),
  );
  const contents = files.join("\n");

  assert.match(
    contents,
    /does \*\*not\*\* create an? (?:real )?OpenAI (?:Platform )?API key/i,
  );
  assert.match(contents, /never (?:edits|delete).*n8n/i);
  assert.match(contents, /unofficial/i);
  assert.match(contents, /OpenAI Terms/i);
  assert.match(contents, /no host `ports` mapping/i);
  assert.match(contents, /This sign-in request expired/i);
  assert.match(contents, /no matches found/i);
});

test("release guidance covers the Windows probe, browser relaunch, and blank OAuth tab", async () => {
  const [readme, npmReadme, troubleshooting] = await Promise.all([
    readFile("README.md", "utf8"),
    readFile("npm/README.md", "utf8"),
    readFile("docs/troubleshooting.md", "utf8"),
  ]);

  for (const guide of [readme, npmReadme]) {
    assert.match(guide, /press Enter in an interactive\s+terminal to open it again/i);
    assert.match(guide, /printed .*URL.*fallback/is);
  }
  assert.match(troubleshooting, /\[eval\]:1/u);
  assert.match(troubleshooting, /white `about:blank` tab/u);
});

test("Windows Command Prompt documentation calls the system PowerShell executable", async () => {
  const [readme, npmReadme, troubleshooting] = await Promise.all([
    readFile("README.md", "utf8"),
    readFile("npm/README.md", "utf8"),
    readFile("docs/troubleshooting.md", "utf8"),
  ]);
  const command =
    '"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -ExecutionPolicy Bypass -Command "irm https://relmio.vercel.app/install.ps1 | iex"';

  for (const guide of [readme, npmReadme, troubleshooting]) {
    assert.ok(guide.includes(command));
  }
  assert.match(troubleshooting, /VS Code embedded browser/u);
  assert.match(troubleshooting, /validated manual link/u);
});

test("n8n configuration guide provides copy-paste model and HTTP recipes", async () => {
  const guide = await readFile("docs/n8n-configuration.md", "utf8");

  assert.match(guide, /AI Agent/u);
  assert.match(guide, /Basic LLM Chain/u);
  assert.match(guide, /OpenAI Chat Model/u);
  assert.match(guide, /http:\/\/n8n-openai-oauth:10531\/v1\/responses/u);
  assert.match(guide, /Bearer local-only/u);
  assert.match(guide, /PASTE_ONE_MODEL_ID_FROM_THE_WIZARD/u);
  assert.match(guide, /curl --request POST/u);
  assert.match(guide, /node version 1\.3/u);
  assert.match(guide, /\/v1\/chat\/completions/u);
  assertOnlyDocumentationAddresses(guide);
});

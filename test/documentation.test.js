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

test("manual installation remains the canonical exact sidecar guide", async () => {
  const guide = await readFile("docs/manual-install.md", "utf8");
  const normalizedGuide = guide.replaceAll("\r\n", "\n");

  assert.ok(normalizedGuide.includes(createDockerfile().trim()));
  assert.ok(
    normalizedGuide.includes(
      createComposeFile({ networkName: "proxy" }).trim(),
    ),
  );
  assert.match(guide, /up -d --wait --wait-timeout 60 --no-deps openai-oauth/);
  assert.match(guide, /http:\/\/n8n-openai-oauth:10531\/v1/);
  assertOnlyDocumentationAddresses(guide);
});

test("README surfaces are concise product entry points linked to canonical docs", async () => {
  const [readme, npmReadme] = await Promise.all([
    readFile("README.md", "utf8"),
    readFile("npm/README.md", "utf8"),
  ]);
  for (const guide of [readme, npmReadme]) {
    assert.match(guide, /## Quick install/u);
    assert.match(guide, /## Common problems/u);
    assert.match(guide, /Docker is not running/u);
    assert.match(guide, /Authentication fails/u);
    assert.match(guide, /Local image build failed/u);
    assert.match(guide, /npx --yes --ignore-scripts relmio@latest/u);
    assert.doesNotMatch(guide, /```mermaid/u);
  }
  assert.match(readme, /## Endpoints/u);
  assert.match(readme, /## Critical security boundaries/u);
  assert.match(readme, /https:\/\/relmio\.vercel\.app\/docs\/reference/u);
  assert.match(npmReadme, /https:\/\/relmio\.vercel\.app\/docs\/security/u);
  assert.doesNotMatch(npmReadme, /\]\((?!https:\/\/)/u);
});

test("canonical local endpoint guidance documents credential rotation", async () => {
  const localGuide = await readFile("docs/local-endpoints.md", "utf8");

  assert.match(localGuide, /previous capability remains active/u);
  assert.match(localGuide, /authenticated Codex WebSocket handshake/u);
  assert.match(localGuide, /preserves the upstream Platform API key/u);
  assert.match(
    localGuide,
    /restores\s+the\s+previous\s+verifier\s+and\s+re-attests\s+its\s+health\s+and\s+loopback\s+publication/u,
  );
  assert.match(
    localGuide,
    /does\s+not\s+retain\s+the\s+previous\s+raw\s+client\s+credential/u,
  );
});

test("security guidance distinguishes all three local endpoint trust contracts", async () => {
  const security = await readFile("docs/security.md", "utf8");

  assert.match(security, /every raw Codex WebSocket[\s\S]*every Codex Chat Adapter route except `GET \/health`/u);
  assert.match(security, /Chat Adapter rejects every request carrying an `Origin` header/u);
  assert.match(security, /All three long-running endpoint containers/u);
  assert.match(security, /Each Codex target receives its own private named/u);
  assert.match(security, /named read-only permission profile with network[\s\S]*disabled/u);
  assert.match(security, /trusted local backend or development server/u);
  assert.match(security, /not[\s\S]*`\/v1\/chat\/completions`[\s\S]*`\/v1\/responses`/u);
  assert.doesNotMatch(security, /Both long-running endpoint containers/u);
  assert.doesNotMatch(security, /Do not expose either endpoint/u);
  assert.match(security, /In-wizard Chat Adapter tester/u);
  assert.match(security, /not encryption at rest or end-to-end encryption/u);
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

  assert.match(contents, /ChatGPT sign-in is never an\s+OpenAI Platform API key/i);
  assert.match(contents, /never (?:edits|delete)[\s\S]*n8n/i);
  assert.match(contents, /unofficial/i);
  assert.match(contents, /OpenAI Terms/i);
  assert.match(contents, /no host `ports` mapping/i);
  assert.match(contents, /This sign-in request expired/i);
  assert.match(contents, /no matches found/i);
});

test("troubleshooting retains the Windows probe, browser relaunch, and blank OAuth tab", async () => {
  const troubleshooting = await readFile("docs/troubleshooting.md", "utf8");
  assert.match(troubleshooting, /\[eval\]:1/u);
  assert.match(troubleshooting, /white `about:blank` tab/u);
});

test("troubleshooting retains the PowerShell-free Windows bootstrap guide", async () => {
  const troubleshooting = await readFile("docs/troubleshooting.md", "utf8");
  assert.match(troubleshooting, /for \/f "delims=" %F/u);
  assert.match(troubleshooting, /relmio-install-%RANDOM%-%RANDOM%-%RANDOM%\.cmd/u);
  assert.match(troubleshooting, /--remove-on-error/u);
  assert.match(troubleshooting, /RELMIO_SELF_DELETE=%~F/u);
  assert.doesNotMatch(troubleshooting, /-o install\.cmd/u);
  assert.match(troubleshooting, /PowerShell-free/u);
  assert.match(troubleshooting, /Please wait/u);
  assert.match(troubleshooting, /VS Code embedded browser/u);
  assert.match(troubleshooting, /validated manual link/u);
});

test("troubleshooting exposes the tested Homebrew tap while WinGet remains pending", async () => {
  const [troubleshooting, maintainerGuide] = await Promise.all([
    readFile("docs/troubleshooting.md", "utf8"),
    readFile("packaging/package-managers.md", "utf8"),
  ]);
  assert.match(troubleshooting, /brew tap Demonbane18\/relmio && brew install relmio/u);
  assert.doesNotMatch(troubleshooting, /\bwinget install\b/iu);
  assert.match(troubleshooting, /Homebrew is available/iu);
  assert.match(troubleshooting, /WinGet\s+command.*hidden/iu);
  assert.match(maintainerGuide, /exact\s+immutable tarball downloaded back from the registry/iu);
  assert.match(maintainerGuide, /Demonbane18\/homebrew-relmio/u);
  assert.match(maintainerGuide, /6c8038f/u);
  assert.match(maintainerGuide, /30905921073/u);
  assert.match(maintainerGuide, /Demonbane18\.Relmio/u);
  assert.match(maintainerGuide, /WinGet manifest pull request.*submitted/iu);
  assert.match(
    maintainerGuide,
    /pending\s+review, merge, and catalog propagation/iu,
  );
});

test("n8n configuration guide provides copy-paste model and HTTP recipes", async () => {
  const guide = await readFile("docs/n8n-configuration.md", "utf8");

  assert.match(guide, /AI Agent/u);
  assert.match(guide, /Basic LLM Chain/u);
  assert.match(guide, /OpenAI Chat Model/u);
  assert.match(guide, /http:\/\/n8n-openai-oauth:10531\/v1\/chat\/completions/u);
  assert.match(guide, /Bearer local-only/u);
  assert.match(guide, /"model": "gpt-5\.6-sol"/u);
  assert.match(guide, /"messages"/u);
  assert.match(guide, /"response_format"/u);
  assert.match(guide, /curl --request POST/u);
  assert.match(guide, /node version 1\.3/u);
  assert.match(guide, /\/v1\/chat\/completions/u);
  assertOnlyDocumentationAddresses(guide);
});

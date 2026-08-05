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
  const [readme, npmReadme] = await Promise.all([
    readFile("README.md", "utf8"),
    readFile("npm/README.md", "utf8"),
  ]);
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
  for (const guide of [readme, npmReadme]) {
    assert.match(
      guide,
      /clickable macOS\/Linux, Homebrew, PowerShell, Command Prompt, and NPX (?:command )?switcher/u,
    );
  }
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

test("Windows Command Prompt documentation uses the PowerShell-free native bootstrap", async () => {
  const [readme, npmReadme, troubleshooting] = await Promise.all([
    readFile("README.md", "utf8"),
    readFile("npm/README.md", "utf8"),
    readFile("docs/troubleshooting.md", "utf8"),
  ]);
  for (const guide of [readme, npmReadme, troubleshooting]) {
    assert.match(guide, /for \/f "delims=" %F/u);
    assert.match(guide, /relmio-install-%RANDOM%-%RANDOM%-%RANDOM%\.cmd/u);
    assert.match(guide, /--remove-on-error/u);
    assert.match(guide, /RELMIO_SELF_DELETE=%~F/u);
    assert.doesNotMatch(guide, /-o install\.cmd/u);
    assert.match(guide, /PowerShell-free/u);
    assert.match(guide, /Please wait/u);
  }
  assert.match(troubleshooting, /VS Code embedded browser/u);
  assert.match(troubleshooting, /validated manual link/u);
});

test("public guides expose the tested Homebrew tap while WinGet remains pending", async () => {
  const [readme, npmReadme, troubleshooting, maintainerGuide] = await Promise.all([
    readFile("README.md", "utf8"),
    readFile("npm/README.md", "utf8"),
    readFile("docs/troubleshooting.md", "utf8"),
    readFile("packaging/package-managers.md", "utf8"),
  ]);

  for (const guide of [readme, npmReadme, troubleshooting]) {
    assert.match(
      guide,
      /brew tap Demonbane18\/relmio && brew install relmio/u,
    );
    assert.doesNotMatch(guide, /\bwinget install\b/iu);
    assert.match(guide, /Homebrew is available/iu);
    assert.match(guide, /WinGet\s+command.*hidden/iu);
  }
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

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
    assert.match(guide, /Use ChatGPT sign-in with n8n/u);
    assert.match(guide, /ChatGPT sign-in is not an OpenAI Platform API key/u);
    assert.match(guide, /unofficial[\s\S]*private[\s\S]*policy-uncertain/iu);
    assert.match(guide, /img\.shields\.io\/github\/stars\/Demonbane18\/relmio/u);
    assert.match(guide, /## Quick install/u);
    assert.match(guide, /## Pick a path/u);
    assert.match(guide, /## Common problems/u);
    assert.match(guide, /Docker is not running/u);
    assert.match(guide, /Authentication fails/u);
    assert.match(guide, /Local image build failed/u);
    assert.match(guide, /npx --yes --ignore-scripts relmio@latest/u);
    assert.match(
      guide,
      /## Support[\s\S]*href="https:\/\/ko-fi\.com\/paldogies"[\s\S]*src="https:\/\/storage\.ko-fi\.com\/cdn\/kofi6\.png\?v=6"/u,
    );
    assert.doesNotMatch(guide, /<script\b/iu);
    assert.doesNotMatch(guide, /```mermaid/u);
  }
  assert.match(readme, /docs\/images\/brand\/relmio-banner-animated\.svg/u);
  assert.match(readme, /https:\/\/relmio\.vercel\.app\/docs\/reference/u);
  assert.match(readme, /https:\/\/relmio\.vercel\.app\/changelog/u);
  assert.match(npmReadme, /https:\/\/relmio\.vercel\.app\/docs\/security/u);
  assert.doesNotMatch(npmReadme, /\]\((?!https:\/\/)/u);
});

test("persistent dashboard guides keep launch, inventory, action, and secret boundaries aligned", async () => {
  const [readme, npmReadme, gettingStarted, localEndpoints, dashboard, troubleshooting] =
    await Promise.all([
      readFile("README.md", "utf8"),
      readFile("npm/README.md", "utf8"),
      readFile("docs/getting-started.md", "utf8"),
      readFile("docs/local-endpoints.md", "utf8"),
      readFile("docs/local-dashboard.md", "utf8"),
      readFile("docs/troubleshooting.md", "utf8"),
  ]);

  for (const entryPoint of [readme, npmReadme]) {
    assert.match(
      entryPoint,
      /relmio start[\s\S]*relmio status[\s\S]*relmio open[\s\S]*relmio stop/u,
    );
    assert.doesNotMatch(entryPoint, /Press Enter to reopen the same\s+dashboard/u);
    assert.match(entryPoint, /six supported local services/u);
    assert.match(entryPoint, /never stored\s+secrets/u);
    assert.match(entryPoint, /existing four-step setup flow/u);
    assert.match(entryPoint, /relmio vps/u);
    assert.match(
      entryPoint,
      /Homebrew\s+installs the persistent `relmio` command;\s+it\s+does not launch the browser/u,
    );
    assert.doesNotMatch(entryPoint, /every launcher opens the same wizard/iu);
    for (const command of ["status", "open", "stop"]) {
      assert.ok(
        entryPoint.includes(`npx --yes --ignore-scripts relmio@latest ${command}`),
      );
    }
  }

  assert.match(readme, /\]\(docs\/local-dashboard\.md\)/u);
  assert.match(
    npmReadme,
    /https:\/\/github\.com\/Demonbane18\/relmio\/blob\/main\/docs\/local-dashboard\.md/u,
  );
  assert.match(gettingStarted, /\[Local dashboard\]\(\.\/local-dashboard\.md\)/u);
  assert.match(localEndpoints, /\[Use the local dashboard\]\(\.\/local-dashboard\.md\)/u);

  for (const command of [
    "npx --yes --ignore-scripts relmio@latest",
    "npx --yes --ignore-scripts relmio@latest status",
    "npx --yes --ignore-scripts relmio@latest open",
    "npx --yes --ignore-scripts relmio@latest stop",
    "relmio",
    "npm start",
    "relmio vps",
  ]) {
    assert.ok(dashboard.includes(command));
  }
  assert.match(dashboard, /another Relmio version/iu);
  assert.match(dashboard, /owner-only, short-lived handoff file/iu);
  assert.match(dashboard, /clean GET/iu);
  assert.match(dashboard, /expires after 10\s+seconds/iu);
  assert.doesNotMatch(dashboard, /[?]session=/u);
  assert.doesNotMatch(troubleshooting, /complete printed|printed `http:\/\/127\.0\.0\.1/iu);
  assert.match(
    dashboard,
    /relmio stop[\s\S]*relmio start[\s\S]*relmio open/iu,
  );
  assert.match(
    troubleshooting,
    /Homebrew and direct npm or NPX runs use the persistent dashboard/iu,
  );
  assert.match(
    troubleshooting,
    /hosted curl, PowerShell, and Command Prompt launchers run in the\s+foreground/iu,
  );
  for (const service of [
    "OpenAI API",
    "Codex (ChatGPT login)",
    "Codex Chat adapter",
    "n8n + ngrok",
    "OpenAI OAuth bridge",
    "AI Assistant tools",
  ]) {
    assert.ok(dashboard.includes(`**${service}**`));
  }
  for (const state of [
    "Checking",
    "Healthy",
    "Stopped",
    "Needs recovery",
    "Unavailable",
    "Stale",
    "Not configured",
  ]) {
    assert.ok(dashboard.includes(`**${state}**`));
  }
  for (const action of [
    "Refresh status",
    "Set up",
    "Resume",
    "Review removal",
    "Sign in",
    "Rotate credential",
    "Refresh credential",
  ]) {
    assert.ok(dashboard.includes(`**${action}**`));
  }

  assert.match(dashboard, /browser-launch command[\s\S]*visible[\s\S]*URL contains that capability/u);
  assert.match(
    dashboard,
    /same-tab reload[\s\S]*current\s+tab's clean GET history entry/u,
  );
  assert.match(dashboard, /new tab[\s\S]*use `relmio open`/u);
  assert.doesNotMatch(dashboard, /refreshed page without its session value cannot reconnect/iu);
  assert.match(
    dashboard,
    /\*\*Refresh status\*\* first forgets abandoned setup drafts[\s\S]*does not change an installed service/u,
  );
  assert.match(dashboard, /never returns a[\s\S]*Platform API key[\s\S]*OAuth token/u);
  assert.match(dashboard, /ChatGPT device sign-in authorizes Codex/u);
  assert.match(dashboard, /Chat Adapter bearer authorizes your client/u);
  assert.match(dashboard, /does not start a browser sign-in by itself/u);
  assert.match(dashboard, /selected n8n container and\s+Docker network remain operator-owned/u);
  assert.match(dashboard, /does not edit n8n configuration[\s\S]*restart[\s\S]*n8n/u);
  assert.match(dashboard, /Select \*\*Add connection\*\*[\s\S]*four-step setup flow/u);
  assert.match(dashboard, /Returning to the dashboard clears pending plans/u);
  assertOnlyDocumentationAddresses(dashboard);
});

test("public guides document persistent dashboard lifecycle and fail-closed provider support", async () => {
  const [readme, npmReadme, gettingStarted, localEndpoints, dashboard, security] =
    await Promise.all([
      readFile("README.md", "utf8"),
      readFile("npm/README.md", "utf8"),
      readFile("docs/getting-started.md", "utf8"),
      readFile("docs/local-endpoints.md", "utf8"),
      readFile("docs/local-dashboard.md", "utf8"),
      readFile("docs/security.md", "utf8"),
    ]);

  for (const guide of [readme, npmReadme, gettingStarted, dashboard]) {
    assert.match(
      guide,
      /relmio start[\s\S]*relmio status[\s\S]*relmio open[\s\S]*relmio stop/u,
    );
    assert.match(guide, /stops only (?:that|the Relmio dashboard) process/iu);
    assert.match(guide, /foreground[\s,-]+one-shot/iu);
  }

  for (const guide of [localEndpoints, dashboard, security]) {
    assert.match(guide, /official Codex App Server/u);
    assert.match(guide, /Codex owns the ChatGPT OAuth flow/u);
    assert.match(guide, /one active ChatGPT account/u);
    assert.match(guide, /xAI\/Grok authentication is API-key only/u);
    assert.match(guide, /does not implement third-party Grok OAuth/u);
    assert.match(guide, /401, 403, (?:or )?429/u);
    assert.match(guide, /never (?:changes|rotates) accounts or keys automatically/iu);
    assert.match(guide, /denied by default/u);
    assert.match(guide, /never returns or re-shows a stored secret/u);
  }
});

test("VPS guides explain explicit disconnect and bounded SSH inactivity", async () => {
  const [dashboard, vpsGuide, security] = await Promise.all([
    readFile("docs/local-dashboard.md", "utf8"),
    readFile("docs/vps-and-n8n.md", "utf8"),
    readFile("docs/security.md", "utf8"),
  ]);

  for (const guide of [dashboard, vpsGuide, security]) {
    assert.match(guide, /Disconnect from VPS/u);
    assert.match(guide, /15 minutes\s+of\s+inactivity/u);
    assert.match(guide, /active\s+(?:VPS|remote)\s+operation/u);
  }
});

test("provider roadmap requires official authentication support before implementation", async () => {
  const roadmap = await readFile("docs/roadmap.md", "utf8");

  assert.match(roadmap, /xAI\/Grok API-key support/u);
  assert.match(roadmap, /does not document a third-party Grok OAuth flow/u);
  assert.match(roadmap, /denied by default/u);
  assert.match(roadmap, /401, 403, or 429/u);
  assert.match(roadmap, /never automatically switches accounts or keys/u);
  assert.match(roadmap, /provider-owned OAuth client registration/u);
  assert.doesNotMatch(roadmap, /technically plausible/iu);
  assert.doesNotMatch(roadmap, /Hermes Agent/iu);
});

test("release changelog retains the Unreleased section above the dated release", async () => {
  const changelog = await readFile("CHANGELOG.md", "utf8");
  assert.match(changelog, /## Unreleased[\s\S]*## \[0\.10\.0\] - 2026-08-31/u);
});

test("published guides document the local n8n Assistant tools wizard contract", async () => {
  const [readme, npmReadme, localGuide, assistantGuide, security] = await Promise.all([
    readFile("README.md", "utf8"),
    readFile("npm/README.md", "utf8"),
    readFile("docs/local-endpoints.md", "utf8"),
    readFile("docs/ai-assistant.md", "utf8"),
    readFile("docs/security.md", "utf8"),
  ]);

  for (const guide of [readme, npmReadme]) {
    assert.match(guide, /choose \*\*n8n AI Assistant tools\*\* in the local browser wizard/iu);
    assert.match(guide, /SearXNG[\s\S]*off by default/iu);
    assert.match(guide, /does not (?:change|edit)[\s\S]*restart\s+n8n/iu);
  }
  assert.match(localGuide, /\*\*n8n AI Assistant tools\*\*/u);
  assert.match(localGuide, /~\/\.relmio\/local\/n8n-ai-assistant/u);
  assert.match(localGuide, /N8N_SANDBOX_SERVICE_API_KEY/u);
  assert.match(localGuide, /N8N_INSTANCE_AI_SEARXNG_URL/u);
  assert.match(assistantGuide, /local Docker-socket\s+discovery/u);
  assert.match(security, /privileged\s+Docker-in-Docker runner/u);
  assert.match(security, /no host\s+port/u);
});

test("published documentation explains ChatGPT token refresh and lifetime boundaries", async () => {
  const paths = [
    "README.md",
    "npm/README.md",
    "docs/local-endpoints.md",
    "docs/faq.md",
    "docs/troubleshooting.md",
    "docs/security.md",
    "web/app/docs/generated-content.ts",
  ];
  const contents = await Promise.all(paths.map((path) => readFile(path, "utf8")));
  const generated = contents.at(-1);

  for (const published of contents.slice(0, -1)) {
    assert.match(published, /ChatGPT\/Codex sign-in tokens expire/u);
    assert.match(
      published,
      /official Codex client refreshes\s+them\s+automatically during active use before they expire/iu,
    );
    assert.match(
      published,
      /active\s+sessions\s+usually\s+continue\s+without\s+another\s+browser\s+login/iu,
    );
    assert.match(
      published,
      /official\s+(?:\[[^\]]+\]\([^\)]+\)|OpenAI documentation)\s+does not\s+publish a fixed 10-day lifetime/iu,
    );
    assert.match(published, /do not plan around one/u);
    assert.match(
      published,
      /provider\s+credential is separate from Relmio's local\s+capability[\s\S]*remains valid\s+until you rotate it/u,
    );
  }
  assert.match(generated, /ChatGPT\/Codex sign-in tokens expire/u);
  assert.match(
    generated,
    /official Codex client refreshes\\nthem automatically during active use before they expire/u,
  );
  assert.match(generated, /fixed 10-day lifetime/u);
  assert.match(
    await readFile("docs/troubleshooting.md", "utf8"),
    /If Relmio reports the credential is invalid or refresh no\s+longer succeeds, select \*\*Start ChatGPT sign-in\*\* again in the active local\s+wizard[\s\S]*labels that action \*\*Refresh ChatGPT sign-in\*\*/u,
  );
});

test("local endpoint curl samples keep bearer credentials out of process arguments", async () => {
  const guides = await Promise.all(
    ["docs/local-endpoints.md", "docs/reference.md"].map((path) =>
      readFile(path, "utf8"),
    ),
  );

  for (const guide of guides) {
    assert.doesNotMatch(
      guide,
      /(?:--header|-H) "Authorization: Bearer \$RELMIO_[A-Z_]+"/u,
    );
    assert.match(guide, /printf 'Authorization: Bearer %s\\n'/u);
    assert.match(guide, /(?:--header|-H) @-/u);
  }
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

test("security guidance distinguishes loopback endpoints from the n8n bridge", async () => {
  const security = await readFile("docs/security.md", "utf8");

  assert.match(security, /every raw Codex WebSocket[\s\S]*every Codex Chat Adapter route except `GET \/health`/u);
  assert.match(security, /Chat Adapter rejects every request carrying an `Origin` header/u);
  assert.match(security, /All three long-running loopback endpoint containers/u);
  assert.match(security, /`n8n-openai-oauth` option is a Docker-network-only/u);
  assert.match(security, /local n8n sidecar publishes no host port/u);
  assert.match(security, /local n8n bridge is create\/remove-only/u);
  assert.match(
    security,
    /never edits, executes inside, rebuilds, restarts, stops, recreates, or changes[\s\S]*network membership on n8n/u,
  );
  assert.match(security, /Each Codex target receives its own private named/u);
  assert.match(security, /named read-only permission profile with network[\s\S]*disabled/u);
  assert.match(security, /trusted local backend or development server/u);
  assert.match(security, /not[\s\S]*`\/v1\/chat\/completions`[\s\S]*`\/v1\/responses`/u);
  assert.doesNotMatch(security, /Both long-running endpoint containers/u);
  assert.doesNotMatch(security, /Do not expose either endpoint/u);
  assert.match(security, /In-wizard Chat Adapter tester/u);
  assert.match(security, /not encryption at rest or end-to-end encryption/u);
});

test("public guides link to canonical standalone client credential rotation details", async () => {
  const [readme, npmReadme, localGuide] = await Promise.all([
    readFile("README.md", "utf8"),
    readFile("npm/README.md", "utf8"),
    readFile("docs/local-endpoints.md", "utf8"),
  ]);

  for (const guide of [readme, npmReadme]) {
    assert.match(guide, /https:\/\/relmio\.vercel\.app\/docs\/local-endpoints/u);
  }

  assert.match(localGuide, /previous capability remains active/u);
  assert.match(localGuide, /authenticated Codex WebSocket handshake/u);
  assert.match(localGuide, /preserves the upstream Platform API key/u);
  assert.match(localGuide, /restores the previous verifier and re-attests its\s+health and loopback publication/u);
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

  assert.match(contents, /ChatGPT sign-in is (?:not|never) an\s+OpenAI Platform API key/i);
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

test("troubleshooting explains the Windows WSL Docker Desktop resource failure", async () => {
  const troubleshooting = await readFile("docs/troubleshooting.md", "utf8");
  assert.match(troubleshooting, /0x800705aa/u);
  assert.match(troubleshooting, /wsl --shutdown/u);
  assert.match(troubleshooting, /docker info/u);
});

test("troubleshooting distinguishes the CMD bootstrap from the shared Windows ACL check", async () => {
  const troubleshooting = await readFile("docs/troubleshooting.md", "utf8");
  assert.match(troubleshooting, /for \/f "delims=" %F/u);
  assert.match(troubleshooting, /relmio-install-%RANDOM%-%RANDOM%-%RANDOM%\.cmd/u);
  assert.match(troubleshooting, /--remove-on-error/u);
  assert.match(troubleshooting, /RELMIO_SELF_DELETE=%~F/u);
  assert.doesNotMatch(troubleshooting, /-o install\.cmd/u);
  assert.match(troubleshooting, /Command Prompt bootstrap itself does not call PowerShell/u);
  assert.match(
    troubleshooting,
    /Every native Windows launcher shares this[\s\S]*setup stops\s+before saving secrets/u,
  );
  assert.match(troubleshooting, /Please wait/u);
  assert.match(troubleshooting, /VS Code embedded browser/u);
  assert.match(troubleshooting, /validated manual link/u);
});

test("troubleshooting exposes the tested Homebrew tap while WinGet remains pending", async () => {
  const [troubleshooting, maintainerGuide] = await Promise.all([
    readFile("docs/troubleshooting.md", "utf8"),
    readFile("packaging/package-managers.md", "utf8"),
  ]);
  assert.match(
    troubleshooting,
    /brew tap Demonbane18\/relmio && brew trust --formula Demonbane18\/relmio\/relmio && brew install relmio/u,
  );
  assert.doesNotMatch(troubleshooting, /brew trust Demonbane18\/relmio(?:\s|$)/u);
  assert.match(troubleshooting, /scopes that decision to/u);
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

import assert from "node:assert/strict";
import { access, readFile } from "node:fs/promises";
import test from "node:test";

async function requestApp(path = "/", init = {}) {
  const workerUrl = new URL("../dist/server/index.js", import.meta.url);
  workerUrl.searchParams.set("test", `${process.pid}-${Date.now()}`);
  const { default: worker } = await import(workerUrl.href);

  return worker.fetch(
    new Request(`http://localhost${path}`, {
      ...init,
      headers: { accept: "text/html", ...init.headers },
    }),
    {
      ASSETS: {
        fetch: async () => new Response("Not found", { status: 404 }),
      },
    },
    {
      waitUntil() {},
      passThroughOnException() {},
    },
  );
}

test("server-renders the Relmio product page", async () => {
  const response = await requestApp();
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type") ?? "", /^text\/html\b/i);

  const html = await response.text();
  assert.match(html, /<title>Relmio \| Connect local AI tools safely<\/title>/i);
  assert.match(html, /Use your ChatGPT sign-in with the right local tool\./);
  assert.match(html, /Choose what you are setting up/u);
  assert.match(html, /aria-label="Setup options"/);
  assert.match(html, /aria-pressed="true"/);
  assert.match(html, /n8n with ChatGPT sign-in/);
  assert.match(html, /OpenAI API/);
  assert.match(html, /n8n Code Sandbox/);
  assert.match(html, /Codex Chat Adapter/);
  assert.match(html, /Codex App Server/);
  assert.match(html, /ChatGPT sign-in and Platform API keys do different jobs\./);
  assert.doesNotMatch(html, /OpenAI-shaped workflows you already use/);
  assert.match(html, /Open hosted chat/);
  assert.match(html, /href="\/install"[^>]*>Install Relmio<\/a>/);
  assert.match(html, /href="\/changelog"[^>]*>Changelog<\/a>/);
  assert.match(html, /data-astryx-theme="relmio"/);
  assert.match(html, /aria-label="Color theme"/);
  assert.match(html, /class="[^"]*\btheme-mode-control\b/);
  assert.match(html, /aria-label="System"/);
  assert.match(html, /aria-label="Light"/);
  assert.match(html, /aria-label="Dark"/);
  assert.match(html, /lucide-monitor/);
  assert.match(html, /lucide-sun/);
  assert.match(html, /lucide-moon/);
  assert.doesNotMatch(html, /theme-mode-mobile|<select/u);
  assert.match(html, /class="[^"]*\beditorial-home\b/);
  assert.match(html, /aria-label="n8n with ChatGPT sign-in connection map"/);
  assert.match(html, /Before anything changes/);
  assert.match(html, /What Relmio changes and leaves alone\./);
  assert.match(html, /Connect, then ask\./);
  assert.match(html, /Before you connect: install the browser extension/);
  assert.match(
    html,
    /https:\/\/chromewebstore\.google\.com\/detail\/sign-in-with-chatgpt\/odbgboachaefbbbdiffcefhpkekhfcna/,
  );
  assert.match(
    html,
    /https:\/\/addons\.mozilla\.org\/firefox\/addon\/sign-in-with-chatgpt\//,
  );
  assert.match(html, /temporarily disable it during local sign-in/);
  assert.match(html, /The n8n bridge stays private\./);
  assert.doesNotMatch(html, /npx --yes --ignore-scripts relmio@latest/);
  assert.match(html, /https:\/\/github\.com\/Demonbane18\/relmio/);
  assert.match(html, /class="repository-button"/);
  assert.match(html, /Open Relmio version 0\.11\.0 on GitHub\./);
  assert.match(html, /class="support-button"/);
  assert.match(
    html,
    /href="https:\/\/ko-fi\.com\/paldogies"[^>]*target="_blank"[^>]*rel="noopener noreferrer"[^>]*aria-label="Support Relmio on Ko-fi \(opens in a new tab\)"/,
  );
  assert.match(html, /openai-oauth/);
  assert.match(html, /Evan Zhou Dev/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape/);
});

test("server-renders canonical generated Markdown documentation routes", async () => {
  const [indexResponse, troubleshootingResponse] = await Promise.all([
    requestApp("/docs"),
    requestApp("/docs/troubleshooting"),
  ]);
  assert.equal(indexResponse.status, 200);
  assert.equal(troubleshootingResponse.status, 200);

  const [indexHtml, troubleshootingHtml] = await Promise.all([
    indexResponse.text(),
    troubleshootingResponse.text(),
  ]);
  assert.match(indexHtml, /Relmio documentation/u);
  assert.match(indexHtml, /href="\/docs\/getting-started"/u);
  assert.match(indexHtml, /aria-label="Documentation navigation"/u);
  assert.match(indexHtml, /Find a guide/u);
  assert.match(
    troubleshootingHtml,
    /Canonical guide · Source <code>docs\/troubleshooting\.md<\/code>/u,
  );
  assert.match(troubleshootingHtml, /aria-label="Adjacent documentation"/u);
  assert.match(troubleshootingHtml, /id="local-image-build-failed"/u);
  assert.match(troubleshootingHtml, /Local image build failed/u);
  assert.doesNotMatch(troubleshootingHtml, /dangerouslySetInnerHTML|rehype-raw/u);
});

test("renders a command-first self-hosted n8n install page", async () => {
  const response = await requestApp("/install");
  assert.equal(response.status, 200);

  const [html, installScript, commandPromptInstallScript, powerShellInstallScript, installStyles] = await Promise.all([
    response.text(),
    readFile(new URL("../dist/client/install.sh", import.meta.url), "utf8"),
    readFile(new URL("../dist/client/install.cmd", import.meta.url), "utf8"),
    readFile(new URL("../dist/client/install.ps1", import.meta.url), "utf8"),
    readFile(new URL("../app/install/install.module.css", import.meta.url), "utf8"),
  ]);
  const desktopInstallTabsRule = installStyles.match(
    /\.methodTabs\s*\{(?<declarations>[^}]*)\}/u,
  );
  assert.ok(desktopInstallTabsRule, "expected desktop install tabs rule");
  assert.match(
    desktopInstallTabsRule.groups.declarations,
    /grid-template-columns:\s*repeat\(5,\s*minmax\(0,\s*1fr\)\);/u,
  );
  assert.match(html, /Install Relmio on your computer\./);
  assert.match(html, /data-astryx-theme="relmio"/);
  assert.match(html, /aria-label="Color theme"/);
  assert.match(html, /class="[^"]*\btheme-mode-control\b/);
  assert.match(html, /lucide-monitor/);
  assert.match(html, /lucide-sun/);
  assert.match(html, /lucide-moon/);
  assert.doesNotMatch(html, /theme-mode-mobile|<select/u);
  assert.match(html, /Self-hosted n8n/);
  assert.doesNotMatch(html, /Hostinger VPS/);
  assert.match(html, /class="support-button"/);
  assert.match(html, /https:\/\/ko-fi\.com\/paldogies/);
  assert.match(
    html,
    /The OpenAI-compatible <code>\/v1<\/code> route uses a Platform API key\./,
  );
  assert.match(
    html,
    /ChatGPT sign-in is only for the experimental Codex App Server and Chat Adapter paths\./,
  );
  assert.match(
    html,
    /ChatGPT tokens expire, but the official client refreshes active sessions/,
  );
  assert.match(
    html,
    /href="https:\/\/learn\.chatgpt\.com\/docs\/auth"/,
  );
  assert.match(html, /OpenAI publishes no fixed 10-day lifetime\./);
  assert.match(
    html,
    /curl -fsSL https:\/\/relmio\.vercel\.app\/install\.sh \| sh/,
  );
  assert.match(
    html,
    /brew tap Demonbane18\/relmio &amp;&amp; brew trust --formula Demonbane18\/relmio\/relmio &amp;&amp; brew install relmio/,
  );
  assert.doesNotMatch(html, /brew trust Demonbane18\/relmio(?:\s|&)/);
  assert.doesNotMatch(html, /\bwinget install\b/i);
  assert.match(html, /Homebrew is public/);
  assert.match(html, /trusts only the Relmio formula/);
  assert.match(
    html,
    /irm https:\/\/relmio\.vercel\.app\/install\.ps1 \| iex/,
  );
  assert.match(
    html,
    /for \/f &quot;delims=&quot; %F/,
  );
  assert.match(html, /relmio-install-%RANDOM%-%RANDOM%-%RANDOM%\.cmd/);
  assert.match(html, /--remove-on-error/);
  assert.match(html, /RELMIO_SELF_DELETE=%~F/);
  assert.doesNotMatch(html, /-o install\.cmd/);
  assert.match(html, /npx --yes --ignore-scripts relmio@latest/);
  assert.match(html, /role="tablist"[^>]*aria-label="Installation method"/);
  assert.match(html, /role="tab"[^>]*aria-selected="true"[^>]*>[^<]*macOS \/ Linux/);
  assert.match(html, /role="tab"[^>]*aria-selected="false"[^>]*>[^<]*Homebrew/);
  assert.doesNotMatch(html, /role="tab"[^>]*>[^<]*WinGet/);
  assert.match(html, /role="tab"[^>]*aria-selected="false"[^>]*>[^<]*PowerShell/);
  assert.match(html, /role="tab"[^>]*aria-selected="false"[^>]*>[^<]*CMD/);
  assert.match(html, /role="tab"[^>]*aria-selected="false"[^>]*>[^<]*NPX/);
  assert.match(html, /macOS, Linux, WSL, or Git Bash/);
  assert.match(html, /No Git Bash or preinstalled Node\.js required/);
  assert.match(html, /For Command Prompt, not PowerShell/);
  assert.match(html, /non-admin bootstrap verifies a temporary runtime/);
  assert.match(html, /already has Node\.js 22 or newer/);
  assert.match(html, /WinGet remains hidden until Microsoft accepts[^<]*catalog pull request/);
  assert.match(html, /Copy macOS \/ Linux installation command/);
  assert.match(html, /title="Copy macOS \/ Linux installation command"/);
  assert.match(html, /aria-live="polite"/);
  assert.doesNotMatch(html, /<span role="status"[^>]*>Copy<\/span>/);
  assert.match(html, /Choose an installation method/);
  assert.match(html, /Run Relmio on your own computer/);
  assert.doesNotMatch(html, /href="https:\/\/www\.npmjs\.com/);
  assert.match(installScript, /^#!\/bin\/sh/m);
  assert.match(installScript, /Node\.js download checksum did not match/);
  assert.match(installScript, /--ignore-scripts relmio@latest/);
  assert.doesNotMatch(commandPromptInstallScript, /powershell|pwsh/iu);
  assert.match(commandPromptInstallScript, /certutil\.exe/u);
  assert.match(commandPromptInstallScript, /Node\.js download checksum did not match/u);
  assert.match(commandPromptInstallScript, /--ignore-scripts relmio@latest/u);
  assert.match(powerShellInstallScript, /Get-FileHash/);
  assert.match(powerShellInstallScript, /Node\.js download checksum did not match/);
  assert.match(powerShellInstallScript, /--ignore-scripts/);
});

test("renders the generated repository changelog as a hosted release-notes page", async () => {
  const response = await requestApp("/changelog");
  assert.equal(response.status, 200);

  const html = await response.text();
  assert.match(html, /<title>Changelog \| Relmio<\/title>/u);
  assert.match(html, /Release notes/u);
  assert.match(html, /What changed, in plain language\./u);
  assert.match(html, /href="#changelog-content"[^>]*>Skip to release notes<\/a>/u);
  assert.match(html, /0\.10\.0/u);
  assert.match(html, /0\.9\.1/u);
  assert.match(html, /href="\/docs"[^>]*>Docs<\/a>/u);
});

test("returns current repository stars and npm version for the GitHub control", async (t) => {
  t.mock.method(globalThis, "fetch", async (input) => {
    const url = String(input);
    if (url.includes("api.github.com/repos/Demonbane18/relmio")) {
      return Response.json({ stargazers_count: 42 });
    }
    if (url.includes("registry.npmjs.org/relmio/latest")) {
      return Response.json({ version: "0.2.1" });
    }
    return new Response("Not found", { status: 404 });
  });

  const response = await requestApp("/api/project-meta");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    stars: 42,
    version: "0.2.1",
  });
  assert.match(response.headers.get("cache-control") ?? "", /s-maxage=900/);
});

test("falls back safely when project metadata is malformed", async (t) => {
  t.mock.method(
    globalThis,
    "fetch",
    async () =>
      new Response("{", {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
  );

  const response = await requestApp("/api/project-meta");
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    stars: null,
    version: "0.11.0",
  });
});

test("keeps web metadata fallbacks synchronized with the prepared release version", async () => {
  const [rootPackage, versionSource, routeSource, repositoryButton] = await Promise.all([
    readFile(new URL("../../package.json", import.meta.url), "utf8"),
    readFile(new URL("../app/project-version.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/api/project-meta/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/components/RepositoryButton.tsx", import.meta.url), "utf8"),
  ]);
  const preparedVersion = JSON.parse(rootPackage).version;

  assert.match(versionSource, new RegExp(`preparedReleaseVersion = "${preparedVersion}"`, "u"));
  assert.match(routeSource, /import \{ preparedReleaseVersion \} from "\.\.\/\.\.\/project-version"/u);
  assert.match(routeSource, /const fallbackVersion = preparedReleaseVersion/u);
  assert.match(repositoryButton, /import \{ preparedReleaseVersion \} from "\.\.\/project-version"/u);
  assert.match(repositoryButton, /version: preparedReleaseVersion/u);
  assert.doesNotMatch(`${routeSource}\n${repositoryButton}`, /0\.7\.0/u);
});

test("rejects non-string chat prompts before reading credentials", async () => {
  const response = await requestApp("/api/chat", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ prompt: { unexpected: true } }),
  });

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), {
    error: "The prompt must be a string.",
  });
});

test("streams chat over Relmio's explicit terminal-state protocol without proxy buffering", async () => {
  const [chatConsole, chatRoute, streamReader] = await Promise.all([
    readFile(new URL("../app/components/ChatConsole.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/chat/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/components/relmio-stream.js", import.meta.url), "utf8"),
  ]);

  assert.doesNotMatch(chatConsole, /useCompletion/u);
  assert.match(chatConsole, /readRelmioEvents/u);
  assert.match(streamReader, /ReadableStream|getReader/u);
  assert.match(chatRoute, /createOpenAIOAuthTransport/u);
  assert.match(chatRoute, /encodeEvent\("delta"/u);
  assert.match(chatRoute, /encodeEvent\("terminal"/u);
  assert.match(chatRoute, /"Content-Encoding":\s*"none"/u);
});

test("returns a streaming error event instead of an empty completion", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    Response.json(
      { error: { message: "private upstream detail" } },
      { status: 401 },
    ),
  );
  t.mock.method(console, "error", () => {});

  const response = await requestApp("/api/chat", {
    method: "POST",
    headers: {
      authorization: "Bearer test-token",
      "chatgpt-account-id": "test-account",
      "content-type": "application/json",
    },
    body: JSON.stringify({ prompt: "hello" }),
  });

  assert.equal(response.status, 200);
  assert.equal(response.headers.get("content-type"), "text/event-stream");
  assert.equal(response.headers.get("content-encoding"), "none");
  assert.equal(response.headers.get("x-relmio-stream"), "v1");

  const stream = await response.text();
  assert.match(stream, /event: error/u);
  assert.match(
    stream,
    /"code":"upstream_failed"/u,
  );
  assert.match(stream, /event: terminal\ndata: \{"outcome":"failed"\}/u);
  assert.doesNotMatch(stream, /private upstream detail/u);
});

test("identifies a ChatGPT challenge against the hosting network", async (t) => {
  t.mock.method(globalThis, "fetch", async () =>
    new Response("<html>private challenge body</html>", {
      status: 403,
      headers: {
        "cf-mitigated": "challenge",
        "content-type": "text/html",
      },
    }),
  );
  t.mock.method(console, "error", () => {});

  const response = await requestApp("/api/chat", {
    method: "POST",
    headers: {
      authorization: "Bearer test-token",
      "chatgpt-account-id": "test-account",
      "content-type": "application/json",
    },
    body: JSON.stringify({ prompt: "hello" }),
  });

  assert.equal(response.status, 200);
  const stream = await response.text();
  assert.match(stream, /event: error/u);
  assert.match(
    stream,
    /"code":"hosting_network_blocked"/u,
  );
  assert.doesNotMatch(stream, /private challenge body|test-token/u);
});

test("forwards incremental model text as separate chat stream events", async (t) => {
  const upstreamEvents = [
    {
      type: "response.created",
      response: { id: "response-test", created_at: 1, model: "gpt-5.4-mini" },
    },
    {
      type: "response.output_item.added",
      output_index: 0,
      item: { type: "message", id: "message-test", phase: "final_answer" },
    },
    {
      type: "response.output_text.delta",
      item_id: "message-test",
      delta: "Hello",
    },
    {
      type: "response.output_text.delta",
      item_id: "message-test",
      delta: " world",
    },
    {
      type: "response.output_item.done",
      output_index: 0,
      item: { type: "message", id: "message-test", phase: "final_answer" },
    },
    {
      type: "response.completed",
      response: {
        usage: {
          input_tokens: 1,
          input_tokens_details: { cached_tokens: 0 },
          output_tokens: 2,
          output_tokens_details: { reasoning_tokens: 0 },
        },
      },
    },
  ];
  const upstreamStream = `${upstreamEvents
    .map((event) => `data: ${JSON.stringify(event)}\n\n`)
    .join("")}data: [DONE]\n\n`;

  t.mock.method(globalThis, "fetch", async (input) =>
    String(input).includes("/responses")
      ? new Response(upstreamStream, {
          headers: { "content-type": "text/event-stream" },
        })
      : Response.json(
          { error: { message: "Model catalog unavailable in this test." } },
          { status: 503 },
        ),
  );

  const response = await requestApp("/api/chat", {
    method: "POST",
    headers: {
      authorization: "Bearer test-token",
      "chatgpt-account-id": "test-account",
      "content-type": "application/json",
    },
    body: JSON.stringify({ prompt: "hello" }),
  });

  assert.equal(response.status, 200);
  const stream = await response.text();
  assert.match(stream, /event: delta\ndata: \{"text":"Hello"\}/u);
  assert.match(stream, /event: delta\ndata: \{"text":" world"\}/u);
  assert.ok(stream.indexOf('"text":"Hello"') < stream.indexOf('"text":" world"'));
  assert.match(stream, /event: terminal\ndata: \{"outcome":"completed"\}/u);
  assert.doesNotMatch(stream, /response-test|message-test/u);
});

for (const terminalType of [
  "response.failed",
  "response.incomplete",
  "response.cancelled",
  "response.canceled",
]) {
  test(`turns ${terminalType} into one redacted failed terminal outcome`, async (t) => {
    const privateDetail = `private-${terminalType}-detail`;
    const upstreamStream = [
      `data: ${JSON.stringify({
        type: "response.created",
        response: { id: "response-private", created_at: 1, model: "gpt-5.4-mini" },
      })}\n\n`,
      `data: ${JSON.stringify({
        type: terminalType,
        response: {
          id: "response-private",
          status: terminalType.slice("response.".length),
          error: { message: privateDetail },
          incomplete_details: { reason: privateDetail },
        },
      })}\n\n`,
      "data: [DONE]\n\n",
    ].join("");

    t.mock.method(globalThis, "fetch", async (input) =>
      String(input).includes("/responses")
        ? new Response(upstreamStream, {
            headers: { "content-type": "text/event-stream" },
          })
        : Response.json({ data: [] }),
    );

    const response = await requestApp("/api/chat", {
      method: "POST",
      headers: {
        authorization: "Bearer test-token",
        "chatgpt-account-id": "test-account",
        "content-type": "application/json",
      },
      body: JSON.stringify({ prompt: "What is a robot?" }),
    });

    assert.equal(response.status, 200);
    const stream = await response.text();
    assert.equal((stream.match(/event: error/gu) ?? []).length, 1);
    assert.equal((stream.match(/event: terminal/gu) ?? []).length, 1);
    assert.match(stream, /"code":"upstream_failed"/u);
    assert.match(stream, /"outcome":"failed"/u);
    assert.doesNotMatch(stream, new RegExp(privateDetail, "u"));
    assert.doesNotMatch(stream, /response-private|test-token/u);
  });
}

test("fails a terminal-less upstream stream instead of reporting empty success", async (t) => {
  t.mock.method(globalThis, "fetch", async (input) =>
    String(input).includes("/responses")
      ? new Response(
          `data: ${JSON.stringify({
            type: "response.created",
            response: { id: "private-id", created_at: 1, model: "gpt-5.4-mini" },
          })}\n\n`,
          { headers: { "content-type": "text/event-stream" } },
        )
      : Response.json({ data: [] }),
  );

  const response = await requestApp("/api/chat", {
    method: "POST",
    headers: {
      authorization: "Bearer test-token",
      "chatgpt-account-id": "test-account",
      "content-type": "application/json",
    },
    body: JSON.stringify({ prompt: "What is love?" }),
  });

  const stream = await response.text();
  assert.match(stream, /event: error/u);
  assert.match(stream, /"code":"upstream_failed"/u);
  assert.match(stream, /event: terminal\ndata: \{"outcome":"failed"\}/u);
  assert.doesNotMatch(stream, /private-id/u);
});

test("ships the request-bound chat and removes starter assets", async () => {
  const [chatConsole, chatStyles, chatRoute, layout, packageJson] = await Promise.all([
    readFile(new URL("../app/components/ChatConsole.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/components/ChatConsole.module.css", import.meta.url), "utf8"),
    readFile(new URL("../app/api/chat/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);

  assert.match(chatConsole, /openaiAuthHeaders/u);
  assert.match(chatConsole, /SignInWithChatGPT/u);
  assert.match(chatConsole, /styles\.messageIncomplete/u);
  assert.match(chatConsole, /Relmio · incomplete/u);
  assert.match(chatConsole, /<HStack className="console-statuses"/u);
  assert.match(chatStyles, /\.messageIncomplete\s*\{[\s\S]*var\(--relay-amber,[^)]*--color-border-orange/u);
  assert.match(chatStyles, /\.messageIncomplete p,[\s\S]*\.messageIncomplete span\s*\{[\s\S]*color:\s*var\(--color-text-orange\)/u);
  assert.match(chatRoute, /openaiCredentials\(request\)/u);
  assert.match(chatRoute, /Cache-Control": "no-store"/u);
  assert.match(layout, /Relmio \| Connect local AI tools safely/u);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/u);
  await assert.rejects(
    access(new URL("../app/_sites-preview", import.meta.url)),
  );
});

test("returns hosted ChatGPT callbacks to the active deployment origin", async () => {
  const chatConsole = await readFile(
    new URL("../app/components/ChatConsole.tsx", import.meta.url),
    "utf8",
  );

  assert.doesNotMatch(chatConsole, /callbackPath=/u);
  assert.doesNotMatch(chatConsole, /relmio\.jpfusin\.tech/u);
});

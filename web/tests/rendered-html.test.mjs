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
  assert.match(
    html,
    /<title>Relmio \| Your ChatGPT plan, safely relayed<\/title>/i,
  );
  assert.match(html, /data-design-contract="c4426c7c"/);
  assert.match(html, /Your ChatGPT plan, safely relayed\./);
  assert.match(html, /Your private route/);
  assert.match(html, /Your computer/);
  assert.match(html, /SSH host check/);
  assert.match(html, /Existing n8n network/);
  assert.match(html, /Private sidecar/);
  assert.match(html, /Remote writes begin only after your review\./);
  assert.match(html, /Boundaries you can verify/);
  assert.match(html, /Existing n8n stays untouched/);
  assert.match(html, /No public VPS port/);
  assert.match(html, /Tokens are not logged/);
  assert.match(html, /Remote writes require confirmation/);
  assert.match(html, /One route\. Five deliberate gates\./);
  assert.doesNotMatch(html, /OpenAI-shaped workflows you already use/);
  assert.doesNotMatch(html, /One clean path to your tools\./);
  assert.match(html, /Try hosted chat/);
  assert.match(
    html,
    /href="\/install"[^>]*>.*?Run local wizard.*?<\/a>/,
  );
  assert.match(html, /A request-bound test lane\./);
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
  assert.match(html, /The boundary is part of the product\./);
  assert.match(html, /astryx-/);
  assert.doesNotMatch(html, /npx --yes --ignore-scripts relmio@latest/);
  assert.match(html, /https:\/\/github\.com\/Demonbane18\/relmio/);
  assert.match(html, /openai-oauth/);
  assert.match(html, /Evan Zhou Dev/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape/);
});

test("renders a command-first n8n and Hostinger VPS install page", async () => {
  const response = await requestApp("/install");
  assert.equal(response.status, 200);

  const [html, installScript, powerShellInstallScript] = await Promise.all([
    response.text(),
    readFile(new URL("../dist/client/install.sh", import.meta.url), "utf8"),
    readFile(new URL("../dist/client/install.ps1", import.meta.url), "utf8"),
  ]);
  assert.match(html, /Your local route starts here\./);
  assert.match(html, /Five gates, one deliberate install\./);
  assert.match(html, /Hostinger VPS/);
  assert.match(
    html,
    /curl -fsSL https:\/\/relmio\.vercel\.app\/install\.sh \| sh/,
  );
  assert.match(
    html,
    /irm https:\/\/relmio\.vercel\.app\/install\.ps1 \| iex/,
  );
  assert.match(
    html,
    /powershell -NoProfile -ExecutionPolicy Bypass -Command &quot;irm https:\/\/relmio\.vercel\.app\/install\.ps1 \| iex&quot;/,
  );
  assert.match(html, /npx --yes --ignore-scripts relmio@latest/);
  assert.match(html, /role="tablist"[^>]*aria-label="Local terminal"/);
  assert.match(html, /role="tab"[^>]*aria-selected="true"[^>]*>[^<]*macOS \/ Linux/);
  assert.match(html, /role="tab"[^>]*aria-selected="false"[^>]*>[^<]*PowerShell/);
  assert.match(html, /role="tab"[^>]*aria-selected="false"[^>]*>[^<]*CMD/);
  assert.match(html, /role="tab"[^>]*aria-selected="false"[^>]*>[^<]*NPX/);
  assert.match(html, /macOS, Linux, WSL, or Git Bash/);
  assert.match(html, /No Git Bash or preinstalled Node\.js required/);
  assert.match(html, /Open Command Prompt, not PowerShell/);
  assert.match(html, /NPX requires Node\.js 22 or newer/);
  assert.match(html, /Copy installation command/);
  assert.match(html, /Run this on your own computer/);
  assert.match(html, /Confirm the SSH fingerprint/);
  assert.match(html, /See every remote write/);
  assert.match(html, /Create the private sidecar/);
  assert.doesNotMatch(html, /href="https:\/\/www\.npmjs\.com/);
  assert.match(installScript, /^#!\/bin\/sh/m);
  assert.match(installScript, /Node\.js download checksum did not match/);
  assert.match(installScript, /--ignore-scripts relmio@latest/);
  assert.match(powerShellInstallScript, /Get-FileHash/);
  assert.match(powerShellInstallScript, /Node\.js download checksum did not match/);
  assert.match(powerShellInstallScript, /--ignore-scripts/);
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
    version: "0.2.1",
  });
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

test("streams chat over the UI message protocol without proxy buffering", async () => {
  const [chatConsole, chatRoute] = await Promise.all([
    readFile(new URL("../app/components/ChatConsole.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/chat/route.ts", import.meta.url), "utf8"),
  ]);

  assert.doesNotMatch(chatConsole, /streamProtocol:\s*"text"/u);
  assert.match(chatRoute, /toUIMessageStreamResponse/u);
  assert.match(chatRoute, /"Content-Encoding":\s*"none"/u);
  assert.match(chatRoute, /onError:\s*streamErrorMessage/u);
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
  assert.equal(response.headers.get("x-vercel-ai-ui-message-stream"), "v1");

  const stream = await response.text();
  assert.match(stream, /"type":"error"/u);
  assert.match(
    stream,
    /The response stream failed\. Reconnect ChatGPT and try again\./u,
  );
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
  assert.match(stream, /"type":"error"/u);
  assert.match(
    stream,
    /ChatGPT blocked requests from this hosting network\./u,
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
  assert.match(stream, /"type":"text-delta".*"delta":"Hello"/u);
  assert.match(stream, /"type":"text-delta".*"delta":" world"/u);
  assert.ok(stream.indexOf('"delta":"Hello"') < stream.indexOf('"delta":" world"'));
  assert.match(stream, /data: \[DONE\]/u);
});

test("ships the request-bound chat and removes starter assets", async () => {
  const [chatConsole, chatRoute, layout, packageJson, providers, theme, styles] =
    await Promise.all([
      readFile(
        new URL("../app/components/ChatConsole.tsx", import.meta.url),
        "utf8",
      ),
      readFile(new URL("../app/api/chat/route.ts", import.meta.url), "utf8"),
      readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
      readFile(new URL("../package.json", import.meta.url), "utf8"),
      readFile(new URL("../app/providers.tsx", import.meta.url), "utf8"),
      readFile(new URL("../app/relmio-theme.ts", import.meta.url), "utf8"),
      readFile(new URL("../app/globals.css", import.meta.url), "utf8"),
    ]);

  const packageMetadata = JSON.parse(packageJson);

  assert.match(chatConsole, /openaiAuthHeaders/u);
  assert.match(chatConsole, /SignInWithChatGPT/u);
  assert.match(chatRoute, /openaiCredentials\(request\)/u);
  assert.match(chatRoute, /Cache-Control": "no-store"/u);
  assert.match(layout, /Relmio \| Your ChatGPT plan, safely relayed/u);
  assert.match(layout, /data-design-contract="c4426c7c"/u);
  assert.match(providers, /@astryxdesign\/core\/theme/u);
  assert.match(providers, /@astryxdesign\/core\/Link/u);
  assert.match(providers, /relmioTheme/u);
  assert.match(theme, /defineTheme/u);
  assert.match(theme, /extends:\s*neutralTheme/u);
  assert.match(styles, /@astryxdesign\/core\/reset\.css/u);
  assert.match(styles, /@astryxdesign\/core\/astryx\.css/u);
  assert.match(styles, /@astryxdesign\/theme-neutral\/theme\.css/u);
  assert.equal(packageMetadata.dependencies["@astryxdesign/core"], "0.2.0");
  assert.equal(
    packageMetadata.dependencies["@astryxdesign/theme-neutral"],
    "0.2.0",
  );
  assert.equal(packageMetadata.devDependencies["@astryxdesign/cli"], "0.2.0");
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

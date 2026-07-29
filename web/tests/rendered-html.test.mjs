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
  assert.match(html, /<title>Relmio — Your ChatGPT plan, relayed<\/title>/i);
  assert.match(html, /Your ChatGPT plan\./);
  assert.match(html, /One clean path to your tools\./);
  assert.match(html, /Try the secure chat/);
  assert.match(html, /Connect, then ask\./);
  assert.match(html, /Private where it matters\./);
  assert.match(html, /npx --yes --ignore-scripts relmio@latest/);
  assert.match(html, /https:\/\/github\.com\/Demonbane18\/n8n-openai-oauth-setup/);
  assert.doesNotMatch(html, /codex-preview|Your site is taking shape/);
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

test("ships the request-bound chat and removes starter assets", async () => {
  const [chatConsole, chatRoute, layout, packageJson] = await Promise.all([
    readFile(new URL("../app/components/ChatConsole.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/chat/route.ts", import.meta.url), "utf8"),
    readFile(new URL("../app/layout.tsx", import.meta.url), "utf8"),
    readFile(new URL("../package.json", import.meta.url), "utf8"),
  ]);

  assert.match(chatConsole, /openaiAuthHeaders/u);
  assert.match(chatConsole, /SignInWithChatGPT/u);
  assert.match(chatRoute, /openaiCredentials\(request\)/u);
  assert.match(chatRoute, /Cache-Control": "no-store"/u);
  assert.match(layout, /Relmio — Your ChatGPT plan, relayed/u);
  assert.doesNotMatch(packageJson, /react-loading-skeleton/u);
  await assert.rejects(
    access(new URL("../app/_sites-preview", import.meta.url)),
  );
});

test("pins hosted ChatGPT callbacks to the custom Relmio domain", async () => {
  const chatConsole = await readFile(
    new URL("../app/components/ChatConsole.tsx", import.meta.url),
    "utf8",
  );

  assert.match(
    chatConsole,
    /const hostedChatCallbackUrl = "https:\/\/relmio\.jpfusin\.tech\/";/u,
  );
  assert.match(chatConsole, /callbackPath=\{hostedChatCallbackUrl\}/u);
});

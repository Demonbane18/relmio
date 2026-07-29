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

test("streams chat over the UI message protocol without proxy buffering", async () => {
  const [chatConsole, chatRoute] = await Promise.all([
    readFile(new URL("../app/components/ChatConsole.tsx", import.meta.url), "utf8"),
    readFile(new URL("../app/api/chat/route.ts", import.meta.url), "utf8"),
  ]);

  assert.doesNotMatch(chatConsole, /streamProtocol:\s*"text"/u);
  assert.match(chatRoute, /toUIMessageStreamResponse/u);
  assert.match(chatRoute, /"Content-Encoding":\s*"none"/u);
  assert.match(chatRoute, /onError:\s*\(\)\s*=>/u);
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

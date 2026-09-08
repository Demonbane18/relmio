import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createOpenAIOAuthFetchHandler } from "openai-oauth";
import { createSidecarHandler, createSidecarServer } from "../src/gateway/openai-oauth-sidecar.mjs";
import { createDockerfile } from "../src/domain/templates.js";
import { createLocalN8nSidecarDockerfile, createLocalN8nSidecarDockerignore } from "../src/domain/local-n8n-sidecar.js";

// n8n OpenAI v2 createRequest, with default options and a user text message.
const n8nRequest = {
  model: "gpt-6-astra",
  input: [{ role: "user", content: [{ type: "input_text", text: "Hello" }] }],
  parallel_tool_calls: true, store: true, background: false,
};
const completed = {
  id: "resp_test", object: "response", status: "completed", model: "gpt-6-astra",
  output: [{ id: "msg_test", type: "message", role: "assistant", status: "completed",
    content: [{ type: "output_text", text: "Hello!", annotations: [] }] }],
  usage: { input_tokens: 3, output_tokens: 2, total_tokens: 5 },
};
const eventStream = `event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: completed })}\n\n`;

function request(body = n8nRequest, path = "/v1/responses", method = "POST") {
  return new Request(`http://sidecar.test${path}`, {
    method, headers: { "content-type": "application/json" },
    ...(!["GET", "HEAD"].includes(method) && { body: JSON.stringify(body) }),
  });
}

async function runtime(t, fetchOverride) {
  const dir = await mkdtemp(join(tmpdir(), "relmio-oauth-contract-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const authFilePath = join(dir, "auth.json");
  await writeFile(authFilePath, JSON.stringify({ tokens: { access_token: "test-only", account_id: "test-account" } }), { mode: 0o600 });
  const calls = [];
  const upstream = createOpenAIOAuthFetchHandler({
    authFilePath,
    fetch: async (url, init) => {
      const pathname = new URL(url).pathname;
      if (pathname.endsWith("/models")) {
        return Response.json({ models: [{ slug: "gpt-6-astra", display_name: "GPT-6-ASTRA", visibility: "list", supported_in_api: true }] });
      }
      const body = JSON.parse(init.body);
      calls.push({ pathname, body });
      if (fetchOverride) return fetchOverride(url, init, body);
      if (Object.hasOwn(body, "background")) {
        return Response.json({ detail: "Unsupported parameter: background" }, { status: 400 });
      }
      return new Response(eventStream, { headers: { "content-type": "text/event-stream" } });
    },
  });
  return { upstream, handler: createSidecarHandler(upstream), calls };
}

test("pinned transport reproduces n8n background rejection before the adapter", async (t) => {
  const { upstream } = await runtime(t);
  const response = await upstream(request());
  assert.equal(response.status, 400);
  assert.equal((await response.json()).detail, "Unsupported parameter: background");
});

test("n8n Message a Model receives decoded output for Simplify Output on or off", async (t) => {
  const { handler, calls } = await runtime(t);
  const response = await handler(request());
  assert.equal(response.status, 200);
  assert.match(response.headers.get("content-type"), /application\/json/u);
  const body = await response.json();
  assert.deepEqual(body, completed); // Simplify Output off.
  assert.deepEqual(body.output, completed.output); // n8n Simplify Output on.
  assert.equal(Object.hasOwn(calls[0].body, "background"), false);
  assert.equal(calls[0].body.store, false);
  assert.equal(calls[0].body.stream, true);
  assert.deepEqual(calls[0].body.input, n8nRequest.input);
  assert.equal(n8nRequest.background, false);
});

test("n8n Analyze Image URL and binary request shapes survive the pinned transport", async (t) => {
  const { handler, calls } = await runtime(t);
  const images = [
    "https://example.invalid/image.png",
    "data:image/png;base64,dGVzdA==",
  ];
  for (const imageUrl of images) {
    const body = {
      model: "gpt-6-astra",
      input: [{ role: "user", content: [
        { type: "input_text", text: "Describe the image" },
        { type: "input_image", image_url: imageUrl, detail: "auto" },
      ] }],
      max_output_tokens: 300,
    };
    const response = await handler(request(body));
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).output, completed.output);
  }
  assert.deepEqual(calls.map(({ body }) => body.input[0].content[1]), [
    { type: "input_image", image_url: images[0], detail: "auto" },
    { type: "input_image", image_url: images[1], detail: "auto" },
  ]);
  assert.ok(calls.every(({ body }) => !Object.hasOwn(body, "max_output_tokens")));
  assert.ok(calls.every(({ body }) => body.store === false));
});

test("explicit background and stored state fail before any provider call", async (t) => {
  const { handler, calls } = await runtime(t);
  for (const extra of [{ background: true }, { background: "false" }, { conversation: "conv_123" }, { previous_response_id: "resp_123" }, { input: [{ type: "item_reference", id: "msg_123" }] }]) {
    const response = await handler(request({ ...n8nRequest, ...extra }));
    assert.equal(response.status, 400);
    assert.ok((await response.json()).error.message);
  }
  assert.deepEqual(calls, []);
});

test("every unsupported n8n action family returns a specific OAuth error before the pinned handler", async (t) => {
  const { handler, calls } = await runtime(t);
  const unsupported = [
    ["POST", "/v1/audio/speech", "audio"],
    ["POST", "/v1/audio/transcriptions", "audio"],
    ["POST", "/v1/audio/translations", "audio"],
    ["POST", "/v1/files", "files"],
    ["GET", "/v1/files", "files"],
    ["DELETE", "/v1/files/file_123", "files"],
    ["POST", "/v1/conversations", "conversations"],
    ["GET", "/v1/conversations/conv_123", "conversations"],
    ["POST", "/v1/conversations/conv_123", "conversations"],
    ["DELETE", "/v1/conversations/conv_123", "conversations"],
    ["POST", "/v1/moderations", "moderations"],
    ["POST", "/v1/videos", "videos"],
    ["POST", "/v1/responses/resp_123", null],
  ];
  for (const [method, path, param] of unsupported) {
    const response = await handler(request({}, path, method));
    assert.equal(response.status, 501, `${method} ${path}`);
    const body = await response.json();
    assert.equal(body.error.code, "unsupported_oauth_feature");
    assert.equal(body.error.param, param);
    assert.match(body.error.message, /ChatGPT OAuth|stored responses/u);
  }
  assert.deepEqual(calls, []);
});

test("unsupported route boundaries do not capture similarly named paths", async (t) => {
  const { handler } = await runtime(t);
  for (const path of ["/v1/videosomething", "/v1/moderations-old", "/v1/filesystem", "/v1/audiofile", "/v1/conversations-old"]) {
    const response = await handler(request({}, path));
    assert.equal(response.status, 404, path);
    assert.notEqual((await response.json()).error.code, "unsupported_oauth_feature");
  }
});

test("invalid Responses JSON and non-object bodies return client errors", async () => {
  const handler = createSidecarHandler(() => assert.fail("must not forward"));
  for (const body of ["{", "null", "[]", '"hello"']) {
    const response = await handler(new Request("http://sidecar.test/v1/responses", { method: "POST", body }));
    assert.equal(response.status, 400);
  }
});

test("n8n GPT Image generation preserves image background and binary result", async (t) => {
  const image = { created: 123, data: [{ b64_json: "dGVzdA==" }] };
  const { handler, calls } = await runtime(t, () => Response.json(image));
  const response = await handler(request({ model: "gpt-image-2", prompt: "A blue square", background: "opaque", quality: "low", n: 1 }, "/v1/images/generations"));
  assert.deepEqual(await response.json(), image);
  assert.equal(calls[0].body.background, "opaque");
  assert.equal(calls[0].body.model, "gpt-image-2");
});

test("n8n image editing preserves multipart reference images", async (t) => {
  const { handler, calls } = await runtime(t, () => Response.json({ data: [{ b64_json: "dGVzdA==" }] }));
  const form = new FormData();
  form.set("model", "gpt-image-2");
  form.set("prompt", "Make it blue");
  form.set("image", new Blob(["test"], { type: "image/png" }), "image.png");
  const response = await handler(new Request("http://sidecar.test/v1/images/edits", { method: "POST", body: form }));
  assert.equal(response.status, 200);
  assert.deepEqual(calls[0].body.images, [{ image_url: "data:image/png;base64,dGVzdA==" }]);
});

test("image URL output stays explicitly unsupported instead of changing output type", async (t) => {
  const { handler, calls } = await runtime(t);
  const response = await handler(request({ model: "gpt-image-2", prompt: "A square", response_format: "url" }, "/v1/images/generations"));
  assert.equal(response.status, 400);
  assert.match((await response.json()).error.message, /b64_json/u);
  assert.deepEqual(calls, []);
});

test("Chat Completions, models and health still use the existing handler", async () => {
  const paths = [];
  const handler = createSidecarHandler(async (req) => {
    paths.push(new URL(req.url).pathname);
    return Response.json({ ok: true });
  });
  for (const path of ["/v1/chat/completions", "/v1/models", "/health"]) {
    assert.equal((await handler(request({}, path))).status, 200);
  }
  assert.deepEqual(paths, ["/v1/chat/completions", "/v1/models", "/health"]);
});

test("both sidecar build paths launch the same packaged adapter", async () => {
  for (const dockerfile of [createDockerfile(), createLocalN8nSidecarDockerfile({ installId: "a".repeat(32) })]) {
    assert.match(dockerfile, /COPY --chown=node:node openai-oauth-sidecar\.mjs \/app\/openai-oauth-sidecar\.mjs/u);
    assert.match(dockerfile, /ENTRYPOINT \["node", "\/app\/openai-oauth-sidecar\.mjs"\]/u);
    assert.match(dockerfile, /openai-oauth@2\.0\.0/u);
  }
  assert.match(createLocalN8nSidecarDockerignore(), /^!openai-oauth-sidecar\.mjs$/mu);
  assert.match(await readFile(new URL("../src/gateway/openai-oauth-sidecar.mjs", import.meta.url), "utf8"), /createOpenAIOAuthFetchHandler/u);
});

test("HTTP server carries the n8n JSON request and response through the adapter", async (t) => {
  const { handler } = await runtime(t);
  const server = createSidecarServer(handler);
  await new Promise((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", resolve); });
  t.after(() => new Promise((resolve) => { server.close(resolve); server.closeAllConnections(); }));
  const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/responses`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(n8nRequest),
  });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), completed);
});

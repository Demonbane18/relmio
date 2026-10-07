import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { CODEX_CLI_VERSION, createSidecarHandler, createSidecarServer, listSiwcModels } from "../src/gateway/openai-oauth-sidecar.mjs";

const credential = "local_client_credential_123456789";
const verifier = createHash("sha256").update(credential).digest();
// Resolved like the container's root: the image store refuses an unresolved one, and Windows resolves "/tmp/..." onto a drive.
const registration = { storageRoot: resolve("/tmp/test-siwc"), registrationId: "first" };
const terminal = (type, response) => `event: ${type}\ndata: ${JSON.stringify({ type, response })}\n\n`;
const completed = { id: "resp_1", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "Hello" }] }] };
const fakeDiscovery = (listModels = async () => ({ models: [], clientVersion: CODEX_CLI_VERSION, checksEnabled: false }), recordOutcome) => {
  const outcomes = [];
  return { outcomes, listModels, recordOutcome: recordOutcome ?? (async (outcome) => { outcomes.push(outcome); }) };
};
const fake = (onFetch = () => new Response(terminal("response.completed", completed), { headers: { "content-type": "text/event-stream" } }),
  { discovery = fakeDiscovery(), imagesStatus = async () => ({ state: "off" }), now } = {}) => {
  const calls = [];
  const tokenCalls = [];
  const handler = createSidecarHandler({ registration, runtimeId: "runtime-1", tokenVerifier: verifier, discovery, imagesStatus, now,
    getToken: async (selected, options) => { tokenCalls.push(selected); assert.deepEqual(selected, registration); assert.equal(options.runtimeId, "runtime-1"); return { accessToken: "provider-token" }; },
    fetchImpl: async (url, options) => { calls.push({ url, options }); return onFetch(url, options); },
  });
  return { handler, calls, tokenCalls, discovery };
};
function request(path, body, headers = {}) {
  return new Request(`http://local.test${path}`, { method: body === undefined ? "GET" : "POST", headers: { host: "n8n-openai-oauth:10531", authorization: `Bearer ${credential}`, ...headers }, ...(body !== undefined && { body: JSON.stringify(body) }) });
}

test("per-request local bearer gates all provider traffic and never leaks upstream", async () => {
  const { handler, calls } = fake();
  for (const path of ["/v1/models", "/v1/responses", "/v1/chat/completions", "/v1/images/generations"]) {
    const response = await handler(new Request(`http://local.test${path}`, { method: path === "/v1/models" ? "GET" : "POST", headers: { host: "n8n-openai-oauth:10531" } }));
    assert.equal(response.status, 401);
  }
  assert.equal(calls.length, 0);
  const response = await handler(request("/v1/responses", { model: "gpt-6.1-sol", input: [{ role: "user", content: "Hi" }] }));
  assert.equal(response.status, 200);
  assert.equal(calls[0].url, "https://api.openai.com/v1/responses");
  assert.equal(calls[0].options.headers.authorization, "Bearer provider-token");
  assert.notEqual(calls[0].options.headers.authorization, `Bearer ${credential}`);
  assert.deepEqual(JSON.parse(calls[0].options.body), { model: "gpt-6.1-sol", input: [{ role: "user", content: "Hi" }], store: false, stream: true });
});

test("private Host and no-Origin admission precedes token and provider access", async () => {
  const { handler, calls, tokenCalls } = fake();
  const body = { model: "gpt-6.1-sol", input: [{ role: "user", content: "Hi" }] };
  for (const [headers, status, param] of [
    [{ origin: "https://example.test" }, 403, "origin"],
    [{ host: "example.test:10531" }, 421, "host"],
    [{ host: "n8n-openai-oauth.evil:10531" }, 421, "host"],
  ]) {
    const response = await handler(request("/v1/responses", body, headers));
    assert.equal(response.status, status);
    assert.equal((await response.json()).error.param, param);
  }
  assert.equal(calls.length, 0);
  assert.equal(tokenCalls.length, 0);
  assert.equal((await handler(request("/v1/responses", body, { host: "openai-oauth:10531" }))).status, 200);
  assert.equal(calls.length, 1);
  assert.equal(tokenCalls.length, 1);
});

test("wizard catalog keeps the pinned client version and listed order without inventing entitlement", async () => {
  const catalog = [
    { slug: "gpt-6.1-sol", display_name: "GPT 6.1 Sol", visibility: "list", minimal_client_version: "0.153.0" },
    { slug: "private", visibility: "hidden", minimal_client_version: "0.100.0" },
    { slug: "gpt-6-sol", display_name: "GPT 6 Sol", visibility: "list", minimal_client_version: "0.155.0" },
    { slug: "gpt-6-luna", display_name: "GPT 6 Luna", visibility: "list", minimal_client_version: "0.155.0" },
    { slug: "other-listed", visibility: "list" },
  ];
  const catalogRequests = [];
  const provider = (url, options) => {
    const parsed = new URL(url);
    assert.equal(parsed.origin, "https://api.openai.com");
    assert.equal(parsed.pathname, "/v1/models");
    assert.deepEqual([...parsed.searchParams], [["client_version", CODEX_CLI_VERSION]]);
    assert.equal(options.headers.authorization, "Bearer provider-token");
    catalogRequests.push(url);
    return Response.json({ models: catalog });
  };
  assert.deepEqual(await listSiwcModels({ ...registration, runtimeId: "runtime-1", getToken: async () => ({ accessToken: "provider-token" }), fetchImpl: provider }), [
    { slug: "gpt-6.1-sol", display_name: "GPT 6.1 Sol" },
    { slug: "gpt-6-sol", display_name: "GPT 6 Sol" },
    { slug: "gpt-6-luna", display_name: "GPT 6 Luna" },
    { slug: "other-listed", display_name: "other-listed" },
  ]);
  assert.equal(catalogRequests.length, 1);
});

test("models route lists the discovery catalog in order without a lease or provider call of its own", async () => {
  const models = [{ id: "gpt-7-nova", display_name: "GPT 7 Nova" }, { id: "gpt-6.1-sol", display_name: "GPT 6.1 Sol" }];
  const { handler, calls, tokenCalls } = fake(undefined, { discovery: fakeDiscovery(async () => ({ models, clientVersion: "0.161.0", checksEnabled: true })) });
  const response = await handler(request("/v1/models?client_version=0.147.0"));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("cache-control"), "no-store");
  assert.deepEqual(await response.json(), { object: "list", data: [
    { id: "gpt-7-nova", object: "model", created: 0, owned_by: "openai", display_name: "GPT 7 Nova" },
    { id: "gpt-6.1-sol", object: "model", created: 0, owned_by: "openai", display_name: "GPT 6.1 Sol" },
  ] });
  assert.deepEqual([calls.length, tokenCalls.length], [0, 0]);
});

test("catalog and lease failures map to fixed errors with their recovery and never expose the cause", async () => {
  for (const [cause, status, code, recovery] of [
    [{ code: "catalog_unavailable", status: 401, recovery: "reauthorize" }, 401, "catalog_unavailable", "reauthorize"],
    [{ code: "catalog_unavailable", status: 503, recovery: "retry-later" }, 503, "catalog_unavailable", "retry-later"],
    [{ code: "siwc_lock_unavailable", status: 503, recovery: "retry-later" }, 503, "registration_unavailable", "retry-later"],
    [{ recovery: "reauthorize" }, 401, "registration_unavailable", "reauthorize"],
    [{ recovery: "fix-configuration" }, 503, "registration_unavailable", "fix-configuration"],
    [{ recovery: "resolve-handoff" }, 409, "registration_unavailable", "resolve-handoff"],
    [{ recovery: "enable-plan" }, 403, "registration_unavailable", "enable-plan"],
    [{}, 403, "registration_unavailable", "enable-plan"],
  ]) {
    const thrown = Object.assign(new Error("Bearer provider-token was rejected"), cause);
    const { handler } = fake(undefined, { discovery: fakeDiscovery(async () => { throw thrown; }) });
    const response = await handler(request("/v1/models"));
    const text = await response.text();
    assert.deepEqual([response.status, JSON.parse(text).error.code, JSON.parse(text).recovery], [status, code, recovery]);
    assert.equal(text.includes("provider-token"), false);
  }
});

test("passive learning records one completed outcome per successful turn on both text routes", async () => {
  const responses = { model: "gpt-7-nova", input: [{ role: "user", content: "Hi" }] };
  const chat = { model: "gpt-7-nova", messages: [{ role: "user", content: "Hi" }] };
  for (const [path, body] of [["/v1/responses", responses], ["/v1/responses", { ...responses, stream: true }],
    ["/v1/chat/completions", chat], ["/v1/chat/completions", { ...chat, stream: true }]]) {
    const { handler, discovery } = fake();
    const response = await handler(request(path, body));
    assert.equal(response.status, 200);
    assert.match(await response.text(), /Hello/u);
    assert.deepEqual(discovery.outcomes, [{ model: "gpt-7-nova", outcome: "completed" }], `${path} ${body.stream === true}`);
  }
});

test("passive learning marks a model rejected only for model-level 400 and 404 traffic errors", async () => {
  const responses = { model: "gpt-7-nova", input: [{ role: "user", content: "Hi" }] };
  const chat = { model: "gpt-7-nova", messages: [{ role: "user", content: "Hi" }] };
  for (const [path, body] of [["/v1/responses", responses], ["/v1/chat/completions", chat]]) {
    for (const [status, error, rejected] of [
      [404, { code: "model_not_found", message: "Unknown model" }, true],
      [400, { code: "invalid_model" }, true],
      [400, { code: "invalid_value", param: "model" }, true],
      [400, { code: "subscription_sharing_unsupported_capability" }, false],
      [400, { code: "subscription_sharing_unsupported_capability", param: "tools" }, false],
      [400, { code: "invalid_value", param: "input" }, false],
      [401, { code: "invalid_model" }, false],
      [403, { code: "model_not_found" }, false],
      [429, { code: "subscription_sharing_usage_limit_exceeded", param: "model" }, false],
      [500, { code: "model_not_found" }, false],
      [503, { param: "model" }, false],
    ]) {
      const { handler, discovery } = fake(() => Response.json({ error }, { status }));
      const response = await handler(request(path, body));
      assert.equal(response.status, status);
      assert.deepEqual(discovery.outcomes, rejected ? [{ model: "gpt-7-nova", outcome: "model_rejected" }] : [], `${path} ${status} ${JSON.stringify(error)}`);
    }
  }
});

test("passive learning ignores failed, incomplete, interrupted and unsent turns", async () => {
  const body = { model: "gpt-7-nova", input: [{ role: "user", content: "Hi" }] };
  for (const upstream of [
    () => new Response(terminal("response.failed", { error: { code: "model_not_found", message: "Gone" } })),
    () => new Response(terminal("response.incomplete", { incomplete_details: { reason: "max_output_tokens" } })),
    () => new Response(terminal("response.completed", { ...completed, status: "failed" })),
    () => new Response("event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"partial\"}\n\n"),
    () => { throw new TypeError("fetch failed"); },
  ]) {
    for (const stream of [false, true]) {
      const { handler, discovery } = fake(upstream);
      await (await handler(request("/v1/responses", { ...body, stream }))).text();
      assert.deepEqual(discovery.outcomes, []);
    }
  }
});

test("a hanging or failing model store never delays or alters the client response", { timeout: 10_000 }, async () => {
  const body = { model: "gpt-7-nova", input: [{ role: "user", content: "Hi" }] };
  for (const recordOutcome of [() => new Promise(() => {}), async () => { throw new Error("store_unsafe"); }, () => { throw new Error("store_unsafe"); }]) {
    const completedTurn = fake(undefined, { discovery: fakeDiscovery(undefined, recordOutcome) });
    assert.equal((await (await completedTurn.handler(request("/v1/responses", body))).json()).id, "resp_1");
    const streamed = await completedTurn.handler(request("/v1/responses", { ...body, stream: true }));
    assert.match(await streamed.text(), /event: response\.completed/u);
    const rejectedTurn = fake(() => Response.json({ error: { code: "model_not_found" } }, { status: 404 }), { discovery: fakeDiscovery(undefined, recordOutcome) });
    const rejected = await rejectedTurn.handler(request("/v1/responses", body));
    assert.deepEqual([rejected.status, (await rejected.json()).error.code], [404, "model_not_found"]);
  }
});

test("closing the handler closes model discovery so shutdown sends no more checks", async () => {
  let closed = 0;
  const { handler } = fake(undefined, { discovery: { ...fakeDiscovery(), close: () => { closed += 1; } } });
  assert.equal((await handler(request("/v1/models"))).status, 200);
  assert.equal(closed, 0);
  handler.close();
  assert.equal(closed, 1);
});

const countingDiscovery = (recordActivity) => {
  const entries = [];
  return { ...fakeDiscovery(), entries, recordActivity: recordActivity ?? ((entry) => { entries.push(entry); }) };
};
const textRoutes = (model) => [
  ["/v1/responses", { model, input: [{ role: "user", content: "Hi" }] }],
  ["/v1/responses", { model, input: [{ role: "user", content: "Hi" }], stream: true }],
  ["/v1/chat/completions", { model, messages: [{ role: "user", content: "Hi" }] }],
  ["/v1/chat/completions", { model, messages: [{ role: "user", content: "Hi" }], stream: true }],
];

test("each text request sent to OpenAI counts once with its outcome, streamed or not, on both routes", async () => {
  const usage = { input_tokens: 9, input_tokens_details: { cached_tokens: 2 }, output_tokens: 3,
    output_tokens_details: { reasoning_tokens: 1 }, total_tokens: 12 };
  const sse = (text) => () => new Response(text, { headers: { "content-type": "text/event-stream" } });
  const counted = (outcome, extra = {}) => ({ model: "gpt-7-nova", accepted: true, outcome, usage: undefined, code: undefined, ...extra });
  for (const [upstream, expected] of [
    [sse(terminal("response.completed", { ...completed, usage })), counted("completed", { usage })],
    [sse(terminal("response.failed", { error: { code: "subscription_sharing_usage_limit_exceeded", message: "Limit" } })),
      counted("failed", { accepted: false, code: "subscription_sharing_usage_limit_exceeded" })],
    [sse(terminal("response.incomplete", { incomplete_details: { reason: "max_output_tokens" }, usage })), counted("incomplete")],
    [sse("event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"partial\"}\n\n"), counted("failed", { accepted: false })],
    [sse(terminal("response.completed", { ...completed, status: "failed", usage })), counted("failed", { accepted: false })],
    [() => Response.json({ error: { code: "subscription_sharing_user_not_eligible", message: "No" } }, { status: 403 }),
      counted("failed", { accepted: false, code: "subscription_sharing_user_not_eligible" })],
    [() => { throw new TypeError("fetch failed"); }, counted("failed", { accepted: false })],
  ]) {
    for (const [path, body] of textRoutes("gpt-7-nova")) {
      const discovery = countingDiscovery();
      const { handler } = fake(upstream, { discovery });
      await (await handler(request(path, body))).text();
      assert.deepEqual(discovery.entries, [expected], `${path} ${body.stream === true} ${expected.outcome}`);
    }
  }

  // Requests that never reach OpenAI, image requests and model lists count nothing.
  const discovery = countingDiscovery();
  const { handler } = fake(undefined, { discovery });
  for (const [path, body, headers] of [
    ["/v1/responses", { model: "gpt-7-nova", input: [{ role: "user", content: "Hi" }], store: true }],
    ["/v1/responses", { model: "gpt-7-nova", input: [{ role: "user", content: "Hi" }] }, { authorization: "Bearer wrong" }],
    ["/v1/images/generations", { model: "gpt-image-2", prompt: "A cat" }],
    ["/v1/models"],
  ]) await (await handler(request(path, body, headers))).text();
  const leaseless = createSidecarHandler({ registration, runtimeId: "runtime-1", tokenVerifier: verifier, discovery,
    imagesStatus: async () => ({ state: "off" }),
    getToken: async () => { throw Object.assign(new Error("Plan use is paused."), { recovery: "enable-plan" }); },
    fetchImpl: async () => { throw new Error("No request may be sent without a lease."); } });
  assert.equal((await leaseless(request("/v1/responses", { model: "gpt-7-nova", input: [{ role: "user", content: "Hi" }] }))).status, 403);
  assert.deepEqual(discovery.entries, []);
});

test("a request the client abandons counts with no outcome", async () => {
  const added = { type: "response.output_item.added", output_index: 0,
    item: { type: "message", id: "msg_1", role: "assistant", status: "in_progress", content: [] } };
  const delta = { type: "response.output_text.delta", output_index: 0, item_id: "msg_1", content_index: 0, delta: "part" };
  for (const [path, body] of textRoutes("gpt-7-nova").filter(([, body]) => body.stream)) {
    let sent = 0;
    const provider = new ReadableStream({ pull(controller) {
      controller.enqueue(new TextEncoder().encode(event(sent++ === 0 ? added : delta)));
    } });
    const discovery = countingDiscovery();
    const { handler } = fake(() => new Response(provider, { headers: { "content-type": "text/event-stream" } }), { discovery });
    const reader = (await handler(request(path, body))).body.getReader();
    assert.equal((await reader.read()).done, false);
    await reader.cancel();
    assert.deepEqual(discovery.entries, [{ model: "gpt-7-nova", accepted: false, outcome: undefined, usage: undefined, code: undefined }], path);
  }
  // A failure caused by the client leaving is not counted as failed either.
  const controller = new AbortController();
  const abandoned = new Request("http://local.test/v1/responses", { method: "POST", signal: controller.signal,
    headers: { host: "n8n-openai-oauth:10531", authorization: `Bearer ${credential}` },
    body: JSON.stringify({ model: "gpt-7-nova", input: [{ role: "user", content: "Hi" }] }) });
  const discovery = countingDiscovery();
  const { handler } = fake(() => { controller.abort(); throw new DOMException("The operation was aborted.", "AbortError"); }, { discovery });
  assert.equal((await handler(abandoned)).status, 503);
  assert.deepEqual(discovery.entries, [{ model: "gpt-7-nova", accepted: false, outcome: undefined, usage: undefined, code: undefined }]);
});

test("a hanging or failing request counter never delays or alters the client response", { timeout: 10_000 }, async () => {
  const body = { model: "gpt-7-nova", input: [{ role: "user", content: "Hi" }] };
  const wire = async (discovery) => (await (await fake(undefined, { discovery }).handler(request("/v1/responses", { ...body, stream: true }))).text());
  const plain = await wire(fakeDiscovery());
  for (const recordActivity of [() => new Promise(() => {}), async () => { throw new Error("store_unsafe"); }, () => { throw new Error("store_unsafe"); }]) {
    const discovery = countingDiscovery(recordActivity);
    assert.equal(await wire(discovery), plain);
    const { handler } = fake(undefined, { discovery });
    assert.equal((await (await handler(request("/v1/responses", body))).json()).id, "resp_1");
    assert.match(await (await handler(request("/v1/chat/completions", { model: "gpt-7-nova",
      messages: [{ role: "user", content: "Hi" }], stream: true }))).text(), /\[DONE\]/u);
    const limited = await fake(() => Response.json({ error: { code: "subscription_sharing_usage_limit_exceeded" } }, { status: 429 }),
      { discovery }).handler(request("/v1/responses", body));
    assert.deepEqual([limited.status, (await limited.json()).recovery], [429, "manage-usage"]);
  }
});

test("the sidecar's own discovery keeps the counts and writes them when the handler closes", {
  skip: process.platform === "win32" && "the request count store exists only in the Linux sidecar container; NTFS has no POSIX modes",
}, async (t) => {
  const storageRoot = await mkdtemp(join(tmpdir(), "relmio-sidecar-usage-"));
  t.after(() => rm(storageRoot, { recursive: true, force: true }));
  const usage = { input_tokens: 9, input_tokens_details: { cached_tokens: 2 }, output_tokens: 3,
    output_tokens_details: { reasoning_tokens: 1 }, total_tokens: 12 };
  const pasted = "sk-pasted-key-0123456789";
  const handler = createSidecarHandler({ registration: { storageRoot, registrationId: "first" }, runtimeId: "runtime-1",
    tokenVerifier: verifier, imagesStatus: async () => ({ state: "off" }), getToken: async () => ({ accessToken: "provider-token" }),
    fetchImpl: async (url, options) => {
      assert.equal(String(url), "https://api.openai.com/v1/responses");
      // OpenAI answers 200 and then fails a model it does not run: that name is never stored.
      return new Response(JSON.parse(options.body).model === pasted
        ? terminal("response.failed", { error: { code: "server_error", message: "Failed" } })
        : terminal("response.completed", { ...completed, usage }));
    } });
  for (const [path, body] of [...textRoutes("gpt-7-nova"), ...textRoutes(pasted)]) await (await handler(request(path, body))).text();
  await handler.close();
  const text = await readFile(join(storageRoot, "activity", "first.json"), "utf8");
  const days = Object.values(JSON.parse(text).days);
  assert.deepEqual(days.reduce((sum, day) => sum + day["gpt-7-nova"].requests, 0), 4);
  assert.deepEqual(days.reduce((sum, day) => sum + day["gpt-7-nova"].total, 0), 48);
  assert.deepEqual(days.reduce((sum, day) => sum + day.other.requests, 0), 4);
  for (const secret of ["provider-token", "Hello", "resp_1", credential, pasted]) assert.equal(text.includes(secret), false, secret);
});

test("rejects unsupported parameters, tools, routes, and storage before provider dispatch", async () => {
  const { handler, calls } = fake();
  const base = { model: "gpt-6.1-sol", input: [{ role: "user", content: "Hi" }] };
  for (const [body, param] of [
    [{ ...base, store: true }, "store"],
    [{ ...base, previous_response_id: "resp" }, "previous_response_id"], [{ ...base, tools: [{ type: "image_generation" }] }, "tools"],
    [{ ...base, input: [{ type: "message", role: "system", content: "bypass" }] }, "input"],
    [{ ...base, include: ["file_search_call.results"] }, "include"],
    [{ ...base, input: [{ role: "user", content: [{ type: "input_audio", data: "AA==" }] }] }, "input"],
  ]) {
    const response = await handler(request("/v1/responses", body));
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.param, param);
  }
  for (const path of ["/v1/images/generations", "/v1/images/edits", "/v1/files", "/v1/audio/speech", "/v1/responses/resp_1"]) {
    assert.equal((await handler(request(path, base))).status, 404);
  }
  assert.equal(calls.length, 0);
});

test("image and file input remain available through public Responses without generation routes", async () => {
  const { handler, calls } = fake();
  const input = [{ role: "user", content: [{ type: "input_image", image_url: "https://example.test/cat.png" }, { type: "input_file", file_data: "data:application/pdf;base64,AA==" }] }];
  const response = await handler(request("/v1/responses", { model: "gpt-6.1-sol", input }));
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(calls[0].options.body).input, input);
});

test("streaming never reports success on failed, incomplete or interrupted provider streams", async () => {
  for (const event of [
    terminal("response.failed", { error: { code: "subscription_sharing_usage_limit_exceeded", message: "Limited" } }),
    terminal("response.incomplete", { incomplete_details: { reason: "max_output_tokens" } }),
    "event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"partial\"}\n\n",
  ]) {
    const { handler } = fake(() => new Response(`event: response.output_text.delta\ndata: {"type":"response.output_text.delta","delta":"part"}\n\n${event}`));
    const response = await handler(request("/v1/responses", { model: "gpt-6.1-sol", input: [{ role: "user", content: "Hi" }], stream: true }));
    const wire = await response.text();
    assert.match(wire, /response\.output_text\.delta/u);
    assert.doesNotMatch(wire, /event: response\.completed/u);
    if (!wire.includes("response.failed") && !wire.includes("response.incomplete")) assert.match(wire, /stream_interrupted/u);
  }
});

test("data-only Responses SSE preserves parsed delta and completion payloads", async () => {
  const delta = { type: "response.output_text.delta", delta: "hello" };
  const { handler } = fake(() => new Response(`data: ${JSON.stringify(delta)}\n\ndata: ${JSON.stringify({ type: "response.completed", response: completed })}\n\n`));
  const response = await handler(request("/v1/responses", {
    model: "gpt-6.1-sol", input: [{ role: "user", content: "Hi" }], stream: true,
  }));
  const events = (await response.text()).trim().split("\n\n").map((block) => ({
    event: block.split("\n").find((line) => line.startsWith("event:")).slice(6).trim(),
    data: JSON.parse(block.split("\n").find((line) => line.startsWith("data:")).slice(5).trim()),
  }));
  assert.equal(events[0].event, "response.output_text.delta");
  assert.deepEqual(events[0].data, delta);
  assert.equal(events[1].event, "response.completed");
  assert.deepEqual(events[1].data.response, completed);
});

test("Responses SSE follows downstream demand and cancels upstream on disconnect", async () => {
  let produced = 0;
  let cancelled = false;
  const encoder = new TextEncoder();
  const providerStream = new ReadableStream({
    pull(controller) {
      produced++;
      if (produced > 100) { controller.close(); return; }
      controller.enqueue(encoder.encode(`event: response.output_text.delta\ndata: ${JSON.stringify({
        type: "response.output_text.delta", delta: "part",
      })}\n\n`));
    },
    cancel() { cancelled = true; },
  });
  const { handler } = fake(() => new Response(providerStream, { headers: { "content-type": "text/event-stream" } }));
  const response = await handler(request("/v1/responses", { model: "gpt-6.1-sol",
    input: [{ role: "user", content: "Hi" }], stream: true }));
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(produced < 100);
  const reader = response.body.getReader();
  const first = await reader.read();
  const firstEvent = new TextDecoder().decode(first.value);
  assert.match(firstEvent, /event: response\.output_text\.delta/u);
  assert.deepEqual(JSON.parse(firstEvent.split("\n").find((line) => line.startsWith("data:")).slice(5).trim()), {
    type: "response.output_text.delta", delta: "part",
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.ok(produced < 100);
  await reader.cancel();
  assert.equal(cancelled, true);
});

test("provider detail admission and post-delta chat limits stay safe and terminal", async () => {
  const denied = fake(() => new Response(JSON.stringify({ detail: "Serving region is unavailable." }), {
    status: 403, headers: { "x-request-id": "req_region" },
  }));
  const base = { model: "gpt-6.1-sol", input: [{ role: "user", content: "Hi" }] };
  const error = await denied.handler(request("/v1/responses", base));
  assert.equal(error.status, 403);
  assert.deepEqual((await error.json()).upstream, { status: 403, body: { detail: "Serving region is unavailable." }, requestId: "req_region" });

  const textDelta = { type: "response.output_text.delta", output_index: 0, item_id: "msg_partial", content_index: 0, delta: "partial", logprobs: [] };
  const added = { type: "response.output_item.added", output_index: 0,
    item: { type: "message", id: "msg_partial", role: "assistant", status: "in_progress", phase: "final_answer", content: [] } };
  const failed = fake(() => new Response(`${event(added)}${event(textDelta)}${terminal("response.failed", { error: { code: "subscription_sharing_usage_limit_exceeded", message: "Limit" } })}`, { headers: { "x-request-id": "req_limit" } }));
  const stream = await failed.handler(request("/v1/chat/completions", { model: "gpt-6.1-sol", messages: [{ role: "user", content: "Hi" }], stream: true }));
  const events = await stream.text();
  const [partial, limit] = events.trim().split("\n\n").map((block) =>
    JSON.parse(block.split("\n").find((line) => line.startsWith("data:")).slice(5).trim()));
  assert.equal(partial.choices[0].delta.content, "partial");
  assert.equal(limit.error.code, "subscription_sharing_usage_limit_exceeded");
  assert.equal(limit.status, 429);
  assert.equal(limit.requestId, "req_limit");
  assert.doesNotMatch(events, /\[DONE\]/u);
});

test("Responses passes namespaced tools and additional tool items but rejects hosted tools", async () => {
  const { handler, calls } = fake();
  const namespace = { type: "namespace", name: "local", description: "Local tools", tools: [{ type: "function", name: "lookup", parameters: { type: "object", properties: {} } }] };
  const input = [{ role: "user", content: "Look up" }, { type: "additional_tools", role: "developer", tools: [{ type: "function", name: "calculate" }] }];
  const response = await handler(request("/v1/responses", { model: "gpt-6.1-sol", input, tools: [namespace] }));
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(calls[0].options.body).tools, [namespace]);
  assert.deepEqual(JSON.parse(calls[0].options.body).input, [input[0], { ...input[1],
    tools: [{ type: "function", name: "calculate", parameters: null, strict: null }] }]);
  for (const tool of [{ type: "tool_search" }, { type: "code_interpreter" }]) {
    const unsupported = await handler(request("/v1/responses", { model: "gpt-6.1-sol", input, tools: [tool] }));
    assert.equal(unsupported.status, 400);
    assert.equal((await unsupported.json()).error.param, "tools");
  }
  const deferred = await handler(request("/v1/responses", { model: "gpt-6.1-sol", input,
    tools: [{ ...namespace, tools: [{ type: "function", name: "lookup", defer_loading: true }] }] }));
  assert.equal(deferred.status, 400);
  assert.equal((await deferred.json()).error.param, "tools");
  assert.equal(calls.length, 1);
});

test("aggregate requires terminal completion and preserves bounded provider error status, code, param and request id", async () => {
  const error = fake(() => new Response(JSON.stringify({ error: { code: "subscription_sharing_unsupported_capability", param: "tools", message: "Unsupported" } }), { status: 400, headers: { "x-request-id": "req_123" } }));
  const base = { model: "gpt-6.1-sol", input: [{ role: "user", content: "Hi" }] };
  const rejected = await error.handler(request("/v1/responses", base));
  assert.equal(rejected.status, 400);
  const rejectedBody = await rejected.json();
  assert.equal(rejectedBody.error.code, "subscription_sharing_unsupported_capability");
  assert.equal(rejectedBody.error.param, "tools");
  assert.equal(rejectedBody.requestId, "req_123");
  assert.deepEqual(rejectedBody.upstream, { status: 400, body: { error: rejectedBody.error }, requestId: "req_123" });
  const failed = fake(() => new Response(`${terminal("response.output_text.delta", { id: "resp_1" })}${terminal("response.failed", { error: { code: "subscription_sharing_usage_limit_exceeded", message: "Limit" } })}`));
  const result = await failed.handler(request("/v1/responses", base));
  assert.equal(result.status, 429);
  assert.equal((await result.json()).recovery, "manage-usage");
  const eventId = fake(() => new Response(`event: response.failed\ndata: ${JSON.stringify({
    type: "response.failed", request_id: "req_event_only",
    response: { error: { code: "subscription_sharing_usage_limit_exceeded", param: "model", message: "Limit" } },
  })}\n\n`));
  const eventFailure = await eventId.handler(request("/v1/responses", base));
  assert.equal(eventFailure.status, 429);
  assert.equal((await eventFailure.json()).requestId, "req_event_only");
  const truncated = fake(() => new Response("event: response.output_text.delta\ndata: {\"type\":\"response.output_text.delta\",\"delta\":\"partial\"}\n\n"));
  assert.equal((await truncated.handler(request("/v1/responses", base))).status, 502);
});

test("known selected access token is removed from provider diagnostics and output", async () => {
  const base = { model: "gpt-6.1-sol", input: [{ role: "user", content: "Hi" }] };
  const error = fake(() => new Response(JSON.stringify({ detail: "provider-token" }), { status: 403 }));
  const rejected = await error.handler(request("/v1/responses", base));
  assert.equal((await rejected.text()).includes("provider-token"), false);
  const echoed = { ...completed, output: [{ type: "message", content: [{ type: "output_text", text: "provider-token" }] }] };
  const success = fake(() => new Response(terminal("response.completed", echoed)));
  const result = await success.handler(request("/v1/responses", base));
  assert.equal((await result.text()).includes("provider-token"), false);
});

test("chat compatibility preserves text history and translates flat client tools without unsupported fields", async () => {
  const { handler, calls } = fake();
  const messages = [{ role: "developer", content: "Be brief" }, { role: "user", content: "Hello" }];
  const response = await handler(request("/v1/chat/completions", { model: "gpt-6.1-sol", messages }));
  assert.equal((await response.json()).choices[0].message.content, "Hello");
  assert.deepEqual(JSON.parse(calls[0].options.body).input, messages);
  const tools = [{ type: "function", function: { name: "get", parameters: { type: "object", properties: {} } } }];
  const withTool = await handler(request("/v1/chat/completions", { model: "gpt-6.1-sol", messages, tools, tool_choice: "auto" }));
  assert.equal(withTool.status, 200);
  const translated = JSON.parse(calls[1].options.body);
  assert.deepEqual(translated.input[0], { type: "additional_tools", role: "developer",
    tools: [{ type: "function", name: "get", parameters: tools[0].function.parameters, strict: null }] });
  assert.equal(translated.tool_choice, "auto");
  assert.equal((await handler(request("/v1/chat/completions", { model: "gpt-6.1-sol", messages, tools,
    tool_choice: { type: "function", function: { name: "get" } } }))).status, 400);
  assert.equal((await handler(request("/v1/chat/completions", { model: "gpt-6.1-sol", messages, tools,
    temperature: 0.5 }))).status, 400);
  assert.equal((await handler(request("/v1/chat/completions", { model: "gpt-6.1-sol", messages,
    tools: [{ type: "code_interpreter" }] }))).status, 400);
  assert.equal((await handler(request("/v1/chat/completions", { model: "gpt-6.1-sol", messages: [{ role: "system", content: "system priority" }] }))).status, 400);
  assert.equal(calls.length, 2);
});

test("HTTP listener carries authenticated request to the selected provider and no credential in health", async (t) => {
  const { handler } = fake();
  const server = createSidecarServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const base = `http://127.0.0.1:${server.address().port}`;
  assert.deepEqual(await (await fetch(`${base}/health`)).json(), { status: "ok" });
  const response = await fetch(`${base}/v1/responses`, { method: "POST", headers: { authorization: `Bearer ${credential}` }, body: JSON.stringify({ model: "gpt-6.1-sol", input: [{ role: "user", content: "Hi" }] }) });
  assert.equal((await response.json()).id, "resp_1");
});

test("sidecar quiescence interrupts an active request before account mutation", async () => {
  let entered;
  const active = new Promise((resolve) => { entered = resolve; });
  let aborted = false;
  const server = createSidecarServer(async (request) => {
    entered();
    await new Promise((resolve) => request.signal.addEventListener("abort", () => {
      aborted = true;
      resolve();
    }, { once: true }));
    return Response.json({ status: "not_completed" });
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const pending = fetch(`http://127.0.0.1:${server.address().port}/v1/responses`, {
    method: "POST", body: JSON.stringify({ input: [] }),
  }).catch((error) => error);
  await active;
  await server.quiesce();
  assert.equal(aborted, true);
  assert.ok((await pending) instanceof Error);
});

const functionTool = { type: "function", name: "lookup", description: "Look up a city",
  parameters: { type: "object", properties: { city: { type: "string" } }, required: ["city"], additionalProperties: false }, strict: true };
const functionCall = (suffix, extra = {}) => ({ type: "function_call", id: `fc_${suffix}`,
  call_id: `call_${suffix}`, name: "lookup", arguments: '{"city":"Paris"}', status: "completed", ...extra });
const event = (value) => `event: ${value.type}\ndata: ${JSON.stringify(value)}\n\n`;
const toolResponse = (output) => ({ id: "resp_tools", object: "response", status: "completed", output });
function parseEvents(wire) {
  return wire.trim().split("\n\n").map((block) => {
    const data = block.split("\n").find((line) => line.startsWith("data:")).slice(5).trim();
    return data === "[DONE]" ? data : JSON.parse(data);
  });
}
const chatBody = (extra = {}) => ({ model: "gpt-6.1-sol", messages: [{ role: "user", content: "Look up Paris" }],
  tools: [{ type: "function", function: { name: functionTool.name, description: functionTool.description,
    parameters: functionTool.parameters, strict: functionTool.strict } }], ...extra });

test("Responses two-turn function and custom history preserves call ids and exact namespaces", async () => {
  const output = [functionCall("flat"), functionCall("namespaced", { namespace: "crm" }),
    { type: "custom_tool_call", id: "ctc_1", call_id: "call_custom", name: "query", input: "select city", namespace: "db" }];
  let turn = 0;
  const { handler, calls } = fake(() => new Response(terminal("response.completed", ++turn === 1 ? toolResponse(output) : completed)));
  const input = [{ role: "user", content: "Look up Paris" }];
  const custom = { type: "custom", name: "query", format: { type: "text" } };
  const namespace = { type: "namespace", name: "crm", description: "CRM", tools: [functionTool] };
  const tools = [functionTool, custom, namespace, { type: "web_search" }];
  const first = await handler(request("/v1/responses", { model: "gpt-6.1-sol", input, tools, parallel_tool_calls: true }));
  const firstBody = await first.json();
  assert.deepEqual(firstBody.output, output);
  assert.deepEqual(JSON.parse(calls[0].options.body).input[0], { type: "additional_tools", role: "developer", tools: [functionTool, custom] });
  assert.deepEqual(JSON.parse(calls[0].options.body).tools, [namespace, { type: "web_search" }]);
  const history = [...input, ...firstBody.output,
    { type: "function_call_output", call_id: "call_namespaced", namespace: "crm", output: "CRM Paris" },
    { type: "custom_tool_call_output", call_id: "call_custom", output: "DB Paris" },
    { type: "function_call_output", call_id: "call_flat", output: "Paris" }];
  const second = await handler(request("/v1/responses", { model: "gpt-6.1-sol", input: history, tools }));
  assert.equal((await second.json()).output[0].content[0].text, "Hello");
  assert.deepEqual(JSON.parse(calls[1].options.body).input.slice(1), history);
  assert.equal(calls.length, 2);
});

test("Chat two-turn parallel calls map reversed tool results by tool_call_id", async () => {
  let turn = 0;
  const output = [functionCall("one"), functionCall("two", { arguments: '{"city":"Rome"}' })];
  const { handler, calls } = fake(() => new Response(terminal("response.completed", ++turn === 1 ? toolResponse(output) : completed)));
  const body = chatBody({ tool_choice: "required", parallel_tool_calls: true });
  const first = await (await handler(request("/v1/chat/completions", body))).json();
  assert.equal(first.choices[0].finish_reason, "tool_calls");
  assert.deepEqual(first.choices[0].message.tool_calls.map((call) => call.id), ["call_one", "call_two"]);
  assert.equal(first.choices[0].message.content, null);
  const second = await (await handler(request("/v1/chat/completions", { ...body, tool_choice: "auto",
    messages: [...body.messages, first.choices[0].message,
      { role: "tool", tool_call_id: "call_two", content: "Rome result" },
      { role: "tool", tool_call_id: "call_one", content: "Paris result" }] }))).json();
  assert.equal(second.choices[0].message.content, "Hello");
  const replay = JSON.parse(calls[1].options.body);
  assert.deepEqual(replay.input.slice(2), [
    { type: "function_call", call_id: "call_one", name: "lookup", arguments: '{"city":"Paris"}' },
    { type: "function_call", call_id: "call_two", name: "lookup", arguments: '{"city":"Rome"}' },
    { type: "function_call_output", call_id: "call_two", output: "Rome result" },
    { type: "function_call_output", call_id: "call_one", output: "Paris result" },
  ]);
  assert.equal(replay.parallel_tool_calls, true);
  assert.equal(calls.length, 2);
});

test("Chat custom definitions and nonstreaming custom results roundtrip without coercing input", async () => {
  const custom = { type: "custom", custom: { name: "query", format: { type: "text" } } };
  const output = [{ type: "custom_tool_call", id: "ctc_1", call_id: "call_query", name: "query", input: "select city" }];
  let turn = 0;
  const { handler, calls } = fake(() => new Response(terminal("response.completed", ++turn === 1 ? toolResponse(output) : completed)));
  const body = chatBody({ tools: [custom] });
  const first = await (await handler(request("/v1/chat/completions", body))).json();
  assert.deepEqual(first.choices[0].message.tool_calls, [{ id: "call_query", type: "custom", custom: { name: "query", input: "select city" } }]);
  const second = await handler(request("/v1/chat/completions", { ...body, messages: [...body.messages,
    first.choices[0].message, { role: "tool", tool_call_id: "call_query", content: "Paris" }] }));
  assert.equal(second.status, 200);
  assert.deepEqual(JSON.parse(calls[0].options.body).input[0].tools, [{ type: "custom", ...custom.custom }]);
  assert.deepEqual(JSON.parse(calls[1].options.body).input.slice(2), [
    { type: "custom_tool_call", call_id: "call_query", name: "query", input: "select city" },
    { type: "custom_tool_call_output", call_id: "call_query", output: "Paris" },
  ]);
  const streaming = await handler(request("/v1/chat/completions", { ...body, stream: true }));
  assert.equal(streaming.status, 400);
  assert.equal((await streaming.json()).recovery, "fix-request");
  assert.equal(calls.length, 2);
});

test("tool choices preserve auto none required and reject forced or malformed choices before credentials", async () => {
  const { handler, calls, tokenCalls } = fake();
  for (const choice of ["auto", "none", "required"]) {
    for (const [path, body] of [
      ["/v1/responses", { model: "gpt-6.1-sol", input: [{ role: "user", content: "Hi" }], tools: [functionTool] }],
      ["/v1/chat/completions", chatBody()],
    ]) {
      assert.equal((await handler(request(path, { ...body, tool_choice: choice }))).status, 200);
      assert.equal(JSON.parse(calls.at(-1).options.body).tool_choice, choice);
    }
  }
  for (const choice of [{ type: "function", name: "lookup" }, { type: "namespace", name: "crm" }, {}, "bogus"]) {
    const response = await handler(request("/v1/responses", { model: "gpt-6.1-sol", input: [{ role: "user", content: "Hi" }],
      tools: [functionTool], tool_choice: choice }));
    assert.equal(response.status, 400);
    const error = await response.json();
    assert.equal(error.error.param, "tool_choice");
    assert.equal(error.recovery, "fix-request");
  }
  assert.equal(calls.length, 6);
  assert.equal(tokenCalls.length, 6);
});

test("malformed tools, duplicate definitions and unsafe replay are rejected before dispatch", async () => {
  const { handler, calls, tokenCalls } = fake();
  const input = [{ role: "user", content: "Hi" }];
  for (const tools of [
    [functionTool, functionTool], Array.from({ length: 129 }, (_, i) => ({ ...functionTool, name: `lookup${i}` })),
    [{ ...functionTool, parameters: [] }], [{ ...functionTool, strict: "yes" }],
    [{ ...functionTool, defer_loading: false }], [{ ...functionTool, allowed_callers: ["program"] }],
    [{ type: "custom", name: "query", format: { type: "grammar", syntax: "shell", definition: "*" } }],
  ]) {
    const response = await handler(request("/v1/responses", { model: "gpt-6.1-sol", input, tools }));
    assert.equal(response.status, 400);
    assert.equal((await response.json()).recovery, "fix-request");
  }
  for (const history of [
    [functionCall("1"), functionCall("1")],
    [functionCall("1"), functionCall("2", { id: "fc_1" })],
    [{ type: "function_call_output", call_id: "unknown", output: "result" }],
    [functionCall("1"), { type: "function_call_output", call_id: "call_1", output: "1" }, { type: "function_call_output", call_id: "call_1", output: "2" }],
    [functionCall("1", { namespace: "crm" }), { type: "function_call_output", call_id: "call_1", namespace: "other", output: "1" }],
    [functionCall("1", { caller: { type: "program" } })],
    [functionCall("1", { async: true })],
    [functionCall("1", { arguments: "x".repeat(128 * 1024 + 1) })],
  ]) {
    assert.equal((await handler(request("/v1/responses", { model: "gpt-6.1-sol", input: [...input, ...history] }))).status, 400);
  }
  const call = { id: "call_1", type: "function", function: { name: "lookup", arguments: "{}" } };
  for (const messages of [
    [{ role: "tool", tool_call_id: "unknown", content: "result" }],
    [{ role: "assistant", content: null, tool_calls: [call, call] }],
    [{ role: "assistant", content: null, tool_calls: [call] }, { role: "tool", tool_call_id: "other", content: "result" }],
    [{ role: "assistant", content: null, tool_calls: [call] }, { role: "tool", tool_call_id: "call_1", content: "1" }, { role: "tool", tool_call_id: "call_1", content: "2" }],
    [{ role: "assistant", content: null, tool_calls: [{ ...call, function: { name: "lookup", arguments: "x".repeat(128 * 1024 + 1) } }] },
      { role: "tool", tool_call_id: "call_1", content: "1" }],
    // Only an empty content list stands in for "no content"; parts, and empty lists without tool calls, stay refused.
    [{ role: "assistant", content: [{ type: "text", text: "hi" }], tool_calls: [call] }, { role: "tool", tool_call_id: "call_1", content: "1" }],
    [{ role: "user", content: "Hi" }, { role: "assistant", content: [] }],
  ]) {
    assert.equal((await handler(request("/v1/chat/completions", chatBody({ messages })))).status, 400);
  }
  assert.equal(calls.length, 0);
  assert.equal(tokenCalls.length, 0);
});

test("Chat streaming emits indexed parallel arguments once and preserves ids on second turn", async () => {
  const one = functionCall("1");
  const two = functionCall("2", { arguments: '{"city":"Rome"}' });
  const events = [
    { type: "response.output_item.added", output_index: 0, item: { ...one, arguments: "", status: "in_progress" } },
    { type: "response.output_item.added", output_index: 1, item: { ...two, arguments: "", status: "in_progress" } },
    { type: "response.function_call_arguments.delta", output_index: 1, item_id: two.id, delta: '{"city":' },
    { type: "response.function_call_arguments.delta", output_index: 0, item_id: one.id, delta: '{"city":"Pa' },
    { type: "response.function_call_arguments.delta", output_index: 1, item_id: two.id, delta: '"Rome"}' },
    { type: "response.function_call_arguments.done", output_index: 0, item_id: one.id, arguments: one.arguments },
    { type: "response.output_item.done", output_index: 0, item: one },
    { type: "response.function_call_arguments.done", output_index: 1, item_id: two.id, item: two },
    { type: "response.output_item.done", output_index: 1, item: two },
    { type: "response.completed", response: toolResponse([one, two]) },
  ];
  let turn = 0;
  const { handler, calls } = fake(() => new Response(++turn === 1 ? events.map(event).join("") : terminal("response.completed", completed)));
  const response = await handler(request("/v1/chat/completions", chatBody({ stream: true, stream_options: { include_usage: true } })));
  const parsed = parseEvents(await response.text());
  assert.equal(parsed[0].choices[0].delta.role, "assistant");
  assert.equal(parsed.filter((chunk) => chunk.choices?.[0]?.delta?.role).length, 1);
  assert.equal(parsed.at(-1), "[DONE]");
  assert.equal(parsed.find((chunk) => chunk.choices?.[0]?.finish_reason)?.choices[0].finish_reason, "tool_calls");
  const toolCalls = [];
  for (const chunk of parsed) for (const delta of chunk.choices?.[0]?.delta?.tool_calls ?? []) {
    const prior = toolCalls[delta.index] ?? { id: delta.id, type: "function", function: { name: delta.function.name, arguments: "" } };
    prior.function.arguments += delta.function.arguments ?? "";
    toolCalls[delta.index] = prior;
  }
  assert.deepEqual(toolCalls, [one, two].map((call) => ({ id: call.call_id, type: "function", function: { name: call.name, arguments: call.arguments } })));
  const second = await handler(request("/v1/chat/completions", chatBody({ messages: [
    { role: "user", content: "Look up cities" }, { role: "assistant", content: null, tool_calls: toolCalls },
    { role: "tool", tool_call_id: "call_2", content: "Rome" }, { role: "tool", tool_call_id: "call_1", content: "Paris" },
  ] })));
  assert.equal(second.status, 200);
  assert.deepEqual(JSON.parse(calls[1].options.body).input.filter((item) => item.type === "function_call_output").map((item) => item.call_id), ["call_2", "call_1"]);
  // n8n's AI Agent replays the tool-call turn with `content: []` when the Chat Model's Responses API is off.
  const replayed = await handler(request("/v1/chat/completions", chatBody({ messages: [
    { role: "user", content: "Look up cities" }, { role: "assistant", content: [], tool_calls: toolCalls },
    { role: "tool", tool_call_id: "call_2", content: "Rome" }, { role: "tool", tool_call_id: "call_1", content: "Paris" },
  ] })));
  assert.equal(replayed.status, 200);
  assert.deepEqual(JSON.parse(calls[2].options.body).input.filter((item) => item.role === "assistant"), [],
    "an empty content list sends no empty assistant message upstream");
  assert.deepEqual(JSON.parse(calls[2].options.body).input.filter((item) => item.type === "function_call").map((item) => item.call_id), ["call_1", "call_2"]);
});

test("Chat streaming completed-only tools emit complete deltas and output-index ordering stays stable", async () => {
  const one = functionCall("1");
  const two = functionCall("2");
  for (const events of [
    [{ type: "response.completed", response: toolResponse([one, two]) }],
    [{ type: "response.output_item.added", output_index: 1, item: { ...two, arguments: "", status: "in_progress" } },
      { type: "response.output_item.added", output_index: 0, item: { ...one, arguments: "", status: "in_progress" } },
      { type: "response.completed", response: toolResponse([one, two]) }],
  ]) {
    const { handler } = fake(() => new Response(events.map(event).join("")));
    const response = await handler(request("/v1/chat/completions", chatBody({ stream: true })));
    const parsed = parseEvents(await response.text());
    assert.equal(parsed.at(-1), "[DONE]");
    const ids = parsed.flatMap((chunk) => chunk.choices?.[0]?.delta?.tool_calls ?? []).filter((delta) => delta.id).map((delta) => delta.id);
    assert.deepEqual(new Set(ids), new Set(["call_1", "call_2"]));
  }
});

test("Chat stream collisions, mutation, argument bounds and call bounds never report success", async () => {
  const one = functionCall("1");
  const added = (item, output_index = 0) => ({ type: "response.output_item.added", output_index, item: { ...item, status: "in_progress" } });
  for (const events of [
    [added({ ...one, arguments: "" }), added(functionCall("2", { call_id: one.call_id, arguments: "" }), 1)],
    [added({ ...one, arguments: "" }), added(functionCall("2", { id: one.id, arguments: "" }), 1)],
    [added({ ...one, arguments: "" }), { type: "response.output_item.done", output_index: 0, item: { ...one, id: "fc_changed" } }],
    [added({ ...one, arguments: "" }), { type: "response.function_call_arguments.delta", output_index: 0, item_id: "fc_foreign", delta: "{}" }],
    [added({ ...one, arguments: "x".repeat(128 * 1024 + 1) })],
    [added({ ...one, arguments: "" }), { type: "response.function_call_arguments.delta", output_index: 0, item_id: one.id, delta: "x".repeat(128 * 1024 + 1) }],
    [added(one), { type: "response.function_call_arguments.done", output_index: 0, item_id: one.id, arguments: "{}" }],
    [added(one), { type: "response.output_item.done", output_index: 0, item: one },
      { type: "response.function_call_arguments.delta", output_index: 0, item_id: one.id, delta: " " }],
    [added({ ...one, arguments: "" }), { type: "response.completed", response: toolResponse([functionCall("1", { id: "fc_changed" })]) }],
    Array.from({ length: 33 }, (_, index) => added(functionCall(String(index), { arguments: "" }), index)),
  ]) {
    const { handler } = fake(() => new Response(events.map(event).join("")));
    const response = await handler(request("/v1/chat/completions", chatBody({ stream: true })));
    const parsed = parseEvents(await response.text());
    assert.equal(parsed.at(-1).error.code, "unsupported_output");
    assert.equal(parsed.some((chunk) => chunk.choices?.[0]?.finish_reason), false);
    assert.equal(parsed.includes("[DONE]"), false);
  }
});

test("Chat nonstreaming output rejects platform collisions, namespaces and program calls", async () => {
  for (const output of [
    [functionCall("1"), functionCall("2", { call_id: "call_1" })],
    [functionCall("1"), functionCall("2", { id: "fc_1" })],
    [functionCall("1", { namespace: "crm" })],
    [functionCall("1", { caller: { type: "program" } })],
    [functionCall("1", { async: true })],
    [functionCall("1", { arguments: "x".repeat(128 * 1024 + 1) })],
  ]) {
    const { handler } = fake(() => new Response(terminal("response.completed", toolResponse(output))));
    const response = await handler(request("/v1/chat/completions", chatBody()));
    assert.equal(response.status, 422);
    assert.equal((await response.json()).recovery, "fix-request");
  }
});

test("partial Chat tool arguments end truthfully on provider limit, incomplete, EOF and transport failure", async () => {
  const call = functionCall("1");
  const partial = [
    { type: "response.output_item.added", output_index: 0, item: { ...call, status: "in_progress", arguments: "" } },
    { type: "response.function_call_arguments.delta", output_index: 0, item_id: call.id, delta: '{"city":' },
  ].map(event);
  for (const ending of [
    event({ type: "response.failed", response: { error: { code: "subscription_sharing_usage_limit_exceeded", param: "model", message: "Limit" } } }),
    event({ type: "response.incomplete", response: { incomplete_details: { reason: "max_output_tokens" } } }),
    "", null,
  ]) {
    const chunks = [...partial, ...(ending ? [ending] : [])];
    const { handler, calls } = fake(() => new Response(new ReadableStream({
      pull(controller) {
        if (chunks.length) controller.enqueue(new TextEncoder().encode(chunks.shift()));
        else if (ending === null) controller.error(new Error("socket failed"));
        else controller.close();
      },
    }), { headers: { "x-request-id": "req_partial_tools" } }));
    const response = await handler(request("/v1/chat/completions", chatBody({ stream: true })));
    const parsed = parseEvents(await response.text());
    assert.equal(parsed[1].choices[0].delta.tool_calls[0].function.arguments, '{"city":');
    assert.equal(parsed.at(-1).requestId, "req_partial_tools");
    assert.equal(parsed.at(-1).error.code, ending?.includes("response.failed") ? "subscription_sharing_usage_limit_exceeded"
      : ending?.includes("response.incomplete") ? "response_incomplete" : "stream_interrupted");
    assert.equal(parsed.includes("[DONE]"), false);
    assert.equal(calls.length, 1);
  }
});

test("Responses tool streaming stays passthrough and replays both call types on next request", async () => {
  const call = functionCall("response_stream", { namespace: "crm" });
  const custom = { type: "custom_tool_call", id: "ctc_response_stream", call_id: "call_custom_stream", name: "query", namespace: "db", input: "select city" };
  const events = [
    { type: "response.output_item.added", output_index: 0, item: { ...call, status: "in_progress", arguments: "" } },
    { type: "response.function_call_arguments.delta", output_index: 0, item_id: call.id, delta: call.arguments },
    { type: "response.output_item.done", output_index: 0, item: call },
    { type: "response.output_item.added", output_index: 1, item: { ...custom, input: "" } },
    { type: "response.custom_tool_call_input.delta", output_index: 1, item_id: custom.id, delta: custom.input },
    { type: "response.output_item.done", output_index: 1, item: custom },
    { type: "response.completed", response: toolResponse([call, custom]) },
  ];
  let turn = 0;
  const { handler, calls } = fake(() => new Response(++turn === 1 ? events.map(event).join("") : terminal("response.completed", completed)));
  const input = [{ role: "user", content: "Look up" }];
  const first = await handler(request("/v1/responses", { model: "gpt-6.1-sol", input, stream: true }));
  assert.deepEqual(parseEvents(await first.text()), events);
  const history = [...input, ...events.at(-1).response.output,
    { type: "function_call_output", call_id: call.call_id, output: "Paris" },
    { type: "custom_tool_call_output", call_id: custom.call_id, output: "Paris" }];
  const second = await handler(request("/v1/responses", { model: "gpt-6.1-sol", input: history, stream: true }));
  assert.deepEqual(parseEvents(await second.text()).at(-1).response, completed);
  assert.deepEqual(JSON.parse(calls[1].options.body).input, history);
});

test("Chat standard omitted assistant content and grammar tools retain representable semantics", async () => {
  const { handler, calls } = fake();
  const response = await handler(request("/v1/chat/completions", chatBody({ messages: [
    { role: "user", content: "Hi" },
    { role: "assistant", tool_calls: [{ id: "call_1", type: "function", function: { name: "lookup", arguments: "{}" } }] },
    { role: "tool", tool_call_id: "call_1", content: "Paris" },
  ], tools: [{ type: "custom", custom: { name: "query", format: { type: "grammar", grammar: { syntax: "regex", definition: "select [a-z]+" } } } }] })));
  assert.equal(response.status, 200);
  const forwarded = JSON.parse(calls[0].options.body);
  assert.deepEqual(forwarded.input[0].tools[0].format, { type: "grammar", syntax: "regex", definition: "select [a-z]+" });
  assert.deepEqual(forwarded.input.slice(2), [
    { type: "function_call", call_id: "call_1", name: "lookup", arguments: "{}" },
    { type: "function_call_output", call_id: "call_1", output: "Paris" },
  ]);
});

test("Chat usage maps Responses counts and stream options never enter upstream request", async () => {
  const usage = { input_tokens: 12, output_tokens: 8, total_tokens: 20,
    input_tokens_details: { cached_tokens: 2 }, output_tokens_details: { reasoning_tokens: 3 } };
  const { handler, calls } = fake(() => new Response(terminal("response.completed", { ...completed, usage })));
  const nonstream = await (await handler(request("/v1/chat/completions", chatBody()))).json();
  assert.deepEqual(nonstream.usage, { prompt_tokens: 12, completion_tokens: 8, total_tokens: 20,
    prompt_tokens_details: { cached_tokens: 2 }, completion_tokens_details: { reasoning_tokens: 3 } });
  const stream = await handler(request("/v1/chat/completions", chatBody({ stream: true, stream_options: { include_usage: true } })));
  const parsed = parseEvents(await stream.text());
  assert.deepEqual(parsed.at(-2).choices, []);
  assert.deepEqual(parsed.at(-2).usage, nonstream.usage);
  assert.equal(JSON.parse(calls[1].options.body).stream_options, undefined);
  for (const stream_options of [{ include_usage: true, include_obfuscation: false }, { include_usage: "yes" }, null]) {
    const response = await handler(request("/v1/chat/completions", chatBody({ stream: true, stream_options })));
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.param, "stream_options");
  }
  assert.equal(calls.length, 2);
});

test("additional_tools functions explicitly carry nullable required fields without inventing schemas", async () => {
  const { handler, calls } = fake();
  const input = [{ role: "user", content: "Hi" }];
  for (const definition of [
    { name: "lookup" },
    { name: "lookup", parameters: null, strict: null },
    { name: "lookup", parameters: { type: "object", properties: {} }, strict: false },
  ]) {
    for (const [path, body] of [
      ["/v1/responses", { model: "gpt-6.1-sol", input, tools: [{ type: "function", ...definition }] }],
      ["/v1/chat/completions", { model: "gpt-6.1-sol", messages: input, tools: [{ type: "function", function: definition }] }],
    ]) {
      const response = await handler(request(path, body));
      assert.equal(response.status, 200);
      assert.deepEqual(JSON.parse(calls.at(-1).options.body).input[0].tools, [{
        type: "function", ...definition, parameters: definition.parameters ?? null, strict: definition.strict ?? null,
      }]);
    }
  }
  const response = await handler(request("/v1/responses", { model: "gpt-6.1-sol",
    input: [{ type: "additional_tools", role: "developer", tools: [{ type: "function", name: "lookup" }] }, ...input] }));
  assert.equal(response.status, 200);
  assert.deepEqual(JSON.parse(calls.at(-1).options.body).input[0].tools,
    [{ type: "function", name: "lookup", parameters: null, strict: null }]);
  assert.equal(calls.length, 7);
});

test("Chat completed outputs skip reasoning before text and function calls without exposing it", async () => {
  const reasoning = { type: "reasoning", id: "rs_private", status: "completed",
    summary: [{ type: "summary_text", text: "private-reasoning-summary" }],
    content: [{ type: "reasoning_text", text: "private-reasoning-content" }], encrypted_content: "private-encrypted-reasoning" };
  for (const item of [completed.output[0], functionCall("with_reasoning")]) {
    const { handler } = fake(() => new Response(terminal("response.completed", toolResponse([reasoning, item]))));
    const response = await handler(request("/v1/chat/completions", chatBody()));
    assert.equal(response.status, 200);
    const wire = await response.text();
    assert.doesNotMatch(wire, /private-reasoning|private-encrypted|rs_private/u);
    const choice = JSON.parse(wire).choices[0];
    if (item.type === "message") {
      assert.equal(choice.message.content, "Hello");
      assert.equal(choice.finish_reason, "stop");
    } else {
      assert.deepEqual(choice.message.tool_calls, [{ id: item.call_id, type: "function",
        function: { name: item.name, arguments: item.arguments } }]);
      assert.equal(choice.finish_reason, "tool_calls");
    }
  }
});

test("Chat streams skip reasoning items and summaries before text and function arguments", async () => {
  const reasoning = { type: "reasoning", id: "rs_private", status: "completed",
    summary: [{ type: "summary_text", text: "private-reasoning-summary" }], encrypted_content: "private-encrypted-reasoning" };
  for (const item of [{ ...completed.output[0], id: "msg_after_reasoning", role: "assistant", status: "completed" },
    functionCall("after_reasoning")]) {
    const events = [
      { type: "response.output_item.added", output_index: 0, item: { ...reasoning, status: "in_progress", summary: [] } },
      { type: "response.reasoning_summary_part.added", item_id: reasoning.id, output_index: 0, summary_index: 0, part: { type: "summary_text", text: "" } },
      { type: "response.reasoning_summary_text.delta", item_id: reasoning.id, output_index: 0, summary_index: 0, delta: reasoning.summary[0].text },
      { type: "response.reasoning_summary_text.done", item_id: reasoning.id, output_index: 0, summary_index: 0, text: reasoning.summary[0].text },
      { type: "response.reasoning_summary_part.done", item_id: reasoning.id, output_index: 0, summary_index: 0, part: reasoning.summary[0] },
      { type: "response.output_item.done", output_index: 0, item: reasoning },
      { type: "response.output_item.added", output_index: 1, item: { ...item, status: "in_progress",
        ...(item.type === "message" ? { content: [] } : { arguments: "" }) } },
      item.type === "message"
        ? { type: "response.output_text.delta", item_id: item.id, output_index: 1, content_index: 0, delta: "Hello", logprobs: [] }
        : { type: "response.function_call_arguments.delta", item_id: item.id, output_index: 1, delta: item.arguments },
      { type: "response.output_item.done", output_index: 1, item },
      { type: "response.completed", response: toolResponse([reasoning, item]) },
    ].map((value, sequence_number) => ({ ...value, sequence_number }));
    const { handler } = fake(() => new Response(events.map(event).join("")));
    const response = await handler(request("/v1/chat/completions", chatBody({ stream: true })));
    const wire = await response.text();
    assert.doesNotMatch(wire, /private-reasoning|private-encrypted|rs_private/u);
    const parsed = parseEvents(wire);
    assert.equal(parsed.at(-1), "[DONE]");
    assert.equal(parsed[0].choices[0].delta.role, "assistant");
    assert.equal(parsed.at(-2).choices[0].finish_reason, item.type === "message" ? "stop" : "tool_calls");
    if (item.type === "message") assert.equal(parsed[0].choices[0].delta.content, "Hello");
    else {
      assert.equal(parsed[0].choices[0].delta.tool_calls[0].id, item.call_id);
      assert.equal(parsed[1].choices[0].delta.tool_calls[0].function.arguments, item.arguments);
    }
  }
});

const finalMessage = (text, extra = {}) => ({ type: "message", id: "msg_live", role: "assistant",
  status: "completed", phase: "final_answer", content: [{ type: "output_text", text, annotations: [] }], ...extra });
function liveOutputEvents(items) {
  const events = [];
  for (const [output_index, item] of items.entries()) {
    events.push({ type: "response.output_item.added", output_index, item: { ...item, status: "in_progress",
      ...(item.type === "message" ? { content: [] } : item.type === "function_call" ? { arguments: "" } : {}) } });
    if (item.type === "message") events.push({ type: "response.output_text.delta", output_index,
      item_id: item.id, content_index: 0, delta: item.content[0].text, logprobs: [] });
    if (item.type === "function_call") {
      events.push({ type: "response.function_call_arguments.delta", output_index, item_id: item.id, delta: item.arguments });
      events.push({ type: "response.function_call_arguments.done", output_index, item_id: item.id, arguments: item.arguments });
    }
    events.push({ type: "response.output_item.done", output_index, item });
  }
  return [...events, { type: "response.completed", response: toolResponse([]) }];
}

test("empty terminal output aggregates completed text and parallel calls without losing phase or ids", async () => {
  for (const output of [[finalMessage("Live final text")], [functionCall("live1"), functionCall("live2")]]) {
    for (const path of ["/v1/responses", "/v1/chat/completions"]) {
      const { handler } = fake(() => new Response(liveOutputEvents(output).map(event).join("")));
      const response = await handler(request(path, path === "/v1/responses"
        ? { model: "gpt-6.1-sol", input: [{ role: "user", content: "Hi" }] } : chatBody()));
      assert.equal(response.status, 200);
      const body = await response.json();
      if (path === "/v1/responses") assert.deepEqual(body.output, output);
      else if (output[0].type === "message") {
        assert.equal(body.choices[0].message.content, "Live final text");
        assert.equal(body.choices[0].finish_reason, "stop");
      } else {
        assert.deepEqual(body.choices[0].message.tool_calls, output.map((call) => ({
          id: call.call_id, type: "function", function: { name: call.name, arguments: call.arguments },
        })));
        assert.equal(body.choices[0].finish_reason, "tool_calls");
      }
    }
  }
});

test("Chat streams text and a genuine two-turn tool roundtrip with empty terminal output", async () => {
  const calls = [functionCall("live1"), functionCall("live2")];
  let turn = 0;
  const fixture = fake(() => new Response(liveOutputEvents(++turn === 1 ? calls : [finalMessage("Tool results received")]).map(event).join("")));
  const first = await fixture.handler(request("/v1/chat/completions", chatBody({ stream: true })));
  const parsed = parseEvents(await first.text());
  assert.equal(parsed.at(-1), "[DONE]");
  assert.equal(parsed.at(-2).choices[0].finish_reason, "tool_calls");
  const tool_calls = calls.map((call) => ({ id: call.call_id, type: "function", function: { name: call.name, arguments: call.arguments } }));
  for (const [index, call] of calls.entries()) {
    const chunks = parsed.flatMap((chunk) => chunk.choices?.[0]?.delta?.tool_calls ?? []).filter((chunk) => chunk.index === index);
    assert.equal(chunks[0].id, call.call_id);
    assert.equal(chunks.map((chunk) => chunk.function.arguments ?? "").join(""), call.arguments);
  }
  const second = await fixture.handler(request("/v1/chat/completions", chatBody({ stream: true, messages: [
    { role: "user", content: "Hi" }, { role: "assistant", content: null, tool_calls },
    { role: "tool", tool_call_id: "call_live2", content: "Rome" }, { role: "tool", tool_call_id: "call_live1", content: "Paris" },
  ] })));
  const secondParsed = parseEvents(await second.text());
  assert.equal(secondParsed[0].choices[0].delta.content, "Tool results received");
  assert.equal(secondParsed.at(-2).choices[0].finish_reason, "stop");
  assert.equal(secondParsed.at(-1), "[DONE]");
  assert.deepEqual(JSON.parse(fixture.calls[1].options.body).input.filter((item) => item.type === "function_call_output")
    .map((item) => item.call_id), ["call_live2", "call_live1"]);
});

test("done items are ordered by output index and empty output never invents unfinished items", async () => {
  const items = [functionCall("ordered1"), functionCall("ordered2")];
  const reversed = [{ type: "response.output_item.done", output_index: 1, item: items[1] },
    { type: "response.output_item.done", output_index: 0, item: items[0] },
    { type: "response.completed", response: toolResponse([]) }];
  const { handler } = fake(() => new Response(reversed.map(event).join("")));
  const response = await handler(request("/v1/responses", { model: "gpt-6.1-sol", input: [{ role: "user", content: "Hi" }] }));
  assert.deepEqual((await response.json()).output, items);
  for (const path of ["/v1/responses", "/v1/chat/completions"]) {
    const fixture = fake(() => new Response(terminal("response.completed", toolResponse([]))));
    const body = path === "/v1/responses" ? { model: "gpt-6.1-sol", input: [{ role: "user", content: "Hi" }] } : chatBody();
    const empty = await fixture.handler(request(path, body));
    assert.equal(empty.status, 200);
    const emptyBody = await empty.json();
    if (path === "/v1/responses") assert.deepEqual(emptyBody.output, []);
    else assert.equal(emptyBody.choices[0].message.content, "");
  }
});

test("duplicate or conflicting output indexes and added/done identities never produce successful output", async () => {
  const item = finalMessage("Final");
  const added = { type: "response.output_item.added", output_index: 0, item: { ...item, status: "in_progress", content: [] } };
  const done = { type: "response.output_item.done", output_index: 0, item };
  for (const events of [
    [done, done],
    [done, { ...done, item: finalMessage("Different") }],
    [added, { ...done, item: { ...item, id: "msg_other" } }],
    [added, { ...done, item: { ...item, phase: "commentary" } }],
    [{ ...done, output_index: -1 }],
    [{ ...done, output_index: 256 }],
    [done, { type: "response.completed", response: toolResponse([finalMessage("Conflicting terminal")]) }],
  ]) {
    const wire = [...events, ...(events.at(-1).type === "response.completed" ? [] : [{ type: "response.completed", response: toolResponse([]) }])].map(event).join("");
    for (const path of ["/v1/responses", "/v1/chat/completions"]) {
      const fixture = fake(() => new Response(wire));
      const response = await fixture.handler(request(path, path === "/v1/responses"
        ? { model: "gpt-6.1-sol", input: [{ role: "user", content: "Hi" }] } : chatBody()));
      assert.notEqual(response.status, 200);
    }
    const fixture = fake(() => new Response(wire));
    const response = await fixture.handler(request("/v1/chat/completions", chatBody({ stream: true })));
    const parsed = parseEvents(await response.text());
    assert.equal(parsed.at(-1).error.code, "unsupported_output");
    assert.equal(parsed.includes("[DONE]"), false);
  }
});

test("Chat commentary never reaches content even when text precedes phase metadata", async () => {
  const commentary = finalMessage("private-commentary", { id: "msg_commentary", phase: "commentary" });
  const final = finalMessage("Final only");
  for (const delayedPhase of [false, true]) {
    const events = liveOutputEvents([commentary, final]);
    if (delayedPhase) [events[0], events[1]] = [events[1], events[0]];
    for (const stream of [false, true]) {
      const fixture = fake(() => new Response(events.map(event).join("")));
      const response = await fixture.handler(request("/v1/chat/completions", chatBody({ stream })));
      assert.equal(response.status, 200);
      const wire = await response.text();
      assert.doesNotMatch(wire, /private-commentary|msg_commentary/u);
      if (stream) {
        const parsed = parseEvents(wire);
        assert.equal(parsed[0].choices[0].delta.content, "Final only");
        assert.equal(parsed.at(-1), "[DONE]");
      } else assert.equal(JSON.parse(wire).choices[0].message.content, "Final only");
    }
  }
  const fixture = fake(() => new Response(liveOutputEvents([commentary, final]).map(event).join("")));
  const native = await fixture.handler(request("/v1/responses", { model: "gpt-6.1-sol", input: [{ role: "user", content: "Hi" }] }));
  assert.deepEqual((await native.json()).output, [commentary, final]);
});

test("Chat buffers unknown-phase text until done or populated terminal items establish final content", async () => {
  for (const phase of ["commentary", "final_answer", undefined, null]) {
    const item = finalMessage("Phase-bound text", { phase });
    for (const useDone of [true, false]) {
      const events = [{ type: "response.output_text.delta", output_index: 0, item_id: item.id, content_index: 0, delta: "Phase-bound text", logprobs: [] },
        ...(useDone ? [{ type: "response.output_item.done", output_index: 0, item }] : []),
        { type: "response.completed", response: toolResponse(useDone ? [] : [item]) }];
      const fixture = fake(() => new Response(events.map(event).join("")));
      const response = await fixture.handler(request("/v1/chat/completions", chatBody({ stream: true })));
      const parsed = parseEvents(await response.text());
      assert.equal(parsed.at(-1), "[DONE]");
      const content = parsed.map((chunk) => chunk.choices?.[0]?.delta?.content ?? "").join("");
      assert.equal(content, phase === "commentary" ? "" : "Phase-bound text");
    }
  }
});

test("output caps are dropped, chat effort becomes Responses reasoning, and other unsupported fields stay refused", async () => {
  const { handler, calls, tokenCalls } = fake();
  const base = { model: "gpt-6.1-sol", input: [{ role: "user", content: "Reply with OK." }] };
  assert.equal((await handler(request("/v1/responses", { ...base, max_output_tokens: 16 }))).status, 200);
  assert.equal("max_output_tokens" in JSON.parse(calls[0].options.body), false);
  const chat = { model: "gpt-6.1-sol", messages: [{ role: "user", content: "Reply with OK." }] };
  for (const cap of [{ max_completion_tokens: 16 }, { max_tokens: 64 }]) {
    assert.equal((await handler(request("/v1/chat/completions", { ...chat, ...cap }))).status, 200);
    const forwarded = JSON.parse(calls.at(-1).options.body);
    for (const name of ["max_completion_tokens", "max_tokens", "max_output_tokens"]) assert.equal(name in forwarded, false);
  }
  for (const effort of ["none", "minimal", "low", "medium", "high", "xhigh", "max"]) {
    assert.equal((await handler(request("/v1/chat/completions", { ...chat, reasoning_effort: effort }))).status, 200);
    const forwarded = JSON.parse(calls.at(-1).options.body);
    assert.deepEqual(forwarded.reasoning, { effort });
    assert.equal("reasoning_effort" in forwarded, false);
  }
  const dispatched = calls.length;
  for (const reasoning_effort of ["HIGH", "", "extreme", null, 1, { effort: "high" }]) {
    const response = await handler(request("/v1/chat/completions", { ...chat, reasoning_effort }));
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.param, "reasoning_effort");
  }
  for (const name of ["conversation", "max_tool_calls", "metadata", "moderation", "multi_agent", "prompt", "prompt_cache_retention",
    "safety_identifier", "temperature", "top_logprobs", "top_p", "truncation", "user", "previous_response_id"]) {
    const response = await handler(request("/v1/responses", { ...base, max_output_tokens: 16, [name]: 1 }));
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.param, name);
  }
  assert.deepEqual([calls.length, tokenCalls.length], [dispatched, dispatched]);
});

const question = { role: "user", content: "Weather in Paris?" };
const reference = (id) => ({ type: "item_reference", id });
const reasoningItem = (id, extra = {}) => ({ type: "reasoning", id, status: "completed",
  summary: [{ type: "summary_text", text: `${id} summary` }], encrypted_content: `${id}-encrypted`, ...extra });
const replayedReasoning = (id) => ({ type: "reasoning", id, encrypted_content: `${id}-encrypted`, summary: [{ type: "summary_text", text: `${id} summary` }] });
function replayFixture(options) {
  const replies = [];
  const fixture = fake(() => new Response(replies.shift() ?? terminal("response.completed", completed)), options);
  const turn = async (input, extra = {}) => (await fixture.handler(request("/v1/responses", { model: "gpt-6.1-sol", input, ...extra }))).text();
  const replayed = async (...ids) => {
    await turn([question, ...ids.map(reference)]);
    return JSON.parse(fixture.calls.at(-1).options.body).input.slice(1).map((item) => item.id);
  };
  return { ...fixture, replies, turn, replayed };
}

test("completed streamed and aggregated items replace item references in order and other references are dropped", async () => {
  const streamed = [reasoningItem("rs_streamed"), finalMessage("Checking.", { id: "msg_streamed", phase: "commentary" }), functionCall("streamed")];
  // Only reasoning with encrypted content and plain assistant text can be replayed under store:false.
  const unreplayable = [{ type: "reasoning", id: "rs_plain", status: "completed", summary: [] }, reasoningItem("rs_no_summary", { summary: null }),
    finalMessage("", { id: "msg_refusal", content: [{ type: "refusal", refusal: "No." }] }),
    finalMessage("", { id: "msg_mixed", content: [{ type: "output_text", text: "Yes" }, { type: "refusal", refusal: "No." }] }),
    { type: "web_search_call", id: "ws_1", status: "completed", action: { type: "search", query: "Paris" } }];
  // A valid phase is replayed with the text; a missing or unknown one is left out.
  const phased = [finalMessage("Done.", { id: "msg_aggregated" }), finalMessage("Plain.", { id: "msg_unphased", phase: null }),
    finalMessage("Odd.", { id: "msg_odd_phase", phase: "analysis" })];
  const aggregated = [reasoningItem("rs_aggregated"), ...phased, ...unreplayable];
  const { handler, calls, replies, turn } = replayFixture();
  // The live route sends response.completed with empty output, so streamed items come from output_item.done.
  replies.push(liveOutputEvents(streamed).map(event).join(""), terminal("response.completed", toolResponse(aggregated)));
  await turn([question], { stream: true });
  assert.deepEqual(JSON.parse(await turn([question])).output, aggregated);
  const result = { type: "function_call_output", call_id: "call_streamed", output: "20C" };
  const followUp = { role: "user", content: "And tomorrow?" };
  const response = await handler(request("/v1/responses", { model: "gpt-6.1-sol", input: [question, reference("rs_streamed"), reference("msg_streamed"),
    reference("fc_streamed"), functionCall("streamed"), result, reference("rs_unknown"), ...unreplayable.map((item) => reference(item.id)),
    reference("rs_aggregated"), ...phased.map((item) => reference(item.id)), followUp] }));
  assert.equal(response.status, 200);
  const replayedMessage = (id, text, phase) => ({ type: "message", role: "assistant", id, content: [{ type: "output_text", text }], ...(phase && { phase }) });
  assert.deepEqual(JSON.parse(calls[2].options.body).input, [question, replayedReasoning("rs_streamed"),
    replayedMessage("msg_streamed", "Checking.", "commentary"), functionCall("streamed"), result, replayedReasoning("rs_aggregated"),
    replayedMessage("msg_aggregated", "Done.", "final_answer"), replayedMessage("msg_unphased", "Plain."), replayedMessage("msg_odd_phase", "Odd."), followUp]);
});

test("item references that leave no input or lack a valid id are refused before credentials", async () => {
  const { handler, calls, tokenCalls } = fake();
  for (const input of [[reference("rs_unknown")], [reference("rs_unknown"), reference("msg_unknown")], [question, reference("rs.invalid")],
    [question, reference("r".repeat(129))], [question, { type: "item_reference" }], [question, reference(42)]]) {
    const response = await handler(request("/v1/responses", { model: "gpt-6.1-sol", input, tools: [functionTool] }));
    assert.equal(response.status, 400);
    assert.equal((await response.json()).error.param, "input");
  }
  assert.deepEqual([calls.length, tokenCalls.length], [0, 0]);
});

test("a repeated item reference expands once", async () => {
  const { replies, turn, replayed } = replayFixture();
  replies.push(terminal("response.completed", toolResponse([reasoningItem("rs_once"), finalMessage("Two parts.", { id: "msg_once" })])));
  await turn([question]);
  assert.deepEqual(await replayed("rs_once", "msg_once", "msg_once", ...Array(250).fill("rs_once")), ["rs_once", "msg_once"]);
});

test("a pass-through stream whose items cannot be tracked reaches the client unchanged and caches nothing", async () => {
  // About 1.1 MiB each: every event fits the 2 MiB event limit, but together they exceed the tracked-output limit.
  const large = (index) => ({ type: "reasoning", id: `rs_untracked_${index}`, summary: [], encrypted_content: "e".repeat(1_150_000) });
  const events = [
    { type: "response.output_item.done", sequence_number: 0, output_index: 0, item: large(0) },
    { type: "response.output_item.done", sequence_number: 1, output_index: 1, item: large(1) },
    { type: "response.completed", sequence_number: 2, response: toolResponse([]) },
  ];
  const chunks = events.map(event);
  let turn = 0;
  const { handler, calls } = fake(() => ++turn > 1 ? new Response(terminal("response.completed", completed)) : new Response(new ReadableStream({
    pull(controller) {
      if (chunks.length) controller.enqueue(new TextEncoder().encode(chunks.shift()));
      else controller.close();
    },
  })));
  const response = await handler(request("/v1/responses", { model: "gpt-6.1-sol", input: [question], stream: true }));
  assert.deepEqual(parseEvents(await response.text()), events);
  const followUp = await handler(request("/v1/responses", { model: "gpt-6.1-sol", input: [question, reference("rs_untracked_0"), reference("rs_untracked_1")] }));
  assert.equal(followUp.status, 200);
  assert.deepEqual(JSON.parse(calls[1].options.body).input, [question]);
});

test("only items from completed responses are replayed, never from failed, incomplete or interrupted ones", async () => {
  const started = liveOutputEvents([reasoningItem("rs_unfinished")]).slice(0, -1).map(event);
  for (const [ending, cached] of [
    [event({ type: "response.completed", response: toolResponse([]) }), true],
    [event({ type: "response.failed", response: { error: { code: "server_error", message: "Failed" } } }), false],
    [event({ type: "response.incomplete", response: { incomplete_details: { reason: "max_output_tokens" } } }), false],
    [event({ type: "response.completed", response: { ...toolResponse([]), status: "failed" } }), false],
    ["", false], [null, false],
  ]) {
    for (const stream of [true, false]) {
      const chunks = [...started, ...(ending ? [ending] : [])];
      let turn = 0;
      const { handler, calls } = fake(() => ++turn > 1 ? new Response(terminal("response.completed", completed)) : new Response(new ReadableStream({
        pull(controller) {
          if (chunks.length) controller.enqueue(new TextEncoder().encode(chunks.shift()));
          else if (ending === null) controller.error(new Error("socket failed"));
          else controller.close();
        },
      })));
      await (await handler(request("/v1/responses", { model: "gpt-6.1-sol", input: [question], stream }))).text();
      assert.equal((await handler(request("/v1/responses", { model: "gpt-6.1-sol", input: [question, reference("rs_unfinished")] }))).status, 200);
      assert.deepEqual(JSON.parse(calls[1].options.body).input, cached ? [question, replayedReasoning("rs_unfinished")] : [question],
        `${ending?.split("\n")[0]} stream=${stream}`);
    }
  }
});

test("upstream asks for encrypted reasoning only when the request sets reasoning and keeps valid client include values", async () => {
  const { handler, calls } = fake();
  const base = { model: "gpt-6.1-sol", input: [{ role: "user", content: "Hi" }] };
  const encrypted = "reasoning.encrypted_content";
  for (const [reasoning, include, expected] of [
    [undefined, undefined, undefined], [null, undefined, undefined], [undefined, [], []],
    [undefined, ["web_search_call.action.sources"], ["web_search_call.action.sources"]], [undefined, [encrypted], [encrypted]],
    [{ effort: "high" }, undefined, [encrypted]], [{}, [], [encrypted]],
    [{ effort: "low" }, ["web_search_call.action.sources"], ["web_search_call.action.sources", encrypted]],
    [{ effort: "low" }, [encrypted, "message.input_image.image_url"], [encrypted, "message.input_image.image_url"]],
  ]) {
    for (const stream of [false, true]) {
      assert.equal((await handler(request("/v1/responses", { ...base, reasoning, include, stream }))).status, 200);
      assert.deepEqual(JSON.parse(calls.at(-1).options.body).include, expected, `${JSON.stringify(reasoning)} ${JSON.stringify(include)}`);
    }
  }
  const refused = await handler(request("/v1/responses", { ...base, reasoning: { effort: "high" }, include: [encrypted, "file_search_call.results"] }));
  assert.equal(refused.status, 400);
  assert.equal((await refused.json()).error.param, "include");
  assert.equal(calls.length, 18);
});

test("cached items expire six hours after insertion even when recently used", async () => {
  let clock = 1_000_000;
  const { replies, turn, replayed } = replayFixture({ now: () => clock });
  replies.push(terminal("response.completed", toolResponse([reasoningItem("rs_aged")])));
  await turn([question]);
  clock += 6 * 60 * 60 * 1000 - 1;
  assert.deepEqual(await replayed("rs_aged"), ["rs_aged"]);
  clock += 1;
  assert.deepEqual(await replayed("rs_aged"), []);
});

test("expired items leave the item cache before unexpired ones are evicted", async () => {
  let clock = 0;
  const { replies, turn, replayed } = replayFixture({ now: () => clock });
  replies.push(terminal("response.completed", toolResponse([reasoningItem("rs_old")])));
  await turn([question]);
  clock = 60 * 60 * 1000;
  for (let batch = 0; batch < 16; batch++) {
    replies.push(terminal("response.completed", toolResponse(Array.from({ length: Math.min(256, 4095 - batch * 256) },
      (_, index) => reasoningItem(`rs_fresh_${batch * 256 + index}`)))));
    await turn([question]);
  }
  clock = 5 * 60 * 60 * 1000;
  assert.deepEqual(await replayed("rs_old"), ["rs_old"]);
  clock = 6 * 60 * 60 * 1000;
  replies.push(terminal("response.completed", toolResponse([reasoningItem("rs_new")])));
  await turn([question]);
  assert.deepEqual(await replayed("rs_old", "rs_fresh_0", "rs_new"), ["rs_fresh_0", "rs_new"]);
});

test("the item cache holds 4096 items and evicts the least recently used first", async () => {
  const { replies, turn, replayed } = replayFixture();
  for (let batch = 0; batch < 16; batch++) {
    replies.push(terminal("response.completed", toolResponse(Array.from({ length: 256 }, (_, index) => reasoningItem(`rs_${batch * 256 + index}`)))));
    await turn([question]);
  }
  assert.deepEqual(await replayed("rs_0"), ["rs_0"]);
  replies.push(terminal("response.completed", toolResponse([reasoningItem("rs_4096")])));
  await turn([question]);
  assert.deepEqual(await replayed("rs_0", "rs_1", "rs_2", "rs_4095", "rs_4096"), ["rs_0", "rs_2", "rs_4095", "rs_4096"]);
});

test("the item cache holds at most 32 MiB of serialized items and evicts the least recently used first", async () => {
  const { replies, turn, replayed } = replayFixture();
  // About 2 MB each: sixteen fit in 32 MiB and a seventeenth does not.
  const large = (index) => ({ type: "reasoning", id: `rs_large_${index}`, summary: [], encrypted_content: "e".repeat(1_999_900) });
  for (let index = 0; index < 16; index++) {
    replies.push(terminal("response.completed", toolResponse([large(index)])));
    await turn([question]);
  }
  assert.deepEqual(await replayed("rs_large_0"), ["rs_large_0"]);
  replies.push(terminal("response.completed", toolResponse([large(16)])));
  await turn([question]);
  for (const [id, kept] of [["rs_large_1", false], ["rs_large_0", true], ["rs_large_2", true], ["rs_large_16", true]]) {
    assert.deepEqual(await replayed(id), kept ? [id] : [], id);
  }
});

test("item references cannot expand a request past the body limit", async () => {
  const { handler, calls, replies, turn } = replayFixture();
  // About 750 KB each: two fit the 2 MiB copy budget and three do not.
  const wide = (index) => ({ type: "reasoning", id: `rs_wide_${index}`, summary: [], encrypted_content: "e".repeat(750_000) });
  replies.push(terminal("response.completed", toolResponse([wide(0), wide(1)])), terminal("response.completed", toolResponse([wide(2)])));
  await turn([question]);
  await turn([question]);
  const refused = await handler(request("/v1/responses", { model: "gpt-6.1-sol",
    input: [question, reference("rs_wide_0"), reference("rs_wide_1"), reference("rs_wide_2")] }));
  assert.equal(refused.status, 413);
  assert.equal((await refused.json()).error.param, "input");
  assert.equal(calls.length, 2);
  await turn([question, reference("rs_wide_0"), reference("rs_wide_2")]);
  assert.deepEqual(JSON.parse(calls[2].options.body).input.map((item) => item.encrypted_content?.length), [undefined, 750_000, 750_000]);
});

test("Responses stream errors carry type, sequence numbers and a top-level error, terminal frames keep usage and reasons, Chat keeps its error body, and no frame leaks the token", async () => {
  const started = [{ type: "response.created", sequence_number: 0, response: { id: "resp_1", status: "in_progress", output: [] } },
    { type: "response.output_text.delta", sequence_number: 1, item_id: "msg_1", output_index: 0, content_index: 0, delta: "provider-token partial", logprobs: [] }];
  const streamed = async (ending, path, body) => {
    const chunks = [...started.map(event), ...(ending ? [ending] : [])];
    const { handler } = fake(() => new Response(new ReadableStream({
      pull(controller) {
        if (chunks.length) controller.enqueue(new TextEncoder().encode(chunks.shift()));
        else if (ending === null) controller.error(new Error("socket failed"));
        else controller.close();
      },
    }), { headers: { "x-request-id": "provider-token" } }));
    const wire = await (await handler(request(path, body))).text();
    assert.equal(wire.includes("provider-token"), false);
    return wire;
  };
  const interrupted = { type: "error", sequence_number: 2, code: "stream_interrupted", param: null };
  const usage = { input_tokens: 5, input_tokens_details: { cached_tokens: 1 }, output_tokens: 7, output_tokens_details: { reasoning_tokens: 3 }, total_tokens: 12 };
  const terminalFrame = (type, sequence_number, incomplete_details, frameUsage) => ({ type, sequence_number, response: { incomplete_details, usage: frameUsage } });
  for (const [ending, last] of [
    ["", interrupted], [null, interrupted], ["data: {broken\n\n", interrupted],
    [event({ type: "response.failed", sequence_number: 7, response: { error: { code: "server_error", message: "Failed for provider-token" },
      usage: { ...usage, output_tokens_details: { reasoning_tokens: "3" } } } }),
      terminalFrame("response.failed", 7, undefined, { ...usage, output_tokens_details: {} })],
    [event({ type: "response.incomplete", response: { incomplete_details: { reason: "max_output_tokens" }, usage } }),
      terminalFrame("response.incomplete", 2, { reason: "max_output_tokens" }, usage)],
    // AI SDK would read usage without a reason as a clean stop.
    [event({ type: "response.incomplete", response: { usage } }), terminalFrame("response.incomplete", 2, undefined, undefined)],
    // AI SDK would drop the whole frame for a count it cannot parse.
    [event({ type: "response.incomplete", response: { incomplete_details: { reason: "content_filter" }, usage: { ...usage, input_tokens: "5" } } }),
      terminalFrame("response.incomplete", 2, { reason: "content_filter" }, undefined)],
  ]) {
    const wire = await streamed(ending, "/v1/responses", { model: "gpt-6.1-sol", input: [{ role: "user", content: "Hi" }], stream: true });
    assert.match(wire, new RegExp(`event: ${last.type}\\ndata: [^\\n]*\\n\\n$`, "u"));
    const frame = parseEvents(wire).at(-1);
    for (const [key, value] of Object.entries(last)) {
      if (key !== "response") assert.deepEqual(frame[key], value, key);
      else for (const [field, expected] of Object.entries(value)) assert.deepEqual(frame.response[field], expected, field);
    }
    assert.equal(typeof (frame.message ?? frame.response.error.message), "string");
    // openai-node raises only on a top-level error. No type inside it: AI SDK would then parse the nested shape and lose the message.
    if (frame.type === "error") assert.deepEqual(frame.error, { code: frame.code, message: frame.message });
    if (frame.type === "response.failed") assert.deepEqual(frame.error, { code: frame.response.error.code, message: frame.response.error.message });
  }
  for (const ending of ["", null]) {
    const frame = parseEvents(await streamed(ending, "/v1/chat/completions", chatBody({ stream: true }))).at(-1);
    assert.deepEqual([frame.error.code, frame.status, frame.sequence_number], ["stream_interrupted", 502, undefined]);
  }
});

test("requests may define up to 128 tools while one response still carries at most 32 tool calls", async () => {
  const { handler, calls } = fake();
  const defined = (count) => Array.from({ length: count }, (_, index) => ({ ...functionTool, name: `lookup${index}` }));
  const input = [{ role: "user", content: "Hi" }];
  for (const [count, status] of [[128, 200], [129, 400]]) {
    for (const [path, body, param] of [
      ["/v1/responses", { model: "gpt-6.1-sol", input, tools: defined(count) }, "tools"],
      ["/v1/responses", { model: "gpt-6.1-sol", input: [{ type: "additional_tools", role: "developer", tools: defined(count) }, ...input] }, "input"],
      ["/v1/responses", { model: "gpt-6.1-sol", input, tools: [{ type: "namespace", name: "crm", description: "CRM", tools: defined(count) }] }, "tools"],
      ["/v1/chat/completions", { model: "gpt-6.1-sol", messages: input, tools: defined(count).map(({ type, ...definition }) => ({ type, function: definition })) }, "tools"],
    ]) {
      const response = await handler(request(path, body));
      assert.equal(response.status, status, `${path} ${param} ${count}`);
      if (status === 400) assert.equal((await response.json()).error.param, param);
    }
  }
  assert.equal(calls.length, 4);
  const thirtyThree = fake(() => new Response(terminal("response.completed", toolResponse(Array.from({ length: 33 }, (_, index) => functionCall(String(index)))))));
  const refused = await thirtyThree.handler(request("/v1/chat/completions", chatBody()));
  assert.equal(refused.status, 422);
});

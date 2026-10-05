import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import { createSidecarHandler, createSidecarServer, listSiwcModels } from "../src/gateway/openai-oauth-sidecar.mjs";

const credential = "local_client_credential_123456789";
const verifier = createHash("sha256").update(credential).digest();
const registration = { storageRoot: "/tmp/test-siwc", registrationId: "first" };
const terminal = (type, response) => `event: ${type}\ndata: ${JSON.stringify({ type, response })}\n\n`;
const completed = { id: "resp_1", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "Hello" }] }] };
const fake = (onFetch = () => new Response(terminal("response.completed", completed), { headers: { "content-type": "text/event-stream" } })) => {
  const calls = [];
  const tokenCalls = [];
  const handler = createSidecarHandler({ registration, runtimeId: "runtime-1", tokenVerifier: verifier,
    getToken: async (selected, options) => { tokenCalls.push(selected); assert.deepEqual(selected, registration); assert.equal(options.runtimeId, "runtime-1"); return { accessToken: "provider-token" }; },
    fetchImpl: async (url, options) => { calls.push({ url, options }); return onFetch(url, options); },
  });
  return { handler, calls, tokenCalls };
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

test("catalog preserves listed server order and display names without synthetic image models", async () => {
  const provider = () => Response.json({ models: [
    { slug: "z-model", display_name: "Z model", visibility: "list" },
    { slug: "private", visibility: "hidden" },
    { slug: "a-model", display_name: "A model", visibility: "list" },
  ] });
  const { handler } = fake(provider);
  const response = await handler(request("/v1/models"));
  assert.deepEqual((await response.json()).data, [
    { id: "z-model", object: "model", display_name: "Z model" },
    { id: "a-model", object: "model", display_name: "A model" },
  ]);
  assert.deepEqual(await listSiwcModels({ ...registration, runtimeId: "runtime-1", getToken: async () => ({ accessToken: "provider-token" }), fetchImpl: provider }), [
    { slug: "z-model", display_name: "Z model" }, { slug: "a-model", display_name: "A model" },
  ]);
});

test("rejects unsupported parameters, tools, routes, and storage before provider dispatch", async () => {
  const { handler, calls } = fake();
  const base = { model: "gpt-6.1-sol", input: [{ role: "user", content: "Hi" }] };
  for (const [body, param] of [
    [{ ...base, store: true }, "store"], [{ ...base, max_output_tokens: 20 }, "max_output_tokens"],
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

  const textDelta = { type: "response.output_text.delta", delta: "partial" };
  const failed = fake(() => new Response(`event: response.output_text.delta\ndata: ${JSON.stringify(textDelta)}\n\n${terminal("response.failed", { error: { code: "subscription_sharing_usage_limit_exceeded", message: "Limit" } })}`, { headers: { "x-request-id": "req_limit" } }));
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
    [functionTool, functionTool], Array.from({ length: 33 }, (_, i) => ({ ...functionTool, name: `lookup${i}` })),
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

import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { once } from "node:events";
import test from "node:test";
import { createSidecarHandler, createSidecarServer } from "../src/gateway/openai-oauth-sidecar.mjs";

const MiB = 1024 * 1024;
const credential = "local_client_credential_123456789";
const verifier = createHash("sha256").update(credential).digest();
const registration = { storageRoot: "/tmp/test-siwc-images", registrationId: "first" };
const imageToken = "codex-images-access-token-987654321";
const signedLease = { accessToken: imageToken, accountId: "acct_1234567890", residency: "us", fedramp: true };
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const generated = () => Response.json({ created: 1778832973, data: [{ b64_json: "aW1hZ2U=", generation_id: "gen_1" }],
  size: "1024x1024", quality: "high", background: "opaque", output_format: "png", usage: { total_tokens: 10 } });
const leaseError = (code, message = "lease failed") => Object.assign(new Error(message), { code });
const headers = { host: "n8n-openai-oauth:10531", authorization: `Bearer ${credential}` };
const editFields = { prompt: "Add a red hat to the cat", model: "gpt-image-2" };

function setup({ upstream = generated, lease = async () => signedLease, status = async () => ({ state: "signed-in" }) } = {}) {
  const calls = [];
  const counts = { lease: 0, siwc: 0 };
  const handler = createSidecarHandler({ registration, runtimeId: "runtime-1", tokenVerifier: verifier,
    getToken: async () => { counts.siwc += 1; return { accessToken: "siwc-text-token-123456" }; },
    getImagesLease: async () => { counts.lease += 1; return lease(); },
    imagesStatus: status,
    discovery: { listModels: async () => ({ models: [{ id: "gpt-6.1-sol", display_name: "GPT 6.1 Sol" }] }), recordOutcome: async () => {} },
    fetchImpl: async (url, options) => { calls.push({ url, options }); return upstream(url, options); },
  });
  return { handler, calls, counts };
}
const sent = (call) => JSON.parse(call.options.body);
const generate = (body, extra = {}) => new Request("http://local.test/v1/images/generations", { method: "POST", headers: { ...headers, ...extra },
  body: typeof body === "string" ? body : JSON.stringify(body) });
const edit = (body, extra = {}) => new Request("http://local.test/v1/images/edits", { method: "POST", headers: { ...headers, ...extra }, body });
const rawEdit = (text, contentType = "multipart/form-data; boundary=XyZ") => edit(Buffer.from(text), { "content-type": contentType });
function form(fields, images = [{ bytes: png, type: "image/png" }]) {
  const data = new FormData();
  for (const image of images) data.append(image.name ?? "image[]", new Blob([image.bytes], { type: image.type }), image.filename ?? "input.png");
  for (const [key, value] of Object.entries(fields)) data.append(key, value);
  return data;
}
// undici's FormData stream rejects after an early cancel, so oversized bodies are sent as bytes.
async function encoded(data) {
  const response = new Response(data);
  return edit(Buffer.from(await response.arrayBuffer()), { "content-type": response.headers.get("content-type") });
}
async function refusal(response) {
  const body = await response.json();
  return [response.status, body.error.code, body.error.param];
}

test("generation maps every accepted field to the Codex images request with its own identity", async () => {
  const { handler, calls, counts } = setup();
  const response = await handler(generate({ prompt: "A lighthouse at dusk", model: "gpt-image-2", quality: "standard", size: "1536x1024",
    background: "transparent", n: 1, response_format: "b64_json", user: "u-1", output_format: "png", output_compression: 80 }));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { created: 1778832973, data: [{ b64_json: "aW1hZ2U=" }], size: "1024x1024", quality: "high", background: "opaque" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, "https://chatgpt.com/backend-api/codex/images/generations");
  assert.equal(calls[0].options.method, "POST");
  assert.equal(calls[0].options.redirect, "error");
  assert.deepEqual(sent(calls[0]), { prompt: "A lighthouse at dusk", model: "gpt-image-2", quality: "auto", size: "1536x1024", background: "transparent" });
  const upstreamHeaders = new Headers(calls[0].options.headers);
  assert.equal(upstreamHeaders.get("authorization"), `Bearer ${imageToken}`);
  assert.equal(upstreamHeaders.get("chatgpt-account-id"), "acct_1234567890");
  assert.equal(upstreamHeaders.get("x-openai-internal-codex-residency"), "us");
  assert.equal(upstreamHeaders.get("x-openai-fedramp"), "true");
  assert.equal(upstreamHeaders.get("originator"), "relmio");
  assert.match(upstreamHeaders.get("user-agent"), /^Relmio \(/u);
  assert.match(upstreamHeaders.get("x-codex-image-turn-id"), /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u);
  assert.equal(upstreamHeaders.get("content-type"), "application/json");
  assert.equal(counts.siwc, 0);
});

test("absent options and lease claims are omitted and every request gets a fresh turn id", async () => {
  const { handler, calls } = setup({ lease: async () => ({ accessToken: imageToken, accountId: "acct_1234567890", fedramp: false }),
    upstream: () => Response.json({ data: [{ b64_json: "eA==" }], size: { width: 1 } }) });
  for (let index = 0; index < 2; index += 1) {
    const body = await (await handler(generate({ prompt: "A fox", model: "gpt-image-2" }))).json();
    assert.deepEqual(Object.keys(body).sort(), ["created", "data"]);
    assert.ok(Number.isSafeInteger(body.created));
  }
  assert.deepEqual(sent(calls[0]), { prompt: "A fox", model: "gpt-image-2" });
  const [first, second] = calls.map((call) => new Headers(call.options.headers));
  assert.equal(first.has("x-openai-internal-codex-residency"), false);
  assert.equal(first.has("x-openai-fedramp"), false);
  assert.notEqual(first.get("x-codex-image-turn-id"), second.get("x-codex-image-turn-id"));
});

test("edit converts multipart image parts to ordered data URLs and maps n8n's string fields", async () => {
  const { handler, calls } = setup();
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 9]);
  const response = await handler(edit(form({ ...editFields, n: "1", size: "1024x1024", quality: "standard", background: "opaque", input_fidelity: "high",
    user: "u-1", response_format: "b64_json", output_format: "png" }, [{ bytes: png, type: "image/png" }, { bytes: jpeg, type: "image/jpeg", name: "image" }])));
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data, [{ b64_json: "aW1hZ2U=" }]);
  assert.equal(calls[0].url, "https://chatgpt.com/backend-api/codex/images/edits");
  assert.equal(new Headers(calls[0].options.headers).get("content-type"), "application/json");
  assert.deepEqual(sent(calls[0]), { prompt: editFields.prompt, model: "gpt-image-2", quality: "auto", size: "1024x1024", background: "opaque",
    images: [{ image_url: `data:image/png;base64,${png.toString("base64")}` }, { image_url: `data:image/jpeg;base64,${jpeg.toString("base64")}` }] });
});

test("hand-built multipart accepts quoted boundaries, unquoted names and media type parameters", async () => {
  const { handler, calls } = setup();
  const body = "--XyZ\r\nContent-Disposition: form-data; name=prompt\r\n\r\nA fox\r\n" +
    "--XyZ\r\ncontent-disposition: form-data; name=\"model\"\r\n\r\ngpt-image-2\r\n" +
    "--XyZ\r\nContent-Disposition: form-data; name=\"image\"; filename=\"a.webp\"\r\nContent-Type: IMAGE/WEBP; charset=binary\r\n\r\nRIFF\r\n--XyZ--\r\nepilogue";
  assert.equal((await handler(rawEdit(body, "multipart/form-data; boundary=\"XyZ\""))).status, 200);
  assert.deepEqual(sent(calls[0]), { prompt: "A fox", model: "gpt-image-2", images: [{ image_url: `data:image/webp;base64,${Buffer.from("RIFF").toString("base64")}` }] });
});

test("only gpt-image-2 is accepted on both image routes", async () => {
  const { handler, calls } = setup();
  for (const request of [generate({ prompt: "A fox", model: "gpt-image-1" }), generate({ prompt: "A fox" }), edit(form({ prompt: "A fox", model: "dall-e-2" }))]) {
    const response = await handler(request);
    const { error } = await response.json();
    assert.deepEqual([response.status, error.code, error.param], [400, "unsupported_model", "model"]);
    assert.match(error.message, /gpt-image-2/u);
  }
  assert.equal(calls.length, 0);
});

test("generation refuses counts, url responses, unknown fields, bad values and oversized JSON before dispatch", async () => {
  const { handler, calls } = setup();
  const base = { prompt: "A fox", model: "gpt-image-2" };
  for (const [body, expected] of [
    [{ ...base, n: 2 }, [400, "unsupported_parameter", "n"]],
    [{ ...base, n: "4" }, [400, "unsupported_parameter", "n"]],
    [{ ...base, response_format: "url" }, [400, "unsupported_parameter", "response_format"]],
    [{ ...base, mask: "x" }, [400, "unsupported_parameter", "mask"]],
    [{ ...base, style: "vivid" }, [400, "unsupported_parameter", "style"]],
    [{ ...base, size: "512x512" }, [400, "invalid_value", "size"]],
    [{ ...base, quality: "hd" }, [400, "invalid_value", "quality"]],
    [{ ...base, background: "white" }, [400, "invalid_value", "background"]],
    [{ model: "gpt-image-2" }, [400, "invalid_value", "prompt"]],
    [{ ...base, prompt: "" }, [400, "invalid_value", "prompt"]],
    [{ ...base, prompt: 42 }, [400, "invalid_value", "prompt"]],
    [{ ...base, prompt: "x".repeat(32_001) }, [400, "invalid_value", "prompt"]],
    ["[]", [400, "invalid_json", "body"]],
    ["{", [400, "invalid_json", "body"]],
  ]) assert.deepEqual(await refusal(await handler(generate(body))), expected, JSON.stringify(body).slice(0, 80));
  assert.equal(calls.length, 0);
  const filler = 64 * 1024 - JSON.stringify({ ...base, user: "" }).length;
  assert.equal((await handler(generate({ ...base, user: "x".repeat(filler) }))).status, 200);
  assert.deepEqual(await refusal(await handler(generate({ ...base, user: "x".repeat(filler + 1) }))), [413, "body_too_large", "body"]);
  assert.equal((await handler(generate({ ...base, prompt: "x".repeat(32_000) }))).status, 200);
  assert.equal(calls.length, 2);
});

test("edit refuses masks, url responses, extra counts, unsupported sizes and bad images before dispatch", async () => {
  const { handler, calls } = setup();
  const duplicate = form(editFields);
  duplicate.append("prompt", "Another prompt");
  for (const [data, expected] of [
    [form({ ...editFields, mask: new Blob([png], { type: "image/png" }) }), [400, "unsupported_parameter", "mask"]],
    [form({ ...editFields, response_format: "url" }), [400, "unsupported_parameter", "response_format"]],
    [form({ ...editFields, n: "2" }), [400, "unsupported_parameter", "n"]],
    [form({ ...editFields, size: "256x256" }), [400, "invalid_value", "size"]],
    [form({ ...editFields, size: "512x512" }), [400, "invalid_value", "size"]],
    [form(editFields, []), [400, "invalid_value", "image"]],
    [form(editFields, Array.from({ length: 17 }, () => ({ bytes: png, type: "image/png" }))), [400, "invalid_value", "image"]],
    [form(editFields, [{ bytes: Buffer.from("<svg/>"), type: "image/svg+xml" }]), [400, "invalid_value", "image"]],
    [form(editFields, [{ bytes: Buffer.alloc(0), type: "image/png" }]), [400, "invalid_value", "image"]],
    [duplicate, [400, "invalid_multipart", "prompt"]],
  ]) assert.deepEqual(await refusal(await handler(edit(data))), expected);
  assert.equal(calls.length, 0);
  assert.equal((await handler(edit(form(editFields, Array.from({ length: 16 }, () => ({ bytes: png, type: "image/gif" })))))).status, 200);
  assert.equal(sent(calls[0]).images.length, 16);
});

test("edit enforces part count, per-part header, per-image and total body limits", async () => {
  const { handler, calls } = setup();
  const parts = (count) => Array.from({ length: count }, () => ({ bytes: png, type: "image/png" }));
  assert.deepEqual(await refusal(await handler(edit(form(editFields, parts(62))))), [400, "invalid_value", "image"]);
  assert.deepEqual(await refusal(await handler(edit(form(editFields, parts(63))))), [400, "invalid_multipart", "body"]);
  assert.equal((await handler(edit(form(editFields, [{ bytes: png, type: "image/png", filename: "x".repeat(8_000) }])))).status, 200);
  assert.deepEqual(await refusal(await handler(edit(form(editFields, [{ bytes: png, type: "image/png", filename: "x".repeat(8_200) }])))), [400, "invalid_multipart", "body"]);
  assert.equal((await handler(edit(form(editFields, [{ bytes: Buffer.alloc(25 * MiB), type: "image/png" }])))).status, 200);
  assert.deepEqual(await refusal(await handler(edit(form(editFields, [{ bytes: Buffer.alloc(25 * MiB + 1), type: "image/png" }])))), [413, "image_too_large", "image"]);
  assert.equal((await handler(edit(form(editFields, [{ bytes: Buffer.alloc(23 * MiB), type: "image/png" }, { bytes: Buffer.alloc(24 * MiB), type: "image/png" }])))).status, 200);
  assert.deepEqual(await refusal(await handler(await encoded(form(editFields, [{ bytes: Buffer.alloc(24 * MiB), type: "image/png" }, { bytes: Buffer.alloc(24 * MiB), type: "image/png" }])))), [413, "body_too_large", "body"]);
  assert.equal(calls.length, 3);
});

test("crafted long header lines parse in linear time", async () => {
  const { handler, calls } = setup();
  const part = `--XyZ\r\nContent-Disposition: form-data; name="image"\r\na:x${" ".repeat(8_100)}y\r\n\r\nv\r\n`;
  const started = performance.now();
  const response = await handler(rawEdit(`${part.repeat(64)}--XyZ--\r\n`));
  const elapsed = performance.now() - started;
  assert.equal(response.status, 400);
  assert.ok(elapsed < 200, `${elapsed} ms`);
  assert.equal(calls.length, 0);
});

test("malformed multipart bodies are refused before dispatch", async () => {
  const { handler, calls } = setup();
  const model = "Content-Disposition: form-data; name=\"model\"\r\n\r\ngpt-image-2";
  for (const [body, contentType] of [
    [`--XyZ\r\n${model}\r\n--XyZ--\r\n`, "application/json"],
    [`--XyZ\r\n${model}\r\n--XyZ--\r\n`, "multipart/form-data"],
    [`--XyZ\r\n${model}\r\n--XyZ--\r\n`, "multipart/form-data; boundary=bad\u00e9"],
    [`preamble\r\n--XyZ\r\n${model}\r\n--XyZ--\r\n`],
    [`--XyZ\r\n${model}\r\n--XyZ`],
    [`--XyZ\r\n${model}\r\n`],
    ["--XyZ\r\nContent-Type: text/plain\r\n\r\ngpt-image-2\r\n--XyZ--\r\n"],
    ["--XyZ\r\nContent-Disposition: attachment; name=\"model\"\r\n\r\ngpt-image-2\r\n--XyZ--\r\n"],
    ["--XyZ\r\nContent-Disposition: form-data; filename=\"a.png\"\r\n\r\ngpt-image-2\r\n--XyZ--\r\n"],
    [`--XyZ\r\n${model.replace(": ", ":\n ")}\r\n--XyZ--\r\n`],
    [`--XyZ\r\n${model.replaceAll("\r\n", "\n")}\n--XyZ--\n`],
    [`--XyZ\r\n${model}\r\n--XyZ\r\nContent-Disposition: form-data; name="a"\r\nContent-Disposition: form-data; name="b"\r\n\r\nx\r\n--XyZ--\r\n`],
    [`--XyZ  \r\n${model}\r\n--XyZ--\r\n`],
  ]) assert.deepEqual(await refusal(await handler(rawEdit(body, contentType))), [400, "invalid_multipart", "body"], JSON.stringify(body));
  assert.equal(calls.length, 0);
});

test("lease states map to off, reauthorize and unavailable before validation or dispatch", async () => {
  for (const [code, status, recovery] of [["images_off", 404, "fix-request"], ["images_reauthorize", 401, "reauthorize"],
    ["images_unavailable", 503, "retry-later"], [undefined, 503, "retry-later"]]) {
    const { handler, calls } = setup({ lease: async () => { throw leaseError(code, `stored ${imageToken}`); } });
    for (const request of [generate({ prompt: "A fox", model: "gpt-image-1" }), edit(form(editFields)), rawEdit("not multipart")]) {
      const response = await handler(request);
      const text = await response.text();
      const body = JSON.parse(text);
      assert.deepEqual([response.status, body.error.code, body.recovery], [status, code ?? "images_unavailable", recovery]);
      assert.equal(text.includes(imageToken), false);
      assert.equal(request.bodyUsed, false, "the add-on state is checked before the body is read");
    }
    assert.equal(calls.length, 0);
  }
});

test("one image edit runs at a time; a concurrent edit is refused before its lease or body", async () => {
  let entered, release;
  const leased = new Promise((resolve) => { entered = resolve; });
  const gate = new Promise((resolve) => { release = resolve; });
  let lease = async () => { lease = async () => signedLease; entered(); await gate; return signedLease; };
  const { handler, counts } = setup({ lease: () => lease() });
  const first = handler(edit(form(editFields)));
  await leased;
  const second = edit(form(editFields));
  const refused = await handler(second);
  const body = await refused.json();
  assert.deepEqual([refused.status, body.error.code, body.recovery], [429, "images_busy", "retry-later"]);
  assert.equal(second.bodyUsed, false);
  assert.equal(counts.lease, 1);
  assert.equal((await handler(generate({ prompt: "A fox", model: "gpt-image-2" }))).status, 200, "generations are not held by an edit");
  release();
  assert.equal((await first).status, 200);
  lease = async () => { throw leaseError("images_off"); };
  assert.equal((await handler(edit(form(editFields)))).status, 404);
  lease = async () => signedLease;
  assert.equal((await handler(edit(form(editFields)))).status, 200, "a finished or failed edit frees the slot");
});

test("origin, host, bearer and method gates precede the image lease", async () => {
  const { handler, counts, calls } = setup();
  for (const [request, status] of [
    [new Request("http://local.test/v1/images/edits", { method: "POST", headers: { host: headers.host }, body: "x" }), 401],
    [generate({ prompt: "A fox", model: "gpt-image-2" }, { authorization: "Bearer wrong_local_credential" }), 401],
    [generate({ prompt: "A fox", model: "gpt-image-2" }, { origin: "https://example.test" }), 403],
    [generate({ prompt: "A fox", model: "gpt-image-2" }, { host: "example.test" }), 421],
    [new Request("http://local.test/v1/images/generations", { headers }), 405],
  ]) assert.equal((await handler(request)).status, status);
  assert.equal(counts.lease, 0);
  assert.equal(calls.length, 0);
});

test("models lists gpt-image-2 only for image pickers while the Codex image sign-in is active", async () => {
  const listed = "gpt-6.1-sol";
  const image = "gpt-image-2";
  // n8n's Chat Model node and Chat Hub send openai-platform; the OpenAI node, which hosts the image picker, does not.
  const chatPicker = { "openai-platform": "org-qkmJQuJ2WnvoIKMr2UJwIJkZ" };
  for (const [status, extra, expected] of [
    [async () => ({ state: "signed-in" }), {}, [listed, image]],
    [async () => ({ state: "signed-in" }), chatPicker, [listed]],
    [async () => ({ state: "off" }), {}, [listed]],
    [async () => ({ state: "pending" }), {}, [listed]],
    [async () => ({ state: "reauthorize" }), {}, [listed]],
    [async () => { throw leaseError("images_unavailable"); }, {}, [listed]],
  ]) {
    const { handler, counts } = setup({ status });
    const response = await handler(new Request("http://local.test/v1/models", { headers: { ...headers, ...extra } }));
    assert.equal(response.status, 200);
    assert.deepEqual((await response.json()).data.map(({ id }) => id), expected);
    assert.equal(counts.lease, 0);
  }
});

test("usage limits pass through as 429 with the Codex code and reset time", async () => {
  for (const [body, code, resetsAt] of [
    [{ error: { type: "usage_limit_reached", plan_type: "plus", resets_at: 1778836573, message: `limit for ${imageToken}` } }, "usage_limit_reached", 1778836573],
    [{ error: { code: "rate_limit_exceeded" } }, "rate_limit_exceeded", undefined],
    ["not json", "rate_limited", undefined],
  ]) {
    const { handler, calls } = setup({ upstream: () => new Response(typeof body === "string" ? body : JSON.stringify(body), { status: 429 }) });
    const response = await handler(generate({ prompt: "A fox", model: "gpt-image-2" }));
    const text = await response.text();
    assert.equal(response.status, 429);
    assert.equal(JSON.parse(text).error.code, code);
    assert.equal(JSON.parse(text).error.resets_at, resetsAt);
    assert.equal(text.includes(imageToken), false);
    assert.equal(calls.length, 1);
  }
});

test("upstream 401, 5xx and transport failures become 502 without retry or a forced refresh", async () => {
  for (const [upstream, code, recovery] of [
    [() => Response.json({ error: { message: "expired" } }, { status: 401 }), "images_upstream_unauthorized", "reauthorize"],
    [() => new Response("bad gateway", { status: 503 }), "images_upstream_failed", "retry-later"],
    [() => { throw new TypeError("fetch failed"); }, "images_upstream_failed", "retry-later"],
    [() => new Response("not json"), "images_upstream_failed", "retry-later"],
    [() => Response.json({ data: [] }), "images_invalid_response", "retry-later"],
    [() => Response.json({ data: [{ url: "https://example.test/a.png" }] }), "images_invalid_response", "retry-later"],
    [() => new Response(new ReadableStream({ pull(controller) { controller.enqueue(new Uint8Array(MiB)); } })), "images_upstream_failed", "retry-later"],
  ]) {
    const { handler, calls, counts } = setup({ upstream });
    const response = await handler(generate({ prompt: "A fox", model: "gpt-image-2" }));
    const body = await response.json();
    assert.deepEqual([response.status, body.error.code, body.recovery], [502, code, recovery]);
    assert.equal(calls.length, 1);
    assert.equal(counts.lease, 1);
  }
});

test("other upstream errors keep status and code but never echo tokens, credentials or prompts", async () => {
  const prompt = "Paint the secret garden at noon";
  const echo = `Rejected ${prompt} with ${imageToken} from ${credential}`;
  const { handler } = setup({ upstream: () => Response.json({ error: { message: echo, code: "content_policy_violation", param: "prompt", type: "invalid_request_error" } },
    { status: 400, headers: { "x-request-id": `req_${imageToken}` } }) });
  for (const request of [generate({ prompt, model: "gpt-image-2" }), edit(form({ prompt, model: "gpt-image-2" }))]) {
    const response = await handler(request);
    const text = await response.text();
    assert.equal(response.status, 400);
    assert.equal(JSON.parse(text).error.code, "content_policy_violation");
    for (const secret of [prompt, imageToken, credential]) assert.equal(text.includes(secret), false, secret);
  }
});

test("text routes keep the SIWC lease and still refuse hosted image generation", async () => {
  const completed = { id: "resp_1", status: "completed", output: [{ type: "message", content: [{ type: "output_text", text: "Hello" }] }] };
  const { handler, calls, counts } = setup({ upstream: () => new Response(`event: response.completed\ndata: ${JSON.stringify({ type: "response.completed", response: completed })}\n\n`) });
  const refused = await handler(new Request("http://local.test/v1/responses", { method: "POST", headers,
    body: JSON.stringify({ model: "gpt-6.1-sol", input: [{ role: "user", content: "Hi" }], tools: [{ type: "image_generation" }] }) }));
  assert.deepEqual(await refusal(refused), [400, "unsupported_siwc_feature", "tools"]);
  const response = await handler(new Request("http://local.test/v1/responses", { method: "POST", headers,
    body: JSON.stringify({ model: "gpt-6.1-sol", input: [{ role: "user", content: "Hi" }] }) }));
  assert.equal(response.status, 200);
  assert.equal(calls[0].url, "https://api.openai.com/v1/responses");
  assert.equal(new Headers(calls[0].options.headers).get("authorization"), "Bearer siwc-text-token-123456");
  assert.deepEqual(counts, { lease: 0, siwc: 1 });
});

test("client disconnect aborts the upstream image request", async () => {
  let aborted, entered;
  const started = new Promise((resolve) => { entered = resolve; });
  const { handler } = setup({ upstream: (url, options) => new Promise((resolve, reject) => {
    options.signal.addEventListener("abort", () => { aborted = true; reject(options.signal.reason); }, { once: true });
    entered();
  }) });
  const controller = new AbortController();
  const pending = handler(new Request("http://local.test/v1/images/generations", { method: "POST", headers, signal: controller.signal,
    body: JSON.stringify({ prompt: "A fox", model: "gpt-image-2" }) }));
  await started;
  controller.abort();
  assert.equal((await pending).status, 502);
  assert.equal(aborted, true);
});

test("HTTP listener carries a multipart edit through to the Codex request", async (t) => {
  const { handler, calls } = setup();
  const server = createSidecarServer(handler);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const response = await fetch(`http://127.0.0.1:${server.address().port}/v1/images/edits`, { method: "POST",
    headers: { authorization: `Bearer ${credential}` }, body: form(editFields, [{ bytes: Buffer.alloc(2 * MiB, 7), type: "image/png" }]) });
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data, [{ b64_json: "aW1hZ2U=" }]);
  assert.equal(sent(calls[0]).images[0].image_url, `data:image/png;base64,${Buffer.alloc(2 * MiB, 7).toString("base64")}`);
});

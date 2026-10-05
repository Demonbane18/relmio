import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { CODEX_CLI_VERSION, createSidecarHandler } from "../src/gateway/openai-oauth-sidecar.mjs";

const imageModels = ["gpt-image-2", "gpt-image-2.5-flare", "gpt-image-2.5-sunburst"];
const credential = "image_route_local_credential_123456";
const registration = { storageRoot: "/tmp/test-images", registrationId: "account_1" };
function generationRequest(body) {
  return new Request("http://sidecar.test/v1/images/generations", {
    method: "POST", headers: { host: "n8n-openai-oauth:10531", authorization: `Bearer ${credential}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}
function editRequest(model, { mask = false } = {}) {
  const form = new FormData();
  if (model !== undefined) form.set("model", model);
  form.set("prompt", "Make the square blue");
  form.set("image", new Blob(["test"], { type: "image/png" }), "image.png");
  if (mask) form.set("mask", new Blob(["mask"], { type: "image/png" }), "mask.png");
  return new Request("http://sidecar.test/v1/images/edits", {
    method: "POST", headers: { host: "n8n-openai-oauth:10531", authorization: `Bearer ${credential}` }, body: form,
  });
}
function runtime(providerResponse = () => Response.json({ models: [
  { slug: "gpt-6-astra", display_name: "GPT-6-ASTRA", visibility: "list" },
  { slug: "image-account-only", visibility: "hidden" },
] })) {
  const calls = [];
  const handler = createSidecarHandler({
    registration, runtimeId: "runtime_1",
    tokenVerifier: createHash("sha256").update(credential).digest(),
    getToken: async () => ({ accessToken: "fake-provider-token" }),
    fetchImpl: async (url, options) => { calls.push({ url, options }); return providerResponse(url, options); },
  });
  return { handler, calls };
}

test("model discovery never invents GPT Image 2 entitlement", async () => {
  const { handler, calls } = runtime();
  const response = await handler(new Request("http://sidecar.test/v1/models", {
    headers: { host: "n8n-openai-oauth:10531", authorization: `Bearer ${credential}` },
  }));
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data.map(({ id }) => id), ["gpt-6-astra"]);
  assert.deepEqual(calls.map(({ url }) => url), [`https://api.openai.com/v1/models?client_version=${CODEX_CLI_VERSION}`]);
});

test("all former image-generation models are rejected before any provider request", async () => {
  const { handler, calls } = runtime();
  for (const model of imageModels) {
    const response = await handler(generationRequest({ model, prompt: "A blue square", background: "opaque", quality: "low", n: 1 }));
    assert.equal(response.status, 404, model);
    assert.equal((await response.json()).error.param, "route");
  }
  assert.deepEqual(calls, []);
});

test("all former image-edit models are rejected before any provider request", async () => {
  const { handler, calls } = runtime();
  for (const model of imageModels) {
    const response = await handler(editRequest(model));
    assert.equal(response.status, 404, model);
    assert.equal((await response.json()).error.param, "route");
  }
  assert.deepEqual(calls, []);
});

test("missing image model cannot default to an old synthetic image entitlement", async () => {
  const { handler, calls } = runtime();
  assert.equal((await handler(generationRequest({ prompt: "A blue square" }))).status, 404);
  assert.equal((await handler(editRequest())).status, 404);
  assert.deepEqual(calls, []);
});

test("a provider error cannot make image generation an authorized route", async () => {
  const { handler, calls } = runtime(() => { throw new Error("provider must not be reached"); });
  const response = await handler(generationRequest({ model: "gpt-image-2.5-flare", prompt: "A blue square" }));
  assert.equal(response.status, 404);
  assert.deepEqual(calls, []);
});

test("image generation stays unavailable with stream or URL output flags", async () => {
  const { handler, calls } = runtime();
  for (const body of [
    { model: imageModels[1], prompt: "A square", stream: true },
    { model: imageModels[2], prompt: "A square", response_format: "url" },
  ]) {
    assert.equal((await handler(generationRequest(body))).status, 404);
  }
  assert.deepEqual(calls, []);
});

test("masked image edits remain unavailable", async () => {
  const { handler, calls } = runtime();
  for (const model of imageModels.slice(1)) {
    assert.equal((await handler(editRequest(model, { mask: true }))).status, 404);
  }
  assert.deepEqual(calls, []);
});

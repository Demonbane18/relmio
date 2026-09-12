import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createOpenAIOAuthFetchHandler } from "openai-oauth";
import { createSidecarHandler } from "../src/gateway/openai-oauth-sidecar.mjs";

const imageModels = [
  "gpt-image-2",
  "gpt-image-2.5-flare",
  "gpt-image-2.5-sunburst",
];
const newImageModels = imageModels.slice(1);
const imageResponse = {
  created: 123,
  data: [{ b64_json: "dGVzdA==" }],
};

function generationRequest(body) {
  return new Request("http://sidecar.test/v1/images/generations", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function editRequest(model, { mask = false } = {}) {
  const form = new FormData();
  if (model !== undefined) form.set("model", model);
  form.set("prompt", "Make the square blue");
  form.set("background", "opaque");
  form.set("quality", "low");
  form.set("n", "1");
  form.set("image", new Blob(["test"], { type: "image/png" }), "image.png");
  if (mask) form.set("mask", new Blob(["mask"], { type: "image/png" }), "mask.png");
  return new Request("http://sidecar.test/v1/images/edits", {
    method: "POST",
    body: form,
  });
}

async function runtime(t, providerResponse = () => Response.json(imageResponse)) {
  const dir = await mkdtemp(join(tmpdir(), "relmio-images25-contract-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const authFilePath = join(dir, "auth.json");
  await writeFile(authFilePath, JSON.stringify({
    tokens: { access_token: "test-only", account_id: "test-account" },
  }), { mode: 0o600 });

  const calls = [];
  const upstream = createOpenAIOAuthFetchHandler({
    authFilePath,
    ensureFresh: false,
    fetch: async (url, init = {}) => {
      const target = new URL(url);
      if (target.hostname === "registry.npmjs.org") {
        return Response.json({ version: "0.153.4" });
      }
      if (target.pathname.endsWith("/models")) {
        return Response.json({
          models: [{
            slug: "gpt-6-astra",
            display_name: "GPT-6-ASTRA",
            visibility: "list",
            supported_in_api: true,
          }],
        });
      }
      if (!target.pathname.endsWith("/images/generations") &&
          !target.pathname.endsWith("/images/edits")) {
        throw new Error(`Unexpected synthetic provider route: ${target.pathname}`);
      }
      const body = JSON.parse(init.body);
      calls.push({ pathname: target.pathname, body });
      return providerResponse({ pathname: target.pathname, body });
    },
  });

  return { handler: createSidecarHandler(upstream), calls };
}

test("successful model discovery includes both GPT Image 2.5 variants exactly once", async (t) => {
  const { handler } = await runtime(t);

  const response = await handler(new Request("http://sidecar.test/v1/models"));
  assert.equal(response.status, 200);
  const ids = (await response.json()).data.map(({ id }) => id);

  assert.deepEqual(
    [...ids].sort(),
    ["gpt-6-astra", ...imageModels].sort(),
  );
  assert.equal(new Set(ids).size, ids.length);
});

test("every supported image model reaches the exact generation route with its ID and options", async (t) => {
  const { handler, calls } = await runtime(t);

  for (const model of imageModels) {
    const response = await handler(generationRequest({
      model,
      prompt: "A blue square",
      background: "opaque",
      quality: "low",
      n: 1,
    }));
    assert.equal(response.status, 200, model);
    assert.deepEqual(await response.json(), imageResponse, model);
  }

  assert.deepEqual(calls, imageModels.map((model) => ({
    pathname: "/backend-api/codex/images/generations",
    body: {
      model,
      prompt: "A blue square",
      background: "opaque",
      n: 1,
      quality: "low",
    },
  })));
});

test("every supported image model reaches the exact edit route with its ID and options", async (t) => {
  const { handler, calls } = await runtime(t);

  for (const model of imageModels) {
    const response = await handler(editRequest(model));
    assert.equal(response.status, 200, model);
    assert.deepEqual(await response.json(), imageResponse, model);
  }

  assert.deepEqual(calls, imageModels.map((model) => ({
    pathname: "/backend-api/codex/images/edits",
    body: {
      images: [{ image_url: "data:image/png;base64,dGVzdA==" }],
      model,
      prompt: "Make the square blue",
      n: 1,
      background: "opaque",
      quality: "low",
    },
  })));
});

test("omitting the image model still defaults generations and edits to GPT Image 2", async (t) => {
  const { handler, calls } = await runtime(t);

  const generation = await handler(generationRequest({
    prompt: "A blue square",
    background: "opaque",
    quality: "low",
    n: 1,
  }));
  const edit = await handler(editRequest(undefined));

  assert.equal(generation.status, 200);
  assert.equal(edit.status, 200);
  assert.deepEqual(calls.map(({ body }) => body.model), [
    "gpt-image-2",
    "gpt-image-2",
  ]);
});

test("an unsupported-model provider error is returned without remapping the requested model", async (t) => {
  const providerError = {
    error: {
      message: "The requested image model is unavailable for this account.",
      type: "invalid_request_error",
      code: "model_not_found",
    },
  };
  const { handler, calls } = await runtime(t, () => Response.json(providerError, {
    status: 404,
    headers: { "x-request-id": "req_model_not_found" },
  }));

  const response = await handler(generationRequest({
    model: "gpt-image-2.5-flare",
    prompt: "A blue square",
    quality: "low",
    n: 1,
  }));

  assert.equal(response.status, 404);
  assert.equal(response.headers.get("x-request-id"), "req_model_not_found");
  assert.deepEqual(await response.json(), providerError);
  assert.equal(calls[0].body.model, "gpt-image-2.5-flare");
});

test("new image variants reject streaming and URL output before a provider request", async (t) => {
  const { handler, calls } = await runtime(t);
  const attempts = [
    {
      body: { model: newImageModels[0], prompt: "A square", stream: true },
      message: /Streaming image generation/u,
    },
    {
      body: { model: newImageModels[1], prompt: "A square", response_format: "url" },
      message: /b64_json/u,
    },
  ];

  for (const { body, message } of attempts) {
    const response = await handler(generationRequest(body));
    assert.equal(response.status, 400, body.model);
    assert.match((await response.json()).error.message, message, body.model);
  }
  assert.deepEqual(calls, []);
});

test("both new image variants reject masked edits before a provider request", async (t) => {
  const { handler, calls } = await runtime(t);

  for (const model of newImageModels) {
    const response = await handler(editRequest(model, { mask: true }));
    assert.equal(response.status, 400, model);
    assert.match((await response.json()).error.message, /masks/u, model);
  }
  assert.deepEqual(calls, []);
});

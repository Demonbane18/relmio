import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { CODEX_CLI_VERSION, createSidecarHandler } from "../src/gateway/openai-oauth-sidecar.mjs";

const credential = "image_route_local_credential_123456";
const registration = { storageRoot: "/tmp/test-images", registrationId: "account_1" };

test("model discovery never invents GPT Image 2 entitlement while images are off", async () => {
  const calls = [];
  const handler = createSidecarHandler({
    registration, runtimeId: "runtime_1",
    tokenVerifier: createHash("sha256").update(credential).digest(),
    getToken: async () => ({ accessToken: "fake-provider-token" }),
    imagesStatus: async () => ({ state: "off" }),
    fetchImpl: async (url) => {
      calls.push(url);
      return Response.json({ models: [
        { slug: "gpt-6-astra", display_name: "GPT-6-ASTRA", visibility: "list" },
        { slug: "image-account-only", visibility: "hidden" },
      ] });
    },
  });
  const response = await handler(new Request("http://sidecar.test/v1/models", {
    headers: { host: "n8n-openai-oauth:10531", authorization: `Bearer ${credential}` },
  }));
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data.map(({ id }) => id), ["gpt-6-astra"]);
  assert.deepEqual(calls, [`https://api.openai.com/v1/models?client_version=${CODEX_CLI_VERSION}`]);
});

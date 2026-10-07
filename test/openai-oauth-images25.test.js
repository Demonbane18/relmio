import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CODEX_CLI_VERSION, createSidecarHandler } from "../src/gateway/openai-oauth-sidecar.mjs";

const credential = "image_route_local_credential_123456";

test("model discovery never invents image entitlement from the catalog or while images are off", async (t) => {
  const storageRoot = await mkdtemp(join(tmpdir(), "relmio-images25-"));
  t.after(() => rm(storageRoot, { recursive: true, force: true }));
  const registration = { storageRoot, registrationId: "account_1" };
  const latest = `${Number(CODEX_CLI_VERSION.split(".")[0]) + 1}.0.0`;
  const catalogs = [];
  const handler = createSidecarHandler({
    registration, runtimeId: "runtime_1",
    tokenVerifier: createHash("sha256").update(credential).digest(),
    getToken: async (selected) => { assert.deepEqual(selected, registration); return { accessToken: "fake-provider-token" }; },
    imagesStatus: async () => ({ state: "off" }),
    fetchImpl: async (url) => {
      if (String(url) === "https://registry.npmjs.org/@openai/codex/latest") return Response.json({ version: latest });
      catalogs.push(String(url));
      return Response.json({ models: [
        { slug: "gpt-6-astra", display_name: "GPT-6-ASTRA", visibility: "list" },
        { slug: "gpt-image-2.5-flare", display_name: "GPT Image 2.5 Flare", visibility: "list" },
        { slug: "image-account-only", visibility: "hidden" },
      ] });
    },
  });
  const response = await handler(new Request("http://sidecar.test/v1/models", {
    headers: { host: "n8n-openai-oauth:10531", authorization: `Bearer ${credential}` },
  }));
  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).data.map(({ id }) => id), ["gpt-6-astra"]);
  assert.deepEqual(catalogs, [`https://api.openai.com/v1/models?client_version=${latest}`]);
});

import assert from "node:assert/strict";
import test from "node:test";
import { CODEX_CLI_VERSION } from "../src/gateway/openai-oauth-sidecar.mjs";

import {
  GROK_BUILD_CLI_VERSION,
  createCodexChatComposeFile, createCodexChatConfig, createCodexChatDockerfile,
  createCodexComposeFile, createCodexConfig, createCodexDockerfile,
  createGrokBuildComposeFile, createGrokBuildDockerfile,
  createLocalDockerignore, createLocalDeploymentPlan,
  validateLocalTarget,
} from "../src/domain/local-endpoints.js";

const authBinding = {
  registrationId: "registration_codex_1",
  clientId: "oaiapp_codex_fixture",
  generation: "123e4567-e89b-42d3-a456-426614174000",
  ownerHostId: "urn:uuid:123e4567-e89b-42d3-a456-426614174001",
  ownerRuntimeId: "wizard",
};
const options = {
  port: 14500, installId: "b".repeat(32), registrationId: authBinding.registrationId,
  tokenSha256: "a".repeat(64),
};

test("both Codex install plans bind a reviewed SIWC registration", () => {
  const direct = createLocalDeploymentPlan({ target: "codex-chatgpt", port: 14500, authBinding });
  const adapter = createLocalDeploymentPlan({ target: "codex-chat", port: 14501, authBinding });
  assert.equal(direct.endpoint, "ws://127.0.0.1:14500");
  assert.equal(adapter.endpoint, "http://127.0.0.1:14501");
  assert.deepEqual(direct.authBinding, authBinding);
  for (const invalid of [
    { ...authBinding, registrationId: "../codex" },
    { ...authBinding, generation: "old-mtime" },
    { ...authBinding, ownerRuntimeId: "x;docker stop n8n" },
  ]) assert.throws(() => createLocalDeploymentPlan({
    target: "codex-chat", port: 14501, authBinding: invalid,
  }));
  assert.throws(() => createLocalDeploymentPlan({ target: "codex-chat", port: 14501 }));
});

test("generated Codex contexts use the same protected owner and public Responses provider", () => {
  const direct = createCodexComposeFile(options);
  const adapter = createCodexChatComposeFile({ ...options, port: 14501 });
  for (const compose of [direct, adapter]) {
    assert.match(compose, /RELMIO_REGISTRATION_ID: "registration_codex_1"/);
    assert.match(compose, /RELMIO_GATEWAY_TOKEN_SHA256: a{64}/);
    assert.match(compose, /N8N_OPENAI_OAUTH_HOME: \/home\/node\/\.relmio-siwc/);
    assert.match(compose, /- codex-state:\/home\/node\/\.codex/);
    assert.match(compose, /- siwc-store:\/home\/node\/\.relmio-siwc/);
    assert.doesNotMatch(compose, /codex-home|chatgptDeviceCode|account\/login\/start/);
    assert.doesNotMatch(compose, /0\.0\.0\.0:1450[01]/);
  }
  assert.match(direct, /127\.0\.0\.1:14500:4500/);
  assert.match(adapter, /127\.0\.0\.1:14501:14501/);
  const directConfig = createCodexConfig();
  const adapterConfig = createCodexChatConfig();
  for (const config of [directConfig, adapterConfig]) {
    const provider = config.split("[model_providers.openai_chatgpt_plan]\n")[1]?.split("\n[")[0];
    assert.ok(provider, "the selected configured provider must exist");
    assert.match(provider, /^name = "ChatGPT plan"$/mu);
    assert.match(config, /base_url = "https:\/\/api\.openai\.com\/v1"/);
    assert.match(config, /env_key = "ACCESS_TOKEN"/);
    assert.match(config, /wire_api = "responses"/);
    assert.match(config, /requires_openai_auth = false/);
    assert.match(config, /supports_websockets = false/);
    assert.match(config, /"\/home\/node\/\.relmio-siwc" = "deny"/);
    assert.match(config, /\[agents\]\s+enabled = false/);
    assert.doesNotMatch(config, /forced_login_method|cli_auth_credentials_store/);
  }
  assert.match(adapterConfig, /relmio-chat-readonly/);
  assert.match(directConfig, /relmio-workspace/);
});

test("both Codex images pin official CLI and locked Node runtime without native credential login", () => {
  for (const [dockerfile, entry] of [
    [createCodexDockerfile(), "codex-app-server.mjs"],
    [createCodexChatDockerfile(), "codex-chat.js"],
  ]) {
    assert.match(dockerfile, /FROM node:24-bookworm-slim/);
    assert.match(dockerfile, /npm ci --omit=dev --ignore-scripts/);
    assert.ok(dockerfile.includes(`@openai/codex@${CODEX_CLI_VERSION}`));
    assert.ok(dockerfile.includes(entry));
    assert.doesNotMatch(dockerfile, /login --device-auth|openai-oauth@/);
  }
  for (const target of ["codex-chat", "codex-chatgpt"]) {
    const ignore = createLocalDockerignore(target);
    assert.match(ignore, /!services\/siwc-session\.mjs/);
    assert.match(ignore, /!gateway\/openai-oauth-sidecar\.mjs/);
    assert.match(ignore, /!infrastructure\/local-process\.js/);
  }
  assert.throws(() => createCodexComposeFile({ ...options, registrationId: "../steal" }));
  assert.throws(() => createCodexChatComposeFile({ ...options, tokenSha256: "wrong" }));
});

test("Grok remains a separate direct OAuth method", () => {
  const plan = createLocalDeploymentPlan({ target: "xai-grok-build", port: 14502 });
  assert.equal(plan.endpoint, "http://127.0.0.1:14502");
  assert.equal(Object.hasOwn(plan, "authBinding"), false);
  assert.equal(validateLocalTarget("xai-grok-build"), "xai-grok-build");
  assert.match(createGrokBuildDockerfile(), new RegExp(GROK_BUILD_CLI_VERSION.replaceAll(".", "\\.")));
  assert.match(createGrokBuildComposeFile({ port: 14502, tokenSha256: "a".repeat(64), installId: "b".repeat(32) }), /127\.0\.0\.1:14502/);
  assert.equal(createLocalDockerignore("xai-grok-build").includes("siwc-session"), false);
});

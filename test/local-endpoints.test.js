import assert from "node:assert/strict";
import test from "node:test";

import {
  CODEX_CLI_VERSION,
  LOCAL_TARGETS,
  createCodexChatComposeFile,
  createCodexChatConfig,
  createCodexChatDockerfile,
  createCodexChatRequirements,
  createCodexComposeFile,
  createCodexConfig,
  createCodexDockerfile,
  createCodexRequirements,
  createLocalDockerignore,
  createLocalDeploymentPlan,
  createOpenAiGatewayComposeFile,
  createOpenAiGatewayDockerfile,
  validateAllowedOrigins,
  validateInstallId,
  validateLocalPort,
  validateLocalTarget,
  validatePlatformApiKey,
  validateSha256Verifier,
} from "../src/domain/local-endpoints.js";

const verifier = "a".repeat(64);
const installId = "b".repeat(32);

test("local endpoint validation accepts the explicit provider contracts", () => {
  assert.equal(validateLocalTarget("openai-api"), "openai-api");
  assert.equal(validateLocalTarget("codex-chatgpt"), "codex-chatgpt");
  assert.equal(validateLocalTarget("codex-chat"), "codex-chat");
  assert.equal(validateLocalPort("12435"), 12435);
  assert.equal(
    validatePlatformApiKey(`sk-${"a".repeat(48)}`),
    `sk-${"a".repeat(48)}`,
  );
  assert.equal(validateSha256Verifier(verifier), verifier);
  assert.equal(validateInstallId(installId), installId);
});

test("local endpoint validation rejects ambiguous auth and unsafe port values", () => {
  for (const target of [
    "openai",
    "chatgpt",
    "openai-oauth",
    "constructor",
    "toString",
    "__proto__",
    "",
    null,
  ]) {
    assert.throws(() => validateLocalTarget(target), /target/i);
  }
  for (const port of [0, 22, 80, 1023, 65_536, "12435;id", "--help"] ) {
    assert.throws(() => validateLocalPort(port), /port/i);
  }
  for (const key of [
    "chatgpt-session-token",
    "eyJhbGciOi.fake.jwt",
    "sk-short",
    `sk-${"a".repeat(20)}\nsecond`,
    ` sk-${"a".repeat(48)}`,
  ]) {
    assert.throws(() => validatePlatformApiKey(key), /Platform API key/i);
  }
  for (const hash of ["a".repeat(63), "z".repeat(64), `${verifier}\n`]) {
    assert.throws(() => validateSha256Verifier(hash), /verifier/i);
  }
  for (const id of ["b".repeat(31), "B".repeat(32), `${installId}\n`]) {
    assert.throws(() => validateInstallId(id), /installation ID/i);
  }
});

test("browser origins are exact, normalized, deduplicated, and bounded", () => {
  assert.deepEqual(
    validateAllowedOrigins([
      "http://localhost:3000",
      "https://app.example.com",
      "http://localhost:3000",
    ]),
    ["http://localhost:3000", "https://app.example.com"],
  );
  assert.deepEqual(validateAllowedOrigins(undefined), []);

  for (const origin of [
    "*",
    "null",
    "file:///tmp/app.html",
    "http://user:pass@localhost:3000",
    "https://app.example.com/path",
    "https://app.example.com?query=yes",
    "https://app.example.com/#fragment",
    "javascript:alert(1)",
  ]) {
    assert.throws(() => validateAllowedOrigins([origin]), /origin/i);
  }
  assert.throws(
    () =>
      validateAllowedOrigins(
        Array.from({ length: 11 }, (_, index) => `https://app${index}.example`),
      ),
    /origin/i,
  );
});

test("OpenAI API deployment plan is explicitly Platform-backed and browser capable", () => {
  const plan = createLocalDeploymentPlan({
    target: "openai-api",
    port: 12435,
    allowedOrigins: ["http://localhost:3000"],
  });

  assert.deepEqual(plan, {
    target: "openai-api",
    label: "OpenAI API",
    bindHost: "127.0.0.1",
    port: 12435,
    endpoint: "http://127.0.0.1:12435/v1",
    protocol: "openai-v1",
    upstreamAuth: "platform-api-key",
    allowedOrigins: ["http://localhost:3000"],
    browserClients: true,
    experimental: false,
    managedPath: "~/.relmio/local/openai-api",
  });
});

test("Codex deployment plan preserves official App Server semantics", () => {
  const plan = createLocalDeploymentPlan({
    target: "codex-chatgpt",
    port: 14500,
  });

  assert.deepEqual(plan, {
    target: "codex-chatgpt",
    label: "Codex with ChatGPT",
    bindHost: "127.0.0.1",
    port: 14500,
    endpoint: "ws://127.0.0.1:14500",
    protocol: "codex-app-server-json-rpc",
    upstreamAuth: "chatgpt-via-codex",
    allowedOrigins: [],
    browserClients: false,
    experimental: true,
    managedPath: "~/.relmio/local/codex-chatgpt",
  });
});

test("Codex Chat has its own loopback HTTP contract and hardened adapter image", () => {
  const plan = createLocalDeploymentPlan({ target: "codex-chat", port: 14501 });
  assert.deepEqual(plan, {
    target: "codex-chat",
    label: "Codex Chat Adapter",
    bindHost: "127.0.0.1",
    port: 14501,
    endpoint: "http://127.0.0.1:14501",
    protocol: "relmio-codex-chat-http",
    upstreamAuth: "chatgpt-via-codex",
    allowedOrigins: [],
    browserClients: false,
    experimental: true,
    managedPath: "~/.relmio/local/codex-chat",
  });

  const dockerfile = createCodexChatDockerfile();
  const config = createCodexChatConfig();
  const requirements = createCodexChatRequirements();
  const compose = createCodexChatComposeFile({
    port: 14501,
    tokenSha256: verifier,
    installId,
  });
  assert.match(dockerfile, /@openai\/codex@0\.147\.0/);
  assert.match(dockerfile, /COPY --chown=node:node gateway\.mjs/);
  assert.match(dockerfile, /ENTRYPOINT \["node", "\/app\/gateway\.mjs"\]/);
  assert.match(config, /^approval_policy = "never"$/mu);
  assert.match(config, /^default_permissions = "relmio-chat-readonly"$/mu);
  assert.match(
    config,
    /^\[permissions\.relmio-chat-readonly\]\nextends = ":read-only"$/mu,
  );
  assert.match(config, /^\[permissions\.relmio-chat-readonly\.filesystem\]$/mu);
  assert.match(config, /^":root" = "deny"$/mu);
  assert.match(config, /^":minimal" = "read"$/mu);
  assert.match(config, /^":tmpdir" = "deny"$/mu);
  assert.match(config, /^":slash_tmp" = "deny"$/mu);
  assert.match(config, /^"\/workspace" = "read"$/mu);
  assert.match(config, /^"\/home\/node\/\.codex" = "deny"$/mu);
  assert.match(requirements, /^allowed_approval_policies = \["never"\]$/mu);
  assert.match(
    requirements,
    /^\[allowed_permission_profiles\]\n"relmio-chat-readonly" = true$/mu,
  );
  assert.doesNotMatch(requirements, /allowed_approval_policies = \["on-request"\]/u);
  assert.match(compose, /127\.0\.0\.1:14501:14501/);
  assert.match(compose, /RELMIO_GATEWAY_TOKEN_SHA256: a{64}/);
  assert.match(compose, /RELMIO_GATEWAY_HOST: 0\.0\.0\.0/);
  assert.match(compose, /RELMIO_GATEWAY_PORT: "14501"/);
  assert.match(compose, /codex-home:\/home\/node\/\.codex/);
  assert.match(compose, /codex-workspace:\/workspace/);
  assert.match(compose, /127\.0\.0\.1:14501\/health/);
  assert.match(compose, /no-new-privileges:true/);
  assert.match(compose, /cap_drop:\n\s+- ALL/);
  assert.match(compose, /read_only: true/);
  assert.doesNotMatch(compose, /0\.0\.0\.0:14501|:::14501|\/var\/run\/docker\.sock|n8n/i);
});

test("OpenAI gateway Compose uses a private seeded volume without weakening runtime isolation", () => {
  const compose = createOpenAiGatewayComposeFile({
    port: 12435,
    tokenSha256: verifier,
    allowedOrigins: ["http://localhost:3000"],
    installId,
  });

  assert.match(compose, /127\.0\.0\.1:12435:10531/);
  assert.match(compose, /RELMIO_GATEWAY_TOKEN_SHA256: a{64}/);
  assert.match(
    compose,
    /OPENAI_API_KEY_FILE: \/run\/relmio-secret\/openai-api-key/,
  );
  const encodedOrigins = /RELMIO_ALLOWED_ORIGINS_BASE64: (\S+)/u.exec(compose)?.[1];
  assert.deepEqual(
    JSON.parse(Buffer.from(encodedOrigins, "base64").toString("utf8")),
    ["http://localhost:3000"],
  );
  assert.match(
    compose,
    /openai-api-key:\/run\/relmio-secret:ro/,
  );
  assert.match(compose, /credential-seed:/);
  assert.match(compose, /profiles:\n\s+- relmio-credential-seed/);
  assert.match(compose, /network_mode: none/);
  assert.match(compose, /restart: "no"/);
  assert.match(compose, /pull_policy: never/);
  assert.match(compose, /openai-api-key:\/run\/relmio-secret\n/);
  assert.match(compose, /user: "0:0"/);
  assert.match(compose, /cap_add:\n\s+- CHOWN/);
  assert.ok(
    compose.indexOf(
      "chmod 0400 /run/relmio-secret/.openai-api-key.next",
    ) <
      compose.indexOf(
        "chown 1000:1000 /run/relmio-secret/.openai-api-key.next",
      ),
  );
  assert.match(compose, /logging:\n\s+driver: "none"/);
  assert.match(
    compose,
    /volumes:\n\s+openai-api-key:\n\s+labels:\n\s+io\.relmio\.managed: "true"\n\s+io\.relmio\.target: "openai-api"\n\s+io\.relmio\.install: "b{32}"/,
  );
  assert.match(compose, /no-new-privileges:true/);
  assert.match(compose, /cap_drop:\n\s+- ALL/);
  assert.match(compose, /read_only: true/);
  assert.match(compose, /io\.relmio\.install: "b{32}"/);
  assert.match(compose, /networks:\n\s+default:\n\s+labels:/);
  assert.doesNotMatch(compose, /0\.0\.0\.0:12435|:::12435|n8n|openai-oauth/i);
  assert.doesNotMatch(compose, /OPENAI_API_KEY:\s*sk-/);
  assert.doesNotMatch(compose, /file: \.\/secrets|^secrets:/m);
  const seedService = /\n  credential-seed:\n([\s\S]*?)\nnetworks:/u.exec(
    compose,
  )?.[1];
  assert.ok(seedService);
  assert.doesNotMatch(seedService, /^\s+ports:/m);
  const seedScript = /\n    command:\n      - \|\n([\s\S]*?)\n    volumes:/u.exec(
    seedService,
  )?.[1];
  assert.ok(seedScript);
  assert.match(
    seedScript,
    /cat > \/run\/relmio-secret\/\.openai-api-key\.next/,
  );
  assert.doesNotMatch(seedScript, /\becho\b|\bprintf\b|\btee\b|\benv\b/);
  assert.doesNotMatch(compose, /external:\s*true/);
});

test("OpenAI gateway Dockerfile packages only the dependency-free runtime", () => {
  const dockerfile = createOpenAiGatewayDockerfile();

  assert.match(dockerfile, /^FROM node:22-bookworm-slim$/m);
  assert.match(dockerfile, /COPY --chown=node:node gateway\.mjs/);
  assert.match(dockerfile, /^USER node$/m);
  assert.match(dockerfile, /ENTRYPOINT \["node", "\/app\/gateway\.mjs"\]/);
  assert.doesNotMatch(dockerfile, /npm install|openai-oauth|@openai\/codex/);
});

test("local Docker build contexts exclude credentials and unrelated managed files", () => {
  const gateway = createLocalDockerignore("openai-api");
  const codex = createLocalDockerignore("codex-chatgpt");

  assert.equal(gateway, "**\n!Dockerfile\n!gateway.mjs\n");
  assert.equal(
    codex,
    "**\n!Dockerfile\n!config.toml\n!requirements.toml\n",
  );
  assert.doesNotMatch(gateway, /secrets|openai-api-key/iu);
});

test("Codex image and config pin the official App Server and ChatGPT login", () => {
  assert.equal(CODEX_CLI_VERSION, "0.147.0");
  const dockerfile = createCodexDockerfile();
  const config = createCodexConfig();
  const requirements = createCodexRequirements();

  assert.match(dockerfile, /@openai\/codex@0\.147\.0/);
  assert.match(dockerfile, /--ignore-scripts/);
  assert.match(dockerfile, /apt-get update/);
  assert.match(dockerfile, /apt-get install --no-install-recommends -y ca-certificates/);
  assert.match(dockerfile, /rm -rf \/var\/lib\/apt\/lists\/\*/);
  assert.match(dockerfile, /COPY --chown=node:node config\.toml/);
  assert.match(
    dockerfile,
    /COPY --chmod=0444 requirements\.toml \/etc\/codex\/requirements\.toml/,
  );
  assert.match(dockerfile, /^USER node$/m);
  assert.match(dockerfile, /ENTRYPOINT \["codex"\]/);
  assert.match(config, /cli_auth_credentials_store = "file"/);
  assert.match(config, /forced_login_method = "chatgpt"/);
  assert.match(config, /^default_permissions = "relmio-workspace"$/m);
  assert.doesNotMatch(config, /^":root" = "deny"$/mu);
  assert.doesNotMatch(config, /\/home\/node\/\.codex/u);
  assert.match(config, /\[permissions\.relmio-workspace\]/);
  assert.match(config, /extends = ":workspace"/);
  assert.match(
    config,
    /\[permissions\.relmio-workspace\.network\]\nenabled = false/,
  );
  assert.doesNotMatch(config, /sandbox_mode|sandbox_workspace_write/);
  assert.match(config, /inherit = "none"/);
  assert.match(requirements, /allowed_approval_policies = \["on-request"\]/);
  assert.match(requirements, /allowed_approvals_reviewers = \["user"\]/);
  assert.match(requirements, /allowed_login_methods = \["chatgpt"\]/);
  assert.doesNotMatch(requirements, /allowed_sandbox_modes/);
  assert.match(requirements, /^default_permissions = "relmio-workspace"$/m);
  const allowedProfiles =
    /\[allowed_permission_profiles\]\n([\s\S]*?)(?:\n\[|$)/u.exec(
      requirements,
    )?.[1].trim();
  assert.equal(allowedProfiles, '"relmio-workspace" = true');
  assert.match(requirements, /allowed_web_search_modes = \["disabled"\]/);
  assert.match(requirements, /allow_managed_hooks_only = true/);
  assert.match(requirements, /allow_remote_control = false/);
  assert.match(requirements, /multi_agent = false/);
  assert.doesNotMatch(`${config}\n${requirements}`, /danger-full-access/);
});

test("Codex Compose isolates the official server behind one loopback binding", () => {
  const compose = createCodexComposeFile({
    port: 14500,
    tokenSha256: verifier,
    installId,
  });

  assert.match(compose, /127\.0\.0\.1:14500:4500/);
  assert.match(compose, /--listen\n\s+- ws:\/\/0\.0\.0\.0:4500/);
  assert.match(compose, /- --strict-config/);
  assert.match(compose, /--ws-auth\n\s+- capability-token/);
  assert.match(compose, /--ws-token-sha256\n\s+- a{64}/);
  assert.match(compose, /codex-home:\/home\/node\/\.codex/);
  assert.match(compose, /codex-workspace:\/workspace/);
  assert.match(compose, /io\.relmio\.install: "b{32}"/);
  assert.match(compose, /codex-home:\n\s+labels:/);
  assert.match(compose, /127\.0\.0\.1:4500\/readyz/);
  assert.match(compose, /no-new-privileges:true/);
  assert.match(compose, /cap_drop:\n\s+- ALL/);
  assert.match(compose, /read_only: true/);
  assert.doesNotMatch(compose, /\/var\/run\/docker\.sock|\/Users\/|~\/|\.ssh|n8n/i);
  assert.doesNotMatch(compose, /0\.0\.0\.0:14500|:::14500/);
});

test("local target metadata remains closed and immutable", () => {
  assert.deepEqual(Object.keys(LOCAL_TARGETS).sort(), [
    "codex-chat",
    "codex-chatgpt",
    "openai-api",
  ]);
  assert.equal(Object.isFrozen(LOCAL_TARGETS), true);
});

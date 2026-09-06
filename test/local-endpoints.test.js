import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { runInNewContext } from "node:vm";
import { brotliCompressSync, brotliDecompressSync } from "node:zlib";

import { PROVIDER_TARGET_BINDINGS } from "../src/domain/provider-lifecycle.js";
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
  GROK_BUILD_CLI_VERSION,
  GROK_BUILD_REQUIREMENTS_TOML,
  createGrokBuildComposeFile,
  createGrokBuildDockerfile,
  createLocalDockerignore,
  createLocalDeploymentPlan,
  validateInstallId,
  validateLocalPort,
  validateLocalTarget,
  validateSha256Verifier,
} from "../src/domain/local-endpoints.js";

const verifier = "a".repeat(64);
const installId = "b".repeat(32);

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

test("SuperGrok is an isolated direct OAuth adapter with an exact official login pin", async () => {
  const plan = createLocalDeploymentPlan({ target: "xai-grok-build" });
  assert.deepEqual(plan, {
    target: "xai-grok-build", label: "SuperGrok", bindHost: "127.0.0.1",
    port: 14502, endpoint: "http://127.0.0.1:14502", protocol: "relmio-grok-build-chat-http",
    upstreamAuth: "provider-owned-oauth", browserClients: false,
    experimental: true, managedPath: "~/.relmio/local/xai-grok-build",
  });
  assert.equal(GROK_BUILD_CLI_VERSION, "1.0.13");
  const dockerfile = createGrokBuildDockerfile();
  const compose = createGrokBuildComposeFile({ port: 14502, tokenSha256: verifier, installId });
  const policyArguments = dockerfile.match(/printf '%s\\n' ((?:'[^']*' ?)+) > \/etc\/grok\/requirements\.toml/u)?.[1];
  assert.ok(policyArguments);
  const generatedPolicy = [...policyArguments.matchAll(/'([^']*)'/gu)].map((match) => match[1]).join("\n") + "\n";
  assert.match(dockerfile, /@xai-official\/grok@1\.0\.13/);
  assert.match(dockerfile, /--ignore-scripts/);
  assert.match(dockerfile, /COPY --chown=node:node gateway\.js chat\.js session\.js \/app\//);
  assert.match(dockerfile, /mkdir -p \/etc\/grok/);
  assert.equal(generatedPolicy, GROK_BUILD_REQUIREMENTS_TOML);
  assert.match(dockerfile, /disable_bypass_permissions_mode = true/);
  for (const tool of ["Bash", "Edit", "Read", "Grep", "MCPTool", "WebFetch", "WebSearch"]) {
    assert.match(dockerfile, new RegExp(`action = "deny", tool = "${tool}"`, "u"));
  }
  assert.match(dockerfile, /chmod 0444 \/etc\/grok\/requirements\.toml/);
  assert.match(compose, /127\.0\.0\.1:14502:14502/);
  const { version } = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));
  assert.ok(compose.includes(`RELMIO_GATEWAY_VERSION: ${version}`));
  assert.match(compose, /grok-home:\/home\/node\/\.grok/);
  assert.match(compose, /RELMIO_GATEWAY_PUBLIC_PORT: "14502"/);
  assert.ok(compose.includes(`RELMIO_GATEWAY_INSTALL_ID: "${installId}"`));
  assert.match(compose, /no-new-privileges:true/);
  assert.match(compose, /cap_drop:\n\s+- ALL/);
  assert.match(compose, /read_only: true/);
  assert.doesNotMatch(compose, /:\/etc\/grok(?:\/|$)/u);
  assert.doesNotMatch(compose, /xai_api_key|codex|workspace|n8n/i);
});

test("Grok Build image runtime has no repository package metadata dependency", async () => {
  const source = await readFile(new URL("../src/supergrok/runtime.js", import.meta.url), "utf8");
  assert.doesNotMatch(source, /createRequire|package\.json/u);
  assert.equal(createLocalDockerignore("xai-grok-build"), "**\n!Dockerfile\n!gateway.js\n!chat.js\n!session.js\n");
  assert.doesNotMatch(createGrokBuildDockerfile(), /COPY[^\n]*package\.json/u);
});

test("Grok image bootstraps only the pinned platform payload outside credential storage", () => {
  const dockerfile = createGrokBuildDockerfile();
  const program = dockerfile.match(/&& node -e '([^']+)'/u)?.[1];
  assert.ok(program);
  assert.match(dockerfile, /--include=optional --ignore-scripts/u);
  assert.match(dockerfile, /ln -sf \/opt\/relmio-grok\/grok \/usr\/local\/bin\/grok/u);
  assert.match(dockerfile, /GROK_HOME=\/tmp\/relmio-grok-bootstrap GROK_MANAGED_BY_NPM=1 grok --no-auto-update --version/u);
  assert.match(dockerfile, /^ENV GROK_MANAGED_BY_NPM=1$/mu);
  const payload = Buffer.from("fixture native executable");
  for (const arch of ["x64", "arm64"]) {
    const metadata = `/fixture/grok-linux-${arch}/package.json`;
    const writes = [];
    const fs = {
      readFileSync(file) {
        if (file === metadata) return JSON.stringify({ version: GROK_BUILD_CLI_VERSION });
        assert.equal(file, `/fixture/grok-linux-${arch}/bin/grok.br`);
        return brotliCompressSync(payload);
      },
      mkdirSync(file, options) { writes.push({ file, options }); },
      writeFileSync(file, bytes, options) { writes.push({ file, bytes, options }); },
    };
    const requireFixture = (name) => ({ "node:fs": fs, "node:path": path, "node:zlib": { brotliDecompressSync } })[name];
    requireFixture.resolve = (name, options) => {
      assert.equal(name, `@xai-official/grok-linux-${arch}/package.json`);
      assert.equal(JSON.stringify(options), JSON.stringify({ paths: ["/usr/local/lib/node_modules/@xai-official/grok"] }));
      return metadata;
    };
    const execute = () => runInNewContext(program, {
      require: requireFixture,
      process: { platform: "linux", arch, env: { GROK_HOME: "/foreign/credential-home" } },
    });
    execute();
    assert.equal(writes[0].file, "/opt/relmio-grok");
    assert.equal(writes[0].options.mode, 0o755);
    assert.equal(writes[1].file, "/opt/relmio-grok/grok");
    assert.deepEqual(writes[1].bytes, payload);
    assert.equal(writes[1].options.mode, 0o755);
    assert.equal(writes[1].options.flag, "wx");
    writes.length = 0;
    fs.readFileSync = () => JSON.stringify({ version: "0.0.0" });
    assert.throws(execute, /version mismatch/u);
    assert.equal(writes.length, 0);
  }
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



test("OAuth-only targets reject retired API routes before planning", () => {
  assert.deepEqual(Object.keys(LOCAL_TARGETS), ["codex-chatgpt", "codex-chat", "xai-grok-build"]);
  for (const target of Object.keys(LOCAL_TARGETS)) {
    assert.doesNotMatch(LOCAL_TARGETS[target].upstreamAuth, /api-key/i);
    assert.equal(LOCAL_TARGETS[target].label, PROVIDER_TARGET_BINDINGS[target].label);
  }
  for (const target of ["openai-api", "xai-inference", "n8n-xai-inference"]) {
    assert.throws(() => validateLocalTarget(target), /target/i);
    assert.throws(() => createLocalDeploymentPlan({ target, port: 12435 }), /target/i);
  }
  assert.deepEqual(createLocalDeploymentPlan({ target: "xai-grok-build" }), {
    target: "xai-grok-build", label: "SuperGrok", bindHost: "127.0.0.1", port: 14502,
    endpoint: "http://127.0.0.1:14502", protocol: "relmio-grok-build-chat-http",
    upstreamAuth: "provider-owned-oauth", browserClients: false, experimental: true,
    managedPath: "~/.relmio/local/xai-grok-build",
  });
});

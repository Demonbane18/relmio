import { validatePort } from "./validation.js";
import { getProviderTargetBinding } from "./provider-lifecycle.js";
import packageManifest from "../../package.json" with { type: "json" };

export const CODEX_CLI_VERSION = "0.147.0";
export const GROK_BUILD_CLI_VERSION = "1.0.13";
export const GROK_BUILD_REQUIREMENTS_TOML = [
  "[ui]",
  "disable_bypass_permissions_mode = true",
  "",
  "[permission]",
  "rules = [",
  '  { action = "deny", tool = "Bash" },',
  '  { action = "deny", tool = "Edit" },',
  '  { action = "deny", tool = "Read" },',
  '  { action = "deny", tool = "Grep" },',
  '  { action = "deny", tool = "MCPTool" },',
  '  { action = "deny", tool = "WebFetch" },',
  '  { action = "deny", tool = "WebSearch" },',
  "]",
  "",
].join("\n");
const PACKAGE_VERSION = packageManifest.version;

function createLocalTargetDefinition(targetId, runtimeMetadata) {
  const binding = getProviderTargetBinding(targetId);
  if (
    !runtimeMetadata ||
    typeof runtimeMetadata !== "object" ||
    Object.keys(runtimeMetadata).length !== 3 ||
    !Object.hasOwn(runtimeMetadata, "browserClients") ||
    !Object.hasOwn(runtimeMetadata, "experimental") ||
    !Object.hasOwn(runtimeMetadata, "containerPort")
  ) {
    throw new TypeError("Local endpoint runtime metadata is invalid.");
  }

  return Object.freeze({
    label: binding.label,
    protocol: binding.protocol,
    upstreamAuth: binding.upstreamAuth,
    browserClients: runtimeMetadata.browserClients,
    experimental: runtimeMetadata.experimental,
    containerPort: runtimeMetadata.containerPort,
  });
}

export const LOCAL_TARGETS = Object.freeze({
  "codex-chatgpt": createLocalTargetDefinition("codex-chatgpt", {
    browserClients: false,
    experimental: true,
    containerPort: 4_500,
  }),
  "codex-chat": createLocalTargetDefinition("codex-chat", {
    browserClients: false,
    experimental: true,
    containerPort: 14_501,
  }),
  "xai-grok-build": createLocalTargetDefinition("xai-grok-build", {
    browserClients: false,
    experimental: true,
    containerPort: 14_502,
  }),
});

export function validateLocalTarget(value) {
  if (
    typeof value !== "string" ||
    !Object.prototype.hasOwnProperty.call(LOCAL_TARGETS, value)
  ) {
    throw new TypeError("Local endpoint target is invalid.");
  }
  return value;
}

export function validateLocalPort(value) {
  const port = validatePort(value);
  if (port < 1_024) {
    throw new TypeError("Local endpoint port must be between 1024 and 65535.");
  }
  return port;
}

export function validateSha256Verifier(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/u.test(value)) {
    throw new TypeError("Local capability verifier is invalid.");
  }
  return value;
}

export function validateInstallId(value) {
  if (typeof value !== "string" || !/^[a-f0-9]{32}$/u.test(value)) {
    throw new TypeError("Local endpoint installation ID is invalid.");
  }
  return value;
}

export function createLocalDeploymentPlan({
  target,
  port,
}) {
  const safeTarget = validateLocalTarget(target);
  const safePort = validateLocalPort(
    safeTarget === "xai-grok-build" ? port ?? 14_502 : port,
  );
  const targetDefinition = LOCAL_TARGETS[safeTarget];
  const endpoint =
    safeTarget === "codex-chatgpt"
      ? `ws://127.0.0.1:${safePort}`
      : `http://127.0.0.1:${safePort}`;

  return {
    target: safeTarget,
    label: targetDefinition.label,
    bindHost: "127.0.0.1",
    port: safePort,
    endpoint,
    protocol: targetDefinition.protocol,
    upstreamAuth: targetDefinition.upstreamAuth,
    browserClients: targetDefinition.browserClients,
    experimental: targetDefinition.experimental,
    managedPath: `~/.relmio/local/${safeTarget}`,
  };
}

export function createLocalDockerignore(target) {
  const safeTarget = validateLocalTarget(target);
  if (safeTarget === "xai-grok-build") {
    return "**\n!Dockerfile\n!gateway.js\n!chat.js\n!session.js\n";
  }
  return safeTarget === "codex-chat"
    ? "**\n!Dockerfile\n!gateway.mjs\n!config.toml\n!requirements.toml\n"
    : "**\n!Dockerfile\n!config.toml\n!requirements.toml\n";
}

export function createGrokBuildDockerfile() {
  // The npm launcher prefers GROK_HOME/bin/grok, which is a writable credential
  // volume. Extract the pinned platform payload into the image instead.
  const bootstrap = [
    'const fs = require("node:fs");',
    'const path = require("node:path");',
    'const zlib = require("node:zlib");',
    'if (process.platform !== "linux" || !["x64", "arm64"].includes(process.arch)) throw new Error("Unsupported Grok image platform");',
    'const metadata = require.resolve("@xai-official/grok-linux-" + process.arch + "/package.json", { paths: ["/usr/local/lib/node_modules/@xai-official/grok"] });',
    `if (JSON.parse(fs.readFileSync(metadata, "utf8")).version !== "${GROK_BUILD_CLI_VERSION}") throw new Error("Grok platform version mismatch");`,
    'const binary = zlib.brotliDecompressSync(fs.readFileSync(path.join(path.dirname(metadata), "bin/grok.br")));',
    'fs.mkdirSync("/opt/relmio-grok", { mode: 0o755 });',
    'fs.writeFileSync("/opt/relmio-grok/grok", binary, { mode: 0o755, flag: "wx" });',
  ].join(" ");
  const requirements = GROK_BUILD_REQUIREMENTS_TOML.trimEnd()
    .split("\n")
    .map((line) => `'${line}'`)
    .join(" ");
  return `FROM node:22-bookworm-slim

WORKDIR /app

RUN npm install --global --include=optional --ignore-scripts @xai-official/grok@${GROK_BUILD_CLI_VERSION} \\
    && node -e '${bootstrap}' \\
    && ln -sf /opt/relmio-grok/grok /usr/local/bin/grok \\
    && GROK_HOME=/tmp/relmio-grok-bootstrap GROK_MANAGED_BY_NPM=1 grok --no-auto-update --version \\
    && npm cache clean --force \\
    && mkdir -p /etc/grok \\
    && printf '%s\\n' ${requirements} > /etc/grok/requirements.toml \\
    && chmod 0444 /etc/grok/requirements.toml \\
    && mkdir -p /home/node/.grok /workspace \\
    && chown -R node:node /home/node/.grok /workspace

COPY --chown=node:node gateway.js chat.js session.js /app/

ENV GROK_HOME=/home/node/.grok
ENV GROK_MANAGED_BY_NPM=1
WORKDIR /workspace
USER node

ENTRYPOINT ["node", "/app/gateway.js"]
`;
}

export function createGrokBuildComposeFile({ port, tokenSha256, installId }) {
  const safePort = validateLocalPort(port);
  const safeVerifier = validateSha256Verifier(tokenSha256);
  const safeInstallId = validateInstallId(installId);
  return `services:
  grok-build:
    image: relmio-grok-build-${safeInstallId}:local
    build:
      context: .
      dockerfile: Dockerfile
    restart: unless-stopped
    init: true
    environment:
      RELMIO_GATEWAY_TOKEN_SHA256: ${safeVerifier}
      RELMIO_GATEWAY_VERSION: ${PACKAGE_VERSION}
      RELMIO_GATEWAY_HOST: 0.0.0.0
      RELMIO_GATEWAY_PORT: "14502"
      RELMIO_GATEWAY_PUBLIC_PORT: "${safePort}"
      RELMIO_GATEWAY_INSTALL_ID: "${safeInstallId}"
    ports:
      - "127.0.0.1:${safePort}:14502"
    volumes:
      - grok-home:/home/node/.grok
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    read_only: true
    tmpfs:
      - /tmp:size=64m,mode=1777,nodev,nosuid
      - /run:size=16m,mode=0755,nodev,nosuid
    pids_limit: 128
    mem_limit: 2g
    cpus: 2.0
    healthcheck:
      test: ["CMD", "node", "-e", "fetch('http://127.0.0.1:14502/health').then((r) => process.exit(r.ok ? 0 : 1)).catch(() => process.exit(1))"]
      interval: 10s
      timeout: 5s
      retries: 9
      start_period: 20s
    labels:
      io.relmio.managed: "true"
      io.relmio.target: "xai-grok-build"
      io.relmio.install: "${safeInstallId}"

networks:
  default:
    labels:
      io.relmio.managed: "true"
      io.relmio.target: "xai-grok-build"
      io.relmio.install: "${safeInstallId}"

volumes:
  grok-home:
    labels:
      io.relmio.managed: "true"
      io.relmio.target: "xai-grok-build"
      io.relmio.install: "${safeInstallId}"
`;
}

function renderCodexConfig({
  approvalPolicy,
  permissionProfile,
  permissionProfileBase,
  protectCredentialStore = false,
}) {
  const filesystemPermissions = protectCredentialStore
    ? `
[permissions.${permissionProfile}.filesystem]
":root" = "deny"
":minimal" = "read"
":tmpdir" = "deny"
":slash_tmp" = "deny"
"/workspace" = "read"
"/home/node/.codex" = "deny"
`
    : "";
  return `approval_policy = "${approvalPolicy}"
approvals_reviewer = "user"
allow_login_shell = false
check_for_update_on_startup = false
cli_auth_credentials_store = "file"
default_permissions = "${permissionProfile}"
forced_login_method = "chatgpt"
web_search = "disabled"

[analytics]
enabled = false

[feedback]
enabled = false

[permissions.${permissionProfile}]
extends = "${permissionProfileBase}"
${filesystemPermissions}

[permissions.${permissionProfile}.network]
enabled = false

[shell_environment_policy]
inherit = "none"
ignore_default_excludes = false

[features]
apps = false
auth_elicitation = false
browser_use = false
browser_use_external = false
browser_use_full_cdp_access = false
code_mode_host = false
computer_use = false
fast_mode = false
goals = false
hooks = false
image_generation = false
in_app_browser = false
multi_agent = false
plugins = false
plugin_sharing = false
remote_plugin = false
shell_snapshot = false
skill_mcp_dependency_install = false
tool_call_mcp_elicitation = false
tool_suggest = false
`;
}

export function createCodexConfig() {
  return renderCodexConfig({
    approvalPolicy: "on-request",
    permissionProfile: "relmio-workspace",
    permissionProfileBase: ":workspace",
  });
}

export function createCodexChatConfig() {
  return renderCodexConfig({
    approvalPolicy: "never",
    permissionProfile: "relmio-chat-readonly",
    permissionProfileBase: ":read-only",
    protectCredentialStore: true,
  });
}

function renderCodexRequirements({ approvalPolicy, permissionProfile }) {
  return `allowed_approval_policies = ["${approvalPolicy}"]
allowed_approvals_reviewers = ["user"]
allowed_login_methods = ["chatgpt"]
allowed_web_search_modes = ["disabled"]
allow_managed_hooks_only = true
allow_remote_control = false
check_for_update_on_startup = false
allow_login_shell = false
default_permissions = "${permissionProfile}"

[allowed_permission_profiles]
"${permissionProfile}" = true

[feedback]
enabled = false

[features]
apps = false
auth_elicitation = false
browser_use = false
browser_use_external = false
browser_use_full_cdp_access = false
code_mode_host = false
computer_use = false
fast_mode = false
goals = false
hooks = false
image_generation = false
in_app_browser = false
multi_agent = false
plugins = false
plugin_sharing = false
remote_plugin = false
shell_snapshot = false
skill_mcp_dependency_install = false
tool_call_mcp_elicitation = false
tool_suggest = false
`;
}

export function createCodexRequirements() {
  return renderCodexRequirements({
    approvalPolicy: "on-request",
    permissionProfile: "relmio-workspace",
  });
}

export function createCodexChatRequirements() {
  return renderCodexRequirements({
    approvalPolicy: "never",
    permissionProfile: "relmio-chat-readonly",
  });
}

export function createCodexDockerfile() {
  return `FROM node:22-bookworm-slim

RUN apt-get update \\
    && apt-get install --no-install-recommends -y ca-certificates \\
    && rm -rf /var/lib/apt/lists/* \\
    && npm install --global --ignore-scripts @openai/codex@${CODEX_CLI_VERSION} \\
    && npm cache clean --force \\
    && mkdir -p /etc/codex /home/node/.codex /workspace \\
    && chown -R node:node /home/node/.codex /workspace

COPY --chmod=0444 requirements.toml /etc/codex/requirements.toml
COPY --chown=node:node config.toml /home/node/.codex/config.toml

ENV CODEX_HOME=/home/node/.codex
WORKDIR /workspace
USER node

ENTRYPOINT ["codex"]
`;
}

export function createCodexChatDockerfile() {
  return `FROM node:22-bookworm-slim

WORKDIR /app

RUN apt-get update \\
    && apt-get install --no-install-recommends -y ca-certificates \\
    && rm -rf /var/lib/apt/lists/* \\
    && npm install --global --ignore-scripts @openai/codex@${CODEX_CLI_VERSION} \\
    && npm cache clean --force \\
    && mkdir -p /etc/codex /home/node/.codex /workspace \\
    && chown -R node:node /home/node/.codex /workspace

COPY --chmod=0444 requirements.toml /etc/codex/requirements.toml
COPY --chown=node:node config.toml /home/node/.codex/config.toml
COPY --chown=node:node gateway.mjs /app/gateway.mjs

ENV CODEX_HOME=/home/node/.codex
WORKDIR /workspace
USER node

ENTRYPOINT ["node", "/app/gateway.mjs"]
`;
}

export function createCodexChatComposeFile({ port, tokenSha256, installId }) {
  const safePort = validateLocalPort(port);
  const safeVerifier = validateSha256Verifier(tokenSha256);
  const safeInstallId = validateInstallId(installId);
  const gatewayImage = `relmio-codex-chat-${safeInstallId}:local`;

  return `services:
  codex-chat:
    image: ${gatewayImage}
    build:
      context: .
      dockerfile: Dockerfile
    restart: unless-stopped
    init: true
    environment:
      RELMIO_GATEWAY_TOKEN_SHA256: ${safeVerifier}
      RELMIO_GATEWAY_HOST: 0.0.0.0
      RELMIO_GATEWAY_PORT: "14501"
      RELMIO_PACKAGE_VERSION: "${PACKAGE_VERSION}"
    ports:
      - "127.0.0.1:${safePort}:14501"
    volumes:
      - codex-home:/home/node/.codex
      - codex-workspace:/workspace
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    read_only: true
    tmpfs:
      - /tmp:size=64m,mode=1777,nodev,nosuid
      - /run:size=16m,mode=0755,nodev,nosuid
      - /home/node/.cache:uid=1000,gid=1000,mode=0700,nodev,nosuid
    pids_limit: 128
    mem_limit: 2g
    cpus: 2.0
    ulimits:
      nofile:
        soft: 1024
        hard: 1024
      core: 0
    logging:
      driver: json-file
      options:
        max-size: 10m
        max-file: "3"
    healthcheck:
      test:
        - CMD
        - node
        - -e
        - 'fetch("http://127.0.0.1:14501/health").then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))'
      interval: 10s
      timeout: 5s
      retries: 9
      start_period: 20s
    labels:
      io.relmio.managed: "true"
      io.relmio.target: "codex-chat"
      io.relmio.install: "${safeInstallId}"

networks:
  default:
    labels:
      io.relmio.managed: "true"
      io.relmio.target: "codex-chat"
      io.relmio.install: "${safeInstallId}"

volumes:
  codex-home:
    labels:
      io.relmio.managed: "true"
      io.relmio.target: "codex-chat"
      io.relmio.install: "${safeInstallId}"
  codex-workspace:
    labels:
      io.relmio.managed: "true"
      io.relmio.target: "codex-chat"
      io.relmio.install: "${safeInstallId}"
`;
}

export function createCodexComposeFile({ port, tokenSha256, installId }) {
  const safePort = validateLocalPort(port);
  const safeVerifier = validateSha256Verifier(tokenSha256);
  const safeInstallId = validateInstallId(installId);

  return `services:
  codex:
    build:
      context: .
      dockerfile: Dockerfile
    restart: unless-stopped
    init: true
    command:
      - app-server
      - --strict-config
      - --listen
      - ws://0.0.0.0:4500
      - --ws-auth
      - capability-token
      - --ws-token-sha256
      - ${safeVerifier}
    ports:
      - "127.0.0.1:${safePort}:4500"
    volumes:
      - codex-home:/home/node/.codex
      - codex-workspace:/workspace
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    read_only: true
    tmpfs:
      - /tmp:size=64m,mode=1777,nodev,nosuid
      - /run:size=16m,mode=0755,nodev,nosuid
      - /home/node/.cache:uid=1000,gid=1000,mode=0700,nodev,nosuid
    pids_limit: 128
    mem_limit: 2g
    cpus: 2.0
    ulimits:
      nofile:
        soft: 1024
        hard: 1024
      core: 0
    logging:
      driver: json-file
      options:
        max-size: 10m
        max-file: "3"
    healthcheck:
      test:
        - CMD
        - node
        - -e
        - 'fetch("http://127.0.0.1:4500/readyz").then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))'
      interval: 10s
      timeout: 5s
      retries: 9
      start_period: 20s
    labels:
      io.relmio.managed: "true"
      io.relmio.target: "codex-chatgpt"
      io.relmio.install: "${safeInstallId}"

networks:
  default:
    labels:
      io.relmio.managed: "true"
      io.relmio.target: "codex-chatgpt"
      io.relmio.install: "${safeInstallId}"

volumes:
  codex-home:
    labels:
      io.relmio.managed: "true"
      io.relmio.target: "codex-chatgpt"
      io.relmio.install: "${safeInstallId}"
  codex-workspace:
    labels:
      io.relmio.managed: "true"
      io.relmio.target: "codex-chatgpt"
      io.relmio.install: "${safeInstallId}"
`;
}

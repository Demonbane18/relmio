import { validatePort } from "./validation.js";

export const CODEX_CLI_VERSION = "0.147.0";

export const LOCAL_TARGETS = Object.freeze({
  "openai-api": Object.freeze({
    label: "OpenAI API",
    protocol: "openai-v1",
    upstreamAuth: "platform-api-key",
    browserClients: true,
    experimental: false,
    containerPort: 10_531,
  }),
  "codex-chatgpt": Object.freeze({
    label: "Codex with ChatGPT",
    protocol: "codex-app-server-json-rpc",
    upstreamAuth: "chatgpt-via-codex",
    browserClients: false,
    experimental: true,
    containerPort: 4_500,
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

export function validatePlatformApiKey(value) {
  if (
    typeof value !== "string" ||
    value.length > 512 ||
    !/^sk-[A-Za-z0-9_-]{32,509}$/u.test(value)
  ) {
    throw new TypeError("OpenAI Platform API key is invalid.");
  }
  return value;
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

function validateBrowserOrigin(value) {
  if (typeof value !== "string" || value.length > 2_048) {
    throw new TypeError("Browser origin is invalid.");
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("Browser origin is invalid.");
  }

  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username !== "" ||
    url.password !== "" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    value !== url.origin
  ) {
    throw new TypeError("Browser origin is invalid.");
  }

  return url.origin;
}

export function validateAllowedOrigins(value = []) {
  if (!Array.isArray(value) || value.length > 10) {
    throw new TypeError("Browser origin list is invalid.");
  }

  return [...new Set(value.map(validateBrowserOrigin))];
}

export function createLocalDeploymentPlan({
  target,
  port,
  allowedOrigins,
}) {
  const safeTarget = validateLocalTarget(target);
  const safePort = validateLocalPort(port);
  const targetDefinition = LOCAL_TARGETS[safeTarget];
  const safeOrigins =
    safeTarget === "openai-api"
      ? validateAllowedOrigins(allowedOrigins)
      : validateAllowedOrigins([]);
  const endpoint =
    safeTarget === "openai-api"
      ? `http://127.0.0.1:${safePort}/v1`
      : `ws://127.0.0.1:${safePort}`;

  return {
    target: safeTarget,
    label: targetDefinition.label,
    bindHost: "127.0.0.1",
    port: safePort,
    endpoint,
    protocol: targetDefinition.protocol,
    upstreamAuth: targetDefinition.upstreamAuth,
    allowedOrigins: safeOrigins,
    browserClients: targetDefinition.browserClients,
    experimental: targetDefinition.experimental,
    managedPath: `~/.relmio/local/${safeTarget}`,
  };
}

export function createOpenAiGatewayDockerfile() {
  return `FROM node:22-bookworm-slim

WORKDIR /app
COPY --chown=node:node gateway.mjs /app/gateway.mjs

USER node

ENTRYPOINT ["node", "/app/gateway.mjs"]
`;
}

export function createLocalDockerignore(target) {
  const safeTarget = validateLocalTarget(target);
  return safeTarget === "openai-api"
    ? "**\n!Dockerfile\n!gateway.mjs\n"
    : "**\n!Dockerfile\n!config.toml\n!requirements.toml\n";
}

export function createOpenAiGatewayComposeFile({
  port,
  tokenSha256,
  allowedOrigins,
  installId,
}) {
  const safePort = validateLocalPort(port);
  const safeVerifier = validateSha256Verifier(tokenSha256);
  const safeOrigins = validateAllowedOrigins(allowedOrigins);
  const safeInstallId = validateInstallId(installId);
  const originsBase64 = Buffer.from(JSON.stringify(safeOrigins), "utf8").toString(
    "base64",
  );
  const gatewayImage = `relmio-openai-api-${safeInstallId}-gateway:local`;

  return `services:
  gateway:
    image: ${gatewayImage}
    build:
      context: .
      dockerfile: Dockerfile
    restart: unless-stopped
    init: true
    environment:
      OPENAI_API_KEY_FILE: /run/relmio-secret/openai-api-key
      RELMIO_GATEWAY_TOKEN_SHA256: ${safeVerifier}
      RELMIO_ALLOWED_ORIGINS_BASE64: ${originsBase64}
      RELMIO_GATEWAY_HOST: 0.0.0.0
      RELMIO_GATEWAY_PORT: "10531"
    volumes:
      - openai-api-key:/run/relmio-secret:ro
    ports:
      - "127.0.0.1:${safePort}:10531"
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    read_only: true
    tmpfs:
      - /tmp:size=16m,mode=1777
    pids_limit: 128
    mem_limit: 512m
    cpus: 1.0
    healthcheck:
      test:
        - CMD
        - node
        - -e
        - 'fetch("http://127.0.0.1:10531/health").then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))'
      interval: 10s
      timeout: 5s
      retries: 6
      start_period: 10s
    labels:
      io.relmio.managed: "true"
      io.relmio.target: "openai-api"
      io.relmio.install: "${safeInstallId}"

  credential-seed:
    image: ${gatewayImage}
    pull_policy: never
    profiles:
      - relmio-credential-seed
    restart: "no"
    network_mode: none
    user: "0:0"
    entrypoint:
      - /bin/sh
      - -c
    command:
      - |
        set -eu
        umask 077
        trap 'rm -f -- /run/relmio-secret/.openai-api-key.next' EXIT HUP INT TERM
        rm -f -- /run/relmio-secret/.openai-api-key.next
        cat > /run/relmio-secret/.openai-api-key.next
        chmod 0400 /run/relmio-secret/.openai-api-key.next
        chown 1000:1000 /run/relmio-secret/.openai-api-key.next
        mv -f -- /run/relmio-secret/.openai-api-key.next /run/relmio-secret/openai-api-key
        trap - EXIT HUP INT TERM
    volumes:
      - openai-api-key:/run/relmio-secret
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    cap_add:
      - CHOWN
    read_only: true
    pids_limit: 32
    mem_limit: 64m
    cpus: 0.25
    logging:
      driver: "none"
    labels:
      io.relmio.managed: "true"
      io.relmio.target: "openai-api"
      io.relmio.install: "${safeInstallId}"

networks:
  default:
    labels:
      io.relmio.managed: "true"
      io.relmio.target: "openai-api"
      io.relmio.install: "${safeInstallId}"

volumes:
  openai-api-key:
    labels:
      io.relmio.managed: "true"
      io.relmio.target: "openai-api"
      io.relmio.install: "${safeInstallId}"
`;
}

export function createCodexConfig() {
  return `approval_policy = "on-request"
approvals_reviewer = "user"
allow_login_shell = false
check_for_update_on_startup = false
cli_auth_credentials_store = "file"
default_permissions = "relmio-workspace"
forced_login_method = "chatgpt"
web_search = "disabled"

[analytics]
enabled = false

[feedback]
enabled = false

[permissions.relmio-workspace]
extends = ":workspace"

[permissions.relmio-workspace.network]
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

export function createCodexRequirements() {
  return `allowed_approval_policies = ["on-request"]
allowed_approvals_reviewers = ["user"]
allowed_login_methods = ["chatgpt"]
allowed_web_search_modes = ["disabled"]
allow_managed_hooks_only = true
allow_remote_control = false
check_for_update_on_startup = false
allow_login_shell = false
default_permissions = "relmio-workspace"

[allowed_permission_profiles]
"relmio-workspace" = true

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

export function createCodexDockerfile() {
  return `FROM node:22-bookworm-slim

RUN npm install --global --ignore-scripts @openai/codex@${CODEX_CLI_VERSION} \\
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

import { validateLocalDockerHost } from "../infrastructure/local-process.js";
import { validateDockerName } from "./validation.js";
import { validateInstallId } from "./local-endpoints.js";

export const LOCAL_N8N_SIDECAR_TARGET = "n8n-openai-oauth";
export const LOCAL_N8N_SIDECAR_HOSTNAME = "n8n-openai-oauth";
export const LOCAL_N8N_SIDECAR_PORT = 10_531;
export const LOCAL_N8N_SIDECAR_ENDPOINT =
  "http://n8n-openai-oauth:10531/v1";

const DOCKER_OBJECT_ID_PATTERN = /^[a-f0-9]{64}$/u;
const AUTH_GENERATION_MAX_BYTES = 128;

export function validateDockerObjectId(value, label = "Docker object") {
  if (typeof value !== "string" || !DOCKER_OBJECT_ID_PATTERN.test(value)) {
    throw new TypeError(`${label} identity is invalid.`);
  }
  return value;
}

export function validateAuthGeneration(value) {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value) > AUTH_GENERATION_MAX_BYTES
  ) {
    throw new TypeError("OAuth credential generation is invalid.");
  }
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime()) || parsed.toISOString() !== value) {
    throw new TypeError("OAuth credential generation is invalid.");
  }
  return value;
}

export function createLocalN8nSidecarPlan({
  dockerHost,
  n8nContainerId,
  n8nContainerName,
  dockerNetworkId,
  networkName,
  authGeneration,
}) {
  return {
    kind: "n8n-sidecar",
    target: LOCAL_N8N_SIDECAR_TARGET,
    label: "Self-hosted n8n bridge",
    endpoint: LOCAL_N8N_SIDECAR_ENDPOINT,
    baseUrl: LOCAL_N8N_SIDECAR_ENDPOINT,
    protocol: "openai-v1",
    upstreamAuth: "chatgpt-oauth",
    dockerHost: validateLocalDockerHost(dockerHost),
    n8nContainerId: validateDockerObjectId(
      n8nContainerId,
      "n8n container",
    ),
    n8nContainerName: validateDockerName(n8nContainerName),
    dockerNetworkId: validateDockerObjectId(
      dockerNetworkId,
      "Docker network",
    ),
    networkName: validateDockerName(networkName),
    authGeneration: validateAuthGeneration(authGeneration),
    managedPath: "~/.relmio/local/n8n-openai-oauth",
    hostPublication: "none",
    unofficial: true,
  };
}

export function normalizeLocalN8nSidecarPlan(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("The local n8n sidecar plan is invalid.");
  }
  const normalized = createLocalN8nSidecarPlan({
    dockerHost: value.dockerHost,
    n8nContainerId: value.n8nContainerId,
    n8nContainerName: value.n8nContainerName,
    dockerNetworkId: value.dockerNetworkId,
    networkName: value.networkName,
    authGeneration: value.authGeneration,
  });
  for (const [name, expected] of Object.entries(normalized)) {
    if (value[name] !== expected) {
      throw new TypeError("The local n8n sidecar plan is invalid.");
    }
  }
  return normalized;
}

export function createLocalN8nSidecarDockerfile({ installId }) {
  const safeInstallId = validateInstallId(installId);
  return `FROM node:22-bookworm-slim

ARG RELMIO_INSTALL_ID=${safeInstallId}
LABEL io.relmio.managed="true" \\
      io.relmio.target="${LOCAL_N8N_SIDECAR_TARGET}" \\
      io.relmio.install="${safeInstallId}"

RUN npm install --global --ignore-scripts openai-oauth@2.0.0 \\
    && npm cache clean --force

USER node

ENTRYPOINT ["openai-oauth"]
CMD ["--host", "0.0.0.0", "--port", "10531", "--oauth-file", "/home/node/.codex/auth.json"]
`;
}

export function createLocalN8nSidecarDockerignore() {
  return "**\n!Dockerfile\n";
}

export function createLocalN8nSidecarComposeFile({
  installId,
  networkName,
}) {
  const safeInstallId = validateInstallId(installId);
  const safeNetworkName = validateDockerName(networkName);
  const image = `relmio-n8n-openai-oauth-${safeInstallId}:local`;

  return `services:
  openai-oauth:
    image: ${image}
    build:
      context: .
      dockerfile: Dockerfile
      args:
        RELMIO_INSTALL_ID: "${safeInstallId}"
      labels:
        io.relmio.managed: "true"
        io.relmio.target: "${LOCAL_N8N_SIDECAR_TARGET}"
        io.relmio.install: "${safeInstallId}"
    restart: unless-stopped
    init: true
    volumes:
      - oauth-auth:/home/node/.codex
    expose:
      - "10531"
    networks:
      n8n-shared:
        aliases:
          - ${LOCAL_N8N_SIDECAR_HOSTNAME}
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    read_only: true
    tmpfs:
      - /tmp:size=16m,mode=1777
      - /home/node/.local:uid=1000,gid=1000,mode=0700
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
      start_period: 20s
    labels:
      io.relmio.managed: "true"
      io.relmio.target: "${LOCAL_N8N_SIDECAR_TARGET}"
      io.relmio.install: "${safeInstallId}"

  credential-seed:
    image: ${image}
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
        trap 'rm -f -- /run/relmio-auth/.auth.json.next; chown 1000:1000 /run/relmio-auth' EXIT HUP INT TERM
        chown 0:0 /run/relmio-auth
        chmod 0700 /run/relmio-auth
        rm -f -- /run/relmio-auth/.auth.json.next
        cat > /run/relmio-auth/.auth.json.next
        node -e 'JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))' /run/relmio-auth/.auth.json.next
        chmod 0600 /run/relmio-auth/.auth.json.next
        chown 1000:1000 /run/relmio-auth/.auth.json.next
        mv -f -- /run/relmio-auth/.auth.json.next /run/relmio-auth/auth.json
        chown 1000:1000 /run/relmio-auth
        trap - EXIT HUP INT TERM
    volumes:
      - oauth-auth:/run/relmio-auth
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
      io.relmio.target: "${LOCAL_N8N_SIDECAR_TARGET}"
      io.relmio.install: "${safeInstallId}"

networks:
  n8n-shared:
    external: true
    name: ${safeNetworkName}

volumes:
  oauth-auth:
    labels:
      io.relmio.managed: "true"
      io.relmio.target: "${LOCAL_N8N_SIDECAR_TARGET}"
      io.relmio.install: "${safeInstallId}"
`;
}

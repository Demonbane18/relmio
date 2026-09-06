import { validateLocalDockerHost } from "../infrastructure/local-process.js";
import { validateDockerName } from "./validation.js";
import { validateDockerObjectId } from "./local-n8n-sidecar.js";
import { createGrokBuildDockerfile, createLocalDockerignore, validateInstallId, validateSha256Verifier } from "./local-endpoints.js";
import packageManifest from "../../package.json" with { type: "json" };

export const LOCAL_N8N_SUPERGROK_TARGET = "n8n-supergrok-oauth";
export const LOCAL_N8N_SUPERGROK_HOSTNAME = "n8n-supergrok";
export const LOCAL_N8N_SUPERGROK_PORT = 14_502;
export const LOCAL_N8N_SUPERGROK_ENDPOINT = "http://n8n-supergrok:14502/v1";

export function createLocalN8nSuperGrokPlan({ dockerHost, n8nContainerId, n8nContainerName, dockerNetworkId, networkName }) {
  return {
    kind: "n8n-supergrok",
    target: LOCAL_N8N_SUPERGROK_TARGET,
    label: "SuperGrok for n8n",
    endpoint: LOCAL_N8N_SUPERGROK_ENDPOINT,
    baseUrl: LOCAL_N8N_SUPERGROK_ENDPOINT,
    protocol: "openai-chat-completions",
    upstreamAuth: "provider-owned-oauth",
    dockerHost: validateLocalDockerHost(dockerHost),
    n8nContainerId: validateDockerObjectId(n8nContainerId, "n8n container"),
    n8nContainerName: validateDockerName(n8nContainerName),
    dockerNetworkId: validateDockerObjectId(dockerNetworkId, "Docker network"),
    networkName: validateDockerName(networkName),
    managedPath: "~/.relmio/local/n8n-supergrok-oauth",
    hostPublication: "none",
    experimental: true,
  };
}

export function normalizeLocalN8nSuperGrokPlan(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("The private SuperGrok plan is invalid.");
  const normalized = createLocalN8nSuperGrokPlan(value);
  if (Object.keys(value).some(key => !Object.hasOwn(normalized, key) && key !== "disposableHarnessWarning") ||
      (Object.hasOwn(value, "disposableHarnessWarning") && typeof value.disposableHarnessWarning !== "boolean") ||
      Object.entries(normalized).some(([key, expected]) => value[key] !== expected)) {
    throw new TypeError("The private SuperGrok plan is invalid.");
  }
  return normalized;
}

export function createLocalN8nSuperGrokDockerfile({ installId }) {
  const id = validateInstallId(installId);
  return `${createGrokBuildDockerfile()}\nLABEL io.relmio.managed="true" \\
      io.relmio.target="${LOCAL_N8N_SUPERGROK_TARGET}" \\
      io.relmio.install="${id}"\n`;
}

export function createLocalN8nSuperGrokDockerignore() {
  return createLocalDockerignore("xai-grok-build");
}

export function createLocalN8nSuperGrokComposeFile({ installId, networkName, tokenSha256 }) {
  const id = validateInstallId(installId);
  const network = validateDockerName(networkName);
  const verifier = validateSha256Verifier(tokenSha256);
  return `services:
  supergrok-oauth:
    image: relmio-n8n-supergrok-oauth-${id}:local
    build:
      context: .
      dockerfile: Dockerfile
    restart: unless-stopped
    init: true
    environment:
      RELMIO_GATEWAY_TOKEN_SHA256: ${verifier}
      RELMIO_GATEWAY_VERSION: ${packageManifest.version}
      RELMIO_GATEWAY_HOST: 0.0.0.0
      RELMIO_GATEWAY_PORT: "14502"
      RELMIO_GATEWAY_PUBLIC_PORT: "14502"
      RELMIO_GATEWAY_PRIVATE_HOST: "n8n-supergrok:14502"
      RELMIO_GATEWAY_INSTALL_ID: "${id}"
    volumes:
      - grok-home:/home/node/.grok
    networks:
      n8n-shared:
        aliases:
          - n8n-supergrok
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
      io.relmio.target: "${LOCAL_N8N_SUPERGROK_TARGET}"
      io.relmio.install: "${id}"

networks:
  n8n-shared:
    external: true
    name: ${network}

volumes:
  grok-home:
    labels:
      io.relmio.managed: "true"
      io.relmio.target: "${LOCAL_N8N_SUPERGROK_TARGET}"
      io.relmio.install: "${id}"
`;
}

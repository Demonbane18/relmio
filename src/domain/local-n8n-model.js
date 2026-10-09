import { isDeepStrictEqual } from "node:util";
import { validateLocalDockerHost } from "../infrastructure/local-process.js";
import { validateDockerName } from "./validation.js";
import { validateDockerObjectId } from "./local-n8n-sidecar.js";
import { validateInstallId } from "./local-endpoints.js";
import { getProviderTargetBinding } from "./provider-lifecycle.js";
import { getLocalModelDefinition, LOCAL_MODEL_CATALOG_REVISION } from "../local-model/catalog.mjs";

export { getLocalModelDefinition, LOCAL_MODEL_CATALOG } from "../local-model/catalog.mjs";
export const LOCAL_N8N_MODEL_TARGET = "n8n-local-model";
export const LOCAL_N8N_MODEL_HOSTNAME = "n8n-local-model";
export const LOCAL_N8N_MODEL_PORT = 11434;
export const LOCAL_N8N_MODEL_ENDPOINT = "http://n8n-local-model:11434/v1";
export const LOCAL_MODEL_RUNTIME_IMAGE = "ollama/ollama:0.34.4@sha256:8262851b2846b87c649eddf3e76beb270c52f4d1bc94559f47efde16b0841551";
export const LOCAL_MODEL_HELPER_IMAGE = "node:24-bookworm-slim@sha256:0e0ff40c39bc087845bfb27465a0df4ea419520094bc35842ff83dd8cbe6f9b6";
const GIB = 1024 ** 3;

export function hasEnabledNoNewPrivileges(securityOptions) {
  if (!Array.isArray(securityOptions)) return false;
  let enabled = false;
  for (const option of securityOptions) {
    if (option === "no-new-privileges" || option === "no-new-privileges:true" || option === "no-new-privileges=true") {
      enabled = true;
    } else if (typeof option !== "string" || option.startsWith("no-new-privileges")) {
      return false;
    }
  }
  return enabled;
}

function resourceBudget(modelId, value) {
  const model = getLocalModelDefinition(modelId);
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).length !== 3 ||
      !Number.isSafeInteger(value.memoryBytes) || value.memoryBytes <= 0 ||
      !Number.isSafeInteger(value.diskAvailableBytes) || value.diskAvailableBytes <= 0 ||
      !Number.isFinite(value.cpus) || value.cpus < 1 || value.cpus > 4096) {
    throw new TypeError("Measured Docker memory, CPUs and available disk are required.");
  }
  const hostResources = { memoryBytes: value.memoryBytes, cpus: value.cpus, diskAvailableBytes: value.diskAvailableBytes };
  const reservedMemoryBytes = Math.max(1.5 * GIB, Math.ceil(value.memoryBytes * 0.2)) + 256 * 1024 ** 2;
  const requiredDiskBytes = model.expectedDownloadBytes * 2 + 12 * GIB;
  if (model.memoryBytes + reservedMemoryBytes > value.memoryBytes) {
    throw new RangeError("Docker memory is insufficient after reserving OS, n8n and acquisition headroom. Choose a smaller model.");
  }
  if (requiredDiskBytes > value.diskAvailableBytes) {
    throw new RangeError("Docker disk is insufficient for the model, runtime image and download headroom.");
  }
  return {
    contextTokens: model.contextTokens, memoryBytes: model.memoryBytes,
    cpus: Math.max(0.5, Math.min(4, value.cpus * 0.75)),
    expectedDownloadBytes: model.expectedDownloadBytes, requiredDiskBytes,
    reservedMemoryBytes, hostResources,
  };
}

export function createLocalN8nModelPlan({ dockerHost, n8nContainerId, n8nContainerName, dockerNetworkId, networkName, modelId, hostResources }) {
  const binding = getProviderTargetBinding(LOCAL_N8N_MODEL_TARGET);
  return {
    kind: LOCAL_N8N_MODEL_TARGET, target: LOCAL_N8N_MODEL_TARGET,
    label: binding.label, endpoint: LOCAL_N8N_MODEL_ENDPOINT, baseUrl: LOCAL_N8N_MODEL_ENDPOINT,
    protocol: binding.protocol, upstreamAuth: binding.upstreamAuth,
    dockerHost: validateLocalDockerHost(dockerHost),
    n8nContainerId: validateDockerObjectId(n8nContainerId, "n8n container"),
    n8nContainerName: validateDockerName(n8nContainerName),
    dockerNetworkId: validateDockerObjectId(dockerNetworkId, "Docker network"),
    networkName: validateDockerName(networkName),
    managedPath: "~/.relmio/local/n8n-local-model", hostPublication: "none",
    modelId: getLocalModelDefinition(modelId).id, catalogRevision: LOCAL_MODEL_CATALOG_REVISION,
    approvedModelDigest: getLocalModelDefinition(modelId).manifestDigest,
    runtimeImage: LOCAL_MODEL_RUNTIME_IMAGE, ...resourceBudget(modelId, hostResources),
    authentication: "none", apiKeyPlaceholder: "local-only", responsesApi: false,
    cloudEnabled: false, experimental: true,
  };
}

export function normalizeLocalN8nModelPlan(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("The private local model plan is invalid.");
  const normalized = createLocalN8nModelPlan(value);
  if (Object.keys(value).some(key => !Object.hasOwn(normalized, key) && key !== "disposableHarnessWarning") ||
      (Object.hasOwn(value, "disposableHarnessWarning") && typeof value.disposableHarnessWarning !== "boolean") ||
      Object.entries(normalized).some(([key, expected]) => !isDeepStrictEqual(value[key], expected))) {
    throw new TypeError("The private local model plan is invalid.");
  }
  return normalized;
}

export function createLocalN8nModelAcquisitionDockerfile({ installId }) {
  const id = validateInstallId(installId);
  return `FROM ${LOCAL_MODEL_HELPER_IMAGE}
LABEL io.relmio.managed="true" \\
      io.relmio.target="${LOCAL_N8N_MODEL_TARGET}" \\
      io.relmio.install="${id}"
WORKDIR /app
COPY --chown=node:node catalog.mjs acquisition.mjs /app/
USER node
ENTRYPOINT ["node", "/app/acquisition.mjs"]
`;
}

export function createLocalN8nModelDockerignore() {
  return "**\n!Dockerfile.acquisition\n!catalog.mjs\n!acquisition.mjs\n";
}

export function createLocalN8nModelComposeFile({ installId, networkName, modelId, hostResources }) {
  const id = validateInstallId(installId);
  const network = validateDockerName(networkName);
  const budget = resourceBudget(modelId, hostResources);
  return `services:
  local-model:
    image: ${LOCAL_MODEL_RUNTIME_IMAGE}
    restart: unless-stopped
    init: true
    user: "0:0"
    environment:
      OLLAMA_HOST: "0.0.0.0:11434"
      OLLAMA_NO_CLOUD: "1"
      OLLAMA_NOPRUNE: "1"
      OLLAMA_MODELS: "/root/.ollama/models"
      OLLAMA_CONTEXT_LENGTH: "${budget.contextTokens}"
      OLLAMA_NUM_PARALLEL: "1"
      OLLAMA_MAX_LOADED_MODELS: "1"
      OLLAMA_MAX_QUEUE: "4"
      OLLAMA_KEEP_ALIVE: "1m"
      NVIDIA_VISIBLE_DEVICES: "void"
      CUDA_VISIBLE_DEVICES: "-1"
    volumes:
      - model-cache:/root/.ollama
    networks:
      n8n-shared:
        aliases:
          - ${LOCAL_N8N_MODEL_HOSTNAME}
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    read_only: true
    tmpfs:
      - /tmp:size=256m,mode=1777,nodev,nosuid
    pids_limit: 256
    mem_limit: ${budget.memoryBytes}
    memswap_limit: ${budget.memoryBytes}
    cpus: ${budget.cpus}
    healthcheck:
      test: ["CMD", "/bin/ollama", "list"]
      interval: 10s
      timeout: 5s
      retries: 9
      start_period: 20s
    logging:
      driver: json-file
      options:
        max-size: "1m"
        max-file: "1"
    labels:
      io.relmio.managed: "true"
      io.relmio.target: "${LOCAL_N8N_MODEL_TARGET}"
      io.relmio.install: "${id}"
  acquisition:
    profiles: ["acquisition"]
    image: relmio-n8n-local-model-acquisition-${id}:local
    build:
      context: .
      dockerfile: Dockerfile.acquisition
    restart: "no"
    init: true
    user: "1000:1000"
    networks:
      - n8n-shared
    security_opt:
      - no-new-privileges:true
    cap_drop:
      - ALL
    read_only: true
    pids_limit: 64
    mem_limit: 268435456
    memswap_limit: 268435456
    cpus: 0.5
    logging:
      driver: json-file
      options:
        max-size: "1m"
        max-file: "1"
    labels:
      io.relmio.managed: "true"
      io.relmio.target: "${LOCAL_N8N_MODEL_TARGET}"
      io.relmio.install: "${id}"
networks:
  n8n-shared:
    external: true
    name: ${JSON.stringify(network)}
volumes:
  model-cache:
    labels:
      io.relmio.managed: "true"
      io.relmio.target: "${LOCAL_N8N_MODEL_TARGET}"
      io.relmio.install: "${id}"
`;
}

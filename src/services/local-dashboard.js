import {
  getLocalDockerStatus,
  getManagedLocalEndpointStatus,
} from "./local-installer.js";
import { getLocalN8nAssistantStatus } from "./local-n8n-assistant-installer.js";
import { getLocalN8nSidecarStatus } from "./local-n8n-sidecar-installer.js";
import { getLocalN8nSuperGrokStatus } from "./local-n8n-supergrok-installer.js";
import { getLocalN8nModelStatus } from "./local-n8n-model-installer.js";

const SERVICE_DEFINITIONS = Object.freeze([
  Object.freeze({
    target: "codex-chatgpt",
    label: "Codex (ChatGPT login)",
    kind: "endpoint",
  }),
  Object.freeze({ target: "codex-chat", label: "Codex Chat adapter", kind: "endpoint" }),
  Object.freeze({ target: "xai-grok-build", label: "SuperGrok", kind: "endpoint" }),
  Object.freeze({ target: "local-n8n-stack", label: "n8n + ngrok", kind: "n8n-stack" }),
  Object.freeze({
    target: "n8n-openai-oauth",
    label: "OpenAI OAuth bridge",
    kind: "n8n-oauth-bridge",
  }),
  Object.freeze({
    target: "local-n8n-assistant",
    label: "AI Assistant tools",
    kind: "n8n-assistant",
  }),
  Object.freeze({ target: "n8n-supergrok-oauth", label: "SuperGrok for n8n", kind: "n8n-supergrok" }),
  Object.freeze({ target: "n8n-local-model", label: "Local model for n8n", kind: "n8n-local-model" }),
]);
const STATES = new Set(["absent", "healthy", "stopped", "partial", "unavailable"]);
const ASSISTANT_MODES = new Set(["disabled", "sandbox", "sandbox-with-searxng"]);
const PROVIDER_DEFINITIONS = Object.freeze([
  Object.freeze({
    target: "codex-chatgpt",
    label: "ChatGPT",
    authentication: "provider-oauth",
  }),
  Object.freeze({
    target: "codex-chat",
    label: "ChatGPT",
    authentication: "provider-oauth",
  }),
  Object.freeze({
    target: "xai-grok-build",
    label: "SuperGrok",
    authentication: "provider-oauth",
  }),
  Object.freeze({ target: "n8n-supergrok-oauth", label: "SuperGrok (n8n)", authentication: "provider-oauth" }),
]);

function unavailableService(definition) {
  return {
    ...definition,
    managed: false,
    state: "unavailable",
    snapshot: null,
    actions: [],
  };
}

function absentService(definition) {
  return {
    ...definition,
    managed: false,
    state: "absent",
    snapshot: null,
    actions: ["setup"],
  };
}

function readExplicitLoopbackPort(value) {
  const match = /^(?:http|ws):\/\/127\.0\.0\.1:(\d{1,5})(?:\/|$)/u.exec(value);
  const port = Number(match?.[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new TypeError();
  }
  return port;
}

function validateLoopbackEndpoint(value, { target }) {
  if (typeof value !== "string" || value.length > 128) throw new TypeError();
  const parsed = new URL(value);
  if (parsed.hostname !== "127.0.0.1" || parsed.username || parsed.password) {
    throw new TypeError();
  }
  const expectedProtocol = target === "codex-chatgpt" ? "ws:" : "http:";
  const expectedPath = "/";
  const port = readExplicitLoopbackPort(value);
  if (
    parsed.protocol !== expectedProtocol ||
    parsed.pathname !== expectedPath ||
    parsed.search ||
    parsed.hash ||
    !Number.isInteger(port) ||
    port < 1 ||
    port > 65_535
  ) {
    throw new TypeError();
  }
  return value;
}

function validatePublicNgrokUrl(value) {
  if (typeof value !== "string" || value.length > 256) throw new TypeError();
  const parsed = new URL(value);
  if (
    parsed.protocol !== "https:" ||
    parsed.port ||
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash ||
    parsed.username ||
    parsed.password ||
    !/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u.test(parsed.hostname)
  ) {
    throw new TypeError();
  }
  return value;
}

function copyBooleanRecord(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError();
  return Object.fromEntries(keys.map((key) => {
    if (typeof value[key] !== "boolean") throw new TypeError();
    return [key, value[key]];
  }));
}

function copyEndpointSnapshot(target, snapshot) {
  if (
    !snapshot ||
    snapshot.target !== target ||
    snapshot.auth?.configured !== true ||
    snapshot.auth?.disclosure !== "rotate-only" ||
    snapshot.canRotateCredential !== true
  ) {
    throw new TypeError();
  }
  return {
    target,
    endpoint: validateLoopbackEndpoint(snapshot.endpoint, { target }),
    auth: { configured: true, disclosure: "rotate-only" },
    canRotateCredential: true,
  };
}

function copyStackSnapshot(snapshot) {
  if (
    snapshot?.target !== "local-n8n-stack" ||
    !ASSISTANT_MODES.has(snapshot.assistantMode) ||
    typeof snapshot.canResume !== "boolean" ||
    snapshot.canRemove !== true
  ) {
    throw new TypeError();
  }
  return {
    target: "local-n8n-stack",
    assistantMode: snapshot.assistantMode,
    endpoints: {
      n8nLocal: validateLoopbackEndpoint(snapshot.endpoints?.n8nLocal, {
        target: "codex-chat",
      }),
      ngrokPublic: validatePublicNgrokUrl(snapshot.endpoints?.ngrokPublic),
      ngrokInspector: validateLoopbackEndpoint(snapshot.endpoints?.ngrokInspector, {
        target: "codex-chat",
      }),
    },
    components: copyBooleanRecord(snapshot.components, [
      "n8n",
      "ngrok",
      "codeSandbox",
      "searxng",
    ]),
    canResume: snapshot.canResume,
    canRemove: true,
  };
}

function copySidecarSnapshot(snapshot) {
  if (
    snapshot?.target !== "n8n-openai-oauth" ||
    snapshot.endpoint !== "http://n8n-openai-oauth:10531/v1" ||
    snapshot.auth?.configured !== true ||
    snapshot.auth?.disclosure !== "server-managed" ||
    snapshot.canRefreshCredential !== true ||
    snapshot.canRemove !== true
  ) {
    throw new TypeError();
  }
  return {
    target: "n8n-openai-oauth",
    endpoint: "http://n8n-openai-oauth:10531/v1",
    auth: { configured: true, disclosure: "server-managed" },
    canRefreshCredential: true,
    canRemove: true,
  };
}

function copySuperGrokSnapshot(snapshot) {
  if (
    snapshot?.target !== "n8n-supergrok-oauth" ||
    snapshot.endpoint !== "http://n8n-supergrok:14502/v1" ||
    snapshot.auth?.configured !== true ||
    snapshot.auth?.disclosure !== "one-time" ||
    snapshot.canRemove !== true
  ) throw new TypeError();
  return {
    target: "n8n-supergrok-oauth",
    endpoint: "http://n8n-supergrok:14502/v1",
    auth: { configured: true, disclosure: "one-time" },
    canRemove: true,
  };
}

const MODEL_STATES = new Set(["missing", "downloading", "ready", "failed", "partial"]);
const MODEL_IDS = new Set(["qwen3:0.6b", "qwen3:1.7b", "qwen3.5:2b", "qwen3.5:4b", "qwen3.5:9b"]);

function copyModelSnapshot(snapshot) {
  if (
    snapshot?.target !== "n8n-local-model" ||
    snapshot.endpoint !== "http://n8n-local-model:11434/v1" ||
    !MODEL_STATES.has(snapshot.model?.state) ||
    !MODEL_IDS.has(snapshot.model?.id) ||
    typeof snapshot.canRetry !== "boolean" ||
    snapshot.canRetry !== ["missing", "failed"].includes(snapshot.model.state) ||
    snapshot.canRemove !== (snapshot.model.state !== "downloading") ||
    (snapshot.model.digest !== null && !/^[a-f0-9]{64}$/u.test(snapshot.model.digest)) ||
    (snapshot.model.state === "ready" && snapshot.model.digest === null)
  ) throw new TypeError();
  return {
    target: "n8n-local-model",
    endpoint: snapshot.endpoint,
    model: {
      state: snapshot.model.state,
      id: snapshot.model.id,
      digest: snapshot.model.digest,
    },
    canRetry: snapshot.canRetry,
    canRemove: snapshot.canRemove,
  };
}

function copyAssistantSnapshot(snapshot) {
  if (
    snapshot?.target !== "local-n8n-assistant" ||
    snapshot.auth?.sandboxConfigured !== true ||
    snapshot.auth?.disclosure !== "one-time" ||
    snapshot.canRemove !== true
  ) {
    throw new TypeError();
  }
  return {
    target: "local-n8n-assistant",
    components: copyBooleanRecord(snapshot.components, ["codeSandbox", "searxng"]),
    auth: { sandboxConfigured: true, disclosure: "one-time" },
    canRemove: true,
  };
}

function copySnapshot(definition, snapshot) {
  if (definition.kind === "endpoint") return copyEndpointSnapshot(definition.target, snapshot);
  if (definition.kind === "n8n-stack") return copyStackSnapshot(snapshot);
  if (definition.kind === "n8n-oauth-bridge") return copySidecarSnapshot(snapshot);
  if (definition.kind === "n8n-supergrok") return copySuperGrokSnapshot(snapshot);
  if (definition.kind === "n8n-local-model") return copyModelSnapshot(snapshot);
  return copyAssistantSnapshot(snapshot);
}

function actionsFor(definition, state, snapshot) {
  const actions = [];
  if (state === "stopped" && snapshot?.canResume === true) {
    actions.push("resume");
  }
  if (
    state === "healthy" &&
    definition.kind === "endpoint" &&
    snapshot?.canRotateCredential === true
  ) {
    if (["codex-chatgpt", "codex-chat"].includes(definition.target)) {
      actions.push("sign-in-chatgpt", "sign-out-chatgpt");
    } else if (definition.target === "xai-grok-build") {
      actions.push("sign-in-grok-build", "sign-out-grok-build");
    }
    actions.push("rotate-local-capability");
  }
  if (
    state === "healthy" &&
    definition.kind === "n8n-oauth-bridge" &&
    snapshot?.canRefreshCredential === true
  ) {
    actions.push("refresh-credential");
  }
  if (definition.kind === "n8n-local-model" && snapshot?.canRetry === true) {
    actions.push("retry-model");
  }
  if (definition.kind === "n8n-supergrok") {
    if (state === "healthy") actions.push("sign-in-grok-build", "sign-out-grok-build");
    if (snapshot?.canRemove === true) actions.push("remove-owned-supergrok");
  } else if (snapshot?.canRemove === true) actions.push("remove");
  return actions;
}

function providerRuntimeEntry(definition) {
  return {
    ...definition,
    readiness: "runtime-owned",
  };
}

function getProviderReadiness() {
  return PROVIDER_DEFINITIONS.map(providerRuntimeEntry);
}

function sanitizeService(definition, result) {
  if (!result || !STATES.has(result.state)) throw new TypeError();
  if (result.state === "absent") {
    return result.managed === false && result.snapshot == null
      ? absentService(definition)
      : unavailableService(definition);
  }
  if (result.state === "unavailable" || result.managed !== true) {
    return unavailableService(definition);
  }
  if (result.state === "partial" && result.snapshot == null) {
    return {
      ...definition,
      managed: true,
      state: "partial",
      snapshot: null,
      actions: [],
    };
  }
  const snapshot = copySnapshot(definition, result.snapshot);
  return {
    ...definition,
    managed: true,
    state: result.state,
    snapshot,
    actions: actionsFor(definition, result.state, snapshot),
  };
}

function sanitizeDocker(result) {
  if (result?.dockerAvailable !== true) {
    return { available: false, version: null, composeVersion: null };
  }
  const version = /^[A-Za-z0-9.+-]{1,64}$/u.test(result.dockerVersion ?? "")
    ? result.dockerVersion
    : null;
  const composeVersion = /^[A-Za-z0-9.+-]{1,64}$/u.test(result.composeVersion ?? "")
    ? result.composeVersion
    : null;
  if (!version || !composeVersion) {
    return { available: false, version: null, composeVersion: null };
  }
  return { available: true, version, composeVersion };
}

function dashboardModelStatus(result) {
  if (result?.status === "absent") return { managed: false, state: "absent", snapshot: null };
  if (result?.status === "unavailable") return { managed: false, state: "unavailable", snapshot: null };
  if (result?.status === "partial") {
    if (result.managed !== true || !MODEL_IDS.has(result.modelId) ||
      result.endpoint !== "http://n8n-local-model:11434/v1") throw new TypeError();
    return {
      managed: true, state: "partial",
      snapshot: {
        target: "n8n-local-model", endpoint: result.endpoint,
        model: { state: "partial", id: result.modelId, digest: null },
        canRetry: false, canRemove: true,
      },
    };
  }
  const modelStates = {
    "runtime-ready": "missing",
    downloading: "downloading",
    "model-ready": "ready",
    "model-error": "failed",
  };
  const modelState = modelStates[result?.status];
  if (
    result?.managed !== true || !modelState ||
    !MODEL_IDS.has(result.modelId) ||
    result.endpoint !== "http://n8n-local-model:11434/v1"
  ) throw new TypeError();
  return {
    managed: true,
    state: "healthy",
    snapshot: {
      target: "n8n-local-model",
      endpoint: result.endpoint,
      model: { state: modelState, id: result.modelId, digest: result.modelDigest ?? null },
      canRetry: ["missing", "failed"].includes(modelState),
      canRemove: modelState !== "downloading",
    },
  };
}

async function inspectService(definition, inspectors) {
  try {
    let result;
    if (definition.kind === "endpoint") {
      result = await inspectors.inspectLocalEndpoint({ target: definition.target });
    } else if (definition.kind === "n8n-stack") {
      result = await inspectors.inspectLocalN8nStack();
    } else if (definition.kind === "n8n-oauth-bridge") {
      result = await inspectors.inspectLocalN8nSidecar();
    } else if (definition.kind === "n8n-supergrok") {
      result = await inspectors.inspectLocalN8nSuperGrok();
    } else if (definition.kind === "n8n-local-model") {
      result = dashboardModelStatus(await inspectors.inspectLocalN8nModel());
    } else {
      result = await inspectors.inspectLocalN8nAssistant();
    }
    return sanitizeService(definition, result);
  } catch {
    return unavailableService(definition);
  }
}

const unavailableInspector = async () => ({ managed: false, state: "unavailable" });

export async function getLocalDashboardStatus({
  now = () => new Date(),
  getDockerStatus = getLocalDockerStatus,
  inspectLocalEndpoint = getManagedLocalEndpointStatus,
  inspectLocalN8nStack = unavailableInspector,
  inspectLocalN8nSidecar = getLocalN8nSidecarStatus,
  inspectLocalN8nAssistant = getLocalN8nAssistantStatus,
  inspectLocalN8nSuperGrok = getLocalN8nSuperGrokStatus,
  inspectLocalN8nModel = getLocalN8nModelStatus,
} = {}) {
  let generatedAt;
  try {
    generatedAt = now().toISOString();
  } catch {
    generatedAt = new Date(0).toISOString();
  }
  let docker;
  try {
    docker = sanitizeDocker(await getDockerStatus());
  } catch {
    docker = { available: false, version: null, composeVersion: null };
  }
  const inspectors = {
    inspectLocalEndpoint,
    inspectLocalN8nStack,
    inspectLocalN8nSidecar,
    inspectLocalN8nAssistant,
    inspectLocalN8nSuperGrok,
    inspectLocalN8nModel,
  };
  const [services, providers] = await Promise.all([
    Promise.all(
      SERVICE_DEFINITIONS.map((definition) => inspectService(definition, inspectors)),
    ),
    getProviderReadiness(),
  ]);
  return {
    schemaVersion: 1,
    generatedAt,
    docker,
    auth: { secretsRevealable: false },
    services,
    providers,
  };
}

import {
  getLocalDockerStatus,
  getManagedLocalEndpointStatus,
} from "./local-installer.js";
import { getLocalN8nAssistantStatus } from "./local-n8n-assistant-installer.js";
import { getLocalN8nSidecarStatus } from "./local-n8n-sidecar-installer.js";

const SERVICE_DEFINITIONS = Object.freeze([
  Object.freeze({ target: "openai-api", label: "OpenAI API", kind: "endpoint" }),
  Object.freeze({
    target: "codex-chatgpt",
    label: "Codex (ChatGPT login)",
    kind: "endpoint",
  }),
  Object.freeze({ target: "codex-chat", label: "Codex Chat adapter", kind: "endpoint" }),
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
]);
const STATES = new Set(["absent", "healthy", "stopped", "partial", "unavailable"]);
const ASSISTANT_MODES = new Set(["disabled", "sandbox", "sandbox-with-searxng"]);

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
  const expectedPath = target === "openai-api" ? "/v1" : "/";
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
      actions.push("sign-in");
    }
    actions.push("rotate-credential");
  }
  if (
    state === "healthy" &&
    definition.kind === "n8n-oauth-bridge" &&
    snapshot?.canRefreshCredential === true
  ) {
    actions.push("refresh-credential");
  }
  if (snapshot?.canRemove === true) actions.push("remove");
  return actions;
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

async function inspectService(definition, inspectors) {
  try {
    let result;
    if (definition.kind === "endpoint") {
      result = await inspectors.inspectLocalEndpoint({ target: definition.target });
    } else if (definition.kind === "n8n-stack") {
      result = await inspectors.inspectLocalN8nStack();
    } else if (definition.kind === "n8n-oauth-bridge") {
      result = await inspectors.inspectLocalN8nSidecar();
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
  };
  return {
    schemaVersion: 1,
    generatedAt,
    docker,
    auth: { secretsRevealable: false },
    services: await Promise.all(
      SERVICE_DEFINITIONS.map((definition) => inspectService(definition, inspectors)),
    ),
  };
}

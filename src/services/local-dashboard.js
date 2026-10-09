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
    label: "Codex (ChatGPT plan)",
    kind: "endpoint",
  }),
  Object.freeze({ target: "codex-chat", label: "Codex Chat adapter", kind: "endpoint" }),
  Object.freeze({ target: "xai-grok-build", label: "SuperGrok", kind: "endpoint" }),
  Object.freeze({ target: "local-n8n-stack", label: "Local n8n stack", kind: "n8n-stack" }),
  Object.freeze({
    target: "n8n-openai-oauth",
    label: "ChatGPT plan sidecar",
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
const STATES = new Set(["absent", "healthy", "stopped", "staged", "partial", "legacy", "unavailable"]);
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

const SIWC_SESSIONS = new Set(["signed-out", "connected", "reauthorize"]);
const SIWC_OWNERSHIP = new Set(["owned", "handoff-pending", "transferred"]);

export function copySiwcAccountView(account) {
  if (!account || typeof account !== "object" || Array.isArray(account) ||
      typeof account.registrationId !== "string" ||
      !/^[A-Za-z0-9_-]{8,128}$/u.test(account.registrationId) ||
      typeof account.label !== "string" || account.label.length > 160 ||
      /[\u0000-\u001f\u007f]/u.test(account.label) ||
      (account.email !== undefined && (typeof account.email !== "string" ||
        account.email.length > 254 || /[\u0000-\u001f\u007f]/u.test(account.email))) ||
      account.identity !== "verified" || !SIWC_SESSIONS.has(account.session) ||
      !["granted", "not-granted"].includes(account.planPermission) ||
      typeof account.planEnabled !== "boolean" ||
      !SIWC_OWNERSHIP.has(account.ownership) ||
      typeof account.generation !== "string" || !/^[A-Za-z0-9_-]{8,128}$/u.test(account.generation) ||
      typeof account.needsPlanWelcome !== "boolean" ||
      typeof account.ownerHostId !== "string" ||
      !/^urn:uuid:[a-f0-9-]{36}$/iu.test(account.ownerHostId) ||
      typeof account.ownerRuntimeId !== "string" ||
      !/^[A-Za-z0-9_-]{1,128}$/u.test(account.ownerRuntimeId)) throw new TypeError();
  return {
    registrationId: account.registrationId, label: account.label,
    ...(account.email !== undefined ? { email: account.email } : {}),
    identity: "verified", session: account.session, planPermission: account.planPermission,
    planEnabled: account.planEnabled, ownership: account.ownership,
    generation: account.generation, ownerHostId: account.ownerHostId,
    ownerRuntimeId: account.ownerRuntimeId, needsPlanWelcome: account.needsPlanWelcome,
  };
}

export function copySiwcStaging(value) {
  if (!value || !/^[A-Za-z0-9_-]{8,128}$/u.test(value.installId ?? "") ||
      !/^[A-Za-z0-9_-]{8,128}$/u.test(value.registrationId ?? "") ||
      !/^[a-z][a-z0-9-]{0,63}$/u.test(value.stage ?? "")) throw new TypeError("The staged installation is invalid.");
  return { installId: value.installId, registrationId: value.registrationId, stage: value.stage };
}

function copyInstalledSiwc(snapshot) {
  if (typeof snapshot.migrationRequired !== "boolean" ||
      typeof snapshot.auth?.configured !== "boolean") throw new TypeError();
  if (snapshot.migrationState !== undefined &&
      (snapshot.migrationRequired !== true ||
        !["incomplete", "prepared", "stopped"].includes(snapshot.migrationState) ||
        snapshot.legacyResourcesPreserved !== true)) throw new TypeError();
  const migration = snapshot.migrationState
    ? { migrationState: snapshot.migrationState, legacyResourcesPreserved: true } : {};
  if (snapshot.migrationRequired) {
    if (snapshot.registrationId !== undefined || snapshot.auth.account !== undefined ||
        snapshot.auth.configured) throw new TypeError();
    return { migrationRequired: true, ...migration, auth: { configured: false } };
  }
  if (!/^[A-Za-z0-9_-]{8,128}$/u.test(snapshot.registrationId ?? "")) throw new TypeError();
  const account = snapshot.auth.account === undefined ? null : copySiwcAccountView(snapshot.auth.account);
  if (account && account.registrationId !== snapshot.registrationId) throw new TypeError();
  const active = account?.ownership === "owned" && account.session === "connected" &&
    account.planPermission === "granted" && account.planEnabled === true;
  if (snapshot.auth.configured !== active) throw new TypeError();
  return {
    registrationId: snapshot.registrationId, migrationRequired: false, ...migration,
    auth: { configured: active, ...(account ? { account } : {}) },
  };
}

function copyEndpointSnapshot(target, snapshot) {
  if (!snapshot || snapshot.target !== target ||
      snapshot.auth?.disclosure !== "rotate-only" ||
      snapshot.canRotateCredential !== (snapshot.migrationRequired !== true)) throw new TypeError();
  const chatgpt = target === "codex-chatgpt" || target === "codex-chat";
  const siwc = chatgpt ? copyInstalledSiwc(snapshot) : null;
  if (!chatgpt && snapshot.auth.configured !== true) throw new TypeError();
  return {
    target,
    endpoint: validateLoopbackEndpoint(snapshot.endpoint, { target }),
    auth: { configured: chatgpt ? siwc.auth.configured : true, disclosure: "rotate-only",
      ...(siwc?.auth.account ? { account: siwc.auth.account } : {}) },
    ...(siwc ? { registrationId: siwc.registrationId, migrationRequired: siwc.migrationRequired,
      ...(siwc.migrationState ? { migrationState: siwc.migrationState, legacyResourcesPreserved: true } : {}) } : {}),
    canRotateCredential: snapshot.canRotateCredential,
  };
}

function copyStackSnapshot(snapshot) {
  if (
    snapshot?.target !== "local-n8n-stack" ||
    !["none", "ngrok"].includes(snapshot.publicAccess) ||
    !ASSISTANT_MODES.has(snapshot.assistantMode) ||
    typeof snapshot.canResume !== "boolean" ||
    snapshot.canRemove !== true ||
    !/^relmio-local-n8n-[a-f0-9]{32}-n8n-1$/u.test(snapshot.n8nContainerName) ||
    snapshot.networkName !== `${snapshot.n8nContainerName.slice(0, -6)}_edge` ||
    !/^http:\/\/localhost:(?:[1-9][0-9]{0,4})$/u.test(snapshot.localUrl) ||
    snapshot.endpoints?.n8nLocal !== snapshot.localUrl ||
    snapshot.endpoints?.ngrokPublic !== snapshot.ngrokPublicUrl ||
    snapshot.components?.ngrok !== (snapshot.publicAccess === "ngrok") ||
    (snapshot.publicAccess === "none" && (snapshot.ngrokPublicUrl !== null || snapshot.endpoints?.ngrokInspector !== null))
  ) throw new TypeError();
  const publicUrl = snapshot.publicAccess === "ngrok"
    ? validatePublicNgrokUrl(snapshot.ngrokPublicUrl) : null;
  return {
    target: "local-n8n-stack",
    publicAccess: snapshot.publicAccess,
    localUrl: snapshot.localUrl,
    ngrokPublicUrl: publicUrl,
    n8nContainerName: snapshot.n8nContainerName,
    networkName: snapshot.networkName,
    assistantMode: snapshot.assistantMode,
    endpoints: {
      n8nLocal: snapshot.localUrl,
      ngrokPublic: publicUrl,
      ngrokInspector: snapshot.publicAccess === "ngrok"
        ? validateLoopbackEndpoint(snapshot.endpoints.ngrokInspector, { target: "codex-chat" }) : null,
    },
    components: copyBooleanRecord(snapshot.components, [
      "n8n", "ngrok", "codeSandbox", "searxng",
    ]),
    canResume: snapshot.canResume,
    canRemove: true,
  };
}

function copySidecarSnapshot(snapshot) {
  if (snapshot?.target !== "n8n-openai-oauth" ||
      snapshot.endpoint !== "http://n8n-openai-oauth:10531/v1" ||
      snapshot.auth?.disclosure !== "server-managed" ||
      snapshot.canRefreshCredential !== false ||
      snapshot.canRemove !== true) throw new TypeError();
  const siwc = copyInstalledSiwc(snapshot);
  return {
    target: "n8n-openai-oauth",
    endpoint: snapshot.endpoint,
    auth: { configured: siwc.auth.configured, disclosure: "server-managed",
      ...(siwc.auth.account ? { account: siwc.auth.account } : {}) },
    registrationId: siwc.registrationId,
    migrationRequired: siwc.migrationRequired,
    ...(siwc.migrationState ? { migrationState: siwc.migrationState, legacyResourcesPreserved: true } : {}),
    canRefreshCredential: false,
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
  if (state === "legacy") return snapshot?.migrationRequired === true ? ["setup"] : [];
  if (state === "partial" && snapshot?.migrationState) return [];
  if (state === "stopped" && snapshot?.registrationId &&
      (["codex-chatgpt", "codex-chat"].includes(definition.target) ||
        definition.kind === "n8n-oauth-bridge")) actions.push("inspect-stopped-chatgpt");
  if (state === "stopped" && snapshot?.canResume === true) {
    actions.push("resume");
  }
  if (
    state === "healthy" &&
    definition.kind === "endpoint" &&
    snapshot?.canRotateCredential === true
  ) {
    if (["codex-chatgpt", "codex-chat"].includes(definition.target)) {
      actions.push("setup");
      if (snapshot.auth.account?.ownership === "owned") {
        actions.push("sign-out-chatgpt");
        if (snapshot.auth.account.planEnabled) actions.push("disable-chatgpt-plan");
      }
    } else if (definition.target === "xai-grok-build") {
      actions.push("sign-in-grok-build", "sign-out-grok-build");
    }
    actions.push("rotate-local-capability");
  }
  if (definition.kind === "n8n-oauth-bridge" && state === "healthy") {
    actions.push("setup");
    if (snapshot.auth.account?.ownership === "owned") {
      actions.push("sign-out-chatgpt");
      if (snapshot.auth.account.planEnabled) actions.push("disable-chatgpt-plan");
    }
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
  if (result.state === "staged") {
    if (!["codex-chatgpt", "codex-chat", "n8n-openai-oauth"].includes(definition.target)) throw new TypeError();
    return { ...definition, managed: true, state: "staged", snapshot: null,
      staging: copySiwcStaging(result.staging), actions: ["setup"] };
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

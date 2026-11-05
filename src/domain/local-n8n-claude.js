import { validateLocalDockerHost } from "../infrastructure/local-process.js";
import { validateDockerName } from "./validation.js";
import { validateDockerObjectId } from "./local-n8n-sidecar.js";
import { validModels, MODEL_RULES } from "../claude/launcher.js";
import { reviewClaudeCompanion } from "../claude/companion.js";

export const LOCAL_N8N_CLAUDE_TARGET = "n8n-claude-oauth";
export const LOCAL_N8N_CLAUDE_ENDPOINT = "http://relmio-claude:14502/v1";
export const DEFAULT_LOCAL_CLAUDE_MODELS = Object.freeze(["claude-haiku-5-5", "claude-sonnet-5-5", "claude-opus-5-5"]);
export const CLAUDE_REVIEW_FIELDS = Object.freeze([
  "officialBinaryReviewed", "effectivePolicyReviewed", "nativeAuthAndBillingReviewed", "policyChangesControlled",
]);

export function validateClaudeReview(review) {
  if (!review || typeof review !== "object" || Array.isArray(review) ||
      Object.keys(review).length !== CLAUDE_REVIEW_FIELDS.length ||
      CLAUDE_REVIEW_FIELDS.some((key) => review[key] !== true)) {
    throw new TypeError("Confirm all four Claude review questions.");
  }
  return Object.fromEntries(CLAUDE_REVIEW_FIELDS.map((key) => [key, true]));
}

export function createLocalN8nClaudePlan({ dockerHost, n8nContainerId, n8nContainerName, dockerNetworkId, networkName, models = [...DEFAULT_LOCAL_CLAUDE_MODELS], arch }) {
  if (!validModels(models)) throw new TypeError(MODEL_RULES);
  if (!["amd64", "arm64"].includes(arch)) throw new TypeError("The local Claude architecture is unsupported.");
  const { version, executableSha256 } = reviewClaudeCompanion({ network: networkName, arch, models });
  return {
    kind: "n8n-claude", target: LOCAL_N8N_CLAUDE_TARGET, label: "Claude for n8n",
    endpoint: LOCAL_N8N_CLAUDE_ENDPOINT, baseUrl: LOCAL_N8N_CLAUDE_ENDPOINT,
    protocol: "openai-chat-completions", upstreamAuth: "provider-owned-oauth",
    dockerHost: validateLocalDockerHost(dockerHost),
    n8nContainerId: validateDockerObjectId(n8nContainerId, "n8n container"),
    n8nContainerName: validateDockerName(n8nContainerName),
    dockerNetworkId: validateDockerObjectId(dockerNetworkId, "Docker network"),
    networkName: validateDockerName(networkName), models: [...models], arch,
    version, executableSha256,
    managedPath: "~/.relmio/local/n8n-claude-oauth", hostPublication: "none", experimental: true,
  };
}

export function normalizeLocalN8nClaudePlan(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError("The private Claude plan is invalid.");
  const normalized = createLocalN8nClaudePlan(value);
  if (Object.keys(value).some((key) => !Object.hasOwn(normalized, key) && key !== "disposableHarnessWarning") ||
      (Object.hasOwn(value, "disposableHarnessWarning") && typeof value.disposableHarnessWarning !== "boolean") ||
      Object.entries(normalized).some(([key, expected]) => key === "models"
        ? JSON.stringify(value.models) !== JSON.stringify(expected) : value[key] !== expected)) {
    throw new TypeError("The private Claude plan is invalid.");
  }
  return normalized;
}

export function createSafeLocalN8nClaudePlan(plan) {
  const normalized = normalizeLocalN8nClaudePlan(plan);
  const { dockerHost: _dockerHost, ...safe } = normalized;
  return { ...safe, disposableHarnessWarning: plan.disposableHarnessWarning === true };
}

function validExpiry(value) {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) &&
    new Date(Date.parse(value)).toISOString() === value;
}

export function createSafeLocalN8nClaudeInstallResult(result, plan) {
  if (result?.target !== LOCAL_N8N_CLAUDE_TARGET || result.endpoint !== LOCAL_N8N_CLAUDE_ENDPOINT ||
      result.baseUrl !== result.endpoint || result.protocol !== "openai-chat-completions" ||
      result.networkName !== plan.networkName || result.n8nContainerName !== plan.n8nContainerName ||
      result.hostPublication !== "none" || !/^[A-Za-z0-9_-]{32,256}$/u.test(result.clientKey ?? "") ||
      result.credentialShownOnce !== true || result.deploymentMode !== "installed" ||
      !validExpiry(result.expiresAt) || JSON.stringify(result.models) !== JSON.stringify(plan.models)) {
    throw new TypeError("The local Claude install result is invalid.");
  }
  return {
    target: LOCAL_N8N_CLAUDE_TARGET, endpoint: LOCAL_N8N_CLAUDE_ENDPOINT,
    baseUrl: LOCAL_N8N_CLAUDE_ENDPOINT, protocol: "openai-chat-completions",
    networkName: validateDockerName(result.networkName), n8nContainerName: validateDockerName(result.n8nContainerName),
    hostPublication: "none", clientCredential: result.clientKey, credentialShownOnce: true,
    deploymentMode: "installed", models: [...result.models], expiresAt: result.expiresAt,
  };
}

export function createSafeLocalN8nClaudeSnapshot(snapshot) {
  if (snapshot?.target !== LOCAL_N8N_CLAUDE_TARGET || snapshot.endpoint !== LOCAL_N8N_CLAUDE_ENDPOINT ||
      snapshot.auth?.configured !== true || snapshot.auth.disclosure !== "one-time" ||
      snapshot.canRemove !== true || !validModels(snapshot.models) || !validExpiry(snapshot.expiresAt) ||
      typeof snapshot.approvalExpired !== "boolean") throw new TypeError("The local Claude snapshot is invalid.");
  return {
    target: LOCAL_N8N_CLAUDE_TARGET, endpoint: LOCAL_N8N_CLAUDE_ENDPOINT,
    auth: { configured: true, disclosure: "one-time" }, canRemove: true,
    models: [...snapshot.models], expiresAt: snapshot.expiresAt, approvalExpired: snapshot.approvalExpired,
  };
}

export function createSafeLocalN8nClaudeStatus(result) {
  if (result?.target !== LOCAL_N8N_CLAUDE_TARGET || typeof result.managed !== "boolean" ||
      !["absent", "healthy", "partial", "unavailable"].includes(result.state) ||
      result.managed !== ["healthy", "partial"].includes(result.state)) throw new TypeError("The local Claude status is invalid.");
  return {
    target: LOCAL_N8N_CLAUDE_TARGET, managed: result.managed, state: result.state,
    snapshot: result.managed ? createSafeLocalN8nClaudeSnapshot(result.snapshot) : null,
  };
}

export function createSafeLocalN8nClaudeChangeResult(result, action) {
  if (result?.target !== LOCAL_N8N_CLAUDE_TARGET ||
      (action === "remove" ? result.removed !== true : result.changed !== true) ||
      (action === "renew" && !validExpiry(result.expiresAt))) throw new TypeError("The local Claude action result is invalid.");
  return { target: LOCAL_N8N_CLAUDE_TARGET, ...(action === "remove" ? { removed: true } : { changed: true }),
    ...(action === "renew" ? { expiresAt: result.expiresAt } : {}) };
}

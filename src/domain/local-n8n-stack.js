import { validateLocalDockerHost } from "../infrastructure/local-process.js";
import { isIP } from "node:net";
import { validateHostname, validatePort } from "./validation.js";

export const LOCAL_N8N_STACK_TARGET = "local-n8n-stack";
export const LOCAL_N8N_STACK_PUBLIC_CONFIRMATION =
  "EXPOSE_LOCAL_N8N_VIA_NGROK";
export const LOCAL_N8N_STACK_REMOVE_CONFIRMATION =
  "REMOVE_LOCAL_N8N_STACK";
export const LOCAL_N8N_STACK_MANAGED_PATH = "~/.relmio/local/n8n-stack";

export const LOCAL_N8N_ASSISTANT_MODES = Object.freeze([
  "disabled",
  "sandbox",
  "sandbox-with-searxng",
]);

const RESERVED_PORT = 10_531;
const RESERVED_HOST_SUFFIXES = new Set([
  "example",
  "internal",
  "invalid",
  "lan",
  "local",
  "localhost",
  "test",
]);
const INSTALL_ID_PATTERN = /^[a-f0-9]{32}$/u;
const PROJECT_NAME_PATTERN = /^relmio-local-n8n-[a-f0-9]{32}$/u;

function hasExactKeys(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

export function validateNgrokHostname(value) {
  const hostname = validateHostname(value);
  if (
    hostname.includes(":") ||
    isIP(hostname) !== 0 ||
    hostname.split(".").length < 2 ||
    RESERVED_HOST_SUFFIXES.has(hostname.split(".").at(-1))
  ) {
    throw new TypeError("The reserved ngrok hostname is invalid.");
  }
  return hostname;
}

export function validateAssistantMode(value) {
  if (typeof value !== "string" || !LOCAL_N8N_ASSISTANT_MODES.includes(value)) {
    throw new TypeError(
      "Assistant mode must be disabled, sandbox, or sandbox-with-searxng.",
    );
  }
  return value;
}

export function validateTimezone(value) {
  if (typeof value !== "string" || value.length < 1 || value.length > 128) {
    throw new TypeError("Timezone is invalid.");
  }
  try {
    const timezone = new Intl.DateTimeFormat("en-US", { timeZone: value })
      .resolvedOptions().timeZone;
    if (timezone !== value) throw new Error("non-canonical");
  } catch {
    throw new TypeError("Timezone is invalid.");
  }
  return value;
}

export function createLocalN8nStackPlan({
  dockerHost,
  ngrokHostname,
  n8nPort,
  ngrokInspectorPort,
  timezone,
  assistantMode,
}) {
  const localPort = validatePort(n8nPort);
  const inspectorPort = validatePort(ngrokInspectorPort);
  if (
    localPort === inspectorPort ||
    localPort === RESERVED_PORT ||
    inspectorPort === RESERVED_PORT
  ) {
    throw new TypeError("Local n8n and ngrok inspector ports must be distinct and cannot use 10531.");
  }
  const hostname = validateNgrokHostname(ngrokHostname);
  const mode = validateAssistantMode(assistantMode);
  return Object.freeze({
    kind: "local-n8n-stack",
    target: LOCAL_N8N_STACK_TARGET,
    label: "Disposable self-hosted n8n + ngrok",
    dockerHost: validateLocalDockerHost(dockerHost),
    ngrokHostname: hostname,
    n8nPort: localPort,
    ngrokInspectorPort: inspectorPort,
    timezone: validateTimezone(timezone),
    assistantMode: mode,
    localUrl: `http://127.0.0.1:${localPort}`,
    ngrokPublicUrl: `https://${hostname}`,
    hostPublication: "loopback-only",
    deploymentMode: "new-disposable-stack",
    managedPath: LOCAL_N8N_STACK_MANAGED_PATH,
  });
}

export function normalizeLocalN8nStackPlan(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("The local n8n stack plan is invalid.");
  }
  const normalized = createLocalN8nStackPlan(value);
  if (!hasExactKeys(value, Object.keys(normalized))) {
    throw new TypeError("The local n8n stack plan is invalid.");
  }
  for (const [name, expected] of Object.entries(normalized)) {
    if (value[name] !== expected) {
      throw new TypeError("The local n8n stack plan is invalid.");
    }
  }
  return normalized;
}

function createInstallId(randomBytes) {
  const value = randomBytes(16);
  if (!Buffer.isBuffer(value) || value.length !== 16) {
    throw new TypeError("A cryptographic local n8n installation generator is required.");
  }
  return value.toString("hex");
}

export function validateLocalN8nStackMarker(value) {
  const keys = [
    "schemaVersion",
    "kind",
    "target",
    "installId",
    "projectName",
    "dockerHost",
    "ngrokHostname",
    "n8nPort",
    "ngrokInspectorPort",
    "timezone",
    "assistantMode",
  ];
  if (
    !hasExactKeys(value, keys) ||
    value.schemaVersion !== 1 ||
    value.kind !== "relmio-local-n8n-stack" ||
    value.target !== LOCAL_N8N_STACK_TARGET ||
    typeof value.installId !== "string" ||
    !INSTALL_ID_PATTERN.test(value.installId) ||
    typeof value.projectName !== "string" ||
    !PROJECT_NAME_PATTERN.test(value.projectName) ||
    value.projectName.slice(-32) !== value.installId
  ) {
    throw new TypeError("The local n8n stack ownership marker is invalid.");
  }
  const plan = createLocalN8nStackPlan({
    dockerHost: value.dockerHost,
    ngrokHostname: value.ngrokHostname,
    n8nPort: value.n8nPort,
    ngrokInspectorPort: value.ngrokInspectorPort,
    timezone: value.timezone,
    assistantMode: value.assistantMode,
  });
  return Object.freeze({
    schemaVersion: 1,
    kind: "relmio-local-n8n-stack",
    target: LOCAL_N8N_STACK_TARGET,
    installId: value.installId,
    projectName: value.projectName,
    dockerHost: plan.dockerHost,
    ngrokHostname: plan.ngrokHostname,
    n8nPort: plan.n8nPort,
    ngrokInspectorPort: plan.ngrokInspectorPort,
    timezone: plan.timezone,
    assistantMode: plan.assistantMode,
  });
}

export function createLocalN8nStackInstallation({ plan, randomBytes }) {
  const safePlan = normalizeLocalN8nStackPlan(plan);
  if (typeof randomBytes !== "function") {
    throw new TypeError("A cryptographic local n8n installation generator is required.");
  }
  const installId = createInstallId(randomBytes);
  const marker = validateLocalN8nStackMarker({
    schemaVersion: 1,
    kind: "relmio-local-n8n-stack",
    target: LOCAL_N8N_STACK_TARGET,
    installId,
    projectName: `relmio-local-n8n-${installId}`,
    dockerHost: safePlan.dockerHost,
    ngrokHostname: safePlan.ngrokHostname,
    n8nPort: safePlan.n8nPort,
    ngrokInspectorPort: safePlan.ngrokInspectorPort,
    timezone: safePlan.timezone,
    assistantMode: safePlan.assistantMode,
  });
  return Object.freeze({ ...marker, marker });
}

export function getLocalN8nStackLabels(installation) {
  const marker = validateLocalN8nStackMarker(installation?.marker ?? installation);
  return Object.freeze({
    "io.relmio.managed": "true",
    "io.relmio.target": LOCAL_N8N_STACK_TARGET,
    "io.relmio.install": marker.installId,
    "io.relmio.project": marker.projectName,
  });
}

export function getLocalN8nStackServiceNames(installation) {
  const marker = validateLocalN8nStackMarker(installation?.marker ?? installation);
  return Object.freeze([
    "n8n",
    "ngrok",
    ...(marker.assistantMode === "disabled"
      ? []
      : ["relmio-sandbox-certs", "relmio-sandbox-api", "relmio-sandbox-runner-1"]),
    ...(marker.assistantMode === "sandbox-with-searxng" ? ["relmio-searxng"] : []),
  ]);
}

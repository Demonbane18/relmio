import { validateLocalDockerHost } from "../infrastructure/local-process.js";
import { validateAssistantSearxngSelection } from "./assistant.js";
import { validateDockerObjectId } from "./local-n8n-sidecar.js";
import { validateDockerName } from "./validation.js";

export const LOCAL_N8N_ASSISTANT_TARGET = "n8n-ai-assistant";

export function createLocalN8nAssistantPlan({
  dockerHost,
  n8nContainerId,
  n8nContainerName,
  dockerNetworkId,
  networkName,
  includeSearxng,
}) {
  return {
    kind: "n8n-assistant",
    target: LOCAL_N8N_ASSISTANT_TARGET,
    label: "n8n AI Assistant tools",
    protocol: "n8n-instance-ai-companion",
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
    includeSearxng: validateAssistantSearxngSelection(includeSearxng),
    codeSandbox: true,
    privilegedRunner: true,
    hostPublication: "none",
    managedPath: "~/.relmio/local/n8n-ai-assistant",
    n8nConfigurationRequired: true,
  };
}

export function normalizeLocalN8nAssistantPlan(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("The local n8n Assistant plan is invalid.");
  }
  const normalized = createLocalN8nAssistantPlan({
    dockerHost: value.dockerHost,
    n8nContainerId: value.n8nContainerId,
    n8nContainerName: value.n8nContainerName,
    dockerNetworkId: value.dockerNetworkId,
    networkName: value.networkName,
    includeSearxng: value.includeSearxng,
  });
  for (const [name, expected] of Object.entries(normalized)) {
    if (value[name] !== expected) {
      throw new TypeError("The local n8n Assistant plan is invalid.");
    }
  }
  return normalized;
}

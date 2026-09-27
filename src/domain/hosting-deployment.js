import { getLocalModelDefinition } from "../local-model/catalog.mjs";
import { getHostingProvider } from "./hosting-providers.js";
import { PLATFORM_HOSTING_PROFILES } from "./hosting-platform-profiles.js";
import { SCHEDULER_HOSTING_PROFILES } from "./hosting-scheduler-profiles.js";
import { CLOUD_HOSTING_PROFILES } from "./hosting-cloud-profiles.js";
import { EDGE_HOSTING_PROFILES } from "./hosting-edge-profiles.js";

const profiles = [...PLATFORM_HOSTING_PROFILES, ...SCHEDULER_HOSTING_PROFILES, ...CLOUD_HOSTING_PROFILES, ...EDGE_HOSTING_PROFILES];
const deploymentIdPattern = /^[a-f0-9]{12}$/u;
const pathSegment = /^(?:[a-zA-Z0-9][a-zA-Z0-9._-]*|\.dockerignore)$/u;
const documentationSources = {
  model: [{ label: "Ollama pull API", url: "https://docs.ollama.com/api/pull" }],
  searxng: [{ label: "SearXNG JSON search API", url: "https://docs.searxng.org/dev/search_api.html" }],
  assistant: [{ label: "Self-hosted n8n Assistant and Daytona", url: "https://docs.n8n.io/deploy/host-n8n/configure-n8n/set-up-n8n-assistant/" }],
  endpoint: [],
};

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function exactOwnDataKeys(value, allowed, required = allowed) {
  if (!plainObject(value)) return false;
  const keys = Object.keys(value);
  return keys.every(key => allowed.includes(key) && Object.hasOwn(value, key) && Object.getOwnPropertyDescriptor(value, key)?.get === undefined && Object.getOwnPropertyDescriptor(value, key)?.set === undefined) &&
    required.every(key => Object.hasOwn(value, key));
}

function normalizedInputs(value, fields) {
  const allowed = fields.map(field => field.name);
  if (!exactOwnDataKeys(value, allowed, fields.filter(field => field.required).map(field => field.name))) {
    throw new TypeError("Deployment fields must match the selected profile exactly.");
  }
  const normalized = {};
  for (const field of fields) {
    if (!Object.hasOwn(value, field.name)) continue;
    const input = value[field.name];
    if (field.type === "number") {
      if (!Number.isSafeInteger(input) || (field.min !== undefined && input < field.min) ||
          (field.max !== undefined && input > field.max)) throw new TypeError("A deployment number is outside its allowed range.");
    } else if (field.type === "text") {
      if (typeof input !== "string" || input.length === 0 || input.length > 512 ||
          !field.pattern || !new RegExp(field.pattern, "u").test(input) || /[\u0000-\u001f\u007f]/u.test(input)) {
        throw new TypeError("A deployment text field is invalid.");
      }
    } else if (field.type !== "select") {
      throw new TypeError("The selected deployment profile is invalid.");
    }
    if (field.type === "select" && !field.options.some(option => option.value === input)) {
      throw new TypeError("A deployment choice is not available.");
    }
    normalized[field.name] = input;
  }
  return normalized;
}

function validFile(file) {
  return exactOwnDataKeys(file, ["name", "content", "mediaType"]) &&
    typeof file.name === "string" && file.name.length <= 128 && file.name.split("/").every(segment => pathSegment.test(segment) && segment !== "." && segment !== "..") &&
    typeof file.content === "string" && file.content.length > 0 && typeof file.mediaType === "string" &&
    /^[a-z]+\/[a-z0-9.+-]+$/u.test(file.mediaType);
}

function validateRenderedBundle(bundle) {
  if (!plainObject(bundle) || !Array.isArray(bundle.files) || !Array.isArray(bundle.settings) ||
      !Array.isArray(bundle.steps) || !Array.isArray(bundle.requirements) || !Array.isArray(bundle.limitations) ||
      !plainObject(bundle.connection) || bundle.steps.length === 0 ||
      !bundle.files.every(validFile) || new Set(bundle.files.map(file => file.name)).size !== bundle.files.length ||
      bundle.files.some(file => file.name === "INSTRUCTIONS.md") ||
      !bundle.settings.every(row => exactOwnDataKeys(row, ["name", "value"]) && typeof row.name === "string" && typeof row.value === "string") ||
      ![bundle.steps, bundle.requirements, bundle.limitations].every(items => items.every(item => typeof item === "string" && item.length > 0))) {
    throw new TypeError("The deployment profile returned an incomplete plan.");
  }
}

function instructionDocument({ provider, component, resourceName, files, settings, steps, connection, requirements, limitations, sources }) {
  const list = items => items.length ? items.map(item => `- ${item}`).join("\n") : "- None.";
  const settingsList = settings.map(({ name, value }) => `- ${name}: ${value}`);
  const connectionList = Object.entries(connection).map(([name, value]) => `- ${name}: ${typeof value === "string" ? value : JSON.stringify(value)}`);
  return `# ${provider.label}: ${component} handoff

Resource name: ${resourceName}
Status: local artifacts only; remote runtime NOT-RUN. Operator-owned manual deployment, not a managed host install.

## Before any operator action

Review the exact new resource name and all proposed files/settings against your account to avoid adopting or replacing an existing resource. Check current cost, privileges, network access and approval. This generator has not connected to a provider, executed a command, written a remote file, changed n8n, or deployed anything.

## Requirements

${list(requirements)}

## Downloaded files

${list(files.map(file => file.name))}

Keep these files together in their relative paths. Only a reviewed operator deploys them; INSTRUCTIONS.md is this guide, not a provider configuration file. If there is no provider file, the exact dashboard/operator procedure below is the deployment handoff.

## Nonsecret settings

${list(settingsList)}

Create any named runtime secret in the provider's secret store using an independently generated or account-owned value. Secret values are never in this bundle. Do not paste secrets into source, command histories, shared plans, or downloads.

## Connection after operator deployment

${list(connectionList)}

## Operator procedure and meaningful verification

${steps.map((step, index) => `${index + 1}. ${step}`).join("\n")}

## Limits and unverified runtime

${list(limitations)}

## Reviewed sources

${list(sources.map(source => `[${source.label}](${source.url})`))}
`;
}

export function getHostingDeploymentProfiles() {
  return profiles.map(({ providerId, component, fields }) => ({
    providerId, component,
    fields: fields.map(field => ({ ...field, ...(field.options ? { options: field.options.map(option => ({ ...option })) } : {}) })),
  }));
}

export function createHostingDeploymentPlan(request) {
  if (!exactOwnDataKeys(request, ["providerId", "component", "deploymentId", "modelId", "inputs"], ["providerId", "component", "deploymentId", "inputs"]) ||
      typeof request.providerId !== "string" || typeof request.component !== "string" ||
      typeof request.deploymentId !== "string" || !deploymentIdPattern.test(request.deploymentId) ||
      !["model", "searxng", "assistant", "endpoint"].includes(request.component) ||
      Object.hasOwn(request, "modelId") !== (request.component === "model")) {
    throw new TypeError("Invalid deployment request.");
  }
  const provider = getHostingProvider(request.providerId);
  const profile = profiles.find(item => item.providerId === request.providerId && item.component === request.component);
  if (!profile) throw new RangeError("No manual deployment profile exists for this provider and component.");
  const model = request.component === "model" ? getLocalModelDefinition(request.modelId) : null;
  const inputs = normalizedInputs(request.inputs, profile.fields);
  const resourceName = `relmio-${request.component}-${request.deploymentId}`;
  const context = { providerId: provider.id, component: request.component, deploymentId: request.deploymentId, resourceName, model, inputs };
  let rendered;
  try {
    rendered = profile.render(context);
  } catch {
    throw new TypeError("The selected deployment fields cannot be combined safely.");
  }
  validateRenderedBundle(rendered);
  const sources = [...provider.sources, ...documentationSources[request.component]];
  const guide = instructionDocument({ provider, component: request.component, resourceName, ...rendered, sources });
  return {
    providerId: provider.id, component: request.component, deploymentId: request.deploymentId,
    resourceName, kind: "manual", verification: "not-live-tested", reviewedOn: provider.reviewedOn,
    sources, ...rendered,
    files: [...rendered.files, { name: "INSTRUCTIONS.md", content: guide, mediaType: "text/markdown" }],
  };
}

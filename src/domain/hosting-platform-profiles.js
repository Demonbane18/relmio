import { LOCAL_MODEL_RUNTIME_IMAGE } from "./local-n8n-model.js";
import { createSearchImageFiles, modelEnvironment, searchEnvironment } from "./hosting-deployment-common.js";

const RENDER_REGIONS = ["oregon", "ohio", "frankfurt", "singapore", "virginia"];
const RENDER_PLANS = ["2c-4g", "2c-8g", "2c-16g", "4c-16g", "4c-32g", "8c-32g"];
const option = value => ({ value, label: value });
const renderRegion = { name: "region", label: "Existing n8n region", type: "select", required: true, options: RENDER_REGIONS.map(option), description: "Choose the actual Render region with private-network access to the n8n backend." };
const flyRegion = { name: "region", label: "Existing n8n Fly region", type: "text", required: true, pattern: "^[a-z]{3}$", description: "Three-letter Fly region code where the n8n backend can reach this private app." };
const searchRequirements = ["n8n's execution backend must reach the private search service on port 8080; approve outbound HTTPS/DNS from SearXNG to search engines.", "Generate a unique, cryptographically random secret (at least 32 characters) in the provider secret store as SEARXNG_SECRET; never place it in this bundle or source control."];
const searchLimitations = ["NOT-RUN on a provider: JSON search, backend routing, egress/rate limits, memory and account policy require an operator-owned runtime check.", "Search cache is intentionally disposable; configuration is baked into the image. This is not a public search proxy."];
const modelLimitations = ["NOT-RUN on a provider: model download, real inference, capacity, private DNS and account policy require an operator-owned runtime check.", "The Ollama image is pinned; manual pulling of a mutable model tag is not Relmio's managed model-digest attestation. A successful pull or TCP health is not inference-ready evidence."];

function checkModelCapacity(model, memoryGB, diskGB) {
  if (model.memoryBytes + 1024 ** 3 > memoryGB * 1024 ** 3 ||
      (diskGB !== undefined && model.expectedDownloadBytes * 2 + 5 * 1024 ** 3 > diskGB * 1024 ** 3)) {
    throw new RangeError("The selected compute or persistent cache cannot cover this model's planning allowance.");
  }
}

function modelPullSteps(model, baseUrl) {
  return [
    `After deploying the private service, from an operator-controlled n8n backend on its permitted private network use an HTTP Request: POST ${baseUrl.replace(/\/v1$/u, "")}/api/pull, JSON body ${JSON.stringify({ model: model.id, stream: false })}, with a download-appropriate timeout. Require terminal status success; do not publish the unauthenticated model-management port to make the pull work.`,
    `Then execute a fresh, bounded n8n Chat Completions workflow using ${baseUrl}, model ${model.id}, Responses OFF and reasoning_effort none when applicable. Require a real answer; a successful pull or model list is insufficient.`,
  ];
}

function yamlEnvironment(env) {
  return Object.entries(env).map(([key, value]) => `      - key: ${key}\n        value: '${value}'`).join("\n");
}

function renderModel({ resourceName, model, inputs }) {
  const memoryGB = Number(inputs.plan.split("-")[1].replace("g", ""));
  if (inputs.diskGB % 5 !== 0) throw new TypeError("Render disk size must be a multiple of 5 GB.");
  checkModelCapacity(model, memoryGB, inputs.diskGB);
  const env = { ...modelEnvironment(model), PORT: "11434" };
  const baseUrl = "the actual Render Connect Internal address on port 11434/v1";
  return {
    files: [{ name: "render.yaml", mediaType: "text/yaml", content: `services:
  - type: pserv
    runtime: image
    name: ${resourceName}
    region: ${inputs.region}
    plan: ${inputs.plan}
    numInstances: 1
    image:
      url: ${LOCAL_MODEL_RUNTIME_IMAGE}
    disk:
      name: ${resourceName}-data
      mountPath: /var/data
      sizeGB: ${inputs.diskGB}
    envVars:
${yamlEnvironment(env)}
` }],
    settings: Object.entries(env).map(([name, value]) => ({ name, value })),
    steps: [
      "Review service name against your account before creating a NEW Render Blueprint for only this private service. Do not sync this file into a Blueprint managing existing n8n, databases or other services: names alone cannot prove non-adoption; do not remove existing resources.",
      `Deploy this single private service in ${inputs.region} on ${inputs.plan}, with its own ${inputs.diskGB} GB runtime disk. Leave the image's default ollama serve startup intact; disk is mounted only while service runs. Verify that the private service has no public onrender.com route.`,
      "In Render Connect copy the actual Internal address, append :11434/v1 for the n8n credential, and use its same host on port 11434 for model acquisition; do not use a guessed hostname. Check the n8n worker is in the same permitted private network/region.",
      ...modelPullSteps(model, baseUrl),
    ],
    connection: { discovery: "Copy Render Connect Internal address and append :11434/v1", protocol: "OpenAI-compatible Chat Completions", authentication: "private-network-only; no public raw model API" },
    requirements: ["Render paid private service and persistent disk; confirm current price/capacity before creation.", "Render and the n8n execution backend must share an allowed private network; model download needs approved outbound access."],
    limitations: [...modelLimitations, "Render disks are per instance and unavailable during build/pre-deploy; disk attachment disables zero-downtime deploys."],
  };
}

function renderSearch({ resourceName, inputs }) {
  const env = { ...searchEnvironment(), PORT: "8080" };
  const files = createSearchImageFiles();
  files.push({ name: "render.yaml", mediaType: "text/yaml", content: `services:
  - type: pserv
    runtime: docker
    name: ${resourceName}
    region: ${inputs.region}
    plan: ${inputs.plan}
    numInstances: 1
    envVars:
${yamlEnvironment(env)}
      - key: SEARXNG_SECRET
        sync: false
` });
  return {
    files,
    settings: Object.entries(env).map(([name, value]) => ({ name, value })),
    steps: ["In a fresh Git repository containing ONLY these generated search files, review the unique name and create a new Render Blueprint private service. Do not synchronize a Blueprint that owns existing n8n/resources; the source repository supplies the Dockerfile build context.", "At Blueprint creation enter SEARXNG_SECRET through Render's secret prompt; use a newly generated 32+ character random value, never a tracked env file. Keep the service private and the n8n backend in the same permitted Render region/network.", "From the n8n execution backend copy the actual Render Connect Internal address, request GET /search?q=n8n&format=json at port 8080 and require a JSON object with results array; upstream blocking is distinct from transport failure. Add its private base URL as N8N_INSTANCE_AI_SEARXNG_URL only if this is your selected Assistant search provider; Brave or UI credentials may take precedence."],
    connection: { discovery: "Copy Render Connect Internal address and append :8080", testPath: "/search?q=n8n&format=json" },
    requirements: searchRequirements,
    limitations: searchLimitations,
  };
}

function railwayModel({ resourceName, model, inputs }) {
  checkModelCapacity(model, inputs.memoryGB, inputs.volumeGB);
  const env = modelEnvironment(model, "[::]:11434");
  const baseUrl = `http://${resourceName}.railway.internal:11434/v1`;
  return {
    files: [],
    settings: Object.entries(env).map(([name, value]) => ({ name, value })),
    steps: [
      `In the existing Railway project and exact environment reachable by n8n, create a NEW private service named ${resourceName} from the Docker image ${LOCAL_MODEL_RUNTIME_IMAGE}. Do not select existing n8n, add a public domain/TCP proxy, use deprecated railway.json, or apply a whole-project IaC plan. Preserve the image's default serve command.`,
      `Create a new Railway volume for only this service, mount it at /var/data, choose ${inputs.volumeGB} GB in Railway's volume size control (${inputs.volumeGB * 1024} MB), and attach it to the service. The volume is available at runtime, not build/pre-deploy time.`,
      `Set the listed environment variables in this new service and review its memory limit: reserve at least ${inputs.memoryGB} GB for this model plus n8n elsewhere. Keep one replica and confirm no public domain/TCP proxy exists. Railway private DNS is environment-scoped; legacy environments may resolve IPv6 only.`,
      ...modelPullSteps(model, baseUrl),
    ],
    connection: { baseUrl, protocol: "OpenAI-compatible Chat Completions", authentication: "same Railway environment private network only" },
    requirements: ["An existing Railway project/environment with n8n backend network access and a separately paid persistent volume.", "Confirm service resource allocation, volume capacity, current billing and outbound registry access."],
    limitations: [...modelLimitations, "Railway services are nonprivileged; this is not a DinD Assistant runner."],
  };
}

function railwaySearch({ resourceName, inputs }) {
  const env = searchEnvironment("::");
  return {
    files: createSearchImageFiles(),
    settings: Object.entries(env).map(([name, value]) => ({ name, value })),
    steps: [
      `Put only the generated Dockerfile, settings.yml, start.sh and .dockerignore in a new Git repository. In n8n's existing Railway project/environment, add a NEW service ${resourceName} from that repository with Dockerfile builder and one replica. Do not adopt n8n or apply whole-project IaC.`,
      "Set the listed runtime variables and create SEARXNG_SECRET as an owner-generated random 32+ character value in Railway service Variables; do not put it in the repo or a generated download. Do not create a public domain or TCP proxy. Search cache is ephemeral; no volume is required.",
      `From the n8n backend in this exact environment GET http://${resourceName}.railway.internal:8080/search?q=n8n&format=json; require JSON results array. If using Assistant, use this private base URL for N8N_INSTANCE_AI_SEARXNG_URL and confirm search precedence.`,
    ],
    connection: { baseUrl: `http://${resourceName}.railway.internal:8080`, testPath: "/search?q=n8n&format=json" },
    requirements: searchRequirements,
    limitations: [...searchLimitations, "Legacy Railway environments may have IPv6-only private DNS; runtime listens on IPv6."],
  };
}

function flyModel({ resourceName, model, inputs }) {
  const minMB = (inputs.cpuKind === "shared" ? 256 : 2048) * inputs.cpus;
  const maxMB = (inputs.cpuKind === "shared" ? 2048 : 8192) * inputs.cpus;
  if ((inputs.cpuKind === "shared" && inputs.cpus > 8) || inputs.memoryMB < minMB || inputs.memoryMB > maxMB) {
    throw new RangeError("Fly CPU and memory selection is outside reviewed Machine sizes.");
  }
  checkModelCapacity(model, inputs.memoryMB / 1024, inputs.volumeGB);
  const env = modelEnvironment(model, "[::]:11434");
  const baseUrl = `http://${resourceName}.internal:11434/v1`;
  return {
    files: [{ name: "fly.toml", mediaType: "text/plain", content: `app = "${resourceName}"
primary_region = "${inputs.region}"

[build]
  image = "${LOCAL_MODEL_RUNTIME_IMAGE}"

[env]
${Object.entries(env).map(([key, value]) => `  ${key} = "${value}"`).join("\n")}

[[mounts]]
  source = "${resourceName.replace(/-/gu, "_")}_data"
  destination = "/var/data"
  initial_size = "${inputs.volumeGB}gb"

[[vm]]
  cpu_kind = "${inputs.cpuKind}"
  cpus = ${inputs.cpus}
  memory = "${inputs.memoryMB}mb"
` }],
    settings: Object.entries(env).map(([name, value]) => ({ name, value })),
    steps: [
      `In the existing permitted Fly organization create only a NEW app ${resourceName} in ${inputs.region}, not the existing n8n app. Review its name for collisions and deploy this fly.toml from an isolated directory. Do not allocate a public IPv4/IPv6/Flycast address; this file intentionally has no services/http_service block.`,
      `Provision/attach exactly one ${inputs.volumeGB} GB volume to one Machine in ${inputs.region} (the mount initial_size applies on first deploy). Explicitly set/verify exactly ONE running Machine and one attached volume after deployment; fly deploy alone does not prove singleton placement. Leave the machine running: direct 6PN traffic does not use Fly Proxy autostart.`,
      "Confirm the actual n8n execution backend joins the same permitted Fly organization 6PN and can reach the running private Machine; never publish the raw model API as a connectivity workaround.",
      ...modelPullSteps(model, baseUrl),
    ],
    connection: { baseUrl, protocol: "OpenAI-compatible Chat Completions", authentication: "same-organization Fly 6PN only" },
    requirements: ["Fly organization, region, persistent per-Machine volume and private 6PN from the n8n backend.", "Review paid resources and memory/CPU capacity before deployment."],
    limitations: [...modelLimitations, "A Fly volume is local to one Machine/region with no automatic replication, and stopped Machines disappear from .internal DNS."],
  };
}

function flySearch({ resourceName, inputs }) {
  const env = searchEnvironment("::");
  const files = createSearchImageFiles();
  files.push({ name: "fly.toml", mediaType: "text/plain", content: `app = "${resourceName}"
primary_region = "${inputs.region}"

[build]
  dockerfile = "Dockerfile"

[env]
${Object.entries(env).map(([key, value]) => `  ${key} = "${value}"`).join("\n")}

[[vm]]
  cpu_kind = "shared"
  cpus = 1
  memory = "${inputs.memoryMB}mb"
` });
  return {
    files,
    settings: Object.entries(env).map(([name, value]) => ({ name, value })),
    steps: [`In the existing Fly organization create a NEW app ${resourceName}, review name collision, deploy only these files from an isolated directory and verify one running Machine in ${inputs.region}. No services/http_service, public IPv4/IPv6 or Flycast address: direct .internal 6PN reachability requires an already permitted n8n backend.`, "Create SEARXNG_SECRET as a 32+ character cryptographically random Fly app secret through the operator's secure secret workflow, not as a fly.toml environment value or repository file. The startup wrapper refuses a missing/short secret.", `From the n8n execution backend GET http://${resourceName}.internal:8080/search?q=n8n&format=json; require a JSON results array. Configure N8N_INSTANCE_AI_SEARXNG_URL to the private base URL only if Assistant uses SearXNG and check provider precedence.`],
    connection: { baseUrl: `http://${resourceName}.internal:8080`, testPath: "/search?q=n8n&format=json" },
    requirements: searchRequirements,
    limitations: [...searchLimitations, "A stopped Fly Machine is absent from .internal DNS; no Fly Proxy autostart is configured."],
  };
}

function digitaloceanSearch({ resourceName, inputs }) {
  const env = searchEnvironment();
  return {
    files: createSearchImageFiles(),
    settings: [...Object.entries(env).map(([name, value]) => ({ name, value })), { name: "instance_size_slug", value: inputs.instanceSize }, { name: "internal_ports", value: "8080" }],
    steps: [
      `Put only these four generated files in a new Git repository. In the EXISTING DigitalOcean App Platform app (same app as its n8n execution component), add a NEW Service component ${resourceName} sourced from this repo and Dockerfile; do not replace the existing app spec or existing n8n component. Verify the component name is unused before creation.`,
      `In the app spec editor for ONLY the new service, choose instance_size_slug ${inputs.instanceSize}, instance_count 1, internal_ports [8080]; remove its http_port and any ingress rules matching this service. Preserve all existing app ingress routes, n8n, database and other components. Save only after reviewing the complete proposed diff.`,
      "Set the listed Granian runtime variables and an independently generated 32+ character SEARXNG_SECRET as an encrypted RUN_TIME SECRET through App Platform settings, not a tracked app spec/env file. This service must have outbound DNS/HTTPS but no public route.",
      `From the n8n execution component in this same app GET http://${resourceName}:8080/search?q=n8n&format=json and require a JSON results array. Only then optionally use its base URL for N8N_INSTANCE_AI_SEARXNG_URL; check Brave/UI precedence.`,
    ],
    connection: { baseUrl: `http://${resourceName}:8080`, testPath: "/search?q=n8n&format=json" },
    requirements: ["Existing DigitalOcean App Platform app with an n8n execution component and access to add one internal service; confirm billing before operator action.", ...searchRequirements],
    limitations: [...searchLimitations, "App Platform has no persistent volumes; cache is disposable, local filesystem is capped and replaced on deployments. This is not a persistent Ollama model lane."],
  };
}

const daytonaPlatforms = ["render", "railway", "fly", "digitalocean-app", "ecs-ec2", "ecs-fargate", "eks", "eks-fargate", "gke", "gke-autopilot", "aks", "cloud-run", "azure-container-apps", "azure-container-instances", "lightsail-containers"];
function daytonaAssistant({ providerId }) {
  return {
    files: [],
    settings: [
      { name: "N8N_INSTANCE_AI_SANDBOX_ENABLED", value: "true" },
      { name: "N8N_INSTANCE_AI_SANDBOX_PROVIDER", value: "daytona" },
      { name: "N8N_INSTANCE_AI_SANDBOX_IMAGE", value: "daytonaio/sandbox:0.5.3-slim" },
      { name: "DAYTONA_API_URL", value: "https://app.daytona.io/api" },
    ],
    steps: [
      `For self-hosted n8n on ${providerId}, first check the instance's Assistant/instance-ai entitlement and operator-owned Daytona account/capacity. Daytona replaces only sandbox execution; choose and configure a real model provider independently. This is NOT a Relmio-managed runner.`,
      "In the EXISTING n8n environment configuration, preserve every N8N_ENABLED_MODULES entry and include instance-ai. An operator, not this plan, reviews and applies all n8n configuration changes and handles any necessary restart in their maintenance window; do not let this guide mutate or restart n8n.",
      "Add the listed nonsecret settings to the n8n runtime. Put the actual DAYTONA_API_KEY from the operator's own Daytona account into its existing secret manager as a runtime secret; never write its value into this plan, a downloaded file or a shared app spec.",
      "Select the exact supported N8N_INSTANCE_AI_MODEL and supply its independent N8N_INSTANCE_AI_MODEL_API_KEY as an operator-owned runtime secret when that provider requires a key. A custom endpoint may additionally need N8N_INSTANCE_AI_MODEL_URL; it must be reachable from the n8n backend.",
      "If search is desired, configure one reachable N8N_INSTANCE_AI_SEARXNG_URL or an operator-owned Brave key, then check n8n search-provider precedence. Generate and execute one harmless workflow that actually performs a Daytona sandbox operation; a login or health check alone is not proof.",
    ],
    connection: { provider: "daytona", apiUrl: "https://app.daytona.io/api", integration: "operator-configured n8n self-hosted Assistant sandbox" },
    requirements: ["Self-hosted n8n with instance-ai available, operator-owned Daytona account/capacity and approved outbound HTTPS.", "Operator-owned Assistant model and secret management; no credentials are collected by the generator."],
    limitations: ["NOT-RUN: Daytona account capacity, sandbox action and model/search compatibility need a real operator-owned execution.", "The n8n-documented Daytona image tag is date-qualified guidance, not a Relmio-attested immutable image digest; review current vendor guidance before applying.", "This handoff does not install a local privileged runner, alter existing n8n, or provide Ollama, SearXNG or credential bridges."],
  };
}

const modelFields = [renderRegion, { name: "plan", label: "New service plan", type: "select", required: true, options: RENDER_PLANS.map(option), description: "Current Render compute slugs; review live price and model memory headroom." }, { name: "diskGB", label: "Persistent disk GB", type: "number", required: true, min: 5, max: 500, defaultValue: 20, description: "Use 5 GB multiples; model cache and download need capacity." }];
const railwayModelFields = [{ name: "volumeGB", label: "New persistent volume GB", type: "number", required: true, min: 10, max: 500, defaultValue: 20 }, { name: "memoryGB", label: "Reviewed service memory GB", type: "number", required: true, min: 4, max: 128, defaultValue: 8 }];
const flyModelFields = [flyRegion, { name: "cpuKind", label: "Machine CPU type", type: "select", required: true, options: ["shared", "performance"].map(option) }, { name: "cpus", label: "Machine CPUs", type: "select", required: true, options: [1, 2, 4, 8, 16].map(value => ({ value, label: `${value} CPU${value === 1 ? "" : "s"}` })), defaultValue: 2, description: "Shared supports at most 8 CPUs; 16 requires performance. Memory limits depend on CPU kind and count." }, { name: "memoryMB", label: "Machine memory MB", type: "select", required: true, options: [4096, 8192, 16384, 32768].map(value => ({ value, label: `${value} MB` })) }, { name: "volumeGB", label: "New persistent volume GB", type: "number", required: true, min: 10, max: 500, defaultValue: 20 }];
const flySearchFields = [flyRegion, { name: "memoryMB", label: "Machine memory MB", type: "select", required: true, options: [1024, 2048].map(value => ({ value, label: `${value} MB` })) }];

export const PLATFORM_HOSTING_PROFILES = [
  { providerId: "render", component: "model", fields: modelFields, render: renderModel },
  { providerId: "render", component: "searxng", fields: [renderRegion, { name: "plan", label: "New private service plan", type: "select", required: true, options: ["1c-2g", "2c-4g", "2c-8g"].map(option) }], render: renderSearch },
  { providerId: "railway", component: "model", fields: railwayModelFields, render: railwayModel },
  { providerId: "railway", component: "searxng", fields: [], render: railwaySearch },
  { providerId: "fly", component: "model", fields: flyModelFields, render: flyModel },
  { providerId: "fly", component: "searxng", fields: flySearchFields, render: flySearch },
  { providerId: "digitalocean-app", component: "searxng", fields: [{ name: "instanceSize", label: "New service size", type: "select", required: true, options: ["apps-s-1vcpu-2gb", "apps-s-2vcpu-4gb"].map(option) }], render: digitaloceanSearch },
  ...daytonaPlatforms.map(providerId => ({ providerId, component: "assistant", fields: [], render: daytonaAssistant })),
];

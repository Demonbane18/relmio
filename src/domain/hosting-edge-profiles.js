import { createSearchImageFiles, searchEnvironment } from "./hosting-deployment-common.js";

const WORKER_DATE = "2026-09-27";
const WRANGLER_VERSION = "4.141.0";
const CONTAINERS_VERSION = "0.3.7";

const endpointFields = [{
  name: "upstreamOrigin",
  label: "Existing authenticated model HTTPS origin",
  type: "text",
  required: true,
  pattern: "https://[A-Za-z0-9.-]+",
  description: "Origin only, without a path, query, credentials, IP literal, or port. The gateway always calls /v1/chat/completions.",
}];

function file(name, content, mediaType = "text/plain") {
  return { name, content, mediaType };
}

function validateUpstreamOrigin(input) {
  let url;
  try {
    url = new URL(input);
  } catch {
    throw new Error("An HTTPS model origin is required.");
  }
  const hostname = url.hostname.toLowerCase();
  const labels = hostname.split(".");
  if (url.protocol !== "https:" || input !== url.origin || url.port ||
      !/^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/.test(hostname) ||
      labels.every((part) => /^[0-9]+$/.test(part)) ||
      labels.some((part) => part.startsWith("-") || part.endsWith("-") || part.length > 63) ||
      /\.(?:local|localhost|internal|test|invalid|example)$/.test(hostname) ||
      hostname === "localhost" || hostname.endsWith(".localhost") ||
      hostname.length > 253) {
    throw new Error("Provide a public DNS HTTPS origin without a port, path, or credentials.");
  }
  return url.origin;
}

// This module is copied into each generated deployment; the HTTPS upstream is fixed at plan time.
// Only the caller credential is accepted at ingress. The upstream bearer is read from the
// server-side runtime secret store and sent to that upstream, not embedded in generated
// artifacts or deliberately included in responses or logs.
function proxySource(origin) {
  return `const UPSTREAM = ${JSON.stringify(origin + "/v1/chat/completions")};
const MAX_BODY = 262144;
const encoder = new TextEncoder();

function reply(status) {
  return new Response(null, { status, headers: { "cache-control": "no-store" } });
}

async function sameSecret(provided, expected) {
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const left = new Uint8Array(a);
  const right = new Uint8Array(b);
  let difference = 0;
  for (let i = 0; i < left.length; i++) difference |= left[i] ^ right[i];
  return difference === 0;
}

async function readBoundedBody(request) {
  const length = request.headers.get("content-length");
  if (length !== null && (!/^[0-9]+$/.test(length) || Number(length) > MAX_BODY)) return null;
  if (!request.body) return null;
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BODY) {
        await reader.cancel();
        return null;
      }
      chunks.push(value);
    }
  } catch {
    return null;
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

export async function handleChatRequest(request, secrets, fetchUpstream = fetch) {
  if (typeof secrets?.incoming !== "string" || !secrets.incoming ||
      typeof secrets.upstream !== "string" || !secrets.upstream) return reply(503);
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ") || authorization.length > 1024 ||
      !(await sameSecret(authorization.slice(7), secrets.incoming))) return reply(401);
  const url = new URL(request.url);
  if (request.method !== "POST" || url.pathname !== "/api/chat" || url.search || url.hash) return reply(404);
  if (!/^application\\/json(?:\\s*;|$)/i.test(request.headers.get("content-type") ?? "") ||
      ![null, "identity"].includes(request.headers.get("content-encoding"))) return reply(415);
  const body = await readBoundedBody(request);
  if (!body) return reply(413);
  try {
    const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(body));
    if (!parsed || Array.isArray(parsed) || typeof parsed !== "object" ||
        typeof parsed.model !== "string" || !parsed.model || !Array.isArray(parsed.messages)) return reply(400);
  } catch {
    return reply(400);
  }
  try {
    const upstream = await fetchUpstream(UPSTREAM, {
      method: "POST",
      headers: {
        "authorization": \`Bearer \${secrets.upstream}\`,
        "content-type": "application/json",
        "accept": "application/json, text/event-stream",
      },
      body,
      redirect: "manual",
      signal: request.signal,
    });
    if (upstream.status < 200 || upstream.status >= 300) {
      await upstream.body?.cancel();
      return reply(502);
    }
    const contentType = upstream.headers.get("content-type") ?? "";
    const safeType = /^application\\/json(?:\\s*;|$)/i.test(contentType) ? "application/json" :
      /^text\\/event-stream(?:\\s*;|$)/i.test(contentType) ? "text/event-stream" : null;
    if (!safeType || !upstream.body) {
      await upstream.body?.cancel();
      return reply(502);
    }
    return new Response(upstream.body, {
      status: upstream.status,
      headers: { "content-type": safeType, "cache-control": "no-store", "x-content-type-options": "nosniff" },
    });
  } catch {
    return reply(502);
  }
}
`;
}

function endpointPlan({ providerId, resourceName, inputs }) {
  const origin = validateUpstreamOrigin(inputs.upstreamOrigin);
  const common = file("proxy.mjs", proxySource(origin), "text/javascript");
  const secrets = ["RELMIO_INCOMING_TOKEN", "RELMIO_UPSTREAM_TOKEN"];
  const commonSteps = [
    "Review the selected existing model service and its exact HTTPS origin; it must implement POST /v1/chat/completions and require its own bearer credential. This gateway never hosts a model.",
    "Generate a strong independent caller token outside Relmio for RELMIO_INCOMING_TOKEN, and obtain an already issued valid API credential for the selected upstream as RELMIO_UPSTREAM_TOKEN (or configure an owned upstream to accept a separate token). Store each only in its respective runtime secret/credential store; never place values in source, build variables, URLs, or downloads.",
    "Deploy only this new endpoint project; review naming/collisions and preserve any existing n8n deployment. Confirm the endpoint URL and test a fresh authenticated Chat Completions request; a deployment/health response is not inference proof.",
    "In n8n, use an HTTP Request POST to the actual deployed HTTPS /api/chat with an Authorization: Bearer credential kept in n8n, Content-Type: application/json, and JSON Chat Completions body (model and messages). For streaming clients this endpoint forwards successful SSE; do not enable Responses mode.",
  ];
  let files;
  let providerStep;
  if (providerId === "vercel") {
    files = [common, file("api/chat.mjs", `import { handleChatRequest } from "../proxy.mjs";\n\nexport default {\n  fetch(request) {\n    return handleChatRequest(request, { incoming: process.env.RELMIO_INCOMING_TOKEN, upstream: process.env.RELMIO_UPSTREAM_TOKEN });\n  },\n};\n`, "text/javascript"), file("package.json", JSON.stringify({ private: true, type: "module" }, null, 2) + "\n", "application/json")];
    providerStep = "Create an isolated Vercel Node.js Functions project from these files; configure both runtime Environment Variables as sensitive values for the target environment before deployment. Use the actual deployment's /api/chat URL; preview and production secrets are separate.";
  } else if (providerId === "netlify") {
    files = [common, file("netlify/functions/chat.mjs", `import { handleChatRequest } from "../../proxy.mjs";\n\nexport default function handler(request) {\n  return handleChatRequest(request, { incoming: process.env.RELMIO_INCOMING_TOKEN, upstream: process.env.RELMIO_UPSTREAM_TOKEN });\n}\n\nexport const config = { path: "/api/chat" };\n`, "text/javascript"), file("package.json", JSON.stringify({ private: true, type: "module" }, null, 2) + "\n", "application/json")];
    providerStep = "Create an isolated Netlify Functions site from these files; configure both variables in Netlify's runtime Functions environment scope, not netlify.toml. Redeploy after setting/rotating secrets; use its actual HTTPS /api/chat URL.";
  } else {
    files = [common, file("src/index.mjs", `import { handleChatRequest } from "../proxy.mjs";\n\nexport default {\n  fetch(request, env) {\n    return handleChatRequest(request, { incoming: env.RELMIO_INCOMING_TOKEN, upstream: env.RELMIO_UPSTREAM_TOKEN });\n  },\n};\n`, "text/javascript"), file("package.json", JSON.stringify({ private: true, type: "module", devDependencies: { wrangler: WRANGLER_VERSION } }, null, 2) + "\n", "application/json"), file("wrangler.jsonc", JSON.stringify({ name: resourceName, main: "src/index.mjs", compatibility_date: WORKER_DATE, workers_dev: true, preview_urls: false, secrets: { required: secrets }, observability: { enabled: true, logs: { enabled: true, head_sampling_rate: 0.1 }, traces: { enabled: true, head_sampling_rate: 0.01 } } }, null, 2) + "\n", "application/json")];
    providerStep = "Create a new Cloudflare Worker project from these files; configure both required Worker secrets using private interactive secret input or dashboard, then review and deploy. Keep the authenticated workers.dev route enabled for n8n's off-platform HTTPS requests; never serve unprotected raw model endpoints.";
  }
  return {
    files,
    settings: [
      { name: "RELMIO_INCOMING_TOKEN", value: "Independent operator-generated caller token stored as a runtime secret; n8n stores its matching credential." },
      { name: "RELMIO_UPSTREAM_TOKEN", value: "Already issued and approved upstream API bearer credential stored as a runtime secret; not a generated OAuth/session token." },
    ],
    steps: [providerStep, ...commonSteps],
    connection: { path: "/api/chat", method: "POST", authentication: "Bearer RELMIO_INCOMING_TOKEN (n8n credential)", upstream: origin + "/v1/chat/completions", usage: "HTTP Request Chat Completions; use the actual deployed HTTPS hostname" },
    requirements: ["An existing, approved, reachable HTTPS OpenAI-compatible Chat Completions upstream with bearer authentication and model access.", "Separate server-side runtime secrets and an n8n-held caller credential."],
    limitations: ["Not a model deployment or a universal URL relay; only POST /api/chat forwards to the fixed upstream path.", "No OAuth/ChatGPT/Codex/SuperGrok session credential is generated or transferred. Confirm your upstream's permitted use and network policy.", "Proxy success is not model/tool quality proof; cloud inference, function limits, and provider costs remain operator responsibilities."],
  };
}

function n8nCloudPlan() {
  return {
    files: [],
    settings: [
      { name: "Remote model base URL", value: "Use the actual approved externally reachable HTTPS model gateway URL, not localhost or another provider's private DNS." },
      { name: "n8n credential", value: "Store the gateway's caller bearer token in n8n's credential store, never in the plan or a workflow URL." },
      { name: "Model", value: "Select the exact available model identifier returned by the remote service; do not assume Relmio's local catalog is hosted there." },
      { name: "Remote search HTTP Request", value: "If using search, connect to an independently operated authenticated HTTPS /search?q=...&format=json route; store its separate bearer credential in n8n." },
    ],
    steps: [
      "Operate an independently approved, authenticated remote model gateway before connecting n8n Cloud. For the generated Vercel/Netlify/Cloudflare Workers endpoint, its exact callable path is POST /api/chat and it implements Chat Completions only.",
      "For that endpoint, create an n8n Cloud HTTP Request node (or AI Agent HTTP Request tool): POST the gateway's actual HTTPS /api/chat, choose a stored Header Auth credential with Authorization: Bearer <caller token>, send Content-Type application/json and a Chat Completions JSON body containing the actual model and messages; read choices[0].message.content. For an upstream remote Ollama service with an authenticated Ollama API proxy (not this restricted Chat-only endpoint), use n8n's Ollama credential with actual remote Base URL and optional API Key bearer authentication.",
      "For search from n8n Cloud, create a separate HTTP Request node or AI Agent HTTP Request tool: GET the actual approved HTTPS search gateway /search with URL-encoded q and format=json, using a stored Header Auth credential for Authorization: Bearer <search token>. Require a JSON object with a results array; this is not a native Assistant search-provider setting.",
      "Run a fresh workflow and inspect the completion rather than treating a credential save or health check as proof. Never expose raw unauthenticated Ollama or model-management paths to make Cloud reach a private service.",
      "n8n Cloud's native Assistant and sandbox entitlement are n8n-managed. Self-hosted instance-ai environment settings and a private SearXNG Docker hostname are not configuration for a Cloud tenant.",
    ],
    connection: { protocol: "OpenAI-compatible Chat Completions", path: "/api/chat", method: "POST", authentication: "n8n Header Auth credential: Authorization Bearer caller token", usage: "HTTP Request node/tool from n8n Cloud to an operator-approved HTTPS gateway", search: "Separate authenticated HTTP Request GET /search?q=<encoded query>&format=json; use an independently deployed search gateway, not the Chat-only proxy" },
    requirements: ["An already deployed HTTPS endpoint reachable from n8n Cloud with a valid stored caller credential and available model."],
    limitations: ["No n8n Cloud host SSH, Docker, or native managed companion install; private provider DNS and localhost are not n8n Cloud endpoints.", "This guidance does not provision the remote service, modify n8n, or claim native Assistant support for custom HTTP auth headers."],
  };
}

function cloudflareSearchPlan({ resourceName }) {
  const files = createSearchImageFiles();
  const vars = searchEnvironment();
  const searchWorker = `import { Container } from "@cloudflare/containers";
import { env as bindings } from "cloudflare:workers";
import { handleSearchRequest } from "../search-handler.mjs";

export class SearchContainer extends Container {
  defaultPort = 8080;
  sleepAfter = "10m";
  envVars = {
    GRANIAN_HOST: ${JSON.stringify(vars.GRANIAN_HOST)},
    GRANIAN_PORT: ${JSON.stringify(vars.GRANIAN_PORT)},
    FORCE_OWNERSHIP: ${JSON.stringify(vars.FORCE_OWNERSHIP)},
    SEARXNG_SECRET: bindings.SEARXNG_SECRET,
  };
}

export default {
  fetch(request, env) {
    return handleSearchRequest(request, env, (name) => env.SEARCH_CONTAINER.getByName(name));
  },
};
`;
  const searchHandler = `const encoder = new TextEncoder();
const MAX_QUERY_BYTES = 512;
const MAX_RESULT_BYTES = 1048576;

function reply(status) {
  return new Response(null, { status, headers: { "cache-control": "no-store" } });
}

function boundedStream(body) {
  let count = 0;
  return body.pipeThrough(new TransformStream({
    transform(chunk, controller) {
      count += chunk.byteLength;
      if (count > MAX_RESULT_BYTES) throw new Error("Search response exceeds limit");
      controller.enqueue(chunk);
    },
  }));
}

// The only destination is the configured container binding; caller paths never become upstream URLs.
export async function handleSearchRequest(request, env, getContainer) {
  if (typeof env.RELMIO_SEARCH_TOKEN !== "string" || !env.RELMIO_SEARCH_TOKEN ||
      typeof env.SEARXNG_SECRET !== "string" || !env.SEARXNG_SECRET) return reply(503);
  const authorization = request.headers.get("authorization");
  if (!authorization?.startsWith("Bearer ") || authorization.length > 1024 ||
      !(await sameSecret(authorization.slice(7), env.RELMIO_SEARCH_TOKEN))) return reply(401);
  const url = new URL(request.url);
  if (request.method !== "GET" || url.pathname !== "/search" || url.hash ||
      url.search.length > 1024) return reply(404);
  const pairs = [...url.searchParams];
  if (pairs.length !== 2 || pairs.some(([key]) => key !== "q" && key !== "format") ||
      url.searchParams.getAll("q").length !== 1 || url.searchParams.getAll("format").length !== 1 ||
      url.searchParams.get("format") !== "json") return reply(400);
  const query = url.searchParams.get("q");
  if (!query?.trim() || encoder.encode(query).length > MAX_QUERY_BYTES) return reply(400);
  const target = new URL("http://localhost:8080/search");
  target.searchParams.set("q", query);
  target.searchParams.set("format", "json");
  try {
    const response = await getContainer(${JSON.stringify(resourceName)}).fetch(new Request(target, { method: "GET" }));
    const length = response.headers.get("content-length");
    if (response.status !== 200 || !response.body ||
        !/^application\\/json(?:\\s*;|$)/i.test(response.headers.get("content-type") ?? "") ||
        (length !== null && (!/^[0-9]+$/.test(length) || Number(length) > MAX_RESULT_BYTES))) {
      await response.body?.cancel();
      return reply(502);
    }
    return new Response(boundedStream(response.body), {
      status: 200,
      headers: { "content-type": "application/json", "cache-control": "no-store", "x-content-type-options": "nosniff" },
    });
  } catch {
    return reply(502);
  }
}


async function sameSecret(provided, expected) {
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", encoder.encode(provided)),
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
  ]);
  const left = new Uint8Array(a);
  const right = new Uint8Array(b);
  let difference = 0;
  for (let i = 0; i < left.length; i++) difference |= left[i] ^ right[i];
  return difference === 0;
}
`;
  const config = {
    name: resourceName,
    main: "src/index.mjs",
    compatibility_date: WORKER_DATE,
    workers_dev: true,
    preview_urls: false,
    containers: [{ class_name: "SearchContainer", image: "./Dockerfile", instance_type: "standard-1", max_instances: 1 }],
    durable_objects: { bindings: [{ name: "SEARCH_CONTAINER", class_name: "SearchContainer" }] },
    migrations: [{ tag: "v1", new_sqlite_classes: ["SearchContainer"] }],
    secrets: { required: ["SEARXNG_SECRET", "RELMIO_SEARCH_TOKEN"] },
    observability: { enabled: true, logs: { enabled: true, head_sampling_rate: 0.1 }, traces: { enabled: true, head_sampling_rate: 0.01 } },
  };
  files.push(file("src/index.mjs", searchWorker, "text/javascript"));
  files.push(file("search-handler.mjs", searchHandler, "text/javascript"));
  files.push(file("wrangler.jsonc", JSON.stringify(config, null, 2) + "\n", "application/json"));
  files.push(file("package.json", JSON.stringify({ private: true, type: "module", dependencies: { "@cloudflare/containers": CONTAINERS_VERSION }, devDependencies: { wrangler: WRANGLER_VERSION } }, null, 2) + "\n", "application/json"));
  return {
    files,
    settings: [
      { name: "SEARXNG_SECRET", value: "Operator-generated high-entropy Worker secret, forwarded only to the private container." },
      { name: "RELMIO_SEARCH_TOKEN", value: "Independent operator-generated high-entropy Worker secret, held as the n8n HTTP Request credential." },
    ],
    steps: [
      "Create a new isolated Cloudflare Containers Worker project from these files. Review unique resource names/collisions and the package/Wrangler configuration before deploying; Cloudflare Containers requires a compatible account and locally available image builder. Do not apply this to an existing n8n project.",
      "Configure two independent high-entropy Worker secrets (SEARXNG_SECRET for SearXNG startup, RELMIO_SEARCH_TOKEN for caller authentication) via private dashboard/interactive secret input before deployment. Never put values in wrangler.jsonc or downloaded files. Container storage/cache is ephemeral; SearXNG needs outbound search-engine access.",
      "Deploy this Worker and container image only. Its authenticated workers.dev route is deliberately reachable from off-platform n8n; without that HTTPS route a self-hosted n8n cannot call a private Cloudflare binding. The container itself has no public service port.",
      "In an n8n workflow HTTP Request node (or AI Agent HTTP Request tool), GET the actual Worker HTTPS /search with q and format=json, using a stored Header Auth credential Authorization: Bearer <search token>. Confirm a JSON results array and actual engine outcome. A native instance Assistant SearXNG URL setting cannot send this custom header, so do not point it at this route as if that integration worked.",
    ],
    connection: { path: "/search", method: "GET", query: "q=<URL-encoded search text>&format=json", authentication: "Bearer RELMIO_SEARCH_TOKEN in n8n HTTP Request credential", usage: "Workflow or AI Agent HTTP Request tool; actual deployed Worker HTTPS hostname required" },
    requirements: ["Cloudflare Containers availability and image build support, SearXNG outbound egress, two independently supplied runtime secrets, and an n8n HTTP Request credential."],
    limitations: ["Search-only private container with authenticated public Worker route; no unauthenticated search, arbitrary proxy, privileged sandbox, persistent model cache, or native Assistant custom-header integration.", "Cloudflare container disk is ephemeral; search-engine blocks/rate limits and paid resource usage require live operator verification."],
  };
}

export const EDGE_HOSTING_PROFILES = [
  { providerId: "cloudflare-containers", component: "searxng", fields: [], render: cloudflareSearchPlan },
  { providerId: "n8n-cloud", component: "endpoint", fields: [], render: n8nCloudPlan },
  ...["vercel", "netlify", "cloudflare-workers"].map((providerId) => ({
    providerId, component: "endpoint", fields: endpointFields, render: endpointPlan,
  })),
];

import { createServer } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";

// These exact image IDs work through this bridge's existing image translation.
// Catalog support does not prove that every account is entitled to use them.
const compatibilityImageModels = Object.freeze([
  "gpt-image-2.5-flare",
  "gpt-image-2.5-sunburst",
]);
const incompatibleModelPattern = /^gpt-(?:live|realtime)(?:-|$)/u;

function requestError(message, param, status = 400) {
  return Response.json({
    error: { message, type: "invalid_request_error", code: "unsupported_oauth_feature", param },
  }, { status });
}

const unsupportedRoutes = [
  {
    pattern: /^\/v1\/audio(?:\/|$)/u,
    param: "audio",
    message: "Audio generation, transcription, and translation are unavailable with ChatGPT OAuth. Use a separately configured OpenAI Platform connection for n8n Audio actions; do not put its API key in this bridge.",
  },
  {
    pattern: /^\/v1\/files(?:\/|$)/u,
    param: "files",
    message: "File upload, listing, and deletion are unavailable with ChatGPT OAuth. For model input, send file content inline with Message a Model; use a separately configured OpenAI Platform connection for n8n File actions.",
  },
  {
    pattern: /^\/v1\/conversations(?:\/|$)/u,
    param: "conversations",
    message: "Stored conversations are unavailable with ChatGPT OAuth. Send the full conversation history in each Message a Model input.",
  },
  {
    pattern: /^\/v1\/moderations(?:\/|$)/u,
    param: "moderations",
    message: "Text classification for violations is unavailable with ChatGPT OAuth. Use a separately configured OpenAI Platform connection for n8n's Classify Text for Violations action.",
  },
  {
    pattern: /^\/v1\/videos(?:\/|$)/u,
    param: "videos",
    message: "Video generation is unavailable with ChatGPT OAuth. Use a separately configured OpenAI Platform connection for n8n's Generate a Video action.",
  },
  {
    pattern: /^\/v1\/live(?:\/|$)/u,
    param: "live",
    message: "This ChatGPT OAuth bridge does not support OpenAI Live sessions. Use a separately configured OpenAI Platform Live connection.",
  },
  {
    pattern: /^\/v1\/realtime(?:\/|$)/u,
    param: "realtime",
    message: "This ChatGPT OAuth bridge does not support OpenAI Realtime sessions. Use a separately configured OpenAI Platform Realtime connection.",
  },
];

async function adaptModelsResponse(response) {
  if (!response.ok) return response;

  let body;
  try {
    body = await response.clone().json();
  } catch {
    return response;
  }
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    body.object !== "list" ||
    !Array.isArray(body.data) ||
    !body.data.every((model) =>
      model && typeof model === "object" && !Array.isArray(model) &&
      typeof model.id === "string" && model.id.length > 0)
  ) {
    return response;
  }

  const data = body.data.filter(({ id }) => !incompatibleModelPattern.test(id));
  const modelIds = new Set(data.map(({ id }) => id));
  for (const id of compatibilityImageModels) {
    if (!modelIds.has(id)) {
      data.push({ id, object: "model", created: 0, owned_by: "codex-oauth" });
      modelIds.add(id);
    }
  }

  const headers = new Headers(response.headers);
  headers.delete("content-encoding");
  headers.delete("content-digest");
  headers.delete("content-length");
  headers.delete("content-md5");
  headers.delete("digest");
  headers.delete("etag");
  headers.delete("last-modified");
  headers.delete("repr-digest");
  headers.set("content-type", "application/json; charset=utf-8");
  return new Response(JSON.stringify({ ...body, data }), {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

// Keep OAuth, upstream catalog discovery, image transport and SSE decoding in
// the pinned package. Supplement media compatibility at the public boundary.
export function createSidecarHandler(upstream) {
  return async (request) => {
    const { pathname } = new URL(request.url);
    const unsupported = unsupportedRoutes.find(({ pattern }) => pattern.test(pathname));
    if (unsupported) {
      return requestError(unsupported.message, unsupported.param, 501);
    }
    if (pathname.startsWith("/v1/responses/")) {
      return requestError("Stored responses are unavailable with ChatGPT OAuth. Send the full conversation in each request.", null, 501);
    }
    if (request.method === "POST" && pathname === "/v1/responses") {
      let body;
      try {
        body = await request.json();
      } catch {
        return requestError("Request body must be valid JSON.", null);
      }
      if (!body || typeof body !== "object" || Array.isArray(body)) {
        return requestError("Request body must be a JSON object.", null);
      }
      if (body.background !== undefined && body.background !== false) {
        return requestError("ChatGPT OAuth does not support Background Mode. Turn it off in the n8n node.", "background");
      }
      if (body.conversation != null) {
        return requestError("ChatGPT OAuth does not support stored conversations. Send the full conversation in input.", "conversation");
      }
      // n8n includes false even when Background Mode is off. Codex rejects the
      // field's presence; omitting false preserves synchronous behavior.
      delete body.background;
      const headers = new Headers(request.headers);
      headers.delete("content-length");
      request = new Request(request.url, {
        method: "POST", headers, body: JSON.stringify(body), signal: request.signal,
      });
    }
    const response = await upstream(request);
    if (request.method === "GET" && pathname === "/v1/models") {
      return adaptModelsResponse(response);
    }
    return response;
  };
}

export function createSidecarServer(handler) {
  return createServer(async (req, res) => {
    const controller = new AbortController();
    res.on("close", () => {
      if (!res.writableFinished) controller.abort();
    });
    try {
      const request = new Request(new URL(req.url, "http://sidecar.local"), {
        method: req.method,
        headers: req.headers,
        signal: controller.signal,
        ...(!["GET", "HEAD"].includes(req.method) && {
          body: Readable.toWeb(req), duplex: "half",
        }),
      });
      const response = await handler(request);
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) await pipeline(Readable.fromWeb(response.body), res);
      else res.end();
    } catch {
      if (res.headersSent) res.destroy();
      else {
        res.writeHead(500, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: "The OAuth sidecar could not complete the request.", type: "server_error" } }));
      }
    }
  });
}

async function main() {
  // This absolute module path is provided by both generated node:22 images.
  const { createOpenAIOAuthFetchHandler } = await import("/usr/local/lib/node_modules/openai-oauth/dist/index.js");
  const upstream = createOpenAIOAuthFetchHandler({ authFilePath: "/home/node/.codex/auth.json" });
  const server = createSidecarServer(createSidecarHandler(upstream));
  server.listen(10531, "0.0.0.0");
  const stop = () => server.close(() => process.exit(0));
  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(() => {
    console.error("The OAuth sidecar could not start.");
    process.exitCode = 1;
  });
}

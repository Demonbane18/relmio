import assert from "node:assert/strict";
import { createServer, request as httpRequest } from "node:http";
import test from "node:test";

import {
  hashGatewayToken,
  loadOpenAIGatewayConfig,
  startOpenAIGateway,
} from "../src/gateway/openai.js";

const localToken = "relmio_local_test_token_0123456789";
const platformApiKey = "sk-project-fixture-never-log-this";
const allowedOrigin = "https://app.example.test";

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      const address = server.address();
      resolve(`http://127.0.0.1:${address.port}`);
    });
  });
}

function closeServer(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
}

async function startUpstream(handler) {
  const server = createServer(handler);
  const origin = await listen(server);
  return {
    origin,
    async close() {
      await closeServer(server);
    },
  };
}

async function startGateway(t, options = {}) {
  const gateway = await startOpenAIGateway({
    host: "127.0.0.1",
    port: 0,
    platformApiKey,
    tokenVerifier: hashGatewayToken(localToken),
    allowedOrigins: [allowedOrigin],
    ...options,
  });
  t.after(() => gateway.close());
  return gateway;
}

function gatewayHeaders(overrides = {}) {
  return {
    Authorization: `Bearer ${localToken}`,
    Origin: allowedOrigin,
    ...overrides,
  };
}

function rawRequest(origin, path, options = {}) {
  const target = new URL(origin);
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: target.hostname,
        port: target.port,
        path,
        method: options.method ?? "GET",
        headers: options.headers,
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          resolve({
            status: response.statusCode,
            headers: response.headers,
            body: Buffer.concat(chunks).toString("utf8"),
          });
        });
      },
    );
    request.once("error", reject);
    if (options.body !== undefined) {
      request.write(options.body);
    }
    request.end();
  });
}

function rawConnect(origin, path, headers) {
  const target = new URL(origin);
  return new Promise((resolve, reject) => {
    const request = httpRequest({
      hostname: target.hostname,
      port: target.port,
      path,
      method: "CONNECT",
      headers,
    });
    request.once("connect", (response, socket) => {
      socket.destroy();
      resolve(response.statusCode);
    });
    request.once("response", (response) => {
      response.resume();
      resolve(response.statusCode);
    });
    request.once("error", reject);
    request.end();
  });
}

function startPausedRequest(origin, path, options = {}) {
  const target = new URL(origin);
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      {
        hostname: target.hostname,
        port: target.port,
        path,
        method: options.method ?? "GET",
        headers: options.headers,
      },
      (response) => {
        response.pause();
        resolve({ request, response });
      },
    );
    request.once("error", reject);
    request.end();
  });
}

test("health is public while every OpenAI route requires the local bearer", async (t) => {
  const upstream = await startUpstream((_request, response) => {
    response.end('{"ok":true}');
  });
  t.after(() => upstream.close());
  const gateway = await startGateway(t, { upstreamBaseUrl: upstream.origin });

  const health = await fetch(`${gateway.origin}/health`);
  assert.equal(health.status, 200);
  assert.deepEqual(await health.json(), { status: "ok" });

  const missing = await fetch(`${gateway.origin}/v1/models`, {
    headers: { Origin: allowedOrigin },
  });
  assert.equal(missing.status, 401);

  const wrong = await fetch(`${gateway.origin}/v1/models`, {
    headers: gatewayHeaders({ Authorization: "Bearer wrong-token" }),
  });
  assert.equal(wrong.status, 401);

  const accepted = await fetch(`${gateway.origin}/v1/models`, {
    headers: gatewayHeaders(),
  });
  assert.equal(accepted.status, 200);
});

test("native clients need no Origin while browser CORS stays exact", async (t) => {
  const upstream = await startUpstream((_request, response) => response.end());
  t.after(() => upstream.close());
  const gateway = await startGateway(t, { upstreamBaseUrl: upstream.origin });

  const missingOrigin = await fetch(`${gateway.origin}/v1/models`, {
    headers: { Authorization: `Bearer ${localToken}` },
  });
  assert.equal(missingOrigin.status, 200);
  assert.equal(missingOrigin.headers.get("access-control-allow-origin"), null);

  const suffixAttack = await fetch(`${gateway.origin}/v1/models`, {
    headers: gatewayHeaders({ Origin: `${allowedOrigin}.evil.test` }),
  });
  assert.equal(suffixAttack.status, 403);

  const preflight = await fetch(`${gateway.origin}/v1/responses`, {
    method: "OPTIONS",
    headers: {
      Origin: allowedOrigin,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "authorization, content-type",
    },
  });
  assert.equal(preflight.status, 204);
  assert.equal(
    preflight.headers.get("access-control-allow-origin"),
    allowedOrigin,
  );
  assert.equal(preflight.headers.get("access-control-allow-methods"), "POST");
  assert.equal(
    preflight.headers.get("access-control-allow-headers"),
    "authorization, content-type",
  );
  assert.match(preflight.headers.get("vary") ?? "", /Origin/u);

  const rejectedHeader = await fetch(`${gateway.origin}/v1/responses`, {
    method: "OPTIONS",
    headers: {
      Origin: allowedOrigin,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "authorization, x-forwarded-for",
    },
  });
  assert.equal(rejectedHeader.status, 403);

  const rejectedMethod = await fetch(`${gateway.origin}/v1/models`, {
    method: "OPTIONS",
    headers: {
      Origin: allowedOrigin,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": "authorization",
    },
  });
  assert.equal(rejectedMethod.status, 403);
});

test("an empty browser allowlist still supports authenticated native clients", async (t) => {
  const upstream = await startUpstream((_request, response) => response.end("ok"));
  t.after(() => upstream.close());
  const gateway = await startGateway(t, {
    upstreamBaseUrl: upstream.origin,
    allowedOrigins: [],
  });

  const nativeResponse = await fetch(`${gateway.origin}/v1/models`, {
    headers: { Authorization: `Bearer ${localToken}` },
  });
  assert.equal(nativeResponse.status, 200);

  const browserResponse = await fetch(`${gateway.origin}/v1/models`, {
    headers: gatewayHeaders(),
  });
  assert.equal(browserResponse.status, 403);
});

test("Host accepts only canonical loopback authorities", async (t) => {
  const upstream = await startUpstream((_request, response) => response.end("ok"));
  t.after(() => upstream.close());
  const gateway = await startGateway(t, { upstreamBaseUrl: upstream.origin });

  for (const host of [
    "localhost",
    "localhost:10531",
    "127.0.0.1",
    "127.0.0.1:10531",
    "[::1]",
    "[::1]:10531",
  ]) {
    const accepted = await rawRequest(gateway.origin, "/v1/models", {
      headers: gatewayHeaders({ Host: host }),
    });
    assert.equal(accepted.status, 200, `${host} should be accepted`);
  }

  for (const host of [
    "localhost?x",
    "localhost#x",
    "127.0.0.1:10531?x",
    "[::1]:10531#x",
  ]) {
    const rejected = await rawRequest(gateway.origin, "/v1/models", {
      headers: gatewayHeaders({ Host: host }),
    });
    assert.equal(rejected.status, 421, `${host} should be rejected`);
  }
});

test("the proxy replaces secrets, strips ambient headers, and preserves path and response metadata", async (t) => {
  let observed;
  const upstream = await startUpstream((request, response) => {
    observed = { url: request.url, headers: request.headers };
    response.writeHead(201, {
      "Content-Type": "application/json",
      Location: "https://other.example/credential",
      "Set-Cookie": "upstream=session",
      "X-Request-Id": "req_fixture",
      "Retry-After": "7",
    });
    response.end('{"created":true}');
  });
  t.after(() => upstream.close());
  const gateway = await startGateway(t, { upstreamBaseUrl: upstream.origin });

  const response = await rawRequest(gateway.origin, "/v1/responses?trace=one", {
    method: "POST",
    headers: {
      ...gatewayHeaders(),
      "Content-Type": "application/json",
      Cookie: "session=ambient",
      Forwarded: "for=192.0.2.1",
      "X-Forwarded-For": "192.0.2.1",
      "Proxy-Authorization": "Basic ambient",
      Referer: "https://app.example.test/page",
      "OpenAI-Organization": "org_client_controlled",
      "OpenAI-Project": "proj_client_controlled",
      Connection: "x-private",
      "X-Private": "must-not-cross",
    },
    body: "{}",
  });

  assert.equal(response.status, 201);
  assert.equal(response.headers["x-request-id"], "req_fixture");
  assert.equal(response.headers["retry-after"], "7");
  assert.equal(response.headers.location, undefined);
  assert.equal(response.headers["set-cookie"], undefined);
  assert.equal(response.body, '{"created":true}');
  assert.equal(observed.url, "/v1/responses?trace=one");
  assert.equal(observed.headers.authorization, `Bearer ${platformApiKey}`);
  for (const name of [
    "cookie",
    "forwarded",
    "x-forwarded-for",
    "proxy-authorization",
    "referer",
    "origin",
    "openai-organization",
    "openai-project",
    "x-private",
  ]) {
    assert.equal(observed.headers[name], undefined, `${name} must be stripped`);
  }
});

test("streaming is incremental and respects downstream cancellation", async (t) => {
  let releaseSecondChunk;
  let markUpstreamStarted;
  const upstreamStarted = new Promise((resolve) => {
    markUpstreamStarted = resolve;
  });
  let markCancelled;
  const cancelled = new Promise((resolve) => {
    markCancelled = resolve;
  });
  const upstream = await startUpstream((request, response) => {
    if (request.url === "/v1/responses?mode=cancel") {
      request.once("aborted", markCancelled);
      response.once("close", () => {
        if (!response.writableEnded) {
          markCancelled();
        }
      });
      response.write("open");
      markUpstreamStarted();
      return;
    }

    response.writeHead(200, { "Content-Type": "text/event-stream" });
    response.write("data: first\n\n");
    releaseSecondChunk = () => {
      response.end("data: second\n\n");
    };
  });
  t.after(() => upstream.close());
  const gateway = await startGateway(t, { upstreamBaseUrl: upstream.origin });

  const streamed = await fetch(`${gateway.origin}/v1/responses?mode=stream`, {
    method: "POST",
    headers: gatewayHeaders(),
  });
  const reader = streamed.body.getReader();
  const first = await Promise.race([
    reader.read(),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("first chunk was buffered")), 500),
    ),
  ]);
  assert.equal(new TextDecoder().decode(first.value), "data: first\n\n");
  releaseSecondChunk();
  const second = await reader.read();
  assert.equal(new TextDecoder().decode(second.value), "data: second\n\n");

  const cancelRequest = httpRequest(`${gateway.origin}/v1/responses?mode=cancel`, {
    method: "POST",
    headers: gatewayHeaders(),
  });
  cancelRequest.on("response", (response) => {
    response.once("data", () => cancelRequest.destroy());
  });
  cancelRequest.on("error", () => {});
  cancelRequest.end();
  await upstreamStarted;
  await Promise.race([
    cancelled,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("upstream was not cancelled")), 500),
    ),
  ]);
});

test("429 responses are untouched and transport failures are generic and secret-free", async (t) => {
  const rateLimited = await startUpstream((_request, response) => {
    response.writeHead(429, {
      "Content-Type": "application/json",
      "Retry-After": "19",
    });
    response.end('{"error":{"message":"slow down"}}');
  });
  t.after(() => rateLimited.close());
  const gateway = await startGateway(t, {
    upstreamBaseUrl: rateLimited.origin,
  });

  const response = await fetch(`${gateway.origin}/v1/responses`, {
    method: "POST",
    headers: gatewayHeaders({ "Content-Type": "application/json" }),
    body: "{}",
  });
  assert.equal(response.status, 429);
  assert.equal(response.headers.get("retry-after"), "19");
  assert.deepEqual(await response.json(), { error: { message: "slow down" } });

  const unreachable = await startGateway(t, {
    upstreamBaseUrl: "http://127.0.0.1:1",
  });
  const failed = await fetch(`${unreachable.origin}/v1/models`, {
    headers: gatewayHeaders(),
  });
  assert.equal(failed.status, 502);
  const failureText = await failed.text();
  assert.doesNotMatch(failureText, /127\.0\.0\.1:1/u);
  assert.doesNotMatch(failureText, new RegExp(platformApiKey, "u"));
  assert.doesNotMatch(failureText, new RegExp(localToken, "u"));
});

test("an upstream response-header timeout fails once and releases its concurrency slot", async (t) => {
  let upstreamCalls = 0;
  let markFirstStarted;
  const firstStarted = new Promise((resolve) => {
    markFirstStarted = resolve;
  });
  const upstream = await startUpstream((_request, response) => {
    upstreamCalls += 1;
    if (upstreamCalls === 1) {
      markFirstStarted();
      return;
    }
    response.end("ok");
  });
  t.after(() => upstream.close());
  const gateway = await startGateway(t, {
    upstreamBaseUrl: upstream.origin,
    maxConcurrentRequests: 1,
    upstreamResponseHeaderTimeoutMs: 50,
  });
  const controller = new AbortController();
  const stalled = fetch(`${gateway.origin}/v1/models`, {
    headers: gatewayHeaders(),
    signal: controller.signal,
  });

  try {
    await firstStarted;
    const overloaded = await fetch(`${gateway.origin}/v1/models`, {
      headers: gatewayHeaders(),
    });
    assert.equal(overloaded.status, 429);

    let rejectDeadline;
    const deadline = new Promise((_, reject) => {
      rejectDeadline = setTimeout(
        () => reject(new Error("upstream response headers did not time out")),
        1_000,
      );
    });
    const timedOut = await Promise.race([stalled, deadline]);
    clearTimeout(rejectDeadline);
    assert.equal(timedOut.status, 504);
    const failureText = await timedOut.text();
    assert.deepEqual(JSON.parse(failureText), {
      error: {
        code: "upstream_timeout",
        message: "The request was rejected by the local gateway.",
      },
    });
    assert.doesNotMatch(failureText, new RegExp(platformApiKey, "u"));
    assert.doesNotMatch(failureText, new RegExp(localToken, "u"));
    assert.equal(upstreamCalls, 1, "the timed-out request must not be retried");

    const afterTimeout = await fetch(`${gateway.origin}/v1/models`, {
      headers: gatewayHeaders(),
    });
    assert.equal(afterTimeout.status, 200);
    assert.equal(await afterTimeout.text(), "ok");
    assert.equal(upstreamCalls, 2);
  } finally {
    controller.abort();
    await stalled.catch(() => {});
  }
});

test("the upstream idle timeout resets for flowing bytes and releases stalled streams", async (t) => {
  let upstreamCalls = 0;
  const upstream = await startUpstream((request, response) => {
    upstreamCalls += 1;
    if (request.url === "/v1/responses?mode=active") {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write("data: first\n\n");
      setTimeout(() => response.write("data: second\n\n"), 50);
      setTimeout(() => response.end("data: third\n\n"), 100);
      return;
    }
    if (request.url === "/v1/responses?mode=idle") {
      response.writeHead(200, { "Content-Type": "text/event-stream" });
      response.write("data: partial\n\n");
      return;
    }
    response.end("ok");
  });
  t.after(() => upstream.close());
  const gateway = await startGateway(t, {
    upstreamBaseUrl: upstream.origin,
    maxConcurrentRequests: 1,
    upstreamResponseHeaderTimeoutMs: 500,
    upstreamIdleTimeoutMs: 80,
  });

  const active = await fetch(`${gateway.origin}/v1/responses?mode=active`, {
    method: "POST",
    headers: gatewayHeaders(),
  });
  assert.equal(
    await active.text(),
    "data: first\n\ndata: second\n\ndata: third\n\n",
  );

  const controller = new AbortController();
  const idle = await fetch(`${gateway.origin}/v1/responses?mode=idle`, {
    method: "POST",
    headers: gatewayHeaders(),
    signal: controller.signal,
  });
  const reader = idle.body.getReader();

  try {
    const first = await reader.read();
    assert.equal(new TextDecoder().decode(first.value), "data: partial\n\n");

    const overloaded = await fetch(`${gateway.origin}/v1/models`, {
      headers: gatewayHeaders(),
    });
    assert.equal(overloaded.status, 429);

    let rejectDeadline;
    const deadline = new Promise((_, reject) => {
      rejectDeadline = setTimeout(
        () => reject(new Error("idle upstream stream did not time out")),
        1_000,
      );
    });
    const idleResult = await Promise.race([
      reader.read().then(
        () => "ended",
        () => "aborted",
      ),
      deadline,
    ]);
    clearTimeout(rejectDeadline);
    assert.equal(idleResult, "aborted");

    const afterTimeout = await fetch(`${gateway.origin}/v1/models`, {
      headers: gatewayHeaders(),
    });
    assert.equal(afterTimeout.status, 200);
    assert.equal(await afterTimeout.text(), "ok");
    assert.equal(upstreamCalls, 3, "neither upstream request may be retried");
  } finally {
    controller.abort();
    await reader.cancel().catch(() => {});
  }
});

test("downstream backpressure times out and releases its concurrency slot", async (t) => {
  let upstreamCalls = 0;
  const floodChunk = Buffer.alloc(64 * 1024, "x");
  const upstream = await startUpstream((request, response) => {
    upstreamCalls += 1;
    if (request.url === "/v1/responses?mode=backpressure") {
      response.writeHead(200, { "Content-Type": "application/octet-stream" });
      const writeUntilBlocked = () => {
        if (response.destroyed) {
          return;
        }
        while (response.write(floodChunk)) {
          // Fill the authenticated client's receive path until gateway
          // backpressure pauses the upstream response.
        }
        response.once("drain", writeUntilBlocked);
      };
      response.once("close", () => response.off("drain", writeUntilBlocked));
      writeUntilBlocked();
      return;
    }
    response.end("ok");
  });
  t.after(() => upstream.close());
  const gateway = await startGateway(t, {
    upstreamBaseUrl: upstream.origin,
    maxConcurrentRequests: 1,
    upstreamResponseHeaderTimeoutMs: 500,
    upstreamIdleTimeoutMs: 500,
    downstreamStallTimeoutMs: 80,
  });
  const stalled = await startPausedRequest(
    gateway.origin,
    "/v1/responses?mode=backpressure",
    { method: "POST", headers: gatewayHeaders() },
  );

  try {
    const overloaded = await fetch(`${gateway.origin}/v1/models`, {
      headers: gatewayHeaders(),
    });
    assert.equal(overloaded.status, 429);

    const deadline = Date.now() + 1_000;
    let afterTimeout;
    while (!afterTimeout && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 20));
      const probe = await fetch(`${gateway.origin}/v1/models`, {
        headers: gatewayHeaders(),
      });
      if (probe.status === 200) {
        afterTimeout = probe;
      } else {
        assert.equal(probe.status, 429);
        await probe.arrayBuffer();
      }
    }

    assert.ok(afterTimeout, "downstream backpressure did not release its slot");
    assert.equal(afterTimeout.status, 200);
    assert.equal(await afterTimeout.text(), "ok");
    assert.equal(
      upstreamCalls,
      2,
      "the stalled upstream request must not be retried",
    );
  } finally {
    stalled.response.destroy();
    stalled.request.destroy();
  }
});

test("fixed-target, method, Host, path, header, body, and overload guards fail closed", async (t) => {
  let upstreamCalls = 0;
  let releaseBlocked;
  let markBlocked;
  const blocked = new Promise((resolve) => {
    markBlocked = resolve;
  });
  const upstream = await startUpstream((request, response) => {
    upstreamCalls += 1;
    if (request.url === "/v1/responses?mode=blocked") {
      response.write("holding");
      releaseBlocked = () => response.end();
      markBlocked();
      return;
    }
    response.end("ok");
  });
  t.after(() => upstream.close());
  const gateway = await startGateway(t, {
    upstreamBaseUrl: upstream.origin,
    maxHeaderBytes: 512,
    maxPathBytes: 128,
    maxBodyBytes: 16,
    maxConcurrentRequests: 1,
  });

  const common = gatewayHeaders();
  assert.equal(
    (await rawRequest(gateway.origin, "http://evil.example/v1/models", { headers: common }))
      .status,
    400,
  );
  assert.equal(
    (await rawRequest(gateway.origin, "//evil.example/v1/models", { headers: common }))
      .status,
    400,
  );
  assert.equal(
    (
      await rawRequest(gateway.origin, "/v1/models", {
        method: "TRACE",
        headers: { Origin: allowedOrigin },
      })
    ).status,
    401,
  );
  assert.equal(
    (
      await rawRequest(gateway.origin, "/v1/models", {
        method: "TRACE",
        headers: common,
      })
    ).status,
    405,
  );
  assert.equal(await rawConnect(gateway.origin, "/v1/models", common), 405);
  assert.equal(
    (
      await rawRequest(gateway.origin, "/v1/models", {
        headers: { ...common, Host: "attacker.example" },
      })
    ).status,
    421,
  );
  assert.equal(
    (await rawRequest(gateway.origin, `/v1/${"x".repeat(200)}`, { headers: common }))
      .status,
    414,
  );
  assert.equal(
    (await rawRequest(gateway.origin, "/v1/assistants", { headers: common })).status,
    404,
  );
  assert.equal(
    (
      await rawRequest(gateway.origin, "/v1/models", {
        method: "POST",
        headers: common,
      })
    ).status,
    405,
  );
  assert.equal(
    (
      await rawRequest(gateway.origin, "/v1/models", {
        headers: { ...common, "X-Filler": "x".repeat(600) },
      })
    ).status,
    431,
  );
  assert.equal(
    (
      await rawRequest(gateway.origin, "/v1/responses", {
        method: "POST",
        headers: {
          ...common,
          "Content-Length": "17",
          "Content-Type": "application/json",
        },
        body: "x".repeat(17),
      })
    ).status,
    413,
  );

  const first = fetch(`${gateway.origin}/v1/responses?mode=blocked`, {
    method: "POST",
    headers: common,
    body: "{}",
  });
  await blocked;
  const overloaded = await fetch(`${gateway.origin}/v1/models`, {
    headers: common,
  });
  assert.equal(overloaded.status, 429);
  assert.equal(overloaded.headers.get("retry-after"), "1");
  releaseBlocked();
  await (await first).arrayBuffer();

  assert.equal(upstreamCalls, 1);
});

test("CLI configuration reads secrets from a file and strictly decodes origins", async () => {
  const tokenVerifier = hashGatewayToken(localToken);
  const origins = Buffer.from(JSON.stringify([allowedOrigin])).toString("base64");
  const reads = [];
  const config = await loadOpenAIGatewayConfig(
    {
      OPENAI_API_KEY_FILE: "/run/secrets/openai_api_key",
      RELMIO_GATEWAY_TOKEN_SHA256: tokenVerifier,
      RELMIO_ALLOWED_ORIGINS_BASE64: origins,
      RELMIO_GATEWAY_HOST: "127.0.0.1",
      RELMIO_GATEWAY_PORT: "12000",
    },
    {
      async readFile(path, encoding) {
        reads.push([path, encoding]);
        return `${platformApiKey}\n`;
      },
    },
  );

  assert.deepEqual(reads, [["/run/secrets/openai_api_key", "utf8"]]);
  assert.equal(config.platformApiKey, platformApiKey);
  assert.equal(config.tokenVerifier, tokenVerifier);
  assert.deepEqual(config.allowedOrigins, [allowedOrigin]);
  assert.equal(config.host, "127.0.0.1");
  assert.equal(config.port, 12000);

  const nativeOnly = await loadOpenAIGatewayConfig(
    {
      OPENAI_API_KEY_FILE: "/run/secrets/openai_api_key",
      RELMIO_GATEWAY_TOKEN_SHA256: tokenVerifier,
      RELMIO_ALLOWED_ORIGINS_BASE64: Buffer.from("[]").toString("base64"),
    },
    { readFile: async () => platformApiKey },
  );
  assert.deepEqual(nativeOnly.allowedOrigins, []);

  await assert.rejects(
    loadOpenAIGatewayConfig(
      {
        OPENAI_API_KEY_FILE: "/run/secrets/openai_api_key",
        RELMIO_GATEWAY_TOKEN_SHA256: tokenVerifier,
        RELMIO_ALLOWED_ORIGINS_BASE64: Buffer.from(
          JSON.stringify(["https://app.example.test/path"]),
        ).toString("base64"),
      },
      { readFile: async () => platformApiKey },
    ),
    /origin configuration is invalid/u,
  );
});

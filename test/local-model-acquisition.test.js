import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import test from "node:test";
import { runLocalModelAcquisition, parseLocalModelOperationStatus } from "../src/local-model/acquisition.mjs";
import { getLocalModelDefinition } from "../src/local-model/catalog.mjs";

const modelId = "qwen3:0.6b";
const operationId = "a".repeat(32);
const digest = getLocalModelDefinition(modelId).manifestDigest;

async function runtime(t, overrides = {}) {
  let installed = overrides.installed ?? false;
  const calls = [];
  const records = [];
  const server = createServer(async (request, response) => {
    const parts = [];
    for await (const part of request) parts.push(part);
    const body = parts.length ? JSON.parse(Buffer.concat(parts)) : null;
    calls.push({ path: request.url, body });
    response.setHeader("content-type", "application/json");
    if (request.url === "/api/tags") {
      response.end(JSON.stringify({ models: installed ? [{ name: modelId, digest: overrides.manifestDigest ?? digest.slice(7), details: { quantization_level: overrides.quantization ?? "Q4_K_M" } }] : [] }));
    } else if (request.url === "/api/pull") {
      response.setHeader("content-type", "application/x-ndjson");
      if (overrides.pullText !== undefined) { response.end(overrides.pullText); return; }
      installed = true;
      response.write('{"status":"pulling","digest":"');
      response.end(`${digest}","total":200,"completed":125}\n{"status":"success"}\n`);
    } else if (request.url === "/api/chat") {
      response.end(JSON.stringify({ model: modelId, done: true, eval_count: 1, message: { content: overrides.answer ?? "4" } }));
    } else if (request.url === "/api/ps") {
      response.end(JSON.stringify({ models: [{ name: modelId, digest, context_length: overrides.context ?? 2048 }] }));
    } else {
      response.writeHead(404).end();
    }
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => { server.closeAllConnections(); server.close(); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  const run = (input = {}, dependencies = {}) => runLocalModelAcquisition({ modelId, operationId, ...input }, {
    fetchImpl: (url, options) => {
      assert.ok(url.startsWith("http://n8n-local-model:11434/"));
      assert.equal(options.redirect, "error");
      return fetch(url.replace("http://n8n-local-model:11434", origin), options);
    },
    emit: record => records.push(record), ...dependencies,
  });
  return { calls, records, run };
}

test("pull progress alone cannot mark ready: digest and real inference complete the transition", async t => {
  const harness = await runtime(t);
  const result = await harness.run();
  assert.equal(result.state, "model-ready");
  assert.equal(result.modelDigest, digest);
  assert.equal(result.inferenceVerified, true);
  assert.equal(result.writerMayBeActive, false);
  const progress = harness.records.find(record => record.completedBytes === 125);
  assert.equal(progress.totalBytes, 200);
  assert.equal(progress.inferenceVerified, false);
  const probe = harness.calls.find(call => call.path === "/api/chat").body;
  assert.equal(probe.think, false);
  assert.equal(probe.options.num_ctx, 2048);
  assert.equal(probe.options.num_predict, 16);
  assert.equal(harness.calls.filter(call => call.path === "/api/pull").length, 1);
  assert.deepEqual(parseLocalModelOperationStatus(harness.records.map(value => JSON.stringify(value)).join("\n"), { modelId, operationId }), result);
});

test("a known installed digest skips mutable-tag pulls; missing or changed identity fails before writes", async t => {
  const cached = await runtime(t, { installed: true });
  assert.equal((await cached.run({ expectedDigest: digest })).state, "model-ready");
  assert.equal(cached.calls.some(call => call.path === "/api/pull"), false);
  const mismatch = await runtime(t, { installed: true });
  const failure = await mismatch.run({ expectedDigest: `sha256:${"c".repeat(64)}` });
  assert.equal(failure.errorCode, "model-identity-changed");
  assert.equal(mismatch.calls.some(call => call.body !== null), false);
  const missing = await runtime(t);
  assert.equal((await missing.run({ expectedDigest: digest })).errorCode, "model-identity-changed");
  assert.equal(missing.calls.some(call => call.body !== null), false);
});

test("first acquisition rejects same-quantization catalog drift before inference, even after a successful pull", async t => {
  for (const installed of [false, true]) {
    const harness = await runtime(t, { installed, manifestDigest: `sha256:${"c".repeat(64)}` });
    const result = await harness.run();
    assert.equal(result.state, "model-error");
    assert.equal(result.errorCode, "model-identity-changed");
    assert.equal(result.inferenceVerified, false);
    assert.equal(harness.calls.some(call => call.path === "/api/chat"), false);
    assert.equal(harness.calls.filter(call => call.path === "/api/pull").length, installed ? 0 : 1);
  }
});

test("HTTP 200 with stream error or truncated success never retries or marks ready", async t => {
  for (const pullText of ['{"error":"private upstream detail"}\n', '{"status":"pulling manifest"}\n', "x".repeat(16385)]) {
    const harness = await runtime(t, { pullText });
    const result = await harness.run();
    assert.equal(result.state, "model-error");
    assert.equal(result.writerMayBeActive, true);
    assert.equal(harness.calls.filter(call => call.path === "/api/pull").length, 1);
    assert.equal(harness.calls.some(call => call.path === "/api/chat"), false);
    assert.ok(!JSON.stringify(harness.records).includes("private upstream detail"));
  }
});

test("download deadline terminates the helper but preserves uncertainty about the runtime writer", async () => {
  const calls = [];
  const result = await runLocalModelAcquisition({ modelId, operationId }, {
    pullTimeoutMs: 20,
    emit: () => {},
    fetchImpl: async (url, { signal }) => {
      calls.push(new URL(url).pathname);
      if (url.endsWith("/api/tags")) return Response.json({ models: [] });
      return new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
    },
  });
  assert.equal(result.errorCode, "download-timeout");
  assert.equal(result.writerMayBeActive, true);
  assert.deepEqual(calls, ["/api/tags", "/api/pull"]);
});

test("a valid long cold pull can exceed sixteen MiB of progress without losing readiness", async () => {
  const chunk = Buffer.from(`${JSON.stringify({ status: "pulling", digest, total: 6594474236, completed: 1234567890 })}\n`.repeat(64));
  const chunkCount = Math.ceil((17 * 1024 * 1024) / chunk.length);
  let emittedChunks = 0;
  let installed = false;
  let pullCalls = 0;
  const result = await runLocalModelAcquisition({ modelId, operationId }, {
    emit: () => {},
    fetchImpl: async url => {
      if (url.endsWith("/api/tags")) return Response.json({ models: installed ? [{ name: modelId, digest, details: { quantization_level: "Q4_K_M" } }] : [] });
      if (url.endsWith("/api/pull")) {
        pullCalls += 1;
        return new Response(new ReadableStream({
          pull(controller) {
            if (emittedChunks < chunkCount) {
              emittedChunks += 1;
              controller.enqueue(chunk);
            } else {
              installed = true;
              controller.enqueue(Buffer.from('{"status":"success"}\n'));
              controller.close();
            }
          },
        }));
      }
      if (url.endsWith("/api/chat")) return Response.json({ model: modelId, done: true, eval_count: 2, message: { content: "4" } });
      if (url.endsWith("/api/ps")) return Response.json({ models: [{ name: modelId, digest, context_length: 2048 }] });
      throw new Error("Unexpected runtime route.");
    },
  });
  assert.equal(result.state, "model-ready");
  assert.equal(result.inferenceVerified, true);
  assert.equal(result.modelDigest, digest);
  assert.equal(pullCalls, 1);
  assert.equal(emittedChunks, chunkCount);
});

test("empty, reasoning-only or incorrect inference and excessive effective context cannot become ready", async t => {
  for (const overrides of [{ answer: "" }, { answer: "2" }, { answer: "<think>4</think>" }, { context: 32768 }]) {
    const harness = await runtime(t, { installed: true, ...overrides });
    const result = await harness.run();
    assert.equal(result.state, "model-error");
    assert.equal(result.modelDigest, digest);
    assert.equal(result.inferenceVerified, false);
    assert.equal(result.writerMayBeActive, false);
    assert.equal(harness.calls.filter(call => call.path === "/api/chat").length, 1);
  }
});

test("catalog quantization drift fails without pulling or executing inference", async t => {
  const harness = await runtime(t, { installed: true, quantization: "F16" });
  assert.equal((await harness.run()).errorCode, "quantization-changed");
  assert.equal(harness.calls.some(call => call.body !== null), false);
});

test("operation status cannot be forged from another operation, arbitrary fields or liveness alone", async t => {
  const harness = await runtime(t, { installed: true });
  const ready = await harness.run();
  for (const changes of [
    { operationId: "c".repeat(32) }, { modelId: "qwen3:1.7b" }, { inferenceVerified: false },
    { modelDigest: null }, { writerMayBeActive: true }, { secret: "do not copy" },
    { completedBytes: 2, totalBytes: 1 }, { updatedAt: "yesterday" },
  ]) assert.throws(() => parseLocalModelOperationStatus(JSON.stringify({ ...ready, ...changes }), { modelId, operationId }));
  assert.throws(() => parseLocalModelOperationStatus(" ".repeat(65537), { modelId, operationId }));
  assert.throws(() => parseLocalModelOperationStatus(JSON.stringify(ready).repeat(257), { modelId, operationId }));
});

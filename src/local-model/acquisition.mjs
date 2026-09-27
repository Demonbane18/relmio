import { pathToFileURL } from "node:url";
import { getLocalModelDefinition } from "./catalog.mjs";

const ORIGIN = "http://n8n-local-model:11434";
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const OPERATION = /^[a-f0-9]{32}$/u;
const MAX_LINE_BYTES = 16 * 1024;
const MAX_JSON_BYTES = 256 * 1024;
const ERROR_CODES = new Set([
  "runtime-unavailable", "invalid-response", "download-failed", "download-timeout",
  "model-missing", "model-identity-changed", "quantization-changed", "inference-failed",
  "inference-timeout", "context-budget-exceeded",
]);
const STATUS_KEYS = ["schema", "operationId", "modelId", "state", "phase", "completedBytes", "totalBytes", "blobDigest", "modelDigest", "inferenceVerified", "errorCode", "writerMayBeActive", "updatedAt"];

function fail(code) {
  const error = new Error(code);
  error.code = code;
  throw error;
}

function normalizeDigest(value) {
  if (typeof value !== "string") fail("invalid-response");
  const digest = value.startsWith("sha256:") ? value : `sha256:${value}`;
  if (!DIGEST.test(digest)) fail("invalid-response");
  return digest;
}

function validBytes(value) {
  return value === null || (Number.isSafeInteger(value) && value >= 0);
}

function validateStatus(value, { modelId, operationId }) {
  if (!value || typeof value !== "object" || Array.isArray(value) ||
      Object.keys(value).length !== STATUS_KEYS.length || STATUS_KEYS.some(key => !Object.hasOwn(value, key)) ||
      value.schema !== 1 || value.modelId !== modelId || value.operationId !== operationId ||
      !validBytes(value.completedBytes) || !validBytes(value.totalBytes) ||
      (value.completedBytes !== null && value.totalBytes !== null && value.completedBytes > value.totalBytes) ||
      !(value.blobDigest === null || DIGEST.test(value.blobDigest)) ||
      !(value.modelDigest === null || DIGEST.test(value.modelDigest)) ||
      typeof value.writerMayBeActive !== "boolean" || typeof value.inferenceVerified !== "boolean" ||
      typeof value.updatedAt !== "string" || !Number.isFinite(Date.parse(value.updatedAt)) ||
      new Date(value.updatedAt).toISOString() !== value.updatedAt) fail("invalid-response");
  const phases = { downloading: "download", verifying: "inference", "model-ready": "complete", "model-error": "error" };
  if (!Object.hasOwn(phases, value.state) || phases[value.state] !== value.phase ||
      (value.state === "model-error" ? !ERROR_CODES.has(value.errorCode) : value.errorCode !== null) ||
      value.inferenceVerified !== (value.state === "model-ready") ||
      ((value.state === "verifying" || value.state === "model-ready") && (value.modelDigest === null || value.writerMayBeActive)) ||
      (value.state === "downloading" && !value.writerMayBeActive)) fail("invalid-response");
  return value;
}

// Docker reads are bounded by the caller as well; never accept arbitrary log text.
export function parseLocalModelOperationStatus(log, { modelId, operationId }) {
  getLocalModelDefinition(modelId);
  if (!OPERATION.test(operationId) || typeof log !== "string" || Buffer.byteLength(log) > 65536) fail("invalid-response");
  const lines = log.trim().split("\n");
  if (lines.length > 256 || !lines[0]) fail("invalid-response");
  let status;
  for (const line of lines) {
    if (Buffer.byteLength(line) > MAX_LINE_BYTES) fail("invalid-response");
    let value;
    try { value = JSON.parse(line); } catch { fail("invalid-response"); }
    status = validateStatus(value, { modelId, operationId });
  }
  return status;
}

async function readJson(response) {
  if (!response.ok || !response.body) fail("runtime-unavailable");
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    size += chunk.byteLength;
    if (size > MAX_JSON_BYTES) fail("invalid-response");
    chunks.push(chunk);
  }
  let parsed;
  try { parsed = JSON.parse(Buffer.concat(chunks, size).toString("utf8")); } catch { fail("invalid-response"); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed) || Object.hasOwn(parsed, "error")) fail("invalid-response");
  return parsed;
}

async function consumePull(response, onProgress) {
  if (!response.ok || !response.body) fail("download-failed");
  let pending = Buffer.alloc(0);
  let success = false;
  function consume(line) {
    if (!line.length) return;
    if (success) fail("invalid-response");
    let record;
    try { record = JSON.parse(line.toString("utf8")); } catch { fail("invalid-response"); }
    if (!record || typeof record !== "object" || Array.isArray(record)) fail("invalid-response");
    if (Object.hasOwn(record, "error")) fail("download-failed");
    if (typeof record.status !== "string" || record.status.length > 512) fail("invalid-response");
    if (record.status === "success") { success = true; return; }
    const totalBytes = record.total ?? null;
    const completedBytes = record.completed ?? null;
    if (!validBytes(totalBytes) || !validBytes(completedBytes) ||
        (totalBytes !== null && completedBytes !== null && completedBytes > totalBytes)) fail("invalid-response");
    onProgress({ totalBytes, completedBytes, blobDigest: record.digest ? normalizeDigest(record.digest) : null });
  }
  for await (const chunk of response.body) {
    const bytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    let offset = 0;
    while (offset < bytes.length) {
      const newline = bytes.indexOf(10, offset);
      const end = newline === -1 ? bytes.length : newline;
      const segment = bytes.subarray(offset, end);
      if (pending.length + segment.length > MAX_LINE_BYTES) fail("invalid-response");
      const line = pending.length ? Buffer.concat([pending, segment]) : segment;
      if (newline === -1) {
        // Copy only the incomplete record, never retain a large network chunk.
        pending = Buffer.from(line);
        break;
      }
      consume(line);
      pending = Buffer.alloc(0);
      offset = newline + 1;
    }
  }
  consume(pending);
  if (!success) fail("download-failed");
}

function findInstalled(tags, model) {
  if (!Array.isArray(tags.models) || tags.models.length > 128) fail("invalid-response");
  const matches = tags.models.filter(item => item && (item.name === model.id || item.model === model.id));
  if (matches.length > 1) fail("invalid-response");
  if (!matches.length) return null;
  const found = matches[0];
  const digest = normalizeDigest(found.digest);
  if (digest !== model.manifestDigest) fail("model-identity-changed");
  if (found.details?.quantization_level !== model.quantization) fail("quantization-changed");
  return digest;
}

// Inject transport for focused proof, never expose a production URL override.
export async function runLocalModelAcquisition({ modelId, operationId, expectedDigest = null }, {
  fetchImpl = globalThis.fetch,
  emit = value => process.stdout.write(`${JSON.stringify(value)}\n`),
  now = Date.now,
  pullTimeoutMs = 2 * 60 * 60 * 1000,
  inferenceTimeoutMs = 5 * 60 * 1000,
} = {}) {
  const model = getLocalModelDefinition(modelId);
  if (!OPERATION.test(operationId) || (expectedDigest !== null && !DIGEST.test(expectedDigest))) throw new TypeError("Local model operation identity is invalid.");
  if (!Number.isInteger(pullTimeoutMs) || pullTimeoutMs < 1 || pullTimeoutMs > 7200000 ||
      !Number.isInteger(inferenceTimeoutMs) || inferenceTimeoutMs < 1 || inferenceTimeoutMs > 300000) throw new TypeError("Local model operation deadline is invalid.");
  let status = {
    schema: 1, operationId, modelId, state: "downloading", phase: "download",
    completedBytes: null, totalBytes: null, blobDigest: null, modelDigest: null,
    inferenceVerified: false, errorCode: null, writerMayBeActive: true,
    updatedAt: new Date(now()).toISOString(),
  };
  let writerMayBeActive = false;
  let stage = "download";
  let lastEmission = -Infinity;
  const controller = new AbortController();
  let timer = setTimeout(() => controller.abort(), pullTimeoutMs);
  function publish(changes) {
    status = { ...status, ...changes, updatedAt: new Date(now()).toISOString() };
    validateStatus(status, { modelId, operationId });
    emit(status);
    lastEmission = now();
  }
  async function request(path, body) {
    return fetchImpl(`${ORIGIN}${path}`, {
      method: body === undefined ? "GET" : "POST", redirect: "error", signal: controller.signal,
      ...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
    });
  }
  try {
    let digest = findInstalled(await readJson(await request("/api/tags")), model);
    if (expectedDigest !== null && digest !== expectedDigest) fail("model-identity-changed");
    if (!digest) {
      writerMayBeActive = true;
      publish({});
      await consumePull(await request("/api/pull", { model: model.id, stream: true }), progress => {
        if (now() - lastEmission >= 1000 || progress.blobDigest !== status.blobDigest) publish(progress);
      });
      writerMayBeActive = false;
      digest = findInstalled(await readJson(await request("/api/tags")), model);
      if (!digest) fail("model-missing");
    }
    stage = "inference";
    clearTimeout(timer);
    timer = setTimeout(() => controller.abort(), inferenceTimeoutMs);
    publish({ state: "verifying", phase: "inference", modelDigest: digest, writerMayBeActive: false, completedBytes: null, totalBytes: null, blobDigest: null });
    const answer = await readJson(await request("/api/chat", {
      model: model.id, stream: false, think: false, keep_alive: "1m",
      messages: [{ role: "user", content: "What is 2 + 2? Reply with only the digit 4." }],
      options: { num_ctx: model.contextTokens, num_predict: 16, temperature: 0, num_gpu: 0 },
    }));
    if (answer.done !== true || answer.model !== model.id || !Number.isSafeInteger(answer.eval_count) || answer.eval_count <= 0 ||
        typeof answer.message?.content !== "string" || !/^\s*4[.!]?\s*$/u.test(answer.message.content)) fail("inference-failed");
    const running = await readJson(await request("/api/ps"));
    if (!Array.isArray(running.models)) fail("invalid-response");
    const active = running.models.filter(item => item && (item.name === model.id || item.model === model.id));
    if (active.length !== 1 || normalizeDigest(active[0].digest) !== digest) fail("model-identity-changed");
    if (!Number.isSafeInteger(active[0].context_length) || active[0].context_length < 1 || active[0].context_length > model.contextTokens) fail("context-budget-exceeded");
    // Detect a tag changing during the inference probe rather than blessing stale identity.
    if (findInstalled(await readJson(await request("/api/tags")), model) !== digest) fail("model-identity-changed");
    publish({ state: "model-ready", phase: "complete", inferenceVerified: true });
  } catch (error) {
    const errorCode = controller.signal.aborted ? `${stage}-timeout` :
      ERROR_CODES.has(error?.code) ? error.code : "runtime-unavailable";
    controller.abort();
    publish({ state: "model-error", phase: "error", inferenceVerified: false, errorCode, writerMayBeActive });
  } finally {
    clearTimeout(timer);
    controller.abort();
  }
  return status;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const args = process.argv.slice(2);
  if (args.length < 2 || args.length > 3) {
    process.stderr.write("Invalid local model acquisition arguments.\n");
    process.exitCode = 1;
  } else {
    try {
      const status = await runLocalModelAcquisition({ modelId: args[0], operationId: args[1], expectedDigest: args[2] ?? null });
      process.exitCode = status.state === "model-ready" ? 0 : 1;
    } catch {
      process.stderr.write("Invalid local model acquisition arguments.\n");
      process.exitCode = 1;
    }
  }
}

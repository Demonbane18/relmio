import { spawn } from "node:child_process";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { userInfo } from "node:os";
import { isAbsolute, normalize } from "node:path";

const MAX_HEADER_BYTES = 16 * 1024;
const MAX_BODY_BYTES = 16 * 1024;
const MAX_INPUT_BYTES = 12 * 1024;
const MAX_COMPLETION_BODY_BYTES = 256 * 1024;
const MAX_COMPLETION_INPUT_BYTES = 192 * 1024;
const MAX_OUTPUT_BYTES = 128 * 1024;
const MAX_LINE_BYTES = 256 * 1024;
const MAX_STDOUT_BYTES = 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const MAX_BUFFERED_RESPONSE_BYTES = 6 * MAX_OUTPUT_BYTES + 64 * 1024; // Worst-case JSON escaping plus envelope.
// Built-in mods observed in Claude Code 2.1.317 init. They ship inside the pinned official binary and
// --safe-mode does not stop them; any other plugin is third-party code and fails closed.
const BUILTIN_PLUGINS = new Set(["cc-plugin-agents-md", "cc-plugin-privacy", "cc-plugin-plugin-authoring"]);
// Private Docker companion: the only hostname n8n may use for this adapter. Never a bind address.
export const COMPANION_HOST = /^[a-z][a-z0-9-]{0,62}$/u;
const ERROR_STATUS = Object.freeze({
  unauthorized: 401,
  login_required: 401,
  forbidden: 403,
  invalid_request: 400,
  unsupported_parameter: 400,
  model_not_found: 404,
  busy: 409,
  provider_quota: 429,
  billing_required: 502,
  model_unavailable: 502,
  upstream_failed: 502,
  invalid_upstream: 502,
  timeout: 504,
  unexpected_tools: 502,
  runtime_mismatch: 502,
  cleanup_failed: 503,
});

function failure(code, status = ERROR_STATUS[code], param = null) {
  return Object.assign(new Error(code), { code, status, param });
}

function safeFailure(error) {
  return Object.hasOwn(ERROR_STATUS, error?.code ?? "")
    ? failure(error.code, error.status ?? ERROR_STATUS[error.code], error.param ?? null)
    : failure("upstream_failed");
}

function failedBody(code) {
  return { status: "failed", resolvedModel: null, error: { code } };
}

function completionError(code, param = null) {
  let type = "server_error";
  let message = "Native Claude did not complete the request.";
  if (code === "unauthorized" || code === "login_required") {
    type = "authentication_error";
    message = code === "unauthorized" ? "Local authentication failed." : "Native Claude login is required.";
  } else if (code === "forbidden") {
    type = "permission_error";
    message = "Use the authenticated same-host loopback endpoint without an Origin header.";
  } else if (["invalid_request", "unsupported_parameter", "model_not_found", "busy"].includes(code)) {
    type = "invalid_request_error";
    message = {
      invalid_request: "The text-only chat request is invalid.",
      unsupported_parameter: "The requested parameter is not supported by this text-only endpoint.",
      model_not_found: "The requested model is not an approved Claude model.",
      busy: "Claude is busy. Submit one request at a time; do not retry automatically.",
    }[code];
  } else if (code === "provider_quota") {
    type = "rate_limit_error";
    message = "Native Claude rejected the request because of its rate or quota limit.";
  } else if (code === "timeout") message = "The Claude request timed out.";
  return { error: { message, type, code: code === "provider_quota" ? "rate_limit_exceeded" : code, param } };
}

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validText(value) {
  return typeof value === "string" && value.isWellFormed() && !value.includes("\0");
}

function identifier(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,256}$/u.test(value);
}

function validateRuntime(runtime) {
  const fields = ["executable", "cwd", "home", "configDir", "version", "models"];
  if (!object(runtime) || Object.keys(runtime).length !== fields.length ||
      fields.some((key) => !Object.hasOwn(runtime, key))) {
    throw new TypeError("Claude runtime configuration is invalid.");
  }
  for (const key of ["executable", "cwd", "home", "configDir"]) {
    const value = runtime[key];
    if (!validText(value) || value.length > 4096 || !isAbsolute(value) ||
        value === "/" || normalize(value) !== value || /[\r\n]/u.test(value)) {
      throw new TypeError("Claude runtime paths must be fixed absolute paths.");
    }
  }
  const models = Array.isArray(runtime.models) ? [...runtime.models] : [];
  if (runtime.version !== "2.1.317" || models.length < 1 || models.length > 8 ||
      new Set(models).size !== models.length || models.some((model) => typeof model !== "string" ||
        model.length > 128 || !/^claude-[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(model) || model.includes("fable"))) {
    throw new TypeError("An exact qualified Claude version and approved model list are required.");
  }
  return { ...runtime, models };
}

function headerCount(request, name) {
  let count = 0;
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index].toLowerCase() === name) count += 1;
  }
  return count;
}

function authorized(request, verifier) {
  const value = request.headers.authorization;
  if (headerCount(request, "authorization") !== 1 || typeof value !== "string" ||
      !/^Bearer [A-Za-z0-9_-]{32,256}$/u.test(value)) return false;
  return timingSafeEqual(createHash("sha256").update(value.slice(7)).digest(), verifier);
}

function readJsonRequest(request, maxBytes, signal, timeoutMs) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("error", onError);
      signal.removeEventListener("abort", onAbort);
      if (error) {
        request.pause();
        reject(error);
      } else resolve(value);
    };
    const onAbort = () => finish(safeFailure(signal.reason));
    const onError = () => finish(failure("invalid_request"));
    const onData = (chunk) => {
      bytes += chunk.length;
      if (bytes > maxBytes) finish(failure("invalid_request", 413));
      else chunks.push(chunk);
    };
    const onEnd = () => {
      let body;
      try {
        body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)));
      } catch {
        finish(failure("invalid_request"));
        return;
      }
      finish(null, body);
    };
    const timer = setTimeout(() => finish(failure("timeout", 408)), timeoutMs);
    request.on("data", onData);
    request.once("end", onEnd);
    request.once("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

function validatePromptRequest(body, models) {
  if (!object(body) || !Object.hasOwn(body, "input") ||
      Object.keys(body).some((key) => key !== "input" && key !== "model") ||
      !validText(body.input) || body.input.trim() === "") throw failure("invalid_request");
  const model = Object.hasOwn(body, "model") ? models.find((model) => model === body.model) : models[0];
  if (!model) throw failure("invalid_request");
  if (Buffer.byteLength(body.input) > MAX_INPUT_BYTES) throw failure("invalid_request", 413);
  return { input: body.input, model };
}

const COMPLETION_FIELDS = new Set([
  "model", "messages", "stream", "stream_options", "temperature", "top_p", "frequency_penalty",
  "presence_penalty", "max_tokens", "max_completion_tokens", "stop", "seed", "user", "metadata",
  "store", "service_tier", "reasoning_effort", "tools", "tool_choice", "parallel_tool_calls",
  "response_format", "n", "logprobs", "top_logprobs", "functions", "function_call", "audio",
  "modalities", "prediction", "web_search_options",
]);

function validateCompletionRequest(body, models) {
  const invalid = (param) => { throw failure("invalid_request", 400, param); };
  const unsupported = (param) => { throw failure("unsupported_parameter", 400, param); };
  if (!object(body)) invalid(null);
  // Unknown keys are not echoed: a caller can put secrets in a field name.
  if (Object.keys(body).some((key) => !COMPLETION_FIELDS.has(key))) unsupported(null);
  if (!validText(body.model) || !body.model) invalid("model");
  const model = models.find((model) => model === body.model);
  if (!model) throw failure("model_not_found", 404, "model");
  if (!Array.isArray(body.messages) || body.messages.length === 0 || body.messages.length > 1024) invalid("messages");
  for (const key of ["functions", "function_call", "top_logprobs", "audio", "prediction", "web_search_options"]) {
    if (Object.hasOwn(body, key)) unsupported(key);
  }
  if (body.tools !== undefined && (!Array.isArray(body.tools) || body.tools.length !== 0)) unsupported("tools");
  if (body.tool_choice !== undefined && body.tool_choice !== "none") unsupported("tool_choice");
  if (body.parallel_tool_calls !== undefined && body.parallel_tool_calls !== false) unsupported("parallel_tool_calls");
  if (body.n !== undefined && body.n !== 1) unsupported("n");
  if (body.logprobs !== undefined && body.logprobs !== false) unsupported("logprobs");
  if (body.response_format !== undefined && (!object(body.response_format) ||
      Object.keys(body.response_format).length !== 1 || body.response_format.type !== "text")) unsupported("response_format");
  if (body.modalities !== undefined && (!Array.isArray(body.modalities) ||
      body.modalities.length !== 1 || body.modalities[0] !== "text")) unsupported("modalities");
  if (body.stream !== undefined && typeof body.stream !== "boolean") invalid("stream");
  if (body.stream_options !== undefined && (!object(body.stream_options) ||
      Object.keys(body.stream_options).length !== 1 || typeof body.stream_options.include_usage !== "boolean" ||
      body.stream !== true)) invalid("stream_options");
  // Sampling, token limits and the remaining compatibility fields are validated but never applied.
  for (const [key, min, max] of [["temperature", 0, 2], ["top_p", 0, 1],
    ["frequency_penalty", -2, 2], ["presence_penalty", -2, 2]]) {
    if (body[key] !== undefined && (!Number.isFinite(body[key]) || body[key] < min || body[key] > max)) invalid(key);
  }
  for (const key of ["max_tokens", "max_completion_tokens"]) {
    if (body[key] !== undefined && (!Number.isSafeInteger(body[key]) || body[key] < 1)) invalid(key);
  }
  if (body.max_tokens !== undefined && body.max_completion_tokens !== undefined) invalid("max_completion_tokens");
  if (body.seed !== undefined && !Number.isSafeInteger(body.seed)) invalid("seed");
  if (body.stop !== undefined && !(validText(body.stop) ||
      (Array.isArray(body.stop) && body.stop.length > 0 && body.stop.length <= 4 && body.stop.every(validText)))) invalid("stop");
  if (body.user !== undefined && !validText(body.user)) invalid("user");
  if (body.store !== undefined && typeof body.store !== "boolean") invalid("store");
  if (body.metadata !== undefined && (!object(body.metadata) || Object.keys(body.metadata).length > 16 ||
      Object.entries(body.metadata).some(([key, value]) => !validText(key) || key.length > 64 ||
        !validText(value) || value.length > 512))) invalid("metadata");
  if (body.service_tier !== undefined && !["auto", "default", "flex", "priority", "scale"].includes(body.service_tier)) invalid("service_tier");
  if (body.reasoning_effort !== undefined && !["none", "minimal", "low", "medium", "high", "xhigh"].includes(body.reasoning_effort)) invalid("reasoning_effort");
  const instructions = [];
  const turns = [];
  for (const [index, message] of body.messages.entries()) {
    const param = `messages[${index}]`;
    if (!object(message)) invalid(param);
    for (const key of ["tool_calls", "function_call", "tool_call_id"]) {
      if (Object.hasOwn(message, key)) unsupported(`${param}.${key}`);
    }
    if (Object.keys(message).some((key) => !["role", "content", "name"].includes(key))) unsupported(param);
    if (!["system", "developer", "user", "assistant"].includes(message.role)) unsupported(`${param}.role`);
    if (message.name !== undefined && !validText(message.name)) invalid(`${param}.name`);
    let content = message.content;
    if (Array.isArray(content)) {
      if (content.length === 0) invalid(`${param}.content`);
      content = content.map((part) => {
        if (!object(part) || part.type !== "text" || Object.keys(part).some((key) => !["type", "text"].includes(key))) {
          unsupported(`${param}.content`);
        }
        if (!validText(part.text)) invalid(`${param}.content`);
        return part.text;
      }).join("");
    }
    if (!validText(content) || content.trim() === "") invalid(`${param}.content`);
    if (message.role === "system" || message.role === "developer") instructions.push(content);
    else turns.push(body.messages.length === 1 ? content : `${message.role === "user" ? "User" : "Assistant"}: ${content}`);
  }
  if (body.messages.at(-1).role !== "user") invalid("messages");
  // ponytail: one transcript prompt, not native history; use a conversation protocol if that becomes required.
  const input = `${instructions.length ? `Instructions:\n${instructions.join("\n\n")}\n\n` : ""}${turns.join("\n\n")}`;
  if (Buffer.byteLength(input) > MAX_COMPLETION_INPUT_BYTES) throw failure("invalid_request", 413, "messages");
  return { input, model, stream: body.stream === true, includeUsage: body.stream_options?.include_usage === true };
}

async function writeResponse(response, contents, signal, timeoutMs) {
  signal?.throwIfAborted();
  if (response.destroyed || response.writableEnded) throw failure("upstream_failed");
  if (response.writableLength + Buffer.byteLength(contents) > MAX_BUFFERED_RESPONSE_BYTES) {
    throw failure("timeout");
  }
  if (response.write(contents)) return;
  await new Promise((resolve, reject) => {
    const finish = (error) => {
      clearTimeout(timer);
      response.off("drain", onDrain);
      response.off("close", onClose);
      response.off("error", onClose);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    };
    const onDrain = () => finish();
    const onClose = () => finish(failure("upstream_failed"));
    const onAbort = () => finish(safeFailure(signal.reason));
    const timer = setTimeout(() => finish(failure("timeout")), timeoutMs);
    response.once("drain", onDrain);
    response.once("close", onClose);
    response.once("error", onClose);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    else if (response.destroyed) onClose();
  });
}

function finishResponse(response, signal, timeoutMs) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      response.off("finish", onFinish);
      response.off("close", onClose);
      response.off("error", onClose);
      signal?.removeEventListener("abort", onAbort);
      if (error) {
        response.destroy();
        reject(error);
      } else resolve();
    };
    const onFinish = () => finish();
    const onClose = () => finish(failure("upstream_failed"));
    const onAbort = () => finish(safeFailure(signal.reason));
    const timer = setTimeout(() => finish(failure("timeout")), timeoutMs);
    response.once("finish", onFinish);
    response.once("close", onClose);
    response.once("error", onClose);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) onAbort();
    else if (response.destroyed) onClose();
    else if (response.writableFinished) onFinish();
    else {
      try { if (!response.writableEnded) response.end(); }
      catch { onClose(); }
    }
  });
}

async function sendJson(response, status, body, signal, timeoutMs) {
  const contents = JSON.stringify(body);
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(contents),
    "Cache-Control": "no-store",
    "Connection": "close",
    "X-Content-Type-Options": "nosniff",
  });
  await writeResponse(response, contents, signal, timeoutMs);
  await finishResponse(response, signal, timeoutMs);
}

function startStream(response) {
  response.writeHead(200, {
    "Content-Type": "text/event-stream; charset=utf-8",
    "Cache-Control": "no-store",
    "Connection": "close",
    "X-Accel-Buffering": "no",
    "X-Content-Type-Options": "nosniff",
  });
  response.flushHeaders();
}

function nativeError(error, status) {
  if (status === 401 || status === 403 ||
      ["authentication_failed", "oauth_org_not_allowed", "account_on_hold", "cloud_credential_error"].includes(error)) {
    return failure("login_required");
  }
  if (status === 429 || error === "rate_limit") return failure("provider_quota");
  if (error === "billing_error") return failure("billing_required");
  if (error === "model_not_found") return failure("model_unavailable");
  return null;
}

function sanitizedUsage(value) {
  if (!object(value)) return null;
  const result = {};
  for (const key of ["input_tokens", "output_tokens", "cache_creation_input_tokens", "cache_read_input_tokens"]) {
    if (Number.isSafeInteger(value[key]) && value[key] >= 0) result[key] = value[key];
  }
  return Object.keys(result).length ? result : null;
}

function completionUsage(usage) {
  if (usage?.input_tokens === undefined || usage?.output_tokens === undefined) return null;
  const prompt_tokens = usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0);
  const completion_tokens = usage.output_tokens;
  const total_tokens = prompt_tokens + completion_tokens;
  if (!Number.isSafeInteger(total_tokens)) return null;
  return { prompt_tokens, completion_tokens, total_tokens };
}

function checkBlock(block) {
  if (!object(block) || typeof block.type !== "string") throw failure("invalid_upstream");
  if (["tool_use", "server_tool_use", "tool_result"].includes(block.type) || block.type.endsWith("_tool_result")) {
    throw failure("unexpected_tools");
  }
  if (block.type === "text" && validText(block.text)) return;
  if (block.type === "thinking" && validText(block.thinking) &&
      (block.signature === undefined || validText(block.signature))) return;
  if (block.type === "redacted_thinking" && validText(block.data)) return;
  throw failure("invalid_upstream");
}

// Stream deltas own text. Complete per-block snapshots only validate it.
function createProtocol(runtime, model, requestId, onDelta) {
  let sessionId = null;
  let initialized = false;
  let current = null;
  let terminal = null;
  let commandUuid = null;
  let outputBytes = 0;
  const text = [];
  const messages = new Map();
  const append = async (part) => {
    if (!validText(part)) throw failure("invalid_upstream");
    outputBytes += Buffer.byteLength(part);
    if (outputBytes > MAX_OUTPUT_BYTES) throw failure("invalid_upstream");
    text.push(part);
    if (part) await onDelta(part);
  };
  const checkModel = (reported) => {
    if (reported !== model) throw failure("runtime_mismatch");
  };
  // Tool, subagent or command activity is never acceptable, even on record types we otherwise ignore.
  const toolSignals = (record) => {
    if (["user", "control_request", "control_response", "tool_progress", "tool_use_summary", "permission_denied"].includes(record.type) ||
        (record.type === "system" && /^(?:hook_|task_|background_|plugin_|control_request_|local_command|files_persisted|memory_recall)/u.test(record.subtype ?? ""))) {
      throw failure("unexpected_tools");
    }
    if ((record.parent_tool_use_id !== undefined && record.parent_tool_use_id !== null) ||
        record.agent_id !== undefined || record.tool_use_result !== undefined ||
        record.deferred_tool_use !== undefined || record.local_command !== undefined) {
      throw failure("unexpected_tools");
    }
    // Auth or cloud helper output means a helper command ran; an empty report is ordinary metadata.
    if (record.type === "auth_status" && record.output !== undefined &&
        !(Array.isArray(record.output) && record.output.length === 0)) throw failure("unexpected_tools");
    // Our one stdin message is one native command; a second command id means queued or injected work.
    if (record.type === "command_lifecycle") {
      commandUuid ??= record.command_uuid;
      if (record.command_uuid !== commandUuid) throw failure("unexpected_tools");
    }
  };
  const common = (record) => {
    if (terminal) throw failure("invalid_upstream");
    toolSignals(record);
    if ((record.user_message_uuid !== undefined && record.user_message_uuid !== requestId) ||
        (record.user_message_uuids !== undefined &&
          (!Array.isArray(record.user_message_uuids) || record.user_message_uuids.length !== 1 ||
           record.user_message_uuids[0] !== requestId)) || record.resume_reason !== undefined ||
        record.origin !== undefined) throw failure("invalid_upstream");
    if (record.aborted !== undefined && record.aborted !== false) throw failure("upstream_failed");
    if (record.fast_mode_state !== undefined && record.fast_mode_state !== "off") {
      throw failure("runtime_mismatch");
    }
    if (sessionId !== null && record.session_id !== sessionId) throw failure("invalid_upstream");
  };
  const stream = async (record) => {
    if (record.parent_tool_use_id !== null || !object(record.event)) throw failure("invalid_upstream");
    const event = record.event;
    if (event.type === "ping") return;
    if (event.type === "error") {
      throw nativeError(event.error?.type, event.error?.status) ?? failure("upstream_failed");
    }
    if (event.type === "content_block_start") checkBlock(event.content_block);
    if (event.type === "content_block_delta" && event.delta?.type === "input_json_delta") {
      throw failure("unexpected_tools");
    }
    if (event.type === "message_start") {
      const message = event.message;
      if (Array.isArray(message?.content)) message.content.forEach(checkBlock);
      if (current || !object(message) || !identifier(message.id) || messages.has(message.id) ||
          (message.role !== undefined && message.role !== "assistant") ||
          !Array.isArray(message.content) || message.content.length !== 0) throw failure("invalid_upstream");
      checkModel(message.model);
      current = { id: message.id, blocks: new Map(), stopped: false, stopReason: null, snapshotOnly: false };
      messages.set(message.id, current);
      return;
    }
    if (!current || current.snapshotOnly || current.stopped) throw failure("invalid_upstream");
    if (event.type === "content_block_start") {
      if (!Number.isSafeInteger(event.index) || event.index !== current.blocks.size || event.index > 1023 ||
          [...current.blocks.values()].some((block) => !block.stopped)) throw failure("invalid_upstream");
      const source = event.content_block;
      const block = { type: source.type, text: source.type === "text" ? source.text : "", stopped: false, snapshot: false };
      current.blocks.set(event.index, block);
      if (block.type === "text") await append(block.text);
      return;
    }
    if (event.type === "content_block_delta") {
      const block = current.blocks.get(event.index);
      const delta = event.delta;
      if (!block || block.stopped || block.snapshot || !object(delta)) throw failure("invalid_upstream");
      if (block.type === "text" && delta.type === "text_delta" && validText(delta.text)) {
        block.text += delta.text;
        await append(delta.text);
      } else if (block.type === "thinking" && delta.type === "thinking_delta" && validText(delta.thinking)) {
        // Thinking and signatures stay native; stdout limits also bound discarded data.
      } else if (block.type === "thinking" && delta.type === "signature_delta" && validText(delta.signature)) {
        // No thinking/signature payload enters the HTTP response.
      } else throw failure("invalid_upstream");
      return;
    }
    if (event.type === "content_block_stop") {
      const block = current.blocks.get(event.index);
      if (!block || block.stopped || (block.type === "text" && block.text && !block.snapshot)) {
        throw failure("invalid_upstream");
      }
      block.stopped = true;
      return;
    }
    if (event.type === "message_delta") {
      if (!object(event.delta) || [...current.blocks.values()].some((block) => !block.stopped)) {
        throw failure("invalid_upstream");
      }
      if (event.delta.stop_reason != null) {
        if (event.delta.stop_reason !== "end_turn" || current.stopReason !== null) throw failure("upstream_failed");
        current.stopReason = event.delta.stop_reason;
      }
      return;
    }
    if (event.type === "message_stop") {
      if (current.stopReason !== "end_turn" || current.blocks.size === 0 ||
          [...current.blocks.values()].some((block) => !block.stopped)) throw failure("invalid_upstream");
      current.stopped = true;
      current = null;
      return;
    }
    throw failure("invalid_upstream");
  };
  const assistant = async (record) => {
    if (record.error !== undefined) throw nativeError(record.error) ?? failure("upstream_failed");
    if (Array.isArray(record.message?.content)) record.message.content.forEach(checkBlock);
    if (record.parent_tool_use_id !== null || !object(record.message)) throw failure("invalid_upstream");
    const message = record.message;
    checkModel(message.model);
    if (!identifier(message.id) || message.role !== "assistant" || !Array.isArray(message.content) ||
        message.content.length === 0 || (message.stop_reason != null && message.stop_reason !== "end_turn")) {
      throw failure("invalid_upstream");
    }
    message.content.forEach(checkBlock);
    let state = messages.get(message.id);
    if (!state) {
      if (current || messages.size !== 0) throw failure("invalid_upstream");
      state = { id: message.id, blocks: new Map(), snapshotOnly: true, stopped: true };
      messages.set(message.id, state);
    }
    if (state.snapshotOnly) {
      for (const source of message.content) {
        state.blocks.set(state.blocks.size, { type: source.type, stopped: true, snapshot: true });
        if (source.type === "text") await append(source.text);
      }
      return;
    }
    const open = [...state.blocks.values()].filter((block) => !block.stopped);
    if (state !== current || open.length !== 1 || message.content.length !== 1 || open[0].snapshot ||
        open[0].type !== message.content[0].type ||
        (open[0].type === "text" && open[0].text !== message.content[0].text)) throw failure("invalid_upstream");
    open[0].snapshot = true;
  };
  return {
    async consume(record) {
      if (!object(record)) throw failure("invalid_upstream");
      // Like Hermes, ignore record types this adapter does not use (Claude Code adds undocumented
      // metadata such as ui_invalidate and command_lifecycle). Content only reaches the caller through
      // validated stream deltas, so an ignored record cannot leak text; tool signals still fail closed.
      if (!(["result", "stream_event", "assistant", "rate_limit_event"].includes(record.type) ||
          (record.type === "system" && ["init", "api_retry", "thinking_tokens", "model_refusal_fallback",
            "model_refusal_no_fallback"].includes(record.subtype)))) {
        toolSignals(record);
        return;
      }
      common(record);
      if (record.type === "result") {
        const providerFailure = nativeError(record.error, record.api_error_status);
        if (providerFailure) throw providerFailure;
        if (record.subtype === "error_during_execution" && record.is_error === true &&
            ["org_config_refused", "org_pin_mismatch", "gateway_signin_required", "gateway_access_denied"]
              .includes(record.startup_failure_reason)) throw failure("login_required");
        if (!initialized || record.subtype !== "success" || record.is_error !== false ||
            record.terminal_reason !== "completed" || record.stop_reason !== "end_turn" ||
            record.num_turns !== 1 || record.aborted === true) throw failure("upstream_failed");
        if (!Array.isArray(record.permission_denials) || record.permission_denials.length !== 0 ||
            (record.queued_turn_count !== undefined && record.queued_turn_count !== 0)) throw failure("unexpected_tools");
        if (record.user_message_uuid !== requestId || (record.result_index !== undefined && record.result_index !== 0) ||
            record.structured_output !== undefined || record.errors !== undefined || record.startup_failure_reason !== undefined ||
            !validText(record.result) || record.result !== text.join("") || outputBytes === 0 || current ||
            messages.size === 0 || [...messages.values()].some((message) => !message.stopped)) {
          throw failure("invalid_upstream");
        }
        if (record.modelUsage !== undefined) {
          if (!object(record.modelUsage) || Object.keys(record.modelUsage).some((reported) => reported !== model)) {
            throw failure("runtime_mismatch");
          }
          for (const usage of Object.values(record.modelUsage)) {
            if (!object(usage) || (usage.provider !== undefined && usage.provider !== "firstParty")) {
              throw failure("runtime_mismatch");
            }
          }
        }
        terminal = { status: "completed", text: text.join(""), resolvedModel: model,
          usage: sanitizedUsage(record.usage), quota: null };
        return;
      }
      if (record.type === "system" && record.subtype === "init") {
        if (initialized || !identifier(record.session_id)) throw failure("invalid_upstream");
        if (record.cwd !== runtime.cwd || record.claude_code_version !== runtime.version ||
            record.model !== model || record.apiKeySource !== "none") throw failure("runtime_mismatch");
        const pluginNames = Array.isArray(record.plugins)
          ? record.plugins.map((plugin) => typeof plugin === "string" ? plugin : plugin?.name) : null;
        if (["tools", "mcp_servers", "skills"].some((key) => !Array.isArray(record[key]) || record[key].length !== 0) ||
            !pluginNames || pluginNames.some((name) => !BUILTIN_PLUGINS.has(name)) ||
            new Set(pluginNames).size !== pluginNames.length ||
            (record.plugin_errors !== undefined && (!Array.isArray(record.plugin_errors) || record.plugin_errors.length !== 0))) {
          throw failure("unexpected_tools");
        }
        // Built-in agent definitions are metadata, not evidence of a subagent running.
        if (record.agents !== undefined && (!Array.isArray(record.agents) || record.agents.some((agent) => !validText(agent)))) {
          throw failure("invalid_upstream");
        }
        initialized = true;
        sessionId = record.session_id;
        return;
      }
      if (record.type === "rate_limit_event") {
        const info = record.rate_limit_info;
        if (!object(info)) throw failure("invalid_upstream");
        if (info.status === "rejected" || info.errorCode === "credits_required") throw failure("provider_quota");
        if (!initialized || !["allowed", "allowed_warning"].includes(info.status)) throw failure("invalid_upstream");
        return;
      }
      if (record.type === "system" && record.subtype === "api_retry") {
        const error = nativeError(record.error, record.error_status);
        if (error) throw error;
        if (!initialized) throw failure("invalid_upstream");
        return; // Native owns its retries. Adapter never retries or starts another child.
      }
      if (record.type === "assistant" && record.error !== undefined) {
        throw nativeError(record.error) ?? failure("upstream_failed");
      }
      if (!initialized) throw failure("invalid_upstream");
      if (record.type === "system" && record.subtype === "thinking_tokens") {
        if (["estimated_tokens", "estimated_tokens_delta"].some((key) =>
          typeof record[key] !== "number" || !Number.isFinite(record[key]) ||
          record[key] < 0 || record[key] > Number.MAX_SAFE_INTEGER)) throw failure("invalid_upstream");
        return;
      }
      if (record.type === "stream_event") await stream(record);
      else if (record.type === "assistant") await assistant(record);
      else if (record.subtype === "model_refusal_fallback") throw failure("runtime_mismatch");
      else throw failure("upstream_failed");
    },
    result() {
      if (!terminal) throw failure("invalid_upstream");
      return terminal;
    },
  };
}

async function readProtocol(stdout, protocol) {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let pending = "";
  let bytes = 0;
  for await (const chunk of stdout) {
    bytes += chunk.length;
    if (bytes > MAX_STDOUT_BYTES) throw failure("invalid_upstream");
    try { pending += decoder.decode(chunk, { stream: true }); }
    catch { throw failure("invalid_upstream"); }
    let newline;
    while ((newline = pending.indexOf("\n")) !== -1) {
      const line = pending.slice(0, newline);
      pending = pending.slice(newline + 1);
      if (!line.trim() || Buffer.byteLength(line) > MAX_LINE_BYTES) throw failure("invalid_upstream");
      let value;
      try { value = JSON.parse(line); }
      catch { throw failure("invalid_upstream"); }
      await protocol.consume(value);
    }
    if (Buffer.byteLength(pending) > MAX_LINE_BYTES) throw failure("invalid_upstream");
  }
  try { pending += decoder.decode(); }
  catch { throw failure("invalid_upstream"); }
  if (pending !== "") throw failure("invalid_upstream");
  return protocol.result();
}

function launchArguments(model) {
  return [
    "-p", "--safe-mode", "--disable-slash-commands", "--setting-sources", "user", "--settings", '{"disableAllHooks":true}',
    "--tools", "", "--disallowedTools", "*", "--strict-mcp-config", "--mcp-config", '{"mcpServers":{}}',
    "--no-session-persistence", "--max-turns", "1", "--input-format", "stream-json", "--output-format", "stream-json",
    "--verbose", "--include-partial-messages", "--permission-prompts", "none", "--model", model,
  ];
}

function childEnvironment(runtime) {
  return {
    HOME: runtime.home,
    // The macOS Keychain entry is keyed by account name; without it native stores "unknown".
    USER: userInfo().username,
    LOGNAME: userInfo().username,
    CLAUDE_CONFIG_DIR: runtime.configDir,
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    TMPDIR: "/tmp",
    CLAUDE_CODE_DISABLE_FAST_MODE: "1",
    CLAUDE_CODE_DISABLE_REFUSAL_FALLBACK: "1",
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
    CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL: "1",
    CLAUDE_CODE_AUTO_CONNECT_IDE: "false",
    CLAUDE_CODE_STARTUP_FAILURE_RESULTS: "1",
  };
}

async function reapOwnedGroup(pid, closed, killProcess, graceMs) {
  const ownedPid = Number.isSafeInteger(pid) && pid > 1;
  let groupGone = false;
  const gone = () => {
    if (!ownedPid) return closed.value && closed.failedSpawn;
    if (!groupGone) {
      try { killProcess(-pid, 0); }
      catch (error) { if (error?.code === "ESRCH") groupGone = true; }
    }
    return closed.value && groupGone;
  };
  if (gone()) return true;
  for (const signal of ["SIGINT", "SIGTERM", "SIGKILL"]) {
    if (ownedPid && !groupGone) {
      try { killProcess(-pid, signal); }
      catch (error) { if (error?.code === "ESRCH") groupGone = true; }
    }
    const deadline = Date.now() + graceMs;
    do {
      if (gone()) return true;
      await new Promise((resolve) => setTimeout(resolve, Math.min(25, Math.max(1, deadline - Date.now()))));
    } while (Date.now() < deadline);
  }
  return gone();
}

async function runNative({ runtime, model, input, signal, spawnProcess, killProcess, terminationGraceMs, onDelta }) {
  signal.throwIfAborted();
  let child;
  try {
    child = spawnProcess(runtime.executable, launchArguments(model), {
      cwd: runtime.cwd, env: childEnvironment(runtime), shell: false, detached: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch { throw failure("upstream_failed"); }
  if (!child || typeof child.once !== "function") throw failure("cleanup_failed");
  const ownedPid = child.pid;
  const closed = { value: false, code: null, signal: null, failedSpawn: false };
  const closePromise = new Promise((resolve) => {
    child.once("close", (code, exitSignal) => {
      closed.value = true;
      closed.code = code;
      closed.signal = exitSignal;
      resolve();
    });
  });
  child.once("error", () => { closed.failedSpawn = true; });
  const { promise: failed, reject: rejectFailure } = Promise.withResolvers();
  // A malformed injected child may fail before the operation race is installed.
  void failed.catch(() => {});
  const onAbort = () => rejectFailure(safeFailure(signal.reason));
  const onError = () => rejectFailure(failure("upstream_failed"));
  child.once("error", onError);
  signal.addEventListener("abort", onAbort, { once: true });
  let stderrBytes = 0;
  const onStderr = (chunk) => {
    stderrBytes += Buffer.byteLength(chunk);
    if (stderrBytes > MAX_STDERR_BYTES) rejectFailure(failure("invalid_upstream"));
  };
  let result;
  let error;
  try {
    if (!child.stdin || typeof child.stdin.end !== "function" || !child.stdout ||
        typeof child.stdout[Symbol.asyncIterator] !== "function" || !child.stderr ||
        typeof child.stderr.on !== "function") throw failure("upstream_failed");
    child.stdin.on("error", onError);
    child.stdout.on("error", onError);
    child.stderr.on("error", onError);
    child.stderr.on("data", onStderr);
    const requestId = randomUUID();
    const protocol = createProtocol(runtime, model, requestId, onDelta);
    const operation = async () => {
      child.stdin.end(`${JSON.stringify({ type: "user", uuid: requestId,
        message: { role: "user", content: input }, parent_tool_use_id: null, client_composed: true })}\n`);
      const value = await readProtocol(child.stdout, protocol);
      await closePromise;
      if (closed.code !== 0 || closed.signal !== null) throw failure("upstream_failed");
      return value;
    };
    if (signal.aborted) onAbort();
    result = await Promise.race([operation(), failed]);
  } catch (caught) { error = safeFailure(caught); }
  // Stop parsing immediately on failure, but keep stderr drained until bounded reap.
  if (error) {
    child.stdin?.destroy?.();
    child.stdout?.destroy?.();
  }
  const reaped = await reapOwnedGroup(ownedPid, closed, killProcess, terminationGraceMs);
  signal.removeEventListener("abort", onAbort);
  child.stderr?.off?.("data", onStderr);
  child.stdin?.destroy?.();
  child.stdout?.destroy?.();
  child.stderr?.destroy?.();
  if (!reaped) throw failure("cleanup_failed");
  if (error) throw error;
  return result;
}

export async function startClaudeChatGateway({
  runtime, tokenVerifier, port = 14502, companionHost, spawnProcess = spawn, killProcess = process.kill,
  turnTimeoutMs = 120000, terminationGraceMs = 500, bodyTimeoutMs = 10000, backpressureTimeoutMs = 10000,
} = {}) {
  if (!["darwin", "linux", "freebsd", "openbsd", "netbsd"].includes(process.platform)) {
    throw new TypeError("Claude Chat requires Unix process groups.");
  }
  const fixedRuntime = validateRuntime(runtime);
  if (!Buffer.isBuffer(tokenVerifier) || tokenVerifier.length !== 32 ||
      !Number.isInteger(port) || port < 0 || port > 65535 ||
      typeof spawnProcess !== "function" || typeof killProcess !== "function" ||
      (companionHost !== undefined && !(typeof companionHost === "string" && COMPANION_HOST.test(companionHost)))) {
    throw new TypeError("Claude Chat gateway configuration is invalid.");
  }
  for (const [value, maximum] of [[turnTimeoutMs, 600000], [terminationGraceMs, 10000],
    [bodyTimeoutMs, 60000], [backpressureTimeoutMs, 60000]]) {
    if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
      throw new TypeError("Claude Chat gateway deadline is invalid.");
    }
  }
  const verifier = Buffer.from(tokenVerifier);
  const sockets = new Set();
  let active = null;
  let poisoned = false;
  let closing = false;
  let closePromise;
  let boundHost;
  const handle = async (request, response) => {
    response.on("error", () => {});
    const openai = request.url?.startsWith("/v1/") === true;
    const reject = (status, code, param = null) => sendJson(response,
      openai && code === "timeout" ? 504 : openai && code === "cleanup_failed" ? 502 : status,
      openai ? completionError(code, param) : failedBody(code), undefined, backpressureTimeoutMs);
    const critical = ["host", "authorization", "content-type", "content-length", "transfer-encoding", "accept", "expect", "content-encoding"];
    if (request.rawHeaders.length > 64 || critical.some((name) => headerCount(request, name) > 1)) {
      await reject(400, "invalid_request"); return;
    }
    if (headerCount(request, "host") !== 1 || request.headers.host !== boundHost || headerCount(request, "origin") !== 0) {
      await reject(403, "forbidden"); return;
    }
    if (!authorized(request, verifier)) { await reject(401, "unauthorized"); return; }
    if (request.method === "GET" && request.url === "/health") {
      await sendJson(response, 200, { status: "ok", providerReadiness: "not-probed" }, undefined, backpressureTimeoutMs);
      return;
    }
    if (request.method === "GET" && request.url === "/v1/models") {
      await sendJson(response, 200, { object: "list", data: fixedRuntime.models.map((model) =>
        ({ id: model, object: "model", created: 0, owned_by: "anthropic" })),
      }, undefined, backpressureTimeoutMs);
      return;
    }
    if (request.method !== "POST" || !["/chat", "/v1/chat/completions"].includes(request.url)) {
      await reject(404, "invalid_request"); return;
    }
    if (closing || poisoned || active) { await reject(409, "busy"); return; }
    if (headerCount(request, "content-type") !== 1 ||
        !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(request.headers["content-type"] ?? "") ||
        request.headers["content-encoding"] !== undefined || request.headers.expect !== undefined || request.headers.trailer !== undefined) {
      await reject(415, "invalid_request"); return;
    }
    const controller = new AbortController();
    let resolveDone;
    const operation = { controller, done: new Promise((resolve) => { resolveDone = resolve; }) };
    active = operation;
    let streaming = false;
    let opened = false;
    let terminalSent = false;
    const disconnect = () => { if (!response.writableEnded) controller.abort(failure("upstream_failed")); };
    request.once("aborted", disconnect);
    response.once("close", disconnect);
    const deadline = setTimeout(() => controller.abort(failure("timeout")), turnTimeoutMs);
    const frame = (event, value, signal = controller.signal) =>
      writeResponse(response, `${openai ? "" : `event: ${event}\n`}data: ${value === "[DONE]" ? value : JSON.stringify(value)}\n\n`, signal, backpressureTimeoutMs);
    try {
      const body = await readJsonRequest(request, openai ? MAX_COMPLETION_BODY_BYTES : MAX_BODY_BYTES, controller.signal, bodyTimeoutMs);
      const chat = openai ? validateCompletionRequest(body, fixedRuntime.models) : validatePromptRequest(body, fixedRuntime.models);
      controller.signal.throwIfAborted();
      streaming = openai ? chat.stream :
        (request.headers.accept ?? "").split(",").some((part) => part.trim().split(";", 1)[0] === "text/event-stream");
      const completion = openai ? { id: `chatcmpl-${randomUUID()}`, created: Math.floor(Date.now() / 1000), model: chat.model } : null;
      const chunk = (delta, finish_reason = null) => ({
        ...completion, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason }],
        ...(chat.includeUsage ? { usage: null } : {}),
      });
      if (streaming && !openai) {
        startStream(response);
        opened = true;
      }
      const result = await runNative({ runtime: fixedRuntime, model: chat.model, input: chat.input, signal: controller.signal,
        spawnProcess, killProcess, terminationGraceMs,
        onDelta: async (text) => {
          if (!streaming) return;
          if (!opened) {
            startStream(response);
            opened = true;
            await frame(null, chunk({ role: "assistant", content: "" }));
          }
          await frame("delta", openai ? chunk({ content: text }) : { text });
        },
      });
      controller.signal.throwIfAborted();
      if (streaming) {
        terminalSent = true;
        if (openai) {
          await frame(null, chunk({}, "stop"));
          if (chat.includeUsage) await frame(null, { ...completion, object: "chat.completion.chunk", choices: [], usage: completionUsage(result.usage) });
          await frame(null, "[DONE]");
        } else {
          await frame("completed", { status: result.status, resolvedModel: result.resolvedModel,
            usage: result.usage, quota: null });
        }
        await finishResponse(response, controller.signal, backpressureTimeoutMs);
      } else await sendJson(response, 200, openai ? {
        ...completion, object: "chat.completion",
        choices: [{ index: 0, message: { role: "assistant", content: result.text }, finish_reason: "stop" }],
        usage: completionUsage(result.usage),
      } : result, controller.signal, backpressureTimeoutMs);
    } catch (caught) {
      const error = safeFailure(caught);
      if (error.code === "cleanup_failed") poisoned = true;
      if (!response.destroyed && !response.writableEnded) {
        try {
          if (opened) {
            if (!terminalSent) {
              terminalSent = true;
              await frame("error", openai ? completionError(error.code, error.param) : failedBody(error.code), null);
              await finishResponse(response, null, backpressureTimeoutMs);
            } else response.destroy();
          } else if (!response.headersSent) await reject(error.status, error.code, error.param);
          else response.destroy();
        } catch { response.destroy(); }
      }
    } finally {
      clearTimeout(deadline);
      request.off("aborted", disconnect);
      response.off("close", disconnect);
      if (!poisoned) active = null;
      resolveDone();
    }
  };
  const server = createServer({ maxHeaderSize: MAX_HEADER_BYTES }, (request, response) => {
    void handle(request, response).catch(() => response.destroy());
  });
  server.maxHeadersCount = 0; // Count raw headers ourselves; never hide a trailing security header.
  server.headersTimeout = 10000;
  server.requestTimeout = 0; // Per-request body/deadline timers also cover slow chunked clients.
  server.keepAliveTimeout = 1000;
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  server.on("checkContinue", (request, response) => {
    if (request.url?.startsWith("/v1/")) {
      void handle(request, response).catch(() => response.destroy());
      return;
    }
    void sendJson(response, 417, failedBody("invalid_request"), undefined, backpressureTimeoutMs)
      .catch(() => response.destroy());
  });
  server.on("upgrade", (request, socket) => socket.destroy());
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    // Companion mode is reachable only on the private Docker network: no published port, bearer on every route.
    server.listen(port, companionHost === undefined ? "127.0.0.1" : "0.0.0.0", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  boundHost = `${companionHost ?? "127.0.0.1"}:${address.port}`;
  return {
    origin: `http://${boundHost}`,
    close() {
      if (closePromise) return closePromise;
      closing = true;
      active?.controller.abort(failure("upstream_failed"));
      const stopped = new Promise((resolve, reject) => {
        server.close((error) => error ? reject(failure("cleanup_failed")) : resolve());
      });
      for (const socket of sockets) socket.destroy();
      closePromise = (async () => {
        await active?.done;
        await stopped;
        if (poisoned) throw failure("cleanup_failed");
      })();
      return closePromise;
    },
  };
}

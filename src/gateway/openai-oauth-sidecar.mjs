import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { pathToFileURL } from "node:url";
import { isDeepStrictEqual } from "node:util";
import { getAccessToken, resolveSiwcStorageRoot } from "../services/siwc-session.mjs";
import { CODEX_IMAGES_MODEL, codexImagesStatus, getCodexImagesLease } from "../services/codex-images.mjs";

export const CODEX_CLI_VERSION = "0.160.0";
const BASE_URL = "https://api.openai.com/v1";
const MODEL_CATALOG_PATH = `/models?client_version=${CODEX_CLI_VERSION}`;
const MAX_BODY = 2 * 1024 * 1024;
const MAX_EVENT = 2 * 1024 * 1024;
const MAX_TOOL_CALLS = 32;
const MAX_TOOL_ARGUMENT_BYTES = 128 * 1024;
const MAX_OUTPUT_ITEMS = 256;
const unsupportedFields = new Set(["conversation", "max_output_tokens", "max_tool_calls", "metadata", "moderation", "multi_agent", "prompt", "prompt_cache_retention", "safety_identifier", "temperature", "top_logprobs", "top_p", "truncation", "user", "previous_response_id"]);
const unsupportedTools = new Set(["image_generation", "file_search", "code_interpreter", "computer", "computer_use", "mcp", "tool_search", "programmatic_tool_calling"]);
const allowedFields = new Set(["model", "input", "instructions", "store", "stream", "background", "tools", "tool_choice", "parallel_tool_calls", "reasoning", "text", "include"]);
const IMAGES_BASE_URL = "https://chatgpt.com/backend-api/codex";
// The sidecar image does not carry the Relmio release version; pinning one here would change the image digest every release.
const IMAGES_USER_AGENT = "Relmio (n8n sidecar)";
const IMAGES_TIMEOUT_MS = 300_000;
const MAX_IMAGE_JSON = 64 * 1024;
const MAX_IMAGE_RESPONSE = 64 * 1024 * 1024;
const MAX_EDIT_BODY = 48 * 1024 * 1024;
const MAX_EDIT_IMAGE = 25 * 1024 * 1024;
const MAX_EDIT_IMAGES = 16;
const MAX_PARTS = 64;
const MAX_PART_HEADERS = 8 * 1024;
const IMAGE_FIELDS = new Set(["prompt", "model", "n", "quality", "size", "background", "response_format", "user", "output_format", "output_compression", "input_fidelity"]);
const IMAGE_QUALITIES = new Set(["low", "medium", "high", "auto"]);
const IMAGE_SIZES = new Set(["1024x1024", "1024x1536", "1536x1024", "auto"]);
const IMAGE_BACKGROUNDS = new Set(["transparent", "opaque", "auto"]);
const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const IMAGES_OFF = "Image generation is off. It needs a separate Codex sign-in that OpenAI doesn't document for other apps. On a VPS sidecar, turn it on in Relmio under Manage the installed ChatGPT session.";

function redactSecrets(value, secrets = []) {
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length >= 8) value = value.replaceAll(secret, "[redacted]");
  }
  return value;
}
function safeText(value, secrets) {
  if (typeof value !== "string") return undefined;
  return redactSecrets(value, secrets).slice(0, 512);
}
function safeError(body, status, requestId, secrets) {
  const source = body?.error && typeof body.error === "object" ? body.error : body;
  const detail = safeText(body?.detail, secrets);
  const code = safeText(source?.code, secrets);
  const param = safeText(source?.param, secrets);
  const type = safeText(source?.type, secrets);
  const message = safeText(source?.message, secrets) ?? detail ?? "The plan request failed.";
  const error = { message, type: type ?? "api_error", ...(code && { code }), ...(param && { param }) };
  const recovery = code === "subscription_sharing_usage_limit_exceeded" ? "manage-usage"
    : status === 503 ? "retry-later" : status === 400 || status === 422 ? "fix-request" : status === 401 ? "reauthorize" : "fix-configuration";
  const safeId = safeText(requestId, secrets);
  return {
    error, status, recovery, ...(safeId && { requestId: safeId }),
    upstream: { status, body: detail !== undefined ? { detail } : { error }, ...(safeId && { requestId: safeId }) },
  };
}
function failureStatus(value) {
  const code = value?.response?.error?.code ?? value?.error?.code;
  if (code === "subscription_sharing_usage_limit_exceeded") return 429;
  if (code === "subscription_sharing_usage_unavailable" || code === "subscription_sharing_user_unavailable") return 503;
  if (code === "subscription_sharing_unsupported_capability") return 400;
  if (code === "subscription_sharing_invalid_user") return 401;
  return 502;
}
function failure(message, param, status = 400, code = "unsupported_siwc_feature", recovery = status >= 500 ? "retry-later" : "fix-request") {
  return Response.json({ error: { message, type: "invalid_request_error", code, param }, status, recovery }, { status, headers: { "cache-control": "no-store" } });
}
function terminalFailure(value, requestId, secrets) {
  if (value.type === "response.incomplete") {
    const reason = safeText(value.response?.incomplete_details?.reason, secrets);
    const safeId = safeText(requestId, secrets);
    return {
      error: { code: "response_incomplete", type: "api_error", message: reason ? `The response was incomplete: ${reason}.` : "The response was incomplete." },
      status: 502, recovery: "fix-request", ...(safeId && { requestId: safeId }),
    };
  }
  return safeError(value.response ?? value, failureStatus(value), requestId, secrets);
}
function eventRequestId(event, response) {
  return safeText(event?.request_id ?? event?.response?.request_id ?? response.headers.get("x-request-id"));
}
function unauthorized() {
  return Response.json({ error: { message: "A local client credential is required.", type: "authentication_error", code: "unauthorized" } }, { status: 401, headers: { "cache-control": "no-store" } });
}
function validBearer(request, verifier) {
  const value = request.headers.get("authorization");
  if (!Buffer.isBuffer(verifier) || verifier.length !== 32 || !value || value.length > 512) return false;
  const match = /^Bearer ([A-Za-z0-9_-]{1,256})$/u.exec(value);
  return Boolean(match && timingSafeEqual(createHash("sha256").update(match[1]).digest(), verifier));
}
function validPrivateHost(value) {
  const match = /^(\[::1\]|127\.0\.0\.1|localhost|n8n-openai-oauth|openai-oauth)(?::([1-9][0-9]{0,4}))?$/iu.exec(value ?? "");
  return Boolean(match && (match[2] === undefined || Number(match[2]) <= 65_535));
}
function validModel(value) {
  return typeof value === "string" && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(value);
}
const validCallId = (value) => typeof value === "string" && /^[!-~]{1,256}$/u.test(value);
const isObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const boundedArguments = (value) => typeof value === "string" && Buffer.byteLength(value) <= MAX_TOOL_ARGUMENT_BYTES;
const directCaller = (value) => value === undefined || value === null ||
  isObject(value) && value.type === "direct" && Object.keys(value).length === 1;
function supportedTool(tool, nested = false) {
  if (!isObject(tool) || unsupportedTools.has(tool.type) || tool.defer_loading !== undefined || tool.deferLoading !== undefined ||
      tool.async !== undefined || tool.allowed_callers !== undefined &&
      (!Array.isArray(tool.allowed_callers) || tool.allowed_callers.some((caller) => caller !== "direct"))) return false;
  if (nested) {
    if (!["function", "custom"].includes(tool.type) || !validModel(tool.name) ||
        tool.description !== undefined && typeof tool.description !== "string") return false;
    if (tool.type === "function") return Object.keys(tool).every((key) => ["type", "name", "description", "parameters", "strict", "allowed_callers"].includes(key)) &&
      (tool.parameters === undefined || tool.parameters === null || isObject(tool.parameters)) &&
      (tool.strict === undefined || tool.strict === null || typeof tool.strict === "boolean");
    if (Object.keys(tool).some((key) => !["type", "name", "description", "format", "allowed_callers"].includes(key))) return false;
    const format = tool.format;
    return format === undefined || isObject(format) && (format.type === "text" && Object.keys(format).length === 1 ||
      format.type === "grammar" && ["lark", "regex"].includes(format.syntax) && typeof format.definition === "string" &&
      Object.keys(format).every((key) => ["type", "syntax", "definition"].includes(key)));
  }
  if (tool.type === "namespace") return validModel(tool.name) && typeof tool.description === "string"
    && Object.keys(tool).every((key) => ["type", "name", "description", "tools"].includes(key))
    && Array.isArray(tool.tools) && tool.tools.length > 0 && tool.tools.length <= MAX_TOOL_CALLS
    && tool.tools.every((member) => supportedTool(member, true))
    && new Set(tool.tools.map((member) => member.name)).size === tool.tools.length;
  return ["web_search", "web_search_preview", "web_search_preview_2025_03_11"].includes(tool.type);
}
function additionalTool(tool) {
  return tool?.type === "function" && (tool.parameters === undefined || tool.strict === undefined)
    ? { ...tool, parameters: tool.parameters ?? null, strict: tool.strict ?? null } : tool;
}
function checkInput(input) {
  if (!Array.isArray(input) || input.length === 0 || input.length > 256) return "input";
  const flatNames = new Set();
  const calls = new Map();
  const itemIds = new Set();
  const results = new Set();
  for (const item of input) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return "input";
    if (item.role === "system" || item.type === "message" && item.role === "system") return "input";
    if (JSON.stringify(item).match(/"type":"(?:input_audio|audio|input_video|video|image_generation_call|file_search_call|code_interpreter_call|computer_call|mcp_call|tool_search)"/u)) return "input";
    if (item.type === "additional_tools") {
      if (item.role !== "developer" || !Array.isArray(item.tools) || !item.tools.length || item.tools.length > MAX_TOOL_CALLS ||
          !item.tools.every((tool) => supportedTool(tool, true) || supportedTool(tool)) ||
          Object.keys(item).some((key) => !["type", "role", "tools", "id"].includes(key)) ||
          item.id !== undefined && !validCallId(item.id)) return "input";
      for (const tool of item.tools) {
        if (!["function", "custom"].includes(tool.type)) continue;
        if (flatNames.has(tool.name)) return "input";
        flatNames.add(tool.name);
      }
    }
    if (["function_call", "custom_tool_call"].includes(item.type)) {
      if (!validCallId(item.call_id) || !validModel(item.name) || calls.has(item.call_id) ||
          !boundedArguments(item.type === "function_call" ? item.arguments : item.input) ||
          !directCaller(item.caller) || item.async !== undefined ||
          item.namespace !== undefined && !validModel(item.namespace) ||
          item.status !== undefined && item.status !== "completed" ||
          item.id !== undefined && (!validCallId(item.id) || itemIds.has(item.id))) return "input";
      calls.set(item.call_id, item);
      if (item.id !== undefined) itemIds.add(item.id);
    } else if (["function_call_output", "custom_tool_call_output"].includes(item.type)) {
      const call = calls.get(item.call_id);
      if (!call || item.type !== `${call.type}_output` || results.has(item.call_id) || !directCaller(item.caller) ||
          !(typeof item.output === "string" || Array.isArray(item.output)) ||
          item.namespace !== undefined && (item.type === "custom_tool_call_output" || item.namespace !== call.namespace)) return "input";
      results.add(item.call_id);
    }
  }
  return results.size === calls.size ? null : "input";
}
function normalizeFlatTools(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "body" };
  if (Array.isArray(body.input) && body.input.some((item) => item?.type === "additional_tools")) {
    body = { ...body, input: body.input.map((item) => item?.type === "additional_tools" && Array.isArray(item.tools)
      ? { ...item, tools: item.tools.map(additionalTool) } : item) };
  }
  if (!Array.isArray(body.tools)) return { body };
  if (body.tools.length > MAX_TOOL_CALLS) return { error: "tools" };
  const flat = body.tools.filter((tool) => tool?.type === "function" || tool?.type === "custom");
  if (!flat.length) return { body };
  if (flat.some((tool) => !supportedTool(tool, true)) ||
      new Set(flat.map((tool) => tool.name)).size !== flat.length) return { error: "tools" };
  if (!Array.isArray(body.input) || body.input.length >= 256) return { error: "input" };
  const remaining = body.tools.filter((tool) => tool?.type !== "function" && tool?.type !== "custom");
  const { tools: _oldTools, ...rest } = body;
  return { body: { ...rest, input: [{ type: "additional_tools", role: "developer", tools: flat.map(additionalTool) }, ...body.input],
    ...(remaining.length && { tools: remaining }) } };
}
function validateResponses(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return "body";
  for (const name of Object.keys(body)) {
    if (unsupportedFields.has(name) || !allowedFields.has(name)) return name;
  }
  if (body.background !== undefined && body.background !== false) return "background";
  if (body.store !== undefined && body.store !== false) return "store";
  if (body.stream !== undefined && typeof body.stream !== "boolean") return "stream";
  if (!validModel(body.model)) return "model";
  const inputError = checkInput(body.input);
  if (inputError) return inputError;
  if (body.tools !== undefined && (!Array.isArray(body.tools) || body.tools.length > MAX_TOOL_CALLS || !body.tools.every((tool) => supportedTool(tool)))) return "tools";
  if (body.parallel_tool_calls !== undefined && typeof body.parallel_tool_calls !== "boolean") return "parallel_tool_calls";
  if (body.tool_choice !== undefined && (
    typeof body.tool_choice === "string" ? !["auto", "none", "required"].includes(body.tool_choice) ||
      body.tool_choice === "required" && !body.tools?.length && !body.input.some((item) => item.type === "additional_tools")
      : !isObject(body.tool_choice) || !["web_search", "web_search_preview"].includes(body.tool_choice.type) ||
        Object.keys(body.tool_choice).length !== 1
  )) return "tool_choice";
  if (body.include !== undefined && (!Array.isArray(body.include) || body.include.length > 16 ||
      body.include.some((value) => typeof value !== "string" || /^(?:file_search_call|code_interpreter_call|computer_call|message\.output_text\.logprobs)/u.test(value)))) return "include";
  return null;
}
async function readBody(request, limit) {
  const reader = request.body?.getReader();
  if (!reader) throw new Error("empty_body");
  const chunks = [];
  let bytes = 0;
  let completed = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) { completed = true; break; }
      bytes += value.byteLength;
      if (bytes > limit) throw new Error("body_too_large");
      chunks.push(value);
    }
  } finally {
    if (!completed) { try { await reader.cancel(); } catch { /* The caller returns an error. */ } }
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}
async function readJson(request, limit = MAX_BODY) {
  return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(await readBody(request, limit)));
}
async function providerError(response, secrets) {
  let body;
  try { body = await readJson(response, 16_384); } catch { body = null; }
  return safeError(body, response.status, response.headers.get("x-request-id"), secrets);
}
async function* sseEvents(stream, reader = stream.getReader()) {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let pending = "";
  let data = [];
  let dataSize = 0;
  let eventName;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) { pending += decoder.decode(); break; }
      pending += decoder.decode(value, { stream: true });
      if (pending.length > MAX_EVENT) throw new Error("stream_too_large");
      let end;
      while ((end = pending.indexOf("\n")) >= 0) {
        const line = pending.slice(0, end).replace(/\r$/u, "");
        pending = pending.slice(end + 1);
        if (!line) {
          if (data.length) {
            const raw = data.join("\n");
            if (raw.length > MAX_EVENT) throw new Error("stream_too_large");
            if (raw !== "[DONE]") yield { type: eventName, value: JSON.parse(raw) };
          }
          data = []; dataSize = 0; eventName = undefined;
        } else if (line.startsWith("data:")) {
          const part = line.slice(5).trimStart();
          dataSize += part.length + 1;
          if (dataSize > MAX_EVENT) throw new Error("stream_too_large");
          data.push(part);
        } else if (line.startsWith("event:")) eventName = line.slice(6).trim();
      }
    }
    if (pending || data.length) throw new Error("stream_interrupted");
  } finally {
    try { await reader.cancel(); } catch { /* An interrupted stream has no success terminal. */ }
    reader.releaseLock();
  }
}
function outputState() {
  return { added: new Map(), done: new Map(), ids: new Map(), bytes: 0 };
}
function consistentOutputItem(initial, final) {
  if (["type", "id", "call_id", "name", "namespace", "phase", "role"].some((key) => initial[key] !== final[key])) return false;
  const field = initial.type === "function_call" ? "arguments" : initial.type === "custom_tool_call" ? "input" : null;
  return !field || initial[field] === undefined || typeof final[field] === "string" && final[field].startsWith(initial[field]);
}
function trackOutputItem(state, value) {
  if (!["response.output_item.added", "response.output_item.done"].includes(value.type)) return;
  const index = value.output_index;
  const item = value.item;
  const added = value.type === "response.output_item.added";
  const target = added ? state.added : state.done;
  if (!Number.isInteger(index) || index < 0 || index >= MAX_OUTPUT_ITEMS || !isObject(item) || typeof item.type !== "string" ||
      target.has(index) || added && state.done.has(index) ||
      item.id !== undefined && (!validCallId(item.id) || state.ids.has(item.id) && state.ids.get(item.id) !== index)) throw new Error("unsupported_output");
  const initial = state.added.get(index);
  if (!added && initial && !consistentOutputItem(initial, item)) throw new Error("unsupported_output");
  state.bytes += Buffer.byteLength(JSON.stringify(item));
  if (state.bytes > MAX_EVENT) throw new Error("unsupported_output");
  target.set(index, item);
  if (item.id !== undefined) state.ids.set(item.id, index);
}
function resolvedOutput(response, state) {
  if (!isObject(response) || !Array.isArray(response.output) || response.output.length > MAX_OUTPUT_ITEMS ||
      Buffer.byteLength(JSON.stringify(response)) > MAX_EVENT) throw new Error("unsupported_output");
  if (response.output.length) {
    for (const [index, item] of state.done) {
      if (!isDeepStrictEqual(response.output[index], item)) throw new Error("unsupported_output");
    }
    for (const [index, item] of state.added) {
      if (!isObject(response.output[index]) || !consistentOutputItem(item, response.output[index])) throw new Error("unsupported_output");
    }
    return { response, byIndex: new Map(response.output.entries()) };
  }
  if ([...state.added.keys()].some((index) => !state.done.has(index))) throw new Error("unsupported_output");
  const byIndex = new Map([...state.done].sort(([left], [right]) => left - right));
  const completed = { ...response, output: [...byIndex.values()] };
  if (Buffer.byteLength(JSON.stringify(completed)) > MAX_EVENT) throw new Error("unsupported_output");
  return { response: completed, byIndex };
}
const finalChatPhase = (item) => item.phase === undefined || item.phase === null || item.phase === "final_answer";
const validChatPhase = (item) => finalChatPhase(item) || item.phase === "commentary";

function streamResponse(upstream, chat, secrets) {
  const encoder = new TextEncoder();
  const id = `chatcmpl-${randomUUID()}`;
  const model = chat?.model;
  const reader = upstream.body.getReader();
  const events = sseEvents(upstream.body, reader);
  let started = false;
  let closed = false;
  let roleSent = false;
  const toolCalls = [];
  const callByOutput = new Map();
  const itemIds = new Set();
  let argumentBytes = 0;
  const textParts = [];
  let textBytes = 0;
  const output = chat ? outputState() : null;
  const pendingText = new Map();
  const body = new ReadableStream({
    async pull(controller) {
      if (closed) return;
      started = true;
      const send = (event, value) => controller.enqueue(encoder.encode(`event: ${event}\ndata: ${redactSecrets(JSON.stringify(value), secrets)}\n\n`));
      const chatChunk = (delta, finishReason = null) => {
        send("message", { id, object: "chat.completion.chunk", model,
          choices: [{ index: 0, delta: { ...(!roleSent && { role: "assistant" }), ...delta }, finish_reason: finishReason }] });
        roleSent = true;
      };
      const appendArguments = (call, argumentsText) => {
        const current = call.parts.join("");
        if (!boundedArguments(argumentsText) || !argumentsText.startsWith(current) ||
            call.done && argumentsText !== current) throw new Error("unsupported_output");
        const suffix = argumentsText.slice(current.length);
        call.bytes += Buffer.byteLength(suffix);
        argumentBytes += Buffer.byteLength(suffix);
        if (argumentBytes > MAX_EVENT) throw new Error("unsupported_output");
        if (suffix) {
          call.parts.push(suffix);
          chatChunk({ tool_calls: [{ index: call.index, function: { arguments: suffix } }] });
        }
        return Boolean(suffix);
      };
      const flushText = (index, item) => {
        const pending = pendingText.get(index);
        if (!pending) return false;
        if (item?.type !== "message" || !validChatPhase(item) ||
            pending.itemId !== undefined && pending.itemId !== item.id) throw new Error("unsupported_output");
        pendingText.delete(index);
        if (!finalChatPhase(item)) return false;
        const text = pending.parts.join("");
        textParts.push(text);
        chatChunk({ content: text });
        return true;
      };
      const finish = () => {
        closed = true;
        controller.close();
        void events.return().catch(() => {});
      };
      try {
        let skipped = 0;
        for (;;) {
          const next = await events.next();
          if (closed) return;
          if (next.done) {
            send("error", safeError({ error: { code: "stream_interrupted", message: "The upstream stream ended before completion." } }, 502, upstream.headers.get("x-request-id"), secrets));
            finish();
            return;
          }
          const value = next.value.value;
          if (typeof value?.type !== "string") throw new Error("invalid_event");
          if (chat && ["response.output_item.added", "response.output_item.done"].includes(value.type)) {
            trackOutputItem(output, value);
            if (value.item.type === "message" && !validChatPhase(value.item)) throw new Error("unsupported_output");
            if (flushText(value.output_index, value.item)) return;
          }
          if (chat && value.type === "response.output_text.delta") {
            if (typeof value.delta !== "string" || !Number.isInteger(value.output_index) ||
                value.output_index < 0 || value.output_index >= MAX_OUTPUT_ITEMS) throw new Error("unsupported_output");
            textBytes += Buffer.byteLength(value.delta);
            if (textBytes > MAX_EVENT) throw new Error("unsupported_output");
            const item = output.added.get(value.output_index) ?? output.done.get(value.output_index);
            if (!item) {
              const pending = pendingText.get(value.output_index) ?? { itemId: value.item_id, parts: [] };
              if (pending.itemId !== value.item_id) throw new Error("unsupported_output");
              pending.parts.push(value.delta);
              pendingText.set(value.output_index, pending);
              if (++skipped > 1000) throw new Error("too_many_events");
              continue;
            }
            if (item.type !== "message" || !validChatPhase(item) ||
                value.item_id !== undefined && value.item_id !== item.id) throw new Error("unsupported_output");
            if (!finalChatPhase(item)) { if (++skipped > 1000) throw new Error("too_many_events"); continue; }
            textParts.push(value.delta);
            chatChunk({ content: value.delta });
            return;
          }
          if (chat && value.type === "response.output_item.added") {
            if (value.item?.type !== "function_call") {
              if (["message", "reasoning"].includes(value.item?.type)) { if (++skipped > 1000) throw new Error("too_many_events"); continue; }
              throw new Error("unsupported_output");
            }
            const call = chatToolCall(value.item, true);
            if (!call || call.type !== "function" || !Number.isInteger(value.output_index) || value.output_index < 0 ||
                toolCalls.length >= MAX_TOOL_CALLS || callByOutput.has(value.output_index) ||
                toolCalls.some((entry) => entry.id === call.id) ||
                value.item.id !== undefined && itemIds.has(value.item.id)) throw new Error("unsupported_output");
            const entry = { id: call.id, name: call.function.name, index: toolCalls.length,
              outputIndex: value.output_index, itemId: value.item.id, done: false,
              parts: [call.function.arguments], bytes: Buffer.byteLength(call.function.arguments) };
            argumentBytes += entry.bytes;
            if (argumentBytes > MAX_EVENT) throw new Error("unsupported_output");
            if (entry.itemId !== undefined) itemIds.add(entry.itemId);
            toolCalls.push(entry);
            callByOutput.set(value.output_index, entry);
            chatChunk({ tool_calls: [{ index: entry.index, id: entry.id, type: "function",
              function: { name: entry.name, arguments: call.function.arguments } }] });
            return;
          }
          if (chat && ["response.function_call_arguments.delta", "response.function_call_arguments.done",
            "response.output_item.done"].includes(value.type)) {
            if (value.type === "response.output_item.done" && ["message", "reasoning"].includes(value.item?.type)) {
              if (++skipped > 1000) throw new Error("too_many_events");
              continue;
            }
            const call = callByOutput.get(value.output_index);
            if (!call || value.item_id !== undefined && value.item_id !== call.itemId) throw new Error("unsupported_output");
            if (value.type === "response.function_call_arguments.delta") {
              if (call.done || typeof value.delta !== "string") throw new Error("unsupported_output");
              const bytes = Buffer.byteLength(value.delta);
              call.bytes += bytes;
              argumentBytes += bytes;
              if (call.bytes > MAX_TOOL_ARGUMENT_BYTES || argumentBytes > MAX_EVENT) throw new Error("unsupported_output");
              if (value.delta) {
                call.parts.push(value.delta);
                chatChunk({ tool_calls: [{ index: call.index, function: { arguments: value.delta } }] });
                return;
              }
            } else {
              const final = value.item === undefined ? null : chatToolCall(value.item);
              if (value.item !== undefined && (!final || final.type !== "function" || final.id !== call.id ||
                  final.function.name !== call.name || value.item.id !== call.itemId)) throw new Error("unsupported_output");
              if (value.type === "response.output_item.done" && !final) throw new Error("unsupported_output");
              const emitted = appendArguments(call, final ? final.function.arguments : value.arguments);
              call.done = true;
              if (emitted) return;
            }
            if (++skipped > 1000) throw new Error("too_many_events");
            continue;
          }
          if (["response.completed", "response.failed", "response.incomplete"].includes(value.type)) {
            if (value.type === "response.completed" && value.response?.status && value.response.status !== "completed") throw new Error("invalid_terminal");
            if (chat) {
              if (value.type === "response.completed") {
                const resolved = resolvedOutput(value.response, output);
                const converted = chatOutput(resolved.response.output);
                if (!converted) throw new Error("unsupported_output");
                for (const index of pendingText.keys()) flushText(index, resolved.byIndex.get(index));
                const textEmitted = textParts.join("");
                if (!converted || converted.toolCalls.some((call) => call.type !== "function") ||
                    !converted.text.startsWith(textEmitted) || toolCalls.length > converted.toolCalls.length) throw new Error("unsupported_output");
                for (const prior of toolCalls) {
                  const item = resolved.byIndex.get(prior.outputIndex);
                  if (!item || item.type !== "function_call" || item.call_id !== prior.id || item.name !== prior.name ||
                      item.id !== prior.itemId || !item.arguments.startsWith(prior.parts.join("")) ||
                      prior.done && item.arguments !== prior.parts.join("")) throw new Error("unsupported_output");
                }
                const remainingText = converted.text.slice(textEmitted.length);
                if (remainingText) chatChunk({ content: remainingText });
                let nextIndex = toolCalls.length;
                for (const [outputIndex, item] of resolved.byIndex) {
                  if (item.type !== "function_call") continue;
                  const prior = callByOutput.get(outputIndex);
                  if (prior) appendArguments(prior, item.arguments);
                  else {
                    const call = chatToolCall(item);
                    chatChunk({ tool_calls: [{ index: nextIndex++, id: call.id, type: "function", function: call.function }] });
                  }
                }
                chatChunk({}, converted.toolCalls.length ? "tool_calls" : "stop");
                if (chat.streamOptions?.include_usage) send("message", { id, object: "chat.completion.chunk", model,
                  choices: [], usage: chatUsage(value.response.usage) ?? null });
                controller.enqueue(encoder.encode("data: [DONE]\n\n"));
              } else send("error", terminalFailure(value, eventRequestId(value, upstream), secrets));
            } else if (value.type === "response.completed") send(value.type, value);
            else {
              const safe = terminalFailure(value, eventRequestId(value, upstream), secrets);
              send(value.type, { type: value.type, response: { error: safe.error, status: value.type === "response.incomplete" ? "incomplete" : "failed" },
                status: safe.status, requestId: safe.requestId, recovery: safe.recovery, ...(safe.upstream && { upstream: safe.upstream }) });
            }
            finish();
            return;
          }
          if (!chat) { send(value.type, value); return; }
          if (++skipped > 1000) throw new Error("too_many_events");
        }
      } catch (error) {
        if (closed) return;
        const code = error?.message === "unsupported_output" ? "unsupported_output" : "stream_interrupted";
        send("error", safeError({ error: { code, message: code === "unsupported_output" ? "The output cannot be represented as a chat completion." : "The upstream stream was interrupted." } },
          code === "unsupported_output" ? 422 : 502, upstream.headers.get("x-request-id"), secrets));
        finish();
      }
    },
    async cancel() {
      closed = true;
      try { await reader.cancel(); } catch { /* The client has disconnected. */ }
      if (started) await events.return().catch(() => {});
      else reader.releaseLock();
    },
  }, { highWaterMark: 1 });
  return new Response(body, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", ...(upstream.headers.get("x-request-id") && { "x-request-id": safeText(upstream.headers.get("x-request-id"), secrets) }) } });
}
function chatToolCall(item, initial = false) {
  const type = item?.type === "function_call" ? "function" : item?.type === "custom_tool_call" ? "custom" : null;
  const field = type === "function" ? "arguments" : "input";
  if (!type || initial && type !== "function" || item.namespace !== undefined || !validModel(item.name) || !validCallId(item.call_id) ||
      item.id !== undefined && !validCallId(item.id) ||
      !(initial && item[field] === undefined || boundedArguments(item[field])) ||
      !directCaller(item.caller) || item.async !== undefined || item.status !== undefined &&
      (initial ? !["in_progress", "completed"].includes(item.status) : item.status !== "completed")) return null;
  return { id: item.call_id, type, [type]: { name: item.name, [field]: item[field] ?? "" } };
}
function chatOutput(output) {
  if (!Array.isArray(output)) return null;
  const text = [];
  const toolCalls = [];
  const ids = new Set();
  const itemIds = new Set();
  for (const item of output) {
    if (!item || typeof item !== "object") return null;
    if (item.id !== undefined) {
      if (!validCallId(item.id) || itemIds.has(item.id)) return null;
      itemIds.add(item.id);
    }
    if (item.type === "reasoning") continue;
    if (item.type === "message") {
      if (item.role !== undefined && item.role !== "assistant" || !validChatPhase(item) || !Array.isArray(item.content) ||
          item.content.some((part) => part?.type !== "output_text" || typeof part.text !== "string")) return null;
      if (finalChatPhase(item)) for (const part of item.content) text.push(part.text);
    } else if (["function_call", "custom_tool_call"].includes(item.type)) {
      const call = chatToolCall(item);
      if (!call || ids.has(call.id)) return null;
      ids.add(call.id);
      toolCalls.push(call);
    } else return null;
    if (toolCalls.length > MAX_TOOL_CALLS) return null;
  }
  return { text: text.join(""), toolCalls };
}
function chatUsage(usage) {
  if (!usage) return undefined;
  return { prompt_tokens: usage.input_tokens, completion_tokens: usage.output_tokens, total_tokens: usage.total_tokens,
    ...(usage.input_tokens_details && { prompt_tokens_details: usage.input_tokens_details }),
    ...(usage.output_tokens_details && { completion_tokens_details: usage.output_tokens_details }) };
}
async function aggregate(upstream, chat, model, secrets) {
  let completed;
  const output = outputState();
  try {
    for await (const { value } of sseEvents(upstream.body)) {
      if (completed || typeof value?.type !== "string") throw new Error("invalid_event");
      trackOutputItem(output, value);
      if (value.type === "response.completed") { completed = resolvedOutput(value.response, output).response; break; }
      if (value.type === "response.failed" || value.type === "response.incomplete") {
        const result = terminalFailure(value, eventRequestId(value, upstream), secrets);
        return Response.json(result, { status: result.status });
      }
    }
  } catch (error) {
    if (error?.message === "unsupported_output") return failure("The upstream output items were invalid.", "output",
      chat ? 422 : 502, "unsupported_output", "fix-request");
    return failure("The upstream stream was interrupted.", null, 502, "stream_interrupted");
  }
  if (!completed || completed.status && completed.status !== "completed") return failure("The upstream stream ended before completion.", null, 502, "stream_interrupted");
  const serialized = JSON.stringify(completed);
  if (Buffer.byteLength(serialized) > MAX_EVENT) return failure("The response was too large to aggregate.", null, 502, "response_too_large");
  if (!chat) return new Response(redactSecrets(serialized, secrets), { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
  const converted = chatOutput(completed.output);
  if (!converted) return failure("This output cannot be represented as a chat completion.", "output", 422);
  const result = { id: safeText(completed.id, secrets), object: "chat.completion", model,
    choices: [{ index: 0, message: { role: "assistant", content: converted.text || (converted.toolCalls.length ? null : ""),
      ...(converted.toolCalls.length && { tool_calls: converted.toolCalls }) },
    finish_reason: converted.toolCalls.length ? "tool_calls" : "stop" }], usage: chatUsage(completed.usage) };
  return new Response(redactSecrets(JSON.stringify(result), secrets), { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
}
function translateChat(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "body" };
  const allowed = new Set(["model", "messages", "tools", "tool_choice", "parallel_tool_calls", "stream", "stream_options"]);
  const invalid = Object.keys(body).find((key) => !allowed.has(key));
  if (invalid) return { error: invalid };
  if (!validModel(body.model)) return { error: "model" };
  if (!Array.isArray(body.messages) || !body.messages.length || body.messages.length > 256) return { error: "messages" };
  if (body.stream !== undefined && typeof body.stream !== "boolean") return { error: "stream" };
  if (body.stream_options !== undefined && (body.stream !== true || !isObject(body.stream_options) ||
      Object.keys(body.stream_options).some((key) => key !== "include_usage") ||
      typeof body.stream_options.include_usage !== "boolean")) return { error: "stream_options" };
  if (body.parallel_tool_calls !== undefined && typeof body.parallel_tool_calls !== "boolean") return { error: "parallel_tool_calls" };
  if (body.tool_choice !== undefined && (!["auto", "none", "required"].includes(body.tool_choice) ||
      body.tool_choice === "required" && !body.tools?.length)) return { error: "tool_choice" };
  const tools = [];
  const names = new Set();
  if (body.tools !== undefined) {
    if (!Array.isArray(body.tools) || body.tools.length > MAX_TOOL_CALLS) return { error: "tools" };
    for (const tool of body.tools) {
      const type = tool?.type;
      const definition = tool?.[type];
      if (!["function", "custom"].includes(type) || !isObject(definition) ||
          Object.keys(tool).some((key) => key !== "type" && key !== type) || names.has(definition.name) ||
          Object.keys(definition).some((key) => key === "type") ||
          body.stream === true && type === "custom") return { error: "tools" };
      const normalized = { type, ...definition };
      if (type === "custom" && normalized.format?.type === "grammar") {
        const format = normalized.format;
        if (!isObject(format.grammar) || Object.keys(format).some((key) => !["type", "grammar"].includes(key)) ||
            Object.keys(format.grammar).some((key) => !["syntax", "definition"].includes(key))) return { error: "tools" };
        normalized.format = { type: "grammar", ...format.grammar };
      }
      if (!supportedTool(normalized, true)) return { error: "tools" };
      names.add(definition.name);
      tools.push(additionalTool(normalized));
    }
  }
  const input = tools.length ? [{ type: "additional_tools", role: "developer", tools }] : [];
  const seenCalls = new Map();
  const completedCalls = new Set();
  for (const message of body.messages) {
    if (!message || typeof message !== "object" || Array.isArray(message)) return { error: "messages" };
    if (message.role === "tool") {
      if (Object.keys(message).some((key) => !["role", "tool_call_id", "content"].includes(key)) ||
          !validCallId(message.tool_call_id) || !seenCalls.has(message.tool_call_id) || completedCalls.has(message.tool_call_id) ||
          typeof message.content !== "string") return { error: "messages" };
      completedCalls.add(message.tool_call_id);
      input.push({ type: `${seenCalls.get(message.tool_call_id)}_output`, call_id: message.tool_call_id, output: message.content });
    } else if (["user", "assistant", "developer"].includes(message.role)) {
      if (Object.keys(message).some((key) => !["role", "content", "tool_calls"].includes(key)) ||
          message.role !== "assistant" && message.tool_calls !== undefined ||
          !(typeof message.content === "string" || message.role === "assistant" &&
            (message.content === null || message.content === undefined) && Array.isArray(message.tool_calls))) return { error: "messages" };
      if (typeof message.content === "string" && (message.content !== "" || !message.tool_calls?.length)) input.push({ role: message.role, content: message.content });
      if (message.tool_calls !== undefined) {
        if (!Array.isArray(message.tool_calls) || !message.tool_calls.length || message.tool_calls.length > MAX_TOOL_CALLS) return { error: "messages" };
        for (const call of message.tool_calls) {
          const type = call?.type;
          const definition = call?.[type];
          const field = type === "function" ? "arguments" : "input";
          if (!isObject(call) || !["function", "custom"].includes(type) ||
              Object.keys(call).some((key) => !["id", "type", type].includes(key)) ||
              !validCallId(call.id) || seenCalls.has(call.id) || !isObject(definition) ||
              Object.keys(definition).some((key) => !["name", field].includes(key)) ||
              !validModel(definition.name) || !boundedArguments(definition[field])) return { error: "messages" };
          const responseType = type === "function" ? "function_call" : "custom_tool_call";
          seenCalls.set(call.id, responseType);
          input.push({ type: responseType, call_id: call.id, name: definition.name, [field]: definition[field] });
        }
      }
    } else return { error: "messages" };
    if (input.length > 256) return { error: "messages" };
  }
  if (completedCalls.size !== seenCalls.size) return { error: "messages" };
  return { request: { model: body.model, input, store: false, stream: true,
    ...(body.tool_choice !== undefined && { tool_choice: body.tool_choice }),
    ...(body.parallel_tool_calls !== undefined && { parallel_tool_calls: body.parallel_tool_calls }) },
  stream: body.stream === true, streamOptions: body.stream_options };
}
function imageRequest(fields) {
  const { prompt, model, n, quality, size, background, response_format: format } = fields;
  if (model !== CODEX_IMAGES_MODEL) return failure(`Only the model ${CODEX_IMAGES_MODEL} is available with the Codex image sign-in.`, "model", 400, "unsupported_model");
  const unknown = Object.keys(fields).find((name) => !IMAGE_FIELDS.has(name));
  if (unknown !== undefined) return failure("This parameter is not available with the Codex image sign-in.", unknown.slice(0, 64), 400, "unsupported_parameter");
  if (typeof prompt !== "string" || prompt.length < 1 || prompt.length > 32_000) return failure("A prompt of 1 to 32000 characters is required.", "prompt", 400, "invalid_value");
  if (n !== undefined && n !== 1 && n !== "1") return failure("The Codex image sign-in returns one image per request.", "n", 400, "unsupported_parameter");
  if (format !== undefined && format !== "b64_json") return failure("The Codex image sign-in returns b64_json images only.", "response_format", 400, "unsupported_parameter");
  const level = quality === "standard" ? "auto" : quality;
  for (const [param, value, allowed] of [["quality", level, IMAGE_QUALITIES], ["size", size, IMAGE_SIZES], ["background", background, IMAGE_BACKGROUNDS]]) {
    if (value !== undefined && !allowed.has(value)) return failure(`Use one of: ${[...allowed].join(", ")}.`, param, 400, "invalid_value");
  }
  return { prompt, model, ...(level !== undefined && { quality: level }), ...(size !== undefined && { size }), ...(background !== undefined && { background }) };
}
function generationRequest(raw) {
  let fields;
  try { fields = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw)); }
  catch { return failure("Request body must be bounded JSON.", "body", 400, "invalid_json"); }
  return isObject(fields) ? imageRequest(fields) : failure("Request body must be a JSON object.", "body", 400, "invalid_json");
}
function multipartBoundary(contentType) {
  const [type, ...params] = (contentType ?? "").split(";");
  if (type.trim().toLowerCase() !== "multipart/form-data") return null;
  const match = params.map((param) => /^\s*boundary\s*=\s*(?:"([^"]*)"|([^\s"]*))\s*$/iu.exec(param)).find(Boolean);
  const boundary = match?.[1] ?? match?.[2] ?? "";
  return /^[0-9A-Za-z'()+_,.\/:=? -]{0,69}[0-9A-Za-z'()+_,.\/:=?-]$/u.test(boundary) ? boundary : null;
}
function partHeaders(text) {
  let disposition, type;
  for (const line of text.split("\r\n")) {
    const header = /^([A-Za-z0-9-]+):(.*)$/u.exec(line);
    if (!header) return null;
    const key = header[1].toLowerCase();
    if (key === "content-disposition") { if (disposition !== undefined) return null; disposition = header[2].trim(); }
    else if (key === "content-type") { if (type !== undefined) return null; type = header[2].trim(); }
  }
  const params = /^form-data((?:[ \t]*;[ \t]*[A-Za-z0-9*-]+[ \t]*=[ \t]*(?:"[^"]*"|[^;"\s]+))*)[ \t]*$/iu.exec(disposition ?? "")?.[1];
  let name;
  for (const [, key, quoted, token] of params?.matchAll(/[ \t]*;[ \t]*([A-Za-z0-9*-]+)[ \t]*=[ \t]*(?:"([^"]*)"|([^;"\s]+))/gu) ?? []) {
    if (key.toLowerCase() === "name") name ??= quoted ?? token;
  }
  return name ? { name, type: type?.split(";")[0].trim().toLowerCase() } : null;
}
// ponytail: buffers the whole bounded body (48 MiB) before parsing; stream parts if the limit grows.
function parseMultipart(body, boundary) {
  const delimiter = Buffer.from(`\r\n--${boundary}`);
  if (!body.subarray(0, delimiter.length - 2).equals(delimiter.subarray(2))) return null;
  const parts = [];
  let position = delimiter.length - 2;
  for (;;) {
    if (body[position] === 0x2d && body[position + 1] === 0x2d) return parts;
    if (body[position] !== 0x0d || body[position + 1] !== 0x0a || parts.length === MAX_PARTS) return null;
    const headerEnd = body.subarray(position, position + MAX_PART_HEADERS + 4).indexOf("\r\n\r\n");
    if (headerEnd < 0) return null;
    const headers = partHeaders(body.toString("latin1", position + 2, position + headerEnd));
    const start = position + headerEnd + 4;
    const end = body.indexOf(delimiter, start);
    if (!headers || end < 0) return null;
    parts.push({ ...headers, content: body.subarray(start, end) });
    position = end + delimiter.length;
  }
}
function editRequest(raw, contentType) {
  const boundary = multipartBoundary(contentType);
  const parts = boundary && parseMultipart(raw, boundary);
  if (!parts) return failure("Image edits need multipart/form-data with at most 64 parts and 8 KiB of headers per part.", "body", 400, "invalid_multipart");
  const fields = Object.create(null);
  const images = [];
  for (const part of parts) {
    if (part.name === "image" || part.name === "image[]") images.push(part);
    else if (part.name in fields) return failure("Each image parameter may appear only once.", part.name.slice(0, 64), 400, "invalid_multipart");
    else fields[part.name] = part.content.toString();
  }
  const upstream = imageRequest(fields);
  if (upstream instanceof Response) return upstream;
  if (images.length < 1 || images.length > MAX_EDIT_IMAGES) return failure("Send 1 to 16 images.", "image", 400, "invalid_value");
  for (const image of images) {
    if (!IMAGE_TYPES.has(image.type) || image.content.length === 0) return failure("Each image must be a non-empty PNG, JPEG, WebP or GIF file.", "image", 400, "invalid_value");
    if (image.content.length > MAX_EDIT_IMAGE) return failure("Each image is limited to 25 MiB.", "image", 413, "image_too_large");
  }
  return { ...upstream, images: images.map((image) => ({ image_url: `data:${image.type};base64,${image.content.toString("base64")}` })) };
}
async function imagesRoute(request, path, { editSlot, ...deps }) {
  if (request.method !== "POST") return failure("This method is not available.", "method", 405);
  if (path !== "/v1/images/edits") return forwardImage(request, path, deps);
  // ponytail: one edit per sidecar keeps a 48 MiB body and its base64 copies inside mem_limit; queue edits if parallel ones are needed.
  if (editSlot.busy) return failure("Another image edit is in progress. Try again shortly.", null, 429, "images_busy", "retry-later");
  editSlot.busy = true;
  try { return await forwardImage(request, path, deps); }
  finally { editSlot.busy = false; }
}
async function forwardImage(request, path, { fetchImpl, getImagesLease }) {
  const edits = path === "/v1/images/edits";
  // The add-on is checked before the body is read, so an off or expired sign-in never buffers an upload.
  // ponytail: a lease slower than requestTimeout (a refresh queued behind a sign-in exchange) ends an unread upload with 408.
  let lease;
  try { lease = await getImagesLease(); }
  catch (error) {
    if (error?.code === "images_off") return failure(IMAGES_OFF, null, 404, "images_off");
    if (error?.code === "images_reauthorize") return failure("The Codex image sign-in expired. Sign in for images again in Relmio.", null, 401, "images_reauthorize", "reauthorize");
    return failure("Image generation is unavailable right now.", null, 503, "images_unavailable");
  }
  let raw;
  try { raw = await readBody(request, edits ? MAX_EDIT_BODY : MAX_IMAGE_JSON); }
  catch (error) {
    if (error?.message === "body_too_large") return failure(edits ? "Image edit bodies are limited to 48 MiB." : "Image generation bodies are limited to 64 KiB.", "body", 413, "body_too_large");
    return failure("The request body could not be read.", "body", 400, edits ? "invalid_multipart" : "invalid_json");
  }
  const body = edits ? editRequest(raw, request.headers.get("content-type")) : generationRequest(raw);
  if (body instanceof Response) return body;
  const secrets = [lease.accessToken, request.headers.get("authorization").slice("Bearer ".length), body.prompt];
  let upstream;
  try {
    upstream = await fetchImpl(`${IMAGES_BASE_URL}${path.slice("/v1".length)}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${lease.accessToken}`, "chatgpt-account-id": lease.accountId,
        ...(lease.residency && { "x-openai-internal-codex-residency": lease.residency }),
        ...(lease.fedramp === true && { "x-openai-fedramp": "true" }),
        originator: "relmio", "user-agent": IMAGES_USER_AGENT, "x-codex-image-turn-id": randomUUID(), "content-type": "application/json",
      },
      body: JSON.stringify(body), redirect: "error", signal: AbortSignal.any([request.signal, AbortSignal.timeout(IMAGES_TIMEOUT_MS)]),
    });
  } catch { return failure("The Codex image request failed.", null, 502, "images_upstream_failed"); }
  if (!upstream.ok) {
    let detail;
    try { detail = await readJson(upstream, 16_384); } catch { detail = null; }
    if (upstream.status === 429) {
      const source = isObject(detail?.error) ? detail.error : {};
      const code = [source.type, source.code].find((value) => typeof value === "string" && /^[A-Za-z0-9_.-]{1,64}$/u.test(value)) ?? "rate_limited";
      return Response.json({ error: { message: "Codex image usage is limited for this plan right now.", type: "rate_limit_error", code, ...(Number.isSafeInteger(source.resets_at) && { resets_at: source.resets_at }) }, status: 429, recovery: "retry-later" }, { status: 429, headers: { "cache-control": "no-store" } });
    }
    if (upstream.status === 401) return failure("Codex rejected the image sign-in. Sign in for images again in Relmio.", null, 502, "images_upstream_unauthorized", "reauthorize");
    if (upstream.status >= 500) return failure("The Codex image request failed.", null, 502, "images_upstream_failed");
    return Response.json(safeError(detail, upstream.status, upstream.headers.get("x-request-id"), secrets), { status: upstream.status, headers: { "cache-control": "no-store" } });
  }
  let result;
  try { result = await readJson(upstream, MAX_IMAGE_RESPONSE); }
  catch { return failure("The Codex image response was interrupted or too large.", null, 502, "images_upstream_failed"); }
  const image = Array.isArray(result?.data) ? result.data[0]?.b64_json : undefined;
  if (typeof image !== "string" || !image) return failure("Codex returned no image.", null, 502, "images_invalid_response");
  const reported = ["size", "quality", "background"].filter((key) => typeof result[key] === "string" && result[key].length <= 64).map((key) => [key, result[key]]);
  return Response.json({ created: Number.isSafeInteger(result.created) ? result.created : Math.floor(Date.now() / 1000), data: [{ b64_json: image }], ...Object.fromEntries(reported) }, { headers: { "cache-control": "no-store" } });
}

export function createSidecarHandler({ fetchImpl = fetch, getToken = getAccessToken, registration, runtimeId, tokenVerifier, baseUrl = BASE_URL,
  getImagesLease = () => getCodexImagesLease({ storageRoot: registration.storageRoot }),
  imagesStatus = () => codexImagesStatus({ storageRoot: registration.storageRoot }) } = {}) {
  if (!registration?.storageRoot || !registration?.registrationId || !runtimeId || !Buffer.isBuffer(tokenVerifier) || tokenVerifier.length !== 32) throw new TypeError("The sidecar requires a selected owned registration and local credential verifier.");
  const editSlot = { busy: false };
  return async (request) => {
    const path = new URL(request.url).pathname;
    if (request.headers.has("origin")) return failure("Browser origins are not allowed.", "origin", 403, "origin_rejected");
    if (!validPrivateHost(request.headers.get("host"))) return failure("The sidecar host is not allowed.", "host", 421, "host_rejected");
    if (path === "/health" && request.method === "GET") return Response.json({ status: "ok" });
    if (!validBearer(request, tokenVerifier)) return unauthorized();
    if (path === "/v1/images/generations" || path === "/v1/images/edits") return imagesRoute(request, path, { fetchImpl, getImagesLease, editSlot });
    if (path !== "/v1/models" && path !== "/v1/responses" && path !== "/v1/chat/completions") return failure("This route is not available with ChatGPT plan usage.", "route", 404);
    if (path === "/v1/models" ? request.method !== "GET" : request.method !== "POST") return failure("This method is not available.", "method", 405);
    let body, streamOptions, stream = false, chat = false;
    if (path !== "/v1/models") {
      try { body = await readJson(request); }
      catch (error) { return failure("Request body must be bounded JSON.", "body", error?.message === "body_too_large" ? 413 : 400, error?.message === "body_too_large" ? "body_too_large" : "invalid_json"); }
      if (path === "/v1/chat/completions") {
        const translated = translateChat(body);
        if (translated.error) return failure("This chat parameter or message cannot be represented by Responses.", translated.error);
        const invalid = validateResponses(translated.request);
        if (invalid) return failure("This chat request cannot be represented by Responses.", invalid);
        stream = translated.stream; streamOptions = translated.streamOptions; body = translated.request; chat = true;
      } else {
        const normalized = normalizeFlatTools(body);
        if (normalized.error) return failure("The tool definitions cannot be represented by this plan route.", normalized.error);
        body = normalized.body;
        const invalid = validateResponses(body);
        if (invalid) return failure("This Responses parameter is unavailable with ChatGPT plan usage.", invalid);
        stream = body.stream === true;
        body = { ...body, store: false, stream: true };
        delete body.background;
      }
    }
    let lease;
    try { lease = await getToken(registration, { runtimeId, minValidityMs: 60_000, signal: request.signal }); }
    catch (error) {
      const recovery = ["retry-later", "reauthorize", "enable-plan", "fix-configuration", "resolve-handoff"].includes(error?.recovery) ? error.recovery : "enable-plan";
      const status = recovery === "reauthorize" ? 401 : recovery === "resolve-handoff" ? 409 : recovery === "retry-later" || recovery === "fix-configuration" ? 503 : 403;
      return failure("The selected ChatGPT registration is not available for plan use.", null, status, "registration_unavailable", recovery);
    }
    let upstream;
    try {
      upstream = await fetchImpl(`${baseUrl}${path === "/v1/models" ? MODEL_CATALOG_PATH : "/responses"}`, {
        method: path === "/v1/models" ? "GET" : "POST",
        headers: { authorization: `Bearer ${lease.accessToken}`, ...(body && { "content-type": "application/json" }) },
        ...(body && { body: JSON.stringify(body) }), signal: request.signal,
      });
    } catch { return failure("The provider request was interrupted.", null, 503, "request_interrupted"); }
    if (!upstream.ok) return Response.json(await providerError(upstream, [lease.accessToken]), { status: upstream.status, headers: { "cache-control": "no-store" } });
    if (path === "/v1/models") {
      let data;
      try {
        const models = (await readJson(upstream)).models;
        if (!Array.isArray(models) || !models.every((m) => m && typeof m.slug === "string" && typeof m.visibility === "string")) throw new Error("invalid_catalog");
        data = models.filter((m) => m.visibility === "list").map((m) => ({ id: redactSecrets(m.slug, [lease.accessToken]), object: "model", display_name: redactSecrets(typeof m.display_name === "string" ? m.display_name : m.slug, [lease.accessToken]) }));
      } catch { return failure("The account model catalog was invalid.", null, 502, "invalid_catalog"); }
      let images = false;
      try { images = (await imagesStatus()).state === "signed-in"; } catch { /* Text models stay listed when the image add-on cannot be read. */ }
      if (images) data.push({ id: CODEX_IMAGES_MODEL, object: "model", display_name: "GPT Image 2 (Codex sign-in)" });
      return Response.json({ object: "list", data }, { headers: { "cache-control": "no-store" } });
    }
    if (!upstream.body) return failure("The provider returned no response stream.", null, 502, "stream_interrupted");
    return stream ? streamResponse(upstream, chat && { ...body, streamOptions }, [lease.accessToken]) : aggregate(upstream, chat, body.model, [lease.accessToken]);
  };
}
export async function listSiwcModels({ storageRoot, registrationId, runtimeId, fetchImpl = fetch, getToken = getAccessToken, signal } = {}) {
  const lease = await getToken({ storageRoot, registrationId }, { runtimeId, minValidityMs: 60_000, signal });
  const response = await fetchImpl(`${BASE_URL}${MODEL_CATALOG_PATH}`, {
    headers: { authorization: `Bearer ${lease.accessToken}` }, signal,
  });
  if (!response.ok) {
    const error = await providerError(response, [lease.accessToken]);
    throw Object.assign(new Error(error.error.message), error);
  }
  const models = (await readJson(response)).models;
  if (!Array.isArray(models) || !models.every((m) => m && typeof m.slug === "string" && typeof m.visibility === "string")) {
    throw new Error("The account model catalog was invalid.");
  }
  return models.filter((m) => m.visibility === "list").map((m) => ({
    slug: redactSecrets(m.slug, [lease.accessToken]),
    display_name: redactSecrets(typeof m.display_name === "string" ? m.display_name : m.slug, [lease.accessToken]),
  }));
}
export function createSidecarServer(handler) {
  const active = new Map();
  let quiescing = false;
  const server = createServer({ maxHeaderSize: 16_384 }, async (req, res) => {
    if (quiescing) { res.writeHead(503); res.end(); return; }
    const controller = new AbortController();
    active.set(res, controller);
    res.on("close", () => { if (!res.writableFinished) controller.abort(); });
    try {
      if (req.rawHeaders.filter((name, index) => index % 2 === 0 && name.toLowerCase() === "host").length !== 1) {
        const rejection = failure("The sidecar host is not allowed.", "host", 421, "host_rejected");
        res.writeHead(rejection.status, Object.fromEntries(rejection.headers));
        res.end(await rejection.text());
        return;
      }
      const request = new Request(new URL(req.url, "http://sidecar.local"), { method: req.method, headers: req.headers, signal: controller.signal, ...(!["GET", "HEAD"].includes(req.method) && { body: Readable.toWeb(req), duplex: "half" }) });
      const response = await handler(request);
      if (controller.signal.aborted) return;
      res.writeHead(response.status, Object.fromEntries(response.headers));
      if (response.body) await pipeline(Readable.fromWeb(response.body), res);
      else res.end();
    } catch {
      if (res.headersSent) res.destroy();
      else { res.writeHead(500, { "content-type": "application/json" }); res.end(JSON.stringify({ error: { message: "The request failed.", code: "gateway_error" } })); }
    } finally { active.delete(res); }
  });
  server.headersTimeout = 10_000;
  server.requestTimeout = 30_000;
  server.maxHeadersCount = 32;
  server.quiesce = () => {
    quiescing = true;
    for (const [response, controller] of active) {
      controller.abort();
      response.destroy();
    }
    return new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  };
  return server;
}
function config(environment = process.env) {
  const registrationId = environment.RELMIO_REGISTRATION_ID;
  const runtimeId = environment.RELMIO_RUNTIME_ID;
  const verifier = environment.RELMIO_GATEWAY_TOKEN_SHA256;
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(registrationId ?? "") || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u.test(runtimeId ?? "") || !/^[a-f0-9]{64}$/u.test(verifier ?? "")) throw new Error("Invalid sidecar configuration.");
  return { registration: { storageRoot: resolveSiwcStorageRoot({ env: environment }), registrationId }, runtimeId, tokenVerifier: Buffer.from(verifier, "hex") };
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const server = createSidecarServer(createSidecarHandler(config()));
    server.listen(10531, "0.0.0.0");
    for (const signal of ["SIGINT", "SIGTERM"]) process.once(signal, () => { void server.quiesce(); });
  } catch { process.stderr.write("Relmio sidecar could not start.\n"); process.exitCode = 1; }
}

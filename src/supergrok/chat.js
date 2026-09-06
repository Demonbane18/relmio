import { createHash, timingSafeEqual } from 'node:crypto';
import { once } from 'node:events';

const UPSTREAM = 'https://cli-chat-proxy.grok.com/v1/chat/completions';
const MODELS_UPSTREAM = 'https://cli-chat-proxy.grok.com/v1/models';
const MAX_REQUEST = 1024 * 1024;
const MAX_RESPONSE = 8 * 1024 * 1024;
const MAX_EVENT = 1024 * 1024;
const MAX_MODELS_RESPONSE = 256 * 1024;
const MAX_MODELS = 256;
const MODELS_TIMEOUT_MS = 15_000;
const VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const fail = code => Object.assign(new Error(code), { code });
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const only = (value, keys) => object(value) && Object.keys(value).every(key => keys.includes(key));
const MODEL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const REQUEST_FIELDS = ['model', 'messages', 'stream', 'stream_options', 'tools', 'tool_choice', 'parallel_tool_calls', 'reasoning_effort', 'temperature', 'top_p', 'max_tokens', 'max_completion_tokens', 'frequency_penalty', 'presence_penalty', 'stop', 'seed', 'n'];
const validContent = value => typeof value === 'string' || (Array.isArray(value) && value.length > 0 && value.every(part => object(part) && ((part.type === 'text' && typeof part.text === 'string') || (part.type === 'image_url' && object(part.image_url) && typeof part.image_url.url === 'string' && part.image_url.url.length > 0))));

export function validateChatRequest(body) {
  if (!only(body, REQUEST_FIELDS) || typeof body.model !== 'string' || !MODEL_ID.test(body.model) || !Array.isArray(body.messages) || body.messages.length === 0 || body.messages.length > 1024 || (body.stream !== undefined && typeof body.stream !== 'boolean')) throw fail('invalid_request');
  if (Object.hasOwn(body, 'reasoning_effort') && !['low', 'medium', 'high', 'xhigh'].includes(body.reasoning_effort)) throw fail('invalid_request');
  for (const [key, min, max] of [['temperature', 0, 2], ['top_p', 0, 1], ['frequency_penalty', -2, 2], ['presence_penalty', -2, 2]]) {
    if (body[key] !== undefined && (!Number.isFinite(body[key]) || body[key] < min || body[key] > max)) throw fail('invalid_request');
  }
  for (const key of ['max_tokens', 'max_completion_tokens']) if (body[key] !== undefined && (!Number.isSafeInteger(body[key]) || body[key] < 1)) throw fail('invalid_request');
  if ((body.max_tokens !== undefined && body.max_completion_tokens !== undefined) || (body.seed !== undefined && !Number.isSafeInteger(body.seed)) || (body.n !== undefined && body.n !== 1) || (body.parallel_tool_calls !== undefined && typeof body.parallel_tool_calls !== 'boolean')) throw fail('invalid_request');
  if (body.stream_options !== undefined && (!only(body.stream_options, ['include_usage']) || body.stream !== true || typeof body.stream_options.include_usage !== 'boolean')) throw fail('invalid_request');
  if (body.stop !== undefined && !(typeof body.stop === 'string' || (Array.isArray(body.stop) && body.stop.length > 0 && body.stop.length <= 4 && body.stop.every(value => typeof value === 'string')))) throw fail('invalid_request');
  const pending = new Set();
  const seen = new Set();
  const messages = [];
  for (const message of body.messages) {
    if (!only(message, ['role', 'content', 'name', 'tool_call_id', 'tool_calls']) || !['system', 'developer', 'user', 'assistant', 'tool'].includes(message.role) || (message.name !== undefined && typeof message.name !== 'string')) throw fail('invalid_request');
    if (Array.isArray(message.content) && message.content.some(part => !object(part) || !only(part, part.type === 'text' ? ['type', 'text'] : ['type', 'image_url']) || (part.type === 'image_url' && (!only(part.image_url, ['url', 'detail']) || (part.image_url.detail !== undefined && !['auto', 'low', 'high'].includes(part.image_url.detail)))))) throw fail('invalid_request');
    if (message.role === 'tool') {
      if (!pending.delete(message.tool_call_id) || typeof message.content !== 'string') throw fail('invalid_tool_history');
      messages.push(message);
      continue;
    }
    if (pending.size) throw fail('invalid_tool_history');
    const emptyToolContent = message.role === 'assistant' && Array.isArray(message.content) && message.content.length === 0;
    if (!validContent(message.content) && !(message.role === 'assistant' && (message.content == null || emptyToolContent) && Array.isArray(message.tool_calls) && message.tool_calls.length > 0)) throw fail('invalid_request');
    if (message.tool_calls !== undefined) {
      if (message.role !== 'assistant' || !Array.isArray(message.tool_calls) || message.tool_calls.length === 0 || message.tool_calls.length > 128) throw fail('invalid_tool_history');
      for (const call of message.tool_calls) {
        if (!only(call, ['id', 'type', 'function']) || typeof call.id !== 'string' || !/^[A-Za-z0-9_-]{1,256}$/u.test(call.id) || seen.has(call.id) || call.type !== 'function' || !only(call.function, ['name', 'arguments']) || typeof call.function.name !== 'string' || typeof call.function.arguments !== 'string') throw fail('invalid_tool_history');
        seen.add(call.id); pending.add(call.id);
      }
    }
    messages.push(emptyToolContent ? { ...message, content: null } : message);
  }
  if (pending.size) throw fail('invalid_tool_history');
  if (body.tools !== undefined && (!Array.isArray(body.tools) || body.tools.length > 128 || body.tools.some(tool => !only(tool, ['type', 'function']) || tool.type !== 'function' || !only(tool.function, ['name', 'description', 'parameters', 'strict']) || typeof tool.function.name !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(tool.function.name) || (tool.function.description !== undefined && typeof tool.function.description !== 'string') || (tool.function.parameters !== undefined && !object(tool.function.parameters)) || (tool.function.strict !== undefined && typeof tool.function.strict !== 'boolean')))) throw fail('invalid_request');
  if (body.tool_choice !== undefined && !['auto', 'none', 'required'].includes(body.tool_choice)) {
    const choice = body.tool_choice;
    if (!only(choice, ['type', 'function']) || choice.type !== 'function' || !only(choice.function, ['name']) || !body.tools?.some(tool => tool.function.name === choice.function.name)) throw fail('invalid_request');
  }
  return Object.fromEntries(REQUEST_FIELDS.filter(key => Object.hasOwn(body, key)).map(key => [key, key === 'messages' ? messages : body[key]]));
}

function headerCount(request, name) {
  let count = 0;
  for (let i = 0; i < request.rawHeaders.length; i += 2) if (request.rawHeaders[i].toLowerCase() === name) count++;
  return count;
}
function json(response, status, body) {
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
  response.end(JSON.stringify(body));
}
async function readBody(stream, limit) {
  const chunks = []; let bytes = 0;
  for await (const chunk of stream) {
    bytes += chunk.length;
    if (bytes > limit) throw fail('body_limit');
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString('utf8');
}

const oauthHeaders = (token, gatewayVersion) => ({ authorization: `Bearer ${token}`, 'X-XAI-Token-Auth': 'xai-grok-cli', 'x-grok-client-version': '1.0.13', 'x-grok-client-mode': 'headless', 'x-grok-client-identifier': 'relmio', 'user-agent': `relmio/${gatewayVersion} grok/1.0.13` });

async function requireUpstreamSuccess(upstream) {
  if (upstream.ok) return;
  await upstream.body?.cancel();
  if (upstream.status === 401 || upstream.status === 403) throw fail('login_required');
  if (upstream.status === 429) throw fail('provider_quota');
  throw fail('provider_error');
}

function normalizeModels(value) {
  if (!object(value) || value.error || !Array.isArray(value.data) || value.data.length > MAX_MODELS) throw fail('invalid_upstream');
  const found = new Set();
  const models = [];
  for (const entry of value.data) {
    if (!object(entry) || (entry._meta !== undefined && !object(entry._meta))) continue;
    const meta = entry._meta;
    const hiddenValue = Object.hasOwn(entry, 'hidden') ? entry.hidden : meta?.hidden;
    if (hiddenValue !== undefined && typeof hiddenValue !== 'boolean') continue;
    if (hiddenValue === true) continue;
    const model = [entry.model, entry.modelId, entry.id, meta?.model, meta?.modelId].find(candidate => typeof candidate === 'string');
    if (!MODEL_ID.test(model ?? '') || found.has(model)) continue;
    found.add(model); models.push(model);
  }
  return models;
}

async function fetchModels(token, gatewayVersion, fetchImpl, signal) {
  const upstream = await fetchImpl(MODELS_UPSTREAM, { method: 'GET', redirect: 'error', signal, headers: oauthHeaders(token, gatewayVersion) });
  await requireUpstreamSuccess(upstream);
  const text = await readBody(upstream.body, MAX_MODELS_RESPONSE);
  let value; try { value = JSON.parse(text); } catch { throw fail('invalid_upstream'); }
  return normalizeModels(value);
}

// Both ends speak Chat Completions. Preserve each delta exactly once; never
// concatenate arguments and then emit the same arguments a second time.
export async function relayChatStream(body, write, signal) {
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = ''; let bytes = 0; let done = false; let terminal = false;
  const consume = async event => {
    const data = event.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /u, '')).join('\n');
    if (!data) return;
    if (done) throw fail('invalid_upstream');
    if (data === '[DONE]') {
      if (!terminal) throw fail('invalid_upstream');
      done = true; await write('data: [DONE]\n\n'); return;
    }
    let value; try { value = JSON.parse(data); } catch { throw fail('invalid_upstream'); }
    if (!object(value) || value.error || !Array.isArray(value.choices)) throw fail('invalid_upstream');
    for (const choice of value.choices) {
      if (!object(choice) || choice.index !== 0 || !object(choice.delta)) throw fail('invalid_upstream');
      if (terminal && (Object.keys(choice.delta).length || choice.finish_reason)) throw fail('invalid_upstream');
      if (choice.finish_reason) terminal = true;
    }
    await write(`data: ${JSON.stringify(value)}\n\n`);
  };
  for await (const chunk of body) {
    signal?.throwIfAborted();
    bytes += chunk.length;
    if (bytes > MAX_RESPONSE) throw fail('body_limit');
    buffer += decoder.decode(chunk, { stream: true });
    buffer = buffer.replace(/\r\n/gu, '\n');
    let index;
    while ((index = buffer.indexOf('\n\n')) >= 0) {
      const event = buffer.slice(0, index); buffer = buffer.slice(index + 2);
      if (Buffer.byteLength(event) > MAX_EVENT) throw fail('body_limit');
      await consume(event);
    }
    if (Buffer.byteLength(buffer) > MAX_EVENT) throw fail('body_limit');
  }
  buffer += decoder.decode();
  if (buffer.trim() || !done) throw fail('incomplete_upstream');
}

export function createGrokSessionChatHandler({ session, tokenVerifier, allowedHosts, gatewayVersion, fetchImpl = fetch, timeoutMs = 120_000 }) {
  if (!session || typeof session.withToken !== 'function' || !Buffer.isBuffer(tokenVerifier) || tokenVerifier.length !== 32 || !Array.isArray(allowedHosts) || allowedHosts.length === 0 || allowedHosts.some(host => typeof host !== 'string' || !/^[a-zA-Z0-9.-]+(?::[0-9]{1,5})?$/u.test(host)) || typeof gatewayVersion !== 'string' || !VERSION_PATTERN.test(gatewayVersion)) throw fail('invalid_configuration');
  const verifier = Buffer.from(tokenVerifier);
  const hosts = new Set(allowedHosts);
  let busy = false;
  return async function handle(request, response) {
    const controller = new AbortController();
    const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]);
    const close = () => controller.abort();
    response.once('close', close);
    const timeout = () => { if (!request.complete) request.destroy(); };
    signal.addEventListener('abort', timeout, { once: true });
    let acquired = false;
    try {
      if (headerCount(request, 'host') !== 1 || !hosts.has(request.headers.host) || request.headers.origin !== undefined) return json(response, 403, { error: { code: 'forbidden' } });
      const authorization = request.headers.authorization;
      if (headerCount(request, 'authorization') !== 1 || typeof authorization !== 'string' || !/^Bearer [A-Za-z0-9_-]{32,256}$/u.test(authorization) || !timingSafeEqual(createHash('sha256').update(authorization.slice(7)).digest(), verifier)) return json(response, 401, { error: { code: 'unauthorized' } });
      if (request.method === 'GET' && request.url === '/health') return json(response, 200, { ok: true, transport: 'grok-session-chat', providerReadiness: 'not-probed' });
      if (request.method === 'GET' && request.url === '/v1/models') {
        const modelSignal = AbortSignal.any([signal, AbortSignal.timeout(MODELS_TIMEOUT_MS)]);
        return await session.withToken(async token => {
          const models = await fetchModels(token, gatewayVersion, fetchImpl, modelSignal);
          json(response, 200, { object: 'list', data: models.map(id => ({ id, object: 'model', owned_by: 'xai' })) });
        }, { signal: modelSignal });
      }
      if (request.method !== 'POST' || request.url !== '/v1/chat/completions') return json(response, 404, { error: { code: 'not_found' } });
      if (busy) return json(response, 409, { error: { code: 'busy' } });
      busy = true; acquired = true;
      if (!/^application\/json(?:\s*;|$)/iu.test(request.headers['content-type'] ?? '')) return json(response, 415, { error: { code: 'content_type' } });
      let input;
      try { input = validateChatRequest(JSON.parse(await readBody(request, MAX_REQUEST))); } catch { return json(response, 400, { error: { code: 'invalid_request' } }); }
      // The runtime's official login owns this session. No key, import, account
      // switching or unverified refresh endpoint exists in this transport.
      await session.withToken(async token => {
        if (input.model !== 'grok-build') {
          const modelSignal = AbortSignal.any([signal, AbortSignal.timeout(MODELS_TIMEOUT_MS)]);
          const models = await fetchModels(token, gatewayVersion, fetchImpl, modelSignal);
          if (!models.includes(input.model)) return json(response, 400, { error: { code: 'unknown_model' } });
        }
        const upstream = await fetchImpl(UPSTREAM, {
          method: 'POST', redirect: 'error', signal,
          headers: { 'content-type': 'application/json', ...oauthHeaders(token, gatewayVersion), 'x-grok-model-override': input.model },
          body: JSON.stringify(input),
        });
        await requireUpstreamSuccess(upstream);
        if (input.stream) {
          if (!(upstream.headers.get('content-type') ?? '').startsWith('text/event-stream')) { await upstream.body?.cancel(); throw fail('invalid_upstream'); }
          response.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' });
          await relayChatStream(upstream.body, async frame => {
            signal.throwIfAborted();
            if (!response.write(frame)) await once(response, 'drain', { signal });
          }, signal);
          response.end();
        } else {
          const text = await readBody(upstream.body, MAX_RESPONSE);
          let value; try { value = JSON.parse(text); } catch { throw fail('invalid_upstream'); }
          if (!object(value) || value.error || !Array.isArray(value.choices) || value.choices.length !== 1 || !object(value.choices[0]?.message)) throw fail('invalid_upstream');
          json(response, 200, value);
        }
      }, { signal });
    } catch (error) {
      if (response.destroyed) return;
      const code = ['login_required', 'provider_quota', 'provider_error'].includes(error?.code) ? error.code : signal.aborted ? 'request_cancelled' : 'upstream_failed';
      const status = code === 'login_required' ? 401 : code === 'provider_quota' ? 429 : 502;
      if (response.headersSent) { response.write(`data: ${JSON.stringify({ error: { code } })}\n\n`); response.end(); }
      else json(response, status, { error: { code } });
    } finally {
      signal.removeEventListener('abort', timeout);
      controller.abort(); response.off('close', close);
      if (acquired) busy = false;
    }
  };
}

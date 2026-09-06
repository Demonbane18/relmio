import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Readable } from 'node:stream';
import { createGrokSessionChatHandler, relayChatStream, validateChatRequest } from '../src/supergrok/chat.js';

const token = 'test-local-credential-0000000000000000000';
const gatewayVersion = '9.8.7-test.1+build.5';
const modelsUrl = 'https://cli-chat-proxy.grok.com/v1/models';
const call = { id: 'call_one', type: 'function', function: { name: 'nonce', arguments: '{"input":"one"}' } };
const initial = { model: 'grok-build', messages: [{ role: 'user', content: 'Call nonce.' }], tools: [{ type: 'function', function: { name: 'nonce', parameters: { type: 'object' } } }] };
const event = (delta, finish_reason = null) => `data: ${JSON.stringify({ id: 'one', object: 'chat.completion.chunk', choices: [{ index: 0, delta, finish_reason }] })}\n\n`;
const withServer = async (t, fetchImpl, session = { withToken: fn => fn('synthetic-provider-secret') }, { catalog = ['grok-4.6', 'grok-4.5'], timeoutMs } = {}) => {
  let handler;
  const server = createServer((req, res) => handler(req, res));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); server.close(); });
  const host = `127.0.0.1:${server.address().port}`;
  const routedFetch = (url, options) => url === modelsUrl
    ? (typeof catalog === 'function' ? catalog(url, options) : Response.json({ object: 'list', data: catalog.map(id => ({ id, model: id })) }))
    : fetchImpl(url, options);
  handler = createGrokSessionChatHandler({ session, tokenVerifier: createHash('sha256').update(token).digest(), allowedHosts: [host], gatewayVersion, fetchImpl: routedFetch, timeoutMs });
  return (body, headers = {}, path = '/v1/chat/completions', options = {}) => {
    const method = options.method ?? 'POST';
    return fetch(`http://${host}${path}`, { ...options, method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers }, body: method === 'GET' ? undefined : JSON.stringify(body) });
  };
};

test('client-owned tool result is forwarded intact across two HTTP requests', async t => {
  let turns = 0;
  const request = await withServer(t, async (url, options) => {
    assert.equal(url, 'https://cli-chat-proxy.grok.com/v1/chat/completions');
    assert.equal(options.headers.authorization, 'Bearer synthetic-provider-secret');
    assert.equal(options.headers['X-XAI-Token-Auth'], 'xai-grok-cli');
    assert.equal(options.headers['x-grok-model-override'], 'grok-build');
    assert.equal(options.headers['x-grok-client-version'], '1.0.13');
    assert.equal(options.headers['x-grok-client-identifier'], 'relmio');
    assert.equal(options.headers['user-agent'], `relmio/${gatewayVersion} grok/1.0.13`);
    assert.equal(options.redirect, 'error');
    const input = JSON.parse(options.body);
    turns++;
    if (turns === 1) return Response.json({ choices: [{ index: 0, message: { role: 'assistant', content: null, tool_calls: [call] }, finish_reason: 'tool_calls' }] });
    assert.deepEqual(input.messages.at(-2).tool_calls, [call]);
    assert.deepEqual(input.messages.at(-1), { role: 'tool', tool_call_id: 'call_one', content: 'independent-result-714' });
    return Response.json({ choices: [{ index: 0, message: { role: 'assistant', content: 'independent-result-714' }, finish_reason: 'stop' }] });
  });
  const first = await (await request(initial)).json();
  const second = await request({ ...initial, messages: [...initial.messages, first.choices[0].message, { role: 'tool', tool_call_id: 'call_one', content: 'independent-result-714' }] });
  assert.equal(second.status, 200);
  assert.equal((await second.json()).choices[0].message.content, 'independent-result-714');
  assert.equal(turns, 2);
});

test('n8n calculator continuation normalizes empty assistant content without changing client history', async t => {
  const id = 'call-f33fdcd8-e2a4-4fb2-96ff-2774aeedafea-0';
  const calculatorCall = { id, type: 'function', function: { name: 'Calculator', arguments: JSON.stringify({ input: '317 * 29', id }) } };
  const calculator = { model: 'grok-4.6', stream: false, tools: [{ type: 'function', function: { name: 'Calculator', parameters: { type: 'object' } } }], messages: [{ role: 'user', content: 'Calculate 317 * 29.' }] };
  const assistant = { role: 'assistant', content: [], tool_calls: [calculatorCall] };
  const tool = { role: 'tool', tool_call_id: id, content: '[{"response":"9193"}]' };
  let turns = 0;
  const request = await withServer(t, async (url, options) => {
    assert.equal(url, 'https://cli-chat-proxy.grok.com/v1/chat/completions');
    const input = JSON.parse(options.body);
    turns++;
    if (turns === 1) return Response.json({ choices: [{ index: 0, message: { ...assistant, content: null }, finish_reason: 'tool_calls' }] });
    assert.deepEqual(input.messages.at(-2), { ...assistant, content: null });
    assert.deepEqual(input.messages.at(-1), tool);
    return Response.json({ choices: [{ index: 0, message: { role: 'assistant', content: '9193' }, finish_reason: 'stop' }] });
  });
  const first = await request(calculator);
  assert.equal(first.status, 200);
  assert.deepEqual((await first.json()).choices[0].message, { ...assistant, content: null });
  const continuation = { ...calculator, messages: [...calculator.messages, assistant, tool] };
  const second = await request(continuation);
  assert.equal(second.status, 200);
  assert.equal((await second.json()).choices[0].message.content, '9193');
  assert.deepEqual(continuation.messages.at(-2).content, []);
  assert.equal(turns, 2);
});

test('empty array content outside valid tool-call history is rejected before session access', async t => {
  let accesses = 0;
  const request = await withServer(t, () => { throw Error('must not fetch'); }, { withToken: () => { accesses++; throw Error('must not access session'); } });
  const invalidCall = { ...call, function: { ...call.function, arguments: { input: 'one' } } };
  for (const messages of [
    [{ role: 'user', content: [] }],
    [{ role: 'assistant', content: [] }],
    [{ role: 'assistant', content: [], tool_calls: [] }],
    [{ role: 'assistant', content: [], tool_calls: [invalidCall] }],
    [{ role: 'assistant', content: [], tool_calls: [call] }],
  ]) {
    const response = await request({ ...initial, messages });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: { code: 'invalid_request' } });
  }
  assert.equal(accesses, 0);
});

test('stream passes fragmented arguments once, handles byte-split CRLF and usage', async () => {
  const source = event({ role: 'assistant', tool_calls: [{ index: 0, id: 'call_one', type: 'function', function: { name: 'nonce', arguments: '{"x":' } }] }) + event({ tool_calls: [{ index: 0, function: { arguments: '"é"}' } }] }) + event({}, 'tool_calls') + 'data: {"choices":[],"usage":{"total_tokens":1}}\n\ndata: [DONE]\n\n';
  let result = '';
  const bytes = Buffer.from(source.replace(/\n/gu, '\r\n'));
  await relayChatStream(Readable.from([...bytes].map(byte => Buffer.from([byte]))), async frame => { result += frame; });
  assert.equal(result, source);
});

test('stream rejects provider errors, missing terminal and oversized frames without raw errors', async () => {
  for (const source of ['data: {"error":{"message":"secret-value"}}\n\n', event({ content: 'partial' }), 'data: [DONE]\n\n', 'data: ' + 'a'.repeat(1024 * 1024 + 1)]) {
    await assert.rejects(relayChatStream(Readable.from([Buffer.from(source)]), async () => {}), error => !error.message.includes('secret-value'));
  }
});

test('orphan, repeated and unresolved tool results fail before sending requests', () => {
  const assistant = { role: 'assistant', tool_calls: [call] };
  const result = { role: 'tool', tool_call_id: 'call_one', content: 'ok' };
  for (const messages of [[result], [assistant], [assistant, initial.messages[0]], [assistant, result, result], [assistant, result, assistant, result]]) {
    assert.throws(() => validateChatRequest({ ...initial, messages }));
  }
  assert.doesNotThrow(() => validateChatRequest({ ...initial, messages: [assistant, result] }));
});

test('authorization and browser requests are rejected before token access', async t => {
  let accesses = 0;
  const request = await withServer(t, () => { throw Error('must not fetch'); }, { withToken: () => { accesses++; } });
  assert.equal((await request(initial, { authorization: 'Bearer wrong' })).status, 401);
  assert.equal((await request(initial, { origin: 'http://evil.example' })).status, 403);
  assert.equal((await request(undefined, { authorization: 'Bearer wrong' }, '/v1/models', { method: 'GET' })).status, 401);
  assert.equal((await request(undefined, { origin: 'http://evil.example' }, '/v1/models', { method: 'GET' })).status, 403);
  assert.equal(accesses, 0);
});

test('model discovery returns the current account catalog without a static fallback', async t => {
  const request = await withServer(t, () => { throw Error('must not fetch'); });
  const response = await request(undefined, {}, '/v1/models', { method: 'GET' });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { object: 'list', data: [
    { id: 'grok-4.6', object: 'model', owned_by: 'xai' },
    { id: 'grok-4.5', object: 'model', owned_by: 'xai' },
  ] });
});

test('model discovery fetches each account catalog fresh and never returns a stale list', async t => {
  const providerTokens = ['account-one-token', 'account-two-token', 'logged-out-token'];
  let accesses = 0;
  let fetches = 0;
  const session = { withToken: fn => fn(providerTokens[accesses++]) };
  const request = await withServer(t, () => { throw Error('must not infer'); }, session, { catalog: async (url, options) => {
    assert.equal(url, modelsUrl);
    assert.equal(options.method, 'GET');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers['X-XAI-Token-Auth'], 'xai-grok-cli');
    assert.equal(options.headers['x-grok-client-version'], '1.0.13');
    assert.equal(options.headers['x-grok-client-mode'], 'headless');
    assert.equal(options.headers['user-agent'], `relmio/${gatewayVersion} grok/1.0.13`);
    assert.equal(options.signal.aborted, false);
    fetches++;
    if (fetches === 1) {
      assert.equal(options.headers.authorization, 'Bearer account-one-token');
      return Response.json({ data: [{ model: 'grok-account-one' }] });
    }
    if (fetches === 2) {
      assert.equal(options.headers.authorization, 'Bearer account-two-token');
      return Response.json({ data: [{ model: 'grok-account-two' }] });
    }
    return new Response('provider-secret', { status: 401 });
  } });
  assert.deepEqual((await (await request(undefined, {}, '/v1/models', { method: 'GET' })).json()).data.map(model => model.id), ['grok-account-one']);
  assert.deepEqual((await (await request(undefined, {}, '/v1/models', { method: 'GET' })).json()).data.map(model => model.id), ['grok-account-two']);
  const loggedOut = await request(undefined, {}, '/v1/models', { method: 'GET' });
  assert.equal(loggedOut.status, 401);
  assert.deepEqual(await loggedOut.json(), { error: { code: 'login_required' } });
  assert.equal(accesses, 3);
  assert.equal(fetches, 3);
});

test('model discovery exposes only safe visible routing slugs and strips provider metadata', async t => {
  const data = [
    { id: 'catalog-id', model: 'grok-4.6', supportedInApi: false, api_backend: 'responses', baseUrl: 'https://untrusted.example/v1' },
    { modelId: 'grok-4.5', apiBackend: 'messages' },
    { id: 'grok-by-id' },
    { _meta: { model: 'grok-from-meta' } },
    { model: 'grok-4.6', description: 'duplicate' },
    { model: 'grok-hidden', hidden: true },
    { model: 'grok-meta-hidden', _meta: { hidden: true } },
    { model: 'grok/bad' },
    { model: 'bad/name', id: 'grok-must-not-alias' },
    { model: 'grok-bad-meta', _meta: 'malformed' },
    { model: 'grok-bad-hidden', hidden: 'false' },
    null,
  ];
  const request = await withServer(t, () => { throw Error('must not infer'); }, undefined, { catalog: () => Response.json({ object: 'list', data }) });
  const response = await request(undefined, {}, '/v1/models', { method: 'GET' });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { object: 'list', data: [
    { id: 'grok-4.6', object: 'model', owned_by: 'xai' },
    { id: 'grok-4.5', object: 'model', owned_by: 'xai' },
    { id: 'grok-by-id', object: 'model', owned_by: 'xai' },
    { id: 'grok-from-meta', object: 'model', owned_by: 'xai' },
  ] });
});

test('an empty provider catalog is returned as an empty model list', async t => {
  const request = await withServer(t, () => { throw Error('must not infer'); }, undefined, { catalog: () => Response.json({ data: [] }) });
  const response = await request(undefined, {}, '/v1/models', { method: 'GET' });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { object: 'list', data: [] });
});

test('catalog failures, redirects and size limits are redacted without following another URL', async t => {
  const cases = [
    { response: new Response('{not-json'), status: 502, code: 'upstream_failed' },
    { response: Response.json({ data: {} }), status: 502, code: 'upstream_failed' },
    { response: Response.json({ data: Array.from({ length: 257 }, (_, index) => ({ model: `grok-${index}` })) }), status: 502, code: 'upstream_failed' },
    { response: new Response('x'.repeat(256 * 1024 + 1)), status: 502, code: 'upstream_failed' },
    { response: new Response('provider-auth-secret', { status: 401 }), status: 401, code: 'login_required' },
    { response: new Response('provider-forbidden-secret', { status: 403 }), status: 401, code: 'login_required' },
    { response: new Response('provider-quota-secret', { status: 429 }), status: 429, code: 'provider_quota' },
    { response: new Response('redirect-secret', { status: 302, headers: { location: 'https://untrusted.example/models' } }), status: 502, code: 'provider_error' },
  ];
  let calls = 0;
  const request = await withServer(t, () => { throw Error('must not infer'); }, undefined, { catalog: (url, options) => {
    assert.equal(url, modelsUrl);
    assert.equal(options.redirect, 'error');
    return cases[calls++].response;
  } });
  for (const expected of cases) {
    const response = await request(undefined, {}, '/v1/models', { method: 'GET' });
    assert.equal(response.status, expected.status);
    assert.deepEqual(await response.json(), { error: { code: expected.code } });
  }
  assert.equal(calls, cases.length);
});

test('a newly discovered model is routed unchanged to the fixed chat endpoint', async t => {
  let inference = 0;
  const body = { ...initial, model: 'grok-new_2026' };
  const request = await withServer(t, async (url, options) => {
    inference++;
    assert.equal(url, 'https://cli-chat-proxy.grok.com/v1/chat/completions');
    assert.equal(options.redirect, 'error');
    assert.equal(options.headers['x-grok-model-override'], body.model);
    assert.deepEqual(JSON.parse(options.body), body);
    return Response.json({ choices: [{ index: 0, message: { role: 'assistant', content: 'new model response' }, finish_reason: 'stop' }] });
  }, undefined, { catalog: () => Response.json({ data: [{ id: 'different-catalog-id', model: body.model, api_backend: 'responses', baseUrl: 'https://untrusted.example/v1' }] }) });
  const response = await request(body);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).choices[0].message.content, 'new model response');
  assert.equal(inference, 1);
});

test('legacy grok-build routing remains available without catalog discovery', async t => {
  let inference = 0;
  const request = await withServer(t, async url => {
    inference++;
    assert.equal(url, 'https://cli-chat-proxy.grok.com/v1/chat/completions');
    return Response.json({ choices: [{ index: 0, message: { role: 'assistant', content: 'legacy response' }, finish_reason: 'stop' }] });
  }, undefined, { catalog: () => { throw Error('legacy route must not fetch catalog'); } });
  const response = await request(initial);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).choices[0].message.content, 'legacy response');
  assert.equal(inference, 1);
});

test('upstream 401 and 429 are redacted with no retry or key fallback', async t => {
  let calls = 0;
  const request = await withServer(t, async () => { calls++; return new Response('secret-value', { status: calls === 1 ? 401 : 429 }); });
  const unauthorized = await request(initial);
  assert.equal(unauthorized.status, 401);
  assert.deepEqual(await unauthorized.json(), { error: { code: 'login_required' } });
  const quota = await request(initial);
  assert.equal(quota.status, 429);
  assert.deepEqual(await quota.json(), { error: { code: 'provider_quota' } });
  assert.equal(calls, 2);
});

test('streaming HTTP tool call preserves high reasoning effort, finish reason and token privacy', async t => {
  const source = event({ tool_calls: [{ index: 0, ...call }] }) + event({}, 'tool_calls') + 'data: [DONE]\n\n';
  const body = { ...initial, model: 'grok-4.6', reasoning_effort: 'high', stream: true, stream_options: { include_usage: true } };
  const request = await withServer(t, async (url, options) => {
    assert.equal(url, 'https://cli-chat-proxy.grok.com/v1/chat/completions');
    assert.equal(options.headers['x-grok-model-override'], 'grok-4.6');
    assert.deepEqual(JSON.parse(options.body), body);
    return new Response(source, { headers: { 'content-type': 'text/event-stream' } });
  });
  const response = await request(body);
  assert.equal(response.status, 200); assert.equal(await response.text(), source);
});

test('safe but undiscovered model is rejected without inference', async t => {
  let accesses = 0;
  let inference = 0;
  const request = await withServer(t, () => { inference++; throw Error('must not infer'); }, { withToken: fn => { accesses++; return fn('synthetic-provider-secret'); } });
  const response = await request({ ...initial, model: 'grok-4.7' });
  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { error: { code: 'unknown_model' } });
  assert.equal(accesses, 1);
  assert.equal(inference, 0);
});

test('malformed model names are rejected before session access', async t => {
  let accesses = 0;
  const request = await withServer(t, () => { throw Error('must not fetch'); }, { withToken: () => { accesses++; throw Error('must not access session'); } });
  for (const model of [null, '', ' grok-4.6', 'grok/4.6', 'grok:4.6', '../grok', 'x'.repeat(129), 46, {}, []]) {
    const response = await request({ ...initial, model });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: { code: 'invalid_request' } });
  }
  assert.equal(accesses, 0);
});

test('invalid reasoning efforts are rejected before session access', async t => {
  let accesses = 0;
  const request = await withServer(t, () => { throw Error('must not fetch'); }, { withToken: () => { accesses++; throw Error('must not access session'); } });
  for (const reasoning_effort of [null, '', 'HIGH', 'none', 1, {}, []]) {
    const response = await request({ ...initial, reasoning_effort });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: { code: 'invalid_request' } });
  }
  assert.equal(accesses, 0);
});


test('invalid message content is rejected before token access', async t => {
  let accesses = 0;
  const request = await withServer(t, () => { throw Error('must not fetch'); }, { withToken: () => { accesses++; } });
  for (const content of [undefined, null, 7, {}, [], [{ type: 'text' }]]) {
    assert.equal((await request({ ...initial, messages: [{ role: 'user', content }] })).status, 400);
  }
  assert.equal(accesses, 0);
});

test('credential inputs, unsupported features and malformed options are rejected before session access', async t => {
  let accesses = 0;
  const request = await withServer(t, () => { throw Error('must not fetch'); }, { withToken: () => { accesses++; } });
  const invalid = [
    ...['api_key', 'apiKey', 'access_token', 'refresh_token', 'authorization', 'headers', 'provider', 'base_url'].map(key => ({ [key]: 'synthetic-secret' })),
    { response_format: { type: 'json_object' } }, { modalities: ['audio'] },
    { temperature: '1' }, { top_p: 2 }, { max_tokens: -1 }, { max_completion_tokens: 1.5 },
    { max_tokens: 1, max_completion_tokens: 1 }, { seed: '1' }, { n: 2 },
    { parallel_tool_calls: 'true' }, { stream_options: { include_usage: true } },
    { stream: true, stream_options: { include_usage: true, api_key: 'synthetic-secret' } },
    { stop: [1] }, { tool_choice: { type: 'function', function: { name: 'not-offered' } } },
    { messages: [{ role: 'user', content: 'Hello', access_token: 'synthetic-secret' }] },
    { messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello', authorization: 'synthetic-secret' }] }] },
    { tools: [{ type: 'function', function: { name: 'nonce', api_key: 'synthetic-secret' } }] },
    { tools: [{ type: 'function', function: {} }] },
    { tools: [{ type: 'function', function: { name: 1 } }] },
    { messages: [{ role: 'user', content: [null] }] },
  ];
  for (const extra of invalid) {
    const response = await request({ ...initial, ...extra });
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: { code: 'invalid_request' } });
  }
  assert.equal(accesses, 0);
});

test('supported client options and tool JSON schemas are preserved in a sanitized request', () => {
  const body = { ...initial, stream: true, stream_options: { include_usage: true },
    tool_choice: { type: 'function', function: { name: 'nonce' } }, parallel_tool_calls: false,
    temperature: 0.5, top_p: 0.9, max_tokens: 1024, frequency_penalty: 0,
    presence_penalty: 0, stop: ['END'], seed: 7, n: 1 };
  const validated = validateChatRequest(body);
  assert.notEqual(validated, body);
  assert.deepEqual(validated, body);
});


test('client cancellation aborts the provider and releases the single-turn slot', { timeout: 5000 }, async t => {
  let started;
  const providerStarted = new Promise(resolve => { started = resolve; });
  let aborted;
  const providerAborted = new Promise(resolve => { aborted = resolve; });
  let attempts = 0;
  const request = await withServer(t, async (url, options) => {
    attempts++;
    if (attempts === 2) return Response.json({ choices: [{ index: 0, message: { role: 'assistant', content: 'next request works' }, finish_reason: 'stop' }] });
    return new Promise((resolve, reject) => {
      options.signal.addEventListener('abort', () => { aborted(); reject(options.signal.reason); }, { once: true });
      started();
    });
  });
  const controller = new AbortController();
  const first = request(initial, {}, '/v1/chat/completions', { signal: controller.signal });
  const firstRejected = assert.rejects(first, error => error.name === 'AbortError');
  await providerStarted;
  controller.abort();
  await firstRejected;
  await providerAborted;
  await new Promise(resolve => setImmediate(resolve));
  const second = await request(initial);
  assert.equal(second.status, 200);
  assert.equal((await second.json()).choices[0].message.content, 'next request works');
});

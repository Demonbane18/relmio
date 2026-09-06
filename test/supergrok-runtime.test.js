import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import test from 'node:test';

import {
  createSuperGrokRuntimeHandler,
  hashSuperGrokCredential,
  loadSuperGrokRuntimeConfig,
  openFreshSuperGrokSession,
  startSuperGrokRuntime,
} from '../src/supergrok/runtime.js';

const credential = 'test-local-credential-0000000000000000000';
const verifier = hashSuperGrokCredential(credential);
const installId = 'a'.repeat(32);
const gatewayVersion = '9.8.7-test.1+build.5';
const publicPort = 14502;
const host = `127.0.0.1:${publicPort}`;

class Response extends EventEmitter {
  constructor() {
    super();
    this.body = '';
    this.destroyed = false;
    this.headers = {};
    this.headersSent = false;
    this.statusCode = 200;
    this.writableEnded = false;
  }

  writeHead(status, headers = {}) { this.statusCode = status; this.headers = headers; this.headersSent = true; return this; }
  write(chunk) { if (!this.destroyed && !this.writableEnded) this.body += String(chunk); return !this.destroyed; }
  end(chunk) { if (chunk !== undefined) this.write(chunk); this.writableEnded = true; this.emit('finish'); }
}

function request({ method = 'GET', url, headers = {}, body } = {}) {
  const source = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
  source.method = method;
  source.url = url;
  source.complete = true;
  source.headers = Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
  source.rawHeaders = Object.entries(headers).flatMap(([name, value]) => [name, value]);
  return source;
}

async function invoke(options, input) {
  const handler = createSuperGrokRuntimeHandler({
    session: { withToken: callback => callback('synthetic-provider-token') },
    tokenVerifier: verifier,
    publicPort,
    gatewayVersion,
    ...options,
  });
  const response = new Response();
  await handler(request(input), response);
  return response;
}

test('runtime config requires the compose listener, public port, verifier and installation identity', () => {
  const environment = {
    RELMIO_GATEWAY_HOST: '0.0.0.0',
    RELMIO_GATEWAY_PORT: '14502',
    RELMIO_GATEWAY_PUBLIC_PORT: '19002',
    RELMIO_GATEWAY_TOKEN_SHA256: createHash('sha256').update(credential).digest('hex'),
    RELMIO_GATEWAY_VERSION: '0.13.0',
    RELMIO_GATEWAY_INSTALL_ID: installId,
  };
  assert.deepEqual(loadSuperGrokRuntimeConfig(environment), { host: '0.0.0.0', port: 14502, publicPort: 19002, tokenVerifier: verifier, gatewayVersion: '0.13.0', installId });
  for (const key of ['RELMIO_GATEWAY_PUBLIC_PORT', 'RELMIO_GATEWAY_INSTALL_ID']) {
    const invalid = { ...environment }; delete invalid[key];
    assert.throws(() => loadSuperGrokRuntimeConfig(invalid), /SuperGrok runtime/i);
  }
});

test('fresh session opens a newly empty home once and otherwise only reopens its matching marker', async () => {
  const calls = [];
  const matching = { withToken: async callback => callback('token') };
  const session = await openFreshSuperGrokSession({ installId, createSession: async options => {
    calls.push(options);
    if (options.initialize) throw new Error('fresh_session_required');
    return matching;
  } });
  assert.equal(session, matching);
  assert.deepEqual(calls, [
    { directory: '/home/node/.grok', instanceId: installId, initialize: true },
    { directory: '/home/node/.grok', instanceId: installId, initialize: false },
  ]);
  await assert.rejects(openFreshSuperGrokSession({ installId, createSession: async () => { throw new Error('secret'); } }), error => error.code === 'fresh_session_required' && !error.message.includes('secret'));
});

test('runtime startup accepts injected session and server boundaries before it listens', async () => {
  const server = new EventEmitter();
  server.listen = (options, callback) => { server.options = options; callback(); };
  server.address = () => ({ family: 'IPv4', port: 14502 });
  server.close = callback => callback();
  let created;
  const runtime = await startSuperGrokRuntime({
    host: '0.0.0.0', port: 14502, publicPort, tokenVerifier: verifier, gatewayVersion, installId,
    session: { withToken: callback => callback('synthetic-provider-token') },
    serverFactory: (options, handler) => { created = { options, handler }; return server; },
  });
  assert.deepEqual(server.options, { host: '0.0.0.0', port: 14502 });
  assert.equal(created.options.maxHeaderSize, 16 * 1024);
  assert.equal(typeof created.handler, 'function');
  assert.equal(runtime.origin, 'http://127.0.0.1:14502');
  await runtime.close();
});

test('health is unauthenticated but only accepts the exact loopback health hosts and does not probe the session', async t => {
  let accesses = 0;
  const options = { session: { withToken: () => { accesses++; } } };
  const health = await invoke(options, { url: '/health', headers: { host } });
  assert.equal(health.statusCode, 200);
  assert.deepEqual(JSON.parse(health.body), { status: 'ok' });
  assert.equal(accesses, 0);
  assert.equal((await invoke(options, { url: '/health', headers: { host: 'grok-build:14502' } })).statusCode, 403);
  assert.equal((await invoke(options, { url: '/health', headers: { host, origin: 'https://example.test' } })).statusCode, 403);
});

test('auth verification and direct model routes use the local bearer and the private service hostname', async t => {
  const seen = [];
  const options = { chatHandler: async (request, response) => {
    seen.push({ method: request.method, url: request.url, host: request.headers.host });
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ object: 'list', data: [] }));
  } };
  assert.equal((await invoke(options, { url: '/auth/verify', headers: { host, authorization: `Bearer ${credential}` } })).statusCode, 200);
  assert.equal((await invoke(options, { url: '/auth/verify', headers: { host, authorization: 'Bearer wrong' } })).statusCode, 401);
  assert.equal((await invoke(options, { url: '/v1/models', headers: { host: 'grok-build:14502', authorization: `Bearer ${credential}` } })).statusCode, 200);
  assert.deepEqual(seen, [{ method: 'GET', url: '/v1/models', host: 'grok-build:14502' }]);
});

test('legacy chat adapts a direct Chat Completions stream without another network request or token disclosure', async t => {
  const options = { chatHandler: async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    assert.deepEqual(body, { model: 'grok-build', messages: [{ role: 'user', content: 'Hello' }], stream: true });
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'Hi ' }, finish_reason: null }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'there' }, finish_reason: 'stop' }] })}\n\n`);
    response.end('data: [DONE]\n\n');
  } };
  const response = await invoke(options, { method: 'POST', url: '/chat', headers: { host, authorization: `Bearer ${credential}`, accept: 'text/event-stream', 'content-type': 'application/json' }, body: { input: 'Hello' } });
  const text = response.body;
  assert.equal(response.statusCode, 200);
  assert.match(text, /event: start\ndata: \{"requestId":"[0-9a-f-]{36}"\}/u);
  assert.match(text, /event: delta\ndata: \{"text":"Hi "\}/u);
  assert.match(text, /event: delta\ndata: \{"text":"there"\}/u);
  assert.match(text, /event: terminal\ndata: \{"outcome":"completed"\}/u);
  assert.ok(!text.includes('synthetic-provider-token'));
});

test('legacy chat bounds and times out its request body before opening a provider turn', async () => {
  let providerCalls = 0;
  const options = { chatHandler: async () => { providerCalls++; }, legacyBodyTimeoutMs: 5 };
  const oversized = await invoke(options, { method: 'POST', url: '/chat', headers: { host, authorization: `Bearer ${credential}`, accept: 'text/event-stream', 'content-type': 'application/json' }, body: { input: 'a'.repeat(16 * 1024) } });
  assert.equal(oversized.statusCode, 413);
  assert.deepEqual(JSON.parse(oversized.body), { error: { code: 'body_too_large' } });

  const hanging = new Readable({ read() {} });
  hanging.method = 'POST'; hanging.url = '/chat'; hanging.complete = false;
  hanging.headers = { host, authorization: `Bearer ${credential}`, accept: 'text/event-stream', 'content-type': 'application/json' };
  hanging.rawHeaders = Object.entries(hanging.headers).flatMap(([name, value]) => [name, value]);
  const response = new Response();
  const handler = createSuperGrokRuntimeHandler({
    session: { withToken: callback => callback('synthetic-provider-token') },
    tokenVerifier: verifier, publicPort, gatewayVersion, ...options,
  });
  const socketHandle = setTimeout(() => {}, 1_000);
  try { await handler(hanging, response); } finally { clearTimeout(socketHandle); }
  assert.equal(response.statusCode, 408);
  assert.deepEqual(JSON.parse(response.body), { error: { code: 'request_timeout' } });
  assert.equal(providerCalls, 0);
});

test('legacy chat propagates downstream backpressure into the direct stream', async () => {
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  let wroteSecond = false;
  const chatHandler = async (_request, response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const first = `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'first' }, finish_reason: null }] })}\n\n`;
    assert.equal(response.write(first), false);
    release();
    await new Promise(resolve => response.once('drain', resolve));
    wroteSecond = true;
    response.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: 'second' }, finish_reason: 'stop' }] })}\n\n`);
    response.end('data: [DONE]\n\n');
  };
  class BackpressuredResponse extends Response {
    write(chunk) {
      const writable = super.write(chunk);
      if (!this.blocked && String(chunk).startsWith('event: delta')) {
        this.blocked = true;
        return false;
      }
      return writable;
    }
  }
  const handler = createSuperGrokRuntimeHandler({
    session: { withToken: callback => callback('synthetic-provider-token') },
    tokenVerifier: verifier, publicPort, gatewayVersion, chatHandler,
  });
  const response = new BackpressuredResponse();
  const pending = handler(request({ method: 'POST', url: '/chat', headers: { host, authorization: `Bearer ${credential}`, accept: 'text/event-stream', 'content-type': 'application/json' }, body: { input: 'Hello' } }), response);
  await blocked;
  assert.equal(wroteSecond, false);
  response.emit('drain');
  await pending;
  assert.equal(wroteSecond, true);
  assert.match(response.body, /event: delta\ndata: \{"text":"second"\}/u);
});

test('private companion accepts only its fixed Docker hostname when explicitly enabled', async () => {
  const input = { url: '/v1/models', headers: { host: 'n8n-supergrok:14502', authorization: `Bearer ${credential}` } };
  let requests = 0;
  const options = { fetchImpl: async (url, requestOptions) => {
    requests++;
    assert.equal(url, 'https://cli-chat-proxy.grok.com/v1/models');
    assert.equal(requestOptions.method, 'GET');
    assert.equal(requestOptions.headers['user-agent'], `relmio/${gatewayVersion} grok/1.0.13`);
    return globalThis.Response.json({ data: [{ id: 'grok-4.6' }] });
  } };
  assert.equal((await invoke(options, input)).statusCode, 403);
  assert.equal(requests, 0);
  const accepted = await invoke({ ...options, privateHost: 'n8n-supergrok:14502' }, input);
  assert.equal(accepted.statusCode, 200);
  assert.deepEqual(JSON.parse(accepted.body).data.map(model => model.id), ['grok-4.6']);
  assert.equal((await invoke({ ...options, privateHost: 'n8n-supergrok:14502' }, { ...input, headers: { ...input.headers, origin: 'https://example.test' } })).statusCode, 403);
  assert.equal(requests, 1);
  assert.throws(() => createSuperGrokRuntimeHandler({ session: { withToken() {} }, tokenVerifier: verifier, publicPort, gatewayVersion, privateHost: 'attacker.test' }), /configuration/u);
});

test('runtime factories require a valid gateway version', async () => {
  const base = { session: { withToken() {} }, tokenVerifier: verifier, publicPort };
  for (const invalid of [undefined, '', '01.2.3', '1.2', '1.2.3/evil', 123]) {
    assert.throws(() => createSuperGrokRuntimeHandler({ ...base, gatewayVersion: invalid }), /configuration/u);
  }
  await assert.rejects(startSuperGrokRuntime({
    host: '127.0.0.1', port: 0, publicPort, tokenVerifier: verifier, installId,
    session: base.session,
  }), /configuration/u);
});

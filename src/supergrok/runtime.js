import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { pathToFileURL } from 'node:url';

import { createGrokSessionChatHandler } from './chat.js';
import { createFreshGrokSession } from './session.js';

const MAX_LEGACY_BODY = 16 * 1024;
const MAX_LEGACY_INPUT = 12 * 1024;
const LEGACY_BODY_TIMEOUT_MS = 120_000;
const VERSION_PATTERN = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/u;
const SESSION_DIRECTORY = '/home/node/.grok';
const SERVICE_PORT = 14502;
const SERVICE_HOST = `grok-build:${SERVICE_PORT}`;
const PRIVATE_HOST = `n8n-supergrok:${SERVICE_PORT}`;
const INTERNAL_HEALTH_HOST = `127.0.0.1:${SERVICE_PORT}`;
const KEEPALIVE_INTERVAL_MS = 15_000;

const plainObject = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const error = code => Object.assign(new Error(code), { code });

function headerCount(request, name) {
  let count = 0;
  for (let index = 0; index < request.rawHeaders.length; index += 2) if (request.rawHeaders[index].toLowerCase() === name) count += 1;
  return count;
}

function json(response, status, body) {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(text),
    'content-type': 'application/json; charset=utf-8',
    'x-content-type-options': 'nosniff',
  });
  response.end(text);
}

function validBearer(request, verifier) {
  if (headerCount(request, 'authorization') !== 1) return false;
  const authorization = request.headers.authorization;
  const match = typeof authorization === 'string' ? /^Bearer ([A-Za-z0-9_-]{32,256})$/u.exec(authorization) : null;
  return Boolean(match) && timingSafeEqual(hashSuperGrokCredential(match[1]), verifier);
}

function acceptsSse(request) {
  return headerCount(request, 'accept') === 1 && typeof request.headers.accept === 'string' && request.headers.accept.split(',').some(value => value.trim().split(';', 1)[0] === 'text/event-stream');
}

function publicHost(port) {
  return `127.0.0.1:${port}`;
}

function hasExpectedHost(request, allowedHosts) {
  return headerCount(request, 'host') === 1 && typeof request.headers.host === 'string' && allowedHosts.has(request.headers.host);
}

function noOrigin(request) {
  return headerCount(request, 'origin') === 0;
}

async function readLegacyInput(request, timeoutMs) {
  const chunks = [];
  let size = 0;
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    request.destroy();
  }, timeoutMs);
  timeout.unref?.();
  try {
    for await (const chunk of request) {
      size += chunk.length;
      if (size > MAX_LEGACY_BODY) throw error('body_too_large');
      chunks.push(Buffer.from(chunk));
    }
  } catch (caught) {
    if (timedOut) throw error('request_timeout');
    if (caught?.code === 'body_too_large') throw caught;
    throw error('invalid_request');
  } finally {
    clearTimeout(timeout);
  }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw error('invalid_json'); }
  if (!plainObject(body) || Object.keys(body).length !== 1 || typeof body.input !== 'string' || body.input.trim() === '' || body.input.includes('\0') || Buffer.byteLength(body.input, 'utf8') > MAX_LEGACY_INPUT) throw error('invalid_request');
  return body.input;
}

function createLegacyEventStream(response, keepaliveIntervalMs) {
  let ended = false;
  const write = (event, data) => {
    if (ended || response.destroyed || response.writableEnded) return false;
    return response.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  };
  response.writeHead(200, {
    'cache-control': 'no-store',
    connection: 'keep-alive',
    'content-encoding': 'none',
    'content-type': 'text/event-stream; charset=utf-8',
    'x-accel-buffering': 'no',
    'x-content-type-options': 'nosniff',
    'x-relmio-stream': 'v1',
  });
  const keepalive = setInterval(() => {
    if (!ended && !response.destroyed && !response.writableEnded) response.write(': keepalive\n\n');
  }, keepaliveIntervalMs);
  keepalive.unref?.();
  write('start', { requestId: randomUUID() });
  return {
    delta(text) { return typeof text !== 'string' || text.length === 0 || write('delta', { text }); },
    complete() {
      if (ended) return;
      write('terminal', { outcome: 'completed' });
      ended = true; clearInterval(keepalive); response.end();
    },
    fail() {
      if (ended) return;
      write('error', { code: 'upstream_failed', retryable: true });
      write('terminal', { outcome: 'failed' });
      ended = true; clearInterval(keepalive); response.end();
    },
    onDrain(listener) { response.on('drain', listener); },
    offDrain(listener) { response.off('drain', listener); },
    dispose() { ended = true; clearInterval(keepalive); },
  };
}

class CapturedResponse extends EventEmitter {
  constructor(onChunk) {
    super();
    this.onChunk = onChunk;
    this.destroyed = false;
    this.headersSent = false;
    this.writableEnded = false;
    this.statusCode = 200;
  }

  writeHead(status) {
    this.statusCode = status;
    this.headersSent = true;
    return this;
  }

  write(chunk) {
    if (this.destroyed || this.writableEnded) return false;
    return this.onChunk(Buffer.from(chunk).toString('utf8')) !== false;
  }

  end(chunk) {
    if (chunk !== undefined) this.write(chunk);
    this.writableEnded = true;
    this.emit('finish');
  }
}

function directRequest(request, body) {
  const stream = Readable.from([Buffer.from(JSON.stringify(body))]);
  stream.method = 'POST';
  stream.url = '/v1/chat/completions';
  stream.complete = true;
  stream.headers = {
    authorization: request.headers.authorization,
    'content-type': 'application/json',
    host: request.headers.host,
  };
  stream.rawHeaders = ['authorization', request.headers.authorization, 'content-type', 'application/json', 'host', request.headers.host];
  return stream;
}

function createChatCompletionBridge(chatHandler, request, input, events) {
  let buffer = '';
  let sawDone = false;
  let sawTerminal = false;
  let invalid = false;
  const consume = frame => {
    const data = frame.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).replace(/^ /u, '')).join('\n');
    if (!data || invalid) return true;
    if (data === '[DONE]') {
      if (sawDone || !sawTerminal) invalid = true;
      sawDone = true;
      return true;
    }
    let chunk;
    try { chunk = JSON.parse(data); } catch { invalid = true; return true; }
    if (!plainObject(chunk) || chunk.error || !Array.isArray(chunk.choices)) { invalid = true; return true; }
    let writable = true;
    for (const choice of chunk.choices) {
      const content = choice?.delta?.content;
      if (typeof content === 'string') writable = events.delta(content) && writable;
      if (typeof choice?.finish_reason === 'string' && choice.finish_reason.length > 0) sawTerminal = true;
    }
    return writable;
  };
  const capture = new CapturedResponse(chunk => {
    let writable = true;
    buffer += chunk.replace(/\r\n/gu, '\n');
    let boundary;
    while ((boundary = buffer.indexOf('\n\n')) >= 0) {
      writable = consume(buffer.slice(0, boundary)) && writable;
      buffer = buffer.slice(boundary + 2);
    }
    if (Buffer.byteLength(buffer, 'utf8') > MAX_LEGACY_BODY) invalid = true;
    return writable;
  });
  const drain = () => capture.emit('drain');
  events.onDrain(drain);
  const bridgedRequest = directRequest(request, {
    model: 'grok-build',
    messages: [{ role: 'user', content: input }],
    stream: true,
  });
  return {
    async run() {
      try {
        await chatHandler(bridgedRequest, capture);
        if (buffer.trim()) invalid = true;
        return capture.statusCode === 200 && sawDone && sawTerminal && !invalid;
      } finally {
        events.offDrain(drain);
      }
    },
    cancel() {
      capture.destroyed = true;
      capture.emit('close');
      bridgedRequest.destroy();
    },
  };
}

async function handleLegacyChat(request, response, { verifier, directHosts, chatHandler, keepaliveIntervalMs, bodyTimeoutMs }) {
  if (!hasExpectedHost(request, directHosts)) return json(response, 400, { error: { code: 'host_rejected' } });
  if (!noOrigin(request)) return json(response, 403, { error: { code: 'origin_rejected' } });
  if (!validBearer(request, verifier)) return json(response, 401, { error: { code: 'unauthorized' } });
  if (!acceptsSse(request) || headerCount(request, 'content-type') !== 1 || !/^application\/json(?:\s*;\s*charset=utf-8)?$/iu.test(request.headers['content-type'])) return json(response, 406, { error: { code: 'stream_required' } });
  let input;
  try { input = await readLegacyInput(request, bodyTimeoutMs); } catch (caught) {
    const status = caught.code === 'body_too_large' ? 413 : caught.code === 'request_timeout' ? 408 : 400;
    return json(response, status, { error: { code: caught.code ?? 'invalid_request' } });
  }
  const events = createLegacyEventStream(response, keepaliveIntervalMs);
  const bridge = createChatCompletionBridge(chatHandler, request, input, events);
  const close = () => { if (!response.writableEnded) bridge.cancel(); };
  response.once('close', close);
  try {
    if (await bridge.run()) events.complete();
    else events.fail();
  } catch {
    events.fail();
  } finally {
    response.off('close', close);
    events.dispose();
  }
}

export function hashSuperGrokCredential(value) {
  if (typeof value !== 'string' || value.length === 0) throw new TypeError('SuperGrok credential is invalid.');
  return createHash('sha256').update(value, 'utf8').digest();
}

export function loadSuperGrokRuntimeConfig(environment = process.env) {
  const port = Number(environment.RELMIO_GATEWAY_PORT);
  const publicPort = Number(environment.RELMIO_GATEWAY_PUBLIC_PORT);
  const tokenHash = environment.RELMIO_GATEWAY_TOKEN_SHA256;
  const gatewayVersion = environment.RELMIO_GATEWAY_VERSION;
  const installId = environment.RELMIO_GATEWAY_INSTALL_ID;
  const privateHost = environment.RELMIO_GATEWAY_PRIVATE_HOST;
  if (privateHost !== undefined && privateHost !== PRIVATE_HOST) throw new TypeError('SuperGrok runtime configuration is invalid.');
  if (environment.RELMIO_GATEWAY_HOST !== '0.0.0.0' || port !== SERVICE_PORT || !Number.isInteger(publicPort) || publicPort < 1 || publicPort > 65_535 || !/^[a-f0-9]{64}$/u.test(tokenHash ?? '') || typeof gatewayVersion !== 'string' || !VERSION_PATTERN.test(gatewayVersion) || !/^[a-f0-9]{32}$/u.test(installId ?? '')) throw new TypeError('SuperGrok runtime configuration is invalid.');
  return { host: '0.0.0.0', port, publicPort, tokenVerifier: Buffer.from(tokenHash, 'hex'), gatewayVersion, installId, ...(privateHost === undefined ? {} : { privateHost }) };
}

export async function openFreshSuperGrokSession({ directory = SESSION_DIRECTORY, installId, createSession = createFreshGrokSession } = {}) {
  if (typeof createSession !== 'function' || !/^[a-f0-9]{32}$/u.test(installId ?? '')) throw new TypeError('SuperGrok runtime configuration is invalid.');
  try {
    return await createSession({ directory, instanceId: installId, initialize: true });
  } catch {
    try { return await createSession({ directory, instanceId: installId, initialize: false }); }
    catch { throw error('fresh_session_required'); }
  }
}

export function createSuperGrokRuntimeHandler({ session, tokenVerifier, publicPort, privateHost, gatewayVersion, chatHandler, fetchImpl, keepaliveIntervalMs = KEEPALIVE_INTERVAL_MS, legacyBodyTimeoutMs = LEGACY_BODY_TIMEOUT_MS } = {}) {
  if (!session || typeof session.withToken !== 'function' || !Buffer.isBuffer(tokenVerifier) || tokenVerifier.length !== 32 || !Number.isInteger(publicPort) || publicPort < 1 || publicPort > 65_535 || typeof gatewayVersion !== 'string' || !VERSION_PATTERN.test(gatewayVersion) || !Number.isInteger(keepaliveIntervalMs) || keepaliveIntervalMs < 1 || !Number.isInteger(legacyBodyTimeoutMs) || legacyBodyTimeoutMs < 1) throw new TypeError('SuperGrok runtime configuration is invalid.');
  if (privateHost !== undefined && privateHost !== PRIVATE_HOST) throw new TypeError('SuperGrok runtime configuration is invalid.');
  const loopbackHost = publicHost(publicPort);
  const directHosts = new Set([loopbackHost, SERVICE_HOST]);
  if (privateHost) directHosts.add(privateHost);
  const healthHosts = new Set([loopbackHost, INTERNAL_HEALTH_HOST]);
  const direct = chatHandler ?? createGrokSessionChatHandler({ session, tokenVerifier, allowedHosts: [...directHosts], gatewayVersion, fetchImpl });
  if (typeof direct !== 'function') throw new TypeError('SuperGrok runtime configuration is invalid.');
  return async (request, response) => {
    if (request.method === 'GET' && request.url === '/health') {
      if (!hasExpectedHost(request, healthHosts) || !noOrigin(request)) return json(response, 403, { error: { code: 'forbidden' } });
      return json(response, 200, { status: 'ok' });
    }
    if (request.method === 'GET' && request.url === '/auth/verify') {
      if (!hasExpectedHost(request, directHosts) || !noOrigin(request)) return json(response, 403, { error: { code: 'forbidden' } });
      const authorized = validBearer(request, tokenVerifier);
      return json(response, authorized ? 200 : 401, authorized ? { status: 'ok' } : { error: { code: 'unauthorized' } });
    }
    if (request.method === 'POST' && request.url === '/chat') return handleLegacyChat(request, response, { verifier: tokenVerifier, directHosts, chatHandler: direct, keepaliveIntervalMs, bodyTimeoutMs: legacyBodyTimeoutMs });
    return direct(request, response);
  };
}

export async function startSuperGrokRuntime({ host, port, publicPort, privateHost, tokenVerifier, gatewayVersion, installId, session, createSession = createFreshGrokSession, chatHandler, fetchImpl, serverFactory = createServer, keepaliveIntervalMs = KEEPALIVE_INTERVAL_MS } = {}) {
  if (!['0.0.0.0', '127.0.0.1'].includes(host) || !Number.isInteger(port) || port < 0 || port > 65_535 || !Number.isInteger(publicPort) || publicPort < 1 || publicPort > 65_535 || !Buffer.isBuffer(tokenVerifier) || tokenVerifier.length !== 32 || typeof gatewayVersion !== 'string' || !VERSION_PATTERN.test(gatewayVersion) || !/^[a-f0-9]{32}$/u.test(installId ?? '') || typeof serverFactory !== 'function') throw new TypeError('SuperGrok runtime configuration is invalid.');
  if (privateHost !== undefined && privateHost !== PRIVATE_HOST) throw new TypeError('SuperGrok runtime configuration is invalid.');
  const activeSession = session ?? await openFreshSuperGrokSession({ installId, createSession });
  const handler = createSuperGrokRuntimeHandler({ session: activeSession, tokenVerifier, publicPort, privateHost, gatewayVersion, chatHandler, fetchImpl, keepaliveIntervalMs });
  const server = serverFactory({ maxHeaderSize: 16 * 1024 }, handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host, port }, () => { server.off('error', reject); resolve(); });
  });
  const address = server.address();
  return {
    origin: `http://${address.family === 'IPv6' ? '[::1]' : '127.0.0.1'}:${address.port}`,
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  startSuperGrokRuntime(loadSuperGrokRuntimeConfig()).catch(() => { process.exitCode = 1; });
}

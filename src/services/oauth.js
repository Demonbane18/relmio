import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createServer } from 'node:http';
import { openOpenAiAuthorization } from '../browser.js';
import {
  commitAuthorization, ensureSiwcHost, getSiwcDiscovery, listRegistrations,
  readPendingSiwcRegistration, readRegistration, readRegistrationView, readSiwcHost, readSiwcJson,
  reserveSiwcClient, signOut, validateSiwcClientId, validateSiwcRegistrationId, verifySiwcIdToken,
} from './siwc-session.mjs';

const RESOURCE = 'https://api.openai.com/v1';
const SCOPES = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
const CALLBACK = '/auth/callback';
const randomValue = () => randomBytes(32).toString('base64url');
const page = '<!doctype html><html lang="en"><meta charset="utf-8"><title>ChatGPT sign-in</title><body><p>Return to Relmio to continue.</p></body></html>';
const failure = () => new Error('ChatGPT sign-in could not be verified. Start a fresh sign-in.');
const cancelled = () => new Error('ChatGPT sign-in was cancelled.');
async function tokenExchangeFailure(response) {
  let body;
  try { body = await readSiwcJson(response); } catch { /* Never expose token endpoint bodies. */ }
  const source = body?.error;
  const code = typeof source === 'string' ? source : source?.code;
  const param = typeof source === 'object' ? source?.param : undefined;
  const safeCode = typeof code === 'string' && /^[A-Za-z0-9_:-]{1,128}$/u.test(code) ? code : undefined;
  const safeParam = typeof param === 'string' && /^[A-Za-z0-9_.\[\]-]{1,128}$/u.test(param) ? param : undefined;
  const requestId = response.headers?.get('x-request-id');
  return Object.assign(failure(), {
    safeOAuth: true, status: response.status,
    recovery: safeCode === 'invalid_client' ? 'fix-configuration'
      : safeCode === 'invalid_grant' ? 'reauthorize' : response.status >= 500 ? 'retry-later' : 'review-again',
    ...(safeCode ? { code: safeCode } : {}),
    ...(safeParam ? { param: safeParam } : {}),
    ...(requestId && /^[A-Za-z0-9_-]{1,128}$/u.test(requestId) ? { requestId } : {}),
  });
}

export async function listAuthRegistrations({ storageRoot } = {}, deps = {}) {
  return listRegistrations({ storageRoot }, deps);
}

export async function getAuthStatus({ storageRoot, registrationId, runtimeId = 'local' } = {}, deps = {}) {
  const empty = { exists: false, identity: 'unverified', session: 'signed-out',
    planPermission: 'not-granted', planEnabled: false, ownership: 'owned', needsPlanWelcome: false };
  if (!registrationId) return empty;
  validateSiwcRegistrationId(registrationId);
  const account = await readRegistrationView({ storageRoot, registrationId }, deps);
  if (!account) return { ...empty, registrationId };
  if (account.identity !== 'verified' || account.ownership !== 'owned' || account.session !== 'connected')
    return { ...account, exists: false };
  const host = await readSiwcHost({ storageRoot, runtimeId }, deps);
  return { ...account, exists: account.ownerHostId === host.hostId && account.ownerRuntimeId === runtimeId };
}

export async function startOAuthLogin({ storageRoot, registrationId, purpose = 'sign-in', runtimeId = 'local' } = {},
  { fetchImpl = fetch, createServerImpl = createServer, openAuthorization = openOpenAiAuthorization,
    now = Date.now, fileSystem, platform, lockDownPath, timeoutMs = 600000 } = {}) {
  if (!['sign-in', 'enable-plan'].includes(purpose) || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600000) throw new TypeError('Invalid SIWC sign-in request.');
  if (purpose === 'enable-plan' && !registrationId) throw new Error('Select a verified account before enabling plan use.');
  const deps = { fetchImpl, now, fileSystem, platform, lockDownPath };
  const original = registrationId ? await readRegistration({ storageRoot, registrationId }, deps) : null;
  let pendingRegistration = registrationId && !original
    ? await readPendingSiwcRegistration({ storageRoot, registrationId }, deps) : null;
  if (registrationId && !original && !pendingRegistration) throw new Error('Unknown SIWC registration.');
  if (purpose === 'enable-plan' && !original) throw new Error('Select a verified account before enabling plan use.');
  const host = original || pendingRegistration
    ? await readSiwcHost({ storageRoot, runtimeId }, deps)
    : await ensureSiwcHost({ storageRoot, runtimeId }, deps);
  if ((original || pendingRegistration) && ((original ?? pendingRegistration).owner.hostId !== host.hostId ||
      (original ?? pendingRegistration).owner.runtimeId !== runtimeId ||
      original && original.handoff.state !== 'owned')) throw new Error('SIWC account belongs to another runtime.');
  const metadata = await getSiwcDiscovery(deps);
  const attemptId = randomUUID(), pendingId = registrationId ?? randomUUID();
  const state = randomValue(), nonce = randomValue(), verifier = randomValue();
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  const abort = new AbortController();
  let server, timeout, redirectUri, deadline, resolveCompletion, rejectCompletion;
  let pending = true, accepting = true, inFlight, closePromise, cancelReason;
  const completion = new Promise((resolve, reject) => { resolveCompletion = resolve; rejectCompletion = reject; });
  completion.catch(() => {});
  const close = () => {
    if (closePromise) return closePromise;
    clearTimeout(timeout);
    closePromise = server?.listening ? new Promise(resolve => server.close(() => resolve())) : Promise.resolve();
    server?.closeIdleConnections?.();
    return closePromise;
  };
  const settle = (error, result) => {
    if (!pending) return;
    pending = false;
    accepting = false;
    clearTimeout(timeout);
    if (error) rejectCompletion(error);
    else resolveCompletion(result);
  };
  const cancel = async (reason = cancelled()) => {
    if (!pending) return;
    accepting = false;
    cancelReason = reason;
    abort.abort();
    if (inFlight) await inFlight;
    if (pending) settle(reason);
    await close();
  };
  const handler = async (request, response) => {
    if (request.method !== 'GET' || !request.url || request.url.length > 4096) {
      response.writeHead(404).end();
      return;
    }
    let url;
    try { url = new URL(request.url, 'http://127.0.0.1'); }
    catch { response.writeHead(400).end(); return; }
    if (url.pathname !== CALLBACK || url.hash || request.headers.host !== `127.0.0.1:${server.address()?.port}` ||
        !accepting) {
      response.writeHead(400, { 'cache-control': 'no-store' }).end(page);
      return;
    }
    const suppliedStates = url.searchParams.getAll('state');
    const suppliedState = Buffer.from(suppliedStates.length === 1 ? suppliedStates[0] : '');
    const expectedState = Buffer.from(state);
    if (suppliedState.length !== expectedState.length || !timingSafeEqual(suppliedState, expectedState)) {
      response.writeHead(400, { 'cache-control': 'no-store', 'content-type': 'text/html; charset=utf-8' }).end(page);
      return;
    }
    // State is consumed synchronously, before code exchange or any other await.
    accepting = false;
    inFlight = (async () => {
      try {
        const keys = [...url.searchParams.keys()];
        const code = url.searchParams.get('code');
        if (keys.some(key => !['state', 'code', 'client_id', 'scope', 'iss', 'error'].includes(key)) ||
            new Set(keys).size !== keys.length ||
            (url.searchParams.has('iss') && url.searchParams.get('iss') !== metadata.issuer) ||
            now() > deadline || abort.signal.aborted) throw failure();
        if (url.searchParams.has('error')) {
          if (url.searchParams.get('error') !== 'access_denied' || url.searchParams.has('code')) throw failure();
          throw Object.assign(new Error(purpose === 'enable-plan'
            ? 'ChatGPT plan use was declined.' : 'ChatGPT sign-in was declined.'), {
            safeOAuth: true, code: 'access_denied', recovery: purpose === 'enable-plan' ? 'enable-plan' : 'none',
          });
        }
        if (typeof code !== 'string' || !/^[!-~]{1,2048}$/u.test(code)) throw failure();
        const returnedClient = url.searchParams.get('client_id');
        const savedClient = original?.clientId ?? pendingRegistration?.clientId;
        if (!savedClient && !returnedClient || savedClient && returnedClient && returnedClient !== savedClient) throw failure();
        const clientId = validateSiwcClientId(savedClient ?? returnedClient);
        if (clientId === 'dynamic_agent_client') throw failure();
        if (!original && !pendingRegistration) pendingRegistration = await reserveSiwcClient({
          storageRoot, registrationId: pendingId, clientId, runtimeId,
        }, deps);
        if (abort.signal.aborted) throw failure();
        const tokenResponse = await fetchImpl(metadata.token_endpoint, {
          method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
          body: new URLSearchParams({ grant_type: 'authorization_code', code,
            redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier, resource: RESOURCE }),
          signal: AbortSignal.any([abort.signal, AbortSignal.timeout(10000)]),
        });
        if (!tokenResponse.ok) {
          const error = await tokenExchangeFailure(tokenResponse);
          error.registrationId = registrationId ?? pendingRegistration.registrationId;
          throw error;
        }
        const tokens = await readSiwcJson(tokenResponse);
        if (tokens?.client_id !== undefined && tokens.client_id !== clientId) throw failure();
        const payload = await verifySiwcIdToken(tokens?.id_token,
          { clientId, nonce, subject: original?.identity.subject, metadata }, deps);
        if (abort.signal.aborted) throw failure();
        const account = await commitAuthorization({ storageRoot,
          registrationId: original?.registrationId ?? pendingRegistration?.registrationId,
          expectedGeneration: original?.generation ?? pendingRegistration?.generation,
          clientId, identity: { issuer: payload.iss, subject: payload.sub,
            ...(payload.email ? { email: payload.email } : {}) }, tokens, runtimeId, signal: abort.signal }, deps);
        if (abort.signal.aborted) {
          // A commit already in the OS rename is linearized before cancellation.
          // Clear it under the registration lock before reporting cancellation.
          try { await signOut({ storageRoot, registrationId: account.registrationId }, { runtimeId }, deps); }
          catch {
            throw Object.assign(new Error('ChatGPT sign-in cleanup is uncertain. Restart Relmio before retrying.'), { retryBlocked: true });
          }
          throw cancelled();
        }
        settle(null, account);
        response.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
          'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' }).end(page);
      } catch (error) {
        settle(error?.retryBlocked || error?.safeOAuth ? error : abort.signal.aborted ? cancelReason ?? cancelled() : failure());
        if (!response.writableEnded) response.writeHead(400, { 'content-type': 'text/html; charset=utf-8',
          'cache-control': 'no-store', 'referrer-policy': 'no-referrer' }).end(page);
      } finally { await close(); }
    })();
    await inFlight;
  };
  server = createServerImpl((request, response) => { void handler(request, response).catch(() => {
    if (!response.writableEnded) response.writeHead(500, { 'cache-control': 'no-store' }).end();
  }); });
  try {
    await new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => { server.off('error', reject); resolve(); });
    });
    const address = server.address();
    if (!address || typeof address === 'string' || address.address !== '127.0.0.1') throw failure();
    redirectUri = `http://127.0.0.1:${address.port}${CALLBACK}`;
    deadline = now() + timeoutMs;
    const authorization = new URL(metadata.authorization_endpoint);
    const params = {
      client_id: original?.clientId ?? pendingRegistration?.clientId ?? 'dynamic_agent_client',
      response_type: 'code', redirect_uri: redirectUri,
      scope: SCOPES, resource: RESOURCE, state, nonce, code_challenge_method: 'S256', code_challenge: challenge,
      ext_agent_host_id: host.hostId,
      ...(!original && !pendingRegistration ? { agent_name_hint: 'Relmio' } : {}),
      ...(purpose === 'enable-plan' ? { prompt: 'consent' } : {}),
    };
    for (const [key, value] of Object.entries(params)) authorization.searchParams.set(key, value);
    timeout = setTimeout(() => { void cancel(new Error('ChatGPT sign-in expired. Start again.')); }, timeoutMs);
    if (!await openAuthorization(authorization.href)) throw failure();
    return Object.freeze({ launchMode: 'system-browser', attemptId, completion, cancel });
  } catch {
    accepting = false;
    abort.abort();
    settle(new Error('The ChatGPT sign-in browser could not start.'));
    await close();
    throw new Error('The ChatGPT sign-in browser could not start.');
  }
}

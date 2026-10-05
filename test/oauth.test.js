import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { getAuthStatus, listAuthRegistrations, startOAuthLogin } from '../src/services/oauth.js';
import {
  acceptAuthHandoff, ensureSiwcHost, finishAuthHandoff, prepareAuthHandoff,
  readAuthHandoff, readAuthHandoffReceipt, readPendingAuthHandoff, readRegistration,
  selectRegistration, setPlanEnabled,
} from '../src/services/siwc-session.mjs';

const issuer = 'https://auth.openai.com';
const clientId = 'oaiapp_realm_test';
const discovery = { issuer, authorization_endpoint: `${issuer}/api/accounts/authorize`,
  token_endpoint: `${issuer}/api/accounts/oauth/token`, jwks_uri: `${issuer}/.well-known/jwks.json` };
const tokenFixture = scope => ({ access_token: 'opaque-secret-access', refresh_token: 'opaque-secret-refresh',
  expires_in: 3600, token_type: 'Bearer', scope });

async function fixture(t, { grant = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct',
  changeNonce = false, changeSubject = false, wrongAudience = false,
  wrongIssuer = false, badSignature = false, futureIssuedAt = false, wrongTokenClient = false,
  expired = false, returnedClient = clientId, tokenDelay, tokenError,
  callbackParams = [], callbackError, beforeCallback } = {}) {
  const storageRoot = await fs.mkdtemp(join(tmpdir(), 'relmio-siwc-oauth-'));
  t.after(() => fs.rm(storageRoot, { recursive: true, force: true }));
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = { ...await exportJWK(publicKey), kid: 'test-key', alg: 'RS256', use: 'sig' };
  let authorization, callbackResult, callbackUrl, issuedSubject = 'verified-subject';
  let currentTokenError = tokenError, currentReturnedClient = returnedClient, exchanges = 0;
  let currentCallbackError = callbackError;
  const fetchImpl = async (url, options = {}) => {
    if (url === `${issuer}/.well-known/openid-configuration`) return Response.json(discovery);
    if (url === discovery.jwks_uri) return Response.json({ keys: [jwk] });
    if (url === discovery.token_endpoint) {
      exchanges++;
      const form = options.body;
      assert.equal(form.get('grant_type'), 'authorization_code');
      assert.equal(form.get('client_id'), clientId);
      assert.equal(form.get('redirect_uri'), authorization.searchParams.get('redirect_uri'));
      assert.ok(form.get('code_verifier'));
      assert.equal(form.get('resource'), 'https://api.openai.com/v1');
      if (currentTokenError) return Response.json({ error: currentTokenError, error_description: 'opaque-secret-provider-body' },
        { status: 400, headers: { 'x-request-id': 'request_fixture' } });
      if (tokenDelay) await tokenDelay();
      const issuedAt = Math.floor(Date.now() / 1000);
      const signer = badSignature ? (await generateKeyPair('RS256')).privateKey : privateKey;
      const token = await new SignJWT({ nonce: changeNonce ? 'wrong-nonce' : authorization.searchParams.get('nonce'), email: 'person@example.test' })
        .setProtectedHeader({ alg: 'RS256', kid: 'test-key' }).setIssuer(wrongIssuer ? 'https://wrong.example' : issuer)
        .setAudience(wrongAudience ? 'another-client' : clientId)
        .setSubject(changeSubject ? 'other-subject' : issuedSubject)
        .setIssuedAt(futureIssuedAt ? issuedAt + 3600 : issuedAt)
        .setExpirationTime(expired ? issuedAt - 60 : issuedAt + 7200)
        .sign(signer);
      return Response.json({ ...(grant.includes('chatgpt.tokens.use.direct') ? tokenFixture(grant) : { scope: grant }),
        ...(wrongTokenClient ? { client_id: 'another-issued-client' } : {}), id_token: token });
    }
    throw new Error('Unexpected provider request');
  };
  const openAuthorization = async value => {
    authorization = new URL(value);
    const url = new URL(authorization.searchParams.get('redirect_uri'));
    if (currentCallbackError) url.searchParams.set('error', currentCallbackError);
    else url.searchParams.set('code', 'one-use-code');
    url.searchParams.set('state', authorization.searchParams.get('state'));
    if (currentReturnedClient !== null) url.searchParams.set('client_id', currentReturnedClient);
    for (const [name, value] of callbackParams) url.searchParams.append(name, value);
    callbackUrl = url.href;
    if (beforeCallback) await beforeCallback(url, () => exchanges);
    callbackResult = fetch(url).then(response => response.text());
    return true;
  };
  return { storageRoot, fetchImpl, openAuthorization,
    setSubject(value) { issuedSubject = value; },
    setTokenError(value) { currentTokenError = value; },
    setReturnedClient(value) { currentReturnedClient = value; },
    setCallbackError(value) { currentCallbackError = value; },
    authorization: () => authorization, callbackUrl: () => callbackUrl,
    tokenExchanges: () => exchanges, callbackPage: () => callbackResult };
}

test('fresh loopback dynamic registration verifies signed identity and keeps tokens out of browser views', async t => {
  const f = await fixture(t);
  assert.deepEqual(await listAuthRegistrations({ storageRoot: f.storageRoot }), []);
  assert.equal((await getAuthStatus({ storageRoot: f.storageRoot })).session, 'signed-out');
  const attempt = await startOAuthLogin({ storageRoot: f.storageRoot, runtimeId: 'local' }, f);
  assert.equal(attempt.launchMode, 'system-browser');
  assert.equal(Object.hasOwn(attempt, 'authorizationUrl'), false);
  const account = await attempt.completion;
  assert.equal(account.identity, 'verified');
  assert.equal(account.planPermission, 'granted');
  assert.equal(account.planEnabled, false);
  assert.equal(f.authorization().searchParams.get('client_id'), 'dynamic_agent_client');
  assert.equal(f.authorization().searchParams.get('agent_name_hint'), 'Relmio');
  assert.match(f.authorization().searchParams.get('redirect_uri'), /^http:\/\/127\.0\.0\.1:\d+\/auth\/callback$/u);
  assert.equal(f.authorization().searchParams.get('scope'), 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct');
  assert.equal(f.authorization().searchParams.has('id_token_hint'), false);
  const privateRecord = await readRegistration({ storageRoot: f.storageRoot, registrationId: account.registrationId });
  assert.equal(privateRecord.clientId, clientId);
  assert.equal(privateRecord.session.refreshToken, 'opaque-secret-refresh');
  assert.equal(JSON.stringify(await listAuthRegistrations({ storageRoot: f.storageRoot })).includes('opaque-secret'), false);
  assert.equal((await f.callbackPage()).includes('opaque-secret'), false);
  assert.equal((await f.callbackPage()).includes('one-use-code'), false);
});

test('documented callback scope is ignored for plan permission and exact issuer is accepted', async t => {
  for (const variant of [
    { callbackScope: 'openid', grant: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct', permission: 'granted' },
    { callbackScope: 'chatgpt.tokens.use.direct email offline_access openid profile resource.invoke',
      grant: 'openid profile email', permission: 'not-granted' },
  ]) {
    const f = await fixture(t, { grant: variant.grant, callbackParams: [['scope', variant.callbackScope], ['iss', issuer]] });
    const attempt = await startOAuthLogin({ storageRoot: f.storageRoot, runtimeId: 'local' }, f);
    const account = await attempt.completion;
    assert.equal(account.identity, 'verified');
    assert.equal(account.planPermission, variant.permission);
    assert.equal(f.tokenExchanges(), 1);
    assert.deepEqual((await readRegistration({ storageRoot: f.storageRoot, registrationId: account.registrationId })).session.scopes,
      variant.grant.split(' '));
    assert.equal((await f.callbackPage()).includes('opaque-secret'), false);
  }
});

test('callback issuer mismatch, unknown parameters and duplicate optional parameters fail before token exchange', async t => {
  for (const callbackParams of [
    [['iss', 'https://other.example']],
    [['iss', `${issuer}/`]],
    [['scope', 'openid'], ['scope', 'chatgpt.tokens.use.direct']],
    [['iss', issuer], ['iss', issuer]],
    [['unknown', 'opaque-secret-callback']],
  ]) {
    const f = await fixture(t, { callbackParams });
    const attempt = await startOAuthLogin({ storageRoot: f.storageRoot, runtimeId: 'local' }, f);
    await assert.rejects(attempt.completion);
    assert.equal(f.tokenExchanges(), 0);
    assert.deepEqual(await listAuthRegistrations({ storageRoot: f.storageRoot }), []);
    assert.equal((await f.callbackPage()).includes('opaque-secret'), false);
  }
});

test('valid-state access denial declines sign-in without exchanging a code or reserving a client', async t => {
  const f = await fixture(t, { callbackError: 'access_denied', returnedClient: null,
    callbackParams: [['scope', 'chatgpt.tokens.use.direct'], ['iss', issuer]] });
  const attempt = await startOAuthLogin({ storageRoot: f.storageRoot, runtimeId: 'local' }, f);
  await assert.rejects(attempt.completion, error => {
    assert.equal(error.safeOAuth, true);
    assert.equal(error.code, 'access_denied');
    assert.equal(error.recovery, 'none');
    return true;
  });
  assert.equal(f.tokenExchanges(), 0);
  assert.deepEqual(await listAuthRegistrations({ storageRoot: f.storageRoot }), []);
  const completionPage = await f.callbackPage();
  assert.equal(completionPage.includes('opaque-secret'), false);
  assert.equal(completionPage.includes(f.authorization().searchParams.get('state')), false);
  const replay = new URL(f.callbackUrl());
  replay.searchParams.delete('error');
  replay.searchParams.set('code', 'one-use-code');
  replay.searchParams.set('client_id', clientId);
  await fetch(replay).then(response => assert.equal(response.status, 400), () => {});
  assert.equal(f.tokenExchanges(), 0);
  await attempt.cancel();
});

test('plan consent denial preserves the verified account and reports enable-plan recovery', async t => {
  const f = await fixture(t, { grant: 'openid profile email' });
  const firstAttempt = await startOAuthLogin({ storageRoot: f.storageRoot, runtimeId: 'local' }, f);
  const account = await firstAttempt.completion;
  await f.callbackPage();
  const registration = { storageRoot: f.storageRoot, registrationId: account.registrationId };
  const before = await readRegistration(registration);
  f.setCallbackError('access_denied');
  const attempt = await startOAuthLogin({ ...registration, runtimeId: 'local', purpose: 'enable-plan' }, f);
  await assert.rejects(attempt.completion, error => {
    assert.equal(error.safeOAuth, true);
    assert.equal(error.code, 'access_denied');
    assert.equal(error.recovery, 'enable-plan');
    return true;
  });
  assert.equal(f.tokenExchanges(), 1);
  assert.deepEqual(await readRegistration(registration), before);
  assert.equal((await getAuthStatus(registration)).planPermission, 'not-granted');
  assert.equal((await f.callbackPage()).includes('opaque-secret'), false);
});

test('access denial with invalid issuer or unsupported error parameters stays a generic failure and makes no token request', async t => {
  for (const variant of [
    { callbackParams: [['iss', 'https://other.example']] },
    { callbackParams: [['error_description', 'opaque-secret-callback']] },
    { callbackError: 'unknown_error' },
  ]) {
    const f = await fixture(t, { callbackError: 'access_denied', ...variant });
    const attempt = await startOAuthLogin({ storageRoot: f.storageRoot, runtimeId: 'local' }, f);
    await assert.rejects(attempt.completion, error => {
      assert.equal(error.code, undefined);
      assert.equal(error.safeOAuth, undefined);
      return true;
    });
    assert.equal(f.tokenExchanges(), 0);
    assert.deepEqual(await listAuthRegistrations({ storageRoot: f.storageRoot }), []);
    assert.equal((await f.callbackPage()).includes('opaque-secret'), false);
  }
});

test('wrong-state loopback callbacks never consume the attempt before a correct one completes', async t => {
  const f = await fixture(t, { beforeCallback: async (callback, exchanges) => {
    for (const variant of ['wrong', 'wrong-denial', 'missing', 'duplicate']) {
      const invalid = new URL(callback);
      if (variant === 'missing') invalid.searchParams.delete('state');
      else if (variant === 'duplicate') invalid.searchParams.append('state', invalid.searchParams.get('state'));
      else invalid.searchParams.set('state', 'x'.repeat(43));
      if (variant === 'wrong-denial') {
        invalid.searchParams.delete('code');
        invalid.searchParams.set('error', 'access_denied');
      }
      const response = await fetch(invalid);
      assert.equal(response.status, 400);
      assert.equal((await response.text()).includes('one-use-code'), false);
      assert.equal(exchanges(), 0);
    }
  } });
  const attempt = await startOAuthLogin({ storageRoot: f.storageRoot, runtimeId: 'local' }, f);
  const account = await attempt.completion;
  assert.equal(account.identity, 'verified');
  assert.equal(f.tokenExchanges(), 1);
  await f.callbackPage();
});

test('selected account status is coherent without reading unrelated registrations', async t => {
  const f = await fixture(t);
  const attempt = await startOAuthLogin({ storageRoot: f.storageRoot, runtimeId: 'local' }, f);
  const account = await attempt.completion;
  await f.callbackPage();
  await fs.writeFile(join(f.storageRoot, 'registrations', 'another-registration-id.json'), '{"session":"malformed"}', { mode: 0o600 });
  const status = await getAuthStatus({ storageRoot: f.storageRoot, registrationId: account.registrationId });
  assert.equal(status.exists, true);
  assert.equal(status.generation, account.generation);
  assert.equal(status.session, account.session);
  assert.equal(status.identity, account.identity);
  assert.equal(JSON.stringify(status).includes('opaque-secret'), false);
});

test('state and signed OIDC signature, issuer, audience, nonce and time reject unverified identity', async t => {
  for (const variant of [{ changeNonce: true }, { returnedClient: null },
    { returnedClient: 'dynamic_agent_client' }, { wrongAudience: true }, { wrongIssuer: true },
    { badSignature: true }, { futureIssuedAt: true }, { wrongTokenClient: true }, { expired: true }]) {
    const f = await fixture(t, variant);
    const attempt = await startOAuthLogin({ storageRoot: f.storageRoot, runtimeId: 'local' }, f);
    await assert.rejects(attempt.completion);
    const views = await listAuthRegistrations({ storageRoot: f.storageRoot });
    assert.ok(views.every(view => view.identity === 'unverified' && view.session === 'signed-out'));
    if (variant.returnedClient === null || variant.returnedClient === 'dynamic_agent_client') assert.equal(views.length, 0);
    else assert.equal(views.length, 1);
    await f.callbackPage();
  }
});

test('identity-only grant persists but remains disabled for plan use; reconsent binds the subject', async t => {
  const f = await fixture(t, { grant: 'openid profile email' });
  const first = await startOAuthLogin({ storageRoot: f.storageRoot, runtimeId: 'local' }, f);
  const account = await first.completion;
  assert.equal(account.planPermission, 'not-granted');
  assert.equal(account.session, 'connected');
  assert.equal((await getAuthStatus({ storageRoot: f.storageRoot, registrationId: account.registrationId })).exists, true);
  assert.equal((await readRegistration({ storageRoot: f.storageRoot, registrationId: account.registrationId })).session.accessToken, undefined);
  f.setSubject('another-workspace');
  const second = await startOAuthLogin({ storageRoot: f.storageRoot, registrationId: account.registrationId,
    runtimeId: 'local', purpose: 'enable-plan' }, f);
  assert.equal(f.authorization().searchParams.get('client_id'), clientId);
  assert.equal(f.authorization().searchParams.get('prompt'), 'consent');
  assert.equal(f.authorization().searchParams.has('agent_name_hint'), false);
  await assert.rejects(second.completion);
  assert.equal((await readRegistration({ storageRoot: f.storageRoot, registrationId: account.registrationId })).identity.subject, 'verified-subject');
});

test('reauthorization rejects a different callback client without replacing the verified session', async t => {
  const f = await fixture(t);
  const first = await startOAuthLogin({ storageRoot: f.storageRoot, runtimeId: 'local' }, f);
  const original = await first.completion;
  await f.callbackPage();
  f.setReturnedClient('another-issued-client');
  const retry = await startOAuthLogin({ storageRoot: f.storageRoot,
    registrationId: original.registrationId, runtimeId: 'local' }, f);
  await assert.rejects(retry.completion);
  const saved = await readRegistration({ storageRoot: f.storageRoot, registrationId: original.registrationId });
  assert.equal(saved.generation, original.generation);
  assert.equal(saved.clientId, clientId);
  assert.equal(saved.session.accessToken, 'opaque-secret-access');
});

test('replayed callback state cannot trigger a second token exchange', async t => {
  let entered, release;
  const reached = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { tokenDelay: async () => { entered(); await gate; } });
  const attempt = await startOAuthLogin({ storageRoot: f.storageRoot, runtimeId: 'local' }, f);
  await reached;
  const replay = await fetch(f.callbackUrl());
  assert.equal(replay.status, 400);
  release();
  const account = await attempt.completion;
  assert.equal(f.tokenExchanges(), 1);
  assert.equal((await readRegistration({ storageRoot: f.storageRoot, registrationId: account.registrationId })).generation,
    account.generation);
  await f.callbackPage();
});

test('cancellation invalidates an in-flight code exchange before credential commit', async t => {
  let entered, release;
  const reached = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { tokenDelay: async () => { entered(); await gate; } });
  const attempt = await startOAuthLogin({ storageRoot: f.storageRoot, runtimeId: 'local' }, f);
  await reached;
  const stopping = attempt.cancel();
  release();
  await stopping;
  await assert.rejects(attempt.completion);
  const pending = await listAuthRegistrations({ storageRoot: f.storageRoot });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].identity, 'unverified');
  await f.callbackPage();
});

test('cancellation during atomic commit clears any committed tokens before it completes', async t => {
  let entered, release, held = false;
  const reached = new Promise(resolve => { entered = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const f = await fixture(t);
  const fileSystem = {
    ...fs,
    async rename(source, destination) {
      if (!held && destination.includes('/registrations/') && destination.endsWith('.json') &&
          (await fs.readFile(source, 'utf8')).includes('opaque-secret-access')) {
        held = true;
        entered();
        await gate;
      }
      return fs.rename(source, destination);
    },
  };
  const attempt = await startOAuthLogin({ storageRoot: f.storageRoot, runtimeId: 'local' }, { ...f, fileSystem });
  await reached;
  const stopping = attempt.cancel();
  release();
  await stopping;
  await assert.rejects(attempt.completion);
  const views = await listAuthRegistrations({ storageRoot: f.storageRoot });
  assert.equal(views.length, 1);
  assert.equal(views[0].session, 'signed-out');
  const stored = await readRegistration({ storageRoot: f.storageRoot, registrationId: views[0].registrationId });
  assert.equal(stored.session.accessToken, undefined);
  assert.equal(stored.session.refreshToken, undefined);
  await f.callbackPage();
});

test('token-exchange failures expose safe code and recovery without leaking the provider body', async t => {
  const f = await fixture(t, { tokenError: 'invalid_client' });
  const attempt = await startOAuthLogin({ storageRoot: f.storageRoot, runtimeId: 'local' }, f);
  let pendingId;
  await assert.rejects(attempt.completion, error => {
    pendingId = error.registrationId;
    assert.equal(error.status, 400);
    assert.equal(error.code, 'invalid_client');
    assert.equal(error.recovery, 'fix-configuration');
    assert.equal(error.requestId, 'request_fixture');
    assert.equal(JSON.stringify(error).includes('opaque-secret-provider-body'), false);
    return true;
  });
  const pending = await listAuthRegistrations({ storageRoot: f.storageRoot });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].registrationId, pendingId);
  assert.equal(pending[0].identity, 'unverified');
  assert.equal((await f.callbackPage()).includes('opaque-secret-provider-body'), false);
});

test('invalid_grant after issued client registration retries with the saved client and fresh PKCE', async t => {
  const f = await fixture(t, { tokenError: 'invalid_grant' });
  const first = await startOAuthLogin({ storageRoot: f.storageRoot, runtimeId: 'local' }, f);
  let registrationId;
  await assert.rejects(first.completion, error => {
    assert.equal(error.code, 'invalid_grant');
    registrationId = error.registrationId;
    return typeof registrationId === 'string';
  });
  await f.callbackPage();
  const initialState = f.authorization().searchParams.get('state');
  const initialChallenge = f.authorization().searchParams.get('code_challenge');
  const pending = await listAuthRegistrations({ storageRoot: f.storageRoot });
  assert.equal(pending.length, 1);
  assert.equal(pending[0].registrationId, registrationId);
  assert.equal(pending[0].identity, 'unverified');
  assert.equal((await readRegistration({ storageRoot: f.storageRoot, registrationId })), null);
  assert.equal(JSON.stringify(pending).includes(clientId), false);
  assert.equal((await getAuthStatus({ storageRoot: f.storageRoot, registrationId })).exists, false);
  await assert.rejects(selectRegistration({ storageRoot: f.storageRoot, registrationId }));
  f.setTokenError(null);
  const retry = await startOAuthLogin({ storageRoot: f.storageRoot, registrationId, runtimeId: 'local' }, f);
  assert.equal(f.authorization().searchParams.get('client_id'), clientId);
  assert.equal(f.authorization().searchParams.has('agent_name_hint'), false);
  assert.notEqual(f.authorization().searchParams.get('state'), initialState);
  assert.notEqual(f.authorization().searchParams.get('code_challenge'), initialChallenge);
  const account = await retry.completion;
  assert.equal(account.registrationId, registrationId);
  assert.equal(account.identity, 'verified');
  assert.equal((await listAuthRegistrations({ storageRoot: f.storageRoot })).length, 1);
});

test('verified loopback reauthorization preserves an accepted receipt without exposing recovery proofs or tokens in account status', async t => {
  const f = await fixture(t);
  const destinationRoot = await fs.mkdtemp(join(tmpdir(), 'relmio-siwc-oauth-destination-'));
  t.after(() => fs.rm(destinationRoot, { recursive: true, force: true }));
  const attempt = await startOAuthLogin({ storageRoot: f.storageRoot, runtimeId: 'local' }, f);
  const first = await attempt.completion;
  await f.callbackPage();
  const source = { storageRoot: f.storageRoot, registrationId: first.registrationId };
  const enabled = await setPlanEnabled(source, { enabled: true, expectedGeneration: first.generation });
  const target = await ensureSiwcHost({ storageRoot: destinationRoot, runtimeId: 'local' });
  const prepared = await prepareAuthHandoff(source, {
    expectedGeneration: enabled.generation, target, backgroundConsent: false,
  });
  const pending = await readPendingAuthHandoff(source);
  const contents = await readAuthHandoff(source, {
    handoffId: prepared.handoffId, expectedGeneration: enabled.generation,
  });
  const accepted = await acceptAuthHandoff({ storageRoot: destinationRoot, runtimeId: 'local',
    expectedRegistrationId: first.registrationId, expectedTarget: target, contents });
  await finishAuthHandoff(source, { handoffId: prepared.handoffId, receipt: accepted.receipt });
  const destination = { storageRoot: destinationRoot, registrationId: first.registrationId };
  const renewed = await startOAuthLogin({ ...destination, runtimeId: 'local' }, f);
  const account = await renewed.completion;
  await f.callbackPage();
  assert.equal(f.authorization().searchParams.get('client_id'), clientId);
  assert.deepEqual(await readAuthHandoffReceipt(destination, { runtimeId: 'local',
    handoffId: pending.handoffId, expectedTarget: target,
    expectedBinding: pending.binding, identity: pending.identity }), accepted);
  const status = await getAuthStatus({ ...destination, runtimeId: 'local' });
  assert.equal(status.exists, true);
  assert.equal(status.generation, account.generation);
  assert.equal((await getAuthStatus({ ...source, runtimeId: 'local' })).ownership, 'transferred');
  const serialized = JSON.stringify(status);
  assert.equal(serialized.includes('opaque-secret'), false);
  assert.equal(serialized.includes(accepted.receipt.proof), false);
  assert.equal(serialized.includes('acceptedHandoff'), false);
});

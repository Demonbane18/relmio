import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { chmod, link, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  CODEX_IMAGES_CLIENT_ID, CODEX_IMAGES_VERIFICATION_URL, cancelCodexImagesLogin, codexImagesStatus,
  getCodexImagesLease, pollCodexImagesLogin, runCodexImagesCli, signOutCodexImages, startCodexImagesLogin,
} from '../src/services/codex-images.mjs';

const T0 = Date.parse('2026-10-06T12:00:00.000Z');
const AUTH = 'https://api.openai.com/auth';
const ACCOUNT = 'acct-1234567890abcdef';
const iso = ms => new Date(ms).toISOString();
const jwt = payload => `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify(payload)).toString('base64url')}.private-signature`;
const ACCESS = jwt({ exp: (T0 + 3_600_000) / 1000, [AUTH]: { chatgpt_account_id: 'acct-from-access-zyxwvu' }, jti: 'a1' });
const ID_TOKEN = jwt({ email: 'user@example.com', [AUTH]: { chatgpt_account_id: ACCOUNT, chatgpt_plan_type: 'plus' } });
const SECRETS = ['private-device-auth-id', 'private-auth-code', 'private-code-verifier', 'private-refresh-1',
  'private-refresh-2', 'private-signature', ACCESS, ID_TOKEN];

async function root(t) {
  const storageRoot = await mkdtemp(join(tmpdir(), 'relmio-codex-images-'));
  t.after(() => rm(storageRoot, { recursive: true, force: true }));
  return storageRoot;
}
// Fake auth.openai.com: one handler per path; every request is recorded with its decoded body.
function harness(handlers = {}) {
  const clock = { t: T0 };
  const calls = [];
  const fetchImpl = async (url, options) => {
    const form = options.headers['content-type'] === 'application/x-www-form-urlencoded';
    const body = form ? Object.fromEntries(options.body) : JSON.parse(options.body);
    const path = new URL(url).pathname;
    calls.push({ path, body, form });
    assert.ok(handlers[path], `unexpected request to ${url}`);
    return handlers[path](body);
  };
  return { clock, calls, handlers, deps: { fetchImpl, now: () => clock.t, sleep: async () => {} } };
}
const json = (body, status = 200) => () => Response.json(body, { status });
const deviceCode = (extra = {}) => json({ device_auth_id: 'private-device-auth-id', user_code: 'ABCD-1234', ...extra });
const grant = json({ authorization_code: 'private-auth-code', code_challenge: 'challenge', code_verifier: 'private-code-verifier' });
const tokens = (extra = {}) => json({ id_token: ID_TOKEN, access_token: ACCESS, refresh_token: 'private-refresh-1', ...extra });
const storeDir = storageRoot => join(storageRoot, 'codex-images');
async function seedSession(storageRoot, overrides = {}) {
  await mkdir(storeDir(storageRoot), { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  const session = {
    schemaVersion: 1, clientId: CODEX_IMAGES_CLIENT_ID, accountId: ACCOUNT, email: 'user@example.com', planType: 'plus',
    accessToken: ACCESS, refreshToken: 'private-refresh-1', accessExpiresAt: iso(T0 + 3_600_000),
    obtainedAt: iso(T0 - 60_000), refreshState: 'ok', updatedAt: iso(T0 - 60_000), ...overrides,
  };
  await writeFile(join(storeDir(storageRoot), 'session.json'), JSON.stringify(session), { mode: 0o600 });
  return session;
}
const readSession = async storageRoot => JSON.parse(await readFile(join(storeDir(storageRoot), 'session.json'), 'utf8'));
const rejectsWith = (promise, code) => assert.rejects(promise, error => error.code === code);

test('device sign-in saves one images session and returns no secrets', async t => {
  const storageRoot = await root(t);
  const { clock, calls, deps } = harness({
    '/api/accounts/deviceauth/usercode': deviceCode({ user_code: undefined, usercode: 'ABCD-1234', interval: '7' }),
    '/api/accounts/deviceauth/token': grant,
    '/oauth/token': tokens(),
  });
  const started = await startCodexImagesLogin({ storageRoot }, deps);
  assert.deepEqual(started, { state: 'pending', pending: {
    userCode: 'ABCD-1234', verificationUrl: CODEX_IMAGES_VERIFICATION_URL, expiresAt: iso(T0 + 15 * 60_000) } });
  assert.deepEqual(calls[0], { path: '/api/accounts/deviceauth/usercode', body: { client_id: CODEX_IMAGES_CLIENT_ID }, form: false });

  clock.t = T0 + 6_999;
  assert.equal((await pollCodexImagesLogin({ storageRoot }, deps)).state, 'pending');
  assert.equal(calls.length, 1, 'an early poll must not reach OpenAI');

  clock.t = T0 + 7_000;
  const signedIn = await pollCodexImagesLogin({ storageRoot }, deps);
  assert.deepEqual(signedIn, { state: 'signed-in', account: { email: 'user@example.com', planType: 'plus', accountIdSuffix: 'abcdef' } });
  assert.deepEqual(calls.slice(1), [
    { path: '/api/accounts/deviceauth/token', body: { device_auth_id: 'private-device-auth-id', user_code: 'ABCD-1234' }, form: false },
    { path: '/oauth/token', form: true, body: {
      grant_type: 'authorization_code', client_id: CODEX_IMAGES_CLIENT_ID, code: 'private-auth-code',
      redirect_uri: 'https://auth.openai.com/deviceauth/callback', code_verifier: 'private-code-verifier' } },
  ]);

  assert.deepEqual(await readdir(storageRoot), ['codex-images']);
  assert.deepEqual(await readdir(storeDir(storageRoot)), ['session.json']);
  assert.equal((await stat(storeDir(storageRoot))).mode & 0o777, 0o700);
  assert.equal((await stat(join(storeDir(storageRoot), 'session.json'))).mode & 0o777, 0o600);
  const session = await readSession(storageRoot);
  assert.equal(JSON.stringify(session).includes(ID_TOKEN), false);
  assert.equal(session.accountId, ACCOUNT);
  assert.equal(session.refreshToken, 'private-refresh-1');
  assert.equal(session.accessExpiresAt, iso(T0 + 3_600_000));
  assert.equal(session.refreshState, 'ok');

  assert.deepEqual(await codexImagesStatus({ storageRoot }, deps), signedIn);
  assert.deepEqual(await getCodexImagesLease({ storageRoot }, deps), { accessToken: ACCESS, accountId: ACCOUNT, fedramp: false });
  await rejectsWith(startCodexImagesLogin({ storageRoot }, deps), 'images_signed_in');
  assert.equal(calls.length, 3);
});

test('polling honours the 5 s floor and keeps the pending sign-in until it succeeds', async t => {
  const storageRoot = await root(t);
  const { clock, calls, handlers, deps } = harness({ '/api/accounts/deviceauth/usercode': deviceCode({ interval: '2' }) });
  await startCodexImagesLogin({ storageRoot }, deps);
  clock.t = T0 + 4_999;
  await pollCodexImagesLogin({ storageRoot }, deps);
  assert.equal(calls.length, 1);

  for (const [offset, status] of [[5_000, 403], [10_000, 404]]) {
    clock.t = T0 + offset;
    handlers['/api/accounts/deviceauth/token'] = json({}, status);
    assert.equal((await pollCodexImagesLogin({ storageRoot }, deps)).state, 'pending');
    assert.equal((await pollCodexImagesLogin({ storageRoot }, deps)).state, 'pending');
  }
  assert.equal(calls.length, 3, 'a repeated poll inside the interval must not reach OpenAI');

  clock.t = T0 + 15_000;
  handlers['/api/accounts/deviceauth/token'] = json({ error: 'server_error' }, 500);
  await rejectsWith(pollCodexImagesLogin({ storageRoot }, deps), 'images_login_failed');
  assert.equal((await codexImagesStatus({ storageRoot }, deps)).state, 'pending');

  clock.t = T0 + 20_000;
  handlers['/api/accounts/deviceauth/token'] = grant;
  handlers['/oauth/token'] = json({ error: 'invalid_grant' }, 400);
  await rejectsWith(pollCodexImagesLogin({ storageRoot }, deps), 'images_login_failed');
  assert.equal((await codexImagesStatus({ storageRoot }, deps)).state, 'pending', 'exchange failure keeps the pending sign-in');

  clock.t = T0 + 25_000;
  handlers['/oauth/token'] = tokens({ id_token: jwt({}) });
  const result = await pollCodexImagesLogin({ storageRoot }, deps);
  assert.deepEqual(result, { state: 'signed-in', account: { accountIdSuffix: 'zyxwvu' } });
  assert.equal((await readSession(storageRoot)).accountId, 'acct-from-access-zyxwvu');
});

test('declined and expired sign-ins end in off and clear the pending code', async t => {
  const storageRoot = await root(t);
  const { clock, calls, handlers, deps } = harness({
    '/api/accounts/deviceauth/usercode': deviceCode(),
    '/api/accounts/deviceauth/token': json({ error: 'authorization_declined', error_description: 'Denied' }, 401),
  });
  await startCodexImagesLogin({ storageRoot }, deps);
  clock.t = T0 + 5_000;
  assert.deepEqual(await pollCodexImagesLogin({ storageRoot }, deps), { state: 'off', outcome: 'declined' });
  assert.deepEqual(await codexImagesStatus({ storageRoot }, deps), { state: 'off' });

  clock.t = T0;
  await startCodexImagesLogin({ storageRoot }, deps);
  handlers['/api/accounts/deviceauth/token'] = json({ error: 'unauthorized' }, 401);
  clock.t = T0 + 5_000;
  await rejectsWith(pollCodexImagesLogin({ storageRoot }, deps), 'images_login_failed');
  const polls = calls.length;
  clock.t = T0 + 15 * 60_000;
  assert.deepEqual(await pollCodexImagesLogin({ storageRoot }, deps), { state: 'off', outcome: 'expired' });
  assert.equal(calls.length, polls, 'an expired sign-in is not polled');

  clock.t = T0;
  await startCodexImagesLogin({ storageRoot }, deps);
  clock.t = T0 + 15 * 60_000;
  assert.deepEqual(await codexImagesStatus({ storageRoot }, deps), { state: 'off' });
  assert.deepEqual(await readdir(storeDir(storageRoot)), []);
});

test('starting again replaces the pending sign-in and cancel clears it', async t => {
  const storageRoot = await root(t);
  const { handlers, deps } = harness({ '/api/accounts/deviceauth/usercode': deviceCode() });
  await startCodexImagesLogin({ storageRoot }, deps);
  handlers['/api/accounts/deviceauth/usercode'] = deviceCode({ user_code: 'WXYZ-9876' });
  assert.equal((await startCodexImagesLogin({ storageRoot }, deps)).pending.userCode, 'WXYZ-9876');
  assert.equal((await codexImagesStatus({ storageRoot }, deps)).pending.userCode, 'WXYZ-9876');
  assert.deepEqual(await cancelCodexImagesLogin({ storageRoot }, deps), { state: 'off' });
  assert.deepEqual(await codexImagesStatus({ storageRoot }, deps), { state: 'off' });
});

test('a 404 on the device code request means device code sign-in is off; other start failures stay generic', async t => {
  const storageRoot = await root(t);
  const { handlers, deps } = harness({ '/api/accounts/deviceauth/usercode': json({ error: 'not_found' }, 404) });
  await rejectsWith(startCodexImagesLogin({ storageRoot }, deps), 'images_device_login_disabled');
  for (const failure of [json({}, 500), json({}, 403), () => { throw new Error('offline'); }, json({ device_auth_id: 'private-device-auth-id' })]) {
    handlers['/api/accounts/deviceauth/usercode'] = failure;
    await rejectsWith(startCodexImagesLogin({ storageRoot }, deps), 'images_login_failed');
  }
  assert.deepEqual(await codexImagesStatus({ storageRoot }, deps), { state: 'off' });
});

test('refresh persists in-flight first, then stores the rotated pair', async t => {
  const storageRoot = await root(t);
  await seedSession(storageRoot, { accessExpiresAt: iso(T0 + 5 * 60_000 + 1_000) });
  const rotated = jwt({ exp: (T0 + 7_200_000) / 1000, [AUTH]: { chatgpt_data_residency: 'eu', chatgpt_account_is_fedramp: true } });
  const { clock, calls, handlers, deps } = harness({
    '/oauth/token': async () => {
      assert.equal((await readSession(storageRoot)).refreshState, 'in-flight');
      assert.deepEqual(JSON.parse(await readFile(join(storeDir(storageRoot), 'lock'), 'utf8')), { pid: process.pid, createdAt: iso(clock.t) });
      return Response.json({ access_token: rotated, refresh_token: 'private-refresh-2' });
    },
  });
  assert.equal((await getCodexImagesLease({ storageRoot }, deps)).accessToken, ACCESS);
  assert.equal(calls.length, 0, 'no refresh while more than 5 minutes remain');

  clock.t = T0 + 1_000;
  assert.deepEqual(await getCodexImagesLease({ storageRoot }, deps),
    { accessToken: rotated, accountId: ACCOUNT, residency: 'eu', fedramp: true });
  assert.deepEqual(calls, [{ path: '/oauth/token', form: false,
    body: { client_id: CODEX_IMAGES_CLIENT_ID, grant_type: 'refresh_token', refresh_token: 'private-refresh-1' } }]);
  let session = await readSession(storageRoot);
  assert.equal(session.refreshToken, 'private-refresh-2');
  assert.equal(session.refreshState, 'ok');
  assert.equal(session.email, 'user@example.com');
  assert.equal(session.planType, 'plus');
  await getCodexImagesLease({ storageRoot }, deps);
  assert.equal(calls.length, 1);

  clock.t = T0 + 7_200_000;
  handlers['/oauth/token'] = json({ access_token: jwt({ exp: (T0 + 9_000_000) / 1000 }) });
  await getCodexImagesLease({ storageRoot }, deps);
  assert.equal(calls[1].body.refresh_token, 'private-refresh-2');
  session = await readSession(storageRoot);
  assert.equal(session.refreshToken, 'private-refresh-2', 'a response without a refresh token keeps the current one');
  assert.equal(await readdir(storeDir(storageRoot)).then(names => names.includes('lock')), false);
});

test('lease sends residency only from a valid claim', async t => {
  const cases = [
    [{ chatgpt_data_residency: 'EU!', chatgpt_compute_residency: 'us' }, 'us'],
    [{ chatgpt_data_residency: 'a-very-long-region-name' }, undefined],
    [{ chatgpt_account_is_fedramp: 'true' }, undefined],
  ];
  for (const [claims, residency] of cases) {
    const storageRoot = await root(t);
    const accessToken = jwt({ exp: (T0 + 3_600_000) / 1000, [AUTH]: claims });
    await seedSession(storageRoot, { accessToken });
    const lease = await getCodexImagesLease({ storageRoot }, harness().deps);
    assert.equal(lease.residency, residency);
    assert.equal(lease.fedramp, false);
  }
});

test('refresh answers that need a new sign-in mark reauthorize and never retry the token', async t => {
  const cases = [
    [401, {}],
    [400, { error: { code: 'refresh_token_expired' } }],
    [401, { error: { code: 'refresh_token_reused' } }],
    [400, { error: { code: 'refresh_token_reused' } }],
    [400, { error: { code: 'refresh_token_invalidated' } }],
    [403, { code: 'refresh_token_reused' }],
    [400, { error: 'invalid_grant' }],
  ];
  for (const [status, body] of cases) {
    const storageRoot = await root(t);
    await seedSession(storageRoot, { accessExpiresAt: iso(T0 + 60_000) });
    const { calls, deps } = harness({ '/oauth/token': json(body, status) });
    await rejectsWith(getCodexImagesLease({ storageRoot }, deps), 'images_reauthorize');
    const session = await readSession(storageRoot);
    assert.equal(session.refreshState, 'reauthorize', JSON.stringify(body));
    assert.equal(session.refreshToken, 'private-refresh-1');
    await rejectsWith(getCodexImagesLease({ storageRoot }, deps), 'images_reauthorize');
    assert.equal(calls.length, 1);
    assert.equal((await codexImagesStatus({ storageRoot }, deps)).state, 'reauthorize');
  }
});

test('a transport error or unreadable answer after sending never replays the refresh token', async t => {
  const cases = [
    () => { throw new Error('socket hang up private-refresh-1'); },
    () => { throw Object.assign(new Error('The operation was aborted due to timeout'), { name: 'TimeoutError' }); },
    () => new Response('{"access_token":', { status: 200 }),
    json({ access_token: 'not-a-jwt-without-expiry', refresh_token: 'private-refresh-2' }),
  ];
  for (const handler of cases) {
    const storageRoot = await root(t);
    await seedSession(storageRoot, { accessExpiresAt: iso(T0 + 60_000) });
    const { calls, deps } = harness({ '/oauth/token': handler });
    await assert.rejects(getCodexImagesLease({ storageRoot }, deps), error =>
      error.code === 'images_reauthorize' && !SECRETS.some(secret => error.message.includes(secret)));
    assert.equal((await readSession(storageRoot)).refreshState, 'reauthorize');
    await rejectsWith(getCodexImagesLease({ storageRoot }, deps), 'images_reauthorize');
    assert.equal(calls.length, 1);
  }
});

test('other refresh errors restore the session so a later lease can retry', async t => {
  for (const [status, body] of [[400, { error: 'invalid_request' }], [500, {}], [429, { error: { code: 'rate_limited' } }]]) {
    const storageRoot = await root(t);
    await seedSession(storageRoot, { accessExpiresAt: iso(T0 + 60_000) });
    const { calls, deps } = harness({ '/oauth/token': json(body, status) });
    await rejectsWith(getCodexImagesLease({ storageRoot }, deps), 'images_unavailable');
    const session = await readSession(storageRoot);
    assert.equal(session.refreshState, 'ok');
    assert.equal(session.refreshToken, 'private-refresh-1');
    await rejectsWith(getCodexImagesLease({ storageRoot }, deps), 'images_unavailable');
    assert.equal(calls.length, 2);
  }
});

test('a session left in-flight by a crash requires a new sign-in', async t => {
  const storageRoot = await root(t);
  await seedSession(storageRoot, { refreshState: 'in-flight' });
  const { calls, deps } = harness();
  await rejectsWith(getCodexImagesLease({ storageRoot }, deps), 'images_reauthorize');
  assert.equal(calls.length, 0);
  assert.equal((await readSession(storageRoot)).refreshState, 'reauthorize');

  const other = await root(t);
  await seedSession(other, { refreshState: 'in-flight' });
  assert.equal((await codexImagesStatus({ storageRoot: other }, deps)).state, 'reauthorize');
  await rejectsWith(getCodexImagesLease({ storageRoot: other }, deps), 'images_reauthorize');
});

test('the lock excludes other work and is replaced only when stale', async t => {
  const storageRoot = await root(t);
  await mkdir(storeDir(storageRoot), { mode: 0o700 });
  const lock = join(storeDir(storageRoot), 'lock');
  const held = JSON.stringify({ pid: 1, createdAt: iso(T0 - 119_000) });
  await writeFile(lock, held, { mode: 0o600 });
  const { deps } = harness();
  await rejectsWith(codexImagesStatus({ storageRoot }, deps), 'images_unavailable');
  assert.equal(await readFile(lock, 'utf8'), held, 'a live lock is left alone');

  let waits = 0;
  const released = { ...deps, sleep: async () => { waits++; await rm(lock); } };
  assert.deepEqual(await codexImagesStatus({ storageRoot }, released), { state: 'off' });
  assert.equal(waits, 1);

  await writeFile(lock, JSON.stringify({ pid: 1, createdAt: iso(T0 - 120_001) }), { mode: 0o600 });
  assert.deepEqual(await codexImagesStatus({ storageRoot }, deps), { state: 'off' });
  await assert.rejects(stat(lock), { code: 'ENOENT' });
});

test('concurrent leases refresh the token once', async t => {
  const storageRoot = await root(t);
  await seedSession(storageRoot, { accessExpiresAt: iso(T0 + 60_000) });
  const rotated = jwt({ exp: (T0 + 7_200_000) / 1000 });
  let answer;
  const gate = new Promise(done => { answer = done; });
  const { calls, deps } = harness({ '/oauth/token': async () => {
    await gate;
    return Response.json({ access_token: rotated, refresh_token: 'private-refresh-2' });
  } });
  const realWait = { ...deps, sleep: () => new Promise(done => setTimeout(done, 2)) };
  const first = getCodexImagesLease({ storageRoot }, realWait);
  while (calls.length === 0) await new Promise(done => setTimeout(done, 2));
  const second = getCodexImagesLease({ storageRoot }, realWait);
  await new Promise(done => setTimeout(done, 20));
  answer();
  assert.deepEqual((await Promise.all([first, second])).map(lease => lease.accessToken), [rotated, rotated]);
  assert.equal(calls.length, 1);
});

test('storage refuses symlinks, hard links, loose permissions and relative roots', async t => {
  const { deps } = harness({ '/oauth/revoke': json({}) });
  const cases = {
    'symlinked session': async (storageRoot, outside) => {
      await writeFile(outside, JSON.stringify(await seedSession(storageRoot)), { mode: 0o600 });
      await rm(join(storeDir(storageRoot), 'session.json'));
      await symlink(outside, join(storeDir(storageRoot), 'session.json'));
    },
    'hard-linked session': async (storageRoot, outside) => {
      await seedSession(storageRoot);
      await link(join(storeDir(storageRoot), 'session.json'), outside);
    },
    'group-readable session': async storageRoot => {
      await seedSession(storageRoot);
      await chmod(join(storeDir(storageRoot), 'session.json'), 0o640);
    },
    'open directory': async storageRoot => {
      await seedSession(storageRoot);
      await chmod(storeDir(storageRoot), 0o755);
    },
    'symlinked directory': async (storageRoot, outside) => {
      await mkdir(outside, { mode: 0o700 });
      await symlink(outside, storeDir(storageRoot));
    },
  };
  for (const [name, arrange] of Object.entries(cases)) {
    const storageRoot = await root(t);
    const outside = join(await root(t), 'outside');
    await arrange(storageRoot, outside);
    await rejectsWith(getCodexImagesLease({ storageRoot }, deps), 'images_unavailable', name);
    await rejectsWith(codexImagesStatus({ storageRoot }, deps), 'images_unavailable', name);
  }
  await rejectsWith(codexImagesStatus({ storageRoot: 'relative/root' }, deps), 'images_unavailable');

  const storageRoot = await root(t);
  const outside = join(await root(t), 'outside');
  await cases['symlinked session'](storageRoot, outside);
  assert.deepEqual(await signOutCodexImages({ storageRoot }, deps), { state: 'off', revocation: 'unconfirmed' });
  assert.equal((await readFile(outside, 'utf8')).includes('private-refresh-1'), true, 'sign-out never follows the link');
  assert.deepEqual(await readdir(storeDir(storageRoot)), []);
});

test('sign-out clears local state even when revocation fails', async t => {
  const cases = [
    [{}, () => { throw new Error('offline'); }, 'unconfirmed'],
    [{}, json({}, 500), 'unconfirmed'],
    [{}, json({}), 'confirmed'],
    [{ refreshState: 'reauthorize' }, json({}), 'unconfirmed'],
  ];
  for (const [overrides, revoke, revocation] of cases) {
    const storageRoot = await root(t);
    await seedSession(storageRoot, overrides);
    const { calls, deps } = harness({ '/oauth/revoke': revoke });
    assert.deepEqual(await signOutCodexImages({ storageRoot }, deps), { state: 'off', revocation });
    assert.deepEqual(calls[0].body, { token: 'private-refresh-1', token_type_hint: 'refresh_token', client_id: CODEX_IMAGES_CLIENT_ID });
    assert.deepEqual(await readdir(storeDir(storageRoot)), []);
    await rejectsWith(getCodexImagesLease({ storageRoot }, deps), 'images_off');
  }
  const storageRoot = await root(t);
  const { calls, deps } = harness({ '/api/accounts/deviceauth/usercode': deviceCode() });
  await startCodexImagesLogin({ storageRoot }, deps);
  assert.deepEqual(await signOutCodexImages({ storageRoot }, deps), { state: 'off', revocation: 'not-applicable' });
  assert.equal(calls.length, 1);
  assert.deepEqual(await codexImagesStatus({ storageRoot }, deps), { state: 'off' });
});

test('sign-out also removes leftover temp records but never follows links or touches other names', async t => {
  const storageRoot = await root(t);
  const outside = await root(t);
  await seedSession(storageRoot);
  const store = storeDir(storageRoot);
  const temp = name => join(store, name);
  for (const name of ['session.json.0b6b3c2e-4a8f-4c55-9a2e-1f0f6f7f8a9b.tmp', 'pending.json.1c7c4d3f-5b9a-4d66-8b3f-2a1a7a8b9cad.tmp'])
    await writeFile(temp(name), 'private-refresh-2', { mode: 0o600 });
  await writeFile(temp('notes.json.tmp'), 'keep', { mode: 0o600 });
  await writeFile(join(outside, 'target'), 'outside');
  await symlink(join(outside, 'target'), temp('session.json.2d8d5e4a-6c0b-4e77-9c4a-3b2b8b9cadbe.tmp'));
  await mkdir(temp('pending.json.3e9e6f5b-7d1c-4f88-8d5b-4c3c9cadbecf.tmp'));
  const { deps } = harness({ '/oauth/revoke': json({}) });
  assert.deepEqual(await signOutCodexImages({ storageRoot }, deps), { state: 'off', revocation: 'confirmed' });
  assert.deepEqual((await readdir(store)).sort(), ['notes.json.tmp', 'pending.json.3e9e6f5b-7d1c-4f88-8d5b-4c3c9cadbecf.tmp',
    'session.json.2d8d5e4a-6c0b-4e77-9c4a-3b2b8b9cadbe.tmp']);
  assert.equal(await readFile(join(outside, 'target'), 'utf8'), 'outside');
});

test('without a store every call except sign-in is off and creates nothing', async t => {
  const storageRoot = await root(t);
  const { calls, deps } = harness();
  for (const missing of [storageRoot, join(storageRoot, 'absent')]) {
    await rejectsWith(getCodexImagesLease({ storageRoot: missing }, deps), 'images_off');
    assert.deepEqual(await codexImagesStatus({ storageRoot: missing }, deps), { state: 'off' });
    assert.deepEqual(await pollCodexImagesLogin({ storageRoot: missing }, deps), { state: 'off' });
    assert.deepEqual(await cancelCodexImagesLogin({ storageRoot: missing }, deps), { state: 'off' });
    assert.deepEqual(await signOutCodexImages({ storageRoot: missing }, deps), { state: 'off', revocation: 'not-applicable' });
  }
  assert.deepEqual(await readdir(storageRoot), []);
  assert.equal(calls.length, 0);
});

test('the CLI prints one JSON line per command and never a secret', async t => {
  const storageRoot = await root(t);
  const { clock, handlers, deps } = harness({
    '/api/accounts/deviceauth/usercode': deviceCode(),
    '/api/accounts/deviceauth/token': grant,
    '/oauth/token': () => { throw new Error('connect failed for private-auth-code private-code-verifier'); },
    '/oauth/revoke': () => { throw new Error('revoke failed for private-refresh-1'); },
  });
  const run = async command => {
    const output = { text: '', write(chunk) { this.text += chunk; } };
    const exitCode = await runCodexImagesCli({ command, storageRoot, output, deps });
    assert.match(output.text, /^[^\n]+\n$/u);
    for (const secret of SECRETS) assert.equal(output.text.includes(secret), false, `${command} printed a secret`);
    return { exitCode, result: JSON.parse(output.text) };
  };
  assert.deepEqual(await run('status'), { exitCode: 0, result: { state: 'off' } });
  assert.equal((await run('login-start')).result.state, 'pending');
  clock.t = T0 + 5_000;
  const failed = await run('login-poll');
  assert.equal(failed.exitCode, 1);
  assert.equal(failed.result.error, 'images_login_failed');
  assert.equal(typeof failed.result.message, 'string');
  clock.t = T0 + 10_000;
  handlers['/oauth/token'] = tokens();
  assert.deepEqual(await run('login-poll'), { exitCode: 0, result: { state: 'signed-in',
    account: { email: 'user@example.com', planType: 'plus', accountIdSuffix: 'abcdef' } } });
  assert.equal((await run('login-start')).exitCode, 1);
  assert.deepEqual(await run('sign-out'), { exitCode: 0, result: { state: 'off', revocation: 'unconfirmed' } });
  assert.deepEqual(await run('login-cancel'), { exitCode: 0, result: { state: 'off' } });
  assert.deepEqual(await run('refresh'), { exitCode: 1, result: { error: 'invalid_command', message: 'Unknown Codex images command.' } });

  const script = fileURLToPath(new URL('../src/services/codex-images.mjs', import.meta.url));
  const { stdout } = await promisify(execFile)(process.execPath, [script, 'status'], { env: { N8N_OPENAI_OAUTH_HOME: storageRoot } });
  assert.deepEqual(JSON.parse(stdout), { state: 'off' });
  await assert.rejects(promisify(execFile)(process.execPath, [script, 'status'], { env: { N8N_OPENAI_OAUTH_HOME: 'relative' } }),
    error => error.code === 1 && JSON.parse(error.stdout).error === 'images_unavailable');
});

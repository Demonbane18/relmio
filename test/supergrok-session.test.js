import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, symlink, chmod, link } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFreshGrokSession, selectFreshSessionToken } from '../src/supergrok/session.js';
const id = 'a'.repeat(32);
const now = Date.parse('2026-09-05T00:00:00Z');
const fresh = () => ({ 'https://auth.x.ai::synthetic-client': { oidc_client_id: 'synthetic-client', auth_mode: 'oidc', oidc_issuer: 'https://auth.x.ai', key: 'synthetic-session-secret', expires_at: '2026-09-06T00:00:00Z' } });
const posixSessionSkip = process.platform === 'win32' && 'fresh-session file ownership is enforced inside the Linux runtime container';
async function setup(t) {
  const directory = await mkdtemp(join(tmpdir(), 'relmio-session-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const session = await createFreshGrokSession({ directory, instanceId: id, initialize: true, now: () => now });
  return { directory, session, auth: join(directory, 'auth.json') };
}
test('fresh empty namespace only, no preexisting credential adoption', { skip: posixSessionSkip }, async t => {
  const { directory, session, auth } = await setup(t);
  assert.deepEqual(await session.status(), { connected: false });
  await writeFile(auth, JSON.stringify(fresh()), { mode: 0o600 });
  assert.deepEqual(await session.status(), { connected: true });
  await session.withToken(value => assert.equal(value, 'synthetic-session-secret'));
  await assert.rejects(createFreshGrokSession({ directory, instanceId: id, initialize: true }), /fresh_session_required/u);
  await assert.rejects(createFreshGrokSession({ directory, instanceId: 'b'.repeat(32) }), /fresh_session_required/u);
  await rm(auth);
  assert.deepEqual(await session.status(), { connected: false });
});
test('keys, imports, legacy, foreign issuer, ambiguous and expired entries are rejected', () => {
  for (const mutation of [entry => { entry.auth_mode = 'api_key'; }, entry => { entry.auth_mode = 'web_login'; }, entry => { entry.auth_mode = 'external'; }, entry => { delete entry.auth_mode; }, entry => { entry.oidc_issuer = 'https://other.example'; }, entry => { entry.expires_at = '2026-09-04T00:00:00Z'; }, entry => { entry.key += '\r\nheader'; }]) {
    const record = fresh(); mutation(Object.values(record)[0]); assert.throws(() => selectFreshSessionToken(record, now), /login_required/u);
  }
  assert.throws(() => selectFreshSessionToken({ ...fresh(), other: Object.values(fresh())[0] }, now));
});
test('fresh session rejects direct Windows hosts', { skip: process.platform !== 'win32' && 'covered by the Linux runtime session tests' }, async () => {
  await assert.rejects(createFreshGrokSession({ directory: 'C:\\relmio-session', instanceId: id, initialize: true }), /invalid_session_configuration/u);
});
test('symlinks, hardlinks, public file modes and oversized auth fail closed', { skip: posixSessionSkip }, async t => {
  const { directory, session, auth } = await setup(t);
  const other = join(directory, 'other');
  await writeFile(other, JSON.stringify(fresh()), { mode: 0o600 });
  await symlink(other, auth); assert.deepEqual(await session.status(), { connected: false }); await rm(auth);
  await link(other, auth); assert.deepEqual(await session.status(), { connected: false }); await rm(auth);
  await writeFile(auth, JSON.stringify(fresh()), { mode: 0o600 }); await chmod(auth, 0o644);
  assert.deepEqual(await session.status(), { connected: false });
  await chmod(auth, 0o600); await writeFile(auth, 'a'.repeat(65537)); assert.deepEqual(await session.status(), { connected: false });
});
test('errors never reveal private directory, provider credentials or JSON', { skip: posixSessionSkip }, async t => {
  const { auth, session, directory } = await setup(t);
  await writeFile(auth, 'synthetic-secret-invalid-json', { mode: 0o600 });
  await assert.rejects(session.withToken(() => {}), error => error.message === 'login_required' && !String(error.stack).includes(directory));
});

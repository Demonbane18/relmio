import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import * as fs from 'node:fs/promises';
import { chmod, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { exportJWK, generateKeyPair, SignJWT } from 'jose';
import { getAuthStatus } from '../src/services/oauth.js';
import { runSiwcHandoffCli } from '../src/services/siwc-handoff.mjs';
import { acquireLocalIntegrationLifecycleLock } from '../src/services/local-integration-lifecycle-lock.js';
import { createSidecarHandler, createSidecarServer } from '../src/gateway/openai-oauth-sidecar.mjs';
import { getLocalPidNamespaceIdentity, getLocalProcessIdentity } from '../src/infrastructure/process-identity.js';
import { lockDownLocalPath } from '../src/infrastructure/local-process.js';
import {
  acceptAuthHandoff, acknowledgePlanUse, commitAuthorization, ensureSiwcHost, finishAuthHandoff,
  getAccessToken, getSelectedRegistration, listRegistrations, listSiwcThreadBindings, prepareAuthHandoff,
  readAuthHandoff, readAuthHandoffReceipt, readPendingAuthHandoff, readRegistration, readSiwcHost, readSiwcJson, recordSiwcThreadBinding,
  resolveSiwcStorageRoot, selectRegistration, setPlanEnabled, signOut, validateSiwcBackgroundConsent,
  SIWC_LOCK_OPERATION_TIMEOUT_MS, SIWC_LOCK_LEASE_MS, SIWC_LOCK_WAIT_TIMEOUT_MS,
} from '../src/services/siwc-session.mjs';
const execFileAsync = promisify(execFile);

const discovery = { issuer: 'https://auth.openai.com',
  authorization_endpoint: 'https://auth.openai.com/api/accounts/authorize',
  token_endpoint: 'https://auth.openai.com/api/accounts/oauth/token',
  jwks_uri: 'https://auth.openai.com/.well-known/jwks.json',
  revocation_endpoint: 'https://auth.openai.com/api/accounts/oauth/revoke' };
const tokens = (suffix, scope = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct') => ({
  access_token: `private-access-${suffix}`, refresh_token: `private-refresh-${suffix}`,
  id_token: `private-identity-${suffix}`, scope, token_type: 'Bearer', expires_in: 3600,
  earliest_refresh_at: 'opaque-provider-hint',
});
async function root(t) {
  const storageRoot = await mkdtemp(join(tmpdir(), 'relmio-siwc-session-'));
  t.after(() => rm(storageRoot, { recursive: true, force: true }));
  return storageRoot;
}
async function registration(storageRoot, suffix = 'first', now = 1700000000000) {
  return commitAuthorization({ storageRoot, clientId: `oaiapp_${suffix}`, runtimeId: 'local',
    identity: { issuer: discovery.issuer, subject: `subject-${suffix}`, email: 'same@example.test' },
    tokens: tokens(suffix) }, { now: () => now });
}
async function exportedHandoff(t) {
  const storageRoot = await root(t), destinationRoot = await root(t);
  const first = await registration(storageRoot);
  const source = { storageRoot, registrationId: first.registrationId };
  const destination = { storageRoot: destinationRoot, registrationId: first.registrationId };
  const enabled = await setPlanEnabled(source, { enabled: true, expectedGeneration: first.generation });
  const target = await ensureSiwcHost({ storageRoot: destinationRoot, runtimeId: 'remote' });
  const prepared = await prepareAuthHandoff(source, {
    expectedGeneration: enabled.generation, target, backgroundConsent: false,
  });
  const pending = await readPendingAuthHandoff(source);
  const contents = await readAuthHandoff(source, { handoffId: prepared.handoffId, expectedGeneration: enabled.generation });
  return { source, destination, target, prepared, pending, contents, expectedGeneration: enabled.generation };
}

function guardedReadOnlyFileSystem() {
  const writes = [];
  const fileSystem = { ...fs };
  for (const method of ['mkdir', 'rename', 'rm', 'rmdir', 'writeFile', 'chmod', 'chown']) {
    fileSystem[method] = async () => { writes.push(method); throw new Error('Read-only operation attempted a write.'); };
  }
  fileSystem.open = async (path, flags, ...rest) => {
    if (flags !== 'r') { writes.push('open'); throw new Error('Read-only operation attempted a write.'); }
    return fs.open(path, flags, ...rest);
  };
  return { fileSystem, writes };
}

async function crashWhileHoldingLock(lockPath, namespaceIdentity = '', acquiredAt = null) {
  const probe = `
    import * as fileSystem from 'node:fs/promises';
    const { acquireLocalIntegrationLifecycleLock } = await import(process.argv[1]);
    await acquireLocalIntegrationLifecycleLock({ fileSystem, lockPath: process.argv[2], reclaimIncomplete: false, atomicPublication: true,
      getPidNamespaceIdentity: process.argv[3] ? async () => process.argv[3] : undefined,
      leaseNow: process.argv[4] ? () => Number(process.argv[4]) : undefined });
    process.stdout.write('claimed');
    process.exit(0);
  `;
  const { stdout } = await execFileAsync(process.execPath, [
    '--input-type=module', '-e', probe,
    new URL('../src/services/local-integration-lifecycle-lock.js', import.meta.url).href,
    lockPath, namespaceIdentity, acquiredAt === null ? '' : String(acquiredAt),
  ], { cwd: fileURLToPath(new URL('..', import.meta.url)), timeout: 10000 });
  assert.equal(stdout, 'claimed');
}

test('host storage ignores personal Codex credentials and requires an absolute managed root', async t => {
  const homeDirectory = await root(t);
  assert.equal(resolveSiwcStorageRoot({ env: { CODEX_HOME: join(homeDirectory, '.codex') }, homeDirectory }),
    join(homeDirectory, '.n8n-openai-oauth'));
  const configured = join(homeDirectory, 'dedicated');
  assert.equal(resolveSiwcStorageRoot({ env: { N8N_OPENAI_OAUTH_HOME: configured }, homeDirectory }), configured);
  assert.throws(() => resolveSiwcStorageRoot({ env: { N8N_OPENAI_OAUTH_HOME: '../personal' }, homeDirectory }), TypeError);
  await assert.rejects(readRegistration({ storageRoot: configured, registrationId: '../auth' }), TypeError);
  await assert.rejects(fs.access(configured), { code: 'ENOENT' });
});

test('account selection and first plan acknowledgment retain separate verified registrations', async t => {
  const storageRoot = await root(t);
  assert.equal(await getSelectedRegistration({ storageRoot }), null);
  const a = await registration(storageRoot);
  const b = await registration(storageRoot, 'second');
  assert.notEqual(a.registrationId, b.registrationId);
  assert.equal(a.email, b.email);
  await selectRegistration({ storageRoot, registrationId: b.registrationId });
  assert.equal(await getSelectedRegistration({ storageRoot }), b.registrationId);
  assert.equal((await readRegistration({ storageRoot, registrationId: b.registrationId })).session.earliestRefreshAt,
    'opaque-provider-hint');
  await assert.rejects(setPlanEnabled({ storageRoot, registrationId: a.registrationId }, { enabled: true, expectedGeneration: b.generation }));
  const enabled = await setPlanEnabled({ storageRoot, registrationId: b.registrationId }, { enabled: true, expectedGeneration: b.generation });
  assert.equal(enabled.needsPlanWelcome, true);
  await assert.rejects(acknowledgePlanUse({ storageRoot, registrationId: b.registrationId }, { expectedGeneration: b.generation }));
  const acknowledged = await acknowledgePlanUse({ storageRoot, registrationId: b.registrationId }, { expectedGeneration: enabled.generation });
  assert.equal(acknowledged.needsPlanWelcome, false);
  assert.equal(JSON.stringify(await listRegistrations({ storageRoot })).includes('private-'), false);
});

test('one issued client cannot be duplicated under a new ID or linked by email', async t => {
  const storageRoot = await root(t);
  const first = await registration(storageRoot);
  await assert.rejects(commitAuthorization({ storageRoot, clientId: 'oaiapp_first', runtimeId: 'local',
    identity: { issuer: discovery.issuer, subject: 'another-subject', email: 'same@example.test' },
    tokens: tokens('duplicate') }));
  const accounts = await listRegistrations({ storageRoot });
  assert.equal(accounts.length, 1);
  assert.equal(accounts[0].registrationId, first.registrationId);
  assert.equal((await readRegistration({ storageRoot, registrationId: first.registrationId })).identity.subject, 'subject-first');
});

test('registration lock serializes rotating refresh and rejects foreign owners', async t => {
  const storageRoot = await root(t);
  const first = await registration(storageRoot);
  const enabled = await setPlanEnabled({ storageRoot, registrationId: first.registrationId }, { enabled: true, expectedGeneration: first.generation });
  let refreshes = 0;
  const fetchImpl = async (url, options) => {
    if (url.endsWith('/openid-configuration')) return Response.json(discovery);
    assert.equal(url, discovery.token_endpoint);
    assert.equal(options.body.get('refresh_token'), 'private-refresh-first');
    assert.equal(options.body.get('client_id'), 'oaiapp_first');
    assert.equal(options.body.get('scope'), null);
    refreshes++;
    await new Promise(done => setTimeout(done, 30));
    return Response.json({ ...tokens('rotated'), id_token: undefined });
  };
  const request = () => getAccessToken({ storageRoot, registrationId: first.registrationId },
    { runtimeId: 'local', minValidityMs: 1000 }, { now: () => 1700003600000, fetchImpl });
  const [a, b] = await Promise.all([request(), request()]);
  assert.equal(refreshes, 1);
  assert.equal(a.accessToken, 'private-access-rotated');
  assert.equal(b.accessToken, a.accessToken);
  assert.notEqual(a.generation, enabled.generation);
  await assert.rejects(getAccessToken({ storageRoot, registrationId: first.registrationId }, { runtimeId: 'other' }),
    error => error.recovery === 'resolve-handoff');
});

test('a crashed lock owner is reclaimed before token use without restoring or replaying credentials', async t => {
  const storageRoot = await root(t);
  const first = await registration(storageRoot);
  const source = { storageRoot, registrationId: first.registrationId };
  await setPlanEnabled(source, { enabled: true, expectedGeneration: first.generation });
  const lockPath = join(storageRoot, 'registrations', `${first.registrationId}.lock`);
  await crashWhileHoldingLock(lockPath);
  const owner = JSON.parse(await fs.readFile(lockPath, 'utf8'));
  assert.notEqual(owner.pid, process.pid);
  assert.equal(typeof owner.processStartIdentity, 'string');
  assert.equal(typeof owner.token, 'string');
  const lease = await getAccessToken(source, { runtimeId: 'local' }, {
    now: () => 1700000000000,
    fetchImpl: async () => { throw new Error('Valid access must not trigger a provider request.'); },
  });
  assert.equal(lease.accessToken, 'private-access-first');
  await assert.rejects(fs.access(lockPath), { code: 'ENOENT' });
  assert.equal((await readRegistration(source)).session.refreshToken, 'private-refresh-first');
});

test('PID reuse reclaims only the lock whose published start identity differs', async t => {
  const storageRoot = await root(t);
  const first = await registration(storageRoot);
  const source = { storageRoot, registrationId: first.registrationId };
  const lockPath = join(storageRoot, 'registrations', `${first.registrationId}.lock`);
  await crashWhileHoldingLock(lockPath);
  const owner = JSON.parse(await fs.readFile(lockPath, 'utf8'));
  let inspectedOwner = false;
  const changed = await setPlanEnabled(source, { enabled: true, expectedGeneration: first.generation }, {
    getProcessIdentity: async pid => {
      if (pid === owner.pid) inspectedOwner = true;
      return { state: 'active', startIdentity: pid === process.pid ? 'fixture-current-process' : 'fixture-reused-pid' };
    },
  });
  assert.equal(inspectedOwner, true);
  assert.equal(changed.planEnabled, true);
  await assert.rejects(fs.access(lockPath), { code: 'ENOENT' });
});

test('live lock ownership is retained and contention reaches the sidecar as retry-later 503', async t => {
  const storageRoot = await root(t);
  const first = await registration(storageRoot);
  const source = { storageRoot, registrationId: first.registrationId };
  await setPlanEnabled(source, { enabled: true, expectedGeneration: first.generation });
  const lockPath = join(storageRoot, 'registrations', `${first.registrationId}.lock`);
  const release = await acquireLocalIntegrationLifecycleLock({ fileSystem: fs, lockPath, reclaimIncomplete: false, atomicPublication: true });
  try {
    const ownerBytes = await fs.readFile(lockPath);
    const owner = JSON.parse(ownerBytes);
    let waits = 0, providerCalls = 0;
    let clock = 1000;
    const deps = {
      getProcessIdentity: async pid => {
        assert.equal(pid, process.pid);
        return { state: 'active', startIdentity: owner.processStartIdentity };
      },
      monotonicNow: () => clock,
      waitForLock: async () => { waits++; clock += SIWC_LOCK_WAIT_TIMEOUT_MS; },
      fetchImpl: async () => { providerCalls++; throw new Error('Locked owner must not call the provider.'); },
    };
    await assert.rejects(getAccessToken(source, { runtimeId: 'local' }, deps), error => {
      assert.equal(error.status, 503);
      assert.equal(error.recovery, 'retry-later');
      assert.equal(error.code, 'siwc_lock_unavailable');
      return true;
    });
    const clientCredential = 'fixture-client-credential';
    const handler = createSidecarHandler({ registration: source, runtimeId: 'local',
      tokenVerifier: createHash('sha256').update(clientCredential).digest(),
      fetchImpl: deps.fetchImpl, getToken: (registration, options) => getAccessToken(registration, options, deps) });
    const response = await handler(new Request('http://127.0.0.1/v1/models', {
      headers: { host: '127.0.0.1', authorization: `Bearer ${clientCredential}` },
    }));
    assert.equal(response.status, 503);
    assert.equal((await response.json()).recovery, 'retry-later');
    assert.equal(providerCalls, 0);
    assert.ok(waits > 0);
    assert.deepEqual(await fs.readFile(lockPath), ownerBytes);
    assert.equal((await readRegistration(source)).session.refreshToken, 'private-refresh-first');
  } finally { await release(); }
});

test('missing, malformed and uncertain lock ownership is never reclaimed because of age', async t => {
  for (const kind of ['missing', 'malformed', 'ambiguous']) {
    const storageRoot = await root(t);
    const first = await registration(storageRoot);
    const source = { storageRoot, registrationId: first.registrationId };
    const lockPath = join(storageRoot, 'registrations', `${first.registrationId}.lock`);
    let ownerPid;
    if (kind === 'ambiguous') {
      await crashWhileHoldingLock(lockPath);
      ownerPid = JSON.parse(await fs.readFile(lockPath, 'utf8')).pid;
    } else {
      await fs.mkdir(lockPath, { mode: 0o700 });
      if (kind === 'malformed') await fs.writeFile(join(lockPath, '.owner.json'), '{broken', { mode: 0o600 });
    }
    const old = new Date(Date.now() - 600000);
    await fs.utimes(lockPath, old, old);
    const ownerPath = kind === 'ambiguous' ? lockPath : join(lockPath, '.owner.json');
    if (kind === 'malformed') await fs.utimes(ownerPath, old, old);
    const before = kind === 'ambiguous' ? null : await fs.readdir(lockPath);
    const ownerBytes = kind === 'missing' ? null : await fs.readFile(ownerPath);
    let clock = 1000;
    await assert.rejects(setPlanEnabled(source, { enabled: true, expectedGeneration: first.generation }, {
      monotonicNow: () => clock, waitForLock: async () => { clock += SIWC_LOCK_WAIT_TIMEOUT_MS; },
      getProcessIdentity: async pid => pid === ownerPid ? { state: 'ambiguous' }
        : { state: 'active', startIdentity: 'fixture-current-process' },
    }), error => error.status === 503 && error.recovery === 'retry-later');
    if (before) assert.deepEqual(await fs.readdir(lockPath), before);
    if (ownerBytes) assert.deepEqual(await fs.readFile(ownerPath), ownerBytes);
    assert.equal((await readRegistration(source)).generation, first.generation);
  }
});

// PID-namespace leases only arise when Linux containers share one SIWC store. These
// tests run that logic as platform 'linux', whose POSIX mode checks cannot pass on NTFS.
const linuxNamespaceSkip = process.platform === 'win32' &&
  'Linux PID-namespace leases exist only in container storage; NTFS has no POSIX modes';

test('young foreign PID namespaces keep an absent or reused-looking owner frozen until its lease expires', { skip: linuxNamespaceSkip }, async t => {
  const bootId = '12345678-1234-1234-1234-123456789abc';
  const foreignNamespace = `linux:${bootId}:pid:4026532001`;
  const localNamespace = `linux:${bootId}:pid:4026532002`;
  for (const observed of ['dead', 'reused', 'namespace-unavailable']) {
    const storageRoot = await root(t);
    const first = await registration(storageRoot);
    const source = { storageRoot, registrationId: first.registrationId };
    const enabled = await setPlanEnabled(source, { enabled: true, expectedGeneration: first.generation });
    const lockPath = join(storageRoot, 'registrations', `${first.registrationId}.lock`);
    await crashWhileHoldingLock(lockPath, foreignNamespace);
    const ownerBytes = await fs.readFile(lockPath);
    const owner = JSON.parse(ownerBytes);
    assert.equal(owner.processNamespaceIdentity, foreignNamespace);
    let clock = owner.acquiredAt + 1;
    let foreignPidProbes = 0, providerCalls = 0;
    await assert.rejects(getAccessToken(source, { runtimeId: 'local' }, {
      platform: 'linux', monotonicNow: () => clock,
      waitForLock: async () => { clock += SIWC_LOCK_WAIT_TIMEOUT_MS; },
      getPidNamespaceIdentity: async () => observed === 'namespace-unavailable' ? null : localNamespace,
      getProcessIdentity: async pid => {
        if (pid === process.pid) return { state: 'active', startIdentity: 'fixture-current-process' };
        assert.equal(pid, owner.pid);
        foreignPidProbes++;
        return observed === 'dead' ? { state: 'dead' }
          : { state: 'active', startIdentity: 'fixture-unrelated-process-in-local-namespace' };
      },
      fetchImpl: async () => { providerCalls++; throw new Error('Foreign lock must block provider requests.'); },
    }), error => error.status === 503 && error.recovery === 'retry-later');
    assert.equal(foreignPidProbes, 0);
    assert.equal(providerCalls, 0);
    assert.deepEqual(await fs.readFile(lockPath), ownerBytes);
    assert.equal((await fs.lstat(lockPath)).isFile(), true);
    assert.equal((await readRegistration(source)).generation, enabled.generation);
    assert.equal((await readRegistration(source)).session.refreshToken, 'private-refresh-first');
  }
});

test('an expired foreign namespace lease is reclaimed before a healthy refresh', { skip: linuxNamespaceSkip }, async t => {
  const storageRoot = await root(t);
  const first = await registration(storageRoot);
  const source = { storageRoot, registrationId: first.registrationId };
  await setPlanEnabled(source, { enabled: true, expectedGeneration: first.generation });
  const boot = '12345678-1234-1234-1234-123456789abc';
  const lockPath = join(storageRoot, 'registrations', `${first.registrationId}.lock`);
  await crashWhileHoldingLock(lockPath, `linux:${boot}:pid:4026532001`, 1000);
  const clock = 1000 + SIWC_LOCK_LEASE_MS + 1;
  let posts = 0;
  const lease = await getAccessToken(source, { runtimeId: 'local' }, {
    platform: 'linux', monotonicNow: () => clock, now: () => 1700003600000,
    getPidNamespaceIdentity: async () => `linux:${boot}:pid:4026532002`,
    getProcessIdentity: async pid => {
      assert.equal(pid, process.pid);
      return { state: 'active', startIdentity: 'fixture-current-process' };
    },
    fetchImpl: async (url, options) => {
      if (url.endsWith('/openid-configuration')) return Response.json(discovery);
      assert.equal(url, discovery.token_endpoint);
      const frozen = await readRegistration(source);
      assert.equal(frozen.session.refreshUncertain, true);
      assert.equal(frozen.planEnabled, false);
      assert.equal(options.body.get('refresh_token'), 'private-refresh-first');
      posts++;
      return Response.json({ ...tokens('lease-recovered'), id_token: undefined });
    },
  });
  assert.equal(posts, 1);
  assert.equal(lease.accessToken, 'private-access-lease-recovered');
  await assert.rejects(fs.access(lockPath), { code: 'ENOENT' });
});

test('expired foreign lease recovery never replays a refresh whose freeze was persisted before a crash', { skip: linuxNamespaceSkip }, async t => {
  const storageRoot = await root(t);
  const first = await registration(storageRoot);
  const source = { storageRoot, registrationId: first.registrationId };
  await setPlanEnabled(source, { enabled: true, expectedGeneration: first.generation });
  const boot = '12345678-1234-1234-1234-123456789abc';
  const probe = `
    const { getAccessToken } = await import(process.argv[1]);
    const registration = JSON.parse(process.argv[2]);
    const discovery = JSON.parse(process.argv[3]);
    await getAccessToken(registration, { runtimeId: 'local' }, {
      monotonicNow: () => 1000, now: () => 1700003600000,
      getPidNamespaceIdentity: async () => process.argv[4],
      fetchImpl: async url => {
        if (url.endsWith('/openid-configuration')) return Response.json(discovery);
        process.stdout.write('frozen-before-post');
        process.exit(0);
      },
    });
  `;
  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', probe,
    new URL('../src/services/siwc-session.mjs', import.meta.url).href,
    JSON.stringify(source), JSON.stringify(discovery), `linux:${boot}:pid:4026532001`,
  ], { cwd: fileURLToPath(new URL('..', import.meta.url)), timeout: 10000 });
  assert.equal(stdout, 'frozen-before-post');
  const frozen = await readRegistration(source);
  assert.equal(frozen.session.refreshUncertain, true);
  let requests = 0;
  await assert.rejects(getAccessToken(source, { runtimeId: 'local' }, {
    platform: 'linux', monotonicNow: () => 1000 + SIWC_LOCK_LEASE_MS + 1,
    getPidNamespaceIdentity: async () => `linux:${boot}:pid:4026532002`,
    getProcessIdentity: async () => ({ state: 'active', startIdentity: 'fixture-current-process' }),
    fetchImpl: async () => { requests++; throw new Error('Frozen refresh must not be replayed.'); },
  }), error => error.recovery === 'reauthorize');
  assert.equal(requests, 0);
  assert.deepEqual(await readRegistration(source), frozen);
  await assert.rejects(fs.access(join(storageRoot, 'registrations', `${first.registrationId}.lock`)), { code: 'ENOENT' });
});

test('a monotonic deadline passed during discovery performs no token POST or record commit', async t => {
  const storageRoot = await root(t);
  const first = await registration(storageRoot);
  const source = { storageRoot, registrationId: first.registrationId };
  await setPlanEnabled(source, { enabled: true, expectedGeneration: first.generation });
  const before = await readRegistration(source);
  let clock = 1000, posts = 0, commits = 0;
  await assert.rejects(getAccessToken(source, { runtimeId: 'local' }, {
    monotonicNow: () => clock, now: () => 1700003600000,
    fileSystem: { ...fs, async rename(from, to) {
      if (to === join(storageRoot, 'registrations', `${first.registrationId}.json`)) commits++;
      return fs.rename(from, to);
    } },
    fetchImpl: async (url, options) => {
      assert.ok(options.signal instanceof AbortSignal);
      if (url.endsWith('/openid-configuration')) {
        clock += SIWC_LOCK_OPERATION_TIMEOUT_MS;
        return Response.json(discovery);
      }
      posts++;
      throw new Error('Expired holder must not POST.');
    },
  }), error => error.code === 'siwc_lock_deadline');
  assert.equal(posts, 0);
  assert.equal(commits, 0);
  await getAccessToken(source, { runtimeId: 'local' }, {
    now: () => 1700000000000, fetchImpl: async () => { throw new Error('Valid access must not refresh.'); },
  });
  assert.deepEqual(await readRegistration(source), before);
  await assert.rejects(fs.access(join(storageRoot, 'registrations', `${first.registrationId}.lock`)), { code: 'ENOENT' });
});

test('a holder delayed after the refresh freeze is fenced before token POST', async t => {
  const storageRoot = await root(t);
  const first = await registration(storageRoot);
  const source = { storageRoot, registrationId: first.registrationId };
  await setPlanEnabled(source, { enabled: true, expectedGeneration: first.generation });
  let clock = 1000, commits = 0, posts = 0;
  await assert.rejects(getAccessToken(source, { runtimeId: 'local' }, {
    monotonicNow: () => clock, now: () => 1700003600000,
    fileSystem: { ...fs, async rename(from, to) {
      await fs.rename(from, to);
      if (to === join(storageRoot, 'registrations', `${first.registrationId}.json`)) {
        commits++;
        clock += SIWC_LOCK_OPERATION_TIMEOUT_MS;
      }
    } },
    fetchImpl: async url => {
      if (url.endsWith('/openid-configuration')) return Response.json(discovery);
      posts++;
      throw new Error('Expired holder must not POST.');
    },
  }), error => error.code === 'siwc_lock_deadline');
  assert.equal(posts, 0);
  assert.equal(commits, 1);
  assert.equal((await readRegistration(source)).session.refreshUncertain, true);
  // The deadline rejects the caller before the fenced holder settles; a waiting caller proves its lock is released.
  await assert.rejects(getAccessToken(source, { runtimeId: 'local' }, {
    fetchImpl: async () => { throw new Error('Frozen refresh must not replay.'); },
  }), error => error.recovery === 'reauthorize');
  await assert.rejects(fs.access(join(storageRoot, 'registrations', `${first.registrationId}.lock`)), { code: 'ENOENT' });
});

test('a monotonic deadline passed immediately before rename leaves the previous record intact', async t => {
  const storageRoot = await root(t);
  const first = await registration(storageRoot);
  const source = { storageRoot, registrationId: first.registrationId };
  const recordPath = join(storageRoot, 'registrations', `${first.registrationId}.json`);
  const before = await fs.readFile(recordPath);
  let clock = 1000, staged = false, commits = 0;
  await assert.rejects(setPlanEnabled(source, { enabled: true, expectedGeneration: first.generation }, {
    monotonicNow: () => clock,
    fileSystem: { ...fs,
      async open(path, flags, ...args) {
        if (flags === 'wx' && path.startsWith(`${recordPath}.`)) staged = true;
        return fs.open(path, flags, ...args);
      },
      async lstat(path) {
        const stat = await fs.lstat(path);
        if (staged && path === recordPath) clock += SIWC_LOCK_OPERATION_TIMEOUT_MS;
        return stat;
      },
      async rename(from, to) {
        if (to === recordPath) commits++;
        return fs.rename(from, to);
      },
    },
  }), error => error.code === 'siwc_lock_deadline');
  assert.equal(commits, 0);
  assert.deepEqual(await fs.readFile(recordPath), before);
  // The fenced holder settles after its caller; the intact record stays usable once its lock is released.
  await setPlanEnabled(source, { enabled: true, expectedGeneration: first.generation });
  await assert.rejects(fs.access(join(storageRoot, 'registrations', `${first.registrationId}.lock`)), { code: 'ENOENT' });
});

test('a paused atomic publication cannot restart the holder deadline before token work', async t => {
  const storageRoot = await root(t);
  const first = await registration(storageRoot);
  const source = { storageRoot, registrationId: first.registrationId };
  await setPlanEnabled(source, { enabled: true, expectedGeneration: first.generation });
  const before = await readRegistration(source);
  const lockPath = join(storageRoot, 'registrations', `${first.registrationId}.lock`);
  const recordPath = join(storageRoot, 'registrations', `${first.registrationId}.json`);
  let clock = 1000, requests = 0, commits = 0;
  await assert.rejects(getAccessToken(source, { runtimeId: 'local' }, {
    monotonicNow: () => clock, now: () => 1700003600000,
    fileSystem: { ...fs,
      async link(from, to) {
        await fs.link(from, to);
        if (to === lockPath) clock += SIWC_LOCK_OPERATION_TIMEOUT_MS;
      },
      async rename(from, to) {
        if (to === recordPath) commits++;
        return fs.rename(from, to);
      },
    },
    fetchImpl: async () => { requests++; throw new Error('Expired publication must not perform token work.'); },
  }), error => error.code === 'siwc_lock_deadline');
  assert.equal(requests, 0);
  assert.equal(commits, 0);
  await getAccessToken(source, { runtimeId: 'local' }, {
    now: () => 1700000000000, fetchImpl: async () => { throw new Error('Valid access must not refresh.'); },
  });
  assert.deepEqual(await readRegistration(source), before);
  await assert.rejects(fs.access(lockPath), { code: 'ENOENT' });
});

test('overall timeout keeps an ignored operation locked until it settles and fences its late response', async t => {
  const storageRoot = await root(t);
  const first = await registration(storageRoot);
  const source = { storageRoot, registrationId: first.registrationId };
  await setPlanEnabled(source, { enabled: true, expectedGeneration: first.generation });
  let entered, respond, expire, requestSignal, clock = 1000, lateCommits = 0;
  const reached = new Promise(resolve => { entered = resolve; });
  const response = new Promise(resolve => { respond = resolve; });
  const operation = getAccessToken(source, { runtimeId: 'local' }, {
    monotonicNow: () => clock, now: () => 1700003600000,
    scheduleTimeout(callback, milliseconds) {
      assert.equal(milliseconds, SIWC_LOCK_OPERATION_TIMEOUT_MS);
      expire = callback;
      return callback;
    },
    cancelTimeout() {},
    fileSystem: { ...fs, async rename(from, to) {
      if (clock >= 1000 + SIWC_LOCK_OPERATION_TIMEOUT_MS &&
          to === join(storageRoot, 'registrations', `${first.registrationId}.json`)) lateCommits++;
      return fs.rename(from, to);
    } },
    fetchImpl: async (url, options) => {
      if (url.endsWith('/openid-configuration')) return Response.json(discovery);
      requestSignal = options.signal;
      entered();
      return response;
    },
  });
  await reached;
  const frozen = await readRegistration(source);
  assert.equal(frozen.session.refreshUncertain, true);
  clock += SIWC_LOCK_OPERATION_TIMEOUT_MS;
  expire();
  await assert.rejects(operation, error => error.code === 'siwc_lock_deadline');
  assert.equal(requestSignal.aborted, true);
  await fs.access(join(storageRoot, 'registrations', `${first.registrationId}.lock`));
  const nextRequest = getAccessToken(source, { runtimeId: 'local' }, {
    fetchImpl: async () => { throw new Error('Frozen refresh must not replay.'); },
  });
  respond(Response.json({ ...tokens('too-late'), id_token: undefined }));
  await assert.rejects(nextRequest, error => error.recovery === 'reauthorize');
  await assert.rejects(fs.access(join(storageRoot, 'registrations', `${first.registrationId}.lock`)), { code: 'ENOENT' });
  assert.equal(lateCommits, 0);
  assert.deepEqual(await readRegistration(source), frozen);
});

test('transient process identity unavailability waits and then succeeds without provider work', async t => {
  const storageRoot = await root(t);
  const first = await registration(storageRoot);
  const source = { storageRoot, registrationId: first.registrationId };
  await setPlanEnabled(source, { enabled: true, expectedGeneration: first.generation });
  let scans = 0, waits = 0, clock = 1000;
  const result = await getAccessToken(source, { runtimeId: 'local' }, {
    monotonicNow: () => clock, now: () => 1700000000000,
    getProcessIdentity: async () => ++scans === 1 ? { state: 'ambiguous' }
      : { state: 'active', startIdentity: 'fixture-current-process' },
    waitForLock: async () => { waits++; clock++; },
    fetchImpl: async () => { throw new Error('Valid access must not refresh.'); },
  });
  assert.ok(waits > 0);
  assert.equal(result.accessToken, 'private-access-first');
});

test('a lock disappearing during inspection is retried instead of failing live contention', async t => {
  const storageRoot = await root(t);
  const first = await registration(storageRoot);
  const source = { storageRoot, registrationId: first.registrationId };
  await setPlanEnabled(source, { enabled: true, expectedGeneration: first.generation });
  const lockPath = join(storageRoot, 'registrations', `${first.registrationId}.lock`);
  const release = await acquireLocalIntegrationLifecycleLock({ fileSystem: fs, lockPath, atomicPublication: true });
  let releaseDuringInspect = true;
  try {
    const result = await getAccessToken(source, { runtimeId: 'local' }, {
      now: () => 1700000000000, waitForLock: async () => {},
      fileSystem: { ...fs, async lstat(path) {
        if (path === lockPath && releaseDuringInspect) {
          releaseDuringInspect = false;
          await release();
        }
        return fs.lstat(path);
      } },
      fetchImpl: async () => { throw new Error('Valid access must not refresh.'); },
    });
    assert.equal(result.accessToken, 'private-access-first');
    assert.equal(releaseDuringInspect, false);
  } finally {
    if (releaseDuringInspect) await release();
  }
});

test('client cancellation while waiting for the owner performs no freeze or provider request', async t => {
  const storageRoot = await root(t);
  const first = await registration(storageRoot);
  const source = { storageRoot, registrationId: first.registrationId };
  await setPlanEnabled(source, { enabled: true, expectedGeneration: first.generation });
  const before = await readRegistration(source);
  const lockPath = join(storageRoot, 'registrations', `${first.registrationId}.lock`);
  const release = await acquireLocalIntegrationLifecycleLock({ fileSystem: fs, lockPath, atomicPublication: true });
  const caller = new AbortController(), reason = new Error('fixture caller cancelled');
  let requests = 0;
  try {
    await assert.rejects(getAccessToken(source, { runtimeId: 'local', signal: caller.signal }, {
      waitForLock: async () => { caller.abort(reason); },
      fetchImpl: async () => { requests++; throw new Error('Waiting must not reach the provider.'); },
    }), error => error === reason);
    assert.equal(requests, 0);
    assert.deepEqual(await readRegistration(source), before);
  } finally { await release(); }
});

test('client cancellation after the freeze but before POST restores the original session under the lock', async t => {
  const storageRoot = await root(t);
  const first = await registration(storageRoot);
  const source = { storageRoot, registrationId: first.registrationId };
  await setPlanEnabled(source, { enabled: true, expectedGeneration: first.generation });
  const before = await readRegistration(source);
  const recordPath = join(storageRoot, 'registrations', `${first.registrationId}.json`);
  const caller = new AbortController(), reason = new Error('fixture caller cancelled');
  let restored, posts = 0, cancelled = false;
  const restoration = new Promise(resolve => { restored = resolve; });
  const operation = getAccessToken(source, { runtimeId: 'local', signal: caller.signal }, {
    now: () => 1700003600000,
    fileSystem: { ...fs, async rename(from, to) {
      await fs.rename(from, to);
      if (to === recordPath) {
        const saved = JSON.parse(await fs.readFile(to, 'utf8'));
        if (!cancelled && saved.session.refreshUncertain) {
          cancelled = true;
          caller.abort(reason);
        } else if (cancelled && !saved.session.refreshUncertain) restored();
      }
    } },
    fetchImpl: async url => {
      if (url.endsWith('/openid-configuration')) return Response.json(discovery);
      posts++;
      throw new Error('Cancelled pre-POST operation must not send tokens.');
    },
  });
  await assert.rejects(operation, error => error === reason);
  await restoration;
  const saved = await readRegistration(source);
  assert.deepEqual(saved.session, before.session);
  assert.equal(saved.planEnabled, before.planEnabled);
  assert.equal(posts, 0);
  const next = await getAccessToken(source, { runtimeId: 'local' }, {
    now: () => 1700003600000, fetchImpl: async url => url.endsWith('/openid-configuration')
      ? Response.json(discovery) : Response.json({ ...tokens('after-cancellation'), id_token: undefined }),
  });
  assert.equal(next.accessToken, 'private-access-after-cancellation');
});

test('client cancellation during POST leaves the refresh running and saves the rotating replacement', async t => {
  const storageRoot = await root(t);
  const first = await registration(storageRoot);
  const source = { storageRoot, registrationId: first.registrationId };
  await setPlanEnabled(source, { enabled: true, expectedGeneration: first.generation });
  let entered, respond, waiterEntered, postSignal, posts = 0;
  const reached = new Promise(resolve => { entered = resolve; });
  const response = new Promise(resolve => { respond = resolve; });
  const waiterReached = new Promise(resolve => { waiterEntered = resolve; });
  const deps = { now: () => 1700003600000, fetchImpl: async (url, options) => {
    if (url.endsWith('/openid-configuration')) return Response.json(discovery);
    posts++;
    postSignal = options.signal;
    entered();
    return response;
  } };
  const caller = new AbortController(), reason = new Error('fixture caller cancelled');
  const operation = getAccessToken(source, { runtimeId: 'local', signal: caller.signal }, deps);
  await reached;
  caller.abort(reason);
  await assert.rejects(operation, error => error === reason);
  assert.equal(postSignal.aborted, false);
  const waiting = getAccessToken(source, { runtimeId: 'local' }, { ...deps,
    waitForLock: async ms => { waiterEntered(); await new Promise(resolve => setTimeout(resolve, ms)); },
  });
  await waiterReached;
  assert.equal(posts, 1);
  respond(Response.json({ ...tokens('completed-after-disconnect'), id_token: undefined }));
  const next = await waiting;
  assert.equal(next.accessToken, 'private-access-completed-after-disconnect');
  const saved = await readRegistration(source);
  assert.equal(saved.session.refreshToken, 'private-refresh-completed-after-disconnect');
  assert.equal(saved.session.refreshUncertain, undefined);
  assert.equal(saved.planEnabled, true);
  assert.equal(posts, 1);
});

test('a cancelled caller cannot release a freeze or candidate rename that is still in flight', async t => {
  for (const phase of ['freeze', 'candidate']) {
    const storageRoot = await root(t);
    const first = await registration(storageRoot);
    const source = { storageRoot, registrationId: first.registrationId };
    await setPlanEnabled(source, { enabled: true, expectedGeneration: first.generation });
    const recordPath = join(storageRoot, 'registrations', `${first.registrationId}.json`);
    let entered, resume, waiterEntered, held = false, posts = 0, waiterSettled = false;
    const reached = new Promise(resolve => { entered = resolve; });
    const renameGate = new Promise(resolve => { resume = resolve; });
    const waiterReached = new Promise(resolve => { waiterEntered = resolve; });
    const deps = { now: () => 1700003600000,
      fileSystem: { ...fs, async rename(from, to) {
        if (!held && to === recordPath) {
          const saved = JSON.parse(await fs.readFile(from, 'utf8'));
          const matches = phase === 'freeze' ? saved.session.refreshUncertain && !saved.session.verificationPending
            : saved.session.verificationPending;
          if (matches) { held = true; entered(); await renameGate; }
        }
        return fs.rename(from, to);
      } },
      fetchImpl: async url => {
        if (url.endsWith('/openid-configuration')) return Response.json(discovery);
        posts++;
        return Response.json({ ...tokens('rename-completed'), id_token: undefined });
      },
    };
    const caller = new AbortController(), reason = new Error('fixture caller cancelled');
    const operation = getAccessToken(source, { runtimeId: 'local', signal: caller.signal }, deps);
    await reached;
    caller.abort(reason);
    await assert.rejects(operation, error => error === reason);
    const waiting = getAccessToken(source, { runtimeId: 'local' }, { ...deps,
      waitForLock: async ms => { waiterEntered(); await new Promise(resolve => setTimeout(resolve, ms)); },
    });
    waiting.then(() => { waiterSettled = true; }, () => { waiterSettled = true; });
    await waiterReached;
    assert.equal(waiterSettled, false);
    resume();
    const next = await waiting;
    assert.equal(next.accessToken, 'private-access-rename-completed');
    assert.equal(posts, 1);
    assert.equal((await readRegistration(source)).session.refreshUncertain, undefined);
  }
});

test('sidecar quiesce cancels the client without cancelling its in-flight credential rotation', async t => {
  const storageRoot = await root(t);
  const first = await registration(storageRoot);
  const source = { storageRoot, registrationId: first.registrationId };
  await setPlanEnabled(source, { enabled: true, expectedGeneration: first.generation });
  let entered, respond, postSignal, posts = 0, closed = false;
  const reached = new Promise(resolve => { entered = resolve; });
  const response = new Promise(resolve => { respond = resolve; });
  const deps = { now: () => 1700003600000, fetchImpl: async (url, options) => {
    if (url.endsWith('/openid-configuration')) return Response.json(discovery);
    posts++;
    postSignal = options.signal;
    entered();
    return response;
  } };
  const clientCredential = 'fixture-quiesce-client';
  const server = createSidecarServer(createSidecarHandler({ registration: source, runtimeId: 'local',
    tokenVerifier: createHash('sha256').update(clientCredential).digest(),
    getToken: (registration, options) => getAccessToken(registration, options, deps),
    fetchImpl: async () => { throw new Error('Cancelled request must not reach the model catalog.'); },
  }));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const request = fetch(`http://127.0.0.1:${server.address().port}/v1/models`, {
      headers: { authorization: `Bearer ${clientCredential}` },
    });
    request.catch(() => {});
    await reached;
    await server.quiesce();
    closed = true;
    await assert.rejects(request);
    assert.equal(postSignal.aborted, false);
    const waiting = getAccessToken(source, { runtimeId: 'local' }, deps);
    respond(Response.json({ ...tokens('quiesce-completed'), id_token: undefined }));
    assert.equal((await waiting).accessToken, 'private-access-quiesce-completed');
    assert.equal(posts, 1);
    assert.equal((await readRegistration(source)).session.refreshUncertain, undefined);
  } finally {
    respond(Response.json({ ...tokens('quiesce-completed'), id_token: undefined }));
    if (!closed && server.listening) await server.quiesce();
  }
});

test('Linux PID namespace identity binds the namespace inode to the kernel boot and fails closed on unavailable metadata', async () => {
  const bootId = '12345678-1234-1234-1234-123456789abc';
  const readIdentity = async ({ namespaceLink = 'pid:[4026532001]', boot = `${bootId}\n` } = {}) =>
    getLocalPidNamespaceIdentity({ platform: 'linux', fileSystem: {
      async readlink(path) {
        assert.equal(path, '/proc/self/ns/pid');
        return namespaceLink;
      },
      async readFile(path, encoding) {
        assert.equal(path, '/proc/sys/kernel/random/boot_id');
        assert.equal(encoding, 'utf8');
        return boot;
      },
    } });
  const identity = await readIdentity();
  assert.equal(identity, `linux:${bootId}:pid:4026532001`);
  assert.notEqual(await readIdentity({ namespaceLink: 'pid:[4026532002]' }), identity);
  assert.notEqual(await readIdentity({ boot: '87654321-1234-1234-1234-123456789abc\n' }), identity);
  for (const invalid of [
    { namespaceLink: 'mnt:[4026532001]' }, { namespaceLink: 'pid:[0]' },
    { namespaceLink: 'pid:[1]\n' }, { namespaceLink: 'x'.repeat(65) },
    { boot: 'invalid' }, { boot: 'x'.repeat(65) },
  ]) assert.equal(await readIdentity(invalid), null);
  assert.equal(await getLocalPidNamespaceIdentity({ platform: 'linux', fileSystem: {
    async readlink() { throw Object.assign(new Error('proc unavailable'), { code: 'ENOENT' }); },
    async readFile() { return `${bootId}\n`; },
  } }), null);
  assert.equal(await getLocalPidNamespaceIdentity({ platform: 'linux', fileSystem: {} }), null);
  assert.equal(await getLocalPidNamespaceIdentity({ platform: 'unknown' }), null);
  const nativeIdentity = await getLocalPidNamespaceIdentity();
  assert.equal(typeof nativeIdentity, 'string');
  assert.equal(await getLocalPidNamespaceIdentity(), nativeIdentity);
});

test('a copied registration cannot refresh or appear connected on a different host', async t => {
  const storageRoot = await root(t), copiedRoot = await root(t);
  const first = await registration(storageRoot);
  await setPlanEnabled({ storageRoot, registrationId: first.registrationId }, {
    enabled: true, expectedGeneration: first.generation,
  });
  const originalHost = await readSiwcHost({ storageRoot, runtimeId: 'local' });
  const destinationHost = await ensureSiwcHost({ storageRoot: copiedRoot, runtimeId: 'local' });
  assert.notEqual(originalHost.hostId, destinationHost.hostId);
  const copiedPath = join(copiedRoot, 'registrations', `${first.registrationId}.json`);
  await fs.copyFile(join(storageRoot, 'registrations', `${first.registrationId}.json`), copiedPath);
  // A faithful copy is owner-only too; on Windows copyFile inherits the folder ACL instead.
  if (process.platform === 'win32') await lockDownLocalPath(copiedPath, { platform: 'win32', kind: 'file' });
  const copied = { storageRoot: copiedRoot, registrationId: first.registrationId };
  await assert.rejects(getAccessToken(copied, { runtimeId: 'local' }, {
    fetchImpl: async () => { throw new Error('Network must not be used.'); },
  }), error => error.recovery === 'resolve-handoff');
  assert.equal((await getAuthStatus({ ...copied, runtimeId: 'local' })).exists, false);
});

test('separate processes share one rotating refresh owner', async t => {
  for (let iteration = 0; iteration < 10; iteration++) {
    await t.test(`concurrent refresh ${iteration + 1}`, async subtest => {
      const storageRoot = await root(subtest);
      const first = await registration(storageRoot);
      await setPlanEnabled({ storageRoot, registrationId: first.registrationId }, {
        enabled: true, expectedGeneration: first.generation,
      });
      const logPath = join(storageRoot, 'refresh-count.txt');
      const worker = `
        import { appendFile } from 'node:fs/promises';
        const [moduleUrl, storageRoot, registrationId, logPath] = process.argv.slice(1);
        const { getAccessToken } = await import(moduleUrl);
        const discovery = {
          issuer: 'https://auth.openai.com',
          authorization_endpoint: 'https://auth.openai.com/api/accounts/authorize',
          token_endpoint: 'https://auth.openai.com/api/accounts/oauth/token',
          jwks_uri: 'https://auth.openai.com/.well-known/jwks.json'
        };
        const result = await getAccessToken({ storageRoot, registrationId }, { runtimeId: 'local', minValidityMs: 1000 }, {
          now: () => 1700003600000,
          fetchImpl: async (url, options) => {
            if (url.endsWith('/openid-configuration')) return Response.json(discovery);
            if (options.body.get('refresh_token') !== 'private-refresh-first') throw new Error('unexpected rotation');
            await appendFile(logPath, 'refresh\\n');
            await new Promise(done => setTimeout(done, 80));
            return Response.json({ access_token: 'private-access-rotated', refresh_token: 'private-refresh-rotated',
              expires_in: 3600, token_type: 'Bearer',
              scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct' });
          },
        });
        process.stdout.write(result.accessToken === 'private-access-rotated' ? 'ok' : 'wrong');
      `;
      const args = ['--input-type=module', '-e', worker,
        new URL('../src/services/siwc-session.mjs', import.meta.url).href,
        storageRoot, first.registrationId, logPath];
      const cwd = fileURLToPath(new URL('..', import.meta.url));
      const results = await Promise.all([0, 1].map(() => execFileAsync(process.execPath, args, {
        cwd, timeout: 30000,
      })));
      assert.deepEqual(results.map(result => result.stdout), ['ok', 'ok']);
      assert.equal((await fs.readFile(logPath, 'utf8')).match(/refresh/gu)?.length, 1);
    });
  }
});

test('post-rotation write, sync and rename failures never expose R0 to a fresh process', async t => {
  const moduleUrl = new URL('../src/services/siwc-session.mjs', import.meta.url).href;
  const cwd = fileURLToPath(new URL('..', import.meta.url));
  const probe = `
    const { getAccessToken } = await import(process.argv[1]);
    try {
      await getAccessToken({ storageRoot: process.argv[2], registrationId: process.argv[3] },
        { runtimeId: 'local' }, { fetchImpl: async () => { process.stdout.write('network'); throw new Error('forbidden'); } });
      process.stdout.write('leased');
    } catch (error) { process.stdout.write(error.recovery === 'reauthorize' ? 'blocked' : 'wrong'); }
  `;
  for (const failureAt of ['write', 'sync', 'rename']) {
    await t.test(failureAt, async subtest => {
      const storageRoot = await root(subtest);
      const first = await registration(storageRoot);
      await setPlanEnabled({ storageRoot, registrationId: first.registrationId }, {
        enabled: true, expectedGeneration: first.generation,
      });
      let posts = 0;
      const fileSystem = {
        ...fs,
        async open(path, flags, mode) {
          const handle = await fs.open(path, flags, mode);
          if (flags !== 'wx' || !path.includes(`${sep}registrations${sep}`)) return handle;
          let replacement = false;
          return {
            stat: () => handle.stat(), readFile: () => handle.readFile(), close: () => handle.close(),
            chmod: mode => handle.chmod(mode),
            async writeFile(value) {
              replacement = String(value).includes('private-access-rotated');
              if (replacement && failureAt === 'write') throw new Error('injected write failure');
              await handle.writeFile(value);
            },
            async sync() {
              if (replacement && failureAt === 'sync') throw new Error('injected sync failure');
              await handle.sync();
            },
          };
        },
        async rename(source, destination) {
          if (failureAt === 'rename' && destination.includes(`${sep}registrations${sep}`) && destination.endsWith('.json') &&
              (await fs.readFile(source, 'utf8')).includes('private-access-rotated'))
            throw new Error('injected rename failure');
          await fs.rename(source, destination);
        },
      };
      await assert.rejects(getAccessToken({ storageRoot, registrationId: first.registrationId },
        { runtimeId: 'local' }, {
          now: () => 1700003600000, fileSystem,
          fetchImpl: async url => {
            if (url.endsWith('/openid-configuration')) return Response.json(discovery);
            posts++;
            return Response.json({ ...tokens('rotated'), id_token: undefined });
          },
        }));
      assert.equal(posts, 1);
      const frozen = await readRegistration({ storageRoot, registrationId: first.registrationId });
      assert.equal(frozen.session.refreshUncertain, true);
      assert.equal(frozen.planEnabled, false);
      const { stdout } = await execFileAsync(process.execPath,
        ['--input-type=module', '-e', probe, moduleUrl, storageRoot, first.registrationId],
        { cwd, timeout: 10000 });
      assert.equal(stdout, 'blocked');
    });
  }
});

test('a replacement that becomes shorter than the requested lease remains frozen', async t => {
  const storageRoot = await root(t);
  const first = await registration(storageRoot);
  await setPlanEnabled({ storageRoot, registrationId: first.registrationId }, {
    enabled: true, expectedGeneration: first.generation,
  });
  let now = 1700003600000;
  let posts = 0;
  const fileSystem = {
    ...fs,
    async rename(source, destination) {
      if (destination.includes(`${sep}registrations${sep}`) && destination.endsWith('.json') &&
          (await fs.readFile(source, 'utf8')).includes('private-access-rotated'))
        now += 2000;
      await fs.rename(source, destination);
    },
  };
  const registrationRef = { storageRoot, registrationId: first.registrationId };
  await assert.rejects(getAccessToken(registrationRef, { runtimeId: 'local', minValidityMs: 60000 }, {
    now: () => now, fileSystem,
    fetchImpl: async url => {
      if (url.endsWith('/openid-configuration')) return Response.json(discovery);
      posts++;
      return Response.json({ ...tokens('rotated'), id_token: undefined, expires_in: 61 });
    },
  }), error => error.recovery === 'reauthorize');
  assert.equal(posts, 1);
  const frozen = await readRegistration(registrationRef);
  assert.equal(frozen.session.refreshToken, 'private-refresh-rotated');
  assert.equal(frozen.session.refreshUncertain, true);
  assert.equal(frozen.planEnabled, false);
  await assert.rejects(getAccessToken(registrationRef, { runtimeId: 'local' }, {
    fetchImpl: async () => { throw new Error('must not refresh again'); },
  }), error => error.recovery === 'reauthorize');
});

test('definite temporary 503 restores retryable R0 and a later healthy refresh succeeds', async t => {
  const storageRoot = await root(t);
  const first = await registration(storageRoot);
  await setPlanEnabled({ storageRoot, registrationId: first.registrationId }, { enabled: true, expectedGeneration: first.generation });
  const registrationRef = { storageRoot, registrationId: first.registrationId };
  let posts = 0;
  await assert.rejects(getAccessToken(registrationRef, { runtimeId: 'local' }, {
    now: () => 1700003600000,
    fetchImpl: async url => {
      if (url.endsWith('/openid-configuration')) return Response.json(discovery);
      posts++;
      return Response.json({ error: 'temporarily_unavailable' }, { status: 503 });
    },
  }), error => error.recovery === 'retry-later');
  const retryable = await readRegistration(registrationRef);
  assert.equal(retryable.session.refreshToken, 'private-refresh-first');
  assert.equal(retryable.session.refreshUncertain, undefined);
  assert.equal(retryable.planEnabled, true);
  const lease = await getAccessToken(registrationRef, { runtimeId: 'local' }, {
    now: () => 1700003600000,
    fetchImpl: async (url, options) => {
      if (url.endsWith('/openid-configuration')) return Response.json(discovery);
      posts++;
      assert.equal(options.body.get('refresh_token'), 'private-refresh-first');
      return Response.json({ ...tokens('rotated'), id_token: undefined });
    },
  });
  assert.equal(posts, 2);
  assert.equal(lease.accessToken, 'private-access-rotated');
  assert.equal((await readRegistration(registrationRef)).session.refreshToken, 'private-refresh-rotated');
});

test('terminal invalid_grant clears unusable tokens while retaining registration identity', async t => {
  const storageRoot = await root(t);
  const first = await registration(storageRoot);
  await setPlanEnabled({ storageRoot, registrationId: first.registrationId }, { enabled: true, expectedGeneration: first.generation });
  await assert.rejects(getAccessToken({ storageRoot, registrationId: first.registrationId },
    { runtimeId: 'local' }, { now: () => 1700003600000, fetchImpl: async url =>
      url.endsWith('/openid-configuration') ? Response.json(discovery) :
        Response.json({ error: 'invalid_grant' }, { status: 400 }) }), error => error.recovery === 'reauthorize');
  const saved = await readRegistration({ storageRoot, registrationId: first.registrationId });
  assert.equal(saved.clientId, 'oaiapp_first');
  assert.equal(saved.session.refreshToken, undefined);
  assert.equal((await listRegistrations({ storageRoot }))[0].session, 'reauthorize');
});

test('ambiguous network refresh preserves token bytes but freezes use until fresh sign-in', async t => {
  const storageRoot = await root(t);
  const first = await registration(storageRoot);
  await setPlanEnabled({ storageRoot, registrationId: first.registrationId }, {
    enabled: true, expectedGeneration: first.generation,
  });
  const registrationRef = { storageRoot, registrationId: first.registrationId };
  let writes = 0;
  const fileSystem = {
    ...fs,
    async rename(source, destination) {
      if (destination === join(storageRoot, 'registrations', `${first.registrationId}.json`)) {
        writes++;
        if (writes > 1) throw new Error('uncertainty persistence unavailable');
      }
      await fs.rename(source, destination);
    },
  };
  await assert.rejects(getAccessToken(registrationRef, { runtimeId: 'local' }, {
    now: () => 1700003600000, fileSystem,
    fetchImpl: async url => {
      if (url.endsWith('/openid-configuration')) return Response.json(discovery);
      const persisted = await readRegistration(registrationRef);
      assert.equal(persisted.session.refreshUncertain, true);
      assert.equal(persisted.planEnabled, false);
      throw new Error('connection lost after refresh was sent');
    },
  }), error => error.recovery === 'reauthorize');
  const frozen = await readRegistration(registrationRef);
  assert.equal(frozen.session.refreshToken, 'private-refresh-first');
  assert.equal(frozen.session.refreshUncertain, true);
  assert.equal(frozen.planEnabled, false);
  assert.equal(writes, 1);
  const probe = `
    const { getAccessToken } = await import(process.argv[1]);
    try {
      await getAccessToken({ storageRoot: process.argv[2], registrationId: process.argv[3] },
        { runtimeId: 'local' }, { fetchImpl: async () => { process.stdout.write('network'); throw Error('forbidden'); } });
      process.stdout.write('leased');
    } catch (error) { process.stdout.write(error.recovery === 'reauthorize' ? 'blocked' : 'wrong'); }
  `;
  const { stdout } = await execFileAsync(process.execPath,
    ['--input-type=module', '-e', probe, new URL('../src/services/siwc-session.mjs', import.meta.url).href,
      storageRoot, first.registrationId],
    { cwd: fileURLToPath(new URL('..', import.meta.url)), timeout: 10000 });
  assert.equal(stdout, 'blocked');
  assert.equal((await listRegistrations({ storageRoot }))[0].session, 'reauthorize');
  await assert.rejects(getAccessToken(registrationRef, { runtimeId: 'local' }, {
    fetchImpl: async () => { throw new Error('must not retry uncertain rotation'); },
  }), error => error.recovery === 'reauthorize');
  await assert.rejects(setPlanEnabled(registrationRef, { enabled: true, expectedGeneration: frozen.generation }));
  let revokedToken;
  const signedOut = await signOut(registrationRef, { runtimeId: 'local' }, {
    fetchImpl: async (url, options) => {
      if (url.endsWith('/openid-configuration')) return Response.json(discovery);
      revokedToken = options.body.get('token');
      return new Response(null, { status: 200 });
    },
  });
  assert.equal(revokedToken, 'private-refresh-first');
  assert.equal(signedOut.revocation, 'unconfirmed');
  assert.equal((await readRegistration(registrationRef)).session.refreshToken, undefined);
});

test('revocation uncertainty clears local credentials and preserves the issued client', async t => {
  const storageRoot = await root(t);
  const first = await registration(storageRoot);
  let revocations = 0;
  const result = await signOut({ storageRoot, registrationId: first.registrationId }, { runtimeId: 'local' }, {
    fetchImpl: async url => {
      if (url.endsWith('/openid-configuration')) return Response.json(discovery);
      revocations++;
      return Response.json({}, { status: 503 });
    },
  });
  assert.equal(result.revocation, 'unconfirmed');
  assert.equal(result.account.session, 'signed-out');
  assert.equal(revocations, 3);
  const saved = await readRegistration({ storageRoot, registrationId: first.registrationId });
  assert.equal(saved.clientId, 'oaiapp_first');
  assert.equal(saved.session.accessToken, undefined);
  assert.equal((await ensureSiwcHost({ storageRoot, runtimeId: 'local' })).hostId, saved.owner.hostId);
});

test('HTTP 200 revocation confirms remote sign-out while a repeated local sign-out has no token to revoke', async t => {
  const storageRoot = await root(t);
  const first = await registration(storageRoot);
  let revocations = 0;
  const fetchImpl = async (url, options) => {
    if (url.endsWith('/openid-configuration')) return Response.json(discovery);
    assert.equal(url, discovery.revocation_endpoint);
    assert.equal(options.body.get('client_id'), 'oaiapp_first');
    assert.equal(options.body.get('token'), 'private-refresh-first');
    revocations++;
    return new Response(null, { status: 200 });
  };
  const registrationRef = { storageRoot, registrationId: first.registrationId };
  const firstResult = await signOut(registrationRef, { runtimeId: 'local' }, { fetchImpl });
  assert.equal(firstResult.revocation, 'confirmed');
  const secondResult = await signOut(registrationRef, { runtimeId: 'local' }, { fetchImpl });
  assert.equal(secondResult.revocation, 'not-applicable');
  assert.equal(revocations, 1);
  assert.equal(secondResult.account.session, 'signed-out');
});

test('handoff freezes sender before export, attests destination, then clears only sender tokens', async t => {
  const storageRoot = await root(t), destinationRoot = await root(t);
  const first = await registration(storageRoot);
  await assert.rejects(prepareAuthHandoff({ storageRoot, registrationId: first.registrationId }, {
    expectedGeneration: first.generation, target: await ensureSiwcHost({ storageRoot: destinationRoot, runtimeId: 'remote' }), backgroundConsent: false,
  }));
  const enabled = await setPlanEnabled({ storageRoot, registrationId: first.registrationId }, { enabled: true, expectedGeneration: first.generation });
  const target = await ensureSiwcHost({ storageRoot: destinationRoot, runtimeId: 'remote' });
  const frozen = await prepareAuthHandoff({ storageRoot, registrationId: first.registrationId }, {
    expectedGeneration: enabled.generation, target, backgroundConsent: false,
  });
  await assert.rejects(getAccessToken({ storageRoot, registrationId: first.registrationId }, { runtimeId: 'local' }),
    error => error.recovery === 'resolve-handoff');
  const contents = await readAuthHandoff({ storageRoot, registrationId: first.registrationId }, {
    handoffId: frozen.handoffId, expectedGeneration: enabled.generation,
  });
  await assert.rejects(readAuthHandoff({ storageRoot, registrationId: first.registrationId }, {
    handoffId: frozen.handoffId, expectedGeneration: enabled.generation,
  }));
  assert.notEqual((await readRegistration({ storageRoot, registrationId: first.registrationId })).generation, enabled.generation);
  await assert.rejects(acceptAuthHandoff({ storageRoot: destinationRoot, runtimeId: 'remote',
    expectedRegistrationId: first.registrationId,
    expectedTarget: { ...target, hostId: (await ensureSiwcHost({ storageRoot, runtimeId: 'local' })).hostId }, contents }));
  const accepted = await acceptAuthHandoff({ storageRoot: destinationRoot, runtimeId: 'remote',
    expectedRegistrationId: first.registrationId, expectedTarget: target, contents });
  await assert.rejects(finishAuthHandoff({ storageRoot, registrationId: first.registrationId }, {
    handoffId: frozen.handoffId, receipt: { ...accepted.receipt, proof: 'wrong' },
  }));
  assert.equal((await readRegistration({ storageRoot, registrationId: first.registrationId })).handoff.state, 'handoff-pending');
  const sender = await finishAuthHandoff({ storageRoot, registrationId: first.registrationId }, {
    handoffId: frozen.handoffId, receipt: accepted.receipt,
  });
  assert.equal(sender.ownership, 'transferred');
  assert.equal((await readRegistration({ storageRoot, registrationId: first.registrationId })).session.refreshToken, undefined);
  assert.equal((await readRegistration({ storageRoot: destinationRoot, registrationId: first.registrationId })).owner.hostId, target.hostId);
  await assert.rejects(acceptAuthHandoff({ storageRoot: destinationRoot, runtimeId: 'remote',
    expectedRegistrationId: first.registrationId, expectedTarget: target, contents }));
});

test('background consent is explicitly bound to the account and destination', async t => {
  const storageRoot = await root(t), destinationRoot = await root(t);
  const first = await registration(storageRoot);
  const enabled = await setPlanEnabled({ storageRoot, registrationId: first.registrationId }, {
    enabled: true, expectedGeneration: first.generation,
  });
  const target = await ensureSiwcHost({ storageRoot: destinationRoot, runtimeId: 'n8n' });
  await assert.rejects(prepareAuthHandoff({ storageRoot, registrationId: first.registrationId }, {
    expectedGeneration: enabled.generation, target, backgroundConsent: true,
  }), TypeError);
  const backgroundConsent = { acceptedAt: new Date().toISOString(), noticeVersion: 'siwc-local-2026-10-04' };
  const prepared = await prepareAuthHandoff({ storageRoot, registrationId: first.registrationId }, {
    expectedGeneration: enabled.generation, target, backgroundConsent,
  });
  assert.deepEqual(prepared.binding.backgroundConsent, backgroundConsent);
  assert.equal(prepared.binding.registrationId, first.registrationId);
  const contents = await readAuthHandoff({ storageRoot, registrationId: first.registrationId }, {
    handoffId: prepared.handoffId, expectedGeneration: enabled.generation,
  });
  const accepted = await acceptAuthHandoff({ storageRoot: destinationRoot, runtimeId: 'n8n',
    expectedRegistrationId: first.registrationId, expectedTarget: target, contents });
  assert.deepEqual(accepted.receipt.binding.backgroundConsent, backgroundConsent);
  assert.deepEqual((await readRegistration({ storageRoot: destinationRoot, registrationId: first.registrationId })).backgroundConsent,
    backgroundConsent);
});

test('VPS consent notice validates before effects and stays bound through handoff receipt', async t => {
  const storageRoot = await root(t), destinationRoot = await root(t);
  const consent = { acceptedAt: new Date().toISOString(), noticeVersion: 'siwc-vps-2026-10-04' };
  assert.equal(validateSiwcBackgroundConsent(consent, { target: 'vps-n8n' }), consent);
  assert.throws(() => validateSiwcBackgroundConsent(consent, { target: 'local-n8n' }), TypeError);
  assert.throws(() => validateSiwcBackgroundConsent({ ...consent, noticeVersion: 'unknown' }, { target: 'vps-n8n' }), TypeError);
  const first = await registration(storageRoot);
  const enabled = await setPlanEnabled({ storageRoot, registrationId: first.registrationId }, {
    enabled: true, expectedGeneration: first.generation,
  });
  const target = await ensureSiwcHost({ storageRoot: destinationRoot, runtimeId: 'vps' });
  const source = { storageRoot, registrationId: first.registrationId };
  const prepared = await prepareAuthHandoff(source, {
    expectedGeneration: enabled.generation, target, backgroundConsent: consent,
  });
  const contents = await readAuthHandoff(source, {
    handoffId: prepared.handoffId, expectedGeneration: enabled.generation,
  });
  const accepted = await acceptAuthHandoff({ storageRoot: destinationRoot, runtimeId: 'vps',
    expectedRegistrationId: first.registrationId, expectedTarget: target, contents });
  assert.deepEqual(accepted.receipt.binding.backgroundConsent, consent);
  const sender = await finishAuthHandoff(source, { handoffId: prepared.handoffId, receipt: accepted.receipt });
  assert.equal(sender.ownership, 'transferred');
  assert.equal((await readRegistration(source)).session.refreshToken, undefined);
  assert.deepEqual((await readRegistration({ storageRoot: destinationRoot, registrationId: first.registrationId })).backgroundConsent,
    consent);
});

test('malformed destination transfer never creates a host identity', async t => {
  const storageRoot = await root(t);
  const expectedTarget = { hostId: `urn:uuid:${randomUUID()}`, runtimeId: 'remote' };
  await assert.rejects(acceptAuthHandoff({ storageRoot, runtimeId: 'remote', expectedTarget,
    expectedRegistrationId: randomUUID(), contents: Buffer.from('invalid-transfer') }));
  await assert.rejects(fs.access(join(storageRoot, 'host.json')), { code: 'ENOENT' });
});

test('a valid B handoff cannot mutate an A-configured destination through acceptance or CLI', async t => {
  const f = await exportedHandoff(t);
  const a = await commitAuthorization({ storageRoot: f.destination.storageRoot,
    runtimeId: 'remote', clientId: 'oaiapp_destination_a',
    identity: { issuer: discovery.issuer, subject: 'destination-a' }, tokens: tokens('destination-a') });
  const hostBefore = await fs.readFile(join(f.destination.storageRoot, 'host.json'));
  const aPath = join(f.destination.storageRoot, 'registrations', `${a.registrationId}.json`);
  const aBefore = await fs.readFile(aPath);
  const guard = guardedReadOnlyFileSystem();
  const request = { storageRoot: f.destination.storageRoot, runtimeId: 'remote',
    expectedTarget: f.target, contents: f.contents };
  await assert.rejects(acceptAuthHandoff(request, guard), TypeError);
  await assert.rejects(acceptAuthHandoff({ ...request, expectedRegistrationId: a.registrationId }, guard));
  let output = '';
  await assert.rejects(runSiwcHandoffCli({ command: 'accept',
    storageRoot: f.destination.storageRoot, runtimeId: 'remote', registrationId: a.registrationId,
    input: [f.contents], output: { write(value) { output += value; } }, sessionDeps: guard }));
  assert.deepEqual(guard.writes, []);
  assert.equal(output, '');
  assert.deepEqual(await fs.readFile(join(f.destination.storageRoot, 'host.json')), hostBefore);
  assert.deepEqual(await fs.readFile(aPath), aBefore);
  await assert.rejects(fs.access(join(f.destination.storageRoot, 'registrations', `${f.source.registrationId}.json`)),
    { code: 'ENOENT' });
  const absentRoot = join(await root(t), 'absent');
  await assert.rejects(acceptAuthHandoff({ ...request, storageRoot: absentRoot,
    expectedRegistrationId: a.registrationId }, guard));
  await assert.rejects(fs.access(absentRoot), { code: 'ENOENT' });
});

test('lost acceptance and local finish acknowledgments recover after destination refresh and process restart', async t => {
  const f = await exportedHandoff(t);
  let committed, acceptanceWrites = 0;
  const fileSystem = { ...fs, async rename(source, destination) {
    if (destination === join(f.destination.storageRoot, 'registrations', `${f.source.registrationId}.json`)) {
      committed = JSON.parse(await fs.readFile(source, 'utf8'));
      acceptanceWrites++;
      await fs.rename(source, destination);
      throw new Error('Destination commit acknowledgment lost.');
    }
    return fs.rename(source, destination);
  } };
  await assert.rejects(acceptAuthHandoff({ storageRoot: f.destination.storageRoot, runtimeId: 'remote',
    expectedTarget: f.target, expectedRegistrationId: f.source.registrationId, contents: f.contents }, { fileSystem }));
  assert.equal(acceptanceWrites, 1);
  assert.equal((await readRegistration(f.destination)).session.refreshToken, 'private-refresh-first');
  assert.deepEqual(await readPendingAuthHandoff(f.source), f.pending);
  await assert.rejects(readAuthHandoff(f.source, {
    handoffId: f.prepared.handoffId, expectedGeneration: f.expectedGeneration,
  }));
  let refreshPosts = 0;
  await getAccessToken(f.destination, { runtimeId: 'remote' }, {
    now: () => 1700003600000, fetchImpl: async (url, options) => {
      if (url === `${discovery.issuer}/.well-known/openid-configuration`) return Response.json(discovery);
      assert.equal(url, discovery.token_endpoint);
      assert.equal(options.body.get('refresh_token'), 'private-refresh-first');
      refreshPosts++;
      return Response.json({ ...tokens('destination-rotated'), id_token: undefined });
    },
  });
  assert.equal(refreshPosts, 1);
  const current = await readRegistration(f.destination);
  assert.notEqual(current.generation, committed.generation);
  assert.deepEqual(current.acceptedHandoff, committed.acceptedHandoff);
  const selection = { runtimeId: 'remote', handoffId: f.pending.handoffId,
    expectedTarget: f.target, expectedBinding: f.pending.binding, identity: f.pending.identity };
  const probe = `
    const { readAuthHandoffReceipt } = await import(process.argv[1]);
    const receipt = await readAuthHandoffReceipt(JSON.parse(process.argv[2]), JSON.parse(process.argv[3]));
    process.stdout.write(JSON.stringify(receipt));
  `;
  const { stdout } = await execFileAsync(process.execPath, [
    '--input-type=module', '-e', probe, new URL('../src/services/siwc-session.mjs', import.meta.url).href,
    JSON.stringify(f.destination), JSON.stringify(selection),
  ], { cwd: fileURLToPath(new URL('..', import.meta.url)), timeout: 10000 });
  const recovered = JSON.parse(stdout);
  assert.deepEqual(recovered, committed.acceptedHandoff);
  assert.equal(stdout.includes('private-'), false);
  let finishWrites = 0;
  await assert.rejects(finishAuthHandoff(f.source, {
    handoffId: recovered.handoffId, receipt: recovered.receipt,
  }, { fileSystem: { ...fs, async rename(source, destination) {
    if (destination === join(f.source.storageRoot, 'registrations', `${f.source.registrationId}.json`)) {
      finishWrites++;
      await fs.rename(source, destination);
      throw new Error('Sender commit acknowledgment lost.');
    }
    return fs.rename(source, destination);
  } } }));
  const transferred = await readRegistration(f.source);
  assert.deepEqual(transferred.session, {});
  assert.equal(transferred.handoff.state, 'transferred');
  const finished = await finishAuthHandoff(f.source, { handoffId: recovered.handoffId, receipt: recovered.receipt });
  assert.equal(finished.ownership, 'transferred');
  assert.equal(finished.generation, transferred.generation);
  assert.equal(finishWrites, 1);
  assert.equal(await readPendingAuthHandoff(f.source), null);
  assert.equal((await readRegistration(f.destination)).session.refreshToken, 'private-refresh-destination-rotated');
  await assert.rejects(finishAuthHandoff(f.source, {
    handoffId: randomUUID(), receipt: recovered.receipt,
  }));
  await assert.rejects(finishAuthHandoff(f.source, {
    handoffId: recovered.handoffId, receipt: { ...recovered.receipt, proof: 'x'.repeat(43) },
  }));
});

test('receipt persists across plan toggles, sign-out and verified reauthorization and rejects every identity binding mismatch', async t => {
  const f = await exportedHandoff(t);
  const accepted = await acceptAuthHandoff({ storageRoot: f.destination.storageRoot, runtimeId: 'remote',
    expectedTarget: f.target, expectedRegistrationId: f.source.registrationId, contents: f.contents });
  const selection = { runtimeId: 'remote', handoffId: f.pending.handoffId,
    expectedTarget: f.target, expectedBinding: f.pending.binding, identity: f.pending.identity };
  let current = await readRegistration(f.destination);
  for (const enabled of [false, true]) {
    await setPlanEnabled(f.destination, { enabled, expectedGeneration: current.generation });
    current = await readRegistration(f.destination);
    assert.deepEqual(await readAuthHandoffReceipt(f.destination, selection), accepted);
  }
  const signedOut = await signOut(f.destination, { runtimeId: 'remote' }, {
    fetchImpl: async url => url.endsWith('/openid-configuration')
      ? Response.json(discovery) : new Response(null, { status: 200 }),
  });
  assert.deepEqual((await readRegistration(f.destination)).session, {});
  assert.deepEqual(await readAuthHandoffReceipt(f.destination, selection), accepted);
  await commitAuthorization({ ...f.destination, runtimeId: 'remote',
    expectedGeneration: signedOut.account.generation, clientId: f.pending.identity.clientId,
    identity: { issuer: f.pending.identity.issuer, subject: f.pending.identity.subject }, tokens: tokens('reauthorized') });
  assert.deepEqual(await readAuthHandoffReceipt(f.destination, selection), accepted);
  const mismatches = [
    { handoffId: randomUUID() },
    { runtimeId: 'another-runtime' },
    { expectedTarget: { ...f.target, hostId: `urn:uuid:${randomUUID()}` } },
    { expectedBinding: { ...f.pending.binding, generation: randomUUID() } },
    { expectedBinding: { ...f.pending.binding, source: { ...f.pending.binding.source, runtimeId: 'other-source' } } },
    { identity: { ...f.pending.identity, issuer: 'https://other.example' } },
    { identity: { ...f.pending.identity, clientId: 'oaiapp_other' } },
    { identity: { ...f.pending.identity, subject: 'other-subject' } },
  ];
  const guard = guardedReadOnlyFileSystem();
  for (const mismatch of mismatches) {
    await assert.rejects(readAuthHandoffReceipt(f.destination, { ...selection, ...mismatch }, guard));
  }
  await assert.rejects(readAuthHandoffReceipt({ ...f.destination, registrationId: randomUUID() }, selection, guard));
  assert.deepEqual(guard.writes, []);
  assert.equal(JSON.stringify(await readAuthHandoffReceipt(f.destination, selection)).includes('private-'), false);
});

test('receipt CLI is read-only, returns the exact original receipt and bounds UTF-8 stdin to 8 KiB', async t => {
  const f = await exportedHandoff(t);
  const request = Buffer.from(JSON.stringify({ handoffId: f.pending.handoffId,
    binding: f.pending.binding, identity: f.pending.identity }));
  const guard = guardedReadOnlyFileSystem();
  const invoke = async (input, storageRoot = f.destination.storageRoot, registrationId = f.source.registrationId) => {
    let output = '';
    await runSiwcHandoffCli({ command: 'receipt', storageRoot, runtimeId: 'remote', registrationId,
      input, output: { write(value) { output += value; } }, sessionDeps: guard });
    return JSON.parse(output);
  };
  const absentRoot = join(await root(t), 'absent');
  assert.deepEqual(await invoke([request], absentRoot), { receipt: null });
  await assert.rejects(fs.access(absentRoot), { code: 'ENOENT' });
  assert.deepEqual(await invoke([request]), { receipt: null });
  const accepted = await acceptAuthHandoff({ storageRoot: f.destination.storageRoot, runtimeId: 'remote',
    expectedTarget: f.target, expectedRegistrationId: f.source.registrationId, contents: f.contents });
  assert.deepEqual(await invoke([request.subarray(0, 12), request.subarray(12)]), { receipt: accepted });
  assert.deepEqual(await invoke([Buffer.concat([request, Buffer.alloc(8192 - request.length, 0x20)])]),
    { receipt: accepted });
  await assert.rejects(invoke([Buffer.concat([request, Buffer.alloc(8193 - request.length, 0x20)])]), TypeError);
  await assert.rejects(invoke(['é'.repeat(4097)]), TypeError);
  await assert.rejects(invoke([]), TypeError);
  await assert.rejects(invoke([Buffer.from('{invalid')] ), SyntaxError);
  await assert.rejects(invoke([Buffer.from([0xff])]), TypeError);
  await assert.rejects(invoke([Buffer.from(JSON.stringify({ ...JSON.parse(request), tokens: tokens('unexpected') }))]), TypeError);
  await assert.rejects(invoke([request], f.destination.storageRoot, randomUUID()));
  const saved = await readRegistration(f.destination);
  assert.equal(saved.session.refreshToken, 'private-refresh-first');
  assert.deepEqual(saved.acceptedHandoff, accepted);
  assert.deepEqual(guard.writes, []);
  const linkedRoot = await root(t);
  await fs.symlink(join(f.destination.storageRoot, 'registrations'), join(linkedRoot, 'registrations'));
  await assert.rejects(invoke([request], linkedRoot));
  assert.deepEqual(guard.writes, []);
});

test('pending handoff metadata is token-free and does not create sender storage', async t => {
  const storageRoot = join(await root(t), 'missing');
  const guard = guardedReadOnlyFileSystem();
  assert.equal(await readPendingAuthHandoff({ storageRoot, registrationId: randomUUID() }, guard), null);
  await assert.rejects(fs.access(storageRoot), { code: 'ENOENT' });
  const existingRoot = await root(t);
  const first = await registration(existingRoot);
  const source = { storageRoot: existingRoot, registrationId: first.registrationId };
  assert.equal(await readPendingAuthHandoff(source, guard), null);
  const enabled = await setPlanEnabled(source, { enabled: true, expectedGeneration: first.generation });
  const target = await ensureSiwcHost({ storageRoot: await root(t), runtimeId: 'remote' });
  const prepared = await prepareAuthHandoff(source, {
    expectedGeneration: enabled.generation, target, backgroundConsent: false,
  });
  const pending = await readPendingAuthHandoff(source, guard);
  assert.deepEqual(pending, { ...prepared, target,
    identity: { issuer: discovery.issuer, clientId: 'oaiapp_first', subject: 'subject-first' } });
  const serialized = JSON.stringify(pending);
  assert.equal(serialized.includes('private-'), false);
  assert.equal(serialized.includes('proofSecret'), false);
  assert.equal(serialized.includes('session'), false);
  assert.deepEqual(guard.writes, []);
});

test('symlinked registration storage fails closed', async t => {
  const storageRoot = await root(t);
  const outside = await root(t);
  await symlink(outside, join(storageRoot, 'registrations'));
  await assert.rejects(listRegistrations({ storageRoot }));
});

test('group- or world-accessible registration storage fails closed', {
  skip: process.platform === 'win32' && 'NTFS has no POSIX mode bits; Windows storage is held to owner-only ACLs instead',
}, async t => {
  const nested = await root(t);
  await mkdir(join(nested, 'registrations'), { mode: 0o700 });
  await chmod(join(nested, 'registrations'), 0o777);
  await assert.rejects(listRegistrations({ storageRoot: nested }));
});

test('host read never creates a missing identity, while explicit creation remains stable', async t => {
  const storageRoot = await root(t);
  await assert.rejects(readSiwcHost({ storageRoot, runtimeId: 'local' }));
  await assert.rejects(fs.access(join(storageRoot, 'host.json')), { code: 'ENOENT' });
  const created = await ensureSiwcHost({ storageRoot, runtimeId: 'local' });
  assert.deepEqual(await readSiwcHost({ storageRoot, runtimeId: 'local' }), created);
  assert.equal((await ensureSiwcHost({ storageRoot, runtimeId: 'local' })).hostId, created.hostId);
});

test('plan welcome is acknowledged once per issued registration across logout and reauthorization', async t => {
  const storageRoot = await root(t);
  const first = await registration(storageRoot);
  let view = await setPlanEnabled({ storageRoot, registrationId: first.registrationId }, {
    enabled: true, expectedGeneration: first.generation,
  });
  view = await acknowledgePlanUse({ storageRoot, registrationId: first.registrationId }, {
    expectedGeneration: view.generation,
  });
  const signedOut = await signOut({ storageRoot, registrationId: first.registrationId }, { runtimeId: 'local' }, {
    fetchImpl: async url => url.endsWith('/openid-configuration') ? Response.json(discovery) : new Response(null, { status: 200 }),
  });
  assert.equal(signedOut.account.needsPlanWelcome, false);
  view = await commitAuthorization({ storageRoot, registrationId: first.registrationId,
    expectedGeneration: signedOut.account.generation, clientId: 'oaiapp_first', runtimeId: 'local',
    identity: { issuer: discovery.issuer, subject: 'subject-first' }, tokens: tokens('renewed') });
  view = await setPlanEnabled({ storageRoot, registrationId: first.registrationId }, {
    enabled: true, expectedGeneration: view.generation,
  });
  assert.equal(view.needsPlanWelcome, false);
});

test('a signed refresh ID token for a different subject freezes rotating credentials', async t => {
  const storageRoot = await root(t);
  const now = Date.now();
  const first = await registration(storageRoot, 'first', now - 3600000);
  await setPlanEnabled({ storageRoot, registrationId: first.registrationId }, {
    enabled: true, expectedGeneration: first.generation,
  });
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = { ...await exportJWK(publicKey), alg: 'RS256', kid: 'refresh-test', use: 'sig' };
  const signed = await new SignJWT({})
    .setProtectedHeader({ alg: 'RS256', kid: 'refresh-test' })
    .setIssuer(discovery.issuer).setAudience('oaiapp_first')
    .setSubject('different-subject').setIssuedAt().setExpirationTime('5m').sign(privateKey);
  await assert.rejects(getAccessToken({ storageRoot, registrationId: first.registrationId },
    { runtimeId: 'local' }, { now: () => now, fetchImpl: async url => {
      if (url.endsWith('/openid-configuration')) return Response.json(discovery);
      if (url === discovery.jwks_uri) return Response.json({ keys: [jwk] });
      return Response.json({ ...tokens('rotated'), id_token: signed });
    } }), error => error.recovery === 'reauthorize');
  const record = await readRegistration({ storageRoot, registrationId: first.registrationId });
  assert.equal(record.session.refreshToken, 'private-refresh-rotated');
  assert.equal(record.session.refreshUncertain, true);
  assert.equal(record.session.verificationPending, false);
  await assert.rejects(getAccessToken({ storageRoot, registrationId: first.registrationId },
    { runtimeId: 'local' }, { fetchImpl: async () => { throw new Error('invalid identity must not retry'); } }),
  error => error.recovery === 'reauthorize');
  assert.equal(record.identity.subject, 'subject-first');
});

test('JWKS outage after rotation keeps replacement protected and revocable without granting a lease', async t => {
  const storageRoot = await root(t);
  const now = Date.now();
  const first = await registration(storageRoot, 'first', now - 3600000);
  await setPlanEnabled({ storageRoot, registrationId: first.registrationId }, {
    enabled: true, expectedGeneration: first.generation,
  });
  const { privateKey } = await generateKeyPair('RS256');
  const signed = await new SignJWT({})
    .setProtectedHeader({ alg: 'RS256', kid: 'refresh-test' })
    .setIssuer(discovery.issuer).setAudience('oaiapp_first')
    .setSubject('subject-first').setIssuedAt().setExpirationTime('5m').sign(privateKey);
  const registrationRef = { storageRoot, registrationId: first.registrationId };
  await assert.rejects(getAccessToken(registrationRef, { runtimeId: 'local' }, {
    now: () => now,
    fetchImpl: async url => url.endsWith('/openid-configuration') ? Response.json(discovery)
      : url === discovery.jwks_uri ? Response.json({}, { status: 503 })
        : Response.json({ ...tokens('rotated'), id_token: signed }),
  }), error => error.recovery === 'retry-later');
  const frozen = await readRegistration(registrationRef);
  assert.equal(frozen.session.refreshToken, 'private-refresh-rotated');
  assert.equal(frozen.session.refreshUncertain, true);
  let repeatedRefreshes = 0;
  await assert.rejects(getAccessToken(registrationRef, { runtimeId: 'local' }, {
    now: () => now,
    fetchImpl: async url => {
      if (url.endsWith('/openid-configuration')) return Response.json(discovery);
      if (url === discovery.jwks_uri) return Response.json({}, { status: 503 });
      repeatedRefreshes++;
      throw new Error('must not replay old token');
    },
  }), error => error.recovery === 'retry-later');
  assert.equal(repeatedRefreshes, 0);
  let revoked;
  const signedOut = await signOut(registrationRef, { runtimeId: 'local' }, {
    fetchImpl: async (url, options) => {
      if (url.endsWith('/openid-configuration')) return Response.json(discovery);
      revoked = options.body.get('token');
      return new Response(null, { status: 200 });
    },
  });
  assert.equal(revoked, 'private-refresh-rotated');
  assert.equal(signedOut.revocation, 'unconfirmed');
  assert.equal((await readRegistration(registrationRef)).session.refreshToken, undefined);
});

test('JWKS recovery verifies the persisted R1 without another refresh POST', async t => {
  const storageRoot = await root(t);
  const now = Date.now();
  const first = await registration(storageRoot, 'first', now - 3600000);
  await setPlanEnabled({ storageRoot, registrationId: first.registrationId }, {
    enabled: true, expectedGeneration: first.generation,
  });
  const { privateKey, publicKey } = await generateKeyPair('RS256');
  const jwk = { ...await exportJWK(publicKey), kid: 'refresh-recovery', alg: 'RS256', use: 'sig' };
  const signed = await new SignJWT({})
    .setProtectedHeader({ alg: 'RS256', kid: 'refresh-recovery' })
    .setIssuer(discovery.issuer).setAudience('oaiapp_first')
    .setSubject('subject-first').setIssuedAt().setExpirationTime('5m').sign(privateKey);
  const registrationRef = { storageRoot, registrationId: first.registrationId };
  let refreshPosts = 0;
  await assert.rejects(getAccessToken(registrationRef, { runtimeId: 'local' }, {
    now: () => now,
    fetchImpl: async url => {
      if (url.endsWith('/openid-configuration')) return Response.json(discovery);
      if (url === discovery.jwks_uri) return Response.json({}, { status: 503 });
      refreshPosts++;
      return Response.json({ ...tokens('rotated'), id_token: signed });
    },
  }), error => error.recovery === 'retry-later');
  const frozen = await readRegistration(registrationRef);
  assert.equal(frozen.session.refreshToken, 'private-refresh-rotated');
  assert.equal(frozen.session.verificationPending, true);
  const lease = await getAccessToken(registrationRef, { runtimeId: 'local' }, {
    now: () => now,
    fetchImpl: async url => {
      if (url.endsWith('/openid-configuration')) return Response.json(discovery);
      if (url === discovery.jwks_uri) return Response.json({ keys: [jwk] });
      refreshPosts++;
      throw new Error('must not refresh R0 or R1 during verification retry');
    },
  });
  assert.equal(refreshPosts, 1);
  assert.equal(lease.accessToken, 'private-access-rotated');
  const current = await readRegistration(registrationRef);
  assert.equal(current.session.refreshToken, 'private-refresh-rotated');
  assert.equal(current.session.refreshUncertain, undefined);
  assert.equal(current.planEnabled, true);
});

test('a rotating token response naming another issued client is never promoted', async t => {
  const storageRoot = await root(t);
  const first = await registration(storageRoot);
  await setPlanEnabled({ storageRoot, registrationId: first.registrationId }, {
    enabled: true, expectedGeneration: first.generation,
  });
  await assert.rejects(getAccessToken({ storageRoot, registrationId: first.registrationId },
    { runtimeId: 'local' }, { now: () => 1700003600000, fetchImpl: async url => {
      if (url.endsWith('/openid-configuration')) return Response.json(discovery);
      return Response.json({ ...tokens('rotated'), id_token: undefined, client_id: 'another-issued-client' });
    } }), error => error.recovery === 'reauthorize');
  const record = await readRegistration({ storageRoot, registrationId: first.registrationId });
  assert.equal(record.session.refreshToken, 'private-refresh-rotated');
  assert.equal(record.session.refreshUncertain, true);
  assert.equal(record.session.verificationPending, undefined);
  assert.equal(record.clientId, 'oaiapp_first');
});

test('failed persistence of a wrong-client R1 cannot activate it in a fresh process', async t => {
  const storageRoot = await root(t);
  const first = await registration(storageRoot);
  await setPlanEnabled({ storageRoot, registrationId: first.registrationId }, {
    enabled: true, expectedGeneration: first.generation,
  });
  let posts = 0;
  const fileSystem = {
    ...fs,
    async rename(source, destination) {
      if (destination.includes(`${sep}registrations${sep}`) && destination.endsWith('.json') &&
          (await fs.readFile(source, 'utf8')).includes('private-access-rotated'))
        throw Object.assign(new Error('replacement write unavailable'), { code: 'ENOSPC' });
      await fs.rename(source, destination);
    },
  };
  const registrationRef = { storageRoot, registrationId: first.registrationId };
  await assert.rejects(getAccessToken(registrationRef, { runtimeId: 'local' }, {
    now: () => 1700003600000, fileSystem,
    fetchImpl: async url => {
      if (url.endsWith('/openid-configuration')) return Response.json(discovery);
      posts++;
      return Response.json({ ...tokens('rotated'), id_token: undefined, client_id: 'another-issued-client' });
    },
  }));
  assert.equal(posts, 1);
  const frozen = await readRegistration(registrationRef);
  assert.equal(frozen.session.refreshUncertain, true);
  assert.equal(frozen.session.verificationPending, undefined);
  assert.equal(frozen.session.refreshToken, 'private-refresh-first');
  assert.equal(frozen.planEnabled, false);
  const probe = `
    const { getAccessToken } = await import(process.argv[1]);
    try {
      await getAccessToken({ storageRoot: process.argv[2], registrationId: process.argv[3] },
        { runtimeId: 'local' }, { fetchImpl: async () => { process.stdout.write('network'); throw Error('forbidden'); } });
      process.stdout.write('leased');
    } catch (error) { process.stdout.write(error.recovery === 'reauthorize' ? 'blocked' : 'wrong'); }
  `;
  const { stdout } = await execFileAsync(process.execPath,
    ['--input-type=module', '-e', probe, new URL('../src/services/siwc-session.mjs', import.meta.url).href,
      storageRoot, first.registrationId],
    { cwd: fileURLToPath(new URL('..', import.meta.url)), timeout: 10000 });
  assert.equal(stdout, 'blocked');
  assert.equal(posts, 1);
});

test('provider JSON is bounded as bytes while streaming', async () => {
  let cancelled = false;
  let reads = 0;
  const response = new Response(new ReadableStream({
    pull(controller) {
      reads++;
      controller.enqueue(new Uint8Array(96 * 1024));
    },
    cancel() { cancelled = true; },
  }));
  await assert.rejects(readSiwcJson(response));
  assert.equal(cancelled, true);
  assert.equal(reads < 5, true);
});

test('Windows ACL adapter protects each new credential file before writing secret bytes', async t => {
  const storageRoot = await root(t);
  const protectedPaths = new Set();
  const lockDownPath = async (path, { verifyOnly }) => {
    if (verifyOnly) assert.equal(protectedPaths.has(path), true);
    else protectedPaths.add(path);
  };
  const fileSystem = {
    ...fs,
    async open(path, flags, mode) {
      const handle = await fs.open(path, flags, mode);
      return {
        stat: () => handle.stat(), readFile: () => handle.readFile(),
        sync: () => handle.sync(), close: () => handle.close(),
        chmod: mode => handle.chmod(mode),
        async writeFile(value) {
          if (String(value).includes('private-access-first')) assert.equal(protectedPaths.has(path), true);
          await handle.writeFile(value);
        },
      };
    },
    async link(source, destination) {
      await fs.link(source, destination);
      if (protectedPaths.has(source)) protectedPaths.add(destination);
    },
    async rename(source, destination) {
      await fs.rename(source, destination);
      for (const path of [...protectedPaths]) {
        if (path === source || path.startsWith(`${source}${sep}`)) {
          protectedPaths.delete(path);
          protectedPaths.add(`${destination}${path.slice(source.length)}`);
        }
      }
    },
  };
  // Every access uses the injected adapter; the native Windows adapter never protected these files.
  const windowsDeps = { fileSystem, platform: 'win32', lockDownPath,
    getProcessIdentity: async () => ({ state: 'active', startIdentity: 'fixture-windows-process' }) };
  const account = await commitAuthorization({ storageRoot, clientId: 'oaiapp_first', runtimeId: 'local',
    identity: { issuer: discovery.issuer, subject: 'subject-first' }, tokens: tokens('first') }, windowsDeps);
  assert.equal((await readRegistration({ storageRoot, registrationId: account.registrationId }, windowsDeps))
    .session.accessToken, 'private-access-first');
});

test('Windows path protection rejects a symlink before touching its target ACL', async t => {
  const parent = await root(t), outside = await root(t);
  const storageRoot = join(parent, 'linked-root');
  await symlink(outside, storageRoot);
  let aclCalls = 0;
  await assert.rejects(ensureSiwcHost({ storageRoot, runtimeId: 'local' }, {
    platform: 'win32', lockDownPath: async () => { aclCalls++; },
  }));
  assert.equal(aclCalls, 0);
});

test('Windows keeps an existing owner-only SIWC directory and rewrites only one that fails verification', async t => {
  const storageRoot = await root(t);
  const registrations = join(storageRoot, 'registrations');
  const protectedDirectories = new Set(), rewrites = [];
  const aclAdapter = async (path, { kind, verifyOnly }) => {
    if (kind !== 'directory') return;
    if (verifyOnly) {
      if (!protectedDirectories.has(path)) throw new Error('Windows could not apply and verify owner-only protection for local Relmio files.');
      return;
    }
    rewrites.push(path);
    protectedDirectories.add(path);
  };
  // Each wrapper is a distinct adapter, so it starts with no remembered inodes, like a new process.
  const freshProcess = () => ({ platform: 'win32', lockDownPath: (...args) => aclAdapter(...args),
    getProcessIdentity: async () => ({ state: 'active', startIdentity: 'fixture-windows-process' }) });
  const host = await ensureSiwcHost({ storageRoot, runtimeId: 'local' }, freshProcess());
  assert.deepEqual(rewrites, [storageRoot, registrations]);
  rewrites.length = 0;
  assert.deepEqual(await ensureSiwcHost({ storageRoot, runtimeId: 'local' }, freshProcess()), host);
  assert.deepEqual(rewrites, []);
  protectedDirectories.delete(registrations);
  await ensureSiwcHost({ storageRoot, runtimeId: 'local' }, freshProcess());
  assert.deepEqual(rewrites, [registrations]);
});

test('thread ownership persists only for the verified active registration and model', async t => {
  const storageRoot = await root(t);
  const first = await registration(storageRoot);
  const second = await registration(storageRoot, 'second');
  const enabled = await setPlanEnabled({ storageRoot, registrationId: first.registrationId }, {
    enabled: true, expectedGeneration: first.generation,
  });
  const registrationRef = { storageRoot, registrationId: first.registrationId };
  const identity = { issuer: discovery.issuer, clientId: 'oaiapp_first', subject: 'subject-first' };
  const binding = { runtimeId: 'local', threadId: 'thread_123', model: 'gpt-5.6', identity };
  await assert.rejects(recordSiwcThreadBinding(registrationRef, {
    ...binding, identity: { ...identity, clientId: 'oaiapp_second' },
  }));
  assert.deepEqual(await listSiwcThreadBindings(registrationRef, { runtimeId: 'local' }), []);
  const saved = await recordSiwcThreadBinding(registrationRef, binding);
  assert.deepEqual(saved, { threadId: 'thread_123', model: 'gpt-5.6', identity });
  assert.deepEqual(await listSiwcThreadBindings(registrationRef, { runtimeId: 'local' }), [saved]);
  assert.deepEqual(await recordSiwcThreadBinding(registrationRef, binding), saved);
  await assert.rejects(recordSiwcThreadBinding(registrationRef, { ...binding, model: 'other-model' }));
  await assert.rejects(listSiwcThreadBindings({ storageRoot, registrationId: second.registrationId }, { runtimeId: 'local' }));
  const target = await ensureSiwcHost({ storageRoot: await root(t), runtimeId: 'remote' });
  await prepareAuthHandoff(registrationRef, { expectedGeneration: enabled.generation, target, backgroundConsent: false });
  await assert.rejects(listSiwcThreadBindings(registrationRef, { runtimeId: 'local' }));
});

test('corrupt protected thread storage is rejected rather than treated as empty', async t => {
  const storageRoot = await root(t);
  const first = await registration(storageRoot);
  await setPlanEnabled({ storageRoot, registrationId: first.registrationId }, {
    enabled: true, expectedGeneration: first.generation,
  });
  const registrationRef = { storageRoot, registrationId: first.registrationId };
  await recordSiwcThreadBinding(registrationRef, { runtimeId: 'local', threadId: 'thread_123',
    model: 'gpt-5.6', identity: { issuer: discovery.issuer, clientId: 'oaiapp_first', subject: 'subject-first' } });
  await fs.writeFile(join(storageRoot, 'threads', `${first.registrationId}.json`), '{"bindings":"invalid"}', { mode: 0o600 });
  await assert.rejects(listSiwcThreadBindings(registrationRef, { runtimeId: 'local' }));
});

test('a transient release IO failure retries the same exact claim and does not strand the registration', async t => {
  const storageRoot = await root(t);
  const first = await registration(storageRoot);
  const source = { storageRoot, registrationId: first.registrationId };
  await setPlanEnabled(source, { enabled: true, expectedGeneration: first.generation });
  const lockPath = join(storageRoot, 'registrations', `${first.registrationId}.lock`);
  let injected = false, waits = 0;
  const result = await getAccessToken(source, { runtimeId: 'local' }, {
    now: () => 1700000000000, waitForLock: async () => { waits++; },
    fileSystem: { ...fs, async rename(from, to) {
      if (!injected && from === lockPath) {
        injected = true;
        throw Object.assign(new Error('fixture transient release failure'), { code: 'EAGAIN' });
      }
      return fs.rename(from, to);
    } },
    fetchImpl: async () => { throw new Error('Cached access must not reach the provider.'); },
  });
  assert.equal(injected, true);
  assert.ok(waits > 0);
  assert.equal(result.accessToken, 'private-access-first');
  await assert.rejects(fs.access(lockPath), { code: 'ENOENT' });
  assert.equal((await getAccessToken(source, { runtimeId: 'local' }, {
    now: () => 1700000000000, fetchImpl: async () => { throw new Error('Cached access must not refresh.'); },
  })).accessToken, 'private-access-first');
});

test('twelve concurrent cached-token callers serialize and leave no published lock behind', async t => {
  const storageRoot = await root(t);
  const first = await registration(storageRoot);
  const source = { storageRoot, registrationId: first.registrationId };
  await setPlanEnabled(source, { enabled: true, expectedGeneration: first.generation });
  const requests = Array.from({ length: 12 }, () => getAccessToken(source, { runtimeId: 'local' }, {
    now: () => 1700000000000, fetchImpl: async () => { throw new Error('Cached access must not refresh.'); },
  }));
  const results = await Promise.all(requests);
  assert.ok(results.every(result => result.accessToken === 'private-access-first'));
  await assert.rejects(fs.access(join(storageRoot, 'registrations', `${first.registrationId}.lock`)), { code: 'ENOENT' });
  await assert.rejects(fs.access(join(storageRoot, 'registrations', `${first.registrationId}.lock.publication-lock`)), { code: 'ENOENT' });
  assert.equal((await getAccessToken(source, { runtimeId: 'local' }, {
    now: () => 1700000000000, fetchImpl: async () => { throw new Error('Cached access must not refresh.'); },
  })).accessToken, 'private-access-first');
});

test('cached-token ownership releases through a contending publication guard and remains usable', async t => {
  const storageRoot = await root(t);
  const first = await registration(storageRoot);
  const source = { storageRoot, registrationId: first.registrationId };
  await setPlanEnabled(source, { enabled: true, expectedGeneration: first.generation });
  const recordPath = join(storageRoot, 'registrations', `${first.registrationId}.json`);
  const lockPath = join(storageRoot, 'registrations', `${first.registrationId}.lock`);
  let guardCreated = false, guardHeld = false, releaseGuard, collisions = 0;
  const result = await getAccessToken(source, { runtimeId: 'local' }, {
    now: () => 1700000000000,
    fileSystem: { ...fs, async open(path, flags, ...args) {
      const handle = await fs.open(path, flags, ...args);
      if (path !== recordPath || flags !== 'r') return handle;
      return {
        stat: () => handle.stat(), close: () => handle.close(),
        async readFile() {
          const contents = await handle.readFile();
          if (!guardCreated) {
            guardCreated = true;
            releaseGuard = await acquireLocalIntegrationLifecycleLock({
              fileSystem: fs, lockPath: `${lockPath}.publication-lock`, atomicPublication: true,
            });
            guardHeld = true;
          }
          return contents;
        },
      };
    } },
    async getProcessIdentity(pid, options) {
      if (guardHeld) {
        guardHeld = false;
        collisions++;
        await releaseGuard();
      }
      return getLocalProcessIdentity(pid, options);
    },
    fetchImpl: async () => { throw new Error('Cached access must not refresh.'); },
  });
  assert.equal(collisions, 1);
  assert.equal(result.accessToken, 'private-access-first');
  await assert.rejects(fs.access(lockPath), { code: 'ENOENT' });
  await assert.rejects(fs.access(`${lockPath}.publication-lock`), { code: 'ENOENT' });
  assert.equal((await getAccessToken(source, { runtimeId: 'local' }, {
    now: () => 1700000000000, fetchImpl: async () => { throw new Error('Cached access must not refresh.'); },
  })).accessToken, 'private-access-first');
});

test('persistent transient release IO stops at the session retry bound without altering credentials', async t => {
  const storageRoot = await root(t);
  const first = await registration(storageRoot);
  const source = { storageRoot, registrationId: first.registrationId };
  await setPlanEnabled(source, { enabled: true, expectedGeneration: first.generation });
  const before = await readRegistration(source);
  const lockPath = join(storageRoot, 'registrations', `${first.registrationId}.lock`);
  let clock = 1000, attempts = 0, waits = 0;
  await assert.rejects(getAccessToken(source, { runtimeId: 'local' }, {
    now: () => 1700000000000, monotonicNow: () => clock,
    waitForLock: async () => { waits++; clock += SIWC_LOCK_WAIT_TIMEOUT_MS; },
    fileSystem: { ...fs, async rename(from, to) {
      if (from === lockPath) {
        attempts++;
        throw Object.assign(new Error('fixture persistent release failure'), { code: 'EAGAIN' });
      }
      return fs.rename(from, to);
    } },
    fetchImpl: async () => { throw new Error('Cached access must not refresh.'); },
  }), error => error.code === 'siwc_lock_unavailable' && error.status === 503);
  assert.equal(attempts, 2);
  assert.equal(waits, 1);
  assert.deepEqual(await readRegistration(source), before);
});

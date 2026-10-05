import * as fs from 'node:fs/promises';
import { createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import {
  lockDownLocalPath, recallWindowsLockdown, refreshWindowsLockdown, rememberWindowsLockdown, retryWindowsFileSharing,
} from '../infrastructure/local-process.js';
import { createLocalJWKSet, jwtVerify } from 'jose';
import { acquireLocalIntegrationLifecycleLock } from './local-integration-lifecycle-lock.js';

const ISSUER = 'https://auth.openai.com';
const RESOURCE = 'https://api.openai.com/v1';
const MAX_FILE = 128 * 1024;
export const SIWC_LOCK_OPERATION_TIMEOUT_MS = 120_000;
export const SIWC_LOCK_LEASE_MS = 600_000;
export const SIWC_LOCK_WAIT_TIMEOUT_MS = 150_000;
const monotonicMilliseconds = () => Number(process.hrtime.bigint() / 1_000_000n);
const TERMINAL = new Set(['invalid_grant', 'invalid_refresh_token', 'token_expired', 'refresh_token_expired', 'refresh_token_invalidated', 'refresh_token_reused']);
const pause = ms => new Promise(done => setTimeout(done, ms));
export async function readSiwcJson(response) {
  const reader = response?.body?.getReader?.();
  if (!reader) throw new Error('Invalid OpenAI response.');
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_FILE) {
        await reader.cancel();
        throw new Error('OpenAI response exceeded the size limit.');
      }
      chunks.push(value);
    }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, total)));
  } catch {
    throw new Error('Invalid or oversized OpenAI response.');
  } finally {
    reader.releaseLock();
  }
}
const settings = deps => ({ fileSystem: deps?.fileSystem ?? fs, fetchImpl: deps?.fetchImpl ?? fetch, now: deps?.now ?? Date.now, platform: deps?.platform ?? process.platform, lockDownPath: deps?.lockDownPath ?? lockDownLocalPath,
  getProcessIdentity: deps?.getProcessIdentity, getPidNamespaceIdentity: deps?.getPidNamespaceIdentity,
  waitForLock: deps?.waitForLock ?? pause, monotonicNow: deps?.monotonicNow ?? monotonicMilliseconds,
  signal: deps?.signal, callerSignal: deps && Object.hasOwn(deps, 'callerSignal') ? deps.callerSignal : deps?.signal,
  holderSignal: deps?.holderSignal, checkLock: deps?.checkLock,
  scheduleTimeout: deps?.scheduleTimeout ?? setTimeout, cancelTimeout: deps?.cancelTimeout ?? clearTimeout });
const valid = (value, pattern, name) => {
  if (typeof value !== 'string' || !pattern.test(value)) throw new TypeError(`Invalid SIWC ${name}.`);
  return value;
};
export const validateSiwcRegistrationId = value => valid(value, /^[A-Za-z0-9_-]{8,64}$/u, 'registration ID');
export const validateSiwcRuntimeId = value => valid(value, /^[A-Za-z0-9_-]{1,64}$/u, 'runtime ID');
export const validateSiwcHostId = value => valid(value, /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu, 'host ID');
export const validateSiwcClientId = value => valid(value, /^[!-~]{1,256}$/u, 'issued client ID');
const assertGeneration = value => valid(value, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu, 'generation');
const assertTarget = target => ({ hostId: validateSiwcHostId(target?.hostId), runtimeId: validateSiwcRuntimeId(target?.runtimeId) });
export function resolveSiwcStorageRoot({ env = process.env, homeDirectory = homedir() } = {}) {
  const root = env.N8N_OPENAI_OAUTH_HOME || join(homeDirectory, '.n8n-openai-oauth');
  if (typeof root !== 'string' || !isAbsolute(root) || root.includes('\0') || resolve(root) !== root) throw new TypeError('Invalid SIWC storage root.');
  return root;
}
const rootOf = storageRoot => {
  const root = storageRoot ?? resolveSiwcStorageRoot();
  if (typeof root !== 'string' || !isAbsolute(root) || root.includes('\0') || resolve(root) !== root) throw new TypeError('Invalid SIWC storage root.');
  return root;
};
const fileOf = (root, id) => join(root, 'registrations', `${validateSiwcRegistrationId(id)}.json`);
const uid = () => typeof process.getuid === 'function' ? process.getuid() : null;
// An unchanged inode this process locked down itself skips the repeat Windows ACL
// check; foreign, replaced or changed inodes do not.
async function verifyWindowsAcl(path, kind, stat, contents, cfg) {
  if (contents !== null && recallWindowsLockdown(cfg.lockDownPath, stat, contents)) return;
  await cfg.lockDownPath(path, { platform: cfg.platform, kind, verifyOnly: true });
  if (contents !== null) refreshWindowsLockdown(cfg.lockDownPath, stat, contents);
}
async function assertSafePath(path, kind, cfg, { windowsAclChecked = false } = {}) {
  const { fileSystem: io, platform } = cfg;
  const stat = await io.lstat(path);
  if (stat.isSymbolicLink() || (kind === 'file' ? !stat.isFile() || stat.nlink !== 1 : !stat.isDirectory())) throw new Error('Unsafe SIWC storage entry.');
  if (platform === 'win32') { if (!windowsAclChecked) await verifyWindowsAcl(path, kind, stat, '', cfg); }
  else if ((uid() !== null && stat.uid !== uid()) || (stat.mode & (kind === 'file' ? 0o077 : 0o077)) !== 0) throw new Error('Insecure SIWC storage permissions.');
  return stat;
}
async function directory(path, cfg) {
  cfg.checkLock?.();
  let created = true;
  try { await cfg.fileSystem.mkdir(path, { mode: 0o700 }); }
  catch (error) { if (error?.code !== 'EEXIST') throw error; created = false; }
  const stat = await cfg.fileSystem.lstat(path);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Unsafe SIWC storage entry.');
  if (cfg.platform !== 'win32') {
    await assertSafePath(path, 'directory', cfg);
    return;
  }
  if (recallWindowsLockdown(cfg.lockDownPath, stat, '')) return;
  // Rewriting a directory DACL re-propagates to every child and races other processes
  // using them, so an existing directory that already verifies owner-only is kept as is.
  if (!created) {
    let verified = false;
    try {
      await cfg.lockDownPath(path, { platform: cfg.platform, kind: 'directory', verifyOnly: true });
      verified = true;
    } catch { /* Repair it below, exactly like a new directory. */ }
    if (verified) {
      refreshWindowsLockdown(cfg.lockDownPath, await assertSafePath(path, 'directory', cfg, { windowsAclChecked: true }), '');
      return;
    }
  }
  await cfg.lockDownPath(path, { platform: cfg.platform, kind: 'directory' });
  // The lockdown reads its owner-only DACL back, so no separate verify-only check follows.
  rememberWindowsLockdown(cfg.lockDownPath, await assertSafePath(path, 'directory', cfg, { windowsAclChecked: true }), '');
}
async function ensureRoot(root, cfg) {
  await directory(root, cfg);
  await directory(join(root, 'registrations'), cfg);
}
async function readFile(path, cfg, missing = null) {
  cfg.checkLock?.();
  let stat;
  // The Windows ACL check runs below, once the contents are known and before they are used.
  try { stat = await assertSafePath(path, 'file', cfg, { windowsAclChecked: true }); }
  catch (error) { if (error?.code === 'ENOENT') return missing; throw error; }
  if (stat.size > MAX_FILE || stat.size === 0) throw new Error('Invalid SIWC storage file.');
  const handle = await cfg.fileSystem.open(path, 'r');
  try {
    const opened = await handle.stat();
    if (opened.ino !== stat.ino || opened.dev !== stat.dev || !opened.isFile()) throw new Error('SIWC storage changed during read.');
    const bytes = await handle.readFile();
    if (bytes.length !== stat.size || bytes.length > MAX_FILE) throw new Error('Invalid SIWC storage file.');
    if (cfg.platform === 'win32') await verifyWindowsAcl(path, 'file', stat, bytes, cfg);
    try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); }
    catch { throw new Error('Invalid SIWC storage file.'); }
  } finally { await handle.close(); }
}
async function atomicFile(path, value, cfg, beforeRename = () => {}) {
  cfg.checkLock?.();
  const contents = Buffer.from(JSON.stringify(value));
  if (contents.length === 0 || contents.length > MAX_FILE) throw new Error('SIWC storage record is too large.');
  const temp = `${path}.${randomUUID()}.tmp`;
  let created = false;
  try {
    const handle = await cfg.fileSystem.open(temp, 'wx', 0o600);
    created = true;
    try {
      if (cfg.platform === 'win32') await cfg.lockDownPath(temp, { platform: cfg.platform, kind: 'file' });
      cfg.checkLock?.();
      await handle.writeFile(contents);
      await handle.sync();
    } finally { await handle.close(); }
    // The Windows lockdown above already read the staged file's owner-only DACL back.
    const staged = await assertSafePath(temp, 'file', cfg, { windowsAclChecked: true });
    if (cfg.platform === 'win32') rememberWindowsLockdown(cfg.lockDownPath, staged, contents);
    try {
      const existing = await assertSafePath(path, 'file', cfg, { windowsAclChecked: true });
      if (cfg.platform === 'win32') {
        await verifyWindowsAcl(path, 'file', existing,
          existing.size > 0 && existing.size <= MAX_FILE ? await cfg.fileSystem.readFile(path) : null, cfg);
      }
    } catch (error) { if (error?.code !== 'ENOENT') throw error; }
    beforeRename();
    cfg.checkLock?.();
    await retryWindowsFileSharing(() => cfg.fileSystem.rename(temp, path), { platform: cfg.platform });
    if (cfg.platform !== 'win32') {
      const directoryHandle = await cfg.fileSystem.open(dirname(path), 'r');
      try { await directoryHandle.sync(); } finally { await directoryHandle.close(); }
    }
  } finally { if (created) await cfg.fileSystem.rm(temp, { force: true }); }
}
const lockUnavailable = () => Object.assign(new Error('SIWC session lock is unavailable. Retry later.'),
  { status: 503, recovery: 'retry-later', code: 'siwc_lock_unavailable' });
async function releaseSessionLock(release, cfg) {
  const deadline = cfg.monotonicNow() + SIWC_LOCK_WAIT_TIMEOUT_MS;
  for (let attempt = 0; attempt < 3000; attempt++) {
    try { await release(); return; }
    catch (error) {
      if (!['RELMIO_LOCK_BUSY', 'RELMIO_LOCK_CHANGED', 'EAGAIN', 'EBUSY', 'EINTR', 'EIO'].includes(error?.code) ||
          attempt === 2999 || cfg.monotonicNow() >= deadline) throw lockUnavailable();
      await cfg.waitForLock(50);
    }
  }
}
async function locked(root, registrationId, cfg, operation) {
  validateSiwcRegistrationId(registrationId);
  await ensureRoot(root, cfg);
  const lockPath = join(root, 'registrations', `${registrationId}.lock`);
  const fileSystem = { ...cfg.fileSystem, async lstat(path) {
    const stat = await cfg.fileSystem.lstat(path);
    if (stat.isSymbolicLink() || stat.isFile() && (stat.nlink < 1 || stat.nlink > 2) ||
        cfg.platform !== 'win32' && uid() !== null && stat.uid !== uid())
      throw new Error('Unsafe SIWC lock storage.');
    return stat;
  } };
  let release;
  const waitDeadline = cfg.monotonicNow() + SIWC_LOCK_WAIT_TIMEOUT_MS;
  for (let i = 0; i < 3000 && cfg.monotonicNow() < waitDeadline; i++) {
    cfg.checkLock?.();
    cfg.callerSignal?.throwIfAborted();
    try {
      release = await acquireLocalIntegrationLifecycleLock({
        fileSystem, lockPath, platform: cfg.platform, lockDownPath: cfg.lockDownPath,
        getProcessIdentity: cfg.getProcessIdentity, getPidNamespaceIdentity: cfg.getPidNamespaceIdentity,
        reclaimIncomplete: false, atomicPublication: true, leaseMs: SIWC_LOCK_LEASE_MS, leaseNow: cfg.monotonicNow,
        label: 'SIWC session lock', releaseWaitMs: SIWC_LOCK_WAIT_TIMEOUT_MS,
      });
      break;
    } catch (error) {
      if (!['RELMIO_LOCK_BUSY', 'RELMIO_LOCK_CHANGED', 'RELMIO_LOCK_IDENTITY_UNAVAILABLE'].includes(error?.code))
        throw lockUnavailable();
      if (i < 2999 && cfg.monotonicNow() < waitDeadline) await cfg.waitForLock(50);
    }
  }
  if (!release) throw lockUnavailable();
  const controller = new AbortController();
  const holderSignal = cfg.holderSignal ? AbortSignal.any([cfg.holderSignal, controller.signal]) : controller.signal;
  const callerSignal = cfg.callerSignal;
  const signal = callerSignal ? AbortSignal.any([callerSignal, holderSignal]) : holderSignal;
  const deadline = release.acquiredAt + SIWC_LOCK_OPERATION_TIMEOUT_MS;
  const deadlineFailure = () => Object.assign(new Error('SIWC session operation exceeded its deadline. Retry later.'),
    { status: 503, recovery: 'retry-later', code: 'siwc_lock_deadline' });
  const checkLock = () => {
    cfg.checkLock?.();
    if (cfg.monotonicNow() >= deadline && !controller.signal.aborted) controller.abort(deadlineFailure());
    holderSignal.throwIfAborted();
  };
  const activeCfg = { ...cfg, signal, holderSignal, callerSignal, checkLock };
  const subscriptions = [];
  const cancellations = [holderSignal, callerSignal].filter(Boolean).map(signal => new Promise((_, reject) => {
    const onAbort = () => reject(signal.reason);
    subscriptions.push({ signal, onAbort });
    signal.addEventListener('abort', onAbort, { once: true });
    if (signal.aborted) onAbort();
  }));
  const timer = cfg.scheduleTimeout(() => controller.abort(deadlineFailure()), Math.max(0, deadline - cfg.monotonicNow()));
  const operationResult = Promise.resolve().then(() => {
    checkLock();
    callerSignal?.throwIfAborted();
    return operation(activeCfg);
  }).then(result => {
    checkLock();
    return result;
  }).finally(async () => {
    cfg.cancelTimeout(timer);
    for (const { signal, onAbort } of subscriptions) signal.removeEventListener('abort', onAbort);
    controller.abort(deadlineFailure());
    await releaseSessionLock(release, cfg);
  });
  // Caller cancellation can return early, but the owned operation retains the lock until it settles.
  return Promise.race([operationResult, ...cancellations]).then(result => {
    callerSignal?.throwIfAborted();
    return result;
  });
}
const CONSENT_NOTICE = Object.freeze({
  'local-n8n': 'siwc-local-2026-10-04',
  'vps-n8n': 'siwc-vps-2026-10-04',
});
function consentShape(value) {
  return Boolean(value && typeof value === 'object' &&
    Object.keys(value).sort().join(',') === 'acceptedAt,noticeVersion' &&
    typeof value.acceptedAt === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/u.test(value.acceptedAt) &&
    !Number.isNaN(Date.parse(value.acceptedAt)));
}
export function validateSiwcBackgroundConsent(value, { target } = {}) {
  if (!Object.hasOwn(CONSENT_NOTICE, target) || !consentShape(value) ||
      value.noticeVersion !== CONSENT_NOTICE[target]) throw new TypeError('Invalid SIWC background consent.');
  return value;
}
function validConsent(value) {
  return value === false || consentShape(value) &&
    Object.values(CONSENT_NOTICE).includes(value.noticeVersion);
}
function validateHandoffBinding(binding) {
  if (!binding || typeof binding !== 'object' ||
      Object.keys(binding).sort().join(',') !== 'backgroundConsent,clientId,generation,registrationId,source,target' ||
      !binding.source || typeof binding.source !== 'object' ||
      Object.keys(binding.source).sort().join(',') !== 'hostId,runtimeId' ||
      !binding.target || typeof binding.target !== 'object' ||
      Object.keys(binding.target).sort().join(',') !== 'hostId,runtimeId' ||
      !validConsent(binding.backgroundConsent)) throw new Error('Invalid SIWC handoff binding.');
  validateSiwcRegistrationId(binding.registrationId);
  validateSiwcClientId(binding.clientId);
  assertGeneration(binding.generation);
  assertTarget(binding.source);
  assertTarget(binding.target);
  return binding;
}
function validateHandoffReceipt(receipt) {
  if (!receipt || typeof receipt !== 'object' ||
      Object.keys(receipt).sort().join(',') !== 'binding,handoffId,proof' ||
      typeof receipt.proof !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(receipt.proof))
    throw new Error('Invalid SIWC handoff receipt.');
  assertGeneration(receipt.handoffId);
  validateHandoffBinding(receipt.binding);
  return receipt;
}
function validatePending(record, id) {
  if (record?.schemaVersion !== 1 || record.kind !== 'pending' || record.registrationId !== id ||
      record.label !== 'ChatGPT sign-in pending' || !Number.isSafeInteger(record.createdAt) ||
      record.identity !== undefined || record.session !== undefined ||
      record.planEnabled !== undefined || record.handoff !== undefined) throw new Error('Invalid pending SIWC registration.');
  validateSiwcRegistrationId(id);
  validateSiwcClientId(record.clientId);
  if (record.clientId === 'dynamic_agent_client') throw new Error('Invalid pending SIWC client.');
  assertGeneration(record.generation);
  validateSiwcHostId(record.owner?.hostId);
  validateSiwcRuntimeId(record.owner?.runtimeId);
  return record;
}
function pendingAccount(record) {
  return { registrationId: record.registrationId, label: record.label, identity: 'unverified',
    session: 'signed-out', planPermission: 'not-granted', planEnabled: false,
    ownership: 'owned', generation: record.generation,
    ownerHostId: record.owner.hostId, ownerRuntimeId: record.owner.runtimeId,
    needsPlanWelcome: false };
}
function validateRecord(record, id) {
  if (record?.schemaVersion !== 1 || record.registrationId !== id ||
      typeof record.label !== 'string' || !record.label || record.label.length > 256 ||
      /[\u0000-\u001f\u007f]/u.test(record.label) ||
      !['owned', 'handoff-pending', 'transferred'].includes(record.handoff?.state) ||
      typeof record.planEnabled !== 'boolean' || typeof record.planAcknowledged !== 'boolean' ||
      !validConsent(record.backgroundConsent)) throw new Error('Invalid SIWC registration record.');
  validateSiwcRegistrationId(record.registrationId);
  validateSiwcClientId(record.clientId);
  if (record.clientId === 'dynamic_agent_client') throw new Error('Invalid SIWC issued client ID.');
  assertGeneration(record.generation);
  validateSiwcHostId(record.owner?.hostId);
  validateSiwcRuntimeId(record.owner?.runtimeId);
  if (record.identity?.issuer !== ISSUER || typeof record.identity?.subject !== 'string' ||
      !record.identity.subject || record.identity.subject.length > 512 ||
      record.identity.email !== undefined &&
      (typeof record.identity.email !== 'string' || record.identity.email.length > 256)) throw new Error('Invalid SIWC identity.');
  const session = record.session;
  if (!session || typeof session !== 'object' || Array.isArray(session) ||
      (session.accessToken !== undefined && (typeof session.accessToken !== 'string' || !session.accessToken || session.accessToken.length > 8192)) ||
      (session.refreshToken !== undefined && (typeof session.refreshToken !== 'string' || !session.refreshToken || session.refreshToken.length > 8192)) ||
      (session.idToken !== undefined && (typeof session.idToken !== 'string' || !session.idToken || session.idToken.length > 16384)) ||
      (session.scopes !== undefined && (!Array.isArray(session.scopes) || session.scopes.length > 64 ||
        session.scopes.some(scope => typeof scope !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/u.test(scope)))) ||
      (session.accessToken !== undefined && (!['Bearer', 'bearer'].includes(session.tokenType) ||
        !Number.isSafeInteger(session.receivedAt) || !Number.isSafeInteger(session.expiresIn) ||
        !Number.isSafeInteger(session.expiresAt) || session.expiresAt !== session.receivedAt + session.expiresIn * 1000)) ||
      (session.identityOnly === true && session.accessToken !== undefined) ||
      (session.reauthorize === true && (session.accessToken !== undefined || session.refreshToken !== undefined)) ||
      (session.refreshUncertain !== undefined && typeof session.refreshUncertain !== 'boolean') ||
      (session.refreshUncertain === true && record.planEnabled) ||
      (session.verificationPending !== undefined && typeof session.verificationPending !== 'boolean') ||
      (session.verificationPending === true && (!session.refreshUncertain ||
        typeof session.pendingIdToken !== 'boolean' || typeof session.resumePlanEnabled !== 'boolean' ||
        session.pendingIdToken && !session.idToken)) ||
      (record.planEnabled && (!session.accessToken || !session.scopes?.includes('chatgpt.tokens.use.direct')))) throw new Error('Invalid SIWC session.');
  if (record.handoff.state === 'handoff-pending') {
    const binding = record.handoff.binding;
    if (typeof record.handoff.exported !== 'boolean' ||
        typeof record.handoff.handoffId !== 'string' || !/^[0-9a-f-]{36}$/iu.test(record.handoff.handoffId) ||
        typeof record.handoff.proofSecret !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(record.handoff.proofSecret) ||
        binding?.registrationId !== record.registrationId || binding.clientId !== record.clientId ||
        binding.source?.hostId !== record.owner.hostId || binding.source.runtimeId !== record.owner.runtimeId)
      throw new Error('Invalid SIWC handoff.');
    validateHandoffBinding(binding);
  }
  if (record.handoff.state === 'transferred' &&
      (record.handoff.handoffId !== undefined || record.handoff.receipt !== undefined)) {
    const receipt = validateHandoffReceipt(record.handoff.receipt);
    if (receipt.handoffId !== record.handoff.handoffId ||
        receipt.binding.registrationId !== record.registrationId ||
        receipt.binding.clientId !== record.clientId ||
        receipt.binding.source.hostId !== record.owner.hostId ||
        receipt.binding.source.runtimeId !== record.owner.runtimeId ||
        record.session.accessToken || record.session.refreshToken || record.session.idToken)
      throw new Error('Invalid transferred SIWC handoff.');
  }
  if (record.acceptedHandoff !== undefined) {
    const accepted = record.acceptedHandoff;
    if (!accepted || typeof accepted !== 'object' ||
        Object.keys(accepted).sort().join(',') !== 'binding,handoffId,receipt')
      throw new Error('Invalid accepted SIWC handoff.');
    validateHandoffReceipt(accepted.receipt);
    assertGeneration(accepted.handoffId);
    validateHandoffBinding(accepted.binding);
    if (accepted.binding.registrationId !== record.registrationId ||
        accepted.binding.clientId !== record.clientId ||
        accepted.binding.target.hostId !== record.owner.hostId ||
        accepted.binding.target.runtimeId !== record.owner.runtimeId ||
        accepted.receipt.handoffId !== accepted.handoffId ||
        JSON.stringify(accepted.receipt.binding) !== JSON.stringify(accepted.binding) ||
        typeof accepted.receipt.proof !== 'string' ||
        !/^[A-Za-z0-9_-]{43}$/u.test(accepted.receipt.proof))
      throw new Error('Invalid accepted SIWC receipt.');
  }
  return record;
}
function account(record) {
  return {
    registrationId: record.registrationId, label: record.label,
    ...(record.identity.email ? { email: record.identity.email } : {}),
    identity: 'verified',
    session: record.session?.reauthorize || record.session?.refreshUncertain ? 'reauthorize'
      : record.session?.accessToken || record.session?.identityOnly ? 'connected' : 'signed-out',
    planPermission: record.session?.accessToken && record.session?.scopes?.includes('chatgpt.tokens.use.direct') ? 'granted' : 'not-granted',
    planEnabled: !!record.planEnabled,
    ownership: record.handoff?.state ?? 'owned', generation: record.generation,
    ownerHostId: record.owner.hostId, ownerRuntimeId: record.owner.runtimeId,
    needsPlanWelcome: !!record.planEnabled && !record.planAcknowledged,
  };
}
export async function ensureSiwcHost({ storageRoot, runtimeId }, deps = {}) {
  const root = rootOf(storageRoot), cfg = settings(deps);
  validateSiwcRuntimeId(runtimeId);
  return locked(root, 'hostidentity', cfg, async cfg => {
    const path = join(root, 'host.json');
    let host = await readFile(path, cfg);
    if (!host) {
      host = { schemaVersion: 1, hostId: `urn:uuid:${randomUUID()}` };
      await atomicFile(path, host, cfg);
    }
    if (host.schemaVersion !== 1) throw new Error('Invalid SIWC host identity.');
    return { hostId: validateSiwcHostId(host.hostId), runtimeId };
  });
}
export async function readSiwcHost({ storageRoot, runtimeId }, deps = {}) {
  const root = rootOf(storageRoot), cfg = settings(deps);
  validateSiwcRuntimeId(runtimeId);
  await assertSafePath(root, 'directory', cfg);
  const host = await readFile(join(root, 'host.json'), cfg);
  if (host?.schemaVersion !== 1) throw new Error('SIWC host identity is missing or invalid.');
  return { hostId: validateSiwcHostId(host.hostId), runtimeId };
}
export async function readRegistration({ storageRoot, registrationId }, deps = {}) {
  const cfg = settings(deps), root = rootOf(storageRoot);
  validateSiwcRegistrationId(registrationId);
  await ensureRoot(root, cfg);
  const record = await readFile(fileOf(root, registrationId), cfg);
  if (record?.kind === 'pending') {
    validatePending(record, registrationId);
    return null;
  }
  return record ? validateRecord(record, registrationId) : null;
}
export async function readPendingSiwcRegistration({ storageRoot, registrationId }, deps = {}) {
  const cfg = settings(deps), root = rootOf(storageRoot);
  validateSiwcRegistrationId(registrationId);
  await ensureRoot(root, cfg);
  const record = await readFile(fileOf(root, registrationId), cfg);
  if (!record) return null;
  return record.kind === 'pending' ? validatePending(record, registrationId) : null;
}
function viewOf(record, registrationId) {
  return record.kind === 'pending'
    ? pendingAccount(validatePending(record, registrationId))
    : account(validateRecord(record, registrationId));
}
export async function readRegistrationView({ storageRoot, registrationId }, deps = {}) {
  const cfg = settings(deps), root = rootOf(storageRoot);
  validateSiwcRegistrationId(registrationId);
  await ensureRoot(root, cfg);
  const record = await readFile(fileOf(root, registrationId), cfg);
  return record ? viewOf(record, registrationId) : null;
}
export async function listRegistrations({ storageRoot } = {}, deps = {}) {
  const cfg = settings(deps), root = rootOf(storageRoot);
  await ensureRoot(root, cfg);
  const entries = await cfg.fileSystem.readdir(join(root, 'registrations'));
  const result = [];
  for (const name of entries) {
    if (!name.endsWith('.json')) continue;
    const id = name.slice(0, -5);
    validateSiwcRegistrationId(id);
    const record = await readFile(fileOf(root, id), cfg);
    if (record) result.push(viewOf(record, id));
  }
  return result;
}
export async function getSelectedRegistration({ storageRoot } = {}, deps = {}) {
  const cfg = settings(deps), root = rootOf(storageRoot);
  await ensureRoot(root, cfg);
  const selected = await readFile(join(root, 'selection.json'), cfg);
  if (!selected) return null;
  validateSiwcRegistrationId(selected.registrationId);
  const account = await readRegistration({ storageRoot: root, registrationId: selected.registrationId }, deps);
  return account?.handoff.state === 'owned' ? selected.registrationId : null;
}
export async function selectRegistration({ storageRoot, registrationId }, deps = {}) {
  const cfg = settings(deps), root = rootOf(storageRoot);
  const account = await readRegistration({ storageRoot: root, registrationId }, deps);
  if (!account || account.handoff.state !== 'owned') throw new Error('The SIWC registration cannot be selected.');
  await ensureRoot(root, cfg);
  await atomicFile(join(root, 'selection.json'), { registrationId }, cfg);
  return registrationId;
}
async function mutate({ storageRoot, registrationId }, deps, fn, beforeCommit, allowPending = false) {
  const cfg = settings(deps), root = rootOf(storageRoot);
  return locked(root, registrationId, cfg, async cfg => {
    const path = fileOf(root, registrationId);
    const previous = await readFile(path, cfg);
    let current = null;
    if (previous) current = previous.kind === 'pending' && allowPending
      ? validatePending(previous, registrationId) : validateRecord(previous, registrationId);
    if (current) {
      const host = await readSiwcHost({ storageRoot: root, runtimeId: current.owner.runtimeId }, deps);
      if (host.hostId !== current.owner.hostId) throw new Error('SIWC registration belongs to another host.');
    }
    const outcome = await fn(current, cfg, root);
    if (!outcome) return null;
    const next = { ...outcome, generation: randomUUID() };
    validateRecord(next, registrationId);
    await atomicFile(path, next, cfg, beforeCommit);
    return account(next);
  });
}
async function rejectDuplicateClient(root, registrationId, clientId, cfg) {
  for (const name of await cfg.fileSystem.readdir(join(root, 'registrations'))) {
    if (!name.endsWith('.json')) continue;
    const otherId = validateSiwcRegistrationId(name.slice(0, -5));
    if (otherId === registrationId) continue;
    const other = await readFile(fileOf(root, otherId), cfg);
    if (other && (other.kind === 'pending' ? validatePending(other, otherId) : validateRecord(other, otherId)).clientId === clientId)
      throw new Error('This issued ChatGPT client already belongs to a different registration.');
  }
}
export async function reserveSiwcClient({ storageRoot, registrationId = randomUUID(), clientId, runtimeId }, deps = {}) {
  validateSiwcRegistrationId(registrationId);
  validateSiwcClientId(clientId);
  if (clientId === 'dynamic_agent_client') throw new Error('An issued SIWC client ID is required.');
  const cfg = settings(deps), root = rootOf(storageRoot);
  const host = await readSiwcHost({ storageRoot: root, runtimeId }, deps);
  return locked(root, 'identitymap', cfg, async cfg => {
    await rejectDuplicateClient(root, registrationId, clientId, cfg);
    return locked(root, registrationId, cfg, async cfg => {
      const path = fileOf(root, registrationId);
      if (await readFile(path, cfg)) throw new Error('SIWC registration already exists.');
      const pending = { schemaVersion: 1, kind: 'pending', registrationId,
        clientId, label: 'ChatGPT sign-in pending', generation: randomUUID(),
        createdAt: cfg.now(), owner: host };
      validatePending(pending, registrationId);
      await atomicFile(path, pending, cfg);
      return pending;
    });
  });
}
function normalizeTokens(tokens, now, old) {
  if (!tokens || typeof tokens !== 'object' || Array.isArray(tokens) ||
      !Number.isSafeInteger(now) || now < 0 ||
      (tokens.id_token !== undefined && (typeof tokens.id_token !== 'string' || !tokens.id_token || tokens.id_token.length > 16384)) ||
      (tokens.refresh_token !== undefined && (typeof tokens.refresh_token !== 'string' || !tokens.refresh_token || tokens.refresh_token.length > 8192)) ||
      (old && !tokens.refresh_token) ||
      (tokens.earliest_refresh_at !== undefined && !(typeof tokens.earliest_refresh_at === 'string' && tokens.earliest_refresh_at.length <= 256 ||
        typeof tokens.earliest_refresh_at === 'number' && Number.isFinite(tokens.earliest_refresh_at)))) throw new Error('Invalid SIWC token response.');
  const hasAccess = typeof tokens.access_token === 'string' && tokens.access_token.length > 0 && tokens.access_token.length <= 8192;
  if (tokens.access_token !== undefined && !hasAccess ||
      (hasAccess && (!Number.isSafeInteger(tokens.expires_in) || tokens.expires_in < 1 || tokens.expires_in > 86400 ||
        !['Bearer', 'bearer'].includes(tokens.token_type) || typeof tokens.scope !== 'string' || tokens.scope.length > 2048)) ||
      (!hasAccess && old)) throw new Error('Invalid SIWC token response.');
  const scopes = (tokens.scope ?? '').split(/\s+/u).filter(Boolean);
  if (scopes.length > 64 || scopes.some(scope => !/^[A-Za-z0-9_.:-]{1,128}$/u.test(scope)) ||
      (!hasAccess && scopes.includes('chatgpt.tokens.use.direct'))) throw new Error('Invalid SIWC granted scopes.');
  return { ...(hasAccess ? { accessToken: tokens.access_token, tokenType: tokens.token_type,
    expiresIn: tokens.expires_in, expiresAt: now + tokens.expires_in * 1000 } : { identityOnly: true }),
    ...(tokens.refresh_token ? { refreshToken: tokens.refresh_token } : {}),
    ...(tokens.id_token ?? old?.idToken ? { idToken: tokens.id_token ?? old.idToken } : {}),
    scopes, receivedAt: now,
    ...(tokens.earliest_refresh_at === undefined ? {} : { earliestRefreshAt: tokens.earliest_refresh_at }) };
}
export async function commitAuthorization({ storageRoot, registrationId = randomUUID(), expectedGeneration, clientId, identity, tokens, runtimeId, signal }, deps = {}) {
  validateSiwcClientId(clientId);
  validateSiwcRuntimeId(runtimeId);
  if (identity?.issuer !== ISSUER || typeof identity?.subject !== 'string' || !identity.subject || identity.subject.length > 512 ||
      (identity.email !== undefined && (typeof identity.email !== 'string' || identity.email.length > 256))) throw new Error('Invalid verified SIWC identity.');
  const host = await ensureSiwcHost({ storageRoot, runtimeId }, deps);
  const cfg = settings(deps), root = rootOf(storageRoot);
  return locked(root, 'identitymap', cfg, async cfg => {
    await rejectDuplicateClient(root, registrationId, clientId, cfg);
    return mutate({ storageRoot: root, registrationId }, cfg, (old, currentCfg) => {
      if (old && (old.clientId !== clientId || old.owner.hostId !== host.hostId ||
          old.owner.runtimeId !== runtimeId || old.generation !== expectedGeneration ||
          old.kind !== 'pending' && (old.identity.issuer !== identity.issuer ||
            old.identity.subject !== identity.subject || old.handoff.state !== 'owned')))
        throw new Error('SIWC registration changed; start a fresh sign-in.');
      if (!old && expectedGeneration !== undefined) throw new Error('Unknown SIWC registration.');
      const session = normalizeTokens(tokens, currentCfg.now());
      return { schemaVersion: 1, registrationId,
        label: old?.kind === 'pending' ? identity.email ?? `ChatGPT ${registrationId.slice(0, 8)}`
          : old?.label ?? identity.email ?? `ChatGPT ${registrationId.slice(0, 8)}`,
        clientId, identity: { issuer: identity.issuer, subject: identity.subject, ...(identity.email ? { email: identity.email } : {}) },
        owner: host, session, planEnabled: !!old?.planEnabled && session.scopes.includes('chatgpt.tokens.use.direct'),
        planAcknowledged: !!old?.planAcknowledged, backgroundConsent: old?.backgroundConsent ?? false,
        ...(old?.acceptedHandoff ? { acceptedHandoff: old.acceptedHandoff } : {}),
        handoff: { state: 'owned' } };
    }, () => {
      if (signal?.aborted) throw new Error('SIWC sign-in attempt was cancelled.');
    }, true);
  });
}
export async function setPlanEnabled(registration, { enabled, expectedGeneration }, deps = {}) {
  if (typeof enabled !== 'boolean') throw new TypeError('Invalid SIWC plan setting.');
  return mutate(registration, deps, old => {
    if (!old || old.generation !== expectedGeneration) throw new Error('SIWC registration changed.');
    if (enabled && old.session?.refreshUncertain)
      throw Object.assign(new Error('ChatGPT refresh outcome is uncertain. Sign in again.'), { recovery: 'reauthorize' });
    if (old.handoff.state !== 'owned' || (enabled && (!old.session?.accessToken || !old.session.scopes.includes('chatgpt.tokens.use.direct')))) throw new Error('ChatGPT plan permission is not available.');
    return { ...old, planEnabled: enabled,
      ...(!enabled && old.session?.verificationPending
        ? { session: { ...old.session, resumePlanEnabled: false } } : {}) };
  });
}
export async function acknowledgePlanUse(registration, { expectedGeneration } = {}, deps = {}) {
  return mutate(registration, deps, old => {
    if (!old || old.generation !== expectedGeneration || !old.planEnabled || old.handoff.state !== 'owned') throw new Error('ChatGPT plan use is unavailable.');
    return { ...old, planAcknowledged: true };
  });
}
function networkSignal(cfg, timeoutMs) {
  cfg.checkLock?.();
  return cfg.signal ? AbortSignal.any([cfg.signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs);
}
export async function getSiwcDiscovery(deps = {}) {
  const cfg = settings(deps);
  const response = await cfg.fetchImpl(`${ISSUER}/.well-known/openid-configuration`, { signal: networkSignal(cfg, 5000) });
  if (!response.ok) throw new Error('OpenAI discovery is unavailable.');
  const metadata = await readSiwcJson(response);
  if (metadata?.issuer !== ISSUER || metadata.authorization_endpoint !== `${ISSUER}/api/accounts/authorize` ||
      metadata.token_endpoint !== `${ISSUER}/api/accounts/oauth/token` || metadata.jwks_uri !== `${ISSUER}/.well-known/jwks.json` ||
      (metadata.revocation_endpoint !== undefined && (typeof metadata.revocation_endpoint !== 'string' ||
        !metadata.revocation_endpoint.startsWith(`${ISSUER}/`) || new URL(metadata.revocation_endpoint).origin !== ISSUER))) throw new Error('OpenAI discovery does not match the supported issuer.');
  return metadata;
}
export async function verifySiwcIdToken(idToken, { clientId, nonce, subject, metadata }, deps = {}) {
  validateSiwcClientId(clientId);
  if (typeof idToken !== 'string' || idToken.length < 20 || idToken.length > 16384 ||
      (nonce !== undefined && (typeof nonce !== 'string' || nonce.length < 32)) ||
      (subject !== undefined && (typeof subject !== 'string' || !subject))) throw new Error('Invalid SIWC ID token.');
  const cfg = settings(deps);
  const discovery = metadata ?? await getSiwcDiscovery(deps);
  if (discovery.issuer !== ISSUER || discovery.jwks_uri !== `${ISSUER}/.well-known/jwks.json`) throw new Error('Invalid OpenAI verification metadata.');
  let response, jwks;
  try {
    response = await cfg.fetchImpl(discovery.jwks_uri, { signal: networkSignal(cfg, 5000) });
    if (!response.ok) throw new Error('OpenAI signing keys are unavailable.');
    jwks = await readSiwcJson(response);
  } catch {
    throw Object.assign(new Error('OpenAI signing keys are temporarily unavailable.'), { verificationUnavailable: true });
  }
  const { payload } = await jwtVerify(idToken, createLocalJWKSet(jwks), {
    issuer: ISSUER, audience: clientId, clockTolerance: 5,
    requiredClaims: ['sub', 'exp', 'iat', ...(nonce === undefined ? [] : ['nonce'])],
    algorithms: ['RS256', 'ES256'],
  });
  if (payload.aud !== clientId || typeof payload.sub !== 'string' || !payload.sub ||
      payload.sub.length > 512 || !Number.isInteger(payload.iat) ||
      payload.iat > Math.floor(cfg.now() / 1000) + 5 ||
      nonce !== undefined && payload.nonce !== nonce ||
      subject !== undefined && payload.sub !== subject ||
      payload.email !== undefined && (typeof payload.email !== 'string' || payload.email.length > 256)) throw new Error('SIWC ID token claims do not match.');
  return payload;
}
async function tokenRequest(form, cfg, metadata) {
  let response;
  cfg.checkLock?.();
  try { response = await cfg.fetchImpl(metadata.token_endpoint, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams(form), signal: networkSignal(cfg, 10000) }); }
  catch { throw Object.assign(new Error('ChatGPT refresh outcome is uncertain. Sign in again before plan use.'), { recovery: 'reauthorize', rotationUncertain: true }); }
  if (!response.ok) {
    let code;
    try { code = (await readSiwcJson(response))?.error; } catch { /* Keep token response private. */ }
    if (typeof code !== 'string' || !/^[A-Za-z0-9_:-]{1,128}$/u.test(code)) code = undefined;
    const terminal = TERMINAL.has(code);
    throw Object.assign(new Error(terminal ? 'ChatGPT sign-in must be renewed.' : 'OpenAI token service rejected the request.'),
      { recovery: terminal ? 'reauthorize' : code === 'invalid_client' ? 'fix-configuration' : 'retry-later',
        terminal, definiteNonRotating: response.status === 503 && code === 'temporarily_unavailable',
        ...(code ? { code } : {}), status: response.status,
        ...(response.headers?.get('x-request-id')?.match(/^[A-Za-z0-9_-]{1,128}$/u)
          ? { requestId: response.headers.get('x-request-id') } : {}) });
  }
  try { return { tokens: await readSiwcJson(response), metadata }; }
  catch { throw Object.assign(new Error('ChatGPT session rotation could not be verified.'), { recovery: 'reauthorize', rotationUncertain: true }); }
}
async function blockCandidate(record, path, cfg) {
  await atomicFile(path, { ...record, generation: randomUUID(),
    session: { ...record.session, verificationPending: false,
      pendingIdToken: false, resumePlanEnabled: false } }, cfg);
}
async function completeCandidate(record, path, cfg, minValidityMs, signal, knownMetadata) {
  const pending = record.session;
  if (signal?.aborted) throw signal.reason;
  if (pending.pendingIdToken) {
    let metadata = knownMetadata;
    if (!metadata) {
      try { metadata = await getSiwcDiscovery(cfg); }
      catch { throw Object.assign(new Error('OpenAI verification is temporarily unavailable.'), { recovery: 'retry-later' }); }
    }
    try {
      await verifySiwcIdToken(pending.idToken,
        { clientId: record.clientId, subject: record.identity.subject, metadata }, cfg);
    } catch (error) {
      if (error?.verificationUnavailable)
        throw Object.assign(new Error('OpenAI verification is temporarily unavailable.'), { recovery: 'retry-later' });
      await blockCandidate(record, path, cfg);
      throw Object.assign(new Error('ChatGPT identity changed during refresh.'), { recovery: 'reauthorize' });
    }
  }
  if (pending.expiresAt - cfg.now() <= minValidityMs) {
    await blockCandidate(record, path, cfg);
    throw Object.assign(new Error('ChatGPT refreshed access expires too soon. Sign in again.'), { recovery: 'reauthorize' });
  }
  const resumePlanEnabled = pending.resumePlanEnabled;
  const verifiedSession = { ...pending };
  delete verifiedSession.refreshUncertain;
  delete verifiedSession.verificationPending;
  delete verifiedSession.pendingIdToken;
  delete verifiedSession.resumePlanEnabled;
  const next = { ...record, generation: randomUUID(), session: verifiedSession,
    planEnabled: resumePlanEnabled && verifiedSession.scopes.includes('chatgpt.tokens.use.direct') };
  await atomicFile(path, next, cfg);
  if (signal?.aborted) throw signal.reason;
  if (!next.planEnabled) throw Object.assign(new Error('ChatGPT plan permission was removed.'), { recovery: 'enable-plan' });
  if (verifiedSession.expiresAt - cfg.now() <= minValidityMs) {
    await atomicFile(path, { ...next, generation: randomUUID(),
      session: { ...verifiedSession, refreshUncertain: true }, planEnabled: false }, cfg);
    throw Object.assign(new Error('ChatGPT refreshed access expires too soon.'), { recovery: 'reauthorize' });
  }
  return { accessToken: next.session.accessToken, expiresAt: next.session.expiresAt, generation: next.generation };
}
export async function getAccessToken({ storageRoot, registrationId }, { runtimeId, minValidityMs = 60000, signal } = {}, deps = {}) {
  validateSiwcRuntimeId(runtimeId);
  if (!Number.isSafeInteger(minValidityMs) || minValidityMs < 0 || minValidityMs > 3600000) throw new TypeError('Invalid SIWC token validity.');
  const cfg = settings({ ...deps, signal: signal && deps.signal ? AbortSignal.any([signal, deps.signal]) : signal ?? deps.signal }), root = rootOf(storageRoot);
  const host = await readSiwcHost({ storageRoot: root, runtimeId }, deps);
  return locked(root, registrationId, cfg, async cfg => {
    const path = fileOf(root, registrationId);
    const record = validateRecord(await readFile(path, cfg), registrationId);
    if (record.owner.hostId !== host.hostId || record.owner.runtimeId !== runtimeId || record.handoff.state !== 'owned')
      throw Object.assign(new Error('SIWC account belongs to another runtime.'), { recovery: 'resolve-handoff' });
    cfg.callerSignal?.throwIfAborted();
    const protectedCfg = { ...cfg, signal: cfg.holderSignal, callerSignal: null };
    if (record.session?.verificationPending)
      return completeCandidate(record, path, protectedCfg, minValidityMs, protectedCfg.signal);
    if (record.session?.reauthorize || record.session?.refreshUncertain ||
        !record.session?.accessToken && !record.session?.identityOnly)
      throw Object.assign(new Error('ChatGPT sign-in must be renewed.'), { recovery: 'reauthorize' });
    if (!record.planEnabled || !record.session?.scopes?.includes('chatgpt.tokens.use.direct'))
      throw Object.assign(new Error('ChatGPT plan permission is not enabled.'), { recovery: 'enable-plan' });
    cfg.callerSignal?.throwIfAborted();
    const session = record.session;
    if (session.accessToken && session.expiresAt - cfg.now() > minValidityMs) return { accessToken: session.accessToken, expiresAt: session.expiresAt, generation: record.generation };
    if (!session.refreshToken) throw Object.assign(new Error('ChatGPT sign-in must be renewed.'), { recovery: 'reauthorize' });
    let metadata;
    try { metadata = await getSiwcDiscovery(cfg); }
    catch { throw Object.assign(new Error('OpenAI discovery is temporarily unavailable.'), { recovery: 'retry-later' }); }
    cfg.callerSignal?.throwIfAborted();
    // Persist the freeze before any refresh POST. A later write failure must not
    // allow another process to replay a refresh token whose rotation is unknown.
    const frozen = { ...record, generation: randomUUID(),
      session: { ...session, refreshUncertain: true }, planEnabled: false };
    await atomicFile(path, frozen, protectedCfg, () => cfg.callerSignal?.throwIfAborted());
    if (cfg.callerSignal?.aborted) {
      await atomicFile(path, { ...record, generation: randomUUID() }, protectedCfg);
      throw cfg.callerSignal.reason;
    }
    let rotation;
    try {
      rotation = await tokenRequest({ grant_type: 'refresh_token', client_id: record.clientId,
        refresh_token: session.refreshToken, resource: RESOURCE }, protectedCfg, metadata);
    } catch (error) {
      if (error.definiteNonRotating)
        await atomicFile(path, { ...record, generation: randomUUID() }, protectedCfg);
      else if (error.terminal) await atomicFile(path, { ...frozen, generation: randomUUID(),
        session: { reauthorize: true } }, protectedCfg);
      throw error;
    }
    let nextSession;
    try { nextSession = normalizeTokens(rotation.tokens, cfg.now(), session); }
    catch { throw Object.assign(new Error('ChatGPT session rotation could not be verified.'), { recovery: 'reauthorize' }); }
    // A mismatched returned client can never become a retryable candidate.
    // Persist R1 for revocation, but keep its owner permanently blocked.
    const clientMismatch = rotation.tokens.client_id !== undefined &&
      rotation.tokens.client_id !== record.clientId;
    const candidate = { ...frozen, generation: randomUUID(),
      session: clientMismatch ? { ...nextSession, refreshUncertain: true }
        : { ...nextSession, refreshUncertain: true, verificationPending: true,
          pendingIdToken: !!rotation.tokens.id_token, resumePlanEnabled: record.planEnabled } };
    await atomicFile(path, candidate, protectedCfg);
    if (clientMismatch)
      throw Object.assign(new Error('SIWC rotating client changed.'), { recovery: 'reauthorize' });
    return completeCandidate(candidate, path, protectedCfg, minValidityMs, protectedCfg.signal, metadata);
  });
}
function validateThreadBinding(binding, record) {
  if (!binding || typeof binding !== 'object' || Object.keys(binding).sort().join(',') !== 'identity,model,threadId' ||
      !binding.identity || typeof binding.identity !== 'object' ||
      Object.keys(binding.identity).sort().join(',') !== 'clientId,issuer,subject' ||
      typeof binding.threadId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/u.test(binding.threadId) ||
      typeof binding.model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u.test(binding.model) ||
      binding.identity.issuer !== record.identity.issuer ||
      binding.identity.clientId !== record.clientId ||
      binding.identity.subject !== record.identity.subject) throw new Error('Invalid SIWC thread binding.');
  return binding;
}
async function ownedThreadRecord(root, registrationId, runtimeId, cfg, deps) {
  const record = validateRecord(await readFile(fileOf(root, registrationId), cfg), registrationId);
  const host = await readSiwcHost({ storageRoot: root, runtimeId }, deps);
  if (record.owner.hostId !== host.hostId || record.owner.runtimeId !== runtimeId ||
      record.handoff.state !== 'owned' || !record.planEnabled || !record.session?.accessToken)
    throw new Error('SIWC thread session is not owned or enabled here.');
  return record;
}
async function threadStorage(root, registrationId, record, cfg) {
  await directory(join(root, 'threads'), cfg);
  const path = join(root, 'threads', `${validateSiwcRegistrationId(registrationId)}.json`);
  const saved = await readFile(path, cfg);
  if (!saved) return { path, bindings: [] };
  if (saved.schemaVersion !== 1 || saved.registrationId !== registrationId ||
      saved.owner?.hostId !== record.owner.hostId || saved.owner.runtimeId !== record.owner.runtimeId ||
      !Array.isArray(saved.bindings) || saved.bindings.length > 1024) throw new Error('Invalid SIWC thread storage.');
  const ids = new Set();
  for (const binding of saved.bindings) {
    validateThreadBinding(binding, record);
    if (ids.has(binding.threadId)) throw new Error('Duplicate SIWC thread binding.');
    ids.add(binding.threadId);
  }
  return { path, bindings: saved.bindings };
}
export async function listSiwcThreadBindings({ storageRoot, registrationId }, { runtimeId } = {}, deps = {}) {
  validateSiwcRuntimeId(runtimeId);
  const cfg = settings(deps), root = rootOf(storageRoot);
  return locked(root, registrationId, cfg, async cfg => {
    const record = await ownedThreadRecord(root, registrationId, runtimeId, cfg, deps);
    return (await threadStorage(root, registrationId, record, cfg)).bindings;
  });
}
export async function recordSiwcThreadBinding({ storageRoot, registrationId },
  { runtimeId, threadId, model, identity } = {}, deps = {}) {
  validateSiwcRuntimeId(runtimeId);
  const cfg = settings(deps), root = rootOf(storageRoot);
  return locked(root, registrationId, cfg, async cfg => {
    const record = await ownedThreadRecord(root, registrationId, runtimeId, cfg, deps);
    validateThreadBinding({ threadId, model, identity }, record);
    const { path, bindings } = await threadStorage(root, registrationId, record, cfg);
    const existing = bindings.find(item => item.threadId === threadId);
    if (existing) {
      if (existing.model !== model) throw new Error('SIWC thread belongs to another model.');
      return existing;
    }
    if (bindings.length === 1024) throw new Error('SIWC thread binding limit reached.');
    await atomicFile(path, { schemaVersion: 1, registrationId, owner: record.owner,
      bindings: [...bindings, { threadId, model,
        identity: { issuer: record.identity.issuer, clientId: record.clientId,
          subject: record.identity.subject } }] }, cfg);
    return { threadId, model, identity: { issuer: record.identity.issuer,
      clientId: record.clientId, subject: record.identity.subject } };
  });
}
export async function signOut(registration, { runtimeId }, deps = {}) {
  validateSiwcRuntimeId(runtimeId);
  const cfg = settings(deps), root = rootOf(registration.storageRoot);
  let revocation = 'not-applicable';
  const host = await readSiwcHost({ storageRoot: root, runtimeId }, deps);
  const accountView = await locked(root, registration.registrationId, cfg, async cfg => {
    const path = fileOf(root, registration.registrationId);
    const record = validateRecord(await readFile(path, cfg), registration.registrationId);
    if (record.owner.hostId !== host.hostId || record.owner.runtimeId !== runtimeId || record.handoff.state !== 'owned') throw new Error('SIWC session belongs to another runtime.');
    const refreshToken = record.session?.refreshToken;
    if (refreshToken) {
      revocation = 'unconfirmed';
      try {
        const metadata = await getSiwcDiscovery(cfg);
        if (typeof metadata.revocation_endpoint === 'string') {
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              cfg.checkLock?.();
              const response = await cfg.fetchImpl(metadata.revocation_endpoint, {
                method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' },
                body: new URLSearchParams({ token: refreshToken, token_type_hint: 'refresh_token', client_id: record.clientId }),
                signal: networkSignal(cfg, 5000),
              });
              if (response.status === 200) {
                if (!record.session.refreshUncertain) revocation = 'confirmed';
                break;
              }
              if (response.status < 500) break;
            } catch { /* Bounded retry of uncertain network result. */ }
            if (attempt < 2) await pause(100 * (attempt + 1));
          }
        }
      } catch { /* Local sign-out remains mandatory even when revocation is uncertain. */ }
    }
    const next = { ...record, generation: randomUUID(), session: {}, planEnabled: false, backgroundConsent: false };
    await atomicFile(path, next, cfg);
    return account(next);
  });
  return { account: accountView, revocation };
}
function proof(secret, handoffId, binding) {
  return createHmac('sha256', Buffer.from(secret, 'base64url')).update(JSON.stringify({ handoffId, binding })).digest('base64url');
}
export async function prepareAuthHandoff(registration, { expectedGeneration, target, backgroundConsent }, deps = {}) {
  const destination = assertTarget(target);
  assertGeneration(expectedGeneration);
  if (!validConsent(backgroundConsent)) throw new TypeError('Invalid SIWC background consent.');
  let result;
  await mutate(registration, deps, old => {
    if (!old || old.generation !== expectedGeneration || old.handoff.state !== 'owned' || !old.session?.refreshToken ||
        !old.planEnabled || !old.session.scopes.includes('chatgpt.tokens.use.direct') ||
        old.owner.hostId === destination.hostId) throw new Error('SIWC session cannot be transferred.');
    const handoffId = randomUUID();
    const binding = { registrationId: old.registrationId, clientId: old.clientId, generation: old.generation,
      source: old.owner, target: destination, backgroundConsent };
    result = { handoffId, binding };
    return { ...old, handoff: { state: 'handoff-pending', handoffId, binding,
      proofSecret: randomBytes(32).toString('base64url'), exported: false }, backgroundConsent };
  });
  return result;
}
export async function readAuthHandoff(registration, { handoffId, expectedGeneration }, deps = {}) {
  assertGeneration(handoffId);
  assertGeneration(expectedGeneration);
  const cfg = settings(deps), root = rootOf(registration.storageRoot);
  return locked(root, registration.registrationId, cfg, async cfg => {
    const path = fileOf(root, registration.registrationId);
    const record = validateRecord(await readFile(path, cfg), registration.registrationId);
    const host = await readSiwcHost({ storageRoot: root, runtimeId: record.owner.runtimeId }, deps);
    if (record.owner.hostId !== host.hostId || record.handoff.state !== 'handoff-pending' ||
        record.handoff.exported || record.handoff.handoffId !== handoffId ||
        record.handoff.binding.generation !== expectedGeneration) throw new Error('SIWC handoff changed; transfer remains frozen.');
    const exported = { ...record, generation: randomUUID(), handoff: { ...record.handoff, exported: true } };
    const contents = Buffer.from(JSON.stringify({ schemaVersion: 1, handoffId, binding: exported.handoff.binding,
      proofSecret: exported.handoff.proofSecret, record: { ...exported, handoff: { state: 'owned' } } }));
    if (contents.length > MAX_FILE) throw new Error('SIWC handoff is too large.');
    await atomicFile(path, exported, cfg);
    return contents;
  });
}
async function readExistingRegistration(root, registrationId, cfg) {
  validateSiwcRegistrationId(registrationId);
  try {
    await assertSafePath(root, 'directory', cfg);
    await assertSafePath(join(root, 'registrations'), 'directory', cfg);
  } catch (error) {
    if (error?.code === 'ENOENT') return null;
    throw error;
  }
  const record = await readFile(fileOf(root, registrationId), cfg);
  if (record?.kind === 'pending') {
    validatePending(record, registrationId);
    return null;
  }
  return record ? validateRecord(record, registrationId) : null;
}
export async function readPendingAuthHandoff({ storageRoot, registrationId }, deps = {}) {
  const cfg = settings(deps), root = rootOf(storageRoot);
  const record = await readExistingRegistration(root, registrationId, cfg);
  if (record?.handoff.state !== 'handoff-pending') return null;
  const host = await readSiwcHost({ storageRoot: root, runtimeId: record.owner.runtimeId }, deps);
  if (host.hostId !== record.owner.hostId) throw new Error('SIWC registration belongs to another host.');
  return { handoffId: record.handoff.handoffId, binding: record.handoff.binding,
    target: record.handoff.binding.target,
    identity: { issuer: record.identity.issuer, clientId: record.clientId, subject: record.identity.subject } };
}
export async function readAuthHandoffReceipt({ storageRoot, registrationId },
  { runtimeId, handoffId, expectedTarget, expectedBinding, identity } = {}, deps = {}) {
  const cfg = settings(deps), root = rootOf(storageRoot);
  validateSiwcRegistrationId(registrationId);
  validateSiwcRuntimeId(runtimeId);
  assertGeneration(handoffId);
  const target = assertTarget(expectedTarget);
  const binding = validateHandoffBinding(expectedBinding);
  if (!identity || typeof identity !== 'object' ||
      Object.keys(identity).sort().join(',') !== 'clientId,issuer,subject' ||
      identity.issuer !== ISSUER || typeof identity.subject !== 'string' ||
      !identity.subject || identity.subject.length > 512 ||
      identity.clientId !== binding.clientId || binding.registrationId !== registrationId ||
      target.runtimeId !== runtimeId || binding.target.hostId !== target.hostId ||
      binding.target.runtimeId !== runtimeId) throw new Error('SIWC handoff receipt selection does not match.');
  const record = await readExistingRegistration(root, registrationId, cfg);
  if (!record) return null;
  const host = await readSiwcHost({ storageRoot: root, runtimeId }, deps);
  const accepted = record.acceptedHandoff;
  if (host.hostId !== target.hostId || record.owner.hostId !== target.hostId ||
      record.owner.runtimeId !== runtimeId || record.identity.issuer !== identity.issuer ||
      record.identity.subject !== identity.subject || record.clientId !== identity.clientId ||
      accepted?.handoffId !== handoffId ||
      JSON.stringify(accepted.binding) !== JSON.stringify(binding))
    throw new Error('SIWC handoff receipt does not match.');
  return accepted;
}
export async function acceptAuthHandoff({ storageRoot, runtimeId, expectedTarget, expectedRegistrationId, contents }, deps = {}) {
  const cfg = settings(deps), root = rootOf(storageRoot);
  validateSiwcRuntimeId(runtimeId);
  validateSiwcRegistrationId(expectedRegistrationId);
  const target = assertTarget(expectedTarget);
  if (!Buffer.isBuffer(contents) || contents.length > MAX_FILE || !contents.length) throw new Error('Invalid protected SIWC handoff.');
  let transfer;
  try { transfer = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(contents)); }
  catch { throw new Error('Invalid protected SIWC handoff.'); }
  const binding = validateHandoffBinding(transfer?.binding);
  // Reject before lock setup can create storage directories; recheck under the acceptance lock.
  if (binding.registrationId !== expectedRegistrationId) throw new Error('SIWC handoff registration does not match.');
  assertGeneration(transfer.handoffId);
  const record = validateRecord(transfer.record, binding.registrationId);
  if (transfer.schemaVersion !== 1 ||
      target.runtimeId !== runtimeId || binding.target?.hostId !== target.hostId || binding.target.runtimeId !== runtimeId ||
      binding.source?.hostId === target.hostId ||
      binding.registrationId !== record.registrationId || binding.clientId !== record.clientId || binding.generation === record.generation ||
      binding.source.hostId !== record.owner.hostId || binding.source.runtimeId !== record.owner.runtimeId ||
      record.handoff.state !== 'owned' ||
      typeof transfer.proofSecret !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(transfer.proofSecret) ||
      !record.session?.refreshToken) throw new Error('SIWC handoff target or account does not match.');
  return locked(root, 'identitymap', cfg, async cfg => {
    if (binding.registrationId !== expectedRegistrationId) throw new Error('SIWC handoff registration does not match.');
    const host = await readSiwcHost({ storageRoot: root, runtimeId }, deps);
    if (host.hostId !== target.hostId) throw new Error('SIWC destination host changed.');
    const receipt = { handoffId: transfer.handoffId, binding, proof: proof(transfer.proofSecret, transfer.handoffId, binding) };
    const acceptedHandoff = { handoffId: transfer.handoffId, binding, receipt };
    await rejectDuplicateClient(root, record.registrationId, record.clientId, cfg);
    await locked(root, record.registrationId, cfg, async cfg => {
      const path = fileOf(root, record.registrationId);
      if (await readFile(path, cfg)) throw new Error('Destination already has this SIWC registration.');
      const next = { ...record, owner: host, generation: randomUUID(), backgroundConsent: binding.backgroundConsent,
        handoff: { state: 'owned' }, acceptedHandoff };
      validateRecord(next, record.registrationId);
      await atomicFile(path, next, cfg);
    });
    return acceptedHandoff;
  });
}
export async function finishAuthHandoff(registration, { handoffId, receipt }, deps = {}) {
  assertGeneration(handoffId);
  validateHandoffReceipt(receipt);
  const cfg = settings(deps), root = rootOf(registration.storageRoot);
  return locked(root, registration.registrationId, cfg, async cfg => {
    const path = fileOf(root, registration.registrationId);
    const old = validateRecord(await readFile(path, cfg), registration.registrationId);
    const host = await readSiwcHost({ storageRoot: root, runtimeId: old.owner.runtimeId }, deps);
    if (old.owner.hostId !== host.hostId) throw new Error('SIWC registration belongs to another host.');
    const handoff = old.handoff;
    if (handoff.state === 'transferred' && handoff.handoffId === handoffId &&
        JSON.stringify(handoff.receipt) === JSON.stringify(receipt)) return account(old);
    if (!handoff || handoff.state !== 'handoff-pending' || !handoff.exported || handoff.handoffId !== handoffId ||
        receipt.handoffId !== handoffId || JSON.stringify(receipt.binding) !== JSON.stringify(handoff.binding))
      throw new Error('SIWC handoff receipt does not match.');
    const expected = Buffer.from(proof(handoff.proofSecret, handoffId, handoff.binding));
    const supplied = Buffer.from(receipt.proof);
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) throw new Error('SIWC handoff receipt does not match.');
    const next = { ...old, generation: randomUUID(), session: {}, planEnabled: false,
      handoff: { state: 'transferred', handoffId, receipt } };
    validateRecord(next, registration.registrationId);
    await atomicFile(path, next, cfg);
    return account(next);
  });
}

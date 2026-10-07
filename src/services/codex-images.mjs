// Opt-in, images-only Codex sign-in for the VPS ChatGPT sidecar. It uses the Codex CLI
// device flow, as Hermes Agent's "OpenAI (Codex auth)" provider does. OpenAI does not
// document this route for other apps, so it can stop working. Built-ins only: this file
// ships alone inside the sidecar image.
import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

export const CODEX_IMAGES_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
export const CODEX_IMAGES_VERIFICATION_URL = 'https://auth.openai.com/codex/device';
export const CODEX_IMAGES_MODEL = 'gpt-image-2';

const ISSUER = 'https://auth.openai.com';
const USER_CODE_URL = `${ISSUER}/api/accounts/deviceauth/usercode`;
const DEVICE_TOKEN_URL = `${ISSUER}/api/accounts/deviceauth/token`;
const TOKEN_URL = `${ISSUER}/oauth/token`;
const REVOKE_URL = `${ISSUER}/oauth/revoke`;
const REDIRECT_URI = `${ISSUER}/deviceauth/callback`;
const AUTH_TIMEOUT_MS = 20_000;
const REVOKE_TIMEOUT_MS = 10_000;
const PENDING_MS = 15 * 60_000;
const REFRESH_MARGIN_MS = 5 * 60_000;
const MAX_ACCESS_LIFETIME_MS = 366 * 24 * 3600_000;
const MAX_FILE = 64 * 1024;
const LOCK_STALE_MS = 120_000;
const LOCK_RETRY_MS = 100;
// Longer than the slowest holder (poll + exchange, 2 x 20 s), shorter than the installer's 90 s exec.
const LOCK_ATTEMPTS = 450;
const REAUTHORIZE_CODES = new Set(['refresh_token_expired', 'refresh_token_reused', 'refresh_token_invalidated']);
const LEASE_CODES = new Set(['images_off', 'images_reauthorize', 'images_unavailable']);
const USER_CODE = /^[A-Z0-9]{2,16}(?:-[A-Z0-9]{2,16}){0,3}$/u;
const OPAQUE = /^[!-~]{1,4096}$/u;
const TOKEN = /^[!-~]{1,16384}$/u;
const ACCOUNT = /^[A-Za-z0-9_-]{6,128}$/u;
const PLAN = /^[A-Za-z0-9_.-]{1,32}$/u;
const RESIDENCY = /^[a-z-]{1,16}$/u;
const EMAIL = /^[^\p{C}\s@]+@[^\p{C}\s@]+$/u;
const LEFTOVER_RECORD = /^(session|pending)\.json\.[0-9a-f-]{36}\.tmp$/u;
const AUTH_CLAIM = 'https://api.openai.com/auth';
const uid = process.getuid?.();

class CodexImagesError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}
// Messages are fixed text, so no token, code, verifier or upstream body can reach them.
const off = () => new CodexImagesError('images_off', 'Image generation is off. Sign in to Codex for images first.');
const reauthorize = () => new CodexImagesError('images_reauthorize', 'The Codex image sign-in expired. Sign in for images again.');
const unsafeStorage = () => new CodexImagesError('images_unavailable', 'Codex image sign-in storage is unsafe or invalid.');
const busy = () => new CodexImagesError('images_unavailable', 'Codex image sign-in is busy. Try again shortly.');
const refreshFailed = () => new CodexImagesError('images_unavailable', 'Codex image sign-in could not be refreshed. Try again later.');
const loginFailed = () => new CodexImagesError('images_login_failed', 'The Codex sign-in request failed. Try again.');
const startFailed = () => new CodexImagesError('images_login_failed',
  'The Codex sign-in request failed. Try again. If it keeps failing, check that device code sign-in is on in ChatGPT security settings.');
const deviceLoginDisabled = () => new CodexImagesError('images_device_login_disabled',
  'Codex device code sign-in is off for this account. Turn it on in ChatGPT security settings, or ask your workspace admin, then try again.');

const settings = (deps) => ({
  fetchImpl: deps?.fetchImpl ?? fetch,
  now: deps?.now ?? Date.now,
  fileSystem: deps?.fileSystem ?? fs,
  randomUUID: deps?.randomUUID ?? randomUUID,
  sleep: deps?.sleep ?? pause,
});
const iso = (ms) => new Date(ms).toISOString();
const isIso = (value) => typeof value === 'string' && value.length <= 32 && Number.isFinite(Date.parse(value));
const matches = (value, pattern) => typeof value === 'string' && pattern.test(value);
const isEmail = (value) => matches(value, EMAIL) && value.length <= 254;

function jwtClaims(token) {
  try {
    const parts = token.split('.');
    const claims = parts.length === 3 ? JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8')) : null;
    return claims && typeof claims === 'object' && !Array.isArray(claims) ? claims : {};
  } catch {
    return {};
  }
}
function authClaims(claims) {
  const value = claims[AUTH_CLAIM];
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

// --- Store: ${storageRoot}/codex-images/{session.json,pending.json,lock} ---

// Only sign-in creates the directory; without it every other call is simply off.
async function storeDirectory(storageRoot, cfg, create = false) {
  if (typeof storageRoot !== 'string' || !isAbsolute(storageRoot) || storageRoot.includes('\0') ||
      resolve(storageRoot) !== storageRoot) throw unsafeStorage();
  const directory = join(storageRoot, 'codex-images');
  try {
    if (create) {
      try { await cfg.fileSystem.mkdir(directory, { mode: 0o700 }); }
      catch (error) { if (error?.code !== 'EEXIST') throw error; }
    }
    assertOwned(await cfg.fileSystem.lstat(directory), 'directory');
  } catch (error) {
    if (!create && error?.code === 'ENOENT') return null;
    throw unsafeStorage();
  }
  return directory;
}
function assertOwned(stat, kind) {
  if (stat.isSymbolicLink() || (kind === 'file' ? !stat.isFile() || stat.nlink !== 1 : !stat.isDirectory()) ||
      (uid !== undefined && stat.uid !== uid) || (stat.mode & 0o077) !== 0) throw unsafeStorage();
  return stat;
}
async function readRecord(path, cfg) {
  try {
    let stat;
    try { stat = await cfg.fileSystem.lstat(path); }
    catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
    assertOwned(stat, 'file');
    if (stat.size === 0 || stat.size > MAX_FILE) throw unsafeStorage();
    const handle = await cfg.fileSystem.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = await handle.stat();
      if (opened.ino !== stat.ino || opened.dev !== stat.dev) throw unsafeStorage();
      const bytes = await handle.readFile();
      if (bytes.length > MAX_FILE) throw unsafeStorage();
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } finally {
      await handle.close();
    }
  } catch {
    throw unsafeStorage();
  }
}
async function writeRecord(path, value, cfg) {
  const bytes = Buffer.from(JSON.stringify(value));
  if (bytes.length > MAX_FILE) throw unsafeStorage();
  const temp = `${path}.${cfg.randomUUID()}.tmp`;
  try {
    const handle = await cfg.fileSystem.open(temp, 'wx', 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await cfg.fileSystem.rename(temp, path);
    const directory = await cfg.fileSystem.open(dirname(path), 'r');
    try { await directory.sync(); } finally { await directory.close(); }
  } catch {
    throw unsafeStorage();
  } finally {
    await cfg.fileSystem.rm(temp, { force: true }).catch(() => {});
  }
}
const removeRecord = (path, cfg) => cfg.fileSystem.rm(path, { force: true }).catch(() => { throw unsafeStorage(); });

function validSession(value) {
  return Boolean(value && typeof value === 'object' && value.schemaVersion === 1 &&
    value.clientId === CODEX_IMAGES_CLIENT_ID && matches(value.accountId, ACCOUNT) &&
    (value.email === undefined || isEmail(value.email)) && (value.planType === undefined || matches(value.planType, PLAN)) &&
    matches(value.accessToken, TOKEN) && matches(value.refreshToken, TOKEN) &&
    isIso(value.accessExpiresAt) && isIso(value.obtainedAt) && isIso(value.updatedAt) &&
    ['ok', 'in-flight', 'reauthorize'].includes(value.refreshState));
}
function validPending(value) {
  return Boolean(value && typeof value === 'object' && value.schemaVersion === 1 &&
    matches(value.deviceAuthId, OPAQUE) && matches(value.userCode, USER_CODE) &&
    Number.isSafeInteger(value.intervalSeconds) && value.intervalSeconds >= 5 && value.intervalSeconds <= 900 &&
    isIso(value.expiresAt) && isIso(value.createdAt) && isIso(value.nextPollAt));
}
async function readSession(directory, cfg) {
  const session = await readRecord(join(directory, 'session.json'), cfg);
  if (session !== null && !validSession(session)) throw unsafeStorage();
  return session;
}

// The lock holder keeps "in-flight" only while it holds the lock, so a holder that
// finds it left over knows a refresh crashed with an unknown rotation outcome.
async function lockedSession(directory, cfg) {
  const session = await readSession(directory, cfg);
  if (session?.refreshState !== 'in-flight') return session;
  const next = { ...session, refreshState: 'reauthorize', updatedAt: iso(cfg.now()) };
  await writeRecord(join(directory, 'session.json'), next, cfg);
  return next;
}
async function load(directory, cfg) {
  const session = await lockedSession(directory, cfg);
  const pendingPath = join(directory, 'pending.json');
  let pending = await readRecord(pendingPath, cfg);
  if (pending !== null && !validPending(pending)) throw unsafeStorage();
  let expired = false;
  if (pending && cfg.now() >= Date.parse(pending.expiresAt)) {
    await removeRecord(pendingPath, cfg);
    pending = null;
    expired = true;
  }
  return { session, pending, expired };
}
function statusOf({ session, pending }) {
  const account = session && {
    ...(session.email ? { email: session.email } : {}),
    ...(session.planType ? { planType: session.planType } : {}),
    accountIdSuffix: session.accountId.slice(-6),
  };
  if (session?.refreshState === 'ok') return { state: 'signed-in', account };
  if (pending) return { state: 'pending', pending: { userCode: pending.userCode, verificationUrl: CODEX_IMAGES_VERIFICATION_URL, expiresAt: pending.expiresAt } };
  if (session) return { state: 'reauthorize', account };
  return { state: 'off' };
}

async function lockAge(path, cfg) {
  let stat;
  try { stat = await cfg.fileSystem.lstat(path); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw error; }
  let createdAt = Number.NaN;
  if (stat.isFile() && stat.size <= 1024) {
    try { createdAt = Date.parse(JSON.parse(await cfg.fileSystem.readFile(path, 'utf8')).createdAt); }
    catch { /* A holder that crashed before writing falls back to the file time. */ }
  }
  if (!Number.isFinite(createdAt)) createdAt = stat.isFile() ? stat.mtimeMs : 0;
  return { ino: stat.ino, age: Math.abs(cfg.now() - createdAt) };
}
async function locked(directory, cfg, operation) {
  const path = join(directory, 'lock');
  let ino;
  for (let attempt = 0; ino === undefined; attempt++) {
    if (attempt > LOCK_ATTEMPTS) throw busy();
    let handle;
    try { handle = await cfg.fileSystem.open(path, 'wx', 0o600); }
    catch (error) {
      if (error?.code !== 'EEXIST') throw unsafeStorage();
      const held = await lockAge(path, cfg).catch(() => { throw unsafeStorage(); });
      if (held && held.age > LOCK_STALE_MS) {
        // ponytail: lstat-then-unlink can race a second stale taker by microseconds; stale locks only follow a crash.
        if ((await cfg.fileSystem.lstat(path).catch(() => null))?.ino === held.ino) await removeRecord(path, cfg);
      } else if (held) await cfg.sleep(LOCK_RETRY_MS);
      continue;
    }
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: iso(cfg.now()) }));
      ino = (await handle.stat()).ino;
    } catch {
      await cfg.fileSystem.rm(path, { force: true }).catch(() => {});
      throw unsafeStorage();
    } finally {
      await handle.close();
    }
  }
  try {
    return await operation();
  } finally {
    // A lock replaced as stale belongs to its new holder.
    if ((await cfg.fileSystem.lstat(path).catch(() => null))?.ino === ino)
      await cfg.fileSystem.rm(path, { force: true }).catch(() => {});
  }
}

// --- auth.openai.com ---

function post(cfg, url, body, { form = false, timeoutMs = AUTH_TIMEOUT_MS } = {}) {
  return cfg.fetchImpl(url, {
    method: 'POST',
    headers: { 'content-type': form ? 'application/x-www-form-urlencoded' : 'application/json', accept: 'application/json' },
    body: form ? new URLSearchParams(body) : JSON.stringify(body),
    redirect: 'error',
    signal: AbortSignal.timeout(timeoutMs),
  });
}
async function readJson(response) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Empty response.');
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_FILE) {
        await reader.cancel();
        throw new Error('Oversized response.');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks, total)));
}
async function errorCode(response) {
  try {
    const body = await readJson(response);
    const code = typeof body?.error === 'string' ? body.error : body?.error?.code ?? body?.code;
    return typeof code === 'string' ? code : undefined;
  } catch {
    return undefined;
  }
}
// Builds a session from a token response. A refresh keeps the stored account and
// refresh token unless the response rotates them.
function sessionFrom(tokens, now, previous) {
  if (!tokens || typeof tokens !== 'object' || !matches(tokens.access_token, TOKEN) ||
      (tokens.refresh_token !== undefined || !previous) && !matches(tokens.refresh_token, TOKEN) ||
      tokens.id_token !== undefined && !matches(tokens.id_token, TOKEN)) throw new Error('Invalid token response.');
  const id = jwtClaims(tokens.id_token), access = jwtClaims(tokens.access_token);
  const accountId = previous?.accountId ??
    [authClaims(id).chatgpt_account_id, authClaims(access).chatgpt_account_id].find(value => matches(value, ACCOUNT));
  const email = isEmail(id.email) ? id.email : previous?.email;
  const planType = [authClaims(id).chatgpt_plan_type, authClaims(access).chatgpt_plan_type]
    .find(value => matches(value, PLAN)) ?? previous?.planType;
  const expiresAt = Number.isSafeInteger(access.exp) ? access.exp * 1000
    : Number.isSafeInteger(tokens.expires_in) ? now + tokens.expires_in * 1000 : Number.NaN;
  if (!accountId || !(expiresAt > now && expiresAt <= now + MAX_ACCESS_LIFETIME_MS)) throw new Error('Invalid token response.');
  return {
    schemaVersion: 1, clientId: CODEX_IMAGES_CLIENT_ID, accountId,
    ...(email ? { email } : {}), ...(planType ? { planType } : {}),
    accessToken: tokens.access_token, refreshToken: tokens.refresh_token ?? previous.refreshToken,
    accessExpiresAt: iso(expiresAt), obtainedAt: iso(now), refreshState: 'ok', updatedAt: iso(now),
  };
}
async function exchange(grant, cfg) {
  let response;
  try {
    response = await post(cfg, TOKEN_URL, {
      grant_type: 'authorization_code', client_id: CODEX_IMAGES_CLIENT_ID, code: grant.authorization_code,
      redirect_uri: REDIRECT_URI, code_verifier: grant.code_verifier,
    }, { form: true });
    if (!response.ok) throw loginFailed();
    return sessionFrom(await readJson(response), cfg.now());
  } catch {
    throw loginFailed();
  }
}
// Single-use refresh tokens: "in-flight" is on disk before the POST, and any outcome
// that may have rotated the token without our seeing the result ends in "reauthorize".
async function refresh(directory, session, cfg) {
  const path = join(directory, 'session.json');
  const settle = (refreshState) => writeRecord(path, { ...session, refreshState, updatedAt: iso(cfg.now()) }, cfg);
  await settle('in-flight');
  let response;
  try {
    response = await post(cfg, TOKEN_URL, {
      client_id: CODEX_IMAGES_CLIENT_ID, grant_type: 'refresh_token', refresh_token: session.refreshToken,
    });
  } catch {
    await settle('reauthorize');
    throw reauthorize();
  }
  if (!response.ok) {
    const code = await errorCode(response);
    if (response.status === 401 || REAUTHORIZE_CODES.has(code) || response.status === 400 && code === 'invalid_grant') {
      await settle('reauthorize');
      throw reauthorize();
    }
    await settle('ok');
    throw refreshFailed();
  }
  let next;
  try { next = sessionFrom(await readJson(response), cfg.now(), session); }
  catch {
    await settle('reauthorize');
    throw reauthorize();
  }
  await writeRecord(path, next, cfg);
  return next;
}
function leaseOf(session) {
  const claims = authClaims(jwtClaims(session.accessToken));
  const residency = [claims.chatgpt_data_residency, claims.chatgpt_compute_residency].find(value => matches(value, RESIDENCY));
  return {
    accessToken: session.accessToken, accountId: session.accountId,
    ...(residency ? { residency } : {}), fedramp: claims.chatgpt_account_is_fedramp === true,
  };
}

// --- Public operations ---

export async function codexImagesStatus({ storageRoot } = {}, deps) {
  const cfg = settings(deps);
  const directory = await storeDirectory(storageRoot, cfg);
  if (!directory) return { state: 'off' };
  return locked(directory, cfg, async () => statusOf(await load(directory, cfg)));
}

export async function startCodexImagesLogin({ storageRoot } = {}, deps) {
  const cfg = settings(deps);
  const directory = await storeDirectory(storageRoot, cfg, true);
  return locked(directory, cfg, async () => {
    const { session } = await load(directory, cfg);
    if (session?.refreshState === 'ok')
      throw new CodexImagesError('images_signed_in', 'Codex image sign-in is already on. Sign out of images first.');
    let response;
    try { response = await post(cfg, USER_CODE_URL, { client_id: CODEX_IMAGES_CLIENT_ID }); }
    catch { throw startFailed(); }
    // Codex treats a 404 here as device code sign-in being off for the account or workspace.
    if (response.status === 404) throw deviceLoginDisabled();
    let body;
    try {
      if (!response.ok) throw startFailed();
      body = await readJson(response);
    } catch {
      throw startFailed();
    }
    const userCode = body?.user_code ?? body?.usercode;
    if (!matches(body?.device_auth_id, OPAQUE) || !matches(userCode, USER_CODE)) throw startFailed();
    const intervalSeconds = Math.min(900, Math.max(5, Number.parseInt(String(body.interval ?? '5'), 10) || 5));
    const now = cfg.now();
    const pending = {
      schemaVersion: 1, deviceAuthId: body.device_auth_id, userCode, intervalSeconds,
      expiresAt: iso(now + PENDING_MS), createdAt: iso(now), nextPollAt: iso(now + intervalSeconds * 1000),
    };
    await writeRecord(join(directory, 'pending.json'), pending, cfg);
    return statusOf({ session, pending });
  });
}

export async function pollCodexImagesLogin({ storageRoot } = {}, deps) {
  const cfg = settings(deps);
  const directory = await storeDirectory(storageRoot, cfg);
  if (!directory) return { state: 'off' };
  return locked(directory, cfg, async () => {
    const current = await load(directory, cfg);
    if (current.expired) return { ...statusOf(current), outcome: 'expired' };
    const { pending } = current;
    if (!pending || cfg.now() < Date.parse(pending.nextPollAt)) return statusOf(current);
    const pendingPath = join(directory, 'pending.json');
    await writeRecord(pendingPath, { ...pending, nextPollAt: iso(cfg.now() + pending.intervalSeconds * 1000) }, cfg);
    let response;
    try { response = await post(cfg, DEVICE_TOKEN_URL, { device_auth_id: pending.deviceAuthId, user_code: pending.userCode }); }
    catch { throw loginFailed(); }
    if (response.status === 403 || response.status === 404) return statusOf(current);
    if (!response.ok) {
      if (response.status === 401 && await errorCode(response) === 'authorization_declined') {
        await removeRecord(pendingPath, cfg);
        return { ...statusOf({ session: current.session }), outcome: 'declined' };
      }
      throw loginFailed();
    }
    let grant;
    try { grant = await readJson(response); } catch { throw loginFailed(); }
    if (!matches(grant?.authorization_code, OPAQUE) || !matches(grant?.code_verifier, OPAQUE)) throw loginFailed();
    const session = await exchange(grant, cfg);
    await writeRecord(join(directory, 'session.json'), session, cfg);
    await removeRecord(pendingPath, cfg);
    return statusOf({ session });
  });
}

export async function cancelCodexImagesLogin({ storageRoot } = {}, deps) {
  const cfg = settings(deps);
  const directory = await storeDirectory(storageRoot, cfg);
  if (!directory) return { state: 'off' };
  return locked(directory, cfg, async () => {
    await removeRecord(join(directory, 'pending.json'), cfg);
    return statusOf(await load(directory, cfg));
  });
}

export async function signOutCodexImages({ storageRoot } = {}, deps) {
  const cfg = settings(deps);
  const directory = await storeDirectory(storageRoot, cfg);
  if (!directory) return { state: 'off', revocation: 'not-applicable' };
  return locked(directory, cfg, async () => {
    let session = null;
    let revocation = 'not-applicable';
    try { session = await readSession(directory, cfg); }
    catch { revocation = 'unconfirmed'; }
    if (session) {
      revocation = 'unconfirmed';
      try {
        const response = await post(cfg, REVOKE_URL, {
          token: session.refreshToken, token_type_hint: 'refresh_token', client_id: CODEX_IMAGES_CLIENT_ID,
        }, { timeoutMs: REVOKE_TIMEOUT_MS });
        // After an unknown rotation a newer refresh token may exist that this cannot revoke.
        if (response.ok && session.refreshState === 'ok') revocation = 'confirmed';
      } catch { /* Local sign-out still happens. */ }
    }
    await removeRecord(join(directory, 'session.json'), cfg);
    await removeRecord(join(directory, 'pending.json'), cfg);
    // A crash between write and rename can leave a token-bearing temp record behind.
    for (const name of await cfg.fileSystem.readdir(directory).catch(() => { throw unsafeStorage(); })) {
      if (!LEFTOVER_RECORD.test(name)) continue;
      const path = join(directory, name);
      if ((await cfg.fileSystem.lstat(path).catch(() => null))?.isFile()) await removeRecord(path, cfg);
    }
    return { state: 'off', revocation };
  });
}

export async function getCodexImagesLease({ storageRoot } = {}, deps) {
  const cfg = settings(deps);
  const fresh = (session) => session.refreshState === 'ok' && Date.parse(session.accessExpiresAt) - cfg.now() > REFRESH_MARGIN_MS;
  try {
    const directory = await storeDirectory(storageRoot, cfg);
    const seen = directory && await readSession(directory, cfg);
    if (!seen) throw off();
    if (seen.refreshState === 'reauthorize') throw reauthorize();
    if (fresh(seen)) return leaseOf(seen);
    // A peer may be refreshing ("in-flight"); re-read once its lock is released.
    return await locked(directory, cfg, async () => {
      const session = await lockedSession(directory, cfg);
      if (!session) throw off();
      if (session.refreshState !== 'ok') throw reauthorize();
      return leaseOf(fresh(session) ? session : await refresh(directory, session, cfg));
    });
  } catch (error) {
    if (error instanceof CodexImagesError && LEASE_CODES.has(error.code)) throw error;
    throw refreshFailed();
  }
}

const COMMANDS = {
  status: codexImagesStatus,
  'login-start': startCodexImagesLogin,
  'login-poll': pollCodexImagesLogin,
  'login-cancel': cancelCodexImagesLogin,
  'sign-out': signOutCodexImages,
};

export async function runCodexImagesCli({ command, storageRoot, output = process.stdout, deps } = {}) {
  let result;
  let exitCode = 0;
  try {
    if (!Object.hasOwn(COMMANDS, command)) throw new CodexImagesError('invalid_command', 'Unknown Codex images command.');
    result = await COMMANDS[command]({ storageRoot }, deps);
  } catch (error) {
    exitCode = 1;
    result = error instanceof CodexImagesError
      ? { error: error.code, message: error.message }
      : { error: 'images_failed', message: 'Codex image sign-in failed.' };
  }
  output.write(`${JSON.stringify(result)}\n`);
  return exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runCodexImagesCli({ command: process.argv[2], storageRoot: process.env.N8N_OPENAI_OAUTH_HOME });
}

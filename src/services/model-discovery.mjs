// Text model discovery for the n8n ChatGPT sidecar. It lists the account's models from the
// SIWC catalog, asking as the newest stable Codex release on npm (checked at most every
// 12 h), and hides models OpenAI rejected. With the opt-in model checks it lists only models
// that answered one tiny request. Built-ins only, except the CLI entry's SIWC session import:
// this file ships inside the sidecar image.
import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';

// Pins the local Codex installs (local-endpoints.js). The catalog is never asked as an older client.
export const CODEX_CLI_VERSION = '0.160.0';
// The model-check disclosure the owner approves. Changing what checks send needs a new version.
export const MODEL_CHECKS_NOTICE = 'model-checks-2026-10-06';
export const MODEL_CHECKS_DIR = 'model-checks';
export const CATALOG_TTL_MS = 300_000;
export const VERSION_TTL_MS = 43_200_000;
export const FAILURE_RETRY_MS = 86_400_000;

const VERSION_URL = 'https://registry.npmjs.org/@openai/codex/latest';
const MODELS_URL = 'https://api.openai.com/v1/models';
const RESPONSES_URL = 'https://api.openai.com/v1/responses';
const VERSION_TIMEOUT_MS = 5_000;
const CATALOG_TIMEOUT_MS = 20_000;
const PROBE_TIMEOUT_MS = 60_000;
const STALE_CATALOG_MS = 3_600_000;
const PAUSE_MS = 3_600_000;
// The installer runs the CLI in a remote exec that holds the VPS operation lock.
const CHECKS_ON_DEADLINE_MS = 180_000;
const STATUS_DEADLINE_MS = 60_000;
// Part of the checks-on deadline kept for saving the setting after the probes.
const SAVE_RESERVE_MS = 15_000;
const MAX_VERSION_BODY = 1024 * 1024;
const MAX_CATALOG_BODY = 4 * 1024 * 1024;
const MAX_STREAM = 256 * 1024;
const MAX_FILE = 64 * 1024;
const MAX_MODELS = 256;
const MAX_ROWS = 64;
const MAX_LABEL = 256;
const LOCK_STALE_MS = 120_000;
const LOCK_RETRY_MS = 100;
const LOCK_ATTEMPTS = 450;
const STABLE_VERSION = /^\d{1,4}\.\d{1,4}\.\d{1,4}$/u;
const SLUG = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/u;
const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/u;
const CODE = /^[A-Za-z0-9_.-]{1,64}$/u;
const TOKEN = /^[!-~]{1,16384}$/u;
const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const TERMINAL_FAILURES = new Set(['response.failed', 'response.incomplete', 'error']);
const USAGE_CODES = new Set(['subscription_sharing_usage_limit_exceeded', 'subscription_sharing_usage_unavailable',
  'subscription_sharing_user_unavailable']);
const CLI_ERRORS = new Set(['invalid_command', 'invalid_configuration', 'store_unsafe', 'store_busy']);
const uid = process.getuid?.();

class ModelDiscoveryError extends Error {
  constructor(code, message, details) {
    super(message);
    this.code = code;
    Object.assign(this, details);
  }
}
// Messages are fixed text, so no token or upstream text can reach them.
const UNSAFE = 'The model-check record is unsafe. An administrator must inspect it.';
const storeUnsafe = () => new ModelDiscoveryError('store_unsafe', UNSAFE);
// A safe file that does not parse. Only turning checks off may replace it.
const storeCorrupt = () => new ModelDiscoveryError('store_unsafe', UNSAFE, { corrupt: true });
const storeBusy = () => new ModelDiscoveryError('store_busy', 'The model-check record is busy. Try again.');
const catalogUnavailable = (status) => new ModelDiscoveryError('catalog_unavailable', 'The account model catalog is unavailable.',
  { status, recovery: status === 401 ? 'reauthorize' : 'retry-later' });
const invalidConfiguration = () => new ModelDiscoveryError('invalid_configuration', 'The sidecar configuration is invalid.');
const catalogErrorOf = (error) => error instanceof ModelDiscoveryError && error.code === 'catalog_unavailable'
  ? 'catalog_unavailable' : 'registration_unavailable';

const settings = (deps) => ({
  fetchImpl: deps?.fetchImpl ?? fetch,
  now: deps?.now ?? Date.now,
  fileSystem: deps?.fileSystem ?? fs,
  randomUUID: deps?.randomUUID ?? randomUUID,
  sleep: deps?.sleep ?? pause,
});
const iso = (ms) => new Date(ms).toISOString();
const isIso = (value) => typeof value === 'string' && Number.isFinite(Date.parse(value)) && iso(Date.parse(value)) === value;
const matches = (value, pattern) => typeof value === 'string' && pattern.test(value);
const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const validBudget = (value) => value === undefined || Number.isSafeInteger(value) && value > 0;
const ageOf = (at, since) => Math.abs(at - since);
const versionRank = (version) => matches(version, STABLE_VERSION)
  ? version.split('.').reduce((rank, part) => rank * 10_000 + Number(part), 0) : -1;
const newerVersion = (version, pinned) => versionRank(version) > versionRank(pinned) ? version : pinned;
const validRecord = (record) => isObject(record) && (record.state === 'verified' || record.state === 'failed') &&
  isIso(record.checkedAt) && (record.source === 'probe' || record.source === 'traffic') &&
  (record.code === undefined || matches(record.code, CODE));
const validConsent = (value) => isObject(value) && isIso(value.acceptedAt) && matches(value.noticeVersion, CODE);
const validRelease = (value) => isObject(value) && isIso(value.checkedAt) &&
  (value.version === undefined || matches(value.version, STABLE_VERSION));
const recent = (record, at) => ageOf(at, Date.parse(record.checkedAt)) < FAILURE_RETRY_MS;
// A traffic failure hides a model in every mode, a probe failure only while checks are on.
const hides = (record, on, at) => record?.state === 'failed' && (record.source === 'traffic' || on) && recent(record, at);
const due = (record, at) => !record || record.state === 'failed' && !recent(record, at);
// What passive learning skips: any verified record, or a traffic failure that still hides the model.
const settled = (record, state, at) => state === 'verified' ? record?.state === 'verified'
  : record?.state === 'failed' && record.source === 'traffic' && recent(record, at);
// Checks count as on only while the current disclosure is approved.
const active = (store) => store.checksEnabled && store.consent?.noticeVersion === MODEL_CHECKS_NOTICE;
const emptyStore = () => ({ checksEnabled: false, consent: null, models: new Map() });
const withModel = (store, slug, record) => ({ ...store, models: new Map(store.models).set(slug, record) });
// The models n8n gets: with checks on only verified ones, or until one is verified, all that no failure hides.
function listedEntries(entries, store, at) {
  const on = active(store);
  const visible = entries.filter(({ id }) => !hides(store.models.get(id), on, at));
  if (!on) return visible;
  const verified = entries.filter(({ id }) => store.models.get(id)?.state === 'verified');
  return verified.length ? verified : visible;
}
// A caller that gives up stops waiting; the work it waited on carries on.
function waitFor(promise, signal) {
  if (!signal) return promise;
  return new Promise((done, fail) => {
    const abort = () => fail(signal.reason);
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
    promise.then(done, fail).finally(() => signal.removeEventListener('abort', abort));
  });
}

// --- Store files ---
// ponytail: these copy the store helpers in codex-images.mjs (storeDirectory, assertOwned, readRecord,
// writeRecord, lockAge, locked). A safety fix in either file belongs in both. Differences: readRecord here
// tells a safe file that does not parse from an unsafe one, and locked can stop waiting at a deadline.

function assertOwned(stat, kind) {
  if (stat.isSymbolicLink() || (kind === 'file' ? !stat.isFile() || stat.nlink !== 1 : !stat.isDirectory()) ||
      (uid !== undefined && stat.uid !== uid) || (stat.mode & 0o077) !== 0) throw storeUnsafe();
  return stat;
}
async function readRecord(path, cfg) {
  let stat;
  try { stat = await cfg.fileSystem.lstat(path); }
  catch (error) { if (error?.code === 'ENOENT') return null; throw storeUnsafe(); }
  assertOwned(stat, 'file');
  if (stat.size === 0 || stat.size > MAX_FILE) throw storeCorrupt();
  let bytes;
  try {
    const handle = await cfg.fileSystem.open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const opened = await handle.stat();
      if (opened.ino !== stat.ino || opened.dev !== stat.dev) throw storeUnsafe();
      bytes = await handle.readFile();
    } finally {
      await handle.close();
    }
  } catch {
    throw storeUnsafe();
  }
  try {
    if (bytes.length > MAX_FILE) throw new Error('Oversized record.');
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    throw storeCorrupt();
  }
}
async function writeRecord(path, bytes, cfg) {
  if (bytes.length > MAX_FILE) throw storeUnsafe();
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
    throw storeUnsafe();
  } finally {
    await cfg.fileSystem.rm(temp, { force: true }).catch(() => {});
  }
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
async function locked(path, cfg, operation, { wait = true, deadline = Infinity } = {}) {
  let ino;
  for (let attempt = 0; ino === undefined; attempt++) {
    if (attempt > LOCK_ATTEMPTS) throw storeBusy();
    let handle;
    try { handle = await cfg.fileSystem.open(path, 'wx', 0o600); }
    catch (error) {
      if (error?.code !== 'EEXIST') throw storeUnsafe();
      const held = await lockAge(path, cfg).catch(() => { throw storeUnsafe(); });
      if (held && held.age > LOCK_STALE_MS) {
        // ponytail: lstat-then-unlink can race a second stale taker by microseconds; stale locks only follow a crash.
        if ((await cfg.fileSystem.lstat(path).catch(() => null))?.ino === held.ino)
          await cfg.fileSystem.rm(path, { force: true }).catch(() => { throw storeUnsafe(); });
      } else if (held) {
        if (!wait || cfg.now() >= deadline) throw storeBusy();
        await cfg.sleep(LOCK_RETRY_MS);
      }
      continue;
    }
    try {
      await handle.writeFile(JSON.stringify({ pid: process.pid, createdAt: iso(cfg.now()) }));
      ino = (await handle.stat()).ino;
    } catch {
      await cfg.fileSystem.rm(path, { force: true }).catch(() => {});
      throw storeUnsafe();
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

// --- OpenAI and npm responses ---

async function readJson(response, limit) {
  const reader = response.body?.getReader();
  if (!reader) throw new Error('Empty response.');
  const chunks = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > limit) {
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
// A terminal event's outcome, or null to keep reading.
function eventOutcome(raw) {
  let event;
  try { event = JSON.parse(raw); } catch { return null; }
  if (event?.type === 'response.completed')
    return event.response?.status === undefined || event.response.status === 'completed' ? { state: 'verified' } : {};
  if (!TERMINAL_FAILURES.has(event?.type)) return null;
  const code = event.response?.error?.code ?? event.error?.code ?? event.code;
  if (USAGE_CODES.has(code)) return { stop: 'usage_limit' };
  if (code === 'subscription_sharing_invalid_user') return { stop: 'reauthorize' };
  return {};
}
// Reads the probe's SSE stream to its terminal event, then ends it.
async function streamOutcome(response) {
  const reader = response.body?.getReader();
  if (!reader) return {};
  const decoder = new TextDecoder();
  let pending = '';
  let data = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return {};
      total += value.byteLength;
      if (total > MAX_STREAM) return {};
      pending += decoder.decode(value, { stream: true });
      for (let end = pending.indexOf('\n'); end >= 0; end = pending.indexOf('\n')) {
        const line = pending.slice(0, end).replace(/\r$/u, '');
        pending = pending.slice(end + 1);
        if (line.startsWith('data:')) data.push(line.slice(5).trimStart());
        else if (!line && data.length) {
          const outcome = eventOutcome(data.join('\n'));
          data = [];
          if (outcome) return outcome;
        }
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
}
function lowestEffort(levels) {
  const listed = new Set(Array.isArray(levels) ? levels.map((level) => typeof level === 'string' ? level : level?.effort) : []);
  return EFFORTS.find((effort) => listed.has(effort));
}
function catalogEntries(body, token) {
  if (!Array.isArray(body?.models)) throw new Error('Invalid catalog.');
  const leaks = (text) => token.length >= 8 && text.includes(token);
  const ids = new Set();
  const entries = [];
  for (const model of body.models) {
    const id = model?.slug;
    if (!matches(id, SLUG) || /image/iu.test(id) || model.visibility !== 'list' || model.supported_in_api === false ||
        ids.has(id) || leaks(id)) continue;
    const name = model.display_name;
    const label = typeof name === 'string' && name.length >= 1 && name.length <= MAX_LABEL && !/\p{C}/u.test(name) && !leaks(name) ? name : id;
    ids.add(id);
    entries.push({ id, display_name: label, effort: lowestEffort(model.supported_reasoning_levels) });
    if (entries.length === MAX_MODELS) break;
  }
  return entries;
}

// --- Public operations ---

// A 400 or 404 counts against the model only when OpenAI blames the model. Returns OpenAI's error
// code, "model_rejected" when it gives no usable code, or null.
export function classifyModelRejection(status, errorBody, { source } = {}) {
  if (status !== 400 && status !== 404) return null;
  const error = isObject(errorBody?.error) ? errorBody.error : errorBody;
  if (!isObject(error)) return null;
  const { code, param } = error;
  // A probe sends nothing else that a bare capability error could refer to; traffic can.
  const modelLevel = param === 'model' || code === 'model_not_found' || code === 'invalid_model' ||
    source === 'probe' && code === 'subscription_sharing_unsupported_capability' && (param === undefined || param === null);
  if (!modelLevel) return null;
  return matches(code, CODE) ? code : 'model_rejected';
}

export async function resolveCatalogClientVersion({ pinned, cache, fetchImpl = fetch, now = Date.now } = {}) {
  cache ??= {};
  const at = now();
  if (!(ageOf(at, cache.fetchedAt) < VERSION_TTL_MS)) {
    // A failed check counts too, so npm sees at most one request per 12 h, as disclosed.
    cache.fetchedAt = at;
    try {
      const response = await fetchImpl(VERSION_URL, {
        headers: { accept: 'application/json' }, redirect: 'error', signal: AbortSignal.timeout(VERSION_TIMEOUT_MS),
      });
      if (response.ok) {
        const { version } = await readJson(response, MAX_VERSION_BODY);
        if (matches(version, STABLE_VERSION)) cache.version = version;
      } else await response.body?.cancel();
    } catch { /* The last good version, or the pin, stays in use. */ }
  }
  return newerVersion(cache.version, pinned);
}

export function createModelDiscovery({ storageRoot, registrationId, pinnedClientVersion, getLease, deps } = {}) {
  if (!matches(pinnedClientVersion, STABLE_VERSION) || typeof getLease !== 'function')
    throw new TypeError('Model discovery needs a stable pinned client version and a lease source.');
  const cfg = settings(deps);
  const versionCache = {};
  let catalog = null;
  let refreshing = null;
  let background = null;
  let pausedAt = -Infinity;
  // close() aborts this: leases, the catalog request, probes and the spacing sleep end, and runs stop.
  const closing = new AbortController();
  // Last known state per model, so steady-state traffic writes nothing.
  let known = new Map();

  // --- Store: ${storageRoot}/model-checks/${registrationId}.{json,lock} ---

  async function storeDirectory(create = false) {
    if (typeof storageRoot !== 'string' || !isAbsolute(storageRoot) || storageRoot.includes('\0') ||
        resolve(storageRoot) !== storageRoot || !matches(registrationId, ID)) throw storeUnsafe();
    const directory = join(storageRoot, MODEL_CHECKS_DIR);
    try {
      if (create) {
        try { await cfg.fileSystem.mkdir(directory, { mode: 0o700 }); }
        catch (error) { if (error?.code !== 'EEXIST') throw error; }
      }
      assertOwned(await cfg.fileSystem.lstat(directory), 'directory');
    } catch (error) {
      if (!create && error?.code === 'ENOENT') return null;
      throw storeUnsafe();
    }
    return directory;
  }
  const storePath = (directory) => join(directory, `${registrationId}.json`);
  function parseStore(value) {
    const entries = isObject(value?.models) ? Object.entries(value.models) : [];
    if (!isObject(value) || value.schemaVersion !== 1 || value.registrationId !== registrationId ||
        typeof value.checksEnabled !== 'boolean' || !isIso(value.updatedAt) || !isObject(value.models) ||
        !(value.consent === undefined || value.consent === null || validConsent(value.consent)) ||
        // codexRelease shares the last npm check between the sidecar and CLI processes.
        !(value.codexRelease === undefined || validRelease(value.codexRelease)) ||
        entries.length > MAX_MODELS || !entries.every(([slug, record]) => matches(slug, SLUG) && validRecord(record))) throw storeCorrupt();
    return { checksEnabled: value.checksEnabled, consent: value.consent ?? null, models: new Map(entries),
      ...(value.codexRelease && { codexRelease: value.codexRelease }) };
  }
  async function load(directory) {
    const value = directory ? await readRecord(storePath(directory), cfg) : null;
    return value === null ? emptyStore() : parseStore(value);
  }
  // A missing, unsafe or corrupt store reads as checks off with no records.
  async function readStore() {
    let store;
    try { store = await load(await storeDirectory()); }
    catch { store = { ...emptyStore(), unsafe: true }; }
    known = new Map(store.models);
    return store;
  }
  // Oldest records go first when the store would exceed its caps.
  function serialize(store, at) {
    const entries = [...store.models].sort(([, a], [, b]) => Date.parse(b.checkedAt) - Date.parse(a.checkedAt)).slice(0, MAX_MODELS);
    for (;;) {
      const bytes = Buffer.from(JSON.stringify({
        schemaVersion: 1, registrationId, checksEnabled: store.checksEnabled, consent: store.consent ?? null, updatedAt: iso(at),
        models: Object.fromEntries(entries), ...(store.codexRelease && { codexRelease: store.codexRelease }),
      }));
      if (bytes.length <= MAX_FILE || !entries.length) return bytes;
      entries.pop();
    }
  }
  // Locked read-modify-write. The file is read again inside the lock and each caller changes only its
  // own keys. A corrupt or unsafe store is never overwritten, except that turning checks off may replace
  // a safe file that does not parse.
  async function update(mutate, { wait = true, deadline = Infinity, replaceCorrupt = false } = {}) {
    const directory = await storeDirectory(true);
    return locked(join(directory, `${registrationId}.lock`), cfg, async () => {
      let current;
      let replace = false;
      try { current = await load(directory); }
      catch (error) {
        if (!(replaceCorrupt && error?.corrupt)) throw error;
        current = emptyStore();
        replace = true;
      }
      const at = cfg.now();
      const next = mutate(current, at);
      if (next !== current || replace) await writeRecord(storePath(directory), serialize(next, at), cfg);
      known = new Map(next.models);
      return next;
    }, { wait, deadline });
  }

  // --- Catalog ---

  const deadlineOf = (budgetMs) => budgetMs === undefined ? Infinity : cfg.now() + budgetMs;
  // Ends a wait at a deadline on cfg.now()'s clock.
  const cutoff = (deadline) => Number.isFinite(deadline) ? AbortSignal.timeout(Math.max(1, deadline - cfg.now())) : undefined;
  async function leaseFor(signal) {
    const merged = signal ? AbortSignal.any([signal, closing.signal]) : closing.signal;
    merged.throwIfAborted();
    const lease = await waitFor(Promise.resolve(getLease({ signal: merged })), merged);
    if (!matches(lease?.accessToken, TOKEN)) throw new Error('Invalid lease.');
    return lease;
  }
  // The npm check another process shared through the store counts, unless it is dated in the future
  // (a clock that jumped back).
  function knownVersion(store) {
    const shared = Date.parse(store.codexRelease?.checkedAt);
    if (shared <= cfg.now() && !(shared <= versionCache.fetchedAt))
      Object.assign(versionCache, { version: store.codexRelease.version ?? versionCache.version, fetchedAt: shared });
    return newerVersion(versionCache.version, pinnedClientVersion);
  }
  async function catalogVersion() {
    knownVersion(await readStore());
    const before = versionCache.fetchedAt;
    const version = await resolveCatalogClientVersion({ pinned: pinnedClientVersion, cache: versionCache, fetchImpl: cfg.fetchImpl, now: cfg.now });
    if (versionCache.fetchedAt !== before) {
      const checkedAt = versionCache.fetchedAt;
      const codexRelease = { ...(versionCache.version && { version: versionCache.version }), checkedAt: iso(checkedAt) };
      // Never waits on a busy lock: the catalog answers n8n first.
      await update((latest, at) => {
        const stored = Date.parse(latest.codexRelease?.checkedAt);
        return stored >= checkedAt && stored <= at ? latest : { ...latest, codexRelease };
      }, { wait: false }).catch(() => {});
    }
    return version;
  }
  async function fetchCatalog(lease, readOnly) {
    let failureStatus = 503;
    try {
      // Read-only callers use the last shared npm check, or the pin, and write nothing.
      const clientVersion = readOnly ? knownVersion(await readStore()) : await catalogVersion();
      closing.signal.throwIfAborted();
      const response = await cfg.fetchImpl(`${MODELS_URL}?client_version=${clientVersion}`, {
        headers: { authorization: `Bearer ${lease.accessToken}`, accept: 'application/json' },
        redirect: 'error', signal: AbortSignal.any([closing.signal, AbortSignal.timeout(CATALOG_TIMEOUT_MS)]),
      });
      if (!response.ok) {
        if (response.status === 401) failureStatus = 401;
        await response.body?.cancel().catch(() => {});
        throw new Error('Catalog request failed.');
      }
      const entries = catalogEntries(await readJson(response, MAX_CATALOG_BODY), lease.accessToken);
      catalog = { entries, ids: new Set(entries.map(({ id }) => id)), clientVersion, fetchedAt: cfg.now() };
      return catalog;
    } catch {
      // A rejected sign-in surfaces now instead of hiding behind an hour of cached lists.
      if (failureStatus !== 401 && catalog && ageOf(cfg.now(), catalog.fetchedAt) < STALE_CATALOG_MS) return catalog;
      throw catalogUnavailable(failureStatus);
    }
  }
  // Every caller takes its own lease first; lease errors propagate unchanged and never fall back to the
  // cached list. Concurrent callers then share one request, which runs on its own timeout.
  async function loadCatalog(signal, { readOnly = false } = {}) {
    if (catalog && ageOf(cfg.now(), catalog.fetchedAt) < CATALOG_TTL_MS) return catalog;
    const lease = await leaseFor(signal);
    signal?.throwIfAborted();
    if (!refreshing) {
      refreshing = fetchCatalog(lease, readOnly).finally(() => { refreshing = null; });
      refreshing.catch(() => {});
    }
    return waitFor(refreshing, signal);
  }

  // --- Probes ---

  // One tiny request: { state, code? } to record, { stop } to end the run, or {} to retry next run.
  async function probe(entry, lease, signal) {
    let response;
    try {
      response = await cfg.fetchImpl(RESPONSES_URL, {
        method: 'POST',
        headers: { authorization: `Bearer ${lease.accessToken}`, 'content-type': 'application/json', accept: 'text/event-stream' },
        body: JSON.stringify({
          model: entry.id, instructions: 'Reply with OK.', input: [{ role: 'user', content: [{ type: 'input_text', text: 'OK' }] }],
          stream: true, store: false, ...(entry.effort && { reasoning: { effort: entry.effort } }),
        }),
        redirect: 'error', signal,
      });
      if (response.status === 401) return { stop: 'reauthorize' };
      if (response.status === 429) return { stop: 'usage_limit' };
      if (response.ok) return await streamOutcome(response);
      if (response.status < 400 || response.status >= 500) return {};
      let body = null;
      if (response.status === 400 || response.status === 404) {
        try { body = await readJson(response, MAX_FILE); } catch { /* An unreadable error never blames the model. */ }
      }
      const code = classifyModelRejection(response.status, body, { source: 'probe' });
      return code ? { state: 'failed', code } : { stop: 'probe_rejected' };
    } catch {
      return {};
    } finally {
      // Unread bodies must not hold the connection open.
      await response?.body?.cancel().catch(() => {});
    }
  }
  // One model at a time; each result is saved as it lands. Returns the counts, the catalog the run used
  // and, when it had none, why. Only the enabling run probes while checks are off.
  async function run({ limit, spacingMs, deadline, saveDeadline = deadline, enabling }) {
    const result = { checked: 0, verified: 0, failed: 0 };
    const opening = cutoff(deadline);
    let current;
    try { current = await loadCatalog(opening); }
    catch (error) {
      if (closing.signal.aborted) return { result: { ...result, stoppedReason: 'checks_off' }, catalog: null, catalogError: 'catalog_unavailable' };
      if (opening?.aborted || cfg.now() >= deadline)
        return { result: { ...result, stoppedReason: 'time_limit' }, catalog: null, catalogError: 'catalog_unavailable' };
      if (catalogErrorOf(error) === 'catalog_unavailable')
        return { result: error.status === 401 ? { ...result, stoppedReason: 'reauthorize' } : result, catalog: null, catalogError: 'catalog_unavailable' };
      return { result: { ...result, stoppedReason: error?.recovery === 'reauthorize' ? 'reauthorize' : 'lease_unavailable' },
        catalog: null, catalogError: 'registration_unavailable' };
    }
    const stop = (stoppedReason) => ({ result: { ...result, stoppedReason }, catalog: current });
    // Turning checks off, an approval that no longer matches or close() stops the run; a model another
    // process settled is skipped. The enabling run probes while checks are still off.
    const recheck = async (id) => {
      if (closing.signal.aborted) return 'checks_off';
      const store = await readStore();
      if (enabling && store.unsafe) throw storeUnsafe();
      if (!enabling && !active(store)) return 'checks_off';
      return due(store.models.get(id), cfg.now()) ? 'probe' : 'skip';
    };
    for (const entry of current.entries) {
      if (result.checked >= limit) break;
      if (!due((await readStore()).models.get(entry.id), cfg.now())) continue;
      if (result.checked > 0 && spacingMs > 0) await cfg.sleep(spacingMs, undefined, { signal: closing.signal }).catch(() => {});
      if (cfg.now() >= deadline) return stop('time_limit');
      let next = await recheck(entry.id);
      if (next === 'checks_off') return stop(next);
      if (next === 'skip') continue;
      const budget = cutoff(deadline);
      const signal = AbortSignal.any([closing.signal, AbortSignal.timeout(PROBE_TIMEOUT_MS), ...(budget ? [budget] : [])]);
      let lease;
      try { lease = await leaseFor(signal); }
      catch (error) {
        return stop(closing.signal.aborted ? 'checks_off' : budget?.aborted ? 'time_limit'
          : error?.recovery === 'reauthorize' ? 'reauthorize' : 'lease_unavailable');
      }
      // The lease can take a while, so check again right before sending.
      next = await recheck(entry.id);
      if (next === 'checks_off') return stop(next);
      if (next === 'skip') continue;
      result.checked += 1;
      const outcome = await probe(entry, lease, signal);
      if (outcome.stop) return stop(outcome.stop);
      if (outcome.state) {
        await update((latest, at) => withModel(latest, entry.id,
          { state: outcome.state, checkedAt: iso(at), source: 'probe', ...(outcome.code && { code: outcome.code }) }), { deadline: saveDeadline });
        result[outcome.state] += 1;
      }
      if (budget?.aborted) return stop('time_limit');
    }
    return { result, catalog: current };
  }
  // StatusView: rows in catalog order, at most 64; "failed" only while the failure still hides the model.
  function view(store, current, { catalogError, lastRun } = {}) {
    const on = active(store);
    const head = { checksEnabled: on, clientVersion: current?.clientVersion ?? knownVersion(store),
      catalogCheckedAt: current ? iso(current.fetchedAt) : null, ...(catalogError && { catalogError }), ...(lastRun && { lastRun }) };
    if (!current) return { ...head, models: [] };
    const at = cfg.now();
    const shown = new Set(listedEntries(current.entries, store, at).map(({ id }) => id));
    return { ...head, models: current.entries.slice(0, MAX_ROWS).map(({ id, display_name }) => {
      const record = store.models.get(id);
      const state = record?.state === 'verified' ? 'verified' : hides(record, on, at) ? 'failed' : 'unchecked';
      return { id, display_name, state, listed: shown.has(id), ...(state !== 'unchecked' && { checkedAt: record.checkedAt }) };
    }) };
  }

  // --- Operations ---

  async function verifyNow({ limit = 12, spacingMs = 0, budgetMs, enabling = false } = {}) {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > MAX_MODELS || !Number.isSafeInteger(spacingMs) || spacingMs < 0 ||
        !validBudget(budgetMs) || typeof enabling !== 'boolean') throw new TypeError('Invalid model check options.');
    return (await run({ limit, spacingMs, deadline: deadlineOf(budgetMs), enabling })).result;
  }

  async function listModels({ signal } = {}) {
    const store = await readStore();
    const current = await loadCatalog(signal);
    const at = cfg.now();
    const on = active(store);
    if (on && !closing.signal.aborted && !background && ageOf(at, pausedAt) >= PAUSE_MS &&
        current.entries.some(({ id }) => due(store.models.get(id), at))) {
      // Never awaited here: n8n gets the list now, and new models show once they answer. A run that
      // stopped or left a model unanswered pauses background checks in this process for an hour.
      // ponytail: no cross-process run lock, so a repeated checks-on can probe a model this run probes too.
      background = run({ limit: 8, spacingMs: 5_000, deadline: Infinity, enabling: false })
        .then(({ result }) => { if (result.stoppedReason || result.checked > result.verified + result.failed) pausedAt = cfg.now(); },
          () => { pausedAt = cfg.now(); })
        .finally(() => { background = null; });
    }
    return { models: listedEntries(current.entries, store, at).map(({ id, display_name }) => ({ id, display_name })),
      clientVersion: current.clientVersion, checksEnabled: on };
  }

  async function recordOutcome({ model, outcome } = {}) {
    try {
      const state = outcome === 'completed' ? 'verified' : outcome === 'model_rejected' ? 'failed' : undefined;
      // Only models from the last catalog: n8n defaults, typos and pasted keys never reach the store.
      if (!state || typeof model !== 'string' || !catalog?.ids.has(model) || settled(known.get(model), state, cfg.now())) return;
      const record = (at) => ({ state, checkedAt: iso(at), source: 'traffic' });
      known.set(model, record(cfg.now()));
      await update((store, at) => settled(store.models.get(model), state, at) ? store : withModel(store, model, record(at)));
    } catch { /* Passive learning never affects traffic. */ }
  }

  // Read-only apart from the lease, which may refresh the SIWC token: no npm request, no store write.
  async function status({ budgetMs } = {}) {
    if (!validBudget(budgetMs)) throw new TypeError('Invalid status options.');
    const deadline = deadlineOf(budgetMs);
    const signal = cutoff(deadline);
    let current = null;
    let failure = {};
    try { current = await loadCatalog(signal, { readOnly: true }); }
    // Status runs no checks, so a timeout is reported as an unreadable catalog, never as a check run.
    catch (error) { failure = { catalogError: signal?.aborted || cfg.now() >= deadline ? 'catalog_unavailable' : catalogErrorOf(error) }; }
    return view(await readStore(), current, failure);
  }

  async function setChecks({ enabled, budgetMs } = {}) {
    if (typeof enabled !== 'boolean' || !validBudget(budgetMs)) throw new TypeError('Model checks need enabled: true or false.');
    const deadline = deadlineOf(budgetMs);
    if (!enabled) {
      // No network call, so checks can be turned off while OpenAI or the sign-in is down.
      const store = await update((current) => current.checksEnabled || current.consent
        ? { ...current, checksEnabled: false, consent: null } : current, { deadline, replaceCorrupt: true });
      return view(store, catalog);
    }
    // Probe first and save after, so n8n switches to the verified list in one step and the sidecar starts
    // no run of its own meanwhile. Nothing is spent when the results could not be saved.
    if ((await readStore()).unsafe) throw storeUnsafe();
    const checked = await run({ limit: 12, spacingMs: 0, enabling: true, saveDeadline: deadline,
      deadline: Number.isFinite(deadline) ? deadline - SAVE_RESERVE_MS : Infinity });
    const store = await update((current, at) => active(current) ? current
      : { ...current, checksEnabled: true, consent: { acceptedAt: iso(at), noticeVersion: MODEL_CHECKS_NOTICE } }, { deadline });
    return view(store, checked.catalog, { catalogError: checked.catalogError, lastRun: checked.result });
  }

  // Stops background checks for good: work in flight is aborted, a running run stops at its next check
  // and no new run starts. Resolves once the running run has stopped; never rejects.
  function close() {
    closing.abort();
    return background ? background.then(() => {}, () => {}) : Promise.resolve();
  }

  return { listModels, recordOutcome, status, setChecks, verifyNow, close };
}

const COMMANDS = {
  status: (discovery, budgetMs) => discovery.status({ budgetMs: budgetMs(STATUS_DEADLINE_MS) }),
  'checks-on': (discovery, budgetMs) => discovery.setChecks({ enabled: true, budgetMs: budgetMs(CHECKS_ON_DEADLINE_MS) }),
  'checks-off': (discovery) => discovery.setChecks({ enabled: false }),
};

export async function runModelDiscoveryCli({ command, env = process.env, output = process.stdout, deps } = {}) {
  // One deadline from the start covers lock waits, the lease, npm, the catalog and probes. A lease call
  // still pending at the deadline settles before the process exits: nothing here calls process.exit().
  const now = deps?.now ?? Date.now;
  const started = now();
  const budgetMs = (deadlineMs) => Math.max(1, started + deadlineMs - now());
  let result;
  let exitCode = 0;
  try {
    if (!Object.hasOwn(COMMANDS, command)) throw new ModelDiscoveryError('invalid_command', 'Unknown command.');
    const session = await import('./siwc-session.mjs');
    let storageRoot;
    try { storageRoot = session.resolveSiwcStorageRoot({ env }); } catch { throw invalidConfiguration(); }
    const registrationId = env.RELMIO_REGISTRATION_ID;
    const runtimeId = env.RELMIO_RUNTIME_ID;
    if (!matches(registrationId, ID) || !matches(runtimeId, ID)) throw invalidConfiguration();
    const getAccessToken = deps?.getAccessToken ?? session.getAccessToken;
    const discovery = createModelDiscovery({
      storageRoot, registrationId, pinnedClientVersion: CODEX_CLI_VERSION, deps,
      getLease: ({ signal } = {}) => getAccessToken({ storageRoot, registrationId }, { runtimeId, minValidityMs: 60_000, signal }),
    });
    result = await COMMANDS[command](discovery, budgetMs);
  } catch (error) {
    exitCode = 1;
    result = error instanceof ModelDiscoveryError && CLI_ERRORS.has(error.code)
      ? { error: error.code, message: error.message }
      : { error: 'discovery_failed', message: 'Model discovery failed.' };
  }
  output.write(`${JSON.stringify(result)}\n`);
  return exitCode;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runModelDiscoveryCli({ command: process.argv[2] });
}

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { chmod, link, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  CATALOG_TTL_MS, CODEX_CLI_VERSION, FAILURE_RETRY_MS, MODEL_CHECKS_DIR, MODEL_CHECKS_NOTICE, VERSION_TTL_MS,
  classifyModelRejection, createModelDiscovery, resolveCatalogClientVersion, runModelDiscoveryCli,
} from '../src/services/model-discovery.mjs';

const T0 = Date.parse('2026-10-06T12:00:00.000Z');
const MINUTE = 60_000;
const HOUR = 3_600_000;
const TOKEN = 'fake-siwc-access-token-0123456789';
const REGISTRATION = 'registration-0001';
const PINNED = CODEX_CLI_VERSION;
const LATEST = '0.161.0';
const OLD_NOTICE = 'model-checks-2026-01-01';
const MISSING_ROOT = '/nonexistent/relmio-model-discovery';
const iso = ms => new Date(ms).toISOString();
const entry = (slug, extra = {}) => ({ slug, display_name: `Model ${slug}`, visibility: 'list', supported_in_api: true, ...extra });
const CATALOG = [entry('gpt-6-sol'), entry('gpt-6-luna'), entry('gpt-6-astra')];
const CATALOG_IDS = CATALOG.map(({ slug }) => slug);
const event = (type, extra = {}) => `event: ${type}\ndata: ${JSON.stringify({ type, ...extra })}\n\n`;
const sse = (...events) => new Response(events.join(''), { headers: { 'content-type': 'text/event-stream' } });
const completed = () => sse(event('response.created'), event('response.completed', { response: { status: 'completed' } }));
const apiError = (status, error) => () =>
  Response.json({ error: { message: `Rejected for ${TOKEN}`, type: 'invalid_request_error', ...error } }, { status });
const ids = result => result.models.map(({ id }) => id);
const rows = view => view.models.map(({ id, state, listed, checkedAt }) => [id, state, listed, checkedAt ?? null]);
const exists = path => stat(path).then(() => true, () => false);
const settle = () => new Promise(done => setTimeout(done, 25));
async function until(condition) {
  for (let attempt = 0; attempt < 2500; attempt++) {
    if (await condition()) return;
    await new Promise(done => setTimeout(done, 2));
  }
  assert.fail('The condition never held.');
}

async function root(t) {
  const storageRoot = await mkdtemp(join(tmpdir(), 'relmio-model-discovery-'));
  t.after(() => rm(storageRoot, { recursive: true, force: true }));
  return storageRoot;
}
const storeDir = storageRoot => join(storageRoot, MODEL_CHECKS_DIR);
const storeFile = storageRoot => join(storeDir(storageRoot), `${REGISTRATION}.json`);
const lockFile = storageRoot => join(storeDir(storageRoot), `${REGISTRATION}.lock`);
const readStoreFile = async storageRoot => JSON.parse(await readFile(storeFile(storageRoot), 'utf8'));
const idle = async storageRoot => !await exists(lockFile(storageRoot));
const CONSENT = { acceptedAt: iso(T0 - MINUTE), noticeVersion: MODEL_CHECKS_NOTICE };
const record = (state, ageMs, extra = {}) => ({ state, checkedAt: iso(T0 - ageMs), source: 'probe', ...extra });
const storeJson = (extra = {}) => JSON.stringify({ schemaVersion: 1, registrationId: REGISTRATION, checksEnabled: true, consent: CONSENT,
  updatedAt: iso(T0 - MINUTE), models: { 'gpt-6-sol': record('verified', MINUTE) }, ...extra });
async function seedWith(storageRoot, text) {
  await mkdir(storeDir(storageRoot), { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  await writeFile(storeFile(storageRoot), text, { mode: 0o600 });
}
const seedStore = (storageRoot, { checksEnabled = false, consent = checksEnabled ? CONSENT : null, models = {} } = {}) =>
  seedWith(storageRoot, storeJson({ checksEnabled, consent, models }));

// Fake npm registry, OpenAI and SIWC lease. Routes can be swapped mid-test; every request is recorded.
function harness({ storageRoot = MISSING_ROOT, catalog = CATALOG, probe, lease, deps: extra } = {}) {
  const clock = { t: T0 };
  const calls = { npm: [], catalog: [], probe: [], leases: [], sleeps: [] };
  const routes = {
    npm: () => Response.json({ name: '@openai/codex', version: LATEST }),
    catalog: () => Response.json({ models: catalog }),
    probe: probe ?? completed,
    lease: lease ?? (() => ({ accessToken: TOKEN })),
  };
  const fetchImpl = async (url, options) => {
    const { origin, pathname } = new URL(url);
    if (origin === 'https://registry.npmjs.org') { calls.npm.push({ url, options }); return routes.npm(options); }
    assert.equal(origin, 'https://api.openai.com');
    if (pathname === '/v1/models') { calls.catalog.push({ url, options }); return routes.catalog(options); }
    assert.equal(pathname, '/v1/responses');
    const body = JSON.parse(options.body);
    calls.probe.push({ body, options });
    return routes.probe(body, options);
  };
  const deps = { fetchImpl, now: () => clock.t, sleep: async ms => { calls.sleeps.push(ms); }, ...extra };
  const getLease = async options => { calls.leases.push(options); return routes.lease(options); };
  const discovery = createModelDiscovery({ storageRoot, registrationId: REGISTRATION, pinnedClientVersion: PINNED, getLease, deps });
  return { clock, calls, routes, deps, discovery };
}
const networkCalls = calls => calls.npm.length + calls.catalog.length + calls.probe.length + calls.leases.length;
const hang = (body, options) => new Promise((_, reject) => {
  options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
});

test('the catalog version is the newest stable Codex release on npm, checked at most every 12 h, and never fails', async () => {
  const calls = [];
  const resolveWith = (cache, answer) => resolveCatalogClientVersion({ pinned: PINNED, cache, now: () => T0,
    fetchImpl: async (url, options) => { calls.push({ url, options }); return answer(); } });

  for (const [latest, expected] of [['0.161.2', '0.161.2'], ['0.159.9', PINNED], ['0.99.0', PINNED], ['0.160.10', '0.160.10'], ['1.0.0', '1.0.0']]) {
    const cache = {};
    assert.equal(await resolveWith(cache, () => Response.json({ name: '@openai/codex', version: latest })), expected, latest);
    assert.deepEqual(cache, { version: latest, fetchedAt: T0 });
  }
  const [request] = calls;
  assert.equal(request.url, 'https://registry.npmjs.org/@openai/codex/latest');
  assert.equal(request.options.redirect, 'error');
  assert.deepEqual(request.options.headers, { accept: 'application/json' });
  assert.ok(request.options.signal instanceof AbortSignal);

  calls.length = 0;
  assert.equal(await resolveWith({ version: LATEST, fetchedAt: T0 - VERSION_TTL_MS + 1 }, () => Response.json({ version: '0.170.0' })), LATEST);
  assert.equal(calls.length, 0, 'a check younger than 12 h is reused');
  assert.equal(await resolveWith({ version: LATEST, fetchedAt: T0 - VERSION_TTL_MS }, () => Response.json({ version: '0.170.0' })), '0.170.0');
  assert.equal(calls.length, 1);

  for (const version of ['0.162.0-alpha.1', '0.162', 'v0.162.0', '12345.0.0', 162, null]) {
    const cache = { version: LATEST, fetchedAt: T0 - VERSION_TTL_MS };
    assert.equal(await resolveWith(cache, () => Response.json({ version })), LATEST, String(version));
    assert.equal(cache.version, LATEST);
  }

  const failures = [
    () => { throw new Error(`offline ${TOKEN}`); },
    () => new Response('busy', { status: 503 }),
    () => new Response('{"version":'),
    () => new Response(JSON.stringify({ version: '0.170.0', padding: 'x'.repeat(1024 * 1024) })),
    () => Response.json(null),
  ];
  for (const failure of failures) {
    const cache = { version: LATEST, fetchedAt: T0 - VERSION_TTL_MS - 1 };
    assert.equal(await resolveWith(cache, failure), LATEST);
    assert.deepEqual(cache, { version: LATEST, fetchedAt: T0 }, 'a failed check keeps the last good version and counts as the check');
    assert.equal(await resolveWith({}, failure), PINNED);
  }
  calls.length = 0;
  assert.equal(await resolveWith({ fetchedAt: T0 - 1 }, () => Response.json({ version: '0.170.0' })), PINNED);
  assert.equal(calls.length, 0, 'a failed check also waits 12 h');
});

test('only rejections that blame the model count against it, and only a probe counts a bare capability error', () => {
  const body = error => ({ error: { message: 'Rejected.', type: 'invalid_request_error', ...error } });
  const capability = 'subscription_sharing_unsupported_capability';
  // [status, error body, result for traffic, result for a probe]
  const table = [
    [400, body({ code: 'model_not_found' }), 'model_not_found', 'model_not_found'],
    [404, body({ code: 'model_not_found', param: null }), 'model_not_found', 'model_not_found'],
    [400, body({ code: 'invalid_model', param: 'tools' }), 'invalid_model', 'invalid_model'],
    [400, body({ code: 'unsupported_value', param: 'model' }), 'unsupported_value', 'unsupported_value'],
    [400, body({ param: 'model' }), 'model_rejected', 'model_rejected'],
    [404, body({ code: 'x'.repeat(65), param: 'model' }), 'model_rejected', 'model_rejected'],
    [400, body({ code: capability, param: 'model' }), capability, capability],
    [400, body({ code: capability }), null, capability],
    [404, body({ code: capability, param: null }), null, capability],
    [400, body({ code: capability, param: 'reasoning.effort' }), null, null],
    [400, body({ code: capability, param: 'tools' }), null, null],
    [400, body({ code: 'invalid_value', param: 'input' }), null, null],
    [404, body({ code: 'not_found' }), null, null],
    [403, body({ code: 'model_not_found' }), null, null],
    [401, body({ code: 'invalid_model' }), null, null],
    [429, body({ param: 'model' }), null, null],
    [500, body({ code: 'model_not_found' }), null, null],
    [400, { code: 'model_not_found' }, 'model_not_found', 'model_not_found'],
    [400, { error: 'model_not_found' }, null, null],
    [400, null, null, null],
    [400, 'model_not_found', null, null],
    [400, [body({ code: 'model_not_found' })], null, null],
  ];
  for (const [status, errorBody, traffic, probe] of table) {
    const label = `${status} ${JSON.stringify(errorBody)}`;
    assert.equal(classifyModelRejection(status, errorBody, { source: 'traffic' }), traffic, `traffic: ${label}`);
    assert.equal(classifyModelRejection(status, errorBody, { source: 'probe' }), probe, `probe: ${label}`);
  }
  assert.equal(classifyModelRejection(400, body({ code: capability })), null, 'traffic is the default');
});

test('the catalog keeps listable text models in server order, caches them 5 min and serves a stale copy for 1 h', async () => {
  const catalog = [
    entry('gpt-6-sol', { display_name: 'GPT-6 Sol' }),
    entry('gpt-6-hidden', { visibility: 'hide' }),
    entry('gpt-6-chat-only', { supported_in_api: false }),
    entry('gpt-image-2'),
    entry('relmio-Image-x'),
    entry('bad slug'),
    entry('-leading'),
    { slug: 42, visibility: 'list' },
    null,
    entry(TOKEN),
    entry('gpt-6-luna', { display_name: 'x'.repeat(257) }),
    entry('gpt-6-astra', { display_name: 'Astra\u0007' }),
    entry('gpt-6-terra', { display_name: `Terra ${TOKEN}` }),
    entry('gpt-6-nova', { display_name: '' }),
    entry('gpt-6-sol', { display_name: 'Duplicate' }),
    entry('gpt-6.1-sol', { display_name: 'GPT-6.1 Sol', supported_in_api: undefined }),
    entry('gpt-6-vega', { display_name: 'v'.repeat(256) }),
  ];
  const listedIds = ['gpt-6-sol', 'gpt-6-luna', 'gpt-6-astra', 'gpt-6-terra', 'gpt-6-nova', 'gpt-6.1-sol', 'gpt-6-vega'];
  const { clock, calls, routes, discovery } = harness({ catalog });
  assert.deepEqual(await discovery.listModels(), {
    models: [
      { id: 'gpt-6-sol', display_name: 'GPT-6 Sol' }, { id: 'gpt-6-luna', display_name: 'gpt-6-luna' },
      { id: 'gpt-6-astra', display_name: 'gpt-6-astra' }, { id: 'gpt-6-terra', display_name: 'gpt-6-terra' },
      { id: 'gpt-6-nova', display_name: 'gpt-6-nova' }, { id: 'gpt-6.1-sol', display_name: 'GPT-6.1 Sol' },
      { id: 'gpt-6-vega', display_name: 'v'.repeat(256) },
    ],
    clientVersion: LATEST, checksEnabled: false,
  });
  const [request] = calls.catalog;
  assert.equal(request.url, `https://api.openai.com/v1/models?client_version=${LATEST}`);
  assert.equal(request.options.headers.authorization, `Bearer ${TOKEN}`);
  assert.equal(request.options.redirect, 'error');

  clock.t = T0 + CATALOG_TTL_MS - 1;
  await discovery.listModels();
  assert.equal(calls.catalog.length, 1);
  clock.t = T0 + CATALOG_TTL_MS;
  await discovery.listModels();
  assert.equal(calls.catalog.length, 2);

  const fetchedAt = clock.t;
  for (const failure of [
    () => new Response('down', { status: 503 }),
    () => { throw new Error(`socket closed ${TOKEN}`); },
    () => Response.json({ data: [] }),
  ]) {
    routes.catalog = failure;
    clock.t = fetchedAt + HOUR - 1;
    assert.deepEqual(ids(await discovery.listModels()), listedIds, 'a failed refresh serves the last list');
    clock.t = fetchedAt + HOUR;
    await assert.rejects(discovery.listModels(), error => error.code === 'catalog_unavailable' && error.status === 503 &&
      error.recovery === 'retry-later' && !error.message.includes(TOKEN));
  }
  // A rejected sign-in and a failed lease never hide behind the cached list.
  clock.t = fetchedAt + CATALOG_TTL_MS;
  routes.catalog = () => new Response('expired', { status: 401 });
  await assert.rejects(discovery.listModels(), { code: 'catalog_unavailable', status: 401, recovery: 'reauthorize' });
  routes.catalog = () => Response.json({ models: catalog });
  const leaseError = Object.assign(new Error('locked'), { status: 503, recovery: 'retry-later', code: 'siwc_lock_unavailable' });
  routes.lease = () => { throw leaseError; };
  const before = calls.npm.length + calls.catalog.length;
  await assert.rejects(discovery.listModels(), error => error === leaseError, 'lease errors propagate unchanged');
  assert.equal(calls.npm.length + calls.catalog.length, before, 'a failed lease reaches no provider');
  assert.equal(calls.npm.length, 1, 'npm was asked once in all of this');

  const controller = new AbortController();
  controller.abort();
  const aborted = harness();
  await assert.rejects(aborted.discovery.listModels({ signal: controller.signal }), { name: 'AbortError' });
  assert.equal(networkCalls(aborted.calls), 0, 'an aborted request takes no lease and reaches no provider');

  const padded = bytes => [entry('gpt-6-sol', { base_instructions: 'x'.repeat(bytes) })];
  assert.deepEqual(ids(await harness({ catalog: padded(3.5 * 1024 * 1024) }).discovery.listModels()), ['gpt-6-sol']);
  await assert.rejects(harness({ catalog: padded(4 * 1024 * 1024) }).discovery.listModels(), { code: 'catalog_unavailable', status: 503 });

  const many = harness({ catalog: Array.from({ length: 300 }, (_, index) => entry(`model-${index}`)) });
  const listed = ids(await many.discovery.listModels());
  assert.equal(listed.length, 256);
  assert.equal(listed.at(-1), 'model-255');
});

test('concurrent callers share one catalog request, and a caller that gives up does not cancel it', async () => {
  let release;
  const gate = new Promise(done => { release = done; });
  const { calls, routes, discovery } = harness();
  routes.catalog = async () => { await gate; return Response.json({ models: CATALOG }); };
  const controller = new AbortController();
  const leaving = discovery.listModels({ signal: controller.signal });
  const staying = discovery.listModels();
  await until(() => calls.catalog.length === 1);
  controller.abort();
  await assert.rejects(leaving, { name: 'AbortError' });
  assert.equal(calls.catalog[0].options.signal.aborted, false);
  release();
  assert.deepEqual(ids(await staying), CATALOG_IDS);
  assert.equal(calls.catalog.length, 1);
  assert.equal(calls.leases.length, 2, 'each caller takes its own lease first');
  assert.deepEqual(calls.leases.map(options => options.signal.aborted), [true, false], 'each lease wait follows its own caller');
  assert.deepEqual(ids(await discovery.listModels()), CATALOG_IDS);
  assert.equal(calls.catalog.length, 1, 'the shared answer fills the cache');
});

test('processes share one npm check through the store, except a check dated in the future', async t => {
  const storageRoot = await root(t);
  await seedWith(storageRoot, storeJson({ checksEnabled: false, consent: null, codexRelease: { version: '0.162.0', checkedAt: iso(T0 - HOUR) } }));
  const shared = harness({ storageRoot });
  assert.equal((await shared.discovery.listModels()).clientVersion, '0.162.0');
  assert.equal(shared.calls.npm.length, 0);
  assert.equal(shared.calls.catalog[0].url, 'https://api.openai.com/v1/models?client_version=0.162.0');

  await seedWith(storageRoot, storeJson({ checksEnabled: false, consent: null,
    codexRelease: { version: '0.162.0', checkedAt: iso(T0 + 2 * VERSION_TTL_MS) } }));
  const skewed = harness({ storageRoot });
  assert.equal((await skewed.discovery.listModels()).clientVersion, LATEST);
  assert.equal(skewed.calls.npm.length, 1);
  assert.deepEqual((await readStoreFile(storageRoot)).codexRelease, { version: LATEST, checkedAt: iso(T0) });
});

test('status asks no npm and writes nothing: it reads the last shared npm check, or the pin', async t => {
  const storageRoot = await root(t);
  const fresh = harness({ storageRoot });
  const view = await fresh.discovery.status();
  assert.deepEqual([view.clientVersion, view.catalogCheckedAt, view.models.length], [CODEX_CLI_VERSION, iso(T0), 3]);
  assert.equal(fresh.calls.catalog[0].url, `https://api.openai.com/v1/models?client_version=${CODEX_CLI_VERSION}`);
  assert.deepEqual([fresh.calls.npm.length, await readdir(storageRoot)], [0, []]);

  await seedWith(storageRoot, storeJson({ checksEnabled: false, consent: null,
    codexRelease: { version: '0.162.0', checkedAt: iso(T0 - 2 * VERSION_TTL_MS) } }));
  const before = await readFile(storeFile(storageRoot));
  const shared = harness({ storageRoot });
  assert.equal((await shared.discovery.status()).clientVersion, '0.162.0', 'an old shared check is used as it is');
  assert.equal(shared.calls.npm.length, 0);
  assert.deepEqual([await readFile(storeFile(storageRoot)), await readdir(storeDir(storageRoot))], [before, [`${REGISTRATION}.json`]]);

  // Listing still makes the 12 h npm check.
  shared.clock.t = T0 + CATALOG_TTL_MS;
  assert.equal((await shared.discovery.listModels()).clientVersion, LATEST);
  assert.equal(shared.calls.npm.length, 1);
});

test('a failure hides a model by its source and the mode, and status rows say what n8n lists', async t => {
  const storageRoot = await root(t);
  const catalog = ['alpha', 'beta', 'gamma', 'delta', 'epsilon'].map(slug => entry(slug));
  const models = {
    alpha: record('verified', MINUTE),
    beta: record('failed', FAILURE_RETRY_MS - HOUR, { source: 'traffic', code: 'model_not_found' }),
    gamma: record('failed', HOUR, { code: 'model_not_found' }),
    delta: record('failed', FAILURE_RETRY_MS + 1, { source: 'traffic' }),
  };
  const { calls, discovery } = harness({ storageRoot, catalog });

  // Checks off: a traffic failure hides the model, a probe failure does not.
  await seedStore(storageRoot, { models });
  assert.deepEqual(ids(await discovery.listModels()), ['alpha', 'gamma', 'delta', 'epsilon']);
  assert.deepEqual(rows(await discovery.status()), [
    ['alpha', 'verified', true, iso(T0 - MINUTE)],
    ['beta', 'failed', false, iso(T0 - FAILURE_RETRY_MS + HOUR)],
    ['gamma', 'unchecked', true, null],
    ['delta', 'unchecked', true, null],
    ['epsilon', 'unchecked', true, null],
  ]);

  // Checks on: both kinds hide it, and n8n lists only verified models. Status starts no run.
  await seedStore(storageRoot, { checksEnabled: true, models });
  const on = await discovery.status();
  assert.equal(on.checksEnabled, true);
  assert.deepEqual(rows(on), [
    ['alpha', 'verified', true, iso(T0 - MINUTE)],
    ['beta', 'failed', false, iso(T0 - FAILURE_RETRY_MS + HOUR)],
    ['gamma', 'failed', false, iso(T0 - HOUR)],
    ['delta', 'unchecked', false, null],
    ['epsilon', 'unchecked', false, null],
  ]);

  // Checks on with nothing verified yet: everything no failure hides.
  await seedStore(storageRoot, { checksEnabled: true, models: { beta: models.beta, gamma: models.gamma } });
  assert.deepEqual(rows(await discovery.status()).map(([id, , listed]) => [id, listed]),
    [['alpha', true], ['beta', false], ['gamma', false], ['delta', true], ['epsilon', true]]);
  await settle();
  assert.equal(calls.probe.length, 0, 'status never starts a run');

  // Checks on with nothing due: only verified models, and no run.
  await seedStore(storageRoot, { checksEnabled: true, models: { ...models,
    delta: record('verified', MINUTE, { source: 'traffic' }), epsilon: record('failed', HOUR, { source: 'traffic' }) } });
  assert.deepEqual(await discovery.listModels(), {
    models: [{ id: 'alpha', display_name: 'Model alpha' }, { id: 'delta', display_name: 'Model delta' }],
    clientVersion: LATEST, checksEnabled: true,
  });

  // An approval of an older disclosure, or none at all, counts as checks off.
  for (const consent of [{ ...CONSENT, noticeVersion: OLD_NOTICE }, null]) {
    await seedWith(storageRoot, storeJson({ checksEnabled: true, consent, models }));
    const listed = await discovery.listModels();
    assert.deepEqual([ids(listed), listed.checksEnabled], [['alpha', 'gamma', 'delta', 'epsilon'], false]);
  }
  await settle();
  assert.equal(calls.probe.length, 0, 'no run without the current approval');

  const wide = harness({ catalog: Array.from({ length: 100 }, (_, index) => entry(`model-${index}`)) });
  const view = await wide.discovery.status();
  assert.deepEqual([view.models.length, view.models.at(-1).id], [64, 'model-63']);
  assert.equal((await wide.discovery.listModels()).models.length, 100);
});

test('with checks on, n8n keeps the full list until a model answers, from one background run that listing never awaits', { timeout: 30_000 }, async t => {
  const storageRoot = await root(t);
  const catalog = ['alpha', 'beta', 'gamma', 'delta'].map(slug => entry(slug));
  const beta = record('failed', HOUR, { source: 'traffic', code: 'model_not_found' });
  await seedStore(storageRoot, { checksEnabled: true, models: { beta } });
  let open;
  const gate = new Promise(done => { open = done; });
  const { clock, calls, discovery } = harness({ storageRoot, catalog, probe: async body => {
    await gate;
    return body.model === 'delta' ? completed() : apiError(404, { code: 'model_not_found' })();
  } });

  // The first probe waits at the gate, so this would never resolve if listing awaited the run.
  const bootstrap = await discovery.listModels();
  assert.deepEqual([ids(bootstrap), bootstrap.checksEnabled], [['alpha', 'gamma', 'delta'], true]);
  await until(() => calls.probe.length === 1);
  assert.deepEqual(ids(await discovery.listModels()), ['alpha', 'gamma', 'delta']);
  await settle();
  assert.equal(calls.probe.length, 1, 'a second run started while the first was in flight');
  open();
  await until(async () => (await readStoreFile(storageRoot)).models.delta?.state === 'verified' && await idle(storageRoot));
  assert.deepEqual(calls.probe.map(({ body }) => body.model), ['alpha', 'gamma', 'delta']);
  assert.deepEqual(calls.sleeps, [5_000, 5_000]);
  const failed = { state: 'failed', checkedAt: iso(T0), source: 'probe', code: 'model_not_found' };
  assert.deepEqual((await readStoreFile(storageRoot)).models,
    { beta, alpha: failed, gamma: failed, delta: { state: 'verified', checkedAt: iso(T0), source: 'probe' } });

  assert.deepEqual(ids(await discovery.listModels()), ['delta']);
  await settle();
  assert.equal(calls.probe.length, 3, 'nothing is due, so nothing runs');

  // A day later the failures are due again, and they stay hidden while they keep failing.
  clock.t = T0 + FAILURE_RETRY_MS;
  assert.deepEqual(ids(await discovery.listModels()), ['delta']);
  await until(async () => (await readStoreFile(storageRoot)).models.gamma.checkedAt === iso(clock.t) && await idle(storageRoot));
  assert.deepEqual(calls.probe.slice(3).map(({ body }) => body.model), ['alpha', 'beta', 'gamma']);
  assert.deepEqual(ids(await discovery.listModels()), ['delta']);
});

test('a background run that stops or leaves a model unanswered pauses background checks for an hour', { timeout: 30_000 }, async t => {
  for (const [name, answer, probed] of [['usage limit', apiError(429, { code: 'rate_limit_exceeded' }), 1], ['server error', apiError(503, { code: 'busy' }), 2]]) {
    const storageRoot = await root(t);
    await seedStore(storageRoot, { checksEnabled: true });
    const { clock, calls, routes, discovery } = harness({ storageRoot, catalog: [entry('alpha'), entry('beta')], probe: answer });
    await discovery.listModels();
    await until(() => calls.probe.length === probed);
    await settle();
    assert.equal(calls.probe.length, probed, name);
    clock.t = T0 + HOUR - 1;
    await discovery.listModels();
    await settle();
    assert.equal(calls.probe.length, probed, `${name}: a run started within the hour`);
    clock.t = T0 + HOUR;
    routes.probe = completed;
    await discovery.listModels();
    await until(() => calls.probe.length === probed + 2);
  }

  // A run that saved every answer leaves no pause: a new model is checked as soon as it appears.
  const storageRoot = await root(t);
  await seedStore(storageRoot, { checksEnabled: true });
  const { clock, calls, routes, discovery } = harness({ storageRoot, catalog: [entry('alpha')] });
  await discovery.listModels();
  await until(async () => (await readStoreFile(storageRoot)).models.alpha?.state === 'verified' && await idle(storageRoot));
  await settle();
  routes.catalog = () => Response.json({ models: [entry('alpha'), entry('beta')] });
  clock.t = T0 + CATALOG_TTL_MS;
  await discovery.listModels();
  await until(() => calls.probe.length === 2);
  assert.equal(calls.probe[1].body.model, 'beta');
});

test('turning checks off, or an outdated approval, stops a background run before its next probe', { timeout: 30_000 }, async t => {
  const storageRoot = await root(t);
  await seedStore(storageRoot, { checksEnabled: true });
  let open;
  const gate = new Promise(done => { open = done; });
  const sidecar = harness({ storageRoot, probe: async () => { await gate; return completed(); } });
  await sidecar.discovery.listModels();
  await until(() => sidecar.calls.probe.length === 1);
  const cli = harness({ storageRoot });
  assert.equal((await cli.discovery.setChecks({ enabled: false })).checksEnabled, false);
  assert.equal(networkCalls(cli.calls), 0, 'turning checks off makes no network call');
  open();
  await until(async () => (await readStoreFile(storageRoot)).models['gpt-6-sol']?.state === 'verified' && await idle(storageRoot));
  await settle();
  assert.deepEqual(sidecar.calls.probe.map(({ body }) => body.model), ['gpt-6-sol']);
  const saved = await readStoreFile(storageRoot);
  assert.deepEqual([saved.checksEnabled, saved.consent], [false, null], 'the answer that landed kept checks off');

  const second = await root(t);
  await seedStore(second, { checksEnabled: true });
  let release;
  const held = new Promise(done => { release = done; });
  const other = harness({ storageRoot: second, probe: async () => { await held; return completed(); } });
  await other.discovery.listModels();
  await until(() => other.calls.probe.length === 1);
  await seedWith(second, storeJson({ models: {}, consent: { ...CONSENT, noticeVersion: OLD_NOTICE } }));
  release();
  await until(async () => (await readStoreFile(second)).models['gpt-6-sol']?.state === 'verified' && await idle(second));
  await settle();
  assert.equal(other.calls.probe.length, 1);
});

test('turning checks off while a probe waits for its lease sends no probe', { timeout: 30_000 }, async t => {
  const storageRoot = await root(t);
  await seedStore(storageRoot, { checksEnabled: true });
  let release;
  const slow = new Promise(done => { release = done; });
  const sidecar = harness({ storageRoot });
  // The catalog's lease is quick; the probe's waits until checks are off.
  sidecar.routes.lease = async () => {
    if (sidecar.calls.leases.length > 1) await slow;
    return { accessToken: TOKEN };
  };
  await sidecar.discovery.listModels();
  await until(() => sidecar.calls.leases.length === 2);
  assert.equal((await harness({ storageRoot }).discovery.setChecks({ enabled: false })).checksEnabled, false);
  release();
  await settle();
  await settle();
  assert.equal(sidecar.calls.probe.length, 0, 'a probe was sent after checks were turned off');
  const saved = await readStoreFile(storageRoot);
  assert.deepEqual([saved.checksEnabled, saved.consent, saved.models], [false, null, {}]);
});

test('close() aborts work in flight, stops a background run before its next probe and starts no new run', { timeout: 30_000 }, async t => {
  const storageRoot = await root(t);
  await seedStore(storageRoot, { checksEnabled: true });
  const hung = harness({ storageRoot, probe: hang });
  await hung.discovery.listModels();
  await until(() => hung.calls.probe.length === 1);
  const closed = hung.discovery.close();
  assert.equal(hung.calls.probe[0].options.signal.aborted, true, 'the probe in flight is aborted');
  await closed;
  await hung.discovery.close();
  assert.deepEqual(ids(await hung.discovery.listModels()), CATALOG_IDS);
  await settle();
  assert.deepEqual([hung.calls.probe.length, hung.calls.leases.length], [1, 2], 'nothing was sent after close()');
  assert.deepEqual((await readStoreFile(storageRoot)).models, {});

  // A run waiting between probes, or for a probe's lease, stops at once.
  const spaced = await root(t);
  await seedStore(spaced, { checksEnabled: true });
  const sleeping = harness({ storageRoot: spaced, deps: { sleep: (ms, value, options) => new Promise((_, fail) => {
    sleeping.calls.sleeps.push(ms);
    options?.signal?.addEventListener('abort', () => fail(options.signal.reason), { once: true });
  }) } });
  await sleeping.discovery.listModels();
  await until(() => sleeping.calls.sleeps.length === 1);
  await sleeping.discovery.close();
  assert.equal(sleeping.calls.probe.length, 1);

  const leasing = await root(t);
  await seedStore(leasing, { checksEnabled: true });
  const waiting = harness({ storageRoot: leasing });
  waiting.routes.lease = () => waiting.calls.leases.length > 1 ? new Promise(() => {}) : { accessToken: TOKEN };
  await waiting.discovery.listModels();
  await until(() => waiting.calls.leases.length === 2);
  await waiting.discovery.close();
  assert.deepEqual([waiting.calls.leases[1].signal.aborted, waiting.calls.probe.length], [true, 0]);

  // A catalog lease taken without a caller's signal is aborted too.
  const opening = harness({ storageRoot: await root(t), lease: () => new Promise(() => {}) });
  const run = opening.discovery.verifyNow({ enabling: true });
  await until(() => opening.calls.leases.length === 1);
  opening.discovery.close();
  assert.deepEqual(await run, { checked: 0, verified: 0, failed: 0, stoppedReason: 'checks_off' });
  assert.deepEqual([opening.calls.leases[0].signal.aborted, networkCalls(opening.calls)], [true, 1]);
});

test('each probe answer is saved, skipped or ends the run as classified', { timeout: 60_000 }, async t => {
  let cancelled = false;
  const openStream = () => new Response(new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(event('response.created') + event('response.completed', { response: { status: 'completed' } })));
    },
    cancel() { cancelled = true; },
  }));
  const terminal = (type, code) => () => sse(event('response.created'), type === 'error'
    ? event('error', { code, message: TOKEN })
    : event(type, { response: { status: type === 'response.failed' ? 'failed' : 'incomplete', error: { code, message: TOKEN } } }));
  const saved = (state, code) => ({ result: { checked: 2, verified: state === 'verified' ? 2 : 1, failed: state === 'failed' ? 1 : 0 },
    record: { state, checkedAt: iso(T0), source: 'probe', ...(code && { code }) } });
  const stopped = stoppedReason => ({ result: { checked: 1, verified: 0, failed: 0, stoppedReason } });
  const skipped = { result: { checked: 2, verified: 1, failed: 0 } };
  const capability = 'subscription_sharing_unsupported_capability';
  const cases = {
    'completed': [openStream, saved('verified')],
    'model-not-found': [apiError(404, { code: 'model_not_found' }), saved('failed', 'model_not_found')],
    'invalid-model': [apiError(400, { code: 'invalid_model', param: null }), saved('failed', 'invalid_model')],
    'param-model': [apiError(400, { code: 'unsupported_value', param: 'model' }), saved('failed', 'unsupported_value')],
    'bare-capability': [apiError(400, { code: capability }), saved('failed', capability)],
    'effort-capability': [apiError(400, { code: capability, param: 'reasoning.effort' }), stopped('probe_rejected')],
    'bad-input': [apiError(400, { code: 'invalid_value', param: 'input' }), stopped('probe_rejected')],
    'route-404': [apiError(404, { code: 'not_found' }), stopped('probe_rejected')],
    'forbidden': [apiError(403, { code: 'subscription_sharing_route_not_supported' }), stopped('probe_rejected')],
    'unprocessable': [apiError(422, { code: 'invalid_value' }), stopped('probe_rejected')],
    'unauthorized': [apiError(401, { code: 'invalid_token' }), stopped('reauthorize')],
    'rate-limited': [apiError(429, { code: 'rate_limit_exceeded' }), stopped('usage_limit')],
    'stream-usage-limit': [terminal('response.failed', 'subscription_sharing_usage_limit_exceeded'), stopped('usage_limit')],
    'stream-usage-unavailable': [terminal('error', 'subscription_sharing_usage_unavailable'), stopped('usage_limit')],
    'stream-user-unavailable': [terminal('response.incomplete', 'subscription_sharing_user_unavailable'), stopped('usage_limit')],
    'stream-invalid-user': [terminal('response.failed', 'subscription_sharing_invalid_user'), stopped('reauthorize')],
    'stream-failed': [terminal('response.failed', 'server_error'), skipped],
    'stream-incomplete': [() => sse(event('response.incomplete', { response: { status: 'incomplete', incomplete_details: { reason: 'max_output_tokens' } } })), skipped],
    'stream-error': [terminal('error', 'server_error'), skipped],
    'completed-but-failed': [() => sse(event('response.completed', { response: { status: 'failed' } })), skipped],
    'no-terminal': [() => sse(event('response.created'), event('response.output_text.delta', { delta: 'OK' })), skipped],
    'oversized': [() => sse(event('response.output_text.delta', { delta: 'x'.repeat(256 * 1024) }), event('response.completed')), skipped],
    'server-error': [apiError(500, { code: 'server_error' }), skipped],
    'network': [() => { throw new TypeError(`fetch failed for ${TOKEN}`); }, skipped],
    'timeout': [() => { throw new DOMException('The operation timed out.', 'TimeoutError'); }, skipped],
  };
  for (const [name, [answer, expected]] of Object.entries(cases)) {
    const storageRoot = await root(t);
    const model = `p-${name}`;
    const { calls, discovery } = harness({ storageRoot, catalog: [entry(model), entry('z-next')],
      probe: body => body.model === model ? answer() : completed() });
    assert.deepEqual(await discovery.verifyNow({ enabling: true }), expected.result, name);
    assert.deepEqual(calls.probe.map(({ body }) => body.model), expected.result.stoppedReason ? [model] : [model, 'z-next'], name);
    const stored = await readStoreFile(storageRoot);
    assert.deepEqual(stored.models[model], expected.record, name);
    assert.equal(JSON.stringify(stored).includes(TOKEN), false, name);
  }
  assert.equal(cancelled, true, 'the probe ends the stream after the terminal event');
});

test('a probe is one tiny streamed request at the lowest listed reasoning effort, with a fresh lease each time', async t => {
  const catalog = [
    entry('e-objects', { supported_reasoning_levels: [{ effort: 'medium' }, { effort: 'low' }] }),
    entry('e-strings', { supported_reasoning_levels: ['xhigh', 'none'] }),
    entry('e-unknown', { supported_reasoning_levels: ['turbo'] }),
    entry('e-missing'),
  ];
  const storageRoot = await root(t);
  const { calls, discovery } = harness({ storageRoot, catalog });
  assert.deepEqual(await discovery.verifyNow({ enabling: true }), { checked: 4, verified: 4, failed: 0 });
  const [first] = calls.probe;
  assert.equal(first.options.method, 'POST');
  assert.equal(first.options.redirect, 'error');
  assert.equal(first.options.headers.authorization, `Bearer ${TOKEN}`);
  assert.deepEqual(first.body, {
    model: 'e-objects', instructions: 'Reply with OK.', input: [{ role: 'user', content: [{ type: 'input_text', text: 'OK' }] }],
    stream: true, store: false, reasoning: { effort: 'low' },
  });
  assert.deepEqual(calls.probe[1].body.reasoning, { effort: 'none' });
  assert.equal(Object.hasOwn(calls.probe[2].body, 'reasoning'), false, 'an unknown level sends no reasoning');
  assert.equal(Object.hasOwn(calls.probe[3].body, 'reasoning'), false);
  assert.equal(calls.leases.length, 1 + 4, 'each probe takes the lease again');
  assert.equal((await stat(storeDir(storageRoot))).mode & 0o777, 0o700);
  assert.equal((await stat(storeFile(storageRoot))).mode & 0o777, 0o600);
  assert.deepEqual(await readdir(storeDir(storageRoot)), [`${REGISTRATION}.json`]);

  // Without checks on, only the enabling run probes.
  const off = harness({ storageRoot: await root(t), catalog });
  assert.deepEqual(await off.discovery.verifyNow(), { checked: 0, verified: 0, failed: 0, stoppedReason: 'checks_off' });
  assert.equal(off.calls.probe.length, 0);
});

test('a run stops at its budget, cutting the probe in flight', { timeout: 30_000 }, async t => {
  const cut = harness({ storageRoot: await root(t), catalog: [entry('hung')], probe: hang });
  cut.routes.catalog = () => {
    cut.clock.t += 1_000 - 50;
    return Response.json({ models: [entry('hung')] });
  };
  const started = performance.now();
  assert.deepEqual(await cut.discovery.verifyNow({ enabling: true, budgetMs: 1_000 }),
    { checked: 1, verified: 0, failed: 0, stoppedReason: 'time_limit' });
  assert.ok(performance.now() - started < 10_000);
  assert.equal(cut.calls.probe[0].options.signal.aborted, true);
});

test('turning checks on probes first, then saves the setting and approval in one write', { timeout: 30_000 }, async t => {
  const storageRoot = await root(t);
  const catalog = [entry('alpha'), entry('beta'), entry('gamma')];
  let open;
  const gate = new Promise(done => { open = done; });
  const answers = { alpha: completed, beta: apiError(404, { code: 'model_not_found' }), gamma: apiError(503, { code: 'busy' }) };
  const cli = harness({ storageRoot, catalog, probe: async body => {
    if (body.model === 'alpha') await gate;
    return answers[body.model]();
  } });
  const sidecar = harness({ storageRoot, catalog, probe: apiError(503, { code: 'busy' }) });
  const enabling = cli.discovery.setChecks({ enabled: true });
  await until(() => cli.calls.probe.length === 1);
  // Meanwhile the sidecar still lists everything and starts no run of its own.
  const during = await sidecar.discovery.listModels();
  assert.deepEqual([ids(during), during.checksEnabled], [['alpha', 'beta', 'gamma'], false]);
  await settle();
  assert.equal(sidecar.calls.probe.length, 0);
  open();
  assert.deepEqual(await enabling, {
    checksEnabled: true, clientVersion: LATEST, catalogCheckedAt: iso(T0),
    lastRun: { checked: 3, verified: 1, failed: 1 },
    models: [
      { id: 'alpha', display_name: 'Model alpha', state: 'verified', listed: true, checkedAt: iso(T0) },
      { id: 'beta', display_name: 'Model beta', state: 'failed', listed: false, checkedAt: iso(T0) },
      { id: 'gamma', display_name: 'Model gamma', state: 'unchecked', listed: false },
    ],
  });
  assert.deepEqual([cli.calls.catalog.length, cli.calls.leases.length], [1, 4], 'the view reuses the run\'s catalog and lease count');
  const saved = await readStoreFile(storageRoot);
  assert.deepEqual([saved.checksEnabled, saved.consent], [true, { acceptedAt: iso(T0), noticeVersion: MODEL_CHECKS_NOTICE }]);
  assert.deepEqual(ids(await sidecar.discovery.listModels()), ['alpha']);
  await until(() => sidecar.calls.probe.length === 1);
  await settle();

  const many = harness({ storageRoot: await root(t), catalog: Array.from({ length: 14 }, (_, index) => entry(`m-${String(index).padStart(2, '0')}`)) });
  const wide = await many.discovery.setChecks({ enabled: true });
  assert.deepEqual(wide.lastRun, { checked: 12, verified: 12, failed: 0 });
  assert.deepEqual(wide.models.map(({ state }) => state), [...Array(12).fill('verified'), 'unchecked', 'unchecked']);
});

test('turning checks off makes no network call, clears the approval and reports from the cached catalog', async t => {
  const storageRoot = await root(t);
  await seedWith(storageRoot, storeJson({ codexRelease: { version: '0.162.0', checkedAt: iso(T0 - HOUR) } }));
  const cold = harness({ storageRoot });
  assert.deepEqual(await cold.discovery.setChecks({ enabled: false }),
    { checksEnabled: false, clientVersion: '0.162.0', catalogCheckedAt: null, models: [] });
  assert.equal(networkCalls(cold.calls), 0);
  const saved = await readStoreFile(storageRoot);
  assert.deepEqual([saved.checksEnabled, saved.consent, saved.models], [false, null, { 'gpt-6-sol': record('verified', MINUTE) }]);

  const warm = harness({ storageRoot });
  await warm.discovery.listModels();
  await seedStore(storageRoot, { checksEnabled: true, models: { 'gpt-6-luna': record('failed', HOUR) } });
  const before = networkCalls(warm.calls);
  const view = await warm.discovery.setChecks({ enabled: false });
  assert.equal(networkCalls(warm.calls), before);
  assert.equal(view.catalogCheckedAt, iso(T0));
  assert.deepEqual(view.models.map(({ id, state, listed }) => [id, state, listed]),
    [['gpt-6-sol', 'unchecked', true], ['gpt-6-luna', 'unchecked', true], ['gpt-6-astra', 'unchecked', true]],
    'with checks off a probe failure no longer hides the model');
});

test('passive learning writes once per change, only for catalog models, and never throws', async t => {
  const storageRoot = await root(t);
  await seedStore(storageRoot, { models: { 'gpt-6-astra': record('failed', HOUR) } });
  let renames = 0;
  const fileSystem = { ...fs, rename: async (...args) => { renames += 1; return fs.rename(...args); } };
  const { clock, discovery } = harness({ storageRoot, deps: { fileSystem } });
  const learn = (outcome, model = 'gpt-6-sol') => discovery.recordOutcome({ model, outcome });

  await learn('completed');
  assert.equal(renames, 0, 'nothing is learned before a catalog is loaded');
  assert.deepEqual(ids(await discovery.listModels()), CATALOG_IDS);
  const base = renames;
  for (let i = 0; i < 3; i++) await learn('completed');
  assert.equal(renames, base + 1);
  for (let i = 0; i < 3; i++) await learn('model_rejected', 'gpt-6-luna');
  assert.equal(renames, base + 2);
  for (const model of ['gpt-5-mini', 'typo-model-name', 'gpt-image-2']) await learn('model_rejected', model);
  assert.equal(renames, base + 2, 'ids outside the catalog are ignored');

  // A rejection from traffic replaces a probe failure, so the model is hidden with checks off too.
  await learn('model_rejected', 'gpt-6-astra');
  assert.equal(renames, base + 3);
  assert.deepEqual(ids(await discovery.listModels()), ['gpt-6-sol']);
  assert.deepEqual((await readStoreFile(storageRoot)).models, {
    'gpt-6-sol': { state: 'verified', checkedAt: iso(T0), source: 'traffic' },
    'gpt-6-luna': { state: 'failed', checkedAt: iso(T0), source: 'traffic' },
    'gpt-6-astra': { state: 'failed', checkedAt: iso(T0), source: 'traffic' },
  });

  await learn('model_rejected');
  await learn('completed');
  assert.equal(renames, base + 5, 'each change of state lands');
  clock.t = T0 + FAILURE_RETRY_MS;
  await learn('model_rejected', 'gpt-6-luna');
  assert.equal(renames, base + 6, 'a rejection refreshes a failure once it is 24 h old');
  assert.equal((await readStoreFile(storageRoot)).models['gpt-6-luna'].checkedAt, iso(clock.t));

  // Another process learns the stored state with its catalog and writes nothing for it.
  const restarted = harness({ storageRoot, deps: { fileSystem } });
  restarted.clock.t = clock.t;
  await restarted.discovery.listModels();
  const mark = renames;
  await restarted.discovery.recordOutcome({ model: 'gpt-6-sol', outcome: 'completed' });
  await restarted.discovery.recordOutcome({ model: 'gpt-6-sol', outcome: 'completed' });
  assert.equal(renames, mark);

  for (const input of [undefined, {}, { model: 'bad slug', outcome: 'completed' }, { model: 'gpt-6-sol', outcome: 'other' },
    { model: 'toString', outcome: 'constructor' }, { model: 42, outcome: 'completed' }]) {
    assert.equal(await discovery.recordOutcome(input), undefined);
  }
  await chmod(storeFile(storageRoot), 0o644);
  const before = await readFile(storeFile(storageRoot));
  assert.equal(await restarted.discovery.recordOutcome({ model: 'gpt-6-astra', outcome: 'completed' }), undefined, 'an unsafe store is swallowed');
  assert.deepEqual(await readFile(storeFile(storageRoot)), before);
  assert.equal(renames, mark);
});

test('an unsafe or corrupt store reads as missing, and only turning checks off may replace a safe corrupt file', async t => {
  const unsafe = {
    'symlinked file': async (storageRoot, outside) => {
      await seedWith(storageRoot, storeJson());
      await rm(storeFile(storageRoot));
      await writeFile(outside, storeJson(), { mode: 0o600 });
      await symlink(outside, storeFile(storageRoot));
    },
    'hard-linked file': async (storageRoot, outside) => {
      await seedWith(storageRoot, storeJson());
      await link(storeFile(storageRoot), outside);
    },
    'group-readable file': async storageRoot => {
      await seedWith(storageRoot, storeJson());
      await chmod(storeFile(storageRoot), 0o640);
    },
    'open directory': async storageRoot => {
      await seedWith(storageRoot, storeJson());
      await chmod(storeDir(storageRoot), 0o755);
    },
    'symlinked directory': async (storageRoot, outside) => {
      await mkdir(outside, { mode: 0o700 });
      await writeFile(join(outside, `${REGISTRATION}.json`), storeJson(), { mode: 0o600 });
      await symlink(outside, storeDir(storageRoot));
    },
  };
  const corrupt = {
    'corrupt JSON': storageRoot => seedWith(storageRoot, storeJson().slice(0, -1)),
    'empty file': storageRoot => seedWith(storageRoot, ''),
    'another registration': storageRoot => seedWith(storageRoot, storeJson({ registrationId: 'registration-9999' })),
    'unknown state': storageRoot => seedWith(storageRoot, storeJson({ models: { 'gpt-6-sol': record('great', 0) } })),
    'unknown source': storageRoot => seedWith(storageRoot, storeJson({ models: { 'gpt-6-sol': record('failed', 0, { source: 'guess' }) } })),
    'loose timestamp': storageRoot => seedWith(storageRoot, storeJson({ models: { 'gpt-6-sol': { ...record('verified', 0), checkedAt: '2026-10-06' } } })),
    'malformed approval': storageRoot => seedWith(storageRoot, storeJson({ consent: { noticeVersion: MODEL_CHECKS_NOTICE } })),
    'oversized': storageRoot => seedWith(storageRoot, storeJson({ padding: 'x'.repeat(64 * 1024) })),
  };
  const snapshot = async (storageRoot, outside) => ({
    entries: await readdir(storeDir(storageRoot)).then(names => names.sort(), error => error.code),
    file: await readFile(storeFile(storageRoot)).catch(error => error.code),
    outside: await readFile(outside).catch(error => error.code),
  });
  for (const [name, arrange] of [...Object.entries(unsafe), ...Object.entries(corrupt)]) {
    const storageRoot = await root(t);
    const outside = join(await root(t), 'outside');
    await arrange(storageRoot, outside);
    const before = await snapshot(storageRoot, outside);
    const { calls, discovery } = harness({ storageRoot });
    const listed = await discovery.listModels();
    assert.deepEqual([ids(listed), listed.checksEnabled], [CATALOG_IDS, false], name);
    assert.deepEqual((await discovery.status()).models.map(({ state }) => state), ['unchecked', 'unchecked', 'unchecked'], name);
    assert.deepEqual(await discovery.verifyNow(), { checked: 0, verified: 0, failed: 0, stoppedReason: 'checks_off' }, name);
    await assert.rejects(discovery.setChecks({ enabled: true }), { code: 'store_unsafe' }, name);
    assert.equal(await discovery.recordOutcome({ model: 'gpt-6-luna', outcome: 'model_rejected' }), undefined, name);
    assert.equal(calls.probe.length, 0, name);
    assert.deepEqual(await snapshot(storageRoot, outside), before, `${name} was changed`);
    if (Object.hasOwn(unsafe, name)) {
      await assert.rejects(discovery.setChecks({ enabled: false }), { code: 'store_unsafe' }, name);
      assert.deepEqual(await snapshot(storageRoot, outside), before, `${name} was changed`);
    } else {
      assert.equal((await discovery.setChecks({ enabled: false })).checksEnabled, false, name);
      const replaced = await readStoreFile(storageRoot);
      assert.deepEqual([replaced.registrationId, replaced.checksEnabled, replaced.consent, replaced.models], [REGISTRATION, false, null, {}], name);
    }
  }
  const relative = harness({ storageRoot: 'relative/root' });
  assert.deepEqual(ids(await relative.discovery.listModels()), CATALOG_IDS);
  await assert.rejects(relative.discovery.setChecks({ enabled: true }), { code: 'store_unsafe' });
  await assert.rejects(relative.discovery.setChecks({ enabled: false }), { code: 'store_unsafe' });
});

test('the store lock serializes writers, waits for a live holder until a deadline and replaces only a stale one', { timeout: 30_000 }, async t => {
  const storageRoot = await root(t);
  const tick = () => new Promise(done => setTimeout(done, 5));
  const catalog = Array.from({ length: 12 }, (_, index) => entry(`model-${index}`));
  const writers = [harness({ storageRoot, catalog, deps: { sleep: tick } }), harness({ storageRoot, catalog, deps: { sleep: tick } })];
  for (const writer of writers) await writer.discovery.listModels();
  await Promise.all(catalog.map(({ slug }, index) => writers[index % 2].discovery.recordOutcome({ model: slug, outcome: 'completed' })));
  assert.deepEqual(Object.keys((await readStoreFile(storageRoot)).models).sort(), catalog.map(({ slug }) => slug).sort(), 'no write was lost');

  await seedStore(storageRoot, { checksEnabled: true });
  const lock = lockFile(storageRoot);
  const live = JSON.stringify({ pid: 1, createdAt: iso(T0 - 119_000) });
  await writeFile(lock, live, { mode: 0o600 });
  const blocked = harness({ storageRoot });
  await assert.rejects(blocked.discovery.setChecks({ enabled: false }), { code: 'store_busy' });
  assert.ok(blocked.calls.sleeps.length > 0);
  assert.equal(await readFile(lock, 'utf8'), live, 'a live lock is left alone');
  assert.equal((await readStoreFile(storageRoot)).checksEnabled, true);

  const patient = harness({ storageRoot, deps: { sleep: () => rm(lock, { force: true }) } });
  assert.equal((await patient.discovery.setChecks({ enabled: false })).checksEnabled, false, 'a released lock is taken');

  await seedStore(storageRoot, { checksEnabled: true });
  await writeFile(lock, JSON.stringify({ pid: 1, createdAt: iso(T0 - 120_001) }), { mode: 0o600 });
  assert.equal((await harness({ storageRoot }).discovery.setChecks({ enabled: false })).checksEnabled, false, 'a stale lock is replaced');
  assert.equal(await exists(lock), false);

  await seedStore(storageRoot, { checksEnabled: true });
  await writeFile(lock, JSON.stringify({ pid: 1, createdAt: iso(T0) }), { mode: 0o600 });
  const timed = harness({ storageRoot, deps: { sleep: async () => { timed.clock.t += 400; } } });
  await assert.rejects(timed.discovery.setChecks({ enabled: false, budgetMs: 1_000 }), { code: 'store_busy' });
  assert.ok(timed.clock.t >= T0 + 1_000 && timed.clock.t < T0 + 2_000, 'the wait ends at the deadline');
});

test('the CLI prints one JSON line per command and never the token', { timeout: 30_000 }, async t => {
  const storageRoot = await root(t);
  const catalog = [entry('gpt-6-sol', { display_name: `Sol ${TOKEN}` }), entry('gpt-6-luna'), entry('gpt-6-astra')];
  const answers = {
    'gpt-6-sol': completed,
    'gpt-6-luna': apiError(404, { code: 'model_not_found' }),
    'gpt-6-astra': () => { throw new Error(`socket closed for ${TOKEN}`); },
  };
  const { calls, routes, deps } = harness({ storageRoot, catalog, probe: body => answers[body.model]() });
  const leases = [];
  let leaseError;
  const getAccessToken = async (registration, options) => {
    leases.push({ registration, options });
    if (leaseError) throw leaseError;
    return { accessToken: TOKEN, expiresAt: T0 + HOUR };
  };
  const env = { N8N_OPENAI_OAUTH_HOME: storageRoot, RELMIO_REGISTRATION_ID: REGISTRATION, RELMIO_RUNTIME_ID: 'runtime-1' };
  const run = async (command, overrides = {}) => {
    const output = { text: '', write(chunk) { this.text += chunk; } };
    const exitCode = await runModelDiscoveryCli({ command, env: { ...env, ...overrides }, output, deps: { ...deps, getAccessToken } });
    assert.match(output.text, /^[^\n]+\n$/u);
    assert.equal(output.text.includes(TOKEN), false, `${command} printed the token`);
    return { exitCode, result: JSON.parse(output.text) };
  };
  const quiet = () => networkCalls(calls) + leases.length;

  assert.deepEqual(await run('status'), { exitCode: 0, result: { checksEnabled: false, clientVersion: CODEX_CLI_VERSION, catalogCheckedAt: iso(T0), models: [
    { id: 'gpt-6-sol', display_name: 'gpt-6-sol', state: 'unchecked', listed: true },
    { id: 'gpt-6-luna', display_name: 'Model gpt-6-luna', state: 'unchecked', listed: true },
    { id: 'gpt-6-astra', display_name: 'Model gpt-6-astra', state: 'unchecked', listed: true },
  ] } });
  assert.deepEqual(leases[0].registration, { storageRoot, registrationId: REGISTRATION });
  assert.deepEqual([leases[0].options.runtimeId, leases[0].options.minValidityMs], ['runtime-1', 60_000]);
  assert.ok(leases[0].options.signal instanceof AbortSignal, 'the lease wait ends at the deadline');
  assert.equal(calls.probe.length, 0);
  assert.deepEqual([calls.npm.length, await readdir(storageRoot)], [0, []], 'status asks no npm and writes nothing');
  assert.equal(calls.catalog[0].url, `https://api.openai.com/v1/models?client_version=${CODEX_CLI_VERSION}`);

  assert.deepEqual(await run('checks-on'), { exitCode: 0, result: { checksEnabled: true, clientVersion: LATEST, catalogCheckedAt: iso(T0),
    lastRun: { checked: 3, verified: 1, failed: 1 },
    models: [
      { id: 'gpt-6-sol', display_name: 'gpt-6-sol', state: 'verified', listed: true, checkedAt: iso(T0) },
      { id: 'gpt-6-luna', display_name: 'Model gpt-6-luna', state: 'failed', listed: false, checkedAt: iso(T0) },
      { id: 'gpt-6-astra', display_name: 'Model gpt-6-astra', state: 'unchecked', listed: false },
    ] } });
  assert.deepEqual(calls.probe.map(({ body }) => body.model), ['gpt-6-sol', 'gpt-6-luna', 'gpt-6-astra']);

  const before = quiet();
  assert.deepEqual(await run('checks-off'), { exitCode: 0,
    result: { checksEnabled: false, clientVersion: LATEST, catalogCheckedAt: null, models: [] } });
  assert.equal(quiet(), before, 'checks-off makes no network call');
  assert.deepEqual((await run('status')).result.models.map(({ id, state, listed }) => [id, state, listed]),
    [['gpt-6-sol', 'verified', true], ['gpt-6-luna', 'unchecked', true], ['gpt-6-astra', 'unchecked', true]]);
  assert.equal(calls.npm.length, 1, 'only checks-on asked npm; status reads the check it shared');

  // Status still answers when the catalog or the sign-in fails, so checks can be turned off.
  routes.catalog = () => { throw new Error(`connect ECONNREFUSED ${TOKEN}`); };
  assert.deepEqual(await run('status'), { exitCode: 0, result: { checksEnabled: false, clientVersion: LATEST,
    catalogCheckedAt: null, catalogError: 'catalog_unavailable', models: [] } });
  routes.catalog = () => Response.json({ models: catalog });
  leaseError = Object.assign(new Error(`refresh failed for ${TOKEN}`), { recovery: 'reauthorize' });
  const signedOut = await run('status');
  assert.deepEqual([signedOut.exitCode, signedOut.result.catalogError, signedOut.result.models], [0, 'registration_unavailable', []]);
  assert.deepEqual(await run('checks-on'), { exitCode: 0, result: { checksEnabled: true, clientVersion: LATEST, catalogCheckedAt: null,
    catalogError: 'registration_unavailable', lastRun: { checked: 0, verified: 0, failed: 0, stoppedReason: 'reauthorize' }, models: [] } });
  leaseError = undefined;

  const failure = async (command, code, overrides) => {
    const { exitCode, result } = await run(command, overrides);
    assert.deepEqual([exitCode, Object.keys(result), result.error], [1, ['error', 'message'], code], command);
  };
  await failure('refresh', 'invalid_command');
  await failure('status', 'invalid_configuration', { RELMIO_REGISTRATION_ID: '../escape' });
  await failure('status', 'invalid_configuration', { RELMIO_RUNTIME_ID: '' });
  await failure('status', 'invalid_configuration', { N8N_OPENAI_OAUTH_HOME: 'relative' });
  await chmod(storeFile(storageRoot), 0o644);
  const unsafeBefore = quiet();
  await failure('checks-on', 'store_unsafe');
  await failure('checks-off', 'store_unsafe');
  assert.equal(quiet(), unsafeBefore, 'an unsafe store stops checks-on before any network call');
  await chmod(storeFile(storageRoot), 0o600);

  const script = fileURLToPath(new URL('../src/services/model-discovery.mjs', import.meta.url));
  const exec = args => promisify(execFile)(process.execPath, [script, ...args], { env }).then(
    ({ stdout }) => ({ code: 0, stdout }), error => ({ code: error.code, stdout: error.stdout }));
  const unknown = await exec(['refresh']);
  assert.deepEqual([unknown.code, JSON.parse(unknown.stdout).error], [1, 'invalid_command']);
  // No SIWC registration exists here, so the lease fails before any network request.
  const noLease = await exec(['status']);
  assert.deepEqual([noLease.code, JSON.parse(noLease.stdout).catalogError], [0, 'registration_unavailable']);
  for (const { stdout } of [unknown, noLease]) assert.equal(stdout.includes(TOKEN), false);
});

test('CLI commands answer by their deadline, even when a lease never settles or probes run long', { timeout: 30_000 }, async t => {
  const run = async (command, storageRoot, deps) => {
    const output = { text: '', write(chunk) { this.text += chunk; } };
    const env = { N8N_OPENAI_OAUTH_HOME: storageRoot, RELMIO_REGISTRATION_ID: REGISTRATION, RELMIO_RUNTIME_ID: 'runtime-1' };
    const exitCode = await runModelDiscoveryCli({ command, env, output, deps });
    return { exitCode, result: JSON.parse(output.text) };
  };
  // The first reading is the CLI start; every later one is `elapsed` after it.
  const startedBefore = elapsed => { let first = true; return () => { if (!first) return T0 + elapsed; first = false; return T0; }; };
  const stuck = () => new Promise(() => {});
  const timeLimited = { checked: 0, verified: 0, failed: 0, stoppedReason: 'time_limit' };

  const statusRoot = await root(t);
  const status = harness({ storageRoot: statusRoot });
  const began = performance.now();
  assert.deepEqual(await run('status', statusRoot, { ...status.deps, now: startedBefore(60_000 - 50), getAccessToken: stuck }), { exitCode: 0,
    result: { checksEnabled: false, clientVersion: CODEX_CLI_VERSION, catalogCheckedAt: null, catalogError: 'catalog_unavailable',
      models: [] } });

  const onRoot = await root(t);
  const on = harness({ storageRoot: onRoot });
  assert.deepEqual(await run('checks-on', onRoot, { ...on.deps, now: startedBefore(180_000 - 50), getAccessToken: stuck }), { exitCode: 0,
    result: { checksEnabled: true, clientVersion: CODEX_CLI_VERSION, catalogCheckedAt: null, catalogError: 'catalog_unavailable',
      lastRun: timeLimited, models: [] } });
  assert.ok(performance.now() - began < 10_000);
  assert.equal(networkCalls(status.calls) + networkCalls(on.calls), 0);

  const slowRoot = await root(t);
  const catalog = ['b-1', 'b-2', 'b-3', 'b-4', 'b-5'].map(slug => entry(slug));
  const starts = [];
  const slow = harness({ storageRoot: slowRoot, catalog, probe: () => {
    starts.push(slow.clock.t);
    slow.clock.t += 70_000;
    return apiError(503, { code: 'busy' })();
  } });
  const limited = await run('checks-on', slowRoot, { ...slow.deps, getAccessToken: async () => ({ accessToken: TOKEN }) });
  assert.equal(limited.exitCode, 0);
  assert.deepEqual([limited.result.checksEnabled, limited.result.lastRun.stoppedReason], [true, 'time_limit']);
  assert.ok(starts.length < catalog.length && starts.every(at => at < T0 + 180_000), 'no probe starts after the deadline');
  assert.deepEqual(limited.result.models.map(({ state }) => state), catalog.map(() => 'unchecked'));
});

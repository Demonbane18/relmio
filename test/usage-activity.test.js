import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import {
  ACTIVITY_DIR, ACTIVITY_WRITE_MS, CODEX_CLI_VERSION, createModelDiscovery, runModelDiscoveryCli,
  usageRecordFromCli, usageView,
} from '../src/services/model-discovery.mjs';

const T0 = Date.parse('2026-10-07T12:00:00.000Z');
const MINUTE = 60_000;
const DAY = 86_400_000;
const REGISTRATION = 'registration-0001';
const iso = ms => new Date(ms).toISOString();
const zero = { requests: 0, completed: 0, failed: 0, incomplete: 0, input: 0, cached: 0, output: 0, reasoning: 0, total: 0 };
const counts = values => ({ ...zero, ...values });
const blank = state => ({ state, since: null, updatedAt: null, totals: zero, activeDays: 0, peakDay: null,
  days: [], models: [], lastUsageEvent: null });
const exists = path => stat(path).then(() => true, () => false);

async function root(t) {
  const storageRoot = await mkdtemp(join(tmpdir(), 'relmio-usage-'));
  t.after(() => rm(storageRoot, { recursive: true, force: true }));
  return storageRoot;
}
const activityDir = storageRoot => join(storageRoot, ACTIVITY_DIR);
const activityFile = storageRoot => join(activityDir(storageRoot), `${REGISTRATION}.json`);
const lockFile = storageRoot => join(activityDir(storageRoot), `${REGISTRATION}.lock`);
const readRecordFile = async storageRoot => JSON.parse(await readFile(activityFile(storageRoot), 'utf8'));
async function seed(storageRoot, text) {
  await mkdir(activityDir(storageRoot), { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  await writeFile(activityFile(storageRoot), text, { mode: 0o600 });
}
async function until(condition) {
  for (let attempt = 0; attempt < 2500; attempt++) {
    if (await condition()) return;
    await new Promise(done => setTimeout(done, 2));
  }
  assert.fail('The condition never held.');
}

// One sidecar process: its discovery with a test clock and write timer. Each record write is one rename.
function sidecar(storageRoot, { now = T0 } = {}) {
  const clock = { t: now };
  const timers = [];
  const writes = [];
  const fileSystem = { ...fs, rename: async (from, to) => { await fs.rename(from, to); writes.push(to); } };
  const discovery = createModelDiscovery({
    storageRoot, registrationId: REGISTRATION, pinnedClientVersion: CODEX_CLI_VERSION,
    getLease: async () => ({ accessToken: 'fake-siwc-access-token-0123456789' }),
    deps: {
      // Lock waits must yield real time: a no-op sleep spends every lock attempt at once on a loaded runner.
      now: () => clock.t, fileSystem, sleep: () => new Promise(resolve => setTimeout(resolve, 1)),
      fetchImpl: async () => { throw new Error('Counting requests makes no network call.'); },
      setTimer: (callback, ms) => { const timer = { callback, ms, cleared: false, unref() {} }; timers.push(timer); return timer; },
      clearTimer: timer => { timer.cleared = true; },
    },
  });
  // Ends the 30-second wait and waits for the write it starts.
  const elapse = async () => {
    const timer = timers.shift();
    assert.equal(timer?.ms, ACTIVITY_WRITE_MS);
    const before = writes.length;
    timer.callback();
    await until(async () => writes.length > before && !await exists(lockFile(storageRoot)));
  };
  return { clock, timers, writes, discovery, elapse };
}

// The request count store exists only in the Linux sidecar container, and its owner-only mode
// checks cannot pass on NTFS. Windows runs the tests that need no store.
const containerStoreSkip = process.platform === 'win32' &&
  'the request count store exists only in the Linux sidecar container; NTFS has no POSIX modes';

test('counts add up per UTC day and model, with tokens only from completed responses', { skip: containerStoreSkip }, async t => {
  const storageRoot = await root(t);
  const { discovery } = sidecar(storageRoot);
  const usage = { input_tokens: 100, input_tokens_details: { cached_tokens: 40 }, output_tokens: 30,
    output_tokens_details: { reasoning_tokens: 12 }, total_tokens: 130 };
  for (const entry of [
    { outcome: 'completed', usage },
    { outcome: 'completed', usage: { input_tokens: 5, output_tokens: 7 } },
    { outcome: 'incomplete', usage },
    { outcome: 'failed', usage },
    {},
  ]) discovery.recordActivity({ model: 'gpt-6-sol', accepted: true, ...entry });
  discovery.recordActivity({ model: 'gpt-6-luna', accepted: true, outcome: 'completed',
    usage: { input_tokens: -1, output_tokens: 1.5, total_tokens: 2 ** 53, input_tokens_details: { cached_tokens: '4' } } });
  // OpenAI did not accept it and no catalog lists it: a typo or pasted key is never stored as a name.
  discovery.recordActivity({ model: 'sk-pasted-key-0123456789', outcome: 'failed' });
  discovery.recordActivity({ model: '../escape', accepted: true, outcome: 'completed', usage });
  await discovery.close();

  const record = await readRecordFile(storageRoot);
  assert.deepEqual(record, {
    schemaVersion: 1, registrationId: REGISTRATION, startedAt: iso(T0), updatedAt: iso(T0),
    days: { '2026-10-07': {
      'gpt-6-sol': counts({ requests: 5, completed: 2, failed: 1, incomplete: 1, input: 105, cached: 40, output: 37, reasoning: 12, total: 142 }),
      'gpt-6-luna': counts({ requests: 1, completed: 1 }),
      other: counts({ requests: 2, completed: 1, failed: 1, input: 100, cached: 40, output: 30, reasoning: 12, total: 130 }),
    } },
    lastUsageEvent: null,
  });
  assert.equal(JSON.stringify(record).includes('sk-pasted'), false);
  assert.equal((await stat(activityDir(storageRoot))).mode & 0o777, 0o700);
  assert.equal((await stat(activityFile(storageRoot))).mode & 0o777, 0o600);
  assert.deepEqual(usageView(record, { registrationId: REGISTRATION, now: T0 }), {
    state: 'ok', since: iso(T0), updatedAt: iso(T0),
    totals: counts({ requests: 8, completed: 4, failed: 2, incomplete: 1, input: 205, cached: 80, output: 67, reasoning: 24, total: 272 }),
    activeDays: 1, peakDay: { date: '2026-10-07', total: 272 },
    days: [{ date: '2026-10-07', requests: 8, total: 272 }],
    models: [
      { id: 'gpt-6-sol', requests: 5, total: 142, input: 105, cached: 40, output: 37, reasoning: 12 },
      { id: 'gpt-6-luna', requests: 1, total: 0, input: 0, cached: 0, output: 0, reasoning: 0 },
      { id: 'other', requests: 2, total: 130, input: 100, cached: 40, output: 30, reasoning: 12 },
    ],
    lastUsageEvent: null,
  });

  // A later sidecar process adds to the stored counts instead of replacing them.
  const next = sidecar(storageRoot, { now: T0 + MINUTE });
  next.discovery.recordActivity({ model: 'gpt-6-sol', accepted: true, outcome: 'completed',
    usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } });
  await next.discovery.close();
  const merged = await readRecordFile(storageRoot);
  assert.deepEqual(merged.days['2026-10-07']['gpt-6-sol'],
    counts({ requests: 6, completed: 3, failed: 1, incomplete: 1, input: 106, cached: 40, output: 38, reasoning: 12, total: 144 }));
  assert.deepEqual([merged.startedAt, merged.updatedAt], [iso(T0), iso(T0 + MINUTE)]);
});

test('a model is named once OpenAI accepts the request or the last catalog lists it; two writers merge', { skip: containerStoreSkip }, async t => {
  const storageRoot = await root(t);
  const { discovery } = sidecar(storageRoot);
  discovery.recordActivity({ model: 'gpt-6-luna', outcome: 'failed' });
  const listed = createModelDiscovery({
    storageRoot, registrationId: REGISTRATION, pinnedClientVersion: CODEX_CLI_VERSION,
    getLease: async () => ({ accessToken: 'fake-siwc-access-token-0123456789' }),
    deps: { now: () => T0, sleep: () => new Promise(resolve => setTimeout(resolve, 1)), setTimer: () => ({ unref() {} }), clearTimer: () => {},
      fetchImpl: async url => new URL(url).origin === 'https://registry.npmjs.org' ? Response.json({ version: CODEX_CLI_VERSION })
        : Response.json({ models: [{ slug: 'gpt-6-luna', display_name: 'GPT-6 Luna', visibility: 'list' }] }) },
  });
  await listed.listModels();
  listed.recordActivity({ model: 'gpt-6-luna', outcome: 'failed' });
  listed.recordActivity({ model: 'gpt-6-astra', outcome: 'failed' });
  // Both processes write under the record's lock, and neither loses the other's counts.
  await Promise.all([discovery.close(), listed.close()]);
  assert.deepEqual((await readRecordFile(storageRoot)).days['2026-10-07'], {
    other: counts({ requests: 2, failed: 2 }),
    'gpt-6-luna': counts({ requests: 1, failed: 1 }),
  });
});

test('day rollover keeps the 31 most recent UTC days on disk; the view covers the last 30', { skip: containerStoreSkip }, async t => {
  const storageRoot = await root(t);
  const run = async (at, entry = {}) => {
    const { discovery } = sidecar(storageRoot, { now: at });
    discovery.recordActivity({ model: 'gpt-6-sol', accepted: true, outcome: 'completed',
      usage: { input_tokens: 1, output_tokens: 1 }, ...entry });
    await discovery.close();
    return readRecordFile(storageRoot);
  };
  const midnight = Date.parse('2026-10-08T00:00:00.000Z');
  await run(T0);
  await run(midnight - 1);
  let record = await run(midnight);
  assert.deepEqual(Object.keys(record.days), ['2026-10-07', '2026-10-08']);
  assert.equal(record.days['2026-10-07']['gpt-6-sol'].requests, 2);

  record = await run(T0 + 30 * DAY);
  assert.deepEqual(Object.keys(record.days), ['2026-10-07', '2026-10-08', '2026-11-06'], 'the 31st day back is still kept');
  const month = usageView(record, { registrationId: REGISTRATION, now: T0 + 30 * DAY });
  assert.deepEqual(month.days, [{ date: '2026-10-08', requests: 1, total: 2 }, { date: '2026-11-06', requests: 1, total: 2 }]);
  assert.equal(month.since, '2026-10-08T00:00:00.000Z', 'the view starts 30 days back once counting began earlier');
  assert.equal(month.totals.requests, 2);

  record = await run(T0 + 31 * DAY);
  assert.deepEqual(Object.keys(record.days), ['2026-10-08', '2026-11-06', '2026-11-07']);
  assert.equal(record.startedAt, iso(T0));
  record = await run(T0 + 31 * DAY + MINUTE, { usage: { input_tokens: 50, output_tokens: 50 } });
  const view = usageView(record, { registrationId: REGISTRATION, now: T0 + 31 * DAY + MINUTE });
  assert.deepEqual([view.activeDays, view.peakDay], [2, { date: '2026-11-07', total: 102 }]);
  assert.deepEqual(view.days.map(({ date }) => date), ['2026-11-06', '2026-11-07']);

  // Days outside the window leave an empty view that still says when counting last changed.
  assert.deepEqual(usageView(record, { registrationId: REGISTRATION, now: T0 + 90 * DAY }), {
    ...blank('empty'), since: '2026-12-07T00:00:00.000Z', updatedAt: record.updatedAt });
});

test('each day names at most 64 models and folds the rest into other; the view keeps the 64 busiest', { skip: containerStoreSkip }, async t => {
  const storageRoot = await root(t);
  const first = sidecar(storageRoot);
  for (let index = 0; index < 70; index++) {
    first.discovery.recordActivity({ model: `model-a${index}`, accepted: true, outcome: 'completed',
      usage: { input_tokens: index, output_tokens: 0 } });
  }
  first.discovery.recordActivity({ model: 'model-a0', accepted: true });
  await first.discovery.close();
  let record = await readRecordFile(storageRoot);
  const firstDay = record.days['2026-10-07'];
  assert.equal(Object.keys(firstDay).length, 65);
  assert.deepEqual(firstDay['model-a0'], counts({ requests: 2, completed: 1 }));
  assert.equal(firstDay['model-a64'], undefined);
  assert.deepEqual(firstDay.other, counts({ requests: 6, completed: 6, input: 399, total: 399 }));

  // A day that is already full folds a new model into other when stored counts are merged too.
  const second = sidecar(storageRoot, { now: T0 + MINUTE });
  second.discovery.recordActivity({ model: 'model-new', accepted: true, outcome: 'completed' });
  for (let index = 0; index <= 64; index++) {
    second.clock.t = T0 + DAY;
    second.discovery.recordActivity({ model: `model-b${index}`, accepted: true, outcome: 'completed',
      usage: { input_tokens: 100 + index, output_tokens: 0 } });
  }
  await second.discovery.close();
  record = await readRecordFile(storageRoot);
  assert.equal(Object.keys(record.days['2026-10-07']).length, 65);
  assert.deepEqual(record.days['2026-10-07'].other, counts({ requests: 7, completed: 7, input: 399, total: 399 }));
  assert.deepEqual(record.days['2026-10-08'].other, counts({ requests: 1, completed: 1, input: 164, total: 164 }));

  const view = usageView(record, { registrationId: REGISTRATION, now: T0 + DAY });
  assert.equal(view.models.length, 65);
  assert.deepEqual(view.models.slice(0, 2).map(({ id, total }) => [id, total]), [['model-b63', 163], ['model-b62', 162]]);
  assert.ok(view.models.slice(0, 64).every(({ id }) => id.startsWith('model-b')));
  // Day one's 64 named models (65 requests, 2016 tokens) join both days' other rows.
  assert.deepEqual(view.models.at(-1), { id: 'other', requests: 73, total: 2579, input: 2579, cached: 0, output: 0, reasoning: 0 });
  assert.equal(view.totals.requests, 137);
});

test('the last plan-usage event is kept until a later completed response clears it', { skip: containerStoreSkip }, async t => {
  const storageRoot = await root(t);
  const step = async (at, entries) => {
    const { discovery } = sidecar(storageRoot, { now: at });
    for (const entry of entries) discovery.recordActivity({ model: 'gpt-6-sol', accepted: true, ...entry });
    await discovery.close();
    return usageView(await readRecordFile(storageRoot), { registrationId: REGISTRATION, now: at }).lastUsageEvent;
  };
  assert.equal(await step(T0, [{ outcome: 'failed', code: 'model_not_found' },
    { outcome: 'incomplete', code: 'subscription_sharing_usage_limit_exceeded' }]), null);
  let at = T0;
  for (const [code, recovery] of [
    ['subscription_sharing_usage_limit_exceeded', 'manage-usage'],
    ['subscription_sharing_usage_unavailable', 'retry-later'],
    ['subscription_sharing_user_unavailable', 'retry-later'],
    ['subscription_sharing_user_not_eligible', 'none'],
  ]) {
    at += MINUTE;
    assert.deepEqual(await step(at, [{ outcome: 'failed', code }]), { at: iso(at), code, recovery });
  }
  const notEligible = { at: iso(at), code: 'subscription_sharing_user_not_eligible', recovery: 'none' };
  assert.deepEqual(await step(at + MINUTE, [{ outcome: 'failed' }, { outcome: 'incomplete' }, {}]), notEligible,
    'other failures, incomplete responses and abandoned requests keep it');
  assert.equal(await step(at + 2 * MINUTE, [{ outcome: 'completed' }]), null);
  const later = at + 3 * MINUTE;
  assert.deepEqual(await step(later, [{ outcome: 'completed' }, { outcome: 'failed', code: 'subscription_sharing_usage_limit_exceeded' }]),
    { at: iso(later), code: 'subscription_sharing_usage_limit_exceeded', recovery: 'manage-usage' }, 'an event after the completion stays');
  assert.equal(await step(later + MINUTE, [{ outcome: 'failed', code: 'subscription_sharing_usage_unavailable' }, { outcome: 'completed' }]), null);
});

test('counts are written 30 seconds after the first one, once per wait, and close writes the rest', { skip: containerStoreSkip }, async t => {
  const storageRoot = await root(t);
  const { discovery, timers, writes, elapse } = sidecar(storageRoot);
  const count = () => discovery.recordActivity({ model: 'gpt-6-sol', accepted: true, outcome: 'completed' });
  const requests = async () => (await readRecordFile(storageRoot)).days['2026-10-07']['gpt-6-sol'].requests;
  count(); count(); count();
  assert.equal(timers.length, 1, 'one write is scheduled for all three');
  await new Promise(done => setTimeout(done, 20));
  assert.deepEqual(writes, []);
  assert.equal(await exists(activityDir(storageRoot)), false, 'nothing touches the disk before the wait ends');
  await elapse();
  assert.deepEqual([writes.length, await requests()], [1, 3]);

  count(); count();
  assert.equal(timers.length, 1, 'the next counts wait for a new window');
  const waiting = timers[0];
  await discovery.close();
  assert.equal(waiting.cleared, true);
  assert.deepEqual([writes.length, await requests()], [2, 5], 'close writes what is left, once');

  // A request the shutdown cut off is written at once, without another timer.
  count();
  await until(async () => writes.length === 3 && !await exists(lockFile(storageRoot)));
  assert.deepEqual([timers.length, await requests()], [1, 6]);
  await discovery.close();
  waiting.callback();
  await new Promise(done => setTimeout(done, 20));
  assert.equal(writes.length, 3, 'with nothing pending, nothing is written');
});

test('a failed write keeps its counts for the next one, and odd input never throws', { skip: containerStoreSkip }, async t => {
  const storageRoot = await root(t);
  await mkdir(activityDir(storageRoot), { mode: 0o700 });
  await chmod(activityDir(storageRoot), 0o755);
  const { discovery, writes } = sidecar(storageRoot);
  for (const odd of [undefined, null, 'gpt-6-sol', 42, { outcome: 'done', usage: 'lots', code: {} }]) {
    assert.doesNotThrow(() => discovery.recordActivity(odd));
  }
  discovery.recordActivity({ model: 'gpt-6-sol', accepted: true, outcome: 'completed' });
  await discovery.close();
  assert.deepEqual(writes, [], 'a group-readable folder is refused');
  assert.equal(await exists(activityFile(storageRoot)), false);

  await chmod(activityDir(storageRoot), 0o700);
  discovery.recordActivity({ model: 'gpt-6-sol', accepted: true, outcome: 'completed' });
  await until(async () => writes.length === 1 && !await exists(lockFile(storageRoot)));
  assert.deepEqual((await readRecordFile(storageRoot)).days, { '2026-10-07': {
    other: counts({ requests: 5 }), 'gpt-6-sol': counts({ requests: 2, completed: 2 }),
  } });
});

test('a malformed record reads as unavailable', () => {
  const row = counts({ requests: 1, completed: 1, input: 5, total: 5 });
  const valid = { schemaVersion: 1, registrationId: REGISTRATION, startedAt: iso(T0), updatedAt: iso(T0),
    days: { '2026-10-07': { 'gpt-6-sol': row } }, lastUsageEvent: null };
  const named = (size) => Object.fromEntries(Array.from({ length: size }, (_, index) => [`model-${index}`, row]));
  for (const record of [valid, { ...valid, days: { '2026-10-07': { ...named(64), other: row } } }]) {
    assert.equal(usageView(record, { registrationId: REGISTRATION, now: T0 }).state, 'ok');
  }
  for (const malformed of [
    undefined, 'text', [], { ...valid, schemaVersion: 2 }, { ...valid, registrationId: 'registration-0002' },
    { ...valid, extra: true }, { ...valid, startedAt: 'yesterday' }, { ...valid, updatedAt: undefined },
    { ...valid, days: [] }, { ...valid, days: { '2026-02-30': valid.days['2026-10-07'] } },
    { ...valid, days: { '2026-10-7': valid.days['2026-10-07'] } },
    { ...valid, days: Object.fromEntries(Array.from({ length: 32 }, (_, index) => [iso(T0 - index * DAY).slice(0, 10), { other: row }])) },
    { ...valid, days: { '2026-10-07': named(65) } },
    { ...valid, days: { '2026-10-07': { '../auth': row } } },
    { ...valid, days: { '2026-10-07': { 'gpt-6-sol': { ...row, requests: -1 } } } },
    { ...valid, days: { '2026-10-07': { 'gpt-6-sol': { ...row, total: 2 ** 53 } } } },
    { ...valid, days: { '2026-10-07': { 'gpt-6-sol': { ...row, total: 1.5 } } } },
    { ...valid, days: { '2026-10-07': { 'gpt-6-sol': { ...row, prompt: 'must-not-show' } } } },
    { ...valid, days: { '2026-10-07': { 'gpt-6-sol': { ...row, cached: undefined } } } },
    { ...valid, lastUsageEvent: { at: iso(T0), code: 'model_not_found' } },
    { ...valid, lastUsageEvent: { at: iso(T0), code: 'subscription_sharing_usage_limit_exceeded', requestId: 'req_1' } },
    { ...valid, lastUsageEvent: undefined },
  ]) {
    assert.deepEqual(usageView(malformed, { registrationId: REGISTRATION, now: T0 }), blank('unavailable'),
      JSON.stringify(malformed)?.slice(0, 120));
  }
});

test('the next write replaces a malformed stored record, and an unsafe one is never touched', { skip: containerStoreSkip }, async t => {
  const storageRoot = await root(t);
  await seed(storageRoot, '{"schemaVersion":1,');
  const corrupt = sidecar(storageRoot);
  await assert.rejects(corrupt.discovery.activity(), { code: 'store_unsafe' });
  corrupt.discovery.recordActivity({ model: 'gpt-6-sol', accepted: true, outcome: 'completed' });
  await corrupt.discovery.close();
  assert.deepEqual(corrupt.writes.length, 1);
  assert.deepEqual((await readRecordFile(storageRoot)).days, { '2026-10-07': { 'gpt-6-sol': counts({ requests: 1, completed: 1 }) } });

  await chmod(activityFile(storageRoot), 0o644);
  const before = await readFile(activityFile(storageRoot), 'utf8');
  const unsafe = sidecar(storageRoot);
  await assert.rejects(unsafe.discovery.activity(), { code: 'store_unsafe' });
  unsafe.discovery.recordActivity({ model: 'gpt-6-sol', accepted: true, outcome: 'completed' });
  await unsafe.discovery.close();
  assert.deepEqual(unsafe.writes, []);
  assert.equal(await readFile(activityFile(storageRoot), 'utf8'), before);
  assert.equal((await stat(activityFile(storageRoot))).mode & 0o777, 0o644);
});

test('the usage command prints the stored record or null, and its result maps to a view', async t => {
  const storageRoot = await root(t);
  const env = { N8N_OPENAI_OAUTH_HOME: storageRoot, RELMIO_REGISTRATION_ID: REGISTRATION, RELMIO_RUNTIME_ID: 'runtime-1' };
  const usage = async (overrides = {}) => {
    const output = { text: '', write(chunk) { this.text += chunk; } };
    const code = await runModelDiscoveryCli({ command: 'usage', env: { ...env, ...overrides }, output });
    assert.match(output.text, /^[^\n]+\n$/u);
    return { code, stdout: output.text };
  };
  const nothing = await usage();
  assert.deepEqual(nothing, { code: 0, stdout: 'null\n' });
  assert.equal(await exists(activityDir(storageRoot)), false, 'reading creates nothing');
  assert.deepEqual(usageView(usageRecordFromCli(nothing, REGISTRATION)), blank('empty'));

  // The record the sidecar below writes for one plan-usage failure, as the usage command prints it.
  const stored = { schemaVersion: 1, registrationId: REGISTRATION, startedAt: iso(T0), updatedAt: iso(T0),
    days: { '2026-10-07': { 'gpt-6-sol': counts({ requests: 1, failed: 1 }) } },
    lastUsageEvent: { at: iso(T0), code: 'subscription_sharing_usage_limit_exceeded' } };
  await t.test('a sidecar\'s stored record is printed as it is, and an unsafe one is refused', { skip: containerStoreSkip }, async () => {
    const { discovery } = sidecar(storageRoot);
    discovery.recordActivity({ model: 'gpt-6-sol', accepted: true, outcome: 'failed', code: 'subscription_sharing_usage_limit_exceeded' });
    await discovery.close();
    const printed = await usage();
    assert.equal(printed.code, 0);
    assert.deepEqual([JSON.parse(printed.stdout), await readRecordFile(storageRoot)], [stored, stored]);
    await chmod(activityFile(storageRoot), 0o644);
    const unsafe = await usage();
    assert.deepEqual([unsafe.code, JSON.parse(unsafe.stdout)], [1,
      { error: 'store_unsafe', message: 'The request count record is unsafe. An administrator must inspect it.' }]);
    assert.equal(usageView(usageRecordFromCli(unsafe, REGISTRATION)).state, 'unavailable');

    const script = fileURLToPath(new URL('../src/services/model-discovery.mjs', import.meta.url));
    const fresh = await root(t);
    const { stdout } = await promisify(execFile)(process.execPath, [script, 'usage'], { env: { ...env, N8N_OPENAI_OAUTH_HOME: fresh } });
    assert.equal(stdout, 'null\n');
  });
  const printed = { code: 0, stdout: `${JSON.stringify(stored)}\n` };
  assert.deepEqual(usageRecordFromCli(printed, REGISTRATION), stored);
  assert.deepEqual(usageView(usageRecordFromCli(printed, REGISTRATION), { registrationId: REGISTRATION, now: T0 }).lastUsageEvent,
    { at: iso(T0), code: 'subscription_sharing_usage_limit_exceeded', recovery: 'manage-usage' });

  // A sidecar built before request counting has no usage command, or no model module at all, and counts nothing yet.
  for (const result of [
    { code: 1, stdout: `${JSON.stringify({ error: 'invalid_command', message: 'Unknown command.' })}\n` },
    { code: 1, stdout: '', stderr: "Error: Cannot find module '/app/services/model-discovery.mjs'\n    at Module._resolveFilename" },
    { code: 1, stdout: '', stderr: "Error [ERR_MODULE_NOT_FOUND]: Cannot find module '/app/services/siwc-session.mjs'" },
  ]) assert.equal(usageRecordFromCli(result, REGISTRATION), null, JSON.stringify(result));
  // Every other failed run, a failed exec or a crash included, is unavailable rather than empty.
  for (const result of [
    { code: 1, stdout: '' },
    { code: 1, stdout: '', stderr: 'Error response from daemon: container is not running' },
    { code: 137, stdout: '', stderr: '' },
    { code: 1, stdout: '', stderr: 'TypeError: Cannot read properties of undefined' },
    { code: 1, stdout: "Error: Cannot find module '/app/services/model-discovery.mjs'" },
    { code: 1, stdout: 'partial', stderr: "Error: Cannot find module '/app/services/model-discovery.mjs'" },
    { code: 1, stdout: JSON.stringify({ error: 'store_unsafe', message: 'remote text' }) },
    { code: 1, stdout: JSON.stringify({ error: 'invalid_configuration' }) },
    { code: 2, stdout: 'null' },
    { code: 0, stdout: 'not json' },
    { code: 0, stdout: '' },
    { code: 0, stdout: JSON.stringify({ ...stored, registrationId: 'registration-0002' }) },
  ]) assert.equal(usageView(usageRecordFromCli(result, REGISTRATION)).state, 'unavailable', JSON.stringify(result));

  const invalid = await usage({ RELMIO_REGISTRATION_ID: '../escape' });
  assert.deepEqual([invalid.code, JSON.parse(invalid.stdout).error], [1, 'invalid_configuration']);
});

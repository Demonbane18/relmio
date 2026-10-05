import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { access, mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { promisify } from 'node:util';
import test from 'node:test';
import { buildNpmPackage } from '../scripts/build-npm-package.js';
import { collectSiwcRuntimeAssets } from '../src/services/siwc-runtime-assets.js';
import {
  commitAuthorization, ensureSiwcHost, prepareAuthHandoff, readPendingAuthHandoff, setPlanEnabled,
} from '../src/services/siwc-session.mjs';

const dependencies = { jose: '6.2.12', ws: '8.22.0' };
const execFileAsync = promisify(execFile);

test('generated runtime package has pinned production closure and fixed credential-free assets', async () => {
  const result = await collectSiwcRuntimeAssets();
  const manifest = JSON.parse(result.packageJson);
  const lock = JSON.parse(result.packageLock);
  assert.deepEqual(manifest.dependencies, dependencies);
  assert.deepEqual(lock.packages[''].dependencies, dependencies);
  assert.equal(manifest.type, 'module');
  assert.equal(Object.hasOwn(manifest, 'devDependencies'), false);
  const required = new Set(Object.keys(manifest.dependencies));
  for (const name of required) {
    const entry = lock.packages[`node_modules/${name}`];
    assert.equal(entry.version, manifest.dependencies[name]);
    assert.match(entry.integrity, /^sha512-/u);
    for (const dependency of Object.keys({ ...entry.dependencies, ...entry.optionalDependencies })) required.add(dependency);
  }
  assert.deepEqual(new Set(Object.keys(lock.packages).filter(name => name !== '').map(name => name.slice('node_modules/'.length))), required);
  const paths = result.files.map(file => file.path);
  assert.equal(new Set(paths).size, paths.length);
  assert.ok(paths.includes('services/siwc-handoff.mjs'));
  assert.ok(paths.includes('services/siwc-session.mjs'));
  assert.ok(paths.includes('infrastructure/local-process.js'));
  assert.ok(paths.every(path => !path.startsWith('/') && !path.includes('..') && !/auth\.json|\.codex/u.test(path)));
  assert.ok(result.files.every(file => Buffer.isBuffer(file.contents) && file.contents.length > 0));
});

test('collector rejects a symlinked runtime source instead of following it', async t => {
  const tmp = await mkdtemp(join(tmpdir(), 'relmio-siwc-assets-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const result = await collectSiwcRuntimeAssets();
  const root = join(tmp, 'src');
  for (const file of result.files) {
    const path = join(root, file.path);
    await mkdir(dirname(path), { recursive: true });
    if (file.path === 'services/siwc-session.mjs') await symlink(join(root, 'services/siwc-handoff.mjs'), path);
    else await writeFile(path, file.contents);
  }
  await writeFile(join(tmp, 'package.json'), result.packageJson);
  await writeFile(join(tmp, 'package-lock.json'), result.packageLock);
  await assert.rejects(collectSiwcRuntimeAssets({ root }));
});

test('built npm tarball imports the collector without the repository package-lock', async t => {
  const tmp = await mkdtemp(join(tmpdir(), 'relmio-siwc-packed-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const extract = join(tmp, 'extracted');
  await mkdir(extract);
  const { tarballPath } = await buildNpmPackage({ outputDirectory: join(tmp, 'dist') });
  await execFileAsync('tar', ['-xzf', tarballPath, '-C', extract], { cwd: tmp });
  await assert.rejects(access(join(extract, 'package', 'package-lock.json')), { code: 'ENOENT' });
  const sealed = await readFile(join(extract, 'package', 'src', 'services', 'siwc-runtime-lock.json'));
  const installedModule = pathToFileURL(join(extract, 'package', 'src', 'services', 'siwc-runtime-assets.js')).href;
  const { collectSiwcRuntimeAssets: packedCollector } = await import(installedModule);
  const packed = await packedCollector();
  assert.deepEqual(JSON.parse(packed.packageJson).dependencies, dependencies);
  assert.deepEqual(JSON.parse(packed.packageLock).packages[''].dependencies, dependencies);
  assert.deepEqual(packed.packageLock, sealed);
  assert.ok(packed.files.every(file => Buffer.isBuffer(file.contents) && file.contents.length > 0));
});

test('collected runtime imports the handoff CLI and reads receipts with only its pinned dependency closure', async t => {
  const tmp = await mkdtemp(join(tmpdir(), 'relmio-siwc-runtime-cli-'));
  t.after(() => rm(tmp, { recursive: true, force: true }));
  const assets = await collectSiwcRuntimeAssets();
  const runtimeRoot = join(tmp, 'runtime');
  for (const file of assets.files) {
    const path = join(runtimeRoot, file.path);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, file.contents);
  }
  await writeFile(join(runtimeRoot, 'package.json'), assets.packageJson);
  await mkdir(join(runtimeRoot, 'node_modules'));
  for (const name of Object.keys(JSON.parse(assets.packageJson).dependencies)) {
    await symlink(fileURLToPath(new URL(`../node_modules/${name}`, import.meta.url)),
      join(runtimeRoot, 'node_modules', name), 'junction');
  }
  const storageRoot = join(tmp, 'sender');
  const destinationRoot = join(tmp, 'destination');
  const first = await commitAuthorization({ storageRoot, runtimeId: 'local', clientId: 'oaiapp_runtime_assets',
    identity: { issuer: 'https://auth.openai.com', subject: 'runtime-assets-subject' },
    tokens: { access_token: 'fixture-access', refresh_token: 'fixture-refresh',
      scope: 'openid offline_access resource.invoke chatgpt.tokens.use.direct', token_type: 'Bearer', expires_in: 3600 } });
  const source = { storageRoot, registrationId: first.registrationId };
  const enabled = await setPlanEnabled(source, { enabled: true, expectedGeneration: first.generation });
  const target = await ensureSiwcHost({ storageRoot: join(tmp, 'reviewed-target'), runtimeId: 'remote' });
  await prepareAuthHandoff(source, { expectedGeneration: enabled.generation, target, backgroundConsent: false });
  const pending = await readPendingAuthHandoff(source);
  const probe = `
    const { runSiwcHandoffCli } = await import(process.argv[1]);
    await runSiwcHandoffCli({ command: 'receipt', input: [Buffer.from(process.argv[2])] });
  `;
  const { stdout } = await execFileAsync(process.execPath, [
    '--input-type=module', '-e', probe, pathToFileURL(join(runtimeRoot, 'services/siwc-handoff.mjs')).href,
    JSON.stringify({ handoffId: pending.handoffId, binding: pending.binding, identity: pending.identity }),
  ], { cwd: runtimeRoot, timeout: 10000, env: { ...process.env,
    HOME: join(tmp, 'home'), N8N_OPENAI_OAUTH_HOME: destinationRoot,
    RELMIO_RUNTIME_ID: 'remote', RELMIO_REGISTRATION_ID: first.registrationId } });
  assert.deepEqual(JSON.parse(stdout), { receipt: null });
  await assert.rejects(access(destinationRoot), { code: 'ENOENT' });
});

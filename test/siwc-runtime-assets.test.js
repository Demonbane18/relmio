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
  INSTALL_ROOT, PRECHECK_COMMAND, SIDECAR_BUILD_IGNORE_CONTENT, SIDECAR_MANAGED_CONTEXT_GUARD,
  createVerificationCommands,
} from '../src/domain/safety.js';
import { createLocalN8nSidecarDockerignore } from '../src/domain/local-n8n-sidecar.js';
import { createLocalDockerignore } from '../src/domain/local-endpoints.js';
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
  assert.ok(paths.includes('services/codex-images.mjs'));
  assert.ok(paths.includes('services/model-discovery.mjs'));
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

const shippedFiles = ignore => ignore.split('\n')
  .filter(line => line.startsWith('!') && !line.endsWith('/')).map(line => line.slice(1));

test('every collected runtime file is guarded and hashed, and every shipped file symlink-checked, on the VPS', async () => {
  const { files } = await collectSiwcRuntimeAssets();
  const tokens = command => new Set(command.split(/[\s;]+/u));
  const guard = tokens(SIDECAR_MANAGED_CONTEXT_GUARD);
  const staged = tokens(createVerificationCommands().stagedFiles);
  const precheck = tokens(PRECHECK_COMMAND);
  for (const { path } of files) {
    assert.ok(guard.has(`${INSTALL_ROOT}/${path}`), path);
    assert.ok(staged.has(`${INSTALL_ROOT}/${path}`), path);
  }
  for (const path of shippedFiles(SIDECAR_BUILD_IGNORE_CONTENT)) assert.ok(precheck.has(`${INSTALL_ROOT}/${path}`), path);
});

test('every sidecar build context ships the modules the sidecar and its CLIs import', async t => {
  const assets = await collectSiwcRuntimeAssets();
  for (const [name, ignore] of Object.entries({
    vps: SIDECAR_BUILD_IGNORE_CONTENT, 'local-n8n': createLocalN8nSidecarDockerignore(),
    'codex-chat': createLocalDockerignore('codex-chat'), 'codex-chatgpt': createLocalDockerignore('codex-chatgpt'),
  })) await t.test(name, async t => {
    const context = await mkdtemp(join(tmpdir(), 'relmio-siwc-context-'));
    t.after(() => rm(context, { recursive: true, force: true }));
    const shipped = new Set(shippedFiles(ignore));
    for (const file of assets.files.filter(file => shipped.has(file.path))) {
      await mkdir(dirname(join(context, file.path)), { recursive: true });
      await writeFile(join(context, file.path), file.contents);
    }
    await writeFile(join(context, 'package.json'), assets.packageJson);
    await mkdir(join(context, 'node_modules'));
    for (const dependency of Object.keys(dependencies)) {
      await symlink(fileURLToPath(new URL(`../node_modules/${dependency}`, import.meta.url)),
        join(context, 'node_modules', dependency), 'junction');
    }
    const probe = `for (const path of ['gateway/openai-oauth-sidecar.mjs', 'services/codex-images.mjs', 'services/model-discovery.mjs'])
      await import(new URL(path, process.env.RELMIO_CONTEXT_URL).href);`;
    await execFileAsync(process.execPath, ['--input-type=module', '-e', probe], { cwd: context, timeout: 10000,
      env: { ...process.env, RELMIO_CONTEXT_URL: pathToFileURL(`${context}/`).href } });
  });
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

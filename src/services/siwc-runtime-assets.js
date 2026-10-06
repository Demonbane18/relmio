import * as fs from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceRoot = dirname(dirname(fileURLToPath(import.meta.url)));
const SOURCES = Object.freeze([
  'gateway/openai-oauth-sidecar.mjs',
  'gateway/codex-chat.js',
  'gateway/codex-app-server.mjs',
  'services/siwc-session.mjs',
  'services/siwc-handoff.mjs',
  'services/local-integration-lifecycle-lock.js',
  'services/codex-images.mjs',
  'infrastructure/local-process.js',
  'infrastructure/process-identity.js',
]);

export async function collectSiwcRuntimeAssets({ root = sourceRoot, fileSystem = fs } = {}) {
  const files = await Promise.all(SOURCES.map(async path => {
    const source = join(root, path);
    const stat = await fileSystem.lstat(source);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size < 1 || stat.size > 1024 * 1024) throw new Error('SIWC runtime source is unsafe.');
    const handle = await fileSystem.open(source, 'r');
    try {
      const opened = await handle.stat();
      if (!opened.isFile() || opened.dev !== stat.dev || opened.ino !== stat.ino) throw new Error('SIWC runtime source changed.');
      const contents = await handle.readFile();
      if (contents.length !== stat.size) throw new Error('SIWC runtime source changed.');
      return { path, contents };
    } finally { await handle.close(); }
  }));
  const packageRoot = dirname(root);
  const manifest = JSON.parse(await fileSystem.readFile(join(packageRoot, 'package.json'), 'utf8'));
  const dependencies = { jose: manifest.dependencies?.jose, ws: manifest.dependencies?.ws };
  if (Object.values(dependencies).some(version => typeof version !== 'string' || !/^\d+\.\d+\.\d+$/u.test(version)))
    throw new Error('SIWC runtime dependencies must be pinned.');
  let lockBytes;
  try { lockBytes = await fileSystem.readFile(join(packageRoot, 'package-lock.json'), 'utf8'); }
  catch (error) {
    if (error?.code !== 'ENOENT') throw error;
    lockBytes = await fileSystem.readFile(join(root, 'services/siwc-runtime-lock.json'), 'utf8');
  }
  const lock = JSON.parse(lockBytes);
  if (lock.lockfileVersion !== 3 || Object.entries(dependencies).some(([name, version]) =>
    lock.packages?.['']?.dependencies?.[name] !== version)) throw new Error('SIWC runtime dependency lock is invalid.');
  const packages = { '': { name: 'relmio-siwc-runtime', version: '1.0.0', dependencies, engines: { node: '>=24' } } };
  for (const [name, version] of Object.entries(dependencies)) {
    const entry = lock.packages?.[`node_modules/${name}`];
    if (entry?.version !== version || !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(entry.integrity ?? '') ||
        entry.resolved !== `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz` ||
        Object.keys(entry.dependencies ?? {}).length || Object.keys(entry.optionalDependencies ?? {}).length)
      throw new Error('SIWC runtime dependency lock is invalid.');
    packages[`node_modules/${name}`] = entry;
  }
  const packageJson = Buffer.from(`${JSON.stringify({ name: 'relmio-siwc-runtime', version: '1.0.0', private: true,
    type: 'module', engines: { node: '>=24' }, dependencies }, null, 2)}\n`);
  const packageLock = Buffer.from(`${JSON.stringify({ name: 'relmio-siwc-runtime', version: '1.0.0',
    lockfileVersion: 3, requires: true, packages }, null, 2)}\n`);
  return { files, packageJson, packageLock };
}

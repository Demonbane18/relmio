import { constants } from 'node:fs';
import { open, lstat, readdir, chmod, writeFile } from 'node:fs/promises';
import { join, isAbsolute } from 'node:path';

const loginRequired = () => Object.assign(new Error('login_required'), { code: 'login_required' });
const uid = () => process.getuid?.();
const privateFile = stat => stat.isFile() && stat.nlink === 1 && stat.uid === uid() && (stat.mode & 0o777) === 0o600 && stat.size <= 64 * 1024;

async function readPrivate(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!privateFile(stat)) throw loginRequired();
    const buffer = Buffer.alloc(64 * 1024 + 1);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 64 * 1024) throw loginRequired();
    return JSON.parse(buffer.subarray(0, bytesRead).toString('utf8'));
  } finally { await handle.close(); }
}

export function selectFreshSessionToken(record, now = Date.now()) {
  if (!record || typeof record !== 'object' || Array.isArray(record) || Object.keys(record).length !== 1) throw loginRequired();
  const entry = Object.values(record)[0];
  const scope = Object.keys(record)[0];
  if (typeof entry?.oidc_client_id !== 'string' || !entry.oidc_client_id || scope !== `https://auth.x.ai::${entry.oidc_client_id}`) throw loginRequired();
  if (!entry || entry.auth_mode !== 'oidc' || entry.oidc_issuer !== 'https://auth.x.ai' || typeof entry.key !== 'string' || !/^[A-Za-z0-9._~+/-]+=*$/u.test(entry.key) || entry.key.length < 16 || entry.key.length > 32 * 1024 || typeof entry.expires_at !== 'string' || !/^\d{4}-\d{2}-\d{2}T/u.test(entry.expires_at) || !(Date.parse(entry.expires_at) > now + 60_000)) throw loginRequired();
  return entry.key;
}

// Only open the new runtime's own volume. This has no home-directory discovery,
// token import, token export, refresh-grant implementation or API-key fallback.
export async function createFreshGrokSession({ directory, instanceId, initialize = false, now = Date.now }) {
  if (process.platform === 'win32' || typeof directory !== 'string' || !isAbsolute(directory) || !/^[a-f0-9]{32}$/u.test(instanceId)) throw new Error('invalid_session_configuration');
  const markerPath = join(directory, '.relmio-fresh-session.json');
  const marker = { schema: 1, kind: 'relmio-fresh-grok-session', instanceId };
  const checkDirectory = async () => {
    const stat = await lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid() || (stat.mode & 0o777) !== 0o700) throw loginRequired();
  };
  try {
    if (initialize) {
      const stat = await lstat(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== uid() || (await readdir(directory)).length !== 0) throw loginRequired();
      await chmod(directory, 0o700);
      await writeFile(markerPath, JSON.stringify(marker), { flag: 'wx', mode: 0o600 });
    }
    await checkDirectory();
    const found = await readPrivate(markerPath);
    if (JSON.stringify(found) !== JSON.stringify(marker)) throw loginRequired();
  } catch { throw new Error('fresh_session_required'); }
  return {
    async withToken(callback, { signal } = {}) {
      let token;
      try {
        signal?.throwIfAborted();
        await checkDirectory();
        if (JSON.stringify(await readPrivate(markerPath)) !== JSON.stringify(marker)) throw loginRequired();
        token = selectFreshSessionToken(await readPrivate(join(directory, 'auth.json')), now());
      } catch { throw loginRequired(); }
      try { signal?.throwIfAborted(); return await callback(token); }
      finally { token = undefined; }
    },
    async status() {
      try { await this.withToken(() => {}); return { connected: true }; }
      catch { return { connected: false }; }
    },
  };
}

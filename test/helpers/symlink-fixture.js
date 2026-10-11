import { symlink } from 'node:fs/promises';

// Directory junctions exercise the real Windows reparse-point guard without
// requiring Developer Mode. File symlinks have no unprivileged equivalent.
export const directoryLinkType = process.platform === 'win32' ? 'junction' : 'dir';

export async function createFileSymlinkFixture(t, target, path) {
  try {
    await symlink(target, path, 'file');
    return true;
  } catch (error) {
    if (process.platform !== 'win32' || error.code !== 'EPERM') throw error;
    t.skip('Windows denied file-symlink creation; this fixture requires symlink privilege or Developer Mode. Security settings were not changed.');
    return false;
  }
}

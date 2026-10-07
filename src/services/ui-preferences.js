import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import * as fs from "node:fs/promises";
import { join } from "node:path";

// The wizard binds a new port on every run, so browser storage starts empty each time. The setup guide
// choice is kept in the SIWC storage root (N8N_OPENAI_OAUTH_HOME or ~/.n8n-openai-oauth) with the sign-ins.
const FILE = "ui-preferences.json";
const MAX_BYTES = 1024;

// Never read through a link or past 1 KB. O_NONBLOCK opens a FIFO at once, so it is refused, not waited on.
export async function readUiPreferences({ storageRoot, fileSystem = fs }) {
  try {
    const handle = await fileSystem.open(join(storageRoot, FILE),
      constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const stat = await handle.stat();
      if (!stat.isFile() || stat.size > MAX_BYTES) return {};
      const buffer = Buffer.alloc(MAX_BYTES);
      const { bytesRead } = await handle.read(buffer, 0, MAX_BYTES, 0);
      const value = JSON.parse(buffer.toString("utf8", 0, bytesRead));
      return value?.guide === "on" || value?.guide === "off" ? { guide: value.guide } : {};
    } finally {
      await handle.close();
    }
  } catch {
    return {};
  }
}

// Written only into a private root this user owns, as the SIWC store requires on POSIX; otherwise skipped.
// The root is created when missing, never its parents. Windows has no such mode bits and writes as before.
export async function writeUiPreferences({ storageRoot, preferences, fileSystem = fs }) {
  try { await fileSystem.mkdir(storageRoot, { mode: 0o700 }); }
  catch (error) { if (error?.code !== "EEXIST") throw error; }
  if (process.platform !== "win32") {
    const root = await fileSystem.lstat(storageRoot);
    if (root.isSymbolicLink() || !root.isDirectory() || root.uid !== process.getuid() || (root.mode & 0o077) !== 0) return;
  }
  const path = join(storageRoot, FILE);
  const temporary = `${path}.${randomUUID()}.tmp`;
  try {
    const handle = await fileSystem.open(temporary, "wx", 0o600);
    try {
      await handle.writeFile(`${JSON.stringify({ guide: preferences.guide })}\n`);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await fileSystem.rename(temporary, path);
  } finally {
    await fileSystem.rm(temporary, { force: true });
  }
}

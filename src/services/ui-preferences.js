import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { join } from "node:path";

// The wizard binds a new port on every run, so browser storage starts empty
// each time. The setup guide choice is kept in the wizard's state directory.
const FILE = "ui-preferences.json";

export async function readUiPreferences({ storageRoot, fileSystem = fs }) {
  const path = join(storageRoot, FILE);
  try {
    const stat = await fileSystem.lstat(path);
    if (!stat.isFile() || stat.size > 1024) return {};
    const value = JSON.parse(await fileSystem.readFile(path, "utf8"));
    return value?.guide === "on" || value?.guide === "off" ? { guide: value.guide } : {};
  } catch {
    return {};
  }
}

export async function writeUiPreferences({ storageRoot, preferences, fileSystem = fs }) {
  await fileSystem.mkdir(storageRoot, { recursive: true, mode: 0o700 });
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

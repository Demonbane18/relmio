import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { readUiPreferences, writeUiPreferences } from "../src/services/ui-preferences.js";

const posix = process.platform !== "win32";
const FILE = "ui-preferences.json";

async function directory(t) {
  const path = await fs.mkdtemp(join(tmpdir(), "relmio-ui-preferences-"));
  t.after(() => fs.rm(path, { recursive: true, force: true }));
  return path;
}

test("the guide preference is never read through a link, from a FIFO or past 1 KB", { skip: !posix, timeout: 10_000 }, async (t) => {
  const storageRoot = await directory(t);
  const file = join(storageRoot, FILE);
  const outside = join(await directory(t), "outside.json");
  await fs.writeFile(outside, JSON.stringify({ guide: "on" }));
  await fs.symlink(outside, file);
  // A check that ran just before the file was swapped for a link saw a small regular file.
  const raced = { ...fs, lstat: async () => ({ isFile: () => true, isSymbolicLink: () => false, size: 16 }) };
  assert.deepEqual(await readUiPreferences({ storageRoot, fileSystem: raced }), {});
  assert.deepEqual(await readUiPreferences({ storageRoot }), {});

  await fs.rm(file);
  await promisify(execFile)("mkfifo", [file]);
  assert.deepEqual(await readUiPreferences({ storageRoot }), {}, "a FIFO is refused without waiting for a writer");

  await fs.rm(file);
  await fs.writeFile(file, `${JSON.stringify({ guide: "on" })}${" ".repeat(1024)}`);
  assert.deepEqual(await readUiPreferences({ storageRoot }), {}, "a file over 1 KB reads as unset");
  await fs.writeFile(file, JSON.stringify({ guide: "on" }));
  assert.deepEqual(await readUiPreferences({ storageRoot }), { guide: "on" });
});

test("the guide preference is written only into a private root this user owns, never creating its parents", { skip: !posix }, async (t) => {
  const parent = await directory(t);
  const write = (storageRoot, fileSystem) => writeUiPreferences({ storageRoot, preferences: { guide: "on" }, fileSystem });
  const written = async (storageRoot) => (await fs.readdir(storageRoot)).includes(FILE);
  const owned = async (name) => {
    const path = join(parent, name);
    await fs.mkdir(path, { mode: 0o700 });
    return path;
  };

  const shared = await owned("shared");
  await fs.chmod(shared, 0o770);
  await write(shared);
  assert.equal(await written(shared), false, "a root the group can use is refused");

  const target = await owned("target");
  await fs.symlink(target, join(parent, "linked"));
  await write(join(parent, "linked"));
  assert.equal(await written(target), false, "a linked root is not followed");

  const foreign = await owned("foreign");
  const otherOwner = { ...fs, lstat: async (path) => Object.assign(await fs.lstat(path), { uid: process.getuid() + 1 }) };
  await write(foreign, otherOwner);
  assert.equal(await written(foreign), false, "a root another user owns is refused");

  await assert.rejects(write(join(parent, "missing", "root")), { code: "ENOENT" });
  assert.equal((await fs.readdir(parent)).includes("missing"), false, "parents are never created");

  const fresh = join(parent, "fresh");
  await write(fresh);
  assert.equal((await fs.lstat(fresh)).mode & 0o077, 0);
  assert.deepEqual(await readUiPreferences({ storageRoot: fresh }), { guide: "on" });
});

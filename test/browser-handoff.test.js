import assert from "node:assert/strict";
import * as nodeFileSystem from "node:fs/promises";
import { mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { createPrivateBrowserHandoff } from "../src/services/browser-handoff.js";

const origin = "http://127.0.0.1:4567";
const ticketId = "i".repeat(43);
const secret = "s".repeat(43);

async function privateTemp(t) {
  const directory = await mkdtemp(join(tmpdir(), "relmio-handoff-test-"));
  t.after(async () => rm(directory, { recursive: true, force: true }));
  return await realpath(directory);
}

test("private browser handoff stores its one-time secret only in an owner-only file", async (t) => {
  const privateRoot = await privateTemp(t);
  const handoff = await createPrivateBrowserHandoff({
    origin,
    route: "/local",
    ticketId,
    secret,
    privateRoot,
    lockDownPath: async () => {},
    randomBytes: () => Buffer.from("0123456789ab", "utf8"),
  });
  const path = fileURLToPath(handoff.launchUrl);
  const directory = dirname(path);
  const contents = await readFile(path, "utf8");

  assert.match(basename(directory), /^relmio-browser-[A-Za-z0-9_-]{6,64}$/u);
  assert.match(basename(path), /^launch-[a-f0-9]{24}\.html$/u);
  assert.equal(path.includes(ticketId), false);
  assert.equal(path.includes(secret), false);
  assert.match(contents, new RegExp(ticketId, "u"));
  assert.match(contents, new RegExp(secret, "u"));
  assert.match(contents, /method="post"/u);
  assert.match(contents, /action="http:\/\/127\.0\.0\.1:4567\/__relmio\/browser\/bootstrap"/u);
  assert.doesNotMatch(contents, /src=|href=|session=/iu);
  if (process.platform !== "win32") {
    assert.equal((await stat(directory)).mode & 0o777, 0o700);
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  }

  assert.equal(await handoff.dispose(), true);
  await assert.rejects(() => stat(path), /ENOENT/u);
  await assert.rejects(() => stat(directory), /ENOENT/u);
});

test("Windows locks the empty file before writing the handoff secret", async (t) => {
  const privateRoot = await privateTemp(t);
  const observed = [];
  const handoff = await createPrivateBrowserHandoff({
    origin,
    route: "/assistant",
    ticketId,
    secret,
    privateRoot,
    platform: "win32",
    getUid: undefined,
    randomBytes: () => Buffer.from("fedcba987654", "utf8"),
    async lockDownPath(path, options) {
      const contents = options.kind === "file"
        ? await readFile(path, "utf8")
        : null;
      observed.push({ path, options, contents });
    },
  });

  const fileLocks = observed.filter(({ options }) => options.kind === "file");
  assert.equal(fileLocks.length >= 2, true);
  assert.equal(fileLocks[0].contents, "");
  assert.equal(fileLocks[0].options.verifyOnly, undefined);
  assert.equal(fileLocks.at(-1).options.verifyOnly, true);
  assert.equal(fileLocks.at(-1).contents.includes(secret), true);
  await handoff.dispose();
});

test("Windows verifies the private parent before creating a handoff child", async (t) => {
  const privateRoot = await privateTemp(t);
  let parentVerified = false;
  const fileSystem = {
    ...nodeFileSystem,
    async mkdtemp(prefix) {
      assert.equal(parentVerified, true);
      return await nodeFileSystem.mkdtemp(prefix);
    },
  };
  const handoff = await createPrivateBrowserHandoff({
    origin,
    route: "/local",
    ticketId,
    secret,
    privateRoot,
    fileSystem,
    platform: "win32",
    getUid: undefined,
    randomBytes: () => Buffer.from("001122334455", "utf8"),
    async lockDownPath(path, options) {
      if (path === privateRoot) {
        assert.equal(options.kind, "directory");
        assert.equal(options.verifyOnly, true);
        parentVerified = true;
      }
    },
  });
  await handoff.dispose();
});

test("exact cleanup preserves a replaced handoff path", async (t) => {
  const privateRoot = await privateTemp(t);
  const handoff = await createPrivateBrowserHandoff({
    origin,
    route: "/",
    ticketId,
    secret,
    privateRoot,
    lockDownPath: async () => {},
    randomBytes: () => Buffer.from("aaaaaaaaaaaa", "utf8"),
  });
  const path = fileURLToPath(handoff.launchUrl);
  const moved = `${path}.moved`;
  await rename(path, moved);
  await writeFile(path, "replacement", { mode: 0o600 });

  assert.equal(await handoff.dispose(), false);
  assert.equal(await readFile(path, "utf8"), "replacement");
  assert.match(await readFile(moved, "utf8"), new RegExp(secret, "u"));
});

test("handoff creation rejects unsafe origins, routes, tokens, and symbolic temp roots", async (t) => {
  const privateRoot = await privateTemp(t);
  for (const options of [
    { origin: "http://localhost:4567", route: "/local", ticketId, secret },
    { origin, route: "/other", ticketId, secret },
    { origin, route: "/local", ticketId: "short", secret },
    { origin, route: "/local", ticketId, secret: "short" },
  ]) {
    await assert.rejects(
      () => createPrivateBrowserHandoff({ ...options, privateRoot }),
      /handoff/iu,
    );
  }
});

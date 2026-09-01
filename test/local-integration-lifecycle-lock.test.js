import assert from "node:assert/strict";
import * as fileSystem from "node:fs/promises";
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  acquireLocalIntegrationLifecycleLock,
  settleLocalIntegrationLifecycleOperation,
} from "../src/services/local-integration-lifecycle-lock.js";

const NOW = 100_000;

async function createFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "relmio-integration-lock-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, lockPath: join(root, ".relmio-integration.lock") };
}

function publication({ pid = 701, startIdentity = "test:dead", token = "11111111-1111-4111-8111-111111111111" } = {}) {
  return {
    schemaVersion: 2,
    pid,
    processStartIdentity: startIdentity,
    token,
    publishedAtMs: 1,
  };
}

async function writeClaim(lockPath, value) {
  await mkdir(lockPath, { mode: 0o700 });
  if (value !== undefined) {
    await writeFile(join(lockPath, ".owner.json"), `${JSON.stringify(value)}\n`, { mode: 0o600 });
  }
}

function identityMap(states) {
  return async (pid) => {
    if (pid === process.pid) return { state: "active", startIdentity: "test:self" };
    return states.get(pid) ?? { state: "ambiguous" };
  };
}

function lockOptions(lockPath, states = new Map()) {
  return {
    fileSystem,
    lockPath,
    now: () => NOW,
    platform: process.platform,
    getProcessIdentity: identityMap(states),
    lockDownPath: async () => {},
  };
}

test("integration locks reclaim dead and PID-reused publications, then release only their exact claim", async (t) => {
  for (const [name, claim, state] of [
    ["dead", publication({ pid: 701 }), { state: "dead" }],
    ["PID reused", publication({ pid: 702, startIdentity: "test:old", token: "22222222-2222-4222-8222-222222222222" }), { state: "active", startIdentity: "test:new" }],
  ]) {
    await t.test(name, async (subtest) => {
      const { lockPath } = await createFixture(subtest);
      await writeClaim(lockPath, claim);
      const release = await acquireLocalIntegrationLifecycleLock(lockOptions(
        lockPath,
        new Map([[claim.pid, state]]),
      ));
      await release();
      await assert.rejects(() => fileSystem.lstat(lockPath), /ENOENT/u);
    });
  }
});

test("integration locks fail closed for active and ambiguous publications", async (t) => {
  for (const [name, state] of [
    ["active", { state: "active", startIdentity: "test:owner" }],
    ["ambiguous", { state: "ambiguous" }],
  ]) {
    await t.test(name, async (subtest) => {
      const { lockPath } = await createFixture(subtest);
      const claim = publication({ pid: 703, startIdentity: "test:owner", token: "33333333-3333-4333-8333-333333333333" });
      await writeClaim(lockPath, claim);
      await assert.rejects(
        () => acquireLocalIntegrationLifecycleLock(lockOptions(lockPath, new Map([[claim.pid, state]]))),
        /Another Relmio process|could not verify/iu,
      );
      assert.deepEqual(JSON.parse(await readFile(join(lockPath, ".owner.json"), "utf8")), claim);
    });
  }
});

test("integration locks give incomplete and malformed publications bounded startup grace", async (t) => {
  for (const [name, contents] of [["missing", undefined], ["malformed", "not-json"]]) {
    await t.test(name, async (subtest) => {
      const { lockPath } = await createFixture(subtest);
      await writeClaim(lockPath, contents === undefined ? undefined : contents);
      if (contents !== undefined) {
        await writeFile(join(lockPath, ".owner.json"), contents, { mode: 0o600 });
      }
      await assert.rejects(
        () => acquireLocalIntegrationLifecycleLock(lockOptions(lockPath)),
        /Another Relmio process/iu,
      );

      const agePath = contents === undefined ? lockPath : join(lockPath, ".owner.json");
      await utimes(agePath, new Date(1), new Date(1));
      const release = await acquireLocalIntegrationLifecycleLock(lockOptions(lockPath));
      await release();
      await assert.rejects(() => fileSystem.lstat(lockPath), /ENOENT/u);
    });
  }
});

test("a stale inspector cannot delete a replacement integration lock", async (t) => {
  const { lockPath } = await createFixture(t);
  const stale = publication({ pid: 704, startIdentity: "test:dead", token: "44444444-4444-4444-8444-444444444444" });
  const replacement = publication({ pid: 705, startIdentity: "test:replacement", token: "55555555-5555-4555-8555-555555555555" });
  await writeClaim(lockPath, stale);
  let replaced = false;
  const racingFileSystem = {
    ...fileSystem,
    async rename(from, to) {
      await fileSystem.rename(from, to);
      if (!replaced && from === lockPath) {
        replaced = true;
        await writeClaim(lockPath, replacement);
      }
    },
  };
  await assert.rejects(
    () => acquireLocalIntegrationLifecycleLock({
      ...lockOptions(lockPath, new Map([
        [stale.pid, { state: "dead" }],
        [replacement.pid, { state: "active", startIdentity: "test:replacement" }],
      ])),
      fileSystem: racingFileSystem,
    }),
    /Another Relmio process|refuses to reclaim/iu,
  );
  assert.deepEqual(JSON.parse(await readFile(join(lockPath, ".owner.json"), "utf8")), replacement);
});

test("a lifecycle release failure stays visible after a completed integration action", async (t) => {
  const { lockPath } = await createFixture(t);
  let failRelease = false;
  const releaseFailingFileSystem = {
    ...fileSystem,
    async rmdir(path) {
      if (failRelease && String(path).includes(".quarantine-")) {
        throw Object.assign(new Error("injected release failure"), { code: "EIO" });
      }
      return fileSystem.rmdir(path);
    },
  };
  const release = await acquireLocalIntegrationLifecycleLock({
    ...lockOptions(lockPath),
    fileSystem: releaseFailingFileSystem,
  });
  failRelease = true;
  await assert.rejects(
    () => settleLocalIntegrationLifecycleOperation({
      completionLabel: "Test integration action",
      operation: async () => ({ completed: true }),
      releaseLock: release,
    }),
    (error) => error?.code === "LOCAL_INTEGRATION_LIFECYCLE_LOCK_RELEASE" &&
      /completed, but Relmio could not release/u.test(error.message),
  );
});

test("a failed Windows owner publication removes its exact claim and permits an immediate retry", async (t) => {
  const { root, lockPath } = await createFixture(t);
  let rejectFirstOwnerAcl = true;
  const lockDownPath = async (_path, options = {}) => {
    if (rejectFirstOwnerAcl && options.kind === "file" && options.verifyOnly !== true) {
      rejectFirstOwnerAcl = false;
      throw new Error("injected owner ACL publication failure");
    }
  };
  const options = {
    ...lockOptions(lockPath),
    lockDownPath,
    platform: "win32",
  };

  await assert.rejects(
    () => acquireLocalIntegrationLifecycleLock(options),
    /could not acquire/iu,
  );
  assert.deepEqual(await fileSystem.readdir(root), []);

  const release = await acquireLocalIntegrationLifecycleLock(options);
  await release();
  assert.deepEqual(await fileSystem.readdir(root), []);
});

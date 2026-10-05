import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fileSystem from "node:fs/promises";
import { mkdtemp, mkdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { getLocalProcessIdentity } from "../src/infrastructure/process-identity.js";

import {
  acquireLocalIntegrationLifecycleLock,
  settleLocalIntegrationLifecycleOperation,
} from "../src/services/local-integration-lifecycle-lock.js";

const NOW = 100_000;
const NAMESPACE = "test:namespace";
const execFileAsync = promisify(execFile);

async function createFixture(t) {
  const root = await mkdtemp(join(tmpdir(), "relmio-integration-lock-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return { root, lockPath: join(root, ".relmio-integration.lock") };
}

function publication({ pid = 701, startIdentity = "test:dead", token = "11111111-1111-4111-8111-111111111111",
  namespaceIdentity = NAMESPACE, acquiredAt } = {}) {
  return {
    schemaVersion: 3,
    pid,
    processStartIdentity: startIdentity,
    processNamespaceIdentity: namespaceIdentity,
    ...(acquiredAt === undefined ? {} : { acquiredAt }),
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
    getPidNamespaceIdentity: async () => NAMESPACE,
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

test("missing owner publications get bounded startup grace only when incomplete recovery is allowed", async (t) => {
  const { lockPath } = await createFixture(t);
  await writeClaim(lockPath);
  await assert.rejects(() => acquireLocalIntegrationLifecycleLock(lockOptions(lockPath)),
    error => error.code === "RELMIO_LOCK_BUSY");
  await utimes(lockPath, new Date(1), new Date(1));
  await assert.rejects(() => acquireLocalIntegrationLifecycleLock({
    ...lockOptions(lockPath), reclaimIncomplete: false,
  }), error => error.code === "RELMIO_LOCK_BUSY");
  assert.deepEqual(await fileSystem.readdir(lockPath), []);
  const release = await acquireLocalIntegrationLifecycleLock(lockOptions(lockPath));
  await release();
  await assert.rejects(() => fileSystem.lstat(lockPath), /ENOENT/u);
});

test("malformed and legacy owner publications fail closed regardless of age", async (t) => {
  const legacy = { ...publication(), schemaVersion: 2 };
  delete legacy.processNamespaceIdentity;
  for (const raw of ["not-json", JSON.stringify(legacy)]) {
    const { lockPath } = await createFixture(t);
    await writeClaim(lockPath);
    const ownerPath = join(lockPath, ".owner.json");
    await writeFile(ownerPath, raw, { mode: 0o600 });
    await utimes(ownerPath, new Date(1), new Date(1));
    await assert.rejects(() => acquireLocalIntegrationLifecycleLock(lockOptions(lockPath)));
    assert.equal(await readFile(ownerPath, "utf8"), raw);
    assert.deepEqual(await fileSystem.readdir(lockPath), [".owner.json"]);
  }
});

test("foreign namespace owners are preserved without probing a dead-looking or reused PID", async (t) => {
  for (const observed of [{ state: "dead" }, { state: "active", startIdentity: "test:reused" }]) {
    const { lockPath } = await createFixture(t);
    const claim = publication({ namespaceIdentity: "test:foreign-namespace" });
    await writeClaim(lockPath, claim);
    let ownerPidProbes = 0;
    await assert.rejects(() => acquireLocalIntegrationLifecycleLock({
      ...lockOptions(lockPath),
      async getProcessIdentity(pid) {
        if (pid === process.pid) return { state: "active", startIdentity: "test:self" };
        ownerPidProbes++;
        return observed;
      },
    }));
    assert.equal(ownerPidProbes, 0);
    assert.deepEqual(JSON.parse(await readFile(join(lockPath, ".owner.json"), "utf8")), claim);
    assert.deepEqual(await fileSystem.readdir(lockPath), [".owner.json"]);
  }
});

test("unavailable or malformed self namespace refuses lock acquisition before publication", async (t) => {
  for (const namespace of [null, undefined, "", "bad\nnamespace", "x".repeat(513)]) {
    const { root, lockPath } = await createFixture(t);
    await assert.rejects(() => acquireLocalIntegrationLifecycleLock({
      ...lockOptions(lockPath), getPidNamespaceIdentity: async () => namespace,
    }));
    assert.deepEqual(await fileSystem.readdir(root), []);
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

test("integration locks forward the injected platform to process identity inspection", async (t) => {
  const { lockPath } = await createFixture(t);
  const inspectedPlatforms = [];
  const namespacePlatforms = [];
  const release = await acquireLocalIntegrationLifecycleLock({
    fileSystem,
    lockPath,
    now: () => NOW,
    platform: "win32",
    lockDownPath: async () => {},
    async getPidNamespaceIdentity(options) {
      namespacePlatforms.push(options.platform);
      return NAMESPACE;
    },
    async getProcessIdentity(pid, options) {
      assert.equal(pid, process.pid);
      inspectedPlatforms.push(options.platform);
      return { state: "active", startIdentity: "test:self" };
    },
  });
  await release();

  assert.deepEqual(inspectedPlatforms, ["win32"]);
  assert.deepEqual(namespacePlatforms, ["win32"]);
});

test("ambiguous lease recovery is opt-in and keeps young, equal-age and backwards-clock claims held", async (t) => {
  const boot = "12345678-1234-1234-1234-123456789abc";
  const leaseMs = 600_000;
  for (const [enabled, clock] of [[false, 700_001], [true, 600_999], [true, 601_000], [true, 999]]) {
    const { lockPath } = await createFixture(t);
    const claim = publication({ namespaceIdentity: `linux:${boot}:pid:4026532001`, acquiredAt: 1000 });
    await writeClaim(lockPath, claim);
    await assert.rejects(() => acquireLocalIntegrationLifecycleLock({
      ...lockOptions(lockPath), getPidNamespaceIdentity: async () => `linux:${boot}:pid:4026532002`,
      leaseMs: enabled ? leaseMs : null, leaseNow: () => clock,
    }));
    assert.deepEqual(JSON.parse(await readFile(join(lockPath, ".owner.json"), "utf8")), claim);
  }
});

test("an expired same-boot foreign lease reclaims atomically without probing the foreign PID", async (t) => {
  const { lockPath } = await createFixture(t);
  const boot = "12345678-1234-1234-1234-123456789abc";
  const claim = publication({ namespaceIdentity: `linux:${boot}:pid:4026532001`, acquiredAt: 1000 });
  await writeClaim(lockPath, claim);
  let foreignPidProbes = 0;
  const release = await acquireLocalIntegrationLifecycleLock({
    ...lockOptions(lockPath), getPidNamespaceIdentity: async () => `linux:${boot}:pid:4026532002`,
    leaseMs: 600_000, leaseNow: () => 601_001,
    async getProcessIdentity(pid) {
      if (pid === process.pid) return { state: "active", startIdentity: "test:self" };
      foreignPidProbes++;
      return { state: "dead" };
    },
  });
  assert.equal(foreignPidProbes, 0);
  assert.equal(JSON.parse(await readFile(join(lockPath, ".owner.json"), "utf8")).pid, process.pid);
  await release();
  await assert.rejects(() => fileSystem.lstat(lockPath), /ENOENT/u);
});

test("an opt-in prior-boot claim is dead despite a reset monotonic clock", async (t) => {
  const { lockPath } = await createFixture(t);
  await writeClaim(lockPath, publication({
    namespaceIdentity: "linux:12345678-1234-1234-1234-123456789abc:pid:4026532001",
    acquiredAt: 9_000_000,
  }));
  const release = await acquireLocalIntegrationLifecycleLock({
    ...lockOptions(lockPath),
    getPidNamespaceIdentity: async () => "linux:87654321-1234-1234-1234-123456789abc:pid:4026532002",
    leaseMs: 600_000, leaseNow: () => 1,
  });
  await release();
  await assert.rejects(() => fileSystem.lstat(lockPath), /ENOENT/u);
});

test("missing lease timestamp or boot proof cannot enable ambiguous age reclamation", async (t) => {
  const boot = "12345678-1234-1234-1234-123456789abc";
  for (const claim of [
    publication({ namespaceIdentity: `linux:${boot}:pid:4026532001` }),
    publication({ namespaceIdentity: "test:foreign-namespace", acquiredAt: 1000 }),
  ]) {
    const { lockPath } = await createFixture(t);
    await writeClaim(lockPath, claim);
    await assert.rejects(() => acquireLocalIntegrationLifecycleLock({
      ...lockOptions(lockPath), getPidNamespaceIdentity: async () => `linux:${boot}:pid:4026532002`,
      leaseMs: 600_000, leaseNow: () => 9_000_000,
    }));
    assert.deepEqual(JSON.parse(await readFile(join(lockPath, ".owner.json"), "utf8")), claim);
  }
});

test("atomic claims publish only a durable complete private owner and expose the original acquisition clock", async (t) => {
  const { lockPath } = await createFixture(t);
  const synchronized = new Set(), protectedFiles = new Set();
  // An ACL belongs to the file, so the hard-linked lock path shares its temp file's protection.
  const inode = async path => { const { dev, ino } = await fileSystem.lstat(path); return `${dev}:${ino}`; };
  let linked = false, parentSynced = false;
  const atomicFileSystem = { ...fileSystem,
    async open(path, flags, ...args) {
      const handle = await fileSystem.open(path, flags, ...args);
      return {
        writeFile: (...values) => handle.writeFile(...values),
        chmod: mode => handle.chmod(mode), stat: () => handle.stat(), close: () => handle.close(),
        async sync() {
          await handle.sync();
          synchronized.add(path);
          if (flags === "r" && linked) parentSynced = true;
        },
      };
    },
    async link(from, to) {
      assert.equal(synchronized.has(from), true);
      assert.equal(protectedFiles.has(await inode(from)), true);
      if (to === lockPath) {
        await assert.rejects(() => fileSystem.lstat(lockPath), /ENOENT/u);
        linked = true;
      }
      return fileSystem.link(from, to);
    },
  };
  const release = await acquireLocalIntegrationLifecycleLock({
    ...lockOptions(lockPath), atomicPublication: true, leaseNow: () => 1234,
    fileSystem: atomicFileSystem,
    lockDownPath: async (path, options = {}) => {
      if (options.verifyOnly) assert.equal(protectedFiles.has(await inode(path)), true);
      else protectedFiles.add(await inode(path));
    },
  });
  try {
    assert.equal((await fileSystem.lstat(lockPath)).isFile(), true);
    assert.equal(JSON.parse(await readFile(lockPath, "utf8")).acquiredAt, 1234);
    assert.equal(release.acquiredAt, 1234);
    assert.equal(Object.getOwnPropertyDescriptor(release, "acquiredAt").writable, false);
    assert.equal(parentSynced, process.platform !== "win32");
  } finally { await release(); }
  await assert.rejects(() => fileSystem.lstat(lockPath), /ENOENT/u);
});

test("Windows publishes without its unsupported directory fsync while POSIX still fails closed", async (t) => {
  // Node opens a Windows directory read-only, so FlushFileBuffers reports EPERM.
  const unsupportedDirectorySync = lockPath => ({ ...fileSystem,
    async open(path, flags, ...args) {
      const handle = await fileSystem.open(path, flags, ...args);
      if (path !== dirname(lockPath)) return handle;
      return { close: () => handle.close(),
        async sync() { throw Object.assign(new Error("EPERM: operation not permitted, fsync"), { code: "EPERM" }); } };
    },
  });
  await t.test("win32", async (subtest) => {
    const { lockPath } = await createFixture(subtest);
    const secured = [];
    const release = await acquireLocalIntegrationLifecycleLock({
      ...lockOptions(lockPath), atomicPublication: true, platform: "win32",
      fileSystem: unsupportedDirectorySync(lockPath),
      lockDownPath: async (path, options = {}) => { if (!options.verifyOnly) secured.push(path); },
    });
    assert.equal((await fileSystem.lstat(lockPath)).isFile(), true);
    assert.equal(secured.some(path => path.startsWith(`${lockPath}.publication-`) &&
      !path.startsWith(`${lockPath}.publication-lock`)), true);
    await release();
    await assert.rejects(() => fileSystem.lstat(lockPath), /ENOENT/u);
  });
  await t.test("POSIX", { skip: process.platform === "win32" && "POSIX owner-mode checks cannot pass on NTFS" }, async (subtest) => {
    const { lockPath } = await createFixture(subtest);
    await assert.rejects(() => acquireLocalIntegrationLifecycleLock({
      ...lockOptions(lockPath), atomicPublication: true, fileSystem: unsupportedDirectorySync(lockPath),
    }), error => error.code === "RELMIO_LOCK_UNAVAILABLE");
    await assert.rejects(() => fileSystem.lstat(lockPath), /ENOENT/u);
  });
});

// Counts identity queries and ACL checks, each a helper round trip on Windows.
function windowsSpawnCounter(lockPath, { ctimeShift = () => 0 } = {}) {
  const counts = { identity: 0, lockVerifies: 0, lockdowns: 0, ownNameVerifies: 0 };
  return {
    counts,
    options: {
      ...lockOptions(lockPath), atomicPublication: true, platform: "win32",
      fileSystem: { ...fileSystem, async lstat(path) {
        const metadata = await fileSystem.lstat(path);
        if (path !== lockPath || !ctimeShift()) return metadata;
        return Object.assign(Object.create(Object.getPrototypeOf(metadata)), metadata,
          { ctimeMs: metadata.ctimeMs + ctimeShift() });
      } },
      async getProcessIdentity(pid) {
        if (pid === process.pid) counts.identity++;
        return { state: "active", startIdentity: "test:self" };
      },
      async lockDownPath(path, options = {}) {
        if (!options.verifyOnly) counts.lockdowns++;
        else if (path === lockPath) counts.lockVerifies++;
        else if (/\.(?:publication|released)-[0-9a-f-]{36}$/u.test(path)) counts.ownNameVerifies++;
      },
    },
  };
}

test("an uncontended Windows owner queries its identity once and does not re-verify its own claim", async (t) => {
  const { lockPath } = await createFixture(t);
  const { counts, options } = windowsSpawnCounter(lockPath);
  const acquisitions = 4;
  for (let index = 0; index < acquisitions; index += 1) {
    const release = await acquireLocalIntegrationLifecycleLock(options);
    await release();
  }
  assert.equal(counts.identity, 1);
  // A remembered inode is verified at most once, after its temp name is unlinked.
  assert.ok(counts.lockVerifies <= acquisitions, `${counts.lockVerifies} lock-path verifications`);
  assert.equal(counts.lockdowns, acquisitions * 3);
  // Temp and detached names are only unlinked after an exact identity match.
  assert.equal(counts.ownNameVerifies, 0);
  await assert.rejects(() => fileSystem.lstat(lockPath), /ENOENT/u);
});

test("a changed Windows change time or replaced inode is verified before use", async (t) => {
  await t.test("change time", async (subtest) => {
    const { lockPath } = await createFixture(subtest);
    let shift = 0;
    const { counts, options } = windowsSpawnCounter(lockPath, { ctimeShift: () => shift });
    const release = await acquireLocalIntegrationLifecycleLock(options);
    const verifiedBefore = counts.lockVerifies;
    shift = 1;
    await release();
    assert.ok(counts.lockVerifies > verifiedBefore);
    await assert.rejects(() => fileSystem.lstat(lockPath), /ENOENT/u);
  });
  await t.test("inode", async (subtest) => {
    const { lockPath } = await createFixture(subtest);
    const { counts, options } = windowsSpawnCounter(lockPath);
    const release = await acquireLocalIntegrationLifecycleLock(options);
    const original = await readFile(lockPath, "utf8");
    await fileSystem.rename(lockPath, `${lockPath}.original`);
    await writeFile(lockPath, original, { mode: 0o600 });
    const verifiedBefore = counts.lockVerifies;
    await assert.rejects(release, /replaced/u);
    assert.ok(counts.lockVerifies > verifiedBefore);
    assert.equal(await readFile(lockPath, "utf8"), original);
  });
});

test("a foreign Windows claim is ACL-verified on every inspection", async (t) => {
  const { lockPath } = await createFixture(t);
  await writeFile(lockPath, JSON.stringify(publication({ pid: 703, startIdentity: "test:live", acquiredAt: 1 })), { mode: 0o600 });
  const { counts, options } = windowsSpawnCounter(lockPath);
  options.getProcessIdentity = async pid => pid === 703
    ? { state: "active", startIdentity: "test:live" } : { state: "active", startIdentity: "test:self" };
  for (let attempt = 0; attempt < 2; attempt += 1) {
    await assert.rejects(() => acquireLocalIntegrationLifecycleLock(options), error => error.code === "RELMIO_LOCK_BUSY");
  }
  assert.equal(counts.lockVerifies, 2);
});

test("a Windows sharing refusal on the claim file is retried and the release completes", async (t) => {
  const { lockPath } = await createFixture(t);
  const { options } = windowsSpawnCounter(lockPath);
  const refusals = { rename: 2, unlink: 1, link: 1 };
  const refused = [];
  options.fileSystem = { ...options.fileSystem };
  for (const method of Object.keys(refusals)) {
    options.fileSystem[method] = async (...args) => {
      if (refusals[method]-- > 0) {
        refused.push(method);
        throw Object.assign(new Error(`${method} sharing violation`), { code: method === "unlink" ? "EPERM" : "EBUSY" });
      }
      return fileSystem[method](...args);
    };
  }
  const release = await acquireLocalIntegrationLifecycleLock(options);
  await release();
  assert.deepEqual(refused.sort(), ["link", "rename", "rename", "unlink"]);
  await assert.rejects(() => fileSystem.lstat(lockPath), /ENOENT/u);
});

test("a Windows ACL check racing a claim replacement retries, but an unchanged unprotected claim fails closed", async (t) => {
  await t.test("replaced during the check", async (subtest) => {
    const { lockPath } = await createFixture(subtest);
    const owner = publication({ pid: 703, startIdentity: "test:live", acquiredAt: 1 });
    await writeFile(lockPath, JSON.stringify(owner), { mode: 0o600 });
    const { options } = windowsSpawnCounter(lockPath);
    options.lockDownPath = async (path, { verifyOnly } = {}) => {
      if (verifyOnly && path === lockPath) {
        await fileSystem.unlink(lockPath);
        throw new Error("Windows could not apply and verify owner-only protection for local Relmio files.");
      }
    };
    await assert.rejects(() => acquireLocalIntegrationLifecycleLock(options), error => error.code === "RELMIO_LOCK_CHANGED");
  });
  await t.test("unchanged", async (subtest) => {
    const { lockPath } = await createFixture(subtest);
    const owner = JSON.stringify(publication({ pid: 703, startIdentity: "test:live", acquiredAt: 1 }));
    await writeFile(lockPath, owner, { mode: 0o600 });
    const { options } = windowsSpawnCounter(lockPath);
    let checks = 0;
    options.lockDownPath = async (path, { verifyOnly } = {}) => {
      if (verifyOnly && path === lockPath) {
        checks++;
        throw new Error("Windows could not apply and verify owner-only protection for local Relmio files.");
      }
    };
    await assert.rejects(() => acquireLocalIntegrationLifecycleLock(options),
      error => /owner-only protection/u.test(error.message) && error.code === undefined);
    assert.equal(checks, 3);
    assert.equal(await readFile(lockPath, "utf8"), owner);
  });
});

test("an interrupted unpublished atomic record never reserves the lock or falls back to a directory", async (t) => {
  const { lockPath } = await createFixture(t);
  let directoryFallback = false;
  await assert.rejects(() => acquireLocalIntegrationLifecycleLock({
    ...lockOptions(lockPath), atomicPublication: true,
    fileSystem: { ...fileSystem,
      async mkdir(path, ...args) {
        if (path === lockPath) directoryFallback = true;
        return fileSystem.mkdir(path, ...args);
      },
      async link(from, to) {
        if (to === lockPath) throw Object.assign(new Error("exclusive publication unavailable"), { code: "EOPNOTSUPP" });
        return fileSystem.link(from, to);
      },
    },
  }), error => error.code === "RELMIO_LOCK_UNAVAILABLE");
  assert.equal(directoryFallback, false);
  await assert.rejects(() => fileSystem.lstat(lockPath), /ENOENT/u);
  const release = await acquireLocalIntegrationLifecycleLock({
    ...lockOptions(lockPath), atomicPublication: true,
  });
  await release();
  await assert.rejects(() => fileSystem.lstat(lockPath), /ENOENT/u);
});

test("atomic publication cannot replace an existing directory or malformed file", async (t) => {
  for (const kind of ["directory", "file"]) {
    const { lockPath } = await createFixture(t);
    if (kind === "directory") await mkdir(lockPath, { mode: 0o700 });
    else await writeFile(lockPath, "broken-owner", { mode: 0o600 });
    await assert.rejects(() => acquireLocalIntegrationLifecycleLock({
      ...lockOptions(lockPath), atomicPublication: true,
    }));
    if (kind === "directory") assert.deepEqual(await fileSystem.readdir(lockPath), []);
    else assert.equal(await readFile(lockPath, "utf8"), "broken-owner");
  }
});

test("an atomic release never removes a replacement owner file", async (t) => {
  const { lockPath } = await createFixture(t);
  const release = await acquireLocalIntegrationLifecycleLock({
    ...lockOptions(lockPath), atomicPublication: true,
  });
  await fileSystem.rename(lockPath, `${lockPath}.original`);
  const replacement = publication({ pid: 705, startIdentity: "test:replacement", acquiredAt: 1000 });
  await writeFile(lockPath, JSON.stringify(replacement), { mode: 0o600 });
  await assert.rejects(release);
  assert.deepEqual(JSON.parse(await readFile(lockPath, "utf8")), replacement);
});

test("an expired foreign atomic claim is reclaimed without an incomplete directory window", async (t) => {
  const { lockPath } = await createFixture(t);
  const boot = "12345678-1234-1234-1234-123456789abc";
  const prior = publication({ namespaceIdentity: `linux:${boot}:pid:4026532001`, acquiredAt: 1000 });
  await writeFile(lockPath, JSON.stringify(prior), { mode: 0o600 });
  const release = await acquireLocalIntegrationLifecycleLock({
    ...lockOptions(lockPath), atomicPublication: true, leaseMs: 600_000, leaseNow: () => 601_001,
    getPidNamespaceIdentity: async () => `linux:${boot}:pid:4026532002`,
  });
  assert.equal((await fileSystem.lstat(lockPath)).isFile(), true);
  assert.equal(JSON.parse(await readFile(lockPath, "utf8")).pid, process.pid);
  await release();
  await assert.rejects(() => fileSystem.lstat(lockPath), /ENOENT/u);
});

test("a process crash immediately after atomic link leaves a complete recoverable owner, not an incomplete claim", async (t) => {
  const { lockPath } = await createFixture(t);
  const probe = `
    import * as fileSystem from 'node:fs/promises';
    const { acquireLocalIntegrationLifecycleLock } = await import(process.argv[1]);
    await acquireLocalIntegrationLifecycleLock({
      fileSystem: { ...fileSystem, async link(from, to) {
        await fileSystem.link(from, to);
        if (to === process.argv[2]) { process.stdout.write('linked'); process.exit(0); }
      } },
      lockPath: process.argv[2], atomicPublication: true,
      getPidNamespaceIdentity: async () => process.argv[3],
    });
  `;
  const { stdout } = await execFileAsync(process.execPath, ["--input-type=module", "-e", probe,
    new URL("../src/services/local-integration-lifecycle-lock.js", import.meta.url).href, lockPath, NAMESPACE,
  ], { cwd: fileURLToPath(new URL("..", import.meta.url)), timeout: 10000 });
  assert.equal(stdout, "linked");
  const claim = JSON.parse(await readFile(lockPath, "utf8"));
  assert.equal(claim.schemaVersion, 3);
  assert.equal(claim.processNamespaceIdentity, NAMESPACE);
  assert.equal(Number.isSafeInteger(claim.acquiredAt), true);
  assert.equal((await fileSystem.lstat(lockPath)).nlink, 2);
  const release = await acquireLocalIntegrationLifecycleLock({
    ...lockOptions(lockPath), atomicPublication: true, getProcessIdentity: getLocalProcessIdentity,
  });
  await release();
  await assert.rejects(() => fileSystem.lstat(lockPath), /ENOENT/u);
});

test("owner release waits through another task's publication guard and leaves the slot usable", async (t) => {
  const { lockPath } = await createFixture(t);
  let guardHeld = false, releaseGuard, collisions = 0;
  const options = {
    ...lockOptions(lockPath), atomicPublication: true,
    async getProcessIdentity(pid) {
      assert.equal(pid, process.pid);
      if (guardHeld) {
        guardHeld = false;
        collisions++;
        await releaseGuard();
      }
      return { state: "active", startIdentity: "test:self" };
    },
  };
  const releaseOwner = await acquireLocalIntegrationLifecycleLock(options);
  releaseGuard = await acquireLocalIntegrationLifecycleLock({
    ...lockOptions(`${lockPath}.publication-lock`), atomicPublication: true,
  });
  guardHeld = true;
  await releaseOwner();
  assert.equal(collisions, 1);
  await assert.rejects(() => fileSystem.lstat(lockPath), /ENOENT/u);
  await assert.rejects(() => fileSystem.lstat(`${lockPath}.publication-lock`), /ENOENT/u);
  const next = await acquireLocalIntegrationLifecycleLock(options);
  await next();
  await assert.rejects(() => fileSystem.lstat(lockPath), /ENOENT/u);
});

test("a settled same-process owner recovers its exact failed-release claim on the next acquisition", async (t) => {
  const { lockPath } = await createFixture(t);
  const options = { ...lockOptions(lockPath), atomicPublication: true, releaseWaitMs: 1 };
  const releaseOwner = await acquireLocalIntegrationLifecycleLock(options);
  const original = JSON.parse(await readFile(lockPath, "utf8"));
  const releaseGuard = await acquireLocalIntegrationLifecycleLock({
    ...lockOptions(`${lockPath}.publication-lock`), atomicPublication: true,
  });
  await assert.rejects(releaseOwner, error => error.code === "RELMIO_LOCK_BUSY");
  assert.deepEqual(JSON.parse(await readFile(lockPath, "utf8")), original);
  await releaseGuard();
  const next = await acquireLocalIntegrationLifecycleLock(options);
  const recovered = JSON.parse(await readFile(lockPath, "utf8"));
  assert.notEqual(recovered.token, original.token);
  assert.equal(recovered.pid, process.pid);
  await next();
  await assert.rejects(() => fileSystem.lstat(lockPath), /ENOENT/u);
});

test("same-process failed-release recovery never removes a successor nonce or inode", async (t) => {
  for (const changed of ["inode", "nonce"]) {
    const { lockPath } = await createFixture(t);
    const options = { ...lockOptions(lockPath), atomicPublication: true, releaseWaitMs: 1 };
    const releaseOwner = await acquireLocalIntegrationLifecycleLock(options);
    const releaseGuard = await acquireLocalIntegrationLifecycleLock({
      ...lockOptions(`${lockPath}.publication-lock`), atomicPublication: true,
    });
    await assert.rejects(releaseOwner, error => error.code === "RELMIO_LOCK_BUSY");
    await releaseGuard();
    const original = JSON.parse(await readFile(lockPath, "utf8"));
    const successor = changed === "nonce"
      ? { ...original, token: "22222222-2222-4222-8222-222222222222" } : original;
    if (changed === "inode") await fileSystem.rename(lockPath, `${lockPath}.original`);
    await writeFile(lockPath, JSON.stringify(successor), { mode: 0o600 });
    await assert.rejects(() => acquireLocalIntegrationLifecycleLock(options),
      error => error.code === "RELMIO_LOCK_BUSY");
    assert.deepEqual(JSON.parse(await readFile(lockPath, "utf8")), successor);
  }
});

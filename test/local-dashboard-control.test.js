import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import * as fileSystem from "node:fs/promises";
import { mkdtemp, mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import test from "node:test";

import packageManifest from "../package.json" with { type: "json" };

import {
  ensureLocalDashboardBrowserLaunchRoot,
  inspectLocalDashboardControlPlane,
  readLocalDashboardBrowserUrl,
  runLocalDashboardDaemon,
  spawnLocalDashboardDaemon,
  startLocalDashboardControlPlane,
  stopLocalDashboardControlPlane,
} from "../src/services/local-dashboard-control.js";

const TOKEN = "A".repeat(43);
const BROWSER_TOKEN = `w${"B".repeat(42)}`;
const INSTANCE_ID = "12345678-1234-4123-8123-123456789abc";
const PACKAGE_VERSION = packageManifest.version;
const TEST_CLI_PATH = join(tmpdir(), "relmio-cli.js");
const TEST_ALT_CLI_PATH = join(tmpdir(), "relmio-cli-test.js");
const TEST_ALT_EXEC_PATH = join(
  dirname(process.execPath),
  process.platform === "win32" ? "node-test.exe" : "node-test",
);
const PUBLICATION = Object.freeze({
  schemaVersion: 1,
  kind: "relmio-dashboard-control",
  protocolVersion: 1,
  packageVersion: PACKAGE_VERSION,
  pid: 701,
  processStartIdentity: "test-process-start-701",
  instanceId: INSTANCE_ID,
  origin: "http://127.0.0.1:42731",
  publishedAtMs: 123_456,
});

function stateMarkerName(publication = PUBLICATION) {
  const publicationRaw = `${JSON.stringify(publication)}\n`;
  const digest = (raw) => createHash("sha256").update(raw, "utf8").digest("base64url");
  return `.state-v1-${publication.instanceId}-${[
    publicationRaw,
    TOKEN,
    BROWSER_TOKEN,
  ].map(digest).join("-")}`;
}

function publishingMarkerName(publication = PUBLICATION) {
  return stateMarkerName(publication).replace(/^\.state-v1-/u, ".publishing-v1-");
}

async function fixture(t) {
  const homeDirectory = await realpath(
    await mkdtemp(join(tmpdir(), "relmio-dashboard-control-test-")),
  );
  t.after(() => rm(homeDirectory, { recursive: true, force: true }));
  return {
    homeDirectory,
    env: {},
    relmioHome: join(homeDirectory, ".relmio"),
  };
}

async function writeManagedControl(setup, publication = PUBLICATION) {
  const publicationRaw = `${JSON.stringify(publication)}\n`;
  const stateMarker = stateMarkerName(publication);
  await mkdir(join(setup.relmioHome, "control"), { recursive: true, mode: 0o700 });
  await fileSystem.chmod(setup.relmioHome, 0o700);
  await fileSystem.chmod(join(setup.relmioHome, "control"), 0o700);
  await writeFile(
    join(setup.relmioHome, ".managed-by-relmio-root.json"),
    `${JSON.stringify({ schemaVersion: 1, kind: "relmio-local-root" })}\n`,
    { mode: 0o600 },
  );
  await writeFile(
    join(setup.relmioHome, "control", "dashboard.json"),
    publicationRaw,
    { mode: 0o600 },
  );
  await writeFile(join(setup.relmioHome, "control", "control.key"), TOKEN, { mode: 0o600 });
  await writeFile(join(setup.relmioHome, "control", "browser.key"), BROWSER_TOKEN, { mode: 0o600 });
  await mkdir(join(setup.relmioHome, "control", stateMarker), { mode: 0o700 });
}

function healthyResponse(publication = PUBLICATION) {
  return {
    ok: true,
    status: 200,
    async json() {
      return {
        kind: "relmio-dashboard-control",
        protocolVersion: 1,
        packageVersion: publication.packageVersion,
        instanceId: publication.instanceId,
        pid: publication.pid,
        origin: publication.origin,
      };
    },
  };
}

test("control-plane inspection reports a missing managed root as absent without creating it", async (t) => {
  const setup = await fixture(t);

  assert.deepEqual(
    await inspectLocalDashboardControlPlane({
      ...setup,
      fileSystem,
      lockDownPath: async () => {},
    }),
    { state: "absent" },
  );
  await assert.rejects(() => fileSystem.lstat(setup.relmioHome), /ENOENT/u);
});

test("browser handoff root is created only beneath the verified owner-only Relmio root", async (t) => {
  const setup = await fixture(t);
  const root = await ensureLocalDashboardBrowserLaunchRoot({
    ...setup,
    fileSystem,
    lockDownPath: async () => {},
    getProcessIdentity: async () => ({
      state: "active",
      startIdentity: "test-current-process-start",
    }),
    now: () => 123_456,
  });
  assert.equal(root, join(setup.relmioHome, "browser-launches"));
  if (process.platform !== "win32") {
    assert.equal((await fileSystem.stat(setup.relmioHome)).mode & 0o777, 0o700);
    assert.equal((await fileSystem.stat(root)).mode & 0o777, 0o700);
  }
  const marker = JSON.parse(
    await fileSystem.readFile(join(setup.relmioHome, ".managed-by-relmio-root.json"), "utf8"),
  );
  assert.deepEqual(marker, { schemaVersion: 1, kind: "relmio-local-root" });
});

test("inspection distinguishes a healthy daemon, a dead process, PID reuse, and ambiguous identity without exposing keys", async (t) => {
  const cases = [
    {
      name: "healthy",
      identity: { state: "active", startIdentity: PUBLICATION.processStartIdentity },
      fetchImpl: async () => healthyResponse(),
      expectedState: "healthy",
    },
    { name: "dead", identity: { state: "dead" }, expectedState: "dead" },
    {
      name: "PID reuse",
      identity: { state: "active", startIdentity: "different-process-start" },
      expectedState: "pid-reused",
    },
    { name: "ambiguous", identity: { state: "ambiguous" }, expectedState: "ambiguous" },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async (subtest) => {
      const setup = await fixture(subtest);
      await writeManagedControl(setup);
      const result = await inspectLocalDashboardControlPlane({
        ...setup,
        fileSystem,
        lockDownPath: async () => {},
        getProcessIdentity: async () => scenario.identity,
        fetchImpl: scenario.fetchImpl ?? (async () => {
          throw new Error("health must not be probed for a non-active identity");
        }),
      });

      assert.equal(result.state, scenario.expectedState);
      assert.equal(result.pid, PUBLICATION.pid);
      assert.equal(result.origin, PUBLICATION.origin);
      assert.equal(JSON.stringify(result).includes(TOKEN), false);
      assert.equal(JSON.stringify(result).includes(BROWSER_TOKEN), false);
    });
  }
});

test("inspection fails closed for malformed, oversized, non-loopback, unexpected, and unsafe publications", async (t) => {
  const cases = [
    {
      name: "malformed JSON",
      mutate: async (setup) => writeFile(
        join(setup.relmioHome, "control", "dashboard.json"),
        "{",
        { mode: 0o600 },
      ),
    },
    {
      name: "oversized JSON",
      mutate: async (setup) => writeFile(
        join(setup.relmioHome, "control", "dashboard.json"),
        "x".repeat(4 * 1024 + 1),
        { mode: 0o600 },
      ),
    },
    {
      name: "unexpected publication key",
      publication: { ...PUBLICATION, surprise: true },
    },
    {
      name: "missing package version",
      publication: Object.fromEntries(
        Object.entries(PUBLICATION).filter(([name]) => name !== "packageVersion"),
      ),
    },
    {
      name: "invalid package version",
      publication: { ...PUBLICATION, packageVersion: "latest" },
    },
    {
      name: "non-loopback origin",
      publication: { ...PUBLICATION, origin: "http://0.0.0.0:42731" },
    },
    {
      name: "invalid control key",
      mutate: async (setup) => writeFile(
        join(setup.relmioHome, "control", "control.key"),
        "short",
        { mode: 0o600 },
      ),
    },
    {
      name: "swapped role keys",
      mutate: async (setup) => {
        await writeFile(join(setup.relmioHome, "control", "control.key"), BROWSER_TOKEN, { mode: 0o600 });
        await writeFile(join(setup.relmioHome, "control", "browser.key"), TOKEN, { mode: 0o600 });
      },
    },
    {
      name: "unsafe publication permissions",
      skip: process.platform === "win32",
      mutate: async (setup) => fileSystem.chmod(
        join(setup.relmioHome, "control", "dashboard.json"),
        0o644,
      ),
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, { skip: scenario.skip }, async (subtest) => {
      const setup = await fixture(subtest);
      await writeManagedControl(setup, scenario.publication ?? PUBLICATION);
      await scenario.mutate?.(setup);
      await assert.rejects(
        () => inspectLocalDashboardControlPlane({
          ...setup,
          fileSystem,
          lockDownPath: async () => {},
          getProcessIdentity: async () => ({ state: "dead" }),
        }),
        /refuses|invalid|unsafe|oversized/iu,
      );
    });
  }
});

test("inspection rejects symlinked control files", { skip: process.platform === "win32" }, async (t) => {
  const setup = await fixture(t);
  await writeManagedControl(setup);
  const publicationPath = join(setup.relmioHome, "control", "dashboard.json");
  const outside = join(setup.homeDirectory, "outside.json");
  await writeFile(outside, `${JSON.stringify(PUBLICATION)}\n`, { mode: 0o600 });
  await rm(publicationPath);
  await fileSystem.symlink(outside, publicationPath);

  await assert.rejects(
    () => inspectLocalDashboardControlPlane({
      ...setup,
      fileSystem,
      lockDownPath: async () => {},
      getProcessIdentity: async () => ({ state: "dead" }),
    }),
    /unsafe/iu,
  );
});

test("Windows reads verify owner-only ACLs on every managed root, state marker, and control file", async (t) => {
  const setup = await fixture(t);
  await writeManagedControl(setup);
  const calls = [];
  const result = await inspectLocalDashboardControlPlane({
    ...setup,
    fileSystem,
    platform: "win32",
    lockDownPath: async (path, options) => calls.push({ path, options }),
    getProcessIdentity: async () => ({ state: "dead" }),
  });

  assert.equal(result.state, "dead");
  const verifiedPaths = new Set(calls.map(({ path }) => path));
  const stateMarkerPath = [...verifiedPaths].find((path) => basename(path).startsWith(".state-v1-"));
  assert.equal(typeof stateMarkerPath, "string");
  assert.deepEqual(verifiedPaths, new Set([
    setup.relmioHome,
    join(setup.relmioHome, ".managed-by-relmio-root.json"),
    join(setup.relmioHome, "control"),
    stateMarkerPath,
    join(setup.relmioHome, "control", "dashboard.json"),
    join(setup.relmioHome, "control", "control.key"),
    join(setup.relmioHome, "control", "browser.key"),
  ]));
  assert.ok(calls.every(({ options }) => options.verifyOnly === true));
  assert.deepEqual(
    calls.find(({ path }) => path.endsWith(".managed-by-relmio-root.json"))?.options,
    {
      platform: "win32",
      kind: "file",
      verifyOnly: true,
      verifyEffectiveOwnerOnly: true,
    },
  );
  assert.ok(calls.filter(({ path }) => [
    "dashboard.json",
    "control.key",
    "browser.key",
  ].includes(basename(path))).every(({ options }) =>
    options.kind === "file" && options.verifyEffectiveOwnerOnly === undefined
  ));
  assert.ok(calls.filter(({ path }) =>
    !path.endsWith(".managed-by-relmio-root.json")
  ).every(({ options }) => options.verifyEffectiveOwnerOnly === undefined));
});

test("Windows custom storage requires an owner-only parent ACL before any managed write", async (t) => {
  const setup = await fixture(t);
  const calls = [];
  await assert.rejects(
    () => inspectLocalDashboardControlPlane({
      ...setup,
      env: { RELMIO_HOME: setup.relmioHome },
      fileSystem,
      platform: "win32",
      lockDownPath: async (path, options) => {
        calls.push({ path, options });
        throw new Error("custom parent ACL rejected");
      },
    }),
    /custom parent ACL rejected/iu,
  );
  assert.deepEqual(calls, [{
    path: setup.homeDirectory,
    options: { platform: "win32", verifyOnly: true },
  }]);
  await assert.rejects(() => fileSystem.lstat(setup.relmioHome), /ENOENT/u);
});

test("Windows default profile parent is a fingerprinted trust anchor, not a POSIX mode check", async (t) => {
  const setup = await fixture(t);
  const windowsMetadataFileSystem = {
    ...fileSystem,
    async lstat(path) {
      const metadata = await fileSystem.lstat(path);
      if (path !== setup.homeDirectory) return metadata;
      return new Proxy(metadata, {
        get(target, property, receiver) {
          if (property === "mode") return (target.mode & ~0o777) | 0o777;
          return Reflect.get(target, property, receiver);
        },
      });
    },
  };
  const result = await inspectLocalDashboardControlPlane({
    ...setup,
    fileSystem: windowsMetadataFileSystem,
    platform: "win32",
    lockDownPath: async () => {
      throw new Error("default Windows profile parent must not require a private POSIX mode or strict ACL");
    },
  });
  assert.deepEqual(result, { state: "absent" });
});

test("POSIX inspection rejects otherwise-private files owned by another account", {
  skip: process.platform === "win32" || typeof process.getuid !== "function",
}, async (t) => {
  const setup = await fixture(t);
  await writeManagedControl(setup);
  await assert.rejects(
    () => inspectLocalDashboardControlPlane({
      ...setup,
      fileSystem,
      getUid: () => process.getuid() + 1,
      lockDownPath: async () => {},
      getProcessIdentity: async () => ({ state: "dead" }),
    }),
    /unsafe/iu,
  );
});

test("an active PID is healthy only when the authenticated liveness document matches every published identity", async (t) => {
  const setup = await fixture(t);
  await writeManagedControl(setup);
  const calls = [];
  const result = await inspectLocalDashboardControlPlane({
    ...setup,
    fileSystem,
    lockDownPath: async () => {},
    getProcessIdentity: async () => ({ state: "active", startIdentity: PUBLICATION.processStartIdentity }),
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return healthyResponse({ ...PUBLICATION, instanceId: "32345678-1234-4123-8123-123456789abc" });
    },
  });
  assert.equal(result.state, "unresponsive");
  assert.equal(calls[0].url, `${PUBLICATION.origin}/__relmio/control/status`);
  assert.deepEqual(calls[0].options.headers, { "X-Relmio-Control": TOKEN });
});

test("exact authenticated health with another package version is a sanitized mismatch", async (t) => {
  const setup = await fixture(t);
  const priorPublication = { ...PUBLICATION, packageVersion: "0.12.2" };
  await writeManagedControl(setup, priorPublication);
  const result = await inspectLocalDashboardControlPlane({
    ...setup,
    fileSystem,
    lockDownPath: async () => {},
    getProcessIdentity: async () => ({
      state: "active",
      startIdentity: priorPublication.processStartIdentity,
    }),
    fetchImpl: async () => healthyResponse(priorPublication),
  });

  assert.equal(result.state, "version-mismatch");
  assert.equal(result.packageVersion, "0.12.2");
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
  assert.equal(JSON.stringify(result).includes(BROWSER_TOKEN), false);
});

test("the daemon publishes only metadata plus two role-bound private keys and cleans up its exact state", async (t) => {
  const setup = await fixture(t);
  const startedWith = [];
  const messages = [];
  const scheduled = [];
  let serverClosed = 0;
  const controller = await runLocalDashboardDaemon({
    ...setup,
    fileSystem,
    platform: process.platform,
    lockDownPath: async () => {},
    getProcessIdentity: async () => ({
      state: "active",
      startIdentity: "test-current-process-start",
    }),
    randomBytes: () => Buffer.alloc(32, 7),
    randomUUID: () => INSTANCE_ID,
    now: () => PUBLICATION.publishedAtMs,
    sendMessage: (message) => messages.push(message),
    scheduleStop: (callback) => scheduled.push(callback),
    startServer: async (options) => {
      startedWith.push(options);
      return {
        origin: PUBLICATION.origin,
        async close() { serverClosed += 1; },
      };
    },
  });

  assert.deepEqual(messages, [{ type: "ready" }]);
  assert.equal(startedWith.length, 1);
  assert.equal(startedWith[0].controlInstanceId, INSTANCE_ID);
  assert.equal(startedWith[0].sessionToken.length, 43);
  assert.equal(startedWith[0].controlToken.length, 43);
  assert.notEqual(startedWith[0].sessionToken, startedWith[0].controlToken);
  assert.equal(startedWith[0].browserHandoffRoot, join(setup.relmioHome, "browser-launches"));

  const controlRoot = join(setup.relmioHome, "control");
  const publication = JSON.parse(await fileSystem.readFile(join(controlRoot, "dashboard.json"), "utf8"));
  const controlToken = await fileSystem.readFile(join(controlRoot, "control.key"), "utf8");
  const browserToken = await fileSystem.readFile(join(controlRoot, "browser.key"), "utf8");
  assert.deepEqual(publication, {
    ...PUBLICATION,
    pid: process.pid,
    processStartIdentity: "test-current-process-start",
  });
  assert.equal(JSON.stringify(publication).includes(controlToken), false);
  assert.equal(JSON.stringify(publication).includes(browserToken), false);
  assert.equal(controlToken, startedWith[0].controlToken);
  assert.equal(browserToken, startedWith[0].sessionToken);

  if (process.platform !== "win32") {
    for (const path of [setup.relmioHome, controlRoot, join(setup.relmioHome, "control.lock")]) {
      assert.equal((await fileSystem.stat(path)).mode & 0o777, 0o700);
    }
    for (const path of [
      join(setup.relmioHome, ".managed-by-relmio-root.json"),
      join(controlRoot, "dashboard.json"),
      join(controlRoot, "control.key"),
      join(controlRoot, "browser.key"),
    ]) {
      assert.equal((await fileSystem.stat(path)).mode & 0o777, 0o600);
    }
  }

  assert.deepEqual(await startedWith[0].onControlStop(), { stopping: true, instanceId: INSTANCE_ID });
  assert.equal(scheduled.length, 1);
  scheduled[0]();
  await controller.completion;
  assert.equal(serverClosed, 1);
  for (const file of ["dashboard.json", "control.key", "browser.key"]) {
    await assert.rejects(() => fileSystem.lstat(join(controlRoot, file)), /ENOENT/u);
  }
  await assert.rejects(() => fileSystem.lstat(join(setup.relmioHome, "control.lock")), /ENOENT/u);
});

test("signal shutdown keeps the publication and lifetime lock until server close settles", async (t) => {
  const setup = await fixture(t);
  const signalTarget = new EventEmitter();
  let notifyCloseStarted;
  let releaseClose;
  const closeStarted = new Promise((resolve) => {
    notifyCloseStarted = resolve;
  });
  const closeGate = new Promise((resolve) => {
    releaseClose = resolve;
  });
  const controller = await runLocalDashboardDaemon({
    ...setup,
    fileSystem,
    lockDownPath: async () => {},
    getProcessIdentity: async () => ({
      state: "active",
      startIdentity: "test-current-process-start",
    }),
    randomBytes: () => Buffer.alloc(32, 43),
    randomUUID: () => INSTANCE_ID,
    now: () => PUBLICATION.publishedAtMs,
    sendMessage: () => {},
    signalTarget,
    startServer: async () => ({
      origin: PUBLICATION.origin,
      async close() {
        notifyCloseStarted();
        await closeGate;
      },
    }),
  });

  signalTarget.emit("SIGTERM");
  await closeStarted;
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(
    (await fileSystem.lstat(join(setup.relmioHome, "control", "dashboard.json"))).isFile(),
    true,
  );
  assert.equal(
    (await fileSystem.lstat(join(setup.relmioHome, "control.lock"))).isDirectory(),
    true,
  );

  releaseClose();
  await controller.completion;
  await assert.rejects(
    () => fileSystem.lstat(join(setup.relmioHome, "control", "dashboard.json")),
    /ENOENT/u,
  );
  await assert.rejects(
    () => fileSystem.lstat(join(setup.relmioHome, "control.lock")),
    /ENOENT/u,
  );
});

test("daemon cleanup preserves a publication replaced after startup", async (t) => {
  const setup = await fixture(t);
  const controller = await runLocalDashboardDaemon({
    ...setup,
    fileSystem,
    lockDownPath: async () => {},
    getProcessIdentity: async () => ({ state: "active", startIdentity: "test-current-process-start" }),
    randomBytes: () => Buffer.alloc(32, 9),
    randomUUID: () => INSTANCE_ID,
    now: () => PUBLICATION.publishedAtMs,
    sendMessage: () => {},
    startServer: async () => ({ origin: PUBLICATION.origin, close: async () => {} }),
  });
  const publicationPath = join(setup.relmioHome, "control", "dashboard.json");
  const replacement = { ...PUBLICATION, pid: 999, processStartIdentity: "replacement" };
  await writeFile(publicationPath, `${JSON.stringify(replacement)}\n`, { mode: 0o600 });

  await assert.rejects(() => controller.stop(), /changed|replaced|refuses/iu);
  assert.deepEqual(
    JSON.parse(await fileSystem.readFile(publicationPath, "utf8")),
    replacement,
  );
  assert.equal((await fileSystem.lstat(join(setup.relmioHome, "control"))).isDirectory(), true);
});

test("root-protection and each publication-stage failure remain retryable without partial authority", async (t) => {
  for (const failAt of ["root", "control.key", "browser.key", "dashboard.json"]) {
    await t.test(failAt, async (subtest) => {
      const setup = await fixture(subtest);
      let injected = false;
      const lockDownPath = async (path, options = {}) => {
        const matches = failAt === "root"
          ? path === setup.relmioHome && options.verifyOnly !== true
          : path.endsWith(failAt) && options.verifyOnly !== true;
        if (!injected && matches) {
          injected = true;
          throw new Error("injected protection failure");
        }
      };
      const options = {
        ...setup,
        fileSystem,
        lockDownPath,
        getProcessIdentity: async () => ({ state: "active", startIdentity: "test-current-process-start" }),
        randomBytes: () => Buffer.alloc(32, 11),
        randomUUID: () => INSTANCE_ID,
        now: () => PUBLICATION.publishedAtMs,
        sendMessage: () => {},
        startServer: async () => ({ origin: PUBLICATION.origin, close: async () => {} }),
      };

      await assert.rejects(() => runLocalDashboardDaemon(options), /protect|publish/iu);
      const controlRoot = join(setup.relmioHome, "control");
      for (const name of ["dashboard.json", "control.key", "browser.key"]) {
        await assert.rejects(() => fileSystem.lstat(join(controlRoot, name)), /ENOENT/u);
      }
      await assert.rejects(() => fileSystem.lstat(join(setup.relmioHome, "control.staging")), /ENOENT/u);

      const retry = await runLocalDashboardDaemon({ ...options, lockDownPath: async () => {} });
      await retry.stop();
    });
  }
});

test("a private partial canonical state left by a crash is reclaimed only under the lifetime lock", async (t) => {
  const setup = await fixture(t);
  await writeManagedControl(setup);
  const controlRoot = join(setup.relmioHome, "control");
  await fileSystem.rename(
    join(controlRoot, stateMarkerName()),
    join(controlRoot, publishingMarkerName()),
  );
  await rm(join(controlRoot, "browser.key"));

  const controller = await runLocalDashboardDaemon({
    ...setup,
    fileSystem,
    lockDownPath: async () => {},
    getProcessIdentity: async () => ({ state: "active", startIdentity: "test-current-process-start" }),
    randomBytes: () => Buffer.alloc(32, 13),
    randomUUID: () => INSTANCE_ID,
    now: () => PUBLICATION.publishedAtMs,
    sendMessage: () => {},
    startServer: async () => ({ origin: PUBLICATION.origin, close: async () => {} }),
  });

  assert.equal((await fileSystem.lstat(controlRoot)).isDirectory(), true);
  assert.equal((await fileSystem.lstat(join(controlRoot, "browser.key"))).isFile(), true);
  await controller.stop();
});

test("a crash between root staging and marker publication cannot brick first start", async (t) => {
  const setup = await fixture(t);
  await mkdir(join(setup.homeDirectory, ".relmio.bootstrap"), { mode: 0o700 });
  const controller = await runLocalDashboardDaemon({
    ...setup,
    fileSystem,
    lockDownPath: async () => {},
    getProcessIdentity: async () => ({ state: "active", startIdentity: "test-current-process-start" }),
    randomBytes: () => Buffer.alloc(32, 15),
    randomUUID: () => INSTANCE_ID,
    now: () => PUBLICATION.publishedAtMs,
    sendMessage: () => {},
    startServer: async () => ({ origin: PUBLICATION.origin, close: async () => {} }),
  });
  assert.equal((await fileSystem.lstat(setup.relmioHome)).isDirectory(), true);
  assert.deepEqual(
    JSON.parse(await fileSystem.readFile(join(setup.relmioHome, ".managed-by-relmio-root.json"), "utf8")),
    { schemaVersion: 1, kind: "relmio-local-root" },
  );
  await assert.rejects(() => fileSystem.lstat(join(setup.homeDirectory, ".relmio.bootstrap")), /ENOENT/u);
  await controller.stop();
});

test("a root marker interrupted mid-write is retryable only while its bootstrap phase remains", async (t) => {
  const recoverable = await fixture(t);
  await mkdir(join(recoverable.homeDirectory, ".relmio.bootstrap"), { mode: 0o700 });
  await mkdir(recoverable.relmioHome, { mode: 0o700 });
  await writeFile(
    join(recoverable.relmioHome, ".managed-by-relmio-root.json"),
    "{\"schemaVersion\":",
    { mode: 0o600 },
  );
  const controller = await runLocalDashboardDaemon({
    ...recoverable,
    fileSystem,
    lockDownPath: async () => {},
    getProcessIdentity: async () => ({ state: "active", startIdentity: "test-current-process-start" }),
    randomBytes: () => Buffer.alloc(32, 31),
    randomUUID: () => INSTANCE_ID,
    now: () => PUBLICATION.publishedAtMs,
    sendMessage: () => {},
    startServer: async () => ({ origin: PUBLICATION.origin, close: async () => {} }),
  });
  assert.deepEqual(
    JSON.parse(await fileSystem.readFile(
      join(recoverable.relmioHome, ".managed-by-relmio-root.json"),
      "utf8",
    )),
    { schemaVersion: 1, kind: "relmio-local-root" },
  );
  await assert.rejects(
    () => fileSystem.lstat(join(recoverable.homeDirectory, ".relmio.bootstrap")),
    /ENOENT/u,
  );
  await controller.stop();

  const uncommitted = await fixture(t);
  await mkdir(uncommitted.relmioHome, { mode: 0o700 });
  await writeFile(
    join(uncommitted.relmioHome, ".managed-by-relmio-root.json"),
    "{\"schemaVersion\":",
    { mode: 0o600 },
  );
  await assert.rejects(
    () => runLocalDashboardDaemon({
      ...uncommitted,
      fileSystem,
      lockDownPath: async () => {},
      getProcessIdentity: async () => ({ state: "active", startIdentity: "test-current-process-start" }),
      randomBytes: () => Buffer.alloc(32, 32),
      randomUUID: () => INSTANCE_ID,
      now: () => PUBLICATION.publishedAtMs,
      sendMessage: () => {},
      startServer: async () => ({ origin: PUBLICATION.origin, close: async () => {} }),
    }),
    /invalid|managed-root|refuses/iu,
  );
  assert.equal(
    await fileSystem.readFile(
      join(uncommitted.relmioHome, ".managed-by-relmio-root.json"),
      "utf8",
    ),
    "{\"schemaVersion\":",
  );
});

test("an interrupted canonical write is retryable only under its durable publishing phase", async (t) => {
  for (const entry of ["control.key", "browser.key", "dashboard.json"]) {
    await t.test(entry, async (subtest) => {
      const setup = await fixture(subtest);
      await writeManagedControl(setup);
      const controlRoot = join(setup.relmioHome, "control");
      await fileSystem.rename(
        join(controlRoot, stateMarkerName()),
        join(controlRoot, publishingMarkerName()),
      );
      await writeFile(join(controlRoot, entry), "", { mode: 0o600 });

      const controller = await runLocalDashboardDaemon({
        ...setup,
        fileSystem,
        lockDownPath: async () => {},
        getProcessIdentity: async () => ({ state: "active", startIdentity: "test-current-process-start" }),
        randomBytes: () => Buffer.alloc(32, 33),
        randomUUID: () => INSTANCE_ID,
        now: () => PUBLICATION.publishedAtMs,
        sendMessage: () => {},
        startServer: async () => ({ origin: PUBLICATION.origin, close: async () => {} }),
      });
      assert.equal((await fileSystem.lstat(join(controlRoot, entry))).isFile(), true);
      await controller.stop();
    });
  }
});

test("a missing or partial file beneath a committed ready marker is preserved and rejected", async (t) => {
  for (const change of ["missing", "partial"]) {
    await t.test(change, async (subtest) => {
      const setup = await fixture(subtest);
      await writeManagedControl(setup);
      const controlKeyPath = join(setup.relmioHome, "control", "control.key");
      if (change === "missing") await rm(controlKeyPath);
      else await writeFile(controlKeyPath, "partial", { mode: 0o600 });
      await assert.rejects(
        () => startLocalDashboardControlPlane({
          ...setup,
          fileSystem,
          lockDownPath: async () => {},
          getProcessIdentity: async () => ({ state: "dead" }),
          spawnDaemon: async () => { throw new Error("must not spawn over changed ready state"); },
        }),
        /changed|complete|refuses/iu,
      );
      if (change === "partial") {
        assert.equal(await fileSystem.readFile(controlKeyPath, "utf8"), "partial");
      } else {
        await assert.rejects(() => fileSystem.lstat(controlKeyPath), /ENOENT/u);
      }
      assert.equal(
        (await fileSystem.lstat(join(setup.relmioHome, "control", stateMarkerName()))).isDirectory(),
        true,
      );
    });
  }
});

test("the ready marker is committed exclusively only after every final file is exact", async (t) => {
  const setup = await fixture(t);
  const controlRoot = join(setup.relmioHome, "control");
  let readyCommitObserved = false;
  const orderedFileSystem = {
    ...fileSystem,
    async open(path, flags, mode) {
      if (
        flags === "wx" && dirname(path) === controlRoot &&
        ["control.key", "browser.key", "dashboard.json"].includes(basename(path))
      ) {
        const entries = await fileSystem.readdir(controlRoot);
        assert.equal(entries.some((entry) => entry.startsWith(".publishing-v1-")), true);
        assert.equal(entries.some((entry) => entry.startsWith(".state-v1-")), false);
      }
      return fileSystem.open(path, flags, mode);
    },
    async mkdir(path, options) {
      if (dirname(path) === controlRoot && basename(path).startsWith(".state-v1-")) {
        const [, , publicationDigest, controlDigest, browserDigest] =
          /^\.state-v1-([^-]+(?:-[^-]+){4})-([A-Za-z0-9_-]{43})-([A-Za-z0-9_-]{43})-([A-Za-z0-9_-]{43})$/u
            .exec(basename(path)) ?? [];
        assert.equal(typeof publicationDigest, "string");
        for (const [entry, digest] of [
          ["dashboard.json", publicationDigest],
          ["control.key", controlDigest],
          ["browser.key", browserDigest],
        ]) {
          const raw = await fileSystem.readFile(join(controlRoot, entry), "utf8");
          assert.equal(createHash("sha256").update(raw, "utf8").digest("base64url"), digest);
        }
        readyCommitObserved = true;
      }
      return fileSystem.mkdir(path, options);
    },
  };
  const controller = await runLocalDashboardDaemon({
    ...setup,
    fileSystem: orderedFileSystem,
    lockDownPath: async () => {},
    getProcessIdentity: async () => ({ state: "active", startIdentity: "test-current-process-start" }),
    randomBytes: () => Buffer.alloc(32, 34),
    randomUUID: () => INSTANCE_ID,
    now: () => PUBLICATION.publishedAtMs,
    sendMessage: () => {},
    startServer: async () => ({ origin: PUBLICATION.origin, close: async () => {} }),
  });
  assert.equal(readyCommitObserved, true);
  await controller.stop();
});

test("a crash after the exclusive ready commit leaves a healthy recoverable publishing residue", async (t) => {
  const setup = await fixture(t);
  let interrupted = false;
  const crashAfterCommitFileSystem = {
    ...fileSystem,
    async rmdir(path, options) {
      if (!interrupted && basename(path).startsWith(".publishing-v1-")) {
        interrupted = true;
        throw new Error("injected interruption after ready commit");
      }
      return fileSystem.rmdir(path, options);
    },
  };
  const controller = await runLocalDashboardDaemon({
    ...setup,
    fileSystem: crashAfterCommitFileSystem,
    lockDownPath: async () => {},
    getProcessIdentity: async () => ({ state: "active", startIdentity: "test-current-process-start" }),
    fetchImpl: async () => healthyResponse({
      ...PUBLICATION,
      pid: process.pid,
      processStartIdentity: "test-current-process-start",
    }),
    randomBytes: () => Buffer.alloc(32, 36),
    randomUUID: () => INSTANCE_ID,
    now: () => PUBLICATION.publishedAtMs,
    sendMessage: () => {},
    startServer: async () => ({ origin: PUBLICATION.origin, close: async () => {} }),
  });
  const controlRoot = join(setup.relmioHome, "control");
  const entries = await fileSystem.readdir(controlRoot);
  assert.equal(entries.some((entry) => entry.startsWith(".state-v1-")), true);
  assert.equal(entries.some((entry) => entry.startsWith(".publishing-v1-")), true);
  assert.equal((await inspectLocalDashboardControlPlane({
    ...setup,
    fileSystem,
    lockDownPath: async () => {},
    getProcessIdentity: async () => ({ state: "active", startIdentity: "test-current-process-start" }),
    fetchImpl: async () => healthyResponse({
      ...PUBLICATION,
      pid: process.pid,
      processStartIdentity: "test-current-process-start",
    }),
  })).state, "healthy");
  await controller.stop();
});

test("a legacy bootstrap-marker retirement crash is recovered without renaming over a destination", async (t) => {
  const setup = await fixture(t);
  const bootstrapRoot = join(setup.homeDirectory, ".relmio.bootstrap");
  await mkdir(bootstrapRoot, { mode: 0o700 });
  await writeFile(
    join(bootstrapRoot, ".managed-by-relmio-root.json.retired"),
    `${JSON.stringify({ schemaVersion: 1, kind: "relmio-local-root" })}\n`,
    { mode: 0o600 },
  );
  let injected = false;
  const crashingFileSystem = {
    ...fileSystem,
    async rmdir(path, options) {
      if (!injected && path === bootstrapRoot) {
        injected = true;
        throw new Error("injected crash after retired marker removal");
      }
      return fileSystem.rmdir(path, options);
    },
    async rename(from, to) {
      if (from === bootstrapRoot || to === setup.relmioHome) {
        throw new Error("directory rename must not participate in bootstrap recovery");
      }
      return fileSystem.rename(from, to);
    },
  };
  const options = {
    ...setup,
    fileSystem: crashingFileSystem,
    lockDownPath: async () => {},
    getProcessIdentity: async () => ({ state: "active", startIdentity: "test-current-process-start" }),
    randomBytes: () => Buffer.alloc(32, 16),
    randomUUID: () => INSTANCE_ID,
    now: () => PUBLICATION.publishedAtMs,
    sendMessage: () => {},
    startServer: async () => ({ origin: PUBLICATION.origin, close: async () => {} }),
  };

  await assert.rejects(() => runLocalDashboardDaemon(options), /bootstrap recovery/iu);
  assert.deepEqual(await fileSystem.readdir(bootstrapRoot), []);

  const retry = await runLocalDashboardDaemon(options);
  await assert.rejects(() => fileSystem.lstat(bootstrapRoot), /ENOENT/u);
  await retry.stop();
});

test("a durable retiring marker lets a successor finish cleanup after a crash", async (t) => {
  const setup = await fixture(t);
  await writeManagedControl(setup);
  const controlRoot = join(setup.relmioHome, "control");
  const stateMarker = stateMarkerName();
  await mkdir(join(controlRoot, stateMarker, "retiring"), { mode: 0o700 });
  await rm(join(controlRoot, "dashboard.json"));
  const controller = await runLocalDashboardDaemon({
    ...setup,
    fileSystem,
    lockDownPath: async () => {},
    getProcessIdentity: async () => ({ state: "active", startIdentity: "test-current-process-start" }),
    randomBytes: () => Buffer.alloc(32, 17),
    randomUUID: () => INSTANCE_ID,
    now: () => PUBLICATION.publishedAtMs,
    sendMessage: () => {},
    startServer: async () => ({ origin: PUBLICATION.origin, close: async () => {} }),
  });
  assert.equal((await fileSystem.lstat(controlRoot)).isDirectory(), true);
  await assert.rejects(() => fileSystem.lstat(join(controlRoot, stateMarker, "retiring")), /ENOENT/u);
  await controller.stop();
});

test("canonical crash recovery never uses an overwrite-capable directory rename", async (t) => {
  const setup = await fixture(t);
  await writeManagedControl(setup);
  const controlRoot = join(setup.relmioHome, "control");
  await fileSystem.rename(
    join(controlRoot, stateMarkerName()),
    join(controlRoot, publishingMarkerName()),
  );
  await rm(join(controlRoot, "browser.key"));
  const racingFileSystem = {
    ...fileSystem,
    async rename(from, to) {
      if (from === controlRoot || to === controlRoot || to.includes("control.retired")) {
        throw new Error("canonical dashboard control directory must not be renamed");
      }
      return fileSystem.rename(from, to);
    },
  };
  const controller = await runLocalDashboardDaemon({
    ...setup,
    fileSystem: racingFileSystem,
    lockDownPath: async () => {},
    getProcessIdentity: async () => ({ state: "active", startIdentity: "test-current-process-start" }),
    randomBytes: () => Buffer.alloc(32, 19),
    randomUUID: () => INSTANCE_ID,
    now: () => PUBLICATION.publishedAtMs,
    sendMessage: () => {},
    startServer: async () => ({ origin: PUBLICATION.origin, close: async () => {} }),
  });
  assert.equal((await fileSystem.lstat(join(controlRoot, "browser.key"))).isFile(), true);
  await controller.stop();
});

test("a same-account empty destination race blocks publication without overwrite or directory rename", async (t) => {
  const setup = await fixture(t);
  let raced = false;
  const controlRoot = join(setup.relmioHome, "control");
  const racingFileSystem = {
    ...fileSystem,
    async mkdir(path, options) {
      if (!raced && path === controlRoot) {
        raced = true;
        await fileSystem.mkdir(path, options);
        const error = new Error("raced destination already exists");
        error.code = "EEXIST";
        throw error;
      }
      return fileSystem.mkdir(path, options);
    },
    async rename(from, to) {
      return fileSystem.rename(from, to);
    },
  };

  await assert.rejects(
    () => runLocalDashboardDaemon({
      ...setup,
      fileSystem: racingFileSystem,
      lockDownPath: async () => {},
      getProcessIdentity: async () => ({ state: "active", startIdentity: "test-current-process-start" }),
      randomBytes: () => Buffer.alloc(32, 20),
      randomUUID: () => INSTANCE_ID,
      now: () => PUBLICATION.publishedAtMs,
      sendMessage: () => {},
      startServer: async () => ({ origin: PUBLICATION.origin, close: async () => {} }),
    }),
    /existing|replace|publish|destination/iu,
  );
  assert.deepEqual(await fileSystem.readdir(controlRoot), []);
});

test("Windows ancestry replacement after exclusive open never receives dashboard key contents", async (t) => {
  const setup = await fixture(t);
  const originalRoot = `${setup.relmioHome}.original`;
  const controlKeyPath = join(setup.relmioHome, "control", "control.key");
  let replaced = false;
  const racingFileSystem = {
    ...fileSystem,
    async open(path, flags, mode) {
      if (!replaced && path === controlKeyPath) {
        replaced = true;
        await fileSystem.rename(setup.relmioHome, originalRoot);
        await mkdir(join(setup.relmioHome, "control"), { recursive: true, mode: 0o700 });
        await fileSystem.chmod(setup.relmioHome, 0o700);
        await fileSystem.chmod(join(setup.relmioHome, "control"), 0o700);
      }
      return fileSystem.open(path, flags, mode);
    },
  };

  await assert.rejects(
    () => runLocalDashboardDaemon({
      ...setup,
      fileSystem: racingFileSystem,
      platform: "win32",
      lockDownPath: async () => {},
      getProcessIdentity: async () => ({ state: "active", startIdentity: "test-current-process-start" }),
      randomBytes: () => Buffer.alloc(32, 21),
      randomUUID: () => INSTANCE_ID,
      now: () => PUBLICATION.publishedAtMs,
      sendMessage: () => {},
      startServer: async () => ({ origin: PUBLICATION.origin, close: async () => {} }),
    }),
    /changed|ancestor|boundary|unsafe/iu,
  );
  const replacementKey = await fileSystem.readFile(controlKeyPath, "utf8").catch(() => "");
  assert.equal(replacementKey.includes("A".repeat(20)), false);
  assert.equal(replacementKey.length, 0);
});

test("retirement moves the canonical entry first and preserves a raced replacement in its reserved slot", async (t) => {
  const setup = await fixture(t);
  const controlRoot = join(setup.relmioHome, "control");
  const publicationPath = join(controlRoot, "dashboard.json");
  const replacementPublication = `${JSON.stringify({ ...PUBLICATION, pid: 999 })}\n`;
  let armRace = false;
  let raced = false;
  const unlinked = [];
  const crashingFileSystem = {
    ...fileSystem,
    async rename(from, to) {
      if (armRace && !raced && from === publicationPath) {
        raced = true;
        await fileSystem.unlink(from);
        await writeFile(from, replacementPublication, { mode: 0o600 });
      }
      return fileSystem.rename(from, to);
    },
    async unlink(path) {
      unlinked.push(path);
      return fileSystem.unlink(path);
    },
  };
  const controller = await runLocalDashboardDaemon({
    ...setup,
    fileSystem: crashingFileSystem,
    lockDownPath: async () => {},
    getProcessIdentity: async () => ({ state: "active", startIdentity: "test-current-process-start" }),
    randomBytes: () => Buffer.alloc(32, 23),
    randomUUID: () => INSTANCE_ID,
    now: () => PUBLICATION.publishedAtMs,
    sendMessage: () => {},
    startServer: async () => ({ origin: PUBLICATION.origin, close: async () => {} }),
  });
  armRace = true;

  await assert.rejects(
    () => controller.stop(),
    /changed|retiring|remove|moved|refuses/iu,
  );
  const marker = (await fileSystem.readdir(controlRoot)).find((entry) => entry.startsWith(".state-v1-"));
  assert.equal(typeof marker, "string");
  const retiringPath = join(controlRoot, marker, "retiring");
  assert.equal((await fileSystem.lstat(retiringPath)).isDirectory(), true);
  const slots = await fileSystem.readdir(retiringPath);
  assert.equal(slots.length, 1);
  const payloadPath = join(retiringPath, slots[0], "payload");
  assert.equal(await fileSystem.readFile(payloadPath, "utf8"), replacementPublication);
  await assert.rejects(() => fileSystem.lstat(publicationPath), /ENOENT/u);
  assert.equal(unlinked.includes(publicationPath), false);
  assert.equal(unlinked.includes(payloadPath), false);

  await assert.rejects(
    () => startLocalDashboardControlPlane({
      ...setup,
      fileSystem,
      lockDownPath: async () => {},
      getProcessIdentity: async () => ({ state: "dead" }),
      spawnDaemon: async () => { throw new Error("must not spawn over changed state"); },
    }),
    /changed|retiring|refuses/iu,
  );
  assert.equal(await fileSystem.readFile(payloadPath, "utf8"), replacementPublication);
  assert.equal((await fileSystem.lstat(retiringPath)).isDirectory(), true);
});

test("successful and failed cleanup unlink only verified payloads inside reserved retirement slots", async (t) => {
  const setup = await fixture(t);
  const controlRoot = join(setup.relmioHome, "control");
  const canonical = new Set([
    join(controlRoot, "dashboard.json"),
    join(controlRoot, "control.key"),
    join(controlRoot, "browser.key"),
  ]);
  const unlinked = [];
  const retirementFileSystem = {
    ...fileSystem,
    async unlink(path) {
      unlinked.push(path);
      return fileSystem.unlink(path);
    },
  };
  const controller = await runLocalDashboardDaemon({
    ...setup,
    fileSystem: retirementFileSystem,
    lockDownPath: async () => {},
    getProcessIdentity: async () => ({ state: "active", startIdentity: "test-current-process-start" }),
    randomBytes: () => Buffer.alloc(32, 35),
    randomUUID: () => INSTANCE_ID,
    now: () => PUBLICATION.publishedAtMs,
    sendMessage: () => {},
    startServer: async () => ({ origin: PUBLICATION.origin, close: async () => {} }),
  });
  await controller.stop();
  const controlUnlinks = unlinked.filter((path) => path.startsWith(`${controlRoot}/`));
  assert.equal(controlUnlinks.length, 3);
  assert.equal(controlUnlinks.every((path) => basename(path) === "payload"), true);
  assert.equal(controlUnlinks.some((path) => canonical.has(path)), false);
});

test("POSIX refuses a custom Relmio root beneath a non-sticky group-writable parent", {
  skip: process.platform === "win32" || typeof process.getuid !== "function",
}, async (t) => {
  const setup = await fixture(t);
  await fileSystem.chmod(setup.homeDirectory, 0o770);
  await assert.rejects(
    () => inspectLocalDashboardControlPlane({
      ...setup,
      fileSystem,
      lockDownPath: async () => {},
    }),
    /unsafe.*parent/iu,
  );
  await fileSystem.chmod(setup.homeDirectory, 0o700);
});

function fakeChild({ message, exitCode, delayMs = 0 } = {}) {
  const child = new EventEmitter();
  child.connected = true;
  child.disconnectCalls = 0;
  child.unrefCalls = 0;
  child.disconnect = () => {
    child.disconnectCalls += 1;
    child.connected = false;
  };
  child.unref = () => { child.unrefCalls += 1; };
  setTimeout(() => {
    if (message) child.emit("message", message);
    else if (exitCode !== undefined) child.emit("exit", exitCode, null);
  }, delayMs);
  return child;
}

test("daemon spawn uses the current Node executable, fixed private command, IPC only, and an environment allowlist", async () => {
  const calls = [];
  const child = fakeChild({ message: { type: "ready" } });
  const result = await spawnLocalDashboardDaemon({
    execPath: process.execPath,
    cliPath: TEST_CLI_PATH,
    environment: {
      PATH: "/usr/bin",
      HOME: "/Users/example",
      RELMIO_HOME: "/Users/example/.relmio",
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
      TZ: "UTC",
      DOCKER_HOST: "unix:///private/tmp/docker.sock",
      OPENAI_API_KEY: "must-not-survive",
      DATABASE_PASSWORD: "must-not-survive",
      RANDOM_TOKEN: "must-not-survive",
      UNRELATED_TOKEN_SHAPED_VALUE: "A".repeat(43),
    },
    spawnProcess(file, args, options) {
      calls.push({ file, args, options });
      return child;
    },
    startupTimeoutMs: 100,
  });

  assert.deepEqual(result, { state: "ready" });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].file, process.execPath);
  assert.deepEqual(calls[0].args, [TEST_CLI_PATH, "__relmio-dashboard-daemon"]);
  assert.deepEqual(calls[0].options, {
    cwd: dirname(process.execPath),
    detached: true,
    shell: false,
    windowsHide: true,
    stdio: ["ignore", "ignore", "ignore", "ipc"],
    env: {
      PATH: "/usr/bin",
      HOME: "/Users/example",
      RELMIO_HOME: "/Users/example/.relmio",
      LANG: "en_US.UTF-8",
      LC_ALL: "en_US.UTF-8",
      TZ: "UTC",
      DOCKER_HOST: "unix:///private/tmp/docker.sock",
    },
  });
  assert.equal(child.disconnectCalls, 1);
  assert.equal(child.unrefCalls, 1);
});

test("daemon spawn has a bounded readiness handshake and surfaces only fixed child errors", async () => {
  await assert.rejects(
    () => spawnLocalDashboardDaemon({
      execPath: process.execPath,
      cliPath: TEST_CLI_PATH,
      environment: {},
      spawnProcess: () => fakeChild(),
      startupTimeoutMs: 10,
    }),
    /timed out/iu,
  );
  await assert.rejects(
    () => spawnLocalDashboardDaemon({
      execPath: process.execPath,
      cliPath: TEST_CLI_PATH,
      environment: {},
      spawnProcess: () => fakeChild({
        message: { type: "error", message: "Relmio dashboard daemon could not start." },
      }),
      startupTimeoutMs: 100,
    }),
    /^Error: Relmio dashboard daemon could not start\.$/u,
  );
  await assert.rejects(
    () => spawnLocalDashboardDaemon({
      execPath: process.execPath,
      cliPath: TEST_CLI_PATH,
      environment: {},
      spawnProcess: () => fakeChild({ message: { type: "ready", secret: TOKEN } }),
      startupTimeoutMs: 100,
    }),
    /invalid readiness/iu,
  );
  for (const leakedToken of [TOKEN, BROWSER_TOKEN]) {
    assert.throws(
      () => spawnLocalDashboardDaemon({
        execPath: process.execPath,
        cliPath: TEST_CLI_PATH,
        environment: { DOCKER_HOST: leakedToken },
        spawnProcess: () => fakeChild({ message: { type: "ready" } }),
      }),
      /refuses.*key.*environment/iu,
    );
  }
});

test("fire-and-forget control shutdown absorbs its cleanup rejection after completion reports it", async (t) => {
  const setup = await fixture(t);
  let requestStop;
  let scheduledStop;
  const unhandled = [];
  const observeUnhandled = (error) => { unhandled.push(error); };
  process.on("unhandledRejection", observeUnhandled);
  t.after(() => process.off("unhandledRejection", observeUnhandled));

  const controller = await runLocalDashboardDaemon({
    ...setup,
    fileSystem,
    lockDownPath: async () => {},
    getProcessIdentity: async () => ({ state: "active", startIdentity: "test-current-process-start" }),
    randomBytes: () => Buffer.alloc(32, 41),
    randomUUID: () => INSTANCE_ID,
    now: () => PUBLICATION.publishedAtMs,
    sendMessage: () => {},
    scheduleStop: (callback) => { scheduledStop = callback; },
    startServer: async ({ onControlStop }) => {
      requestStop = onControlStop;
      return {
        origin: PUBLICATION.origin,
        close: async () => { throw new Error("fixture cleanup failed"); },
      };
    },
  });

  assert.deepEqual(requestStop(), { stopping: true, instanceId: INSTANCE_ID });
  scheduledStop();
  await assert.rejects(controller.completion, /fixture cleanup failed/u);
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(unhandled, []);
  assert.equal(
    (await fileSystem.lstat(join(setup.relmioHome, "control", "dashboard.json"))).isFile(),
    true,
  );
  assert.equal(
    (await fileSystem.lstat(join(setup.relmioHome, "control.lock"))).isDirectory(),
    true,
  );
});

test("start returns an existing healthy daemon without spawning and keeps both keys out of status", async (t) => {
  const setup = await fixture(t);
  await writeManagedControl(setup);
  let spawned = false;
  const result = await startLocalDashboardControlPlane({
    ...setup,
    fileSystem,
    lockDownPath: async () => {},
    getProcessIdentity: async () => ({ state: "active", startIdentity: PUBLICATION.processStartIdentity }),
    fetchImpl: async () => healthyResponse(),
    spawnDaemon: async () => { spawned = true; },
  });

  assert.deepEqual(result, {
    state: "existing",
    pid: PUBLICATION.pid,
    instanceId: INSTANCE_ID,
    origin: PUBLICATION.origin,
    publishedAtMs: PUBLICATION.publishedAtMs,
    packageVersion: PACKAGE_VERSION,
  });
  assert.equal(spawned, false);
  assert.equal(JSON.stringify(result).includes(TOKEN), false);
  assert.equal(JSON.stringify(result).includes(BROWSER_TOKEN), false);
});

test("start reclaims only a rechecked dead publication, then trusts the protected post-IPC state", async (t) => {
  const setup = await fixture(t);
  await writeManagedControl(setup);
  const replacement = {
    ...PUBLICATION,
    pid: 702,
    processStartIdentity: "new-process-start",
    instanceId: "22345678-1234-4123-8123-123456789abc",
    publishedAtMs: 123_999,
  };
  let spawned = 0;
  const spawnProcess = () => { throw new Error("injected spawn process should be forwarded, not called here"); };
  const result = await startLocalDashboardControlPlane({
    ...setup,
    fileSystem,
    lockDownPath: async () => {},
    getProcessIdentity: async (pid) => {
      if (pid === process.pid) return { state: "active", startIdentity: "caller-process-start" };
      if (pid === PUBLICATION.pid) return { state: "dead" };
      if (pid === replacement.pid) return { state: "active", startIdentity: replacement.processStartIdentity };
      return { state: "ambiguous" };
    },
    fetchImpl: async () => healthyResponse(replacement),
    execPath: TEST_ALT_EXEC_PATH,
    cliPath: TEST_ALT_CLI_PATH,
    spawnProcess,
    startupTimeoutMs: 321,
    spawnDaemon: async (spawnOptions) => {
      spawned += 1;
      assert.deepEqual(spawnOptions, {
        environment: setup.env,
        execPath: TEST_ALT_EXEC_PATH,
        cliPath: TEST_ALT_CLI_PATH,
        spawnProcess,
        startupTimeoutMs: 321,
      });
      await assert.rejects(() => fileSystem.lstat(join(setup.relmioHome, "control")), /ENOENT/u);
      await writeManagedControl(setup, replacement);
      return { state: "ready" };
    },
  });

  assert.equal(spawned, 1);
  assert.deepEqual(result, {
    state: "started",
    pid: replacement.pid,
    instanceId: replacement.instanceId,
    origin: replacement.origin,
    publishedAtMs: replacement.publishedAtMs,
    packageVersion: PACKAGE_VERSION,
  });
});

test("start and browser open refuse a version-mismatched daemon without spawning", async (t) => {
  const setup = await fixture(t);
  const priorPublication = { ...PUBLICATION, packageVersion: "0.12.2" };
  await writeManagedControl(setup, priorPublication);
  let spawned = false;
  const options = {
    ...setup,
    fileSystem,
    lockDownPath: async () => {},
    getProcessIdentity: async () => ({
      state: "active",
      startIdentity: priorPublication.processStartIdentity,
    }),
    fetchImpl: async () => healthyResponse(priorPublication),
  };

  await assert.rejects(
    () => startLocalDashboardControlPlane({
      ...options,
      spawnDaemon: async () => { spawned = true; },
    }),
    /another Relmio version.*relmio stop.*retry/iu,
  );
  await assert.rejects(
    () => readLocalDashboardBrowserUrl(options),
    /not healthy/iu,
  );
  assert.equal(spawned, false);
});

test("start refuses ambiguous and active-but-unresponsive publications", async (t) => {
  for (const scenario of [
    { name: "ambiguous", identity: { state: "ambiguous" }, fetchImpl: async () => healthyResponse() },
    {
      name: "unresponsive",
      identity: { state: "active", startIdentity: PUBLICATION.processStartIdentity },
      fetchImpl: async () => { throw new Error("connection refused"); },
    },
  ]) {
    await t.test(scenario.name, async (subtest) => {
      const setup = await fixture(subtest);
      await writeManagedControl(setup);
      let spawned = false;
      await assert.rejects(
        () => startLocalDashboardControlPlane({
          ...setup,
          fileSystem,
          lockDownPath: async () => {},
          getProcessIdentity: async () => scenario.identity,
          fetchImpl: scenario.fetchImpl,
          spawnDaemon: async () => { spawned = true; },
        }),
        /ambiguous|unresponsive|refuses/iu,
      );
      assert.equal(spawned, false);
    });
  }
});

test("browser launch access rereads the owner-only browser key and prepares a secret-free handoff", async (t) => {
  const setup = await fixture(t);
  await writeManagedControl(setup);
  const launchUrl = "file:///private/tmp/relmio-browser-Ab3dE9/launch-0123456789abcdef01234567.html";
  const calls = [];
  const url = await readLocalDashboardBrowserUrl({
    ...setup,
    fileSystem,
    lockDownPath: async () => {},
    getProcessIdentity: async () => ({ state: "active", startIdentity: PUBLICATION.processStartIdentity }),
    fetchImpl: async (requestUrl, options) => {
      calls.push({ url: requestUrl, options });
      if (requestUrl.endsWith("/status")) return healthyResponse();
      return {
        ok: true,
        status: 201,
        async json() { return { launchUrl }; },
      };
    },
    route: "/assistant",
  });
  assert.equal(url, launchUrl);
  const prepareCall = calls.find(({ url: requestUrl }) => requestUrl.endsWith("/prepare"));
  assert.equal(prepareCall.url, `${PUBLICATION.origin}/__relmio/browser/prepare`);
  assert.equal(prepareCall.options.method, "POST");
  assert.deepEqual(prepareCall.options.headers, {
    "Content-Type": "application/json",
    "Origin": PUBLICATION.origin,
    "X-Setup-Token": BROWSER_TOKEN,
  });
  assert.equal(prepareCall.options.body, JSON.stringify({ route: "/assistant" }));
  assert.equal(JSON.stringify(prepareCall).includes(TOKEN), false);
});

test("stop authenticates with only the private control key and waits for exact state removal", async (t) => {
  const setup = await fixture(t);
  await writeManagedControl(setup);
  const calls = [];
  const result = await stopLocalDashboardControlPlane({
    ...setup,
    fileSystem,
    lockDownPath: async () => {},
    getProcessIdentity: async () => ({ state: "active", startIdentity: PUBLICATION.processStartIdentity }),
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith("/status")) return healthyResponse();
      await rm(join(setup.relmioHome, "control"), { recursive: true });
      return {
        ok: true,
        status: 202,
        async json() { return { stopping: true, instanceId: INSTANCE_ID }; },
      };
    },
    sleep: async () => {},
  });

  assert.deepEqual(result, { state: "stopped" });
  const stopCall = calls.find(({ url }) => url.endsWith("/stop"));
  assert.equal(stopCall.url, `${PUBLICATION.origin}/__relmio/control/stop`);
  assert.equal(stopCall.options.method, "POST");
  assert.deepEqual(stopCall.options.headers, { "X-Relmio-Control": TOKEN });
  assert.equal(JSON.stringify(stopCall.options).includes(BROWSER_TOKEN), false);
  assert.equal(Object.keys(stopCall.options.headers).some((name) => /setup|origin/iu.test(name)), false);
});

test("stop can authenticate and retire a protocol-compatible version mismatch", async (t) => {
  const setup = await fixture(t);
  const priorPublication = { ...PUBLICATION, packageVersion: "0.12.2" };
  await writeManagedControl(setup, priorPublication);
  const calls = [];
  const result = await stopLocalDashboardControlPlane({
    ...setup,
    fileSystem,
    lockDownPath: async () => {},
    getProcessIdentity: async () => ({
      state: "active",
      startIdentity: priorPublication.processStartIdentity,
    }),
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith("/status")) return healthyResponse(priorPublication);
      await rm(join(setup.relmioHome, "control"), { recursive: true });
      return {
        ok: true,
        status: 202,
        async json() { return { stopping: true, instanceId: INSTANCE_ID }; },
      };
    },
    sleep: async () => {},
  });

  assert.deepEqual(result, { state: "stopped" });
  const stopCall = calls.find(({ url }) => url.endsWith("/stop"));
  assert.deepEqual(stopCall.options.headers, { "X-Relmio-Control": TOKEN });
  assert.equal(JSON.stringify(stopCall).includes(BROWSER_TOKEN), false);
});

test("stop follows the exact daemon through its durable retiring state", async (t) => {
  const setup = await fixture(t);
  await writeManagedControl(setup);
  const controlRoot = join(setup.relmioHome, "control");
  const retiringPath = join(controlRoot, stateMarkerName(), "retiring");
  let sleeps = 0;
  const result = await stopLocalDashboardControlPlane({
    ...setup,
    fileSystem,
    lockDownPath: async () => {},
    getProcessIdentity: async () => ({ state: "active", startIdentity: PUBLICATION.processStartIdentity }),
    fetchImpl: async (url) => {
      if (url.endsWith("/status")) return healthyResponse();
      await mkdir(retiringPath, { mode: 0o700 });
      return {
        ok: true,
        status: 202,
        async json() { return { stopping: true, instanceId: INSTANCE_ID }; },
      };
    },
    sleep: async () => {
      sleeps += 1;
      await rm(controlRoot, { recursive: true });
    },
    stopChecks: 2,
    stopPollMs: 0,
  });
  assert.deepEqual(result, { state: "stopped" });
  assert.equal(sleeps, 1);
});

test("stop polling recognizes the exact daemon after nested retirement is removed but before ready cleanup", async (t) => {
  const setup = await fixture(t);
  let gapResolve;
  let releaseGap;
  const gapReached = new Promise((resolveGap) => { gapResolve = resolveGap; });
  const gapRelease = new Promise((resolveRelease) => { releaseGap = resolveRelease; });
  let paused = false;
  const pausingFileSystem = {
    ...fileSystem,
    async rmdir(path, options) {
      const result = await fileSystem.rmdir(path, options);
      if (
        !paused && basename(path) === "retiring" &&
        basename(dirname(path)).startsWith(".state-v1-")
      ) {
        paused = true;
        gapResolve();
        await gapRelease;
      }
      return result;
    },
  };
  const controller = await runLocalDashboardDaemon({
    ...setup,
    fileSystem: pausingFileSystem,
    lockDownPath: async () => {},
    getProcessIdentity: async () => ({ state: "active", startIdentity: "test-current-process-start" }),
    randomBytes: () => Buffer.alloc(32, 37),
    randomUUID: () => INSTANCE_ID,
    now: () => PUBLICATION.publishedAtMs,
    sendMessage: () => {},
    startServer: async () => ({ origin: PUBLICATION.origin, close: async () => {} }),
  });
  let daemonStop;
  const result = await stopLocalDashboardControlPlane({
    ...setup,
    fileSystem: pausingFileSystem,
    lockDownPath: async () => {},
    getProcessIdentity: async () => ({ state: "active", startIdentity: "test-current-process-start" }),
    fetchImpl: async (url) => {
      if (url.endsWith("/status")) {
        return {
          ok: true,
          status: 200,
          async json() {
            return {
              kind: "relmio-dashboard-control",
              protocolVersion: 1,
              packageVersion: controller.publication.packageVersion,
              instanceId: controller.publication.instanceId,
              pid: controller.publication.pid,
              origin: controller.publication.origin,
            };
          },
        };
      }
      daemonStop = controller.stop();
      await gapReached;
      return {
        ok: true,
        status: 202,
        async json() { return { stopping: true, instanceId: INSTANCE_ID }; },
      };
    },
    sleep: async () => {
      releaseGap();
      await daemonStop;
    },
    stopChecks: 2,
    stopPollMs: 0,
  });
  assert.deepEqual(result, { state: "stopped" });
  assert.equal(paused, true);
});

test("stop rejects an otherwise-valid control document returned with HTTP 200", async (t) => {
  const setup = await fixture(t);
  await writeManagedControl(setup);
  await assert.rejects(
    () => stopLocalDashboardControlPlane({
      ...setup,
      fileSystem,
      lockDownPath: async () => {},
      getProcessIdentity: async () => ({ state: "active", startIdentity: PUBLICATION.processStartIdentity }),
      fetchImpl: async (url) => url.endsWith("/status") ? healthyResponse() : {
        ok: true,
        status: 200,
        async json() { return { stopping: true, instanceId: INSTANCE_ID }; },
      },
    }),
    /invalid dashboard stop response/iu,
  );
});

test("stop reports an authenticated busy response without trusting its body", async (t) => {
  const setup = await fixture(t);
  await writeManagedControl(setup);
  let bodyReads = 0;
  await assert.rejects(
    () => stopLocalDashboardControlPlane({
      ...setup,
      fileSystem,
      lockDownPath: async () => {},
      getProcessIdentity: async () => ({ state: "active", startIdentity: PUBLICATION.processStartIdentity }),
      fetchImpl: async (url) => url.endsWith("/status") ? healthyResponse() : {
        ok: false,
        status: 409,
        async json() {
          bodyReads += 1;
          return { error: "untrusted remote detail" };
        },
      },
    }),
    /dashboard is busy; wait for active work to finish, then retry/iu,
  );
  assert.equal(bodyReads, 0);
});

test("stop is idempotent for absent/dead state and fails closed for an unresponsive active process", async (t) => {
  const absentSetup = await fixture(t);
  assert.deepEqual(await stopLocalDashboardControlPlane({
    ...absentSetup,
    fileSystem,
    lockDownPath: async () => {},
  }), { state: "absent" });

  const deadSetup = await fixture(t);
  await writeManagedControl(deadSetup);
  let requested = false;
  assert.deepEqual(await stopLocalDashboardControlPlane({
    ...deadSetup,
    fileSystem,
    lockDownPath: async () => {},
    getProcessIdentity: async (pid) => pid === process.pid
      ? { state: "active", startIdentity: "caller-process-start" }
      : { state: "dead" },
    fetchImpl: async () => { requested = true; throw new Error("must not request a dead process"); },
  }), { state: "stopped" });
  assert.equal(requested, false);
  await assert.rejects(() => fileSystem.lstat(join(deadSetup.relmioHome, "control")), /ENOENT/u);

  const unresponsiveSetup = await fixture(t);
  await writeManagedControl(unresponsiveSetup);
  await assert.rejects(
    () => stopLocalDashboardControlPlane({
      ...unresponsiveSetup,
      fileSystem,
      lockDownPath: async () => {},
      getProcessIdentity: async () => ({ state: "active", startIdentity: PUBLICATION.processStartIdentity }),
      fetchImpl: async () => { throw new Error("connection refused"); },
    }),
    /unresponsive|refuses/iu,
  );
});

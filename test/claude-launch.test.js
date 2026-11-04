import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rename, rm, symlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { readKeyHashFile, runClaudeChat } from "../src/claude/launcher.js";

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

async function fixture(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "relmio-claude-launch-")));
  t.after(async () => {
    try { await chmod(join(directory, "account", "empty"), 0o700); } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await rm(directory, { force: true, recursive: true });
  });
  // Synthetic inert bytes only. No test executes this file or a real Claude binary.
  const binary = Buffer.from("synthetic-native-candidate\n");
  const executable = join(directory, "native-candidate");
  await writeFile(executable, binary, { mode: 0o700 });
  const accountRoot = join(directory, "account");
  const runtime = {
    executable,
    cwd: join(accountRoot, "empty"),
    home: await realpath(homedir()),
    configDir: join(accountRoot, "config"),
    version: "2.1.317",
    models: ["claude-sonnet-5-5", "claude-opus-5-5"],
  };
  const executableSha256 = createHash("sha256").update(binary).digest("hex");
  const clock = { value: Date.parse("2026-11-03T12:00:00.000Z") };
  const config = {
    schemaVersion: 2,
    accountRoot,
    executable,
    executableSha256,
    version: runtime.version,
    models: runtime.models,
    qualification: {
      reviewedBy: "synthetic-test-only",
      reviewedAt: new Date(clock.value - 1000).toISOString(),
      expiresAt: new Date(clock.value + 60_000).toISOString(),
      officialBinaryReviewed: true,
      effectivePolicyReviewed: true,
      nativeAuthAndBillingReviewed: true,
      policyChangesControlled: true,
      runtime: { ...runtime, executableSha256 },
    },
  };
  const configPath = join(directory, "claude-launch.json");
  const save = () => writeFile(configPath, JSON.stringify(config), { mode: 0o600 });
  await save();
  const localBearer = Buffer.alloc(32, 91).toString("base64url");
  const env = {
    RELMIO_CLAUDE_LAUNCH_CONFIG: configPath,
    RELMIO_CLAUDE_CHAT_TOKEN_SHA256: createHash("sha256").update(localBearer).digest("hex"),
    ANTHROPIC_API_KEY: "synthetic-inherited-api-secret",
    ANTHROPIC_BASE_URL: "https://unexpected.invalid",
    NODE_OPTIONS: "--require=synthetic-untrusted-preload",
  };
  const signalTarget = new EventEmitter();
  const logs = [];
  const errors = [];
  const captured = [];
  const startGateway = async (options) => {
    captured.push(options);
    return { origin: "http://127.0.0.1:14502", close: async () => {} };
  };
  const options = {
    env,
    now: () => clock.value,
    signalTarget,
    startGateway,
    log: (line) => logs.push(line),
    logError: (line) => errors.push(line),
  };
  return { directory, executable, accountRoot, runtime, config, configPath, clock, save, env, signalTarget, logs, errors, captured, options };
}

test("launcher uses fixed dedicated paths, verifier only, and keeps account exclusive through cleanup", async (t) => {
  const f = await fixture(t);
  const cleanupStarted = Promise.withResolvers();
  const cleanupAllowed = Promise.withResolvers();
  let closes = 0;
  const app = await runClaudeChat({
    ...f.options,
    startGateway: async (options) => {
      f.captured.push(options);
      return {
        origin: "http://127.0.0.1:14502",
        async close() {
          closes += 1;
          cleanupStarted.resolve();
          await cleanupAllowed.promise;
        },
      };
    },
  });
  t.after(() => { cleanupAllowed.resolve(); return app.close(); });
  assert.deepEqual(f.captured[0].runtime, f.runtime);
  assert.equal(f.captured[0].port, 14502);
  assert.equal(f.captured[0].tokenVerifier.toString("hex"), f.env.RELMIO_CLAUDE_CHAT_TOKEN_SHA256);
  assert.equal(JSON.stringify(f.captured).includes(f.env.ANTHROPIC_API_KEY), false);
  for (const path of [f.accountRoot, f.runtime.configDir]) {
    assert.equal((await lstat(path)).mode & 0o777, 0o700);
  }
  assert.equal((await lstat(f.runtime.cwd)).mode & 0o777, 0o500);
  assert.deepEqual(await readdir(f.runtime.cwd), []);
  const closing = app.close();
  await cleanupStarted.promise;
  await assert.rejects(runClaudeChat(f.options), { code: "account_locked" });
  cleanupAllowed.resolve();
  await closing;
  await app.close();
  assert.equal(closes, 1);
  assert.equal(f.signalTarget.listenerCount("SIGINT"), 0);
  assert.equal(f.signalTarget.listenerCount("SIGTERM"), 0);
  const next = await runClaudeChat(f.options);
  await next.close();
  assert.deepEqual((await readdir(f.accountRoot)).sort(), ["config", "empty"]);
});

test("qualification binds every runtime value and rejects missing, stale, future or incomplete review", async (t) => {
  const f = await fixture(t);
  const original = structuredClone(f.config);
  const changes = [
    (c) => { delete c.qualification; },
    (c) => { c.qualification.expiresAt = new Date(f.clock.value).toISOString(); },
    (c) => { c.qualification.reviewedAt = new Date(f.clock.value + 1).toISOString(); },
    ...["officialBinaryReviewed", "effectivePolicyReviewed", "nativeAuthAndBillingReviewed", "policyChangesControlled"]
      .map((key) => (c) => { c.qualification[key] = false; }),
    ...Object.keys(original.qualification.runtime)
      .map((key) => (c) => { c.qualification.runtime[key] += "-changed"; }),
  ];
  for (const change of changes) {
    Object.assign(f.config, structuredClone(original));
    change(f.config);
    await f.save();
    await assert.rejects(runClaudeChat(f.options));
  }
  assert.equal(f.captured.length, 0);
  await assert.rejects(lstat(f.accountRoot), { code: "ENOENT" });
});

test("qualification may span exactly seven days and not one millisecond more", async (t) => {
  const f = await fixture(t);
  const reviewed = Date.parse(f.config.qualification.reviewedAt);
  f.config.qualification.expiresAt = new Date(reviewed + SEVEN_DAYS_MS + 1).toISOString();
  await f.save();
  await assert.rejects(runClaudeChat(f.options), { code: "runtime_unqualified" });
  assert.equal(f.captured.length, 0);
  await assert.rejects(lstat(f.accountRoot), { code: "ENOENT" });
  f.config.qualification.expiresAt = new Date(reviewed + SEVEN_DAYS_MS).toISOString();
  await f.save();
  const app = await runClaudeChat(f.options);
  assert.equal(f.captured.length, 1);
  await app.close();
});

test("launcher passes companionHost only when it is a lowercase DNS label, never as a bind address", async (t) => {
  const f = await fixture(t);
  for (const companionHost of [
    "", "0.0.0.0", "127.0.0.1", "::1", "Relmio-Claude", "1relmio", "-relmio", "relmio_claude", "relmio.claude",
    "relmio-claude:14502", "relmio claude", "relmio-claude\n", "a".repeat(64), null, 0, false, ["relmio-claude"], {},
  ]) {
    f.config.companionHost = companionHost;
    await f.save();
    await assert.rejects(runClaudeChat(f.options), { code: "launch_config_invalid" }, JSON.stringify(companionHost));
  }
  assert.equal(f.captured.length, 0);
  await assert.rejects(lstat(f.accountRoot), { code: "ENOENT" });
  for (const companionHost of ["relmio-claude", "a", "a".repeat(63), undefined]) {
    if (companionHost === undefined) delete f.config.companionHost; else f.config.companionHost = companionHost;
    await f.save();
    const app = await runClaudeChat(f.options);
    await app.close();
    assert.equal(f.captured.at(-1).companionHost, companionHost);
  }
});

test("launcher rejects invalid, duplicate, empty, oversized and Fable model lists before creating an account", async (t) => {
  const f = await fixture(t);
  for (const models of [
    [], Array.from({ length: 9 }, (_, index) => `claude-model-${index}`),
    ["claude-sonnet-5-5", "claude-sonnet-5-5"],
    ["claude-fable-5-5"], ["claude-sonnet-fable-5"], ["claude-unfabled-5"],
    "claude-sonnet-5-5", null, [null], [4], ["sonnet"], ["claude-sonnet-5-5;id"],
    [`claude-${"a".repeat(122)}`],
  ]) {
    f.config.models = models;
    f.config.qualification.runtime.models = models;
    await f.save();
    await assert.rejects(runClaudeChat(f.options), { code: "launch_config_invalid" });
  }
  assert.equal(f.captured.length, 0);
  await assert.rejects(lstat(f.accountRoot), { code: "ENOENT" });
});

test("launcher rejects schema version 1 and legacy model keys even alongside an approved list", async (t) => {
  const f = await fixture(t);
  f.config.schemaVersion = 1;
  await f.save();
  await assert.rejects(runClaudeChat(f.options), { code: "launch_config_invalid" });
  f.config.schemaVersion = 2;
  f.config.model = f.config.models[0];
  await f.save();
  await assert.rejects(runClaudeChat(f.options), { code: "launch_config_invalid" });
  delete f.config.models;
  await f.save();
  await assert.rejects(runClaudeChat(f.options), { code: "launch_config_invalid" });
  assert.equal(f.captured.length, 0);
  await assert.rejects(lstat(f.accountRoot), { code: "ENOENT" });
});

test("qualification requires the exact approved model list including its order", async (t) => {
  const f = await fixture(t);
  for (const models of [
    [...f.config.models].reverse(), [f.config.models[0]], [...f.config.models, "claude-haiku-5-5"],
    ["claude-sonnet-5-5", "claude-haiku-5-5"], [], null, undefined, f.config.models.join(","),
  ]) {
    f.config.qualification.runtime.models = models;
    await f.save();
    await assert.rejects(runClaudeChat(f.options), { code: "runtime_unqualified" });
  }
  assert.equal(f.captured.length, 0);
  await assert.rejects(lstat(f.accountRoot), { code: "ENOENT" });
});

test("launcher accepts one through eight models and a model id at the length limit", async (t) => {
  const f = await fixture(t);
  for (const models of [
    ["claude-haiku-5-5"],
    [`claude-${"a".repeat(121)}`, ...Array.from({ length: 7 }, (_, index) => `claude-model-${index}`)],
  ]) {
    f.config.models = models;
    f.config.qualification.runtime.models = [...models];
    await f.save();
    const app = await runClaudeChat(f.options);
    t.after(app.close);
    assert.deepEqual(f.captured.at(-1).runtime.models, models);
    await app.close();
  }
});

test("launcher rejects command overrides, unknown configuration, unpinned binary and unsafe files", async (t) => {
  const f = await fixture(t);
  for (const argv of [["--prompt", "secret"], ["--env", "ANTHROPIC_BASE_URL=x"], ["--upstream", "https://unexpected.invalid"]]) {
    await assert.rejects(runClaudeChat({ ...f.options, argv }), { code: "launch_config_invalid" });
  }
  await assert.rejects(runClaudeChat({ ...f.options, env: { ...f.env, RELMIO_CLAUDE_CHAT_TOKEN_SHA256: "not-a-verifier" } }), { code: "launch_config_invalid" });
  f.config.env = { ANTHROPIC_BASE_URL: "https://unexpected.invalid" };
  await f.save();
  await assert.rejects(runClaudeChat(f.options), { code: "launch_config_invalid" });
  delete f.config.env;
  await f.save();
  await writeFile(f.executable, "changed synthetic executable\n", { mode: 0o700 });
  await assert.rejects(runClaudeChat(f.options), { code: "binary_pin_mismatch" });
  const alias = join(f.directory, "binary-alias");
  await symlink(f.executable, alias);
  f.config.executable = alias;
  f.config.qualification.runtime.executable = alias;
  await f.save();
  await assert.rejects(runClaudeChat(f.options), { code: "unsafe_runtime_path" });
  await chmod(f.configPath, 0o644);
  await assert.rejects(runClaudeChat(f.options), { code: "launch_config_invalid" });
  assert.equal(f.captured.length, 0);
});

test("launcher refuses an account root that contains the owner's home before any write", async (t) => {
  const f = await fixture(t);
  const home = await realpath(homedir());
  const accountRoot = join(home, "..");
  f.config.accountRoot = accountRoot;
  Object.assign(f.config.qualification.runtime, { cwd: join(accountRoot, "empty"), configDir: join(accountRoot, "config") });
  await f.save();
  await assert.rejects(runClaudeChat(f.options), { code: "unsafe_runtime_path" });
  assert.equal(f.captured.length, 0);
});

test("launcher refuses an account root inside the installed package or checkout, outside src, before any write", async (t) => {
  const f = await fixture(t);
  const packageRoot = await realpath(fileURLToPath(new URL("..", import.meta.url)));
  const accountRoot = join(packageRoot, `.relmio-claude-account-test-${process.pid}`);
  t.after(() => rm(accountRoot, { force: true, recursive: true }));
  f.config.accountRoot = accountRoot;
  Object.assign(f.config.qualification.runtime, { cwd: join(accountRoot, "empty"), configDir: join(accountRoot, "config") });
  await f.save();
  await assert.rejects(runClaudeChat(f.options), { code: "unsafe_runtime_path" });
  await assert.rejects(lstat(accountRoot), { code: "ENOENT" });
  assert.equal(f.captured.length, 0);
});

test("key-hash file must be a private canonical file holding exactly one lowercase SHA256", async (t) => {
  const f = await fixture(t);
  const hash = f.env.RELMIO_CLAUDE_CHAT_TOKEN_SHA256;
  const path = join(f.directory, "key.sha256");
  await writeFile(path, `${hash}\n`, { mode: 0o600 });
  assert.equal(await readKeyHashFile(path), hash);
  const alias = join(f.directory, "key-alias.sha256");
  await symlink(path, alias);
  await assert.rejects(readKeyHashFile(alias), { code: "launch_config_invalid" });
  await assert.rejects(readKeyHashFile("key.sha256"), { code: "launch_config_invalid" });
  await chmod(path, 0o640);
  await assert.rejects(readKeyHashFile(path), { code: "launch_config_invalid" });
  for (const contents of [hash.toUpperCase(), `${hash}\n\n`, ` ${hash}`, hash.slice(1), "", `${hash}${hash}`]) {
    await rm(path);
    await writeFile(path, contents, { mode: 0o600 });
    await assert.rejects(readKeyHashFile(path), { code: "launch_config_invalid" }, JSON.stringify(contents));
  }
});

test("launcher refuses symlinked native config and nonempty fixed cwd without reading native state", async (t) => {
  const f = await fixture(t);
  await mkdir(f.accountRoot, { mode: 0o700 });
  const unrelated = join(f.directory, "unrelated-config");
  await mkdir(unrelated, { mode: 0o700 });
  const credentialCanary = "synthetic-native-credential-not-for-adapter";
  const nativeState = join(unrelated, "opaque-native-state");
  await writeFile(nativeState, credentialCanary, { mode: 0o600 });
  await symlink(unrelated, f.runtime.configDir);
  await assert.rejects(runClaudeChat(f.options), { code: "unsafe_runtime_path" });
  assert.equal(await readFile(nativeState, "utf8"), credentialCanary);
  assert.equal(f.logs.join("").includes(credentialCanary), false);

  const second = await fixture(t);
  await mkdir(second.accountRoot, { mode: 0o700 });
  await mkdir(second.runtime.cwd, { mode: 0o700 });
  await writeFile(join(second.runtime.cwd, "unexpected-project-file"), "synthetic only");
  await chmod(second.runtime.cwd, 0o500);
  await assert.rejects(runClaudeChat(second.options), { code: "unsafe_runtime_path" });
  assert.equal(f.captured.length + second.captured.length, 0);
  await chmod(second.runtime.cwd, 0o700);
});

test("unconfirmed reap retains exclusive lock and never retries failed cleanup", async (t) => {
  const f = await fixture(t);
  let closes = 0;
  const app = await runClaudeChat({
    ...f.options,
    startGateway: async () => ({
      origin: "http://127.0.0.1:14502",
      close: async () => { closes += 1; throw new Error("synthetic-secret-cleanup-diagnostic"); },
    }),
  });
  await assert.rejects(app.close(), { code: "cleanup_failed" });
  await assert.rejects(app.close(), { code: "cleanup_failed" });
  assert.equal(closes, 1);
  await assert.rejects(runClaudeChat(f.options), { code: "account_locked" });
  assert.equal((await lstat(join(f.accountRoot, ".relmio-claude.lock"))).isFile(), true);
  assert.equal(f.logs.join("").includes("synthetic-secret-cleanup-diagnostic"), false);
});

test("stale-looking lock is preserved and failed listener startup releases only its own claim", async (t) => {
  const stale = await fixture(t);
  await mkdir(stale.accountRoot, { mode: 0o700 });
  const lockPath = join(stale.accountRoot, ".relmio-claude.lock");
  const oldClaim = '{"pid":2147483647,"startedAt":"1970-01-01T00:00:00.000Z"}\n';
  await writeFile(lockPath, oldClaim, { mode: 0o600 });
  await assert.rejects(runClaudeChat(stale.options), { code: "account_locked" });
  assert.equal(await readFile(lockPath, "utf8"), oldClaim);

  const f = await fixture(t);
  await assert.rejects(runClaudeChat({
    ...f.options,
    startGateway: async () => { throw new Error("synthetic-secret-bind-diagnostic"); },
  }), (error) => error.code === "launch_failed" && !error.message.includes("synthetic-secret"));
  const app = await runClaudeChat(f.options);
  await app.close();
});

test("lost account claim blocks spawning and preserves replacement claim on close", async (t) => {
  const f = await fixture(t);
  const app = await runClaudeChat(f.options);
  const lockPath = join(f.accountRoot, ".relmio-claude.lock");
  await rename(lockPath, join(f.accountRoot, ".original-claim"));
  const replacement = "synthetic replacement owner";
  await writeFile(lockPath, replacement, { mode: 0o600 });
  assert.throws(() => f.captured[0].spawnProcess(f.executable, [], {}), { code: "runtime_changed" });
  await assert.rejects(app.close(), { code: "cleanup_failed" });
  assert.equal(await readFile(lockPath, "utf8"), replacement);
});

test("each native launch refuses expired review, binary/config changes and cwd contamination before spawn", async (t) => {
  const mutations = [
    async (f) => { f.clock.value += 60_000; },
    async (f) => { await writeFile(f.executable, "changed synthetic binary\n"); },
    async (f) => { f.config.models = ["claude-haiku-5-5"]; await f.save(); },
    async (f) => {
      await chmod(f.runtime.cwd, 0o700);
      await writeFile(join(f.runtime.cwd, "unexpected"), "synthetic");
      await chmod(f.runtime.cwd, 0o500);
    },
  ];
  for (const mutate of mutations) {
    const f = await fixture(t);
    const app = await runClaudeChat(f.options);
    await mutate(f);
    assert.throws(() => f.captured[0].spawnProcess(f.executable, [], {}),
      (error) => ["runtime_unqualified", "runtime_changed"].includes(error.code));
    await app.close();
    if ((await readdir(f.runtime.cwd)).length) await chmod(f.runtime.cwd, 0o700);
  }
});

test("signal during startup waits for gateway cleanup and releases no lock early", async (t) => {
  const f = await fixture(t);
  const starting = Promise.withResolvers();
  const gatewayReady = Promise.withResolvers();
  let closes = 0;
  const launch = runClaudeChat({
    ...f.options,
    startGateway: async () => {
      starting.resolve();
      return gatewayReady.promise;
    },
  });
  await starting.promise;
  f.signalTarget.emit("SIGTERM");
  await assert.rejects(runClaudeChat(f.options), { code: "account_locked" });
  gatewayReady.resolve({ origin: "http://127.0.0.1:14502", close: async () => { closes += 1; } });
  await assert.rejects(launch, { code: "launch_cancelled" });
  assert.equal(closes, 1);
  assert.deepEqual(f.logs, []);
  const next = await runClaudeChat(f.options);
  await next.close();
});

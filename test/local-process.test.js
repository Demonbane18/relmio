import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

import {
  attestLocalDockerBuilder,
  createLocalDockerEnvironment,
  createWindowsAclHelper,
  lockDownLocalPath,
  recallWindowsLockdown,
  refreshWindowsLockdown,
  rememberWindowsLockdown,
  retryWindowsFileSharing,
  runWindowsAclCommand,
  runLocalProcess,
  verifyWindowsDockerConfigPath,
  validateLocalDockerHost,
} from "../src/infrastructure/local-process.js";

const LOCAL_DOCKER_HOST = "unix:///var/run/docker.sock";
const WINDOWS_DOCKER_HOST = "npipe:////./pipe/dockerDesktopLinuxEngine";
const RUNNER_DOCKER_HOST =
  process.platform === "win32" ? WINDOWS_DOCKER_HOST : LOCAL_DOCKER_HOST;

test("Windows lockdown memory skips only unchanged inodes this process locked down itself", () => {
  const adapter = async () => {};
  const locked = { dev: 7, ino: 11, birthtimeMs: 1000.5, ctimeMs: 2000.25 };
  rememberWindowsLockdown(adapter, locked, "owner-record");
  assert.equal(recallWindowsLockdown(adapter, { ...locked }, "owner-record"), true);
  assert.equal(recallWindowsLockdown(adapter, { ...locked }, Buffer.from("owner-record")), true);
  for (const changed of [{ ctimeMs: 2001 }, { ino: 12 }, { dev: 8 }, { birthtimeMs: 1001 }, { ctimeMs: undefined }]) {
    assert.equal(recallWindowsLockdown(adapter, { ...locked, ...changed }, "owner-record"), false);
  }
  assert.equal(recallWindowsLockdown(adapter, locked, "changed-record"), false);
  assert.equal(recallWindowsLockdown(async () => {}, locked, "owner-record"), false);

  const foreign = { dev: 7, ino: 99, birthtimeMs: 1000, ctimeMs: 2000 };
  refreshWindowsLockdown(adapter, foreign, "foreign-record");
  assert.equal(recallWindowsLockdown(adapter, foreign, "foreign-record"), false);

  const linked = { ...locked, ctimeMs: 3000 };
  refreshWindowsLockdown(adapter, linked, "owner-record");
  assert.equal(recallWindowsLockdown(adapter, linked, "owner-record"), true);
  assert.equal(recallWindowsLockdown(adapter, locked, "owner-record"), false);

  const bounded = async () => {};
  const entry = index => ({ dev: 1, ino: index, birthtimeMs: 1, ctimeMs: 1 });
  for (let index = 0; index <= 256; index += 1) rememberWindowsLockdown(bounded, entry(index), "");
  assert.equal(recallWindowsLockdown(bounded, entry(0), ""), false);
  assert.equal(recallWindowsLockdown(bounded, entry(1), ""), true);
  assert.equal(recallWindowsLockdown(bounded, entry(256), ""), true);
});

test("Windows sharing refusals are retried briefly; other errors and platforms run once", async () => {
  const refusal = code => Object.assign(new Error(code), { code });
  const run = (codes, platform = "win32") => {
    const waits = [];
    let calls = 0;
    const result = retryWindowsFileSharing(async () => {
      const code = codes[calls++];
      if (code) throw refusal(code);
      return "done";
    }, { platform, wait: async milliseconds => { waits.push(milliseconds); } });
    return { result, waits, calls: () => calls };
  };
  const transient = run(["EBUSY", "EPERM", "EACCES"]);
  assert.equal(await transient.result, "done");
  assert.deepEqual(transient.waits, [10, 20, 40]);
  for (const [codes, platform] of [[["ENOENT"], "win32"], [["EBUSY"], "linux"], [["EPERM"], "darwin"]]) {
    const once = run(codes, platform);
    await assert.rejects(once.result, { code: codes[0] });
    assert.equal(once.calls(), 1);
  }
  const persistent = run(Array(20).fill("EPERM"));
  await assert.rejects(persistent.result, { code: "EPERM" });
  assert.equal(persistent.calls(), 8);
  assert.equal(persistent.waits.reduce((sum, value) => sum + value, 0), 1270);
});

function inspectWindowsAcl(path) {
  return new Promise((resolve, reject) => {
    const windowsPowerShell = join(
      process.env.SystemRoot,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    const script = [
      "$utf8=[System.Text.UTF8Encoding]::new($false,$true)",
      "$reader=[System.IO.StreamReader]::new([Console]::OpenStandardInput(),$utf8,$false)",
      "$path=$reader.ReadToEnd()",
      "$sid=[System.Security.Principal.WindowsIdentity]::GetCurrent().User",
      "$item=Get-Item -LiteralPath $path",
      "if($item.PSIsContainer){$acl=[System.IO.DirectoryInfo]::new($path).GetAccessControl()}else{$acl=[System.IO.FileInfo]::new($path).GetAccessControl()}",
      "$owner=$acl.GetOwner([System.Security.Principal.SecurityIdentifier])",
      "$rules=@($acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]))",
      "$result=[ordered]@{accessRulesProtected=[bool]($acl.AreAccessRulesProtected);ownerIsCurrent=[bool]($owner.Value -eq $sid.Value);rules=@($rules|ForEach-Object{[ordered]@{identity=if($_.IdentityReference.Value -eq $sid.Value){'current-user'}else{'other'};accessType=[int]($_.AccessControlType);rights=[int]($_.FileSystemRights);inheritance=[int]($_.InheritanceFlags);propagation=[int]($_.PropagationFlags);inherited=[bool]($_.IsInherited)}})}",
      "$result|ConvertTo-Json -Compress -Depth 4",
    ].join(";");
    const child = spawn(
      windowsPowerShell,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    let stdout = "";
    child.stdout.on("data", (chunk) => { stdout += String(chunk); });
    child.stdin.end(path, "utf8");
    child.once("error", () => reject(new Error("Independent Windows ACL inspection could not start.")));
    child.once("close", (code) => {
      if (code !== 0) {
        reject(new Error("Independent Windows ACL inspection failed."));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error("Independent Windows ACL inspection returned an invalid result."));
      }
    });
  });
}

function assertExactOwnerOnlyAcl(actual, expectedInheritance) {
  const diagnostic = JSON.stringify(actual);
  assert.equal(actual.accessRulesProtected, true, diagnostic);
  assert.equal(actual.ownerIsCurrent, true, diagnostic);
  assert.equal(actual.rules.length, 1);
  assert.deepEqual(actual.rules[0], {
    identity: "current-user",
    accessType: 0,
    rights: 2_032_127,
    inheritance: expectedInheritance,
    propagation: 0,
    inherited: false,
  });
}

function windowsPowerShellPath() {
  return join(
    process.env.SystemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}

function runConsoleCodePageCommand(script) {
  return new Promise((resolve, reject) => {
    const child = spawn(
      windowsPowerShellPath(),
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      { shell: false, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] },
    );
    const chunks = [];
    child.stdout.on("data", (chunk) => chunks.push(chunk));
    child.once("error", () => reject(new Error("Console code page command could not start.")));
    child.once("close", (code) => {
      const text = Buffer.concat(chunks).toString("utf8").replaceAll("\0", "").trim();
      if (code !== 0) reject(new Error("Console code page command failed."));
      else resolve(text);
    });
  });
}

async function useLegacyConsoleCodePage(t) {
  let previous = null;
  try {
    const output = await runConsoleCodePageCommand([
      "try{$before=[Console]::InputEncoding.CodePage}catch{exit 2}",
      "if($before -eq 0){exit 2}",
      "[Console]::InputEncoding=[System.Text.Encoding]::GetEncoding(437)",
      "[Console]::OutputEncoding=[System.Text.Encoding]::GetEncoding(437)",
      "[Console]::Out.Write($before)",
    ].join(";"));
    previous = Number.parseInt(output, 10);
  } catch {
    previous = null;
  }
  if (Number.isInteger(previous)) {
    t.after(() => runConsoleCodePageCommand([
      `[Console]::InputEncoding=[System.Text.Encoding]::GetEncoding(${previous})`,
      `[Console]::OutputEncoding=[System.Text.Encoding]::GetEncoding(${previous})`,
    ].join(";")).catch(() => {}));
  }
}


function createFakeChild(onSpawn = () => {}, { closeOnKill = true } = {}) {
  const child = new EventEmitter();
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.killCalls = [];
  child.closed = false;
  child.kill = (signal) => {
    child.killCalls.push(signal);
    if (closeOnKill && !child.closed) {
      queueMicrotask(() => {
        if (!child.closed) {
          child.closed = true;
          child.emit("close", 143);
        }
      });
    }
    return true;
  };
  queueMicrotask(() => onSpawn(child));
  return child;
}

function closeChild(child, code = 1) {
  if (!child.closed) {
    child.closed = true;
    child.emit("close", code);
  }
}

function createManualTimers() {
  let nextId = 1;
  const scheduled = new Map();
  return {
    setTimer(callback, milliseconds) {
      const id = nextId;
      nextId += 1;
      scheduled.set(id, { callback, milliseconds });
      return id;
    },
    clearTimer(id) {
      scheduled.delete(id);
    },
    fire(milliseconds) {
      const entry = [...scheduled.entries()].find(
        ([, timer]) => timer.milliseconds === milliseconds,
      );
      assert.ok(entry, `Expected a ${milliseconds}ms timer.`);
      const [id, timer] = entry;
      scheduled.delete(id);
      timer.callback();
    },
    get activeCount() {
      return scheduled.size;
    },
    get scheduledMilliseconds() {
      return [...scheduled.values()].map(({ milliseconds }) => milliseconds);
    },
  };
}

async function assertPromisePending(promise) {
  const state = await Promise.race([
    promise.then(
      () => "resolved",
      () => "rejected",
    ),
    new Promise((resolve) => queueMicrotask(() => resolve("pending"))),
  ]);
  assert.equal(state, "pending");
}

test("validateLocalDockerHost accepts local Unix sockets and Docker Desktop's Linux engine pipe", () => {
  assert.equal(
    validateLocalDockerHost(LOCAL_DOCKER_HOST, { platform: "linux" }),
    LOCAL_DOCKER_HOST,
  );
  assert.equal(
    validateLocalDockerHost("unix:///Users/test/.docker/run/docker.sock", {
      platform: "darwin",
    }),
    "unix:///Users/test/.docker/run/docker.sock",
  );

  for (const value of [
    "tcp://127.0.0.1:2375",
    "ssh://docker@example.test",
    "http://127.0.0.1:2375",
    "unix://remote.example.test/var/run/docker.sock",
    "unix:///var/run/docker.sock?context=remote",
    "unix:///var/run/docker.sock#remote",
    "unix:///var/run/%64ocker.sock",
    "unix://",
    "relative/docker.sock",
    "unix:///var/run/docker.sock\n--host=tcp://example.test",
  ]) {
    assert.throws(
      () => validateLocalDockerHost(value, { platform: "linux" }),
      /docker host|unix|unsupported/i,
    );
  }
  assert.equal(
    validateLocalDockerHost(WINDOWS_DOCKER_HOST, { platform: "win32" }),
    WINDOWS_DOCKER_HOST,
  );
  assert.throws(
    () => validateLocalDockerHost(LOCAL_DOCKER_HOST, { platform: "win32" }),
    /Windows.*Docker Desktop.*Linux engine pipe/iu,
  );
  assert.throws(() => validateLocalDockerHost("npipe:////./pipe/docker_engine", { platform: "win32" }));
});

test("local process runner pins Docker to the validated local host and sanitizes its environment", async () => {
  let invocation;
  const result = await runLocalProcess(
    {
      file: "docker",
      args: ["compose", "version", "--short"],
      cwd: "/tmp/relmio-test",
      dockerHost: RUNNER_DOCKER_HOST,
    },
    {
      environment: {
        PATH: "/usr/bin",
        LANG: "C",
        DOCKER_HOST: "tcp://attacker.example.test:2375",
        docker_context: "remote",
        DOCKER_CONFIG: "/tmp/remote-docker-config",
        DOCKER_TLS_VERIFY: "1",
        DOCKER_CERT_PATH: "/tmp/remote-certificates",
        BUILDKIT_HOST: "tcp://attacker.example.test:1234",
        BUILDX_BUILDER: "remote-ci",
        BUILDX_CONFIG: "/tmp/remote-builder-state",
        NGROK_AUTHTOKEN: "stale-shell-token",
        compose_file: "/tmp/unreviewed-compose.yml",
      },
      spawnProcess(file, args, options) {
        invocation = { file, args, options };
        return createFakeChild((child) => {
          child.stdout.end("2.29.0\n");
          child.stderr.end();
          closeChild(child, 0);
        });
      },
    },
  );

  assert.deepEqual(result, { stdout: "2.29.0\n", stderr: "", code: 0 });
  assert.equal(invocation.file, "docker");
  assert.deepEqual(invocation.args, [
    "--host",
    RUNNER_DOCKER_HOST,
    "compose",
    "version",
    "--short",
  ]);
  assert.deepEqual(invocation.options, {
    cwd: "/tmp/relmio-test",
    env: { PATH: "/usr/bin", LANG: "C" },
    shell: false,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
});

test("a model build pins its reviewed default builder despite inherited process selectors", async () => {
  let invocation;
  const cwd = join(tmpdir(), "synthetic-model-home"), config = join(cwd, ".docker");
  await runLocalProcess({
    file: "docker",
    args: ["compose", "--project-name", "reviewed", "build", "--builder", "default", "acquisition"],
    cwd, dockerHost: RUNNER_DOCKER_HOST, attestedDockerConfig: config,
  }, {
    environment: { PATH: "/usr/bin", BUILDX_BUILDER: "remote-ci", BUILDX_CONFIG: "/tmp/remote",
      DOCKER_CONFIG: "/tmp/foreign", DOCKER_BUILDKIT: "0", COMPOSE_BAKE: "true" },
    spawnProcess(file, args, options) {
      invocation = { file, args, options };
      return createFakeChild(child => closeChild(child, 0));
    },
  });
  assert.deepEqual(invocation.args.slice(0, 2), ["--host", RUNNER_DOCKER_HOST]);
  assert.deepEqual(invocation.options.env, { PATH: "/usr/bin", DOCKER_BUILDKIT: "1",
    DOCKER_CONFIG: config, BUILDX_BUILDER: "default", COMPOSE_BAKE: "false" });
  await runLocalProcess({
    file: "docker", args: ["compose", "--profile", "acquisition", "run", "-d", "acquisition"],
    cwd, dockerHost: RUNNER_DOCKER_HOST, attestedDockerConfig: config,
  }, {
    environment: { BUILDX_BUILDER: "remote-ci", BUILDX_CONFIG: "/synthetic/remote" },
    spawnProcess(file, args, options) {
      invocation = { file, args, options };
      return createFakeChild(child => closeChild(child, 0));
    },
  });
  assert.deepEqual(invocation.options.env, { DOCKER_CONFIG: config, BUILDX_BUILDER: "default",
    DOCKER_BUILDKIT: "1", COMPOSE_BAKE: "false" });
  await assert.rejects(() => runLocalProcess({
    file: "docker", args: ["compose", "build", "acquisition"],
    cwd, dockerHost: RUNNER_DOCKER_HOST, attestedDockerConfig: config,
  }, { spawnProcess() { throw new Error("Unexpected build"); } }), /attested default Docker builder/u);
});

test("canonical context-only Buildx selections ignore Key without changing the saved selector", async t => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "relmio-builder-test-")));
  t.after(() => rm(home, { recursive: true, force: true }));
  const directory = join(home, ".docker", "buildx");
  await mkdir(join(directory, "defaults"), { recursive: true });
  await mkdir(join(directory, "instances"));
  const current = join(directory, "current");
  const fallback = join(directory, "defaults",
    createHash("sha256").update(RUNNER_DOCKER_HOST).digest("hex").slice(0, 20));
  const options = { fileSystem: await import("node:fs/promises"), environment: {}, homeDirectory: home,
    verifyDockerAcl: async () => {} };
  assert.equal(await attestLocalDockerBuilder(RUNNER_DOCKER_HOST, options), join(home, ".docker"));
  for (const Key of ["desktop-linux", "", "ssh://unreviewed.example.test"]) {
    for (const Global of [false, true]) {
      const saved = JSON.stringify({ Key, Name: "", Global });
      await writeFile(current, saved);
      assert.equal(await attestLocalDockerBuilder(RUNNER_DOCKER_HOST, options), join(home, ".docker"));
      assert.equal(await readFile(current, "utf8"), saved);
    }
  }
  await writeFile(fallback, "default");
  const saved = JSON.stringify({ Key: "other-context", Name: "", Global: true });
  await writeFile(current, saved);
  assert.equal(await attestLocalDockerBuilder(RUNNER_DOCKER_HOST, options), join(home, ".docker"));
  assert.equal(await readFile(current, "utf8"), saved);
  for (const Global of [false, true]) {
    await writeFile(current, JSON.stringify({ Key: RUNNER_DOCKER_HOST, Name: "default", Global }));
    assert.equal(await attestLocalDockerBuilder(RUNNER_DOCKER_HOST, options), join(home, ".docker"));
    for (const [Key, Name] of [["other-context", "default"], [RUNNER_DOCKER_HOST, "remote-ci"]]) {
      await writeFile(current, JSON.stringify({ Key, Name, Global }));
      await assert.rejects(() => attestLocalDockerBuilder(RUNNER_DOCKER_HOST, options));
    }
  }
});

test("Buildx current requires bounded original canonical bytes and correct JSON types", async t => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "relmio-builder-test-")));
  t.after(() => rm(home, { recursive: true, force: true }));
  const directory = join(home, ".docker", "buildx");
  await mkdir(directory, { recursive: true });
  const current = join(directory, "current");
  const options = { fileSystem: await import("node:fs/promises"), environment: {}, homeDirectory: home,
    verifyDockerAcl: async () => {} };
  const rejected = [
    "{",
    "[]",
    "null",
    JSON.stringify({ Key: "context", Name: "", Global: false, Extra: true }),
    '{"Key":"first","Key":"second","Name":"","Global":false}',
    '{"Name":"","Key":"context","Global":false}',
    '{"Key":"\\u0063ontext","Name":"","Global":false}',
    '{"Key":"context","Name":"","Global":false}\n',
    '{"Key":"context","Name":""}',
    '{"Key":"context","Global":false}',
    '{"Name":"","Global":false}',
    '{"Key":"context","Name":"","Global":"false"}',
    '{"Key":null,"Name":"","Global":false}',
    '{"Key":"context","Name":null,"Global":false}',
    Buffer.concat([Buffer.from('{"Key":"'), Buffer.from([0xff]),
      Buffer.from('","Name":"","Global":false}')]),
  ];
  let rejectionMessage;
  for (const record of rejected) {
    await writeFile(current, record);
    await assert.rejects(() => attestLocalDockerBuilder(RUNNER_DOCKER_HOST, options), error => {
      if (rejectionMessage === undefined) rejectionMessage = error.message;
      assert.equal(error.message, rejectionMessage);
      assert.equal(error.message.includes("context"), false);
      return true;
    });
  }
  const base = Buffer.byteLength(JSON.stringify({ Key: "", Name: "", Global: false }));
  await writeFile(current, JSON.stringify({ Key: "k".repeat(4096 - base), Name: "", Global: false }));
  assert.equal(await attestLocalDockerBuilder(RUNNER_DOCKER_HOST, options), join(home, ".docker"));
  await writeFile(current, JSON.stringify({ Key: "k".repeat(4097 - base), Name: "", Global: false }));
  await assert.rejects(() => attestLocalDockerBuilder(RUNNER_DOCKER_HOST, options));
  await writeFile(current, JSON.stringify({ Key: "context", Name: "", Global: false }));
  const overBoundBytes = Buffer.from(JSON.stringify({
    Key: "k".repeat(4097 - base), Name: "", Global: false,
  }));
  const fileSystem = { ...options.fileSystem, async readFile(location, ...args) {
    return location === current ? overBoundBytes : options.fileSystem.readFile(location, ...args);
  } };
  await assert.rejects(() => attestLocalDockerBuilder(RUNNER_DOCKER_HOST,
    { ...options, fileSystem }));
});

test("an ignored Buildx Key cannot bypass reviewed-host fallback or shadow rejection", async t => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "relmio-builder-test-")));
  t.after(() => rm(home, { recursive: true, force: true }));
  const directory = join(home, ".docker", "buildx");
  await mkdir(join(directory, "defaults"), { recursive: true });
  await mkdir(join(directory, "instances"));
  const current = join(directory, "current");
  const ignoredKey = "ssh://unreviewed.example.test";
  const saved = JSON.stringify({ Key: ignoredKey, Name: "", Global: false });
  await writeFile(current, saved);
  const hash = key => createHash("sha256").update(key).digest("hex").slice(0, 20);
  const fallback = join(directory, "defaults", hash(RUNNER_DOCKER_HOST));
  await writeFile(join(directory, "defaults", hash(ignoredKey)), "default");
  const options = { fileSystem: await import("node:fs/promises"), environment: {}, homeDirectory: home,
    verifyDockerAcl: async () => {} };
  for (const value of ["remote-ci", "", "default\n", "{}"]) {
    await writeFile(fallback, value);
    await assert.rejects(() => attestLocalDockerBuilder(RUNNER_DOCKER_HOST, options));
  }
  await rm(current);
  await assert.rejects(() => attestLocalDockerBuilder(RUNNER_DOCKER_HOST, options));
  await writeFile(current, saved);
  await writeFile(fallback, "default");
  const shadow = join(directory, "instances", "default");
  await writeFile(shadow, "{}");
  await assert.rejects(() => attestLocalDockerBuilder(RUNNER_DOCKER_HOST, options));
  await rm(current);
  await assert.rejects(() => attestLocalDockerBuilder(RUNNER_DOCKER_HOST, options));
  await writeFile(current, saved);
  await rm(shadow);
  if (process.platform !== "win32") {
    await symlink(fallback, shadow);
    await assert.rejects(() => attestLocalDockerBuilder(RUNNER_DOCKER_HOST, options));
    await rm(shadow);
    await rm(fallback);
    await symlink(current, fallback);
    await assert.rejects(() => attestLocalDockerBuilder(RUNNER_DOCKER_HOST, options));
    await rm(fallback);
    await rm(current);
    await symlink(fallback, current);
    await assert.rejects(() => attestLocalDockerBuilder(RUNNER_DOCKER_HOST, options));
    await rm(current);
    await writeFile(current, saved);
  }
  assert.equal(await readFile(current, "utf8"), saved);
  await assert.rejects(() => attestLocalDockerBuilder(RUNNER_DOCKER_HOST,
    { ...options, environment: { [process.platform === "win32" ? "USERPROFILE" : "HOME"]: join(tmpdir(), "different-home") } }));
});

test("an ignored Key does not relax file ownership, links, ancestors, or readable selectors", async t => {
  const home = await realpath(await mkdtemp(join(tmpdir(), "relmio-builder-test-")));
  t.after(() => rm(home, { recursive: true, force: true }));
  const directory = join(home, ".docker", "buildx");
  await mkdir(directory, { recursive: true });
  const current = join(directory, "current");
  await writeFile(current, JSON.stringify({ Key: "other-context", Name: "", Global: true }));
  const original = await import("node:fs/promises");
  const options = { fileSystem: original, environment: {}, homeDirectory: home,
    verifyDockerAcl: async () => {} };
  assert.equal(await attestLocalDockerBuilder(RUNNER_DOCKER_HOST, options), join(home, ".docker"));
  const brokenRead = { ...original, async readFile(location, ...args) {
    if (location === current) throw new Error("other-context must not leak");
    return original.readFile(location, ...args);
  } };
  await assert.rejects(() => attestLocalDockerBuilder(RUNNER_DOCKER_HOST,
    { ...options, fileSystem: brokenRead }), error => {
    assert.equal(error.message.includes("other-context"), false);
    return true;
  });
  if (process.platform !== "win32") {
    for (const [location, properties] of [
      [current, { nlink: 2 }],
      [current, { mode: 0o666 }],
      [current, { uid: process.getuid() + 1 }],
      [home, { mode: 0o777 }],
      [home, { uid: process.getuid() + 1 }],
    ]) {
      const fileSystem = { ...original, async lstat(path) {
        const entry = await original.lstat(path);
        return path === location ? Object.assign(Object.create(entry), properties) : entry;
      } };
      await assert.rejects(() => attestLocalDockerBuilder(RUNNER_DOCKER_HOST,
        { ...options, fileSystem }));
    }
  }
});

test("Windows attestation rejects an untrusted-write ACL even for context-only keys", async () => {
  const homeDirectory = "C:\\Users\\fixture";
  const current = `${homeDirectory}\\.docker\\buildx\\current`;
  const directories = new Set(["C:\\", "C:\\Users", homeDirectory,
    `${homeDirectory}\\.docker`, `${homeDirectory}\\.docker\\buildx`]);
  const fileSystem = {
    async lstat(location) {
      if (location === current) return { isFile: () => true, isSymbolicLink: () => false,
        size: 60, nlink: 1 };
      if (directories.has(location)) return { isDirectory: () => true, isSymbolicLink: () => false };
      throw Object.assign(new Error("not found"), { code: "ENOENT" });
    },
    async readFile() { return Buffer.from(JSON.stringify({ Key: "other-context", Name: "", Global: true })); },
  };
  const options = { platform: "win32", homeDirectory, environment: {}, fileSystem,
    verifyDockerAcl: async location => {
      if (location === current) throw new Error("untrusted write access");
    } };
  await assert.rejects(() => attestLocalDockerBuilder(WINDOWS_DOCKER_HOST, options));
  assert.equal(await attestLocalDockerBuilder(WINDOWS_DOCKER_HOST,
    { ...options, verifyDockerAcl: async () => {} }), `${homeDirectory}\\.docker`);
});

test("existing Windows Docker ACL accepts inherited trusted owners but rejects untrusted modification", async () => {
  const user = "S-1-5-21-100-200-300-1001";
  const base = { owner: user, current: user, rules: [
    { sid: user, rights: 2032127, type: 0 },
    { sid: "S-1-5-18", rights: 2032127, type: 0 },
    { sid: "S-1-5-32-544", rights: 2032127, type: 0 },
    { sid: "S-1-1-0", rights: 131209, type: 0 },
  ] };
  const verify = acl => verifyWindowsDockerConfigPath("C:\\Users\\fixture\\.docker", {
    systemRoot: "C:\\Windows",
    runAclCommand: async () => ({ stdout: JSON.stringify(acl) }),
  });
  await verify(base);
  await assert.rejects(() => verify({ ...base, rules: [...base.rules,
    { sid: "S-1-1-0", rights: 278, type: 0 }] }), /ACL permits an untrusted builder change/u);
  await assert.rejects(() => verify({ ...base, owner: "S-1-5-21-400-500-600-1002" }),
    /ACL permits an untrusted builder change/u);
  await assert.rejects(() => verify({ ...base, rules: [] }), /ACL permits an untrusted builder change/u);
});

test("local Docker environments remove managed interpolation and Compose controls case-insensitively", () => {
  const managedNames = [
    "NGROK_AUTHTOKEN",
    "N8N_ENCRYPTION_KEY",
    "NGROK_DOMAIN",
    "N8N_LOCAL_PORT",
    "NGROK_INSPECTOR_PORT",
    "GENERIC_TIMEZONE",
    "SANDBOX_API_KEYS",
    "SANDBOX_API_RUNNER_REGISTRATION_TOKEN",
    "SANDBOX_API_RUNNER_API_KEY",
    "SEARXNG_SECRET",
  ];
  const environment = {
    PATH: "/usr/bin",
    RELMIO_UNRELATED: "preserved",
    COMPOSER_TOKEN: "also-preserved",
    Compose_Project_Name: "unreviewed-project",
    compose_profiles: "unreviewed-profile",
  };
  for (const name of managedNames) {
    environment[
      [...name]
        .map((character, index) =>
          index % 2 === 0 ? character.toLowerCase() : character,
        )
        .join("")
    ] = `stale-${name}`;
  }

  assert.deepEqual(createLocalDockerEnvironment(environment), {
    PATH: "/usr/bin",
    RELMIO_UNRELATED: "preserved",
    COMPOSER_TOKEN: "also-preserved",
  });
});

test("local process runner permits an unpinned initial Docker context inspection", async () => {
  let invocation;
  await runLocalProcess(
    {
      file: "docker",
      args: ["context", "inspect", "--format", "{{json .Endpoints.docker.Host}}"],
      cwd: "/tmp/relmio-test",
    },
    {
      environment: { PATH: "/usr/bin", DOCKER_CONTEXT: "remote" },
      spawnProcess(file, args, options) {
        invocation = { file, args, options };
        return createFakeChild((child) => closeChild(child, 0));
      },
    },
  );

  assert.deepEqual(invocation.args, [
    "context",
    "inspect",
    "--format",
    "{{json .Endpoints.docker.Host}}",
  ]);
  assert.deepEqual(invocation.options.env, { PATH: "/usr/bin" });
});

function capturingAclHelper(answer = true) {
  const requests = [];
  return { requests, async check(request) { requests.push(request); return answer; } };
}

test("Windows managed paths are ACL-locked to the current account before use", async () => {
  const aclHelper = capturingAclHelper();
  await lockDownLocalPath("C:\\Users\\test\\.relmio", {
    platform: "win32",
    systemRoot: "C:\\Windows",
    aclHelper,
  });
  assert.equal(aclHelper.requests.length, 1);
  const [{ powershell, script, path }] = aclHelper.requests;
  assert.equal(powershell, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
  assert.equal(path, "C:\\Users\\test\\.relmio");
  assert.equal(script.includes(path), false);
  assert.match(script, /\$identity=\[System\.Security\.Principal\.WindowsIdentity\]::GetCurrent\(\)/u);
  assert.match(script, /\$beforeOwner=\$before\.GetOwner\(\[System\.Security\.Principal\.SecurityIdentifier\]\)/u);
  assert.match(script, /BuiltinAdministratorsSid/u);
  assert.match(script, /WindowsBuiltInRole\]::Administrator/u);
  assert.match(script, /\$beforeOwner\.Value -ne \$sid\.Value -and \(-not \(\$beforeOwner\.Value -eq \$administratorsSid\.Value/u);
  assert.match(script, /if\(\$normalizeOwner\)\{\$acl\.SetOwner\(\$sid\)\}/u);
  assert.match(script, /SetAccessRuleProtection\(\$true,\$false\)/u);
  assert.match(script, /ContainerInherit[^;]*ObjectInherit/u);
  assert.match(script, /\$rules\.Count -ne 1/u);
  assert.match(script, /FileSystemRights -ne \[System\.Security\.AccessControl\.FileSystemRights\]::FullControl/u);
  assert.match(script, /PropagationFlags -ne \[System\.Security\.AccessControl\.PropagationFlags\]::None/u);
  assert.match(script, /\.IsInherited/u);
  assert.match(script, /\$actual\.GetOwner\(\[System\.Security\.Principal\.SecurityIdentifier\]\)/u);
  assert.match(script, /\$owner\.Value -ne \$sid\.Value/u);
  assert.match(script, /return \$true$/u);
});

test("Windows managed paths can verify an exact ACL without rewriting it", async () => {
  const aclHelper = capturingAclHelper();
  await lockDownLocalPath("C:\\Users\\test\\.relmio", {
    platform: "win32",
    systemRoot: "C:\\Windows",
    verifyOnly: true,
    aclHelper,
  });
  const [{ script }] = aclHelper.requests;
  assert.match(script, /\$actual=\$before/u);
  assert.doesNotMatch(script, /SetAccessControl|SetAccessRuleProtection|SetOwner|New-Object/u);
  assert.doesNotMatch(script, /BuiltinAdministratorsSid|WindowsBuiltInRole/u);
  assert.match(script, /if\(\$owner\.Value -ne \$sid\.Value\)\{return \$false\}/u);
  assert.match(script, /\$rules\.Count -ne 1/u);
  assert.match(script, /AreAccessRulesProtected/u);
  await assert.rejects(
    () => lockDownLocalPath("C:\\Users\\test\\.relmio", {
      platform: "win32",
      systemRoot: "C:\\Windows",
      verifyOnly: "yes",
      aclHelper,
    }),
    /verification mode is invalid/u,
  );
  await assert.rejects(
    () => lockDownLocalPath("C:\\Users\\test\\.relmio", {
      platform: "win32", systemRoot: "C:\\Windows", verifyOnly: true, aclHelper: capturingAclHelper(false),
    }),
    /owner-only protection/u,
  );
});

test("Windows legacy verification accepts only an inherited effective owner-only file ACL", async () => {
  const aclHelper = capturingAclHelper();
  await lockDownLocalPath("C:\\Users\\test\\.relmio\\managed.json", {
    platform: "win32",
    systemRoot: "C:\\Windows",
    kind: "file",
    verifyOnly: true,
    verifyEffectiveOwnerOnly: true,
    aclHelper,
  });
  const [{ script }] = aclHelper.requests;

  assert.doesNotMatch(script, /SetAccessControl|SetAccessRuleProtection|SetOwner|New-Object/u);
  assert.match(script, /\$rules\.Count -ne 1/u);
  assert.match(script, /\$rules\[0\]\.IdentityReference\.Value -ne \$sid\.Value/u);
  assert.match(script, /AccessControlType -ne 'Allow'/u);
  assert.match(script, /FileSystemRights -ne \[System\.Security\.AccessControl\.FileSystemRights\]::FullControl/u);
  assert.match(script, /BuiltinAdministratorsSid/u);
  assert.match(script, /WindowsBuiltInRole\]::Administrator/u);
  assert.match(
    script,
    /\$trustedLegacyAdministratorsOwner=\$legacyInheritedOwnerOnly -and \$owner\.Value -eq \$administratorsSid\.Value -and \$principal\.IsInRole/u,
  );
  assert.match(script, /if\(\$owner\.Value -ne \$sid\.Value -and \(-not \$trustedLegacyAdministratorsOwner\)\)\{return \$false\}/u);
  assert.match(script, /\$strictOwnerOnly/u);
  assert.match(script, /\$legacyInheritedOwnerOnly/u);
  assert.match(
    script,
    /\(-not \$actual\.AreAccessRulesProtected\) -and \$rules\[0\]\.IsInherited/u,
  );
  assert.match(script, /if\(-not \(\$strictOwnerOnly -or \$legacyInheritedOwnerOnly\)\)\{return \$false\}/u);

  for (const invalid of [
    { kind: "directory", verifyOnly: true, verifyEffectiveOwnerOnly: true },
    { kind: "file", verifyOnly: false, verifyEffectiveOwnerOnly: true },
    { kind: "file", verifyOnly: true, verifyEffectiveOwnerOnly: "yes" },
  ]) {
    await assert.rejects(
      () => lockDownLocalPath("C:\\Users\\test\\.relmio\\managed.json", {
        platform: "win32",
        systemRoot: "C:\\Windows",
        aclHelper,
        ...invalid,
      }),
      /effective owner-only verification mode is invalid/u,
    );
  }
});

test("Windows ACL lockdown rejects malformed system roots before invoking a process", async () => {
  const invalidSystemRoots = [
    null,
    "",
    "Windows",
    "C:\\NotWindows",
    "C:\\Windows\\System32",
    "C:\\other\\..\\Windows",
    "\\\\server\\share\\Windows",
    "C:\\Windows\0untrusted",
  ];
  for (const systemRoot of invalidSystemRoots) {
    const aclHelper = capturingAclHelper();
    await assert.rejects(
      () =>
        lockDownLocalPath("C:\\Users\\test\\.relmio", {
          platform: "win32",
          systemRoot,
          aclHelper,
        }),
      /built-in security tool/iu,
    );
    assert.equal(aclHelper.requests.length, 0);
  }
});

test("Windows ACL lockdown sanitizes PowerShell launch and proof failures", async () => {
  const privateDetail = "private-upstream-detail";
  await assert.rejects(
    () =>
      lockDownLocalPath("C:\\Users\\test\\.relmio", {
        platform: "win32",
        systemRoot: "D:\\Windows",
        aclHelper: { async check() { throw new Error(privateDetail); } },
      }),
    (error) => {
      assert.match(error.message, /owner-only protection/iu);
      assert.doesNotMatch(error.message, new RegExp(privateDetail, "u"));
      assert.doesNotMatch(error.message, /powershell|D:\\\\Windows/iu);
      return true;
    },
  );
});

function createHelperChild(reply = (request, child) => {
  child.stdout.write(`{"id":${request.id},"ok":true}\r\n`);
}) {
  const child = createFakeChild();
  child.requests = [];
  child.refs = [];
  for (const name of ["ref", "unref"]) child[name] = () => child.refs.push(name);
  let buffered = "";
  child.stdin.on("data", (chunk) => {
    buffered += chunk.toString("utf8");
    let newline;
    while ((newline = buffered.indexOf("\n")) >= 0) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      child.lines = [...(child.lines ?? []), line];
      const request = JSON.parse(line);
      child.requests.push(request);
      reply(request, child);
    }
  });
  return child;
}

async function captureAclScript(options) {
  const aclHelper = capturingAclHelper();
  await lockDownLocalPath("C:\\Users\\test\\.relmio\\managed.json", {
    platform: "win32", systemRoot: "C:\\Windows", aclHelper, ...options,
  });
  return aclHelper.requests[0].script;
}

test("Windows ACL helper reuses one PowerShell process and frames each path as JSON data", async () => {
  const spawned = [];
  const exitListeners = new Set();
  const helper = createWindowsAclHelper({
    spawnProcess(file, args, options) {
      const child = createHelperChild();
      spawned.push({ file, args, options, child });
      return child;
    },
    onProcessExit(listener) { exitListeners.add(listener); return () => exitListeners.delete(listener); },
  });
  const powershell = "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe";
  const script = await captureAclScript({ kind: "file", verifyOnly: true });
  const unicodePath = "C:\\Users\\tést\\.relmio\\\"quoted\" 𝔘.json";
  assert.deepEqual(await Promise.all([
    helper.check({ powershell, script, path: "C:\\Users\\test\\a.json" }),
    helper.check({ powershell, script, path: unicodePath }),
  ]), [true, true]);
  assert.equal(spawned.length, 1);
  const [{ file, args, options, child }] = spawned;
  assert.equal(file, powershell);
  assert.deepEqual(args.slice(0, 4), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"]);
  assert.equal(options.shell, false);
  assert.equal(options.windowsHide, true);
  assert.equal(args[4].includes('"'), false);
  assert.equal(args[4].includes("tést"), false);
  assert.match(args[4], /ConvertFrom-Json/u);
  assert.equal(args[4].includes(script), true);
  assert.deepEqual(child.requests.map(({ path }) => path), ["C:\\Users\\test\\a.json", unicodePath]);
  assert.equal(child.requests[0].check, child.requests[1].check);
  assert.ok(child.requests[1].id > child.requests[0].id);
  assert.ok(child.lines.every((line) => /^[\x20-\x7e]+$/u.test(line)));
  assert.equal(child.refs.at(-1), "unref");
  assert.equal(exitListeners.size, 1);
  [...exitListeners][0]();
  assert.deepEqual(child.killCalls, ["SIGKILL"]);
});

test("Windows ACL helper answers requests one at a time and reports a refused check", async () => {
  let release;
  const child = createHelperChild((request, spawned) => {
    if (request.id === 1) release = () => spawned.stdout.write(`{"id":1,"ok":false}\n`);
    else spawned.stdout.write(`{"id":${request.id},"ok":true}\n`);
  });
  const helper = createWindowsAclHelper({ spawnProcess: () => child, onProcessExit: () => () => {} });
  const request = { powershell: "C:\\Windows\\powershell.exe", script: await captureAclScript({ kind: "file" }) };
  const first = helper.check({ ...request, path: "C:\\one" });
  const second = helper.check({ ...request, path: "C:\\two" });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(child.requests.length, 1);
  await assertPromisePending(second);
  release();
  assert.equal(await first, false);
  assert.equal(await second, true);
  assert.equal(child.requests.length, 2);
});

test("Windows ACL helper fails a timed-out, crashed or malformed request closed and restarts", async (t) => {
  const request = { powershell: "C:\\Windows\\powershell.exe", script: await captureAclScript({ kind: "file", verifyOnly: true }) };
  for (const [name, fault] of [
    ["timeout", null],
    ["crash", (_request, child) => closeChild(child, 1)],
    ["unexpected id", (requested, child) => child.stdout.write(`{"id":${requested.id + 1},"ok":true}\n`)],
    ["malformed", (_request, child) => child.stdout.write("ok\n")],
    ["oversized", (_request, child) => child.stdout.write("x".repeat(64))],
  ]) {
    await t.test(name, async () => {
      const timers = createManualTimers();
      const children = [];
      const detached = [];
      const helper = createWindowsAclHelper({
        spawnProcess() {
          const child = createHelperChild(children.length === 0
            ? (requested, spawned) => fault?.(requested, spawned)
            : undefined);
          children.push(child);
          return child;
        },
        onProcessExit: () => () => detached.push(children.length),
        setTimer: timers.setTimer,
        clearTimer: timers.clearTimer,
        maxResponseBytes: 32,
      });
      const failed = helper.check({ ...request, path: "C:\\first" });
      await new Promise((resolve) => setImmediate(resolve));
      if (name === "timeout") timers.fire(60_000);
      await assert.rejects(failed);
      assert.equal(children[0].killCalls.length, 1);
      assert.equal(detached.length, 1);
      assert.equal(await helper.check({ ...request, path: "C:\\second" }), true);
      assert.equal(children.length, 2);
      assert.deepEqual(children[1].requests.map(({ path }) => path), ["C:\\second"]);
    });
  }
});

test("a stalled read-only ACL check on a ready helper times out in 5 s and the next check starts fresh", async () => {
  const timers = createManualTimers();
  const requested = [];
  const children = [];
  let stall = false;
  const helper = createWindowsAclHelper({
    spawnProcess() {
      const child = createHelperChild((request, spawned) => {
        if (!(stall && children.indexOf(spawned) === 0)) spawned.stdout.write(`{"id":${request.id},"ok":true}\n`);
      });
      children.push(child);
      return child;
    },
    onProcessExit: () => () => {},
    setTimer(callback, milliseconds) { requested.push(milliseconds); return timers.setTimer(callback, milliseconds); },
    clearTimer: timers.clearTimer,
  });
  const powershell = "C:\\Windows\\powershell.exe";
  const verify = { powershell, script: await captureAclScript({ kind: "file", verifyOnly: true }) };
  const lockdown = { powershell, script: await captureAclScript({ kind: "file" }) };
  const scheduled = async request => {
    requested.length = 0;
    const result = helper.check(request);
    await new Promise(resolve => setImmediate(resolve));
    return { result, milliseconds: [...requested] };
  };
  // The first request covers PowerShell startup, so even a read-only check gets the long timeout.
  const first = await scheduled({ ...verify, path: "C:\\first" });
  assert.deepEqual(first.milliseconds, [60_000]);
  assert.equal(await first.result, true);
  const applied = await scheduled({ ...lockdown, path: "C:\\applied" });
  assert.deepEqual(applied.milliseconds, [60_000]);
  assert.equal(await applied.result, true);
  stall = true;
  const stalled = await scheduled({ ...verify, path: "C:\\stalled" });
  assert.deepEqual(stalled.milliseconds, [5_000]);
  const queued = helper.check({ ...verify, path: "C:\\queued" });
  timers.fire(5_000);
  await assert.rejects(stalled.result, /timed out/u);
  assert.deepEqual(children[0].killCalls, ["SIGKILL"]);
  assert.equal(await queued, true);
  assert.equal(children.length, 2);
  assert.deepEqual(children[1].requests.map(({ path }) => path), ["C:\\queued"]);
});

test("Windows ACL helper rejects unknown checks and malformed paths without starting PowerShell", async () => {
  let spawned = 0;
  const helper = createWindowsAclHelper({ spawnProcess: () => { spawned++; return createHelperChild(); } });
  const script = await captureAclScript({ kind: "file" });
  for (const request of [
    { powershell: "C:\\Windows\\powershell.exe", script: `${script};Remove-Item $path`, path: "C:\\one" },
    { powershell: "C:\\Windows\\powershell.exe", script, path: "C:\\\ud800broken" },
    { powershell: "C:\\Windows\\powershell.exe", script, path: 7 },
  ]) await assert.rejects(() => helper.check(request), TypeError);
  assert.equal(spawned, 0);
});

test("Windows ACL runner bounds stalled and overlong security subprocesses", async (t) => {
  await t.test("default timeout tolerates contended native process startup", async () => {
    const timers = createManualTimers();
    const child = createFakeChild(() => {}, { closeOnKill: false });
    const command = runWindowsAclCommand("C:\\Windows\\powershell.exe", [], {
      spawnProcess: () => child,
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
    });
    await new Promise((resolve) => queueMicrotask(resolve));
    const scheduledMilliseconds = timers.scheduledMilliseconds;
    closeChild(child, 0);
    await command;
    assert.deepEqual(scheduledMilliseconds, [60_000]);
    assert.equal(timers.activeCount, 0);
  });

  await t.test("timeout", async () => {
    const child = createFakeChild(() => {}, { closeOnKill: false });
    await assert.rejects(
      runWindowsAclCommand("C:\\Windows\\powershell.exe", [], {
        input: "C:\\Users\\test\\.relmio",
        spawnProcess: () => child,
        timeoutMs: 5,
        terminationGraceMs: 5,
      }),
      /timed out/u,
    );
    assert.deepEqual(child.killCalls, ["SIGKILL"]);
  });

  await t.test("output limit", async () => {
    let child;
    await assert.rejects(
      runWindowsAclCommand("C:\\Windows\\powershell.exe", [], {
        spawnProcess() {
          child = createFakeChild((spawned) => {
            spawned.stdout.write(Buffer.alloc(9));
          });
          return child;
        },
        maxOutputBytes: 8,
        timeoutMs: 1_000,
        terminationGraceMs: 5,
      }),
      /too much output/u,
    );
    assert.deepEqual(child.killCalls, ["SIGKILL"]);
  });
});

test(
  "Windows ACL lockdown succeeds against real NTFS directories and files",
  { skip: process.platform !== "win32" },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "relmio-acl-test-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    await lockDownLocalPath(directory, { platform: "win32" });
    const credentialPath = join(directory, "auth.json");
    await writeFile(credentialPath, "{}", "utf8");
    await lockDownLocalPath(credentialPath, { platform: "win32", kind: "file" });
    await lockDownLocalPath(directory, { platform: "win32", verifyOnly: true });
    await lockDownLocalPath(credentialPath, {
      platform: "win32",
      kind: "file",
      verifyOnly: true,
    });
    assertExactOwnerOnlyAcl(await inspectWindowsAcl(directory), 3);
    assertExactOwnerOnlyAcl(await inspectWindowsAcl(credentialPath), 0);
  },
);

test(
  "Windows legacy verification accepts an inherited owner-only file beneath a protected directory",
  { skip: process.platform !== "win32" },
  async (t) => {
    const directory = await mkdtemp(join(tmpdir(), "relmio-legacy-acl-test-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    await lockDownLocalPath(directory, { platform: "win32" });
    const inheritedFile = join(directory, "managed.json");
    await writeFile(inheritedFile, "{}", "utf8");
    await assert.rejects(
      () => lockDownLocalPath(inheritedFile, {
        platform: "win32",
        kind: "file",
        verifyOnly: true,
      }),
      /owner-only protection/u,
    );
    await lockDownLocalPath(inheritedFile, {
      platform: "win32",
      kind: "file",
      verifyOnly: true,
      verifyEffectiveOwnerOnly: true,
    });

    const windowsPowerShell = join(
      process.env.SystemRoot,
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    const addOtherAccountRule = [
      "$path=[Console]::In.ReadToEnd()",
      "$item=[System.IO.FileInfo]::new($path)",
      "$acl=$item.GetAccessControl()",
      "$everyone=[System.Security.Principal.SecurityIdentifier]::new([System.Security.Principal.WellKnownSidType]::WorldSid,$null)",
      "$rule=[System.Security.AccessControl.FileSystemAccessRule]::new($everyone,[System.Security.AccessControl.FileSystemRights]::ReadData,[System.Security.AccessControl.InheritanceFlags]::None,[System.Security.AccessControl.PropagationFlags]::None,[System.Security.AccessControl.AccessControlType]::Allow)",
      "$acl.AddAccessRule($rule)",
      "$item.SetAccessControl($acl)",
    ].join(";");
    await runWindowsAclCommand(
      windowsPowerShell,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", addOtherAccountRule],
      { input: inheritedFile },
    );
    await assert.rejects(
      () => lockDownLocalPath(inheritedFile, {
        platform: "win32",
        kind: "file",
        verifyOnly: true,
        verifyEffectiveOwnerOnly: true,
      }),
      /owner-only protection/u,
    );
  },
);

test(
  "Windows ACL lockdown protects the exact non-ASCII path supplied on stdin",
  { skip: process.platform !== "win32" },
  async (t) => {
    await useLegacyConsoleCodePage(t);
    const directory = await mkdtemp(join(tmpdir(), "relmio-acl-utf8-"));
    t.after(() => rm(directory, { recursive: true, force: true }));
    const unicodeDirectory = join(directory, "caf\u00e9_\u6771\u4eac_\u{1F600}");
    await mkdir(unicodeDirectory);
    const credentialPath = join(
      unicodeDirectory,
      "Jos\u00e9_\u65e5\u672c_\u{1D11E}_$';[]().json",
    );
    await writeFile(credentialPath, "{}", "utf8");
    const before = await inspectWindowsAcl(credentialPath);
    assert.equal(before.accessRulesProtected, false, JSON.stringify(before));

    await lockDownLocalPath(credentialPath, { platform: "win32", kind: "file" });
    await lockDownLocalPath(credentialPath, {
      platform: "win32",
      kind: "file",
      verifyOnly: true,
    });
    await lockDownLocalPath(credentialPath, {
      platform: "win32",
      kind: "file",
      verifyOnly: true,
      verifyEffectiveOwnerOnly: true,
    });
    assertExactOwnerOnlyAcl(await inspectWindowsAcl(credentialPath), 0);

    await lockDownLocalPath(unicodeDirectory, { platform: "win32" });
    await lockDownLocalPath(unicodeDirectory, {
      platform: "win32",
      verifyOnly: true,
    });
    assertExactOwnerOnlyAcl(await inspectWindowsAcl(unicodeDirectory), 3);

    const inheritedPath = join(
      unicodeDirectory,
      "Jos\u00e9_\u65e5\u672c_\u{1F600}_$';[]().json",
    );
    await writeFile(inheritedPath, "{}", "utf8");
    await assert.rejects(
      () => lockDownLocalPath(inheritedPath, {
        platform: "win32",
        kind: "file",
        verifyOnly: true,
      }),
      /owner-only protection/u,
    );
    await lockDownLocalPath(inheritedPath, {
      platform: "win32",
      kind: "file",
      verifyOnly: true,
      verifyEffectiveOwnerOnly: true,
    });
    const inherited = await inspectWindowsAcl(inheritedPath);
    const inheritedDiagnostic = JSON.stringify(inherited);
    assert.equal(inherited.accessRulesProtected, false, inheritedDiagnostic);
    assert.equal(inherited.rules.length, 1, inheritedDiagnostic);
    assert.equal(inherited.rules[0].identity, "current-user", inheritedDiagnostic);
    assert.equal(inherited.rules[0].accessType, 0, inheritedDiagnostic);
    assert.equal(inherited.rules[0].rights, 2_032_127, inheritedDiagnostic);
    assert.equal(inherited.rules[0].inherited, true, inheritedDiagnostic);
  },
);


test("local process runner rejects executable, argument, and Docker host injection", async () => {
  for (const input of [
    { file: "sh", args: ["-c", "id"], cwd: "/tmp" },
    { file: "docker", args: ["compose\nrun", "id"], cwd: "/tmp" },
    { file: "docker", args: ["compose", "\0bad"], cwd: "/tmp" },
    { file: "docker", args: ["compose"], cwd: "relative/path" },
    {
      file: "docker",
      args: ["version"],
      cwd: "/tmp",
      dockerHost: "tcp://attacker.example.test:2375",
    },
  ]) {
    await assert.rejects(
      () => runLocalProcess(input),
      /process|docker|argument|directory|host/i,
    );
  }
});

test("local process runner waits for close after output overflow and clears its kill timer", async () => {
  let child;
  const timers = createManualTimers();
  const processPromise = runLocalProcess(
    {
      file: "docker",
      args: ["version"],
      cwd: "/tmp",
      maxOutputBytes: 8,
    },
    {
      spawnProcess() {
        child = createFakeChild(
          (fake) => fake.stdout.write("123456789"),
          { closeOnKill: false },
        );
        return child;
      },
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      terminationGraceMs: 25,
    },
  );

  await new Promise((resolve) => queueMicrotask(resolve));
  assert.deepEqual(child.killCalls, ["SIGTERM"]);
  await assertPromisePending(processPromise);

  closeChild(child);
  await assert.rejects(processPromise, /output|limit/i);
  assert.equal(timers.activeCount, 0);
});

test("local process runner settles after an ignored SIGKILL without waiting forever", async () => {
  let child;
  const timers = createManualTimers();
  const processPromise = runLocalProcess(
    {
      file: "docker",
      args: ["version"],
      cwd: "/tmp",
      timeoutMs: 100,
    },
    {
      spawnProcess() {
        child = createFakeChild(() => {}, { closeOnKill: false });
        return child;
      },
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      terminationGraceMs: 25,
    },
  );

  timers.fire(100);
  assert.deepEqual(child.killCalls, ["SIGTERM"]);
  await assertPromisePending(processPromise);

  timers.fire(25);
  assert.deepEqual(child.killCalls, ["SIGTERM", "SIGKILL"]);
  await assertPromisePending(processPromise);
  assert.equal(timers.activeCount, 1);

  timers.fire(25);
  await assert.rejects(processPromise, /timed out/i);
  assert.equal(timers.activeCount, 0);

  // Late process events after terminal settlement are idempotent.
  closeChild(child);
});

test("local process runner terminates before settling an stdin failure", async () => {
  let child;
  const timers = createManualTimers();
  const processPromise = runLocalProcess(
    {
      file: "docker",
      args: ["compose", "up"],
      cwd: "/tmp",
    },
    {
      spawnProcess() {
        child = createFakeChild(() => {}, { closeOnKill: false });
        return child;
      },
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      terminationGraceMs: 25,
    },
  );

  child.stdin.emit("error", new Error("write failed"));
  assert.deepEqual(child.killCalls, ["SIGTERM"]);
  await assertPromisePending(processPromise);

  closeChild(child);
  await assert.rejects(processPromise, /could not start/i);
  assert.equal(timers.activeCount, 0);
});

test("local process runner never includes child stderr in startup errors", async () => {
  await assert.rejects(
    () =>
      runLocalProcess(
        {
          file: "docker",
          args: ["version"],
          cwd: "/tmp",
        },
        {
          spawnProcess() {
            return createFakeChild((child) => {
              child.stderr.write("sk-super-secret-upstream-value");
              child.emit("error", new Error("spawn included secret"));
            });
          },
        },
      ),
    (error) => {
      assert.doesNotMatch(error.message, /secret|sk-/i);
      return true;
    },
  );
});

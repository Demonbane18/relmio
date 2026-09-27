import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile, lstat, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import test from "node:test";
import { withVpsOperationLock } from "../src/services/vps-operation-lock.js";
import { VPS_OPERATION_LOCKS, createVpsLockCommand, releaseVpsLockCommand,
  createVpsBuildStateCommand, cleanupVpsBuildStateCommand } from "../src/domain/vps-build-state.js";
import { SHARED_ROOT_MARKER_CONTENT, SIDECAR_BUILD_IGNORE_GUARD,
  SIDECAR_BUILD_IGNORE_CONTENT } from "../src/domain/safety.js";

const exec = promisify(execFile);
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const buildCommand = "docker compose --project-name fixture --file /docker/n8n-openai-oauth/local-model/compose.yaml --profile acquisition build --quiet acquisition";
const posix = { skip: process.platform === "win32" };

// Execute the generated POSIX shell against real disposable files. The only
// platform seam is GNU stat formatting/root UID and a synthetic mount table:
// neither privileged chown nor a Linux mount namespace is required by CI.
const statAdapter = `const fs=require('node:fs'); const a=process.argv.slice(1); const p=a.at(-1); try { const s=fs.lstatSync(p); const v={d:s.dev,i:s.ino,u:p===process.env.BAD_OWNER_PATH?1:s.uid===process.getuid()?0:s.uid,h:s.nlink,a:(s.mode&4095).toString(8),s:s.size}; process.stdout.write(a[1].replace(/%([diuhas])/g,(_,k)=>v[k])+'\\n'); } catch { process.exitCode=1; }`;

async function fixture(t, { docker = "", badOwner = "" } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "relmio-build-state-"));
  // Only this test's freshly created disposable tree is removed by the harness.
  t.after(() => rm(directory, { recursive: true, force: true }));
  const parent = join(directory, "docker");
  const root = join(parent, "n8n-openai-oauth");
  await mkdir(root, { recursive: true, mode: 0o755 });
  await writeFile(join(root, ".managed-by-relmio-root"), SHARED_ROOT_MARKER_CONTENT, { mode: 0o600 });
  await writeFile(join(root, "model-cache-sentinel"), "existing cache");
  await writeFile(join(directory, "n8n-sentinel"), "existing n8n");
  const mounts = join(directory, "mountinfo");
  await writeFile(mounts, "");
  const calls = [];
  const remote = { async exec(command) {
    calls.push(command);
    const script = `stat() { ${quote(process.execPath)} -e ${quote(statAdapter)} -- "$@"; }\ndocker() { ${docker || "return 91"}; }\n` +
      command.replaceAll("/docker", parent).replaceAll("/proc/self/mountinfo", mounts);
    try {
      const result = await exec("/bin/sh", ["-c", script], { env: { ...process.env, BAD_OWNER_PATH: badOwner && join(root, badOwner) } });
      return { code: 0, ...result };
    } catch (error) {
      return { code: typeof error.code === "number" ? error.code : 99, stdout: error.stdout ?? "", stderr: error.stderr ?? "" };
    }
  } };
  return { directory, root, mounts, remote, calls,
    state: join(root, ".local-model-operation.lock/buildx"),
    lock: join(root, ".local-model-operation.lock") };
}

const ordinaryBuild = `test "$BUILDX_BUILDER:$DOCKER_BUILDKIT:$COMPOSE_BAKE" = default:1:false || return 90; umask 077; mkdir -p "$BUILDX_CONFIG/refs/default/default" "$BUILDX_CONFIG/activity"; printf temporary > "$BUILDX_CONFIG/.lock"; printf history > "$BUILDX_CONFIG/refs/default/default/build-record"`;

async function unchanged(f) {
  assert.equal(await readFile(join(f.root, "model-cache-sentinel"), "utf8"), "existing cache");
  assert.equal(await readFile(join(f.directory, "n8n-sentinel"), "utf8"), "existing n8n");
}

test("confirmed build lease confines state and removes only its created tree", posix, async t => {
  const f = await fixture(t, { docker: ordinaryBuild });
  const value = await withVpsOperationLock(f.remote, VPS_OPERATION_LOCKS.model, async build => {
    await assert.rejects(lstat(f.state), { code: "ENOENT" });
    await build(buildCommand);
    assert.equal((await lstat(f.state)).mode & 0o777, 0o700);
    assert.equal(await readFile(join(f.state, "refs/default/default/build-record"), "utf8"), "history");
    return "started";
  });
  assert.equal(value, "started");
  await assert.rejects(lstat(f.lock), { code: "ENOENT" });
  await unchanged(f);
});

test("nonbuilding operation holds a lease without creating Buildx state", posix, async t => {
  const f = await fixture(t);
  await withVpsOperationLock(f.remote, VPS_OPERATION_LOCKS.model, async () => {
    assert.deepEqual(await readdir(f.lock), []);
  });
  await assert.rejects(lstat(f.lock), { code: "ENOENT" });
  await unchanged(f);
});

test("build failure still cleans verified state and preserves the primary failure", posix, async t => {
  const f = await fixture(t, { docker: `${ordinaryBuild}; return 7` });
  await assert.rejects(withVpsOperationLock(f.remote, VPS_OPERATION_LOCKS.model, build => build(buildCommand)));
  await assert.rejects(lstat(f.lock), { code: "ENOENT" });
  await unchanged(f);
});

for (const [name, injection] of [
  ["symlink", 'ln -s "$BUILDX_CONFIG/../../model-cache-sentinel" "$BUILDX_CONFIG/foreign"'],
  ["hardlink", 'ln "$BUILDX_CONFIG/../../model-cache-sentinel" "$BUILDX_CONFIG/foreign"'],
  ["special file", 'mkfifo "$BUILDX_CONFIG/foreign"'],
  ["group-writable entry", 'chmod 0666 "$BUILDX_CONFIG/.lock"'],
]) {
  test(`cleanup retains the entire tree and lock on ${name} ambiguity`, posix, async t => {
    const f = await fixture(t, { docker: `${ordinaryBuild}; ${injection}; return 7` });
    await assert.rejects(withVpsOperationLock(f.remote, VPS_OPERATION_LOCKS.model, build => build(buildCommand)), error => {
      assert.match(error.safeMessage, /administrator must inspect/u);
      assert.equal(error.operationLockRetained, true);
      return true;
    });
    assert.equal(await readFile(join(f.state, "refs/default/default/build-record"), "utf8"), "history");
    assert.equal((await lstat(f.lock)).isDirectory(), true);
    await unchanged(f);
  });
}

test("cleanup rejects a nested same-device mount before any deletion", posix, async t => {
  const f = await fixture(t, { docker: ordinaryBuild });
  await assert.rejects(withVpsOperationLock(f.remote, VPS_OPERATION_LOCKS.model, async build => {
    await build(buildCommand);
    await writeFile(f.mounts, `40 30 8:1 / ${f.state}/refs/default rw - ext4 /dev/fixture rw\n`);
  }), /administrator must inspect/u);
  assert.equal(await readFile(join(f.state, "refs/default/default/build-record"), "utf8"), "history");
  await unchanged(f);
});

test("cleanup rejects a foreign owner without deleting prior verified entries", posix, async t => {
  const f = await fixture(t, { docker: ordinaryBuild, badOwner: ".local-model-operation.lock/buildx/refs/default/default/build-record" });
  await assert.rejects(withVpsOperationLock(f.remote, VPS_OPERATION_LOCKS.model, build => build(buildCommand)), /administrator must inspect/u);
  assert.equal(await readFile(join(f.state, ".lock"), "utf8"), "temporary");
  await unchanged(f);
});

test("pre-existing lock is not adopted or cleaned", posix, async t => {
  const f = await fixture(t);
  await mkdir(f.lock, { mode: 0o700 });
  await writeFile(join(f.lock, "foreign"), "do not touch");
  let called = false;
  await assert.rejects(withVpsOperationLock(f.remote, VPS_OPERATION_LOCKS.model, () => { called = true; }), /held or uncertain/u);
  assert.equal(called, false);
  assert.equal(await readFile(join(f.lock, "foreign"), "utf8"), "do not touch");
});

test("state replacement cannot authorize deleting another inode", posix, async t => {
  const f = await fixture(t);
  const acquired = await f.remote.exec(createVpsLockCommand(VPS_OPERATION_LOCKS.model));
  assert.equal(acquired.code, 0);
  const identity = acquired.stdout.trim();
  const created = await f.remote.exec(createVpsBuildStateCommand(VPS_OPERATION_LOCKS.model, identity));
  assert.equal(created.code, 0);
  const wrongIdentity = `${(await lstat(f.state)).dev}:0`;
  assert.equal((await f.remote.exec(cleanupVpsBuildStateCommand(VPS_OPERATION_LOCKS.model, identity, wrongIdentity))).code, 73);
  assert.equal((await lstat(f.state)).isDirectory(), true);
  assert.notEqual((await f.remote.exec(releaseVpsLockCommand(VPS_OPERATION_LOCKS.model, identity))).code, 0);
});

test("OAuth ignore guard accepts only absent or exact owned context policy", posix, async t => {
  const f = await fixture(t);
  assert.equal((await f.remote.exec(SIDECAR_BUILD_IGNORE_GUARD)).code, 0);
  const path = join(f.root, "Dockerfile.dockerignore");
  await writeFile(path, SIDECAR_BUILD_IGNORE_CONTENT, { mode: 0o644 });
  assert.equal((await f.remote.exec(SIDECAR_BUILD_IGNORE_GUARD)).code, 0);
  await writeFile(path, "user policy\n");
  assert.notEqual((await f.remote.exec(SIDECAR_BUILD_IGNORE_GUARD)).code, 0);
  assert.equal(await readFile(path, "utf8"), "user policy\n");
});

test("interrupted build leaves its state and lease for explicit inspection", posix, async t => {
  const f = await fixture(t, { docker: ordinaryBuild });
  const original = f.remote.exec;
  const disconnected = new Error("fixture connection interrupted");
  f.remote.exec = async command => {
    const result = await original(command);
    if (command.includes("BUILDX_CONFIG=")) throw disconnected;
    return result;
  };
  await assert.rejects(withVpsOperationLock(f.remote, VPS_OPERATION_LOCKS.model, build => build(buildCommand)), error => {
    assert.equal(error, disconnected);
    assert.equal(error.operationLockRetained, true);
    return true;
  });
  assert.equal(await readFile(join(f.state, ".lock"), "utf8"), "temporary");
  assert.equal((await lstat(f.lock)).isDirectory(), true);
  await unchanged(f);
});

test("unknown non-build outcome after a successful build retains real state and lock despite responsive cleanup", posix, async t => {
  const f = await fixture(t, { docker: ordinaryBuild });
  const original = f.remote.exec;
  let cleanupAttempts = 0;
  f.remote.exec = async command => {
    if (command === "fixture-compose-up") {
      return Promise.reject(Object.assign(new Error("The SSH command closed without a verified exit status."), {
        remoteOutcomeUnknown: true,
      }));
    }
    if (command.includes("state_guard()") || command.includes("rmdir /docker/n8n-openai-oauth/.local-model-operation.lock")) cleanupAttempts += 1;
    return original(command);
  };
  await assert.rejects(withVpsOperationLock(f.remote, VPS_OPERATION_LOCKS.model, async build => {
    await build(buildCommand);
    await f.remote.exec("fixture-compose-up");
  }), error => {
    assert.equal(error.operationLockRetained, true);
    assert.match(error.safeMessage, /administrator must inspect/u);
    return true;
  });
  assert.equal(cleanupAttempts, 0);
  assert.equal(await readFile(join(f.state, ".lock"), "utf8"), "temporary");
  assert.equal((await lstat(f.lock)).isDirectory(), true);
  await unchanged(f);
});

test("operation error remains primary when verified cleanup succeeds", posix, async t => {
  const f = await fixture(t, { docker: ordinaryBuild });
  const primary = new Error("fixture deployment failure");
  await assert.rejects(withVpsOperationLock(f.remote, VPS_OPERATION_LOCKS.model, async build => {
    await build(buildCommand);
    throw primary;
  }), error => error === primary);
  await assert.rejects(lstat(f.lock), { code: "ENOENT" });
  await unchanged(f);
});

test("disconnect after lock creation reports the exact retained lease without cleanup", posix, async t => {
  const f = await fixture(t);
  const original = f.remote.exec;
  const disconnected = new Error("fixture acquisition disconnect");
  f.remote.exec = async command => {
    await original(command);
    throw disconnected;
  };
  let entered = false;
  await assert.rejects(withVpsOperationLock(f.remote, VPS_OPERATION_LOCKS.model, () => { entered = true; }), error => {
    assert.equal(error.cause, disconnected);
    assert.equal(error.operationLockRetained, true);
    assert.ok(error.safeMessage.includes(VPS_OPERATION_LOCKS.model));
    return true;
  });
  assert.equal(entered, false);
  assert.equal((await lstat(f.lock)).isDirectory(), true);
  assert.deepEqual(await readdir(f.lock), []);
  await unchanged(f);
});

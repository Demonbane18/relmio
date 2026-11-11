import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { chmod, lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  ASSISTANT_PRECHECK_COMMAND, createAssistantDeploymentCommands, createAssistantInstallation,
} from "../src/domain/assistant.js";
import {
  PRECHECK_COMMAND, SHARED_ROOT_COMMAND, SHARED_ROOT_MARKER_CONTENT, SHARED_ROOT_TIGHTEN_COMMAND,
  createDeploymentCommands, createVerificationCommands,
} from "../src/domain/safety.js";
import {
  VPS_OPERATION_LOCKS, claimVpsResumeLockCommand, cleanupVpsBuildStateCommand, createVpsBuildStateCommand,
  createVpsLockCommand, inspectVpsResumeLockCommand, releaseVpsLockCommand, releaseVpsResumeClaimCommand,
} from "../src/domain/vps-build-state.js";
import { applyVpsClaude } from "../src/services/vps-claude.js";
import { installVpsLocalModel, reviewVpsLocalModel } from "../src/services/vps-local-model.js";
import { installVpsSuperGrok } from "../src/services/vps-supergrok.js";

const exec = promisify(execFile);
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const posix = { skip: process.platform === "win32" };
const mode = async path => (await lstat(path)).mode & 0o7777;

// The generated POSIX shell runs against real disposable folders. The only seam is GNU stat's
// output and the root owner: files of the test user count as root's, as on the VPS.
const statAdapter = `const fs=require('node:fs'); const a=process.argv.slice(1); const p=a.at(-1); try { const s=fs.lstatSync(p); const v={d:s.dev,i:s.ino,u:p===process.env.FOREIGN_OWNER_PATH?1000:s.uid===process.getuid()?0:s.uid,h:s.nlink,a:(s.mode&4095).toString(8),s:s.size}; process.stdout.write(a[1].replace(/%([diuhas])/g,(_,k)=>v[k])+'\\n'); } catch { process.exitCode=1; }`;

async function fixture(t, { rootMode } = {}) {
  const directory = await mkdtemp(join(tmpdir(), "relmio-shared-root-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const parent = join(directory, "docker");
  const root = join(parent, "n8n-openai-oauth");
  await mkdir(parent, { mode: 0o755 });
  if (rootMode !== undefined) {
    await mkdir(root);
    await chmod(root, rootMode);
  }
  const mounts = join(directory, "mountinfo");
  const ownershipLog = join(directory, "ownership");
  await writeFile(mounts, "");
  const shell = async (command, { foreignOwner = "" } = {}) => {
    const script = `stat() { ${quote(process.execPath)} -e ${quote(statAdapter)} -- "$@"; }\n` +
      `chown() { [ "$#" = 3 ] && [ "$1:$2" = '-h:0:0' ] && [ "$3" = ${quote(root)} ] && [ -d "$3" ] && [ ! -L "$3" ] && printf '%s\\n' "$2:$3" >> ${quote(ownershipLog)}; }\n` +
      command.replaceAll("/docker", parent).replaceAll("/proc/self/mountinfo", mounts);
    try {
      const { stdout } = await exec("/bin/sh", ["-c", script], { env: { ...process.env, FOREIGN_OWNER_PATH: foreignOwner } });
      return { code: 0, stdout };
    } catch (error) {
      return { code: typeof error.code === "number" ? error.code : 99, stdout: error.stdout ?? "" };
    }
  };
  const run = async (command, options) => (await shell(command, options)).code;
  return { directory, parent, root, run, shell, ownershipLog };
}

test("the shared root command creates Relmio's folder for root only", posix, async t => {
  const f = await fixture(t);
  assert.equal(await f.run(SHARED_ROOT_COMMAND), 0);
  assert.equal(await mode(f.root), 0o700);
  // A second run keeps it.
  assert.equal(await f.run(SHARED_ROOT_COMMAND), 0);
  assert.equal(await mode(f.root), 0o700);
  assert.equal(await readFile(f.ownershipLog, "utf8"), `0:0:${f.root}\n`);
});

test("status and review commands leave an existing 0755 folder alone; the shared root command sets it to 0700 and keeps the session folder", posix, async t => {
  const f = await fixture(t, { rootMode: 0o755 });
  await writeFile(join(f.root, ".managed-by-relmio-root"), SHARED_ROOT_MARKER_CONTENT, { mode: 0o644 });
  await mkdir(join(f.root, "siwc"), { mode: 0o700 });
  await writeFile(join(f.root, "siwc", "host.json"), "session", { mode: 0o600 });
  const verification = createVerificationCommands();
  // What status and review run never changes the mode.
  for (const command of [PRECHECK_COMMAND, ASSISTANT_PRECHECK_COMMAND, verification.sharedRoot, verification.staging,
    verification.stagedFiles, verification.legacyStatus, ...Object.values(VPS_OPERATION_LOCKS).map(inspectVpsResumeLockCommand)]) {
    await f.run(command);
    assert.equal(await mode(f.root), 0o755);
  }
  assert.equal(await f.run(SHARED_ROOT_COMMAND), 0);
  assert.equal(await mode(f.root), 0o700);
  assert.equal(await mode(join(f.root, "siwc")), 0o700);
  assert.equal(await readFile(join(f.root, "siwc", "host.json"), "utf8"), "session");
});

// Image sign-in polls and cancels take the lock without a final confirmation, so the lock
// commands must never be where an older install's folder mode changes.
test("taking, resuming and releasing an operation lock leaves an existing 0755 folder's mode alone", posix, async t => {
  for (const lock of Object.values(VPS_OPERATION_LOCKS)) {
    const f = await fixture(t, { rootMode: 0o755 });
    await writeFile(join(f.root, ".managed-by-relmio-root"), SHARED_ROOT_MARKER_CONTENT, { mode: 0o644 });
    const held = await f.shell(createVpsLockCommand(lock));
    assert.equal(held.code, 0, lock);
    const identity = held.stdout.trim();
    assert.equal(await mode(join(f.parent, lock.slice("/docker/".length))), 0o700);
    assert.equal(await mode(f.root), 0o755, lock);
    const claim = await f.shell(claimVpsResumeLockCommand(lock, identity));
    assert.equal(claim.code, 0, lock);
    assert.equal(await mode(f.root), 0o755, lock);
    assert.equal(await f.run(releaseVpsResumeClaimCommand(lock, identity, claim.stdout.trim())), 0, lock);
    assert.equal(await f.run(releaseVpsLockCommand(lock, identity)), 0, lock);
    assert.equal(await mode(f.root), 0o755, lock);
  }
});

test("the confirmed tighten command sets an existing root-owned folder to 0700 and never creates one", posix, async t => {
  const existing = await fixture(t, { rootMode: 0o755 });
  await mkdir(join(existing.root, "siwc"), { mode: 0o700 });
  assert.equal(await existing.run(SHARED_ROOT_TIGHTEN_COMMAND), 0);
  assert.equal(await mode(existing.root), 0o700);
  assert.equal(await mode(join(existing.root, "siwc")), 0o700);
  assert.equal(await existing.run(SHARED_ROOT_TIGHTEN_COMMAND), 0);
  assert.equal(await mode(existing.root), 0o700);

  const absent = await fixture(t);
  assert.notEqual(await absent.run(SHARED_ROOT_TIGHTEN_COMMAND), 0);
  await assert.rejects(lstat(absent.root), { code: "ENOENT" });

  const writableParent = await fixture(t, { rootMode: 0o755 });
  await chmod(writableParent.parent, 0o775);
  assert.notEqual(await writableParent.run(SHARED_ROOT_TIGHTEN_COMMAND), 0);
  assert.equal(await mode(writableParent.root), 0o755);

  const foreign = await fixture(t, { rootMode: 0o755 });
  assert.notEqual(await foreign.run(SHARED_ROOT_TIGHTEN_COMMAND, { foreignOwner: foreign.root }), 0);
  assert.equal(await mode(foreign.root), 0o755);

  const groupWritable = await fixture(t, { rootMode: 0o775 });
  assert.notEqual(await groupWritable.run(SHARED_ROOT_TIGHTEN_COMMAND), 0);
  assert.equal(await mode(groupWritable.root), 0o775);

  const linked = await fixture(t);
  const elsewhere = join(linked.directory, "elsewhere");
  await mkdir(elsewhere, { mode: 0o755 });
  await chmod(elsewhere, 0o755);
  await symlink(elsewhere, linked.root);
  assert.notEqual(await linked.run(SHARED_ROOT_TIGHTEN_COMMAND), 0);
  assert.equal(await mode(elsewhere), 0o755);
});

test("the shared root command refuses a folder that is not root's own and leaves its mode alone", posix, async t => {
  const writableParent = await fixture(t, { rootMode: 0o755 });
  await chmod(writableParent.parent, 0o775);
  assert.notEqual(await writableParent.run(SHARED_ROOT_COMMAND), 0);
  assert.equal(await mode(writableParent.root), 0o755);

  const foreign = await fixture(t, { rootMode: 0o755 });
  assert.notEqual(await foreign.run(SHARED_ROOT_COMMAND, { foreignOwner: foreign.root }), 0);
  assert.equal(await mode(foreign.root), 0o755);

  const groupWritable = await fixture(t, { rootMode: 0o775 });
  assert.notEqual(await groupWritable.run(SHARED_ROOT_COMMAND), 0);
  assert.equal(await mode(groupWritable.root), 0o775);

  const linked = await fixture(t);
  const elsewhere = join(linked.directory, "elsewhere");
  await mkdir(elsewhere, { mode: 0o755 });
  await chmod(elsewhere, 0o755);
  await symlink(elsewhere, linked.root);
  assert.notEqual(await linked.run(SHARED_ROOT_COMMAND), 0);
  assert.equal(await mode(elsewhere), 0o755);

  const file = await fixture(t);
  await writeFile(file.root, "not a folder", { mode: 0o644 });
  assert.notEqual(await file.run(SHARED_ROOT_COMMAND), 0);
  assert.equal(await mode(file.root), 0o644);
});

test("the Assistant creates its own folder for root only and refuses one that is not", posix, async t => {
  let next = 1;
  const installation = createAssistantInstallation({ randomBytes: size => Buffer.alloc(size, next++), includeSearxng: false });
  const [shared, own] = createAssistantDeploymentCommands({ installation });
  assert.equal(shared, SHARED_ROOT_COMMAND);

  const fresh = await fixture(t);
  assert.equal(await fresh.run(shared), 0);
  assert.equal(await fresh.run(own), 0);
  const folder = join(fresh.root, "assistant-sandbox");
  assert.equal(await mode(folder), 0o700);
  assert.equal(await fresh.run(own), 0);

  await chmod(folder, 0o755);
  assert.notEqual(await fresh.run(own), 0);
  assert.equal(await mode(folder), 0o755);
  await chmod(folder, 0o700);
  assert.notEqual(await fresh.run(own, { foreignOwner: folder }), 0);

  const linked = await fixture(t, { rootMode: 0o700 });
  const elsewhere = join(linked.directory, "elsewhere");
  await mkdir(elsewhere, { mode: 0o700 });
  await symlink(elsewhere, join(linked.root, "assistant-sandbox"));
  assert.notEqual(await linked.run(own), 0);
});

// mkdir, install or chmod aimed at exactly Relmio's shared folder, with the mode it sets.
const sharedRootModes = command => [...command.matchAll(/\b(?:mkdir|install|chmod)\b[^;&|]*?\s(0?[0-7]{3})\s[^;&|]*?\/docker\/n8n-openai-oauth(?=[\s;&|)]|$)/gu)]
  .map(match => Number.parseInt(match[1], 8));
const modelessSharedRootMkdir = /\bmkdir\b(?![^;&|]*\s-m\s)[^;&|]*\s\/docker\/n8n-openai-oauth(?=[\s;&|)]|$)/u;

function assertRootOnly(commands, label) {
  for (const command of commands) {
    for (const bits of sharedRootModes(command)) assert.equal(bits & 0o077, 0, `${label}: ${command}`);
    assert.doesNotMatch(command, modelessSharedRootMkdir, label);
  }
}

// Records what a confirmed install sends up to its operation lock, which this remote refuses.
function probeRemote(answers = {}) {
  const calls = [];
  return { calls, async exec(command) {
    calls.push(command);
    if (command === PRECHECK_COMMAND) return { code: 0, stdout: "new\n" };
    for (const [start, stdout] of Object.entries(answers)) if (command.startsWith(start)) return { code: 0, stdout };
    if (command.startsWith(SHARED_ROOT_COMMAND)) return { code: 0, stdout: "" };
    return { code: 1, stdout: "" };
  } };
}

test("no generated VPS command creates or sets the shared folder with group or other permission bits", async () => {
  let next = 1;
  const installation = createAssistantInstallation({ randomBytes: size => Buffer.alloc(size, next++), includeSearxng: true });
  const identity = "11:22";
  assert.deepEqual(sharedRootModes(SHARED_ROOT_COMMAND), [0o700, 0o700]);
  assert.deepEqual(sharedRootModes(SHARED_ROOT_TIGHTEN_COMMAND), [0o700]);
  assertRootOnly([SHARED_ROOT_COMMAND, SHARED_ROOT_TIGHTEN_COMMAND, PRECHECK_COMMAND, ASSISTANT_PRECHECK_COMMAND,
    ...createDeploymentCommands(), ...Object.values(createVerificationCommands())], "ChatGPT sidecar");
  for (const startupScope of ["all", "searxng"]) {
    assertRootOnly(createAssistantDeploymentCommands({ installation, startupScope }), "Assistant");
  }
  // No lock command sets any mode on the shared folder: some lock takers have no final confirmation.
  for (const lock of Object.values(VPS_OPERATION_LOCKS)) {
    for (const command of [createVpsLockCommand(lock), inspectVpsResumeLockCommand(lock), claimVpsResumeLockCommand(lock, identity),
      releaseVpsResumeClaimCommand(lock, identity, identity), releaseVpsLockCommand(lock, identity),
      createVpsBuildStateCommand(lock, identity), cleanupVpsBuildStateCommand(lock, identity, identity)]) {
      assert.deepEqual(sharedRootModes(command), [], lock);
      assert.doesNotMatch(command, /\bchmod\b|\bchown\b/u, lock);
      assert.doesNotMatch(command, modelessSharedRootMkdir, lock);
    }
  }

  const grok = probeRemote();
  await assert.rejects(installVpsSuperGrok({ remote: grok, plan: { action: "install" }, confirmed: true }), /held or uncertain/u);
  const claude = probeRemote();
  await assert.rejects(applyVpsClaude({ remote: claude, confirmed: true, plan: { action: "install", models: ["claude-sonnet-5-5"],
    review: { officialBinaryReviewed: true, effectivePolicyReviewed: true, nativeAuthAndBillingReviewed: true, policyChangesControlled: true } } }),
  /held or uncertain/u);

  const containerId = "a".repeat(64);
  const networkId = "b".repeat(64);
  const selection = { containerName: "n8n-fixture", networkName: "private-net" };
  const model = probeRemote({
    "[ -d /docker ] && [ ! -L /docker ] && stat -c %u:%a /docker": "0:755",
    "[ -d /docker ] && [ ! -L /docker ] && [ ! -L /docker/n8n-openai-oauth ] && if [ ! -e /docker/n8n-openai-oauth/local-model ]": "absent",
    "docker ps -a --filter label=io.relmio.target=n8n-local-model": "",
    "docker volume ls --filter label=io.relmio.target=n8n-local-model": "",
    "docker inspect n8n-fixture": `${JSON.stringify(containerId)}|true|${JSON.stringify({ "private-net": { NetworkID: networkId } })}`,
    "docker network inspect private-net": JSON.stringify({ Id: networkId, Name: "private-net", Scope: "local", Driver: "bridge", Internal: false, Options: {}, Containers: {} }),
    "docker info ": `${16 * 1024 ** 3}|4|"/var/lib/docker"`,
    "df -B1 ": `Avail\n${50 * 1024 ** 3}\n`,
    "sed -n ": `${8 * 1024 ** 2}\n`,
  });
  const plan = await reviewVpsLocalModel({ remote: model, ...selection, action: "install", modelId: "qwen3:0.6b" });
  await assert.rejects(installVpsLocalModel({ remote: model, plan, confirmed: true }), /held or uncertain/u);

  for (const [label, remote] of [["SuperGrok", grok], ["Claude", claude], ["self-hosted model", model]]) {
    const rootWrites = remote.calls.filter(command => sharedRootModes(command).length > 0);
    // Only the folder command, which runs after the final confirmation was checked.
    assert.equal(rootWrites.length, 1, label);
    assert.ok(rootWrites[0].startsWith(SHARED_ROOT_COMMAND), label);
    assertRootOnly(remote.calls, label);
  }
});

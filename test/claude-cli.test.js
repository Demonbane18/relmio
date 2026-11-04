import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { spawn, spawnSync } from "node:child_process";
import { chmod, copyFile, link, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import { runClaudeCommand } from "../src/claude/command.js";
import { readKeyHashFile, runClaudeChat } from "../src/claude/launcher.js";
import { cliMode } from "../src/cli.js";

const effects = [];
const forbidden = (name) => async () => {
  effects.push(name);
  throw new Error(`command crossed into ${name}`);
};
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

async function workspace(t) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "relmio-claude-cli-")));
  t.after(async () => {
    try { await chmod(join(directory, "setup", "account", "empty"), 0o700); } catch { /* absent */ }
    try { await chmod(join(directory, "contaminated", "account", "empty"), 0o700); } catch { /* absent */ }
    await rm(directory, { force: true, recursive: true });
  });
  return directory;
}

function run(argumentsList, options = {}) {
  const output = [];
  const result = runClaudeCommand({
    argumentsList,
    log: (line) => output.push(line),
    isInteractive: () => true,
    ask: forbidden("ask"),
    startLauncher: forbidden("launch"),
    initLocal: forbidden("local init"),
    prepareLocal: forbidden("local prepare"),
    prepareCompanion: forbidden("companion prepare"),
    ...options,
  });
  return { result, output };
}

test("claude routing and arguments refuse unknown commands and overrides before any effect", async () => {
  assert.equal(cliMode(["claude", "serve"]), "claude");
  assert.equal(cliMode(["claude"]), "claude");
  for (const argumentsList of [
    [], ["serve", "extra"], ["serve", "--prompt", "secret"], ["serve", "--env", "ANTHROPIC_BASE_URL=x"],
    ["serve", "--upstream", "https://unexpected.invalid"], ["serve", "--model", "claude-opus-5-5"], ["serve", "--config"],
    ["local"], ["local", "init", "/tmp/x"], ["local", "init", "--claude", "/bin/claude"],
    ["local", "prepare", "/tmp/x"], ["local", "prepare", "/tmp/x", "--claude", "/bin/claude", "--env", "A=B"],
    ["companion", "prepare", "/tmp/x"], ["companion", "prepare", "--network", "proxy"],
    ["companion", "prepare", "/tmp/x", "/tmp/y", "--network", "proxy"],
    ["companion", "prepare", "/tmp/x", "--network", "proxy", "--port", "14502"],
    ["companion", "prepare", "/tmp/x", "--network", "--arch", "arm64"], ["companion"], ["login"],
  ]) {
    await assert.rejects(run(argumentsList).result, Error, JSON.stringify(argumentsList));
  }
  await assert.rejects(run(["serve"], { platform: "win32" }).result, Error);
  assert.equal(await run(["--help"], { platform: "win32" }).result, 0);
  assert.deepEqual(effects.splice(0), []);
});

test("serve gives explicit files precedence over the environment and passes only the launch pair", async (t) => {
  const directory = await workspace(t);
  const keyHashPath = join(directory, "key.sha256");
  const fileHash = sha256("synthetic-file-key");
  await writeFile(keyHashPath, `${fileHash}\n`, { mode: 0o600 });
  const env = {
    RELMIO_CLAUDE_LAUNCH_CONFIG: "/env/launch.json",
    RELMIO_CLAUDE_CHAT_TOKEN_SHA256: sha256("synthetic-env-key"),
    ANTHROPIC_API_KEY: "synthetic-inherited-api-secret",
  };
  const launches = [];
  const startLauncher = async (options) => { launches.push(options); return { origin: "http://127.0.0.1:14502" }; };

  assert.equal(await run(["serve", "--config", join(directory, "launch.json"), "--key-hash-file", keyHashPath],
    { env, startLauncher }).result, 0);
  assert.deepEqual(launches.at(-1).env, {
    RELMIO_CLAUDE_LAUNCH_CONFIG: join(directory, "launch.json"),
    RELMIO_CLAUDE_CHAT_TOKEN_SHA256: fileHash,
  });
  assert.deepEqual(launches.at(-1).argv, []);

  assert.equal(await run(["serve"], { env, startLauncher }).result, 0);
  assert.deepEqual(launches.at(-1).env, {
    RELMIO_CLAUDE_LAUNCH_CONFIG: env.RELMIO_CLAUDE_LAUNCH_CONFIG,
    RELMIO_CLAUDE_CHAT_TOKEN_SHA256: env.RELMIO_CLAUDE_CHAT_TOKEN_SHA256,
  });

  await assert.rejects(run(["serve", "--config", join(directory, "launch.json")], { env }).result, Error);
  await assert.rejects(run(["serve", "--key-hash-file", keyHashPath], { env }).result, Error);
  await chmod(keyHashPath, 0o644);
  await assert.rejects(run(["serve", "--config", join(directory, "launch.json"), "--key-hash-file", keyHashPath],
    { env }).result, { code: "launch_config_invalid" });
  assert.equal(launches.length, 2);
  assert.deepEqual(effects.splice(0), []);
});

test("local and companion prepare refuse without an interactive terminal before touching files", async (t) => {
  const root = await workspace(t);
  for (const argumentsList of [
    ["local", "prepare", join(root, "setup"), "--claude", "/bin/sh"],
    ["companion", "prepare", join(root, "bundle"), "--network", "proxy"],
  ]) {
    const { result } = run(argumentsList, { isInteractive: () => false, prepareLocal: undefined, prepareCompanion: undefined });
    assert.equal(await result, 1);
    await assert.rejects(lstat(argumentsList[2]), { code: "ENOENT" });
  }
  assert.deepEqual(effects.splice(0), []);
});

test("companion prepare refuses a bad network, unknown arch, Fable model and unsafe folder without writing", async (t) => {
  const root = await workspace(t);
  const out = join(root, "bundle");
  for (const options of [
    ["--network", "_proxy"], ["--network", "proxy net"], ["--network", `n${"a".repeat(128)}`], ["--network", "proxy;id"],
    ["--network", "proxy", "--arch", "x86_64"], ["--network", "proxy", "--arch", "AMD64"],
    ["--network", "proxy", "--model", "claude-fable-5-5"], ["--network", "proxy", "--model", "sonnet"],
  ]) {
    await assert.rejects(run(["companion", "prepare", out, ...options], { prepareCompanion: undefined }).result,
      Error, JSON.stringify(options));
    await assert.rejects(lstat(out), { code: "ENOENT" });
  }
  await mkdir(out, { mode: 0o700 });
  await writeFile(join(out, "keep.txt"), "owner file\n");
  await assert.rejects(run(["companion", "prepare", out, "--network", "proxy"], { prepareCompanion: undefined }).result, Error);
  assert.deepEqual(await readdir(out), ["keep.txt"]);
  const shared = join(root, "shared");
  await mkdir(shared, { mode: 0o755 });
  await chmod(shared, 0o755);
  await assert.rejects(run(["companion", "prepare", shared, "--network", "proxy"], { prepareCompanion: undefined }).result, Error);
  assert.deepEqual(await readdir(shared), []);
  assert.deepEqual(effects.splice(0), []);
});

test("companion prepare writes nothing, not even its folder, until every review item is confirmed", async (t) => {
  const root = await workspace(t);
  const out = join(root, "bundle");
  const prepare = (answers) => {
    const asked = [];
    const call = run(["companion", "prepare", out, "--network", "proxy"], {
      prepareCompanion: undefined,
      ask: async (question) => { asked.push(question); return answers.shift(); },
    });
    return { ...call, asked };
  };
  for (const answers of [["y", "y", "y", "n"], ["n"], ["yes", ""], [undefined], ["Y", "y", "no"]]) {
    const declined = prepare([...answers]);
    assert.equal(await declined.result, 1);
    assert.equal(declined.asked.length, answers.length);
    await assert.rejects(lstat(out), { code: "ENOENT" });
  }
  await mkdir(out, { mode: 0o700 });
  assert.equal(await prepare(["y", "n"]).result, 1);
  assert.deepEqual(await readdir(out), []);
});

test("companion prepare writes a private bundle whose image runs the packaged launcher with the verified pin", async (t) => {
  const root = await workspace(t);
  const out = join(root, "bundle");
  const models = ["claude-sonnet-5-5", "claude-haiku-5-5"];
  let asked = 0;
  const { result } = run(["companion", "prepare", out, "--network", "proxy", "--arch", "arm64",
    ...models.flatMap((model) => ["--model", model])], {
    prepareCompanion: undefined,
    ask: async () => { asked += 1; return "y"; },
  });
  assert.equal(await result, 0);
  assert.equal(asked, 4);
  assert.equal((await lstat(out)).mode & 0o777, 0o700);
  for (const file of [".env", "launch.json", "n8n-api-key.txt"]) {
    assert.equal((await lstat(join(out, file))).mode & 0o777, 0o600, file);
  }
  const key = (await readFile(join(out, "n8n-api-key.txt"), "utf8")).trim();
  const environment = await readFile(join(out, ".env"), "utf8");
  assert.equal(environment, `N8N_DOCKER_NETWORK=proxy\nRELMIO_CLAUDE_CHAT_TOKEN_SHA256=${sha256(key)}\n`);
  assert.equal(environment.includes(key), false);

  const config = JSON.parse(await readFile(join(out, "launch.json"), "utf8"));
  const dockerfile = await readFile(join(out, "Dockerfile"), "utf8");
  assert.equal(config.executableSha256, /^ARG CLAUDE_SHA256_ARM64=([a-f0-9]{64})$/mu.exec(dockerfile)[1]);
  assert.deepEqual(config.models, models);
  assert.deepEqual(config.qualification.runtime.models, models);
  const window = Date.parse(config.qualification.expiresAt) - Date.parse(config.qualification.reviewedAt);
  assert.ok(window > 0 && window <= 7 * 24 * 60 * 60 * 1000);

  const entry = /^CMD \["node", "([^"]+)"\]$/mu.exec(dockerfile)[1];
  assert.equal(await readFile(join(out, "app", entry), "utf8"), await readFile(resolve("src/claude/launcher.js"), "utf8"));
  assert.equal(await readFile(join(out, "app/src/gateway/claude-chat.js"), "utf8"),
    await readFile(resolve("src/gateway/claude-chat.js"), "utf8"));
  const bundled = await import(pathToFileURL(join(out, "app", entry)).href);
  assert.equal(typeof bundled.runClaudeChat, "function");
});

test("local init, owner answers and local prepare produce a launch the launcher accepts; refusals write nothing", async (t) => {
  const root = await workspace(t);
  const directory = join(root, "setup");
  // Synthetic inert bytes only; nothing executes this file.
  const executable = join(root, "claude-2.1.317");
  await writeFile(executable, "synthetic-native-candidate\n", { mode: 0o700 });
  const local = (argumentsList, answers = [], hours = []) => {
    const asked = [];
    const call = run(["local", argumentsList[0], directory, "--claude", executable, ...argumentsList.slice(1), ...hours], {
      initLocal: undefined,
      prepareLocal: undefined,
      ask: async (question) => { asked.push(question); return answers.shift(); },
    });
    return { ...call, asked };
  };

  await assert.rejects(local(["prepare"]).result, Error);
  await assert.rejects(lstat(directory), { code: "ENOENT" });
  assert.equal(await local(["init"]).result, 0);
  assert.equal((await lstat(directory)).mode & 0o777, 0o700);
  for (const [path, mode] of [["account", 0o700], ["account/config", 0o700], ["account/empty", 0o500]]) {
    assert.equal((await lstat(join(directory, path))).mode & 0o777, mode, path);
  }
  assert.deepEqual(await readdir(directory), ["account"]);

  for (const answers of [["y", "y", "y", "n"], ["n"], ["yes", ""], [undefined]]) {
    const declined = local(["prepare"], [...answers]);
    assert.equal(await declined.result, 1);
    assert.equal(declined.asked.length, answers.length);
    assert.deepEqual(await readdir(directory), ["account"]);
  }
  const tooLong = local(["prepare"], [], ["--hours", "169"]);
  await assert.rejects(tooLong.result, Error);
  assert.equal(tooLong.asked.length, 0);

  assert.equal(await local(["prepare"], ["y", "Y", "yes", "y"], ["--hours", "168"]).result, 0);
  for (const file of ["launch.json", "key.sha256", "n8n-api-key.txt"]) {
    assert.equal((await lstat(join(directory, file))).mode & 0o777, 0o600, file);
  }
  const key = (await readFile(join(directory, "n8n-api-key.txt"), "utf8")).trim();
  const keyHash = await readKeyHashFile(join(directory, "key.sha256"));
  assert.equal(keyHash, sha256(key));

  const captured = [];
  const app = await runClaudeChat({
    env: { RELMIO_CLAUDE_LAUNCH_CONFIG: join(directory, "launch.json"), RELMIO_CLAUDE_CHAT_TOKEN_SHA256: keyHash },
    signalTarget: new EventEmitter(),
    log: () => {},
    startGateway: async (options) => {
      captured.push(options);
      return { origin: "http://127.0.0.1:14502", close: async () => {} };
    },
  });
  await app.close();
  assert.equal(captured[0].runtime.executable, executable);
  assert.equal(captured[0].runtime.cwd, join(directory, "account", "empty"));
  assert.equal(captured[0].companionHost, undefined);

  const renewal = local(["prepare"], ["y", "y", "y", "y"]);
  assert.equal(await renewal.result, 0);
  assert.equal(await readKeyHashFile(join(directory, "key.sha256")), keyHash);
  assert.equal((await readFile(join(directory, "n8n-api-key.txt"), "utf8")).trim(), key);
  const renewed = JSON.parse(await readFile(join(directory, "launch.json"), "utf8"));
  assert.equal(Date.parse(renewed.qualification.expiresAt) - Date.parse(renewed.qualification.reviewedAt), 60 * 60 * 1000);

  await writeFile(join(directory, "unexpected.txt"), "owner file\n");
  await assert.rejects(local(["init"]).result, Error);
  await assert.rejects(local(["prepare"], ["y", "y", "y", "y"]).result, Error);
});

test("local init and prepare reject linked, shared, or nonempty account paths before writing", async (t) => {
  const root = await workspace(t);
  t.after(() => chmod(join(root, "contaminated", "account", "empty"), 0o700).catch(() => {}));
  const executable = join(root, "claude-2.1.317");
  await writeFile(executable, "synthetic-native-candidate\n", { mode: 0o700 });
  const attempt = (directory, command) => run(
    ["local", command, directory, "--claude", executable],
    { initLocal: undefined, prepareLocal: undefined, ask: async () => "y" },
  ).result;
  let caseId = 0;

  async function canary() {
    const outside = join(root, `outside-${caseId += 1}`);
    await mkdir(outside, { mode: 0o700 });
    const path = join(outside, "canary.txt");
    await writeFile(path, "untouched\n", { mode: 0o640 });
    return { outside, path, before: await lstat(path) };
  }

  async function unchanged(path, before) {
    const after = await lstat(path);
    assert.equal(after.ino, before.ino);
    assert.equal(after.mode, before.mode);
    assert.equal(await readFile(path, "utf8"), "untouched\n");
  }

  async function refuse(directory, label) {
    await assert.rejects(attempt(directory, "init"), Error, label);
    await assert.rejects(attempt(directory, "prepare"), Error, label);
    await assert.rejects(lstat(join(directory, "launch.json")), { code: "ENOENT" }, label);
    await assert.rejects(lstat(join(directory, "n8n-api-key.txt")), { code: "ENOENT" }, label);
  }

  const linkedAccount = join(root, "linked-account");
  await mkdir(linkedAccount, { mode: 0o700 });
  const accountCanary = await canary();
  await symlink(accountCanary.outside, join(linkedAccount, "account"));
  await refuse(linkedAccount, "account symlink");
  assert.deepEqual(await readdir(accountCanary.outside), ["canary.txt"]);
  await unchanged(accountCanary.path, accountCanary.before);

  const linkedConfig = join(root, "linked-config");
  await mkdir(linkedConfig, { mode: 0o700 });
  await mkdir(join(linkedConfig, "account"), { mode: 0o700 });
  const configCanary = await canary();
  await symlink(configCanary.outside, join(linkedConfig, "account", "config"));
  await refuse(linkedConfig, "config symlink");
  assert.deepEqual(await readdir(join(linkedConfig, "account")), ["config"]);
  assert.deepEqual(await readdir(configCanary.outside), ["canary.txt"]);
  await unchanged(configCanary.path, configCanary.before);

  const linkedEmpty = join(root, "linked-empty");
  await mkdir(linkedEmpty, { mode: 0o700 });
  await mkdir(join(linkedEmpty, "account"), { mode: 0o700 });
  await mkdir(join(linkedEmpty, "account", "config"), { mode: 0o700 });
  const emptyCanary = await canary();
  await symlink(emptyCanary.outside, join(linkedEmpty, "account", "empty"));
  await refuse(linkedEmpty, "empty symlink");
  assert.deepEqual(await readdir(emptyCanary.outside), ["canary.txt"]);
  await unchanged(emptyCanary.path, emptyCanary.before);

  const sharedAccount = join(root, "shared-account");
  await mkdir(sharedAccount, { mode: 0o700 });
  await mkdir(join(sharedAccount, "account"), { mode: 0o700 });
  await chmod(join(sharedAccount, "account"), 0o755);
  await refuse(sharedAccount, "shared account");
  assert.deepEqual(await readdir(join(sharedAccount, "account")), []);

  const sharedConfig = join(root, "shared-config");
  await mkdir(sharedConfig, { mode: 0o700 });
  await mkdir(join(sharedConfig, "account"), { mode: 0o700 });
  await mkdir(join(sharedConfig, "account", "config"), { mode: 0o700 });
  await chmod(join(sharedConfig, "account", "config"), 0o755);
  await refuse(sharedConfig, "shared config");
  assert.deepEqual(await readdir(join(sharedConfig, "account")), ["config"]);

  const sharedEmpty = join(root, "shared-empty");
  await mkdir(sharedEmpty, { mode: 0o700 });
  await mkdir(join(sharedEmpty, "account"), { mode: 0o700 });
  await mkdir(join(sharedEmpty, "account", "config"), { mode: 0o700 });
  await mkdir(join(sharedEmpty, "account", "empty"), { mode: 0o700 });
  await chmod(join(sharedEmpty, "account", "empty"), 0o755);
  await refuse(sharedEmpty, "shared empty");

  const writableEmpty = join(root, "writable-empty");
  await mkdir(writableEmpty, { mode: 0o700 });
  await mkdir(join(writableEmpty, "account"), { mode: 0o700 });
  await mkdir(join(writableEmpty, "account", "config"), { mode: 0o700 });
  await mkdir(join(writableEmpty, "account", "empty"), { mode: 0o700 });
  await refuse(writableEmpty, "writable empty");

  const contaminated = join(root, "contaminated");
  const cwd = join(contaminated, "account", "empty");
  await mkdir(contaminated, { mode: 0o700 });
  await mkdir(join(contaminated, "account"), { mode: 0o700 });
  await mkdir(join(contaminated, "account", "config"), { mode: 0o700 });
  await mkdir(cwd, { mode: 0o700 });
  await writeFile(join(cwd, "note.txt"), "contaminant\n");
  await chmod(cwd, 0o500);
  await refuse(contaminated, "contaminated cwd");
  assert.equal(await readFile(join(cwd, "note.txt"), "utf8"), "contaminant\n");
});

const RENEW_DRIVER = `
import json, os, pty, select, subprocess, sys, time
bundle, mode, *answers = sys.argv[1:]
env = os.environ.copy()
result_path = env["RENEW_RESULT"]

def save(code, output):
    with open(result_path, "w", encoding="utf-8") as handle:
        json.dump({"code": code, "output": output}, handle)

if mode == "pipe":
    proc = subprocess.run(["sh", "renew.sh"], cwd=bundle, env=env, input=b"y\\n", capture_output=True)
    save(proc.returncode, (proc.stdout + proc.stderr).decode(errors="replace"))
    raise SystemExit(0)

master, slave = pty.openpty()
if mode == "tty":
    proc = subprocess.Popen(["sh", "renew.sh"], cwd=bundle, env=env, stdin=slave, stdout=slave, stderr=slave)
else:
    proc = subprocess.Popen(
        ["sh", "renew.sh"], cwd=bundle, env=env, stdin=slave, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    )
os.close(slave)
if mode != "tty":
    out, err = proc.communicate(timeout=5)
    os.close(master)
    save(proc.returncode, ((out or b"") + (err or b"")).decode(errors="replace"))
    raise SystemExit(0)

collected = b""
pending = [(answer + "\\n").encode() for answer in answers]
buffer = b""
deadline = time.time() + 8
try:
    while time.time() < deadline:
        readable, _, _ = select.select([master], [], [], 0.2)
        if readable:
            try:
                chunk = os.read(master, 4096)
            except OSError:
                break
            if not chunk:
                break
            collected += chunk
            buffer += chunk
            while pending and b"[y/N]" in buffer:
                os.write(master, pending.pop(0))
                buffer = buffer.split(b"[y/N]", 1)[1]
        if proc.poll() is not None:
            break
finally:
    if proc.poll() is None:
        proc.kill()
    code = proc.wait(timeout=3)
    os.close(master)
save(code, collected.decode(errors="replace"))
`;

test("renew.sh requires a terminal and four yes answers, and does not follow launch links", async (t) => {
  const root = await workspace(t);
  const bundle = join(root, "bundle");
  const bin = join(root, "bin");
  await mkdir(bundle, { mode: 0o700 });
  await mkdir(bin, { mode: 0o700 });
  await copyFile(resolve("src/templates/claude-companion/renew.sh"), join(bundle, "renew.sh"));
  const python = spawnSync("python3", ["-c", "import sys; print(sys.executable)"], { encoding: "utf8" });
  assert.equal(python.status, 0);
  const realPython = python.stdout.trim();
  await writeFile(join(bin, "python3"), `#!/bin/sh
real="$RENEW_REAL_PYTHON"
if [ "\${1:-}" = "-" ]; then
  shift
  exec "$real" -c '
import os, sys
log = os.environ.get("RENEW_CHOWN_LOG")
real_fchown = os.fchown
def fchown(fd, uid, gid):
    if log:
        with open(log, "a", encoding="utf-8") as handle:
            handle.write("%s %s\\n" % (uid, gid))
        return None
    return real_fchown(fd, uid, gid)
os.fchown = fchown
code = sys.stdin.read()
sys.argv = ["-"] + sys.argv[1:]
exec(compile(code, "renew.py", "exec"))
' "$@"
fi
exec "$real" "$@"
`, { mode: 0o755 });
  await writeFile(join(bin, "docker"), `#!/bin/sh
printf '%s\\n' "$*" >> "$DOCKER_LOG"
if [ "$1" = "exec" ]; then
  printf '%s\\n' '{"loggedIn":true,"authMethod":"claude.ai","subscriptionType":"max"}'
  exit 0
fi
if [ "$1" = "compose" ]; then
  exit 0
fi
echo "unexpected docker invocation" >&2
exit 1
`, { mode: 0o755 });
  const launch = {
    schemaVersion: 2,
    accountRoot: "/data/account",
    executable: "/opt/claude/2.1.317/claude",
    executableSha256: "ab".repeat(32),
    version: "2.1.317",
    models: ["claude-haiku-5-5", "claude-sonnet-5-5"],
    companionHost: "relmio-claude",
    port: 14502,
    qualification: {
      reviewedBy: "owner",
      reviewedAt: "2020-01-01T00:00:00.000Z",
      expiresAt: "2020-01-02T00:00:00.000Z",
      officialBinaryReviewed: true,
      effectivePolicyReviewed: true,
      nativeAuthAndBillingReviewed: true,
      policyChangesControlled: true,
      runtime: { executable: "/opt/claude/2.1.317/claude", marker: "keep" },
    },
    untouched: "keep-me",
  };
  const launchPath = join(bundle, "launch.json");
  const original = `${JSON.stringify(launch, null, 2)}\n`;
  await writeFile(launchPath, original, { mode: 0o600 });
  await writeFile(join(bundle, "keep.txt"), "bundle-file\n", { mode: 0o600 });
  const dockerLog = join(root, "docker.log");
  const resultPath = join(root, "renew-result.json");
  const chownLog = join(root, "chown.log");
  const baseEnv = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    RENEW_REAL_PYTHON: realPython,
    RENEW_RESULT: resultPath,
    DOCKER_LOG: dockerLog,
  };
  delete baseEnv.RENEW_CHOWN_LOG;

  async function runRenew(mode, answers = [], extraEnv = {}) {
    await rm(dockerLog, { force: true });
    await rm(resultPath, { force: true });
    await writeFile(dockerLog, "");
    await new Promise((resolve, reject) => {
      const child = spawn(realPython, ["-c", RENEW_DRIVER, bundle, mode, ...answers], {
        env: { ...baseEnv, ...extraEnv },
        stdio: ["ignore", "pipe", "pipe"],
      });
      const err = [];
      child.stderr.on("data", (chunk) => err.push(chunk));
      const timer = setTimeout(() => child.kill("SIGKILL"), 12000);
      child.once("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.once("exit", (code) => {
        clearTimeout(timer);
        if (code !== 0) reject(new Error(`renew driver exited ${code}: ${Buffer.concat(err).toString("utf8")}`));
        else resolve();
      });
    });
    return {
      ...JSON.parse(await readFile(resultPath, "utf8")),
      docker: await readFile(dockerLog, "utf8"),
    };
  }

  async function fileSnap(path) {
    const metadata = await lstat(path);
    return { bytes: await readFile(path), mode: metadata.mode, ino: metadata.ino };
  }

  async function assertSnap(path, before, label) {
    const after = await lstat(path);
    assert.equal(after.mode, before.mode, label);
    assert.equal(after.ino, before.ino, label);
    assert.deepEqual(await readFile(path), before.bytes, label);
  }

  const piped = await runRenew("pipe");
  assert.notEqual(piped.code, 0);
  assert.equal((piped.output.match(/\[y\/N\]/g) ?? []).length, 0);
  assert.equal(piped.docker, "");
  assert.equal(await readFile(launchPath, "utf8"), original);

  const stdoutPipe = await runRenew("stdout-pipe");
  assert.notEqual(stdoutPipe.code, 0);
  assert.equal(stdoutPipe.docker, "");
  assert.equal(await readFile(launchPath, "utf8"), original);

  for (let declined = 0; declined < 4; declined += 1) {
    const answers = [...Array(declined).fill("y"), "n"];
    const result = await runRenew("tty", answers);
    assert.notEqual(result.code, 0, `declined question ${declined + 1}`);
    assert.equal((result.output.match(/\[y\/N\]/g) ?? []).length, answers.length, `declined question ${declined + 1}`);
    assert.equal(result.docker, "", `declined question ${declined + 1}`);
    assert.equal(await readFile(launchPath, "utf8"), original, `declined question ${declined + 1}`);
    assert.equal(await readFile(join(bundle, "keep.txt"), "utf8"), "bundle-file\n");
  }

  const outside = join(root, "outside-target");
  await writeFile(outside, "SECRET-BYTES\n", { mode: 0o640 });
  const outsideBefore = await fileSnap(outside);
  const nextPath = join(bundle, "launch.json.next");
  await symlink(outside, nextPath);
  const linked = await runRenew("tty", ["y", "y", "y", "y"]);
  assert.notEqual(linked.code, 0);
  await assertSnap(outside, outsideBefore, "next symlink target");
  assert.equal((await lstat(nextPath)).isSymbolicLink(), true);
  assert.equal(await readFile(launchPath, "utf8"), original);
  assert.equal(linked.docker.includes("compose restart"), false);

  await rm(nextPath);
  await link(outside, nextPath);
  const hardBefore = await fileSnap(outside);
  const hardLinked = await runRenew("tty", ["y", "y", "y", "y"]);
  assert.notEqual(hardLinked.code, 0);
  await assertSnap(outside, hardBefore, "next hardlink target");
  assert.equal(await readFile(launchPath, "utf8"), original);

  await rm(nextPath);
  await rm(launchPath);
  await symlink(outside, launchPath);
  const inputBefore = await fileSnap(outside);
  const inputLink = await runRenew("tty", ["y", "y", "y", "y"]);
  assert.notEqual(inputLink.code, 0);
  await assertSnap(outside, inputBefore, "input symlink target");
  assert.equal((await lstat(launchPath)).isSymbolicLink(), true);
  assert.equal(inputLink.docker, "");

  await rm(launchPath);
  await writeFile(launchPath, original, { mode: 0o600 });
  const renewedRun = await runRenew("tty", ["y", "y", "y", "y"], { RENEW_CHOWN_LOG: chownLog });
  assert.equal(renewedRun.code, 0, renewedRun.output);
  assert.equal((renewedRun.output.match(/\[y\/N\]/g) ?? []).length, 4);
  assert.match(renewedRun.docker, /^exec /u);
  assert.match(renewedRun.docker, /compose restart relmio-claude/u);
  assert.equal(await readFile(chownLog, "utf8"), "10001 10001\n");
  assert.equal((await lstat(launchPath)).mode & 0o777, 0o600);
  assert.equal((await lstat(launchPath)).nlink, 1);
  await assert.rejects(lstat(nextPath), { code: "ENOENT" });
  assert.equal(await readFile(join(bundle, "keep.txt"), "utf8"), "bundle-file\n");
  const renewed = JSON.parse(await readFile(launchPath, "utf8"));
  const withoutStamps = (config) => {
    const copy = structuredClone(config);
    delete copy.qualification.reviewedAt;
    delete copy.qualification.expiresAt;
    return copy;
  };
  assert.deepEqual(withoutStamps(renewed), withoutStamps(launch));
  const iso = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
  assert.match(renewed.qualification.reviewedAt, iso);
  assert.match(renewed.qualification.expiresAt, iso);
  assert.notEqual(renewed.qualification.reviewedAt, launch.qualification.reviewedAt);
  assert.notEqual(renewed.qualification.expiresAt, launch.qualification.expiresAt);
  const windowMs = Date.parse(renewed.qualification.expiresAt) - Date.parse(renewed.qualification.reviewedAt);
  assert.ok(windowMs > 0 && windowMs <= 7 * 24 * 60 * 60 * 1000);
  assert.ok(windowMs >= 7 * 24 * 60 * 60 * 1000 - 2 * 60 * 60 * 1000);
});

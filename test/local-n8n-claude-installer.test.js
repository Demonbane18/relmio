import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import baseTest from "node:test";
import { createLocalN8nClaudePlan, CLAUDE_REVIEW_FIELDS } from "../src/domain/local-n8n-claude.js";
import {
  installLocalN8nClaude, getLocalN8nClaudeStatus, changeLocalN8nClaude,
  inspectLocalN8nClaudeHost, attestLocalN8nClaudeInstallation, getLocalN8nClaudeAuthStatus,
  discoverLocalN8nClaudeModels,
} from "../src/services/local-n8n-claude-installer.js";
import { withTestLocalSecurity } from "./helpers/local-security.js";

// Local Claude is macOS and Linux only (owner decision). The fixtures below assert POSIX modes and installs are refused on Windows,
// so they are skipped there; the Windows refusal itself runs everywhere with an injected platform.
const test = (name, fn) => baseTest(name, { skip: process.platform === "win32" ? "Local Claude is macOS and Linux only" : false }, fn);

const HOST = "unix:///var/run/docker.sock";
const N8N = "a".repeat(64); const NETWORK = "b".repeat(64); const COMPANION = "c".repeat(64);
const IMAGE_ID = `sha256:${"d".repeat(64)}`;
const REVIEW = Object.fromEntries(CLAUDE_REVIEW_FIELDS.map(key => [key, true]));
const selection = { dockerHost: HOST, n8nContainerId: N8N, n8nContainerName: "fixture-n8n", dockerNetworkId: NETWORK, networkName: "fixture-shared" };
const plan = () => createLocalN8nClaudePlan({ ...selection, arch: "arm64" });
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
async function fixture(t, flags = {}) {
  const homeDirectory = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "relmio-claude-local-")));
  t.after(() => fs.rm(homeDirectory, { recursive: true, force: true }));
  const root = join(homeDirectory, ".relmio", "local", "n8n-claude-oauth");
  const calls = []; let image = false; let started = false; let volume = false;
  const marker = async () => JSON.parse(await fs.readFile(join(root, ".managed-by-relmio.json"), "utf8"));
  const labels = async () => ({ "com.relmio.managed": "claude-companion", "com.docker.compose.project": "relmio-claude", "com.docker.compose.service": "relmio-claude",
    "io.relmio.target": "n8n-claude-oauth", "io.relmio.managed": "true", "io.relmio.install": (await marker()).installId });
  const n8n = () => ({ Id: flags.changedN8n ? "f".repeat(64) : N8N, Name: "/fixture-n8n", State: { Running: true },
    NetworkSettings: { Networks: { "fixture-shared": { NetworkID: NETWORK, Aliases: ["fixture-n8n"] } } } });
  const container = async () => ({ Id: COMPANION, Name: "/relmio-claude", Image: IMAGE_ID,
    Config: { Image: "relmio-claude:2.1.317", User: "10001:10001", Labels: flags.manual ? { "com.relmio.managed": "claude-companion" } : await labels() },
    State: { Running: started && !flags.stopped }, HostConfig: { ReadonlyRootfs: true, CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges:true"], PortBindings: flags.published ? { "14502/tcp": [{}] } : {} },
    Mounts: [{ Type: "volume", Name: "relmio-claude_claude-account", Destination: "/data/account", RW: true },
      { Type: "bind", Source: join(root, "launch.json"), Destination: "/run/relmio/launch.json", RW: false }],
    NetworkSettings: { Ports: {}, Networks: { "fixture-shared": { NetworkID: NETWORK, Aliases: ["relmio-claude"] }, ...(flags.extraNetwork ? { other: {} } : {}) } } });
  const out = value => ({ code: 0, stdout: typeof value === "string" ? value : JSON.stringify(value), stderr: "" });
  const absent = () => ({ code: 1, stdout: "", stderr: "missing" });
  const runProcess = async spec => {
    calls.push(spec); const a = spec.args;
    // validateProcessSpec in src/infrastructure/local-process.js is not exported; this mirrors its timeout cap so a spec the real runner refuses fails here too.
    if (spec.timeoutMs !== undefined) assert.ok(Number.isInteger(spec.timeoutMs) && spec.timeoutMs >= 1 && spec.timeoutMs <= 600_000, "Local Docker process timeout is invalid.");
    assert.equal((await fs.stat(spec.cwd)).isDirectory(), true, "Docker cwd must already exist");
    if (a[0] === "context") return out(JSON.stringify(flags.remoteHost ? "tcp://example.test:2375" : HOST));
    if (a[0] === "info") return out(flags.arch ?? "aarch64\n");
    if (a[0] === "ps") return out([JSON.stringify({ ID: N8N }), ...((started || flags.manual) && !flags.missingContainer ? [JSON.stringify({ ID: COMPANION })] : [])].join("\n"));
    if (a[0] === "container" && a.at(-1) === N8N) return out(n8n());
    if (a[0] === "container" && a.at(-1) === COMPANION) return out(await container());
    if (a[0] === "network") return out({ Id: flags.changedNetwork ? "f".repeat(64) : NETWORK, Name: "fixture-shared", Driver: "bridge", Internal: false,
      Containers: { [N8N]: { Name: "fixture-n8n" }, ...(started ? { [COMPANION]: { Name: "relmio-claude" } } : {}) } });
    if (a[0] === "volume" && a[1] === "inspect") {
      if (flags.unlabeledVolume) return out({ Name: "relmio-claude_claude-account", Labels: {} });
      return volume || flags.orphanVolume ? out({ Name: "relmio-claude_claude-account", Labels: {
        "com.docker.compose.project": "relmio-claude", "com.docker.compose.volume": "claude-account",
        ...(volume && !flags.foreignVolume ? await labels() : {}),
      } }) : absent();
    }
    if (a[0] === "image" && a[1] === "inspect") return image && !flags.missingImage && !(flags.missingTag && a.at(-1) !== IMAGE_ID)
      ? out({ Id: IMAGE_ID, Config: { Labels: await labels() } }) : absent();
    if (a[0] === "image" && a[1] === "rm") { image = false; return out(""); }
    if (a[0] === "run") {
      if (flags.missingImage) return absent();
      if (a.includes("/bin/chown")) return flags.chownFails ? absent() : out("");
      if (flags.probeFails) return absent();
      if (flags.wrongHash) return out("0".repeat(64));
      return out(sha(await fs.readFile(join(root, "launch.json"))));
    }
    if (a[0] === "restart") { flags.stopped = false; return out(""); }
    if (a[0] === "exec" && a.includes("status")) return flags.signedOut
      ? { ...out({ loggedIn: false, authMethod: null, subscriptionType: null, token: "provider-secret" }), code: 1 }
      : out({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "pro", email: "private@example.test", token: "provider-secret" });
    if (a[0] === "exec" && a.includes("logout")) return out("provider-secret");
    if (a[0] === "exec" && a.at(-1).includes("/v1/models")) return out(["claude-sonnet-5-5"]);
    if (a[0] === "exec" && flags.healthProbeFails && String(a.at(-1)).includes("/health")) return absent();
    if (a[0] === "exec") return out("ok");
    if (a[0] === "compose") {
      if (a.includes("build")) {
        image = true;
        if (flags.buildFailureResource) {
          flags.manual = flags.buildFailureResource === "container";
          flags.foreignVolume = true; volume = true;
          return absent();
        }
        return flags.buildFailsAfterTag ? absent() : out("");
      }
      if (a.includes("up")) { started = true; volume = true; return out(""); }
      if (a.includes("down")) { started = false; if (a.includes("--volumes")) volume = false; return out(""); }
      if (a.includes("config")) return out("");
    }
    throw new Error(`Unexpected fixture Docker command: ${a.join(" ")}`);
  };
  const dependencies = withTestLocalSecurity({ homeDirectory, env: {}, runProcess, now: () => new Date("2026-11-05T00:00:00.000Z") });
  return { root, calls, flags, dependencies };
}

test("local Claude plan inspection is read-only and refuses a pre-existing non-wizard container", async t => {
  const f = await fixture(t);
  assert.deepEqual(await inspectLocalN8nClaudeHost(selection, f.dependencies), { arch: "arm64" });
  assert.equal(f.calls.some(spec => ["build", "up", "down", "run", "exec", "restart"].includes(spec.args[0])), false);
  await assert.rejects(() => fs.lstat(f.root), { code: "ENOENT" });
  const manual = await fixture(t, { manual: true });
  await assert.rejects(() => inspectLocalN8nClaudeHost(selection, manual.dependencies), /non-wizard/u);
  await assert.rejects(() => installLocalN8nClaude({ plan: plan(), confirmed: true, review: REVIEW }, manual.dependencies), /non-wizard/u);
  await assert.rejects(() => fs.lstat(manual.root), { code: "ENOENT" });
});

test("local Claude install, filtered status, renewal, sign-out and removal stay inside companion", async t => {
  const f = await fixture(t);
  const result = await installLocalN8nClaude({ plan: plan(), confirmed: true, review: REVIEW }, f.dependencies);
  assert.equal(result.endpoint, "http://relmio-claude:14502/v1");
  assert.match(result.clientKey, /^[A-Za-z0-9_-]{43}$/u);
  assert.equal((await fs.readFile(join(f.root, ".managed-by-relmio.json"), "utf8")).includes(result.clientKey), false);
  assert.equal((await fs.stat(join(f.root, "app/src/claude/launcher.js"))).mode & 0o777, 0o644);
  const installed = await attestLocalN8nClaudeInstallation({ installDirectory: f.root }, f.dependencies);
  assert.equal(installed.containerId, COMPANION);
  const before = f.calls.length;
  const status = await getLocalN8nClaudeStatus(f.dependencies);
  assert.equal(status.state, "healthy");
  assert.equal(JSON.stringify(status).includes(result.clientKey), false);
  assert.equal(f.calls.slice(before).some(spec => ["run", "exec", "up", "restart"].includes(spec.args[0])), false);
  assert.deepEqual(await getLocalN8nClaudeAuthStatus({}, f.dependencies), { loggedIn: true, authMethod: "claude.ai", subscriptionType: "pro" });
  f.flags.signedOut = true;
  assert.deepEqual(await getLocalN8nClaudeAuthStatus({}, f.dependencies), { loggedIn: false, authMethod: null, subscriptionType: null });
  f.flags.signedOut = false;
  assert.deepEqual(await discoverLocalN8nClaudeModels({ clientKey: result.clientKey }, f.dependencies), { models: ["claude-sonnet-5-5"] });
  const probe = f.calls.findLast(spec => spec.args[0] === "exec" && spec.args.at(-1).includes("/v1/models"));
  assert.equal(probe.input, result.clientKey);
  assert.equal(probe.args.join(" ").includes(result.clientKey), false);
  assert.deepEqual(await changeLocalN8nClaude({ action: "sign-out", confirmed: true }, f.dependencies), { target: result.target, changed: true });
  const renewal = await changeLocalN8nClaude({ action: "renew", confirmed: true, review: REVIEW }, { ...f.dependencies, now: () => new Date("2026-11-06T00:00:00.000Z") });
  assert.ok(Date.parse(renewal.expiresAt) > Date.parse(result.expiresAt));
  assert.deepEqual(f.calls.findLast(spec => spec.args[0] === "restart").args, ["restart", COMPANION]);
  assert.deepEqual(await changeLocalN8nClaude({ action: "remove", confirmed: true }, f.dependencies), { target: result.target, removed: true });
  await assert.rejects(() => fs.lstat(f.root), { code: "ENOENT" });
  assert.equal((await getLocalN8nClaudeStatus(f.dependencies)).state, "absent");
  assert.equal(f.calls.some(spec => spec.args.some(arg => ["stop", "restart", "rm"].includes(arg)) && spec.args.includes(N8N)), false);
});

test("Claude install fails when the ownership helper exits non-zero", async t => {
  const f = await fixture(t, { chownFails: true });
  await assert.rejects(() => installLocalN8nClaude({ plan: plan(), confirmed: true, review: REVIEW }, f.dependencies), /Docker operation failed/u);
  assert.equal(f.calls.some(spec => spec.args[0] === "compose" && spec.args.includes("up")), false);
});

test("a failed renewal restores the previous approval file and leaves the install manageable", async t => {
  const later = () => new Date("2026-11-06T00:00:00.000Z");
  for (const flag of ["chownFails", "probeFails", "wrongHash"]) {
    const f = await fixture(t);
    await installLocalN8nClaude({ plan: plan(), confirmed: true, review: REVIEW }, f.dependencies);
    const launch = join(f.root, "launch.json"); const markerPath = join(f.root, ".managed-by-relmio.json");
    const [before, markerBefore] = [await fs.readFile(launch), await fs.readFile(markerPath, "utf8")];
    const restarts = f.calls.filter(spec => spec.args[0] === "restart").length;
    f.flags[flag] = true;
    await assert.rejects(() => changeLocalN8nClaude({ action: "renew", confirmed: true, review: REVIEW }, { ...f.dependencies, now: later }), flag === "wrongHash" ? /unreadable or changed/u : /Docker operation failed/u, flag);
    assert.deepEqual(await fs.readFile(launch), before, flag);
    assert.equal(await fs.readFile(markerPath, "utf8"), markerBefore, flag);
    assert.equal(f.calls.filter(spec => spec.args[0] === "restart").length, restarts, flag);
    f.flags[flag] = false;
    await attestLocalN8nClaudeInstallation({ installDirectory: f.root }, f.dependencies);
    assert.deepEqual(await changeLocalN8nClaude({ action: "remove", confirmed: true }, f.dependencies), { target: "n8n-claude-oauth", removed: true }, flag);
  }
});

test("Claude rejects missing reviews, changed Docker identities, unsupported machines and unsafe files", async t => {
  const f = await fixture(t);
  await assert.rejects(() => installLocalN8nClaude({ plan: plan(), confirmed: false, review: REVIEW }, f.dependencies));
  await assert.rejects(() => installLocalN8nClaude({ plan: plan(), confirmed: true, review: {} }, f.dependencies));
  assert.equal(f.calls.length, 0);
  for (const flags of [{ changedN8n: true }, { changedNetwork: true }, { arch: "mips" }, { remoteHost: true }]) {
    const bad = await fixture(t, flags);
    await assert.rejects(() => installLocalN8nClaude({ plan: plan(), confirmed: true, review: REVIEW }, bad.dependencies));
    assert.equal(bad.calls.some(spec => spec.args[0] === "compose"), false);
  }
  await installLocalN8nClaude({ plan: plan(), confirmed: true, review: REVIEW }, f.dependencies);
  f.flags.stopped = true;
  assert.equal((await getLocalN8nClaudeStatus(f.dependencies)).state, "partial");
  await assert.rejects(() => changeLocalN8nClaude({ action: "renew", confirmed: true, review: {} }, f.dependencies));
  await fs.appendFile(join(f.root, "compose.yml"), "# changed\n");
  await assert.rejects(() => changeLocalN8nClaude({ action: "remove", confirmed: true }, f.dependencies), /files changed/u);
});

test("Claude refuses published ports and a second attached network", async t => {
  for (const flags of [{ published: true }, { extraNetwork: true }]) {
    const f = await fixture(t, flags);
    await assert.rejects(() => installLocalN8nClaude({ plan: plan(), confirmed: true, review: REVIEW }, f.dependencies), /safety attestation/u);
  }
});

test("a failed post-start health probe removes the companion and reports the original error", async t => {
  const f = await fixture(t, { healthProbeFails: true });
  await assert.rejects(() => installLocalN8nClaude({ plan: plan(), confirmed: true, review: REVIEW }, f.dependencies), /Local Claude Docker operation failed/u);
  await assert.rejects(() => fs.lstat(f.root), { code: "ENOENT" });
  assert.equal(f.calls.some(spec => spec.args.includes("down") && spec.args.includes("--volumes")), true);
  assert.equal(f.calls.some(spec => spec.args[0] === "image" && spec.args[1] === "rm"), true);
  assert.equal(f.calls.some(spec => spec.args.includes(N8N) && spec.args.some(arg => ["stop", "rm", "restart", "kill"].includes(arg))), false);
  assert.equal((await getLocalN8nClaudeStatus(f.dependencies)).state, "absent");
});

test("a labeled orphan login volume can be installed again and is kept", async t => {
  const f = await fixture(t, { orphanVolume: true });
  const result = await installLocalN8nClaude({ plan: plan(), confirmed: true, review: REVIEW }, f.dependencies);
  assert.match(result.clientKey, /^[A-Za-z0-9_-]{43}$/u);
  assert.equal(f.calls.some(spec => spec.args[0] === "volume" && spec.args[1] === "rm"), false);
  assert.equal(f.calls.some(spec => spec.args.includes("--volumes")), false);
  assert.equal((await getLocalN8nClaudeStatus(f.dependencies)).state, "healthy");
});

test("a failed install that reuses a labeled login volume keeps the volume", async t => {
  const f = await fixture(t, { orphanVolume: true, healthProbeFails: true });
  await assert.rejects(() => installLocalN8nClaude({ plan: plan(), confirmed: true, review: REVIEW }, f.dependencies), /Local Claude Docker operation failed/u);
  const down = f.calls.filter(spec => spec.args[0] === "compose" && spec.args.includes("down"));
  assert.equal(down.length, 1);
  assert.equal(down[0].args.includes("--volumes"), false);
  assert.equal(f.calls.some(spec => spec.args[0] === "volume" && spec.args[1] === "rm"), false);
  await assert.rejects(() => fs.lstat(f.root), { code: "ENOENT" });
});

test("a build that tagged the image and then failed still has its image removed", async t => {
  const f = await fixture(t, { buildFailsAfterTag: true });
  await assert.rejects(() => installLocalN8nClaude({ plan: plan(), confirmed: true, review: REVIEW }, f.dependencies), /Local Claude Docker operation failed/u);
  assert.equal(f.calls.some(spec => spec.args[0] === "image" && spec.args[1] === "rm"), true);
  await assert.rejects(() => fs.lstat(f.root), { code: "ENOENT" });
});

test("an unlabeled leftover login volume is refused and nothing is written", async t => {
  const f = await fixture(t, { unlabeledVolume: true });
  await assert.rejects(() => installLocalN8nClaude({ plan: plan(), confirmed: true, review: REVIEW }, f.dependencies), /unowned Claude login volume/u);
  assert.equal(f.calls.some(spec => spec.args[0] === "compose"), false);
  await assert.rejects(() => fs.lstat(f.root), { code: "ENOENT" });
});

test("rollback refuses a companion or login volume that appeared during the build", async t => {
  for (const buildFailureResource of ["container", "volume"]) {
    const f = await fixture(t, { buildFailureResource });
    await assert.rejects(() => installLocalN8nClaude({ plan: plan(), confirmed: true, review: REVIEW }, f.dependencies), /cleanup could not be confirmed/u);
    assert.equal(f.calls.some(spec => spec.args[0] === "compose" && spec.args.includes("down")), false, buildFailureResource);
    assert.equal(f.calls.some(spec => spec.args[0] === "volume" && spec.args[1] === "rm"), false, buildFailureResource);
    assert.equal((await fs.lstat(f.root)).isDirectory(), true);
  }
});

test("removal tolerates a pruned image but still rejects changed files and an existing changed launch file", async t => {
  const f = await fixture(t);
  await installLocalN8nClaude({ plan: plan(), confirmed: true, review: REVIEW }, f.dependencies);
  await fs.appendFile(join(f.root, "launch.json"), " ");
  await assert.rejects(() => changeLocalN8nClaude({ action: "remove", confirmed: true }, f.dependencies), /unreadable or changed/u);
  f.flags.missingTag = true;
  await assert.rejects(() => changeLocalN8nClaude({ action: "remove", confirmed: true }, f.dependencies), /unreadable or changed/u);
  f.flags.missingImage = true;
  f.flags.missingContainer = true;
  await assert.rejects(() => changeLocalN8nClaude({ action: "renew", confirmed: true, review: REVIEW }, f.dependencies), /Docker operation failed/u);
  await assert.rejects(() => changeLocalN8nClaude({ action: "sign-out", confirmed: true }, f.dependencies), /Docker operation failed/u);
  await fs.appendFile(join(f.root, "compose.yml"), "# changed\n");
  await assert.rejects(() => changeLocalN8nClaude({ action: "remove", confirmed: true }, f.dependencies), /files changed/u);
  const compose = await fs.readFile(join(f.root, "compose.yml"), "utf8");
  await fs.writeFile(join(f.root, "compose.yml"), compose.slice(0, -"# changed\n".length));
  const before = f.calls.length;
  assert.deepEqual(await changeLocalN8nClaude({ action: "remove", confirmed: true }, f.dependencies), { target: "n8n-claude-oauth", removed: true });
  assert.equal(f.calls.slice(before).some(spec => spec.args[0] === "run"), false);
  await assert.rejects(() => fs.lstat(f.root), { code: "ENOENT" });
});

test("renewal starts a stopped companion but refuses sign-out or renewal of a missing companion", async t => {
  const f = await fixture(t);
  const installed = await installLocalN8nClaude({ plan: plan(), confirmed: true, review: REVIEW }, f.dependencies);
  f.flags.stopped = true;
  await assert.rejects(() => changeLocalN8nClaude({ action: "sign-out", confirmed: true }, f.dependencies), /safety attestation/u);
  const renewed = await changeLocalN8nClaude({ action: "renew", confirmed: true, review: REVIEW },
    { ...f.dependencies, now: () => new Date("2026-11-06T00:00:00.000Z") });
  assert.ok(Date.parse(renewed.expiresAt) > Date.parse(installed.expiresAt));
  assert.equal((await getLocalN8nClaudeStatus(f.dependencies)).state, "healthy");
  f.flags.missingContainer = true;
  const before = await fs.readFile(join(f.root, "launch.json"), "utf8");
  const restarts = f.calls.filter(spec => spec.args[0] === "restart").length;
  await assert.rejects(() => changeLocalN8nClaude({ action: "renew", confirmed: true, review: REVIEW }, f.dependencies), /missing/u);
  assert.equal(await fs.readFile(join(f.root, "launch.json"), "utf8"), before);
  assert.equal(f.calls.filter(spec => spec.args[0] === "restart").length, restarts);
});

test("local application directories stay traversable under a restrictive umask", async t => {
  const f = await fixture(t);
  const old = process.umask(0o077);
  try {
    await installLocalN8nClaude({ plan: plan(), confirmed: true, review: REVIEW }, f.dependencies);
    for (const path of ["app", "app/src", "app/src/gateway", "app/src/claude"]) {
      assert.equal((await fs.stat(join(f.root, path))).mode & 0o777, 0o755, path);
    }
  } finally { process.umask(old); }
});

baseTest("Windows refuses local Claude before any Docker call, lock or write", async t => {
  const home = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "relmio-claude-win-")));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const dependencies = withTestLocalSecurity({ homeDirectory: home, env: {}, platform: "win32",
    runProcess: async () => assert.fail("Windows must not reach Docker") });
  const refused = /needs macOS or Linux/u;
  await assert.rejects(() => inspectLocalN8nClaudeHost(selection, dependencies), refused);
  await assert.rejects(() => installLocalN8nClaude({ plan: plan(), confirmed: true, review: REVIEW }, dependencies), refused);
  for (const action of ["renew", "sign-out", "remove"]) {
    await assert.rejects(() => changeLocalN8nClaude({ action, confirmed: true, review: REVIEW }, dependencies), refused);
  }
  assert.deepEqual(await fs.readdir(home), []);
});

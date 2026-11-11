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
import { startIsolatedWizard } from "./helpers/siwc-wizard.js";

// Local Claude is macOS and Linux only (owner decision). The fixtures below assert POSIX modes and installs are refused on Windows,
// so they are skipped there; the Windows refusal itself runs everywhere with an injected platform.
const test = (name, fn) => baseTest(name, { skip: process.platform === "win32" ? "Local Claude is macOS and Linux only" : false }, fn);

const HOST = "unix:///var/run/docker.sock";
const N8N = "a".repeat(64); const NETWORK = "b".repeat(64); const COMPANION = "c".repeat(64); const MANUAL_PROJECT = "9".repeat(64);
// Other containers on the same Docker host. The first few are near misses of the companion's name and project and must be left alone.
const NEAR_MISSES = ["relmio-claude-2", "my-relmio-claude", "relmio-claudex", "xrelmio-claude"];
const unrelatedContainer = index => ({ id: (index + 1).toString(16).padStart(64, "0"), name: NEAR_MISSES[index] ?? `unrelated-${index}`,
  labels: { "com.docker.compose.project": index === 0 ? "relmio-claude-other" : `project-${index}` } });
const IMAGE_ID = `sha256:${"d".repeat(64)}`;
const REVIEW = Object.fromEntries(CLAUDE_REVIEW_FIELDS.map(key => [key, true]));
const selection = { dockerHost: HOST, n8nContainerId: N8N, n8nContainerName: "fixture-n8n", dockerNetworkId: NETWORK, networkName: "fixture-shared" };
const plan = () => createLocalN8nClaudePlan({ ...selection, arch: "arm64" });
const sha = bytes => createHash("sha256").update(bytes).digest("hex");
async function fixture(t, flags = {}) {
  const homeDirectory = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "relmio-claude-local-")));
  t.after(() => fs.rm(homeDirectory, { recursive: true, force: true }));
  const root = join(homeDirectory, ".relmio", "local", "n8n-claude-oauth");
  const calls = []; let image = false; let started = false;
  let volume = flags.orphanVolume || flags.unlabeledVolume ? { installId: null, loginData: null } : null;
  const marker = async () => JSON.parse(await fs.readFile(join(root, ".managed-by-relmio.json"), "utf8"));
  const labels = async () => ({ "com.relmio.managed": "claude-companion", "com.docker.compose.project": "relmio-claude", "com.docker.compose.service": "relmio-claude",
    "io.relmio.target": "n8n-claude-oauth", "io.relmio.managed": "true", "io.relmio.install": (await marker()).installId });
  const n8n = () => ({ Id: flags.changedN8n ? "f".repeat(64) : N8N, Name: "/fixture-n8n", State: { Running: true },
    NetworkSettings: { Networks: { "fixture-shared": { NetworkID: NETWORK, Aliases: ["fixture-n8n"] } } } });
  const container = async () => ({ Id: COMPANION, Name: "/relmio-claude", Image: IMAGE_ID,
    Config: { Image: "relmio-claude:2.1.317", User: "10001:10001", Labels: flags.manual ? { "com.relmio.managed": "claude-companion" } : await labels() },
    State: flags.restarting ? { Status: "restarting", Running: true, Restarting: true, Health: { Status: "unhealthy" } }
      : started && !flags.stopped ? { Status: "running", Running: true, Restarting: false, Health: { Status: flags.health ?? "healthy" } }
        : { Status: "exited", Running: false, Restarting: false },
    HostConfig: { ReadonlyRootfs: true, CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges:true"], PortBindings: flags.published ? { "14502/tcp": [{}] } : {} },
    Mounts: [{ Type: "volume", Name: "relmio-claude_claude-account", Destination: "/data/account", RW: true },
      { Type: "bind", Source: join(root, "launch.json"), Destination: "/run/relmio/launch.json", RW: false }],
    NetworkSettings: { Ports: {}, Networks: { "fixture-shared": { NetworkID: NETWORK, Aliases: ["relmio-claude"] }, ...(flags.extraNetwork ? { other: {} } : {}) } } });
  // Every container the fake Docker host has: n8n, the companion once it exists, a manual Compose project and unrelated ones.
  const inventory = async () => [
    { id: N8N, name: "fixture-n8n", labels: {} },
    ...((started || flags.manual) && !flags.missingContainer ? [{ id: COMPANION, name: "relmio-claude", labels: (await container()).Config.Labels }] : []),
    ...(flags.manualProject ? [{ id: MANUAL_PROJECT, name: "relmio-claude-app-1", labels: { "com.docker.compose.project": "relmio-claude" } }] : []),
    ...Array.from({ length: flags.unrelated ?? 0 }, (_, index) => unrelatedContainer(index)),
  ];
  // Docker applies a name filter as a regular expression to the name with and without its leading slash, and a label filter exactly.
  const listed = (item, filter) => {
    if (filter.startsWith("name=")) return [`/${item.name}`, item.name].some(name => new RegExp(filter.slice(5), "u").test(name));
    assert.ok(filter.startsWith("label="), `Unexpected fixture Docker filter: ${filter}`);
    const separator = filter.indexOf("=", 6);
    return item.labels[filter.slice(6, separator)] === filter.slice(separator + 1);
  };
  const out = value => ({ code: 0, stdout: typeof value === "string" ? value : JSON.stringify(value), stderr: "" });
  const absent = () => ({ code: 1, stdout: "", stderr: "missing" });
  const runProcess = async spec => {
    calls.push(spec); const a = spec.args;
    // validateProcessSpec in src/infrastructure/local-process.js is not exported; this mirrors its timeout cap so a spec the real runner refuses fails here too.
    if (spec.timeoutMs !== undefined) assert.ok(Number.isInteger(spec.timeoutMs) && spec.timeoutMs >= 1 && spec.timeoutMs <= 600_000, "Local Docker process timeout is invalid.");
    assert.ok(a.every(arg => typeof arg === "string"), "Local Docker process arguments must be strings.");
    assert.equal((await fs.stat(spec.cwd)).isDirectory(), true, "Docker cwd must already exist");
    if (a[0] === "context") return out(JSON.stringify(flags.remoteHost ? "tcp://example.test:2375" : HOST));
    if (a[0] === "info") return out(flags.arch ?? "aarch64\n");
    if (a[0] === "ps") {
      const filters = a.flatMap((arg, index) => arg === "--filter" ? [a[index + 1]] : []);
      return out((await inventory()).filter(item => filters.every(filter => listed(item, filter))).map(item => JSON.stringify({ ID: item.id })).join("\n"));
    }
    if (a[0] === "container" && a.at(-1) === N8N) return out(n8n());
    if (a[0] === "container" && a.at(-1) === COMPANION) return out(await container());
    if (a[0] === "container") {
      const other = (await inventory()).find(item => item.id === a.at(-1));
      if (other) return out({ Id: other.id, Name: `/${other.name}`, Config: { Labels: other.labels }, State: { Status: "running", Running: true } });
    }
    if (a[0] === "network") return out({ Id: flags.changedNetwork ? "f".repeat(64) : NETWORK, Name: "fixture-shared", Driver: "bridge", Internal: false,
      Containers: { [N8N]: { Name: "fixture-n8n" }, ...(started ? { [COMPANION]: { Name: "relmio-claude" } } : {}) } });
    if (a[0] === "volume" && a[1] === "inspect") {
      if (!volume) return absent();
      if (flags.unlabeledVolume) return out({ Name: "relmio-claude_claude-account", Labels: {} });
      // A volume keeps the labels of the install that created it, also after that install is removed.
      return out({ Name: "relmio-claude_claude-account", Labels: {
        "com.docker.compose.project": "relmio-claude", "com.docker.compose.volume": "claude-account",
        ...(volume.installId && !flags.foreignVolume ? { "io.relmio.target": "n8n-claude-oauth", "io.relmio.managed": "true", "io.relmio.install": volume.installId } : {}),
      } });
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
          flags.foreignVolume = true; volume = { installId: null, loginData: null };
          return absent();
        }
        return flags.buildFailsAfterTag ? absent() : out("");
      }
      if (a.includes("up")) {
        volume ??= { installId: (await marker()).installId, loginData: null };
        started = true; return out("");
      }
      if (a.includes("down")) { started = false; if (a.includes("--volumes")) volume = null; return out(""); }
      if (a.includes("config")) return out("");
    }
    throw new Error(`Unexpected fixture Docker command: ${a.join(" ")}`);
  };
  const dependencies = withTestLocalSecurity({ homeDirectory, env: {}, runProcess, now: () => new Date("2026-11-05T00:00:00.000Z") });
  return { root, calls, flags, dependencies, get volume() { return volume; } };
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
  assert.deepEqual(await changeLocalN8nClaude({ action: "remove", confirmed: true }, f.dependencies), { target: result.target, removed: true, loginKept: false });
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
    assert.deepEqual(await changeLocalN8nClaude({ action: "remove", confirmed: true }, f.dependencies), { target: "n8n-claude-oauth", removed: true, loginKept: false }, flag);
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
  assert.deepEqual(await changeLocalN8nClaude({ action: "remove", confirmed: true }, f.dependencies), { target: "n8n-claude-oauth", removed: true, loginKept: false });
  assert.equal(f.calls.slice(before).some(spec => spec.args[0] === "run"), false);
  await assert.rejects(() => fs.lstat(f.root), { code: "ENOENT" });
});

test("removal works for an install interrupted before its image was recorded", async t => {
  const f = await fixture(t);
  await installLocalN8nClaude({ plan: plan(), confirmed: true, review: REVIEW }, f.dependencies);
  const markerPath = join(f.root, ".managed-by-relmio.json");
  const marker = JSON.parse(await fs.readFile(markerPath, "utf8"));
  await fs.writeFile(markerPath, `${JSON.stringify({ ...marker, imageId: null })}\n`, { mode: 0o600 });
  f.flags.missingImage = true;
  f.flags.missingContainer = true;
  assert.deepEqual(await changeLocalN8nClaude({ action: "remove", confirmed: true }, f.dependencies), { target: "n8n-claude-oauth", removed: true, loginKept: false });
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

test("status lists and inspects only companion candidates, however many other containers the host has", async t => {
  const counts = [];
  for (const unrelated of [2, 150]) {
    const f = await fixture(t, { unrelated });
    assert.deepEqual(await inspectLocalN8nClaudeHost(selection, f.dependencies), { arch: "arm64" });
    await installLocalN8nClaude({ plan: plan(), confirmed: true, review: REVIEW }, f.dependencies);
    const before = f.calls.length;
    assert.equal((await getLocalN8nClaudeStatus(f.dependencies)).state, "healthy");
    const status = f.calls.slice(before);
    counts.push(status.length);
    assert.deepEqual(status.filter(spec => spec.args[0] === "container").map(spec => spec.args.at(-1)), [COMPANION]);
    assert.equal((await getLocalN8nClaudeAuthStatus({}, f.dependencies)).loggedIn, true);
    assert.equal(f.calls.some(spec => spec.args[0] === "container" && ![N8N, COMPANION].includes(spec.args.at(-1))), false);
  }
  assert.equal(counts[0], counts[1]);
  assert.ok(counts[0] <= 6, `one status check ran ${counts[0]} Docker commands`);
});

test("a manual relmio-claude container or Compose project is refused among many unrelated containers", async t => {
  for (const flags of [{ manual: true }, { manualProject: true }]) {
    const f = await fixture(t, { ...flags, unrelated: 150 });
    await assert.rejects(() => inspectLocalN8nClaudeHost(selection, f.dependencies), /non-wizard/u);
    await assert.rejects(() => installLocalN8nClaude({ plan: plan(), confirmed: true, review: REVIEW }, f.dependencies), /non-wizard/u);
    await assert.rejects(() => fs.lstat(f.root), { code: "ENOENT" });
    assert.equal(f.calls.some(spec => ["compose", "run", "exec"].includes(spec.args[0])), false);
  }
  // A foreign project container that appears next to an installed companion blocks status and every change.
  const f = await fixture(t, { unrelated: 150 });
  await installLocalN8nClaude({ plan: plan(), confirmed: true, review: REVIEW }, f.dependencies);
  f.flags.manualProject = true;
  assert.equal((await getLocalN8nClaudeStatus(f.dependencies)).state, "unavailable");
  await assert.rejects(() => changeLocalN8nClaude({ action: "remove", confirmed: true }, f.dependencies), /non-wizard/u);
  assert.equal((await fs.lstat(f.root)).isDirectory(), true);
});

test("status reports the Docker runtime and is healthy only while the companion is running", async t => {
  // Docker's first health check runs a minute after start, so an install and a renewal succeed while health is still starting.
  const f = await fixture(t, { health: "starting" });
  const installed = await installLocalN8nClaude({ plan: plan(), confirmed: true, review: REVIEW }, f.dependencies);
  assert.equal(installed.deploymentMode, "installed");
  const read = async () => { const status = await getLocalN8nClaudeStatus(f.dependencies); return [status.state, status.snapshot.runtime]; };
  assert.deepEqual(await read(), ["partial", "starting"]);
  assert.equal((await getLocalN8nClaudeAuthStatus({}, f.dependencies)).loggedIn, true);
  const renewed = await changeLocalN8nClaude({ action: "renew", confirmed: true, review: REVIEW },
    { ...f.dependencies, now: () => new Date("2026-11-06T00:00:00.000Z") });
  assert.equal(renewed.changed, true);
  f.flags.health = "healthy";
  assert.deepEqual(await read(), ["healthy", "running"]);
  f.flags.health = "unhealthy";
  assert.deepEqual(await read(), ["partial", "unhealthy"]);
  // Docker keeps Running true for a container in a restart loop.
  f.flags.restarting = true;
  assert.deepEqual(await read(), ["partial", "restarting"]);
  f.flags.restarting = false; f.flags.stopped = true;
  assert.deepEqual(await read(), ["partial", "stopped"]);
  f.flags.missingContainer = true;
  assert.deepEqual(await read(), ["partial", "stopped"]);
});

test("removal can keep the Claude sign-in volume, and a later install reuses it", async t => {
  const f = await fixture(t);
  await installLocalN8nClaude({ plan: plan(), confirmed: true, review: REVIEW }, f.dependencies);
  const loginVolume = f.volume;
  assert.ok(loginVolume);
  loginVolume.loginData = "synthetic-claude-login";
  for (const request of [{ action: "sign-out", keepLogin: true }, { action: "renew", review: REVIEW, keepLogin: true }, { action: "remove", keepLogin: "yes" }]) {
    const before = f.calls.length;
    await assert.rejects(() => changeLocalN8nClaude({ ...request, confirmed: true }, f.dependencies), /action is invalid/u);
    assert.equal(f.calls.length, before);
  }
  // A companion that keeps restarting can still be removed, and only its labeled login volume is left.
  f.flags.restarting = true;
  assert.deepEqual(await changeLocalN8nClaude({ action: "remove", confirmed: true, keepLogin: true }, f.dependencies),
    { target: "n8n-claude-oauth", removed: true, loginKept: true });
  assert.equal(f.calls.some(spec => spec.args.includes("--volumes") || (spec.args[0] === "volume" && spec.args[1] === "rm")), false);
  assert.equal(f.volume, loginVolume, "keepLogin must retain the original volume");
  assert.equal(f.volume.loginData, "synthetic-claude-login");
  assert.equal(f.calls.some(spec => spec.args[0] === "image" && spec.args[1] === "rm"), true);
  await assert.rejects(() => fs.lstat(f.root), { code: "ENOENT" });
  assert.equal((await getLocalN8nClaudeStatus(f.dependencies)).state, "absent");
  f.flags.restarting = false;
  const again = await installLocalN8nClaude({ plan: plan(), confirmed: true, review: REVIEW }, f.dependencies);
  assert.match(again.clientKey, /^[A-Za-z0-9_-]{43}$/u);
  assert.equal((await getLocalN8nClaudeStatus(f.dependencies)).state, "healthy");
  assert.equal(f.volume, loginVolume, "reinstall must reuse the original volume");
  assert.equal(f.volume.loginData, "synthetic-claude-login", "reinstall must preserve saved login data");
  assert.equal(f.calls.some(spec => spec.args.includes("--volumes") || (spec.args[0] === "volume" && spec.args[1] === "rm")), false);
  assert.deepEqual(await changeLocalN8nClaude({ action: "remove", confirmed: true }, f.dependencies),
    { target: "n8n-claude-oauth", removed: true, loginKept: false });
  assert.equal(f.calls.some(spec => spec.args.includes("--volumes")), true);
  assert.equal(f.volume, null, "default removal must delete the login volume");
});

test("a failed or unstartable Docker step is a server failure, while refusals stay plain errors", async t => {
  const failed = await fixture(t, { chownFails: true });
  await assert.rejects(() => installLocalN8nClaude({ plan: plan(), confirmed: true, review: REVIEW }, failed.dependencies),
    error => error.statusCode === 500 && error.message === "Local Claude Docker operation failed.");
  const timedOut = await fixture(t);
  const runProcess = timedOut.dependencies.runProcess;
  await assert.rejects(() => installLocalN8nClaude({ plan: plan(), confirmed: true, review: REVIEW }, { ...timedOut.dependencies,
    runProcess: async spec => { if (spec.args.includes("build")) throw new Error("The local Docker process timed out."); return runProcess(spec); } }),
    error => error.statusCode === 500 && error.message === "The local Docker process timed out.");
  await assert.rejects(() => fs.lstat(timedOut.root), { code: "ENOENT" });
  const refused = await fixture(t, { manual: true });
  await assert.rejects(() => installLocalN8nClaude({ plan: plan(), confirmed: true, review: REVIEW }, refused.dependencies),
    error => error.statusCode === undefined && /non-wizard/u.test(error.message));
  await assert.rejects(() => installLocalN8nClaude({ plan: plan(), confirmed: false, review: REVIEW }, refused.dependencies),
    error => error.statusCode === undefined);
});

test("the install route answers a failed Docker step with 500 and a refusal with its own readable 400", async t => {
  const f = await fixture(t, { chownFails: true });
  const token = "local-claude-installer-route-token-1234567890";
  const wizard = await startIsolatedWizard({ sessionToken: token, uiFiles: { "/": "", "/local": "" }, services: {
    discoverLocalN8nSidecarTargets: async () => ({ dockerAvailable: true, dockerHost: HOST, containers: [{
      containerId: N8N, containerName: "fixture-n8n", image: "n8nio/n8n:fixture", networks: [{ dockerNetworkId: NETWORK, networkName: "fixture-shared" }],
    }] }),
    inspectLocalN8nClaudeHost: selected => inspectLocalN8nClaudeHost(selected, f.dependencies),
    installLocalN8nClaude: request => installLocalN8nClaude(request, f.dependencies),
    getManagedLocalN8nStackTarget: async () => null,
  } });
  t.after(() => wizard.close());
  const post = async (path, body) => {
    const response = await fetch(`${wizard.origin}${path}`, { method: "POST",
      headers: { "Content-Type": "application/json", "X-Setup-Token": token, Origin: wizard.origin }, body: JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  };
  const planned = await post("/api/local/plan", { target: "n8n-claude-oauth", n8nContainerId: N8N, dockerNetworkId: NETWORK, models: ["claude-sonnet-5-5"] });
  assert.equal(planned.status, 200);
  const failed = await post("/api/local/install", { planId: planned.body.planId, confirmed: true, review: REVIEW });
  assert.equal(failed.status, 500);
  assert.equal(failed.body.error, "Local Claude Docker operation failed.");
  assert.equal(failed.body.recovery, "none");
  // A manual companion is the owner's to remove: the refusal keeps status 400 and its advice reaches the browser unchanged.
  f.flags.manual = true;
  const refused = await post("/api/local/plan", { target: "n8n-claude-oauth", n8nContainerId: N8N, dockerNetworkId: NETWORK, models: ["claude-sonnet-5-5"] });
  assert.equal(refused.status, 400);
  assert.match(refused.body.error, /non-wizard relmio-claude container/u);
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

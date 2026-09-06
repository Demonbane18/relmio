import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { EventEmitter } from "node:events";
import { runInNewContext } from "node:vm";

import { createLocalN8nSuperGrokPlan } from "../src/domain/local-n8n-supergrok.js";
import {
  attestLocalN8nSuperGrokInstallation,
  getLocalN8nSuperGrokStatus,
  installLocalN8nSuperGrok,
  removeLocalN8nSuperGrok,
  resolveLocalN8nSuperGrokInstallRoot,
} from "../src/services/local-n8n-supergrok-installer.js";
import { withTestLocalSecurity } from "./helpers/local-security.js";

const HOST = process.platform === "win32" ? "npipe:////./pipe/dockerDesktopLinuxEngine" : "unix:///var/run/docker.sock";
const N8N = "a".repeat(64);
const NETWORK = "b".repeat(64);
const SIDECAR = "c".repeat(64);
const INSTALL = "d".repeat(32);

function plan(overrides = {}) {
  return createLocalN8nSuperGrokPlan({ dockerHost: HOST, n8nContainerId: N8N, n8nContainerName: "fixture-n8n", dockerNetworkId: NETWORK, networkName: "fixture-shared", ...overrides });
}
async function home(t) { const root = await mkdtemp(join(tmpdir(), "relmio-supergrok-test-")); t.after(() => rm(root, { recursive: true, force: true })); return realpath(root); }
function labels(project) { return { "com.docker.compose.project": project, "com.docker.compose.service": "supergrok-oauth", "io.relmio.managed": "true", "io.relmio.target": "n8n-supergrok-oauth", "io.relmio.install": INSTALL }; }

function runner({ changedNetwork = false, changedN8n = false, n8nAvailable = true, aliasCollision = false, published = false, foreignResource = false, wrongImage = false, extraNetwork = false, configFails = false, configFailureHook, buildFails = false, buildLeavesImage = false, upFails = false, verifierFails = false, cleanupFails = false, volumeOnlyAfterUpFailure = false } = {}) {
  const calls = []; let started = false; let image = false; let resourcesRemoved = false; let partialVolume = false;
  const project = `relmio-n8n-supergrok-oauth-${INSTALL}`;
  const result = async (spec) => {
    calls.push(spec); const a = spec.args ?? []; const joined = a.join(" ");
    if (joined === "context inspect --format {{json .Endpoints.docker.Host}}") return { code: 0, stdout: `${JSON.stringify(HOST)}\n`, stderr: "" };
    if (a[0] === "container" && a[1] === "inspect" && a.at(-1) === N8N) return n8nAvailable ? { code: 0, stdout: `${JSON.stringify({ Id: changedN8n ? "e".repeat(64) : N8N, Name: "/fixture-n8n", State: { Running: true }, NetworkSettings: { Networks: { "fixture-shared": { NetworkID: NETWORK, Aliases: ["fixture-n8n"] } } } })}\n`, stderr: "" } : { code: 1, stdout: "", stderr: "missing" };
    if (a[0] === "network" && a[1] === "inspect") {
      const containers = { [N8N]: { Name: "fixture-n8n" } };
      if (started && !resourcesRemoved) containers[SIDECAR] = { Name: `${project}-supergrok-oauth-1` };
      if (aliasCollision) containers["e".repeat(64)] = { Name: "attacker" };
      return { code: 0, stdout: `${JSON.stringify({ Id: changedNetwork ? "f".repeat(64) : NETWORK, Name: "fixture-shared", Driver: "bridge", Internal: false, Containers: containers })}\n`, stderr: "" };
    }
    if (a[0] === "container" && a[1] === "inspect" && a.at(-1) === "e".repeat(64)) return { code: 0, stdout: `${JSON.stringify({ Id: "e".repeat(64), Name: "/attacker", Config: { Labels: {} }, NetworkSettings: { Networks: { "fixture-shared": { NetworkID: NETWORK, Aliases: ["n8n-supergrok"] } } } })}\n`, stderr: "" };
    if (a[0] === "container" && a[1] === "inspect" && a.at(-1) === "f".repeat(64)) return { code: 0, stdout: `${JSON.stringify({ Id: "f".repeat(64), Config: { Labels: {} } })}\n`, stderr: "" };
    if (a[0] === "container" && a[1] === "inspect" && a.at(-1) === SIDECAR) return { code: 0, stdout: `${JSON.stringify({ Id: SIDECAR, Image: wrongImage ? `sha256:${"a".repeat(64)}` : `sha256:${"f".repeat(64)}`, Name: `/${project}-supergrok-oauth-1`, Config: { Image: `${project}:local`, Labels: labels(project) }, State: { Running: started && !resourcesRemoved }, HostConfig: { ReadonlyRootfs: true, CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges:true"], PortBindings: {} }, Mounts: [{ Type: "volume", Name: `${project}_grok-home`, Destination: "/home/node/.grok", RW: true }], NetworkSettings: { Networks: { "fixture-shared": { NetworkID: NETWORK, Aliases: ["n8n-supergrok", "supergrok-oauth"] }, ...(extraNetwork ? { unexpected: { NetworkID: "z".repeat(64), Aliases: [] } } : {}) }, Ports: { "14502/tcp": null } } })}\n`, stderr: "" };
    if (a[0] === "ps" && a.includes(`label=com.docker.compose.project=${project}`)) return { code: 0, stdout: foreignResource ? `${JSON.stringify({ ID: "f".repeat(64) })}\n` : started && !resourcesRemoved ? `${JSON.stringify({ ID: SIDECAR })}\n` : "", stderr: "" };
    if (a[0] === "volume" && a[1] === "ls") return { code: 0, stdout: (started || partialVolume) && !resourcesRemoved ? `${JSON.stringify({ Name: `${project}_grok-home` })}\n` : "", stderr: "" };
    if (a[0] === "volume" && a[1] === "inspect") return { code: 0, stdout: `${JSON.stringify({ "com.docker.compose.project": project, "io.relmio.managed": "true", "io.relmio.target": "n8n-supergrok-oauth", "io.relmio.install": INSTALL })}\n`, stderr: "" };
    if (a[0] === "image" && a[1] === "inspect" && a[2] === "--format") return image ? { code: 0, stdout: `${JSON.stringify({ Id: `sha256:${"f".repeat(64)}`, Config: { Labels: { "com.docker.compose.project": project, "io.relmio.managed": "true", "io.relmio.target": "n8n-supergrok-oauth", "io.relmio.install": INSTALL } } })}\n`, stderr: "" } : { code: 1, stdout: "", stderr: "missing" };
    if (a[0] === "image" && a[1] === "inspect") return image ? { code: 0, stdout: "{}", stderr: "" } : { code: 1, stdout: "", stderr: "" };
    if (a[0] === "image" && a[1] === "rm") { image = false; return { code: 0, stdout: "", stderr: "" }; }
    if (joined.includes(" build supergrok-oauth")) { image = !buildFails || buildLeavesImage; return { code: buildFails ? 1 : 0, stdout: "", stderr: buildFails ? "build failed" : "" }; }
    if (joined.includes(" up -d --wait")) { if (upFails) { partialVolume = volumeOnlyAfterUpFailure; return { code: 1, stdout: "", stderr: "start failed" }; } started = true; return { code: 0, stdout: "", stderr: "" }; }
    if (joined.includes(" down --volumes")) { if (cleanupFails) return { code: 1, stdout: "", stderr: "cleanup failed" }; started = false; partialVolume = false; resourcesRemoved = true; return { code: 0, stdout: "", stderr: "" }; }
    if (joined.includes(" config --quiet")) { if (configFails) await configFailureHook?.(spec.cwd); return { code: configFails ? 1 : 0, stdout: "", stderr: configFails ? "config failed" : "" }; }
    if (joined.includes(" ps --status running --services supergrok-oauth")) return { code: 0, stdout: started && !resourcesRemoved ? "supergrok-oauth\n" : "", stderr: "" };
    if (joined.includes(" ps --format json supergrok-oauth")) return { code: 0, stdout: JSON.stringify({ Publishers: [{ URL: published ? "0.0.0.0" : "", PublishedPort: published ? 14502 : 0 }] }), stderr: "" };
    if (joined.includes(" ps -q supergrok-oauth")) return { code: 0, stdout: started && !resourcesRemoved ? `${SIDECAR}\n` : "", stderr: "" };
    if (a[0] === "exec" && a[1] === "-i" && a[2] === SIDECAR) return { code: verifierFails ? 1 : 0, stdout: verifierFails ? "" : "ok", stderr: "" };
    throw new Error(`unexpected Docker fixture command: ${joined}`);
  };
  result.calls = calls;
  result.setExternalN8n = ({ available = n8nAvailable, changed = changedN8n } = {}) => { n8nAvailable = available; changedN8n = changed; };
  result.setForeignResource = (value) => { foreignResource = value; };
  result.setSidecarRunning = (value) => { started = value; };
  return result;
}
const deps = (more = {}) => withTestLocalSecurity({ randomBytes: () => Buffer.from(`${INSTALL}${"1".repeat(32)}${"2".repeat(64)}`, "hex"), readRuntime: async () => "export default 1;", readChat: async () => "export default 2;", readSession: async () => "export default 3;", ...more });

test("bootstrap verification works before provider sign-in without querying its model catalog", { timeout: 5000 }, async t => {
  const directory = await home(t); const runProcess = runner();
  await installLocalN8nSuperGrok({ plan: plan(), confirmed: true }, deps({ homeDirectory: directory, env: {}, runProcess }));
  const probe = runProcess.calls.find(spec => spec.args[0] === "exec" && spec.args[1] === "-i");
  assert.ok(probe);
  const visited = [];
  const result = await new Promise((resolve, reject) => {
    const stdin = new EventEmitter(); stdin.setEncoding = () => {};
    runInNewContext(probe.args.at(-1), {
      process: { stdin, stdout: { write: resolve }, exit: code => reject(new Error(`probe exited ${code}`)) },
      fetch: async url => {
        visited.push(url);
        return { ok: url.endsWith("/health") || url.endsWith("/auth/verify"), status: url.endsWith("/v1/models") ? 401 : 200 };
      },
    });
    stdin.emit("data", probe.input); stdin.emit("end");
  });
  assert.equal(result, "ok");
  assert.deepEqual(visited.sort(), ["http://127.0.0.1:14502/auth/verify", "http://127.0.0.1:14502/health"]);
});

test("fresh-directory cleanup uses exact filesystem identities on hosts with 64-bit file IDs", async (t) => {
  const directory = await home(t);
  let exactIdentityReads = 0;
  const fileSystem = {
    ...fs,
    async lstat(path, options) {
      const entry = await fs.lstat(path, options);
      if (options?.bigint === true) {
        exactIdentityReads += 1;
        // NTFS IDs can exceed Number.MAX_SAFE_INTEGER; keep exact high bits.
        entry.dev += 2n ** 60n;
        entry.ino += 2n ** 60n;
      }
      return entry;
    },
  };
  await assert.rejects(
    () => installLocalN8nSuperGrok(
      { plan: plan(), confirmed: true },
      deps({ fileSystem, homeDirectory: directory, env: {}, runProcess: runner({ configFails: true }) }),
    ),
    /Compose validation/u,
  );
  const root = await resolveLocalN8nSuperGrokInstallRoot({ homeDirectory: directory, env: {} });
  await assert.rejects(() => fs.lstat(root), { code: "ENOENT" });
  assert.ok(exactIdentityReads >= 3);
});

test("private SuperGrok install, redacted status, attestation and removal remain inside an owned no-port project", async (t) => {
  const directory = await home(t); const runProcess = runner();
  const installed = await installLocalN8nSuperGrok({ plan: plan(), confirmed: true }, deps({ homeDirectory: directory, env: {}, runProcess }));
  assert.deepEqual({ ...installed, clientKey: "redacted" }, { target: "n8n-supergrok-oauth", endpoint: "http://n8n-supergrok:14502/v1", baseUrl: "http://n8n-supergrok:14502/v1", protocol: "openai-chat-completions", n8nContainerName: "fixture-n8n", networkName: "fixture-shared", hostPublication: "none", clientKey: "redacted", credentialShownOnce: true, deploymentMode: "installed" });
  assert.equal(runProcess.calls.some((call) => JSON.stringify(call).includes(installed.clientKey)), true, "bearer is supplied only as bounded process stdin");
  const verifier = runProcess.calls.find((call) => call.args[0] === "exec");
  assert.deepEqual(verifier.args.slice(0, 3), ["exec", "-i", SIDECAR]);
  assert.equal(runProcess.calls.some((call) => call.args.includes("run")), false);
  const root = await resolveLocalN8nSuperGrokInstallRoot({ homeDirectory: directory, env: {} });
  const marker = await fs.readFile(join(root, ".managed-by-relmio.json"), "utf8"); assert.equal(marker.includes(installed.clientKey), false);
  assert.deepEqual(await attestLocalN8nSuperGrokInstallation({ installDirectory: root }, deps({ runProcess })), { installDirectory: root, projectName: `relmio-n8n-supergrok-oauth-${INSTALL}`, dockerHost: HOST, serviceName: "supergrok-oauth" });
  assert.deepEqual(await getLocalN8nSuperGrokStatus(deps({ homeDirectory: directory, env: {}, runProcess })), { target: "n8n-supergrok-oauth", managed: true, state: "healthy", snapshot: { target: "n8n-supergrok-oauth", endpoint: "http://n8n-supergrok:14502/v1", auth: { configured: true, disclosure: "one-time" }, canRemove: true } });
  assert.deepEqual(await removeLocalN8nSuperGrok({ confirmed: true }, deps({ homeDirectory: directory, env: {}, runProcess })), { removed: true, target: "n8n-supergrok-oauth" });
});

test("private SuperGrok refuses mutations without confirmation or when selected n8n identity, alias, or host-port attestation changes", async (t) => {
  const directory = await home(t);
  await assert.rejects(() => installLocalN8nSuperGrok({ plan: plan(), confirmed: false }, deps({ homeDirectory: directory, env: {}, runProcess: runner() })), /Confirm installation/u);
  for (const options of [{ changedN8n: true }, { changedNetwork: true }, { aliasCollision: true }]) await assert.rejects(() => installLocalN8nSuperGrok({ plan: plan(), confirmed: true }, deps({ homeDirectory: directory, env: {}, runProcess: runner(options) })), /changed|collision/u);
  await assert.rejects(() => installLocalN8nSuperGrok({ plan: plan(), confirmed: true }, deps({ homeDirectory: directory, env: {}, runProcess: runner({ foreignResource: true }) })), /ownership|Unexpected Docker resources/u);
  await assert.rejects(() => installLocalN8nSuperGrok({ plan: plan(), confirmed: true }, deps({ homeDirectory: directory, env: {}, runProcess: runner({ published: true }) })), /published an unexpected host port/u);
  for (const options of [{ wrongImage: true }, { extraNetwork: true }]) {
    const failureDirectory = await home(t);
    await assert.rejects(() => installLocalN8nSuperGrok({ plan: plan(), confirmed: true }, deps({ homeDirectory: failureDirectory, env: {}, runProcess: runner(options) })), /identity|cleanup/u);
  }
  await assert.rejects(() => resolveLocalN8nSuperGrokInstallRoot({ homeDirectory: directory, env: { RELMIO_HOME: "/tmp/not-relmio" } }), /storage path/u);
});

test("stored managed-file hashes reject a changed Compose file", async (t) => {
  const directory = await home(t); const runProcess = runner();
  await installLocalN8nSuperGrok({ plan: plan(), confirmed: true }, deps({ homeDirectory: directory, env: {}, runProcess }));
  const root = await resolveLocalN8nSuperGrokInstallRoot({ homeDirectory: directory, env: {} });
  await fs.appendFile(join(root, "docker-compose.yml"), "# changed\n");
  await assert.rejects(() => attestLocalN8nSuperGrokInstallation({ installDirectory: root }, deps({ runProcess })), /managed files changed/u);
});

test("stored ownership keeps a previous package configuration removable", async (t) => {
  const directory = await home(t); const runProcess = runner();
  await installLocalN8nSuperGrok({ plan: plan(), confirmed: true }, deps({ homeDirectory: directory, env: {}, runProcess }));
  const root = await resolveLocalN8nSuperGrokInstallRoot({ homeDirectory: directory, env: {} });
  const dockerfile = `${await fs.readFile(join(root, "Dockerfile"), "utf8")}\n# generated by a previous Relmio package\n`;
  const dockerignore = await fs.readFile(join(root, ".dockerignore"), "utf8");
  const compose = await fs.readFile(join(root, "docker-compose.yml"), "utf8");
  const marker = JSON.parse(await fs.readFile(join(root, ".managed-by-relmio.json"), "utf8"));
  marker.configSha256 = createHash("sha256").update(`${dockerfile}\n${dockerignore}\n${compose}`).digest("hex");
  await fs.writeFile(join(root, "Dockerfile"), dockerfile);
  await fs.writeFile(join(root, ".managed-by-relmio.json"), `${JSON.stringify(marker)}\n`);
  await assert.rejects(() => attestLocalN8nSuperGrokInstallation({ installDirectory: root }, deps({ runProcess })), /configuration changed/u);
  assert.equal((await getLocalN8nSuperGrokStatus(deps({ homeDirectory: directory, env: {}, runProcess }))).state, "healthy");
  assert.deepEqual(await removeLocalN8nSuperGrok({ confirmed: true }, deps({ homeDirectory: directory, env: {}, runProcess })), { removed: true, target: "n8n-supergrok-oauth" });
});

test("owned cleanup does not require the original n8n container", async (t) => {
  const directory = await home(t); const runProcess = runner();
  await installLocalN8nSuperGrok({ plan: plan(), confirmed: true }, deps({ homeDirectory: directory, env: {}, runProcess }));
  runProcess.setExternalN8n({ available: false, changed: true });
  const beforeMaintenance = runProcess.calls.length;
  assert.equal((await getLocalN8nSuperGrokStatus(deps({ homeDirectory: directory, env: {}, runProcess }))).state, "healthy");
  assert.deepEqual(await removeLocalN8nSuperGrok({ confirmed: true }, deps({ homeDirectory: directory, env: {}, runProcess })), { removed: true, target: "n8n-supergrok-oauth" });
  assert.equal(runProcess.calls.slice(beforeMaintenance).some((call) => call.args?.[0] === "container" && call.args?.[1] === "inspect" && call.args.at(-1) === N8N), false);
});

test("an owned but unavailable sidecar remains removable", async (t) => {
  const directory = await home(t); const runProcess = runner();
  await installLocalN8nSuperGrok({ plan: plan(), confirmed: true }, deps({ homeDirectory: directory, env: {}, runProcess }));
  runProcess.setSidecarRunning(false);
  assert.deepEqual(await getLocalN8nSuperGrokStatus(deps({ homeDirectory: directory, env: {}, runProcess })), {
    target: "n8n-supergrok-oauth",
    managed: true,
    state: "partial",
    snapshot: { target: "n8n-supergrok-oauth", endpoint: "http://n8n-supergrok:14502/v1", auth: { configured: true, disclosure: "one-time" }, canRemove: true },
  });
  assert.deepEqual(await removeLocalN8nSuperGrok({ confirmed: true }, deps({ homeDirectory: directory, env: {}, runProcess })), { removed: true, target: "n8n-supergrok-oauth" });
});

test("owned cleanup refuses a project label that lacks Relmio ownership", async (t) => {
  const directory = await home(t); const runProcess = runner();
  await installLocalN8nSuperGrok({ plan: plan(), confirmed: true }, deps({ homeDirectory: directory, env: {}, runProcess }));
  runProcess.setForeignResource(true);
  await assert.rejects(() => removeLocalN8nSuperGrok({ confirmed: true }, deps({ homeDirectory: directory, env: {}, runProcess })), /matching ownership/u);
  const root = await resolveLocalN8nSuperGrokInstallRoot({ homeDirectory: directory, env: {} });
  assert.equal((await fs.lstat(root)).isDirectory(), true);
});

test("a symbolic-link local ancestor is rejected before any Docker mutation", async (t) => {
  const directory = await home(t);
  const relmioHome = join(directory, ".relmio");
  await fs.mkdir(relmioHome);
  await fs.writeFile(join(relmioHome, ".managed-by-relmio-root.json"), `${JSON.stringify({ schemaVersion: 1, kind: "relmio-local-root" })}\n`);
  await fs.symlink(tmpdir(), join(relmioHome, "local"));
  const runProcess = runner();
  await assert.rejects(() => installLocalN8nSuperGrok({ plan: plan(), confirmed: true }, deps({ homeDirectory: directory, env: {}, runProcess })), /unsafe local managed directory/u);
  assert.equal(runProcess.calls.length, 0);
});

test("failed startup or private verification cleans an attested recoverable project and allows a fresh install", async (t) => {
  for (const options of [{ upFails: true }, { upFails: true, volumeOnlyAfterUpFailure: true }, { verifierFails: true }]) {
    const directory = await home(t);
    await assert.rejects(() => installLocalN8nSuperGrok({ plan: plan(), confirmed: true }, deps({ homeDirectory: directory, env: {}, runProcess: runner(options) })), /start|verification/u);
    const root = await resolveLocalN8nSuperGrokInstallRoot({ homeDirectory: directory, env: {} });
    await assert.rejects(() => fs.lstat(root), { code: "ENOENT" });
    await installLocalN8nSuperGrok({ plan: plan(), confirmed: true }, deps({ homeDirectory: directory, env: {}, runProcess: runner() }));
  }
});

test("failed Compose validation and image builds remove pre-start outputs and allow a fresh install", async (t) => {
  for (const options of [
    { configFails: true },
    { buildFails: true },
    { buildFails: true, buildLeavesImage: true },
  ]) {
    const directory = await home(t);
    const failedRun = runner(options);
    await assert.rejects(
      () => installLocalN8nSuperGrok({ plan: plan(), confirmed: true }, deps({ homeDirectory: directory, env: {}, runProcess: failedRun })),
      /Compose validation|image build/u,
    );
    const root = await resolveLocalN8nSuperGrokInstallRoot({ homeDirectory: directory, env: {} });
    await assert.rejects(() => fs.lstat(root), { code: "ENOENT" });
    const composeCalls = failedRun.calls.filter((call) => call.args[0] === "compose");
    if (options.configFails) {
      assert.deepEqual(composeCalls.map((call) => call.args.slice(-2)), [["config", "--quiet"]]);
    } else {
      assert.equal(composeCalls.some((call) => call.args.join(" ").includes(" down --volumes --remove-orphans")), true);
    }
    if (options.buildLeavesImage) {
      assert.equal(failedRun.calls.some((call) => call.args[0] === "image" && call.args[1] === "rm"), true);
    }
    await installLocalN8nSuperGrok({ plan: plan(), confirmed: true }, deps({ homeDirectory: directory, env: {}, runProcess: runner() }));
  }
});

test("fresh-root cleanup retains changed roots and removes only tracked partial writes", async (t) => {
  const writeFailureDirectory = await home(t);
  const writeFailureRunner = runner();
  const failingFileSystem = {
    ...fs,
    async writeFile(path, ...rest) {
      if (String(path).endsWith("gateway.js") && rest[1]?.flag === "wx") throw new Error("injected write failure");
      return fs.writeFile(path, ...rest);
    },
  };
  await assert.rejects(
    () => installLocalN8nSuperGrok({ plan: plan(), confirmed: true }, deps({ fileSystem: failingFileSystem, homeDirectory: writeFailureDirectory, env: {}, runProcess: writeFailureRunner })),
    /injected write failure/u,
  );
  const writeFailureRoot = await resolveLocalN8nSuperGrokInstallRoot({ homeDirectory: writeFailureDirectory, env: {} });
  await assert.rejects(() => fs.lstat(writeFailureRoot), { code: "ENOENT" });
  assert.equal(writeFailureRunner.calls.some((call) => call.args[0] === "compose"), false);

  for (const [name, change] of [
    ["extra entry", async (root) => fs.writeFile(join(root, "unowned"), "retain")],
    ["root replacement", async (root) => { await fs.rm(root, { recursive: true, force: true }); await fs.mkdir(root); await fs.writeFile(join(root, "replacement"), "retain"); }],
  ]) {
    const directory = await home(t);
    const failedRun = runner({ configFails: true, configFailureHook: change });
    await assert.rejects(
      () => installLocalN8nSuperGrok({ plan: plan(), confirmed: true }, deps({ homeDirectory: directory, env: {}, runProcess: failedRun })),
      /cleanup could not be confirmed/u,
      name,
    );
    const root = await resolveLocalN8nSuperGrokInstallRoot({ homeDirectory: directory, env: {} });
    assert.equal((await fs.lstat(root)).isDirectory(), true, name);
    assert.equal(failedRun.calls.filter((call) => call.args[0] === "compose").length, 1, name);
  }
});

test("fresh root and generated destinations are created exclusively", async (t) => {
  const rootRaceDirectory = await home(t);
  const rootRace = await resolveLocalN8nSuperGrokInstallRoot({ homeDirectory: rootRaceDirectory, env: {} });
  const rootRaceFileSystem = {
    ...fs,
    async mkdir(path, ...rest) {
      if (path === rootRace) {
        await fs.mkdir(path, ...rest);
        await fs.writeFile(join(path, "sentinel"), "retain");
        const error = new Error("exists");
        error.code = "EEXIST";
        throw error;
      }
      return fs.mkdir(path, ...rest);
    },
  };
  const rootRaceRunner = runner();
  await assert.rejects(
    () => installLocalN8nSuperGrok({ plan: plan(), confirmed: true }, deps({ fileSystem: rootRaceFileSystem, homeDirectory: rootRaceDirectory, env: {}, runProcess: rootRaceRunner })),
    /directory appeared/u,
  );
  assert.equal(await fs.readFile(join(rootRace, "sentinel"), "utf8"), "retain");
  assert.equal(rootRaceRunner.calls.some((call) => call.args[0] === "compose"), false);

  const fileRaceDirectory = await home(t);
  const fileRace = await resolveLocalN8nSuperGrokInstallRoot({ homeDirectory: fileRaceDirectory, env: {} });
  const fileRaceFileSystem = {
    ...fs,
    async writeFile(path, data, options) {
      if (path === join(fileRace, "Dockerfile") && options?.flag === "wx") {
        await fs.writeFile(path, "retain");
      }
      return fs.writeFile(path, data, options);
    },
  };
  const fileRaceRunner = runner();
  await assert.rejects(
    () => installLocalN8nSuperGrok({ plan: plan(), confirmed: true }, deps({ fileSystem: fileRaceFileSystem, homeDirectory: fileRaceDirectory, env: {}, runProcess: fileRaceRunner })),
    /cleanup could not be confirmed/u,
  );
  assert.equal(await fs.readFile(join(fileRace, "Dockerfile"), "utf8"), "retain");
  assert.equal(fileRaceRunner.calls.some((call) => call.args[0] === "compose"), false);
});

test("failed cleanup retains the managed directory for explicit guarded recovery", async (t) => {
  const directory = await home(t);
  await assert.rejects(() => installLocalN8nSuperGrok({ plan: plan(), confirmed: true }, deps({ homeDirectory: directory, env: {}, runProcess: runner({ verifierFails: true, cleanupFails: true }) })), /cleanup could not be confirmed/u);
  const root = await resolveLocalN8nSuperGrokInstallRoot({ homeDirectory: directory, env: {} });
  assert.equal((await fs.lstat(root)).isDirectory(), true);
});

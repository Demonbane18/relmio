import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { buildClaudeCompanionBundle, parseClaudeAuthStatus, renewClaudeLaunchConfig } from "../src/claude/companion.js";
import { PRECHECK_COMMAND } from "../src/domain/safety.js";
import {
  VPS_OPERATION_LOCKS, cleanupVpsBuildStateCommand, createVpsBuildStateCommand, createVpsLockCommand, releaseVpsLockCommand,
} from "../src/domain/vps-build-state.js";
import {
  applyVpsClaude, discoverVpsClaudeModels, getVpsClaudeAuthStatus, getVpsClaudeStatus, reviewVpsClaude, vpsClaudeLoginCommand,
  createVpsClaudeLaunchWriteCommand,
} from "../src/services/vps-claude.js";
import { verifiedSshFixture } from "./helpers/ssh-session.js";
import { startIsolatedWizard as startWizardServer } from "./helpers/siwc-wizard.js";

const ROOT = "/docker/n8n-openai-oauth/claude";
const LOCK = VPS_OPERATION_LOCKS.claude;
const COMPOSE = `docker compose --project-name relmio-claude --file ${ROOT}/compose.yml`;
const ENDPOINT = "http://relmio-claude:14502/v1";
const n8nId = "a".repeat(64);
const networkId = "b".repeat(64);
const companionId = "c".repeat(64);
const foreignId = "e".repeat(64);
const selected = { containerName: "n8n-fixture", networkName: "fixture-net" };
const models = ["claude-sonnet-5-5", "claude-haiku-5-5"];
const review = { officialBinaryReviewed: true, effectivePolicyReviewed: true, nativeAuthAndBillingReviewed: true, policyChangesControlled: true };
const NOW = Date.parse("2026-11-05T12:00:00.000Z");
const DAY = 24 * 60 * 60 * 1000;
const now = () => NOW;
const entropy = (size) => Buffer.alloc(size, 7);
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const approvalUntil = (time) => new Date(time + 7 * DAY - 60 * 60 * 1000).toISOString();

function companionContainer({ tokenSha256, network = selected.networkName, id = companionId }) {
  return {
    Id: id, Name: "/relmio-claude",
    Config: {
      Image: "relmio-claude:2.1.317", User: "10001:10001",
      Env: ["PATH=/usr/local/bin:/usr/bin:/bin", `RELMIO_CLAUDE_CHAT_TOKEN_SHA256=${tokenSha256}`],
      Labels: {
        "com.relmio.managed": "claude-companion", "com.docker.compose.project": "relmio-claude",
        "com.docker.compose.service": "relmio-claude", "com.docker.compose.project.working_dir": ROOT,
      },
    },
    State: { Running: true, Restarting: false, Health: { Status: "healthy" } },
    HostConfig: { ReadonlyRootfs: true, CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges:true"], PortBindings: {} },
    NetworkSettings: { Networks: { [network]: { NetworkID: networkId, Aliases: ["relmio-claude"] } }, Ports: {} },
    Mounts: [
      { Type: "volume", Name: "relmio-claude_claude-account", Destination: "/data/account", RW: true },
      { Type: "bind", Source: `${ROOT}/launch.json`, Destination: "/run/relmio/launch.json", RW: false },
    ],
  };
}

const companionVolume = () => ({
  Name: "relmio-claude_claude-account",
  Labels: { "com.docker.compose.project": "relmio-claude", "com.docker.compose.volume": "claude-account" },
});

// A small model of the VPS: the companion folder, its container and volume, and the n8n network.
// Every command that would change the VPS fails unless the test opened `writable`.
function createVps({ arch = "x86_64", foreignAlias = false } = {}) {
  const vps = {
    writable: false, root: false, files: new Map(), container: null, volume: null,
    calls: [], inputs: [], uploads: [], builds: [], restarts: 0,
    internalNetwork: false, authCode: null,
    auth: { loggedIn: true, authMethod: "claude.ai", subscriptionType: "max", email: "owner@example.test", orgName: "Owner Org" },
  };
  const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
  const failed = { code: 1, stdout: "", stderr: "" };
  const write = () => {
    if (!vps.writable) throw new Error("A read-only Claude step tried to change the VPS.");
  };
  const listing = () => ["root 0:0 700", ...[...vps.files].map(([path, file]) =>
    `${path} ${file.type} ${file.owner} ${file.mode} 1 ${file.type === "f" ? Buffer.byteLength(file.contents) : 4096}`)].join("\n");
  vps.remote = {
    async exec(command, options) {
      vps.calls.push(command);
      if (options?.input !== undefined) vps.inputs.push({ command, input: options.input });
      if (command === PRECHECK_COMMAND) return ok("managed\n");
      if (command.startsWith(`if [ ! -e ${ROOT} ]`)) return ok(vps.root ? listing() : "absent\n");
      if (command === "docker container inspect relmio-claude") return vps.container ? ok(JSON.stringify([vps.container])) : failed;
      if (command === "docker volume inspect relmio-claude_claude-account") return vps.volume ? ok(JSON.stringify([vps.volume])) : failed;
      if (command === "docker ps -a --format '{{.Names}}'") return ok(["n8n-fixture", ...(vps.container ? ["relmio-claude"] : [])].join("\n"));
      if (command === "docker volume ls --format '{{.Name}}'") return ok(vps.volume ? vps.volume.Name : "");
      if (command.startsWith(`cat -- ${ROOT}/`)) return ok(vps.files.get(command.slice(`cat -- ${ROOT}/`.length)).contents);
      if (command.startsWith(`cd ${ROOT} && sha256sum -- `)) {
        return ok(command.slice(`cd ${ROOT} && sha256sum -- `.length).split(" ")
          .map((path) => `${sha256(vps.files.get(path).contents)}  ${path}`).join("\n"));
      }
      if (command === "uname -m") return ok(`${arch}\n`);
      if (command.startsWith(`docker container inspect ${selected.containerName} `)) {
        return ok(`${JSON.stringify(n8nId)}|true|${JSON.stringify({ [selected.networkName]: { NetworkID: networkId } })}`);
      }
      if (command.startsWith(`docker network inspect ${selected.networkName} `)) {
        return ok(JSON.stringify({ Id: networkId, Name: selected.networkName, Internal: vps.internalNetwork, Containers: {
          [n8nId]: { Name: selected.containerName },
          ...(foreignAlias ? { [foreignId]: { Name: "other-helper" } } : {}),
          ...(vps.container ? { [vps.container.Id]: { Name: "relmio-claude" } } : {}),
        } }));
      }
      const networks = /^docker container inspect ([a-f0-9]{64}) --format '\{\{json \.NetworkSettings\.Networks\}\}'$/u.exec(command);
      if (networks) {
        const claims = networks[1] === foreignId || networks[1] === vps.container?.Id;
        return ok(JSON.stringify({ [selected.networkName]: { Aliases: claims ? ["relmio-claude"] : ["n8n"] } }));
      }
      const claude = /^docker exec -w \/data\/account\/empty ([a-f0-9]{64}) env -i .+ auth (status --json|logout)$/u.exec(command);
      if (claude && claude[1] === vps.container?.Id) {
        if (claude[2] === "logout") {
          write();
          vps.auth = { loggedIn: false };
          return ok("Successfully logged out.\n");
        }
        return { code: vps.authCode ?? (vps.auth.loggedIn ? 0 : 1), stdout: JSON.stringify(vps.auth), stderr: "" };
      }
      if (vps.container && command.startsWith(`docker exec -i ${vps.container.Id} node -e `)) {
        const token = /RELMIO_CLAUDE_CHAT_TOKEN_SHA256=([a-f0-9]{64})/u.exec(vps.container.Config.Env.join("\n"))[1];
        return ok(JSON.stringify(sha256(options.input) === token
          ? { status: 200, models: JSON.parse(vps.files.get("launch.json").contents).models }
          : { status: 401, models: [] }));
      }
      // Everything below changes the VPS.
      write();
      if (command.includes("install -d -m 0755 /docker/n8n-openai-oauth &&")) return ok();
      if (command === createVpsLockCommand(LOCK)) return ok("11:22\n");
      if (command === createVpsBuildStateCommand(LOCK, "11:22")) return ok("11:33\n");
      if (command === cleanupVpsBuildStateCommand(LOCK, "11:22", "11:33") || command === releaseVpsLockCommand(LOCK, "11:22")) return ok();
      if (command.includes(" BUILDX_CONFIG=")) {
        vps.builds.push(command);
        return ok();
      }
      if (command.endsWith(`umask 077 && mkdir ${ROOT}`)) {
        assert.equal(vps.root, false);
        vps.root = true;
        return ok();
      }
      const clear = /&& rm -f -- (.+?) && for d in (.+?); do .+; done && (chmod 0700 \S+|cd \/ && rmdir \S+)$/u.exec(command);
      if (clear) {
        for (const path of clear[1].split(" ")) vps.files.delete(path);
        for (const directory of clear[2].split(" ")) {
          if ([...vps.files.keys()].some((path) => path.startsWith(`${directory}/`))) return failed;
          vps.files.delete(directory);
        }
        if (clear[3].startsWith("cd /")) {
          if (vps.files.size) return failed;
          vps.root = false;
        }
        return ok();
      }
      const directories = /&& mkdir -m 0755 (.+)$/u.exec(command);
      if (directories) {
        for (const directory of directories[1].split(" ")) {
          assert.equal(vps.files.has(directory), false);
          vps.files.set(directory, { type: "d", owner: "0:0", mode: "755" });
        }
        return ok();
      }
      const modes = /&& chmod 0644 -- (.+?) && chmod 0600 -- (.+?) && chown -h 10001:10001 -- launch\.json$/u.exec(command);
      if (modes) {
        for (const path of modes[1].split(" ")) vps.files.get(path).mode = "644";
        for (const path of modes[2].split(" ")) vps.files.get(path).mode = "600";
        vps.files.get("launch.json").owner = "10001:10001";
        return ok();
      }
      if (command === `${COMPOSE} config --quiet`) return ok();
      if (command.startsWith(`${COMPOSE} up -d --wait `)) {
        // A resource this install did not create appeared before Compose started it.
        if (vps.swapOnUp) {
          Object.assign(vps, vps.swapOnUp);
          return { code: 1, stdout: "", stderr: "conflict" };
        }
        const env = vps.files.get(".env").contents;
        vps.container = companionContainer({
          tokenSha256: /RELMIO_CLAUDE_CHAT_TOKEN_SHA256=([a-f0-9]{64})/u.exec(env)[1],
          network: /N8N_DOCKER_NETWORK=(\S+)/u.exec(env)[1],
        });
        vps.volume ??= companionVolume();
        if (vps.upFails) return { code: 1, stdout: "", stderr: "unhealthy" };
        return ok();
      }
      if (command === `${COMPOSE} restart relmio-claude`) {
        vps.restarts += 1;
        return ok();
      }
      if (command.includes("launch.json.next") && options?.input !== undefined) {
        vps.files.set("launch.json", { type: "f", owner: "10001:10001", mode: "600", contents: options.input });
        return ok();
      }
      if (vps.container && command === `docker rm -f ${vps.container.Id}`) {
        vps.container = null;
        return ok();
      }
      if (command === "docker volume rm relmio-claude_claude-account") {
        vps.volume = null;
        return ok();
      }
      throw new Error(`Unexpected VPS command: ${command}`);
    },
    async upload(path, contents, mode) {
      write();
      assert.equal(vps.root, true);
      assert.ok(path.startsWith(`${ROOT}/`));
      vps.uploads.push(path);
      vps.files.set(path.slice(ROOT.length + 1), { type: "f", owner: "0:0", mode: mode.toString(8), contents });
    },
  };
  return vps;
}

async function install(vps) {
  const plan = await reviewVpsClaude({ remote: vps.remote, action: "install", ...selected, models, review, now });
  vps.writable = true;
  const result = await applyVpsClaude({ remote: vps.remote, plan, confirmed: true }, { now, entropy });
  return { plan, result };
}

// What `relmio claude companion prepare` leaves after the owner copied it to the VPS and ran Compose by hand.
async function seedManualInstall(vps) {
  const bundle = await buildClaudeCompanionBundle({ network: selected.networkName, arch: "amd64", models: ["claude-opus-5-5"], now });
  vps.root = true;
  for (const directory of ["app", "app/src", "app/src/gateway", "app/src/claude"]) {
    vps.files.set(directory, { type: "d", owner: "0:0", mode: "755" });
  }
  for (const file of bundle.files) vps.files.set(file.path, { type: "f", owner: "0:0", mode: file.mode.toString(8), contents: file.contents });
  vps.files.set("n8n-api-key.txt", { type: "f", owner: "0:0", mode: "600", contents: `${bundle.key}\n` });
  vps.container = companionContainer({ tokenSha256: bundle.keySha256, id: "d".repeat(64) });
  vps.volume = companionVolume();
  return bundle;
}

const n8nUntouched = (vps) => vps.calls.filter((command) => command.includes(selected.containerName))
  .every((command) => command.startsWith(`docker container inspect ${selected.containerName} --format `));

test("Claude review needs all four answers before any VPS command and refuses unsafe selections", async () => {
  const vps = createVps();
  for (const answers of [undefined, {}, { ...review, policyChangesControlled: false }, { ...review, extra: true },
    { ...review, officialBinaryReviewed: "true" }, [true, true, true, true]]) {
    for (const action of ["install", "replace", "renew"]) {
      await assert.rejects(reviewVpsClaude({ remote: vps.remote, action, ...selected, models, review: answers, now }), /four Claude review questions/u);
    }
  }
  await assert.rejects(reviewVpsClaude({ remote: vps.remote, action: "restart-n8n", ...selected, models, review, now }), /supported/u);
  assert.equal(vps.calls.length, 0);

  for (const unsafe of [{ containerName: "n8n; touch /tmp/owned" }, { networkName: "net$(id)" }, { networkName: "--network" }]) {
    await assert.rejects(reviewVpsClaude({ remote: vps.remote, action: "install", ...selected, ...unsafe, models, review, now }), /invalid/u);
  }
  for (const unsafeModels of [["claude-fable-5-5"], ["claude-sonnet-5-5; rm -rf /"], [], Array(9).fill("claude-sonnet-5-5")]) {
    await assert.rejects(reviewVpsClaude({ remote: vps.remote, action: "install", ...selected, models: unsafeModels, review, now }), /model IDs/u);
  }
  assert.equal(vps.calls.length, 0);
  await assert.rejects(reviewVpsClaude({ remote: createVps({ arch: "riscv64" }).remote, action: "install", ...selected, models, review, now }),
    /amd64.*arm64/u);
});

test("Claude install review is read-only and discloses the pinned binary, the approval window and no n8n change", async () => {
  const vps = createVps();
  const plan = await reviewVpsClaude({ remote: vps.remote, action: "install", ...selected, models, review, now });
  assert.equal(vps.root, false);
  assert.deepEqual(vps.uploads, []);
  assert.deepEqual(vps.inputs, []);
  assert.equal(plan.installDirectory, ROOT);
  assert.equal(plan.endpoint, ENDPOINT);
  assert.equal(plan.arch, "amd64");
  assert.equal(plan.version, "2.1.317");
  assert.equal(plan.executableSha256, "eb224419e344575faa4a1f39b290b649425a10cd5ee2ef1d003480cd9ae57eb0");
  assert.equal(plan.expiresAt, approvalUntil(NOW));
  assert.deepEqual([plan.existingN8nChanges, plan.restarts, plan.publishedPorts, plan.keepsClaudeLogin], [[], 0, [], false]);
  assert.deepEqual([plan.containerId, plan.networkId], [n8nId, networkId]);
  assert.equal(plan.operationLockPath, LOCK);
  const arm = await reviewVpsClaude({ remote: createVps({ arch: "aarch64" }).remote, action: "install", ...selected, models, review, now });
  assert.equal(arm.executableSha256, "563a0d60ad0c223d9415768210997acb0f7134ea51dc3c238e88bc2e18ddeefa");

  const status = await getVpsClaudeStatus({ remote: vps.remote, now });
  assert.deepEqual(status, { state: "absent", installation: null, candidate: {
    version: "2.1.317", arch: "amd64", platform: "linux-x64", executableSha256: plan.executableSha256,
  } });
});

test("another container answering to relmio-claude on the n8n network blocks install before any write", async () => {
  const vps = createVps({ foreignAlias: true });
  await assert.rejects(reviewVpsClaude({ remote: vps.remote, action: "install", ...selected, models, review, now }), /relmio-claude on this n8n network/u);
  assert.equal(vps.root, false);
});

test("confirmed install writes the marker first, keeps the key out of the VPS and leaves n8n alone", async () => {
  const vps = createVps();
  const plan = await reviewVpsClaude({ remote: vps.remote, action: "install", ...selected, models, review, now });
  const before = vps.calls.length;
  await assert.rejects(applyVpsClaude({ remote: vps.remote, plan, confirmed: false }, { now, entropy }), /Confirm/u);
  await assert.rejects(applyVpsClaude({ remote: vps.remote, plan: { ...plan, review: { ...review, effectivePolicyReviewed: false } }, confirmed: true }, { now, entropy }),
    /four Claude review questions/u);
  assert.equal(vps.calls.length, before);

  vps.writable = true;
  const result = await applyVpsClaude({ remote: vps.remote, plan, confirmed: true }, { now, entropy });
  assert.equal(result.state, "installed");
  assert.match(result.clientKey, /^[A-Za-z0-9_-]{43}$/u);
  assert.equal(result.expiresAt, approvalUntil(NOW));
  assert.equal(vps.uploads[0], `${ROOT}/.managed-by-relmio.json`);
  const marker = JSON.parse(vps.files.get(".managed-by-relmio.json").contents);
  assert.equal(marker.kind, "relmio-claude-companion");
  assert.equal(marker.tokenSha256, sha256(result.clientKey));
  assert.equal(Object.hasOwn(marker.files, "launch.json"), false);
  const launch = vps.files.get("launch.json");
  assert.deepEqual([launch.owner, launch.mode], ["10001:10001", "600"]);
  assert.equal(JSON.parse(launch.contents).qualification.expiresAt, result.expiresAt);
  for (const path of ["app/src/claude/launcher.js", "app/src/gateway/claude-chat.js", "Dockerfile"]) assert.equal(vps.files.get(path).mode, "644", path);
  assert.equal(vps.files.has("n8n-api-key.txt"), false);
  assert.ok([...vps.files.values()].every((file) => !file.contents?.includes(result.clientKey)));
  assert.ok(vps.calls.every((command) => !command.includes(result.clientKey)));
  assert.equal(vps.builds.length, 1);
  assert.ok(n8nUntouched(vps));

  assert.deepEqual(await getVpsClaudeStatus({ remote: vps.remote, now }), {
    state: "installed",
    installation: { network: selected.networkName, arch: "amd64", models, expiresAt: result.expiresAt, approvalExpired: false, container: "running", endpoint: ENDPOINT },
    candidate: { version: "2.1.317", arch: "amd64", platform: "linux-x64", executableSha256: plan.executableSha256 },
  });
  await assert.rejects(reviewVpsClaude({ remote: vps.remote, action: "install", ...selected, models, review, now }), /not ready/u);
});

test("a CLI-made manual install is replaced in place: the login volume stays, the old key file goes, a new key is issued", async () => {
  const vps = createVps();
  const manual = await seedManualInstall(vps);
  assert.deepEqual(await getVpsClaudeStatus({ remote: vps.remote, now }), {
    state: "manual", installation: null,
    candidate: { version: "2.1.317", arch: "amd64", platform: "linux-x64", executableSha256: "eb224419e344575faa4a1f39b290b649425a10cd5ee2ef1d003480cd9ae57eb0" },
  });
  await assert.rejects(reviewVpsClaude({ remote: vps.remote, action: "install", ...selected, models, review, now }), /not ready/u);
  for (const action of ["renew", "sign-out", "remove"]) {
    await assert.rejects(reviewVpsClaude({ remote: vps.remote, action, review, now }), /not ready/u, action);
  }

  const plan = await reviewVpsClaude({ remote: vps.remote, action: "replace", ...selected, models, review, now });
  assert.equal(plan.keepsClaudeLogin, true);
  assert.equal(plan.installId, null);
  const loginVolume = vps.volume;
  vps.writable = true;
  const result = await applyVpsClaude({ remote: vps.remote, plan, confirmed: true }, { now, entropy });
  assert.equal(vps.volume, loginVolume);
  assert.ok(vps.calls.every((command) => !command.includes("volume rm")));
  assert.equal(vps.files.has("n8n-api-key.txt"), false);
  assert.notEqual(sha256(result.clientKey), manual.keySha256);
  assert.ok(vps.container.Config.Env.includes(`RELMIO_CLAUDE_CHAT_TOKEN_SHA256=${sha256(result.clientKey)}`));
  const status = await getVpsClaudeStatus({ remote: vps.remote, now });
  assert.equal(status.state, "installed");
  assert.deepEqual(status.installation.models, models);
  assert.ok(n8nUntouched(vps));
});

test("unrecognized companions, folders and leftovers are invalid and every change is refused", async () => {
  const cases = {
    "foreign relmio-claude container": (vps) => { vps.container = { Id: foreignId, Name: "/relmio-claude", Config: { Labels: {} } }; },
    "unlabeled leftover volume": (vps) => { vps.volume = { Name: "relmio-claude_claude-account", Labels: {} }; },
    "manual bundle with an unknown file": async (vps) => {
      await seedManualInstall(vps);
      vps.files.set("notes.txt", { type: "f", owner: "0:0", mode: "644", contents: "owner notes\n" });
    },
    "manual bundle without a companion container": async (vps) => {
      await seedManualInstall(vps);
      vps.container = null;
    },
    "manual bundle from another folder": async (vps) => {
      await seedManualInstall(vps);
      vps.container.Config.Labels["com.docker.compose.project.working_dir"] = "/root/claude";
    },
    "manual bundle with a folder owned by another user": async (vps) => {
      await seedManualInstall(vps);
      vps.files.get("app").owner = "1000:1000";
    },
    "manual bundle with a group-writable nested folder": async (vps) => {
      await seedManualInstall(vps);
      vps.files.get("app/src").mode = "775";
    },
    "manual bundle with an other-writable file": async (vps) => {
      await seedManualInstall(vps);
      vps.files.get("Dockerfile").mode = "646";
    },
    "installed bundle with an edited compose file": async (vps) => {
      await install(vps);
      vps.files.get("compose.yml").contents += "    privileged: true\n";
    },
    "installed bundle with a linked launch file": async (vps) => {
      await install(vps);
      vps.files.get("launch.json").type = "l";
    },
  };
  for (const [name, arrange] of Object.entries(cases)) {
    const vps = createVps();
    await arrange(vps);
    vps.writable = false;
    const status = await getVpsClaudeStatus({ remote: vps.remote, now });
    assert.deepEqual([status.state, status.installation], ["invalid", null], name);
    for (const action of ["install", "replace", "renew", "sign-out", "remove"]) {
      await assert.rejects(reviewVpsClaude({ remote: vps.remote, action, ...selected, models, review, now }), /not ready/u, `${name}: ${action}`);
    }
  }
});

test("a labeled orphan login volume is absent, installable, and keeps the Claude login", async () => {
  const vps = createVps();
  const loginVolume = companionVolume();
  vps.volume = loginVolume;
  const status = await getVpsClaudeStatus({ remote: vps.remote, now });
  assert.equal(status.state, "absent");
  assert.equal(status.existingLogin, true);
  assert.equal(status.installation, null);
  const plan = await reviewVpsClaude({ remote: vps.remote, action: "install", ...selected, models, review, now });
  assert.equal(plan.keepsClaudeLogin, true);
  vps.writable = true;
  const result = await applyVpsClaude({ remote: vps.remote, plan, confirmed: true }, { now, entropy });
  assert.equal(result.state, "installed");
  assert.equal(vps.volume, loginVolume);
  assert.equal(vps.calls.some((command) => command.includes("volume rm")), false);
  assert.ok(n8nUntouched(vps));
});

test("a manual bundle whose launch file renew.sh left owned by 10001 is still a manual install", async () => {
  const vps = createVps();
  await seedManualInstall(vps);
  vps.files.get("launch.json").owner = "10001:10001";
  assert.equal((await getVpsClaudeStatus({ remote: vps.remote, now })).state, "manual");
});

test("renew rewrites only launch.json, atomically and owned by 10001, then restarts only the companion", async t => {
  const vps = createVps();
  await install(vps);
  const files = new Map([...vps.files].map(([path, file]) => [path, { ...file }]));
  const counts = { calls: vps.calls.length, uploads: vps.uploads.length, builds: vps.builds.length, inputs: vps.inputs.length };
  const later = NOW + 3 * DAY;
  const plan = await reviewVpsClaude({ remote: vps.remote, action: "renew", review, now: () => later });
  assert.deepEqual([plan.expiresAt, plan.keepsClaudeLogin, plan.network], [approvalUntil(later), true, selected.networkName]);
  const result = await applyVpsClaude({ remote: vps.remote, plan, confirmed: true }, { now: () => later });
  assert.deepEqual(result, { state: "installed", expiresAt: approvalUntil(later) });

  assert.equal(vps.uploads.length, counts.uploads);
  assert.equal(vps.builds.length, counts.builds);
  const writes = vps.inputs.slice(counts.inputs);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].command, createVpsClaudeLaunchWriteCommand());
  await t.test("executes the renewal write on disposable files", { skip: process.platform === "win32" }, t => assertLaunchWrite(t, writes[0].input));
  const scope = (config) => ({ ...config, qualification: { ...config.qualification, reviewedAt: null, expiresAt: null } });
  const previous = JSON.parse(files.get("launch.json").contents);
  const renewed = JSON.parse(writes[0].input);
  assert.deepEqual(scope(renewed), scope(previous));
  assert.equal(renewed.qualification.expiresAt, approvalUntil(later));
  for (const [path, file] of vps.files) if (path !== "launch.json") assert.deepEqual(file, files.get(path), path);
  assert.deepEqual([vps.files.get("launch.json").owner, vps.files.get("launch.json").mode], ["10001:10001", "600"]);
  assert.equal(vps.restarts, 1);
  assert.ok(vps.calls.slice(counts.calls).every((command) => !command.includes(selected.containerName)));
});

test("renew refuses a companion that is running without a claude.ai login and writes nothing", async () => {
  for (const auth of [{ loggedIn: false }, { loggedIn: true, authMethod: "console", subscriptionType: null }]) {
    const vps = createVps();
    await install(vps);
    vps.auth = auth;
    const plan = await reviewVpsClaude({ remote: vps.remote, action: "renew", review, now });
    const inputs = vps.inputs.length;
    await assert.rejects(applyVpsClaude({ remote: vps.remote, plan, confirmed: true }, { now }), /not signed in to a Claude plan/u);
    assert.equal(vps.inputs.length, inputs);
    assert.equal(vps.restarts, 0);
  }
});

test("an expired approval shows in status and can still be renewed while the launcher restarts", async () => {
  const vps = createVps();
  await install(vps);
  const later = NOW + 8 * DAY;
  vps.container.State = { Running: true, Restarting: true, Health: { Status: "unhealthy" } };
  const status = await getVpsClaudeStatus({ remote: vps.remote, now: () => later });
  assert.deepEqual([status.installation.approvalExpired, status.installation.container], [true, "stopped"]);
  await assert.rejects(reviewVpsClaude({ remote: vps.remote, action: "sign-out", now: () => later }), /safety check/u);
  const plan = await reviewVpsClaude({ remote: vps.remote, action: "renew", review, now: () => later });
  const applying = vps.calls.length;
  const result = await applyVpsClaude({ remote: vps.remote, plan, confirmed: true }, { now: () => later });
  assert.equal(result.expiresAt, approvalUntil(later));
  // A restarting launcher cannot answer `claude auth status`, so the owner's review answers stand alone.
  assert.ok(vps.calls.slice(applying).every((command) => !command.endsWith(" auth status --json")));
  assert.equal(vps.restarts, 1);
});

test("the sign-in check returns only loggedIn, authMethod and subscriptionType even when Claude prints the email", async () => {
  const vps = createVps();
  await install(vps);
  vps.writable = false;
  vps.auth = { loggedIn: true, authMethod: "claude.ai", subscriptionType: "max", email: "owner@example.test", orgId: "org-123", orgName: "Owner Org" };
  const status = await getVpsClaudeAuthStatus({ remote: vps.remote, now });
  assert.deepEqual(status, { loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" });
  assert.deepEqual(parseClaudeAuthStatus("Not JSON: owner@example.test"), { loggedIn: false, authMethod: null, subscriptionType: null });
  assert.deepEqual(parseClaudeAuthStatus(JSON.stringify({ loggedIn: "true", authMethod: "claude.ai\nowner@example.test", subscriptionType: { plan: "max" } })),
    { loggedIn: false, authMethod: null, subscriptionType: null });
});

test("the model check sends the key on stdin only and refuses keys that are not this companion's", async () => {
  const vps = createVps();
  const { result } = await install(vps);
  vps.writable = false;
  assert.deepEqual(await discoverVpsClaudeModels({ remote: vps.remote, clientKey: result.clientKey, now }), { models });
  assert.ok(vps.calls.every((command) => !command.includes(result.clientKey)));
  const probe = vps.inputs.find(({ command }) => command.includes(" node -e "));
  assert.equal(probe.input, result.clientKey);
  await assert.rejects(discoverVpsClaudeModels({ remote: vps.remote, clientKey: "synthetic-provider-credential", now }), /companion key/u);
  await assert.rejects(discoverVpsClaudeModels({ remote: vps.remote, clientKey: "x".repeat(43), now }), /does not belong/u);
  assert.ok(vps.calls.every((command) => !command.includes("synthetic-provider-credential")));
});

test("sign-out runs the official logout inside the companion; removal deletes only the companion, its volume and folder", async () => {
  const vps = createVps();
  await install(vps);
  const signOut = await reviewVpsClaude({ remote: vps.remote, action: "sign-out", now });
  assert.deepEqual([signOut.expiresAt, signOut.keepsClaudeLogin], [null, false]);
  assert.deepEqual(await applyVpsClaude({ remote: vps.remote, plan: signOut, confirmed: true }, { now }), { state: "installed", loggedIn: false });
  assert.deepEqual(await getVpsClaudeAuthStatus({ remote: vps.remote, now }), { loggedIn: false, authMethod: null, subscriptionType: null });

  const removal = await reviewVpsClaude({ remote: vps.remote, action: "remove", now });
  assert.deepEqual(await applyVpsClaude({ remote: vps.remote, plan: removal, confirmed: true }, { now }), { state: "absent" });
  assert.deepEqual([vps.root, vps.container, vps.volume, vps.files.size], [false, null, null, 0]);
  assert.ok(n8nUntouched(vps));
  assert.equal((await getVpsClaudeStatus({ remote: vps.remote, now })).state, "absent");
});

test("a failed VPS install after start removes the companion, volume and files and reports the original error", async () => {
  const vps = createVps();
  vps.upFails = true;
  const plan = await reviewVpsClaude({ remote: vps.remote, action: "install", ...selected, models, review, now });
  vps.writable = true;
  await assert.rejects(applyVpsClaude({ remote: vps.remote, plan, confirmed: true }, { now, entropy }), /did not become healthy/u);
  assert.deepEqual([vps.root, vps.container, vps.volume, vps.files.size], [false, null, null, 0]);
  assert.ok(n8nUntouched(vps));
});

test("a failed VPS replace after start removes the new companion files but keeps the login volume", async () => {
  const vps = createVps();
  await install(vps);
  const volume = vps.volume;
  vps.upFails = true;
  const plan = await reviewVpsClaude({ remote: vps.remote, action: "replace", ...selected, models, review, now });
  await assert.rejects(applyVpsClaude({ remote: vps.remote, plan, confirmed: true }, { now, entropy }), /did not become healthy/u);
  assert.equal(vps.volume, volume);
  assert.equal(vps.container, null);
  assert.equal(vps.root, false);
  assert.equal(vps.files.size, 0);
  assert.equal(vps.calls.some((command) => command.includes("volume rm")), false);
  assert.ok(n8nUntouched(vps));
});

test("a failed VPS install that reuses a login volume keeps it", async () => {
  const vps = createVps();
  const loginVolume = companionVolume();
  vps.volume = loginVolume;
  vps.upFails = true;
  const plan = await reviewVpsClaude({ remote: vps.remote, action: "install", ...selected, models, review, now });
  assert.equal(plan.keepsClaudeLogin, true);
  vps.writable = true;
  await assert.rejects(applyVpsClaude({ remote: vps.remote, plan, confirmed: true }, { now, entropy }), /did not become healthy/u);
  assert.equal(vps.volume, loginVolume);
  assert.deepEqual([vps.root, vps.container, vps.files.size], [false, null, 0]);
  assert.equal(vps.calls.some((command) => command.includes("volume rm")), false);
  assert.ok(n8nUntouched(vps));
});

test("a login volume that appears after review fails closed before any write", async () => {
  const vps = createVps();
  const plan = await reviewVpsClaude({ remote: vps.remote, action: "install", ...selected, models, review, now });
  assert.equal(plan.keepsClaudeLogin, false);
  const loginVolume = companionVolume();
  vps.volume = loginVolume;
  vps.writable = true;
  await assert.rejects(applyVpsClaude({ remote: vps.remote, plan, confirmed: true }, { now, entropy }), /safety check/u);
  assert.equal(vps.volume, loginVolume);
  assert.deepEqual([vps.root, vps.uploads.length], [false, 0]);
  assert.equal(vps.calls.some((command) => command.includes("volume rm")), false);
});

test("rollback refuses a container or volume it does not own that appears when start fails", async () => {
  const foreignContainer = { Id: foreignId, Name: "/relmio-claude", Config: { Labels: {} } };
  const unlabeledVolume = { Name: "relmio-claude_claude-account", Labels: {} };
  for (const [name, swapped, kept] of [["container", { container: foreignContainer }, "container"], ["volume", { volume: unlabeledVolume }, "volume"]]) {
    const vps = createVps();
    const plan = await reviewVpsClaude({ remote: vps.remote, action: "install", ...selected, models, review, now });
    vps.swapOnUp = swapped;
    vps.writable = true;
    await assert.rejects(applyVpsClaude({ remote: vps.remote, plan, confirmed: true }, { now, entropy }), /cleanup could not be confirmed/u, name);
    assert.equal(vps[kept], swapped[kept], name);
    assert.equal(vps.calls.some((command) => command.startsWith("docker rm -f") || command.includes("volume rm")), false, name);
    assert.ok(n8nUntouched(vps), name);
  }
});

test("a stale plan cannot act on a companion that changed after review", async () => {
  const vps = createVps();
  await install(vps);
  const plan = await reviewVpsClaude({ remote: vps.remote, action: "remove", now });
  await assert.rejects(applyVpsClaude({ remote: vps.remote, plan: { ...plan, installId: "f".repeat(32) }, confirmed: true }, { now }), /safety check/u);
  assert.ok(vps.container);
  const replace = await reviewVpsClaude({ remote: vps.remote, action: "replace", ...selected, models, review, now });
  await assert.rejects(applyVpsClaude({ remote: vps.remote, plan: { ...replace, networkId: "f".repeat(64) }, confirmed: true }, { now, entropy }), /safety check/u);
  assert.equal(JSON.parse(vps.files.get(".managed-by-relmio.json").contents).installId, plan.installId);
});

test("a renewal changes only the approval timestamps and refuses any other launch.json change", async () => {
  const { launchConfig } = await buildClaudeCompanionBundle({ network: "proxy", arch: "arm64", models, now });
  const renewed = renewClaudeLaunchConfig(structuredClone(launchConfig), () => NOW + DAY);
  assert.equal(renewed.qualification.expiresAt, approvalUntil(NOW + DAY));
  assert.deepEqual({ ...renewed, qualification: { ...renewed.qualification, reviewedAt: 0, expiresAt: 0 } },
    { ...launchConfig, qualification: { ...launchConfig.qualification, reviewedAt: 0, expiresAt: 0 } });
  for (const tamper of [
    (config) => { config.port = 1; }, (config) => { config.companionHost = "other-host"; },
    (config) => { config.models = ["claude-fable-5-5"]; }, (config) => { config.qualification.runtime.models = ["claude-opus-5-5"]; },
    (config) => { config.qualification.effectivePolicyReviewed = false; }, (config) => { config.executable = "/tmp/claude"; },
    (config) => { config.accountRoot = "/root"; }, (config) => { config.extra = true; },
    (config) => { config.qualification.reviewedBy = "someone else"; }, (config) => { config.executableSha256 = "0".repeat(64); },
    (config) => { config.qualification = null; },
  ]) {
    const config = structuredClone(launchConfig);
    tamper(config);
    assert.throws(() => renewClaudeLaunchConfig(config, now), TypeError, tamper.toString());
  }
});

test("renewal compares nested approval values independently of object key order", async () => {
  const reorder = value => Array.isArray(value) ? value.map(reorder)
    : value !== null && typeof value === "object" ? Object.fromEntries(Object.entries(value).reverse().map(([key, item]) => [key, reorder(item)])) : value;
  const { launchConfig } = await buildClaudeCompanionBundle({ network: "proxy", arch: "arm64", models, now });
  const reordered = reorder(launchConfig);
  assert.deepEqual(renewClaudeLaunchConfig(reordered, now), launchConfig);
  reordered.qualification.runtime.models.reverse();
  assert.throws(() => renewClaudeLaunchConfig(reordered, now), TypeError);
  const vps = createVps();
  await install(vps);
  const launch = vps.files.get("launch.json");
  launch.contents = JSON.stringify(reorder(JSON.parse(launch.contents)));
  assert.equal((await getVpsClaudeStatus({ remote: vps.remote, now })).installation.approvalExpired, false);
  const plan = await reviewVpsClaude({ remote: vps.remote, action: "renew", review, now });
  assert.equal((await applyVpsClaude({ remote: vps.remote, plan, confirmed: true }, { now })).state, "installed");
});

test("internal or unknown VPS networks are rejected before review and again before deployment writes", async () => {
  for (const internal of [true, null, undefined, "false"]) {
    const vps = createVps();
    vps.internalNetwork = internal;
    await assert.rejects(() => reviewVpsClaude({ remote: vps.remote, action: "install", ...selected, models, review, now }), /no outbound route/u);
    assert.equal(vps.root, false);
    assert.equal(vps.uploads.length, 0);
  }
  const vps = createVps();
  const plan = await reviewVpsClaude({ remote: vps.remote, action: "install", ...selected, models, review, now });
  vps.internalNetwork = true; vps.writable = true;
  await assert.rejects(() => applyVpsClaude({ remote: vps.remote, plan, confirmed: true }, { now }), /no outbound route/u);
  assert.equal(vps.root, false);
  assert.equal(vps.uploads.length, 0);
});

test("auth status accepts only native success and signed-out exit codes", async () => {
  const vps = createVps();
  await install(vps);
  vps.auth = { loggedIn: false };
  vps.authCode = 1;
  assert.deepEqual(await getVpsClaudeAuthStatus({ remote: vps.remote, now }), { loggedIn: false, authMethod: null, subscriptionType: null });
  for (const code of [-1, 2, 124, 125, 127, "0"]) {
    vps.authCode = code;
    await assert.rejects(() => getVpsClaudeAuthStatus({ remote: vps.remote, now }), /could not be checked/u, String(code));
  }
  const renewal = await reviewVpsClaude({ remote: vps.remote, action: "renew", review, now });
  const inputs = vps.inputs.length;
  vps.authCode = 2;
  await assert.rejects(() => applyVpsClaude({ remote: vps.remote, plan: renewal, confirmed: true }, { now }), /could not be checked/u);
  assert.equal(vps.inputs.length, inputs);
  assert.equal(vps.restarts, 0);
});

test("approval write roots reject shell fragments and paths outside the guard", () => {
  for (const roots of [
    { guardRoot: "/docker;true" }, { installRoot: "/tmp/other" },
    { guardRoot: "/docker", installRoot: "/docker/../outside" },
    { guardRoot: null }, { installRoot: [] },
  ]) assert.throws(() => createVpsClaudeLaunchWriteCommand(roots), TypeError);
});

async function assertLaunchWrite(t, input) {
  const directory = await fs.realpath(await fs.mkdtemp(join(tmpdir(), "relmio-claude-write-")));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const guardRoot = join(directory, "docker");
  const installRoot = join(guardRoot, "n8n-openai-oauth");
  const root = join(installRoot, "claude");
  const bin = join(directory, "bin");
  await fs.mkdir(root, { recursive: true });
  await fs.mkdir(bin);
  const adapter = join(bin, "coreutils.cjs");
  // Production runs GNU coreutils on a Linux VPS. Exercise the same shell on macOS
  // with real file modes, fsync and rename; only root-only chown ownership is virtual.
  await fs.writeFile(adapter, `const fs = require("node:fs");
const [command, ...args] = process.argv.slice(2);
if (command === "chown") {
  if (args.join(" ") !== "-h 10001:10001 launch.json.next") process.exit(2);
  const s = fs.lstatSync(args[2]); if (!s.isFile() || s.isSymbolicLink()) process.exit(1);
} else if (command === "stat") {
  if (args[0] !== "-c" || args[1] !== "%u:%g:%a:%h") process.exit(2);
  const s = fs.lstatSync(args[2]); process.stdout.write("10001:10001:" + (s.mode & 4095).toString(8) + ":" + s.nlink);
} else if (command === "sync") {
  const fd = fs.openSync(args[0], "r"); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
} else if (command === "mv") {
  if (args[0] !== "-fT") process.exit(2); fs.renameSync(args[1], args[2]);
} else process.exit(2);
`);
  const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
  for (const name of ["chown", "stat", "sync", "mv"]) {
    await fs.writeFile(join(bin, name), `#!/bin/sh\nexec ${quote(process.execPath)} ${quote(adapter)} ${name} "$@"\n`, { mode: 0o755 });
    await fs.chmod(join(bin, name), 0o755);
  }
  const path = join(root, "launch.json");
  await fs.writeFile(path, "previous approval\n", { mode: 0o600 });
  const command = createVpsClaudeLaunchWriteCommand({ guardRoot, installRoot });
  const execute = () => spawnSync("sh", ["-c", command], { input, encoding: "utf8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } });
  const result = execute();
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await fs.readFile(path, "utf8"), input);
  assert.equal((await fs.stat(path)).mode & 0o777, 0o600);
  await assert.rejects(() => fs.lstat(join(root, "launch.json.next")), { code: "ENOENT" });
  const detached = join(installRoot, "saved-claude");
  await fs.rename(root, detached);
  await fs.writeFile(join(detached, "launch.json"), "guard sentinel\n");
  const before = await fs.lstat(join(detached, "launch.json"));
  await fs.symlink(detached, root);
  assert.notEqual(execute().status, 0);
  assert.equal(await fs.readFile(join(detached, "launch.json"), "utf8"), "guard sentinel\n");
  assert.equal((await fs.lstat(join(detached, "launch.json"))).ino, before.ino);
}

test("an edited approval cannot be renewed; replacing the companion writes a fresh one", async () => {
  const vps = createVps();
  await install(vps);
  const launch = vps.files.get("launch.json");
  launch.contents = JSON.stringify({ ...JSON.parse(launch.contents), port: 15000 });
  const status = await getVpsClaudeStatus({ remote: vps.remote, now });
  assert.deepEqual([status.state, status.installation.expiresAt, status.installation.approvalExpired], ["installed", null, true]);
  await assert.rejects(reviewVpsClaude({ remote: vps.remote, action: "renew", review, now }), /cannot be renewed/u);
  const plan = await reviewVpsClaude({ remote: vps.remote, action: "replace", ...selected, models, review, now });
  await applyVpsClaude({ remote: vps.remote, plan, confirmed: true }, { now, entropy: (size) => Buffer.alloc(size, 9) });
  assert.equal(JSON.parse(vps.files.get("launch.json").contents).port, 14502);
  assert.equal((await getVpsClaudeStatus({ remote: vps.remote, now })).installation.approvalExpired, false);
});

test("the terminal sign-in command uses the verified SSH destination and refuses unsafe values", () => {
  assert.equal(vpsClaudeLoginCommand({ host: "vps.example", port: 22, username: "root" }), `ssh -t root@vps.example sh ${ROOT}/login.sh`);
  assert.equal(vpsClaudeLoginCommand({ host: "203.0.113.7", port: 2222, username: "root" }), `ssh -t -p 2222 root@203.0.113.7 sh ${ROOT}/login.sh`);
  for (const unsafe of [{ host: "vps.example;id" }, { host: "-oProxyCommand=id" }, { username: "root;id" }, { port: "22 -o x" }]) {
    assert.throws(() => vpsClaudeLoginCommand({ host: "vps.example", port: 22, username: "root", ...unsafe }), /invalid/u);
  }
});

const servicePlan = (args) => ({
  action: args.action, installDirectory: ROOT, endpoint: ENDPOINT, existingN8nChanges: [], restarts: 0, publishedPorts: [],
  operationLockPath: LOCK, installId: null,
  containerName: args.containerName ?? null, networkName: args.networkName ?? null,
  containerId: args.containerName ? n8nId : null, networkId: args.networkName ? networkId : null,
  ...(args.review ? { review: args.review } : {}),
  network: selected.networkName, arch: "amd64", models, version: "2.1.317", executableSha256: "e".repeat(64),
  expiresAt: ["sign-out", "remove"].includes(args.action) ? null : approvalUntil(NOW),
  keepsClaudeLogin: ["replace", "renew"].includes(args.action),
});

async function serverFixture(t, configure = () => {}) {
  const token = "t".repeat(43);
  const calls = { review: [], apply: [] };
  let freshContainerId = n8nId;
  const services = {
    getAuthStatus: async () => { throw new Error("Claude must not request local ChatGPT credentials"); },
    scanHostFingerprint: async () => `SHA256:${"a".repeat(43)}`,
    connectVerified: async (request) => verifiedSshFixture(request),
    discoverN8n: async () => ({ containers: [{ id: n8nId, name: selected.containerName, image: "n8nio/n8n", state: "running" }] }),
    discoverNetworks: async () => ({ networks: [selected.networkName], instanceAi: { status: "missing" } }),
    reviewVpsClaude: async ({ remote, ...args }) => {
      assert.ok(remote);
      calls.review.push(args);
      return { ...servicePlan(args), ...(args.containerName ? { containerId: freshContainerId } : {}) };
    },
    applyVpsClaude: async (args) => {
      calls.apply.push(args);
      return { state: "installed", clientKey: "k".repeat(43), expiresAt: approvalUntil(NOW), installId: "f".repeat(32) };
    },
    getVpsClaudeStatus: async () => ({ state: "absent", installation: null, candidate: {
      version: "2.1.317", arch: "amd64", platform: "linux-x64", executableSha256: "e".repeat(64), executable: "/opt/claude/2.1.317/claude",
    } }),
    getVpsClaudeAuthStatus: async () => ({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "max", email: "owner@example.test" }),
    discoverVpsClaudeModels: async () => ({ models, status: 200 }),
    reviewVpsSuperGrok: async (args) => ({ ...selected, action: args.action, containerId: n8nId, networkId, installId: null, publishedPorts: [],
      operationLockPath: "/docker/n8n-openai-oauth/.supergrok-operation.lock",
      temporaryBuildStatePath: "/docker/n8n-openai-oauth/.supergrok-operation.lock/buildx" }),
    installVpsSuperGrok: async () => { throw new Error("SuperGrok must not install in Claude tests"); },
  };
  configure(services);
  const server = await startWizardServer({ sessionToken: token, services, uiFiles: { "/": "test" } });
  t.after(() => server.close());
  const headers = (authenticated) => ({ Origin: server.origin, ...(authenticated ? { "X-Setup-Token": token } : {}) });
  const post = async (path, body = {}, authenticated = true) => fetch(server.origin + path, {
    method: "POST", headers: { ...headers(authenticated), "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  const get = async (path) => fetch(server.origin + path, { headers: headers(true) });
  const scan = await (await post("/api/ssh/fingerprint", { host: "fixture.example", port: 22 })).json();
  assert.equal((await post("/api/ssh/connect", { host: "fixture.example", port: 22, username: "root", useAgent: false,
    privilege: "root", password: "fixture-only", expectedFingerprint: scan.fingerprint })).status, 200);
  assert.equal((await post("/api/discover")).status, 200);
  assert.equal((await post("/api/networks", { containerName: selected.containerName })).status, 200);
  return { post, get, calls, changeContainer: () => { freshContainerId = "d".repeat(64); } };
}

const PLAN_KEYS = ["action", "installDirectory", "endpoint", "network", "arch", "models", "version", "executableSha256", "expiresAt",
  "keepsClaudeLogin", "existingN8nChanges", "restarts", "publishedPorts", "operationLockPath"].sort();

test("the Claude API needs the session token and the four answers, shows only the plan contract and applies once", async (t) => {
  const f = await serverFixture(t);
  const install = { action: "install", ...selected, models, review };
  assert.equal((await f.post("/api/vps/claude/plan", install, false)).status, 401);
  for (const body of [{ action: "install", ...selected, models }, { action: "renew" }, { ...install, extra: true },
    { action: "remove", review }, { action: "restart-n8n" }, { ...install, containerName: "undiscovered-n8n" }]) {
    assert.equal((await f.post("/api/vps/claude/plan", body)).status, 400, JSON.stringify(body));
  }
  assert.equal(f.calls.review.length, 0);

  const reviewed = await f.post("/api/vps/claude/plan", install);
  assert.equal(reviewed.status, 200);
  const { planId, plan } = await reviewed.json();
  assert.deepEqual(Object.keys(plan).sort(), PLAN_KEYS);
  assert.doesNotMatch(JSON.stringify(plan), new RegExp(n8nId, "u"));
  assert.equal((await f.post("/api/vps/claude/apply", { planId, confirmed: false })).status, 400);
  assert.equal((await f.post("/api/vps/claude/apply", { planId: "forged", confirmed: true })).status, 400);
  assert.equal((await f.post("/api/vps/claude/apply", { planId, confirmed: true, review })).status, 400);
  assert.equal(f.calls.apply.length, 0);

  const applied = await f.post("/api/vps/claude/apply", { planId, confirmed: true });
  assert.equal(applied.status, 200);
  assert.deepEqual(await applied.json(), { state: "installed", clientKey: "k".repeat(43), expiresAt: approvalUntil(NOW) });
  assert.equal(f.calls.apply.length, 1);
  assert.equal(f.calls.apply[0].confirmed, true);
  assert.equal(Object.hasOwn(f.calls.apply[0].plan, "planId"), false);
  assert.deepEqual(f.calls.apply[0].plan.review, review);
  assert.notEqual((await f.post("/api/vps/claude/apply", { planId, confirmed: true })).status, 200);
  assert.equal(f.calls.apply.length, 1);
});

test("a replaced n8n container, rediscovery and other provider reviews invalidate a reviewed Claude plan", async (t) => {
  const f = await serverFixture(t);
  const install = { action: "install", ...selected, models, review };
  let { planId } = await (await f.post("/api/vps/claude/plan", install)).json();
  f.changeContainer();
  assert.notEqual((await f.post("/api/vps/claude/apply", { planId, confirmed: true })).status, 200);

  ({ planId } = await (await f.post("/api/vps/claude/plan", install)).json());
  assert.equal((await f.post("/api/discover")).status, 200);
  assert.notEqual((await f.post("/api/vps/claude/apply", { planId, confirmed: true })).status, 200);

  assert.equal((await f.post("/api/networks", { containerName: selected.containerName })).status, 200);
  ({ planId } = await (await f.post("/api/vps/claude/plan", install)).json());
  assert.equal((await f.post("/api/vps/supergrok/plan", { ...selected, action: "install" })).status, 200);
  assert.notEqual((await f.post("/api/vps/claude/apply", { planId, confirmed: true })).status, 200);

  const grok = await (await f.post("/api/vps/supergrok/plan", { ...selected, action: "install" })).json();
  assert.equal((await f.post("/api/vps/claude/plan", { action: "remove" })).status, 200);
  assert.notEqual((await f.post("/api/vps/supergrok/apply", { ...grok, confirmed: true })).status, 200);
  assert.equal(f.calls.apply.length, 0);
});

test("Claude status, sign-in check and model check pass only contract fields to the browser", async (t) => {
  const f = await serverFixture(t);
  const status = await f.get("/api/vps/claude/status");
  assert.equal(status.status, 200);
  assert.deepEqual(await status.json(), {
    state: "absent", installation: null,
    candidate: { version: "2.1.317", arch: "amd64", platform: "linux-x64", executableSha256: "e".repeat(64) },
    loginCommand: `ssh -t root@fixture.example sh ${ROOT}/login.sh`,
  });
  const auth = await f.post("/api/vps/claude/auth-status", {});
  assert.deepEqual(await auth.json(), { loggedIn: true, authMethod: "claude.ai", subscriptionType: "max" });
  assert.equal((await f.post("/api/vps/claude/auth-status", { email: true })).status, 400);
  const listed = await f.post("/api/vps/claude/models", { clientKey: "k".repeat(43) });
  assert.deepEqual(await listed.json(), { models });
  assert.equal((await f.post("/api/vps/claude/models", { clientKey: "k".repeat(43), installId: "x" })).status, 400);
});

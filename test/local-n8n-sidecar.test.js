import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import * as fs from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import {
  createLocalN8nSidecarPlan, normalizeLocalN8nSidecarPlan,
  createLocalN8nSidecarComposeFile,
} from "../src/domain/local-n8n-sidecar.js";
import {
  getLocalN8nSidecarStatus, getLocalN8nSidecarUsage, installLocalN8nSidecar,
  inspectStoppedLocalN8nSiwcInstallation, manageLocalN8nSiwcInstallation,
  resolveLocalN8nSidecarInstallRoot, reviewLocalN8nLegacyMigration,
  reviewLocalN8nSiwcReplacement, reviewLocalN8nSiwcResume, reconcileLocalN8nSiwcHandoff,
} from "../src/services/local-n8n-sidecar-installer.js";
import { CODEX_CLI_VERSION, createModelDiscovery, runModelDiscoveryCli } from "../src/services/model-discovery.mjs";
import { runSiwcHandoffCli } from "../src/services/siwc-handoff.mjs";
import {
  commitAuthorization, getAccessToken, listRegistrations, setPlanEnabled, readRegistration,
} from "../src/services/siwc-session.mjs";
import { withTestLocalSecurity } from "./helpers/local-security.js";

const DOCKER_HOST = process.platform === "win32"
  ? "npipe:////./pipe/dockerDesktopLinuxEngine" : "unix:///var/run/docker.sock";
const N8N_ID = "a".repeat(64);
const NETWORK_ID = "b".repeat(64);
const SIDECAR_ID = "c".repeat(64);
const installId = "d".repeat(32);
const projectName = `relmio-n8n-openai-oauth-${installId}`;
const registrationId = "registration_local_n8n";
const consent = {
  acceptedAt: "2026-10-04T00:00:00.000Z",
  noticeVersion: "siwc-local-2026-10-04",
};

async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "relmio-n8n-siwc-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const homeDirectory = join(root, "user");
  await (await import("node:fs/promises")).mkdir(homeDirectory);
  const registration = { storageRoot: join(root, "source"), registrationId };
  const destinationRoot = join(root, "destination");
  const connected = await commitAuthorization({
    ...registration, clientId: "oaiapp_local_n8n", runtimeId: "wizard",
    identity: { issuer: "https://auth.openai.com", subject: randomUUID() },
    tokens: {
      access_token: "fake-local-access", refresh_token: "fake-local-refresh",
      token_type: "Bearer", expires_in: 3600,
      scope: "openid profile offline_access resource.invoke chatgpt.tokens.use.direct",
    },
  });
  const enabled = await setPlanEnabled(registration, {
    enabled: true, expectedGeneration: connected.generation,
  });
  const authBinding = {
    registrationId, clientId: "oaiapp_local_n8n", generation: enabled.generation,
    ownerHostId: enabled.ownerHostId, ownerRuntimeId: enabled.ownerRuntimeId,
  };
  const plan = createLocalN8nSidecarPlan({
    dockerHost: DOCKER_HOST, n8nContainerId: N8N_ID,
    n8nContainerName: "relmio-test-n8n", dockerNetworkId: NETWORK_ID,
    networkName: "relmio-test-assistant-shared", authBinding,
  });
  return { homeDirectory, registration, destinationRoot, authBinding, plan };
}

const fakeRevocationProvider = async url => {
  if (url.endsWith("/.well-known/openid-configuration")) {
    return Response.json({
      issuer: "https://auth.openai.com",
      authorization_endpoint: "https://auth.openai.com/api/accounts/authorize",
      token_endpoint: "https://auth.openai.com/api/accounts/oauth/token",
      jwks_uri: "https://auth.openai.com/.well-known/jwks.json",
      revocation_endpoint: "https://auth.openai.com/api/accounts/oauth/revoke",
    });
  }
  if (url.endsWith("/api/accounts/oauth/revoke")) return new Response(null, { status: 200 });
  throw new Error("Unexpected provider request in local fixture.");
};

function fakeDocker(destinationRoot, {
  rejectAccept = false, networkDrift = false, contextHost = DOCKER_HOST,
  catalogFailed = false, failStart = false, publishedHostPort = false,
  projectInstallId = installId, selectedRegistrationId = registrationId,
  containerId = SIDECAR_ID, loseAcceptAck = false,
} = {}) {
  const calls = [];
  let imageBuilt = false;
  let volumeReady = false;
  let volumeName = "siwc-store";
  let installed = false;
  let running = false;
  const projectName = `relmio-n8n-openai-oauth-${projectInstallId}`;
  const labels = {
    "com.docker.compose.project": projectName,
    "io.relmio.managed": "true",
    "io.relmio.target": "n8n-openai-oauth",
    "io.relmio.install": projectInstallId,
  };
  const n8n = {
    Id: N8N_ID, Name: "/relmio-test-n8n",
    Config: { Image: "docker.n8n.io/n8nio/n8n:2.36.8", Labels: {} },
    State: { Running: true, Paused: false },
    NetworkSettings: { Networks: { "relmio-test-assistant-shared": {
      NetworkID: NETWORK_ID, Aliases: ["n8n", "relmio-test-n8n"],
    } } },
  };
  const sidecar = () => ({
    Id: containerId, Image: `sha256:${"7".repeat(64)}`,
    Name: `/${projectName}-openai-oauth-1`,
    Config: { Image: `${projectName}:local`, Labels: { ...labels,
      "com.docker.compose.service": "openai-oauth" } },
    State: { Running: running, Paused: false, Health: { Status: "healthy" } },
    NetworkSettings: {
      Networks: { "relmio-test-assistant-shared": {
        NetworkID: NETWORK_ID, Aliases: ["n8n-openai-oauth"],
      } },
      Ports: { "10531/tcp": null },
    },
    Mounts: [{ Type: "volume", Name: `${projectName}_${volumeName}`,
      Destination: volumeName === "siwc-store" ? "/home/node/.relmio-siwc" : "/home/node/.codex", RW: true }],
  });
  const cli = async (command, spec) => {
    let stdout = "";
    await runSiwcHandoffCli({
      command, storageRoot: destinationRoot, runtimeId: projectInstallId,
      registrationId: command === "accept" || command === "receipt"
        ? spec.args.find(arg => arg.startsWith("RELMIO_REGISTRATION_ID="))?.split("=")[1] : selectedRegistrationId,
      input: Readable.from(spec.input ? [spec.input] : []),
      output: { write(value) { stdout += value; } },
      sessionDeps: { fetchImpl: fakeRevocationProvider },
    });
    return { code: 0, stdout };
  };
  const runner = async spec => {
    calls.push(spec);
    const args = spec.args;
    const joined = args.join(" ");
    const ok = stdout => ({ code: 0, stdout, stderr: "" });
    if (joined === "context inspect --format {{json .Endpoints.docker.Host}}") return ok(`${JSON.stringify(contextHost)}\n`);
    if (joined === "context show") return ok("desktop-linux\n");
    if (args[0] === "container" && args[1] === "inspect") {
      if (args.at(-1) === N8N_ID && n8n.Id !== N8N_ID) return { code: 1, stdout: "", stderr: "old n8n container is gone" };
      return ok(JSON.stringify(args.at(-1) === n8n.Id ? n8n : sidecar()));
    }
    if (args[0] === "network" && args[1] === "inspect") {
      return ok(JSON.stringify({ Id: networkDrift ? "9".repeat(64) : NETWORK_ID,
        Name: "relmio-test-assistant-shared", Driver: "bridge", Scope: "local", Internal: false,
        Containers: { [n8n.Id]: { Name: n8n.Name.slice(1) },
          ...(running ? { [containerId]: { Name: `${projectName}-openai-oauth-1` } } : {}) } }));
    }
    if (args[0] === "ps" && args.includes(`label=com.docker.compose.project=${projectName}`)) {
      return ok(installed ? `${JSON.stringify({ ID: containerId })}\n` : "");
    }
    if (args[0] === "volume" && args[1] === "ls") {
      return ok(volumeReady ? `${JSON.stringify({ Name: `${projectName}_${volumeName}` })}\n` : "");
    }
    if (args[0] === "volume" && args[1] === "inspect") return ok(JSON.stringify(
      args.includes("{{json .Labels}}") ? labels : {
        Name: `${projectName}_${volumeName}`, Driver: "local", CreatedAt: "2026-10-04T00:00:00Z",
        Mountpoint: `/var/lib/docker/volumes/${projectName}_${volumeName}/_data`, Options: null, Labels: labels,
      }));
    if (args[0] === "image" && args[1] === "ls") {
      return ok(imageBuilt ? `${JSON.stringify({ Repository: projectName, Tag: "local" })}\n` : "");
    }
    if (args[0] === "image" && args[1] === "inspect") return ok(JSON.stringify(labels));
    if (joined.includes("ps --all -q openai-oauth") || joined.includes("ps -q openai-oauth")) {
      return ok(installed ? `${containerId}\n` : "");
    }
    if (joined.includes("ps --status running --services")) return ok(running ? "openai-oauth\n" : "");
    if (joined.includes("ps --format json openai-oauth") || joined.includes("ps --all --format json openai-oauth")) {
      return ok(JSON.stringify({ Name: `${projectName}-openai-oauth-1`, Service: "openai-oauth",
        State: running ? "running" : "exited", Health: "healthy",
        Publishers: [{ URL: publishedHostPort ? "0.0.0.0" : "",
          PublishedPort: publishedHostPort ? 10531 : 0 }] }));
    }
    if (joined.includes("config --format json")) return ok(JSON.stringify({
      services: { "openai-oauth": { image: `${projectName}:local`, volumes: [
        { type: "volume", source: volumeName, target: "/home/node/.relmio-siwc" },
      ] }, "credential-seed": {} },
      volumes: { [volumeName]: { name: `${projectName}_${volumeName}` } },
    }));
    if (args.includes("/app/services/siwc-handoff.mjs")) {
      const command = args.at(-1);
      if (command === "accept" && rejectAccept) throw new Error("Docker outcome unknown");
      if (command === "account" && !running && args.includes("exec")) return { code: 1, stdout: "", stderr: "" };
      const result = await cli(command, spec);
      if (command === "accept" && loseAcceptAck) throw new Error("Lost acknowledgment after commit");
      return result;
    }
    if (args.includes("-e") && args.includes("run")) {
      const compose = await readFile(join(spec.cwd, "docker-compose.yml"), "utf8");
      const hash = compose.match(/RELMIO_GATEWAY_TOKEN_SHA256: "([a-f0-9]{64})"/u)?.[1];
      assert.equal(createHash("sha256").update(spec.input).digest("hex"), hash);
      return catalogFailed
        ? { code: 1, stdout: JSON.stringify({ error: { code: "request_interrupted" } }), stderr: "" }
        : ok(JSON.stringify({ data: [{ id: "selected-model" }] }));
    }
    if (joined.includes("build openai-oauth")) { imageBuilt = true; return ok(""); }
    if (joined.includes("run --rm --no-deps -T credential-seed")) { volumeReady = true; return ok(""); }
    if (joined.includes("up -d --wait")) {
      if (failStart) return { code: 1, stdout: "", stderr: "start failed" };
      installed = true; running = true; return ok("");
    }
    if (joined.includes("stop --timeout 30 openai-oauth")) { running = false; return ok(""); }
    return ok("");
  };
  runner.calls = calls;
  runner.setVolumeName = name => { volumeName = name; };
  runner.isRunning = () => running;
  runner.setFailStart = value => { failStart = value; };
  runner.setRegistrationId = value => { selectedRegistrationId = value; };
  runner.setRejectAccept = value => { rejectAccept = value; };
  runner.recreateN8n = () => { n8n.Id = "9".repeat(64); n8n.Name = "/recreated-n8n"; };
  return runner;
}

async function legacyFixture(homeDirectory) {
  const oldInstallId = "e".repeat(32);
  const oldProject = `relmio-n8n-openai-oauth-${oldInstallId}`;
  const installRoot = await resolveLocalN8nSidecarInstallRoot({ homeDirectory, env: {} });
  const root = join(homeDirectory, ".relmio");
  await mkdir(installRoot, { recursive: true, mode: 0o700 });
  await writeFile(join(root, ".managed-by-relmio-root.json"),
    `${JSON.stringify({ schemaVersion: 1, kind: "relmio-local-root" })}\n`, { mode: 0o600 });
  const marker = {
    schemaVersion: 1, kind: "relmio-local-n8n-sidecar", target: "n8n-openai-oauth",
    installId: oldInstallId, projectName: oldProject, dockerHost: DOCKER_HOST,
    n8nContainerId: N8N_ID, n8nContainerName: "relmio-test-n8n",
    dockerNetworkId: NETWORK_ID, networkName: "relmio-test-assistant-shared",
  };
  for (const [filename, contents] of Object.entries({
    ".managed-by-relmio.json": `${JSON.stringify(marker)}\n`,
    "docker-compose.yml": "services:\n  openai-oauth:\n    image: legacy-owned\n",
    "Dockerfile": "FROM node:22-bookworm-slim\n",
    ".dockerignore": "**\n!Dockerfile\n",
    "openai-oauth-sidecar.mjs": "export const legacy = true;\n",
  })) await writeFile(join(installRoot, filename), contents, { mode: 0o600 });
  return { oldInstallId, oldProject, installRoot };
}

function fakeLegacyDocker(destinationRoot, { oldInstallId, oldProject, rejectAccept = false } = {}) {
  const fresh = fakeDocker(destinationRoot, { rejectAccept });
  const calls = [];
  const oldContainerId = "f".repeat(64);
  const oldVolumeName = `${oldProject}_oauth-auth`;
  let oldImageId = `sha256:${"7".repeat(64)}`;
  let oldRunning = true;
  let credentialMount = { Type: "volume", Name: oldVolumeName, Destination: "/home/node/.codex", RW: true };
  let createdAt = "2026-10-04T00:00:00Z";
  let composeSource = "oauth-auth";
  const labels = {
    "com.docker.compose.project": oldProject,
    "com.docker.compose.service": "openai-oauth",
    "io.relmio.managed": "true",
    "io.relmio.target": "n8n-openai-oauth",
    "io.relmio.install": oldInstallId,
  };
  const ok = stdout => ({ code: 0, stdout, stderr: "" });
  const runner = async spec => {
    calls.push(spec);
    const args = spec.args;
    const joined = args.join(" ");
    if (args[0] === "network" && args[1] === "inspect") {
      return ok(JSON.stringify({
        Id: NETWORK_ID, Name: "relmio-test-assistant-shared",
        Driver: "bridge", Scope: "local", Internal: false,
        Containers: {
          [N8N_ID]: { Name: "relmio-test-n8n" },
          ...(oldRunning ? { [oldContainerId]: { Name: `${oldProject}-openai-oauth-1` } } : {}),
        },
      }));
    }
    if (args[0] === "container" && args[1] === "inspect" && args.at(-1) === oldContainerId) {
      return ok(JSON.stringify({
        Id: oldContainerId, Image: oldImageId,
        Name: `/${oldProject}-openai-oauth-1`,
        Config: { Image: `${oldProject}:local`, Labels: labels },
        State: { Running: oldRunning, Paused: false, Health: { Status: "healthy" } },
        NetworkSettings: { Networks: { "relmio-test-assistant-shared": {
          NetworkID: NETWORK_ID, Aliases: ["n8n-openai-oauth"],
        } }, Ports: { "10531/tcp": null } },
        Mounts: [credentialMount],
      }));
    }
    if (args[0] === "ps" && args.includes(`label=com.docker.compose.project=${oldProject}`)) {
      return ok(`${JSON.stringify({ ID: oldContainerId })}\n`);
    }
    if (args[0] === "volume" && args.includes(`label=com.docker.compose.project=${oldProject}`)) {
      return ok(`${JSON.stringify({ Name: oldVolumeName })}\n`);
    }
    if (args[0] === "volume" && args[1] === "inspect" && args.at(-1) === oldVolumeName) {
      return ok(JSON.stringify(args.includes("{{json .Labels}}") ? labels : {
        Name: oldVolumeName, Driver: "local", CreatedAt: createdAt,
        Mountpoint: `/var/lib/docker/volumes/${oldVolumeName}/_data`, Options: null, Labels: labels,
      }));
    }
    if (args[0] === "image" && args[1] === "ls" &&
        args.some(value => value === `reference=${oldProject}:local`)) {
      return ok(`${JSON.stringify({ Repository: oldProject, Tag: "local" })}\n`);
    }
    if (args[0] === "image" && args[1] === "inspect" &&
        args.at(-1) === `${oldProject}:local`) return ok(JSON.stringify(labels));
    if (args.includes(oldProject)) {
      if (joined.includes("config --format json")) return ok(JSON.stringify({
        services: { "openai-oauth": { image: `${oldProject}:local`,
          volumes: [{ type: "volume", source: composeSource, target: "/home/node/.codex" }] } },
        volumes: { "oauth-auth": { name: oldVolumeName } },
      }));
      if (joined.includes("ps --all -q openai-oauth")) return ok(`${oldContainerId}\n`);
      if (joined.includes("stop --timeout 30 openai-oauth")) {
        oldRunning = false;
        return ok("");
      }
    }
    return fresh(spec);
  };
  runner.calls = calls;
  runner.oldVolumeName = oldVolumeName;
  runner.isOldRunning = () => oldRunning;
  runner.setOldImageId = value => { oldImageId = value; };
  runner.setOldMount = value => { credentialMount = value; };
  runner.setVolumeCreatedAt = value => { createdAt = value; };
  runner.setComposeSource = value => { composeSource = value; };
  return runner;
}

function deps(homeDirectory, runner) {
  return withTestLocalSecurity({
    env: {}, homeDirectory, runProcess: runner,
    randomBytes: () => Buffer.alloc(32, 0xdd),
  });
}

test("review binds selected account and exact n8n/container network identity", async t => {
  const { plan, authBinding, homeDirectory } = await fixture(t);
  assert.deepEqual(normalizeLocalN8nSidecarPlan(plan), plan);
  for (const invalid of [
    { ...plan, authBinding: { ...authBinding, generation: randomUUID() } },
    { ...plan, networkName: "other-network" },
    { ...plan, n8nContainerId: "e".repeat(64) },
  ]) await assert.rejects(() => installLocalN8nSidecar({
    plan: invalid, registration: { storageRoot: join(homeDirectory, "missing"), registrationId },
    backgroundConsent: consent, confirmed: false,
  }, deps(homeDirectory, fakeDocker(join(homeDirectory, "target")))));
  assert.throws(() => normalizeLocalN8nSidecarPlan({ ...plan, authBinding: { ...authBinding, clientId: "x\ny" } }));
});

test("private n8n install transfers one session, returns one bearer and never touches n8n", async t => {
  const { homeDirectory, registration, destinationRoot, plan } = await fixture(t);
  const runner = fakeDocker(destinationRoot);
  const result = await installLocalN8nSidecar({
    plan, registration, backgroundConsent: consent, confirmed: true,
  }, deps(homeDirectory, runner));
  assert.equal(result.account.registrationId, registrationId);
  assert.equal(result.account.ownerRuntimeId, installId);
  assert.equal(result.credentialShownOnce, true);
  assert.deepEqual(result.models, ["selected-model"]);
  const status = await getLocalN8nSidecarStatus(deps(homeDirectory, runner));
  assert.equal(status.snapshot.auth.configured, true);
  assert.equal(status.snapshot.auth.account.registrationId, registrationId);
  const source = (await listRegistrations({ storageRoot: registration.storageRoot }))[0];
  assert.equal(source.ownership, "transferred");
  await assert.rejects(() => getAccessToken(registration, { runtimeId: "wizard" }));
  const transfer = runner.calls.find(call => call.args.includes("/app/services/siwc-handoff.mjs") && call.args.at(-1) === "accept");
  assert.ok(Buffer.from(transfer.input).includes(Buffer.from("fake-local-refresh")));
  assert.equal(transfer.args.some(value => value.includes("fake-local-refresh")), false);
  assert.equal(runner.calls.some(call => call.args.includes("n8n") && call.args.includes("restart")), false);
  const installRoot = await resolveLocalN8nSidecarInstallRoot({ homeDirectory, env: {} });
  const compose = await readFile(join(installRoot, "docker-compose.yml"), "utf8");
  assert.equal(compose.includes("10531:10531"), false);
  assert.equal(compose.includes("fake-local-refresh"), false);
  assert.equal(compose, createLocalN8nSidecarComposeFile({ installId,
    networkName: plan.networkName, registrationId, tokenSha256: createHash("sha256").update(result.clientCredential).digest("hex") }));
});

test("ambiguous Docker acceptance leaves source frozen without credential rollback", async t => {
  const { homeDirectory, registration, destinationRoot, plan } = await fixture(t);
  const runner = fakeDocker(destinationRoot, { rejectAccept: true });
  await assert.rejects(() => installLocalN8nSidecar({
    plan, registration, backgroundConsent: consent, confirmed: true,
  }, deps(homeDirectory, runner)), /unresolved/);
  const [source] = await listRegistrations({ storageRoot: registration.storageRoot });
  assert.equal(source.ownership, "handoff-pending");
  await assert.rejects(() => getAccessToken(registration, { runtimeId: "wizard" }));
  assert.equal(runner.calls.some(call => call.args.includes("up") && call.args.includes("openai-oauth")), false);
});

test("wrong selected account or Docker network fails before protected transfer", async t => {
  const { homeDirectory, registration, destinationRoot, plan, authBinding } = await fixture(t);
  const runner = fakeDocker(destinationRoot, { networkDrift: true });
  await assert.rejects(() => installLocalN8nSidecar({
    plan, registration, backgroundConsent: consent, confirmed: true,
  }, deps(homeDirectory, runner)), /network|identity/i);
  assert.equal(runner.calls.some(call => call.args.includes("/app/services/siwc-handoff.mjs") && call.args.at(-1) === "accept"), false);
  const wrong = { ...plan, authBinding: { ...authBinding, clientId: "oaiapp_other" } };
  await assert.rejects(() => installLocalN8nSidecar({
    plan: wrong, registration, backgroundConsent: consent, confirmed: true,
  }, deps(homeDirectory, fakeDocker(destinationRoot))));
});

test("stopped owner inspection and disable require separate confirmations", async t => {
  const { homeDirectory, registration, destinationRoot, plan } = await fixture(t);
  const runner = fakeDocker(destinationRoot);
  await installLocalN8nSidecar({ plan, registration, backgroundConsent: consent, confirmed: true }, deps(homeDirectory, runner));
  const status = await getLocalN8nSidecarStatus(deps(homeDirectory, runner));
  await assert.rejects(() => manageLocalN8nSiwcInstallation({
    registrationId, action: "disable-plan", expectedGeneration: status.snapshot.auth.account.generation,
    confirmed: false,
  }, deps(homeDirectory, runner)));
  const result = await manageLocalN8nSiwcInstallation({
    registrationId, action: "disable-plan", expectedGeneration: status.snapshot.auth.account.generation,
    confirmed: true,
  }, deps(homeDirectory, runner));
  assert.equal(result.runtimeStopped, true);
  assert.equal(result.account.planEnabled, false);
  const stopped = await getLocalN8nSidecarStatus(deps(homeDirectory, runner));
  assert.equal(stopped.state, "stopped");
  assert.equal(stopped.snapshot.auth.configured, false);
  await assert.rejects(() => inspectStoppedLocalN8nSiwcInstallation({
    registrationId, confirmed: false,
  }, deps(homeDirectory, runner)));
  const inspected = await inspectStoppedLocalN8nSiwcInstallation({
    registrationId, confirmed: true,
  }, deps(homeDirectory, runner));
  assert.equal(inspected.account.generation, result.account.generation);
  await assert.rejects(() => manageLocalN8nSiwcInstallation({
    registrationId, action: "enable-plan",
    expectedGeneration: inspected.account.generation, confirmed: true,
  }, deps(homeDirectory, runner)), /consent/i);
  const enabled = await manageLocalN8nSiwcInstallation({
    registrationId, action: "enable-plan",
    expectedGeneration: inspected.account.generation,
    backgroundConsent: true, confirmed: true,
  }, deps(homeDirectory, runner));
  assert.equal(enabled.account.planEnabled, true);
  assert.equal(enabled.runtimeStopped, false);
  assert.equal((await getLocalN8nSidecarStatus(deps(homeDirectory, runner))).snapshot.auth.configured, true);
});

test("local usage reads only the running owned sidecar's counts, with its read-only command", async t => {
  const { homeDirectory, registration, destinationRoot, plan } = await fixture(t);
  const runner = fakeDocker(destinationRoot);
  assert.equal(await getLocalN8nSidecarUsage(deps(homeDirectory, runner)), undefined, "nothing is installed");
  await installLocalN8nSidecar({ plan, registration, backgroundConsent: consent, confirmed: true }, deps(homeDirectory, runner));
  const reads = [];
  // The fake container runs the real usage command against its own SIWC storage.
  const container = async spec => {
    if (!spec.args.includes("/app/services/model-discovery.mjs")) return runner(spec);
    reads.push(spec);
    const output = { text: "", write(chunk) { this.text += chunk; } };
    const code = await runModelDiscoveryCli({ command: spec.args.at(-1), output,
      env: { N8N_OPENAI_OAUTH_HOME: destinationRoot, RELMIO_REGISTRATION_ID: registrationId, RELMIO_RUNTIME_ID: installId } });
    return { code, stdout: output.text, stderr: "" };
  };
  assert.equal(await getLocalN8nSidecarUsage(deps(homeDirectory, container)), null, "nothing is recorded yet");
  assert.deepEqual(reads.at(-1).args, ["compose", "--project-name", projectName, "--file", "docker-compose.yml",
    "exec", "-T", "openai-oauth", "node", "/app/services/model-discovery.mjs", "usage"]);

  const discovery = createModelDiscovery({ storageRoot: destinationRoot, registrationId, pinnedClientVersion: CODEX_CLI_VERSION,
    getLease: async () => ({ accessToken: "fake-unused-access-token" }) });
  discovery.recordActivity({ model: "selected-model", accepted: true, outcome: "completed",
    usage: { input_tokens: 3, output_tokens: 4 } });
  await discovery.close();
  const record = await getLocalN8nSidecarUsage(deps(homeDirectory, container));
  assert.equal(record.registrationId, registrationId);
  assert.deepEqual(Object.values(record.days).map(day => day["selected-model"].total), [7]);
  const older = async spec => spec.args.includes("/app/services/model-discovery.mjs")
    ? { code: 1, stdout: JSON.stringify({ error: "invalid_command", message: "Unknown command." }), stderr: "" }
    : runner(spec);
  assert.equal(await getLocalN8nSidecarUsage(deps(homeDirectory, older)), null, "an older sidecar reads as empty");

  const status = await getLocalN8nSidecarStatus(deps(homeDirectory, runner));
  await manageLocalN8nSiwcInstallation({ registrationId, action: "disable-plan",
    expectedGeneration: status.snapshot.auth.account.generation, confirmed: true }, deps(homeDirectory, runner));
  const before = reads.length;
  assert.equal(await getLocalN8nSidecarUsage(deps(homeDirectory, container)), undefined, "a stopped sidecar is not read");
  assert.equal(reads.length, before);
});

test("Windows sidecar asset ACL drift blocks status before inspecting the runtime", async t => {
  const { homeDirectory, registration, destinationRoot, plan } = await fixture(t);
  const contextHost = "npipe:////./pipe/dockerDesktopLinuxEngine";
  const runner = fakeDocker(destinationRoot, { contextHost });
  const selectedPlan = { ...plan, dockerHost: contextHost };
  await installLocalN8nSidecar({
    plan: selectedPlan, registration, backgroundConsent: consent, confirmed: true,
  }, withTestLocalSecurity({
    ...deps(homeDirectory, runner), platform: "win32", lockDownPath: async () => {},
  }));
  const before = runner.calls.length;
  const status = await getLocalN8nSidecarStatus(withTestLocalSecurity({
    ...deps(homeDirectory, runner),
    platform: "win32",
    lockDownPath: async (path, options) => {
      if (path.endsWith("siwc-session.mjs") && options.verifyOnly) {
        throw new Error("Inherited ACL entry grants another user access");
      }
    },
  }));
  assert.equal(status.state, "unavailable");
  assert.equal(runner.calls.slice(before).some(call =>
    call.args.includes("exec") || call.args.includes("run") || call.args.includes("up")), false);
});

for (const module of ["codex-images.mjs", "model-discovery.mjs"]) {
  test(`Windows sidecar status verifies ${module} when present and accepts installs made before it`, async t => {
    const { homeDirectory, registration, destinationRoot, plan } = await fixture(t);
    const contextHost = "npipe:////./pipe/dockerDesktopLinuxEngine";
    const runner = fakeDocker(destinationRoot, { contextHost });
    const permitted = () => withTestLocalSecurity({
      ...deps(homeDirectory, runner), platform: "win32", lockDownPath: async () => {},
    });
    await installLocalN8nSidecar({
      plan: { ...plan, dockerHost: contextHost }, registration, backgroundConsent: consent, confirmed: true,
    }, permitted());
    const baseline = await getLocalN8nSidecarStatus(permitted());
    assert.notEqual(baseline.state, "unavailable");
    let optionalModule;
    const restricted = () => withTestLocalSecurity({
      ...deps(homeDirectory, runner),
      platform: "win32",
      lockDownPath: async (path, options) => {
        if (path.endsWith(module) && options.verifyOnly) {
          optionalModule = path;
          throw new Error("Inherited ACL entry grants another user access");
        }
      },
    });
    assert.equal((await getLocalN8nSidecarStatus(restricted())).state, "unavailable");
    await rm(optionalModule);
    assert.equal((await getLocalN8nSidecarStatus(restricted())).state, baseline.state);
  });
}

test("legacy local n8n marker is shown as migration-required without importing its credential", async t => {
  const { homeDirectory, registration, destinationRoot, plan } = await fixture(t);
  const runner = fakeDocker(destinationRoot);
  await installLocalN8nSidecar({
    plan, registration, backgroundConsent: consent, confirmed: true,
  }, deps(homeDirectory, runner));
  const installRoot = await resolveLocalN8nSidecarInstallRoot({ homeDirectory, env: {} });
  const markerPath = join(installRoot, ".managed-by-relmio.json");
  const marker = JSON.parse(await readFile(markerPath, "utf8"));
  marker.schemaVersion = 1;
  await writeFile(markerPath, `${JSON.stringify(marker)}\n`, { mode: 0o600 });
  runner.setVolumeName("oauth-auth");
  const before = runner.calls.length;
  const status = await getLocalN8nSidecarStatus(deps(homeDirectory, runner));
  assert.equal(status.state, "legacy");
  assert.equal(status.snapshot.migrationRequired, true);
  assert.equal(status.snapshot.auth.configured, false);
  assert.equal(Object.hasOwn(status.snapshot.auth, "account"), false);
  assert.equal(runner.calls.slice(before).some(call => call.args.includes("/app/services/siwc-handoff.mjs")), false);
});

test("confirmed installed-owner sign-out revokes at the destination and clears only its tokens", async t => {
  const { homeDirectory, registration, destinationRoot, plan } = await fixture(t);
  const runner = fakeDocker(destinationRoot);
  await installLocalN8nSidecar({
    plan, registration, backgroundConsent: consent, confirmed: true,
  }, deps(homeDirectory, runner));
  const current = await getLocalN8nSidecarStatus(deps(homeDirectory, runner));
  const result = await manageLocalN8nSiwcInstallation({
    registrationId, action: "sign-out",
    expectedGeneration: current.snapshot.auth.account.generation,
    confirmed: true,
  }, deps(homeDirectory, runner));
  assert.equal(result.revocation, "confirmed");
  assert.equal(result.account.session, "signed-out");
  assert.equal(result.runtimeStopped, true);
  await assert.rejects(() => getAccessToken({
    storageRoot: destinationRoot, registrationId,
  }, { runtimeId: installId }));
  const transferred = (await listRegistrations({ storageRoot: registration.storageRoot }))[0];
  assert.equal(transferred.ownership, "transferred");
});

test("reviewed local n8n migration stops only the old sidecar and keeps its OAuth volume offline", async t => {
  const { homeDirectory, registration, destinationRoot, plan } = await fixture(t);
  const { oldInstallId, oldProject, installRoot } = await legacyFixture(homeDirectory);
  const runner = fakeLegacyDocker(destinationRoot, { oldInstallId, oldProject });
  const legacyBinding = await reviewLocalN8nLegacyMigration({ plan }, deps(homeDirectory, runner));
  assert.equal(legacyBinding.running, true);
  assert.equal(legacyBinding.containerId, "f".repeat(64));
  assert.equal(legacyBinding.volumeName, `${oldProject}_oauth-auth`);
  const result = await installLocalN8nSidecar({
    plan, registration, backgroundConsent: consent, confirmed: true,
    migrationConsent: true, legacyBinding,
  }, deps(homeDirectory, runner));
  assert.equal(result.deploymentMode, "migrated");
  assert.equal(result.legacyRetained, true);
  assert.equal(result.account.ownerRuntimeId, installId);
  assert.equal(runner.isOldRunning(), false);
  assert.equal(runner.calls.filter(call => call.args.includes("stop")).length, 1);
  assert.equal(runner.calls.some(call => call.args.includes("n8n") && call.args.includes("restart")), false);
  assert.equal(runner.calls.some(call => call.args.includes("down") || call.args.includes("rm")), false);
  const archive = join(installRoot, "legacy", oldInstallId);
  assert.equal(JSON.parse(await readFile(join(archive, "migration.json"), "utf8")).state, "transferred");
  assert.equal(JSON.parse(await readFile(join(archive, ".managed-by-relmio.json"), "utf8")).installId, oldInstallId);
  const compose = await readFile(join(installRoot, "docker-compose.yml"), "utf8");
  assert.equal(compose.includes("siwc-store:/home/node/.relmio-siwc"), true);
  assert.equal(compose.includes(oldProject), false);
});

test("legacy n8n migration rejects stale image/consent before stopping the old writer", async t => {
  const { homeDirectory, registration, destinationRoot, plan } = await fixture(t);
  const { oldInstallId, oldProject, installRoot } = await legacyFixture(homeDirectory);
  const runner = fakeLegacyDocker(destinationRoot, { oldInstallId, oldProject });
  const legacyBinding = await reviewLocalN8nLegacyMigration({ plan }, deps(homeDirectory, runner));
  const before = runner.calls.length;
  await assert.rejects(() => installLocalN8nSidecar({
    plan, registration, backgroundConsent: consent, confirmed: true,
    migrationConsent: false, legacyBinding,
  }, deps(homeDirectory, runner)));
  assert.equal(runner.calls.length, before);
  runner.setOldImageId(`sha256:${"9".repeat(64)}`);
  await assert.rejects(() => installLocalN8nSidecar({
    plan, registration, backgroundConsent: consent, confirmed: true,
    migrationConsent: true, legacyBinding,
  }, deps(homeDirectory, runner)), /changed/i);
  assert.equal(runner.isOldRunning(), true);
  assert.equal(JSON.parse(await readFile(join(installRoot, ".managed-by-relmio.json"), "utf8")).schemaVersion, 1);
});

test("unknown local n8n migration receipt leaves old volume offline and sender frozen", async t => {
  const { homeDirectory, registration, destinationRoot, plan } = await fixture(t);
  const { oldInstallId, oldProject, installRoot } = await legacyFixture(homeDirectory);
  const runner = fakeLegacyDocker(destinationRoot, { oldInstallId, oldProject, rejectAccept: true });
  const legacyBinding = await reviewLocalN8nLegacyMigration({ plan }, deps(homeDirectory, runner));
  await assert.rejects(() => installLocalN8nSidecar({
    plan, registration, backgroundConsent: consent, confirmed: true,
    migrationConsent: true, legacyBinding,
  }, deps(homeDirectory, runner)), /unresolved/i);
  assert.equal(runner.isOldRunning(), false);
  assert.equal(JSON.parse(await readFile(join(installRoot, "legacy", oldInstallId, "migration.json"), "utf8")).state, "stopped");
  assert.equal((await listRegistrations({ storageRoot: registration.storageRoot }))[0].ownership, "handoff-pending");
  const status = await getLocalN8nSidecarStatus(deps(homeDirectory, runner));
  assert.equal(status.state, "staged");
  assert.equal(status.staging.stage, "handoff-pending");
  assert.equal(status.staging.registrationId, registrationId);
});

test("local n8n consent binds the reviewed local notice before any Docker operation", async t => {
  const { homeDirectory, registration, destinationRoot, plan } = await fixture(t);
  const runner = fakeDocker(destinationRoot);
  await assert.rejects(() => installLocalN8nSidecar({
    plan, registration, backgroundConsent: {
      ...consent, noticeVersion: "siwc-vps-2026-10-04",
    }, confirmed: true,
  }, deps(homeDirectory, runner)));
  assert.equal(runner.calls.length, 0);
});

test("reviewed n8n account replacement keeps old signed-out volume offline", async t => {
  const { homeDirectory, registration, destinationRoot, plan } = await fixture(t);
  const oldRunner = fakeDocker(destinationRoot);
  await installLocalN8nSidecar({
    plan, registration, backgroundConsent: consent, confirmed: true,
  }, deps(homeDirectory, oldRunner));
  const current = await getLocalN8nSidecarStatus(deps(homeDirectory, oldRunner));
  const signedOut = await manageLocalN8nSiwcInstallation({
    registrationId, action: "sign-out",
    expectedGeneration: current.snapshot.auth.account.generation, confirmed: true,
  }, deps(homeDirectory, oldRunner));
  assert.equal(signedOut.account.session, "signed-out");
  const nextId = "registration_n8n_next";
  const next = { storageRoot: registration.storageRoot, registrationId: nextId };
  const connected = await commitAuthorization({
    ...next, clientId: "oaiapp_n8n_next", runtimeId: "wizard",
    identity: { issuer: "https://auth.openai.com", subject: randomUUID() },
    tokens: {
      access_token: "next-n8n-access", refresh_token: "next-n8n-refresh",
      token_type: "Bearer", expires_in: 3600,
      scope: "openid profile offline_access resource.invoke chatgpt.tokens.use.direct",
    },
  });
  const enabled = await setPlanEnabled(next, {
    enabled: true, expectedGeneration: connected.generation,
  });
  const nextPlan = {
    ...plan,
    authBinding: {
      registrationId: nextId, clientId: "oaiapp_n8n_next",
      generation: enabled.generation,
      ownerHostId: enabled.ownerHostId, ownerRuntimeId: enabled.ownerRuntimeId,
    },
  };
  const newInstallId = "e".repeat(32);
  const newRoot = `${destinationRoot}-next`;
  const newRunner = fakeDocker(newRoot, {
    projectInstallId: newInstallId,
    selectedRegistrationId: nextId,
    containerId: "9".repeat(64),
  });
  const oldProject = `relmio-n8n-openai-oauth-${installId}`;
  const newProject = `relmio-n8n-openai-oauth-${newInstallId}`;
  const calls = [];
  const runner = async spec => {
    calls.push(spec);
    const args = spec.args;
    if (args[0] === "network" && args[1] === "inspect") {
      return newRunner.isRunning() ? newRunner(spec) : oldRunner(spec);
    }
    if (args.some(value => value.includes(oldProject)) ||
        args.at(-1) === SIDECAR_ID) return oldRunner(spec);
    if (args.some(value => value.includes(newProject)) ||
        args.at(-1) === "9".repeat(64)) return newRunner(spec);
    return oldRunner(spec);
  };
  runner.calls = calls;
  const reviewed = await reviewLocalN8nSiwcReplacement({
    plan: nextPlan,
  }, deps(homeDirectory, runner));
  const existingBinding = { ...reviewed, expectedGeneration: signedOut.account.generation };
  await assert.rejects(() => installLocalN8nSidecar({
    plan: nextPlan, registration: next, backgroundConsent: consent, confirmed: true,
    replacementConsent: false, existingBinding,
  }, deps(homeDirectory, runner)));
  const result = await installLocalN8nSidecar({
    plan: nextPlan, registration: next, backgroundConsent: consent, confirmed: true,
    replacementConsent: true, existingBinding,
  }, withTestLocalSecurity({
    ...deps(homeDirectory, runner), randomBytes: () => Buffer.alloc(32, 0xee),
  }));
  assert.equal(result.deploymentMode, "replaced");
  assert.equal(result.replacedAccount, true);
  assert.equal(result.account.ownerRuntimeId, newInstallId);
  assert.equal((await listRegistrations({ storageRoot: destinationRoot }))[0].session, "signed-out");
  assert.equal((await listRegistrations({ storageRoot: newRoot }))[0].ownership, "owned");
  assert.equal(calls.some(call => call.args.includes("down") || call.args.includes("rm")), false);
});

test("local n8n catalog outage keeps the installed account and one-time bearer recoverable", async t => {
  const { homeDirectory, registration, destinationRoot, plan } = await fixture(t);
  const runner = fakeDocker(destinationRoot, { catalogFailed: true });
  const installed = await installLocalN8nSidecar({
    plan, registration, backgroundConsent: consent, confirmed: true,
  }, deps(homeDirectory, runner));
  assert.equal(installed.readiness, "unverified");
  assert.deepEqual(installed.models, []);
  assert.equal(installed.catalogFailure.recovery, "retry-later");
  assert.equal(installed.account.ownership, "owned");
  assert.equal(installed.credentialShownOnce, true);
});

test("local n8n install rejects missing final confirmation without starting Docker", async t => {
  const { homeDirectory, registration, destinationRoot, plan } = await fixture(t);
  const runner = fakeDocker(destinationRoot);
  await assert.rejects(() => installLocalN8nSidecar({
    plan, registration, backgroundConsent: consent, confirmed: false,
  }, deps(homeDirectory, runner)));
  assert.equal(runner.calls.length, 0);
});

test("post-receipt local n8n start failure returns one-time key without claiming runtime readiness", async t => {
  const { homeDirectory, registration, destinationRoot, plan } = await fixture(t);
  const runner = fakeDocker(destinationRoot, { failStart: true });
  const result = await installLocalN8nSidecar({
    plan, registration, backgroundConsent: consent, confirmed: true,
  }, deps(homeDirectory, runner));
  assert.equal(result.deploymentMode, "partial");
  assert.equal(result.runtimeState, "stopped");
  assert.equal(result.readiness, "unverified");
  assert.equal(result.runtimeFailure.recovery, "resolve-handoff");
  assert.equal(typeof result.clientCredential, "string");
  assert.equal(result.account.ownership, "owned");
  assert.equal((await listRegistrations({ storageRoot: registration.storageRoot }))[0].ownership, "transferred");
});

test("unexpected local n8n host publication stops only its service and preserves one-time key", async t => {
  const { homeDirectory, registration, destinationRoot, plan } = await fixture(t);
  const runner = fakeDocker(destinationRoot, { publishedHostPort: true });
  const result = await installLocalN8nSidecar({
    plan, registration, backgroundConsent: consent, confirmed: true,
  }, deps(homeDirectory, runner));
  assert.equal(result.deploymentMode, "partial");
  assert.equal(result.runtimeState, "stopped");
  assert.match(result.runtimeFailure.error, /host port/i);
  assert.equal(result.hostPublication, "none");
  assert.equal(typeof result.clientCredential, "string");
  assert.equal(runner.calls.some(call => call.args.includes("stop") &&
    call.args.includes("openai-oauth")), true);
  assert.equal(runner.calls.some(call => call.args.includes("stop") &&
    call.args.includes("n8n")), false);
});

test("generated credential initializer obeys root plus CHOWN-only ownership model", {
  skip: process.platform === "win32" && "the initializer runs only under the Linux container's /bin/sh",
}, async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "relmio-seed-model-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const compose = createLocalN8nSidecarComposeFile({ installId, networkName: "owned-network", registrationId,
    tokenSha256: "a".repeat(64) });
  const seed = compose.split("\n  credential-seed:\n")[1].split("\nnetworks:\n")[0];
  const values = field => seed.match(new RegExp(`^    ${field}:\\n((?:      - .*\\n)+)`, "m"))?.[1]
    .trim().split("\n").map(value => value.trim().slice(2));
  assert.equal(seed.match(/^    user: "(.*)"$/m)[1], "0:0");
  assert.deepEqual(values("cap_drop"), ["ALL"]);
  assert.deepEqual(values("cap_add"), ["CHOWN"]);
  assert.deepEqual(values("volumes"), ["siwc-store:/run/relmio-auth"]);
  assert.equal(seed.match(/^    network_mode: (.*)$/m)[1], "none");
  const shell = seed.split("      - |\n")[1].split("    volumes:\n")[0]
    .split("\n").map(line => line.slice(8)).join("\n");
  const model = join(root, "owner");
  const calls = join(root, "calls");
  const functions = `
stat() { [ "$*" = "-c %u:%g:%a /run/relmio-auth" ] || exit 10; cat "$MODEL"; }
chmod() {
  [ "$*" = "0700 /run/relmio-auth" ] || exit 11
  IFS=: read -r uid gid mode < "$MODEL"
  [ "$uid" = "0" ] || exit 12
  printf 'chmod\\n' >> "$CALLS"
  printf '0:0:700\\n' > "$MODEL"
}
chown() {
  [ "$*" = "1000:1000 /run/relmio-auth" ] || exit 13
  printf 'chown\\n' >> "$CALLS"
  printf '%s\\n' "$CHOWN_RESULT" > "$MODEL"
}
`;
  for (const [initial, chownResult, succeeds, order] of [
    ["0:0:755", "1000:1000:700", true, "chmod\nchown\n"],
    ["0:0:700", "1000:1000:700", true, "chmod\nchown\n"],
    ["1000:1000:700", "1000:1000:700", true, ""],
    ["1000:1000:755", "1000:1000:700", false, ""],
    ["2000:2000:700", "1000:1000:700", false, ""],
    ["0:0:755", "0:0:700", false, "chmod\nchown\n"],
  ]) {
    await writeFile(model, `${initial}\n`);
    await writeFile(calls, "");
    const result = spawnSync("/bin/sh", ["-c", `${functions}\n${shell}`], {
      env: { PATH: process.env.PATH, MODEL: model, CALLS: calls, CHOWN_RESULT: chownResult },
      encoding: "utf8",
    });
    assert.equal(result.status === 0, succeeds, `${initial}: ${result.stderr}`);
    assert.equal(await readFile(calls, "utf8"), order);
    if (succeeds) assert.equal((await readFile(model, "utf8")).trim(), "1000:1000:700");
  }
});

test("local n8n lost acceptance acknowledgment reconciles original receipt after owner generation changes", async t => {
  const { homeDirectory, registration, destinationRoot, plan } = await fixture(t);
  const runner = fakeDocker(destinationRoot, { loseAcceptAck: true });
  await assert.rejects(() => installLocalN8nSidecar({ plan, registration, backgroundConsent: consent, confirmed: true },
    deps(homeDirectory, runner)), error => error.remoteOutcomeUnknown === true);
  const [before] = await listRegistrations({ storageRoot: destinationRoot });
  await setPlanEnabled({ storageRoot: destinationRoot, registrationId }, { enabled: false, expectedGeneration: before.generation });
  const reconciled = await reconcileLocalN8nSiwcHandoff({ registration, confirmed: true }, deps(homeDirectory, runner));
  assert.equal(reconciled.outcome, "finished");
  assert.equal(reconciled.account.ownership, "transferred");
  assert.deepEqual((await readRegistration(registration)).session, {});
  assert.equal(runner.calls.filter(call => call.args.at(-1) === "accept").length, 1);
  assert.equal((await reconcileLocalN8nSiwcHandoff({ registration, confirmed: true }, deps(homeDirectory, runner))).outcome, "finished");
});

test("local n8n receipt absence or transport failure keeps sender frozen", async t => {
  const { homeDirectory, registration, destinationRoot, plan } = await fixture(t);
  const runner = fakeDocker(destinationRoot, { rejectAccept: true });
  await assert.rejects(() => installLocalN8nSidecar({ plan, registration, backgroundConsent: consent, confirmed: true }, deps(homeDirectory, runner)));
  assert.equal((await reconcileLocalN8nSiwcHandoff({ registration, confirmed: true }, deps(homeDirectory, runner))).outcome, "not-accepted");
  const failed = async spec => spec.args.at(-1) === "receipt" ? { code: 1, stdout: "secret" } : runner(spec);
  await assert.rejects(() => reconcileLocalN8nSiwcHandoff({ registration, confirmed: true }, deps(homeDirectory, failed)),
    error => error.remoteOutcomeUnknown === true && !error.message.includes("secret"));
  assert.equal((await listRegistrations({ storageRoot: registration.storageRoot }))[0].ownership, "handoff-pending");
});

test("local n8n staging precedes directory creation and reviewed retry retains destination identity", async t => {
  const { homeDirectory, registration, destinationRoot, plan } = await fixture(t);
  const runner = fakeDocker(destinationRoot);
  const fileSystem = { ...fs, mkdir: async (path, options) => {
    if (path.endsWith(join("local", "n8n-openai-oauth"))) {
      const staged = JSON.parse(await readFile(join(homeDirectory, ".relmio-local-n8n-openai-oauth.siwc-staging.json"), "utf8"));
      assert.equal(staged.installId, installId);
      throw new Error("Interrupted before managed directory");
    }
    return fs.mkdir(path, options);
  } };
  await assert.rejects(() => installLocalN8nSidecar({ plan, registration, backgroundConsent: consent, confirmed: true },
    { ...deps(homeDirectory, runner), fileSystem }));
  assert.equal((await getLocalN8nSidecarStatus(deps(homeDirectory, runner))).state, "staged");
  const resume = await reviewLocalN8nSiwcResume({ registration }, deps(homeDirectory, runner));
  const result = await installLocalN8nSidecar({ plan: resume.plan, registration, resume, backgroundConsent: consent, confirmed: true },
    { ...deps(homeDirectory, runner), randomBytes: () => Buffer.alloc(32, 0xee) });
  assert.equal(result.account.ownerRuntimeId, installId);
  assert.equal(runner.calls.filter(call => call.args.at(-1) === "accept").length, 1);
});

test("local n8n build interruption resumes without deleting or creating a second writer", async t => {
  const { homeDirectory, registration, destinationRoot, plan } = await fixture(t);
  const legacy = await legacyFixture(homeDirectory);
  const runner = fakeLegacyDocker(destinationRoot, legacy);
  const legacyBinding = await reviewLocalN8nLegacyMigration({ plan }, deps(homeDirectory, runner));
  const failed = async spec => spec.args.includes("build") ? { code: 1, stdout: "" } : runner(spec);
  await assert.rejects(() => installLocalN8nSidecar({ plan, registration, backgroundConsent: consent, confirmed: true,
    migrationConsent: true, legacyBinding }, deps(homeDirectory, failed)));
  assert.equal(runner.isOldRunning(), false);
  const resume = await reviewLocalN8nSiwcResume({ registration }, deps(homeDirectory, runner));
  const result = await installLocalN8nSidecar({ plan: resume.plan, registration, resume, backgroundConsent: consent, confirmed: true },
    deps(homeDirectory, runner));
  assert.equal(result.deploymentMode, "migrated");
  assert.equal(runner.isOldRunning(), false);
  assert.equal(runner.calls.filter(call => call.args.at(-1) === "accept").length, 1);
  assert.equal(runner.calls.some(call => call.args.includes("down") || call.args.includes("rm")), false);
});

test("local n8n migration rejects mount, effective mapping and recreated volume before stopping", async t => {
  for (const change of ["mount-name", "mount-type", "mount-path", "compose", "volume"]) {
    const { homeDirectory, registration, destinationRoot, plan } = await fixture(t);
    const legacy = await legacyFixture(homeDirectory);
    const runner = fakeLegacyDocker(destinationRoot, legacy);
    const legacyBinding = await reviewLocalN8nLegacyMigration({ plan }, deps(homeDirectory, runner));
    if (change.startsWith("mount")) runner.setOldMount({
      Type: change === "mount-type" ? "bind" : "volume",
      Name: change === "mount-name" ? `${legacy.oldProject}_other` : runner.oldVolumeName,
      Destination: change === "mount-path" ? "/other" : "/home/node/.codex", RW: true,
    });
    if (change === "compose") runner.setComposeSource("other");
    if (change === "volume") runner.setVolumeCreatedAt("2026-10-05T00:00:00Z");
    await assert.rejects(() => installLocalN8nSidecar({ plan, registration, backgroundConsent: consent, confirmed: true,
      migrationConsent: true, legacyBinding }, deps(homeDirectory, runner)));
    assert.equal(runner.isOldRunning(), true);
    assert.equal(runner.calls.some(call => call.args.includes("stop") || call.args.includes("build")), false);
  }
});

test("local n8n rechecks credential volume after draining legacy writer", async t => {
  const { homeDirectory, registration, destinationRoot, plan } = await fixture(t);
  const legacy = await legacyFixture(homeDirectory);
  const runner = fakeLegacyDocker(destinationRoot, legacy);
  const legacyBinding = await reviewLocalN8nLegacyMigration({ plan }, deps(homeDirectory, runner));
  const changed = async spec => {
    const result = await runner(spec);
    if (spec.args.includes("stop")) runner.setVolumeCreatedAt("2026-10-05T00:00:00Z");
    return result;
  };
  await assert.rejects(() => installLocalN8nSidecar({ plan, registration, backgroundConsent: consent, confirmed: true,
    migrationConsent: true, legacyBinding }, deps(homeDirectory, changed)));
  assert.equal(runner.isOldRunning(), false);
  assert.equal(runner.calls.some(call => call.args.includes("build") || call.args.at(-1) === "accept"), false);
});

test("local n8n keeps one-time key through journal and lifecycle lock finalization failures", async t => {
  for (const failure of ["journal", "lock"]) {
    const { homeDirectory, registration, destinationRoot, plan } = await fixture(t);
    const legacy = await legacyFixture(homeDirectory);
    const runner = fakeLegacyDocker(destinationRoot, legacy);
    const legacyBinding = await reviewLocalN8nLegacyMigration({ plan }, deps(homeDirectory, runner));
    const fileSystem = { ...fs,
      writeFile: async (path, contents, options) => {
        if (failure === "journal" && path.includes("migration.json.tmp-") &&
            JSON.parse(contents.toString()).state === "transferred") throw new Error("secret journal failure");
        return fs.writeFile(path, contents, options);
      },
      rename: async (from, to) => {
        if (failure === "lock" && from.endsWith(".relmio-local-n8n-openai-oauth.lock")) throw new Error("lock cleanup failed");
        return fs.rename(from, to);
      },
    };
    const result = await installLocalN8nSidecar({ plan, registration, backgroundConsent: consent, confirmed: true,
      migrationConsent: true, legacyBinding }, { ...deps(homeDirectory, runner), fileSystem });
    assert.equal(result.deploymentMode, "partial");
    assert.equal(result.credentialShownOnce, true);
    assert.equal(typeof result.clientCredential, "string");
    assert.equal(result.finalizationFailure.recovery, "review-again");
    assert.equal(result.account.ownership, "owned");
    assert.equal(JSON.stringify(result).includes("secret journal"), false);
  }
});

test("local n8n unknown stop retains unknown publication and one-time key", async t => {
  const { homeDirectory, registration, destinationRoot, plan } = await fixture(t);
  const runner = fakeDocker(destinationRoot, { failStart: true });
  const failed = async spec => {
    if (spec.args.includes("stop") || spec.args.includes("--status")) throw new Error("Docker transport lost");
    return runner(spec);
  };
  const result = await installLocalN8nSidecar({ plan, registration, backgroundConsent: consent, confirmed: true }, deps(homeDirectory, failed));
  assert.equal(result.hostPublication, "unknown");
  assert.equal(result.runtimeState, "unknown");
  assert.equal(result.credentialShownOnce, true);
  assert.equal(typeof result.clientCredential, "string");
});

test("local n8n enable liveness and publication errors stop attested runtime or report unknown", async t => {
  for (const fault of ["malformed", "nonzero", "liveness", "lost-stop"]) {
    const { homeDirectory, registration, destinationRoot, plan } = await fixture(t);
    const runner = fakeDocker(destinationRoot);
    const installed = await installLocalN8nSidecar({ plan, registration, backgroundConsent: consent, confirmed: true }, deps(homeDirectory, runner));
    const disabled = await manageLocalN8nSiwcInstallation({ registrationId, action: "disable-plan",
      expectedGeneration: installed.account.generation, confirmed: true }, deps(homeDirectory, runner));
    let started = false;
    const failed = async spec => {
      if (spec.args.includes("up")) { started = true; return runner(spec); }
      if (started && spec.args.includes("--format") && spec.args.includes("ps")) {
        return fault === "nonzero" ? { code: 1, stdout: "" } : { code: 0, stdout: "malformed" };
      }
      if (started && fault === "liveness" && spec.args.includes("--status")) return { code: 1, stdout: "" };
      if (started && fault === "lost-stop" && spec.args.includes("stop")) throw new Error("Lost stop acknowledgment");
      return runner(spec);
    };
    await assert.rejects(() => manageLocalN8nSiwcInstallation({ registrationId, action: "enable-plan",
      expectedGeneration: disabled.account.generation, backgroundConsent: true, confirmed: true }, deps(homeDirectory, failed)),
    error => error.runtimeStopped === (fault !== "lost-stop") && error.remoteOutcomeUnknown === (fault === "lost-stop"));
    assert.equal(runner.isRunning(), fault === "lost-stop");
    assert.equal(runner.calls.some(call => call.args.includes("stop") && call.args.includes("n8n")), false);
  }
});

test("local n8n not-accepted checkpoint resumes with fresh independent sign-in", async t => {
  const { homeDirectory, registration, destinationRoot, plan } = await fixture(t);
  const runner = fakeDocker(destinationRoot, { rejectAccept: true });
  await assert.rejects(() => installLocalN8nSidecar({ plan, registration, backgroundConsent: consent, confirmed: true }, deps(homeDirectory, runner)));
  await reconcileLocalN8nSiwcHandoff({ registration, confirmed: true }, deps(homeDirectory, runner));
  const next = { ...registration, registrationId: "registration_n8n_resume" };
  const connected = await commitAuthorization({ ...next, clientId: "oaiapp_resume", runtimeId: "wizard",
    identity: { issuer: "https://auth.openai.com", subject: randomUUID() },
    tokens: { access_token: "fresh-access", refresh_token: "fresh-refresh", token_type: "Bearer",
      expires_in: 3600, scope: "openid profile offline_access resource.invoke chatgpt.tokens.use.direct" } });
  await setPlanEnabled(next, { enabled: true, expectedGeneration: connected.generation });
  const resume = await reviewLocalN8nSiwcResume({ registration: next }, deps(homeDirectory, runner));
  assert.equal(resume.registrationId, next.registrationId);
  runner.setRegistrationId(next.registrationId);
  runner.setRejectAccept(false);
  const result = await installLocalN8nSidecar({ plan: resume.plan, registration: next, resume,
    backgroundConsent: consent, confirmed: true }, deps(homeDirectory, runner));
  assert.equal(result.account.registrationId, next.registrationId);
  assert.equal((await readRegistration(registration)).handoff.state, "handoff-pending");
  assert.equal((await readRegistration(next)).handoff.state, "transferred");
  assert.equal(runner.calls.filter(call => call.args.at(-1) === "accept").length, 2);
});

test("local n8n post-transfer resume rotates bearer without another export", async t => {
  const { homeDirectory, registration, destinationRoot, plan } = await fixture(t);
  const runner = fakeDocker(destinationRoot, { failStart: true });
  const partial = await installLocalN8nSidecar({ plan, registration, backgroundConsent: consent, confirmed: true }, deps(homeDirectory, runner));
  runner.setFailStart(false);
  const resume = await reviewLocalN8nSiwcResume({ registration }, deps(homeDirectory, runner));
  const result = await installLocalN8nSidecar({ plan: resume.plan, registration, resume,
    backgroundConsent: consent, confirmed: true }, { ...deps(homeDirectory, runner), randomBytes: () => Buffer.alloc(32, 0xee) });
  assert.notEqual(result.clientCredential, partial.clientCredential);
  assert.equal(result.account.ownerRuntimeId, installId);
  assert.equal(result.runtimeState, "running");
  assert.equal(runner.calls.filter(call => call.args.at(-1) === "accept").length, 1);
});

test("local n8n post-receipt checkpoint failure keeps committed key", async t => {
  const { homeDirectory, registration, destinationRoot, plan } = await fixture(t);
  const runner = fakeDocker(destinationRoot);
  const fileSystem = { ...fs, writeFile: async (path, contents, options) => {
    if (path.includes(".siwc-staging.json.tmp-") && JSON.parse(contents.toString()).stage === "transferred") {
      throw new Error("Checkpoint unavailable");
    }
    return fs.writeFile(path, contents, options);
  } };
  const result = await installLocalN8nSidecar({ plan, registration, backgroundConsent: consent, confirmed: true },
    { ...deps(homeDirectory, runner), fileSystem });
  assert.equal(typeof result.clientCredential, "string");
  assert.equal(result.credentialShownOnce, true);
  assert.equal(result.deploymentMode, "partial");
  assert.equal(result.finalizationFailure.recovery, "resolve-handoff");
  assert.deepEqual((await readRegistration(registration)).session, {});
});

test("local n8n resume rejects changed file or reviewed container identity before writes", async t => {
  const { homeDirectory, registration, destinationRoot, plan } = await fixture(t);
  const runner = fakeDocker(destinationRoot);
  const failed = async spec => spec.args.includes("build") ? { code: 1, stdout: "" } : runner(spec);
  await assert.rejects(() => installLocalN8nSidecar({ plan, registration, backgroundConsent: consent, confirmed: true }, deps(homeDirectory, failed)));
  const resume = await reviewLocalN8nSiwcResume({ registration }, deps(homeDirectory, runner));
  const installRoot = await resolveLocalN8nSidecarInstallRoot({ homeDirectory, env: {} });
  await writeFile(join(installRoot, "Dockerfile"), "changed", { mode: 0o600 });
  const before = runner.calls.length;
  await assert.rejects(() => installLocalN8nSidecar({ plan: resume.plan, registration, resume,
    backgroundConsent: consent, confirmed: true }, deps(homeDirectory, runner)));
  assert.equal(runner.calls.slice(before).some(call => call.args.includes("build") || call.args.includes("up")), false);
  const fresh = await reviewLocalN8nSiwcResume({ registration }, deps(homeDirectory, runner));
  const drift = async spec => {
    if (spec.args[0] === "container" && spec.args.at(-1) === N8N_ID) {
      const result = await runner(spec);
      return { ...result, stdout: JSON.stringify({ ...JSON.parse(result.stdout), Id: "e".repeat(64) }) };
    }
    return runner(spec);
  };
  await assert.rejects(() => installLocalN8nSidecar({ plan: fresh.plan, registration, resume: fresh,
    backgroundConsent: consent, confirmed: true }, deps(homeDirectory, drift)));
});

test("local n8n staged resume binds refreshed generation and retains the exact account", async t => {
  const { homeDirectory, registration, destinationRoot, plan } = await fixture(t);
  const runner = fakeDocker(destinationRoot);
  const failed = async spec => spec.args.includes("build") ? { code: 1, stdout: "" } : runner(spec);
  await assert.rejects(() => installLocalN8nSidecar({ plan, registration, backgroundConsent: consent, confirmed: true }, deps(homeDirectory, failed)));
  const disabled = await setPlanEnabled(registration, { enabled: false, expectedGeneration: plan.authBinding.generation });
  const enabled = await setPlanEnabled(registration, { enabled: true, expectedGeneration: disabled.generation });
  const resume = await reviewLocalN8nSiwcResume({ registration }, deps(homeDirectory, runner));
  await assert.rejects(() => reviewLocalN8nSiwcResume({}, deps(homeDirectory, runner)));
  assert.equal(resume.plan.authBinding.generation, enabled.generation);
  for (const field of ["registrationId", "clientId", "ownerHostId", "ownerRuntimeId"]) {
    assert.equal(resume.plan.authBinding[field], plan.authBinding[field]);
  }
  const installRoot = await resolveLocalN8nSidecarInstallRoot({ homeDirectory, env: {} });
  await writeFile(join(installRoot, "retained-user-data.txt"), "keep", { mode: 0o600 });
  const reviewed = await reviewLocalN8nSiwcResume({ registration }, deps(homeDirectory, runner));
  const installed = await installLocalN8nSidecar({ plan: reviewed.plan, registration, resume: reviewed,
    backgroundConsent: consent, confirmed: true }, deps(homeDirectory, runner));
  assert.equal(installed.account.ownerRuntimeId, installId);
  assert.equal(runner.calls.filter(call => call.args.at(-1) === "accept").length, 1);
  assert.equal(runner.calls.some(call => call.args.includes("down") || call.args.includes("rm")), false);
  assert.equal(await readFile(join(installRoot, "retained-user-data.txt"), "utf8"), "keep");
  const checkpoint = JSON.parse(await readFile(join(homeDirectory, ".relmio-local-n8n-openai-oauth.siwc-staging.json"), "utf8"));
  assert.equal(checkpoint.plan.authBinding.generation, enabled.generation);
});

test("lost n8n acceptance reconciles after n8n recreation and resumes with a fresh reviewed container", async t => {
  const { homeDirectory, registration, destinationRoot, plan } = await fixture(t);
  const runner = fakeDocker(destinationRoot, { loseAcceptAck: true });
  await assert.rejects(() => installLocalN8nSidecar({ plan, registration, backgroundConsent: consent, confirmed: true }, deps(homeDirectory, runner)));
  runner.recreateN8n();
  const before = runner.calls.length;
  const result = await reconcileLocalN8nSiwcHandoff({ registration, confirmed: true }, deps(homeDirectory, runner));
  assert.equal(result.outcome, "finished");
  assert.equal(runner.calls.slice(before).some(call => call.args[0] === "container" && call.args.at(-1) === N8N_ID), false);
  const current = await readRegistration(registration);
  const freshPlan = { ...plan, n8nContainerId: "9".repeat(64), n8nContainerName: "recreated-n8n",
    authBinding: { ...plan.authBinding, generation: current.generation } };
  const resume = await reviewLocalN8nSiwcResume({ registration, plan: freshPlan }, deps(homeDirectory, runner));
  assert.equal(resume.plan.n8nContainerId, freshPlan.n8nContainerId);
  assert.equal(resume.plan.authBinding.generation, plan.authBinding.generation);
  const installed = await installLocalN8nSidecar({ plan: resume.plan, registration, resume,
    backgroundConsent: consent, confirmed: true }, { ...deps(homeDirectory, runner), randomBytes: () => Buffer.alloc(32, 0xee) });
  assert.equal(installed.runtimeState, "running");
  assert.equal(installed.account.ownerRuntimeId, installId);
  const checkpoint = JSON.parse(await readFile(join(homeDirectory, ".relmio-local-n8n-openai-oauth.siwc-staging.json"), "utf8"));
  assert.equal(checkpoint.plan.n8nContainerId, freshPlan.n8nContainerId);
  assert.equal(runner.calls.filter(call => call.args.at(-1) === "accept").length, 1);
  assert.equal(runner.calls.some(call => call.args.includes("restart") && call.args.includes("n8n")), false);
});

test("n8n receipt absence remains uncertain while a one-off acceptance helper exists", async t => {
  const { homeDirectory, registration, destinationRoot, plan } = await fixture(t);
  const runner = fakeDocker(destinationRoot, { rejectAccept: true });
  await assert.rejects(() => installLocalN8nSidecar({ plan, registration, backgroundConsent: consent, confirmed: true }, deps(homeDirectory, runner)));
  const checkpointPath = join(homeDirectory, ".relmio-local-n8n-openai-oauth.siwc-staging.json");
  const before = await readFile(checkpointPath, "utf8");
  const uncertain = async spec => {
    if (spec.args.includes("label=com.docker.compose.oneoff=True")) {
      return { code: 0, stdout: JSON.stringify({ ID: "f".repeat(64), Names: "owned-accept-helper" }) };
    }
    return runner(spec);
  };
  await assert.rejects(() => reconcileLocalN8nSiwcHandoff({ registration, confirmed: true },
    deps(homeDirectory, uncertain)), error => error.remoteOutcomeUnknown === true);
  assert.equal(await readFile(checkpointPath, "utf8"), before);
  assert.equal((await readRegistration(registration)).handoff.state, "handoff-pending");
  assert.equal(runner.calls.filter(call => call.args.at(-1) === "accept").length, 1);
});

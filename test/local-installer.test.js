import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";

import {
  acquireLocalEndpointChangeLock, activateLocalClientCredentialRotation,
  getManagedLocalEndpointStatus, installLocalEndpoint,
  inspectStoppedLocalSiwcInstallation, manageLocalSiwcInstallation,
  prepareLocalClientCredentialRotation, resolveLocalInstallRoot,
  reviewLocalCodexLegacyMigration, reviewLocalCodexSiwcReplacement,
  reviewLocalSiwcResume, reconcileLocalSiwcHandoff,
} from "../src/services/local-installer.js";
import { runSiwcHandoffCli } from "../src/services/siwc-handoff.mjs";
import { CODEX_CLI_VERSION } from "../src/gateway/openai-oauth-sidecar.mjs";
import {
  commitAuthorization, getAccessToken, listRegistrations, setPlanEnabled, readRegistration,
} from "../src/services/siwc-session.mjs";
import { withTestLocalSecurity } from "./helpers/local-security.js";
import { acquireLocalIntegrationLifecycleLock } from "../src/services/local-integration-lifecycle-lock.js";

const DOCKER_HOST = process.platform === "win32"
  ? "npipe:////./pipe/dockerDesktopLinuxEngine" : "unix:///var/run/docker.sock";
const installId = "d".repeat(32);
const CONTAINER_ID = "c".repeat(64);
const registrationId = "registration_codex_test";

async function fixture(t, target = "codex-chat") {
  const root = await realpath(await mkdtemp(join(tmpdir(), "relmio-codex-siwc-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const homeDirectory = join(root, "user");
  await (await import("node:fs/promises")).mkdir(homeDirectory);
  const registration = { storageRoot: join(root, "source"), registrationId };
  const destinationRoot = join(root, "destination");
  const connected = await commitAuthorization({
    ...registration, clientId: "oaiapp_codex_fixture", runtimeId: "wizard",
    identity: { issuer: "https://auth.openai.com", subject: randomUUID() },
    tokens: {
      access_token: "fake-codex-access", refresh_token: "fake-codex-refresh",
      token_type: "Bearer", expires_in: 3600,
      scope: "openid profile offline_access resource.invoke chatgpt.tokens.use.direct",
    },
  });
  const enabled = await setPlanEnabled(registration, {
    enabled: true, expectedGeneration: connected.generation,
  });
  const authBinding = {
    registrationId, clientId: "oaiapp_codex_fixture", generation: enabled.generation,
    ownerHostId: enabled.ownerHostId, ownerRuntimeId: enabled.ownerRuntimeId,
  };
  const plan = { target, port: target === "codex-chat" ? 14501 : 14500, authBinding };
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
  if (url === `https://api.openai.com/v1/models?client_version=${CODEX_CLI_VERSION}`) return Response.json({
    models: [{ slug: "selected-model", display_name: "Selected model", visibility: "list" }],
  });
  throw new Error("Unexpected provider request in local fixture.");
};

function fakeDocker({
  target, destinationRoot, failAccept = false, failStart = false, foreignResource = false,
  contextHost = DOCKER_HOST, projectInstallId = installId,
  selectedRegistrationId = registrationId, containerId = CONTAINER_ID, loseAcceptAck = false,
} = {}) {
  const calls = [];
  const service = target === "codex-chat" ? "codex-chat" : "codex";
  const projectName = `relmio-${target}-${projectInstallId}`;
  const port = target === "codex-chat" ? 14501 : 14500;
  const containerPort = target === "codex-chat" ? 14501 : 4500;
  const volumes = ["codex-state", "siwc-store", "codex-workspace"];
  let imageBuilt = false;
  let volumesReady = false;
  let installed = false;
  let running = false;
  const labels = resource => [
    `com.docker.compose.project=${projectName}`,
    "io.relmio.managed=true", `io.relmio.target=${target}`,
    `io.relmio.install=${projectInstallId}`,
    ...(resource ? [`com.docker.compose.${resource}=default`] : []),
  ].join(",");
  const networkId = projectInstallId === installId ? "8".repeat(64) : "9".repeat(64);
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
    if (args[0] === "network" && args[1] === "inspect" &&
        args.at(-1) === `${projectName}_default`) {
      return ok(JSON.stringify({ Id: networkId, Name: `${projectName}_default` }));
    }
    if (args[0] === "volume" && args[1] === "inspect") return ok(JSON.stringify({
      Name: args.at(-1), CreatedAt: "2026-10-04T00:00:00Z", Driver: "local",
      Mountpoint: `/var/lib/docker/volumes/${args.at(-1)}/_data`,
    }));
    if (args[0] === "container" && args[1] === "inspect" &&
        args.at(-1) === containerId) {
      return ok(JSON.stringify({
        Id: containerId,
        Image: `sha256:${(projectInstallId === installId ? "7" : "6").repeat(64)}`,
        State: { Running: running, Paused: false },
        Config: { Labels: {
          "com.docker.compose.project": projectName,
          "com.docker.compose.service": service,
          "io.relmio.managed": "true",
          "io.relmio.target": target,
          "io.relmio.install": projectInstallId,
        } },
        NetworkSettings: { Networks: { [`${projectName}_default`]: { NetworkID: networkId } } },
        Mounts: volumes.map((name, index) => ({
          Type: "volume", Name: `${projectName}_${name}`,
          Destination: ["/home/node/.codex", "/home/node/.relmio-siwc", "/workspace"][index],
        })),
      }));
    }
    if (args.includes(projectName) && joined.includes("config --format json")) {
      return ok(JSON.stringify({
        services: { [service]: {
          environment: {
            RELMIO_REGISTRATION_ID: selectedRegistrationId,
            RELMIO_RUNTIME_ID: projectInstallId,
            N8N_OPENAI_OAUTH_HOME: "/home/node/.relmio-siwc",
          },
          volumes: volumes.map((name, index) => ({
            source: name,
            target: ["/home/node/.codex", "/home/node/.relmio-siwc", "/workspace"][index],
          })),
          ports: [{ published: String(port), host_ip: "127.0.0.1", target: containerPort }],
        } },
        networks: { default: { name: `${projectName}_default` } },
        volumes: Object.fromEntries(volumes.map(name => [name, { name: `${projectName}_${name}` }])),
      }));
    }
    if (["ps", "network", "volume"].includes(args[0]) && args.includes("--filter") &&
        args.some(value => value === `label=com.docker.compose.project=${projectName}`)) {
      if (args[0] === "ps") return ok(installed ? `${JSON.stringify({
        ID: containerId, Names: `${projectName}-${service}-1`, Labels: `${labels()},com.docker.compose.service=${service}`,
      })}\n` : "");
      if (args[0] === "network") return ok(volumesReady ? `${JSON.stringify({
        Name: `${projectName}_default`, Labels: labels("network"),
      })}\n` : "");
      return ok(volumesReady ? volumes.map(name => JSON.stringify({
        Name: `${projectName}_${name}`,
        Labels: `${labels()},com.docker.compose.volume=${name}`,
      })).join("\n") + "\n" : "");
    }
    if (joined.includes("ps --all -q") || joined.includes("ps -q")) return ok(installed ? `${containerId}\n` : "");
    if (joined.includes("ps --status running --services")) return ok(running ? `${service}\n` : "");
    if (joined.includes("ps --all --format json") || joined.includes("ps --format json")) {
      return ok(JSON.stringify({ Name: `${projectName}-${service}-1`, Service: service,
        State: running ? "running" : "exited", Health: "healthy",
        Publishers: [{ URL: "127.0.0.1", PublishedPort: port, TargetPort: containerPort, Protocol: "tcp" }] }));
    }
    if (args.includes("/app/services/siwc-handoff.mjs")) {
      const command = args.at(-1);
      if (command === "accept" && failAccept) throw new Error("Docker response ambiguous");
      if (command === "account" && args.includes("exec") && !running) return { code: 1, stdout: "" };
      if (command === "host") volumesReady = true;
      const result = await cli(command, spec);
      if (command === "accept" && loseAcceptAck) throw new Error("Lost acknowledgment after commit");
      return result;
    }
    if (joined.includes(`build ${service}`)) { imageBuilt = true; return ok(""); }
    if (joined.includes("up -d --wait")) {
      if (failStart) return { code: 1, stdout: "", stderr: "start failed" };
      installed = true; running = true; return ok("");
    }
    if (joined.includes(`stop --timeout 30 ${service}`)) { running = false; return ok(""); }
    if (foreignResource) return { code: 1, stdout: "", stderr: "foreign resource" };
    return ok("");
  };
  runner.calls = calls;
  runner.isBuilt = () => imageBuilt;
  runner.setFailStart = value => { failStart = value; };
  runner.setRegistrationId = value => { selectedRegistrationId = value; };
  runner.setFailAccept = value => { failAccept = value; };
  return runner;
}

async function legacyFixture(homeDirectory, target = "codex-chat") {
  const oldInstallId = "e".repeat(32);
  const oldProject = `relmio-${target}-${oldInstallId}`;
  const installRoot = await resolveLocalInstallRoot({ target, homeDirectory, env: {} });
  const root = join(homeDirectory, ".relmio");
  await mkdir(installRoot, { recursive: true, mode: 0o700 });
  await writeFile(join(root, ".managed-by-relmio-root.json"),
    `${JSON.stringify({ schemaVersion: 1, kind: "relmio-local-root" })}\n`, { mode: 0o600 });
  const marker = {
    schemaVersion: 2, target, port: target === "codex-chat" ? 14501 : 14500,
    dockerHost: DOCKER_HOST, installId: oldInstallId, projectName: oldProject,
  };
  for (const [filename, contents] of Object.entries({
    ".managed-by-relmio.json": `${JSON.stringify(marker)}\n`,
    "docker-compose.yml": "services:\n  codex-chat:\n    image: legacy-owned\n",
    "Dockerfile": "FROM node:22-bookworm-slim\n",
    ".dockerignore": "**\n!Dockerfile\n",
    "config.toml": "forced_login_method = \"chatgpt\"\n",
    "requirements.toml": "allowed_login_methods = [\"chatgpt\"]\n",
    "gateway.mjs": "export const legacy = true;\n",
  })) await writeFile(join(installRoot, filename), contents, { mode: 0o600 });
  return { oldInstallId, oldProject, installRoot };
}

function fakeLegacyDocker({ target, destinationRoot, oldInstallId, oldProject, failAccept = false }) {
  const fresh = fakeDocker({ target, destinationRoot, failAccept });
  const calls = [];
  const oldService = target === "codex-chat" ? "codex-chat" : "codex";
  const oldContainerId = "f".repeat(64);
  const oldNetworkId = "8".repeat(64);
  const oldVolumes = ["codex-home", "codex-workspace"];
  let oldImageId = `sha256:${"7".repeat(64)}`;
  let oldRunning = true;
  const labels = resource => [
    `com.docker.compose.project=${oldProject}`,
    "io.relmio.managed=true", `io.relmio.target=${target}`,
    `io.relmio.install=${oldInstallId}`,
    ...(resource ? [`com.docker.compose.${resource}=${resource === "network" ? "default" : resource}`] : []),
  ].join(",");
  const ok = stdout => ({ code: 0, stdout, stderr: "" });
  const runner = async spec => {
    calls.push(spec);
    const args = spec.args;
    const joined = args.join(" ");
    if (args[0] === "network" && args[1] === "inspect" &&
        args.at(-1) === `${oldProject}_default`) {
      return ok(JSON.stringify({ Id: oldNetworkId, Name: `${oldProject}_default` }));
    }
    if (args[0] === "container" && args[1] === "inspect" && args.at(-1) === oldContainerId) {
      return ok(JSON.stringify({
        Id: oldContainerId, Image: oldImageId,
        Config: { Labels: {
          "com.docker.compose.project": oldProject,
          "com.docker.compose.service": oldService,
          "io.relmio.managed": "true",
          "io.relmio.target": target,
          "io.relmio.install": oldInstallId,
        } },
        State: { Running: oldRunning, Paused: false },
        NetworkSettings: { Networks: { [`${oldProject}_default`]: { NetworkID: oldNetworkId } } },
        Mounts: oldVolumes.map((name, index) => ({
          Type: "volume", Name: `${oldProject}_${name}`,
          Destination: index === 0 ? "/home/node/.codex" : "/workspace",
        })),
      }));
    }
    if (["ps", "network", "volume"].includes(args[0]) &&
        args.includes(`label=com.docker.compose.project=${oldProject}`)) {
      if (args[0] === "ps") return ok(`${JSON.stringify({
        Names: `${oldProject}-${oldService}-1`,
        Labels: `${labels()},com.docker.compose.service=${oldService}`,
      })}\n`);
      if (args[0] === "network") return ok(`${JSON.stringify({
        Name: `${oldProject}_default`, Labels: labels("network"),
      })}\n`);
      return ok(oldVolumes.map(name => JSON.stringify({
        Name: `${oldProject}_${name}`,
        Labels: `${labels()},com.docker.compose.volume=${name}`,
      })).join("\n") + "\n");
    }
    if (args.includes(oldProject)) {
      if (joined.includes("config --format json")) return ok(JSON.stringify({
        services: { [oldService]: {
          volumes: oldVolumes.map((name, index) => ({
            source: name, target: index === 0 ? "/home/node/.codex" : "/workspace",
          })),
          ports: [{ published: target === "codex-chat" ? "14501" : "14500",
            host_ip: "127.0.0.1", target: target === "codex-chat" ? 14501 : 4500 }],
        } },
        networks: { default: { name: `${oldProject}_default` } },
        volumes: Object.fromEntries(oldVolumes.map(name => [name, { name: `${oldProject}_${name}` }])),
      }));
      if (joined.includes(`ps --all -q ${oldService}`)) return ok(`${oldContainerId}\n`);
      if (joined.includes(`stop --timeout 30 ${oldService}`)) {
        oldRunning = false;
        return ok("");
      }
    }
    return fresh(spec);
  };
  runner.calls = calls;
  runner.oldVolumeNames = oldVolumes.map(name => `${oldProject}_${name}`);
  runner.isOldRunning = () => oldRunning;
  runner.setOldImageId = value => { oldImageId = value; };
  return runner;
}

function deps(homeDirectory, runProcess, extra = {}) {
  return withTestLocalSecurity({
    env: {}, homeDirectory, runProcess,
    randomBytes: () => Buffer.alloc(32, 0xdd),
    isPortAvailable: async () => true,
    fetchImpl: async () => ({ ok: true }),
    verifyCodexCapability: async () => {},
    ...extra,
  });
}

test("Codex endpoints transfer only the selected verified session into fresh protected volumes", async t => {
  for (const target of ["codex-chat", "codex-chatgpt"]) {
    const fixtureT = await fixture(t, target);
    const { homeDirectory, registration, destinationRoot, plan } = fixtureT;
    const runner = fakeDocker({ target, destinationRoot });
    const result = await installLocalEndpoint({ plan, registration, confirmed: true }, deps(homeDirectory, runner));
    assert.equal(result.target, target);
    assert.equal(result.account.registrationId, registrationId);
    assert.equal(result.account.ownerRuntimeId, installId);
    assert.equal(result.account.ownership, "owned");
    assert.equal(result.credentialShownOnce, true);
    if (target === "codex-chatgpt") {
      assert.equal(result.readiness, "verified");
      assert.deepEqual(result.models, ["selected-model"]);
    } else {
      assert.equal(result.readiness, "unverified");
      assert.deepEqual(result.models, []);
      assert.equal(typeof result.catalogFailure.error, "string");
    }
    const source = (await listRegistrations({ storageRoot: registration.storageRoot }))[0];
    assert.equal(source.ownership, "transferred");
    await assert.rejects(() => getAccessToken(registration, { runtimeId: "wizard" }));
    const installRoot = await resolveLocalInstallRoot({ target, homeDirectory, env: {} });
    const compose = await readFile(join(installRoot, "docker-compose.yml"), "utf8");
    assert.match(compose, /siwc-store:\/home\/node\/\.relmio-siwc/);
    assert.match(compose, /codex-state:\/home\/node\/\.codex/);
    assert.doesNotMatch(compose, /codex-home|fake-codex-refresh/);
    const status = await getManagedLocalEndpointStatus({ target }, deps(homeDirectory, runner));
    assert.equal(status.snapshot.auth.account.registrationId, registrationId);
    assert.equal(status.snapshot.auth.configured, true);
    assert.equal(runner.calls.some(call => call.args.includes("account/login/start")), false);
  }
});

test("wrong binding or stale account fails before Docker writes", async t => {
  const { homeDirectory, registration, destinationRoot, plan, authBinding } = await fixture(t);
  const runner = fakeDocker({ target: plan.target, destinationRoot });
  for (const changed of [
    { ...authBinding, clientId: "oaiapp_other" },
    { ...authBinding, generation: randomUUID() },
    { ...authBinding, ownerHostId: `urn:uuid:${randomUUID()}` },
  ]) await assert.rejects(() => installLocalEndpoint({
    plan: { ...plan, authBinding: changed }, registration, confirmed: true,
  }, deps(homeDirectory, runner)));
  assert.equal(runner.calls.length, 0);
  await assert.rejects(() => installLocalEndpoint({ plan, registration, confirmed: false }, deps(homeDirectory, runner)));
  assert.equal(runner.calls.length, 0);
});

test("ambiguous destination acceptance leaves source frozen and does not start Codex", async t => {
  const { homeDirectory, registration, destinationRoot, plan } = await fixture(t);
  const runner = fakeDocker({ target: plan.target, destinationRoot, failAccept: true });
  await assert.rejects(() => installLocalEndpoint({ plan, registration, confirmed: true }, deps(homeDirectory, runner)), /unresolved/i);
  const [source] = await listRegistrations({ storageRoot: registration.storageRoot });
  assert.equal(source.ownership, "handoff-pending");
  await assert.rejects(() => getAccessToken(registration, { runtimeId: "wizard" }));
  assert.equal(runner.calls.some(call => call.args.includes("up") && call.args.includes("codex-chat")), false);
});

test("installed Codex disable-plan stops exact service before mutation and stopped inspection needs confirmation", async t => {
  const { homeDirectory, registration, destinationRoot, plan } = await fixture(t);
  const runner = fakeDocker({ target: plan.target, destinationRoot });
  await installLocalEndpoint({ plan, registration, confirmed: true }, deps(homeDirectory, runner));
  const current = await getManagedLocalEndpointStatus({ target: plan.target }, deps(homeDirectory, runner));
  await assert.rejects(() => manageLocalSiwcInstallation({
    target: plan.target, registrationId, action: "disable-plan",
    expectedGeneration: randomUUID(), confirmed: true,
  }, deps(homeDirectory, runner)));
  const result = await manageLocalSiwcInstallation({
    target: plan.target, registrationId, action: "disable-plan",
    expectedGeneration: current.snapshot.auth.account.generation, confirmed: true,
  }, deps(homeDirectory, runner));
  assert.equal(result.account.planEnabled, false);
  assert.equal(result.runtimeStopped, true);
  const stopped = await getManagedLocalEndpointStatus({ target: plan.target }, deps(homeDirectory, runner));
  assert.equal(stopped.state, "stopped");
  assert.equal(stopped.snapshot.auth.configured, false);
  await assert.rejects(() => inspectStoppedLocalSiwcInstallation({
    target: plan.target, registrationId, confirmed: false,
  }, deps(homeDirectory, runner)));
  const inspected = await inspectStoppedLocalSiwcInstallation({
    target: plan.target, registrationId, confirmed: true,
  }, deps(homeDirectory, runner));
  assert.equal(inspected.account.generation, result.account.generation);
  const enabled = await manageLocalSiwcInstallation({
    target: plan.target, registrationId, action: "enable-plan",
    expectedGeneration: inspected.account.generation, confirmed: true,
  }, deps(homeDirectory, runner));
  assert.equal(enabled.account.planEnabled, true);
  assert.equal(enabled.runtimeStopped, false);
  assert.equal((await getManagedLocalEndpointStatus({ target: plan.target },
    deps(homeDirectory, runner))).snapshot.auth.configured, true);
});

test("existing Codex installation is never silently overwritten", async t => {
  const { homeDirectory, registration, destinationRoot, plan } = await fixture(t);
  const runner = fakeDocker({ target: plan.target, destinationRoot });
  await installLocalEndpoint({ plan, registration, confirmed: true }, deps(homeDirectory, runner));
  const before = runner.calls.length;
  await assert.rejects(() => installLocalEndpoint({ plan, registration, confirmed: true }, deps(homeDirectory, runner)));
  assert.equal(runner.calls.length, before);
});

test("local project lifecycle lock serializes separate endpoint operations", async t => {
  const { homeDirectory } = await fixture(t);
  const first = await acquireLocalEndpointChangeLock({ target: "codex-chat" }, deps(homeDirectory, async () => ({ code: 0, stdout: "" })));
  try {
    await assert.rejects(() => acquireLocalEndpointChangeLock({ target: "codex-chat" }, deps(homeDirectory, async () => ({ code: 0, stdout: "" }))));
  } finally { await first(); }
});

test("Windows generated-asset ACL drift blocks runtime inspection", async t => {
  const { homeDirectory, registration, destinationRoot, plan } = await fixture(t);
  const runner = fakeDocker({
    target: plan.target, destinationRoot,
    contextHost: "npipe:////./pipe/dockerDesktopLinuxEngine",
  });
  const permitted = deps(homeDirectory, runner, {
    platform: "win32", lockDownPath: async () => {},
  });
  await installLocalEndpoint({ plan, registration, confirmed: true }, permitted);
  const before = runner.calls.length;
  const restricted = deps(homeDirectory, runner, {
    platform: "win32",
    lockDownPath: async (path, options) => {
      if (path.endsWith("siwc-session.mjs") && options.verifyOnly) {
        throw new Error("Inherited ACL entry grants another user access");
      }
    },
  });
  const status = await getManagedLocalEndpointStatus({ target: plan.target }, restricted);
  assert.equal(status.state, "unavailable");
  assert.equal(runner.calls.slice(before).some(call =>
    call.args.includes("exec") || call.args.includes("run") || call.args.includes("up")), false);
});

test("Windows status verifies the image module when present and accepts installs made before it", async t => {
  const { homeDirectory, registration, destinationRoot, plan } = await fixture(t);
  const runner = fakeDocker({
    target: plan.target, destinationRoot,
    contextHost: "npipe:////./pipe/dockerDesktopLinuxEngine",
  });
  const permitted = deps(homeDirectory, runner, { platform: "win32", lockDownPath: async () => {} });
  await installLocalEndpoint({ plan, registration, confirmed: true }, permitted);
  const baseline = await getManagedLocalEndpointStatus({ target: plan.target }, permitted);
  assert.notEqual(baseline.state, "unavailable");
  let imagesModule;
  const restricted = deps(homeDirectory, runner, {
    platform: "win32",
    lockDownPath: async (path, options) => {
      if (path.endsWith("codex-images.mjs") && options.verifyOnly) {
        imagesModule = path;
        throw new Error("Inherited ACL entry grants another user access");
      }
    },
  });
  assert.equal((await getManagedLocalEndpointStatus({ target: plan.target }, restricted)).state, "unavailable");
  await rm(imagesModule);
  assert.equal((await getManagedLocalEndpointStatus({ target: plan.target }, restricted)).state, baseline.state);
});

test("legacy Codex marker requires fresh SIWC sign-in without reading old credentials", async t => {
  const { homeDirectory, registration, destinationRoot, plan } = await fixture(t);
  const runner = fakeDocker({ target: plan.target, destinationRoot });
  await installLocalEndpoint({ plan, registration, confirmed: true }, deps(homeDirectory, runner));
  const installRoot = await resolveLocalInstallRoot({ target: plan.target, homeDirectory, env: {} });
  const markerPath = join(installRoot, ".managed-by-relmio.json");
  const marker = JSON.parse(await readFile(markerPath, "utf8"));
  marker.schemaVersion = 2;
  await writeFile(markerPath, `${JSON.stringify(marker)}\n`, { mode: 0o600 });
  const before = runner.calls.length;
  const status = await getManagedLocalEndpointStatus({ target: plan.target }, deps(homeDirectory, runner));
  assert.equal(status.state, "legacy");
  assert.equal(status.snapshot.migrationRequired, true);
  assert.equal(status.snapshot.auth.configured, false);
  assert.equal(status.snapshot.canRotateCredential, false);
  assert.equal(runner.calls.slice(before).some(call => call.args.includes("/app/services/siwc-handoff.mjs")), false);
});

test("reviewed Codex capability rotation rejects a stale destination generation before write", async t => {
  const { homeDirectory, registration, destinationRoot, plan } = await fixture(t);
  const runner = fakeDocker({ target: plan.target, destinationRoot });
  await installLocalEndpoint({ plan, registration, confirmed: true }, deps(homeDirectory, runner));
  const prepared = await prepareLocalClientCredentialRotation(
    { target: plan.target }, deps(homeDirectory, runner),
  );
  assert.equal(prepared.registrationId, registrationId);
  assert.equal(typeof prepared.expectedGeneration, "string");
  const installRoot = await resolveLocalInstallRoot({ target: plan.target, homeDirectory, env: {} });
  const original = await readFile(join(installRoot, "docker-compose.yml"), "utf8");
  await assert.rejects(() => activateLocalClientCredentialRotation({
    target: plan.target, clientCredential: prepared.clientCredential,
    tokenSha256: prepared.tokenSha256, registrationId,
    expectedGeneration: randomUUID(),
  }, deps(homeDirectory, runner)), /review|changed/i);
  assert.equal(await readFile(join(installRoot, "docker-compose.yml"), "utf8"), original);
});

test("reviewed Codex migration stops only old writer and retains old volumes offline", async t => {
  const { homeDirectory, registration, destinationRoot, plan } = await fixture(t);
  const { oldInstallId, oldProject, installRoot } = await legacyFixture(homeDirectory, plan.target);
  const runner = fakeLegacyDocker({
    target: plan.target, destinationRoot, oldInstallId, oldProject,
  });
  const legacyBinding = await reviewLocalCodexLegacyMigration(
    { target: plan.target }, deps(homeDirectory, runner),
  );
  assert.equal(legacyBinding.running, true);
  assert.equal(legacyBinding.containerId, "f".repeat(64));
  assert.equal(legacyBinding.imageId, `sha256:${"7".repeat(64)}`);
  assert.deepEqual(legacyBinding.volumeNames, runner.oldVolumeNames);
  const result = await installLocalEndpoint({
    plan, registration, confirmed: true, migrationConsent: true, legacyBinding,
  }, deps(homeDirectory, runner));
  assert.equal(result.deploymentMode, "migrated");
  assert.equal(result.migratedLegacy, true);
  assert.equal(result.legacyRetained, true);
  assert.equal(result.account.ownerRuntimeId, installId);
  assert.equal(runner.isOldRunning(), false);
  assert.equal(runner.calls.filter(call => call.args.includes("stop")).length, 1);
  assert.equal(runner.calls.some(call => call.args.includes("rm") || call.args.includes("down")), false);
  const oldArchive = join(installRoot, "legacy", oldInstallId);
  const archived = JSON.parse(await readFile(join(oldArchive, "migration.json"), "utf8"));
  assert.equal(archived.state, "transferred");
  assert.equal(JSON.parse(await readFile(join(oldArchive, ".managed-by-relmio.json"), "utf8")).installId, oldInstallId);
  assert.deepEqual(runner.oldVolumeNames, legacyBinding.volumeNames);
  const source = (await listRegistrations({ storageRoot: registration.storageRoot }))[0];
  assert.equal(source.ownership, "transferred");
});

test("legacy migration requires separate consent and exact image/volume binding before stopping", async t => {
  const { homeDirectory, registration, destinationRoot, plan } = await fixture(t);
  const { oldInstallId, oldProject, installRoot } = await legacyFixture(homeDirectory, plan.target);
  const runner = fakeLegacyDocker({
    target: plan.target, destinationRoot, oldInstallId, oldProject,
  });
  const legacyBinding = await reviewLocalCodexLegacyMigration(
    { target: plan.target }, deps(homeDirectory, runner),
  );
  const before = runner.calls.length;
  await assert.rejects(() => installLocalEndpoint({
    plan, registration, confirmed: true, migrationConsent: false, legacyBinding,
  }, deps(homeDirectory, runner)));
  assert.equal(runner.calls.length, before);
  runner.setOldImageId(`sha256:${"9".repeat(64)}`);
  await assert.rejects(() => installLocalEndpoint({
    plan, registration, confirmed: true, migrationConsent: true, legacyBinding,
  }, deps(homeDirectory, runner)), /changed/i);
  assert.equal(runner.isOldRunning(), true);
  assert.equal(JSON.parse(await readFile(join(installRoot, ".managed-by-relmio.json"), "utf8")).schemaVersion, 2);
});

test("ambiguous migration handoff leaves old Codex writer stopped and protected source frozen", async t => {
  const { homeDirectory, registration, destinationRoot, plan } = await fixture(t);
  const { oldInstallId, oldProject, installRoot } = await legacyFixture(homeDirectory, plan.target);
  const runner = fakeLegacyDocker({
    target: plan.target, destinationRoot, oldInstallId, oldProject, failAccept: true,
  });
  const legacyBinding = await reviewLocalCodexLegacyMigration(
    { target: plan.target }, deps(homeDirectory, runner),
  );
  await assert.rejects(() => installLocalEndpoint({
    plan, registration, confirmed: true, migrationConsent: true, legacyBinding,
  }, deps(homeDirectory, runner)), /unresolved/);
  assert.equal(runner.isOldRunning(), false);
  const journal = JSON.parse(await readFile(join(installRoot, "legacy", oldInstallId, "migration.json"), "utf8"));
  assert.equal(journal.state, "stopped");
  const [source] = await listRegistrations({ storageRoot: registration.storageRoot });
  assert.equal(source.ownership, "handoff-pending");
  await assert.rejects(() => getAccessToken(registration, { runtimeId: "wizard" }));
  const status = await getManagedLocalEndpointStatus({ target: plan.target }, deps(homeDirectory, runner));
  assert.equal(status.state, "staged");
  assert.equal(status.staging.stage, "handoff-pending");
  assert.equal(status.staging.registrationId, registrationId);
});

test("reviewed Codex account replacement retains signed-out old history offline", async t => {
  const { homeDirectory, registration, destinationRoot, plan } = await fixture(t);
  const oldRunner = fakeDocker({ target: plan.target, destinationRoot });
  await installLocalEndpoint({ plan, registration, confirmed: true }, deps(homeDirectory, oldRunner));
  const current = await getManagedLocalEndpointStatus({ target: plan.target }, deps(homeDirectory, oldRunner));
  const signedOut = await manageLocalSiwcInstallation({
    target: plan.target, registrationId,
    action: "sign-out", expectedGeneration: current.snapshot.auth.account.generation,
    confirmed: true,
  }, deps(homeDirectory, oldRunner));
  assert.equal(signedOut.account.session, "signed-out");
  const nextId = "registration_codex_next";
  const next = { storageRoot: registration.storageRoot, registrationId: nextId };
  const connected = await commitAuthorization({
    ...next, clientId: "oaiapp_codex_next", runtimeId: "wizard",
    identity: { issuer: "https://auth.openai.com", subject: randomUUID() },
    tokens: {
      access_token: "next-fake-access", refresh_token: "next-fake-refresh",
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
      registrationId: nextId, clientId: "oaiapp_codex_next",
      generation: enabled.generation,
      ownerHostId: enabled.ownerHostId, ownerRuntimeId: enabled.ownerRuntimeId,
    },
  };
  const newInstallId = "e".repeat(32);
  const newRoot = `${destinationRoot}-next`;
  const newRunner = fakeDocker({
    target: plan.target, destinationRoot: newRoot,
    projectInstallId: newInstallId, selectedRegistrationId: nextId,
    containerId: "a".repeat(64),
  });
  const oldProject = `relmio-${plan.target}-${installId}`;
  const newProject = `relmio-${plan.target}-${newInstallId}`;
  const calls = [];
  const runner = async spec => {
    calls.push(spec);
    const args = spec.args;
    if (args.includes(oldProject) || args.includes(`label=com.docker.compose.project=${oldProject}`) ||
        args.at(-1) === CONTAINER_ID ||
        args.at(-1) === `${oldProject}_default`) return oldRunner(spec);
    if (args.includes(newProject) || args.includes(`label=com.docker.compose.project=${newProject}`) ||
        args.at(-1) === "a".repeat(64) ||
        args.at(-1) === `${newProject}_default`) return newRunner(spec);
    return oldRunner(spec);
  };
  runner.calls = calls;
  const reviewed = await reviewLocalCodexSiwcReplacement({ target: plan.target }, deps(homeDirectory, runner));
  const existingBinding = { ...reviewed, expectedGeneration: signedOut.account.generation };
  await assert.rejects(() => installLocalEndpoint({
    plan: nextPlan, registration: next, confirmed: true,
    replacementConsent: false, existingBinding,
  }, deps(homeDirectory, runner, { randomBytes: () => Buffer.alloc(32, 0xee) })));
  const installed = await installLocalEndpoint({
    plan: nextPlan, registration: next, confirmed: true,
    replacementConsent: true, existingBinding,
  }, deps(homeDirectory, runner, { randomBytes: () => Buffer.alloc(32, 0xee) }));
  assert.equal(installed.deploymentMode, "replaced");
  assert.equal(installed.replacedAccount, true);
  assert.equal(installed.oldHistoryRetained, true);
  assert.equal(installed.account.ownerRuntimeId, newInstallId);
  assert.equal((await listRegistrations({ storageRoot: destinationRoot }))[0].session, "signed-out");
  assert.equal((await listRegistrations({ storageRoot: newRoot }))[0].ownership, "owned");
  assert.equal(calls.some(call => call.args.includes("down") || call.args.includes("rm")), false);
});

test("post-receipt Codex start failure returns local bearer with stopped owner warning", async t => {
  const { homeDirectory, registration, destinationRoot, plan } = await fixture(t);
  const runner = fakeDocker({ target: plan.target, destinationRoot, failStart: true });
  const result = await installLocalEndpoint({ plan, registration, confirmed: true }, deps(homeDirectory, runner));
  assert.equal(result.deploymentMode, "partial");
  assert.equal(result.runtimeState, "stopped");
  assert.equal(result.readiness, "unverified");
  assert.equal(result.runtimeFailure.recovery, "resolve-handoff");
  assert.equal(typeof result.clientCredential, "string");
  assert.equal(result.account.ownership, "owned");
  assert.equal((await listRegistrations({ storageRoot: registration.storageRoot }))[0].ownership, "transferred");
});

test("lost Codex acceptance acknowledgment reconciles durable receipt after destination changes", async t => {
  const { homeDirectory, registration, destinationRoot, plan } = await fixture(t);
  const runner = fakeDocker({ target: plan.target, destinationRoot, loseAcceptAck: true });
  await assert.rejects(() => installLocalEndpoint({ plan, registration, confirmed: true }, deps(homeDirectory, runner)),
    error => error.remoteOutcomeUnknown === true);
  const [destination] = await listRegistrations({ storageRoot: destinationRoot });
  await setPlanEnabled({ storageRoot: destinationRoot, registrationId }, {
    enabled: false, expectedGeneration: destination.generation,
  });
  const result = await reconcileLocalSiwcHandoff({ target: plan.target, registration, confirmed: true }, deps(homeDirectory, runner));
  assert.equal(result.outcome, "finished");
  assert.equal(result.account.ownership, "transferred");
  assert.deepEqual((await readRegistration(registration)).session, {});
  assert.equal(runner.calls.filter(call => call.args.at(-1) === "accept").length, 1);
  assert.equal((await reconcileLocalSiwcHandoff({ target: plan.target, registration, confirmed: true },
    deps(homeDirectory, runner))).outcome, "finished");
});

test("Codex receipt absence and transport uncertainty never thaw the sender", async t => {
  const { homeDirectory, registration, destinationRoot, plan } = await fixture(t);
  const runner = fakeDocker({ target: plan.target, destinationRoot, failAccept: true });
  await assert.rejects(() => installLocalEndpoint({ plan, registration, confirmed: true }, deps(homeDirectory, runner)));
  assert.equal((await reconcileLocalSiwcHandoff({ target: plan.target, registration, confirmed: true },
    deps(homeDirectory, runner))).outcome, "not-accepted");
  const failed = async spec => {
    if (spec.args.at(-1) === "receipt") return { code: 1, stdout: "", stderr: "secret" };
    return runner(spec);
  };
  await assert.rejects(() => reconcileLocalSiwcHandoff({ target: plan.target, registration, confirmed: true },
    deps(homeDirectory, failed)), error => error.remoteOutcomeUnknown === true && !error.message.includes("secret"));
  assert.equal((await listRegistrations({ storageRoot: registration.storageRoot }))[0].ownership, "handoff-pending");
  await assert.rejects(() => getAccessToken(registration, { runtimeId: "wizard" }));
});

test("Codex staging precedes directory writes and reviewed resume retains one project", async t => {
  const { homeDirectory, registration, destinationRoot, plan } = await fixture(t);
  const runner = fakeDocker({ target: plan.target, destinationRoot });
  const fileSystem = { ...fs, mkdir: async (path, options) => {
    if (path.endsWith(join("local", plan.target))) {
      const staged = JSON.parse(await readFile(join(homeDirectory, `.relmio-local-${plan.target}.siwc-staging.json`), "utf8"));
      assert.equal(staged.registrationId, registrationId);
      assert.equal(staged.installId, installId);
      throw new Error("Interrupted before endpoint directory");
    }
    return fs.mkdir(path, options);
  } };
  await assert.rejects(() => installLocalEndpoint({ plan, registration, confirmed: true },
    deps(homeDirectory, runner, { fileSystem })));
  const status = await getManagedLocalEndpointStatus({ target: plan.target }, deps(homeDirectory, runner));
  assert.equal(status.state, "staged");
  const resume = await reviewLocalSiwcResume({ target: plan.target, registration }, deps(homeDirectory, runner));
  const installed = await installLocalEndpoint({ plan: resume.plan, registration, resume, confirmed: true },
    deps(homeDirectory, runner, { randomBytes: () => Buffer.alloc(32, 0xee) }));
  assert.equal(installed.account.ownerRuntimeId, installId);
  assert.equal(runner.calls.filter(call => call.args.at(-1) === "accept").length, 1);
  assert.equal(runner.calls.some(call => call.args.includes("down")), false);
});

test("Codex interrupted build and file drift reject stale resume before another write", async t => {
  const { homeDirectory, registration, destinationRoot, plan } = await fixture(t);
  const runner = fakeDocker({ target: plan.target, destinationRoot });
  const failed = async spec => spec.args.includes("build")
    ? { code: 1, stdout: "" } : runner(spec);
  await assert.rejects(() => installLocalEndpoint({ plan, registration, confirmed: true }, deps(homeDirectory, failed)));
  const resume = await reviewLocalSiwcResume({ target: plan.target, registration }, deps(homeDirectory, runner));
  const installRoot = await resolveLocalInstallRoot({ target: plan.target, homeDirectory, env: {} });
  await writeFile(join(installRoot, "Dockerfile"), "changed", { mode: 0o600 });
  const before = runner.calls.length;
  await assert.rejects(() => installLocalEndpoint({ plan: resume.plan, registration, resume, confirmed: true }, deps(homeDirectory, runner)));
  assert.equal(runner.calls.slice(before).some(call => call.args.includes("build") || call.args.includes("up")), false);
  const fresh = await reviewLocalSiwcResume({ target: plan.target, registration }, deps(homeDirectory, runner));
  assert.equal((await installLocalEndpoint({ plan: fresh.plan, registration, resume: fresh, confirmed: true },
    deps(homeDirectory, runner))).account.ownerRuntimeId, installId);
});

test("Codex migrated key survives journal and operation-lock release failure", async t => {
  for (const failure of ["journal", "lock"]) {
    const { homeDirectory, registration, destinationRoot, plan } = await fixture(t);
    const legacy = await legacyFixture(homeDirectory, plan.target);
    const runner = fakeLegacyDocker({ target: plan.target, destinationRoot, ...legacy });
    const legacyBinding = await reviewLocalCodexLegacyMigration({ target: plan.target }, deps(homeDirectory, runner));
    const fileSystem = { ...fs,
      writeFile: async (path, contents, options) => {
        if (failure === "journal" && path.includes("migration.json.tmp-") &&
            JSON.parse(contents.toString()).state === "transferred") throw new Error("secret journal failure");
        return fs.writeFile(path, contents, options);
      },
      rename: async (from, to) => {
        if (failure === "lock" && from.endsWith(`.relmio-local-${plan.target}.lock`)) throw new Error("lock cleanup failed");
        return fs.rename(from, to);
      },
    };
    const result = await installLocalEndpoint({ plan, registration, confirmed: true, migrationConsent: true, legacyBinding },
      deps(homeDirectory, runner, { fileSystem }));
    assert.equal(result.deploymentMode, "partial");
    assert.equal(result.credentialShownOnce, true);
    assert.equal(typeof result.clientCredential, "string");
    assert.equal(result.finalizationFailure.recovery, "review-again");
    assert.equal(result.account.ownership, "owned");
    assert.equal((await listRegistrations({ storageRoot: registration.storageRoot }))[0].ownership, "transferred");
    assert.equal(JSON.stringify(result).includes("secret journal"), false);
  }
});

test("Codex post-transfer resume rotates bearer without another acceptance", async t => {
  const { homeDirectory, registration, destinationRoot, plan } = await fixture(t);
  const runner = fakeDocker({ target: plan.target, destinationRoot, failStart: true });
  const partial = await installLocalEndpoint({ plan, registration, confirmed: true }, deps(homeDirectory, runner));
  runner.setFailStart(false);
  const resume = await reviewLocalSiwcResume({ target: plan.target, registration }, deps(homeDirectory, runner));
  const result = await installLocalEndpoint({ plan: resume.plan, registration, resume, confirmed: true },
    deps(homeDirectory, runner, { randomBytes: () => Buffer.alloc(32, 0xee) }));
  assert.notEqual(result.clientCredential, partial.clientCredential);
  assert.equal(result.account.ownerRuntimeId, installId);
  assert.equal(result.runtimeState, "running");
  assert.equal(runner.calls.filter(call => call.args.at(-1) === "accept").length, 1);
});

test("Codex interrupted legacy build completes reviewed resume with old writer offline", async t => {
  const { homeDirectory, registration, destinationRoot, plan } = await fixture(t);
  const legacy = await legacyFixture(homeDirectory, plan.target);
  const runner = fakeLegacyDocker({ target: plan.target, destinationRoot, ...legacy });
  const legacyBinding = await reviewLocalCodexLegacyMigration({ target: plan.target }, deps(homeDirectory, runner));
  const failed = async spec => spec.args.includes("build") ? { code: 1, stdout: "" } : runner(spec);
  await assert.rejects(() => installLocalEndpoint({ plan, registration, confirmed: true, migrationConsent: true, legacyBinding },
    deps(homeDirectory, failed)));
  const resume = await reviewLocalSiwcResume({ target: plan.target, registration }, deps(homeDirectory, runner));
  assert.equal(resume.migration, "legacy");
  const result = await installLocalEndpoint({ plan: resume.plan, registration, resume, confirmed: true }, deps(homeDirectory, runner));
  assert.equal(result.deploymentMode, "migrated");
  assert.equal(runner.isOldRunning(), false);
  assert.equal(runner.calls.filter(call => call.args.at(-1) === "accept").length, 1);
});

test("Codex unaccepted frozen transfer can resume with independent fresh registration", async t => {
  const { homeDirectory, registration, destinationRoot, plan } = await fixture(t);
  const runner = fakeDocker({ target: plan.target, destinationRoot, failAccept: true });
  await assert.rejects(() => installLocalEndpoint({ plan, registration, confirmed: true }, deps(homeDirectory, runner)));
  await reconcileLocalSiwcHandoff({ target: plan.target, registration, confirmed: true }, deps(homeDirectory, runner));
  const next = { ...registration, registrationId: "registration_codex_resume" };
  const connected = await commitAuthorization({ ...next, clientId: "oaiapp_resume", runtimeId: "wizard",
    identity: { issuer: "https://auth.openai.com", subject: randomUUID() },
    tokens: { access_token: "fresh-access", refresh_token: "fresh-refresh", token_type: "Bearer",
      expires_in: 3600, scope: "openid profile offline_access resource.invoke chatgpt.tokens.use.direct" } });
  await setPlanEnabled(next, { enabled: true, expectedGeneration: connected.generation });
  const resume = await reviewLocalSiwcResume({ target: plan.target, registration: next }, deps(homeDirectory, runner));
  assert.equal(resume.registrationId, next.registrationId);
  runner.setRegistrationId(next.registrationId);
  runner.setFailAccept(false);
  const result = await installLocalEndpoint({ plan: resume.plan, registration: next, resume, confirmed: true }, deps(homeDirectory, runner));
  assert.equal(result.account.registrationId, next.registrationId);
  assert.equal((await readRegistration(registration)).handoff.state, "handoff-pending");
  assert.equal((await readRegistration(next)).handoff.state, "transferred");
  assert.equal(runner.calls.filter(call => call.args.at(-1) === "accept").length, 2);
});

test("Codex post-receipt checkpoint failure preserves committed client key", async t => {
  const { homeDirectory, registration, destinationRoot, plan } = await fixture(t);
  const runner = fakeDocker({ target: plan.target, destinationRoot });
  const fileSystem = { ...fs, writeFile: async (path, contents, options) => {
    if (path.includes(".siwc-staging.json.tmp-") && JSON.parse(contents.toString()).stage === "transferred") {
      throw new Error("Checkpoint unavailable");
    }
    return fs.writeFile(path, contents, options);
  } };
  const result = await installLocalEndpoint({ plan, registration, confirmed: true }, deps(homeDirectory, runner, { fileSystem }));
  assert.equal(typeof result.clientCredential, "string");
  assert.equal(result.credentialShownOnce, true);
  assert.equal(result.deploymentMode, "partial");
  assert.equal(result.finalizationFailure.recovery, "resolve-handoff");
  assert.deepEqual((await readRegistration(registration)).session, {});
});

test("Codex enable verification failure confirms exact service stop or reports unknown", async t => {
  for (const fault of ["malformed", "nonzero", "liveness", "lost-stop"]) {
    const { homeDirectory, registration, destinationRoot, plan } = await fixture(t);
    const runner = fakeDocker({ target: plan.target, destinationRoot });
    const installed = await installLocalEndpoint({ plan, registration, confirmed: true }, deps(homeDirectory, runner));
    const disabled = await manageLocalSiwcInstallation({ target: plan.target, registrationId, action: "disable-plan",
      expectedGeneration: installed.account.generation, confirmed: true }, deps(homeDirectory, runner));
    let started = false;
    let failureStop = false;
    const failed = async spec => {
      if (spec.args.includes("up")) { started = true; return runner(spec); }
      if (started && spec.args.includes("stop")) failureStop = true;
      if (started && spec.args.includes("--format") && spec.args.includes("ps")) {
        return fault === "nonzero" ? { code: 1, stdout: "" } : { code: 0, stdout: "malformed" };
      }
      if (started && !failureStop && fault === "liveness" && spec.args.includes("--status")) return { code: 1, stdout: "" };
      if (started && fault === "lost-stop" && spec.args.includes("stop")) throw new Error("Lost stop acknowledgment");
      return runner(spec);
    };
    await assert.rejects(() => manageLocalSiwcInstallation({ target: plan.target, registrationId, action: "enable-plan",
      expectedGeneration: disabled.account.generation, confirmed: true }, deps(homeDirectory, failed)),
    error => error.runtimeStopped === (fault !== "lost-stop") && error.remoteOutcomeUnknown === (fault === "lost-stop"));
  }
});

test("Codex staged resume reviews current generation without rebinding stable source identity", async t => {
  const { homeDirectory, registration, destinationRoot, plan } = await fixture(t);
  const runner = fakeDocker({ target: plan.target, destinationRoot });
  const failed = async spec => spec.args.includes("build") ? { code: 1, stdout: "" } : runner(spec);
  await assert.rejects(() => installLocalEndpoint({ plan, registration, confirmed: true }, deps(homeDirectory, failed)));
  const disabled = await setPlanEnabled(registration, { enabled: false, expectedGeneration: plan.authBinding.generation });
  const enabled = await setPlanEnabled(registration, { enabled: true, expectedGeneration: disabled.generation });
  const resume = await reviewLocalSiwcResume({ target: plan.target, registration }, deps(homeDirectory, runner));
  assert.equal(resume.plan.authBinding.generation, enabled.generation);
  await assert.rejects(() => reviewLocalSiwcResume({ target: plan.target }, deps(homeDirectory, runner)));
  for (const field of ["registrationId", "clientId", "ownerHostId", "ownerRuntimeId"]) {
    assert.equal(resume.plan.authBinding[field], plan.authBinding[field]);
  }
  const installRoot = await resolveLocalInstallRoot({ target: plan.target, homeDirectory, env: {} });
  await writeFile(join(installRoot, "retained-user-data.txt"), "keep", { mode: 0o600 });
  const reviewed = await reviewLocalSiwcResume({ target: plan.target, registration }, deps(homeDirectory, runner));
  const installed = await installLocalEndpoint({ plan: reviewed.plan, registration, resume: reviewed, confirmed: true }, deps(homeDirectory, runner));
  assert.equal(installed.account.ownerRuntimeId, installId);
  assert.equal(runner.calls.filter(call => call.args.at(-1) === "accept").length, 1);
  assert.equal(runner.calls.some(call => call.args.includes("down") || call.args.includes("rm")), false);
  assert.equal(await readFile(join(installRoot, "retained-user-data.txt"), "utf8"), "keep");
  const checkpoint = JSON.parse(await readFile(join(homeDirectory, `.relmio-local-${plan.target}.siwc-staging.json`), "utf8"));
  assert.equal(checkpoint.plan.authBinding.generation, enabled.generation);
});

test("shared lifecycle lock preserves incomplete claims when reclamation is disabled and types contention", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "relmio-lock-policy-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lockPath = join(root, "operation.lock");
  await mkdir(lockPath, { mode: 0o700 });
  const earlier = new Date(Date.now() - 120_000);
  await fs.utimes(lockPath, earlier, earlier);
  const options = {
    fileSystem: fs, lockPath, platform: process.platform,
    getProcessIdentity: async () => ({ state: "active", startIdentity: "current-process" }),
    lockDownPath: async () => {},
  };
  await assert.rejects(() => acquireLocalIntegrationLifecycleLock({ ...options, reclaimIncomplete: false }),
    error => error.code === "RELMIO_LOCK_BUSY");
  assert.deepEqual(await fs.readdir(lockPath), []);
  await assert.rejects(() => acquireLocalIntegrationLifecycleLock({ ...options, reclaimIncomplete: "false" }), TypeError);
  const release = await acquireLocalIntegrationLifecycleLock(options);
  await assert.rejects(() => acquireLocalIntegrationLifecycleLock({ ...options, reclaimIncomplete: false }),
    error => error.code === "RELMIO_LOCK_BUSY" && Object.keys(error).includes("code"));
  await release();
});

test("shared lifecycle lock never probes or reclaims a foreign PID namespace", async t => {
  for (const ownerState of ["dead", "reused"]) {
    const root = await realpath(await mkdtemp(join(tmpdir(), "relmio-pid-namespace-")));
    t.after(() => rm(root, { recursive: true, force: true }));
    const lockPath = join(root, "operation.lock");
    const common = { fileSystem: fs, lockPath, platform: process.platform, lockDownPath: async () => {}, reclaimIncomplete: false };
    const release = await acquireLocalIntegrationLifecycleLock({ ...common,
      getPidNamespaceIdentity: async () => "namespace:foreign",
      getProcessIdentity: async () => ({ state: "active", startIdentity: "foreign-start" }),
    });
    const ownerPath = join(lockPath, ".owner.json");
    const before = await readFile(ownerPath, "utf8");
    assert.equal(JSON.parse(before).processNamespaceIdentity, "namespace:foreign");
    let probes = 0;
    await assert.rejects(() => acquireLocalIntegrationLifecycleLock({ ...common,
      getPidNamespaceIdentity: async () => "namespace:local",
      getProcessIdentity: async () => {
        if (++probes === 1) return { state: "active", startIdentity: "local-start" };
        return ownerState === "dead" ? { state: "dead" } : { state: "active", startIdentity: "reused-start" };
      },
    }), error => error.code !== "RELMIO_LOCK_BUSY");
    assert.equal(probes, 1, "only the acquiring process may be probed before namespace comparison");
    assert.equal(await readFile(ownerPath, "utf8"), before);
    await release();
  }
});

test("shared lifecycle lock reclaims a reused PID only within the attested namespace", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "relmio-same-namespace-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lockPath = join(root, "operation.lock");
  const common = { fileSystem: fs, lockPath, platform: process.platform,
    lockDownPath: async () => {}, reclaimIncomplete: false,
    getPidNamespaceIdentity: async () => "namespace:shared" };
  await acquireLocalIntegrationLifecycleLock({ ...common,
    getProcessIdentity: async () => ({ state: "active", startIdentity: "old-start" }) });
  const release = await acquireLocalIntegrationLifecycleLock({ ...common,
    getProcessIdentity: async () => ({ state: "active", startIdentity: "new-start" }) });
  const owner = JSON.parse(await readFile(join(lockPath, ".owner.json"), "utf8"));
  assert.equal(owner.processStartIdentity, "new-start");
  assert.equal(owner.processNamespaceIdentity, "namespace:shared");
  await release();
});

test("shared lifecycle lock preserves legacy or malformed namespace claims and rejects unknown local namespace", async t => {
  for (const legacy of [true, false]) {
    const root = await realpath(await mkdtemp(join(tmpdir(), "relmio-unbound-namespace-")));
    t.after(() => rm(root, { recursive: true, force: true }));
    const lockPath = join(root, "operation.lock");
    await mkdir(lockPath, { mode: 0o700 });
    const ownerPath = join(lockPath, ".owner.json");
    const contents = legacy ? JSON.stringify({
      schemaVersion: 2, pid: process.pid, processStartIdentity: "old-start",
      token: randomUUID(), publishedAtMs: Date.now() - 120_000,
    }) : "{";
    await writeFile(ownerPath, contents, { mode: 0o600 });
    const earlier = new Date(Date.now() - 120_000);
    await fs.utimes(ownerPath, earlier, earlier);
    await assert.rejects(() => acquireLocalIntegrationLifecycleLock({
      fileSystem: fs, lockPath, platform: process.platform, lockDownPath: async () => {},
      getPidNamespaceIdentity: async () => "namespace:local",
      getProcessIdentity: async () => ({ state: "active", startIdentity: "current-start" }),
    }));
    assert.equal(await readFile(ownerPath, "utf8"), contents);
  }
  const root = await realpath(await mkdtemp(join(tmpdir(), "relmio-unknown-self-namespace-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lockPath = join(root, "operation.lock");
  await assert.rejects(() => acquireLocalIntegrationLifecycleLock({
    fileSystem: fs, lockPath, platform: process.platform, lockDownPath: async () => {},
    getPidNamespaceIdentity: async () => null,
    getProcessIdentity: async () => ({ state: "active", startIdentity: "current-start" }),
  }));
  await assert.rejects(() => fs.lstat(lockPath), error => error.code === "ENOENT");
});

test("shared lifecycle arbitration also refuses a foreign namespace", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "relmio-arbitration-namespace-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lockPath = join(root, "operation.lock");
  const common = { fileSystem: fs, platform: process.platform, lockDownPath: async () => {}, reclaimIncomplete: false };
  const releaseOwner = await acquireLocalIntegrationLifecycleLock({ ...common, lockPath,
    getPidNamespaceIdentity: async () => "namespace:local",
    getProcessIdentity: async () => ({ state: "active", startIdentity: "old-start" }) });
  const releaseArbitration = await acquireLocalIntegrationLifecycleLock({ ...common, lockPath: join(lockPath, ".reclaim"),
    getPidNamespaceIdentity: async () => "namespace:foreign",
    getProcessIdentity: async () => ({ state: "active", startIdentity: "foreign-start" }) });
  const before = await readFile(join(lockPath, ".owner.json"), "utf8");
  let probes = 0;
  await assert.rejects(() => acquireLocalIntegrationLifecycleLock({ ...common, lockPath,
    getPidNamespaceIdentity: async () => "namespace:local",
    getProcessIdentity: async () => { probes++; return { state: "active", startIdentity: "new-start" }; },
  }));
  assert.equal(probes, 2, "foreign arbitration PID must not be probed");
  assert.equal(await readFile(join(lockPath, ".owner.json"), "utf8"), before);
  await releaseArbitration();
  await releaseOwner();
});

test("foreign namespace lease recovery is opt-in and uses boot-bound monotonic age", async t => {
  const boot = "11111111-1111-4111-8111-111111111111";
  for (const [age, leaseMs, outcome] of [
    [600_001, undefined, "ambiguous"],
    [599_999, 600_000, "busy"],
    [600_000, 600_000, "busy"],
    [600_001, 600_000, "reclaimed"],
    [-1, 600_000, "ambiguous"],
  ]) {
    const root = await realpath(await mkdtemp(join(tmpdir(), "relmio-lease-age-")));
    t.after(() => rm(root, { recursive: true, force: true }));
    const lockPath = join(root, "operation.lock");
    const acquiredAt = 1_000_000;
    const common = { fileSystem: fs, lockPath, platform: process.platform,
      lockDownPath: async () => {}, reclaimIncomplete: false,
      getProcessIdentity: async () => ({ state: "active", startIdentity: "current-start" }) };
    const releaseOwner = await acquireLocalIntegrationLifecycleLock({ ...common,
      getPidNamespaceIdentity: async () => `linux:${boot}:pid:42`, leaseNow: () => acquiredAt });
    const before = await readFile(join(lockPath, ".owner.json"), "utf8");
    const candidate = { ...common, getPidNamespaceIdentity: async () => `linux:${boot}:pid:43`,
      leaseNow: () => acquiredAt + age, now: () => Date.now() + 86_400_000,
      ...(leaseMs === undefined ? {} : { leaseMs }) };
    if (outcome === "reclaimed") {
      const release = await acquireLocalIntegrationLifecycleLock(candidate);
      const owner = JSON.parse(await readFile(join(lockPath, ".owner.json"), "utf8"));
      assert.equal(owner.acquiredAt, acquiredAt + age);
      assert.equal(owner.processNamespaceIdentity, `linux:${boot}:pid:43`);
      await assert.rejects(() => releaseOwner());
      await release();
    } else {
      await assert.rejects(() => acquireLocalIntegrationLifecycleLock(candidate),
        error => outcome === "busy" ? error.code === "RELMIO_LOCK_BUSY" : error.code !== "RELMIO_LOCK_BUSY");
      assert.equal(await readFile(join(lockPath, ".owner.json"), "utf8"), before);
      await releaseOwner();
    }
  }
});

test("opt-in lease recovery reclaims an old boot despite a reset monotonic counter", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "relmio-lease-reboot-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lockPath = join(root, "operation.lock");
  const beforeBoot = "11111111-1111-4111-8111-111111111111";
  const afterBoot = "22222222-2222-4222-8222-222222222222";
  const common = { fileSystem: fs, lockPath, platform: process.platform, lockDownPath: async () => {},
    reclaimIncomplete: false, getProcessIdentity: async () => ({ state: "active", startIdentity: "current-start" }) };
  await acquireLocalIntegrationLifecycleLock({ ...common,
    getPidNamespaceIdentity: async () => `linux:${beforeBoot}:pid:42`, leaseNow: () => 1_000_000_000 });
  await assert.rejects(() => acquireLocalIntegrationLifecycleLock({ ...common,
    getPidNamespaceIdentity: async () => `linux:${afterBoot}:pid:43`, leaseNow: () => 100 }));
  let probes = 0;
  const release = await acquireLocalIntegrationLifecycleLock({ ...common, leaseMs: 600_000,
    getPidNamespaceIdentity: async () => `linux:${afterBoot}:pid:43`, leaseNow: () => 100,
    getProcessIdentity: async () => { probes++; return { state: "active", startIdentity: "current-start" }; } });
  assert.equal(probes, 1, "a prior-boot PID cannot be meaningfully probed");
  const owner = JSON.parse(await readFile(join(lockPath, ".owner.json"), "utf8"));
  assert.equal(owner.acquiredAt, 100);
  assert.equal(owner.processNamespaceIdentity, `linux:${afterBoot}:pid:43`);
  await release();
});

test("foreign lease recovery preserves missing clock or boot proof and rechecks changed claims atomically", async t => {
  const boot = "11111111-1111-4111-8111-111111111111";
  for (const missing of ["acquiredAt", "malformed-clock", "boot"]) {
    const root = await realpath(await mkdtemp(join(tmpdir(), "relmio-unproved-lease-")));
    t.after(() => rm(root, { recursive: true, force: true }));
    const lockPath = join(root, "operation.lock");
    const common = { fileSystem: fs, lockPath, platform: process.platform, lockDownPath: async () => {},
      reclaimIncomplete: false, getProcessIdentity: async () => ({ state: "active", startIdentity: "current-start" }) };
    await acquireLocalIntegrationLifecycleLock({ ...common,
      getPidNamespaceIdentity: async () => `linux:${boot}:pid:42`, leaseNow: () => 1_000_000 });
    const path = join(lockPath, ".owner.json");
    const owner = JSON.parse(await readFile(path, "utf8"));
    if (missing === "acquiredAt") delete owner.acquiredAt;
    if (missing === "malformed-clock") owner.acquiredAt = "not-a-clock";
    await writeFile(path, JSON.stringify(owner), { mode: 0o600 });
    const before = await readFile(path, "utf8");
    await assert.rejects(() => acquireLocalIntegrationLifecycleLock({ ...common, leaseMs: 600_000,
      getPidNamespaceIdentity: async () => missing === "boot" ? "namespace:unknown" : `linux:${boot}:pid:43`,
      leaseNow: () => 1_600_001 }));
    assert.equal(await readFile(path, "utf8"), before);
  }
  const root = await realpath(await mkdtemp(join(tmpdir(), "relmio-lease-recheck-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lockPath = join(root, "operation.lock");
  const ownerPath = join(lockPath, ".owner.json");
  const common = { fileSystem: fs, lockPath, platform: process.platform, lockDownPath: async () => {},
    reclaimIncomplete: false, getProcessIdentity: async () => ({ state: "active", startIdentity: "current-start" }) };
  await acquireLocalIntegrationLifecycleLock({ ...common,
    getPidNamespaceIdentity: async () => `linux:${boot}:pid:42`, leaseNow: () => 1_000_000 });
  let renewed;
  let outerDetaches = 0;
  const fileSystem = { ...fs,
    mkdir: async (path, options) => {
      if (path === join(lockPath, ".reclaim")) {
        const owner = JSON.parse(await readFile(ownerPath, "utf8"));
        renewed = JSON.stringify({ ...owner, acquiredAt: 1_600_001, token: randomUUID() });
        await writeFile(ownerPath, renewed, { mode: 0o600 });
      }
      return fs.mkdir(path, options);
    },
    rename: async (from, to) => { if (from === lockPath) outerDetaches++; return fs.rename(from, to); },
  };
  await assert.rejects(() => acquireLocalIntegrationLifecycleLock({ ...common, fileSystem, leaseMs: 600_000,
    getPidNamespaceIdentity: async () => `linux:${boot}:pid:43`, leaseNow: () => 1_600_001 }),
    error => error.code === "RELMIO_LOCK_CHANGED");
  assert.equal(outerDetaches, 0);
  assert.equal(await readFile(ownerPath, "utf8"), renewed);
});

test("lifecycle lock types inspection races and self-identity failures without accepting unsafe data", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "relmio-lock-race-code-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lockPath = join(root, "operation.lock");
  const common = { fileSystem: fs, lockPath, platform: process.platform,
    lockDownPath: async () => {}, getPidNamespaceIdentity: async () => "namespace:shared",
    getProcessIdentity: async () => ({ state: "active", startIdentity: "current-start" }) };
  await assert.rejects(() => acquireLocalIntegrationLifecycleLock({ ...common,
    getProcessIdentity: async () => ({ state: "ambiguous" }) }),
    error => error.code === "RELMIO_LOCK_IDENTITY_UNAVAILABLE");
  const release = await acquireLocalIntegrationLifecycleLock(common);
  const fileSystem = { ...fs, readFile: async (path, encoding) => {
    if (path === join(lockPath, ".owner.json")) throw Object.assign(new Error("released concurrently"), { code: "ENOENT" });
    return fs.readFile(path, encoding);
  } };
  await assert.rejects(() => acquireLocalIntegrationLifecycleLock({ ...common, fileSystem }),
    error => error.code === "RELMIO_LOCK_CHANGED");
  await release();
  for (const leaseMs of [0, -1, "600000", false, 1.5, Infinity]) {
    await assert.rejects(() => acquireLocalIntegrationLifecycleLock({ ...common, leaseMs }), TypeError);
  }
});

test("atomic lock publication ignores an interrupted private temp record", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "relmio-atomic-crash-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lockPath = join(root, "operation.lock");
  const options = { fileSystem: fs, lockPath, atomicPublication: true,
    lockDownPath: async () => {}, getPidNamespaceIdentity: async () => "namespace:shared",
    getProcessIdentity: async () => ({ state: "active", startIdentity: "current-start" }) };
  const interrupted = { ...fs, open: async (path, ...args) => {
    const handle = await fs.open(path, ...args);
    return new Proxy(handle, { get(target, property) {
      if (property === "sync" && path.includes(".publication-")) return async () => { throw new Error("crash before publication"); };
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    } });
  } };
  await assert.rejects(() => acquireLocalIntegrationLifecycleLock({ ...options, fileSystem: interrupted }),
    error => error.code === "RELMIO_LOCK_UNAVAILABLE");
  await assert.rejects(() => fs.lstat(lockPath), error => error.code === "ENOENT");
  assert.equal((await fs.readdir(root)).some(name => name.includes(".publication-")), true);
  const release = await acquireLocalIntegrationLifecycleLock(options);
  assert.equal((await fs.lstat(lockPath)).isFile(), true);
  assert.equal(typeof release.acquiredAt, "number");
  await release();
});

test("concurrent atomic lock acquirers publish exactly one owner and release only their exact record", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "relmio-atomic-race-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lockPath = join(root, "operation.lock");
  const options = { fileSystem: fs, lockPath, atomicPublication: true,
    lockDownPath: async () => {}, getPidNamespaceIdentity: async () => "namespace:shared",
    getProcessIdentity: async () => ({ state: "active", startIdentity: "current-start" }) };
  const results = await Promise.allSettled(Array.from({ length: 4 }, () => acquireLocalIntegrationLifecycleLock(options)));
  assert.equal(results.filter(result => result.status === "fulfilled").length, 1);
  const release = results.find(result => result.status === "fulfilled").value;
  const owner = JSON.parse(await readFile(lockPath, "utf8"));
  const changed = JSON.stringify({ ...owner, token: randomUUID() });
  await writeFile(lockPath, changed, { mode: 0o600 });
  await assert.rejects(() => release());
  assert.equal(await readFile(lockPath, "utf8"), changed);
  await assert.rejects(() => acquireLocalIntegrationLifecycleLock(options),
    error => error.code === "RELMIO_LOCK_BUSY");
  assert.equal(await readFile(lockPath, "utf8"), changed);
});

test("atomic lock refuses malformed files and existing empty directories without replacing them", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "relmio-atomic-corrupt-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const options = { fileSystem: fs, atomicPublication: true,
    lockDownPath: async () => {}, getPidNamespaceIdentity: async () => "namespace:shared",
    getProcessIdentity: async () => ({ state: "active", startIdentity: "current-start" }) };
  const malformed = join(root, "malformed.lock");
  await writeFile(malformed, "{", { mode: 0o600 });
  await assert.rejects(() => acquireLocalIntegrationLifecycleLock({ ...options, lockPath: malformed }));
  assert.equal(await readFile(malformed, "utf8"), "{");
  const empty = join(root, "empty.lock");
  await mkdir(empty, { mode: 0o700 });
  await assert.rejects(() => acquireLocalIntegrationLifecycleLock({ ...options, lockPath: empty }));
  assert.equal((await fs.lstat(empty)).isDirectory(), true);
  assert.deepEqual(await fs.readdir(empty), []);
});

test("atomic lock applies Windows temp ACL before exclusive link and never falls back when unsupported", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "relmio-atomic-unavailable-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lockPath = join(root, "operation.lock");
  const secured = new Set();
  let nonAtomicWrites = 0;
  const fileSystem = { ...fs,
    link: async source => {
      assert.equal(secured.has(source), true);
      throw Object.assign(new Error("filesystem does not support hard links"), { code: "ENOTSUP" });
    },
    writeFile: async () => { nonAtomicWrites++; throw new Error("non-atomic fallback"); },
  };
  await assert.rejects(() => acquireLocalIntegrationLifecycleLock({
    fileSystem, lockPath, atomicPublication: true, platform: "win32",
    lockDownPath: async (path, options) => { if (options.kind === "file" && !options.verifyOnly) secured.add(path); },
    getPidNamespaceIdentity: async () => "win32:host",
    getProcessIdentity: async () => ({ state: "active", startIdentity: "current-start" }),
  }), error => error.code === "RELMIO_LOCK_UNAVAILABLE");
  assert.equal(nonAtomicWrites, 0);
  await assert.rejects(() => fs.lstat(lockPath), error => error.code === "ENOENT");
});

test("Codex receipt absence is not recorded while an acceptance helper may still be running", async t => {
  const { homeDirectory, registration, destinationRoot, plan } = await fixture(t);
  const runner = fakeDocker({ target: plan.target, destinationRoot, failAccept: true });
  await assert.rejects(() => installLocalEndpoint({ plan, registration, confirmed: true }, deps(homeDirectory, runner)));
  const checkpointPath = join(homeDirectory, `.relmio-local-${plan.target}.siwc-staging.json`);
  const before = await readFile(checkpointPath, "utf8");
  const uncertain = async spec => {
    if (spec.args.includes("label=com.docker.compose.oneoff=True")) {
      return { code: 0, stdout: JSON.stringify({ ID: "f".repeat(64), Names: "owned-accept-helper" }) };
    }
    return runner(spec);
  };
  await assert.rejects(() => reconcileLocalSiwcHandoff({ target: plan.target, registration, confirmed: true },
    deps(homeDirectory, uncertain)), error => error.remoteOutcomeUnknown === true);
  assert.equal(await readFile(checkpointPath, "utf8"), before);
  assert.equal((await readRegistration(registration)).handoff.state, "handoff-pending");
  assert.equal(runner.calls.filter(call => call.args.at(-1) === "accept").length, 1);
});

test("atomic release waits through live guard contention and leaves the next acquisition usable", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "relmio-release-guard-wait-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lockPath = join(root, "operation.lock");
  const guardPath = `${lockPath}.publication-lock`;
  const guardPid = process.pid + 17;
  let unblock;
  const guardProbed = new Promise(resolve => { unblock = resolve; });
  const options = { fileSystem: fs, lockPath, atomicPublication: true, releaseWaitMs: 500,
    lockDownPath: async () => {}, getPidNamespaceIdentity: async () => "namespace:shared",
    getProcessIdentity: async pid => {
      if (pid === guardPid) { unblock(); return { state: "active", startIdentity: "guard-start" }; }
      return { state: "active", startIdentity: "owner-start" };
    } };
  const release = await acquireLocalIntegrationLifecycleLock(options);
  const owner = JSON.parse(await readFile(lockPath, "utf8"));
  await writeFile(guardPath, JSON.stringify({ ...owner, pid: guardPid,
    processStartIdentity: "guard-start", token: randomUUID() }), { mode: 0o600 });
  const completion = release();
  await guardProbed;
  assert.equal((await fs.lstat(lockPath)).isFile(), true);
  await fs.unlink(guardPath);
  await completion;
  await assert.rejects(() => fs.lstat(lockPath), error => error.code === "ENOENT");
  const next = await acquireLocalIntegrationLifecycleLock(options);
  await next();
});

test("failed atomic release recovers only its exact inactive claim in the same process", async t => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "relmio-release-self-recovery-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const lockPath = join(root, "operation.lock");
  const guardPath = `${lockPath}.publication-lock`;
  const guardPid = process.pid + 17;
  const options = { fileSystem: fs, lockPath, atomicPublication: true, releaseWaitMs: 10,
    lockDownPath: async () => {}, getPidNamespaceIdentity: async () => "namespace:shared",
    getProcessIdentity: async pid => ({ state: "active", startIdentity: pid === guardPid ? "guard-start" : "owner-start" }) };
  const release = await acquireLocalIntegrationLifecycleLock(options);
  const owner = JSON.parse(await readFile(lockPath, "utf8"));
  await writeFile(guardPath, JSON.stringify({ ...owner, pid: guardPid,
    processStartIdentity: "guard-start", token: randomUUID() }), { mode: 0o600 });
  await assert.rejects(() => release(), error => error.code === "RELMIO_LOCK_BUSY");
  assert.equal(JSON.parse(await readFile(lockPath, "utf8")).token, owner.token);
  await fs.unlink(guardPath);
  const next = await acquireLocalIntegrationLifecycleLock(options);
  const successor = await readFile(lockPath, "utf8");
  assert.notEqual(JSON.parse(successor).token, owner.token);
  await release();
  assert.equal(await readFile(lockPath, "utf8"), successor);
  await next();
});

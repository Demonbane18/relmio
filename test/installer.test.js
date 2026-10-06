import assert from "node:assert/strict";
import { createHash, randomUUID } from "node:crypto";
import { mkdtemp, rm, mkdir, writeFile, readFile, link, symlink, lstat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import test from "node:test";
import { promisify } from "node:util";
import { execFile } from "node:child_process";

import {
  INSTALL_ROOT, PRECHECK_COMMAND, SIDECAR_MANAGED_CONTEXT_GUARD,
  SIWC_STAGING_PATH, SIWC_MIGRATION_PENDING_PATH, SIWC_MIGRATED_PATH,
  createVerificationCommands,
} from "../src/domain/safety.js";
import {
  changeVpsCodexImages, getVpsCodexImagesStatus,
  getVpsSiwcInstallationStatus, installSidecar,
  inspectStoppedVpsSiwcInstallation, manageVpsSiwcInstallation,
  reviewVpsSiwcReplacement, reviewVpsLegacyMigration, reviewVpsSiwcTarget,
  reviewVpsSiwcResume, reconcileVpsSiwcHandoff,
  reviewVpsSiwcRuntimeUpdate, updateVpsSiwcRuntime,
} from "../src/services/installer.js";
import { collectSiwcRuntimeAssets } from "../src/services/siwc-runtime-assets.js";
import { runSiwcHandoffCli } from "../src/services/siwc-handoff.mjs";
import {
  commitAuthorization, getAccessToken, listRegistrations, setPlanEnabled, readRegistration,
} from "../src/services/siwc-session.mjs";

const registrationId = "registration_test_vps";
const runtimeId = "vps_n8n";
const backgroundConsent = {
  acceptedAt: "2026-10-04T00:00:00.000Z",
  noticeVersion: "siwc-vps-2026-10-04",
};

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "relmio-vps-siwc-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const registration = { storageRoot: join(root, "source"), registrationId };
  const destinationRoot = join(root, "destination");
  const identity = { issuer: "https://auth.openai.com", subject: randomUUID(), email: "same@example.test" };
  const tokens = {
    access_token: "fake-access-value", refresh_token: "fake-refresh-value",
    token_type: "Bearer", expires_in: 3600,
    scope: "openid profile offline_access resource.invoke chatgpt.tokens.use.direct",
  };
  const connected = await commitAuthorization({
    ...registration, clientId: "oaiapp_vps_fixture", identity, tokens, runtimeId: "wizard",
  });
  const enabled = await setPlanEnabled(registration, {
    enabled: true, expectedGeneration: connected.generation,
  });
  const authBinding = {
    registrationId, clientId: "oaiapp_vps_fixture", generation: enabled.generation,
    ownerHostId: enabled.ownerHostId, ownerRuntimeId: enabled.ownerRuntimeId,
  };
  return { registration, destinationRoot, authBinding };
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
  throw new Error("Unexpected provider request in VPS fixture.");
};

function effectiveService(selected, verifier = "a".repeat(64)) {
  return {
    image: "n8n-openai-oauth:local",
    environment: { N8N_OPENAI_OAUTH_HOME: "/home/node/.relmio-siwc",
      RELMIO_REGISTRATION_ID: selected, RELMIO_RUNTIME_ID: runtimeId,
      RELMIO_GATEWAY_TOKEN_SHA256: verifier },
    build: { context: INSTALL_ROOT, dockerfile: "Dockerfile" },
    volumes: [{ type: "bind", source: `${INSTALL_ROOT}/siwc`, target: "/home/node/.relmio-siwc" }],
    restart: "unless-stopped", init: true, read_only: true,
    cap_drop: ["ALL"], security_opt: ["no-new-privileges:true"],
    pids_limit: 128, mem_limit: 536870912, cpus: 1,
    tmpfs: ["/tmp:size=16m,mode=1777", "/home/node/.local:uid=1000,gid=1000,mode=0700"],
    networks: { "n8n-shared": { aliases: ["n8n-openai-oauth"] } }, expose: ["10531"],
    labels: { "io.n8n-openai-oauth.managed": "true" },
    healthcheck: {
      test: ["CMD", "node", "-e",
        'fetch("http://127.0.0.1:10531/health").then((response) => process.exit(response.ok ? 0 : 1)).catch(() => process.exit(1))'],
      interval: "30s", timeout: "5s", retries: 3, start_period: "20s",
    },
  };
}

function fakeRemote({ destinationRoot, rejectAccept = false, managed = false, legacy = false,
  catalogFailed = false, failStart = false, publishedHostPort = false } = {}) {
  const verification = createVerificationCommands();
  const commands = [], uploads = [], files = new Map(), archives = new Map();
  const faults = { rejectAccept, catalogFailed, failStart, publishedHostPort };
  const identity = {
    host: "192.0.2.10", port: 22, fingerprint: "SHA256:fake-host-fingerprint",
    username: "root", authentication: "agent", privilege: "root", loginUid: 0, effectiveUid: 0,
  };
  let active = legacy, containerExists = legacy;
  let selected = registrationId, verifier = "a".repeat(64), newCompose = !legacy;
  let containerService = effectiveService(selected, verifier);
  let migrationState = legacy ? "legacy" : null;
  let locked = false, buildState = false, recoveryClaim = false;
  let delayedHandoff;
  // A build tags a new image; `up -d` recreates the container only when the tag moved.
  let builds = 0, recreations = 0;
  let taggedImage = `sha256:${"7".repeat(64)}`, containerImage = taggedImage, containerId = "c".repeat(64);
  if (legacy) {
    files.set(`${INSTALL_ROOT}/Dockerfile`, Buffer.from("legacy image"));
    files.set(`${INSTALL_ROOT}/docker-compose.yml`, Buffer.from("legacy compose"));
    files.set(`${INSTALL_ROOT}/.managed-by-n8n-openai-oauth`, Buffer.from("Managed by n8n-openai-oauth-setup.\n"));
  }
  const cli = async (command, contents) => {
    let stdout = "";
    await runSiwcHandoffCli({
      command, storageRoot: destinationRoot, runtimeId, registrationId: selected,
      input: Readable.from(contents ? [Buffer.from(contents)] : []),
      output: { write(value) { stdout += value; } },
      sessionDeps: { fetchImpl: fakeRevocationProvider },
    });
    return { code: 0, stdout };
  };
  const hashes = map => [...map].map(([path, contents]) =>
    `${createHash("sha256").update(contents).digest("hex")}  ${path}\n`).join("");
  const remote = {
    identity, commands, uploads, files, faults,
    async completeDelayedAcceptance() {
      if (!delayedHandoff) throw new Error("No delayed fixture acceptance exists.");
      const contents = delayedHandoff;
      delayedHandoff = undefined;
      const result = await cli("accept", contents);
      faults.activeOneOff = false;
      return result;
    },
    async upload() { throw new Error("Truncating upload is forbidden for SIWC."); },
    async publishManagedFile(path, contents, mode) {
      if (faults.guard) {
        const checked = await faults.guard();
        if (checked.code !== 0) throw new Error("Unsafe managed target.");
      }
      if (faults.failJournalStage && path === SIWC_STAGING_PATH &&
          JSON.parse(String(contents)).stage === faults.failJournalStage) {
        throw new Error("Journal publication failed.");
      }
      if (faults.failMigratedMarker && path === SIWC_MIGRATED_PATH) throw new Error("Marker publication failed.");
      if (faults.failUpload === path) {
        faults.failUpload = null;
        throw new Error("Confirmed publication failure.");
      }
      uploads.push({ path, contents, mode });
      files.set(path, Buffer.from(contents));
      if (path.endsWith("/.managed-by-n8n-openai-oauth")) managed = true;
      if (path === SIWC_MIGRATION_PENDING_PATH) migrationState = "partial";
      if (path === SIWC_MIGRATED_PATH) migrationState = "managed";
      if (path.endsWith("/docker-compose.yml")) {
        selected = String(contents).match(/RELMIO_REGISTRATION_ID: "([A-Za-z0-9_-]+)"/u)?.[1] ?? selected;
        verifier = String(contents).match(/RELMIO_GATEWAY_TOKEN_SHA256: "([a-f0-9]+)"/u)?.[1] ?? verifier;
        newCompose = true;
      }
      if (faults.loseUploadAck === path) {
        faults.loseUploadAck = null;
        throw Object.assign(new Error("Publication acknowledgment lost."), { remoteOutcomeUnknown: true });
      }
    },
    async exec(command, { input, timeoutMs } = {}) {
      commands.push({ command, input, timeoutMs });
      if (command === SIDECAR_MANAGED_CONTEXT_GUARD && faults.guard) return faults.guard();
      if (command === "docker network inspect --format '{{json .}}' proxy") return {
        code: 0, stdout: JSON.stringify({ Id: faults.networkId ?? "d".repeat(64), Name: "proxy" }),
      };
      if (command === "docker inspect --format '{{json .}}' n8n") return {
        code: 0, stdout: JSON.stringify({ Id: faults.n8nContainerId ?? "e".repeat(64), Name: "/n8n",
          State: { Running: true }, NetworkSettings: { Networks: {
            proxy: { NetworkID: faults.networkId ?? "d".repeat(64) },
          } } }),
      };
      if (command === PRECHECK_COMMAND) return {
        code: legacy && migrationState !== "managed" ? 42 : 0,
        stdout: managed || legacy ? "managed" : "new",
      };
      if (command === verification.sharedRoot) return {
        code: 0, stdout: files.has(`${INSTALL_ROOT}/.managed-by-relmio-root`) ? "managed" : "absent",
      };
      if (command === verification.staging) return { code: 0, stdout: files.get(SIWC_STAGING_PATH)?.toString() ?? "null" };
      if (command === verification.stagedFiles) return {
        code: 0, stdout: hashes(new Map([...files].filter(([path]) =>
          ![SIWC_STAGING_PATH, SIWC_MIGRATION_PENDING_PATH, SIWC_MIGRATED_PATH,
            `${INSTALL_ROOT}/.managed-by-relmio-root`].includes(path)))),
      };
      if (command === verification.legacyArchiveFiles) return {
        code: 0, stdout: archives.size ? hashes(archives) : "absent",
      };
      if (command === verification.archiveLegacy) {
        for (const [path, contents] of files) {
          if (["Dockerfile", "docker-compose.yml", ".managed-by-n8n-openai-oauth"].includes(path.split("/").at(-1))) {
            archives.set(path.replace(`${INSTALL_ROOT}/`, `${INSTALL_ROOT}/legacy/`), Buffer.from(contents));
          }
        }
        return { code: 0, stdout: "" };
      }
      if (command === verification.host) return cli("host");
      if (command === verification.accept) {
        if (faults.delayAccept) {
          delayedHandoff = input;
          faults.activeOneOff = true;
          throw Object.assign(new Error("Acceptance channel deadline elapsed."),
            { remoteOutcomeUnknown: true, timedOut: true });
        }
        if (faults.silentAccept) {
          throw Object.assign(new Error("Command deadline elapsed."), { remoteOutcomeUnknown: true, timedOut: true });
        }
        if (faults.rejectAccept) throw Object.assign(new Error("SSH channel lost"), { remoteOutcomeUnknown: true });
        const accepted = await cli("accept", input);
        if (faults.loseAcceptAck) throw Object.assign(new Error("Receipt acknowledgment lost."), { remoteOutcomeUnknown: true });
        return accepted;
      }
      if (command === verification.receipt) {
        if (faults.silentReceipt) throw Object.assign(new Error("Receipt deadline elapsed."),
          { remoteOutcomeUnknown: true, timedOut: true });
        return cli("receipt", input);
      }
      if (command === verification.oneOffContainers) return {
        code: 0, stdout: faults.activeOneOff ? "a".repeat(64) : "",
      };
      if (command === verification.account || command === verification.accountLive) return cli("account");
      if (command.includes("/app/services/codex-images.mjs ")) {
        return faults.images?.(command) ?? { code: 0, stdout: JSON.stringify({ state: "off" }) };
      }
      if (command === verification.signOut) return cli("sign-out", input);
      if (command === verification.disablePlan) return cli("disable-plan", input);
      if (command === verification.enablePlan) return cli("enable-plan", input);
      if (command === verification.runningService) return { code: 0, stdout: active ? "openai-oauth\n" : "" };
      if (command === verification.publicationState) return faults.publicationFailure ?? {
        code: 0, stdout: JSON.stringify({ Publishers: faults.publishedHostPort
          ? [{ PublishedPort: 10531, URL: "0.0.0.0" }] : [] }),
      };
      if (command === verification.models) return faults.catalogFailed
        ? { code: 1, stdout: JSON.stringify({
            status: 503, error: { code: "subscription_sharing_usage_unavailable" },
            recovery: "retry-later", requestId: "req-test",
          }) } : { code: 0, stdout: JSON.stringify({ data: [{ id: "account-model" }] }) };
      if (command === verification.stop) {
        if (faults.unknownStop) throw Object.assign(new Error("Stop outcome lost."), { remoteOutcomeUnknown: true });
        active = false;
        if (faults.loseStopAck) throw Object.assign(new Error("Stop acknowledgment lost."), { remoteOutcomeUnknown: true });
        return { code: 0, stdout: "" };
      }
      if (command === verification.legacyStatus) return { code: 0, stdout: migrationState ?? (managed ? "managed" : "absent") };
      if (command === verification.ownerPresence) return { code: 0, stdout: containerExists ? containerId : "" };
      if (command === verification.ownerImage) return { code: 0, stdout: JSON.stringify({
        Id: faults.imageId ?? taggedImage, Config: { User: "node", WorkingDir: "/app",
          Entrypoint: ["node", "/app/gateway/openai-oauth-sidecar.mjs"], Cmd: null },
      }) };
      if (command === verification.ownerContainer) return {
        code: containerExists ? 0 : 1,
        stdout: JSON.stringify({
          Id: faults.ownerContainerId ?? containerId, Name: "/n8n-openai-oauth-openai-oauth-1",
          Image: faults.containerImageId ?? containerImage, State: { Running: active, Paused: false },
          Config: { Image: "n8n-openai-oauth:local", User: "node", WorkingDir: "/app",
            Entrypoint: ["node", "/app/gateway/openai-oauth-sidecar.mjs"], Cmd: null,
            Env: Object.entries(containerService.environment).map(([key, value]) => `${key}=${value}`),
            Labels: { "com.docker.compose.project": "n8n-openai-oauth",
              "com.docker.compose.service": "openai-oauth", "io.n8n-openai-oauth.managed": "true" } },
          HostConfig: { Privileged: false, ReadonlyRootfs: true, Init: true,
            CapDrop: ["ALL"], CapAdd: null, SecurityOpt: ["no-new-privileges:true"],
            RestartPolicy: { Name: "unless-stopped" }, PidsLimit: 128, Memory: 536870912,
            NanoCpus: 1000000000, Tmpfs: { "/tmp": "size=16m,mode=1777",
              "/home/node/.local": "uid=1000,gid=1000,mode=0700" },
            PortBindings: {}, Devices: [], Binds: [], PidMode: "", IpcMode: "private",
            ...faults.hostConfig },
          Mounts: [{ Type: "bind", RW: true, Source: legacy && containerExists && !active && migrationState === "partial"
              ? `${INSTALL_ROOT}/auth` : newCompose ? `${INSTALL_ROOT}/siwc` : `${INSTALL_ROOT}/auth`,
            Destination: legacy && containerExists && !active && migrationState === "partial"
              ? "/home/node/.codex" : newCompose ? "/home/node/.relmio-siwc" : "/home/node/.codex" }],
          NetworkSettings: { Networks: { proxy: { NetworkID: "d".repeat(64) } }, Ports: { "10531/tcp": null } },
        }),
      };
      if (command === verification.managementConfig) return { code: 0, stdout: JSON.stringify({
        services: { "openai-oauth": newCompose
          ? { ...effectiveService(selected, verifier), ...faults.service }
          : { environment: {}, build: { context: INSTALL_ROOT },
            volumes: [{ source: `${INSTALL_ROOT}/auth`, target: "/home/node/.codex" }] } },
        networks: { "n8n-shared": { name: "proxy", external: true } },
      }) };
      if (command === verification.legacyCredential) return { code: 0, stdout: "12:34:1000:600:512:1760000000\n" };
      if (command.includes("printf none")) return { code: buildState ? 73 : 0, stdout: locked ? "1:1" : "none" };
      if (command.includes("mkdir /docker/n8n-openai-oauth/.openai-oauth-operation.lock/recovery")) {
        if (!locked || recoveryClaim) return { code: 1, stdout: "" };
        recoveryClaim = true; return { code: 0, stdout: "1:2" };
      }
      if (command.includes("mkdir /docker/n8n-openai-oauth/.openai-oauth-operation.lock/buildx")) {
        buildState = true; return { code: 0, stdout: "1:3" };
      }
      if (command.includes("&& mkdir /docker/n8n-openai-oauth/.openai-oauth-operation.lock &&")) {
        if (locked) return { code: 1, stdout: "" };
        locked = true; return { code: 0, stdout: "1:1" };
      }
      if (command.includes("\nstate=")) { buildState = false; return { code: 0, stdout: "" }; }
      if (command.endsWith("rmdir /docker/n8n-openai-oauth/.openai-oauth-operation.lock/recovery")) {
        recoveryClaim = false; return { code: 0, stdout: "" };
      }
      if (command.endsWith("rmdir /docker/n8n-openai-oauth/.openai-oauth-operation.lock")) {
        if (faults.failRelease) return { code: 1, stdout: "" };
        locked = false; return { code: 0, stdout: "" };
      }
      if (command.includes("DOCKER_BUILDKIT=1")) {
        if (faults.buildTimeout) throw Object.assign(new Error("Build deadline elapsed."), { timedOut: true, remoteOutcomeUnknown: true });
        if (faults.buildFailed) return { code: 1, stdout: "" };
        taggedImage = `sha256:${String(++builds).padStart(64, "8")}`;
      }
      if (command.includes(" up -d ")) {
        if (faults.failStart) return { code: 1, stdout: "" };
        if (!containerExists || containerImage !== taggedImage) {
          containerId = String(++recreations).padStart(64, "b");
          containerImage = taggedImage;
        }
        active = true; containerExists = true; legacy = false;
        containerService = effectiveService(selected, verifier);
      }
      return { code: 0, stdout: "" };
    },
  };
  return { remote, reviewedTarget: { ...identity, networkName: "proxy", containerName: "n8n",
    n8nContainerId: "e".repeat(64), networkId: "d".repeat(64) } };
}

test("reviewed VPS transfer freezes source, attests destination and never puts credentials in build context", async t => {
  const { registration, destinationRoot, authBinding } = await fixture(t);
  const { remote, reviewedTarget } = fakeRemote({ destinationRoot });
  const result = await installSidecar({
    remote, networkName: "proxy", registration, authBinding,
    reviewedTarget, backgroundConsent, confirmed: true,
  });
  assert.equal(result.account.registrationId, registrationId);
  assert.equal(result.account.ownership, "owned");
  assert.equal(result.account.ownerRuntimeId, runtimeId);
  assert.equal(result.models[0], "account-model");
  assert.equal(result.credentialShownOnce, true);
  assert.equal(typeof result.clientCredential, "string");
  const source = (await listRegistrations({ storageRoot: registration.storageRoot }))[0];
  assert.equal(source.ownership, "transferred");
  await assert.rejects(() => getAccessToken(registration, { runtimeId: "wizard" }));
  assert.equal(remote.uploads.some(item => item.path.endsWith("auth.json")), false);
  assert.equal(remote.uploads.some(item => Buffer.from(item.contents).includes(Buffer.from("fake-refresh-value"))), false);
  assert.equal(remote.commands.some(item => item.command.includes("docker stop n8n")), false);
  assert.equal(remote.commands.some(item => item.command.includes("10531:10531")), false);
  const transfer = remote.commands.find(item => item.command === createVerificationCommands().accept);
  assert.ok(transfer.input.includes("fake-refresh-value"));
  assert.equal(transfer.command.includes("fake-refresh-value"), false);
});

test("wrong selected account or SSH target fails before remote writes", async t => {
  const { registration, destinationRoot, authBinding } = await fixture(t);
  const { remote, reviewedTarget } = fakeRemote({ destinationRoot });
  for (const invalid of [
    { authBinding: { ...authBinding, generation: randomUUID() } },
    { authBinding: { ...authBinding, clientId: "oaiapp_wrong" } },
    { registration: { ...registration, registrationId: "registration_wrong" } },
    { reviewedTarget: { ...reviewedTarget, fingerprint: "SHA256:wrong" } },
  ]) await assert.rejects(() => installSidecar({
    remote, networkName: "proxy", registration, authBinding,
    reviewedTarget, backgroundConsent, confirmed: true, ...invalid,
  }));
  assert.equal(remote.uploads.length, 0);
  assert.equal(remote.commands.length, 0);
});

test("unknown SSH acceptance leaves source frozen and forbids a second export", async t => {
  const { registration, destinationRoot, authBinding } = await fixture(t);
  const { remote, reviewedTarget } = fakeRemote({ destinationRoot, rejectAccept: true });
  await assert.rejects(() => installSidecar({
    remote, networkName: "proxy", registration, authBinding,
    reviewedTarget, backgroundConsent, confirmed: true,
  }), /unresolved/i);
  const [source] = await listRegistrations({ storageRoot: registration.storageRoot });
  assert.equal(source.ownership, "handoff-pending");
  await assert.rejects(() => getAccessToken(registration, { runtimeId: "wizard" }));
  await assert.rejects(() => installSidecar({
    remote, networkName: "proxy", registration, authBinding,
    reviewedTarget, backgroundConsent, confirmed: true,
  }));
});

test("installed owner status and confirmed sign-out operate on destination after stopping only its service", async t => {
  const { registration, destinationRoot, authBinding } = await fixture(t);
  const { remote, reviewedTarget } = fakeRemote({ destinationRoot });
  await installSidecar({ remote, networkName: "proxy", registration, authBinding,
    reviewedTarget, backgroundConsent, confirmed: true });
  const status = await getVpsSiwcInstallationStatus({ remote, networkName: "proxy", reviewedTarget });
  assert.equal(status.state, "owned");
  assert.equal(status.account.registrationId, registrationId);
  await assert.rejects(() => manageVpsSiwcInstallation({
    remote, networkName: "proxy", reviewedTarget, registrationId,
    action: "sign-out", expectedGeneration: randomUUID(), confirmed: true,
  }));
  const result = await manageVpsSiwcInstallation({
    remote, networkName: "proxy", reviewedTarget, registrationId,
    action: "disable-plan", expectedGeneration: status.account.generation, confirmed: true,
  });
  assert.equal(result.account.planEnabled, false);
  assert.equal(result.runtimeStopped, true);
  assert.equal(result.revocation, "not-applicable");
  const stopped = await getVpsSiwcInstallationStatus({ remote, networkName: "proxy", reviewedTarget });
  assert.equal(stopped.state, "stopped");
  const inspected = await inspectStoppedVpsSiwcInstallation({
    remote, networkName: "proxy", reviewedTarget, registrationId, confirmed: true,
  });
  assert.equal(inspected.account.registrationId, registrationId);
  await assert.rejects(() => manageVpsSiwcInstallation({
    remote, networkName: "proxy", reviewedTarget, registrationId,
    action: "enable-plan", expectedGeneration: inspected.account.generation,
    confirmed: true,
  }), /consent/i);
  const enabled = await manageVpsSiwcInstallation({
    remote, networkName: "proxy", reviewedTarget, registrationId,
    action: "enable-plan", expectedGeneration: inspected.account.generation,
    backgroundConsent: true, confirmed: true,
  });
  assert.equal(enabled.account.planEnabled, true);
  assert.equal(enabled.runtimeStopped, false);
});

test("VPS consent rejects an unknown or local notice before any SSH command", async t => {
  const { registration, destinationRoot, authBinding } = await fixture(t);
  const { remote, reviewedTarget } = fakeRemote({ destinationRoot });
  for (const consent of [
    { ...backgroundConsent, noticeVersion: "siwc-local-2026-10-04" },
    { ...backgroundConsent, noticeVersion: "unknown-notice" },
    { ...backgroundConsent, acceptedAt: "tomorrow" },
  ]) {
    await assert.rejects(() => installSidecar({
      remote, networkName: "proxy", registration, authBinding,
      reviewedTarget, backgroundConsent: consent, confirmed: true,
    }));
  }
  assert.equal(remote.commands.length, 0);
  assert.equal(remote.uploads.length, 0);
});

test("reviewed VPS account replacement preserves host identity and signed-out mapping", async t => {
  const { registration, destinationRoot, authBinding } = await fixture(t);
  const { remote, reviewedTarget } = fakeRemote({ destinationRoot });
  await installSidecar({
    remote, networkName: "proxy", registration, authBinding,
    reviewedTarget, backgroundConsent, confirmed: true,
  });
  const oldStatus = await getVpsSiwcInstallationStatus({
    remote, networkName: "proxy", reviewedTarget,
  });
  const signedOut = await manageVpsSiwcInstallation({
    remote, networkName: "proxy", reviewedTarget, registrationId,
    action: "sign-out", expectedGeneration: oldStatus.account.generation,
    confirmed: true,
  });
  assert.equal(signedOut.account.session, "signed-out");
  const reviewed = await reviewVpsSiwcReplacement({
    remote, networkName: "proxy", reviewedTarget,
  });
  const existingBinding = {
    ...reviewed,
    ownerHostId: signedOut.account.ownerHostId,
    expectedGeneration: signedOut.account.generation,
  };
  const fresh = { storageRoot: registration.storageRoot, registrationId: "registration_vps_next" };
  const connected = await commitAuthorization({
    ...fresh, clientId: "oaiapp_vps_next", runtimeId: "wizard",
    identity: { issuer: "https://auth.openai.com", subject: randomUUID() },
    tokens: {
      access_token: "second-fake-access", refresh_token: "second-fake-refresh",
      token_type: "Bearer", expires_in: 3600,
      scope: "openid profile offline_access resource.invoke chatgpt.tokens.use.direct",
    },
  });
  const enabled = await setPlanEnabled(fresh, {
    enabled: true, expectedGeneration: connected.generation,
  });
  const nextBinding = {
    registrationId: fresh.registrationId, clientId: "oaiapp_vps_next",
    generation: enabled.generation,
    ownerHostId: enabled.ownerHostId, ownerRuntimeId: enabled.ownerRuntimeId,
  };
  await assert.rejects(() => installSidecar({
    remote, networkName: "proxy", registration: fresh, authBinding: nextBinding,
    reviewedTarget, backgroundConsent, confirmed: true,
    replacementConsent: false, existingBinding,
  }));
  const installed = await installSidecar({
    remote, networkName: "proxy", registration: fresh, authBinding: nextBinding,
    reviewedTarget, backgroundConsent, confirmed: true,
    replacementConsent: true, existingBinding,
  });
  assert.equal(installed.deploymentMode, "replaced");
  assert.equal(installed.account.registrationId, fresh.registrationId);
  assert.equal(installed.account.ownerHostId, signedOut.account.ownerHostId);
  const destinationAccounts = await listRegistrations({ storageRoot: destinationRoot });
  assert.equal(destinationAccounts.find(account => account.registrationId === registrationId).session, "signed-out");
  assert.equal(destinationAccounts.find(account => account.registrationId === fresh.registrationId).ownership, "owned");
  assert.equal(remote.uploads.some(item => item.path.endsWith("auth.json")), false);
});

test("reviewed self-hosted VM migration preserves old credential file offline and transfers only fresh SIWC", async t => {
  const { registration, destinationRoot, authBinding } = await fixture(t);
  const { remote, reviewedTarget } = fakeRemote({ destinationRoot, legacy: true });
  const legacyBinding = await reviewVpsLegacyMigration({
    remote, networkName: "proxy", reviewedTarget,
  });
  assert.equal(legacyBinding.authIdentity, "12:34:1000:600:512:1760000000");
  assert.equal(legacyBinding.running, true);
  const installed = await installSidecar({
    remote, networkName: "proxy", registration, authBinding, reviewedTarget,
    backgroundConsent, confirmed: true, migrationConsent: true, legacyBinding,
  });
  assert.equal(installed.deploymentMode, "migrated");
  assert.equal(installed.migratedLegacy, true);
  assert.equal(installed.legacyRetained, true);
  assert.equal(installed.account.ownerRuntimeId, runtimeId);
  assert.equal((await getVpsSiwcInstallationStatus({
    remote, networkName: "proxy", reviewedTarget,
  })).state, "owned");
  const commands = remote.commands.map(entry => entry.command);
  const verification = createVerificationCommands();
  assert.ok(commands.indexOf(verification.archiveLegacy) < commands.indexOf(verification.stop));
  assert.ok(commands.indexOf(verification.stop) < commands.indexOf(verification.accept));
  assert.ok(remote.uploads.some(item => item.path === SIWC_MIGRATED_PATH));
  assert.equal(remote.uploads.some(item => item.path.endsWith("/auth/auth.json")), false);
  assert.equal(commands.some(command => /docker (?:restart|stop) n8n\b/u.test(command)), false);
});

test("unknown VM legacy transfer retains pending marker and frozen sender without reviving old bridge", async t => {
  const { registration, destinationRoot, authBinding } = await fixture(t);
  const { remote, reviewedTarget } = fakeRemote({ destinationRoot, legacy: true, rejectAccept: true });
  const legacyBinding = await reviewVpsLegacyMigration({
    remote, networkName: "proxy", reviewedTarget,
  });
  await assert.rejects(() => installSidecar({
    remote, networkName: "proxy", registration, authBinding, reviewedTarget,
    backgroundConsent, confirmed: true, migrationConsent: true, legacyBinding,
  }), /unresolved/i);
  assert.equal((await listRegistrations({ storageRoot: registration.storageRoot }))[0].ownership, "handoff-pending");
  assert.equal((await getVpsSiwcInstallationStatus({
    remote, networkName: "proxy", reviewedTarget,
  })).state, "staged");
  assert.equal(remote.uploads.some(item => item.path === SIWC_MIGRATED_PATH), false);
});

test("provider catalog failure after transfer returns the one-time local bearer with explicit unverified state", async t => {
  const { registration, destinationRoot, authBinding } = await fixture(t);
  const { remote, reviewedTarget } = fakeRemote({ destinationRoot, catalogFailed: true });
  const installed = await installSidecar({
    remote, networkName: "proxy", registration, authBinding,
    reviewedTarget, backgroundConsent, confirmed: true,
  });
  assert.equal(installed.account.ownership, "owned");
  assert.equal(installed.credentialShownOnce, true);
  assert.equal(installed.readiness, "unverified");
  assert.deepEqual(installed.models, []);
  assert.equal(installed.catalogFailure.code, "subscription_sharing_usage_unavailable");
  assert.equal(installed.catalogFailure.status, 503);
  assert.equal(installed.catalogFailure.requestId, "req-test");
  assert.equal((await listRegistrations({ storageRoot: registration.storageRoot }))[0].ownership, "transferred");
});

test("legacy VM migration requires separate confirmation and exact old image binding before writes", async t => {
  const { registration, destinationRoot, authBinding } = await fixture(t);
  const { remote, reviewedTarget } = fakeRemote({ destinationRoot, legacy: true });
  const reviewed = await reviewVpsLegacyMigration({
    remote, networkName: "proxy", reviewedTarget,
  });
  const before = remote.commands.length;
  await assert.rejects(() => installSidecar({
    remote, networkName: "proxy", registration, authBinding, reviewedTarget,
    backgroundConsent, confirmed: true, migrationConsent: false,
    legacyBinding: reviewed,
  }));
  assert.equal(remote.commands.length, before);
  await assert.rejects(() => installSidecar({
    remote, networkName: "proxy", registration, authBinding, reviewedTarget,
    backgroundConsent, confirmed: true, migrationConsent: true,
    legacyBinding: { ...reviewed, imageId: `sha256:${"9".repeat(64)}` },
  }), /changed/i);
  assert.equal(remote.uploads.length, 0);
  assert.equal(remote.commands.some(entry => entry.command === createVerificationCommands().stop), false);
});

test("VPS install refuses missing final confirmation before SSH mutation", async t => {
  const { registration, destinationRoot, authBinding } = await fixture(t);
  const { remote, reviewedTarget } = fakeRemote({ destinationRoot });
  await assert.rejects(() => installSidecar({
    remote, networkName: "proxy", registration, authBinding,
    reviewedTarget, backgroundConsent, confirmed: false,
  }));
  assert.equal(remote.commands.length, 0);
  assert.equal(remote.uploads.length, 0);
});

test("VM start failure after receipt preserves one-time key and pending migration state", async t => {
  const { registration, destinationRoot, authBinding } = await fixture(t);
  const { remote, reviewedTarget } = fakeRemote({ destinationRoot, legacy: true, failStart: true });
  const legacyBinding = await reviewVpsLegacyMigration({
    remote, networkName: "proxy", reviewedTarget,
  });
  const installed = await installSidecar({
    remote, networkName: "proxy", registration, authBinding, reviewedTarget,
    backgroundConsent, confirmed: true, migrationConsent: true, legacyBinding,
  });
  assert.equal(installed.deploymentMode, "partial");
  assert.equal(installed.migrationPending, true);
  assert.equal(installed.runtimeState, "stopped");
  assert.equal(installed.hostPublication, "none");
  assert.equal(installed.readiness, "unverified");
  assert.equal(installed.runtimeFailure.recovery, "resolve-handoff");
  assert.equal(installed.account.ownership, "owned");
  assert.equal(typeof installed.clientCredential, "string");
  assert.equal((await getVpsSiwcInstallationStatus({
    remote, networkName: "proxy", reviewedTarget,
  })).state, "staged");
});

test("unexpected VPS host publication stops only owned sidecar and warns without losing one-time key", async t => {
  const { registration, destinationRoot, authBinding } = await fixture(t);
  const { remote, reviewedTarget } = fakeRemote({ destinationRoot, publishedHostPort: true });
  const result = await installSidecar({
    remote, networkName: "proxy", registration, authBinding,
    reviewedTarget, backgroundConsent, confirmed: true,
  });
  assert.equal(result.deploymentMode, "partial");
  assert.equal(result.readiness, "unverified");
  assert.equal(result.runtimeState, "stopped");
  assert.equal(result.hostPublication, "none");
  assert.match(result.runtimeFailure.error, /host port/i);
  assert.equal(typeof result.clientCredential, "string");
  assert.equal(remote.commands.some(entry => entry.command === createVerificationCommands().stop), true);
  assert.equal(remote.commands.some(entry => /docker (?:stop|restart) n8n\b/u.test(entry.command)), false);
});

async function freshRegistration(storageRoot, id) {
  const registration = { storageRoot, registrationId: id };
  const connected = await commitAuthorization({ ...registration,
    clientId: `oaiapp_${id}`, runtimeId: "wizard",
    identity: { issuer: "https://auth.openai.com", subject: randomUUID() },
    tokens: { access_token: "new-fake-access", refresh_token: "new-fake-refresh",
      token_type: "Bearer", expires_in: 3600,
      scope: "openid profile offline_access resource.invoke chatgpt.tokens.use.direct" },
  });
  const enabled = await setPlanEnabled(registration, { enabled: true, expectedGeneration: connected.generation });
  return { registration, authBinding: {
    registrationId: id, clientId: `oaiapp_${id}`, generation: enabled.generation,
    ownerHostId: enabled.ownerHostId, ownerRuntimeId: enabled.ownerRuntimeId,
  } };
}

test("reused n8n names with changed immutable IDs reject before deployment effects", async t => {
  for (const field of ["networkId", "n8nContainerId"]) {
    await t.test(field, async t => {
      const { registration, destinationRoot, authBinding } = await fixture(t);
      const { remote, reviewedTarget } = fakeRemote({ destinationRoot, legacy: true });
      const legacyBinding = await reviewVpsLegacyMigration({ remote, networkName: "proxy", reviewedTarget });
      remote.faults[field] = "f".repeat(64);
      const before = remote.commands.length;
      await assert.rejects(() => installSidecar({
        remote, networkName: "proxy", registration, authBinding, reviewedTarget,
        backgroundConsent, confirmed: true, migrationConsent: true, legacyBinding,
      }));
      assert.equal(remote.uploads.length, 0);
      assert.equal(remote.commands.slice(before).some(item => item.command.includes(" stop ") ||
        item.command.includes("DOCKER_BUILDKIT") || item.command === createVerificationCommands().accept), false);
    });
  }
});

test("destination IDs changed after build reject before freezing or exporting source", async t => {
  const { registration, destinationRoot, authBinding } = await fixture(t);
  const { remote, reviewedTarget } = fakeRemote({ destinationRoot });
  const exec = remote.exec.bind(remote);
  remote.exec = async (command, options) => {
    const result = await exec(command, options);
    if (command.includes("DOCKER_BUILDKIT=1")) remote.faults.networkId = "f".repeat(64);
    return result;
  };
  await assert.rejects(() => installSidecar({ remote, networkName: "proxy", registration,
    authBinding, reviewedTarget, backgroundConsent, confirmed: true }));
  assert.equal((await readRegistration(registration)).handoff.state, "owned");
  assert.equal(remote.commands.filter(item => item.command === createVerificationCommands().accept).length, 0);
});

test("lost accepted receipt reconciles after destination refresh and reviewed n8n recreation without another export", async t => {
  const { registration, destinationRoot, authBinding } = await fixture(t);
  const { remote, reviewedTarget: originalTarget } = fakeRemote({ destinationRoot });
  let reviewedTarget = originalTarget;
  remote.faults.loseAcceptAck = true;
  await assert.rejects(() => installSidecar({ remote, networkName: "proxy", registration,
    authBinding, reviewedTarget, backgroundConsent, confirmed: true }), error => error.remoteOutcomeUnknown);
  const destination = await readRegistration({ storageRoot: destinationRoot, registrationId });
  await getAccessToken({ storageRoot: destinationRoot, registrationId }, {
    runtimeId, minValidityMs: 60_000,
  }, { now: () => destination.session.expiresAt - 30_000,
    fetchImpl: async url => url.endsWith("/api/accounts/oauth/token")
    ? Response.json({ access_token: "rotated-fake-access", refresh_token: "rotated-fake-refresh",
        token_type: "Bearer", expires_in: 3600,
        scope: "openid profile offline_access resource.invoke chatgpt.tokens.use.direct" })
    : fakeRevocationProvider(url) });
  remote.faults.n8nContainerId = "f".repeat(64);
  reviewedTarget = { ...remote.identity, networkName: "proxy", containerName: "n8n",
    ...await reviewVpsSiwcTarget({ remote, networkName: "proxy", containerName: "n8n" }) };
  assert.equal((await getVpsSiwcInstallationStatus({ remote, networkName: "proxy", reviewedTarget })).state, "staged");
  const recovered = await reconcileVpsSiwcHandoff({ remote, networkName: "proxy",
    reviewedTarget, registration, confirmed: true });
  assert.equal(recovered.outcome, "finished");
  assert.equal(recovered.account.ownership, "transferred");
  assert.deepEqual((await readRegistration(registration)).session, {});
  const resume = await reviewVpsSiwcResume({ remote, networkName: "proxy", reviewedTarget, registrationId });
  const source = await readRegistration(registration);
  const resumed = await installSidecar({ remote, networkName: "proxy", registration,
    authBinding: { ...authBinding, generation: source.generation }, reviewedTarget,
    backgroundConsent, resume, confirmed: true });
  assert.equal(resumed.runtimeState, "running");
  assert.equal(typeof resumed.clientCredential, "string");
  assert.equal(JSON.parse(remote.files.get(SIWC_STAGING_PATH)).reviewedTarget.n8nContainerId,
    reviewedTarget.n8nContainerId);
  assert.equal(remote.commands.filter(item => item.command === createVerificationCommands().accept).length, 1);
  assert.equal((await readRegistration({ storageRoot: destinationRoot, registrationId })).session.refreshToken,
    "rotated-fake-refresh");
});

test("unaccepted frozen handoff resumes only with independently authorized fresh registration", async t => {
  const { registration, destinationRoot, authBinding } = await fixture(t);
  const { remote, reviewedTarget } = fakeRemote({ destinationRoot, rejectAccept: true });
  await assert.rejects(() => installSidecar({ remote, networkName: "proxy", registration,
    authBinding, reviewedTarget, backgroundConsent, confirmed: true }));
  const reconciled = await reconcileVpsSiwcHandoff({ remote, networkName: "proxy",
    reviewedTarget, registration, confirmed: true });
  assert.equal(reconciled.outcome, "not-accepted");
  assert.equal(reconciled.account.ownership, "handoff-pending");
  const fresh = await freshRegistration(registration.storageRoot, "registration_fresh_recovery");
  const resume = await reviewVpsSiwcResume({ remote, networkName: "proxy", reviewedTarget,
    registrationId: fresh.registration.registrationId });
  assert.equal(resume.stagedRegistrationId, registrationId);
  remote.faults.rejectAccept = false;
  const result = await installSidecar({ remote, networkName: "proxy", ...fresh,
    reviewedTarget, backgroundConsent, resume, confirmed: true });
  assert.equal(result.account.registrationId, fresh.registration.registrationId);
  assert.equal((await readRegistration(registration)).handoff.state, "handoff-pending");
  assert.equal(remote.commands.filter(item => item.command === createVerificationCommands().accept).length, 2);
});

test("interrupted publication resumes with current generation and reviewed deployment mode without deleting data", async t => {
  for (const mode of ["fresh", "migration", "replacement"]) await t.test(mode, async t => {
    let { registration, destinationRoot, authBinding } = await fixture(t);
    const { remote, reviewedTarget } = fakeRemote({ destinationRoot, legacy: mode === "migration" });
    let consent = {};
    if (mode === "migration") consent = { migrationConsent: true,
      legacyBinding: await reviewVpsLegacyMigration({ remote, networkName: "proxy", reviewedTarget }) };
    if (mode === "replacement") {
      await installSidecar({ remote, networkName: "proxy", registration, authBinding,
        reviewedTarget, backgroundConsent, confirmed: true });
      const status = await getVpsSiwcInstallationStatus({ remote, networkName: "proxy", reviewedTarget });
      const signedOut = await manageVpsSiwcInstallation({ remote, networkName: "proxy", reviewedTarget,
        registrationId, action: "sign-out", expectedGeneration: status.account.generation, confirmed: true });
      const existing = await reviewVpsSiwcReplacement({ remote, networkName: "proxy", reviewedTarget });
      consent = { replacementConsent: true, existingBinding: { ...existing,
        ownerHostId: signedOut.account.ownerHostId, expectedGeneration: signedOut.account.generation } };
      ({ registration, authBinding } = await freshRegistration(registration.storageRoot, "registration_resume_replace"));
    }
    remote.faults.loseUploadAck = `${INSTALL_ROOT}/package.json`;
    await assert.rejects(() => installSidecar({ remote, networkName: "proxy", registration,
      authBinding, reviewedTarget, backgroundConsent, confirmed: true, ...consent }),
    error => error.remoteOutcomeUnknown);
    const beforeFiles = new Map(remote.files);
    const status = await getVpsSiwcInstallationStatus({ remote, networkName: "proxy", reviewedTarget });
    assert.equal(status.state, "staged");
    assert.equal(status.staging.registrationId, registration.registrationId);
    const oldGeneration = authBinding.generation;
    const disabled = await setPlanEnabled(registration, { enabled: false, expectedGeneration: oldGeneration });
    const enabled = await setPlanEnabled(registration, { enabled: true, expectedGeneration: disabled.generation });
    assert.notEqual(enabled.generation, oldGeneration);
    authBinding = { ...authBinding, generation: enabled.generation };
    const resume = await reviewVpsSiwcResume({ remote, networkName: "proxy", reviewedTarget,
      registrationId: registration.registrationId });
    assert.equal(resume.operationLockIdentity, "1:1");
    const deploymentMode = mode === "fresh" ? "installed" : mode === "migration" ? "migrated" : "replaced";
    assert.equal(resume.deploymentMode, deploymentMode);
    await assert.rejects(() => installSidecar({ remote, networkName: "proxy", registration,
      authBinding, reviewedTarget, backgroundConsent,
      resume: { ...resume, deploymentMode: deploymentMode === "installed" ? "migrated" : "installed" },
      confirmed: true }));
    const result = await installSidecar({ remote, networkName: "proxy", registration,
      authBinding, reviewedTarget, backgroundConsent, resume, confirmed: true });
    assert.equal(result.runtimeState, "running");
    assert.equal(result.deploymentMode, deploymentMode);
    assert.equal((await readRegistration({ storageRoot: destinationRoot,
      registrationId: registration.registrationId })).acceptedHandoff.binding.generation, enabled.generation);
    for (const path of beforeFiles.keys()) assert.ok(remote.files.has(path));
    assert.equal(remote.commands.filter(item => item.command === createVerificationCommands().accept).length,
      mode === "replacement" ? 2 : 1);
  });
});

test("post-transfer journal, migration marker and lock failures retain committed one-time key", async t => {
  for (const fault of ["journal", "marker", "lock", "migration-lock"]) await t.test(fault, async t => {
    const { registration, destinationRoot, authBinding } = await fixture(t);
    const migrating = fault === "marker" || fault === "migration-lock";
    const { remote, reviewedTarget } = fakeRemote({ destinationRoot, legacy: migrating });
    const consent = migrating ? { migrationConsent: true,
      legacyBinding: await reviewVpsLegacyMigration({ remote, networkName: "proxy", reviewedTarget }) } : {};
    if (fault === "journal") remote.faults.failJournalStage = "transferred";
    if (fault === "marker") remote.faults.failMigratedMarker = true;
    if (fault === "lock" || fault === "migration-lock") remote.faults.failRelease = true;
    const result = await installSidecar({ remote, networkName: "proxy", registration,
      authBinding, reviewedTarget, backgroundConsent, confirmed: true, ...consent });
    assert.equal(result.deploymentMode, "partial");
    assert.equal(result.credentialShownOnce, true);
    assert.equal(typeof result.clientCredential, "string");
    assert.equal(result.finalizationFailure.recovery, "resolve-handoff");
    assert.equal(result.readiness, "unverified");
    assert.deepEqual((await readRegistration(registration)).session, {});
    assert.equal(remote.files.get(`${INSTALL_ROOT}/docker-compose.yml`).includes(Buffer.from(result.clientCredential)), false);
    assert.equal(result.migratedLegacy, undefined);
    assert.equal(result.replacedAccount, undefined);
    if (fault === "migration-lock") assert.equal(result.migrationPending, true);
  });
});

test("changed immutable image or execution rejects management before helper or stop", async t => {
  for (const fault of ["image", "execution", "container-execution"]) await t.test(fault, async t => {
    const { registration, destinationRoot, authBinding } = await fixture(t);
    const { remote, reviewedTarget } = fakeRemote({ destinationRoot });
    const installed = await installSidecar({ remote, networkName: "proxy", registration,
      authBinding, reviewedTarget, backgroundConsent, confirmed: true });
    if (fault === "image") remote.faults.imageId = `sha256:${"9".repeat(64)}`;
    if (fault === "execution") remote.faults.service = { command: ["node", "/tmp/foreign.mjs"] };
    if (fault === "container-execution") remote.faults.hostConfig = { ReadonlyRootfs: false };
    const before = remote.commands.length;
    await assert.rejects(() => manageVpsSiwcInstallation({ remote, networkName: "proxy", reviewedTarget,
      registrationId, action: "disable-plan", expectedGeneration: installed.account.generation, confirmed: true }));
    assert.equal(remote.commands.slice(before).some(item => item.command === createVerificationCommands().account ||
      item.command === createVerificationCommands().stop ||
      item.command === createVerificationCommands().disablePlan), false);
  });
});

test("enable verification errors stop exact service and classify lost stop outcomes", async t => {
  for (const mode of ["malformed", "nonzero", "lost-ack", "unknown-stop"]) await t.test(mode, async t => {
    const { registration, destinationRoot, authBinding } = await fixture(t);
    const { remote, reviewedTarget } = fakeRemote({ destinationRoot });
    const installed = await installSidecar({ remote, networkName: "proxy", registration,
      authBinding, reviewedTarget, backgroundConsent, confirmed: true });
    const disabled = await manageVpsSiwcInstallation({ remote, networkName: "proxy", reviewedTarget,
      registrationId, action: "disable-plan", expectedGeneration: installed.account.generation, confirmed: true });
    const exec = remote.exec.bind(remote);
    remote.exec = async (command, options) => {
      if (command === createVerificationCommands().publicationState) {
        remote.faults.publicationFailure = mode === "nonzero" ? { code: 1, stdout: "" }
          : { code: 0, stdout: "not-json" };
        if (mode === "lost-ack") remote.faults.loseStopAck = true;
        if (mode === "unknown-stop") remote.faults.unknownStop = true;
      }
      return exec(command, options);
    };
    const before = remote.commands.length;
    await assert.rejects(() => manageVpsSiwcInstallation({ remote, networkName: "proxy", reviewedTarget,
      registrationId, action: "enable-plan", expectedGeneration: disabled.account.generation,
      backgroundConsent: true, confirmed: true }), error => {
      assert.equal(error.runtimeState, mode === "unknown-stop" ? "unknown" : "stopped");
      assert.equal(error.remoteOutcomeUnknown === true, mode === "unknown-stop");
      return true;
    });
    assert.equal(remote.commands.slice(before).filter(item => item.command === createVerificationCommands().stop).length, 2);
  });
});

test("silent acceptance and build deadlines preserve uncertainty without automatic acceptance replay", async t => {
  for (const fault of ["silentAccept", "buildTimeout"]) await t.test(fault, async t => {
    const { registration, destinationRoot, authBinding } = await fixture(t);
    const { remote, reviewedTarget } = fakeRemote({ destinationRoot });
    remote.faults[fault] = true;
    await assert.rejects(() => installSidecar({ remote, networkName: "proxy", registration,
      authBinding, reviewedTarget, backgroundConsent, confirmed: true }), error => {
      assert.equal(error.remoteOutcomeUnknown, true);
      assert.equal(error.timedOut, true);
      assert.equal(error.operationLockRetained, true);
      return true;
    });
    const accepts = remote.commands.filter(item => item.command === createVerificationCommands().accept);
    assert.equal(accepts.length, fault === "silentAccept" ? 1 : 0);
    if (accepts.length) assert.equal(accepts[0].timeoutMs, 120_000);
    const builds = remote.commands.filter(item => item.command.includes("DOCKER_BUILDKIT=1"));
    assert.equal(builds[0].timeoutMs, 1_800_000);
    await assert.rejects(() => installSidecar({ remote, networkName: "proxy", registration,
      authBinding, reviewedTarget, backgroundConsent, confirmed: true }));
    assert.equal(remote.commands.filter(item => item.command === createVerificationCommands().accept).length, accepts.length);
  });
});

// The guard is the remote VPS /bin/sh script. Windows paths carry backslashes and drive
// letters that a POSIX shell cannot treat as the Linux paths the guard checks.
test("legacy and replacement child links reject without changing outside inode", {
  skip: process.platform === "win32" && "the guard is a remote Linux /bin/sh script over Linux paths",
}, async t => {
  for (const flow of ["legacy", "replacement"]) for (const target of ["compose-hardlink", "asset-symlink"]) {
    await t.test(`${flow}/${target}`, async t => {
      const { registration, destinationRoot, authBinding } = await fixture(t);
      const { remote, reviewedTarget } = fakeRemote({ destinationRoot, legacy: flow === "legacy" });
      let consent;
      if (flow === "legacy") {
        consent = { migrationConsent: true,
          legacyBinding: await reviewVpsLegacyMigration({ remote, networkName: "proxy", reviewedTarget }) };
      } else {
        await installSidecar({ remote, networkName: "proxy", registration, authBinding,
          reviewedTarget, backgroundConsent, confirmed: true });
        const status = await getVpsSiwcInstallationStatus({ remote, networkName: "proxy", reviewedTarget });
        const signedOut = await manageVpsSiwcInstallation({ remote, networkName: "proxy", reviewedTarget,
          registrationId, action: "sign-out", expectedGeneration: status.account.generation, confirmed: true });
        consent = { replacementConsent: true, existingBinding: {
          ...await reviewVpsSiwcReplacement({ remote, networkName: "proxy", reviewedTarget }),
          ownerHostId: signedOut.account.ownerHostId, expectedGeneration: signedOut.account.generation,
        } };
      }
      const scratch = await mkdtemp(join(tmpdir(), "relmio-vps-links-"));
      t.after(() => rm(scratch, { recursive: true, force: true }));
      const docker = join(scratch, "docker"), root = join(docker, "n8n-openai-oauth");
      await mkdir(root, { recursive: true, mode: 0o755 });
      const outside = join(scratch, "outside");
      await writeFile(outside, "must stay unchanged", { mode: 0o600 });
      if (target === "compose-hardlink") await link(outside, join(root, "docker-compose.yml"));
      else {
        await mkdir(join(scratch, "outside-assets"), { mode: 0o755 });
        await symlink(join(scratch, "outside-assets"), join(root, "services"));
      }
      const outsideMetadata = await lstat(outside);
      const guard = SIDECAR_MANAGED_CONTEXT_GUARD.replaceAll(INSTALL_ROOT, root)
        .replaceAll("/docker ", `${docker} `);
      // Simulate root ownership only; inode type, link count and mode are real.
      const stat = `stat() { '${process.execPath}' --input-type=module -e 'import {lstatSync} from "node:fs"; const s=lstatSync(process.argv[2]); const f=process.argv[1]; console.log(f==="%u"?"0":f==="%u:%h"?"0:"+s.nlink:f==="%a"?(s.mode&511).toString(8):"invalid")' "$2" "$3"; };`;
      remote.faults.guard = async () => {
        try { await promisify(execFile)("sh", ["-c", `${stat}${guard}`]); return { code: 0, stdout: "" }; }
        catch (error) { return { code: error.code, stdout: "" }; }
      };
      const before = remote.uploads.length;
      const fresh = flow === "replacement"
        ? await freshRegistration(registration.storageRoot, "registration_link_reject")
        : { registration, authBinding };
      await assert.rejects(() => installSidecar({ remote, networkName: "proxy", ...fresh,
        reviewedTarget, backgroundConsent, confirmed: true, ...consent }));
      assert.equal(remote.uploads.length, before);
      assert.equal(await readFile(outside, "utf8"), "must stay unchanged");
      const afterMetadata = await lstat(outside);
      for (const field of ["ino", "dev", "nlink", "size", "mode", "mtimeMs", "uid", "gid"]) {
        assert.equal(afterMetadata[field], outsideMetadata[field]);
      }
      assert.equal(remote.commands.slice(-4).some(item => item.command === createVerificationCommands().stop), false);
    });
  }
});

test("installed status and controls reject changed destination IDs without rebinding", async t => {
  const { registration, destinationRoot, authBinding } = await fixture(t);
  const { remote, reviewedTarget } = fakeRemote({ destinationRoot });
  const installed = await installSidecar({ remote, networkName: "proxy", registration,
    authBinding, reviewedTarget, backgroundConsent, confirmed: true });
  remote.faults.n8nContainerId = "f".repeat(64);
  const before = remote.commands.length;
  await assert.rejects(() => getVpsSiwcInstallationStatus({ remote, networkName: "proxy", reviewedTarget }));
  await assert.rejects(() => inspectStoppedVpsSiwcInstallation({ remote, networkName: "proxy",
    reviewedTarget, registrationId, confirmed: true }));
  await assert.rejects(() => manageVpsSiwcInstallation({ remote, networkName: "proxy", reviewedTarget,
    registrationId, action: "sign-out", expectedGeneration: installed.account.generation, confirmed: true }));
  assert.equal(remote.commands.slice(before).some(item => item.command === createVerificationCommands().account ||
    item.command === createVerificationCommands().stop ||
    item.command === createVerificationCommands().signOut), false);
});

test("same stopped owner is re-attested before account mutation", async t => {
  const { registration, destinationRoot, authBinding } = await fixture(t);
  const { remote, reviewedTarget } = fakeRemote({ destinationRoot });
  const installed = await installSidecar({ remote, networkName: "proxy", registration,
    authBinding, reviewedTarget, backgroundConsent, confirmed: true });
  const exec = remote.exec.bind(remote);
  remote.exec = async (command, options) => {
    const result = await exec(command, options);
    if (command === createVerificationCommands().stop) remote.faults.ownerContainerId = "f".repeat(64);
    return result;
  };
  await assert.rejects(() => manageVpsSiwcInstallation({ remote, networkName: "proxy", reviewedTarget,
    registrationId, action: "sign-out", expectedGeneration: installed.account.generation, confirmed: true }));
  assert.equal(remote.commands.some(item => item.command === createVerificationCommands().signOut), false);
  assert.equal((await readRegistration({ storageRoot: destinationRoot, registrationId })).session.refreshToken,
    "fake-refresh-value");
});

test("receipt absence cannot declare not-accepted while a one-off container remains", async t => {
  const { registration, destinationRoot, authBinding } = await fixture(t);
  const { remote, reviewedTarget } = fakeRemote({ destinationRoot });
  remote.faults.delayAccept = true;
  await assert.rejects(() => installSidecar({ remote, networkName: "proxy", registration,
    authBinding, reviewedTarget, backgroundConsent, confirmed: true }),
  error => error.remoteOutcomeUnknown === true);
  const checkpoint = Buffer.from(remote.files.get(SIWC_STAGING_PATH));
  await assert.rejects(() => reconcileVpsSiwcHandoff({ remote, networkName: "proxy",
    reviewedTarget, registration, confirmed: true }), error => error.remoteOutcomeUnknown === true);
  assert.deepEqual(remote.files.get(SIWC_STAGING_PATH), checkpoint);
  assert.equal((await readRegistration(registration)).handoff.state, "handoff-pending");
  assert.equal(remote.commands.filter(item => item.command === createVerificationCommands().accept).length, 1);
});

test("late destination acceptance blocks fresh-registration resume before Compose rewrite or export", async t => {
  const { registration, destinationRoot, authBinding } = await fixture(t);
  const { remote, reviewedTarget } = fakeRemote({ destinationRoot });
  remote.faults.delayAccept = true;
  await assert.rejects(() => installSidecar({ remote, networkName: "proxy", registration,
    authBinding, reviewedTarget, backgroundConsent, confirmed: true }));
  // The empty observed container list permits a reviewed absence snapshot;
  // the deferred boundary completes acceptance after that snapshot.
  remote.faults.activeOneOff = false;
  const absent = await reconcileVpsSiwcHandoff({ remote, networkName: "proxy",
    reviewedTarget, registration, confirmed: true });
  assert.equal(absent.outcome, "not-accepted");
  const fresh = await freshRegistration(registration.storageRoot, "registration_late_acceptance");
  const resume = await reviewVpsSiwcResume({ remote, networkName: "proxy", reviewedTarget,
    registrationId: fresh.registration.registrationId });
  await remote.completeDelayedAcceptance();
  const compose = Buffer.from(remote.files.get(`${INSTALL_ROOT}/docker-compose.yml`));
  const before = remote.uploads.length;
  await assert.rejects(() => installSidecar({ remote, networkName: "proxy", ...fresh,
    reviewedTarget, backgroundConsent, resume, confirmed: true }));
  assert.deepEqual(remote.files.get(`${INSTALL_ROOT}/docker-compose.yml`), compose);
  assert.equal(remote.uploads.length, before);
  assert.equal((await readRegistration(fresh.registration)).handoff.state, "owned");
  assert.equal((await readRegistration(registration)).handoff.state, "handoff-pending");
  assert.equal(remote.commands.filter(item => item.command === createVerificationCommands().accept).length, 1);
  const recovered = await reconcileVpsSiwcHandoff({ remote, networkName: "proxy",
    reviewedTarget, registration, confirmed: true });
  assert.equal(recovered.outcome, "finished");
});

test("complete installed owner survives reviewed n8n recreation and changed SSH authentication", async t => {
  for (const change of ["n8n-recreation", "authentication"]) await t.test(change, async t => {
    const { registration, destinationRoot, authBinding } = await fixture(t);
    const { remote, reviewedTarget } = fakeRemote({ destinationRoot });
    await installSidecar({ remote, networkName: "proxy", registration,
      authBinding, reviewedTarget, backgroundConsent, confirmed: true });
    if (change === "n8n-recreation") remote.faults.n8nContainerId = "f".repeat(64);
    else Object.assign(remote.identity, { authentication: "password", username: "ubuntu",
      privilege: "sudo-n", loginUid: 1000 });
    const currentTarget = { ...remote.identity, networkName: "proxy", containerName: "n8n",
      ...await reviewVpsSiwcTarget({ remote, networkName: "proxy", containerName: "n8n" }) };
    const status = await getVpsSiwcInstallationStatus({ remote, networkName: "proxy", reviewedTarget: currentTarget });
    assert.equal(status.state, "owned");
    const result = await manageVpsSiwcInstallation({ remote, networkName: "proxy", reviewedTarget: currentTarget,
      registrationId, action: "sign-out", expectedGeneration: status.account.generation, confirmed: true });
    assert.equal(result.account.session, "signed-out");
    assert.equal(result.runtimeStopped, true);
  });
});

const runtimeVariant = label => ({ async collectAssets() {
  const assets = await collectSiwcRuntimeAssets();
  const [first, ...rest] = assets.files;
  return { ...assets, files: [
    { ...first, contents: Buffer.concat([first.contents, Buffer.from(`\n// ${label}\n`)]) }, ...rest,
  ] };
} });
const changed = runtimeVariant("updated runtime");

async function installedOwner(t) {
  const { registration, destinationRoot, authBinding } = await fixture(t);
  const { remote, reviewedTarget } = fakeRemote({ destinationRoot });
  const installed = await installSidecar({ remote, networkName: "proxy", registration,
    authBinding, reviewedTarget, backgroundConsent, confirmed: true });
  return { registration, destinationRoot, authBinding, installed, remote,
    scope: { remote, networkName: "proxy", reviewedTarget, registrationId } };
}

test("reviewed runtime update rebuilds and recreates only the owned sidecar and keeps key and session", async t => {
  const { destinationRoot, installed, remote, scope } = await installedOwner(t);
  const verification = createVerificationCommands();
  assert.equal((await getVpsSiwcInstallationStatus(scope)).runtimeUpdateAvailable, false);
  assert.equal((await getVpsSiwcInstallationStatus(scope, changed)).runtimeUpdateAvailable, true);
  const review = await reviewVpsSiwcRuntimeUpdate(scope, changed);
  const [{ path: changedPath }] = (await collectSiwcRuntimeAssets()).files;
  assert.deepEqual(review.changedFiles, [changedPath]);
  assert.equal(review.rebuildRequired, true);
  assert.equal(review.continuing, false);
  const compose = Buffer.from(remote.files.get(`${INSTALL_ROOT}/docker-compose.yml`));
  const commandsBefore = remote.commands.length;
  const uploadsBefore = remote.uploads.length;
  const result = await updateVpsSiwcRuntime({ ...scope, review, confirmed: true }, changed);
  assert.equal(result.runtimeState, "running");
  assert.equal(result.keyChanged, false);
  assert.equal(result.account.registrationId, registrationId);
  assert.notEqual(result.imageId, review.imageId);
  assert.notEqual(result.containerId, review.containerId);
  assert.equal(JSON.stringify(result).includes(installed.clientCredential), false);
  assert.deepEqual(remote.files.get(`${INSTALL_ROOT}/docker-compose.yml`), compose);
  assert.deepEqual(remote.files.get(`${INSTALL_ROOT}/${changedPath}`), (await changed.collectAssets()).files[0].contents);
  assert.equal(remote.uploads.slice(uploadsBefore).some(item => item.path.endsWith("/docker-compose.yml") ||
    item.path.startsWith(`${INSTALL_ROOT}/siwc`)), false);
  const applied = remote.commands.slice(commandsBefore);
  const commands = applied.map(item => item.command);
  for (const forbidden of [verification.accept, verification.host, verification.receipt, verification.account]) {
    assert.equal(commands.includes(forbidden), false);
  }
  assert.equal(applied.some(item => item.input?.includes("fake-refresh-value")), false);
  assert.equal(commands.some(command => /docker (?:restart|stop|rm) n8n\b|10531:10531/u.test(command)), false);
  const stopAt = commands.indexOf(verification.stop);
  assert.ok(stopAt >= 0 && stopAt < commands.findIndex(command => command.includes(" up -d ")));
  const status = await getVpsSiwcInstallationStatus(scope, changed);
  assert.equal(status.state, "owned");
  assert.equal(status.runtimeUpdateAvailable, false);
  assert.equal((await readRegistration({ storageRoot: destinationRoot, registrationId })).session.refreshToken,
    "fake-refresh-value");
});

test("runtime update review of a current install needs no rebuild and its apply is refused", async t => {
  const { remote, scope } = await installedOwner(t);
  const review = await reviewVpsSiwcRuntimeUpdate(scope);
  assert.equal(review.rebuildRequired, false);
  assert.deepEqual(review.changedFiles, []);
  const commandsBefore = remote.commands.length;
  const uploadsBefore = remote.uploads.length;
  await assert.rejects(() => updateVpsSiwcRuntime({ ...scope, review, confirmed: true }));
  assert.equal(remote.commands.length, commandsBefore);
  assert.equal(remote.uploads.length, uploadsBefore);
});

test("runtime update refuses unconfirmed, stale, mismatched or stopped owners before any write", async t => {
  const { installed, remote, scope } = await installedOwner(t);
  const review = await reviewVpsSiwcRuntimeUpdate(scope, changed);
  await assert.rejects(() => reviewVpsSiwcRuntimeUpdate({ ...scope, registrationId: "registration_other" }, changed));
  const commandsBefore = remote.commands.length;
  const uploadsBefore = remote.uploads.length;
  for (const invalid of [{ confirmed: false }, { registrationId: "registration_other" },
    { review: { ...review, rebuildRequired: false } }]) {
    await assert.rejects(() => updateVpsSiwcRuntime({ ...scope, review, confirmed: true, ...invalid }, changed));
  }
  // This Relmio version's runtime files must be the ones reviewed.
  await assert.rejects(() => updateVpsSiwcRuntime({ ...scope, review, confirmed: true }));
  assert.equal(remote.commands.length, commandsBefore);
  await assert.rejects(() => updateVpsSiwcRuntime({ ...scope, confirmed: true,
    review: { ...review, checkpointSha256: "0".repeat(64) } }, changed));
  await manageVpsSiwcInstallation({ ...scope, action: "disable-plan",
    expectedGeneration: installed.account.generation, confirmed: true });
  await assert.rejects(() => reviewVpsSiwcRuntimeUpdate(scope, changed));
  await assert.rejects(() => updateVpsSiwcRuntime({ ...scope, review, confirmed: true }, changed));
  assert.equal(remote.uploads.length, uploadsBefore);
  assert.equal(remote.commands.slice(commandsBefore).some(item => item.command.includes("DOCKER_BUILDKIT=1") ||
    item.command.includes(" up -d ")), false);
});

test("interrupted runtime update start stays updating, refuses generic resume and finishes from a new review", async t => {
  const modes = { start: { failStart: true }, verification: { publishedHostPort: true },
    "unknown-stop": { publishedHostPort: true } };
  for (const [mode, faults] of Object.entries(modes)) await t.test(mode, async t => {
    const { registration, authBinding, remote, scope } = await installedOwner(t);
    const uncertain = mode === "unknown-stop";
    const review = await reviewVpsSiwcRuntimeUpdate(scope, changed);
    Object.assign(remote.faults, faults);
    const exec = remote.exec.bind(remote);
    // Only the stop of the started, unverified sidecar loses its outcome.
    if (uncertain) remote.exec = async (command, options) => {
      if (command === createVerificationCommands().publicationState) remote.faults.unknownStop = true;
      return exec(command, options);
    };
    await assert.rejects(() => updateVpsSiwcRuntime({ ...scope, review, confirmed: true }, changed), error => {
      assert.equal(error.recovery, "review-again");
      assert.equal(error.runtimeState, uncertain ? "unknown" : "stopped");
      assert.equal(error.hostPublication, uncertain ? "unknown" : "none");
      assert.equal(error.remoteOutcomeUnknown === true, uncertain);
      return true;
    });
    remote.exec = exec;
    for (const fault of [...Object.keys(faults), "unknownStop"]) remote.faults[fault] = false;
    const status = await getVpsSiwcInstallationStatus(scope);
    assert.equal(status.state, "updating");
    await assert.rejects(() => reviewVpsSiwcResume(scope));
    const uploadsBefore = remote.uploads.length;
    await assert.rejects(() => installSidecar({ remote, networkName: "proxy", registration, authBinding,
      reviewedTarget: scope.reviewedTarget, backgroundConsent, confirmed: true,
      resume: { ...status.staging, deploymentMode: "installed" } }));
    assert.equal(remote.uploads.length, uploadsBefore);
    const next = await reviewVpsSiwcRuntimeUpdate(scope, changed);
    assert.equal(next.continuing, true);
    assert.equal(next.rebuildRequired, true);
    assert.equal(next.operationLockIdentity !== undefined, uncertain);
    const result = await updateVpsSiwcRuntime({ ...scope, review: next, confirmed: true }, changed);
    assert.equal(result.runtimeState, "running");
    const finished = await getVpsSiwcInstallationStatus(scope, changed);
    assert.equal(finished.state, "owned");
    assert.equal(finished.runtimeUpdateAvailable, false);
  });
});

test("runtime update interrupted before its built journal is finished by a rebuilding continuation", async t => {
  const { remote, scope } = await installedOwner(t);
  const verification = createVerificationCommands();
  const review = await reviewVpsSiwcRuntimeUpdate(scope, changed);
  remote.faults.failJournalStage = "built";
  const before = remote.commands.length;
  await assert.rejects(() => updateVpsSiwcRuntime({ ...scope, review, confirmed: true }, changed));
  const attempted = remote.commands.slice(before).map(item => item.command);
  assert.equal(attempted.filter(command => command.includes("DOCKER_BUILDKIT=1")).length, 1);
  assert.equal(attempted.some(command => command === verification.stop || command === verification.accountLive ||
    command.includes(" up -d ")), false);
  remote.faults.failJournalStage = undefined;
  const status = await getVpsSiwcInstallationStatus(scope);
  assert.equal(status.state, "updating");
  assert.equal(status.staging.stage, "context");
  const next = await reviewVpsSiwcRuntimeUpdate(scope, changed);
  assert.equal(next.continuing, true);
  assert.equal(next.containerId, review.containerId);
  const resumedAt = remote.commands.length;
  const result = await updateVpsSiwcRuntime({ ...scope, review: next, confirmed: true }, changed);
  const resumed = remote.commands.slice(resumedAt).map(item => item.command);
  assert.equal(resumed.filter(command => command.includes("DOCKER_BUILDKIT=1")).length, 1);
  assert.ok(resumed.includes(verification.stop));
  assert.equal(result.runtimeState, "running");
  assert.notEqual(result.containerId, review.containerId);
  assert.equal((await getVpsSiwcInstallationStatus(scope, changed)).runtimeUpdateAvailable, false);
});

test("non-transferred resume from built rebuilds changed runtime files and records the new image", async t => {
  const { registration, destinationRoot, authBinding } = await fixture(t);
  const { remote, reviewedTarget } = fakeRemote({ destinationRoot });
  const exec = remote.exec.bind(remote);
  remote.exec = async (command, options) => {
    const result = await exec(command, options);
    if (command.includes("DOCKER_BUILDKIT=1")) remote.faults.networkId = "f".repeat(64);
    return result;
  };
  await assert.rejects(() => installSidecar({ remote, networkName: "proxy", registration,
    authBinding, reviewedTarget, backgroundConsent, confirmed: true }));
  remote.exec = exec;
  delete remote.faults.networkId;
  const staged = JSON.parse(remote.files.get(SIWC_STAGING_PATH));
  assert.equal(staged.stage, "built");
  const resume = await reviewVpsSiwcResume({ remote, networkName: "proxy", reviewedTarget, registrationId });
  const commandsBefore = remote.commands.length;
  const uploadsBefore = remote.uploads.length;
  const result = await installSidecar({ remote, networkName: "proxy", registration, authBinding,
    reviewedTarget, backgroundConsent, resume, confirmed: true }, changed);
  assert.equal(result.runtimeState, "running");
  assert.equal(remote.commands.slice(commandsBefore).filter(item => item.command.includes("DOCKER_BUILDKIT=1")).length, 1);
  const uploads = remote.uploads.slice(uploadsBefore);
  const context = uploads.findIndex(item => item.path === SIWC_STAGING_PATH &&
    JSON.parse(String(item.contents)).stage === "context");
  assert.ok(context >= 0 && context < uploads.findIndex(item => item.path !== SIWC_STAGING_PATH));
  assert.equal(JSON.parse(String(uploads[context].contents)).imageId, undefined);
  const finished = JSON.parse(remote.files.get(SIWC_STAGING_PATH));
  assert.notEqual(finished.imageId, staged.imageId);
  assert.equal(finished.imageId, JSON.parse((await exec(createVerificationCommands().ownerImage)).stdout).Id);
  assert.notEqual(finished.imageSourceSha256, staged.imageSourceSha256);
  assert.equal((await getVpsSiwcInstallationStatus({ remote, networkName: "proxy", reviewedTarget },
    changed)).runtimeUpdateAvailable, false);
});

test("runtime update continuation keeps files left by an earlier interrupted attempt attestable", async t => {
  const { remote, scope } = await installedOwner(t);
  const first = runtimeVariant("first attempt"), second = runtimeVariant("second attempt");
  const [, laterAsset] = (await collectSiwcRuntimeAssets()).files;
  const review = await reviewVpsSiwcRuntimeUpdate(scope, first);
  // The first attempt publishes its changed asset, then stops at the next upload.
  remote.faults.failUpload = `${INSTALL_ROOT}/${laterAsset.path}`;
  await assert.rejects(() => updateVpsSiwcRuntime({ ...scope, review, confirmed: true }, first));
  const retry = await reviewVpsSiwcRuntimeUpdate(scope, second);
  assert.equal(retry.continuing, true);
  // The continuation stops before replacing the first attempt's asset.
  remote.faults.failUpload = `${INSTALL_ROOT}/Dockerfile`;
  await assert.rejects(() => updateVpsSiwcRuntime({ ...scope, review: retry, confirmed: true }, second));
  assert.equal((await getVpsSiwcInstallationStatus(scope)).state, "updating");
  const last = await reviewVpsSiwcRuntimeUpdate(scope, second);
  const result = await updateVpsSiwcRuntime({ ...scope, review: last, confirmed: true }, second);
  assert.equal(result.runtimeState, "running");
  assert.equal((await getVpsSiwcInstallationStatus(scope, second)).runtimeUpdateAvailable, false);
});

test("confirmed runtime build failure keeps the running previous sidecar installed; an uncertain one stays updating", async t => {
  for (const mode of ["confirmed", "uncertain"]) await t.test(mode, async t => {
    const { installed, remote, scope } = await installedOwner(t);
    const review = await reviewVpsSiwcRuntimeUpdate(scope, changed);
    const fault = mode === "confirmed" ? "buildFailed" : "buildTimeout";
    remote.faults[fault] = true;
    await assert.rejects(() => updateVpsSiwcRuntime({ ...scope, review, confirmed: true }, changed), error => {
      assert.equal(error.remoteOutcomeUnknown === true, mode === "uncertain");
      if (mode === "confirmed") {
        assert.equal(error.recovery, "review-again");
        assert.equal(error.runtimeState, "running");
      }
      return true;
    });
    remote.faults[fault] = false;
    const status = await getVpsSiwcInstallationStatus(scope, changed);
    if (mode === "uncertain") {
      assert.equal(status.state, "updating");
      return;
    }
    assert.equal(status.state, "owned");
    assert.equal(status.runtimeUpdateAvailable, true);
    const owner = await reviewVpsSiwcReplacement(scope);
    assert.deepEqual([owner.containerId, owner.imageId, owner.running], [review.containerId, review.imageId, true]);
    const again = await reviewVpsSiwcRuntimeUpdate(scope, changed);
    assert.equal(again.continuing, false);
    assert.equal(again.rebuildRequired, true);
    const disabled = await manageVpsSiwcInstallation({ ...scope, action: "disable-plan",
      expectedGeneration: installed.account.generation, confirmed: true });
    assert.equal(disabled.runtimeStopped, true);
  });
});

test("fresh runtime update review refuses a held operation lock", async t => {
  const { remote, scope } = await installedOwner(t);
  const exec = remote.exec.bind(remote);
  remote.exec = async (command, options) => command.includes("printf none")
    ? { code: 0, stdout: "1:1" } : exec(command, options);
  await assert.rejects(() => reviewVpsSiwcRuntimeUpdate(scope, changed));
  remote.exec = exec;
  assert.equal((await reviewVpsSiwcRuntimeUpdate(scope, changed)).operationLockIdentity, undefined);
});

test("frozen handoff reconciliation refuses an interrupted runtime update record", async t => {
  const { registration, destinationRoot, authBinding } = await fixture(t);
  const { remote, reviewedTarget } = fakeRemote({ destinationRoot, rejectAccept: true });
  await assert.rejects(() => installSidecar({ remote, networkName: "proxy", registration,
    authBinding, reviewedTarget, backgroundConsent, confirmed: true }));
  const checkpoint = JSON.parse(remote.files.get(SIWC_STAGING_PATH));
  const updating = Buffer.from(`${JSON.stringify({ ...checkpoint,
    runtimeUpdate: { fromImageId: checkpoint.imageId, fromContainerId: "c".repeat(64) } })}\n`);
  remote.files.set(SIWC_STAGING_PATH, updating);
  await assert.rejects(() => reconcileVpsSiwcHandoff({ remote, networkName: "proxy",
    reviewedTarget, registration, confirmed: true }));
  assert.deepEqual(remote.files.get(SIWC_STAGING_PATH), updating);
  assert.equal((await readRegistration(registration)).handoff.state, "handoff-pending");
});

const imageRuns = remote => remote.commands.map(item => item.command)
  .filter(command => command.includes("/app/services/codex-images.mjs "));
const LOCK_ACQUIRE = "&& mkdir /docker/n8n-openai-oauth/.openai-oauth-operation.lock &&";
const LOCK_RELEASE = "rmdir /docker/n8n-openai-oauth/.openai-oauth-operation.lock";

test("Codex image status attests the running owner, keeps only known fields and reports an older sidecar", async t => {
  const { remote, scope } = await installedOwner(t);
  const verification = createVerificationCommands();
  const { containerId } = await reviewVpsSiwcReplacement(scope);
  remote.faults.images = command => command === verification.imagesStatus
    ? { code: 0, stdout: JSON.stringify({ state: "signed-in", account: { accountIdSuffix: "abc123" },
      accessToken: "fake-images-access" }) }
    : { code: 1, stdout: "" };
  const status = await getVpsCodexImagesStatus(scope);
  assert.deepEqual(status, { state: "signed-in", account: { accountIdSuffix: "abc123" }, containerId });
  assert.equal(JSON.stringify(status).includes("fake-images-access"), false);
  remote.faults.images = () => ({ code: 1, stdout: "" });
  assert.deepEqual(await getVpsCodexImagesStatus(scope), { state: "unavailable", containerId });
  remote.faults.images = () => ({ code: 1, stdout: JSON.stringify({ error: "images_unavailable", message: "busy" }) });
  await assert.rejects(getVpsCodexImagesStatus(scope), { code: "images_unavailable" });
  for (const stdout of ["not json", JSON.stringify({ state: "unavailable" }), JSON.stringify({ error: "images_off" })]) {
    remote.faults.images = () => ({ code: 0, stdout });
    await assert.rejects(getVpsCodexImagesStatus(scope));
  }
  remote.faults.images = () => ({ code: 0, stdout: JSON.stringify({ state: "off" }) });
  const runs = imageRuns(remote).length;
  await assert.rejects(getVpsCodexImagesStatus({ ...scope, registrationId: "registration_other" }));
  await assert.rejects(getVpsCodexImagesStatus({ ...scope, registrationId: "../auth" }));
  const { account } = await getVpsSiwcInstallationStatus(scope);
  await manageVpsSiwcInstallation({ ...scope, action: "disable-plan",
    expectedGeneration: account.generation, confirmed: true });
  await assert.rejects(getVpsCodexImagesStatus(scope));
  assert.equal(imageRuns(remote).length, runs);
});

test("Codex image actions run only their fixed command while holding the OAuth operation lock", async t => {
  const { remote, scope } = await installedOwner(t);
  const verification = createVerificationCommands();
  const { containerId } = await reviewVpsSiwcReplacement(scope);
  const pending = { userCode: "ABCD-EFGH", verificationUrl: "https://auth.openai.com/codex/device",
    expiresAt: "2026-10-06T12:15:00.000Z" };
  const outputs = {
    [verification.imagesLoginStart]: { state: "pending", pending, deviceAuthId: "fake-device-auth" },
    [verification.imagesLoginPoll]: { state: "off", outcome: "declined" },
    [verification.imagesLoginCancel]: { state: "off" },
    [verification.imagesSignOut]: { state: "off", revocation: "confirmed" },
  };
  remote.faults.images = command => ({ code: 0, stdout: JSON.stringify(outputs[command]) });
  for (const [action, key, confirmed] of [["login-start", "imagesLoginStart", true],
    ["login-poll", "imagesLoginPoll"], ["login-cancel", "imagesLoginCancel"], ["sign-out", "imagesSignOut", true]]) {
    const start = remote.commands.length;
    const result = await changeVpsCodexImages({ ...scope, action, expectedContainerId: containerId, confirmed });
    const expected = { ...outputs[verification[key]], containerId };
    delete expected.deviceAuthId;
    assert.deepEqual(result, expected);
    const commands = remote.commands.slice(start).map(item => item.command);
    assert.deepEqual(commands.filter(command => command.includes("/app/services/codex-images.mjs ")), [verification[key]]);
    const acquired = commands.findIndex(command => command.includes(LOCK_ACQUIRE));
    const ran = commands.indexOf(verification[key]);
    const released = commands.findIndex(command => command.endsWith(LOCK_RELEASE));
    assert.ok(acquired >= 0 && acquired < ran && ran < released, action);
  }
});

test("Codex image changes refuse missing confirmation, a changed sidecar or a held lock before running", async t => {
  const { remote, scope } = await installedOwner(t);
  const verification = createVerificationCommands();
  const { containerId } = await reviewVpsSiwcReplacement(scope);
  const change = fields => changeVpsCodexImages({ ...scope, expectedContainerId: containerId, confirmed: true, ...fields });
  const actions = ["login-start", "login-poll", "login-cancel", "sign-out"];
  const before = remote.commands.length;
  for (const fields of [
    { action: "login-start", confirmed: false }, { action: "sign-out", confirmed: "yes" },
    { action: "status" }, { action: "login-start; docker stop n8n" }, { action: "toString" },
    { action: "login-poll", expectedContainerId: "short" },
    { action: "login-poll", reviewedTarget: { ...scope.reviewedTarget, fingerprint: "SHA256:other" } },
  ]) await assert.rejects(change(fields));
  assert.equal(remote.commands.length, before);
  for (const action of actions) {
    await assert.rejects(change({ action, expectedContainerId: "f".repeat(64) }), action);
    await assert.rejects(change({ action, registrationId: "registration_other" }), action);
  }
  remote.faults.containerImageId = `sha256:${"9".repeat(64)}`;
  for (const action of actions) await assert.rejects(change({ action }), action);
  delete remote.faults.containerImageId;
  const exec = remote.exec.bind(remote);
  remote.exec = async (command, options) => {
    const result = await exec(command, options);
    return command === verification.ownerContainer ? { ...result, stdout: JSON.stringify({
      ...JSON.parse(result.stdout), State: { Running: false, Paused: false } }) } : result;
  };
  for (const action of actions) await assert.rejects(change({ action }), action);
  remote.exec = async (command, options) => command.includes(LOCK_ACQUIRE)
    ? { code: 1, stdout: "" } : exec(command, options);
  for (const action of actions) await assert.rejects(change({ action }), action);
  remote.exec = exec;
  assert.deepEqual(imageRuns(remote), []);
  assert.equal((await change({ action: "login-poll" })).state, "off");
  remote.faults.images = () => ({ code: 1, stdout: "Error: Cannot find module '/app/services/codex-images.mjs'" });
  await assert.rejects(change({ action: "login-poll" }));
  remote.faults.images = () => ({ code: 1, stdout: JSON.stringify({ error: "images_signed_in", message: "Already on." }) });
  await assert.rejects(change({ action: "login-start" }), { code: "images_signed_in" });
  const failure = async error => {
    remote.faults.images = () => ({ code: 1, stdout: JSON.stringify({ error, message: "remote text must not leak" }) });
    return change({ action: "login-start" }).then(() => assert.fail("login-start must fail"), caught => caught);
  };
  const disabled = await failure("images_device_login_disabled");
  const generic = await failure("images_unknown_step");
  assert.equal(disabled.code, "images_device_login_disabled");
  assert.notEqual(disabled.message, generic.message, "a disabled device code sign-in gets its own local explanation");
  assert.equal((await failure("__proto__")).message, generic.message);
  for (const error of [disabled, generic]) assert.equal(error.message.includes("remote text"), false);
});

test("SIWC sign-out first signs out of Codex images best effort; pausing plan use keeps them", async t => {
  const verification = createVerificationCommands();
  for (const images of [
    () => ({ code: 0, stdout: JSON.stringify({ state: "off", revocation: "confirmed" }) }),
    () => ({ code: 1, stdout: "Error: Cannot find module '/app/services/codex-images.mjs'" }),
    () => { throw new Error("channel lost while printing private-images-output"); },
  ]) {
    const { remote, scope } = await installedOwner(t);
    remote.faults.images = images;
    const { account } = await getVpsSiwcInstallationStatus(scope);
    const start = remote.commands.length;
    const result = await manageVpsSiwcInstallation({ ...scope, action: "sign-out",
      expectedGeneration: account.generation, confirmed: true });
    assert.equal(result.account.session, "signed-out");
    assert.equal(JSON.stringify(result).includes("private-images-output"), false);
    const commands = remote.commands.slice(start).map(item => item.command);
    assert.deepEqual(commands.filter(command => command.includes("/app/services/codex-images.mjs ")), [verification.imagesSignOut]);
    assert.ok(commands.indexOf(verification.imagesSignOut) < commands.indexOf(verification.stop));
  }
  const { remote, scope } = await installedOwner(t);
  const { account } = await getVpsSiwcInstallationStatus(scope);
  const runs = imageRuns(remote).length;
  const paused = await manageVpsSiwcInstallation({ ...scope, action: "disable-plan",
    expectedGeneration: account.generation, confirmed: true });
  assert.equal(paused.runtimeStopped, true);
  assert.equal(imageRuns(remote).length, runs);
});

test("adding the image module makes an installed sidecar's runtime update available and ships it", async t => {
  const { registration, destinationRoot, authBinding } = await fixture(t);
  const { remote, reviewedTarget } = fakeRemote({ destinationRoot });
  const imagesPath = "services/codex-images.mjs";
  const older = { async collectAssets() {
    const assets = await collectSiwcRuntimeAssets();
    return { ...assets, files: assets.files.filter(file => file.path !== imagesPath) };
  } };
  await installSidecar({ remote, networkName: "proxy", registration,
    authBinding, reviewedTarget, backgroundConsent, confirmed: true }, older);
  assert.equal(remote.files.has(`${INSTALL_ROOT}/${imagesPath}`), false);
  const scope = { remote, networkName: "proxy", reviewedTarget, registrationId };
  assert.equal((await getVpsSiwcInstallationStatus(scope, older)).runtimeUpdateAvailable, false);
  assert.equal((await getVpsSiwcInstallationStatus(scope)).runtimeUpdateAvailable, true);
  const review = await reviewVpsSiwcRuntimeUpdate(scope);
  assert.ok(review.changedFiles.includes(imagesPath));
  assert.equal(review.rebuildRequired, true);
  await updateVpsSiwcRuntime({ ...scope, review, confirmed: true });
  const shipped = (await collectSiwcRuntimeAssets()).files.find(file => file.path === imagesPath);
  assert.deepEqual(remote.files.get(`${INSTALL_ROOT}/${imagesPath}`), shipped.contents);
  assert.equal((await getVpsSiwcInstallationStatus(scope)).runtimeUpdateAvailable, false);
});

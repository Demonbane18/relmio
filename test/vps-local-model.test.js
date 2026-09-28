import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, link, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { createLocalN8nModelPlan, getLocalModelDefinition, LOCAL_MODEL_RUNTIME_IMAGE } from "../src/domain/local-n8n-model.js";
import { inspectVpsLocalModel, reviewVpsLocalModel, installVpsLocalModel, changeVpsLocalModel, getVpsLocalModelOperationStatus } from "../src/services/vps-local-model.js";

const containerId = "a".repeat(64);
const networkId = "b".repeat(64);
const selection = { containerName: "n8n-fixture", networkName: "private-net" };
const gib = 1024 ** 3;

function remoteFixture({ memoryBytes = 8 * gib, dockerMemoryBytes = 16 * gib,
  diskAvailableBytes = 50 * gib, networkIdActual = networkId, running = true,
  networkDriver = "bridge", networkInternal = false, networkOptions = {}, networkFlags = {},
  parentMetadata = "0:755", parentCode = 0, collision = false, orphan = false, dockerRoot = "/var/lib/docker" } = {}) {
  const calls = [];
  return { calls, async exec(command) {
    calls.push(command);
    if (command === "[ -d /docker ] && [ ! -L /docker ] && stat -c %u:%a /docker") return { code: parentCode, stdout: parentMetadata };
    if (command.includes("printf absent")) return { code: 0, stdout: "absent" };
    if (command.startsWith("docker ps -a --filter label=io.relmio.target=n8n-local-model")) return {
      code: 0, stdout: orphan ? "unattributed-model-container" : "",
    };
    if (command.startsWith("docker volume ls --filter label=io.relmio.target=n8n-local-model")) return {
      code: 0, stdout: "",
    };
    if (command.startsWith("docker inspect n8n-fixture")) return { code: 0,
      stdout: `${JSON.stringify(containerId)}|${running}|${JSON.stringify({ "private-net": { NetworkID: networkIdActual } })}` };
    if (command.startsWith("docker network inspect private-net")) return { code: 0,
      stdout: JSON.stringify({ Id: networkIdActual, Name: "private-net", Scope: "local", Driver: networkDriver,
        Internal: networkInternal, Options: networkOptions, ...networkFlags,
        Containers: collision ? { ["c".repeat(64)]: { Name: "foreign" } } : {} }) };
    if (command.startsWith("docker inspect " + "c".repeat(64))) return { code: 0,
      stdout: JSON.stringify({ "private-net": { Aliases: ["n8n-local-model"] } }) };
    if (command.startsWith("docker info ")) return { code: 0,
      stdout: `${JSON.stringify(dockerMemoryBytes)}|${JSON.stringify(4)}|${JSON.stringify(dockerRoot)}` };
    if (command.startsWith("df -B1 ")) return { code: 0, stdout: `Avail\n${diskAvailableBytes}\n` };
    if (command.startsWith("sed -n ")) return { code: 0, stdout: `${memoryBytes / 1024}\n` };
    throw new Error(`Unexpected remote command: ${command}`);
  } };
}

test("VPS review binds exact selected IDs and measured model budget without remote mutation", async () => {
  const remote = remoteFixture();
  const plan = await reviewVpsLocalModel({ remote, ...selection, action: "install", modelId: "qwen3:0.6b" });
  assert.equal(plan.containerId, containerId);
  assert.equal(plan.networkId, networkId);
  assert.equal(plan.modelId, "qwen3:0.6b");
  assert.match(plan.approvedModelDigest, /^sha256:[a-f0-9]{64}$/u);
  assert.equal(plan.approvedModelDigest, getLocalModelDefinition(plan.modelId).manifestDigest);
  assert.equal(plan.hostResources.memoryBytes, 16 * gib);
  assert.ok(plan.requiredDiskBytes > plan.expectedDownloadBytes);
  assert.deepEqual(plan.publishedPorts, []);
  assert.deepEqual(plan.existingN8nChanges, []);
  assert.equal(plan.installDirectory, "/docker/n8n-openai-oauth/local-model");
  assert.deepEqual(plan.sharedRootBootstrap, {
    directory: "/docker/n8n-openai-oauth",
    markerPath: "/docker/n8n-openai-oauth/.managed-by-relmio-root",
    mayCreateDirectory: true, mayCreateMarker: true, preservesExistingMode: true,
  });
  assert.equal(plan.operationLockPath, "/docker/n8n-openai-oauth/.local-model-operation.lock");
  assert.ok(remote.calls.every(command => !/\b(?:mkdir|rm|stop|start|upload|build|pull|up -d)\b/u.test(command)));
  assert.deepEqual((await inspectVpsLocalModel({ remote, ...selection })).state, "absent");
});

test("an absent model reports unavailable when selected n8n cannot be inspected", async () => {
  const status = await inspectVpsLocalModel({ remote: remoteFixture({ running: false }), ...selection });
  assert.equal(status.state, "unavailable");
  assert.equal(status.installId, null);
  assert.equal(status.modelId, null);
});

test("VPS review rejects unknown and insufficient resources, foreign networks, and alias collisions", async () => {
  await assert.rejects(() => reviewVpsLocalModel({ remote: remoteFixture({ memoryBytes: 2 * gib }), ...selection,
    action: "install", modelId: "qwen3:0.6b" }), /insufficient/u);
  const smallHost = await reviewVpsLocalModel({
    remote: remoteFixture({ dockerMemoryBytes: 4 * gib, memoryBytes: 3 * gib }), ...selection,
    action: "install", modelId: "qwen3:0.6b",
  });
  assert.equal(smallHost.hostResources.memoryBytes, 4 * gib);
  await assert.rejects(() => reviewVpsLocalModel({ remote: remoteFixture({ diskAvailableBytes: 2 * gib }), ...selection,
    action: "install", modelId: "qwen3:0.6b" }), /insufficient/u);
  await assert.rejects(() => reviewVpsLocalModel({ remote: remoteFixture({ networkDriver: "overlay" }), ...selection,
    action: "install", modelId: "qwen3:0.6b" }));
  await assert.rejects(() => reviewVpsLocalModel({ remote: remoteFixture({ networkInternal: true }), ...selection,
    action: "install", modelId: "qwen3:0.6b" }));
  await assert.rejects(() => reviewVpsLocalModel({ remote: remoteFixture({ collision: true }), ...selection,
    action: "install", modelId: "qwen3:0.6b" }), /already in use/u);
  const malicious = remoteFixture({ dockerRoot: "/var/lib/docker; touch /tmp/evil" });
  await assert.rejects(() => reviewVpsLocalModel({ remote: malicious, ...selection,
    action: "install", modelId: "qwen3:0.6b" }));
  assert.ok(malicious.calls.every(command => !command.includes("touch")));
});

test("VPS model review rejects unsafe active bridge options without remote writes", async () => {
  const unsafeOptions = [
    { "com.docker.network.bridge.gateway_mode_ipv4": "nat-unprotected" },
    { "com.docker.network.bridge.gateway_mode_ipv6": "nat-unprotected" },
    { "com.docker.network.bridge.gateway_mode_ipv4": "unknown-mode" },
    { "com.docker.network.bridge.gateway_mode_ipv4": "isolated" },
    { "com.docker.network.bridge.gateway_mode_ipv4": true },
    { "com.docker.network.bridge.enable_icc": "false" },
    { "com.docker.network.bridge.default_bridge": "true" },
    [],
  ];
  for (const networkOptions of unsafeOptions) {
    const remote = remoteFixture({ networkOptions });
    await assert.rejects(() => reviewVpsLocalModel({ remote, ...selection,
      action: "install", modelId: "qwen3:0.6b" }), /network|bridge/u);
    assert.ok(remote.calls.every(command => !/\b(?:mkdir|rm|stop|start|build|pull)\b/u.test(command)));
  }
});

test("published-port routing and inactive-family options do not disqualify unpublished models", async () => {
  for (const networkFlags of [{ EnableIPv6: false }, { EnableIPv4: false, EnableIPv6: true }]) {
    const disabledFamily = networkFlags.EnableIPv4 === false ? "ipv4" : "ipv6";
    const enabledFamily = disabledFamily === "ipv4" ? "ipv6" : "ipv4";
    const remote = remoteFixture({ networkFlags, networkOptions: {
      [`com.docker.network.bridge.gateway_mode_${disabledFamily}`]: "nat-unprotected",
      [`com.docker.network.bridge.gateway_mode_${enabledFamily}`]: "routed",
      "com.docker.network.bridge.trusted_host_interfaces": "eth0:vxlan.1",
      "com.docker.network.bridge.host_binding_ipv4": "0.0.0.0",
    } });
    const plan = await reviewVpsLocalModel({ remote, ...selection, action: "install", modelId: "qwen3:0.6b" });
    assert.deepEqual(plan.publishedPorts, []);
    assert.equal(plan.networkId, networkId);
  }
});

test("unsafe or missing docker parent is an administrator prerequisite before review or apply writes", async () => {
  const plan = await reviewVpsLocalModel({ remote: remoteFixture(), ...selection,
    action: "install", modelId: "qwen3:0.6b" });
  for (const prerequisite of [{ parentCode: 1 }, { parentMetadata: "1000:755" },
    { parentMetadata: "0:775" }, { parentMetadata: "0:777" }, { parentMetadata: "" }]) {
    const remote = remoteFixture(prerequisite);
    await assert.rejects(() => inspectVpsLocalModel({ remote, ...selection }), /administrator.*\/docker/iu);
    await assert.rejects(() => reviewVpsLocalModel({ remote, ...selection,
      action: "install", modelId: "qwen3:0.6b" }), /administrator.*\/docker/iu);
    await assert.rejects(() => installVpsLocalModel({ remote, plan, confirmed: true }), /administrator.*\/docker/iu);
    assert.ok(remote.calls.every(command => !/\b(?:mkdir|rm|stop|start|build|pull)\b/u.test(command)));
  }
});

test("a bridge becoming unprotected after review fails before VPS installation writes", async () => {
  const plan = await reviewVpsLocalModel({ remote: remoteFixture(), ...selection,
    action: "install", modelId: "qwen3:0.6b" });
  const remote = remoteFixture({ networkOptions: { "com.docker.network.bridge.gateway_mode_ipv4": "nat-unprotected" } });
  await assert.rejects(() => installVpsLocalModel({ remote, plan, confirmed: true }), /network|bridge/u);
  assert.ok(remote.calls.every(command => !/\b(?:mkdir|rm|stop|start|build|pull)\b/u.test(command)));
});

test("missing ownership marker cannot hide an orphaned managed model", async () => {
  const remote = remoteFixture({ orphan: true });
  await assert.rejects(() => inspectVpsLocalModel({ remote, ...selection }));
  await assert.rejects(() => reviewVpsLocalModel({ remote, ...selection, action: "install", modelId: "qwen3:0.6b" }));
  assert.ok(remote.calls.every(command => !command.startsWith("docker rm") && !command.includes(" up -d ")));
});

test("VPS command inputs reject shell fragments and unreviewed cache deletion before any write", async () => {
  const remote = remoteFixture();
  await assert.rejects(() => reviewVpsLocalModel({ remote, ...selection, containerName: "n8n; touch /tmp/x",
    action: "install", modelId: "qwen3:0.6b" }), /invalid/u);
  await assert.rejects(() => reviewVpsLocalModel({ remote, ...selection, networkName: "private-net$(id)",
    action: "install", modelId: "qwen3:0.6b" }), /invalid/u);
  await assert.rejects(() => reviewVpsLocalModel({ remote, ...selection, action: "install", modelId: "qwen3:0.6b;id" }));
  await assert.rejects(() => reviewVpsLocalModel({ remote, ...selection, action: "restart-n8n", modelId: "qwen3:0.6b" }), /supported/u);
  await assert.rejects(() => reviewVpsLocalModel({ remote, ...selection, action: "remove" }), /cache/u);
  assert.equal(remote.calls.length, 0);

  const plan = await reviewVpsLocalModel({ remote, ...selection, action: "install", modelId: "qwen3:0.6b" });
  const before = remote.calls.length;
  await assert.rejects(() => installVpsLocalModel({ remote, plan, confirmed: false }), /Confirm/u);
  await assert.rejects(() => installVpsLocalModel({ remote, plan: { ...plan,
    approvedModelDigest: `sha256:${"0".repeat(64)}` }, confirmed: true }));
  await assert.rejects(() => installVpsLocalModel({ remote, plan: { ...plan, modelId: "qwen3.5:9b" }, confirmed: true }));
  await assert.rejects(() => installVpsLocalModel({ remote, plan: { ...plan, hostResources: { ...plan.hostResources, memoryBytes: 64 * gib } }, confirmed: true }));
  await assert.rejects(() => changeVpsLocalModel({ remote, plan: { ...plan, action: "remove" }, confirmed: true }));
  assert.equal(remote.calls.length, before);
});

test("a replaced n8n/network identity is rejected before any remote write", async () => {
  const first = remoteFixture();
  const plan = await reviewVpsLocalModel({ remote: first, ...selection, action: "install", modelId: "qwen3:0.6b" });
  const changed = remoteFixture({ networkIdActual: "e".repeat(64) });
  const original = changed.exec;
  changed.exec = command => {
    if (command.startsWith("if [ -e /docker/n8n-openai-oauth ]")) {
      changed.calls.push(command);
      return Promise.resolve({ code: 0, stdout: "managed" });
    }
    if (command.includes("mkdir -m 0755 /docker/n8n-openai-oauth")) {
      changed.calls.push(command);
      return Promise.resolve({ code: 0, stdout: "" });
    }
    return original(command);
  };
  await assert.rejects(() => installVpsLocalModel({ remote: changed, plan, confirmed: true }));
  assert.ok(changed.calls.every(command => !/\b(?:mkdir|install -d|build|up -d)\b/u.test(command)));
});

function installedFixture({ phase = "model-ready", foreignVolume = false, foreignImage = false,
  foreignDigest = false, n8nMissing = false } = {}) {
  const calls = [];
  const installId = "c".repeat(32);
  const operationId = "d".repeat(32);
  const project = `relmio-n8n-local-model-${installId}`;
  const names = { container: `${project}-local-model-1`, operation: `${project}-acquisition`,
    volume: `${project}_model-cache`, helperImage: `relmio-n8n-local-model-acquisition-${installId}:local` };
  const modelId = "qwen3:0.6b";
  const hostResources = { memoryBytes: 8 * gib, cpus: 4, diskAvailableBytes: 50 * gib };
  const budget = createLocalN8nModelPlan({ dockerHost: "unix:///var/run/docker.sock", n8nContainerId: containerId,
    n8nContainerName: selection.containerName, dockerNetworkId: networkId, networkName: selection.networkName, modelId, hostResources });
  const marker = { schemaVersion: 1, kind: "relmio-vps-local-model", installId, projectName: project, ...selection,
    containerId, networkId, modelId, approvedModelDigest: budget.approvedModelDigest,
    hostResources, runtimeImageId: `sha256:${"e".repeat(64)}`,
    helperImageId: `sha256:${"f".repeat(64)}`, operationId, modelDigest: null,
    files: Object.fromEntries(["Dockerfile.acquisition", ".dockerignore", "catalog.mjs", "acquisition.mjs", "compose.yaml"]
      .map(name => [name, createHash("sha256").update(name).digest("hex")])) };
  const labels = service => ({ "io.relmio.managed": "true", "io.relmio.target": "n8n-local-model",
    "io.relmio.install": installId, "com.docker.compose.project": project, "com.docker.compose.service": service });
  const network = aliases => ({ [selection.networkName]: { NetworkID: networkId, Aliases: aliases } });
  const baseHost = (memory, nanoCpus) => ({ PortBindings: {}, NetworkMode: selection.networkName, Privileged: false,
    ReadonlyRootfs: true, CapDrop: ["ALL"], SecurityOpt: ["no-new-privileges:true"],
    RestartPolicy: { Name: "no" }, Memory: memory, MemorySwap: memory, NanoCpus: nanoCpus });
  const runtime = { Id: "1".repeat(64), Name: `/${names.container}`, Image: marker.runtimeImageId,
    Config: { Labels: labels("local-model"), Image: LOCAL_MODEL_RUNTIME_IMAGE,
      Env: ["OLLAMA_NO_CLOUD=1", "OLLAMA_NOPRUNE=1", "OLLAMA_NUM_PARALLEL=1", `OLLAMA_CONTEXT_LENGTH=${budget.contextTokens}`] },
    HostConfig: baseHost(budget.memoryBytes, Math.round(budget.cpus * 1e9)), State: { Running: true, Health: { Status: "healthy" } },
    NetworkSettings: { Networks: network(["n8n-local-model"]), Ports: { "11434/tcp": null } },
    Mounts: [{ Type: "volume", Name: names.volume, Destination: "/root/.ollama", RW: true }] };
  const helper = { Id: "2".repeat(64), Name: `/${names.operation}`, Image: marker.helperImageId,
    Config: { Labels: { ...labels("acquisition"), "io.relmio.operation": operationId },
      Image: marker.helperImageId, Cmd: [modelId, operationId] },
    HostConfig: baseHost(268435456, 500000000), State: { Running: phase === "downloading", ExitCode: phase === "model-ready" ? 0 : 1 },
    NetworkSettings: { Networks: network([]), Ports: {} }, Mounts: [] };
  const volume = { Name: names.volume, Labels: foreignVolume ? { ...labels("model-cache"), "io.relmio.install": "different" } : labels("model-cache") };
  const digest = foreignDigest ? `sha256:${"3".repeat(64)}` : marker.approvedModelDigest;
  const record = JSON.stringify({ schema: 1, operationId, modelId, state: phase,
    phase: phase === "model-ready" ? "complete" : phase === "model-error" ? "error" : "download",
    completedBytes: phase === "model-ready" ? 523000000 : 23000,
    totalBytes: 523000000, blobDigest: null,
    modelDigest: ["model-ready", "model-error"].includes(phase) ? digest : null,
    inferenceVerified: phase === "model-ready", errorCode: phase === "model-error" ? "inference-failed" : null,
    writerMayBeActive: phase === "downloading",
    updatedAt: "2026-09-26T12:00:00.000Z" });
  const remote = { calls, async exec(command) {
    calls.push(command);
    if (command === "[ -d /docker ] && [ ! -L /docker ] && stat -c %u:%a /docker") return { code: 0, stdout: "0:755" };
    if (command.includes("printf absent")) return { code: 0, stdout: JSON.stringify(marker) };
    if (command.includes("stat -c '%d:%i' /docker/n8n-openai-oauth/local-model")) return { code: 0, stdout: "22:33" };
    if (command.includes("sha256sum /docker/n8n-openai-oauth/local-model/.managed-by-relmio.json | cut")) {
      return { code: 0, stdout: createHash("sha256").update(JSON.stringify(marker)).digest("hex") };
    }
    if (command.includes("find /docker/n8n-openai-oauth/local-model")) return { code: 0, stdout: `${Object.keys(marker.files).join("\n")}\n.managed-by-relmio.json` };
    if (command.startsWith("docker container inspect ")) {
      const resource = command.includes(names.container) ? runtime : helper;
      return { code: 0, stdout: JSON.stringify([resource]) };
    }
    if (command.startsWith("docker volume inspect ")) return { code: 0, stdout: JSON.stringify([volume]) };
    if (command.startsWith("docker image inspect ")) return { code: 0, stdout: JSON.stringify({
      Id: marker.helperImageId, Config: { Labels: { "io.relmio.managed": "true",
        "io.relmio.target": "n8n-local-model", "io.relmio.install": foreignImage ? "other-owner" : marker.installId } },
    }) };
    if (command.startsWith("docker ps -a --filter label=")) return { code: 0, stdout: `${names.container}\n${names.operation}` };
    if (command.startsWith("docker volume ls --filter label=")) return { code: 0, stdout: names.volume };
    if (command.startsWith("docker logs --tail 12 ")) return { code: 0, stdout: record };
    if (command.startsWith("docker inspect n8n-fixture")) return n8nMissing ? { code: 1, stdout: "" } :
      { code: 0, stdout: `${JSON.stringify(containerId)}|true|${JSON.stringify(network(null))}` };
    if (command.startsWith("docker network inspect private-net")) return { code: 0, stdout: JSON.stringify({
      Name: selection.networkName, Id: networkId, Driver: "bridge", Scope: "local", Internal: false, Containers: {} }) };
    if (command.includes(".local-model-operation.lock") && command.includes("mkdir")) return { code: 0, stdout: "22:33" };
    if (command.includes("BUILDX_CONFIG=") || command.includes("state_guard()")) return { code: 0, stdout: "" };
    if (command.startsWith("docker rm -f ") || command.startsWith("docker volume rm ") ||
        command.startsWith("docker image rm ") || command.startsWith("rm -f -- ") ||
        command.includes("rmdir /docker/n8n-openai-oauth/.local-model-operation.lock") ||
        command.startsWith("[ ! -L ")) return { code: 0, stdout: "" };
    throw new Error(`Unexpected remote command: ${command}`);
  } };
  return { remote, marker, names, digest, runtime, helper, volume, record };
}

test("VPS model readiness requires completed inference, not just a healthy listed runtime", async () => {
  const ready = installedFixture();
  const status = await getVpsLocalModelOperationStatus({ remote: ready.remote, installId: ready.marker.installId });
  assert.equal(status.state, "model-ready");
  assert.equal(status.operation.modelDigest, ready.digest);
  assert.equal(status.operation.completedBytes, 523000000);
  const changed = installedFixture({ foreignDigest: true });
  await assert.rejects(() => getVpsLocalModelOperationStatus({ remote: changed.remote, installId: changed.marker.installId }));
  const failedChanged = installedFixture({ phase: "model-error", foreignDigest: true });
  await assert.rejects(() => reviewVpsLocalModel({ remote: failedChanged.remote, ...selection, action: "retry" }));
  const pending = installedFixture({ phase: "downloading" });
  const downloading = await inspectVpsLocalModel({ remote: pending.remote, ...selection });
  assert.equal(downloading.state, "downloading");
  assert.equal(downloading.operation.completedBytes, 23000);
  await assert.rejects(() => reviewVpsLocalModel({ remote: pending.remote, ...selection, action: "retry" }));
  const justStarted = installedFixture({ phase: "downloading" });
  const original = justStarted.remote.exec;
  justStarted.remote.exec = command => command.startsWith("docker logs --tail 12 ")
    ? Promise.resolve({ code: 0, stdout: "" })
    : original(command);
  assert.equal((await getVpsLocalModelOperationStatus({
    remote: justStarted.remote, installId: justStarted.marker.installId,
  })).state, "downloading");
  const uncertain = installedFixture({ phase: "downloading" });
  const validExec = uncertain.remote.exec;
  uncertain.remote.exec = command => command.startsWith("docker logs --tail 12 ")
    ? Promise.resolve({ code: 0, stdout: "{\"state\":\"ready\"}\n" })
    : validExec(command);
  const unknown = await getVpsLocalModelOperationStatus({ remote: uncertain.remote, installId: uncertain.marker.installId });
  assert.equal(unknown.state, "partial");
  assert.equal(unknown.operation.writerMayBeActive, true);
  await assert.rejects(() => reviewVpsLocalModel({ remote: uncertain.remote, ...selection, action: "retry" }));
  const stillWriting = installedFixture({ phase: "model-error" });
  stillWriting.helper.State.Running = true;
  assert.equal((await getVpsLocalModelOperationStatus({
    remote: stillWriting.remote, installId: stillWriting.marker.installId,
  })).state, "partial");
  await assert.rejects(() => reviewVpsLocalModel({ remote: stillWriting.remote, ...selection, action: "retry" }));
  const foreign = installedFixture({ foreignVolume: true });
  await assert.rejects(() => getVpsLocalModelOperationStatus({ remote: foreign.remote, installId: foreign.marker.installId }));
});

test("effective runtime and helper CPU/swap limits must match the reviewed budgets", async () => {
  for (const [resource, field, changed] of [
    ["runtime", "NanoCpus", 9_000_000_000], ["runtime", "MemorySwap", 0],
    ["helper", "NanoCpus", 2_000_000_000], ["helper", "MemorySwap", 0],
  ]) {
    const fixture = installedFixture();
    fixture[resource].HostConfig[field] = changed;
    await assert.rejects(() => getVpsLocalModelOperationStatus({
      remote: fixture.remote, installId: fixture.marker.installId,
    }));
  }
});

test("VPS model status accepts Docker's enabled security-option forms for both owned containers", async () => {
  for (const resource of ["runtime", "helper"]) {
    for (const securityOpt of ["no-new-privileges", "no-new-privileges:true", "no-new-privileges=true"]) {
      const fixture = installedFixture();
      fixture[resource].HostConfig.SecurityOpt = [securityOpt];
      const inspected = await inspectVpsLocalModel({ remote: fixture.remote, ...selection });
      assert.equal(inspected.state, "model-ready", `${resource}: ${securityOpt}`);
      assert.equal(inspected.operation.modelDigest, fixture.digest);
    }
  }
});

test("VPS model status rejects absent, disabled, conflicting and malformed security options", async () => {
  const unsafe = [
    [],
    ["no-new-privileges:false"],
    ["no-new-privileges=false"],
    ["no-new-privileges", "no-new-privileges:false"],
    ["no-new-privileges:false", "no-new-privileges"],
    ["no-new-privileges:true", "no-new-privileges=false"],
    ["no-new-privileges=false", "no-new-privileges:true"],
    ["no-new-privileges=true", "no-new-privileges=false"],
    ["no-new-privileges=false", "no-new-privileges=true"],
    ["no-new-privileges:maybe"],
    ["no-new-privileges:true:extra"],
    ["no-new-privileges", "no-new-privileges:maybe"],
    ["no-new-privileges:maybe", "no-new-privileges"],
    "no-new-privileges:true",
  ];
  for (const resource of ["runtime", "helper"]) {
    for (const securityOpt of unsafe) {
      const fixture = installedFixture();
      fixture[resource].HostConfig.SecurityOpt = securityOpt;
      await assert.rejects(() => getVpsLocalModelOperationStatus({
        remote: fixture.remote, installId: fixture.marker.installId,
      }), `${resource}: ${JSON.stringify(securityOpt)}`);
    }
  }
});

test("reviewed cache deletion removes only attested model resources when n8n is gone", async () => {
  const { remote, names } = installedFixture({ n8nMissing: true });
  const plan = await reviewVpsLocalModel({ remote, ...selection, action: "remove", clearModelCache: true });
  assert.equal(plan.clearModelCache, true);
  const reviewedCommands = remote.calls.length;
  assert.ok(remote.calls.every(command => !command.startsWith("docker rm -f ")));
  const result = await changeVpsLocalModel({ remote, plan, confirmed: true });
  assert.deepEqual(result, { state: "absent", removed: true, modelCacheDeleted: true });
  const removal = remote.calls.slice(reviewedCommands);
  assert.deepEqual(removal.filter(command => command.startsWith("docker rm -f ")),
    [`docker rm -f ${"1".repeat(64)}`, `docker rm -f ${"2".repeat(64)}`]);
  assert.ok(removal.includes(`docker volume rm ${names.volume}`));
  assert.ok(removal.includes(`docker image rm ${names.helperImage}`));
  assert.ok(removal.every(command => !command.includes(`docker stop ${containerId}`) && !command.includes(`docker rm -f ${containerId}`)));
});

test("a retagged foreign image blocks cache deletion before any owned resource is removed", async () => {
  const { remote } = installedFixture({ foreignImage: true });
  const plan = await reviewVpsLocalModel({ remote, ...selection, action: "remove", clearModelCache: true });
  const before = remote.calls.length;
  await assert.rejects(() => changeVpsLocalModel({ remote, plan, confirmed: true }));
  const attempted = remote.calls.slice(before);
  assert.ok(attempted.every(command => !command.startsWith("docker rm ") && !command.startsWith("docker volume rm ")));
});

test("confirmed install creates only the owned private runtime, cache and detached acquisition", async () => {
  const prior = installedFixture({ phase: "downloading" });
  const remote = remoteFixture();
  const initial = remote.exec;
  const uploads = [];
  let marker = null;
  let pendingMarker = null;
  let runtimeCreated = false;
  let operationCreated = false;
  let helperImageBuilt = false;
  remote.upload = async (path, contents, mode) => {
    uploads.push({ path, contents, mode });
    if (path.endsWith("/.managed-by-relmio.json.next")) pendingMarker = JSON.parse(contents);
  };
  remote.exec = async command => {
    if (command.startsWith("if [ -e /docker/n8n-openai-oauth ]")) {
      remote.calls.push(command);
      return { code: 0, stdout: "managed" };
    }
    if (command.includes("printf absent")) {
      remote.calls.push(command);
      return { code: 0, stdout: marker ? JSON.stringify(marker) : "absent" };
    }
    if (command.includes("mv -T -- /docker/n8n-openai-oauth/local-model/.managed-by-relmio.json.next")) {
      remote.calls.push(command);
      marker = pendingMarker;
      pendingMarker = null;
      return { code: 0, stdout: "" };
    }
    if (command.includes("stat -c '%d:%i' /docker/n8n-openai-oauth/local-model")) {
      remote.calls.push(command);
      return { code: 0, stdout: "22:33" };
    }
    if (command.includes("sha256sum /docker/n8n-openai-oauth/local-model/.managed-by-relmio.json | cut")) {
      return { code: 0, stdout: createHash("sha256").update(JSON.stringify(marker)).digest("hex") };
    }
    if (command.includes("find /docker/n8n-openai-oauth/local-model")) {
      remote.calls.push(command);
      return { code: 0, stdout: [...Object.keys(prior.marker.files), ".managed-by-relmio.json"].join("\n") };
    }
    if (command.startsWith("docker container inspect ")) {
      remote.calls.push(command);
      if (command.includes(prior.names.container) && runtimeCreated) return { code: 0, stdout: JSON.stringify([prior.runtime]) };
      if (command.includes(prior.names.operation) && operationCreated) return { code: 0, stdout: JSON.stringify([prior.helper]) };
      return { code: 1, stdout: "" };
    }
    if (command.startsWith("docker volume inspect ")) {
      remote.calls.push(command);
      return runtimeCreated ? { code: 0, stdout: JSON.stringify([prior.volume]) } : { code: 1, stdout: "" };
    }
    if (command.startsWith("docker ps -a --filter label=")) {
      remote.calls.push(command);
      return { code: 0, stdout: [runtimeCreated && prior.names.container, operationCreated && prior.names.operation].filter(Boolean).join("\n") };
    }
    if (command.startsWith("docker volume ls --filter label=")) {
      remote.calls.push(command);
      return { code: 0, stdout: runtimeCreated ? prior.names.volume : "" };
    }
    if (command.startsWith("docker ps -a --format ") || command.startsWith("docker volume ls --format ")) {
      remote.calls.push(command);
      return { code: 0, stdout: "" };
    }
    if (command.startsWith("docker image inspect ")) {
      remote.calls.push(command);
      return helperImageBuilt ? { code: 0, stdout: JSON.stringify({ Id: prior.marker.helperImageId, Config: { Labels: {
        "io.relmio.managed": "true", "io.relmio.install": prior.marker.installId,
        "io.relmio.target": "n8n-local-model" } } }) }
        : { code: 1, stdout: "" };
    }
    if (command.startsWith("docker image ls --format ")) return { code: 0, stdout: "" };
    if (command.includes(" --profile acquisition build ")) helperImageBuilt = true;
    if (command.startsWith("docker run -d ")) {
      operationCreated = true;
      remote.calls.push(command);
      return { code: 0, stdout: prior.helper.Id };
    }
    if (command.includes(" up -d --wait ")) runtimeCreated = true;
    if (command.startsWith("docker logs --tail 12 ")) return { code: 0, stdout: prior.record };
    if (command.includes(".local-model-operation.lock") && command.includes("mkdir")) return { code: 0, stdout: "22:33" };
    if (command.includes("BUILDX_CONFIG=") || command.includes("state_guard()")) {
      remote.calls.push(command);
      return { code: 0, stdout: "" };
    }
    if (command.startsWith("docker compose ") || command.startsWith("[ ! -L ") ||
        command.includes("rmdir /docker/n8n-openai-oauth/.local-model-operation.lock") ||
        command.includes("umask 077 && mkdir /docker/n8n-openai-oauth/local-model") ||
        command.includes("mkdir -m 0755 /docker/n8n-openai-oauth")) {
      remote.calls.push(command);
      return { code: 0, stdout: "" };
    }
    return initial(command);
  };
  const plan = await reviewVpsLocalModel({ remote, ...selection, action: "install", modelId: "qwen3:0.6b" });
  const result = await installVpsLocalModel({ remote, plan, confirmed: true }, {
    entropy: count => Buffer.alloc(count, uploads.length ? 0xdd : 0xcc),
  });
  assert.equal(result.state, "downloading");
  assert.equal(result.installId, prior.marker.installId);
  assert.equal(result.containerId, containerId);
  const rootWrite = remote.calls.find(command => command.includes("mkdir -m 0755 /docker/n8n-openai-oauth"));
  assert.ok(rootWrite);
  assert.doesNotMatch(rootWrite, /install -d -m 0755/u);
  assert.ok(rootWrite.includes("stat -c %u /docker/n8n-openai-oauth"));
  assert.equal(result.networkId, networkId);
  assert.deepEqual(new Set(uploads.map(item => item.path.split("/").at(-1))), new Set([
    ".managed-by-relmio.json.next", "Dockerfile.acquisition", ".dockerignore", "catalog.mjs", "acquisition.mjs", "compose.yaml",
  ]));
  assert.ok(uploads.every(item => item.path.startsWith("/docker/n8n-openai-oauth/local-model/") && item.mode === 0o600));
  const compose = uploads.find(item => item.path.endsWith("/compose.yaml")).contents;
  assert.ok(compose.includes('name: "private-net"'));
  assert.ok(compose.includes('OLLAMA_NO_CLOUD: "1"'));
  assert.ok(compose.includes('OLLAMA_NOPRUNE: "1"'));
  assert.doesNotMatch(compose, /^\s*ports:/mu);
  assert.ok(remote.calls.some(command => command.startsWith(`docker run -d --name ${prior.names.operation} --network ${networkId} `) &&
    command.includes(` ${prior.marker.helperImageId} qwen3:0.6b `)));
  assert.ok(remote.calls.every(command => !/docker (?:stop|restart|rm) n8n-fixture|docker compose .*n8n-fixture/u.test(command)));
});

function retryFixture({ phase = "model-error", helperMissing = false, runtimeStopped = false, runtimeMissing = false,
  imageRetag = false, swapRuntimeName = false, diskAvailableBytes = 50 * gib, interruptMarker = false } = {}) {
  const installed = installedFixture({ phase, foreignImage: imageRetag });
  const { remote, marker, names, runtime, helper } = installed;
  runtime.State.Running = !runtimeStopped;
  const measured = remoteFixture({ diskAvailableBytes });
  const original = remote.exec;
  let replacement = null;
  let pendingMarker = null;
  let helperPresent = !helperMissing;
  let swapped = false;
  let runtimePresent = !runtimeMissing;
  let tempLeft = false;
  remote.upload = async (path, contents, mode) => {
    assert.equal(path, "/docker/n8n-openai-oauth/local-model/.managed-by-relmio.json.next");
    assert.equal(mode, 0o600);
    pendingMarker = JSON.parse(contents);
    tempLeft = true;
    if (interruptMarker) throw new Error("SFTP upload interrupted");
  };
  remote.exec = async command => {
    if (command.startsWith("docker info ") || command.startsWith("df -B1 ") || command.startsWith("sed -n ")) {
      return measured.exec(command);
    }
    if (tempLeft && command.includes("find /docker/n8n-openai-oauth/local-model")) {
      remote.calls.push(command);
      return { code: 0, stdout: `${Object.keys(marker.files).join("\n")}\n.managed-by-relmio.json\n.managed-by-relmio.json.next` };
    }
    if (command.startsWith("docker container inspect ")) {
      const value = command.split(" ").at(-1);
      if (value === runtime.Id || value === names.container) {
        remote.calls.push(command);
        const selected = value === names.container && swapped ? { ...runtime, Id: "3".repeat(64) } : runtime;
        return runtimePresent ? { code: 0, stdout: JSON.stringify([selected]) } : { code: 1, stdout: "" };
      }
      if (value === helper.Id || value === names.operation) {
        remote.calls.push(command);
        return helperPresent ? { code: 0, stdout: JSON.stringify([helper]) } : { code: 1, stdout: "" };
      }
    }
    if (command.startsWith("docker ps -a --format ")) return { code: 0, stdout: "" };
    if (command.startsWith("docker stop -t 20 ")) {
      remote.calls.push(command);
      runtime.State.Running = false;
      swapped = swapRuntimeName;
      return { code: 0, stdout: names.container };
    }
    if (command.startsWith(`docker rm ${helper.Id}`) || command.startsWith(`docker rm -f ${helper.Id}`)) {
      remote.calls.push(command);
      helperPresent = false;
      return { code: 0, stdout: names.operation };
    }
    if (command.startsWith("docker start " + runtime.Id)) {
      remote.calls.push(command);
      runtime.State.Running = true;
      return { code: 0, stdout: names.container };
    }
    if (command.startsWith("for i in 1 2 3 ")) {
      remote.calls.push(command);
      return { code: 0, stdout: "" };
    }
    if (command.includes(" up -d --wait --wait-timeout 90 ")) {
      remote.calls.push(command);
      runtimePresent = true;
      return { code: 0, stdout: "" };
    }
    if (command.startsWith("docker run -d ")) {
      remote.calls.push(command);
      replacement = "9".repeat(32);
      helper.Config.Labels["io.relmio.operation"] = replacement;
      helper.Config.Cmd = [marker.modelId, replacement, ...(marker.modelDigest ? [marker.modelDigest] : [])];
      helper.State.Running = true;
      helperPresent = true;
      return { code: 0, stdout: helper.Id };
    }
    if (replacement && command.startsWith("docker logs --tail 12 ")) {
      remote.calls.push(command);
      return { code: 0, stdout: JSON.stringify({ ...JSON.parse(installed.record), operationId: replacement,
        state: "downloading", phase: "download", modelDigest: null, errorCode: null, writerMayBeActive: true }) };
    }
    if (command.includes("mv -T -- /docker/n8n-openai-oauth/local-model/.managed-by-relmio.json.next")) {
      remote.calls.push(command);
      Object.assign(marker, pendingMarker);
      pendingMarker = null;
      tempLeft = false;
      return { code: 0, stdout: "" };
    }
    return original(command);
  };
  return { ...installed, get replacement() { return replacement; } };
}

test("retry of a failed inference shuts down only the owned writer and binds its installed digest", async () => {
  const installed = retryFixture();
  const { remote, marker, runtime, helper, digest } = installed;
  const plan = await reviewVpsLocalModel({ remote, ...selection, action: "retry" });
  const before = remote.calls.length;
  const result = await changeVpsLocalModel({ remote, plan, confirmed: true }, {
    entropy: count => Buffer.alloc(count, 0x99),
  });
  assert.equal(result.state, "downloading");
  assert.equal(marker.modelDigest, digest);
  const commands = remote.calls.slice(before);
  assert.ok(commands.indexOf(`docker stop -t 20 ${runtime.Id}`) < commands.indexOf(`docker rm ${helper.Id}`));
  assert.ok(commands.some(command => command.includes(`${marker.helperImageId} qwen3:0.6b ${installed.replacement} ${digest}`)));
  assert.ok(commands.every(command => !command.includes(`docker stop ${containerId}`) && !command.includes(`docker rm ${containerId}`)));
});

test("a crashed helper launch with an existing operation ID can retry without deleting model cache", async () => {
  const installed = retryFixture({ phase: "downloading", helperMissing: true });
  const oldOperation = installed.marker.operationId;
  const plan = await reviewVpsLocalModel({ remote: installed.remote, ...selection, action: "retry" });
  const result = await changeVpsLocalModel({ remote: installed.remote, plan, confirmed: true }, {
    entropy: count => Buffer.alloc(count, 0x99),
  });
  assert.equal(result.state, "downloading");
  assert.notEqual(installed.marker.operationId, oldOperation);
  assert.equal(installed.marker.modelDigest, null);
  assert.ok(installed.remote.calls.some(command => command === `docker stop -t 20 ${installed.runtime.Id}`));
  assert.ok(installed.remote.calls.some(command => command === `docker start ${installed.runtime.Id}`));
  assert.ok(installed.remote.calls.every(command => !command.startsWith("docker volume rm ")));
});

test("retry restores a missing owned runtime after an interrupted acquisition without discarding cache", async () => {
  const installed = retryFixture({ phase: "downloading", helperMissing: true, runtimeMissing: true });
  const plan = await reviewVpsLocalModel({ remote: installed.remote, ...selection, action: "retry" });
  const result = await changeVpsLocalModel({ remote: installed.remote, plan, confirmed: true }, {
    entropy: count => Buffer.alloc(count, 0x99),
  });
  assert.equal(result.state, "downloading");
  assert.ok(installed.remote.calls.some(command => command.includes(" up -d --wait --wait-timeout 90 ") &&
    command.endsWith("--no-deps local-model")));
  assert.ok(installed.remote.calls.every(command => !command.startsWith("docker volume rm ") &&
    !command.startsWith("docker stop n8n-fixture")));
});

test("retry shuts down a running acquisition by immutable ID when the owned runtime is stopped", async () => {
  const installed = retryFixture({ phase: "downloading", runtimeStopped: true });
  const plan = await reviewVpsLocalModel({ remote: installed.remote, ...selection, action: "retry" });
  const result = await changeVpsLocalModel({ remote: installed.remote, plan, confirmed: true }, {
    entropy: count => Buffer.alloc(count, 0x99),
  });
  assert.equal(result.state, "downloading");
  assert.ok(installed.remote.calls.some(command => command === `docker rm -f ${installed.helper.Id}`));
  assert.ok(installed.remote.calls.some(command => command === `docker start ${installed.runtime.Id}`));
  assert.ok(installed.remote.calls.every(command => !command.startsWith("docker stop -t 20 ")));
});

test("retry refuses a retagged acquisition image before stopping the model runtime", async () => {
  const installed = retryFixture({ imageRetag: true });
  const plan = await reviewVpsLocalModel({ remote: installed.remote, ...selection, action: "retry" });
  const before = installed.remote.calls.length;
  await assert.rejects(() => changeVpsLocalModel({ remote: installed.remote, plan, confirmed: true }));
  assert.ok(installed.remote.calls.slice(before).every(command => !command.startsWith("docker stop ") &&
    !command.startsWith("docker rm ") && !command.startsWith("docker run ")));
});

test("retry refuses a swapped runtime name rather than starting an unreviewed container", async () => {
  const installed = retryFixture({ swapRuntimeName: true });
  const plan = await reviewVpsLocalModel({ remote: installed.remote, ...selection, action: "retry" });
  const before = installed.remote.calls.length;
  await assert.rejects(() => changeVpsLocalModel({ remote: installed.remote, plan, confirmed: true }));
  const calls = installed.remote.calls.slice(before);
  assert.ok(calls.includes(`docker stop -t 20 ${installed.runtime.Id}`));
  assert.ok(calls.every(command => !command.startsWith("docker start ") && !command.startsWith("docker run ")));
});

test("attested cached inference retries do not require the cold download disk reserve", async () => {
  const cached = retryFixture({ diskAvailableBytes: 2 * gib });
  const plan = await reviewVpsLocalModel({ remote: cached.remote, ...selection, action: "retry" });
  const result = await changeVpsLocalModel({ remote: cached.remote, plan, confirmed: true }, {
    entropy: count => Buffer.alloc(count, 0x99),
  });
  assert.equal(result.state, "downloading");
  assert.equal(cached.marker.modelDigest, cached.digest);
  const cold = retryFixture({ phase: "downloading", helperMissing: true, diskAvailableBytes: 2 * gib });
  await assert.rejects(() => reviewVpsLocalModel({ remote: cold.remote, ...selection, action: "retry" }), /insufficient/u);
  assert.ok(cold.remote.calls.every(command => !command.startsWith("docker stop ") && !command.startsWith("docker run ")));
});

test("an interrupted checkpoint upload preserves the last valid marker for an explicit retry", async () => {
  const installed = retryFixture({ interruptMarker: true });
  const previousOperation = installed.marker.operationId;
  const plan = await reviewVpsLocalModel({ remote: installed.remote, ...selection, action: "retry" });
  const before = installed.remote.calls.length;
  await assert.rejects(() => changeVpsLocalModel({ remote: installed.remote, plan, confirmed: true }),
    /SFTP upload interrupted/u);
  assert.equal(installed.marker.operationId, previousOperation);
  assert.equal(installed.marker.modelDigest, null);
  assert.ok(installed.remote.calls.slice(before).every(command => !command.includes("mv -T --")));
  const status = await getVpsLocalModelOperationStatus({ remote: installed.remote, installId: installed.marker.installId });
  assert.equal(status.state, "partial");
});

const shellExec = promisify(execFile);
const checkpointPath = "/docker/n8n-openai-oauth/local-model/.managed-by-relmio.json.next";
const checkpointStat = `const fs=require('node:fs'); const a=process.argv.slice(1); const s=fs.lstatSync(a.at(-1)); const v={u:0,a:(s.mode&4095).toString(8),h:s.nlink,s:s.size,d:s.dev,i:s.ino}; process.stdout.write(a[1].replace(/%([uahsdi])/g,(_,k)=>v[k])+'\\n');`;
const shellQuote = value => `'${value.replaceAll("'", "'\\''")}'`;

async function checkpointFixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "relmio-checkpoint-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const docker = join(directory, "docker");
  const root = join(docker, "n8n-openai-oauth", "local-model");
  await mkdir(root, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  const checkpoint = join(root, ".managed-by-relmio.json.next");
  const markerFile = join(root, ".managed-by-relmio.json");
  const sentinel = join(directory, "outside-sentinel");
  await writeFile(sentinel, "outside data", { mode: 0o600 });
  const installed = retryFixture();
  await writeFile(markerFile, JSON.stringify(installed.marker), { mode: 0o600 });
  const original = installed.remote.exec;
  let uploadCalls = 0;
  let publishCalls = 0;
  const execute = async command => {
    const script = `stat() { ${shellQuote(process.execPath)} -e ${shellQuote(checkpointStat)} -- "$@"; }\nsha256sum() { shasum -a 256 "$@"; }\nmv() { [ "$1" = -T ] && shift; [ "$1" = -- ] && shift; command mv "$@"; }\n` +
      command.replaceAll("/docker", docker);
    try {
      const result = await shellExec("/bin/sh", ["-c", script]);
      return { code: 0, stdout: result.stdout };
    } catch (error) {
      return { code: typeof error.code === "number" ? error.code : 99, stdout: error.stdout ?? "" };
    }
  };
  installed.remote.exec = async command => {
    if (command.startsWith(`[ ! -L ${checkpointPath} ]`)) {
      installed.remote.calls.push(command);
      return execute(command);
    }
    if (command.includes(`mv -T -- ${checkpointPath}`)) {
      publishCalls += 1;
      installed.remote.calls.push(command);
      return execute(command);
    }
    if (command.includes("sha256sum /docker/n8n-openai-oauth/local-model/.managed-by-relmio.json | cut")) {
      installed.remote.calls.push(command);
      return execute(command);
    }
    if (command.includes("stat -c '%d:%i' /docker/n8n-openai-oauth/local-model")) {
      installed.remote.calls.push(command);
      return { code: 0, stdout: (await execute(`stat -c '%d:%i' ${checkpointPath.slice(0, -"/.managed-by-relmio.json.next".length)}`)).stdout };
    }
    return original(command);
  };
  installed.remote.upload = async (_path, contents) => {
    uploadCalls += 1;
    await writeFile(checkpoint, contents, { mode: 0o600 });
  };
  return { ...installed, checkpoint, sentinel, markerFile,
    get uploadCalls() { return uploadCalls; }, get publishCalls() { return publishCalls; } };
}

test("review rejects a hard-linked or symlinked checkpoint without changing the outside sentinel", { skip: process.platform === "win32" }, async t => {
  for (const kind of ["hardlink", "symlink"]) {
    const f = await checkpointFixture(t);
    if (kind === "hardlink") await link(f.sentinel, f.checkpoint);
    else await symlink(f.sentinel, f.checkpoint);
    const oldMarker = await readFile(f.markerFile, "utf8");
    await assert.rejects(() => reviewVpsLocalModel({ remote: f.remote, ...selection, action: "retry" }));
    assert.equal(await readFile(f.sentinel, "utf8"), "outside data");
    assert.equal(await readFile(f.markerFile, "utf8"), oldMarker);
    assert.equal(f.uploadCalls, 0);
    assert.ok(f.remote.calls.every(command => !command.includes("docker stop -t 20 ")));
  }
});

test("a checkpoint hard-linked between attestation and upload is rejected before upload", { skip: process.platform === "win32" }, async t => {
  const f = await checkpointFixture(t);
  const plan = await reviewVpsLocalModel({ remote: f.remote, ...selection, action: "retry" });
  const oldMarker = await readFile(f.markerFile, "utf8");
  const original = f.remote.exec;
  let linked = false;
  f.remote.exec = async command => {
    if (!linked && command.includes("stat -c '%d:%i' /docker/n8n-openai-oauth/local-model")) {
      await link(f.sentinel, f.checkpoint);
      linked = true;
    }
    return original(command);
  };
  await assert.rejects(() => changeVpsLocalModel({ remote: f.remote, plan, confirmed: true }));
  assert.equal(linked, true);
  assert.equal(f.uploadCalls, 0);
  assert.equal(f.publishCalls, 0);
  assert.equal(await readFile(f.sentinel, "utf8"), "outside data");
  assert.equal(await readFile(f.markerFile, "utf8"), oldMarker);
});

test("a checkpoint linked outside after upload is rejected before marker publication", { skip: process.platform === "win32" }, async t => {
  const f = await checkpointFixture(t);
  const plan = await reviewVpsLocalModel({ remote: f.remote, ...selection, action: "retry" });
  const oldMarker = await readFile(f.markerFile, "utf8");
  f.remote.upload = async (_path, contents) => {
    await writeFile(f.checkpoint, contents, { mode: 0o600 });
    await rm(f.sentinel);
    await link(f.checkpoint, f.sentinel);
  };
  await assert.rejects(() => changeVpsLocalModel({ remote: f.remote, plan, confirmed: true }));
  assert.equal(f.publishCalls, 1);
  assert.equal(await readFile(f.markerFile, "utf8"), oldMarker);
  assert.notEqual(await readFile(f.sentinel, "utf8"), oldMarker);
});

test("failed runtime bootstrap can be explicitly reviewed for retry without discarding cache", async () => {
  const installed = installedFixture({ phase: "downloading" });
  const measured = remoteFixture();
  installed.marker.runtimeImageId = null;
  installed.marker.helperImageId = null;
  installed.marker.operationId = null;
  const original = installed.remote.exec;
  let helperImageBuilt = false;
  let runtimeCreated = false;
  let operationCreated = false;
  let pendingMarker = null;
  installed.remote.upload = async (path, contents, mode) => {
    assert.equal(path, "/docker/n8n-openai-oauth/local-model/.managed-by-relmio.json.next");
    assert.equal(mode, 0o600);
    pendingMarker = JSON.parse(contents);
  };
  installed.remote.exec = command => {
    if (command.includes("mv -T -- /docker/n8n-openai-oauth/local-model/.managed-by-relmio.json.next")) {
      Object.assign(installed.marker, pendingMarker);
      pendingMarker = null;
      return Promise.resolve({ code: 0, stdout: "" });
    }
    if (command.startsWith("docker image inspect ")) return Promise.resolve(helperImageBuilt
      ? { code: 0, stdout: JSON.stringify({ Id: installed.helper.Image, Config: { Labels: {
        "io.relmio.managed": "true", "io.relmio.install": installed.marker.installId,
        "io.relmio.target": "n8n-local-model",
      } } }) }
      : { code: 1, stdout: "" });
    if (command.startsWith("docker image ls --format ")) return Promise.resolve({ code: 0, stdout: "" });
    if (command.includes(" --profile acquisition build ")) helperImageBuilt = true;
    if (command.includes(" up -d --wait ")) runtimeCreated = true;
    if (command.startsWith("docker run -d ")) {
      operationCreated = true;
      installed.remote.calls.push(command);
      return Promise.resolve({ code: 0, stdout: installed.helper.Id });
    }
    if (command.startsWith("docker container inspect ")) {
      const selected = command.includes(installed.names.container) ? installed.runtime : installed.helper;
      if (selected === installed.runtime ? !runtimeCreated : !operationCreated) {
        return Promise.resolve({ code: 1, stdout: "" });
      }
      return Promise.resolve({ code: 0, stdout: JSON.stringify([selected]) });
    }
    if (command.startsWith("docker volume inspect ")) return Promise.resolve(runtimeCreated
      ? { code: 0, stdout: JSON.stringify([installed.volume]) } : { code: 1, stdout: "" });
    if (command.startsWith("docker ps -a --format ") || command.startsWith("docker volume ls --format ")) {
      return Promise.resolve({ code: 0, stdout: "" });
    }
    if (command.startsWith("docker ps -a --filter label=")) return Promise.resolve({
      code: 0, stdout: [runtimeCreated && installed.names.container, operationCreated && installed.names.operation].filter(Boolean).join("\n"),
    });
    if (command.startsWith("docker volume ls --filter label=")) {
      return Promise.resolve({ code: 0, stdout: runtimeCreated ? installed.names.volume : "" });
    }
    if (command.startsWith("docker info ") || command.startsWith("df -B1 ") || command.startsWith("sed -n ")) {
      return measured.exec(command);
    }
    if (command.startsWith("docker compose ") || command.startsWith("for i in 1 2 3 ")) {
      installed.remote.calls.push(command);
      return Promise.resolve({ code: 0, stdout: "" });
    }
    return original(command);
  };
  const plan = await reviewVpsLocalModel({ remote: installed.remote, ...selection, action: "retry" });
  assert.equal(plan.modelId, "qwen3:0.6b");
  assert.equal(plan.installId, installed.marker.installId);
  assert.equal(plan.clearModelCache, false);
  assert.ok(installed.remote.calls.every(command => !command.includes(" up -d ") && !command.startsWith("docker rm")));
  const result = await changeVpsLocalModel({ remote: installed.remote, plan, confirmed: true }, {
    entropy: count => Buffer.alloc(count, 0xdd),
  });
  assert.equal(result.state, "downloading");
  assert.equal(installed.marker.runtimeImageId, installed.runtime.Image);
  assert.equal(installed.marker.helperImageId, installed.helper.Image);
  assert.ok(installed.remote.calls.some(command => command.includes(" --profile acquisition build ")));
  assert.ok(installed.remote.calls.some(command => command.includes(" up -d --wait ")));
  assert.ok(installed.remote.calls.every(command => !command.startsWith("docker volume rm ")));
});

test("an occupied helper image tag is rejected before a build could overwrite it", async () => {
  const remote = remoteFixture();
  const plan = await reviewVpsLocalModel({ remote, ...selection, action: "install", modelId: "qwen3:0.6b" });
  const original = remote.exec;
  let built = false;
  remote.upload = async () => {};
  remote.exec = async command => {
    if (command.startsWith("if [ -e /docker/n8n-openai-oauth ]")) return { code: 0, stdout: "managed" };
    if (command.includes(".local-model-operation.lock") && command.includes("mkdir")) return { code: 0, stdout: "22:33" };
    if (command.includes("mv -T -- /docker/n8n-openai-oauth/local-model/.managed-by-relmio.json.next")) {
      remote.calls.push(command);
      return { code: 0, stdout: "" };
    }
    if (command.includes("stat -c '%d:%i' /docker/n8n-openai-oauth/local-model")) {
      return { code: 0, stdout: "22:33" };
    }
    if (command.startsWith("docker container inspect ") || command.startsWith("docker volume inspect ")) return { code: 1, stdout: "" };
    if (command.startsWith("docker ps -a --format ") || command.startsWith("docker volume ls --format ") ||
        command.startsWith("docker ps -a --filter label=") || command.startsWith("docker volume ls --filter label=")) {
      return { code: 0, stdout: "" };
    }
    if (command.includes("find /docker/n8n-openai-oauth/local-model")) return { code: 0, stdout:
      "Dockerfile.acquisition\n.dockerignore\ncatalog.mjs\nacquisition.mjs\ncompose.yaml\n.managed-by-relmio.json" };
    if (command.startsWith("docker image inspect ")) {
      remote.calls.push(command);
      return { code: 0, stdout: JSON.stringify({
        Id: `sha256:${"f".repeat(64)}`, Config: { Labels: { "io.relmio.target": "foreign" } },
      }) };
    }
    if (command.includes(" --profile acquisition build ")) built = true;
    if (command.startsWith("docker compose ") || command.startsWith("[ ! -L ") ||
        command.includes("rmdir /docker/n8n-openai-oauth/.local-model-operation.lock") ||
        command.includes("umask 077 && mkdir /docker/n8n-openai-oauth/local-model") ||
        command.includes("mkdir -m 0755 /docker/n8n-openai-oauth")) return { code: 0, stdout: "" };
    return original(command);
  };
  await assert.rejects(() => installVpsLocalModel({ remote, plan, confirmed: true }, {
    entropy: count => Buffer.alloc(count, 0xcc),
  }));
  assert.equal(built, false);
  assert.ok(remote.calls.some(command => command.startsWith("docker image inspect relmio-n8n-local-model-acquisition-")));
});

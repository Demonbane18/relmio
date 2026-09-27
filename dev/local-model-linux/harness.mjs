#!/usr/bin/env node

import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, open, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runLocalProcess, validateLocalDockerHost } from "../../src/infrastructure/local-process.js";
import { discoverLocalN8nSidecarTargets } from "../../src/services/local-n8n-sidecar-installer.js";
import { createLocalN8nModelPlan } from "../../src/domain/local-n8n-model.js";
import { assertLocalModelNetworkEligibility } from "../../src/domain/local-model-network.js";
import {
  applyLocalN8nModelAction,
  getLocalN8nModelStatus,
  inspectLocalN8nModelResources,
  installLocalN8nModel,
  reviewLocalN8nModelAction,
} from "../../src/services/local-n8n-model-installer.js";
import { createCacheInventoryProgram, validatePartialInventory } from "./cache-inventory.mjs";

const directory = dirname(fileURLToPath(import.meta.url));
const checkout = await realpath(resolve(directory, "../.."));
const runtime = join(directory, ".runtime");
const home = join(runtime, "home");
const ownerPath = join(runtime, "owner.json");
const project = `relmio-model-acceptance-${digest(checkout).slice(0, 20)}`;
const image = "docker.io/n8nio/n8n:2.36.8@sha256:cfe2704ff858395503d42548206c2c99ea351a205e941063a9d9b77b0f404478";
const model = "qwen3:0.6b";
const containerName = `${project}-n8n-1`;
const networkName = `${project}_model`;
const volumeName = `${project}_n8n-data`;
const idPattern = /^[a-f0-9]{64}$/u;
const digestPattern = /^sha256:[a-f0-9]{64}$/u;
const commands = new Set(["preflight", "fixture", "review", "install", "install-midpull", "interrupt-pull", "status", "wait", "reconnect", "workflow", "fault", "retry", "remove-model", "teardown"]);

function digest(value) { return createHash("sha256").update(value).digest("hex"); }
function requireThat(condition, message) { if (!condition) throw new Error(message); }
function emit(event, data = {}) { process.stdout.write(`${JSON.stringify({ at: new Date().toISOString(), event, ...data })}\n`); }

// No environment variable or command-line flag is an approval channel.
export async function confirmTarget(action, target, { input = process.stdin, output = process.stdout } = {}) {
  requireThat(input.isTTY === true && output.isTTY === true,
    `Interactive confirmation required for ${action} ${target}. Nothing approved; hand off this exact command to a human terminal.`);
  const phrase = `${action} ${target}`;
  const reader = createInterface({ input, output });
  try {
    const answer = await reader.question(`Type exactly ${JSON.stringify(phrase)} to approve this target: `);
    requireThat(answer === phrase, "Confirmation did not match; nothing approved.");
  } finally { reader.close(); }
}

export async function preflight({ platform = process.platform, environment = process.env, runProcess = runLocalProcess } = {}) {
  requireThat(platform === "linux", "This acceptance harness requires a real Linux host. No Docker Desktop startup or macOS emulation is attempted.");
  for (const [key, value] of Object.entries(environment)) {
    requireThat(!value || (!/^(DOCKER_HOST|DOCKER_CONTEXT|DOCKER_CONFIG|DOCKER_TLS_VERIFY|DOCKER_CERT_PATH|BUILDKIT_HOST|RELMIO_HOME)$/iu.test(key) && !key.toUpperCase().startsWith("COMPOSE_")), "Unset Docker, Compose, and RELMIO_HOME overrides before acceptance.");
  }
  const context = await runProcess({ file: "docker", args: ["context", "inspect", "--format", "{{json .Endpoints.docker.Host}}"], cwd: directory, timeoutMs: 10_000 });
  requireThat(context.code === 0, "Cannot inspect the selected local Docker context.");
  const dockerHost = validateLocalDockerHost(JSON.parse(context.stdout.trim()), { platform: "linux" });
  requireThat(dockerHost.startsWith("unix://"), "Only a local Unix-socket Docker Engine is allowed.");
  const result = await runProcess({ file: "docker", args: ["info", "--format", "{{json .}}"], dockerHost, cwd: directory, timeoutMs: 10_000 });
  requireThat(result.code === 0, "Local Docker daemon is unreachable; start nothing automatically. Hand off to an approved Linux host.");
  const info = JSON.parse(result.stdout);
  requireThat(info.OSType === "linux" && info.ID, "A Linux Docker Engine identity is required.");
  const compose = await runProcess({ file: "docker", args: ["compose", "version", "--short"], dockerHost, cwd: directory, timeoutMs: 10_000 });
  const version = /^v?(\d+)\.(\d+)\.(\d+)/u.exec(compose.stdout.trim());
  requireThat(compose.code === 0 && version && (Number(version[1]) > 2 || (Number(version[1]) === 2 && Number(version[2]) >= 17)), "Docker Compose v2.17 or newer is required.");
  return { dockerHost, engineId: info.ID };
}

async function secureDirectory(path, create = false) {
  if (create) await mkdir(path, { mode: 0o700 }).catch(error => { if (error.code !== "EEXIST") throw error; });
  const entry = await lstat(path);
  requireThat(entry.isDirectory() && !entry.isSymbolicLink() && (entry.mode & 0o077) === 0 && entry.uid === process.getuid(), "Harness directory must be an owner-only regular directory.");
  requireThat(await realpath(path) === path, "Harness directory has a symbolic-link ancestor.");
}
async function privateJson(path) {
  const entry = await lstat(path);
  requireThat(entry.isFile() && !entry.isSymbolicLink() && entry.nlink === 1 && (entry.mode & 0o077) === 0 && entry.uid === process.getuid() && entry.size < 1024 * 1024, "Unsafe harness metadata file.");
  return JSON.parse(await readFile(path, "utf8"));
}
async function save(marker, first = false) {
  const temporary = `${ownerPath}.${randomUUID()}`;
  if (!first) await privateJson(ownerPath);
  await writeFile(temporary, `${JSON.stringify(marker)}\n`, { flag: "wx", mode: 0o600 });
  if (first) {
    // Exclusive creation protects against a second checkout process, even before the lock.
    await writeFile(ownerPath, `${JSON.stringify(marker)}\n`, { flag: "wx", mode: 0o600 });
    await unlink(temporary);
  } else await rename(temporary, ownerPath);
}
async function load(engine) {
  await secureDirectory(runtime);
  await secureDirectory(home);
  const marker = await privateJson(ownerPath);
  requireThat(marker.schema === 1 && marker.checkout === checkout && marker.project === project && marker.image === image && typeof marker.owner === "string" && /^[a-f0-9-]{36}$/u.test(marker.owner), "Ownership marker does not match this checkout.");
  requireThat(marker.dockerHost === engine.dockerHost && marker.engineId === engine.engineId, "Docker host or engine identity changed. Refusing all fixture actions.");
  requireThat(marker.composeHash === digest(await readFile(join(directory, "compose.yml"))), "Fixture Compose definition changed; manual ownership review required.");
  return marker;
}
async function evidence(event, data = {}) {
  emit(event, data);
  const file = join(runtime, "evidence.jsonl");
  try {
    const entry = await lstat(file);
    requireThat(entry.isFile() && !entry.isSymbolicLink() && entry.nlink === 1 && entry.uid === process.getuid() && (entry.mode & 0o077) === 0 && entry.size < 4 * 1024 * 1024, "Evidence is unsafe or reached its 4 MiB bound; preserve and inspect it manually.");
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  const handle = await open(file, "a", 0o600);
  try { await handle.writeFile(`${JSON.stringify({ at: new Date().toISOString(), event, ...data })}\n`); } finally { await handle.close(); }
}
function boundary(marker) {
  return async spec => {
    requireThat(spec.file === "docker" && (!spec.dockerHost || spec.dockerHost === marker.dockerHost), "Production process tried to leave the attested Docker target.");
    if (spec.args[0] === "run") {
      const expected = ["run", "--rm", "--pull", "never", "--network", "none", "--read-only", "--entrypoint", "node", marker.imageId, "-e", "const s=require('node:fs').statfsSync('/');process.stdout.write(JSON.stringify({bytes:Number(s.bavail)*Number(s.bsize)}))"];
      requireThat(marker.imageId && JSON.stringify(spec.args) === JSON.stringify(expected), "An unexpected transient production Docker run was rejected.");
      const name = `${project}-disk-probe-${randomUUID()}`;
      await confirmTarget("RUN-AND-REMOVE-READONLY-DISK-PROBE", `${name}/${marker.imageId}`);
      spec = { ...spec, args: ["run", "--name", name, "--label", `com.relmio.owner=${marker.owner}`, "--label", "com.relmio.disposable=true", ...spec.args.slice(1)] };
    }
    return runLocalProcess({ ...spec, timeoutMs: spec.timeoutMs ?? 180_000, maxOutputBytes: 1024 * 1024 });
  };
}
function dependencies(marker) {
  return { runProcess: boundary(marker), env: { ...process.env, RELMIO_HOME: join(home, ".relmio") }, homeDirectory: home, platform: "linux", cwd: directory };
}
async function docker(marker, args, options = {}) {
  const result = await boundary(marker)({ file: "docker", args, dockerHost: marker.dockerHost, cwd: directory, ...options });
  requireThat(result.code === 0, `Docker ${args[0]} ${args[1] ?? ""} failed. Resources retained; inspect the exact owned fixture manually. Raw Docker output is not logged.`);
  return result.stdout;
}
async function inspect(marker, kind, name, optional = false) {
  const result = await boundary(marker)({ file: "docker", args: [kind, "inspect", "--format", "{{json .}}", name], dockerHost: marker.dockerHost, cwd: directory });
  if (optional && result.code === 1) return null;
  requireThat(result.code === 0, `Cannot inspect owned ${kind}.`);
  return JSON.parse(result.stdout);
}
function labelled(labels, marker) {
  return labels?.["com.relmio.owner"] === marker.owner && labels?.["com.relmio.disposable"] === "true" && labels?.["com.docker.compose.project"] === project;
}

// Also used on partially created fixtures: never capture a foreign or altered resource.
async function fixture(marker, { running = true, optional = false } = {}) {
  const n8n = await inspect(marker, "container", marker.containerId ?? containerName, optional);
  const network = await inspect(marker, "network", marker.networkId ?? networkName, optional);
  const volume = await inspect(marker, "volume", volumeName, optional);
  if (network) {
    assertLocalModelNetworkEligibility(network);
    requireThat(labelled(network.Labels, marker) && network.Name === networkName && network.Driver === "bridge" && idPattern.test(network.Id), "Fixture network ownership changed.");
    if (marker.networkId) requireThat(marker.networkId === network.Id, "Fixture network was replaced.");
  }
  if (volume) {
    requireThat(labelled(volume.Labels, marker) && volume.Name === volumeName && volume.Driver === "local" && !Object.keys(volume.Options ?? {}).length, "Fixture data volume ownership changed.");
    if (marker.volumeCreatedAt) requireThat(marker.volumeCreatedAt === volume.CreatedAt, "Fixture volume was replaced.");
  }
  if (n8n) {
    requireThat(labelled(n8n.Config?.Labels, marker) && n8n.Name === `/${containerName}` && n8n.Config.Image === image && idPattern.test(n8n.Id) && digestPattern.test(n8n.Image), "Fixture n8n identity changed.");
    if (!marker.imageId) requireThat((await inspect(marker, "image", image)).Id === n8n.Image, "Fixture does not use the digest-pinned official image.");
    requireThat(!Object.keys(n8n.HostConfig?.PortBindings ?? {}).length && !n8n.HostConfig?.PublishAllPorts && !n8n.HostConfig?.Privileged && n8n.HostConfig?.ReadonlyRootfs === true && n8n.HostConfig?.RestartPolicy?.Name === "no", "Fixture n8n isolation changed.");
    requireThat(n8n.Mounts?.filter(mount => mount.Type !== "tmpfs").length === 1 && n8n.Mounts.some(mount => mount.Type === "volume" && mount.Name === volumeName && mount.Destination === "/home/node/.n8n"), "Fixture has unexpected mounts.");
    requireThat(network && volume && Object.keys(n8n.NetworkSettings?.Networks ?? {}).length === 1 && n8n.NetworkSettings.Networks[networkName]?.NetworkID === network.Id, "Fixture network selection changed.");
    if (marker.containerId) requireThat(marker.containerId === n8n.Id && marker.imageId === n8n.Image && marker.startedAt === n8n.State.StartedAt && marker.restartCount === n8n.RestartCount, "Fixture n8n was replaced or restarted.");
    if (running) requireThat(n8n.State?.Running && n8n.State.Health?.Status === "healthy", "Fixture n8n is not healthy; no restart is attempted.");
  } else if (!optional) throw new Error("Fixture n8n is missing.");
  return { n8n, network, volume };
}
async function recordFixture(marker) {
  const { n8n, network, volume } = await fixture(marker);
  Object.assign(marker, { containerId: n8n.Id, imageId: n8n.Image, networkId: network.Id, volumeCreatedAt: volume.CreatedAt, startedAt: n8n.State.StartedAt, restartCount: n8n.RestartCount });
  await save(marker);
  return marker;
}
async function discoverPlan(marker) {
  await fixture(marker);
  const deps = dependencies(marker);
  const discovery = await discoverLocalN8nSidecarTargets(deps);
  const target = discovery.containers.find(item => item.containerId === marker.containerId);
  requireThat(discovery.dockerHost === marker.dockerHost && target?.networks.some(item => item.dockerNetworkId === marker.networkId && item.networkName === networkName), "Production discovery did not find the exact fixture target.");
  const selection = { dockerHost: marker.dockerHost, n8nContainerId: marker.containerId, n8nContainerName: containerName, dockerNetworkId: marker.networkId, networkName };
  return createLocalN8nModelPlan({ ...selection, modelId: model, hostResources: await inspectLocalN8nModelResources(selection, deps) });
}
async function status(marker) {
  await fixture(marker);
  const result = await getLocalN8nModelStatus(dependencies(marker));
  requireThat(result.status !== "unavailable", "Production model status is unavailable; no fallback or repair attempted.");
  if (result.managed) requireThat(result.modelId === model && result.networkName === networkName && result.containerName === containerName, "Production model selected a different target.");
  return result;
}
async function waitReady(marker) {
  const deadline = Date.now() + 2 * 60 * 60 * 1000;
  while (Date.now() < deadline) {
    const result = await status(marker);
    await evidence("model-status", result);
    if (result.status === "model-ready") return result;
    requireThat(["downloading", "runtime-ready"].includes(result.status), "Acquisition did not reach ready. Resources/cache retained; review the exact failure before any explicit retry.");
    await delay(5000);
  }
  throw new Error("Two-hour acquisition observation deadline reached. No helper/runtime was stopped; reconnect to inspect it.");
}

export function createWorkflow() {
  return {
    id: "RelmioLocalModelAcceptance", name: "Relmio private model acceptance", active: false,
    nodes: [
      { id: "trigger", name: "Manual Trigger", type: "n8n-nodes-base.manualTrigger", typeVersion: 1, position: [0, 0], parameters: {} },
      { id: "chat", name: "Chat Completions", type: "n8n-nodes-base.httpRequest", typeVersion: 4.2, position: [240, 0], parameters: {
        method: "POST", url: "http://n8n-local-model:11434/v1/chat/completions", authentication: "none", sendBody: true, contentType: "json", specifyBody: "json",
        jsonBody: JSON.stringify({ model, messages: [{ role: "user", content: "What is 2 + 2? Reply with only the digit 4. /no_think" }], stream: false, temperature: 0, reasoning_effort: "none", max_tokens: 64 }),
        options: { timeout: 180000, response: { response: { responseFormat: "json" } } },
      } },
    ],
    connections: { "Manual Trigger": { main: [[{ node: "Chat Completions", type: "main", index: 0 }]] } },
    settings: { executionOrder: "v1" },
  };
}
export function parseExecution(text) {
  // n8n bootstrap diagnostics can precede --rawOutput's execution JSON.
  for (let offset = text.indexOf("{"); offset !== -1; offset = text.indexOf("{", offset + 1)) {
    let execution;
    try { execution = JSON.parse(text.slice(offset)); } catch { continue; }
    const result = execution?.data?.resultData;
    const chat = result?.runData?.["Chat Completions"]?.[0]?.data?.main?.[0]?.[0]?.json;
    const content = chat?.choices?.[0]?.message?.content;
    requireThat(!result?.error && execution.finished === true && chat?.object === "chat.completion" && chat.model === model && typeof content === "string" && /(?:^|\D)4(?:\D|$)/u.test(content) && chat.usage?.completion_tokens > 0, "n8n execution did not prove a real successful Chat Completions response.");
    return { executionId: execution.id ?? null, model: chat.model, completionTokens: chat.usage.completion_tokens, answer: content, responseHash: digest(JSON.stringify(chat)) };
  }
  throw new Error("n8n did not return a complete execution result; process exit alone is not success.");
}
async function workflow(marker) {
  const current = await status(marker);
  requireThat(current.status === "model-ready", "Actual n8n workflow execution requires a model-ready runtime.");
  requireThat(!marker.fault || marker.retryVerified, "Post-fault workflow proof requires verified cache-preserving production retry first.");
  if (!marker.workflowImported) {
    await confirmTarget("IMPORT-WORKFLOW", `${marker.containerId}/RelmioLocalModelAcceptance`);
    await fixture(marker);
    // n8n 2.36.8 no longer supports execute --file. Import into only this disposable DB first.
    await docker(marker, ["exec", "-i", "--user", "node", marker.containerId, "node", "-e", "const fs=require('node:fs');let s='';process.stdin.on('data',c=>s+=c);process.stdin.on('end',()=>{const p='/tmp/relmio-acceptance.json';try{fs.writeFileSync(p,s,{flag:'wx',mode:0o600});}catch(e){if(e.code!=='EEXIST')throw e;const t=fs.lstatSync(p);if(!t.isFile()||t.isSymbolicLink()||fs.readFileSync(p,'utf8')!==s)throw Error('Workflow input changed');}});"], { input: JSON.stringify(createWorkflow()) });
    await docker(marker, ["exec", "--user", "node", marker.containerId, "n8n", "import:workflow", "--input=/tmp/relmio-acceptance.json"]);
    marker.workflowImported = true;
    await save(marker);
  }
  await confirmTarget("EXECUTE-WORKFLOW", `${marker.containerId}/RelmioLocalModelAcceptance`);
  await fixture(marker);
  // The pinned execute command starts its own broker; do not collide with the live editor's 5679.
  const output = await docker(marker, ["exec", "--user", "node", "--env", "N8N_RUNNERS_BROKER_PORT=5680", marker.containerId, "n8n", "execute", "--id=RelmioLocalModelAcceptance", "--rawOutput"], { timeoutMs: 240_000 });
  const proof = parseExecution(output);
  await fixture(marker);
  await evidence(marker.fault ? "workflow-after-retry" : "workflow-cold", proof);
  marker[marker.fault ? "retryWorkflow" : "coldWorkflow"] = { modelDigest: current.modelDigest, responseHash: proof.responseHash };
  await save(marker);
}
async function modelResources(marker, state) {
  requireThat(state.managed && /^[a-f0-9]{32}$/u.test(state.installId), "No owned model installation identity.");
  const name = `relmio-n8n-local-model-${state.installId}`;
  const instance = await inspect(marker, "container", `${name}-local-model-1`);
  const cache = await inspect(marker, "volume", `${name}_model-cache`);
  for (const labels of [instance.Config?.Labels, cache.Labels]) requireThat(labels?.["io.relmio.install"] === state.installId && labels?.["io.relmio.target"] === "n8n-local-model" && labels?.["io.relmio.managed"] === "true" && labels?.["com.docker.compose.project"] === name, "Model resource ownership mismatch.");
  requireThat(idPattern.test(instance.Id) && instance.Id !== marker.containerId && !Object.keys(instance.HostConfig?.PortBindings ?? {}).length && instance.Mounts.some(mount => mount.Name === cache.Name && mount.Destination === "/root/.ollama"), "Unsafe model fault target.");
  return { instance, cache };
}
async function cacheProof(marker, instance) {
  const output = await docker(marker, ["exec", instance.Id, "/bin/sh", "-c", "find /root/.ollama/models -type f -exec sha256sum {} \\;"], { timeoutMs: 180_000 });
  const lines = output.trim().split("\n").sort();
  requireThat(lines.every(line => /^[a-f0-9]{64}  \/root\/\.ollama\/models\//u.test(line)) && lines.some(line => line.includes("/blobs/")) && lines.some(line => line.includes("/manifests/")), "Cannot establish model cache content identity.");
  return { files: lines.length, sha256: digest(lines.join("\n")) };
}
async function attestInspector(marker) {
  requireThat(marker.inspector && marker.fault?.cacheName, "No recorded cache inspector.");
  const item = await inspect(marker, "container", marker.inspector.id ?? marker.inspector.name);
  const host = item.HostConfig;
  requireThat(idPattern.test(item.Id) && (!marker.inspector.id || item.Id === marker.inspector.id) && item.Name === `/${marker.inspector.name}` &&
    item.Image === marker.imageId && item.Config?.Image === marker.imageId && item.Config?.Labels?.["com.relmio.owner"] === marker.owner &&
    item.Config?.Labels?.["com.relmio.disposable"] === "true" && item.Config?.Labels?.["com.relmio.role"] === "cache-inspector" &&
    JSON.stringify(item.Config?.Entrypoint) === JSON.stringify(["node"]) && JSON.stringify(item.Config?.Cmd) === JSON.stringify(["-e", createCacheInventoryProgram()]) &&
    host?.NetworkMode === "none" && host.ReadonlyRootfs === true && host.Privileged === false && host.AutoRemove === false &&
    host.CapDrop?.includes("ALL") && host.SecurityOpt?.some(option => ["no-new-privileges", "no-new-privileges:true"].includes(option)) && !Object.keys(host.PortBindings ?? {}).length &&
    item.Mounts?.length === 1 && item.Mounts[0].Name === marker.fault.cacheName && item.Mounts[0].Destination === "/cache" && item.Mounts[0].RW === false,
  "Cache inspector ownership or read-only isolation changed.");
  requireThat(item.State?.Running === false, "Cache inspector is still running; no second reader is started.");
  return item;
}
async function reconcileAbsentInspector(marker) {
  if (!marker.inspector) return;
  const recorded = await inspect(marker, "container", marker.inspector.id ?? marker.inspector.name, true);
  if (recorded) return; // Full attestation still follows before any action.
  requireThat(await inspect(marker, "container", marker.inspector.name, true) === null, "A replacement container occupies the recorded cache inspector name.");
  marker.inspector = null;
  await save(marker);
}
async function stoppedCacheProof(marker) {
  const current = await status(marker);
  const { instance, cache } = await modelResources(marker, current);
  requireThat(instance.Id === marker.fault.runtimeId && !instance.State.Running && cache.Name === marker.fault.cacheName && cache.CreatedAt === marker.fault.cacheCreatedAt, "The exact model writer must remain stopped before cache inspection.");
  await reconcileAbsentInspector(marker);
  if (!marker.inspector) {
    const name = `${project}-cache-inspector`;
    requireThat(await inspect(marker, "container", name, true) === null, "Cache inspector name is already occupied.");
    await confirmTarget("CREATE-READONLY-CACHE-INSPECTOR", `${name}/${cache.Name}/${marker.imageId}`);
    marker.inspector = { name, id: null };
    await save(marker);
    const id = (await docker(marker, ["create", "--name", name, "--network", "none", "--read-only", "--user", "0:0",
      "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--label", `com.relmio.owner=${marker.owner}`,
      "--label", "com.relmio.disposable=true", "--label", "com.relmio.role=cache-inspector",
      "--mount", `type=volume,src=${cache.Name},dst=/cache,readonly`, "--entrypoint", "node", marker.imageId, "-e", createCacheInventoryProgram()])).trim();
    requireThat(idPattern.test(id), "Cache inspector creation identity was not returned.");
    marker.inspector.id = id;
    await save(marker);
  }
  const inspector = await attestInspector(marker);
  await confirmTarget("RUN-READONLY-CACHE-INSPECTOR", `${inspector.Id}/${cache.Name}`);
  await attestInspector(marker);
  requireThat(!(await inspect(marker, "container", instance.Id)).State.Running, "Model writer resumed during cache-read confirmation.");
  const rows = validatePartialInventory(JSON.parse(await docker(marker, ["start", "--attach", inspector.Id], { timeoutMs: 180_000 })));
  const exited = await attestInspector(marker);
  requireThat(exited.State.ExitCode === 0 && !(await inspect(marker, "container", instance.Id)).State.Running, "Cache inventory did not finish with the writer stopped.");
  return { files: rows.length, sha256: digest(JSON.stringify(rows)), entries: rows };
}
async function removeInspector(marker) {
  await reconcileAbsentInspector(marker);
  if (!marker.inspector) return;
  const item = await attestInspector(marker);
  await confirmTarget("DELETE-CACHE-INSPECTOR", item.Id);
  await attestInspector(marker);
  await docker(marker, ["container", "rm", item.Id]);
  requireThat(await inspect(marker, "container", item.Id, true) === null, "Cache inspector remains.");
  marker.inspector = null;
  await save(marker);
}
export function hasPartialProgress(result) {
  return result?.status === "downloading" && result.progress?.status === "downloading" &&
    Number.isSafeInteger(result.progress.completed) && Number.isSafeInteger(result.progress.total) &&
    result.progress.completed > 0 && result.progress.completed < result.progress.total;
}
async function interruptPull(marker) {
  requireThat(marker.scenario === "midpull" && !marker.midpullNotRun && !marker.retryVerified, "Select install-midpull on a fresh fixture; a completed or missed scenario cannot be reused.");
  if (!marker.fault) {
    const deadline = Date.now() + 300_000;
    let current;
    while (Date.now() < deadline) {
      current = await status(marker);
      if (hasPartialProgress(current)) break;
      if (current.status === "model-ready") {
        marker.midpullNotRun = "download-finished-before-partial-observation";
        await save(marker);
        await evidence("midpull-NOT-RUN", { reason: marker.midpullNotRun, cacheRetained: true });
        throw new Error("Cold download finished too quickly. Requested mid-pull scenario is NOT-RUN; use a new fixture/checkout, never delete a ready cache to simulate it.");
      }
      requireThat(["downloading", "runtime-ready"].includes(current.status), "Cold acquisition failed before measurable partial progress; inspect retained resources.");
      await delay(200);
    }
    requireThat(hasPartialProgress(current), "Five-minute partial-progress deadline reached; no fault or cleanup was attempted.");
    const { instance, cache } = await modelResources(marker, current);
    await evidence("midpull-observed", { runtimeId: instance.Id, progress: current.progress });
    await confirmTarget("INTERRUPT-ONE-COLD-MODEL", `${instance.Id}/${current.operationId}/${cache.Name}`);
    current = await status(marker);
    if (!hasPartialProgress(current)) {
      marker.midpullNotRun = "partial-window-ended-before-human-confirmation";
      await save(marker);
      await evidence("midpull-NOT-RUN", { reason: marker.midpullNotRun, observedStatus: current.status, cacheRetained: true });
      throw new Error("The partial download window ended before confirmation. NOT-RUN; no stop, deletion or retry performed.");
    }
    const exact = await modelResources(marker, current);
    requireThat(exact.instance.Id === instance.Id && exact.cache.CreatedAt === cache.CreatedAt, "Cold fault resource identity changed.");
    marker.fault = { kind: "midpull", runtimeId: instance.Id, installId: current.installId, digest: null, cacheName: cache.Name, cacheCreatedAt: cache.CreatedAt, operationId: current.operationId, partialProgress: current.progress };
    await save(marker);
    await docker(marker, ["container", "stop", "--time", "30", instance.Id]);
  }
  requireThat(marker.fault.kind === "midpull", "A different fault already owns this fixture.");
  requireThat((await inspect(marker, "container", marker.fault.runtimeId)).State.Running === false, "Cold writer shutdown is not proved; no second fault is injected.");
  if (marker.fault.proof) return; // Reconnect is inspection, never another interruption.
  let proof;
  try { proof = await stoppedCacheProof(marker); }
  catch (error) {
    if (error.message.includes("NOT-RUN")) {
      marker.midpullNotRun = "no-incomplete-cache-after-writer-stop";
      await save(marker);
      await evidence("midpull-NOT-RUN", { reason: marker.midpullNotRun, cacheRetained: true });
    }
    throw error;
  }
  marker.fault.proof = proof;
  await save(marker);
  await evidence("cold-writer-stopped", { runtimeId: marker.fault.runtimeId, cacheName: marker.fault.cacheName, proof, n8nUnchanged: true });
}
async function injectFault(marker) {
  requireThat(!marker.fault && marker.coldWorkflow, "Exactly one fault is allowed, only after a successful cold n8n workflow.");
  requireThat(marker.scenario !== "midpull", "Mid-pull fixtures cannot substitute a ready-runtime fault.");
  const current = await status(marker);
  requireThat(current.status === "model-ready", "Fault requires a ready model.");
  const { instance, cache } = await modelResources(marker, current);
  const proof = await cacheProof(marker, instance);
  await confirmTarget("STOP-ONE-MODEL", instance.Id);
  await fixture(marker);
  marker.fault = { runtimeId: instance.Id, installId: current.installId, digest: current.modelDigest, cacheName: cache.Name, cacheCreatedAt: cache.CreatedAt, proof, operationId: current.operationId };
  await save(marker); // An interrupted stop cannot result in a second fault injection.
  await docker(marker, ["container", "stop", "--time", "30", instance.Id]);
  requireThat((await inspect(marker, "container", instance.Id)).State.Running === false, "Model-only stop did not complete.");
  const after = await status(marker);
  requireThat(after.status === "partial", "Production status did not observe the stopped runtime.");
  await evidence("one-model-fault", { runtimeId: instance.Id, cacheName: cache.Name, proof, n8nUnchanged: true });
}
async function retry(marker) {
  requireThat(marker.fault && !marker.retryVerified, "Retry acceptance requires the one recorded model-only fault.");
  requireThat(!marker.midpullNotRun && (marker.fault.kind !== "midpull" || marker.fault.proof), "No genuine interrupted cold cache was proved; retry acceptance cannot claim this scenario.");
  const deps = dependencies(marker);
  const current = await status(marker);
  // A new invocation can finish observing an already approved retry, without retrying again.
  if (current.operationId === marker.fault.operationId || ["partial", "model-error", "runtime-ready"].includes(current.status)) {
    const review = await reviewLocalN8nModelAction({ action: "retry" }, deps);
    const digestMatches = marker.fault.kind === "midpull"
      ? (review.modelDigest === null || `sha256:${review.modelDigest}` === marker.approvedModelDigest)
      : (review.modelDigest === marker.fault.digest || (review.modelDigest === null && current.operationId === null && `sha256:${marker.fault.digest}` === marker.approvedModelDigest));
    requireThat(review.installId === marker.fault.installId && digestMatches, "Retry review lost the installed model identity.");
    emit("retry-review", review);
    await confirmTarget("RETRY-MODEL-REMOVE-OLD-HELPER", `${review.installId}/${review.operationId}`);
    await fixture(marker);
    if (marker.fault.kind === "midpull" && !marker.partialCacheRetainedBeforeRestart) {
      const retained = await stoppedCacheProof(marker);
      requireThat(retained.sha256 === marker.fault.proof.sha256, "Partial cache changed before writer restart.");
      marker.partialCacheRetainedBeforeRestart = true;
      await save(marker);
      await evidence("partial-cache-retained-before-restart", { proof: retained, byteOffsetResumeClaimed: false });
    }
    await applyLocalN8nModelAction({ review, confirmed: true }, deps);
  }
  const ready = await waitReady(marker);
  const { instance, cache } = await modelResources(marker, ready);
  const proof = await cacheProof(marker, instance);
  requireThat(instance.Id === marker.fault.runtimeId && cache.Name === marker.fault.cacheName && cache.CreatedAt === marker.fault.cacheCreatedAt && ready.operationId !== marker.fault.operationId, "Retry did not preserve runtime/cache identity.");
  if (marker.fault.kind === "midpull") {
    requireThat(marker.partialCacheRetainedBeforeRestart && `sha256:${ready.modelDigest}` === marker.approvedModelDigest, "Interrupted acquisition did not preserve partial cache before restart and reach the approved final model.");
  } else requireThat(ready.modelDigest === marker.fault.digest && proof.sha256 === marker.fault.proof.sha256, "Ready-model retry changed existing cache contents.");
  marker.retryVerified = true;
  await save(marker);
  await evidence("retry-cache-preserved", { installId: ready.installId, modelDigest: ready.modelDigest, cacheName: cache.Name, proof, n8nUnchanged: true });
}
async function removeModel(marker) {
  const deps = dependencies(marker);
  await fixture(marker, { running: false, optional: true });
  await removeInspector(marker);
  const review = await reviewLocalN8nModelAction({ action: "remove", removeModelData: true }, deps);
  emit("model-removal-review", review);
  await confirmTarget("DELETE-MODEL-AND-CACHE", `${review.installId}/${review.operationId}`);
  await fixture(marker, { running: false, optional: true });
  const result = await applyLocalN8nModelAction({ review, confirmed: true }, deps);
  requireThat(result.removed && (await getLocalN8nModelStatus(deps)).status === "absent", "Production removal did not reach absent.");
  marker.modelRemoved = true;
  await save(marker);
  await evidence("model-removed", { ...result, n8nUnchanged: true });
}
async function teardown(marker) {
  requireThat((await getLocalN8nModelStatus(dependencies(marker))).status === "absent", "Remove the managed model through its separately confirmed command before fixture teardown.");
  let owned = await fixture(marker, { running: false, optional: true });
  const target = `${marker.owner}/${owned.n8n?.Id ?? "no-container"}/${owned.network?.Id ?? "no-network"}/${owned.volume?.Name ?? "no-volume"}`;
  emit("fixture-teardown-review", { target, deletes: ["disposable n8n container", "disposable n8n database volume", "fixture network"], retains: ["evidence", "isolated home", "images"] });
  await confirmTarget("DELETE-FIXTURE", target);
  owned = await fixture(marker, { running: false, optional: true });
  requireThat(target === `${marker.owner}/${owned.n8n?.Id ?? "no-container"}/${owned.network?.Id ?? "no-network"}/${owned.volume?.Name ?? "no-volume"}`, "The approved fixture teardown target changed.");
  const attached = Object.keys(owned.network?.Containers ?? {});
  requireThat(attached.every(id => id === owned.n8n?.Id), "Fixture network contains another container; refusing teardown.");
  const users = await docker(marker, ["ps", "-a", "--filter", `volume=${volumeName}`, "--format", "{{.ID}}", "--no-trunc"]);
  requireThat(users.trim().split("\n").filter(Boolean).every(id => id === owned.n8n?.Id), "Fixture volume has another consumer; refusing teardown.");
  if (owned.n8n) {
    if (owned.n8n.State.Running) await docker(marker, ["container", "stop", "--time", "30", owned.n8n.Id]);
    await docker(marker, ["container", "rm", owned.n8n.Id]);
  }
  if (owned.volume) await docker(marker, ["volume", "rm", owned.volume.Name]);
  if (owned.network) await docker(marker, ["network", "rm", owned.network.Id]);
  const remaining = await fixture({ ...marker, containerId: null, networkId: null }, { running: false, optional: true });
  requireThat(!remaining.n8n && !remaining.network && !remaining.volume, "Fixture resources remain; ownership retained.");
  marker.tornDown = true;
  await save(marker);
  await evidence("fixture-removed", { retainedLocalEvidence: true, readyRuntimeRecoveryComplete: Boolean(marker.scenario !== "midpull" && marker.reconnected && marker.coldWorkflow && marker.retryVerified && marker.retryWorkflow && marker.modelRemoved), interruptedColdDownloadVerified: Boolean(marker.scenario === "midpull" && !marker.midpullNotRun && marker.fault?.proof && marker.partialCacheRetainedBeforeRestart && marker.reconnected && marker.retryVerified && marker.retryWorkflow && marker.modelRemoved), byteOffsetResumeClaimed: false });
}
async function createFixture(engine) {
  requireThat(!(await lstat(ownerPath).catch(error => { if (error.code === "ENOENT") return null; throw error; })), "An ownership marker already exists. Reconnect instead of recreating n8n.");
  const marker = { schema: 1, checkout, project, image, ...engine, owner: randomUUID(), composeHash: digest(await readFile(join(directory, "compose.yml"))) };
  for (const [kind, name] of [["container", containerName], ["network", networkName], ["volume", volumeName]]) requireThat(await inspect(marker, kind, name, true) === null, "Fixture resource name is already occupied. Nothing adopted.");
  await confirmTarget("CREATE-FIXTURE-INITIALIZE-DISPOSABLE-DATABASE", `${project}/${marker.owner}`);
  await secureDirectory(home, true);
  await save(marker, true);
  const result = await runLocalProcess({ file: "docker", args: ["compose", "--project-name", project, "--file", join(directory, "compose.yml"), "up", "--detach", "--wait", "--wait-timeout", "150", "--no-recreate", "n8n"], dockerHost: engine.dockerHost, cwd: directory, timeoutMs: 600_000 }, { environment: { ...process.env, RELMIO_ACCEPTANCE_OWNER: marker.owner } });
  requireThat(result.code === 0, "Fixture startup failed. Marker/resources retained; status or teardown can inspect exact ownership. Do not rerun Compose manually.");
  await recordFixture(marker);
  await evidence("fixture-created", { containerId: marker.containerId, networkId: marker.networkId, image, noHostPorts: true });
}

export async function runCli(argv = process.argv.slice(2)) {
  const command = argv[0] ?? "help";
  if (command === "help" || command === "--help") {
    process.stdout.write(`Private real-Linux Docker local-model acceptance\n\nUsage: node dev/local-model-linux/harness.mjs <command>\nCommands: ${[...commands].join(", ")}\n\nSequence: preflight; fixture; review; install; wait; reconnect (new process); workflow; fault; retry; workflow; remove-model; teardown.\nAll mutation approvals require a human TTY and exact displayed target. No --yes, cleanup trap, CI bypass, host ports, tunnel, credential, or Docker socket mount.\nNo automatic retry. Failed runs retain resources and cache. status/wait/reconnect never repair.\nEvidence and isolated home remain under dev/local-model-linux/.runtime after approved teardown.\nA cold run needs registry egress, measured production model budget, Linux Docker Engine, Compose >=2.17, and Node >=24.\n`);
    process.stdout.write("Distinct cold-interruption sequence (separate fresh checkout/fixture): fixture; install-midpull; reconnect; retry; workflow; remove-model; teardown. install-midpull observes real positive partial progress and asks before stopping the exact writer. interrupt-pull reconnects to that observation/proof stage. A completed download before confirmation is NOT-RUN, never success. Read-only cache inspector creation and removal each require exact-target approval. Partial bytes are proved retained before restart; network byte-offset resume is not claimed.\nProduction resource review uses a separately approved exact-named no-network read-only disk probe, removed on its normal exit only after explicit creation/removal approval. Workflow execution always requires its own exact-target approval.\n");
    return;
  }
  requireThat(argv.length === 1 && commands.has(command), "Unknown command or extra arguments; use --help. Approval flags are not supported.");
  requireThat(Number(process.versions.node.split(".")[0]) >= 24, "Node.js 24 or newer is required.");
  const engine = await preflight();
  if (command === "preflight") { emit("preflight-ok", engine); return; }
  await secureDirectory(runtime, command === "fixture");
  const lock = await open(join(runtime, "lifecycle.lock"), "wx", 0o600).catch(() => { throw new Error("Harness lifecycle lock exists or is unsafe. Human review is required; never steal a lock."); });
  try {
    await lock.writeFile(`${JSON.stringify({ pid: process.pid, command, project })}\n`);
    if (command === "fixture") { await createFixture(engine); return; }
    const marker = await load(engine);
    requireThat(!marker.tornDown, "This fixture is already torn down. Evidence retained; use a separate checkout for a new cold run.");
    if (command === "teardown") { await teardown(marker); return; }
    if (!marker.containerId) await recordFixture(marker);
    if (command === "review") { await evidence("install-review", await discoverPlan(marker)); return; }
    if (command === "install" || command === "install-midpull") {
      const plan = await discoverPlan(marker);
      emit("install-review", plan);
      await confirmTarget("INSTALL-AND-DOWNLOAD", `${marker.containerId}/${model}/${plan.approvedModelDigest}`);
      requireThat((await status(marker)).status === "absent", "Cold acceptance requires an absent managed model installation.");
      requireThat(!marker.scenario, "An installation scenario already owns this fixture; use a separate fresh checkout for another cold case.");
      marker.scenario = command === "install-midpull" ? "midpull" : "ready-recovery";
      marker.approvedModelDigest = plan.approvedModelDigest;
      await save(marker);
      await evidence("install-start", { model, networkId: marker.networkId, approvedModelDigest: plan.approvedModelDigest });
      await evidence("install-result", await installLocalN8nModel({ plan, confirmed: true }, dependencies(marker)));
      if (marker.scenario === "midpull") await interruptPull(marker);
    } else if (command === "wait") await waitReady(marker);
    else if (command === "status" || command === "reconnect") {
      const result = await status(marker);
      if (command === "reconnect") {
        requireThat(result.managed, "Reconnect requires a real persisted installation.");
        marker.reconnected = true;
        await save(marker);
      }
      await evidence(command, result);
    } else if (command === "workflow") await workflow(marker);
    else if (command === "interrupt-pull") await interruptPull(marker);
    else if (command === "fault") await injectFault(marker);
    else if (command === "retry") await retry(marker);
    else if (command === "remove-model") await removeModel(marker);
  } finally {
    await lock.close();
    await unlink(join(runtime, "lifecycle.lock"));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runCli().catch(error => { process.stderr.write(`${error.message}\nNo automatic cleanup or retry was performed.\n`); process.exitCode = 1; });
}

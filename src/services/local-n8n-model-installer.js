import { createHash, randomBytes as defaultRandomBytes, randomUUID } from "node:crypto";
import * as defaultFileSystem from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

import {
  LOCAL_N8N_MODEL_ENDPOINT,
  LOCAL_N8N_MODEL_HOSTNAME,
  LOCAL_N8N_MODEL_TARGET,
  LOCAL_MODEL_RUNTIME_IMAGE,
  createLocalN8nModelAcquisitionDockerfile,
  createLocalN8nModelComposeFile,
  createLocalN8nModelDockerignore,
  createLocalN8nModelPlan,
  normalizeLocalN8nModelPlan,
} from "../domain/local-n8n-model.js";
import { parseLocalModelOperationStatus } from "../local-model/acquisition.mjs";
import { assertLocalModelNetworkEligibility } from "../domain/local-model-network.js";
import { validateDockerName } from "../domain/validation.js";
import { attestLocalDockerBuilder, lockDownLocalPath, runLocalProcess, validateLocalDockerHost } from "../infrastructure/local-process.js";
import { getLocalProcessIdentity } from "../infrastructure/process-identity.js";
import { acquireLocalIntegrationLifecycleLock, settleLocalIntegrationLifecycleOperation } from "./local-integration-lifecycle-lock.js";
import { discoverLocalN8nSidecarTargets } from "./local-n8n-sidecar-installer.js";

const MARKER_FILE = ".managed-by-relmio.json";
const ROOT_MARKER = ".managed-by-relmio-root.json";
const COMPOSE_FILE = "compose.yaml";
const PROJECT_PREFIX = "relmio-n8n-local-model";
const SERVICE = "local-model";
const HELPER = "acquisition";
const VOLUME = "model-cache";
const MAX_METADATA = 1024 * 1024;
const MAX_RESOURCES = 100;
const DOCKER_ENV = new Set(["DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH", "BUILDKIT_HOST", "BUILDX_BUILDER", "BUILDX_CONFIG"]);
const ID = /^[a-f0-9]{64}$/u;
const SHORT_ID = /^[a-f0-9]{32}$/u;
const DIGEST = /^sha256:[a-f0-9]{64}$/u;
const HASH = /^[a-f0-9]{64}$/u;
const FILES = [COMPOSE_FILE, "Dockerfile.acquisition", ".dockerignore", "acquisition.mjs", "catalog.mjs"];

function hash(value) { return createHash("sha256").update(value).digest("hex"); }
function missing(error) { return error?.code === "ENOENT"; }
function absolute(value) {
  if (typeof value !== "string" || !isAbsolute(value) || value.includes("\0")) throw new TypeError("Invalid managed local-model path.");
  return resolve(value);
}
function installRoot(value) {
  const root = absolute(value);
  if (basename(root) !== LOCAL_N8N_MODEL_TARGET || basename(dirname(root)) !== "local" || basename(resolve(root, "..", "..")) !== ".relmio") throw new TypeError("Invalid managed local-model root.");
  return root;
}
function noOverrides(env) {
  if (!env || typeof env !== "object" || Array.isArray(env)) throw new TypeError("Invalid Docker environment.");
  for (const [name, value] of Object.entries(env)) {
    const key = name.toUpperCase();
    if ((DOCKER_ENV.has(key) || key.startsWith("COMPOSE_")) && value) throw new Error("Docker environment overrides are not allowed for managed local models.");
    if (key === "DOCKER_BUILDKIT" && value && value !== "1") throw new Error("Disabling Docker BuildKit is not allowed for managed local models.");
  }
}
async function stat(fs, path, options) { try { return await fs.lstat(path, options); } catch (error) { if (missing(error)) return null; throw error; } }
function directory(entry) { if (!entry?.isDirectory?.() || entry.isSymbolicLink()) throw new Error("Unsafe managed directory."); }
async function directoryId(fs, path) {
  const entry = await stat(fs, path, { bigint: true }); directory(entry);
  if ((typeof entry.dev !== "bigint" && !Number.isSafeInteger(entry.dev)) || (typeof entry.ino !== "bigint" && !Number.isSafeInteger(entry.ino))) throw new Error("Managed directory identity is unavailable.");
  return { dev: entry.dev, ino: entry.ino };
}
async function privateFile(fs, path, data, platform, lockDownPath) {
  if (await stat(fs, path)) throw new Error("A managed file already exists. Nothing was overwritten.");
  await fs.writeFile(path, data, { flag: "wx", mode: 0o600 });
  await fs.chmod(path, 0o600);
  if (platform === "win32") await lockDownPath(path, { platform, kind: "file" });
}
async function privateDirectory(fs, path, platform, lockDownPath) {
  const entry = await stat(fs, path);
  if (entry) directory(entry); else await fs.mkdir(path, { mode: 0o700 });
  await fs.chmod(path, 0o700);
  if (platform === "win32") await lockDownPath(path, { platform });
}
async function attestFiles(fs, root, marker, platform = process.platform, lockDownPath = lockDownLocalPath) {
  const id = await directoryId(fs, root);
  const rootEntry = await stat(fs, root);
  if (platform === "win32") await lockDownPath(root, { platform, verifyOnly: true });
  else if ((rootEntry.mode & 0o077) !== 0) throw new Error("Managed local-model directory permissions changed.");
  const names = (await fs.readdir(root)).sort();
  const expected = [...FILES, MARKER_FILE].sort();
  if (names.length !== expected.length || names.some((name, index) => name !== expected[index])) throw new Error("Managed local-model files changed. Nothing was changed.");
  const contents = {};
  for (const name of expected) {
    const path = join(root, name);
    const entry = await stat(fs, path);
    if (!entry?.isFile?.() || entry.isSymbolicLink() || (platform !== "win32" && (entry.mode & 0o077) !== 0)) throw new Error("Unsafe managed local-model file.");
    if (platform === "win32") await lockDownPath(path, { platform, kind: "file", verifyOnly: true, verifyEffectiveOwnerOnly: true });
    const contentsText = await fs.readFile(path, "utf8");
    if (Buffer.byteLength(contentsText) > MAX_METADATA) throw new Error("Oversized managed local-model file.");
    contents[name] = contentsText;
  }
  if (contents[MARKER_FILE] !== `${JSON.stringify(marker)}\n` || FILES.some(name => hash(contents[name]) !== marker.fileHashes[name])) throw new Error("Managed local-model files changed. Nothing was changed.");
  return { id, contents };
}
function parse(text, label) {
  if (typeof text !== "string" || Buffer.byteLength(text) > MAX_METADATA) throw new Error(`${label} returned invalid metadata.`);
  try { return JSON.parse(text); } catch { throw new Error(`${label} returned invalid metadata.`); }
}
function rows(text, label) { return text.trim() ? text.trim().split("\n").map(line => parse(line, label)) : []; }
async function run(boundary, spec, label) {
  const result = await boundary(spec);
  if (result?.code !== 0) throw new Error(`${label} failed.`);
  return result.stdout;
}
function dockerSpec(marker, cwd, args) { return { file: "docker", args, cwd, dockerHost: marker.dockerHost }; }
function compose(marker, args) {
  if (marker.projectName !== `${PROJECT_PREFIX}-${marker.installId}` || !SHORT_ID.test(marker.installId)) throw new Error("Invalid managed project identity.");
  return ["compose", "--project-name", marker.projectName, "--file", COMPOSE_FILE, ...args];
}
async function docker(boundary, marker, cwd, args, label) { return run(boundary, dockerSpec(marker, cwd, args), label); }
async function inspect(boundary, marker, cwd, kind, id) { return parse((await docker(boundary, marker, cwd, [kind, "inspect", "--format", "{{json .}}", id], `${kind} inspection`)).trim(), `${kind} inspection`); }
async function assertVacant(boundary, marker, cwd, kind, name) {
  const result = await boundary(dockerSpec(marker, cwd, [kind, "inspect", name]));
  if (result?.code !== 1) throw new Error(`The managed ${kind} name is not safely available.`);
}
function labelsMatch(labels, marker) {
  return labels?.["com.docker.compose.project"] === marker.projectName && labels?.["io.relmio.managed"] === "true" && labels?.["io.relmio.target"] === LOCAL_N8N_MODEL_TARGET && labels?.["io.relmio.install"] === marker.installId;
}
function imageLabelsMatch(labels, marker) {
  return labels?.["io.relmio.managed"] === "true" && labels?.["io.relmio.target"] === LOCAL_N8N_MODEL_TARGET && labels?.["io.relmio.install"] === marker.installId;
}
async function ownedHelperImage(boundary, marker, cwd) {
  const name = `relmio-n8n-local-model-acquisition-${marker.installId}:local`;
  const result = await boundary(dockerSpec(marker, cwd, ["image", "inspect", "--format", "{{json .}}", name]));
  if (result?.code === 1) return null;
  if (result?.code !== 0) throw new Error("Owned model helper image cannot be inspected.");
  const image = parse(result.stdout.trim(), "Model helper image");
  if (!DIGEST.test(image?.Id) || !imageLabelsMatch(image.Config?.Labels, marker) || (marker.helperImageId && image.Id !== marker.helperImageId)) throw new Error("Model helper image identity changed.");
  return { name, id: image.Id };
}
function markerValid(value) {
  if (!value || value.schemaVersion !== 1 || value.kind !== "relmio-local-n8n-model" || value.target !== LOCAL_N8N_MODEL_TARGET || !SHORT_ID.test(value.installId) || value.projectName !== `${PROJECT_PREFIX}-${value.installId}` || !value.fileHashes || Object.keys(value.fileHashes).sort().join(",") !== FILES.slice().sort().join(",") || FILES.some(name => !HASH.test(value.fileHashes[name])) || !DIGEST.test(value.approvedModelDigest) || (value.runtimeImageId !== null && !DIGEST.test(value.runtimeImageId)) || (value.helperImageId !== null && !DIGEST.test(value.helperImageId))) throw new Error("Invalid managed local-model marker.");
  validateLocalDockerHost(value.dockerHost);
  const plan = createLocalN8nModelPlan({ dockerHost: value.dockerHost, n8nContainerId: value.n8nContainerId, n8nContainerName: value.n8nContainerName, dockerNetworkId: value.dockerNetworkId, networkName: value.networkName, modelId: value.modelId, hostResources: value.hostResources });
  if (plan.runtimeImage !== value.runtimeImage || plan.memoryBytes !== value.memoryBytes || plan.cpus !== value.cpus || plan.contextTokens !== value.contextTokens || plan.approvedModelDigest !== value.approvedModelDigest) throw new Error("Invalid managed runtime budget.");
  if (value.operationId !== null && (!SHORT_ID.test(value.operationId) || value.operationName !== `${value.projectName}-model-pull-${value.operationId}`)) throw new Error("Invalid managed operation identity.");
  if (value.operationId === null && value.operationName !== null) throw new Error("Invalid managed operation identity.");
  if ((value.operationExpectedDigest !== null && !DIGEST.test(value.operationExpectedDigest)) || (value.operationId === null && value.operationExpectedDigest !== null)) throw new Error("Invalid managed operation digest.");
  return value;
}
async function managed(fs, root) {
  const home = resolve(root, "..", "..");
  const homeEntry = await stat(fs, home); if (!homeEntry) return null; directory(homeEntry);
  const rootEntry = await stat(fs, join(home, ROOT_MARKER));
  if (!rootEntry?.isFile?.() || rootEntry.isSymbolicLink()) throw new Error("Relmio storage root is not owned.");
  const rootMarker = parse(await fs.readFile(join(home, ROOT_MARKER), "utf8"), "root marker");
  if (rootMarker.schemaVersion !== 1 || rootMarker.kind !== "relmio-local-root") throw new Error("Relmio storage root is not owned.");
  const local = await stat(fs, join(home, "local")); if (!local) return null; directory(local);
  const entry = await stat(fs, root); if (!entry) return null; directory(entry);
  const markerEntry = await stat(fs, join(root, MARKER_FILE));
  if (!markerEntry?.isFile?.() || markerEntry.isSymbolicLink()) throw new Error("Local-model directory is not owned.");
  return markerValid(parse(await fs.readFile(join(root, MARKER_FILE), "utf8"), "local-model marker"));
}
async function replaceMarker(fs, root, marker, previous, platform = process.platform, lockDownPath = lockDownLocalPath) {
  const old = await stat(fs, join(root, MARKER_FILE));
  if (!old?.isFile?.() || old.isSymbolicLink() || await fs.readFile(join(root, MARKER_FILE), "utf8") !== `${JSON.stringify(previous)}\n`) throw new Error("Managed marker changed during operation.");
  const temp = join(root, `.marker-${randomUUID()}`);
  try {
    await fs.writeFile(temp, `${JSON.stringify(marker)}\n`, { flag: "wx", mode: 0o600 });
    await fs.chmod(temp, 0o600);
    if (platform === "win32") await lockDownPath(temp, { platform, kind: "file" });
    await fs.rename(temp, join(root, MARKER_FILE));
    await fs.chmod(join(root, MARKER_FILE), 0o600);
  } catch (error) { try { await fs.unlink(temp); } catch {} throw error; }
}
async function context(boundary, cwd, env, platform) {
  noOverrides(env);
  const stdout = await run(boundary, { file: "docker", args: ["context", "inspect", "--format", "{{json .Endpoints.docker.Host}}"], cwd }, "Docker context inspection");
  return validateLocalDockerHost(parse(stdout.trim(), "Docker context"), { platform });
}
async function selection(plan, marker, boundary, cwd) {
  const n8n = await inspect(boundary, marker, cwd, "container", plan.n8nContainerId);
  if (n8n.Id !== plan.n8nContainerId || n8n.Name !== `/${plan.n8nContainerName}` || n8n.State?.Running !== true || n8n.NetworkSettings?.Networks?.[plan.networkName]?.NetworkID !== plan.dockerNetworkId || !/^(?:(?:(?:docker\.n8n\.io|docker\.io)\/)?n8nio\/n8n)(?::[A-Za-z0-9_.-]{1,128})?(?:@sha256:[a-f0-9]{64})?$/u.test(n8n.Config?.Image)) throw new Error("Selected n8n container changed. Review again.");
  const network = await inspect(boundary, marker, cwd, "network", plan.networkName);
  assertLocalModelNetworkEligibility(network);
  if (network.Id !== plan.dockerNetworkId || network.Name !== plan.networkName || !network.Containers?.[plan.n8nContainerId]) throw new Error("Selected n8n network changed. Review again.");
  const peers = Object.keys(network.Containers);
  if (peers.length > MAX_RESOURCES) throw new Error("The selected Docker network is too large to attest.");
  for (const id of peers) {
    if (!ID.test(id)) throw new Error("Invalid Docker network member identity.");
    const peer = id === plan.n8nContainerId ? n8n : await inspect(boundary, marker, cwd, "container", id);
    const aliases = peer.NetworkSettings?.Networks?.[plan.networkName]?.Aliases;
    const names = [peer.Name?.slice(1), network.Containers[id]?.Name, ...(Array.isArray(aliases) ? aliases : [])];
    if (names.some(name => name === LOCAL_N8N_MODEL_HOSTNAME || name === SERVICE) && !labelsMatch(peer.Config?.Labels, marker)) throw new Error("The private model network alias is already in use.");
  }
  return n8n;
}
async function resources(boundary, marker, cwd) {
  const filter = `label=com.docker.compose.project=${marker.projectName}`;
  const containers = rows(await docker(boundary, marker, cwd, ["ps", "--all", "--no-trunc", "--filter", filter, "--format", "{{json .}}"], "Model container inventory"), "Model container inventory");
  const volumes = rows(await docker(boundary, marker, cwd, ["volume", "ls", "--filter", filter, "--format", "{{json .}}"], "Model volume inventory"), "Model volume inventory");
  if (containers.length > 2 || volumes.length > 1) throw new Error("Unexpected resources claim the managed model project.");
  const names = new Map();
  for (const row of containers) {
    if (!ID.test(row?.ID)) throw new Error("Invalid model container identity.");
    const item = await inspect(boundary, marker, cwd, "container", row.ID);
    const service = item.Config?.Labels?.["com.docker.compose.service"];
    if (!labelsMatch(item.Config?.Labels, marker) || item.Id !== row.ID || ![SERVICE, HELPER].includes(service)) throw new Error("A Docker resource lacks exact model ownership.");
    const expectedName = service === SERVICE ? `${marker.projectName}-${SERVICE}-1` : marker.operationName;
    if (item.Name !== `/${expectedName}` || names.has(service) || (service === HELPER && (!marker.operationId || item.Config?.Labels?.["com.docker.compose.oneoff"] !== "True" || item.Config?.Labels?.["io.relmio.operation"] !== marker.operationId))) throw new Error("An unexpected model container claims the project.");
    names.set(service, item);
  }
  let volume = null;
  for (const row of volumes) {
    const name = validateDockerName(row?.Name);
    if (name !== `${marker.projectName}_${VOLUME}`) throw new Error("Unexpected model volume claims the project.");
    volume = await inspect(boundary, marker, cwd, "volume", name);
    if (volume.Name !== name || !labelsMatch(volume.Labels, marker)) throw new Error("Model cache volume ownership changed.");
  }
  return { runtime: names.get(SERVICE) ?? null, helper: names.get(HELPER) ?? null, volume };
}
function environmentMatches(actual, expected) {
  if (!Array.isArray(actual)) return false;
  for (const [name, value] of Object.entries(expected)) {
    let count = 0;
    for (const entry of actual) {
      if (typeof entry !== "string" || !entry.startsWith(`${name}=`)) continue;
      if (entry !== `${name}=${value}` || ++count > 1) return false;
    }
    if (count !== 1) return false;
  }
  return true;
}
function attestRuntime(marker, owned, { running = true, health = true } = {}) {
  const item = owned.runtime;
  const host = item?.HostConfig;
  if (typeof item?.State?.Running !== "boolean") throw new Error("The owned model runtime state is unavailable.");
  if (!item || !owned.volume || !DIGEST.test(marker.runtimeImageId) || item.Image !== marker.runtimeImageId || item.Config?.Image !== LOCAL_MODEL_RUNTIME_IMAGE || (running && item.State?.Running !== true) || (running && health && item.State?.Health?.Status !== "healthy") || item.NetworkSettings?.Networks?.[marker.networkName]?.NetworkID !== marker.dockerNetworkId || Object.keys(item.NetworkSettings?.Networks ?? {}).length !== 1 || !item.NetworkSettings.Networks[marker.networkName].Aliases?.includes(LOCAL_N8N_MODEL_HOSTNAME) || Object.values(item.NetworkSettings?.Ports ?? {}).some(value => value !== null) || Object.keys(host?.PortBindings ?? {}).length || host?.NetworkMode === "host" || host?.Privileged !== false || !host?.CapDrop?.includes("ALL") || !host?.SecurityOpt?.includes("no-new-privileges:true") || host?.ReadonlyRootfs !== true || host?.RestartPolicy?.Name !== "no" || host?.PidsLimit !== 256 || item.Mounts?.length !== 1 || item.Mounts[0].Type !== "volume" || item.Mounts[0].Name !== owned.volume.Name || item.Mounts[0].Destination !== "/root/.ollama" || item.Mounts[0].RW !== true || host?.Memory !== marker.memoryBytes || host?.MemorySwap !== marker.memoryBytes || host?.NanoCpus !== Math.round(marker.cpus * 1e9) || !environmentMatches(item.Config?.Env, { OLLAMA_HOST: "0.0.0.0:11434", OLLAMA_NO_CLOUD: "1", OLLAMA_NOPRUNE: "1", OLLAMA_MODELS: "/root/.ollama/models", OLLAMA_CONTEXT_LENGTH: marker.contextTokens, OLLAMA_NUM_PARALLEL: "1", OLLAMA_MAX_LOADED_MODELS: "1", NVIDIA_VISIBLE_DEVICES: "void", CUDA_VISIBLE_DEVICES: "-1" })) throw new Error("The model runtime is not an attested private owned container.");
}
function attestHelper(marker, owned) {
  const item = owned.helper;
  const host = item?.HostConfig;
  if (typeof item?.State?.Running !== "boolean") throw new Error("The owned acquisition helper state is unavailable.");
  if (!item || !DIGEST.test(marker.helperImageId) || item.Image !== marker.helperImageId || item.Config?.Image !== `relmio-n8n-local-model-acquisition-${marker.installId}:local` || item.Config?.Cmd?.length !== (marker.operationExpectedDigest ? 3 : 2) || item.Config.Cmd[0] !== marker.modelId || item.Config.Cmd[1] !== marker.operationId || (marker.operationExpectedDigest && item.Config.Cmd[2] !== marker.operationExpectedDigest) || item.NetworkSettings?.Networks?.[marker.networkName]?.NetworkID !== marker.dockerNetworkId || Object.keys(item.NetworkSettings?.Networks ?? {}).length !== 1 || Object.values(item.NetworkSettings?.Ports ?? {}).some(value => value !== null) || Object.keys(host?.PortBindings ?? {}).length || host?.NetworkMode === "host" || host?.Privileged !== false || !host?.CapDrop?.includes("ALL") || !host?.SecurityOpt?.includes("no-new-privileges:true") || host?.ReadonlyRootfs !== true || host?.RestartPolicy?.Name !== "no" || host?.Memory !== 268_435_456 || host?.MemorySwap !== 268_435_456 || host?.NanoCpus !== 500_000_000 || host?.PidsLimit !== 64 || item.Mounts?.length !== 0) throw new Error("The model acquisition helper is not attested.");
}
function outcome(marker, owned, log) {
  if (!marker.operationId) return { status: "runtime-ready", modelDigest: null, progress: null, reason: null };
  if (!owned.helper) return { status: "partial", modelDigest: null, progress: null, reason: "operation-missing" };
  if (!log.trim()) {
    if (owned.helper.State?.Running === true) return { status: "downloading", modelDigest: null, progress: null, reason: null };
    if (owned.helper.State?.Status === "exited" && owned.helper.State?.ExitCode !== 0) return { status: "model-error", modelDigest: null, progress: null, reason: "acquisition-failed" };
    return { status: "partial", modelDigest: null, progress: null, reason: "operation-status-missing" };
  }
  let event;
  try { event = parseLocalModelOperationStatus(log, { modelId: marker.modelId, operationId: marker.operationId }); } catch { return { status: "partial", modelDigest: null, progress: null, reason: "operation-status-invalid" }; }
  if (event.modelDigest !== null && event.modelDigest !== marker.approvedModelDigest) return { status: "partial", modelDigest: null, progress: null, reason: "model-identity-changed" };
  const progress = event && { status: event.state, completed: event.completedBytes, total: event.totalBytes };
  if (owned.helper.State?.Running === true) return { status: "downloading", modelDigest: null, progress, reason: null };
  if (owned.helper.State?.Status === "exited" && owned.helper.State?.ExitCode === 0 && event?.state === "model-ready" && event.phase === "complete" && event.inferenceVerified === true && event.modelDigest === marker.approvedModelDigest) return { status: "model-ready", modelDigest: event.modelDigest.slice(7), progress, reason: null };
  if (owned.helper.State?.Status === "exited") return { status: "model-error", modelDigest: DIGEST.test(event?.modelDigest) ? event.modelDigest.slice(7) : null, progress, reason: event?.errorCode ?? "acquisition-failed" };
  return { status: "partial", modelDigest: null, progress, reason: "operation-unknown" };
}
function snapshot(marker, state, extra = {}) {
  return { target: LOCAL_N8N_MODEL_TARGET, managed: true, status: state, installId: marker.installId, modelId: marker.modelId, modelDigest: extra.modelDigest ?? null, endpoint: LOCAL_N8N_MODEL_ENDPOINT, networkName: marker.networkName, containerName: marker.n8nContainerName, resourceBudget: { memoryBytes: marker.memoryBytes, cpus: marker.cpus, contextTokens: marker.contextTokens }, operationId: marker.operationId, progress: extra.progress ?? null, reason: extra.reason ?? null };
}
async function observed(marker, root, boundary) {
  const owned = await resources(boundary, marker, root);
  try { attestRuntime(marker, owned); } catch { return snapshot(marker, "partial", { reason: "runtime-unavailable" }); }
  if (marker.operationId) {
    try { attestHelper(marker, owned); } catch { return snapshot(marker, "partial", { reason: "operation-unavailable" }); }
  }
  const logs = owned.helper ? await docker(boundary, marker, root, ["logs", "--tail", "12", owned.helper.Id], "Model operation status") : "";
  const result = outcome(marker, owned, logs);
  return snapshot(marker, result.status, result);
}

async function waitForRuntime(marker, root, boundary, containerId, wait) {
  for (let attempt = 0; attempt < 30; attempt++) {
    const owned = await resources(boundary, marker, root);
    if (owned.runtime?.Id !== containerId) throw new Error("The owned model runtime identity changed during startup.");
    attestRuntime(marker, owned, { health: false });
    if (owned.runtime.State.Health?.Status === "healthy") return;
    if (!["starting", "unhealthy"].includes(owned.runtime.State.Health?.Status)) throw new Error("The owned model runtime health check is missing.");
    if (attempt < 29) await wait(3000);
  }
  throw new Error("The owned model runtime did not become healthy.");
}

async function retryCandidate(marker, root, boundary, fs, platform, lockDownPath, readAcquisition, readCatalog) {
  const { contents } = await attestFiles(fs, root, marker, platform, lockDownPath);
  const owned = await resources(boundary, marker, root);
  if (owned.runtime) attestRuntime(marker, owned, { running: false });
  else await assertVacant(boundary, marker, root, "container", `${marker.projectName}-${SERVICE}-1`);
  if (owned.helper) attestHelper(marker, owned);
  else if (marker.operationName) await assertVacant(boundary, marker, root, "container", marker.operationName);
  if (!owned.volume) await assertVacant(boundary, marker, root, "volume", `${marker.projectName}_${VOLUME}`);
  const image = await ownedHelperImage(boundary, marker, root);
  if (marker.helperImageId && !image) throw new Error("The owned acquisition image is missing.");
  if (marker.operationId && !owned.runtime) throw new Error("A previous model operation lacks its owned runtime.");
  if (owned.runtime && !image) throw new Error("The owned acquisition image is missing.");
  if (marker.operationExpectedDigest && marker.operationExpectedDigest !== marker.approvedModelDigest) throw new Error("The previous model digest differs from the approved model.");
  let digest = marker.operationExpectedDigest?.slice(7) ?? null;
  if (owned.helper) {
    const log = await docker(boundary, marker, root, ["logs", "--tail", "12", owned.helper.Id], "Model operation status");
    if (log.trim()) {
      let event;
      try { event = parseLocalModelOperationStatus(log, { modelId: marker.modelId, operationId: marker.operationId }); }
      catch { throw new Error("The previous model operation status cannot be attested."); }
      if (event.modelDigest && event.modelDigest !== marker.approvedModelDigest) throw new Error("The previous model identity changed.");
      if (event.modelDigest) digest = event.modelDigest.slice(7);
    }
  }
  if (!owned.runtime || !owned.runtime.State?.Running) {
    const measured = await inspectLocalN8nModelResources(marker, { runProcess: boundary, env: {}, platform, cwd: root });
    if (measured.memoryBytes !== marker.hostResources.memoryBytes || measured.cpus !== marker.hostResources.cpus) throw new Error("The reviewed model budget changed.");
    if (!owned.runtime) {
      const current = createLocalN8nModelPlan({ dockerHost: marker.dockerHost, n8nContainerId: marker.n8nContainerId, n8nContainerName: marker.n8nContainerName, dockerNetworkId: marker.dockerNetworkId, networkName: marker.networkName, modelId: marker.modelId, hostResources: measured });
      if (current.memoryBytes !== marker.memoryBytes || current.cpus !== marker.cpus || current.contextTokens !== marker.contextTokens || current.approvedModelDigest !== marker.approvedModelDigest) throw new Error("The reviewed model budget changed.");
    }
  }
  if (!owned.runtime) {
    const acquisition = await readAcquisition();
    const catalog = await readCatalog();
    const expected = { [COMPOSE_FILE]: createLocalN8nModelComposeFile({ installId: marker.installId, networkName: marker.networkName, modelId: marker.modelId, hostResources: marker.hostResources }), "Dockerfile.acquisition": createLocalN8nModelAcquisitionDockerfile({ installId: marker.installId }), ".dockerignore": createLocalN8nModelDockerignore(), "acquisition.mjs": acquisition, "catalog.mjs": catalog };
    if (FILES.some(name => contents[name] !== expected[name])) throw new Error("The previous model bootstrap cannot be safely resumed with this package.");
    if (marker.runtimeImageId) {
      const runtime = await inspect(boundary, marker, root, "image", LOCAL_MODEL_RUNTIME_IMAGE);
      if (runtime.Id !== marker.runtimeImageId) throw new Error("Pinned runtime image identity changed.");
    }
  }
  return { owned, image, digest };
}

async function resumeBootstrap(marker, root, fs, boundary, platform, lockDownPath, builderOptions) {
  await attestFiles(fs, root, marker, platform, lockDownPath);
  await docker(boundary, marker, root, compose(marker, ["config", "--quiet"]), "Model Compose validation");
  let current = marker;
  if (!current.runtimeImageId) {
    await run(boundary, { ...dockerSpec(current, root, ["image", "pull", "--quiet", LOCAL_MODEL_RUNTIME_IMAGE]), timeoutMs: 540_000 }, "Pinned Ollama image download");
    const image = await inspect(boundary, current, root, "image", LOCAL_MODEL_RUNTIME_IMAGE);
    if (!DIGEST.test(image.Id)) throw new Error("Pinned Ollama image identity is invalid.");
    const next = { ...current, runtimeImageId: image.Id };
    await replaceMarker(fs, root, next, current, platform, lockDownPath);
    current = next;
  }
  if (!current.helperImageId) {
    let image = await ownedHelperImage(boundary, current, root);
    if (!image) {
      const attestedDockerConfig = await attestLocalDockerBuilder(current.dockerHost, builderOptions);
      await run(boundary, { ...dockerSpec(current, root, compose(current, ["--profile", HELPER, "build", "--builder", "default", "--quiet", HELPER])), attestedDockerConfig, timeoutMs: 540_000 }, "Acquisition image build");
      image = await ownedHelperImage(boundary, current, root);
    }
    if (!image) throw new Error("Acquisition image identity is invalid.");
    const next = { ...current, helperImageId: image.id };
    await replaceMarker(fs, root, next, current, platform, lockDownPath);
    current = next;
  }
  await selection(current, current, boundary, root);
  await attestFiles(fs, root, current, platform, lockDownPath);
  await docker(boundary, current, root, compose(current, ["up", "-d", "--wait", "--wait-timeout", "90", "--no-deps", SERVICE]), "Private model runtime startup");
  attestRuntime(current, await resources(boundary, current, root));
  return current;
}

export async function resolveLocalN8nModelInstallRoot({ env = process.env, homeDirectory = homedir(), fileSystem = defaultFileSystem, platform = process.platform } = {}) {
  if (typeof platform !== "string" || !platform) throw new TypeError("Invalid local platform.");
  const requested = typeof env.RELMIO_HOME === "string" && env.RELMIO_HOME.trim() ? env.RELMIO_HOME : join(homeDirectory, ".relmio");
  const home = absolute(requested);
  if (basename(home) !== ".relmio") throw new TypeError("Invalid Relmio home directory.");
  const parent = dirname(home);
  const canonical = await fileSystem.realpath(parent);
  if (canonical !== resolve(parent)) throw new Error("Symbolic-link ancestors are not allowed for managed models.");
  return join(canonical, ".relmio", "local", LOCAL_N8N_MODEL_TARGET);
}
export async function acquireLocalN8nModelChangeLock({ fileSystem = defaultFileSystem, getProcessIdentity = getLocalProcessIdentity, installRoot: root, lockDownPath = lockDownLocalPath, now = Date.now, platform = process.platform } = {}) {
  installRoot(root);
  return acquireLocalIntegrationLifecycleLock({ fileSystem, getProcessIdentity, lockDownPath, now, platform, lockPath: join(dirname(resolve(root, "..", "..")), ".relmio-local-n8n-model.lock"), label: "local n8n model operation lock" });
}

export async function inspectLocalN8nModelResources({ dockerHost, n8nContainerId, n8nContainerName, dockerNetworkId, networkName }, dependencies = {}) {
  const { runProcess = runLocalProcess, env = process.env, platform = process.platform, cwd = process.cwd() } = dependencies;
  noOverrides(env);
  const discovery = await discoverLocalN8nSidecarTargets({ runProcess, cwd, env, platform });
  if (discovery.dockerHost !== dockerHost || !discovery.containers.some(item => item.containerId === n8nContainerId && item.containerName === n8nContainerName && item.networks.some(network => network.dockerNetworkId === dockerNetworkId && network.networkName === networkName))) throw new Error("Selected local n8n target changed. Review again.");
  const network = await inspect(runProcess, { dockerHost }, cwd, "network", networkName);
  assertLocalModelNetworkEligibility(network);
  if (network.Id !== dockerNetworkId || network.Name !== networkName || !network.Containers?.[n8nContainerId]) throw new Error("Selected n8n network changed. Review again.");
  const info = parse((await run(runProcess, { file: "docker", args: ["info", "--format", "{{json .}}"], cwd, dockerHost }, "Docker engine resource inspection")).trim(), "Docker engine resource inspection");
  if (!Number.isSafeInteger(info.MemTotal) || info.MemTotal <= 0 || !Number.isFinite(info.NCPU) || info.NCPU <= 0) throw new Error("Docker engine memory or CPU allocation is unavailable.");
  const n8n = parse((await run(runProcess, { file: "docker", args: ["container", "inspect", "--format", "{{json .}}", n8nContainerId], cwd, dockerHost }, "n8n image inspection")).trim(), "n8n image inspection");
  if (n8n.Id !== n8nContainerId || n8n.Name !== `/${n8nContainerName}` || n8n.State?.Running !== true || n8n.NetworkSettings?.Networks?.[networkName]?.NetworkID !== dockerNetworkId || !DIGEST.test(n8n.Image)) throw new Error("Selected n8n identity changed during resource inspection.");
  const probe = "const s=require('node:fs').statfsSync('/');process.stdout.write(JSON.stringify({bytes:Number(s.bavail)*Number(s.bsize)}))";
  const disk = parse((await run(runProcess, { file: "docker", args: ["run", "--rm", "--pull", "never", "--network", "none", "--read-only", "--entrypoint", "node", n8n.Image, "-e", probe], cwd, dockerHost }, "Docker engine disk inspection")).trim(), "Docker engine disk inspection");
  if (!Number.isSafeInteger(disk.bytes) || disk.bytes <= 0) throw new Error("Docker engine available disk space is unavailable.");
  return { memoryBytes: info.MemTotal, cpus: info.NCPU, diskAvailableBytes: disk.bytes };
}

async function startOperation(marker, root, fs, boundary, entropy, expectedDigest = null, platform = process.platform, lockDownPath = lockDownLocalPath, builderOptions) {
  if (marker.operationId || (expectedDigest !== null && !HASH.test(expectedDigest))) throw new Error("Invalid model acquisition state.");
  const random = entropy(16);
  if (!Buffer.isBuffer(random) || random.length !== 16) throw new Error("Could not generate model operation identity.");
  const operationId = random.toString("hex");
  const next = { ...marker, operationId, operationName: `${marker.projectName}-model-pull-${operationId}`, operationExpectedDigest: expectedDigest === null ? null : `sha256:${expectedDigest}` };
  const attestedDockerConfig = await attestLocalDockerBuilder(marker.dockerHost, builderOptions);
  await assertVacant(boundary, next, root, "container", next.operationName);
  // Record the exact expected name before Docker can create it. Failed/uncertain starts remain inspectable.
  await replaceMarker(fs, root, next, marker, platform, lockDownPath);
  await attestFiles(fs, root, next, platform, lockDownPath);
  const image = await ownedHelperImage(boundary, next, root);
  if (!image || image.id !== next.helperImageId) throw new Error("The owned acquisition image changed before model download.");
  await run(boundary, { ...dockerSpec(next, root, compose(next, ["--profile", HELPER, "run", "-d", "--no-deps", "--name", next.operationName, "--label", `io.relmio.operation=${operationId}`, HELPER, next.modelId, operationId, ...(next.operationExpectedDigest ? [next.operationExpectedDigest] : [])])), attestedDockerConfig }, "Model acquisition start");
  return next;
}

export async function installLocalN8nModel({ plan, confirmed }, dependencies = {}) {
  if (confirmed !== true) throw new Error("Confirm the private local-model installation and download.");
  const { fileSystem: fs = defaultFileSystem, env = process.env, homeDirectory = homedir(), platform = process.platform, runProcess = runLocalProcess, lockDownPath = lockDownLocalPath, verifyDockerAcl, getProcessIdentity, lifecycleLockNow = Date.now, randomBytes = defaultRandomBytes, readAcquisition = () => defaultFileSystem.readFile(new URL("../local-model/acquisition.mjs", import.meta.url), "utf8"), readCatalog = () => defaultFileSystem.readFile(new URL("../local-model/catalog.mjs", import.meta.url), "utf8") } = dependencies;
  noOverrides(env);
  const normalized = normalizeLocalN8nModelPlan(plan);
  const root = await resolveLocalN8nModelInstallRoot({ fileSystem: fs, env, homeDirectory, platform });
  const release = await acquireLocalN8nModelChangeLock({ fileSystem: fs, getProcessIdentity, installRoot: root, lockDownPath, now: lifecycleLockNow, platform });
  return settleLocalIntegrationLifecycleOperation({ completionLabel: "Local model installation", releaseLock: release, operation: async () => {
    if (await managed(fs, root)) throw new Error("The managed local model already exists.");
    const random = randomBytes(16);
    if (!Buffer.isBuffer(random) || random.length !== 16) throw new Error("Could not generate model installation identity.");
    const installId = random.toString("hex");
    const marker = { schemaVersion: 1, kind: "relmio-local-n8n-model", target: LOCAL_N8N_MODEL_TARGET, installId, projectName: `${PROJECT_PREFIX}-${installId}`, dockerHost: normalized.dockerHost, n8nContainerId: normalized.n8nContainerId, n8nContainerName: normalized.n8nContainerName, dockerNetworkId: normalized.dockerNetworkId, networkName: normalized.networkName, modelId: normalized.modelId, approvedModelDigest: normalized.approvedModelDigest, hostResources: normalized.hostResources, memoryBytes: normalized.memoryBytes, cpus: normalized.cpus, contextTokens: normalized.contextTokens, runtimeImage: LOCAL_MODEL_RUNTIME_IMAGE, runtimeImageId: null, helperImageId: null, fileHashes: {}, operationId: null, operationName: null, operationExpectedDigest: null };
    const cwd = dirname(resolve(root, "..", ".."));
    if (await context(runProcess, cwd, env, platform) !== normalized.dockerHost) throw new Error("Selected Docker context changed. Review again.");
    const builderOptions = { fileSystem: fs, environment: env, homeDirectory, platform, verifyDockerAcl };
    await attestLocalDockerBuilder(normalized.dockerHost, builderOptions);
    const empty = await resources(runProcess, marker, cwd);
    if (empty.runtime || empty.helper || empty.volume) throw new Error("The model project identity is already in use.");
    await assertVacant(runProcess, marker, cwd, "container", `${marker.projectName}-${SERVICE}-1`);
    await assertVacant(runProcess, marker, cwd, "volume", `${marker.projectName}_${VOLUME}`);
    await selection(normalized, marker, runProcess, cwd);
    const measured = await inspectLocalN8nModelResources(normalized, { runProcess, env, platform, cwd });
    if (measured.memoryBytes !== normalized.hostResources.memoryBytes || measured.cpus !== normalized.hostResources.cpus) throw new Error("Docker engine resources changed. Review a fresh budget.");
    const currentBudget = createLocalN8nModelPlan({ dockerHost: normalized.dockerHost, n8nContainerId: normalized.n8nContainerId, n8nContainerName: normalized.n8nContainerName, dockerNetworkId: normalized.dockerNetworkId, networkName: normalized.networkName, modelId: normalized.modelId, hostResources: measured });
    if (currentBudget.memoryBytes !== normalized.memoryBytes || currentBudget.cpus !== normalized.cpus || currentBudget.contextTokens !== normalized.contextTokens || currentBudget.requiredDiskBytes !== normalized.requiredDiskBytes || currentBudget.reservedMemoryBytes !== normalized.reservedMemoryBytes || currentBudget.approvedModelDigest !== normalized.approvedModelDigest) throw new Error("The reviewed model budget changed.");
    const acquisition = await readAcquisition(); const catalog = await readCatalog();
    if (typeof acquisition !== "string" || typeof catalog !== "string" || !acquisition.trim() || !catalog.trim() || Buffer.byteLength(acquisition) > 512 * 1024 || Buffer.byteLength(catalog) > 512 * 1024) throw new Error("Packaged acquisition helper is invalid.");
    const composeFile = createLocalN8nModelComposeFile({ installId, networkName: normalized.networkName, modelId: normalized.modelId, hostResources: normalized.hostResources });
    const files = { [COMPOSE_FILE]: composeFile, "Dockerfile.acquisition": createLocalN8nModelAcquisitionDockerfile({ installId }), ".dockerignore": createLocalN8nModelDockerignore(), "acquisition.mjs": acquisition, "catalog.mjs": catalog };
    for (const name of FILES) marker.fileHashes[name] = hash(files[name]);
    const home = resolve(root, "..", "..");
    const homeWasAbsent = !(await stat(fs, home));
    if (homeWasAbsent) await fs.mkdir(home, { mode: 0o700 });
    await privateDirectory(fs, home, platform, lockDownPath);
    if (homeWasAbsent) await privateFile(fs, join(home, ROOT_MARKER), `${JSON.stringify({ schemaVersion: 1, kind: "relmio-local-root" })}\n`, platform, lockDownPath);
    await privateDirectory(fs, join(home, "local"), platform, lockDownPath);
    if (await stat(fs, root)) throw new Error("A local-model directory appeared during installation.");
    await fs.mkdir(root, { mode: 0o700 });
    await fs.chmod(root, 0o700);
    if (platform === "win32") await lockDownPath(root, { platform });
    for (const name of FILES) await privateFile(fs, join(root, name), files[name], platform, lockDownPath);
    await privateFile(fs, join(root, MARKER_FILE), `${JSON.stringify(marker)}\n`, platform, lockDownPath);
    await attestFiles(fs, root, marker, platform, lockDownPath);
    await docker(runProcess, marker, root, compose(marker, ["config", "--quiet"]), "Model Compose validation");
    await attestFiles(fs, root, marker, platform, lockDownPath);
    await selection(normalized, marker, runProcess, root);
    await run(runProcess, { ...dockerSpec(marker, root, ["image", "pull", "--quiet", LOCAL_MODEL_RUNTIME_IMAGE]), timeoutMs: 540_000 }, "Pinned Ollama image download");
    const runtimeImage = await inspect(runProcess, marker, root, "image", LOCAL_MODEL_RUNTIME_IMAGE);
    if (!DIGEST.test(runtimeImage.Id)) throw new Error("Pinned Ollama image identity is invalid.");
    let previous = { ...marker };
    marker.runtimeImageId = runtimeImage.Id;
    await replaceMarker(fs, root, marker, previous, platform, lockDownPath);
    const imageName = `relmio-n8n-local-model-acquisition-${installId}:local`;
    const collision = await runProcess(dockerSpec(marker, root, ["image", "inspect", imageName]));
    if (collision?.code !== 1) throw new Error("An image already claims the fresh model helper identity.");
    const attestedDockerConfig = await attestLocalDockerBuilder(marker.dockerHost, builderOptions);
    await run(runProcess, { ...dockerSpec(marker, root, compose(marker, ["--profile", HELPER, "build", "--builder", "default", "--quiet", HELPER])), attestedDockerConfig, timeoutMs: 540_000 }, "Acquisition image build");
    const helperImage = await inspect(runProcess, marker, root, "image", imageName);
    if (!DIGEST.test(helperImage.Id) || !imageLabelsMatch(helperImage.Config?.Labels, marker)) throw new Error("Acquisition image identity is invalid.");
    previous = { ...marker };
    marker.helperImageId = helperImage.Id;
    await replaceMarker(fs, root, marker, previous, platform, lockDownPath);
    await selection(normalized, marker, runProcess, root);
    await attestFiles(fs, root, marker, platform, lockDownPath);
    await docker(runProcess, marker, root, compose(marker, ["up", "-d", "--wait", "--wait-timeout", "90", "--no-deps", SERVICE]), "Private model runtime startup");
    attestRuntime(marker, await resources(runProcess, marker, root));
    const next = await startOperation(marker, root, fs, runProcess, randomBytes, null, platform, lockDownPath, builderOptions);
    return observed(next, root, runProcess);
  } });
}

export async function getLocalN8nModelStatus(dependencies = {}) {
  const { fileSystem: fs = defaultFileSystem, env = process.env, homeDirectory = homedir(), platform = process.platform, runProcess = runLocalProcess, lockDownPath = lockDownLocalPath } = dependencies;
  const absent = { target: LOCAL_N8N_MODEL_TARGET, managed: false, status: "absent", installId: null, modelId: null, modelDigest: null, endpoint: null, networkName: null, containerName: null, resourceBudget: null, operationId: null, progress: null, reason: null };
  try {
    const root = await resolveLocalN8nModelInstallRoot({ fileSystem: fs, env, homeDirectory, platform });
    if (!(await stat(fs, root))) return absent;
    const marker = await managed(fs, root);
    if (!marker) return absent;
    if (await context(runProcess, root, env, platform) !== marker.dockerHost) return { ...absent, status: "unavailable" };
    await attestFiles(fs, root, marker, platform, lockDownPath);
    return await observed(marker, root, runProcess);
  } catch { return { ...absent, status: "unavailable" }; }
}

export async function reviewLocalN8nModelAction({ action, removeModelData = false }, dependencies = {}) {
  if (!["retry", "remove"].includes(action) || typeof removeModelData !== "boolean" || (action === "retry" && removeModelData) || (action === "remove" && !removeModelData)) throw new TypeError("A full model removal must separately include model cache deletion.");
  const status = await getLocalN8nModelStatus(dependencies);
  if (!status.managed || (action === "retry" && !["model-error", "runtime-ready", "partial"].includes(status.status)) || (action === "remove" && !["partial", "runtime-ready", "model-ready", "model-error"].includes(status.status))) throw new Error("The model installation is not safe for this action.");
  let digest = status.modelDigest;
  if (action === "retry" && status.status === "partial") {
    try {
      const { fileSystem: fs = defaultFileSystem, env = process.env, homeDirectory = homedir(), platform = process.platform, runProcess = runLocalProcess, lockDownPath = lockDownLocalPath, readAcquisition = () => defaultFileSystem.readFile(new URL("../local-model/acquisition.mjs", import.meta.url), "utf8"), readCatalog = () => defaultFileSystem.readFile(new URL("../local-model/catalog.mjs", import.meta.url), "utf8") } = dependencies;
      const root = await resolveLocalN8nModelInstallRoot({ fileSystem: fs, env, homeDirectory, platform });
      const marker = await managed(fs, root);
      if (!marker || await context(runProcess, root, env, platform) !== marker.dockerHost) throw new Error("Selected Docker context changed.");
      digest = (await retryCandidate(marker, root, runProcess, fs, platform, lockDownPath, readAcquisition, readCatalog)).digest;
    } catch { throw new Error("The model installation is not safe for retry."); }
  }
  return { action, installId: status.installId, modelId: status.modelId, modelDigest: digest, endpoint: status.endpoint, removeModelData, networkName: status.networkName, containerName: status.containerName, resourceBudget: status.resourceBudget, operationId: status.operationId };
}

export async function applyLocalN8nModelAction({ review, confirmed }, dependencies = {}) {
  if (confirmed !== true) throw new Error("Confirm the reviewed model action and its storage effect.");
  const { fileSystem: fs = defaultFileSystem, env = process.env, homeDirectory = homedir(), platform = process.platform, runProcess = runLocalProcess, lockDownPath = lockDownLocalPath, verifyDockerAcl, getProcessIdentity, lifecycleLockNow = Date.now, randomBytes = defaultRandomBytes, wait = delay, readAcquisition = () => defaultFileSystem.readFile(new URL("../local-model/acquisition.mjs", import.meta.url), "utf8"), readCatalog = () => defaultFileSystem.readFile(new URL("../local-model/catalog.mjs", import.meta.url), "utf8") } = dependencies;
  noOverrides(env);
  const root = await resolveLocalN8nModelInstallRoot({ fileSystem: fs, env, homeDirectory, platform });
  const release = await acquireLocalN8nModelChangeLock({ fileSystem: fs, getProcessIdentity, installRoot: root, lockDownPath, now: lifecycleLockNow, platform });
  return settleLocalIntegrationLifecycleOperation({ completionLabel: "Local model action", releaseLock: release, operation: async () => {
    const marker = await managed(fs, root);
    if (!marker) throw new Error("The managed local model is not installed.");
    await attestFiles(fs, root, marker, platform, lockDownPath);
    if (await context(runProcess, root, env, platform) !== marker.dockerHost) throw new Error("Selected Docker context changed.");
    const builderOptions = { fileSystem: fs, environment: env, homeDirectory, platform, verifyDockerAcl };
    if (review?.action === "retry") await attestLocalDockerBuilder(marker.dockerHost, builderOptions);
    const current = await reviewLocalN8nModelAction({ action: review?.action, removeModelData: review?.removeModelData }, { ...dependencies, fileSystem: fs, env, homeDirectory, platform, runProcess });
    if (JSON.stringify(current) !== JSON.stringify(review)) throw new Error("The reviewed model installation changed.");
    const candidate = review.action === "retry" ? await retryCandidate(marker, root, runProcess, fs, platform, lockDownPath, readAcquisition, readCatalog) : null;
    const owned = candidate?.owned ?? await resources(runProcess, marker, root);
    if (owned.runtime) attestRuntime(marker, owned, { running: false });
    else await assertVacant(runProcess, marker, root, "container", `${marker.projectName}-${SERVICE}-1`);
    if (owned.helper) attestHelper(marker, owned);
    else if (marker.operationName) await assertVacant(runProcess, marker, root, "container", marker.operationName);
    if (!owned.volume) await assertVacant(runProcess, marker, root, "volume", `${marker.projectName}_${VOLUME}`);
    const helperImage = candidate ? candidate.image : await ownedHelperImage(runProcess, marker, root);
    if (review.action === "retry") {
      await selection(marker, marker, runProcess, root);
      if (owned.runtime) {
        if (owned.runtime.State?.Running) await docker(runProcess, marker, root, ["container", "stop", "--time", "30", owned.runtime.Id], "Owned model writer shutdown");
        const stopped = await resources(runProcess, marker, root);
        if (stopped.runtime?.Id !== owned.runtime.Id || stopped.runtime.State?.Running !== false) throw new Error("Model writer shutdown could not be proved.");
        attestRuntime(marker, stopped, { running: false });
      }
      if (owned.helper) {
        if (owned.helper.State?.Running) await docker(runProcess, marker, root, ["container", "stop", "--time", "30", owned.helper.Id], "Owned model acquisition shutdown");
        const stopped = await resources(runProcess, marker, root);
        if (stopped.helper?.Id !== owned.helper.Id || stopped.helper.State?.Running !== false) throw new Error("Model acquisition shutdown could not be proved.");
        attestHelper(marker, stopped);
        await docker(runProcess, marker, root, ["container", "rm", owned.helper.Id], "Previous model operation removal");
        await assertVacant(runProcess, marker, root, "container", marker.operationName);
      }
      let active = marker;
      if (marker.operationId) {
        active = { ...marker, operationId: null, operationName: null, operationExpectedDigest: null };
        await replaceMarker(fs, root, active, marker, platform, lockDownPath);
      }
      if (!owned.runtime) active = await resumeBootstrap(active, root, fs, runProcess, platform, lockDownPath, builderOptions);
      else {
        await docker(runProcess, active, root, ["container", "start", owned.runtime.Id], "Owned model runtime restart");
        await waitForRuntime(active, root, runProcess, owned.runtime.Id, wait);
      }
      await attestFiles(fs, root, active, platform, lockDownPath);
      await selection(active, active, runProcess, root);
      const next = await startOperation(active, root, fs, runProcess, randomBytes, review.modelDigest, platform, lockDownPath, builderOptions);
      return observed(next, root, runProcess);
    }
    if (review.action !== "remove" || review.removeModelData !== true) throw new Error("Cache-deleting removal was not reviewed.");
    if (owned.helper?.State?.Running) throw new Error("Model acquisition is still active; removal was not started.");
    if (owned.runtime?.State?.Running) {
      await docker(runProcess, marker, root, ["container", "stop", "--time", "30", owned.runtime.Id], "Owned model writer shutdown");
      const stopped = await inspect(runProcess, marker, root, "container", owned.runtime.Id);
      if (stopped.Id !== owned.runtime.Id || stopped.State?.Running !== false) throw new Error("Model writer shutdown could not be proved.");
    }
    if (owned.runtime) await docker(runProcess, marker, root, ["container", "rm", owned.runtime.Id], "Owned model runtime removal");
    if (owned.helper) await docker(runProcess, marker, root, ["container", "rm", owned.helper.Id], "Completed model operation removal");
    if (owned.volume) await docker(runProcess, marker, root, ["volume", "rm", owned.volume.Name], "Owned model cache deletion");
    const remaining = await resources(runProcess, marker, root);
    if (remaining.helper || remaining.runtime || remaining.volume) throw new Error("Owned Docker resources remain; managed files were retained.");
    if (helperImage) {
      await docker(runProcess, marker, root, ["image", "rm", helperImage.name], "Owned acquisition image removal");
      if (await ownedHelperImage(runProcess, marker, root)) throw new Error("Owned helper image remains; managed files were retained.");
    }
    const { id, contents } = await attestFiles(fs, root, marker, platform, lockDownPath);
    const detached = join(dirname(root), `.${basename(root)}.cleanup-${randomUUID()}`);
    if (await stat(fs, detached)) throw new Error("Could not reserve managed cleanup directory.");
    await fs.rename(root, detached);
    try {
      const actual = await directoryId(fs, detached);
      if (actual.dev !== id.dev || actual.ino !== id.ino || (await fs.readdir(detached)).length !== Object.keys(contents).length) throw new Error("Managed directory changed during removal.");
      for (const [name, text] of Object.entries(contents)) if (await fs.readFile(join(detached, name), "utf8") !== text) throw new Error("Managed file changed during removal.");
      await fs.rm(detached, { recursive: true, force: false });
    } catch (error) { if (!(await stat(fs, root))) try { await fs.rename(detached, root); } catch {} throw error; }
    return { target: LOCAL_N8N_MODEL_TARGET, removed: true, cacheRetained: false };
  } });
}

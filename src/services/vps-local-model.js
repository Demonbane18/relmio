import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { isDeepStrictEqual } from "node:util";
import { validateDockerName } from "../domain/validation.js";
import { validateDockerObjectId } from "../domain/local-n8n-sidecar.js";
import { validateInstallId } from "../domain/local-endpoints.js";
import { INSTALL_ROOT, PRECHECK_COMMAND, SHARED_ROOT_MARKER_PATH, SHARED_ROOT_MARKER_CONTENT } from "../domain/safety.js";
import { createLocalN8nModelPlan, createLocalN8nModelComposeFile, createLocalN8nModelAcquisitionDockerfile, createLocalN8nModelDockerignore, getLocalModelDefinition, hasEnabledNoNewPrivileges, LOCAL_N8N_MODEL_ENDPOINT, LOCAL_N8N_MODEL_TARGET, LOCAL_MODEL_RUNTIME_IMAGE } from "../domain/local-n8n-model.js";
import { parseLocalModelOperationStatus } from "../local-model/acquisition.mjs";
import { assertLocalModelNetworkEligibility } from "../domain/local-model-network.js";
import { withVpsOperationLock } from "./vps-operation-lock.js";

export const VPS_LOCAL_MODEL_ROOT = `${INSTALL_ROOT}/local-model`;
const ROOT = VPS_LOCAL_MODEL_ROOT;
const MARKER = `${ROOT}/.managed-by-relmio.json`;
const MARKER_NEXT = `${ROOT}/.managed-by-relmio.json.next`;
const LOCK = `${INSTALL_ROOT}/.local-model-operation.lock`;
const FILES = ["Dockerfile.acquisition", ".dockerignore", "catalog.mjs", "acquisition.mjs", "compose.yaml"];
const IMAGE_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const DIGEST_PATTERN = /^sha256:[a-f0-9]{64}$/u;
const OPERATION_PATTERN = /^[a-f0-9]{32}$/u;
const parentGuard = `[ -d /docker ] && [ ! -L /docker ] && [ ! -L ${INSTALL_ROOT} ]`;
const hash = value => createHash("sha256").update(value).digest("hex");
const fail = () => new Error("The VPS local-model ownership or safety check failed. No unverified resource was changed.");
const parse = text => { try { return JSON.parse(text); } catch { throw fail(); } };
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;

async function run(remote, command) {
  const result = await remote.exec(command);
  if (result.code !== 0) throw fail();
  return result.stdout.trim();
}

async function requireSafeDockerParent(remote) {
  const result = await remote.exec("[ -d /docker ] && [ ! -L /docker ] && stat -c %u:%a /docker");
  const metadata = result.code === 0 && /^0:([0-7]{3,4})$/u.exec(result.stdout.trim());
  if (!metadata || (Number.parseInt(metadata[1], 8) & 0o022) !== 0) {
    throw new Error("Administrator prerequisite: provide an existing root-owned /docker directory that is not a symbolic link or writable by group/others, then review again. Relmio will not create or repair /docker; writes are limited to /docker/n8n-openai-oauth.");
  }
}

function identity(marker) {
  validateInstallId(marker.installId);
  validateDockerName(marker.containerName);
  validateDockerName(marker.networkName);
  validateDockerObjectId(marker.containerId, "n8n container");
  validateDockerObjectId(marker.networkId, "network");
  getLocalModelDefinition(marker.modelId);
  if (marker.projectName !== `relmio-n8n-local-model-${marker.installId}`) throw fail();
  return {
    container: `${marker.projectName}-local-model-1`,
    operation: `${marker.projectName}-acquisition`,
    volume: `${marker.projectName}_model-cache`,
    helperImage: `relmio-n8n-local-model-acquisition-${marker.installId}:local`,
  };
}

function validateMarker(marker) {
  if (!marker || marker.schemaVersion !== 1 || marker.kind !== "relmio-vps-local-model" ||
      !marker.hostResources || typeof marker.hostResources !== "object" ||
      Object.keys(marker.hostResources).sort().join() !== "cpus,diskAvailableBytes,memoryBytes" ||
      !marker.files || Object.keys(marker.files).sort().join() !== [...FILES].sort().join() ||
      FILES.some(file => !/^[a-f0-9]{64}$/u.test(marker.files[file])) ||
      (marker.runtimeImageId !== null && !IMAGE_PATTERN.test(marker.runtimeImageId)) ||
      (marker.helperImageId !== null && !IMAGE_PATTERN.test(marker.helperImageId)) ||
      (marker.operationId !== null && !OPERATION_PATTERN.test(marker.operationId)) ||
      (marker.modelDigest !== null && (!DIGEST_PATTERN.test(marker.modelDigest) ||
        marker.modelDigest !== marker.approvedModelDigest)) ||
      !DIGEST_PATTERN.test(marker.approvedModelDigest)) throw fail();
  identity(marker);
  if (planFor(marker.containerName, marker.networkName, marker.containerId, marker.networkId, marker.modelId,
    marker.hostResources).approvedModelDigest !== marker.approvedModelDigest) throw fail();
  return marker;
}

function planFor(containerName, networkName, containerId, networkId, modelId, hostResources) {
  return createLocalN8nModelPlan({
    dockerHost: "unix:///var/run/docker.sock",
    n8nContainerId: validateDockerObjectId(containerId, "n8n container"),
    n8nContainerName: validateDockerName(containerName),
    dockerNetworkId: validateDockerObjectId(networkId, "network"),
    networkName: validateDockerName(networkName),
    modelId: getLocalModelDefinition(modelId).id,
    hostResources,
  });
}

async function readMarker(remote) {
  await requireSafeDockerParent(remote);
  const text = await run(remote, `${parentGuard} && if [ ! -e ${ROOT} ]; then printf absent; else [ ! -L ${ROOT} ] && [ -d ${ROOT} ] && [ "$(stat -c %u:%a ${ROOT})" = 0:700 ] && [ ! -L ${MARKER} ] && [ -f ${MARKER} ] && [ "$(stat -c %u:%a:%h ${MARKER})" = 0:600:1 ] && [ "$(stat -c %s ${MARKER})" -le 16384 ] && cat ${MARKER}; fi`);
  if (text !== "absent") return validateMarker(parse(text));
  // A missing marker cannot authorize a second installation over an orphaned
  // project or model cache. Such resources require manual ownership recovery.
  const containers = await run(remote, "docker ps -a --filter label=io.relmio.target=n8n-local-model --format '{{.Names}}'");
  const volumes = await run(remote, "docker volume ls --filter label=io.relmio.target=n8n-local-model --format '{{.Name}}'");
  if (containers || volumes) throw fail();
  return null;
}

async function attestFiles(remote, marker, { partial = false } = {}) {
  const listed = await run(remote, `${parentGuard} && [ ! -L ${ROOT} ] && [ -d ${ROOT} ] && find ${ROOT} -mindepth 1 -maxdepth 1 -printf '%f\n'`);
  if (listed.split("\n").some(name => ![...FILES, ".managed-by-relmio.json", ".managed-by-relmio.json.next"].includes(name))) throw fail();
  await run(remote, `[ ! -L ${MARKER_NEXT} ] && { [ ! -e ${MARKER_NEXT} ] || { [ -f ${MARKER_NEXT} ] && [ "$(stat -c %u:%a:%h ${MARKER_NEXT})" = 0:600:1 ] && [ "$(stat -c %s ${MARKER_NEXT})" -le 16384 ]; }; }`);
  for (const name of FILES) {
    const file = `${ROOT}/${name}`;
    await run(remote, `[ ! -L ${file} ] && ${partial ? `if [ -e ${file} ]; then ` : ""}[ -f ${file} ] && [ "$(stat -c %u:%a ${file})" = 0:600 ] && [ "$(sha256sum ${file} | cut -d ' ' -f 1)" = ${marker.files[name]} ]${partial ? "; fi" : ""}`);
  }
}

async function inspectOptional(remote, type, name) {
  const safeName = validateDockerName(name);
  if (!["container", "volume"].includes(type)) throw fail();
  const result = await remote.exec(`docker ${type} inspect ${safeName}`);
  if (result.code !== 0) {
    const listed = await run(remote, type === "container" ? "docker ps -a --format '{{.Names}}'" : "docker volume ls --format '{{.Name}}'");
    if (listed.split("\n").includes(safeName)) throw fail();
    return null;
  }
  const values = parse(result.stdout);
  if (!Array.isArray(values) || values.length !== 1) throw fail();
  return values[0];
}

function owned(labels, marker) {
  return labels?.["io.relmio.managed"] === "true" && labels?.["io.relmio.target"] === LOCAL_N8N_MODEL_TARGET &&
    labels?.["io.relmio.install"] === marker.installId && labels?.["com.docker.compose.project"] === marker.projectName;
}

function noPublication(item) {
  return item.HostConfig && Object.keys(item.HostConfig.PortBindings ?? {}).length === 0 &&
    Object.values(item.NetworkSettings?.Ports ?? {}).every(value => value === null) &&
    item.HostConfig.NetworkMode !== "host" && item.HostConfig.Privileged !== true &&
    !item.Mounts?.some(mount => mount.Destination === "/var/run/docker.sock");
}

function attestContainer(item, marker, helper) {
  const names = identity(marker);
  const budget = planFor(marker.containerName, marker.networkName, marker.containerId, marker.networkId, marker.modelId, marker.hostResources);
  const host = item.HostConfig;
  if (!owned(item.Config?.Labels, marker) ||
      item.Config.Labels["com.docker.compose.service"] !== (helper ? "acquisition" : "local-model") ||
      item.Name !== `/${helper ? names.operation : names.container}` || item.Id === marker.containerId ||
      item.Config.Image !== (helper ? marker.helperImageId : LOCAL_MODEL_RUNTIME_IMAGE) ||
      (helper ? marker.helperImageId && item.Image !== marker.helperImageId : marker.runtimeImageId && item.Image !== marker.runtimeImageId) ||
      !noPublication(item) || Object.keys(item.NetworkSettings?.Networks ?? {}).length !== 1 ||
      item.NetworkSettings.Networks[marker.networkName]?.NetworkID !== marker.networkId ||
      host?.ReadonlyRootfs !== true || !host.CapDrop?.includes("ALL") ||
      !hasEnabledNoNewPrivileges(host.SecurityOpt) || host.RestartPolicy?.Name !== "no" ||
      host.Memory !== (helper ? 268435456 : budget.memoryBytes) ||
      host.MemorySwap !== (helper ? 268435456 : budget.memoryBytes) ||
      host.NanoCpus !== (helper ? 500000000 : Math.round(budget.cpus * 1e9)) ||
      (helper ? (item.Mounts?.length !== 0 || item.Config.Labels["io.relmio.operation"] !== marker.operationId ||
        !Array.isArray(item.Config.Cmd) || item.Config.Cmd[0] !== marker.modelId || item.Config.Cmd[1] !== marker.operationId ||
        item.Config.Cmd.length !== (marker.modelDigest ? 3 : 2) ||
        (marker.modelDigest && item.Config.Cmd[2] !== marker.modelDigest)) :
        (item.Mounts?.length !== 1 || item.Mounts[0].Type !== "volume" || item.Mounts[0].Name !== names.volume ||
        item.Mounts[0].Destination !== "/root/.ollama" || item.Mounts[0].RW !== true ||
        !item.Config.Env?.includes("OLLAMA_NO_CLOUD=1") || !item.Config.Env?.includes("OLLAMA_NOPRUNE=1") ||
        !item.Config.Env?.includes("OLLAMA_NUM_PARALLEL=1") ||
        !item.Config.Env?.includes(`OLLAMA_CONTEXT_LENGTH=${budget.contextTokens}`) ||
        !item.NetworkSettings.Networks[marker.networkName].Aliases?.includes("n8n-local-model")))) throw fail();
}

async function attestResources(remote, marker) {
  const names = identity(marker);
  const container = await inspectOptional(remote, "container", names.container);
  const operation = await inspectOptional(remote, "container", names.operation);
  const volume = await inspectOptional(remote, "volume", names.volume);
  if (container && !volume || operation && !marker.operationId) throw fail();
  if (container) attestContainer(container, marker, false);
  if (operation) attestContainer(operation, marker, true);
  if (volume && (!owned(volume.Labels, marker) || volume.Name !== names.volume)) throw fail();
  const containers = await run(remote, `docker ps -a --filter label=com.docker.compose.project=${marker.projectName} --format '{{.Names}}'`);
  if (containers && containers.split("\n").some(name => ![names.container, names.operation].includes(name))) throw fail();
  const volumes = await run(remote, `docker volume ls --filter label=com.docker.compose.project=${marker.projectName} --format '{{.Name}}'`);
  if (volumes && volumes.split("\n").some(name => name !== names.volume)) throw fail();
  return { container, operation, volume };
}

async function boundary(remote, containerName, networkName, expected = null) {
  const container = validateDockerName(containerName);
  const network = validateDockerName(networkName);
  const [id, running, networks] = (await run(remote, `docker inspect ${container} --format '{{json .Id}}|{{json .State.Running}}|{{json .NetworkSettings.Networks}}'`)).split("|");
  const n8nId = validateDockerObjectId(parse(id), "n8n container");
  const members = parse(networks);
  if (parse(running) !== true || !members?.[network]) throw new Error("The selected n8n container or network changed. Review again.");
  const net = parse(await run(remote, `docker network inspect ${network} --format '{{json .}}'`));
  const networkId = validateDockerObjectId(net.Id, "network");
  assertLocalModelNetworkEligibility(net);
  if (net.Name !== network ||
      !members[network] || members[network].NetworkID !== networkId ||
      (expected && (expected.containerId !== n8nId || expected.networkId !== networkId))) throw fail();
  const attached = Object.entries(net.Containers ?? {});
  if (attached.length > 100) throw fail();
  for (const [id, item] of attached) {
    const checked = validateDockerObjectId(id, "connected container");
    const aliases = parse(await run(remote, `docker inspect ${checked} --format '{{json .NetworkSettings.Networks}}'`))[network]?.Aliases;
    if ([item.Name, ...(Array.isArray(aliases) ? aliases : [])].some(alias => ["n8n-local-model", "local-model"].includes(alias)) &&
        (!expected || item.Name !== identity(expected).container)) throw new Error("The local-model hostname is already in use. Nothing was changed.");
  }
  return { containerId: n8nId, networkId };
}

async function resources(remote, modelId) {
  const info = (await run(remote, "docker info --format '{{json .MemTotal}}|{{json .NCPU}}|{{json .DockerRootDir}}'" )).split("|");
  if (info.length !== 3) throw fail();
  const memoryBytes = parse(info[0]);
  const cpus = parse(info[1]);
  const dockerRoot = parse(info[2]);
  if (!Number.isSafeInteger(memoryBytes) || memoryBytes <= 0 || !Number.isInteger(cpus) || cpus <= 0 ||
      typeof dockerRoot !== "string" || !/^\/[a-zA-Z0-9_.\/-]+$/u.test(dockerRoot) || dockerRoot.includes("..") || dockerRoot.length > 256) throw fail();
  const available = await run(remote, `df -B1 --output=avail -- ${quote(dockerRoot)}`);
  const fields = available.split(/\s+/u);
  const diskAvailableBytes = Number(fields.at(-1));
  const meminfo = await run(remote, "sed -n 's/^MemAvailable:[[:space:]]*\\([0-9][0-9]*\\) kB$/\\1/p' /proc/meminfo");
  const freeBytes = Number(meminfo) * 1024;
  if (!Number.isSafeInteger(diskAvailableBytes) || diskAvailableBytes <= 0 ||
      !Number.isSafeInteger(freeBytes) || freeBytes <= 0) throw fail();
  // Docker's total allocation is the domain budget; MemAvailable is a separate
  // present-tense check, not another allowance from which to reserve n8n twice.
  const usableFreeBytes = Math.min(memoryBytes, freeBytes);
  if (usableFreeBytes < getLocalModelDefinition(modelId).memoryBytes + 512 * 1024 ** 2) {
    throw new RangeError("Available VPS memory is insufficient for the selected model and acquisition headroom.");
  }
  return { memoryBytes, cpus, diskAvailableBytes };
}

function checkPresentCapacity(marker, measured, cachedRetry = false) {
  if (cachedRetry && measured.diskAvailableBytes < 1024 ** 3) {
    throw new RangeError("Available VPS disk is insufficient for cached model verification and logs.");
  }
  const required = cachedRetry
    ? Math.max(measured.diskAvailableBytes, planFor(marker.containerName, marker.networkName,
      marker.containerId, marker.networkId, marker.modelId, marker.hostResources).requiredDiskBytes)
    : measured.diskAvailableBytes;
  // A verified cached inference retry does not re-download weights, but still
  // needs current memory/CPU capacity and free disk for logs and temporary data.
  planFor(marker.containerName, marker.networkName, marker.containerId, marker.networkId,
    marker.modelId, { ...measured, diskAvailableBytes: required });
}

function isCachedRetry(marker, status) {
  return status.state === "model-error" && status.operation?.modelDigest === marker.approvedModelDigest &&
    status.operation.writerMayBeActive === false;
}

async function operationStatus(remote, marker, inspected = null) {
  if (!marker.operationId) return null;
  const item = inspected ?? (await attestResources(remote, marker)).operation;
  if (!item) return { state: "partial", phase: "unknown", completedBytes: null, totalBytes: null, modelDigest: null, errorCode: null, writerMayBeActive: true };
  const output = await run(remote, `docker logs --tail 12 ${validateDockerObjectId(item.Id, "acquisition container")}`);
  if (output === "") return { state: item.State?.Running ? "downloading" : "partial", phase: "unknown",
    completedBytes: null, totalBytes: null, modelDigest: null, errorCode: null, writerMayBeActive: true };
  let latest;
  try { latest = parseLocalModelOperationStatus(output, { modelId: marker.modelId, operationId: marker.operationId }); }
  catch { return { state: "partial", phase: "unknown", completedBytes: null, totalBytes: null, modelDigest: null, errorCode: null, writerMayBeActive: true }; }
  if (latest.modelDigest !== null && latest.modelDigest !== marker.approvedModelDigest) throw fail();
  let state = latest.state;
  if (state === "model-ready" && (item.State?.Running || item.State?.ExitCode !== 0 || latest.inferenceVerified !== true)) state = "partial";
  if (state === "model-error" && item.State?.Running) state = "partial";
  if ((state === "downloading" || state === "verifying") && item.State?.Running !== true) state = "partial";
  return { state, phase: latest.phase, completedBytes: latest.completedBytes, totalBytes: latest.totalBytes,
    modelDigest: latest.modelDigest, errorCode: latest.errorCode, writerMayBeActive: state === "partial" || latest.writerMayBeActive === true };
}

async function inspectInstalled(remote, marker) {
  await attestFiles(remote, marker, { partial: true });
  const found = await attestResources(remote, marker);
  const operation = await operationStatus(remote, marker, found.operation);
  let state = "partial";
  if (found.container?.State?.Running === true && found.container?.State?.Health?.Status === "healthy" &&
      marker.runtimeImageId && marker.helperImageId) {
    await attestFiles(remote, marker);
    state = !operation ? "runtime-ready" : operation.state === "model-ready" && (!marker.modelDigest || operation.modelDigest === marker.modelDigest) ? "model-ready" : operation.state === "model-error" ? "model-error" : operation.state === "partial" ? "partial" : "downloading";
  }
  return { state, containerId: marker.containerId, networkId: marker.networkId, installId: marker.installId,
    endpoint: LOCAL_N8N_MODEL_ENDPOINT, modelId: marker.modelId, operation };
}

export async function inspectVpsLocalModel({ remote, containerName, networkName }) {
  validateDockerName(containerName);
  validateDockerName(networkName);
  const marker = await readMarker(remote);
  if (!marker) {
    try {
      const selected = await boundary(remote, containerName, networkName);
      return { state: "absent", ...selected, installId: null, endpoint: LOCAL_N8N_MODEL_ENDPOINT, modelId: null, operation: null };
    } catch {
      return { state: "unavailable", containerId: null, networkId: null, installId: null,
        endpoint: LOCAL_N8N_MODEL_ENDPOINT, modelId: null, operation: null };
    }
  }
  if (marker.containerName !== containerName || marker.networkName !== networkName) throw new Error("This model belongs to another n8n selection.");
  const status = await inspectInstalled(remote, marker);
  try { await boundary(remote, containerName, networkName, marker); }
  catch { return { ...status, state: "unavailable" }; }
  return status;
}

function reviewShape(action, marker, selected, modelId, hostResources, clearModelCache) {
  const domain = planFor(marker?.containerName ?? selected.containerName, marker?.networkName ?? selected.networkName,
    selected.containerId, selected.networkId, modelId, hostResources);
  return { action, containerName: domain.n8nContainerName, networkName: domain.networkName,
    containerId: domain.n8nContainerId, networkId: domain.dockerNetworkId, installId: marker?.installId ?? null,
    installDirectory: ROOT, operationLockPath: LOCK,
    temporaryBuildStatePath: action === "remove" ? null : `${LOCK}/buildx`,
    sharedRootBootstrap: action === "install" ? {
      directory: INSTALL_ROOT, markerPath: SHARED_ROOT_MARKER_PATH,
      mayCreateDirectory: true, mayCreateMarker: true, preservesExistingMode: true,
    } : null,
    endpoint: LOCAL_N8N_MODEL_ENDPOINT, modelId, catalogRevision: domain.catalogRevision,
    approvedModelDigest: domain.approvedModelDigest, runtimeImage: domain.runtimeImage,
    contextTokens: domain.contextTokens, memoryBytes: domain.memoryBytes,
    cpus: domain.cpus, expectedDownloadBytes: domain.expectedDownloadBytes, requiredDiskBytes: domain.requiredDiskBytes,
    reservedMemoryBytes: domain.reservedMemoryBytes, hostResources: domain.hostResources,
    clearModelCache, publishedPorts: [], existingN8nChanges: [], existingN8nRestarts: 0 };
}

export async function reviewVpsLocalModel({ remote, containerName, networkName, action, modelId, clearModelCache }) {
  if (!["install", "retry", "remove"].includes(action)) throw new TypeError("Choose a supported model action.");
  validateDockerName(containerName);
  validateDockerName(networkName);
  if (action === "remove" ? clearModelCache !== true : clearModelCache !== undefined) throw new TypeError("Model-cache deletion requires a separate reviewed confirmation.");
  if (action === "install") getLocalModelDefinition(modelId);
  const marker = await readMarker(remote);
  if (action === "install" && marker || action !== "install" && !marker) throw new Error("Refresh the model installation before this action.");
  if (marker && (marker.containerName !== containerName || marker.networkName !== networkName ||
      modelId !== undefined && modelId !== marker.modelId)) throw fail();
  const selected = action === "remove" && marker
    ? { containerId: marker.containerId, networkId: marker.networkId }
    : await boundary(remote, containerName, networkName, marker);
  let status = null;
  if (marker) {
    status = await inspectInstalled(remote, marker);
    if (action === "retry" && !["model-error", "runtime-ready"].includes(status.state)) {
      if (status.state !== "partial") {
        throw new Error("The model is not ready for this action. Refresh its status.");
      }
      await attestFiles(remote, marker);
    }
  }
  const measured = action === "remove" ? null : await resources(remote, marker?.modelId ?? modelId);
  const budget = action === "install" ? measured : marker.hostResources;
  const selection = { ...selected, containerName, networkName };
  const plan = reviewShape(action, marker, selection, marker?.modelId ?? modelId, budget, clearModelCache === true);
  if (action === "install") planFor(containerName, networkName, selected.containerId, selected.networkId, plan.modelId, measured);
  else if (action === "retry") checkPresentCapacity(marker, measured, isCachedRetry(marker, status));
  return plan;
}

function validatePlan(plan, action) {
  if (!plan || plan.action !== action || plan.installDirectory !== ROOT || plan.endpoint !== LOCAL_N8N_MODEL_ENDPOINT ||
      plan.clearModelCache !== (action === "remove") || !Array.isArray(plan.publishedPorts) || plan.publishedPorts.length ||
      !Array.isArray(plan.existingN8nChanges) || plan.existingN8nChanges.length || plan.existingN8nRestarts !== 0 ||
      (action === "install" ? plan.installId !== null : (validateInstallId(plan.installId), false))) throw fail();
  const selected = { containerName: plan.containerName, networkName: plan.networkName,
    containerId: plan.containerId, networkId: plan.networkId };
  const expected = reviewShape(action, action === "install" ? null : { ...selected, installId: plan.installId },
    selected, plan.modelId, plan.hostResources, action === "remove");
  if (!isDeepStrictEqual(plan, expected)) throw fail();
  return plan;
}

async function withLock(remote, operation) {
  await requireSafeDockerParent(remote);
  return withVpsOperationLock(remote, LOCK, operation);
}

function compose(marker) {
  identity(marker);
  return `docker compose --project-name ${marker.projectName} --file ${ROOT}/compose.yaml`;
}

async function publishMarker(remote, marker, { initial = false } = {}) {
  validateMarker(marker);
  const contents = JSON.stringify(marker);
  if (Buffer.byteLength(contents) > 16384) throw fail();
  const rootId = await run(remote, `${parentGuard} && [ ! -L ${ROOT} ] && [ "$(stat -c %u:%a ${ROOT})" = 0:700 ] && stat -c '%d:%i' ${ROOT}`);
  if (!/^\d+:\d+$/u.test(rootId)) throw fail();
  const oldHash = initial ? null : await run(remote, `[ ! -L ${MARKER} ] && [ -f ${MARKER} ] && [ "$(stat -c %u:%a:%h ${MARKER})" = 0:600:1 ] && sha256sum ${MARKER} | cut -d ' ' -f 1`);
  if (oldHash !== null && !/^[a-f0-9]{64}$/u.test(oldHash)) throw fail();
  await run(remote, `[ ! -L ${MARKER_NEXT} ] && { [ ! -e ${MARKER_NEXT} ] || { [ -f ${MARKER_NEXT} ] && [ "$(stat -c %u:%a:%h ${MARKER_NEXT})" = 0:600:1 ]; }; }`);
  await remote.upload(MARKER_NEXT, contents, 0o600);
  const original = initial
    ? `[ ! -e ${MARKER} ] && [ ! -L ${MARKER} ]`
    : `[ ! -L ${MARKER} ] && [ -f ${MARKER} ] && [ "$(stat -c %u:%a:%h ${MARKER})" = 0:600:1 ] && [ "$(sha256sum ${MARKER} | cut -d ' ' -f 1)" = ${oldHash} ]`;
  await run(remote, `${parentGuard} && [ ! -L ${ROOT} ] && [ "$(stat -c %u:%a ${ROOT})" = 0:700 ] && [ "$(stat -c '%d:%i' ${ROOT})" = ${quote(rootId)} ] && [ ! -L ${MARKER_NEXT} ] && [ -f ${MARKER_NEXT} ] && [ "$(stat -c %u:%a:%h ${MARKER_NEXT})" = 0:600:1 ] && [ "$(stat -c %s ${MARKER_NEXT})" -le 16384 ] && [ "$(sha256sum ${MARKER_NEXT} | cut -d ' ' -f 1)" = ${hash(contents)} ] && ${original} && mv -T -- ${MARKER_NEXT} ${MARKER}`);
}

async function updateMarker(remote, marker) {
  await publishMarker(remote, marker);
}

async function beginAcquisition(remote, marker, entropy) {
  const bytes = entropy(16);
  if (!Buffer.isBuffer(bytes) || bytes.length !== 16) throw fail();
  await boundary(remote, marker.containerName, marker.networkName, marker);
  const image = await inspectOwnedHelperImage(remote, marker);
  if (!image || !marker.helperImageId || image.Id !== marker.helperImageId) throw fail();
  marker.operationId = bytes.toString("hex");
  await updateMarker(remote, marker);
  const names = identity(marker);
  const expected = marker.modelDigest ? ` ${marker.modelDigest}` : "";
  // The immutable image ID prevents a retagged name from changing executable
  // code between attestation and container creation. Mirror the reviewed
  // acquisition service's private network, labels and resource restrictions.
  await run(remote, `docker run -d --name ${names.operation} --network ${marker.networkId} --label io.relmio.managed=true --label io.relmio.target=${LOCAL_N8N_MODEL_TARGET} --label io.relmio.install=${marker.installId} --label com.docker.compose.project=${marker.projectName} --label com.docker.compose.service=acquisition --label io.relmio.operation=${marker.operationId} --user 1000:1000 --read-only --cap-drop ALL --security-opt no-new-privileges --pids-limit 64 --memory 268435456 --memory-swap 268435456 --cpus 0.5 --init --restart no --log-driver json-file --log-opt max-size=1m --log-opt max-file=1 ${marker.helperImageId} ${marker.modelId} ${marker.operationId}${expected}`);
  const item = (await attestResources(remote, marker)).operation;
  if (!item) throw fail();
  return { state: "downloading", containerId: marker.containerId, networkId: marker.networkId,
    installId: marker.installId, endpoint: LOCAL_N8N_MODEL_ENDPOINT, modelId: marker.modelId,
    operation: await operationStatus(remote, marker, item) };
}

async function recoverRuntimeBootstrap(remote, marker, found, entropy, build) {
  if (marker.operationId !== null || found.operation) throw fail();
  await attestFiles(remote, marker);
  const name = identity(marker).helperImage;
  let inspected = await remote.exec(`docker image inspect ${name} --format '{{json .}}'`);
  if (inspected.code !== 0) {
    if (marker.helperImageId) throw fail();
    const listed = await run(remote, "docker image ls --format '{{.Repository}}:{{.Tag}}'");
    if (listed.split("\n").includes(name)) throw fail();
    await build(`${compose(marker)} --profile acquisition build --quiet acquisition`);
    inspected = await remote.exec(`docker image inspect ${name} --format '{{json .}}'`);
    if (inspected.code !== 0) throw fail();
  }
  const image = parse(inspected.stdout);
  if (!IMAGE_PATTERN.test(image.Id) ||
      marker.helperImageId && marker.helperImageId !== image.Id ||
      image.Config?.Labels?.["io.relmio.managed"] !== "true" ||
      image.Config.Labels["io.relmio.target"] !== LOCAL_N8N_MODEL_TARGET ||
      image.Config.Labels["io.relmio.install"] !== marker.installId) throw fail();
  marker.helperImageId = image.Id;
  await updateMarker(remote, marker);
  await boundary(remote, marker.containerName, marker.networkName, marker);
  if (!found.container) {
    await run(remote, `${compose(marker)} up -d --wait --wait-timeout 90 --quiet-pull --no-build --no-deps local-model`);
  } else if (found.container.State?.Running === false) {
    const pinned = await inspectOptional(remote, "container", found.container.Id);
    const named = await inspectOptional(remote, "container", identity(marker).container);
    if (!pinned || !named || pinned.Id !== found.container.Id || named.Id !== pinned.Id ||
        pinned.State?.Running !== false) throw fail();
    attestContainer(pinned, marker, false);
    await run(remote, `docker start ${validateDockerObjectId(pinned.Id, "model runtime")}`);
  } else if (found.container.State?.Running !== true) {
    throw fail();
  }
  const running = (await attestResources(remote, marker)).container;
  if (!running || (found.container && running.Id !== found.container.Id) ||
      running.State?.Running !== true || !IMAGE_PATTERN.test(running.Image)) throw fail();
  await run(remote, `for i in 1 2 3 4 5 6 7 8 9 10; do [ "$(docker inspect ${validateDockerObjectId(running.Id, "model runtime")} --format '{{.State.Health.Status}}')" = healthy ] && exit 0; sleep 3; done; exit 1`);
  marker.runtimeImageId = running.Image;
  await updateMarker(remote, marker);
  return await beginAcquisition(remote, marker, entropy);
}

const defaultReadAssets = async () => Object.fromEntries(await Promise.all(
  ["catalog.mjs", "acquisition.mjs"].map(async name => [name, await readFile(new URL(`../local-model/${name}`, import.meta.url), "utf8")])));

export async function installVpsLocalModel({ remote, plan, confirmed }, { entropy = randomBytes, readAssets = defaultReadAssets } = {}) {
  if (confirmed !== true) throw new Error("Confirm the reviewed model installation first.");
  validatePlan(plan, "install");
  await requireSafeDockerParent(remote);
  const preflight = await boundary(remote, plan.containerName, plan.networkName);
  if (preflight.containerId !== plan.containerId || preflight.networkId !== plan.networkId) throw fail();
  const precheck = await remote.exec(PRECHECK_COMMAND);
  if (precheck.code !== 0 || !["new", "managed"].includes(precheck.stdout.trim())) throw fail();
  // Preserve an existing shared parent's mode; only create it if absent.
  // Root and marker ownership are checked before a child/lock mutation.
  await run(remote, `${parentGuard} && [ "$(stat -c %u /docker)" = 0 ] && if [ ! -e ${INSTALL_ROOT} ]; then mkdir -m 0755 ${INSTALL_ROOT}; fi && [ -d ${INSTALL_ROOT} ] && [ ! -L ${INSTALL_ROOT} ] && [ "$(stat -c %u ${INSTALL_ROOT})" = 0 ] && if [ ! -e ${SHARED_ROOT_MARKER_PATH} ]; then (umask 077; set -C; printf '%s\n' ${quote(SHARED_ROOT_MARKER_CONTENT.trim())} > ${SHARED_ROOT_MARKER_PATH}); fi && [ ! -L ${SHARED_ROOT_MARKER_PATH} ] && [ -f ${SHARED_ROOT_MARKER_PATH} ] && [ "$(stat -c %u ${SHARED_ROOT_MARKER_PATH})" = 0 ] && [ "$(cat ${SHARED_ROOT_MARKER_PATH})" = ${quote(SHARED_ROOT_MARKER_CONTENT.trim())} ]`);
  return withLock(remote, async build => {
    if (await readMarker(remote)) throw fail();
    const current = await boundary(remote, plan.containerName, plan.networkName);
    if (current.containerId !== plan.containerId || current.networkId !== plan.networkId) throw fail();
    planFor(plan.containerName, plan.networkName, current.containerId, current.networkId,
      plan.modelId, await resources(remote, plan.modelId));
    const bytes = entropy(16);
    if (!Buffer.isBuffer(bytes) || bytes.length !== 16) throw fail();
    const installId = bytes.toString("hex");
    const assets = await readAssets();
    const files = { "Dockerfile.acquisition": createLocalN8nModelAcquisitionDockerfile({ installId }),
      ".dockerignore": createLocalN8nModelDockerignore(), ...assets,
      "compose.yaml": createLocalN8nModelComposeFile({ installId, networkName: plan.networkName, modelId: plan.modelId, hostResources: plan.hostResources }) };
    if (Object.keys(files).sort().join() !== [...FILES].sort().join() || FILES.some(name => typeof files[name] !== "string" || !files[name] || Buffer.byteLength(files[name]) > 1_000_000)) throw fail();
    const marker = { schemaVersion: 1, kind: "relmio-vps-local-model", installId,
      projectName: `relmio-n8n-local-model-${installId}`, containerName: plan.containerName,
      networkName: plan.networkName, ...current, modelId: plan.modelId,
      approvedModelDigest: plan.approvedModelDigest, hostResources: plan.hostResources,
      runtimeImageId: null, helperImageId: null, operationId: null, modelDigest: null,
      files: Object.fromEntries(FILES.map(name => [name, hash(files[name])])) };
    const existing = await attestResources(remote, marker);
    if (existing.container || existing.operation || existing.volume) throw fail();
    await run(remote, `${parentGuard} && umask 077 && mkdir ${ROOT}`);
    await publishMarker(remote, marker, { initial: true });
    for (const name of FILES) await remote.upload(`${ROOT}/${name}`, files[name], 0o600);
    await attestFiles(remote, marker);
    const helperImageName = identity(marker).helperImage;
    const occupied = await remote.exec(`docker image inspect ${helperImageName} --format '{{json .}}'`);
    if (occupied.code === 0) throw fail();
    const imageNames = await run(remote, "docker image ls --format '{{.Repository}}:{{.Tag}}'");
    if (imageNames.split("\n").includes(helperImageName)) throw fail();
    await run(remote, `${compose(marker)} --profile acquisition config --quiet`);
    await build(`${compose(marker)} --profile acquisition build --quiet acquisition`);
    const image = parse(await run(remote, `docker image inspect ${identity(marker).helperImage} --format '{{json .}}'`));
    if (!IMAGE_PATTERN.test(image.Id) || image.Config?.Labels?.["io.relmio.managed"] !== "true" ||
        image.Config.Labels["io.relmio.install"] !== installId ||
        image.Config.Labels["io.relmio.target"] !== LOCAL_N8N_MODEL_TARGET) throw fail();
    marker.helperImageId = image.Id;
    await updateMarker(remote, marker);
    await boundary(remote, plan.containerName, plan.networkName, marker);
    await run(remote, `${compose(marker)} up -d --wait --wait-timeout 90 --quiet-pull --no-build --no-deps local-model`);
    const running = (await attestResources(remote, marker)).container;
    if (!running?.State?.Running || running.State?.Health?.Status !== "healthy" || !IMAGE_PATTERN.test(running.Image)) throw fail();
    marker.runtimeImageId = running.Image;
    await updateMarker(remote, marker);
    await attestFiles(remote, marker);
    return await beginAcquisition(remote, marker, entropy);
  });
}

async function inspectOwnedHelperImage(remote, marker) {
  const name = identity(marker).helperImage;
  const result = await remote.exec(`docker image inspect ${name} --format '{{json .}}'`);
  if (result.code !== 0) {
    const listed = await run(remote, "docker image ls --format '{{.Repository}}:{{.Tag}}'");
    if (listed.split("\n").includes(name)) throw fail();
    return null;
  }
  const image = parse(result.stdout);
  if (!IMAGE_PATTERN.test(image.Id) || marker.helperImageId && image.Id !== marker.helperImageId ||
      image.Config?.Labels?.["io.relmio.managed"] !== "true" ||
      image.Config.Labels["io.relmio.target"] !== LOCAL_N8N_MODEL_TARGET ||
      image.Config.Labels["io.relmio.install"] !== marker.installId) throw fail();
  return image;
}

export async function changeVpsLocalModel({ remote, plan, confirmed }, { entropy = randomBytes } = {}) {
  if (confirmed !== true) throw new Error("Confirm the reviewed model action first.");
  if (!["retry", "remove"].includes(plan?.action)) throw fail();
  validatePlan(plan, plan.action);
  return withLock(remote, async build => {
    const marker = await readMarker(remote);
    if (!marker || marker.installId !== plan.installId || marker.containerId !== plan.containerId ||
        marker.networkId !== plan.networkId || marker.containerName !== plan.containerName ||
        marker.networkName !== plan.networkName || marker.modelId !== plan.modelId ||
        marker.approvedModelDigest !== plan.approvedModelDigest ||
        !isDeepStrictEqual(marker.hostResources, plan.hostResources)) throw fail();
    await attestFiles(remote, marker, { partial: plan.action === "remove" });
    const found = await attestResources(remote, marker);
    const current = await operationStatus(remote, marker, found.operation);
    if (plan.action === "retry") {
      await boundary(remote, plan.containerName, plan.networkName, marker);
      const status = await inspectInstalled(remote, marker);
      if (!["model-error", "runtime-ready", "partial"].includes(status.state)) throw fail();
      if (status.state === "partial") await attestFiles(remote, marker);
      checkPresentCapacity(marker, await resources(remote, marker.modelId), isCachedRetry(marker, status));
      if (marker.helperImageId && !(await inspectOwnedHelperImage(remote, marker))) throw fail();
      if (status.state === "partial" && marker.operationId === null && !found.operation) {
        return await recoverRuntimeBootstrap(remote, marker, found, entropy, build);
      }
      if (!found.container && status.state !== "partial") throw fail();
      // Stop the exact attested server, not a mutable container name. A failed
      // acquisition may still be writing when its last status was ambiguous.
      if (found.container?.State?.Running) {
        await run(remote, `docker stop -t 20 ${validateDockerObjectId(found.container.Id, "model runtime")}`);
      }
      let stopped = null;
      if (found.container) {
        stopped = await inspectOptional(remote, "container", found.container.Id);
        if (!stopped || stopped.Id !== found.container.Id || stopped.State?.Running !== false) throw fail();
        attestContainer(stopped, marker, false);
        const named = await inspectOptional(remote, "container", identity(marker).container);
        if (!named || named.Id !== stopped.Id) throw fail();
      }
      if (found.operation) {
        const helper = await inspectOptional(remote, "container", found.operation.Id);
        if (!helper || helper.Id !== found.operation.Id) throw fail();
        attestContainer(helper, marker, true);
        await run(remote, `docker rm ${helper.State?.Running ? "-f " : ""}${validateDockerObjectId(helper.Id, "owned acquisition")}`);
      }
      if (current?.modelDigest && !marker.modelDigest) marker.modelDigest = current.modelDigest;
      marker.operationId = null;
      await updateMarker(remote, marker);
      if (!stopped) return await recoverRuntimeBootstrap(remote, marker, { ...found, operation: null }, entropy, build);
      const named = await inspectOptional(remote, "container", identity(marker).container);
      if (!named || named.Id !== stopped.Id || named.State?.Running !== false) throw fail();
      attestContainer(named, marker, false);
      await run(remote, `docker start ${validateDockerObjectId(stopped.Id, "model runtime")}`);
      const running = (await attestResources(remote, marker)).container;
      if (!running || running.Id !== stopped.Id || running.State?.Running !== true) throw fail();
      await run(remote, `for i in 1 2 3 4 5 6 7 8 9 10; do [ "$(docker inspect ${validateDockerObjectId(stopped.Id, "model runtime")} --format '{{.State.Health.Status}}')" = healthy ] && exit 0; sleep 3; done; exit 1`);
      return await beginAcquisition(remote, marker, entropy);
    }
    const helperImage = await inspectOwnedHelperImage(remote, marker);
    // Full owned removal explicitly deletes the cached weights. Stop the only model
    // server before deleting its writer and volume; never touch the selected n8n.
    if (found.container) await run(remote, `docker rm -f ${validateDockerObjectId(found.container.Id, "model runtime")}`);
    if (found.operation) await run(remote, `docker rm -f ${validateDockerObjectId(found.operation.Id, "owned acquisition")}`);
    if (found.volume) await run(remote, `docker volume rm ${identity(marker).volume}`);
    if (helperImage) await run(remote, `docker image rm ${identity(marker).helperImage}`);
    await attestFiles(remote, marker, { partial: true });
    await run(remote, `rm -f -- ${[...FILES.map(name => `${ROOT}/${name}`), MARKER_NEXT, MARKER].join(" ")} && rmdir ${ROOT}`);
    return { state: "absent", removed: true, modelCacheDeleted: true };
  });
}

export async function getVpsLocalModelOperationStatus({ remote, installId }) {
  validateInstallId(installId);
  const marker = await readMarker(remote);
  if (!marker || marker.installId !== installId) throw fail();
  return await inspectInstalled(remote, marker);
}

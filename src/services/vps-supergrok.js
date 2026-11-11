import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { validateDockerName } from "../domain/validation.js";
import { validateDockerObjectId } from "../domain/local-n8n-sidecar.js";
import { validateInstallId } from "../domain/local-endpoints.js";
import { INSTALL_ROOT, PRECHECK_COMMAND, SHARED_ROOT_COMMAND, SHARED_ROOT_TIGHTEN_COMMAND, SHARED_ROOT_MARKER_PATH, SHARED_ROOT_MARKER_CONTENT } from "../domain/safety.js";
import { createLocalN8nSuperGrokComposeFile, createLocalN8nSuperGrokDockerfile, createLocalN8nSuperGrokDockerignore, LOCAL_N8N_SUPERGROK_ENDPOINT } from "../domain/local-n8n-supergrok.js";
import { requireSupportedVpsCpu } from "../domain/vps-build-state.js";
import { assertVpsNetworkSupported } from "../domain/vps-network.js";
import { withVpsOperationLock } from "./vps-operation-lock.js";

export const VPS_SUPERGROK_ROOT = `${INSTALL_ROOT}/supergrok`;
const ROOT = VPS_SUPERGROK_ROOT;
const MARKER = `${ROOT}/.managed-by-relmio.json`;
const LOCK = `${INSTALL_ROOT}/.supergrok-operation.lock`;
const FILES = ["Dockerfile", ".dockerignore", "gateway.js", "chat.js", "session.js", "docker-compose.yml"];
const TARGET = "n8n-supergrok-oauth";
const hash = value => createHash("sha256").update(value).digest("hex");
const fail = () => new Error("The VPS SuperGrok ownership or safety check failed. Nothing outside its managed companion may be changed.");
// A named setup step that failed on the server gets its own sentence and code. Ownership and
// attestation mismatches keep the one sentence above. safeMessage survives an appended lock notice.
const STEP_FAILURES = Object.freeze({
  vps_step_compose_config: "Docker Compose did not accept the SuperGrok files on this server. Remove the incomplete companion, then install again.",
  vps_step_build: "The SuperGrok image did not build on this server. Check free disk space and network access, remove the incomplete companion, then install again.",
  vps_step_image_check: "Docker could not show the SuperGrok image after the build. Remove the incomplete companion, then install again.",
  vps_step_start: "The SuperGrok companion did not become healthy within 90 seconds. Remove the incomplete companion, then install again.",
});
const stepFailure = code => Object.assign(new Error(STEP_FAILURES[code]), { safeMessage: STEP_FAILURES[code], code });
// An installed companion is pinned to the name of its n8n container and to its Docker network,
// not to that container's ID, so it stays manageable after the same n8n is recreated. Another
// n8n on the same network is refused. The names below are validated Docker names from the marker.
const otherContainer = marker => new Error(`SuperGrok is installed for the n8n container "${marker.containerName}". Choose that n8n to manage it.`);
const otherNetwork = marker => new Error(`SuperGrok is installed on the Docker network "${marker.networkName}". Choose that network to manage it.`);
const replacedNetwork = marker => new Error(`The Docker network "${marker.networkName}" was replaced after SuperGrok was installed on it. This companion cannot be managed here.`);
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
const parse = text => { try { return JSON.parse(text); } catch { throw fail(); } };
const parentGuard = `[ -d /docker ] && [ ! -L /docker ] && [ ! -L ${INSTALL_ROOT} ]`;

async function run(remote, command, { input, step } = {}) {
  const result = await remote.exec(command, input === undefined ? undefined : { input });
  if (result.code !== 0) throw step ? stepFailure(step) : fail();
  return result.stdout.trim();
}

function validateMarker(marker) {
  if (!marker || marker.schemaVersion !== 1 || marker.kind !== "relmio-vps-supergrok") throw fail();
  validateInstallId(marker.installId);
  validateDockerName(marker.containerName);
  validateDockerName(marker.networkName);
  validateDockerObjectId(marker.containerId, "n8n container");
  validateDockerObjectId(marker.networkId, "network");
  if (marker.projectName !== `relmio-n8n-supergrok-oauth-${marker.installId}` ||
      !/^[a-f0-9]{64}$/u.test(marker.tokenSha256) ||
      (marker.imageId !== null && !/^sha256:[a-f0-9]{64}$/u.test(marker.imageId)) ||
      !marker.files || Object.keys(marker.files).length !== FILES.length || FILES.some(name => !/^[a-f0-9]{64}$/u.test(marker.files[name]))) throw fail();
  return marker;
}

async function readMarker(remote) {
  const text = await run(remote, `${parentGuard} && if [ ! -e ${ROOT} ]; then printf absent; else [ ! -L ${ROOT} ] && [ -d ${ROOT} ] && [ ! -L ${MARKER} ] && [ -f ${MARKER} ] && [ "$(stat -c %u ${ROOT})" = 0 ] && [ "$(stat -c %a ${ROOT})" = 700 ] && [ "$(stat -c %s ${MARKER})" -le 16384 ] && cat ${MARKER}; fi`);
  return text === "absent" ? null : validateMarker(parse(text));
}

function names(marker) {
  validateMarker(marker);
  return { container: `${marker.projectName}-supergrok-oauth-1`, credential: `${marker.projectName}-credential-action`, volume: `${marker.projectName}_grok-home`, image: `${marker.projectName}:local` };
}

function owned(labels, marker) {
  return labels?.["io.relmio.managed"] === "true" && labels?.["io.relmio.target"] === TARGET && labels?.["io.relmio.install"] === marker.installId;
}

async function inspectOptional(remote, type, name) {
  // Inspect only an exact generated name, never a guessed production resource.
  const result = await remote.exec(`docker ${type} inspect ${validateDockerName(name)}`);
  if (result.code !== 0) {
    const list = await run(remote, type === "container" ? "docker ps -a --format '{{.Names}}'" : "docker volume ls --format '{{.Name}}'");
    if (list.split("\n").includes(name)) throw fail();
    return null;
  }
  const values = parse(result.stdout);
  if (!Array.isArray(values) || values.length !== 1) throw fail();
  return values[0];
}

async function attestResources(remote, marker) {
  const n = names(marker);
  const container = await inspectOptional(remote, "container", n.container);
  const credential = await inspectOptional(remote, "container", n.credential);
  const volume = await inspectOptional(remote, "volume", n.volume);
  for (const item of [container, credential]) {
    if (item && (!owned(item.Config?.Labels, marker) || item.Config.Labels["com.docker.compose.project"] !== marker.projectName ||
        item.Id === marker.containerId || (marker.imageId && item.Image !== marker.imageId) || item.Config.Image !== n.image ||
        !["/" + n.container, "/" + n.credential].includes(item.Name) || Object.keys(item.HostConfig?.PortBindings ?? {}).length ||
        Object.values(item.NetworkSettings?.Ports ?? {}).some(value => value !== null) ||
        item.Mounts?.length !== 1 || item.Mounts[0].Name !== n.volume || item.Mounts[0].Destination !== "/home/node/.grok" || item.Mounts[0].RW !== true)) throw fail();
  }
  if (volume && (!owned(volume.Labels, marker) || volume.Labels["com.docker.compose.project"] !== marker.projectName)) throw fail();
  const listed = await run(remote, `docker ps -a --filter label=com.docker.compose.project=${marker.projectName} --format '{{.Names}}'`);
  if (listed && listed.split("\n").some(name => ![n.container, n.credential].includes(name))) throw fail();
  const volumes = await run(remote, `docker volume ls --filter label=com.docker.compose.project=${marker.projectName} --format '{{.Name}}'`);
  if (volumes && volumes.split("\n").some(name => name !== n.volume)) throw fail();
  return { container, credential, volume };
}

async function attestFiles(remote, marker, { partial = false } = {}) {
  const fileNames = [...FILES, ".managed-by-relmio.json"];
  const checks = FILES.map(name => `[ ! -L ${ROOT}/${name} ] && ${partial ? `if [ -e ${ROOT}/${name} ]; then ` : ""}[ -f ${ROOT}/${name} ] && [ "$(sha256sum ${ROOT}/${name} | cut -d ' ' -f 1)" = ${marker.files[name]} ]${partial ? "; fi" : ""}`);
  const listing = await run(remote, `${parentGuard} && [ ! -L ${ROOT} ] && [ -d ${ROOT} ] && find ${ROOT} -mindepth 1 -maxdepth 1 -printf '%f\n'`);
  if (listing.split("\n").some(name => !fileNames.includes(name))) throw fail();
  await run(remote, checks.join(" && "));
}

async function boundary(remote, containerName, networkName, marker = null, { install = false } = {}) {
  const container = validateDockerName(containerName);
  const network = validateDockerName(networkName);
  const [id, running, networks] = (await run(remote, `docker inspect ${container} --format '{{json .Id}}|{{json .State.Running}}|{{json .NetworkSettings.Networks}}'`)).split("|");
  const n8n = { id: parse(id), running: parse(running), networks: parse(networks) };
  if (!n8n.running || !n8n.networks?.[network]) throw new Error("The selected n8n container or network changed. Review a fresh plan.");
  const net = parse(await run(remote, `docker network inspect ${network} --format '{{json .}}'`));
  validateDockerObjectId(n8n.id, "n8n container");
  validateDockerObjectId(net.Id, "network");
  if (n8n.networks[network].NetworkID !== net.Id) throw fail();
  if (marker && marker.networkId !== net.Id) throw replacedNetwork(marker);
  if (install && !marker) assertVpsNetworkSupported(net);
  for (const [id, item] of Object.entries(net.Containers ?? {})) {
    validateDockerObjectId(id, "connected container");
    // The first read already holds the selected n8n container's networks.
    const networks = id === n8n.id ? n8n.networks : parse(await run(remote, `docker inspect ${id} --format '{{json .NetworkSettings.Networks}}'`));
    if ([item.Name, ...(networks[network]?.Aliases ?? [])].some(alias => ["n8n-supergrok", "supergrok-oauth"].includes(alias))) {
      if (!marker || item.Name !== names(marker).container) throw new Error("The private n8n-supergrok hostname is already in use. Nothing was changed.");
    }
  }
  return { containerId: n8n.id, networkId: net.Id };
}

function attestRunning(container, marker) {
  const n = names(marker);
  const network = container?.NetworkSettings?.Networks?.[marker.networkName];
  const host = container?.HostConfig;
  const mounts = container?.Mounts;
  if (!container || !owned(container.Config?.Labels, marker) || container.Image !== marker.imageId || container.Config.Image !== n.image ||
      !settled(container) ||
      Object.keys(container.NetworkSettings?.Networks ?? {}).length !== 1 || network?.NetworkID !== marker.networkId || !network.Aliases?.includes("n8n-supergrok") ||
      Object.values(container.NetworkSettings?.Ports ?? {}).some(value => value !== null) || Object.keys(host?.PortBindings ?? {}).length ||
      host?.ReadonlyRootfs !== true || !host.CapDrop?.includes("ALL") || !host.SecurityOpt?.includes("no-new-privileges:true") ||
      !Array.isArray(mounts) || mounts.length !== 1 || mounts[0].Name !== n.volume || mounts[0].Destination !== "/home/node/.grok" || mounts[0].RW !== true) throw fail();
}

function withLock(remote, operation) {
  return withVpsOperationLock(remote, LOCK, operation);
}

// Docker reports Running while a container restarts, so only a settled, healthy runtime counts.
const settled = container => container?.State?.Running === true && container.State.Restarting !== true &&
  container.State.Status !== "restarting" && container.State.Health?.Status === "healthy";

async function inspect(remote, containerName, networkName, { install = false } = {}) {
  validateDockerName(containerName);
  validateDockerName(networkName);
  const marker = await readMarker(remote);
  if (marker && marker.containerName !== containerName) throw otherContainer(marker);
  if (marker && marker.networkName !== networkName) throw otherNetwork(marker);
  const selected = await boundary(remote, containerName, networkName, marker, { install });
  if (!marker) return { state: "absent", ...selected, installId: null, endpoint: LOCAL_N8N_SUPERGROK_ENDPOINT };
  const resources = await attestResources(remote, marker);
  const healthy = settled(resources.container) && marker.imageId !== null;
  // One attestation per check: every file for a healthy runtime, the files that exist otherwise.
  await attestFiles(remote, marker, { partial: !healthy });
  if (healthy) attestRunning(resources.container, marker);
  return { state: healthy ? "healthy" : "partial", ...selected, installId: marker.installId, endpoint: LOCAL_N8N_SUPERGROK_ENDPOINT, credentialActionRunning: resources.credential?.State?.Running === true };
}

export async function inspectVpsSuperGrok({ remote, containerName, networkName }) {
  return inspect(remote, containerName, networkName);
}

export async function reviewVpsSuperGrok({ remote, containerName, networkName, action }) {
  if (!["install", "sign-in", "sign-out", "remove", "cancel-sign-in"].includes(action)) throw new TypeError("Choose a supported SuperGrok action.");
  const install = action === "install";
  // Known from the connection, before any remote read: the pinned Grok build exists for these CPUs only.
  if (install) requireSupportedVpsCpu(remote.host, "SuperGrok");
  const status = await inspect(remote, containerName, networkName, { install });
  if ((install && status.state !== "absent") || (!install && status.state === "absent") ||
      (["sign-in", "sign-out"].includes(action) && status.state !== "healthy") ||
      (action === "cancel-sign-in" ? !status.credentialActionRunning : status.credentialActionRunning)) throw new Error("SuperGrok is not ready for that action. Refresh its status first.");
  return { action, containerName, networkName, containerId: status.containerId, networkId: status.networkId, installId: status.installId, installDirectory: ROOT, operationLockPath: LOCK, temporaryBuildStatePath: ["install", "sign-in", "sign-out"].includes(action) ? `${LOCK}/buildx` : null, endpoint: LOCAL_N8N_SUPERGROK_ENDPOINT, publishedPorts: [], existingN8nChanges: [], existingN8nRestarts: 0 };
}

const defaultReadAssets = async () => Object.fromEntries(await Promise.all([["gateway.js", "runtime.js"], ["chat.js", "chat.js"], ["session.js", "session.js"]].map(async ([name, file]) => [name, await readFile(new URL(`../supergrok/${file}`, import.meta.url), "utf8")])));

export async function installVpsSuperGrok({ remote, plan, confirmed }, { readAssets = defaultReadAssets, entropy = randomBytes } = {}) {
  if (confirmed !== true || plan.action !== "install") throw new Error("Confirm the reviewed SuperGrok installation first.");
  const precheck = await remote.exec(PRECHECK_COMMAND);
  if (precheck.code !== 0 || !["new", "managed"].includes(precheck.stdout.trim())) throw fail();
  await run(remote, `${SHARED_ROOT_COMMAND} && if [ ! -e ${SHARED_ROOT_MARKER_PATH} ]; then (set -C; printf '%s\n' ${quote(SHARED_ROOT_MARKER_CONTENT.trim())} > ${SHARED_ROOT_MARKER_PATH}); fi`);
  return withLock(remote, async build => {
    if (await readMarker(remote)) throw new Error("SuperGrok is already installed. Use its management actions.");
    const selection = await boundary(remote, plan.containerName, plan.networkName, null, { install: true });
    if (selection.containerId !== plan.containerId || selection.networkId !== plan.networkId) throw fail();
    const bytes = entropy(48);
    if (!Buffer.isBuffer(bytes) || bytes.length !== 48) throw fail();
    const installId = bytes.subarray(0, 16).toString("hex");
    const clientKey = bytes.subarray(16).toString("hex");
    const files = { Dockerfile: createLocalN8nSuperGrokDockerfile({ installId }), ".dockerignore": createLocalN8nSuperGrokDockerignore(), ...(await readAssets()), "docker-compose.yml": createLocalN8nSuperGrokComposeFile({ installId, networkName: plan.networkName, tokenSha256: hash(clientKey) }) };
    if (Object.keys(files).length !== FILES.length || FILES.some(name => typeof files[name] !== "string" || !files[name] || files[name].length > 1_000_000)) throw fail();
    const marker = { schemaVersion: 1, kind: "relmio-vps-supergrok", installId, projectName: `relmio-n8n-supergrok-oauth-${installId}`, containerName: plan.containerName, networkName: plan.networkName, ...selection, tokenSha256: hash(clientKey), imageId: null, files: Object.fromEntries(FILES.map(name => [name, hash(files[name])])) };
    const resources = await attestResources(remote, marker);
    if (resources.container || resources.credential || resources.volume) throw fail();
    await run(remote, `umask 077 && mkdir ${ROOT}`);
    await remote.upload(MARKER, JSON.stringify(marker), 0o600);
    for (const name of FILES) await remote.upload(`${ROOT}/${name}`, files[name], 0o600);
    await attestFiles(remote, marker);
    const compose = composePrefix(marker);
    await run(remote, `${compose} config --quiet`, { step: "vps_step_compose_config" });
    // The lock helper tags a build that exited non-zero. Unknown outcomes and lock errors pass through.
    try { await build(`${compose} build supergrok-oauth`); }
    catch (error) { throw error?.code === "vps_step_build" ? stepFailure("vps_step_build") : error; }
    const image = parse(await run(remote, `docker image inspect ${names(marker).image} --format '{{json .}}'`, { step: "vps_step_image_check" }));
    if (!owned(image.Config?.Labels, marker) || !/^sha256:[a-f0-9]{64}$/u.test(image.Id)) throw fail();
    marker.imageId = image.Id;
    await remote.upload(MARKER, JSON.stringify(marker), 0o600);
    await boundary(remote, plan.containerName, plan.networkName, marker);
    await run(remote, `${compose} up -d --wait --wait-timeout 90 --no-build --no-deps supergrok-oauth`, { step: "vps_step_start" });
    attestRunning((await attestResources(remote, marker)).container, marker);
    return { state: "healthy", installId, endpoint: LOCAL_N8N_SUPERGROK_ENDPOINT, clientKey, credentialShownOnce: true, protocol: "openai-chat-completions" };
  });
}

function composePrefix(marker) {
  names(marker);
  return `docker compose --project-name ${marker.projectName} --file ${ROOT}/docker-compose.yml`;
}

export async function changeVpsSuperGrok({ remote, plan, confirmed }) {
  if (confirmed !== true || !["sign-in", "sign-out", "remove", "cancel-sign-in"].includes(plan.action)) throw new Error("Confirm the reviewed SuperGrok action first.");
  return withLock(remote, async build => {
    const marker = await readMarker(remote);
    if (!marker || marker.installId !== plan.installId || marker.networkId !== plan.networkId ||
        marker.containerName !== plan.containerName || marker.networkName !== plan.networkName) throw fail();
    // That name may resolve to a new container after n8n was recreated; it must be the reviewed one.
    if ((await boundary(remote, plan.containerName, plan.networkName, marker)).containerId !== plan.containerId) throw fail();
    // The owner confirmed this change above. Each branch sets an older shared folder to mode 0700
    // after its own checks and right before its first write.
    const tightenSharedFolder = () => run(remote, SHARED_ROOT_TIGHTEN_COMMAND);
    await attestFiles(remote, marker, { partial: plan.action === "remove" });
    const resources = await attestResources(remote, marker);
    if (plan.action === "cancel-sign-in") {
      if (!resources.credential?.State?.Running) throw new Error("The credential action has already ended. Refresh status.");
      await tightenSharedFolder();
      await run(remote, `docker rm -f ${validateDockerObjectId(resources.credential.Id, "credential action")}`);
      return { state: "cancelled", installId: marker.installId };
    }
    if (resources.credential?.State?.Running) throw new Error("An official Grok credential action is still running. Wait for it to finish or expire before changing this companion.");
    const n = names(marker);
    if (plan.action === "remove") {
      await tightenSharedFolder();
      for (const item of [resources.credential, resources.container]) if (item) await run(remote, `docker rm -f ${validateDockerObjectId(item.Id, "owned companion")}`);
      if (resources.volume) await run(remote, `docker volume rm ${n.volume}`);
      await attestFiles(remote, marker, { partial: true });
      await run(remote, `rm -f -- ${[...FILES.map(name => `${ROOT}/${name}`), MARKER].join(" ")} && rmdir ${ROOT}`);
      return { state: "absent", removed: true };
    }
    attestRunning(resources.container, marker);
    await tightenSharedFolder();
    if (resources.credential) await run(remote, `docker rm ${validateDockerObjectId(resources.credential.Id, "credential action")}`);
    const operation = plan.action === "sign-in" ? "login --device-auth" : "logout";
    // The deterministic Docker name excludes overlapping actions across SSH sessions.
    // Compose run starts the stored image, so a failed launch keeps the lock helper's sentence without its build code.
    try {
      await build(`${composePrefix(marker)} run -d --name ${n.credential} --no-deps --pull never --entrypoint /bin/sh supergrok-oauth -c ${quote(`umask 077; exec /usr/bin/timeout --signal=TERM --kill-after=2s ${plan.action === "sign-in" ? 900 : 60}s grok --no-auto-update ${operation}`)}`);
    } catch (error) {
      if (error?.code === "vps_step_build") delete error.code;
      throw error;
    }
    return { state: "pending", installId: marker.installId };
  });
}

export function parseGrokDevicePrompt(output) {
  const clean = String(output).replace(/\x1b\[[0-9;]*[A-Za-z]/gu, "").slice(-16000);
  let verificationUrl = null;
  for (const match of clean.matchAll(/https:\/\/[^\s<>"']+/gu)) {
    try {
      const url = new URL(match[0]);
      if (["accounts.x.ai", "auth.x.ai", "grok.com", "accounts.grok.com", "x.ai"].includes(url.hostname) && !url.username && !url.password && (!url.port || url.port === "443")) {
        // Never forward arbitrary query values from provider diagnostics.
        url.search = ""; url.hash = "";
        verificationUrl = url.href;
        break;
      }
    } catch { /* Ignore non-URLs. */ }
  }
  const code = clean.match(/\b([A-Z0-9]{4}-[A-Z0-9]{4})\b/u)?.[1] ?? null;
  return { verificationUrl, userCode: code };
}

export function classifyGrokLoginExitCode(exitCode) {
  if (exitCode === 0) return "complete";
  // GNU timeout returns 124 when its configured deadline elapses. Do not
  // interpret other signal-derived exits (for example, 137) as a timeout.
  return exitCode === 124 ? "expired" : "failed";
}

export async function getVpsGrokLoginStatus({ remote, installId }) {
  const marker = await readMarker(remote);
  if (!marker || marker.installId !== installId) throw fail();
  await attestFiles(remote, marker);
  const { credential } = await attestResources(remote, marker);
  if (!credential) return { state: "idle" };
  const logs = await remote.exec(`docker logs --tail 60 ${names(marker).credential}`);
  if (logs.code !== 0) throw fail();
  const state = credential.State?.Running
    ? "pending"
    : classifyGrokLoginExitCode(credential.State?.ExitCode);
  return { state, ...(state === "pending" ? parseGrokDevicePrompt(logs.stdout + logs.stderr) : {}) };
}

export async function discoverVpsGrokModels({ remote, installId, clientKey }) {
  if (typeof clientKey !== "string" || !/^[a-f0-9]{64}$/u.test(clientKey)) throw new TypeError("Enter the local bridge bearer from this installation, not a provider API key.");
  const marker = await readMarker(remote);
  if (!marker || marker.installId !== installId || marker.tokenSha256 !== hash(clientKey)) throw fail();
  await attestFiles(remote, marker);
  attestRunning((await attestResources(remote, marker)).container, marker);
  const probe = 'let key="";process.stdin.on("data",x=>key+=x);process.stdin.on("end",async()=>{try{const r=await fetch("http://127.0.0.1:14502/v1/models",{headers:{Authorization:"Bearer "+key},signal:AbortSignal.timeout(20000)});const j=await r.json();console.log(JSON.stringify({status:r.status,models:r.ok?j.data.map(x=>x.id):[],code:j.error?.code}));}catch{console.log(JSON.stringify({status:502,models:[],code:"provider_unavailable"}));}});';
  const result = parse(await run(remote, `docker exec -i ${names(marker).container} node -e ${quote(probe)}`, { input: clientKey }));
  if (!Number.isInteger(result.status) || !Array.isArray(result.models) || result.models.length > 1024 || result.models.some(id => typeof id !== "string" || !/^[a-zA-Z0-9_.:-]{1,128}$/u.test(id))) throw fail();
  return { status: result.status, models: result.models, ...(result.status === 401 ? { code: "login_required" } : {}) };
}

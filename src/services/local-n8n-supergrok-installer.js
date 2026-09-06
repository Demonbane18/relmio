import { createHash, randomBytes as defaultRandomBytes, randomUUID } from "node:crypto";
import * as defaultFileSystem from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import {
  LOCAL_N8N_SUPERGROK_ENDPOINT,
  LOCAL_N8N_SUPERGROK_HOSTNAME,
  LOCAL_N8N_SUPERGROK_TARGET,
  createLocalN8nSuperGrokComposeFile,
  createLocalN8nSuperGrokDockerfile,
  createLocalN8nSuperGrokDockerignore,
  normalizeLocalN8nSuperGrokPlan,
} from "../domain/local-n8n-supergrok.js";
import { validateDockerName } from "../domain/validation.js";
import { lockDownLocalPath, runLocalProcess, validateLocalDockerHost } from "../infrastructure/local-process.js";
import { getLocalProcessIdentity } from "../infrastructure/process-identity.js";
import { acquireLocalIntegrationLifecycleLock, settleLocalIntegrationLifecycleOperation } from "./local-integration-lifecycle-lock.js";

const COMPOSE_FILE = "docker-compose.yml";
const MARKER_FILE = ".managed-by-relmio.json";
const ROOT_MARKER = ".managed-by-relmio-root.json";
const PROJECT_PREFIX = "relmio-n8n-supergrok-oauth";
const SERVICE_NAME = "supergrok-oauth";
const MARKER_SCHEMA = 1;
const MAX_METADATA_BYTES = 1024 * 1024;
const MAX_CONTAINERS = 100;
const DOCKER_ENV = new Set(["DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH", "BUILDKIT_HOST"]);
const VERIFIER = [
  'let b="";process.stdin.setEncoding("utf8");process.stdin.on("data",x=>{b+=x;if(b.length>512)process.exit(2)});',
  'process.stdin.on("end",async()=>{try{if(!/^[a-f0-9]{64}$/i.test(b.trim()))process.exit(2);',
  // Installation verifies the local service and bearer; model discovery requires
  // the separate, user-attended provider login and is not a bootstrap health check.
  'const h={Authorization:"Bearer "+b.trim()};const [a,c]=await Promise.all([fetch("http://127.0.0.1:14502/health"),fetch("http://127.0.0.1:14502/auth/verify",{headers:h})]);',
  'if(!a.ok||!c.ok)process.exit(1);process.stdout.write("ok")}catch{process.exit(1)}});',
].join("");

function missing(error) { return error?.code === "ENOENT"; }
function sha(value) { return createHash("sha256").update(value).digest("hex"); }
function validId(value) { return typeof value === "string" && /^[a-f0-9]{32}$/u.test(value); }
function validatePath(value) {
  if (typeof value !== "string" || !isAbsolute(value) || value.includes("\0")) throw new TypeError("The local SuperGrok install directory is invalid.");
  return resolve(value);
}
function assertInstallRoot(value) {
  const root = validatePath(value);
  if (basename(root) !== LOCAL_N8N_SUPERGROK_TARGET || basename(dirname(root)) !== "local" || basename(resolve(root, "..", "..")) !== ".relmio") throw new TypeError("The local SuperGrok install directory is invalid.");
  return root;
}
function assertNoDockerOverrides(env) {
  if (!env || typeof env !== "object" || Array.isArray(env)) throw new TypeError("The local process environment is invalid.");
  for (const [name, value] of Object.entries(env)) if (DOCKER_ENV.has(name.toUpperCase()) && value) throw new Error("Relmio local sidecars require the selected Docker context without a Docker environment override.");
}
async function lstat(fileSystem, path) { try { return await fileSystem.lstat(path); } catch (error) { if (missing(error)) return null; throw error; } }
function assertDirectory(entry) { if (!entry?.isDirectory?.() || entry.isSymbolicLink()) throw new Error("Relmio refuses an unsafe local managed directory."); }
async function writePrivate(fileSystem, path, data) {
  const old = await lstat(fileSystem, path);
  if (old && (!old.isFile?.() || old.isSymbolicLink())) throw new Error("Relmio refuses to replace an unsafe local managed file.");
  const temporary = `${path}.tmp-${randomUUID()}`;
  try { await fileSystem.writeFile(temporary, data, { flag: "wx", mode: 0o600 }); await fileSystem.chmod(temporary, 0o600); await fileSystem.rename(temporary, path); await fileSystem.chmod(path, 0o600); }
  catch (error) { try { await fileSystem.unlink(temporary); } catch {} throw error; }
}
async function writeExclusivePrivate(fileSystem, path, data) {
  const old = await lstat(fileSystem, path);
  if (old) throw new Error("Relmio refuses to replace an existing fresh local SuperGrok file.");
  try {
    await fileSystem.writeFile(path, data, { flag: "wx", mode: 0o600 });
    await fileSystem.chmod(path, 0o600);
  } catch (error) {
    if (error?.code === "EEXIST") throw new Error("A fresh local SuperGrok file appeared during installation. Nothing was changed.");
    throw error;
  }
}
async function ensurePrivateDirectory(fileSystem, path, platform, lockDownPath) {
  const entry = await lstat(fileSystem, path);
  if (entry) assertDirectory(entry); else await fileSystem.mkdir(path, { mode: 0o700 });
  await fileSystem.chmod(path, 0o700);
  if (platform === "win32") await lockDownPath(path, { platform });
}
async function directoryIdentity(fileSystem, path) {
  const entry = await lstat(fileSystem, path);
  assertDirectory(entry);
  if (!Number.isSafeInteger(entry.dev) || !Number.isSafeInteger(entry.ino)) throw new Error("Relmio could not attest the fresh local SuperGrok directory.");
  return { dev: entry.dev, ino: entry.ino };
}

export async function resolveLocalN8nSuperGrokInstallRoot({ env = process.env, homeDirectory = homedir(), fileSystem = defaultFileSystem, platform = process.platform } = {}) {
  if (typeof platform !== "string" || !platform) throw new TypeError("The local platform is invalid.");
  const requested = typeof env.RELMIO_HOME === "string" && env.RELMIO_HOME.trim() ? env.RELMIO_HOME : join(homeDirectory, ".relmio");
  const home = validatePath(requested);
  if (basename(home) !== ".relmio") throw new TypeError("Relmio local storage path is invalid.");
  const parent = dirname(home);
  let canonical;
  try { canonical = await fileSystem.realpath(parent); } catch { throw new Error("The parent of the Relmio local storage directory is invalid."); }
  if (canonical !== resolve(parent)) throw new Error("Relmio refuses a local storage path with a symbolic-link ancestor.");
  return join(canonical, ".relmio", "local", LOCAL_N8N_SUPERGROK_TARGET);
}

export async function acquireLocalN8nSuperGrokChangeLock({ fileSystem = defaultFileSystem, getProcessIdentity = getLocalProcessIdentity, installRoot, lockDownPath = lockDownLocalPath, now = Date.now, platform = process.platform } = {}) {
  const root = assertInstallRoot(installRoot);
  return acquireLocalIntegrationLifecycleLock({ fileSystem, getProcessIdentity, lockDownPath, now, platform, lockPath: join(dirname(resolve(root, "..", "..")), ".relmio-local-n8n-supergrok-oauth.lock"), label: "local n8n SuperGrok sidecar operation lock" });
}

function composeArgs(projectName, rest) {
  if (!new RegExp(`^${PROJECT_PREFIX}-[a-f0-9]{32}$`, "u").test(projectName)) throw new TypeError("The local SuperGrok project identity is invalid.");
  return ["compose", "--project-name", projectName, "--file", COMPOSE_FILE, ...rest];
}
async function run(runProcess, spec, label) { const result = await runProcess(spec); if (result?.code !== 0) throw new Error(`${label} failed.`); return result; }
function json(text, label) { if (typeof text !== "string" || Buffer.byteLength(text) > MAX_METADATA_BYTES) throw new Error(`${label} returned invalid Docker metadata.`); try { return JSON.parse(text); } catch { throw new Error(`${label} returned invalid Docker metadata.`); } }
function lines(text, label) { if (!text.trim()) return []; return text.trim().split("\n").map((line) => json(line, label)); }
async function inspectContainer(runProcess, cwd, dockerHost, id) { return json((await run(runProcess, { file: "docker", args: ["container", "inspect", "--format", "{{json .}}", id], cwd, dockerHost }, "Docker container inspection")).stdout.trim(), "Docker container inspection"); }
async function inspectNetwork(runProcess, cwd, dockerHost, name) { return json((await run(runProcess, { file: "docker", args: ["network", "inspect", "--format", "{{json .}}", name], cwd, dockerHost }, "Docker network inspection")).stdout.trim(), "Docker network inspection"); }
function labelsOwned(labels, marker, service = false) { return labels && labels["com.docker.compose.project"] === marker.projectName && labels["io.relmio.managed"] === "true" && labels["io.relmio.target"] === LOCAL_N8N_SUPERGROK_TARGET && labels["io.relmio.install"] === marker.installId && (!service || labels["com.docker.compose.service"] === SERVICE_NAME); }
function validateMarker(marker) {
  if (!marker || marker.schemaVersion !== MARKER_SCHEMA || marker.kind !== "relmio-local-n8n-supergrok" || marker.target !== LOCAL_N8N_SUPERGROK_TARGET || !validId(marker.installId) || marker.projectName !== `${PROJECT_PREFIX}-${marker.installId}` || typeof marker.tokenSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(marker.tokenSha256) || typeof marker.configSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(marker.configSha256) || typeof marker.sourceSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(marker.sourceSha256) || typeof marker.imageId !== "string" || !/^sha256:[a-f0-9]{64}$/u.test(marker.imageId)) throw new Error("The local SuperGrok managed marker is invalid.");
  validateLocalDockerHost(marker.dockerHost);
  normalizeLocalN8nSuperGrokPlan({
    kind: "n8n-supergrok", target: marker.target,
    label: "SuperGrok for n8n", endpoint: LOCAL_N8N_SUPERGROK_ENDPOINT,
    baseUrl: LOCAL_N8N_SUPERGROK_ENDPOINT, protocol: "openai-chat-completions",
    upstreamAuth: "provider-owned-oauth", dockerHost: marker.dockerHost,
    n8nContainerId: marker.n8nContainerId, n8nContainerName: marker.n8nContainerName,
    dockerNetworkId: marker.dockerNetworkId, networkName: marker.networkName,
    managedPath: "~/.relmio/local/n8n-supergrok-oauth", hostPublication: "none", experimental: true,
  });
  return marker;
}
async function inspectManaged(fileSystem, root) {
  const home = resolve(root, "..", ".."); const homeEntry = await lstat(fileSystem, home);
  if (!homeEntry) return { baseExists: false, marker: null };
  assertDirectory(homeEntry);
  const rootMarker = await lstat(fileSystem, join(home, ROOT_MARKER));
  if (!rootMarker?.isFile?.() || rootMarker.isSymbolicLink()) throw new Error("The Relmio local storage directory is not an owned managed root. Nothing was changed.");
  let parsed; try { parsed = json(await fileSystem.readFile(join(home, ROOT_MARKER), "utf8"), "Relmio root marker"); } catch { throw new Error("The Relmio local managed-root marker is invalid."); }
  if (parsed?.schemaVersion !== 1 || parsed?.kind !== "relmio-local-root") throw new Error("The Relmio local managed-root marker is invalid.");
  const localRoot = join(home, "local");
  const localEntry = await lstat(fileSystem, localRoot);
  if (!localEntry) return { baseExists: true, marker: null };
  assertDirectory(localEntry);
  const entry = await lstat(fileSystem, root); if (!entry) return { baseExists: true, marker: null }; assertDirectory(entry);
  const markerFile = await lstat(fileSystem, join(root, MARKER_FILE)); if (!markerFile?.isFile?.() || markerFile.isSymbolicLink()) throw new Error("The local SuperGrok directory is unmanaged. Nothing was overwritten.");
  try { return { baseExists: true, marker: validateMarker(json(await fileSystem.readFile(join(root, MARKER_FILE), "utf8"), "SuperGrok marker")) }; } catch { throw new Error("The local SuperGrok managed marker is invalid."); }
}
async function attestStoredManagedFiles(fileSystem, root, marker) {
  const names = ["Dockerfile", ".dockerignore", COMPOSE_FILE, "gateway.js", "chat.js", "session.js"];
  const contents = [];
  for (const name of names) {
    const entry = await lstat(fileSystem, join(root, name));
    if (!entry?.isFile?.() || entry.isSymbolicLink()) throw new Error("Relmio refuses an unsafe local SuperGrok managed file.");
    contents.push(await fileSystem.readFile(join(root, name), "utf8"));
  }
  if (sha(`${contents[0]}\n${contents[1]}\n${contents[2]}`) !== marker.configSha256 || sha(`${contents[3]}\n${contents[4]}\n${contents[5]}`) !== marker.sourceSha256) throw new Error("The local SuperGrok managed files changed. Nothing was changed.");
  const markerText = `${JSON.stringify(marker)}\n`;
  const markerEntry = await lstat(fileSystem, join(root, MARKER_FILE));
  if (!markerEntry?.isFile?.() || markerEntry.isSymbolicLink() || await fileSystem.readFile(join(root, MARKER_FILE), "utf8") !== markerText) throw new Error("The local SuperGrok managed marker changed. Nothing was changed.");
  const files = { Dockerfile: contents[0], ".dockerignore": contents[1], [COMPOSE_FILE]: contents[2], "gateway.js": contents[3], "chat.js": contents[4], "session.js": contents[5], [MARKER_FILE]: markerText };
  const rootIdentity = await directoryIdentity(fileSystem, root);
  await attestGeneratedFiles(fileSystem, root, files, rootIdentity);
  return { files, rootIdentity };
}
async function attestManagedFiles(fileSystem, root, marker) {
  const stored = await attestStoredManagedFiles(fileSystem, root, marker);
  const expectedDockerfile = createLocalN8nSuperGrokDockerfile({ installId: marker.installId });
  const expectedDockerignore = createLocalN8nSuperGrokDockerignore();
  const expectedCompose = createLocalN8nSuperGrokComposeFile({ installId: marker.installId, networkName: marker.networkName, tokenSha256: marker.tokenSha256 });
  if (stored.files.Dockerfile !== expectedDockerfile || stored.files[".dockerignore"] !== expectedDockerignore || stored.files[COMPOSE_FILE] !== expectedCompose) throw new Error("The local SuperGrok managed configuration changed. Nothing was changed.");
  return stored;
}
async function attestGeneratedFiles(fileSystem, root, files, expectedRootIdentity) {
  const actualRootIdentity = await directoryIdentity(fileSystem, root);
  if (actualRootIdentity.dev !== expectedRootIdentity.dev || actualRootIdentity.ino !== expectedRootIdentity.ino) {
    throw new Error("The fresh local SuperGrok directory changed. Nothing was changed.");
  }
  const expectedNames = Object.keys(files).sort();
  const actualNames = (await fileSystem.readdir(root)).sort();
  if (actualNames.length !== expectedNames.length || actualNames.some((name, index) => name !== expectedNames[index])) {
    throw new Error("The fresh local SuperGrok directory changed. Nothing was changed.");
  }
  for (const [name, expected] of Object.entries(files)) {
    const path = join(root, name);
    const entry = await lstat(fileSystem, path);
    if (!entry?.isFile?.() || entry.isSymbolicLink() || await fileSystem.readFile(path, "utf8") !== expected) {
      throw new Error("The generated local SuperGrok files changed. Nothing was changed.");
    }
  }
}
async function removeFreshGeneratedRoot(fileSystem, root, files, rootIdentity) {
  await attestGeneratedFiles(fileSystem, root, files, rootIdentity);
  const detached = join(dirname(root), `.${basename(root)}.cleanup-${randomUUID()}`);
  if (await lstat(fileSystem, detached)) throw new Error("Relmio could not reserve fresh local SuperGrok cleanup storage.");
  await fileSystem.rename(root, detached);
  try {
    await attestGeneratedFiles(fileSystem, detached, files, rootIdentity);
    await fileSystem.rm(detached, { recursive: true, force: false });
  } catch (error) {
    if (!(await lstat(fileSystem, root))) {
      try { await fileSystem.rename(detached, root); } catch {}
    }
    throw error;
  }
}
async function initialize(fileSystem, root, baseExists, platform, lockDownPath, freshRoot) {
  const home = resolve(root, "..", "..");
  if (!baseExists) { await fileSystem.mkdir(home, { mode: 0o700 }); await writePrivate(fileSystem, join(home, ROOT_MARKER), `${JSON.stringify({ schemaVersion: 1, kind: "relmio-local-root" })}\n`); }
  await ensurePrivateDirectory(fileSystem, home, platform, lockDownPath); await ensurePrivateDirectory(fileSystem, join(home, "local"), platform, lockDownPath);
  if (await lstat(fileSystem, root)) throw new Error("A fresh local SuperGrok directory appeared during installation. Nothing was changed.");
  try { await fileSystem.mkdir(root, { mode: 0o700 }); }
  catch (error) {
    if (error?.code === "EEXIST") throw new Error("A fresh local SuperGrok directory appeared during installation. Nothing was changed.");
    throw error;
  }
  freshRoot.created = true;
  freshRoot.identity = await directoryIdentity(fileSystem, root);
  await fileSystem.chmod(root, 0o700);
  if (platform === "win32") await lockDownPath(root, { platform });
}
async function resolveDockerHost(runProcess, cwd, env, platform) {
  assertNoDockerOverrides(env); const found = await runProcess({ file: "docker", args: ["context", "inspect", "--format", "{{json .Endpoints.docker.Host}}"], cwd });
  if (found.code !== 0) throw new Error("The selected Docker context could not be inspected.");
  let host; try { host = validateLocalDockerHost(json(found.stdout.trim(), "Docker context"), { platform }); } catch { throw new Error("The selected Docker context is not a local Docker daemon."); }
  return host;
}
async function attestPlan(plan, runProcess, cwd, marker) {
  const n8n = await inspectContainer(runProcess, cwd, plan.dockerHost, plan.n8nContainerId);
  if (n8n.Id !== plan.n8nContainerId || n8n.Name !== `/${plan.n8nContainerName}` || n8n.State?.Running !== true || n8n.NetworkSettings?.Networks?.[plan.networkName]?.NetworkID !== plan.dockerNetworkId) throw new Error("The selected n8n container changed. Create and confirm a fresh plan.");
  const network = await inspectNetwork(runProcess, cwd, plan.dockerHost, plan.networkName);
  if (network.Id !== plan.dockerNetworkId || network.Name !== plan.networkName || network.Driver !== "bridge" || network.Internal === true || !network.Containers?.[plan.n8nContainerId]) throw new Error("The selected n8n Docker network changed. Create and confirm a fresh plan.");
  const connected = Object.keys(network.Containers); if (connected.length > MAX_CONTAINERS) throw new Error("The selected n8n Docker network is too large to attest safely.");
  for (const id of connected) { const item = id === plan.n8nContainerId ? n8n : await inspectContainer(runProcess, cwd, plan.dockerHost, id); const state = item.NetworkSettings?.Networks?.[plan.networkName]; const aliases = state?.Aliases; const claimed = [item.Name?.slice(1), network.Containers[id]?.Name, ...(Array.isArray(aliases) ? aliases : [])].includes(LOCAL_N8N_SUPERGROK_HOSTNAME) || [item.Name?.slice(1), network.Containers[id]?.Name, ...(Array.isArray(aliases) ? aliases : [])].includes(SERVICE_NAME); if (claimed && !labelsOwned(item.Config?.Labels, marker, true)) throw new Error("The n8n-supergrok Docker network alias has a collision. Nothing was changed."); }
}
async function attestOwned(marker, runProcess, cwd, { state = "absent" } = {}) {
  if (!["absent", "exact", "recovery"].includes(state)) throw new TypeError("The local SuperGrok ownership state is invalid.");
  const filter = `label=com.docker.compose.project=${marker.projectName}`;
  const containers = lines((await run(runProcess, { file: "docker", args: ["ps", "--all", "--no-trunc", "--filter", filter, "--format", "{{json .}}"], cwd, dockerHost: marker.dockerHost }, "SuperGrok container ownership check")).stdout, "SuperGrok container ownership check");
  const volumes = lines((await run(runProcess, { file: "docker", args: ["volume", "ls", "--filter", filter, "--format", "{{json .}}"], cwd, dockerHost: marker.dockerHost }, "SuperGrok volume ownership check")).stdout, "SuperGrok volume ownership check");
  if (containers.length > MAX_CONTAINERS || volumes.length > MAX_CONTAINERS) throw new Error("The local SuperGrok ownership check failed closed.");
  const resourcesEmpty = containers.length === 0 && volumes.length === 0;
  const resourcesExact = containers.length === 1 && volumes.length === 1 && volumes[0]?.Name === `${marker.projectName}_grok-home`;
  const resourcesRecoverable = containers.length <= 1 && volumes.length <= 1 && (volumes.length === 0 || volumes[0]?.Name === `${marker.projectName}_grok-home`);
  if ((state === "absent" && !resourcesEmpty) || (state === "exact" && !resourcesExact) || (state === "recovery" && !resourcesRecoverable)) throw new Error("Unexpected Docker resources use the local SuperGrok project identity. Nothing was changed.");
  for (const row of containers) { const id = row?.ID; if (typeof id !== "string" || !/^[a-f0-9]{64}$/u.test(id)) throw new Error("The local SuperGrok Docker ownership metadata is invalid."); const container = await inspectContainer(runProcess, cwd, marker.dockerHost, id); if (!labelsOwned(container.Config?.Labels, marker, true) || container.Name !== `/${marker.projectName}-${SERVICE_NAME}-1`) throw new Error("A Docker resource uses this Relmio project identity without matching ownership. Nothing was changed."); }
  for (const row of volumes) { const name = validateDockerName(row?.Name); const labels = json((await run(runProcess, { file: "docker", args: ["volume", "inspect", "--format", "{{json .Labels}}", name], cwd, dockerHost: marker.dockerHost }, "SuperGrok volume ownership inspection")).stdout.trim(), "SuperGrok volume ownership inspection"); if (!labelsOwned(labels, marker)) throw new Error("A Docker resource uses this Relmio project identity without matching ownership. Nothing was changed."); }
  const image = `${marker.projectName}:local`; const imageResult = await runProcess({ file: "docker", args: ["image", "inspect", "--format", "{{json .}}", image], cwd, dockerHost: marker.dockerHost });
  if (imageResult.code !== 0) {
    if (state === "exact" || !resourcesEmpty) throw new Error("The local SuperGrok image is missing.");
    return true;
  }
  const imageMetadata = json(imageResult.stdout.trim(), "SuperGrok image ownership inspection");
  if (imageMetadata?.Id !== marker.imageId || !labelsOwned(imageMetadata?.Config?.Labels, marker)) throw new Error("A Docker image uses this Relmio project identity without matching ownership. Nothing was changed.");
  if (state === "absent") throw new Error("Unexpected Docker image uses the local SuperGrok project identity. Nothing was changed.");
  return true;
}
async function getOwnedImageId(marker, runProcess, cwd, { allowAbsent = false } = {}) {
  const result = await runProcess({ file: "docker", args: ["image", "inspect", "--format", "{{json .}}", `${marker.projectName}:local`], cwd, dockerHost: marker.dockerHost });
  if (result.code !== 0) {
    if (allowAbsent) return null;
    throw new Error("The local SuperGrok image is missing.");
  }
  const image = json(result.stdout.trim(), "SuperGrok image ownership inspection");
  if (!/^sha256:[a-f0-9]{64}$/u.test(image?.Id) || !labelsOwned(image?.Config?.Labels, marker)) throw new Error("A Docker image uses this Relmio project identity without matching ownership. Nothing was changed.");
  return image.Id;
}
function noPorts(text) { const rows = json(text, "SuperGrok published-port safety check"); const item = Array.isArray(rows) ? rows[0] : rows; if (!item || (Array.isArray(rows) && rows.length !== 1) || !Array.isArray(item.Publishers) || item.Publishers.some((p) => p?.PublishedPort !== 0 || p?.URL !== "")) throw new Error("Safety check failed: the local SuperGrok sidecar published an unexpected host port."); }
async function verify(marker, runProcess, cwd, clientKey) {
  const running = await run(runProcess, { file: "docker", args: composeArgs(marker.projectName, ["ps", "--status", "running", "--services", SERVICE_NAME]), cwd, dockerHost: marker.dockerHost }, "SuperGrok status check"); if (!running.stdout.split(/\s+/u).includes(SERVICE_NAME)) throw new Error("The local SuperGrok sidecar did not reach the running state.");
  noPorts((await run(runProcess, { file: "docker", args: composeArgs(marker.projectName, ["ps", "--format", "json", SERVICE_NAME]), cwd, dockerHost: marker.dockerHost }, "SuperGrok published-port check")).stdout);
  const id = (await run(runProcess, { file: "docker", args: composeArgs(marker.projectName, ["ps", "-q", SERVICE_NAME]), cwd, dockerHost: marker.dockerHost }, "SuperGrok identity check")).stdout.trim();
  if (!/^[a-f0-9]{64}$/u.test(id)) throw new Error("The local SuperGrok Docker identity could not be verified."); const sidecar = await inspectContainer(runProcess, cwd, marker.dockerHost, id); const network = sidecar.NetworkSettings?.Networks?.[marker.networkName]; const ports = sidecar.NetworkSettings?.Ports;
  const mounts = sidecar.Mounts;
  const host = sidecar.HostConfig;
  if (sidecar.Id !== id || sidecar.Name !== `/${marker.projectName}-${SERVICE_NAME}-1` || sidecar.Image !== marker.imageId || sidecar.Config?.Image !== `${marker.projectName}:local` || sidecar.State?.Running !== true || !labelsOwned(sidecar.Config?.Labels, marker, true) || Object.keys(sidecar.NetworkSettings?.Networks ?? {}).length !== 1 || network?.NetworkID !== marker.dockerNetworkId || !Array.isArray(network.Aliases) || !network.Aliases.includes(LOCAL_N8N_SUPERGROK_HOSTNAME) || !network.Aliases.includes(SERVICE_NAME) || !ports || Object.values(ports).some((value) => value !== null) || host?.ReadonlyRootfs !== true || !Array.isArray(host?.CapDrop) || !host.CapDrop.includes("ALL") || !Array.isArray(host?.SecurityOpt) || !host.SecurityOpt.includes("no-new-privileges:true") || (host.PortBindings && Object.keys(host.PortBindings).length !== 0) || !Array.isArray(mounts) || mounts.length !== 1 || mounts[0]?.Type !== "volume" || mounts[0]?.Name !== `${marker.projectName}_grok-home` || mounts[0]?.Destination !== "/home/node/.grok" || mounts[0]?.RW !== true) throw new Error("The local SuperGrok Docker identity could not be verified.");
  if (clientKey) { const result = await run(runProcess, { file: "docker", args: ["exec", "-i", id, "node", "-e", VERIFIER], cwd, dockerHost: marker.dockerHost, input: clientKey }, "SuperGrok private-network verification"); if (result.stdout.trim() !== "ok") throw new Error("The local SuperGrok private-network verification failed."); }
}
async function cleanup(marker, runProcess, cwd) { await run(runProcess, { file: "docker", args: composeArgs(marker.projectName, ["down", "--volumes", "--remove-orphans"]), cwd, dockerHost: marker.dockerHost }, "SuperGrok cleanup"); const filter = `label=com.docker.compose.project=${marker.projectName}`; for (const args of [["ps", "--all", "--filter", filter, "--format", "{{json .}}"], ["volume", "ls", "--filter", filter, "--format", "{{json .}}"]]) if (lines((await run(runProcess, { file: "docker", args, cwd, dockerHost: marker.dockerHost }, "SuperGrok cleanup verification")).stdout, "SuperGrok cleanup verification").length) throw new Error("Relmio could not confirm removal of its local SuperGrok resources. The managed directory was kept."); }
async function removeOwnedImage(marker, runProcess, cwd) {
  await attestOwned(marker, runProcess, cwd, { state: "recovery" });
  const image = `${marker.projectName}:local`;
  const listed = await runProcess({ file: "docker", args: ["image", "inspect", image], cwd, dockerHost: marker.dockerHost });
  if (listed.code !== 0) return;
  await run(runProcess, { file: "docker", args: ["image", "rm", image], cwd, dockerHost: marker.dockerHost }, "SuperGrok image removal");
  const absent = await runProcess({ file: "docker", args: ["image", "inspect", image], cwd, dockerHost: marker.dockerHost });
  if (absent.code === 0) throw new Error("Relmio could not confirm removal of its local SuperGrok image. The managed directory was kept.");
}
async function recoverOwnedProject(marker, runProcess, cwd) {
  await attestOwned(marker, runProcess, cwd, { state: "recovery" });
  await cleanup(marker, runProcess, cwd);
  await removeOwnedImage(marker, runProcess, cwd);
}
async function source(read, label) { const value = await read(); if (typeof value !== "string" || !value.trim() || Buffer.byteLength(value) > 512 * 1024) throw new Error(`The packaged SuperGrok ${label} source is invalid.`); return value; }
const defaultReadRuntime = () => defaultFileSystem.readFile(new URL("../supergrok/runtime.js", import.meta.url), "utf8");
const defaultReadChat = () => defaultFileSystem.readFile(new URL("../supergrok/chat.js", import.meta.url), "utf8");
const defaultReadSession = () => defaultFileSystem.readFile(new URL("../supergrok/session.js", import.meta.url), "utf8");

export async function installLocalN8nSuperGrok({ plan, confirmed }, dependencies = {}) {
  if (confirmed !== true) throw new Error("Confirm installation of the managed local n8n SuperGrok bridge.");
  const {
    fileSystem = defaultFileSystem, env = process.env, homeDirectory = homedir(),
    runProcess = runLocalProcess, platform = process.platform,
    lockDownPath = lockDownLocalPath, getProcessIdentity, lifecycleLockNow = Date.now,
    randomBytes = defaultRandomBytes, readRuntime = defaultReadRuntime,
    readChat = defaultReadChat, readSession = defaultReadSession,
  } = dependencies;
  assertNoDockerOverrides(env);
  const normalized = normalizeLocalN8nSuperGrokPlan(plan);
  const root = await resolveLocalN8nSuperGrokInstallRoot({ env, homeDirectory, fileSystem, platform });
  const release = await acquireLocalN8nSuperGrokChangeLock({ fileSystem, getProcessIdentity, installRoot: root, lockDownPath, now: lifecycleLockNow, platform });
  return settleLocalIntegrationLifecycleOperation({
    completionLabel: "Local n8n SuperGrok installation",
    releaseLock: release,
    operation: async () => {
      const managed = await inspectManaged(fileSystem, root);
      if (managed.marker) throw new Error("The managed local n8n SuperGrok bridge is already installed. Remove it before installing again.");
      const entropy = randomBytes(64);
      if (!Buffer.isBuffer(entropy) || entropy.length !== 64) throw new Error("Relmio could not create a strong SuperGrok identity.");
      const installId = entropy.subarray(0, 16).toString("hex");
      const clientKey = entropy.subarray(16, 48).toString("hex");
      const marker = {
        schemaVersion: MARKER_SCHEMA, kind: "relmio-local-n8n-supergrok", target: LOCAL_N8N_SUPERGROK_TARGET,
        installId, projectName: `${PROJECT_PREFIX}-${installId}`, dockerHost: normalized.dockerHost,
        n8nContainerId: normalized.n8nContainerId, n8nContainerName: normalized.n8nContainerName,
        dockerNetworkId: normalized.dockerNetworkId, networkName: normalized.networkName,
        tokenSha256: sha(clientKey), configSha256: "", sourceSha256: "", imageId: "",
      };
      const parent = dirname(resolve(root, "..", ".."));
      if ((await resolveDockerHost(runProcess, parent, env, platform)) !== normalized.dockerHost) throw new Error("The selected Docker context changed. Create and confirm a fresh plan.");
      await attestOwned(marker, runProcess, parent);
      await attestPlan(normalized, runProcess, parent, marker);
      const [runtime, chat, session] = await Promise.all([source(readRuntime, "runtime"), source(readChat, "chat"), source(readSession, "session")]);
      const dockerfile = createLocalN8nSuperGrokDockerfile({ installId });
      const dockerignore = createLocalN8nSuperGrokDockerignore();
      const compose = createLocalN8nSuperGrokComposeFile({ installId, networkName: normalized.networkName, tokenSha256: marker.tokenSha256 });
      marker.configSha256 = sha(`${dockerfile}\n${dockerignore}\n${compose}`);
      marker.sourceSha256 = sha(`${runtime}\n${chat}\n${session}`);
      const generatedFiles = { Dockerfile: dockerfile, ".dockerignore": dockerignore, "gateway.js": runtime, "chat.js": chat, "session.js": session, [COMPOSE_FILE]: compose };
      const freshRoot = { created: false, identity: null, files: {} };
      let buildAttempted = false;
      try {
        await initialize(fileSystem, root, managed.baseExists, platform, lockDownPath, freshRoot);
        for (const [name, data] of Object.entries(generatedFiles)) {
          await writeExclusivePrivate(fileSystem, join(root, name), data);
          freshRoot.files[name] = data;
        }
        await run(runProcess, { file: "docker", args: composeArgs(marker.projectName, ["config", "--quiet"]), cwd: root, dockerHost: marker.dockerHost }, "SuperGrok Compose validation");
        await attestPlan(normalized, runProcess, root, marker);
        await attestOwned(marker, runProcess, root);
        buildAttempted = true;
        await run(runProcess, { file: "docker", args: composeArgs(marker.projectName, ["build", SERVICE_NAME]), cwd: root, dockerHost: marker.dockerHost }, "SuperGrok image build");
        marker.imageId = await getOwnedImageId(marker, runProcess, root);
        const markerText = `${JSON.stringify(marker)}\n`;
        await writeExclusivePrivate(fileSystem, join(root, MARKER_FILE), markerText);
        freshRoot.files[MARKER_FILE] = markerText;
        await attestManagedFiles(fileSystem, root, marker);
        await run(runProcess, { file: "docker", args: composeArgs(marker.projectName, ["up", "-d", "--wait", "--wait-timeout", "90", "--no-deps", SERVICE_NAME]), cwd: root, dockerHost: marker.dockerHost }, "SuperGrok start");
        await attestOwned(marker, runProcess, root, { state: "exact" });
        await verify(marker, runProcess, root, clientKey);
        return { target: LOCAL_N8N_SUPERGROK_TARGET, endpoint: LOCAL_N8N_SUPERGROK_ENDPOINT, baseUrl: LOCAL_N8N_SUPERGROK_ENDPOINT, protocol: "openai-chat-completions", n8nContainerName: normalized.n8nContainerName, networkName: normalized.networkName, hostPublication: "none", clientKey, credentialShownOnce: true, deploymentMode: "installed" };
      } catch (error) {
        if (freshRoot.created && !buildAttempted) {
          try {
            // `docker compose config` only reads the generated file. Do not
            // run `down` after it rejects that same file; prove this fresh
            // project has no Docker resources, then remove the exact files.
            await attestGeneratedFiles(fileSystem, root, freshRoot.files, freshRoot.identity);
            await attestOwned(marker, runProcess, root, { state: "absent" });
            await removeFreshGeneratedRoot(fileSystem, root, freshRoot.files, freshRoot.identity);
          } catch { throw new Error("SuperGrok installation failed and automatic cleanup could not be confirmed. Inspect only the Relmio SuperGrok project before retrying."); }
        } else if (freshRoot.created) {
          try {
            // A failed build can still leave a complete labelled image. Capture
            // its attested identity before recovery so cleanup remains owned.
            if (!marker.imageId) {
              const imageId = await getOwnedImageId(marker, runProcess, root, { allowAbsent: true });
              if (imageId) {
                marker.imageId = imageId;
                const markerText = `${JSON.stringify(marker)}\n`;
                await writeExclusivePrivate(fileSystem, join(root, MARKER_FILE), markerText);
                freshRoot.files[MARKER_FILE] = markerText;
              }
            }
            await recoverOwnedProject(marker, runProcess, root);
            await removeFreshGeneratedRoot(fileSystem, root, freshRoot.files, freshRoot.identity);
          }
          catch { throw new Error("SuperGrok installation failed and automatic cleanup could not be confirmed. Inspect only the Relmio SuperGrok project before retrying."); }
        }
        throw error;
      }
    },
  });
}

export async function attestLocalN8nSuperGrokInstallation({ installDirectory }, dependencies = {}) {
  const { fileSystem = defaultFileSystem, runProcess = runLocalProcess, platform = process.platform } = dependencies;
  const root = assertInstallRoot(installDirectory);
  const managed = await inspectManaged(fileSystem, root);
  const marker = managed.marker;
  if (!marker) throw new Error("The managed local n8n SuperGrok bridge is not installed.");
  validateLocalDockerHost(marker.dockerHost, { platform });
  await attestManagedFiles(fileSystem, root, marker);
  await attestPlan(marker, runProcess, root, marker);
  await attestOwned(marker, runProcess, root, { state: "exact" });
  await verify(marker, runProcess, root);
  return { installDirectory: root, projectName: marker.projectName, dockerHost: marker.dockerHost, serviceName: SERVICE_NAME };
}
export async function getLocalN8nSuperGrokStatus(dependencies = {}) {
  const {
    fileSystem = defaultFileSystem,
    env = process.env,
    homeDirectory = homedir(),
    runProcess = runLocalProcess,
    platform = process.platform,
  } = dependencies;
  const absent = { target: LOCAL_N8N_SUPERGROK_TARGET, managed: false, state: "absent" };
  try {
    const root = await resolveLocalN8nSuperGrokInstallRoot({ env, homeDirectory, fileSystem, platform });
    if (!(await lstat(fileSystem, root))) return absent;
    const managed = await inspectManaged(fileSystem, root);
    if (!managed.marker) return absent;
    const marker = managed.marker;
    if ((await resolveDockerHost(runProcess, root, env, platform)) !== marker.dockerHost) {
      return { target: LOCAL_N8N_SUPERGROK_TARGET, managed: false, state: "unavailable" };
    }
    await attestStoredManagedFiles(fileSystem, root, marker);
    await attestOwned(marker, runProcess, root, { state: "recovery" });
    const snapshot = {
      target: LOCAL_N8N_SUPERGROK_TARGET,
      endpoint: LOCAL_N8N_SUPERGROK_ENDPOINT,
      auth: { configured: true, disclosure: "one-time" },
      canRemove: true,
    };
    try {
      await attestOwned(marker, runProcess, root, { state: "exact" });
      await verify(marker, runProcess, root);
    } catch {
      return { target: LOCAL_N8N_SUPERGROK_TARGET, managed: true, state: "partial", snapshot };
    }
    return {
      target: LOCAL_N8N_SUPERGROK_TARGET,
      managed: true,
      state: "healthy",
      snapshot,
    };
  } catch {
    return { target: LOCAL_N8N_SUPERGROK_TARGET, managed: false, state: "unavailable" };
  }
}
export async function removeLocalN8nSuperGrok({ confirmed }, dependencies = {}) {
  if (confirmed !== true) throw new Error("Confirm removal of the managed local n8n SuperGrok bridge.");
  const { fileSystem = defaultFileSystem, env = process.env, homeDirectory = homedir(), runProcess = runLocalProcess, platform = process.platform, lockDownPath = lockDownLocalPath, getProcessIdentity, lifecycleLockNow = Date.now } = dependencies;
  assertNoDockerOverrides(env);
  const root = await resolveLocalN8nSuperGrokInstallRoot({ env, homeDirectory, fileSystem, platform });
  const release = await acquireLocalN8nSuperGrokChangeLock({ fileSystem, getProcessIdentity, installRoot: root, lockDownPath, now: lifecycleLockNow, platform });
  return settleLocalIntegrationLifecycleOperation({
    completionLabel: "Local n8n SuperGrok removal",
    releaseLock: release,
    operation: async () => {
      const managed = await inspectManaged(fileSystem, root);
      if (!managed.marker) throw new Error("The managed local n8n SuperGrok bridge is not installed.");
      const marker = managed.marker;
      const ownedFiles = await attestStoredManagedFiles(fileSystem, root, marker);
      await recoverOwnedProject(marker, runProcess, root);
      await removeFreshGeneratedRoot(fileSystem, root, ownedFiles.files, ownedFiles.rootIdentity);
      return { removed: true, target: LOCAL_N8N_SUPERGROK_TARGET };
    },
  });
}

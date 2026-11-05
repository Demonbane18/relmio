import { createHash, randomUUID } from "node:crypto";
import * as defaultFileSystem from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import {
  LOCAL_N8N_CLAUDE_TARGET, LOCAL_N8N_CLAUDE_ENDPOINT, createLocalN8nClaudePlan, normalizeLocalN8nClaudePlan,
  validateClaudeReview, createSafeLocalN8nClaudeSnapshot,
} from "../domain/local-n8n-claude.js";
import { CANDIDATE_VERSION, validModels } from "../claude/launcher.js";
import { buildClaudeCompanionBundle, claudeArchFromMachine, parseClaudeAuthStatus, renewClaudeLaunchConfig } from "../claude/companion.js";
import { validateDockerName } from "../domain/validation.js";
import { runLocalProcess, validateLocalDockerHost, lockDownLocalPath } from "../infrastructure/local-process.js";
import { getLocalProcessIdentity } from "../infrastructure/process-identity.js";
import { acquireLocalIntegrationLifecycleLock, settleLocalIntegrationLifecycleOperation } from "./local-integration-lifecycle-lock.js";

const ALIAS = "relmio-claude";
const IMAGE = `relmio-claude:${CANDIDATE_VERSION}`;
const VOLUME = "relmio-claude_claude-account";
const MARKER = ".managed-by-relmio.json";
const ROOT_MARKER = ".managed-by-relmio-root.json";
const ID = /^[a-f0-9]{64}$/u;
const SHA = /^[a-f0-9]{64}$/u;
const FILES = ["Dockerfile", "compose.yml", "login.sh", "renew.sh", "app/src/gateway/claude-chat.js", "app/src/claude/launcher.js", "app/package.json", ".env", "launch.json"];
const DOCKER_ENV = new Set(["DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH", "BUILDKIT_HOST"]);
const AUTH_ARGS = ["env", "-i", "HOME=/home/claude", "USER=claude", "LOGNAME=claude", "CLAUDE_CONFIG_DIR=/data/account/config", "PATH=/usr/bin:/bin:/usr/sbin:/sbin", "TMPDIR=/tmp", `/opt/claude/${CANDIDATE_VERSION}/claude`, "auth"];
// http.get to 127.0.0.1 with Host relmio-claude:14502. fetch() cannot set Host, and companionHost mode rejects loopback Host.
export const LOCAL_CLAUDE_HEALTH_PROBE = 'const http=require("node:http");let b="";process.stdin.setEncoding("utf8");process.stdin.on("data",x=>{b+=x;if(b.length>256)process.exit(2)});process.stdin.on("end",()=>{if(!/^[A-Za-z0-9_-]{43}$/u.test(b))process.exit(2);let n=0;const once=()=>{const req=http.get({host:"127.0.0.1",port:14502,path:"/health",headers:{Host:"relmio-claude:14502",Authorization:"Bearer "+b},timeout:1000},res=>{res.resume();if(res.statusCode===200){process.stdout.write("ok");return}process.exit(1)});req.on("timeout",()=>req.destroy());req.on("error",()=>{if(++n>=90)process.exit(1);setTimeout(once,1000)})};once()})';
export const LOCAL_CLAUDE_MODELS_PROBE = 'const http=require("node:http");let b="";process.stdin.setEncoding("utf8");process.stdin.on("data",x=>{b+=x;if(b.length>256)process.exit(2)});process.stdin.on("end",()=>{if(!/^[A-Za-z0-9_-]{43}$/u.test(b))process.exit(2);const req=http.get({host:"127.0.0.1",port:14502,path:"/v1/models",headers:{Host:"relmio-claude:14502",Authorization:"Bearer "+b},timeout:10000},res=>{let d="";res.setEncoding("utf8");res.on("data",c=>d+=c);res.on("end",()=>{if(res.statusCode!==200)process.exit(1);try{process.stdout.write(JSON.stringify(JSON.parse(d).data.map(m=>m.id)))}catch{process.exit(1)}})});req.on("timeout",()=>req.destroy());req.on("error",()=>process.exit(1))})';

const sha = value => createHash("sha256").update(value).digest("hex");
function noOverrides(env) {
  if (!env || typeof env !== "object" || Array.isArray(env) || Object.entries(env).some(([key, value]) => DOCKER_ENV.has(key.toUpperCase()) && value)) throw new Error("Relmio requires the selected local Docker context without environment overrides.");
}
function rootPath(path) {
  if (typeof path !== "string" || !isAbsolute(path) || /[\0\r\n,]/u.test(path) || resolve(path) !== path || basename(path) !== LOCAL_N8N_CLAUDE_TARGET || basename(dirname(path)) !== "local" || basename(resolve(path, "..", "..")) !== ".relmio") throw new Error("The local Claude install directory is invalid.");
  return path;
}
async function stat(fs, path) { try { return await fs.lstat(path); } catch (error) { if (error?.code === "ENOENT") return null; throw error; } }
function directory(entry) { if (!entry?.isDirectory?.() || entry.isSymbolicLink()) throw new Error("Relmio refuses an unsafe local Claude directory."); }
async function privateFile(fs, path, data, { exclusive = false, mode = 0o600 } = {}) {
  const before = await stat(fs, path);
  if (before && (!before.isFile?.() || before.isSymbolicLink() || exclusive)) throw new Error("Relmio refuses to overwrite an unsafe local Claude file.");
  const temporary = exclusive ? path : `${path}.tmp-${randomUUID()}`;
  await fs.writeFile(temporary, data, { flag: "wx", mode });
  await fs.chmod(temporary, mode);
  if (!exclusive) await fs.rename(temporary, path);
}
function json(text) {
  if (typeof text !== "string" || Buffer.byteLength(text) > 1024 * 1024) throw new Error("Docker returned invalid Claude metadata.");
  try { return JSON.parse(text); } catch { throw new Error("Docker returned invalid Claude metadata."); }
}
async function run(deps, root, host, args, extra = {}) {
  const result = await deps.runProcess({ file: "docker", args, cwd: root, ...(host ? { dockerHost: host } : {}), maxOutputBytes: 1024 * 1024, ...extra });
  if (result?.code !== 0) throw new Error("Local Claude Docker operation failed.");
  return result;
}
async function inspect(deps, root, host, kind, name) {
  return json((await run(deps, root, host, [kind, "inspect", "--format", "{{json .}}", name])).stdout.trim());
}
function options(deps = {}) {
  return { fileSystem: defaultFileSystem, env: process.env, homeDirectory: homedir(), runProcess: runLocalProcess,
    platform: process.platform, lockDownPath: lockDownLocalPath, getProcessIdentity: getLocalProcessIdentity,
    now: () => new Date(), ...deps };
}
export async function resolveLocalN8nClaudeInstallRoot(dependencies = {}) {
  const deps = options(dependencies);
  const home = typeof deps.env.RELMIO_HOME === "string" && deps.env.RELMIO_HOME.trim() ? deps.env.RELMIO_HOME : join(deps.homeDirectory, ".relmio");
  if (!isAbsolute(home) || /[\0\r\n]/u.test(home) || basename(home) !== ".relmio") throw new Error("The Relmio local storage path is invalid.");
  const parent = dirname(resolve(home));
  if (await deps.fileSystem.realpath(parent) !== parent) throw new Error("Relmio refuses a local storage path with a symbolic-link ancestor.");
  return join(parent, ".relmio", "local", LOCAL_N8N_CLAUDE_TARGET);
}
export async function acquireLocalN8nClaudeChangeLock({ installRoot, ...dependencies } = {}) {
  const deps = options(dependencies);
  const root = rootPath(installRoot);
  return acquireLocalIntegrationLifecycleLock({ fileSystem: deps.fileSystem, getProcessIdentity: deps.getProcessIdentity,
    lockDownPath: deps.lockDownPath, platform: deps.platform, now: deps.lifecycleLockNow ?? Date.now,
    lockPath: join(dirname(resolve(root, "..", "..")), ".relmio-local-n8n-claude-oauth.lock"), label: "local Claude companion operation lock" });
}
async function dockerHost(deps, root) {
  noOverrides(deps.env);
  const host = json((await run(deps, root, null, ["context", "inspect", "--format", "{{json .Endpoints.docker.Host}}"])).stdout.trim());
  return validateLocalDockerHost(host, { platform: deps.platform });
}
async function readMarker(deps, root) {
  const fs = deps.fileSystem;
  const home = resolve(root, "..", "..");
  const homeEntry = await stat(fs, home);
  if (!homeEntry) return null;
  directory(homeEntry);
  const entry = await stat(fs, join(home, ROOT_MARKER));
  if (!entry?.isFile?.() || entry.isSymbolicLink()) throw new Error("The Relmio local storage directory is not an owned managed root.");
  const rootMarker = json(await fs.readFile(join(home, ROOT_MARKER), "utf8"));
  if (rootMarker?.schemaVersion !== 1 || rootMarker.kind !== "relmio-local-root") throw new Error("The Relmio root marker is invalid.");
  const local = await stat(fs, dirname(root));
  if (!local) return null;
  directory(local);
  const found = await stat(fs, root);
  if (!found) return null;
  directory(found);
  const markerFile = await stat(fs, join(root, MARKER));
  if (!markerFile?.isFile?.() || markerFile.isSymbolicLink() || markerFile.size > 16384) throw new Error("The local Claude directory is unmanaged. Remove it yourself before wizard setup.");
  const marker = json(await fs.readFile(join(root, MARKER), "utf8"));
  if (marker?.schemaVersion !== 1 || marker.kind !== "relmio-claude-companion" || !/^[a-f0-9]{32}$/u.test(marker.installId ?? "") ||
      marker.target !== LOCAL_N8N_CLAUDE_TARGET || !SHA.test(marker.tokenSha256 ?? "") ||
      !["arm64", "amd64"].includes(marker.arch) || !validModels(marker.models) || !ID.test(marker.n8nContainerId ?? "") ||
      !ID.test(marker.dockerNetworkId ?? "") || !marker.files || Object.keys(marker.files).length !== FILES.length ||
      FILES.some(name => !SHA.test(marker.files[name] ?? "")) || (marker.imageId !== null && !/^sha256:[a-f0-9]{64}$/u.test(marker.imageId ?? ""))) throw new Error("The local Claude managed marker is invalid.");
  validateLocalDockerHost(marker.dockerHost, { platform: deps.platform });
  validateDockerName(marker.network); validateDockerName(marker.n8nContainerName);
  renewClaudeLaunchConfig(marker.launchConfig, () => deps.now().getTime());
  if (JSON.stringify(marker.launchConfig.models) !== JSON.stringify(marker.models) ||
      marker.expiresAt !== marker.launchConfig.qualification.expiresAt ||
      marker.files["launch.json"] !== sha(`${JSON.stringify(marker.launchConfig, null, 2)}\n`)) throw new Error("The local Claude approval marker is invalid.");
  return marker;
}
function owned(container, marker) {
  const labels = container?.Config?.Labels;
  return marker && container.Name === `/${ALIAS}` && labels?.["com.relmio.managed"] === "claude-companion" &&
    labels["com.docker.compose.project"] === ALIAS && labels["com.docker.compose.service"] === ALIAS &&
    labels["io.relmio.target"] === LOCAL_N8N_CLAUDE_TARGET && labels["io.relmio.install"] === marker.installId && labels["io.relmio.managed"] === "true";
}
async function resources(deps, root, host, marker) {
  const result = await run(deps, root, host, ["ps", "--all", "--no-trunc", "--format", "{{json .}}"]);
  const rows = result.stdout.trim() ? result.stdout.trim().split("\n").map(json) : [];
  if (rows.length > 100) throw new Error("The local Claude container inventory is too large to attest.");
  let container = null;
  for (const row of rows) {
    if (!ID.test(row.ID ?? "")) throw new Error("The local Claude container inventory is invalid.");
    const item = await inspect(deps, root, host, "container", row.ID);
    if (item.Name === `/${ALIAS}` || item.Config?.Labels?.["com.docker.compose.project"] === ALIAS) {
      if (container || !owned(item, marker)) throw new Error("An existing non-wizard relmio-claude container is here. Remove the manual companion yourself from its original bundle directory before using this wizard. Removing its login volume signs Claude out. The wizard also needs its old image removed. Relmio did not change it.");
      container = item;
    }
  }
  const volumeResult = await deps.runProcess({ file: "docker", args: ["volume", "inspect", "--format", "{{json .}}", VOLUME], cwd: root, dockerHost: host });
  if (volumeResult.code === 0) {
    const volume = json(volumeResult.stdout);
    const labeled = volume.Name === VOLUME && volume.Labels?.["com.docker.compose.project"] === ALIAS && volume.Labels?.["com.docker.compose.volume"] === "claude-account";
    // A labeled volume with no marker is a login left by a removed companion. Any other volume stays refused.
    if (!labeled) throw new Error("An unowned Claude login volume already exists. Nothing was changed.");
  }
  return container;
}
async function boundary(deps, root, plan, marker) {
  const n8n = await inspect(deps, root, plan.dockerHost, "container", plan.n8nContainerId);
  const network = await inspect(deps, root, plan.dockerHost, "network", plan.networkName);
  if (n8n.Id !== plan.n8nContainerId || n8n.Name !== `/${plan.n8nContainerName}` || n8n.State?.Running !== true ||
      n8n.NetworkSettings?.Networks?.[plan.networkName]?.NetworkID !== plan.dockerNetworkId ||
      network.Id !== plan.dockerNetworkId || network.Name !== plan.networkName || network.Driver !== "bridge" || network.Internal === true ||
      !network.Containers?.[plan.n8nContainerId] || Object.keys(network.Containers).length > 100) throw new Error("The selected n8n container or network changed. Review a fresh plan.");
  for (const [id, endpoint] of Object.entries(network.Containers)) {
    if (!ID.test(id)) throw new Error("The n8n Docker network metadata is invalid.");
    const item = id === plan.n8nContainerId ? n8n : await inspect(deps, root, plan.dockerHost, "container", id);
    const aliases = item.NetworkSettings?.Networks?.[plan.networkName]?.Aliases;
    if ([item.Name?.slice(1), endpoint?.Name, ...(Array.isArray(aliases) ? aliases : [])].includes(ALIAS) && !owned(item, marker)) throw new Error("The relmio-claude Docker network alias has a collision. Nothing was changed.");
  }
}
async function launchHash(deps, root, marker, path = join(root, "launch.json"), { prepare = false } = {}) {
  if (!marker.imageId) {
    if (sha(await deps.fileSystem.readFile(path)) !== marker.files["launch.json"]) throw new Error("The Claude approval file changed.");
    return;
  }
  const mount = `type=bind,src=${path},dst=/launch.json`;
  const base = ["run", "--rm", "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges:true"];
  if (prepare) await run(deps, root, marker.dockerHost, [...base, "--cap-add", "CHOWN", "--user", "0:0", "--mount", mount, "--entrypoint", "/bin/chown", marker.imageId, "10001:10001", "/launch.json"]);
  const probe = 'const fs=require("node:fs"),c=require("node:crypto");const s=fs.statSync("/launch.json");if(!s.isFile()||(s.mode&63)!==0||![0,10001].includes(s.uid))process.exit(1);process.stdout.write(c.createHash("sha256").update(fs.readFileSync("/launch.json")).digest("hex"))';
  const result = await run(deps, root, marker.dockerHost, [...base, "--user", "10001:10001", "--mount", `${mount},readonly`, "--entrypoint", "node", marker.imageId, "-e", probe]);
  if (result.stdout.trim() !== marker.files["launch.json"]) throw new Error("The Claude approval file is unreadable or changed.");
}
async function attestFiles(deps, root, marker, { skipLaunch = false } = {}) {
  const fs = deps.fileSystem;
  for (const name of FILES) {
    for (let parent = dirname(join(root, name)); parent !== dirname(root); parent = dirname(parent)) directory(await stat(fs, parent));
    const entry = await stat(fs, join(root, name));
    if (!entry?.isFile?.() || entry.isSymbolicLink() || entry.nlink !== 1 || entry.size > 1024 * 1024) throw new Error("The managed Claude files are unsafe.");
    if (name !== "launch.json" && sha(await fs.readFile(join(root, name))) !== marker.files[name]) throw new Error("The managed Claude files changed. Nothing was changed.");
  }
  if (!skipLaunch) await launchHash(deps, root, marker);
}
async function attestContainer(deps, root, marker, { running = true } = {}) {
  const item = await resources(deps, root, marker.dockerHost, marker);
  if (!item) { if (!running) return null; throw new Error("The managed Claude companion is missing."); }
  const host = item.HostConfig; const mounts = item.Mounts;
  const network = item.NetworkSettings?.Networks?.[marker.network];
  if (!ID.test(item.Id ?? "") || item.Image !== marker.imageId || item.Config?.Image !== IMAGE ||
      item.Config?.User !== "10001:10001" || (running && item.State?.Running !== true) ||
      host?.ReadonlyRootfs !== true || !host.CapDrop?.includes("ALL") || !host.SecurityOpt?.includes("no-new-privileges:true") ||
      Object.keys(host.PortBindings ?? {}).length !== 0 || Object.values(item.NetworkSettings?.Ports ?? {}).some(value => value !== null) ||
      Object.keys(item.NetworkSettings?.Networks ?? {}).length !== 1 || network?.NetworkID !== marker.dockerNetworkId || !network.Aliases?.includes(ALIAS) ||
      !Array.isArray(mounts) || mounts.length !== 2 || !mounts.some(mount => mount.Type === "volume" && mount.Name === VOLUME && mount.Destination === "/data/account" && mount.RW === true) ||
      !mounts.some(mount => mount.Type === "bind" && mount.Source === join(root, "launch.json") && mount.Destination === "/run/relmio/launch.json" && mount.RW === false)) throw new Error("The local Claude companion safety attestation failed.");
  return item;
}
function compose(args) { return ["compose", "--project-name", ALIAS, "--file", "compose.yml", ...args]; }
async function withChange(dependencies, operation) {
  const deps = options(dependencies); noOverrides(deps.env);
  const root = await resolveLocalN8nClaudeInstallRoot(deps);
  const release = await acquireLocalN8nClaudeChangeLock({ ...deps, installRoot: root });
  return settleLocalIntegrationLifecycleOperation({ completionLabel: "Local Claude change", releaseLock: release,
    operation: async () => operation(deps, root) });
}

export async function inspectLocalN8nClaudeHost(selection, dependencies = {}) {
  const deps = options(dependencies);
  const safe = createLocalN8nClaudePlan({ ...selection, arch: "arm64" });
  const root = await resolveLocalN8nClaudeInstallRoot(deps);
  const marker = await readMarker(deps, root);
  const cwd = dirname(resolve(root, "..", ".."));
  const host = await dockerHost(deps, cwd);
  if (host !== safe.dockerHost) throw new Error("The selected Docker context changed.");
  await resources(deps, cwd, host, marker);
  const arch = claudeArchFromMachine((await run(deps, cwd, host, ["info", "--format", "{{.Architecture}}"])).stdout);
  await boundary(deps, cwd, safe, marker);
  return { arch };
}

async function ownedImage(deps, root, marker, { absentAllowed = false } = {}) {
  const result = await deps.runProcess({ file: "docker", args: ["image", "inspect", "--format", "{{json .}}", IMAGE], cwd: root, dockerHost: marker.dockerHost });
  if (result.code !== 0 && absentAllowed) return null;
  if (result.code !== 0) throw new Error("The local Claude companion image is missing.");
  const image = json(result.stdout);
  const labels = image.Config?.Labels;
  if (!/^sha256:[a-f0-9]{64}$/u.test(image.Id ?? "") || (marker.imageId && marker.imageId !== image.Id) ||
      labels?.["io.relmio.target"] !== LOCAL_N8N_CLAUDE_TARGET || labels["io.relmio.install"] !== marker.installId ||
      labels["io.relmio.managed"] !== "true") throw new Error("An unowned Claude companion image already exists. Nothing was changed.");
  return image.Id;
}

async function initialize(deps, root) {
  const fs = deps.fileSystem; const home = resolve(root, "..", "..");
  if (!(await stat(fs, home))) {
    await fs.mkdir(home, { mode: 0o700 });
    await privateFile(fs, join(home, ROOT_MARKER), `${JSON.stringify({ schemaVersion: 1, kind: "relmio-local-root" })}\n`, { exclusive: true });
  }
  for (const path of [home, dirname(root)]) {
    const existing = await stat(fs, path);
    if (existing) directory(existing); else await fs.mkdir(path, { mode: 0o700 });
    await fs.chmod(path, 0o700);
    if (deps.platform === "win32") await deps.lockDownPath(path, { platform: deps.platform });
  }
  if (await stat(fs, root)) throw new Error("A local Claude directory appeared during installation. Nothing was overwritten.");
  await fs.mkdir(root, { mode: 0o700 });
}

export async function installLocalN8nClaude({ plan, confirmed, review }, dependencies = {}) {
  if (confirmed !== true) throw new Error("Confirm installation of the local Claude companion.");
  validateClaudeReview(review);
  const normalized = normalizeLocalN8nClaudePlan(plan);
  return withChange(dependencies, async (deps, root) => {
    const existing = await readMarker(deps, root);
    if (existing) throw new Error("The wizard-managed Claude companion is already installed. Remove it before installing again.");
    const selected = await inspectLocalN8nClaudeHost(normalized, deps);
    if (selected.arch !== normalized.arch) throw new Error("The Docker architecture changed. Review a fresh plan.");
    const buildBundle = deps.buildBundle ?? buildClaudeCompanionBundle;
    const bundle = await buildBundle({ network: normalized.networkName, arch: normalized.arch, models: normalized.models, now: () => deps.now().getTime() });
    const installId = randomUUID().replaceAll("-", "");
    const marker = { schemaVersion: 1, kind: "relmio-claude-companion", target: LOCAL_N8N_CLAUDE_TARGET,
      installId, network: normalized.networkName, arch: normalized.arch, models: [...normalized.models],
      dockerHost: normalized.dockerHost, n8nContainerId: normalized.n8nContainerId,
      n8nContainerName: normalized.n8nContainerName, dockerNetworkId: normalized.dockerNetworkId,
      tokenSha256: bundle.keySha256, launchConfig: bundle.launchConfig, expiresAt: bundle.expiresAt, imageId: null, files: {} };
    const image = await deps.runProcess({ file: "docker", args: ["image", "inspect", IMAGE], cwd: dirname(resolve(root, "..", "..")), dockerHost: marker.dockerHost });
    if (image.code === 0) throw new Error("An existing Claude image is not owned by this wizard. Remove the manual companion from its original bundle directory first.");
    if (!Array.isArray(bundle.files) || bundle.files.length !== FILES.length ||
        new Set(bundle.files.map(file => file.path)).size !== FILES.length ||
        bundle.files.some(file => !FILES.includes(file.path) || typeof file.contents !== "string")) throw new Error("The packaged Claude bundle is invalid.");
    for (const file of bundle.files) {
      if (file.path === "compose.yml") {
        const label = '      com.relmio.managed: "claude-companion"';
        if (file.contents.split(label).length !== 2) throw new Error("The packaged Claude Compose ownership label is invalid.");
        file.contents = file.contents.replace(label, `${label}\n      io.relmio.managed: "true"\n      io.relmio.target: "${LOCAL_N8N_CLAUDE_TARGET}"\n      io.relmio.install: "${installId}"`);
      }
      if (file.path === "Dockerfile") file.contents += `\nLABEL io.relmio.managed="true" io.relmio.target="${LOCAL_N8N_CLAUDE_TARGET}" io.relmio.install="${installId}"\n`;
      marker.files[file.path] = sha(file.contents);
    }
    let wrote = false;
    const priorVolume = await deps.runProcess({ file: "docker", args: ["volume", "inspect", "--format", "{{json .}}", VOLUME], cwd: dirname(resolve(root, "..", "..")), dockerHost: marker.dockerHost });
    const reuseLogin = priorVolume.code === 0 && json(priorVolume.stdout).Name === VOLUME &&
      json(priorVolume.stdout).Labels?.["com.docker.compose.project"] === ALIAS &&
      json(priorVolume.stdout).Labels?.["com.docker.compose.volume"] === "claude-account";
    try {
      await initialize(deps, root);
      wrote = true;
      for (const path of ["app", "app/src", "app/src/gateway", "app/src/claude"]) await deps.fileSystem.mkdir(join(root, path), { mode: 0o755 });
      for (const file of bundle.files) await privateFile(deps.fileSystem, join(root, file.path), file.contents,
        { exclusive: true, mode: [".env", "launch.json"].includes(file.path) ? 0o600 : 0o644 });
      await privateFile(deps.fileSystem, join(root, MARKER), `${JSON.stringify(marker)}\n`, { exclusive: true });
      await run(deps, root, marker.dockerHost, compose(["config", "--quiet"]));
      await boundary(deps, root, normalized, marker);
      await resources(deps, root, marker.dockerHost, marker);
      await run(deps, root, marker.dockerHost, compose(["build", ALIAS]), { timeoutMs: 600_000 });
      marker.imageId = await ownedImage(deps, root, marker);
      await privateFile(deps.fileSystem, join(root, MARKER), `${JSON.stringify(marker)}\n`);
      await launchHash(deps, root, marker, join(root, "launch.json"), { prepare: true });
      await attestFiles(deps, root, marker);
      await run(deps, root, marker.dockerHost, compose(["up", "-d", "--no-deps", ALIAS]));
      await attestContainer(deps, root, marker);
      const checked = await run(deps, root, marker.dockerHost, ["exec", "-i", ALIAS, "node", "-e", LOCAL_CLAUDE_HEALTH_PROBE],
        { input: bundle.key, timeoutMs: 190_000, maxOutputBytes: 4096 });
      if (checked.stdout.trim() !== "ok") throw new Error("The local Claude private-network health check failed.");
      return { target: LOCAL_N8N_CLAUDE_TARGET, endpoint: LOCAL_N8N_CLAUDE_ENDPOINT, baseUrl: LOCAL_N8N_CLAUDE_ENDPOINT,
        protocol: "openai-chat-completions", n8nContainerName: normalized.n8nContainerName, networkName: normalized.networkName,
        hostPublication: "none", clientKey: bundle.key, credentialShownOnce: true, deploymentMode: "installed",
        models: [...marker.models], expiresAt: marker.expiresAt };
    } catch (error) {
      if (!wrote) throw error;
      try { await rollbackInstall(deps, root, marker, { keepVolume: reuseLogin }); }
      catch { throw new Error(`Claude installation failed and automatic cleanup could not be confirmed. ${error.message}`); }
      throw error;
    }
  });
}

export async function attestLocalN8nClaudeInstallation({ installDirectory }, dependencies = {}) {
  const deps = options(dependencies); const root = rootPath(installDirectory);
  const marker = await readMarker(deps, root);
  if (!marker) throw new Error("The wizard-managed local Claude companion is not installed.");
  if (await dockerHost(deps, root) !== marker.dockerHost) throw new Error("The selected local Docker context changed.");
  await ownedImage(deps, root, marker);
  await attestFiles(deps, root, marker);
  const container = await attestContainer(deps, root, marker);
  return { installDirectory: root, projectName: ALIAS, dockerHost: marker.dockerHost, serviceName: ALIAS, containerId: container.Id };
}

export async function getLocalN8nClaudeStatus(dependencies = {}) {
  const deps = options(dependencies);
  const absent = { target: LOCAL_N8N_CLAUDE_TARGET, managed: false, state: "absent" };
  try {
    const root = await resolveLocalN8nClaudeInstallRoot(deps);
    const marker = await readMarker(deps, root);
    if (!marker) return absent;
    const host = await dockerHost(deps, root);
    await resources(deps, root, host, marker);
    if (host !== marker.dockerHost) throw new Error("Docker context changed.");
    await attestFiles(deps, root, marker, { skipLaunch: true });
    const snapshot = createSafeLocalN8nClaudeSnapshot({ target: LOCAL_N8N_CLAUDE_TARGET, endpoint: LOCAL_N8N_CLAUDE_ENDPOINT,
      auth: { configured: true, disclosure: "one-time" }, canRemove: true, models: marker.models,
      expiresAt: marker.expiresAt, approvalExpired: Date.parse(marker.expiresAt) <= deps.now().getTime() });
    let healthy = false;
    try { await ownedImage(deps, root, marker); await attestContainer(deps, root, marker); healthy = !snapshot.approvalExpired; } catch {}
    return { target: LOCAL_N8N_CLAUDE_TARGET, managed: true, state: healthy ? "healthy" : "partial", snapshot };
  } catch { return { target: LOCAL_N8N_CLAUDE_TARGET, managed: false, state: "unavailable" }; }
}

export async function getLocalN8nClaudeAuthStatus(_request = {}, dependencies = {}) {
  const deps = options(dependencies);
  const root = await resolveLocalN8nClaudeInstallRoot(deps);
  const installed = await attestLocalN8nClaudeInstallation({ installDirectory: root }, deps);
  const result = await deps.runProcess({ file: "docker",
    args: ["exec", "-w", "/data/account/empty", installed.containerId, ...AUTH_ARGS, "status", "--json"],
    cwd: root, dockerHost: installed.dockerHost, maxOutputBytes: 64 * 1024, timeoutMs: 60_000 });
  if (![0, 1].includes(result?.code)) throw new Error("The Claude sign-in status check failed.");
  return parseClaudeAuthStatus(result.stdout);
}

async function removeFiles(deps, root, marker) {
  const identity = await deps.fileSystem.lstat(root, { bigint: true });
  const detached = join(dirname(root), `.claude-cleanup-${randomUUID()}`);
  if (await stat(deps.fileSystem, detached)) throw new Error("Claude cleanup storage is unavailable.");
  await deps.fileSystem.rename(root, detached);
  try {
    const current = await deps.fileSystem.lstat(detached, { bigint: true });
    if (identity.dev !== current.dev || identity.ino !== current.ino) throw new Error("The managed Claude directory changed.");
    await attestFiles(deps, detached, marker, { skipLaunch: true });
    const expected = new Set([...FILES, MARKER]);
    const walk = async (path = "") => {
      for (const entry of await deps.fileSystem.readdir(join(detached, path), { withFileTypes: true })) {
        const name = path ? `${path}/${entry.name}` : entry.name;
        if (entry.isDirectory() && !entry.isSymbolicLink() && [...expected].some(file => file.startsWith(`${name}/`))) await walk(name);
        else if (!entry.isFile() || entry.isSymbolicLink() || !expected.delete(name)) throw new Error("The managed Claude directory changed. It was kept.");
      }
    };
    await walk();
    if (expected.size || await deps.fileSystem.readFile(join(detached, MARKER), "utf8") !== `${JSON.stringify(marker)}\n`) throw new Error("The managed Claude directory changed. It was kept.");
    await deps.fileSystem.rm(detached, { recursive: true, force: false });
  } catch (error) {
    if (!(await stat(deps.fileSystem, root))) await deps.fileSystem.rename(detached, root);
    throw error;
  }
}
async function removeFreshRoot(deps, root) {
  const allowed = new Set(FILES);
  const walk = async (path = "") => {
    for (const entry of await deps.fileSystem.readdir(join(root, path), { withFileTypes: true })) {
      const name = path ? `${path}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error("The managed Claude directory changed. It was kept.");
      if (entry.isDirectory()) {
        if (![...allowed].some(file => file.startsWith(`${name}/`))) throw new Error("The managed Claude directory changed. It was kept.");
        await walk(name);
      } else if (!entry.isFile() || !allowed.has(name)) throw new Error("The managed Claude directory changed. It was kept.");
    }
  };
  await walk();
  await deps.fileSystem.rm(root, { recursive: true, force: false });
}
async function rollbackInstall(deps, root, marker, { keepVolume = false }) {
  if (await stat(deps.fileSystem, join(root, "compose.yml"))) {
    await run(deps, root, marker.dockerHost, compose(keepVolume ? ["down"] : ["down", "--volumes"]));
    if (await resources(deps, root, marker.dockerHost, marker)) throw new Error("The Claude container remains.");
    if (!keepVolume) {
      const volume = await deps.runProcess({ file: "docker", args: ["volume", "inspect", VOLUME], cwd: root, dockerHost: marker.dockerHost });
      if (volume.code === 0) throw new Error("The Claude login volume remains.");
    }
  }
  // ownedImage only accepts this attempt's install label, so a build that tagged the image and then failed is still removed.
  const imageId = await ownedImage(deps, root, marker, { absentAllowed: true });
  if (imageId) {
    await run(deps, root, marker.dockerHost, ["image", "rm", IMAGE]);
    if (await ownedImage(deps, root, marker, { absentAllowed: true })) throw new Error("The Claude image remains.");
  }
  if (!(await stat(deps.fileSystem, root))) return;
  if (await stat(deps.fileSystem, join(root, MARKER))) await removeFiles(deps, root, marker);
  else await removeFreshRoot(deps, root);
}


export async function changeLocalN8nClaude({ action, confirmed, review }, dependencies = {}) {
  if (!["renew", "sign-out", "remove"].includes(action)) throw new Error("The local Claude action is invalid.");
  if (confirmed !== true) throw new Error("Confirm the local Claude action.");
  if (action === "renew") validateClaudeReview(review);
  return withChange(dependencies, async (deps, root) => {
    const marker = await readMarker(deps, root);
    if (!marker) throw new Error("The wizard-managed local Claude companion is not installed.");
    if (await dockerHost(deps, root) !== marker.dockerHost) throw new Error("The selected Docker context changed.");
    await attestFiles(deps, root, marker);
    const container = await attestContainer(deps, root, marker, { running: action !== "remove" });
    if (action === "sign-out") {
      await run(deps, root, marker.dockerHost, ["exec", "-w", "/data/account/empty", container.Id, ...AUTH_ARGS, "logout"], { timeoutMs: 60_000, maxOutputBytes: 4096 });
      return { target: LOCAL_N8N_CLAUDE_TARGET, changed: true };
    }
    if (action === "renew") {
      // The host may not read launch.json once it is 10001-owned; readMarker proved this text hashes to the marker.
      const previous = { contents: `${JSON.stringify(marker.launchConfig, null, 2)}\n`, hash: marker.files["launch.json"] };
      marker.launchConfig = renewClaudeLaunchConfig(marker.launchConfig, () => deps.now().getTime());
      marker.expiresAt = marker.launchConfig.qualification.expiresAt;
      const contents = `${JSON.stringify(marker.launchConfig, null, 2)}\n`;
      marker.files["launch.json"] = sha(contents);
      try {
        await privateFile(deps.fileSystem, join(root, "launch.json"), contents);
        await launchHash(deps, root, marker, join(root, "launch.json"), { prepare: true });
      } catch (error) {
        // The marker still holds the old hash, so put the old approval file back, owned for the container again.
        marker.files["launch.json"] = previous.hash;
        try {
          await privateFile(deps.fileSystem, join(root, "launch.json"), previous.contents);
          await launchHash(deps, root, marker, join(root, "launch.json"), { prepare: true });
        } catch { /* The renewal error below is the one to report. */ }
        throw error;
      }
      await privateFile(deps.fileSystem, join(root, MARKER), `${JSON.stringify(marker)}\n`);
      await run(deps, root, marker.dockerHost, ["restart", container.Id]);
      await attestContainer(deps, root, marker);
      return { target: LOCAL_N8N_CLAUDE_TARGET, changed: true, expiresAt: marker.expiresAt };
    }
    await run(deps, root, marker.dockerHost, compose(["down", "--volumes"]));
    if (await resources(deps, root, marker.dockerHost, marker)) throw new Error("The Claude container remains. Managed files were kept.");
    const volume = await deps.runProcess({ file: "docker", args: ["volume", "inspect", VOLUME], cwd: root, dockerHost: marker.dockerHost });
    if (volume.code === 0) throw new Error("The Claude login volume remains. Managed files were kept.");
    const imageId = await ownedImage(deps, root, marker, { absentAllowed: true });
    if (imageId) await run(deps, root, marker.dockerHost, ["image", "rm", IMAGE]);
    await removeFiles(deps, root, marker);
    return { target: LOCAL_N8N_CLAUDE_TARGET, removed: true };
  });
}

export async function discoverLocalN8nClaudeModels({ clientKey }, dependencies = {}) {
  if (typeof clientKey !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(clientKey)) throw new Error("Enter the one-time Relmio Claude key.");
  const deps = options(dependencies);
  const root = await resolveLocalN8nClaudeInstallRoot(deps);
  const installed = await attestLocalN8nClaudeInstallation({ installDirectory: root }, deps);
  const probe = LOCAL_CLAUDE_MODELS_PROBE;
  const result = await run(deps, root, installed.dockerHost, ["exec", "-i", installed.containerId, "node", "-e", probe],
    { input: clientKey, timeoutMs: 15_000, maxOutputBytes: 4096 });
  const models = json(result.stdout);
  if (!validModels(models)) throw new Error("The Claude model list is invalid.");
  return { models: [...models] };
}

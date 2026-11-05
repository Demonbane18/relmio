// Owner-only Claude companion on the managed VPS: the bundle from `relmio claude companion prepare`,
// deployed by the wizard to /docker/n8n-openai-oauth/claude after review and final confirmation.
// The owner signs in from their own terminal with login.sh; Relmio never reads or moves the Claude login,
// which stays in the companion's Docker volume. Only three auth status fields ever leave the VPS.
import { createHash, randomBytes } from "node:crypto";
import { validateDockerName, validateHostname, validatePort, validateUsername } from "../domain/validation.js";
import { validateDockerObjectId } from "../domain/local-n8n-sidecar.js";
import { validateInstallId } from "../domain/local-endpoints.js";
import { INSTALL_ROOT, PRECHECK_COMMAND, SHARED_ROOT_MARKER_PATH, SHARED_ROOT_MARKER_CONTENT } from "../domain/safety.js";
import { VPS_OPERATION_LOCKS } from "../domain/vps-build-state.js";
import {
  CLAUDE_COMPANION, buildClaudeCompanionBundle, claudeArchFromMachine, claudeCompanionPin,
  parseClaudeAuthStatus, renewClaudeLaunchConfig, reviewClaudeCompanion,
} from "../claude/companion.js";
import { CANDIDATE_VERSION, MODEL_RULES, validModels } from "../claude/launcher.js";
import { withVpsOperationLock } from "./vps-operation-lock.js";

export const VPS_CLAUDE_ROOT = `${INSTALL_ROOT}/claude`;
const ROOT = VPS_CLAUDE_ROOT;
const MARKER_NAME = ".managed-by-relmio.json";
const MARKER = `${ROOT}/${MARKER_NAME}`;
const LOCK = VPS_OPERATION_LOCKS.claude;
// One companion per Docker host: the template fixes the compose project, container name and network alias.
const NAME = CLAUDE_COMPANION.project;
const VOLUME = `${NAME}_claude-account`;
const IMAGE = `${NAME}:${CANDIDATE_VERSION}`;
const COMPOSE = `docker compose --project-name ${NAME} --file ${ROOT}/compose.yml`;
const ACTIONS = Object.freeze(["install", "replace", "renew", "sign-out", "remove"]);
const ALLOWED_STATES = Object.freeze({
  install: ["absent"], replace: ["manual", "installed"], renew: ["installed"], "sign-out": ["installed"], remove: ["installed"],
});
const REVIEW_FIELDS = Object.freeze(["officialBinaryReviewed", "effectivePolicyReviewed", "nativeAuthAndBillingReviewed", "policyChangesControlled"]);
const MAX_FILE_BYTES = 16 * 1024;
const DIRECTORIES = Object.freeze(["app", "app/src", "app/src/gateway", "app/src/claude"]);
// Every bundle file except launch.json is hashed in the marker; renewals rewrite only launch.json.
const FIXED_FILES = Object.freeze({
  Dockerfile: "644", "compose.yml": "644", "login.sh": "644", "renew.sh": "644",
  "app/src/gateway/claude-chat.js": "644", "app/src/claude/launcher.js": "644", "app/package.json": "644", ".env": "600",
});
const ENTRY_SPEC = new Map([
  [MARKER_NAME, { type: "f", owner: "0:0", mode: "600" }],
  ...Object.entries(FIXED_FILES).map(([path, mode]) => [path, { type: "f", owner: "0:0", mode }]),
  ["launch.json", { type: "f", owner: "10001:10001", mode: "600" }],
  ...DIRECTORIES.map((path) => [path, { type: "d", owner: "0:0", mode: "755" }]),
]);
// A bundle from `relmio claude companion prepare` may also hold its one-time key file; replacing it deletes that copy.
const MANUAL_TYPES = new Map([
  ...[...ENTRY_SPEC].filter(([path]) => path !== MARKER_NAME).map(([path, { type }]) => [path, type]),
  ["n8n-api-key.txt", "f"],
]);
const KNOWN_FILES = [...MANUAL_TYPES].filter(([, type]) => type === "f").map(([path]) => path);
const hash = (value) => createHash("sha256").update(value).digest("hex");
const fail = () => new Error("The VPS Claude ownership or safety check failed. Nothing outside its managed companion may be changed.");
const quote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`;
const parse = (text) => { try { return JSON.parse(text); } catch { throw fail(); } };
const parentGuard = `[ -d /docker ] && [ ! -L /docker ] && [ ! -L ${INSTALL_ROOT} ]`;
const rootGuard = `${parentGuard} && [ ! -L ${ROOT} ] && [ -d ${ROOT} ]`;
const LISTING = `if [ ! -e ${ROOT} ] && [ ! -L ${ROOT} ]; then printf 'absent\\n'; elif ${rootGuard}; then stat -c 'root %u:%g %a' ${ROOT} && find ${ROOT} -mindepth 1 -printf '%P %y %U:%G %m %n %s\\n'; else printf 'unsafe\\n'; fi`;
// Deletes only the fixed bundle names, deepest folders last; an unexpected entry makes rmdir fail.
const CLEAR_BUNDLE = `rm -f -- ${[MARKER_NAME, ...KNOWN_FILES].join(" ")} && for d in ${[...DIRECTORIES].reverse().join(" ")}; do if [ -d "$d" ]; then rmdir -- "$d" || exit 1; fi; done`;
const REMOVE_ROOT = `${rootGuard} && cd ${ROOT} && ${CLEAR_BUNDLE} && cd / && rmdir ${ROOT}`;
// GNU coreutils on the Linux VPS: exclusive create, 10001-owned 0600, sync, then one atomic rename.
export function createVpsClaudeLaunchWriteCommand({ guardRoot = "/docker", installRoot = INSTALL_ROOT } = {}) {
  const safePath = /^\/[A-Za-z0-9_-][A-Za-z0-9_.-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9_.-]*)*$/u;
  if (typeof guardRoot !== "string" || typeof installRoot !== "string" || !safePath.test(guardRoot) ||
    !safePath.test(installRoot) || !installRoot.startsWith(`${guardRoot}/`)) throw new TypeError("The Claude write roots are invalid.");
  const root = `${installRoot}/claude`;
  const guard = `[ -d ${guardRoot} ] && [ ! -L ${guardRoot} ] && [ ! -L ${installRoot} ] && [ ! -L ${root} ] && [ -d ${root} ]`;
  return `${guard} && cd ${root} && [ ! -e launch.json.next ] && [ ! -L launch.json.next ] && umask 077 && if (set -C; cat > launch.json.next) && chown -h 10001:10001 launch.json.next && [ -f launch.json.next ] && [ ! -L launch.json.next ] && [ "$(stat -c %u:%g:%a:%h launch.json.next)" = 10001:10001:600:1 ] && sync launch.json.next && mv -fT launch.json.next launch.json; then exit 0; else rm -f launch.json.next; exit 1; fi`;
}
// The key arrives on stdin, never in argv, and only the configured model IDs come back.
export const VPS_CLAUDE_MODELS_PROBE = `let k="";process.stdin.setEncoding("utf8");process.stdin.on("data",c=>k+=c);process.stdin.on("end",()=>{const r=require("node:http").get({host:"127.0.0.1",port:${CLAUDE_COMPANION.port},path:"/v1/models",headers:{Host:"${CLAUDE_COMPANION.alias}:${CLAUDE_COMPANION.port}",Authorization:"Bearer "+k},timeout:20000},s=>{let b="";s.setEncoding("utf8");s.on("data",c=>b+=c);s.on("end",()=>{let m=[];try{if(s.statusCode===200)m=JSON.parse(b).data.map(x=>x.id)}catch{}console.log(JSON.stringify({status:s.statusCode,models:m}))})});r.on("timeout",()=>r.destroy());r.on("error",()=>console.log(JSON.stringify({status:502,models:[]})))});`;

async function run(remote, command, input) {
  const result = await remote.exec(command, input === undefined ? undefined : { input });
  if (result.code !== 0) throw fail();
  return result.stdout.trim();
}

// login.sh's environment without a terminal; status checks also skip nonessential traffic, like renew.sh.
function claudeCommand(container, args) {
  const quiet = args === "auth status --json" ? " CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1" : "";
  return `docker exec -w /data/account/empty ${validateDockerObjectId(container?.Id, "Claude companion")} env -i HOME=/home/claude USER=claude LOGNAME=claude CLAUDE_CONFIG_DIR=/data/account/config PATH=/usr/bin:/bin:/usr/sbin:/sbin TMPDIR=/tmp${quiet} /opt/claude/${CANDIDATE_VERSION}/claude ${args}`;
}

function requireReview(review) {
  if (!review || typeof review !== "object" || Array.isArray(review) || Object.keys(review).length !== REVIEW_FIELDS.length ||
    REVIEW_FIELDS.some((field) => review[field] !== true)) {
    throw Object.assign(new Error("Answer yes to all four Claude review questions first. Nothing was changed."), { statusCode: 400 });
  }
}

function validateMarker(marker) {
  const keys = ["schemaVersion", "kind", "installId", "network", "arch", "models", "tokenSha256", "files"];
  const files = Object.keys(FIXED_FILES);
  if (!marker || typeof marker !== "object" || Array.isArray(marker) || Object.keys(marker).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(marker, key)) || marker.schemaVersion !== 1 || marker.kind !== "relmio-claude-companion" ||
    typeof marker.tokenSha256 !== "string" || !/^[a-f0-9]{64}$/u.test(marker.tokenSha256) ||
    !marker.files || typeof marker.files !== "object" || Object.keys(marker.files).length !== files.length ||
    files.some((path) => !Object.hasOwn(marker.files, path) || !/^[a-f0-9]{64}$/u.test(marker.files[path]))) throw fail();
  validateInstallId(marker.installId);
  reviewClaudeCompanion({ network: marker.network, arch: marker.arch, models: marker.models });
  return marker;
}

function parseListing(text) {
  const [head, ...lines] = text.split("\n");
  if (head === "absent" && lines.length === 0) return "absent";
  const root = /^root (\d+):(\d+) ([0-7]{3,4})$/u.exec(head);
  if (!root) return null;
  const entries = new Map();
  for (const line of lines) {
    const match = /^([A-Za-z0-9_.][A-Za-z0-9_./-]*) ([a-z]) (\d+:\d+) ([0-7]{3,4}) (\d+) (\d+)$/u.exec(line);
    if (!match || entries.has(match[1])) return null;
    entries.set(match[1], { type: match[2], owner: match[3], mode: match[4], links: Number(match[5]), size: Number(match[6]) });
  }
  return { uid: root[1], gid: root[2], mode: root[3], entries };
}

async function inspectOptional(remote, type, name) {
  // Inspect only the exact fixed name, never a guessed production resource.
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

// Created by Compose from this folder, whether by the wizard or by hand with the CLI bundle.
function companionOf(container) {
  const labels = container?.Config?.Labels ?? {};
  return container?.Name === `/${NAME}` && labels["com.relmio.managed"] === "claude-companion" &&
    labels["com.docker.compose.project"] === NAME && labels["com.docker.compose.service"] === NAME &&
    labels["com.docker.compose.project.working_dir"] === ROOT;
}

function composeVolume(volume) {
  return volume?.Name === VOLUME && volume.Labels?.["com.docker.compose.project"] === NAME &&
    volume.Labels["com.docker.compose.volume"] === "claude-account";
}

// The template's hardening, this installation's key hash and network; `running` excludes a restart loop.
function attestCompanion(container, marker, { running = true } = {}) {
  const host = container?.HostConfig;
  const networks = container?.NetworkSettings?.Networks ?? {};
  const mounts = Array.isArray(container?.Mounts)
    ? container.Mounts.filter((mount) => !(mount.Type === "tmpfs" && ["/tmp", "/home/claude"].includes(mount.Destination)))
    : [];
  const account = mounts.find((mount) => mount.Type === "volume");
  const launch = mounts.find((mount) => mount.Type === "bind");
  if (!companionOf(container) || !container.Config.Env?.includes(`RELMIO_CLAUDE_CHAT_TOKEN_SHA256=${marker.tokenSha256}`) ||
    container.Config.Image !== IMAGE || container.Config.User !== "10001:10001" ||
    (running && (container.State?.Running !== true || container.State.Restarting === true)) ||
    Object.keys(networks).length !== 1 || !networks[marker.network]?.Aliases?.includes(CLAUDE_COMPANION.alias) ||
    Object.values(container.NetworkSettings?.Ports ?? {}).some((value) => value !== null) || Object.keys(host?.PortBindings ?? {}).length ||
    host?.ReadonlyRootfs !== true || !host.CapDrop?.includes("ALL") || !host.SecurityOpt?.includes("no-new-privileges:true") ||
    mounts.length !== 2 || account?.Name !== VOLUME || account.Destination !== "/data/account" || account.RW !== true ||
    launch?.Source !== `${ROOT}/launch.json` || launch.Destination !== "/run/relmio/launch.json" || launch.RW !== false) {
    throw fail();
  }
}

function containerState(container) {
  if (!container) return "missing";
  return container.State?.Running === true && container.State.Restarting !== true ? "running" : "stopped";
}

// Anything Relmio cannot recognize is "invalid" and refused; only Docker or SSH failures throw.
async function inspectClaude(remote, now) {
  const listing = parseListing(await run(remote, LISTING));
  const container = await inspectOptional(remote, "container", NAME);
  const volume = await inspectOptional(remote, "volume", VOLUME);
  const invalid = { state: "invalid", container, volume, marker: null, launchConfig: null, complete: false };
  if (listing === "absent") {
    if (container || (volume && !composeVolume(volume))) return invalid;
    return { ...invalid, state: "absent", existingLogin: volume !== null };
  }
  if (!listing || (container && !companionOf(container)) || (volume && !composeVolume(volume))) return invalid;
  const { entries } = listing;
  if (!entries.has(MARKER_NAME)) {
    // A root-owned folder is not enough: a non-root or group/other-writable entry could be swapped for a symlink before CLEAR_BUNDLE.
    // renew.sh leaves launch.json owned by 10001:10001, so that one entry may keep it.
    const manual = container !== null && listing.uid === "0" && (Number.parseInt(listing.mode, 8) & 0o022) === 0 &&
      [...entries].every(([path, entry]) => MANUAL_TYPES.get(path) === entry.type && (Number.parseInt(entry.mode, 8) & 0o022) === 0 &&
        (entry.owner === "0:0" || (path === "launch.json" && entry.owner === "10001:10001")));
    return { ...invalid, state: manual ? "manual" : "invalid" };
  }
  if (`${listing.uid}:${listing.gid}` !== "0:0" || listing.mode !== "700" || [...entries].some(([path, entry]) => {
    const spec = ENTRY_SPEC.get(path);
    return !spec || spec.type !== entry.type || spec.owner !== entry.owner || spec.mode !== entry.mode ||
      (entry.type === "f" && (entry.links !== 1 || ([MARKER_NAME, "launch.json"].includes(path) && entry.size > MAX_FILE_BYTES)));
  })) return invalid;
  let marker;
  const markerText = await run(remote, `cat -- ${MARKER}`);
  try { marker = validateMarker(JSON.parse(markerText)); } catch { return invalid; }
  const present = Object.keys(FIXED_FILES).filter((path) => entries.has(path));
  if (present.length) {
    const sums = new Map((await run(remote, `cd ${ROOT} && sha256sum -- ${present.join(" ")}`)).split("\n")
      .map((line) => /^([a-f0-9]{64}) {2}(\S+)$/u.exec(line)).filter(Boolean).map((match) => [match[2], match[1]]));
    if (present.some((path) => sums.get(path) !== marker.files[path])) return invalid;
  }
  let launchConfig = null;
  if (entries.has("launch.json")) {
    const text = await run(remote, `cat -- ${ROOT}/launch.json`);
    try {
      const config = JSON.parse(text);
      renewClaudeLaunchConfig(config, now);
      if (config.executableSha256 === claudeCompanionPin(marker.arch).executableSha256 &&
        JSON.stringify(config.models) === JSON.stringify(marker.models)) launchConfig = config;
    } catch { /* An unreadable approval can only be replaced. */ }
  }
  const complete = present.length === Object.keys(FIXED_FILES).length && entries.has("launch.json");
  return { ...invalid, state: "installed", marker, launchConfig, complete };
}

function publicPin(arch) {
  const { version, platform, executableSha256 } = claudeCompanionPin(arch);
  return { version, arch, platform, executableSha256 };
}

export function vpsClaudeLoginCommand({ host, port, username }) {
  const safePort = validatePort(port);
  return `ssh -t ${safePort === 22 ? "" : `-p ${safePort} `}${validateUsername(username)}@${validateHostname(host)} sh ${ROOT}/login.sh`;
}

export async function getVpsClaudeStatus({ remote, now = Date.now }) {
  const status = await inspectClaude(remote, now);
  const { marker, launchConfig } = status;
  const machine = marker ? null : await run(remote, "uname -m");
  let candidate = null;
  try { candidate = publicPin(marker?.arch ?? claudeArchFromMachine(machine)); } catch { /* Install refuses this architecture. */ }
  const expiresAt = launchConfig?.qualification.expiresAt ?? null;
  return {
    state: status.state,
    ...(status.existingLogin ? { existingLogin: true } : {}),
    installation: status.state === "installed" ? {
      network: marker.network, arch: marker.arch, models: [...marker.models], expiresAt,
      approvalExpired: expiresAt === null || Date.parse(expiresAt) <= now(),
      container: containerState(status.container), endpoint: CLAUDE_COMPANION.endpoint,
    } : null,
    candidate,
  };
}

async function requirePrecheck(remote) {
  const precheck = await remote.exec(PRECHECK_COMMAND);
  if (precheck.code !== 0 || !["new", "managed"].includes(precheck.stdout.trim())) {
    throw new Error("The VPS Relmio folder is not one Relmio recognizes, so the Claude companion cannot be placed there. Nothing was changed.");
  }
}

async function boundary(remote, containerName, networkName, companionId) {
  const container = validateDockerName(containerName);
  const network = validateDockerName(networkName);
  const [id, running, networks] = (await run(remote, `docker container inspect ${container} --format '{{json .Id}}|{{json .State.Running}}|{{json .NetworkSettings.Networks}}'`)).split("|");
  const n8n = { id: parse(id), running: parse(running), networks: parse(networks) };
  if (n8n.running !== true || !n8n.networks?.[network]) throw new Error("The selected n8n container or network changed. Review a fresh plan.");
  const net = parse(await run(remote, `docker network inspect ${network} --format '{{json .}}'`));
  validateDockerObjectId(n8n.id, "n8n container");
  validateDockerObjectId(net.Id, "network");
  if (n8n.networks[network].NetworkID !== net.Id || net.Name !== network) throw fail();
  if (net.Internal !== false) throw new Error("The selected n8n network has no outbound route. Choose a network with internet access. Nothing was changed.");
  for (const [connected, item] of Object.entries(net.Containers ?? {})) {
    validateDockerObjectId(connected, "connected container");
    if (connected === companionId) continue;
    const aliases = parse(await run(remote, `docker container inspect ${connected} --format '{{json .NetworkSettings.Networks}}'`))?.[network]?.Aliases ?? [];
    if ([item.Name, ...aliases].includes(CLAUDE_COMPANION.alias)) {
      throw new Error("Another container already answers to relmio-claude on this n8n network. Nothing was changed.");
    }
  }
  return { containerId: n8n.id, networkId: net.Id };
}

async function readAuthStatus(remote, container) {
  const result = await remote.exec(claudeCommand(container, "auth status --json"));
  // Claude reports a missing login with exit 1 and JSON; all other failures stay errors.
  if (![0, 1].includes(result.code)) {
    throw new Error("The Claude companion could not be checked. Check that it is running.");
  }
  return parseClaudeAuthStatus(result.stdout);
}

/** Read-only review. Every write waits for applyVpsClaude after the owner's final confirmation. */
export async function reviewVpsClaude({ remote, action, containerName = null, networkName = null, models, review, now = Date.now }) {
  if (!ACTIONS.includes(action)) throw new TypeError("Choose a supported Claude action.");
  const approves = ["install", "replace", "renew"].includes(action);
  const deploys = action === "install" || action === "replace";
  if (approves) requireReview(review);
  if (deploys) {
    validateDockerName(containerName);
    validateDockerName(networkName);
    if (!validModels(models)) throw new Error(MODEL_RULES);
  }
  const status = await inspectClaude(remote, now);
  if (!ALLOWED_STATES[action].includes(status.state)) throw new Error("Claude is not ready for that action. Refresh its status first.");
  const plan = {
    action, installDirectory: ROOT, endpoint: CLAUDE_COMPANION.endpoint, existingN8nChanges: [], restarts: 0,
    publishedPorts: [], operationLockPath: LOCK, installId: status.marker?.installId ?? null,
    containerName: null, networkName: null, containerId: null, networkId: null,
    ...(approves ? { review: Object.fromEntries(REVIEW_FIELDS.map((field) => [field, true])) } : {}),
  };
  if (deploys) {
    await requirePrecheck(remote);
    const selection = await boundary(remote, containerName, networkName,
      status.container ? validateDockerObjectId(status.container.Id, "Claude companion") : null);
    const arch = claudeArchFromMachine(await run(remote, "uname -m"));
    const bundle = await buildClaudeCompanionBundle({ network: networkName, arch, models, now });
    return {
      ...plan, containerName, networkName, ...selection, network: networkName, arch, models: bundle.review.models,
      version: bundle.review.version, executableSha256: bundle.review.executableSha256, expiresAt: bundle.expiresAt,
      keepsClaudeLogin: action === "replace" || status.existingLogin === true,
    };
  }
  const { marker } = status;
  const pin = claudeCompanionPin(marker.arch);
  let expiresAt = null;
  if (action !== "remove") {
    if (!status.complete) throw new Error("This Claude companion is incomplete. Replace it first.");
    attestCompanion(status.container, marker, { running: action === "sign-out" });
  }
  if (action === "renew") {
    if (!status.launchConfig) throw new Error("This Claude approval cannot be renewed. Replace the companion to write a fresh one.");
    expiresAt = renewClaudeLaunchConfig(status.launchConfig, now).qualification.expiresAt;
  }
  return {
    ...plan, network: marker.network, arch: marker.arch, models: [...marker.models], version: pin.version,
    executableSha256: pin.executableSha256, expiresAt, keepsClaudeLogin: action === "renew",
  };
}
async function rollbackDeploy(remote, { keepVolume }) {
  const container = await inspectOptional(remote, "container", NAME);
  if (container) {
    if (!companionOf(container)) throw fail();
    await run(remote, `docker rm -f ${validateDockerObjectId(container.Id, "Claude companion")}`);
  }
  if (!keepVolume) {
    const volume = await inspectOptional(remote, "volume", VOLUME);
    if (volume) {
      if (!composeVolume(volume)) throw fail();
      await run(remote, `docker volume rm ${VOLUME}`);
    }
  }
  const listing = parseListing(await run(remote, LISTING));
  if (listing === "absent") return;
  if (!listing) throw new Error("Claude cleanup could not read the companion folder.");
  await run(remote, REMOVE_ROOT);
  if (await inspectOptional(remote, "container", NAME)) throw new Error("The Claude container remains.");
  if (!keepVolume && await inspectOptional(remote, "volume", VOLUME)) throw new Error("The Claude login volume remains.");
  if (parseListing(await run(remote, LISTING)) !== "absent") throw new Error("The Claude companion files remain.");
}


async function deploy(remote, plan, build, status, { now, entropy }) {
  const selection = await boundary(remote, plan.containerName, plan.networkName,
    status.container ? validateDockerObjectId(status.container.Id, "Claude companion") : null);
  if (selection.containerId !== plan.containerId || selection.networkId !== plan.networkId ||
    claudeArchFromMachine(await run(remote, "uname -m")) !== plan.arch) throw fail();
  const bundle = await buildClaudeCompanionBundle({ network: plan.networkName, arch: plan.arch, models: plan.models, now });
  if (bundle.files.length !== Object.keys(FIXED_FILES).length + 1 ||
    bundle.files.some((file) => ENTRY_SPEC.get(file.path)?.mode !== file.mode.toString(8))) throw fail();
  const id = entropy(16);
  if (!Buffer.isBuffer(id) || id.length !== 16) throw fail();
  const marker = validateMarker({
    schemaVersion: 1, kind: "relmio-claude-companion", installId: id.toString("hex"), network: plan.networkName,
    arch: plan.arch, models: bundle.review.models, tokenSha256: bundle.keySha256,
    files: Object.fromEntries(bundle.files.filter((file) => file.path !== "launch.json").map((file) => [file.path, hash(file.contents)])),
  });
  // A later failure removes this attempt. Replace keeps the login volume.
  let wrote = false;
  try {
    await run(remote, plan.action === "install"
      ? `${parentGuard} && umask 077 && mkdir ${ROOT}`
      : `${rootGuard} && cd ${ROOT} && ${CLEAR_BUNDLE} && chmod 0700 ${ROOT}`);
    wrote = true;
    await remote.upload(MARKER, `${JSON.stringify(marker)}\n`, 0o600);
    await run(remote, `${rootGuard} && cd ${ROOT} && mkdir -m 0755 ${DIRECTORIES.join(" ")}`);
    for (const file of bundle.files) await remote.upload(`${ROOT}/${file.path}`, file.contents, file.mode);
    const readable = bundle.files.filter((file) => file.mode === 0o644).map((file) => file.path);
    await run(remote, `${rootGuard} && cd ${ROOT} && chown -R 0:0 -- . && chmod 0644 -- ${readable.join(" ")} && chmod 0600 -- ${MARKER_NAME} .env launch.json && chown -h 10001:10001 -- launch.json`);
    const written = await inspectClaude(remote, now);
    if (written.state !== "installed" || written.marker.installId !== marker.installId || !written.complete || !written.launchConfig) throw fail();
    await run(remote, `${COMPOSE} config --quiet`);
    await build(`${COMPOSE} build ${NAME}`);
    // The healthcheck runs every 60 seconds, so the first healthy report can take about a minute.
    const up = await remote.exec(`${COMPOSE} up -d --wait --wait-timeout 180 --no-build --force-recreate ${NAME}`);
    if (up.code !== 0) throw new Error("The Claude companion did not become healthy. Check its status, then replace or remove it.");
    const container = await inspectOptional(remote, "container", NAME);
    attestCompanion(container, marker);
    if (container.State?.Health?.Status !== "healthy") throw fail();
    return { state: "installed", clientKey: bundle.key, expiresAt: bundle.expiresAt };
  } catch (error) {
    if (!wrote) throw error;
    try { await rollbackDeploy(remote, { keepVolume: plan.keepsClaudeLogin === true }); }
    catch { throw new Error(`Claude installation failed and automatic cleanup could not be confirmed. ${error.message}`); }
    throw error;
  }
}

async function renew(remote, status, now) {
  // An expired approval keeps the launcher in a restart loop, so its login can only be checked while it runs.
  if (containerState(status.container) === "running") {
    const auth = await readAuthStatus(remote, status.container);
    if (auth.loggedIn !== true || auth.authMethod !== "claude.ai") {
      throw new Error("The companion is not signed in to a Claude plan. Run the sign-in command, then renew.");
    }
  }
  const renewed = renewClaudeLaunchConfig(status.launchConfig, now);
  await run(remote, createVpsClaudeLaunchWriteCommand(), `${JSON.stringify(renewed, null, 2)}\n`);
  await run(remote, `${COMPOSE} restart ${NAME}`);
  return { state: "installed", expiresAt: renewed.qualification.expiresAt };
}

async function signOut(remote, status) {
  const logout = await remote.exec(claudeCommand(status.container, "auth logout"));
  if (logout.code !== 0) throw new Error("Claude sign-out did not finish. Check its status and try again.");
  if ((await readAuthStatus(remote, status.container)).loggedIn) {
    throw new Error("Claude still reports a sign-in. Check its status and try again.");
  }
  return { state: "installed", loggedIn: false };
}

async function remove(remote, status) {
  if (status.container) await run(remote, `docker rm -f ${validateDockerObjectId(status.container.Id, "Claude companion")}`);
  if (status.volume) await run(remote, `docker volume rm ${VOLUME}`);
  await run(remote, REMOVE_ROOT);
  return { state: "absent" };
}

/** Applies a reviewed plan after the owner's final confirmation, under the VPS Claude operation lock. */
export async function applyVpsClaude({ remote, plan, confirmed }, { now = Date.now, entropy = randomBytes } = {}) {
  if (confirmed !== true || !ACTIONS.includes(plan?.action)) throw new Error("Confirm the reviewed Claude action first.");
  if (["install", "replace", "renew"].includes(plan.action)) requireReview(plan.review);
  const deploys = plan.action === "install" || plan.action === "replace";
  if (deploys) {
    if (!validModels(plan.models)) throw fail();
    await requirePrecheck(remote);
    await run(remote, `${parentGuard} && install -d -m 0755 ${INSTALL_ROOT} && if [ ! -e ${SHARED_ROOT_MARKER_PATH} ]; then (set -C; printf '%s\\n' ${quote(SHARED_ROOT_MARKER_CONTENT.trim())} > ${SHARED_ROOT_MARKER_PATH}); fi`);
  }
  return withVpsOperationLock(remote, LOCK, async (build) => {
    const status = await inspectClaude(remote, now);
    // keepsClaudeLogin was fixed at review; a login volume that appeared since must not be rolled back, so drift fails closed.
    if (!ALLOWED_STATES[plan.action].includes(status.state) || (status.marker?.installId ?? null) !== plan.installId ||
      (deploys && plan.keepsClaudeLogin !== (plan.action === "replace" || status.existingLogin === true))) throw fail();
    if (deploys) return deploy(remote, plan, build, status, { now, entropy });
    if (plan.action === "remove") return remove(remote, status);
    if (!status.complete || status.marker.network !== plan.network) throw fail();
    attestCompanion(status.container, status.marker, { running: plan.action === "sign-out" });
    if (plan.action === "sign-out") return signOut(remote, status);
    if (!status.launchConfig) throw fail();
    return renew(remote, status, now);
  });
}

export async function getVpsClaudeAuthStatus({ remote, now = Date.now }) {
  const status = await inspectClaude(remote, now);
  if (status.state !== "installed") throw new Error("Claude is not installed by this wizard. Refresh its status first.");
  attestCompanion(status.container, status.marker);
  return await readAuthStatus(remote, status.container);
}

export async function discoverVpsClaudeModels({ remote, clientKey, now = Date.now }) {
  if (typeof clientKey !== "string" || !/^[A-Za-z0-9_-]{43}$/u.test(clientKey)) {
    throw new TypeError("Enter the Claude companion key shown when this companion was installed.");
  }
  const status = await inspectClaude(remote, now);
  if (status.state !== "installed" || status.marker.tokenSha256 !== hash(clientKey)) {
    throw new Error("That key does not belong to this Claude companion.");
  }
  attestCompanion(status.container, status.marker);
  const result = parse(await run(remote, `docker exec -i ${validateDockerObjectId(status.container.Id, "Claude companion")} node -e ${quote(VPS_CLAUDE_MODELS_PROBE)}`, clientKey));
  if (result?.status === 401) throw new Error("The Claude companion did not accept this key.");
  if (result?.status !== 200 || !validModels(result.models)) throw new Error("The Claude companion did not answer. Check its status.");
  return { models: result.models };
}

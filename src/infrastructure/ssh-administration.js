import { createHash } from "node:crypto";
import { INSTALL_ROOT } from "../domain/safety.js";
import { validateUsername } from "../domain/validation.js";

export const MAX_UPLOAD_BYTES = 1_000_000;
export const DOCKER_ENDPOINT = "unix:///var/run/docker.sock";
export const LOGIN_PROBE = "/usr/bin/id -u";
const BUILDER_ENV_GUARD = 'if [ -n "${BUILDX_BUILDER:-}${BUILDX_CONFIG:-}${BUILDKIT_HOST:-}${DOCKER_CONFIG:-}${COMPOSE_BAKE:-}" ] || [ "${DOCKER_BUILDKIT:-1}" != 1 ]; then exit 78; fi';
const MODEL_ROOT = `${INSTALL_ROOT}/local-model`;
const MODEL_FILES = new Set(["Dockerfile.acquisition", ".dockerignore", "catalog.mjs", "acquisition.mjs", "compose.yaml", ".managed-by-relmio.json", ".managed-by-relmio.json.next"]);
export const quoteShell = value => `'${value.replaceAll("'", "'\\''")}'`;
const DEFAULT_BUILDER_KEY = createHash("sha256").update(DOCKER_ENDPOINT).digest("hex").slice(0, 20);
const canonicalDefaultSelections = ["", "default"].flatMap(Name => [false, true].map(Global =>
  JSON.stringify({ Key: DOCKER_ENDPOINT, Name, Global })));

// Buildx inspect itself creates state and can print nodegroup private keys.
// Read only its two bounded selector files, never config.json/nodegroups.
// Unknown/manual serialization is intentionally unsupported, not repaired.
export const BUILDER_STATE_PROBE = [
  '[ "$(docker context show)" = default ] || exit 79',
  `[ "$(docker context inspect default --format '{{.Endpoints.docker.Host}}')" = ${quoteShell(DOCKER_ENDPOINT)} ] || exit 79`,
  'case "${HOME:-}" in /*) ;; *) exit 79;; esac',
  'dir=$HOME; while :; do [ -d "$dir" ] && [ ! -L "$dir" ] && [ "$(stat -c %u "$dir")" = 0 ] || exit 79; mode=$(stat -c %a "$dir") || exit 79; [ "$((0$mode & 0022))" = 0 ] || exit 79; [ "$dir" = / ] && break; dir=$(dirname "$dir"); done',
  'for dir in "$HOME/.docker" "$HOME/.docker/buildx" "$HOME/.docker/buildx/defaults" "$HOME/.docker/buildx/instances"; do [ ! -L "$dir" ] || exit 79; if [ -e "$dir" ]; then [ -d "$dir" ] && [ "$(stat -c %u "$dir")" = 0 ] || exit 79; mode=$(stat -c %a "$dir") || exit 79; [ "$((0$mode & 0022))" = 0 ] || exit 79; fi; done',
  '[ ! -e "$HOME/.docker/buildx/instances/default" ] && [ ! -L "$HOME/.docker/buildx/instances/default" ] || exit 79',
  'safe_selector() { [ ! -L "$1" ] && [ -f "$1" ] && [ "$(stat -c %u:%h "$1")" = 0:1 ] && [ "$(stat -c %s "$1")" -le 4096 ] || return 1; mode=$(stat -c %a "$1") || return 1; [ "$((0$mode & 0022))" = 0 ]; }',
  'current="$HOME/.docker/buildx/current"; [ ! -L "$current" ] || exit 79',
  `if [ -e "$current" ]; then safe_selector "$current" || exit 79; selection=$(cat "$current") || exit 79; ${canonicalDefaultSelections.map(value => `[ "$selection" = ${quoteShell(value)} ]`).join(" || ")} || exit 79; fi`,
  `fallback="$HOME/.docker/buildx/defaults/${DEFAULT_BUILDER_KEY}"; [ ! -L "$fallback" ] || exit 79`,
  'if [ -e "$fallback" ]; then safe_selector "$fallback" && [ "$(stat -c %s "$fallback")" = 7 ] && [ "$(cat "$fallback")" = default ] || exit 79; fi',
].join("; ");
// Each refusal reaches the browser as its own sentence with a code. The server
// replaces any message over 240 characters or with a filtered path, so every
// text below plus the fixed suffix stays inside that limit.
const refuse = (code, message) => Object.assign(new Error(`${message} No remote files were written.`), { code });
const fail = () => refuse("vps_prereq_probe", "The VPS requires verified Linux root administration, a safe existing Docker parent directory, GNU upload tools, and a local rootful Docker Engine with Compose.");
const prerequisites = Object.freeze({
  70: ["vps_prereq_linux", "The managed VPS adapter requires Linux host administration, not service-container SSH."],
  71: ["vps_prereq_uid", "The selected SSH mode did not provide effective UID 0. Root login or noninteractive passwordless sudo is required."],
  72: ["vps_prereq_tools", "Required Linux file-operation capabilities are unavailable. An administrator must provide GNU dd/stat/find, sha256sum, awk, directory/removal tools, and readable process mount information."],
  73: ["vps_prereq_docker_dir", "An administrator must provide an existing root-owned, non-symlink Docker parent directory without group/world write permission. Relmio will not create or repair it."],
  74: ["vps_prereq_docker_cli", "A root-owned Docker CLI without group/world write permission is required in the administrative PATH."],
  75: ["vps_prereq_docker_context", "The selected Docker context must use Docker's standard local socket. Remote, custom-socket and rootless contexts are not supported; Relmio will not switch your context."],
  76: ["vps_prereq_docker_engine", "The local rootful Docker Engine is unavailable or unverified. An administrator must provide the root-owned standard Docker socket and running Engine."],
  77: ["vps_prereq_compose", "Docker Compose is unavailable in the selected administrative context. An administrator must install or repair the Compose plugin."],
  78: ["vps_prereq_builder_config", "Custom Docker or Buildx configuration, builder selectors and disabled BuildKit are unsupported. Remove those selectors first; Relmio will not switch a remote builder or use the classic builder."],
  79: ["vps_prereq_default_builder", "The existing default Docker context and built-in default builder are required. Custom, shadowed or ambiguous saved builder selections are unsupported; Relmio will not switch or initialize them."],
});
const prerequisite = code => refuse(...prerequisites[code]);

// Every probe is read-only. In particular, do not test dd by creating a file.
export const ADMIN_PROBE = [
  "set -eu",
  BUILDER_ENV_GUARD,
  '[ "$(uname -s)" = Linux ] || exit 70',
  '[ "$(id -u)" = 0 ] || exit 71',
  "for tool in stat dd sha256sum chmod cat dirname find awk rm rmdir mkdir; do command -v \"$tool\" >/dev/null || exit 72; done",
  "dd --version >/dev/null || exit 72",
  "/usr/bin/stat --version >/dev/null || exit 72",
  '[ -r /proc/self/mountinfo ] || exit 72',
  '[ -d /docker ] && [ ! -L /docker ] && [ "$(stat -c %u /docker)" = 0 ] || exit 73',
  'mode=$(stat -c %a /docker) || exit 73; [ "$((0$mode & 0022))" = 0 ] || exit 73',
  'binary=$(command -v docker) || exit 74; case "$binary" in /*) ;; *) exit 74;; esac',
  '[ "$(stat -Lc %u "$binary")" = 0 ] || exit 74',
  'mode=$(stat -Lc %a "$binary") || exit 74; [ "$((0$mode & 0022))" = 0 ] || exit 74',
  'if [ -n "${DOCKER_CONTEXT:-}" ]; then endpoint=$(docker context inspect "$DOCKER_CONTEXT" --format \'{{.Endpoints.docker.Host}}\') || exit 75; elif [ -n "${DOCKER_HOST:-}" ]; then endpoint=$DOCKER_HOST; else endpoint=$(docker context inspect --format \'{{.Endpoints.docker.Host}}\') || exit 75; fi',
  `[ "$endpoint" = ${quoteShell(DOCKER_ENDPOINT)} ] || exit 75`,
  BUILDER_STATE_PROBE,
  "unset DOCKER_CONTEXT DOCKER_TLS_VERIFY DOCKER_CERT_PATH",
  `DOCKER_HOST=${quoteShell(DOCKER_ENDPOINT)}; export DOCKER_HOST`,
  '[ -S /var/run/docker.sock ] && [ "$(stat -Lc %u /var/run/docker.sock)" = 0 ] || exit 76',
  "printf '0\\n%s\\n%s\\ndefault\\n' \"$endpoint\" \"$binary\"",
  "docker info --format '{{json .}}' || exit 76",
  "docker compose version --short || exit 77",
  "printf 'default\\n'",
].join("; ");

// cloud-init answers a root key sign-in with one fixed sentence when the image
// turns root off. Only that exact sentence, with a name the username validator
// returns unchanged, is recognised. No other remote text reaches a message.
const ROOT_REDIRECT = /^Please login as the user "([^"\n]*)" rather than the user "root"\.\n{0,2}$/u;
function redirectedLogin(stdout) {
  const name = typeof stdout === "string" ? ROOT_REDIRECT.exec(stdout)?.[1] : undefined;
  if (name === undefined) return null;
  try { return validateUsername(name) === name ? name : null; } catch { return null; }
}

export function parseLoginUid(result) {
  const redirected = redirectedLogin(result.stdout);
  if (redirected) {
    throw refuse("ssh_root_login_disabled", `This server refuses root sign-in and asks for the user "${redirected}" instead. Only the self-hosted model setup can use that account, with passwordless sudo. The other setups need root.`);
  }
  if (result.code !== 0 || !/^(0|[1-9][0-9]{0,9})\n?$/u.test(result.stdout)) throw fail();
  const uid = Number(result.stdout.trim());
  if (uid > 4294967294) throw fail();
  return uid;
}

// A leading major.minor.patch is all the check needs. Distribution packages
// append their own revision, for example 2.40.3+ds1-0ubuntu1~24.04.1.
const COMPOSE_VERSION = /^v?\d{1,4}\.\d{1,4}\.\d{1,4}(?:[A-Za-z.+~_:-][A-Za-z0-9.+~_:-]{0,63})?$/u;

export function parseAdministrativeProbe(result) {
  if (result.code !== 0) {
    if (Object.hasOwn(prerequisites, result.code)) throw prerequisite(result.code);
    throw refuse("vps_prereq_probe", "The selected administrative probe failed. Verify Linux root access or passwordless sudo -n permission without a TTY.");
  }
  const lines = result.stdout.trimEnd().split("\n");
  if (lines.length !== 7 || lines[0] !== "0" || lines[1] !== DOCKER_ENDPOINT ||
      !/^\/[A-Za-z0-9_./-]+\/docker$/u.test(lines[2]) || lines[2].split("/").includes("..") ||
      lines[3] !== "default" || !COMPOSE_VERSION.test(lines[5])) throw fail();
  let info;
  try { info = JSON.parse(lines[4]); } catch { throw fail(); }
  if (Array.isArray(info?.SecurityOptions) && info.SecurityOptions.some(option => typeof option === "string" && /rootless|podman/iu.test(option)) ||
      [info?.ServerVersion, info?.OperatingSystem].some(value => typeof value === "string" && /podman/iu.test(value))) {
    throw refuse("vps_prereq_rootless", "The managed VPS adapter requires a local rootful Docker Engine; rootless Docker and Podman are unsupported.");
  }
  if (!info || info.OSType !== "linux" || typeof info.ServerVersion !== "string" ||
      !/^\d+\.\d+\.\d+/u.test(info.ServerVersion) || !Array.isArray(info.SecurityOptions) ||
      info.SecurityOptions.some(option => typeof option !== "string")) throw fail();
  if (lines[6] !== "default") throw prerequisite(79);
  return Object.freeze({ endpoint: DOCKER_ENDPOINT, binary: lines[2], builder: "default" });
}

const HOST_TEXT = /^[\x20-\x7e]{1,64}$/u;
const HOST_VERSION = /^\d{1,4}(?:\.\d{1,4}){1,2}(?:[A-Za-z.+~_:-][A-Za-z0-9.+~_:-]{0,63})?$/u;
const hostText = (value, pattern = HOST_TEXT) => typeof value === "string" && pattern.test(value) ? value : null;
// A version the probe accepted always yields a value: the whole string when it
// is plain, otherwise its leading numbers.
function hostVersion(value) {
  if (typeof value !== "string") return null;
  const text = value.replace(/^v/u, "");
  return HOST_VERSION.test(text) ? text : /^\d{1,6}\.\d{1,6}\.\d{1,6}/u.exec(text)?.[0] ?? null;
}
const hostCount = value => Number.isSafeInteger(value) && value > 0 ? value : null;

// Read-only facts from the same probe output that parseAdministrativeProbe
// attests. They describe the host for warnings and review-time checks; they
// never widen what the probe accepts. Unknown values are null, including an
// absent client plugin list; no additional remote probe is needed.
export function describeAdministrativeHost(result) {
  const lines = typeof result?.stdout === "string" ? result.stdout.trimEnd().split("\n") : [];
  let info = null;
  try { info = JSON.parse(lines[4]); } catch { /* facts stay unknown */ }
  if (!info || typeof info !== "object") info = {};
  const plugins = info.ClientInfo?.Plugins;
  const buildx = Array.isArray(plugins)
    ? plugins.find(plugin => plugin?.Name === "buildx" && (plugin.Err === undefined || plugin.Err === null)) : undefined;
  const security = Array.isArray(info.SecurityOptions)
    ? [...new Set(info.SecurityOptions.map(option =>
      typeof option === "string" ? /^name=([a-z0-9-]{1,32})(?:,|$)/u.exec(option)?.[1] : undefined)
      .filter(Boolean))].slice(0, 16)
    : null;
  return Object.freeze({
    os: hostText(info.OperatingSystem),
    kernel: hostText(info.KernelVersion),
    arch: hostText(info.Architecture, /^[A-Za-z0-9_]{1,32}$/u),
    dockerVersion: hostVersion(info.ServerVersion),
    composeVersion: hostVersion(lines[5]),
    buildxVersion: hostVersion(buildx?.Version),
    memoryBytes: hostCount(info.MemTotal),
    cpus: hostCount(info.NCPU),
    security: security && Object.freeze(security),
  });
}

export function administrativeCommand(command, privilege, engine) {
  if (!["root", "sudo-n"].includes(privilege)) throw new TypeError("SSH privilege mode is invalid.");
  const environment = `PATH=/usr/sbin:/usr/bin:/sbin:/bin:/usr/local/bin; export PATH; ${BUILDER_ENV_GUARD}; ` + (engine
    ? `${BUILDER_STATE_PROBE}; unset DOCKER_CONTEXT DOCKER_TLS_VERIFY DOCKER_CERT_PATH; DOCKER_HOST=${quoteShell(engine.endpoint)}; BUILDX_BUILDER=default; export DOCKER_HOST BUILDX_BUILDER; docker() { ${quoteShell(engine.binary)} --host ${quoteShell(engine.endpoint)} "$@"; }; `
    : "");
  const shell = `/bin/sh -c ${quoteShell(environment + command)}`;
  return privilege === "sudo-n" ? `/usr/bin/sudo -n -- ${shell}` : shell;
}

export function validateModelUpload(remotePath, contents, mode) {
  if (typeof remotePath !== "string" || !remotePath.startsWith(`${MODEL_ROOT}/`) ||
      !MODEL_FILES.has(remotePath.slice(MODEL_ROOT.length + 1)) || mode !== 0o600) {
    throw new TypeError("Sudo uploads are restricted to public local-model assets and markers with mode 0600.");
  }
  if (typeof contents !== "string" && !Buffer.isBuffer(contents)) throw new TypeError("Remote upload contents are invalid.");
  const size = Buffer.isBuffer(contents) ? contents.length : Buffer.byteLength(contents);
  if (size > MAX_UPLOAD_BYTES || (remotePath.includes(".managed-by-relmio.json") && size > 16384)) {
    throw new TypeError("Remote upload exceeded the safety limit.");
  }
  return Buffer.isBuffer(contents) ? contents : Buffer.from(contents);
}

export function modelUploadCommand(remotePath, data) {
  // Only the caller's validated public model bytes reach this private channel.
  // Root-owned non-writable parents exclude ordinary login-user races. These
  // shell checks do not defend against a concurrently hostile root process.
  validateModelUpload(remotePath, data, 0o600);
  const target = quoteShell(remotePath);
  const parents = ["/", "/docker", INSTALL_ROOT, MODEL_ROOT].map(quoteShell).join(" ");
  const digest = createHash("sha256").update(data).digest("hex");
  return [
    "set -eu; umask 077",
    `for parent in ${parents}; do [ -d "$parent" ] && [ ! -L "$parent" ] && [ "$(stat -c %u "$parent")" = 0 ] || exit 1; mode=$(stat -c %a "$parent"); [ "$((0$mode & 0022))" = 0 ]; done`,
    `[ ! -L ${target} ]`,
    `if [ -e ${target} ]; then [ -f ${target} ] && [ "$(stat -c %u:%a:%h ${target})" = 0:600:1 ] || exit 1; else (set -C; : > ${target}); fi`,
    `dd of=${target} oflag=nofollow status=none`,
    `[ ! -L ${target} ] && [ -f ${target} ] && [ "$(stat -c %u:%a:%h:%s ${target})" = 0:600:1:${data.length} ] || exit 1`,
    `[ "$(sha256sum ${target})" = '${digest}  ${remotePath}' ]`,
  ].join("; ");
}

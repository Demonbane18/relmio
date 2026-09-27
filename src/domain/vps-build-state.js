import { INSTALL_ROOT, SHARED_ROOT_MARKER_PATH, SHARED_ROOT_MARKER_CONTENT } from "./safety.js";

export const VPS_OPERATION_LOCKS = Object.freeze({
  model: `${INSTALL_ROOT}/.local-model-operation.lock`,
  supergrok: `${INSTALL_ROOT}/.supergrok-operation.lock`,
  oauth: `${INSTALL_ROOT}/.openai-oauth-operation.lock`,
});
const quote = value => `'${value.replaceAll("'", "'\\''")}'`;
const identityPattern = /^\d+:\d+$/u;
function validate(lock, identity) {
  if (!Object.values(VPS_OPERATION_LOCKS).includes(lock) ||
      (identity !== undefined && !identityPattern.test(identity))) {
    throw new TypeError("Invalid VPS operation lock identity.");
  }
}

// These are Linux host guards, not a defence against a concurrently hostile root.
// No user-controlled paths or file contents enter the generated cleanup program.
const rootGuard = `[ -d /docker ] && [ ! -L /docker ] && [ "$(stat -c %u /docker)" = 0 ] && [ $((0$(stat -c %a /docker) & 022)) -eq 0 ] && [ -d ${INSTALL_ROOT} ] && [ ! -L ${INSTALL_ROOT} ] && [ "$(stat -c %u ${INSTALL_ROOT})" = 0 ] && [ $((0$(stat -c %a ${INSTALL_ROOT}) & 022)) -eq 0 ] && [ ! -L ${SHARED_ROOT_MARKER_PATH} ] && [ -f ${SHARED_ROOT_MARKER_PATH} ] && [ "$(stat -c %u:%h ${SHARED_ROOT_MARKER_PATH})" = 0:1 ] && [ $((0$(stat -c %a ${SHARED_ROOT_MARKER_PATH}) & 022)) -eq 0 ] && [ "$(stat -c %s ${SHARED_ROOT_MARKER_PATH})" = ${Buffer.byteLength(SHARED_ROOT_MARKER_CONTENT)} ] && [ "$(cat ${SHARED_ROOT_MARKER_PATH})" = ${quote(SHARED_ROOT_MARKER_CONTENT.trim())} ]`;
const noMount = path => `awk -v p=${quote(path)} '$5 == p || index($5, p "/") == 1 { found = 1 } END { exit found ? 1 : 0 }' /proc/self/mountinfo`;
function lockGuard(lock, identity) {
  validate(lock, identity);
  return `${rootGuard} && [ ! -L ${lock} ] && [ -d ${lock} ] && [ "$(stat -c %u:%a ${lock})" = 0:700 ] && [ "$(stat -c '%d:%i' ${lock})" = ${quote(identity)} ] && ${noMount(lock)}`;
}

export function createVpsLockCommand(lock) {
  validate(lock);
  return `${rootGuard} && umask 077 && mkdir ${lock} && [ "$(stat -c %u:%a ${lock})" = 0:700 ] && ${noMount(lock)} && stat -c '%d:%i' ${lock}`;
}

export function releaseVpsLockCommand(lock, identity) {
  return `${lockGuard(lock, identity)} && rmdir ${lock}`;
}

export function createVpsBuildStateCommand(lock, identity) {
  return `${lockGuard(lock, identity)} && umask 077 && mkdir ${lock}/buildx && [ "$(stat -c %u:%a ${lock}/buildx)" = 0:700 ] && stat -c '%d:%i' ${lock}/buildx`;
}

export function scopeVpsBuildCommand(lock, identity, stateIdentity, command) {
  validate(lock, stateIdentity);
  if (typeof command !== "string" || !command.startsWith("docker compose ") ||
      /[\r\n\0]/u.test(command) || !/(?: build | run -d )/u.test(command)) {
    throw new TypeError("Only a generated build-capable Compose command may use temporary build state.");
  }
  return `${lockGuard(lock, identity)} && [ ! -L ${lock}/buildx ] && [ -d ${lock}/buildx ] && [ "$(stat -c %u:%a ${lock}/buildx)" = 0:700 ] && [ "$(stat -c '%d:%i' ${lock}/buildx)" = ${quote(stateIdentity)} ] && BUILDX_CONFIG=${quote(`${lock}/buildx`)} BUILDX_BUILDER=default DOCKER_BUILDKIT=1 COMPOSE_BAKE=false ${command}`;
}

export function cleanupVpsBuildStateCommand(lock, identity, stateIdentity) {
  validate(lock, stateIdentity);
  const state = `${lock}/buildx`;
  // Two passes: refuse the entire tree before unlinking anything, then recheck
  // each exact inode immediately before unlink/rmdir. Never follow symlinks,
  // cross a mount (including same-device bind mounts), or remove special files.
  return `${lockGuard(lock, identity)} || exit 73
state=${quote(state)}
expected=${quote(stateIdentity)}
state_guard() {
  ${lockGuard(lock, identity)} && [ ! -L "$state" ] && [ -d "$state" ] && [ "$(stat -c %u:%a "$state")" = 0:700 ] && [ "$(stat -c '%d:%i' "$state")" = "$expected" ]
}
walk() (
  path=$1; depth=$2; action=$3
  [ "$depth" -le 16 ] && [ ! -L "$path" ] || exit 1
  metadata=$(stat -c '%d:%i:%u:%h:%a' -- "$path") || exit 1
  oldIFS=$IFS; IFS=:; set -- $metadata; IFS=$oldIFS
  [ "$1" = "\${expected%%:*}" ] && [ "$3" = 0 ] && [ $((0$5 & 022)) -eq 0 ] || exit 1
  if [ -d "$path" ]; then
    for child in "$path"/* "$path"/.[!.]* "$path"/..?*; do
      if [ ! -e "$child" ] && [ ! -L "$child" ]; then continue; fi
      walk "$child" "$((depth + 1))" "$action" || exit 1
    done
    if [ "$action" = remove ]; then
      state_guard && [ ! -L "$path" ] && [ -d "$path" ] && [ "$(stat -c '%d:%i:%u:%a' -- "$path")" = "$1:$2:$3:$5" ] && rmdir -- "$path" || exit 1
    fi
  elif [ -f "$path" ] && [ "$4" = 1 ]; then
    if [ "$action" = remove ]; then
      state_guard && [ ! -L "$path" ] && [ -f "$path" ] && [ "$(stat -c '%d:%i:%u:%h:%a' -- "$path")" = "$metadata" ] && rm -- "$path" || exit 1
    fi
  else
    exit 1
  fi
)
state_guard && walk "$state" 0 check && walk "$state" 0 remove || exit 73`;
}

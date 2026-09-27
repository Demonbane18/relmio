export const INSTALL_ROOT = "/docker/n8n-openai-oauth";
export const PROJECT_NAME = "n8n-openai-oauth";
export const SERVICE_NAME = "openai-oauth";
export const MANAGED_MARKER_PATH = `${INSTALL_ROOT}/.managed-by-n8n-openai-oauth`;
export const SHARED_ROOT_MARKER_PATH = `${INSTALL_ROOT}/.managed-by-relmio-root`;
export const SHARED_ROOT_MARKER_CONTENT = "relmio-managed-root:v1\n";
export const SIDECAR_MARKER_CONTENT = "Managed by n8n-openai-oauth-setup.\n";
export const SIDECAR_BUILD_IGNORE_PATH = `${INSTALL_ROOT}/Dockerfile.dockerignore`;
export const SIDECAR_BUILD_IGNORE_CONTENT = "*\n!Dockerfile\n!openai-oauth-sidecar.mjs\n";
export const SIDECAR_BUILD_IGNORE_GUARD = `[ ! -L ${SIDECAR_BUILD_IGNORE_PATH} ] && { [ ! -e ${SIDECAR_BUILD_IGNORE_PATH} ] || { [ -f ${SIDECAR_BUILD_IGNORE_PATH} ] && [ "$(stat -c %u:%h ${SIDECAR_BUILD_IGNORE_PATH})" = 0:1 ] && [ $((0$(stat -c %a ${SIDECAR_BUILD_IGNORE_PATH}) & 022)) -eq 0 ] && [ "$(stat -c %s ${SIDECAR_BUILD_IGNORE_PATH})" = ${Buffer.byteLength(SIDECAR_BUILD_IGNORE_CONTENT)} ] && [ "$(cat ${SIDECAR_BUILD_IGNORE_PATH})" = '${SIDECAR_BUILD_IGNORE_CONTENT.trim()}' ]; }; }`;

const COMPOSE_PREFIX =
  "docker compose --project-name n8n-openai-oauth --file /docker/n8n-openai-oauth/docker-compose.yml";

export const PRECHECK_COMMAND = `if [ -e ${INSTALL_ROOT} ]; then if [ -L ${INSTALL_ROOT} ] || [ ! -d ${INSTALL_ROOT} ] || [ -L ${SHARED_ROOT_MARKER_PATH} ] || [ -L ${MANAGED_MARKER_PATH} ] || [ -L ${INSTALL_ROOT}/auth ] || { [ -e ${INSTALL_ROOT}/auth ] && [ ! -d ${INSTALL_ROOT}/auth ]; } || [ -L ${INSTALL_ROOT}/Dockerfile ] || { [ -e ${INSTALL_ROOT}/Dockerfile ] && [ ! -f ${INSTALL_ROOT}/Dockerfile ]; } || [ -L ${INSTALL_ROOT}/openai-oauth-sidecar.mjs ] || { [ -e ${INSTALL_ROOT}/openai-oauth-sidecar.mjs ] && [ ! -f ${INSTALL_ROOT}/openai-oauth-sidecar.mjs ]; } || [ -L ${INSTALL_ROOT}/docker-compose.yml ] || { [ -e ${INSTALL_ROOT}/docker-compose.yml ] && [ ! -f ${INSTALL_ROOT}/docker-compose.yml ]; } || [ -L ${INSTALL_ROOT}/auth/auth.json ] || { [ -e ${INSTALL_ROOT}/auth/auth.json ] && [ ! -f ${INSTALL_ROOT}/auth/auth.json ]; }; then exit 43; elif [ -e ${SHARED_ROOT_MARKER_PATH} ]; then if [ ! -f ${SHARED_ROOT_MARKER_PATH} ] || [ "$(cat ${SHARED_ROOT_MARKER_PATH})" != "${SHARED_ROOT_MARKER_CONTENT.trim()}" ]; then exit 42; elif [ -e ${MANAGED_MARKER_PATH} ]; then if [ ! -f ${MANAGED_MARKER_PATH} ] || [ "$(cat ${MANAGED_MARKER_PATH})" != "${SIDECAR_MARKER_CONTENT.trim()}" ]; then exit 42; else printf '%s\\n' managed; fi; else printf '%s\\n' new; fi; elif [ -f ${MANAGED_MARKER_PATH} ] && [ "$(cat ${MANAGED_MARKER_PATH})" = "${SIDECAR_MARKER_CONTENT.trim()}" ]; then printf '%s\\n' managed; else exit 42; fi; else printf '%s\\n' new; fi`;

const DEPLOYMENT_COMMANDS = Object.freeze([
  `[ -d /docker ] && [ ! -L /docker ] && [ "$(stat -c %u /docker)" = 0 ] && [ $((0$(stat -c %a /docker) & 022)) -eq 0 ] && [ ! -L ${INSTALL_ROOT} ] && if [ ! -e ${INSTALL_ROOT} ]; then mkdir -m 0755 ${INSTALL_ROOT}; fi && [ -d ${INSTALL_ROOT} ] && [ "$(stat -c %u ${INSTALL_ROOT})" = 0 ] && [ $((0$(stat -c %a ${INSTALL_ROOT}) & 022)) -eq 0 ]`,
  `install -d -m 0700 -o 1000 -g 1000 ${INSTALL_ROOT}/auth`,
  `chown 1000:1000 ${INSTALL_ROOT}/auth/auth.json`,
  `chmod 600 ${INSTALL_ROOT}/auth/auth.json`,
  `${COMPOSE_PREFIX} config --quiet`,
  `${COMPOSE_PREFIX} build ${SERVICE_NAME}`,
  `${COMPOSE_PREFIX} up -d --wait --wait-timeout 60 --no-build --no-deps ${SERVICE_NAME}`,
]);

const VERIFICATION_COMMANDS = Object.freeze({
  runningService: `${COMPOSE_PREFIX} ps --status running --services`,
  publicationState: `${COMPOSE_PREFIX} ps --format json ${SERVICE_NAME}`,
  models: `${COMPOSE_PREFIX} exec -T ${SERVICE_NAME} node -e 'fetch("http://127.0.0.1:10531/v1/models").then(async (response) => { console.log(await response.text()); process.exit(response.ok ? 0 : 1); }).catch(() => { console.log("RELMIO_MODEL_CHECK_UNREACHABLE"); process.exit(1); })'`,
  cleanup: `${COMPOSE_PREFIX} rm --force --stop ${SERVICE_NAME}`,
});

const ALLOWED_SIDECAR_COMMANDS = new Set([
  PRECHECK_COMMAND,
  SIDECAR_BUILD_IGNORE_GUARD,
  ...DEPLOYMENT_COMMANDS,
  ...Object.values(VERIFICATION_COMMANDS),
]);

export function createDeploymentCommands() {
  return [...DEPLOYMENT_COMMANDS];
}

export function createVerificationCommands() {
  return { ...VERIFICATION_COMMANDS };
}

export function assertSidecarOnlyCommands(commands) {
  if (!Array.isArray(commands) || commands.length === 0) {
    throw new TypeError("A sidecar command list is required.");
  }

  for (const command of commands) {
    if (
      typeof command !== "string" ||
      !ALLOWED_SIDECAR_COMMANDS.has(command)
    ) {
      throw new Error(
        "Command rejected: only the installer-managed sidecar may be changed; n8n must remain untouched.",
      );
    }
  }

  return commands;
}

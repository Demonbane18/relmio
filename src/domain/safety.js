export const INSTALL_ROOT = "/docker/n8n-openai-oauth";
export const PROJECT_NAME = "n8n-openai-oauth";
export const SERVICE_NAME = "openai-oauth";
export const MANAGED_MARKER_PATH = `${INSTALL_ROOT}/.managed-by-n8n-openai-oauth`;

const COMPOSE_PREFIX =
  "docker compose --project-name n8n-openai-oauth --file /docker/n8n-openai-oauth/docker-compose.yml";

export const PRECHECK_COMMAND = `if [ -e ${INSTALL_ROOT} ] && [ ! -f ${MANAGED_MARKER_PATH} ]; then exit 42; fi`;

const DEPLOYMENT_COMMANDS = Object.freeze([
  `install -d -m 0755 ${INSTALL_ROOT}`,
  `install -d -m 0700 -o 1000 -g 1000 ${INSTALL_ROOT}/auth`,
  `chown 1000:1000 ${INSTALL_ROOT}/auth/auth.json`,
  `chmod 600 ${INSTALL_ROOT}/auth/auth.json`,
  `${COMPOSE_PREFIX} config --quiet`,
  `${COMPOSE_PREFIX} build ${SERVICE_NAME}`,
  `${COMPOSE_PREFIX} up -d --wait --wait-timeout 60 --no-deps ${SERVICE_NAME}`,
]);

const VERIFICATION_COMMANDS = Object.freeze({
  runningService: `${COMPOSE_PREFIX} ps --status running --services`,
  publishedPort: `${COMPOSE_PREFIX} port ${SERVICE_NAME} 10531`,
  models: `${COMPOSE_PREFIX} exec -T ${SERVICE_NAME} node -e 'fetch("http://127.0.0.1:10531/v1/models").then(async (response) => { console.log(await response.text()); process.exit(response.ok ? 0 : 1); }).catch(() => process.exit(1))'`,
});

const ALLOWED_SIDECAR_COMMANDS = new Set([
  PRECHECK_COMMAND,
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

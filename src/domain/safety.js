export function validateSiwcRegistrationId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{8,64}$/u.test(value)) {
    throw new TypeError("The selected SIWC registration is invalid.");
  }
  return value;
}

export function validateSiwcRuntimeId(value) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]{1,64}$/u.test(value)) {
    throw new TypeError("The selected SIWC runtime is invalid.");
  }
  return value;
}

export function validateSiwcAuthBinding(value) {
  if (
    !value || typeof value !== "object" || Array.isArray(value) ||
    Object.keys(value).length !== 5
  ) throw new TypeError("The selected SIWC account binding is invalid.");
  validateSiwcRegistrationId(value.registrationId);
  if (typeof value.clientId !== "string" || !/^[!-~]{1,256}$/u.test(value.clientId)) {
    throw new TypeError("The selected SIWC client is invalid.");
  }
  if (typeof value.generation !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value.generation)) {
    throw new TypeError("The selected SIWC generation is invalid.");
  }
  if (typeof value.ownerHostId !== "string" || !/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value.ownerHostId)) {
    throw new TypeError("The selected SIWC host is invalid.");
  }
  validateSiwcRuntimeId(value.ownerRuntimeId);
  return Object.freeze({ ...value });
}

const CATALOG_RECOVERIES = new Set([
  "retry-later", "reauthorize", "enable-plan", "manage-usage",
  "fix-request", "fix-configuration", "review-again", "resolve-handoff",
]);
const safeCatalogField = value => typeof value === "string" &&
  /^[A-Za-z0-9_.:-]{1,128}$/u.test(value) &&
  !/^sk-[A-Za-z0-9_-]{8,}$/u.test(value) &&
  !/^eyJ[A-Za-z0-9_-]{16,}\./u.test(value) ? value : undefined;

export function safeSiwcCatalogFailure(error) {
  return {
    error: "The selected account model catalog could not be verified.",
    status: Number.isInteger(error?.status) && error.status >= 400 &&
      error.status <= 599 ? error.status : 503,
    ...(safeCatalogField(error?.code) ? { code: error.code } : {}),
    ...(safeCatalogField(error?.param) ? { param: error.param } : {}),
    ...(safeCatalogField(error?.requestId) ? { requestId: error.requestId } : {}),
    recovery: CATALOG_RECOVERIES.has(error?.recovery) ? error.recovery : "retry-later",
  };
}

export function safeSiwcRuntimeFailure() {
  return {
    error: "The owned runtime could not be verified after transfer.",
    status: 503,
    recovery: "resolve-handoff",
  };
}


export const INSTALL_ROOT = "/docker/n8n-openai-oauth";
export const PROJECT_NAME = "n8n-openai-oauth";
export const SERVICE_NAME = "openai-oauth";
export const MANAGED_MARKER_PATH = `${INSTALL_ROOT}/.managed-by-n8n-openai-oauth`;
export const SHARED_ROOT_MARKER_PATH = `${INSTALL_ROOT}/.managed-by-relmio-root`;
export const SHARED_ROOT_MARKER_CONTENT = "relmio-managed-root:v1\n";
export const SIDECAR_MARKER_CONTENT = "Managed by n8n-openai-oauth-setup.\n";
export const SIWC_MIGRATION_PENDING_PATH = `${INSTALL_ROOT}/.siwc-migration-pending`;
export const SIWC_MIGRATED_PATH = `${INSTALL_ROOT}/.siwc-migrated`;
export const SIWC_MIGRATION_MARKER_CONTENT = "relmio-siwc-migration:v1\n";
export const SIWC_STAGING_PATH = `${INSTALL_ROOT}/.siwc-staging.json`;
export const SIDECAR_BUILD_IGNORE_PATH = `${INSTALL_ROOT}/Dockerfile.dockerignore`;
export const SIDECAR_BUILD_IGNORE_CONTENT = "*\n!Dockerfile\n!package.json\n!package-lock.json\n!services/\n!services/siwc-session.mjs\n!services/siwc-handoff.mjs\n!services/local-integration-lifecycle-lock.js\n!gateway/\n!gateway/openai-oauth-sidecar.mjs\n!infrastructure/\n!infrastructure/local-process.js\n!infrastructure/process-identity.js\n";
export const SIDECAR_BUILD_IGNORE_GUARD = `[ ! -L ${SIDECAR_BUILD_IGNORE_PATH} ] && { [ ! -e ${SIDECAR_BUILD_IGNORE_PATH} ] || { [ -f ${SIDECAR_BUILD_IGNORE_PATH} ] && [ "$(stat -c %u:%h ${SIDECAR_BUILD_IGNORE_PATH})" = 0:1 ] && [ $((0$(stat -c %a ${SIDECAR_BUILD_IGNORE_PATH}) & 022)) -eq 0 ] && [ "$(stat -c %s ${SIDECAR_BUILD_IGNORE_PATH})" = ${Buffer.byteLength(SIDECAR_BUILD_IGNORE_CONTENT)} ] && [ "$(cat ${SIDECAR_BUILD_IGNORE_PATH})" = '${SIDECAR_BUILD_IGNORE_CONTENT.trim()}' ]; }; }`;
export const SIDECAR_FRESH_CONTEXT_GUARD = `for p in ${MANAGED_MARKER_PATH} ${SIDECAR_BUILD_IGNORE_PATH} ${INSTALL_ROOT}/Dockerfile ${INSTALL_ROOT}/docker-compose.yml ${INSTALL_ROOT}/package.json ${INSTALL_ROOT}/package-lock.json ${INSTALL_ROOT}/services ${INSTALL_ROOT}/gateway ${INSTALL_ROOT}/infrastructure; do [ ! -e "$p" ] && [ ! -L "$p" ] || exit 42; done; [ ! -L ${INSTALL_ROOT}/siwc ] || exit 43; if [ -d ${INSTALL_ROOT}/siwc ]; then [ -z "$(find ${INSTALL_ROOT}/siwc -mindepth 1 -maxdepth 1 -print -quit)" ] || exit 42; fi; if [ -d ${INSTALL_ROOT}/auth ]; then [ -z "$(find ${INSTALL_ROOT}/auth -mindepth 1 -maxdepth 1 -print -quit)" ] || exit 42; fi`;
export const SIDECAR_MANAGED_CONTEXT_GUARD = `for p in /docker ${INSTALL_ROOT} ${INSTALL_ROOT}/services ${INSTALL_ROOT}/gateway ${INSTALL_ROOT}/infrastructure ${INSTALL_ROOT}/legacy; do if [ -e "$p" ] || [ -L "$p" ]; then [ ! -L "$p" ] && [ -d "$p" ] && [ "$(stat -c %u "$p")" = 0 ] && [ $((0$(stat -c %a "$p") & 022)) -eq 0 ] || exit 43; fi; done; for p in ${SHARED_ROOT_MARKER_PATH} ${MANAGED_MARKER_PATH} ${SIWC_STAGING_PATH} ${SIWC_MIGRATION_PENDING_PATH} ${SIWC_MIGRATED_PATH} ${SIDECAR_BUILD_IGNORE_PATH} ${INSTALL_ROOT}/Dockerfile ${INSTALL_ROOT}/docker-compose.yml ${INSTALL_ROOT}/package.json ${INSTALL_ROOT}/package-lock.json ${INSTALL_ROOT}/services/siwc-session.mjs ${INSTALL_ROOT}/services/siwc-handoff.mjs ${INSTALL_ROOT}/services/local-integration-lifecycle-lock.js ${INSTALL_ROOT}/gateway/openai-oauth-sidecar.mjs ${INSTALL_ROOT}/gateway/codex-chat.js ${INSTALL_ROOT}/gateway/codex-app-server.mjs ${INSTALL_ROOT}/infrastructure/local-process.js ${INSTALL_ROOT}/infrastructure/process-identity.js ${INSTALL_ROOT}/openai-oauth-sidecar.mjs; do if [ -e "$p" ] || [ -L "$p" ]; then [ ! -L "$p" ] && [ -f "$p" ] && [ "$(stat -c %u:%h "$p")" = 0:1 ] && [ $((0$(stat -c %a "$p") & 022)) -eq 0 ] || exit 43; fi; done; if [ -e ${INSTALL_ROOT}/siwc ] || [ -L ${INSTALL_ROOT}/siwc ]; then [ ! -L ${INSTALL_ROOT}/siwc ] && [ -d ${INSTALL_ROOT}/siwc ] && [ "$(stat -c %u:%g:%a ${INSTALL_ROOT}/siwc)" = 1000:1000:700 ] || exit 43; fi`;

const COMPOSE_PREFIX =
  "docker compose --project-name n8n-openai-oauth --file /docker/n8n-openai-oauth/docker-compose.yml";

export const PRECHECK_COMMAND = `if [ -e ${INSTALL_ROOT} ]; then [ ! -L ${INSTALL_ROOT} ] && [ -d ${INSTALL_ROOT} ] || exit 43; for p in ${SHARED_ROOT_MARKER_PATH} ${MANAGED_MARKER_PATH} ${SIDECAR_BUILD_IGNORE_PATH} ${SIWC_MIGRATION_PENDING_PATH} ${SIWC_MIGRATED_PATH} ${INSTALL_ROOT}/auth ${INSTALL_ROOT}/siwc ${INSTALL_ROOT}/Dockerfile ${INSTALL_ROOT}/package.json ${INSTALL_ROOT}/package-lock.json ${INSTALL_ROOT}/services ${INSTALL_ROOT}/services/siwc-session.mjs ${INSTALL_ROOT}/services/siwc-handoff.mjs ${INSTALL_ROOT}/services/local-integration-lifecycle-lock.js ${INSTALL_ROOT}/gateway ${INSTALL_ROOT}/gateway/openai-oauth-sidecar.mjs ${INSTALL_ROOT}/infrastructure ${INSTALL_ROOT}/infrastructure/local-process.js ${INSTALL_ROOT}/infrastructure/process-identity.js ${INSTALL_ROOT}/docker-compose.yml; do [ ! -L "$p" ] || exit 43; done; if [ -e ${INSTALL_ROOT}/auth/auth.json ]; then [ -f ${SIWC_MIGRATED_PATH} ] && [ "$(cat ${SIWC_MIGRATED_PATH})" = '${SIWC_MIGRATION_MARKER_CONTENT.trim()}' ] || exit 42; fi; if [ -e ${SHARED_ROOT_MARKER_PATH} ]; then [ -f ${SHARED_ROOT_MARKER_PATH} ] && [ "$(cat ${SHARED_ROOT_MARKER_PATH})" = "${SHARED_ROOT_MARKER_CONTENT.trim()}" ] || exit 42; if [ -e ${MANAGED_MARKER_PATH} ]; then [ -f ${MANAGED_MARKER_PATH} ] && [ "$(cat ${MANAGED_MARKER_PATH})" = "${SIDECAR_MARKER_CONTENT.trim()}" ] || exit 42; printf '%s\\n' managed; else [ ! -e ${INSTALL_ROOT}/siwc/host.json ] || exit 42; printf '%s\\n' new; fi; elif [ -f ${MANAGED_MARKER_PATH} ] && [ "$(cat ${MANAGED_MARKER_PATH})" = "${SIDECAR_MARKER_CONTENT.trim()}" ]; then printf '%s\\n' managed; else exit 42; fi; else printf '%s\\n' new; fi`;

const DEPLOYMENT_COMMANDS = Object.freeze([
  `[ -d /docker ] && [ ! -L /docker ] && [ "$(stat -c %u /docker)" = 0 ] && [ $((0$(stat -c %a /docker) & 022)) -eq 0 ] && [ ! -L ${INSTALL_ROOT} ] && if [ ! -e ${INSTALL_ROOT} ]; then mkdir -m 0755 ${INSTALL_ROOT}; fi && [ -d ${INSTALL_ROOT} ] && [ "$(stat -c %u ${INSTALL_ROOT})" = 0 ] && [ $((0$(stat -c %a ${INSTALL_ROOT}) & 022)) -eq 0 ]`,
  `install -d -m 0700 -o 1000 -g 1000 ${INSTALL_ROOT}/siwc`,
  `install -d -m 0755 ${INSTALL_ROOT}/services ${INSTALL_ROOT}/gateway ${INSTALL_ROOT}/infrastructure`,
  `${COMPOSE_PREFIX} config --quiet`,
  `${COMPOSE_PREFIX} build ${SERVICE_NAME}`,
  `${COMPOSE_PREFIX} up -d --wait --wait-timeout 60 --no-build --no-deps ${SERVICE_NAME}`,
]);

const VERIFICATION_COMMANDS = Object.freeze({
  runningService: `${COMPOSE_PREFIX} ps --status running --services`,
  publicationState: `${COMPOSE_PREFIX} ps --format json ${SERVICE_NAME}`,
  managementConfig: `${COMPOSE_PREFIX} config --format json`,
  ownerContainer: `docker inspect --format '{{json .}}' n8n-openai-oauth-openai-oauth-1`,
  ownerPresence: `docker container ls --all --no-trunc --filter 'name=^/n8n-openai-oauth-openai-oauth-1$' --format '{{.ID}}'`,
  ownerImage: `docker image inspect --format '{{json .}}' n8n-openai-oauth:local`,
  sharedRoot: `${SIDECAR_MANAGED_CONTEXT_GUARD}; if [ -e ${SHARED_ROOT_MARKER_PATH} ]; then [ "$(cat ${SHARED_ROOT_MARKER_PATH})" = '${SHARED_ROOT_MARKER_CONTENT.trim()}' ] && printf managed; else printf absent; fi`,
  staging: `${SIDECAR_MANAGED_CONTEXT_GUARD}; if [ -e ${SIWC_STAGING_PATH} ]; then [ "$(stat -c %s ${SIWC_STAGING_PATH})" -le 16384 ] && cat ${SIWC_STAGING_PATH}; else printf null; fi`,
  stagedFiles: `${SIDECAR_MANAGED_CONTEXT_GUARD}; for p in ${MANAGED_MARKER_PATH} ${SIDECAR_BUILD_IGNORE_PATH} ${INSTALL_ROOT}/Dockerfile ${INSTALL_ROOT}/docker-compose.yml ${INSTALL_ROOT}/package.json ${INSTALL_ROOT}/package-lock.json ${INSTALL_ROOT}/services/siwc-session.mjs ${INSTALL_ROOT}/services/siwc-handoff.mjs ${INSTALL_ROOT}/services/local-integration-lifecycle-lock.js ${INSTALL_ROOT}/gateway/openai-oauth-sidecar.mjs ${INSTALL_ROOT}/gateway/codex-chat.js ${INSTALL_ROOT}/gateway/codex-app-server.mjs ${INSTALL_ROOT}/infrastructure/local-process.js ${INSTALL_ROOT}/infrastructure/process-identity.js ${INSTALL_ROOT}/openai-oauth-sidecar.mjs; do if [ -e "$p" ]; then sha256sum "$p" || exit 43; fi; done`,
  legacyCredential: `[ ! -L ${INSTALL_ROOT}/auth/auth.json ] && [ -f ${INSTALL_ROOT}/auth/auth.json ] && [ "$(stat -c %u:%a ${INSTALL_ROOT}/auth/auth.json)" = 1000:600 ] && [ "$(stat -c %s ${INSTALL_ROOT}/auth/auth.json)" -le 131072 ] && stat -c '%d:%i:%u:%a:%s:%Y' ${INSTALL_ROOT}/auth/auth.json`,
  archiveLegacy: `${SIDECAR_MANAGED_CONTEXT_GUARD}; [ ! -L ${INSTALL_ROOT}/legacy ] && if [ ! -e ${INSTALL_ROOT}/legacy ]; then install -d -m 0700 ${INSTALL_ROOT}/legacy; fi && for p in ${INSTALL_ROOT}/Dockerfile ${INSTALL_ROOT}/docker-compose.yml ${MANAGED_MARKER_PATH}; do [ ! -L "$p" ] && [ -f "$p" ] || exit 43; done && cp -p -n ${INSTALL_ROOT}/Dockerfile ${INSTALL_ROOT}/docker-compose.yml ${MANAGED_MARKER_PATH} ${INSTALL_ROOT}/legacy/ && for p in ${INSTALL_ROOT}/openai-oauth-sidecar.mjs ${SIDECAR_BUILD_IGNORE_PATH}; do if [ -e "$p" ]; then [ ! -L "$p" ] && [ -f "$p" ] && cp -p -n "$p" ${INSTALL_ROOT}/legacy/ || exit 43; fi; done`,
  legacyArchiveFiles: `${SIDECAR_MANAGED_CONTEXT_GUARD}; if [ ! -e ${INSTALL_ROOT}/legacy ]; then printf absent; else for p in ${INSTALL_ROOT}/legacy/Dockerfile ${INSTALL_ROOT}/legacy/docker-compose.yml ${INSTALL_ROOT}/legacy/.managed-by-n8n-openai-oauth ${INSTALL_ROOT}/legacy/openai-oauth-sidecar.mjs ${INSTALL_ROOT}/legacy/Dockerfile.dockerignore; do if [ -e "$p" ] || [ -L "$p" ]; then [ ! -L "$p" ] && [ -f "$p" ] && [ "$(stat -c %u:%h "$p")" = 0:1 ] && [ $((0$(stat -c %a "$p") & 022)) -eq 0 ] && sha256sum "$p" || exit 43; fi; done; fi`,
  legacyStatus: `if [ -L ${INSTALL_ROOT} ] || [ -L ${MANAGED_MARKER_PATH} ] || [ -L ${INSTALL_ROOT}/auth ] || [ -L ${INSTALL_ROOT}/auth/auth.json ] || [ -L ${SIWC_MIGRATION_PENDING_PATH} ] || [ -L ${SIWC_MIGRATED_PATH} ]; then exit 43; elif [ -f ${SIWC_MIGRATED_PATH} ] && [ "$(cat ${SIWC_MIGRATED_PATH})" = '${SIWC_MIGRATION_MARKER_CONTENT.trim()}' ]; then printf managed; elif [ -f ${SIWC_MIGRATION_PENDING_PATH} ] && [ "$(cat ${SIWC_MIGRATION_PENDING_PATH})" = '${SIWC_MIGRATION_MARKER_CONTENT.trim()}' ]; then printf partial; elif [ -f ${MANAGED_MARKER_PATH} ] && [ "$(cat ${MANAGED_MARKER_PATH})" = "${SIDECAR_MARKER_CONTENT.trim()}" ] && [ -f ${INSTALL_ROOT}/auth/auth.json ]; then printf legacy; elif [ -f ${MANAGED_MARKER_PATH} ] && [ "$(cat ${MANAGED_MARKER_PATH})" = "${SIDECAR_MARKER_CONTENT.trim()}" ]; then printf managed; else printf absent; fi`,
  host: `${COMPOSE_PREFIX} run --rm --no-deps -T --entrypoint node ${SERVICE_NAME} /app/services/siwc-handoff.mjs host`,
  accept: `${COMPOSE_PREFIX} run --rm --no-deps -T --entrypoint node ${SERVICE_NAME} /app/services/siwc-handoff.mjs accept`,
  receipt: `${COMPOSE_PREFIX} run --rm --no-deps -T --entrypoint node ${SERVICE_NAME} /app/services/siwc-handoff.mjs receipt`,
  oneOffContainers: "docker ps -a --filter label=com.docker.compose.project=n8n-openai-oauth --filter label=com.docker.compose.oneoff=True -q",
  account: `${COMPOSE_PREFIX} run --rm --no-deps -T --entrypoint node ${SERVICE_NAME} /app/services/siwc-handoff.mjs account`,
  accountLive: `${COMPOSE_PREFIX} exec -T ${SERVICE_NAME} node /app/services/siwc-handoff.mjs account`,
  signOut: `${COMPOSE_PREFIX} run --rm --no-deps -T --entrypoint node ${SERVICE_NAME} /app/services/siwc-handoff.mjs sign-out`,
  disablePlan: `${COMPOSE_PREFIX} run --rm --no-deps -T --entrypoint node ${SERVICE_NAME} /app/services/siwc-handoff.mjs disable-plan`,
  enablePlan: `${COMPOSE_PREFIX} run --rm --no-deps -T --entrypoint node ${SERVICE_NAME} /app/services/siwc-handoff.mjs enable-plan`,
  stop: `${COMPOSE_PREFIX} stop -t 30 ${SERVICE_NAME}`,
  models: `${COMPOSE_PREFIX} exec -T ${SERVICE_NAME} node -e '(async()=>{let key="";for await(const chunk of process.stdin){key+=chunk;if(key.length>128)process.exit(1)}const response=await fetch("http://127.0.0.1:10531/v1/models",{headers:{Authorization:"Bearer "+key}});console.log(await response.text());process.exit(response.ok?0:1)})().catch(()=>{console.log("RELMIO_MODEL_CHECK_UNREACHABLE");process.exit(1)})'`,
});

const ALLOWED_SIDECAR_COMMANDS = new Set([
  PRECHECK_COMMAND,
  SIDECAR_BUILD_IGNORE_GUARD,
  SIDECAR_FRESH_CONTEXT_GUARD,
  SIDECAR_MANAGED_CONTEXT_GUARD,
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

export function parseManagedFileHashes(output) {
  if (typeof output !== "string" || Buffer.byteLength(output) > 8192) {
    throw new Error("The managed file identities are invalid.");
  }
  const files = {};
  for (const line of output.trim().split("\n").filter(Boolean)) {
    const match = /^([a-f0-9]{64})  (\/docker\/n8n-openai-oauth\/[A-Za-z0-9/._-]+)$/u.exec(line);
    if (!match || match[2].split("/").some(part => part === "." || part === "..") ||
        Object.hasOwn(files, match[2])) throw new Error("The managed file identities are invalid.");
    files[match[2]] = match[1];
  }
  return files;
}

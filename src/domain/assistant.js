import {
  INSTALL_ROOT,
  MANAGED_MARKER_PATH,
  SHARED_ROOT_MARKER_CONTENT,
  SHARED_ROOT_MARKER_PATH,
  SIDECAR_MARKER_CONTENT,
} from "./safety.js";
import { validateDockerName } from "./validation.js";

export const ASSISTANT_ROOT = INSTALL_ROOT + "/assistant-sandbox";
export const ASSISTANT_MARKER_PATH =
  ASSISTANT_ROOT + "/.managed-by-relmio-ai-assistant";
export { SHARED_ROOT_MARKER_PATH as ASSISTANT_ROOT_MARKER_PATH };

const ASSISTANT_MARKER_VERSION = 2;
const LEGACY_ASSISTANT_MARKER_VERSION = 1;
const INSTALL_ID_PATTERN = /^[a-f0-9]{32}$/u;
const PROJECT_NAME_PATTERN = /^relmio-ai-[a-f0-9]{32}$/u;
const SANDBOX_ALIAS_PATTERN = /^relmio-ai-sandbox-[a-f0-9]{32}$/u;
const SEARXNG_ALIAS_PATTERN = /^relmio-ai-searxng-[a-f0-9]{32}$/u;
const MAX_MARKER_BYTES = 512;

const MANAGED_LABEL = "io.relmio.ai-assistant.managed";
const INSTALL_ID_LABEL = "io.relmio.ai-assistant.install-id";
const EXPECTED_MANAGED_LABEL_VALUE = "true";
const SANDBOX_SERVICE_NAMES = Object.freeze([
  "relmio-sandbox-certs",
  "relmio-sandbox-api",
  "relmio-sandbox-runner-1",
]);
const SEARXNG_SERVICE_NAME = "relmio-searxng";

const ROOT_PRECHECK =
  "if [ -e " + INSTALL_ROOT + " ]; then " +
  "if [ -L " + INSTALL_ROOT + " ] || [ ! -d " + INSTALL_ROOT + " ] || " +
  "[ -L " + SHARED_ROOT_MARKER_PATH + " ] || [ -L " + MANAGED_MARKER_PATH + " ]; then exit 43; " +
  "elif [ -e " + SHARED_ROOT_MARKER_PATH + " ]; then " +
  "if [ ! -f " + SHARED_ROOT_MARKER_PATH + " ] || [ \"$(cat " + SHARED_ROOT_MARKER_PATH + ")\" != \"" +
  SHARED_ROOT_MARKER_CONTENT.trim() + "\" ]; then exit 42; fi; " +
  "elif [ -f " + MANAGED_MARKER_PATH + " ] && [ \"$(cat " +
  MANAGED_MARKER_PATH + ")\" = \"" + SIDECAR_MARKER_CONTENT.trim() +
  "\" ]; then :; else exit 42; fi; fi";

export const ASSISTANT_PRECHECK_COMMAND =
  ROOT_PRECHECK + "; if [ -L " + ASSISTANT_ROOT + " ]; then exit 43; " +
  "elif [ -e " + ASSISTANT_ROOT + " ]; then " +
  "if [ ! -d " + ASSISTANT_ROOT + " ]; then exit 42; " +
  "elif [ -L " + ASSISTANT_MARKER_PATH + " ] || [ -L " +
  ASSISTANT_ROOT + "/docker-compose.yml ] || [ -L " +
  ASSISTANT_ROOT + "/searxng-settings.yml ] || [ -L " +
  ASSISTANT_ROOT + "/.env ]; then exit 43; " +
  "elif [ ! -f " + ASSISTANT_MARKER_PATH + " ]; then exit 42; " +
  "else printf '%s\\n' managed; cat " + ASSISTANT_MARKER_PATH +
  "; fi; else printf '%s\\n' new; fi";

function createInstallHex(randomBytes) {
  const value = randomBytes(16);
  if (!Buffer.isBuffer(value) || value.length !== 16) {
    throw new TypeError("A cryptographic AI Assistant install generator is required.");
  }
  return value.toString("hex");
}

function objectHasExactKeys(value, keys) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length &&
    actual.every((key, index) => key === expected[index]);
}

export function validateAssistantInstallation(value) {
  const legacyKeys = [
    "version",
    "installId",
    "projectName",
    "sandboxAlias",
    "searxngAlias",
  ];
  if (
    value?.version === LEGACY_ASSISTANT_MARKER_VERSION &&
    objectHasExactKeys(value, legacyKeys)
  ) {
    return validateAssistantInstallation({
      ...value,
      version: ASSISTANT_MARKER_VERSION,
      includeSearxng: true,
    });
  }
  const requiredKeys = [...legacyKeys, "includeSearxng"];
  if (
    !objectHasExactKeys(value, requiredKeys) ||
    value.version !== ASSISTANT_MARKER_VERSION ||
    typeof value.installId !== "string" ||
    !INSTALL_ID_PATTERN.test(value.installId) ||
    typeof value.projectName !== "string" ||
    !PROJECT_NAME_PATTERN.test(value.projectName) ||
    typeof value.sandboxAlias !== "string" ||
    !SANDBOX_ALIAS_PATTERN.test(value.sandboxAlias) ||
    typeof value.searxngAlias !== "string" ||
    !SEARXNG_ALIAS_PATTERN.test(value.searxngAlias) ||
    typeof value.includeSearxng !== "boolean" ||
    value.sandboxAlias === value.searxngAlias ||
    value.sandboxAlias.endsWith(value.installId) ||
    value.searxngAlias.endsWith(value.installId) ||
    value.sandboxAlias.slice(-32) === value.searxngAlias.slice(-32)
  ) {
    throw new TypeError("The AI Assistant installation marker is invalid.");
  }
  return {
    version: ASSISTANT_MARKER_VERSION,
    installId: value.installId,
    projectName: value.projectName,
    sandboxAlias: value.sandboxAlias,
    searxngAlias: value.searxngAlias,
    includeSearxng: value.includeSearxng,
  };
}

export function validateAssistantSearxngSelection(includeSearxng) {
  if (typeof includeSearxng !== "boolean") {
    throw new TypeError("Choose whether to include optional SearXNG web search.");
  }
  return includeSearxng;
}

export function createAssistantInstallation({ randomBytes, includeSearxng }) {
  if (typeof randomBytes !== "function") {
    throw new TypeError("A cryptographic AI Assistant install generator is required.");
  }
  const selectedSearxng = validateAssistantSearxngSelection(includeSearxng);
  const installId = createInstallHex(randomBytes);
  const projectSuffix = createInstallHex(randomBytes);
  const sandboxSuffix = createInstallHex(randomBytes);
  const searxngSuffix = createInstallHex(randomBytes);
  return validateAssistantInstallation({
    version: ASSISTANT_MARKER_VERSION,
    installId,
    projectName: "relmio-ai-" + projectSuffix,
    sandboxAlias: "relmio-ai-sandbox-" + sandboxSuffix,
    searxngAlias: "relmio-ai-searxng-" + searxngSuffix,
    includeSearxng: selectedSearxng,
  });
}

export function serializeAssistantMarker(installation) {
  return JSON.stringify(validateAssistantInstallation(installation)) + "\n";
}

export function parseAssistantMarker(contents) {
  if (
    typeof contents !== "string" ||
    contents.length === 0 ||
    Buffer.byteLength(contents, "utf8") > MAX_MARKER_BYTES
  ) {
    throw new TypeError("The AI Assistant installation marker is invalid.");
  }
  try {
    return validateAssistantInstallation(JSON.parse(contents));
  } catch {
    throw new TypeError("The AI Assistant installation marker is invalid.");
  }
}

export function parseAssistantPrecheck(output) {
  if (typeof output !== "string" || output.length === 0) {
    throw new TypeError("The VPS AI Assistant install-directory check returned an invalid state.");
  }
  if (output === "new\n") return { state: "new", installation: null };
  if (!output.startsWith("managed\n")) {
    throw new TypeError("The VPS AI Assistant install-directory check returned an invalid state.");
  }
  return {
    state: "managed",
    installation: parseAssistantMarker(output.slice("managed\n".length)),
  };
}

function composePrefix(installation) {
  const safeInstallation = validateAssistantInstallation(installation);
  return "docker compose --project-name " + safeInstallation.projectName +
    " --file " + ASSISTANT_ROOT + "/docker-compose.yml";
}

export function getAssistantServiceNames(installation) {
  const safeInstallation = validateAssistantInstallation(installation);
  return safeInstallation.includeSearxng
    ? [...SANDBOX_SERVICE_NAMES, SEARXNG_SERVICE_NAME]
    : [...SANDBOX_SERVICE_NAMES];
}

export function getAssistantContainerNames(installation) {
  const safeInstallation = validateAssistantInstallation(installation);
  const prefix = "relmio-ai-" + safeInstallation.installId.slice(0, 16) + "-";
  return {
    certs: prefix + "certs",
    api: prefix + "api",
    runner: prefix + "runner",
    ...(safeInstallation.includeSearxng ? { searxng: prefix + "search" } : {}),
  };
}

function validateAssistantStartupScope(installation, startupScope) {
  if (startupScope === "all") return getAssistantServiceNames(installation);
  if (startupScope === "searxng" && installation.includeSearxng) {
    return [SEARXNG_SERVICE_NAME];
  }
  throw new TypeError("The AI Assistant startup scope is invalid.");
}

export function createAssistantDeploymentCommands({ installation, startupScope = "all" }) {
  const safeInstallation = validateAssistantInstallation(installation);
  const prefix = composePrefix(safeInstallation);
  const publicPaths = [ASSISTANT_ROOT + "/docker-compose.yml"];
  if (safeInstallation.includeSearxng) {
    publicPaths.push(ASSISTANT_ROOT + "/searxng-settings.yml");
  }
  const startupServices = validateAssistantStartupScope(safeInstallation, startupScope);
  return [
    "install -d -m 0755 " + INSTALL_ROOT,
    "install -d -m 0700 " + ASSISTANT_ROOT,
    "chmod 600 " + SHARED_ROOT_MARKER_PATH + " " + ASSISTANT_MARKER_PATH +
      " " + ASSISTANT_ROOT + "/.env",
    "chmod 644 " + publicPaths.join(" "),
    "test \"$(stat -c '%a' " + SHARED_ROOT_MARKER_PATH + ")\" = 600 && " +
      "test \"$(stat -c '%a' " + ASSISTANT_MARKER_PATH + ")\" = 600 && " +
      "test \"$(stat -c '%a' " + ASSISTANT_ROOT + "/.env)\" = 600",
    publicPaths.map(
      (path) => "test \"$(stat -c '%a' " + path + ")\" = 644",
    ).join(" && "),
    prefix + " config --quiet",
    prefix + " up -d --wait --wait-timeout 90 " + startupServices.join(" "),
  ];
}

export function createAssistantVerificationCommands({ installation, cleanupScope = "project" }) {
  const safeInstallation = validateAssistantInstallation(installation);
  const services = getAssistantServiceNames(safeInstallation).filter(
    (service) => service !== "relmio-sandbox-certs",
  );
  if (cleanupScope !== "project" && cleanupScope !== "searxng") {
    throw new TypeError("The AI Assistant cleanup scope is invalid.");
  }
  if (cleanupScope === "searxng" && !safeInstallation.includeSearxng) {
    throw new TypeError("The AI Assistant cleanup scope is invalid.");
  }
  const prefix = composePrefix(safeInstallation);
  return {
    health: prefix +
      " exec -T relmio-sandbox-api wget -qO- http://127.0.0.1:8080/healthz",
    runningServices: prefix + " ps --status running --services",
    publicationState: prefix + " ps --format json " + services.join(" "),
    cleanup: cleanupScope === "searxng"
      ? prefix + " rm -sf " + SEARXNG_SERVICE_NAME
      : prefix + " down --volumes",
  };
}

export function getAssistantManagedResourceNames(installation) {
  const safeInstallation = validateAssistantInstallation(installation);
  return {
    containers: Object.values(getAssistantContainerNames(safeInstallation)),
    network: safeInstallation.projectName + "-internal",
    volume: safeInstallation.projectName + "-sandbox-tls",
  };
}

function createAttestationCommand(resource, installation) {
  const safeInstallation = validateAssistantInstallation(installation);
  const filter = "--filter \"label=com.docker.compose.project=" +
    safeInstallation.projectName + "\"";
  if (resource === "containers") {
    return "docker container ls -a " + filter +
      " --format '{{.Label \"" + INSTALL_ID_LABEL + "\"}}|{{.Label \"" +
      MANAGED_LABEL + "\"}}'";
  }
  if (resource === "networks") {
    return "docker network ls " + filter +
      " --format '{{.Label \"" + INSTALL_ID_LABEL + "\"}}|{{.Label \"" +
      MANAGED_LABEL + "\"}}'";
  }
  return "docker volume ls " + filter +
    " --format '{{.Label \"" + INSTALL_ID_LABEL + "\"}}|{{.Label \"" +
    MANAGED_LABEL + "\"}}'";
}

export function createAssistantOwnershipAttestationCommands({ installation }) {
  return {
    containers: createAttestationCommand("containers", installation),
    networks: createAttestationCommand("networks", installation),
    volumes: createAttestationCommand("volumes", installation),
  };
}

function createExactResourceCommand(kind, names) {
  const nameField = kind === "containers" ? ".Names" : ".Name";
  const format = " --format '{{" + nameField + "}}|{{.Label \"" + INSTALL_ID_LABEL +
    "\"}}|{{.Label \"" + MANAGED_LABEL + "\"}}'";
  if (kind === "containers") {
    return names.containers.map(
      (name) => "docker container ls -a --filter \"name=" + name + "\"" + format,
    ).join(" && ");
  }
  if (kind === "network") {
    return "docker network ls --filter \"name=" + names.network + "\"" + format;
  }
  return "docker volume ls --filter \"name=" + names.volume + "\"" + format;
}

export function createAssistantExactResourceAttestationCommands({ installation }) {
  const names = getAssistantManagedResourceNames(installation);
  return {
    containers: createExactResourceCommand("containers", names),
    network: createExactResourceCommand("network", names),
    volume: createExactResourceCommand("volume", names),
  };
}

export function createAssistantNetworkCollisionCommand({ networkName, installation }) {
  const safeNetworkName = validateDockerName(networkName);
  validateAssistantInstallation(installation);
  return "ids=$(docker network inspect " + safeNetworkName +
    " --format '{{range $id, $_ := .Containers}}{{$id}}{{\"\\n\"}}{{end}}') && " +
    "if [ -n \"$ids\" ]; then printf '%s\\n' \"$ids\" | xargs -r docker inspect --format '{{.Id}}|{{index .Config.Labels \"" +
    INSTALL_ID_LABEL + "\"}}|{{with index .NetworkSettings.Networks \"" +
    safeNetworkName + "\"}}{{join .Aliases \",\"}}{{end}}'; fi";
}

export function getAssistantLabels(installation) {
  const safeInstallation = validateAssistantInstallation(installation);
  return {
    [MANAGED_LABEL]: EXPECTED_MANAGED_LABEL_VALUE,
    [INSTALL_ID_LABEL]: safeInstallation.installId,
  };
}

export function assertAssistantOnlyCommands({
  commands,
  installation,
  networkName,
  startupScope = "all",
  cleanupScope = "project",
}) {
  if (!Array.isArray(commands) || commands.length === 0) {
    throw new TypeError("An AI Assistant command list is required.");
  }
  const allowed = new Set([
    ASSISTANT_PRECHECK_COMMAND,
    createAssistantNetworkCollisionCommand({ networkName, installation }),
    ...Object.values(createAssistantOwnershipAttestationCommands({ installation })),
    ...Object.values(createAssistantExactResourceAttestationCommands({ installation })),
    ...createAssistantDeploymentCommands({ installation, startupScope }),
    ...Object.values(createAssistantVerificationCommands({ installation, cleanupScope })),
  ]);
  for (const command of commands) {
    if (typeof command !== "string" || !allowed.has(command)) {
      throw new Error(
        "Command rejected: only the managed AI Assistant companion may be changed; n8n must remain untouched.",
      );
    }
  }
  return commands;
}

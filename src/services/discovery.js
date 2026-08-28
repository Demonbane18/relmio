import { validateDockerName } from "../domain/validation.js";

const DOCKER_VERSION_COMMAND =
  "docker version --format '{{.Server.Version}}'";
const COMPOSE_VERSION_COMMAND = "docker compose version --short";
const RUNNING_CONTAINERS_COMMAND =
  "docker ps --filter status=running --format '{{json .}}'";

function isOfficialN8nImage(image) {
  return /(?:^|\/)n8nio\/n8n(?:[:@]|$)/.test(image);
}

async function runReadOnly(remote, command, label) {
  const result = await remote.exec(command);
  if (result.code !== 0) {
    throw new Error(`${label} failed. Check Docker access on the VPS.`);
  }
  return result.stdout.trim();
}

export function parseDockerPsOutput(output) {
  if (typeof output !== "string" || output.trim() === "") {
    return [];
  }

  try {
    return output
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line))
      .filter(
        (container) =>
          container.State === "running" &&
          typeof container.Image === "string" &&
          isOfficialN8nImage(container.Image),
      )
      .map((container) => ({
        id: String(container.ID),
        image: container.Image,
        name: validateDockerName(container.Names),
        state: container.State,
      }));
  } catch {
    throw new Error(
      "The installer could not understand Docker's container list.",
    );
  }
}

export async function discoverN8n(remote) {
  const dockerVersion = await runReadOnly(
    remote,
    DOCKER_VERSION_COMMAND,
    "Docker check",
  );
  const composeVersion = await runReadOnly(
    remote,
    COMPOSE_VERSION_COMMAND,
    "Docker Compose check",
  );
  const containerOutput = await runReadOnly(
    remote,
    RUNNING_CONTAINERS_COMMAND,
    "n8n discovery",
  );

  return {
    dockerVersion,
    composeVersion,
    containers: parseDockerPsOutput(containerOutput),
  };
}

export function createInspectNetworksCommand(containerName) {
  const safeName = validateDockerName(containerName);
  return `docker inspect ${safeName} --format '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}'`;
}

export function createInspectN8nEnabledModulesCommand(containerName) {
  const safeName = validateDockerName(containerName);
  return `docker inspect ${safeName} --format '{{range .Config.Env}}{{if eq (index (split . "=") 0) "N8N_ENABLED_MODULES"}}configured|{{println (join (slice (split . "=") 1) "=")}}{{end}}{{end}}'`;
}

export function parseN8nEnabledModulesOutput(output) {
  if (typeof output !== "string" || output.length > 4 * 1024) {
    throw new Error("The n8n AI Assistant prerequisite could not be verified.");
  }
  const lines = output.trim().split("\n").filter(Boolean);
  if (lines.length === 0) return { status: "missing" };
  if (lines.length !== 1 || !lines[0].startsWith("configured|")) {
    throw new Error("The n8n AI Assistant prerequisite could not be verified.");
  }
  const modules = lines[0]
    .slice("configured|".length)
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return { status: modules.includes("instance-ai") ? "enabled" : "configured" };
}

export async function discoverNetworks(remote, containerName) {
  const command = createInspectNetworksCommand(containerName);
  const enabledModulesCommand = createInspectN8nEnabledModulesCommand(containerName);
  const [output, enabledModulesOutput] = await Promise.all([
    runReadOnly(remote, command, "Docker network discovery"),
    runReadOnly(remote, enabledModulesCommand, "n8n AI Assistant prerequisite discovery"),
  ]);
  const networks = [
    ...new Set(
      output
        .split("\n")
        .map((name) => name.trim())
        .filter(Boolean)
        .map(validateDockerName),
    ),
  ];

  return {
    networks,
    recommended: networks.includes("proxy") ? "proxy" : (networks[0] ?? null),
    instanceAi: parseN8nEnabledModulesOutput(enabledModulesOutput),
  };
}

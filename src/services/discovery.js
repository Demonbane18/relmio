import { validateDockerName } from "../domain/validation.js";
import { describeVpsNetworkSupport } from "../domain/vps-network.js";

const DOCKER_VERSION_COMMAND =
  "docker version --format '{{.Server.Version}}'";
const COMPOSE_VERSION_COMMAND = "docker compose version --short";
const RUNNING_CONTAINERS_COMMAND =
  "docker ps --filter status=running --format '{{json .}}'";
// Static and read-only. Docker prints each container's two Compose labels by
// name, so nothing is parsed out of its comma-joined label column.
const COMPOSE_LABELS_COMMAND =
  "docker ps --all --format '{{.ID}}|{{.Label \"com.docker.compose.project\"}}|{{.Label \"com.docker.compose.service\"}}'";
// The service name in n8n's own Compose file for its sandbox stack.
const N8N_SANDBOX_SERVICE = "sandbox-api";
const DEFAULT_BRIDGE_OPTION = "com.docker.network.bridge.default_bridge";
const CONTAINER_ID = /^[a-f0-9]{12,64}$/u;
const IMAGE_ID = /^(?:sha256:)?[a-f0-9]{12,64}$/u;
const IMAGE_REFERENCE = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,254}$/u;
const COMPOSE_PROJECT = /^[a-z0-9][a-z0-9_-]{0,127}$/u;
const NONE_FOUND_MESSAGE =
  "No running container from the official n8n image (n8nio/n8n) was found. Relmio looks at running Docker containers only. Start n8n in Docker on this server, then check again.";

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

function firstDockerName(names) {
  if (typeof names !== "string") return null;
  for (const name of names.split(",")) {
    try { return validateDockerName(name); } catch { /* try the next name */ }
  }
  return null;
}

function runningContainers(output) {
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
          container.State === "running" && typeof container.Image === "string",
      );
  } catch {
    throw new Error(
      "The installer could not understand Docker's container list.",
    );
  }
}

// After an image tag moves, Docker lists a container that still runs the old
// image by image ID. `images` maps such a container's ID to the image name it
// was created from. `compose` holds the Compose labels read by name.
export function parseDockerPsOutput(output, { images, compose } = {}) {
  return runningContainers(output).flatMap((container) => {
    const id = String(container.ID);
    const image = IMAGE_ID.test(container.Image) ? images?.get(id) : container.Image;
    const name = typeof image === "string" && isOfficialN8nImage(image)
      ? firstDockerName(container.Names) : null;
    if (name === null) return [];
    const composeProject = compose?.projects.get(id) ?? null;
    return [{
      id,
      image,
      name,
      state: container.State,
      composeProject,
      n8nSandboxPresent: composeProject !== null && compose.sandboxProjects.has(composeProject),
    }];
  });
}

export function createInspectContainerImagesCommand(containerIds) {
  if (!Array.isArray(containerIds) || containerIds.length === 0 ||
      containerIds.some((id) => typeof id !== "string" || !CONTAINER_ID.test(id))) {
    throw new TypeError("Docker container IDs are invalid.");
  }
  return `docker container inspect --format '{{.Id}}|{{.Config.Image}}' ${containerIds.join(" ")}`;
}

export function parseContainerImagesOutput(output, containerIds) {
  const images = new Map();
  for (const line of typeof output === "string" ? output.split("\n") : []) {
    const [fullId, image, ...rest] = line.trim().split("|");
    if (rest.length > 0 || !CONTAINER_ID.test(fullId ?? "") || !IMAGE_REFERENCE.test(image ?? "")) continue;
    const id = containerIds.find((candidate) => fullId.startsWith(candidate));
    if (id !== undefined) images.set(id, image);
  }
  return images;
}

export function parseComposeLabelsOutput(output) {
  const projects = new Map();
  const sandboxProjects = new Set();
  for (const line of typeof output === "string" ? output.split("\n") : []) {
    const parts = line.trim().split("|");
    if (parts.length !== 3 || !CONTAINER_ID.test(parts[0]) || !COMPOSE_PROJECT.test(parts[1])) continue;
    projects.set(parts[0], parts[1]);
    if (parts[2] === N8N_SANDBOX_SERVICE) sandboxProjects.add(parts[1]);
  }
  return { projects, sandboxProjects };
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
  const compose = parseComposeLabelsOutput(await runReadOnly(
    remote,
    COMPOSE_LABELS_COMMAND,
    "n8n discovery",
  ));
  const imageIdContainers = runningContainers(containerOutput)
    .filter((container) => IMAGE_ID.test(container.Image) && CONTAINER_ID.test(String(container.ID)))
    .map((container) => String(container.ID));
  // One inspect, only for containers listed by image ID. A container that went
  // away in between makes Docker exit non-zero; the rest still resolve.
  const images = imageIdContainers.length === 0
    ? new Map()
    : parseContainerImagesOutput(
      (await remote.exec(createInspectContainerImagesCommand(imageIdContainers))).stdout,
      imageIdContainers,
    );
  const containers = parseDockerPsOutput(containerOutput, { images, compose });

  return {
    dockerVersion,
    composeVersion,
    containers,
    ...(containers.length === 0 ? { noneFoundMessage: NONE_FOUND_MESSAGE } : {}),
  };
}

export function createInspectNetworksCommand(containerName) {
  const safeName = validateDockerName(containerName);
  return `docker inspect ${safeName} --format '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}'`;
}

export function createInspectNetworkDetailsCommand(networkNames) {
  if (!Array.isArray(networkNames) || networkNames.length === 0) {
    throw new TypeError("Docker network names are invalid.");
  }
  return `docker network inspect --format '{{json .Name}}|{{json .Driver}}|{{json .Internal}}|{{json (index .Options "${DEFAULT_BRIDGE_OPTION}")}}' ${networkNames.map(validateDockerName).join(" ")}`;
}

// Marks networks on which a Relmio container certainly cannot work. Docker's
// predefined networks are known by name alone; `Internal` needs the inspect.
// A failed or unreadable inspect leaves a network unmarked instead of refused.
export function parseNetworkSupportOutput(output, networkNames) {
  const records = new Map(networkNames.map((name) => [name, { Name: name }]));
  for (const line of typeof output === "string" ? output.split("\n") : []) {
    const parts = line.trim().split("|");
    if (parts.length !== 4) continue;
    try {
      const [name, driver, internal, defaultBridge] = parts.map((part) => JSON.parse(part));
      if (records.has(name)) {
        records.set(name, {
          Name: name, Driver: driver, Internal: internal,
          Options: { [DEFAULT_BRIDGE_OPTION]: defaultBridge },
        });
      }
    } catch { /* this network keeps its name-only record */ }
  }
  return Object.fromEntries(networkNames.map((name) =>
    [name, describeVpsNetworkSupport(records.get(name), { outbound: true })]));
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
  const details = networks.length === 0
    ? { code: 1 }
    : await remote.exec(createInspectNetworkDetailsCommand(networks));
  const support = parseNetworkSupportOutput(details.code === 0 ? details.stdout : "", networks);
  const usable = networks.filter((name) => support[name].supported);
  const preferred = usable.length > 0 ? usable : networks;

  return {
    networks,
    recommended: preferred.includes("proxy") ? "proxy" : (preferred[0] ?? null),
    instanceAi: parseN8nEnabledModulesOutput(enabledModulesOutput),
    support,
  };
}

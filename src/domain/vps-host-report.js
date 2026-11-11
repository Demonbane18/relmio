// Turns facts Relmio already holds (the connection probe and the cached n8n
// discovery) into short rows for the VPS pages. Nothing here contacts the
// server. A pass row repeats what Docker reported and proves nothing about a
// later build; a fail row marks a flow that certainly cannot work.
export const VPS_FLOWS = Object.freeze(["chatgpt", "assistant", "supergrok", "claude", "local-model"]);

const ROOT_ONLY_FLOWS = ["chatgpt", "assistant", "supergrok", "claude"];
// Pinned artifacts exist for x86_64 and arm64 only.
const PINNED_CPU_FLOWS = ["supergrok", "claude", "local-model"];
const UNPINNED_CPU_FLOWS = ["chatgpt", "assistant"];
const BUILD_FLOWS = ["chatgpt", "supergrok", "claude", "local-model"];
const BIND_MOUNT_FLOWS = ["chatgpt", "assistant", "claude"];
const OUTBOUND_FLOWS = ["chatgpt", "supergrok", "claude", "local-model"];
// Oldest versions seen in Relmio's tests and live checks. Older ones only warn.
const TESTED_DOCKER_MAJOR = 28;
const TESTED_COMPOSE = [2, 38];
const SMALL_MEMORY_BYTES = 2 * 1024 ** 3;

const row = (id, level, text, flows = []) => ({ id, level, text, flows });
const numbers = version => version.split(".").map(part => Number.parseInt(part, 10));
const olderThan = (version, [major, minor]) => {
  const [first, second = 0] = numbers(version);
  return first < major || (first === major && second < minor);
};

function loginRow({ username, loginUid, authentication, privilege }) {
  const signedIn = `Signed in as ${username} (UID ${loginUid}) with ${authentication === "agent" ? "the local SSH agent" : "a password"}`;
  return privilege === "root"
    ? row("login", "pass", `${signedIn}.`)
    : row("login", "fail", `${signedIn}; commands run through sudo -n. Only the self-hosted model setup accepts this session.`, ROOT_ONLY_FLOWS);
}

function osRow({ os, kernel }) {
  if (os === null) return row("os", "warn", "Docker did not report the operating system. Relmio is tested on Ubuntu 24.04.");
  const system = kernel === null ? os : `${os}, kernel ${kernel}`;
  return /^Ubuntu 24\.04(?:\.\d+)?(?: LTS)?$/u.test(os)
    ? row("os", "pass", `${system}.`)
    : row("os", "warn", `${system}. Relmio is untested on this system; it is tested on Ubuntu 24.04.`);
}

function cpuRows({ arch }) {
  if (arch === null) return [];
  if (arch === "x86_64" || arch === "amd64") return [row("cpu", "pass", "x86_64 CPU.")];
  if (arch === "aarch64" || arch === "arm64") return [row("cpu", "warn", "arm64 CPU (aarch64). Relmio is untested on arm64 servers.")];
  return [
    row("cpu", "fail", `${arch} CPU. Grok, Claude and the self-hosted model run only on x86_64 or arm64.`, PINNED_CPU_FLOWS),
    row("cpu-untested", "warn", `${arch} CPU. The ChatGPT bridge and the Assistant are untested on it and may not build or start.`, UNPINNED_CPU_FLOWS),
  ];
}

function versionRows({ dockerVersion, composeVersion, buildxVersion }) {
  const rows = [];
  if (dockerVersion !== null) {
    rows.push(numbers(dockerVersion)[0] < TESTED_DOCKER_MAJOR
      ? row("docker", "warn", `Docker Engine ${dockerVersion}. Relmio is untested on Docker Engine older than ${TESTED_DOCKER_MAJOR}.`)
      : row("docker", "pass", `Docker Engine ${dockerVersion}.`));
  }
  if (composeVersion !== null) {
    rows.push(olderThan(composeVersion, TESTED_COMPOSE)
      ? row("compose", "warn", `Docker Compose ${composeVersion}. Relmio is untested on Compose older than ${TESTED_COMPOSE.join(".")}.`)
      : row("compose", "pass", `Docker Compose ${composeVersion}.`));
  }
  if (typeof buildxVersion === "string") rows.push(row("buildx", "pass", `Buildx ${buildxVersion}.`));
  else if (buildxVersion === null) {
    rows.push(row("buildx", "warn", "Docker did not report a usable Buildx plugin. Compose can still build images. If a build fails, check the Buildx installation.", BUILD_FLOWS));
  }
  return rows;
}

function resourceRows({ memoryBytes, cpus }) {
  const parts = [
    ...(cpus === null ? [] : [`${cpus} ${cpus === 1 ? "CPU" : "CPUs"}`]),
    ...(memoryBytes === null ? [] : [`${(memoryBytes / 1024 ** 3).toFixed(1)} GB memory`]),
  ];
  if (parts.length === 0) return [];
  const small = (cpus !== null && cpus < 2) || (memoryBytes !== null && memoryBytes < SMALL_MEMORY_BYTES);
  return [small
    ? row("resources", "warn", `${parts.join(", ")}. This is a small server: image builds and first starts may be slow or fail.`)
    : row("resources", "pass", `${parts.join(", ")}.`)];
}

function securityRows({ security }) {
  if (security === null) return [];
  return [
    row("security", "pass", security.length === 0
      ? "Docker reported no security options."
      : `Docker security options: ${security.slice(0, 6).join(", ")}${security.length > 6 ? ", and more" : ""}.`),
    ...(security.includes("selinux") ? [row("security-selinux", "warn",
      "Docker runs with SELinux. The ChatGPT bridge, the Assistant's web search and Claude each mount a server folder, and SELinux may block that.", BIND_MOUNT_FLOWS)] : []),
    ...(security.includes("userns") ? [row("security-userns", "warn",
      "Docker remaps container users (userns-remap). File owners inside Relmio's containers will not match the server's, so setup may fail.")] : []),
  ];
}

function n8nRows(discovery, containerName) {
  if (!Array.isArray(discovery?.containers)) return [];
  const { containers } = discovery;
  if (containers.length === 0) {
    return [row("n8n", "warn", typeof discovery.noneFoundMessage === "string" && discovery.noneFoundMessage.length <= 240
      ? discovery.noneFoundMessage : "No running n8n container was found on this server.")];
  }
  const shown = containers.find(container => container.name === containerName) ??
    (containers.length === 1 ? containers[0] : null);
  if (!shown) return [row("n8n", "pass", `Found ${containers.length} running n8n containers.`)];
  // The image name is Docker's own text: show it only when it is short and plain.
  const image = typeof shown.image === "string" && /^[\x21-\x7e]{1,80}$/u.test(shown.image) ? ` (${shown.image})` : "";
  return [row("n8n", "pass", `Found n8n container ${shown.name}${image}.`)];
}

function networkRows(networks, networkName) {
  if (networkName === null || !Array.isArray(networks?.networks) || !networks.networks.includes(networkName)) return [];
  const support = networks.support?.[networkName];
  if (support?.supported === false && typeof support.message === "string") {
    return support.reason === "internal"
      ? [
        row("network", "fail", support.message, OUTBOUND_FLOWS),
        row("network-search", "warn", "The selected network is internal. The Assistant's optional web search cannot reach the internet from it.", ["assistant"]),
      ]
      : [row("network", "fail", support.message)];
  }
  const count = networks.networks.length;
  return [row("network", "pass", count > 1
    ? `n8n is on ${count} Docker networks; ${networkName} is selected.`
    : `Network ${networkName} is selected.`)];
}

export function buildVpsHostReport({ identity, host = null, discovery = null, networks, containerName = null, networkName = null }) {
  return {
    host,
    rows: [
      loginRow(identity),
      ...(host === null ? [] : [osRow(host), ...cpuRows(host), ...versionRows(host), ...resourceRows(host), ...securityRows(host)]),
      ...n8nRows(discovery, containerName),
      ...networkRows(networks, networkName),
    ],
  };
}

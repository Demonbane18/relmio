import { randomBytes as createRandomBytes, randomUUID } from "node:crypto";
import * as defaultFileSystem from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import {
  createAssistantInstallation,
  getAssistantContainerNames,
  getAssistantManagedResourceNames,
  getAssistantServiceNames,
  validateAssistantInstallation,
} from "../domain/assistant.js";
import {
  ASSISTANT_COMPANION_IMAGES,
  createAssistantComposeFile,
  createAssistantEnv,
  createAssistantSecrets,
  createSearxngSettings,
} from "../domain/assistant-templates.js";
import {
  LOCAL_N8N_ASSISTANT_TARGET,
  normalizeLocalN8nAssistantPlan,
} from "../domain/local-n8n-assistant.js";
import {
  runLocalProcess,
  validateLocalDockerHost,
} from "../infrastructure/local-process.js";
import { discoverLocalN8nSidecarTargets } from "./local-n8n-sidecar-installer.js";

const COMPOSE_FILENAME = "docker-compose.yml";
const MANAGED_MARKER = ".managed-by-relmio.json";
const ROOT_MARKER = ".managed-by-relmio-root.json";
const MARKER_SCHEMA_VERSION = 1;
const ROOT_MARKER_SCHEMA_VERSION = 1;
const MAX_DOCKER_METADATA_BYTES = 1024 * 1024;
const DOCKER_SELECTION_VARIABLES = new Set([
  "BUILDKIT_HOST",
  "DOCKER_CERT_PATH",
  "DOCKER_CONFIG",
  "DOCKER_CONTEXT",
  "DOCKER_HOST",
  "DOCKER_TLS_VERIFY",
]);

function isMissing(error) {
  return error?.code === "ENOENT";
}

function assertSupportedPlatform(platform) {
  if (platform === "win32") {
    throw new Error(
      "Local n8n Assistant companions are not supported on native Windows in this release.",
    );
  }
}

function rejectDockerEnvironmentOverrides(env) {
  if (!env || typeof env !== "object" || Array.isArray(env)) {
    throw new TypeError("The local process environment is invalid.");
  }
  for (const [name, value] of Object.entries(env)) {
    if (
      DOCKER_SELECTION_VARIABLES.has(name.toUpperCase()) &&
      typeof value === "string" &&
      value !== ""
    ) {
      throw new Error(
        "Relmio local companions require the selected Docker context without a Docker environment override.",
      );
    }
  }
}

function validateAbsolutePath(value) {
  if (
    typeof value !== "string" ||
    value.trim() === "" ||
    value.includes("\0") ||
    !isAbsolute(value)
  ) {
    throw new TypeError("Relmio local storage path is invalid.");
  }
  return resolve(value);
}

function validateManagedBase(value) {
  const resolved = validateAbsolutePath(value);
  if (basename(resolved) !== ".relmio") {
    throw new TypeError("Relmio local storage path is invalid.");
  }
  return resolved;
}

function validateInstallRoot(value) {
  const resolved = validateAbsolutePath(value);
  if (
    basename(resolved) !== LOCAL_N8N_ASSISTANT_TARGET ||
    basename(dirname(resolved)) !== "local" ||
    basename(resolve(resolved, "..", "..")) !== ".relmio"
  ) {
    throw new TypeError("The local n8n Assistant install directory is invalid.");
  }
  return resolved;
}

export async function resolveLocalN8nAssistantInstallRoot({
  env = process.env,
  homeDirectory = homedir(),
  fileSystem = defaultFileSystem,
  platform = process.platform,
} = {}) {
  assertSupportedPlatform(platform);
  const configuredHome =
    typeof env.RELMIO_HOME === "string" && env.RELMIO_HOME.trim() !== ""
      ? env.RELMIO_HOME
      : resolve(homeDirectory, ".relmio");
  const requestedHome = validateManagedBase(configuredHome);
  const requestedParent = dirname(requestedHome);
  let canonicalParent;
  try {
    canonicalParent = await fileSystem.realpath(requestedParent);
  } catch {
    throw new Error("The parent of the Relmio local storage directory is invalid.");
  }
  if (canonicalParent !== resolve(requestedParent)) {
    throw new Error(
      "Relmio refuses a local storage path with a symbolic-link ancestor.",
    );
  }
  return join(
    canonicalParent,
    ".relmio",
    "local",
    LOCAL_N8N_ASSISTANT_TARGET,
  );
}

async function lstatIfExists(fileSystem, path) {
  try {
    return await fileSystem.lstat(path);
  } catch (error) {
    if (isMissing(error)) return null;
    throw new Error("Relmio could not inspect its local managed directory.");
  }
}

function assertDirectory(metadata) {
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new Error("Relmio refuses an unsafe local managed directory.");
  }
}

async function ensurePrivateDirectory(fileSystem, path) {
  const metadata = await lstatIfExists(fileSystem, path);
  if (metadata) {
    assertDirectory(metadata);
  } else {
    await fileSystem.mkdir(path, { mode: 0o700 });
  }
  await fileSystem.chmod(path, 0o700);
}

async function writeManagedFile(fileSystem, path, contents, mode) {
  const existing = await lstatIfExists(fileSystem, path);
  if (existing && (existing.isSymbolicLink() || !existing.isFile())) {
    throw new Error("Relmio refuses to replace a non-file in its managed directory.");
  }
  const temporaryPath = `${path}.tmp-${randomUUID()}`;
  try {
    await fileSystem.writeFile(temporaryPath, contents, { flag: "wx", mode });
    await fileSystem.chmod(temporaryPath, mode);
    await fileSystem.rename(temporaryPath, path);
    await fileSystem.chmod(path, mode);
  } catch {
    try {
      await fileSystem.unlink(temporaryPath);
    } catch {
      // The temporary file may not have been created.
    }
    throw new Error("Relmio could not write its local n8n Assistant files.");
  }
}

function validateMarker(marker) {
  if (
    marker?.schemaVersion !== MARKER_SCHEMA_VERSION ||
    marker?.kind !== "relmio-local-n8n-assistant" ||
    marker?.target !== LOCAL_N8N_ASSISTANT_TARGET
  ) {
    throw new TypeError("The local n8n Assistant marker is invalid.");
  }
  const plan = normalizeLocalN8nAssistantPlan(marker.plan);
  const installation = validateAssistantInstallation(marker.installation);
  validateLocalDockerHost(plan.dockerHost);
  return { plan, installation };
}

async function inspectManagedInstall({ fileSystem, installRoot }) {
  const relmioHome = resolve(installRoot, "..", "..");
  const localRoot = join(relmioHome, "local");
  const homeMetadata = await lstatIfExists(fileSystem, relmioHome);
  if (!homeMetadata) return { baseExists: false, marker: null };
  assertDirectory(homeMetadata);

  const rootMarkerPath = join(relmioHome, ROOT_MARKER);
  const rootMarkerMetadata = await lstatIfExists(fileSystem, rootMarkerPath);
  if (
    !rootMarkerMetadata ||
    rootMarkerMetadata.isSymbolicLink() ||
    !rootMarkerMetadata.isFile()
  ) {
    throw new Error(
      "The Relmio local storage directory is not an owned managed root. Nothing was changed.",
    );
  }
  try {
    const rootMarker = JSON.parse(
      await fileSystem.readFile(rootMarkerPath, "utf8"),
    );
    if (
      rootMarker?.schemaVersion !== ROOT_MARKER_SCHEMA_VERSION ||
      rootMarker?.kind !== "relmio-local-root"
    ) {
      throw new TypeError();
    }
  } catch {
    throw new Error("The Relmio local managed-root marker is invalid.");
  }

  for (const path of [localRoot, installRoot]) {
    const metadata = await lstatIfExists(fileSystem, path);
    if (metadata) assertDirectory(metadata);
  }
  const installMetadata = await lstatIfExists(fileSystem, installRoot);
  if (!installMetadata) return { baseExists: true, marker: null };

  const markerPath = join(installRoot, MANAGED_MARKER);
  const markerMetadata = await lstatIfExists(fileSystem, markerPath);
  if (
    !markerMetadata ||
    markerMetadata.isSymbolicLink() ||
    !markerMetadata.isFile()
  ) {
    throw new Error(
      "The local n8n Assistant directory is unmanaged. Nothing was overwritten.",
    );
  }
  try {
    const marker = JSON.parse(await fileSystem.readFile(markerPath, "utf8"));
    validateMarker(marker);
    return { baseExists: true, marker };
  } catch {
    throw new Error("The local n8n Assistant managed marker is invalid.");
  }
}

async function initializeManagedDirectories({
  fileSystem,
  installRoot,
  baseExists,
}) {
  const relmioHome = resolve(installRoot, "..", "..");
  if (!baseExists) {
    await fileSystem.mkdir(relmioHome, { mode: 0o700 });
    await writeManagedFile(
      fileSystem,
      join(relmioHome, ROOT_MARKER),
      `${JSON.stringify({
        schemaVersion: ROOT_MARKER_SCHEMA_VERSION,
        kind: "relmio-local-root",
      })}\n`,
      0o600,
    );
  }
  await fileSystem.chmod(relmioHome, 0o700);
  await ensurePrivateDirectory(fileSystem, join(relmioHome, "local"));
  await ensurePrivateDirectory(fileSystem, installRoot);
}

async function acquireAssistantLock({ fileSystem, installRoot }) {
  const safeInstallRoot = validateInstallRoot(installRoot);
  const lockPath = join(
    dirname(resolve(safeInstallRoot, "..", "..")),
    ".relmio-local-n8n-ai-assistant.lock",
  );
  const ownerPath = join(lockPath, "owner.json");
  const ownerToken = randomUUID();
  try {
    await fileSystem.mkdir(lockPath, { mode: 0o700 });
    await fileSystem.writeFile(
      ownerPath,
      `${JSON.stringify({ processId: process.pid, ownerToken })}\n`,
      { flag: "wx", mode: 0o600 },
    );
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new Error("Another Relmio process is changing these local companions.");
    }
    throw new Error("Relmio could not create its local companion lock.");
  }
  return async () => {
    try {
      const owner = JSON.parse(await fileSystem.readFile(ownerPath, "utf8"));
      if (owner?.ownerToken === ownerToken) {
        await fileSystem.rm(lockPath, { recursive: true, force: true });
      }
    } catch {
      // Lock cleanup must not hide the completed operation.
    }
  };
}

async function runOrThrow(runProcess, spec, label) {
  const result = await runProcess(spec);
  if (result.code !== 0) throw new Error(`${label} failed.`);
  return result;
}

function parseJson(value, label) {
  if (
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value) > MAX_DOCKER_METADATA_BYTES
  ) {
    throw new Error(`${label} returned invalid Docker metadata.`);
  }
  try {
    return JSON.parse(value);
  } catch {
    throw new Error(`${label} returned invalid Docker metadata.`);
  }
}

function parseJsonRecords(value, label) {
  if (
    typeof value !== "string" ||
    Buffer.byteLength(value) > MAX_DOCKER_METADATA_BYTES
  ) {
    throw new Error(`${label} returned invalid Docker metadata.`);
  }
  if (value.trim() === "") return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    return value.trim().split("\n").map((line) => parseJson(line, label));
  }
}

function parseLabels(value) {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value;
  }
  if (typeof value !== "string") return null;
  const labels = {};
  for (const entry of value.split(",")) {
    const separator = entry.indexOf("=");
    if (separator <= 0) continue;
    labels[entry.slice(0, separator)] = entry.slice(separator + 1);
  }
  return labels;
}

function createComposeArgs(projectName, tail) {
  return [
    "compose",
    "--project-name",
    projectName,
    "--file",
    COMPOSE_FILENAME,
    ...tail,
  ];
}

async function attestReviewedTarget({
  plan,
  runProcess,
  cwd,
  env,
  platform,
}) {
  const discovery = await discoverLocalN8nSidecarTargets({
    runProcess,
    cwd,
    env,
    platform,
  });
  if (discovery.dockerHost !== plan.dockerHost) {
    throw new Error(
      "The selected Docker context changed. Review a fresh n8n Assistant plan.",
    );
  }
  const container = discovery.containers.find(
    (candidate) =>
      candidate.containerId === plan.n8nContainerId &&
      candidate.containerName === plan.n8nContainerName,
  );
  const network = container?.networks.find(
    (candidate) =>
      candidate.dockerNetworkId === plan.dockerNetworkId &&
      candidate.networkName === plan.networkName,
  );
  if (!container || !network) {
    throw new Error(
      "The selected n8n container or Docker network changed. Review a fresh plan.",
    );
  }
}

async function inspectSelectedNetwork({ plan, runProcess, cwd }) {
  const result = await runOrThrow(
    runProcess,
    {
      file: "docker",
      args: [
        "network",
        "inspect",
        "--format",
        "{{json .}}",
        plan.networkName,
      ],
      cwd,
      dockerHost: plan.dockerHost,
    },
    "Selected n8n network inspection",
  );
  return parseJson(result.stdout.trim(), "Selected n8n network inspection");
}

async function attestAliasesAreFree({
  plan,
  installation,
  runProcess,
  cwd,
}) {
  const network = await inspectSelectedNetwork({ plan, runProcess, cwd });
  if (network?.Id !== plan.dockerNetworkId || network?.Name !== plan.networkName) {
    throw new Error(
      "The selected n8n Docker network changed. Review a fresh plan.",
    );
  }
  const reserved = new Set([
    installation.sandboxAlias,
    ...(installation.includeSearxng ? [installation.searxngAlias] : []),
  ]);
  const endpoints = network?.Containers;
  if (!endpoints || typeof endpoints !== "object" || Array.isArray(endpoints)) {
    throw new Error("The selected n8n Docker network metadata is invalid.");
  }
  for (const endpoint of Object.values(endpoints)) {
    const names = [
      endpoint?.Name,
      ...(Array.isArray(endpoint?.Aliases) ? endpoint.Aliases : []),
    ];
    if (names.some((name) => typeof name === "string" && reserved.has(name))) {
      throw new Error(
        "A generated n8n Assistant network alias has a collision. Nothing was changed.",
      );
    }
  }
}

async function listDockerResources({
  kind,
  filter,
  runProcess,
  cwd,
  dockerHost,
}) {
  const args = kind === "container"
    ? ["container", "ls", "-a", "--filter", filter, "--format", "{{json .}}"]
    : [kind, "ls", "--filter", filter, "--format", "{{json .}}"];
  const result = await runOrThrow(
    runProcess,
    { file: "docker", args, cwd, dockerHost },
    `Docker ${kind} ownership inspection`,
  );
  return parseJsonRecords(result.stdout, `Docker ${kind} ownership inspection`);
}

async function attestNoResourceCollisions({
  installation,
  runProcess,
  cwd,
  dockerHost,
}) {
  const names = getAssistantManagedResourceNames(installation);
  for (const name of names.containers) {
    const records = await listDockerResources({
      kind: "container",
      filter: `name=^/${name}$`,
      runProcess,
      cwd,
      dockerHost,
    });
    if (records.length !== 0) {
      throw new Error("A Docker container uses the generated companion identity.");
    }
  }
  for (const [kind, name] of [
    ["network", names.network],
    ["volume", names.volume],
  ]) {
    const records = await listDockerResources({
      kind,
      filter: `name=^${name}$`,
      runProcess,
      cwd,
      dockerHost,
    });
    if (records.length !== 0) {
      throw new Error(`A Docker ${kind} uses the generated companion identity.`);
    }
  }
  for (const kind of ["container", "network", "volume"]) {
    const records = await listDockerResources({
      kind,
      filter: `label=com.docker.compose.project=${installation.projectName}`,
      runProcess,
      cwd,
      dockerHost,
    });
    if (records.length !== 0) {
      throw new Error("A Docker resource uses the generated companion project identity.");
    }
  }
}

function requireOwnedLabels(record, installation) {
  const labels = parseLabels(record?.Labels);
  if (
    !labels ||
    labels["com.docker.compose.project"] !== installation.projectName ||
    labels["io.relmio.ai-assistant.managed"] !== "true" ||
    labels["io.relmio.ai-assistant.install-id"] !== installation.installId
  ) {
    throw new Error(
      "A local companion Docker resource does not have matching Relmio ownership.",
    );
  }
}

async function inspectOwnedProject({
  installation,
  runProcess,
  cwd,
  dockerHost,
  allowAbsent = false,
  allowPartial = false,
}) {
  const expectedNames = getAssistantManagedResourceNames(installation);
  const resources = {
    containers: await listDockerResources({
      kind: "container",
      filter: `label=com.docker.compose.project=${installation.projectName}`,
      runProcess,
      cwd,
      dockerHost,
    }),
    networks: await listDockerResources({
      kind: "network",
      filter: `label=com.docker.compose.project=${installation.projectName}`,
      runProcess,
      cwd,
      dockerHost,
    }),
    volumes: await listDockerResources({
      kind: "volume",
      filter: `label=com.docker.compose.project=${installation.projectName}`,
      runProcess,
      cwd,
      dockerHost,
    }),
  };
  const count = Object.values(resources).reduce(
    (total, records) => total + records.length,
    0,
  );
  if (count === 0) {
    if (allowAbsent) return false;
    throw new Error("The local companion Docker resource set is incomplete.");
  }
  for (const record of [
    ...resources.containers,
    ...resources.networks,
    ...resources.volumes,
  ]) {
    requireOwnedLabels(record, installation);
  }
  const containerNames = new Set(resources.containers.map((record) => record.Names));
  const exactResourceSet =
    resources.containers.length === expectedNames.containers.length &&
    resources.networks.length === 1 &&
    resources.volumes.length === 1 &&
    expectedNames.containers.every((name) => containerNames.has(name)) &&
    resources.networks[0]?.Name === expectedNames.network &&
    resources.volumes[0]?.Name === expectedNames.volume;
  if (!allowPartial && !exactResourceSet) {
    throw new Error("The local companion Docker resource set is incomplete.");
  }
  if (
    containerNames.size !== resources.containers.length ||
    [...containerNames].some((name) => !expectedNames.containers.includes(name)) ||
    resources.networks.length > 1 ||
    resources.networks.some((record) => record.Name !== expectedNames.network) ||
    resources.volumes.length > 1 ||
    resources.volumes.some((record) => record.Name !== expectedNames.volume)
  ) {
    throw new Error("The local companion Docker resource identity is invalid.");
  }
  return true;
}

function assertNoPublishedPorts(records, expectedServices) {
  if (
    records.length !== expectedServices.length ||
    new Set(records.map((record) => record?.Service)).size !== records.length ||
    expectedServices.some(
      (service) => !records.some((record) => record?.Service === service),
    )
  ) {
    throw new Error(
      "The local companion host-publication service set is invalid.",
    );
  }
  for (const record of records) {
    const publishers = record?.Publishers;
    if (!Array.isArray(publishers)) {
      throw new Error("The local companion published-port metadata is invalid.");
    }
    for (const publisher of publishers) {
      if (
        !publisher ||
        !Number.isInteger(publisher.PublishedPort) ||
        typeof publisher.URL !== "string" ||
        publisher.PublishedPort < 0
      ) {
        throw new Error("The local companion published-port metadata is invalid.");
      }
      if (publisher.PublishedPort > 0 || publisher.URL !== "") {
        throw new Error("A local companion published a host port.");
      }
    }
  }
}

async function verifyRunningCompanions({
  plan,
  installation,
  runProcess,
  installRoot,
}) {
  await inspectOwnedProject({
    installation,
    runProcess,
    cwd: installRoot,
    dockerHost: plan.dockerHost,
  });
  const expectedServices = getAssistantServiceNames(installation).filter(
    (service) => service !== "relmio-sandbox-certs",
  );
  const running = await runOrThrow(
    runProcess,
    {
      file: "docker",
      args: createComposeArgs(installation.projectName, [
        "ps",
        "--status",
        "running",
        "--services",
      ]),
      cwd: installRoot,
      dockerHost: plan.dockerHost,
    },
    "Local companion running-service verification",
  );
  const runningServices = running.stdout.trim() === ""
    ? []
    : running.stdout.trim().split("\n").sort();
  if (
    runningServices.length !== expectedServices.length ||
    expectedServices.some((service) => !runningServices.includes(service))
  ) {
    throw new Error("The local companion service set is not running.");
  }
  const publication = await runOrThrow(
    runProcess,
    {
      file: "docker",
      args: createComposeArgs(installation.projectName, ["ps", "--format", "json"]),
      cwd: installRoot,
      dockerHost: plan.dockerHost,
    },
    "Local companion host-publication verification",
  );
  assertNoPublishedPorts(
    parseJsonRecords(publication.stdout, "Local companion host-publication verification"),
    expectedServices,
  );
  await runOrThrow(
    runProcess,
    {
      file: "docker",
      args: createComposeArgs(installation.projectName, [
        "exec",
        "-T",
        "relmio-sandbox-api",
        "wget",
        "-qO-",
        "http://127.0.0.1:8080/healthz",
      ]),
      cwd: installRoot,
      dockerHost: plan.dockerHost,
    },
    "Local Code Sandbox health verification",
  );
  if (installation.includeSearxng) {
    const search = await runOrThrow(
      runProcess,
      {
        file: "docker",
        args: createComposeArgs(installation.projectName, [
          "exec",
          "-T",
          "relmio-sandbox-api",
          "wget",
          "-qO-",
          `http://${installation.searxngAlias}:8080/search?q=relmio&format=json`,
        ]),
        cwd: installRoot,
        dockerHost: plan.dockerHost,
      },
      "Local SearXNG JSON verification",
    );
    let payload;
    try {
      payload = JSON.parse(search.stdout);
    } catch {
      throw new Error("The local SearXNG service did not return JSON.");
    }
    if (!Array.isArray(payload?.results)) {
      throw new Error("The local SearXNG service returned an invalid result.");
    }
  }
}

async function cleanupCompanionProject({
  installation,
  runProcess,
  installRoot,
  dockerHost,
}) {
  await runOrThrow(
    runProcess,
    {
      file: "docker",
      args: createComposeArgs(installation.projectName, [
        "down",
        "--volumes",
        "--remove-orphans",
      ]),
      cwd: installRoot,
      dockerHost,
    },
    "Local companion cleanup",
  );
  const remains = await inspectOwnedProject({
    installation,
    runProcess,
    cwd: installRoot,
    dockerHost,
    allowAbsent: true,
  });
  if (remains) {
    throw new Error("Relmio could not confirm local companion cleanup.");
  }
}

function createN8nSettings({ installation, secrets }) {
  const sandboxUrl = `http://${installation.sandboxAlias}:8080`;
  const settings = {
    N8N_ENABLED_MODULES: "instance-ai",
    N8N_INSTANCE_AI_SANDBOX_ENABLED: "true",
    N8N_INSTANCE_AI_SANDBOX_PROVIDER: "n8n-sandbox",
    N8N_INSTANCE_AI_SANDBOX_IMAGE: ASSISTANT_COMPANION_IMAGES.sandbox,
    N8N_SANDBOX_SERVICE_URL: sandboxUrl,
    N8N_SANDBOX_SERVICE_API_KEY: secrets.sandboxApiKey,
  };
  if (installation.includeSearxng) {
    settings.N8N_INSTANCE_AI_SEARXNG_URL =
      `http://${installation.searxngAlias}:8080`;
  }
  return settings;
}

export async function installLocalN8nAssistant(
  { plan, confirmed },
  {
    fileSystem = defaultFileSystem,
    env = process.env,
    homeDirectory = homedir(),
    runProcess = runLocalProcess,
    randomBytes = createRandomBytes,
    platform = process.platform,
  } = {},
) {
  if (confirmed !== true) {
    throw new Error(
      "Confirm the reviewed privileged n8n Assistant companion plan before installing.",
    );
  }
  assertSupportedPlatform(platform);
  rejectDockerEnvironmentOverrides(env);
  const normalizedPlan = normalizeLocalN8nAssistantPlan(plan);
  const installRoot = await resolveLocalN8nAssistantInstallRoot({
    env,
    homeDirectory,
    fileSystem,
    platform,
  });
  const releaseLock = await acquireAssistantLock({ fileSystem, installRoot });
  let installation;
  let managedDirectoryCreated = false;
  let deploymentStarted = false;
  try {
    const managed = await inspectManagedInstall({ fileSystem, installRoot });
    if (managed.marker) {
      throw new Error(
        "The managed local n8n Assistant tools are already installed. Remove them before installing a fresh companion stack.",
      );
    }
    const workingDirectory = dirname(resolve(installRoot, "..", ".."));
    await attestReviewedTarget({
      plan: normalizedPlan,
      runProcess,
      cwd: workingDirectory,
      env,
      platform,
    });
    installation = createAssistantInstallation({
      randomBytes,
      includeSearxng: normalizedPlan.includeSearxng,
    });
    const secrets = createAssistantSecrets({
      randomBytes,
      includeSearxng: normalizedPlan.includeSearxng,
    });
    await attestAliasesAreFree({
      plan: normalizedPlan,
      installation,
      runProcess,
      cwd: workingDirectory,
    });
    await attestNoResourceCollisions({
      installation,
      runProcess,
      cwd: workingDirectory,
      dockerHost: normalizedPlan.dockerHost,
    });
    await initializeManagedDirectories({
      fileSystem,
      installRoot,
      baseExists: managed.baseExists,
    });
    managedDirectoryCreated = true;
    await writeManagedFile(
      fileSystem,
      join(installRoot, COMPOSE_FILENAME),
      createAssistantComposeFile({
        networkName: normalizedPlan.networkName,
        installation,
      }),
      0o600,
    );
    await writeManagedFile(
      fileSystem,
      join(installRoot, ".env"),
      createAssistantEnv(secrets, {
        includeSearxng: normalizedPlan.includeSearxng,
      }),
      0o600,
    );
    if (normalizedPlan.includeSearxng) {
      await writeManagedFile(
        fileSystem,
        join(installRoot, "searxng-settings.yml"),
        createSearxngSettings(),
        0o600,
      );
    }
    await writeManagedFile(
      fileSystem,
      join(installRoot, MANAGED_MARKER),
      `${JSON.stringify({
        schemaVersion: MARKER_SCHEMA_VERSION,
        kind: "relmio-local-n8n-assistant",
        target: LOCAL_N8N_ASSISTANT_TARGET,
        plan: normalizedPlan,
        installation,
      })}\n`,
      0o600,
    );
    await runOrThrow(
      runProcess,
      {
        file: "docker",
        args: createComposeArgs(installation.projectName, ["config", "--quiet"]),
        cwd: installRoot,
        dockerHost: normalizedPlan.dockerHost,
      },
      "Local n8n Assistant Compose validation",
    );
    await attestReviewedTarget({
      plan: normalizedPlan,
      runProcess,
      cwd: installRoot,
      env,
      platform,
    });
    await attestAliasesAreFree({
      plan: normalizedPlan,
      installation,
      runProcess,
      cwd: installRoot,
    });
    await attestNoResourceCollisions({
      installation,
      runProcess,
      cwd: installRoot,
      dockerHost: normalizedPlan.dockerHost,
    });

    deploymentStarted = true;
    await runOrThrow(
      runProcess,
      {
        file: "docker",
        args: createComposeArgs(installation.projectName, [
          "up",
          "-d",
          "--wait",
          "--wait-timeout",
          "90",
          ...getAssistantServiceNames(installation),
        ]),
        cwd: installRoot,
        dockerHost: normalizedPlan.dockerHost,
      },
      "Local n8n Assistant companion start",
    );
    await verifyRunningCompanions({
      plan: normalizedPlan,
      installation,
      runProcess,
      installRoot,
    });
    const n8nSettings = createN8nSettings({ installation, secrets });
    return {
      target: LOCAL_N8N_ASSISTANT_TARGET,
      endpoint: n8nSettings.N8N_SANDBOX_SERVICE_URL,
      sandboxUrl: n8nSettings.N8N_SANDBOX_SERVICE_URL,
      sandboxApiKey: secrets.sandboxApiKey,
      ...(installation.includeSearxng
        ? { searxngUrl: n8nSettings.N8N_INSTANCE_AI_SEARXNG_URL }
        : {}),
      protocol: "n8n-instance-ai-companion",
      includeSearxng: installation.includeSearxng,
      networkName: normalizedPlan.networkName,
      n8nContainerName: normalizedPlan.n8nContainerName,
      hostPublication: "none",
      privilegedRunner: true,
      n8nConfigurationRequired: true,
      n8nSettings,
      deploymentMode: "installed",
      credentialShownOnce: true,
    };
  } catch (error) {
    if (deploymentStarted && installation) {
      try {
        const resourcesExist = await inspectOwnedProject({
          installation,
          runProcess,
          cwd: installRoot,
          dockerHost: normalizedPlan.dockerHost,
          allowAbsent: true,
          allowPartial: true,
        });
        if (resourcesExist) {
          await cleanupCompanionProject({
            installation,
            runProcess,
            installRoot,
            dockerHost: normalizedPlan.dockerHost,
          });
        }
      } catch {
        throw new Error(
          "Local companion verification failed and automatic cleanup could not be confirmed. Inspect only the Relmio n8n Assistant project before retrying.",
        );
      }
    }
    if (managedDirectoryCreated) {
      try {
        await fileSystem.rm(installRoot, { recursive: true, force: false });
      } catch {
        throw new Error(
          "Local companion installation failed and managed-file cleanup could not be confirmed.",
        );
      }
    }
    throw error;
  } finally {
    await releaseLock();
  }
}

export async function removeLocalN8nAssistant(
  { confirmed },
  {
    fileSystem = defaultFileSystem,
    env = process.env,
    homeDirectory = homedir(),
    runProcess = runLocalProcess,
    platform = process.platform,
  } = {},
) {
  if (confirmed !== true) {
    throw new Error("Confirm removal of the managed local n8n Assistant tools.");
  }
  assertSupportedPlatform(platform);
  rejectDockerEnvironmentOverrides(env);
  const installRoot = await resolveLocalN8nAssistantInstallRoot({
    env,
    homeDirectory,
    fileSystem,
    platform,
  });
  const releaseLock = await acquireAssistantLock({ fileSystem, installRoot });
  try {
    const managed = await inspectManagedInstall({ fileSystem, installRoot });
    if (!managed.marker) {
      throw new Error("The managed local n8n Assistant tools are not installed.");
    }
    const { plan, installation } = validateMarker(managed.marker);
    await inspectOwnedProject({
      installation,
      runProcess,
      cwd: installRoot,
      dockerHost: plan.dockerHost,
    });
    await cleanupCompanionProject({
      installation,
      runProcess,
      installRoot,
      dockerHost: plan.dockerHost,
    });
    await fileSystem.rm(installRoot, { recursive: true, force: false });
    return { target: LOCAL_N8N_ASSISTANT_TARGET, removed: true };
  } finally {
    await releaseLock();
  }
}

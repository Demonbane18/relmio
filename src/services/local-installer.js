import { createHash, randomBytes as createRandomBytes, randomUUID } from "node:crypto";
import * as defaultFileSystem from "node:fs/promises";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

import {
  createCodexComposeFile,
  createCodexConfig,
  createCodexDockerfile,
  createCodexRequirements,
  createLocalDeploymentPlan,
  createLocalDockerignore,
  createOpenAiGatewayComposeFile,
  createOpenAiGatewayDockerfile,
  validateInstallId,
  validateLocalTarget,
  validatePlatformApiKey,
} from "../domain/local-endpoints.js";
import {
  runLocalProcess,
  validateLocalDockerHost,
} from "../infrastructure/local-process.js";

const MANAGED_MARKER = ".managed-by-relmio.json";
const ROOT_MARKER = ".managed-by-relmio-root.json";
const MARKER_SCHEMA_VERSION = 2;
const ROOT_MARKER_SCHEMA_VERSION = 1;
const COMPOSE_FILENAME = "docker-compose.yml";
const PROJECTS = Object.freeze({
  "openai-api": Object.freeze({
    projectPrefix: "relmio-openai-api",
    serviceName: "gateway",
    containerPort: 10_531,
  }),
  "codex-chatgpt": Object.freeze({
    projectPrefix: "relmio-codex-chatgpt",
    serviceName: "codex",
    containerPort: 4_500,
  }),
});
const DOCKER_SELECTION_VARIABLES = Object.freeze([
  "DOCKER_HOST",
  "DOCKER_CONTEXT",
  "DOCKER_CONFIG",
  "DOCKER_TLS_VERIFY",
  "DOCKER_CERT_PATH",
  "BUILDKIT_HOST",
]);

function isMissing(error) {
  return error?.code === "ENOENT";
}

function assertSupportedPlatform(platform) {
  if (platform === "win32") {
    throw new Error(
      "Local Docker endpoints are not supported on native Windows in this release.",
    );
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

function validateInstallDirectory(value, target) {
  const resolved = validateAbsolutePath(value);
  if (
    basename(resolved) !== target ||
    basename(dirname(resolved)) !== "local" ||
    basename(resolve(resolved, "..", "..")) !== ".relmio"
  ) {
    throw new TypeError("The local endpoint install directory is invalid.");
  }
  return resolved;
}

export async function resolveLocalInstallRoot({
  target,
  env = process.env,
  homeDirectory = homedir(),
  fileSystem = defaultFileSystem,
  platform = process.platform,
} = {}) {
  assertSupportedPlatform(platform);
  const safeTarget = validateLocalTarget(target);
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
  const relmioHome = join(canonicalParent, ".relmio");
  return join(relmioHome, "local", safeTarget);
}

async function lstatIfExists(fileSystem, path) {
  try {
    return await fileSystem.lstat(path);
  } catch (error) {
    if (isMissing(error)) {
      return null;
    }
    throw new Error("Relmio could not inspect its local managed directory.");
  }
}

function assertDirectoryMetadata(metadata) {
  if (metadata.isSymbolicLink()) {
    throw new Error("Relmio refuses to use a symbolic link in its managed path.");
  }
  if (!metadata.isDirectory()) {
    throw new Error("Relmio local managed path is not a directory.");
  }
}

async function assertRegularManagedMarker(fileSystem, path, errorMessage) {
  const metadata = await lstatIfExists(fileSystem, path);
  if (!metadata || metadata.isSymbolicLink() || !metadata.isFile()) {
    throw new Error(errorMessage);
  }
}

async function inspectManagedRoot({ fileSystem, relmioHome, installRoot, target }) {
  const localRoot = join(relmioHome, "local");
  const homeMetadata = await lstatIfExists(fileSystem, relmioHome);
  if (!homeMetadata) {
    return {
      baseExists: false,
      deploymentMode: "installed",
      marker: null,
      previousPort: null,
    };
  }
  assertDirectoryMetadata(homeMetadata);

  let rootMarkerContents;
  const rootMarkerPath = join(relmioHome, ROOT_MARKER);
  await assertRegularManagedMarker(
    fileSystem,
    rootMarkerPath,
    "The Relmio local storage directory already exists without a valid managed-root marker. Nothing was changed.",
  );
  try {
    rootMarkerContents = await fileSystem.readFile(rootMarkerPath, "utf8");
  } catch {
    throw new Error(
      "The Relmio local storage directory already exists without a valid managed-root marker. Nothing was changed.",
    );
  }
  try {
    const rootMarker = JSON.parse(rootMarkerContents);
    if (
      rootMarker?.schemaVersion !== ROOT_MARKER_SCHEMA_VERSION ||
      rootMarker?.kind !== "relmio-local-root"
    ) {
      throw new TypeError();
    }
  } catch {
    throw new Error(
      "The Relmio local storage managed-root marker is invalid. Nothing was changed.",
    );
  }

  for (const path of [localRoot, installRoot]) {
    const metadata = await lstatIfExists(fileSystem, path);
    if (metadata) {
      assertDirectoryMetadata(metadata);
    }
  }

  const installMetadata = await lstatIfExists(fileSystem, installRoot);
  if (!installMetadata) {
    return {
      baseExists: true,
      deploymentMode: "installed",
      marker: null,
      previousPort: null,
    };
  }

  let markerContents;
  const markerPath = join(installRoot, MANAGED_MARKER);
  await assertRegularManagedMarker(
    fileSystem,
    markerPath,
    "The local endpoint directory already exists without a Relmio managed marker. Nothing was overwritten.",
  );
  try {
    markerContents = await fileSystem.readFile(markerPath, "utf8");
  } catch (error) {
    if (isMissing(error)) {
      throw new Error(
        "The local endpoint directory already exists without a Relmio managed marker. Nothing was overwritten.",
      );
    }
    throw new Error("Relmio could not read its local managed marker.");
  }

  try {
    const marker = JSON.parse(markerContents);
    const installId = validateInstallId(marker?.installId);
    const dockerHost = validateLocalDockerHost(marker?.dockerHost);
    const projectName = `${PROJECTS[target].projectPrefix}-${installId}`;
    if (
      marker?.schemaVersion !== MARKER_SCHEMA_VERSION ||
      marker?.target !== target ||
      !Number.isInteger(marker?.port) ||
      marker?.projectName !== projectName
    ) {
      throw new TypeError();
    }
    return {
      baseExists: true,
      deploymentMode: "updated",
      marker: {
        schemaVersion: MARKER_SCHEMA_VERSION,
        target,
        port: marker.port,
        dockerHost,
        installId,
        projectName,
      },
      previousPort: marker.port,
    };
  } catch {
    throw new Error("The local endpoint managed marker is invalid. Nothing was overwritten.");
  }
}

async function initializeManagedBase({ fileSystem, relmioHome, baseExists }) {
  if (baseExists) {
    await fileSystem.chmod(relmioHome, 0o700);
    return;
  }
  await fileSystem.mkdir(relmioHome, { mode: 0o700 });
  await fileSystem.chmod(relmioHome, 0o700);
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

async function ensurePrivateDirectory(fileSystem, path) {
  const existing = await lstatIfExists(fileSystem, path);
  if (existing) {
    assertDirectoryMetadata(existing);
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
    throw new Error("Relmio could not write its local managed files.");
  }
}

export function isLoopbackPortAvailable(port) {
  return new Promise((resolvePromise, rejectPromise) => {
    const server = createServer();
    server.unref();
    server.once("error", (error) => {
      if (error?.code === "EADDRINUSE" || error?.code === "EACCES") {
        resolvePromise(false);
      } else {
        rejectPromise(new Error("Relmio could not check the local endpoint port."));
      }
    });
    server.listen(port, "127.0.0.1", () => {
      server.close((error) => {
        if (error) {
          rejectPromise(new Error("Relmio could not finish checking the local port."));
        } else {
          resolvePromise(true);
        }
      });
    });
  });
}

function validateVersion(value, label) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!/^[A-Za-z0-9.+-]{1,64}$/u.test(normalized)) {
    throw new Error(`${label} returned an invalid version.`);
  }
  return normalized;
}

function rejectDockerEnvironmentOverrides(env) {
  for (const name of DOCKER_SELECTION_VARIABLES) {
    if (typeof env[name] === "string" && env[name] !== "") {
      throw new Error(
        "Relmio local endpoints require the selected Docker context without Docker environment overrides.",
      );
    }
  }
}

async function resolveLocalDockerHost({
  runProcess,
  cwd,
  env,
  platform,
}) {
  assertSupportedPlatform(platform);
  rejectDockerEnvironmentOverrides(env);
  const context = await runProcess({
    file: "docker",
    args: [
      "context",
      "inspect",
      "--format",
      "{{json .Endpoints.docker.Host}}",
    ],
    cwd,
  });
  if (context.code !== 0) {
    throw new Error("The selected Docker context could not be inspected.");
  }
  let candidate;
  try {
    candidate = JSON.parse(context.stdout.trim());
  } catch {
    throw new Error("The selected Docker context is not a local Docker daemon.");
  }
  try {
    return validateLocalDockerHost(candidate, { platform });
  } catch {
    throw new Error("The selected Docker context is not a local Docker daemon.");
  }
}

export async function getLocalDockerStatus({
  runProcess = runLocalProcess,
  cwd = process.cwd(),
  env = process.env,
  platform = process.platform,
} = {}) {
  try {
    const dockerHost = await resolveLocalDockerHost({
      runProcess,
      cwd,
      env,
      platform,
    });
    const docker = await runProcess({
      file: "docker",
      args: ["version", "--format", "{{.Server.Version}}"],
      cwd,
      dockerHost,
    });
    if (docker.code !== 0) {
      throw new Error();
    }
    const compose = await runProcess({
      file: "docker",
      args: ["compose", "version", "--short"],
      cwd,
      dockerHost,
    });
    if (compose.code !== 0) {
      throw new Error();
    }
    return {
      dockerAvailable: true,
      dockerVersion: validateVersion(docker.stdout, "Docker"),
      composeVersion: validateVersion(compose.stdout, "Docker Compose"),
      dockerHost,
    };
  } catch {
    return {
      dockerAvailable: false,
      ...(platform === "win32" ? { unsupportedPlatform: true } : {}),
    };
  }
}

export async function restartLocalCodex(
  { installDirectory },
  dependencies = {},
) {
  const runProcess = dependencies.runProcess ?? runLocalProcess;
  const attested = await attestLocalCodexInstallation(
    { installDirectory },
    dependencies,
  );

  await runOrThrow(runProcess, {
    label: "Codex credential reload",
    file: "docker",
    args: createComposeArgs("codex-chatgpt", attested.projectName, [
      "restart",
      "--timeout",
      "10",
      "codex",
    ]),
    cwd: installDirectory,
    dockerHost: attested.dockerHost,
  });
  await runOrThrow(runProcess, {
    label: "Codex readiness wait",
    file: "docker",
    args: createComposeArgs("codex-chatgpt", attested.projectName, [
      "up",
      "-d",
      "--wait",
      "--wait-timeout",
      "90",
      "--no-deps",
      "codex",
    ]),
    cwd: installDirectory,
    dockerHost: attested.dockerHost,
  });
  return { restarted: true };
}

function createProjectName(target, installId) {
  return `${PROJECTS[target].projectPrefix}-${validateInstallId(installId)}`;
}

function createComposeArgs(target, projectName, suffix) {
  if (projectName !== createProjectName(target, projectName.slice(-32))) {
    throw new TypeError("The local Docker project identity is invalid.");
  }
  return [
    "compose",
    "--project-name",
    projectName,
    "--file",
    COMPOSE_FILENAME,
    ...suffix,
  ];
}

function createDeploymentSpecs({
  target,
  installRoot,
  dockerHost,
  projectName,
  apiKey,
}) {
  const project = PROJECTS[target];
  const specs = [
    {
      label: "Local Compose validation",
      file: "docker",
      args: createComposeArgs(target, projectName, ["config", "--quiet"]),
      cwd: installRoot,
      dockerHost,
    },
    {
      label: "Local image build",
      file: "docker",
      args: createComposeArgs(target, projectName, ["build", project.serviceName]),
      cwd: installRoot,
      dockerHost,
    },
  ];
  if (target === "openai-api") {
    specs.push({
      label: "OpenAI Platform credential seed",
      file: "docker",
      args: createComposeArgs(target, projectName, [
        "run",
        "--rm",
        "--no-deps",
        "--no-build",
        "-T",
        "credential-seed",
      ]),
      cwd: installRoot,
      dockerHost,
      input: Buffer.from(validatePlatformApiKey(apiKey), "utf8"),
    });
  }
  specs.push({
    label: "Local endpoint start",
    file: "docker",
    args: createComposeArgs(target, projectName, [
      "up",
      "-d",
      "--wait",
      "--wait-timeout",
      "90",
      "--no-deps",
      project.serviceName,
    ]),
    cwd: installRoot,
    dockerHost,
  });
  return specs;
}

function createVerificationSpecs({ target, installRoot, dockerHost, projectName }) {
  const project = PROJECTS[target];
  return {
    running: {
      label: "Local endpoint status check",
      file: "docker",
      args: createComposeArgs(target, projectName, ["ps", "--status", "running", "--services"]),
      cwd: installRoot,
      dockerHost,
    },
    publication: {
      label: "Local endpoint publication check",
      file: "docker",
      args: createComposeArgs(target, projectName, ["ps", "--format", "json", project.serviceName]),
      cwd: installRoot,
      dockerHost,
    },
  };
}

function createCleanupSpec({ target, installRoot, dockerHost, projectName }) {
  const project = PROJECTS[target];
  return {
    label: "Unsafe local endpoint cleanup",
    file: "docker",
    args: createComposeArgs(target, projectName, [
      "rm",
      "--force",
      "--stop",
      project.serviceName,
    ]),
    cwd: installRoot,
    dockerHost,
  };
}

function createCleanupVerificationSpec({ target, installRoot, dockerHost, projectName }) {
  const project = PROJECTS[target];
  return {
    label: "Local endpoint cleanup verification",
    file: "docker",
    args: createComposeArgs(target, projectName, [
      "ps",
      "--all",
      "--services",
      project.serviceName,
    ]),
    cwd: installRoot,
    dockerHost,
  };
}

function createOwnershipPreflightSpecs({
  target,
  installRoot,
  dockerHost,
  projectName,
}) {
  const format = "{{json .}}";
  const projectFilter = `label=com.docker.compose.project=${projectName}`;
  return [
    {
      resource: "container",
      label: "Local container ownership check",
      file: "docker",
      args: ["ps", "--all", "--filter", projectFilter, "--format", format],
      cwd: installRoot,
      dockerHost,
    },
    {
      resource: "network",
      label: "Local network ownership check",
      file: "docker",
      args: ["network", "ls", "--filter", projectFilter, "--format", format],
      cwd: installRoot,
      dockerHost,
    },
    {
      resource: "volume",
      label: "Local volume ownership check",
      file: "docker",
      args: ["volume", "ls", "--filter", projectFilter, "--format", format],
      cwd: installRoot,
      dockerHost,
    },
  ];
}

function parseDockerLabelSet(value) {
  if (typeof value !== "string" || value.length > 16 * 1024) {
    throw new Error("The local Docker ownership metadata is invalid.");
  }
  return new Set(value.split(",").filter(Boolean));
}

function validateOwnershipOutput(
  output,
  { target, installId, projectName, resource },
) {
  const rows = output.trim() === "" ? [] : output.trim().split("\n");
  for (const row of rows) {
    let parsed;
    try {
      parsed = JSON.parse(row);
    } catch {
      throw new Error("The local Docker ownership metadata is invalid.");
    }
    const labels = parseDockerLabelSet(parsed?.Labels);
    for (const expected of [
      `com.docker.compose.project=${projectName}`,
      "io.relmio.managed=true",
      `io.relmio.target=${target}`,
      `io.relmio.install=${installId}`,
    ]) {
      if (!labels.has(expected)) {
        throw new Error(
          "A Docker resource already uses this Relmio project identity without matching ownership. Nothing was changed.",
        );
      }
    }
    if (
      resource === "container" &&
      !labels.has(`com.docker.compose.service=${PROJECTS[target].serviceName}`)
    ) {
      throw new Error(
        "A Docker resource already uses this Relmio project identity without matching ownership. Nothing was changed.",
      );
    }
  }
}

async function attestDockerOwnership({
  target,
  installRoot,
  dockerHost,
  installId,
  projectName,
  runProcess,
}) {
  for (const spec of createOwnershipPreflightSpecs({
    target,
    installRoot,
    dockerHost,
    projectName,
  })) {
    const result = await runOrThrow(runProcess, spec);
    validateOwnershipOutput(result.stdout, {
      target,
      installId,
      projectName,
      resource: spec.resource,
    });
  }
}

async function runOrThrow(runProcess, spec) {
  const result = await runProcess({
    file: spec.file,
    args: spec.args,
    cwd: spec.cwd,
    ...(spec.dockerHost ? { dockerHost: spec.dockerHost } : {}),
    ...(spec.input !== undefined ? { input: spec.input } : {}),
  });
  if (result.code !== 0) {
    throw new Error(`${spec.label} failed.`);
  }
  return result;
}

function validatePublishedEndpoint(output, { target, port }) {
  let services;
  try {
    const parsed = JSON.parse(output);
    services = Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    throw new Error("The local endpoint publication metadata is invalid.");
  }
  if (services.length !== 1 || !Array.isArray(services[0]?.Publishers)) {
    throw new Error("The local endpoint publication check failed closed.");
  }
  const publishers = services[0].Publishers;
  const expected = PROJECTS[target];
  if (
    publishers.length !== 1 ||
    publishers[0]?.URL !== "127.0.0.1" ||
    publishers[0]?.PublishedPort !== port ||
    publishers[0]?.TargetPort !== expected.containerPort ||
    publishers[0]?.Protocol !== "tcp"
  ) {
    throw new Error(
      "The local endpoint publication is not the exact planned loopback binding.",
    );
  }
}

function parseModelIds(value) {
  if (!Array.isArray(value?.data)) {
    throw new Error("The OpenAI Platform model response could not be verified.");
  }
  const models = value.data
    .map((entry) => entry?.id)
    .filter(
      (id) =>
        typeof id === "string" &&
        id.length > 0 &&
        id.length <= 128 &&
        /^[A-Za-z0-9_.:-]+$/u.test(id),
    );
  if (models.length === 0) {
    throw new Error("The OpenAI Platform model response could not be verified.");
  }
  return models;
}

async function verifyHttpEndpoint({ plan, clientCredential, fetchImpl }) {
  const healthPath = plan.target === "openai-api" ? "/health" : "/readyz";
  const httpEndpoint = `http://127.0.0.1:${plan.port}${healthPath}`;
  let health;
  try {
    health = await fetchImpl(httpEndpoint, {
      method: "GET",
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    throw new Error("The local endpoint did not answer its readiness check.");
  }
  if (!health.ok) {
    throw new Error("The local endpoint did not pass its readiness check.");
  }

  if (plan.target !== "openai-api") {
    return [];
  }

  let response;
  try {
    response = await fetchImpl(`http://127.0.0.1:${plan.port}/v1/models`, {
      method: "GET",
      headers: { Authorization: `Bearer ${clientCredential}` },
      signal: AbortSignal.timeout(15_000),
    });
  } catch {
    throw new Error("The OpenAI Platform credential could not be verified.");
  }
  if (!response.ok) {
    throw new Error("The OpenAI Platform credential could not be verified.");
  }
  try {
    return parseModelIds(await response.json());
  } catch (error) {
    if (error?.message?.includes("model response")) {
      throw error;
    }
    throw new Error("The OpenAI Platform model response could not be verified.");
  }
}

async function defaultReadGatewaySource() {
  return defaultFileSystem.readFile(
    new URL("../gateway/openai.js", import.meta.url),
    "utf8",
  );
}

export async function attestLocalCodexInstallation(
  { installDirectory },
  {
    fileSystem = defaultFileSystem,
    runProcess = runLocalProcess,
    platform = process.platform,
  } = {},
) {
  assertSupportedPlatform(platform);
  const safeDirectory = validateInstallDirectory(
    installDirectory,
    "codex-chatgpt",
  );
  const relmioHome = resolve(safeDirectory, "..", "..");
  const managed = await inspectManagedRoot({
    fileSystem,
    relmioHome,
    installRoot: safeDirectory,
    target: "codex-chatgpt",
  });
  if (managed.deploymentMode !== "updated" || !managed.marker) {
    throw new Error("Install the local Codex endpoint before signing in.");
  }
  await attestDockerOwnership({
    target: "codex-chatgpt",
    installRoot: safeDirectory,
    dockerHost: managed.marker.dockerHost,
    installId: managed.marker.installId,
    projectName: managed.marker.projectName,
    runProcess,
  });
  const verification = createVerificationSpecs({
    target: "codex-chatgpt",
    installRoot: safeDirectory,
    dockerHost: managed.marker.dockerHost,
    projectName: managed.marker.projectName,
  });
  const running = await runOrThrow(runProcess, verification.running);
  if (!running.stdout.split(/\s+/u).includes("codex")) {
    throw new Error("The managed local Codex endpoint is not running.");
  }
  const publication = await runOrThrow(runProcess, verification.publication);
  validatePublishedEndpoint(publication.stdout, {
    target: "codex-chatgpt",
    port: managed.marker.port,
  });
  return {
    dockerHost: managed.marker.dockerHost,
    projectName: managed.marker.projectName,
  };
}

export async function installLocalEndpoint(
  { plan, apiKey, confirmed },
  {
    fileSystem = defaultFileSystem,
    env = process.env,
    homeDirectory = homedir(),
    runProcess = runLocalProcess,
    randomBytes = createRandomBytes,
    isPortAvailable = isLoopbackPortAvailable,
    readGatewaySource = defaultReadGatewaySource,
    fetchImpl = fetch,
    platform = process.platform,
  } = {},
) {
  if (confirmed !== true) {
    throw new Error("Confirm the reviewed local endpoint plan before installing.");
  }
  assertSupportedPlatform(platform);
  rejectDockerEnvironmentOverrides(env);

  const normalizedPlan = createLocalDeploymentPlan({
    target: plan?.target,
    port: plan?.port,
    allowedOrigins: plan?.allowedOrigins,
  });
  const safeApiKey =
    normalizedPlan.target === "openai-api"
      ? validatePlatformApiKey(apiKey)
      : null;
  const installRoot = await resolveLocalInstallRoot({
    target: normalizedPlan.target,
    env,
    homeDirectory,
    fileSystem,
    platform,
  });
  const relmioHome = resolve(installRoot, "..", "..");
  const managed = await inspectManagedRoot({
    fileSystem,
    relmioHome,
    installRoot,
    target: normalizedPlan.target,
  });
  const dockerHost = managed.marker?.dockerHost ??
    (await resolveLocalDockerHost({
      runProcess,
      cwd: dirname(relmioHome),
      env,
      platform,
    }));
  const installIdBytes = managed.marker ? null : randomBytes(32);
  if (
    installIdBytes !== null &&
    (!Buffer.isBuffer(installIdBytes) || installIdBytes.length !== 32)
  ) {
    throw new Error("Relmio could not generate a strong installation identity.");
  }
  const installId = managed.marker?.installId ??
    installIdBytes.subarray(0, 16).toString("hex");
  validateInstallId(installId);
  const projectName = createProjectName(normalizedPlan.target, installId);
  await attestDockerOwnership({
    target: normalizedPlan.target,
    installRoot: managed.marker ? installRoot : dirname(relmioHome),
    dockerHost,
    installId,
    projectName,
    runProcess,
  });

  if (
    managed.previousPort !== normalizedPlan.port &&
    !(await isPortAvailable(normalizedPlan.port))
  ) {
    throw new Error("The selected local endpoint port is already in use.");
  }

  const capabilityBytes = randomBytes(32);
  if (!Buffer.isBuffer(capabilityBytes) || capabilityBytes.length !== 32) {
    throw new Error("Relmio could not generate a strong local capability.");
  }
  const clientCredential = capabilityBytes.toString("base64url");
  const tokenSha256 = createHash("sha256")
    .update(clientCredential)
    .digest("hex");

  await initializeManagedBase({
    fileSystem,
    relmioHome,
    baseExists: managed.baseExists,
  });
  await ensurePrivateDirectory(fileSystem, join(relmioHome, "local"));
  await ensurePrivateDirectory(fileSystem, installRoot);

  let dockerfile;
  let composeFile;
  if (normalizedPlan.target === "openai-api") {
    const gatewaySource = await readGatewaySource();
    if (
      typeof gatewaySource !== "string" ||
      gatewaySource.length === 0 ||
      gatewaySource.length > 512 * 1024
    ) {
      throw new Error("The packaged local gateway runtime is invalid.");
    }
    dockerfile = createOpenAiGatewayDockerfile();
    composeFile = createOpenAiGatewayComposeFile({
      port: normalizedPlan.port,
      tokenSha256,
      allowedOrigins: normalizedPlan.allowedOrigins,
      installId,
    });
    await writeManagedFile(
      fileSystem,
      join(installRoot, "gateway.mjs"),
      gatewaySource,
      0o600,
    );
  } else {
    dockerfile = createCodexDockerfile();
    composeFile = createCodexComposeFile({
      port: normalizedPlan.port,
      tokenSha256,
      installId,
    });
    await writeManagedFile(
      fileSystem,
      join(installRoot, "config.toml"),
      createCodexConfig(),
      0o600,
    );
    await writeManagedFile(
      fileSystem,
      join(installRoot, "requirements.toml"),
      createCodexRequirements(),
      0o600,
    );
  }

  await writeManagedFile(
    fileSystem,
    join(installRoot, "Dockerfile"),
    dockerfile,
    0o600,
  );
  await writeManagedFile(
    fileSystem,
    join(installRoot, ".dockerignore"),
    createLocalDockerignore(normalizedPlan.target),
    0o600,
  );
  await writeManagedFile(
    fileSystem,
    join(installRoot, COMPOSE_FILENAME),
    composeFile,
    0o600,
  );
  await writeManagedFile(
    fileSystem,
    join(installRoot, MANAGED_MARKER),
    `${JSON.stringify({
      schemaVersion: MARKER_SCHEMA_VERSION,
      target: normalizedPlan.target,
      port: normalizedPlan.port,
      dockerHost,
      installId,
      projectName,
    })}\n`,
    0o600,
  );

  let deploymentStarted = false;
  let models;
  try {
    for (const spec of createDeploymentSpecs({
      target: normalizedPlan.target,
      installRoot,
      dockerHost,
      projectName,
      apiKey: safeApiKey,
    })) {
      if (spec.args.includes("up")) {
        deploymentStarted = true;
      }
      await runOrThrow(runProcess, spec);
    }
    const verification = createVerificationSpecs({
      target: normalizedPlan.target,
      installRoot,
      dockerHost,
      projectName,
    });
    const running = await runOrThrow(runProcess, verification.running);
    if (
      !running.stdout
        .split(/\s+/u)
        .includes(PROJECTS[normalizedPlan.target].serviceName)
    ) {
      throw new Error("The local endpoint did not reach the running state.");
    }
    const publication = await runOrThrow(runProcess, verification.publication);
    validatePublishedEndpoint(publication.stdout, {
      target: normalizedPlan.target,
      port: normalizedPlan.port,
    });
    models = await verifyHttpEndpoint({
      plan: normalizedPlan,
      clientCredential,
      fetchImpl,
    });
  } catch (error) {
    if (deploymentStarted) {
      let cleanupConfirmed = false;
      try {
        await runOrThrow(
          runProcess,
          createCleanupSpec({
            target: normalizedPlan.target,
            installRoot,
            dockerHost,
            projectName,
          }),
        );
        const remaining = await runOrThrow(
          runProcess,
          createCleanupVerificationSpec({
            target: normalizedPlan.target,
            installRoot,
            dockerHost,
            projectName,
          }),
        );
        cleanupConfirmed = !remaining.stdout
          .split(/\s+/u)
          .includes(PROJECTS[normalizedPlan.target].serviceName);
      } catch {
        // The caller receives a stronger fail-closed error below.
      }
      if (!cleanupConfirmed) {
        throw new Error(
          "Relmio could not confirm that the failed local endpoint was stopped. Inspect the Relmio Docker project before retrying.",
        );
      }
    }
    throw error;
  }

  return {
    target: normalizedPlan.target,
    endpoint: normalizedPlan.endpoint,
    protocol: normalizedPlan.protocol,
    clientCredential,
    credentialShownOnce: true,
    models,
    deploymentMode: managed.deploymentMode,
    experimental: normalizedPlan.experimental,
    browserClients: normalizedPlan.browserClients,
  };
}

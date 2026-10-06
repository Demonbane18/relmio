import { createHash, randomBytes, randomUUID } from "node:crypto";

import {
  INSTALL_ROOT,
  MANAGED_MARKER_PATH,
  PRECHECK_COMMAND,
  SHARED_ROOT_MARKER_CONTENT,
  SHARED_ROOT_MARKER_PATH,
  SIDECAR_MARKER_CONTENT,
  SIDECAR_BUILD_IGNORE_PATH,
  SIDECAR_BUILD_IGNORE_CONTENT,
  SIDECAR_BUILD_IGNORE_GUARD,
  SIDECAR_FRESH_CONTEXT_GUARD,
  SIDECAR_MANAGED_CONTEXT_GUARD,
  SIWC_STAGING_PATH,
  SIWC_MIGRATION_PENDING_PATH,
  SIWC_MIGRATED_PATH,
  SIWC_MIGRATION_MARKER_CONTENT,
  assertSidecarOnlyCommands,
  createDeploymentCommands,
  createVerificationCommands,
  parseManagedFileHashes,
  safeSiwcCatalogFailure,
  safeSiwcRuntimeFailure,
  validateSiwcAuthBinding,
  validateSiwcRegistrationId,
} from "../domain/safety.js";
import {
  SIDECAR_HOSTNAME,
  attestVpsSiwcCompose,
  attestVpsSiwcContainer,
  attestVpsSiwcImage,
  createComposeFile,
  createDockerfile,
} from "../domain/templates.js";
import { validateDockerName } from "../domain/validation.js";

import { VPS_OPERATION_LOCKS, inspectVpsResumeLockCommand } from "../domain/vps-build-state.js";
import { withVpsOperationLock } from "./vps-operation-lock.js";
import { collectSiwcRuntimeAssets } from "./siwc-runtime-assets.js";
import {
  finishAuthHandoff, prepareAuthHandoff, readAuthHandoff, readRegistration,
  readPendingAuthHandoff, readRegistrationView, validateSiwcBackgroundConsent,
} from "./siwc-session.mjs";
const MAX_HANDOFF_BYTES = 64 * 1024;
const ASSET_PATHS = new Set([
  "gateway/openai-oauth-sidecar.mjs", "gateway/codex-chat.js",
  "gateway/codex-app-server.mjs", "services/siwc-session.mjs",
  "services/siwc-handoff.mjs", "infrastructure/local-process.js",
  "services/local-integration-lifecycle-lock.js", "infrastructure/process-identity.js",
]);

const DOCKER_ID = /^[a-f0-9]{64}$/u;
const IMAGE_ID = /^sha256:[a-f0-9]{64}$/u;
const RUNTIME_UPDATE_PENDING = "Finish the interrupted sidecar update from Manage the installed ChatGPT session.";

export async function reviewVpsSiwcTarget({ remote, networkName, containerName }) {
  const network = validateDockerName(networkName);
  const name = validateDockerName(containerName);
  if (!remote?.identity) throw new Error("Verify the selected VPS before reviewing n8n.");
  const networkRecord = parseHandoffOutput(
    (await runOrThrow(remote, `docker network inspect --format '{{json .}}' ${network}`,
      "Selected n8n network identity check")).stdout, "Selected n8n network identity check", 64 * 1024,
  );
  const containerRecord = parseHandoffOutput(
    (await runOrThrow(remote, `docker inspect --format '{{json .}}' ${name}`,
      "Selected n8n container identity check")).stdout, "Selected n8n container identity check", 64 * 1024,
  );
  const networkId = networkRecord?.Id;
  const n8nContainerId = containerRecord?.Id;
  if (!DOCKER_ID.test(networkId) || networkRecord.Name !== network ||
      !DOCKER_ID.test(n8nContainerId) ||
      containerRecord?.Name?.replace(/^\//u, "") !== name ||
      containerRecord?.State?.Running !== true ||
      containerRecord?.NetworkSettings?.Networks?.[network]?.NetworkID !== networkId) {
    throw new Error("The selected running n8n container or network identity could not be verified.");
  }
  return Object.freeze({ n8nContainerId, networkId });
}

function validateReviewedTarget(remote, reviewedTarget, networkName) {
  if (!remote?.identity || !reviewedTarget || reviewedTarget.networkName !== networkName ||
      validateDockerName(reviewedTarget.containerName) !== reviewedTarget.containerName ||
      !DOCKER_ID.test(reviewedTarget.n8nContainerId) || !DOCKER_ID.test(reviewedTarget.networkId)) {
    throw new Error("The reviewed VPS or selected n8n destination changed.");
  }
  for (const field of ["host", "port", "fingerprint", "username", "authentication", "privilege", "loginUid", "effectiveUid"]) {
    if (remote.identity[field] !== reviewedTarget[field]) {
      throw new Error("The verified VPS identity differs from the reviewed target.");
    }
  }
}

async function reattestReviewedTarget(remote, reviewedTarget) {
  const actual = await reviewVpsSiwcTarget({
    remote, networkName: reviewedTarget.networkName,
    containerName: reviewedTarget.containerName,
  });
  if (actual.n8nContainerId !== reviewedTarget.n8nContainerId ||
      actual.networkId !== reviewedTarget.networkId) {
    throw new Error("The reviewed n8n container or network changed. Review and confirm again.");
  }
}

async function validateReviewedAccount(registration, binding) {
  const record = await readRegistration(registration);
  if (
    record?.registrationId !== binding.registrationId ||
    record?.clientId !== binding.clientId ||
    record?.generation !== binding.generation ||
    record?.owner?.hostId !== binding.ownerHostId ||
    record?.owner?.runtimeId !== binding.ownerRuntimeId ||
    record?.handoff?.state !== "owned" ||
    !record.planEnabled ||
    !record.session?.scopes?.includes("chatgpt.tokens.use.direct") ||
    !record.session?.refreshToken
  ) throw new Error("The selected ChatGPT account changed. Review and confirm it again.");
}

function parseHandoffOutput(output, label, maxBytes = 4096) {
  if (typeof output !== "string" || Buffer.byteLength(output) > maxBytes) {
    throw new Error(`${label} returned invalid attestation.`);
  }
  try { return JSON.parse(output); }
  catch { throw new Error(`${label} returned invalid attestation.`); }
}

async function runOrThrow(remote, command, label, input) {
  const result = await remote.exec(command, {
    timeoutMs: 90_000, ...(input === undefined ? {} : { input }),
  });
  if (result.code !== 0) {
    throw new Error(
      `${label} failed. The existing n8n deployment was not changed.`,
    );
  }
  return result;
}

function modelCheckFailure(result) {
  let recovery = "retry-later";
  let code = "model_check_failed";
  let status;
  let param;
  let requestId;
  if (typeof result?.stdout === "string" &&
      Buffer.byteLength(result.stdout) <= 4096) {
    try {
      const parsed = JSON.parse(result.stdout);
      if (typeof parsed?.error?.code === "string" &&
          /^[A-Za-z0-9_.-]{1,128}$/u.test(parsed.error.code)) {
        code = parsed.error.code;
      }
      if (Number.isInteger(parsed?.status) && parsed.status >= 400 && parsed.status <= 599) {
        status = parsed.status;
      }
      if (typeof parsed?.error?.param === "string" &&
          /^[A-Za-z0-9_.:-]{1,128}$/u.test(parsed.error.param)) {
        param = parsed.error.param;
      }
      if (typeof parsed?.requestId === "string" &&
          /^[A-Za-z0-9_.:-]{1,128}$/u.test(parsed.requestId)) {
        requestId = parsed.requestId;
      }
      if ([
        "reauthorize", "enable-plan", "manage-usage", "fix-request",
        "fix-configuration", "review-again", "resolve-handoff", "retry-later",
      ].includes(parsed?.recovery)) recovery = parsed.recovery;
    } catch {
      // The destination owns the session; an unclassified response cannot
      // authorize a retry, account switch, or source-token restoration.
    }
  }
  const message = "The selected SIWC model check failed. The destination owns the session; n8n was not changed.";
  return Object.assign(new Error(message), {
    safeMessage: message, code, recovery,
    ...(status === undefined ? {} : { status }),
    ...(param === undefined ? {} : { param }),
    ...(requestId === undefined ? {} : { requestId }),
  });
}

function parseModels(output) {
  try {
    const parsed = JSON.parse(output);
    if (!Array.isArray(parsed.data)) {
      throw new TypeError();
    }

    const models = parsed.data
      .map((model) => model?.id)
      .filter(
        (id) =>
          typeof id === "string" &&
          id.length > 0 &&
          id.length <= 128 &&
          /^[a-zA-Z0-9_.:-]+$/.test(id),
      );
    return models;
  } catch {
    throw new Error(
      "The sidecar started, but its model response could not be verified.",
    );
  }
}

function hasPublishedHostPort(output) {
  try {
    const parsed = JSON.parse(output);
    const services = Array.isArray(parsed) ? parsed : [parsed];
    if (services.length === 0) {
      throw new TypeError();
    }

    for (const service of services) {
      if (!service || !Array.isArray(service.Publishers)) {
        throw new TypeError();
      }
      for (const publisher of service.Publishers) {
        if (
          !publisher ||
          !Number.isInteger(publisher.PublishedPort) ||
          publisher.PublishedPort < 0 ||
          typeof publisher.URL !== "string"
        ) {
          throw new TypeError();
        }
        if (publisher.PublishedPort > 0 || publisher.URL.trim() !== "") {
          return true;
        }
      }
    }
    return false;
  } catch {
    throw new Error("The published-port safety check failed.");
  }
}


const sha256 = contents => createHash("sha256").update(contents).digest("hex");
const TARGET_FIELDS = ["host", "port", "fingerprint", "username", "authentication",
  "privilege", "loginUid", "effectiveUid", "networkName", "containerName",
  "n8nContainerId", "networkId"];
const STAGES = new Set(["preparing", "context", "built", "transferred", "complete"]);

// Everything the image is built from; the Compose file (one-time key verifier) is per install.
function managedRuntimeFiles(assets) {
  const files = new Map([
    [MANAGED_MARKER_PATH, SIDECAR_MARKER_CONTENT],
    [SIDECAR_BUILD_IGNORE_PATH, SIDECAR_BUILD_IGNORE_CONTENT],
    [`${INSTALL_ROOT}/Dockerfile`, createDockerfile()],
    [`${INSTALL_ROOT}/package.json`, assets.packageJson],
    [`${INSTALL_ROOT}/package-lock.json`, assets.packageLock],
  ]);
  for (const asset of assets.files) {
    if (!ASSET_PATHS.has(asset.path) || !Buffer.isBuffer(asset.contents)) {
      throw new Error("The packaged SIWC runtime assets are invalid.");
    }
    files.set(`${INSTALL_ROOT}/${asset.path}`, asset.contents);
  }
  return files;
}

function imageSourceDigest(files) {
  return sha256([...files]
    .filter(([path]) => path !== `${INSTALL_ROOT}/docker-compose.yml` && path !== MANAGED_MARKER_PATH)
    .map(([path, contents]) => `${sha256(contents)}  ${path}\n`).sort().join(""));
}

async function inspectResumeLock(remote, allowHeld = true) {
  const lock = (await runOrThrow(remote, inspectVpsResumeLockCommand(VPS_OPERATION_LOCKS.oauth),
    "Interrupted SIWC operation lock check")).stdout.trim();
  if (lock !== "none" && (!allowHeld || !/^\d+:\d+$/u.test(lock))) {
    throw new Error("The interrupted operation lock is uncertain. An administrator must inspect it.");
  }
  return lock === "none" ? undefined : lock;
}

async function attestLiveAccount(remote, registrationId) {
  const account = parseHandoffOutput(
    (await runOrThrow(remote, createVerificationCommands().accountLive, "Destination SIWC account check")).stdout,
    "Destination SIWC account check",
  ).account;
  if (account?.registrationId !== registrationId || account?.ownership !== "owned" ||
      account?.ownerRuntimeId !== "vps_n8n") {
    throw new Error("The installed SIWC account could not be attested.");
  }
  return account;
}

async function readStaging(remote, reviewedTarget, { allowTargetRefresh = false } = {}) {
  const output = (await runOrThrow(remote, createVerificationCommands().staging,
    "SIWC staging ownership check")).stdout;
  const checkpoint = parseHandoffOutput(output, "SIWC staging ownership check", 16384);
  if (checkpoint === null) return null;
  if (checkpoint?.schemaVersion !== 1 || !STAGES.has(checkpoint.stage) ||
      !/^[0-9a-f-]{36}$/u.test(checkpoint.installId) ||
      !["installed", "migrated", "replaced"].includes(checkpoint.deploymentMode) ||
      (checkpoint.stage === "complete" || allowTargetRefresh
        ? ["host", "port", "fingerprint", "networkId"] : TARGET_FIELDS)
        .some(field => checkpoint.reviewedTarget?.[field] !== reviewedTarget[field]) ||
      checkpoint.registrationId !== checkpoint.authBinding?.registrationId) {
    throw new Error("The SIWC staging owner or reviewed destination changed.");
  }
  validateSiwcAuthBinding(checkpoint.authBinding);
  return { checkpoint, checkpointSha256: sha256(output) };
}

async function attestStagedFiles(remote, checkpoint) {
  const output = (await runOrThrow(remote, createVerificationCommands().stagedFiles,
    "Staged SIWC files check")).stdout;
  const files = parseManagedFileHashes(output);
  for (const [path, digest] of Object.entries(files)) {
    if (checkpoint.files?.[path] !== digest &&
        ((!["preparing", "context"].includes(checkpoint.stage) &&
          !(checkpoint.deploymentMode === "migrated" && path === `${INSTALL_ROOT}/openai-oauth-sidecar.mjs`)) ||
          checkpoint.previousFiles?.[path] !== digest)) {
      throw new Error("A staged SIWC file changed. Review the installation before resuming.");
    }
  }
  if (["built", "transferred", "complete"].includes(checkpoint.stage) &&
      Object.keys(checkpoint.files ?? {}).some(path => !Object.hasOwn(files, path))) {
    throw new Error("A required staged SIWC file is missing.");
  }
  return files;
}

async function publishCheckpoint(remote, checkpoint, stage) {
  const next = { ...checkpoint, stage };
  await remote.publishManagedFile(SIWC_STAGING_PATH, `${JSON.stringify(next)}\n`, 0o600);
  Object.assign(checkpoint, next);
}

function partialFinalization(result, error = "SIWC finalization could not be confirmed. Review recovery before using this credential.") {
  return {
    ...result, deploymentMode: "partial", readiness: "unverified",
    finalizationFailure: { error, recovery: "resolve-handoff" },
  };
}

export async function reviewVpsSiwcResume({
  remote, networkName, reviewedTarget, registrationId,
}) {
  validateReviewedTarget(remote, reviewedTarget, networkName);
  validateSiwcRegistrationId(registrationId);
  await reattestReviewedTarget(remote, reviewedTarget);
  const staging = await readStaging(remote, reviewedTarget, { allowTargetRefresh: true });
  if (staging?.checkpoint.runtimeUpdate) throw new Error(RUNTIME_UPDATE_PENDING);
  if (!staging || (staging.checkpoint.registrationId !== registrationId &&
      staging.checkpoint.notAccepted !== true)) {
    throw new Error("There is no matching interrupted SIWC installation to resume.");
  }
  await attestStagedFiles(remote, staging.checkpoint);
  const lock = await inspectResumeLock(remote);
  return Object.freeze({
    installId: staging.checkpoint.installId, registrationId,
    stage: staging.checkpoint.stage, checkpointSha256: staging.checkpointSha256,
    deploymentMode: staging.checkpoint.deploymentMode,
    ...(lock ? { operationLockIdentity: lock } : {}),
    ...(staging.checkpoint.registrationId === registrationId ? {} :
      { stagedRegistrationId: staging.checkpoint.registrationId }),
  });
}

export async function reconcileVpsSiwcHandoff({
  remote, networkName, reviewedTarget, registration, confirmed,
}) {
  if (confirmed !== true) throw new Error("Confirm reconciliation of the frozen SIWC handoff.");
  validateReviewedTarget(remote, reviewedTarget, networkName);
  validateSiwcRegistrationId(registration?.registrationId);
  const pending = await readPendingAuthHandoff(registration);
  if (!pending) throw new Error("The selected account has no frozen SIWC handoff.");
  await reattestReviewedTarget(remote, reviewedTarget);
  const staging = await readStaging(remote, reviewedTarget, { allowTargetRefresh: true });
  if (staging?.checkpoint.runtimeUpdate) throw new Error(RUNTIME_UPDATE_PENDING);
  if (!staging || staging.checkpoint.registrationId !== registration.registrationId ||
      staging.checkpoint.destination?.hostId !== pending.target.hostId ||
      staging.checkpoint.destination?.runtimeId !== pending.target.runtimeId) {
    throw new Error("The frozen handoff differs from the reviewed VPS installation.");
  }
  await attestStagedFiles(remote, staging.checkpoint);
  await attestInstalledImage(remote, staging.checkpoint);
  const config = parseHandoffOutput((await runOrThrow(remote,
    createVerificationCommands().managementConfig, "Reconciliation Compose check")).stdout,
  "Reconciliation Compose check", 64 * 1024);
  if (attestVpsSiwcCompose(config, networkName) !== registration.registrationId) {
    throw new Error("The destination registration changed.");
  }
  const response = await readPendingVpsReceipt(remote, pending);
  if (response?.receipt === null) {
    await assertNoVpsOneOffContainers(remote);
    const lock = (await runOrThrow(remote, inspectVpsResumeLockCommand(VPS_OPERATION_LOCKS.oauth),
      "Frozen SIWC operation lock check")).stdout.trim();
    if (lock !== "none" && !/^\d+:\d+$/u.test(lock)) throw new Error("The frozen SIWC lock is uncertain.");
    await withVpsOperationLock(remote, VPS_OPERATION_LOCKS.oauth, async () => {
      await reattestReviewedTarget(remote, reviewedTarget);
      const current = await readStaging(remote, reviewedTarget, { allowTargetRefresh: true });
      if (current?.checkpointSha256 !== staging.checkpointSha256) {
        throw new Error("The frozen installation changed during reconciliation.");
      }
      const settled = await readPendingVpsReceipt(remote, pending);
      if (settled?.receipt !== null) {
        throw Object.assign(new Error("The SIWC handoff outcome changed. Reconcile the accepted receipt before resuming."), {
          remoteOutcomeUnknown: true,
        });
      }
      await assertNoVpsOneOffContainers(remote);
      staging.checkpoint.notAccepted = true;
      await publishCheckpoint(remote, staging.checkpoint, staging.checkpoint.stage);
    }, { resumeIdentity: lock === "none" ? undefined : lock });
    return { outcome: "not-accepted", account: await readRegistrationView(registration) };
  }
  if (response?.receipt?.handoffId !== pending.handoffId ||
      JSON.stringify(response.receipt.binding) !== JSON.stringify(pending.binding)) {
    throw new Error("The destination receipt differs from the frozen SIWC handoff.");
  }
  return { outcome: "finished", account: await finishAuthHandoff(registration, {
    handoffId: pending.handoffId, receipt: response.receipt.receipt,
  }) };
}

async function attestInstalledImage(remote, checkpoint) {
  const image = parseHandoffOutput((await runOrThrow(remote,
    createVerificationCommands().ownerImage, "Sidecar executable image check")).stdout,
  "Sidecar executable image check", 64 * 1024);
  return attestVpsSiwcImage(image, checkpoint?.imageId);
}

async function readPendingVpsReceipt(remote, pending) {
  try {
    return parseHandoffOutput((await runOrThrow(remote,
      createVerificationCommands().receipt, "Destination receipt reconciliation",
      JSON.stringify({ handoffId: pending.handoffId, binding: pending.binding,
        identity: pending.identity }))).stdout, "Destination receipt reconciliation", 8192);
  } catch (cause) {
    throw Object.assign(new Error("The SIWC receipt outcome is unresolved. The sender remains frozen."), {
      remoteOutcomeUnknown: true, ...(cause?.timedOut ? { timedOut: true } : {}),
    });
  }
}

async function assertNoVpsOneOffContainers(remote) {
  try {
    const result = await runOrThrow(remote, createVerificationCommands().oneOffContainers,
      "Frozen SIWC handoff writer check");
    if (typeof result.stdout !== "string" || result.stdout.trim() !== "") {
      throw new Error("A one-off SIWC operation may still own the handoff.");
    }
  } catch (cause) {
    throw Object.assign(new Error("The SIWC handoff may still be running. The sender remains frozen."), {
      remoteOutcomeUnknown: true, ...(cause?.timedOut ? { timedOut: true } : {}),
    });
  }
}

export async function installSidecar({
  remote, networkName, registration, authBinding, reviewedTarget,
  backgroundConsent, replacementConsent, existingBinding,
  migrationConsent, legacyBinding, resume, confirmed,
}, { collectAssets = collectSiwcRuntimeAssets } = {}) {
  if (confirmed !== true) throw new Error("Confirm the sidecar-only deployment before installing.");
  validateReviewedTarget(remote, reviewedTarget, networkName);
  const binding = validateSiwcAuthBinding(authBinding);
  if (registration?.registrationId !== binding.registrationId || !registration.storageRoot) {
    throw new Error("The selected SIWC registration does not match the reviewed plan.");
  }
  const safeConsent = Object.freeze({
    ...validateSiwcBackgroundConsent(backgroundConsent, { target: "vps-n8n" }),
  });
  const replacing = replacementConsent !== undefined || existingBinding !== undefined;
  const migrating = migrationConsent !== undefined || legacyBinding !== undefined;
  if ((migrating && replacing) || (migrating && migrationConsent !== true)) {
    throw new Error("Confirm the separately reviewed VPS legacy bridge migration.");
  }
  if (replacing && replacementConsent !== true) {
    throw new Error("Confirm the separately reviewed VPS account replacement.");
  }
  const source = await readRegistration(registration);
  const transferred = resume && source?.handoff?.state === "transferred";
  if (!transferred) await validateReviewedAccount(registration, binding);
  else if (source.registrationId !== binding.registrationId || source.clientId !== binding.clientId ||
      source.generation !== binding.generation || source.owner.hostId !== binding.ownerHostId ||
      source.owner.runtimeId !== binding.ownerRuntimeId) {
    throw new Error("The transferred account changed. Review recovery again.");
  }
  const verification = createVerificationCommands();
  const deploymentCommands = createDeploymentCommands();
  assertSidecarOnlyCommands([PRECHECK_COMMAND, SIDECAR_MANAGED_CONTEXT_GUARD,
    SIDECAR_FRESH_CONTEXT_GUARD, ...deploymentCommands, ...Object.values(verification)]);
  let staging = await readStaging(remote, reviewedTarget, { allowTargetRefresh: !!resume });
  let checkpoint = staging?.checkpoint;
  if (checkpoint?.runtimeUpdate) throw new Error(RUNTIME_UPDATE_PENDING);
  if (resume) {
    const current = await reviewVpsSiwcResume({
      remote, networkName, reviewedTarget, registrationId: binding.registrationId,
    });
    for (const field of ["installId", "registrationId", "stage", "checkpointSha256", "deploymentMode", "operationLockIdentity", "stagedRegistrationId"]) {
      if (resume[field] !== current[field]) throw new Error("The reviewed SIWC resume binding changed.");
    }
    if (resume.stagedRegistrationId) {
      if (transferred || source?.handoff?.state !== "owned" || checkpoint.notAccepted !== true) {
        throw new Error("A fresh authorized SIWC session is required after unaccepted transfer.");
      }
    } else {
      for (const field of ["registrationId", "clientId", "ownerHostId", "ownerRuntimeId"]) {
        if (checkpoint.authBinding[field] !== binding[field]) throw new Error("The staged source account changed.");
      }
    }
  } else {
    if (checkpoint && checkpoint.stage !== "complete") {
      throw new Error("This SIWC installation is staged. Review and confirm resume instead.");
    }
    checkpoint = null;
  }
  let reviewedLegacy;
  let reviewedExisting;
  if (!resume && migrating) {
    reviewedLegacy = await reviewVpsLegacyMigration({ remote, networkName, reviewedTarget });
    for (const field of ["containerId", "imageId", "networkName", "networkId", "authIdentity", "running"]) {
      if (legacyBinding?.[field] !== reviewedLegacy[field]) {
        throw new Error("The old VPS sidecar or protected credential changed. Review migration again.");
      }
    }
  }
  if (!resume && replacing) {
    reviewedExisting = await reviewVpsSiwcReplacement({ remote, networkName, reviewedTarget });
    for (const field of ["registrationId", "containerId", "imageId", "networkName", "networkId", "running"]) {
      if (existingBinding?.[field] !== reviewedExisting[field]) {
        throw new Error("The reviewed VPS sidecar changed. Review replacement again.");
      }
    }
    if (existingBinding.registrationId === binding.registrationId ||
        typeof existingBinding.ownerHostId !== "string" ||
        typeof existingBinding.expectedGeneration !== "string") {
      throw new Error("The old destination owner or selected account changed.");
    }
  }
  if (!resume && !migrating) {
    const precheck = await remote.exec(PRECHECK_COMMAND);
    if (precheck.code !== 0 || precheck.stdout?.trim() !== (replacing ? "managed" : "new")) {
      throw new Error("The existing VPS bridge requires separately reviewed SIWC recovery.");
    }
    if (!replacing) await runOrThrow(remote, SIDECAR_FRESH_CONTEXT_GUARD, "Fresh sidecar directory check");
  }
  const files = managedRuntimeFiles(await collectAssets());
  const clientCredential = randomBytes(32).toString("base64url");
  files.set(`${INSTALL_ROOT}/docker-compose.yml`, createComposeFile({
    networkName, registrationId: binding.registrationId, runtimeId: "vps_n8n",
    tokenSha256: sha256(clientCredential),
  }));
  await runOrThrow(remote, SIDECAR_MANAGED_CONTEXT_GUARD, "Managed SIWC publication targets check");
  // Only the fixed root and its shared ownership marker precede the journal.
  const sharedRoot = (await runOrThrow(remote, verification.sharedRoot, "Shared root ownership check")).stdout.trim();
  if (!["managed", "absent"].includes(sharedRoot)) throw new Error("The shared root owner changed.");
  await reattestReviewedTarget(remote, reviewedTarget);
  await runOrThrow(remote, deploymentCommands[0], "Sidecar root creation");
  if (sharedRoot === "absent") {
    await remote.publishManagedFile(SHARED_ROOT_MARKER_PATH, SHARED_ROOT_MARKER_CONTENT, 0o644);
  }
  return withVpsOperationLock(remote, VPS_OPERATION_LOCKS.oauth, async build => {
    await reattestReviewedTarget(remote, reviewedTarget);
    await runOrThrow(remote, SIDECAR_MANAGED_CONTEXT_GUARD, "Managed SIWC context check");
    if (resume) {
      staging = await readStaging(remote, reviewedTarget, { allowTargetRefresh: true });
      if (staging?.checkpointSha256 !== resume.checkpointSha256) {
        throw new Error("The staged installation changed before resume.");
      }
      await attestStagedFiles(remote, checkpoint);
      checkpoint.previousFiles = parseManagedFileHashes((await runOrThrow(remote,
        verification.stagedFiles, "Interrupted managed files check")).stdout);
      if (resume.stagedRegistrationId) {
        const pending = await readPendingAuthHandoff({
          storageRoot: registration.storageRoot, registrationId: resume.stagedRegistrationId,
        });
        if (!pending || pending.binding.registrationId !== checkpoint.registrationId ||
            pending.binding.clientId !== checkpoint.authBinding.clientId ||
            pending.binding.source.hostId !== checkpoint.authBinding.ownerHostId ||
            pending.binding.source.runtimeId !== checkpoint.authBinding.ownerRuntimeId ||
            pending.target.hostId !== checkpoint.destination?.hostId ||
            pending.target.runtimeId !== checkpoint.destination?.runtimeId) {
          throw new Error("The original frozen SIWC handoff changed. Reconcile it before resuming.");
        }
        await attestInstalledImage(remote, checkpoint);
        const config = parseHandoffOutput((await runOrThrow(remote, verification.managementConfig,
          "Original handoff configuration check")).stdout, "Original handoff configuration check", 64 * 1024);
        if (attestVpsSiwcCompose(config, networkName) !== resume.stagedRegistrationId) {
          throw new Error("The original destination configuration changed.");
        }
        const original = await readPendingVpsReceipt(remote, pending);
        if (original?.receipt !== null) {
          throw new Error("The original SIWC handoff was accepted. Reconcile it before selecting a fresh registration.");
        }
        await assertNoVpsOneOffContainers(remote);
        checkpoint.registrationId = binding.registrationId;
        checkpoint.notAccepted = false;
      }
      if (!transferred) checkpoint.authBinding = binding;
      checkpoint.reviewedTarget = Object.fromEntries(TARGET_FIELDS.map(field => [field, reviewedTarget[field]]));
    } else {
      const previous = (await runOrThrow(remote, verification.stagedFiles, "Existing managed files check")).stdout;
      const previousFiles = parseManagedFileHashes(previous);
      checkpoint = {
        schemaVersion: 1, installId: randomUUID(), registrationId: binding.registrationId,
        authBinding: binding, reviewedTarget: Object.fromEntries(TARGET_FIELDS.map(field => [field, reviewedTarget[field]])),
        deploymentMode: migrating ? "migrated" : replacing ? "replaced" : "installed",
        previousFiles, ...(reviewedLegacy ? { legacyBinding: reviewedLegacy, legacyFiles: previousFiles } : {}),
        ...(reviewedExisting ? { existingBinding: { ...reviewedExisting,
          ownerHostId: existingBinding.ownerHostId, expectedGeneration: existingBinding.expectedGeneration } } : {}),
      };
    }
    let resumedAccount;
    if (transferred) {
      await attestInstalledImage(remote, checkpoint);
      const config = parseHandoffOutput((await runOrThrow(remote, verification.managementConfig,
        "Resumed execution configuration check")).stdout, "Resumed execution configuration check", 64 * 1024);
      if (attestVpsSiwcCompose(config, networkName) !== binding.registrationId) {
        throw new Error("The resumed destination configuration changed.");
      }
      const presence = await runOrThrow(remote, verification.ownerPresence, "Resumed owner presence check");
      if (presence.stdout.trim()) {
        let owner;
        try { owner = await reviewVpsSiwcReplacement({ remote, networkName, reviewedTarget, allowStaged: true }); }
        catch { await attestStoppedPreviousContainer(remote, checkpoint); }
        if (owner && (owner.registrationId !== binding.registrationId ||
            !await stopAttestedService(remote, reviewedTarget, owner))) {
          throw Object.assign(new Error("The resumed owned service stop could not be attested."),
            { remoteOutcomeUnknown: true });
        }
      }
      resumedAccount = parseHandoffOutput((await runOrThrow(remote, verification.account,
        "Resumed destination account check")).stdout, "Resumed destination account check").account;
      if (resumedAccount?.registrationId !== binding.registrationId ||
          resumedAccount.ownerHostId !== checkpoint.destination?.hostId ||
          resumedAccount.ownerRuntimeId !== "vps_n8n" || resumedAccount.ownership !== "owned") {
        throw new Error("The resumed destination account changed.");
      }
      checkpoint.containerId = undefined;
    }
    const imageSourceSha256 = imageSourceDigest(files);
    const rebuild = !transferred && checkpoint.deploymentMode !== "replaced" &&
      (!checkpoint.imageId || checkpoint.imageSourceSha256 !== imageSourceSha256);
    // Forget the old image before uploading, so a crash after the build never pairs
    // the moved tag with a recorded old image ID.
    if (rebuild) Object.assign(checkpoint, { imageId: undefined, imageSourceSha256: undefined });
    checkpoint.files = Object.fromEntries([...files].map(([path, contents]) => [path, sha256(contents)]));
    await publishCheckpoint(remote, checkpoint,
      resume && checkpoint.stage !== "preparing" ? "context" : checkpoint.stage ?? "preparing");
    if (checkpoint.stage === "preparing") {
      if (checkpoint.deploymentMode === "migrated") {
        await prepareLegacyMigration({ remote, networkName, reviewedTarget,
          reviewedLegacy: checkpoint.legacyBinding, verification, checkpoint });
      } else if (checkpoint.deploymentMode === "replaced") {
        await prepareAccountReplacement({ remote, networkName, reviewedTarget,
          reviewedExisting: checkpoint.existingBinding, existingBinding: checkpoint.existingBinding,
          verification, runtimeId: "vps_n8n" });
      }
      await publishCheckpoint(remote, checkpoint, "context");
    } else if (!transferred && checkpoint.deploymentMode !== "installed") {
      await attestStoppedPreviousContainer(remote, checkpoint);
    }
    await runOrThrow(remote, SIDECAR_MANAGED_CONTEXT_GUARD, "SIWC source-directory check");
    await runOrThrow(remote, deploymentCommands[1], "SIWC storage directory creation");
    await runOrThrow(remote, deploymentCommands[2], "Sidecar source directory creation");
    let credentialPublicationStarted = false;
    try {
      for (const [path, contents] of files) {
        if (path === `${INSTALL_ROOT}/docker-compose.yml`) credentialPublicationStarted = true;
        await remote.publishManagedFile(path, contents, 0o644);
      }
      await runOrThrow(remote, deploymentCommands[3], "Sidecar Compose validation");
      if (rebuild) {
        await build(deploymentCommands[4]);
        await build.releaseState();
      }
      checkpoint.imageId = await attestInstalledImage(remote, checkpoint);
      if (rebuild) checkpoint.imageSourceSha256 = imageSourceSha256;
    } catch (error) {
      if (!transferred || !credentialPublicationStarted) throw error;
      return partialFinalization({
        baseUrl: `http://${SIDECAR_HOSTNAME}:10531/v1`, clientCredential,
        credentialShownOnce: true, useResponsesApi: true, models: [], account: resumedAccount,
        runtimeState: error?.remoteOutcomeUnknown ? "unknown" : "stopped",
        hostPublication: error?.remoteOutcomeUnknown ? "unknown" : "none",
        ...(error?.remoteOutcomeUnknown ? { remoteOutcomeUnknown: true } : {}),
      });
    }
    let journalFailed = false;
    try { await publishCheckpoint(remote, checkpoint, transferred ? "transferred" : "built"); }
    catch (error) {
      if (!transferred) throw error;
      journalFailed = true;
    }
    let result;
    if (transferred) {
      result = await startTransferredSidecar({ remote, verification, deploymentCommands,
        binding, clientCredential, deploymentMode: checkpoint.deploymentMode,
        accepted: { account: resumedAccount }, destination: checkpoint.destination, reviewedTarget, checkpoint });
      if (journalFailed) result = partialFinalization(result);
    } else {
      result = await transferSidecarSession({ remote, verification, deploymentCommands,
        registration, binding, backgroundConsent: safeConsent, runtimeId: "vps_n8n",
        clientCredential, deploymentMode: checkpoint.deploymentMode, reviewedTarget, checkpoint,
        expectedDestinationHostId: checkpoint.existingBinding?.ownerHostId });
    }
    try {
      if (result.runtimeState === "running") {
        if (checkpoint.deploymentMode === "migrated") {
          await remote.publishManagedFile(SIWC_MIGRATED_PATH, SIWC_MIGRATION_MARKER_CONTENT, 0o600);
        }
        await publishCheckpoint(remote, checkpoint, "complete");
      }
    } catch {
      result = partialFinalization(result);
    }
    return {
      ...result,
      ...(checkpoint.deploymentMode === "migrated" ? {
        legacyRetained: true, ...(result.deploymentMode === "partial"
          ? { migrationPending: true } : { migratedLegacy: true }),
      } : {}),
    };
  }, { resumeIdentity: resume?.operationLockIdentity });
}

async function transferSidecarSession({
  remote, verification, deploymentCommands, registration, binding,
  backgroundConsent, runtimeId, clientCredential, deploymentMode,
  expectedDestinationHostId, reviewedTarget, checkpoint,
}) {
  await reattestReviewedTarget(remote, reviewedTarget);
  await attestInstalledImage(remote, checkpoint);
  const config = parseHandoffOutput((await runOrThrow(remote, verification.managementConfig,
    "Handoff execution configuration check")).stdout, "Handoff execution configuration check", 64 * 1024);
  if (attestVpsSiwcCompose(config, reviewedTarget.networkName) !== binding.registrationId) {
    throw new Error("The destination handoff configuration changed.");
  }
  const destination = parseHandoffOutput(
    (await runOrThrow(remote, verification.host, "Destination host initialization")).stdout,
    "Destination host initialization",
  );
  if (typeof destination.hostId !== "string" || destination.runtimeId !== runtimeId ||
      destination.hostId === binding.ownerHostId ||
      expectedDestinationHostId && destination.hostId !== expectedDestinationHostId) {
    throw new Error("The destination SIWC host identity is invalid.");
  }
  checkpoint.destination = destination;
  await publishCheckpoint(remote, checkpoint, "built");
  await reattestReviewedTarget(remote, reviewedTarget);
  await validateReviewedAccount(registration, binding);
  const { handoffId } = await prepareAuthHandoff(registration, {
    expectedGeneration: binding.generation, target: destination, backgroundConsent,
  });
  const contents = await readAuthHandoff(registration, {
    handoffId, expectedGeneration: binding.generation,
  });
  if (contents.length > MAX_HANDOFF_BYTES) {
    throw new Error("The selected session remains frozen: protected handoff exceeds the SSH limit.");
  }
  let accepted;
  try {
    const result = await remote.exec(verification.accept, {
      input: contents.toString("utf8"), timeoutMs: 120_000,
    });
    if (result.code !== 0) throw new Error("Destination SIWC handoff was not confirmed.");
    accepted = parseHandoffOutput(result.stdout, "Destination SIWC handoff");
  } catch (error) {
    const failure = new Error("The SIWC transfer outcome is unresolved. The sender remains frozen; inspect the destination before retrying.");
    failure.remoteOutcomeUnknown = true;
    if (error?.timedOut === true) failure.timedOut = true;
    throw failure;
  }
  if (accepted?.handoffId !== handoffId ||
      accepted.account?.registrationId !== binding.registrationId ||
      accepted.account?.ownerHostId !== destination.hostId ||
      accepted.account?.ownerRuntimeId !== runtimeId ||
      accepted.account?.ownership !== "owned") {
    throw new Error("The SIWC handoff receipt or destination account did not match. The sender remains frozen.");
  }
  await finishAuthHandoff(registration, { handoffId, receipt: accepted.receipt });
  let finalizationFailed = false;
  try { await publishCheckpoint(remote, checkpoint, "transferred"); }
  catch { finalizationFailed = true; }
  const result = await startTransferredSidecar({ remote, verification, deploymentCommands,
    binding, clientCredential, deploymentMode, accepted, destination, reviewedTarget, checkpoint });
  return finalizationFailed ? partialFinalization(result) : result;
}

async function startTransferredSidecar({
  remote, verification, deploymentCommands, binding, clientCredential,
  deploymentMode, accepted, destination, reviewedTarget, checkpoint,
}) {
  const runtimeId = "vps_n8n";
  try {
    await runOrThrow(remote, deploymentCommands.at(-1), "Sidecar start");
    const running = await runOrThrow(remote, verification.runningService, "Sidecar status check");
    if (!running.stdout.split(/\s+/u).includes("openai-oauth")) {
      throw new Error("The sidecar did not reach the running state.");
    }
    const publication = await remote.exec(verification.publicationState);
    if (publication.code !== 0 || hasPublishedHostPort(publication.stdout)) {
      throw Object.assign(new Error("The sidecar unexpectedly published a host port."), { unsafePublication: true });
    }
    const owner = await reviewVpsSiwcReplacement({
      remote, networkName: reviewedTarget.networkName, reviewedTarget, allowStaged: true,
    });
    if (!owner.running || owner.registrationId !== binding.registrationId) {
      throw new Error("The started SIWC owner could not be attested.");
    }
    checkpoint.containerId = owner.containerId;
  } catch (error) {
    const stopped = await stopAttestedService(remote, reviewedTarget);
    return {
      baseUrl: `http://${SIDECAR_HOSTNAME}:10531/v1`,
      clientCredential, credentialShownOnce: true, useResponsesApi: true,
      models: [], deploymentMode: "partial", account: accepted.account,
      hostPublication: stopped ? "none" : "unknown",
      readiness: "unverified", runtimeState: stopped ? "stopped" : "unknown",
      runtimeFailure: error?.unsafePublication === true
        ? { error: "The sidecar may have published a host port. Inspect it before use.",
            status: 503, recovery: "resolve-handoff" }
        : safeSiwcRuntimeFailure(),
      ...(deploymentMode === "replaced" ? { replacementPending: true } : {}),
    };
  }
  let models = [];
  let catalogFailure;
  try {
    const response = await remote.exec(verification.models, { input: clientCredential, timeoutMs: 45_000 });
    if (response.code !== 0) throw modelCheckFailure(response);
    models = parseModels(response.stdout);
  } catch (error) {
    catalogFailure = safeSiwcCatalogFailure(error);
  }
  let account = accepted.account;
  let status;
  try {
    status = parseHandoffOutput(
      (await runOrThrow(remote, verification.accountLive, "Destination SIWC account check")).stdout,
      "Destination SIWC account check",
    );
  } catch {
    catalogFailure ??= safeSiwcCatalogFailure({
      code: "owner_status_unavailable", recovery: "retry-later",
    });
  }
  if (status && (status.account?.registrationId !== binding.registrationId ||
      status.account.ownerHostId !== destination.hostId ||
      status.account.ownerRuntimeId !== runtimeId ||
      status.account.ownership !== "owned")) {
    return partialFinalization({
      baseUrl: `http://${SIDECAR_HOSTNAME}:10531/v1`, clientCredential,
      credentialShownOnce: true, useResponsesApi: true, models: [],
      account, runtimeState: "running", hostPublication: "none",
    }, "The destination account could not be attested. Do not use this credential until recovery is reviewed.");
  }
  if (status) account = status.account;
  return {
    baseUrl: `http://${SIDECAR_HOSTNAME}:10531/v1`,
    clientCredential, credentialShownOnce: true, useResponsesApi: true,
    models, deploymentMode, account,
    hostPublication: "none",
    runtimeState: "running",
    readiness: catalogFailure ? "unverified" : "verified",
    ...(catalogFailure ? { catalogFailure } : {}),
    ...(deploymentMode === "replaced" ? { replacedAccount: true } : {}),
  };
}

async function prepareAccountReplacement({
  remote, networkName, reviewedTarget, reviewedExisting, existingBinding,
  verification, runtimeId,
}) {
  const current = await reviewVpsSiwcReplacement({
    remote, networkName, reviewedTarget, allowStaged: true,
  });
  for (const field of [
    "registrationId", "containerId", "imageId", "networkName", "networkId", "running",
  ]) {
    if (current[field] !== reviewedExisting[field]) {
      throw new Error("The old VPS sidecar changed before replacement. Review again.");
    }
  }
  const old = parseHandoffOutput(
    (await runOrThrow(remote, verification.account, "Old destination SIWC account check")).stdout,
    "Old destination SIWC account check",
  ).account;
  if (old?.registrationId !== existingBinding.registrationId ||
      old?.ownerHostId !== existingBinding.ownerHostId ||
      old?.ownerRuntimeId !== runtimeId ||
      old?.generation !== existingBinding.expectedGeneration ||
      old?.session !== "signed-out" || old?.planEnabled !== false) {
    throw new Error("Sign out of the exact old VPS SIWC account before reviewed replacement.");
  }
  await reattestReviewedTarget(remote, reviewedTarget);
  await runOrThrow(remote, verification.stop, "Owned old sidecar stop");
  const running = await runOrThrow(remote, verification.runningService, "Old sidecar stopped check");
  if (running.stdout.split(/\s+/u).includes("openai-oauth")) {
    throw new Error("The old sidecar did not stop; replacement was not attempted.");
  }
  const stopped = await reviewVpsSiwcReplacement({
    remote, networkName, reviewedTarget, allowStaged: true,
  });
  if (stopped.running || stopped.containerId !== current.containerId ||
      stopped.imageId !== current.imageId ||
      stopped.registrationId !== current.registrationId ||
      stopped.networkName !== current.networkName) {
    throw new Error("The old VPS sidecar changed while stopping; it will not be resumed automatically.");
  }
  const postStop = parseHandoffOutput(
    (await runOrThrow(remote, verification.account, "Stopped old SIWC account check")).stdout,
    "Stopped old SIWC account check",
  ).account;
  if (postStop?.registrationId !== old.registrationId ||
      postStop?.generation !== old.generation ||
      postStop?.session !== "signed-out" || postStop?.planEnabled !== false) {
    throw new Error("The old signed-out SIWC account changed. The sidecar remains stopped.");
  }
}

async function prepareLegacyMigration({
  remote, networkName, reviewedTarget, reviewedLegacy, verification, checkpoint,
}) {
  const current = await reviewVpsLegacyMigration({
    remote, networkName, reviewedTarget, allowPending: true,
  });
  for (const field of [
    "containerId", "imageId", "networkName", "networkId", "authIdentity",
  ]) {
    if (current[field] !== reviewedLegacy[field]) {
      throw new Error("The old VPS sidecar changed before migration. Review again.");
    }
  }
  const checkArchive = async () => {
    const output = (await runOrThrow(remote, verification.legacyArchiveFiles,
      "Legacy archive ownership check")).stdout.trim();
    if (output === "absent") return false;
    const archived = parseManagedFileHashes(output);
    for (const [path, digest] of Object.entries(archived)) {
      if (!path.startsWith(`${INSTALL_ROOT}/legacy/`) ||
          checkpoint.legacyFiles?.[path.replace("/legacy/", "/")] !== digest) {
        throw new Error("The retained legacy archive changed; it will not be overwritten.");
      }
    }
    return ["Dockerfile", "docker-compose.yml", ".managed-by-n8n-openai-oauth"]
      .every(name => Object.hasOwn(archived, `${INSTALL_ROOT}/legacy/${name}`));
  };
  if (!await checkArchive()) {
    await runOrThrow(remote, verification.archiveLegacy, "Legacy sidecar metadata preservation");
    if (!await checkArchive()) throw new Error("The retained legacy archive is incomplete.");
  }
  await remote.publishManagedFile(SIWC_MIGRATION_PENDING_PATH, SIWC_MIGRATION_MARKER_CONTENT, 0o600);
  await reattestReviewedTarget(remote, reviewedTarget);
  if (reviewedLegacy.running) {
    await runOrThrow(remote, verification.stop, "Attested legacy sidecar stop");
  }
  const running = await runOrThrow(remote, verification.runningService, "Legacy sidecar stopped check");
  if (running.stdout.split(/\s+/u).includes("openai-oauth")) {
    throw new Error("The old refresh writer did not stop; the new SIWC transfer was not attempted.");
  }
  const stopped = await reviewVpsLegacyMigration({
    remote, networkName, reviewedTarget, allowPending: true,
  });
  for (const field of [
    "containerId", "imageId", "networkName", "authIdentity",
  ]) {
    if (stopped[field] !== reviewedLegacy[field]) {
      throw new Error("The old VPS sidecar changed while stopping. It will not be resumed automatically.");
    }
  }
  if (stopped.running ||
      stopped.networkId && stopped.networkId !== reviewedLegacy.networkId) {
    throw new Error("The old sidecar identity or refresh-writer state is unresolved.");
  }
}

async function attestStoppedPreviousContainer(remote, checkpoint) {
  const previous = checkpoint.legacyBinding ?? checkpoint.existingBinding;
  const container = parseHandoffOutput((await runOrThrow(remote,
    createVerificationCommands().ownerContainer, "Staged previous writer identity check")).stdout,
  "Staged previous writer identity check", 64 * 1024);
  const root = checkpoint.legacyBinding ? "auth" : "siwc";
  const destination = checkpoint.legacyBinding ? "/home/node/.codex" : "/home/node/.relmio-siwc";
  if (container?.Id !== previous.containerId || container.Image !== previous.imageId ||
      container.State?.Running !== false || container.State?.Paused !== false ||
      container.Mounts?.length !== 1 || container.Mounts[0]?.Type !== "bind" ||
      container.Mounts[0]?.Source !== `${INSTALL_ROOT}/${root}` ||
      container.Mounts[0]?.Destination !== destination ||
      container.Config?.Labels?.["com.docker.compose.project"] !== "n8n-openai-oauth" ||
      container.Config?.Labels?.["com.docker.compose.service"] !== "openai-oauth" ||
      container.Config?.Labels?.["io.n8n-openai-oauth.managed"] !== "true") {
    throw new Error("The staged previous writer changed or is not stopped.");
  }
}

export async function reviewVpsLegacyMigration({
  remote, networkName, reviewedTarget, allowPending = false,
}) {
  validateReviewedTarget(remote, reviewedTarget, networkName);
  const verification = createVerificationCommands();
  await reattestReviewedTarget(remote, reviewedTarget);
  await runOrThrow(remote, SIDECAR_MANAGED_CONTEXT_GUARD, "Legacy managed context check");
  assertSidecarOnlyCommands(Object.values(verification));
  const state = await runOrThrow(remote, verification.legacyStatus, "Legacy VPS bridge ownership check");
  if (state.stdout.trim() !== "legacy" &&
      !(allowPending && state.stdout.trim() === "partial")) {
    throw new Error("The selected VPS sidecar is not the managed legacy bridge.");
  }
  const config = parseHandoffOutput(
    (await runOrThrow(remote, verification.managementConfig, "Legacy Compose ownership check")).stdout,
    "Legacy Compose ownership check",
  );
  const service = config?.services?.["openai-oauth"];
  if (Object.keys(config?.services ?? {}).length !== 1 ||
      config.networks?.["n8n-shared"]?.name !== networkName ||
      config.networks?.["n8n-shared"]?.external !== true ||
      service?.build?.context !== INSTALL_ROOT ||
      Array.isArray(service?.ports) && service.ports.length > 0 ||
      service?.volumes?.length !== 1 ||
      service.volumes[0].source !== `${INSTALL_ROOT}/auth` ||
      service.volumes[0].target !== "/home/node/.codex") {
    throw new Error("The old VPS bridge Compose target is not exactly owned.");
  }
  const inspected = await runOrThrow(remote, verification.ownerContainer, "Legacy container identity check");
  if (typeof inspected.stdout !== "string" ||
      Buffer.byteLength(inspected.stdout) > 64 * 1024) {
    throw new Error("The old VPS container identity is invalid.");
  }
  let container;
  try { container = JSON.parse(inspected.stdout); } catch {
    throw new Error("The old VPS container identity is invalid.");
  }
  const containerId = container?.Id;
  const imageId = container?.Image;
  const networkId = container?.NetworkSettings?.Networks?.[networkName]?.NetworkID;
  const mounts = container?.Mounts;
  if (!/^[a-f0-9]{64}$/u.test(containerId) ||
      !/^sha256:[a-f0-9]{64}$/u.test(imageId) ||
      typeof container?.State?.Running !== "boolean" ||
      container?.State?.Paused !== false ||
      container?.Config?.Labels?.["com.docker.compose.project"] !== "n8n-openai-oauth" ||
      container?.Config?.Labels?.["com.docker.compose.service"] !== "openai-oauth" ||
      container?.Config?.Labels?.["io.n8n-openai-oauth.managed"] !== "true" ||
      !Array.isArray(mounts) || mounts.length !== 1 ||
      mounts[0]?.Type !== "bind" ||
      mounts[0]?.Source !== `${INSTALL_ROOT}/auth` ||
      mounts[0]?.Destination !== "/home/node/.codex" ||
      (networkId && networkId !== reviewedTarget.networkId) ||
      (container.State.Running && !/^[a-f0-9]{64}$/u.test(networkId))) {
    throw new Error("The old VPS bridge container, image, network or credential root changed.");
  }
  const credential = await runOrThrow(remote, verification.legacyCredential, "Legacy credential ownership check");
  const authIdentity = credential.stdout.trim();
  if (!/^\d+:\d+:1000:600:\d+:\d+$/u.test(authIdentity)) {
    throw new Error("The old protected credential generation could not be attested.");
  }
  return Object.freeze({
    containerId, imageId, networkName,
    ...(networkId ? { networkId } : {}),
    authIdentity, running: container.State.Running,
  });
}

export async function reviewVpsSiwcReplacement({
  remote, networkName, reviewedTarget, allowStaged = false,
}) {
  validateReviewedTarget(remote, reviewedTarget, networkName);
  await reattestReviewedTarget(remote, reviewedTarget);
  const verification = createVerificationCommands();
  await runOrThrow(remote, SIDECAR_MANAGED_CONTEXT_GUARD, "Owned SIWC context check");
  const staging = await readStaging(remote, reviewedTarget, { allowTargetRefresh: allowStaged });
  if (!staging || (!allowStaged && staging.checkpoint.stage !== "complete")) {
    throw new Error("The VPS SIWC installation is not finalized. Review resume instead.");
  }
  await attestStagedFiles(remote, staging.checkpoint);
  const config = parseHandoffOutput(
    (await runOrThrow(remote, verification.managementConfig, "Sidecar Compose ownership check")).stdout,
    "Sidecar Compose ownership check", 64 * 1024,
  );
  const registrationId = attestVpsSiwcCompose(config, networkName);
  const expectedImageId = staging.checkpoint.imageId ?? staging.checkpoint.existingBinding?.imageId;
  if (!expectedImageId) throw new Error("The owned SIWC image was not recorded.");
  const imageId = await attestInstalledImage(remote, { imageId: expectedImageId });
  const container = parseHandoffOutput(
    (await runOrThrow(remote, verification.ownerContainer, "Owned sidecar identity check")).stdout,
    "Owned sidecar identity check", 64 * 1024,
  );
  const owner = attestVpsSiwcContainer(container, {
    service: config.services["openai-oauth"], networkName,
    networkId: reviewedTarget.networkId, imageId,
  });
  if (staging.checkpoint.containerId && owner.containerId !== staging.checkpoint.containerId) {
    throw new Error("The installed SIWC container identity changed.");
  }
  return Object.freeze({ registrationId, ...owner, networkName, networkId: reviewedTarget.networkId });
}

export async function getVpsSiwcInstallationStatus({
  remote, networkName, reviewedTarget,
}, { collectAssets = collectSiwcRuntimeAssets } = {}) {
  validateReviewedTarget(remote, reviewedTarget, networkName);
  await reattestReviewedTarget(remote, reviewedTarget);
  const staging = await readStaging(remote, reviewedTarget, { allowTargetRefresh: true });
  if (staging && staging.checkpoint.stage !== "complete") {
    const { installId, registrationId, stage } = staging.checkpoint;
    return { state: staging.checkpoint.runtimeUpdate ? "updating" : "staged",
      staging: { installId, registrationId, stage } };
  }
  const verification = createVerificationCommands();
  assertSidecarOnlyCommands(Object.values(verification));
  const state = await runOrThrow(remote, verification.legacyStatus, "VPS sidecar ownership check");
  if (state.stdout.trim() === "legacy") return { state: "legacy" };
  if (state.stdout.trim() === "partial") {
    return { state: "partial", migrationRequired: true, legacyResourcesPreserved: true };
  }
  if (state.stdout.trim() === "absent") return { state: "absent" };
  if (state.stdout.trim() !== "managed") {
    throw new Error("The VPS sidecar ownership state is invalid.");
  }
  const owner = await reviewVpsSiwcReplacement({ remote, networkName, reviewedTarget });
  const { registrationId } = owner;
  if (!owner.running) return { state: "stopped", registrationId };
  const account = await attestLiveAccount(remote, registrationId);
  let runtimeUpdateAvailable;
  try {
    runtimeUpdateAvailable = staging.checkpoint.imageSourceSha256 !==
      imageSourceDigest(managedRuntimeFiles(await collectAssets()));
  } catch { /* Without this version's runtime files the update state is unknown, not current. */ }
  return { state: "owned", registrationId, account,
    ...(runtimeUpdateAvailable === undefined ? {} : { runtimeUpdateAvailable }) };
}

export async function reviewVpsSiwcRuntimeUpdate(
  { remote, networkName, reviewedTarget, registrationId },
  { collectAssets = collectSiwcRuntimeAssets } = {},
) {
  validateReviewedTarget(remote, reviewedTarget, networkName);
  validateSiwcRegistrationId(registrationId);
  await reattestReviewedTarget(remote, reviewedTarget);
  const staging = await readStaging(remote, reviewedTarget, { allowTargetRefresh: true });
  const checkpoint = staging?.checkpoint;
  const update = checkpoint?.runtimeUpdate;
  if (!checkpoint || checkpoint.registrationId !== registrationId ||
      (!update && checkpoint.stage !== "complete")) {
    throw new Error("There is no matching installed SIWC sidecar to update.");
  }
  await attestStagedFiles(remote, checkpoint);
  let containerId = update?.fromContainerId;
  let imageId = checkpoint.imageId;
  if (update) {
    if (!validRuntimeUpdate(update) || !IMAGE_ID.test(imageId)) {
      throw new Error("The interrupted sidecar update record is invalid.");
    }
  } else {
    const owner = await reviewVpsSiwcReplacement({ remote, networkName, reviewedTarget });
    if (owner.registrationId !== registrationId) {
      throw new Error("The installed SIWC account differs from the reviewed selection.");
    }
    if (!owner.running) throw new Error("Turn plan use back on before updating.");
    await attestLiveAccount(remote, registrationId);
    ({ containerId, imageId } = owner);
  }
  const lock = await inspectResumeLock(remote, !!update);
  const files = managedRuntimeFiles(await collectAssets());
  const imageSourceSha256 = imageSourceDigest(files);
  const changedFiles = [...files].filter(([path, contents]) => checkpoint.files?.[path] !== sha256(contents))
    .map(([path]) => path.slice(INSTALL_ROOT.length + 1)).sort();
  return Object.freeze({
    installId: checkpoint.installId, registrationId, stage: checkpoint.stage,
    continuing: !!update, checkpointSha256: staging.checkpointSha256, containerId, imageId,
    changedFiles, imageSourceSha256, rebuildRequired: !!update || changedFiles.length > 0 ||
      checkpoint.imageSourceSha256 !== imageSourceSha256,
    ...(lock ? { operationLockIdentity: lock } : {}),
  });
}

function validRuntimeUpdate(update) {
  return DOCKER_ID.test(update?.fromContainerId) && IMAGE_ID.test(update.fromImageId) &&
    (update.fromImageSourceSha256 === undefined || /^[a-f0-9]{64}$/u.test(update.fromImageSourceSha256)) &&
    (update.builtImageIds === undefined || (Array.isArray(update.builtImageIds) &&
      update.builtImageIds.length <= 8 && update.builtImageIds.every(id => IMAGE_ID.test(id))));
}

export async function updateVpsSiwcRuntime(
  { remote, networkName, reviewedTarget, registrationId, review, confirmed },
  { collectAssets = collectSiwcRuntimeAssets } = {},
) {
  if (confirmed !== true || review?.rebuildRequired !== true || review.registrationId !== registrationId) {
    throw new Error("Review and confirm the sidecar update before applying it.");
  }
  validateSiwcRegistrationId(registrationId);
  validateReviewedTarget(remote, reviewedTarget, networkName);
  const verification = createVerificationCommands();
  const deploymentCommands = createDeploymentCommands();
  assertSidecarOnlyCommands([SIDECAR_MANAGED_CONTEXT_GUARD, ...deploymentCommands.slice(1),
    ...Object.values(verification)]);
  const files = managedRuntimeFiles(await collectAssets());
  const imageSourceSha256 = imageSourceDigest(files);
  if (imageSourceSha256 !== review.imageSourceSha256) {
    throw new Error("This Relmio version's sidecar files differ from the review. Review the update again.");
  }
  const reviewChanged = "The installed sidecar changed after review. Review the update again.";
  return withVpsOperationLock(remote, VPS_OPERATION_LOCKS.oauth, async build => {
    await reattestReviewedTarget(remote, reviewedTarget);
    await runOrThrow(remote, SIDECAR_MANAGED_CONTEXT_GUARD, "Managed SIWC context check");
    const staging = await readStaging(remote, reviewedTarget, { allowTargetRefresh: true });
    if (!staging || staging.checkpointSha256 !== review.checkpointSha256) throw new Error(reviewChanged);
    const { checkpoint } = staging;
    if (checkpoint.runtimeUpdate && !validRuntimeUpdate(checkpoint.runtimeUpdate)) {
      throw new Error("The interrupted sidecar update record is invalid.");
    }
    // Whatever an earlier attempt left on disk stays attestable if this attempt is interrupted.
    checkpoint.previousFiles = await attestStagedFiles(remote, checkpoint);
    const config = parseHandoffOutput((await runOrThrow(remote, verification.managementConfig,
      "Sidecar Compose ownership check")).stdout, "Sidecar Compose ownership check", 64 * 1024);
    if (attestVpsSiwcCompose(config, networkName) !== registrationId) throw new Error(reviewChanged);
    const service = config.services["openai-oauth"];
    if (!checkpoint.runtimeUpdate) {
      const owner = await reviewVpsSiwcReplacement({ remote, networkName, reviewedTarget });
      if (!owner.running || owner.registrationId !== registrationId ||
          owner.containerId !== review.containerId || owner.imageId !== review.imageId) {
        throw new Error(reviewChanged);
      }
      checkpoint.runtimeUpdate = { fromImageId: owner.imageId, fromContainerId: owner.containerId,
        fromImageSourceSha256: checkpoint.imageSourceSha256 };
    }
    checkpoint.files = { ...checkpoint.files,
      ...Object.fromEntries([...files].map(([path, contents]) => [path, sha256(contents)])) };
    checkpoint.reviewedTarget = Object.fromEntries(TARGET_FIELDS.map(field => [field, reviewedTarget[field]]));
    await publishCheckpoint(remote, checkpoint, "context");

    const inspectContainer = async () => parseHandoffOutput((await runOrThrow(remote,
      verification.ownerContainer, "Previous sidecar identity check")).stdout,
    "Previous sidecar identity check", 64 * 1024);
    // Only the original writer or a container on an image this update built is recognized.
    const attestUpdateContainer = container => {
      const { fromImageId, fromContainerId, builtImageIds = [] } = checkpoint.runtimeUpdate;
      const original = container?.Image === fromImageId;
      if (!original && !builtImageIds.includes(container?.Image)) {
        throw new Error("The previous sidecar container changed. Review the update again.");
      }
      const attested = attestVpsSiwcContainer(container, { service, networkName,
        networkId: reviewedTarget.networkId, imageId: container.Image });
      if (original && attested.containerId !== fromContainerId) {
        throw new Error("The previous sidecar container changed. Review the update again.");
      }
      return attested;
    };

    await runOrThrow(remote, deploymentCommands[1], "SIWC storage directory creation");
    await runOrThrow(remote, deploymentCommands[2], "Sidecar source directory creation");
    await runOrThrow(remote, SIDECAR_MANAGED_CONTEXT_GUARD, "SIWC source-directory check");
    for (const [path, contents] of files) await remote.publishManagedFile(path, contents, 0o644);
    await runOrThrow(remote, deploymentCommands[3], "Sidecar Compose validation");

    // Always rebuild: a continuation never trusts an image it did not record.
    try {
      await build(deploymentCommands[4]);
    } catch (error) {
      if (error?.remoteOutcomeUnknown || error?.timedOut) throw error;
      const { fromImageId, fromContainerId, fromImageSourceSha256 } = checkpoint.runtimeUpdate;
      try {
        await attestInstalledImage(remote, { imageId: fromImageId });
        const owner = attestVpsSiwcContainer(await inspectContainer(), { service, networkName,
          networkId: reviewedTarget.networkId, imageId: fromImageId });
        if (!owner.running || owner.containerId !== fromContainerId) throw new Error(reviewChanged);
      } catch { throw error; }
      // The confirmed failure left the original image tag and writer running: record them as installed.
      const onDisk = await attestStagedFiles(remote, checkpoint);
      delete checkpoint.runtimeUpdate;
      Object.assign(checkpoint, { imageId: fromImageId, containerId: fromContainerId, files: onDisk });
      if (fromImageSourceSha256 === undefined) delete checkpoint.imageSourceSha256;
      else checkpoint.imageSourceSha256 = fromImageSourceSha256;
      await publishCheckpoint(remote, checkpoint, "complete");
      const message = "The sidecar image build failed. The previous sidecar keeps running; review the update again later.";
      throw Object.assign(new Error(message), {
        safeMessage: message, recovery: "review-again", runtimeState: "running", hostPublication: "none",
      });
    }
    await build.releaseState();
    const imageId = await attestInstalledImage(remote, {});
    const { builtImageIds = [] } = checkpoint.runtimeUpdate;
    checkpoint.runtimeUpdate = { ...checkpoint.runtimeUpdate,
      builtImageIds: [...builtImageIds.filter(id => id !== imageId), imageId].slice(-8) };
    Object.assign(checkpoint, { imageId, imageSourceSha256, containerId: undefined });
    await publishCheckpoint(remote, checkpoint, "built");

    if ((await runOrThrow(remote, verification.ownerPresence, "Previous sidecar presence check")).stdout.trim()) {
      const container = await inspectContainer();
      // A container on the new image was started by this update after the built journal.
      if (container?.Image !== imageId) {
        const previous = attestUpdateContainer(container);
        if (previous.running) {
          await reattestReviewedTarget(remote, reviewedTarget);
          try { await remote.exec(verification.stop, { timeoutMs: 90_000 }); }
          catch { /* A lost stop acknowledgment is resolved by exact container inspection. */ }
          const stopped = attestUpdateContainer(await inspectContainer());
          if (stopped.running || stopped.containerId !== previous.containerId) {
            throw new Error("The previous sidecar did not stop. The updated sidecar was not started.");
          }
        }
      }
    }

    let owner;
    let account;
    try {
      await runOrThrow(remote, deploymentCommands.at(-1), "Updated sidecar start");
      const running = await runOrThrow(remote, verification.runningService, "Updated sidecar status");
      if (!running.stdout.split(/\s+/u).includes("openai-oauth")) {
        throw new Error("The updated sidecar did not reach the running state.");
      }
      const publication = await runOrThrow(remote, verification.publicationState, "Sidecar publication check");
      if (hasPublishedHostPort(publication.stdout)) throw new Error("Unexpected sidecar host publication.");
      owner = await reviewVpsSiwcReplacement({ remote, networkName, reviewedTarget, allowStaged: true });
      if (!owner.running || owner.imageId !== imageId || owner.registrationId !== registrationId) {
        throw new Error("The updated sidecar could not be attested.");
      }
      account = await attestLiveAccount(remote, registrationId);
    } catch (cause) {
      let stopped = await stopAttestedService(remote, reviewedTarget);
      if (!stopped) {
        // The start may have failed before recreation, leaving the original writer stopped.
        try { stopped = !attestUpdateContainer(await inspectContainer()).running; }
        catch { /* An unrecognized container is never declared stopped. */ }
      }
      throw Object.assign(new Error(stopped
        ? "The sidecar update could not be verified. The sidecar was stopped; review the update again to finish it."
        : "The sidecar update could not be verified and stopping could not be confirmed. Do not use the sidecar."), {
        safeMessage: stopped
          ? "The sidecar update could not be verified. The sidecar was stopped; review the update again."
          : "The sidecar update and stop outcomes are unknown. Inspect the sidecar before use.",
        recovery: "review-again", runtimeState: stopped ? "stopped" : "unknown",
        hostPublication: stopped ? "none" : "unknown",
        ...(stopped ? {} : { remoteOutcomeUnknown: true }),
        ...(cause?.timedOut ? { timedOut: true } : {}),
      });
    }
    delete checkpoint.runtimeUpdate;
    checkpoint.containerId = owner.containerId;
    await publishCheckpoint(remote, checkpoint, "complete");
    return { registrationId, imageId, containerId: owner.containerId, account,
      runtimeState: "running", keyChanged: false };
  }, { resumeIdentity: review.operationLockIdentity });
}

export async function inspectStoppedVpsSiwcInstallation({
  remote, networkName, registrationId, reviewedTarget, confirmed,
}) {
  if (confirmed !== true) throw new Error("Confirm inspection of the installed SIWC account.");
  validateSiwcRegistrationId(registrationId);
  validateReviewedTarget(remote, reviewedTarget, networkName);
  const verification = createVerificationCommands();
  assertSidecarOnlyCommands([PRECHECK_COMMAND, ...Object.values(verification)]);
  const reviewedOwner = await reviewVpsSiwcReplacement({ remote, networkName, reviewedTarget });
  if (reviewedOwner.registrationId !== registrationId || reviewedOwner.running) {
    throw new Error("The selected stopped SIWC owner changed.");
  }
  return withVpsOperationLock(remote, VPS_OPERATION_LOCKS.oauth, async () => {
    const owner = await reviewVpsSiwcReplacement({ remote, networkName, reviewedTarget });
    if (owner.running || owner.containerId !== reviewedOwner.containerId ||
        owner.imageId !== reviewedOwner.imageId || owner.registrationId !== registrationId) {
      throw new Error("The selected stopped SIWC owner changed.");
    }
    const account = parseHandoffOutput(
      (await runOrThrow(remote, verification.account, "Stopped SIWC account inspection")).stdout,
      "Stopped SIWC account inspection",
    ).account;
    if (account?.registrationId !== registrationId || account?.ownership !== "owned" ||
        account?.ownerRuntimeId !== "vps_n8n") {
      throw new Error("The stopped SIWC account could not be attested.");
    }
    return { account };
  });
}

export async function manageVpsSiwcInstallation({
  remote, networkName, registrationId, action, expectedGeneration,
  reviewedTarget, backgroundConsent, confirmed,
}) {
  if (confirmed !== true ||
      !["sign-out", "disable-plan", "enable-plan"].includes(action) ||
      (action === "enable-plan" && backgroundConsent !== true)) {
    throw new Error("Confirm the selected installed SIWC account and background workflow consent.");
  }
  validateSiwcRegistrationId(registrationId);
  if (typeof expectedGeneration !== "string" ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(expectedGeneration)) {
    throw new TypeError("The selected SIWC account generation is invalid.");
  }
  validateReviewedTarget(remote, reviewedTarget, networkName);
  const verification = createVerificationCommands();
  const startCommand = createDeploymentCommands().at(-1);
  assertSidecarOnlyCommands([PRECHECK_COMMAND, startCommand, ...Object.values(verification)]);
  const reviewedOwner = await reviewVpsSiwcReplacement({ remote, networkName, reviewedTarget });
  if (reviewedOwner.registrationId !== registrationId) {
    throw new Error("The installed SIWC account differs from the reviewed selection.");
  }
  return withVpsOperationLock(remote, VPS_OPERATION_LOCKS.oauth, async () => {
    const owner = await reviewVpsSiwcReplacement({ remote, networkName, reviewedTarget });
    if (owner.containerId !== reviewedOwner.containerId ||
        owner.imageId !== reviewedOwner.imageId || owner.registrationId !== registrationId) {
      throw new Error("The reviewed installed SIWC owner changed.");
    }
    const before = parseHandoffOutput(
      (await runOrThrow(remote, verification.account, "Destination SIWC account check")).stdout,
      "Destination SIWC account check",
    ).account;
    if (before?.registrationId !== registrationId ||
        before?.generation !== expectedGeneration ||
        before?.ownership !== "owned") {
      throw new Error("The installed SIWC account changed; review it again.");
    }
    if (action === "enable-plan" &&
        (before.planPermission !== "granted" || before.session !== "connected")) {
      throw new Error("This installed account needs a fresh authorized SIWC sign-in before plan use can resume.");
    }
    await reattestReviewedTarget(remote, reviewedTarget);
    await runOrThrow(remote, verification.stop, "Owned sidecar stop");
    const running = await runOrThrow(remote, verification.runningService, "Owned sidecar stopped check");
    if (running.stdout.split(/\s+/u).includes("openai-oauth")) {
      throw new Error("The owned sidecar did not stop; account mutation was not attempted.");
    }
    const stoppedOwner = await reviewVpsSiwcReplacement({ remote, networkName, reviewedTarget });
    if (stoppedOwner.running || stoppedOwner.containerId !== owner.containerId ||
        stoppedOwner.imageId !== owner.imageId || stoppedOwner.registrationId !== registrationId) {
      throw new Error("The stopped SIWC owner changed. Account mutation was not attempted.");
    }
    const command = action === "sign-out" ? verification.signOut
      : action === "enable-plan" ? verification.enablePlan : verification.disablePlan;
    const input = JSON.stringify({
      registrationId, expectedGeneration,
      ...(action === "enable-plan" ? { backgroundConsent: true } : {}),
    });
    const changed = parseHandoffOutput(
      (await runOrThrow(remote, command, "Destination SIWC account operation", input)).stdout,
      "Destination SIWC account operation",
    );
    if (changed.account?.registrationId !== registrationId ||
        changed.account?.ownerHostId !== before.ownerHostId ||
        changed.account?.ownerRuntimeId !== "vps_n8n" ||
        changed.account?.ownership !== "owned") {
      throw new Error("The destination SIWC account result could not be attested.");
    }
    if (action === "enable-plan") {
      if (changed.account.planEnabled !== true ||
          changed.account.planPermission !== "granted") {
        throw new Error("The destination SIWC grant could not be confirmed. The service remains stopped.");
      }
      try {
        await runOrThrow(remote, startCommand, "Owned SIWC sidecar start");
        const started = await runOrThrow(remote, verification.runningService, "Owned SIWC sidecar status");
        if (!started.stdout.split(/\s+/u).includes("openai-oauth")) {
          throw new Error("The owned sidecar did not reach the running state.");
        }
        const publication = await runOrThrow(remote, verification.publicationState, "Sidecar publication check");
        if (hasPublishedHostPort(publication.stdout)) throw new Error("Unexpected sidecar host publication.");
        const live = await reviewVpsSiwcReplacement({ remote, networkName, reviewedTarget });
        if (live.containerId !== owner.containerId || live.imageId !== owner.imageId || !live.running) {
          throw new Error("The enabled SIWC owner changed.");
        }
      } catch (cause) {
        const stopped = await stopAttestedService(remote, reviewedTarget, owner);
        throw Object.assign(new Error(stopped
          ? "SIWC enable verification failed. The attested service was stopped; review before enabling again."
          : "SIWC enable verification failed and stopping could not be confirmed. Do not use the service."), {
          safeMessage: stopped
            ? "SIWC enable verification failed. The attested service was stopped."
            : "SIWC enable and stop outcomes are unknown. Inspect the owned service before use.",
          recovery: "resolve-handoff", runtimeState: stopped ? "stopped" : "unknown",
          hostPublication: stopped ? "none" : "unknown",
          ...(stopped ? {} : { remoteOutcomeUnknown: true }),
          ...(cause?.timedOut ? { timedOut: true } : {}),
        });
      }
    }
    return {
      account: changed.account, revocation: changed.revocation,
      runtimeStopped: action !== "enable-plan",
    };
  });
}

async function stopAttestedService(remote, reviewedTarget, expectedOwner) {
  const verification = createVerificationCommands();
  try {
    await reattestReviewedTarget(remote, reviewedTarget);
    const presence = await runOrThrow(remote, verification.ownerPresence, "Owned service presence check");
    if (!presence.stdout.trim()) return !expectedOwner;
    const owner = await reviewVpsSiwcReplacement({
      remote, networkName: reviewedTarget.networkName, reviewedTarget, allowStaged: true,
    });
    if (expectedOwner && (owner.containerId !== expectedOwner.containerId ||
        owner.imageId !== expectedOwner.imageId)) return false;
    try { await remote.exec(verification.stop, { timeoutMs: 90_000 }); }
    catch { /* A lost stop acknowledgment is resolved by exact container inspection. */ }
    const stopped = await reviewVpsSiwcReplacement({
      remote, networkName: reviewedTarget.networkName, reviewedTarget, allowStaged: true,
    });
    return !stopped.running && stopped.containerId === owner.containerId && stopped.imageId === owner.imageId;
  } catch {
    if (!expectedOwner) {
      try {
        await reattestReviewedTarget(remote, reviewedTarget);
        const staging = await readStaging(remote, reviewedTarget, { allowTargetRefresh: true });
        if (staging?.checkpoint.legacyBinding || staging?.checkpoint.existingBinding) {
          await attestStoppedPreviousContainer(remote, staging.checkpoint);
          return true;
        }
      } catch { /* An unrecognized container is never stopped or declared safe. */ }
    }
    return false;
  }
}

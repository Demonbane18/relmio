import {
  createVpsLockCommand, releaseVpsLockCommand, createVpsBuildStateCommand,
  scopeVpsBuildCommand, cleanupVpsBuildStateCommand,
  claimVpsResumeLockCommand, releaseVpsResumeClaimCommand,
} from "../domain/vps-build-state.js";

const validIdentity = value => typeof value === "string" && /^\d+:\d+$/u.test(value);
const recoveryMessage = lock => `Temporary build state or the operation lock could not be safely removed. An administrator must inspect ${lock} before retrying; Relmio will not delete uncertain or pre-existing state.`;

// Call only after the service's final-confirmation gate. Build state is lazy:
// status, removal and cached retries never create it. Grok credential launches
// use Compose run, which may build a missing image and therefore needs isolation.
export async function withVpsOperationLock(remote, lock, operation, { resumeIdentity } = {}) {
  const uncertainMessage = `The operation lock is held or uncertain. An administrator must inspect ${lock} before retrying.`;
  let acquired;
  let claimIdentity;
  try {
    acquired = await remote.exec(resumeIdentity
      ? claimVpsResumeLockCommand(lock, resumeIdentity) : createVpsLockCommand(lock));
  } catch (cause) {
    throw Object.assign(new Error(uncertainMessage, { cause }), {
      safeMessage: uncertainMessage, operationLockRetained: true,
      ...(cause?.remoteOutcomeUnknown === true ? { remoteOutcomeUnknown: true } : {}),
      ...(cause?.timedOut === true ? { timedOut: true } : {}),
    });
  }
  if (resumeIdentity) claimIdentity = acquired.stdout?.trim();
  const identity = resumeIdentity ?? acquired.stdout?.trim();
  if (acquired.code !== 0 || !validIdentity(identity) ||
      (resumeIdentity && !validIdentity(claimIdentity))) {
    throw Object.assign(new Error(uncertainMessage), {
      safeMessage: uncertainMessage, operationLockRetained: true,
    });
  }
  let stateIdentity;
  let stateUncertain = false;
  let buildUncertain = false;
  let primary;
  let result;
  const build = async command => {
    if (!stateIdentity) {
      stateUncertain = true;
      const created = await remote.exec(createVpsBuildStateCommand(lock, identity));
      stateIdentity = created.stdout?.trim();
      if (created.code !== 0 || !validIdentity(stateIdentity)) {
        stateIdentity = undefined;
        throw new Error(recoveryMessage(lock));
      }
      stateUncertain = false;
    }
    const scoped = scopeVpsBuildCommand(lock, identity, stateIdentity, command);
    buildUncertain = true;
    const built = await remote.exec(scoped, { timeoutMs: 1_800_000 });
    if (!Number.isInteger(built?.code)) throw Object.assign(
      new Error("The companion build result could not be confirmed."), { remoteOutcomeUnknown: true });
    buildUncertain = false;
    if (built.code !== 0) throw new Error("The confirmed companion image build or launch failed. The existing n8n deployment was not changed.");
  };
  build.releaseState = async () => {
    if (!stateIdentity || stateUncertain || buildUncertain) throw new Error(recoveryMessage(lock));
    stateUncertain = true;
    const removed = await remote.exec(cleanupVpsBuildStateCommand(lock, identity, stateIdentity));
    if (removed.code !== 0) throw new Error(recoveryMessage(lock));
    stateIdentity = undefined;
    stateUncertain = false;
  };
  try {
    result = await operation(build);
  } catch (error) {
    primary = error;
  }
  let cleanupFailed = stateUncertain || buildUncertain ||
    primary?.remoteOutcomeUnknown === true || result?.remoteOutcomeUnknown === true;
  try {
    // A disconnected exec may leave Compose running. Never clean underneath it.
    if (!cleanupFailed && stateIdentity && (await remote.exec(cleanupVpsBuildStateCommand(lock, identity, stateIdentity))).code !== 0) cleanupFailed = true;
    if (!cleanupFailed && claimIdentity &&
        (await remote.exec(releaseVpsResumeClaimCommand(lock, identity, claimIdentity))).code !== 0) cleanupFailed = true;
    // Never release an uncertain lease, even if a foreign actor emptied it.
    if (!cleanupFailed && (await remote.exec(releaseVpsLockCommand(lock, identity))).code !== 0) cleanupFailed = true;
  } catch {
    cleanupFailed = true;
  }
  if (cleanupFailed) {
    const message = recoveryMessage(lock);
    if (!primary && result?.credentialShownOnce === true && typeof result.clientCredential === "string") {
      const partial = {
        ...result, deploymentMode: "partial", readiness: "unverified",
        operationLockRetained: true,
        finalizationFailure: { error: message, recovery: "resolve-handoff" },
      };
      if (result.migratedLegacy === true) partial.migrationPending = true;
      if (result.replacedAccount === true) partial.replacementPending = true;
      delete partial.migratedLegacy;
      delete partial.replacedAccount;
      return partial;
    }
    if (primary) {
      // Keep the primary exception and recovery classification; add only fixed,
      // safe cleanup text, never remote command output or credential material.
      primary.message = `${primary.message} ${message}`;
      primary.safeMessage = `${primary.safeMessage ?? "The confirmed operation failed."} ${message}`;
      primary.operationLockRetained = true;
      throw primary;
    }
    throw Object.assign(new Error(message), { safeMessage: message, operationLockRetained: true });
  }
  if (primary) throw primary;
  return result;
}

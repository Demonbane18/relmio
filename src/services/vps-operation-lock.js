import {
  createVpsLockCommand, releaseVpsLockCommand, createVpsBuildStateCommand,
  scopeVpsBuildCommand, cleanupVpsBuildStateCommand,
} from "../domain/vps-build-state.js";

const validIdentity = value => typeof value === "string" && /^\d+:\d+$/u.test(value);
const recoveryMessage = lock => `Temporary build state or the operation lock could not be safely removed. An administrator must inspect ${lock} before retrying; Relmio will not delete uncertain or pre-existing state.`;

// Call only after the service's final-confirmation gate. Build state is lazy:
// status, removal and cached retries never create it. Grok credential launches
// use Compose run, which may build a missing image and therefore needs isolation.
export async function withVpsOperationLock(remote, lock, operation) {
  const uncertainMessage = `The operation lock is held or uncertain. An administrator must inspect ${lock} before retrying.`;
  let acquired;
  try {
    acquired = await remote.exec(createVpsLockCommand(lock));
  } catch (cause) {
    throw Object.assign(new Error(uncertainMessage, { cause }), {
      safeMessage: uncertainMessage, operationLockRetained: true,
    });
  }
  const identity = acquired.stdout?.trim();
  if (acquired.code !== 0 || !validIdentity(identity)) {
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
    const built = await remote.exec(scoped);
    if (!Number.isInteger(built?.code)) throw new Error("The companion build result could not be confirmed.");
    buildUncertain = false;
    if (built.code !== 0) throw new Error("The confirmed companion image build or launch failed. The existing n8n deployment was not changed.");
  };
  try {
    result = await operation(build);
  } catch (error) {
    primary = error;
  }
  let cleanupFailed = stateUncertain || buildUncertain || primary?.remoteOutcomeUnknown === true;
  try {
    // A disconnected exec may leave Compose running. Never clean underneath it.
    if (!cleanupFailed && stateIdentity && (await remote.exec(cleanupVpsBuildStateCommand(lock, identity, stateIdentity))).code !== 0) cleanupFailed = true;
    // Never release an uncertain lease, even if a foreign actor emptied it.
    if (!cleanupFailed && (await remote.exec(releaseVpsLockCommand(lock, identity))).code !== 0) cleanupFailed = true;
  } catch {
    cleanupFailed = true;
  }
  if (cleanupFailed) {
    const message = recoveryMessage(lock);
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

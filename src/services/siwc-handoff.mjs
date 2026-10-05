import { pathToFileURL } from "node:url";
import { listSiwcModels } from "../gateway/openai-oauth-sidecar.mjs";
import {
  acceptAuthHandoff, ensureSiwcHost, readSiwcHost, listRegistrations,
  readAuthHandoffReceipt, readRegistration, readRegistrationView, setPlanEnabled, signOut,
} from "./siwc-session.mjs";

const MAX_HANDOFF_BYTES = 128 * 1024;
const MAX_RECEIPT_BYTES = 8 * 1024;

async function readOperationInput(input, limit) {
  const chunks = [];
  let length = 0;
  for await (const chunk of input) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += bytes.length;
    if (length > limit) throw new TypeError("SIWC operation exceeded the size limit.");
    chunks.push(bytes);
  }
  if (length === 0) throw new TypeError("SIWC operation is empty.");
  return Buffer.concat(chunks, length);
}

export async function runSiwcHandoffCli({
  command,
  storageRoot = process.env.N8N_OPENAI_OAUTH_HOME,
  runtimeId = process.env.RELMIO_RUNTIME_ID,
  registrationId = process.env.RELMIO_REGISTRATION_ID,
  input = process.stdin,
  output = process.stdout,
  sessionDeps = {},
} = {}) {
  if (!["host", "account", "models", "accept", "receipt", "sign-out", "disable-plan", "enable-plan"].includes(command)) {
    throw new TypeError("Invalid SIWC handoff operation.");
  }
  if (command === "receipt") {
    const contents = await readOperationInput(input, MAX_RECEIPT_BYTES);
    const request = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(contents));
    if (!request || typeof request !== "object" ||
        Object.keys(request).sort().join(",") !== "binding,handoffId,identity") {
      throw new TypeError("SIWC handoff receipt selection is invalid.");
    }
    const receipt = await readAuthHandoffReceipt({ storageRoot, registrationId }, {
      runtimeId, handoffId: request.handoffId, expectedTarget: request.binding?.target,
      expectedBinding: request.binding, identity: request.identity,
    }, sessionDeps);
    output.write(`${JSON.stringify({ receipt })}\n`);
    return;
  }
  const target = await (command === "host"
    ? ensureSiwcHost({ storageRoot, runtimeId }, sessionDeps)
    : readSiwcHost({ storageRoot, runtimeId }, sessionDeps));
  if (command === "host") {
    output.write(`${JSON.stringify(target)}\n`);
    return;
  }
  if (command === "account" || command === "models") {
    const account = (await listRegistrations({ storageRoot }, sessionDeps)).find(
      candidate => candidate.registrationId === registrationId,
    );
    if (!account || account.identity !== "verified" || account.ownership !== "owned" ||
        account.ownerHostId !== target.hostId || account.ownerRuntimeId !== runtimeId) {
      throw new Error("SIWC account is not owned by this installation.");
    }
    if (command === "models") {
      const models = await listSiwcModels({
        storageRoot, registrationId, runtimeId,
        fetchImpl: sessionDeps.fetchImpl ?? fetch,
      });
      output.write(`${JSON.stringify({ models })}\n`);
    } else {
      output.write(`${JSON.stringify({ account })}\n`);
    }
    return;
  }
  const contents = await readOperationInput(input, command === "accept" ? MAX_HANDOFF_BYTES : 4096);
  if (command === "accept") {
    const result = await acceptAuthHandoff({
      storageRoot, runtimeId, expectedTarget: target, expectedRegistrationId: registrationId, contents,
    }, sessionDeps);
    const account = await readRegistrationView({ storageRoot, registrationId }, sessionDeps);
    if (account?.identity !== "verified" || account?.ownership !== "owned" ||
        account?.ownerHostId !== target.hostId ||
        account?.ownerRuntimeId !== runtimeId) {
      throw new Error("The accepted SIWC registration does not match this installation.");
    }
    output.write(`${JSON.stringify({ ...result, account })}\n`);
    return;
  }
  const request = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(contents));
  if (request?.registrationId !== registrationId || typeof request?.expectedGeneration !== "string") {
    throw new TypeError("SIWC management selection is invalid.");
  }
  const registration = { storageRoot, registrationId };
  const current = await readRegistration(registration, sessionDeps);
  if (
    current?.owner?.hostId !== target.hostId ||
    current?.owner?.runtimeId !== runtimeId ||
    current?.generation !== request.expectedGeneration ||
    current?.handoff?.state !== "owned"
  ) throw new Error("The selected SIWC account changed.");
  if (command === "enable-plan" &&
      current.backgroundConsent && request.backgroundConsent !== true) {
    throw new Error("Background workflow consent must be confirmed for this installation.");
  }
  const result = command === "sign-out"
    ? await signOut(registration, { runtimeId }, sessionDeps)
    : { account: await setPlanEnabled(registration, {
      enabled: command === "enable-plan", expectedGeneration: request.expectedGeneration,
    }, sessionDeps), revocation: "not-applicable" };
  output.write(`${JSON.stringify(result)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runSiwcHandoffCli({ command: process.argv[2] }).catch(() => {
    process.stderr.write("SIWC handoff failed. Inspect the selected installation before retrying.\n");
    process.exitCode = 1;
  });
}

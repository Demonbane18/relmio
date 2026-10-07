import { isAbsolute, normalize } from "node:path";
import {
  runLocalProcess,
  validateLocalDockerHost,
} from "../infrastructure/local-process.js";
import { validateSiwcRegistrationId } from "../domain/safety.js";

const SERVICES = Object.freeze({ "codex-chatgpt": "codex", "codex-chat": "codex-chat" });
const COMMANDS = new Set(["host", "accept", "receipt", "account", "account-live", "models", "sign-out", "disable-plan", "enable-plan"]);

/** Run the installed, registration-scoped SIWC session manager in an owned Codex image. */
export async function runCodexSiwcCommand({
  target, installRoot, dockerHost, projectName, command, input, registrationId,
  runProcess = runLocalProcess,
}) {
  const service = SERVICES[target];
  if (!service || !COMMANDS.has(command) ||
      typeof installRoot !== "string" || !isAbsolute(installRoot) ||
      normalize(installRoot) !== installRoot ||
      typeof projectName !== "string" ||
      !new RegExp(`^relmio-${target}-[a-f0-9]{32}$`, "u").test(projectName)) {
    throw new TypeError("The installed Codex SIWC operation is invalid.");
  }
  validateLocalDockerHost(dockerHost);
  if (command === "accept" || command === "receipt") validateSiwcRegistrationId(registrationId);
  if (input !== undefined && (!Buffer.isBuffer(input) || input.length === 0 || input.length > 128 * 1024)) {
    throw new TypeError("The protected SIWC operation input is invalid.");
  }
  if (command === "receipt" && (!Buffer.isBuffer(input) || input.length > 8192)) {
    throw new TypeError("The handoff receipt request is invalid.");
  }
  const live = command === "account-live" || command === "models";
  const result = await runProcess({
    file: "docker",
    args: live
      ? [
          "compose", "--project-name", projectName, "--file", "docker-compose.yml",
          "exec", "-T", service, "node", "/app/services/siwc-handoff.mjs",
          command === "account-live" ? "account" : command,
        ]
      : [
          "compose", "--project-name", projectName, "--file", "docker-compose.yml",
          "run", "--rm", "--no-deps", "-T",
          ...(["accept", "receipt"].includes(command)
            ? ["--env", `RELMIO_REGISTRATION_ID=${registrationId}`] : []),
          "--entrypoint", "node", service, "/app/services/siwc-handoff.mjs", command,
        ],
    cwd: installRoot,
    dockerHost,
    ...(input === undefined ? {} : { input }),
  });
  if (result.code !== 0 || typeof result.stdout !== "string" ||
      Buffer.byteLength(result.stdout) > (command === "models" ? 64 * 1024 : 4096)) {
    throw Object.assign(new Error("The installed Codex SIWC operation could not be attested."),
      ["accept", "receipt"].includes(command) ? { remoteOutcomeUnknown: true } : {});
  }
  try { return JSON.parse(result.stdout); }
  catch { throw Object.assign(new Error("The installed Codex SIWC operation returned invalid attestation."),
    ["accept", "receipt"].includes(command) ? { remoteOutcomeUnknown: true } : {}); }
}

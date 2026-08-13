import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";

import {
  createLocalDockerEnvironment,
  validateLocalDockerHost,
} from "../infrastructure/local-process.js";

const COMPOSE_FILE_NAME = "docker-compose.yml";
const PROJECT_NAME_PATTERN =
  /^relmio-codex-chatgpt-[a-f0-9]{32}$/u;
const DEFAULT_RESPONSE_TIMEOUT_MS = 15_000;
const DEFAULT_COMPLETION_TIMEOUT_MS = 300_000;
const DEFAULT_TERMINATION_GRACE_MS = 2_000;
const DEFAULT_MAX_LINE_BYTES = 16 * 1024;
const DEFAULT_MAX_STDOUT_BYTES = 64 * 1024;
const DEFAULT_MAX_STDERR_BYTES = 32 * 1024;
const OPENAI_AUTH_ORIGIN = "https://auth.openai.com";

const PROCESS_START_ERROR =
  "The Codex sign-in process could not start. Check Docker and try again.";
const PROCESS_RESPONSE_ERROR =
  "The Codex sign-in process returned an unexpected sign-in response.";
const PROCESS_OUTPUT_ERROR = "The Codex sign-in process returned too much data.";
const LOGIN_START_ERROR = "The Codex sign-in could not be started.";
const LOGIN_FAILED_ERROR = "The Codex sign-in was not completed.";
const LOGIN_MISMATCH_ERROR =
  "The Codex sign-in process returned an unexpected sign-in response.";
const RESPONSE_TIMEOUT_ERROR =
  "The Codex sign-in process timed out before providing a device code.";
const COMPLETION_TIMEOUT_ERROR =
  "The Codex sign-in timed out before it was completed.";
const PROCESS_EARLY_CLOSE_ERROR =
  "The Codex sign-in process ended before providing a device code.";
const PROCESS_INCOMPLETE_CLOSE_ERROR =
  "The Codex sign-in process ended before sign-in completed.";
const LOGIN_CANCELLED_ERROR = "The Codex sign-in was cancelled.";

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasOwn(value, property) {
  return Object.prototype.hasOwnProperty.call(value, property);
}

function assertPositiveInteger(value, label, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new TypeError(`${label} must be a positive integer.`);
  }
}

function validateOptions({
  installDirectory,
  dockerHost,
  projectName,
  responseTimeoutMs,
  completionTimeoutMs,
  terminationGraceMs,
  maxLineBytes,
  maxStdoutBytes,
  maxStderrBytes,
}) {
  if (
    typeof installDirectory !== "string" ||
    installDirectory.length === 0 ||
    installDirectory.includes("\0") ||
    !isAbsolute(installDirectory)
  ) {
    throw new TypeError("The Codex install directory is invalid.");
  }
  const validatedDockerHost = validateLocalDockerHost(dockerHost);
  if (
    typeof projectName !== "string" ||
    !PROJECT_NAME_PATTERN.test(projectName)
  ) {
    throw new TypeError("The Codex Compose project identity is invalid.");
  }
  assertPositiveInteger(responseTimeoutMs, "responseTimeoutMs");
  assertPositiveInteger(completionTimeoutMs, "completionTimeoutMs");
  assertPositiveInteger(terminationGraceMs, "terminationGraceMs", 60_000);
  assertPositiveInteger(maxLineBytes, "maxLineBytes");
  assertPositiveInteger(maxStdoutBytes, "maxStdoutBytes");
  assertPositiveInteger(maxStderrBytes, "maxStderrBytes");
  if (maxLineBytes > maxStdoutBytes) {
    throw new TypeError("maxLineBytes cannot exceed maxStdoutBytes.");
  }
  return { dockerHost: validatedDockerHost, projectName };
}

function validateVerificationUrl(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 2048) {
    throw new TypeError();
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError();
  }
  if (
    url.origin !== OPENAI_AUTH_ORIGIN ||
    url.protocol !== "https:" ||
    url.hostname !== "auth.openai.com" ||
    url.port !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== ""
  ) {
    throw new TypeError();
  }
  return url.toString();
}

function validateDeviceResponse(value) {
  if (
    !isPlainObject(value) ||
    value.type !== "chatgptDeviceCode" ||
    typeof value.loginId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(value.loginId) ||
    typeof value.userCode !== "string" ||
    value.userCode.length < 4 ||
    value.userCode.length > 32 ||
    !/^[A-Z0-9]+(?:-[A-Z0-9]+)*$/u.test(value.userCode)
  ) {
    throw new TypeError();
  }

  return {
    loginId: value.loginId,
    userCode: value.userCode,
    verificationUrl: validateVerificationUrl(value.verificationUrl),
  };
}

function createInitializeMessage() {
  return {
    id: 0,
    method: "initialize",
    params: {
      clientInfo: {
        name: "relmio",
        title: "Relmio",
        version: "0.3.1",
      },
    },
  };
}

function createPostInitializeMessages() {
  return [
    { method: "initialized", params: {} },
    {
      id: 1,
      method: "account/login/start",
      params: { type: "chatgptDeviceCode" },
    },
  ];
}

export async function startCodexDeviceLogin({
  installDirectory,
  dockerHost,
  projectName,
  spawnProcess = spawn,
  responseTimeoutMs = DEFAULT_RESPONSE_TIMEOUT_MS,
  completionTimeoutMs = DEFAULT_COMPLETION_TIMEOUT_MS,
  terminationGraceMs = DEFAULT_TERMINATION_GRACE_MS,
  maxLineBytes = DEFAULT_MAX_LINE_BYTES,
  maxStdoutBytes = DEFAULT_MAX_STDOUT_BYTES,
  maxStderrBytes = DEFAULT_MAX_STDERR_BYTES,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
  environment = process.env,
} = {}) {
  const validated = validateOptions({
    installDirectory,
    dockerHost,
    projectName,
    responseTimeoutMs,
    completionTimeoutMs,
    terminationGraceMs,
    maxLineBytes,
    maxStdoutBytes,
    maxStderrBytes,
  });
  const childEnvironment = createLocalDockerEnvironment(environment);

  let child;
  try {
    child = spawnProcess(
      "docker",
      [
        "--host",
        validated.dockerHost,
        "compose",
        "--project-name",
        validated.projectName,
        "--file",
        COMPOSE_FILE_NAME,
        "run",
        "--rm",
        "--no-deps",
        "codex",
        "app-server",
        "--strict-config",
        "--stdio",
      ],
      {
        cwd: installDirectory,
        env: childEnvironment,
        shell: false,
        stdio: ["pipe", "pipe", "pipe"],
        windowsHide: true,
      },
    );
  } catch {
    throw new Error(PROCESS_START_ERROR);
  }

  let resolveDeviceResponse;
  let rejectDeviceResponse;
  let deviceResponseSettled = false;
  let expectedLoginId = null;
  const deviceResponsePromise = new Promise((resolvePromise, rejectPromise) => {
    resolveDeviceResponse = resolvePromise;
    rejectDeviceResponse = rejectPromise;
  });

  let resolveCompletion;
  let rejectCompletion;
  let completionSettled = false;
  const completion = new Promise((resolvePromise, rejectPromise) => {
    resolveCompletion = resolvePromise;
    rejectCompletion = rejectPromise;
  });
  // Startup failures can reject before completion is returned to the caller.
  void completion.catch(() => {});

  let responseTimer;
  let completionTimer;
  let killTimer;
  let forceSettleTimer;
  let successCloseTimer;
  let processClosed = false;
  let terminationRequested = false;
  let pendingFailure = null;
  let pendingSuccess = false;
  let protocolPhase = "waitingInitialize";
  let stdoutBuffer = Buffer.alloc(0);
  let stdoutBytes = 0;
  let stderrBytes = 0;

  const clearScheduledTimer = (timer) => {
    if (timer === undefined) {
      return;
    }
    try {
      clearTimer(timer);
    } catch {
      // Timer cleanup must not replace the selected redacted result.
    }
  };

  const clearResponseTimer = () => {
    clearScheduledTimer(responseTimer);
    responseTimer = undefined;
  };

  const clearCompletionTimer = () => {
    clearScheduledTimer(completionTimer);
    completionTimer = undefined;
  };

  const clearKillTimer = () => {
    clearScheduledTimer(killTimer);
    killTimer = undefined;
  };

  const clearForceSettleTimer = () => {
    clearScheduledTimer(forceSettleTimer);
    forceSettleTimer = undefined;
  };

  const clearSuccessCloseTimer = () => {
    clearScheduledTimer(successCloseTimer);
    successCloseTimer = undefined;
  };

  const signalChild = (signal) => {
    try {
      child.kill(signal);
    } catch {
      // Never expose platform- or process-specific termination details.
    }
  };

  const requestTermination = () => {
    if (terminationRequested || processClosed) {
      return;
    }
    terminationRequested = true;
    signalChild("SIGTERM");
    if (processClosed) {
      return;
    }
    try {
      killTimer = setTimer(() => {
        killTimer = undefined;
        if (!processClosed) {
          signalChild("SIGKILL");
          try {
            forceSettleTimer = setTimer(() => {
              forceSettleTimer = undefined;
              if (!processClosed) {
                if (pendingFailure) {
                  settleFailureNow(pendingFailure);
                } else if (pendingSuccess) {
                  settleSuccessNow();
                }
              }
            }, terminationGraceMs);
          } catch {
            if (pendingFailure) {
              settleFailureNow(pendingFailure);
            } else if (pendingSuccess) {
              settleSuccessNow();
            }
          }
        }
      }, terminationGraceMs);
    } catch {
      signalChild("SIGKILL");
      if (pendingFailure) {
        settleFailureNow(pendingFailure);
      } else if (pendingSuccess) {
        settleSuccessNow();
      }
    }
  };

  const settleFailureNow = (message) => {
    clearResponseTimer();
    clearCompletionTimer();
    clearKillTimer();
    clearForceSettleTimer();
    clearSuccessCloseTimer();
    pendingFailure = null;
    pendingSuccess = false;
    if (!deviceResponseSettled) {
      deviceResponseSettled = true;
      rejectDeviceResponse(new Error(message));
    }
    if (!completionSettled) {
      completionSettled = true;
      rejectCompletion(new Error(message));
    }
  };

  const settleSuccessNow = () => {
    clearResponseTimer();
    clearCompletionTimer();
    clearKillTimer();
    clearForceSettleTimer();
    clearSuccessCloseTimer();
    pendingSuccess = false;
    if (!completionSettled) {
      completionSettled = true;
      resolveCompletion({ success: true });
    }
  };

  const requestFailure = (message, { terminateProcess = true } = {}) => {
    if (
      pendingFailure ||
      pendingSuccess ||
      (deviceResponseSettled && completionSettled)
    ) {
      return false;
    }
    protocolPhase = "terminating";
    clearResponseTimer();
    clearCompletionTimer();
    if (!terminateProcess || processClosed) {
      settleFailureNow(message);
      return true;
    }
    pendingFailure = message;
    requestTermination();
    return true;
  };

  const settleProtocolFailure = (message = PROCESS_RESPONSE_ERROR) => {
    requestFailure(message);
  };

  const writeMessage = (message) => {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };

  const acceptInitialize = (message) => {
    if (protocolPhase !== "waitingInitialize") {
      settleProtocolFailure(LOGIN_MISMATCH_ERROR);
      return;
    }
    if (hasOwn(message, "error") || !isPlainObject(message.result)) {
      settleProtocolFailure(LOGIN_START_ERROR);
      return;
    }

    protocolPhase = "waitingLogin";
    try {
      for (const nextMessage of createPostInitializeMessages()) {
        writeMessage(nextMessage);
      }
    } catch {
      requestFailure(PROCESS_START_ERROR);
    }
  };

  const acceptDeviceResponse = (result) => {
    if (protocolPhase !== "waitingLogin" || deviceResponseSettled) {
      settleProtocolFailure(LOGIN_MISMATCH_ERROR);
      return;
    }

    let device;
    try {
      device = validateDeviceResponse(result);
    } catch {
      settleProtocolFailure(PROCESS_RESPONSE_ERROR);
      return;
    }

    expectedLoginId = device.loginId;
    protocolPhase = "waitingCompletion";
    clearResponseTimer();
    try {
      completionTimer = setTimer(
        () => {
          completionTimer = undefined;
          requestFailure(COMPLETION_TIMEOUT_ERROR);
        },
        completionTimeoutMs,
      );
    } catch {
      requestFailure(PROCESS_START_ERROR);
      return;
    }
    deviceResponseSettled = true;
    resolveDeviceResponse({
      verificationUrl: device.verificationUrl,
      userCode: device.userCode,
      completion,
      cancel() {
        requestFailure(LOGIN_CANCELLED_ERROR);
      },
    });
  };

  const acceptCompletion = (params) => {
    if (
      protocolPhase !== "waitingCompletion" ||
      !isPlainObject(params) ||
      expectedLoginId === null ||
      typeof params.loginId !== "string" ||
      params.loginId !== expectedLoginId ||
      typeof params.success !== "boolean" ||
      !(
        params.error === undefined ||
        params.error === null ||
        typeof params.error === "string"
      )
    ) {
      settleProtocolFailure(LOGIN_MISMATCH_ERROR);
      return;
    }
    if (params.success !== true) {
      requestFailure(LOGIN_FAILED_ERROR);
      return;
    }
    if (completionSettled || pendingSuccess) {
      return;
    }

    protocolPhase = "completing";
    pendingSuccess = true;
    clearCompletionTimer();
    try {
      child.stdin.end();
    } catch {
      // Completion is established and no sensitive detail is useful.
    }
    if (processClosed) {
      settleSuccessNow();
      return;
    }
    try {
      successCloseTimer = setTimer(() => {
        successCloseTimer = undefined;
        requestTermination();
      }, terminationGraceMs);
    } catch {
      requestTermination();
    }
  };

  const processLine = (lineBuffer) => {
    if (pendingFailure || pendingSuccess || completionSettled) {
      return;
    }
    if (lineBuffer.length > maxLineBytes) {
      requestFailure(PROCESS_OUTPUT_ERROR);
      return;
    }
    const withoutCarriageReturn =
      lineBuffer.at(-1) === 0x0d ? lineBuffer.subarray(0, -1) : lineBuffer;
    if (withoutCarriageReturn.length === 0) {
      return;
    }

    let message;
    try {
      message = JSON.parse(withoutCarriageReturn.toString("utf8"));
    } catch {
      settleProtocolFailure(PROCESS_RESPONSE_ERROR);
      return;
    }
    if (!isPlainObject(message)) {
      settleProtocolFailure(PROCESS_RESPONSE_ERROR);
      return;
    }

    if (hasOwn(message, "id")) {
      if (message.id === 0) {
        acceptInitialize(message);
        return;
      }
      if (message.id === 1) {
        if (protocolPhase !== "waitingLogin") {
          settleProtocolFailure(LOGIN_MISMATCH_ERROR);
          return;
        }
        if (hasOwn(message, "error")) {
          settleProtocolFailure(LOGIN_START_ERROR);
          return;
        }
        if (!hasOwn(message, "result")) {
          settleProtocolFailure(PROCESS_RESPONSE_ERROR);
          return;
        }
        acceptDeviceResponse(message.result);
        return;
      }
      settleProtocolFailure(PROCESS_RESPONSE_ERROR);
      return;
    }
    if (message.method === "account/login/completed") {
      acceptCompletion(message.params);
    }
  };

  const consumeStdout = (chunk) => {
    if (pendingFailure || pendingSuccess || completionSettled) {
      return;
    }
    let bytes;
    try {
      bytes = Buffer.from(chunk);
    } catch {
      settleProtocolFailure(PROCESS_RESPONSE_ERROR);
      return;
    }
    stdoutBytes += bytes.length;
    if (stdoutBytes > maxStdoutBytes) {
      requestFailure(PROCESS_OUTPUT_ERROR);
      return;
    }
    stdoutBuffer = Buffer.concat([stdoutBuffer, bytes]);

    let newlineIndex = stdoutBuffer.indexOf(0x0a);
    while (
      newlineIndex >= 0 &&
      !pendingFailure &&
      !pendingSuccess &&
      !completionSettled
    ) {
      const line = stdoutBuffer.subarray(0, newlineIndex);
      stdoutBuffer = stdoutBuffer.subarray(newlineIndex + 1);
      processLine(line);
      newlineIndex = stdoutBuffer.indexOf(0x0a);
    }
    if (
      !pendingFailure &&
      !pendingSuccess &&
      !completionSettled &&
      stdoutBuffer.length > maxLineBytes
    ) {
      requestFailure(PROCESS_OUTPUT_ERROR);
    }
  };

  const consumeStderr = (chunk) => {
    if (pendingFailure || pendingSuccess || completionSettled) {
      return;
    }
    let byteLength;
    try {
      byteLength = Buffer.byteLength(chunk);
    } catch {
      settleProtocolFailure(PROCESS_RESPONSE_ERROR);
      return;
    }
    stderrBytes += byteLength;
    if (stderrBytes > maxStderrBytes) {
      requestFailure(PROCESS_OUTPUT_ERROR);
    }
  };

  if (
    !child ||
    typeof child.once !== "function" ||
    typeof child.kill !== "function" ||
    typeof child.stdout?.on !== "function" ||
    typeof child.stderr?.on !== "function" ||
    typeof child.stdin?.write !== "function" ||
    typeof child.stdin?.end !== "function"
  ) {
    settleFailureNow(PROCESS_START_ERROR);
    return deviceResponsePromise;
  }

  try {
    child.stdout.on("data", consumeStdout);
    child.stderr.on("data", consumeStderr);
    child.stdin.on?.("error", () => {
      if (pendingSuccess) {
        clearSuccessCloseTimer();
        requestTermination();
      } else if (!pendingFailure) {
        requestFailure(
          deviceResponseSettled
            ? PROCESS_INCOMPLETE_CLOSE_ERROR
            : PROCESS_START_ERROR,
        );
      }
    });
    child.once("error", () => {
      if (pendingSuccess) {
        clearSuccessCloseTimer();
        requestTermination();
        return;
      }
      if (pendingFailure) {
        return;
      }
      requestFailure(
        deviceResponseSettled
          ? PROCESS_INCOMPLETE_CLOSE_ERROR
          : PROCESS_START_ERROR,
      );
    });
    child.once("close", () => {
      processClosed = true;
      clearKillTimer();
      clearForceSettleTimer();
      clearSuccessCloseTimer();
      if (pendingFailure) {
        settleFailureNow(pendingFailure);
        return;
      }
      if (!pendingSuccess && !completionSettled && stdoutBuffer.length > 0) {
        const finalLine = stdoutBuffer;
        stdoutBuffer = Buffer.alloc(0);
        processLine(finalLine);
      }
      if (pendingFailure) {
        settleFailureNow(pendingFailure);
        return;
      }
      if (pendingSuccess) {
        settleSuccessNow();
        return;
      }
      if (deviceResponseSettled && completionSettled) {
        return;
      }
      if (!deviceResponseSettled) {
        requestFailure(PROCESS_EARLY_CLOSE_ERROR, { terminateProcess: false });
      } else if (!completionSettled) {
        requestFailure(PROCESS_INCOMPLETE_CLOSE_ERROR, {
          terminateProcess: false,
        });
      }
    });

    responseTimer = setTimer(() => {
      responseTimer = undefined;
      requestFailure(RESPONSE_TIMEOUT_ERROR);
    }, responseTimeoutMs);
    writeMessage(createInitializeMessage());
  } catch {
    requestFailure(PROCESS_START_ERROR);
  }

  return deviceResponsePromise;
}

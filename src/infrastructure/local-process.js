import { spawn } from "node:child_process";
import { isAbsolute } from "node:path";

const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000;
const DEFAULT_TERMINATION_GRACE_MS = 2_000;
const MAX_ARGUMENT_BYTES = 16 * 1024;
const MAX_INPUT_BYTES = 1_000_000;
const MAX_DOCKER_HOST_BYTES = 4 * 1024;
const DOCKER_SELECTION_ENVIRONMENT_VARIABLES = new Set([
  "BUILDKIT_HOST",
  "DOCKER_CERT_PATH",
  "DOCKER_CONFIG",
  "DOCKER_CONTEXT",
  "DOCKER_HOST",
  "DOCKER_TLS_VERIFY",
]);

export function validateLocalDockerHost(
  value,
  { platform = process.platform } = {},
) {
  if (platform === "win32") {
    throw new TypeError(
      "Native Windows Docker hosts are unsupported for local endpoints.",
    );
  }
  if (
    typeof platform !== "string" ||
    typeof value !== "string" ||
    value.length === 0 ||
    Buffer.byteLength(value) > MAX_DOCKER_HOST_BYTES ||
    /[\0\r\n%]/u.test(value) ||
    !value.startsWith("unix:///")
  ) {
    throw new TypeError("The local Docker host must be a Unix socket URI.");
  }

  let url;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("The local Docker host must be a Unix socket URI.");
  }
  if (
    url.protocol !== "unix:" ||
    url.host !== "" ||
    url.username !== "" ||
    url.password !== "" ||
    url.search !== "" ||
    url.hash !== "" ||
    !url.pathname.startsWith("/") ||
    url.pathname === "/" ||
    url.href !== value
  ) {
    throw new TypeError("The local Docker host must be a Unix socket URI.");
  }
  return value;
}

export function createLocalDockerEnvironment(environment = process.env) {
  if (
    environment === null ||
    typeof environment !== "object" ||
    Array.isArray(environment)
  ) {
    throw new TypeError("The local Docker process environment is invalid.");
  }

  const sanitized = {};
  for (const [name, value] of Object.entries(environment)) {
    if (!DOCKER_SELECTION_ENVIRONMENT_VARIABLES.has(name.toUpperCase())) {
      sanitized[name] = value;
    }
  }
  return sanitized;
}

function validateProcessSpec({
  file,
  args,
  cwd,
  input,
  dockerHost,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES,
}) {
  if (file !== "docker") {
    throw new TypeError("Only the local Docker process is allowed.");
  }
  if (
    !Array.isArray(args) ||
    args.length === 0 ||
    args.some(
      (argument) =>
        typeof argument !== "string" ||
        argument.length === 0 ||
        argument.includes("\0") ||
        /[\r\n]/u.test(argument),
    ) ||
    Buffer.byteLength(args.join("\0")) > MAX_ARGUMENT_BYTES
  ) {
    throw new TypeError("Local Docker process arguments are invalid.");
  }
  if (typeof cwd !== "string" || !isAbsolute(cwd) || cwd.includes("\0")) {
    throw new TypeError("Local Docker working directory is invalid.");
  }
  if (
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 600_000
  ) {
    throw new TypeError("Local Docker process timeout is invalid.");
  }
  if (
    !Number.isInteger(maxOutputBytes) ||
    maxOutputBytes < 1 ||
    maxOutputBytes > 10_000_000
  ) {
    throw new TypeError("Local Docker output limit is invalid.");
  }

  const inputBuffer =
    input === undefined
      ? null
      : Buffer.isBuffer(input)
        ? input
        : typeof input === "string"
          ? Buffer.from(input)
          : null;
  if (
    input !== undefined &&
    (!inputBuffer || inputBuffer.length > MAX_INPUT_BYTES)
  ) {
    throw new TypeError("Local Docker process input is invalid.");
  }

  return {
    file,
    args: [...args],
    cwd,
    dockerHost:
      dockerHost === undefined ? null : validateLocalDockerHost(dockerHost),
    input: inputBuffer,
    timeoutMs,
    maxOutputBytes,
  };
}

function validateTerminationGrace(milliseconds) {
  if (
    !Number.isSafeInteger(milliseconds) ||
    milliseconds < 1 ||
    milliseconds > 60_000
  ) {
    throw new TypeError("Local Docker termination grace is invalid.");
  }
}

export function runLocalProcess(
  spec,
  {
    spawnProcess = spawn,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
    terminationGraceMs = DEFAULT_TERMINATION_GRACE_MS,
    environment = process.env,
  } = {},
) {
  let validated;
  let childEnvironment;
  try {
    validated = validateProcessSpec(spec);
    validateTerminationGrace(terminationGraceMs);
    childEnvironment = createLocalDockerEnvironment(environment);
  } catch (error) {
    return Promise.reject(error);
  }

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnProcess(
        validated.file,
        validated.dockerHost === null
          ? validated.args
          : ["--host", validated.dockerHost, ...validated.args],
        {
          cwd: validated.cwd,
          env: childEnvironment,
          shell: false,
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        },
      );
    } catch {
      reject(new Error("The local Docker process could not start."));
      return;
    }

    if (
      !child ||
      typeof child.once !== "function" ||
      typeof child.kill !== "function" ||
      typeof child.stdin?.end !== "function" ||
      typeof child.stdout?.on !== "function" ||
      typeof child.stderr?.on !== "function"
    ) {
      reject(new Error("The local Docker process could not start."));
      return;
    }

    const stdout = [];
    const stderr = [];
    let outputBytes = 0;
    let settled = false;
    let closed = false;
    let terminalError = null;
    let timeoutTimer;
    let killTimer;
    let forceSettleTimer;

    const clearScheduledTimer = (timer) => {
      if (timer === undefined) {
        return;
      }
      try {
        clearTimer(timer);
      } catch {
        // Timer cleanup must not replace the selected generic process result.
      }
    };

    const clearAllTimers = () => {
      clearScheduledTimer(timeoutTimer);
      clearScheduledTimer(killTimer);
      clearScheduledTimer(forceSettleTimer);
      timeoutTimer = undefined;
      killTimer = undefined;
      forceSettleTimer = undefined;
    };

    const settle = (error, result) => {
      if (settled) {
        return;
      }
      settled = true;
      clearAllTimers();
      if (error) {
        reject(error);
      } else {
        resolve(result);
      }
    };

    const signalChild = (signal) => {
      try {
        child.kill(signal);
      } catch {
        // Never expose platform- or process-specific termination details.
      }
    };

    const requestTermination = (error) => {
      if (settled || terminalError) {
        return;
      }
      terminalError = error;
      clearScheduledTimer(timeoutTimer);
      timeoutTimer = undefined;
      signalChild("SIGTERM");
      if (closed || settled) {
        return;
      }
      try {
        killTimer = setTimer(() => {
          killTimer = undefined;
          if (!closed && !settled) {
            signalChild("SIGKILL");
            try {
              forceSettleTimer = setTimer(() => {
                forceSettleTimer = undefined;
                if (!closed && !settled) {
                  settle(terminalError);
                }
              }, terminationGraceMs);
            } catch {
              settle(terminalError);
            }
          }
        }, terminationGraceMs);
      } catch {
        signalChild("SIGKILL");
        settle(terminalError);
      }
    };

    const capture = (target, chunk) => {
      if (settled || terminalError) {
        return;
      }
      let buffer;
      try {
        buffer = Buffer.from(chunk);
      } catch {
        requestTermination(
          new Error("The local Docker process returned invalid output."),
        );
        return;
      }
      outputBytes += buffer.length;
      if (outputBytes > validated.maxOutputBytes) {
        requestTermination(
          new Error("The local Docker process exceeded its output limit."),
        );
        return;
      }
      target.push(buffer);
    };

    child.stdout.on("data", (chunk) => capture(stdout, chunk));
    child.stderr.on("data", (chunk) => capture(stderr, chunk));
    child.stdin.on?.("error", () => {
      if (!terminalError) {
        requestTermination(
          new Error("The local Docker process could not start."),
        );
      }
    });
    child.once("error", () => {
      if (!terminalError) {
        requestTermination(
          new Error("The local Docker process could not start."),
        );
      }
    });
    child.once("close", (code) => {
      closed = true;
      if (terminalError) {
        settle(terminalError);
        return;
      }
      settle(null, {
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        code: Number.isInteger(code) ? code : 1,
      });
    });

    try {
      timeoutTimer = setTimer(() => {
        timeoutTimer = undefined;
        requestTermination(new Error("The local Docker process timed out."));
      }, validated.timeoutMs);
    } catch {
      requestTermination(
        new Error("The local Docker process could not start."),
      );
    }

    if (!terminalError) {
      try {
        if (validated.input) {
          child.stdin.end(validated.input);
        } else {
          child.stdin.end();
        }
      } catch {
        requestTermination(
          new Error("The local Docker process could not start."),
        );
      }
    }
  });
}

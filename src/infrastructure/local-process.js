import { spawn } from "node:child_process";
import { isAbsolute, win32 as windowsPath } from "node:path";

const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000;
const DEFAULT_TERMINATION_GRACE_MS = 2_000;
const MAX_ARGUMENT_BYTES = 16 * 1024;
const MAX_INPUT_BYTES = 1_000_000;
const MAX_DOCKER_HOST_BYTES = 4 * 1024;
const WINDOWS_ACL_TIMEOUT_MS = 60_000;
const WINDOWS_ACL_MAX_OUTPUT_BYTES = 4 * 1024;
const WINDOWS_SECURITY_TOOL_ERROR =
  "Windows could not locate the built-in security tool required to protect local Relmio files.";
const WINDOWS_PATH_PROTECTION_ERROR =
  "Windows could not apply and verify owner-only protection for local Relmio files.";
const WINDOWS_DOCKER_DESKTOP_LINUX_ENGINE =
  "npipe:////./pipe/dockerDesktopLinuxEngine";
const DOCKER_SELECTION_ENVIRONMENT_VARIABLES = new Set([
  "BUILDKIT_HOST",
  "DOCKER_CERT_PATH",
  "DOCKER_CONFIG",
  "DOCKER_CONTEXT",
  "DOCKER_HOST",
  "DOCKER_TLS_VERIFY",
]);
const LOCAL_N8N_STACK_ENVIRONMENT_VARIABLES = new Set([
  "NGROK_AUTHTOKEN",
  "N8N_ENCRYPTION_KEY",
  "NGROK_DOMAIN",
  "N8N_LOCAL_PORT",
  "NGROK_INSPECTOR_PORT",
  "GENERIC_TIMEZONE",
  "SANDBOX_API_KEYS",
  "SANDBOX_API_RUNNER_REGISTRATION_TOKEN",
  "SANDBOX_API_RUNNER_API_KEY",
  "SEARXNG_SECRET",
]);

export function validateLocalDockerHost(
  value,
  { platform = null } = {},
) {
  if (platform !== null && typeof platform !== "string") {
    throw new TypeError("The local Docker platform is invalid.");
  }
  if (platform === "win32") {
    if (value !== WINDOWS_DOCKER_DESKTOP_LINUX_ENGINE) {
      throw new TypeError(
        "Windows local Docker must use Docker Desktop's Linux engine pipe.",
      );
    }
    return value;
  }
  if (
    value === WINDOWS_DOCKER_DESKTOP_LINUX_ENGINE &&
    platform === null
  ) {
    return value;
  }
  if (
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
    const normalizedName = name.toUpperCase();
    if (
      !DOCKER_SELECTION_ENVIRONMENT_VARIABLES.has(normalizedName) &&
      !LOCAL_N8N_STACK_ENVIRONMENT_VARIABLES.has(normalizedName) &&
      !normalizedName.startsWith("COMPOSE_")
    ) {
      sanitized[name] = value;
    }
  }
  return sanitized;
}

function validateWindowsPath(value) {
  if (typeof value !== "string" || !windowsPath.isAbsolute(value) || value.includes("\0")) {
    throw new TypeError("The local managed path is invalid.");
  }
}

function resolveWindowsPowerShell(systemRoot) {
  if (
    typeof systemRoot !== "string" ||
    !windowsPath.isAbsolute(systemRoot) ||
    /[\0\r\n]/u.test(systemRoot) ||
    systemRoot
      .split(/[\\/]/u)
      .some((segment) => segment === "." || segment === "..")
  ) {
    throw new Error(WINDOWS_SECURITY_TOOL_ERROR);
  }

  const normalizedSystemRoot = windowsPath.normalize(systemRoot);
  const volumeRoot = windowsPath.parse(normalizedSystemRoot).root;
  if (
    !/^[A-Za-z]:\\$/u.test(volumeRoot) ||
    windowsPath.dirname(normalizedSystemRoot).toLowerCase() !==
      volumeRoot.toLowerCase() ||
    windowsPath.basename(normalizedSystemRoot).toLowerCase() !== "windows"
  ) {
    throw new Error(WINDOWS_SECURITY_TOOL_ERROR);
  }

  return windowsPath.join(
    normalizedSystemRoot,
    "System32",
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
  );
}

export function runWindowsAclCommand(
  file,
  args,
  {
    input = "",
    spawnProcess = spawn,
    timeoutMs = WINDOWS_ACL_TIMEOUT_MS,
    maxOutputBytes = WINDOWS_ACL_MAX_OUTPUT_BYTES,
    terminationGraceMs = DEFAULT_TERMINATION_GRACE_MS,
    setTimer = setTimeout,
    clearTimer = clearTimeout,
  } = {},
) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnProcess(file, args, {
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      reject(new Error("Windows ACL verification could not start."));
      return;
    }
    let stdout = "";
    let outputBytes = 0;
    let settled = false;
    let terminationTimer;
    let failure;
    const timeout = setTimer(() => {
      terminate(new Error("Windows ACL verification timed out."));
    }, timeoutMs);

    function settle(error, result) {
      if (settled) return;
      settled = true;
      clearTimer(timeout);
      clearTimer(terminationTimer);
      if (error) reject(error);
      else resolve(result);
    }

    function terminate(error) {
      if (failure || settled) return;
      failure = error;
      try { child.kill("SIGKILL"); } catch { /* Forced settlement remains bounded. */ }
      terminationTimer = setTimer(() => settle(failure), terminationGraceMs);
    }

    function consume(chunk, { capture = false } = {}) {
      if (settled) return;
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
      outputBytes += value.length;
      if (outputBytes > maxOutputBytes) {
        terminate(new Error("Windows ACL verification returned too much output."));
        return;
      }
      if (capture) stdout += value.toString("utf8");
    }

    child.stdout.on("data", (chunk) => consume(chunk, { capture: true }));
    child.stderr.on("data", (chunk) => consume(chunk));
    child.stdin.once("error", () => {
      terminate(new Error("Windows ACL verification could not receive its path."));
    });
    try { child.stdin.end(input); } catch {
      terminate(new Error("Windows ACL verification could not receive its path."));
    }
    child.once("error", () => {
      settle(new Error("Windows ACL verification could not start."));
    });
    child.once("close", (code) => {
      if (failure) settle(failure);
      else if (code === 0) settle(null, { stdout });
      else settle(new Error("Windows ACL lockdown could not be verified."));
    });
  });
}

/**
 * Requires the current account to own the path before read-only verification. During
 * setup, an Administrator may also normalize a path initially owned by the trusted
 * Builtin Administrators principal to the current account, then creates and reads
 * back a protected DACL containing only that account. Any other initial owner fails
 * closed. Verification mode never changes ownership or access rules.
 * Effective owner-only verification additionally accepts the exact legacy shape of
 * one inherited current-user FullControl rule on a file. On Administrator accounts,
 * Windows may assign a new inherited child to the trusted Builtin Administrators
 * principal even though only the current account receives access. That owner is
 * accepted only for the inherited legacy shape and only while the current account
 * is an Administrator. Callers must first verify that file's containing managed
 * directory with the strict protected ACL contract.
 * A directory rule is inheritable, so managed children receive the same protection.
 * Call this before writing secrets into a newly created managed directory or file.
 */
export async function lockDownLocalPath(
  path,
  {
    platform = process.platform,
    kind = "directory",
    runAclCommand = runWindowsAclCommand,
    systemRoot = process.env.SystemRoot,
    verifyOnly = false,
    verifyEffectiveOwnerOnly = false,
  } = {},
) {
  if (platform !== "win32") return;
  validateWindowsPath(path);
  const windowsPowerShell = resolveWindowsPowerShell(systemRoot);
  if (kind !== "directory" && kind !== "file") {
    throw new TypeError("Windows ACL path kind is invalid.");
  }
  if (typeof runAclCommand !== "function") {
    throw new TypeError("Windows ACL runner is invalid.");
  }
  if (typeof verifyOnly !== "boolean") {
    throw new TypeError("Windows ACL verification mode is invalid.");
  }
  if (
    typeof verifyEffectiveOwnerOnly !== "boolean" ||
    (verifyEffectiveOwnerOnly && (!verifyOnly || kind !== "file"))
  ) {
    throw new TypeError("Windows ACL effective owner-only verification mode is invalid.");
  }
  const script = [
    "$path=[Console]::In.ReadToEnd()",
    "$identity=[System.Security.Principal.WindowsIdentity]::GetCurrent()",
    "$sid=$identity.User",
    `$item=[System.IO.${kind === "directory" ? "DirectoryInfo" : "FileInfo"}]::new($path)`,
    "if($item.PSObject.Methods.Name -contains 'GetAccessControl'){$before=$item.GetAccessControl()}else{$before=[System.IO.FileSystemAclExtensions]::GetAccessControl($item)}",
    "$beforeOwner=$before.GetOwner([System.Security.Principal.SecurityIdentifier])",
    `$expectedInheritance=[System.Security.AccessControl.InheritanceFlags]::${kind === "directory" ? "ContainerInherit -bor [System.Security.AccessControl.InheritanceFlags]::ObjectInherit" : "None"}`,
    ...(!verifyOnly || verifyEffectiveOwnerOnly ? [
      "$administratorsSid=[System.Security.Principal.SecurityIdentifier]::new([System.Security.Principal.WellKnownSidType]::BuiltinAdministratorsSid,$null)",
      "$principal=[System.Security.Principal.WindowsPrincipal]::new($identity)",
    ] : []),
    ...(verifyOnly ? [
      "$actual=$before",
    ] : [
      "if($beforeOwner.Value -ne $sid.Value -and (-not ($beforeOwner.Value -eq $administratorsSid.Value -and $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)))){exit 1}",
      "$normalizeOwner=$beforeOwner.Value -ne $sid.Value",
      `$acl=New-Object System.Security.AccessControl.${kind === "directory" ? "Directory" : "File"}Security`,
      "if($normalizeOwner){$acl.SetOwner($sid)}",
      "$acl.SetAccessRuleProtection($true,$false)",
      "$rule=[System.Security.AccessControl.FileSystemAccessRule]::new($sid,[System.Security.AccessControl.FileSystemRights]::FullControl,$expectedInheritance,[System.Security.AccessControl.PropagationFlags]::None,[System.Security.AccessControl.AccessControlType]::Allow)",
      "$acl.SetAccessRule($rule)",
      "if($item.PSObject.Methods.Name -contains 'SetAccessControl'){$item.SetAccessControl($acl);$actual=$item.GetAccessControl()}else{[System.IO.FileSystemAclExtensions]::SetAccessControl($item,$acl);$actual=[System.IO.FileSystemAclExtensions]::GetAccessControl($item)}",
    ]),
    ...(!verifyEffectiveOwnerOnly
      ? ["if(-not $actual.AreAccessRulesProtected){exit 1}"]
      : []),
    "$owner=$actual.GetOwner([System.Security.Principal.SecurityIdentifier])",
    ...(!verifyEffectiveOwnerOnly ? [
      "if($owner.Value -ne $sid.Value){exit 1}",
    ] : []),
    "$rules=@($actual.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]))",
    "if($rules.Count -ne 1){exit 1}",
    "if($rules[0].IdentityReference.Value -ne $sid.Value -or $rules[0].AccessControlType -ne 'Allow' -or $rules[0].FileSystemRights -ne [System.Security.AccessControl.FileSystemRights]::FullControl -or $rules[0].InheritanceFlags -ne $expectedInheritance -or $rules[0].PropagationFlags -ne [System.Security.AccessControl.PropagationFlags]::None){exit 1}",
    ...(verifyEffectiveOwnerOnly ? [
      "$strictOwnerOnly=$actual.AreAccessRulesProtected -and (-not $rules[0].IsInherited)",
      "$legacyInheritedOwnerOnly=(-not $actual.AreAccessRulesProtected) -and $rules[0].IsInherited",
      "if(-not ($strictOwnerOnly -or $legacyInheritedOwnerOnly)){exit 1}",
      "$trustedLegacyAdministratorsOwner=$legacyInheritedOwnerOnly -and $owner.Value -eq $administratorsSid.Value -and $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)",
      "if($owner.Value -ne $sid.Value -and (-not $trustedLegacyAdministratorsOwner)){exit 1}",
    ] : [
      "if($rules[0].IsInherited){exit 1}",
    ]),
  ].join(";");
  try {
    await runAclCommand(
      windowsPowerShell,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      { input: path },
    );
  } catch {
    throw new Error(WINDOWS_PATH_PROTECTION_ERROR);
  }
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
        dockerHost === undefined
          ? null
          : validateLocalDockerHost(dockerHost, { platform: process.platform }),
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

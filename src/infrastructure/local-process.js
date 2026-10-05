import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as defaultFileSystem from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, win32 as windowsPath } from "node:path";

const DEFAULT_TIMEOUT_MS = 180_000;
const DEFAULT_MAX_OUTPUT_BYTES = 1_000_000;
const DEFAULT_TERMINATION_GRACE_MS = 2_000;
const MAX_ARGUMENT_BYTES = 16 * 1024;
const MAX_INPUT_BYTES = 1_000_000;
const MAX_DOCKER_HOST_BYTES = 4 * 1024;
const WINDOWS_ACL_TIMEOUT_MS = 60_000;
const WINDOWS_LOCKDOWN_MEMORY_LIMIT = 256;
const windowsLockdownMemories = new WeakMap();
const WINDOWS_ACL_MAX_OUTPUT_BYTES = 4 * 1024;
const WINDOWS_SECURITY_TOOL_ERROR =
  "Windows could not locate the built-in security tool required to protect local Relmio files.";
const WINDOWS_PATH_PROTECTION_ERROR =
  "Windows could not apply and verify owner-only protection for local Relmio files.";
const WINDOWS_DOCKER_DESKTOP_LINUX_ENGINE =
  "npipe:////./pipe/dockerDesktopLinuxEngine";
const DOCKER_SELECTION_ENVIRONMENT_VARIABLES = new Set([
  "BUILDX_BUILDER",
  "BUILDX_CONFIG",
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

// Existing Windows Docker profiles normally inherit SYSTEM/Administrators ACLs.
// Inspect them without changing ownership or ACLs; only untrusted write access
// (including an untrusted owner) makes a saved builder selector unsafe.
export async function verifyWindowsDockerConfigPath(location, {
  kind = "directory",
  runAclCommand = runWindowsAclCommand,
  systemRoot = process.env.SystemRoot,
} = {}) {
  validateWindowsPath(location);
  if (!["directory", "file"].includes(kind)) throw new TypeError("Invalid Docker configuration path kind.");
  const powershell = resolveWindowsPowerShell(systemRoot);
  const script = [
    "$utf8=[System.Text.UTF8Encoding]::new($false,$true)",
    "$reader=[System.IO.StreamReader]::new([Console]::OpenStandardInput(),$utf8,$false)",
    "$path=$reader.ReadToEnd()",
    "$identity=[System.Security.Principal.WindowsIdentity]::GetCurrent()",
    "$current=$identity.User.Value",
    `$item=[System.IO.${kind === "directory" ? "DirectoryInfo" : "FileInfo"}]::new($path)`,
    "if($item.PSObject.Methods.Name -contains 'GetAccessControl'){$acl=$item.GetAccessControl()}else{$acl=[System.IO.FileSystemAclExtensions]::GetAccessControl($item)}",
    "$rules=@($acl.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])|ForEach-Object{[ordered]@{sid=$_.IdentityReference.Value;rights=[int]$_.FileSystemRights;type=[int]$_.AccessControlType}})",
    "$owner=$acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value",
    "[ordered]@{owner=$owner;current=$current;rules=$rules}|ConvertTo-Json -Compress -Depth 4",
  ].join(";");
  let acl;
  try {
    const result = await runAclCommand(powershell,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script], { input: location });
    acl = JSON.parse(result.stdout);
  } catch {
    throw new Error("The existing Docker configuration ACL cannot be verified.");
  }
  const trusted = new Set([acl?.current, "S-1-5-18", "S-1-5-32-544"]);
  const writeRights = 278 | 64 | 65536 | 262144 | 524288;
  if (!/^S-1-[0-9-]+$/u.test(acl?.current) || !trusted.has(acl?.owner) ||
      !Array.isArray(acl.rules) || acl.rules.length === 0 || acl.rules.length > 256 ||
      acl.rules.some(rule => !/^S-1-[0-9-]+$/u.test(rule?.sid) ||
        !Number.isInteger(rule.rights) || ![0, 1].includes(rule.type) ||
        (rule.type === 0 && !trusted.has(rule.sid) && ((rule.rights >>> 0) & writeRights) !== 0))) {
    throw new Error("The existing Docker configuration ACL permits an untrusted builder change.");
  }
}

// Buildx inspect initializes state and may expose nodegroup credentials.
// Only read its bounded selectors; never change the user's saved selection.
export async function attestLocalDockerBuilder(dockerHost, {
  fileSystem = defaultFileSystem,
  environment = process.env,
  homeDirectory,
  platform = process.platform,
  verifyDockerAcl = verifyWindowsDockerConfigPath,
} = {}) {
  validateLocalDockerHost(dockerHost, { platform });
  const path = platform === "win32" ? windowsPath : { dirname, isAbsolute, join, resolve };
  if (typeof homeDirectory !== "string" || !path.isAbsolute(homeDirectory) ||
      homeDirectory.includes("\0") || path.resolve(homeDirectory) !== homeDirectory) {
    throw new Error("The Docker configuration location is not safe for a model build.");
  }
  const configuredHome = platform === "win32" ? environment.USERPROFILE : environment.HOME;
  if (configuredHome && (platform === "win32"
    ? path.resolve(configuredHome).toLowerCase() !== homeDirectory.toLowerCase()
    : path.resolve(configuredHome) !== homeDirectory)) {
    throw new Error("The Docker configuration location changed. Review again.");
  }
  const unsafe = () => new Error("The built-in default Docker builder cannot be attested; no model build was started.");
  const uid = platform === "win32" ? null : process.getuid();
  async function entry(location) {
    try { return await fileSystem.lstat(location); }
    catch (error) { if (error?.code === "ENOENT") return null; throw unsafe(); }
  }
  async function safeDirectory(location, { owned = true } = {}) {
    const item = await entry(location);
    if (!item) return false;
    if (!item.isDirectory() || item.isSymbolicLink() ||
        (uid !== null && (((item.mode & 0o022) !== 0 &&
          !(owned === false && item.uid === 0 && (item.mode & 0o1000) !== 0)) ||
          (owned && item.uid !== uid)))) throw unsafe();
    if (platform === "win32" && owned) {
      try { await verifyDockerAcl(location); } catch { throw unsafe(); }
    }
    return true;
  }
  let ancestor = homeDirectory;
  while (true) {
    if (!await safeDirectory(ancestor, { owned: ancestor === homeDirectory })) throw unsafe();
    const parent = path.dirname(ancestor);
    if (parent === ancestor) break;
    ancestor = parent;
  }
  const config = path.join(homeDirectory, ".docker");
  const buildx = path.join(config, "buildx");
  const defaults = path.join(buildx, "defaults");
  const instances = path.join(buildx, "instances");
  for (const location of [config, buildx, defaults, instances]) await safeDirectory(location);
  if (await entry(path.join(instances, "default"))) throw unsafe();
  async function selector(location) {
    const item = await entry(location);
    if (!item) return null;
    if (!item.isFile() || item.isSymbolicLink() || item.size > 4096 || item.nlink !== 1 ||
        (uid !== null && (item.uid !== uid || (item.mode & 0o022) !== 0))) throw unsafe();
    if (platform === "win32") {
      try { await verifyDockerAcl(location, { kind: "file" }); } catch { throw unsafe(); }
    }
    try { return await fileSystem.readFile(location); } catch { throw unsafe(); }
  }
  // Buildx ignores Key and Global when Name is empty, but the reviewed host's
  // fallback can still select another builder; attest it below using dockerHost.
  const current = await selector(path.join(buildx, "current"));
  if (current !== null) {
    if (!Buffer.isBuffer(current) || current.length > 4096) throw unsafe();
    let selected;
    try { selected = JSON.parse(current.toString("utf8")); } catch { throw unsafe(); }
    if (selected === null || typeof selected !== "object" || Array.isArray(selected) ||
        typeof selected.Key !== "string" || typeof selected.Name !== "string" ||
        typeof selected.Global !== "boolean" ||
        !(selected.Name === "" || (selected.Name === "default" && selected.Key === dockerHost)) ||
        !current.equals(Buffer.from(JSON.stringify({
          Key: selected.Key, Name: selected.Name, Global: selected.Global,
        })))) throw unsafe();
  }
  const key = createHash("sha256").update(dockerHost).digest("hex").slice(0, 20);
  const fallback = await selector(path.join(defaults, key));
  if (fallback !== null && !fallback.equals(Buffer.from("default"))) throw unsafe();
  return config;
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
    try { child.stdin.end(input, "utf8"); } catch {
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

// One Windows ACL check, as the body of a PowerShell function whose only parameter is
// $path. It returns $true only after every owner-only condition holds.
function windowsAclCheckScript({ kind, verifyOnly, verifyEffectiveOwnerOnly }) {
  return [
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
      "if($beforeOwner.Value -ne $sid.Value -and (-not ($beforeOwner.Value -eq $administratorsSid.Value -and $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)))){return $false}",
      "$normalizeOwner=$beforeOwner.Value -ne $sid.Value",
      `$acl=New-Object System.Security.AccessControl.${kind === "directory" ? "Directory" : "File"}Security`,
      "if($normalizeOwner){$acl.SetOwner($sid)}",
      "$acl.SetAccessRuleProtection($true,$false)",
      "$rule=[System.Security.AccessControl.FileSystemAccessRule]::new($sid,[System.Security.AccessControl.FileSystemRights]::FullControl,$expectedInheritance,[System.Security.AccessControl.PropagationFlags]::None,[System.Security.AccessControl.AccessControlType]::Allow)",
      "$acl.SetAccessRule($rule)",
      "if($item.PSObject.Methods.Name -contains 'SetAccessControl'){$item.SetAccessControl($acl);$actual=$item.GetAccessControl()}else{[System.IO.FileSystemAclExtensions]::SetAccessControl($item,$acl);$actual=[System.IO.FileSystemAclExtensions]::GetAccessControl($item)}",
    ]),
    ...(!verifyEffectiveOwnerOnly
      ? ["if(-not $actual.AreAccessRulesProtected){return $false}"]
      : []),
    "$owner=$actual.GetOwner([System.Security.Principal.SecurityIdentifier])",
    ...(!verifyEffectiveOwnerOnly ? [
      "if($owner.Value -ne $sid.Value){return $false}",
    ] : []),
    "$rules=@($actual.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier]))",
    "if($rules.Count -ne 1){return $false}",
    "if($rules[0].IdentityReference.Value -ne $sid.Value -or $rules[0].AccessControlType -ne 'Allow' -or $rules[0].FileSystemRights -ne [System.Security.AccessControl.FileSystemRights]::FullControl -or $rules[0].InheritanceFlags -ne $expectedInheritance -or $rules[0].PropagationFlags -ne [System.Security.AccessControl.PropagationFlags]::None){return $false}",
    ...(verifyEffectiveOwnerOnly ? [
      "$strictOwnerOnly=$actual.AreAccessRulesProtected -and (-not $rules[0].IsInherited)",
      "$legacyInheritedOwnerOnly=(-not $actual.AreAccessRulesProtected) -and $rules[0].IsInherited",
      "if(-not ($strictOwnerOnly -or $legacyInheritedOwnerOnly)){return $false}",
      "$trustedLegacyAdministratorsOwner=$legacyInheritedOwnerOnly -and $owner.Value -eq $administratorsSid.Value -and $principal.IsInRole([System.Security.Principal.WindowsBuiltInRole]::Administrator)",
      "if($owner.Value -ne $sid.Value -and (-not $trustedLegacyAdministratorsOwner)){return $false}",
    ] : [
      "if($rules[0].IsInherited){return $false}",
    ]),
    "return $true",
  ].join(";");
}

// Every valid check, in a fixed order; a request names its check by index only.
const WINDOWS_ACL_CHECKS = Object.freeze([
  { kind: "directory", verifyOnly: false, verifyEffectiveOwnerOnly: false },
  { kind: "directory", verifyOnly: true, verifyEffectiveOwnerOnly: false },
  { kind: "file", verifyOnly: false, verifyEffectiveOwnerOnly: false },
  { kind: "file", verifyOnly: true, verifyEffectiveOwnerOnly: false },
  { kind: "file", verifyOnly: true, verifyEffectiveOwnerOnly: true },
].map(windowsAclCheckScript));

// Static helper: reads one JSON request per line as strict UTF-8 and answers
// {"id":N,"ok":true|false}. Paths arrive only as JSON data. Any exception answers
// false. [char]34 avoids double quotes, which the Windows PowerShell CLI can strip.
const WINDOWS_ACL_HELPER_SCRIPT = [
  "$utf8=[System.Text.UTF8Encoding]::new($false,$true)",
  "$reader=[System.IO.StreamReader]::new([Console]::OpenStandardInput(),$utf8,$false)",
  "$writer=[System.IO.StreamWriter]::new([Console]::OpenStandardOutput(),[System.Text.UTF8Encoding]::new($false))",
  "$writer.AutoFlush=$true",
  "$q=[char]34",
  ...WINDOWS_ACL_CHECKS.map((check, index) => `function Test-RelmioAcl${index}([string]$path){${check}}`),
  `while($null -ne ($line=$reader.ReadLine())){$id=0;$ok=$false;try{$request=ConvertFrom-Json -InputObject $line;$id=[long]$request.id;$check=[int]$request.check;if($check -lt 0 -or $check -gt ${WINDOWS_ACL_CHECKS.length - 1}){throw 'check'};$result=@(& ('Test-RelmioAcl'+$check) ([string]$request.path));$ok=$result.Count -gt 0 -and $result[-1] -is [bool] -and $result[-1]}catch{$ok=$false};$writer.WriteLine('{'+$q+'id'+$q+':'+$id+','+$q+'ok'+$q+':'+$(if($ok){'true'}else{'false'})+'}')}`,
].join(";");
const WINDOWS_ACL_RESPONSE = /^\{"id":([1-9][0-9]{0,15}),"ok":(true|false)\}\r?$/u;

function asciiJsonLine(value) {
  return `${JSON.stringify(value).replace(/[\u007f-\uffff]/g,
    (character) => `\\u${character.charCodeAt(0).toString(16).padStart(4, "0")}`)}\n`;
}

/**
 * Keeps one Windows PowerShell process per Node process to answer ACL checks, so a
 * check costs a pipe round trip instead of a PowerShell start. Requests are serialized
 * JSON lines; the path is data and is never interpolated into script text. A timeout,
 * malformed or out-of-order reply, exit or spawn failure fails that request closed and
 * retires the helper; the next request starts a fresh one. An idle helper does not keep
 * Node alive and is killed when Node exits.
 */
export function createWindowsAclHelper({
  spawnProcess = spawn,
  timeoutMs = WINDOWS_ACL_TIMEOUT_MS,
  maxResponseBytes = WINDOWS_ACL_MAX_OUTPUT_BYTES,
  onProcessExit = (listener) => {
    process.once("exit", listener);
    return () => process.removeListener("exit", listener);
  },
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  let worker = null;
  let nextId = 0;
  let queue = Promise.resolve();

  function setActive(current, active) {
    const { child } = current;
    for (const handle of [child, child.stdin, child.stdout, child.stderr]) {
      try {
        if (active) handle?.ref?.();
        else handle?.unref?.();
      } catch { /* Reference counting only affects process lifetime. */ }
    }
  }

  function retire(current, error) {
    if (worker === current) worker = null;
    if (current.retired) return;
    current.retired = true;
    current.detachExit?.();
    try { current.child.kill("SIGKILL"); } catch { /* The request still fails closed. */ }
    const pending = current.pending;
    current.pending = null;
    if (pending) {
      clearTimer(pending.timer);
      pending.reject(error);
    }
  }

  function receive(current, chunk) {
    if (current.retired) return;
    current.buffer += Buffer.isBuffer(chunk) ? chunk.toString("latin1") : String(chunk);
    let newline;
    while ((newline = current.buffer.indexOf("\n")) >= 0) {
      const line = current.buffer.slice(0, newline);
      current.buffer = current.buffer.slice(newline + 1);
      const match = WINDOWS_ACL_RESPONSE.exec(line);
      const pending = current.pending;
      if (!pending || !match || Number(match[1]) !== pending.id) {
        retire(current, new Error("Windows ACL helper returned an unexpected reply."));
        return;
      }
      current.pending = null;
      clearTimer(pending.timer);
      setActive(current, false);
      pending.resolve(match[2] === "true");
    }
    if (current.buffer.length > maxResponseBytes) {
      retire(current, new Error("Windows ACL helper returned too much output."));
    }
  }

  function start(powershell) {
    const child = spawnProcess(
      powershell,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", WINDOWS_ACL_HELPER_SCRIPT],
      { shell: false, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
    );
    const current = { child, powershell, buffer: "", pending: null, retired: false };
    const fail = (message) => () => retire(current, new Error(message));
    child.stdout.on("data", (chunk) => receive(current, chunk));
    child.stderr.on("data", () => {}); // Never surface helper diagnostics.
    child.stdin.on("error", fail("Windows ACL helper could not receive a request."));
    child.once("error", fail("Windows ACL helper could not start."));
    child.once("close", fail("Windows ACL helper stopped."));
    current.detachExit = onProcessExit(() => {
      try { child.kill("SIGKILL"); } catch { /* Node is exiting. */ }
    });
    setActive(current, false);
    return current;
  }

  function send(powershell, check, path) {
    if (worker && worker.powershell !== powershell) {
      retire(worker, new Error("Windows ACL helper was replaced."));
    }
    let current;
    try {
      current = worker ?? start(powershell);
    } catch {
      return Promise.reject(new Error("Windows ACL helper could not start."));
    }
    worker = current;
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimer(
        () => retire(current, new Error("Windows ACL helper timed out.")),
        timeoutMs,
      );
      current.pending = { id, resolve, reject, timer };
      setActive(current, true);
      try {
        current.child.stdin.write(asciiJsonLine({ id, check, path }));
      } catch {
        retire(current, new Error("Windows ACL helper could not receive a request."));
      }
    });
  }

  return Object.freeze({
    check({ powershell, script, path }) {
      const check = WINDOWS_ACL_CHECKS.indexOf(script);
      if (check < 0 || typeof powershell !== "string" || typeof path !== "string" || !path.isWellFormed()) {
        return Promise.reject(new TypeError("The Windows ACL request is invalid."));
      }
      const result = queue.then(() => send(powershell, check, path));
      queue = result.catch(() => {});
      return result;
    },
    close() {
      if (worker) retire(worker, new Error("Windows ACL helper was closed."));
    },
  });
}

const sharedWindowsAclHelper = createWindowsAclHelper();

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
 * The check runs in this process's ACL helper; the path is request data, never script text.
 */
export async function lockDownLocalPath(
  path,
  {
    platform = process.platform,
    kind = "directory",
    aclHelper = sharedWindowsAclHelper,
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
  if (typeof aclHelper?.check !== "function") {
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
  let protectedPath = false;
  try {
    protectedPath = await aclHelper.check({
      powershell: windowsPowerShell,
      script: windowsAclCheckScript({ kind, verifyOnly, verifyEffectiveOwnerOnly }),
      path,
    }) === true;
  } catch { /* Any helper failure is unverified protection. */ }
  if (!protectedPath) throw new Error(WINDOWS_PATH_PROTECTION_ERROR);
}

const WINDOWS_SHARING_ERROR_CODES = new Set(["EACCES", "EBUSY", "EPERM"]);
const WINDOWS_SHARING_RETRY_DELAYS_MS = Object.freeze([10, 20, 40, 80, 160, 320, 640]);

/**
 * On Windows, antivirus scans, the search indexer and other processes' ACL checks
 * briefly hold files without delete sharing, and a deleted name can linger until the
 * last handle closes. Node reports those refusals as EACCES, EBUSY or EPERM. This
 * retries only those codes, for about 1.3 seconds, then throws the last refusal.
 * Every other error, and every platform but Windows, gets a single attempt.
 */
export async function retryWindowsFileSharing(operation, {
  platform = process.platform,
  wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
} = {}) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      if (platform !== "win32" || !WINDOWS_SHARING_ERROR_CODES.has(error?.code) ||
          attempt >= WINDOWS_SHARING_RETRY_DELAYS_MS.length) throw error;
      await wait(WINDOWS_SHARING_RETRY_DELAYS_MS[attempt]);
    }
  }
}

function windowsLockdownIdentity(metadata) {
  return [metadata?.dev, metadata?.ino, metadata?.birthtimeMs, metadata?.ctimeMs].every(Number.isFinite)
    ? `${metadata.dev}:${metadata.ino}:${metadata.birthtimeMs}`
    : null;
}

function windowsLockdownDigest(contents) {
  return createHash("sha256").update(contents).digest("hex");
}

/**
 * Remembers, for this process only, an inode that this process has just locked
 * down with `lockDownPath`; that lockdown reads the owner-only DACL back. The
 * key is device, inode and birth time. A later match also needs the same change
 * time and contents (use "" for a directory). NTFS updates the change time when
 * a security descriptor changes, so an ACL edit forces full verification again.
 * Memory is per lockdown adapter and bounded; the oldest entries are evicted.
 */
export function rememberWindowsLockdown(lockDownPath, metadata, contents) {
  const identity = windowsLockdownIdentity(metadata);
  if (typeof lockDownPath !== "function" || !identity) return;
  let memory = windowsLockdownMemories.get(lockDownPath);
  if (!memory) {
    memory = new Map();
    windowsLockdownMemories.set(lockDownPath, memory);
  }
  memory.delete(identity);
  memory.set(identity, { ctimeMs: metadata.ctimeMs, digest: windowsLockdownDigest(contents) });
  if (memory.size > WINDOWS_LOCKDOWN_MEMORY_LIMIT) memory.delete(memory.keys().next().value);
}

/**
 * Returns true only for an unchanged inode this process locked down itself.
 * Foreign, replaced, changed or evicted inodes return false and need full verification.
 */
export function recallWindowsLockdown(lockDownPath, metadata, contents) {
  const identity = windowsLockdownIdentity(metadata);
  const remembered = identity && typeof lockDownPath === "function"
    ? windowsLockdownMemories.get(lockDownPath)?.get(identity)
    : undefined;
  return remembered !== undefined && remembered.ctimeMs === metadata.ctimeMs &&
    remembered.digest === windowsLockdownDigest(contents);
}

/**
 * After a full verify-only check succeeds, records the new change time of an
 * inode this process locked down earlier (a link or rename can change it).
 * An inode this process never locked down is never added.
 */
export function refreshWindowsLockdown(lockDownPath, metadata, contents) {
  const identity = windowsLockdownIdentity(metadata);
  if (identity && windowsLockdownMemories.get(lockDownPath)?.has(identity)) {
    rememberWindowsLockdown(lockDownPath, metadata, contents);
  }
}

function validateProcessSpec({
  file,
  args,
  cwd,
  input,
  dockerHost,
  attestedDockerConfig,
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
  if (attestedDockerConfig !== undefined &&
      (dockerHost === undefined || typeof attestedDockerConfig !== "string" ||
        !isAbsolute(attestedDockerConfig) || resolve(attestedDockerConfig) !== attestedDockerConfig ||
        attestedDockerConfig.includes("\0") || args[0] !== "compose" ||
        !(args.includes("run") || (args.includes("build") &&
          args.some((value, index) => value === "--builder" && args[index + 1] === "default"))))) {
    throw new TypeError("A model build requires an attested default Docker builder.");
  }

  return {
    file,
    args: [...args],
    cwd,
    dockerHost:
        dockerHost === undefined
          ? null
          : validateLocalDockerHost(dockerHost, { platform: process.platform }),
    attestedDockerConfig,
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
    if (validated.attestedDockerConfig !== undefined) {
      childEnvironment.DOCKER_CONFIG = validated.attestedDockerConfig;
      childEnvironment.BUILDX_BUILDER = "default";
      childEnvironment.DOCKER_BUILDKIT = "1";
      childEnvironment.COMPOSE_BAKE = "false";
    }
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

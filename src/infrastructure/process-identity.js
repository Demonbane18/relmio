import { spawn } from "node:child_process";
import * as defaultFileSystem from "node:fs/promises";
import { platform as hostPlatform } from "node:os";
import { posix as posixPath, win32 as windowsPath } from "node:path";

const MAX_PROCESS_ID = 2_147_483_647;
const MAX_START_IDENTITY_BYTES = 512;
const PROCESS_IDENTITY_TIMEOUT_MS = 5_000;
const MAX_PROCESS_IDENTITY_OUTPUT_BYTES = 1_024;

function assertPid(pid) {
  if (!Number.isSafeInteger(pid) || pid < 1 || pid > MAX_PROCESS_ID) {
    throw new TypeError("The local process ID is invalid.");
  }
}

function active(startIdentity) {
  if (
    typeof startIdentity !== "string" ||
    startIdentity.length === 0 ||
    Buffer.byteLength(startIdentity) > MAX_START_IDENTITY_BYTES ||
    /[\0\r\n]/u.test(startIdentity)
  ) {
    return Object.freeze({ state: "ambiguous" });
  }
  return Object.freeze({ state: "active", startIdentity });
}

function resolveWindowsPowerShell(systemRoot) {
  if (
    typeof systemRoot !== "string" ||
    !windowsPath.isAbsolute(systemRoot) ||
    /[\0\r\n]/u.test(systemRoot) ||
    systemRoot.split(/[\\/]/u).some((segment) => segment === "." || segment === "..")
  ) {
    return null;
  }
  const normalized = windowsPath.normalize(systemRoot);
  const volumeRoot = windowsPath.parse(normalized).root;
  if (
    !/^[A-Za-z]:\\$/u.test(volumeRoot) ||
    windowsPath.dirname(normalized).toLowerCase() !== volumeRoot.toLowerCase() ||
    windowsPath.basename(normalized).toLowerCase() !== "windows"
  ) {
    return null;
  }
  return windowsPath.join(normalized, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
}

export function runIdentityCommand(
  file,
  args,
  {
    input = "",
    spawnProcess = spawn,
    timeoutMs = PROCESS_IDENTITY_TIMEOUT_MS,
    maxOutputBytes = MAX_PROCESS_IDENTITY_OUTPUT_BYTES,
  } = {},
) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnProcess(file, args, {
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "ignore"],
        env: { ...process.env, LANG: "C", LC_ALL: "C", TZ: "UTC" },
      });
    } catch {
      reject(new Error("The local process identity could not be inspected."));
      return;
    }
    if (
      !child || typeof child.once !== "function" || typeof child.kill !== "function" ||
      typeof child.stdout?.on !== "function" || typeof child.stdin?.end !== "function"
    ) {
      reject(new Error("The local process identity could not be inspected."));
      return;
    }

    const output = [];
    let outputBytes = 0;
    let settled = false;
    let timeout;
    const finish = (error, result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(result);
    };
    const fail = () => {
      try { child.kill("SIGKILL"); } catch { /* best-effort termination */ }
      finish(new Error("The local process identity could not be inspected."));
    };

    child.stdout.on("data", (chunk) => {
      if (settled) return;
      let buffer;
      try { buffer = Buffer.from(chunk); } catch { fail(); return; }
      outputBytes += buffer.length;
      if (outputBytes > maxOutputBytes) { fail(); return; }
      output.push(buffer);
    });
    child.stdout.once?.("error", fail);
    child.stdin.once?.("error", fail);
    child.once("error", fail);
    child.once("close", (code) => {
      finish(null, {
        code: Number.isInteger(code) ? code : 1,
        stdout: Buffer.concat(output).toString("utf8"),
      });
    });
    timeout = setTimeout(fail, timeoutMs);
    timeout.unref?.();
    try { child.stdin.end(input); } catch { fail(); }
  });
}

function probeLocalProcess(pid) {
  try {
    process.kill(pid, 0);
    return "present";
  } catch (error) {
    return error?.code === "ESRCH" ? "dead" : "ambiguous";
  }
}

function processIsConfirmedDead(pid, probeProcess) {
  try { return probeProcess(pid) === "dead"; } catch { return false; }
}

function parseLinuxStat(value) {
  if (typeof value !== "string") return null;
  const closingParenthesis = value.lastIndexOf(")");
  if (closingParenthesis < 2 || value[closingParenthesis + 1] !== " ") return null;
  const fields = value.slice(closingParenthesis + 2).trim().split(/\s+/u);
  const startTicks = fields[19]; // field 22; fields begin with process state (field 3).
  return /^[0-9]+$/u.test(startTicks) ? startTicks : null;
}

async function inspectLinuxProcess(pid, { fileSystem }) {
  try {
    const [statContents, bootIdContents] = await Promise.all([
      fileSystem.readFile(posixPath.join("/proc", String(pid), "stat"), "utf8"),
      fileSystem.readFile("/proc/sys/kernel/random/boot_id", "utf8"),
    ]);
    const startTicks = parseLinuxStat(statContents);
    const bootId = typeof bootIdContents === "string" ? bootIdContents.trim() : "";
    if (!startTicks || !/^[a-f0-9-]{36}$/iu.test(bootId)) {
      return Object.freeze({ state: "ambiguous" });
    }
    return active(`linux:${bootId}:${startTicks}`);
  } catch (error) {
    if (error?.code === "ENOENT" || error?.code === "ESRCH") {
      return Object.freeze({ state: "dead" });
    }
    return Object.freeze({ state: "ambiguous" });
  }
}

async function inspectMacProcess(pid, { probeProcess, runCommand }) {
  try {
    const result = await runCommand("/bin/ps", ["-p", String(pid), "-o", "lstart="], {});
    if (result?.code !== 0 && processIsConfirmedDead(pid, probeProcess)) {
      return Object.freeze({ state: "dead" });
    }
    if (result?.code !== 0 || typeof result.stdout !== "string") {
      return Object.freeze({ state: "ambiguous" });
    }
    const startTime = result.stdout.trim();
    return /^[A-Z][a-z]{2}\s+[A-Z][a-z]{2}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}\s+\d{4}$/u.test(startTime)
      ? active(`darwin:${startTime}`)
      : Object.freeze({ state: "ambiguous" });
  } catch {
    return Object.freeze({ state: "ambiguous" });
  }
}

async function inspectWindowsProcess(pid, { probeProcess, runCommand, systemRoot }) {
  const powershell = resolveWindowsPowerShell(systemRoot);
  if (!powershell) return Object.freeze({ state: "ambiguous" });
  const script = [
    "$pidText=[Console]::In.ReadToEnd()",
    "if($pidText -notmatch '^[1-9][0-9]*$'){[Console]::Out.Write('ambiguous');exit 0}",
    "try{$target=Get-Process -Id ([int]$pidText) -ErrorAction Stop}catch [Microsoft.PowerShell.Commands.ProcessCommandException]{[Console]::Out.Write('missing');exit 0}catch{[Console]::Out.Write('ambiguous');exit 0}",
    "try{[Console]::Out.Write('active:'+($target.StartTime.ToUniversalTime().Ticks))}catch{[Console]::Out.Write('ambiguous')}",
  ].join(";");
  try {
    const result = await runCommand(
      powershell,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
      { input: String(pid) },
    );
    if (result?.code !== 0 || typeof result.stdout !== "string") {
      return Object.freeze({ state: "ambiguous" });
    }
    const output = result.stdout.trim();
    if (output === "missing" && processIsConfirmedDead(pid, probeProcess)) {
      return Object.freeze({ state: "dead" });
    }
    const ticks = output.match(/^active:([0-9]{1,20})$/u)?.[1];
    return ticks ? active(`win32:${ticks}`) : Object.freeze({ state: "ambiguous" });
  } catch {
    return Object.freeze({ state: "ambiguous" });
  }
}

/**
 * Returns a process state plus a stable per-boot creation identity.
 * Any inability to prove the identity is deliberately reported as ambiguous.
 */
export async function getLocalProcessIdentity(
  pid,
  {
    platform = hostPlatform(),
    fileSystem = defaultFileSystem,
    probeProcess = probeLocalProcess,
    runCommand = runIdentityCommand,
    systemRoot = process.env.SystemRoot,
  } = {},
) {
  assertPid(pid);
  if (typeof platform !== "string") {
    throw new TypeError("The local process platform is invalid.");
  }
  if (typeof runCommand !== "function" || typeof probeProcess !== "function") {
    throw new TypeError("The local process identity adapter is invalid.");
  }
  if (platform === "linux") {
    if (!fileSystem || typeof fileSystem.readFile !== "function") {
      throw new TypeError("The local process identity adapter is invalid.");
    }
    return inspectLinuxProcess(pid, { fileSystem });
  }
  if (platform === "darwin") return inspectMacProcess(pid, { probeProcess, runCommand });
  if (platform === "win32") {
    return inspectWindowsProcess(pid, { probeProcess, runCommand, systemRoot });
  }
  return Object.freeze({ state: "ambiguous" });
}

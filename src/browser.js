import { spawn } from "node:child_process";
import { basename, dirname, win32 } from "node:path";
import { fileURLToPath } from "node:url";

const HANDOFF_DIRECTORY_PATTERN = /^relmio-browser-[A-Za-z0-9_-]{6,64}$/u;
const HANDOFF_FILE_PATTERN = /^launch-[a-f0-9]{24}\.html$/u;

function windowsFilePath(url) {
  const parsed = new URL(url);
  let pathname;
  try {
    pathname = decodeURIComponent(parsed.pathname);
  } catch {
    throw new TypeError("Relmio browser handoff URL is invalid.");
  }
  if (/^\/[A-Za-z]:\//u.test(pathname)) pathname = pathname.slice(1);
  return pathname.replaceAll("/", "\\");
}

function windowsExplorer(systemRoot) {
  if (
    typeof systemRoot !== "string" || !win32.isAbsolute(systemRoot) ||
    /[\u0000-\u001F\u007F"<>|*?]/u.test(systemRoot)
  ) {
    throw new TypeError("Relmio Windows system root is invalid.");
  }
  return win32.join(win32.normalize(systemRoot), "explorer.exe");
}

export function isPrivateBrowserLaunchUrl(value) {
  if (typeof value !== "string" || /[\u0000-\u001F\u007F]/u.test(value)) return false;
  try {
    const parsed = new URL(value);
    if (
      parsed.protocol !== "file:" || parsed.hostname !== "" || parsed.username ||
      parsed.password || parsed.search || parsed.hash
    ) return false;
    const path = fileURLToPath(parsed);
    return HANDOFF_FILE_PATTERN.test(basename(path)) &&
      HANDOFF_DIRECTORY_PATTERN.test(basename(dirname(path)));
  } catch {
    return false;
  }
}

export function browserCommand(
  launchUrl,
  platform = process.platform,
  { systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? process.env.WINDIR } = {},
) {
  if (!isPrivateBrowserLaunchUrl(launchUrl)) {
    throw new TypeError("Relmio browser handoff URL is invalid.");
  }
  if (platform === "darwin") return { file: "open", args: [launchUrl] };
  if (platform === "win32") {
    return {
      file: windowsExplorer(systemRoot),
      args: [windowsFilePath(launchUrl)],
    };
  }
  return { file: "xdg-open", args: [launchUrl] };
}

export async function openBrowser(
  launchUrl,
  {
    platform = process.platform,
    spawnProcess = spawn,
    launchTimeoutMs = 5_000,
    systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? process.env.WINDIR,
  } = {},
) {
  if (
    !isPrivateBrowserLaunchUrl(launchUrl) ||
    !Number.isSafeInteger(launchTimeoutMs) || launchTimeoutMs < 1 || launchTimeoutMs > 30_000
  ) return false;
  let command;
  try {
    command = browserCommand(launchUrl, platform, { systemRoot });
  } catch {
    return false;
  }
  let child;
  try {
    child = spawnProcess(command.file, command.args, {
      detached: true,
      stdio: "ignore",
      shell: false,
    });
  } catch {
    return false;
  }
  if (
    !child || typeof child.once !== "function" ||
    typeof child.removeListener !== "function" || typeof child.unref !== "function"
  ) return false;
  child.unref();

  return await new Promise((resolveLaunch) => {
    let settled = false;
    let spawned = false;
    let timer;
    const settle = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.removeListener("spawn", onSpawn);
      child.removeListener("error", onError);
      child.removeListener("exit", onExit);
      resolveLaunch(result);
    };
    const onSpawn = () => { spawned = true; };
    const onError = () => settle(false);
    const onExit = (code, signal) => settle(signal === null && code === 0);
    child.once("spawn", onSpawn);
    child.once("error", onError);
    child.once("exit", onExit);
    timer = setTimeout(() => settle(spawned), launchTimeoutMs);
  });
}

export function attachBrowserReopenOnEnter({
  input = process.stdin,
  prepareLaunch,
  open = openBrowser,
  write = console.log,
}) {
  if (!input.isTTY) return () => {};
  if (typeof prepareLaunch !== "function" || typeof open !== "function") {
    throw new TypeError("Relmio browser reopen adapter is invalid.");
  }

  const onData = (data) => {
    if (/\r|\n/u.test(String(data))) {
      void Promise.resolve()
        .then(() => prepareLaunch())
        .then((url) => open(url))
        .catch(() => {});
    }
  };

  input.setEncoding?.("utf8");
  input.resume?.();
  input.on("data", onData);
  write("If the wizard did not open automatically, press Enter to open it again.");

  return () => {
    input.off("data", onData);
    input.pause?.();
  };
}

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

export function isOpenAiAuthorizationUrl(value) {
  if (typeof value !== "string" || value.length > 4096 || /[\u0000-\u0020\u007F]/u.test(value)) return false;
  try {
    const url = new URL(value);
    if (url.origin !== "https://auth.openai.com" ||
        url.pathname !== "/api/accounts/authorize" || url.hash ||
        url.username || url.password || url.href !== value) return false;
    const allowed = new Set(["client_id", "agent_name_hint", "ext_agent_host_id",
      "response_type", "redirect_uri", "scope", "resource", "state", "nonce",
      "code_challenge_method", "code_challenge", "prompt"]);
    const keys = [...url.searchParams.keys()];
    const required = ["client_id", "ext_agent_host_id", "response_type", "redirect_uri",
      "scope", "resource", "state", "nonce", "code_challenge_method", "code_challenge"];
    const clientId = url.searchParams.get("client_id");
    if (keys.some(key => !allowed.has(key)) || new Set(keys).size !== keys.length ||
        required.some(key => !url.searchParams.has(key)) ||
        !/^[!-~]{1,256}$/u.test(clientId ?? "") ||
        !/^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(url.searchParams.get("ext_agent_host_id") ?? "") ||
        (clientId === "dynamic_agent_client" ? url.searchParams.get("agent_name_hint") !== "Relmio" : url.searchParams.has("agent_name_hint")) ||
        (url.searchParams.has("prompt") && url.searchParams.get("prompt") !== "consent") ||
        url.searchParams.get("response_type") !== "code" ||
        url.searchParams.get("code_challenge_method") !== "S256" ||
        url.searchParams.get("resource") !== "https://api.openai.com/v1" ||
        url.searchParams.get("scope") !== "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct" ||
        !/^[A-Za-z0-9_-]{32,128}$/u.test(url.searchParams.get("state") ?? "") ||
        !/^[A-Za-z0-9_-]{32,128}$/u.test(url.searchParams.get("nonce") ?? "") ||
        !/^[A-Za-z0-9_-]{43}$/u.test(url.searchParams.get("code_challenge") ?? "")) return false;
    const redirectUri = url.searchParams.get("redirect_uri");
    const redirect = new URL(redirectUri);
    return redirect.protocol === "http:" && redirect.hostname === "127.0.0.1" &&
      Number(redirect.port) >= 1 && Number(redirect.port) <= 65535 &&
      redirect.pathname === "/auth/callback" && redirect.href === redirectUri &&
      !redirect.search && !redirect.hash;
  } catch {
    return false;
  }
}

export async function openOpenAiAuthorization(url, options = {}) {
  if (!isOpenAiAuthorizationUrl(url)) return false;
  return launchCommand(url, options);
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

export async function openBrowser(launchUrl, options = {}) {
  if (!isPrivateBrowserLaunchUrl(launchUrl)) return false;
  return launchCommand(launchUrl, options);
}

async function launchCommand(launchUrl, {
  platform = process.platform,
  spawnProcess = spawn,
  launchTimeoutMs = 5_000,
  systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT ?? process.env.WINDIR,
} = {}) {
  if (!Number.isSafeInteger(launchTimeoutMs) || launchTimeoutMs < 1 || launchTimeoutMs > 30_000) return false;
  let command;
  try {
    command = isPrivateBrowserLaunchUrl(launchUrl)
      ? browserCommand(launchUrl, platform, { systemRoot })
      : isOpenAiAuthorizationUrl(launchUrl)
        ? platform === "darwin" ? { file: "open", args: [launchUrl] }
          : platform === "win32" ? { file: windowsExplorer(systemRoot), args: [launchUrl] }
            : { file: "xdg-open", args: [launchUrl] }
        : null;
  } catch {
    return false;
  }
  if (!command) return false;
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
    const onSpawn = () => {
      spawned = true;
      // Explorer dispatches to the shell; its exit code does not report browser loading.
      if (platform === "win32") settle(true);
    };
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

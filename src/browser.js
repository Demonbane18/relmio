import { spawn } from "node:child_process";

export function browserCommand(url, platform = process.platform) {
  if (platform === "darwin") {
    return { file: "open", args: [url] };
  }
  if (platform === "win32") {
    return { file: "explorer.exe", args: [url] };
  }
  return { file: "xdg-open", args: [url] };
}

export function openBrowser(
  url,
  { platform = process.platform, spawnProcess = spawn } = {},
) {
  const command = browserCommand(url, platform);
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
  child.once("error", () => {
    // The URL is also printed, so users can open it manually.
  });
  child.unref();
  return true;
}

export function attachBrowserReopenOnEnter({
  input = process.stdin,
  url,
  open = openBrowser,
  write = console.log,
}) {
  if (!input.isTTY) {
    return () => {};
  }

  const onData = (data) => {
    if (/\r|\n/u.test(String(data))) {
      open(url);
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

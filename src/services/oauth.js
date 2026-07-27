import * as defaultFileSystem from "node:fs/promises";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { spawn } from "node:child_process";

const MAX_AUTH_FILE_BYTES = 128 * 1024;
const LOGIN_TIMEOUT_MS = 300_000;
const PROCESS_TIMEOUT_MS = LOGIN_TIMEOUT_MS + 15_000;

export function resolveAuthPath({
  env = process.env,
  homeDirectory = homedir(),
} = {}) {
  if (typeof env.CODEX_HOME === "string" && env.CODEX_HOME.trim() !== "") {
    return resolve(env.CODEX_HOME, "auth.json");
  }
  return resolve(homeDirectory, ".codex", "auth.json");
}

export async function getAuthStatus({
  fileSystem = defaultFileSystem,
  env = process.env,
  homeDirectory = homedir(),
} = {}) {
  const path = resolveAuthPath({ env, homeDirectory });

  try {
    await fileSystem.access(path);
    return { exists: true, path };
  } catch (error) {
    if (error.code === "ENOENT") {
      return { exists: false, path };
    }
    throw new Error("The local OAuth credential location could not be checked.");
  }
}

export async function readAuthContents({
  authPath,
  fileSystem = defaultFileSystem,
}) {
  let contents;
  try {
    contents = await fileSystem.readFile(authPath);
  } catch {
    throw new Error("The local OAuth credential file could not be read.");
  }

  if (
    !Buffer.isBuffer(contents) ||
    contents.length === 0 ||
    contents.length > MAX_AUTH_FILE_BYTES
  ) {
    throw new Error("The local OAuth credential file is invalid.");
  }

  try {
    const parsed = JSON.parse(contents.toString("utf8"));
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new TypeError();
    }
  } catch {
    throw new Error("The local OAuth credential file is invalid.");
  }

  return contents;
}

export async function runOAuthLogin({
  fileSystem = defaultFileSystem,
  env = process.env,
  homeDirectory = homedir(),
  platform = process.platform,
  spawnProcess = spawn,
} = {}) {
  const command = platform === "win32" ? "npx.cmd" : "npx";
  const args = [
    "--yes",
    "openai-oauth@2.0.0",
    "login",
    "--open",
    "--login-timeout-ms",
    String(LOGIN_TIMEOUT_MS),
  ];

  await new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    const child = spawnProcess(command, args, {
      env,
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });

    child.stdin?.end("y\n");
    child.stdout?.resume();
    child.stderr?.resume();

    const timeout = setTimeout(() => {
      if (!settled) {
        settled = true;
        child.kill?.("SIGTERM");
        rejectPromise(
          new Error("The sign-in request expired. Start a fresh login."),
        );
      }
    }, PROCESS_TIMEOUT_MS);

    child.once("error", () => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        rejectPromise(
          new Error(
            "The local sign-in command could not start. Install Node.js 22 and try again.",
          ),
        );
      }
    });
    child.once("exit", (code) => {
      if (!settled) {
        settled = true;
        clearTimeout(timeout);
        if (code === 0) {
          resolvePromise();
        } else {
          rejectPromise(
            new Error("ChatGPT sign-in did not finish. Start a fresh login."),
          );
        }
      }
    });
  });

  const status = await getAuthStatus({
    fileSystem,
    env,
    homeDirectory,
  });
  if (!status.exists) {
    throw new Error("Sign-in finished, but no local credential file was found.");
  }

  return { success: true };
}

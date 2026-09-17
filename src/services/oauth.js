import * as defaultFileSystem from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";
import { lockDownLocalPath } from "../infrastructure/local-process.js";

const MAX_AUTH_FILE_BYTES = 128 * 1024;
const MAX_LOGIN_OUTPUT_BYTES = 32 * 1024;
const LOGIN_TIMEOUT_MS = 300_000;
const PROCESS_TIMEOUT_MS = LOGIN_TIMEOUT_MS + 15_000;
const CREDENTIAL_POLL_INTERVAL_MS = 100;
const PROCESS_TERMINATION_GRACE_MS = 1_000;
const PROCESS_TERMINATION_FORCE_WAIT_MS = 1_000;
const TERMINATION_UNCONFIRMED_MESSAGE =
  "ChatGPT sign-in could not be stopped safely. Close the sign-in helper, then restart Relmio.";
const CODEX_LOGIN_PACKAGE = "@openai/codex@0.154.0";

const wait = (milliseconds) =>
  new Promise((resolvePromise) => setTimeout(resolvePromise, milliseconds));

function resolveWindowsNpxCli({ env, execPath }) {
  const npmExecPathKey = Object.keys(env ?? {}).find(
    (key) => key.toLowerCase() === "npm_execpath",
  );
  const npmExecPath =
    npmExecPathKey === undefined ? undefined : env[npmExecPathKey];

  if (typeof npmExecPath === "string") {
    if (/(?:^|[\\/])npx-cli\.js$/iu.test(npmExecPath)) {
      return resolve(npmExecPath);
    }
    if (/(?:^|[\\/])npm-cli\.js$/iu.test(npmExecPath)) {
      return resolve(dirname(npmExecPath), "npx-cli.js");
    }
  }

  return resolve(dirname(execPath), "node_modules", "npm", "bin", "npx-cli.js");
}

function createNpxInvocation({ platform, env, execPath }) {
  if (platform !== "win32") {
    return { command: "npx", prefixArgs: [] };
  }

  return {
    command: execPath,
    // Windows cannot execute npx.cmd directly with shell:false.
    prefixArgs: [resolveWindowsNpxCli({ env, execPath })],
  };
}

export function resolveAuthPath({
  env = process.env,
  homeDirectory = homedir(),
} = {}) {
  if (
    typeof env.N8N_OPENAI_OAUTH_HOME === "string" &&
    env.N8N_OPENAI_OAUTH_HOME.trim() !== ""
  ) {
    return resolve(env.N8N_OPENAI_OAUTH_HOME, "auth.json");
  }
  return resolve(homeDirectory, ".n8n-openai-oauth", "auth.json");
}

export async function getAuthStatus({
  fileSystem = defaultFileSystem,
  env = process.env,
  homeDirectory = homedir(),
} = {}) {
  const path = resolveAuthPath({ env, homeDirectory });

  try {
    await fileSystem.access(path);
    const metadata = await fileSystem.stat(path);
    return {
      exists: true,
      path,
      updatedAt: metadata.mtime.toISOString(),
    };
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
    const tokens = parsed?.tokens;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      Array.isArray(parsed) ||
      parsed.auth_mode !== "chatgpt" ||
      !tokens ||
      typeof tokens !== "object" ||
      Array.isArray(tokens) ||
      ![tokens.access_token, tokens.id_token, tokens.refresh_token].every(
        (token) => typeof token === "string" && token.length > 0,
      )
    ) {
      throw new TypeError();
    }
  } catch {
    throw new Error("The local OAuth credential file is invalid.");
  }

  return contents;
}

function stripTerminalControlSequences(value) {
  return value
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/gu, "")
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/gu, "");
}

function loginProcessError(stderr) {
  const sanitized = stripTerminalControlSequences(stderr);
  if (
    /port\s+\d+[^\n]*(?:already\s+in\s+use|address\s+in\s+use)/iu.test(sanitized) ||
    /address\s+already\s+in\s+use/iu.test(sanitized)
  ) {
    return new Error(
      "ChatGPT sign-in could not open its local callback port. Close other sign-in helpers and try again.",
    );
  }
  return new Error(
    "ChatGPT sign-in did not finish. Start a fresh login. If no browser opened, check the Windows default browser and try again.",
  );
}

export async function startOAuthLogin({
  fileSystem = defaultFileSystem,
  env = process.env,
  homeDirectory = homedir(),
  platform = process.platform,
  execPath = process.execPath,
  spawnProcess = spawn,
  createPendingId = randomUUID,
  waitForCredentialPoll = wait,
  killProcess = process.kill,
  terminationGraceMs = PROCESS_TERMINATION_GRACE_MS,
  terminationForceWaitMs = PROCESS_TERMINATION_FORCE_WAIT_MS,
  createTimer = setTimeout,
  clearTimer = clearTimeout,
  lockDownPath = lockDownLocalPath,
} = {}) {
  const npxInvocation = createNpxInvocation({ platform, env, execPath });
  const authPath = resolveAuthPath({ env, homeDirectory });
  const authDirectory = dirname(authPath);
  const pendingId = createPendingId();
  if (
    typeof pendingId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/u.test(pendingId)
  ) {
    throw new Error("The local sign-in attempt identifier is invalid.");
  }
  const pendingCodexHome = resolve(authDirectory, `.codex-login-${pendingId}`);
  if (dirname(pendingCodexHome) !== authDirectory) {
    throw new Error("The local sign-in credential directory is invalid.");
  }
  const pendingAuthPath = resolve(pendingCodexHome, "auth.json");
  const loginEnv = Object.fromEntries(
    Object.entries(env ?? {}).filter(([name]) => name.toLowerCase() !== "codex_home"),
  );
  loginEnv.CODEX_HOME = pendingCodexHome;
  const args = [
    "--yes",
    "--ignore-scripts",
    `--package=${CODEX_LOGIN_PACKAGE}`,
    "--",
    "codex",
    "-c",
    'cli_auth_credentials_store="file"',
    "login",
  ];

  await fileSystem.mkdir(authDirectory, { recursive: true, mode: 0o700 });
  await fileSystem.chmod(authDirectory, 0o700);
  await lockDownPath(authDirectory, { platform, kind: "directory" });
  await fileSystem.mkdir(pendingCodexHome, { mode: 0o700 });
  await fileSystem.chmod(pendingCodexHome, 0o700);
  await lockDownPath(pendingCodexHome, { platform, kind: "directory" });

  let child;
  try {
    child = spawnProcess(
      npxInvocation.command,
      [...npxInvocation.prefixArgs, ...args],
      {
        env: loginEnv,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        ...(platform === "win32" ? {} : { detached: true }),
      },
    );
  } catch (error) {
    try {
      await fileSystem.rm(pendingCodexHome, { recursive: true, force: true });
    } catch {
      // Preserve the sanitized process-launch error.
    }
    throw new Error(
      "The local sign-in command could not start. Update Relmio and retry with Node.js 24 or newer.",
      { cause: error },
    );
  }
  const loginOutput = { stdout: "", stderr: "" };
  let loginOutputBytes = 0;
  let cancelAttempt = () => Promise.resolve();

  const captureLoginOutput = (stream, chunk) => {
    const output = Buffer.from(chunk).toString("utf8");
    loginOutputBytes += Buffer.byteLength(output);
    if (loginOutputBytes > MAX_LOGIN_OUTPUT_BYTES) {
      void requestCancellation("The sign-in command returned too much output.").catch(
        () => {},
      );
      return;
    }
    loginOutput[stream] += output;
  };

  child.stdout?.on?.("data", (chunk) => captureLoginOutput("stdout", chunk));
  child.stderr?.on?.("data", (chunk) => captureLoginOutput("stderr", chunk));

  let resolveProcessClose;
  let rejectProcessClose;
  let processCloseSettled = false;
  const processClosePromise = new Promise((resolvePromise, rejectPromise) => {
    resolveProcessClose = resolvePromise;
    rejectProcessClose = rejectPromise;
  });
  const settleProcessClose = (error, code) => {
    if (processCloseSettled) {
      return;
    }
    processCloseSettled = true;
    if (error) {
      rejectProcessClose(error);
    } else {
      resolveProcessClose(code);
    }
  };

  child.once("error", () => {
    const error = new Error(
      "The local sign-in command could not start. Install Node.js 24 and try again.",
    );
    settleProcessClose(error);
  });
  child.once("close", (code) => {
    settleProcessClose(null, code);
  });

  let keepPollingForCredential = true;
  let cancellationRequested = false;
  let rejectCancellation;
  const cancellationPromise = new Promise((_, rejectPromise) => {
    rejectCancellation = rejectPromise;
  });
  cancellationPromise.catch(() => {});

  const promotionAuthPath = `${pendingAuthPath}.ready`;
  let credentialPromotion;
  let promotionPhase = "idle";
  const promotionCancellationWaitMs =
    terminationGraceMs + terminationForceWaitMs;
  const createRetryBlockedError = () =>
    Object.assign(new Error(TERMINATION_UNCONFIRMED_MESSAGE), {
      retryBlocked: true,
    });
  const assertPromotionActive = () => {
    if (cancellationRequested) {
      throw new Error("ChatGPT sign-in did not finish. Start a fresh login.");
    }
  };
  const savePendingCredential = () => {
    if (credentialPromotion) {
      return credentialPromotion;
    }

    credentialPromotion = (async () => {
      promotionPhase = "staging";
      try {
        assertPromotionActive();
        await lockDownPath(pendingAuthPath, { platform, kind: "file" });
        assertPromotionActive();
        await readAuthContents({
          authPath: pendingAuthPath,
          fileSystem,
        });
        assertPromotionActive();
        await fileSystem.chmod(pendingAuthPath, 0o600);
        assertPromotionActive();
        await fileSystem.copyFile(pendingAuthPath, promotionAuthPath);
        assertPromotionActive();
        await fileSystem.chmod(promotionAuthPath, 0o600);
        await lockDownPath(promotionAuthPath, { platform, kind: "file" });
        assertPromotionActive();
        promotionPhase = "committing";
        await fileSystem.rename(promotionAuthPath, authPath);
        promotionPhase = "committed";
      } catch (error) {
        if (cancellationRequested && promotionPhase !== "committed") {
          promotionPhase = "cancelled";
        }
        throw error;
      }
    })();
    credentialPromotion.catch(() => {});
    return credentialPromotion;
  };

  const waitForBoundedResult = (promise, milliseconds) =>
    new Promise((resolvePromise) => {
      let settled = false;
      const timer = createTimer(() => {
        if (!settled) {
          settled = true;
          resolvePromise(false);
        }
      }, milliseconds);
      promise.then(
        () => {
          if (!settled) {
            settled = true;
            clearTimer(timer);
            resolvePromise(true);
          }
        },
        () => {
          if (!settled) {
            settled = true;
            clearTimer(timer);
            resolvePromise(true);
          }
        },
      );
    });

  const waitForDuration = (milliseconds) =>
    new Promise((resolvePromise) => {
      createTimer(() => resolvePromise(true), milliseconds);
    });

  const waitForTaskkill = (taskkill, milliseconds) =>
    new Promise((resolvePromise) => {
      let settled = false;
      const finish = (confirmed) => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimer(timer);
        resolvePromise(confirmed);
      };
      const timer = createTimer(() => finish(false), milliseconds);
      taskkill?.once?.("error", () => finish(false));
      taskkill?.once?.("close", (code) => finish(code === 0));
      if (!taskkill?.once) {
        finish(false);
      }
    });

  let terminationPromise;
  const terminateProcessTree = () => {
    if (terminationPromise) {
      return terminationPromise;
    }

    terminationPromise = (async () => {
      const hasChildPid = Number.isSafeInteger(child.pid) && child.pid > 0;

      if (platform === "win32" && hasChildPid) {
        const runTaskkill = async (force, timeout) => {
          try {
            const taskkill = spawnProcess(
              "taskkill",
              ["/pid", String(child.pid), "/t", ...(force ? ["/f"] : [])],
              {
                shell: false,
                stdio: "ignore",
                windowsHide: true,
              },
            );
            return await waitForTaskkill(taskkill, timeout);
          } catch {
            return false;
          }
        };
        if (
          (await runTaskkill(false, terminationGraceMs)) ||
          (await runTaskkill(true, terminationForceWaitMs))
        ) {
          return;
        }
      } else if (hasChildPid) {
        const processGroupIsGone = () => {
          try {
            killProcess(-child.pid, 0);
            return false;
          } catch (error) {
            return error?.code === "ESRCH";
          }
        };
        try {
          killProcess(-child.pid, "SIGTERM");
        } catch {
          // The group may have already exited between launch and cancellation.
        }
        if (
          processGroupIsGone() ||
          ((await waitForDuration(terminationGraceMs)) && processGroupIsGone())
        ) {
          return;
        }
        try {
          killProcess(-child.pid, "SIGKILL");
        } catch {
          // A final process-group check below determines whether it is gone.
        }
        if (
          processGroupIsGone() ||
          ((await waitForDuration(terminationForceWaitMs)) &&
            processGroupIsGone())
        ) {
          return;
        }
      } else {
        try {
          child.kill?.("SIGTERM");
        } catch {
          // The process may have already exited before cancellation.
        }
        if (
          processCloseSettled ||
          (await waitForBoundedResult(
            processClosePromise,
            terminationGraceMs,
          ))
        ) {
          return;
        }
        try {
          child.kill?.("SIGKILL");
        } catch {
          // The direct child is only a last resort when no PID is available.
        }
        if (
          processCloseSettled ||
          (await waitForBoundedResult(
            processClosePromise,
            terminationForceWaitMs,
          ))
        ) {
          return;
        }
      }

      throw createRetryBlockedError();
    })();
    return terminationPromise;
  };

  cancelAttempt = async (
    message = "ChatGPT sign-in stopped. Start a fresh login.",
  ) => {
    if (!cancellationRequested) {
      cancellationRequested = true;
      keepPollingForCredential = false;
      rejectCancellation(new Error(message));
    }
    let promotionError;
    try {
      if (
        credentialPromotion &&
        !(await waitForBoundedResult(
          credentialPromotion,
          promotionCancellationWaitMs,
        ))
      ) {
        promotionError = createRetryBlockedError();
      }
    } catch {
      // Cancellation intentionally abandons a staged but unpromoted credential.
    }
    if (
      promotionPhase === "committing" ||
      promotionPhase === "committed"
    ) {
      promotionError = createRetryBlockedError();
    }
    let terminationError;
    try {
      await terminateProcessTree();
    } catch (error) {
      terminationError = error;
    }
    if (promotionError) {
      throw promotionError;
    }
    if (terminationError) {
      throw terminationError;
    }
  };

  let cancellationResult;
  const requestCancellation = (message) => {
    if (!cancellationResult) {
      cancellationResult = cancelAttempt(message);
      cancellationResult.catch(() => {});
    }
    return cancellationResult;
  };

  const pendingCredentialPromise = (async () => {
    while (keepPollingForCredential) {
      try {
        await readAuthContents({
          authPath: pendingAuthPath,
          fileSystem,
        });
      } catch {
        await waitForCredentialPoll(CREDENTIAL_POLL_INTERVAL_MS);
        continue;
      }
      return { success: true };
    }
    throw new Error("ChatGPT sign-in did not finish. Start a fresh login.");
  })();
  pendingCredentialPromise.catch(() => {});

  const completion = (async () => {
    let processTimeout;
    let completedSuccessfully = false;
    try {
      const result = await Promise.race([
        processClosePromise.then(async (code) => {
          if (code !== 0) {
            throw loginProcessError(loginOutput.stderr);
          }
          await pendingCredentialPromise;
          await savePendingCredential();
          return { success: true };
        }),
        cancellationPromise,
        new Promise((_, rejectPromise) => {
          processTimeout = createTimer(() => {
            const error = new Error(
              "The sign-in request expired. Start a fresh login.",
            );
            void requestCancellation(error.message).catch(() => {});
            rejectPromise(error);
          }, PROCESS_TIMEOUT_MS);
        }),
      ]);
      completedSuccessfully = result.success === true;
      return result;
    } finally {
      keepPollingForCredential = false;
      clearTimer(processTimeout);
      try {
        await credentialPromotion;
      } catch {
        // A cancellation can abandon an attempt-local staged credential.
      }
      if (cancellationResult) {
        try {
          await cancellationResult;
        } catch (error) {
          if (error?.retryBlocked === true) {
            throw error;
          }
        }
      }
      const committedBeforeFailure =
        !completedSuccessfully && promotionPhase === "committed";
      if (!processCloseSettled) {
        await terminateProcessTree();
      }
      try {
        await fileSystem.rm(pendingAuthPath, { force: true });
        await fileSystem.rm(promotionAuthPath, { force: true });
        await fileSystem.rm(pendingCodexHome, { recursive: true, force: true });
      } catch {
        // A failed cleanup must not hide the actionable sign-in result.
      }
      if (committedBeforeFailure) {
        throw createRetryBlockedError();
      }
    }
  })();
  completion.catch(() => {});
  return Object.freeze({
    launchMode: "system-browser",
    completion,
    cancel() {
      return requestCancellation();
    },
  });
}

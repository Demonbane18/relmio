import * as defaultFileSystem from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, resolve } from "node:path";
import { spawn } from "node:child_process";

const MAX_AUTH_FILE_BYTES = 128 * 1024;
const MAX_LOGIN_OUTPUT_BYTES = 32 * 1024;
const LOGIN_URL_TIMEOUT_MS = 15_000;
const LOGIN_TIMEOUT_MS = 300_000;
const PROCESS_TIMEOUT_MS = LOGIN_TIMEOUT_MS + 15_000;
const CREDENTIAL_POLL_INTERVAL_MS = 100;
const PROCESS_TERMINATION_GRACE_MS = 1_000;
const PROCESS_TERMINATION_FORCE_WAIT_MS = 1_000;
const TERMINATION_UNCONFIRMED_MESSAGE =
  "ChatGPT sign-in could not be stopped safely. Close the sign-in helper, then restart Relmio.";
const LOGIN_URL_PREFIX = "OpenAI OAuth login URL: ";
const OPENAI_AUTH_ORIGIN = "https://auth.openai.com";
const SUPPORTED_LOOPBACK_REDIRECT_HOSTNAMES = new Set([
  "localhost",
  "127.0.0.1",
  "[::1]",
]);

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
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw new TypeError();
    }
  } catch {
    throw new Error("The local OAuth credential file is invalid.");
  }

  return contents;
}

function validateAuthorizationUrl(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    throw new Error("The sign-in command returned an invalid authorization URL.");
  }

  if (
    url.origin !== OPENAI_AUTH_ORIGIN ||
    url.username !== "" ||
    url.password !== "" ||
    url.hash !== "" ||
    url.href.includes("#") ||
    url.pathname !== "/oauth/authorize" ||
    url.searchParams.get("response_type") !== "code" ||
    !url.searchParams.get("state") ||
    !url.searchParams.get("code_challenge")
  ) {
    throw new Error("The sign-in command returned an unexpected destination.");
  }

  let redirect;
  try {
    redirect = new URL(url.searchParams.get("redirect_uri") ?? "");
  } catch {
    throw new Error("The sign-in command returned an invalid callback.");
  }
  if (
    redirect.protocol !== "http:" ||
    redirect.username !== "" ||
    redirect.password !== "" ||
    redirect.search !== "" ||
    redirect.hash !== "" ||
    redirect.href.includes("?") ||
    redirect.href.includes("#") ||
    !SUPPORTED_LOOPBACK_REDIRECT_HOSTNAMES.has(redirect.hostname) ||
    redirect.port !== "1455" ||
    redirect.pathname !== "/auth/callback"
  ) {
    throw new Error("The sign-in command returned an unexpected callback.");
  }

  return url.toString();
}

function stripTerminalControlSequences(value) {
  return value
    .replace(/\u001B\][^\u0007]*(?:\u0007|\u001B\\)/gu, "")
    .replace(/\u001B\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/[\u0000-\u0009\u000B-\u001F\u007F-\u009F]/gu, "");
}

function extractAuthorizationUrl(output, { includeFinalLine = false } = {}) {
  const lines = stripTerminalControlSequences(output).split("\n");
  const lineCount = includeFinalLine ? lines.length : lines.length - 1;
  for (const line of lines.slice(0, lineCount)) {
    const markerIndex = line.indexOf(LOGIN_URL_PREFIX);
    if (markerIndex >= 0) {
      return validateAuthorizationUrl(
        line.slice(markerIndex + LOGIN_URL_PREFIX.length).trim(),
      );
    }
  }
  return null;
}

function loginStartupError(stderr) {
  const callbackPortConflict =
    "OpenAI OAuth login needs http://localhost:1455/auth/callback, but port 1455 is already in use.";
  if (stripTerminalControlSequences(stderr).includes(callbackPortConflict)) {
    return new Error(
      `${callbackPortConflict} Stop the process using that port and try again.`,
    );
  }
  return new Error("The sign-in command did not return an authorization URL.");
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
} = {}) {
  const npxInvocation = createNpxInvocation({ platform, env, execPath });
  const authPath = resolveAuthPath({ env, homeDirectory });
  const authDirectory = dirname(authPath);
  const pendingAuthPath = `${authPath}.pending-${createPendingId()}`;
  const args = [
    "--yes",
    "--ignore-scripts",
    "--legacy-peer-deps=false",
    "--include=peer",
    "--package=openai-oauth@2.0.0",
    "--package=zod@4.1.8",
    "--",
    "openai-oauth",
    "login",
    "--no-open",
    "--login-timeout-ms",
    String(LOGIN_TIMEOUT_MS),
    "--oauth-file",
    pendingAuthPath,
  ];

  await fileSystem.mkdir(authDirectory, { recursive: true, mode: 0o700 });
  await fileSystem.chmod(authDirectory, 0o700);

  let child;
  try {
    child = spawnProcess(
      npxInvocation.command,
      [...npxInvocation.prefixArgs, ...args],
      {
        env,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
        ...(platform === "win32" ? {} : { detached: true }),
      },
    );
  } catch (error) {
    throw new Error(
      "The local sign-in command could not start. Update Relmio and retry with Node.js 22 or newer.",
      { cause: error },
    );
  }
  const loginOutput = { stdout: "", stderr: "" };
  let loginOutputBytes = 0;
  let cancelAttempt = () => Promise.resolve();
  let resolveAuthorizationUrl;
  let rejectAuthorizationUrl;
  let authorizationUrlSettled = false;
  const authorizationUrlPromise = new Promise((resolvePromise, rejectPromise) => {
    resolveAuthorizationUrl = resolvePromise;
    rejectAuthorizationUrl = rejectPromise;
  });
  const settleAuthorizationUrl = (error, authorizationUrl) => {
    if (authorizationUrlSettled) {
      return;
    }
    authorizationUrlSettled = true;
    if (error) {
      rejectAuthorizationUrl(error);
    } else {
      resolveAuthorizationUrl(authorizationUrl);
    }
  };

  const captureLoginOutput = (stream, chunk) => {
    if (authorizationUrlSettled) {
      return;
    }
    const output = Buffer.from(chunk).toString("utf8");
    loginOutputBytes += Buffer.byteLength(output);
    if (loginOutputBytes > MAX_LOGIN_OUTPUT_BYTES) {
      settleAuthorizationUrl(
        new Error("The sign-in command returned too much output."),
      );
      void requestCancellation("The sign-in command returned too much output.").catch(
        () => {},
      );
      return;
    }
    loginOutput[stream] += output;
    try {
      const authorizationUrl = extractAuthorizationUrl(loginOutput[stream]);
      if (authorizationUrl) {
        settleAuthorizationUrl(null, authorizationUrl);
      }
    } catch (error) {
      settleAuthorizationUrl(error);
      void requestCancellation(error.message).catch(() => {});
    }
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
      "The local sign-in command could not start. Install Node.js 22 and try again.",
    );
    settleAuthorizationUrl(error);
    settleProcessClose(error);
  });
  child.once("close", (code) => {
    if (!authorizationUrlSettled) {
      try {
        const authorizationUrl =
          extractAuthorizationUrl(loginOutput.stdout, {
            includeFinalLine: true,
          }) ??
          extractAuthorizationUrl(loginOutput.stderr, {
            includeFinalLine: true,
          });
        if (authorizationUrl) {
          settleAuthorizationUrl(null, authorizationUrl);
        } else {
          settleAuthorizationUrl(loginStartupError(loginOutput.stderr));
        }
      } catch (error) {
        settleAuthorizationUrl(error);
      }
    }
    settleProcessClose(null, code);
  });

  const loginUrlTimeout = createTimer(() => {
    const error = new Error(
      "The sign-in command did not provide a fresh login link.",
    );
    settleAuthorizationUrl(error);
    void requestCancellation(error.message).catch(() => {});
  }, LOGIN_URL_TIMEOUT_MS);

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
        assertPromotionActive();
        promotionPhase = "committing";
        await fileSystem.rename(promotionAuthPath, authPath);
        promotionPhase = "committed";
        await fileSystem.chmod(authPath, 0o600);
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
    await authorizationUrlPromise;
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
      await savePendingCredential();
      return { success: true };
    }
    throw new Error("ChatGPT sign-in did not finish. Start a fresh login.");
  })();

  const completion = (async () => {
    let processTimeout;
    let completedSuccessfully = false;
    try {
      const result = await Promise.race([
        pendingCredentialPromise,
        processClosePromise.then(async (code) => {
          if (code !== 0) {
            throw new Error(
              "ChatGPT sign-in did not finish. Start a fresh login.",
            );
          }
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
      clearTimer(loginUrlTimeout);
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
      if (!completedSuccessfully || !processCloseSettled) {
        await terminateProcessTree();
      }
      try {
        await fileSystem.rm(pendingAuthPath, { force: true });
        await fileSystem.rm(promotionAuthPath, { force: true });
      } catch {
        // A failed cleanup must not hide the actionable sign-in result.
      }
      if (committedBeforeFailure) {
        throw createRetryBlockedError();
      }
    }
  })();
  completion.catch(() => {});

  try {
    const authorizationUrl = await Promise.race([
      authorizationUrlPromise,
      completion.then(
        () => {
          throw new Error(
            "The sign-in command finished without a fresh login link.",
          );
        },
        (error) => {
          throw error;
        },
      ),
    ]);
    clearTimer(loginUrlTimeout);
    return {
      authorizationUrl,
      completion,
      cancel() {
        return requestCancellation();
      },
    };
  } catch (error) {
    clearTimer(loginUrlTimeout);
    let retryBlocked = false;
    try {
      await requestCancellation(error.message);
    } catch {
      retryBlocked = true;
    }
    try {
      await waitForBoundedResult(completion, promotionCancellationWaitMs);
    } catch {
      // Preserve the more specific authorization-link error.
    }
    if (retryBlocked) {
      error.retryBlocked = true;
    }
    throw error;
  }
}

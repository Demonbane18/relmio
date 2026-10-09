import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  attachBrowserReopenOnEnter,
  browserCommand,
  isOpenAiAuthorizationUrl,
  isPrivateBrowserLaunchUrl,
  openBrowser,
  openOpenAiAuthorization,
  windowsUrlLaunch,
} from "../src/browser.js";

const handoffDirectory = "relmio-browser-Ab3dE9";
const handoffFilename = "launch-0123456789abcdef01234567.html";
const launchUrl = pathToFileURL(join(tmpdir(), handoffDirectory, handoffFilename)).href;
const windowsLaunchUrl = `file:///C:/Users/Relmio/AppData/Local/Temp/${handoffDirectory}/${handoffFilename}`;
const sessionToken = `w${"s".repeat(42)}`;
const bootstrapSecret = "b".repeat(43);

function launcherChild(exitCode = 0) {
  const child = new EventEmitter();
  child.unref = () => {};
  queueMicrotask(() => {
    child.emit("spawn");
    child.emit("exit", exitCode, null);
  });
  return child;
}

test("browser launching accepts only a canonical private Relmio handoff file", () => {
  assert.equal(isPrivateBrowserLaunchUrl(launchUrl), true);
  for (const value of [
    `http://127.0.0.1:4567/local?session=${sessionToken}`,
    pathToFileURL(join(tmpdir(), "other", handoffFilename)).href,
    pathToFileURL(join(tmpdir(), handoffDirectory, "not-launch.html")).href,
    pathToFileURL(join(tmpdir(), handoffDirectory, "launch-secret.html")).href,
    `${launchUrl}?session=x`,
    `${launchUrl}#token`,
    "file://server/C:/Users/Relmio/AppData/Local/Temp/relmio-browser-Ab3dE9/launch-0123456789abcdef01234567.html",
    "relative/relmio-browser-Ab3dE9/launch-0123456789abcdef01234567.html",
    `${launchUrl}\n--unsafe`,
  ]) {
    assert.equal(isPrivateBrowserLaunchUrl(value), false, value);
  }
});

test("macOS and Linux launch only the non-authorizing file URL", async () => {
  for (const platform of ["darwin", "linux"]) {
    const calls = [];
    const expectedFile = platform === "darwin" ? "open" : "xdg-open";
    assert.deepEqual(browserCommand(launchUrl, platform), {
      file: expectedFile,
      args: [launchUrl],
    });
    assert.equal(await openBrowser(launchUrl, {
      platform,
      spawnProcess(...args) {
        calls.push(args);
        return launcherChild();
      },
    }), true);
    assert.deepEqual(calls, [[
      expectedFile,
      [launchUrl],
      { detached: true, stdio: "ignore", shell: false },
    ]]);
    const serialized = JSON.stringify(calls);
    assert.equal(serialized.includes(sessionToken), false);
    assert.equal(serialized.includes(bootstrapSecret), false);
    assert.doesNotMatch(serialized, /session=|relmio-bootstrap/iu);
  }
});

test("Windows uses the absolute system Explorer without a command parser", async () => {
  const calls = [];
  const command = browserCommand(windowsLaunchUrl, "win32", {
    systemRoot: "C:\\Windows",
  });
  assert.deepEqual(command, {
    file: "C:\\Windows\\explorer.exe",
    args: ["C:\\Users\\Relmio\\AppData\\Local\\Temp\\relmio-browser-Ab3dE9\\launch-0123456789abcdef01234567.html"],
  });
  assert.equal(await openBrowser(windowsLaunchUrl, {
    platform: "win32",
    systemRoot: "C:\\Windows",
    spawnProcess(...args) {
      calls.push(args);
      return launcherChild();
    },
  }), true);
  assert.deepEqual(calls, [[
    "C:\\Windows\\explorer.exe",
    command.args,
    { detached: true, stdio: "ignore", shell: false },
  ]]);
  assert.doesNotMatch(JSON.stringify(calls), /cmd\.exe|\/c|session=|relmio-bootstrap/iu);
});

test("browser launching rejects legacy bearer URLs and unsafe launcher inputs", async () => {
  const calls = [];
  for (const rejected of [
    `http://127.0.0.1:4567/?session=${sessionToken}`,
    `http://127.0.0.1:4567/assistant?session=${sessionToken}`,
    `http://127.0.0.1:4567/local?session=${sessionToken}`,
    `${launchUrl}?next=x`,
  ]) {
    assert.equal(await openBrowser(rejected, {
      spawnProcess(...args) {
        calls.push(args);
        return launcherChild();
      },
    }), false);
  }
  assert.deepEqual(calls, []);
  assert.throws(
    () => browserCommand(windowsLaunchUrl, "win32", { systemRoot: "relative\\Windows" }),
    TypeError,
  );
});

test("browser launching reports asynchronous launcher errors and direct-launcher nonzero exits", async (t) => {
  await t.test("error", async () => {
    const child = new EventEmitter();
    child.unref = () => {};
    queueMicrotask(() => child.emit("error", new Error("missing launcher")));
    assert.equal(await openBrowser(launchUrl, { spawnProcess: () => child }), false);
  });

  await t.test("nonzero exit", async () => {
    assert.equal(
      await openBrowser(launchUrl, {
        platform: "linux",
        spawnProcess: () => launcherChild(1),
      }),
      false,
    );
  });
});

test("Windows keeps a successfully dispatched Explorer handoff alive despite its exit code", async () => {
  assert.equal(await openBrowser(windowsLaunchUrl, {
    platform: "win32",
    systemRoot: "C:\\Windows",
    spawnProcess: () => launcherChild(1),
  }), true);
});

test("interactive Enter prepares a fresh handoff before every reopen", async () => {
  const input = new EventEmitter();
  input.isTTY = true;
  input.setEncoding = () => {};
  input.resume = () => {};
  let pauseCount = 0;
  input.pause = () => { pauseCount += 1; };
  const instructions = [];
  const opened = [];
  let prepared = 0;

  const detach = attachBrowserReopenOnEnter({
    input,
    async prepareLaunch() {
      prepared += 1;
      return launchUrl.replace("0123456789abcdef01234567", `${prepared}`.padStart(24, "0"));
    },
    open: async (url) => { opened.push(url); },
    write: (line) => instructions.push(line),
  });

  assert.deepEqual(instructions, [
    "If the wizard did not open automatically, press Enter to open it again.",
  ]);
  input.emit("data", "\r\n");
  input.emit("data", "\n");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(prepared, 2);
  assert.equal(opened.length, 2);
  assert.notEqual(opened[0], opened[1]);

  detach();
  input.emit("data", "\n");
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(opened.length, 2);
  assert.equal(pauseCount, 1);
});

test("noninteractive input never prepares a handoff", () => {
  const input = new EventEmitter();
  input.isTTY = false;
  let prepared = 0;
  const detach = attachBrowserReopenOnEnter({
    input,
    prepareLaunch: async () => { prepared += 1; return launchUrl; },
  });
  input.emit("data", "\n");
  detach();
  assert.equal(prepared, 0);
});

test("OpenAI authorization uses the system browser only for the exact SIWC transaction", async () => {
  const url = new URL("https://auth.openai.com/api/accounts/authorize");
  const fields = {
    client_id: "dynamic_agent_client",
    agent_name_hint: "Relmio",
    ext_agent_host_id: "urn:uuid:912eb843-21f6-4e5d-962c-a11390686d62",
    response_type: "code",
    redirect_uri: "http://127.0.0.1:45321/auth/callback",
    scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
    resource: "https://api.openai.com/v1",
    state: "a".repeat(43),
    nonce: "b".repeat(43),
    code_challenge_method: "S256",
    code_challenge: "c".repeat(43),
  };
  for (const [name, value] of Object.entries(fields)) url.searchParams.set(name, value);
  assert.equal(isOpenAiAuthorizationUrl(url.href), true);
  assert.equal(await openBrowser(url.href), false);
  for (const platform of ["darwin", "linux", "win32"]) {
    const calls = [];
    assert.equal(await openOpenAiAuthorization(url.href, {
      platform, systemRoot: "C:\\Windows",
      spawnProcess(...args) { calls.push(args); return launcherChild(); },
    }), true);
    assert.equal(calls.length, 1);
    if (platform === "win32") {
      assert.equal(calls[0][0], "C:\\Windows\\System32\\cmd.exe");
      assert.deepEqual(calls[0][1], windowsUrlLaunch([url.href]).args);
      assert.equal(calls[0][2].windowsVerbatimArguments, true);
      assert.equal(calls[0][2].windowsHide, true);
      assert.equal(calls[0][2].env.RELMIO_BROWSER_TARGET_0, url.href);
      assert.equal(calls[0][1].join(" ").includes("%"), false);
    } else {
      assert.equal(calls[0][0], platform === "darwin" ? "open" : "xdg-open");
      assert.deepEqual(calls[0][1], [url.href]);
    }
    assert.equal(calls[0][2].shell, false);
  }
  const rejected = ["https://example.com/api/accounts/authorize", "https://auth.openai.com/oauth/authorize"];
  for (const [name, value] of [["redirect_uri", "http://localhost:45321/auth/callback"],
    ["client_id", ""], ["scope", "openid"], ["agent_name_hint", "OtherApp"],
    ["ext_agent_host_id", "email@example.test"], ["prompt", "force_reconsent"],
    ["id_token_hint", "private-token"]]) {
    const bad = new URL(url);
    bad.searchParams.set(name, value);
    rejected.push(bad.href);
  }
  const duplicate = new URL(url);
  duplicate.searchParams.append("state", "d".repeat(43));
  rejected.push(duplicate.href, `${url.href}#fragment`, `${url.href}\n--unsafe`);
  let unsafeLaunches = 0;
  for (const value of rejected) {
    assert.equal(isOpenAiAuthorizationUrl(value), false, value);
    assert.equal(await openOpenAiAuthorization(value, {
      spawnProcess() { unsafeLaunches++; return launcherChild(); },
    }), false);
  }
  assert.equal(unsafeLaunches, 0);
});

function openAiAuthorizationUrl() {
  const url = new URL("https://auth.openai.com/api/accounts/authorize");
  const fields = {
    client_id: "dynamic_agent_client",
    agent_name_hint: "Relmio",
    ext_agent_host_id: "urn:uuid:912eb843-21f6-4e5d-962c-a11390686d62",
    response_type: "code",
    redirect_uri: "http://127.0.0.1:45321/auth/callback",
    scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
    resource: "https://api.openai.com/v1",
    state: "a".repeat(43),
    nonce: "b".repeat(43),
    code_challenge_method: "S256",
    code_challenge: "c".repeat(43),
  };
  for (const [name, value] of Object.entries(fields)) url.searchParams.set(name, value);
  return url.href;
}

test("Windows authorization launch failure is not treated as a started sign-in", async () => {
  assert.equal(await openOpenAiAuthorization(openAiAuthorizationUrl(), {
    platform: "win32",
    systemRoot: "C:\\Windows",
    spawnProcess: () => launcherChild(1),
  }), false);
});

test("windowsUrlLaunch keeps the URL out of cmd's command text", () => {
  const url = "http://127.0.0.1:9/oauth/authorize?redirect_uri=http%3A%2F%2F127.0.0.1%3A9%2Fauth%2Fcallback&x=!PATH!";
  const launch = windowsUrlLaunch([url]);
  assert.deepEqual(launch.args, ["/d", "/v:on", "/s", "/c", 'start "" "!RELMIO_BROWSER_TARGET_0!"']);
  assert.deepEqual(launch.env, { RELMIO_BROWSER_TARGET_0: url });
  assert.throws(() => windowsUrlLaunch(['http://127.0.0.1:9/?q="&calc']), TypeError);
  assert.throws(() => windowsUrlLaunch(["http://127.0.0.1:9/?q=\n"]), TypeError);
});

test("native Windows start passes an ampersand and percent-encoded URL unchanged", {
  skip: process.platform !== "win32",
}, async (t) => {
  const url = "http://127.0.0.1:9/oauth/authorize?response_type=code&client_id=abc&redirect_uri=http%3A%2F%2F127.0.0.1%3A9%2Fauth%2Fcallback&scope=openid%20profile%20email&state=a-b_c&code_challenge=x%2By&code_challenge_method=S256";
  const directory = await mkdtemp(join(tmpdir(), "relmio-win-browser-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const record = join(directory, "args.json");
  const script = join(directory, "browser.mjs");
  await writeFile(script, `import { writeFileSync } from "node:fs";
writeFileSync(${JSON.stringify(record)}, JSON.stringify(process.argv.slice(2)));
`);
  const launch = windowsUrlLaunch([process.execPath, script, url]);
  // Variables named like the URL's escapes: cmd's %...% expansion would replace %3A% with BROKEN.
  const child = spawn(join(process.env.SystemRoot, "System32", "cmd.exe"), launch.args, {
    env: { ...process.env, "3A": "BROKEN", "2F": "BROKEN", ...launch.env },
    windowsVerbatimArguments: true,
    windowsHide: true,
    shell: false,
  });
  const code = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", resolve);
  });
  assert.equal(code, 0);
  const deadline = Date.now() + 5_000;
  let recorded;
  while (Date.now() < deadline) {
    try {
      recorded = JSON.parse(await readFile(record, "utf8"));
      break;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  assert.deepEqual(recorded, [url]);
});

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";

import {
  attachBrowserReopenOnEnter,
  browserCommand,
  isPrivateBrowserLaunchUrl,
  openBrowser,
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
    /Windows system root/iu,
  );
});

test("browser launching reports asynchronous launcher errors and nonzero exits", async (t) => {
  await t.test("error", async () => {
    const child = new EventEmitter();
    child.unref = () => {};
    queueMicrotask(() => child.emit("error", new Error("missing launcher")));
    assert.equal(await openBrowser(launchUrl, { spawnProcess: () => child }), false);
  });

  await t.test("nonzero exit", async () => {
    assert.equal(
      await openBrowser(launchUrl, { spawnProcess: () => launcherChild(1) }),
      false,
    );
  });
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

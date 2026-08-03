import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  attachBrowserReopenOnEnter,
  browserCommand,
  openBrowser,
} from "../src/browser.js";

test("Windows browser launching invokes the default URL handler with the local URL as a literal argument", () => {
  const url = "http://127.0.0.1:4567/?session=literal&next=%26whoami";
  const command = browserCommand(url, "win32");

  assert.deepEqual(command, {
    file: "rundll32.exe",
    args: ["url.dll,FileProtocolHandler", url],
  });

  const calls = [];
  const child = new EventEmitter();
  child.unref = () => {};
  openBrowser(url, {
    platform: "win32",
    spawnProcess(...args) {
      calls.push(args);
      return child;
    },
  });

  assert.deepEqual(calls, [
    ["rundll32.exe", command.args, { detached: true, stdio: "ignore", shell: false }],
  ]);
});

test("browser launching refuses URLs outside the private local wizard", () => {
  const calls = [];

  const opened = openBrowser("https://example.test/?session=not-local", {
    platform: "win32",
    spawnProcess(...args) {
      calls.push(args);
      const child = new EventEmitter();
      child.unref = () => {};
      return child;
    },
  });

  assert.equal(opened, false);
  assert.deepEqual(calls, []);
});

test("macOS and Linux retain their native browser launchers", () => {
  assert.deepEqual(browserCommand("http://127.0.0.1:4567", "darwin"), {
    file: "open",
    args: ["http://127.0.0.1:4567"],
  });
  assert.deepEqual(browserCommand("http://127.0.0.1:4567", "linux"), {
    file: "xdg-open",
    args: ["http://127.0.0.1:4567"],
  });
});

test("interactive terminals reopen the local wizard on Enter without attaching to pipes", () => {
  const input = new EventEmitter();
  input.isTTY = true;
  input.setEncoding = () => {};
  input.resume = () => {};
  let pauseCount = 0;
  input.pause = () => {
    pauseCount += 1;
  };
  const instructions = [];
  const opened = [];

  const detach = attachBrowserReopenOnEnter({
    input,
    url: "http://127.0.0.1:4567/?session=fixture",
    open: (url) => opened.push(url),
    write: (line) => instructions.push(line),
  });

  assert.deepEqual(instructions, [
    "If the wizard did not open automatically, press Enter to open it again.",
  ]);
  input.emit("data", "\r\n");
  assert.deepEqual(opened, ["http://127.0.0.1:4567/?session=fixture"]);

  detach();
  input.emit("data", "\r\n");
  assert.equal(opened.length, 1);
  assert.equal(pauseCount, 1);

  const noninteractiveInput = new EventEmitter();
  noninteractiveInput.isTTY = false;
  const noOp = attachBrowserReopenOnEnter({
    input: noninteractiveInput,
    url: "http://127.0.0.1:4567/?session=fixture",
    open: (url) => opened.push(url),
    write: (line) => instructions.push(line),
  });
  noninteractiveInput.emit("data", "\n");
  noOp();

  assert.equal(opened.length, 1);
  assert.equal(instructions.length, 1);
});

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  attachBrowserReopenOnEnter,
  browserCommand,
  openBrowser,
} from "../src/browser.js";

test("Windows browser launching passes the local URL as a literal argument", () => {
  const command = browserCommand(
    "http://127.0.0.1:4567/?session=literal&next=%26whoami",
    "win32",
  );

  assert.deepEqual(command, {
    file: "explorer.exe",
    args: ["http://127.0.0.1:4567/?session=literal&next=%26whoami"],
  });

  const calls = [];
  const child = new EventEmitter();
  child.unref = () => {};
  openBrowser(command.args[0], {
    platform: "win32",
    spawnProcess(...args) {
      calls.push(args);
      return child;
    },
  });

  assert.deepEqual(calls, [
    ["explorer.exe", command.args, { detached: true, stdio: "ignore", shell: false }],
  ]);
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

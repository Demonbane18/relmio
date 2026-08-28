import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";

import {
  attachBrowserReopenOnEnter,
  browserCommand,
  openBrowser,
} from "../src/browser.js";

test("Windows browser launching invokes the default URL handler with the local URL as a literal argument", () => {
  const url = `http://127.0.0.1:4567/?session=${"a".repeat(43)}`;
  const command = browserCommand(url, "win32");

  assert.deepEqual(command, {
    file: "cmd.exe",
    args: ["/d", "/c", "start", "Relmio local wizard", url],
  });

  const calls = [];
  const child = new EventEmitter();
  child.unref = () => {};
  assert.equal(openBrowser(url, {
    platform: "win32",
    spawnProcess(...args) {
      calls.push(args);
      return child;
    },
  }), true);

  assert.deepEqual(calls, [
    ["cmd.exe", command.args, { detached: true, stdio: "ignore", shell: false }],
  ]);
});

test("browser launching refuses URLs outside the exact private local wizard", () => {
  const calls = [];

  const opened = openBrowser(
    `http://127.0.0.1:4567/?session=${"a".repeat(43)}&next=%26whoami`,
    {
      platform: "win32",
      spawnProcess(...args) {
        calls.push(args);
        const child = new EventEmitter();
        child.unref = () => {};
        return child;
      },
    },
  );

  assert.equal(opened, false);
  assert.deepEqual(calls, []);
});

test("browser launching accepts only the exact AI Assistant wizard route", () => {
  const session = "b".repeat(43);
  const url = `http://127.0.0.1:4567/assistant?session=${session}`;
  const calls = [];
  const child = new EventEmitter();
  child.unref = () => {};

  assert.equal(openBrowser(url, {
    platform: "linux",
    spawnProcess(...args) {
      calls.push(args);
      return child;
    },
  }), true);
  assert.deepEqual(calls, [[
    "xdg-open",
    [url],
    { detached: true, stdio: "ignore", shell: false },
  ]]);

  const rejectedUrls = [
    ...["/assistant/extra", "/assistant%2Fextra", "/status", "//assistant"].map(
      (pathname) => `http://127.0.0.1:4567${pathname}?session=${session}`,
    ),
    `http://127.0.0.1:4567/assistant?session=${session}&next=ignored`,
    `https://127.0.0.1:4567/assistant?session=${session}`,
    `http://localhost:4567/assistant?session=${session}`,
    `http://127.0.0.1:4567/foo/../assistant?session=${session}`,
    `http://127.0.0.1:4567/%2e/assistant?session=${session}`,
    `http://127.0.0.1:4567/assistant/%2e%2e/assistant?session=${session}`,
    `http://127.0.0.1:4567/assistant/../?session=${session}`,
    `http://127.0.0.1:4567/.?session=${session}`,
    `http://127.0.0.1:4567/assistant/?session=${session}`,
    `http://127.0.0.1:4567/assistant/.?session=${session}`,
    `http://127.1:4567/assistant?session=${session}`,
    `http://%31%32%37.0.0.1:4567/assistant?session=${session}`,
    `HTTP://127.0.0.1:4567/assistant?session=${session}`,
    `http://127.0.0.1:04567/assistant?session=${session}`,
    `http://127.0.0.1:80/assistant?session=${session}`,
  ];
  for (const rejectedUrl of rejectedUrls) {
    assert.equal(openBrowser(rejectedUrl, {
      platform: "linux",
      spawnProcess(...args) {
        calls.push(args);
        return child;
      },
    }), false);
  }
  assert.equal(calls.length, 1);
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

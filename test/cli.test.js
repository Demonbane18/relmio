import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { cliMode, isCliEntryPath, runCli } from "../src/cli.js";

const execFileAsync = promisify(execFile);

test("CLI recognizes only the explicit version flags", () => {
  assert.equal(cliMode(["--version"]), "version");
  assert.equal(cliMode(["-v"]), "version");
  assert.equal(cliMode([]), "wizard");
  assert.equal(cliMode(["--version", "extra"]), "wizard");
});

test("version mode prints package metadata without starting the wizard", async () => {
  const output = [];
  await runCli({
    argumentsList: ["--version"],
    log: (line) => output.push(line),
    readPackage: async () => '{"version":"1.2.3"}',
  });
  assert.deepEqual(output, ["1.2.3"]);
});

test("CLI entry detection resolves package-manager symlinks", () => {
  const sourcePath = resolve("src/cli.js");
  const aliases = new Map([
    ["/package-manager/bin/relmio", sourcePath],
    [sourcePath, sourcePath],
  ]);
  assert.equal(isCliEntryPath("/package-manager/bin/relmio", (path) => aliases.get(path)), true);
  assert.equal(isCliEntryPath("/other/command", (path) => aliases.get(path) ?? path), false);
});

test("the installed CLI version command exits with the repository version", async () => {
  const packageJson = JSON.parse(await readFile("package.json", "utf8"));
  const { stderr, stdout } = await execFileAsync(
    process.execPath,
    ["src/cli.js", "--version"],
    { cwd: process.cwd() },
  );

  assert.equal(stderr, "");
  assert.equal(stdout.trim(), packageJson.version);
});

test(
  "a symlinked installed CLI runs the version command",
  { skip: process.platform === "win32" },
  async () => {
    const packageJson = JSON.parse(await readFile("package.json", "utf8"));
    const directory = await mkdtemp(join(tmpdir(), "relmio-cli-"));
    const commandPath = join(directory, "relmio");
    try {
      await symlink(resolve("src/cli.js"), commandPath, "file");
      const { stderr, stdout } = await execFileAsync(commandPath, ["--version"]);
      assert.equal(stderr, "");
      assert.equal(stdout.trim(), packageJson.version);
    } finally {
      await rm(directory, { force: true, recursive: true });
    }
  },
);

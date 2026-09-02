import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  buildNpmPackage,
  resolveNpmInvocation,
} from "../scripts/build-npm-package.js";

const execFileAsync = promisify(execFile);

function resolveNpxInvocation({
  env = process.env,
  execPath = process.execPath,
  platform = process.platform,
} = {}) {
  if (platform !== "win32") {
    return { command: "npx", prefixArgs: [] };
  }

  // npm.cmd/npx.cmd are shell wrappers and cannot be executed with
  // shell:false. Use the same npm CLI resolution as the package builder and
  // invoke npx-cli.js through the active Node runtime instead.
  const npmInvocation = resolveNpmInvocation({ env, execPath, platform });
  const npmCliPath = npmInvocation.prefixArgs[0];
  return {
    command: execPath,
    prefixArgs: [join(dirname(npmCliPath), "npx-cli.js")],
  };
}

test("the packed npm tarball installs offline and its npx command reports its version", async (t) => {
  const workspaceDirectory = await mkdtemp(
    join(tmpdir(), "relmio-package-install-smoke-"),
  );
  const outputDirectory = join(workspaceDirectory, "package");
  const consumerDirectory = join(workspaceDirectory, "consumer");
  const npmCacheDirectory = join(workspaceDirectory, "npm-cache");
  t.after(() => rm(workspaceDirectory, { recursive: true, force: true }));

  await mkdir(consumerDirectory, { recursive: true });
  // npm ci has already materialized the package's locked production
  // dependencies in this checkout. Seed those exact installed dependencies
  // into the consumer so this smoke test never needs a registry request.
  await cp(join(process.cwd(), "node_modules"), join(consumerDirectory, "node_modules"), {
    recursive: true,
  });
  await writeFile(
    join(consumerDirectory, "package.json"),
    JSON.stringify(
      {
        name: "relmio-package-install-smoke-consumer",
        private: true,
      },
      null,
      2,
    ),
  );

  const { packageJson, tarballPath } = await buildNpmPackage({
    outputDirectory,
  });
  const npmEnvironment = {
    ...process.env,
    npm_config_audit: "false",
    npm_config_fund: "false",
    npm_config_cache: npmCacheDirectory,
    npm_config_offline: "true",
    npm_config_update_notifier: "false",
  };
  const npmInvocation = resolveNpmInvocation();

  await execFileAsync(
    npmInvocation.command,
    [
      ...npmInvocation.prefixArgs,
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--offline",
      "--package-lock=false",
      "--no-save",
      tarballPath,
    ],
    {
      cwd: consumerDirectory,
      env: npmEnvironment,
      maxBuffer: 1024 * 1024,
    },
  );

  const npxInvocation = resolveNpxInvocation();
  const { stderr, stdout } = await execFileAsync(
    npxInvocation.command,
    [...npxInvocation.prefixArgs, "--no-install", "relmio", "--version"],
    {
      cwd: consumerDirectory,
      env: npmEnvironment,
      maxBuffer: 1024 * 1024,
    },
  );

  assert.equal(stderr, "");
  assert.equal(stdout.trim(), packageJson.version);
  const installedManifest = JSON.parse(
    await readFile(join(consumerDirectory, "node_modules", "relmio", "package.json"), "utf8"),
  );
  assert.equal(installedManifest.version, packageJson.version);
});

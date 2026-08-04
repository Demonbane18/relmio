#!/usr/bin/env node

import { execFile } from "node:child_process";
import {
  copyFile,
  cp,
  mkdir,
  mkdtemp,
  readFile,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const sourceRoot = fileURLToPath(new URL("..", import.meta.url));
const defaultOutputDirectory = join(sourceRoot, "dist", "npm");

export function resolveNpmInvocation({
  env = process.env,
  execPath = process.execPath,
  platform = process.platform,
} = {}) {
  if (platform !== "win32") {
    return { command: "npm", prefixArgs: [] };
  }

  const npmExecPathKey = Object.keys(env ?? {}).find(
    (key) => key.toLowerCase() === "npm_execpath",
  );
  const npmExecPath =
    npmExecPathKey === undefined ? undefined : env[npmExecPathKey];
  let npmCliPath;

  if (typeof npmExecPath === "string") {
    if (/(?:^|[\\/])npm-cli\.js$/iu.test(npmExecPath)) {
      npmCliPath = resolve(npmExecPath);
    } else if (/(?:^|[\\/])npx-cli\.js$/iu.test(npmExecPath)) {
      npmCliPath = resolve(dirname(npmExecPath), "npm-cli.js");
    }
  }

  return {
    command: execPath,
    // Windows cannot execute npm.cmd directly with shell:false.
    prefixArgs: [
      npmCliPath ??
        resolve(dirname(execPath), "node_modules", "npm", "bin", "npm-cli.js"),
    ],
  };
}

async function copyPublishEntry({ entry, stagingDirectory }) {
  const source = join(sourceRoot, entry);
  const target = join(stagingDirectory, entry);

  if (entry === "README.md") {
    await copyFile(join(sourceRoot, "npm", "README.md"), target);
    return;
  }

  await cp(source, target, { recursive: true });
}

export async function stageNpmPackage(stagingDirectory) {
  const packageJson = JSON.parse(
    await readFile(join(sourceRoot, "package.json"), "utf8"),
  );
  const publishEntries = new Set([
    "package.json",
    ...(packageJson.files ?? []),
  ]);

  await mkdir(stagingDirectory, { recursive: true });
  for (const entry of publishEntries) {
    await copyPublishEntry({ entry, stagingDirectory });
  }

  return packageJson;
}

export async function buildNpmPackage({
  outputDirectory = defaultOutputDirectory,
} = {}) {
  const stagingDirectory = await mkdtemp(join(tmpdir(), "relmio-package-"));

  try {
    const packageJson = await stageNpmPackage(stagingDirectory);
    await mkdir(outputDirectory, { recursive: true });

    const expectedFilename = `${packageJson.name}-${packageJson.version}.tgz`;
    const expectedPath = join(outputDirectory, expectedFilename);
    await rm(expectedPath, { force: true });

    const npmInvocation = resolveNpmInvocation();
    const { stdout } = await execFileAsync(
      npmInvocation.command,
      [
        ...npmInvocation.prefixArgs,
        "pack",
        stagingDirectory,
        "--json",
        "--ignore-scripts",
        "--pack-destination",
        outputDirectory,
      ],
      {
        cwd: sourceRoot,
        env: {
          ...process.env,
          npm_config_cache: join(stagingDirectory, ".npm-cache"),
        },
      },
    );
    const [packedPackage] = JSON.parse(stdout);
    const tarballPath = resolve(outputDirectory, packedPackage.filename);

    if (basename(tarballPath) !== expectedFilename) {
      throw new Error(
        `npm produced ${basename(tarballPath)} instead of ${expectedFilename}.`,
      );
    }

    return { packageJson, packedPackage, tarballPath };
  } finally {
    await rm(stagingDirectory, { recursive: true, force: true });
  }
}

async function main() {
  const outputArgument = process.argv[2];
  const outputDirectory =
    outputArgument === undefined
      ? defaultOutputDirectory
      : resolve(process.cwd(), outputArgument);
  const result = await buildNpmPackage({ outputDirectory });
  console.log(result.tarballPath);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

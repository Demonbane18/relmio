#!/usr/bin/env node

import { deflateRawSync } from "node:zlib";
import {
  access,
  cp,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { stageNpmPackage } from "./build-npm-package.js";

const projectRoot = fileURLToPath(new URL("..", import.meta.url));
const supportedArchitectures = new Map([
  ["x64", 0x8664],
  ["arm64", 0xaa64],
]);
const zipDosDate = (1 << 5) | 1;
const zipDosTime = 0;
const maxZip32Value = 0xffffffff;
const semver =
  /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-(?:(?:0|[1-9]\d*)|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:(?:0|[1-9]\d*)|\d*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/u;

function assertNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string.`);
  }
  return value;
}

function assertArchitecture(architecture) {
  if (!supportedArchitectures.has(architecture)) {
    throw new Error(`Unsupported Windows architecture: ${architecture}.`);
  }
}

function writeUInt16(buffer, offset, value) {
  buffer.writeUInt16LE(value, offset);
}

function writeUInt32(buffer, offset, value) {
  buffer.writeUInt32LE(value >>> 0, offset);
}

const crcTable = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < table.length; index += 1) {
    let value = index;
    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

export function crc32(contents) {
  let value = 0xffffffff;
  for (const byte of contents) {
    value = crcTable[(value ^ byte) & 0xff] ^ (value >>> 8);
  }
  return (value ^ 0xffffffff) >>> 0;
}

function normalizeArchivePath(path) {
  const normalized = path.split(sep).join("/");
  if (
    normalized === "" ||
    normalized.startsWith("/") ||
    normalized.split("/").some((part) => part === "" || part === "." || part === "..")
  ) {
    throw new Error(`Unsafe ZIP entry path: ${path}`);
  }
  return normalized;
}

export function peMachine(contents, label = "Windows executable") {
  if (contents.length < 0x40 || contents.toString("ascii", 0, 2) !== "MZ") {
    throw new Error(`${label} is not a PE executable.`);
  }
  const peOffset = contents.readUInt32LE(0x3c);
  if (
    peOffset > contents.length - 6 ||
    contents.toString("ascii", peOffset, peOffset + 4) !== "PE\0\0"
  ) {
    throw new Error(`${label} has an invalid PE header.`);
  }
  return contents.readUInt16LE(peOffset + 4);
}

export function validatePeArchitecture({ architecture, contents, label }) {
  assertArchitecture(architecture);
  const machine = peMachine(contents, label);
  if (machine !== supportedArchitectures.get(architecture)) {
    throw new Error(
      `${label} is not built for ${architecture}; received PE machine 0x${machine.toString(16)}.`,
    );
  }
}

async function assertRegularFile(path, label) {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`${label} does not exist: ${path}`);
    }
    throw error;
  }
  if (!metadata.isFile() || metadata.size === 0) {
    throw new Error(`${label} must be a non-empty regular file: ${path}`);
  }
}

async function assertDirectory(path, label) {
  let metadata;
  try {
    metadata = await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT") {
      throw new Error(`${label} does not exist: ${path}`);
    }
    throw error;
  }
  if (!metadata.isDirectory()) {
    throw new Error(`${label} must be a directory: ${path}`);
  }
}

export async function validateNodeRuntimeDirectory({ architecture, directory }) {
  assertArchitecture(architecture);
  const runtimeDirectory = resolve(directory);
  const nodePath = join(runtimeDirectory, "node.exe");
  const npxPath = join(
    runtimeDirectory,
    "node_modules",
    "npm",
    "bin",
    "npx-cli.js",
  );
  await Promise.all([
    assertRegularFile(nodePath, "Bundled node.exe"),
    assertRegularFile(npxPath, "Bundled npm npx-cli.js"),
  ]);
  validatePeArchitecture({
    architecture,
    contents: await readFile(nodePath),
    label: "Bundled node.exe",
  });
  return runtimeDirectory;
}

export async function collectArchiveFiles(rootDirectory) {
  const root = resolve(rootDirectory);
  const files = [];

  async function collect(directory) {
    const entries = await readdir(directory, { withFileTypes: true });
    entries.sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        throw new Error(`Symbolic links are not permitted in a portable ZIP: ${path}`);
      }
      if (entry.isDirectory()) {
        await collect(path);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error(`Unsupported portable ZIP entry: ${path}`);
      }
      files.push({
        contents: await readFile(path),
        path: normalizeArchivePath(relative(root, path)),
      });
    }
  }

  await collect(root);
  return files.sort((left, right) => left.path.localeCompare(right.path));
}

function zipEntry({ contents, path, offset }) {
  const filename = Buffer.from(path, "utf8");
  const compressed = deflateRawSync(contents, { level: 9 });
  if (
    filename.length > 0xffff ||
    contents.length > maxZip32Value ||
    compressed.length > maxZip32Value ||
    offset > maxZip32Value
  ) {
    throw new Error(`Portable ZIP entry exceeds the supported ZIP32 limit: ${path}`);
  }
  const checksum = crc32(contents);
  const localHeader = Buffer.alloc(30);
  writeUInt32(localHeader, 0, 0x04034b50);
  writeUInt16(localHeader, 4, 20);
  writeUInt16(localHeader, 6, 0);
  writeUInt16(localHeader, 8, 8);
  writeUInt16(localHeader, 10, zipDosTime);
  writeUInt16(localHeader, 12, zipDosDate);
  writeUInt32(localHeader, 14, checksum);
  writeUInt32(localHeader, 18, compressed.length);
  writeUInt32(localHeader, 22, contents.length);
  writeUInt16(localHeader, 26, filename.length);
  writeUInt16(localHeader, 28, 0);

  const centralDirectoryHeader = Buffer.alloc(46);
  writeUInt32(centralDirectoryHeader, 0, 0x02014b50);
  writeUInt16(centralDirectoryHeader, 4, 20);
  writeUInt16(centralDirectoryHeader, 6, 20);
  writeUInt16(centralDirectoryHeader, 8, 0);
  writeUInt16(centralDirectoryHeader, 10, 8);
  writeUInt16(centralDirectoryHeader, 12, zipDosTime);
  writeUInt16(centralDirectoryHeader, 14, zipDosDate);
  writeUInt32(centralDirectoryHeader, 16, checksum);
  writeUInt32(centralDirectoryHeader, 20, compressed.length);
  writeUInt32(centralDirectoryHeader, 24, contents.length);
  writeUInt16(centralDirectoryHeader, 28, filename.length);
  writeUInt16(centralDirectoryHeader, 30, 0);
  writeUInt16(centralDirectoryHeader, 32, 0);
  writeUInt16(centralDirectoryHeader, 34, 0);
  writeUInt16(centralDirectoryHeader, 36, 0);
  writeUInt32(centralDirectoryHeader, 38, 0x81a40000);
  writeUInt32(centralDirectoryHeader, 42, offset);

  return {
    centralDirectory: Buffer.concat([centralDirectoryHeader, filename]),
    localContents: Buffer.concat([localHeader, filename, compressed]),
  };
}

export function createDeterministicZip(files) {
  if (!Array.isArray(files) || files.length === 0) {
    throw new Error("A portable ZIP requires at least one file.");
  }
  if (files.length > 0xffff) {
    throw new Error("Portable ZIP has too many entries for ZIP32.");
  }
  const sortedFiles = [...files]
    .map(({ contents, path }) => ({
      contents: Buffer.from(contents),
      path: normalizeArchivePath(assertNonEmptyString(path, "ZIP entry path")),
    }))
    .sort((left, right) => left.path.localeCompare(right.path));
  const duplicate = sortedFiles.find(
    (entry, index) => index > 0 && entry.path === sortedFiles[index - 1].path,
  );
  if (duplicate) {
    throw new Error(`Portable ZIP has a duplicate entry: ${duplicate.path}`);
  }

  const locals = [];
  const centralDirectories = [];
  let offset = 0;
  for (const file of sortedFiles) {
    const entry = zipEntry({ ...file, offset });
    locals.push(entry.localContents);
    centralDirectories.push(entry.centralDirectory);
    offset += entry.localContents.length;
    if (offset > maxZip32Value) {
      throw new Error("Portable ZIP exceeds the supported ZIP32 limit.");
    }
  }
  const centralDirectory = Buffer.concat(centralDirectories);
  const endOfCentralDirectory = Buffer.alloc(22);
  writeUInt32(endOfCentralDirectory, 0, 0x06054b50);
  writeUInt16(endOfCentralDirectory, 4, 0);
  writeUInt16(endOfCentralDirectory, 6, 0);
  writeUInt16(endOfCentralDirectory, 8, sortedFiles.length);
  writeUInt16(endOfCentralDirectory, 10, sortedFiles.length);
  writeUInt32(endOfCentralDirectory, 12, centralDirectory.length);
  writeUInt32(endOfCentralDirectory, 16, offset);
  writeUInt16(endOfCentralDirectory, 20, 0);
  return Buffer.concat([...locals, centralDirectory, endOfCentralDirectory]);
}

async function copyDirectoryContents(source, target) {
  await assertDirectory(source, "Production node_modules directory");
  await mkdir(target, { recursive: true });
  const entries = await readdir(source, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name === ".package-lock.json") {
      continue;
    }
    await cp(join(source, entry.name), join(target, entry.name), {
      dereference: false,
      recursive: entry.isDirectory(),
    });
  }
}

async function assertMissing(path) {
  try {
    await access(path);
  } catch (error) {
    if (error.code === "ENOENT") {
      return;
    }
    throw error;
  }
  throw new Error(`Refusing to overwrite existing output: ${path}`);
}

export async function buildWingetPortablePackage({
  architecture,
  launcherPath,
  nodeRuntimeDirectory,
  outputPath,
  productionNodeModulesDirectory = join(projectRoot, "node_modules"),
  stagePackage = stageNpmPackage,
}) {
  assertArchitecture(architecture);
  const packageJson = JSON.parse(
    await readFile(join(projectRoot, "package.json"), "utf8"),
  );
  const version = packageJson.version;
  if (typeof version !== "string" || !semver.test(version)) {
    throw new Error("package.json must contain a valid semantic version.");
  }
  const expectedFilename = `relmio-${version}-windows-${architecture}.zip`;
  const resolvedOutputPath = resolve(outputPath);
  if (basename(resolvedOutputPath) !== expectedFilename) {
    throw new Error(
      `Portable archive must be named ${expectedFilename}; received ${basename(resolvedOutputPath)}.`,
    );
  }
  await assertMissing(resolvedOutputPath);

  const resolvedLauncherPath = resolve(launcherPath);
  await assertRegularFile(resolvedLauncherPath, "Relmio launcher");
  validatePeArchitecture({
    architecture,
    contents: await readFile(resolvedLauncherPath),
    label: "Relmio launcher",
  });
  const resolvedRuntimeDirectory = await validateNodeRuntimeDirectory({
    architecture,
    directory: nodeRuntimeDirectory,
  });

  const stagingDirectory = await mkdtemp(join(tmpdir(), "relmio-winget-"));
  try {
    const archiveRoot = join(stagingDirectory, `relmio-${version}-windows-${architecture}`);
    const appNodeModules = join(archiveRoot, "app", "node_modules");
    await mkdir(archiveRoot, { recursive: true });
    await cp(resolvedLauncherPath, join(archiveRoot, "relmio.exe"));
    await cp(resolvedRuntimeDirectory, join(archiveRoot, "runtime"), {
      dereference: false,
      recursive: true,
    });
    await stagePackage(join(appNodeModules, "relmio"));
    await copyDirectoryContents(productionNodeModulesDirectory, appNodeModules);

    await Promise.all([
      assertRegularFile(
        join(archiveRoot, "relmio.exe"),
        "Packaged Relmio launcher",
      ),
      assertRegularFile(
        join(archiveRoot, "runtime", "node.exe"),
        "Packaged node.exe",
      ),
      assertRegularFile(
        join(archiveRoot, "runtime", "node_modules", "npm", "bin", "npx-cli.js"),
        "Packaged npm npx-cli.js",
      ),
      assertRegularFile(
        join(appNodeModules, "relmio", "src", "cli.js"),
        "Packaged Relmio CLI",
      ),
      assertDirectory(join(appNodeModules, "ssh2"), "Packaged ssh2 dependency"),
    ]);

    await mkdir(dirname(resolvedOutputPath), { recursive: true });
    const zip = createDeterministicZip(await collectArchiveFiles(archiveRoot));
    await writeFile(resolvedOutputPath, zip, { flag: "wx" });
    return {
      outputPath: resolvedOutputPath,
      sha256: createHash("sha256").update(zip).digest("hex"),
      version,
    };
  } finally {
    await rm(stagingDirectory, { force: true, recursive: true });
  }
}

function parseArguments(argumentsList) {
  const options = {};
  const accepted = new Set([
    "--architecture",
    "--launcher",
    "--node-runtime-dir",
    "--output",
  ]);
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index];
    if (!accepted.has(argument)) {
      throw new Error(`Unknown argument: ${argument}`);
    }
    if (options[argument] !== undefined) {
      throw new Error(`Argument supplied more than once: ${argument}`);
    }
    const value = argumentsList[index + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new Error(`${argument} requires a value.`);
    }
    options[argument] = value;
    index += 1;
  }
  for (const required of accepted) {
    if (options[required] === undefined) {
      throw new Error(`${required} is required.`);
    }
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const result = await buildWingetPortablePackage({
    architecture: options["--architecture"],
    launcherPath: options["--launcher"],
    nodeRuntimeDirectory: options["--node-runtime-dir"],
    outputPath: options["--output"],
  });
  console.log(result.outputPath);
  console.log(`SHA-256: ${result.sha256}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

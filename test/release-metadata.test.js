import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { validateReleaseMetadata } from "../scripts/check-release-metadata.js";

const execFileAsync = promisify(execFile);
const releaseCheckPath = fileURLToPath(
  new URL("../scripts/check-release-metadata.js", import.meta.url),
);

function releaseCheckEnvironment(overrides = {}) {
  const environment = { ...process.env };
  delete environment.GITHUB_REF_TYPE;
  delete environment.GITHUB_REF_NAME;
  return { ...environment, ...overrides };
}

const packageJson = {
  name: "relmio",
  version: "0.1.5",
};

const packageLock = {
  name: "relmio",
  version: "0.1.5",
  packages: {
    "": {
      name: "relmio",
      version: "0.1.5",
    },
  },
};

const changelog = `# Changelog

## [0.1.5] - 2026-07-28

### Fixed

- Example release.
`;

test("release metadata accepts one version across package, lockfile, changelog, and tag", () => {
  assert.deepEqual(
    validateReleaseMetadata({
      packageJson,
      packageLock,
      changelog,
      tag: "v0.1.5",
    }),
    { version: "0.1.5" },
  );
});

test("release metadata accepts complete semantic versions", () => {
  const version = "1.2.3-rc.1+build.20260728";
  assert.deepEqual(
    validateReleaseMetadata({
      packageJson: { ...packageJson, version },
      packageLock: {
        ...packageLock,
        version,
        packages: {
          "": { ...packageLock.packages[""], version },
        },
      },
      changelog: changelog.replaceAll("0.1.5", version),
      tag: `v${version}`,
    }),
    { version },
  );
});

test("release metadata rejects malformed semantic versions", () => {
  for (const version of [
    "01.2.3",
    "1.02.3",
    "1.2.03",
    "1.2",
    "1.2.3-",
    "1.2.3-01",
    "1.2.3-..",
    "1.2.3+",
  ]) {
    assert.throws(
      () =>
        validateReleaseMetadata({
          packageJson: { ...packageJson, version },
          packageLock,
          changelog,
        }),
      /package\.json must contain a valid semantic version/u,
      version,
    );
  }
});

test("release metadata rejects every mismatched version source", () => {
  assert.throws(
    () =>
      validateReleaseMetadata({
        packageJson,
        packageLock: { ...packageLock, version: "0.1.4" },
        changelog,
      }),
    /package-lock\.json version 0\.1\.4 does not match 0\.1\.5/u,
  );
  assert.throws(
    () =>
      validateReleaseMetadata({
        packageJson,
        packageLock: {
          ...packageLock,
          packages: {
            "": { ...packageLock.packages[""], version: "0.1.4" },
          },
        },
        changelog,
      }),
    /package-lock\.json root package version 0\.1\.4 does not match 0\.1\.5/u,
  );
  assert.throws(
    () =>
      validateReleaseMetadata({
        packageJson,
        packageLock,
        changelog: changelog.replace("[0.1.5]", "[0.1.4]"),
      }),
    /newest CHANGELOG\.md version 0\.1\.4 does not match 0\.1\.5/u,
  );
  assert.throws(
    () =>
      validateReleaseMetadata({
        packageJson,
        packageLock,
        changelog,
        tag: "v0.1.4",
      }),
    /release tag v0\.1\.4 does not match v0\.1\.5/u,
  );
});

test("release metadata CLI accepts a packed install without a package lock", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "release-metadata-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  await Promise.all([
    writeFile(join(directory, "package.json"), JSON.stringify(packageJson)),
    writeFile(join(directory, "CHANGELOG.md"), changelog),
  ]);

  const { stdout } = await execFileAsync(
    process.execPath,
    [releaseCheckPath],
    { cwd: directory, env: releaseCheckEnvironment() },
  );

  assert.match(stdout, /Release metadata is synchronized at v0\.1\.5\./u);
});

test("release metadata CLI requires a package lock in a Git checkout", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "release-metadata-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  await Promise.all([
    mkdir(join(directory, ".git")),
    writeFile(join(directory, "package.json"), JSON.stringify(packageJson)),
    writeFile(join(directory, "CHANGELOG.md"), changelog),
  ]);

  await assert.rejects(
    execFileAsync(process.execPath, [releaseCheckPath], {
      cwd: directory,
      env: releaseCheckEnvironment(),
    }),
    (error) => {
      assert.match(
        error.stderr,
        /package-lock\.json version missing does not match 0\.1\.5\./u,
      );
      return true;
    },
  );
});

test("release metadata CLI validates the GitHub release tag environment", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "release-metadata-"));
  t.after(() => rm(directory, { recursive: true, force: true }));

  await Promise.all([
    writeFile(join(directory, "package.json"), JSON.stringify(packageJson)),
    writeFile(join(directory, "package-lock.json"), JSON.stringify(packageLock)),
    writeFile(join(directory, "CHANGELOG.md"), changelog),
  ]);

  const { stdout } = await execFileAsync(
    process.execPath,
    [releaseCheckPath],
    {
      cwd: directory,
      env: releaseCheckEnvironment({
        GITHUB_REF_TYPE: "tag",
        GITHUB_REF_NAME: "v0.1.5",
      }),
    },
  );
  assert.match(stdout, /Release metadata is synchronized at v0\.1\.5\./u);

  await assert.rejects(
    execFileAsync(process.execPath, [releaseCheckPath], {
      cwd: directory,
      env: releaseCheckEnvironment({
        GITHUB_REF_TYPE: "tag",
        GITHUB_REF_NAME: "v0.1.4",
      }),
    }),
    (error) => {
      assert.match(
        error.stderr,
        /release tag v0\.1\.4 does not match v0\.1\.5\./u,
      );
      return true;
    },
  );
});

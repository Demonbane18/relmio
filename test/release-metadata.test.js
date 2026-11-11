import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { npmReleaseTag, validateReleaseMetadata } from "../scripts/check-release-metadata.js";

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

const stableVersionSources = {
  "README.md": "Relmio 0.1.5 is the current stable release.\n\n`@latest` selects stable 0.1.5, including the setup guide.\nThe sidecar asks as the newest stable Codex release on npm.\n",
  "npm/README.md": "This command selects stable\nRelmio 0.1.5, including the setup guide.\n",
  "web/app/project-version.ts": 'export const preparedReleaseVersion = "0.1.5";\n',
};

test("a stable release must match the stable version named in both READMEs and the website", () => {
  const validate = (overrides = {}, options = {}) => validateReleaseMetadata({
    packageJson, packageLock, changelog, requireStableVersionSources: true,
    stableVersionSources: { ...stableVersionSources, ...overrides }, ...options,
  });
  assert.deepEqual(validate(), { version: "0.1.5" });
  for (const [file, contents, message] of [
    ["README.md", stableVersionSources["README.md"].replace("selects stable 0.1.5", "selects stable 0.1.4"),
      /README\.md names stable version 0\.1\.4 instead of 0\.1\.5/u],
    ["README.md", stableVersionSources["README.md"].replace("Relmio 0.1.5 is", "Relmio 0.1.4 is"),
      /README\.md names stable version 0\.1\.4 instead of 0\.1\.5/u],
    ["npm/README.md", "This command selects stable Relmio 0.1.4.\n", /npm\/README\.md names stable version 0\.1\.4 instead of 0\.1\.5/u],
    ["npm/README.md", "This command selects stable Relmio 0.1.5-experimental.1.\n", /npm\/README\.md names stable version 0\.1\.5-experimental\.1/u],
    ["npm/README.md", "Hosted installers use the same stable default.\n", /npm\/README\.md does not name stable version 0\.1\.5/u],
    ["web/app/project-version.ts", 'export const preparedReleaseVersion = "0.1.4";\n',
      /web\/app\/project-version\.ts names stable version 0\.1\.4 instead of 0\.1\.5/u],
    ["web/app/project-version.ts", undefined, /web\/app\/project-version\.ts is missing/u],
  ]) {
    assert.throws(() => validate({ [file]: contents }), message);
  }
  // A packed install has no npm/README.md or website: only the sources that exist are compared.
  assert.deepEqual(validate({ "npm/README.md": undefined, "web/app/project-version.ts": undefined },
    { requireStableVersionSources: false }), { version: "0.1.5" });
  assert.throws(() => validate({ "README.md": "`@latest` selects stable 0.1.4.\n", "npm/README.md": undefined },
    { requireStableVersionSources: false }), /README\.md names stable version 0\.1\.4/u);
  // A prerelease keeps naming the last stable release everywhere.
  const version = "0.2.0-experimental.1";
  assert.deepEqual(validate({}, {
    packageJson: { ...packageJson, version },
    packageLock: { ...packageLock, version, packages: { "": { ...packageLock.packages[""], version } } },
    changelog: changelog.replaceAll("0.1.5", version),
  }), { version });
});

test("npm release channel requires an exact tag and matching GitHub prerelease flag", () => {
  assert.equal(
    npmReleaseTag({ version: "0.17.5", tag: "v0.17.5", prerelease: false }),
    "latest",
  );
  assert.equal(
    npmReleaseTag({
      version: "0.18.0-experimental.1",
      tag: "v0.18.0-experimental.1",
      prerelease: true,
    }),
    "experimental",
  );
  assert.equal(
    npmReleaseTag({
      version: "0.17.5+build-with-dash",
      tag: "v0.17.5+build-with-dash",
      prerelease: false,
    }),
    "latest",
  );

  for (const [version, tag, prerelease] of [
    ["0.17.5", "v0.17.5", true],
    ["0.18.0-experimental.1", "v0.18.0-experimental.1", false],
    ["0.18.0-experimental.1", "v0.17.5", true],
    ["0.17.5", undefined, false],
  ]) {
    assert.throws(
      () => npmReleaseTag({ version, tag, prerelease }),
      /release tag|prerelease flag/u,
    );
  }
  assert.throws(
    () =>
      npmReleaseTag({
        version: "0.18.0-experimental.01",
        tag: "v0.18.0-experimental.01",
        prerelease: true,
      }),
    /valid semantic version/u,
  );
});

test("npm dist-tag CLI rejects release mismatch before publication", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "release-channel-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const version = "0.18.0-experimental.1";
  await Promise.all([
    writeFile(
      join(directory, "package.json"),
      JSON.stringify({ ...packageJson, version }),
    ),
    writeFile(
      join(directory, "package-lock.json"),
      JSON.stringify({
        ...packageLock,
        version,
        packages: { "": { ...packageLock.packages[""], version } },
      }),
    ),
    writeFile(join(directory, "CHANGELOG.md"), changelog.replaceAll("0.1.5", version)),
  ]);

  const env = releaseCheckEnvironment({
    RELEASE_TAG: `v${version}`,
    RELEASE_PRERELEASE: "true",
  });
  const { stdout } = await execFileAsync(
    process.execPath,
    [releaseCheckPath, "--npm-dist-tag"],
    { cwd: directory, env },
  );
  assert.equal(stdout.trim(), "experimental");
  for (const overrides of [
    { RELEASE_TAG: "v0.17.5" },
    { RELEASE_PRERELEASE: "false" },
    { RELEASE_PRERELEASE: "" },
  ]) {
    await assert.rejects(
      execFileAsync(process.execPath, [releaseCheckPath, "--npm-dist-tag"], {
        cwd: directory,
        env: { ...env, ...overrides },
      }),
      /release tag|prerelease flag/u,
    );
  }
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

test("release metadata CLI compares the READMEs and the website version in a Git checkout", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "release-metadata-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await Promise.all([".git", "npm", join("web", "app")].map((path) => mkdir(join(directory, path), { recursive: true })));
  const write = (file, contents) => writeFile(join(directory, file), contents);
  await Promise.all([
    write("package.json", JSON.stringify(packageJson)),
    write("package-lock.json", JSON.stringify(packageLock)),
    write("CHANGELOG.md", changelog),
    ...Object.entries(stableVersionSources).map(([file, contents]) => write(file, contents)),
  ]);
  const check = () => execFileAsync(process.execPath, [releaseCheckPath], { cwd: directory, env: releaseCheckEnvironment() });

  assert.match((await check()).stdout, /Release metadata is synchronized at v0\.1\.5\./u);
  for (const [file, stale, message] of [
    ["README.md", "`@latest` selects stable 0.1.4.\n", /README\.md names stable version 0\.1\.4 instead of 0\.1\.5\./u],
    ["web/app/project-version.ts", 'export const preparedReleaseVersion = "0.1.4";\n',
      /web\/app\/project-version\.ts names stable version 0\.1\.4 instead of 0\.1\.5\./u],
  ]) {
    await write(file, stale);
    await assert.rejects(check(), (error) => {
      assert.match(error.stderr, message);
      return true;
    });
    await write(file, stableVersionSources[file]);
  }
  assert.match((await check()).stdout, /Release metadata is synchronized at v0\.1\.5\./u);
});

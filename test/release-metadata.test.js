import assert from "node:assert/strict";
import test from "node:test";

import { validateReleaseMetadata } from "../scripts/check-release-metadata.js";

const packageJson = {
  name: "n8n-openai-oauth-setup",
  version: "0.1.5",
};

const packageLock = {
  name: "n8n-openai-oauth-setup",
  version: "0.1.5",
  packages: {
    "": {
      name: "n8n-openai-oauth-setup",
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

---
name: changelog
description: Prepare and audit Relmio minor, patch, and major-feature release notes with synchronized semantic-version metadata. Use when changing CHANGELOG.md, choosing a release number, summarizing prior releases, creating a Git tag, or preparing a GitHub/npm release.
---

# Relmio changelog steward

Use this skill whenever a release changes user-visible behavior, package
metadata, documentation, installer behavior, or the public website.

## Establish the release scope

1. Read `package.json`, `package-lock.json`, `CHANGELOG.md`, the latest tags,
   and the commits since the last release.
2. Treat the newest released version as the baseline. Summarize only changes
   that are present in the release, not future work under `Unreleased`.
3. Keep release notes user-facing: describe the outcome and the reason it
   matters, not internal implementation trivia.

## Choose the semantic version

Relmio is pre-1.0, so use the normal SemVer interpretation for `0.y.z`:

- increment `z` for backward-compatible fixes, docs, or small maintenance;
- increment `y` for a meaningful new capability, workflow, or compatibility
  surface. Treat this as a major feature release in the release title even
  though SemVer reserves the first digit for the eventual stable major line;
- use `1.0.0` only when the project declares its stable public API;
- increment the first digit after `1.0.0` for breaking public changes.

Never reuse a published version. Confirm that `v<version>` does not already
exist before preparing the release.

## Write the entry

Keep `## Unreleased` at the top. Add the newest dated entry immediately below
it using the exact form `## [X.Y.Z] - YYYY-MM-DD`. Use only sections that have
content, in this order:

1. `Added` for new commands, pages, workflows, or supported capabilities;
2. `Changed` for intentional behavior, UX, compatibility, or documentation
   updates;
3. `Fixed` for corrected failures and regressions;
4. `Security` for security-boundary or dependency fixes.

For a major feature release, begin `Added` or `Changed` with a short
“Highlights since vA.B.C” bullet group when the release consolidates several
prior patch releases. Do not copy every historical bullet; combine related
changes and preserve the most important user impact. Keep sensitive values,
tokens, private hosts, and live URLs out of the entry.

## Synchronize release metadata

The same version must appear in:

- `package.json`;
- both version fields in `package-lock.json`;
- the newest `CHANGELOG.md` heading;
- the annotated Git tag `v<version>` on the exact release commit;
- the npm package and GitHub release after publication.

Run `npm run release:check` before committing. Do not hand-edit a generated
tarball or claim a tag/npm release exists until the external write succeeds.

## Verify the release

Run the repository's full check, dependency audit, package build, and package
preview. Review the diff for accidental credentials or private infrastructure
details. After a release is merged and published, verify the tag points to the
merged commit and query npm anonymously for the exact version and integrity.

---
name: ship
description: Prepare, verify, and execute a safe Relmio release across the npm package, GitHub, Vercel, installers, and distribution surfaces. Use when planning or cutting a Relmio version, updating release metadata or curated notes, preparing a release PR, publishing through npm trusted publishing, verifying a deploy, or auditing installer and Homebrew availability.
---

# Ship Relmio safely

Use this workflow to produce evidence for a Relmio release. Treat every
external write as a separately authorized step. Never use local npm tokens,
never weaken branch protection, and never report a publish, release, tag, merge,
or deploy that has not been verified.

## Distribution audit contract

Explicitly invoke `release-relmio-everywhere` before and after publication.
Read `/Users/demonbane/.codex/skills/release-relmio-everywhere/SKILL.md`
completely, then use its deterministic audit as follows:

1. Before release edits, audit the currently published baseline version and
   require every applicable required check to pass:

   ```sh
   node /Users/demonbane/.codex/skills/release-relmio-everywhere/scripts/audit-distribution.mjs \
     --repo "$PWD" --version "<published-version>" --json
   ```

2. Immediately before the first authorized external publication, run the same
   audit with `<target-version>`. Require all local metadata, installer, and
   behavior checks to pass. Record failures for not-yet-published npm, GitHub,
   Vercel-hosted, Homebrew, or catalog surfaces as the explicit publication
   delta; any other failure blocks publication. Never describe this expected
   nonzero pre-publication result as a green audit.
3. After all authorized, applicable publication and distribution writes, run
   the target-version audit again. Require `ok: true` and every required check
   to report `PASS`; WinGet may report `NOT-PUBLIC` only when no public Relmio
   documentation advertises it. A nonzero result blocks release completion.
4. Include both pre-publication and post-publication audit matrices in the final
   evidence record, with every changed external system and unresolved surface.

## 1. Establish the release candidate

1. Start from a clean, isolated worktree on a short-lived release branch.
   - Run `git status --short`, `git branch --show-current`, and
     `git worktree list`.
   - If the intended source worktree is dirty, create or switch to an isolated
     worktree before editing. Preserve unrelated edits; do not reset or discard
     them.
   - Record the starting commit and the baseline published tag.
2. Establish the scope from evidence, not a branch name.
   - List tags with `git tag --sort=-version:refname`.
   - Inspect `git log v<previous>..HEAD`, `git diff --name-status
     v<previous>..HEAD`, relevant pull requests, and user-facing files.
   - Stop if the baseline tag or intended release commit is ambiguous.
3. Choose the version deliberately.
   - For Relmio's pre-1.0 series, use a patch bump for compatible fixes and a
     minor bump for a meaningful capability, workflow, or compatibility
     surface.
   - Confirm `v<version>` is not already published before updating metadata.
4. Update `package.json`, both version fields in `package-lock.json`, and the
   dated curated `CHANGELOG.md` entry together. Keep `## Unreleased` above the
   entry. Describe user outcome and material limits; do not paste a commit log.

## 2. Keep documentation and packaging honest

1. Keep `README.md` and `npm/README.md` synchronized in product claims,
   installation guidance, limitations, support links, and release-relevant
   content. Preserve their intentional presentation differences: npm uses
   registry-safe asset URLs and omits GitHub-only diagrams.
2. Decide which delivery surfaces apply by inspecting the changed paths and
   the actual release scope:

   | Surface | Apply when | Verify |
   |---|---|---|
   | npm | Package files, runtime, docs, metadata, or CLI behavior changed | `npm pack --dry-run`, staged package content, and registry version after publish |
   | Installers | Bootstrap scripts, supported runtime, install docs, or package entry points changed | Platform-focused tests and downloaded-script checks |
   | Vercel web app | `web/**`, public web copy, install UX, or web-linked guides changed | web lint/typecheck/tests/build and production URL after deploy |
   | Homebrew/distribution | Formula, package-manager scripts, archive layout, installer behavior, or package version changed | artifact, immutable npm tarball, formula/repository status, and catalog status |

3. Do not claim that all surfaces changed when a row is not applicable. Record
   the applicability decision and its evidence in the release PR.
4. Keep provider and credential boundaries precise. For the local endpoint
   capability, a Platform API key powers the OpenAI-compatible `/v1` service;
   ChatGPT sign-in powers only the experimental Codex App Server protocol, not
   a general `/v1` credential.

## 3. Verify before requesting review

Run the current repository commands, starting with focused tests for changed
behavior and expanding to the release gates. Do not skip a failed command or
silently substitute an unverified result.

```sh
npm run lint
npm run release:check
npm test
npm audit --audit-level=high
npm pack --dry-run
```

When `web/**` applies, run these in `web/` as well:

```sh
npm run lint
npm run typecheck
npm test
npm run build:vercel
```

Also run `git diff --check`, inspect the complete diff for credentials and
unrelated changes, and verify README parity with the repository's tests or a
targeted content comparison. For browser changes, use the approved browser
environment to check the production build at desktop and narrow widths,
keyboard focus, accessible names, external-link attributes, and a clean
console. Do not access browser credentials, tokens, cookies, or storage.

Stop and fix or escalate if a relevant check fails, a high-severity audit issue
is unresolved, package contents contain an unexpected file, README variants
make conflicting product claims, or the candidate includes secrets.

## 4. Review, merge, tag, and release

1. Open a release PR that states the exact baseline, intended version,
   applicability decisions, changed surfaces, verification commands, results,
   and known release concerns. Do not bypass branch protection or required
   checks.
2. Wait for required reviews and required CI checks to pass. Merge through the
   protected repository flow only after explicit human authorization when the
   workflow requires it.
3. Resolve the exact merged commit before tagging:

   ```sh
   git fetch origin
   git rev-parse origin/main
   git show -s --format='%H%n%s' <merged-commit>
   ```

   Stop if it does not contain the reviewed release metadata. Create the
   annotated `v<version>` tag only on that exact merged commit, then verify the
   tag target remotely before creating the GitHub release. Use curated release
   notes, never autogenerated commit dumps.
4. Publish npm only through the repository's configured npm OIDC trusted
   publisher in the protected automation. Never create, store, paste, or use a
   local npm access token. After the workflow succeeds, query npm anonymously
   for the exact version, provenance, tarball, and integrity.

## 5. Verify delivered surfaces

1. Confirm the GitHub release tag, target commit, and rendered curated body.
2. Confirm the exact npm version and package contents from the registry; compare
   its immutable tarball with the reviewed candidate.
3. Confirm the Vercel production deployment is for the merged release commit.
   Verify its public landing and install pages, support link, endpoint copy,
   and no-console-error state. Do not expose credentials or deploy previews as
   proof of production.
4. Audit installer and distribution status when applicable:
   - verify published installer URLs, checksums, and supported shell behavior;
   - verify Homebrew's formula points at the exact immutable npm tarball and
     its installation test evidence;
   - record WinGet or other catalog state accurately as pending until the
     upstream catalog has merged and propagated it.

## Stop and failure rules

Stop the release and report the evidence if any condition occurs:

- dirty or ambiguous source/target worktree, tag, branch, or merged commit;
- a required test, audit, package check, installer check, or deployment check
  fails;
- metadata, README variants, changelog, tag, and package versions diverge;
- an external write lacks explicit authorization, including publish, deploy,
  merge, tag, release creation, or installer/distribution update;
- branch protection or required checks would need bypassing;
- an npm token, OAuth credential, SSH secret, or other secret is requested,
  exposed, or appears in the diff;
- registry, GitHub, Vercel, Homebrew, or catalog verification cannot establish
  the exact version and commit.

Do not compensate for a failure by retrying destructive writes, force-pushing,
retagging, manually changing a registry artifact, or loosening a security
boundary. Preserve evidence, identify the failed gate, and request direction.

## Final evidence record

Report the following, using facts and links/identifiers rather than claims:

- release version, previous tag, exact merged commit, exact tag target, and
  GitHub release URL;
- PR, approvals, required-check result, and merge evidence;
- metadata and changelog consistency;
- root and web checks, audit, package preview, README parity, and diff check;
- npm registry version, provenance/integrity, and immutable tarball evidence;
- Vercel production URL, deployed commit, visual/accessibility verification,
  and console result;
- installer, Homebrew, and other distribution applicability decisions and
  verified status;
- every skipped check, failure, risk, or follow-up still outstanding.

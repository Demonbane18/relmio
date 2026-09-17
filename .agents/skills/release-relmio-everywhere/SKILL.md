---
name: release-relmio-everywhere
description: Audit and synchronize Relmio's npm, GitHub release, hosted installer, Homebrew, Windows archive, and conditional WinGet surfaces for an explicitly authorized release. Use the repo ship workflow for merge-only work.
---

# Release Relmio everywhere

Treat one Relmio version as one immutable distribution unit. This skill is for an explicitly requested release or publication; a merge-only request stays in `.agents/skills/ship/SKILL.md`.

Resolve the repository root with `git rev-parse --show-toplevel`. Do not use a path from another computer, and do not assume macOS utilities exist on Windows.

## Build the audit matrix

Before release edits, record the published baseline from public, read-only sources. Immediately before publication, repeat the matrix for the candidate and distinguish expected not-yet-published failures from local inconsistencies. After publication, require every applicable row to pass.

| Surface | Evidence |
| --- | --- |
| Repository metadata | `package.json`, both lockfile version fields, dated changelog entry, and intended `v<version>` agree |
| Package candidate | `npm run check`, high-severity audit, package build, dry-run contents, and README variant checks pass |
| npm | `npm view relmio@<version> version dist.integrity dist.tarball` returns the exact released version and immutable artifact |
| Hosted installers | Public `install.sh`, `install.ps1`, and `install.cmd` byte-match the reviewed source and invoke `relmio@latest` with lifecycle scripts disabled |
| Install page | Public `/install` exposes the reviewed macOS/Linux, Homebrew, PowerShell, CMD, and NPX commands |
| GitHub release | `v<version>` targets the reviewed main commit and contains the exact Windows x64 and arm64 archives |
| Homebrew | The external tap formula points to the immutable npm tarball and matches its version and SHA-256 |
| WinGet | Require the public catalog only when public Relmio docs advertise `winget install`; otherwise report `NOT-PUBLIC` |

Use Node.js for byte comparisons, hashing, and HTTPS checks so the same evidence runs in PowerShell, Command Prompt CI, macOS, and Linux. Never pipe a live installer into a shell as an audit.

## Release gates

1. Start from a clean isolated release branch based on current `origin/main`; preserve every unrelated checkout and worktree.
2. Choose a deliberate pre-1.0 version, then update package metadata and the curated changelog together.
3. Run focused tests followed by root, native Windows, web, package, installer, and distribution checks that apply to the diff.
4. Open a reviewable PR and wait for required checks, especially the native Windows installer/browser-wizard job.
5. Merge only through the protected flow after explicit authorization. Resolve the exact merged commit before tagging.
6. Publish npm only through the repository's OIDC trusted publisher. Never request, read, store, or use a local npm token.
7. Treat npm, GitHub release, Vercel, Homebrew, and WinGet as separate external writes. Perform only the writes currently authorized by the user.
8. Re-run the public matrix and report exact versions, commits, hashes, URLs, skipped surfaces, and failures.

Stop on an ambiguous commit or version, a required failing check, metadata drift, unexpected package content, missing Windows evidence, branch-protection bypass, secret exposure, or an unapproved external write. Never repair a published version by force-pushing, retagging, or replacing a registry artifact.

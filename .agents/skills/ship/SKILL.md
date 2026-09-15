---
name: ship
description: Prepare or execute a Relmio merge or release. Use for an explicitly requested merge, release candidate, publication, or release verification.
---

# Ship Relmio safely

This project skill owns the merge and release workflow. Read only the procedure
needed for the requested operation:

- Release prose only: use [changelog](../changelog/SKILL.md).
- Status only: inspect existing evidence and report gaps read-only. Do not
  trigger candidate preparation, new audits, or external repairs.
- Merge or merge readiness: use [merge](references/merge.md).
- Release candidate, publication, or release verification: use
  [release](references/release.md).
- Consult [affected surfaces and verification](references/verification.md)
  when selecting checks or preparing changed delivery surfaces.

## Authorization and completion

Follow the root [project boundaries](../../../AGENTS.md). Preserve dirty work;
isolate from a verified source instead of resetting or overwriting user edits.
Carry explicit authorization for the same named target and action across turns.
A final confirmation already supplied for that concrete action remains valid
until completion, revocation, or a scope change. A missing approval blocks only
that action; continue independent authorized preparation and verification.
Honor explicit user pauses and readiness-only or verification-only scope.

A merge-only request does not authorize push, npm publication, Vercel deployment,
tagging, GitHub release creation, Homebrew updates, or installer publication.
Check the actual target and automated consequences before an external write;
request any authorization missing for those consequences. A separately
requested feature-branch push is not a package release.

Never weaken branch protection or required CI. Publish npm only through the
protected OIDC trusted publisher; never use local npm tokens. Do not retry
failures with destructive writes, force-pushes, retagging, registry artifact
changes, or weaker security boundaries.

Complete the requested lane and its applicable checks before reporting success.
State candidate validation, local/remote merge, branch publication, npm
publication, deployment, and catalog acceptance separately using verified
commits and evidence. Report blockers without claiming unperformed stages.

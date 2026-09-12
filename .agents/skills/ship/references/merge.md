# Merge-only procedure

Use this procedure for an explicitly requested merge or merge-readiness check.
A readiness check authorizes inspection and reporting, not a merge or edits.
For an authorized merge, complete the applicable preparation below.

1. Inspect the source branch, `main`, worktrees, working-tree changes, merge
   base, and `origin/main`. Preserve unrelated edits. If dirty paths overlap,
   isolate from the verified source when possible; ask only when the source is
   ambiguous or proceeding would overwrite user edits. Do not reset dirty work.
2. Classify the diff with [affected surfaces and verification](verification.md).
   Update applicable README, `Unreleased`, package, web, installer, distribution,
   or guide content before merging. Do not invent a version bump. Summarize
   unaffected surfaces with their reason rather than repeating a fixed inventory.
3. Run checks for the affected behavior and package/delivery contracts, plus
   diff and secret checks. Required CI and reviews remain mandatory for a remote
   protected merge. A failed required candidate check blocks the merge.
4. Run a published-baseline distribution audit only when distribution behavior
   changes or the user requests a release audit. Use the audit command in
   [the release procedure](release.md#distribution-audit-contract) without
   entering publication steps. Report unrelated live drift separately; an
   unrelated published-state failure does not block a merge-only candidate.
5. Merge only the authorized target using the protected repository flow or
   local `--ff-only`. A local merge request does not authorize a remote PR merge
   or push. If the target changes, reevaluate the candidate before merging.
6. Resolve the exact merged commit. Reuse passing results when its tree,
   dependencies, and environment match the tested candidate. Rerun affected
   checks after conflict resolution or other changes; do not waive required CI.
   Verify that pre-existing unrelated edits remain intact.
7. Report the exact merge commit, applicable checks and evidence, preserved
   work, and any blockers. Keep local merge, remote merge, publication,
   deployment, and catalog status separate. For a readiness-only request,
   report readiness and gaps without performing the merge.

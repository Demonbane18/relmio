# Mac wizard integration and release evidence, 2026-09-06

## Source and preservation

- Original Mac checkout: `main` at `b9b83203b4415cfb8876e1b34b90740c94c9d58a`, clean at intake. Existing worktrees were retained.
- Isolated integration worktree: `/private/tmp/relmio-mac-wizard-release`, branch `codex/mac-wizard-release`.
- Fetched feature source: `a3b42bdafd6dce4c6f2eefd1924fb9eb2a331e1b`, matching the user's pushed head. Base candidate: `2a987972f84873b3446618b63877213363bfa8d1`.
- Read `MAC-HANDOFF.md` from Git and `VPS-SUPERGROK-RESULTS.md` plus nested `WINDOWS-RESULTS.md` from the transfer. Attached prompts/scripts were reference material, not independent authorization.
- All 22 listed transfer checksums passed. The Git bundle verified against the base and advertised the same feature head. Ordered patches were not applied because their commits are already present.
- The two Windows fixture files match `694287f` byte-for-byte. Their Mac tests passed, 91 tests and zero failures.
- PR #68 initially pointed at `2a98797`. `origin/main` remained `b9b8320`; latest published release was `0.13.0`. The integration preserves that candidate's ancestry and adds the feature once. npm latest was not used as the tested source.

## Evidence boundaries

The Windows transfer records live native Windows Chat, Assistant node-search, Calculator, logout refusal and disposable cleanup. Those are archived Windows-session results, not fresh Mac executions. Its original full gate remains **CONDITIONAL**: the two fixture fixes are integrated, and Git Bash 2.38.1 needs per-process `MSYS=enable_pcon` for the TTY check. The release documents that compatibility prerequisite and the native PowerShell/CMD alternatives. Default Git Bash 2.38.1 did not pass, and an upgraded version was not tested by the Mac session. The Windows report also discloses a disposable sandbox-key diagnostic exposure, subsequent invalidation and sanitized transfer; it is not a clean secrets-handling pass.

VPS Chat success after turning Responses OFF is **user-reported**. The failed screenshot with Responses ON returned `404 not_found`. No agent-recorded successful VPS generation, VPS Assistant or VPS Calculator result is claimed. Natural provider-token expiry and unlisted model behavior remain untested.

No existing n8n containers, Compose files, workflows, credentials, provider selections or OAuth sessions are changed by these Mac checks. Browser testing uses service doubles with fake values, not a live SSH connection or Docker mutation. No provider login, token transfer, Telegram workflow or production VPS action was performed.

## Mac checks

Runtime: Node 22.23.2, npm 10.9.8. The system Node 24 was used only for initial inspection/dependency setup; release verification uses the Node 22 runtime.

| Check | Result |
| --- | --- |
| Published 0.13.0 distribution baseline | 18 required checks PASS; WinGet NOT-PUBLIC |
| 0.14.0 prepublication distribution | Local metadata, installer behavior/TTY, live wrapper bytes and install-page commands PASS; 7 expected missing/stale publication checks; audit is not green |
| Windows fixture regressions on Mac | 91 PASS, 0 FAIL |
| Root release suite | Node 22: 1,011 PASS, 12 expected platform SKIP, 0 FAIL; includes final expiry regression |
| Root dependency audit / package | 0 vulnerabilities; package build and npm pack dry-run PASS |
| Hosted web lint / typecheck / tests / native build | PASS; 64 tests, Next production build and Vinext build; no high/critical dependency findings (one moderate development dependency) |
| Opera GX wizard matrix | PASS: 20 disposable-service checks; light/dark/system at 320, 375, 768 and 1440 px, host trust, confirmation, pending/cancel/expired, removal, busy navigation, Back/Forward and provider changes; zero browser exceptions |
| Fresh Sol High review | Pending integration |
| Exact updated Windows CI | Pending reviewed candidate push |
| Merge / tag / npm / GitHub / Vercel / Homebrew | Not performed |

Local detailed evidence is under `/private/tmp/relmio-mac-evidence`. It contains sanitized fixture screenshots/results, transfer checks, test logs and distribution audit JSON. No browser profile or provider session is included.

Root diff checks and a targeted added-line secret-pattern scan found no private keys, npm/GitHub tokens, OpenAI live-key patterns or JWTs. The package preview contains 116 allowlisted files and no sensitive credential paths. This is a scoped scan, not a guarantee against every secret format.

## Browser and race corrections

- Back/Forward now reloads the document matching the restored route; restored cached pages cannot resume a credential screen. Existing verified SSH state survives route navigation.
- Discovery invalidates reviewed plans when it starts. A late older review cannot replace the current SuperGrok plan, and cross-provider plans invalidate one another. OpenAI bridge and Assistant dual-plan behavior remains supported.
- Full server regressions complete: older tests were updated to expect stale-plan rejection and release deferred reads during cleanup.
- Completion data is validated before any rendering. Pending login polling retries after a busy read, and GNU timeout exit 124 is reported as expired; other failures remain failures.
- Opera also checked the local Next production homepage, install page and SuperGrok guide at desktop/mobile widths, protected external links, focus, pause/resume and reduced motion; zero page exceptions. This is local production-build evidence, not a production deployment claim.

## Release scope

Version 0.14.0 adds the local/VPS SuperGrok capability and shared wizard flow, retains the candidate's OAuth-only runtime and public homepage work, and includes the Windows fixture corrections. Runtime/npm, README variants, generated docs, hosted web, GitHub platform assets and Homebrew apply. Bootstrap wrapper bytes remain unchanged; supported-shell behavior and deployment equality are checked. No WinGet command is public.

The user authorized shipping through the release process. The remote publication plan is to fast-forward PR #68's branch, require Linux/web/native-Windows/package-manager CI and preview checks, merge through protection, verify the exact merged commit, then create the annotated v0.14.0 tag and curated GitHub release. npm publication must use the protected OIDC workflow. Windows assets, Vercel and the immutable-tarball Homebrew formula must be verified before declaring the release complete. No VPS deployment is part of that publication plan. A VPS write still requires host identity verification before authentication and separate final human confirmation of its exact plan.

---
name: installer-reliability
description: Diagnose, fix, and release-test Relmio installer or browser-wizard failures, especially Windows CMD, PowerShell, portable Node/npm, browser handoff, and ChatGPT OAuth regressions. Use when an installer screenshot, failed bootstrap, expired sign-in, Windows-only report, or installer CI gap needs an evidence-first fix.
---

# Relmio installer reliability

Treat installer failures as release blockers. Preserve user work and secrets while reproducing the exact runtime path.

## Establish a safe baseline

1. Read the repository `AGENTS.md` and current release metadata.
2. Record `git status`, branch, `HEAD`, and upstream divergence before fetching.
3. Fetch `origin/main`. Never overwrite a dirty checkout. Use an isolated branch or checkout when upstream changes overlap local work.
4. Inspect screenshots and reports for the first failing boundary: bootstrap, Node/npm selection, ACL protection, browser launch, OAuth callback, credential promotion, or UI polling.
5. Run the narrow existing tests before editing. A green baseline is evidence of a coverage gap, not proof that the report is invalid.

## Reproduce Windows behavior faithfully

- Start from a clean-user fixture with no `.relmio` directory and no local n8n Docker stack. Missing prerequisites must be reported inside the browser wizard, not terminate the CLI before the browser opens.
- Verify bare `relmio`, bare NPX, and repository `npm start` launches use the foreground wizard without initializing persistent local state. Exercise `start`, `status`, `open`, and `stop` separately when testing the opt-in persistent dashboard.
- Exercise both `install.cmd` and `install.ps1` with installed Node 24 and the checksum-verified portable fallback.
- Keep `RELMIO_FOREGROUND_WIZARD=1` scoped to the child invocation and verify restoration afterward.
- Invoke npm on Windows through the current Node runtime or `npx.cmd`; never rely on shell execution of a POSIX shim.
- Test with inherited or extra profile ACL entries. Foreground browser handoff must use a fresh, owner-only temporary root and must not require the persistent `.relmio` root to be healthy.
- Treat a successful Windows `explorer.exe` spawn as the browser-dispatch boundary. Its later exit status does not prove the browser failed and must not trigger deletion of the handoff file; keep direct-launcher nonzero-exit checks for macOS and Linux.
- Verify false and thrown default-browser launches produce an actionable, secret-free error and close the server plus temporary handoff root.
- Run real Windows ACL read-back tests on native Windows, not only mocked platform branches.

## Fix sign-in without exposing credentials

1. Check the current official OpenAI Codex authentication and CLI documentation before changing the login contract.
2. Prefer a pinned official Codex CLI browser login over parsing undocumented third-party authorization output.
3. Give each attempt an isolated protected `CODEX_HOME` and force file credential storage.
4. Capture helper output only with a strict byte bound. Never return it to the browser or logs.
5. Validate the credential file, protect it before reading or copying, stage it, and atomically promote it only after the official helper exits successfully.
6. Preserve the previous credential on cancellation or failure. Bound process-tree termination and block retries when termination or final commit cannot be confirmed.
7. Return only a random attempt identifier and a fixed launch mode to browser JavaScript. Poll server-owned status and reject stale attempts.

## Work test-first

For each root cause:

1. Add one focused regression that fails for the observed reason.
2. Make the smallest production change that passes it.
3. Run the focused module tests.
4. Run neighboring server, UI, installer, ACL, and cancellation tests.
5. Keep security invariants explicit: loopback only, no capability or OAuth URL in logs, no credential contents in responses, and exact cleanup only.

## Harden CI and release evidence

Windows CI must cover:

- the complete repository check under the pinned npm version;
- Windows PowerShell 5.1 parsing;
- native PowerShell and CMD bootstrap tests;
- installed and portable Node/npm handoffs;
- browser launcher failure handling;
- real owner-only handoff ACL verification;
- the pinned official Codex Windows login binary;
- OAuth credential promotion and sanitized errors;
- `npm audit --audit-level=high` and `npm pack --dry-run`.

Before handoff, run `npm run check`, the focused native Windows tests, `npm audit --audit-level=high`, `npm pack --dry-run`, and `git diff --check`. Report exact pass/skip counts, any environment-limited checks, the upstream commit used, and whether the user's original checkout was left untouched.

Do not deploy, publish, alter the existing n8n Compose/container, expose port 10531, or perform remote writes without the required human confirmation.

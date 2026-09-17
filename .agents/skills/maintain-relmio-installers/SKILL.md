---
name: maintain-relmio-installers
description: Maintain Relmio's macOS/Linux, PowerShell, CMD, NPX, browser-wizard, installer documentation, and native CI surfaces together. Use for planned installer changes and parity audits; use installer-reliability for a specific reported failure.
---

# Maintain Relmio installers

Keep bootstrap scripts, browser handoff, install-page commands, documentation, packaging, and CI synchronized. Work from the repository root, never from hard-coded paths copied from another computer.

## Start with the actual user state

Assume a new user has no `.relmio` files and no local n8n Docker stack. A bare `relmio`, bare NPX command, or hosted launcher must still open the foreground browser wizard. Missing Docker, n8n, or other prerequisites belong in actionable wizard states; they must not terminate the CLI before the browser opens.

Inspect the current diff and at least these surfaces when applicable:

- `web/public/install.sh`, `install.ps1`, and `install.cmd`;
- `web/app/components/CopyCommand.tsx`, `/install`, and selector styles;
- `src/cli.js`, `src/browser.js`, browser handoff, and server lifetime code;
- `README.md`, `npm/README.md`, `CHANGELOG.md`, and affected guides;
- installer, browser, CLI, documentation, package-content, and UI tests;
- `.github/workflows/ci.yml`.

Search for every published installer command before editing. Use the `sync-relmio-readmes` skill when the behavior is user-visible.

## Preserve the platform contract

- Keep native macOS/Linux, Homebrew, PowerShell, Command Prompt, and NPX choices when they are public.
- Prefer an installed compatible Node.js runtime. A portable fallback must use HTTPS, an exact upstream SHA-256, a unique temporary directory, safe quoting, and guaranteed cleanup.
- Pass `--yes --ignore-scripts relmio@latest`. Scope `RELMIO_FOREGROUND_WIZARD=1` to the child invocation and restore caller state.
- PowerShell must support Windows PowerShell 5.1 and PowerShell 7 without requiring Git Bash. Do not use `exit`, leak preference/TLS changes, or invoke a POSIX npm shim.
- CMD must avoid overwriting an existing temporary launcher and must preserve the caller's environment and exit status.
- POSIX shell must retain its controlling terminal and must not assume Homebrew or a package manager exists.

On Windows, a successful `explorer.exe` spawn is the default-browser dispatch boundary. Explorer's later exit code is not proof that navigation failed. Keep the private handoff file and foreground server alive until the page consumes the handoff, it expires, or the user cancels. Synchronous launch failures must close exact owned resources and show a recovery path without exposing a capability.

## Test the real boundaries

Add a focused failing regression first, then run the smallest relevant set and the full gate. Windows CI must exercise:

- the complete repository check with Node.js 24 and npm 10.9.8;
- Windows PowerShell 5.1 parsing plus native PowerShell and CMD bootstraps;
- installed and portable Node/npm paths;
- bare first-run startup with no Relmio state or local n8n stack;
- default-browser success, synchronous failure, cleanup, and real owner-only ACL read-back;
- pinned official Codex login, cancellation, credential validation, and atomic promotion;
- high-severity dependency audit and package preview.

Also run the applicable hosted-web lint, typecheck, tests, and Vercel build. Browser QA should use an available supported browser and cover keyboard selection, copy feedback, narrow layout, and a clean console; never require one maintainer-specific browser such as Opera GX.

Before shipping, run `npm run check`, focused installer tests, `npm audit --audit-level=high`, `npm pack --dry-run`, and `git diff --check`. Report native checks separately from mocked platform branches.

Do not edit, rebuild, restart, or remove the user's n8n stack. Do not expose port `10531`. Push, PR, merge, deployment, package publication, and distribution updates each require the repository's authorization gates.

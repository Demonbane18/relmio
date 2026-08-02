# Task checklist

## Active: Astryx interface overhaul

- [x] Task 13: Establish the visual and dependency foundation
  - Acceptance: Product context, selected direction, Astryx packages, CLI
    index, provider, and theme contract are present.
  - Verify: Astryx CLI doctor/component docs and focused setup tests.
  - Files: `PRODUCT.md`, `AGENTS.md`, `web/package*.json`, `web/app/`

- [x] Task 14: Revamp the hosted Relmio landing and chat surfaces
  - Acceptance: The landing page explains the relay quickly, exposes clear
    install/chat actions, preserves request-bound auth, and handles all chat
    states responsively and accessibly.
  - Verify: web build, rendered HTML tests, keyboard flow, Opera GX desktop and
    mobile inspection.
  - Files: `web/app/page.tsx`, `web/app/components/`, `web/app/globals.css`

- [x] Task 15: Revamp the hosted install route
  - Acceptance: Curl/NPX selection and copy feedback remain keyboard operable,
    while the installation boundary and next steps are easier to scan.
  - Verify: component behavior tests and `/install` browser QA.
  - Files: `web/app/install/page.tsx`, `web/app/components/CopyCommand.tsx`

- [x] Task 16: Revamp the localhost browser wizard
  - Acceptance: Every existing form name, DOM ID, workflow state, and final
    confirmation remains functional in a responsive Astryx-aligned shell.
  - Verify: focused UI contract tests, root test suite, and complete fake-flow
    browser QA without a real VPS or ChatGPT account.
  - Files: `src/ui/index.html`, `src/ui/styles.css`, `src/ui/app.js`, `test/ui.test.js`

- [x] Task 17: Synchronize user documentation and visual evidence
  - Acceptance: GitHub and npm READMEs explain the updated wizard, use
    sanitized current screenshots, and preserve all safety/legal boundaries.
  - Verify: README tests, package build, tarball README inspection, anonymous
    asset checks where applicable.
  - Files: `README.md`, `npm/README.md`, `docs/images/setup/`, tests

- [x] Task 18: Finish review and local main merge
  - Acceptance: All checks, audits, responsive/accessibility QA, Impeccable
    review, staged secret scan, and code review pass with no material finding.
  - Verify: root `npm run check`, web lint/typecheck/build/tests, npm audits,
    package preview, Opera GX QA, and clean post-merge `main`.
  - Files: reviewed feature diff and Git history

- [x] Task 1: Scaffold the package and test harness
  - Acceptance: Node 22 package scripts and a secret-safe ignore policy exist.
  - Verify: `npm test` reaches the test runner.
  - Files: `package.json`, `scripts/`, `test/`

- [x] Task 2: Protect the n8n boundary
  - Acceptance: Inputs are allowlisted and forbidden n8n lifecycle commands are rejected.
  - Verify: focused policy tests fail first, then pass.
  - Files: `src/domain/validation.js`, `src/domain/safety.js`, tests

- [x] Task 3: Generate the sidecar
  - Acceptance: Compose uses an external network and contains no `ports` or Traefik labels.
  - Verify: template tests inspect generated output.
  - Files: `src/domain/templates.js`, tests

- [x] Task 4: Discover n8n read-only
  - Acceptance: running n8n containers and networks are parsed without mutation.
  - Verify: discovery tests use captured Docker output.
  - Files: `src/services/discovery.js`, tests

- [x] Task 5: Add verified SSH/SFTP
  - Acceptance: host fingerprint confirmation is required and secrets are not logged.
  - Verify: fake transport tests cover rejection and upload.
  - Files: `src/infrastructure/ssh.js`, tests

- [x] Task 6: Install only the sidecar
  - Acceptance: remote writes stay under `/docker/n8n-openai-oauth`; n8n is untouched.
  - Verify: installer integration tests assert the exact command sequence.
  - Files: `src/services/installer.js`, tests

- [x] Task 7: Handle local OAuth
  - Acceptance: existing auth is detected and fresh login uses the pinned upstream CLI.
  - Verify: process and filesystem fakes cover success, expiry, and missing auth.
  - Files: `src/services/oauth.js`, tests

- [x] Task 8: Serve the localhost wizard
  - Acceptance: server binds to loopback, requires a session token, validates origin/body size.
  - Verify: localhost HTTP integration tests.
  - Files: `src/web/server.js`, tests

- [x] Task 9: Add the browser UI
  - Acceptance: keyboard-accessible steps cover fingerprint, discovery, plan, confirm, and result.
  - Verify: runtime browser inspection and clean console.
  - Files: `src/ui/index.html`, `src/ui/app.js`, `src/ui/styles.css`

- [x] Task 10: Write the beginner guide and troubleshooting
  - Acceptance: corrected Hostinger path and all observed failures are documented.
  - Verify: commands match generated templates and current upstream flags.
  - Files: `README.md`, `docs/manual-install.md`, `docs/troubleshooting.md`

- [x] Task 11: Document security and maintenance
  - Acceptance: threat model, uninstall, token refresh, and upgrade process are explicit.
  - Verify: security checklist review.
  - Files: `docs/security.md`, `docs/architecture.md`, `docs/maintenance.md`

- [x] Task 12: Verify and prepare the `0.1.6` release candidate
  - Acceptance: tests, lint, audit, package preview, and secret scan pass;
    repository metadata and public documentation are complete.
  - Verify: `npm run check`, `npm audit --audit-level=high`, and
    `npm pack --dry-run`.
  - Files: repository metadata and Git history

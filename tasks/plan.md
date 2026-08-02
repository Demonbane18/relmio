# Implementation Plan: Relmio n8n Setup

## Active feature plan: Astryx interface overhaul

### Overview

Replace the hosted Relmio site and localhost setup wizard visual system while
preserving routes, behavior, form field names, security boundaries, product
truth, and tested installation flows. Use Astryx directly in the React/Next.js
site and translate the same semantic tokens, density, and interaction rules to
the dependency-light static wizard.

### Architecture decisions

- Install `@astryxdesign/core`, one official Astryx theme, and the Astryx CLI
  only in `web/`; do not add React or a build step to the published local wizard.
- Use Astryx components for hosted-site controls and documented page patterns;
  use shared Relmio semantic tokens to make the static wizard feel like the
  same product without shipping the React runtime in the npm CLI.
- Preserve the existing `/`, `/install`, API routes, control names, DOM IDs
  required by `src/ui/app.js`, and all remote-write confirmation gates.
- Keep motion purposeful and lightweight, with reduced-motion fallbacks and no
  scroll listeners that update React state.
- Treat visual QA as a merge gate: desktop and mobile Opera GX checks, clean
  console, keyboard navigation, contrast, tests, lint, typecheck, builds,
  package inspection, audit, and fresh-context finish review.

### Phase 1: Foundation and proof

- [x] Record approved product context and replacement visual direction.
- [x] Install and initialize Astryx through its official CLI.
- [x] Add failing structural tests for Astryx setup, retained routes, wizard
  landmarks, and documentation requirements.

### Checkpoint: foundation

- [x] Astryx CLI can resolve the selected components and tokens.
- [x] Focused tests fail for the intended missing UI contract, then pass after
  the first implementation slice.

### Phase 2: Hosted surfaces

- [x] Build the shared Astryx provider, theme overrides, navigation, and core
  interaction components.
- [x] Recompose the hosted landing page and chat demo without changing the
  request-bound authentication path.
- [x] Recompose `/install` around the existing accessible command picker.

### Checkpoint: hosted site

- [x] `npm run build:vercel`, `npm run typecheck`, `npm run lint`, and web tests
  pass in `web/`.
- [x] Landing, chat, and install routes work at 320px, 768px, 1024px, and
  1440px in Opera GX.

### Phase 3: Local wizard and documentation

- [x] Redesign `src/ui/` while preserving every tested ID, field, status, and
  safe workflow transition.
- [x] Update GitHub and npm READMEs with the revised browser wizard guide and
  sanitized screenshots.
- [x] Build and inspect the npm tarball to confirm the concise npm README and
  static wizard assets are correct.

### Checkpoint: complete

- [x] Root and web automated checks, audits, package inspection, accessibility
  review, and secret scan pass.
- [x] Impeccable detector and fresh-context finish review have no unresolved
  material finding.
- [x] Feature commits are reviewed and merged into local `main`; no push,
  deployment, publication, or remote system change is performed.

### Risks and mitigations

| Risk | Impact | Mitigation |
|---|---:|---|
| Astryx beta API changes | High | Pin exact versions, initialize the CLI, and use generated component docs |
| Next.js/Vinext CSS mismatch | High | Use published prebuilt CSS and verify both build paths before merge |
| Static wizard behavior regresses | High | Preserve IDs and write contract tests before markup changes |
| Visual redesign obscures safety gates | High | Make identity, fingerprint, plan, and confirmation states primary UI landmarks |
| Package size grows unnecessarily | Medium | Keep Astryx in `web/`; retain vanilla HTML/CSS/JS for the npm wizard |
| README screenshots expose data | High | Use sanitized local fixtures only and inspect image metadata |

### Open questions

- None. The user authorized a full visual overhaul, README updates, local merge
  after passing QA, and no external deployment or publication.

## Overview

Create an `npx`-ready localhost browser wizard and beginner documentation that deploy a separate `openai-oauth` Docker Compose sidecar beside n8n without modifying the existing n8n deployment.

## Architecture decisions

- Use a local browser wizard instead of a TUI so non-technical users see a guided interface.
- Use Node core APIs for the web server and tests to minimize dependencies.
- Use `ssh2` for in-memory password authentication, host-key verification, static command execution, and SFTP.
- Generate a separate Compose project that references an existing external Docker network.
- Keep discovery read-only and require confirmation before the first remote write.
- Never expose a host port or add a Traefik route.

## Dependency graph

```text
Validation and safety policy
  -> Docker templates and immutable deployment plan
    -> Read-only remote discovery
      -> Confirmed SSH/SFTP installation
        -> Local wizard API
          -> Browser UI
            -> Documentation and release checks
```

## Phases

### Phase 1: Safety foundation

- Task 1: Add project rules, spec, package manifest, and test harness.
- Task 2: Test and implement input validation and forbidden-command policy.
- Task 3: Test and implement Dockerfile/Compose generation.

### Checkpoint

- Tests prove the sidecar has no published ports and no generated n8n mutation commands.

### Phase 2: Remote workflow

- Task 4: Test and implement read-only Docker discovery.
- Task 5: Test and implement SSH host verification and SFTP boundaries.
- Task 6: Test and implement confirmed, sidecar-only installation.

### Checkpoint

- Fake-SSH integration tests cover discovery, install, failure, and rollback instructions.

### Phase 3: Guided experience

- Task 7: Test and implement local OAuth detection/login.
- Task 8: Test and implement the localhost wizard server.
- Task 9: Build and runtime-check the accessible browser interface.

### Checkpoint

- The full local flow runs without a real VPS and exposes no secrets in responses or logs.

### Phase 4: Documentation and release

- Task 10: Write the manual guide and troubleshooting matrix.
- Task 11: Complete security, architecture, uninstall, and maintenance documentation.
- Task 12: Run tests, lint, audit, package preview, staged-secret scan, and prepare the GitHub repository and npm release.

## Future roadmap

The completed initial implementation remains the supported baseline. Future
provider-neutral work, including the gated SuperGrok/xAI OAuth feasibility
track, is maintained in [`docs/roadmap.md`](../docs/roadmap.md).

## Risks and mitigations

| Risk | Impact | Mitigation |
|---|---:|---|
| Existing n8n is disrupted | High | Separate project; static command allowlist; tests reject n8n lifecycle commands |
| OAuth credential leaks | High | SFTP only; no logging/response bodies; restrictive permissions |
| SSH man-in-the-middle | High | Display and confirm SHA-256 host fingerprint before authentication |
| Public bridge exposure | High | No `ports`; no Traefik labels; inspect published ports after start |
| Upstream OAuth changes | Medium | Pin `2.0.0`; document update and re-test process |
| Password remains in memory | Medium | Request-scoped use only; never persist; recommend SSH agent |

## Open questions

- None for the approved initial release.

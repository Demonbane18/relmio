# Implementation Plan: PlanRelay n8n Setup

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

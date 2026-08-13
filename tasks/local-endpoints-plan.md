# Implementation Plan: Policy-safe local endpoints

## Dependency graph

```text
Official-source boundary + threat model
  -> pure validation and provider contracts
    -> generated gateway/runtime and Compose templates
      -> local filesystem/process boundary
        -> confirmed installer and verification
          -> Codex device-code bridge
            -> wizard routes
              -> local browser UI
                -> docs and release verification
```

## Incremental slices

### Slice 1: Contract and pure domain foundation

- Add provider, port, Platform-key, browser-origin, host-header, and route
  validation.
- Generate pinned/hardened Dockerfiles, Compose files, and the dependency-free
  gateway runtime.
- Verify exact loopback mappings and the separation between Platform and Codex
  credentials.

Checkpoint: focused domain tests pass; no filesystem or Docker side effects.

### Slice 2: Local installation boundary

- Add a shell-free local process runner with bounded output and timeouts.
- Add managed-root creation, symlink/unmanaged-root rejection, restrictive file
  modes, port collision detection, and static Docker Compose invocations.
- Verify health and OpenAI model access without returning upstream secrets.

Checkpoint: fake-process integration tests prove the exact write/command order
and absence of n8n commands.

### Slice 3: Official Codex authentication

- Run a one-shot pinned Codex App Server over stdio in the installed Compose
  project.
- Send `initialize`, `initialized`, then `account/login/start` with
  `chatgptDeviceCode`.
- Validate and surface only the official verification URL and one-time user
  code; monitor the completion notification.

Checkpoint: fake-process tests cover all protocol and failure states.

### Slice 4: Wizard server and UI

- Add authenticated local status, plan, install, login, and login-status routes.
- Add a dedicated local endpoints page linked from the existing wizard.
- Keep credentials only in form/request memory; clear the Platform key after
  install.
- Render mode-specific review and result screens with accurate compatibility
  and experimental notices.

Checkpoint: server integration and static UI tests pass.

### Slice 5: Documentation and evidence

- Document local installation, client configuration, rotation, update,
  uninstall, threat model, policy boundary, and limitations.
- Run focused tests after each slice, then full checks, audit, package preview,
  secret scan, and Opera GX runtime QA.
- Review the final diff against the pre-existing dirty worktree and stage only
  files owned by this feature.

## Rollback strategy

- Each local target is an independent Compose project and managed directory.
- Installation never mutates the remote n8n project.
- A failed new install leaves only its own managed local directory and reports
  an exact recovery command; it does not remove unrelated containers or files.
- A failed update preserves the named Codex data volume and does not delete
  credentials or thread history.
- Source changes are delivered in small reviewable commits after each verified
  slice.

## Decision record

- Standard `/v1` compatibility requires Platform credentials.
- ChatGPT subscription access uses official Codex App Server semantics.
- Browser clients use an exact origin allowlist; no wildcard or `null` origin.
- Capability tokens are distinct from upstream credentials and rotate on every
  install/update.
- The Codex capability verifier is persisted as SHA-256 only. The OpenAI gateway
  also persists only its local verifier; its upstream Platform key is passed
  over stdin to a transient, network-disabled helper and stored in a private,
  labeled named volume rather than a host source file.
- App Server is pinned to `@openai/codex@0.147.0` and its experimental status is
  a user-visible product constraint.

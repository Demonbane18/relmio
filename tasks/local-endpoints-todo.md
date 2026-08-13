# Task checklist: Policy-safe local endpoints

- [x] Task 1: Add local-provider validation and contracts
  - Acceptance: target, port, Platform key, origins, host, and path validation
    fail closed.
  - Verify: focused domain tests are written failing first and then pass.
  - Evidence: `test/local-endpoints.test.js` covers the closed provider set,
    ports, Platform keys, exact origins, immutable metadata, and both plans.

- [x] Task 2: Generate hardened local Docker artifacts
  - Acceptance: exact loopback mapping, pinned providers, separate auth modes,
    non-root/read-only services, and no host/Docker-socket mounts.
  - Verify: template tests inspect every security-sensitive line.
  - Evidence: generated Compose, Dockerfile, Codex config/requirements, and
    build-context exclusions are asserted without invoking live Docker.

- [x] Task 3: Implement the OpenAI gateway runtime
  - Acceptance: local bearer auth, fixed upstream, streaming/backpressure,
    cancellation, CORS allowlist, header filtering, and error pass-through.
  - Verify: localhost integration tests with a fake upstream.
  - Evidence: `test/openai-gateway.test.js` exercises auth, browser/native
    callers, fixed routing, header isolation, incremental streaming, aborts,
    limits, and secret-free failures against a fake upstream.

- [x] Task 4: Implement the local process/filesystem boundary
  - Acceptance: argument-array Docker calls, managed-root marker, modes,
    symlink refusal, output bounds, and timeout/cancellation.
  - Verify: fakes cover success and every fail-closed branch.
  - Evidence: `test/local-process.test.js` and `test/local-installer.test.js`
    cover shell-free argv execution, bounds, timeouts, managed paths, modes,
    symlink refusal, and scoped cleanup.

- [x] Task 5: Implement confirmed local installation
  - Acceptance: no writes before confirmation, collision detection, exact
    project-scoped Compose calls, readiness checks, and one-time capability.
  - Verify: installer tests assert commands, writes, responses, and redaction.
  - Evidence: installer tests cover both targets, pre-write validation,
    publisher verification, readiness, key rotation, and one-time capability
    delivery without touching a real Docker deployment.

- [x] Task 6: Implement official Codex device-code sign-in
  - Acceptance: App Server stdio initialization and device login use the pinned
    service volume; only safe URL/code/status data reaches the browser.
  - Verify: fake JSONL protocol tests cover success, error, cancel, and bounds.
  - Evidence: 24 top-level protocol tests cover framing, URL/code/login-id
    validation, matched completion, cancellation, timeouts, process errors,
    output bounds, and redaction.

- [x] Task 7: Add wizard server routes
  - Acceptance: all local routes retain setup-token, same-origin, body-size, and
    rate-limit controls; no upstream secret is returned.
  - Verify: localhost server integration tests.
  - Evidence: local server tests cover opaque single-use plans, preview
    isolation, serialized installs with lock release, safe responses,
    fresh-process attested Codex login/restart, and redacted failures while the
    existing remote server suite remains green.

- [x] Task 8: Add the local browser experience
  - Acceptance: provider choice, conditional fields, review confirmation,
    results, copy actions, device login, accessibility, and responsive layout.
  - Verify: static UI tests plus Opera GX runtime QA.
  - Evidence: static UI tests pass, and a sanitized Opera GX run completed both
    target flows with no console errors, horizontal overflow, cookies, or web
    storage; the Platform-key field was cleared after submission. The UI also
    shows the Codex experimental/non-production limit before and after install
    and excludes native Windows where owner-only POSIX modes are unavailable.

- [x] Task 9: Document the new boundary and operations
  - Acceptance: local install/client use/rotation/update/uninstall plus current
    OpenAI-source and experimental notices are clear.
  - Verify: documentation consistency tests and manual link review.
  - Evidence: the README pair, architecture, security guide, local-endpoint
    guide, and specification consistently separate Platform API auth from the
    official experimental Codex App Server and state the high-trust caveat. The
    local guide includes ownership-gated update/key-rotation, failed-install
    recovery, uninstall, and explicit Codex volume retention/deletion steps.

- [x] Task 10: Complete release evidence
  - Acceptance: focused and full tests, lint, release check, audit, package
    preview, secret scan, runtime QA, and final security/code review all pass.
  - Verify: record evidence in this checklist and stage only feature-owned files.
  - Evidence: `npm test` passed 226 tests with 6 platform-specific skips and no
    failures; syntax lint checked 51 JavaScript files; release metadata remained
    synchronized at `0.3.1`; npm audit reported zero vulnerabilities; the dry
    run packed the reviewed 68-file, 4.9 MB artifact; package-content tests and
    secret scans passed. Sanitized Opera GX QA completed both target flows with
    no console/storage/overflow issues, and fresh code plus security reviews
    were rerun after the final fail-closed fixes.

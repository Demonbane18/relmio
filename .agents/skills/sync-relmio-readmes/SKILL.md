---
name: sync-relmio-readmes
description: Keep Relmio's GitHub and npm READMEs factually aligned when setup, installer, compatibility, provider, safety, or other user-visible package behavior changes. Preserve each render target and verify the packaged npm README without authorizing publication.
---

# Synchronize Relmio READMEs

Use the repository root reported by `git rev-parse --show-toplevel`; never assume a user-specific checkout path.

## Decide from the diff

Read `AGENTS.md`, the changed implementation and tests, `CHANGELOG.md`, `README.md`, `npm/README.md`, and the directly affected guide. Preserve unrelated work.

Update both README sources when users need a different command, prerequisite, first-run expectation, provider boundary, compatibility statement, safety warning, or recovery step. Leave both unchanged for internal refactors and test-only work, and record that decision.

For installer work, assume a new user has no `.relmio` directory and no local n8n Docker stack. The quick start must explain what happens in that state without implying that existing services or files are required.

## Preserve the two targets

- `README.md` is the complete GitHub guide. Keep repository-relative links, local assets, diagrams, and detailed operating guidance.
- `npm/README.md` is the concise registry guide. Use absolute HTTPS image and documentation URLs, omit Mermaid, and link to the full GitHub guide instead of copying long maintenance sections.
- Keep commands, requirements, security boundaries, and user-visible outcomes identical even when the surrounding presentation differs.
- Never edit an extracted tarball README. `scripts/build-npm-package.js` owns the copy from `npm/README.md` to the package root.

Do not expose credentials, real infrastructure details, private URLs, or unsanitized screenshots. Do not claim that ChatGPT sign-in creates an OpenAI Platform API key or bypasses provider limits.

## Verify cross-platform

Run the documentation and package-content tests first, then the repository gate:

```text
node --test test/documentation.test.js test/package-contents.test.js
npm run check
npm audit --audit-level=high
npm pack --dry-run
git diff --check
```

When an actual tarball inspection is needed, use the repository's cross-platform package build and tests. Do not require a POSIX-only `tar` command on Windows.

Confirm that the GitHub README retains its intended diagrams, the packaged README contains no Mermaid, npm images use anonymous HTTPS URLs, and the tarball allowlist contains no unintended files.

These checks do not authorize a commit, push, merge, tag, publish, or deploy.

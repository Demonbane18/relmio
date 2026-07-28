# Contributing

Thanks for helping improve n8n OpenAI OAuth Setup. Pull requests, focused bug
reports, documentation fixes, and careful security feedback are welcome.

## Before you start

- Read the [README](README.md), [approved scope](SPEC.md), and
  [security guidance](docs/security.md).
- Do not include OAuth credentials, passwords, private keys, live wizard URLs,
  real VPS addresses, or screenshots containing account or infrastructure
  details.
- Keep the repository's safety boundary intact: the wizard must not edit,
  rebuild, restart, stop, recreate, or remove the existing n8n deployment.

## Local development

Use Node.js 22 or newer and the pinned npm version from `package.json`:

```bash
npm ci --ignore-scripts
npm run check
```

Use `npm run preview` for sanitized browser screenshots. Preview mode must
never open a live ChatGPT sign-in or connect to a real VPS.

## Pull requests

1. Fork the repository and create a focused branch.
2. Make the smallest complete change that solves the issue.
3. Add or update tests and documentation for user-visible behavior.
4. Run `npm run check`, `npm audit --audit-level=high`, and `npm pack --dry-run`.
5. Describe the user impact, safety implications, tests, and any follow-up
   work in the pull request.

Maintainers may request a smaller diff, additional evidence, or changes to
protect the sidecar-only safety guarantee. Release and npm publishing work is
performed by maintainers after the version, changelog, package, and Git history
have been reviewed.

## Issues and security

Use a focused issue for reproducible bugs or documentation improvements. For
security concerns, follow [Security and limitations](docs/security.md) and do
not disclose secrets or exploit details in a public issue.

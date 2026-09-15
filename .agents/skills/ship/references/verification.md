# Affected surfaces and verification

1. Keep `README.md` and `npm/README.md` synchronized in product claims,
   installation guidance, limitations, support links, and release-relevant
   content. Preserve their intentional presentation differences: npm uses
   registry-safe asset URLs and omits GitHub-only diagrams.
2. Decide which delivery surfaces apply by inspecting the changed paths and
   the actual merge or release scope:

   | Surface | Apply when | Verify |
   |---|---|---|
   | npm | Package files, runtime, docs, metadata, or CLI behavior changed | `npm pack --dry-run`, staged package content, and registry version after publish |
   | Installers | Bootstrap scripts, supported runtime, install docs, or package entry points changed | Platform-focused tests and downloaded-script checks |
   | Vercel web app | `web/**`, public web copy, install UX, or web-linked guides changed | web lint/typecheck/tests/build and production URL after deploy |
   | Homebrew/distribution | Formula, package-manager scripts, archive layout, installer behavior, or package version changed | artifact, immutable npm tarball, formula/repository status, and catalog status |

3. Do not claim that all surfaces changed when a row is not applicable. Record
   applicable surfaces and their evidence in the PR; summarize unaffected
   surfaces together when they share a reason.
4. Keep provider and credential boundaries precise. Retired API-key services
   use their own Platform API credentials. The current private n8n OAuth bridge
   is an unofficial, policy-uncertain compatibility path: it uses a ChatGPT/Codex
   credential file through the pinned third-party `openai-oauth` runtime to
   serve its selected Docker network's `/v1` interface. The official Codex App
   Server keeps its distinct protocol. Neither path is a general Platform API
   credential or evidence of provider authorization, scope approval, Terms
   compliance, or model/TTS entitlement.

## Choose checks for the requested operation

For a merge candidate, run checks for the affected behavior and package/delivery
contracts. Instruction-only edits need metadata, relative links, consistency,
and diff validation rather than local app builds or tests. Required CI remains
mandatory, including native Windows CI; proportional local checks do not waive it.
For a release candidate, run the full root gate below and applicable web and
installer checks. Do not skip a failed required command or silently substitute
an unverified result.

```sh
npm run lint
npm run release:check
npm test
npm audit --audit-level=high
npm run package:build -- .release
npm pack --dry-run
```

For changed web behavior or a release affecting the web app, run these in
`web/` as well:

```sh
npm run lint
npm run typecheck
npm test
npm run build:vercel
```

The web `npm test` command includes the Vinext build; `build:vercel` checks the
separate Next/Vercel build. Both are needed when these deployment paths apply.

Reuse passing evidence only when the tested tree, dependencies, and environment
match the candidate. Rerun affected checks after conflicts, tree or dependency
changes, or evidence of environmental differences. Record the tested commit and
environment; required CI still runs for the protected merge.

Also run `git diff --check`, inspect the complete diff for credentials and
unrelated changes, and verify README parity with the repository's tests or a
targeted content comparison. For browser changes, use Opera GX to check the
production build at desktop and narrow widths,
keyboard focus, accessible names, external-link attributes, and a clean
console. Do not access browser credentials, tokens, cookies, or storage.

Stop and fix or escalate if a relevant check fails, a high-severity audit issue
is unresolved, package contents contain an unexpected file, README variants
make conflicting product claims, or the candidate includes secrets.

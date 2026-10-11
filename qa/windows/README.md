# Reproducible Windows QA

## v0.22.1 release preparation, 2026-10-11

The candidate preserves Windows fix commit
`b6b4c2ac4e6b055fa22a9feeac757fb9bb2ac2bd`, based on current main
`2a112767aa857bf359d51db1b6f950b21a80c81b`, plus the frozen contextual Help
delta and coherent 0.22.1 metadata. The separate contextual Help preparation
root run reported on 2026-10-11 passed 1,731 tests with 104 explicit skips;
this is distinct from the 2026-10-10 checkpoint below (1,719 passed, 104 skipped).
The final Help correction passed 114 focused tests. Real
Windows Opera checks covered all six Help routes, busy Escape and the corrected
private-new-n8n wording. Synthetic Help accounts and API fixtures are not live
provider or Docker acceptance. These earlier receipts do not certify the final
versioned candidate: its required aggregate, packaging, CI and CodeRabbit gates
must still complete before release.

The owner accepted the known unpatched development-only `braces` advisory and
plans a macOS re-audit. New live VPS-update, image-generation and SuperGrok
workflow checks are not release passes. Fresh read-only VPS discovery/review did
not authorize or apply an update. SuperGrok needs refreshed private sign-in and
its n8n credential binding; availability of an earlier retained one-time local
key is unknown, not established as lost. Image sign-in and requests require
their separate human grant and bounded usage approval. The separate integration
task owns these checks; release approval does not authorize them.

## Unreleased Windows patch checkpoint, 2026-10-10

The tested source is main `2a112767aa857bf359d51db1b6f950b21a80c81b` plus an
uncommitted QA patch; package metadata remains 0.22.0. Native Windows checks
passed 1,719 cases with 104 explicitly skipped cases. Five documentation/package
tests and seven n8n harness unit tests also passed. The rebuilt package installed
offline and opened its actual local dashboard through its private launcher in
an isolated installed Google Chrome profile. The OS default opener was replaced
only by a no-op to keep the owner's browser untouched.

Real Compose 5.3.1 stopped-stack resume preserved the same QA n8n container,
image, mounts and managed-file identities, returned healthy with `/healthz` 200,
and left eight other containers and seven volume names unchanged. Older Compose
flag incompatibility is covered by fixtures, not an older installed binary.
Mount inventories must be sorted by destination: Docker can return the same
mounts in a different order. Retain the initial assertion failure separately.

One previously approved, tiny interactive SIWC text request completed on the
existing authorized account: 14 SSE events, completed terminal/status and exact
expected content, 23 input/10 output tokens. No new grant or additional request
was needed for this checkpoint. This does not prove sidecar/n8n/background,
native Codex clients, VPS, Google, SuperGrok or image integration. Do not
repeat provider requests without a concrete approved test and bounded usage.

The repository's full n8n node Docker runner is explicitly Linux-only. On
Windows it failed setup before any upstream request because the Docker bridge
gateway is not a bindable Windows interface. Its unit tests and real local-model
workflow evidence are separate; use the required Linux CI job for that runner.
Do not publish the sidecar port or change Docker security/network settings just
to make the Linux harness run on Windows.

Root full dependency and web production audits each returned zero vulnerabilities;
the prior full web development audit's braces findings remain separately recorded.
Five post-doc package checks, seven generated-doc checks and the generator's
check mode passed. Six bounded post-fix reviewer artifacts and their formal
report are complete for the earlier frozen diff. The later modal-focus delta
has separate source review, 30 focused controller checks and 34 native Chrome
notice checks across local/VPS markup, seven viewport sizes and both themes.
The reserved-tab test now asserts immediate closure before polling resumes.
These browser checks use synthetic accounts, not a live first-grant flow.

Remaining gates include owner disposition of the unpatched development-only
braces advisory, fresh frozen-commit aggregate/package checks, PR-head and
merged-main CI plus latest CodeRabbit review, and applicable live acceptance.
VPS needs a trusted fingerprint and private human authentication; Google needs
an approved OAuth client/grant; SuperGrok needs an eligible account and official
device sign-in; its existing isolated companion attests healthy, but a failed
installer attempt did not return its one-time local client key. Later availability
of a retained key is unknown. Supported sign-in alone does not create the n8n
credential binding; never extract a key from files or logs.
Images need a separate installed add-on/Codex grant and usage
budget. No blanket Windows feature pass or release readiness is claimed.

Use the standard [Relmio release acceptance workflow](../acceptance/relmio-release-acceptance.json), version `2026-10-07.3`, and its [instructions](../acceptance/README.md). It already contains HTTP Responses, HTTP Chat Completions, AI Agent + Calculator, Basic LLM Chain, OpenAI Message, image generation, and Local Model Chain. Keep one inactive copy per n8n; reuse/update it in place. Never infer a live provider pass from a mocked upstream.

## Isolation and prerequisites

1. Record `git status`, branch, exact base SHA, local diff, Windows version, Node, pinned npm 10.9.8, Docker/Compose versions, and browser. Preserve dirty worktrees.
2. Inventory existing containers and volumes with read-only Docker commands. Save exact IDs, image IDs, creation/start timestamps, restart counts and labels outside the checkout. Do not start/stop/recreate existing deployments.
3. Use a new protected `RELMIO_HOME` and `N8N_OPENAI_OAUTH_HOME`, and a separate supported browser profile. `RELMIO_HOME` must point to an owner-only `.relmio` directory with an owner-protected parent. These are actual Relmio variables; do not reuse personal auth stores.
4. Start an already-installed Docker Desktop normally. Installing prerequisites, rebooting, changing security/network settings, or creating provider credentials/grants needs the action-time user boundary. No Docker prune or broad cleanup.
5. Create only a disposable private n8n on a free loopback port (the 2026-10-10 run uses 15679). Do not publish 10531. Disable ngrok/Assistant until their separate prerequisites and implications are resolved.

## Automated gate

Run `npm ci --ignore-scripts` and `npm run check` with Node 24+ and pinned npm. Also run root production audit/package preview; web lint/typecheck/test/build:vercel and production audit; `node --test test/integration/n8n-nodes/*.test.js`; real Docker Compose rendering with `node scripts/local-stack-ci.mjs compose-config`; and `git diff --check`.

Report native execution separately from injected boundaries. NTFS directory junction fixtures exercise actual reparse-point rejection without Developer Mode. When Windows denies file symlink creation with EPERM, report that case as skipped/blocked, never passed. The CMD lock fixture is held until an explicit release file so machine load cannot turn a failure-path check into success.

Read [native skip coverage](skipped-tests.md). For the optional native Git Bash fixture, verify the installed shell path first, set RELMIO_TEST_POSIX_SHELL only in the test process, and run the gives-Git-Bash test in test/install-script.test.js. Do not count its default skipped case as passed.

Run authentic registry NPX acceptance from an empty directory outside this source checkout. With matching package/version inside its own checkout, npm can resolve the root package without a corresponding .bin shim; that is not a broken published artifact. Compare published source after normalizing checkout CRLF. Real foreground installers require actual interactive stdin/stdout; piping their output into a harness can trigger the documented no-interactive-terminal error. Do not fake TTY or change execution policy to claim acceptance. The documented PowerShell inline installer can be checked separately from direct .ps1-file policy.

## Real acceptance

1. Verify n8n container ownership, loopback binding, `/healthz`, and editor setup. Owner setup requires a user-approved email/name and privately entered password. Do not invent an external identity or print credentials. This account is separate from provider OAuth.
2. Install the allowlisted local model only on the QA n8n network. Read measured budgets/digests and risks first. Verify no host port, cloud fallback or model login; check the actual model response and the Local Model Chain result `4`.
3. For credential-free local-only preparation, run `node qa/windows/prepare-local-acceptance.mjs <outside-checkout-evidence-directory>`. Bind its Local Chat Model to the installed private credential. Provider/image checks are disabled and must remain NOT-RUN, not PASS. Use the canonical workflow for approved live provider coverage.
4. For ChatGPT: user SIWC identity login, separate plan-use permission, isolated registration/token storage, then select a model actually reported Ready. Standard acceptance consumes six text requests and, if enabled, one separate Codex image request. Image login/grants and usage are separate; do not identify a model from appearance.
5. For SuperGrok: approved official device login, eligible subscription and private credential store. For Gmail/Drive: approved OAuth client/redirect, minimum test scopes, explicit grants, isolated messages/files; no real mailbox sends or modifications to real Drive files.
6. Before ngrok: identify exact approved callback/webhook service and port, allowed paths, TLS/auth/access controls and public URL implications. An n8n tunnel exposes every proxied editor/API/webhook route unless an explicitly reviewed path-restricted proxy is used. Never expose the Relmio dashboard, port 10531, or the whole editor by default. A token/domain and exposure approval are needed before activation.
7. Exercise streaming/stop/errors/repeated clicks, keyboard/theme/narrow layout, planner input checks and ZIP structure, clean-tab auth rejection, daemon restart, exact stopped-stack resume, and update/removal confirmation boundaries. Do not combine an unapproved paid operation with a recovery test.

Google OAuth on local n8n can use the exact localhost redirect displayed by its credential UI without a public tunnel ([official n8n instructions](https://docs.n8n.io/integrations/builtin/credentials/google/oauth-generic)). For an initial narrow connection proof, generic Google OAuth allows Gmail gmail.labels for a QA-only label and Drive drive.file for a QA-only file. Review broader built-in consent separately. Current Relmio ngrok Basic Auth protects the whole n8n origin; it is not a path allowlist.

For Qwen streaming, inspect actual content/reasoning and finish_reason. A small max_tokens budget can end in reasoning only; a DONE event does not establish a content pass. Ollama's OpenAI compatibility supports reasoning_effort=none to disable thinking, but that changes model behavior and may reduce answer quality. Verify cancellation after actual content, then verify a fresh normal-thinking answer with adequate budget. Never change production defaults merely to make a fixture green.

## Hostinger target handoff

The current app accepts VPS target/authentication in the wizard; it does **not** implement a VPS dotenv loader. `.env.qa-hostinger.local` is ignored local QA metadata, not automatic configuration. Its documented QA-only variables are `RELMIO_QA_VPS_HOST`, `RELMIO_QA_VPS_PORT`, `RELMIO_QA_VPS_USERNAME`, `RELMIO_QA_VPS_EXPECTED_FINGERPRINT`, `RELMIO_QA_VPS_AUTH_MODE`, `RELMIO_QA_VPS_N8N_CONTAINER`, and `RELMIO_QA_VPS_DOCKER_NETWORK`.

Obtain host/IP, port, intended login, independently verified SSH fingerprint, exact n8n container/network and read-only/write scope. The user enters the SSH password in the wizard or loads an approved existing key into an already configured supported agent. Do not read existing secrets, put passwords/private keys into this metadata file, guess a host, start/configure an SSH agent, or accept a fingerprint blindly. No remote connection was made in this QA run. Remote writes need the final reviewed human confirmation; existing VPS n8n must not be restarted/rebuilt.

## Evidence and exact teardown

Keep screenshots, logs, account data, state, downloads and execution JSON outside public source/npm artifacts. For each matrix row record expected/actual, revision+diff, command or UI action, PASS/FAIL/BLOCKED/EXPECTED-UNSUPPORTED/NOT-RUN, provenance and evidence path. Recheck existing-resource baseline afterward.

Remove only disposable objects created by the run, after exact name/ID and ownership-label read-back. Remove model integration before its QA n8n network; model cache deletion is a separate explicit removal selection. Export useful workflows/evidence first. Use production reviewed removal flows when testable. Stop only the isolated dashboard and close only the dedicated QA browser session. Retain shared downloaded images; never use prune. Report all retained resources and unresolved tests.

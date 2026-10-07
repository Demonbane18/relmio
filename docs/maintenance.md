# Refresh, upgrade, rollback, and uninstall

Relmio installs ChatGPT plan connections through the local browser wizard.
The wizard owns SIWC registration, protected storage, model discovery, and the
reviewed local/VPS sidecar lifecycle. Do not use older instructions that copy
`auth.json` or run `openai-oauth` directly.

## Reauthorize a ChatGPT registration

Open the local wizard with `relmio open` or start it with:

```bash
npx --yes --ignore-scripts relmio@latest
```

Select the intended saved registration and choose **Sign in again** or
**Allow ChatGPT plan use** as shown. Reauthorization uses the same issued client
and verified subject. A new registration remains separate even when it has the
same email. If sign-in succeeds without the ChatGPT plan scope, identity stays
connected but model access remains disabled.

If plan use was paused locally, re-enable it only if the selected registration
still has the provider grant. The first-use plan notice must be acknowledged
before model access. **Manage usage** opens ChatGPT's usage settings.

## Install or manage the n8n sidecar

The selected n8n container and Docker network must already exist. The wizard
reviews both, requires separate consent for background workflow use, and asks
for final confirmation before a sidecar write. It does not change n8n's
credentials, Compose configuration, image, or lifecycle.

Installation generates a bearer for the private Relmio sidecar, displays it
once, and stores only its SHA-256 verifier in Compose. Enter the bearer
manually in n8n. It authorizes the sidecar, not OpenAI. The sidecar publishes
no host port.

Local and VPS installs bind the selected registration to a destination host ID
and runtime. The review also binds the exact n8n container and network IDs;
the VPS installer checks them again before its first write and before the
transfer, and a changed ID requires a new review. After a VPS install
completes, status and sign-out need only the same SSH host identity and Docker
network ID, so recreating n8n or changing the SSH login method does not block
them. The wizard initializes the
destination before freezing the source for transfer. The destination becomes
the sole refresh owner after it returns an attested receipt; only then are
source tokens cleared. If transfer or receipt is uncertain, leave the sender
frozen and use the reviewed recovery below. Do not restore an old token
backup, repeat the handoff blindly, or activate both copies.

### Resume or reconcile an interrupted install

If an install stops partway, status shows it as staged. Select the account,
choose the resume action, review the plan, and confirm it. Relmio continues
the same installation without deleting data or starting a second refresh
writer. A same-account resume uses the account's current state, so turning
plan use on or off or a token refresh does not block it. Resuming after the
session already moved replaces the one-time key.

If the destination accepted the session but the sender lost the
acknowledgment, the account stays handoff-pending. Choose the reconcile
action, review it, and confirm within five minutes. Relmio reads the
destination's identity-bound receipt and finishes the handoff. Without a
receipt the sender stays frozen and needs a fresh sign-in; old tokens are
never restored. A transport failure reports an unknown remote outcome. A
different account can take over only after a confirmed "not accepted"
result; Relmio refuses if the original receipt appears, and on a VPS while a
one-off sidecar helper container is still present.

If ownership moved but a later finishing step failed, the result is partial.
It still shows the one-time key once, with a warning not to use it until the
reported issue is resolved. Relmio never restarts an old writer
automatically.

The SIWC Terms' local/user-controlled token-storage language and OpenAI's
self-hosted VM guide do not resolve persistent remote VM storage. This guide
describes Relmio's implementation, not provider approval for a VPS.

## Migrate a local credential-copy installation

An older `auth.json` credential-copy bridge is not a SIWC registration and is
never imported into the new runtime. When the local wizard detects an owned
legacy target, its separate migration review requires a fresh SIWC sign-in,
separate migration consent, and final confirmation of the exact target.

Only after confirmation does Relmio stop the attested old service. Its old
credential and workspace volumes remain offline; the replacement uses a new
registration/runtime and a new local bearer. Old history and tokens are not
merged. If any migration or stop result is uncertain, the old writer stays
stopped, retained volumes are left for inspection, and Relmio does not
automatically resume, roll back, or delete them. Do not manually copy tokens or
remove the retained volumes.

This describes the local migration path only. VPS legacy migration has its own
reviewed state and is not provider-approved by these controls. The current
source check records the separate, unresolved VPS token-storage question.

## Sign out or disable plan use on an installed target

Choose **Manage account** for the installed Codex or n8n target. Relmio
re-attests the owned installation and stops the exact service before changing
the selected registration. If the process cannot be confirmed stopped, the
account operation does not proceed.

Sign-out attempts provider revocation and clears local access, refresh, and ID
tokens. The account mapping remains. The result distinguishes confirmed,
unconfirmed, and not-applicable revocation. A refresh-uncertain session remains
unconfirmed even if OpenAI returns HTTP 200, because the refresh-token family
may have rotated outside the known record. If unconfirmed, disconnect Relmio
in ChatGPT settings; local cleanup is not proof of remote revocation or
provider-side deletion.

## Replace the account on an installed target

Relmio does not silently swap an installed target to another account. First
sign out or disable plan use through **Manage account**; Relmio attests and
stops only that owned service. A replacement plan is available only after the
old target is confirmed signed out and stopped. Select a new independently
authorized SIWC registration, review the exact replacement, and confirm it
separately.

The old registration mapping and any Codex history or credential volumes remain
preserved separately and offline; only the new registration is activated after
review. Relmio does not transfer or merge token/history state or combine
accounts by email. If replacement state is uncertain, inspect the stopped
target and retained data; Relmio does not restore the old account automatically.

## Recover a request or transfer

- Identity-only account: request the plan grant separately in ChatGPT.
- Usage-limit error: open **Manage usage**; do not rotate accounts or switch
  billing.
- **Model-inference 503 or interrupted stream:** keep the same registration
  and follow the shown retry-later action. A partial answer is not success.
- **Token discovery fails before refresh:** no refresh POST was sent, so the
  session is unchanged; retry later as shown.
- **Refresh POST returns 503 `temporarily_unavailable`:** the pre-refresh
  session is restored and Relmio reports retry-later. This assumes OpenAI did
  not rotate the refresh token, which OpenAI does not document.
- **Refresh POST returns another error, or its network outcome is
  uncertain:** plan use is frozen before the POST. Protected token bytes may
  remain, but the old refresh token is never retried. Complete a fresh SIWC
  sign-in for the same registration before model use.
- **Refresh response cannot be verified:** replacement tokens remain frozen
  with no access lease until successful authentication. `invalid_grant` clears
  unusable tokens and requires reauthorization.
- **Unconfirmed revocation after refresh uncertainty:** a successful remote
  revoke response does not clear the uncertainty; disconnect Relmio in ChatGPT
  settings.
- Unsupported capability or parameter: correct the request; do not retry it
  unchanged or expect a fallback.
- Unresolved handoff: retain the frozen source and use the reviewed resume or
  reconcile action above.

## Update the runtime

Install a newer Relmio package to update the wizard. Existing sidecars are
separate deployments; use the offered ownership-attested maintenance action
and review its target and plan before confirming. A package upgrade alone does
not replace a running sidecar. Do not apply old Dockerfile or Compose snippets
from the former credential-copy guide to an existing installation.

For local endpoints, select the exact target and use the dashboard's reviewed
management action. For VPS, confirm the SSH host fingerprint before
authentication, review the selected server identity, and give a separate
final confirmation for remote writes. Never publish port `10531` or change
the existing n8n service to recover the sidecar. To rebuild an installed VPS
ChatGPT sidecar from the current version, follow
[Update the installed sidecar](vps-and-n8n.md#update-the-installed-sidecar).

## Recheck OpenAI sources

For each implementation or documentation update, fetch current official
identity, SIWC plan-use, model/limitation/error, applicable Terms, and privacy
sources. Compare the exact code path with the sources. Record what Relmio
reads, stores, transmits, and logs; scopes; data recipients; and unresolved
retention or provider requirements. Keep identity, separately granted plan
permission, and model/host capability as separate checks.

The current review is
[openai-source-check-2026-10-05.md](openai-source-check-2026-10-05.md).
Earlier dated source checks are historical implementation records. None is
legal approval, and issue #97 assigns privacy/legal copy to the owner and
counsel.

## Updating or rolling back AI Assistant companion images

The AI Assistant companion has no automatic remote image upgrade. Relmio never
edits the existing n8n Compose file, image, or environment, and never directly
mutates n8n as part of a companion update or rollback.

Maintainers must treat the Sandbox Service API, privileged runner, and nested
sandbox image as one compatibility unit. Before changing
`ASSISTANT_COMPANION_IMAGES` in `src/domain/assistant-templates.js`:

1. Review the official [n8n Sandbox Service release notes and source](https://github.com/n8n-io/n8n-sandbox-service), its [API](https://github.com/n8n-io/n8n-sandbox-service/pkgs/container/n8n-sandbox-service-api), [runner](https://github.com/n8n-io/n8n-sandbox-service/pkgs/container/n8n-sandbox-service-runner-dind), and [nested sandbox](https://github.com/n8n-io/n8n-sandbox-service/pkgs/container/n8n-sandbox-service-sandbox) package registries, plus the [SearXNG source](https://github.com/searxng/searxng) and [SearXNG package registry](https://github.com/searxng/searxng/pkgs/container/searxng).
2. For every candidate, verify the reviewed tag resolves to the intended OCI
   **index** digest and the required Linux platforms. Record a full immutable
   `tag@sha256:<digest>` reference; never substitute `latest`, `stable`, a
   tag-only reference, or a digest-only reference.
   Inspect each numbered or source-revision tag with the same command pattern:

   ```bash
   docker buildx imagetools inspect \
     ghcr.io/UPSTREAM/IMAGE:REVIEWED_VERSION_TAG
   ```

   Record the top-level `Digest` and required Linux platform entries from that
   output. Then repeat the inspection with the proposed full
   `tag@sha256:<digest>` reference and require the same top-level digest. This
   is maintainer evidence gathering only; it does not authorize an update to a
   running companion.
3. Update only the exact source constants, add or update a generated-Compose
   regression, and run these local release gates from the repository root:

   ```bash
   node --test \
     --test-name-pattern="immutable|floating|pinned" \
     test/assistant.test.js
   npm run check
   npm audit --audit-level=high
   npm pack --dry-run
   npm --prefix web run lint
   npm --prefix web run typecheck
   npm --prefix web run build:vercel
   npm --prefix web test
   npm --prefix web audit --audit-level=high
   ```

   Obtain a fresh security review of the exact change set after every fix.
   Release only after all gates pass.

For an already managed companion, the administrator updates Relmio locally,
reconnects and completes host-key confirmation plus read-only discovery, then
reviews the exact companion-only plan. Keep the recorded SearXNG selection
unless intentionally changing it, provide the separate final confirmation, and
then verify that only ownership-labeled companion resources changed, there are
no host-published ports, and n8n remains healthy. Do not treat a local Relmio
update as remote-upgrade authorization.

To roll back, restore the previously reviewed complete `tag@sha256` set through
the same locally updated Relmio build and separately confirmed managed update.
Repeat read-only discovery, exact-plan review, final confirmation, and the
post-update checks above. Never roll back by pulling a moving tag or by editing,
restarting, recreating, or otherwise mutating n8n.

## If n8n is upgraded

This project does not alter the n8n image. A normal n8n image update can still
change node behavior or Docker networks.

After an n8n upgrade:

1. Confirm n8n is healthy.
2. Confirm its network name still matches the sidecar network.
3. Retry the OpenAI credential.
4. Verify one simple OpenAI Chat Model prompt.

If the network name changed, rerun the wizard and select the new shared
network. Do not edit or rebuild n8n merely to repair the sidecar.

## VPS build state and operation-lock recovery

After final confirmation, builds can create temporary root-only mode-`0700`
Buildx client state at these reviewed paths:

- Model install/retry:
  `/docker/n8n-openai-oauth/.local-model-operation.lock/buildx`.
- SuperGrok install/sign-in/sign-out:
  `/docker/n8n-openai-oauth/.supergrok-operation.lock/buildx`.
- OpenAI bridge install/update:
  `/docker/n8n-openai-oauth/.openai-oauth-operation.lock/buildx`.

State is created lazily only for a build-capable call; an already-cached retry
needing no build, status and removal do not create it. Compose `up` is generated
with `--no-build`. SuperGrok credential-action `run` can still build, which is
why its reviewed sign-in/sign-out actions also need confinement.

Successful cleanup removes verified owned temporary state before releasing
the matching lock. If an SSH command or SFTP upload has started but its
completion cannot be confirmed (for example, the connection drops before a
verified exit status), the remote outcome is unknown. Relmio skips cleanup and
retains the operation lock and any Buildx state for administrator inspection,
even if a later SSH connection responds. A partial managed model file may
remain after an interrupted SFTP transfer. A verified nonzero exit is a known
failure and follows the ordinary reviewed cleanup path.

Every SSH command has a finite deadline: 45 minutes by default, 30 minutes for
an image build, 2 minutes for SIWC handoff acceptance, and 5 minutes for
publishing a managed file. A deadline closes that command and reports an
unknown remote outcome; Relmio does not retry it. SIWC managed files are
published through an exclusive temporary file and an atomic rename under
`/docker/n8n-openai-oauth`, never by truncating an existing file. If the
outcome of that publication is unknown, the temporary file may remain for
inspection.

A lost response while acquiring the lock also requires inspection rather than
assuming no lock exists. Do not treat the error as proof that the remote action
did not run, and do not automatically retry, remove the lock, or clear state.

Cleanup rejects symlinks, hard links, ownership, inode or mount ambiguity.
Interruption during cleanup or an uncertain cleanup result can leave the lock
and a partially cleaned state tree. If the main action also failed, that
original failure is preserved; do not assume every cleanup error means the
main action never ran.

Do **not** delete a lock blindly, recursively clear its directory, run Compose
`down`, prune Docker resources or clear model weights as an automatic repair.
An administrator must first establish that no operation still uses the lock,
inspect the exact recorded ownership and remaining state, and decide any
target-specific recovery separately. A similarly named or replaced tree is
not permission to remove it. Relmio's build-state cleanup never removes n8n
or model-cache data and does not copy, move or print registry credentials.

The managed OAuth bridge also owns a guarded `Dockerfile.dockerignore` that
allows only its Dockerfile and runtime source into the build context. A
preexisting unknown ignore file is a refusal, not an automatic overwrite.
Do not delete that file or include `auth`/sibling installations in the build
context to make a failed build proceed.

## Linux local-model acceptance harness

`dev/local-model-linux/harness.mjs` is an interactive maintainer tool for a
**separate disposable n8n fixture**, not an installer for your existing n8n.
Use a fresh dedicated checkout on a human-approved real Linux host with Node.js
24+, local rootful Docker Engine, Docker Compose 2.17+, the production model
resource budget and outbound image/model-registry access. It refuses Darwin,
remote Docker overrides/contexts and unsupported engines; it never starts
Docker Desktop or uses a production n8n instance.

### A. Ready-runtime recovery

Run from the repository root, **one command at a time**, reading the result and
any exact-target confirmation before continuing:

```sh
node dev/local-model-linux/harness.mjs preflight
node dev/local-model-linux/harness.mjs fixture
node dev/local-model-linux/harness.mjs review
node dev/local-model-linux/harness.mjs install
node dev/local-model-linux/harness.mjs wait
node dev/local-model-linux/harness.mjs reconnect
node dev/local-model-linux/harness.mjs workflow
node dev/local-model-linux/harness.mjs fault
node dev/local-model-linux/harness.mjs retry
node dev/local-model-linux/harness.mjs workflow
```

The fixture step creates its own n8n container/data volume and permits normal
n8n database initialization only after target-specific approval. The model
step uses the real production local-model service with `qwen3:0.6b`, isolated
Relmio home/state, a fresh installation ID and a private bridge with registry
egress. Nothing publishes a host port or mounts the Docker socket. The harness
does not request OAuth/API credentials or fabricate an n8n API key.

Resource review is not advertised as mutation-free: the production disk-space
probe runs a named read-only, no-network, no-mount helper and removes that
helper only after the exact **RUN-AND-REMOVE-READONLY-DISK-PROBE** approval.
Install, retry, the first workflow import and every workflow execution have
their own target-specific confirmations.

Each command is a fresh process. `reconnect` must reconstruct status without
repair/restart. The workflow imports and runs only a fixed Manual Trigger →
HTTP Request workflow in the disposable fixture through its documented n8n
CLI. It validates the actual Chat Completions result, not merely CLI exit
status. This CLI activity is a fixture-only exception: the managed installer
still never executes inside or changes your existing n8n.

The single `fault` stops only the owned model runtime after exact confirmation.
The following reviewed `retry` must preserve the cache file hashes, model
digest, cache-volume creation identity and runtime identity; it creates a new
acquisition operation. The second workflow demonstrates post-recovery
inference. Fixture n8n container/image/start/restart identities and its
network/data-volume identity must remain unchanged throughout. Cache
retention does not establish byte-offset download resumption.

### B. Interrupted cold download

Use a **different fresh checkout and fixture** from scenario A. Do not delete
an installed model merely to manufacture a cold cache:

```sh
node dev/local-model-linux/harness.mjs preflight
node dev/local-model-linux/harness.mjs fixture
node dev/local-model-linux/harness.mjs install-midpull
node dev/local-model-linux/harness.mjs reconnect
node dev/local-model-linux/harness.mjs retry
node dev/local-model-linux/harness.mjs workflow
```

`install-midpull` starts the real cold install, waits for observed positive
partial acquisition progress, and displays the exact runtime, operation and
cache identities for human approval. It rechecks that the download is still
partial after approval before stopping only that model runtime. If it
finishes too quickly or the stopped cache is already complete, the result is
**NOT-RUN**, not an interrupted-download success. Cache remains intact; there
is no automatic redownload or destructive retry to force the scenario.

The harness separately asks to create and start an exact owner-labelled,
no-network, read-only cache inspector. It requires real nonempty partial
blobs without a completed model manifest, records SHA-256 inventories, and
retains the inspector. Before the first production retry restarts the writer,
it asks again to start that inspector and requires the partial inventory and
cache/runtime identities to be unchanged. Production retry must then acquire
the catalog-approved model and pass the actual n8n workflow.

If the original partial-observation command was interrupted, the separate
`node dev/local-model-linux/harness.mjs interrupt-pull` command can reconnect
to that stage; it does not inject a second fault after a recorded interruption.
Do not use it to relabel ready-runtime recovery as a cold-download test.
Inspector lifecycle has no separate CLI command: its exact-target prompts
are part of `install-midpull`/`interrupt-pull`, `retry` and `remove-model`.

### Evidence and deliberate removal

Removal is **not automatic**. Only when you have reviewed the exact owned
targets and deliberately want to delete them, run these individually and
answer their separate interactive prompts:

```sh
node dev/local-model-linux/harness.mjs remove-model
node dev/local-model-linux/harness.mjs teardown
```

The first separately confirms/removes any retained cache inspector before
independently reviewing and deleting the attested model/cache. The second
deletes only the attested disposable fixture resources, including its n8n data.
Neither is an automatic recommendation to clean up a failed run.
Neither is a generic `docker compose down`, prune command, failure handler or cleanup trap.
There is no `--yes` or CI/environment approval bypass. Headless invocations
must hand off to a human TTY. Failure or interruption preserves resources and
evidence; an uncertain lock requires inspection, not automatic removal.

Owner-only evidence is recorded in
`dev/local-model-linux/.runtime/evidence.jsonl` with bounded output and file
size. It contains resource identities, progress and the fixed-prompt result;
review it before sharing. After approved teardown, evidence, owner marker,
isolated home and shared downloaded images intentionally remain. Use a
separate checkout for another cold run rather than deleting evidence or
reusing the marker as if the run were new.

Scenario A records `readyRuntimeRecoveryComplete`. Scenario B can record
`interruptedColdDownloadVerified:true` only after genuine partial observation,
retention before restart, reconnect, successful production retry/workflow and
separately approved removal. Its `byteOffsetResumeClaimed:false` is deliberate:
preserving partial bytes plus successful recovery does not measure resumed
network byte offsets. A failed/NOT-RUN scenario can be cleaned up after its own
approval but must not be reported as acceptance success.

**Evidence limits:** implementation-time checks observed CLI help, the
real-Linux preflight refusal on Darwin, injected guard/payload behavior and a
bounded cache-inventory process over synthetic local files. They did not run
a live Linux Docker model download, n8n workflow, interrupted pull,
SSH/provider deployment or Windows agent session. No hosted CI workflow
claims this proof: an early dispatch flag cannot approve resource identities
generated later. Full acceptance requires the separately authorized
interactive Linux runs and their recorded results.

## Roll back or disable the bridge

Stop and remove only the sidecar container:

```bash
docker compose \
  --project-name n8n-openai-oauth \
  --file /docker/n8n-openai-oauth/docker-compose.yml \
  down
```

The files and OAuth credential remain available for recovery. n8n remains
running.

In n8n, disable workflows that depend on the bridge or replace their OpenAI
credential.

## Recoverable uninstall

First run the sidecar-only `down` command above. Then move the project directory
to a dated backup:

```bash
mv /docker/n8n-openai-oauth \
  "/docker/n8n-openai-oauth.disabled-$(date +%Y%m%d-%H%M%S)"
```

This is recoverable: move the directory back if needed. After confirming the
backup is no longer required, remove it through your normal VPS backup and
retention process.

Finally, delete the unused n8n credential through the n8n interface. Never
delete or recreate the n8n container as part of this uninstall.

## Future official n8n support

As of July 28, 2026, an
[open n8n pull request](https://github.com/n8n-io/n8n/pull/29184) proposes
native OpenAI Account authentication for the OpenAI Chat Model. It is not yet
merged. If n8n later ships and documents an official equivalent, prefer the
official built-in route and retire this sidecar after testing migration.

# Refresh, upgrade, rollback, and uninstall

Every command on this page targets the separate
`n8n-openai-oauth` project. None targets the n8n project.

## Update an existing bridge runtime

Updating Relmio on your computer changes the wizard, but it does not replace a
bridge container that is already running. Use a Relmio release that contains
the compatibility update, then update the owned sidecar from the browser.

For a bridge beside local n8n:

1. Run `relmio open` and select **Refresh status**.
2. Select **OpenAI OAuth bridge**.
3. Choose **Manage bridge** and read the runtime update summary.
4. Select the confirmation checkbox, then choose **Update bridge runtime**.

This action does not require a new ChatGPT sign-in. It preserves the existing
OAuth credential, bridge identity, and selected Docker network. Relmio rebuilds
and verifies only its owned sidecar. Use **Apply sign-in to owned bridge** only
to copy a newer ChatGPT sign-in; it does not update the runtime.

For a bridge beside VPS n8n:

1. Run `relmio vps` and connect to the same VPS.
2. Compare and confirm the SSH host fingerprint.
3. Select the n8n container and Docker network.
4. Choose **OpenAI-OAuth/Codex bridge**, then select **Manage
   OpenAI-OAuth/Codex bridge**.
5. Choose **Review bridge update** and review the exact sidecar-only plan.
6. Select the confirmation checkbox, then choose **Update the bridge**.

The browser wizard performs the SSH update. You do not need a separate VPS
terminal. It uploads the current local ChatGPT sign-in to the bridge, stays
inside `/docker/n8n-openai-oauth`, publishes no host port, and does not edit,
stop, restart, rebuild, recreate, or change n8n.

## Refresh an expired ChatGPT login

The easiest method is to open the
[hosted install page](https://relmio.jpfusin.tech/install) and choose the local
terminal you already have. For macOS, Linux, WSL, or Git Bash:

```bash
curl -fsSL https://relmio.jpfusin.tech/install.sh | sh
```

For Windows PowerShell, with no Git Bash or preinstalled Node.js required:

```powershell
irm https://relmio.jpfusin.tech/install.ps1 | iex
```

1. Start the local wizard again.
2. Select **Refresh ChatGPT sign-in**.
3. Complete the newest browser sign-in page.
4. Confirm that the **Credential updated** time matches the fresh sign-in.
5. For a local bridge, select **OpenAI OAuth bridge**, choose **Manage bridge**,
   confirm the credential action, then choose **Apply sign-in to owned bridge**.
6. For a VPS bridge, follow the update sequence above. The update uploads the
   current local sign-in after you review and confirm the bridge-only plan.

The wizard replaces the sidecar credential and starts only the sidecar service.
On a local bridge this is a credential-only action; use **Update bridge runtime**
separately when needed. n8n is not restarted. The local credential is stored at
`~/.n8n-openai-oauth/auth.json`.

Manual POSIX-shell method:

```bash
install -d -m 0700 "$HOME/.n8n-openai-oauth"
npx --yes --ignore-scripts openai-oauth@2.0.0 login \
  --open \
  --login-timeout-ms 300000 \
  --oauth-file "$HOME/.n8n-openai-oauth/auth.json"
scp "$HOME/.n8n-openai-oauth/auth.json" \
  root@YOUR_VPS_IP:/docker/n8n-openai-oauth/auth/auth.json
```

Then on the VPS:

```bash
chown 1000:1000 /docker/n8n-openai-oauth/auth/auth.json
chmod 600 /docker/n8n-openai-oauth/auth/auth.json
docker compose \
  --project-name n8n-openai-oauth \
  --file /docker/n8n-openai-oauth/docker-compose.yml \
  up -d --wait --wait-timeout 60 --no-deps openai-oauth
```

## Restart only the sidecar

```bash
docker compose \
  --project-name n8n-openai-oauth \
  --file /docker/n8n-openai-oauth/docker-compose.yml \
  restart openai-oauth
```

This does not restart n8n.

## Safe source-code update

### Recheck OpenAI sources

Every Relmio update or upgrade must include a fresh review of OpenAI's current
[Sign in with ChatGPT article](https://help.openai.com/en/articles/20001410-sign-in-with-chatgpt),
plus the official [model and media capability documentation](https://developers.openai.com/api/docs/models),
[Codex authentication documentation](https://learn.chatgpt.com/docs/auth),
[Terms](https://openai.com/policies/terms-of-use/), and
[privacy policy](https://openai.com/policies/privacy-policy/) that apply to the
changed flow.

The Help Center article currently describes identity sign-in for supported
external applications. It says the external application receives name, email,
and profile picture, while additional access requires separate approval. It
also describes authentication, account, application, permission, technical,
and security information that OpenAI may collect. Do not assume this
identity-only flow describes Relmio's Codex credential bridge. Verify whether
the flow, client, and permissions match.

For each update:

1. Fetch the current official sources instead of relying on an earlier copy.
2. Compare the documented flow and scopes with the exact Relmio behavior.
3. Record what Relmio reads, stores, transmits, and logs, where the data goes,
   and what the user sees before approval.
4. Check identity sign-in, additional permission grants, and model or TTS
   capability separately.
5. Record the check date, source links, findings, and unresolved questions in
   the update evidence.

The article and a successful OAuth login do not prove blanket Terms compliance,
bridge permission, or model or TTS entitlement. Keep those conclusions limited
to direct, current evidence.

### Current 2026-09-08 bridge disclosure

The public Sign in with ChatGPT article describes identity sign-in for supported
external applications. It does not establish that this unofficial n8n bridge is
supported or that its credential grant authorizes a general Platform `/v1`
connection. The pinned `openai-oauth@2.0.0` runtime defaults to issuer
`https://auth.openai.com`, scopes `openid profile email offline_access`, and
the Codex backend `https://chatgpt.com/backend-api/codex`. Those are package
defaults, not evidence of the account's actual consent or granted scopes.

Relmio copies the complete credential JSON into a local private named Docker
volume through a network-disabled credential-seed helper, or uploads it by SFTP
to `auth/auth.json` under the VPS deployment's bind mount. The third-party
package reads that file and forwards eligible n8n content to its upstream
backend. Building the image contacts the npm registry for the pinned package.
The credential-seed helper disables Docker logging; the main sidecar does not
set a Docker log driver. Relmio does not set the package's opt-in
`CODEX_OPENAI_SERVER_LOG_REQUESTS=1` request-metadata logger. Provider-side
retention, main-sidecar/VPS logging, account entitlement, and policy eligibility
remain account-owner checks.

On the local computer:

```bash
git pull --ff-only
npm ci --ignore-scripts
npm test
npm start
```

Review release notes and the generated plan before approving another VPS
installation.

## Optional maintainer architecture map

Graphify is useful for long-term maintenance because it exposes the boundaries
between the local wizard, OAuth credential flow, SSH verification, sidecar
deployment, and n8n recipes. It is an optional maintainer tool, not a runtime
dependency:

```bash
graphify .
```

Keep the generated `graphify-out/` directory local. It is intentionally ignored
by Git and excluded from the npm package because raw graphs can reveal internal
file relationships, local paths, and unfinished implementation details. Put
only reviewed, redacted diagrams or plain-language architecture notes in the
public repository. Never include credentials, setup URLs, VPS addresses, or
private screenshots in a graph export.

## Updating the pinned bridge version

Do not change `openai-oauth@2.0.0` casually. An upgrade requires:

1. Read the upstream changelog and legal notes.
2. Inspect the package tarball and install scripts.
3. Update both the local login command and generated Dockerfile pin.
4. Run all tests and the fake-data browser flow.
5. Build the sidecar on a disposable VPS first.
6. Verify `/health`, `/v1/models`, `/v1/responses`, streaming, and tool calls.
7. Verify `docker compose port openai-oauth 10531` still returns no mapping.
8. Confirm n8n was not restarted.

Keep the old Docker image until the new one passes.

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

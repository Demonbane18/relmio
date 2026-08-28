# Refresh, upgrade, rollback, and uninstall

Every command on this page targets the separate
`n8n-openai-oauth` project. None targets the n8n project.

## Refresh an expired ChatGPT login

The easiest method is to open the
[hosted install page](https://relmio.vercel.app/install) and choose the local
terminal you already have. For macOS, Linux, WSL, or Git Bash:

```bash
curl -fsSL https://relmio.vercel.app/install.sh | sh
```

For Windows PowerShell, with no Git Bash or preinstalled Node.js required:

```powershell
irm https://relmio.vercel.app/install.ps1 | iex
```

1. Start the local wizard again.
2. Select **Refresh ChatGPT sign-in**.
3. Complete the newest browser sign-in page.
4. Confirm that the **Credential updated** time matches the fresh sign-in.
5. Connect to the same VPS and select the same n8n network.
6. Approve the sidecar plan.

The wizard replaces the sidecar credential and starts only the sidecar service.
n8n is not restarted. Its local credential is stored separately at
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

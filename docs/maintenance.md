# Refresh, upgrade, rollback, and uninstall

Every command on this page targets the separate
`n8n-openai-oauth` project. None targets the n8n project.

## Refresh an expired ChatGPT login

The easiest method:

1. Start the local wizard again.
2. Select **Refresh ChatGPT sign-in**.
3. Complete the newest browser sign-in page.
4. Connect to the same VPS and select the same n8n network.
5. Approve the sidecar plan.

The wizard replaces the sidecar credential and starts only the sidecar service.
n8n is not restarted. Its local credential is stored separately at
`~/.n8n-openai-oauth/auth.json`.

Manual method:

```bash
npx --yes openai-oauth@2.0.0 login --open --login-timeout-ms 300000
scp "$HOME/.codex/auth.json" root@YOUR_VPS_IP:/docker/n8n-openai-oauth/auth/auth.json
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

As of July 27, 2026, an
[open n8n pull request](https://github.com/n8n-io/n8n/pull/29184) proposes
native OpenAI Account authentication for the OpenAI Chat Model. It is not yet
merged. If n8n later ships and documents an official equivalent, prefer the
official built-in route and retire this sidecar after testing migration.

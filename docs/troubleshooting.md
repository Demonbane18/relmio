# Troubleshooting

Start with the exact symptom you see. Do not delete or rebuild n8n while
troubleshooting this sidecar.

## Quick checks

On the VPS:

```bash
docker compose \
  --project-name n8n-openai-oauth \
  --file /docker/n8n-openai-oauth/docker-compose.yml \
  ps
```

```bash
docker compose \
  --project-name n8n-openai-oauth \
  --file /docker/n8n-openai-oauth/docker-compose.yml \
  logs --tail=50 openai-oauth
```

## Symptom table

| Symptom | Meaning | Fix |
|---|---|---|
| `This sign-in request expired` | The OAuth tab is old or the five-minute callback window ended. | Close the old tab and start a fresh login from the wizard or `npx --yes openai-oauth@2.0.0 login --open`. |
| `zsh: no matches found: root@**...**` | The hidden-IP asterisks were copied literally. | Use the real IP with no asterisks: `root@YOUR_VPS_IP`. |
| SSH appears frozen while typing a password | Terminals intentionally show no password characters. | Type the password carefully and press Return. Do not test by typing random visible text. |
| SSH appears to do nothing | The IP may be incomplete, port 22 may be blocked, or SSH is waiting. | Copy the complete IP from Hostinger. Wait up to 15 seconds, then press Control+C and retry. |
| `No such file or directory` after local `chown` | A VPS path was used in the local Terminal. | SSH into the VPS first, then run `chown` there. |
| `No auth file was found at /home/node/.codex/auth.json` | The file is missing, copied to the wrong directory, or the parent directory blocks user `node`. | Verify the mount, owner, and modes using the commands below. |
| `unknown instruction: "--host"` | The Dockerfile `CMD` JSON was split across Dockerfile instructions. | Replace it with the exact one-line `CMD` from the manual guide. |
| n8n credential says it cannot connect with `127.0.0.1` | `127.0.0.1` inside n8n is the n8n container, not the sidecar. | Use `http://n8n-openai-oauth:10531/v1`. |
| Logs show `ENOENT` for `/home/node/.local` | An older wizard release used a read-only root filesystem without a writable app-data directory. | Update to the latest wizard and run the approved install again. It safely refreshes a wizard-managed sidecar. |
| Network command prints `proxy` | That is the network name, not an empty result. | Select or enter `proxy`. |
| Logs show repeated “No auth file” and later show “endpoint ready” | `docker compose logs` contains old and new entries. | Read the newest lines at the bottom. The final “endpoint ready” state wins. |
| n8n requires an API key | The n8n credential UI requires a non-empty value even though the bridge does not. | Enter `local-only`; it is a placeholder, not an OpenAI key. |
| Models do not appear in n8n | Credential test, network, auth, or model compatibility may be failing. | Verify `/v1/models` inside the sidecar, then retry the n8n credential. |
| Responses API request fails but models work | The n8n node or bridge version may be incompatible. | Confirm the project is pinned to `openai-oauth@2.0.0`. Try a basic `/v1/responses` request; use chat completions only as a compatibility fallback. |
| Wizard refuses the install directory | `/docker/n8n-openai-oauth` exists without the wizard marker. | Nothing was overwritten. Move the old directory to a backup name or finish the manual installation; do not delete it blindly. |

## Check the OAuth file safely

Do not run `cat` on the file. Check only its metadata:

```bash
ls -ldn /docker/n8n-openai-oauth/auth
ls -ln /docker/n8n-openai-oauth/auth/auth.json
```

Expected:

```text
auth directory: owner 1000, group 1000, mode drwx------
auth.json: owner 1000, group 1000, mode -rw-------
```

Fix on the VPS:

```bash
chown 1000:1000 /docker/n8n-openai-oauth/auth
chmod 700 /docker/n8n-openai-oauth/auth
chown 1000:1000 /docker/n8n-openai-oauth/auth/auth.json
chmod 600 /docker/n8n-openai-oauth/auth/auth.json
```

## Check the mount

```bash
docker inspect n8n-openai-oauth-openai-oauth-1 \
  --format '{{range .Mounts}}{{println .Source "->" .Destination}}{{end}}'
```

Expected:

```text
/docker/n8n-openai-oauth/auth -> /home/node/.codex
```

The generated container name can differ. Find it with:

```bash
docker compose \
  --project-name n8n-openai-oauth \
  --file /docker/n8n-openai-oauth/docker-compose.yml \
  ps
```

## Check the shared network

```bash
docker inspect n8n-n8n-1 \
  --format '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}'
```

```bash
docker inspect n8n-openai-oauth-openai-oauth-1 \
  --format '{{range $name, $_ := .NetworkSettings.Networks}}{{println $name}}{{end}}'
```

At least one name must match. For the Hostinger setup used during development,
that name was `proxy`.

## Check from n8n without installing curl

Do not modify the n8n image merely to add a diagnostic tool. Use Node if it is
available in the n8n container:

```bash
docker exec n8n-n8n-1 \
  node -e 'fetch("http://n8n-openai-oauth:10531/v1/models").then(async (response) => { console.log(response.status); console.log(await response.text()); }).catch((error) => { console.error(error.message); process.exit(1); })'
```

This is a read-only diagnostic request; it does not install anything or
restart n8n.

## Responses API setting

For the pinned bridge, leave **Use Responses API** on. Upstream supports both
`/v1/responses` and `/v1/chat/completions`. Turn it off only as a temporary
compatibility test if:

- `/v1/models` works;
- the node is definitely calling the correct Base URL; and
- the error specifically concerns `/v1/responses`.

If chat completions work but Responses does not, record the n8n version, node
version, bridge logs, and sanitized error before changing anything else.

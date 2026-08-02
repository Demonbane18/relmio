# Troubleshooting

Start with the exact symptom you see. Do not delete or rebuild n8n while
troubleshooting this sidecar. Do not remove an already working manual OAuth
sidecar until the wizard-managed endpoint has passed a real n8n request.

Always keep a current export or backup of your n8n workflows before using the
wizard or any manual VPS command. The documented commands are sidecar-only and
do not delete, restart, or rebuild n8n, but they still access your VPS and write
files there.

## Hosted chat browser extension

The hosted demo at [relmio.vercel.app](https://relmio.vercel.app/) needs the
open-source **Sign in with ChatGPT** extension to complete the OAuth handoff:

- [Install for Chrome](https://chromewebstore.google.com/detail/sign-in-with-chatgpt/odbgboachaefbbbdiffcefhpkekhfcna)
- [Install for Firefox](https://addons.mozilla.org/firefox/addon/sign-in-with-chatgpt/)

After installation, reload Relmio and select **Connect ChatGPT** again. If the
chat still shows **Not connected**, confirm the extension is enabled, close
stale ChatGPT authorization tabs, and start one fresh connection from Relmio.
The hosted sign-in component also displays its extension install screen when
it detects that the extension is missing.

This requirement applies to the hosted chat, not the local npm wizard. The
wizard listens directly on `localhost:1455`; if an OAuth extension captures
that local callback, temporarily disable it during local sign-in and re-enable
it after the wizard saves the credential.

## Confirm the local package first

Close every old wizard terminal and browser tab, then run the newest published
build on your own computer, not on the VPS. Choose the command for the terminal
you already have.

macOS, Linux, WSL, or Git Bash:

```bash
curl -fsSL https://relmio.vercel.app/install.sh | sh
```

Windows PowerShell:

```powershell
irm https://relmio.vercel.app/install.ps1 | iex
```

Windows Command Prompt:

```bat
powershell -NoProfile -ExecutionPolicy Bypass -Command "irm https://relmio.vercel.app/install.ps1 | iex"
```

These commands do not require Node.js to be installed. The Windows options do
not require Git Bash. Each bootstrap reuses Node.js 22 or newer when available,
or downloads an official temporary runtime and verifies its SHA-256 checksum
before execution.

If you choose the existing-Node fallback, confirm Node is version 22 or newer
and check the published package version first:

```bash
node --version
npm view relmio version
npx --yes --ignore-scripts relmio@latest
```

Keep the terminal open. If the browser does not open automatically, copy the
newest printed `http://127.0.0.1:...` URL into the browser. That URL contains a
temporary setup token: do not post it in an issue or screenshot.

You do not need to sign in to npm, configure npm 2FA, or own this package to
run any public command. npm authentication is required only for the
maintainer who publishes a release.

## Quick VPS checks

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

Check whether Docker published the sidecar port:

```bash
docker compose \
  --project-name n8n-openai-oauth \
  --file /docker/n8n-openai-oauth/docker-compose.yml \
  port openai-oauth 10531
```

Success is no output. `10531/tcp` shown in `docker ps` without a host address
is only an internal container port. A value such as `0.0.0.0:10531` or
`127.0.0.1:10531` is a real host mapping and must be investigated rather than
bypassed.

## Symptom table

| Symptom | Meaning | Fix |
|---|---|---|
| `node: command not found`, `node is not recognized`, or Node is older than 22 | The NPX fallback cannot use the local runtime. | Use the macOS/Linux curl command or the native Windows PowerShell/Command Prompt command above. Either can run with a verified temporary runtime. Do not install Node.js on the VPS for the wizard. |
| `curl` or `sh` is not recognized on Windows | The macOS/Linux command was pasted into a native Windows terminal. | Use the PowerShell command in PowerShell, or the longer `powershell -NoProfile ...` command in Command Prompt. Git Bash is not required. |
| A bootstrap reports a checksum mismatch | The Node.js download did not match the official SHA-256 manifest, so it was not executed. | Retry on a trusted connection. Do not bypass the check. If it repeats, use an existing Node.js 22+ installation and report the sanitized error. |
| Windows reports `spawn EINVAL` when starting ChatGPT sign-in | An older wizard tried to execute `npx.cmd` directly; Windows requires the current Node runtime to launch npm's JavaScript CLI. | Update to the latest `relmio@latest` release and restart the setup command. The current wizard keeps the macOS/Linux/WSL/Git Bash `npx` path unchanged. |
| The browser did not open | The automatic browser launch failed, but the local server may still be running. | Keep the newest terminal open and copy its newest `127.0.0.1` setup URL into the browser. Do not reuse a URL from a closed terminal. |
| The wizard says `This wizard link is incomplete` | The page was refreshed or opened without the private `?session=...` token; the token is removed from the address bar after startup. | Close the tab and open the complete `Local wizard:` URL printed by the active setup terminal. Do not reuse a URL from a closed terminal. |
| An old wizard page reports an invalid or expired setup session | The local server was closed or a newer wizard run created a different one-time session token. | Close the old page and use only the URL printed by the currently running terminal. |
| `npx` appears to run an older wizard | An old terminal or tab is still active, or the package was run without an explicit tag. | Close old runs, check `npm view relmio version`, then run `npx --yes --ignore-scripts relmio@latest`. |
| `This sign-in request expired` | The OAuth tab is old or the five-minute callback window ended. | Close the old tab and select **Refresh ChatGPT sign-in** from the newest active wizard. |
| An **OpenAI OAuth** extension page says the sign-in request expired | A browser extension intercepted the `localhost:1455` callback that belongs to the wizard's fresh login. | Temporarily disable the **Sign in with ChatGPT** or **OpenAI OAuth** extension, then select **Refresh ChatGPT sign-in** in the wizard. Re-enable the extension afterward if you still use it elsewhere. |
| `ChatGPT sign-in did not finish` appears immediately when refreshing an existing credential | Wizard versions through `0.1.3` attempted to reuse `~/.codex/auth.json`, but the bridge CLI requires an interactive terminal before replacing that file. | Update to `0.1.4` or newer. The wizard signs in through its own new credential file and leaves the Codex app credential untouched. |
| The wizard keeps showing `Waiting for browser sign-in` after approval | Older versions waited for the OAuth helper process to close even after its credential file was ready. | Update to `0.1.5` or newer. Confirm the new **Credential updated** time appears before continuing. |
| **Credential updated** still shows the old time | The callback reached an old/expired tab, was intercepted, or a different wizard session is open. | Close every old OAuth and wizard tab. Keep one current wizard open, select **Refresh ChatGPT sign-in**, and complete only the newly opened page. |
| The fresh login cannot bind `localhost:1455` or reports the address is in use | Another OAuth helper or extension process already owns the local callback port. | Close other OAuth login tools and stale wizard processes, then retry. On macOS/Linux, inspect without killing anything using `lsof -nP -iTCP:1455 -sTCP:LISTEN`. |
| `SSH connection failed. Check the address, password, firewall, and confirmed fingerprint.` | The TCP connection, password authentication, or confirmed host identity did not succeed. | Copy the full address and port from the provider, confirm root password login is enabled, check the provider firewall, rescan and compare the fingerprint, then test `ssh -p 22 root@YOUR_VPS_IP` from the same computer. |
| The VPS accepts only an SSH key or passkey | The current wizard supports live password authentication, not SSH keys. | Use the manual installation path or a provider-approved password-authenticated administrator account. Do not weaken SSH security or upload a private key into the wizard. |
| The SSH fingerprint changed | The server was rebuilt, its host keys changed, or the connection may be reaching a different host. | Stop. Verify the address and the new fingerprint through the VPS provider console before confirming it. Never bypass the comparison. |
| The wizard cannot find n8n | No running container matches the supported n8n image discovery. | Run `docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}'` on the VPS. Start or repair n8n through its own deployment process; do not make the wizard recreate it. |
| No shared Docker network is listed | n8n is not attached to a usable user-defined network. | Inspect n8n's networks and choose one the sidecar can join. Do not publish port `10531` as a workaround. |
| Safety check says the sidecar published a host port even though Docker shows only `10531/tcp` | Older checks could interpret Docker Compose's internal-only `PublishedPort: 0` marker as a host binding. | Update to `0.1.4` or newer. The wizard now reads the full publisher metadata and still rejects any real host binding. |
| Safety check reports a real host binding such as `0.0.0.0:10531` | A manual or altered Compose configuration published the port. The latest wizard attempts to stop and remove only its sidecar project before reporting the failure. | Do not bypass the safety check. Confirm the sidecar project is down with the commands above, remove the `ports:` mapping from that sidecar only, and redeploy it without touching n8n. If cleanup could not be confirmed, stop and inspect `/docker/n8n-openai-oauth` before retrying. |
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
| n8n reports `ECONNREFUSED`, `ENOTFOUND`, or “Couldn’t connect” | The Base URL is wrong, the sidecar is unhealthy, or n8n and the sidecar do not share a network. | Use exactly `http://n8n-openai-oauth:10531/v1`, inspect both container networks, and check the sidecar health/logs. |
| Models do not appear in n8n | Credential test, network, auth, or model compatibility may be failing. | Verify `/v1/models` inside the sidecar, then retry the n8n credential. |
| Responses API request fails but models work | The n8n node or bridge version may be incompatible. | Confirm the project is pinned to `openai-oauth@2.0.0`. Try a basic `/v1/responses` request; use chat completions only as a compatibility fallback. |
| Wizard refuses the install directory | `/docker/n8n-openai-oauth` exists without the wizard marker. | Nothing was overwritten. Move the old directory to a backup name or finish the manual installation; do not delete it blindly. |
| A manually created `openai-oauth` container already works | It usually does not block the wizard because the wizard uses a separate project, directory, and collision-resistant hostname. | Keep the working deployment until the new endpoint passes a test. If an exact directory, project, container, or network alias collides, move or rename only the old sidecar after backing it up; never remove n8n. |

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

On OpenAI Chat Model node version 1.3, leave **Use Responses API** on. Earlier
node versions do not show that switch and use Chat Completions by default.
Upstream supports both `/v1/responses` and `/v1/chat/completions`. Turn the
switch off only as a temporary compatibility test if:

- `/v1/models` works;
- the node is definitely calling the correct Base URL; and
- the error specifically concerns `/v1/responses`.

If chat completions work but Responses does not, record the n8n version, node
version, bridge logs, and sanitized error before changing anything else.

# Troubleshooting

Start with the symptom you see. Do not delete or rebuild n8n while you check
the sidecar. Keep a working manual OAuth sidecar until the wizard-managed
endpoint passes a real n8n request.

Always keep a current export or backup of your n8n workflows before using the
wizard or any manual VPS command. The documented commands are sidecar-only and
do not delete, restart, or rebuild n8n, but they still access your VPS and write
files there.

## Docker is not running

Start Docker Desktop or Docker Engine and wait until `docker info` and
`docker compose version` both succeed. Close any stale Relmio wizard tab, start
one fresh wizard session, and review the local plan again. Do not restart or
rebuild unrelated containers while checking the local endpoint.

## Authentication fails

Close stale wizard and device-code tabs, then run `relmio open` from a
persistent install to open the active private dashboard page. A hosted
foreground launcher instead requires its current terminal; press Enter there
to create a fresh private browser handoff. Start one fresh ChatGPT device-code
attempt and complete the newest code. Use the selected provider's official
sign-in. The ChatGPT n8n OAuth bridge does not use a Platform API key;
configure API-key connections and operator-generated hosting artifacts
separately in n8n or the target platform. Grok Build sign-in uses its official
attended CLI flow.

ChatGPT/Codex sign-in tokens expire. The Codex authentication guide describes
automatic refresh but does not give a fixed lifetime. Relmio's private bridge
and hosted chat demo each refresh their own credential copies. OpenAI's one-hour
access-token and rotating 30-day refresh-token lifetimes describe the separate
Sign in with ChatGPT plan-usage flow, not Relmio's pinned Codex flow. If Relmio
reports that a credential is invalid or refresh no longer succeeds, select
**Refresh ChatGPT sign-in** in the active local wizard. Without a saved
credential, the same button reads **Sign in with ChatGPT**.

## Local image build failed

The local wizard intentionally does not show Docker build output, filesystem
paths, or stderr in the browser. Confirm Docker Desktop or Docker Engine is
running, check that the local disk has room for the image, and confirm your
network can reach the image registry. Then close the old wizard, start one new
wizard session, review a fresh plan, and retry. Do not delete an existing
managed endpoint or rebuild unrelated containers as a workaround.

## Hosted chat browser extension

The hosted demo at [relmio.jpfusin.tech/chat](https://relmio.jpfusin.tech/chat) needs the
open-source **Sign in with ChatGPT** extension to complete the OAuth handoff:

- [Install for Chrome](https://chromewebstore.google.com/detail/sign-in-with-chatgpt/odbgboachaefbbbdiffcefhpkekhfcna)
- [Install for Firefox](https://addons.mozilla.org/firefox/addon/sign-in-with-chatgpt/)

After installation, reload Relmio and select **Sign in with ChatGPT** again. If the
chat still shows **Not connected**, confirm the extension is enabled, close
stale ChatGPT authorization tabs, and start one fresh connection from Relmio.
The hosted sign-in component also displays its extension install screen when
it detects that the extension is missing.

This requirement applies to the hosted chat, not the local npm wizard. The
local sign-in is launched by the official Codex CLI in the system browser; the
local wizard does not construct or display an authorization URL. Do not
disable browser or security extensions based only on a sign-in error.

## Confirm the local package first

Close every old wizard terminal and browser tab, then run the newest published
build on your own computer, not on the VPS. Choose the command for the terminal
you already have.

macOS, Linux, WSL, or Git Bash:

```bash
curl -fsSL https://relmio.jpfusin.tech/install.sh | sh
```

Homebrew (macOS or Linux):

```bash
brew tap Demonbane18/relmio && brew trust --formula Demonbane18/relmio/relmio && brew install relmio
```

Windows PowerShell:

```powershell
irm https://relmio.jpfusin.tech/install.ps1 | iex
```

Windows Command Prompt:

```bat
for /f "delims=" %F in ("%TEMP%\relmio-install-%RANDOM%-%RANDOM%-%RANDOM%.cmd") do @if exist "%~F" (exit /b 80) else curl -fsSL --remove-on-error https://relmio.jpfusin.tech/install.cmd -o "%~F" && set "RELMIO_SELF_DELETE=%~F" && call "%~F"
```

These commands do not require Node.js to be installed. The native Windows
options do not require Git Bash and reuse Node.js 24 or newer when available.
Git Bash always uses a verified temporary runtime through its bundled `winpty`
bridge so the native Node child receives terminal handles. Every portable path
shows staged **Please wait** messages while it downloads, verifies, and extracts
the official runtime. The Command Prompt bootstrap itself does not call
PowerShell, request elevation, or change Windows security policy.

After either Windows bootstrap starts Relmio, the running wizard uses the inbox
Windows PowerShell security API to apply and verify owner-only NTFS protection
before writing local credentials. Every native Windows launcher shares this
check. If an organization blocks the inbox tool or its security API, setup stops
before saving secrets; changing launch commands does not bypass the check.
macOS and Linux protect the same managed paths with POSIX permissions instead.

Homebrew is available from the public `Demonbane18/relmio` tap. Homebrew's
[Tap Trust](https://docs.brew.sh/Tap-Trust) model requires an explicit trust
decision for third-party formulae; this command scopes that decision to
`Demonbane18/relmio/relmio` only. It does not trust the whole tap or disable a
global safety control. The WinGet command stays hidden until Microsoft accepts
its catalog pull request and the catalog updates. Until then, use Homebrew or
one of the direct bootstrap commands on this page.

If you choose the existing-Node fallback, confirm Node is version 24 or newer
and check the published package version first:

```bash
node --version
npm view relmio version
npx --yes --ignore-scripts relmio@latest
```

Homebrew and direct npm or NPX runs use the persistent dashboard. After a
Homebrew or global npm install, run `relmio status` and `relmio open`. Without
a global install, use the full NPX lifecycle commands:

```bash
npx --yes --ignore-scripts relmio@latest status
npx --yes --ignore-scripts relmio@latest open
npx --yes --ignore-scripts relmio@latest stop
```

The hosted curl, PowerShell, and Command Prompt launchers run in the
foreground. Keep that terminal open. If the first browser launch fails, press
Enter there to create a fresh owner-only, single-use browser handoff. Relmio
does not print or pass the dashboard session capability in a browser URL.

Relmio opens local ChatGPT/Codex sign-in in the system browser. If no window
opens, check the Windows default browser, select **Stop** in the active wizard,
then retry. The current login flow does not provide a manual authorization link.

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
| `node: command not found`, `node is not recognized`, or Node is older than 24 | The NPX fallback cannot use the local runtime. | Use the macOS/Linux curl command or the native Windows PowerShell/Command Prompt command above. Either can run with a verified temporary runtime. Do not install Node.js on the VPS for the wizard. |
| `curl` or `sh` is not recognized on Windows | The macOS/Linux command was pasted into a native Windows terminal. | Use the PowerShell command in PowerShell or the collision-safe temporary-file command shown above in Command Prompt. Git Bash is not required. If Command Prompt does not have `curl`, update Windows or use the PowerShell route. |
| Git Bash reports that stdin or stdout is not a TTY | Direct NPX on older Git Bash can pass mintty pipes to native Node.js. | Use `curl -fsSL https://relmio.jpfusin.tech/install.sh \| sh`; the hosted launcher uses the bundled `winpty` bridge. For direct NPX on Git Bash 2.38.1 only, prefix the process with `MSYS=enable_pcon`. Do not add a global Git setting. |
| Windows cannot locate its built-in security tool or apply owner-only protection | The bootstrap may have started successfully, but the running wizard could not use the inbox Windows PowerShell security API to protect and verify its local files. | Setup stops before saving secrets. Ask the Windows administrator to allow the inbox security API, then retry. PowerShell, Command Prompt, `npx`, and other Windows launch methods all use this same check and do not bypass it. |
| The bootstrap stays on a `Please wait` stage | Node.js is missing or older than 24, so the bootstrap is downloading, checking, or extracting a temporary Node.js 24 runtime. | Keep the terminal open while the deterministic stage messages advance. The runtime is verified before it runs, is removed after the wizard exits, and is not installed system-wide. |
| A bootstrap reports a checksum mismatch | The Node.js download did not match its reviewed official SHA-256 checksum, so it was not executed. | Retry on a trusted connection. Do not bypass the check. If it repeats, use an existing Node.js 24+ installation and report the sanitized error. |
| Windows PowerShell shows `[eval]:1` before the wizard starts | An older bootstrap passed a JavaScript expression through `node -p`; PowerShell native-argument handling can alter that expression. | Update to the latest `relmio@latest` and rerun the same PowerShell or Command Prompt command. The current bootstrap parses the literal `node --version` output and reuses Node.js 24 or newer. |
| Windows reports `spawn EINVAL` when starting ChatGPT sign-in | An older wizard tried to execute `npx.cmd` directly; Windows requires the current Node runtime to launch npm's JavaScript CLI. | Update to the latest `relmio@latest` release and restart the setup command. The current wizard keeps the macOS/Linux/WSL/Git Bash `npx` path unchanged. |
| The Windows package launcher reports `Relmio installation paths are too long` before the wizard opens | Its fixed `MAX_PATH`-sized buffers cannot represent the installed runtime or CLI path. This limitation is specific to that launcher and does not establish general Windows long-path support. | Use the PowerShell or Command Prompt bootstrap above, which runs a verified temporary runtime. Do not change the Windows long-path registry setting as a workaround. |
| A local n8n action says it completed but Relmio could not release its operation lock | The owned Docker action finished, but the private local lifecycle lock could not be cleaned up safely. Relmio leaves the lock or its quarantine evidence instead of guessing. | Close and restart Relmio before another local n8n stack install/removal, then reopen the wizard and verify the detected owned stack. Do not manually delete lock or Docker resources. |
| A bridge refresh says it could not freeze the owned sidecar or prove a quiesce snapshot | The Docker Linux-container freezer is unavailable, the exact owned container changed, or the credential writer was caught with an incomplete file. Relmio does not fall back to `docker stop`, promote a stale snapshot, or touch n8n. | Keep the evidence in place. On Docker Desktop, confirm the `desktop-linux` engine is running, wait for the existing sidecar writer to finish, reopen the current wizard, and retry once. If Relmio says the exact sidecar state was preserved for inspection, inspect that owned project before retrying; do not delete journal files manually. |
| The local n8n + ngrok stack is shown as **stopped** | Relmio attested the complete owned container, network, and volume set, and found the runtime containers stopped. | Select **Resume owned stack**. It starts only the existing owned containers; it never recreates services, deletes the n8n volume, or changes the generated configuration. |
| The wizard reports a **partial** local n8n + ngrok stack | An ownership-attested stack is incomplete, mixed, or unhealthy. It is not safe to start it as though it were complete. | Use only the separate removal recovery after exporting any needed n8n data. Do not use Docker commands against a guessed project name. |
| The wizard says local n8n stack status is unavailable | Relmio could not safely verify the marker, Docker context, ownership labels, or runtime state. | No resume or removal control is offered. Reopen the current wizard after Docker is stable; do not bypass the check with manual edits to Relmio-managed files. |
| A new local n8n + ngrok attempt asks for the credentials again | Docker startup failed, but Relmio re-attested cleanup and proved no owned resources remain. This is commonly an ngrok hostname that is not reserved for the account or an inactive/incorrect agent authtoken. | Confirm the hostname in ngrok Domains, copy only one active value from **Your Authtoken** or **Settings → Authtokens**, then re-enter the Basic Auth username and password. Relmio intentionally clears all three fields before retrying. |
| An AI client's n8n MCP tool (for example n8n-mcp) reports `Transport closed` after creating or reading a workflow | The connection between your AI client and its MCP server ended. Relmio does not install, proxy, or configure MCP servers. Creating or saving an n8n workflow does not call the Relmio model endpoint or run any Relmio Docker action. The error alone does not show that n8n or the Relmio endpoint failed. | Reconnect or restart the MCP server from your AI client and check that server's own logs. For HTTP transport, also check its health and `/mcp` endpoints and any reverse-proxy timeout. Do not restart n8n or the Relmio sidecar as a first step. After the MCP tool responds again, re-read the workflow, then test the model with the fixed prompt in [Configure n8n nodes](n8n-configuration.md). If the wizard shows the Relmio-managed local n8n + ngrok stack as **stopped**, select **Resume owned stack**. |
| n8n reports `ECONNREFUSED` or `ENOTFOUND` for `n8n-local-model` | The model endpoint is private to the selected Docker network; a running container alone also does not prove that a model passed its inference check. | Use exactly `http://n8n-local-model:11434/v1` and confirm n8n and the model share the selected network and the model status is ready. Do not use `localhost` or publish a host port. The API has no authentication, and the n8n API-key field is ignored; trust every container on that network. |
| A local model download failed, was interrupted, or remains not ready | Partial data may remain in the owned cache and use disk. Retry preserves the cache but does not guarantee an interrupted transfer resumes from its previous byte. The model is not ready until its reviewed manifest digest, quantization, acquisition, and inference checks pass. | From the local dashboard choose **Review model retry**, or on the dedicated VPS model page choose **Review retry**, when offered. Do not clear cached weights as a retry step; deleting them requires separate reviewed confirmation. If VPS ownership or an operation lock is ambiguous, stop and inspect rather than removing lock files or starting another writer. |
| A model identity or quantization check fails | The registry's mutable model tag no longer matches the catalog's reviewed full manifest digest or quantization. The downloaded content is rejected before inference and never reported ready. | Do not pull an alternate tag, bypass the identity check, or assume changing the tag updates the approved catalog. Keep the sanitized failure details and use only a later reviewed catalog/update path. Cache deletion remains a separate reviewed action. |
| Local model setup is run without internet access | Disabling Ollama cloud features does not make setup offline; Docker must fetch the runtime image and Ollama must download the selected model. | Restore access to the required image/model registries before retrying. Do not add a provider key or enable a cloud fallback. |
| Docker Desktop shows a WSL error `0x800705aa`, or Relmio says the WSL engine could not start | Docker Desktop was idle and tried to start its Linux VM; Windows did not have enough free memory or Hyper-V resources. Relmio did not change n8n. | Close memory-heavy apps, run `wsl --shutdown`, start Docker Desktop, wait until `docker info` works, then retry the same reviewed plan. Do not delete Relmio-managed files by hand. |
| The browser did not open | The automatic private handoff failed, but the local server may still be running. | With a persistent install, run `relmio status`, then `relmio open`. With a hosted foreground launcher, keep its terminal open and press Enter to create a fresh handoff. |
| The wizard says `This wizard link is incomplete` | The clean dashboard address was opened in a new tab or bookmark without the current tab-only session. | Close the tab and run `relmio open` for a persistent install. For a hosted foreground launcher, return to its active terminal and press Enter. |
| `relmio status` says another Relmio version is running | An older compatible dashboard daemon is still serving its version-bound UI after a package upgrade. Relmio will not silently reuse it. | Run `relmio stop`, then `relmio start` and `relmio open`. For NPX, repeat the full `npx --yes --ignore-scripts relmio@latest` command before each action. Do not delete `.relmio/control` manually if Relmio reports malformed or incompatible state. |
| An old wizard page reports an invalid or expired setup session | The local server was closed or a newer wizard run created a different private session. | Close the old page and run `relmio open`, or return to the active hosted foreground terminal and press Enter. |
| `npx` appears to run an older wizard | An old terminal or tab is still active, or the package was run without an explicit tag. | Close old runs, check `npm view relmio version`, then run `npx --yes --ignore-scripts relmio@latest`. |
| A white `about:blank` tab remains after selecting **Sign in with ChatGPT** | Older local wizard versions opened a blank tab and navigated it to a validated manual link. The current wizard instead asks the official Codex CLI to open the sign-in in the system browser; it does not construct or display an authorization URL. | Update to the latest `relmio@latest` and close the stranded tab. If an attempt is already pending, finish it in its existing sign-in window. For a fresh attempt, check that a default browser is available; if none opens, use **Stop ChatGPT sign-in** and try again. |
| The sign-in page says `This sign-in request expired` | The current sign-in did not finish before its browser request expired, or an old sign-in page was used. | Close obsolete sign-in tabs and start a fresh attempt from the current wizard. Do not copy or share a callback URL or its query string. |
| An **OpenAI OAuth** page says **Signed in to ChatGPT** and `This sign-in request expired. Start again from the app.` | The wording alone does not identify which application showed the page or prove that another process received a callback. A localhost listener could interfere, but the pinned Codex CLI can retry and use a fallback callback port; the actual recipient in the reported case was not observed. The page can also be stale or belong to another sign-in attempt. | Close stale sign-in tabs and start a fresh attempt from the current wizard. If investigating a port conflict, inspect listeners without stopping processes: on macOS/Linux run `lsof -nP -iTCP:1455 -iTCP:1457 -sTCP:LISTEN`; on Windows PowerShell run `Get-NetTCPConnection -LocalPort 1455,1457 -State Listen \| Select-Object LocalAddress,LocalPort,OwningProcess`. Do not disable extensions or kill a process based only on this page. Never share callback query strings, authorization codes, `state` values, tokens, or full authentication URLs. |
| `ChatGPT sign-in did not finish` appears immediately when refreshing an existing credential | Wizard versions through `0.1.3` attempted to reuse `~/.codex/auth.json`, but the bridge CLI requires an interactive terminal before replacing that file. | Update to `0.1.4` or newer. The wizard signs in through its own new credential file and leaves the Codex app credential untouched. |
| The wizard keeps showing `Waiting for browser sign-in` after approval | Older versions waited for the OAuth helper process to close even after its credential file was ready. | Update to `0.1.5` or newer. Confirm the new **Credential updated** time appears before continuing. |
| **Credential updated** still shows the old time | The current attempt has not been confirmed as complete; the time alone cannot identify whether the page was stale or another process interfered. | Keep one current wizard open, close obsolete sign-in tabs, and start a fresh attempt from the wizard. Do not share its callback URL, query string, authorization code, `state` value, or token. |
| The wizard says `ChatGPT sign-in could not verify its local callback port. Check local security or network settings, then retry.` | Relmio could not determine whether the local callback port is free; this is not evidence that another application owns it. | Check that local security or network software permits localhost connections, then retry. Do not disable a firewall or security product as a workaround. If an organization manages those settings, ask its administrator to review them. |
| The fresh login cannot bind `localhost:1455`, reports the address is in use, or shows the callback-port conflict message | A connection to the default callback port was accepted, but that does not identify the listener or prove that it received the browser callback. Pinned Codex can retry and fall back to port `1457`. | Use **Stop ChatGPT sign-in** before trying again. Inspect listeners without stopping anything: on macOS/Linux run `lsof -nP -iTCP:1455 -iTCP:1457 -sTCP:LISTEN`; on Windows PowerShell run `Get-NetTCPConnection -LocalPort 1455,1457 -State Listen \| Select-Object LocalAddress,LocalPort,OwningProcess`. Close a ChatGPT or Codex app only if you recognize it and can close it normally; do not disable extensions or kill unfamiliar processes. |
| The wizard says `ChatGPT sign-in could not be stopped safely. Close the sign-in helper, then restart Relmio.` | Relmio could not confirm that the original sign-in process closed after cancellation. This does not prove that every descendant process or callback listener has exited, so the wizard blocks another attempt. | Close the sign-in helper only if you can identify it as the one started by this attempt, then restart Relmio. If you cannot identify it safely, leave other processes alone and ask an administrator for help. Do not share callback query strings, authorization codes, `state` values, tokens, or full authentication URLs. |
| SSH connection or administrative preflight fails | Reachability, the confirmed host key, selected account/authentication, or the required administrative context did not pass. | Verify host/port from the machine running Relmio and compare the host fingerprint independently. Check the actual image username and selected method. Keep SSH policy unchanged; do not enable root/password login, bypass host-key checks, or expose Docker as a workaround. |
| The VPS accepts only an SSH key or passkey | Relmio uses a supported local agent, not browser key upload or a provider browser-console session. | Select **Local SSH agent**, load/unlock the existing key in the local agent, and launch Relmio from that environment. Hardware-key or passkey support depends on that agent and its required interaction; no universal compatibility is promised. See [agent setup](hosting-compatibility.md#ssh-agent-and-administrative-access). |
| **Local SSH agent** is unavailable, untested, or authenticates in a terminal but not Relmio | A configured endpoint does not prove a loaded accepted identity. The dashboard may have an old environment; terminal SSH config/jump-host behavior is not automatically used. | Check the agent locally without sharing key listings. If its socket/environment changed, finish active operations, then restart only the Relmio dashboard from the agent-enabled environment. Windows native OpenSSH and WSL have separate agent contexts. Do not paste private-key data into a password field. |
| SSH succeeds but **Passwordless sudo -n (model only)** fails | This account's current policy does not permit the exact noninteractive administrative command context, or Docker/Compose/protected-directory prerequisites fail there. Sudo-group membership is not proof. | Have the administrator inspect the named prerequisite separately. Relmio does not collect a sudo password, edit sudoers, add groups or retry as root. Verify real rootful Docker Engine and Compose in that context, not a user-only plugin, rootless daemon or Podman shim. |
| Docker works but SSH preparation rejects its context or builder selection | The existing context must already be `default` at `unix:///var/run/docker.sock`; built-in default builder selection must be unambiguous and not shadowed by a saved named instance. A running builder is not required. | Have the administrator review the context and protected selector metadata separately, including inherited `BUILDX_BUILDER`, `BUILDX_CONFIG`, `BUILDKIT_HOST`, `DOCKER_CONFIG` or `COMPOSE_BAKE` overrides. Do not paste config/selector files into support messages, remove selections blindly, or use `buildx inspect` assuming it is harmless: it can write state and expose secrets. Relmio does not switch contexts or repair the host. |
| Local model setup rejects Docker builder selection | The local attestor accepts a canonical `current` record with an empty `Name` without interpreting its `Key`; a named `default` must match the reviewed local Docker host. Malformed/noncanonical records, other nonempty names, an unsafe reviewed-host fallback, or an `instances/default` shadow still fail closed. | Do not clear or rewrite saved selectors, switch contexts, or use `buildx inspect`. If setup leaves a managed partial installation, inspect status and choose **Review model retry** only after reviewing the fresh plan; retry retains owned state and re-attests the selection. |
| SSH preparation rejects `DOCKER_BUILDKIT`, required Linux tools or mount information | The guard does not permit classic-builder fallback and needs filesystem ownership/link/mount checks in the selected administrative context. | `DOCKER_BUILDKIT` may be unset, empty or `1`, not `0` or another nonempty value. Ask the administrator to inspect required GNU upload tools, `find`/`awk`/directory tools and readable `/proc/self/mountinfo`; do not bypass the guard or change unrelated host policy automatically. |
| A VPS build leaves an operation lock or reports uncertain build-state cleanup | The confirmed action may have created temporary `buildx` state inside its owned model, SuperGrok or OpenAI operation lock. Interrupted or ambiguous cleanup can retain the lock and a partial tree; the main action may already have run. | Stop and inspect the exact owned operation with the administrator. Do not recursively delete locks, prune Docker, run Compose `down` or clear model weights as automatic recovery. Follow [operation-lock recovery](maintenance.md#vps-build-state-and-operation-lock-recovery); build-state cleanup never removes n8n or model-cache data. |
| The OpenAI bridge refuses an existing `Dockerfile.dockerignore` | The managed bridge accepts only an absent file or its exact safe owned build-context allowlist. An unknown existing file must not be overwritten. | Have the administrator inspect that file and ownership separately. Do not delete it blindly or include credential/sibling/state directories in the build context as a workaround. |
| An OAuth bridge, Assistant or SuperGrok VPS action says the SSH session is model-only | Noninteractive sudo deliberately excludes credential-bearing VPS operations because administrator sudo I/O recording may capture stdin. | Continue model management, or disconnect and use a separately approved direct-root session for the other flow. Do not enable root SSH just for Relmio. Agent authentication does not remove this privilege boundary. |
| The `/docker` prerequisite fails | The administrator-managed parent is absent, symlinked, not root-owned, or group/other writable. Relmio only manages its reviewed subtree. | Ask the administrator to inspect and prepare the intended parent separately. Do not recursively loosen permissions, stage files in `/tmp`, or expect Relmio to create `/docker`. Existing n8n must remain unchanged. |
| A model network is rejected as unprotected or unsupported | An active IP family uses `nat-unprotected`, an unknown/isolated mode, or another required existing-bridge property is missing. | Select an already eligible trusted user-defined bridge attached to n8n, if available. Default/NAT and filtered `routed` modes are not rejected merely for direct routing. Do not change n8n's network or publish `11434`/`10531` to bypass the boundary. |
| The local/VPS model reports an unsafe or incomplete owned-container attestation although its Docker security option is enabled | Relmio accepts Docker's bare, `:true`, and `=true` enabled spellings, while still rejecting missing, disabled, malformed, or conflicting values. It also accepts a bounded canonical Docker Buildx `current` record with an empty `Name` without interpreting its `Key`; named `default`, fallback and shadow checks remain fail-closed. These are attestation compatibility fixes, not inference or model-quality fixes. | Relmio 0.18.0 stable includes these attestation fixes. Open the dashboard with `npx --yes --ignore-scripts relmio@latest local`, then use **Review model retry** only after reviewing the fresh plan. Retry retains the owned state and cache; do not clear the model cache or change n8n to work around an attestation failure. |
| Render SSH works but the model wizard cannot use it | Render connects to a service container, not the Docker host required by this adapter. Sudo or a Docker CLI inside that service does not grant host ownership. | Choose the Render guidance and follow the [manual paid private-service recipe](hosting-compatibility.md#render-manual-private-model-service), or use a qualifying existing Linux VM. Do not rebuild n8n with Docker-in-Docker. |
| A manual Render service is healthy but n8n cannot use the model | TCP health does not prove weights or inference are ready; the caller may have the wrong internal DNS, region/workspace/environment, or worker location. | Validate acquisition in the model service's runtime with its own disk, then real inference from an authorized private-network caller and the actual n8n worker. Use the service's internal address, not the managed Docker alias or `localhost`; never make the model public as a probe workaround. |
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
| `unknown instruction: "--host"` | An older Dockerfile split the bridge command across Dockerfile instructions. | Update the owned bridge through the current wizard. For a manual install, replace both the Dockerfile and `openai-oauth-sidecar.mjs` with the matching files from the same reviewed Relmio package. |
| n8n credential says it cannot connect with `127.0.0.1` | `127.0.0.1` inside n8n is the n8n container, not the sidecar. | Use `http://n8n-openai-oauth:10531/v1`. |
| Logs show `ENOENT` for `/home/node/.local` | An older wizard release used a read-only root filesystem without a writable app-data directory. | Update to the latest wizard and run the approved install again. It safely refreshes a wizard-managed sidecar. |
| Network command prints `proxy` | That is the network name, not an empty result. | Select or enter `proxy`. |
| Logs show repeated “No auth file” and later show “endpoint ready” | `docker compose logs` contains old and new entries. | Read the newest lines at the bottom. The final “endpoint ready” state wins. |
| n8n requires an API key | The n8n credential UI requires a non-empty value even though the bridge does not. | Enter `local-only`; it is a placeholder, not an OpenAI key. |
| n8n reports `ECONNREFUSED`, `ENOTFOUND`, or “Couldn’t connect” | The Base URL is wrong, the sidecar is unhealthy, or n8n and the sidecar do not share a network. | Use exactly `http://n8n-openai-oauth:10531/v1`, inspect both container networks, and check the sidecar health/logs. |
| Models do not appear in n8n | Credential test, network, auth, or model compatibility may be failing. | Verify `/v1/models` inside the sidecar, then retry the n8n credential. |
| The VPS wizard reports `OAuth model check failed` after the sidecar starts | The bridge reached its model verification step, but older wizard code hides the failure detail. Docker `Running` or a successful `/health` response does not verify sign-in or provider access. | Inspect the bridge's model-check result before rebuilding. A failed installation closes the wizard's VPS connection; reconnect and review a fresh plan before retrying. The sidecar may already have been updated. |
| The wizard returns to ChatGPT sign-in after a failed install or update | The bridge reported a rejected credential or OAuth refresh. A local check with automatic refresh disabled does not prove that the saved session can refresh on the VPS. | Select **Refresh ChatGPT sign-in**, complete the new sign-in, then reconnect to the VPS and review a fresh bridge update before confirming. The old confirmation is cleared. Sign-in and deployment are not retried automatically. Keep automatic credential refresh enabled in the bridge. |
| The wizard says the saved ChatGPT sign-in could not be refreshed but stays at VPS connection | The refresh failed without evidence that a new sign-in is the appropriate next step, for example a provider rate limit or server error. | Inspect the provider or connection failure before retrying. The wizard does not direct network failures, permission denials, rate limits, or provider server errors into a fresh sign-in loop. |
| The model service denied the bridge request | The provider refused the request; this message alone does not identify an account, subscription, regional, or VPS-network cause. | Inspect a sanitized provider error before changing the sign-in or deployment. Do not publish the private bridge port to work around the denial. |
| The bridge endpoint could not be reached, or verification over the VPS connection could not complete | The wizard could not reach the private bridge listener, or lost its SSH verification connection. Neither result establishes that the provider rejected the sign-in. | Reconnect and inspect the existing bridge status and private network before reviewing another update. |
| `Unsupported parameter: background` while Background Mode is off | n8n sends `background: false`, but the running bridge predates the compatibility fix. | Install the newer Relmio release, then use **Update bridge runtime** locally or **Update the bridge** in the VPS wizard. Updating the package alone does not replace the running sidecar. |
| Responses API request fails but models work | The n8n node or running bridge may be incompatible. | Update the owned bridge through the Relmio wizard, then retry a basic `/v1/responses` request. Record the n8n version, node version, and sanitized error if it still fails. |
| Generate Audio, transcription, or translation reports an unsupported operation | The pinned `openai-oauth@2.0.0` transport does not implement n8n's audio routes. | Use a provider connection that supports the required audio route. Do not add an API key to this OAuth bridge as a workaround. |
| SuperGrok returns `404 not_found` while models work | The n8n connection is sending a Responses API request to the Chat Completions-only companion. | Turn **Use Responses API** off in the workflow OpenAI Chat Model node and in **Settings > Chat > OpenAI > Edit provider** for Chat Hub. This setting is separate from the Assistant custom endpoint. |
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

Use the switch that matches the provider:

- **OpenAI OAuth/Codex recipe:** leave **Use Responses API** on in OpenAI Chat
  Model node version 1.3. Earlier node versions do not show the switch and use
  Chat Completions by default. The bridge supports both routes.
- **SuperGrok:** turn **Use Responses API** off in workflow model nodes and Chat
  Hub. The companion supports Chat Completions, not `/v1/responses`. Its
  Assistant custom endpoint is configured separately.

For the OpenAI OAuth bridge, turn the switch off only as a temporary compatibility
test if:

- `/v1/models` works;
- the node is definitely calling the correct Base URL; and
- the error specifically concerns `/v1/responses`.

If chat completions work but Responses does not, record the n8n version, node
version, bridge logs, and sanitized error before changing anything else.

For a bridge installed before the current compatibility runtime, update the
owned sidecar first. In the local dashboard use **Manage bridge**, then
confirm the runtime update before choosing **Update bridge runtime**. For a VPS
bridge, reconnect through `relmio vps`, verify the host fingerprint, select the
n8n container and network, choose **OpenAI-OAuth/Codex bridge**, then **Manage
OpenAI-OAuth/Codex bridge**. Select **Review bridge update**, review and confirm
the plan, then choose **Update the bridge**. A package or source update by itself
does not change a running sidecar.

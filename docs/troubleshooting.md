# Troubleshooting

Use the current local SIWC wizard and the symptom table below. Keep provider
tokens and local bearer values out of support messages. Do not inspect token
files to troubleshoot the sidecar.

Always keep a current export or backup of your n8n workflows before using the
wizard or a manual VPS command. The documented installation adds a separate
sidecar; it does not delete, restart, or rebuild n8n.

## Docker is not running

Start Docker Desktop or Docker Engine and wait until `docker info` and
`docker compose version` both succeed. Close any stale Relmio wizard tab, start
one fresh wizard session, and review the local plan again. Do not restart or
rebuild unrelated containers while checking the local endpoint.

## ChatGPT sign-in or model access fails

Start or reopen the current local wizard (`relmio open` for a persistent
installation). Sign-in opens OpenAI authorization in the system browser and
returns to a loopback callback. If the callback fails or expires, start a fresh
attempt from the active wizard. Do not reuse a stale authorization page or
share its callback URL, state, code, tokens, or full URL.

Check the selected account's state:

- **Identity-only:** identity was verified, but ChatGPT plan use was not
  granted. Choose **Allow ChatGPT plan use** and finish the separate consent.
- **Plan paused:** resume only if the selected registration still has its
  provider grant.
- **Reauthorization required:** start a fresh sign-in for that registration.
- **Usage limit:** use **Manage usage** in ChatGPT. Do not switch accounts or
  retry through a different billing path.

Sign-in, plan permission, model listing, host admission, and completed
inference are separate checks. A token-service outage preserves the local
registration; a terminal refresh/identity failure may require reauthorization.

## Local image build failed

The local wizard intentionally does not show Docker build output, filesystem
paths, or stderr in the browser. Confirm Docker Desktop or Docker Engine is
running, check that the local disk has room for the image, and confirm your
network can reach the image registry. Then close the old wizard, start one new
wizard session, review a fresh plan, and retry. Do not delete an existing
managed endpoint or rebuild unrelated containers as a workaround.

## Hosted chat

The website's `/api/chat` is disabled and returns `410 Gone`. Local SIWC setup
does not enable the hosted endpoint. The old demo's browser extension and
stored sign-in applied to its former implementation; they are not required by
the current local wizard. If old saved site data remains in a browser, clearing
it is local cleanup only and does not revoke a provider session.


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

Relmio opens the SIWC authorization request in the system browser. If no window
opens, check the default browser and use **Stop** in the active wizard before
starting a fresh attempt. The wizard does not offer a manual authorization
URL.

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
| A ChatGPT authorization page expired or sign-in failed | The active loopback transaction may have expired, been cancelled, or failed identity verification. | Return to the current wizard and start one fresh sign-in attempt. Do not share the callback URL, state, code, tokens, or full authorization URL. |
| The wizard blocks another sign-in after cancellation | Relmio could not confirm that the original browser helper and transaction stopped safely. | Follow the wizard's recovery message. If it says to restart Relmio, close only the identified helper and restart the local wizard; do not launch another sign-in while the state is uncertain. |
| A connected account cannot request models | Identity may be verified without the separate `chatgpt.tokens.use.direct` plan grant, or plan use may be paused. | Select the intended registration and check its plan-permission state. Complete separate ChatGPT consent or resume plan use as offered. |
| A model request returns a usage-limit error | OpenAI refused the selected account's request because plan usage is limited. | Open **Manage usage** in ChatGPT. Relmio does not infer a reset time, rotate accounts, or switch billing. |
| A model request returns 503 or an interrupted stream | Provider admission or transport did not complete. | Keep the same registration and use the shown retry/recovery action later. Relmio does not replay partial output as success or fall back to another provider. |
| SIWC discovery is unavailable before refresh starts | No refresh POST was sent; the saved registration remains active and the wizard reports retry-later. | Retry the same registration when discovery is available. Do not switch accounts or delete the session. |
| A refresh POST receives HTTP 503 `temporarily_unavailable` | Relmio restores the session it had before the refresh and reports retry-later. This assumes OpenAI did not rotate the refresh token; OpenAI does not document that guarantee. | Retry the same registration later. If a later refresh fails or is uncertain, follow that recovery. |
| A refresh POST receives another error, or its network outcome is uncertain | Relmio freezes the registration before sending the POST and disables plan use. Token bytes are retained when possible, but no old refresh token is retried; `invalid_grant` is the terminal exception that clears unusable tokens. | Follow any configuration repair shown, then complete a fresh SIWC sign-in for the same registration before model use. Sign-out from frozen state is revocation-unconfirmed even if OpenAI returns HTTP 200. |
| Sign-in says `ChatGPT sign-in was declined.` or `ChatGPT plan use was declined.` | You declined the request in ChatGPT. No token request was made. A declined plan request leaves the existing verified registration unchanged. | Start sign-in or **Allow ChatGPT plan use** again if you want to grant it. |
| A request returns 503 `siwc_lock_unavailable` | Another Relmio operation held this account's session lock for longer than the 2.5-minute wait. Each holder stops after a 2-minute operation deadline. A lock from an earlier boot is reclaimed at once; one held from another container or PID namespace is reclaimed after a 10-minute lease. | Wait, then retry. Do not delete lock files by hand. |
| The SIWC store is on a synced folder or network share | The SIWC store relies on local-disk locking and atomic writes from one kernel. Sync tools and network shares can break those guarantees. | Keep `N8N_OPENAI_OAUTH_HOME` (or the sidecar volume) on a local disk that is not synced. |
| Status shows a ChatGPT install as staged | The install stopped partway, for example after a crash or lost connection. | Select the account, choose the resume action, review the plan, and confirm. Relmio continues the same installation without deleting data or starting a second refresh writer. Plan or token changes on that account since the interruption do not block it. If the session had already moved, a new one-time key replaces the old one. |
| Reviewing a plan says `The selected ChatGPT account changed. Refresh it.` | Another account was selected while the wizard loaded the model list. A token refresh alone does not cause this. | Choose the intended account again, then review the plan again. |
| Reviewing a plan says `The account model catalog could not be verified.` | The account's model list contained an entry the wizard does not accept. Nothing was written. | Try again later. If it keeps happening, report it. Do not switch accounts or edit stored sessions. |
| Resume with a different account is refused | A fresh account can take over only after a confirmed "not accepted" result. Relmio refuses if the original receipt appears, and on a VPS while a one-off sidecar helper container is still present. | Reconcile the original handoff first. On a VPS, wait for or inspect the helper container before retrying. |
| An account stays in handoff-pending after an install | The destination may have accepted the session while the sender lost the acknowledgment. | Choose the reconcile action, review it, and confirm within five minutes. Relmio reads the destination's receipt and finishes the handoff. Without a receipt the sender stays frozen; complete a fresh sign-in. Old tokens are never restored. |
| The result shows the one-time key with a finalization warning | Ownership moved to the destination, but a later finishing step failed. | Save the key now; it is shown only once. Do not use it until the reported issue is resolved, then review the installed target again. |
| A VPS install says the reviewed n8n container or network changed | The container or network ID no longer matches the reviewed plan, for example after n8n was recreated during an install. | Review the target again. Relmio never switches to a different container or network silently. After a completed install, recreating n8n or changing the SSH login method does not block status or sign-out; only the SSH host identity and network ID must match. |
| A VPS command times out or reports an unknown remote outcome | Every SSH command has a finite deadline (45 minutes by default, 30 minutes for an image build, 2 minutes for handoff acceptance, 5 minutes for publishing a managed file). Relmio closed that command without retrying; the remote effect may or may not have happened. | Inspect the exact target before trying again. Do not delete operation locks or temporary files by hand. |
| A refresh response's ID token or identity cannot be verified | The replacement tokens are saved only in a frozen record; no access-token lease is issued. | Follow the shown recovery, then complete fresh SIWC sign-in for that registration before plan use. |
| SIWC refresh returns `invalid_grant` | The previous refresh token is invalid; Relmio clears unusable token state and requires reauthorization. | Complete fresh SIWC sign-in for that registration. Relmio does not switch accounts or fall back to Platform API billing. |
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
| The wizard cannot find n8n | No running container matches the supported n8n image discovery. | Run `docker ps --format 'table {{.Names}}\t{{.Image}}\t{{.Status}}'` on the VPS. Start or repair n8n through its own deployment process; do not make the wizard recreate it. Then choose **Retry discovery**. The wizard keeps the verified SSH connection and does not ask for the password again; changing the server details needs a fresh identity check. |
| No shared Docker network is listed | n8n is not attached to a usable user-defined network. | Inspect n8n's networks and choose one the sidecar can join. Do not publish port `10531` as a workaround. |
| n8n cannot reach `n8n-openai-oauth` | The n8n container may not share the selected network, or the sidecar may not be running. | Use `http://n8n-openai-oauth:10531/v1` from the selected Docker network. Do not use `localhost` or publish port `10531`. |
| n8n returns `401` from the private sidecar | The one-time Relmio bearer may be missing, entered incorrectly, or belong to a different installation. | Recheck the exact local bearer from the installation result. Do not substitute an OpenAI API key or a provider token. |
| The model catalog is empty, unavailable, or missing expected models | The selected registration, plan grant, provider catalog, or serving host may be unavailable. OpenAI also filters the catalog by an undocumented `client_version` parameter; Relmio sends its pinned Codex version (0.160.0). | Refresh the selected account and inspect the safe error/recovery action. A catalog failure is not evidence that another account or host should be tried. |
| A request receives an unsupported-parameter or unsupported-route error | The gateway rejected a field or capability it does not implement. | Correct the request using [Configure n8n nodes](n8n-configuration.md). Do not retry the same request unchanged or expect image generation, audio, video, Files management, moderation, or stored conversations to work. |
| Sign-out reports revocation unconfirmed | Relmio cleared local SIWC tokens, but could not confirm remote revocation. A refresh-uncertain token family remains unconfirmed even if OpenAI returned HTTP 200. | Disconnect Relmio from ChatGPT settings. Local cleanup is not proof of provider revocation or deletion. |
| SuperGrok returns `404 not_found` while models work | The n8n connection is sending a Responses API request to the Chat Completions-only companion. | Turn **Use Responses API** off in the workflow OpenAI Chat Model node and in **Settings > Chat > OpenAI > Edit provider** for Chat Hub. This setting is separate from the Assistant custom endpoint. |
| Existing ChatGPT credential-copy sidecar is detected | A legacy authentication/runtime was not a SIWC registration and is never silently adopted. | Use the fresh SIWC sign-in and separately confirmed migration. Relmio stops only the exact attested old sidecar after final approval, keeps its old credential/workspace volumes offline, and creates a new runtime; it does not import `auth.json`. If migration is incomplete or uncertain, inspect the retained resources; the old service is not resumed automatically. |
| The read-only Codex Chat Adapter returns `usage_limit` | The selected ChatGPT account reached a plan-usage limit. | Open **Manage usage** in ChatGPT. Do not switch registrations or billing. |
| The Chat Adapter returns `unauthorized` | The App Server request could not use the selected SIWC registration. | Follow the reauthorization shown for that same registration. The adapter does not fall back to another account or API key. |
| The Chat Adapter reports `stream_interrupted` or `upstream_failed` | The App Server turn did not complete; earlier deltas are partial output. | Use the shown recovery before starting another turn. It does not replay the failed turn automatically. |

## Protect registration and bearer data

Do not print provider token records, Compose environment values, or the
one-time local Relmio bearer in logs or support messages. The wizard shows the
n8n bearer once; if it is lost, use the offered ownership-attested management
flow instead of searching Docker volumes or account files.

## Verify private n8n connectivity

The n8n container and sidecar must share the selected Docker network. In n8n,
use `http://n8n-openai-oauth:10531/v1`; `localhost` refers to n8n itself.
The sidecar publishes no host port. Do not expose `10531` or use a public
reverse proxy as a connectivity workaround.

The sidecar requires the one-time Relmio bearer returned by the wizard. It is
not an OpenAI API key or ChatGPT token. Keep it in an n8n credential and share
it only with trusted callers on that network.

## Recover model and account errors

- **Identity-only account:** use **Allow ChatGPT plan use** to request the
  separate provider grant. Identity sign-in alone does not authorize models.
- **Usage-limit error:** use **Manage usage** in ChatGPT. Do not rotate
  accounts, loop on retries, or switch billing.
- **Unsupported parameter or route:** correct the request using
  [Configure n8n nodes](n8n-configuration.md). The gateway rejects unsupported
  fields and capabilities instead of silently dropping them.
- **Model-inference 503 or interrupted stream:** keep the same registration
  and follow the shown retry-later action. A partial answer is not success.
- **Discovery fails before refresh is sent:** the session is unchanged; retry
  later as shown.
- **Refresh returns 503 `temporarily_unavailable`:** the pre-refresh session
  is restored; retry later. This assumes OpenAI did not rotate the token,
  which OpenAI does not document.
- **Refresh POST fails otherwise or its outcome is uncertain:** use the same
  registration and complete fresh SIWC sign-in before plan use. Do not retry
  the old refresh token.
- **Refresh response cannot be verified:** the replacement token stays frozen
  and is not usable; follow the error recovery and sign in again.
- **Unconfirmed remote revocation:** local credentials were cleared; disconnect
  Relmio from ChatGPT settings. Local cleanup does not prove provider-side
  revocation or data deletion.
- **Unresolved installation transfer:** keep the source frozen and use the
  reviewed resume or reconcile action. Do not restore the sender's old tokens
  or activate both installations. Relmio never restarts an old writer
  automatically.

For current request fields and unsupported capabilities, see
[Configure n8n nodes](n8n-configuration.md). For the data flow and provider
requirements, see the
[2026-10-05 OpenAI source check](openai-source-check-2026-10-05.md).

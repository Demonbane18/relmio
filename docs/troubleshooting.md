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
| The setup guide covers something you want to read or press | The guide keeps clear of the field you are using, the step's main button and error messages, and folds itself away when nothing fits. It can still cover other text or controls, mostly in small windows. | Press the down arrow at the top of the guide (**Hide guide**), or Escape while the guide has focus. It folds into a small **Guide** button; press that to bring it back. To turn the guide off, press **Skip guide** or the **Setup guide** button in the top bar (in the menu on very narrow windows). |
| A ChatGPT authorization page expired or sign-in failed | The active loopback transaction may have expired, been cancelled, or failed identity verification. | Return to the current wizard and start one fresh sign-in attempt. Do not share the callback URL, state, code, tokens, or full authorization URL. |
| The wizard blocks another sign-in after cancellation | Relmio could not confirm that the original browser helper and transaction stopped safely. | Follow the wizard's recovery message. If it says to restart Relmio, close only the identified helper and restart the local wizard; do not launch another sign-in while the state is uncertain. |
| A connected account cannot request models | Identity may be verified without the separate `chatgpt.tokens.use.direct` plan grant, or plan use may be paused. | Select the intended registration and check its plan-permission state. Complete separate ChatGPT consent or resume plan use as offered. |
| A model request returns a usage-limit error | OpenAI refused the request because a usage limit was reached. It can be the plan's limit or the weekly limit set for this app in ChatGPT. | Open **Manage usage** in ChatGPT to see which limit applies and when it resets. Signing in again does not restore usage. Relmio does not infer a reset time, rotate accounts, or switch billing. |
| A model request returns 503 or an interrupted stream | Provider admission or transport did not complete. | Keep the same registration and use the shown retry/recovery action later. Relmio does not replay partial output as success or fall back to another provider. |
| SIWC discovery is unavailable before refresh starts | No refresh POST was sent; the saved registration remains active and the wizard reports retry-later. | Retry the same registration when discovery is available. Do not switch accounts or delete the session. |
| A refresh POST receives HTTP 503 `temporarily_unavailable` | Relmio restores the session it had before the refresh and reports retry-later. This assumes OpenAI did not rotate the refresh token; OpenAI does not document that guarantee. | Retry the same registration later. If a later refresh fails or is uncertain, follow that recovery. |
| A refresh POST receives another error, or its network outcome is uncertain | Relmio freezes the registration before sending the POST and disables plan use. Token bytes are retained when possible, but no old refresh token is retried; `invalid_grant` is the terminal exception that clears unusable tokens. | Follow any configuration repair shown, then complete a fresh SIWC sign-in for the same registration before model use. Sign-out from frozen state is revocation-unconfirmed even if OpenAI returns HTTP 200. |
| Sign-in says `ChatGPT sign-in was declined.` or `ChatGPT plan use was declined.` | You declined the request in ChatGPT. No token request was made. A declined plan request leaves the existing verified registration unchanged. | Start sign-in or **Allow ChatGPT plan use** again if you want to grant it. |
| A request returns 503 `siwc_lock_unavailable` | Another Relmio operation held this account's session lock for longer than the 2.5-minute wait. Each holder stops after a 2-minute operation deadline. A lock from an earlier boot is reclaimed at once; one held from another container or PID namespace is reclaimed after a 10-minute lease. | Wait, then retry. Do not delete lock files by hand. |
| The SIWC store is on a synced folder or network share | The SIWC store relies on local-disk locking and atomic writes from one kernel. Sync tools and network shares can break those guarantees. | Keep `N8N_OPENAI_OAUTH_HOME` (or the sidecar volume) on a local disk that is not synced. |
| Status shows a ChatGPT install as staged | The install stopped partway, for example after a crash or lost connection. | Select the account, choose the resume action, review the plan, and confirm. Relmio continues the same installation without deleting data or starting a second refresh writer. Plan or token changes on that account since the interruption do not block it. If the session had already moved, a new one-time key replaces the old one. |
| Answers from the VPS sidecar are empty but the request succeeds | The sidecar may be running an image built by an older Relmio version, for example one from before the fix for OpenAI's empty `output` field. The files on the server can be current while the running image is not. | Open **Manage the installed ChatGPT session**, choose **Check installed account**, then **Review sidecar update** and confirm. Relmio rebuilds only the sidecar; the ChatGPT sign-in, the one-time key and n8n stay unchanged. See [Update the installed sidecar](vps-and-n8n.md#update-the-installed-sidecar). If the review says `Already current. Nothing to update.`, the image was already built from this version's files. |
| Status shows a sidecar update as interrupted (`updating`) | A sidecar update stopped before it finished, for example after a lost connection, or the new sidecar failed its checks and Relmio stopped it. | Press **Finish sidecar update** on **Choose your n8n**, or choose **Check installed account**, then **Review sidecar update** again, and confirm. Relmio rebuilds the image and finishes the same update. The staged-install resume refuses an interrupted update, and a new install plan for this server is refused until it finishes (`vps_sidecar_updating`). If Relmio could not confirm that the sidecar stopped, do not use it until you inspect it. |
| Reviewing a plan says `A ChatGPT plan sidecar is already installed and running here.` (`vps_sidecar_owned`) | Relmio's sidecar already runs on this n8n network, and a second install is refused. Earlier wizards could label the main button **Review bridge update** and lead here. | Press **Review sidecar update** on **Choose your n8n**. It opens **Manage the installed ChatGPT session**, checks the installed account and reviews the update; confirm it there. See [Update the installed sidecar](vps-and-n8n.md#update-the-installed-sidecar). |
| **Check installed account** says `Needs a fresh sign-in.` | OpenAI no longer accepts the installed sidecar's ChatGPT sign-in, or Relmio could not confirm its last renewal. Relmio does not renew a registration that has moved to the server, so the refresh makes a new one. | Choose **Refresh ChatGPT sign-in** and follow [Refresh the ChatGPT sign-in](vps-and-n8n.md#refresh-the-chatgpt-sign-in). ChatGPT treats the new sign-in as a new connection. n8n needs the new Relmio key afterwards. |
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
| n8n's Assistant shows `A local client credential is required.` | The Assistant's saved API key is not the sidecar's current Relmio key. The Assistant keeps its own copy of the key, separate from your n8n OpenAI credential, so it can keep an old key after Relmio issues a new one. | Paste the current Relmio key, the same one as in your n8n OpenAI credential, into **API key** in the Assistant's **Model** setting (**Settings > n8n Assistant**). Do not use an OpenAI API key or a provider token. |
| The Assistant's model check says `This Responses parameter is unavailable with ChatGPT plan usage.` | The running sidecar was built by an older Relmio version that refuses `max_output_tokens`, which n8n's model check sends. Current sidecars drop that field. | On a VPS, open **Manage the installed ChatGPT session**, choose **Check installed account**, then **Review sidecar update** and confirm. See [Update the installed sidecar](vps-and-n8n.md#update-the-installed-sidecar). Then save the Assistant's model setting again. If the message stays, the request has another field the sidecar refuses; see [AI Assistant requests](n8n-configuration.md#ai-assistant-requests). |
| The Assistant forgets its earlier steps or replies after a sidecar restart or update | Expected. The sidecar keeps earlier reasoning and replies only in memory, and a restart or update empties it. Items also expire after 6 hours, and the least recently used go first when the memory is full (4,096 items or 32 MiB). The sidecar drops references to items it no longer has. | Start a new Assistant conversation. Earlier tool calls and results are still sent in full. See [AI Assistant requests](n8n-configuration.md#ai-assistant-requests). |
| A request with many tools fails with `param` `tools`, for example `The tool definitions cannot be represented by this plan route.` | One request can list at most 128 tools. The same error covers a duplicate tool name or a function or custom tool definition the sidecar cannot send. In n8n's Assistant, tools from connected MCP servers count toward the limit. | Send fewer tools, for example by connecting fewer MCP servers to the Assistant. A Chat Completions message or response is also limited to 32 tool calls. |
| n8n gets `catalog_unavailable` (`The account model catalog is unavailable.`) | The sidecar could not read OpenAI's catalog and has no list from the last hour. HTTP `401` with recovery `reauthorize` means OpenAI rejected the sign-in; `503` with `retry-later` means the catalog could not be reached. | For `retry-later`, try again later. For `reauthorize`, choose **Check installed account**. If it says `Needs a fresh sign-in.`, choose [Refresh ChatGPT sign-in](vps-and-n8n.md#refresh-the-chatgpt-sign-in); otherwise check that the installed account is the one you meant to use. A catalog failure is not a reason to try another account or host. |
| A model is missing from an n8n list | The catalog can take 5 minutes to refresh. OpenAI may show it only to a newer Codex version than the one the sidecar last read from npm (checked about every 12 hours), or mark it hidden or not for API use. IDs that contain `image` are left out. A model that failed with a model error in the last day is hidden. With model checks on, n8n lists only models that answered a test, once any has. In Chat Hub, an admin's allowed-models list hides new models. | Wait 5 minutes and choose **Refresh List** in n8n. On a VPS, choose **Check installed account** and look at the model's labels. In Chat Hub, add the model under **Settings > Chat**. See [Model discovery and checks](n8n-configuration.md#model-discovery-and-checks). |
| `gpt-image-2` is missing from the Chat Model node or Chat Hub, but shows in the OpenAI node's **Message a Model** list | Expected. Only the OpenAI node's image actions can use it; its text and image pickers share one model request. | Use `gpt-image-2` only in **Generate an Image** or **Edit Image**. |
| The Models panel says `Update the sidecar first (Review sidecar update) to show models.` | The running sidecar was built before model discovery. | Choose **Review sidecar update** and confirm, then **Check installed account** again. |
| The Models panel says `OpenAI's model catalog is unavailable right now.` | The status check could not read the catalog or use the ChatGPT session within about a minute. With checks on, the panel adds `You can still turn model checks off.` Turning checks on needs the catalog, so that control is hidden. | Check again later. Turning checks off works without the catalog. |
| The Models panel says `OpenAI's catalog lists no models for this account.` or `Check the installed account to refresh the model list.` | The catalog came back empty, or the panel has no catalog after checks were turned off. | Choose **Check installed account** again. An empty catalog is not a reason to try another account. |
| The Models panel says `Checks paused: plan usage isn't available right now.` | A test hit a usage limit, which can be the plan's limit or this app's limit in ChatGPT, or OpenAI could not check the usage or the account just then. | Wait, or open [Manage usage](https://chatgpt.com/settings/usage). Untested models are tried again later, at the earliest after 60 minutes. |
| The Models panel says `Checks paused: ChatGPT sign-in is needed.` | OpenAI rejected the ChatGPT sign-in during a test. | Choose **Check installed account**. If it says `Needs a fresh sign-in.`, choose [Refresh ChatGPT sign-in](vps-and-n8n.md#refresh-the-chatgpt-sign-in). |
| The Models panel says `Checks paused: the ChatGPT session isn't available for plan use right now.` | The ChatGPT session could not be used for a test just then, for example because another operation held it or plan use is off. | Check again later. Checks resume on a later background run. |
| The Models panel says `Checks paused: OpenAI refused the test request.` | OpenAI answered a `4xx` error, such as `403`, that did not blame the model. Nothing was recorded. | Try again later. If it keeps happening, turn model checks off; new models then show in n8n without a test. |
| The Models panel says `Checks stopped because they were turned off.` | Checks were turned off, here or by **Sign out and revoke**, while a run was in progress. | Nothing to fix. Turn them on again if you want them. |
| The Models panel says `Some models weren't checked in time. The sidecar keeps checking in the background.` | Turning checks on tests up to 12 models within about 3 minutes. | Nothing to do. With checks on, the rest are tested when n8n next asks for models, up to 8 at a time. |
| Changing model checks says `The sidecar's model check record is unsafe. An administrator must inspect it.` or `The sidecar's model check record is busy. Try again in a minute.` | The record under `siwc/model-checks` has the wrong owner, mode or link count, does not parse, or another check holds its lock. Relmio never overwrites an unsafe record. | If busy, try again in a minute. If the record only fails to parse, turning model checks off replaces it. Otherwise an administrator must inspect `/docker/n8n-openai-oauth/siwc/model-checks/` on the VPS. |
| **Plan and usage** says `No requests counted in the last 30 days.` and that an older sidecar counts nothing until it is updated | The sidecar sent no text request to OpenAI in the last 30 days, or it was built by an earlier Relmio version, which counts nothing. A VPS sidecar keeps its old build until you update it. | On a VPS, choose **Check installed account**; if it offers a newer sidecar, choose **Review sidecar update** and confirm. Counting starts with the updated sidecar, so earlier requests never appear. The update ends the SSH session, so after n8n sends a request, connect again, choose **Check installed account**, then **Refresh usage**. On this computer, send a request from n8n, then press **Refresh usage**. |
| **Plan and usage** says `The request counts could not be read, so none are shown.` | The count record failed a safety or format check, or the read-only `usage` command failed, for example while the sidecar restarted. On this computer, Relmio may also have been unable to confirm that it owns the running sidecar. No partial counts are shown. | Press **Refresh usage** again. On this computer, check the ChatGPT plan sidecar under **Connections** first. A record that only fails to parse is replaced the next time the sidecar saves counts after a request. If the message stays on a VPS, an administrator must inspect `/docker/n8n-openai-oauth/siwc/activity/`; Relmio never overwrites an unsafe record. |
| **Plan and usage** says `Relmio can read the counts 10 times in 15 minutes.` | On a VPS, each **Refresh usage** runs a read-only command over SSH, and the wizard allows 10 in any 15 minutes. The counts already on screen stay, with the time they were saved. | Wait a few minutes, then press **Refresh usage** again. The sidecar keeps counting in the meantime. |
| **Plan and usage** says `Press Check installed account again, then Refresh usage.` | On a VPS, the wizard reads the counts only within five minutes of **Check installed account** for the same n8n container and network. | Choose **Check installed account**, then **Refresh usage**. |
| A request receives an unsupported-parameter or unsupported-route error | The gateway rejected a field or capability it does not implement. | Correct the request using [Configure n8n nodes](n8n-configuration.md). Do not retry the same request unchanged or expect audio, video, Files management, moderation, or stored conversations to work. Image routes need the [image add-on](n8n-configuration.md#generate-and-edit-images). |
| An image request returns `404 images_off` | The image add-on is not signed in on this sidecar. | On a VPS, open **Manage the installed ChatGPT session**, choose **Check installed account**, then **Sign in for images**. See [Turn on image generation](vps-and-n8n.md#turn-on-image-generation-optional). On this computer, open **Image generation** for the installed **ChatGPT plan sidecar** and choose **Sign in for images**. See [Turn on image generation on this computer](local-endpoints.md#turn-on-image-generation-optional). |
| n8n's OpenAI image **Model** list shows `No results`, or no `gpt-image-2` | The sidecar lists `gpt-image-2` only while image generation is signed in. A fresh or replaced sidecar starts with it off. | Turn on image generation, during setup or afterwards (see the row above), then open the node again so n8n reloads the list. Choosing **ID** and entering `gpt-image-2` does not help while images are off; requests return `404 images_off`. |
| The image panel says `Update the sidecar first (Review sidecar update) to add image generation.` | The running VPS sidecar was built by an older Relmio version that has no image add-on. | Choose **Review sidecar update** and confirm, then **Check installed account** again. See [Update the installed sidecar](vps-and-n8n.md#update-the-installed-sidecar). |
| The local **Image generation** section says `Update the sidecar first to add image generation.` | An older Relmio version built the local sidecar, so it has no image add-on. The local dashboard has no in-place sidecar update. | Under **Installed ChatGPT account**, choose **Sign out and revoke**, then **Review replacement with a fresh account**, or remove the bridge and set it up again. Either builds a new sidecar with this Relmio version. n8n needs the new Relmio key afterwards. |
| An image request returns `401 images_reauthorize`, or the panel says `The Codex image sign-in expired. Sign in for images again.` | The Codex refresh token expired, was revoked or reused, or a refresh ended with an unknown outcome. Relmio never retries an old refresh token. | On a VPS, choose **Check installed account**; on this computer, open **Image generation**. Then choose **Sign in for images** again. |
| An image request returns `502 images_upstream_unauthorized` | Codex rejected the image sign-in. Relmio does not retry or force a refresh. | Sign in for images again. If it keeps happening, OpenAI may have changed or closed this route, which it does not document for other apps. |
| An image request returns `429`, for example with code `usage_limit_reached` | The plan's Codex image limit is reached. When OpenAI sends `resets_at`, it is the reset time in Unix seconds. | Wait for the reset. Relmio does not retry, switch accounts, or fall back to Platform API billing. |
| An image request returns `503 images_unavailable`, `502 images_upstream_failed` or `502 images_invalid_response` | The Codex sign-in could not be read or refreshed just then, or the Codex request failed or returned no image. Relmio does not retry. | Try again later. If `images_unavailable` keeps happening, choose **Check installed account** to see the image sign-in state. |
| An image request returns `400 unsupported_model` | The node sent a model other than `gpt-image-2`, such as n8n's defaults (`gpt-image-1-mini` for Generate, `gpt-image-1` for Edit) or a GPT Image 2.5 ID. The Codex route ignores the model ID, so Relmio offers only `gpt-image-2`. | Pick `gpt-image-2` from the list or enter it as the ID. For Flare or Sunburst, use a separate OpenAI credential with your own Platform API key; see [the image test](n8n-configuration.md#generate-and-edit-images). |
| An image request returns `400 unsupported_parameter` or `invalid_value` | The request asked for more than one image, a mask, URL output, an unsupported size such as `256x256`, or a field the add-on does not accept. | Ask for one image without **Image Mask**, at `1024x1024`, `1024x1536`, `1536x1024` or `auto`. See the [image limits](n8n-configuration.md#generate-and-edit-images). |
| The image panel says the Codex sign-in was declined or the code expired | Image generation stays off. The code is valid for 15 minutes. | Choose **Sign in for images** again and enter the new code. |
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
  fields and capabilities instead of silently dropping them. Only output-token
  caps are dropped; see
  [AI Assistant requests](n8n-configuration.md#ai-assistant-requests).
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

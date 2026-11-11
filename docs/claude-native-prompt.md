# Claude subscription (experimental): native prompt adapter

Relmio runs one fresh, unmodified official `claude -p` process for each admitted text request. Authenticated `POST /chat` returns JSON or Relmio SSE. `GET /v1/models` and `POST /v1/chat/completions` provide a text-only OpenAI-compatible facade for your own n8n. A messages array becomes one native user turn; native conversation history is not replayed.

This began as an npm-packaged CLI experiment, separate from existing ChatGPT/SuperGrok connections and managed installers. Since Relmio 0.24.0 the browser wizard can also deploy its Docker companion; see [Browser wizard](#browser-wizard-docker-companion). The CLI does not install n8n, configure n8n credentials automatically, or deploy a server for you.

## Requirements and disclaimer

- Node.js 24 or newer. The `relmio claude` commands, including native serving and `relmio claude companion login`, run on macOS or Linux only. Native Windows serving is not supported. The browser wizard's VPS route and **Hosting options** are not limited to those systems; the VPS Claude page is untested on Windows. A Docker target needs Linux `amd64` or `arm64`, Docker/Compose and an existing trusted n8n Docker network.
- The official Claude Code executable, pinned to `2.1.317`, installed and logged in by you. Qualify its provenance, SHA256, effective policy, dedicated authentication, exact models and billing before inference. A newer binary needs fresh qualification and adapter compatibility review.

> [!WARNING]
> Experimental; not affiliated with or endorsed by Anthropic. Relmio never opens, copies, refreshes or transmits Claude credentials. The official CLI owns login, refresh and provider traffic. Use only your own account for personal, owner-only work. Do not offer access to others or run a shared or hosted subscription service. Anthropic's terms and usage policies apply; Anthropic may change or block this use at any time. Successful inference does not establish provider approval.
>
> Anthropic's SDK quickstart says third-party developers may not offer Claude.ai login or plan rate limits for their products unless approved. Relmio provides no Claude login: you log in through the official CLI in your own terminal. The wizard does offer a Claude setup path, and that offering relates to the restriction even though sign-in stays in the official CLI. Relmio has no Anthropic approval for this gateway or wizard. That permission question remains unresolved; this experimental, owner-run use may stop working or be disallowed. See the [current source check](claude-wizard-source-check-2026-11-04.md#anthropic-findings).
>
> Turn extra usage off in your Claude account before sending prompts. Relmio refuses Fable, but extra-usage billing remains your account's setting, not an adapter-enforced spending cap.

### Limitations and subscription usage

- Plan limits are shared with other Claude surfaces. Third-party [Hermes measurements](https://hermes-agent.nousresearch.com/docs/plugins/claude-subscription-directsdk#subscription-usage) suggest `claude -p` may draw the five-hour window faster than interactive Claude Code. That is not an Anthropic guarantee or a universal plan rule. Relmio does not override caller identity or attempt quota weighting.
- Recorded small calls used roughly 1.7 to 2.5K prompt tokens including Claude Code's system prompt and other native context. Treat that as observed overhead, not a fixed per-call system-prompt size. Relmio does not replace the native system prompt or send `--system-prompt`; token counts are not the size of your text alone.
- Text only: no tools, AI Agent tool loop, n8n AI Assistant, Responses API, images or attachments. Accepted sampling fields are ignored; output-token and stop fields do not limit the answer.
- One request at a time, with no queue. The lock covers one account root, not every other Claude client using your plan. Remaining allowance is not reported; `/chat` returns `quota: null`.
- Owner qualification must be reconfirmed. Local setup defaults to one hour; the launcher accepts at most seven days. Expiry blocks later spawns, not a turn already running. Requalify changed binaries, models, policy, layout, login/account or billing.
- Unused, undocumented native stream records are ignored. Tool, subagent, hook, task and command signals still fail closed. The checks cannot prevent an unqualified managed startup command that runs before an init event.
- Native uses your real `HOME`; dedicated `CLAUDE_CONFIG_DIR` does not isolate HOME-resolved caches, logs, files or normal home backups. Native files and provider retention remain separate custody boundaries.
- Recorded live checks cover native macOS with n8n 2.46.4, a Hostinger Docker companion with n8n 2.44.6, and a local Colima (arm64) Docker companion with n8n 2.46.4. Other VPS providers and Docker Desktop remain experimental. n8n Stop and n8n streaming remain unverified; see the [verification record](#verification-record).
- Required n8n settings: **Use Responses API off**, **Max Retries 0**, **Timeout at least 135000 ms**, **Basic LLM Chain Batch Size 1**, and node/workflow automatic retries off.

For full n8n AI Agent tool workflows, use n8n's ordinary Anthropic Chat Model with a Console API key. Eligible Max monthly API credit is a separate billing route, not included subscription allowance. See the [research note](claude-subscription-n8n-research-2026-11-03.md#separate-monthly-api-credit-route) and [current source check](claude-native-prompt-source-check-2026-11-04.md). Neither this guide nor Hermes's MIT source establishes distributed-product permission.

## Topology and credential custody

Default serving binds only `127.0.0.1`, normally `http://127.0.0.1:14502`. Use the actual printed origin when the port differs. Callers must share the host's network namespace. An occupied port is a startup failure, not permission to stop another service.

Docker n8n has its own loopback. The host listener is not reachable by substituting `host.docker.internal`, a Docker service name or a VPS address; its exact Host check rejects those names. Use the [Docker companion](#docker-companion-vps-or-local-docker-n8n) on n8n's existing private network. n8n Cloud cannot reach these private listeners. Never publish an adapter port, reverse-proxy it publicly or tunnel it. If ngrok exposes n8n, it must not expose this companion.

The independent local Relmio bearer authorizes the adapter only. It is not an OpenAI key, Anthropic key or native login token. The adapter compares its SHA256 and never gives it to Claude. Put it only in the trusted client's credential store, never workflow JSON, expressions, pinned data, URLs, shell arguments or browser code. Never copy a personal Claude directory or login into n8n.

Relmio reads prompts, selected model and native text/events in memory. The launcher reads its private config and executable bytes, creates directories and writes a PID/start-time lock. It reports the listener origin or fixed refusal codes, not prompts, raw native stderr or bearer values. Generated answer text remains caller data and is not universally secret-filtered.

Native owns stored login and sends authentication/inference to Anthropic. Native telemetry, provider privacy/retention, n8n execution history, host administrators and backups remain separate boundaries. Linux companion credentials are native-owned protected files in its account volume; macOS uses the native Keychain identity, subject to native fallback behavior. See the [data/recipient disclosure](claude-native-prompt-source-check-2026-11-04.md) and the [historical detailed record](claude-native-prompt-source-check-2026-11-03.md#data-handling-and-recipients).

## Qualification and launcher configuration

Review the exact official binary/digest, effective endpoint/drop-in/MDM/cloud policy and caches, managed MCP, even shadowed `policyHelper` entries, executable auth/telemetry helpers and managed hooks. Managed hooks must be absent or disabled by effective managed policy. Safe mode and caller `disableAllHooks` do not prevent every managed command; init arrives too late to prevent startup hooks.

Confirm dedicated native subscription authentication, actual account/model eligibility, extra-usage controls and control of policy changes throughout the qualification window. Native `apiKeySource: "none"` alone proves neither subscription auth nor included-only billing. Owner assertions record completed review; they do not perform it. Never answer a review question “yes” merely to make setup proceed.

The launch configuration is a private, canonical, regular, singly linked JSON file, at most 16 KiB, owned by root or the current user with no group/other access. Unknown fields are rejected. Its schema is:

| Field | Contract |
| --- | --- |
| `schemaVersion` | Integer `2`; version 1 and legacy single `model` are rejected. |
| `accountRoot` | Canonical absolute private directory outside the installed package/checkout. It must not contain that package or your home directory. Its parent must already exist canonically. Do not reuse personal Claude state. |
| `executable` | Canonical absolute official executable, not a symlink or shell command; nonempty, singly linked, owned by root/current user, executable and not group/other writable. |
| `executableSha256` | Reviewed SHA256, 64 lowercase hex characters. |
| `version` | Exact `2.1.317`. |
| `models` | One to eight unique exact IDs matching `^claude-[a-z0-9]+(?:-[a-z0-9]+)*$`, at most 128 characters each. No aliases/context suffixes or IDs containing `fable`. Order controls model discovery and the `/chat` default. Syntax/listing does not establish entitlement. |
| `port` | Optional integer 1 to 65535; default 14502. |
| `companionHost` | Optional lowercase DNS label matching `^[a-z][a-z0-9-]{0,62}$`. The companion uses `relmio-claude`; omit for loopback. No arbitrary bind address is accepted. |
| `qualification` | Runtime-bound owner assertions and review/expiry timestamps below. |

`qualification` contains only these fields:

- `reviewedBy`: nonblank review identifier, at most 128 characters, no NUL/newlines. Use a generic identifier, not personal details in shared records.
- `reviewedAt`, `expiresAt`: canonical UTC ISO strings in `Date.toISOString()` form. Review cannot be future-dated; expiry must be current and after review, at most seven days later.
- `officialBinaryReviewed`, `effectivePolicyReviewed`, `nativeAuthAndBillingReviewed`, `policyChangesControlled`: boolean `true`, representing actual review.
- `runtime`: exact `executable`, `executableSha256`, `version`, ordered `models`, `home`, `configDir`, `cwd`. First four match the top level; `home` is your canonical real home; `configDir` is `accountRoot/config`; `cwd` is `accountRoot/empty`.

The launcher creates private account/config directories with mode `0700` and an empty read-only working directory with mode `0500`. Existing paths must already meet ownership/privacy/canonical checks. Parent directories must be owned by root/current user and not group/other writable; root-owned sticky temp directories are the exception. Relmio never creates or changes your home directory. These checks do not prevent same-user/root filesystem races or native Keychain access.

It hashes the executable offline at startup, then rechecks qualification expiry, held lock, launch-file metadata/path, executable identity, directory identities and empty cwd before each spawn. It does not inspect native credential/config contents or automatically attest managed policy, account or billing. Changing launch JSON blocks later spawns. Restart after requalification.

Native receives fixed argv with `shell: false`, a detached owned process group, safe mode, disabled slash commands, empty tools/strict empty MCP, no session persistence and one native turn. A filtered child environment excludes inherited API keys, proxies, endpoint overrides and the local bearer. Text goes through one `client_composed: true` stdin JSON message, never argv. Fast mode and refusal fallback are disabled.

Only built-in mods observed in `2.1.317` (`cc-plugin-agents-md`, `cc-plugin-privacy`, `cc-plugin-plugin-authoring`) are allowed by name, each once. That check happens after load. Nonempty auth-helper output, unexpected tool/control activity or a second native command identity fails as `unexpected_tools`. None replaces pre-launch policy review.

## Local setup with `relmio claude`

These instructions target Relmio 0.23.0. Once that version is published, install the npm command as below; during release-candidate QA, use the reviewed candidate tarball instead. This draft is not evidence of npm publication. The earlier 0.22.2 package has no Claude commands.

```sh
npm install --global --ignore-scripts relmio@0.23.0
relmio claude --help
```

Relmio does not install the local Claude binary or log in for you. Install official Claude Code separately and select the reviewed `2.1.317` executable. `relmio start` and `relmio stop` manage the dashboard, not this foreground adapter.

Use the same real `HOME`, `USER`, `LOGNAME`, dedicated `CLAUDE_CONFIG_DIR`, pinned executable and empty cwd for native login/status as for serving. `CLAUDE_CONFIG_DIR` separates config/state and macOS Keychain identity from everyday Claude; it does not give native a separate HOME.

First review binary provenance and effective policy, then initialize a fresh private folder. Replace the binary example with your installed `2.1.317` path. A usual CLI symlink is accepted here and resolved to the canonical executable before hashing:

```sh
CLAUDE_DIR="$HOME/relmio-claude-local"
CLAUDE_BINARY="/absolute/path/to/reviewed/claude"
relmio claude local init "$CLAUDE_DIR" --claude "$CLAUDE_BINARY"
```

`local init` creates the output folder, `account` and `account/config` with mode `0700`, plus `account/empty` with mode `0500`. Its parent must already exist. It needs no existing `.relmio` directory or n8n stack, writes no approval/key, and does not execute Claude. It prints the canonical binary path and offline SHA256; compare that digest with the [official 2.1.317 manifest](https://downloads.claude.ai/claude-code-releases/2.1.317/manifest.json) for your platform before running the binary.

Follow the exact official login command printed by `local init`, then its instruction to repeat it with `auth status`. Those commands use the dedicated `account/config`, empty cwd and literal real HOME/USER/LOGNAME values. Keep them in your own terminal. Existing directories must already meet privacy/canonical-path checks; do not copy personal credentials into them or weaken permissions to bypass a refusal.

On macOS an isolated HOME caused browser login to succeed without saving credentials, followed by `login_required`. If macOS offers **Reset To Defaults** for a missing Keychain, choose **Cancel**; resetting can detach an existing login Keychain.

Complete only the official CLI's login flow. If it asks for a pasted code, use the code from that same flow and check that its suffix after `#` matches the printed link's `state`. Keep the code, link query and output private. `auth status` in the same runtime environment must report `loggedIn: true` and `authMethod: "claude.ai"`; also confirm the reviewed account/plan. Status/login are native operations and do not qualify policy or guarantee zero charges.

After official login/status and billing review, prepare the launch configuration interactively. This example approves only Haiku; choose the exact models your account can use:

```sh
relmio claude local prepare "$CLAUDE_DIR" --claude "$CLAUDE_BINARY" \
  --model claude-haiku-5-5
relmio claude serve --config "$CLAUDE_DIR/launch.json" \
  --key-hash-file "$CLAUDE_DIR/key.sha256"
```

`local prepare` asks four default-No questions: official binary/checksum, effective policy, dedicated native login/models/billing with extra usage off, and control of changes until expiry. Only completed reviews should receive yes. Without stdin/stdout TTY, or after a declined review, it writes nothing. It never runs Claude or reads native login files.

The first approval writes `launch.json`, `key.sha256` and `n8n-api-key.txt`, each mode `0600`. The hash file contains only the local bearer verifier. Enter the private raw key into n8n's credential store, verify it was saved, then remove `n8n-api-key.txt`; never put its value in command arguments or workflow JSON.

Local and companion `prepare` default to Haiku, Sonnet and Opus 5.5 IDs: `claude-haiku-5-5`, `claude-sonnet-5-5`, `claude-opus-5-5`. Repeating `--model <id>` replaces that list, preserving order; use one to eight unique approved IDs. No listing proves entitlement. Local `--hours` accepts whole hours 1 to 168, default 1. Do not extend approval beyond the period you can keep policy/login/billing controlled.

`serve` runs in the foreground and reports that provider readiness was not probed; no Claude request runs until an admitted prompt. Keep that terminal open and use Ctrl-C/SIGTERM for shutdown. Before expiry, stop serving, repeat the same `local prepare` command with the reviewed models and fresh answers, then restart `serve`. Reapproval atomically replaces launch JSON but preserves native login and the local key, even after the raw transfer file was removed. If writing the replacement fails, the previous launch file stays unchanged. Changing launch JSON while serving blocks later spawns.

### Serving with private environment configuration

Use `--config` and `--key-hash-file` together; they take precedence over environment configuration. Relative flag paths resolve from the current folder, but final paths must meet the launcher's canonical/private-file checks. The hash file must be regular, singly linked, non-symlinked, root/current-user owned, inaccessible to group/other users, and contain exactly 64 lowercase hex characters plus an optional newline.

With no flags, `relmio claude serve` reads:

| Variable | Value |
| --- | --- |
| `RELMIO_CLAUDE_LAUNCH_CONFIG` | Absolute canonical private launch-JSON path. |
| `RELMIO_CLAUDE_CHAT_TOKEN_SHA256` | SHA256 of the independent local Relmio bearer, exactly 64 lowercase hex characters; never the raw key or a provider credential. |

No prompt, environment, upstream, model or port override is accepted on the command line. Configure only the reviewed launcher fields above. Bare `relmio claude` is not setup; use `relmio claude --help` for supported subcommands.

## n8n OpenAI Chat Model

For n8n running directly in the same host network namespace, create an OpenAI credential (`openAiApi`):

| Credential field | Value |
| --- | --- |
| Base URL | Printed listener origin plus `/v1`, normally `http://127.0.0.1:14502/v1`. For Docker companion, use `http://relmio-claude:14502/v1`. |
| API Key | Private local Relmio bearer from setup, never a provider key or native token. |
| Organization ID | Blank. |
| Add Custom Header | Off. |

The credential test and From List picker call `/v1/models`. They prove private reachability/local bearer and list configured models, without starting Claude or proving login, entitlement, quota or inference.

Use OpenAI Chat Model v1.3 with a Basic LLM Chain, not an AI Agent:

| Setting | Required value |
| --- | --- |
| Model | From List or an exact approved ID, such as `claude-haiku-5-5`. |
| Use Responses API | **Off**; v1.3 defaults it on. `/v1/responses` is not served. |
| Built-in Tools, Extra Body | Empty. |
| Max Retries | `0`; editor/omitted default is 2. |
| Timeout | At least `135000` ms for the 120-second turn deadline and bounded cleanup. This is an SDK option, not a JSON request field. |
| Basic LLM Chain > Batch Processing > Batch Size | `1`; chain v1.7+ defaults to 5 even when unset. |
| Settings > Retry On Fail | Off; no workflow retries. |
| Output parser, fallback model, tools, images | Disconnected. |

Batching above one can spend allowance on the first item while others fail with `409` busy, after which n8n can discard the first result. There is no queue. The checked n8n 2.46.4 handler did not retry `409`, but can retry `502`, `504` and network failures when retries are enabled. Every retry is a new native run.

Turning Responses API off is insufficient when tools or Responses-only options make LangChain select it anyway. Keep the recipe text-only and leave tools/options empty. Actual n8n Stop behavior and streaming through n8n are not verified.

### HTTP Request node: final JSON

This alternative recipe was source-checked, not live-verified end to end. Use a Header Auth credential: name `Authorization`, value literal `Bearer ` followed by your private Relmio capability. Keep it in n8n's credential store.

| Setting | Value |
| --- | --- |
| Method / URL | `POST` to printed origin plus `/chat`, normally `http://127.0.0.1:14502/chat`; no `/v1` or query string. |
| Authentication | Generic Credential Type > Header Auth. |
| Headers | `Accept: application/json`; no extra Authorization, Origin or Host override. |
| Body | JSON, Using JSON; `Content-Type: application/json`. |
| Response | JSON; Include Response Headers and Status on; Never Error on. |
| Timeout | `135000` ms; documented initial-response timeout is not proof of full-run cancellation. |
| Redirects / pagination / retries | Off, including workflow automatic retries. |

Synthetic request body:

```json
{
  "input": "Reply with one short sentence about a triangle."
}
```

For dynamic input, use the whole JSON field in expression mode: `{{ { input: $json.prompt } }}` and require `prompt` to be a string. Do not interpolate into hand-built JSON. Optional `model` must be an approved ID; omitted uses the first model. Other fields, including `stream`, `messages`, `history` and `tools`, are rejected.

With full response enabled, require both `$json.statusCode === 200` and `$json.body.status === "completed"`, then read `$json.body.text`. Never Error exposes failure bodies for branching; it does not make failed inference successful. Network failures may have no adapter JSON. Submit one item at a time.

Success contains `status: "completed"`, `text`, exact `resolvedModel`, sanitized native token `usage` or null, and `quota: null`. Authenticated `/health` returns `status: "ok"`, `providerReadiness: "not-probed"`; it checks only the listener, not login, qualification, entitlement, quota or free capacity.

## Docker companion (VPS or local Docker n8n)

Use a separate companion when n8n already runs in Docker. It joins only n8n's selected existing private network, without editing n8n Compose/image or rebuilding/restarting n8n. With the CLI it is an operator-applied bundle; the [browser wizard](#browser-wizard-docker-companion) can instead deploy the same companion after your review and final confirmation. Neither is a permission grant. Never publish its port or mount a Docker socket/personal Claude directory.

The image downloads official Linux Claude Code `2.1.317` for `amd64` or `arm64` and checks the architecture-specific official SHA256. Preparation architecture must match the Docker host. The bundle pins the Compose build and runtime platform to that architecture. A checksum mismatch requires provenance review, not an edited expected hash to force a pass.

Compose uses alias `relmio-claude` on external `${N8N_DOCKER_NETWORK}`, no published ports, UID/GID `10001:10001`, read-only root filesystem, dropped capabilities, no-new-privileges, tmpfs `/tmp` and `/home/claude`, read-only `launch.json` and a persistent account volume. Container mode binds `0.0.0.0` internally but accepts only Host `relmio-claude:14502`, rejects Origin and requires the local bearer on every route. Host matching does not authenticate peer containers. Trust every network member; HTTP bearer traffic is unencrypted. The image's TCP healthcheck proves neither HTTP auth nor provider readiness.

### Prepare a private bundle

After reviewing the target's binary/policy/auth/model/billing boundary, use an interactive terminal on a macOS or Linux computer with Relmio. Choose a fresh private output folder and the inspected existing n8n Docker network:

```sh
relmio claude companion prepare "$HOME/relmio-claude-bundle" \
  --network n8n-network --arch amd64 --model claude-haiku-5-5
```

Replace `n8n-network` with the selected network name. Network names must be 1 to 128 letters, digits, dots, underscores or hyphens, starting with a letter/digit. `--arch` must match the Docker host: `amd64` (the default) for most VPS hosts, or `arm64` for Apple silicon/Colima. It selects the pinned launch checksum and writes `RELMIO_PLATFORM=linux/amd64` or `linux/arm64` in `.env`. Compose uses that platform pin for both build and runtime.

Repeat `--model` for the reviewed IDs; omitting it uses the three defaults listed above. An existing output folder must be empty and private (mode `0700`); nonempty output is refused. A missing folder is created with mode `0700` only after approval. Preparation copies the packaged templates and adapter/launcher into a build context; no source checkout or `dev/` files are required.

Like local approval, companion preparation needs an interactive terminal (stdin and stdout TTY) and asks four default-No questions for the target: the official Linux binary and checksum for the chosen architecture, the companion's effective Claude Code policy on that Docker host, the Claude account the companion will sign in to (your own plan, these models, extra usage off, and an `auth status` check before any prompt), and control of changes until expiry. Without a TTY, or after any answer other than yes, it writes nothing, not even the output folder. Yes answers become the review assertions in `launch.json`; Relmio records them but does not check them or prove native login. Never answer yes merely to make setup proceed. Complete and verify the target's own official login before any prompt. Initial qualification expires slightly before seven days.

### Bundle custody and operator deployment

Review the target's binary/policy/auth/model/billing before confirming preparation. Keep the private output directory outside the package/checkout, git, shared folders and logs. Prepared `.env` holds only the network, platform and key hash; `launch.json` holds qualification assertions; `n8n-api-key.txt` holds the independent local bearer. Configuration and secret files use mode `0600`.

For remote deployment, verify the SSH host key before authentication and obtain final confirmation for the exact target/writes. The managed Relmio VPS recipe uses only `/docker/n8n-openai-oauth/claude`; keep sibling deployments untouched. Copy the complete private bundle, including hidden `.env`, preserving modes; inspect existing target files before any replacement. These instructions do not authorize remote writes. On local Docker, use a separately reviewed private host folder.

On the Docker host, use the reviewed companion folder and an authorized Docker administrator account:

```sh
chown 10001:10001 launch.json
chmod 0600 launch.json
unset RELMIO_PLATFORM
docker compose config | grep platform
docker compose build
docker compose up -d
sh login.sh
```

A shell `RELMIO_PLATFORM` overrides `.env`; unset it and confirm `docker compose config` shows the platform chosen with `--arch`. A mismatched image fails the launcher's binary pin check (`binary_pin_mismatch`) instead of running.

Build traffic reaches the Node registry, Debian mirrors and Anthropic binary host. Login runs the pinned official executable inside the companion using `/home/claude`, `USER=claude`, `LOGNAME=claude`, `CLAUDE_CONFIG_DIR=/data/account/config` and empty cwd. The script needs an interactive terminal. A bundle prepared or replaced by this Relmio version prints the status summary with Node inside the companion, so the host needs `sh` and `docker`, not `python3`. An older `login.sh` already on the host still needs `python3` until that bundle is replaced. Complete your own official login, then require `loggedIn: true`, `authMethod: "claude.ai"` and the reviewed plan before inference.

On Linux, native stores its login in a protected file under the companion volume, not macOS Keychain. Host root, Docker administrators, volume access and backups can expose it. Relmio does not copy/export it; native still handles provider auth/refresh.

Set the n8n OpenAI credential's Base URL to `http://relmio-claude:14502/v1` and API Key to the private `n8n-api-key.txt` value without its newline. Save/test in n8n, then remove that transfer file from preparation/deployment copies after confirming the credential was saved. Do not print it into a command or workflow. Use the same text-only node settings above. A credential test does not run a prompt.

### Qualification renewal

Before expiry, repeat the binary/policy/auth/model/billing review and confirm policy changes remained controlled. The launcher accepts no window longer than seven days. Expired prompts fail even if `/health` and `/v1/models` still work.

The companion's `sh renew.sh` needs an interactive terminal (stdin and stdout TTY), host `python3`, and permission to manage the private launch file. It asks four default-No questions: the official Linux binary and checksum, the companion's effective Claude Code policy on that Docker host, dedicated login with these models and extra usage off, and control of changes until expiry. `auth status` must still show `loggedIn: true` and `authMethod: "claude.ai"`. A missing terminal, any answer other than yes, or end of input writes nothing. Yes on every question updates only the qualification timestamps in the UID-10001 launch file, to slightly less than seven days, and restarts only `relmio-claude`. The questions record a fresh owner review. The script does not inspect the binary, policy, or billing settings. Do not pipe a `y` answer. Changed binary, models, policy, account, or billing require full requalification, not only a new timestamp. Renewal does not rotate the bearer or erase login state.

## Browser wizard (Docker companion)

Since Relmio 0.24.0 the wizard can deploy the same companion that `relmio claude companion prepare` writes: on a VPS from `/claude-vps` (**Claude on my server**) and on this computer from `/local` (**Claude for n8n**). Both are experimental. Native n8n stays CLI-only; the wizard has no loopback endpoint for apps on this computer. Both flows use the CLI's bundle builder, so they share its Dockerfile, Compose file, `login.sh`, `renew.sh`, adapter files, pinned checksums, four review fields and approval of 7 days minus 1 hour. The step-by-step guide is [Set up in the browser wizard](claude-subscription.md#set-up-in-the-browser-wizard).

Sign-in stays in your own terminal. The VPS wizard shows `ssh -t root@<host> sh /docker/n8n-openai-oauth/claude/login.sh`, with `-p <port>` only for a port other than 22 and the username taken from the verified direct-root session. The local wizard shows `relmio claude companion login`, which needs an interactive terminal and runs the pinned `auth login` inside the companion through Relmio's attested local Docker host, with a 900-second limit. Relmio never handles the paste code or Claude credentials.

**Check sign-in** runs `auth status --json` inside the companion with the login script's environment. The raw output reaches Relmio's local server (over SSH for a VPS) and can hold more account details than three fields. The server forwards only `loggedIn`, `authMethod` and `subscriptionType` to the browser, and does not store or log the rest. Ready needs `loggedIn: true` and `authMethod: "claude.ai"`. **Check models** passes the one-time key to a probe inside the container on standard input and returns only the approved model IDs. It sends no Claude prompt, so neither check proves entitlement.

Ownership: a wizard install writes `.managed-by-relmio.json` into the companion folder (schema 1, kind `relmio-claude-companion`, install ID, network, architecture, models, the key's SHA256 and file hashes). The folder is `/docker/n8n-openai-oauth/claude` on a VPS, with the operation lock `/docker/n8n-openai-oauth/.claude-operation.lock`, and `~/.relmio/local/n8n-claude-oauth` locally. The marker goes first, so an interrupted install stays owned and can be replaced or removed. Before each action Relmio checks entries, owners, modes and hashes, and the container: labels, key hash, image `relmio-claude:2.1.317`, user `10001:10001`, read-only root filesystem, all capabilities dropped, no-new-privileges, one network with the `relmio-claude` alias, no published ports, and only the login volume and the read-only `launch.json` bind. On a VPS the hashes leave out `launch.json`, because renewals rewrite it; it is compared with the expected companion configuration instead. Anything unrecognized is refused and nothing is adopted or deleted. Only one `relmio-claude` companion can exist per Docker host.

A VPS folder without a marker but with a `relmio-claude` container labeled `com.relmio.managed=claude-companion` counts as a manual installation made with the CLI. The only action allowed on it is **Replace companion and key**, which keeps the login volume and issues a new key. The local wizard does not take over a manual companion; it refuses and asks you to remove it first.

Renewal needs all four review answers again. On a VPS it replaces `launch.json` the way `renew.sh` does (exclusive `launch.json.next`, owner `10001:10001`, mode `0600`, one link, sync, atomic rename) and restarts only `relmio-claude`. Locally it rewrites `launch.json` and restarts only that container. Sign-out runs `auth logout` inside the companion and checks status afterward. VPS removal deletes the container, the `relmio-claude_claude-account` login volume and the exact bundle files. Local removal runs `docker compose down --volumes`, removes the owned image and the managed files, unless you tick **Keep my Claude sign-in for a reinstall**. That option leaves the login volume, including any account lock in it. It is retention, not lock recovery. Unlike `docker compose down` above, wizard removal without that option deletes the login volume. It never touches n8n or its network. Replacing the companion while keeping the login also keeps the lock. Relmio does not clear `.relmio-claude.lock` automatically.

## Text API and streaming contract

All routes require the same bearer, exact Host and no Origin. POST routes require JSON and reject content encoding. `/v1/models` lists approved IDs in configured order, without probing Anthropic.

`/v1/chat/completions` requires an approved `model` and 1 to 1024 nonempty text messages ending in role `user`. `system`/`developer` text is joined under `Instructions:`; user/assistant rows become plain `User:`/`Assistant:` labels in one prompt. A lone user message is sent unchanged. Optional names are dropped. Text-part arrays are concatenated; images/audio/files, tool rows/calls/results and unknown message keys are rejected. Labels inside caller text do not create another native turn.

### Accepted but ignored fields

Claude Code has no per-request sampling controls here. These compatibility fields are validated but never applied:

| Field | Accepted value |
| --- | --- |
| `temperature`, `top_p` | Finite 0 to 2 / 0 to 1. |
| `frequency_penalty`, `presence_penalty` | Finite -2 to 2. |
| `max_tokens`, `max_completion_tokens` | Positive safe integers; sending both is rejected. Neither truncates output. |
| `stop` | String, or 1 to 4 strings; does not stop output. |
| `seed`, `user`, `store` | Safe integer / string / boolean. |
| `metadata` | At most 16 string pairs, keys <=64 characters, values <=512. |
| `service_tier` | `auto`, `default`, `flex`, `priority`, `scale`. |
| `reasoning_effort` | `none`, `minimal`, `low`, `medium`, `high`, `xhigh`. |

Empty/no-op compatibility values are `tools: []`, `tool_choice: "none"`, `parallel_tool_calls: false`, `n: 1`, `logprobs: false`, `response_format: {"type":"text"}`, `modalities: ["text"]`. Nonempty tools, forced tools, legacy functions, parallel calls, structured formats, extra choices, log probabilities, audio, prediction and web search are unsupported.

`stream` is optional boolean. `stream_options` is applied, not ignored: with `stream: true`, only `{"include_usage": true}` or `{"include_usage": false}` is accepted. Unknown top-level fields are rejected without echoing their names; known errors may expose a fixed parameter path.

### Chat Completions JSON and SSE

Non-streaming success is a `chat.completion` with assistant text in `choices[0].message.content`, `finish_reason: "stop"` and `usage` or null. Usage requires native input/output counts; prompt tokens include cache creation/read, completion tokens are native output and total is their safe-integer sum. Missing/invalid accounting is null, not zero or remaining quota.

For `stream: true`, errors before first text keep their non-2xx JSON status. First text opens HTTP 200 SSE with assistant-role chunk, then content chunks. Success ends with stop chunk, optional usage chunk and `data: [DONE]`. Failure after first text sends an error object and closes without stop/[DONE]. Partial text is not completed inference.

### Custom `/chat` SSE

Set `Accept: text/event-stream` on the same `/chat` body. A body `stream` option is not supported. Browser callers are rejected; do not embed the bearer in frontend code. Frames contain `event:` plus JSON `data:`:

| Event | Data |
| --- | --- |
| `delta` | `{ "text": <string> }` |
| `completed` | `{ "status": "completed", "resolvedModel": <exact model>, "usage": <object or null>, "quota": null }` |
| `error` | `{ "status": "failed", "resolvedModel": null, "error": { "code": <safe code> } }` |

Accumulate deltas once; completed repeats no answer text and has no [DONE] sentinel. Admission errors stay ordinary JSON. A broken/stalled/disconnected stream may have no terminal event; treat it as incomplete and do not automatically reconnect/replay. Thinking/signatures are not returned. Completion requires a validated terminal, exact model/runtime/request identity, clean child exit and confirmed owned cleanup; EOF or `message_stop` alone is insufficient.

## Bounds, cancellation and errors

| Limit | Launcher default |
| --- | --- |
| `/chat` body / decoded prompt | 16 KiB / 12 KiB UTF-8. |
| `/v1` body / flattened prompt | 256 KiB / 192 KiB UTF-8. |
| Answer / native line / total stdout / stderr | 128 KiB / 256 KiB / 1 MiB / 64 KiB. |
| Headers | 16 KiB, at most 32 raw headers; critical duplicates rejected. |
| Body read / admitted turn | 10 seconds / 120 seconds. |
| Buffered response / stalled write | 832 KiB / 10 seconds. |
| Owned termination | SIGINT, SIGTERM, SIGKILL; 500 ms grace at each stage. |

Empty/whitespace-only text, NUL and malformed Unicode are rejected. One slot lasts from admitted body read through confirmed cleanup. Disconnect cancels the owned request; the independent deadline bounds callers that do not disconnect. There is no request-ID cancel API. Actual n8n Stop is unverified. Cancellation cannot refund consumed allowance or undo upstream work.

Relmio starts no replacement child, account/model switch or paid fallback. Native can retry or make internal requests, so one prompt/process does not prove one upstream request or billable operation. Quota is always unavailable; Relmio issues no `/usage`, raw `get_usage` or separate quota probe. No fixed budget/reset promise follows from token totals.

| Failure | `/chat` HTTP | Action |
| --- | --- | --- |
| `unauthorized` | 401 | Fix independent local bearer, not provider login. |
| `forbidden` | 403 | Use exact loopback/companion Host and no Origin. |
| `invalid_request` | 400/404/413/415 | Correct input, route, size, headers or media; do not retry unchanged. |
| `busy` | 409 | Slot occupied, shutting down or cleanup uncertain; not provider quota. |
| `login_required` | 401 | Stop; inspect official native login through the reviewed environment. |
| `provider_quota` | 429 | Stop on native quota/credits rejection; no account switch or automatic retry. |
| `billing_required`, `model_unavailable` | 502 | Review billing/entitlement before another prompt. |
| `timeout` | 408 for body; 504 for turn | Bounded deadline exceeded. |
| `runtime_mismatch`, `unexpected_tools` | 502 | Stop and review qualification. |
| `invalid_upstream`, `upstream_failed` | 502 | Incomplete/invalid protocol or failed process; partial text is not success. |
| `cleanup_failed` | 503 | Owned teardown unconfirmed; slot and lock stay unavailable. |

`/chat` failures are `{ "status": "failed", "resolvedModel": null, "error": { "code": <code> } }`. `/v1` uses `{ "error": { "message", "type", "code", "param" } }`, maps quota to `rate_limit_exceeded`, uses 504 for slow bodies and 502 for cleanup failure; unsupported parameters are 400 and an unapproved model is 404. n8n's `OpenAI: Rate limit reached` label is its own error mapping, not a measured allowance. Native raw errors/stderr are not returned. Malformed HTTP/lost sockets can end without an envelope.

Launcher refusal codes include `launch_config_invalid`, `runtime_unqualified`, `unsafe_runtime_path`, `binary_pin_mismatch`, `runtime_changed` and `account_locked`. A pre-spawn refusal can appear as generic `upstream_failed` to HTTP callers. Requalify the cause rather than suppressing the check.

## Shutdown and account-lock recovery

Use Ctrl-C/SIGINT or SIGTERM for foreground serving. Shutdown cancels only owned work and releases the account-root lock after confirmed cleanup. It never scans/kills unrelated native sessions. Uncertain cleanup poisons the adapter, keeps later requests busy and retains the lock.

A crash, an out-of-memory kill or an unclean reboot can leave `.relmio-claude.lock` in the persistent login volume. The launcher fails closed with `account_locked` and never steals a stale-looking claim. The companion can then restart in a loop. Companions from 0.23.0 and 0.24.0 can show this. Relmio does not delete or bypass the lock. Removing or replacing the companion while keeping the Claude sign-in keeps the volume, so the lock stays too.

Recover only after you have stopped every container and process that uses that account, and confirmed none is still running:

1. For a companion restart loop, stop `relmio-claude` first. Then stop every other container and process that uses the same account volume.
2. Confirm none of them is running. An absent host PID is not enough: container PID reuse can hide a live holder. If you cannot confirm that, leave the service stopped and leave the lock in place.
3. When you have confirmed that no process or runtime still uses the account volume, manually remove only the inspected `.relmio-claude.lock`. Do not erase config or login data to bypass the lock.

The launcher never clears this lock for you. Keeping the login for a reinstall, or replacing the companion while keeping the login, does not clear it either.

To retire a companion, review and stop/remove only its Compose project with `docker compose down` in its exact folder; the external n8n network and named account volume remain. Removing the volume, including `--volumes`, deletes native login/account state and needs separate explicit deletion approval. Bundle-folder removal neither removes that volume nor revokes provider login. Remove the retired n8n connection separately in its UI; never delete sibling deployments or restart n8n.

## Verification record

These are sanitized, parent/owner-reported records from the original experiment, not checks run while porting this guide and not blanket acceptance of 0.23.0's packaged CLI. No private paths, addresses, account identifiers or credentials are retained here.

| Date / surface | Recorded evidence |
| --- | --- |
| 2026-11-03 source review | Final boundary review CLEAR; protocol review found no remaining actionable issues in revised thinking-progress/startup-auth/final-flush paths. Read-only; no runtime/provider execution. |
| 2026-11-04 original synthetic suite | `node --test test/claude-chat.test.js test/claude-launch.test.js`: 190 passed, 0 failed/skipped after parsing, built-in-mod, real-HOME, Chat Completions and multi-model changes. Node fixtures, not Claude. |
| Original standalone smoke | `node test/fixtures/claude-child.mjs --smoke` returned `{"json":"completed","sse":"completed","nativeStartup":false}`. |
| Original repository gate | `npm run check`: 1392 total, 1372 passed, 3 failed, 17 skipped. Failures were one copied Node fixture unable to resolve `@rpath/libnode.147.dylib` and two package allowlist mismatches for six existing research docs. The original doc/package run was 26 total, 24 passed, 2 failed; all 22 documentation assertions passed. These are historical failures, not this worktree's result. |
| Original maintenance checks | Lint passed for 159 JS files; release metadata check passed at the old development version 0.17.5. Neither result qualifies 0.23.0. |
| 2026-11-04 native qualification | Official `2.1.317` darwin-arm64 copy matched recorded manifest SHA256 `09f153b4…b5e9` and valid Anthropic signature. No local/MDM Claude policy found. Owner reported personal plan, extra usage off. Native status in adapter environment reported `loggedIn: true`, `authMethod: "claude.ai"`, `subscriptionType: "max"`. |
| 2026-11-04 direct `/chat` | Haiku 5.5 passed on attempt 6: HTTP 200, 2.2 seconds, completed text, exact `claude-haiku-5-5`; native usage input 2, output 37, cache creation 2463. Clean SIGTERM, owned group gone and lock released. Earlier undocumented-record/mod/skill parsing failures and unsaved isolated-HOME login were corrected; allowance used by attempts 1 to 4 is unknown. |
| 2026-11-04 native n8n | Native n8n 2.46.4 on Node 26.12.1, Manual Trigger → Basic LLM Chain (Batch Size 1) → OpenAI Chat Model v1.3, Responses off, Max Retries 0, Timeout 135000. Haiku succeeded first attempt in 1.7 seconds, n8n reported 2502 total tokens; model discovery and clean adapter shutdown passed. |
| 2026-11-04 native multi-model n8n | Same workflow, one attempt each: Sonnet 5.5 completed in 8.4 seconds (1664 prompt / 23 completion tokens), Opus 5.5 in 1.9 seconds (1736 / 23), with schema 2 approving Haiku/Sonnet/Opus 5.5. Exact native model checks passed. This establishes those completions on that account, not measured allowance or universal entitlement. |
| 2026-11-04 Hostinger Docker | Ubuntu 24.04 x86_64, Docker 29.2.1, n8n 2.44.6: official image checksum and hardened companion deployment passed. Private model discovery returned 401 without bearer and 200 with bearer for approved Haiku/Sonnet/Opus 5.5. Native login/status passed with `claude.ai` Max; login stored as a mode-0600 file in companion volume. |
| 2026-11-04 Hostinger n8n UI | Owner-reported credential save, model list and live prompt PASS after Responses API was turned off. The first attempt with Responses on returned 404 for unsupported `/v1/responses` before native startup. |
| 2026-11-04 local Docker | Owner-run on Colima 0.10.3 (arm64) with n8n 2.46.4 in Docker and an arm64 companion on n8n's private network. Login inside the companion PASS; `/v1/models` from the n8n container 401 without the key and 200 with three models; one live Haiku prompt from n8n PASS in about 3 s. The bundle was prepared with the pre-packaging script, before the `RELMIO_PLATFORM` pin. An n8n webhook through an ngrok tunnel PASS; the tunnel pointed only at n8n and the companion published no ports. Docker Desktop untested. |
| 2026-11-05 local wizard | Owner-run on a Mac mini with macOS, Colima 0.10.3 arm64, Docker 29.5.2 and n8n 2.46.4 in Docker. **Claude for n8n** review displayed arm64, pinned SHA256 and four unchecked questions. An unowned old image was refused without writes. Install first exposed a probe Host rejection and retained files after the key was lost; fixed before release with `Host: relmio-claude:14502` probes and rollback on failure. Removal deleted only the companion, login volume, image and managed files while n8n kept running; reinstall passed. One-time key shown once; terminal `relmio claude companion login` passed with `loggedIn: true`, `claude.ai`, Max (first attempt timed out after 15 minutes because code arrived late). Check sign-in confirmed Max. Check models listed three models without a prompt. One Haiku prompt from n8n Basic LLM Chain passed in about 6 seconds. |
| 2026-11-05 VPS wizard discovery | Owner-run on Hostinger, Ubuntu 24.04 x86_64, n8n 2.44.6. SSH host-key check matched pinned fingerprint; root-password connect, n8n discovery and network discovery passed. An older pre-release hand-made companion was correctly reported unrecognized and left unchanged. VPS install, replace, renew, sign-out and remove were not run live; unit and mocked-browser tests only. |
| Other VPS providers | Experimental, untested. |
| Remaining checks | n8n Stop/cancellation, streaming through n8n, HTTP Request end-to-end, installed retention/telemetry, broader platforms and distributed-product permission are unverified. |

The original native n8n install needed npm `--force` for Linux-only canvas dependencies on macOS. This is historical evidence, not a recommended install workaround. Its Node 26 runtime exceeded the then-published n8n npm-install guide range (20.19 through 24.x) despite package engine acceptance. Follow the [current n8n installation requirements](https://docs.n8n.io/deploy/host-n8n/install-options/install-with-npm) for your own installation.

Observed native login scopes on 2026-11-04 were `org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload user:plugins`. This records the login flow, not an exported token or minimum-scope guarantee. No scope implies product permission, included-only charges or quota-report support in this adapter.

## Sources and attribution

- [Current wizard source check](claude-wizard-source-check-2026-11-04.md): the browser wizard, companion data flows, Anthropic permission findings and the OpenAI comparison for this release.
- [2026-11-04 command-line source check](claude-native-prompt-source-check-2026-11-04.md): release-candidate provider/terms/data boundaries for the 0.23.0 CLI.
- [Historical 2026-11-03 source check](claude-native-prompt-source-check-2026-11-03.md): original candidate and older OpenAI comparison.
- [Feasibility review](claude-subscription-n8n-research-2026-11-03.md): rejected relay/replay design and ordinary API-key alternative.
- [Hermes Claude Subscription DirectSDK](https://hermes-agent.nousresearch.com/docs/plugins/claude-subscription-directsdk): disclosure structure, third-party usage measurements and native-record tolerance informed this experiment. Relmio does not use its upstream relay, credential interception, caller override or external-tool replay. Hermes source licensing does not confer Anthropic approval.

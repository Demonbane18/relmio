# Claude subscription for n8n (experimental)

> **Experimental. Not affiliated with or endorsed by Anthropic.** Relmio runs
> the unmodified official Claude Code CLI, which you install and log in to
> yourself through Anthropic's own sign-in, in your own terminal. Claude Code
> handles the login and its credentials. Relmio never reads, copies, refreshes
> or transmits them.
>
> This is for your own personal use only. It is not a shared or hosted service,
> so do not offer it to anyone else.
> [Anthropic's terms and usage policies](https://code.claude.com/docs/en/legal-and-compliance)
> apply. Anthropic's
> [Agent SDK quickstart](https://code.claude.com/docs/en/agent-sdk/quickstart)
> says that, unless previously approved, third-party developers may not offer
> Claude.ai login or rate limits for their products. Relmio offers no Claude
> login of its own, but the wizard does offer a Claude setup path, and that
> relates to the restriction even though sign-in stays in the official CLI in
> your own terminal. Relmio has no approval from Anthropic, and whether this
> use is permitted is unresolved. It may stop working or be disallowed at any
> time. The [current source check](claude-wizard-source-check-2026-11-04.md)
> records what was read and what stays open.

Relmio can answer n8n's OpenAI Chat Model node with your own Claude plan. A
small adapter runs one official `claude -p` turn for each request and returns
plain text. It is text only. Since Relmio 0.24.0 the browser wizard can set up
the Docker companion for you, on a VPS or on this computer. Native n8n and
everything else still use the `relmio claude` commands, which also stay
available for Docker as the advanced path.

## Requirements

- Relmio 0.24.0 or newer for the browser wizard (0.23.0 is enough for the
  commands alone) and Node.js 24 or newer, on macOS or Linux. Relmio refuses
  the `relmio claude` commands, including `relmio claude companion login`, on
  other systems.
- Claude Code 2.1.317 exactly, from Anthropic. For native n8n you install it
  yourself with Anthropic's
  [installer for a specific version](https://code.claude.com/docs/en/setup#install-a-specific-version).
  The Docker companion downloads it for you. Relmio refuses any other version.
- Your own Claude plan that includes Claude Code. Relmio has been tested with
  a Max plan only. Turn extra usage off first.
- n8n that you host yourself: native n8n on the same computer, or n8n in
  Docker on a VPS or on this computer. n8n Cloud cannot reach the adapter.
- For n8n in Docker: Docker Engine with Compose, the name of the Docker network
  n8n uses, and an `amd64` or `arm64` host. The build downloads the Node image,
  Debian packages and the Claude Code binary, and checks the binary's official
  SHA256. The VPS wizard also needs a direct root (UID 0) SSH login.
  **Passwordless sudo -n (model only)** cannot manage Claude.

## How it works

1. n8n's OpenAI Chat Model node sends a Chat Completions request to the
   adapter, with a Relmio access key as its API key.
2. The adapter checks the key, the Host header and the request. It joins the
   messages into one prompt and starts a fresh `claude -p` process: one turn,
   no tools, no MCP servers and no saved session. The prompt goes in through
   standard input, never the command line.
3. Claude Code uses your own login to answer. The adapter returns the text to
   n8n as a normal or streamed Chat Completions response.

Login, token refresh and credential storage stay with Claude Code. Relmio adds
no relay between Claude Code and Anthropic and does not change the caller name
Claude Code reports. The Relmio access key opens only the adapter. It is not an
Anthropic or OpenAI key, and Claude Code never receives it.

With native n8n, Claude Code runs with your real home folder, because macOS
finds the login Keychain through it. Its account settings stay in a separate
config folder. Anything else it reads or writes through your home folder, such
as caches and logs, is ordinary home data that your backups and administrators
can reach.

Before Claude can run, you confirm a four-part review: the official binary and
its checksum, the managed Claude Code policy on the machine, your own login
with extra usage off, and that none of these change until approval ends.
Relmio saves your answers in a private launch file that expires, and the
adapter refuses to start Claude after that. The answers record your review.
Relmio does not check policy, login or billing for you.

## Set up in the browser wizard

The wizard sets up the Docker companion on a VPS or on this computer. Both
flows are marked **Experimental** and **Official sign-in**. Native n8n is not
covered: it keeps the [command-line setup](#native-n8n-on-the-same-computer).

The wizard checks the server, Docker and n8n, shows the pinned Claude Code
version and its official SHA256, asks the four review questions and shows the
exact plan. Only after a separate final confirmation does it write files, build
the companion and start it. It then shows your n8n key once, checks sign-in and
model listing, and handles approval renewal, sign-out and removal.

You sign in yourself, in your own terminal. The wizard shows one command and
never asks for, sees or relays the paste code. Relmio never reads, copies or
transmits your Claude login. **Check sign-in** runs Claude Code's own
`auth status --json` inside the companion. That raw output travels to Relmio's
local server (over SSH for a VPS) and can hold more account details than
three fields. Relmio's server forwards only `loggedIn`, `authMethod` and
`subscriptionType` to the browser and does not store or log the rest.

### Claude on your VPS

The VPS wizard needs a Linux host with GNU coreutils, including `stat -c`,
[`sync FILE`](https://www.gnu.org/software/coreutils/manual/html_node/sync-invocation.html)
and `mv -fT` for private approval-file replacement. BSD/macOS command forms
are not supported on the VPS.

1. Run `relmio vps` and choose **Claude on my server**. From the screen for a
   detected n8n you can instead choose **Claude** under **Other companions**,
   which keeps the SSH connection you already verified.
2. Enter the server address and SSH port. Compare the SSH fingerprint with one
   you trust and confirm it. Then enter the username (normally `root`) and
   choose a password or **Local SSH agent**.
3. Pick the running n8n container and the Docker network it uses. The page
   reports the companion as not installed, a manual installation (made with the
   commands below), installed by the wizard, or unrecognized. Relmio changes
   only a companion it recognizes as its own or as a manual one, and refuses
   an unrecognized one without changing anything.
4. Review Claude use. The page shows the pinned Claude Code version and the
   official SHA256 for the server's architecture. It reads the architecture
   with `uname -m`: `x86_64` becomes `amd64`, `aarch64` or `arm64` becomes
   `arm64`, and anything else is refused. Choose the models (Sonnet 5.5 is
   preselected; Haiku 5.5 and Opus 5.5 are optional; Fable is refused) and
   answer the four review questions. The four checkboxes start unchecked and
   all of them must be checked.
5. Read the plan and confirm it. The plan lists the install folder, endpoint,
   architecture, models and approval expiry. It states that n8n is not changed
   or restarted and that no port is published. Relmio then writes to
   `/docker/n8n-openai-oauth/claude`, builds the companion and starts
   `relmio-claude` on n8n's network.
6. Copy the n8n API key. It is shown once, after an install or replacement.
   The server keeps only its SHA256.
7. Run the sign-in command in your own terminal. The wizard builds it from the
   host and port you verified:

   ```sh
   ssh -t root@<host> sh /docker/n8n-openai-oauth/claude/login.sh
   ```

   `<host>` is your server address. The username is the account you verified,
   and `-p <port>` appears only when the SSH port is not 22. Follow Claude
   Code's sign-in there, paste the code in that terminal and check the `state`
   as in the command-line steps. The script needs `python3` on the server.
8. In the wizard, choose **Check sign-in**. It is ready when it shows
   `loggedIn: true` and `authMethod: "claude.ai"`.
9. Create the credential in n8n as described in
   [Configure n8n](#configure-n8n). Then enter your saved key and choose
   **Check models**. That lists the approved models without sending a Claude
   prompt, so it does not prove your login. The key reaches the check on
   standard input inside the container, never in a command line.

Open **Manage companion and login storage** later for these actions. Each one
shows a plan and needs a final confirmation:

- **Renew approval** asks the four review questions again, rewrites only
  `launch.json` and restarts only `relmio-claude`. While the companion runs it
  first checks that Claude is signed in to a claude.ai plan. A companion that
  is not running, for example one that could not restart after its approval
  expired, cannot answer that check, so your four answers are the only check.
- **Replace companion and key** writes a fresh companion and a new n8n key and
  keeps the Claude login volume. It also repairs an incomplete installation and
  takes over a manual installation made with `relmio claude companion prepare`.
  The old bundle's `n8n-api-key.txt` is deleted. It needs the four questions.
- **Sign out** runs `claude auth logout` inside the companion and confirms that
  status reports signed out. The companion keeps running, and prompts fail
  with `login_required` until you sign in again.
- **Remove companion** deletes the container, the login volume (which signs
  Claude out) and the bundle files. It leaves n8n, its network and Docker's
  image cache alone.

### Claude on this computer

This flow needs macOS or Linux with n8n in local Docker. It is unavailable on
native Windows. Native n8n uses the command-line setup.

1. Run `relmio local`, choose **Add connection**, then **Claude for n8n**. For
   an n8n stack that Relmio created, **Add Claude** in the stack's add-ons does
   the same.
2. Enter the model IDs (one to eight, separated by commas; the three 5.5 models
   by default; Fable is refused), then pick the n8n container and its Docker
   network.
3. Review the plan. It shows Claude Code 2.1.317, the architecture that
   `docker info` reports and the official SHA256. Answer the four review
   questions (unchecked at first) and confirm the plan. Relmio builds
   `relmio-claude` in `~/.relmio/local/n8n-claude-oauth`, joins n8n's network
   and publishes no port. It does not restart n8n.
4. Copy the one-time n8n key. For an n8n that Relmio created, it also tries to
   add an OpenAI credential named **Relmio Claude**. For any other n8n you
   enter the key yourself.
5. Run the sign-in command in your own terminal:

   ```sh
   relmio claude companion login
   ```

   If you use NPX and do not have `relmio` on PATH, run:

   ```sh
   npx --yes --ignore-scripts relmio@latest claude companion login
   ```

   It needs an interactive terminal. It signs in inside the companion through
   Relmio's checked local Docker context, gives up after 15 minutes and prints
   only the filtered status afterward. Paste the code in that terminal, not in
   the browser.
6. In the wizard, choose **Check sign-in**, then **Check models** with your
   saved key. As on a VPS, neither proves model access.

The management panel offers **Renew approval** (four questions again),
**Sign out** and **Remove Claude**. Removal deletes the companion, its login
volume, its image and its managed files. n8n and its network stay.

Only one companion named `relmio-claude` can exist on a Docker host. The local
wizard does not take over a companion made with the commands: it stops and asks
you to remove that one yourself from its original bundle folder first. Removing
its login volume signs Claude out, and its old image has to go too. Relmio
changes nothing in that case.

Every renewal lasts 7 days minus 1 hour. The wizard shows the expiry and
**Renew approval** until it passes. See [Troubleshooting](troubleshooting.md)
for errors, and [Security](security.md#claude-companion-custody) for what the
Docker host can read.

## Set up with the command line (advanced)

Use this for native n8n, or for Docker when you want to build and copy the
bundle yourself. Run `relmio claude --help` to see every command and the same
disclaimer.

### Native n8n on the same computer

Use this when n8n runs directly on the computer, not in Docker. The adapter
listens only on `127.0.0.1`, which a Docker container cannot reach.

1. Install Relmio and create a private folder for the adapter. Point
   `--claude` at your Claude Code 2.1.317 executable. The path below is where
   Anthropic's native installer puts that version.

   ```sh
   npm install --global --ignore-scripts relmio@latest
   relmio claude local init ~/relmio-claude --claude ~/.local/share/claude/versions/2.1.317
   ```

   It prints the binary's path and SHA256 and a sign-in command. Compare the
   SHA256 with Anthropic's
   [2.1.317 manifest](https://downloads.claude.ai/claude-code-releases/2.1.317/manifest.json).
   Relmio does not run Claude Code at this step.

2. Run the printed `auth login` command and sign in with your own Claude
   account. This login belongs to the folder's own config, separate from your
   everyday Claude Code. When it asks for a code, paste the code from the same
   sign-in page and check that the part after `#` matches the `state` in the
   link it printed. Then run the same command with `auth status` in place of
   `auth login`. It must show `loggedIn: true` and `authMethod: "claude.ai"`.

3. Answer the review questions in an interactive terminal:

   ```sh
   relmio claude local prepare ~/relmio-claude --claude ~/.local/share/claude/versions/2.1.317
   ```

   Each of the four questions defaults to No, and anything other than yes
   writes nothing. On approval Relmio writes `launch.json` and, the first
   time, `key.sha256` and `n8n-api-key.txt`, all readable only by you.
   Approval lasts 1 hour; `--hours` sets up to 168 (7 days). The models are
   `claude-haiku-5-5`, `claude-sonnet-5-5` and `claude-opus-5-5`. Pass
   `--model` once per model ID to replace that list.

4. Start the adapter and leave it running:

   ```sh
   relmio claude serve --config ~/relmio-claude/launch.json --key-hash-file ~/relmio-claude/key.sha256
   ```

   It listens on `http://127.0.0.1:14502` and starts Claude only when a
   request arrives. Press Control+C to stop it.

5. Put the text in `~/relmio-claude/n8n-api-key.txt` into the n8n credential
   described in [Configure n8n](#configure-n8n), then delete the file.

Before approval expires, run `relmio claude local prepare` again and restart
`serve`. Re-running keeps your login and access key.

### n8n in Docker (VPS or local Docker)

Use this when n8n runs in Docker and you want to build and copy the bundle
yourself; the wizard above does these steps for you. The companion is a
separate container that joins n8n's existing Docker network as
`relmio-claude`. It publishes no ports and does not change n8n. Never publish
its port or put it behind ngrok, a tunnel or a public proxy.

1. Prepare a bundle in an interactive terminal on a macOS or Linux computer
   with Relmio. Replace `proxy` with the Docker network your n8n container uses.
   `--arch` must match the Docker host: `amd64` (the default) for most VPS
   hosts, or `arm64` for Apple silicon/Colima. The bundle pins the Compose
   build and runtime platform through `RELMIO_PLATFORM` in `.env`, so the
   image's binary matches the approved checksum.

   ```sh
   relmio claude companion prepare ~/relmio-claude-bundle --network proxy --arch amd64
   ```

   It asks the same four review questions as local setup, adapted to the
   Docker host: the official Linux binary, the companion's Claude Code policy,
   the Claude account it will sign in to (your own plan, extra usage off) and
   keeping all of that unchanged. Each defaults to No, and anything other than
   yes writes nothing, not even the folder. Approval lasts 7 days minus 1
   hour. The folder holds the Dockerfile, Compose file, `login.sh`,
   `renew.sh`, the adapter and three private files: `.env`, `launch.json` and
   `n8n-api-key.txt`. Keep it out of git, shared folders and logs.

2. Copy the whole folder, including the hidden `.env`, to the Docker host and
   keep its file modes. On a VPS that Relmio manages, use
   `/docker/n8n-openai-oauth/claude`. Confirm the SSH host key before you
   connect, and confirm the writes before you copy anything.

   The VPS wizard lists a companion placed here as a manual installation.
   **Replace companion and key** can take it over and keeps its Claude login.

3. In that folder on the Docker host, as root or a Docker administrator,
   build, start and sign in:

   ```sh
   chown 10001:10001 launch.json
   chmod 0600 launch.json
   unset RELMIO_PLATFORM
   docker compose config | grep platform
   docker compose build
   docker compose up -d
   sh login.sh
   ```

   A `RELMIO_PLATFORM` set in your shell overrides the one in `.env`, so
   unset it and check that `docker compose config` shows the platform you
   chose with `--arch`. If they differ, the launcher refuses to start.

   `login.sh` runs Claude Code's sign-in inside the companion. Sign in with
   your own account, paste the code and check the `state` as in the native
   steps. The script then shows `auth status`, which must report
   `loggedIn: true` and `authMethod: "claude.ai"`. On Linux the login is a
   private file in the companion's Docker volume. Host root, Docker
   administrators and backups can read it.

4. Put the text in `n8n-api-key.txt` into the n8n credential described in
   [Configure n8n](#configure-n8n), then delete the file from the host and
   from the computer that prepared it.

Before approval expires, repeat the review and run `sh renew.sh` in the same
folder as root, in an interactive terminal. It needs `python3` on the host.
It asks four default-No questions, the same review as companion preparation:
the official binary, the companion's Claude Code policy, your own plan with
extra usage off, and keeping those unchanged. Every answer must be yes. Any
other answer, end of input, or a piped answer writes nothing. It checks the
login, extends approval, and restarts only `relmio-claude`.
Wizard-managed bundles refuse `renew.sh`; use **Renew approval** in the local
or VPS wizard so its ownership record stays consistent.
`docker compose down` removes the companion and keeps its login volume.
Deleting that volume deletes the stored Claude login. The
[technical guide](claude-native-prompt.md#docker-companion-vps-or-local-docker-n8n)
covers the container hardening and lock recovery.

## Configure n8n

Create an **OpenAI** credential in n8n:

| Field | Value |
| --- | --- |
| API Key | Your Relmio access key. In the wizard it is the one-time key it showed. Keep it in n8n's credential store, not in workflow JSON, expressions or URLs. |
| Base URL | `http://127.0.0.1:14502/v1` for native n8n, or `http://relmio-claude:14502/v1` for the Docker companion. |
| Organization ID | Blank. |
| Add Custom Header | Off. |

Testing the credential lists your approved models without running Claude. It
proves the network path and the access key, not your Claude login.

Use a **Basic LLM Chain** with an **OpenAI Chat Model**, not an AI Agent:

| Setting | Value |
| --- | --- |
| Model | From the list, or an exact approved ID such as `claude-sonnet-5-5`. |
| Use Responses API | Off. Node version 1.3 turns it on by default, and the adapter does not serve the Responses API. |
| Options > Max Retries | `0`. Every retry is a new Claude run. |
| Options > Timeout | `135000` ms or more. A turn may take up to 120 seconds plus cleanup. |
| Basic LLM Chain > Batch Size | `1`. The adapter runs one request at a time and has no queue. |
| Settings > Retry On Fail | Off, with no workflow retries. |
| Built-in tools, tools, output parser, fallback model, images | Leave empty or disconnected. |

## Limitations

- Text only. No tools, so no AI Agent tool workflows. No n8n AI Assistant, no
  Responses API and no images or files.
- Sampling settings such as temperature, top P, max tokens and stop sequences
  are accepted and ignored. Claude Code has no per-request controls for them.
- One request at a time. A second request gets `409 busy`; nothing waits in a
  queue.
- You confirm the review again when approval expires: after 1 hour by default
  with `relmio claude local prepare`, after 7 days minus 1 hour for the Docker
  companion (wizard or `prepare`), and never more than 7 days.
- Claude Code is pinned to 2.1.317. A newer version needs a Relmio release
  that qualifies it.
- Claude Code 2.1.317 sends some stream records that Anthropic does not
  document. The adapter ignores records it does not use, but stops the request
  if one of them signals a tool, subagent or command.
- Remaining plan allowance is not reported. The response's `usage` token
  counts are not a balance.
- Claude Code resolves some files through your home folder. A separate config
  folder and disabled session saving do not remove its other files, access by
  administrators, backups or Anthropic's own retention.
- Only the setups listed under [Status](#status) have been tested. Other VPS
  providers are untested.
- n8n must use the settings in [Configure n8n](#configure-n8n): Use Responses
  API off, Max Retries 0, Timeout at least 135000 ms and Batch Size 1.

## Subscription usage

[Anthropic says](https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan)
`claude -p` with a subscription login draws from your plan limits. Those limits
are shared with Claude on the web, desktop and mobile apps and in Claude Code.

[Measurements published by Hermes Agent](https://hermes-agent.nousresearch.com/docs/plugins/claude-subscription-directsdk)
suggest that `claude -p` can use up the 5-hour window faster than interactive
Claude Code for the same work. These are third-party observations, not a
stable multiplier, and Anthropic has not documented the weighting. Relmio does
not override the caller name Claude Code sends, so expect the `claude -p` rate.

Claude Code adds its own system prompt and context to each call. In earlier
small test calls that came to roughly 1,700 to 2,500 prompt tokens, which n8n's
token counts include. Treat it as an observation, not a fixed size per call.

Turn extra usage off in your Claude account. Relmio refuses Fable model IDs,
because `claude -p` can bill Fable to usage credits without asking. Any other
extra-usage billing follows your account setting, which Relmio cannot see or
change.

Relmio adds no retries, account switching, model switching or paid fallback.
Claude Code can still retry on its own, so one request does not prove one
upstream call.

## Status

| Setup | Result |
| --- | --- |
| Native adapter with native n8n 2.46.4 on an Apple silicon Mac mini | Passed on 2026-11-04 with Haiku 5.5, Sonnet 5.5 and Opus 5.5 on a Max plan. |
| Docker companion on a Hostinger VPS (Ubuntu 24.04, x86_64) with n8n 2.44.6 in Docker | Companion install and private model discovery passed on 2026-11-04. On 2026-11-05, owner-run wizard discovery passed after the SSH host key matched the pinned fingerprint and root-password connection; n8n and network discovery passed. An older hand-made pre-release companion was reported unrecognized and left unchanged. Wizard install, replace, renew, sign-out and removal were not run live; unit and mocked-browser tests only. |
| Docker companion on local Docker (Colima 0.10.3, arm64) with n8n 2.46.4 in Docker | Companion login, credential, reachability and live Haiku prompt passed on 2026-11-04 using the pre-packaging prepare script. On 2026-11-05, owner-run **Claude for n8n** wizard flow passed end to end on macOS with Docker 29.5.2: review showed arm64, pinned SHA256 and four unchecked boxes; an unowned old image was refused without writes; install, one-time key, terminal sign-in, model check and Basic LLM Chain Haiku prompt passed. Remove deleted only the companion, login volume, image and managed files; n8n kept running. Reinstall passed. The first install exposed a rejected probe Host and retained managed files after a lost key; both were fixed before release with `Host: relmio-claude:14502` probes and failure rollback. |
| Local Docker n8n behind an ngrok tunnel | Passed on 2026-11-04 for an n8n webhook through ngrok. The companion stayed private: it publishes no ports and the tunnel points only at n8n. Docker Desktop is untested. |
| Browser wizard live coverage | Local **Claude for n8n** passed on 2026-11-05 as above. Hostinger VPS discovery passed, but install, replace, renew, sign-out and remove were not run live. VPS behavior beyond discovery has unit and mocked-browser coverage only. |
| Other VPS providers and native n8n on Linux | Experimental and untested. |
| n8n's Stop button and streaming through n8n | Untested. |

These owner-run checks cover one account and the listed machines only. The
2026-11-05 local wizard run does not qualify other machines, accounts or VPS
wizard actions not run live.

The [technical guide](claude-native-prompt.md) lists the endpoints, limits,
error codes and the full [verification record](claude-native-prompt.md#verification-record).
The [wizard source check](claude-wizard-source-check-2026-11-04.md) is the
current record for this release: what the wizard and companion read, store and
send, and the Anthropic and OpenAI pages it was checked against. The earlier
[official-source check](claude-native-prompt-source-check-2026-11-04.md) covers
the command-line adapter.

## Use an Anthropic API key instead

For AI Agent workflows with tools, use n8n's own Anthropic Chat Model with an
API key from the Claude Console. That route needs no Relmio adapter and uses
API billing and limits instead of your plan's included usage. Eligible Max,
Ultra and Team plans include a
[monthly API credit](https://support.claude.com/en/articles/17154008-monthly-api-credits-for-max-ultra-and-team-plans)
once you link a Console organization. The credit does not roll over, so check
your Console billing settings, such as auto-reload, before you rely on it.

The [feasibility review](claude-subscription-n8n-research-2026-11-03.md)
compares the two routes.

## Attribution

Claude and Claude Code are Anthropic products. Relmio is an independent project.
The
[Claude Subscription DirectSDK plugin for Hermes Agent](https://hermes-agent.nousresearch.com/docs/plugins/claude-subscription-directsdk)
by Nous Research informed this page's disclosures and the adapter's handling of
undocumented stream records, and its usage measurements are cited above. Relmio
does not use its relay, credential interception, caller-name override or tool
replay.

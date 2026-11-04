# Claude subscription for n8n (experimental)

> **Experimental. Not affiliated with or endorsed by Anthropic.** Relmio runs
> the unmodified official Claude Code CLI, which you install and log in to
> yourself through Anthropic's own sign-in. Claude Code handles the login and
> its credentials. Relmio never opens, copies, refreshes or transmits them.
>
> This is for your own personal use only. It is not a shared or hosted service,
> so do not offer it to anyone else.
> [Anthropic's terms and usage policies](https://code.claude.com/docs/en/legal-and-compliance)
> apply. Anthropic's
> [Agent SDK quickstart](https://code.claude.com/docs/en/agent-sdk/quickstart)
> says that, unless previously approved, third-party developers may not offer
> Claude.ai login or rate limits for their products. Relmio offers no Claude
> login of its own, but it has no approval from Anthropic, and whether this use
> is permitted is unresolved. It may stop working or be disallowed at any time.

Relmio 0.23.0 can answer n8n's OpenAI Chat Model node with your own Claude plan.
A small adapter on your machine runs one official `claude -p` turn for each
request and returns plain text. It is a command-line feature for one owner, with
no wizard screens, and it is text only.

## Requirements

- Relmio 0.23.0 or newer and Node.js 24 or newer, on macOS or Linux. Relmio
  refuses the `relmio claude` commands on other systems.
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
  SHA256.

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

## Set up

Run `relmio claude --help` to see every command and the same disclaimer.

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

Use this when n8n runs in Docker. The companion is a separate container that
joins n8n's existing Docker network as `relmio-claude`. It publishes no ports
and does not change n8n. Never publish its port or put it behind ngrok, a
tunnel or a public proxy.

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
`docker compose down` removes the companion and keeps its login volume.
Deleting that volume deletes the stored Claude login. The
[technical guide](claude-native-prompt.md#docker-companion-vps-or-local-docker-n8n)
covers the container hardening and lock recovery.

## Configure n8n

Create an **OpenAI** credential in n8n:

| Field | Value |
| --- | --- |
| API Key | Your Relmio access key. Keep it in n8n's credential store, not in workflow JSON, expressions or URLs. |
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
  companion, and never more than 7 days.
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
| Docker companion on a Hostinger VPS (Ubuntu 24.04, x86_64) with n8n 2.44.6 in Docker | Passed on 2026-11-04: login inside the companion, n8n credential and a live prompt. |
| Docker companion on local Docker (Colima 0.10.3, arm64) with n8n 2.46.4 in Docker | Passed on 2026-11-04: login inside the companion, credential, reachability (401 without the key, 200 with it) and a live Haiku prompt from n8n in about 3 seconds. The bundle came from the pre-packaging prepare script, before the platform pin was added. |
| Local Docker n8n behind an ngrok tunnel | Passed on 2026-11-04 for an n8n webhook through ngrok. The companion stayed private: it publishes no ports and the tunnel points only at n8n. Docker Desktop is untested. |
| Other VPS providers and native n8n on Linux | Experimental and untested. |
| n8n's Stop button and streaming through n8n | Untested. |

These passes are the owner's own runs, one account each, of the same adapter
before it was packaged as `relmio claude`. They do not qualify another machine
or account.

The [technical guide](claude-native-prompt.md) lists the endpoints, limits,
error codes and the full [verification record](claude-native-prompt.md#verification-record).
The [official-source check](claude-native-prompt-source-check-2026-11-04.md)
records what Relmio reads, stores and sends, and the Anthropic pages it was
checked against.

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

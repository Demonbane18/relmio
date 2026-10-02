# Reference

Command and API details: dashboard commands, VPS authentication and privilege,
Chat Adapter tests, the raw Codex App Server command and the wizard tester API.

## Installed dashboard commands

These commands manage the current operating-system account's Relmio dashboard
on `127.0.0.1`. They do not manage n8n, ngrok, Relmio companions, or installed
endpoints.

| Command | Behavior |
| --- | --- |
| `relmio start` | Start the owner-scoped dashboard without opening a browser. |
| `relmio status` | Inspect the owner-scoped dashboard and print its current state. |
| `relmio open` | Start the dashboard if needed, then open its private local page. |
| `relmio stop` | Ask the verified owner-scoped dashboard to stop. |

`relmio stop` stops only the Relmio dashboard process. It never stops or
changes n8n, ngrok, a Relmio companion, or an installed endpoint. The commands
do not print the dashboard's control or browser credential. The dashboard
never returns or re-shows a stored secret.

The hosted install-page launchers still run a foreground one-shot wizard from
their temporary runtime. Use the installed package when you want the persistent
dashboard lifecycle above.

## VPS authentication and privilege

| Wizard control | Contract |
| --- | --- |
| **SSH username** | Actual existing account; provider/image hints do not replace administrator configuration. |
| **SSH authentication → Password** | An already-approved password login; never a sudo password or private-key field. |
| **SSH authentication → Local SSH agent** | Uses a supported agent available to the backend process. No key upload, passphrase collection, forwarding or automatic password fallback. |
| **Administrative context → Root account (UID 0)** | Must verify an actual UID-0 login. Existing credential-bearing VPS routes retain this requirement. |
| **Administrative context → Passwordless sudo -n (model only)** | Explicit noninteractive effective-root context for local models and shared discovery; not OAuth bridge, Assistant or SuperGrok management. |

Confirm the server host key before authentication and the exact reviewed plan
before writes. The existing Docker context must already be `default`, targeting
the rootful `unix:///var/run/docker.sock` daemon that owns n8n. Rootless,
remote/custom contexts and Podman are not substitutes. The safe root-owned
`/docker` directory must already exist without group/other write permission.

Preparation checks bounded, root-owned, non-symlink Buildx current/default
selector files without printing them. Foreign/ambiguous selections or a saved
`instances/default` shadow are rejected; no pre-existing running builder is
required. It does not invoke the Buildx CLI or read `config.json` or nodegroup
secrets. Inherited `BUILDX_BUILDER`, `BUILDX_CONFIG`, `BUILDKIT_HOST`,
`DOCKER_CONFIG` and `COMPOSE_BAKE` overrides are rejected. Administrative
preparation has a 30-second deadline. Buildx `inspect` is not a safe substitute:
even without `--bootstrap`, it can write state and expose nodegroup secrets.

`DOCKER_BUILDKIT` is accepted only when unset, empty or `1`; the adapter does
not fall back to the classic builder. Confirmed build-capable commands use
command-local `BUILDX_CONFIG` at the reviewed operation-lock `buildx` child,
`BUILDX_BUILDER=default`, `DOCKER_BUILDKIT=1` and `COMPOSE_BAKE=false`.
Generated Compose `up` commands use `--no-build`; SuperGrok sign-in/sign-out
use the confined state too because Compose `run` can build an image.
The temporary state is not created by status or other nonbuilding actions.

| Flow | Reviewed temporary state beneath `/docker/n8n-openai-oauth` |
| --- | --- |
| Model install/retry | `.local-model-operation.lock/buildx` |
| SuperGrok install/sign-in/sign-out | `.supergrok-operation.lock/buildx` |
| OpenAI bridge install/update | `.openai-oauth-operation.lock/buildx` |

Creation requires final confirmation and the owned lock. Successful verified
cleanup removes only owned state; uncertainty can leave partial state and the
lock for administrator inspection. See [recovery limits](maintenance.md#vps-build-state-and-operation-lock-recovery).

`GET /api/ssh/capabilities` is a protected read-only capability report, not an
agent-key enumeration or proof that a host accepts a loaded key.
`GET /api/ssh/connection` returns the safe active administrative identity,
including account, authentication, privilege/scope and connection generation;
it does not return credentials or add presentation fields to the model plan.
Without an active session it returns only `{ "connected": false }`.
An existing dashboard keeps its launch environment. See [agent setup and
hosting guidance](hosting-compatibility.md#ssh-agent-and-administrative-access).

For the independent, interactive maintainer fixture, see the
[Linux acceptance harness](maintenance.md#linux-local-model-acceptance-harness).
It is not a production n8n setup or a hosted CI approval bypass.

## Chat Adapter test commands

The experimental Chat Adapter is a loopback-only, Relmio-specific `POST /chat`
service for trusted local backends or development servers. It is not OpenAI
`/v1` and it rejects browser `Origin` headers.

Set the endpoint, then read the one-time credential without typing the literal
credential into shell history:

```bash
export RELMIO_CHAT_BASE_URL="http://127.0.0.1:14501"
read -r -s RELMIO_CHAT_CLIENT_CREDENTIAL
printf '\n'
```

Start a conversation:

```bash
printf 'Authorization: Bearer %s\n' "$RELMIO_CHAT_CLIENT_CREDENTIAL" |
  curl --fail-with-body --silent --show-error \
    --request POST "$RELMIO_CHAT_BASE_URL/chat" \
    --header @- \
    --header "Content-Type: application/json" \
    --data '{"input":"Reply with exactly: adapter works"}'
```

Stream a conversation and inspect its explicit terminal state:

```bash
printf 'Authorization: Bearer %s\n' "$RELMIO_CHAT_CLIENT_CREDENTIAL" |
  curl --no-buffer --fail-with-body --silent --show-error \
    --request POST "$RELMIO_CHAT_BASE_URL/chat" \
    --header @- \
    --header "Accept: text/event-stream" \
    --header "Content-Type: application/json" \
    --data '{"input":"What is love? Answer conversationally."}'
```

The event order is `start`, `progress`, zero or more `delta` events, then one
`terminal`. Only `terminal: completed` is success. A failed terminal is
preceded by a redacted `error` event and must not be treated as a partial
answer.

Copy the returned `conversationId`, then send a continuation:

```bash
export RELMIO_CONVERSATION_ID="CONVERSATION_ID_FROM_THE_PREVIOUS_RESPONSE"
printf 'Authorization: Bearer %s\n' "$RELMIO_CHAT_CLIENT_CREDENTIAL" |
  curl --fail-with-body --silent --show-error \
    --request POST "$RELMIO_CHAT_BASE_URL/chat" \
    --header @- \
    --header "Content-Type: application/json" \
    --data "{\"input\":\"Continue with one short sentence.\",\"conversationId\":\"$RELMIO_CONVERSATION_ID\"}"
```

Unset the shell credential when finished:

```bash
unset RELMIO_CHAT_CLIENT_CREDENTIAL
```

## Raw Codex App Server command

The raw Codex App Server transport is JSON-RPC over WebSocket, experimental,
and high-trust. It is for trusted native clients only; it is not an
OpenAI-compatible `/v1` endpoint. Read the one-time local capability into a
named environment variable rather than placing it in the command:

```bash
read -r -s RELMIO_CODEX_CLIENT_CREDENTIAL
printf '\n'
codex --remote ws://127.0.0.1:14500 \
  --remote-auth-token-env RELMIO_CODEX_CLIENT_CREDENTIAL
unset RELMIO_CODEX_CLIENT_CREDENTIAL
```

Keep that capability private. A trusted Codex client can control the isolated
container and may be able to recover its ChatGPT session credential.

## Local wizard tester API

The browser never contacts the adapter directly. While the local wizard is
running, its same-origin, `X-Setup-Token` protected APIs are:

| Method | Route | Purpose |
| --- | --- | --- |
| `POST` | `/api/local/chat-test/key` | Issue one ephemeral RSA-OAEP public key |
| `POST` | `/api/local/chat-test/message` | Send encrypted credential and one bounded chat turn |
| `POST` | `/api/local/chat-test/reset` | Invalidate the tester key and clear the browser transcript |

The local proxy accepts only a literal `http://127.0.0.1:PORT` adapter base
URL and appends `/chat` itself.

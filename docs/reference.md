# Reference

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

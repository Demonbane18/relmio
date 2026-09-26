# OAuth callback-port source check

Review date: 2026-09-26

This review covers Relmio 0.17.5. Before Relmio starts the official Codex
browser login for an OpenAI OAuth bridge, it now checks whether another local
process already listens on the Codex callback port `localhost:1455`. The check
covers both IPv4 and IPv6 loopback. The release also adds troubleshooting
guidance for that failure and for MCP `Transport closed` errors. This is a
local reliability change. It is not a legal opinion and does not establish
account entitlement.

## Current official sources

- [Sign in with ChatGPT](https://help.openai.com/en/articles/20001410-sign-in-with-chatgpt)
- [Codex authentication](https://learn.chatgpt.com/docs/auth)
- [OpenAI Terms of Use](https://openai.com/policies/row-terms-of-use/)
- [OpenAI Services Agreement](https://openai.com/policies/services-agreement/)
- [OpenAI Privacy Policy](https://openai.com/policies/privacy-policy/)

The Help Center article and the Codex authentication page were retrieved
directly on the review date. At that time the Help Center page said it had
been updated two days earlier. The three policy pages returned HTTP 403 to
command-line retrieval and were not re-read for this release. The most recent
recorded review of those pages is in
[canonical-domain-source-check-2026-09-21.md](canonical-domain-source-check-2026-09-21.md).

## Findings

The Sign in with ChatGPT article describes identity sign-in for supported
external applications. The application receives name, email address, and
profile picture, and any additional access needs a separate permission
request. That identity-only description does not match or authorize Relmio's
third-party ChatGPT/Codex compatibility transport. This release does not
change that assessment.

The Codex authentication page says that `codex login` opens a browser, which
then returns credentials to Codex. It names the default local callback server
as `localhost:1455`. It lists "your local networking configuration blocks the
localhost callback" as a case where the browser flow may not work. It also
documents `cli_auth_credentials_store = "file"`, which writes `auth.json` under
`CODEX_HOME`. Admins can enforce that setting so that users cannot override
it. Relmio's preflight matches this documented callback design and does not
change the login command, its arguments, or its credential store.

## Relmio data flow for this release

- **Reads:** unchanged. The new preflight opens a TCP connection to
  `127.0.0.1:1455` and `[::1]:1455` on the user's own computer, sends no bytes,
  and closes it at once. It reads only whether a connection was accepted.
- **Stores:** unchanged. The preflight stores nothing. If a listener is found,
  Relmio does not create the pending sign-in directory.
- **Transmits:** unchanged. The preflight never leaves the loopback interface.
  The official Codex login still sends the browser sign-in to OpenAI. Relmio
  still seeds the resulting credential only into its owned bridge volume or,
  for VPS bridges, uploads it after explicit confirmation.
- **Logs:** unchanged. The wizard shows a fixed message that names port `1455`.
  Relmio does not log the other process's identity, prompts, or tokens.
- **OAuth scopes and permissions:** unchanged. No new scope or permission is
  requested, and the actual grant is not inspected or broadened.
- **Recipients:** unchanged. OpenAI receives the browser sign-in. The user's
  own n8n bridge receives the resulting credential.

## Unknowns and limits

- Whether OpenAI permits this exact compatibility transport for the account
  and use case remains unresolved.
- The Terms, Services Agreement, and Privacy Policy were not re-read in this
  review because of HTTP 403 responses. Their last recorded review is dated
  2026-09-21.
- If an admin enforces a non-file `cli_auth_credentials_store`, the file-based
  login that Relmio requests may be overridden. This release does not change
  or detect that behavior.
- A process that starts listening on port `1455` after the preflight can still
  intercept the callback. The existing five-minute timeout and troubleshooting
  guidance cover that case.

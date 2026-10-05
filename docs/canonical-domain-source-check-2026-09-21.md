# Canonical-domain source check

Review date: 2026-09-21

**Dated source review:** its OAuth and hosted-chat observations describe the
implementation on 2026-09-21, not the current local SIWC path. The domain and
redirect observations are limited to that review date; the public website's
`/api/chat` now returns `410 Gone`. See the
[2026-10-04 source check](openai-source-check-2026-10-04.md) for current local
flow evidence.

This review covers the change from `relmio.vercel.app` to
`relmio.jpfusin.tech` as Relmio's canonical public website. The former Vercel
hostname remains attached to the same project and is configured to redirect to
the matching path on the new hostname after deployment. This is a URL and
routing change only; it is not a legal opinion and does not establish account
entitlement.

## Current official sources

- [Sign in with ChatGPT](https://help.openai.com/en/articles/20001410-sign-in-with-chatgpt)
- [Codex authentication](https://learn.chatgpt.com/docs/auth)
- [GPT-5.6 Luna model](https://developers.openai.com/api/docs/models/gpt-5.6-luna)
- [OpenAI API authentication](https://developers.openai.com/api/reference/overview#authentication)
- [OpenAI Terms of Use](https://openai.com/policies/row-terms-of-use/)
- [OpenAI Services Agreement](https://openai.com/policies/services-agreement/)
- [OpenAI Privacy Policy](https://openai.com/policies/privacy-policy/)

The authentication, model, and API pages were retrieved directly. The Help
Center and policy pages returned HTTP 403 to command-line retrieval and were
reviewed in Opera GX instead. At review time, the Help Center article said it
was updated two months earlier, the Terms were effective January 1, 2026, the
Services Agreement was effective January 1, 2026, and the Privacy Policy was
updated September 10, 2026.

## Findings

The Sign in with ChatGPT article continues to describe identity sign-in for
supported external applications. It says the application receives name, email
address, and profile picture, while additional access requires a separate
permission request. It separately identifies account, authorization, device,
network, and security information that OpenAI may process for the sign-in.
That identity-only description does not match or authorize Relmio's
third-party ChatGPT/Codex compatibility transport.

The Codex authentication documentation still separates ChatGPT subscription
sign-in from usage-based API-key access and ties the chosen method to the
applicable workspace and data policies. The API documentation still describes
bearer API keys for OpenAI Platform requests. Relmio does not create or convert
the browser session into a Platform API key.

The GPT-5.6 Luna page continues to list the exact `gpt-5.6-luna` model ID,
Responses API, streaming, and text input/output. This proves only published
capability; it does not prove entitlement for a particular ChatGPT account,
OAuth grant, hosting network, or compatibility transport.

The individual Terms continue to prohibit credential sharing, programmatic
extraction, circumvention of restrictions, and bypassing protective measures.
The Services Agreement permits API integration for covered customers while
requiring individual credentials and separately restricting unauthorized use.
Neither document specifically approves Relmio's compatibility transport. The
Privacy Policy continues to describe collection of content, account, usage,
device, location, and log data and disclosure to service providers and other
listed recipients.

## Relmio data flow for this release

- **Reads:** unchanged. The hosted browser reads the user's prompt and the
  connected OAuth client's request headers. The hosted route reads the prompt,
  authorization session, and account context for that request.
- **Stores:** unchanged. The browser keeps at most six prompt/answer exchanges
  in current-tab React state and encrypts its stored OAuth session. Disconnect
  removes that browser session. The server does not retain a reusable OAuth
  session or conversation history.
- **Transmits:** unchanged. The browser sends the prompt and authorization
  headers to Relmio's hosted route. The route sends the prompt, fixed system
  instructions, `gpt-5.6-luna`, low reasoning effort, and streaming settings
  through the pinned OpenAI OAuth transport.
- **Logs:** unchanged. Relmio logs only fixed failure categories or upstream
  HTTP status categories. It does not deliberately log prompts, response
  bodies, authorization headers, account IDs, or OAuth tokens.
- **OAuth scopes and permissions:** unchanged. This release requests no new
  scope or permission and does not inspect or broaden the user's actual grant.
- **Recipients:** unchanged. The receiving parties remain the Relmio web host
  and OpenAI's ChatGPT/Codex backend, with their applicable infrastructure and
  subprocessors. The new custom hostname resolves to the existing Vercel
  project; Cloudflare provides DNS only and does not proxy application traffic.

Installer downloads move to the new hostname but deliver the same reviewed
scripts from the same Vercel project. After this release is deployed, the old
hostname redirects before serving the matching path. Local and VPS OAuth
bridges, n8n configuration, credentials, models, endpoints, and default scopes
do not change.

## Unknowns and limits

- Whether OpenAI permits this exact compatibility transport for the account
  and use case remains unresolved.
- The actual consent screen, granted scopes, and account entitlement were not
  inspected during this URL-only change.
- OpenAI-side retention and logging for this exact transport still depend on
  the account plan, workspace settings, and applicable agreement.
- Source review does not prove a production redirect or deployment. Those are
  separate release and post-deployment verification gates.

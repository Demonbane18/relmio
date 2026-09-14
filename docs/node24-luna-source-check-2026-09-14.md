# Node.js 24 and hosted Luna source check

Review date: 2026-09-14

This review covers the browser wizard's Node.js runtime requirement and the
hosted web chat's default model. It records technical and policy boundaries; it
is not a legal opinion and does not establish account entitlement.

## Current official sources

- [GPT-5.6 Luna model](https://developers.openai.com/api/docs/models/gpt-5.6-luna)
- [Sign in with ChatGPT](https://help.openai.com/en/articles/20001410-sign-in-with-chatgpt)
- [Codex authentication](https://learn.chatgpt.com/docs/auth)
- [OpenAI API authentication](https://developers.openai.com/api/reference/overview#authentication)
- [OpenAI Terms of Use](https://openai.com/policies/row-terms-of-use/)
- [OpenAI Services Agreement](https://openai.com/policies/services-agreement/)
- [OpenAI Privacy Policy](https://openai.com/policies/privacy-policy/)
- [Node.js releases](https://nodejs.org/en/about/previous-releases)
- [Node.js v22 to v24 migration](https://nodejs.org/en/blog/migrations/v22-to-v24)
- [Node.js 24.21.0 release files](https://nodejs.org/download/release/v24.21.0/)
- [Node.js 24.21.0 checksums](https://nodejs.org/download/release/v24.21.0/SHASUMS256.txt)

## Findings

The official model page identifies `gpt-5.6-luna` as the exact model ID and
lists the Responses API, streaming, and text input/output as supported. The
hosted chat already sends a bounded text request to `/responses`, so this update
changes only that request's model value and the synchronized visible label. It
does not add audio, image generation, fine-tuning, tools, or another endpoint.

Node.js 24 is an LTS release line. The official release index identified
24.21.0 as the latest Node.js 24 LTS release during this review and publishes
the macOS, Linux, and Windows archives used by Relmio. The POSIX and PowerShell
launchers continue to select the matching current `latest-v24.x` archive from
the official checksum manifest. The native CMD launcher pins 24.21.0 because it
uses reviewed embedded digests rather than evaluating remote manifest text:

| Archive | Official SHA-256 |
| --- | --- |
| `node-v24.21.0-win-x64.zip` | `158f7685b44de51f6c0df1d153526cbcd3e1bc739a8dfc607721cef75de9e541` |
| `node-v24.21.0-win-arm64.zip` | `8779b1bde1d39f8d420e3b57aa657b39891af434d3de44a919044cec06785921` |

The Node.js migration guide notes that Node.js 24 binaries require macOS 13.5
or newer, use OpenSSL 3.5 with stronger minimum key sizes, and include stricter
runtime validation. Relmio therefore requires its complete tests on Node.js 24;
this source review alone is not compatibility proof for every host.

## Identity, permission, and capability boundaries

The Sign in with ChatGPT article describes identity sign-in for supported
external applications and says name, email address, and profile image are the
identity information shared. Additional access requires a separate permission
request. That identity-only description does not match or authorize Relmio's
third-party ChatGPT/Codex compatibility transport.

The Codex authentication documentation separates ChatGPT subscription sign-in
from API-key usage-based access and says the chosen method controls the
applicable workspace and data policies. The API reference separately documents
API keys and workload identity for OpenAI Platform requests. Relmio does not
convert the browser session into a Platform API key.

The model page proves that the model ID and Responses capability exist in the
OpenAI API catalog. It does not prove that a particular ChatGPT account, OAuth
grant, hosted network, or compatibility transport can use the model. Identity
sign-in, any additional permission grant, and model capability remain separate
checks.

## Relmio data flow for the changed web chat

- **Reads:** the browser component reads the user's current prompt and asks the
  pinned OAuth client for authorization headers. The server route reads the
  prompt, authorization session, and account context for that request.
- **Stores:** the UI keeps at most six prompt/answer exchanges in React state for
  the current tab. Project copy states that the browser OAuth client encrypts
  its stored session and that disconnecting removes it. The Relmio server does
  not keep a reusable OAuth session or conversation history.
- **Transmits:** the browser sends the prompt and OAuth request headers to the
  Relmio web route. The server sends the prompt, fixed system instructions,
  `gpt-5.6-luna`, low reasoning effort, and streaming request settings through
  the pinned OpenAI OAuth transport. The receiving parties are the Relmio web
  host and OpenAI's ChatGPT/Codex backend; network and platform subprocessors
  may apply under their respective terms.
- **Logs:** Relmio logs only a fixed failure category or upstream HTTP status
  category for failed chat requests. It does not deliberately log prompts,
  response bodies, authorization headers, account IDs, or OAuth tokens. OpenAI
  documents collection of content, account, usage, device, and log data;
  provider-side retention for this exact compatibility flow remains unknown.

The changed Node.js requirement does not add a credential, provider, or data
recipient. The local and VPS OAuth bridge flows, their default scopes, and n8n
configuration are unchanged by this update.

## Terms and unresolved questions

The individual Terms prohibit credential sharing, programmatic extraction, and
bypassing restrictions or protective measures. The Services Agreement permits
API integration for covered customers while separately restricting shared
credentials, extracted data, and circumvention. Neither document specifically
approves Relmio's third-party ChatGPT/Codex credential transport.

Unresolved items:

- Whether OpenAI permits this exact compatibility transport for the account and
  use case remains unresolved.
- The actual OAuth consent screen, granted scopes, and account entitlement were
  not inspected in this source-only update.
- A live hosted `gpt-5.6-luna` response was not requested, so account and hosting
  availability remain unverified.
- OpenAI-side retention and logging for this exact flow require confirmation
  from the account's applicable plan, workspace settings, and agreement.
- Native Windows launcher execution remains a separate CI/acceptance gate; the
  reviewed checksums establish archive identity, not successful execution on
  every Windows host.

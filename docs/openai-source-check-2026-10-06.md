# OpenAI source check, 2026-10-06

This is a follow-up to [the 2026-10-05 check](openai-source-check-2026-10-05.md).
It covers two fixes: the wizard's model-list check during plan review, and the
VPS sidecar's Compose ownership check. No sign-in, provider request, credential
read or remote operation was part of this review.

## Sources

Retrieved on 2026-10-06. Developer pages show no update date.

| Source | Status | Displayed date |
| --- | --- | --- |
| [Sign in with ChatGPT (Help Center)](https://help.openai.com/en/articles/20001410-sign-in-with-chatgpt) | Retrieved | Updated 4 days ago |
| [Using your ChatGPT plan in other apps and sites](https://help.openai.com/en/articles/20001542-using-your-chatgpt-plan-in-other-apps-and-sites) | Retrieved | Updated 3 hours ago |
| [SIWC Quickstart](https://developers.openai.com/siwc/quickstart.md) | Retrieved | None |
| [Token sharing for open-source tools](https://developers.openai.com/siwc/token-sharing-open-source) and its sign-in, profiles and sessions, models and inference, Codex App Server, self-hosted VMs, token reference, errors and recovery, and preview limitations pages | Retrieved | None |
| [SIWC UI/UX guidelines](https://developers.openai.com/siwc/ui-ux-guidelines) | Retrieved | None |
| [Responses create reference](https://developers.openai.com/api/reference/resources/responses/methods/create.md) | Retrieved | None |
| [Sign in with ChatGPT (learn.chatgpt.com)](https://learn.chatgpt.com/docs/sign-in-with-chatgpt) | Retrieved | None |
| [Sign in with ChatGPT Terms](https://openai.com/policies/sign-in-with-chatgpt-terms/) | Retrieved | September 29, 2026 |
| [Service Terms](https://openai.com/policies/service-terms/) | Retrieved | September 29, 2026 |
| [Terms of Use](https://openai.com/policies/row-terms-of-use/) and [EU Terms of Use](https://openai.com/policies/eu-terms-of-use/) | Retrieved | January 1 and January 16, 2026 |
| [Usage policies](https://openai.com/policies/usage-policies/) | Retrieved | October 29, 2025 |
| [Privacy policy](https://openai.com/policies/privacy-policy/) and [EU privacy policy](https://openai.com/policies/eu-privacy-policy/) | Retrieved | July 30 and August 24, 2026 |

`https://developers.openai.com/siwc/sign-in` and
`https://developers.openai.com/siwc/models-and-inference` returned 404; their
content is under the token-sharing pages above.

## Findings

- The plan article now lists Go, Plus and Pro for plan use in participating
  apps, and says supported open-source tools remain available to all ChatGPT
  users. The 2026-10-05 check recorded Plus and Pro only. The Quickstart and
  partner directory still say Plus and Pro, so the official pages disagree.
  Relmio does not check the subscription tier in code.
- No other compared fact changed. Refresh still uses the issued client ID,
  refresh token and API resource without `scope`, and replacement tokens need
  no new consent. Model discovery still uses the selected account's bearer at
  `/v1/models`. Policy dates match the previous check.
- Identity sign-in, the separate plan permission and model capability are
  unchanged by these fixes. The model-list endpoint still requires a verified,
  connected, locally owned account with plan use enabled before and after
  discovery. A refreshed token no longer causes a false conflict, and a
  different selected account is still refused. A returned model list is not
  proof that a model request or TTS works.
- The Compose fix only accepts `command` and `entrypoint` when Docker reports
  them as `null` or omits them. Any value, including an empty list or string,
  is still rejected. Image and container checks are separate and unchanged.

## What Relmio reads, stores, transmits and logs

Neither fix changes this. The model-list endpoint reads the selected
registration, its account state and the account's model list. Registration
records stay in `N8N_OPENAI_OAUTH_HOME` or
`~/.n8n-openai-oauth/registrations/`. Refresh sends the refresh token, client
ID and resource to OpenAI's token endpoint, and discovery sends the bearer to
`https://api.openai.com/v1/models?client_version=0.160.0`. The browser receives
the sanitized account view, the model list or an error, never a provider token.

The Compose check reads the resolved Compose configuration over the reviewed
SSH session and writes nothing. When it passes, the existing reviewed session
transfer can run. It adds no transfer method, destination or permission.

No logging was added. OAuth scopes are unchanged:
`openid profile email offline_access resource.invoke chatgpt.tokens.use.direct`,
resource `https://api.openai.com/v1`. Recipients are unchanged: the local
Relmio process and its protected storage, the local browser, OpenAI's
authentication and API services, the selected VPS and its administrator, and
n8n through its separate local bearer.

## Unknowns

- Which plans are eligible is unclear while the Help Center and Quickstart
  disagree. Eligibility for an untested account or model is unverified.
- Still open from earlier checks: Relmio is not in the partner directory;
  persistent VPS token storage against SIWC Terms §1 and the n8n endpoint
  against §2 are unresolved; refresh-503 rotation, `earliest_refresh_at`, the
  undocumented `client_version`, provider log retention and per-account
  capability are not documented. `store: false` does not prove zero retention.

This review is not legal advice, Terms-compliance proof, OpenAI approval or
evidence of model or TTS access.

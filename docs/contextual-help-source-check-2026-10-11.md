# Contextual help source check, 2026-10-11

Official sources were retrieved on 2026-10-11 UTC for this help update. Help
copy was compared with `src/ui/siwc-controls.js`, `src/ui/app.js`, the existing
guide tips and the current setup, FAQ, security and recovery documentation.
The bundled help identifies the Relmio 0.22.1 candidate, development base commit
`b6b4c2ac4e6b055fa22a9feeac757fb9bb2ac2bd`, schema 1 and revision 1. This is
source provenance, not a statement that the candidate is published. The final
release commit, tag and registry artifact must be verified separately.

The release-preparation check retrieved the same official sources again on
2026-10-11 UTC. Identity, separately approved plan usage and model admission
remain distinct. This patch changes Help and Windows interaction/recovery,
not OAuth scopes, recipients, token exchange or capability entitlement.

The [Sign in with ChatGPT article](https://help.openai.com/en/articles/20001410-sign-in-with-chatgpt)
separates identity from separately approved plan usage. Some supported partners
can request eligible plan usage; the article does not establish Relmio partner
approval. The help therefore distinguishes identity-only, granted but paused
plan use, an unread plan notice, a ready account, usage limits and ownership.

The current [direct sign-in protocol](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)
describes the initial dynamic client and issued callback client, fresh state,
nonce and PKCE. The [token reference](https://developers.openai.com/siwc/token-sharing-open-source/token-reference)
includes direct-scope examples. Help changes no requested OAuth scope, token
exchange or sign-in flow. It guides the user to the already implemented separate
consent; granting identity does not grant plan permission or prove model access.
The existing identity scopes are `openid profile email`; plan usage additionally
uses `offline_access resource.invoke chatgpt.tokens.use.direct` for the OpenAI
resource. OpenAI receives the authorization and approved model requests. Relmio
keeps its protected local registration, and an explicitly reviewed destination
receives the selected credential session over SSH. The private compatibility
sidecar uses the separately pinned third-party runtime; this is not a general
Platform API credential or blanket provider approval. Help itself adds no
recipient, saved question, scope or request.

The [self-hosted VM guide](https://developers.openai.com/siwc/token-sharing-open-source/self-hosted-vms)
covers secure SSH transfer and destination-owned refresh, with limits around
host-specific attribution and revocation. A transferred registration is not
offered for local reuse. An unresolved handoff stays frozen pending review.

The [Codex authentication documentation](https://developers.openai.com/codex/auth/)
redirects to [the current authentication guide](https://learn.chatgpt.com/docs/auth)
and identifies sensitive credentials and API keys for programmatic CLI use.
The [Terms of Use](https://openai.com/policies/terms-of-use/) and
[privacy policy](https://openai.com/policies/privacy-policy/) were also checked.
None of these sources is treated as blanket provider, partner, legal or image
route approval. Model listing remains distinct from admission and a completed
request. Existing capability and policy unknowns remain documented in the
[previous implementation review](openai-source-check-2026-10-07.md).

## Help data handling

Help reads existing visible step/tip metadata, bounded account-state enums and
booleans, and the existing bounded error-code information. It receives no email,
account ID, token, SSH password or private key. Its FAQ is bundled and selected
locally. There is no model call, retrieval service, vector database or question
history. Opening help transmits no account data to an external party.

The existing walkthrough preference still uses the local wizard's guarded
`/api/ui/preferences` endpoint and local preference file. Opening, dismissing
or selecting a help topic does not save a question. Help adds no logging, scope
or external recipient. Existing sign-in and model data handling stays covered
by [Security](security.md).

Show me only highlights and focuses an enabled visible target. It does not
activate a control, acknowledge the plan notice, verify a host fingerprint,
select a destination or authorize a remote write. Unknown state, unsupported
metadata and missing targets provide a safe explanation. Browser verification
and live inference are separate acceptance checks, not implied by source or
unit-test evidence.

## 0.22.2 metadata update

On 2026-10-11 the bundled help metadata moved to Relmio 0.22.2, development
base commit `bedaa0f6aeadf76cbb3cbd254b4a0d41908c0426`, still schema 1 and
revision 1. No help text, FAQ entry or rule changed between 0.22.1 and 0.22.2
(`git log v0.22.1..bedaa0f -- src/ui/guide` is empty). For help, 0.22.2 changes
only where the dock and chip sit on screen; the help content, data handling and
sources above are unchanged.

## 0.22.3 metadata update

On 2026-10-22 the bundled help metadata source version moved to Relmio 0.22.3.
Help rules, FAQ entries, and guide steps did not change. Listed guides only
updated the Node.js reuse threshold. `validHelpMetadata` does not require
`sourceCommit` to match the package version, so it stays
`bedaa0f6aeadf76cbb3cbd254b4a0d41908c0426`, the last commit that changed help
behavior. `reviewedOn` is 2026-10-22 because those Node sentences were checked
again.

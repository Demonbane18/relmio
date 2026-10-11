# OpenAI source check: local image device-code controls

Checked 2026-10-11 UTC for the v0.22.1 candidate. This check covers the local
image sign-in code's presentation and explicit Copy code button, not a new
provider grant or image-generation test.

## Official sources fetched

- [Sign in with ChatGPT](https://help.openai.com/en/articles/20001410-sign-in-with-chatgpt)
  separates identity sign-in from additional permissions and plan use.
- [Codex authentication](https://developers.openai.com/codex/auth/)
  redirects to the official [authentication guide](https://learn.chatgpt.com/docs/auth).
  Its device-login section requires the person to open the provider's link,
  sign in, and enter a one-time code; device login may require account or
  workspace settings. No such settings are changed by this UI patch.
- [Image generation](https://developers.openai.com/api/docs/guides/image-generation)
  describes API capabilities, not approval or entitlement for Relmio's separate
  third-party Codex image route.
- [Terms of Use](https://openai.com/policies/terms-of-use/) and the
  [rest-of-world privacy policy](https://openai.com/policies/row-privacy-policy/)
  were reviewed. The generic privacy URL returned a Korea-specific page, so
  it is not treated as a universal regional policy.

## Comparison with the changed code

`src/ui/device-code.js`, its local-page integration and its static server
mapping do not change OAuth scopes, image login/start/cancel/status requests,
account selection, provider link, polling interval, expiry or image requests.
The existing optional renewable Codex image session remains separate from
identity sign-in and ChatGPT text-plan permission. This review does not assert
blanket Terms compliance, provider approval, image access or model availability.

The helper reads only the already displayed code from the local page. It
renders through `textContent`, retains the exact characters, and performs no
clipboard read. Rendering and polling do not copy; synthetic click events are
rejected. A trusted user click may write that displayed code to the operating
system clipboard through the browser Clipboard API. No new network recipient
is added. The person still enters it on the fixed OpenAI device-login page.

This patch adds no file, local-storage, telemetry or log persistence for code
values. Success and recovery text contain no code; errors are not logged.
Unchanged polling leaves the code node and selection intact. Rotation or expiry
clears the displayed code and suppresses stale asynchronous feedback. It does
not erase the OS clipboard or change the provider's stored grant.

## Recipients and remaining unknowns

The existing QA sidecar, local wizard server, browser and OpenAI authentication
service remain the existing flow's parties; auth/session storage is unchanged.
The explicit copy adds the user's OS clipboard as a local recipient. Clipboard
history, managers, other permitted applications or device synchronization may
retain or receive clipboard data according to the user's OS settings; Relmio
does not inspect, configure or promise control over them. The visible warning
continues to say to enter the code only at `auth.openai.com` and never share it.

Verification used dummy codes and mocked clipboard objects plus a source-derived
responsive fixture. No real code was inspected/copied, no provider consent was
automated, and no auth completion, image entitlement or generation was proven.
The live wizard caches assets at startup: updating these files alone does not
activate them. Its restart must be coordinated after the current private handoff
finishes or is cancelled; existing in-memory wizard state cannot be promised.

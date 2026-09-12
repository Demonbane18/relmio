# VPS and n8n

Relmio can add either OAuth companion beside an existing n8n VPS. Each companion
has its own provider sign-in, Docker volume, endpoint, and n8n credential.
SuperGrok does not require or read ChatGPT credentials.

| Connection | Private Base URL | n8n API-key field | Use Responses API |
| --- | --- | --- | --- |
| OpenAI OAuth with ChatGPT/Codex sign-in | `http://n8n-openai-oauth:10531/v1` | `local-only` placeholder | **On** in the Relmio OpenAI Chat Model v1.3 recipe |
| SuperGrok OAuth | `http://n8n-supergrok:14502/v1` | One-time local Relmio bearer | **Off** for workflow model nodes and Chat Hub |

The OpenAI bridge is unofficial, private, and policy-uncertain. ChatGPT sign-in
is not an OpenAI Platform API key. The SuperGrok adapter is experimental and
uses a fresh official Grok device sign-in.

Relmio writes only below `/docker/n8n-openai-oauth`. It does not edit, rebuild,
recreate, stop, or restart your n8n Compose project or image. Neither companion
publishes a host port.

## Use the wizard

1. Start Relmio and choose the provider. Complete ChatGPT/Codex sign-in for the
   OpenAI bridge, or choose SuperGrok and complete its device sign-in after the
   companion is installed.
2. Compare the shown SSH host fingerprint with your provider before you enter
   a password.
3. Select a running n8n container and one existing Docker network.
4. Review the plan and confirm it before Relmio writes anything remotely.
5. In n8n, use the matching private Base URL and Responses API setting from the
   table above, never `127.0.0.1`.
6. Select **Disconnect from VPS** when you finish the remote setup.

Relmio also closes the authenticated SSH session after 15 minutes of
inactivity. An active VPS operation holds a bounded lease so discovery or an
approved install can finish before the idle timer resumes.

## Update an existing OpenAI bridge

Installing a newer Relmio package on your computer does not replace the bridge
already running on the VPS. Start a Relmio release that contains the bridge
compatibility update, then use the same browser wizard:

1. Run `relmio vps` and reconnect to the VPS.
2. Compare and confirm its SSH host fingerprint.
3. Select the n8n container and Docker network.
4. Choose **OpenAI-OAuth/Codex bridge**, then select **Manage
   OpenAI-OAuth/Codex bridge**.
5. Choose **Review bridge update** and review the exact sidecar-only plan.
6. Select the confirmation checkbox, then choose **Update the bridge**.

Relmio performs the SSH update from the browser flow, so no separate VPS
terminal is required. It uploads the current local ChatGPT sign-in, keeps the
selected network, rebuilds and verifies only the owned sidecar inside
`/docker/n8n-openai-oauth`, and publishes no host port. n8n remains untouched.

Use `local-only` only for the OpenAI bridge. It is a placeholder, not an OpenAI
Platform API key. SuperGrok uses the one-time local bearer shown by its wizard.

## Next guides

- [Configure n8n nodes](./n8n-configuration.md)
- [SuperGrok on a VPS](./vps-supergrok.md)
- [AI Assistant companion](./ai-assistant.md)
- [Manual installation](./manual-install.md)
- [Troubleshooting](./troubleshooting.md)

## GPT Image 2.5 in n8n

A new OpenAI OAuth bridge includes `gpt-image-2.5-flare` and
`gpt-image-2.5-sunburst` in model discovery. For an existing managed bridge,
use its reviewed browser runtime-update action to install the current adapter;
upgrading only the Relmio dashboard does not update an already running bridge.
The local update preserves its saved sign-in. A VPS update follows its separate
reviewed sign-in upload flow. Both paths leave n8n unchanged.

The completion screen shows image IDs from the verified model response. In
n8n's OpenAI node, select **Image**, then **Generate an Image** or **Edit Image**,
and pick the exact model from the list. Use **By ID** when needed by your n8n
version. Existing `gpt-image-2` remains available. Do not use the generic
`gpt-image-2.5` as a model ID or select an image model for a text-chat recipe.

Both variants passed bounded generation and editing tests. Exact output
size and all options remain unverified; begin with low quality. Discovery is
not a promise of account entitlement. Live, Realtime and audio are separate
capabilities and remain unsupported through this bridge.

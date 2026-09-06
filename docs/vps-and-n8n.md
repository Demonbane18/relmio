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

Use `local-only` only for the OpenAI bridge. It is a placeholder, not an OpenAI
Platform API key. SuperGrok uses the one-time local bearer shown by its wizard.

## Next guides

- [Configure n8n nodes](./n8n-configuration.md)
- [SuperGrok on a VPS](./vps-supergrok.md)
- [AI Assistant companion](./ai-assistant.md)
- [Manual installation](./manual-install.md)
- [Troubleshooting](./troubleshooting.md)

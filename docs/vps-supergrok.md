# SuperGrok for n8n on a VPS

This unreleased candidate adds a browser setup for a private SuperGrok companion
on an existing n8n VPS. It uses the same pinned official Grok CLI, fresh-session
reader, Chat Completions adapter and account model discovery as local n8n.

Run the candidate's `relmio vps` wizard, then choose **Set up SuperGrok for n8n**.
You can also choose **SuperGrok companion** from the detected n8n management
screen. That link keeps the current wizard's verified SSH connection. ChatGPT
sign-in is not required for this flow.

1. Enter the VPS address. Check the SSH fingerprint against your provider before
   entering its root password. The password is held only for the SSH connection.
2. Select the running n8n container and its existing Docker network.
3. Review installation. Confirm the exact action before any remote write.
4. Save the newly generated **local bridge bearer** directly into an n8n OpenAI
   credential. Its Base URL is `http://n8n-supergrok:14502/v1`. The bearer is not an
   xAI API key; it is shown only in the current browser session.
5. Choose **Sign in with Grok**, review and confirm, then follow the official
   device-sign-in link and enter the displayed code. A fresh session stays inside
   the companion's Docker volume on the VPS. No local/Mac provider session is
   uploaded.
6. Choose **Check account models**. Use a returned model such as `grok-4.6` only
   when it is available to your account. A listed model may not support every tool.
7. **SuperGrok requires Use Responses API OFF.** In the workflow Editor, open the
   OpenAI Chat Model node and turn this switch off; also turn it off in Chat Hub's
   OpenAI provider settings. Leaving it on returns `404 not_found`. This differs
   from Relmio's **OpenAI OAuth/Codex recipe, which uses Responses API ON**.
   Recheck the switch whenever changing providers, save, and run a fresh test.
   For Assistant, use its custom OpenAI-compatible
   endpoint with the same URL, local bearer and text model ID. Assistant's sandbox
   is a separate companion with its own prerequisites.

Test n8n Chat, Assistant node-search, and an AI Agent with Calculator. Ask the
Agent to call Calculator for `317 * 29`, then verify both the tool result and the
model's final answer are `9193`. Relmio does not create these workflows or replace
your existing credentials or provider selections.

## Management and safety

The installation lives only in `/docker/n8n-openai-oauth/supergrok` and joins the
selected existing Docker network. The companion publishes no host port. Relmio
does not modify, rebuild, stop, recreate or restart n8n, its image or Compose file.
Sibling ChatGPT and Assistant installations remain untouched.

The wizard supports status, fresh device sign-in, cancellation of a pending
credential action, sign-out, and removal. Every change requires a reviewed plan
and confirmation. Removal deletes only the ownership-verified SuperGrok container,
credential-action container, auth volume and exact generated files. It leaves
the n8n network, other containers and build-image cache in place. A pending
sign-in must finish, expire or be cancelled before sign-out/removal.

Root-owned private files, content hashes, exact Docker identities, generated
resource names and ownership labels are checked before management. Name or
network-alias collisions fail closed. An exclusive operation directory and a
deterministic credential-action container prevent concurrent changes to the same
auth volume. Sign-in expires after 15 minutes; logout after one minute.

An interrupted SSH operation can leave
`/docker/n8n-openai-oauth/.supergrok-operation.lock`. Automatic stale-lock deletion
is deliberately unsupported: an administrator must first verify that no installer
operation is running, then remove that empty directory before retrying. An
incomplete owned installation can be reviewed and removed; it is never silently
overwritten. Do not delete an existing installation merely to recover a bearer
until you have considered its saved Grok session.

The VPS needs root SSH access, Docker with Compose, standard Linux `stat`, `find`
and `sha256sum`, outbound HTTPS for the pinned image/CLI and provider, and an
eligible Grok account. The shared `/docker/n8n-openai-oauth` root must be absent or
already marked as Relmio-managed; unmanaged files are not adopted automatically.

The adapter is experimental. Local/disposable test evidence does not establish
that it has passed acceptance on your production VPS. Review and approve that
specific installation separately. This feature does not authorize an npm publish,
release, merge or production deployment.

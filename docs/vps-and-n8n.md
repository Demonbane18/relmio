# VPS and n8n

Relmio can add private n8n companions beside an existing VPS installation,
update them, and turn on optional image generation. The ChatGPT sidecar uses a
separately authorized SIWC registration; SuperGrok uses its own session and
does not require or read ChatGPT credentials.

The VPS model setup is tested on Hostinger KVM VPS. Other Linux VPS hosts,
including Hetzner, are experimental. Use the actual SSH username for your
image and an approved local SSH agent or password; provider defaults are
guidance, not credentials to try automatically.


| Connection | Private Base URL | n8n API-key field | Use Responses API |
| --- | --- | --- | --- |
| ChatGPT plan use | `http://n8n-openai-oauth:10531/v1` | One-time local Relmio bearer | **On** for OpenAI Chat Model node 1.3 |
| SuperGrok OAuth | `http://n8n-supergrok:14502/v1` | One-time local Relmio bearer | **Off** for workflow model nodes and Chat Hub |
| Local Ollama model | `http://n8n-local-model:11434/v1` | `local-only` ignored placeholder | **Off** for the documented Chat Completions recipe |

The local plan route is not an OpenAI Platform API key. ChatGPT identity,
plan-use permission, model availability, and successful requests are distinct.
See the [OpenAI source check](openai-source-check-2026-10-04.md) for capability,
account, and data-handling limits.

Relmio's managed files stay below `/docker/n8n-openai-oauth`; the safe,
root-owned `/docker` parent must already exist. Docker manages the companion's
approved images, containers and volumes in its own data root. Relmio does not
edit, rebuild, recreate, execute inside, stop, or restart your n8n Compose
project or image. No companion publishes a host port.

Build-capable actions use temporary mode-`0700` Buildx state inside the reviewed
operation lock. Verified cleanup removes owned temporary state only; ambiguous
or interrupted cleanup retains the lock for administrator inspection. Registry
credentials are not copied, moved or printed for this state.

The local-model companion is not a provider sign-in or an OpenAI API-key
connection. Ollama's API has no authentication by default, so any container on
the selected Docker network can reach its model-management API. Choose a
trusted network. It runs one CPU-based model and needs outbound internet to
download the runtime and model weights even though Ollama cloud features are
disabled. See [Private local models](local-models.md) and
[Hosting compatibility](hosting-compatibility.md).

## Use the wizard

The browser wizard has five steps: **Choose setup**, **Check server**,
**Choose n8n**, **Review**, and **Ready**. The route chooser appears before
ChatGPT sign-in. It is available from stable `@latest` and hosted installers.

1. Choose the ChatGPT route and complete SIWC sign-in on this computer before
   choosing the server. An identity-only registration stays connected but
   cannot use models until you separately allow plan use in ChatGPT. SuperGrok
   uses its own device sign-in; **Local model · your VPS** needs no provider
   sign-in.
2. Enter the server address and port, then independently compare and confirm
   the SSH host fingerprint. Only after that, enter the actual SSH username
   and choose **Local SSH agent** or approved password authentication. Never
   upload a private key or enable root/password SSH just for this wizard.
3. Connect and check the verified administrative identity. The ChatGPT
   sidecar, SuperGrok and Assistant VPS operations require the approved
   direct-root connection; agent authentication does not change that privilege
   boundary. **Passwordless sudo -n (model only)** is limited to local-model
   management and common read-only discovery.
4. Select a running official n8n container and one eligible existing Docker
   network. Rootful Docker Engine, Compose v2 and Buildx must use the same
   local daemon in the selected administrative context. If SSH connected but
   this read-only check fails, fix the problem on the server and choose
   **Retry discovery**. The wizard keeps the verified connection and does not
   ask for the password again. Changing the server details requires a fresh
   identity check. Relmio then checks the installed sidecar on that n8n. The
   check does not change the sidecar, but a running sidecar may renew its
   ChatGPT sign-in and ask OpenAI for the account's model list. The main
   button then says what comes next:
   **Review the exact plan** for a new install, **Review sidecar update** when
   Relmio's sidecar already runs there, **Refresh ChatGPT sign-in** when that
   sidecar's sign-in needs a fresh sign-in, **Finish sidecar update** after an
   interrupted update, **Open recovery** for an interrupted install or
   migration, and **Review replacement** after the installed sign-in was
   signed out. A second install on the same n8n is refused, so these buttons
   open the matching controls instead.
5. Review the selected registration, verified SSH identity, target, and exact
   write plan. Confirm the SSH fingerprint before authentication and separately
   confirm the final remote write. Explicitly approve background n8n use.
   After installation, enter the one-time Relmio bearer manually in n8n. Select
   **Disconnect from VPS** when finished.

The first time you open the wizard, it asks whether to start the setup guide.
The guide points at each box and button in turn and explains errors with the
next step. See [Use the setup guide](getting-started.md#use-the-setup-guide).

The plan review shows short IDs for the selected n8n container and network.
Relmio checks those exact IDs again before its first write and before the
credential transfer. If either changed, the install stops and asks for a new
review. An interrupted install stays bound to the full reviewed target. After
the install completes, status and sign-out need only the same SSH host
identity and Docker network ID, so they keep working if n8n is recreated or
you change the SSH login method. A changed network is still refused.

The destination runtime has a distinct persistent host ID. Relmio freezes the
source registration before transferring it and clears sender tokens only after
the destination returns an attested receipt. Unknown transfer outcomes stay
frozen for inspection; the destination is the only refresh owner after a
confirmed handoff. The published SIWC VM guide and Terms do not resolve
persistent remote token storage, so these implementation safeguards are not
a provider approval claim.

### Recover an interrupted install

- **Install stopped partway:** status shows the install as staged. Select the
  account, choose the resume action, review the plan, and confirm it. Relmio
  continues the same installation without deleting data or starting a second
  refresh writer. Turning plan use on or off, or a token refresh, before you
  resume does not block it. If the session had already moved, the one-time
  key is replaced.
- **Destination accepted the session but the acknowledgment was lost:**
  choose the reconcile action and confirm it within five minutes of the
  review. Relmio reads the destination's receipt and finishes the handoff.
  Without a receipt, the sender stays frozen and needs a fresh sign-in; old
  tokens are never restored.
- **Switching to a fresh account after "not accepted":** allowed only after a
  confirmed not-accepted result. Relmio refuses while a one-off sidecar helper
  container is still present or if the original receipt appears.
- **Ownership moved but a finishing step failed:** the result still shows the
  one-time key once. Save it, but do not use it until the reported issue is
  resolved.

Relmio never restarts an old writer automatically.

See [Hosting compatibility](hosting-compatibility.md) for image-qualified
accounts on Hetzner, Contabo, AWS, DigitalOcean and OCI, local-agent setup,
the existing `/docker` prerequisite, and Render's separate manual private
service. A provider choice does not provision or repair the host.

Relmio also closes the authenticated SSH session after 15 minutes of
inactivity. An active VPS operation holds a bounded lease so discovery or an
approved install can finish before the idle timer resumes.

Every remote command has a finite deadline: 45 minutes by default, 30 minutes
for an image build, 2 minutes for the destination's handoff acceptance, and
5 minutes for publishing a managed file. When a deadline passes, Relmio closes
that command and reports an unknown remote outcome. It does not retry
automatically; inspect the target before trying again. Managed files are
published atomically under `/docker/n8n-openai-oauth` through an exclusive
temporary file and a rename. Relmio rejects symlinked, non-root-owned or
group/other-writable parent directories and symlinked or hard-linked targets.

## Install or manage the ChatGPT sidecar

The first install signs in locally, selects an authorized registration, and
reviews a fresh n8n target and network. Enter the one-time local Relmio bearer
shown after installation manually as n8n's credential:

```text
Base URL: http://n8n-openai-oauth:10531/v1
API key: <one-time Relmio bearer shown by the wizard>
Use Responses API: On
```

The sidecar uses the selected registration to discover public models and send
supported Responses requests. It rejects unsupported routes and parameters;
model discovery does not guarantee account entitlement or host admission.
Legacy credential-copy installations are never adopted automatically. The
reviewed VPS migration attests the exact old sidecar, image, network, and
protected credential ownership, archives the old managed Docker files under
`/docker/n8n-openai-oauth/legacy`, and writes a pending-migration marker before
stopping only that sidecar. The old `/docker/n8n-openai-oauth/auth/auth.json`
and credential volume stay offline; their token bytes are not copied into the
SIWC runtime.

The new SIWC record lives in `/docker/n8n-openai-oauth/siwc`, mounted inside
the container at `/home/node/.relmio-siwc`. It receives its own host identity
and becomes the only refresh owner after a matching transfer receipt. n8n is
unchanged. If stop or transfer is uncertain, the pending marker and old data
are retained, the old sidecar is not resumed automatically, and the transfer
must be inspected rather than retried blindly.

For an installed VPS account, Relmio verifies the managed Compose configuration
and target identity, stops the exact owned sidecar, confirms it is stopped, then
performs the selected sign-out or plan-disable operation. If it cannot attest
that state, it does not mutate the registration.

No port is published and n8n remains unchanged. ChatGPT plan use through a VM
is not described here as provider-approved: OpenAI's self-hosted VM guide and
SIWC Terms leave persistent remote token storage unresolved.

### Update the installed sidecar

Installing a newer Relmio package does not change a sidecar that is already
running. To rebuild an installed VPS sidecar from your current Relmio version,
connect to the server and select its n8n container and network. The main
button then reads **Review sidecar update**. It opens **Manage the installed
ChatGPT session**, checks the installed account again if the last check is
more than four minutes old, and runs the review in step 2. To do the same by
hand:

1. Open **Manage the installed ChatGPT session** and choose **Check installed
   account**. The panel says whether a newer sidecar runtime is available.
2. Choose **Review sidecar update**. The review shows how many runtime files
   change and the short image and container IDs. If nothing needs rebuilding,
   it says `Already current. Nothing to update.`
3. Select **I approve rebuilding and restarting only this owned sidecar**,
   which also names your SSH user, host and port. Then choose **Update the
   sidecar**. The account check and the review each expire after five
   minutes; check and review again if they do.

Relmio uploads this version's runtime files, builds a new image and replaces
only the sidecar container. The old container keeps serving while the image
builds, so the sidecar is unavailable only while it restarts. Relmio does not
rewrite the Compose file, so the one-time Relmio key stays the same. The
ChatGPT session stays in `/docker/n8n-openai-oauth/siwc` and is not
transferred again. n8n is not stopped or restarted, and no host port is
published. Relmio disconnects from the VPS when the update ends.

The sidecar must be running with plan use on. Pausing plan use stops the
sidecar, and Relmio refuses to update a stopped sidecar.

If the image build fails and Relmio can confirm the old sidecar is still the
one running, it keeps that sidecar and marks the install as complete again, so
status, pause and sign-out keep working. Review the update again later.

If the update stops partway for another reason, status reports `updating` and
the panel says the update did not finish. The main button reads **Finish
sidecar update**; it runs the same review. You can also choose **Check
installed account**, then **Review sidecar update**, and confirm to finish it.
Relmio rebuilds the image on every attempt. The staged-install resume and new
install plans for this server are refused until the update finishes. If the
new sidecar fails its checks, Relmio stops it and the update stays open for
another review. If Relmio cannot confirm that the sidecar stopped, do not use
it until you inspect it.

### Refresh the ChatGPT sign-in

The installed sidecar renews its own ChatGPT sign-in. If OpenAI stops
accepting it, or Relmio cannot confirm that a renewal worked, **Check
installed account** shows `Needs a fresh sign-in.`, and model checks may pause
with `Checks paused: ChatGPT sign-in is needed.` Relmio does not yet renew the
registration that the server's sidecar owns. OpenAI's guides renew a sign-in
by repeating it with the registration's saved client ID. Relmio instead makes
a new registration for the same ChatGPT account and gives it to the sidecar
through the reviewed replacement:

1. Open **Manage the installed ChatGPT session**, choose **Check installed
   account**, then **Refresh ChatGPT sign-in**. The button appears only when
   the panel says `Needs a fresh sign-in.`, and the main button on **Choose
   your n8n** then reads **Refresh ChatGPT sign-in** too. Sign in with the
   same ChatGPT account, and choose the same workspace, in the browser window
   Relmio opens. ChatGPT treats this as a new connection: it asks you to
   approve it again, and usage settings for the old connection, such as a
   weekly app limit, do not carry over. You can change the app name ChatGPT
   shows so you can tell the two apart.
2. If the new sign-in has a different email from the installed account,
   Relmio stops the refresh. To move the sidecar to another account on
   purpose, sign it out and use **Review replacement**. Relmio cannot tell two
   workspaces that share one email apart. Otherwise, allow ChatGPT plan use and
   read the plan notice if Relmio asks, then choose **Check the server**.
   Relmio reuses the verified SSH connection while it is open.
3. On **Choose your n8n**, the main button reads **Continue sign-in refresh**
   and opens the installed account's controls. Select the approval box and
   choose **Sign out and revoke**. Relmio stops only the sidecar, signs out the
   old sign-in and disconnects.
4. Reconnect to the same server and choose **Review replacement** within four
   minutes of the sign-out. After that, Relmio first asks for a one-off
   inspection of the stopped sidecar. Keep the account from the new sign-in
   selected: during a refresh, Relmio refuses to review the replacement with
   any other account saved on this computer.
5. Review the plan, select the replacement approval and the other approvals,
   and choose **Replace the sidecar**.
6. Copy the new one-time Relmio key into your n8n OpenAI credential, and into
   the Assistant's API key if you use it. The old key no longer works.
7. If you used image generation, turn it on again under
   [Turn on image generation](#turn-on-image-generation-optional). **Sign out
   and revoke** also signed out of images.

The sidecar is unavailable from the sign-out until the replacement finishes.
n8n is not stopped or restarted. The old registration's mapping stays offline
on the server, and its tokens and history are not reused.

Revoking the old sign-in does not remove its connection from ChatGPT. Once
the replacement works, you can disconnect the old Relmio connection under
**Settings > Security and login > Login connections** if ChatGPT lists it.
Check that you pick the old one.

### Turn on image generation (optional)

Image generation and editing are an opt-in add-on for an installed VPS
sidecar. The local sidecar has the same add-on; see
[Turn on image generation on this computer](local-endpoints.md#turn-on-image-generation-optional).
Read these points before you turn it on:

- It uses a separate Codex sign-in, the way Hermes Agent's "OpenAI (Codex
  auth)" provider does. It is not Sign in with ChatGPT. The ChatGPT plan
  session is never used for images, and the Codex sign-in is never used for
  text.
- OpenAI does not document this route for other apps. It can stop working at
  any time without notice. OpenAI recommends an API key for automation.
- Images use your plan's Codex limits 3 to 5 times faster than text, then
  credits. Free plans can't use it.
- Device code sign-in must be on in ChatGPT security settings, or allowed by
  your workspace admin.
- Sign in with the same ChatGPT account as the sidecar.
- The Codex access and refresh tokens are stored on the VPS in owner-only
  files under `/docker/n8n-openai-oauth/siwc/codex-images`. Anyone with root
  or Docker access on the server, or a copy of that folder, can read them.

The easiest time to turn it on is while you install the sidecar. On the
**Review** step, open **Image generation (optional)**, read the notes and
select **I understand. After installation, start Codex sign-in for images on
…**. After the install, the Ready step shows `Image generation: Sidecar
installed. Image sign-in pending.` below your one-time Relmio key. Open **Enter
the Codex sign-in code**, choose **Open the Codex sign-in page** and enter the
code at `https://auth.openai.com/codex/device`. Relmio keeps the SSH
connection open until you finish or cancel, so keep the tab open. When you
approve, the Ready step says `Codex image sign-in complete`. Leave the box
unticked to install without images; the install is the same either way, and
a failed image sign-in never fails the install.

To turn it on later for an installed sidecar, connect to the server and
select its n8n container and network, then:

1. Open **Manage the installed ChatGPT session** and choose **Check installed
   account**. The image controls appear when this install owns the running
   sidecar. If the panel says `Update the sidecar first (Review sidecar
   update) to add image generation.`, [update the
   sidecar](#update-the-installed-sidecar) and check again.
2. Select **I understand. Sign in to Codex for images on …**, which names
   your SSH user, host and port, then choose **Sign in for images**.
3. Choose **Open the Codex sign-in page**
   (`https://auth.openai.com/codex/device`), sign in, and enter the code the
   panel shows. The code expires after 15 minutes. Relmio checks every
   5 seconds; use **Cancel image sign-in** to stop.

When you approve, the panel says `Images on for` your account and Relmio
disconnects from the VPS. If you decline or the code expires, image
generation stays off.

In n8n, add an **OpenAI** node and choose **Image**, then **Generate an
Image** or **Edit Image**. Use the same OpenAI credential as your chat nodes
(the same Base URL and one-time Relmio key). For **Model**, pick `gpt-image-2`
from the list or choose **ID** and enter it. The OpenAI Chat Model node and
Chat Hub do not list it. Flare and Sunburst need your own OpenAI API key; see
[the image test](n8n-configuration.md#generate-and-edit-images).

Limits:

- Only `gpt-image-2`, one image per request, and prompts up to 32,000
  characters.
- No masks and no URL responses; images come back as base64, which n8n saves
  as binary data.
- Sizes `1024x1024`, `1024x1536`, `1536x1024` or `auto`. OpenAI treats size
  and quality as requests: a `1024x1024` test on 2026-10-06 came back
  1254x1254.
- Edits take 1 to 16 PNG, JPEG, WebP or GIF images, each up to 25 MiB, and at
  most 48 MiB per request.
- Relmio waits up to 5 minutes for an image and does not retry a failed one.

To turn it off, choose **Check installed account**, select **I approve
signing out of images on this server**, then choose **Sign out of images**.
Relmio deletes the Codex sign-in from the server and asks OpenAI to revoke
it. If OpenAI does not confirm the revocation, the panel says so; the files
are deleted anyway. Relmio then disconnects from the VPS.

The image controls need a running sidecar. **Sign out and revoke** first
signs out of images too, as a best effort. **Pause plan use** stops the
sidecar and keeps the Codex image sign-in on the server, so sign out of
images first if you want it gone. For errors, see
[Troubleshooting](troubleshooting.md#symptom-table).

### See models and turn on model checks

**Check installed account** also loads a Models group when this install owns
the running sidecar. It lists up to 64 models from your catalog. Each row has
the model's name and ID, a **Copy ID** button, and two labels:

- **In n8n** or **Not in n8n**: whether the sidecar lists the model to n8n
  right now.
- **Ready** (it answered a test or a real request), **Not working** (OpenAI
  rejected it within the last day) or **Not checked yet**.

If copying fails, the ID is selected so you can copy it with the keyboard.
The status line names the Codex version the catalog was read as. How models
are found and hidden is explained in
[Model discovery and checks](n8n-configuration.md#model-discovery-and-checks).

If the panel says `Update the sidecar first (Review sidecar update) to show
models.`, [update the sidecar](#update-the-installed-sidecar) and check again.

Model checks are off by default. The panel explains them:

> When on, the sidecar sends one short test request ('Reply with OK') to
> models in your catalog: now for up to 12 of them, then for each new model,
> and again once a day for a model that failed. A test that gets no answer is
> tried again after an hour. n8n lists a model only after it answers; until any
> model has answered, n8n shows the full catalog except models that recently
> failed. Each test uses a small amount of your plan.

To turn them on, select **I approve model checks on …**, which names your SSH
user, host and port, then choose **Turn on model checks**. The sidecar tests up
to 12 models one at a time, which can take a few minutes. These controls show
only when the catalog could be read.

To turn them off, select **I approve turning off model checks. New models then
show in n8n without a test request.**, then choose **Turn off model checks**.
This makes no request to OpenAI and works even when the catalog is
unavailable. **Sign out and revoke** also turns model checks off, as a best
effort.

Turning checks on or off needs the same running sidecar that was checked, and
the check expires after 20 minutes; choose **Check installed account** again
if it does. For the status messages, see
[Troubleshooting](troubleshooting.md#symptom-table).

### See plan and usage

**Check installed account** also shows **Plan and usage** when this install
owns the sidecar. It lists the account and its email, whether plan use is on,
the image add-on's plan type while that add-on is signed in, and how many
models OpenAI lists and how many a completed request verified.

Choose **Refresh usage** to read the sidecar's request counts for the last 30
days: total requests and tokens, active days, the peak day, how requests
ended, and the three busiest models, with the rest under a **more models**
disclosure. Days are UTC days. A plan-usage error stays on the panel with what
to do next until a later request completes; for a usage limit it offers
**Manage usage**.

These are requests sent through Relmio, not your plan's usage. Relmio shows no
plan percent, reset time or credits; they stay on ChatGPT's Usage page, which
**Manage usage** opens.

Refresh usage only reads from the server. The wizard allows 10 reads in 15
minutes. The account check lasts five minutes, so choose **Check installed
account** again when it expires. A sidecar built before this Relmio version
counts nothing until you [update the sidecar](#update-the-installed-sidecar),
and requests from before the update never appear. The Ready screen after an
install points here. What the sidecar stores is in
[Request counts](security.md#request-counts), and the panel's messages are in
[Troubleshooting](troubleshooting.md#symptom-table).

## Next guides

- [Configure n8n nodes](./n8n-configuration.md)
- [SuperGrok on a VPS](./vps-supergrok.md)
- [AI Assistant companion](./ai-assistant.md)
- [Manual installation](./manual-install.md)
- [Troubleshooting](./troubleshooting.md)

## Unsupported ChatGPT plan capabilities

The gateway provides model discovery and supported `/v1/responses` requests.
Audio, video, Files API management, moderation, stored
responses/conversations, and unsupported parameters are rejected, except
output-token caps, which are dropped. The
Responses `image_generation` tool stays unsupported; image routes work only
through the [optional image add-on](#turn-on-image-generation-optional).
The Chat Completions compatibility route accepts function tools through
`additional_tools`, with limits of 32 tool calls, 128 KiB of arguments per
call, and 2 MiB of streamed arguments in total. It rejects a named
`tool_choice`, tool namespaces, custom tools in streamed requests, and system
messages. Tool roundtrips passed live on one ChatGPT account on a local macOS
setup on 2026-10-05; a VPS install was not tested live. Discovery does not
establish account access. See [Configure n8n nodes](n8n-configuration.md) and
the [dated source check](openai-source-check-2026-10-05.md).

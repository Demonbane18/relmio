<div align="center">
  <h1>n8n OpenAI OAuth Setup</h1>
  <p>Connect self-hosted n8n to a private, OpenAI-compatible OAuth sidecar without changing your existing n8n deployment.</p>
  <p>
    <a href="#quick-start-with-the-npm-package">Get started</a>
    &nbsp;·&nbsp;
    <a href="https://github.com/Demonbane18/n8n-openai-oauth-setup/issues/new">Report an issue</a>
    &nbsp;·&nbsp;
    <a href="https://github.com/Demonbane18/n8n-openai-oauth-setup/stargazers">Leave a star</a>
  </p>
  <p>
    <a href="https://www.npmjs.com/package/n8n-openai-oauth-setup"><img src="https://img.shields.io/npm/v/n8n-openai-oauth-setup.svg" alt="npm version"></a>
    <a href="https://github.com/Demonbane18/n8n-openai-oauth-setup/actions/workflows/ci.yml"><img src="https://github.com/Demonbane18/n8n-openai-oauth-setup/actions/workflows/ci.yml/badge.svg" alt="CI status"></a>
    <a href="package.json"><img src="https://img.shields.io/badge/Node.js-22%2B-43853d.svg" alt="Node.js 22 or newer"></a>
    <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-blue.svg" alt="MIT license"></a>
    <a href="https://github.com/Demonbane18/n8n-openai-oauth-setup/stargazers"><img src="https://img.shields.io/github/stars/Demonbane18/n8n-openai-oauth-setup?style=flat" alt="GitHub stars"></a>
  </p>
</div>

A local browser wizard that installs
[`openai-oauth@2.0.0`](https://github.com/EvanZhouDev/openai-oauth/releases/tag/v2.0.0)
as a separate Docker sidecar beside a self-hosted n8n instance. It guides a
VPS owner through ChatGPT sign-in, SSH host verification, n8n discovery, an
exact installation plan, and the final n8n credential settings.

The existing n8n image, Compose file, container, and workflows stay untouched.

> [!IMPORTANT]
> This does **not** create an OpenAI Platform API key. It creates a private,
> OpenAI-compatible endpoint that authenticates through a local ChatGPT/Codex
> OAuth session. The `local-only` value entered in n8n is only a placeholder
> for n8n's required API-key field.

> [!WARNING]
> This project and `openai-oauth` are unofficial community projects. They are
> not affiliated with or endorsed by OpenAI. Access, supported models, and
> limits depend on the signed-in ChatGPT account and can change. Use this only
> for personal, experimental workflows; protect the OAuth file like a
> password; and follow OpenAI's current terms and usage policies.

> [!CAUTION]
> This is experimental software provided without warranty. You use it at your
> own risk. To the fullest extent permitted by applicable law, the maintainer
> is not responsible for account restrictions, lost access, data loss, service
> interruption, financial loss, or any direct, indirect, incidental, or
> consequential loss resulting from use of this project. Review OpenAI's
> [Terms of Use](https://openai.com/policies/terms-of-use/), usage policies,
> ChatGPT/Codex terms, your n8n terms, and the upstream project's license and
> legal notices before using it. OpenAI may change or restrict the underlying
> service at any time.

> Similar community tools may use related OAuth/Codex flows, including Hermes
> Agent, but that similarity is not an OpenAI endorsement or a guarantee that
> every use is permitted. This project is not intended to bypass quotas,
> safeguards, account controls, or service restrictions.

<details>
<summary><strong>Table of contents</strong></summary>

- [Quick start with the npm package](#quick-start-with-the-npm-package)
- [Run from a repository clone](#run-from-a-repository-clone)
- [How it works behind the scenes](#how-it-works-behind-the-scenes)
- [What the wizard can and cannot change](#what-the-wizard-can-and-cannot-change)
- [Refresh, update, and remove](#refresh-update-and-remove)
- [Troubleshooting first steps](#troubleshooting-first-steps)
- [Release and version synchronization](#release-and-version-synchronization)
- [Documentation](#documentation)
- [Supported bridge behavior](#supported-bridge-behavior)
- [Contributing](#contributing)
- [Security and responsible disclosure](#security-and-responsible-disclosure)
- [Sources and further reading](#sources-and-further-reading)
- [License](#license)

</details>

## Quick start with the npm package

### Requirements

- A local macOS, Windows, or Linux computer with
  [Node.js 22 or newer](https://nodejs.org/en/download)
- A browser and a ChatGPT account eligible to use the upstream Codex flow
- A self-hosted n8n Docker container on a VPS
- Docker Engine and Docker Compose v2 on the VPS
- The VPS address, SSH port, and root password
- A Docker network that n8n and the new sidecar can share

> [!WARNING]
> Export or otherwise back up your n8n workflows before using the wizard.
> The wizard is designed to create or update only its separate sidecar and
> does not issue n8n deletion, restart, or rebuild commands, but it still
> authenticates to your VPS and writes files there. Keep a recoverable backup
> before granting it access.

Do **not** run the npm command on the VPS. Run it on the computer where you
will complete the browser sign-in.

### 1. Start the newest published wizard

Open Terminal, PowerShell, or another local shell:

```bash
npx --yes --ignore-scripts n8n-openai-oauth-setup@latest
```

Keep that terminal open. The command starts a one-time web server on
`127.0.0.1`, prints a private session URL, and opens the wizard in your
browser. It does not globally install this package.

To confirm which version npm currently publishes:

```bash
npm view n8n-openai-oauth-setup version
```

> [!NOTE]
> Every wizard screenshot below comes from the built-in sanitized preview. It
> uses a reserved documentation IP, fake fingerprint, fake container data, and
> fake models. No real VPS, credential, or browser session is shown.

### 2. Complete or reuse the local ChatGPT sign-in

The wizard stores its validated credential at:

```text
~/.n8n-openai-oauth/auth.json
```

It does not reuse or overwrite the Codex app's `~/.codex/auth.json`. If a
credential already exists, **Continue to VPS** reuses it. Use **Refresh
ChatGPT sign-in** when it is expired, belongs to another account, or you want
a new session.

After a fresh login, check the **Credential updated** timestamp. It is shown
in your computer's local time so you can tell that the browser approval
actually reached the wizard.

![Step 1: local ChatGPT credential found with its update timestamp](docs/images/setup/01-local-sign-in-ready.png)

If a browser extension named **Sign in with ChatGPT** or **OpenAI OAuth**
captures the callback, temporarily disable that extension and start the
refresh again from the wizard. The active wizard must receive the callback on
`localhost:1455`.

### 3. Verify the VPS before entering its password

Enter the VPS address exactly as your provider shows it. Select **Check server
identity**, compare the SHA-256 fingerprint with the intended server, and
confirm it before the password field unlocks.

![Step 2: sanitized VPS address and SSH fingerprint confirmation](docs/images/setup/02-vps-identity-confirmed.png)

The screenshot uses the reserved documentation address `192.0.2.10`, a fake
fingerprint, and an empty password field. Never publish a real password,
private key, session URL, or OAuth file.

### 4. Choose the detected n8n container and shared network

The wizard connects over SSH, runs read-only Docker discovery, and lists the
running n8n container and its networks. Choose the network that n8n should
share with the sidecar; on many Hostinger templates it is named `proxy`.

![Step 3: sanitized n8n container and Docker network discovery](docs/images/setup/03-n8n-detected.png)

### 5. Review and approve the exact plan

Nothing is written during discovery. The review screen shows the single
managed directory, service, Docker network, and private hostname. It also
states the forbidden actions: no n8n edit, rebuild, restart, or recreation;
no host port; and no Traefik route.

![Step 4: exact sidecar-only installation plan](docs/images/setup/04-install-plan.png)

Only after you select the approval checkbox can the wizard upload the OAuth
file and build the separate sidecar.

### 6. Copy the verified settings into n8n

The final screen appears only after the sidecar is healthy, the model list is
reachable, and Docker reports no published host port.

![Step 5: verified private bridge and n8n credential values](docs/images/setup/05-bridge-ready.png)

Use the button beside each value to copy it individually, or select
**Copy credential settings** for the labeled credential set. Then create or
edit an **OpenAI** credential in n8n:

**API Key**

```text
local-only
```

**Base URL**

```text
http://n8n-openai-oauth:10531/v1
```

**Organization ID:** leave empty.

**Add Custom Header**

```text
Off
```

For an **OpenAI Chat Model**:

- select one of the models returned by the bridge;
- on Chat Model node version 1.3, keep **Use Responses API** on;
- if that switch is absent, keep the node's default Chat Completions behavior;
- begin with a simple prompt and no built-in tools;
- add tools only after the basic request succeeds.

The bridge supports both `/v1/responses` and `/v1/chat/completions`.

For an **HTTP Request** node, an example endpoint is:

```text
POST http://n8n-openai-oauth:10531/v1/responses
```

n8n may send `Authorization: Bearer local-only`. The bridge does not treat
that placeholder as an OpenAI API key or secret.

For complete copy-paste recipes for an **AI Agent**, **Basic LLM Chain**, and
**HTTP Request** node—including an importable cURL command—open
[Configure n8n nodes](docs/n8n-configuration.md).

## Run from a repository clone

The npm command above is the recommended path. Contributors can instead run
the source checkout:

```bash
git clone https://github.com/Demonbane18/n8n-openai-oauth-setup.git
cd n8n-openai-oauth-setup
npm ci --ignore-scripts
npm start
```

On macOS, **Start Wizard.command** performs the install-and-start steps. On
Windows, use **Start Wizard.bat**.

## How it works behind the scenes

```mermaid
flowchart LR
  subgraph Local["Your computer"]
    U["You"]
    B["Local browser wizard<br/>127.0.0.1"]
    A["Wizard-only OAuth file<br/>owner-readable only"]
    U --> B
    B -->|"ChatGPT sign-in<br/>localhost:1455 callback"| A
  end

  subgraph VPS["Your VPS"]
    N["Existing n8n container<br/>unchanged"]
    S["openai-oauth sidecar<br/>separate Compose project"]
    D["Shared private<br/>Docker network"]
    N -->|"OpenAI-compatible request<br/>Docker DNS"| D
    D --> S
  end

  B -->|"verified SSH + SFTP<br/>after approval"| S
  S -->|"OAuth-authenticated request"| O["OpenAI service used by<br/>the upstream helper"]
```

The design works because four independent features line up:

1. n8n's OpenAI credential accepts a custom Base URL.
2. `openai-oauth` exposes OpenAI-compatible routes such as `/v1/models`,
   `/v1/responses`, and `/v1/chat/completions`.
3. Docker DNS lets n8n reach the sidecar by the private hostname
   `n8n-openai-oauth` on a shared network.
4. The upstream helper uses the mounted OAuth credential for its upstream
   authentication, while n8n sends the harmless `local-only` placeholder.

The request flow after installation is:

```mermaid
sequenceDiagram
  participant W as n8n workflow
  participant C as n8n OpenAI credential
  participant S as OAuth sidecar
  participant O as Upstream OpenAI service

  W->>C: Run an OpenAI node
  C->>S: Request to n8n-openai-oauth:10531/v1
  S->>S: Read the mounted OAuth credential
  S->>O: Forward an OAuth-authenticated request
  O-->>S: Model response or stream
  S-->>W: OpenAI-compatible response
```

See [Architecture and n8n safety boundary](docs/architecture.md) for the
mutation boundary and command-level design.

## What the wizard can and cannot change

The wizard:

- reads the running n8n container and networks with read-only Docker commands;
- writes only under `/docker/n8n-openai-oauth`;
- creates a separate Compose project named `n8n-openai-oauth`;
- builds and starts only the `openai-oauth` service;
- uploads the OAuth file through SFTP with owner-only permissions;
- joins an existing Docker network;
- verifies that port `10531` is not published.

It never edits the n8n Compose file or image and never builds, restarts, stops,
recreates, or removes the n8n container. It also creates no Traefik route.
Automated tests enforce this boundary.

## Refresh, update, and remove

To refresh an expired ChatGPT session, run the same npm command again, choose
**Refresh ChatGPT sign-in**, verify the timestamp, and approve the update to
the same wizard-managed sidecar:

```bash
npx --yes --ignore-scripts n8n-openai-oauth-setup@latest
```

The update targets only the sidecar. It does not restart n8n. For rollback,
recoverable uninstall, and pinned upstream upgrades, follow
[Refresh, upgrade, rollback, and uninstall](docs/maintenance.md).

## Troubleshooting first steps

- **Old wizard version:** close the old terminal and run the `@latest` command.
- **Browser did not open:** copy the newest printed `127.0.0.1` URL into the
  browser while its terminal remains open.
- **Sign-in says expired:** close the old OAuth tab and begin a fresh refresh
  from the active wizard.
- **Extension page appears:** temporarily disable the extension that captured
  `localhost:1455`.
- **SSH fails:** recheck the full address, port, root password, provider
  firewall, and confirmed fingerprint.
- **n8n cannot connect:** use
  `http://n8n-openai-oauth:10531/v1`, never `127.0.0.1`.

See the full symptom matrix in [Troubleshooting](docs/troubleshooting.md).

## Release and version synchronization

`package.json` is the release version source of truth. The repository also
keeps these values synchronized:

- `package-lock.json` package and root-package versions;
- the newest version heading in [CHANGELOG.md](CHANGELOG.md);
- the Git tag `v<version>` for tagged builds.

`npm run release:check` rejects a mismatch among those local release files
and, on a tag build, the Git tag. The npm badge is an informational view of
the registry's cached `latest` version; the maintainer guide performs a
separate post-publish equality check against the registry. Maintainers must
bump and commit the repository version before publishing that same immutable
version to npm. Publishing npm first does not automatically rewrite Git
history or the README. Follow the
[npm maintainer publishing guide](docs/npm-publish.md) for the ordered release
procedure.

## Documentation

- [Changelog](CHANGELOG.md)
- [Troubleshooting](docs/troubleshooting.md)
- [OpenAI credential and node recipes](docs/n8n-configuration.md)
- [Beginner manual installation](docs/manual-install.md)
- [Security and limitations](docs/security.md)
- [Architecture and n8n safety boundary](docs/architecture.md)
- [Refresh, upgrade, rollback, and uninstall](docs/maintenance.md)
- [YouTube walkthrough outline](docs/video-outline.md)
- [npm maintainer publishing guide](docs/npm-publish.md)
- [Contributing](CONTRIBUTING.md)
- [Approved scope](SPEC.md)

## Supported bridge behavior

The pinned upstream `2.0.0` release documents:

- `/v1/models`;
- `/v1/responses`;
- `/v1/chat/completions`;
- streaming and tool calls.

Available models depend on the ChatGPT account and may change. The upstream
Responses implementation is stateless, so callers must send the conversation
history needed for each request.

## Contributing

Pull requests and focused issue reports are welcome. Before opening a PR,
please read [CONTRIBUTING.md](CONTRIBUTING.md), run the local checks, and keep
the change scoped to one improvement. Never commit OAuth files, passwords,
private keys, live session URLs, real VPS addresses, or screenshots containing
account or infrastructure details.

<p>
  <a href="CONTRIBUTING.md">Contribution guide</a>
  &nbsp;·&nbsp;
  <a href="https://github.com/Demonbane18/n8n-openai-oauth-setup/compare">Submit a pull request</a>
  &nbsp;·&nbsp;
  <a href="https://github.com/Demonbane18/n8n-openai-oauth-setup/issues/new">Open an issue</a>
</p>

## Security and responsible disclosure

Please use the private reporting path described in
[Security and limitations](docs/security.md) for suspected vulnerabilities.
Do not publish credentials, OAuth material, host details, or an exploit in a
public issue.

If this project saves you time, please consider [starring the repository](https://github.com/Demonbane18/n8n-openai-oauth-setup/stargazers).

## Sources and further reading

- [`openai-oauth` v2.0.0 release](https://github.com/EvanZhouDev/openai-oauth/releases/tag/v2.0.0)
- [`openai-oauth` v2.0.0 server routes](https://github.com/EvanZhouDev/openai-oauth/blob/v2.0.0/packages/openai-oauth/src/server.ts)
- [`openai-oauth` v2.0.0 login flow](https://github.com/EvanZhouDev/openai-oauth/blob/v2.0.0/packages/openai-oauth/src/login.ts)
- [n8n OpenAI credential documentation](https://docs.n8n.io/integrations/builtin/credentials/openai/)
- [n8n OpenAI credential source](https://github.com/n8n-io/n8n/blob/master/packages/nodes-base/credentials/OpenAiApi.credentials.ts)
- [n8n OpenAI Chat Model source](https://github.com/n8n-io/n8n/blob/master/packages/%40n8n/nodes-langchain/nodes/llms/LMChatOpenAi/LmChatOpenAi.node.ts)
- [Docker Compose networking](https://docs.docker.com/compose/how-tos/networking/)
- [Docker Compose `expose`](https://docs.docker.com/reference/compose-file/services/#expose)
- [Docker port publishing](https://docs.docker.com/engine/network/port-publishing/)
- [OpenAI: using Codex with a ChatGPT plan](https://help.openai.com/en/articles/11369540-using-codex-with-your-chatgpt-plan)
- [OpenAI Terms of Use](https://openai.com/policies/terms-of-use/)
- [npm semantic versioning](https://docs.npmjs.com/about-semantic-versioning/)

## License

[MIT](LICENSE). The upstream `openai-oauth` project has its own license and
legal notice; review both before distributing or deploying this setup.

import Image from "next/image";
import Link from "next/link";
import { Card } from "@astryxdesign/core/Card";
import { Grid } from "@astryxdesign/core/Grid";
import { HStack } from "@astryxdesign/core/HStack";
import { StatusDot } from "@astryxdesign/core/StatusDot";
import { Text } from "@astryxdesign/core/Text";
import { Token } from "@astryxdesign/core/Token";
import { VStack } from "@astryxdesign/core/VStack";
import { ChatConsole } from "./components/ChatConsole";
import { RepositoryButton } from "./components/RepositoryButton";
import { SupportButton } from "./components/SupportButton";
import { ThemeModeControl } from "./components/ThemeModeControl";

const capabilities = [
  {
    index: "01",
    title: "Sign in once",
    copy: "Connect a supported ChatGPT account through the browser. Your session stays encrypted on this device.",
  },
  {
    index: "02",
    title: "Relay the request",
    copy: "Relmio sends request-bound credentials to the model route without turning them into a reusable API key.",
  },
  {
    index: "03",
    title: "Use the client you know",
    copy: "Start with the hosted chat, then move to n8n AI nodes, local apps, and OpenAI-compatible clients.",
  },
];

const boundaries = [
  "No shared subscription pool",
  "No OAuth tokens in application logs",
  "No public n8n sidecar port",
  "No OpenAI Platform API key created",
];

const relayTargets = [
  "n8n AI Agent",
  "LLM Chain",
  "HTTP Request",
  "Local chat",
  "OpenAI SDK",
];

const chromeExtensionUrl =
  "https://chromewebstore.google.com/detail/sign-in-with-chatgpt/odbgboachaefbbbdiffcefhpkekhfcna";
const firefoxExtensionUrl =
  "https://addons.mozilla.org/firefox/addon/sign-in-with-chatgpt/";

export default function Home() {
  return (
    <main id="main-content">
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>
      <header className="site-header">
        <div className="site-header-inner">
          <a className="brand" href="#top" aria-label="Relmio home">
            <Image
              src="/relmio-icon.png"
              alt=""
              width={38}
              height={38}
              priority
            />
            <span>Relmio</span>
          </a>
          <nav aria-label="Primary navigation">
            <a href="#how-it-works">How it works</a>
            <Link href="/install">Install</Link>
            <Link href="/docs">Docs</Link>
            <a href="#chat">Chat</a>
          </nav>
          <div className="header-actions">
            <ThemeModeControl />
            <SupportButton />
            <RepositoryButton />
          </div>
        </div>
      </header>

      <section className="hero" id="top">
        <div className="hero-copy">
          <p className="eyebrow">
            <span className="status-dot" aria-hidden="true" />
            Private bridge
          </p>
          <h1>
            A private bridge
            <span>between your plan and your tools.</span>
          </h1>
          <p className="hero-lede">
            Test a supported ChatGPT sign-in in the hosted chat. For n8n,
            install Relmio&apos;s private sidecar and keep the relay inside
            your own Docker network.
          </p>
          <p className="hero-boundary">
            A Platform API key powers the OpenAI-compatible /v1 endpoint.
            ChatGPT sign-in powers only the experimental Codex App Server
            protocol.
          </p>
          <div className="hero-actions">
            <a className="button button-primary" href="#chat">
              Try the secure chat
              <span aria-hidden="true">↘</span>
            </a>
            <Link
              className="button button-secondary"
              href="/install"
            >
              Install wizard
            </Link>
          </div>
        </div>

        <VStack className="private-bridge" gap={0} aria-label="Private request route">
          <HStack className="visual-heading" gap={4} justify="between" align="center">
            <VStack gap={0.5}>
              <Text type="code">Request route</Text>
              <Text type="label" weight="bold">One boundary at a time</Text>
            </VStack>
            <Token
              label="Ready"
              size="sm"
              color="teal"
              endContent={<StatusDot variant="success" label="Route ready" />}
            />
          </HStack>
          <Grid className="bridge-route" columns={5} gap={2} align="center">
            <Card className="bridge-node" padding={5} elevation="low">
              <VStack height="100%" gap={1}>
                <Text type="code" color="accent">01</Text>
                <Text type="label" weight="bold">Your app</Text>
                <Text type="supporting" color="secondary">Trusted local backend</Text>
              </VStack>
            </Card>
            <HStack className="bridge-link bridge-link-in" aria-hidden="true">
              <StatusDot variant="accent" label="Request moving to Relmio" />
            </HStack>
            <Card className="bridge-node bridge-node-relmio" padding={5} variant="teal">
              <VStack height="100%" gap={1}>
                <Text type="code" color="inherit">02</Text>
                <Text type="label" color="inherit" weight="bold">Relmio</Text>
                <Text type="supporting" color="inherit">Authenticated relay</Text>
              </VStack>
            </Card>
            <HStack className="bridge-link bridge-link-out" aria-hidden="true">
              <StatusDot variant="accent" label="Response streaming to the app" />
            </HStack>
            <Card className="bridge-node" padding={5} elevation="low">
              <VStack height="100%" gap={1}>
                <Text type="code" color="accent">03</Text>
                <Text type="label" weight="bold">AI response</Text>
                <Text type="supporting" color="secondary">Streamed back</Text>
              </VStack>
            </Card>
          </Grid>
          <HStack className="bridge-boundary" gap={4} justify="between">
            <Text type="code" color="secondary">Credential stays behind the boundary</Text>
            <Text type="code" color="secondary">Response streams through</Text>
          </HStack>
        </VStack>
      </section>

      <section className="signal-strip" aria-label="Supported starting points">
        <p>Built to relay into</p>
        <div className="marquee">
          <div className="marquee-track">
            {relayTargets.map((target) => (
              <span key={target}>{target}</span>
            ))}
            {relayTargets.map((target) => (
              <span key={`${target}-duplicate`} aria-hidden="true">
                {target}
              </span>
            ))}
          </div>
        </div>
      </section>

      <section className="process-section" id="how-it-works">
        <div className="section-intro reveal">
          <p className="section-label">How it works</p>
          <h2>A relay, not another account system.</h2>
          <p>
            Relmio keeps authentication, transport, and client compatibility
            separate. That makes each boundary easier to understand and easier
            to protect.
          </p>
        </div>
        <ol className="process-grid">
          {capabilities.map((capability) => (
            <li className="reveal" key={capability.index}>
              <span>{capability.index}</span>
              <h3>{capability.title}</h3>
              <p>{capability.copy}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="chat-section reveal" id="chat">
        <div className="chat-copy">
          <p className="section-label">Hosted demo</p>
          <h2>Connect, then ask.</h2>
          <p>
            This chat uses the account you connect in this browser. Relmio
            forwards credentials only with your request; the server does not
            keep a reusable session.
          </p>
          <aside className="extension-guide" aria-labelledby="extension-guide-title">
            <span aria-hidden="true">!</span>
            <div>
              <strong id="extension-guide-title">
                Before you connect: install the browser extension
              </strong>
              <p>
                The hosted chat needs the open-source Sign in with ChatGPT
                extension to complete the secure OAuth handoff. Install it for{" "}
                <a href={chromeExtensionUrl} target="_blank" rel="noreferrer">
                  Chrome
                </a>{" "}
                or{" "}
                <a href={firefoxExtensionUrl} target="_blank" rel="noreferrer">
                  Firefox
                </a>
                , reload this page, then connect again.
              </p>
              <p className="extension-local-note">
                Using the local npm wizard? It handles its own localhost
                callback. If an OAuth extension intercepts that callback,
                temporarily disable it during local sign-in.
              </p>
            </div>
          </aside>
          <div className="privacy-note">
            <span aria-hidden="true">⌁</span>
            <div>
              <strong>Device-local by design</strong>
              <p>
                Credentials are encrypted in this browser. Disconnect whenever
                you want to remove the local session.
              </p>
            </div>
          </div>
        </div>
        <ChatConsole />
      </section>

      <section className="security-section" id="security">
        <div className="security-panel reveal">
          <div>
            <p className="section-label section-label-light">Safety boundary</p>
            <h2>Private where it matters.</h2>
            <p>
              The hosted chat is a browser demo. The n8n installer remains a
              local wizard that deploys a separate sidecar without changing
              your existing n8n container, image, or workflows.
            </p>
          </div>
          <ul>
            {boundaries.map((boundary) => (
              <li key={boundary}>
                <span aria-hidden="true">✓</span>
                {boundary}
              </li>
            ))}
          </ul>
        </div>
      </section>

      <section className="closing-section reveal">
        <div>
          <p className="section-label">Start locally</p>
          <h2>Bring your own plan. Keep your own boundary.</h2>
        </div>
        <Link
          className="button button-primary"
          href="/install"
        >
          Install the wizard
          <span aria-hidden="true">↘</span>
        </Link>
      </section>

      <footer>
        <a className="brand footer-brand" href="#top" aria-label="Relmio home">
          <Image src="/relmio-icon.png" alt="" width={32} height={32} />
          <span>Relmio</span>
        </a>
        <p>
          Hosted sign-in uses the{" "}
          <a
            href="https://github.com/EvanZhouDev/openai-oauth"
            target="_blank"
            rel="noreferrer"
          >
            openai-oauth method by Evan Zhou Dev
          </a>
          .
        </p>
        <div>
          <a
            href="https://www.npmjs.com/package/relmio"
            target="_blank"
            rel="noreferrer"
          >
            npm
          </a>
          <a
            href="https://github.com/Demonbane18/relmio"
            target="_blank"
            rel="noreferrer"
          >
            GitHub
          </a>
          <a href="#security">Security</a>
          <a href="#chat">Chat demo</a>
        </div>
      </footer>
    </main>
  );
}

import Image from "next/image";
import Link from "next/link";
import { Button } from "@astryxdesign/core/Button";
import { Grid } from "@astryxdesign/core/Grid";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { ArrowUpRight, Check } from "lucide-react";
import { ChatConsole } from "./components/ChatConsole";
import { RepositoryButton } from "./components/RepositoryButton";
import { SupportButton } from "./components/SupportButton";
import { ThemeModeControl } from "./components/ThemeModeControl";

const routeNotes = [
  ["Your app", "Trusted local backend"],
  ["Relmio", "Authenticated relay"],
  ["AI response", "Streamed back"],
] as const;

const capabilities = [
  ["Sign in once", "Connect a supported ChatGPT account through the browser. Your session stays encrypted on this device."],
  ["Keep credentials scoped", "Relmio sends request-bound credentials to the model route without turning them into a reusable API key."],
  ["Use familiar clients", "Start with the hosted chat, then move to n8n AI nodes, local apps, and OpenAI-compatible clients."],
] as const;

const boundaries = [
  "No shared subscription pool",
  "No OAuth tokens in application logs",
  "No public n8n sidecar port",
  "No OpenAI Platform API key created",
];

const chromeExtensionUrl =
  "https://chromewebstore.google.com/detail/sign-in-with-chatgpt/odbgboachaefbbbdiffcefhpkekhfcna";
const firefoxExtensionUrl =
  "https://addons.mozilla.org/firefox/addon/sign-in-with-chatgpt/";

export default function Home() {
  return (
    <main className="editorial-home" id="main-content">
      <a className="skip-link" href="#content-start">
        Skip to main content
      </a>
      <header className="editorial-header" id="top">
        <HStack className="editorial-header-inner" gap={4} justify="between" align="center">
          <Link className="editorial-brand" href="/" aria-label="Relmio home">
            <HStack gap={2} align="center">
              <Image src="/relmio-icon.png" alt="" width={38} height={38} priority />
              <Text type="label" weight="bold">Relmio</Text>
            </HStack>
          </Link>
          <nav className="editorial-nav" aria-label="Primary navigation">
            <a href="#how-it-works">How it works</a>
            <Link href="/install">Install</Link>
            <Link href="/docs">Docs</Link>
            <a href="#chat">Chat</a>
          </nav>
          <HStack className="editorial-header-actions" gap={2} align="center">
            <ThemeModeControl />
            <SupportButton />
            <RepositoryButton />
          </HStack>
        </HStack>
      </header>

      <section className="editorial-hero" id="content-start">
        <Grid className="editorial-hero-grid" columns={2} gap={8} align="stretch">
          <VStack className="editorial-hero-copy" gap={5} align="start">
            <Text as="p" type="code" color="accent">Private bridge</Text>
            <Heading className="editorial-title" level={1} type="display-1">
              A private bridge between your plan and your tools.
            </Heading>
            <Text as="p" className="editorial-lede" type="large" color="secondary">
              Test a supported ChatGPT sign-in in the hosted chat. For n8n, install Relmio&apos;s private sidecar and keep the relay inside your own Docker network.
            </Text>
            <Text as="p" className="editorial-boundary" type="supporting">
              A Platform API key powers the OpenAI-compatible /v1 endpoint. ChatGPT sign-in powers only the experimental Codex App Server protocol.
            </Text>
            <HStack className="editorial-actions" gap={3} wrap="wrap">
              <Button label="Try the secure chat" href="#chat" variant="primary" size="lg" endContent={<ArrowUpRight aria-hidden="true" />}>
                Try the secure chat
              </Button>
              <Link className="install-wizard-link" href="/install">Install wizard</Link>
            </HStack>
          </VStack>

          <section className="request-route" aria-label="Private request route">
            <VStack gap={5}>
              <VStack gap={1}>
                <Text as="p" type="code" color="accent">Request route</Text>
                <Heading level={2}>One boundary at a time</Heading>
              </VStack>
              <ol className="request-route-list">
                {routeNotes.map(([title, detail]) => (
                  <li key={title}>
                    <VStack gap={1}>
                      <Text type="label" weight="bold">{title}</Text>
                      <Text as="p" type="supporting">{detail}</Text>
                    </VStack>
                  </li>
                ))}
              </ol>
              <Text as="p" type="supporting" color="secondary">
                Credentials stay behind the boundary. Responses stream through.
              </Text>
            </VStack>
          </section>
        </Grid>
      </section>

      <section className="editorial-process" id="how-it-works">
        <VStack className="editorial-section-heading" gap={3}>
          <Text as="p" type="code" color="accent">How it works</Text>
          <Heading level={2} type="display-2">A relay, not another account system.</Heading>
          <Text as="p" type="large" color="secondary">
            Relmio keeps authentication, transport, and client compatibility separate. That makes each boundary easier to understand and easier to protect.
          </Text>
        </VStack>
        <ol className="editorial-capabilities">
          {capabilities.map(([title, copy]) => (
            <li key={title}>
              <Heading level={3}>{title}</Heading>
              <Text as="p" type="supporting">{copy}</Text>
            </li>
          ))}
        </ol>
      </section>

      <section className="editorial-chat" id="chat" aria-labelledby="chat-title">
        <Grid className="editorial-chat-grid" columns={2} gap={8} align="start">
          <VStack className="editorial-chat-copy" gap={4}>
            <Text as="p" type="code" color="accent">Hosted chat</Text>
            <Heading id="chat-title" level={2} type="display-2">Connect, then ask.</Heading>
            <Text as="p" type="large" color="secondary">
              This chat uses the account you connect in this browser. Relmio forwards credentials only with your request; the server does not keep a reusable session.
            </Text>
            <aside className="editorial-note" aria-labelledby="extension-guide-title">
              <VStack gap={2}>
                <Text id="extension-guide-title" type="label" weight="bold">Before you connect: install the browser extension</Text>
                <Text as="p" type="supporting">
                  The hosted chat needs the open-source Sign in with ChatGPT extension to complete the secure OAuth handoff. Install it for <a href={chromeExtensionUrl} target="_blank" rel="noreferrer">Chrome</a> or <a href={firefoxExtensionUrl} target="_blank" rel="noreferrer">Firefox</a>, reload this page, then connect again.
                </Text>
                <Text as="p" type="supporting">
                  Using the local npm wizard? It handles its own localhost callback. If an OAuth extension intercepts that callback, temporarily disable it during local sign-in.
                </Text>
              </VStack>
            </aside>
            <Text as="p" className="editorial-device-note" type="supporting">
              Device-local by design. Credentials are encrypted in this browser. Disconnect whenever you want to remove the local session.
            </Text>
          </VStack>
          <ChatConsole />
        </Grid>
      </section>

      <section className="editorial-security" id="security">
        <Grid className="editorial-security-grid" columns={2} gap={8} align="start">
          <VStack gap={3}>
            <Text as="p" type="code" color="accent">Safety boundary</Text>
            <Heading level={2} type="display-2">Private where it matters.</Heading>
            <Text as="p" type="large" color="secondary">
              The hosted chat is a browser demo. The n8n installer remains a local wizard that deploys a separate sidecar without changing your existing n8n container, image, or workflows.
            </Text>
          </VStack>
          <ul className="editorial-boundaries">
            {boundaries.map((boundary) => (
              <li key={boundary}>
                <Check aria-hidden="true" />
                <Text type="label">{boundary}</Text>
              </li>
            ))}
          </ul>
        </Grid>
      </section>

      <footer className="editorial-footer">
        <HStack className="editorial-footer-inner" gap={4} justify="between" align="center" wrap="wrap">
          <HStack gap={2} align="center">
            <Image src="/relmio-icon.png" alt="" width={32} height={32} />
            <Text type="label" weight="bold">Relmio</Text>
          </HStack>
          <Text as="p" type="supporting">
            Hosted sign-in uses the <a href="https://github.com/EvanZhouDev/openai-oauth" target="_blank" rel="noreferrer">openai-oauth method by Evan Zhou Dev</a>.
          </Text>
          <HStack gap={3} wrap="wrap">
            <a href="https://www.npmjs.com/package/relmio" target="_blank" rel="noreferrer">npm</a>
            <a href="https://github.com/Demonbane18/relmio" target="_blank" rel="noreferrer">GitHub</a>
            <a href="#security">Security</a>
            <a href="#chat">Chat demo</a>
          </HStack>
        </HStack>
      </footer>
    </main>
  );
}

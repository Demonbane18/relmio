import Image from "next/image";
import Link from "next/link";
import { Grid } from "@astryxdesign/core/Grid";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { Check } from "lucide-react";
import { ChatConsole } from "./components/ChatConsole";
import { HashLink } from "./components/HashLink";
import { SignalPlotter } from "./components/relay/SignalPlotter";
import { RepositoryButton } from "./components/RepositoryButton";
import { SupportButton } from "./components/SupportButton";
import { ThemeModeControl } from "./components/ThemeModeControl";

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
      <HashLink className="skip-link" focusTarget targetId="content-start">
        Skip to main content
      </HashLink>
      <header className="editorial-header" id="top">
        <HStack className="editorial-header-inner" gap={4} justify="between" align="center">
          <Link className="editorial-brand" href="/" aria-label="Relmio home">
            <HStack gap={2} align="center">
              <Image src="/relmio-icon.png" alt="" width={38} height={38} priority unoptimized />
              <Text type="label" weight="bold">Relmio</Text>
            </HStack>
          </Link>
          <nav className="editorial-nav" aria-label="Primary navigation">
            <HashLink targetId="how-it-works">How it works</HashLink>
            <Link href="/install">Install</Link>
            <Link href="/docs">Docs</Link>
            <Link href="/changelog">Changelog</Link>
            <HashLink targetId="chat">Chat</HashLink>
          </nav>
          <HStack className="editorial-header-actions" gap={2} align="center">
            <ThemeModeControl />
            <SupportButton />
            <RepositoryButton />
          </HStack>
        </HStack>
      </header>

      <SignalPlotter />

      <section className="editorial-chat" id="chat-section" aria-labelledby="chat-title">
        <Grid className="editorial-chat-grid" columns={2} gap={8} align="start">
          <VStack className="editorial-chat-copy" gap={4}>
            <Text as="p" type="code" color="accent">Hosted chat</Text>
            <Heading id="chat-title" level={2} type="display-2">Connect, then ask.</Heading>
            <Text as="p" type="large" color="secondary">
              This chat uses the account you connect in this browser. Relmio forwards credentials only with your request; the server does not keep a reusable session.
            </Text>
            <section className="editorial-note" aria-labelledby="extension-guide-title">
              <VStack gap={2}>
                <Text id="extension-guide-title" type="label" weight="bold">Before you connect: install the browser extension</Text>
                <Text as="p" type="supporting">
                  The hosted chat needs the open-source Sign in with ChatGPT extension to complete the secure OAuth handoff. Install it for <a href={chromeExtensionUrl} target="_blank" rel="noreferrer">Chrome</a> or <a href={firefoxExtensionUrl} target="_blank" rel="noreferrer">Firefox</a>, reload this page, then connect again.
                </Text>
                <Text as="p" type="supporting">
                  Using the local npm wizard? It handles its own localhost callback. If an OAuth extension intercepts that callback, temporarily disable it during local sign-in.
                </Text>
              </VStack>
            </section>
            <Text as="p" className="editorial-device-note" type="supporting">
              This browser encrypts the credentials it stores. Disconnect to remove the local session.
            </Text>
          </VStack>
          <div className="editorial-chat-console" id="chat">
            <ChatConsole />
          </div>
        </Grid>
      </section>

      <section className="editorial-security" id="security">
        <Grid className="editorial-security-grid" columns={2} gap={8} align="start">
          <VStack gap={3}>
            <Text as="p" type="code" color="accent">Safety boundary</Text>
            <Heading level={2} type="display-2">The n8n bridge stays private.</Heading>
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
            <Image src="/relmio-icon.png" alt="" width={32} height={32} unoptimized />
            <Text type="label" weight="bold">Relmio</Text>
          </HStack>
          <Text as="p" type="supporting">
            Hosted sign-in uses the <a href="https://github.com/EvanZhouDev/openai-oauth" target="_blank" rel="noreferrer">openai-oauth method by Evan Zhou Dev</a>.
          </Text>
          <HStack gap={3} wrap="wrap">
            <a href="https://www.npmjs.com/package/relmio" target="_blank" rel="noreferrer">npm</a>
            <a href="https://github.com/Demonbane18/relmio" target="_blank" rel="noreferrer">GitHub</a>
            <HashLink targetId="security">Security</HashLink>
            <HashLink targetId="chat">Chat demo</HashLink>
          </HStack>
        </HStack>
      </footer>
    </main>
  );
}

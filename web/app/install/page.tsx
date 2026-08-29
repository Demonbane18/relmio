import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { Button } from "@astryxdesign/core/Button";
import { Heading } from "@astryxdesign/core/Heading";
import { HStack } from "@astryxdesign/core/HStack";
import { Text } from "@astryxdesign/core/Text";
import { VStack } from "@astryxdesign/core/VStack";
import { CopyCommand } from "../components/CopyCommand";
import { RepositoryButton } from "../components/RepositoryButton";
import { SupportButton } from "../components/SupportButton";
import { ThemeModeControl } from "../components/ThemeModeControl";

export const metadata: Metadata = {
  title: "Install Relmio for n8n",
  description:
    "Install the local Relmio wizard with Homebrew, macOS/Linux, PowerShell, Command Prompt, or NPX.",
};

const steps = [
  ["Choose an install method", "Use Homebrew, your local shell, or NPX. Windows does not need Git Bash."],
  ["Start locally", "Paste the command on your own computer and keep that terminal open."],
  ["Verify, then approve", "Confirm the target identity and sidecar plan before any deployment write."],
] as const;

export default function InstallPage() {
  return (
    <main className="editorial-install" id="main-content">
      <a className="skip-link" href="#install-command">
        Skip to installation command
      </a>
      <header className="editorial-header editorial-install-header">
        <HStack className="editorial-header-inner" gap={4} justify="between" align="center">
          <Link className="editorial-brand" href="/" aria-label="Relmio home">
            <HStack gap={2} align="center">
              <Image src="/relmio-icon.png" alt="" width={38} height={38} priority />
              <Text type="label" weight="bold">Relmio</Text>
            </HStack>
          </Link>
          <nav className="editorial-nav" aria-label="Primary navigation">
            <Link href="/">Hosted chat</Link>
            <Link href="/docs">Documentation</Link>
          </nav>
          <HStack className="editorial-header-actions" gap={2} align="center">
            <ThemeModeControl />
            <SupportButton />
            <RepositoryButton />
          </HStack>
        </HStack>
      </header>

      <section className="install-lead">
        <VStack className="install-lead-copy" gap={3}>
          <Text as="p" type="code" color="accent">Self-hosted n8n</Text>
          <Heading level={1} type="display-2">Install Relmio for n8n</Heading>
          <Text as="p" type="large" color="secondary">
            Run one local wizard to sign in with ChatGPT, verify your target host, and install a private OpenAI-compatible sidecar beside n8n.
          </Text>
        </VStack>
      </section>

      <section className="install-toolbox" id="install-command" data-install-toolbox>
        <VStack gap={3}>
          <VStack gap={1}>
            <Text as="p" type="code" color="accent">Start here</Text>
            <Heading level={2}>Choose an installation method</Heading>
          </VStack>
          <CopyCommand />
        </VStack>
      </section>

      <section className="install-reference" aria-label="Installation details">
        <details>
          <summary>Read the installation and credential details</summary>
          <VStack className="install-disclosure" gap={4}>
            <Text as="p" type="supporting">
              Choose Homebrew or the terminal already on your computer. Native Windows works without Git Bash or a preinstalled Node.js runtime.
            </Text>
            <Text as="p" type="supporting">
              <strong>Local endpoint choice:</strong> The OpenAI-compatible /v1 option uses a Platform API key. ChatGPT sign-in is only for the experimental Codex App Server and Chat Adapter paths.
            </Text>
            <Text as="p" type="supporting">
              <strong>ChatGPT token lifetime:</strong> ChatGPT/Codex sign-in tokens expire, but the official Codex client refreshes them automatically during active use before they expire, so active sessions usually continue without another browser login. The <a href="https://learn.chatgpt.com/docs/auth" target="_blank" rel="noreferrer">official OpenAI authentication documentation</a> does not publish a fixed 10-day lifetime; do not plan around one. That upstream provider credential is separate from Relmio&apos;s local client capability, which remains valid until you rotate it.
            </Text>
            <Text as="p" type="supporting">
              <strong>Package-manager status:</strong> Homebrew is available from the public <code>Demonbane18/relmio</code> tap. The WinGet command stays hidden until Microsoft accepts its catalog pull request and the catalog updates.
            </Text>
            <Text as="p" type="supporting">
              <strong>Run this on your own computer, not inside the n8n container.</strong> The direct macOS/Linux and native Windows options reuse Node.js 22+ when available, or download and verify a temporary official runtime. NPX is for computers that already have Node.js 22 or newer. Relmio does not edit, rebuild, or restart your existing n8n container.
            </Text>
          </VStack>
        </details>

        <ol className="install-steps">
          {steps.map(([title, copy]) => (
            <li key={title}>
              <VStack gap={1}>
                <Heading level={3}>{title}</Heading>
                <Text as="p" type="supporting">{copy}</Text>
              </VStack>
            </li>
          ))}
        </ol>
      </section>

      <footer className="editorial-footer install-footer">
        <HStack className="editorial-footer-inner" gap={3} justify="between" align="center" wrap="wrap">
          <Button label="Back to Relmio" href="/" variant="secondary" size="lg">
            Back to Relmio
          </Button>
          <HStack gap={3} wrap="wrap">
            <Link href="/#security">Review the safety boundary</Link>
            <Link href="/docs/ai-assistant">Follow the setup guide</Link>
          </HStack>
        </HStack>
      </footer>
    </main>
  );
}

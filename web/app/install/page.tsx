import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { Button } from "@astryxdesign/core/Button";
import { HStack } from "@astryxdesign/core/HStack";
import { Text } from "@astryxdesign/core/Text";
import { ChevronDown } from "lucide-react";
import { CopyCommand } from "../components/CopyCommand";
import { HashLink } from "../components/HashLink";
import { RepositoryButton } from "../components/RepositoryButton";
import { SupportButton } from "../components/SupportButton";
import { ThemeModeControl } from "../components/ThemeModeControl";
import styles from "./install.module.css";

export const metadata: Metadata = {
  title: "Install Relmio for self-hosted n8n",
  description:
    "Install the local Relmio wizard with Homebrew, macOS/Linux, PowerShell, Command Prompt, or NPX.",
};

const steps = [
  ["Choose your terminal", "Pick the command that matches the computer in front of you."],
  ["Start Relmio locally", "Run the wizard on your computer, never inside the n8n container."],
  ["Verify before writes", "Confirm the target fingerprint and exact companion plan before approval."],
] as const;

export default function InstallPage() {
  return (
    <main className={`editorial-install ${styles.page}`} id="main-content">
      <HashLink className="skip-link" focusTarget targetId="install-command">
        Skip to installation command
      </HashLink>
      <header className={`editorial-header editorial-install-header ${styles.header}`}>
        <HStack className="editorial-header-inner" gap={4} justify="between" align="center">
          <Link className="editorial-brand" href="/" aria-label="Relmio home">
            <HStack gap={2} align="center">
              <Image src="/relmio-icon.png" alt="" width={38} height={38} priority unoptimized />
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

      <section className={styles.intro} aria-labelledby="install-title">
        <p className={styles.eyebrow}>Self-hosted n8n · local installer</p>
        <div className={styles.introGrid}>
          <h1 id="install-title">Install Relmio on your computer.</h1>
          <p>
            Connect to a compatible self-hosted n8n setup, inspect the target,
            then approve the exact companion plan only when it matches.
          </p>
        </div>
      </section>

      <section
        className={styles.toolbox}
        id="install-command"
        tabIndex={-1}
        data-install-toolbox
        aria-labelledby="install-method-title"
      >
        <div className={styles.toolboxHeading}>
          <p>Start locally</p>
          <h2 id="install-method-title">Choose an installation method</h2>
        </div>
        <CopyCommand />

        <ol className={styles.steps} aria-label="Installation sequence">
          {steps.map(([title, copy]) => (
            <li key={title}>
              <strong>{title}</strong>
              <span>{copy}</span>
            </li>
          ))}
        </ol>
      </section>

      <section className={styles.reference} aria-label="Installation details">
        <details className={styles.disclosure}>
          <summary>
            <span>
              <strong>Safety, credentials, and runtime</strong>
              <small>What the wizard uses and what it leaves untouched</small>
            </span>
            <ChevronDown aria-hidden="true" />
          </summary>
          <div className={styles.disclosureGrid}>
            <section>
              <h3>Where it runs</h3>
              <p>
                Run Relmio on your own computer, not inside the n8n container.
                Direct installers reuse Node.js 22+ when available or download
                and verify a temporary official runtime. NPX requires Node.js 22+.
              </p>
            </section>
            <section>
              <h3>Existing n8n boundary</h3>
              <p>
                Discovery starts read-only. Relmio does not edit, rebuild, or
                restart your existing n8n container, and it stops for fingerprint,
                plan, and final write confirmation.
              </p>
            </section>
            <section>
              <h3>Credential boundary</h3>
              <p>
                The OpenAI-compatible <code>/v1</code> route uses a Platform API
                key. ChatGPT sign-in is only for the experimental Codex App Server
                and Chat Adapter paths.
              </p>
            </section>
            <section>
              <h3>Packages and sessions</h3>
              <p>
                Homebrew is public through <code>Demonbane18/relmio</code>. WinGet
                remains hidden until Microsoft accepts the catalog pull request and
                the public catalog updates. ChatGPT tokens expire, but the official
                client refreshes active sessions; OpenAI publishes no fixed 10-day
                lifetime. <a href="https://learn.chatgpt.com/docs/auth" target="_blank" rel="noreferrer">Read the authentication guide</a>.
              </p>
            </section>
          </div>
        </details>
      </section>

      <footer className={`editorial-footer install-footer ${styles.footer}`}>
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

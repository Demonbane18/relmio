import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
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
  {
    index: "01",
    title: "Choose an install method",
    copy: "Use Homebrew, your local shell, or NPX. Windows does not need Git Bash.",
  },
  {
    index: "02",
    title: "Start locally",
    copy: "Paste the command on your own computer and keep that terminal open.",
  },
  {
    index: "03",
    title: "Verify, then approve",
    copy: "Confirm the SSH fingerprint and sidecar plan before any VPS write.",
  },
];

export default function InstallPage() {
  return (
    <main className="install-shell" id="main-content">
      <a className="skip-link" href="#install-command">
        Skip to installation command
      </a>
      <header className="site-header install-header">
        <div className="site-header-inner">
          <Link className="brand" href="/" aria-label="Relmio home">
            <Image
              src="/relmio-mark.svg"
              alt=""
              width={38}
              height={38}
              priority
            />
            <span>Relmio</span>
          </Link>
          <Link className="install-back-link" href="/">
            Hosted chat
          </Link>
          <div className="header-actions">
            <ThemeModeControl />
            <SupportButton />
            <RepositoryButton />
          </div>
        </div>
      </header>

      <section className="install-page">
        <div className="install-panel">
          <p className="eyebrow install-eyebrow">
            <span className="status-dot" aria-hidden="true" />
            n8n + Hostinger VPS
          </p>
          <h1>Install Relmio for n8n</h1>
          <p className="install-lede">
            Run one local wizard to sign in with ChatGPT, verify your VPS, and
            install a private OpenAI-compatible sidecar beside n8n. Choose
            Homebrew or the terminal already on your computer. Native Windows
            works without Git Bash or a preinstalled Node.js runtime.
          </p>

          <p className="install-boundary">
            <strong>Local endpoint choice:</strong> The OpenAI-compatible /v1
            option uses a Platform API key. ChatGPT sign-in is only for the
            experimental Codex App Server and Chat Adapter paths.
          </p>

          <p className="install-boundary">
            <strong>ChatGPT token lifetime:</strong> ChatGPT/Codex sign-in
            tokens expire, but the official Codex client refreshes them
            automatically during active use before they expire, so active
            sessions usually continue without another browser login. The{" "}
            <a
              href="https://learn.chatgpt.com/docs/auth"
              target="_blank"
              rel="noreferrer"
            >
              official OpenAI authentication documentation
            </a>{" "}
            does not publish a fixed 10-day lifetime; do not plan around one.
            That upstream provider credential is separate from Relmio&apos;s
            local client capability, which remains valid until you rotate it.
          </p>

          <div className="install-command-stage" id="install-command">
            <p>Choose an installation method</p>
            <CopyCommand />
          </div>

          <p className="install-boundary">
            <strong>Package-manager status:</strong> Homebrew is available from
            the public <code>Demonbane18/relmio</code> tap. The WinGet command
            stays hidden until Microsoft accepts its catalog pull request and
            the catalog updates.
          </p>

          <p className="install-boundary">
            <strong>Run this on your own computer, not on the VPS.</strong>{" "}
            The direct macOS/Linux and native Windows options reuse Node.js 22+
            when available, or download and verify a temporary official
            runtime. NPX is for computers that already have Node.js 22 or
            newer. Relmio does not edit, rebuild, or restart your existing n8n
            container.
          </p>

          <ol className="install-steps">
            {steps.map((step) => (
              <li key={step.index}>
                <span>{step.index}</span>
                <div>
                  <strong>{step.title}</strong>
                  <p>{step.copy}</p>
                </div>
              </li>
            ))}
          </ol>

          <div className="install-page-actions">
            <Link className="button button-primary" href="/">
              Back to Relmio
              <span aria-hidden="true">↖</span>
            </Link>
            <Link className="button button-secondary" href="/#security">
              Review the safety boundary
            </Link>
          </div>
        </div>
      </section>
    </main>
  );
}

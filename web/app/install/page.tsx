import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import { CopyCommand } from "../components/CopyCommand";
import { RepositoryButton } from "../components/RepositoryButton";

export const metadata: Metadata = {
  title: "Install Relmio for n8n",
  description:
    "Run the local Relmio wizard without installing Node.js first, including for Hostinger VPS setups.",
};

const steps = [
  {
    index: "01",
    title: "Run locally",
    copy: "Start the wizard on your own computer, not on the VPS.",
  },
  {
    index: "02",
    title: "Verify the VPS",
    copy: "Confirm the SSH fingerprint before entering your server password.",
  },
  {
    index: "03",
    title: "Approve the sidecar",
    copy: "Review the plan before Relmio writes its separate Docker project.",
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
          <RepositoryButton />
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
            install a private OpenAI-compatible sidecar beside n8n. Use Curl
            for a managed temporary runtime, or NPX when Node.js is ready.
          </p>

          <div className="install-command-stage" id="install-command">
            <p>Choose an installation method</p>
            <CopyCommand />
          </div>

          <p className="install-boundary">
            <strong>Run this on your own computer, not on the VPS.</strong>{" "}
            Choose Curl to avoid installing Node.js first, or NPX if Node.js
            22 or newer is already installed. Relmio does not edit, rebuild,
            or restart your existing n8n container.
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

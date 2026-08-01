import { Button } from "@astryxdesign/core/Button";
import { Heading } from "@astryxdesign/core/Heading";
import { Icon } from "@astryxdesign/core/Icon";
import { Text } from "@astryxdesign/core/Text";
import type { Metadata } from "next";
import { CopyCommand } from "../components/CopyCommand";
import { SiteHeader } from "../components/SiteHeader";

export const metadata: Metadata = {
  title: "Install Relmio for n8n",
  description:
    "Start the local Relmio wizard from macOS, Linux, PowerShell, or Command Prompt, verify your VPS, and review every remote write.",
};

const installGates = [
  {
    title: "Sign in",
    detail: "Authorize on this computer",
    boundary: "Local",
  },
  {
    title: "Verify host",
    detail: "Confirm the SSH fingerprint",
    boundary: "Required",
  },
  {
    title: "Select n8n",
    detail: "Choose the detected network",
    boundary: "Read only",
  },
  {
    title: "Review plan",
    detail: "See every remote write",
    boundary: "Preview",
  },
  {
    title: "Install",
    detail: "Create the private sidecar",
    boundary: "Confirmed",
  },
];

export default function InstallPage() {
  return (
    <>
      <a className="skip-link" href="#install-command">
        Skip to installation command
      </a>
      <SiteHeader />

      <main className="install-main" id="main-content">
        <section className="install-hero" aria-labelledby="install-title">
          <article className="install-narrative">
            <Heading level={1} type="display-1" id="install-title">
              Your local route starts here.
            </Heading>
            <Text as="p" type="large" color="secondary">
              Run one browser wizard on your own computer to sign in, verify a
              Hostinger VPS or another self-hosted VPS, and prepare a separate
              private sidecar for the n8n deployment you already use.
            </Text>
            <aside className="local-boundary">
              <Icon icon="info" color="accent" label="Local setup boundary" />
              <span>
                <strong>Run this on your own computer, not on the VPS.</strong>
                <small>
                  Relmio does not edit, rebuild, recreate, stop, or restart your
                  existing n8n container.
                </small>
              </span>
            </aside>
          </article>

          <section
            className="install-command-stage"
            id="install-command"
            aria-labelledby="install-command-title"
          >
            <header>
              <Heading level={2} id="install-command-title">
                Choose your local terminal
              </Heading>
              <p>
                The macOS/Linux and native Windows options can provide a
                verified temporary runtime. NPX uses Node.js 22 or newer when
                it is already installed.
              </p>
            </header>
            <CopyCommand />
          </section>
        </section>

        <section className="install-route" aria-labelledby="install-route-title">
          <header className="section-heading split-heading">
            <Heading level={2} type="display-3" id="install-route-title">
              Five gates, one deliberate install.
            </Heading>
            <Text as="p" type="large" color="secondary">
              Every step exposes the boundary that matters before the next
              action becomes available.
            </Text>
          </header>

          <ol className="install-gates">
            {installGates.map((gate, index) => (
              <li key={gate.title}>
                <span className="gate-index" aria-hidden="true">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <span>
                  <strong>{gate.title}</strong>
                  <small>{gate.detail}</small>
                </span>
                <em>{gate.boundary}</em>
              </li>
            ))}
          </ol>
        </section>

        <section className="install-assurances" aria-labelledby="assurances-title">
          <Heading level={2} id="assurances-title">
            What the wizard protects
          </Heading>
          <ul>
            <li>
              <Icon icon="check" color="accent" />
              <span>
                <strong>Host identity first</strong>
                <small>Your password unlocks only after fingerprint confirmation.</small>
              </span>
            </li>
            <li>
              <Icon icon="check" color="accent" />
              <span>
                <strong>Read-only discovery</strong>
                <small>Relmio inspects Docker before proposing any write.</small>
              </span>
            </li>
            <li>
              <Icon icon="check" color="accent" />
              <span>
                <strong>Sidecar-only plan</strong>
                <small>The project is confined to /docker/n8n-openai-oauth.</small>
              </span>
            </li>
            <li>
              <Icon icon="check" color="accent" />
              <span>
                <strong>Private network route</strong>
                <small>VPS port 10531 is never published on the host.</small>
              </span>
            </li>
          </ul>
        </section>

        <section className="install-closing" aria-labelledby="install-closing-title">
          <span>
            <Heading level={2} id="install-closing-title">
              Want context before running a command?
            </Heading>
            <p>
              Review the hosted explanation and complete safety boundary first.
            </p>
          </span>
          <nav aria-label="Install page actions">
            <Button href="/" label="Back to Relmio" size="lg" variant="secondary" />
            <Button
              href="/#safety"
              label="Review the safety boundary"
              size="lg"
              variant="primary"
            />
          </nav>
        </section>
      </main>
    </>
  );
}

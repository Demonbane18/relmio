import { Button } from "@astryxdesign/core/Button";
import { Heading } from "@astryxdesign/core/Heading";
import { Icon } from "@astryxdesign/core/Icon";
import { Link } from "@astryxdesign/core/Link";
import { Text } from "@astryxdesign/core/Text";
import { ChatConsole } from "./components/ChatConsole";
import { SignalRoute } from "./components/SignalRoute";
import { SiteHeader } from "./components/SiteHeader";

const boundaries = [
  {
    title: "Existing n8n stays untouched",
    detail: "No edit, rebuild, recreate, stop, or restart.",
  },
  {
    title: "No public VPS port",
    detail: "The sidecar stays on the existing Docker network.",
  },
  {
    title: "Tokens are not logged",
    detail: "Secrets are excluded from application output.",
  },
  {
    title: "Remote writes require confirmation",
    detail: "You see the exact plan before installation.",
  },
];

const gates = [
  {
    title: "Sign in",
    detail: "Authorize on this computer",
  },
  {
    title: "Verify host",
    detail: "Confirm the SSH fingerprint",
  },
  {
    title: "Select n8n",
    detail: "Choose the detected network",
  },
  {
    title: "Review plan",
    detail: "See every remote write",
  },
  {
    title: "Install",
    detail: "Create the private sidecar",
  },
];

const chromeExtensionUrl =
  "https://chromewebstore.google.com/detail/sign-in-with-chatgpt/odbgboachaefbbbdiffcefhpkekhfcna";
const firefoxExtensionUrl =
  "https://addons.mozilla.org/firefox/addon/sign-in-with-chatgpt/";

export default function Home() {
  return (
    <>
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>
      <SiteHeader />

      <main className="site-main" id="main-content">
        <section className="hero-layout" id="top" aria-labelledby="hero-title">
          <article className="hero-narrative">
            <Heading level={1} type="display-1" id="hero-title">
              Your ChatGPT plan, safely relayed.
            </Heading>
            <Text as="p" type="large" color="secondary">
              Connect an existing self-hosted n8n setup to a private
              OpenAI-compatible sidecar without replacing the deployment you
              already trust.
            </Text>
            <nav className="hero-actions" aria-label="Get started">
              <Button
                href="/install"
                label="Run local wizard"
                size="lg"
                variant="primary"
                endContent={<Icon icon="chevronRight" color="inherit" />}
              />
              <Button
                href="#chat"
                label="Try hosted chat"
                size="lg"
                variant="secondary"
              />
            </nav>
            <p className="hero-qualifier">
              Unofficial and experimental. Relmio does not create an OpenAI
              Platform API key or bypass account controls.
            </p>
          </article>

          <SignalRoute />
        </section>

        <section className="boundary-ledger" id="safety" aria-labelledby="boundary-ledger-title">
          <Heading level={2} id="boundary-ledger-title">
            Boundaries you can verify
          </Heading>
          <ul>
            {boundaries.map((boundary) => (
              <li key={boundary.title}>
                <Icon icon="check" color="accent" size="sm" />
                <span>
                  <strong>{boundary.title}</strong>
                  <small>{boundary.detail}</small>
                </span>
              </li>
            ))}
          </ul>
        </section>

        <section
          className="gate-section"
          id="how-it-works"
          aria-labelledby="gate-section-title"
        >
          <header className="section-heading split-heading">
            <Heading level={2} type="display-3" id="gate-section-title">
              One route. Five deliberate gates.
            </Heading>
            <Text as="p" type="large" color="secondary">
              Each checkpoint answers one trust question before the next one
              becomes available.
            </Text>
          </header>

          <ol className="gate-ledger">
            {gates.map((gate, index) => (
              <li key={gate.title}>
                <span className="gate-index" aria-hidden="true">
                  {String(index + 1).padStart(2, "0")}
                </span>
                <strong>{gate.title}</strong>
                <small>{gate.detail}</small>
              </li>
            ))}
          </ol>
        </section>

        <section className="chat-section" id="chat" aria-labelledby="chat-title">
          <article className="chat-narrative">
            <Heading level={2} type="display-3" id="chat-title">
              A request-bound test lane.
            </Heading>
            <Text as="p" type="large" color="secondary">
              The hosted chat lets you test a supported browser sign-in before
              you choose the separate local installer for n8n.
            </Text>

            <aside className="extension-guide" aria-labelledby="extension-guide-title">
              <Icon icon="info" color="accent" label="Setup information" />
              <span>
                <strong id="extension-guide-title">
                  Before you connect: install the browser extension
                </strong>
                <p>
                  Add Sign in with ChatGPT for{" "}
                  <Link href={chromeExtensionUrl} isExternalLink>
                    Chrome-compatible browsers
                  </Link>{" "}
                  or{" "}
                  <Link href={firefoxExtensionUrl} isExternalLink>
                    Firefox
                  </Link>
                  , reload this page, then connect again.
                </p>
                <p>
                  Using the local npm wizard? It handles its own localhost
                  callback. If an OAuth extension intercepts that callback,
                  temporarily disable it during local sign-in.
                </p>
              </span>
            </aside>
          </article>

          <ChatConsole />
        </section>

        <section className="safety-section" aria-labelledby="safety-title">
          <header className="section-heading split-heading">
            <Heading level={2} type="display-3" id="safety-title">
              The boundary is part of the product.
            </Heading>
            <Text as="p" type="large" color="secondary">
              The hosted chat and local installer are intentionally separate.
              One demonstrates request-bound access; the other prepares your
              private VPS route.
            </Text>
          </header>

          <section className="boundary-comparison" aria-label="Relmio operating boundaries">
            <article>
              <Heading level={3}>Try the hosted browser route</Heading>
              <p>
                Connect, send a request, inspect the response, and disconnect
                from the same browser surface.
              </p>
            </article>
            <article>
              <Heading level={3}>Install locally beside n8n</Heading>
              <p>
                Verify your VPS, inspect Docker with read-only commands, review
                the plan, and approve a separate sidecar.
              </p>
            </article>
          </section>
        </section>

        <section className="closing-section" aria-labelledby="closing-title">
          <span>
            <Heading level={2} type="display-3" id="closing-title">
              Ready to establish the private route?
            </Heading>
            <Text as="p" type="large" color="secondary">
              Start locally. Nothing is written to the VPS until you approve
              the reviewed plan.
            </Text>
          </span>
          <Button
            href="/install"
            label="Run local wizard"
            size="lg"
            variant="primary"
            endContent={<Icon icon="chevronRight" color="inherit" />}
          />
        </section>
      </main>

      <footer className="site-footer">
        <strong>Relmio</strong>
        <p>
          Built on the open-source{" "}
          <Link
            href="https://github.com/EvanZhouDev/openai-oauth"
            isExternalLink
          >
            openai-oauth method by Evan Zhou Dev
          </Link>
          .
        </p>
        <nav aria-label="Footer navigation">
          <Link href="https://www.npmjs.com/package/relmio" isExternalLink>
            npm
          </Link>
          <Link href="https://github.com/Demonbane18/relmio" isExternalLink>
            GitHub
          </Link>
          <Link href="/#safety">Safety</Link>
        </nav>
      </footer>
    </>
  );
}

import Link from "next/link";
import { DoorwayHero } from "./components/relay/DoorwayHero";
import { SignalPlotter } from "./components/relay/SignalPlotter";
import { Icon } from "./components/ui/Icon";
import styles from "./page.module.css";

const boundaries = [
  {
    title: "Local only",
    text: "Local endpoints bind to 127.0.0.1 by default.",
  },
  {
    title: "You approve changes",
    text: "The wizard shows the exact plan before any VPS write.",
  },
  {
    title: "n8n stays separate",
    text: "The companion wizard does not edit the existing n8n container, image, or workflows.",
  },
  {
    title: "Your own sign-in",
    text: "No subscription pool or OpenAI Platform API key. Hosted chat route code does not log OAuth tokens.",
  },
];

export default function Home() {
  return (
    <main id="main-content" className="rm-app__main" tabIndex={-1}>
      <div className={`rm-container ${styles.page}`}>
        <section className={styles.hero} aria-labelledby="home-title">
          <div className={styles.intro}>
            <h1 id="home-title" className={`rm-display ${styles.title}`}>
              Bring your AI <span className={styles.nowrap}>sign-ins</span> to your tools.
            </h1>
            <p className={`rm-lede ${styles.lede}`}>
              Keep every credential where it belongs. Relmio guides you through sign-in and
              setup for n8n and local tools.
            </p>
            <div className={styles.actions}>
              <Link className="rm-button rm-button--primary" href="/install">
                Install Relmio
                <Icon name="arrow-right" size="sm" />
              </Link>
              <Link className="rm-button" href="/chat">
                <Icon name="message" size="sm" />
                Try the chat
              </Link>
              <Link className="rm-button rm-button--ghost" href="/docs">
                <Icon name="book" size="sm" />
                Read the docs
              </Link>
            </div>
          </div>
          <div className={styles.sceneCell}>
            <DoorwayHero className={styles.scene} />
          </div>
        </section>

        <div className={styles.details}>
          <SignalPlotter className={styles.guide} />
          <section className={styles.safety} aria-labelledby="safety-title">
            <h2 id="safety-title" className="rm-h3">
              Safety boundaries
            </h2>
            <ul className={styles.boundaryList}>
              {boundaries.map((boundary) => (
                <li key={boundary.title}>
                  <Icon name="shield" size="sm" className={styles.boundaryIcon} />
                  <span className={styles.boundaryTitle}>{boundary.title}</span>
                  <span className={styles.boundaryText}>{boundary.text}</span>
                </li>
              ))}
            </ul>
          </section>

          <footer className={styles.footer}>
            <p>
              Hosted sign-in uses the{" "}
              <a
                className="rm-link rm-link--quiet"
                href="https://github.com/EvanZhouDev/openai-oauth"
                target="_blank"
                rel="noopener noreferrer"
              >
                openai-oauth method by Evan Zhou Dev
                <span className="rm-visually-hidden"> (opens in a new tab)</span>
              </a>
              .
            </p>
            <a
              className="rm-link rm-link--quiet"
              href="https://www.npmjs.com/package/relmio"
              target="_blank"
              rel="noopener noreferrer"
            >
              relmio on npm
              <span className="rm-visually-hidden"> (opens in a new tab)</span>
            </a>
          </footer>
        </div>
      </div>
    </main>
  );
}

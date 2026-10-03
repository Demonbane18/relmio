import { headers } from "next/headers";
import Link from "next/link";
import { SavedSignInCleanup } from "./components/SavedSignInCleanup";
import { DoorwayHero } from "./components/relay/DoorwayHero";
import { SignalPlotter } from "./components/relay/SignalPlotter";
import { classNames } from "./components/ui/classNames";
import { Icon } from "./components/ui/Icon";
import { creatorLinks } from "./components/ui/SiteFooter";
import styles from "./page.module.css";
import { canonicalOrigin } from "./request-origin";
import site from "./site.module.css";

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
    text: "No subscription pool or OpenAI Platform API key. ChatGPT sign-in runs in the local wizard.",
  },
];

// Night-sky decoration for the safety band, in the doorway scene's star shape.
const stars = [
  [72, 34, 1],
  [214, 88, 0.7],
  [388, 22, 0.85],
  [530, 70, 0.6],
  [610, 18, 1],
] as const;

const home = new URL("/", canonicalOrigin).href;
const creatorId = `${home}#creator`;
// Escaping "<" keeps the JSON from closing its script element.
const structuredData = JSON.stringify({
  "@context": "https://schema.org",
  "@graph": [
    {
      "@type": "SoftwareApplication",
      name: "Relmio",
      url: home,
      image: new URL("/relmio-icon.png", canonicalOrigin).href,
      applicationCategory: "DeveloperApplication",
      operatingSystem: "macOS, Linux, Windows",
      license: "https://www.apache.org/licenses/LICENSE-2.0",
      offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
      author: { "@id": creatorId },
    },
    {
      "@type": "Person",
      "@id": creatorId,
      name: "John Paul Fusin",
      sameAs: creatorLinks.map(({ href }) => href),
    },
  ],
}).replace(/</gu, "\\u003c");

export default async function Home() {
  const nonce = (await headers()).get("x-nonce") ?? undefined;
  return (
    <main id="main-content" className="rm-app__main" tabIndex={-1}>
      <script
        type="application/ld+json"
        nonce={nonce}
        suppressHydrationWarning
        dangerouslySetInnerHTML={{ __html: structuredData }}
      />
      <section className={styles.hero} aria-labelledby="home-title">
        <div className={`rm-container ${styles.heroInner}`}>
          <div className={styles.intro}>
            <h1 id="home-title" className={`rm-display ${styles.title}`}>
              Bring your AI <span className={styles.highlight}>sign-ins</span> to your tools.
            </h1>
            <p className={`rm-lede ${styles.lede}`}>
              Keep every credential where it belongs. Relmio guides you through sign-in and
              setup for n8n and local tools.
            </p>
            <div className={styles.actions}>
              <Link className={`rm-button rm-button--primary ${styles.cta}`} href="/install">
                Install Relmio
                <Icon name="arrow-right" size="sm" />
              </Link>
              <Link className={`rm-button rm-button--ghost ${styles.cta}`} href="/docs">
                <Icon name="book" size="sm" />
                Read the docs
              </Link>
            </div>
          </div>
          <DoorwayHero className={styles.scene} />
        </div>
      </section>

      <SignalPlotter className={classNames(site.hillEdge, styles.how)} />

      <section className={styles.chat} id="chat" aria-labelledby="chat-title">
        <div className={`rm-container ${styles.chatGrid}`}>
          <div className={classNames(styles.chatCopy, site.reveal)}>
            <p className="rm-eyebrow">Hosted chat</p>
            <h2 id="chat-title" className={site.sectionTitle}>
              Hosted chat is off.
            </h2>
            <p className="rm-lede">
              Relmio turned off chat and ChatGPT sign-in on this site while it applies to OpenAI
              for access. For now, sign-in works only in the local wizard on your own computer.
            </p>
            <p className={styles.chatNote}>
              Relmio never used an OpenAI Platform API key for ChatGPT sign-in.
            </p>
            <Link className="rm-link rm-link--standalone" href="/install">
              Install the local wizard
              <Icon name="arrow-right" size="xs" />
            </Link>
          </div>
          <div className={`rm-card ${styles.cleanup}`}>
            <h3 className="rm-h3">Signed in here before?</h3>
            <p className={styles.cleanupText}>
              If you used the hosted chat, an encrypted copy of your sign-in may still be saved in
              this browser.
            </p>
            <noscript>
              <p className={styles.cleanupText}>
                Removing it needs JavaScript. You can also clear this site&apos;s data in your
                browser settings.
              </p>
            </noscript>
            <SavedSignInCleanup />
            <p className="rm-small rm-muted">
              This does not revoke access at OpenAI. To end it there, sign out of your other
              sessions in ChatGPT under Settings &gt; Security and login.
            </p>
          </div>
        </div>
      </section>

      <section
        className={classNames(styles.night, site.hillEdge)}
        id="security"
        aria-labelledby="safety-title"
      >
        <svg className={styles.stars} viewBox="0 0 680 110" aria-hidden="true">
          <path
            className={styles.moon}
            d="M 640 18 A 25 25 0 1 0 660 53 A 29 29 0 0 1 640 18 Z"
          />
          {stars.map(([x, y, scale]) => (
            <path
              key={x}
              className={styles.star}
              transform={`translate(${x} ${y}) scale(${scale * 1.6})`}
              d="M 0 -4 L 1.2 -1.2 L 4 0 L 1.2 1.2 L 0 4 L -1.2 1.2 L -4 0 L -1.2 -1.2 Z"
            />
          ))}
        </svg>
        <div className={`rm-container ${styles.safetyGrid}`}>
          <div className={classNames(styles.safetyCopy, site.reveal)}>
            <p className="rm-eyebrow">Safety boundary</p>
            <h2 id="safety-title" className={site.sectionTitle}>
              The n8n bridge stays private.
            </h2>
            <p className={styles.safetyLede}>
              Setup for n8n runs in the local wizard on your own computer.
            </p>
            <Link className="rm-link rm-link--standalone" href="/docs/security">
              Read the security guide
              <Icon name="arrow-right" size="xs" />
            </Link>
          </div>
          <ul className={classNames(styles.boundaryList, site.reveal)}>
            {boundaries.map((boundary) => (
              <li key={boundary.title}>
                <span className={styles.boundaryIcon}>
                  <Icon name="shield" />
                </span>
                <span className={styles.boundaryTitle}>{boundary.title}</span>
                <span className={styles.boundaryText}>{boundary.text}</span>
              </li>
            ))}
          </ul>
        </div>
      </section>
    </main>
  );
}

import { headers } from "next/headers";
import Link from "next/link";
import { ChatConsole } from "./components/ChatConsole";
import { DoorwayHero } from "./components/relay/DoorwayHero";
import { SignalPlotter } from "./components/relay/SignalPlotter";
import { Callout } from "./components/ui/Callout";
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
    text: "No subscription pool or OpenAI Platform API key. Hosted chat route code does not log OAuth tokens.",
  },
];

const chromeExtensionUrl =
  "https://chromewebstore.google.com/detail/sign-in-with-chatgpt/odbgboachaefbbbdiffcefhpkekhfcna";
const firefoxExtensionUrl = "https://addons.mozilla.org/firefox/addon/sign-in-with-chatgpt/";

// Night-sky decoration for the safety band, in the doorway scene's star shape.
const stars = [
  [72, 34, 1],
  [214, 88, 0.7],
  [388, 22, 0.85],
  [530, 70, 0.6],
  [610, 18, 1],
] as const;

function NewTabNote() {
  return <span className="rm-visually-hidden"> (opens in a new tab)</span>;
}

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
              <a className={`rm-button ${styles.cta}`} href="#chat">
                <Icon name="message" size="sm" />
                Try the chat
              </a>
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
              Connect, then ask.
            </h2>
            <p className="rm-lede">
              Each message sends your prompt and access token to Relmio on Vercel, then to
              OpenAI. Refresh and ID tokens stay in this browser and go only to OpenAI.
            </p>
            <Callout title="Before you connect: install the browser extension">
              The hosted chat needs the third-party Sign in with ChatGPT extension to complete
              the OAuth handoff. Install it for{" "}
              <a className="rm-link" href={chromeExtensionUrl} target="_blank" rel="noopener noreferrer">
                Chrome
                <NewTabNote />
              </a>{" "}
              or{" "}
              <a className="rm-link" href={firefoxExtensionUrl} target="_blank" rel="noopener noreferrer">
                Firefox
                <NewTabNote />
              </a>
              , reload this page, then connect again.
            </Callout>
            <ul className={styles.notes}>
              <li>
                <Icon name="laptop" size="sm" className={styles.noteIcon} />
                <span>
                  Using the local npm wizard? It handles its own localhost callback. If an OAuth
                  extension intercepts that callback, temporarily disable it during local sign-in.
                </span>
              </li>
              <li>
                <Icon name="lock" size="sm" className={styles.noteIcon} />
                <span>
                  Your session is encrypted in this browser&apos;s IndexedDB, but this site&apos;s
                  code can read it. A compromised browser, extension or site can too. Sign out
                  removes the local session, not access at OpenAI.
                </span>
              </li>
            </ul>
          </div>
          {/* No transform or isolation here: the sign-in component renders its
              fixed, full-viewport extension dialog inline inside this subtree. */}
          <div className={styles.console}>
            <noscript>
              <p className="rm-callout">
                Chat needs JavaScript to sign in and send messages. You can still read the{" "}
                <Link className="rm-link" href="/docs">
                  docs
                </Link>
                .
              </p>
            </noscript>
            <ChatConsole />
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
              The hosted chat is only a browser demo. Setup for n8n runs in the local wizard
              on your own computer.
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

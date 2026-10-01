import { pageMetadata } from "../page-metadata";
import Link from "next/link";
import { ChatConsole } from "../components/ChatConsole";
import { Callout } from "../components/ui/Callout";
import { Icon } from "../components/ui/Icon";
import styles from "./chat.module.css";

export const metadata = pageMetadata(
  "Hosted chat demo | Relmio",
  "Try Relmio's hosted chat with the ChatGPT account you sign into in this browser. No tools, files, commands or browsing.",
  "/chat",
);

const chromeExtensionUrl =
  "https://chromewebstore.google.com/detail/sign-in-with-chatgpt/odbgboachaefbbbdiffcefhpkekhfcna";
const firefoxExtensionUrl = "https://addons.mozilla.org/firefox/addon/sign-in-with-chatgpt/";

function NewTabNote() {
  return <span className="rm-visually-hidden"> (opens in a new tab)</span>;
}

export default function ChatPage() {
  return (
    <main id="main-content" className="rm-app__main" tabIndex={-1}>
      <div className={`rm-container ${styles.page}`}>
        <div className={styles.header}>
          <div className={styles.heading}>
            <span className="rm-eyebrow">Hosted chat</span>
            <h1 className="rm-h1">Connect, then ask.</h1>
          </div>
          <p className={styles.lede}>
            Each message sends your prompt and access token to Relmio on Vercel, then to OpenAI. Refresh and ID tokens stay in this browser and go only to OpenAI.
          </p>
        </div>
        <noscript><p className="rm-callout">Chat needs JavaScript to sign in and send messages. You can still read the <Link className="rm-link" href="/docs">docs</Link>.</p></noscript>

        <div className={styles.body}>
          <div className={styles.console} id="chat">
            <ChatConsole />
          </div>

          <aside className={styles.aside} aria-label="About the hosted chat">
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
                  Your session is encrypted in this browser&apos;s IndexedDB, but this site&apos;s code can read it. A compromised browser, extension or site can too. Sign out removes the local session, not access at OpenAI.
                </span>
              </li>
            </ul>

            <p className={styles.attribution}>
              Hosted sign-in uses the{" "}
              <a
                className="rm-link rm-link--quiet"
                href="https://github.com/EvanZhouDev/openai-oauth"
                target="_blank"
                rel="noopener noreferrer"
              >
                openai-oauth method by Evan Zhou Dev
                <NewTabNote />
              </a>
              .
            </p>
          </aside>
        </div>
      </div>
    </main>
  );
}

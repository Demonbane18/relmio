import { pageMetadata } from "../page-metadata";
import Link from "next/link";
import { CopyCommand } from "../components/CopyCommand";
import { classNames } from "../components/ui/classNames";
import { CopyButton } from "../components/ui/CopyButton";
import { Icon } from "../components/ui/Icon";
import site from "../site.module.css";
import styles from "./install.module.css";

export const metadata = pageMetadata(
  "Install Relmio for self-hosted n8n",
  "Install the local Relmio wizard with Homebrew, macOS/Linux, PowerShell, Command Prompt, or NPX.",
  "/install",
);

const assistantCommand = "npx --yes --ignore-scripts relmio@latest assistant";

const steps = [
  ["Choose your terminal", "Pick the command that matches the computer in front of you."],
  [
    "Run it on your computer",
    "Run Relmio on your own computer, not inside the n8n container. Discovery is read-only.",
  ],
  [
    "Approve before writes",
    "Confirm the server fingerprint and the exact plan. Relmio never edits, rebuilds or restarts your existing n8n container.",
  ],
] as const;

export default function InstallPage() {
  return (
    <main id="main-content" className="rm-app__main" tabIndex={-1}>
      <div className={`rm-container ${styles.page}`}>
        <section className={styles.intro} aria-labelledby="install-title">
          <p className="rm-eyebrow">Self-hosted n8n · local installer</p>
          <div className={styles.introGrid}>
            <h1 className={styles.title} id="install-title">
              Install Relmio on your computer.
            </h1>
            <p className={styles.lede}>
              Connect a compatible self-hosted n8n setup from your own computer. Relmio
              inspects the target first and changes nothing until you approve the exact plan.
            </p>
          </div>
        </section>

        <section
          className={styles.toolbox}
          id="install-command"
          data-install-toolbox
          aria-labelledby="install-method-title"
        >
          <header className={styles.toolboxHeading}>
            <p className="rm-eyebrow">Start locally</p>
            <h2 className={site.sectionTitle} id="install-method-title">
              Choose an installation method
            </h2>
          </header>
          <CopyCommand />
          <ol className={styles.steps} aria-label="Installation sequence">
            {steps.map(([title, text]) => (
              <li key={title}>
                <strong>{title}</strong>
                <span>{text}</span>
              </li>
            ))}
          </ol>
        </section>

        <section
          className={classNames(styles.assistant, site.reveal)}
          aria-labelledby="assistant-launch-title"
        >
          <div className={styles.assistantCopy}>
            <p className="rm-eyebrow">n8n AI Assistant companion</p>
            <h2 className={styles.assistantTitle} id="assistant-launch-title">
              Launch its own local wizard
            </h2>
            <Link className={`rm-link ${styles.guideLink}`} href="/docs/ai-assistant">
              Read the guide
              <span className="rm-visually-hidden"> for the n8n AI Assistant</span>
              <Icon name="arrow-right" size="xs" />
            </Link>
          </div>
          <div className={`rm-terminal ${styles.assistantCommand}`}>
            <pre className="rm-terminal__body">
              <span className="rm-terminal__prompt" aria-hidden="true">
                $
              </span>
              <code id="assistant-install-command">{assistantCommand}</code>
            </pre>
            <CopyButton targetId="assistant-install-command" label="AI Assistant command" />
          </div>
        </section>

        <section
          className={classNames(styles.reference, site.reveal)}
          aria-labelledby="install-details-title"
        >
          <h2 className={styles.referenceTitle} id="install-details-title">
            Install details
          </h2>
          <div className={styles.disclosureGrid}>
            <details className="rm-disclosure">
              <summary>Dashboard commands</summary>
              <div className="rm-disclosure__body">
                <p>
                  A persistent Homebrew or global npm install adds{" "}
                  <code>relmio start</code>, <code>relmio status</code>,{" "}
                  <code>relmio open</code> and <code>relmio stop</code>.
                </p>
                <p>
                  Stop ends only Relmio&apos;s dashboard process. It never stops n8n or a
                  managed companion.
                </p>
              </div>
            </details>
            <details className="rm-disclosure">
              <summary>Runtime and Node.js</summary>
              <div className="rm-disclosure__body">
                <p>
                  Direct installers reuse Node.js 24 or newer when it is installed.
                  Otherwise they download and verify a temporary official runtime, run
                  the one-shot wizard in the foreground and remove that runtime
                  afterward.
                </p>
                <p>NPX needs Node.js 24 or newer.</p>
              </div>
            </details>
            <details className="rm-disclosure">
              <summary>Homebrew and WinGet</summary>
              <div className="rm-disclosure__body">
                <p>
                  Homebrew is public through <code>Demonbane18/relmio</code>. Its
                  installer command trusts only the Relmio formula, not the whole tap.
                </p>
                <p>
                  WinGet remains hidden until Microsoft accepts the catalog pull request
                  and the public catalog updates.
                </p>
              </div>
            </details>
            <details className="rm-disclosure">
              <summary>Sign-in and tokens</summary>
              <div className="rm-disclosure__body">
                <p>
                  Codex and SuperGrok keep separate sign-in sessions. Experimental SuperGrok setup works with
                  local apps and private local or VPS n8n companions without a ChatGPT
                  credential.
                </p>
                <p>
                  ChatGPT/Codex sign-in tokens expire. The Codex authentication guide describes automatic
                  refresh but gives no fixed lifetime, and Relmio&apos;s bridge refreshes its own copy.{" "}
                  <a
                    className="rm-link"
                    href="https://learn.chatgpt.com/docs/auth"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Read the authentication guide
                    <Icon name="external" size="xs" className={styles.externalIcon} />
                    <span className="rm-visually-hidden"> (opens in a new tab)</span>
                  </a>
                </p>
              </div>
            </details>
          </div>
        </section>

        <nav className={styles.closing} aria-label="Next steps">
          <Link className="rm-button" href="/">
            <Icon name="arrow-left" size="sm" />
            Back to Relmio
          </Link>
          <div className={styles.closingLinks}>
            <Link className="rm-link" href="/#security">
              Review the safety boundary
            </Link>
            <Link className="rm-link" href="/docs/getting-started">
              Follow the setup guide
            </Link>
          </div>
        </nav>
      </div>
    </main>
  );
}

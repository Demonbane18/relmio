import { pageMetadata } from "../page-metadata";
import Link from "next/link";
import { CopyCommand } from "../components/CopyCommand";
import { CopyButton } from "../components/ui/CopyButton";
import { Icon } from "../components/ui/Icon";
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
        <div className={styles.primary}>
          <header className={styles.intro}>
            <p className="rm-eyebrow">Self-hosted n8n · local installer</p>
            <h1 className="rm-h1" id="install-title">
              Install Relmio on your computer.
            </h1>
            <p className={styles.lede}>
              Connect a compatible self-hosted n8n setup from your own computer.
              Relmio inspects the target first and changes nothing until you
              approve the exact plan.
            </p>
          </header>

          <section
            className={styles.toolbox}
            id="install-command"
            data-install-toolbox
            aria-labelledby="install-method-title"
          >
            <h2 className="rm-h3" id="install-method-title">
              Choose an installation method
            </h2>
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
        </div>

        <div className={styles.side}>
          <section className={styles.assistant} aria-labelledby="assistant-launch-title">
            <p className="rm-eyebrow">n8n AI Assistant companion</p>
            <div className={styles.assistantHead}>
              <h2 className="rm-h3" id="assistant-launch-title">
                Launch its own local wizard
              </h2>
              <Link className="rm-link" href="/docs/ai-assistant">
                Read the guide
                <span className="rm-visually-hidden"> for the n8n AI Assistant</span>
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

          <section className={styles.details} aria-labelledby="install-details-title">
            <h2 className="rm-h3" id="install-details-title">
              Install details
            </h2>
            <details className="rm-disclosure" name="install-details">
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
            <details className="rm-disclosure" name="install-details">
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
            <details className="rm-disclosure" name="install-details">
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
            <details className="rm-disclosure" name="install-details">
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
          </section>
        </div>
      </div>
    </main>
  );
}

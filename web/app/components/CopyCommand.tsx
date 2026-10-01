"use client";

import { type KeyboardEvent, useRef, useState } from "react";
import { nextTabIndex } from "./tabKeys";
import { CopyButton } from "./ui/CopyButton";
import { Icon } from "./ui/Icon";
import styles from "../install/install.module.css";

const installMethods = [
  {
    id: "posix",
    label: "macOS / Linux",
    command: "curl -fsSL https://relmio.jpfusin.tech/install.sh | sh",
    note: "For macOS, Linux, WSL, or Git Bash. Runs a foreground one-shot wizard; no preinstalled Node.js required.",
    prompt: "$",
  },
  {
    id: "homebrew",
    label: "Homebrew",
    command: "brew tap Demonbane18/relmio && brew trust --formula Demonbane18/relmio/relmio && brew install relmio",
    note: "For macOS or Linux with Homebrew. Trusts only the Relmio formula, then installs Relmio and Node.js.",
    prompt: "$",
  },
  {
    id: "powershell",
    label: "PowerShell",
    command: "irm https://relmio.jpfusin.tech/install.ps1 | iex",
    note: "For Windows PowerShell or PowerShell 7. Runs a foreground one-shot wizard; no Git Bash or preinstalled Node.js required.",
    prompt: "PS>",
  },
  {
    id: "cmd",
    label: "CMD",
    command:
      'for /f "delims=" %F in ("%TEMP%\\relmio-install-%RANDOM%-%RANDOM%-%RANDOM%.cmd") do @if exist "%~F" (exit /b 80) else curl -fsSL --remove-on-error https://relmio.jpfusin.tech/install.cmd -o "%~F" && set "RELMIO_SELF_DELETE=%~F" && call "%~F"',
    note: "For Command Prompt, not PowerShell. This non-admin bootstrap verifies a temporary runtime when Node.js 24+ is unavailable and runs as a foreground one-shot wizard.",
    prompt: ">",
  },
  {
    id: "npx",
    label: "NPX",
    command: "npx --yes --ignore-scripts relmio@latest",
    note: "For any local terminal that already has Node.js 24 or newer.",
    prompt: "$",
  },
] as const;

type InstallMethodId = (typeof installMethods)[number]["id"];

/** Installation method tabs and the selected command in a kit terminal.
    Arrow keys, Home and End move between tabs and select them. */
export function CopyCommand() {
  const [selectedMethod, setSelectedMethod] = useState<InstallMethodId>("posix");
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  function moveBetweenTabs(event: KeyboardEvent<HTMLButtonElement>, currentIndex: number) {
    const nextIndex = nextTabIndex(event.key, currentIndex, installMethods.length);
    if (nextIndex === null) return;

    event.preventDefault();
    setSelectedMethod(installMethods[nextIndex].id);
    tabRefs.current[nextIndex]?.focus();
  }

  return (
    <>
      <noscript>
        <div className={styles.noScript}>
          <p>Choose the command for your terminal. Copy and run it on your computer.</p>
          <div className={`rm-terminal ${styles.terminal}`}>
            <p className="rm-terminal__bar">{installMethods[0].label}</p>
            <pre className="rm-terminal__body"><code>{installMethods[0].command}</code></pre>
            <p className="rm-terminal__note">{installMethods[0].note}</p>
          </div>
          <div className={styles.noScriptAlternatives}>
            {installMethods.map((method, index) => index === 0 ? null : (
              <details className="rm-disclosure" key={method.id}>
                <summary>{method.label}</summary>
                <div className="rm-disclosure__body">
                  <div className={`rm-terminal ${styles.terminal}`}>
                    <pre className="rm-terminal__body"><code>{method.command}</code></pre>
                    <p className="rm-terminal__note">{method.note}</p>
                  </div>
                </div>
              </details>
            ))}
          </div>
        </div>
      </noscript>
    <div className={styles.picker}>
      <div className="rm-tabs__list" role="tablist" aria-label="Installation method">
        {installMethods.map((method, index) => {
          const selected = selectedMethod === method.id;

          return (
            <button
              key={method.id}
              ref={(element) => {
                tabRefs.current[index] = element;
              }}
              className="rm-tabs__tab"
              type="button"
              role="tab"
              id={`install-method-${method.id}-tab`}
              aria-selected={selected}
              aria-controls={`install-method-${method.id}-panel`}
              tabIndex={selected ? 0 : -1}
              onClick={() => setSelectedMethod(method.id)}
              onKeyDown={(event) => moveBetweenTabs(event, index)}
            >
              {method.label}
            </button>
          );
        })}
      </div>

      {installMethods.map((method) => (
        <div
          key={method.id}
          role="tabpanel"
          id={`install-method-${method.id}-panel`}
          aria-labelledby={`install-method-${method.id}-tab`}
          hidden={selectedMethod !== method.id}
        >
          <div className={`rm-terminal ${styles.terminal}`}>
            <div className="rm-terminal__bar">
              <Icon name="terminal" size="sm" />
              <span>{method.label}</span>
              <div className="rm-terminal__actions">
                <CopyButton targetId={`install-method-${method.id}-command`} label={`${method.label} installation command`} />
              </div>
            </div>
            <pre className="rm-terminal__body">
              <span className="rm-terminal__prompt" aria-hidden="true">
                {method.prompt}
              </span>
              <code id={`install-method-${method.id}-command`}>{method.command}</code>
            </pre>
            <p className="rm-terminal__note">{method.note}</p>
          </div>
        </div>
      ))}
    </div>
    </>
  );
}

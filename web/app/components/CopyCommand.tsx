"use client";

import { Check, Copy, SquareTerminal } from "lucide-react";
import {
  type KeyboardEvent,
  useEffect,
  useRef,
  useState,
} from "react";
import styles from "../install/install.module.css";

const installMethods = [
  {
    id: "posix",
    label: "macOS / Linux",
    command: "curl -fsSL https://relmio.vercel.app/install.sh | sh",
    note: "For macOS, Linux, WSL, or Git Bash. No preinstalled Node.js required.",
    prompt: "$",
  },
  {
    id: "homebrew",
    label: "Homebrew",
    command: "brew tap Demonbane18/relmio && brew install relmio",
    note: "For macOS or Linux computers with Homebrew. Installs Relmio and its Node.js dependency.",
    prompt: "$",
  },
  {
    id: "powershell",
    label: "PowerShell",
    command: "irm https://relmio.vercel.app/install.ps1 | iex",
    note: "For Windows PowerShell or PowerShell 7. No Git Bash or preinstalled Node.js required.",
    prompt: "PS>",
  },
  {
    id: "cmd",
    label: "CMD",
    command:
      'for /f "delims=" %F in ("%TEMP%\\relmio-install-%RANDOM%-%RANDOM%-%RANDOM%.cmd") do @if exist "%~F" (exit /b 80) else curl -fsSL --remove-on-error https://relmio.vercel.app/install.cmd -o "%~F" && set "RELMIO_SELF_DELETE=%~F" && call "%~F"',
    note: "For Command Prompt, not PowerShell. This non-admin bootstrap verifies a temporary runtime when Node.js 22+ is unavailable.",
    prompt: ">",
  },
  {
    id: "npx",
    label: "NPX",
    command: "npx --yes --ignore-scripts relmio@latest",
    note: "For any local terminal that already has Node.js 22 or newer.",
    prompt: "$",
  },
] as const;

type InstallMethod = (typeof installMethods)[number];
type InstallMethodId = InstallMethod["id"];
type CopyFeedback = {
  method: InstallMethodId;
  state: "copied" | "error";
} | null;

export function CopyCommand() {
  const [selectedMethod, setSelectedMethod] =
    useState<InstallMethodId>("posix");
  const [copyFeedback, setCopyFeedback] = useState<CopyFeedback>(null);
  const revertTimer = useRef<number | null>(null);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const activeMethod =
    installMethods.find((method) => method.id === selectedMethod) ?? installMethods[0];

  useEffect(() => {
    return () => {
      if (revertTimer.current !== null) {
        window.clearTimeout(revertTimer.current);
      }
    };
  }, []);

  function clearFeedback() {
    setCopyFeedback(null);
    if (revertTimer.current !== null) {
      window.clearTimeout(revertTimer.current);
      revertTimer.current = null;
    }
  }

  function selectMethod(method: InstallMethod) {
    setSelectedMethod(method.id);
    clearFeedback();
  }

  function moveBetweenTabs(
    event: KeyboardEvent<HTMLButtonElement>,
    currentIndex: number,
  ) {
    let nextIndex: number | null = null;

    if (event.key === "ArrowRight") {
      nextIndex = (currentIndex + 1) % installMethods.length;
    } else if (event.key === "ArrowLeft") {
      nextIndex =
        (currentIndex - 1 + installMethods.length) % installMethods.length;
    } else if (event.key === "Home") {
      nextIndex = 0;
    } else if (event.key === "End") {
      nextIndex = installMethods.length - 1;
    }

    if (nextIndex === null) return;

    event.preventDefault();
    selectMethod(installMethods[nextIndex]);
    tabRefs.current[nextIndex]?.focus();
  }

  async function copy(method: InstallMethod, trigger: HTMLButtonElement) {
    try {
      try {
        await navigator.clipboard.writeText(method.command);
      } catch {
        const textarea = document.createElement("textarea");
        textarea.value = method.command;
        textarea.readOnly = true;
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.append(textarea);
        try {
          textarea.select();
          if (!document.execCommand("copy")) {
            throw new Error("Clipboard fallback failed");
          }
        } finally {
          textarea.remove();
          trigger.focus();
        }
      }

      setCopyFeedback({ method: method.id, state: "copied" });
    } catch {
      setCopyFeedback({ method: method.id, state: "error" });
    }

    if (revertTimer.current !== null) window.clearTimeout(revertTimer.current);
    revertTimer.current = window.setTimeout(() => setCopyFeedback(null), 2200);
  }

  return (
    <section className={styles.methodPicker} aria-label="Installation command selector">
      <div
        className={styles.methodTabs}
        role="tablist"
        aria-label="Installation method"
        aria-orientation="horizontal"
      >
        {installMethods.map((method, index) => {
          const selected = selectedMethod === method.id;

          return (
            <button
              key={method.id}
              ref={(element) => {
                tabRefs.current[index] = element;
              }}
              type="button"
              className={styles.methodTab}
              id={`install-method-${method.id}-tab`}
              role="tab"
              aria-selected={selected}
              aria-controls={`install-method-${method.id}-panel`}
              tabIndex={selected ? 0 : -1}
              onClick={() => selectMethod(method)}
              onKeyDown={(event) => moveBetweenTabs(event, index)}
            >
              {method.label}
            </button>
          );
        })}
      </div>

      <span className={styles.srOnly} role="status" aria-live="polite" aria-atomic="true">
        Showing the {activeMethod.label} installation command.
      </span>

      {installMethods.map((method) => {
        const selected = selectedMethod === method.id;
        const feedback = copyFeedback?.method === method.id
          ? copyFeedback.state
          : null;

        return (
          <section
            key={method.id}
            className={styles.methodPanel}
            id={`install-method-${method.id}-panel`}
            role="tabpanel"
            aria-labelledby={`install-method-${method.id}-tab`}
            hidden={!selected}
          >
            <div className={styles.terminal} data-terminal-theme="always-dark">
              <header className={styles.terminalHeader}>
                <span className={styles.terminalTitle}>
                  <SquareTerminal aria-hidden="true" />
                  relmio / {method.label}
                </span>
                <button
                  type="button"
                  className={styles.copyButton}
                  data-state={feedback ?? "idle"}
                  onClick={(event) => void copy(method, event.currentTarget)}
                  aria-label={`Copy ${method.label} installation command`}
                  aria-describedby={`install-method-${method.id}-command install-method-${method.id}-note`}
                >
                  {feedback === "copied" ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
                  <span role="status" aria-live="polite" aria-atomic="true">
                    {feedback === "copied"
                      ? "Copied"
                      : feedback === "error"
                        ? "Copy failed"
                        : "Copy"}
                  </span>
                </button>
              </header>

              <div className={styles.commandLine}>
                <span aria-hidden="true">{method.prompt}</span>
                <code id={`install-method-${method.id}-command`}>{method.command}</code>
              </div>

              <p className={styles.methodNote} id={`install-method-${method.id}-note`}>
                {method.note}
              </p>
            </div>
          </section>
        );
      })}
    </section>
  );
}

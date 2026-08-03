"use client";

import {
  type KeyboardEvent,
  useEffect,
  useRef,
  useState,
} from "react";

const installMethods = [
  {
    id: "posix",
    label: "macOS / Linux",
    command: "curl -fsSL https://relmio.vercel.app/install.sh | sh",
    note: "For macOS, Linux, WSL, or Git Bash. No preinstalled Node.js required.",
    prompt: "$",
  },
  {
    id: "powershell",
    label: "PowerShell",
    command: "irm https://relmio.vercel.app/install.ps1 | iex",
    note: "Use Windows PowerShell or PowerShell 7 on Windows. No Git Bash or preinstalled Node.js required.",
    prompt: "PS>",
  },
  {
    id: "cmd",
    label: "CMD",
    command:
      '"%SystemRoot%\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -NoProfile -ExecutionPolicy Bypass -Command "irm https://relmio.vercel.app/install.ps1 | iex"',
    note: "Open Command Prompt, not PowerShell. This launches the same verified Windows installer.",
    prompt: ">",
  },
  {
    id: "npx",
    label: "NPX",
    command: "npx --yes --ignore-scripts relmio@latest",
    note: "NPX requires Node.js 22 or newer and works in any local terminal.",
    prompt: "$",
  },
] as const;

type InstallMethod = (typeof installMethods)[number];
type InstallMethodId = InstallMethod["id"];

export function CopyCommand() {
  const [selectedMethod, setSelectedMethod] =
    useState<InstallMethodId>("posix");
  const [copiedMethod, setCopiedMethod] = useState<InstallMethodId | null>(null);
  const revertTimer = useRef<number | null>(null);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);

  useEffect(() => {
    return () => {
      if (revertTimer.current !== null) {
        window.clearTimeout(revertTimer.current);
      }
    };
  }, []);

  function selectMethod(method: InstallMethod) {
    setSelectedMethod(method.id);
    setCopiedMethod(null);
    if (revertTimer.current !== null) {
      window.clearTimeout(revertTimer.current);
      revertTimer.current = null;
    }
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

    if (nextIndex === null) {
      return;
    }

    event.preventDefault();
    selectMethod(installMethods[nextIndex]);
    tabRefs.current[nextIndex]?.focus();
  }

  async function copy(method: InstallMethod) {
    try {
      await navigator.clipboard.writeText(method.command);
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = method.command;
      textarea.readOnly = true;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.append(textarea);
      textarea.select();
      document.execCommand("copy");
      textarea.remove();
    }

    setCopiedMethod(method.id);
    if (revertTimer.current !== null) {
      window.clearTimeout(revertTimer.current);
    }
    revertTimer.current = window.setTimeout(
      () => setCopiedMethod(null),
      1800,
    );
  }

  return (
    <div className="install-method-picker">
      <div
        className="install-method-tabs"
        role="tablist"
        aria-label="Local terminal"
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
              className="install-method-tab"
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

      {installMethods.map((method) => {
        const selected = selectedMethod === method.id;
        const copied = copiedMethod === method.id;

        return (
          <div
            key={method.id}
            className="install-method-panel"
            id={`install-method-${method.id}-panel`}
            role="tabpanel"
            aria-labelledby={`install-method-${method.id}-tab`}
            hidden={!selected}
          >
            <button
              type="button"
              className={`install-command${copied ? " copied" : ""}`}
              onClick={() => copy(method)}
              aria-label={`Copy installation command (${method.label}): ${method.command}`}
              aria-describedby={`install-method-${method.id}-note`}
            >
              <span className="terminal-mark" aria-hidden="true">
                {method.prompt}
              </span>
              <code>{method.command}</code>
              <span className="copy-hint" role="status" aria-live="polite">
                {copied ? "Copied" : "Copy"}
              </span>
            </button>
            <p
              className="install-method-note"
              id={`install-method-${method.id}-note`}
            >
              {method.note}
            </p>
          </div>
        );
      })}
    </div>
  );
}

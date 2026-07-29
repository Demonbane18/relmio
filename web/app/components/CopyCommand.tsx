"use client";

import { useEffect, useRef, useState } from "react";

const command = "npx --yes --ignore-scripts relmio@latest";

export function CopyCommand() {
  const [copied, setCopied] = useState(false);
  const revertTimer = useRef<number | null>(null);

  useEffect(() => {
    return () => {
      if (revertTimer.current !== null) {
        window.clearTimeout(revertTimer.current);
      }
    };
  }, []);

  async function copy() {
    try {
      await navigator.clipboard.writeText(command);
    } catch {
      const textarea = document.createElement("textarea");
      textarea.value = command;
      textarea.readOnly = true;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.append(textarea);
      textarea.select();
      document.execCommand("copy");
      textarea.remove();
    }
    setCopied(true);
    if (revertTimer.current !== null) {
      window.clearTimeout(revertTimer.current);
    }
    revertTimer.current = window.setTimeout(() => setCopied(false), 1800);
  }

  return (
    <button
      type="button"
      className={`install-command${copied ? " copied" : ""}`}
      onClick={copy}
      aria-label={`Copy installation command: ${command}`}
      aria-live="polite"
    >
      <span className="terminal-mark" aria-hidden="true">
        $
      </span>
      <code>{command}</code>
      <span className="copy-hint">{copied ? "Copied" : "Copy"}</span>
    </button>
  );
}

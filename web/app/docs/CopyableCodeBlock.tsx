"use client";

import { Check, Copy } from "lucide-react";
import {
  Children,
  isValidElement,
  type ReactNode,
  useEffect,
  useRef,
  useState,
} from "react";
import styles from "./docs.module.css";

function codeText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (isValidElement<{ children?: ReactNode }>(node)) return codeText(node.props.children);
  return Children.toArray(node).map(codeText).join("");
}

export function CopyableCodeBlock({ children }: { children: ReactNode }) {
  const [feedback, setFeedback] = useState<"copied" | "error" | null>(null);
  const timer = useRef<number | null>(null);

  useEffect(() => () => {
    if (timer.current !== null) window.clearTimeout(timer.current);
  }, []);

  async function copyCode() {
    try {
      const text = codeText(children);
      try {
        await navigator.clipboard.writeText(text);
      } catch {
        const textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.readOnly = true;
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.append(textarea);
        try {
          textarea.select();
          if (!document.execCommand("copy")) throw new Error("Clipboard fallback failed");
        } finally {
          textarea.remove();
        }
      }
      setFeedback("copied");
    } catch {
      setFeedback("error");
    }
    if (timer.current !== null) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setFeedback(null), 2200);
  }

  const label = feedback === "copied"
    ? "Code copied"
    : feedback === "error"
      ? "Could not copy code"
      : "Copy code block";

  return (
    <pre className={styles.copyableCodeBlock}>
      <button
        aria-label={label}
        className={styles.copyCodeButton}
        data-state={feedback ?? "idle"}
        onClick={() => void copyCode()}
        title={label}
        type="button"
      >
        {feedback === "copied" ? (
          <Check aria-hidden="true" />
        ) : (
          <Copy aria-hidden="true" />
        )}
      </button>
      <span
        className={styles.srOnly}
        aria-atomic="true"
        aria-live="polite"
        role="status"
      >
        {feedback === "copied" ? "Code copied." : feedback === "error" ? "Copy failed." : ""}
      </span>
      {children}
    </pre>
  );
}

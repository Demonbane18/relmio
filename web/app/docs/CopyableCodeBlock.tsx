"use client";

import { Children, isValidElement, type ReactNode, useId } from "react";
import { CopyButton } from "../components/ui/CopyButton";
import styles from "./docs.module.css";

function codeLanguage(children: ReactNode) {
  for (const child of Children.toArray(children)) {
    if (isValidElement<{ className?: string }>(child)) {
      const match = /\blanguage-([\w#+-]+)/u.exec(child.props.className ?? "");
      if (match) return match[1];
    }
  }
  return null;
}

/** A fenced Markdown code block drawn as a kit terminal with a copy button.
    Long lines scroll inside the block instead of widening the page; the block
    takes focus so keyboard users can scroll it too. */
export function CopyableCodeBlock({ children }: { children: ReactNode }) {
  const codeId = useId();
  const language = codeLanguage(children);
  return (
    <div className={`rm-terminal ${styles.codeBlock}`}>
      <div className="rm-terminal__bar">
        <span>{language ?? "code"}</span>
        <div className="rm-terminal__actions">
          <CopyButton targetId={codeId} label="code block" />
        </div>
      </div>
      <pre
        className="rm-terminal__body"
        id={codeId}
        tabIndex={0}
        role="group"
        aria-label={language ? `${language} code block` : "Code block"}
      >
        {children}
      </pre>
    </div>
  );
}

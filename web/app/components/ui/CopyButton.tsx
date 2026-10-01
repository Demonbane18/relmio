"use client";

import { useEffect, useRef, useState } from "react";
import { classNames } from "./classNames";
import { Icon } from "./Icon";

type CopyButtonProps = {
  targetId: string;
  /** What is copied, for the accessible name: "Copy {label}". */
  label: string;
  className?: string;
};

/** Icon button that copies text and announces the result politely without
    moving focus. */
export function CopyButton({ targetId, label, className }: CopyButtonProps) {
  const [copied, setCopied] = useState(false);
  const [announcement, setAnnouncement] = useState("");
  const resetTimer = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(resetTimer.current), []);

  async function copy() {
    window.clearTimeout(resetTimer.current);
    try {
      const text = document.getElementById(targetId)?.textContent;
      if (text === undefined || text === null) throw new Error("Copy target is missing.");
      await navigator.clipboard.writeText(text);
      setCopied(true);
      setAnnouncement(`Copied ${label}.`);
    } catch {
      setCopied(false);
      setAnnouncement("Copy failed. Select the text and copy it manually.");
    }
    resetTimer.current = window.setTimeout(() => setCopied(false), 2000);
  }

  return (
    <>
      <button
        className={classNames("rm-icon-button", "rm-icon-button--sm", className)}
        type="button"
        onClick={copy}
        aria-label={`Copy ${label}`}
        title={`Copy ${label}`}
      >
        <Icon name={copied ? "check" : "copy"} size="sm" />
      </button>
      <span className="rm-visually-hidden" role="status" aria-live="polite">
        {announcement}
      </span>
    </>
  );
}

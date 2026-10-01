"use client";

import { useId, useMemo } from "react";
import type { OutlineItem } from "./markdownText";
import { useActiveSection } from "./useActiveSection";
import styles from "./docs.module.css";

type DocumentOutlineProps = {
  items: readonly OutlineItem[];
  /** `rail`: the right column on wide screens, highlights the current section.
      `inline`: a disclosure above the guide on narrower screens. */
  variant: "rail" | "inline";
};

/** "On this page" links built from the guide's Markdown headings. */
export function DocumentOutline({ items, variant }: DocumentOutlineProps) {
  const headingId = useId();
  const ids = useMemo(() => items.map((item) => item.id), [items]);
  const activeId = useActiveSection(ids, variant === "rail");

  const list = (
    <ul className={styles.outlineList}>
      {items.map((item, index) => (
        <li key={`${item.id}-${index}`}>
          <a
            className={styles.outlineLink}
            href={`#${item.id}`}
            data-level={item.level}
            aria-current={item.id === activeId ? "true" : undefined}
          >
            {item.label}
          </a>
        </li>
      ))}
    </ul>
  );

  if (variant === "inline") {
    return (
      <details className={`rm-disclosure ${styles.outlineDisclosure}`}>
        <summary>On this page</summary>
        <nav className="rm-disclosure__body" aria-label="On this page">
          {list}
        </nav>
      </details>
    );
  }

  return (
    <nav className={styles.outline} aria-labelledby={headingId}>
      <p className="rm-sidebar__heading" id={headingId}>
        On this page
      </p>
      {list}
    </nav>
  );
}

"use client";

import { Outline, useOutlineFromMarkdown } from "@astryxdesign/core/Outline";
import styles from "./docs.module.css";

export function DocumentOutline({ markdown }: { markdown: string }) {
  const items = useOutlineFromMarkdown(markdown).filter(
    (item) => item.level === 2 || item.level === 3,
  );

  if (items.length < 2) return null;

  return (
    <aside className={styles.outline} aria-label="On this page">
      <p>On this page</p>
      <Outline items={items} density="compact" offset={88} />
    </aside>
  );
}

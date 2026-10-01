"use client";

import Link from "next/link";
import { useId, useMemo, useState } from "react";
import styles from "./docs.module.css";

export type GuideEntry = {
  slug: string;
  title: string;
  summary: string;
  /** Two-digit position in the guide sequence, such as "01". */
  number: string;
};

type DocumentationSearchProps = {
  guides: readonly GuideEntry[];
  currentSlug?: string;
};

/** "Find a guide" search above the numbered guide list. Typing filters the
    list by title and summary. */
export function DocumentationSearch({ guides, currentSlug }: DocumentationSearchProps) {
  const inputId = useId();
  const [query, setQuery] = useState("");
  const normalized = query.trim().toLowerCase();
  const visibleGuides = useMemo(
    () =>
      normalized
        ? guides.filter((guide) =>
            `${guide.title} ${guide.summary}`.toLowerCase().includes(normalized),
          )
        : guides,
    [guides, normalized],
  );
  const status = normalized
    ? `${visibleGuides.length} guide${visibleGuides.length === 1 ? "" : "s"} found`
    : `${guides.length} guides`;

  return (
    <>
      <div
        className={`rm-field ${styles.search}`}
        role="search"
        aria-labelledby={`${inputId}-label`}
      >
        <label className="rm-field__label" id={`${inputId}-label`} htmlFor={inputId}>
          Find a guide
        </label>
        <input
          className="rm-input"
          id={inputId}
          type="search"
          value={query}
          onChange={(event) => setQuery(event.currentTarget.value)}
          placeholder="Setup, n8n, security…"
          autoComplete="off"
          aria-describedby={`${inputId}-status`}
        />
        <p className="rm-field__hint" id={`${inputId}-status`} role="status" aria-live="polite">
          {status}
        </p>
      </div>
      <nav className={styles.guideNav} aria-label="Documentation navigation">
        {visibleGuides.length > 0 ? (
          <ul className="rm-sidebar__list">
            {visibleGuides.map((guide) => (
              <li key={guide.slug}>
                <Link
                  className={`rm-sidebar__link ${styles.guideLink}`}
                  href={`/docs/${guide.slug}`}
                  aria-current={guide.slug === currentSlug ? "page" : undefined}
                >
                  <span className={styles.guideNumber} aria-hidden="true">
                    {guide.number}
                  </span>
                  {guide.title}
                </Link>
              </li>
            ))}
          </ul>
        ) : (
          <p className={styles.emptySearch}>
            No guide matches that search. Try “n8n”, “security” or “install”.
          </p>
        )}
      </nav>
    </>
  );
}

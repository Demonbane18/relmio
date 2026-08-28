"use client";

import Link from "next/link";
import { useId, useMemo, useState } from "react";
import styles from "./docs.module.css";

type SearchEntry = {
  slug: string;
  title: string;
  summary: string;
};

export function DocumentationSearch({ pages }: { pages: SearchEntry[] }) {
  const inputId = useId();
  const [query, setQuery] = useState("");
  const normalized = query.trim().toLowerCase();
  const visiblePages = useMemo(
    () =>
      normalized
        ? pages.filter((page) =>
            `${page.title} ${page.summary}`.toLowerCase().includes(normalized),
          )
        : pages,
    [normalized, pages],
  );

  return (
    <section className={styles.search} aria-labelledby={`${inputId}-label`}>
      <label id={`${inputId}-label`} htmlFor={inputId}>
        Find a guide
      </label>
      <input
        id={inputId}
        type="search"
        value={query}
        onChange={(event) => setQuery(event.currentTarget.value)}
        placeholder="Search setup, n8n, security, or troubleshooting"
        autoComplete="off"
      />
      <p className={styles.searchStatus} role="status" aria-live="polite">
        {visiblePages.length === pages.length && !normalized
          ? `${pages.length} canonical guides`
          : `${visiblePages.length} guide${visiblePages.length === 1 ? "" : "s"} found`}
      </p>
      {visiblePages.length > 0 ? (
        <ul className={styles.pageList}>
          {visiblePages.map((page) => (
            <li key={page.slug}>
              <Link href={`/docs/${page.slug}`}>
                <strong>{page.title}</strong>
                <span>{page.summary}</span>
              </Link>
            </li>
          ))}
        </ul>
      ) : (
        <p className={styles.emptySearch}>
          No guide matches that search. Try “n8n”, “security”, or “install”.
        </p>
      )}
    </section>
  );
}

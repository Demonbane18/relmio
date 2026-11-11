"use client";

import Link from "next/link";
import { useId, useMemo, useState } from "react";
import type { DocumentationSection } from "./markdownText";
import { matchingSections, sectionHref } from "./markdownText";
import styles from "./docs.module.css";

export type GuideEntry = {
  slug: string;
  title: string;
  /** Short label shown as a badge beside the title, such as "Experimental". */
  status?: string;
  summary: string;
  /** Two-digit position in the guide sequence, such as "01". */
  number: string;
};

type DocumentationSearchProps = {
  guides: readonly GuideEntry[];
  currentSlug?: string;
};

type SectionIndex = "idle" | "loading" | "failed" | readonly DocumentationSection[];

// The section index is its own chunk. The first focus of a search field loads
// it once for the sidebar and the mobile menu, also across guide pages. A
// failed load is forgotten, so the next focus or keystroke tries again.
let sectionIndexRequest: Promise<readonly DocumentationSection[]> | undefined;

function requestSectionIndex() {
  sectionIndexRequest ??= import("./generated-sections.json").then(
    (module) => module.default,
    (error: unknown) => {
      sectionIndexRequest = undefined;
      throw error;
    },
  );
  return sectionIndexRequest;
}

/** "Find a guide" search above the numbered guide list. Typing filters the
    list by title and summary, then lists the guide sections that mention the
    words. */
export function DocumentationSearch({ guides, currentSlug }: DocumentationSearchProps) {
  const inputId = useId();
  const [query, setQuery] = useState("");
  const [sectionIndex, setSectionIndex] = useState<SectionIndex>("idle");
  const normalized = query.trim().toLowerCase();
  const visibleGuides = useMemo(
    () =>
      normalized
        ? guides.filter((guide) =>
            `${guide.title} ${guide.status ?? ""} ${guide.summary}`.toLowerCase().includes(normalized),
          )
        : guides,
    [guides, normalized],
  );
  const sections = useMemo(
    () => (typeof sectionIndex === "string" ? [] : matchingSections(sectionIndex, normalized)),
    [sectionIndex, normalized],
  );

  function loadSections() {
    if (sectionIndex !== "idle" && sectionIndex !== "failed") return;
    setSectionIndex("loading");
    requestSectionIndex().then(setSectionIndex, () => setSectionIndex("failed"));
  }

  let status = `${guides.length} guides`;
  if (normalized) {
    const found = `${visibleGuides.length} guide${visibleGuides.length === 1 ? "" : "s"}`;
    if (typeof sectionIndex !== "string") {
      status = `${found} and ${sections.length} section${sections.length === 1 ? "" : "s"} found`;
    } else if (sectionIndex === "loading") {
      status = `${found} found. Searching sections…`;
    } else if (sectionIndex === "failed") {
      status = `${found} found. Sections did not load. Type again to retry.`;
    } else {
      status = `${found} found`;
    }
  }

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
          onFocus={loadSections}
          onChange={(event) => {
            setQuery(event.currentTarget.value);
            loadSections();
          }}
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
                  {guide.status ? <span className="rm-badge rm-badge--accent">{guide.status}</span> : null}
                </Link>
              </li>
            ))}
          </ul>
        ) : sections.length === 0 ? (
          <p className={styles.emptySearch}>
            No guide {typeof sectionIndex === "string" ? "" : "or section "}matches that search. Try
            “n8n”, “security” or “install”.
          </p>
        ) : null}
        {sections.length > 0 ? (
          <div className={styles.sectionResults}>
            <p className="rm-sidebar__heading" id={`${inputId}-sections`}>
              Sections
            </p>
            <ul className="rm-sidebar__list" aria-labelledby={`${inputId}-sections`}>
              {sections.map((section, index) => (
                <li key={`${index}-${section.slug}-${section.id}`}>
                  <Link
                    className={`rm-sidebar__link ${styles.guideLink} ${styles.sectionLink}`}
                    href={sectionHref(section)}
                  >
                    <span>{section.heading}</span>
                    <span className={styles.sectionGuide}>
                      {guides.find((guide) => guide.slug === section.slug)?.title}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </div>
        ) : null}
      </nav>
    </>
  );
}

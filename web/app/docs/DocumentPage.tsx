import Link from "next/link";
import { classNames } from "../components/ui/classNames";
import { Icon } from "../components/ui/Icon";
import { DocumentationSearch, type GuideEntry } from "./DocumentationSearch";
import { DocumentOutline } from "./DocumentOutline";
import { documentationPages } from "./generated-content";
import { guideSummary, markdownOutline } from "./markdownText";
import { GuideMarkdown } from "./MarkdownContent";
import styles from "./docs.module.css";

type DocumentationEntry = (typeof documentationPages)[number];

const guides: GuideEntry[] = documentationPages.map((page, index) => ({
  slug: page.slug,
  title: page.title,
  summary: guideSummary(page.content),
  number: String(index + 1).padStart(2, "0"),
}));

/** The docs index (no page) or one guide, in the reading layout: guide list on
    the left, the article in the reading column, and its outline on the right. */
export function DocumentationPage({ page }: { page?: DocumentationEntry }) {
  const currentIndex = page ? guides.findIndex((guide) => guide.slug === page.slug) : -1;
  const previousGuide = currentIndex > 0 ? guides[currentIndex - 1] : null;
  const nextGuide =
    currentIndex >= 0 && currentIndex < guides.length - 1 ? guides[currentIndex + 1] : null;
  const outline = page ? markdownOutline(page.content) : [];
  const hasOutline = outline.length >= 2;

  return (
    <main id="main-content" className="rm-app__main" tabIndex={-1}>
      <a className="rm-skip-link" href="#docs-content">
        Skip to documentation
      </a>
      <div className={styles.layout}>
        <details className={`rm-disclosure ${styles.mobileNav}`}>
          <summary>Browse documentation</summary>
          <div className="rm-disclosure__body">
            <DocumentationSearch guides={guides} currentSlug={page?.slug} />
          </div>
        </details>
        <div className={`rm-sidebar ${styles.sidebar}`}>
          <DocumentationSearch guides={guides} currentSlug={page?.slug} />
        </div>

        <div className={styles.pane} data-reading-pane>
          {page ? (
            <div className={classNames(styles.reading, hasOutline && styles.readingWithOutline)}>
              {hasOutline ? <DocumentOutline items={outline} variant="inline" /> : null}
              <article className={`rm-prose ${styles.article}`} id="docs-content" tabIndex={-1}>
                <p className={styles.source}>
                  Canonical guide · Source <code>{page.sourcePath}</code>
                </p>
                <GuideMarkdown content={page.content} />
                <nav className={styles.pager} aria-label="Adjacent documentation">
                  {previousGuide ? (
                    <Link className={styles.pagerLink} href={`/docs/${previousGuide.slug}`}>
                      <span className={styles.pagerLabel}>
                        <Icon name="arrow-left" size="xs" />
                        Previous
                      </span>
                      <strong>{previousGuide.title}</strong>
                    </Link>
                  ) : null}
                  {nextGuide ? (
                    <Link
                      className={`${styles.pagerLink} ${styles.pagerNext}`}
                      href={`/docs/${nextGuide.slug}`}
                    >
                      <span className={styles.pagerLabel}>
                        Next
                        <Icon name="arrow-right" size="xs" />
                      </span>
                      <strong>{nextGuide.title}</strong>
                    </Link>
                  ) : null}
                </nav>
              </article>
              {hasOutline ? <DocumentOutline items={outline} variant="rail" /> : null}
            </div>
          ) : (
            <article
              className={styles.index}
              id="docs-content"
              tabIndex={-1}
              aria-labelledby="docs-title"
            >
              <header className={styles.indexHeader}>
                <p className="rm-eyebrow">Documentation · {guides.length} guides</p>
                <h1 className={styles.indexTitle} id="docs-title">
                  Relmio documentation
                </h1>
                <p className="rm-lede">
                  Setup guides for local tools, self-hosted n8n and their sign-in
                  boundaries. Every page comes from the docs in the repository.
                </p>
              </header>
              <ul className={styles.guideGrid}>
                {guides.map((guide) => (
                  <li key={guide.slug}>
                    <Link className={styles.guideCard} href={`/docs/${guide.slug}`}>
                      <span className={styles.guideNumber} aria-hidden="true">
                        {guide.number}
                      </span>
                      <strong className={styles.guideTitle}>{guide.title}</strong>
                      <span className={styles.guideSummary}>{guide.summary}</span>
                    </Link>
                  </li>
                ))}
              </ul>
            </article>
          )}
        </div>
      </div>
    </main>
  );
}

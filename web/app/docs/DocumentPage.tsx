import Image from "next/image";
import Link from "next/link";
import { ArrowRight, Route } from "lucide-react";
import {
  Children,
  isValidElement,
  type ReactNode,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { HashLink } from "../components/HashLink";
import { RepositoryButton } from "../components/RepositoryButton";
import { SupportButton } from "../components/SupportButton";
import { ThemeModeControl } from "../components/ThemeModeControl";
import { DocumentationSearch } from "./DocumentationSearch";
import { DocumentOutline } from "./DocumentOutline";
import { documentationPages } from "./generated-content";
import styles from "./docs.module.css";

type DocumentationEntry = (typeof documentationPages)[number];

function nodeText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (isValidElement<{ children?: ReactNode }>(node)) {
    return nodeText(node.props.children);
  }
  return Children.toArray(node).map(nodeText).join("");
}

function headingId(children: ReactNode) {
  const normalized = nodeText(children)
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-|-$/gu, "");
  return normalized || undefined;
}

function summaryFromMarkdown(markdown: string) {
  const summary = markdown
    .split("\n")
    .map((line) => line.trim())
    .find(
      (line) =>
        line.length > 40 &&
        !line.startsWith("#") &&
        !line.startsWith("|") &&
        !line.startsWith("-") &&
        !line.startsWith("```") &&
        !line.startsWith(">"),
    );
  return (summary ?? "Open the canonical Relmio guide.")
    .replace(/\[([^\]]+)\]\([^)]+\)/gu, "$1")
    .replace(/[`*_]/gu, "")
    .slice(0, 180);
}

export function DocumentationPage({ page }: { page?: DocumentationEntry }) {
  const currentIndex = page
    ? documentationPages.findIndex((candidate) => candidate.slug === page.slug)
    : -1;
  const previousPage = currentIndex > 0 ? documentationPages[currentIndex - 1] : null;
  const nextPage =
    currentIndex >= 0 && currentIndex < documentationPages.length - 1
      ? documentationPages[currentIndex + 1]
      : null;
  const searchPages = documentationPages.map((candidate) => ({
    slug: candidate.slug,
    title: candidate.title,
    summary: summaryFromMarkdown(candidate.content),
  }));

  return (
    <main className={`${styles.page} ${styles.editorialPage}`} id="main-content">
      <HashLink className="skip-link" focusTarget targetId="docs-content">
        Skip to documentation
      </HashLink>
      <header className={styles.header}>
        <Link className={styles.brand} href="/" aria-label="Relmio home">
          <Image
            src="/relmio-icon.png"
            alt=""
            width={32}
            height={32}
            unoptimized
          />
          <strong>Relmio</strong>
        </Link>
        <nav aria-label="Primary navigation" className={styles.primaryNav}>
          <Link href="/">Home</Link>
          <Link href="/install">Install</Link>
          <Link href="/docs" aria-current="page">Docs</Link>
        </nav>
        <section className={styles.controls} aria-label="Project controls">
          <ThemeModeControl />
          <SupportButton />
          <RepositoryButton />
        </section>
      </header>

      <section
        className={`${styles.layout} ${styles.editorialLayout} ${page ? styles.layoutDetail : styles.layoutIndex}`}
        aria-label="Documentation"
      >
        <details className={styles.mobileNavigation}>
          <summary>Browse documentation</summary>
          <ul>
            {documentationPages.map((candidate) => (
              <li key={candidate.slug}>
                <Link
                  href={`/docs/${candidate.slug}`}
                  aria-current={candidate.slug === page?.slug ? "page" : undefined}
                >
                  {candidate.title}
                </Link>
              </li>
            ))}
          </ul>
        </details>
        <nav className={styles.sidebar} aria-label="Documentation navigation">
          <p>Field manual</p>
          <ul>
            {documentationPages.map((candidate, index) => (
              <li key={candidate.slug}>
                <Link
                  href={`/docs/${candidate.slug}`}
                  aria-current={candidate.slug === page?.slug ? "page" : undefined}
                >
                  <span aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
                  <strong>{candidate.title}</strong>
                </Link>
              </li>
            ))}
          </ul>
        </nav>

        {page ? (
          <article className={styles.article} id="docs-content" tabIndex={-1}>
            <p className={styles.sourceNote}>
              Canonical guide · Source <code>{page.sourcePath}</code>
            </p>
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                h1: ({ children }) => <h1 id={headingId(children)}>{children}</h1>,
                h2: ({ children }) => <h2 id={headingId(children)}>{children}</h2>,
                h3: ({ children }) => <h3 id={headingId(children)}>{children}</h3>,
              }}
            >
              {page.content}
            </ReactMarkdown>
            <nav className={styles.articlePager} aria-label="Adjacent documentation">
              {previousPage ? (
                <Link href={`/docs/${previousPage.slug}`}>
                  <small>Previous</small>
                  <strong>{previousPage.title}</strong>
                </Link>
              ) : null}
              {nextPage ? (
                <Link className={styles.nextPage} href={`/docs/${nextPage.slug}`}>
                  <small>Next</small>
                  <strong>{nextPage.title}</strong>
                </Link>
              ) : null}
            </nav>
          </article>
        ) : (
          <article className={styles.article} id="docs-content" tabIndex={-1}>
            <section className={styles.indexHero} aria-labelledby="docs-title">
              <div>
                <p className={styles.eyebrow}>Field manual · {documentationPages.length} canonical guides</p>
                <h1 id="docs-title">Relmio documentation</h1>
                <p className={styles.intro}>
                  Follow every request from source to boundary to destination.
                  These guides are generated from canonical repository Markdown.
                </p>
              </div>
              <section className={styles.routeLegend} aria-label="Relmio request paths">
                <div className={styles.routeLegendTitle}>
                  <Route aria-hidden="true" size={18} strokeWidth={1.75} />
                  <span>Request paths</span>
                </div>
                <ol>
                  <li><span>01</span><strong>Model Relay</strong><ArrowRight aria-hidden="true" /></li>
                  <li><span>02</span><strong>Sandbox Builder</strong><ArrowRight aria-hidden="true" /></li>
                  <li><span>03</span><strong>Chat Adapter</strong><ArrowRight aria-hidden="true" /></li>
                  <li><span>04</span><strong>App Server</strong><ArrowRight aria-hidden="true" /></li>
                </ol>
              </section>
            </section>
            <DocumentationSearch pages={searchPages} />
          </article>
        )}
        {page ? <DocumentOutline markdown={page.content} /> : null}
      </section>

      <footer className={styles.footer}>
        <Link href="/docs/security">Security boundary</Link>
        <Link href="/docs/troubleshooting">Troubleshooting</Link>
        <a
          href="https://github.com/Demonbane18/relmio"
          target="_blank"
          rel="noopener noreferrer"
        >
          Repository
        </a>
      </footer>
    </main>
  );
}

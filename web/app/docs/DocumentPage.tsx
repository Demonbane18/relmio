import Link from "next/link";
import {
  Children,
  isValidElement,
  type ReactNode,
} from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { RepositoryButton } from "../components/RepositoryButton";
import { SupportButton } from "../components/SupportButton";
import { ThemeModeControl } from "../components/ThemeModeControl";
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

export function DocumentationPage({ page }: { page?: DocumentationEntry }) {
  return (
    <main className={styles.page} id="main-content">
      <a className="skip-link" href="#docs-content">
        Skip to documentation
      </a>
      <header className={styles.header}>
        <Link className={styles.brand} href="/" aria-label="Relmio home">
          <span aria-hidden="true">↗</span>
          Relmio
        </Link>
        <nav aria-label="Primary navigation" className={styles.primaryNav}>
          <Link href="/install">Install</Link>
          <Link href="/docs">Docs</Link>
        </nav>
        <section className={styles.controls} aria-label="Project controls">
          <ThemeModeControl />
          <SupportButton />
          <RepositoryButton />
        </section>
      </header>

      <section className={styles.layout} aria-label="Documentation">
        <nav className={styles.sidebar} aria-label="Documentation navigation">
          <p>Documentation</p>
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
        </nav>

        {page ? (
          <article className={styles.article} id="docs-content">
            <p className={styles.sourceNote}>
              Generated from <code>{page.sourcePath}</code>. Edit repository
              Markdown, not this rendered copy.
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
          </article>
        ) : (
          <article className={styles.article} id="docs-content">
            <p className={styles.eyebrow}>Repository Markdown</p>
            <h1>Relmio documentation</h1>
            <p className={styles.intro}>
              Practical guides for the local wizard, n8n sidecar, and deliberate
              credential boundaries. Each page is generated from canonical
              repository Markdown.
            </p>
            <ul className={styles.pageList}>
              {documentationPages.map((candidate) => (
                <li key={candidate.slug}>
                  <Link href={`/docs/${candidate.slug}`}>
                    <strong>{candidate.title}</strong>
                    <span>Read the canonical guide</span>
                  </Link>
                </li>
              ))}
            </ul>
          </article>
        )}
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

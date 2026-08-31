import type { Metadata } from "next";
import Image from "next/image";
import Link from "next/link";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { RepositoryButton } from "../components/RepositoryButton";
import { SupportButton } from "../components/SupportButton";
import { ThemeModeControl } from "../components/ThemeModeControl";
import { HashLink } from "../components/HashLink";
import { CopyableCodeBlock } from "../docs/CopyableCodeBlock";
import { changelogContent } from "../docs/generated-content";
import styles from "../docs/docs.module.css";

export const metadata: Metadata = {
  title: "Changelog | Relmio",
  description: "Release notes for Relmio.",
};

export default function ChangelogPage() {
  return (
    <main className={`${styles.page} ${styles.editorialPage}`} id="main-content">
      <HashLink className="skip-link" focusTarget targetId="changelog-content">
        Skip to release notes
      </HashLink>
      <header className={styles.header}>
        <Link className={styles.brand} href="/" aria-label="Relmio home">
          <Image src="/relmio-icon.png" alt="" width={32} height={32} unoptimized />
          <strong>Relmio</strong>
        </Link>
        <nav aria-label="Primary navigation" className={styles.primaryNav}>
          <Link href="/">Home</Link>
          <Link href="/install">Install</Link>
          <Link href="/docs">Docs</Link>
          <Link href="/changelog" aria-current="page">Changelog</Link>
        </nav>
        <section className={styles.controls} aria-label="Project controls">
          <ThemeModeControl />
          <SupportButton />
          <RepositoryButton />
        </section>
      </header>

      <article
        className={`${styles.article} ${styles.changelogArticle}`}
        id="changelog-content"
        tabIndex={-1}
      >
        <p className={styles.eyebrow}>Release notes</p>
        <h1>What changed, in plain language.</h1>
        <p className={styles.intro}>
          Every published release is listed here. The docs build reads{" "}
          <code>CHANGELOG.md</code>, so the website and repository show the same notes.
        </p>
        <ReactMarkdown
          remarkPlugins={[remarkGfm]}
          components={{ pre: ({ children }) => <CopyableCodeBlock>{children}</CopyableCodeBlock> }}
        >
          {changelogContent}
        </ReactMarkdown>
      </article>
    </main>
  );
}

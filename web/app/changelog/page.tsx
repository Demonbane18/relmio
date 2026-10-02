import { changelogContent } from "../docs/generated-content";
import { ChangelogMarkdown } from "../docs/MarkdownContent";
import { changelogReleases } from "../docs/markdownText";
import { ReleaseNavigation } from "./ReleaseNavigation";
import styles from "../docs/docs.module.css";
import { pageMetadata } from "../page-metadata";

export const metadata = pageMetadata(
  "Changelog | Relmio",
  "Read Relmio's published release notes for every version, including setup changes, fixes, compatibility updates and experimental prerelease builds.",
  "/changelog",
);

const releaseGroups = changelogReleases(changelogContent);

export default function ChangelogPage() {
  return (
    <main id="main-content" className="rm-app__main" tabIndex={-1}>
      <a className="rm-skip-link" href="#changelog-content">
        Skip to release notes
      </a>
      <div className={styles.layout}>
        <details className={`rm-disclosure ${styles.mobileNav}`}>
          <summary>Browse releases</summary>
          <div className="rm-disclosure__body">
            <ReleaseNavigation groups={releaseGroups} track={false} />
          </div>
        </details>
        <div className={`rm-sidebar ${styles.sidebar}`}>
          <p className="rm-sidebar__heading">Releases</p>
          <ReleaseNavigation groups={releaseGroups} track />
        </div>

        <div className={styles.pane} data-reading-pane>
          <div className={styles.reading}>
            <article
              className={`rm-prose ${styles.article} ${styles.changelog}`}
              id="changelog-content"
              tabIndex={-1}
            >
              <header className={styles.articleHeader}>
                <p className="rm-eyebrow">Release notes</p>
                <h1 className={styles.indexTitle}>What changed, in plain language.</h1>
                <p className="rm-lede">
                  Every published release, newest first. This page reads{" "}
                  <code>CHANGELOG.md</code> from the repository, so both show the same
                  notes.
                </p>
              </header>
              <ChangelogMarkdown content={changelogContent} />
            </article>
          </div>
        </div>
      </div>
    </main>
  );
}
